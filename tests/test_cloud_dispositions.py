"""Real signed ingress -> private verifier -> durable worker -> mocked lemlist.

Uses both ASGI applications, real signatures/SQLite, and only dummy provider data.
"""
import base64
import copy
import datetime
import hashlib
import hmac
import json
from pathlib import Path
import unittest

import httpx
from fastapi.testclient import TestClient

from cloud.sdr.completion import Completion
from cloud.sdr.dispositions import DispositionPolicy
from cloud.sdr.private_claim import PrivateClaim
from cloud.sdr.receiver import Store, Broker, create_app
from cloud.sdr.verifier import create_app as private_app
from cloud.sdr.worker import Worker
import test_cloud_completion as fixtures


class SignedDispositionTests(unittest.TestCase):
    http=fixtures.CloudCompletionTests.http
    call=fixtures.CloudCompletionTests.call

    def setUp(self):
        fixtures.CloudCompletionTests.setUp(self)
        self.store=Store(Path(self.tmp.name)/'signed',self.store.scope,clock=lambda:self.now)
        self.logs=[]
        self.worker=Worker(self.store,self.scope,self.bridge(),policy=self.policy,
            clock=lambda:self.now,report=self.logs.append)
        self.assertEqual(self.worker.tick()['state'],'armed')
        self.now+=2
        iso=lambda n:datetime.datetime.fromtimestamp(n,datetime.timezone.utc).isoformat()
        self.webhook={'event':'call.logged','eventId':'delivery1','occurredAt':iso(self.now),
            'callData':{'workspaceId':'workspace','callId':'signed-call','status':'completed',
                'callDirection':'outbound','prospectData':{'prospectId':'123'},
                'userData':{'userId':'nooksrep'},'disposition':{'id':'disp1','name':'No Answer'},
                'startedAt':iso(self.now-1)}}

    def bridge(self, approval=None, policy=None):
        key=self.store.identity()
        private=private_app(signing_key='dummy-nooks-key',public_key=key.public_key().public_bytes_raw().hex(),
            scope=self.store.scope,clock=lambda:self.now,lemlist_provider=self.provider,approval=approval,
            private_claim=PrivateClaim(Path(self.tmp.name)/'signed-private',self.scope,clock=lambda:self.now),
            disposition_policy=policy or self.policy)
        return Broker('http://nooks-verifier.railway.internal:8080',key,
            transport=httpx.ASGITransport(app=private),clock=lambda:self.now)

    def post(self, webhook=None, *, tamper=False):
        raw=json.dumps(webhook or self.webhook).encode()
        stamp=str(self.now*1000)
        signature=base64.b64encode(hmac.new(b'dummy-nooks-key',stamp.encode()+b'.'+raw,hashlib.sha256).digest()).decode()
        client=TestClient(create_app(self.store,self.bridge(),clock=lambda:self.now))
        return client.post('/api/sdr/webhooks/nooks',content=raw+(b' ' if tamper else b''),
            headers={'x-webhook-signature':'t='+stamp+',s='+signature})

    def approval_for_call(self):
        with self.store.db() as db: digest,encoded=db.execute('SELECT digest,evidence FROM events').fetchone()
        event=json.loads(encoded)
        return dict(call_id=event['call_id'],event_digest=digest,policy_digest=self.policy.digest,
            rep_id=event['rep_id'],disposition_id=event['disposition_id'],confirmed_contact=True,
            confirmed_non_suppressing_disposition=True)

    def test_finalized_disposition_completes_one_task_and_continues_after_signed_delivery(self):
        self.assertEqual(self.post().json(),{'status':'captured'})
        waiting=self.worker.tick()
        self.assertEqual(waiting['event'],'sdr_test_awaiting_confirmation')
        self.assertEqual(waiting['disposition_action'],'completion_allowed')
        self.assertEqual(self.writes,[])
        approved=self.approval_for_call()
        worker=Worker(self.store,self.scope,self.bridge(approved),policy=self.policy,approval=approved,
            clock=lambda:self.now,report=self.logs.append)
        self.assertEqual(worker.tick()['state'],'verified')
        self.assertEqual(self.writes,[{'id':'opp_call','done':True}])
        replay=copy.deepcopy(self.webhook);replay['eventId']='delivery2'
        self.assertEqual(self.post(replay).json(),{'status':'duplicate'})
        restarted=Worker(self.store,self.scope,self.bridge(approved),policy=self.policy,approval=approved,
            clock=lambda:self.now,report=self.logs.append)
        self.assertEqual(restarted.tick()['state'],'verified')
        self.assertEqual(len(self.writes),1)

    def test_worker_reports_missing_activity_link_and_later_progression_without_another_write(self):
        self.assertEqual(self.post().json(),{'status':'captured'})
        approved=self.approval_for_call()
        self.step=None
        worker=Worker(self.store,self.scope,self.bridge(approved),policy=self.policy,approval=approved,
            clock=lambda:self.now,report=self.logs.append)
        first=worker.tick()
        self.assertEqual(first['state'],'observing')
        self.assertTrue(first['readback']['task_done'])
        self.assertEqual(first['readback']['activity_count'],1)
        self.assertFalse(first['readback']['activity_step_present'])
        self.assertFalse(first['readback']['activity_step_matches'])
        self.assertTrue(first['readback']['activity_sequence_matches'])
        self.assertEqual(first['readback']['continuation_task_count'],1)
        self.assertTrue(first['readback']['continuation_pending'])
        with self.store.db() as db:
            before=db.execute('SELECT claimed_at,approval,write_receipt FROM completion').fetchone()
            evidence=json.loads(db.execute('SELECT after_evidence FROM completion').fetchone()[0])
            evidence['private']='dummy-secret-never-log'
            evidence['completion_activities'][0]['note']='private-contact-notes'
            db.execute('UPDATE completion SET after_evidence=?',(json.dumps(evidence),))
        summary=worker.core.observation_summary()
        self.assertEqual(summary,first['readback'])
        for hidden in ('dummy-secret-never-log','private-contact-notes','private@example.test','dummy-private-key'):
            self.assertNotIn(hidden,json.dumps(summary))
        self.step='stp_call'
        self.now=self.scope['expires_at']+1
        restarted=Worker(self.store,self.scope,self.bridge(approved),policy=self.policy,approval=approved,
            clock=lambda:self.now,report=self.logs.append)
        final=restarted.tick()
        self.assertEqual(final['state'],'verified')
        self.assertTrue(final['readback']['activity_step_matches'])
        self.assertEqual(len(self.writes),1)
        with self.store.db() as db:
            self.assertEqual(db.execute('SELECT claimed_at,approval,write_receipt FROM completion').fetchone(),before)

    def test_unknown_id_cannot_complete_even_with_safe_display_name_and_confirmation(self):
        self.webhook['callData']['disposition']['id']='unreviewed'
        self.assertEqual(self.post().status_code,200)
        approved=self.approval_for_call()
        with self.assertRaises(ValueError):
            Worker(self.store,self.scope,self.bridge(approved),policy=self.policy,approval=approved,
                clock=lambda:self.now,report=self.logs.append)
        result=self.worker.tick()
        self.assertEqual((result['state'],result['disposition_action']),('held','unmapped_disposition'))
        self.assertEqual(self.writes,[])

    def test_dnc_id_with_misleading_display_name_is_held_without_claiming_suppression(self):
        self.webhook['callData']['disposition']={'id':'dnc','name':'No Answer'}
        self.assertEqual(self.post().status_code,200)
        result=self.worker.tick()
        self.assertEqual((result['state'],result['disposition_action']),('held','suppression_required'))
        self.assertEqual(self.writes,[])
        self.assertFalse(self.done)

    def test_wrong_caller_is_held_despite_correct_contact_and_disposition(self):
        self.webhook['callData']['userData']['userId']='other-rep'
        self.assertEqual(self.post().status_code,200)
        result=self.worker.tick()
        self.assertEqual((result['state'],result['disposition_action']),('held','caller_mismatch'))
        self.assertEqual(self.writes,[])

    def test_unfinalized_and_tampered_webhooks_never_reach_completion(self):
        self.assertEqual(self.post(tamper=True).status_code,503)
        self.webhook['callData']['status']='in_progress'
        self.assertEqual(self.post().status_code,503)
        self.assertEqual(self.store.summary()['event_count'],0)
        self.assertEqual(self.worker.tick()['state'],'armed')
        self.assertEqual(self.writes,[])

    def test_reviewed_policy_cannot_change_after_arm(self):
        changed=copy.deepcopy(self.policy.value);changed['dispositions']['dnc']='complete'
        with self.assertRaises(ValueError):
            Completion(self.store,self.scope,policy=DispositionPolicy(changed,self.scope),clock=lambda:self.now)
        self.assertEqual(self.writes,[])

    def test_initial_capture_can_discover_ids_but_mapping_is_required_before_completion(self):
        store=Store(Path(self.tmp.name)/'unconfigured',self.store.scope,clock=lambda:self.now)
        core=Completion(store,self.scope,clock=lambda:self.now)
        core.arm(self.call)
        self.now+=1
        event=dict(self.event,started_at=self.now,finalized_at=self.now)
        store.capture(event,self.now)
        self.assertEqual(core.assess_event(),'mapping_required')
        with self.assertRaises(ValueError):core.complete(self.approval,self.call)
        self.assertEqual(self.writes,[])
        configured=Completion(store,self.scope,policy=self.policy,clock=lambda:self.now)
        self.assertEqual(configured.assess_event(),'completion_allowed')
        changed=copy.deepcopy(self.policy.value);changed['dispositions']['disp1']='hold'
        with self.assertRaises(ValueError):
            Completion(store,self.scope,policy=DispositionPolicy(changed,self.scope),clock=lambda:self.now)

    def test_hold_disposition_is_durable_across_worker_restart(self):
        self.webhook['callData']['disposition']['id']='callback'
        self.assertEqual(self.post().status_code,200)
        self.assertEqual(self.worker.tick()['state'],'held')
        restarted=Worker(self.store,self.scope,self.bridge(),policy=self.policy,
            clock=lambda:self.now,report=self.logs.append)
        self.assertEqual(restarted.tick()['state'],'held')
        self.assertEqual(self.writes,[])

    def test_private_service_rejects_a_different_policy_before_claim_or_provider_call(self):
        import asyncio
        self.assertEqual(self.post().status_code,200)
        approved=self.approval_for_call()
        changed=copy.deepcopy(self.policy.value);changed['dispositions']['disp1']='hold'
        broker=self.bridge(approved,DispositionPolicy(changed,self.scope))
        self.requests.clear()
        with self.assertRaises(ValueError):
            asyncio.run(broker.call('/v1/lemlist/complete',json.dumps(approved).encode()))
        self.assertEqual(self.requests,[])
        # Rejection did not consume the private completion grant.
        result=asyncio.run(self.bridge(approved).call('/v1/lemlist/complete',json.dumps(approved).encode()))
        self.assertTrue(result['write_attempted'])
        self.assertEqual(len(self.writes),1)

    def test_matching_event_without_continuation_is_not_reported_as_verified(self):
        self.continuation=False
        self.assertEqual(self.post().status_code,200)
        approved=self.approval_for_call()
        worker=Worker(self.store,self.scope,self.bridge(approved),policy=self.policy,approval=approved,
            clock=lambda:self.now,report=self.logs.append)
        self.assertEqual(worker.tick()['state'],'observing')
        self.assertEqual(worker.tick()['state'],'observing')
        self.assertEqual(len(self.writes),1)


