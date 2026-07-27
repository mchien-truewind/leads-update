const assert = require('assert');
const { test } = require('node:test');
const { PassThrough } = require('stream');

const {
  buildVisitUniqueId,
  formatVisitNoteBody,
  handleRb2bHubSpotWebhook,
  initialVisitUniqueId,
  isRb2bCreatedRecord,
  normalizeRb2bPayload,
  normalizeSeenAt,
  processRb2bVisit,
} = require('../rb2b_hubspot');

async function invokeWebhook({ url, body, secret = 'configured-secret', hubspot = async () => ({}) }) {
  const req = new PassThrough();
  req.method = 'POST';
  req.url = url;
  const response = { statusCode: 0, body: '', headers: {} };
  const res = {
    writeHead(statusCode, headers = {}) {
      response.statusCode = statusCode;
      response.headers = headers;
    },
    end(value = '') {
      response.body = value;
    },
  };
  const promise = handleRb2bHubSpotWebhook(req, res, {
    secret,
    hubspot,
    logger: { log() {}, error() {} },
    contactLookup: { attempts: 1 },
  });
  req.end(body);
  await promise;
  return response;
}

function payload(overrides = {}) {
  return {
    'LinkedIn URL': 'https://www.linkedin.com/in/example-person/',
    'First Name': 'Example',
    'Last Name': 'Person',
    'Business Email': 'person@example.com',
    'Seen At': '2026-07-27T19:05:06-07:00',
    'Captured URL': 'https://www.truewind.ai/pricing',
    is_repeat_visitor: true,
    ...overrides,
  };
}

function rb2bRecord(id, properties = {}) {
  return {
    id,
    properties: {
      rb2b_source: 'true',
      hs_object_source_id: '4209312',
      hs_object_source_detail_1: 'RB2B for CRM',
      hubspot_owner_id: '',
      ...properties,
    },
  };
}

test('normalizes RB2B payloads and formats the Pacific visit date', () => {
  const visit = normalizeRb2bPayload(payload());
  assert.strictEqual(visit.email, 'person@example.com');
  assert.strictEqual(visit.linkedInKey, 'www.linkedin.com/in/example-person');
  assert.strictEqual(visit.seenAt, '2026-07-28T02:05:06.000Z');
  assert.strictEqual(formatVisitNoteBody(visit.seenAt), '07/27/2026 visited main website');
});

test('repairs the timestamp shape shown in RB2B webhook documentation', () => {
  assert.strictEqual(
    normalizeSeenAt('2024-01-01T12:34:56:00.00+00.00'),
    '2024-01-01T12:34:56.000Z',
  );
});

test('rejects payloads outside the Truewind website', () => {
  assert.throws(
    () => normalizeRb2bPayload(payload({ 'Captured URL': 'https://attacker.example/path' })),
    /outside the configured Truewind hosts/,
  );
});

test('distinct visits get distinct IDs while retries keep the same ID', () => {
  const first = normalizeRb2bPayload(payload());
  const retry = normalizeRb2bPayload(payload());
  const later = normalizeRb2bPayload(payload({ 'Seen At': '2026-07-28T19:05:06-07:00' }));
  assert.strictEqual(buildVisitUniqueId(first, 'contact-1'), buildVisitUniqueId(retry, 'contact-1'));
  assert.notStrictEqual(buildVisitUniqueId(first, 'contact-1'), buildVisitUniqueId(later, 'contact-1'));
});

test('initial webhook deliveries use the shared backfill idempotency key', () => {
  const initial = normalizeRb2bPayload(payload({ is_repeat_visitor: false }));
  assert.strictEqual(buildVisitUniqueId(initial, 'contact-1'), initialVisitUniqueId('contact-1'));
});

test('requires exact RB2B creation attribution for owner changes', () => {
  assert.strictEqual(isRb2bCreatedRecord(rb2bRecord('1')), true);
  assert.strictEqual(isRb2bCreatedRecord(rb2bRecord('2', { rb2b_source: 'false' })), false);
  assert.strictEqual(
    isRb2bCreatedRecord(rb2bRecord('3', { hs_object_source_detail_1: 'Other Integration' })),
    false,
  );
});

