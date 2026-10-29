"""Two actual signed webhook routes, separate durable claims, mocked lemlist."""
import asyncio
import base64
import copy
import datetime
import hashlib
import hmac
import json
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from cloud.sdr import verifier
from cloud.sdr.completion import Completion
from cloud.sdr.dispositions import DispositionPolicy
from cloud.sdr.lemlist_provider import Provider
from cloud.sdr.receiver import Broker, Store, create_app
from cloud.sdr.secondary import configured, open_secondary
from cloud.sdr.worker import Worker
import test_cloud_dispositions as fixtures


class DualContactTests(unittest.TestCase):
    def setUp(self):
        self.primary=fixtures.RetargetTests();self.primary.setUp();self.addCleanup(self.primary.doCleanups)
        self.other=fixtures.RetargetTests();self.other.setUp();self.addCleanup(self.other.doCleanups)
        f=self.primary;f.migrate()
        self.other.scope=f.old
        self.old_store=open_secondary(f.store,f.old,'receiver')
        self.old_claim=open_secondary(f.private,f.old,'verifier')
        self.old_policy=DispositionPolicy(dict(f.policy.value,dispositions={'disp_connected':'complete','dnc':'suppress'}),f.old)
        self.logs=[]
        self.approvals=[None,None]
        self.build()
        self.assertEqual(self.workers[0].tick()['state'],'armed')
        f.now+=40;self.other.now=f.now

    def build(self):
        f=self.primary
        key=f.store.identity()
        env={'CAPTURE_SCOPE':json.dumps(f.store.scope),'TEST_RETARGET':json.dumps(f.plan),
             'SECONDARY_TEST_SCOPE':json.dumps(f.old),'NOOKS_SIGNING_KEY':'dummy-signing',
             'LEMLIST_API':'dummy','RECEIVER_PUBLIC_KEY':key.public_key().public_bytes_raw().hex(),
             'SECONDARY_NOOKS_DISPOSITION_POLICY':self.old_policy.encoded}
        if self.approvals[1]:env['SECONDARY_COMPLETION_APPROVAL']=json.dumps(self.approvals[1])
        def provider(scope,write):
            actor=f if scope==f.scope else self.other
            return Provider('dummy',scope,allow_write=write,transport=httpx.MockTransport(actor.http),clock=lambda:f.now)
        primary_provider=provider(f.scope,self.approvals[0] is not None)
        real_create=verifier.create_app
        with patch.dict('os.environ',env,clear=True),patch.object(verifier,'configured',return_value=(primary_provider,self.approvals[0],f.private,f.policy)),patch('cloud.sdr.lemlist_provider.Provider',side_effect=lambda key,scope,allow_write:provider(scope,allow_write)),patch.object(verifier,'create_app',side_effect=lambda **kwargs:real_create(clock=lambda:f.now,**kwargs)):
            private=verifier.from_environment()
        self.brokers=[Broker('http://nooks-verifier.railway.internal:8080',key,clock=lambda:f.now,
            transport=httpx.ASGITransport(app=private),contact_id=cid) for cid in (None,f.old['hubspot_contact_id'])]
        self.workers=[Worker(store,scope,broker,clock=lambda:f.now,policy=policy,approval=approval,report=self.logs.append)
            for store,scope,broker,policy,approval in zip((f.store,self.old_store),(f.scope,f.old),self.brokers,(f.policy,self.old_policy),self.approvals)]
        self.app=create_app(f.store,self.brokers[0],worker=self.workers[0],clock=lambda:f.now,
            secondary=(self.old_store,self.brokers[1],self.workers[1]))

    def event(self,index):
        f=self.primary;scope=(f.scope,f.old)[index]
        event=copy.deepcopy(f.webhook)
        iso=lambda n:datetime.datetime.fromtimestamp(n,datetime.timezone.utc).isoformat()
        event['callData'].update(callId='new-call-'+str(index),startedAt=iso(f.now-30))
        event['callData']['prospectData']['prospectId']=scope['hubspot_contact_id']
        event['occurredAt']=iso(f.now)
        return event

    def post(self,event,tamper=False):
        raw=json.dumps(event).encode();stamp=str(self.primary.now*1000)
        sig=base64.b64encode(hmac.new(b'dummy-signing',stamp.encode()+b'.'+raw,hashlib.sha256).digest()).decode()
        return TestClient(self.app).post('/api/sdr/webhooks/nooks',content=raw+(b' ' if tamper else b''),
            headers={'x-webhook-signature':'t='+stamp+',s='+sig})

    def approve(self,index):
        store=(self.primary.store,self.old_store)[index]
        policy=(self.primary.policy,self.old_policy)[index]
        with store.db() as db:digest,event=db.execute('SELECT digest,evidence FROM events').fetchone()
        event=json.loads(event)
        self.approvals[index]=dict(call_id=event['call_id'],event_digest=digest,policy_digest=policy.digest,
            rep_id=event['rep_id'],disposition_id=event['disposition_id'],confirmed_contact=True,
            confirmed_non_suppressing_disposition=True)

    def test_either_contact_routes_to_its_own_task_and_both_continue_once(self):
        for index in (1,0):
            self.assertEqual(self.post(self.event(index)).json(),{'status':'captured'})
        self.assertEqual(self.primary.writes+self.other.writes,[])
        self.approve(0);self.build()
        self.assertEqual(self.workers[0].tick()['state'],'verified')
        self.assertEqual(self.primary.writes,[{'id':'opp_new','done':True}])
        self.assertEqual(self.other.writes,[])
        self.approve(1);self.build()
        self.assertEqual(self.workers[1].tick()['state'],'verified')
        self.assertEqual(self.other.writes,[{'id':'opp_old','done':True}])
        for i in (0,1):self.assertEqual(self.post(self.event(i)).json(),{'status':'duplicate'})
        self.old_store=open_secondary(self.primary.store,self.primary.old,'receiver')
        self.old_claim=open_secondary(self.primary.private,self.primary.old,'verifier')
        self.build()
        self.assertEqual([w.tick()['state'] for w in self.workers],['verified','verified'])
        self.assertEqual(len(self.primary.writes)+len(self.other.writes),2)
        with self.old_store.db() as db:self.assertEqual(db.execute('SELECT armed_at FROM completion').fetchone()[0],1793204800)
        self.assertEqual({x['test_contact_id'] for x in self.logs},{'123','456'})

    def test_forged_or_unrelated_contact_never_enters_either_inbox(self):
        for index in (0,1):self.assertEqual(self.post(self.event(index),tamper=True).status_code,503)
        unrelated=self.event(0);unrelated['callData']['prospectData']['prospectId']='999'
        self.assertEqual(self.post(unrelated).status_code,503)
        self.assertEqual([s.summary()['event_count'] for s in (self.primary.store,self.old_store)],[0,0])
        self.assertEqual(self.primary.writes+self.other.writes,[])

    def test_approval_for_one_contact_cannot_claim_the_other_task(self):
        for i in (0,1):self.assertEqual(self.post(self.event(i)).status_code,200);self.approve(i)
        self.build()
        with self.assertRaises(ValueError):
            asyncio.run(self.brokers[1].call('/v1/lemlist/complete',json.dumps(self.approvals[0]).encode()))
        with self.old_claim.db() as db:self.assertIsNone(db.execute('SELECT claimed_at FROM write_claim').fetchone()[0])
        self.assertEqual(self.primary.writes+self.other.writes,[])

    def test_suppression_or_conflict_on_one_contact_does_not_release_or_block_other(self):
        event=self.event(1);event['callData']['disposition']={'id':'dnc','name':'Connected'}
        self.assertEqual(self.post(event).status_code,200)
        self.assertEqual(self.workers[1].tick()['state'],'held')
        self.assertEqual(self.post(self.event(0)).status_code,200);self.approve(0);self.build()
        self.assertEqual(self.workers[0].tick()['state'],'verified')
        self.assertEqual(self.other.writes,[])

    def test_secondary_config_cannot_choose_third_contact_or_renew_expiry(self):
        f=self.primary
        for scope in (dict(f.old,hubspot_contact_id='999'),dict(f.old,expires_at=f.old['expires_at']+1),f.scope):
            with self.assertRaises(ValueError):configured({'SECONDARY_TEST_SCOPE':json.dumps(scope)},f.plan,f.scope)
        with self.assertRaises(ValueError):configured({'SECONDARY_COMPLETION_APPROVAL':'{}'},f.plan,f.scope)
        self.assertEqual(configured({'SECONDARY_TEST_SCOPE':json.dumps(f.old)},f.plan,f.scope),f.old)

    def test_secondary_origin_and_committed_claim_survive_restart_without_reset(self):
        self.assertEqual(self.post(self.event(1)).status_code,200);self.approve(1)
        self.assertTrue(self.old_claim.claim(self.approvals[1]))
        restarted=open_secondary(self.primary.private,self.primary.old,'verifier')
        self.assertFalse(restarted.claim(self.approvals[1]))
        with self.assertRaises(ValueError):restarted.claim(dict(self.approvals[1],call_id='replacement'))
        with self.old_store.db() as db:db.execute("UPDATE secondary_origin SET digest='wrong'")
        with self.assertRaises(ValueError):open_secondary(self.primary.store,self.primary.old,'receiver')
        self.assertEqual(self.primary.writes+self.other.writes,[])

    def test_readiness_and_background_lifecycle_include_both_contacts(self):
        with TestClient(self.app) as client:
            ready=client.get('/ready').json()
            self.assertTrue(ready['verifier_ready']);self.assertTrue(ready['secondary']['verifier_ready'])
            self.assertEqual(ready['secondary']['completion_state'],'armed')
        self.assertEqual({x['test_contact_id'] for x in self.logs},{'123','456'})

    def test_receiver_runtime_factory_builds_both_signed_routes_on_existing_volume(self):
        import os
        from cloud.sdr import receiver
        f=self.primary
        env={'RAILWAY_VOLUME_MOUNT_PATH':'/data','TEST_RETARGET':json.dumps(f.plan),
             'CAPTURE_SCOPE':json.dumps(f.store.scope),'LEMLIST_TEST_SCOPE':json.dumps(f.scope),
             'SECONDARY_TEST_SCOPE':json.dumps(f.old),'VERIFIER_URL':'http://nooks-verifier.railway.internal:8080',
             'NOOKS_DISPOSITION_POLICY':f.policy.encoded,'SECONDARY_NOOKS_DISPOSITION_POLICY':self.old_policy.encoded}
        lock=os.open(f.root/'runtime-lock',os.O_RDWR|os.O_CREAT,0o600)
        self.addCleanup(os.close,lock)
        real_store,real_broker,real_worker=Store,Broker,Worker
        def make_store(directory,*args,**kwargs):
            return f.store if str(directory)=='/data/state' else real_store(directory,*args,**kwargs)
        def make_broker(url,key,**kwargs):
            return real_broker(url,key,transport=self.brokers[0].transport,clock=lambda:f.now,**kwargs)
        with patch.dict('os.environ',env,clear=True),patch.object(receiver,'owner_lock',return_value=lock),patch.object(receiver,'Store',side_effect=make_store),patch.object(receiver,'Broker',side_effect=make_broker),patch('cloud.sdr.worker.Worker',side_effect=lambda *args,**kwargs:real_worker(*args,clock=lambda:f.now,**kwargs)),patch.object(receiver,'create_app',side_effect=lambda *args,**kwargs:create_app(*args,clock=lambda:f.now,**kwargs)):
            self.app=receiver.from_environment()
        for index in (1,0):self.assertEqual(self.post(self.event(index)).json(),{'status':'captured'})
        self.assertEqual(self.primary.writes+self.other.writes,[])

    def test_second_contact_keeps_original_expiry(self):
        self.assertEqual(self.post(self.event(1)).status_code,200);self.approve(1);self.build()
        self.primary.now=self.primary.old['expires_at']+1
        with self.assertRaises(ValueError):
            asyncio.run(self.brokers[1].call('/v1/lemlist/complete',json.dumps(self.approvals[1]).encode()))
        self.assertEqual(self.other.writes,[])
        with self.old_claim.db() as db:self.assertIsNone(db.execute('SELECT claimed_at FROM write_claim').fetchone()[0])
