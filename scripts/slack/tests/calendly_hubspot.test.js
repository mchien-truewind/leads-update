const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CONFIG,
  buildDealName,
  findAllowedHostUserUri,
  getCompanyNameFromPayload,
  getEventTypeUri,
  getOrganizerName,
  hubspotDateMs,
  idempotencyRoot,
  isCalendlyApiUri,
  isRescheduled,
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

function testOrganizerName() {
  assert.strictEqual(
    getOrganizerName('https://api.calendly.com/users/069e97c6-0691-4472-84f2-cad9c76b6e01'),
    'Sarah Elix',
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
  testOrganizerName();
  testConfigHasExpectedCloseLostStage();
}

run()
  .then(() => console.log('calendly_hubspot tests passed'))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
