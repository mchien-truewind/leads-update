const https = require('https');

const DEFAULT_LIST_ID = '694';
const DEFAULT_TARGET_CHANNEL = 'slack-testing';
const DEFAULT_LOOKBACK_HOURS = 28;
const DEFAULT_TOUCHPOINT_DAYS = 90;
const DEFAULT_TOUCHPOINT_SOURCE = 'engagements';
const DEFAULT_BDR_OWNER_IDS = ['84547076', '89305622', '91143842', '91143844'];
const DEFAULT_NOOKS_NOT_INTERESTED_DISPOSITION_IDS = ['739e9efc-95d4-448d-9440-7a14287a02fa'];
const DEFAULT_BDR_EMAILS = [
  'sarah@trytruewind.com',
  'xavier@trytruewind.com',
  'jenilee@trytruewind.com',
  'brendan@trytruewind.com',
];

const STATUS = {
  NEW: 'No one has contacted them',
  WORKING: 'Has contacted but no response',
  NURTURING: 'has contacted & responded',
  CONVERTED: 'MQL',
  DISQUALIFIED: 'Disqualified (all)',
};

const DISQUALIFIED_REASONS = {
  NOT_INTERESTED: 'Not Interested',
  BAD_CONTACT_INFO: 'Bad Contact Info',
  OTHER: 'Other',
};

const STATUS_RANK = {
  [STATUS.NEW]: 1,
  [STATUS.WORKING]: 2,
  [STATUS.NURTURING]: 3,
  [STATUS.CONVERTED]: 4,
};

const RECENT_ACTIVITY_SEARCH_FIELDS = [
  'notes_last_contacted',
  'notes_last_updated',
  'hs_last_sales_activity_timestamp',
  'hs_latest_sequence_enrolled_date',
  'hs_latest_meeting_activity',
  'engagements_last_meeting_booked',
  'heyreach_last_activity_date',
];

const CONTACT_PROPERTIES = [
  'email',
  'firstname',
  'lastname',
  'company',
  'jobtitle',
  'hubspot_owner_id',
  'lifecyclestage',
  'hs_lead_status',
  'disqualified_reasons',
  'do_not_contact',
  'hs_email_optout',
  'hs_email_hard_bounce_reason',
  'hs_email_hard_bounce_reason_enum',
  'hs_email_quarantined_reason',
  'hs_email_customer_quarantined_reason',
  'hs_sales_email_last_replied',
  'hs_email_last_reply_date',
  'hs_email_first_reply_date',
  'heyreach_first_reply_date',
  'heyreach_last_reply_date',
  'heyreach_reply_count',
  'heyreach_reply_received',
  'calendly_meeting_booked',
  'notes_last_contacted',
  'num_contacted_notes',
  'hs_last_sales_activity_timestamp',
  'hs_last_sales_activity_type',
  'hs_latest_sequence_enrolled_date',
  'hs_sequences_enrolled_count',
  'hs_sequences_actively_enrolled_count',
  'hs_sequences_is_enrolled',
  'heyreach_last_activity_date',
  'bdr_touchpoints_90d',
  'bdr_touchpoints_90d_updated_at',
];

const ALLOWED_ENGAGEMENT_TYPES = new Set(['EMAIL', 'CALL', 'MEETING', 'TASK']);
const INBOUND_DIRECTIONS = new Set(['INCOMING', 'INBOUND']);
const NOTE_EXCLUSION_PATTERNS = [
  { reason: 'email_open', pattern: /\b(email\s+)?open(?:ed)?\b/i },
  { reason: 'email_click', pattern: /\bclick(?:ed)?\b/i },
  { reason: 'bounce', pattern: /\b(bounce|bounced|hard bounce|soft bounce)\b/i },
  { reason: 'sequence_or_list', pattern: /\b(sequence|enroll(?:ed|ment)?|unenroll(?:ed|ment)?|list membership|workflow)\b/i },
  { reason: 'inbound_reply', pattern: /\b(replied|reply|responded|response from|emailed back|wrote back|inbound)\b/i },
];
const EMAIL_SENT_PATTERNS = [
  /\b(email|sales email|outbound email)\b[^.\n]{0,80}\b(sent|delivered)\b/i,
  /\b(sent|delivered)\b[^.\n]{0,80}\b(email|sales email|outbound email)\b/i,
  /\bemailed\b/i,
];
const MESSAGE_SENT_PATTERNS = [
  /\b(linkedin|heyreach)\b[^.\n]{0,100}\b(message|dm|inmail|connection request|connect request)\b[^.\n]{0,80}\b(sent|delivered)\b/i,
  /\b(sent|delivered)\b[^.\n]{0,80}\b(linkedin|heyreach)\b[^.\n]{0,80}\b(message|dm|inmail|connection request|connect request)\b/i,
  /\bmessage\s+sent\b/i,
  /\bsent\s+(?:a\s+)?message\b/i,
];

function parseDelimitedList(value, fallback = []) {
  const parsed = String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  return parsed.length ? parsed : fallback;
}

function truthy(value) {
  return ['true', '1', 'yes'].includes(String(value || '').trim().toLowerCase());
}

function positiveInt(value) {
  const n = Number.parseInt(String(value || '0'), 10);
  return Number.isFinite(n) && n > 0;
}

function hasValue(value) {
  return String(value ?? '').trim() !== '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? 0 : Math.max(0, dateMs - Date.now());
}

