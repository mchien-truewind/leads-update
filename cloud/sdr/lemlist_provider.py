"""Private-broker-only provider transport. Not wired to any hosted endpoint yet."""
import json
import time
from urllib.parse import parse_qs, urlsplit

import httpx
from . import lemlist_contract as contract
from .common import unique


class Provider:
    def __init__(self, key, scope, *, allow_write=False, transport=None, clock=time.time, monotonic=time.monotonic, window=None, report=None, allow_notes=False):
        contract.validate_scope(scope)
        self.key, self.scope = key, dict(scope)
        self.allow_write, self.transport = allow_write, transport
        self.clock, self.monotonic = clock, monotonic
        self.window = window
        self.allow_notes = allow_notes
        self.report = report or (lambda value: print(json.dumps(value,sort_keys=True),flush=True))
        self.activity_reports = {}

    def _report_activity(self, status, value, offset):
        """Only fixed shape/count diagnostics; never provider fields or response text."""
        rows=value if isinstance(value,list) else []
        fields={'opportunity':'opportunityId','step':'stepId','sequence':'sequenceId'}
        expected={'opportunity':self.scope['task_id'],'step':self.scope['call_step_id'],
                  'sequence':self.scope['sequence_id']}
        result={'event':'lemlist_activity_read','page_offset':offset,
            'response_status':status,'response_shape':'array' if isinstance(value,list) else 'other',
            'response_rows':len(rows) if isinstance(value,list) else None,
            'matching_identity_count':sum(isinstance(row,dict) and row.get('campaignId')==self.scope['campaign_id']
                and row.get('leadId')==self.scope['lead_id'] and row.get('contactId',self.scope['contact_id'])==self.scope['contact_id']
                for row in rows)}
        for name,field in fields.items():
            result['with_'+name+'_count']=sum(isinstance(row,dict) and row.get(field) is not None for row in rows)
            result['matching_'+name+'_count']=sum(isinstance(row,dict) and row.get(field)==expected[name] for row in rows)
        if result!=self.activity_reports.get(offset):
            try: self.report(result)
            except Exception: pass  # Diagnostics cannot alter provider results.
            self.activity_reports[offset]=result  # At most five allowlisted page offsets.

    def _allowed(self, method, path, payload, note_block=None):
        u = urlsplit(path)
        if u.scheme or u.netloc or u.fragment or not path.startswith('/api/'):
            return False
        q = parse_qs(u.query,keep_blank_values=True)
        scope = self.scope
        note_path='/api/contacts/'+scope['contact_id']+'/notes'
        if note_block is not None:
            if method=='POST':
                return self.allow_notes is True and path==note_path and payload=={'note':note_block}
            if method=='PATCH': return False
            if method=='GET' and u.path==note_path and payload is None:
                return (set(q)=={'limit','page','sortBy','sortOrder'} and q['limit']==['100']
                    and q['page'] in ([str(x)] for x in range(1,6))
                    and q['sortBy']==['createdAt'] and q['sortOrder']==['desc'])
        if method == 'PATCH':
            return (self.allow_write is True and path == '/api/tasks'
                    and payload == {'id':scope['task_id'],'done':True})
        if method != 'GET' or payload is not None:
            return False
        if path == '/api/campaigns/'+scope['campaign_id']+'/sequences': return True
        if u.path == '/api/contacts': return q == {'crmIds':[scope['hubspot_contact_id']]}
        if u.path == '/api/leads': return q == {'id':[scope['lead_id']]}
        if u.path == '/api/v2/tasks':
            return q in ({'campaignId':[scope['campaign_id']],'taskId':[scope['task_id']],'limit':['2'],'page':['1']},
                {'campaignId':[scope['campaign_id']],'leadId':[scope['lead_id']],'type':['manual'],'limit':['100'],'page':['1']})
        if u.path == '/api/activities':
            return (set(q) == {'version','campaignId','leadId','type','minDate','limit','offset'}
                and q['version'] == ['v2']
                and q['campaignId'] == [scope['campaign_id']] and q['leadId'] == [scope['lead_id']]
                and q['type'] == ['manualDone'] and q['minDate'] == [str(scope['starts_at'])]
                and q['limit'] == ['100'] and q['offset'] in ([str(x)] for x in range(0,500,100)))
        return False

    def run(self, operation, *, note_event=None, note_approval=None, note_claim=None):
        if operation not in ('inspect','complete','note') or not self.key:
            raise ValueError('provider operation unavailable')
        if operation == 'complete' and self.allow_write is not True:
            raise ValueError('task completion disabled')
        block=None
        if operation=='note':
            from .task_notes import TaskNotes, note_block
            if self.allow_notes is not True or note_claim is None or note_claim.scope!=self.scope:
                raise ValueError('task notes disabled')
            block=note_block(note_event,note_approval,self.scope)
        deadline, calls, writes = self.monotonic()+45, 0, 0
        with httpx.Client(base_url='https://api.lemlist.com',auth=httpx.BasicAuth('',self.key),
                transport=self.transport,trust_env=False,follow_redirects=False,timeout=5) as client:
            def request(method,path,payload=None):
                nonlocal calls,writes
                if not self._allowed(method,path,payload,block) or calls >= 24 or self.monotonic() >= deadline:
                    raise ValueError('provider request outside scope')
                calls += 1
                if method in ('PATCH','POST'):
                    contract.active(self.scope,self.clock(),window=self.window)
                    if writes: raise ValueError('one write attempt only')
                    writes += 1
                try:
                    with client.stream(method,path,json=payload,headers={'Accept':'application/json'}) as response:
                        if response.status_code not in ((200,) if method == 'GET' else (200,201,204)):
                            if urlsplit(path).path=='/api/activities': self._report_activity(response.status_code,None,int(parse_qs(urlsplit(path).query)['offset'][0]))
                            raise ValueError('provider request rejected')
                        raw=bytearray()
                        for chunk in response.iter_bytes():
                            raw.extend(chunk)
                            if len(raw)>131072 or self.monotonic()>=deadline:
                                raise ValueError('provider response exceeded limits')
                        result=json.loads(raw,object_pairs_hook=unique) if method=='GET' else None
                        if urlsplit(path).path=='/api/activities': self._report_activity(response.status_code,result,int(parse_qs(urlsplit(path).query)['offset'][0]))
                        return result
                except Exception:
                    raise ValueError('provider unavailable or rejected') from None
            if operation == 'inspect': return contract.observe(self.scope,lambda p:request('GET',p))
            if operation == 'note': return TaskNotes(note_claim).run(note_event,note_approval,lambda p:request('GET',p),request)
            return contract.complete(self.scope,lambda p:request('GET',p),request,clock=self.clock,window=self.window)
