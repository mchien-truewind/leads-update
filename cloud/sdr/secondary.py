"""Restore only the original untouched contact as a second durable test slot."""
import hashlib
import json

from .common import unique
from .retarget import capture_scope, validate_plan


def configured(environment, plan, primary):
    raw = environment.get('SECONDARY_TEST_SCOPE', '')
    if not raw:
        if environment.get('SECONDARY_COMPLETION_APPROVAL') or environment.get('SECONDARY_NOOKS_DISPOSITION_POLICY'):
            raise ValueError('secondary approval or mapping without scope')
        return None
    secondary = json.loads(raw, object_pairs_hook=unique)
    validate_plan(plan)
    if primary != plan['to_scope'] or secondary != plan['from_scope']:
        raise ValueError('only the archived original test may be added')
    return secondary


def settings(scope, environment):
    from .completion import validate_approval
    from .dispositions import configured as policy_configured
    raw = environment.get('SECONDARY_COMPLETION_APPROVAL', '')
    approval = json.loads(raw, object_pairs_hook=unique) if raw else None
    policy = policy_configured(scope, {'NOOKS_DISPOSITION_POLICY':environment.get('SECONDARY_NOOKS_DISPOSITION_POLICY', '')})
    if approval is not None:
        validate_approval(approval)
        if policy is None: raise ValueError('secondary approval requires reviewed mapping')
        policy.authorize(approval)
    return approval, policy


def open_secondary(parent, scope, role):
    """Copy archived *unclaimed* state once; never overwrite a child journal."""
    if role not in ('receiver','verifier'): raise ValueError('invalid secondary role')
    with parent.db() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT plan,old_state FROM retarget_history WHERE singleton=1').fetchone()
        if not row: raise ValueError('original test archive missing')
        plan, archived = (json.loads(value,object_pairs_hook=unique) for value in row)
        validate_plan(plan)
        expected = capture_scope(plan['to_scope']) if role == 'receiver' else plan['to_scope']
        if parent.scope != expected or scope != plan['from_scope']:
            raise ValueError('secondary scope differs from original archive')
        original = archived.get('completion' if role == 'receiver' else 'write_claim')
        if (not isinstance(original,dict) or json.loads(original['scope']) != scope
                or original.get('approval') is not None or original.get('claimed_at') is not None):
            raise ValueError('original test was claimed')
        if role == 'receiver' and (original.get('state') != 'armed' or original.get('policy') is not None
                or original.get('write_receipt') is not None or original.get('after_evidence') is not None
                or archived.get('capture',{}).get('held') != 0
                or json.loads(archived['capture']['value']) != capture_scope(scope)):
            raise ValueError('original capture was not untouched')
        origin = hashlib.sha256(json.dumps([plan,archived],sort_keys=True,separators=(',',':')).encode()).hexdigest()
        directory = parent.directory/('secondary-'+scope['hubspot_contact_id'])
        if role == 'receiver':
            from .receiver import Store
            from .completion import Completion
            child = Store(directory,capture_scope(scope))
            Completion(child,scope)  # Schema only; preserve the original arm timestamp below.
        else:
            from .private_claim import PrivateClaim
            child = PrivateClaim(directory,scope,clock=parent.clock)
        with child.db() as target:
            target.execute('BEGIN IMMEDIATE')
            target.execute('CREATE TABLE IF NOT EXISTS secondary_origin (singleton INTEGER PRIMARY KEY CHECK(singleton=1), digest TEXT NOT NULL)')
            marker = target.execute('SELECT digest FROM secondary_origin WHERE singleton=1').fetchone()
            if marker:
                if marker[0] != origin: raise ValueError('secondary origin cannot change')
                if role == 'receiver' and not target.execute('SELECT 1 FROM completion WHERE singleton=1').fetchone():
                    raise ValueError('secondary completion journal missing')
            else:
                if role == 'receiver':
                    if (target.execute('SELECT COUNT(*) FROM events').fetchone()[0]
                            or target.execute('SELECT held FROM scope WHERE singleton=1').fetchone()[0]
                            or target.execute('SELECT 1 FROM completion WHERE singleton=1').fetchone()):
                        raise ValueError('secondary receiver already used without origin')
                    fields = ('singleton','scope','armed_at','state','before_evidence','approval','claimed_at','write_receipt','after_evidence','policy')
                    target.execute('INSERT INTO completion ('+','.join(fields)+') VALUES ('+','.join('?' for _ in fields)+')',
                                   tuple(original.get(k) for k in fields))
                else:
                    claim = target.execute('SELECT approval,claimed_at FROM write_claim WHERE singleton=1').fetchone()
                    if claim != (None,None): raise ValueError('secondary private claim already used without origin')
                target.execute('INSERT INTO secondary_origin VALUES(1,?)',(origin,))
    return child
