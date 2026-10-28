"""Hosted proof core: dummy HTTP, real SQLite and no live provider operations."""
import copy
import datetime
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from urllib.parse import parse_qs

import httpx
from cloud.sdr.completion import Completion
from cloud.sdr.dispositions import DispositionPolicy
from cloud.sdr.lemlist_provider import Provider
from cloud.sdr.private_claim import PrivateClaim
from cloud.sdr.receiver import Store


class CloudCompletionTests(unittest.TestCase):
    def setUp(self):
        self.now=1793205000
        self.scope=dict(hubspot_contact_id='123',campaign_id='cam_test',sequence_id='seq_test',
            call_step_id='stp_call',continuation_step_id='stp_next',task_id='opp_call',lead_id='lea_test',
            contact_id='ctc_test',assigned_rep_id='usr_test',workspace_id='workspace',
            starts_at=self.now-10,expires_at=self.now+1000)
        self.contact={'_id':'ctc_test','unsubscribed':False,
            'crmSync':{'provider':'hubspot','crmRecordId':'123','syncDisabled':False},
            'campaigns':[{'campaignId':'cam_test','leadId':'lea_test','campaignState':'running','leadState':'running'}],
            'email':'private@example.test','fields':{'phone':'private phone'}}
        self.lead={'_id':'lea_test','campaignId':'cam_test','contactId':'ctc_test','isPaused':False}
        self.sequences={'seq_test':{'_id':'seq_test','level':0,'steps':[
            {'_id':'stp_call','index':0,'type':'manual','sequenceId':'seq_test','title':'M0 Call in Nooks'},
            {'_id':'stp_next','index':1,'type':'manual','sequenceId':'seq_test','title':'M0 Continuation confirmed'}]}}
        self.task={'_id':'opp_call','campaignId':'cam_test','leadId':'lea_test','contactId':'ctc_test',
            'type':'manual','title':'M0 Call in Nooks','status':'due','assignedTo':'usr_test',
            'campaign':{'id':'cam_test','sequenceId':'seq_test'}}
        self.next_task=dict(self.task,_id='opp_next',title='M0 Continuation confirmed')
        self.done=False;self.step='stp_call';self.continuation=True;self.writes=[];self.requests=[]
        self.provider=Provider('dummy-private-key',self.scope,allow_write=True,
            transport=httpx.MockTransport(self.http),clock=lambda:self.now)
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.store=Store(Path(self.tmp.name)/'state',dict(workspace_id='workspace',prospect_id='123',
            not_before=self.scope['starts_at'],expires_at=self.scope['expires_at']))
        self.policy=DispositionPolicy(dict(workspace_id="workspace",nooks_rep_id="nooksrep",
            lemlist_rep_id="usr_test",dispositions={"disp1":"complete","dnc":"suppress","callback":"hold"}),self.scope)
        self.core=Completion(self.store,self.scope,policy=self.policy,clock=lambda:self.now)
        self.core.arm(self.call)
        self.now+=1
        self.event=dict(workspace_id='workspace',prospect_id='123',call_id='call1',rep_id='nooksrep',
            disposition_id='disp1',disposition_name='No Answer',started_at=self.now,finalized_at=self.now)
        self.store.capture(self.event,self.now)
        raw=json.dumps(self.event,sort_keys=True,separators=(',',':'))
        self.approval=dict(call_id='call1',event_digest=hashlib.sha256(raw.encode()).hexdigest(),
            rep_id='nooksrep',disposition_id='disp1',policy_digest=self.policy.digest,confirmed_contact=True,
            confirmed_non_suppressing_disposition=True)

    def http(self,request):
        self.requests.append((request.method,request.url.host,request.url.path))
        self.assertEqual(request.url.host,'api.lemlist.com')
        self.assertTrue(request.headers['Authorization'].startswith('Basic '))
        path=request.url.path
        if request.method=='PATCH':
            body=json.loads(request.content)
            self.assertEqual((path,body),('/api/tasks',{'id':'opp_call','done':True}))
            self.writes.append(body);self.done=True
            return httpx.Response(204)
        if path=='/api/contacts': result=[self.contact]
        elif path=='/api/leads': result=self.lead
        elif path=='/api/campaigns/cam_test/sequences': result=self.sequences
        elif path=='/api/v2/tasks':
            task=dict(self.task,status='done' if self.done else 'due')
            q=parse_qs(request.url.query.decode())
            rows=[task]
            if 'taskId' not in q and self.done and self.continuation: rows.append(self.next_task)
            result={'total':len(rows),'results':rows}
        elif path=='/api/activities':
            result=[] if not self.done else [{'_id':'act_test','type':'manualDone','campaignId':'cam_test',
                'leadId':'lea_test','contactId':'ctc_test','opportunityId':'opp_call','stepId':self.step,
                'sequenceId':'seq_test','createdAt':datetime.datetime.fromtimestamp(self.now,datetime.timezone.utc).isoformat()}]
        else: self.fail('Unexpected provider path')
        return httpx.Response(200,json=result)

    def call(self,operation,approval):
        if operation=='complete': self.assertEqual(approval,self.approval)
        else: self.assertEqual(approval,{})
        return self.provider.run(operation)

    def test_selected_event_completes_exact_task_and_independently_observes_next_task(self):
        self.assertEqual(self.core.complete(self.approval,self.call),'verified')
        self.assertEqual(self.writes,[{'id':'opp_call','done':True}])
        restarted=Completion(self.store,self.scope,clock=lambda:self.now)
        with self.assertRaises(ValueError): restarted.complete(self.approval,self.call)
        self.assertEqual(len(self.writes),1)
        self.assertEqual(self.store.capture(self.event,self.now),'duplicate')
        self.assertEqual(restarted.status(),{'state':'verified','write_receipt':1})
        result=self.provider.run('inspect')
        self.assertIsNone(result['task']['provider_step_id'])
        self.assertIsNone(result['continuation_tasks'][0]['provider_step_id'])
        for private in ('private@example.test','private phone','dummy-private-key'):
            self.assertNotIn(private,json.dumps(result))

    def test_lost_response_after_write_restarts_with_inspection_only_even_after_expiry(self):
        def lost(operation,approval):
            result=self.call(operation,approval)
            if operation=='complete':raise OSError('dummy lost response')
            return result
        with self.assertRaises(ValueError):self.core.complete(self.approval,lost)
        self.assertEqual(self.core.status()['state'],'uncertain')
        self.now=self.scope['expires_at']+1
        restarted=Completion(self.store,self.scope,clock=lambda:self.now)
        self.assertEqual(restarted.reconcile(self.call),'observed_after_uncertain_write')
        with self.assertRaises(ValueError):restarted.complete(self.approval,self.call)
        self.assertEqual(len(self.writes),1)

    def test_crash_after_durable_claim_never_retries_dispatch(self):
        def crash(operation,approval):
            if operation=='complete':raise KeyboardInterrupt()
            return self.call(operation,approval)
        with self.assertRaises(KeyboardInterrupt):self.core.complete(self.approval,crash)
        self.assertEqual(self.core.status()['state'],'claimed')
        self.assertEqual(Completion(self.store,self.scope,clock=lambda:self.now).reconcile(self.call),'observing')
        with self.assertRaises(ValueError):self.core.complete(self.approval,self.call)
        self.assertEqual(self.writes,[])

    def test_external_completion_at_private_preflight_is_held_without_our_write(self):
        def raced(operation,approval):
            if operation=='complete':self.done=True
            return self.call(operation,approval)
        self.assertEqual(self.core.complete(self.approval,raced),'held')
        self.assertEqual(self.core.status()['write_receipt'],0)
        self.assertEqual(self.writes,[])

    def test_wrong_step_or_missing_continuation_never_claims_verified(self):
        self.step='stp_other'
        self.assertEqual(self.core.complete(self.approval,self.call),'held')
        self.assertEqual(len(self.writes),1)

    def test_missing_continuation_remains_observing_without_repeating_patch(self):
        self.continuation=False
        self.assertEqual(self.core.complete(self.approval,self.call),'observing')
        self.continuation=True
        self.assertEqual(self.core.reconcile(self.call),'verified')
        self.assertEqual(len(self.writes),1)

    def test_conflict_accepted_during_preflight_prevents_dispatch(self):
        def conflict(operation,approval):
            self.assertEqual(operation,'inspect')
            self.store.capture(dict(self.event,disposition_id='do-not-call'),self.now)
            return self.call(operation,approval)
        with self.assertRaises(ValueError):self.core.complete(self.approval,conflict)
        self.assertEqual(self.core.status()['state'],'held')
        self.assertEqual(self.writes,[])

    def test_disposition_conflict_after_write_is_still_held(self):
        self.assertEqual(self.core.complete(self.approval,self.call),'verified')
        self.store.capture(dict(self.event,disposition_id='do-not-call'),self.now)
        self.assertEqual(self.core.reconcile(self.call),'held')
        self.assertEqual(len(self.writes),1)

    def test_approval_digest_and_flags_are_required(self):
        for change in ({'event_digest':'0'*64},{'rep_id':'other'},{'disposition_id':'other'},
                       {'confirmed_contact':False},{'confirmed_non_suppressing_disposition':False}):
            with self.subTest(change=change),self.assertRaises(ValueError):
                self.core.complete(dict(self.approval,**change),self.call)
        self.assertEqual(self.writes,[])

    def test_changed_scope_and_rearm_cannot_reset_original_journal(self):
        with self.assertRaises(ValueError): Completion(self.store,dict(self.scope,task_id='opp_other'))
        with self.assertRaises(ValueError):self.core.arm(self.call)
        self.assertEqual(self.core.status()['state'],'armed')

    def test_private_provider_rechecks_suppression_and_manual_steps_before_patch(self):
        for update,undo in (
            (lambda:self.contact.update(unsubscribed=True),lambda:self.contact.update(unsubscribed=False)),
            (lambda:self.contact['campaigns'][0].update(leadState='paused'),lambda:self.contact['campaigns'][0].update(leadState='running')),
            (lambda:self.sequences['seq_test']['steps'][1].update(type='email'),lambda:self.sequences['seq_test']['steps'][1].update(type='manual')),
            (lambda:self.task.update(assignedTo='usr_other'),lambda:self.task.update(assignedTo='usr_test'))):
            update()
            with self.assertRaises(ValueError):self.provider.run('complete')
            undo()
        self.assertEqual(self.writes,[])

    def test_known_wrong_call_step_prevents_dispatch_at_both_boundaries(self):
        self.task['stepId']='stp_other'
        with self.assertRaises(ValueError):self.core.complete(self.approval,self.call)
        with self.assertRaises(ValueError):self.provider.run('complete')
        self.assertEqual(self.writes,[])
        self.assertEqual(self.core.status()['state'],'armed')

    def test_conflicting_step_between_inspection_and_private_dispatch_never_writes(self):
        def changed_mapping(operation,approval):
            if operation=='complete':self.task['stepId']='stp_other'
            return self.call(operation,approval)
        with self.assertRaises(ValueError):self.core.complete(self.approval,changed_mapping)
        self.assertEqual(self.writes,[])
        self.assertEqual(self.core.status()['state'],'uncertain')

    def test_missing_activity_step_stays_observing_without_inventing_correlation(self):
        self.step=None
        self.assertEqual(self.core.complete(self.approval,self.call),'observing')
        self.step='stp_call'
        self.assertEqual(self.core.reconcile(self.call),'verified')
        self.assertEqual(len(self.writes),1)

    def test_private_transport_default_disabled_and_fixed_origin_and_resource_scope(self):
        disabled=Provider('dummy',self.scope,transport=httpx.MockTransport(self.http),clock=lambda:self.now)
        with self.assertRaises(ValueError):disabled.run('complete')
        for method,path,payload in [('GET','https://example.test/api/contacts',None),
             ('GET','/api/contacts?crmIds=999',None),('PATCH','/api/tasks',{'id':'opp_other','done':True}),
             ('POST','/api/campaigns/cam_test/start',{}),('GET','/api/contacts?crmIds=123&crmIds=999',None),
             ('GET','/api/leads?id=lea_other',None),('GET','/api/leads?id=lea_test&email=other@example.test',None)]:
            self.assertFalse(self.provider._allowed(method,path,payload))
        self.assertEqual(self.writes,[])

    def test_stage_label_is_not_used_as_a_pause_flag(self):
        for stage in ('scanned','contacted','unknown',None):
            self.contact['campaigns'][0]['leadState']=stage
            evidence=self.provider.run('inspect')
            self.assertEqual(evidence['task']['status'],'due')
        self.lead['isPaused']=True
        with self.assertRaises(ValueError):self.provider.run('complete')
        self.assertEqual(self.writes,[])

    def test_lead_pause_readback_requires_exact_identity_and_explicit_false(self):
        original=dict(self.lead)
        for change in ({'isPaused':True},{'isPaused':None},{'isPaused':0},
                {'campaignId':'cam_other'},{'contactId':'ctc_other'},{'_id':'lea_other'}):
            self.lead=dict(original,**change)
            with self.subTest(change=change),self.assertRaises(ValueError):self.provider.run('complete')
        self.lead=dict(original);del self.lead['isPaused']
        with self.assertRaises(ValueError):self.provider.run('complete')
        self.assertEqual(self.writes,[])

    def test_private_transport_rejects_redirect_oversize_duplicate_json_and_http_failures(self):
        for response in (httpx.Response(302,headers={'Location':'https://example.test'}),
            httpx.Response(200,content=b' '*131073),httpx.Response(200,content=b'{"x":1,"x":2}'),
            httpx.Response(503,content=b'dummy secret provider error')):
            calls=[]
            def fake(request):calls.append(request);return response
            provider=Provider('dummy-private-key',self.scope,transport=httpx.MockTransport(fake))
            with self.assertRaises(ValueError) as error:provider.run('inspect')
            self.assertNotIn('dummy secret',str(error.exception))
            self.assertEqual(len(calls),1)


