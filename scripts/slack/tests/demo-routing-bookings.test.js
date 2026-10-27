const assert = require('node:assert/strict');
const { test, before, after, beforeEach } = require('node:test');
const { PGlite } = require('@electric-sql/pglite');
const { DemoBookingStore } = require('../demo-booking-store');
const { routeBooking } = require('../demo-routing-bookings');
const { createDemoRouter } = require('../demo-routing');

let db;
let store;
before(async () => {
  db = new PGlite();
  store = new DemoBookingStore({ async query(text, values) {
    const r = await db.query(text, values);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  } });
  await store.initialize();
});
beforeEach(async () => { await db.exec('TRUNCATE demo_booking_links'); });
after(async () => { await db.close(); });

function fixture({ status = 'existing_deal', ownerId = '40' } = {}) {
  const writes = [];
  const meetings = new Map();
  const alerts = [];
  const route = { status, dealId: '30', companyId: '20', contactId: '10', ownerId, slackUserId: 'UOWNER', ownerName: 'Deal Owner' };
  const router = {
    env: { DEMO_ROUTING_ENABLED: 'true', DEMO_ROUTING_ACTIVATED_AT: '2026-10-22T00:00:00Z' },
    async resolve() { return route; }, async alignContact() { return route; },
  };
  const payload = { email: 'person@bessemer.com', uri: 'https://api.calendly.com/scheduled_events/event/invitees/one',
    event: 'https://api.calendly.com/scheduled_events/event', created_at: '2026-10-23T00:00:00Z' };
  const api = {
    getInviteeUri: p => p.uri, getScheduledEventUri: p => p.event, getOldInviteeUri: p => p.old_invitee || '', isRescheduled: p => Boolean(p.rescheduled),
    getOrganizerName: () => 'Actual Host',
    async findContactByEmail() { return { id: '10' }; },
    async ensureContact(input) { writes.push({ kind: 'contact', ...input }); return { id: '10' }; },
    async findDealByCalendlyIdentifiers() { return null; },
    async findMeetingByCalendlyIdentifiers({ inviteeUri }) { return meetings.get(inviteeUri); },
    async createMeeting(input) {
      writes.push({ kind: 'meeting', ...input });
      const meeting = { id: String(100 + meetings.size) }; meetings.set(input.payload.uri, meeting); return meeting;
    },
    async associate(...args) { writes.push({ kind: 'association', args }); },
    async request(path, options) { writes.push({ path, ...options }); return {}; },
    async postBookedDemoSlackAlert(input) { alerts.push(input); return { ts: '1' }; },
  };
  const input = { eventName: 'invitee.created', payload, scheduledEvent: {},
    filter: { ownerId: '99', hostUserUri: 'https://api.calendly.com/users/other', eventTypeUri: 'https://api.calendly.com/event_types/intro' },
    options: { demoRouter: router, demoBookingStore: store }, api };
  return { input, writes, meetings, alerts, router, route };
}

test('general-calendar booking preserves the deal owner while recording the actual host', async () => {
  const f = fixture();
  const result = await routeBooking(f.input);
  assert.equal(result.dealId, '30');
  assert.equal(f.writes.find(w => w.kind === 'contact').ownerId, '40');
  assert.equal(f.writes.find(w => w.kind === 'meeting').ownerId, '99');
  assert.equal(f.alerts[0].ownerId, '40');
  assert.equal(f.alerts[0].ownerSlackUserByHubSpotOwnerId['40'], 'UOWNER');
  assert.equal(f.writes.filter(w => w.path?.includes('/deals/')).length, 0);
  assert.equal((await store.get(f.input.payload.uri)).reused_existing_deal, true);
});

test('duplicate delivery creates one meeting and sends one notification', async () => {
  const f = fixture();
  await routeBooking(f.input);
  await routeBooking(f.input);
  assert.equal(f.meetings.size, 1);
  assert.equal(f.alerts.length, 1);
});

