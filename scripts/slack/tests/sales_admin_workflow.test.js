const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const {
  DEFAULT_AE_ROSTER,
  buildConfig,
  buildStageDecision,
  buildWritebackNote,
  POST_ACTIONS,
  SalesAdminWorkflow,
  cancellationSourceLabel,
  classifyMeetingStatus,
  getLocalDayRange,
  hubspotNextStepSummary,
  meetingEndMs,
  msUntilNextLocalTime,
  parseRoster,
  recordingDirectlyMatchesMeeting,
  resolveChannelId,
  selectedStageFromInteraction,
} = require('../sales_admin/workflow');
const { createSalesAdminState } = require('../sales_admin/state');
const { HubSpotSalesAdminClient } = require('../sales_admin/hubspot_sales_admin');

function meeting(properties = {}) {
  return { id: 'm1', properties };
}

const STAGES = [
  { id: '1307720553', label: 'Stage 1: MQL', displayOrder: 0 },
  { id: '190380582', label: 'Stage 2: SQL (Full Product Demo)', displayOrder: 1 },
  { id: '190380583', label: 'Stage 3: Awaiting Materials', displayOrder: 2 },
  { id: '190380586', label: 'Stage 4: POC', displayOrder: 3 },
  { id: '190380584', label: 'Stage 5: Proposal', displayOrder: 4 },
  { id: '1166230571', label: 'Stage 6: Won', displayOrder: 5 },
  { id: '190380587', label: 'Stage 7: Closed/Lost', displayOrder: 6 },
];

test('sales admin cancellation detection handles CalendarSync, Calendly, and outcome fallbacks', () => {
  assert.equal(classifyMeetingStatus(meeting({ hs_meeting_title: 'Canceled: Anthony and Xavier' })), 'cancelled');
  assert.equal(classifyMeetingStatus(meeting({ hs_meeting_title: '[Canceled] Calendly: Intro to Truewind' })), 'cancelled');
  assert.equal(classifyMeetingStatus(meeting({ hs_meeting_title: 'Intro to Truewind', hs_meeting_outcome: 'CANCELED' })), 'cancelled');
  assert.equal(classifyMeetingStatus(meeting({ hs_meeting_title: 'Intro to Truewind' })), 'scheduled');
  // Terminal outcomes (e.g. Calendly's NO_SHOW duplicate of a cancelled meeting) are
  // resolved, not live upcoming calls.
  assert.equal(classifyMeetingStatus(meeting({ hs_meeting_title: 'Truewind Intro Meeting', hs_meeting_outcome: 'NO_SHOW' })), 'resolved');
  assert.equal(classifyMeetingStatus(meeting({ hs_meeting_title: 'Truewind Intro Meeting', hs_meeting_outcome: 'COMPLETED' })), 'resolved');
  assert.equal(classifyMeetingStatus(meeting({ hs_meeting_title: 'Truewind Intro Meeting', hs_meeting_outcome: 'RESCHEDULED' })), 'resolved');
});

test('sales admin cancellation source labeling distinguishes CalendarSync and Calendly', () => {
  assert.equal(cancellationSourceLabel(meeting({ hs_meeting_source: 'BIDIRECTIONAL_SYNC', hs_object_source_id: 'CalendarSync' })), 'CalendarSync');
  assert.equal(cancellationSourceLabel(meeting({ hs_object_source_detail_1: 'Calendly', hs_object_source_id: '199720' })), 'Calendly');
  assert.equal(cancellationSourceLabel(meeting({ hs_meeting_title: '[Canceled] Calendly: Intro' })), 'Calendly');
  assert.equal(cancellationSourceLabel(meeting({ hs_meeting_title: 'Canceled: Unknown' })), 'Unknown');
});

test('sales admin cancellation alerts dedupe even when HubSpot note write fails', async () => {
  const posts = [];
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => { posts.push(payload); return { ts: String(posts.length), channel: payload.channel }; } } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-cancel-dedupe-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('84547076', 'C_SARAH');
  const rawMeetings = [
    { id: 'cancel-1', properties: { hs_meeting_title: '[Canceled] Calendly: Truewind Introductions', hs_meeting_start_time: '2026-06-04T14:00:00.000Z', hs_object_source_detail_1: 'Calendly' } },
    { id: 'cancel-2', properties: { hs_meeting_title: 'Canceled: Calendly: Truewind Introductions', hs_meeting_start_time: '2026-06-04T14:00:00.000Z', hs_object_source_detail_1: 'Calendly' } },
  ];
  workflow.hubspot.searchRecentlyUpdatedMeetingsForOwner = async () => rawMeetings;
  workflow.hubspot.attachAssociations = async rawMeeting => ({
    ...rawMeeting,
    _contacts: [{ id: 'ct1', firstname: 'Jeremiah', lastname: 'Paul', email: 'jeremiah@example.com', company: 'StartHub' }],
    _companies: [{ id: 'c1', name: 'StartHub' }],
    _deals: [{ id: 'd1', dealname: 'StartHub - Sarah Elix - 2026-06-04' }],
  });
  workflow.hubspot.createNote = async () => {
    throw new Error('HubSpot 400: Invalid Association Creation Requests');
  };

  const first = await workflow.runCancellationScan(new Date('2026-06-04T14:05:00.000Z'));
  const second = await workflow.runCancellationScan(new Date('2026-06-04T14:10:00.000Z'));

  assert.equal(first.alerted, 1);
  assert.equal(first.skipped, 1);
  assert.equal(second.alerted, 0);
  assert.equal(second.skipped, 2);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /meeting cancelled/);
  assert.match(posts[0].text, /HubSpot deal: <https:\/\/app\.hubspot\.com\/contacts\/43974586\/record\/0-3\/d1\|StartHub - Sarah Elix - 2026-06-04> \(ID: d1\)/);
  const stored = Object.values(workflow.state.load().records).filter(record => record.type === 'cancel');
  assert.ok(stored.some(record => record.hubspotNoteStatus === 'failed'));
});


test('sales admin Grain matching can use direct HubSpot and calendar metadata', () => {
  assert.equal(recordingDirectlyMatchesMeeting({ hubspot: { meeting_id: '12345' } }, { id: '12345', properties: {} }), true);
  assert.equal(recordingDirectlyMatchesMeeting({ calendar_event: { id: 'calendar-event-1' } }, meeting({ hs_meeting_source_id: 'calendar-event-1' })), true);
  assert.equal(recordingDirectlyMatchesMeeting({ calendar_event: { id: 'other' } }, meeting({ hs_meeting_source_id: 'calendar-event-1' })), false);
});

