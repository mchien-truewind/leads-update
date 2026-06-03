const assert = require('assert');
const { Readable } = require('stream');

const {
  eventLooksNonPositive,
  eventLooksPositive,
  extractLead,
  formatPositiveReplyMessage,
  handleInstantlyPositiveReplyWebhook,
  normalizeChannel,
  validateWebhookSecret,
} = require('../instantly_positive_reply_alert');

function testPositiveEventDetection() {
  assert.strictEqual(eventLooksPositive({ event_type: 'lead_interested' }), true);
  assert.strictEqual(eventLooksPositive({ lead: { interest_status_label: 'positive' } }), true);
  assert.strictEqual(eventLooksPositive({ type: 'reply_received' }), false);
}

function testNonPositiveEventDetection() {
  assert.strictEqual(eventLooksNonPositive({ event_type: 'lead_neutral' }), true);
  assert.strictEqual(eventLooksNonPositive({ lead: { interest_status_label: 'negative' } }), true);
  assert.strictEqual(eventLooksNonPositive({ event_type: 'lead_interested' }), false);
}

function testLeadExtraction() {
  const lead = extractLead({
    event_type: 'lead_interested',
    lead: {
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
      company_name: 'Analytical Engines',
      job_title: 'Founder',
      campaign: 'camp_123',
    },
    campaign: { name: 'CFO outbound' },
    reply_text: '<p>Sounds interesting. Can you send times?</p>',
  });

  assert.strictEqual(lead.name, 'Ada Lovelace');
  assert.strictEqual(lead.email, 'ada@example.com');
  assert.strictEqual(lead.company, 'Analytical Engines');
  assert.strictEqual(lead.title, 'Founder');
  assert.strictEqual(lead.campaignName, 'CFO outbound');
  assert.strictEqual(lead.replyText, 'Sounds interesting. Can you send times?');
}

function testLeadExtractionUsesInstantlyWebhookLeadEmail() {
  const lead = extractLead({
    event_type: 'lead_interested',
    lead_email: 'documented@example.com',
  });

  assert.strictEqual(lead.email, 'documented@example.com');
}

function testMessageStartsWithMention() {
  const text = formatPositiveReplyMessage(
    {
      event_type: 'lead_interested',
      lead: { name: 'Grace Hopper', email: 'grace@example.com', company: 'Navy' },
      campaign_name: 'Controller campaign',
      reply_text: 'Yes, worth a conversation.',
    },
    { mentionUserId: 'U123' },
  );

  assert.ok(text.startsWith('<@U123> *Positive Instantly reply*'));
  assert.ok(text.includes('Lead: Grace Hopper | Navy'));
  assert.ok(text.includes('Email: grace@example.com'));
  assert.ok(text.includes('Campaign: Controller campaign'));
}

function testMentionIsRequired() {
  assert.throws(
    () => formatPositiveReplyMessage({ event_type: 'lead_interested' }, {}),
    /mention user id/,
  );
}

function testSecretValidation() {
  assert.strictEqual(
    validateWebhookSecret({ 'x-instantly-webhook-secret': 'secret' }, 'secret'),
    true,
  );
  assert.strictEqual(
    validateWebhookSecret({ authorization: 'Bearer secret' }, 'secret'),
    true,
  );
  assert.strictEqual(
    validateWebhookSecret({ 'x-instantly-webhook-secret': 'wrong' }, 'secret'),
    false,
  );
  assert.strictEqual(validateWebhookSecret({}, ''), true);
}

function testChannelNormalization() {
  assert.strictEqual(normalizeChannel('#gtm-outbound'), 'gtm-outbound');
  assert.strictEqual(normalizeChannel('gtm-outbound'), 'gtm-outbound');
  assert.strictEqual(normalizeChannel(''), 'gtm-outbound');
}

function makeJsonRequest(body, headers = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = 'POST';
  req.headers = headers;
  return req;
}

function makeResponse() {
  return {
    statusCode: null,
    body: '',
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(body = '') {
      this.body = body;
    },
  };
}

async function testHandlerPostsPositiveReply() {
  const posts = [];
  const req = makeJsonRequest(
    { event_type: 'lead_interested', lead_email: 'positive@example.com' },
    { 'x-instantly-webhook-secret': 'secret' },
  );
  const res = makeResponse();

  await handleInstantlyPositiveReplyWebhook(req, res, {
    slackClient: { chat: { postMessage: async payload => posts.push(payload) } },
    slackToken: 'xoxb-test',
    channel: '#gtm-outbound',
    mentionUserId: 'U123',
    webhookSecret: 'secret',
  });

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body, 'ok');
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].channel, 'gtm-outbound');
  assert.ok(posts[0].text.startsWith('<@U123> *Positive Instantly reply*'));
  assert.ok(posts[0].text.includes('positive@example.com'));
}

async function testHandlerRejectsBadSecret() {
  const posts = [];
  const req = makeJsonRequest(
    { event_type: 'lead_interested', lead_email: 'positive@example.com' },
    { 'x-instantly-webhook-secret': 'wrong' },
  );
  const res = makeResponse();

  await handleInstantlyPositiveReplyWebhook(req, res, {
    slackClient: { chat: { postMessage: async payload => posts.push(payload) } },
    slackToken: 'xoxb-test',
    channel: '#gtm-outbound',
    mentionUserId: 'U123',
    webhookSecret: 'secret',
  });

  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(posts.length, 0);
}

async function run() {
  testPositiveEventDetection();
  testNonPositiveEventDetection();
  testLeadExtraction();
  testLeadExtractionUsesInstantlyWebhookLeadEmail();
  testMessageStartsWithMention();
  testMentionIsRequired();
  testSecretValidation();
  testChannelNormalization();
  await testHandlerPostsPositiveReply();
  await testHandlerRejectsBadSecret();
}

run()
  .then(() => console.log('instantly_positive_reply_alert tests passed'))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
