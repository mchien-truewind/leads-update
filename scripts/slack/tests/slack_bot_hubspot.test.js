const assert = require('assert');

process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'xoxb-test';
process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'test-secret';
process.env.SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || 'xapp-test';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-secret';
process.env.GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || 'test-refresh';
process.env.RECRUITING_CALENDAR_ALLOWED_SLACK_USER_IDS = process.env.RECRUITING_CALENDAR_ALLOWED_SLACK_USER_IDS || 'U_TEST';
process.env.SLACK_TO_HUBSPOT_OWNER_JSON = JSON.stringify({
  U_TEST: { id: '89305622', name: 'Xavier Marco' },
});

const {
  TOOLS,
  TRUEWIND_HUBSPOT,
  __setHubSpotRequestOverrideForTests,
  buildDealNoteBody,
  buildRecruitingCalendarInvite,
  classifyProgressDealSource,
  activityDisplayFields,
  deduceLeadSource,
  dealEnteredStageInRange,
  executeTool,
  findRecruitingCandidateByEmail,
  extractStructuredBlockField,
  firstOutcomeAfterEntry,
  formatProspectWorkflowResponse,
  getSystemPrompt,
  grainRecordingMatchesSearch,
  hubSpotPipelineEndpoint,
  hubSpotObjectType,
  hubspotPrimaryAssociatedRecordUrl,
  hubspotPropertyCache,
  hubspotRecordUrl,
  isHubSpotWriteAuthorized,
  pickHubSpotOwnerForProfile,
  isReadOnlyHubSpotProperty,
  isRecruitingCalendarWriteAuthorized,
  hasRecruitingCalendarTitleInput,
  notionPropValue,
  recruitingCalendarTitleFromCandidate,
  recruitingNotionPropertyMap,
  normalizeHubSpotObjectTypeId,
  normalizeHubSpotOutcomeTracking,
  parseHubSpotAsOfBoundary,
  parseHubSpotDateBoundary,
  parseGrainSearchDateRange,
  parseStructuredDealRequest,
  parseProgressDealSourceProperty,
  redactedToolInputForLog,
  resolveDealHubSpotOwner,
  resolveHubSpotOwner,
  resolveHubSpotOwnerForProspect,
  resolveProspectWorkflowOwner,
  matchingActivityKeywords,
  runStructuredDealCreateWorkflow,
  summarizeHubSpotStageCohortOutcomes,
  validateHubSpotProperties,
} = require('../slack_bot');

function seedHubSpotProperty(objectType, name, overrides = {}) {
  hubspotPropertyCache.set(`${objectType}:${name}`, {
    name,
    readOnlyValue: false,
    calculated: false,
    options: [],
    ...overrides,
  });
}

function seedStructuredDealWorkflowProperties() {
  for (const property of ['email', 'firstname', 'lastname', 'company', 'jobtitle', 'contact_type', 'erp', 'lead_source', 'hubspot_owner_id', 'lifecyclestage', 'hs_lead_status', 'linkedin___profile', 'hs_linkedin_url', 'linkedin_profile_url']) {
    seedHubSpotProperty('contacts', property);
  }
  for (const property of ['name', 'domain']) {
    seedHubSpotProperty('companies', property);
  }
  for (const property of ['dealname', 'pipeline', 'dealstage', 'hubspot_owner_id', 'deal_source', 'erp', 'amount', 'closedate']) {
    seedHubSpotProperty('deals', property);
  }
}

async function testConvertedLeadStatusUsesInternalValue() {
  assert.strictEqual(TRUEWIND_HUBSPOT.convertedLeadStatus, 'MQL');
  seedHubSpotProperty('contacts', 'hs_lead_status', {
    options: [
      { label: 'Converted', value: 'MQL' },
      { label: 'No one has contacted them', value: 'No one has contacted them' },
    ],
  });

  assert.deepStrictEqual(
    await validateHubSpotProperties('contacts', { hs_lead_status: 'Converted' }),
    { hs_lead_status: 'MQL' },
  );
}

async function testReadOnlyDealPropertiesAreRejectedBeforeWrite() {
  seedHubSpotProperty('deals', 'hs_deal_stage_probability_shadow', {
    modificationMetadata: { readOnlyValue: true },
  });
  assert.strictEqual(
    isReadOnlyHubSpotProperty({ modificationMetadata: { readOnlyValue: true } }),
    true,
  );

  const result = await executeTool('hubspot_update_deal', {
    deal_id: '123',
    slack_user_id: 'U_TEST',
    properties: { hs_deal_stage_probability_shadow: '0.5' },
  });

  assert.match(result, /read-only/);
  assert.match(result, /hs_deal_stage_probability_shadow/);
}

async function testLowLevelHubSpotWritesRequireAuthorization() {
  const result = await executeTool('hubspot_create_deal', {
    dealname: 'Unauthorized Deal',
    dealstage: TRUEWIND_HUBSPOT.mqlDealStage,
  });

  assert.match(result, /not authorized to write to HubSpot/);

  const noteResult = await executeTool('hubspot_create_note', {
    body: 'Referral note',
    deal_id: '60316278406',
  });

  assert.match(noteResult, /not authorized to write to HubSpot/);
}

async function testReadOnlyDefinitionDoesNotBlockWritableStandardFields() {
  seedHubSpotProperty('deals', 'dealname', {
    modificationMetadata: { readOnlyDefinition: true, readOnlyValue: false },
  });
  seedHubSpotProperty('contacts', 'firstname', {
    modificationMetadata: { readOnlyDefinition: true, readOnlyValue: false },
  });

  assert.strictEqual(
    isReadOnlyHubSpotProperty({ modificationMetadata: { readOnlyDefinition: true, readOnlyValue: false } }),
    false,
  );
  assert.deepStrictEqual(
    await validateHubSpotProperties('deals', { dealname: 'ThinkScan - New Deal' }),
    { dealname: 'ThinkScan - New Deal' },
  );
  assert.deepStrictEqual(
    await validateHubSpotProperties('contacts', { firstname: 'Deepak' }),
    { firstname: 'Deepak' },
  );
}

function testStructuredDealRequestParser() {
  const parsed = parseStructuredDealRequest(`create a new deal in S1
Company: ThinkScan
Type: direct services
Contact: Deepak Rana
Email: <drana@thinkscan.ai>
Deal owner: Xavier Marco
Source: Referral
Meeting booked for Monday May 18
Notes: referred by Mike Ricci`);

  assert.strictEqual(parsed.company, 'ThinkScan');
  assert.strictEqual(parsed.type, 'direct services');
  assert.strictEqual(parsed.contact, 'Deepak Rana');
  assert.strictEqual(parsed.email, 'drana@thinkscan.ai');
  assert.strictEqual(parsed.owner_name, 'Xavier Marco');
  assert.strictEqual(parsed.lead_source, 'Referral');
  assert.strictEqual(parsed.meeting_booked, 'Monday May 18');
  assert.strictEqual(parsed.notes, 'referred by Mike Ricci');
  assert.strictEqual(parsed.dealstage, TRUEWIND_HUBSPOT.mqlDealStage);

  const mailtoParsed = parseStructuredDealRequest(`add deal
Company: ThinkScan
Contact: Deepak Rana
Email: <mailto:drana@thinkscan.ai|drana@thinkscan.ai>`);
  assert.strictEqual(mailtoParsed.email, 'drana@thinkscan.ai');

  assert.strictEqual(parseStructuredDealRequest('please summarize the ThinkScan account'), null);
  assert.strictEqual(parseStructuredDealRequest('create a new deal once we have details'), null);
}

function testStructuredNotesCanBeMultiline() {
  const parsed = parseStructuredDealRequest(`create a new deal in S1
Company: ThinkScan
Contact: Deepak Rana
Email: drana@thinkscan.ai
Notes:
a former customer Mike Ricci at Spect is an advisor.
He referred them to Truewind.
Source: Referral`);

  assert.strictEqual(parsed.notes, 'a former customer Mike Ricci at Spect is an advisor.\nHe referred them to Truewind.');
  assert.strictEqual(parsed.lead_source, 'Referral');
  assert.strictEqual(
    extractStructuredBlockField('Notes: first line\nsecond line\nLinkedIn: https://linkedin.com/in/example', 'Notes', ['Company', 'LinkedIn']),
    'first line\nsecond line',
  );
}

