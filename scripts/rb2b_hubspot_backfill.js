#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

const {
  DEFAULT_OWNER_ID,
  DEFAULT_RB2B_INTEGRATION_ID,
  NOTE_TO_CONTACT_ASSOCIATION_TYPE_ID,
  formatVisitNoteBody,
  initialVisitUniqueId,
  isRb2bCreatedRecord,
  repeatVisitUniqueId,
} = require('./slack/rb2b_hubspot');

const DEFAULT_PREVIEW_PATH = path.resolve(
  process.cwd(),
  'outputs/rb2b/rb2b-visit-notes-owner-preview.json',
);
const NOTE_PROPERTIES = ['hs_unique_id', 'hs_note_body', 'hs_timestamp'];
const CONTACT_PROPERTIES = [
  'createdate',
  'rb2b_captured_at',
  'rb2b_last_logged_activity',
  'rb2b_source',
  'hs_object_source',
  'hs_object_source_id',
  'hs_object_source_detail_1',
  'hubspot_owner_id',
];
const COMPANY_PROPERTIES = [
  'createdate',
  'rb2b_captured_at',
  'rb2b_source',
  'hs_object_source',
  'hs_object_source_id',
  'hs_object_source_detail_1',
  'hubspot_owner_id',
];

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function parseArgs(argv) {
  const args = {
    apply: false,
    previewPath: DEFAULT_PREVIEW_PATH,
    outputPath: DEFAULT_PREVIEW_PATH,
    timelineEventsPath: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--apply') args.apply = true;
    else if (value === '--preview') args.previewPath = path.resolve(argv[++index]);
    else if (value === '--output') args.outputPath = path.resolve(argv[++index]);
    else if (value === '--timeline-events') args.timelineEventsPath = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (args.apply && !argv.includes('--preview')) {
    throw new Error('--apply requires an explicit --preview artifact');
  }
  if (!args.apply && !args.timelineEventsPath) {
    throw new Error('Preview requires --timeline-events from the authenticated seven-day HubSpot audit');
  }
  return args;
}

function createHubSpotClient(token, {
  maxAttempts = 5,
  timeoutMs = 30000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!clean(token)) throw new Error('Missing HUBSPOT_PRIVATE_TOKEN or HUBSPOT_ACCESS_TOKEN');
  return async function hubspot(endpoint, method = 'GET', body = null) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await new Promise((resolve, reject) => {
          const url = new URL(endpoint.startsWith('http') ? endpoint : `https://api.hubapi.com${endpoint}`);
          const req = https.request({
            hostname: url.hostname,
            path: `${url.pathname}${url.search}`,
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
          }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              let parsed = {};
              try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { message: text }; }
              if (res.statusCode < 200 || res.statusCode >= 300) {
                const error = new Error(`HubSpot ${res.statusCode}: ${parsed.message || parsed.category || 'request failed'}`);
                error.statusCode = res.statusCode;
                error.body = parsed;
                reject(error);
                return;
              }
              resolve(parsed);
            });
          });
          req.setTimeout(timeoutMs, () => req.destroy(new Error('HubSpot request timed out')));
          req.on('error', reject);
          if (body) req.write(JSON.stringify(body));
          req.end();
        });
        return result;
      } catch (error) {
        lastError = error;
        if (![429, 500, 502, 503, 504].includes(error.statusCode) || attempt === maxAttempts) throw error;
        const retryAfter = Number(error.body?.policyName === 'SECONDLY' ? 1000 : 0);
        await sleep(Math.max(retryAfter, 500 * (2 ** (attempt - 1))));
      }
    }
    throw lastError;
  };
}

async function searchAll(hubspot, objectType, filterGroups, properties) {
  const results = [];
  let after;
  do {
    const body = { filterGroups, properties, limit: 200, sorts: ['createdate'] };
    if (after) body.after = after;
    const page = await hubspot(`/crm/v3/objects/${objectType}/search`, 'POST', body);
    results.push(...(page.results || []));
    after = page.paging?.next?.after;
  } while (after);
  return results;
}

async function findExistingInitialNotes(hubspot, uniqueIds) {
  if (!uniqueIds.length) return new Map();
  const found = new Map();
  for (let index = 0; index < uniqueIds.length; index += 100) {
    const values = uniqueIds.slice(index, index + 100);
    const response = await hubspot('/crm/v3/objects/notes/search', 'POST', {
      filterGroups: [{ filters: [{ propertyName: 'hs_unique_id', operator: 'IN', values }] }],
      properties: NOTE_PROPERTIES,
      limit: 200,
    });
    for (const note of response.results || []) {
      found.set(clean(note.properties?.hs_unique_id), note);
    }
  }
  return found;
}

