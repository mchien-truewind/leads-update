"""Railway public signed ingress with durable, capture-only one-contact inbox."""
import base64
import asyncio
from contextlib import contextmanager, asynccontextmanager, suppress
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import tempfile
import time
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI, HTTPException, Request, Response
import httpx
from .common import body, envelope, header, load_scope


class Store:
    def __init__(self, directory, scope):
        self.directory, self.scope = Path(directory), scope
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('unsafe state directory')
        self.path = self.directory/'capture.sqlite3'
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise ValueError('unsafe capture database')
        finally:
            os.close(fd)
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS scope (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL, held INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS events (call_id TEXT PRIMARY KEY, digest TEXT NOT NULL, evidence TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS registration (id TEXT PRIMARY KEY, deadline INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
            ''')
            db.execute('BEGIN IMMEDIATE')
            value = json.dumps(scope, sort_keys=True)
            row = db.execute('SELECT value FROM scope WHERE singleton=1').fetchone()
            if row and row[0] != value:
                raise ValueError('scope replacement requires explicit migration')
            db.execute('INSERT OR IGNORE INTO scope(singleton,value) VALUES(1,?)', (value,))

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=2)
        db.execute('PRAGMA synchronous=FULL')
        try:
            with db:
                yield db
        finally:
            db.close()

    def identity(self):
        path = self.directory/'receiver-identity.key'
        if not path.exists():
            key = Ed25519PrivateKey.generate()
            fd, temporary = tempfile.mkstemp(dir=self.directory)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    os.fchmod(stream.fileno(), 0o600)
                    stream.write(key.private_bytes_raw())
                    stream.flush()
                    os.fsync(stream.fileno())
                try:
                    os.link(temporary, path)  # Atomic no-clobber publication.
                except FileExistsError:
                    pass
            finally:
                os.unlink(temporary)
            fd = os.open(self.directory, os.O_RDONLY)
            try: os.fsync(fd)
            finally: os.close(fd)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise ValueError('unsafe app identity')
            return Ed25519PrivateKey.from_private_bytes(stream.read(33))

    def configure_registration(self, identity, deadline, now):
        if not identity and not deadline:
            return
        if not re.fullmatch(r'[a-f0-9]{32}', identity) or not 0 < deadline <= now+3600:
            raise ValueError('registration must be explicitly armed for at most one hour')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT deadline FROM registration WHERE id=?', (identity,)).fetchone()
            if old and old[0] != deadline:
                raise ValueError('cannot renew registration identity')
            db.execute('INSERT OR IGNORE INTO registration(id,deadline) VALUES (?,?)', (identity, deadline))

    def registration(self, identity, now, consume=False):
        with self.db() as db:
            if consume: db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT deadline,consumed FROM registration WHERE id=?', (identity,)).fetchone()
            active = bool(row and not row[1] and now < row[0])
            if active and consume:
                db.execute('UPDATE registration SET consumed=1 WHERE id=?', (identity,))
            return active

    def capture(self, event, now):
        fields = {'workspace_id', 'prospect_id', 'call_id', 'rep_id', 'disposition_id', 'disposition_name', 'started_at', 'finalized_at'}
        if (not isinstance(event, dict) or set(event) != fields
                or event['workspace_id'] != self.scope['workspace_id'] or event['prospect_id'] != self.scope['prospect_id']
                or any(not isinstance(event[k], str) or not 1 <= len(event[k]) <= 200 for k in fields-{'started_at','finalized_at'})
                or any(type(event[k]) not in (int, float) for k in ('started_at','finalized_at'))
                or not self.scope['not_before'] <= event['started_at'] <= event['finalized_at'] <= now+300
                or now >= self.scope['expires_at']):
            raise ValueError('invalid verified event')
        raw = json.dumps(event, sort_keys=True, separators=(',', ':'))
        digest = hashlib.sha256(raw.encode()).hexdigest()
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT digest FROM events WHERE call_id=?', (event['call_id'],)).fetchone()
            if old:
                if old[0] == digest: return 'duplicate'
                db.execute('UPDATE scope SET held=1 WHERE singleton=1')
                return 'held_conflicting_replay'
            count = db.execute('SELECT COUNT(*) FROM events').fetchone()[0]
            if count >= 100:
                db.execute('UPDATE scope SET held=1 WHERE singleton=1')
                raise ValueError('capture capacity reached')
            db.execute('INSERT INTO events VALUES (?,?,?)', (event['call_id'], digest, raw))
            if count:
                db.execute('UPDATE scope SET held=1 WHERE singleton=1')
            return 'captured' if not count else 'held_multiple_calls'

    def summary(self):
        with self.db() as db:
            return {'event_count': db.execute('SELECT COUNT(*) FROM events').fetchone()[0],
                    'held': bool(db.execute('SELECT held FROM scope WHERE singleton=1').fetchone()[0])}


class Broker:
    def __init__(self, url, key, *, transport=None, clock=time.time):
        u = urlsplit(url)
        if (u.scheme != 'http' or not u.hostname or not re.fullmatch(r'[a-z0-9-]+\.railway\.internal', u.hostname)
                or u.port != 8080 or u.path not in ('','/') or u.query or u.fragment or u.username or u.password):
            raise ValueError('fixed private broker URL required')
        self.url, self.key, self.transport, self.clock = url.rstrip('/'), key, transport, clock

    async def call(self, path, raw=b'', nooks_signature=''):
        if path not in ('/v1/ready', '/v1/nooks/verify', '/v1/lemlist/inspect', '/v1/lemlist/complete'):
            raise ValueError('unknown broker operation')
        stamp, nonce = str(int(self.clock())), secrets.token_hex(16)
        signature = self.key.sign(envelope(path, stamp, nonce, raw, nooks_signature))
        headers = {'x-app-time': stamp, 'x-app-nonce': nonce, 'x-app-signature': base64.b64encode(signature).decode()}
        if nooks_signature: headers['x-webhook-signature'] = nooks_signature
        async def exchange():
            async with httpx.AsyncClient(transport=self.transport, timeout=55 if path.startswith('/v1/lemlist/') else 5, follow_redirects=False, trust_env=False) as client:
                async with client.stream('POST', self.url+path, content=raw, headers=headers) as response:
                    if response.status_code != 200:
                        raise ValueError('broker unavailable or rejected')
                    result = bytearray()
                    async for chunk in response.aiter_bytes():
                        result.extend(chunk)
                        if len(result) > 4096: raise ValueError('oversize broker result')
            return json.loads(result)
        return await asyncio.wait_for(exchange(), 60 if path.startswith('/v1/lemlist/') else 6)


def create_app(store, broker, *, registration_id='', deadline=0, clock=time.time, worker=None):
    store.configure_registration(registration_id, deadline, clock())
    setup_diagnostics=set()
    @asynccontextmanager
    async def lifespan(app):
        task=asyncio.create_task(worker.run()) if worker else None
        try: yield
        finally:
            if task:
                task.cancel()
                with suppress(asyncio.CancelledError): await task
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.get('/healthz')
    async def health():
        return {'ok': True, 'role': 'sdr-test' if worker else 'capture-only', 'revision': os.environ.get('RAILWAY_GIT_COMMIT_SHA', 'unknown')}

    @app.get('/identity')
    async def identity():
        return {'algorithm': 'Ed25519', 'public_key': broker.key.public_key().public_bytes_raw().hex()}

    @app.get('/ready')
    async def ready():
        try: verified = (await broker.call('/v1/ready')).get('ready') is True
        except Exception: verified = False
        return {'verifier_ready': verified, 'registration_open': store.registration(registration_id, clock()),
                'capture_only': worker is None or worker.approval is None, **store.summary(),
                'completion_state': worker.core.status()['state'] if worker else 'disabled'}

    @app.post('/api/sdr/webhooks/nooks')
    async def webhook(request: Request):
        raw = await body(request)
        try:
            signature = header(request, 'x-webhook-signature', 200)
            result = await broker.call('/v1/nooks/verify', raw, signature)
            outcome = await asyncio.to_thread(store.capture, result['event'], clock())
            return {'status': outcome}  # Only after SQLite commit succeeds.
        except Exception:
            # Nooks' initial probe is signed and can be call-shaped before the
            # signing key is issued. Only an explicit out-of-scope probe can
            # consume setup; a selected or ambiguous call must be retried.
            try:
                if store.registration(registration_id,clock()):
                    reason=registration_reason(raw,store.scope)
                    if reason in ('empty_probe','outside_scope') and store.registration(registration_id,clock(),consume=True):
                        print(json.dumps({'event':'nooks_setup_accepted'}),flush=True)
                        return Response(status_code=204)
                    if reason not in setup_diagnostics:
                        setup_diagnostics.add(reason)
                        # Fixed reason codes only: no request values, headers or errors.
                        print(json.dumps({'event':'nooks_setup_rejected','reason':reason}),flush=True)
            except Exception:
                pass
            raise HTTPException(503, 'Event unavailable or rejected.') from None

    return app


def registration_reason(raw, scope):
    from .common import unique
    try:
        data=json.loads(raw or b'{}',object_pairs_hook=unique)
    except Exception:
        return 'invalid_json'
    if data == {}: return 'empty_probe'
    if not isinstance(data,dict) or data.get('event') != 'call.logged': return 'unsupported_event'
    call=data.get('callData')
    if not isinstance(call,dict) or not isinstance(call.get('prospectData'),dict): return 'invalid_call_shape'
    workspace,prospect=call.get('workspaceId'),call['prospectData'].get('prospectId')
    if any(not isinstance(v,str) or not 1 <= len(v) <= 200 for v in (workspace,prospect)):
        return 'missing_explicit_identity'
    if (workspace,prospect)==(scope['workspace_id'],scope['prospect_id']): return 'selected_contact'
    if call.get('status')!='completed': return 'not_completed'
    # Nooks' documented setup sample is inbound. Direction is irrelevant to
    # acknowledging a probe whose explicit identity excludes the selected test.
    if call.get('callDirection') not in ('outbound','inbound'): return 'unknown_direction'
    return 'outside_scope'


def registration_probe(raw,scope):
    return registration_reason(raw,scope) in ('empty_probe','outside_scope')


def from_environment():
    if os.environ.get('RAILWAY_VOLUME_MOUNT_PATH') != '/data':
        raise ValueError('durable Railway volume required')
    store = Store('/data/state', load_scope(os.environ['CAPTURE_SCOPE']))
    lock = os.open(store.directory/'owner.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    broker = Broker(os.environ['VERIFIER_URL'], store.identity())
    worker=None
    if os.environ.get('LEMLIST_TEST_SCOPE'):
        from .common import unique
        from .worker import Worker
        from .dispositions import configured
        selected=json.loads(os.environ['LEMLIST_TEST_SCOPE'],object_pairs_hook=unique)
        approval=json.loads(os.environ['COMPLETION_APPROVAL'],object_pairs_hook=unique) if os.environ.get('COMPLETION_APPROVAL') else None
        worker=Worker(store,selected,broker,approval=approval,policy=configured(selected,os.environ))
    elif os.environ.get('COMPLETION_APPROVAL') or os.environ.get('NOOKS_DISPOSITION_POLICY'):
        raise ValueError('approval without scoped worker')
    app = create_app(store, broker, worker=worker, registration_id=os.environ.get('REGISTRATION_ID', ''),
        deadline=int(os.environ.get('REGISTRATION_DEADLINE', '0')))
    app.state.owner_lock = lock  # Single owner for the lifetime of this process.
    return app
