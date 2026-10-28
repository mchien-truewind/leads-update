"""Private hosted credential boundary: authenticated Nooks verification only."""
import os
import asyncio
import json
import threading
import time
from fastapi import FastAPI, HTTPException, Request
from .common import Authenticate, body, header, load_scope, verify_nooks


def create_app(*, signing_key, public_key, scope, clock=time.time, lemlist_provider=None, approval=None, private_claim=None, disposition_policy=None):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    auth = Authenticate(public_key, clock)

    @app.get('/healthz')
    async def health():
        return {'ok': True, 'role': 'private-verifier'}

    async def authenticated(request, raw, signature=''):
        try:
            auth.verify(request, raw, signature)
        except Exception:
            raise HTTPException(403, 'Request rejected.') from None

    @app.post('/v1/ready')
    async def ready(request: Request):
        raw = await body(request)
        await authenticated(request, raw)
        if raw != b'':
            raise HTTPException(400, 'Request rejected.')
        return {'ready': bool(signing_key) and scope['not_before'] <= clock() < scope['expires_at']}

    @app.post('/v1/nooks/verify')
    async def verify(request: Request):
        raw = await body(request)
        try:
            signature = header(request, 'x-webhook-signature', 200)
        except ValueError:
            raise HTTPException(403, 'Request rejected.') from None
        await authenticated(request, raw, signature)
        try:
            return {'event': verify_nooks(raw, signature, signing_key, scope, clock())}
        except Exception:
            raise HTTPException(403, 'Event rejected.') from None

    completion_lock=threading.Lock()

    def run_completion():
        # Cancellation of the HTTP waiter must not release a lock while its
        # provider thread is still writing.
        if not completion_lock.acquire(blocking=False): raise ValueError('completion already in flight')
        try:
            if private_claim.scope != lemlist_provider.scope:
                raise ValueError('private provider scope mismatch')
            from .dispositions import DispositionPolicy
            DispositionPolicy(disposition_policy.value,lemlist_provider.scope).authorize(approval)
            if not private_claim.claim(approval):
                return dict(lemlist_provider.run('inspect'), write_attempted=False)
            return lemlist_provider.run('complete')
        finally: completion_lock.release()

    @app.post('/v1/lemlist/inspect')
    async def inspect_lemlist(request: Request):
        raw=await body(request)
        await authenticated(request,raw)
        if raw or lemlist_provider is None:
            raise HTTPException(503,'Scoped lemlist inspection unavailable.')
        try:
            return await asyncio.to_thread(lemlist_provider.run,'inspect')
        except Exception:
            raise HTTPException(503,'Scoped lemlist inspection unavailable.') from None

    @app.post('/v1/lemlist/complete')
    async def complete_lemlist(request: Request):
        from .common import unique
        from .completion import validate_approval
        raw=await body(request)
        await authenticated(request,raw)
        try:
            supplied=json.loads(raw,object_pairs_hook=unique)
            validate_approval(supplied)
            if approval is None or supplied!=approval or lemlist_provider is None or private_claim is None or disposition_policy is None:
                raise ValueError('completion disabled')
            return await asyncio.to_thread(run_completion)
        except Exception:
            raise HTTPException(503,'Scoped completion unavailable; reconcile by inspection.') from None

    return app


def configured(scope):
    """Optional scoped provider configuration; no default mutation grant."""
    from .completion import validate_approval
    from .lemlist_provider import Provider
    from .private_claim import PrivateClaim
    from .dispositions import configured as configured_policy
    from .common import unique
    value=os.environ.get('LEMLIST_TEST_SCOPE','')
    if not value:
        if os.environ.get('COMPLETION_APPROVAL') or os.environ.get('NOOKS_DISPOSITION_POLICY'): raise ValueError('approval or mapping without scope')
        return None,None,None,None
    selected=json.loads(value,object_pairs_hook=unique)
    expected={'workspace_id':selected['workspace_id'],'prospect_id':selected['hubspot_contact_id'],
              'not_before':selected['starts_at'],'expires_at':selected['expires_at']}
    if expected!=scope: raise ValueError('provider and capture scopes differ')
    if os.environ.get('RAILWAY_VOLUME_MOUNT_PATH') != '/data':
        raise ValueError('private completion requires durable Railway volume')
    claim=PrivateClaim('/data/state',selected)
    approval=json.loads(os.environ['COMPLETION_APPROVAL'],object_pairs_hook=unique) if os.environ.get('COMPLETION_APPROVAL') else None
    policy=configured_policy(selected,os.environ)
    if approval is not None:
        validate_approval(approval)
        if policy is None: raise ValueError('approval without disposition policy')
        policy.authorize(approval)
    return Provider(os.environ.get('LEMLIST_API',''),selected,allow_write=approval is not None),approval,claim,policy


def from_environment():
    scope=load_scope(os.environ['CAPTURE_SCOPE'])
    provider,approval,claim,policy=configured(scope)
    return create_app(signing_key=os.environ.get('NOOKS_SIGNING_KEY', ''),
        public_key=os.environ.get('RECEIVER_PUBLIC_KEY', ''), scope=scope,
        lemlist_provider=provider,approval=approval,private_claim=claim,disposition_policy=policy)
