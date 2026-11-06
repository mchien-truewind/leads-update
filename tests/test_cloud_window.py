"""Explicit reopening expires independently of restart and never resets a claim."""
import copy
import json
import unittest

import httpx
from fastapi.testclient import TestClient
from cloud.sdr.lemlist_provider import Provider
from cloud.sdr.test_window import bind, configured
import test_cloud_dual as fixtures


class WindowTests(unittest.TestCase):
    def setUp(self):
        self.dual=fixtures.DualContactTests();self.dual.setUp();self.addCleanup(self.dual.doCleanups)
        d=self.dual;f=d.primary
        self.original_time=f.now
        self.now=f.scope['expires_at']+10
        self.grant={'scopes':[f.scope,f.old],'starts_at':self.now,'expires_at':self.now+7200,'confirmed_reopen':True}
        self.set_time(self.now)

    def set_time(self,now):
        self.dual.primary.now=self.dual.other.now=now

    def enable(self):
        d=self.dual;f=d.primary
        d.extra_env={'TEST_WINDOW_REOPEN':json.dumps(self.grant)}
        bind(f.store,f.scope,self.grant);bind(d.old_store,f.old,self.grant)
        d.build()  # Actual private runtime factory binds both private journals and providers.

    def test_reopen_both_real_signed_paths_and_complete_each_exact_task_once(self):
        d=self.dual
        self.assertEqual(d.post(d.event(0)).status_code,503)
        self.assertFalse(TestClient(d.app).get('/ready').json()['verifier_ready'])
        self.enable()
        # Actual public runtime factory binds the same grant and accepts each event.
        d.test_receiver_runtime_factory_builds_both_signed_routes_on_existing_volume()
        ready=TestClient(d.app).get('/ready').json()
        self.assertTrue(ready['verifier_ready']);self.assertTrue(ready['secondary']['verifier_ready'])
        self.assertEqual(ready['test_window_expires_at'],self.grant['expires_at'])
        self.assertEqual(ready['secondary']['test_window_expires_at'],self.grant['expires_at'])
        for i in (0,1):d.approve(i)
        d.build()
        self.assertEqual([w.tick()['state'] for w in d.workers],['verified','verified'])
        self.assertEqual(d.primary.writes,[{'id':'opp_new','done':True}])
        self.assertEqual(d.other.writes,[{'id':'opp_old','done':True}])
        for i in (0,1):self.assertEqual(d.post(d.event(i)).json(),{'status':'duplicate'})
        self.enable()
        self.assertEqual([w.tick()['state'] for w in d.workers],['verified','verified'])
        self.assertEqual(len(d.primary.writes)+len(d.other.writes),2)
        with d.old_store.db() as db:
            self.assertEqual(db.execute('SELECT armed_at FROM completion').fetchone()[0],1793204800)
            self.assertEqual(json.loads(db.execute('SELECT scope FROM completion').fetchone()[0]),d.primary.old)

    def test_expiry_blocks_capture_and_every_new_write_boundary(self):
        d=self.dual;self.enable()
        self.assertEqual(d.post(d.event(0)).status_code,200);d.approve(0);d.build()
        self.set_time(self.grant['expires_at'])
        ready=TestClient(d.app).get('/ready').json()
        self.assertFalse(ready['verifier_ready']);self.assertFalse(ready['secondary']['verifier_ready'])
        self.assertEqual(d.post(d.event(1)).status_code,503)
        self.assertEqual(d.workers[0].tick()['state'],'armed')
        with self.assertRaises(ValueError):d.primary.private.claim(d.approvals[0])
        provider=Provider('dummy',d.primary.scope,allow_write=True,transport=httpx.MockTransport(d.primary.http),
            clock=lambda:d.primary.now,window=d.primary.store.window)
        with self.assertRaises(ValueError):provider.run('complete')
        self.assertEqual(d.primary.writes+d.other.writes,[])

    def test_expiry_between_provider_preflight_and_patch_never_writes(self):
        d=self.dual;self.enable()
        def transport(request):
            result=d.primary.http(request)
            if request.url.path=='/api/activities':self.set_time(self.grant['expires_at'])
            return result
        provider=Provider('dummy',d.primary.scope,allow_write=True,transport=httpx.MockTransport(transport),
            clock=lambda:d.primary.now,window=d.primary.store.window)
        with self.assertRaises(ValueError):provider.run('complete')
        self.assertEqual(d.primary.writes,[])

    def test_restart_cannot_renew_or_replace_window_and_removal_closes_access(self):
        d=self.dual;f=d.primary;self.enable()
        shifted=copy.deepcopy(self.grant);shifted['starts_at']+=10;shifted['expires_at']+=10
        for owner,scope in ((f.store,f.scope),(f.private,f.scope),(d.old_store,f.old),(d.old_claim,f.old)):
            # The fixture's old_claim is an independent object on the same durable journal.
            with self.assertRaises(ValueError):bind(owner,scope,shifted)
            bind(owner,scope,None)
            self.assertIsNone(owner.window)
            bind(owner,scope,self.grant)
            self.assertEqual(owner.window.expires_at,self.grant['expires_at'])
        self.set_time(self.grant['expires_at']+100)
        self.enable()  # Expired matching configuration can restart for read-only reconciliation.
        self.assertFalse(TestClient(d.app).get('/ready').json()['verifier_ready'])
        self.assertEqual(d.primary.writes+d.other.writes,[])

    def test_old_private_claim_remains_claimed_after_reopening(self):
        d=self.dual;self.set_time(self.original_time)
        self.assertEqual(d.post(d.event(0)).status_code,200);d.approve(0)
        self.assertTrue(d.primary.private.claim(d.approvals[0]))  # Crash before dispatch.
        self.set_time(self.now);self.enable()
        self.assertEqual(d.workers[0].tick()['state'],'held')
        self.assertFalse(d.primary.private.claim(d.approvals[0]))
        self.assertEqual(d.primary.writes,[])

    def test_invalid_duration_confirmation_or_scope_cannot_bind(self):
        f=self.dual.primary
        bad=[]
        value=copy.deepcopy(self.grant);value['expires_at']+=1;bad.append(value)
        value=copy.deepcopy(self.grant);value['confirmed_reopen']=False;bad.append(value)
        value=copy.deepcopy(self.grant);value['scopes'][1]['task_id']='opp_other';bad.append(value)
        value=copy.deepcopy(self.grant);value['scopes'].reverse();bad.append(value)
        for value in bad:
            with self.subTest(value=value),self.assertRaises(ValueError):
                configured({'TEST_WINDOW_REOPEN':json.dumps(value)},f.scope,f.old)
        with self.assertRaises(ValueError):configured({'TEST_WINDOW_REOPEN':json.dumps(self.grant)},f.scope,None)
        with f.store.db() as db:self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='test_window_reopen'").fetchone())

    def test_expired_window_cannot_first_install_or_auto_roll_forward(self):
        f=self.dual.primary
        self.set_time(self.grant['expires_at']+1)
        with self.assertRaises(ValueError):bind(f.store,f.scope,self.grant)
        self.set_time(self.now);self.enable()
        before=copy.deepcopy(self.grant)
        self.set_time(self.now+3600);self.enable()
        with f.store.db() as db:self.assertEqual(json.loads(db.execute('SELECT value FROM test_window_reopen').fetchone()[0]),before)

    def test_capture_waiting_for_database_lock_rechecks_expiry_before_commit(self):
        import concurrent.futures
        from contextlib import contextmanager
        import threading
        from unittest.mock import patch
        d=self.dual;store=d.primary.store
        for reopened in (False,True):
            with self.subTest(reopened=reopened):
                if reopened:self.set_time(self.now);self.enable()
                deadline=self.grant['expires_at'] if reopened else d.primary.scope['expires_at']
                self.set_time(deadline-1)
                event=dict(workspace_id='workspace',prospect_id='456',call_id='delayed-call',rep_id='nooksrep',
                    disposition_id='disp_connected',disposition_name='Connected',started_at=d.primary.now-1,finalized_at=d.primary.now)
                original_db=store.db;waiting=threading.Event()
                @contextmanager
                def traced_db():
                    with original_db() as db:
                        db.set_trace_callback(lambda statement:waiting.set() if statement=='BEGIN IMMEDIATE' else None)
                        yield db
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    with original_db() as lock:
                        lock.execute('BEGIN IMMEDIATE')
                        with patch.object(store,'db',traced_db):
                            future=pool.submit(store.capture,event,d.primary.now)
                            self.assertTrue(waiting.wait(1))
                            self.set_time(deadline)
                    with self.assertRaises(ValueError):future.result(timeout=2)
                self.assertEqual(store.summary()['event_count'],0)