test('sales admin HubSpot enrichment falls back to company and contact deals', async () => {
  const client = new HubSpotSalesAdminClient({
    hubspotRequest: async () => {
      throw new Error('unexpected raw HubSpot request');
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  client.getAssociations = async (fromType, fromId, toType) => {
    if (fromType === 'meetings' && fromId === 'm1' && toType === 'contacts') return ['ct1'];
    if (fromType === 'meetings' && fromId === 'm1' && toType === 'companies') return ['co1'];
    if (fromType === 'meetings' && fromId === 'm1' && toType === 'deals') return [];
    if (fromType === 'companies' && fromId === 'co1' && toType === 'deals') return ['deal-from-company'];
    if (fromType === 'contacts' && fromId === 'ct1' && toType === 'deals') return ['deal-from-contact', 'deal-from-company'];
    return [];
  };
  client.getObject = async (objectType, objectId) => {
    if (objectType === 'contacts') return { id: objectId, properties: { firstname: 'Alex', lastname: 'Hill', email: 'alex@trove.com', company: 'Trove' } };
    if (objectType === 'companies') return { id: objectId, properties: { name: 'Trove' } };
    if (objectType === 'deals') return { id: objectId, properties: { dealname: objectId === 'deal-from-company' ? 'Trove - New Deal' : 'Trove Expansion', pipeline: '105321581', dealstage: '190380582' } };
    throw new Error(`unexpected object ${objectType}/${objectId}`);
  };

  const enriched = await client.attachAssociations(meeting({ hs_meeting_title: 'Trove x Truewind' }));

  assert.deepEqual(enriched._dealIds, ['deal-from-company', 'deal-from-contact']);
  assert.equal(enriched._deals[0].dealname, 'Trove - New Deal');
  assert.equal(enriched._deals[0]._associationSource, 'fallback');
});

test('sales admin createNote associates to contacts/companies/deals, never the meeting', async () => {
  const calls = [];
  const client = new HubSpotSalesAdminClient({
    hubspotRequest: async (path, method = 'GET') => {
      calls.push({ path, method });
      if (path === '/crm/v3/objects/notes' && method === 'POST') return { id: 'note-1' };
      return {};
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  const note = await client.createNote({
    body: 'No-Show',
    meeting: { id: 'm1' },
    contacts: [{ id: 'ct1' }],
    companies: [{ id: 'co1' }],
    deals: [{ id: 'd1' }],
  });
  assert.equal(note.id, 'note-1');
  const assocPaths = calls.filter(c => c.method === 'PUT').map(c => c.path);
  // HubSpot has no notes<->meetings association — must never attempt it (was the 400).
  assert.ok(!assocPaths.some(p => p.includes('/associations/default/meetings/')), 'must NOT associate note to meeting');
  assert.ok(assocPaths.some(p => p.includes('/associations/default/contacts/ct1')), 'associates to contact');
  assert.ok(assocPaths.some(p => p.includes('/associations/default/companies/co1')), 'associates to company');
  assert.ok(assocPaths.some(p => p.includes('/associations/default/deals/d1')), 'associates to deal');
});

test('sales admin roster requires channel, Slack user, and HubSpot owner', () => {
  const roster = parseRoster(JSON.stringify([{ name: 'Alex Lee', hubspotOwnerId: '559564379', email: 'alex@trytruewind.com', slackUserId: 'U04BPMPR29G', salesAdminChannel: '#gtm-salesadmin-alex' }]));
  assert.deepEqual(roster, [{ name: 'Alex Lee', hubspotOwnerId: '559564379', email: 'alex@trytruewind.com', slackUserId: 'U04BPMPR29G', salesAdminChannel: 'gtm-salesadmin-alex' }]);
  assert.throws(() => parseRoster(JSON.stringify([{ name: 'Missing Channel', hubspotOwnerId: '1', email: 'a@example.com', slackUserId: 'U1' }])), /salesAdminChannel/);
});

test('sales admin default roster includes confirmed Alex and Amy IDs', () => {
  const byName = Object.fromEntries(DEFAULT_AE_ROSTER.map(ae => [ae.name, ae]));
  assert.equal(byName['Alex Lee'].hubspotOwnerId, '559564379');
  assert.equal(byName['Alex Lee'].slackUserId, 'U04BPMPR29G');
  assert.equal(byName['Amy Vetter'].hubspotOwnerId, '92555980');
  assert.equal(byName['Amy Vetter'].slackUserId, 'U0B4MRN83FE');
});


test('sales admin stage decision defaults to next stage and includes current plus later stages', () => {
  const decision = buildStageDecision({
    deal: { id: 'deal-1', dealname: 'Acme', pipeline: '105321581', dealstage: '190380582' },
    stages: STAGES,
  });

  assert.equal(decision.currentStageLabel, 'Stage 2: SQL (Full Product Demo)');
  assert.equal(decision.recommendedStageId, '190380583');
  assert.equal(decision.recommendedStageLabel, 'Stage 3: Awaiting Materials');
  assert.deepEqual(decision.options.map(stage => stage.id), ['190380582', '190380583', '190380586', '190380584', '1166230571', '190380587']);
});

test('sales admin stage decision marks HubSpot closed stages', () => {
  const decision = buildStageDecision({
    deal: { id: 'deal-1', dealname: 'PKF', pipeline: '105321581', dealstage: '190380587' },
    stages: STAGES.map(stage => stage.id === '190380587' ? { ...stage, metadata: { isClosed: 'true' } } : stage),
  });

  assert.equal(decision.currentStageLabel, 'Stage 7: Closed/Lost');
  assert.equal(decision.currentStageIsClosed, true);
});

test('sales admin stage decision stays on final stage when already terminal', () => {
  const decision = buildStageDecision({
    deal: { id: 'deal-1', dealname: 'Acme', pipeline: '105321581', dealstage: '190380587' },
    stages: STAGES,
  });

  assert.equal(decision.currentStageLabel, 'Stage 7: Closed/Lost');
  assert.equal(decision.recommendedStageId, '190380587');
  assert.deepEqual(decision.options.map(stage => stage.id), ['190380587']);
});

test('sales admin reads selected stage from Slack interaction state', () => {
  assert.equal(selectedStageFromInteraction({
    state: {
      values: {
        deal_stage: {
          sales_admin_stage_select: {
            action_id: 'sales_admin_stage_select',
            selected_option: { value: '190380583' },
          },
        },
      },
    },
  }), '190380583');
  assert.equal(selectedStageFromInteraction({ state: { values: {} } }, 'fallback'), 'fallback');
});

test('sales admin config defaults disabled and channel roster is available', () => {
  const config = buildConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.postMeetingDelayMin, 10);
  assert.equal(config.postMeetingLookbackHours, 2);
  assert.equal(config.cancelScanMin, 5);
  assert.equal(config.tomorrowHour, 17);
  assert.equal(config.tomorrowMinute, 0);
  assert.ok(config.roster.some(ae => ae.salesAdminChannel === 'gtm-salesadmin-sarah'));
});

test('sales admin Pacific day range respects date key', () => {
  const range = getLocalDayRange(new Date('2026-06-03T18:00:00.000Z'), 'America/Los_Angeles');
  assert.equal(range.dateKey, '2026-06-03');
  assert.equal(range.start.toISOString(), '2026-06-03T07:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-06-04T07:00:00.000Z');
});

test('sales admin Pacific day range supports tomorrow offset', () => {
  const range = getLocalDayRange(new Date('2026-06-03T18:00:00.000Z'), 'America/Los_Angeles', 1);
  assert.equal(range.dateKey, '2026-06-04');
  assert.equal(range.start.toISOString(), '2026-06-04T07:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-06-05T07:00:00.000Z');
});

test('sales admin meeting end falls back to one hour after start', () => {
  assert.equal(meetingEndMs(meeting({ hs_meeting_start_time: '2026-06-03T18:00:00.000Z' })), Date.parse('2026-06-03T19:00:00.000Z'));
  assert.equal(meetingEndMs(meeting({ hs_meeting_end_time: '2026-06-03T18:30:00.000Z' })), Date.parse('2026-06-03T18:30:00.000Z'));
});

test('sales admin next local time schedules tomorrow after target', () => {
  const delay = msUntilNextLocalTime({ now: new Date('2026-06-03T16:00:00.000Z'), timeZone: 'America/Los_Angeles', hour: 8, minute: 0 });
  assert.equal(delay, 23 * 60 * 60 * 1000);
});

test('sales admin morning summaries skip Saturday and Sunday', async () => {
  const posts = [];
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => { posts.push(payload); return { ts: '1', channel: payload.channel }; } } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-weekend-morning-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('84547076', 'C_SARAH');
  workflow.meetingsForToday = async () => {
    throw new Error('weekend morning should not fetch meetings');
  };

  const saturday = await workflow.runMorningSummaries(new Date('2026-06-06T16:00:00.000Z'));
  const sunday = await workflow.runMorningSummaries(new Date('2026-06-07T16:00:00.000Z'));

  assert.equal(saturday.reason, 'weekend');
  assert.equal(sunday.reason, 'weekend');
  assert.equal(saturday.posted, 0);
  assert.equal(sunday.posted, 0);
  assert.equal(posts.length, 0);
});

test('sales admin tomorrow summaries skip weekend targets but send Sunday for Monday', async () => {
  const posts = [];
  let fetches = 0;
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => { posts.push(payload); return { ts: String(posts.length), channel: payload.channel }; } } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-weekend-tomorrow-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('84547076', 'C_SARAH');
  workflow.meetingsForTomorrow = async () => {
    fetches += 1;
    return [
      {
        id: 'monday-1',
        properties: { hs_meeting_title: 'Monday Intro', hs_meeting_start_time: '2026-06-08T16:00:00.000Z' },
        _companies: [{ id: 'c1', name: 'Monday Co' }],
        _contacts: [{ id: 'ct1', firstname: 'Mona', lastname: 'Buyer', email: 'mona@example.com' }],
      },
    ];
  };

  const friday = await workflow.runTomorrowSummaries(new Date('2026-06-06T00:30:00.000Z'));
  const saturday = await workflow.runTomorrowSummaries(new Date('2026-06-07T00:30:00.000Z'));
  const sunday = await workflow.runTomorrowSummaries(new Date('2026-06-08T00:30:00.000Z'));

  assert.equal(friday.reason, 'weekend_tomorrow');
  assert.equal(friday.dateKey, '2026-06-06');
  assert.equal(saturday.reason, 'weekend_tomorrow');
  assert.equal(saturday.dateKey, '2026-06-07');
  assert.equal(sunday.posted, 1);
  assert.equal(fetches, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /Tomorrow's calls .*Mon, Jun 8/);
  assert.match(posts[0].text, /Monday Co/);
});

test('sales admin post-meeting scan skips weekends unless forced', async () => {
  let fetches = 0;
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => ({ ts: '1', channel: payload.channel }) } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-weekend-post-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('84547076', 'C_SARAH');
  workflow.meetingsForToday = async () => {
    fetches += 1;
    return [];
  };

  const automatic = await workflow.runPostMeetingScan(new Date('2026-06-06T20:00:00.000Z'));
  const forced = await workflow.runPostMeetingScan(new Date('2026-06-06T20:00:00.000Z'), { force: true });

  assert.equal(automatic.reason, 'weekend');
  assert.equal(automatic.prompted, 0);
  assert.equal(forced.prompted, 0);
  assert.equal(fetches, 1);
});


test('sales admin skips configured AEs whose channel has not resolved', async () => {
  const posts = [];
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => { posts.push(payload); return { ts: '1', channel: payload.channel }; } } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
        { name: 'Alex Lee', hubspotOwnerId: '559564379', email: 'alex@trytruewind.com', slackUserId: 'U04BPMPR29G', salesAdminChannel: 'gtm-salesadmin-alex' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-skip-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('84547076', 'C_SARAH');
  workflow.missingChannelsByOwnerId.add('559564379');
  workflow.meetingsForToday = async () => [];

  const stats = await workflow.runMorningSummaries(new Date('2026-06-03T18:00:00.000Z'));
  assert.equal(stats.posted, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'C_SARAH');
});

test('sales admin morning summary includes HubSpot deal links', async () => {
  const posts = [];
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => { posts.push(payload); return { ts: '1', channel: payload.channel }; } } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Xavier Marco', hubspotOwnerId: '89305622', email: 'xavier@trytruewind.com', slackUserId: 'U0AKMHVCJMA', salesAdminChannel: 'gtm-salesadmin-xavier' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-morning-deal-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('89305622', 'C_XAVIER');
  workflow.meetingsForToday = async () => [
    {
      id: 'trove-meeting',
      properties: { hs_meeting_title: 'Trove x Truewind', hs_meeting_start_time: '2026-06-08T15:00:00.000Z' },
      _contacts: [{ id: 'ct1', firstname: 'Alex', lastname: 'Hill', email: 'alex@trove.com', company: 'Trove' }],
      _companies: [{ id: 'co1', name: 'Trove' }],
      _deals: [{ id: 'deal-1', dealname: 'Trove - New Deal' }],
    },
  ];

  const stats = await workflow.runMorningSummaries(new Date('2026-06-08T14:00:00.000Z'));

  assert.equal(stats.posted, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /Trove x Truewind/);
  assert.match(posts[0].text, /<https:\/\/app\.hubspot\.com\/contacts\/43974586\/record\/0-3\/deal-1\|Trove - New Deal>/);
});

test('sales admin tomorrow summary posts next-day calls after 5pm schedule', async () => {
  const posts = [];
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => { posts.push(payload); return { ts: '1', channel: payload.channel }; } } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-tomorrow-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('84547076', 'C_SARAH');
  workflow.meetingsForTomorrow = async () => [
    {
      id: 'm1',
      properties: { hs_meeting_title: 'Truewind Full Demo', hs_meeting_start_time: '2026-06-04T16:30:00.000Z' },
      _companies: [{ id: 'c1', name: 'Acme' }],
      _deals: [{ id: 'd1', dealname: 'Acme - New Deal', pipeline: '105321581', dealstage: '190380582' }],
      _contacts: [{ id: 'ct1', firstname: 'Ava', lastname: 'Buyer', email: 'ava@example.com' }],
    },
    {
      id: 'm2',
      properties: { hs_meeting_title: 'Canceled: Old Intro', hs_meeting_start_time: '2026-06-04T20:00:00.000Z' },
    },
  ];
  workflow.buildStageDecisionForMeeting = async meeting => buildStageDecision({
    deal: meeting._deals?.[0],
    stages: STAGES,
  });

  const stats = await workflow.runTomorrowSummaries(new Date('2026-06-03T18:00:00.000Z'));

  assert.equal(stats.posted, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, 'C_SARAH');
  assert.match(posts[0].text, /Tomorrow's calls .*Jun 4/);
  assert.match(posts[0].text, /<@U09QC3B292R>/);
  assert.match(posts[0].text, /\*9:30 AM — Acme\*/);
  assert.match(posts[0].text, /Truewind Full Demo/);
  assert.match(posts[0].text, /Deal stage: Stage 2: SQL \(Full Product Demo\)/);
  assert.match(posts[0].text, /HubSpot meeting/);
  assert.match(posts[0].text, /Cancelled tomorrow/);
  assert.equal(workflow.state.get('tomorrow:2026-06-04:84547076').status, 'posted');
});

test('sales admin tomorrow summary flags closed-deal meetings instead of hiding them', async () => {
  const posts = [];
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => { posts.push(payload); return { ts: '1', channel: payload.channel }; } } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-closed-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('84547076', 'C_SARAH');
  workflow.meetingsForTomorrow = async () => [
    {
      id: 'm1',
      properties: { hs_meeting_title: 'Truewind Intro', hs_meeting_start_time: '2026-06-04T16:30:00.000Z' },
      _companies: [{ id: 'c1', name: 'GRF' }],
      _deals: [{ id: 'd1', dealname: 'GRF - Sarah Elix', pipeline: '105321581', dealstage: '190380587' }], // Closed/Lost
      _contacts: [{ id: 'ct1', firstname: 'Andrew', lastname: 'Deyhle' }],
    },
  ];
  const closedStages = STAGES.map(stage => stage.id === '190380587' ? { ...stage, metadata: { isClosed: 'true' } } : stage);
  workflow.buildStageDecisionForMeeting = async meeting => buildStageDecision({ deal: meeting._deals?.[0], stages: closedStages });

  await workflow.runTomorrowSummaries(new Date('2026-06-03T18:00:00.000Z'));

  assert.equal(posts.length, 1);
  // Surfaced (not hidden) with an alarm, and NOT shown as a plain stage line.
  assert.match(posts[0].text, /:rotating_light:/);
  assert.match(posts[0].text, /please check/i);
  assert.ok(!/Deal stage: Stage 7: Closed\/Lost/.test(posts[0].text), 'closed deal shows the alarm, not a plain stage line');
});

test('sales admin tomorrow summary excludes NO_SHOW/cancelled duplicate meetings', async () => {
  const posts = [];
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => { posts.push(payload); return { ts: '1', channel: payload.channel }; } } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-resolved-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('84547076', 'C_SARAH');
  // Mirrors the real GRF data: a NO_SHOW duplicate + its [Canceled] twin, plus a real call.
  workflow.meetingsForTomorrow = async () => [
    { id: 'noshow', properties: { hs_meeting_title: 'Ghost Meeting', hs_meeting_outcome: 'NO_SHOW', hs_meeting_start_time: '2026-06-04T12:00:00.000Z' }, _companies: [{ id: 'c1', name: 'GRF' }] },
    { id: 'canceled', properties: { hs_meeting_title: '[Canceled] Real Cancel', hs_meeting_start_time: '2026-06-04T12:30:00.000Z' }, _companies: [{ id: 'c1', name: 'GRF' }] },
    { id: 'live', properties: { hs_meeting_title: 'Real Demo', hs_meeting_start_time: '2026-06-04T18:00:00.000Z' }, _companies: [{ id: 'c2', name: 'Acme' }], _deals: [{ id: 'd1', dealname: 'Acme', pipeline: '105321581', dealstage: '190380582' }] },
  ];
  workflow.buildStageDecisionForMeeting = async meeting => buildStageDecision({ deal: meeting._deals?.[0], stages: STAGES });

  await workflow.runTomorrowSummaries(new Date('2026-06-03T18:00:00.000Z'));

  assert.equal(posts.length, 1);
  assert.ok(!/Ghost Meeting/.test(posts[0].text), 'NO_SHOW duplicate must not appear as a live call');
  assert.match(posts[0].text, /Cancelled tomorrow/);
  assert.match(posts[0].text, /Real Cancel/);
  assert.match(posts[0].text, /Real Demo/);
});

