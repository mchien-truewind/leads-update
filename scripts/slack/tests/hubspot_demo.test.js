const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { before, beforeEach, after, test } = require('node:test');
const { PGlite } = require('@electric-sql/pglite');
const { DemoNotificationStore, isDemoEvent, eventKey, buildMessage, processEvent, handleHubSpotDemoWebhook } = require('../hubspot_demo');
const { recoverDemoNotifications } = require('../demo-routing-recovery');

const event = {
  appId: 31714623, eventId: 100, subscriptionId: 8149441, portalId: 43974586,
  occurredAt: 1792018273594, subscriptionType: 'contact.propertyChange', attemptNumber: 0,
  objectId: 123, propertyName: 'demo_form_submission_datetime', propertyValue: '1792018273594',
};
const env = {
  HUBSPOT_DEMO_SLACK_ENABLED: 'true', HUBSPOT_CLIENT_SECRET: 'test-secret',
  HUBSPOT_PRIVATE_TOKEN: 'test-hubspot-token', SLACK_BOT_TOKEN: 'test-slack-token',
};
const contact = { id: '123', properties: {
  firstname: 'mercedes', lastname: 'test', email: 'testa@testa.com', erp: 'Netsuite', jobtitle: 'test',
  how_did_you_hear_about_us: 'Search engine (Google, Bing, etc.)', finance_team_size: '', phone: '',
  createdate: '2026-10-14T12:00:00Z',
} };
let db;
let store;
const logger = { error() {} };

before(async () => {
  db = new PGlite();
  const pool = { async query(text, values) {
    const result = await db.query(text, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  } };
  store = new DemoNotificationStore(pool);
  await store.initialize();
});
beforeEach(async () => { await db.exec('TRUNCATE hubspot_demo_notifications'); });
after(async () => { await db?.close(); });

function dependencies(overrides = {}) {
  const messages = [];
  return {
    messages, env, store, logger,
    async hubspotRequest(path) {
      assert.ok(path.startsWith('/crm/v3/objects/contacts/123?properties='));
      for (const property of ['erp', 'jobtitle', 'how_did_you_hear_about_us', 'finance_team_size', 'phone', 'createdate']) assert.ok(path.includes(property));
      return contact;
    },
    async fetchImpl(url, options) {
      assert.equal(url, 'https://slack.com/api/chat.postMessage');
      assert.equal(options.headers.authorization, 'Bearer test-slack-token');
      messages.push(JSON.parse(options.body));
      return Response.json({ ok: true, ts: '1792018273.000100', channel: 'C066P0YFF6Z' });
    },
    ...overrides,
  };
}

async function webhook(events, deps, { signature, version, method = 'POST', raw } = {}) {
  const body = raw ?? JSON.stringify(events);
  const req = Readable.from([Buffer.from(body)]);
  req.method = method;
  req.headers = {
    'x-hubspot-signature': signature ?? crypto.createHash('sha256').update('test-secret' + body).digest('hex'),
    ...(version ? { 'x-hubspot-signature-version': version } : {}),
  };
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(text) { this.body = JSON.parse(text); } };
  await handleHubSpotDemoWebhook(req, res, deps);
  return res;
}

test('signed demo webhook sends the exact message, mention, channel, and HubSpot button', async () => {
  const deps = dependencies();
  const response = await webhook([event], deps);
  assert.equal(response.status, 200);
  assert.equal(response.body.sent, 1);
  assert.equal(deps.messages.length, 1);
  const message = deps.messages[0];
  assert.equal(message.channel, 'C066P0YFF6Z');
  assert.equal(message.text, [
    '<@U0ABULY5TEK>', 'New DEMO Submission', 'mercedes test', 'testa@testa.com',
    '- ERP: Netsuite', '- Job Title: test', '- How did you hear about us? Search engine (Google, Bing, etc.)',
    '- Finance team size: ', '- Phone: ', '- Date Created: 10/14/26',
  ].join('\n'));
  assert.equal(message.blocks[1].elements[0].text.text, 'look up in hubspot');
  assert.equal(message.blocks[1].elements[0].url, 'https://app.hubspot.com/contacts/43974586/record/0-1/123');
  const row = await store.get(eventKey(event));
  assert.equal(row.status, 'completed');
  assert.equal(row.slack_ts, '1792018273.000100');
});

test('retries do not resend, while distinct datetime submissions on the same day both notify', async () => {
  const deps = dependencies();
  await webhook([event], deps);
  const retry = { ...event, attemptNumber: 9, subscriptionId: 2, eventId: 888 };
  assert.equal(eventKey(event), eventKey(retry));
  assert.equal((await webhook([retry], deps)).body.duplicates, 1);
  assert.equal(deps.messages.length, 1);
  assert.equal((await webhook([{ ...event, occurredAt: event.occurredAt + 60000, propertyValue: String(Number(event.propertyValue) + 60000) }], deps)).body.sent, 1);
  assert.equal(deps.messages.length, 2);
});