class PolicyValidationTests(unittest.TestCase):
    def test_mapping_is_exact(self):
        scope={'workspace_id':'w','assigned_rep_id':'usr_test'}
        value={'workspace_id':'w','nooks_rep_id':'rep','lemlist_rep_id':'usr_test','dispositions':{'known':'complete'}}
        for change in ({'workspace_id':'other'},{'lemlist_rep_id':'usr_other'},
                {'dispositions':{'known':'resume'}},{'dispositions':{}},{'nooks_rep_id':''}):
            with self.subTest(change=change),self.assertRaises(ValueError):
                DispositionPolicy(dict(value,**change),scope)
        policy=DispositionPolicy(value,scope)
        self.assertEqual(policy.action({'rep_id':'rep','disposition_id':'unknown','disposition_name':'No Answer'}),'unmapped_disposition')


if __name__=='__main__':unittest.main()


class RetargetTests(unittest.TestCase):
    """Explicitly retire an untouched test; recover one already-finalized call."""
    def setUp(self):
        import tempfile
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.now=1793205000
        self.old=dict(hubspot_contact_id='123',campaign_id='cam_test',sequence_id='seq_test',
            call_step_id='stp_call',continuation_step_id='stp_next',task_id='opp_old',lead_id='lea_old',
            contact_id='ctc_old',assigned_rep_id='usr_test',workspace_id='workspace',
            starts_at=self.now-500,expires_at=self.now+1000)
        self.scope=dict(self.old,hubspot_contact_id='456',task_id='opp_new',lead_id='lea_new',contact_id='ctc_new')
        self.plan=dict(from_scope=self.old,to_scope=self.scope,call_id='existing-call',confirmed_contact=True)
        self.store=Store(self.root/'public',self.capture_scope(self.old),clock=lambda:self.now)
        self.original=Completion(self.store,self.old,clock=lambda:self.now-200)
        self.original.arm(lambda *_:self.evidence(self.old))
        self.private=PrivateClaim(self.root/'private',self.old,clock=lambda:self.now)
        self.policy=DispositionPolicy(dict(workspace_id='workspace',nooks_rep_id='nooksrep',
            lemlist_rep_id='usr_test',dispositions={'disp_connected':'complete'}),self.scope)
        self.writes=[];self.done=False;self.paused=False
        iso=lambda n:datetime.datetime.fromtimestamp(n,datetime.timezone.utc).isoformat()
        self.webhook={'event':'call.logged','occurredAt':iso(self.now-70),'callData':{
            'workspaceId':'workspace','callId':'existing-call','status':'completed','callDirection':'outbound',
            'prospectData':{'prospectId':'456'},'userData':{'userId':'nooksrep'},
            'disposition':{'id':'disp_connected','name':'Connected'},'startedAt':iso(self.now-100)}}

    @staticmethod
    def capture_scope(scope):
        from cloud.sdr.retarget import capture_scope
        return capture_scope(scope)

    @staticmethod
    def evidence(scope):
        return {'scope':scope,'task':{'task_id':scope['task_id'],'status':'due','done':False,
            'provider_step_id':None,'provider_sequence_id':scope['sequence_id']},
            'completion_activities':[],'continuation_tasks':[]}

    def migrate(self):
        self.private=PrivateClaim(self.root/'private',self.scope,clock=lambda:self.now,retarget_plan=self.plan)
        self.store=Store(self.root/'public',self.capture_scope(self.scope),clock=lambda:self.now,retarget_plan=self.plan)

    def http(self,request):
        from urllib.parse import parse_qs
        s=self.scope;p=request.url.path
        self.assertEqual(request.url.host,'api.lemlist.com')
        if request.method=='PATCH':
            value=json.loads(request.content)
            self.assertEqual(value,{'id':s['task_id'],'done':True})
            self.writes.append(value);self.done=True
            return httpx.Response(204)
        self.assertEqual(request.method,'GET')
        task={'_id':s['task_id'],'campaignId':s['campaign_id'],'leadId':s['lead_id'],
            'contactId':s['contact_id'],'type':'manual','title':'M0 Call in Nooks',
            'status':'done' if self.done else 'due','assignedTo':s['assigned_rep_id'],
            'campaign':{'id':s['campaign_id'],'sequenceId':s['sequence_id']}}
        if p=='/api/contacts':
            value=[{'_id':s['contact_id'],'unsubscribed':False,
                'crmSync':{'provider':'hubspot','crmRecordId':s['hubspot_contact_id'],'syncDisabled':False},
                'campaigns':[{'campaignId':s['campaign_id'],'leadId':s['lead_id'],
                              'campaignState':'running','leadState':'scanned'}]}]
        elif p=='/api/leads':
            value={'_id':s['lead_id'],'campaignId':s['campaign_id'],'contactId':s['contact_id'],'isPaused':self.paused}
        elif p=='/api/campaigns/cam_test/sequences':
            value={s['sequence_id']:{'_id':s['sequence_id'],'level':0,'steps':[
                {'_id':s['call_step_id'],'index':0,'type':'manual','sequenceId':s['sequence_id'],'title':'M0 Call in Nooks'},
                {'_id':s['continuation_step_id'],'index':1,'type':'manual','sequenceId':s['sequence_id'],'title':'M0 Continuation confirmed'}]}}
        elif p=='/api/v2/tasks':
            rows=[task]
            if self.done and 'taskId' not in parse_qs(request.url.query.decode()):
                rows.append(dict(task,_id='opp_continuation',title='M0 Continuation confirmed',status='due'))
            value={'total':len(rows),'results':rows}
        elif p=='/api/activities':
            value=[] if not self.done else [{'_id':'act_new','type':'manualDone',
                'campaignId':s['campaign_id'],'leadId':s['lead_id'],'contactId':s['contact_id'],
                'opportunityId':s['task_id'],'stepId':s['call_step_id'],'sequenceId':s['sequence_id'],
                'createdAt':datetime.datetime.fromtimestamp(self.now,datetime.timezone.utc).isoformat()}]
        else:self.fail('unexpected provider path')
        return httpx.Response(200,json=value)

    def bridge(self,approval=None):
        from cloud.sdr.lemlist_provider import Provider
        key=self.store.identity()
        provider=Provider('dummy',self.scope,allow_write=approval is not None,
            transport=httpx.MockTransport(self.http),clock=lambda:self.now)
        claim=PrivateClaim(self.root/'private',self.scope,clock=lambda:self.now,retarget_plan=self.plan)
        app=private_app(signing_key='dummy-signing',public_key=key.public_key().public_bytes_raw().hex(),
            scope=self.store.scope,clock=lambda:self.now,lemlist_provider=provider,
            private_claim=claim,approval=approval,disposition_policy=self.policy)
        return Broker('http://nooks-verifier.railway.internal:8080',key,
            transport=httpx.ASGITransport(app=app),clock=lambda:self.now)

    def post(self,event=None,tamper=False):
        raw=json.dumps(event or self.webhook).encode();stamp=str(self.now*1000)
        signature=base64.b64encode(hmac.new(b'dummy-signing',stamp.encode()+b'.'+raw,hashlib.sha256).digest()).decode()
        client=TestClient(create_app(self.store,self.bridge(),clock=lambda:self.now))
        return client.post('/api/sdr/webhooks/nooks',content=raw+(b' ' if tamper else b''),
                           headers={'x-webhook-signature':'t='+stamp+',s='+signature})

    def approval(self):
        with self.store.db() as db:digest,event=db.execute('SELECT digest,evidence FROM events').fetchone()
        event=json.loads(event)
        return dict(call_id=event['call_id'],rep_id=event['rep_id'],disposition_id=event['disposition_id'],
            event_digest=digest,policy_digest=self.policy.digest,confirmed_contact=True,
            confirmed_non_suppressing_disposition=True)

    def test_signed_existing_call_captured_before_new_arm_completes_only_new_task_once(self):
        self.migrate()
        self.assertEqual(self.post().json(),{'status':'captured'})
        worker=Worker(self.store,self.scope,self.bridge(),clock=lambda:self.now,policy=self.policy,report=lambda _:None)
        self.assertEqual(worker.tick()['state'],'armed')
        with self.store.db() as db:
            self.assertEqual(db.execute('SELECT armed_at FROM completion').fetchone()[0],self.now)
            archived=json.loads(db.execute('SELECT old_state FROM retarget_history').fetchone()[0])
        self.assertEqual(json.loads(archived['completion']['scope']),self.old)
        self.assertEqual(archived['completion']['armed_at'],self.now-200)
        approval=self.approval()
        worker=Worker(self.store,self.scope,self.bridge(approval),clock=lambda:self.now,
            policy=self.policy,approval=approval,report=lambda _:None)
        self.assertEqual(worker.tick()['state'],'verified')
        self.assertEqual(self.post().json(),{'status':'duplicate'})
        self.migrate()  # Same plan on restart must preserve the committed claim.
        worker=Worker(self.store,self.scope,self.bridge(approval),clock=lambda:self.now,
            policy=self.policy,approval=approval,report=lambda _:None)
        self.assertEqual(worker.tick()['state'],'verified')
        self.assertEqual(self.writes,[{'id':'opp_new','done':True}])
        with self.private.db() as db:
            old=json.loads(db.execute('SELECT old_state FROM retarget_history').fetchone()[0])
            self.assertIsNotNone(db.execute('SELECT claimed_at FROM write_claim').fetchone()[0])
        self.assertEqual(json.loads(old['write_claim']['scope']),self.old)
        self.assertIsNone(old['write_claim']['claimed_at'])

    def test_new_call_after_arm_can_complete_retargeted_task_once(self):
        self.migrate()
        worker=Worker(self.store,self.scope,self.bridge(),clock=lambda:self.now,
            policy=self.policy,report=lambda _:None)
        self.assertEqual(worker.tick()['state'],'armed')
        self.now+=40
        iso=lambda n:datetime.datetime.fromtimestamp(n,datetime.timezone.utc).isoformat()
        self.webhook['callData']['callId']='new-call-after-arm'
        self.webhook['callData']['startedAt']=iso(self.now-30)
        self.webhook['occurredAt']=iso(self.now)
        self.assertEqual(self.post().json(),{'status':'captured'})
        self.assertEqual(self.writes,[])
        approval=self.approval()
        worker=Worker(self.store,self.scope,self.bridge(approval),clock=lambda:self.now,
            policy=self.policy,approval=approval,report=lambda _:None)
        self.assertEqual(worker.tick()['state'],'verified')
        self.assertEqual(self.post().json(),{'status':'duplicate'})
        self.migrate()
        worker=Worker(self.store,self.scope,self.bridge(approval),clock=lambda:self.now,
            policy=self.policy,approval=approval,report=lambda _:None)
        self.assertEqual(worker.tick()['state'],'verified')
        self.assertEqual(self.writes,[{'id':'opp_new','done':True}])

    def test_new_plan_cannot_reset_or_remove_existing_retarget(self):
        self.migrate()
        bad=dict(self.plan,call_id='different-call')
        for plan in (bad,None):
            with self.subTest(plan=plan),self.assertRaises(ValueError):
                Store(self.root/'public',self.capture_scope(self.scope),clock=lambda:self.now,retarget_plan=plan)
            with self.assertRaises(ValueError):
                PrivateClaim(self.root/'private',self.scope,clock=lambda:self.now,retarget_plan=plan)

    def test_retarget_cannot_extend_window_or_change_owner_or_campaign(self):
        from cloud.sdr.retarget import validate_plan
        for change in ({'expires_at':self.scope['expires_at']+1},{'starts_at':self.scope['starts_at']+1},
                       {'campaign_id':'cam_other'},{'assigned_rep_id':'usr_other'},
                       {'task_id':self.old['task_id']}):
            with self.subTest(change=change),self.assertRaises(ValueError):
                validate_plan(dict(self.plan,to_scope=dict(self.scope,**change)))

    def test_captured_or_claimed_original_test_is_preserved_and_cannot_migrate(self):
        for field,value in (('state','claimed'),('claimed_at',self.now),('write_receipt',0),
                            ('approval','{}'),('policy','{}')):
            with self.subTest(field=field):
                with self.store.db() as db:db.execute('UPDATE completion SET '+field+'=?',(value,))
                with self.assertRaises(ValueError):
                    Store(self.root/'public',self.capture_scope(self.scope),clock=lambda:self.now,retarget_plan=self.plan)
                with self.store.db() as db:
                    self.assertEqual(json.loads(db.execute('SELECT value FROM scope').fetchone()[0]),self.capture_scope(self.old))
                    db.execute('UPDATE completion SET '+field+'=?',('armed' if field=='state' else None,))
        event=dict(workspace_id='workspace',prospect_id='123',call_id='old-call',rep_id='rep',
            disposition_id='disp',disposition_name='Connected',started_at=self.now-1,finalized_at=self.now)
        self.store.capture(event,self.now)
        with self.assertRaises(ValueError):self.migrate()
        self.assertEqual(self.store.summary()['event_count'],1)

    def test_private_claim_cannot_be_retargeted_and_remains_committed(self):
        approval=dict(call_id='old-call',event_digest='a'*64,policy_digest='b'*64,rep_id='rep',
            disposition_id='disp',confirmed_contact=True,confirmed_non_suppressing_disposition=True)
        self.assertTrue(self.private.claim(approval))
        with self.assertRaises(ValueError):self.migrate()
        self.assertFalse(self.private.claim(approval))
        with self.private.db() as db:
            self.assertEqual(json.loads(db.execute('SELECT scope FROM write_claim').fetchone()[0]),self.old)

    def test_archive_and_scope_change_roll_back_together_on_failure(self):
        with self.store.db() as db:
            db.execute("CREATE TRIGGER refuse_retirement BEFORE DELETE ON completion BEGIN SELECT RAISE(ABORT,'blocked'); END")
        with self.assertRaises(Exception):
            Store(self.root/'public',self.capture_scope(self.scope),clock=lambda:self.now,retarget_plan=self.plan)
        with self.store.db() as db:
            self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='retarget_history'").fetchone())
            self.assertEqual(json.loads(db.execute('SELECT value FROM scope').fetchone()[0]),self.capture_scope(self.old))
            self.assertEqual(db.execute('SELECT state FROM completion').fetchone()[0],'armed')

    def test_invalid_signature_and_unapproved_prior_call_never_complete(self):
        import asyncio
        self.migrate()
        worker=Worker(self.store,self.scope,self.bridge(),clock=lambda:self.now,policy=self.policy,report=lambda _:None)
        self.assertEqual(worker.tick()['state'],'armed')
        self.assertEqual(self.post(tamper=True).status_code,503)
        self.assertEqual(self.store.summary()['event_count'],0)
        event=copy.deepcopy(self.webhook);event['callData']['callId']='unapproved-prior-call'
        self.assertEqual(self.post(event).status_code,200)
        approval=self.approval()
        worker=Worker(self.store,self.scope,self.bridge(approval),clock=lambda:self.now,
            policy=self.policy,approval=approval,report=lambda _:None)
        self.assertEqual(worker.tick()['state'],'armed')
        with self.private.db() as db:self.assertIsNone(db.execute('SELECT claimed_at FROM write_claim').fetchone()[0])
        # A different exact approval cannot reach the private write claim.
        wrong=dict(approval,call_id='another-call')
        with self.assertRaises(ValueError):
            asyncio.run(self.bridge(approval).call('/v1/lemlist/complete',json.dumps(wrong).encode()))
        self.assertEqual(self.writes,[])

    def test_changed_provider_state_prevents_arming_even_with_signed_existing_call(self):
        self.migrate();self.assertEqual(self.post().status_code,200);self.paused=True
        worker=Worker(self.store,self.scope,self.bridge(),clock=lambda:self.now,report=lambda _:None)
        self.assertEqual(worker.tick()['state'],'not_armed')
        self.assertEqual(self.writes,[])

    def test_expired_test_cannot_be_retargeted(self):
        self.now=self.old['expires_at']+1
        with self.assertRaises(ValueError):self.migrate()
        with self.store.db() as db:
            self.assertEqual(json.loads(db.execute('SELECT value FROM scope').fetchone()[0]),self.capture_scope(self.old))

    def test_retired_receiver_objects_cannot_capture_or_rearm(self):
        retired=self.store
        self.migrate()
        event=dict(workspace_id='workspace',prospect_id='123',call_id='old-call',rep_id='rep',
            disposition_id='disp',disposition_name='Connected',started_at=self.now-1,finalized_at=self.now)
        with self.assertRaises(ValueError):retired.capture(event,self.now)
        with self.assertRaises(ValueError):self.original.arm(lambda *_:self.evidence(self.old))
        self.assertEqual(self.store.summary()['event_count'],0)

    def test_receiver_lock_is_exclusive_before_journal_migration(self):
        import os
        from cloud.sdr.receiver import owner_lock
        lock=owner_lock(self.root/'public')
        try:
            with self.assertRaises(BlockingIOError):owner_lock(self.root/'public')
            with self.store.db() as db:
                self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='retarget_history'").fetchone())
        finally:os.close(lock)

    def test_incoherent_runtime_config_releases_owner_without_migrating(self):
        import os
        from unittest.mock import patch
        from cloud.sdr import receiver
        lock=os.open(self.root/'test-lock',os.O_RDWR|os.O_CREAT,0o600)
        env={'RAILWAY_VOLUME_MOUNT_PATH':'/data','TEST_RETARGET':json.dumps(self.plan),
             'LEMLIST_TEST_SCOPE':json.dumps(self.old),'CAPTURE_SCOPE':json.dumps(self.capture_scope(self.scope))}
        with patch.dict(os.environ,env,clear=True),patch.object(receiver,'owner_lock',return_value=lock),patch.object(receiver,'Store') as constructor:
            with self.assertRaises(ValueError):receiver.from_environment()
            constructor.assert_not_called()
        with self.assertRaises(OSError):os.fstat(lock)