test('sales admin marks a meeting cancelled when Calendly (source of truth) says so', async () => {
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async () => ({ ts: '1' }) } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-cal-${Date.now()}-${Math.random()}.json`),
      CALENDLY_API_MASTER: 'cal-test-token',
      CALENDLY_ORGANIZATION: 'https://api.calendly.com/organizations/org',
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  // Stub the Calendly fetch with the real Calendly timestamp format (6-digit fractional).
  workflow.fetchCalendlyEvents = async ({ status }) => (status === 'canceled'
    ? [{ start_time: '2026-06-18T12:00:00.000000Z', name: 'Truewind Intro Meeting' }]
    : []);
  const ae = workflow.config.roster[0];
  const meetings = [
    { id: 'm1', properties: { hs_meeting_title: 'Truewind Intro Meeting', hs_meeting_start_time: '2026-06-18T12:00:00Z' } },
    { id: 'm2', properties: { hs_meeting_title: 'Real call', hs_meeting_start_time: '2026-06-18T18:00:00Z' } },
  ];

  await workflow.annotateCalendlyStatus(ae, meetings, { start: new Date('2026-06-18T00:00:00Z'), end: new Date('2026-06-19T00:00:00Z') });

  // Calendly's canceled verdict overrides HubSpot's stale record (by exact start time).
  assert.equal(meetings[0]._calendlyStatus, 'canceled');
  assert.equal(classifyMeetingStatus(meetings[0]), 'cancelled');
  assert.equal(meetings[1]._calendlyStatus, undefined);
  assert.equal(classifyMeetingStatus(meetings[1]), 'scheduled');
});

test('sales admin day fetch dedupes duplicate HubSpot meeting records', async () => {
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => ({ ts: '1', channel: payload.channel }) } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Xavier Marco', hubspotOwnerId: '89305622', email: 'xavier@trytruewind.com', slackUserId: 'U0AKMHVCJMA', salesAdminChannel: 'gtm-salesadmin-xavier' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-dedupe-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  const rawMeetings = [
    { id: 'm1', properties: { hs_meeting_title: 'Intro to Truewind', hs_meeting_start_time: '2026-06-04T18:00:00.000Z' } },
    { id: 'm2', properties: { hs_meeting_title: 'Brooksher Banks and Xavier Marco', hs_meeting_start_time: '2026-06-04T18:00:00.000Z' } },
    { id: 'm3', properties: { hs_meeting_title: 'Calendly: Intro to Truewind', hs_meeting_start_time: '2026-06-04T18:00:00.000Z' } },
    { id: 'm4', properties: { hs_meeting_title: 'A+ Education Intro', hs_meeting_start_time: '2026-06-04T18:30:00.000Z' } },
  ];
  workflow.hubspot.searchMeetingsForOwnerBetween = async () => rawMeetings;
  workflow.hubspot.attachAssociations = async rawMeeting => ({
    ...rawMeeting,
    _contacts: rawMeeting.id === 'm4'
      ? [{ id: 'ct2', firstname: 'Jenifer', lastname: 'Glover', email: 'jenifer@example.com', company: 'A+ Education Partnership' }]
      : [{ id: 'ct1', firstname: 'Brooksher', lastname: 'Banks', email: 'brooksher@example.com', company: 'Banks & Associates' }],
    _companies: rawMeeting.id === 'm4'
      ? [{ id: 'c2', name: 'A+ Education Partnership' }]
      : [{ id: 'c1', name: 'Banks & Associates' }],
    _deals: rawMeeting.id === 'm4'
      ? [{ id: 'd2', dealname: 'A+ Education Partnership - New Deal' }]
      : [{ id: 'd1', dealname: 'Banks & Associates - Xavier Marco - 2026-06-04' }],
  });

  const meetings = await workflow.meetingsForTomorrow(
    { name: 'Xavier Marco', hubspotOwnerId: '89305622' },
    new Date('2026-06-03T18:00:00.000Z'),
  );

  assert.deepEqual(meetings.map(item => item.id), ['m1', 'm4']);
});

test('sales admin compacts long Grain summaries for HubSpot next step', async () => {
  const extraction = await require('../sales_admin/workflow').extractNextSteps({
    anthropic: null,
    recording: {
      ai_summary: {
        summary: [
          '## Call Notes',
          'Truewind explained workpaper automation and accounting controls.',
          'EdOps is evaluating Truewind for a Sage Intacct client and needs Sarah to send pricing before a July decision.',
          'Additional implementation details covered bank reconciliations, AP reconciliation, accruals, and scheduling workflows.',
        ].join('\n'),
      },
      ai_action_items: [{ text: 'Sarah will send pricing and implementation scope.' }],
    },
    logger: { warn() {} },
  });

  assert.ok(extraction.summary.length <= 280);
  assert.doesNotMatch(extraction.summary, /##|\*\*/);
  assert.match(extraction.summary, /EdOps is evaluating Truewind/);
  assert.match(extraction.summary, /send pricing/);
});

test('sales admin HubSpot next step stops at a complete phrase', () => {
  const summary = hubspotNextStepSummary({
    meeting: {
      properties: { hs_meeting_title: 'Diocese of San Bernardino - Xavier Marco - 2026-05-21' },
      _companies: [{ name: 'Diocese of San Bernardino' }],
    },
    extraction: {
      summary: 'Full demo rescheduled to Monday at 12 PM Pacific after conflicts; confirm Angie availability for the Monday noon meeting',
      nextSteps: [{ text: 'Send rescheduled meeting invite for Monday at noon' }],
    },
    datePrefix: '06/15',
  });

  assert.equal(summary, '06/15: Send rescheduled meeting invite for Monday at noon; Full demo rescheduled to Monday at 12 PM Pacific after conflicts');
  assert.ok(summary.replace(/^06\/15:\s*/, '').split(/\s+/).length <= 20);
  assert.doesNotMatch(summary, /;\s*confirm$/i);
});

test('sales admin resolves public channels without requiring private channel scope', async () => {
  const calls = [];
  const channelId = await resolveChannelId({
    conversations: {
      list: async payload => {
        calls.push(payload);
        if (payload.types === 'private_channel') {
          const err = new Error('missing_scope');
          err.data = { error: 'missing_scope' };
          throw err;
        }
        return { channels: [{ id: 'C_SARAH', name: 'gtm-salesadmin-sarah' }] };
      },
    },
  }, 'xoxb-test', '#gtm-salesadmin-sarah');

  assert.equal(channelId, 'C_SARAH');
  assert.deepEqual(calls.map(call => call.types), ['public_channel']);
});

test('sales admin post-meeting scan can force a single targeted meeting', async () => {
  const posts = [];
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => { posts.push(payload); return { ts: '1', channel: payload.channel }; } } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-target-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('84547076', 'C_SARAH');
  workflow.meetingsForToday = async () => [
    { id: 'skip-me', properties: { hs_meeting_title: 'Other call', hs_meeting_start_time: '2026-06-03T18:00:00Z', hs_meeting_end_time: '2026-06-03T18:30:00Z' } },
    { id: 'target-me', properties: { hs_meeting_title: 'EdOps / Truewind', hs_meeting_start_time: '2026-06-03T20:30:00Z', hs_meeting_end_time: '2026-06-03T21:30:00Z' } },
  ];
  workflow.fetchGrainForMeeting = async () => ({
    recording: {
      id: 'grain-1',
      title: 'EdOps / Truewind',
      ai_summary: { summary: 'EdOps is evaluating Truewind for finance workflow automation and needs a follow-up on implementation scope.' },
      ai_action_items: [{ text: 'Send implementation pricing, confirm decision timeline, and identify finance owner for close plan', due_date: '2026-06-10' }],
    },
    grainUrl: 'https://grain.com/share/recording/grain-1',
    source: 'grain_matched',
  });
  workflow.buildStageDecisionForMeeting = async () => buildStageDecision({
    deal: { id: 'deal-1', dealname: 'EdOps - New Deal', pipeline: '105321581', dealstage: '190380582' },
    stages: STAGES,
  });
  workflow.state.set('post:target-me:84547076', { status: 'previously_prompted' });

  const stats = await workflow.runPostMeetingScan(new Date('2026-06-03T22:00:00Z'), {
    ownerId: '84547076',
    meetingId: 'target-me',
    force: true,
  });

  assert.equal(stats.prompted, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /EdOps/);
  assert.match(posts[0].blocks[0].text.text, /^\*EdOps \/ Truewind\*/);
  assert.match(posts[0].blocks[0].text.text, /meeting completed/i);
  assert.ok(!posts[0].blocks.some(block => block.text?.text?.includes('*Outcome from Grain*')));
  // The verbose "Suggested follow-up from Grain" block was removed.
  assert.ok(!posts[0].blocks.some(block => block.text?.text?.includes('*Suggested follow-up from Grain*')), 'Grain follow-up block should be removed');
  const hubspotNextStepBlock = posts[0].blocks.find(block => block.text?.text?.includes('*HubSpot Next Step*'));
  assert.match(hubspotNextStepBlock.text.text, /saved to HubSpot under `Next step`/);
  assert.match(hubspotNextStepBlock.text.text, /\d{2}\/\d{2}: Send implementation pricing, confirm decision timeline, and identify finance owner for close plan/);
  assert.ok(!posts[0].blocks.some(block => block.text?.text?.includes('```')));
  const stageBlock = posts[0].blocks.find(block => block.block_id === 'deal_stage');
  assert.match(stageBlock.text.text, /Deal stage: EdOps - New Deal/);
  assert.match(stageBlock.text.text, /Current stage: \*Stage 2: SQL/);
  assert.match(stageBlock.text.text, /Recommended: \*move it to Stage 3: Awaiting Materials/);
  assert.equal(stageBlock.accessory.type, 'static_select');
  assert.equal(stageBlock.accessory.initial_option.value, '190380583');
  assert.deepEqual(stageBlock.accessory.options.map(option => option.value), ['190380582', '190380583', '190380586', '190380584', '1166230571', '190380587']);
  const actions = posts[0].blocks.find(block => block.type === 'actions');
  assert.deepEqual(actions.elements.map(element => element.type === 'button' ? element.text.text : element.options[0].text.text), ['Confirm & Save', 'Edit Notes', 'No-Show', 'Not this meeting']);
  assert.equal(actions.elements[3].type, 'overflow');
  assert.equal(workflow.state.get('post:target-me:84547076').grainUrl, 'https://grain.com/share/recording/grain-1');
});