test('unsupported events, clears, and sample payloads are ignored', async () => {
  const values = [
    { ...event, propertyValue: 'sample-value' }, { ...event, propertyValue: '' },
    { ...event, propertyName: 'lastname' }, { ...event, subscriptionType: 'contact.creation' },
    { ...event, propertyName: 'demo_form_submission' },
    { ...event, portalId: 1 }, { ...event, appId: 2 }, { ...event, objectId: 0 },
  ];
  const deps = dependencies();
  const res = await webhook(values, deps);
  assert.equal(res.body.ignored, values.length);
  assert.equal(deps.messages.length, 0);
  assert.ok(isDemoEvent({ ...event, subscriptionType: 'object.propertyChange', objectTypeId: '0-1' }));
  assert.ok(!isDemoEvent({ ...event, subscriptionType: 'object.propertyChange', objectTypeId: '0-47' }));
});

test('invalid signatures and malformed batches are rejected before persistence', async () => {
  const deps = dependencies();
  assert.equal((await webhook([event], deps, { signature: 'invalid' })).status, 401);
  assert.equal((await webhook([event], deps, { signature: 'é'.repeat(64) })).status, 401);
  assert.equal((await webhook([event], deps, { version: 'v2' })).status, 401);
  assert.equal((await webhook(event, deps)).status, 400);
  assert.equal((await webhook([], deps, { raw: '{' })).status, 400);
  assert.equal((await webhook(Array(101).fill(event), deps)).status, 400);
  assert.equal((await webhook([], deps, { method: 'GET' })).status, 405);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM hubspot_demo_notifications')).rows[0].count, 0);
});

test('missing configuration fails closed instead of acknowledging lost notifications', async () => {
  for (const key of ['HUBSPOT_DEMO_SLACK_ENABLED', 'HUBSPOT_CLIENT_SECRET', 'SLACK_BOT_TOKEN', 'HUBSPOT_PRIVATE_TOKEN']) {
    assert.equal((await webhook([event], dependencies({ env: { ...env, [key]: '' } }))).status, 503);
  }
  assert.equal((await webhook([event], dependencies({ store: null }))).status, 503);
});

test('contact lookup failures return 503 and retry the same record successfully', async () => {
  const deps = dependencies({ async hubspotRequest() { throw new Error('Not found'); } });
  assert.equal((await webhook([event], deps)).status, 503);
  assert.equal(deps.messages.length, 0);
  assert.equal((await store.get(eventKey(event))).status, 'pending');
  assert.equal((await webhook([event], dependencies())).body.sent, 1);
});

test('Slack rejection can retry; ambiguous transport errors require reconciliation', async () => {
  const rejection = dependencies({ async fetchImpl() { return Response.json({ ok: false, error: 'not_in_channel' }); } });
  assert.equal((await webhook([event], rejection)).status, 503);
  const failure = dependencies({ async fetchImpl() { throw new TypeError('connection interrupted'); } });
  assert.equal((await webhook([event], failure)).body.needsReview, 1);
  const replay = dependencies();
  assert.equal((await webhook([event], replay)).body.needsReview, 1);
  assert.equal(replay.messages.length, 0);
  assert.equal((await store.get(eventKey(event))).status, 'needs_review');
});

