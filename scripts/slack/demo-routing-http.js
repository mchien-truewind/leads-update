const crypto = require('crypto');
const { routingEnabled } = require('./demo-routing');

async function handleDemoRoutingRequest(req, res, { router, env = process.env, logger = console }) {
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const expected = env.DEMO_ROUTING_INTERNAL_TOKEN;
  const supplied = String(req.headers.authorization || '');
  if (!expected || expected.length < 32 || !crypto.timingSafeEqual(
    crypto.createHash('sha256').update(supplied).digest(),
    crypto.createHash('sha256').update(`Bearer ${expected}`).digest(),
  )) return reply(401, { error: 'unauthorized' });
  if (!router || !routingEnabled(env)) return reply(503, { status: 'unresolved', reason: 'routing_disabled' });
  let timer;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > 4096) return reply(413, { error: 'body_too_large' });
      chunks.push(Buffer.from(chunk));
    }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { error: 'invalid_json' }); }
    if (!input || typeof input.email !== 'string' || input.email.length > 320
      || (input.contactId !== undefined && (typeof input.contactId !== 'string' || !/^\d+$/.test(input.contactId)))) return reply(400, { error: 'invalid_input' });
    const result = await Promise.race([
      router.resolve({ email: input.email, contactId: input.contactId }),
      new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'unresolved', reason: 'routing_timeout' }), 4500); }),
    ]);
    if (result.status === 'unresolved' || (result.status === 'existing_deal' && !result.calendlyUrl)) {
      logger.error('demo_routing_calendar_fallback', { reason: result.reason, contactId: result.contactId, dealId: result.dealId });
    }
    return reply(200, result);
  } catch {
    logger.error('demo_routing_request_failed');
    return reply(503, { status: 'unresolved', reason: 'routing_unavailable' });
  } finally { clearTimeout(timer); }
}

module.exports = { handleDemoRoutingRequest };
