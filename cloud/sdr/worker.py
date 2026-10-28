"""Bounded hosted tick; blocking SQLite/provider work stays off the ASGI loop."""
import asyncio
import json
import time

from .completion import Completion, validate_approval


class Worker:
    def __init__(self, store, scope, broker, *, approval=None, policy=None, clock=time.time, report=None):
        self.core=Completion(store,scope,policy=policy,clock=clock)
        if approval is not None:
            validate_approval(approval)
            if policy is None: raise ValueError('completion approval requires configured disposition policy')
            policy.authorize(approval)
        self.store,self.broker,self.approval=store,broker,approval
        self.report=report or (lambda value:print(json.dumps(value,sort_keys=True),flush=True))
        self.last_report=None

    def call(self,operation,payload):
        raw=b'' if operation=='inspect' else json.dumps(payload,sort_keys=True,separators=(',',':')).encode()
        return asyncio.run(self.broker.call('/v1/lemlist/'+operation,raw))

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
        result={'event':'sdr_test_status',**self.core.status()}
        if action: result['disposition_action']=action
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
