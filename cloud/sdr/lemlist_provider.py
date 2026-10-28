"""Private-broker-only provider transport. Not wired to any hosted endpoint yet."""
import json
import time
from urllib.parse import parse_qs, urlsplit

import httpx
from . import lemlist_contract as contract
from .common import unique


class Provider:
    def __init__(self, key, scope, *, allow_write=False, transport=None, clock=time.time, monotonic=time.monotonic):
        contract.validate_scope(scope)
        self.key, self.scope = key, dict(scope)
        self.allow_write, self.transport = allow_write, transport
        self.clock, self.monotonic = clock, monotonic

    def _allowed(self, method, path, payload):
        u = urlsplit(path)
        if u.scheme or u.netloc or u.fragment or not path.startswith('/api/'):
            return False
        q = parse_qs(u.query,keep_blank_values=True)
        scope = self.scope
        if method == 'PATCH':
            return (self.allow_write is True and path == '/api/tasks'
                    and payload == {'id':scope['task_id'],'done':True})
        if method != 'GET' or payload is not None:
            return False
        if path == '/api/campaigns/'+scope['campaign_id']+'/sequences': return True
        if u.path == '/api/contacts': return q == {'crmIds':[scope['hubspot_contact_id']]}
        if u.path == '/api/leads': return q == {'id':[scope['lead_id']]}
        if u.path == '/api/v2/tasks':
            return q in ({'campaignId':[scope['campaign_id']],'taskId':[scope['task_id']],'limit':['2'],'page':['1']},
                {'campaignId':[scope['campaign_id']],'leadId':[scope['lead_id']],'type':['manual'],'limit':['100'],'page':['1']})
        if u.path == '/api/activities':
            return (set(q) == {'campaignId','leadId','type','minDate','limit','offset'}
                and q['campaignId'] == [scope['campaign_id']] and q['leadId'] == [scope['lead_id']]
                and q['type'] == ['manualDone'] and q['minDate'] == [str(scope['starts_at'])]
                and q['limit'] == ['100'] and q['offset'] in ([str(x)] for x in range(0,500,100)))
        return False

    def run(self, operation):
        if operation not in ('inspect','complete') or not self.key:
            raise ValueError('provider operation unavailable')
        if operation == 'complete' and self.allow_write is not True:
            raise ValueError('task completion disabled')
        deadline, calls, writes = self.monotonic()+45, 0, 0
        with httpx.Client(base_url='https://api.lemlist.com',auth=httpx.BasicAuth('',self.key),
                transport=self.transport,trust_env=False,follow_redirects=False,timeout=5) as client:
            def request(method,path,payload=None):
                nonlocal calls,writes
                if not self._allowed(method,path,payload) or calls >= 24 or self.monotonic() >= deadline:
                    raise ValueError('provider request outside scope')
                calls += 1
                if method == 'PATCH':
                    contract.active(self.scope,self.clock())
                    if writes: raise ValueError('one write attempt only')
                    writes += 1
                try:
                    with client.stream(method,path,json=payload,headers={'Accept':'application/json'}) as response:
                        if response.status_code not in ((200,) if method == 'GET' else (200,201,204)):
                            raise ValueError('provider request rejected')
                        raw=bytearray()
                        for chunk in response.iter_bytes():
                            raw.extend(chunk)
                            if len(raw)>131072 or self.monotonic()>=deadline:
                                raise ValueError('provider response exceeded limits')
                        return json.loads(raw,object_pairs_hook=unique) if method=='GET' else None
                except Exception:
                    raise ValueError('provider unavailable or rejected') from None
            if operation == 'inspect': return contract.observe(self.scope,lambda p:request('GET',p))
            return contract.complete(self.scope,lambda p:request('GET',p),request,clock=self.clock)
