const crypto = require('crypto');

const DEFAULT_OWNER_ID = '94834941';
const DEFAULT_RB2B_INTEGRATION_ID = '4209312';
const DEFAULT_ALLOWED_HOSTS = ['truewind.ai', 'www.truewind.ai'];
const NOTE_TO_CONTACT_ASSOCIATION_TYPE_ID = 202;
const MAX_BODY_BYTES = 64 * 1024;

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function normalizeLinkedInUrl(value) {
  const raw = clean(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    return `${url.hostname.toLowerCase()}${path}`;
  } catch {
    return raw.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

function normalizeSeenAt(value) {
  const raw = clean(value);
  if (!raw) throw new Error('Missing Seen At');
  const repaired = raw
    .replace(/([+-]\d{2})\.(\d{2})$/, '$1:$2')
    .replace(/(T\d{2}:\d{2}:\d{2}):(\d{2})(\.\d+)?([+-]\d{2}:\d{2})$/, '$1.$2$4');
  const date = new Date(repaired);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid Seen At');
  return date.toISOString();
}

function parseAllowedHosts(value) {
  const hosts = clean(value)
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return hosts.length ? hosts : DEFAULT_ALLOWED_HOSTS;
}

function normalizeRb2bPayload(payload, { allowedHosts = DEFAULT_ALLOWED_HOSTS } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('RB2B payload must be an object');
  }
  const linkedInUrl = clean(payload['LinkedIn URL']);
  const email = normalizeEmail(payload['Business Email']);
  const capturedUrl = clean(payload['Captured URL']);
  if (!linkedInUrl) throw new Error('Missing LinkedIn URL');
  if (!capturedUrl) throw new Error('Missing Captured URL');
  let capturedHost;
  try {
    capturedHost = new URL(capturedUrl).hostname.toLowerCase();
  } catch {
    throw new Error('Invalid Captured URL');
  }
  if (!allowedHosts.includes(capturedHost)) {
    throw new Error('Captured URL is outside the configured Truewind hosts');
  }
  return {
    linkedInUrl,
    linkedInKey: normalizeLinkedInUrl(linkedInUrl),
    email,
    capturedUrl,
    capturedHost,
    seenAt: normalizeSeenAt(payload['Seen At']),
    isRepeat: payload.is_repeat_visitor === true || payload.is_repeat_visit === true,
    isTest: clean(payload['First Name']).toLowerCase() === 'rb2b'
      && /test payload/i.test(clean(payload['Last Name']) + ' ' + clean(payload.Title)),
  };
}

function initialVisitUniqueId(contactId) {
  const digest = crypto
    .createHash('sha256')
    .update(clean(contactId))
    .digest('hex');
  return `rb2b-initial-${digest}`;
}

function repeatVisitUniqueId(contactId, seenAt) {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify([clean(contactId), normalizeSeenAt(seenAt)]))
    .digest('hex');
  return `rb2b-visit-${digest}`;
}

function buildVisitUniqueId(visit, contactId) {
  return visit.isRepeat
    ? repeatVisitUniqueId(contactId, visit.seenAt)
    : initialVisitUniqueId(contactId);
}

function formatVisitNoteBody(seenAt, timeZone = 'America/Los_Angeles') {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(seenAt));
  return `${formatted} visited main website`;
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(clean(left));
  const b = Buffer.from(clean(right));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readRawBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function searchContacts(hubspot, propertyName, value) {
  const response = await hubspot('/crm/v3/objects/contacts/search', 'POST', {
    filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }],
    properties: [
      'email',
      'linkedin_personal_url',
      'rb2b_source',
      'hs_object_source_id',
      'hs_object_source_detail_1',
      'hubspot_owner_id',
    ],
    limit: 3,
  });
  return response.results || [];
}

function assertUnambiguousContact(results, signal) {
  if (results.length > 1) throw new Error(`Ambiguous HubSpot contact match by ${signal}`);
  return results[0] || null;
}