function hubspotRetryDelayMs({ statusCode, retryAfterMs = 0, attempt }) {
  if (retryAfterMs > 0) return Math.min(retryAfterMs, 30000);
  if (statusCode === 429) return Math.min(2500 * (attempt + 1), 15000);
  return Math.min(1000 * Math.pow(2, attempt), 15000);
}

function isRetryableHubSpotError(err) {
  if (!err) return false;
  if (err.statusCode === 429 || (err.statusCode >= 500 && err.statusCode < 600)) return true;
  return !err.statusCode;
}

function makeDefaultConfig(env = process.env) {
  const touchpointSource = normalizeTouchpointSource(env.LEAD_STATUS_SYNC_TOUCHPOINT_SOURCE || DEFAULT_TOUCHPOINT_SOURCE);
  return {
    listId: env.LEAD_STATUS_SYNC_LIST_ID || DEFAULT_LIST_ID,
    targetChannel: env.LEAD_STATUS_SYNC_TARGET_CHANNEL || DEFAULT_TARGET_CHANNEL,
    triggerSecret: env.LEAD_STATUS_SYNC_TRIGGER_SECRET || env.LEAD_REPORT_TRIGGER_SECRET || '',
    lookbackHours: Number(env.LEAD_STATUS_SYNC_LOOKBACK_HOURS || DEFAULT_LOOKBACK_HOURS),
    touchpointDays: Number(env.LEAD_STATUS_SYNC_TOUCHPOINT_DAYS || DEFAULT_TOUCHPOINT_DAYS),
    touchpointSource,
    previewLimit: Number(env.LEAD_STATUS_SYNC_PREVIEW_LIMIT || 50),
    bdrOwnerIds: parseDelimitedList(env.LEAD_STATUS_SYNC_BDR_OWNER_IDS, DEFAULT_BDR_OWNER_IDS).map(String),
    bdrEmails: parseDelimitedList(env.LEAD_STATUS_SYNC_BDR_EMAILS, DEFAULT_BDR_EMAILS).map(email => email.toLowerCase()),
    enableNooksNotInterestedSync: String(env.LEAD_STATUS_SYNC_ENABLE_NOOKS_NOT_INTERESTED || 'true').toLowerCase() !== 'false',
    nooksNotInterestedDispositionIds: parseDelimitedList(
      env.LEAD_STATUS_SYNC_NOOKS_NOT_INTERESTED_DISPOSITION_IDS,
      DEFAULT_NOOKS_NOT_INTERESTED_DISPOSITION_IDS,
    ).map(String),
    searchDelayMs: Number(env.LEAD_STATUS_SYNC_SEARCH_DELAY_MS || 250),
    generalDelayMs: Number(env.LEAD_STATUS_SYNC_GENERAL_DELAY_MS || 80),
    engagementConcurrency: Number(env.LEAD_STATUS_SYNC_ENGAGEMENT_CONCURRENCY || (touchpointSource === 'engagements' ? 6 : 2)),
  };
}

function normalizeTouchpointSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['notes', 'engagements', 'hybrid'].includes(normalized)) return normalized;
  return DEFAULT_TOUCHPOINT_SOURCE;
}

async function hubspotFetch(path, options = {}, config = {}) {
  const token = config.hubspotToken || process.env.HUBSPOT_PRIVATE_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error('Missing HubSpot token for lead status sync');

  for (let attempt = 0; attempt < 7; attempt += 1) {
    let response;
    try {
      response = await fetch(`https://api.hubapi.com${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(options.headers || {}),
        },
      });
    } catch (err) {
      if (isRetryableHubSpotError(err) && attempt < 6) {
        await sleep(hubspotRetryDelayMs({
          statusCode: err.statusCode,
          retryAfterMs: err.retryAfterMs,
          attempt,
        }));
        continue;
      }
      throw err;
    }
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = text; }

    if (response.ok) return body;
    if ((response.status === 429 || response.status >= 500) && attempt < 6) {
      await sleep(hubspotRetryDelayMs({
        statusCode: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        attempt,
      }));
      continue;
    }
    const message = typeof body === 'string' ? body : (body.message || JSON.stringify(body));
    throw new Error(`HubSpot ${response.status}: ${message}`);
  }
  throw new Error(`HubSpot request exhausted retries: ${path}`);
}

function makeHttpsHubSpotFetch(token) {
  async function request(path, options = {}) {
    for (let attempt = 0; attempt < 7; attempt += 1) {
      try {
        return await requestOnce(path, options);
      } catch (err) {
        if (!isRetryableHubSpotError(err) || attempt >= 6) throw err;
        await sleep(hubspotRetryDelayMs({
          statusCode: err.statusCode,
          retryAfterMs: err.retryAfterMs,
          attempt,
        }));
      }
    }
    throw new Error(`HubSpot request exhausted retries: ${path}`);
  }

  function requestOnce(path, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(`https://api.hubapi.com${path}`);
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(options.headers || {}),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let body;
          try { body = data ? JSON.parse(data) : {}; } catch { body = data; }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const msg = typeof body === 'string' ? body : (body.message || JSON.stringify(body));
            const err = new Error(`HubSpot ${res.statusCode}: ${msg}`);
            err.statusCode = res.statusCode;
            err.retryAfterMs = parseRetryAfterMs(res.headers['retry-after']);
            reject(err);
            return;
          }
          resolve(body);
        });
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  return request;
}