function recordSnapshot(record, properties) {
  return {
    id: String(record.id),
    properties: Object.fromEntries(properties.map((key) => [key, clean(record.properties?.[key])])),
  };
}

function buildScopeHash({ contacts, companies, sourceContacts, sourceCompanies, enrichedContacts }) {
  return sha256({
    contacts: contacts.map((record) => recordSnapshot(record, CONTACT_PROPERTIES)).sort((a, b) => a.id.localeCompare(b.id)),
    companies: companies.map((record) => recordSnapshot(record, COMPANY_PROPERTIES)).sort((a, b) => a.id.localeCompare(b.id)),
    sourceContactIds: sourceContacts.map((record) => String(record.id)).sort(),
    sourceCompanyIds: sourceCompanies.map((record) => String(record.id)).sort(),
    enrichedContactIds: enrichedContacts.map((record) => String(record.id)).sort(),
  });
}

function validateTimelineAudit(timelineAudit, contacts, integrationId) {
  if (!timelineAudit || timelineAudit.schemaVersion !== 1 || !Array.isArray(timelineAudit.events)) {
    throw new Error('Unsupported timeline audit artifact');
  }
  if (clean(timelineAudit.integrationId) !== clean(integrationId)) {
    throw new Error('Timeline audit integration ID mismatch');
  }
  const generatedAt = new Date(clean(timelineAudit.generatedAt)).getTime();
  const windowStart = new Date(clean(timelineAudit.windowStart)).getTime();
  if (Number.isNaN(generatedAt) || Number.isNaN(windowStart) || generatedAt < windowStart) {
    throw new Error('Timeline audit has an invalid time window');
  }
  if (generatedAt - windowStart > (7 * 24 * 60 * 60 * 1000) + (5 * 60 * 1000)) {
    throw new Error('Timeline audit exceeds the seven-day review window');
  }
  const contactIds = new Set(contacts.map((contact) => String(contact.id)));
  const seenEventIds = new Set();
  const coveredContactIds = new Set();
  for (const event of timelineAudit.events) {
    const contactId = clean(event.contactId);
    const eventId = clean(event.eventId);
    const timestamp = clean(event.timestamp);
    if (!contactIds.has(contactId)) throw new Error(`Timeline audit contains out-of-scope contact ${contactId}`);
    if (!eventId.startsWith('eventIntegrations-')) throw new Error(`Invalid RB2B timeline event ID for ${contactId}`);
    if (seenEventIds.has(eventId)) throw new Error(`Duplicate timeline event ${eventId}`);
    const eventTime = new Date(timestamp).getTime();
    if (!timestamp || Number.isNaN(eventTime)) {
      throw new Error(`Invalid timeline timestamp for ${contactId}`);
    }
    if (eventTime < windowStart || eventTime > generatedAt) {
      throw new Error(`Timeline event for ${contactId} is outside the seven-day audit window`);
    }
    seenEventIds.add(eventId);
    coveredContactIds.add(contactId);
  }
  const missing = [...contactIds].filter((id) => !coveredContactIds.has(id));
  if (missing.length) throw new Error(`Timeline audit is missing ${missing.length} scoped contacts`);
  return {
    contactCount: contactIds.size,
    eventCount: timelineAudit.events.length,
    repeatEventCount: timelineAudit.events.length - contactIds.size,
  };
}

function buildContactPlans(contacts, existingNotes, timelineAudit, {
  ownerId = DEFAULT_OWNER_ID,
  integrationId = DEFAULT_RB2B_INTEGRATION_ID,
  timeZone = 'America/Los_Angeles',
} = {}) {
  validateTimelineAudit(timelineAudit, contacts, integrationId);
  const eventsByContact = new Map();
  for (const event of timelineAudit.events) {
    const contactId = String(event.contactId);
    const events = eventsByContact.get(contactId) || [];
    events.push(event);
    eventsByContact.set(contactId, events);
  }
  return contacts.map((contact) => {
    const createdAt = clean(contact.properties?.createdate);
    if (!createdAt || Number.isNaN(new Date(createdAt).getTime())) {
      throw new Error(`RB2B contact ${contact.id} has no valid createdate`);
    }
    if (!isRb2bCreatedRecord(contact, integrationId)) {
      throw new Error(`Contact ${contact.id} failed exact RB2B source validation`);
    }
    const events = eventsByContact.get(String(contact.id))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const notes = events.map((event, index) => {
      const uniqueId = index === 0
        ? initialVisitUniqueId(contact.id)
        : repeatVisitUniqueId(contact.id, event.timestamp);
      const existing = existingNotes.get(uniqueId);
      return {
        timelineEventId: event.eventId,
        visitOrdinal: index + 1,
        uniqueId,
        timestamp: event.timestamp,
        body: formatVisitNoteBody(event.timestamp, timeZone),
        action: existing ? 'skip_existing' : 'create',
        existingNoteId: existing ? String(existing.id) : '',
      };
    });
    return {
      contactId: String(contact.id),
      sourceValidated: true,
      createdAt,
      rb2bCapturedAt: clean(contact.properties?.rb2b_captured_at),
      rb2bLatestActivity: clean(contact.properties?.rb2b_last_logged_activity),
      currentOwnerId: clean(contact.properties?.hubspot_owner_id),
      proposedOwnerId: clean(ownerId),
      ownerAction: clean(contact.properties?.hubspot_owner_id) === clean(ownerId) ? 'skip_already_owned' : 'assign',
      notes,
    };
  });
}

