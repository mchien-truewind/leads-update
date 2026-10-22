const assert = require('node:assert/strict');
const { test } = require('node:test');
const { verifyOwnerRegistry } = require('../demo-routing-readiness');
const { DemoBookingStore } = require('../demo-booking-store');

function fixture() {
  const row = { ownerId: '40', slackUserId: 'UOWNER', calendlyUrl: 'https://calendly.com/owner/intro',
    hostUris: ['https://api.calendly.com/users/host'], eventTypeUris: ['https://api.calendly.com/event_types/intro'] };
  const state = { email: 'owner@example.com', calendarEmail: 'owner@example.com', slackEmail: 'owner@example.com',
    schedulingUrl: row.calendlyUrl, active: true, poolingType: null };
  const options = { registry: new Map([['40', row]]),
    async hubspotRequest() { return { id: '40', email: state.email, archived: false }; },
    async calendlyRequest(url) {
      if (url.includes('/event_types?')) return { collection: [{ uri: row.eventTypeUris[0], active: state.active, scheduling_url: state.schedulingUrl, pooling_type: state.poolingType }] };
      return { resource: { email: state.calendarEmail, current_organization: 'org' } };
    },
    slackClient: { users: { async info() { return { ok: true, user: { deleted: false, profile: { email: state.slackEmail } } }; } } },
  };
  return { options, state };
}

test('registry readiness verifies owner, Calendly, personal event, and Slack identities', async () => {
  await verifyOwnerRegistry(fixture().options);
  for (const field of ['calendarEmail', 'slackEmail', 'schedulingUrl']) {
    const f = fixture(); f.state[field] = 'mismatch';
    await assert.rejects(verifyOwnerRegistry(f.options), /mismatch|unverified/);
  }
  const inactive = fixture(); inactive.state.active = false;
  await assert.rejects(verifyOwnerRegistry(inactive.options), /unverified/);
  const pooled = fixture(); pooled.state.poolingType = 'round_robin';
  await assert.rejects(verifyOwnerRegistry(pooled.options), /unverified/);
});

test('calendar access failures prevent enabling the feature', async () => {
  const f = fixture(); f.options.calendlyRequest = async () => { throw new Error('403'); };
  await assert.rejects(verifyOwnerRegistry(f.options), /403/);
});

test('booking lock uses one pool client for lock, guarded work, and unlock', async () => {
  const calls = [];
  const client = { async query(sql) { calls.push(sql); return { rows: [] }; }, release() { calls.push('release'); } };
  const store = new DemoBookingStore({ async connect() { return client; }, async query() { throw new Error('must not acquire another pool connection'); } });
  await assert.rejects(store.withLock('invitee', async lockedStore => {
    await lockedStore.get('invitee');
    throw new Error('operation failed');
  }), /operation failed/);
  assert.ok(calls[0].includes('pg_advisory_lock'));
  assert.ok(calls[1].startsWith('SELECT * FROM demo_booking_links'));
  assert.ok(calls[2].includes('pg_advisory_unlock'));
  assert.equal(calls[3], 'release');
});
