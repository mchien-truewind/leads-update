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
        self.store=Store(Path(self.tmp.name)/'signed',self.store.scope)
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
        store=Store(Path(self.tmp.name)/'unconfigured',self.store.scope)
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