if __name__=='__main__':unittest.main()

class HostedBoundaryTests(unittest.TestCase):
    # Share fixtures without rerunning the core test methods.
    setUp=CloudCompletionTests.setUp
    http=CloudCompletionTests.http
    call=CloudCompletionTests.call
    def boundary(self, approval):
        from cloud.sdr.receiver import Broker
        from cloud.sdr.verifier import create_app
        key=self.store.identity()
        private=create_app(signing_key='dummy',public_key=key.public_key().public_bytes_raw().hex(),
            scope=self.store.scope,clock=lambda:self.now,lemlist_provider=self.provider,approval=approval,
            private_claim=PrivateClaim(Path(self.tmp.name)/'private',self.scope,clock=lambda:self.now),
            disposition_policy=self.policy)
        return Broker('http://nooks-verifier.railway.internal:8080',key,
            transport=httpx.ASGITransport(app=private),clock=lambda:self.now)

    def test_authenticated_private_completion_requires_matching_configured_approval(self):
        import asyncio
        from cloud.sdr.worker import Worker
        broker=self.boundary(None)
        with self.assertRaises(ValueError):
            asyncio.run(broker.call('/v1/lemlist/complete',json.dumps(self.approval).encode()))
        self.assertEqual(self.writes,[])
        broker=self.boundary(self.approval)
        changed=dict(self.approval,event_digest='0'*64)
        with self.assertRaises(ValueError):
            asyncio.run(broker.call('/v1/lemlist/complete',json.dumps(changed).encode()))
        logs=[]
        worker=Worker(self.store,self.scope,broker,policy=self.policy,approval=self.approval,clock=lambda:self.now,report=logs.append)
        self.assertEqual(worker.tick()['state'],'verified')
        self.assertEqual(worker.tick()['state'],'verified')
        self.assertEqual(len(self.writes),1)
        self.assertEqual(len(logs),1)

    def test_missing_approval_reports_only_bounded_identifiers_and_no_write(self):
        from cloud.sdr.worker import Worker
        logs=[]
        worker=Worker(self.store,self.scope,self.boundary(None),clock=lambda:self.now,report=logs.append)
        result=worker.tick()
        self.assertEqual(set(result),{'event','state','write_receipt','event_digest','call_id','rep_id','disposition_id','policy_digest','disposition_action'})
        self.assertEqual(result['event'],'sdr_test_awaiting_confirmation')
        worker.tick()
        self.assertEqual(len(logs),1)
        self.assertEqual(self.writes,[])
        for text in ('No Answer','private@example.test','private phone','dummy-private-key'):
            self.assertNotIn(text,json.dumps(logs))

    def test_worker_reconciles_lost_response_without_dispatch_after_restart(self):
        from cloud.sdr.worker import Worker
        broker=self.boundary(self.approval)
        original=broker.call
        async def lost(path,*args):
            result=await original(path,*args)
            if path.endswith('/complete'):raise OSError('lost')
            return result
        broker.call=lost
        worker=Worker(self.store,self.scope,broker,policy=self.policy,approval=self.approval,clock=lambda:self.now,report=lambda value:None)
        self.assertEqual(worker.tick()['state'],'uncertain')
        restarted=Worker(self.store,self.scope,self.boundary(self.approval),policy=self.policy,approval=self.approval,
            clock=lambda:self.now,report=lambda value:None)
        self.assertEqual(restarted.tick()['state'],'observed_after_uncertain_write')
        self.assertEqual(len(self.writes),1)

