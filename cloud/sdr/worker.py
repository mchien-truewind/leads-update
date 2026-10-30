"""Bounded hosted tick; blocking SQLite/provider work stays off the ASGI loop."""
import asyncio
import json
import time

from .completion import Completion, validate_approval


class Worker:
    def __init__(self, store, scope, broker, *, approval=None, policy=None, clock=time.time, report=None, notes_enabled=False):
        self.core=Completion(store,scope,policy=policy,clock=clock)
        if approval is not None:
            validate_approval(approval)
            if policy is None: raise ValueError('completion approval requires configured disposition policy')
            policy.authorize(approval)
        self.store,self.broker,self.approval=store,broker,approval
        self.report=report or (lambda value:print(json.dumps(value,sort_keys=True),flush=True))
        self.last_report=None
        self.notes_enabled=notes_enabled
        if notes_enabled:
            if approval is None: raise ValueError('task notes require approved call')
            with store.db() as db:
                db.execute('CREATE TABLE IF NOT EXISTS note_receipt (call_id TEXT PRIMARY KEY,event_digest TEXT NOT NULL,note_state TEXT NOT NULL)')

    def call(self,operation,payload):
        raw=b'' if operation=='inspect' else json.dumps(payload,sort_keys=True,separators=(',',':')).encode()
        return asyncio.run(self.broker.call('/v1/lemlist/'+operation,raw))

    def note_tick(self):
        from .task_notes import note_block, digest
        with self.store.db() as db:
            old=db.execute('SELECT event_digest,note_state FROM note_receipt WHERE call_id=?',(self.approval['call_id'],)).fetchone()
            if old and old[0]!=self.approval['event_digest']: raise ValueError('note receipt differs')
            if old and old[1]=='verified': return 'verified'
            rows=db.execute('SELECT digest,evidence FROM events').fetchall()
            if len(rows)!=1 or rows[0][0]!=self.approval['event_digest']: raise ValueError('note event differs')
            event=json.loads(rows[0][1])
        expected=digest(note_block(event,self.approval,self.core.scope))
        result=self.call('note',{'approval':self.approval,'event':event})
        if (not isinstance(result,dict) or result.get('scope')!=self.core.scope
                or result.get('call_id')!=self.approval['call_id'] or result.get('event_digest')!=self.approval['event_digest']
                or result.get('note_digest')!=expected or result.get('note_state') not in ('verified','observing','uncertain')):
            raise ValueError('invalid note readback')
        with self.store.db() as db:
            db.execute('INSERT INTO note_receipt VALUES(?,?,?) ON CONFLICT(call_id) DO UPDATE SET note_state=excluded.note_state',
                (self.approval['call_id'],self.approval['event_digest'],result['note_state']))
        return result['note_state']

    def tick(self):
        action=self.core.assess_event()
        state=self.core.status()['state']
        try:
            if state=='not_armed': self.core.arm(self.call)
            elif state=='armed' and self.approval is not None: self.core.complete(self.approval,self.call)
            elif state in ('claimed','uncertain','observing'):
                self.core.reconcile(self.call)
        except Exception:
            # Retry reads only. A completion failure has already persisted its
            # claim; neither this loop nor a redeploy resets that claim.
            pass
        result={'event':'sdr_test_status','test_contact_id':self.core.scope['hubspot_contact_id'],**self.core.status()}
        if action: result['disposition_action']=action
        if self.notes_enabled and result['state']=='verified':
            try: result['note_state']=self.note_tick()
            except Exception: result['note_state']='pending'
        readback=self.core.observation_summary()
        if readback is not None: result['readback']=readback
        if result['state']=='armed' and self.approval is None:
            with self.store.db() as db:
                rows=db.execute('SELECT digest,evidence FROM events').fetchall()
            if len(rows)==1:
                event=json.loads(rows[0][1])
                result.update(event='sdr_test_awaiting_confirmation' if self.core.policy else 'sdr_test_awaiting_mapping',event_digest=rows[0][0],
                    **{k:event[k] for k in ('call_id','rep_id','disposition_id')})
                if self.core.policy: result['policy_digest']=self.core.policy.digest
        if result!=self.last_report:
            self.report(result);self.last_report=result
        return result

    async def run(self):
        while True:
            await asyncio.to_thread(self.tick)
            await asyncio.sleep(30)