test('sales admin post-meeting scan skips meetings with HubSpot prompt marker after restart', async () => {
  const posts = [];
  const markerChecks = [];
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => { posts.push(payload); return { ts: '1', channel: payload.channel }; } } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Xavier Marco', hubspotOwnerId: '89305622', email: 'xavier@trytruewind.com', slackUserId: 'U0AKMHVCJMA', salesAdminChannel: 'gtm-salesadmin-xavier' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-marker-skip-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('89305622', 'C_XAVIER');
  workflow.meetingsForToday = async () => [
    { id: 'trove-meeting', properties: { hs_meeting_title: 'Trove x Truewind', hs_meeting_start_time: '2026-06-08T15:00:00.000Z', hs_meeting_end_time: '2026-06-08T16:00:00.000Z' } },
  ];
  workflow.buildStageDecisionForMeeting = async () => null;
  workflow.fetchGrainForMeeting = async () => {
    throw new Error('should not fetch Grain when HubSpot marker exists');
  };
  workflow.hubspot.hasMeetingNoteContaining = async (meetingId, marker) => {
    markerChecks.push({ meetingId, marker });
    return true;
  };
  workflow.hubspot.createPostPromptMarker = async () => {
    throw new Error('should not create duplicate marker');
  };

  const stats = await workflow.runPostMeetingScan(new Date('2026-06-08T17:00:00.000Z'));

  assert.equal(stats.prompted, 0);
  assert.equal(stats.skipped, 1);
  assert.equal(posts.length, 0);
  assert.deepEqual(markerChecks, [{ meetingId: 'trove-meeting', marker: 'sales_admin_post_prompt:89305622:trove-meeting' }]);
  assert.equal(workflow.state.get('post:trove-meeting:89305622').source, 'hubspot_marker');
});