class AsyncSafetyTests(unittest.TestCase):
    setUp=CloudCompletionTests.setUp
    http=CloudCompletionTests.http
    call=CloudCompletionTests.call

    def test_cancelled_private_waiter_does_not_unlock_inflight_provider_write(self):
        import asyncio,threading
        from cloud.sdr.receiver import Broker
        from cloud.sdr.verifier import create_app
        entered,released,finished=threading.Event(),threading.Event(),threading.Event()
        calls=[]
        class Slow:
            scope=self.scope
            def run(inner,operation):
                calls.append(operation);entered.set()
                try:
                    if not released.wait(3):raise RuntimeError('test release missing')
                    return {'write_attempted':True}
                finally:finished.set()
        key=self.store.identity()
        private=create_app(signing_key='dummy',public_key=key.public_key().public_bytes_raw().hex(),
            scope=self.store.scope,clock=lambda:self.now,lemlist_provider=Slow(),approval=self.approval,
            private_claim=PrivateClaim(Path(self.tmp.name)/'private',self.scope,clock=lambda:self.now),
            disposition_policy=self.policy)
        broker=Broker('http://nooks-verifier.railway.internal:8080',key,
            transport=httpx.ASGITransport(app=private),clock=lambda:self.now)
        async def exercise():
            raw=json.dumps(self.approval).encode()
            first=asyncio.create_task(broker.call('/v1/lemlist/complete',raw))
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait,2))
                first.cancel()
                with self.assertRaises(asyncio.CancelledError):await first
                with self.assertRaises(ValueError):await broker.call('/v1/lemlist/complete',raw)
                self.assertEqual(calls,['complete'])
            finally:
                released.set()
                await asyncio.to_thread(finished.wait,2)
        asyncio.run(exercise())

    def test_waiting_sqlite_capture_does_not_block_http_health(self):
        import asyncio,threading
        from unittest.mock import patch
        from cloud.sdr.receiver import create_app
        entered,released=threading.Event(),threading.Event()
        class FakeBroker:
            async def call(inner,*args):return {'event':self.event}
        app=create_app(self.store,FakeBroker(),clock=lambda:self.now)
        def slow_capture(*args):
            entered.set()
            if not released.wait(2):raise RuntimeError('capture blocked event loop')
            return 'duplicate'
        async def exercise():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
                post=asyncio.create_task(client.post('/api/sdr/webhooks/nooks',content=b'{}',headers={'x-webhook-signature':'dummy'}))
                try:
                    self.assertTrue(await asyncio.to_thread(entered.wait,1))
                    health=await asyncio.wait_for(client.get('/healthz'),.5)
                    self.assertEqual(health.status_code,200)
                finally:released.set()
                self.assertEqual((await post).json(),{'status':'duplicate'})
        with patch.object(self.store,'capture',slow_capture):asyncio.run(exercise())