async function findContactOnce(hubspot, visit) {
  if (visit.email) {
    const byEmail = assertUnambiguousContact(
      await searchContacts(hubspot, 'email', visit.email),
      'email',
    );
    if (byEmail) {
      const storedLinkedIn = normalizeLinkedInUrl(byEmail.properties?.linkedin_personal_url);
      if (storedLinkedIn && storedLinkedIn !== visit.linkedInKey) {
        throw new Error('HubSpot email match conflicts with RB2B LinkedIn identity');
      }
      return byEmail;
    }
  }
  const candidates = [...new Set([
    visit.linkedInUrl,
    visit.linkedInUrl.replace(/\/+$/, ''),
    `${visit.linkedInUrl.replace(/\/+$/, '')}/`,
  ])];
  for (const candidate of candidates) {
    const byLinkedIn = assertUnambiguousContact(
      await searchContacts(hubspot, 'linkedin_personal_url', candidate),
      'LinkedIn URL',
    );
    if (byLinkedIn) return byLinkedIn;
  }
  return null;
}

async function findContactWithRetry(hubspot, visit, {
  attempts = 5,
  delayMs = 1500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const contact = await findContactOnce(hubspot, visit);
    if (contact) return contact;
    if (attempt < attempts) await sleep(delayMs * attempt);
  }
  return null;
}

function isRb2bCreatedRecord(record, integrationId = DEFAULT_RB2B_INTEGRATION_ID) {
  const properties = record?.properties || {};
  return clean(properties.rb2b_source).toLowerCase() === 'true'
    && clean(properties.hs_object_source_id) === clean(integrationId)
    && clean(properties.hs_object_source_detail_1) === 'RB2B for CRM';
}

async function findNoteByUniqueId(hubspot, uniqueId) {
  const response = await hubspot('/crm/v3/objects/notes/search', 'POST', {
    filterGroups: [{ filters: [{ propertyName: 'hs_unique_id', operator: 'EQ', value: uniqueId }] }],
    properties: ['hs_unique_id', 'hs_note_body', 'hs_timestamp'],
    limit: 2,
  });
  const results = response.results || [];
  if (results.length > 1) throw new Error('Duplicate HubSpot notes share the RB2B unique ID');
  return results[0] || null;
}

async function ensureVisitNote(hubspot, { contactId, visit, timeZone }) {
  const uniqueId = buildVisitUniqueId(visit, contactId);
  const existing = await findNoteByUniqueId(hubspot, uniqueId);
  if (existing) return { note: existing, created: false, uniqueId };
  const body = formatVisitNoteBody(visit.seenAt, timeZone);
  try {
    const note = await hubspot('/crm/v3/objects/notes', 'POST', {
      properties: {
        hs_timestamp: visit.seenAt,
        hs_note_body: body,
        hs_unique_id: uniqueId,
      },
      associations: [{
        to: { id: String(contactId) },
        types: [{
          associationCategory: 'HUBSPOT_DEFINED',
          associationTypeId: NOTE_TO_CONTACT_ASSOCIATION_TYPE_ID,
        }],
      }],
    });
    return { note, created: true, uniqueId };
  } catch (error) {
    if (error.statusCode !== 409) throw error;
    const raced = await findNoteByUniqueId(hubspot, uniqueId);
    if (!raced) throw error;
    return { note: raced, created: false, uniqueId };
  }
}

async function assignNicoleToRb2bRecords(hubspot, contact, {
  ownerId = DEFAULT_OWNER_ID,
  integrationId = DEFAULT_RB2B_INTEGRATION_ID,
} = {}) {
  const updated = { contact: false, companies: [] };
  if (isRb2bCreatedRecord(contact, integrationId)
      && clean(contact.properties?.hubspot_owner_id) !== clean(ownerId)) {
    await hubspot(`/crm/v3/objects/contacts/${encodeURIComponent(contact.id)}`, 'PATCH', {
      properties: { hubspot_owner_id: clean(ownerId) },
    });
    updated.contact = true;
  }

  const associations = await hubspot(
    `/crm/v4/objects/contacts/${encodeURIComponent(contact.id)}/associations/companies?limit=100`,
  );
  const companyIds = (associations.results || []).map((item) => String(item.toObjectId));
  if (!companyIds.length) return updated;
  const companies = await hubspot('/crm/v3/objects/companies/batch/read', 'POST', {
    properties: [
      'rb2b_source',
      'hs_object_source_id',
      'hs_object_source_detail_1',
      'hubspot_owner_id',
    ],
    inputs: companyIds.map((id) => ({ id })),
  });
  for (const company of companies.results || []) {
    if (!isRb2bCreatedRecord(company, integrationId)) continue;
    if (clean(company.properties?.hubspot_owner_id) === clean(ownerId)) continue;
    await hubspot(`/crm/v3/objects/companies/${encodeURIComponent(company.id)}`, 'PATCH', {
      properties: { hubspot_owner_id: clean(ownerId) },
    });
    updated.companies.push(String(company.id));
  }
  return updated;
}

