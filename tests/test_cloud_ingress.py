"""Permanent ingress keeps legacy action scope closed and receipt durable."""
import copy
import sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_cloud_sdr import CloudTests
from cloud.sdr import receiver, verifier
from cloud.sdr.inbox import Inbox
import httpx
from fastapi.testclient import TestClient


class PermanentTests(CloudTests):
    def production(self):
        private = verifier.create_app(signing_key='dummy-nooks-key',
            public_key=self.key.public_key().public_bytes_raw().hex(), scope=self.scope,
            clock=lambda:self.now, permanent=True)
        broker = receiver.Broker('http://nooks-verifier.railway.internal:8080', self.key,
            transport=httpx.ASGITransport(app=private), clock=lambda:self.now)
        return TestClient(receiver.create_app(self.store, broker, permanent=True, clock=lambda:self.now))

    def test_permanent_expired_scope_multiple_contacts_and_restart(self):
        self.now += 10000
        client = self.production()
        self.assertEqual(client.get('/ready').status_code, 200)
        first = copy.deepcopy(self.event)
        first['callData']['prospectData'] = {'prospectId':'999','email':'test@example.test'}
        self.assertEqual(self.post(first, client=client).json()['status'], 'captured')
        first['eventId'] = 'different-delivery'
        self.assertEqual(self.post(first, client=client).json()['status'], 'duplicate')
        second = copy.deepcopy(first)
        second['callData']['callId'] = 'second'
        self.assertEqual(self.post(second, client=client).json()['status'], 'captured')
        reopened = receiver.Store(self.directory,self.scope,clock=lambda:self.now)
        self.assertEqual(Inbox(reopened).summary()['pending_events'],2)
        self.assertEqual(reopened.summary()['event_count'],0)
        self.assertEqual(self.client.get('/ready').json()['verifier_ready'],False)

    def test_permanent_invalid_signature_workspace_and_storage_failure(self):
        client = self.production()
        raw, headers = self.signed()
        self.assertEqual(client.post('/api/sdr/webhooks/nooks',content=raw).status_code,401)
        self.assertEqual(client.post('/api/sdr/webhooks/nooks',content=raw+b' ',headers=headers).status_code,403)
        other=copy.deepcopy(self.event)
        other['callData']['workspaceId']='other'
        self.assertEqual(self.post(other,client=client).status_code,403)
        with patch.object(Inbox,'capture',side_effect=OSError('disk full')):
            self.assertEqual(self.post(client=client).status_code,503)
        self.assertEqual(Inbox(self.store).summary()['pending_events'],0)

    def test_permanent_revision_is_preserved_and_verifier_outage_retries(self):
        client=self.production()
        self.assertEqual(self.post(client=client).status_code,200)
        changed=copy.deepcopy(self.event)
        changed['callData']['disposition']['name']='Meeting Booked'
        self.assertEqual(self.post(changed,client=client).status_code,200)
        self.assertEqual(Inbox(self.store).summary()['pending_events'],2)
        with patch.object(receiver.Broker,'call',side_effect=TimeoutError):
            self.assertEqual(self.post(client=client).status_code,503)
            self.assertEqual(client.get('/ready').status_code,503)

    def test_forwarding_failure_retries_durable_event_and_success_marks_delivered(self):
        import asyncio
        from cloud.sdr.inbox import Forwarder
        client=self.production()
        self.post(client=client)
        inbox=Inbox(self.store)
        responses=[503,200]
        requests=[]
        def respond(request):
            requests.append(request)
            return httpx.Response(responses.pop(0),json={'status':'processed'})
        worker=Forwarder(inbox,'https://backend.example.test/internal/nooks/deals','dummy-token',transport=httpx.MockTransport(respond))
        asyncio.run(worker.tick(self.now))
        self.assertEqual(inbox.summary()['pending_events'],1)
        asyncio.run(worker.tick(self.now+1))
        self.assertEqual(len(requests),1)
        asyncio.run(worker.tick(self.now+5))
        self.assertEqual(inbox.summary()['pending_events'],0)
        self.assertEqual(requests[0].headers['authorization'],'Bearer dummy-token')