test('creates one note, assigns Nicole, and remains idempotent on retry', async () => {
  const contact = rb2bRecord('contact-1');
  const company = rb2bRecord('company-1');
  const notes = new Map();
  const writes = [];
  const hubspot = async (path, method = 'GET', body = null) => {
    if (path === '/crm/v3/objects/contacts/search') return { results: [contact] };
    if (path === '/crm/v4/objects/contacts/contact-1/associations/companies?limit=100') {
      return { results: [{ toObjectId: 'company-1' }] };
    }
    if (path === '/crm/v3/objects/companies/batch/read') return { results: [company] };
    if (path === '/crm/v3/objects/notes/search') {
      const key = body.filterGroups[0].filters[0].value;
      return { results: notes.has(key) ? [notes.get(key)] : [] };
    }
    if (path === '/crm/v3/objects/notes' && method === 'POST') {
      const note = { id: `note-${notes.size + 1}`, properties: body.properties };
      notes.set(body.properties.hs_unique_id, note);
      writes.push({ path, method, body });
      return note;
    }
    if (path === '/crm/v3/objects/contacts/contact-1' && method === 'PATCH') {
      contact.properties.hubspot_owner_id = body.properties.hubspot_owner_id;
      writes.push({ path, method, body });
      return contact;
    }
    if (path === '/crm/v3/objects/companies/company-1' && method === 'PATCH') {
      company.properties.hubspot_owner_id = body.properties.hubspot_owner_id;
      writes.push({ path, method, body });
      return company;
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  };

  const first = await processRb2bVisit(payload(), { hubspot });
  const retry = await processRb2bVisit(payload(), { hubspot });

  assert.strictEqual(first.status, 'created');
  assert.strictEqual(retry.status, 'already_processed');
  assert.strictEqual(notes.size, 1);
  assert.strictEqual(contact.properties.hubspot_owner_id, '94834941');
  assert.strictEqual(company.properties.hubspot_owner_id, '94834941');
  assert.strictEqual(writes.filter((write) => write.path === '/crm/v3/objects/notes').length, 1);
  assert.deepStrictEqual(writes.find((write) => write.path === '/crm/v3/objects/notes').body.associations, [{
    to: { id: 'contact-1' },
    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
  }]);
});

test('does not overwrite owners on existing records merely enriched by RB2B', async () => {
  const contact = rb2bRecord('contact-existing', {
    rb2b_source: 'false',
    hs_object_source_id: 'USER',
    hs_object_source_detail_1: '',
    hubspot_owner_id: 'another-owner',
  });
  const writes = [];
  const hubspot = async (path, method = 'GET', body = null) => {
    if (path === '/crm/v3/objects/contacts/search') return { results: [contact] };
    if (path.includes('/associations/companies')) return { results: [] };
    if (path === '/crm/v3/objects/notes/search') return { results: [] };
    if (path === '/crm/v3/objects/notes' && method === 'POST') {
      writes.push({ path, body });
      return { id: 'note-existing-contact', properties: body.properties };
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const result = await processRb2bVisit(payload(), { hubspot });
  assert.strictEqual(result.status, 'created');
  assert.strictEqual(contact.properties.hubspot_owner_id, 'another-owner');
  assert.strictEqual(writes.length, 1);
});

test('fails closed on conflicting email and LinkedIn identity', async () => {
  const hubspot = async (path) => {
    if (path === '/crm/v3/objects/contacts/search') {
      return {
        results: [rb2bRecord('contact-1', {
          email: 'person@example.com',
          linkedin_personal_url: 'https://linkedin.com/in/different-person',
        })],
      };
    }
    throw new Error(`Unexpected request ${path}`);
  };
  await assert.rejects(
    processRb2bVisit(payload(), { hubspot, contactLookup: { attempts: 1 } }),
    /conflicts with RB2B LinkedIn identity/,
  );
});

test('webhook route rejects the wrong query secret before any HubSpot call', async () => {
  let calls = 0;
  const response = await invokeWebhook({
    url: '/webhooks/rb2b?secret=wrong',
    body: JSON.stringify(payload()),
    hubspot: async () => {
      calls += 1;
      return {};
    },
  });
  assert.strictEqual(response.statusCode, 401);
  assert.strictEqual(response.body, 'unauthorized');
  assert.strictEqual(calls, 0);
});

test('webhook route accepts RB2B test payloads without mutation', async () => {
  let calls = 0;
  const response = await invokeWebhook({
    url: '/webhooks/rb2b?secret=configured-secret',
    body: JSON.stringify(payload({
      'First Name': 'RB2B',
      'Last Name': 'Test Payload',
      Title: 'Test Payload',
    })),
    hubspot: async () => {
      calls += 1;
      return {};
    },
  });
  assert.strictEqual(response.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(response.body), { ok: true, status: 'test_accepted' });
  assert.strictEqual(calls, 0);
});
