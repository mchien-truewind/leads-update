const assert = require('assert');

const {
  DISQUALIFIED_REASONS,
  STATUS,
  buildContactUpdate,
  classifyLeadStatus,
  formatLeadStatusSyncSummary,
  includeTouchpointEngagement,
  runLeadStatusSync,
} = require('../lead_status_sync');

const TEST_CONFIG = {
  bdrOwnerIds: ['100'],
  bdrEmails: ['bdr@example.com'],
};

function contact(id, properties = {}) {
  return { id: String(id), properties };
}

function engagement(overrides = {}) {
  return {
    engagement: {
      type: 'EMAIL',
      timestamp: Date.parse('2026-05-20T12:00:00.000Z'),
      ownerId: '100',
      ...overrides.engagement,
    },
    metadata: {
      direction: 'OUTGOING',
      from: { email: 'bdr@example.com' },
      ...overrides.metadata,
    },
  };
}

function testTouchpointFiltering() {
  const sinceMs = Date.parse('2026-02-20T00:00:00.000Z');

  assert.strictEqual(includeTouchpointEngagement(engagement(), sinceMs, TEST_CONFIG), true);
  assert.strictEqual(
    includeTouchpointEngagement(
      engagement({ engagement: { type: 'TASK', ownerId: '100' }, metadata: {} }),
      sinceMs,
      TEST_CONFIG,
    ),
    true,
  );
  assert.strictEqual(
    includeTouchpointEngagement(engagement({ engagement: { type: 'NOTE' } }), sinceMs, TEST_CONFIG),
    false,
  );
  assert.strictEqual(
    includeTouchpointEngagement(engagement({ metadata: { direction: 'INBOUND' } }), sinceMs, TEST_CONFIG),
    false,
  );
  assert.strictEqual(
    includeTouchpointEngagement(engagement({ engagement: { ownerId: '999' }, metadata: { from: { email: 'other@example.com' } } }), sinceMs, TEST_CONFIG),
    false,
  );
}

function testLeadClassification() {
  assert.deepStrictEqual(
    classifyLeadStatus(contact(1, { hs_lead_status: '' }), 0),
    { targetStatus: STATUS.NEW, reason: 'blank_no_activity' },
  );
  assert.deepStrictEqual(
    classifyLeadStatus(contact(2, { hs_lead_status: STATUS.NEW }), 2),
    { targetStatus: STATUS.WORKING, reason: 'touchpoint_signal' },
  );
  assert.deepStrictEqual(
    classifyLeadStatus(contact(3, { hs_lead_status: STATUS.WORKING, hs_sales_email_last_replied: '2026-05-20T12:00:00Z' }), 3),
    { targetStatus: STATUS.NURTURING, reason: 'reply_signal' },
  );
  assert.deepStrictEqual(
    classifyLeadStatus(contact(4, { hs_lead_status: STATUS.WORKING, hs_email_optout: 'true' }), 1),
    {
      targetStatus: STATUS.DISQUALIFIED,
      disqualifiedReason: DISQUALIFIED_REASONS.NOT_INTERESTED,
      reason: 'disqualified_signal',
    },
  );
  assert.deepStrictEqual(
    classifyLeadStatus(contact(5, { hs_lead_status: STATUS.DISQUALIFIED }), 0),
    {
      targetStatus: STATUS.DISQUALIFIED,
      disqualifiedReason: DISQUALIFIED_REASONS.OTHER,
      reason: 'backfill_disqualified_reason',
    },
  );
  assert.deepStrictEqual(
    classifyLeadStatus(contact(6, { hs_lead_status: STATUS.CONVERTED, hs_email_optout: 'true' }), 1),
    { reason: 'protected' },
  );
  assert.deepStrictEqual(
    classifyLeadStatus(
      contact(7, {
        hs_lead_status: STATUS.CONVERTED,
        lifecyclestage: 'customer',
        disqualified_reasons: 'Not ICP',
      }),
      1,
      { nooksNotInterested: true },
    ),
    {
      targetStatus: STATUS.DISQUALIFIED,
      disqualifiedReason: DISQUALIFIED_REASONS.NOT_INTERESTED,
      reason: 'nooks_not_interested',
      forceDisqualifiedReason: true,
    },
  );
}

