const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const { handleInviteeCreated, handleInviteeCanceled, CONFIG } = require('../calendly_hubspot');

const payload = { email: 'fixture@gmail.com', name: 'Fixture Lead', uri: 'https://api.calendly.com/scheduled_events/event/invitees/invitee', event: 'https://api.calendly.com/scheduled_events/event' };
const event = { name: 'Demo', start_time: '2026-11-01T12:00:00Z', end_time: '2026-11-01T12:30:00Z' };
const filter = { ownerId: '89305622', hostUserUri: '', eventTypeUri: 'type' };

function mockHubspot(t, { managed = true, cancellation = false, associationError = false } = {}) {
  const calls = [];
  const oldToken = process.env.HUBSPOT_PRIVATE_TOKEN;
  process.env.HUBSPOT_PRIVATE_TOKEN = 'fixture-only-token';
  t.after(() => { if (oldToken === undefined) delete process.env.HUBSPOT_PRIVATE_TOKEN; else process.env.HUBSPOT_PRIVATE_TOKEN = oldToken; });
  const existingDeal = { id: '20', properties: { pipeline: CONFIG.pipelineId, dealstage: CONFIG.newDealStageId,
    hubspot_owner_id: '84547076', hs_lastmodifieddate: '2026-10-30T00:00:00Z' } };
  t.mock.method(https, 'request', (url, options, callback) => {
    const req = new EventEmitter();
    let body;
    req.setTimeout = () => req;
    req.write = data => { body = JSON.parse(data); };
    req.end = () => queueMicrotask(() => {
      const path = new URL(url).pathname;
      calls.push({ path, method: options.method, body });
      let response = {};
      if (path.endsWith('/contacts/search')) response = { results: [{ id: '1', properties: { email: payload.email, hubspot_owner_id: '84547076' } }] };
      else if (path.endsWith('/deals/search')) response = { results: cancellation ? [existingDeal] : [] };
      else if (path.endsWith('/meetings/search')) response = { results: cancellation ? [{ id: '30' }] : [] };
      else if (path === '/crm/v4/objects/contacts/1/associations/deals') response = { results: [{ toObjectId: '20' }] };
      else if (path === '/crm/v4/objects/contacts/1/associations/companies') response = { results: [] };
      else if (path.startsWith('/crm/v3/pipelines/deals/')) response = { stages: [{ id: CONFIG.newDealStageId, metadata: { isClosed: 'false' } }] };
      else if (path.endsWith('/deals/batch/read')) response = { results: [existingDeal] };
      else if (path === '/crm/v3/objects/meetings' && options.method === 'POST') response = { id: '30' };
      else if (path === '/crm/v3/objects/deals' && options.method === 'POST') response = { id: '21' };
      else if (!['PUT', 'PATCH'].includes(options.method)) {
        req.emit('error', new Error(`Unexpected request ${path}`)); return;
      }
      const res = new EventEmitter();
      res.statusCode = associationError && path.endsWith('/associations/deals') ? 503 : 200;
      callback(res);
      res.emit('data', JSON.stringify(response)); res.emit('end');
    });
    return req;
  });
  return { calls, options: { suppressSubmissionAlert: true, demoLifecycle: {
    requestDeals: managed, hasRequestDeal: async () => managed,
    async ensureDealForBooking(id) {
      assert.equal(id, '1');
      if (associationError) throw new Error('HubSpot failed 503');
      return structuredClone(existingDeal);
    },
  } } };
}

test('later booking attaches its meeting to the form deal, preserves its owner and creates no new deal', async t => {
  const f = mockHubspot(t);
  const result = await handleInviteeCreated(payload, event, filter, f.options);
  assert.equal(result.dealId, '20');
  assert.ok(!f.calls.some(c => c.method === 'POST' && c.path === '/crm/v3/objects/deals'));
  assert.ok(f.calls.some(c => c.path === '/crm/v4/objects/meetings/30/associations/default/deals/20'));
  const update = f.calls.find(c => c.path === '/crm/v3/objects/deals/20');
  assert.equal(update.body.properties.calendly_invitee_uri, payload.uri);
  assert.equal(update.body.properties.hubspot_owner_id, undefined);
  assert.equal(update.body.properties.dealstage, undefined);
});

test('failed existing-deal lookup retries instead of creating a duplicate', async t => {
  const f = mockHubspot(t, { associationError: true });
  await assert.rejects(handleInviteeCreated(payload, event, filter, f.options), /503/);
  assert.ok(!f.calls.some(c => c.method === 'POST' && c.path === '/crm/v3/objects/deals'));
});

test('unmanaged Calendly bookings retain the existing create behavior', async t => {
  const f = mockHubspot(t, { managed: false });
  assert.equal((await handleInviteeCreated(payload, event, filter, f.options)).dealId, '21');
  assert.ok(f.calls.some(c => c.method === 'POST' && c.path === '/crm/v3/objects/deals'));
});

test('cancellation updates the meeting and preserves the demo request opportunity', async t => {
  const f = mockHubspot(t, { cancellation: true });
  const result = await handleInviteeCanceled(payload, event, filter, f.options);
  assert.equal(result.action, 'canceled_meeting_preserved_demo_deal');
  assert.ok(!f.calls.some(c => c.path === '/crm/v3/objects/deals/20' && c.method === 'PATCH'));
  assert.ok(f.calls.some(c => c.path === '/crm/v3/objects/meetings/30' && c.body.properties.hs_meeting_outcome === 'CANCELED'));
});

test('unmanaged cancellation retains the existing close-lost behavior', async t => {
  const f = mockHubspot(t, { cancellation: true, managed: false });
  const result = await handleInviteeCanceled(payload, event, filter, f.options);
  assert.equal(result.action, 'closed_lost_no_show');
  assert.ok(f.calls.some(c => c.path === '/crm/v3/objects/deals/20' && c.body.properties.dealstage === CONFIG.closedLostStageId));
});
