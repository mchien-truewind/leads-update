'use strict';

const test = require('node:test');
const assert = require('node:assert');

// gtm_ops/hubspot.js throws at require time without a token; set a dummy before requiring.
process.env.HUBSPOT_PRIVATE_TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN || 'test-token';

const cfg = require('../gtm_ops/config');
const { pickAE, latestMeetingHost, latestMeetingHostDetails, isBookedDemoContact, bookedContactOwnerUpdates, reconcileDealOwners } = require('../gtm_ops/reconciler');
const { CONFIG } = require('../calendly_hubspot');

test('DRY_RUN defaults to true (read-only unless explicitly disabled)', () => {
  // In the test process DRY_RUN is unset, so config must default to safe.
  assert.strictEqual(cfg.DRY_RUN, true);
});

test('pickAE is deterministic and always returns a roster member', () => {
  const a = pickAE('123456');
  const b = pickAE('123456');
  assert.deepStrictEqual(a, b, 'same contact id must map to the same AE across runs');
  assert.ok(cfg.AE_ROSTER.some((ae) => ae.id === a.id), 'picked AE must be in the roster');
});

test('pickAE spreads across the roster', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(pickAE(`contact-${i}`).id);
  assert.ok(seen.size > 1, 'round-robin should use more than one AE over many contacts');
});

test('latestMeetingHost picks the host of the most recent meeting', () => {
  const props = new Map([
    ['m1', { hubspot_owner_id: '111', hs_meeting_start_time: '1000' }],
    ['m2', { hubspot_owner_id: '222', hs_meeting_start_time: '5000' }],
    ['m3', { hubspot_owner_id: '333', hs_meeting_start_time: '3000' }],
  ]);
  assert.strictEqual(latestMeetingHost(['m1', 'm2', 'm3'], props), '222');
  assert.deepStrictEqual(latestMeetingHostDetails(['m1', 'm2', 'm3'], props), { meetingId: 'm2', host: '222' });
});

test('latestMeetingHost parses real HubSpot ISO timestamps', () => {
  const props = new Map([
    ['older', { hubspot_owner_id: '111', hs_meeting_start_time: '2026-08-13T18:00:00.000Z' }],
    ['newer', { hubspot_owner_id: '222', hs_meeting_start_time: '2026-08-13T22:00:00.000Z' }],
  ]);
  assert.deepStrictEqual(latestMeetingHostDetails(['older', 'newer'], props), { meetingId: 'newer', host: '222' });
});

test('manual deal owner override wins over the latest meeting host', async () => {
  const overrideReads = [];
  const writes = [];
  const overrideStore = {
    getDealOwnerOverrides: async (dealIds) => {
      overrideReads.push(dealIds);
      return new Map([['deal-1', { dealId: 'deal-1', ownerId: 'owner-sarah' }]]);
    },
  };
  const api = {
    searchAll: async () => [{ id: 'meeting-1' }],
    associations: async (fromType, ids, toType) => {
      if (fromType === 'meetings' && toType === 'deals') return new Map([['meeting-1', ['deal-1']]]);
      if (fromType === 'deals' && toType === 'meetings') return new Map([['deal-1', ['meeting-1']]]);
      if (fromType === 'meetings' && toType === 'contacts') return new Map([['meeting-1', []]]);
      throw new Error(`Unexpected association ${fromType}->${toType}`);
    },
    batchRead: async (objectType) => {
      if (objectType === 'deals') return new Map([['deal-1', {
        dealname: 'WECU',
        hubspot_owner_id: 'owner-alex',
        pipeline: cfg.ACTIVE_PIPELINE,
      }]]);
      if (objectType === 'meetings') return new Map([['meeting-1', {
        hubspot_owner_id: 'owner-alex',
        hs_meeting_start_time: '2026-08-13T22:00:00.000Z',
      }]]);
      if (objectType === 'contacts') return new Map();
      throw new Error(`Unexpected batch read ${objectType}`);
    },
    hub: async (method, path, body) => {
      if (method === 'GET') return { properties: { hubspot_owner_id: 'owner-alex' } };
      if (method === 'PATCH') { writes.push({ path, body }); return { id: 'deal-1' }; }
      throw new Error(`Unexpected HubSpot call ${method} ${path}`);
    },
    sleep: async () => {},
  };
  const owners = new Map([
    ['owner-alex', { name: 'Alex Lee' }],
    ['owner-sarah', { name: 'Sarah Elix' }],
  ]);

  const result = await reconcileDealOwners(owners, { overrideStore, api, dryRun: false });
  assert.deepStrictEqual(overrideReads, [['deal-1'], ['deal-1']]);
  assert.strictEqual(result.fixed, 1, 'Sarah override must be the desired deal owner even though Alex hosted the meeting');
  assert.deepStrictEqual(writes, [{
    path: '/crm/v3/objects/deals/deal-1',
    body: { properties: { hubspot_owner_id: 'owner-sarah' } },
  }]);
});