async function processRb2bVisit(payload, {
  hubspot,
  ownerId = DEFAULT_OWNER_ID,
  integrationId = DEFAULT_RB2B_INTEGRATION_ID,
  allowedHosts = DEFAULT_ALLOWED_HOSTS,
  timeZone = 'America/Los_Angeles',
  contactLookup,
} = {}) {
  if (typeof hubspot !== 'function') throw new Error('HubSpot client is required');
  const visit = normalizeRb2bPayload(payload, { allowedHosts });
  if (visit.isTest) return { status: 'test_accepted', mutated: false };
  const contact = await findContactWithRetry(hubspot, visit, contactLookup);
  if (!contact) throw new Error('RB2B visitor not found in HubSpot after retry window');
  const ownership = await assignNicoleToRb2bRecords(hubspot, contact, { ownerId, integrationId });
  const noteResult = await ensureVisitNote(hubspot, {
    contactId: contact.id,
    visit,
    timeZone,
  });
  return {
    status: noteResult.created ? 'created' : 'already_processed',
    contactId: String(contact.id),
    noteId: String(noteResult.note.id),
    uniqueId: noteResult.uniqueId,
    ownership,
  };
}

async function handleRb2bHubSpotWebhook(req, res, {
  hubspot,
  secret = process.env.RB2B_WEBHOOK_SECRET,
  ownerId = process.env.RB2B_HUBSPOT_OWNER_ID || DEFAULT_OWNER_ID,
  integrationId = process.env.RB2B_HUBSPOT_INTEGRATION_ID || DEFAULT_RB2B_INTEGRATION_ID,
  allowedHosts = parseAllowedHosts(process.env.RB2B_ALLOWED_HOSTS),
  timeZone = process.env.RB2B_VISIT_TIME_ZONE || 'America/Los_Angeles',
  contactLookup,
  logger = console,
} = {}) {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('method_not_allowed');
    return;
  }
  if (!clean(secret)) {
    res.writeHead(503);
    res.end('not_configured');
    return;
  }
  const supplied = new URL(req.url, 'http://localhost').searchParams.get('secret');
  if (!timingSafeEqual(supplied, secret)) {
    res.writeHead(401);
    res.end('unauthorized');
    return;
  }
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch {
    res.writeHead(413);
    res.end('body_too_large');
    return;
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    res.writeHead(400);
    res.end('invalid_json');
    return;
  }
  try {
    const result = await processRb2bVisit(payload, {
      hubspot,
      ownerId,
      integrationId,
      allowedHosts,
      timeZone,
      contactLookup,
    });
    logger.log?.(JSON.stringify({
      event: 'rb2b_hubspot_visit_processed',
      status: result.status,
      contact_id: result.contactId,
      note_id: result.noteId,
      contact_owner_updated: result.ownership?.contact || false,
      company_owner_updates: result.ownership?.companies?.length || 0,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: result.status }));
  } catch (error) {
    const clientError = /payload|Missing|Invalid|outside|conflicts|Ambiguous/.test(error.message);
    logger.error?.(JSON.stringify({
      event: 'rb2b_hubspot_visit_failed',
      error: clean(error.message).slice(0, 300),
    }));
    res.writeHead(clientError ? 400 : 503);
    res.end(clientError ? 'invalid_payload' : 'processing_failed');
  }
}

module.exports = {
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_OWNER_ID,
  DEFAULT_RB2B_INTEGRATION_ID,
  NOTE_TO_CONTACT_ASSOCIATION_TYPE_ID,
  assignNicoleToRb2bRecords,
  buildVisitUniqueId,
  ensureVisitNote,
  findContactOnce,
  formatVisitNoteBody,
  handleRb2bHubSpotWebhook,
  initialVisitUniqueId,
  isRb2bCreatedRecord,
  normalizeLinkedInUrl,
  normalizeRb2bPayload,
  normalizeSeenAt,
  parseAllowedHosts,
  processRb2bVisit,
  repeatVisitUniqueId,
  timingSafeEqual,
};
