const https = require('https');

const DEFAULT_LIST_ID = '694';
const DEFAULT_TARGET_CHANNEL = 'slack-testing';
const DEFAULT_LOOKBACK_HOURS = 28;
const DEFAULT_TOUCHPOINT_DAYS = 90;
const DEFAULT_BDR_OWNER_IDS = ['84547076', '89305622', '91143842', '91143844'];
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

function makeDefaultConfig(env = process.env) {
  return {
    listId: env.LEAD_STATUS_SYNC_LIST_ID || DEFAULT_LIST_ID,
    targetChannel: env.LEAD_STATUS_SYNC_TARGET_CHANNEL || DEFAULT_TARGET_CHANNEL,
    triggerSecret: env.LEAD_STATUS_SYNC_TRIGGER_SECRET || env.LEAD_REPORT_TRIGGER_SECRET || '',
    lookbackHours: Number(env.LEAD_STATUS_SYNC_LOOKBACK_HOURS || DEFAULT_LOOKBACK_HOURS),
    touchpointDays: Number(env.LEAD_STATUS_SYNC_TOUCHPOINT_DAYS || DEFAULT_TOUCHPOINT_DAYS),
    bdrOwnerIds: parseDelimitedList(env.LEAD_STATUS_SYNC_BDR_OWNER_IDS, DEFAULT_BDR_OWNER_IDS).map(String),
    bdrEmails: parseDelimitedList(env.LEAD_STATUS_SYNC_BDR_EMAILS, DEFAULT_BDR_EMAILS).map(email => email.toLowerCase()),
    searchDelayMs: Number(env.LEAD_STATUS_SYNC_SEARCH_DELAY_MS || 250),
    generalDelayMs: Number(env.LEAD_STATUS_SYNC_GENERAL_DELAY_MS || 80),
    engagementConcurrency: Number(env.LEAD_STATUS_SYNC_ENGAGEMENT_CONCURRENCY || 6),
  };
}

async function hubspotFetch(path, options = {}, config = {}) {
  const token = config.hubspotToken || process.env.HUBSPOT_PRIVATE_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error('Missing HubSpot token for lead status sync');

  for (let attempt = 0; attempt < 7; attempt += 1) {
    const response = await fetch(`https://api.hubapi.com${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = text; }

    if (response.ok) return body;
    if ((response.status === 429 || response.status >= 500) && attempt < 6) {
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }
    const message = typeof body === 'string' ? body : (body.message || JSON.stringify(body));
    throw new Error(`HubSpot ${response.status}: ${message}`);
  }
  throw new Error(`HubSpot request exhausted retries: ${path}`);
}

function makeHttpsHubSpotFetch(token) {
  return function request(path, options = {}) {
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
            reject(new Error(`HubSpot ${res.statusCode}: ${msg}`));
            return;
          }
          resolve(body);
        });
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  };
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

function metadataEmail(metadata) {
  return String(metadata?.from?.email || metadata?.fromEmail || metadata?.senderEmail || '').toLowerCase();
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

function classifyLeadStatus(contact, touchpointCount) {
  const properties = contact.properties || {};
  const currentStatus = properties.hs_lead_status || '';
  const currentReason = properties.disqualified_reasons || '';

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

function buildContactUpdate(contact, targetStatus, disqualifiedReason, touchpointCount, calculatedAtMs) {
  const properties = contact.properties || {};
  const update = {};
  if (canMoveToStatus(properties.hs_lead_status || '', targetStatus)) {
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
    `In GTM open leads: ${stats.listCandidateCount}`,
    `Contacts updated: ${stats.updatedContacts}`,
    `Status changes: ${stats.statusUpdates}`,
    `Touchpoint field changes: ${stats.touchpointUpdates}`,
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
    transitions: {},
    disqualifiedReasons: {},
    workingTouchpointContacts: 0,
    workingTouchpointTotal: 0,
    workingTouchpointMedian: 0,
  };

  await mapLimit(contacts, config.engagementConcurrency, async (contact) => {
    try {
      const touchpointCount = await countTouchpoints90d(hubspot, contact.id, touchpointSinceMs, config);
      const classification = classifyLeadStatus(contact, touchpointCount);
      const update = buildContactUpdate(
        contact,
        classification.targetStatus,
        classification.disqualifiedReason,
        touchpointCount,
        calculatedAtMs,
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
  classifyLeadStatus,
  formatLeadStatusSyncSummary,
  includeTouchpointEngagement,
  makeDefaultConfig,
  parseCliArgs,
  runLeadStatusSync,
};