test('multiple bookings and reschedules retain distinct identities on the same opportunity', async () => {
  const f = fixture();
  const first = await routeBooking(f.input);
  const secondPayload = { ...f.input.payload, uri: `${f.input.payload.uri}-two` };
  const second = await routeBooking({ ...f.input, payload: secondPayload });
  const rescheduled = await routeBooking({ ...f.input, payload: { ...secondPayload, uri: `${secondPayload.uri}-new`, old_invitee: secondPayload.uri, rescheduled: true } });
  assert.equal(first.dealId, second.dealId);
  assert.equal(second.dealId, rescheduled.dealId);
  assert.notEqual(first.meetingId, second.meetingId);
  assert.notEqual(second.meetingId, rescheduled.meetingId);
  assert.equal(f.alerts.length, 2);
  assert.ok(f.writes.some(w => w.path === `/crm/v3/objects/meetings/${second.meetingId}` && w.body.properties.hs_meeting_outcome === 'RESCHEDULED'));
  assert.equal(f.writes.filter(w => w.path?.includes('/deals/')).length, 0);
});

test('cancellation of a reused deal updates only its meeting, including after disabling the flag', async () => {
  const f = fixture();
  const created = await routeBooking(f.input);
  f.router.env.DEMO_ROUTING_ENABLED = 'false';
  const canceled = await routeBooking({ ...f.input, eventName: 'invitee.canceled' });
  assert.equal(canceled.dealId, '30');
  const updates = f.writes.filter(w => w.path);
  assert.deepEqual(updates.map(w => w.path), [`/crm/v3/objects/meetings/${created.meetingId}`]);
  assert.equal(updates[0].body.properties.hs_meeting_outcome, 'CANCELED');
  assert.equal((await routeBooking(f.input)).action, 'ignored_canceled_booking');
});

test('cancel-before-create leaves a tombstone so a delayed creation cannot revive a meeting', async () => {
  const f = fixture();
  await routeBooking({ ...f.input, eventName: 'invitee.canceled' });
  assert.equal((await routeBooking(f.input)).action, 'ignored_canceled_booking');
  assert.equal(f.meetings.size, 0);
});

test('unresolved lookups block new-deal creation; verified no-open-deal permits legacy behavior', async () => {
  const f = fixture({ status: 'unresolved' });
  await assert.rejects(routeBooking(f.input), /routing_unresolved/);
  assert.equal(f.writes.length, 0);
  f.route.status = 'no_open_deal';
  assert.equal(await routeBooking(f.input), null);
});

test('historical events bypass new routing, and an existing booking is pinned across retries', async () => {
  const f = fixture();
  assert.equal(await routeBooking({ ...f.input, payload: { ...f.input.payload, created_at: '2026-10-21T00:00:00Z' } }), null);
  await routeBooking(f.input);
  f.router.resolve = async input => { assert.equal(input.dealId, '30'); return f.route; };
  await routeBooking(f.input);
});

test('partial meeting creation is recovered by identifiers and ambiguous Slack sends are not repeated', async () => {
  const f = fixture();
  let fail = true;
  f.input.api.postBookedDemoSlackAlert = async () => { if (fail) { fail = false; throw new Error('connection lost'); } f.alerts.push('sent'); };
  await assert.rejects(routeBooking(f.input), /connection lost/);
  await routeBooking(f.input);
  assert.equal(f.meetings.size, 1);
  assert.equal(f.alerts.length, 0);
  assert.equal((await store.get(f.input.payload.uri)).notification_state, 'needs_review');
});

test('new-lead booking cancellations keep their existing behavior', async () => {
  const f = fixture();
  await store.put({ inviteeUri: f.input.payload.uri, eventUri: f.input.payload.event,
    contactId: '10', dealId: '31', meetingId: '101', reusedExistingDeal: false });
  assert.equal(await routeBooking({ ...f.input, eventName: 'invitee.canceled' }), null);
});

test('booking identity cannot be overwritten by a later selection', async () => {
  const f = fixture();
  await routeBooking(f.input);
  await assert.rejects(store.put({ inviteeUri: f.input.payload.uri, eventUri: f.input.payload.event,
    contactId: '10', dealId: '31', reusedExistingDeal: true }), /booking_link_conflict/);
});