function buildCompanyPlans(companies, {
  ownerId = DEFAULT_OWNER_ID,
  integrationId = DEFAULT_RB2B_INTEGRATION_ID,
} = {}) {
  return companies.map((company) => {
    if (!isRb2bCreatedRecord(company, integrationId)) {
      throw new Error(`Company ${company.id} failed exact RB2B source validation`);
    }
    return {
      companyId: String(company.id),
      sourceValidated: true,
      currentOwnerId: clean(company.properties?.hubspot_owner_id),
      proposedOwnerId: clean(ownerId),
      ownerAction: clean(company.properties?.hubspot_owner_id) === clean(ownerId) ? 'skip_already_owned' : 'assign',
    };
  });
}

async function collectScope(hubspot, integrationId = DEFAULT_RB2B_INTEGRATION_ID) {
  const rb2bFilter = [{ filters: [{ propertyName: 'rb2b_source', operator: 'EQ', value: 'true' }] }];
  const sourceFilter = [{ filters: [{ propertyName: 'hs_object_source_id', operator: 'EQ', value: clean(integrationId) }] }];
  const activityFilter = [{ filters: [{ propertyName: 'rb2b_last_logged_activity', operator: 'HAS_PROPERTY' }] }];
  const [contacts, companies, sourceContacts, sourceCompanies, activityContacts] = await Promise.all([
    searchAll(hubspot, 'contacts', rb2bFilter, CONTACT_PROPERTIES),
    searchAll(hubspot, 'companies', rb2bFilter, COMPANY_PROPERTIES),
    searchAll(hubspot, 'contacts', sourceFilter, CONTACT_PROPERTIES),
    searchAll(hubspot, 'companies', sourceFilter, COMPANY_PROPERTIES),
    searchAll(hubspot, 'contacts', activityFilter, CONTACT_PROPERTIES),
  ]);
  const createdIds = new Set(contacts.map((record) => String(record.id)));
  const enrichedContacts = activityContacts.filter((record) => !createdIds.has(String(record.id)));
  return { contacts, companies, sourceContacts, sourceCompanies, enrichedContacts };
}

async function validateOwnerIdentity(hubspot, ownerId) {
  const owner = await hubspot(`/crm/v3/owners/${encodeURIComponent(ownerId)}`);
  const valid = String(owner.id) === clean(ownerId)
    && clean(owner.firstName) === 'Nicole'
    && clean(owner.lastName) === 'Shen'
    && owner.archived !== true;
  if (!valid) throw new Error(`Owner ${ownerId} is not the active Nicole Shen HubSpot owner`);
  return true;
}

