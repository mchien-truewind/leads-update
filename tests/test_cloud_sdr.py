"""Hosted capture boundary: dummy secrets, real signatures and durable SQLite."""
import base64
import copy
import datetime
import hashlib
import hmac
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cloud.sdr import common, receiver, verifier, start


class CloudTests(unittest.TestCase):
    def setUp(self):
        self.now = 1793200000
        self.scope = {'workspace_id': 'workspace', 'prospect_id': '123', 'not_before': self.now-50, 'expires_at': self.now+1000}
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)/'state'
        self.store = receiver.Store(self.directory, self.scope)
        self.key = self.store.identity()
        self.private = verifier.create_app(signing_key='dummy-nooks-key',
            public_key=self.key.public_key().public_bytes_raw().hex(), scope=self.scope, clock=lambda:self.now)
        self.broker = receiver.Broker('http://nooks-verifier.railway.internal:8080', self.key,
            transport=httpx.ASGITransport(app=self.private), clock=lambda:self.now)
        self.client = TestClient(receiver.create_app(self.store, self.broker, clock=lambda:self.now))
        iso = lambda n: datetime.datetime.fromtimestamp(n,datetime.timezone.utc).isoformat()
        self.event = {'event':'call.logged','occurredAt':iso(self.now),'callData':{
            'workspaceId':'workspace','callId':'call1','status':'completed','callDirection':'outbound',
            'prospectData':{'prospectId':'123'},'userData':{'userId':'rep1'},
            'disposition':{'id':'disp1','name':'No Answer'},'startedAt':iso(self.now-1),
            'notes':'private notes are excluded','recordingUrl':'https://example.test/private'}}

    def signed(self, event=None, *, stamp=None):
        raw = json.dumps(self.event if event is None else event).encode()
        stamp = str(self.now*1000 if stamp is None else stamp)
        sig = base64.b64encode(hmac.new(b'dummy-nooks-key',stamp.encode()+b'.'+raw,hashlib.sha256).digest()).decode()
        return raw, {'x-webhook-signature':'t='+stamp+',s='+sig}

    def post(self, event=None, client=None):
        raw, headers = self.signed(event)
        return (client or self.client).post('/api/sdr/webhooks/nooks',content=raw,headers=headers)

    def test_inbound_registration_sample_is_accepted_but_selected_inbound_is_not_discarded(self):
        app=receiver.create_app(self.store,self.broker,registration_id='a'*32,deadline=self.now+60,clock=lambda:self.now)
        client=TestClient(app)
        selected=copy.deepcopy(self.event)
        selected['callData']['callDirection']='inbound'
        with patch('builtins.print'):
            self.assertEqual(self.post(selected,client=client).status_code,503)
            self.assertTrue(client.get('/ready').json()['registration_open'])
            sample=copy.deepcopy(selected)
            sample['callData']['prospectData']['prospectId']='external-test-prospect'
            self.assertEqual(self.post(sample,client=client).status_code,204)
            self.assertFalse(client.get('/ready').json()['registration_open'])
            self.assertEqual(self.post(sample,client=client).status_code,503)
        self.assertEqual(self.store.summary()['event_count'],0)

    def test_registration_diagnostics_are_fixed_bounded_and_exclude_private_payload(self):
        app=receiver.create_app(self.store,self.broker,registration_id='b'*32,deadline=self.now+60,clock=lambda:self.now)
        client=TestClient(app)
        sample=copy.deepcopy(self.event)
        sample['callData']['prospectData']={'email':'private-marker@example.test'}
        with patch('builtins.print') as output:
            self.assertEqual(self.post(sample,client=client).status_code,503)
            self.assertEqual(self.post(sample,client=client).status_code,503)
            self.assertEqual(output.call_count,1)
            record=json.loads(output.call_args.args[0])
        self.assertEqual(record,{'event':'nooks_setup_rejected','reason':'missing_explicit_identity'})
        self.assertNotIn('private-marker',json.dumps(record))
        self.assertTrue(client.get('/ready').json()['registration_open'])

    def test_signed_provider_call_crosses_authenticated_broker_and_durable_capture(self):
        self.assertEqual(self.client.get('/ready').json()['verifier_ready'],True)
        self.assertEqual(self.post().json(),{'status':'captured'})
        with self.store.db() as db:
            stored = db.execute('SELECT evidence FROM events').fetchone()[0]
        for field in ('private notes','recordingUrl','dummy-nooks-key'):
            self.assertNotIn(field,stored)
        self.assertEqual(self.store.summary(),{'event_count':1,'held':False})

    def test_restart_keeps_identity_and_deduplication_without_exporting_private_key(self):
        self.post()
        new_store = receiver.Store(self.directory,self.scope)
        new_key = new_store.identity()
        self.assertEqual(new_key.public_key().public_bytes_raw(), self.key.public_key().public_bytes_raw())
        new_client = TestClient(receiver.create_app(new_store,self.broker,clock=lambda:self.now))
        self.assertEqual(self.post(client=new_client).json(),{'status':'duplicate'})
        self.assertEqual(new_client.get('/identity').json(),{'algorithm':'Ed25519','public_key':self.key.public_key().public_bytes_raw().hex()})

    def test_commit_before_lost_ack_is_reconciled_by_duplicate_delivery(self):
        original = self.store.capture
        def lost(event, now):
            original(event, now)
            raise OSError('lost response')
        with patch.object(self.store,'capture',lost): self.assertEqual(self.post().status_code,503)
        self.assertEqual(self.post().json(),{'status':'duplicate'})
        self.assertEqual(self.store.summary()['event_count'],1)

    def test_conflicting_call_replay_and_second_call_hold_without_overwrite(self):
        self.post()
        changed = copy.deepcopy(self.event)
        changed['callData']['disposition'] = {'id':'dnc','name':'Do Not Call'}
        self.assertEqual(self.post(changed).json(),{'status':'held_conflicting_replay'})
        changed['callData']['callId'] = 'call2'
        self.assertEqual(self.post(changed).json(),{'status':'held_multiple_calls'})
        self.assertTrue(self.store.summary()['held'])

    def test_unsigned_tampered_wrong_prospect_and_stale_events_never_commit(self):
        raw, headers = self.signed()
        self.assertEqual(self.client.post('/api/sdr/webhooks/nooks',content=raw).status_code,503)
        self.assertEqual(self.client.post('/api/sdr/webhooks/nooks',content=raw+b' ',headers=headers).status_code,503)
        changed = copy.deepcopy(self.event); changed['callData']['prospectData']['prospectId']='999'
        self.assertEqual(self.post(changed).status_code,503)
        raw, headers = self.signed(stamp=(self.now-301)*1000)
        self.assertEqual(self.client.post('/api/sdr/webhooks/nooks',content=raw,headers=headers).status_code,503)
        self.assertEqual(self.store.summary()['event_count'],0)

    def test_unknown_app_identity_and_missing_provider_key_hold(self):
        for key, signing in ((Ed25519PrivateKey.generate(), 'dummy-nooks-key'),(self.key,'')):
            app=verifier.create_app(signing_key=signing,public_key=self.key.public_key().public_bytes_raw().hex(),scope=self.scope,clock=lambda:self.now)
            broker=receiver.Broker('http://nooks-verifier.railway.internal:8080',key,transport=httpx.ASGITransport(app=app),clock=lambda:self.now)
            client=TestClient(receiver.create_app(self.store,broker,clock=lambda:self.now))
            self.assertFalse(client.get('/ready').json()['verifier_ready'])
            self.assertEqual(self.post(client=client).status_code,503)
        self.assertEqual(self.store.summary()['event_count'],0)

    def test_app_signature_covers_operation_nooks_header_and_body_and_rejects_replay(self):
        raw, nooks = self.signed()
        stamp, nonce = str(self.now), 'a'*32
        sig=self.key.sign(common.envelope('/v1/nooks/verify',stamp,nonce,raw,nooks['x-webhook-signature']))
        headers=dict(nooks,**{'x-app-time':stamp,'x-app-nonce':nonce,'x-app-signature':base64.b64encode(sig).decode()})
        private=TestClient(self.private)
        self.assertEqual(private.post('/v1/ready',content=raw,headers=headers).status_code,403)
        self.assertEqual(private.post('/v1/nooks/verify',content=raw+b' ',headers=headers).status_code,403)
        self.assertEqual(private.post('/v1/nooks/verify',content=raw,headers=dict(headers,**{'x-webhook-signature':'changed'})).status_code,403)
        self.assertEqual(private.post('/v1/nooks/verify',content=raw,headers=headers).status_code,200)
        self.assertEqual(private.post('/v1/nooks/verify',content=raw,headers=headers).status_code,403)

    def test_registration_is_one_shot_durable_and_never_captures_a_call(self):
        make=lambda: TestClient(receiver.create_app(receiver.Store(self.directory,self.scope),self.broker,
            registration_id='b'*32,deadline=self.now+60,clock=lambda:self.now))
        client=make()
        self.assertTrue(client.get('/ready').json()['registration_open'])
        self.assertEqual(client.post('/api/sdr/webhooks/nooks',json={}).status_code,204)
        restarted=make()
        self.assertFalse(restarted.get('/ready').json()['registration_open'])
        self.assertEqual(restarted.post('/api/sdr/webhooks/nooks',json={}).status_code,503)
        self.assertEqual(self.store.summary()['event_count'],0)

    def test_expired_setup_does_not_crash_on_restart_or_ack_unsigned_calls(self):
        client=TestClient(receiver.create_app(self.store,self.broker,registration_id='c'*32,
            deadline=self.now-1,clock=lambda:self.now))
        self.assertFalse(client.get('/ready').json()['registration_open'])
        self.assertEqual(client.post('/api/sdr/webhooks/nooks',json={}).status_code,503)

    def test_real_selected_call_during_registration_is_captured_not_discarded(self):
        client=TestClient(receiver.create_app(self.store,self.broker,registration_id='d'*32,
            deadline=self.now+60,clock=lambda:self.now))
        self.assertEqual(self.post(client=client).json(),{'status':'captured'})
        self.assertEqual(self.store.summary()['event_count'],1)
        self.assertTrue(client.get('/ready').json()['registration_open'])
        raw,headers=self.signed()
        self.assertEqual(client.post('/api/sdr/webhooks/nooks',content=raw+b' ',headers=headers).status_code,503)
        self.assertTrue(client.get('/ready').json()['registration_open'])

    def test_call_shaped_probe_requires_explicit_out_of_scope_identity(self):
        client=TestClient(receiver.create_app(self.store,self.broker,registration_id='e'*32,
            deadline=self.now+60,clock=lambda:self.now))
        probe=copy.deepcopy(self.event)
        del probe['callData']['prospectData']['prospectId']
        self.assertEqual(self.post(probe,client=client).status_code,503)
        probe['callData']['prospectData']['prospectId']='nooks-test-prospect'
        self.assertEqual(self.post(probe,client=client).status_code,204)
        self.assertEqual(self.store.summary()['event_count'],0)
        self.assertFalse(client.get('/ready').json()['registration_open'])

    def test_scope_change_missing_volume_and_local_cloud_launcher_fail_closed(self):
        with self.assertRaises(ValueError): receiver.Store(self.directory,dict(self.scope,prospect_id='999'))
        with patch.dict('os.environ',{},clear=True):
            with self.assertRaises(ValueError): receiver.from_environment()
            with self.assertRaises(SystemExit): start.main()

    def test_fixed_private_address_no_redirects_or_oversize_response(self):
        for url in ('https://evil.test','http://localhost:8080','http://nooks-verifier.railway.internal:8080/v1','http://nooks-verifier.railway.internal:8080?x=y'):
            with self.assertRaises(ValueError): receiver.Broker(url,self.key)
        for status,content in ((302,b''),(200,b'x'*4097)):
            broker=receiver.Broker('http://nooks-verifier.railway.internal:8080',self.key,
                transport=httpx.MockTransport(lambda r:httpx.Response(status,content=content,headers={'Location':'http://evil.test'})),clock=lambda:self.now)
            client=TestClient(receiver.create_app(self.store,broker,clock=lambda:self.now))
            self.assertEqual(self.post(client=client).status_code,503)
        self.assertEqual(self.client.post('/api/sdr/webhooks/nooks',content=b'x'*32769).status_code,413)
        self.assertEqual(self.client.get('/docs').status_code,404)


if __name__ == '__main__': unittest.main()
