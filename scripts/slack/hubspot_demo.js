const crypto = require('crypto');
const { appliesToSubmission } = require('./demo-routing');

const PORTAL_ID = 43974586;
const APP_ID = 31714623;
const PROPERTY = 'demo_form_submission_datetime';
const CHANNEL_ID = 'C066P0YFF6Z';
const MENTION_ID = 'U0ABULY5TEK';
const CONTACT_PROPERTIES = ['firstname', 'lastname', 'email', 'erp', 'jobtitle', 'how_did_you_hear_about_us', 'finance_team_size', 'phone', 'createdate'];

function isDemoEvent(event) {
  if (!event || !['contact.propertyChange', 'object.propertyChange'].includes(event.subscriptionType)) return false;
  if (event.subscriptionType === 'object.propertyChange' && event.objectTypeId !== '0-1') return false;
  if (event.portalId !== PORTAL_ID || event.appId !== APP_ID || event.propertyName !== PROPERTY) return false;
  if (!Number.isSafeInteger(event.objectId) || event.objectId <= 0 || !Number.isSafeInteger(event.occurredAt) || event.occurredAt <= 0) return false;
  const value = String(event.propertyValue ?? '').trim();
  if (!value) return false;
  const date = /^\d+$/.test(value) ? new Date(Number(value)) : new Date(value);
  return Number.isFinite(date.getTime());
}

function eventKey(event) {
  // eventId is not globally unique; delivery attempts and duplicate subscriptions
  // must not create another notification for the same contact property change.
  return crypto.createHash('sha256').update(JSON.stringify([
    event.appId, event.portalId, event.objectId, event.propertyName, event.occurredAt, event.propertyValue,
  ])).digest('hex');
}

function escapeSlack(value) {
  return String(value ?? '').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatCreatedDate(value) {
  if (!value) return '';
  const date = /^\d+$/.test(String(value)) ? new Date(Number(value)) : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: '2-digit',
  }).format(date);
}

