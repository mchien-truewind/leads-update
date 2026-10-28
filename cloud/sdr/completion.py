"""Durable one-contact completion core; no scheduler or HTTP activation.

Run blocking operations in a worker thread, never on the ASGI event loop.
The separate private broker must independently enforce the same exact approval.
"""
import hashlib
import json
import re
import time

from .lemlist_contract import active, ready_before, validate_scope

APPROVAL_FIELDS = {'call_id','event_digest','policy_digest','rep_id','disposition_id',
                  'confirmed_contact','confirmed_non_suppressing_disposition'}


def validate_approval(value):
    if (not isinstance(value,dict) or set(value) != APPROVAL_FIELDS
            or value['confirmed_contact'] is not True
            or value['confirmed_non_suppressing_disposition'] is not True
            or any(not isinstance(value[k],str) or not re.fullmatch(r'[a-f0-9]{64}',value[k])
                   for k in ('event_digest','policy_digest'))
            or any(not isinstance(value[k],str) or not 1 <= len(value[k]) <= 200
                   or any(ord(c)<32 for c in value[k]) for k in ('call_id','rep_id','disposition_id'))):
        raise ValueError('explicit exact-call confirmation required')


class Completion:
    def __init__(self, store, scope, *, policy=None, clock=time.time):
        validate_scope(scope)
        expected = {'workspace_id':scope['workspace_id'],'prospect_id':scope['hubspot_contact_id'],
                    'not_before':scope['starts_at'],'expires_at':scope['expires_at']}
        if store.scope != expected:
            raise ValueError('completion and capture scope differ')
        from .dispositions import DispositionPolicy
        self.store, self.scope, self.clock, self.policy = store,dict(scope),clock,policy
        if policy is not None: DispositionPolicy(policy.value, scope)
        with store.db() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS completion (
                singleton INTEGER PRIMARY KEY CHECK(singleton=1), scope TEXT NOT NULL,
                armed_at REAL NOT NULL, state TEXT NOT NULL, before_evidence TEXT NOT NULL,
                approval TEXT, claimed_at REAL, write_receipt INTEGER, after_evidence TEXT)''')
            if 'policy' not in {r[1] for r in db.execute('PRAGMA table_info(completion)')}:
                db.execute('ALTER TABLE completion ADD COLUMN policy TEXT')
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT scope,policy,state,claimed_at FROM completion WHERE singleton=1').fetchone()
            if row and json.loads(row[0]) != scope:
                raise ValueError('cannot replace completion scope')
            if row:
                if policy is not None and row[1] is None and row[2]=='armed' and row[3] is None:
                    # The first signed call may supply IDs for supervised mapping.
                    # Bind the first reviewed mapping once, before any claim.
                    db.execute('UPDATE completion SET policy=? WHERE singleton=1',(policy.encoded,))
                    row=(row[0],policy.encoded,row[2],row[3])
                if policy is not None and row[1] != policy.encoded:
                    raise ValueError('cannot replace armed disposition policy')
                self.policy = DispositionPolicy(json.loads(row[1]),scope) if row[1] else None

    def status(self):
        with self.store.db() as db:
            row = db.execute('SELECT state,write_receipt FROM completion WHERE singleton=1').fetchone()
            held = bool(db.execute('SELECT held FROM scope WHERE singleton=1').fetchone()[0])
        return {'state':'held' if held else row[0] if row else 'not_armed',
                'write_receipt':row[1] if row else None}

    def arm(self, call):
        active(self.scope,self.clock())
        evidence = call('inspect',{})
        if not ready_before(evidence,self.scope): raise ValueError('test preflight failed')
        with self.store.db() as db:
            db.execute('BEGIN IMMEDIATE')
            active(self.scope,self.clock())
            if (db.execute('SELECT held FROM scope WHERE singleton=1').fetchone()[0]
                    or db.execute('SELECT COUNT(*) FROM events').fetchone()[0]):
                raise ValueError('arm must precede the controlled call')
            # No reset or renewal. A failed insert preserves any old claim.
            db.execute('INSERT INTO completion(singleton,scope,armed_at,state,before_evidence,policy) VALUES(1,?,?,?,?,?)',
                (json.dumps(self.scope,sort_keys=True),self.clock(),'armed',json.dumps(evidence),self.policy.encoded if self.policy else None))
        return 'armed'

    def assess_event(self):
        with self.store.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT state FROM completion WHERE singleton=1').fetchone()
            events=db.execute('SELECT evidence FROM events').fetchall()
            if not row or len(events)!=1: return None
            if self.policy is None: return 'mapping_required'
            action=self.policy.action(json.loads(events[0][0]))
            if action!='completion_allowed' and row[0]=='armed':
                db.execute("UPDATE completion SET state='held' WHERE singleton=1")
            return action

    def complete(self, approval, call):
        validate_approval(approval)
        self.assess_event()
        if self.policy is None: raise ValueError('reviewed disposition policy missing')
        self.policy.authorize(approval)
        active(self.scope,self.clock())
        before = call('inspect',{})
        if not ready_before(before,self.scope): raise ValueError('test preflight changed')
        with self.store.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT state,armed_at FROM completion WHERE singleton=1').fetchone()
            if not row or row[0] != 'armed': raise ValueError('completion is not available')
            if (db.execute('SELECT held FROM scope WHERE singleton=1').fetchone()[0]
                    or db.execute('SELECT COUNT(*) FROM events').fetchone()[0] != 1):
                raise ValueError('ambiguous or held call')
            record = db.execute('SELECT digest,evidence FROM events WHERE call_id=?',(approval['call_id'],)).fetchone()
            if not record: raise ValueError('approved call missing')
            event = json.loads(record[1])
            if (record[0] != approval['event_digest']
                    or hashlib.sha256(record[1].encode()).hexdigest() != record[0]
                    or any(event[k] != approval[k] for k in ('call_id','rep_id','disposition_id'))
                    or event['workspace_id'] != self.scope['workspace_id']
                    or event['prospect_id'] != self.scope['hubspot_contact_id']
                    or not row[1] <= event['started_at'] <= event['finalized_at'] <= self.clock()+300):
                raise ValueError('call differs from reviewed confirmation')
            active(self.scope,self.clock())
            db.execute("UPDATE completion SET state='claimed',approval=?,claimed_at=? WHERE singleton=1",
                (json.dumps(approval,sort_keys=True),self.clock()))
        # Commit precedes external dispatch. A crash from here never resets this claim.
        try:
            with self.store.db() as db:
                db.execute('BEGIN IMMEDIATE')
                state = db.execute('SELECT state FROM completion WHERE singleton=1').fetchone()[0]
                if state != 'claimed' or db.execute('SELECT held FROM scope WHERE singleton=1').fetchone()[0]:
                    raise ValueError('test held before dispatch')
                active(self.scope,self.clock())
                result = call('complete',approval)
                if not isinstance(result,dict) or result.get('scope') != self.scope:
                    raise ValueError('missing completion receipt')
                attempted = result.get('write_attempted')
                if attempted is not True:
                    db.execute("UPDATE completion SET state='held',write_receipt=0,after_evidence=? WHERE singleton=1",
                               (json.dumps(result),))
                    return 'held'
                db.execute('UPDATE completion SET write_receipt=1 WHERE singleton=1')
        except Exception:
            with self.store.db() as db:
                db.execute("UPDATE completion SET state='uncertain' WHERE singleton=1 AND state='claimed'")
            raise ValueError('completion outcome uncertain; inspect only') from None
        return self.reconcile(call)

    def reconcile(self,call):
        # Deliberately available after expiry. This method never dispatches a write.
        with self.store.db() as db:
            row = db.execute('SELECT state,claimed_at,write_receipt FROM completion WHERE singleton=1').fetchone()
        allowed = ('claimed','uncertain','observing','verified','observed_after_uncertain_write')
        if not row or row[0] not in allowed: raise ValueError('no attempt to reconcile')
        evidence = call('inspect',{})
        if not isinstance(evidence,dict) or evidence.get('scope') != self.scope:
            raise ValueError('invalid observation scope')
        events, pending = evidence.get('completion_activities'),evidence.get('continuation_tasks')
        mapped = (isinstance(events,list) and len(events)==1 and isinstance(events[0],dict)
            and events[0].get('task_id') == self.scope['task_id']
            and events[0].get('step_id') == self.scope['call_step_id']
            and events[0].get('sequence_id') == self.scope['sequence_id']
            and type(events[0].get('created_at')) in (int,float) and events[0]['created_at'] >= row[1])
        continuation = (isinstance(pending,list) and len(pending)==1 and isinstance(pending[0],dict)
            and pending[0].get('task_id') != self.scope['task_id']
            and isinstance(pending[0].get('task_id'),str)
            and re.fullmatch(r'opp_[A-Za-z0-9]{1,80}',pending[0]['task_id'])
            and pending[0].get('status') in ('due','upcoming')
            and pending[0].get('provider_sequence_id') == self.scope['sequence_id']
            and pending[0].get('assigned_rep_id') == self.scope['assigned_rep_id']
            and pending[0].get('provider_step_id') in (None,self.scope['continuation_step_id']))
        task = evidence.get('task',{})
        verified = task.get('task_id')==self.scope['task_id'] and task.get('done') is True and mapped and continuation
        state = ('verified' if row[2]==1 else 'observed_after_uncertain_write') if verified else 'observing'
        if isinstance(events,list) and any(not isinstance(x,dict)
                or x.get('step_id') not in (None,self.scope['call_step_id'])
                or x.get('sequence_id') not in (None,self.scope['sequence_id']) for x in events):
            state = 'held'
        with self.store.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT held FROM scope WHERE singleton=1').fetchone()[0]: state='held'
            db.execute("UPDATE completion SET state=?,after_evidence=? WHERE singleton=1 AND state IN ('claimed','uncertain','observing','verified','observed_after_uncertain_write')",
                       (state,json.dumps(evidence)))
            return db.execute('SELECT state FROM completion WHERE singleton=1').fetchone()[0]