function testUpdateBuilderOnlyMovesForwardAndMaintainsTouchpoints() {
  assert.deepStrictEqual(
    buildContactUpdate(contact(1, { hs_lead_status: STATUS.NURTURING, bdr_touchpoints_90d: '1' }), STATUS.WORKING, '', 1, 1770000000000),
    {},
  );
  assert.deepStrictEqual(
    buildContactUpdate(contact(2, { hs_lead_status: STATUS.NEW, bdr_touchpoints_90d: '0' }), STATUS.WORKING, '', 3, 1770000000000),
    {
      hs_lead_status: STATUS.WORKING,
      bdr_touchpoints_90d: '3',
      bdr_touchpoints_90d_updated_at: '1770000000000',
    },
  );
  assert.deepStrictEqual(
    buildContactUpdate(
      contact(3, {
        hs_lead_status: STATUS.CONVERTED,
        disqualified_reasons: 'Not ICP',
        bdr_touchpoints_90d: '0',
      }),
      STATUS.DISQUALIFIED,
      DISQUALIFIED_REASONS.NOT_INTERESTED,
      0,
      1770000000000,
      { forceDisqualifiedReason: true },
    ),
    {
      hs_lead_status: STATUS.DISQUALIFIED,
      disqualified_reasons: DISQUALIFIED_REASONS.NOT_INTERESTED,
    },
  );
}

async function testIncrementalSyncUsesRecentCandidatesAndAllowedEngagements() {
  const updates = [];
  const slackPosts = [];
  const calls = [];

  async function hubspot(path, options = {}) {
    calls.push({ path, options });
    if (path.startsWith('/crm/v3/lists/694/memberships/join-order')) {
      return { results: [{ recordId: '1' }, { recordId: '2' }] };
    }
    if (path === '/crm/v3/objects/contacts/search') {
      const body = JSON.parse(options.body);
      const field = body.filterGroups[0].filters[0].propertyName;
      return field === 'hs_last_sales_activity_timestamp'
        ? { results: [{ id: '1' }, { id: '3' }] }
        : { results: [] };
    }
    if (path === '/crm/v3/objects/calls/search') {
      return { results: [] };
    }
    if (path === '/crm/v3/objects/contacts/batch/read') {
      return {
        results: [
          contact(1, {
            hs_lead_status: STATUS.NEW,
            bdr_touchpoints_90d: '0',
          }),
        ],
      };
    }
    if (path.startsWith('/engagements/v1/engagements/associated/CONTACT/1/paged')) {
      return {
        hasMore: false,
        results: [
          engagement({ engagement: { type: 'TASK', ownerId: '100' }, metadata: {} }),
          engagement({ engagement: { type: 'NOTE', ownerId: '100' }, metadata: {} }),
        ],
      };
    }
    if (path === '/crm/v3/objects/contacts/batch/update') {
      updates.push(...JSON.parse(options.body).inputs);
      return {};
    }
    throw new Error(`Unexpected HubSpot call: ${path}`);
  }

  const stats = await runLeadStatusSync({
    mode: 'incremental',
    listId: '694',
    now: new Date('2026-05-20T13:00:00.000Z'),
    lookbackHours: 28,
    touchpointDays: 90,
    bdrOwnerIds: ['100'],
    bdrEmails: ['bdr@example.com'],
    searchDelayMs: 0,
    generalDelayMs: 0,
    engagementConcurrency: 1,
    hubspot,
    postSlackMessage: async (text, channel) => slackPosts.push({ text, channel }),
    targetChannel: 'slack-testing',
    logger: { log() {} },
  });

  assert.strictEqual(stats.candidateCount, 1);
  assert.strictEqual(stats.listCandidateCount, 1);
  assert.strictEqual(stats.statusUpdates, 1);
  assert.strictEqual(stats.touchpointUpdates, 1);
  assert.strictEqual(updates.length, 1);
  assert.deepStrictEqual(updates[0].properties, {
    hs_lead_status: STATUS.WORKING,
    bdr_touchpoints_90d: '1',
    bdr_touchpoints_90d_updated_at: String(Date.parse('2026-05-20T13:00:00.000Z')),
  });
  assert.strictEqual(slackPosts[0].channel, 'slack-testing');
  assert.match(slackPosts[0].text, /Lead status sync complete \(incremental\)/);
  assert.ok(calls.some(call => call.path === '/crm/v3/objects/contacts/search'));
}

