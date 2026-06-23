const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CONFIG,
  CONTACT_CALENDLY_MEETING_BOOKED_PROPERTY,
  buildBookedDemoSlackMessage,
  buildCalendlyContactProperties,
  buildDealName,
  findAllowedHostUserUri,
  getCompanyIdentityFromPayload,
  getCompanyNameFromPayload,
  getEmailDomain,
  getEventTypeUri,
  getOrganizerName,
  hubspotDateMs,
  inferCompanyNameFromDomain,
  idempotencyRoot,
  isCalendlyApiUri,
  isRescheduled,
  isUsableCompanyDomain,
  postBookedDemoSlackAlert,
  shouldProcessScheduledEvent,
  validateCalendlySignature,
} = require('../calendly_hubspot');

function signedHeader(body, signingKey, timestamp) {
  const signature = crypto
    .createHmac('sha256', signingKey)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function testSignatureValidation() {
  const body = Buffer.from(JSON.stringify({ event: 'invitee.created' }));
  const signingKey = 'test-secret';
  const timestamp = 1778100000;
  const header = signedHeader(body.toString('utf8'), signingKey, timestamp);

  assert.deepStrictEqual(
    validateCalendlySignature(body, header, signingKey, timestamp * 1000),
    { ok: true },
  );
  assert.strictEqual(
    validateCalendlySignature(Buffer.from('tampered'), header, signingKey, timestamp * 1000).ok,
    false,
  );
  assert.strictEqual(
    validateCalendlySignature(body, header, signingKey, (timestamp * 1000) + (6 * 60 * 1000)).reason,
    'stale timestamp',
  );
}

function testAllowlistRequiresEventTypeAndHost() {
  const scheduledEvent = {
    resource: {
      event_type: 'https://api.calendly.com/event_types/6507e7a2-6085-4d57-8726-d5de44d5e16e',
      event_memberships: [
        { user: 'https://api.calendly.com/users/ac8a0acf-71b8-4db8-b74d-31ea6eaef11d' },
      ],
    },
  };
  const filter = shouldProcessScheduledEvent(scheduledEvent);

  assert.strictEqual(filter.ok, true);
  assert.strictEqual(filter.ownerId, '89305622');
  assert.strictEqual(getEventTypeUri(scheduledEvent), 'https://api.calendly.com/event_types/6507e7a2-6085-4d57-8726-d5de44d5e16e');
  assert.strictEqual(findAllowedHostUserUri(scheduledEvent), 'https://api.calendly.com/users/ac8a0acf-71b8-4db8-b74d-31ea6eaef11d');

  const wrongHost = {
    resource: {
      event_type: 'https://api.calendly.com/event_types/6507e7a2-6085-4d57-8726-d5de44d5e16e',
      event_memberships: [{ user: 'https://api.calendly.com/users/not-allowed' }],
    },
  };
  assert.strictEqual(shouldProcessScheduledEvent(wrongHost).ok, false);

  const wrongEvent = {
    resource: {
      event_type: 'https://api.calendly.com/event_types/not-allowed',
      event_memberships: [
        { user: 'https://api.calendly.com/users/ac8a0acf-71b8-4db8-b74d-31ea6eaef11d' },
      ],
    },
  };
  assert.strictEqual(shouldProcessScheduledEvent(wrongEvent).ok, false);

  const objectShapedEvent = {
    resource: {
      event_type: { uri: 'https://api.calendly.com/event_types/6507e7a2-6085-4d57-8726-d5de44d5e16e' },
      event_memberships: [
        { user: { uri: 'https://api.calendly.com/users/ac8a0acf-71b8-4db8-b74d-31ea6eaef11d' } },
      ],
    },
  };
  assert.strictEqual(shouldProcessScheduledEvent(objectShapedEvent).ok, true);

  const amyEvent = {
    resource: {
      event_type: 'https://api.calendly.com/event_types/d7cc7703-81c0-44bb-92ae-a2ed1b99cbdd',
      event_memberships: [
        { user: 'https://api.calendly.com/users/faa4a75c-b934-4b35-8b42-eef03611a78b' },
      ],
    },
  };
  const amyFilter = shouldProcessScheduledEvent(amyEvent);
  assert.strictEqual(amyFilter.ok, true);
  assert.strictEqual(amyFilter.ownerId, '92555980');
}

function testRescheduleDetection() {
  assert.strictEqual(isRescheduled({ rescheduled: true }), true);
  assert.strictEqual(isRescheduled({ new_invitee: 'https://api.calendly.com/scheduled_events/abc/invitees/def' }), true);
  assert.strictEqual(isRescheduled({ rescheduled: false }), false);
}

function testCalendlyApiUriValidation() {
  assert.strictEqual(isCalendlyApiUri('https://api.calendly.com/scheduled_events/abc'), true);
  assert.strictEqual(isCalendlyApiUri('https://example.com/scheduled_events/abc'), false);
  assert.strictEqual(isCalendlyApiUri(''), false);
}

function testHubSpotDateMs() {
  assert.strictEqual(
    hubspotDateMs(new Date('2026-05-06T18:25:30.000Z')),
    String(new Date('2026-05-06T00:00:00.000Z').getTime()),
  );
}

function testIdempotencyRootUsesEnvOverride() {
  const previous = process.env.CALENDLY_WEBHOOK_STATE_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calendly-state-'));
  process.env.CALENDLY_WEBHOOK_STATE_DIR = tmp;
  assert.strictEqual(idempotencyRoot(), tmp);
  if (previous === undefined) delete process.env.CALENDLY_WEBHOOK_STATE_DIR;
  else process.env.CALENDLY_WEBHOOK_STATE_DIR = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
}

function testDealName() {
  assert.strictEqual(
    buildDealName({
      companyName: 'Acme Finance',
      organizerName: 'Sarah Elix',
      startTime: '2026-05-06T16:00:00.000Z',
    }),
    'Acme Finance - Sarah Elix - 2026-05-06',
  );
  assert.strictEqual(
    buildDealName({
      startTime: '2026-05-06T16:00:00.000Z',
    }),
    'Unknown Company - Unknown Organizer - 2026-05-06',
  );
}

function testCompanyNameExtraction() {
  assert.strictEqual(getCompanyNameFromPayload({ company: 'Direct Co' }), 'Direct Co');
  assert.strictEqual(
    getCompanyNameFromPayload({
      questions_and_answers: [
        { question: 'What is your company name?', answer: 'Question Co' },
      ],
    }),
    'Question Co',
  );
  assert.strictEqual(
    getCompanyNameFromPayload({
      invitee: {
        questions_and_answers: [
          { question: 'Company', answer: 'Nested Co' },
        ],
      },
    }),
    'Nested Co',
  );
  assert.strictEqual(getCompanyNameFromPayload({ questions_and_answers: [] }), '');
}

function testCompanyIdentityExtraction() {
  assert.strictEqual(getEmailDomain('ada@acme-finance.com'), 'acme-finance.com');
  assert.strictEqual(isUsableCompanyDomain('acme-finance.com'), true);
  assert.strictEqual(isUsableCompanyDomain('gmail.com'), false);
  assert.strictEqual(inferCompanyNameFromDomain('acme-finance.com'), 'Acme Finance');
  assert.deepStrictEqual(
    getCompanyIdentityFromPayload({
      email: 'ada@acme-finance.com',
      questions_and_answers: [{ question: 'Company', answer: 'Acme CFO Services' }],
    }),
    { name: 'Acme CFO Services', domain: 'acme-finance.com' },
  );
  assert.deepStrictEqual(
    getCompanyIdentityFromPayload({ email: 'ada@acme-finance.com' }),
    { name: 'Acme Finance', domain: 'acme-finance.com' },
  );
  assert.deepStrictEqual(
    getCompanyIdentityFromPayload({ email: 'ada@gmail.com' }),
    { name: '', domain: '' },
  );
}

function testCalendlyContactPropertiesMarkMeetingBooked() {
  assert.strictEqual(CONTACT_CALENDLY_MEETING_BOOKED_PROPERTY, 'calendly_meeting_booked');
  assert.deepStrictEqual(
    buildCalendlyContactProperties({
      name: 'Ada Lovelace',
      email: 'ada@acme-finance.com',
      markMeetingBooked: true,
      ownerId: '92555980',
    }),
    {
      email: 'ada@acme-finance.com',
      firstname: 'Ada',
      lastname: 'Lovelace',
      calendly_meeting_booked: 'true',
      hubspot_owner_id: '92555980',
    },
  );
  assert.deepStrictEqual(
    buildCalendlyContactProperties({
      name: 'Ada Lovelace',
      email: 'ada@acme-finance.com',
    }),
    {
      email: 'ada@acme-finance.com',
      firstname: 'Ada',
      lastname: 'Lovelace',
    },
  );
}

function testBookedDemoSlackMessageTagsMeetingHost() {
  const text = buildBookedDemoSlackMessage({
    payload: {
      name: 'Sean Wilson',
      email: 'sean@practicefinancialgroup.com',
      phone: '5419303372',
      questions_and_answers: [
        { question: 'ERP', answer: 'Other' },
        { question: 'Job Title', answer: 'Systems and Technology Manager' },
        { question: 'How did you hear about us?', answer: 'Industry event or conference' },
        { question: 'Finance team size', answer: '2-5' },
      ],
    },
    scheduledEvent: {
      resource: {
        name: 'Book Demo',
        start_time: '2026-05-19T18:00:00.000Z',
      },
    },
    contactId: '222587193659',
    companyName: 'Practice Financial Group',
    ownerName: 'Amy Vetter',
    ownerSlackUserId: 'U0B4MRN83FE',
  });

  assert.ok(text.startsWith('<@U0B4MRN83FE>\nNew DEMO Meeting Booked'));
  assert.ok(text.includes('<https://app.hubspot.com/contacts/43974586/record/0-1/222587193659|Sean Wilson>'));
  assert.ok(text.includes('- Owner: <@U0B4MRN83FE>'));
  assert.ok(text.includes('- Meeting Host: Amy Vetter'));
  assert.ok(text.includes('- ERP: Other'));
  assert.ok(text.includes('- Job Title: Systems and Technology Manager'));
  assert.ok(text.includes('- How did you hear about us? Industry event or conference'));
  assert.ok(text.includes('- Finance team size: 2-5'));
  assert.ok(text.includes('- Phone: 5419303372'));
}

async function testBookedDemoSlackAlertRetriesTransientFailures() {
  const previousAttempts = process.env.CALENDLY_DEMO_SLACK_ALERT_ATTEMPTS;
  process.env.CALENDLY_DEMO_SLACK_ALERT_ATTEMPTS = '2';
  let attempts = 0;
  const posts = [];
  try {
    const result = await postBookedDemoSlackAlert({
      slackClient: {
        chat: {
          postMessage: async (payload) => {
            attempts += 1;
            posts.push(payload);
            if (attempts === 1) throw new Error('rate_limited');
            return { ts: '123.456' };
          },
        },
      },
      slackToken: 'xoxb-test',
      slackChannel: 'C_TEST',
      ownerSlackUserByHubSpotOwnerId: { 92555980: 'U0B4MRN83FE' },
      payload: { name: 'Sean Wilson', email: 'sean@practicefinancialgroup.com' },
      scheduledEvent: { resource: { start_time: '2026-05-19T18:00:00.000Z' } },
      contactId: '222587193659',
      companyName: 'Practice Financial Group',
      ownerId: '92555980',
      ownerName: 'Amy Vetter',
    });

    assert.strictEqual(result.ts, '123.456');
    assert.strictEqual(attempts, 2);
    assert.strictEqual(posts[0].channel, 'C_TEST');
    assert.ok(posts[1].text.includes('<@U0B4MRN83FE>'));
  } finally {
    if (previousAttempts === undefined) delete process.env.CALENDLY_DEMO_SLACK_ALERT_ATTEMPTS;
    else process.env.CALENDLY_DEMO_SLACK_ALERT_ATTEMPTS = previousAttempts;
  }
}

function testOrganizerName() {
  assert.strictEqual(
    getOrganizerName('https://api.calendly.com/users/069e97c6-0691-4472-84f2-cad9c76b6e01'),
    'Sarah Elix',
  );
  assert.strictEqual(
    getOrganizerName('https://api.calendly.com/users/faa4a75c-b934-4b35-8b42-eef03611a78b'),
    'Amy Vetter',
  );
  assert.strictEqual(
    getOrganizerName('https://api.calendly.com/users/unknown', {
      resource: {
        event_memberships: [
          { user: 'https://api.calendly.com/users/unknown', user_name: 'Fallback Host' },
        ],
      },
    }),
    'Fallback Host',
  );
}

function testConfigHasExpectedCloseLostStage() {
  assert.strictEqual(CONFIG.pipelineId, '105321581');
  assert.strictEqual(CONFIG.newDealStageId, '1307720553');
  assert.strictEqual(CONFIG.closedLostStageId, '190380587');
  assert.strictEqual(CONFIG.closedLostReason, 'no show');
}

async function run() {
  testSignatureValidation();
  testAllowlistRequiresEventTypeAndHost();
  testRescheduleDetection();
  testCalendlyApiUriValidation();
  testHubSpotDateMs();
  testIdempotencyRootUsesEnvOverride();
  testDealName();
  testCompanyNameExtraction();
  testCompanyIdentityExtraction();
  testCalendlyContactPropertiesMarkMeetingBooked();
  testBookedDemoSlackMessageTagsMeetingHost();
  await testBookedDemoSlackAlertRetriesTransientFailures();
  testOrganizerName();
  testConfigHasExpectedCloseLostStage();
}

run()
  .then(() => console.log('calendly_hubspot tests passed'))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
