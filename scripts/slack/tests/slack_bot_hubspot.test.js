const assert = require('assert');

process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || 'xoxb-test';
process.env.SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || 'test-secret';
process.env.SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN || 'xapp-test';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-secret';
process.env.GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || 'test-refresh';
process.env.SLACK_TO_HUBSPOT_OWNER_JSON = JSON.stringify({
  U_TEST: { id: '89305622', name: 'Xavier Marco' },
});

const {
  TRUEWIND_HUBSPOT,
  buildDealNoteBody,
  classifyProgressDealSource,
  deduceLeadSource,
  executeTool,
  extractStructuredBlockField,
  formatProspectWorkflowResponse,
  hubspotPropertyCache,
  hubspotRecordUrl,
  isHubSpotWriteAuthorized,
  isReadOnlyHubSpotProperty,
  parseStructuredDealRequest,
  parseProgressDealSourceProperty,
  resolveHubSpotOwner,
  resolveHubSpotOwnerForProspect,
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
    isHubSpotWriteAuthorized({ slack_user_id: 'U_TEST' }, owner),
    { authorized: true, reason: 'Slack user maps to HubSpot owner' },
  );
  assert.strictEqual(
    isHubSpotWriteAuthorized({ slack_user_id: 'U_UNMAPPED' }, owner).authorized,
    false,
  );
}

function testLeadSourceDefaultsToOutbound() {
  assert.strictEqual(deduceLeadSource('please create this outbound deal'), 'Outbound - Sales Sourced List');
  assert.strictEqual(deduceLeadSource(''), 'Outbound - Sales Sourced List');
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

  const response = formatProspectWorkflowResponse({
    linkedinUrl: '',
    contact: { id: '221459934275', name: 'Deepak Rana', jobtitle: '' },
    company: { id: '54941778205', name: 'ThinkScan', created: false },
    deal: { id: '60316278406', name: 'ThinkScan - New Deal', created: true },
    owner: { name: 'Xavier Marco', source: 'explicit owner' },
    leadSource: 'Referral',
    note: { id: '12345' },
  });

  assert.match(response, /Deal link: https:\/\/app\.hubspot\.com\/contacts\/43974586\/record\/0-3\/60316278406/);
  assert.match(response, /Contact link: https:\/\/app\.hubspot\.com\/contacts\/43974586\/record\/0-1\/221459934275/);
  assert.match(response, /Company link: https:\/\/app\.hubspot\.com\/contacts\/43974586\/record\/0-2\/54941778205/);
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

async function run() {
  await testConvertedLeadStatusUsesInternalValue();
  await testReadOnlyDealPropertiesAreRejectedBeforeWrite();
  await testLowLevelHubSpotWritesRequireAuthorization();
  await testReadOnlyDefinitionDoesNotBlockWritableStandardFields();
  testStructuredDealRequestParser();
  testStructuredNotesCanBeMultiline();
  testDealNoteBodyEscapesAndIncludesFields();
  await testExplicitOwnerOverridesSlackMapping();
  testLeadSourceDefaultsToOutbound();
  testDailyProgressUsesDealSourceProperty();
  testProspectWorkflowResponseIncludesHubSpotLinks();
}

run()
  .then(() => console.log('slack_bot_hubspot tests passed'))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