function buildMessage(contact, routing = null) {
  if (!/^\d+$/.test(String(contact.id))) throw new Error('invalid_contact_id');
  const p = contact.properties || {};
  const text = [
    `<@${routing?.slackUserId || MENTION_ID}>`, routing?.status === 'existing_deal' ? 'DEMO Submission — existing opportunity' : 'New DEMO Submission',
    escapeSlack([p.firstname, p.lastname].filter(Boolean).join(' ')), escapeSlack(p.email),
    `- ERP: ${escapeSlack(p.erp)}`, `- Job Title: ${escapeSlack(p.jobtitle)}`,
    `- How did you hear about us? ${escapeSlack(p.how_did_you_hear_about_us)}`,
    `- Finance team size: ${escapeSlack(p.finance_team_size)}`, `- Phone: ${escapeSlack(p.phone)}`,
    `- Date Created: ${formatCreatedDate(p.createdate)}`,
    ...(routing?.status === 'existing_deal' ? [`- Existing deal: <https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-3/${routing.dealId}|View opportunity>`, `- Deal owner: ${escapeSlack(routing.ownerName || routing.ownerId)}`] : []),
    ...(routing && !routing.calendlyUrl && routing.status === 'existing_deal' ? ['- Routing needs attention: personal calendar mapping unavailable; general calendar fallback.'] : []),
  ].join('\n');
  if (text.length > 3000) throw new Error('demo_message_too_long');
  return {
    channel: CHANNEL_ID, text, unfurl_links: false, unfurl_media: false,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text, verbatim: true } },
      { type: 'actions', elements: [{
        type: 'button', action_id: 'lookup_hubspot_contact',
        text: { type: 'plain_text', text: 'look up in hubspot' },
        url: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-1/${contact.id}`,
      }] },
    ],
  };
}

class DemoNotificationStore {
  constructor(pool) { this.pool = pool; }

  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS hubspot_demo_notifications (
      event_key TEXT PRIMARY KEY,
      event JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'needs_review')),
      phase TEXT NOT NULL DEFAULT 'fetching' CHECK (phase IN ('fetching', 'sending', 'sent')),
      claim_token UUID,
      slack_ts TEXT,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await this.pool.query('ALTER TABLE hubspot_demo_notifications ADD COLUMN IF NOT EXISTS routing JSONB');
    await this.pool.query("CREATE INDEX IF NOT EXISTS hubspot_demo_notifications_recovery_idx ON hubspot_demo_notifications (updated_at) WHERE status IN ('pending', 'processing')");
  }

  async record(event) {
    const key = eventKey(event);
    // Retain only fields needed to identify and reconcile this notification.
    await this.pool.query(`INSERT INTO hubspot_demo_notifications (event_key, event)
      VALUES ($1, $2::jsonb) ON CONFLICT (event_key) DO NOTHING`, [key, JSON.stringify({
      appId: event.appId, portalId: event.portalId, objectId: event.objectId,
      propertyName: event.propertyName, propertyValue: event.propertyValue, occurredAt: event.occurredAt,
    })]);
    return key;
  }

  async claim(key) {
    const result = await this.pool.query(`UPDATE hubspot_demo_notifications
      SET status = 'processing', phase = 'fetching', claim_token = $2, last_error = NULL, updated_at = NOW()
      WHERE event_key = $1 AND (status = 'pending' OR (
        status = 'processing' AND phase = 'fetching' AND updated_at < NOW() - INTERVAL '2 minutes'
      )) RETURNING *`, [key, crypto.randomUUID()]);
    return result.rows[0] || null;
  }

  async get(key) {
    return (await this.pool.query('SELECT * FROM hubspot_demo_notifications WHERE event_key = $1', [key])).rows[0] || null;
  }

  async save(claim, { status, phase, slackTs = null, error = null }) {
    const result = await this.pool.query(`UPDATE hubspot_demo_notifications
      SET status = $3, phase = $4, slack_ts = $5, last_error = $6, updated_at = NOW()
      WHERE event_key = $1 AND claim_token = $2 AND status = 'processing' RETURNING event_key`,
    [claim.event_key, claim.claim_token, status, phase, slackTs, error]);
    if (result.rowCount !== 1) throw new Error('demo_claim_lost');
  }

  async saveRouting(claim, routing) {
    const result = await this.pool.query(`UPDATE hubspot_demo_notifications SET routing = $3::jsonb, updated_at = NOW()
      WHERE event_key = $1 AND claim_token = $2 AND status = 'processing' RETURNING event_key`,
    [claim.event_key, claim.claim_token, JSON.stringify(routing)]);
    if (result.rowCount !== 1) throw new Error('demo_claim_lost');
  }

  async retryableEvents(activatedAt) {
    return (await this.pool.query(`SELECT event_key, event FROM hubspot_demo_notifications
      WHERE (event->>'occurredAt')::bigint >= $1 AND (
        (status = 'pending' AND updated_at < NOW() - INTERVAL '30 seconds')
        OR (status = 'processing' AND updated_at < NOW() - INTERVAL '2 minutes')
      ) ORDER BY updated_at LIMIT 25`, [activatedAt])).rows;
  }

  async quarantineStaleSend(key) {
    const result = await this.pool.query(`UPDATE hubspot_demo_notifications
      SET status = 'needs_review', last_error = 'slack_delivery_unknown', updated_at = NOW()
      WHERE event_key = $1 AND status = 'processing' AND phase = 'sending'
        AND updated_at < NOW() - INTERVAL '2 minutes' RETURNING event_key`, [key]);
    return result.rowCount === 1;
  }
}

function retryError(code) {
  const error = new Error(code);
  error.retryable = true;
  return error;
}

async function processEvent(event, { store, hubspotRequest, env, fetchImpl = fetch, logger = console, demoRouter = null }) {
  const key = await store.record(event);
  const claim = await store.claim(key);
  if (!claim) {
    const row = await store.get(key);
    if (row?.status === 'completed') return 'duplicate';
    if (row?.status === 'needs_review') return 'needs_review';
    if (await store.quarantineStaleSend(key)) {
      logger.error('hubspot_demo_needs_review', { eventKey: key, reason: 'stale_send' });
      return 'needs_review';
    }
    throw retryError('demo_already_processing');
  }
  let sendStarted = false;
  let definitelyRejected = false;
  let slackTs = null;
  try {
    const contact = await hubspotRequest(`/crm/v3/objects/contacts/${event.objectId}?properties=${CONTACT_PROPERTIES.join(',')}`);
    if (String(contact.id) !== String(event.objectId)) throw new Error('contact_id_mismatch');
    let routing = null;
    if (demoRouter && appliesToSubmission(event.propertyValue, env)) {
      routing = await demoRouter.alignContact({ email: contact.properties.email, contactId: String(contact.id) });
      await store.saveRouting(claim, routing);
      if (routing.status === 'unresolved') throw retryError('demo_routing_unresolved');
      if (routing.status === 'existing_deal') {
        // Do not notify from a routing snapshot captured before contact reconciliation.
        routing = await demoRouter.alignContact({ email: contact.properties.email, contactId: String(contact.id) });
        await store.saveRouting(claim, routing);
        if (routing.status !== 'existing_deal') throw retryError('demo_routing_changed');
      }
    }
    const message = buildMessage(contact, routing);
    // Commit intent before the external write. A crashed/ambiguous send is
    // quarantined, never automatically replayed into a duplicate Slack post.
    await store.save(claim, { status: 'processing', phase: 'sending' });
    sendStarted = true;
    const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN.replace(/\s+/g, '')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...message, metadata: { event_type: 'hubspot_demo_submission', event_payload: { event_key: key } } }),
    });
    if (response.status === 429) {
      definitelyRejected = true;
      throw new Error('slack_rate_limited');
    }
    if (!response.ok) throw new Error('slack_http_delivery_unknown');
    const result = await response.json();
    if (result.ok === false) {
      definitelyRejected = true;
      throw new Error('slack_rejected');
    }
    if (result.ok !== true || !result.ts || result.channel !== CHANNEL_ID) throw new Error('slack_delivery_unknown');
    slackTs = result.ts;
    await store.save(claim, { status: 'completed', phase: 'sent', slackTs });
    return 'sent';
  } catch (error) {
    const unknown = sendStarted && !definitelyRejected;
    // Persist categorical errors only: HubSpot responses may contain CRM data.
    await store.save(claim, {
      status: unknown ? 'needs_review' : 'pending', phase: unknown ? 'sending' : 'fetching', slackTs,
      error: unknown ? 'slack_delivery_unknown' : (sendStarted ? 'slack_rejected' : 'contact_lookup_or_preparation_failed'),
    });
    logger.error('hubspot_demo_delivery_failed', { eventKey: key, needsReview: unknown });
    if (unknown) return 'needs_review';
    throw retryError('demo_delivery_retry_required');
  }
}

async function handleHubSpotDemoWebhook(req, res, options) {
  const { env = process.env, store, hubspotRequest, logger = console } = options;
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', ...(status === 503 ? { 'retry-after': '30' } : {}) });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  if (env.HUBSPOT_DEMO_SLACK_ENABLED !== 'true' || !store || !env.HUBSPOT_CLIENT_SECRET
    || !env.SLACK_BOT_TOKEN?.trim() || !(env.HUBSPOT_PRIVATE_TOKEN || env.HUBSPOT_ACCESS_TOKEN)) {
    return reply(503, { error: 'demo_webhook_not_configured' });
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > 1024 * 1024) return reply(413, { error: 'body_too_large' });
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks);
    const expected = crypto.createHash('sha256').update(env.HUBSPOT_CLIENT_SECRET).update(raw).digest('hex');
    const supplied = String(req.headers['x-hubspot-signature'] || '');
    const version = req.headers['x-hubspot-signature-version'];
    if ((version && version !== 'v1') || !/^[a-f0-9]{64}$/.test(supplied)
      || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      return reply(401, { error: 'invalid_signature' });
    }
    let events;
    try { events = JSON.parse(raw.toString('utf8')); } catch { return reply(400, { error: 'invalid_json' }); }
    if (!Array.isArray(events) || events.length > 100) return reply(400, { error: 'expected_event_batch' });
    const results = [];
    for (const event of events.filter(isDemoEvent)) results.push(await processEvent(event, { ...options, env, store, hubspotRequest, logger }));
    return reply(200, {
      received: events.length, sent: results.filter(value => value === 'sent').length,
      duplicates: results.filter(value => value === 'duplicate').length,
      needsReview: results.filter(value => value === 'needs_review').length,
      ignored: events.length - results.length,
    });
  } catch (error) {
    logger.error('hubspot_demo_webhook_retry_required', { retryable: true });
    return reply(503, { error: 'demo_webhook_retry_required' });
  }
}

module.exports = { DemoNotificationStore, isDemoEvent, eventKey, buildMessage, processEvent, handleHubSpotDemoWebhook };