test('sales admin post-meeting scan skips stale meetings after lookback unless forced', async () => {
  const posts = [];
  let grainFetchCount = 0;
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => { posts.push(payload); return { ts: String(posts.length), channel: payload.channel }; } } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_POST_MEETING_LOOKBACK_HOURS: '2',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Xavier Marco', hubspotOwnerId: '89305622', email: 'xavier@trytruewind.com', slackUserId: 'U0AKMHVCJMA', salesAdminChannel: 'gtm-salesadmin-xavier' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-stale-post-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('89305622', 'C_XAVIER');
  workflow.meetingsForToday = async () => [
    { id: 'old-trove-meeting', properties: { hs_meeting_title: 'Trove x Truewind', hs_meeting_start_time: '2026-06-08T15:00:00.000Z', hs_meeting_end_time: '2026-06-08T15:30:00.000Z' } },
  ];
  workflow.buildStageDecisionForMeeting = async () => null;
  workflow.hubspot.hasMeetingNoteContaining = async () => false;
  workflow.hubspot.createPostPromptMarker = async () => ({ id: 'note-1' });
  workflow.fetchGrainForMeeting = async () => {
    grainFetchCount += 1;
    return { recording: null, grainUrl: '', source: 'no_grain_recording' };
  };

  const automatic = await workflow.runPostMeetingScan(new Date('2026-06-08T18:00:00.000Z'));
  const forced = await workflow.runPostMeetingScan(new Date('2026-06-08T18:00:00.000Z'), { force: true });

  assert.equal(automatic.prompted, 0);
  assert.equal(automatic.skipped, 1);
  assert.equal(forced.prompted, 1);
  assert.equal(posts.length, 1);
  assert.equal(grainFetchCount, 1);
});

