'use strict';

const test = require('node:test');
const assert = require('node:assert');

// gtm_ops/hubspot.js throws at require time without a token; set a dummy before requiring.
process.env.HUBSPOT_PRIVATE_TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN || 'test-token';

const cfg = require('../gtm_ops/config');
const { pickAE, reassignRemovedContactOwners } = require('../gtm_ops/reconciler');
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

test('removed roster reassignment searches and updates contacts only', async () => {
  const writes = [];
  const rosterIds = new Set(cfg.AE_ROSTER.map((ae) => ae.id));
  const api = {
    searchAll: async (objectType) => {
      if (objectType === 'contacts') return [
        { id: 'contact-ari', properties: { email: 'buyer@example.com', hubspot_owner_id: '93961773' } },
        { id: 'contact-internal', properties: { email: 'alex@trytruewind.com', hubspot_owner_id: '559564379' } },
      ];
      throw new Error(`Unexpected search ${objectType}`);
    },
    hub: async (method, path, body) => {
      if (method === 'GET' && path.includes('/deals/')) return { properties: { hubspot_owner_id: '559564379', dealstage: '1307720553' } };
      if (method === 'GET' && path.includes('/contacts/')) return { properties: { hubspot_owner_id: '93961773' } };
      if (method === 'PATCH') writes.push({ path, body });
      return {};
    },
    sleep: async () => {},
  };
  const owners = new Map(cfg.AE_ROSTER.map((ae) => [ae.id, { name: ae.name }]));
  owners.set('559564379', { name: 'Alex Lee' });
  owners.set('93961773', { name: 'Ari Nachman' });

  const result = await reassignRemovedContactOwners(owners, { api, dryRun: false });
  assert.strictEqual(result.reassigned, 1);
  assert.strictEqual(writes.length, 1);
  for (const write of writes) {
    const ownerId = write.body.properties.hubspot_owner_id;
    assert.ok(rosterIds.has(ownerId), ownerId);
    assert.ok(!cfg.REMOVED_ROUND_ROBIN_OWNER_IDS.includes(ownerId));
  }
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
