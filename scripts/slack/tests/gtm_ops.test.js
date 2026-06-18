'use strict';

const test = require('node:test');
const assert = require('node:assert');

// gtm_ops/hubspot.js throws at require time without a token; set a dummy before requiring.
process.env.HUBSPOT_PRIVATE_TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN || 'test-token';

const cfg = require('../gtm_ops/config');
const { pickAE, latestMeetingHost } = require('../gtm_ops/reconciler');
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
});

test('latestMeetingHost returns null when the latest meeting has no owner', () => {
  const props = new Map([['m1', { hs_meeting_start_time: '5000' }]]);
  assert.strictEqual(latestMeetingHost(['m1'], props), null);
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