test('sales admin post-meeting scan writes HubSpot prompt marker after posting', async () => {
  const posts = [];
  const markers = [];
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => { posts.push(payload); return { ts: '1.234', channel: payload.channel }; } } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Xavier Marco', hubspotOwnerId: '89305622', email: 'xavier@trytruewind.com', slackUserId: 'U0AKMHVCJMA', salesAdminChannel: 'gtm-salesadmin-xavier' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-marker-write-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('89305622', 'C_XAVIER');
  workflow.meetingsForToday = async () => [
    { id: 'trove-meeting', properties: { hs_meeting_title: 'Trove x Truewind', hs_meeting_start_time: '2026-06-08T15:00:00.000Z', hs_meeting_end_time: '2026-06-08T16:00:00.000Z' } },
  ];
  workflow.buildStageDecisionForMeeting = async () => null;
  workflow.fetchGrainForMeeting = async () => ({
    recording: null,
    grainUrl: '',
    source: 'no_grain_recording',
  });
  workflow.hubspot.hasMeetingNoteContaining = async () => false;
  workflow.hubspot.createPostPromptMarker = async marker => {
    markers.push(marker);
    return { id: 'note-1' };
  };

  const stats = await workflow.runPostMeetingScan(new Date('2026-06-08T17:00:00.000Z'));

  assert.equal(stats.prompted, 1);
  assert.equal(posts.length, 1);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].marker, 'sales_admin_post_prompt:89305622:trove-meeting');
  assert.equal(markers[0].promptKey, 'post:trove-meeting:89305622');
  assert.equal(markers[0].slackChannel, 'C_XAVIER');
  assert.equal(markers[0].slackTs, '1.234');
  assert.equal(workflow.state.get('post:trove-meeting:89305622').hubspotPromptMarkerStatus, 'created');
});

