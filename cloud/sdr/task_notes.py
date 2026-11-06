"""Append one call-outcome note to the pinned contact without replacing task text."""
import datetime
import hashlib
import html
import json
import re
from urllib.parse import urlencode

from .completion import validate_approval
from .lemlist_contract import active, get_task

EVENT_FIELDS={'workspace_id','prospect_id','rep_id','call_id','disposition_id','disposition_name','started_at','finalized_at'}


def enabled(environ):
    value=environ.get('LEMLIST_CALL_NOTES','')
    if value not in ('','1'): raise ValueError('invalid task note setting')
    return value=='1'


def note_block(event, approval, scope):
    validate_approval(approval)
    if not isinstance(event,dict) or set(event)!=EVENT_FIELDS:
        raise ValueError('exact normalized call required')
    encoded=json.dumps(event,sort_keys=True,separators=(',',':'))
    if (hashlib.sha256(encoded.encode()).hexdigest()!=approval['event_digest']
            or any(event[k]!=approval[k] for k in ('call_id','rep_id','disposition_id'))
            or event['workspace_id']!=scope['workspace_id']
            or event['prospect_id']!=scope['hubspot_contact_id']
            or not isinstance(event['call_id'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',event['call_id'])
            or not isinstance(event['disposition_name'],str) or not 1<=len(event['disposition_name'])<=100
            or any(ord(c)<32 for c in event['disposition_name'])):
        raise ValueError('note differs from verified call')
    stamp=datetime.datetime.fromtimestamp(event['started_at'],datetime.timezone.utc).isoformat(timespec='seconds')
    url='https://app.nooks.in/workspaces/'+scope['workspace_id']+'/call-library?selectedCallId='+event['call_id']
    return 'Nooks disposition: '+html.escape(event['disposition_name'])+'\nCall time (UTC): '+stamp+'\nCompleted lemlist task: '+scope['task_id']+'\n'+url


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class TaskNotes:
    def __init__(self, claim):
        self.claim=claim
        with claim.db() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS task_note (
                singleton INTEGER PRIMARY KEY CHECK(singleton=1), call_id TEXT NOT NULL,
                event_digest TEXT NOT NULL, note_digest TEXT NOT NULL,
                state TEXT NOT NULL)''')

    def _check_task(self, fetch):
        scope=self.claim.scope
        path='/api/v2/tasks?'+urlencode({'campaignId':scope['campaign_id'],'taskId':scope['task_id'],'limit':2,'page':1})
        page=fetch(path)
        task=get_task({'campaign_id':scope['campaign_id']},scope['task_id'],lambda _:page)
        row=page['results'][0]
        if (task['done'] is not True or task['lead_id']!=scope['lead_id']
                or row.get('contactId')!=scope['contact_id']
                or task['assigned_rep_id']!=scope['assigned_rep_id']
                or task['provider_sequence_id']!=scope['sequence_id']
                or task['provider_step_id'] not in (None,scope['call_step_id'])):
            raise ValueError('note task correlation changed')
    def _notes(self, fetch):
        path='/api/contacts/'+self.claim.scope['contact_id']+'/notes'
        rows=[];total=None
        for page in range(1,6):
            value=fetch(path+'?'+urlencode({'limit':100,'page':page,'sortBy':'createdAt','sortOrder':'desc'}))
            if (not isinstance(value,dict) or type(value.get('total')) is not int
                    or not 0<=value['total']<=500 or not isinstance(value.get('data'),list)
                    or len(value['data'])>100 or (total is not None and total!=value['total'])):
                raise ValueError('contact notes incomplete')
            total=value['total'];rows.extend(value['data'])
            if len(rows)>=total: break
            if len(value['data'])!=100: raise ValueError('contact notes incomplete')
        if (len(rows)!=total or any(not isinstance(row,dict) or not isinstance(row.get('_id'),str)
                or row.get('contactId')!=self.claim.scope['contact_id'] or not isinstance(row.get('note'),str)
                for row in rows) or len({row['_id'] for row in rows})!=len(rows)):
            raise ValueError('contact notes invalid')
        return rows

    def _matches(self, rows, block):
        marker=block.split('\n')[-1]
        matches=[row for row in rows if marker in row['note']]
        if matches and (len(matches)!=1 or matches[0]['note']!=block):
            raise ValueError('existing call note conflicts')
        return len(matches)==1

    def run(self, event, approval, fetch, write):
        scope=self.claim.scope
        block=note_block(event,approval,scope)
        identity=(event['call_id'],approval['event_digest'],digest(block))
        self._check_task(fetch)
        present=self._matches(self._notes(fetch),block)
        with self.claim.db() as db:
            db.execute('BEGIN IMMEDIATE')
            completed=db.execute('SELECT approval,claimed_at FROM write_claim WHERE singleton=1').fetchone()
            if not completed or completed[1] is None or completed[0]!=json.dumps(approval,sort_keys=True):
                raise ValueError('note requires the same claimed completion')
            old=db.execute('SELECT call_id,event_digest,note_digest,state FROM task_note WHERE singleton=1').fetchone()
            if old and tuple(old[:3])!=identity: raise ValueError('cannot replace note claim')
        if old:
            return self._readback(present,identity)
        with self.claim.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT 1 FROM task_note').fetchone(): raise ValueError('note already claimed')
            active(scope,self.claim.clock(),window=self.claim.window)
            state='verified' if present else 'claimed'
            db.execute('INSERT INTO task_note VALUES(1,?,?,?,?)',(*identity,state))
        if present: return self._result(identity,'verified')
        try:
            # Creates a separate note; concurrent task edits cannot be overwritten.
            write('POST','/api/contacts/'+scope['contact_id']+'/notes',{'note':block})
            return self._readback(self._matches(self._notes(fetch),block),identity)
        except Exception:
            with self.claim.db() as db: db.execute("UPDATE task_note SET state='uncertain' WHERE singleton=1")
            return self._result(identity,'uncertain')

    def _readback(self, present, identity):
        state='verified' if present else 'observing'
        with self.claim.db() as db: db.execute('UPDATE task_note SET state=? WHERE singleton=1',(state,))
        return self._result(identity,state)

    def _result(self, identity, state):
        return {'scope':self.claim.scope,'call_id':identity[0],'event_digest':identity[1],
                'note_digest':identity[2],'note_state':state}