test('concurrent claims allow only one sender; stale pre-send claims are fenced', async () => {
  const key = await store.record(event);
  const claims = await Promise.all([store.claim(key), store.claim(key)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const original = claims.find(Boolean);
  await db.exec("UPDATE hubspot_demo_notifications SET updated_at = NOW() - INTERVAL '3 minutes'");
  const replacement = await store.claim(key);
  assert.notEqual(original.claim_token, replacement.claim_token);
  await assert.rejects(store.save(original, { status: 'processing', phase: 'sending' }), /claim_lost/);
});

test('stale in-flight sends are quarantined rather than resent', async () => {
  const key = await store.record(event);
  const claim = await store.claim(key);
  await store.save(claim, { status: 'processing', phase: 'sending' });
  await db.exec("UPDATE hubspot_demo_notifications SET updated_at = NOW() - INTERVAL '3 minutes'");
  const deps = dependencies();
  assert.equal(await processEvent(event, deps), 'needs_review');
  assert.equal(deps.messages.length, 0);
});

test('user text cannot inject mentions, blank dates stay blank, and dates use Eastern time', () => {
  const message = buildMessage({ ...contact, properties: { ...contact.properties, firstname: '<@OTHER>', erp: '<!channel> & ERP', createdate: '2026-10-14T01:00:00Z' } });
  assert.ok(message.text.includes('&lt;@OTHER&gt;'));
  assert.ok(message.text.includes('&lt;!channel&gt; &amp; ERP'));
  assert.ok(message.text.endsWith('- Date Created: 10/13/26'));
  assert.ok(buildMessage({ ...contact, properties: { ...contact.properties, createdate: null } }).text.endsWith('- Date Created: '));
  assert.throws(() => buildMessage({ ...contact, id: '123/other' }), /invalid_contact_id/);
});

test('future submissions notify the deal owner after reconciliation and persist routing context', async () => {
  const routing = { status: 'existing_deal', contactId: '123', companyId: '20', dealId: '30',
    ownerId: '40', ownerName: 'Deal Owner', slackUserId: 'UOWNER', calendlyUrl: 'https://calendly.com/owner/intro' };
  let alignments = 0;
  const deps = dependencies({
    env: { ...env, DEMO_ROUTING_ENABLED: 'true', DEMO_ROUTING_ACTIVATED_AT: '2026-10-13T00:00:00Z' },
    demoRouter: { async alignContact(input) {
      assert.equal(input.contactId, '123'); alignments++; return routing;
    } },
  });
  assert.equal((await webhook([event], deps)).body.sent, 1);
  assert.equal(alignments, 2);
  assert.ok(deps.messages[0].text.startsWith('<@UOWNER>\nDEMO Submission — existing opportunity'));
  assert.ok(deps.messages[0].text.includes('/record/0-3/30'));
  assert.ok(!deps.messages[0].text.includes('<@U0ABULY5TEK>'));
  assert.deepEqual((await store.get(eventKey(event))).routing, routing);
  assert.equal((await webhook([event], deps)).body.duplicates, 1);
});

test('historical submissions bypass ownership correction even when routing is enabled', async () => {
  const deps = dependencies({ env: { ...env, DEMO_ROUTING_ENABLED: 'true', DEMO_ROUTING_ACTIVATED_AT: '2026-10-22T00:00:00Z' },
    demoRouter: { async alignContact() { throw new Error('must not modify historical contacts'); } } });
  assert.equal((await webhook([event], deps)).body.sent, 1);
  assert.ok(deps.messages[0].text.startsWith('<@U0ABULY5TEK>'));
});

test('matched submission without an owner Slack mapping retries instead of using the fixed recipient', async () => {
  const route = { status: 'existing_deal', contactId: '123', dealId: '30', ownerId: '40', slackUserId: null };
  const deps = dependencies({ env: { ...env, DEMO_ROUTING_ENABLED: 'true', DEMO_ROUTING_ACTIVATED_AT: '2026-10-13T00:00:00Z' },
    demoRouter: { async alignContact() { return route; } } });
  assert.equal((await webhook([event], deps)).status, 503);
  assert.equal(deps.messages.length, 0);
  assert.equal((await store.get(eventKey(event))).status, 'pending');
  route.slackUserId = 'UOWNER';
  assert.equal((await webhook([event], deps)).body.sent, 1);
  assert.ok(deps.messages[0].text.startsWith('<@UOWNER>'));
});

test('routing failure retries before notifying instead of distributing a new lead', async () => {
  const deps = dependencies({ env: { ...env, DEMO_ROUTING_ENABLED: 'true', DEMO_ROUTING_ACTIVATED_AT: '2026-10-13T00:00:00Z' },
    demoRouter: { async alignContact() { return { status: 'unresolved', reason: 'hubspot_lookup_failed' }; } } });
  assert.equal((await webhook([event], deps)).status, 503);
  assert.equal(deps.messages.length, 0);
  assert.equal((await store.get(eventKey(event))).status, 'pending');
});

test('pending routing notifications recover after provider retries stop, without historical replay', async () => {
  const deps = dependencies({ env: { ...env, DEMO_ROUTING_ENABLED: 'true', DEMO_ROUTING_ACTIVATED_AT: '2026-10-13T00:00:00Z' },
    demoRouter: { async alignContact() { return { status: 'no_open_deal' }; } } });
  await store.record(event);
  const historical = { ...event, occurredAt: 1, propertyValue: '1' };
  await store.record(historical);
  await db.exec("UPDATE hubspot_demo_notifications SET updated_at = NOW() - INTERVAL '1 minute'");
  await recoverDemoNotifications(deps);
  assert.equal(deps.messages.length, 1);
  assert.equal((await store.get(eventKey(event))).status, 'completed');
  assert.equal((await store.get(eventKey(historical))).status, 'pending');
});