test('sales admin post-meeting scan skips automatic prompts for closed deals', async () => {
  const posts = [];
  let grainFetchCount = 0;
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => { posts.push(payload); return { ts: '1', channel: payload.channel }; } } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Xavier Marco', hubspotOwnerId: '89305622', email: 'xavier@trytruewind.com', slackUserId: 'U0AKMHVCJMA', salesAdminChannel: 'gtm-salesadmin-xavier' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-closed-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('89305622', 'C_XAVIER');
  workflow.meetingsForToday = async () => [{
    id: 'pkf-meeting',
    properties: {
      hs_meeting_title: 'Alex <> Nkrumah: Connect',
      hs_meeting_start_time: '2026-06-03T20:00:00.000Z',
      hs_meeting_end_time: '2026-06-03T20:30:00.000Z',
    },
    _companies: [{ id: 'c1', name: "PKF O'Connor Davies" }],
    _deals: [{ id: 'deal-1', dealname: "PKF O'Connor Davies - New Deal", pipeline: '105321581', dealstage: '190380587' }],
  }];
  workflow.buildStageDecisionForMeeting = async () => buildStageDecision({
    deal: { id: 'deal-1', dealname: "PKF O'Connor Davies - New Deal", pipeline: '105321581', dealstage: '190380587' },
    stages: STAGES.map(stage => stage.id === '190380587' ? { ...stage, metadata: { isClosed: 'true' } } : stage),
  });
  workflow.fetchGrainForMeeting = async () => {
    grainFetchCount += 1;
    return { recording: null, grainUrl: '', source: 'no_grain_recording' };
  };

  const stats = await workflow.runPostMeetingScan(new Date('2026-06-03T21:00:00.000Z'));

  assert.equal(stats.prompted, 0);
  assert.equal(stats.skipped, 1);
  assert.equal(posts.length, 0);
  assert.equal(grainFetchCount, 0);

  const forcedStats = await workflow.runPostMeetingScan(new Date('2026-06-03T21:00:00.000Z'), {
    ownerId: '89305622',
    meetingId: 'pkf-meeting',
    force: true,
  });

  assert.equal(forcedStats.prompted, 0);
  assert.equal(forcedStats.skipped, 1);
  assert.equal(posts.length, 0);
  assert.equal(grainFetchCount, 0);
});

test('sales admin post-meeting prompt defaults to no-show when no Grain recording exists', async () => {
  const posts = [];
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async payload => { posts.push(payload); return { ts: '1', channel: payload.channel }; } } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Xavier Marco', hubspotOwnerId: '89305622', email: 'xavier@trytruewind.com', slackUserId: 'U0AKMHVCJMA', salesAdminChannel: 'gtm-salesadmin-xavier' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-no-grain-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.channelIdsByOwnerId.set('89305622', 'C_XAVIER');
  workflow.meetingsForToday = async () => [{
    id: 'no-grain-meeting',
    properties: {
      hs_meeting_title: 'Intro to Truewind',
      hs_meeting_start_time: '2026-06-03T17:00:00.000Z',
      hs_meeting_end_time: '2026-06-03T17:30:00.000Z',
    },
    _companies: [{ id: 'c1', name: 'Mysite' }],
    _deals: [],
  }];
  workflow.fetchGrainForMeeting = async () => ({ recording: null, grainUrl: '', source: 'no_grain_recording' });
  workflow.buildStageDecisionForMeeting = async () => null;

  const stats = await workflow.runPostMeetingScan(new Date('2026-06-03T18:00:00.000Z'));

  assert.equal(stats.prompted, 1);
  const headerBlock = posts[0].blocks[0];
  assert.match(headerBlock.text.text, /Doesn't look like they showed up/);
  assert.match(headerBlock.text.text, /\*No-Show\*/);
  // No-show message is minimal: header, context line, actions — no stage/next-step/Grain blocks.
  assert.ok(!posts[0].blocks.some(block => block.block_id === 'deal_stage'), 'no stage block on no-show');
  assert.ok(!posts[0].blocks.some(block => block.text?.text?.includes('*HubSpot Next Step*')), 'no next-step block on no-show');
  assert.ok(!posts[0].blocks.some(block => block.text?.text?.includes('*Suggested follow-up from Grain*')), 'no Grain block on no-show');
  const actions = posts[0].blocks.find(block => block.type === 'actions');
  assert.deepEqual(actions.elements.map(element => element.type === 'button' ? element.text.text : element.options[0].text.text), ['No-Show', 'Confirm Completed', 'Edit Notes', 'Not this meeting']);
  assert.equal(actions.elements[0].style, 'primary');
  assert.equal(actions.elements[0].action_id, POST_ACTIONS.noShow);
  assert.equal(workflow.state.get('post:no-grain-meeting:89305622').grainSource, 'no_grain_recording');
});

test('sales admin confirmation updates HubSpot deal next step summary', async () => {
  const propertyUpdates = [];
  const notes = [];
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async () => ({ ts: 'reply' }) } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-write-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.hubspot = {
    updateDealStage: async () => ({}),
    updateDealProperty: async (dealId, propertyName, value) => {
      propertyUpdates.push({ dealId, propertyName, value });
      return {};
    },
    createNote: async input => {
      notes.push(input.body);
      return { id: 'note-1' };
    },
    createTask: async () => ({ id: 'task-1' }),
  };
  const stageDecision = buildStageDecision({
    deal: { id: 'deal-1', dealname: 'Acme', pipeline: '105321581', dealstage: '190380582' },
    stages: STAGES,
  });
  workflow.state.set('post:m1:84547076', {
    ae: { name: 'Sarah Elix', email: 'sarah@trytruewind.com', hubspotOwnerId: '84547076' },
    meeting: { id: 'm1', properties: { hs_meeting_title: 'Intro', hs_meeting_start_time: '2026-06-03T18:00:00.000Z' }, _deals: [{ id: 'deal-1' }] },
    extraction: { summary: 'Acme is interested in AP automation and needs pricing follow-up.', nextSteps: [{ text: 'Send pricing' }] },
    nextStepDatePrefix: '06/08',
    grainUrl: 'https://grain.com/share/recording/grain-1',
    stageDecision,
    slackChannel: 'C_SARAH',
    slackTs: '1',
  });

  const updated = await workflow.writeMeetingOutcome('post:m1:84547076', {
    status: 'confirmed',
    selectedStageId: '190380582',
    slackUserId: 'U_TEST',
  });

  assert.deepEqual(propertyUpdates, [{ dealId: 'deal-1', propertyName: 'hs_next_step', value: '06/08: Send pricing; Acme is interested in AP automation and needs pricing follow-up.' }]);
  assert.equal(updated.hubspotNextStep, '06/08: Send pricing; Acme is interested in AP automation and needs pricing follow-up.');
  assert.equal(updated.nextStepPropertyUpdate.updated, true);
  assert.match(notes[0], /HubSpot Next step: 06\/08: Send pricing; Acme is interested/);
  assert.match(notes[0], /- Send pricing/);
});

