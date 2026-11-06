"""Reviewed account IDs decide outcomes; mutable disposition names never do."""
import hashlib
import json


class DispositionPolicy:
    def __init__(self, value, scope):
        fields = {'workspace_id', 'nooks_rep_id', 'lemlist_rep_id', 'dispositions'}
        def identity(item):
            return isinstance(item, str) and 1 <= len(item) <= 200 and all(32 <= ord(c) < 127 for c in item)
        if (not isinstance(value, dict) or set(value) != fields
                or any(not identity(value[k]) for k in fields-{'dispositions'})
                or value['workspace_id'] != scope['workspace_id']
                or value['lemlist_rep_id'] != scope['assigned_rep_id']
                or not isinstance(value['dispositions'], dict)
                or not 1 <= len(value['dispositions']) <= 100
                or any(not identity(k) or v not in ('complete', 'suppress', 'hold')
                       for k, v in value['dispositions'].items())):
            raise ValueError('reviewed disposition and representative mapping required')
        self.encoded = json.dumps(value, sort_keys=True, separators=(',', ':'))
        self.value = json.loads(self.encoded)
        self.digest = hashlib.sha256(self.encoded.encode()).hexdigest()

    def action(self, event):
        if event.get('workspace_id', self.value['workspace_id']) != self.value['workspace_id']:
            return 'workspace_mismatch'
        if event.get('rep_id') != self.value['nooks_rep_id']:
            return 'caller_mismatch'
        mapped=self.value['dispositions'].get(event.get('disposition_id'))
        return {'complete':'completion_allowed', 'suppress':'suppression_required',
                'hold':'held'}.get(mapped,'unmapped_disposition')

    def authorize(self, approval):
        if approval.get('policy_digest') != self.digest or self.action(approval) != 'completion_allowed':
            raise ValueError('approval does not match reviewed disposition policy')


def configured(scope, environment):
    from .common import unique
    value = environment.get('NOOKS_DISPOSITION_POLICY', '')
    return DispositionPolicy(json.loads(value, object_pairs_hook=unique), scope) if value else None