class PrivateDurabilityTests(unittest.TestCase):
    setUp=CloudCompletionTests.setUp
    http=CloudCompletionTests.http
    call=CloudCompletionTests.call
    boundary=HostedBoundaryTests.boundary

    def complete_request(self, broker, approval=None):
        import asyncio
        return asyncio.run(broker.call('/v1/lemlist/complete',json.dumps(approval or self.approval).encode()))

    def test_uncertain_patch_with_stale_due_readback_never_repeats_after_retry_or_restart(self):
        attempts=[]
        def uncertain(request):
            if request.method=='PATCH':
                attempts.append(request.method)
                raise httpx.ReadTimeout('dummy response lost',request=request)
            return self.http(request)
        self.provider.transport=httpx.MockTransport(uncertain)
        broker=self.boundary(self.approval)
        with self.assertRaises(ValueError):self.complete_request(broker)
        self.assertFalse(self.complete_request(broker)['write_attempted'])
        restarted=self.boundary(self.approval)
        self.assertFalse(self.complete_request(restarted)['write_attempted'])
        self.now=self.scope['expires_at']+1
        self.assertFalse(self.complete_request(restarted)['write_attempted'])
        self.assertEqual(attempts,['PATCH'])
        self.assertFalse(self.done)

    def test_claim_survives_crash_before_dispatch_and_changed_approval_cannot_reset_it(self):
        from unittest.mock import patch
        broker=self.boundary(self.approval)
        with patch.object(self.provider,'run',side_effect=RuntimeError('dummy failure before dispatch')):
            with self.assertRaises(ValueError):self.complete_request(broker)
        restarted=self.boundary(self.approval)
        self.assertFalse(self.complete_request(restarted)['write_attempted'])
        changed=dict(self.approval,event_digest='0'*64)
        with self.assertRaises(ValueError):self.complete_request(self.boundary(changed),changed)
        self.assertEqual(self.writes,[])

    def test_private_scope_change_fails_and_concurrent_process_claims_allow_only_one(self):
        import concurrent.futures
        path=Path(self.tmp.name)/'private'
        first=PrivateClaim(path,self.scope,clock=lambda:self.now)
        second=PrivateClaim(path,self.scope,clock=lambda:self.now)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda claim:claim.claim(self.approval),(first,second)))
        self.assertEqual(sorted(results),[False,True])
        with self.assertRaises(ValueError):PrivateClaim(path,dict(self.scope,task_id='opp_other'))

    def test_claim_commit_failure_prevents_any_provider_request(self):
        from unittest.mock import patch
        broker=self.boundary(self.approval)
        self.requests.clear()
        with patch.object(PrivateClaim,'claim',side_effect=OSError('dummy disk full')):
            with self.assertRaises(ValueError):self.complete_request(broker)
        self.assertEqual(self.requests,[])

    def test_missing_private_ledger_never_calls_provider(self):
        from cloud.sdr.receiver import Broker
        from cloud.sdr.verifier import create_app
        key=self.store.identity()
        app=create_app(signing_key='dummy',public_key=key.public_key().public_bytes_raw().hex(),
            scope=self.store.scope,clock=lambda:self.now,lemlist_provider=self.provider,approval=self.approval,disposition_policy=self.policy)
        broker=Broker('http://nooks-verifier.railway.internal:8080',key,
            transport=httpx.ASGITransport(app=app),clock=lambda:self.now)
        self.requests.clear()
        with self.assertRaises(ValueError):self.complete_request(broker)
        self.assertEqual(self.requests,[])

    def test_optional_scope_requires_private_volume_but_capture_only_does_not(self):
        from unittest.mock import patch
        from cloud.sdr.verifier import configured
        with patch.dict('os.environ',{},clear=True):
            self.assertEqual(configured(self.store.scope),(None,None,None,None))
        with patch.dict('os.environ',{'LEMLIST_TEST_SCOPE':json.dumps(self.scope)},clear=True):
            with self.assertRaises(ValueError):configured(self.store.scope)

    def test_expired_unclaimed_private_scope_cannot_dispatch(self):
        broker=self.boundary(self.approval)
        self.now=self.scope['expires_at']
        self.requests.clear()
        with self.assertRaises(ValueError):self.complete_request(broker)
        self.assertEqual(self.requests,[])