async function buildPreview(hubspot, {
  ownerId = DEFAULT_OWNER_ID,
  integrationId = DEFAULT_RB2B_INTEGRATION_ID,
  timeZone = 'America/Los_Angeles',
  timelineAudit,
} = {}) {
  const [scope] = await Promise.all([
    collectScope(hubspot, integrationId),
    validateOwnerIdentity(hubspot, ownerId),
  ]);
  const timelineQa = validateTimelineAudit(timelineAudit, scope.contacts, integrationId);
  const provisional = buildContactPlans(scope.contacts, new Map(), timelineAudit, { ownerId, integrationId, timeZone });
  const uniqueIds = provisional.flatMap((plan) => plan.notes.map((note) => note.uniqueId));
  const existingNotes = await findExistingInitialNotes(hubspot, uniqueIds);
  const contactPlans = buildContactPlans(scope.contacts, existingNotes, timelineAudit, { ownerId, integrationId, timeZone });
  const companyPlans = buildCompanyPlans(scope.companies, { ownerId, integrationId });
  const rb2bContactIds = scope.contacts.map((record) => String(record.id)).sort();
  const sourceContactIds = scope.sourceContacts.map((record) => String(record.id)).sort();
  const rb2bCompanyIds = scope.companies.map((record) => String(record.id)).sort();
  const sourceCompanyIds = scope.sourceCompanies.map((record) => String(record.id)).sort();
  const preview = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    mode: 'preview',
    target: {
      ownerId: clean(ownerId),
      ownerName: 'Nicole Shen',
      integrationId: clean(integrationId),
      sourceDetail: 'RB2B for CRM',
      timeZone,
    },
    qa: {
      ownerIdentityValidated: true,
      timelineAudit: timelineQa,
      exactSourceParity: {
        contacts: stableJson(rb2bContactIds) === stableJson(sourceContactIds),
        companies: stableJson(rb2bCompanyIds) === stableJson(sourceCompanyIds),
      },
      rb2bContactCount: contactPlans.length,
      rb2bCompanyCount: companyPlans.length,
      enrichedButNotCreatedContactCount: scope.enrichedContacts.length,
      enrichedButNotCreatedContactIds: scope.enrichedContacts.map((record) => String(record.id)).sort(),
      noteCreates: contactPlans.flatMap((plan) => plan.notes).filter((note) => note.action === 'create').length,
      noteSkips: contactPlans.flatMap((plan) => plan.notes).filter((note) => note.action === 'skip_existing').length,
      contactOwnerAssignments: contactPlans.filter((plan) => plan.ownerAction === 'assign').length,
      companyOwnerAssignments: companyPlans.filter((plan) => plan.ownerAction === 'assign').length,
    },
    scopeHash: buildScopeHash(scope),
    timelineAudit,
    contactPlans,
    companyPlans,
  };
  preview.previewHash = sha256(preview);
  return preview;
}

function validatePreviewArtifact(preview) {
  if (!preview || preview.schemaVersion !== 2 || preview.mode !== 'preview') {
    throw new Error('Unsupported preview artifact');
  }
  const suppliedHash = clean(preview.previewHash);
  const copy = { ...preview };
  delete copy.previewHash;
  if (!suppliedHash || suppliedHash !== sha256(copy)) throw new Error('Preview hash validation failed');
  if (!preview.qa?.exactSourceParity?.contacts || !preview.qa?.exactSourceParity?.companies) {
    throw new Error('Preview source parity gate failed');
  }
  if (!preview.qa?.ownerIdentityValidated) throw new Error('Preview owner identity gate failed');
  validateTimelineAudit(
    preview.timelineAudit,
    preview.contactPlans.map((plan) => ({ id: plan.contactId })),
    preview.target.integrationId,
  );
  if (preview.contactPlans.some((plan) => !plan.sourceValidated)
      || preview.companyPlans.some((plan) => !plan.sourceValidated)) {
    throw new Error('Preview contains an unvalidated source record');
  }
}

async function findNoteByUniqueId(hubspot, uniqueId) {
  const response = await hubspot('/crm/v3/objects/notes/search', 'POST', {
    filterGroups: [{ filters: [{ propertyName: 'hs_unique_id', operator: 'EQ', value: uniqueId }] }],
    properties: NOTE_PROPERTIES,
    limit: 2,
  });
  if ((response.results || []).length > 1) throw new Error(`Duplicate notes for ${uniqueId}`);
  return (response.results || [])[0] || null;
}

async function createVisitNote(hubspot, contactId, notePlan) {
  const existing = await findNoteByUniqueId(hubspot, notePlan.uniqueId);
  if (existing) return { action: 'skip_existing', noteId: String(existing.id) };
  try {
    const note = await hubspot('/crm/v3/objects/notes', 'POST', {
      properties: {
        hs_unique_id: notePlan.uniqueId,
        hs_note_body: notePlan.body,
        hs_timestamp: notePlan.timestamp,
      },
      associations: [{
        to: { id: contactId },
        types: [{
          associationCategory: 'HUBSPOT_DEFINED',
          associationTypeId: NOTE_TO_CONTACT_ASSOCIATION_TYPE_ID,
        }],
      }],
    });
    return { action: 'created', noteId: String(note.id) };
  } catch (error) {
    if (error.statusCode !== 409) throw error;
    const raced = await findNoteByUniqueId(hubspot, notePlan.uniqueId);
    if (!raced) throw error;
    return { action: 'skip_existing', noteId: String(raced.id) };
  }
}