function testDealNoteBodyEscapesAndIncludesFields() {
  assert.strictEqual(
    buildDealNoteBody({
      type: 'direct services',
      meeting_booked: 'Monday May 18',
      notes: 'Mike said "use <Truewind>"\nSecond line & detail',
    }),
    'Type: direct services<br>Meeting booked for: Monday May 18<br>Notes: Mike said &quot;use &lt;Truewind&gt;&quot;<br>Second line &amp; detail',
  );
}

async function testExplicitOwnerOverridesSlackMapping() {
  const owner = resolveHubSpotOwner({ slack_user_id: 'U_TEST', owner_name: 'Mercedes' });
  assert.deepStrictEqual(owner, { id: '87811681', name: 'Mercedes Chien', source: 'explicit owner' });
  assert.deepStrictEqual(
    await resolveHubSpotOwnerForProspect({ slack_user_id: 'U_TEST', owner_name: 'Mercedes' }),
    { id: '87811681', name: 'Mercedes Chien', source: 'explicit owner' },
  );
  assert.deepStrictEqual(
    await isHubSpotWriteAuthorized({ slack_user_id: 'U_TEST' }, owner),
    { authorized: true, reason: 'Slack user maps to HubSpot owner' },
  );
  assert.strictEqual(
    (await isHubSpotWriteAuthorized({ slack_user_id: 'U_UNMAPPED' }, owner)).authorized,
    false,
  );
}

async function testGtmSlackUsersMapToHubSpotOwners() {
  const expectedMappings = [
    ['U0ATZSNCE5T', '91143842', 'Jenilee Chen'],
    ['U0AURH4KMRN', '91143844', 'Brendan Moody'],
    ['U0AKMHVCJMA', '89305622', 'Xavier Marco'],
    ['U09QC3B292R', '84547076', 'Sarah Elix'],
    ['U04BPMPR29G', '559564379', 'Alex Lee'],
    ['U0B4MRN83FE', '92555980', 'Amy Vetter'],
    ['U0ABULY5TEK', '91143842', 'Jenilee Chen'],
  ];

  for (const [slackUserId, hubspotOwnerId, name] of expectedMappings) {
    const owner = resolveHubSpotOwner({ slack_user_id: slackUserId });
    assert.deepStrictEqual(owner, { id: hubspotOwnerId, name, source: 'from Slack tag' });
    assert.deepStrictEqual(
      await isHubSpotWriteAuthorized({ slack_user_id: slackUserId }, owner),
      { authorized: true, reason: 'Slack user maps to HubSpot owner' },
    );
  }
}

function testDynamicOwnerMatchByEmailAndName() {
  const owners = [
    { id: '111', email: 'andrew@trytruewind.com', firstName: 'Andrew', lastName: 'Moyer' },
    { id: '222', email: 'ari@trytruewind.com', firstName: 'Ari', lastName: 'Nachman' },
  ];
  // Email match (preferred), case-insensitive.
  assert.deepStrictEqual(
    pickHubSpotOwnerForProfile({ email: 'ANDREW@trytruewind.com', realName: 'Andrew M' }, owners),
    { id: '111', name: 'Andrew Moyer' },
  );
  // Name fallback when Slack email differs from the HubSpot owner email.
  assert.deepStrictEqual(
    pickHubSpotOwnerForProfile({ email: 'ari.personal@gmail.com', realName: 'ari nachman' }, owners),
    { id: '222', name: 'Ari Nachman' },
  );
  // No match → null (caller falls back to allowlist/default).
  assert.strictEqual(
    pickHubSpotOwnerForProfile({ email: 'stranger@example.com', realName: 'Random Person' }, owners),
    null,
  );
}

function testLeadSourceDefaultsToOutbound() {
  assert.strictEqual(deduceLeadSource('please create this outbound deal'), 'Outbound - Sales Sourced List');
  assert.strictEqual(deduceLeadSource(''), 'Outbound - Sales Sourced List');
}

function testDealOwnerResolution() {
  assert.deepStrictEqual(
    resolveDealHubSpotOwner({ owner_name: 'Sarah Elix', company: 'Acme' }, { id: '91143842', name: 'Jenilee Chen', source: 'from Slack tag' }),
    { id: '84547076', name: 'Sarah Elix', source: 'explicit deal owner' },
  );
  assert.deepStrictEqual(
    resolveDealHubSpotOwner({ owner_name: 'Alex Lee', company: 'Acme' }, { id: '89305622', name: 'Xavier Marco', source: 'from Slack tag' }),
    { id: '559564379', name: 'Alex Lee', source: 'explicit deal owner' },
  );
  assert.deepStrictEqual(
    resolveProspectWorkflowOwner({ company: 'Acme' }, { id: '559564379', name: 'Alex Lee', source: 'from Slack tag' }),
    { id: '559564379', name: 'Alex Lee', source: 'from Slack tag' },
  );
  const hashed = resolveDealHubSpotOwner({ company: 'Hash Co', email: 'buyer@hashco.com' }, { id: '91143842', name: 'Jenilee Chen', source: 'from Slack tag' });
  assert.ok(['84547076', '89305622'].includes(hashed.id));
  assert.deepStrictEqual(
    resolveDealHubSpotOwner({ company: 'Hash Co', email: 'buyer@hashco.com' }, { id: '91143842', name: 'Jenilee Chen', source: 'from Slack tag' }),
    hashed,
  );
}

function testDealNotesPromptAndTools() {
  const toolNames = new Set(TOOLS.map((tool) => tool.name));
  assert.strictEqual(toolNames.has('grain_search_recordings'), true);
  assert.strictEqual(toolNames.has('grain_get_recording'), true);
  assert.strictEqual(toolNames.has('hubspot_get_associated_activities'), true);
  assert.strictEqual(toolNames.has('hubspot_get_pipeline'), true);
  assert.strictEqual(toolNames.has('hubspot_count_deals_entered_stage'), true);
  assert.strictEqual(toolNames.has('hubspot_analyze_deal_activities'), true);
  assert.strictEqual(toolNames.has('recruiting_create_calendar_invite'), true);
  assert.strictEqual(hubSpotPipelineEndpoint(), '/crm/v3/pipelines/deals/105321581');
  assert.strictEqual(hubSpotPipelineEndpoint('custom pipeline'), '/crm/v3/pipelines/deals/custom%20pipeline');
  assert.strictEqual(hubSpotObjectType('meetings'), '0-47');
  assert.strictEqual(hubSpotObjectType('calls'), '0-48');
  assert.strictEqual(hubSpotObjectType('emails'), '0-49');
  assert.strictEqual(hubSpotObjectType('tasks'), '0-27');
  assert.match(
    TOOLS.find((tool) => tool.name === 'grain_search_recordings').input_schema.properties.max_pages.description,
    /coverage\.truncated/,
  );
  assert.match(
    TOOLS.find((tool) => tool.name === 'hubspot_get_associated_activities').input_schema.properties.limit_per_type.description,
    /coverage\.truncated/,
  );
  assert.match(
    TOOLS.find((tool) => tool.name === 'hubspot_get_pipeline').input_schema.properties.pipeline_id.description,
    /105321581/,
  );
  assert.match(
    TOOLS.find((tool) => tool.name === 'hubspot_count_deals_entered_stage').description,
    /dealstage property history/,
  );
  assert.match(
    TOOLS.find((tool) => tool.name === 'hubspot_count_deals_entered_stage').input_schema.properties.track_outcomes.description,
    /cohort outcome tracking/,
  );
  assert.match(
    TOOLS.find((tool) => tool.name === 'hubspot_count_deals_entered_stage').input_schema.properties.track_outcomes.description,
    /first tracked outcome stage/,
  );
  assert.match(
    TOOLS.find((tool) => tool.name === 'hubspot_analyze_deal_activities').description,
    /no-shows/,
  );
  assert.match(
    TOOLS.find((tool) => tool.name === 'hubspot_analyze_deal_activities').input_schema.properties.max_deals.description,
    /coverage\.warning/,
  );

  const prompt = getSystemPrompt();
  assert.match(prompt, /Deal notes and deal summaries/);
  assert.match(prompt, /Do not expect manual AE documentation/);
  assert.match(prompt, /Never rely only on recording titles/);
  assert.match(prompt, /coverage\.truncated/);
  assert.match(prompt, /Pain Points & Requirements/);
  assert.match(prompt, /Risks & Blockers/);
  assert.match(prompt, /HubSpot stage verification rule/);
  assert.match(prompt, /ALWAYS call hubspot_get_pipeline with pipeline_id 105321581/);
  assert.match(prompt, /Deal stages, stage names, or stage movements/);
  assert.match(prompt, /Pipeline summaries or deal counts by stage/);
  assert.match(prompt, /Any mention of S1, S2, S3, S4, S5, MQL, SQL, POC, Proposal/);
  assert.match(prompt, /Questions about "where is \[deal name\]", deal status, or the current state of an opportunity/);
  assert.match(prompt, /The only source of truth for stage configuration is the real-time API response from hubspot_get_pipeline/);
  assert.match(prompt, /Critical HubSpot data freshness/);
  assert.match(prompt, /You MUST call the relevant HubSpot API for every HubSpot question/);
  assert.match(prompt, /HubSpot record links/);
  assert.match(prompt, /Deal disambiguation/);
  assert.match(prompt, /Only ask for clarification if multiple open deals have similar recent activity/);
  assert.match(prompt, /hubspot_count_deals_entered_stage/);
  assert.match(prompt, /Do not use createdate, current dealstage only, or hs_date_entered_\{stageId\}/);
  assert.match(prompt, /true cohort conversion questions/);
  assert.match(prompt, /track_outcomes\.stages/);
  assert.match(prompt, /cohort_outcomes\.outcomes\.still_active/);
  assert.match(prompt, /hubspot_analyze_deal_activities/);
  assert.match(prompt, /no-show, ghosted, missed meeting/);
  assert.match(prompt, /Recruiting calendar scheduling/);
  assert.match(prompt, /recruiting_create_calendar_invite/);
}