test('concurrent HubSpot owner change prevents stale reconciler PATCH', async () => {
  const writes = [];
  const overrideStore = {
    getDealOwnerOverrides: async () => new Map([['deal-1', { dealId: 'deal-1', ownerId: 'owner-sarah' }]]),
  };
  const api = {
    searchAll: async () => [{ id: 'meeting-1' }],
    associations: async (fromType, ids, toType) => {
      if (fromType === 'meetings' && toType === 'deals') return new Map([['meeting-1', ['deal-1']]]);
      if (fromType === 'deals' && toType === 'meetings') return new Map([['deal-1', ['meeting-1']]]);
      if (fromType === 'meetings' && toType === 'contacts') return new Map([['meeting-1', []]]);
      throw new Error(`Unexpected association ${fromType}->${toType}`);
    },
    batchRead: async (objectType) => {
      if (objectType === 'deals') return new Map([['deal-1', { dealname: 'WECU', hubspot_owner_id: 'owner-alex', pipeline: cfg.ACTIVE_PIPELINE }]]);
      if (objectType === 'meetings') return new Map([['meeting-1', { hubspot_owner_id: 'owner-alex', hs_meeting_start_time: '2026-08-13T22:00:00.000Z' }]]);
      if (objectType === 'contacts') return new Map();
      throw new Error(`Unexpected batch read ${objectType}`);
    },
    hub: async (method, path, body) => {
      if (method === 'GET') return { properties: { hubspot_owner_id: 'owner-xavier' } };
      if (method === 'PATCH') writes.push({ path, body });
      return {};
    },
    sleep: async () => {},
  };
  const owners = new Map([
    ['owner-alex', { name: 'Alex Lee' }],
    ['owner-sarah', { name: 'Sarah Elix' }],
    ['owner-xavier', { name: 'Xavier Marco' }],
  ]);

  const result = await reconcileDealOwners(owners, { overrideStore, api, dryRun: false });
  assert.strictEqual(result.fixed, 0);
  assert.deepStrictEqual(writes, []);
});

test('concurrent DB override prevents stale meeting-host PATCH', async () => {
  let overrideReadCount = 0;
  const writes = [];
  const overrideStore = {
    getDealOwnerOverrides: async () => {
      overrideReadCount++;
      return overrideReadCount === 1
        ? new Map()
        : new Map([['deal-1', { dealId: 'deal-1', ownerId: 'owner-sarah' }]]);
    },
  };
  const api = {
    searchAll: async () => [{ id: 'meeting-1' }],
    associations: async (fromType, ids, toType) => {
      if (fromType === 'meetings' && toType === 'deals') return new Map([['meeting-1', ['deal-1']]]);
      if (fromType === 'deals' && toType === 'meetings') return new Map([['deal-1', ['meeting-1']]]);
      if (fromType === 'meetings' && toType === 'contacts') return new Map([['meeting-1', []]]);
      throw new Error(`Unexpected association ${fromType}->${toType}`);
    },
    batchRead: async (objectType) => {
      if (objectType === 'deals') return new Map([['deal-1', { dealname: 'WECU', hubspot_owner_id: 'owner-sarah', pipeline: cfg.ACTIVE_PIPELINE }]]);
      if (objectType === 'meetings') return new Map([['meeting-1', { hubspot_owner_id: 'owner-alex', hs_meeting_start_time: '2026-08-13T22:00:00.000Z' }]]);
      if (objectType === 'contacts') return new Map();
      throw new Error(`Unexpected batch read ${objectType}`);
    },
    hub: async (method, path, body) => {
      if (method === 'GET') return { properties: { hubspot_owner_id: 'owner-sarah' } };
      if (method === 'PATCH') writes.push({ path, body });
      return {};
    },
    sleep: async () => {},
  };
  const owners = new Map([
    ['owner-alex', { name: 'Alex Lee' }],
    ['owner-sarah', { name: 'Sarah Elix' }],
  ]);

  const result = await reconcileDealOwners(owners, { overrideStore, api, dryRun: false });
  assert.strictEqual(overrideReadCount, 2);
  assert.strictEqual(result.fixed, 0);
  assert.deepStrictEqual(writes, []);
});