async function getListMemberIds(hubspot, listId, config) {
  const ids = [];
  let after = '';
  do {
    const qs = new URLSearchParams({ limit: '250' });
    if (after) qs.set('after', after);
    const data = await hubspot(`/crm/v3/lists/${listId}/memberships/join-order?${qs}`);
    for (const row of data.results || []) ids.push(String(row.recordId));
    after = data.paging?.next?.after || '';
    if (config.generalDelayMs) await sleep(config.generalDelayMs);
  } while (after);
  return [...new Set(ids)];
}

async function searchRecentContactIds(hubspot, field, sinceMs, config) {
  const ids = [];
  let after;
  do {
    const body = {
      filterGroups: [{ filters: [{ propertyName: field, operator: 'GTE', value: String(sinceMs) }] }],
      properties: ['hs_object_id'],
      limit: 200,
      sorts: [{ propertyName: field, direction: 'DESCENDING' }],
    };
    if (after) body.after = after;
    try {
      const data = await hubspot('/crm/v3/objects/contacts/search', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      for (const row of data.results || []) ids.push(String(row.id));
      after = data.paging?.next?.after;
    } catch (err) {
      if (/PROPERTY_DOESNT_EXIST|does not exist|VALIDATION_ERROR/i.test(err.message)) return ids;
      throw err;
    }
    if (config.searchDelayMs) await sleep(config.searchDelayMs);
  } while (after);
  return ids;
}

async function batchReadContacts(hubspot, ids, config) {
  const contacts = [];
  for (let i = 0; i < ids.length; i += 100) {
    const data = await hubspot('/crm/v3/objects/contacts/batch/read', {
      method: 'POST',
      body: JSON.stringify({
        properties: CONTACT_PROPERTIES,
        inputs: ids.slice(i, i + 100).map(id => ({ id })),
      }),
    });
    contacts.push(...(data.results || []));
    if (config.generalDelayMs) await sleep(config.generalDelayMs);
  }
  return contacts;
}

async function searchNooksNotInterestedCalls(hubspot, sinceMs, config) {
  const callsById = new Map();
  const filterGroups = [];
  const baseFilters = [
    { propertyName: 'hs_object_source_detail_1', operator: 'EQ', value: 'Nooks' },
  ];
  if (sinceMs) {
    baseFilters.push({ propertyName: 'hs_createdate', operator: 'GTE', value: String(sinceMs) });
  }

  for (const dispositionId of config.nooksNotInterestedDispositionIds || []) {
    filterGroups.push({
      filters: [
        ...baseFilters,
        { propertyName: 'hs_call_disposition', operator: 'EQ', value: dispositionId },
      ],
    });
  }
  filterGroups.push({
    filters: [
      ...baseFilters,
      { propertyName: 'hs_call_title', operator: 'CONTAINS_TOKEN', value: 'Not interested' },
    ],
  });

  for (const filterGroup of filterGroups) {
    let after;
    do {
      const body = {
        filterGroups: [filterGroup],
        properties: [
          'hs_call_title',
          'hs_call_disposition',
          'hs_createdate',
          'hs_object_source_detail_1',
          'hubspot_owner_id',
        ],
        limit: 100,
        sorts: [{ propertyName: 'hs_createdate', direction: 'DESCENDING' }],
      };
      if (after) body.after = after;
      const data = await hubspot('/crm/v3/objects/calls/search', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      for (const call of data.results || []) {
        const ownerId = String(call.properties?.hubspot_owner_id || '');
        if (ownerId && config.bdrOwnerIds.includes(ownerId)) callsById.set(String(call.id), call);
      }
      after = data.paging?.next?.after;
      if (config.searchDelayMs) await sleep(config.searchDelayMs);
    } while (after);
  }

  return [...callsById.values()];
}

async function readCallContactAssociations(hubspot, callIds, config) {
  const contactIds = new Set();
  for (let i = 0; i < callIds.length; i += 100) {
    const data = await hubspot('/crm/v4/associations/calls/contacts/batch/read', {
      method: 'POST',
      body: JSON.stringify({
        inputs: callIds.slice(i, i + 100).map(id => ({ id })),
      }),
    });
    for (const row of data.results || []) {
      for (const target of row.to || []) {
        const id = target.toObjectId || target.id;
        if (id) contactIds.add(String(id));
      }
    }
    if (config.generalDelayMs) await sleep(config.generalDelayMs);
  }
  return [...contactIds];
}

async function findNooksNotInterestedContactIds(hubspot, sinceMs, config) {
  const calls = await searchNooksNotInterestedCalls(hubspot, sinceMs, config);
  if (!calls.length) return { callCount: 0, contactIds: [] };
  const contactIds = await readCallContactAssociations(hubspot, calls.map(call => String(call.id)), config);
  return { callCount: calls.length, contactIds };
}

function metadataEmail(metadata) {
  return String(metadata?.from?.email || metadata?.fromEmail || metadata?.senderEmail || '').toLowerCase();
}

function stripHubSpotHtml(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function noteTimestampMs(note) {
  const properties = note.properties || {};
  const raw = properties.hs_timestamp || properties.hs_createdate || properties.createdate || note.createdAt;
  if (!raw) return 0;
  if (/^\d+$/.test(String(raw))) return Number(raw);
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function noteOwnerId(note) {
  return String(note.properties?.hubspot_owner_id || '');
}

function noteBody(note) {
  return stripHubSpotHtml(note.properties?.hs_note_body || note.properties?.hs_body || '');
}

function noteTouchpointChannel(text) {
  if (EMAIL_SENT_PATTERNS.some(pattern => pattern.test(text))) return 'email';
  if (MESSAGE_SENT_PATTERNS.some(pattern => pattern.test(text))) return 'message';
  return '';
}

function classifyTouchpointNote(note, sinceMs, config) {
  const timestamp = noteTimestampMs(note);
  if (!timestamp || timestamp < sinceMs) return { include: false, reason: 'outside_window' };

  const text = noteBody(note);
  if (!text) return { include: false, reason: 'empty_note' };
  for (const exclusion of NOTE_EXCLUSION_PATTERNS) {
    if (exclusion.pattern.test(text)) return { include: false, reason: exclusion.reason };
  }

  const channel = noteTouchpointChannel(text);
  if (!channel) return { include: false, reason: 'unmatched_note_pattern' };
  return {
    include: true,
    reason: `${channel}_sent`,
    channel,
    dedupeKey: noteDedupeKey(note, channel, text),
  };
}

function callTimestampMs(call) {
  const properties = call.properties || {};
  const raw = properties.hs_timestamp || properties.hs_createdate || properties.createdate || call.createdAt;
  if (!raw) return 0;
  if (/^\d+$/.test(String(raw))) return Number(raw);
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function callTitle(call) {
  return stripHubSpotHtml(call.properties?.hs_call_title || call.properties?.hs_call_body || '');
}

function classifyTouchpointCall(call, sinceMs) {
  const timestamp = callTimestampMs(call);
  if (!timestamp || timestamp < sinceMs) return { include: false, reason: 'outside_window' };
  const direction = String(call.properties?.hs_call_direction || '').toUpperCase();
  if (INBOUND_DIRECTIONS.has(direction)) return { include: false, reason: 'inbound_call' };
  return {
    include: true,
    reason: 'call',
    channel: 'call',
    dedupeKey: `call:${call.id || callTitle(call)}:${timestamp}`,
  };
}

function noteDedupeKey(note, channel, text = noteBody(note)) {
  const timestamp = noteTimestampMs(note);
  const bucketMs = timestamp ? Math.floor(timestamp / (5 * 60 * 1000)) * 5 * 60 * 1000 : 0;
  const owner = noteOwnerId(note) || 'unknown';
  const normalizedText = text.toLowerCase().replace(/\s+/g, ' ').slice(0, 160);
  let hash = 0;
  for (let i = 0; i < normalizedText.length; i += 1) {
    hash = ((hash << 5) - hash) + normalizedText.charCodeAt(i);
    hash |= 0;
  }
  return `${channel}:${owner}:${bucketMs}:${Math.abs(hash)}`;
}

function isBdrEngagement(engagement, metadata, config) {
  const ownerId = String(engagement.ownerId || '');
  if (ownerId && config.bdrOwnerIds.includes(ownerId)) return true;
  const fromEmail = metadataEmail(metadata);
  return Boolean(fromEmail && config.bdrEmails.includes(fromEmail));
}

function includeTouchpointEngagement(item, sinceMs, config) {
  const engagement = item.engagement || {};
  const metadata = item.metadata || {};
  const type = String(engagement.type || '').toUpperCase();
  if (!ALLOWED_ENGAGEMENT_TYPES.has(type)) return false;
  const timestamp = Number(engagement.timestamp || 0);
  if (!timestamp || timestamp < sinceMs) return false;
  if (!isBdrEngagement(engagement, metadata, config)) return false;

  const direction = String(metadata.direction || '').toUpperCase();
  if ((type === 'EMAIL' || type === 'CALL') && INBOUND_DIRECTIONS.has(direction)) return false;
  return true;
}

async function countTouchpoints90d(hubspot, contactId, sinceMs, config) {
  let count = 0;
  let offset = '';
  do {
    const qs = new URLSearchParams({ limit: '100' });
    if (offset) qs.set('offset', offset);
    const data = await hubspot(`/engagements/v1/engagements/associated/CONTACT/${contactId}/paged?${qs}`);
    for (const item of data.results || []) {
      if (includeTouchpointEngagement(item, sinceMs, config)) count += 1;
    }
    offset = data.hasMore ? String(data.offset || '') : '';
    if (config.generalDelayMs) await sleep(Math.min(config.generalDelayMs, 50));
  } while (offset);
  return count;
}

async function readContactNoteAssociations(hubspot, contactId, config) {
  const noteIds = [];
  let after = '';
  do {
    const qs = new URLSearchParams({ limit: '500' });
    if (after) qs.set('after', after);
    const data = await hubspot(`/crm/v4/objects/contacts/${contactId}/associations/notes?${qs}`);
    for (const row of data.results || []) {
      const id = row.toObjectId || row.id;
      if (id) noteIds.push(String(id));
    }
    after = data.paging?.next?.after || '';
    if (config.generalDelayMs) await sleep(Math.min(config.generalDelayMs, 50));
  } while (after);
  return [...new Set(noteIds)];
}

async function readContactActivityAssociations(hubspot, contactId, activityType, config) {
  const ids = [];
  let after = '';
  do {
    const qs = new URLSearchParams({ limit: '500' });
    if (after) qs.set('after', after);
    const data = await hubspot(`/crm/v4/objects/contacts/${contactId}/associations/${activityType}?${qs}`);
    for (const row of data.results || []) {
      const id = row.toObjectId || row.id;
      if (id) ids.push(String(id));
    }
    after = data.paging?.next?.after || '';
    if (config.generalDelayMs) await sleep(Math.min(config.generalDelayMs, 50));
  } while (after);
  return [...new Set(ids)];
}

async function batchReadNotes(hubspot, noteIds, config) {
  const notes = [];
  for (let i = 0; i < noteIds.length; i += 100) {
    const data = await hubspot('/crm/v3/objects/notes/batch/read', {
      method: 'POST',
      body: JSON.stringify({
        properties: [
          'hs_note_body',
          'hs_timestamp',
          'hs_createdate',
          'hubspot_owner_id',
          'hs_created_by_user_id',
        ],
        inputs: noteIds.slice(i, i + 100).map(id => ({ id })),
      }),
    });
    notes.push(...(data.results || []));
    if (config.generalDelayMs) await sleep(config.generalDelayMs);
  }
  return notes;
}

async function batchReadCalls(hubspot, callIds, config) {
  const calls = [];
  for (let i = 0; i < callIds.length; i += 100) {
    const data = await hubspot('/crm/v3/objects/calls/batch/read', {
      method: 'POST',
      body: JSON.stringify({
        properties: [
          'hs_call_title',
          'hs_call_body',
          'hs_call_direction',
          'hs_call_status',
          'hs_timestamp',
          'hs_createdate',
          'hs_object_source_detail_1',
        ],
        inputs: callIds.slice(i, i + 100).map(id => ({ id })),
      }),
    });
    calls.push(...(data.results || []));
    if (config.generalDelayMs) await sleep(config.generalDelayMs);
  }
  return calls;
}

function summarizeNoteTouchpoints(notes, sinceMs, config) {
  const counted = [];
  const excluded = {};
  const seen = new Set();
  let duplicates = 0;

  for (const note of notes) {
    const classification = classifyTouchpointNote(note, sinceMs, config);
    if (!classification.include) {
      addCount(excluded, classification.reason);
      continue;
    }
    if (seen.has(classification.dedupeKey)) {
      duplicates += 1;
      addCount(excluded, 'duplicate');
      continue;
    }
    seen.add(classification.dedupeKey);
    counted.push({
      id: String(note.id),
      channel: classification.channel,
      reason: classification.reason,
      timestamp: noteTimestampMs(note),
      ownerId: noteOwnerId(note),
    });
  }

  return {
    count: counted.length,
    counted,
    excluded,
    duplicates,
    notesScanned: notes.length,
  };
}

function summarizeCallTouchpoints(calls, sinceMs) {
  const counted = [];
  const excluded = {};
  const seen = new Set();
  let duplicates = 0;

  for (const call of calls) {
    const classification = classifyTouchpointCall(call, sinceMs);
    if (!classification.include) {
      addCount(excluded, classification.reason);
      continue;
    }
    if (seen.has(classification.dedupeKey)) {
      duplicates += 1;
      addCount(excluded, 'duplicate');
      continue;
    }
    seen.add(classification.dedupeKey);
    counted.push({
      id: String(call.id),
      channel: classification.channel,
      reason: classification.reason,
      timestamp: callTimestampMs(call),
    });
  }

  return {
    count: counted.length,
    counted,
    excluded,
    duplicates,
    callsScanned: calls.length,
  };
}

async function countNoteTouchpoints90d(hubspot, contactId, sinceMs, config) {
  const noteIds = await readContactNoteAssociations(hubspot, contactId, config);
  const callIds = await readContactActivityAssociations(hubspot, contactId, 'calls', config);
  const callSummary = callIds.length
    ? summarizeCallTouchpoints(await batchReadCalls(hubspot, callIds, config), sinceMs)
    : { count: 0, counted: [], excluded: {}, duplicates: 0, callsScanned: 0 };
  if (!noteIds.length) {
    return {
      count: callSummary.count,
      counted: callSummary.counted,
      excluded: callSummary.excluded,
      duplicates: callSummary.duplicates,
      notesScanned: 0,
      callsScanned: callSummary.callsScanned,
    };
  }
  const noteSummary = summarizeNoteTouchpoints(await batchReadNotes(hubspot, noteIds, config), sinceMs, config);
  return {
    count: noteSummary.count + callSummary.count,
    counted: [...noteSummary.counted, ...callSummary.counted].sort((a, b) => a.timestamp - b.timestamp),
    excluded: mergeCountMaps(noteSummary.excluded, callSummary.excluded),
    duplicates: noteSummary.duplicates + callSummary.duplicates,
    notesScanned: noteSummary.notesScanned,
    callsScanned: callSummary.callsScanned,
  };
}

function mergeCountMaps(...maps) {
  const merged = {};
  for (const map of maps) {
    for (const [key, count] of Object.entries(map || {})) addCount(merged, key, count);
  }
  return merged;
}

async function calculateTouchpoints90d(hubspot, contactId, sinceMs, config) {
  if (config.touchpointSource === 'notes') {
    const noteSummary = await countNoteTouchpoints90d(hubspot, contactId, sinceMs, config);
    return { count: noteSummary.count, source: 'notes', noteSummary };
  }
  if (config.touchpointSource === 'hybrid') {
    const noteSummary = await countNoteTouchpoints90d(hubspot, contactId, sinceMs, config);
    if (noteSummary.notesScanned > 0) return { count: noteSummary.count, source: 'notes', noteSummary };
    return { count: await countTouchpoints90d(hubspot, contactId, sinceMs, config), source: 'engagements_fallback', noteSummary };
  }
  return { count: await countTouchpoints90d(hubspot, contactId, sinceMs, config), source: 'engagements' };
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const results = new Array(items.length);
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
  return results;
}

function hasReplySignal(properties) {
  return hasValue(properties.hs_sales_email_last_replied)
    || hasValue(properties.hs_email_last_reply_date)
    || hasValue(properties.hs_email_first_reply_date)
    || hasValue(properties.heyreach_first_reply_date)
    || hasValue(properties.heyreach_last_reply_date)
    || positiveInt(properties.heyreach_reply_count)
    || truthy(properties.heyreach_reply_received)
    || truthy(properties.calendly_meeting_booked);
}

function disqualifiedSignal(properties) {
  if (truthy(properties.do_not_contact) || truthy(properties.hs_email_optout)) {
    return DISQUALIFIED_REASONS.NOT_INTERESTED;
  }
  if (
    hasValue(properties.hs_email_hard_bounce_reason)
    || hasValue(properties.hs_email_hard_bounce_reason_enum)
    || hasValue(properties.hs_email_quarantined_reason)
    || hasValue(properties.hs_email_customer_quarantined_reason)
  ) {
    return DISQUALIFIED_REASONS.BAD_CONTACT_INFO;
  }
  return '';
}

function isProtectedContact(properties) {
  const status = properties.hs_lead_status || '';
  const lifecycle = String(properties.lifecyclestage || '').toLowerCase();
  if (status === STATUS.CONVERTED) return true;
  if (lifecycle === 'customer' || lifecycle === 'evangelist' || lifecycle === 'opportunity') return true;
  return false;
}

function canMoveToStatus(currentStatus, targetStatus) {
  if (!targetStatus || currentStatus === targetStatus) return false;
  if (!currentStatus) return true;
  if (targetStatus === STATUS.DISQUALIFIED) return currentStatus !== STATUS.CONVERTED;
  if (currentStatus === STATUS.DISQUALIFIED || currentStatus === STATUS.CONVERTED) return false;
  return (STATUS_RANK[targetStatus] || 0) > (STATUS_RANK[currentStatus] || 0);
}

function classifyLeadStatus(contact, touchpointCount, signals = {}) {
  const properties = contact.properties || {};
  const currentStatus = properties.hs_lead_status || '';
  const currentReason = properties.disqualified_reasons || '';

  if (signals.nooksNotInterested) {
    return {
      targetStatus: STATUS.DISQUALIFIED,
      disqualifiedReason: DISQUALIFIED_REASONS.NOT_INTERESTED,
      reason: 'nooks_not_interested',
      forceDisqualifiedReason: true,
    };
  }

  if (currentStatus === STATUS.DISQUALIFIED) {
    if (!currentReason) {
      return {
        targetStatus: STATUS.DISQUALIFIED,
        disqualifiedReason: disqualifiedSignal(properties) || DISQUALIFIED_REASONS.OTHER,
        reason: 'backfill_disqualified_reason',
      };
    }
    return { reason: 'protected_disqualified' };
  }
  if (isProtectedContact(properties)) return { reason: 'protected' };

  const disqualifiedReason = disqualifiedSignal(properties);
  if (disqualifiedReason) {
    return { targetStatus: STATUS.DISQUALIFIED, disqualifiedReason, reason: 'disqualified_signal' };
  }
  if (hasReplySignal(properties)) {
    return { targetStatus: STATUS.NURTURING, reason: 'reply_signal' };
  }
  if (touchpointCount > 0) {
    return { targetStatus: STATUS.WORKING, reason: 'touchpoint_signal' };
  }
  if (!currentStatus) {
    return { targetStatus: STATUS.NEW, reason: 'blank_no_activity' };
  }
  return { reason: 'no_change_signal' };
}

function addCount(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function batchUpdateContacts(hubspot, inputs, config) {
  for (let i = 0; i < inputs.length; i += 100) {
    await hubspot('/crm/v3/objects/contacts/batch/update', {
      method: 'POST',
      body: JSON.stringify({ inputs: inputs.slice(i, i + 100) }),
    });
    if (config.generalDelayMs) await sleep(config.generalDelayMs);
  }
}

function buildContactUpdate(contact, targetStatus, disqualifiedReason, touchpointCount, calculatedAtMs, options = {}) {
  const properties = contact.properties || {};
  const update = {};
  const forceDisqualification = Boolean(
    options.forceDisqualifiedReason
      && targetStatus === STATUS.DISQUALIFIED
      && disqualifiedReason,
  );

  if (forceDisqualification) {
    if ((properties.hs_lead_status || '') !== targetStatus) {
      update.hs_lead_status = targetStatus;
    }
    if ((properties.disqualified_reasons || '') !== disqualifiedReason) {
      update.disqualified_reasons = disqualifiedReason;
    }
  } else if (canMoveToStatus(properties.hs_lead_status || '', targetStatus)) {
    update.hs_lead_status = targetStatus;
    if (targetStatus === STATUS.DISQUALIFIED && disqualifiedReason) {
      update.disqualified_reasons = properties.disqualified_reasons || disqualifiedReason;
    }
  } else if (
    (properties.hs_lead_status || '') === STATUS.DISQUALIFIED
    && targetStatus === STATUS.DISQUALIFIED
    && disqualifiedReason
    && !properties.disqualified_reasons
  ) {
    update.disqualified_reasons = disqualifiedReason;
  }

  if (String(properties.bdr_touchpoints_90d || '') !== String(touchpointCount)) {
    update.bdr_touchpoints_90d = String(touchpointCount);
    update.bdr_touchpoints_90d_updated_at = String(calculatedAtMs);
  }

  return update;
}

function transitionLabel(currentStatus, targetStatus) {
  return `${currentStatus || '(blank)'} -> ${targetStatus}`;
}

function formatLeadStatusSyncSummary(stats) {
  const transitions = Object.entries(stats.transitions)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `- ${label}: ${count}`)
    .join('\n') || '- none';
  const reasonLines = Object.entries(stats.disqualifiedReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `- ${label}: ${count}`)
    .join('\n') || '- none';

  const avg = stats.workingTouchpointContacts
    ? (stats.workingTouchpointTotal / stats.workingTouchpointContacts).toFixed(2)
    : '0';

  return [
    `Lead status sync complete (${stats.mode}${stats.dryRun ? ', dry run' : ''})`,
    '',
    `Scanned candidates: ${stats.candidateCount}`,
    `Contacts evaluated: ${stats.listCandidateCount}`,
    `Contacts updated: ${stats.updatedContacts}`,
    `Status changes: ${stats.statusUpdates}`,
    `Touchpoint field changes: ${stats.touchpointUpdates}`,
    `Touchpoint source: ${stats.touchpointSource || 'engagements'}`,
    `Notes scanned: ${stats.notesScanned || 0}`,
    `Notes counted: ${stats.notesCounted || 0}`,
    `Calls scanned: ${stats.callsScanned || 0}`,
    `Calls counted: ${stats.callsCounted || 0}`,
    `Duplicate notes excluded: ${stats.duplicateNotes || 0}`,
    `Nooks not interested calls: ${stats.nooksNotInterestedCalls || 0}`,
    `Nooks not interested contacts: ${stats.nooksNotInterestedContacts || 0}`,
    `Errors: ${stats.errors}`,
    '',
    'Stage moves:',
    transitions,
    '',
    'Disqualified reasons:',
    reasonLines,
    '',
    'Working touchpoints, last 90 days:',
    `- Working contacts recalculated: ${stats.workingTouchpointContacts}`,
    `- Total touchpoints: ${stats.workingTouchpointTotal}`,
    `- Average: ${avg}`,
    `- Median: ${stats.workingTouchpointMedian}`,
  ].join('\n');
}

async function runLeadStatusSync(options = {}) {
  const config = { ...makeDefaultConfig(options.env || process.env), ...options };
  config.touchpointSource = normalizeTouchpointSource(config.touchpointSource);
  const logger = config.logger || console;
  const mode = config.mode || 'incremental';
  const now = config.now || new Date();
  const lookbackMs = Math.max(1, config.lookbackHours) * 60 * 60 * 1000;
  const touchpointSinceMs = now.getTime() - (Math.max(1, config.touchpointDays) * 24 * 60 * 60 * 1000);
  const calculatedAtMs = now.getTime();
  const hubspot = config.hubspot
    || (config.hubspotToken
      ? makeHttpsHubSpotFetch(config.hubspotToken)
      : (path, requestOptions = {}) => hubspotFetch(path, requestOptions, config));
  const postSlackMessage = config.postSlackMessage;

  const listIds = await getListMemberIds(hubspot, config.listId, config);
  const listSet = new Set(listIds);
  let candidateIds = listIds;
  const nooksNotInterestedContactIds = new Set();
  let nooksNotInterestedCalls = 0;

  if (config.enableNooksNotInterestedSync) {
    const sinceMs = mode === 'full' ? 0 : now.getTime() - lookbackMs;
    const nooksResult = await findNooksNotInterestedContactIds(hubspot, sinceMs, config);
    nooksNotInterestedCalls = nooksResult.callCount;
    for (const id of nooksResult.contactIds) nooksNotInterestedContactIds.add(id);
    logger.log?.(
      `Lead status sync: Nooks not interested calls=${nooksNotInterestedCalls} `
      + `contacts=${nooksNotInterestedContactIds.size}`,
    );
  }

  if (mode !== 'full') {
    const found = new Set();
    const sinceMs = now.getTime() - lookbackMs;
    for (const field of RECENT_ACTIVITY_SEARCH_FIELDS) {
      const ids = await searchRecentContactIds(hubspot, field, sinceMs, config);
      for (const id of ids) {
        if (listSet.has(id)) found.add(id);
      }
      logger.log?.(`Lead status sync: ${field} candidates=${ids.length}`);
    }
    candidateIds = [...found];
  }
  for (const id of nooksNotInterestedContactIds) candidateIds.push(id);
  candidateIds = [...new Set(candidateIds)];

  const contacts = await batchReadContacts(hubspot, candidateIds, config);
  const updates = [];
  const errors = [];
  const workingTouchpoints = [];
  const stats = {
    mode,
    candidateCount: candidateIds.length,
    listCandidateCount: contacts.length,
    updatedContacts: 0,
    statusUpdates: 0,
    touchpointUpdates: 0,
    errors: 0,
    nooksNotInterestedCalls,
    nooksNotInterestedContacts: nooksNotInterestedContactIds.size,
    touchpointSource: config.touchpointSource,
    notesScanned: 0,
    notesCounted: 0,
    callsScanned: 0,
    callsCounted: 0,
    duplicateNotes: 0,
    noteExclusions: {},
    preview: [],
    transitions: {},
    disqualifiedReasons: {},
    workingTouchpointContacts: 0,
    workingTouchpointTotal: 0,
    workingTouchpointMedian: 0,
  };

  await mapLimit(contacts, config.engagementConcurrency, async (contact) => {
    try {
      const touchpointResult = await calculateTouchpoints90d(hubspot, contact.id, touchpointSinceMs, config);
      const touchpointCount = touchpointResult.count;
      if (touchpointResult.noteSummary) {
        stats.notesScanned += touchpointResult.noteSummary.notesScanned;
        stats.notesCounted += touchpointResult.noteSummary.counted.filter(item => item.channel !== 'call').length;
        stats.callsScanned += touchpointResult.noteSummary.callsScanned || 0;
        stats.callsCounted += touchpointResult.noteSummary.counted.filter(item => item.channel === 'call').length;
        stats.duplicateNotes += touchpointResult.noteSummary.duplicates;
        for (const [reason, count] of Object.entries(touchpointResult.noteSummary.excluded)) {
          addCount(stats.noteExclusions, reason, count);
        }
      }
      const classification = classifyLeadStatus(contact, touchpointCount, {
        nooksNotInterested: nooksNotInterestedContactIds.has(String(contact.id)),
      });
      const update = buildContactUpdate(
        contact,
        classification.targetStatus,
        classification.disqualifiedReason,
        touchpointCount,
        calculatedAtMs,
        { forceDisqualifiedReason: classification.forceDisqualifiedReason },
      );

      const currentStatus = contact.properties?.hs_lead_status || '';
      const effectiveStatus = update.hs_lead_status || currentStatus;
      if (effectiveStatus === STATUS.WORKING) {
        workingTouchpoints.push(touchpointCount);
      }

      if (Object.keys(update).length) {
        updates.push({ id: contact.id, properties: update });
        if (update.hs_lead_status) {
          stats.statusUpdates += 1;
          addCount(stats.transitions, transitionLabel(currentStatus, update.hs_lead_status));
        }
        if (update.disqualified_reasons) addCount(stats.disqualifiedReasons, update.disqualified_reasons);
        if (Object.prototype.hasOwnProperty.call(update, 'bdr_touchpoints_90d')) {
          stats.touchpointUpdates += 1;
        }
      }
      if (stats.preview.length < Math.max(0, config.previewLimit)) {
        stats.preview.push({
          id: String(contact.id),
          currentStatus,
          targetStatus: update.hs_lead_status || currentStatus || '',
          touchpoints90d: touchpointCount,
          touchpointSource: touchpointResult.source,
          update,
          classificationReason: classification.reason || '',
          noteEvidence: (touchpointResult.noteSummary?.counted || []).slice(0, 5),
          noteExclusions: touchpointResult.noteSummary?.excluded || {},
        });
      }
    } catch (err) {
      errors.push({ id: contact.id, error: err.message });
    }
  });

  if (updates.length && !config.dryRun) {
    await batchUpdateContacts(hubspot, updates, config);
  }

  stats.updatedContacts = updates.length;
  stats.errors = errors.length;
  stats.workingTouchpointContacts = workingTouchpoints.length;
  stats.workingTouchpointTotal = workingTouchpoints.reduce((sum, value) => sum + value, 0);
  stats.workingTouchpointMedian = median(workingTouchpoints);
  stats.dryRun = Boolean(config.dryRun);
  stats.errorSample = errors.slice(0, 5);
  stats.slackText = formatLeadStatusSyncSummary(stats);

  if (postSlackMessage && !config.skipSlack) {
    await postSlackMessage(stats.slackText, config.targetChannel);
  }

  return stats;
}

function parseCliArgs(argv) {
  const args = { mode: 'incremental' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--full' || arg === '--mode=full') args.mode = 'full';
    else if (arg === '--incremental' || arg === '--mode=incremental') args.mode = 'incremental';
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--skip-slack') args.skipSlack = true;
    else if (arg === '--touchpoint-source') {
      args.touchpointSource = normalizeTouchpointSource(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--touchpoint-source=')) {
      args.touchpointSource = normalizeTouchpointSource(arg.split('=')[1]);
    } else if (arg === '--preview-limit') {
      args.previewLimit = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--preview-limit=')) {
      args.previewLimit = Number(arg.split('=')[1]);
    }
    else if (arg === '--lookback-hours') {
      args.lookbackHours = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--lookback-hours=')) {
      args.lookbackHours = Number(arg.split('=')[1]);
    }
  }
  return args;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const stats = await runLeadStatusSync({
    ...args,
    hubspot: (path, options) => hubspotFetch(path, options, {}),
  });
  console.log(JSON.stringify(stats, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  ALLOWED_ENGAGEMENT_TYPES,
  CONTACT_PROPERTIES,
  DEFAULT_BDR_OWNER_IDS,
  DISQUALIFIED_REASONS,
  RECENT_ACTIVITY_SEARCH_FIELDS,
  STATUS,
  buildContactUpdate,
  canMoveToStatus,
  calculateTouchpoints90d,
  classifyTouchpointNote,
  classifyLeadStatus,
  countNoteTouchpoints90d,
  formatLeadStatusSyncSummary,
  hubspotFetch,
  includeTouchpointEngagement,
  makeDefaultConfig,
  normalizeTouchpointSource,
  parseCliArgs,
  summarizeNoteTouchpoints,
  runLeadStatusSync,
};
