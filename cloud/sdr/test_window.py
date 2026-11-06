"""One explicitly authorized two-hour reopening; original task scopes never change."""
import json

from .common import unique
from .lemlist_contract import validate_scope
from .retarget import capture_scope


def validate(value):
    fields = {'scopes','starts_at','expires_at','confirmed_reopen'}
    if (not isinstance(value,dict) or set(value) != fields or value['confirmed_reopen'] is not True
            or not isinstance(value['scopes'],list) or len(value['scopes']) != 2
            or any(type(value[k]) is not int for k in ('starts_at','expires_at'))
            or not 0 < value['expires_at']-value['starts_at'] <= 7200):
        raise ValueError('explicit two-contact reopening for at most two hours required')
    for scope in value['scopes']: validate_scope(scope)
    if (len({s['hubspot_contact_id'] for s in value['scopes']}) != 2
            or len({s['task_id'] for s in value['scopes']}) != 2
            or value['starts_at'] < max(s['expires_at'] for s in value['scopes'])):
        raise ValueError('reopening must follow the original test window')
    return json.dumps(value,sort_keys=True,separators=(',',':'))


def configured(environment, primary, secondary):
    raw = environment.get('TEST_WINDOW_REOPEN','')
    if not raw: return None
    value = json.loads(raw,object_pairs_hook=unique)
    validate(value)
    if primary is None or secondary is None or value['scopes'] != [primary,secondary]:
        raise ValueError('reopening must bind the exact two configured scopes in order')
    return value


class Window:
    def __init__(self, scope, value):
        self.encoded = validate(value)
        if scope not in value['scopes']: raise ValueError('scope outside reopened test')
        self.scope = dict(scope)
        self.capture_scope = capture_scope(scope)
        self.starts_at, self.expires_at = value['starts_at'], value['expires_at']

    def allows(self, scope, now):
        return (scope == self.scope or scope == self.capture_scope) and self.starts_at <= now < self.expires_at


def bind(owner, scope, value, *, now=None):
    """Persist the exact authorization once, preserving all events and write claims."""
    if value is None:
        owner.window = None  # Removing configuration closes access; never auto-renew.
        return None
    window = Window(scope,value)
    if owner.scope not in (scope,window.capture_scope): raise ValueError('journal scope differs from reopening')
    now = owner.clock() if now is None else now
    with owner.db() as db:
        db.execute('BEGIN IMMEDIATE')
        db.execute('CREATE TABLE IF NOT EXISTS test_window_reopen (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL)')
        row = db.execute('SELECT value FROM test_window_reopen WHERE singleton=1').fetchone()
        if row:
            if row[0] != window.encoded: raise ValueError('test reopening cannot change or renew')
        else:
            if window.starts_at > now+300 or now >= window.expires_at:
                raise ValueError('new reopening must be installed within its fixed window')
            db.execute('INSERT INTO test_window_reopen VALUES(1,?)',(window.encoded,))
    owner.window = window
    return window
