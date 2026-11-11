"""Permanent receipt journal. Acknowledgement follows a durable commit.

Call identity is stable across provider retries; revisions remain separately
replayable without overwriting history or running legacy test task actions.
"""
import hashlib
import json


class Inbox:
    def __init__(self, store):
        self.store = store
        with store.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS ingress_events (
                    id INTEGER PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    call_id TEXT NOT NULL,
                    digest TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    received_at REAL NOT NULL,
                    state TEXT NOT NULL DEFAULT 'pending',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    next_attempt_at REAL NOT NULL DEFAULT 0,
                    UNIQUE(workspace_id, call_id, digest)
                );
                CREATE INDEX IF NOT EXISTS ingress_pending ON ingress_events(state, next_attempt_at);
            ''')

    def capture(self, event, now):
        if event['workspace_id'] != self.store.scope['workspace_id']:
            raise ValueError('workspace mismatch')
        payload = event['payload']
        if payload['callData']['callId'] != event['call_id']:
            raise ValueError('call mismatch')
        # eventId and occurredAt can change on retries. Payload data determines
        # revisions; the first full envelope remains available for auditing.
        canonical = json.dumps(payload['callData'], sort_keys=True, separators=(',', ':'))
        digest = hashlib.sha256(canonical.encode()).hexdigest()
        with self.store.db() as db:
            db.execute('BEGIN IMMEDIATE')
            result = db.execute('''INSERT OR IGNORE INTO ingress_events
                (workspace_id,call_id,digest,payload,received_at) VALUES(?,?,?,?,?)''',
                (event['workspace_id'],event['call_id'],digest,json.dumps(payload),now))
            return 'captured' if result.rowcount else 'duplicate'

    def summary(self):
        with self.store.db() as db:
            # Check write availability, not just process liveness.
            db.execute('BEGIN IMMEDIATE')
            db.execute('UPDATE ingress_events SET attempts=attempts WHERE id=-1')
            return {'pending_events': db.execute("SELECT COUNT(*) FROM ingress_events WHERE state='pending'").fetchone()[0]}


class Forwarder:
    """Serial durable delivery; CRM outages never affect webhook receipt."""
    def __init__(self, inbox, url, token, *, transport=None):
        from urllib.parse import urlsplit
        target = urlsplit(url)
        if target.scheme != 'https' or target.path != '/internal/nooks/deals' or target.username or target.password or target.query or target.fragment or not token:
            raise ValueError('invalid Nooks forwarding configuration')
        self.inbox, self.url, self.token, self.transport = inbox, url, token, transport

    async def tick(self, now):
        import httpx
        with self.inbox.store.db() as db:
            # Never discard pending events; retain delivered evidence for 30 days.
            db.execute("DELETE FROM ingress_events WHERE state='delivered' AND received_at<?", (now-30*86400,))
            row = db.execute("SELECT id,payload,attempts FROM ingress_events WHERE state='pending' AND next_attempt_at<=? ORDER BY id LIMIT 1", (now,)).fetchone()
        if row is None:
            return
        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=False, trust_env=False, transport=self.transport) as client:
                payload = {**json.loads(row[1]), 'ingressSequence': str(row[0])}
                response = await client.post(self.url, json=payload, headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'})
                response.raise_for_status()
                if response.json().get('status') not in ('processed','ignored'):
                    raise ValueError('unconfirmed delivery')
            with self.inbox.store.db() as db:
                db.execute("UPDATE ingress_events SET state='delivered' WHERE id=?", (row[0],))
        except Exception:
            with self.inbox.store.db() as db:
                db.execute('UPDATE ingress_events SET attempts=attempts+1,next_attempt_at=? WHERE id=?',
                           (now+min(3600,5*2**min(row[2],10)),row[0]))

    async def run(self):
        import asyncio
        import time
        while True:
            try:
                await self.tick(time.time())
            except Exception:
                # A storage outage leaves events pending; retry without logging payloads.
                pass
            await asyncio.sleep(1)