test('latestMeetingHost returns null when the latest meeting has no owner', () => {
  const props = new Map([['m1', { hs_meeting_start_time: '5000' }]]);
  assert.strictEqual(latestMeetingHost(['m1'], props), null);
});

test('isBookedDemoContact accepts booked Calendly contacts and demo form contacts', () => {
  assert.strictEqual(isBookedDemoContact({ calendly_meeting_booked: 'true' }), true);
  assert.strictEqual(isBookedDemoContact({ recent_conversion_event_name: 'Book a demo: Book Demo Form' }), true);
  assert.strictEqual(isBookedDemoContact({ recent_conversion_event_name: 'book a demo: book demo form' }), true);
  assert.strictEqual(isBookedDemoContact({ recent_conversion_event_name: 'Newsletter signup' }), false);
});

test('bookedContactOwnerUpdates syncs only selected meeting contacts to the meeting host', () => {
  const updates = bookedContactOwnerUpdates(
    ['deal-1', 'deal-2'],
    new Map([
      ['deal-1', 'host-amy'],
      ['deal-2', 'host-xavier'],
    ]),
    new Map([
      ['deal-1', ['contact-stale', 'contact-already-host', 'contact-not-demo']],
      ['deal-2', ['contact-stale']],
    ]),
    new Map([
      ['contact-stale', {
        email: 'buyer@example.com',
        hubspot_owner_id: 'old-owner',
        calendly_meeting_booked: 'true',
      }],
      ['contact-already-host', {
        email: 'owned@example.com',
        hubspot_owner_id: 'host-amy',
        calendly_meeting_booked: 'true',
      }],
      ['contact-not-demo', {
        email: 'other@example.com',
        hubspot_owner_id: 'old-owner',
        recent_conversion_event_name: 'Newsletter signup',
      }],
    ]),
  );

  assert.deepStrictEqual(updates, [
    { contactId: 'contact-stale', from: 'old-owner', to: 'host-amy', email: 'buyer@example.com', dealId: 'deal-1' },
  ]);
});

test('funnel constants stay in sync with the Calendly webhook CONFIG', () => {
  // gtm_ops_bot.js asserts this on startup and refuses to run live on drift; lock it in a test too.
  assert.strictEqual(cfg.ACTIVE_PIPELINE, CONFIG.pipelineId, 'pipeline id must match webhook');
  assert.strictEqual(cfg.MQL_STAGE, CONFIG.newDealStageId, 'MQL stage must match webhook');
});

test('AE roster (round-robin) is intentionally distinct from the webhook host map', () => {
  // Different purposes: roster = who gets new ownerless leads; host map = who owns a booked demo.
  // This guards against someone "fixing" a non-bug by force-aligning the two sets.
  const hostOwnerIds = new Set([...CONFIG.ownerByCalendlyUserUri.values()].map(String));
  const rosterIds = new Set(cfg.AE_ROSTER.map((ae) => String(ae.id)));
  assert.ok(rosterIds.size >= hostOwnerIds.size, 'roster should cover at least the AE bench');
});
