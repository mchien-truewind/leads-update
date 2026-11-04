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