test('sales admin no-show sets HubSpot meeting outcome and writes a no-show note', async () => {
  const outcomeCalls = [];
  const notes = [];
  let stageUpdated = false;
  let nextStepUpdated = false;
  const workflow = new SalesAdminWorkflow({
    app: { client: { chat: { postMessage: async () => ({ ts: 'reply' }) } } },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-noshow-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.hubspot = {
    updateDealStage: async () => { stageUpdated = true; return {}; },
    updateDealProperty: async () => { nextStepUpdated = true; return {}; },
    updateMeetingOutcome: async (meetingId, outcome) => { outcomeCalls.push({ meetingId, outcome }); return {}; },
    createNote: async input => { notes.push(input.body); return { id: 'note-1' }; },
    createTask: async () => ({ id: 'task-1' }),
  };
  workflow.state.set('post:m1:84547076', {
    ae: { name: 'Sarah Elix', email: 'sarah@trytruewind.com', hubspotOwnerId: '84547076' },
    meeting: { id: 'm1', properties: { hs_meeting_title: 'Intro', hs_meeting_start_time: '2026-06-03T18:00:00.000Z' }, _deals: [{ id: 'deal-1' }] },
    extraction: { summary: '', nextSteps: [] },
    slackChannel: 'C_SARAH',
    slackTs: '1',
  });

  const updated = await workflow.writeMeetingOutcome('post:m1:84547076', { status: 'no_show', slackUserId: 'U_TEST' });

  assert.deepEqual(outcomeCalls, [{ meetingId: 'm1', outcome: 'NO_SHOW' }]);
  assert.equal(stageUpdated, false, 'no-show must not move the deal stage');
  assert.equal(nextStepUpdated, false, 'no-show must not update Next step');
  assert.equal(updated.status, 'no_show');
  assert.match(notes[0], /No[- ]?show/i);
  assert.match(notes[0], /meeting outcome set to No-Show/i);
});

test('sales admin edit action acks before opening modal', async () => {
  const handlers = {};
  const workflow = new SalesAdminWorkflow({
    app: {
      client: {},
      action: (actionId, handler) => { handlers[actionId] = handler; },
      view: () => {},
    },
    hubspotRequest: async () => ({ results: [] }),
    anthropic: null,
    env: {
      SALES_ADMIN_ENABLED: 'true',
      SALES_ADMIN_AE_ROSTER_JSON: JSON.stringify([
        { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
      ]),
      SALES_ADMIN_STATE_PATH: path.join(os.tmpdir(), `sales-admin-edit-${Date.now()}-${Math.random()}.json`),
      SLACK_BOT_TOKEN: 'xoxb-test',
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  workflow.registerHandlers();
  let acked = false;
  let stateReadAfterAck = false;
  let openedPayload = null;
  workflow.state.get = () => {
    stateReadAfterAck = acked;
    return {
      meeting: { id: 'm1', properties: { hs_meeting_title: 'Intro' } },
      extraction: { summary: 'Acme is evaluating Truewind and needs pricing follow-up.' },
      stageDecision: null,
    };
  };

  await handlers[POST_ACTIONS.edit]({
    ack: async () => { acked = true; },
    body: { trigger_id: 'trigger-1', channel: { id: 'C_SARAH' }, message: { ts: '1' }, state: { values: {} }, container: {} },
    action: { value: 'post:m1:84547076' },
    client: {
      views: { open: async payload => { openedPayload = payload; return { ok: true }; } },
      chat: { postMessage: async () => ({ ok: true }) },
    },
  });

  assert.equal(acked, true);
  assert.equal(stateReadAfterAck, true);
  assert.equal(openedPayload.trigger_id, 'trigger-1');
  assert.equal(openedPayload.view.callback_id, POST_ACTIONS.editSubmit);
});

test('sales admin state persists idempotency records', () => {
  const file = path.join(os.tmpdir(), `sales-admin-state-${Date.now()}-${Math.random()}.json`);
  const state = createSalesAdminState(file, { error() {}, warn() {}, log() {} });
  state.set('cancel:m1:owner', { status: 'alerted' });
  const reloaded = createSalesAdminState(file, { error() {}, warn() {}, log() {} });
  assert.equal(reloaded.get('cancel:m1:owner').status, 'alerted');
});

test('sales admin writeback note separates cancellation/no-show from confirmed next steps', () => {
  const note = buildWritebackNote({
    ae: { name: 'Sarah Elix', email: 'sarah@trytruewind.com' },
    meeting: meeting({ hs_meeting_title: 'Intro', hs_meeting_start_time: '2026-06-03T18:00:00.000Z' }),
    status: 'no_show',
    extraction: { outcome: 'Meeting completed', nextSteps: [{ text: 'Send proposal' }] },
  });
  assert.match(note, /Status: no_show/);
  assert.match(note, /Outcome: No show/);
  assert.doesNotMatch(note, /Send proposal/);
  assert.doesNotMatch(note, /Confirmed deal stage:/);
});

test('sales admin writeback note records selected deal stage movement', () => {
  const stageDecision = buildStageDecision({
    deal: { id: 'deal-1', dealname: 'Acme', pipeline: '105321581', dealstage: '190380582' },
    stages: STAGES,
  });
  const note = buildWritebackNote({
    ae: { name: 'Sarah Elix', email: 'sarah@trytruewind.com' },
    meeting: meeting({ hs_meeting_title: 'Intro', hs_meeting_start_time: '2026-06-03T18:00:00.000Z' }),
    status: 'confirmed',
    extraction: { outcome: 'Meeting completed', summary: 'Prospect is ready for proposal follow-up.', nextSteps: [{ text: 'Send proposal package and confirm final approval path with finance sponsor', dueDate: '2026-06-12' }] },
    hubspotNextStep: 'Prospect is ready for proposal follow-up.',
    stageDecision,
    selectedStageId: '190380583',
    stageUpdate: { updated: true, fromLabel: 'Stage 2: SQL (Full Product Demo)', toLabel: 'Stage 3: Awaiting Materials' },
  });
  assert.match(note, /Deal stage before confirmation: Stage 2/);
  assert.match(note, /Confirmed deal stage: Stage 3: Awaiting Materials/);
  assert.match(note, /Deal stage updated in HubSpot: Stage 2: SQL \(Full Product Demo\) -> Stage 3: Awaiting Materials/);
  assert.match(note, /HubSpot Next step: Prospect is ready for proposal follow-up/);
  assert.match(note, /- Send proposal package and confirm final approval path with finance sponsor \(Due: 2026-06-12\)/);
});