async function applyPreview(hubspot, preview) {
  validatePreviewArtifact(preview);
  const current = await buildPreview(hubspot, {
    ...preview.target,
    timelineAudit: preview.timelineAudit,
  });
  if (current.scopeHash !== preview.scopeHash) {
    throw new Error('HubSpot scope changed after preview; generate and review a fresh preview');
  }
  const mutations = {
    contactOwnersAssigned: [],
    companyOwnersAssigned: [],
    notesCreated: [],
    notesExisting: [],
  };
  for (const plan of preview.contactPlans) {
    if (plan.ownerAction === 'assign') {
      await hubspot(`/crm/v3/objects/contacts/${encodeURIComponent(plan.contactId)}`, 'PATCH', {
        properties: { hubspot_owner_id: preview.target.ownerId },
      });
      mutations.contactOwnersAssigned.push(plan.contactId);
    }
    for (const notePlan of plan.notes) {
      const note = await createVisitNote(hubspot, plan.contactId, notePlan);
      mutations[note.action === 'created' ? 'notesCreated' : 'notesExisting'].push({
        contactId: plan.contactId,
        noteId: note.noteId,
        uniqueId: notePlan.uniqueId,
      });
    }
  }
  for (const plan of preview.companyPlans) {
    if (plan.ownerAction !== 'assign') continue;
    await hubspot(`/crm/v3/objects/companies/${encodeURIComponent(plan.companyId)}`, 'PATCH', {
      properties: { hubspot_owner_id: preview.target.ownerId },
    });
    mutations.companyOwnersAssigned.push(plan.companyId);
  }
  const readback = await buildPreview(hubspot, {
    ...preview.target,
    timelineAudit: preview.timelineAudit,
  });
  const verified = {
    contactOwners: readback.contactPlans.every((plan) => plan.currentOwnerId === preview.target.ownerId),
    companyOwners: readback.companyPlans.every((plan) => plan.currentOwnerId === preview.target.ownerId),
    notes: readback.contactPlans.every(
      (plan) => plan.notes.every((note) => note.action === 'skip_existing' && note.existingNoteId),
    ),
    sourceParity: readback.qa.exactSourceParity.contacts && readback.qa.exactSourceParity.companies,
    contactCount: readback.contactPlans.length === preview.contactPlans.length,
    companyCount: readback.companyPlans.length === preview.companyPlans.length,
  };
  if (Object.values(verified).some((value) => value !== true)) {
    throw new Error(`Post-write readback failed: ${JSON.stringify(verified)}`);
  }
  return {
    schemaVersion: 1,
    appliedAt: new Date().toISOString(),
    previewHash: preview.previewHash,
    target: preview.target,
    mutations,
    verified,
    finalCounts: {
      contacts: readback.contactPlans.length,
      companies: readback.companyPlans.length,
      notes: readback.contactPlans.flatMap((plan) => plan.notes).filter((note) => note.existingNoteId).length,
    },
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.HUBSPOT_PRIVATE_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN;
  const hubspot = createHubSpotClient(token);
  if (!args.apply) {
    const timelineAudit = JSON.parse(fs.readFileSync(args.timelineEventsPath, 'utf8'));
    const preview = await buildPreview(hubspot, {
      ownerId: process.env.RB2B_HUBSPOT_OWNER_ID || DEFAULT_OWNER_ID,
      integrationId: process.env.RB2B_HUBSPOT_INTEGRATION_ID || DEFAULT_RB2B_INTEGRATION_ID,
      timeZone: process.env.RB2B_VISIT_TIME_ZONE || 'America/Los_Angeles',
      timelineAudit,
    });
    writeJson(args.outputPath, preview);
    console.log(JSON.stringify({
      mode: 'preview',
      output: args.outputPath,
      previewHash: preview.previewHash,
      qa: preview.qa,
    }, null, 2));
    return;
  }
  const preview = JSON.parse(fs.readFileSync(args.previewPath, 'utf8'));
  const readback = await applyPreview(hubspot, preview);
  const readbackPath = args.outputPath === DEFAULT_PREVIEW_PATH
    ? args.previewPath.replace(/\.json$/i, '.readback.json')
    : args.outputPath;
  writeJson(readbackPath, readback);
  console.log(JSON.stringify({
    mode: 'apply',
    readback: readbackPath,
    previewHash: readback.previewHash,
    verified: readback.verified,
    finalCounts: readback.finalCounts,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  applyPreview,
  buildCompanyPlans,
  buildContactPlans,
  buildPreview,
  buildScopeHash,
  createHubSpotClient,
  validateOwnerIdentity,
  validateTimelineAudit,
  parseArgs,
  sha256,
  stableJson,
  validatePreviewArtifact,
};