function testRecruitingCalendarInviteBuilderAndAuthorization() {
  assert.deepStrictEqual(
    isRecruitingCalendarWriteAuthorized({ __trusted_slack_metadata: { slack_user_id: 'U_TEST' } }),
    { authorized: true, reason: 'Slack user explicitly allowed for recruiting calendar writes' },
  );
  assert.strictEqual(
    isRecruitingCalendarWriteAuthorized({ slack_user_id: 'U_TEST' }).authorized,
    false,
  );
  assert.strictEqual(
    isRecruitingCalendarWriteAuthorized({ __trusted_slack_metadata: { slack_user_id: 'U_OTHER' } }).authorized,
    false,
  );

  const payload = buildRecruitingCalendarInvite({
    candidate_email: 'Candidate@Example.com',
    candidate_name: 'Casey Candidate',
    start_datetime: '2026-05-28T14:00:00-07:00',
    duration_minutes: 20,
    __trusted_slack_metadata: {
      channel_id: 'C123',
      slack_user_id: 'U_TEST',
      thread_ts: '1770000000.000100',
    },
  });

  assert.strictEqual(payload.calendarId, 'primary');
  assert.strictEqual(payload.conferenceDataVersion, 1);
  assert.strictEqual(payload.sendUpdates, 'all');
  assert.match(payload.event.id, /^rc[0-9a-f]{32}$/);
  assert.strictEqual(payload.event.summary, 'Truewind Intro Call - Casey Candidate');
  assert.deepStrictEqual(payload.event.attendees, [{ email: 'candidate@example.com' }]);
  assert.strictEqual(payload.event.start.dateTime, '2026-05-28T14:00:00-07:00');
  assert.strictEqual(payload.event.end.dateTime, '2026-05-28T21:20:00Z');
  assert.strictEqual(payload.event.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');

  const subjectTitled = buildRecruitingCalendarInvite({
    candidate_email: 'candidate@example.com',
    candidate_name: 'Casey Candidate',
    start_datetime: '2026-05-28T14:00:00-07:00',
    email_subject: 'Re: [hiring@] BDR - Casey Candidate',
    __trusted_slack_metadata: {
      channel_id: 'C123',
      slack_user_id: 'U_TEST',
      thread_ts: '1770000000.000100',
    },
  });
  assert.strictEqual(subjectTitled.event.summary, 'BDR - Casey Candidate');
  assert.strictEqual(hasRecruitingCalendarTitleInput({ email_subject: 'Re: [hiring@] BDR - Casey Candidate' }), true);
  assert.strictEqual(hasRecruitingCalendarTitleInput({ candidate_email: 'candidate@example.com' }), false);
  assert.strictEqual(hasRecruitingCalendarTitleInput({ email_subject: 'Re: [hiring@]' }), false);
  assert.strictEqual(
    recruitingCalendarTitleFromCandidate({ role: 'BDR', candidate_name: 'Casey Candidate' }),
    'BDR - Casey Candidate',
  );
  assert.strictEqual(
    recruitingCalendarTitleFromCandidate({ role: 'Growth Generalist', candidate_name: 'Unknown' }),
    'Growth Generalist',
  );

  assert.throws(
    () => buildRecruitingCalendarInvite({ candidate_email: 'candidate@example.com', start_datetime: '2026-05-28T14:00:00' }),
    /ISO datetime with timezone/,
  );
  assert.throws(
    () => buildRecruitingCalendarInvite({ candidate_email: 'candidate@example.com', start_datetime: '2026-05-28T14:00:00-07:00', duration_minutes: 'later' }),
    /duration_minutes must be a number/,
  );

  const logged = redactedToolInputForLog('recruiting_create_calendar_invite', {
    candidate_email: 'candidate@example.com',
    candidate_name: 'Casey Candidate',
    extra_attendees: ['interviewer@example.com'],
    title: 'Truewind Intro Call - Casey Candidate',
    summary: 'Truewind Intro Call - Casey Candidate',
    description: 'Talk with Casey Candidate at candidate@example.com',
    attendees: [{ email: 'candidate@example.com' }],
    start_datetime: '2026-05-28T14:00:00-07:00',
  });
  assert.doesNotMatch(logged, /candidate@example\.com|Casey Candidate|interviewer@example\.com/);
  assert.match(logged, /2026-05-28T14:00:00-07:00/);
  assert.match(logged, /redacted/);
}

async function testRecruitingCalendarInviteExecuteToolAuthAndIdempotency() {
  let insertCalls = 0;
  let getCalls = 0;
  let insertedRequest = null;
  const calendarService = {
    events: {
      insert: async (request) => {
        insertCalls += 1;
        insertedRequest = request;
        const err = new Error('duplicate');
        err.code = 409;
        throw err;
      },
      get: async (request) => {
        getCalls += 1;
        return {
          data: {
            id: request.eventId,
            summary: 'Truewind Intro Call - Casey Candidate',
            htmlLink: 'https://calendar.google.com/event?eid=test',
            start: { dateTime: '2026-05-28T14:00:00-07:00' },
            end: { dateTime: '2026-05-28T21:20:00Z' },
            attendees: [{ email: 'candidate@example.com' }],
            conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/test' }] },
          },
        };
      },
    },
  };

  const spoofed = await executeTool('recruiting_create_calendar_invite', {
    candidate_email: 'candidate@example.com',
    candidate_name: 'Casey Candidate',
    start_datetime: '2026-05-28T14:00:00-07:00',
    slack_user_id: 'U_TEST',
    __trusted_slack_metadata: { slack_user_id: 'U_TEST' },
  }, { calendar_service: calendarService });
  assert.match(spoofed, /not authorized to create recruiting calendar invite/);
  assert.strictEqual(insertCalls, 0);

  const created = await executeTool('recruiting_create_calendar_invite', {
    candidate_email: 'candidate@example.com',
    candidate_name: 'Casey Candidate',
    start_datetime: '2026-05-28T14:00:00-07:00',
    extra_attendees: ['interviewer@example.com'],
    slack_user_id: 'U_OTHER_SHOULD_BE_IGNORED',
  }, {
    slack_user_id: 'U_TEST',
    channel_id: 'C123',
    thread_ts: '1770000000.000100',
    calendar_service: calendarService,
  });
  const parsed = JSON.parse(created);
  assert.match(parsed.id, /^rc[0-9a-f]{32}$/);
  assert.strictEqual(parsed.meetUrl, 'https://meet.google.com/test');
  assert.strictEqual(insertCalls, 1);
  assert.strictEqual(getCalls, 1);
  assert.strictEqual(insertedRequest.calendarId, 'primary');
  assert.strictEqual(insertedRequest.requestBody.summary, 'Truewind Intro Call - Casey Candidate');
  assert.deepStrictEqual(
    insertedRequest.requestBody.attendees,
    [{ email: 'candidate@example.com' }, { email: 'interviewer@example.com' }],
  );
  assert.strictEqual(insertedRequest.body, undefined);
}

function fakeNotionCandidatePage({ email = 'gina@example.com', candidateName = 'Gina Yu', role = 'BDR' } = {}) {
  return {
    id: 'page-1',
    url: 'https://www.notion.so/page1',
    properties: {
      'Candidate Name': { type: 'title', title: [{ plain_text: candidateName }] },
      Email: { type: 'email', email },
      'Role at Truewind': { type: 'multi_select', multi_select: [{ name: role }] },
      Status: { type: 'select', select: { name: 'Interview Scheduled' } },
    },
  };
}

function fakeRecruitingAtsSchema() {
  return {
    properties: {
      'Candidate Name': { type: 'title' },
      Email: { type: 'email' },
      'Role at Truewind': { type: 'multi_select' },
      Status: { type: 'select' },
    },
  };
}

async function testRecruitingCalendarInviteInfersTitleFromAts() {
  const oldDb = process.env.NOTION_DATABASE_ID;
  const oldDbAlias = process.env.NOTION_ATS_DB_ID;
  const oldToken = process.env.NOTION_INTERNAL_INTEGRATION_SECRET;
  const oldTokenAlias = process.env.NOTION_INTERNAL_INTEGRATION;
  process.env.NOTION_DATABASE_ID = 'notion-db';
  delete process.env.NOTION_ATS_DB_ID;
  process.env.NOTION_INTERNAL_INTEGRATION_SECRET = 'notion-token';
  delete process.env.NOTION_INTERNAL_INTEGRATION;

  const calendarRequests = [];
  const calendarService = {
    events: {
      insert: async (request) => {
        calendarRequests.push(request);
        return {
          data: {
            id: request.requestBody.id,
            summary: request.requestBody.summary,
            htmlLink: 'https://calendar.google.com/event?eid=test',
            start: request.requestBody.start,
            end: request.requestBody.end,
            attendees: request.requestBody.attendees,
            conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/test' }] },
          },
        };
      },
    },
  };
  const notionCalls = [];
  const notionRequest = async (endpoint, method = 'GET', body = null) => {
    notionCalls.push({ endpoint, method, body });
    if (method === 'GET') return fakeRecruitingAtsSchema();
    assert.deepStrictEqual(body.filter, {
      property: 'Email',
      email: { equals: 'ginayu75798@icloud.com' },
    });
    return { results: [fakeNotionCandidatePage({ email: 'ginayu75798@icloud.com', candidateName: 'Gina Yu', role: 'BDR' })] };
  };

  try {
    const created = await executeTool('recruiting_create_calendar_invite', {
      candidate_email: 'ginayu75798@icloud.com',
      start_datetime: '2026-06-03T13:30:00-07:00',
    }, {
      slack_user_id: 'U_TEST',
      channel_id: 'C123',
      thread_ts: '1770000000.000100',
      calendar_service: calendarService,
      notion_request: notionRequest,
    });
    const parsed = JSON.parse(created);
    assert.strictEqual(parsed.summary, 'BDR - Gina Yu');
    assert.strictEqual(calendarRequests[0].requestBody.summary, 'BDR - Gina Yu');
    assert.strictEqual(notionCalls.length, 2);
    const inferredId = calendarRequests[0].requestBody.id;

    const candidate = await findRecruitingCandidateByEmail('ginayu75798@icloud.com', { notionRequest });
    assert.strictEqual(candidate.candidate_name, 'Gina Yu');
    assert.strictEqual(candidate.role, 'BDR');

    const subjectCreated = await executeTool('recruiting_create_calendar_invite', {
      candidate_email: 'ginayu75798@icloud.com',
      start_datetime: '2026-06-03T13:30:00-07:00',
      email_subject: 'Re: [hiring@] BDR - Gina Yu',
    }, {
      slack_user_id: 'U_TEST',
      channel_id: 'C123',
      thread_ts: '1770000000.000100',
      calendar_service: calendarService,
      notion_request: notionRequest,
    });
    const subjectParsed = JSON.parse(subjectCreated);
    assert.strictEqual(subjectParsed.summary, 'BDR - Gina Yu');
    assert.strictEqual(calendarRequests[1].requestBody.id, inferredId);
  } finally {
    if (oldDb == null) delete process.env.NOTION_DATABASE_ID;
    else process.env.NOTION_DATABASE_ID = oldDb;
    if (oldDbAlias == null) delete process.env.NOTION_ATS_DB_ID;
    else process.env.NOTION_ATS_DB_ID = oldDbAlias;
    if (oldToken == null) delete process.env.NOTION_INTERNAL_INTEGRATION_SECRET;
    else process.env.NOTION_INTERNAL_INTEGRATION_SECRET = oldToken;
    if (oldTokenAlias == null) delete process.env.NOTION_INTERNAL_INTEGRATION;
    else process.env.NOTION_INTERNAL_INTEGRATION = oldTokenAlias;
  }
}

async function testRecruitingCalendarInviteAtsLookupDoesNotBlockCreation() {
  const oldDb = process.env.NOTION_DATABASE_ID;
  const oldDbAlias = process.env.NOTION_ATS_DB_ID;
  const oldToken = process.env.NOTION_INTERNAL_INTEGRATION_SECRET;
  const oldTokenAlias = process.env.NOTION_INTERNAL_INTEGRATION;
  process.env.NOTION_DATABASE_ID = 'notion-db';
  delete process.env.NOTION_ATS_DB_ID;
  process.env.NOTION_INTERNAL_INTEGRATION_SECRET = 'notion-token';
  delete process.env.NOTION_INTERNAL_INTEGRATION;

  const calendarRequests = [];
  const calendarService = {
    events: {
      insert: async (request) => {
        calendarRequests.push(request);
        return {
          data: {
            id: request.requestBody.id,
            summary: request.requestBody.summary,
            htmlLink: 'https://calendar.google.com/event?eid=test',
            start: request.requestBody.start,
            end: request.requestBody.end,
            attendees: request.requestBody.attendees,
            conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/test' }] },
          },
        };
      },
    },
  };

  try {
    let notionCalls = 0;
    const missingTime = await executeTool('recruiting_create_calendar_invite', {
        candidate_email: 'missing@example.com',
      }, {
        slack_user_id: 'U_TEST',
        channel_id: 'C123',
        thread_ts: '1770000000.000100',
        calendar_service: calendarService,
        notion_request: async () => {
          notionCalls += 1;
          throw new Error('should not call Notion before datetime validation');
        },
      });
    assert.match(missingTime, /Error: start_datetime is required/);
    assert.strictEqual(notionCalls, 0);

    const created = await executeTool('recruiting_create_calendar_invite', {
      candidate_email: 'missing@example.com',
      start_datetime: '2026-06-03T13:30:00-07:00',
    }, {
      slack_user_id: 'U_TEST',
      channel_id: 'C123',
      thread_ts: '1770000000.000100',
      calendar_service: calendarService,
      notion_request: async () => { throw new Error('notion unavailable'); },
    });
    const parsed = JSON.parse(created);
    assert.strictEqual(parsed.summary, 'Truewind Intro Call - missing@example.com');
    const fallbackId = calendarRequests[0].requestBody.id;

    const retried = await executeTool('recruiting_create_calendar_invite', {
      candidate_email: 'missing@example.com',
      start_datetime: '2026-06-03T13:30:00-07:00',
    }, {
      slack_user_id: 'U_TEST',
      channel_id: 'C123',
      thread_ts: '1770000000.000100',
      calendar_service: calendarService,
      notion_request: async (endpoint, method = 'GET', body = null) => {
        if (method === 'GET') return fakeRecruitingAtsSchema();
        assert.deepStrictEqual(body.filter.email, { equals: 'missing@example.com' });
        return { results: [fakeNotionCandidatePage({ email: 'missing@example.com', candidateName: 'Missing Person', role: 'BDR' })] };
      },
    });
    const retriedParsed = JSON.parse(retried);
    assert.strictEqual(retriedParsed.summary, 'BDR - Missing Person');
    assert.strictEqual(calendarRequests[1].requestBody.id, fallbackId);
  } finally {
    if (oldDb == null) delete process.env.NOTION_DATABASE_ID;
    else process.env.NOTION_DATABASE_ID = oldDb;
    if (oldDbAlias == null) delete process.env.NOTION_ATS_DB_ID;
    else process.env.NOTION_ATS_DB_ID = oldDbAlias;
    if (oldToken == null) delete process.env.NOTION_INTERNAL_INTEGRATION_SECRET;
    else process.env.NOTION_INTERNAL_INTEGRATION_SECRET = oldToken;
    if (oldTokenAlias == null) delete process.env.NOTION_INTERNAL_INTEGRATION;
    else process.env.NOTION_INTERNAL_INTEGRATION = oldTokenAlias;
  }
}

function testHubSpotStageHistoryHelpers() {
  assert.strictEqual(parseHubSpotDateBoundary('2026-01-01', 'start_date').toISOString(), '2026-01-01T08:00:00.000Z');
  assert.strictEqual(parseHubSpotDateBoundary('2026-04-01', 'start_date').toISOString(), '2026-04-01T07:00:00.000Z');
  assert.throws(
    () => parseHubSpotDateBoundary('January 1, 2026', 'start_date'),
    /ISO date\/time with timezone or YYYY-MM-DD/,
  );
  assert.deepStrictEqual(
    normalizeHubSpotOutcomeTracking({
      track_outcomes: {
        stages: ['1166230571', '190380587', '1166230571'],
        as_of_date: '2026-04-01',
        include_deal_details: true,
      },
    }),
    {
      outcomeStageIds: ['1166230571', '190380587'],
      asOfBoundary: {
        date: new Date('2026-04-02T07:00:00.000Z'),
        exclusive: true,
        input: '2026-04-01',
      },
      includeDealDetails: true,
    },
  );
  assert.strictEqual(parseHubSpotAsOfBoundary('2026-04-01', 'as_of_date').date.toISOString(), '2026-04-02T07:00:00.000Z');
  assert.strictEqual(parseHubSpotAsOfBoundary('2026-04-01', 'as_of_date').exclusive, true);
  assert.strictEqual(parseHubSpotAsOfBoundary('2026-04-01T12:30:00-07:00', 'as_of_date').date.toISOString(), '2026-04-01T19:30:00.000Z');
  assert.strictEqual(parseHubSpotAsOfBoundary('2026-04-01T12:30:00-07:00', 'as_of_date').exclusive, false);

  const deal = {
    id: '123',
    propertiesWithHistory: {
      dealstage: [
        { value: '1307720553', timestamp: '2026-01-03T18:00:00.000Z' },
        { value: '190380582', timestamp: '2026-02-10T09:00:00.000Z' },
        { value: '190380586', timestamp: '2026-03-02T12:00:00.000Z' },
      ],
    },
  };
  assert.deepStrictEqual(
    dealEnteredStageInRange(
      deal,
      '190380582',
      new Date('2026-02-01T00:00:00.000Z'),
      new Date('2026-03-01T00:00:00.000Z'),
    ),
    { value: '190380582', timestamp: '2026-02-10T09:00:00.000Z', sourceType: '' },
  );
  assert.strictEqual(
    dealEnteredStageInRange(
      deal,
      '190380582',
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-04-01T00:00:00.000Z'),
    ),
    null,
  );
  assert.strictEqual(
    dealEnteredStageInRange(
      {
        id: '456',
        properties: {
          dealstage: '190380582',
          hs_lastmodifieddate: '2026-02-10T09:00:00.000Z',
        },
      },
      '190380582',
      new Date('2026-02-01T00:00:00.000Z'),
      new Date('2026-03-01T00:00:00.000Z'),
    ),
    null,
  );
}

function testHubSpotActivityPatternHelpers() {
  const meetingProps = {
    hs_meeting_title: 'Discovery call - no-show',
    hs_meeting_body: '<p>Prospect did not attend the scheduled call.</p>',
    hs_meeting_outcome: 'NO_SHOW',
  };
  assert.deepStrictEqual(
    matchingActivityKeywords('meetings', meetingProps, ['no-show', 'did not attend', 'missed']),
    ['no-show', 'did not attend'],
  );
  assert.deepStrictEqual(
    activityDisplayFields('meetings', meetingProps),
    {
      title: 'Discovery call - no-show',
      outcome: 'NO_SHOW',
      body_excerpt: 'Prospect did not attend the scheduled call.',
    },
  );

  const noteProps = {
    hs_note_body: 'Buyer missed the meeting and asked to reschedule.',
  };
  assert.deepStrictEqual(
    matchingActivityKeywords('notes', noteProps, ['missed', 'no show']),
    ['missed'],
  );
}

function testHubSpotStageCohortOutcomes() {
  const wonStageId = '1166230571';
  const lostStageId = '190380587';
  const wonDeal = {
    id: 'won-1',
    propertiesWithHistory: {
      dealstage: [
        { value: '190380582', timestamp: '2026-01-10T18:00:00.000Z' },
        { value: wonStageId, timestamp: '2026-02-20T18:00:00.000Z' },
      ],
    },
  };
  const lateLostDeal = {
    id: 'late-lost-1',
    propertiesWithHistory: {
      dealstage: [
        { value: '190380582', timestamp: '2026-01-11T18:00:00.000Z' },
        { value: lostStageId, timestamp: '2026-04-03T06:59:59.000Z' },
      ],
    },
  };
  const activeDeal = {
    id: 'active-1',
    propertiesWithHistory: {
      dealstage: [
        { value: '190380582', timestamp: '2026-01-12T18:00:00.000Z' },
        { value: '190380586', timestamp: '2026-02-15T18:00:00.000Z' },
      ],
    },
  };

  assert.deepStrictEqual(
    firstOutcomeAfterEntry(
      wonDeal,
      { timestamp: '2026-01-10T18:00:00.000Z' },
      [wonStageId, lostStageId],
      null,
    ),
    { value: wonStageId, timestamp: '2026-02-20T18:00:00.000Z', sourceType: '' },
  );

  const summary = summarizeHubSpotStageCohortOutcomes(
    [
      {
        id: 'won-1',
        dealname: 'Won Co',
        entered_stage_at: '2026-01-10T18:00:00.000Z',
        current_stage_id: wonStageId,
        url: 'https://example.com/won',
        deal: wonDeal,
        entry: { timestamp: '2026-01-10T18:00:00.000Z' },
      },
      {
        id: 'late-lost-1',
        dealname: 'Late Lost Co',
        entered_stage_at: '2026-01-11T18:00:00.000Z',
        current_stage_id: lostStageId,
        url: 'https://example.com/lost',
        deal: lateLostDeal,
        entry: { timestamp: '2026-01-11T18:00:00.000Z' },
      },
      {
        id: 'active-1',
        dealname: 'Active Co',
        entered_stage_at: '2026-01-12T18:00:00.000Z',
        current_stage_id: '190380586',
        url: 'https://example.com/active',
        deal: activeDeal,
        entry: { timestamp: '2026-01-12T18:00:00.000Z' },
      },
    ],
    {
      outcomeStageIds: [wonStageId, lostStageId],
      asOfBoundary: parseHubSpotAsOfBoundary('2026-04-01', 'track_outcomes.as_of_date'),
      includeDealDetails: false,
    },
  );

  assert.deepStrictEqual(summary.outcomes, {
    still_active: 2,
    [wonStageId]: 1,
    [lostStageId]: 0,
  });
  assert.deepStrictEqual(summary.deal_ids_by_outcome[wonStageId], ['won-1']);
  assert.deepStrictEqual(summary.deal_ids_by_outcome.still_active, ['late-lost-1', 'active-1']);
  assert.strictEqual(summary.as_of_date, '2026-04-01');
  assert.strictEqual(summary.as_of_cutoff_exclusive, true);
  assert.strictEqual(summary.outcome_selection, 'first_tracked_outcome_after_entry');
  assert.strictEqual(summary.average_days_to_outcome[wonStageId], 41);

  const detailedSummary = summarizeHubSpotStageCohortOutcomes(
    [{
      id: 'won-1',
      dealname: 'Won Co',
      entered_stage_at: '2026-01-10T18:00:00.000Z',
      current_stage_id: wonStageId,
      url: 'https://example.com/won',
      deal: wonDeal,
      entry: { timestamp: '2026-01-10T18:00:00.000Z' },
    }],
    {
      outcomeStageIds: [wonStageId, lostStageId],
      asOfBoundary: null,
      includeDealDetails: true,
    },
  );
  assert.strictEqual(detailedSummary.deal_details_by_outcome[wonStageId][0].outcome_stage_id, wonStageId);
}

function testGrainSearchFilteringHelpers() {
  assert.deepStrictEqual(
    parseGrainSearchDateRange({ start_date: '2026-05-01', end_date: '2026-05-31' }),
    { start: '2026-05-01T00:00:00.000Z', end: '2026-05-31T00:00:00.000Z' },
  );

  const recording = {
    title: 'Sound Community Services discovery',
    start_time: '2026-05-10T17:00:00.000Z',
    participants: [
      { name: 'Susan Hunter', email: 'susan@soundct.org', company: 'Sound Community Services' },
      { name: 'Sarah Elix', email: 'sarah@trytruewind.com' },
    ],
  };

  assert.strictEqual(
    grainRecordingMatchesSearch(recording, {
      companyName: 'Sound Community Services',
      participantEmail: 'susan@soundct.org',
      start: '2026-05-01T00:00:00.000Z',
      end: '2026-05-31T00:00:00.000Z',
    }),
    true,
  );
  assert.strictEqual(
    grainRecordingMatchesSearch(recording, {
      companyName: 'Unrelated Company',
      participantEmail: 'susan@soundct.org',
    }),
    false,
  );
  assert.strictEqual(
    grainRecordingMatchesSearch(
      { title: 'Sound Community Services discovery', participants: [{ email: 'susan@soundct.org' }] },
      {
        companyName: 'Sound Community Services',
        participantEmail: 'susan@soundct.org',
        start: '2026-05-01T00:00:00.000Z',
        end: '2026-05-31T00:00:00.000Z',
      },
    ),
    false,
  );
}

function testDailyProgressUsesDealSourceProperty() {
  assert.strictEqual(parseProgressDealSourceProperty(''), 'deal_source');
  assert.strictEqual(parseProgressDealSourceProperty('lead_source'), 'deal_source');
  assert.strictEqual(parseProgressDealSourceProperty('custom_deal_source'), 'custom_deal_source');
  assert.strictEqual(classifyProgressDealSource('Inbound - Website'), 'inbound');
  assert.strictEqual(classifyProgressDealSource('Outbound - Sales Sourced List'), 'outbound');
  assert.strictEqual(classifyProgressDealSource('Referral'), 'unknown');
}

function testProspectWorkflowResponseIncludesHubSpotLinks() {
  assert.strictEqual(
    hubspotRecordUrl('0-3', '60316278406'),
    'https://app.hubspot.com/contacts/43974586/record/0-3/60316278406',
  );
  assert.strictEqual(
    hubspotRecordUrl('deals', '60316278406'),
    'https://app.hubspot.com/contacts/43974586/record/0-3/60316278406',
  );
  assert.strictEqual(
    hubspotRecordUrl('contacts', '221459934275'),
    'https://app.hubspot.com/contacts/43974586/record/0-1/221459934275',
  );
  assert.strictEqual(hubspotRecordUrl('unknown', '123'), '');
  assert.strictEqual(
    hubspotPrimaryAssociatedRecordUrl({
      dealId: '60316278406',
      contactId: '221459934275',
      companyId: '54941778205',
    }),
    'https://app.hubspot.com/contacts/43974586/record/0-3/60316278406',
  );
  assert.strictEqual(
    hubspotPrimaryAssociatedRecordUrl({ contactId: '221459934275', companyId: '54941778205' }),
    'https://app.hubspot.com/contacts/43974586/record/0-1/221459934275',
  );
  assert.strictEqual(hubspotPrimaryAssociatedRecordUrl({}), '');

  const response = formatProspectWorkflowResponse({
    linkedinUrl: '',
    contact: { id: '221459934275', name: 'Deepak Rana', jobtitle: '' },
    company: { id: '54941778205', name: 'ThinkScan', created: false },
    deal: { id: '60316278406', name: 'ThinkScan - New Deal', created: true },
    contactOwner: { id: '91143842', name: 'Jenilee Chen', source: 'from Slack tag' },
    dealOwner: { id: '89305622', name: 'Xavier Marco', source: 'company split between Sarah/Xavier' },
    leadSource: 'Referral',
    note: { id: '12345' },
  });

  assert.match(response, /Deal link: https:\/\/app\.hubspot\.com\/contacts\/43974586\/record\/0-3\/60316278406/);
  assert.match(response, /Contact link: https:\/\/app\.hubspot\.com\/contacts\/43974586\/record\/0-1\/221459934275/);
  assert.match(response, /Company link: https:\/\/app\.hubspot\.com\/contacts\/43974586\/record\/0-2\/54941778205/);
  assert.match(response, /Contact owner: Jenilee Chen \(from Slack tag\)/);
  assert.match(response, /Deal owner: Xavier Marco \(company split between Sarah\/Xavier\)/);
  assert.match(response, /Note added to deal: 12345/);

  const failedNoteResponse = formatProspectWorkflowResponse({
    linkedinUrl: '',
    contact: { id: '221459934275', name: 'Deepak Rana', jobtitle: '' },
    company: { id: '54941778205', name: 'ThinkScan', created: false },
    deal: { id: '60316278406', name: 'ThinkScan - New Deal', created: true },
    owner: { name: 'Xavier Marco', source: 'explicit owner' },
    leadSource: 'Referral',
    note: { error: 'HubSpot 403: missing scope' },
  });
  assert.match(failedNoteResponse, /! Note was not added: HubSpot 403: missing scope/);
}

function testRecruitingAtsToolRegistrationAndPrompt() {
  assert.ok(TOOLS.find((tool) => tool.name === 'recruiting_list_outstanding_candidates'));
  assert.match(getSystemPrompt(), /recruiting_list_outstanding_candidates/);
  assert.match(getSystemPrompt(), /Notion ATS, not the HubSpot sales deal pipeline/);
}

function testRecruitingNotionPropertyHelpers() {
  assert.strictEqual(
    notionPropValue({ type: 'title', title: [{ plain_text: 'Ali Punjani' }] }),
    'Ali Punjani',
  );
  assert.strictEqual(
    notionPropValue({ type: 'multi_select', multi_select: [{ name: 'AE' }, { name: 'BDR' }] }),
    'AE, BDR',
  );
  const map = recruitingNotionPropertyMap({
    properties: {
      Name: { type: 'title' },
      'Role at Truewind': { type: 'multi_select' },
      'Current Company': { type: 'rich_text' },
      'Current Role': { type: 'rich_text' },
      Status: { type: 'select' },
    },
  });
  assert.strictEqual(map.candidateName, 'Name');
  assert.strictEqual(map.role, 'Role at Truewind');
  assert.strictEqual(map.company, 'Current Company');
  assert.strictEqual(map.currentTitle, 'Current Role');
  assert.strictEqual(map.status, 'Status');
}

function testHubSpotRecordUrlsUseObjectTypeIds() {
  assert.strictEqual(normalizeHubSpotObjectTypeId('contact'), '0-1');
  assert.strictEqual(normalizeHubSpotObjectTypeId('contacts'), '0-1');
  assert.strictEqual(normalizeHubSpotObjectTypeId('company'), '0-2');
  assert.strictEqual(normalizeHubSpotObjectTypeId('companies'), '0-2');
  assert.strictEqual(normalizeHubSpotObjectTypeId('deal'), '0-3');
  assert.strictEqual(normalizeHubSpotObjectTypeId('deals'), '0-3');
  assert.strictEqual(normalizeHubSpotObjectTypeId('meetings'), '0-47');
  assert.strictEqual(normalizeHubSpotObjectTypeId('0-47'), '0-47');
  assert.strictEqual(
    hubspotRecordUrl('deals', '60016351576'),
    'https://app.hubspot.com/contacts/43974586/record/0-3/60016351576',
  );
  assert.strictEqual(
    hubspotRecordUrl('contacts', '123'),
    'https://app.hubspot.com/contacts/43974586/record/0-1/123',
  );
  assert.strictEqual(
    hubspotRecordUrl('companies', '456'),
    'https://app.hubspot.com/contacts/43974586/record/0-2/456',
  );
}

async function testStructuredDealWorkflowBlocksOpenDuplicateDeal() {
  seedStructuredDealWorkflowProperties();
  const calls = [];
  const duplicateDeal = {
    id: '60896321431',
    properties: {
      dealname: 'Oakland Promise - Xavier Marco - 2026-06-11',
      pipeline: TRUEWIND_HUBSPOT.pipeline,
      dealstage: TRUEWIND_HUBSPOT.mqlDealStage,
      hs_is_closed: 'false',
      hubspot_owner_id: TRUEWIND_HUBSPOT.defaultOwnerId,
      hs_lastmodifieddate: '2026-06-07T12:00:00.000Z',
    },
  };

  __setHubSpotRequestOverrideForTests(async (endpoint, method = 'GET', body = null) => {
    calls.push({ endpoint, method, body });
    if (endpoint === '/crm/v3/objects/contacts/search') return { results: [] };
    if (endpoint === '/crm/v3/objects/contacts' && method === 'POST') return { id: '221459934275', properties: body.properties };
    if (endpoint === '/crm/v3/objects/companies/search') return { results: [] };
    if (endpoint === '/crm/v3/objects/companies' && method === 'POST') return { id: '54941778205', properties: body.properties };
    if (endpoint === '/crm/v3/objects/deals/search' && body.filterGroups?.[0]?.filters?.some(filter => filter.operator === 'CONTAINS_TOKEN')) {
      return { results: [duplicateDeal] };
    }
    if (endpoint === '/crm/v3/objects/deals/search') return { results: [] };
    if (endpoint.includes('/associations/')) return { results: [] };
    throw new Error(`Unexpected HubSpot mock call: ${method} ${endpoint}`);
  });

  try {
    const result = await runStructuredDealCreateWorkflow({
      company: 'Oakland Promise',
      contact: 'Xavier Marco',
      email: 'xavier@oaklandpromise.org',
      lead_source: 'Referral',
      slack_user_id: 'U_TEST',
    });
    const parsed = JSON.parse(result);
    assert.strictEqual(parsed.error, 'duplicate_deal_exists');
    assert.deepStrictEqual(parsed.existing_deal, {
      id: '60896321431',
      name: 'Oakland Promise - Xavier Marco - 2026-06-11',
      stage: 'MQL',
      owner: 'Xavier Marco',
      url: 'https://app.hubspot.com/contacts/43974586/record/0-3/60896321431',
    });
    assert.strictEqual(
      calls.some(call => call.endpoint === '/crm/v3/objects/deals' && call.method === 'POST'),
      false,
    );
  } finally {
    __setHubSpotRequestOverrideForTests(null);
  }
}

async function testStructuredDealWorkflowAllowsExplicitDuplicateOverride() {
  seedStructuredDealWorkflowProperties();
  const calls = [];

  __setHubSpotRequestOverrideForTests(async (endpoint, method = 'GET', body = null) => {
    calls.push({ endpoint, method, body });
    if (endpoint === '/crm/v3/objects/contacts/search') return { results: [] };
    if (endpoint === '/crm/v3/objects/contacts' && method === 'POST') return { id: '221459934275', properties: body.properties };
    if (endpoint === '/crm/v3/objects/companies/search') return { results: [] };
    if (endpoint === '/crm/v3/objects/companies' && method === 'POST') return { id: '54941778205', properties: body.properties };
    if (endpoint === '/crm/v3/objects/deals/search') return { results: [] };
    if (endpoint === '/crm/v3/objects/deals' && method === 'POST') return { id: '60896321432', properties: body.properties };
    if (endpoint.includes('/associations/')) return {};
    if (endpoint === '/crm/v3/objects/contacts/221459934275' && method === 'PATCH') return { id: '221459934275', properties: body.properties };
    throw new Error(`Unexpected HubSpot mock call: ${method} ${endpoint}`);
  });

  try {
    const result = await runStructuredDealCreateWorkflow({
      company: 'Oakland Promise',
      contact: 'Xavier Marco',
      email: 'xavier@oaklandpromise.org',
      lead_source: 'Referral',
      slack_user_id: 'U_TEST',
      check_duplicates: false,
    });
    assert.match(result, /Deal created: Oakland Promise - New Deal/);
    assert.match(result, /Deal ID: 60896321432/);
    assert.strictEqual(
      calls.some(call => call.endpoint === '/crm/v3/objects/deals' && call.method === 'POST'),
      true,
    );
    assert.strictEqual(
      calls.some(call => call.endpoint.includes('/associations/deals')),
      false,
    );
  } finally {
    __setHubSpotRequestOverrideForTests(null);
  }
}

async function testStructuredDealWorkflowIgnoresAssociatedDealInDifferentPipeline() {
  seedStructuredDealWorkflowProperties();
  const calls = [];
  const otherPipelineDeal = {
    id: '60896321433',
    properties: {
      dealname: 'Oakland Promise - Old Pipeline',
      pipeline: 'default',
      dealstage: TRUEWIND_HUBSPOT.mqlDealStage,
      hs_is_closed: 'false',
      hubspot_owner_id: TRUEWIND_HUBSPOT.defaultOwnerId,
      hs_lastmodifieddate: '2026-06-07T12:00:00.000Z',
    },
  };

  __setHubSpotRequestOverrideForTests(async (endpoint, method = 'GET', body = null) => {
    calls.push({ endpoint, method, body });
    if (endpoint === '/crm/v3/objects/contacts/search') return { results: [] };
    if (endpoint === '/crm/v3/objects/contacts' && method === 'POST') return { id: '221459934275', properties: body.properties };
    if (endpoint === '/crm/v3/objects/companies/search') return { results: [] };
    if (endpoint === '/crm/v3/objects/companies' && method === 'POST') return { id: '54941778205', properties: body.properties };
    if (endpoint === '/crm/v4/objects/0-2/54941778205/associations/0-3?limit=100') {
      return { results: [{ toObjectId: '60896321433' }] };
    }
    if (endpoint === '/crm/v3/objects/0-3/batch/read') return { results: [otherPipelineDeal] };
    if (endpoint.includes('/associations/')) return { results: [] };
    if (endpoint === '/crm/v3/objects/deals/search') return { results: [] };
    if (endpoint === '/crm/v3/objects/deals' && method === 'POST') return { id: '60896321434', properties: body.properties };
    throw new Error(`Unexpected HubSpot mock call: ${method} ${endpoint}`);
  });

  try {
    const result = await runStructuredDealCreateWorkflow({
      company: 'Oakland Promise',
      contact: 'Xavier Marco',
      email: 'xavier@oaklandpromise.org',
      lead_source: 'Referral',
      slack_user_id: 'U_TEST',
    });
    assert.match(result, /Deal created: Oakland Promise - New Deal/);
    assert.match(result, /Deal ID: 60896321434/);
    assert.strictEqual(
      calls.some(call => call.endpoint === '/crm/v3/objects/deals' && call.method === 'POST'),
      true,
    );
  } finally {
    __setHubSpotRequestOverrideForTests(null);
  }
}

async function testProspectWorkflowExplicitOwnerControlsContactAndDeal() {
  seedStructuredDealWorkflowProperties();
  const calls = [];

  __setHubSpotRequestOverrideForTests(async (endpoint, method = 'GET', body = null) => {
    calls.push({ endpoint, method, body });
    if (endpoint === '/crm/v3/objects/contacts/search') return { results: [] };
    if (endpoint === '/crm/v3/objects/contacts' && method === 'POST') return { id: '221459934277', properties: body.properties };
    if (endpoint === '/crm/v3/objects/contacts/221459934277' && method === 'PATCH') return { id: '221459934277', properties: body.properties };
    if (endpoint === '/crm/v3/objects/companies/search') return { results: [] };
    if (endpoint === '/crm/v3/objects/companies' && method === 'POST') return { id: '54941778207', properties: body.properties };
    if (endpoint === '/crm/v3/objects/deals/search') return { results: [] };
    if (endpoint === '/crm/v3/objects/deals' && method === 'POST') return { id: '60896321436', properties: body.properties };
    if (endpoint.includes('/associations/')) return { results: [] };
    throw new Error(`Unexpected HubSpot mock call: ${method} ${endpoint}`);
  });

  try {
    const result = await executeTool('hubspot_push_truewind_prospect', {
      email: 'buyer@explicitowner.example',
      company: 'Explicit Owner Co',
      firstname: 'Pat',
      lastname: 'Buyer',
      linkedin_url: 'https://www.linkedin.com/in/pat-buyer/',
      lead_source: 'Referral',
      owner_name: 'Alex Lee',
      slack_user_id: 'U_TEST',
      check_duplicates: false,
    });
    assert.match(result, /Owner: Alex Lee \(explicit deal owner\)/);

    const contactCreate = calls.find(call => call.endpoint === '/crm/v3/objects/contacts' && call.method === 'POST');
    const dealCreate = calls.find(call => call.endpoint === '/crm/v3/objects/deals' && call.method === 'POST');
    const contactConversion = calls.find(call => call.endpoint === '/crm/v3/objects/contacts/221459934277' && call.method === 'PATCH');

    assert.strictEqual(contactCreate.body.properties.hubspot_owner_id, '559564379');
    assert.strictEqual(dealCreate.body.properties.hubspot_owner_id, '559564379');
    assert.strictEqual(contactConversion.body.properties.hubspot_owner_id, '559564379');
  } finally {
    __setHubSpotRequestOverrideForTests(null);
  }
}

async function testProspectWorkflowBlocksOpenDuplicateDeal() {
  seedStructuredDealWorkflowProperties();
  const calls = [];
  const duplicateDeal = {
    id: '60896321435',
    properties: {
      dealname: 'Oakland Promise - Xavier Marco - 2026-06-11',
      pipeline: TRUEWIND_HUBSPOT.pipeline,
      dealstage: TRUEWIND_HUBSPOT.mqlDealStage,
      hs_is_closed: 'false',
      hubspot_owner_id: TRUEWIND_HUBSPOT.defaultOwnerId,
      hs_lastmodifieddate: '2026-06-07T12:00:00.000Z',
    },
  };

  __setHubSpotRequestOverrideForTests(async (endpoint, method = 'GET', body = null) => {
    calls.push({ endpoint, method, body });
    if (endpoint === '/crm/v3/objects/contacts/search') return { results: [] };
    if (endpoint === '/crm/v3/objects/contacts' && method === 'POST') return { id: '221459934276', properties: body.properties };
    if (endpoint === '/crm/v3/objects/companies/search') return { results: [] };
    if (endpoint === '/crm/v3/objects/companies' && method === 'POST') return { id: '54941778206', properties: body.properties };
    if (endpoint === '/crm/v3/objects/deals/search' && body.filterGroups?.[0]?.filters?.some(filter => filter.operator === 'CONTAINS_TOKEN')) {
      return { results: [duplicateDeal] };
    }
    if (endpoint === '/crm/v3/objects/deals/search') return { results: [] };
    if (endpoint.includes('/associations/')) return { results: [] };
    throw new Error(`Unexpected HubSpot mock call: ${method} ${endpoint}`);
  });

  try {
    const result = await executeTool('hubspot_push_truewind_prospect', {
      email: 'xavier@oaklandpromise.org',
      company: 'Oakland Promise',
      firstname: 'Xavier',
      lastname: 'Marco',
      linkedin_url: 'https://www.linkedin.com/in/xavier-marco/',
      lead_source: 'Referral',
      slack_user_id: 'U_TEST',
    });
    const parsed = JSON.parse(result);
    assert.strictEqual(parsed.error, 'duplicate_deal_exists');
    assert.strictEqual(parsed.existing_deal.id, '60896321435');
    assert.strictEqual(parsed.existing_deal.name, 'Oakland Promise - Xavier Marco - 2026-06-11');
    assert.strictEqual(
      calls.some(call => call.endpoint === '/crm/v3/objects/deals' && call.method === 'POST'),
      false,
    );
    assert.strictEqual(
      calls.some(call => call.endpoint === '/crm/v3/objects/contacts/221459934276' && call.method === 'PATCH'),
      false,
    );
  } finally {
    __setHubSpotRequestOverrideForTests(null);
  }
}

async function run() {
  await testConvertedLeadStatusUsesInternalValue();
  await testReadOnlyDealPropertiesAreRejectedBeforeWrite();
  await testLowLevelHubSpotWritesRequireAuthorization();
  await testReadOnlyDefinitionDoesNotBlockWritableStandardFields();
  testStructuredDealRequestParser();
  testStructuredNotesCanBeMultiline();
  testDealNoteBodyEscapesAndIncludesFields();
  await testExplicitOwnerOverridesSlackMapping();
  await testGtmSlackUsersMapToHubSpotOwners();
  testDynamicOwnerMatchByEmailAndName();
  testLeadSourceDefaultsToOutbound();
  testDealOwnerResolution();
  testDealNotesPromptAndTools();
  testRecruitingAtsToolRegistrationAndPrompt();
  testRecruitingNotionPropertyHelpers();
  testRecruitingCalendarInviteBuilderAndAuthorization();
  await testRecruitingCalendarInviteExecuteToolAuthAndIdempotency();
  await testRecruitingCalendarInviteInfersTitleFromAts();
  await testRecruitingCalendarInviteAtsLookupDoesNotBlockCreation();
  testHubSpotStageHistoryHelpers();
  testHubSpotActivityPatternHelpers();
  testHubSpotStageCohortOutcomes();
  testGrainSearchFilteringHelpers();
  testDailyProgressUsesDealSourceProperty();
  testProspectWorkflowResponseIncludesHubSpotLinks();
  testHubSpotRecordUrlsUseObjectTypeIds();
  await testStructuredDealWorkflowBlocksOpenDuplicateDeal();
  await testStructuredDealWorkflowAllowsExplicitDuplicateOverride();
  await testStructuredDealWorkflowIgnoresAssociatedDealInDifferentPipeline();
  await testProspectWorkflowExplicitOwnerControlsContactAndDeal();
  await testProspectWorkflowBlocksOpenDuplicateDeal();
}

run()
  .then(() => console.log('slack_bot_hubspot tests passed'))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
