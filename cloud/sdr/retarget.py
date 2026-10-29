"""One explicit contact change; archive an untouched test and pin its prior call."""
import json
import re

from .common import unique
from .lemlist_contract import active, validate_scope

_CHANGED = {'hubspot_contact_id', 'task_id', 'lead_id', 'contact_id'}


def capture_scope(scope):
    return dict(workspace_id=scope['workspace_id'], prospect_id=scope['hubspot_contact_id'],
                not_before=scope['starts_at'], expires_at=scope['expires_at'])


def validate_plan(plan):
    if (not isinstance(plan, dict) or set(plan) != {'from_scope', 'to_scope', 'call_id', 'confirmed_contact'}
            or plan['confirmed_contact'] is not True or not isinstance(plan['call_id'], str)
            or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', plan['call_id'])):
        raise ValueError('explicit one-contact retarget plan required')
    old, new = plan['from_scope'], plan['to_scope']
    validate_scope(old); validate_scope(new)
    if {k for k in old if old[k] != new[k]} != _CHANGED:
        raise ValueError('retarget cannot change campaign, owner, steps or time window')
    return json.dumps(plan, sort_keys=True, separators=(',', ':'))


def configured(environment):
    raw = environment.get('TEST_RETARGET', '')
    plan = json.loads(raw, object_pairs_hook=unique) if raw else None
    if plan is not None: validate_plan(plan)
    return plan


def _row(db, table):
    cursor = db.execute('SELECT * FROM '+table+' WHERE singleton=1')
    row = cursor.fetchone()
    return dict(zip((x[0] for x in cursor.description), row)) if row else None


def apply(db, role, plan, target, now):
    """Called inside the owning journal's IMMEDIATE transaction; never reset a claim."""
    if role not in ('receiver', 'verifier'): raise ValueError('invalid journal role')
    exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='retarget_history'").fetchone()
    history = _row(db, 'retarget_history') if exists else None
    if plan is None:
        if history: raise ValueError('retarget plan cannot be removed')
        return None
    encoded = validate_plan(plan)
    old, new = plan['from_scope'], plan['to_scope']
    expected = capture_scope(new) if role == 'receiver' else new
    if target != expected: raise ValueError('retarget differs from configured scope')
    if history:
        if history['plan'] != encoded: raise ValueError('retarget plan cannot change')
        return plan['call_id']  # Startup readback; existing claims remain untouched.
    active(old, now)
    if role == 'receiver':
        previous = _row(db, 'scope')
        has_completion = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='completion'").fetchone()
        completion = _row(db, 'completion') if has_completion else None
        if (not previous or json.loads(previous['value']) != capture_scope(old) or previous['held']
                or db.execute('SELECT COUNT(*) FROM events').fetchone()[0]
                or not completion or json.loads(completion['scope']) != old
                or completion['state'] != 'armed'
                or any(completion.get(k) is not None for k in
                       ('approval', 'claimed_at', 'write_receipt', 'after_evidence', 'policy'))):
            raise ValueError('only an untouched armed test can be retired')
        archived = {'capture': previous, 'completion': completion}
    else:
        previous = _row(db, 'write_claim')
        if (not previous or json.loads(previous['scope']) != old
                or previous['approval'] is not None or previous['claimed_at'] is not None):
            raise ValueError('claimed or unknown private test cannot be retired')
        archived = {'write_claim': previous}
    db.execute('CREATE TABLE retarget_history (singleton INTEGER PRIMARY KEY CHECK(singleton=1), plan TEXT NOT NULL, old_state TEXT NOT NULL, changed_at REAL NOT NULL)')
    db.execute('INSERT INTO retarget_history VALUES(1,?,?,?)',
               (encoded, json.dumps(archived, sort_keys=True), now))
    if role == 'receiver':
        db.execute('UPDATE scope SET value=? WHERE singleton=1', (json.dumps(expected, sort_keys=True),))
        # The entire original row is archived above in this same transaction.
        db.execute('DELETE FROM completion WHERE singleton=1')
    else:
        db.execute('UPDATE write_claim SET scope=? WHERE singleton=1', (json.dumps(new, sort_keys=True),))
    return plan['call_id']