async function testIncrementalSyncUsesRecentNooksNotInterestedCalls() {
  const updates = [];

  async function hubspot(path, options = {}) {
    if (path.startsWith('/crm/v3/lists/694/memberships/join-order')) {
      return { results: [] };
    }
    if (path === '/crm/v3/objects/calls/search') {
      return {
        results: [
          {
            id: 'call-1',
            properties: {
              hs_call_title: '[Nooks Call] - Not interested - Example Person - by BDR',
              hs_call_disposition: '739e9efc-95d4-448d-9440-7a14287a02fa',
              hs_object_source_detail_1: 'Nooks',
              hubspot_owner_id: '100',
            },
          },
        ],
      };
    }
    if (path === '/crm/v4/associations/calls/contacts/batch/read') {
      return {
        results: [
          { from: { id: 'call-1' }, to: [{ toObjectId: '9' }] },
        ],
      };
    }
    if (path === '/crm/v3/objects/contacts/search') {
      return { results: [] };
    }
    if (path === '/crm/v3/objects/contacts/batch/read') {
      return {
        results: [
          contact(9, {
            hs_lead_status: STATUS.CONVERTED,
            lifecyclestage: 'customer',
            disqualified_reasons: 'Not ICP',
            bdr_touchpoints_90d: '0',
          }),
        ],
      };
    }
    if (path.startsWith('/engagements/v1/engagements/associated/CONTACT/9/paged')) {
      return { hasMore: false, results: [] };
    }
    if (path === '/crm/v3/objects/contacts/batch/update') {
      updates.push(...JSON.parse(options.body).inputs);
      return {};
    }
    throw new Error(`Unexpected HubSpot call: ${path}`);
  }

  const stats = await runLeadStatusSync({
    mode: 'incremental',
    listId: '694',
    now: new Date('2026-06-02T22:00:00.000Z'),
    lookbackHours: 28,
    touchpointDays: 90,
    bdrOwnerIds: ['100'],
    bdrEmails: ['bdr@example.com'],
    searchDelayMs: 0,
    generalDelayMs: 0,
    engagementConcurrency: 1,
    hubspot,
    skipSlack: true,
    logger: { log() {} },
  });

  assert.strictEqual(stats.nooksNotInterestedCalls, 1);
  assert.strictEqual(stats.nooksNotInterestedContacts, 1);
  assert.strictEqual(stats.candidateCount, 1);
  assert.strictEqual(stats.statusUpdates, 1);
  assert.strictEqual(updates.length, 1);
  assert.deepStrictEqual(updates[0], {
    id: '9',
    properties: {
      hs_lead_status: STATUS.DISQUALIFIED,
      disqualified_reasons: DISQUALIFIED_REASONS.NOT_INTERESTED,
    },
  });
}

function testSummaryIncludesKeyCounts() {
  const text = formatLeadStatusSyncSummary({
    mode: 'incremental',
    dryRun: true,
    candidateCount: 10,
    listCandidateCount: 7,
    updatedContacts: 3,
    statusUpdates: 2,
    touchpointUpdates: 3,
    errors: 0,
    transitions: { [`${STATUS.NEW} -> ${STATUS.WORKING}`]: 2 },
    disqualifiedReasons: {},
    workingTouchpointContacts: 5,
    workingTouchpointTotal: 12,
    workingTouchpointMedian: 2,
  });

  assert.match(text, /Lead status sync complete \(incremental, dry run\)/);
  assert.match(text, /Status changes: 2/);
  assert.match(text, /Total touchpoints: 12/);
}

async function run() {
  testTouchpointFiltering();
  testLeadClassification();
  testUpdateBuilderOnlyMovesForwardAndMaintainsTouchpoints();
  await testIncrementalSyncUsesRecentCandidatesAndAllowedEngagements();
  await testIncrementalSyncUsesRecentNooksNotInterestedCalls();
  testSummaryIncludesKeyCounts();
}

run()
  .then(() => console.log('lead_status_sync tests passed'))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