test('provider deal identifiers win before account resolution when local linkage is absent', async () => {
  for (const rescheduled of [false, true]) {
    const f = fixture();
    if (rescheduled) f.input.payload.old_invitee = 'https://api.calendly.com/scheduled_events/old/invitees/old';
    f.input.api.findDealByCalendlyIdentifiers = async input => {
      assert.equal(input.inviteeUri, rescheduled ? f.input.payload.old_invitee : f.input.payload.uri);
      return { id: '31' };
    };
    f.router.resolve = async () => { throw new Error('must preserve identifier match'); };
    for (const eventName of ['invitee.created', 'invitee.canceled']) {
      assert.equal(await routeBooking({ ...f.input, eventName }), null);
      assert.equal(await store.get(f.input.payload.uri), null);
    }
    assert.equal(f.writes.length, 0);
  }
});

test('missing owner notification mapping stays pending and never sends to another recipient', async () => {
  const f = fixture();
  f.route.slackUserId = null;
  await assert.rejects(routeBooking(f.input), /notification_mapping_missing/);
  assert.equal(f.alerts.length, 0);
  assert.equal((await store.get(f.input.payload.uri)).notification_state, 'pending');
  f.route.slackUserId = 'UOWNER';
  await routeBooking(f.input);
  assert.equal(f.meetings.size, 1);
  assert.equal(f.alerts.length, 1);
});

test('rescheduling a closed linked opportunity records one replacement meeting and preserves the deal', async () => {
  const f = fixture();
  const deal = { id: '30', archived: false, properties: { pipeline: '105321581', dealstage: 'open',
    hubspot_owner_id: '40', hs_lastmodifieddate: '2026-10-23T00:00:00Z' } };
  const contact = { id: '10', properties: { email: f.input.payload.email, hubspot_owner_id: '40' } };
  const crmWrites = [];
  f.input.options.demoRouter = createDemoRouter({
    env: { ...f.router.env, DEMO_ROUTING_OWNERS_JSON: JSON.stringify([{ ownerId: '40', slackUserId: 'UOWNER',
      calendlyUrl: 'https://calendly.com/deal-owner/intro', hostUris: ['https://api.calendly.com/users/owner'],
      eventTypeUris: ['https://api.calendly.com/event_types/intro'] }]) },
    request: async (path, options = {}) => {
      if (options.method === 'PUT' || options.method === 'PATCH') { crmWrites.push({ path, ...options }); return {}; }
      if (path.endsWith('/contacts/search')) return { results: [contact] };
      if (path.includes('/contacts/10/associations/companies')) return { results: [{ toObjectId: '20' }] };
      if (path.includes('/associations/deals')) return { results: [{ toObjectId: '30' }] };
      if (path.includes('/pipelines/')) return { stages: [{ id: 'open', metadata: { isClosed: false } }, { id: 'won', metadata: { isClosed: true } }] };
      if (path.endsWith('/deals/batch/read')) return { results: [structuredClone(deal)] };
      if (path.includes('/objects/deals/30?')) return structuredClone(deal);
      if (path.includes('/objects/contacts/10?')) return contact;
      if (path.includes('/owners/40')) return { id: '40', archived: false, firstName: 'Deal', lastName: 'Owner' };
      throw new Error('unexpected CRM request');
    },
  });
  const first = await routeBooking(f.input);
  deal.properties.dealstage = 'won';
  deal.properties.pipeline = 'closed-pipeline';
  const payload = { ...f.input.payload, uri: `${f.input.payload.uri}-rescheduled`,
    old_invitee: f.input.payload.uri, rescheduled: true };
  const second = await routeBooking({ ...f.input, payload });
  const replay = await routeBooking({ ...f.input, payload });
  assert.equal(second.dealId, first.dealId);
  assert.notEqual(second.meetingId, first.meetingId);
  assert.equal(replay.meetingId, second.meetingId);
  assert.equal(f.meetings.size, 2);
  assert.equal(f.alerts.length, 1);
  assert.equal(deal.properties.dealstage, 'won');
  assert.equal(deal.properties.pipeline, 'closed-pipeline');
  assert.equal(deal.properties.hubspot_owner_id, '40');
  assert.ok(crmWrites.every(w => !w.path.startsWith('/crm/v3/objects/deals')));
  assert.ok(f.writes.some(w => w.path === `/crm/v3/objects/meetings/${first.meetingId}` && w.body.properties.hs_meeting_outcome === 'RESCHEDULED'));
  assert.equal((await store.get(payload.uri)).deal_id, '30');
});
