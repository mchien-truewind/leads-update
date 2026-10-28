"""Bounded signed requests shared by the hosted receiver and credential verifier."""
import asyncio
import base64
import datetime
import hashlib
import hmac
import json
import re
import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException

MAX_BODY = 32768
AUDIENCE = 'truewind-nooks-capture-v1'


async def body(request):
    async def read():
        result = bytearray()
        async for chunk in request.stream():
            result.extend(chunk)
            if len(result) > MAX_BODY:
                raise HTTPException(413, 'Request too large.')
        return bytes(result)
    try:
        return await asyncio.wait_for(read(), 5)
    except asyncio.TimeoutError:
        raise HTTPException(408, 'Request timed out.') from None


def header(request, name, limit):
    values = request.headers.getlist(name)
    if len(values) != 1 or not 1 <= len(values[0]) <= limit:
        raise ValueError('invalid header')
    return values[0]


def envelope(path, stamp, nonce, raw, nooks_signature):
    return json.dumps([AUDIENCE, 'POST', path, stamp, nonce,
        hashlib.sha256(raw).hexdigest(), nooks_signature], separators=(',', ':'), ensure_ascii=True).encode()


class Authenticate:
    def __init__(self, public_key, clock=time.time):
        self.key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key)) if public_key else None
        self.clock, self.used, self.minute = clock, {}, []

    def verify(self, request, raw, nooks_signature):
        if self.key is None:
            raise ValueError('identity not pinned')
        stamp, nonce = header(request, 'x-app-time', 10), header(request, 'x-app-nonce', 32)
        signature = header(request, 'x-app-signature', 100)
        if not re.fullmatch(r'[0-9]{10}', stamp) or not re.fullmatch(r'[a-f0-9]{32}', nonce):
            raise ValueError('invalid app identity')
        now = self.clock()
        if abs(now-int(stamp)) > 30:
            raise ValueError('expired request')
        self.key.verify(base64.b64decode(signature, validate=True),
                        envelope(request.url.path, stamp, nonce, raw, nooks_signature))
        self.used = {k: expiry for k, expiry in self.used.items() if expiry >= now}
        self.minute = [t for t in self.minute if now-t < 60]
        if nonce in self.used or len(self.used) >= 256 or len(self.minute) >= 120:
            raise ValueError('replay or rate limit')
        self.used[nonce] = now+61
        self.minute.append(now)


def unique(pairs):
    result = {}
    for k, v in pairs:
        if k in result:
            raise ValueError('duplicate JSON key')
        result[k] = v
    return result


def load_scope(value):
    scope = json.loads(value, object_pairs_hook=unique)
    if (not isinstance(scope, dict) or set(scope) != {'workspace_id', 'prospect_id', 'not_before', 'expires_at'}
            or not isinstance(scope['workspace_id'], str) or not re.fullmatch(r'[A-Za-z0-9]{1,100}', scope['workspace_id'])
            or not isinstance(scope['prospect_id'], str) or not re.fullmatch(r'[1-9][0-9]{0,24}', scope['prospect_id'])
            or any(type(scope[k]) is not int for k in ('not_before', 'expires_at'))
            or not 0 < scope['not_before'] < scope['expires_at'] <= scope['not_before']+172800):
        raise ValueError('invalid one-contact capture scope')
    return scope


def timestamp(value):
    if not isinstance(value, str) or len(value) > 40:
        raise ValueError('invalid call time')
    dt = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        raise ValueError('timezone missing')
    return dt.timestamp()


def verify_nooks(raw, signature, key, scope, now):
    if not key or not scope['not_before'] <= now < scope['expires_at']:
        raise ValueError('capture not enabled')
    parts = {}
    for item in signature.split(','):
        k, sep, v = item.strip().partition('=')
        if not sep or k not in ('t', 's') or k in parts:
            raise ValueError('invalid signature')
        parts[k] = v
    if set(parts) != {'t', 's'} or not re.fullmatch(r'[0-9]{13}', parts['t']):
        raise ValueError('invalid timestamp')
    if abs(now-int(parts['t'])/1000) > 300:
        raise ValueError('stale event')
    expected = hmac.new(key.encode(), parts['t'].encode()+b'.'+raw, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, base64.b64decode(parts['s'], validate=True)):
        raise ValueError('signature mismatch')
    event = json.loads(raw, object_pairs_hook=unique)
    call = event['callData']
    if (event['event'] != 'call.logged' or call['status'] != 'completed' or call['callDirection'] != 'outbound'
            or call['workspaceId'] != scope['workspace_id'] or call['prospectData']['prospectId'] != scope['prospect_id']):
        raise ValueError('call outside scope')
    result = {'workspace_id': call['workspaceId'], 'prospect_id': call['prospectData']['prospectId'],
        'call_id': call['callId'], 'rep_id': call['userData']['userId'],
        'disposition_id': call['disposition']['id'], 'disposition_name': call['disposition']['name'],
        'started_at': timestamp(call['startedAt']), 'finalized_at': timestamp(event['occurredAt'])}
    if (any(not isinstance(v, str) or not 1 <= len(v) <= 200 or any(ord(c) < 32 for c in v)
            for k, v in result.items() if not k.endswith('_at'))
            or not scope['not_before'] <= result['started_at'] <= result['finalized_at'] <= now+300):
        raise ValueError('invalid event correlation')
    return result  # No outcome classification or task mutation.
