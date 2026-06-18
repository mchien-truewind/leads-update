const assert = require('assert');

const {
  DISQUALIFIED_REASONS,
  STATUS,
  buildContactUpdate,
  classifyTouchpointNote,
  classifyLeadStatus,
  formatLeadStatusSyncSummary,
  hubspotFetch,
  includeTouchpointEngagement,
  makeDefaultConfig,
  summarizeNoteTouchpoints,
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

function note(id, properties = {}) {
  return {
    id: String(id),
    properties: {
      hs_timestamp: String(Date.parse('2026-05-20T12:00:00.000Z')),
      hubspot_owner_id: '100',
      hs_note_body: 'Email sent to prospect',
      ...properties,
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

function testNoteTouchpointClassification() {
  const sinceMs = Date.parse('2026-02-20T00:00:00.000Z');

  assert.deepStrictEqual(
    classifyTouchpointNote(note(1, { hs_note_body: '<p>Email sent to prospect</p>' }), sinceMs, TEST_CONFIG),
    {
      include: true,
      reason: 'email_sent',
      channel: 'email',
      dedupeKey: classifyTouchpointNote(note(1, { hs_note_body: '<p>Email sent to prospect</p>' }), sinceMs, TEST_CONFIG).dedupeKey,
    },
  );
  assert.strictEqual(
    classifyTouchpointNote(note(2, { hs_note_body: 'Email opened by prospect' }), sinceMs, TEST_CONFIG).reason,
    'email_open',
  );
  assert.strictEqual(
    classifyTouchpointNote(note(3, { hs_note_body: 'Sent LinkedIn message through HeyReach' }), sinceMs, TEST_CONFIG).channel,
    'message',
  );
  assert.strictEqual(
    classifyTouchpointNote(note(4, { hubspot_owner_id: '999', hs_note_body: 'Email sent to prospect' }), sinceMs, TEST_CONFIG).channel,
    'email',
  );
  assert.strictEqual(
    classifyTouchpointNote(note(5, { hs_timestamp: String(Date.parse('2026-01-01T00:00:00.000Z')) }), sinceMs, TEST_CONFIG).reason,
    'outside_window',
  );
}

function testNoteTouchpointSummaryDedupesAndTracksExclusions() {
  const sinceMs = Date.parse('2026-02-20T00:00:00.000Z');
  const summary = summarizeNoteTouchpoints([
    note(1, { hs_note_body: 'Email sent to prospect' }),
    note(2, { hs_note_body: 'Email sent to prospect' }),
    note(3, { hs_note_body: 'Email opened by prospect' }),
    note(4, { hs_note_body: 'Prospect replied with thanks' }),
  ], sinceMs, TEST_CONFIG);

  assert.strictEqual(summary.count, 1);
  assert.strictEqual(summary.duplicates, 1);
  assert.strictEqual(summary.excluded.duplicate, 1);
  assert.strictEqual(summary.excluded.email_open, 1);
  assert.strictEqual(summary.excluded.inbound_reply, 1);
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

async function testNotesModeUsesAssociatedNotesForTouchpoints() {
  const updates = [];
  const calls = [];

  async function hubspot(path, options = {}) {
    calls.push({ path, options });
    if (path.startsWith('/crm/v3/lists/694/memberships/join-order')) {
      return { results: [{ recordId: '1' }] };
    }
    if (path === '/crm/v3/objects/contacts/search') {
      const body = JSON.parse(options.body);
      const field = body.filterGroups[0].filters[0].propertyName;
      return field === 'notes_last_updated' ? { results: [{ id: '1' }] } : { results: [] };
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
    if (path.startsWith('/crm/v4/objects/contacts/1/associations/notes')) {
      return {
        results: [{ toObjectId: 'n1' }, { toObjectId: 'n2' }, { toObjectId: 'n3' }],
      };
    }
    if (path.startsWith('/crm/v4/objects/contacts/1/associations/calls')) {
      return {
        results: [{ toObjectId: 'c1' }],
      };
    }
    if (path === '/crm/v3/objects/notes/batch/read') {
      return {
        results: [
          note('n1', { hs_note_body: 'Email sent to prospect' }),
          note('n2', { hs_note_body: 'Email opened by prospect' }),
          note('n3', { hs_note_body: 'Sent LinkedIn message through HeyReach' }),
        ],
      };
    }
    if (path === '/crm/v3/objects/calls/batch/read') {
      return {
        results: [
          {
            id: 'c1',
            properties: {
              hs_timestamp: String(Date.parse('2026-05-20T12:30:00.000Z')),
              hs_call_direction: 'OUTBOUND',
              hs_call_status: 'COMPLETED',
              hs_call_title: '[Nooks Call] - Left voicemail - Example Person',
            },
          },
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
    touchpointSource: 'notes',
    bdrOwnerIds: ['100'],
    bdrEmails: ['bdr@example.com'],
    searchDelayMs: 0,
    generalDelayMs: 0,
    engagementConcurrency: 1,
    hubspot,
    skipSlack: true,
    logger: { log() {} },
  });

  assert.strictEqual(stats.touchpointSource, 'notes');
  assert.strictEqual(stats.notesScanned, 3);
  assert.strictEqual(stats.notesCounted, 2);
  assert.strictEqual(stats.callsScanned, 1);
  assert.strictEqual(stats.callsCounted, 1);
  assert.strictEqual(stats.noteExclusions.email_open, 1);
  assert.strictEqual(stats.touchpointUpdates, 1);
  assert.deepStrictEqual(updates[0].properties, {
    hs_lead_status: STATUS.WORKING,
    bdr_touchpoints_90d: '3',
    bdr_touchpoints_90d_updated_at: String(Date.parse('2026-05-20T13:00:00.000Z')),
  });
  assert.strictEqual(stats.preview[0].touchpointSource, 'notes');
  assert.strictEqual(stats.preview[0].noteEvidence.length, 3);
  assert.ok(calls.some(call => call.path.startsWith('/crm/v4/objects/contacts/1/associations/notes')));
  assert.ok(calls.some(call => call.path === '/crm/v3/objects/notes/batch/read'));
  assert.ok(calls.some(call => call.path.startsWith('/crm/v4/objects/contacts/1/associations/calls')));
  assert.ok(calls.some(call => call.path === '/crm/v3/objects/calls/batch/read'));
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
    touchpointSource: 'notes',
    notesScanned: 9,
    notesCounted: 6,
    callsScanned: 3,
    callsCounted: 2,
    duplicateNotes: 1,
    errors: 0,
    transitions: { [`${STATUS.NEW} -> ${STATUS.WORKING}`]: 2 },
    disqualifiedReasons: {},
    workingTouchpointContacts: 5,
    workingTouchpointTotal: 12,
    workingTouchpointMedian: 2,
  });

  assert.match(text, /Lead status sync complete \(incremental, dry run\)/);
  assert.match(text, /Status changes: 2/);
  assert.match(text, /Touchpoint source: notes/);
  assert.match(text, /Notes scanned: 9/);
  assert.match(text, /Calls counted: 2/);
  assert.match(text, /Total touchpoints: 12/);
}

function testNotesModeDefaultsToLowerConcurrency() {
  assert.strictEqual(makeDefaultConfig({ LEAD_STATUS_SYNC_TOUCHPOINT_SOURCE: 'engagements' }).engagementConcurrency, 6);
  assert.strictEqual(makeDefaultConfig({ LEAD_STATUS_SYNC_TOUCHPOINT_SOURCE: 'notes' }).engagementConcurrency, 2);
  assert.strictEqual(
    makeDefaultConfig({
      LEAD_STATUS_SYNC_TOUCHPOINT_SOURCE: 'notes',
      LEAD_STATUS_SYNC_ENGAGEMENT_CONCURRENCY: '4',
    }).engagementConcurrency,
    4,
  );
}

async function testHubSpotFetchRetriesTransientFailures() {
  const originalFetch = global.fetch;
  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      const err = new Error('fetch failed');
      err.retryAfterMs = 1;
      throw err;
    }
    if (attempts === 2) {
      return {
        ok: false,
        status: 429,
        headers: { get: name => (String(name).toLowerCase() === 'retry-after' ? '0.001' : '') },
        text: async () => JSON.stringify({ message: 'You have reached your ten_secondly_rolling limit.' }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => '' },
      text: async () => JSON.stringify({ ok: true }),
    };
  };

  try {
    const result = await hubspotFetch('/crm/v3/objects/contacts/1', {}, { hubspotToken: 'test-token' });
    assert.deepStrictEqual(result, { ok: true });
    assert.strictEqual(attempts, 3);
  } finally {
    global.fetch = originalFetch;
  }
}

async function run() {
  testTouchpointFiltering();
  testNoteTouchpointClassification();
  testNoteTouchpointSummaryDedupesAndTracksExclusions();
  testLeadClassification();
  testUpdateBuilderOnlyMovesForwardAndMaintainsTouchpoints();
  await testIncrementalSyncUsesRecentCandidatesAndAllowedEngagements();
  await testIncrementalSyncUsesRecentNooksNotInterestedCalls();
  await testNotesModeUsesAssociatedNotesForTouchpoints();
  testSummaryIncludesKeyCounts();
  testNotesModeDefaultsToLowerConcurrency();
  await testHubSpotFetchRetriesTransientFailures();
}

run()
  .then(() => console.log('lead_status_sync tests passed'))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
