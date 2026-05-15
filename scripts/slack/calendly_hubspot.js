const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const DEFAULT_HTTP_TIMEOUT_MS = Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 30000);
const inFlightWebhookKeys = new Set();

const CONFIG = {
  hubSpotPortalId: '43974586',
  pipelineId: '105321581',
  newDealStageId: '1307720553',
  closedLostStageId: '190380587',
  closedLostReason: 'no show',
  allowedEventTypeUris: new Set([
    'https://api.calendly.com/event_types/e742a350-d2ef-4549-a07e-7e11b00a24ab',
    'https://api.calendly.com/event_types/71ad5a08-ca70-4cb6-9ea4-d4eb5ae78e68',
    'https://api.calendly.com/event_types/6507e7a2-6085-4d57-8726-d5de44d5e16e',
    'https://api.calendly.com/event_types/1d5f7667-f512-4e71-aece-6737e0a9da34',
    'https://api.calendly.com/event_types/8ce8dcfa-d158-45ef-998b-1ff0a041849a',
  ]),
  ownerByCalendlyUserUri: new Map([
    ['https://api.calendly.com/users/069e97c6-0691-4472-84f2-cad9c76b6e01', '84547076'],
    ['https://api.calendly.com/users/ac8a0acf-71b8-4db8-b74d-31ea6eaef11d', '89305622'],
  ]),
  organizerNameByCalendlyUserUri: new Map([
    ['https://api.calendly.com/users/069e97c6-0691-4472-84f2-cad9c76b6e01', 'Sarah Elix'],
    ['https://api.calendly.com/users/ac8a0acf-71b8-4db8-b74d-31ea6eaef11d', 'Xavier Marco'],
  ]),
};

function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseSignatureHeader(headerValue) {
  const parts = Object.fromEntries(
    String(headerValue || '')
      .split(',')
      .map(part => {
        const index = part.indexOf('=');
        if (index === -1) return ['', ''];
        return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
      })
      .filter(([key, value]) => key && value),
  );
  return { timestamp: parts.t, signature: parts.v1 };
}

function safeCompareHex(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function validateCalendlySignature(rawBody, signatureHeader, signingKey, nowMs = Date.now()) {
  if (!signingKey) return { ok: false, reason: 'missing signing key' };
  const { timestamp, signature } = parseSignatureHeader(signatureHeader);
  if (!timestamp || !signature) return { ok: false, reason: 'missing signature parts' };

  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs)) return { ok: false, reason: 'invalid timestamp' };
  if (Math.abs(nowMs - timestampMs) > 5 * 60 * 1000) return { ok: false, reason: 'stale timestamp' };

  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto
    .createHmac('sha256', signingKey)
    .update(signedPayload)
    .digest('hex');

  return safeCompareHex(expected, signature)
    ? { ok: true }
    : { ok: false, reason: 'signature mismatch' };
}

function httpsJsonRequest(url, { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        if (data) {
          try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`${method} ${new URL(url).hostname} failed ${res.statusCode}`);
          error.statusCode = res.statusCode;
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${url} timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function getHubSpotToken() {
  return process.env.HUBSPOT_PRIVATE_TOKEN
    || process.env.HUBSPOT_ACCESS_TOKEN
    || process.env.HUBSPOT_MERCEDES_CLAUDE;
}

function getCalendlyToken() {
  return process.env.CALENDLY_API_KEY || process.env.CALENDLY_API;
}

async function hubspotRequest(path, { method = 'GET', body } = {}) {
  const token = getHubSpotToken();
  if (!token) throw new Error('Missing HubSpot token');
  return httpsJsonRequest(`https://api.hubapi.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body,
  });
}

async function calendlyRequest(uri) {
  const token = getCalendlyToken();
  if (!token) throw new Error('Missing Calendly token');
  return httpsJsonRequest(uri, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'content-type': 'text/plain' });
  res.end(text);
}

function clean(value) {
  return String(value || '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function lastUriPart(uri) {
  return clean(uri).split('/').filter(Boolean).pop() || '';
}

function splitName(name) {
  const parts = clean(name).split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  if (parts.length === 1) return { firstname: parts[0] };
  return { firstname: parts.slice(0, -1).join(' '), lastname: parts[parts.length - 1] };
}

function getScheduledEventUri(payload) {
  return clean(payload?.event || payload?.scheduled_event?.uri || payload?.scheduled_event);
}

function getInviteeUri(payload) {
  return clean(payload?.uri || payload?.invitee?.uri);
}

function getNewInviteeUri(payload) {
  return clean(payload?.new_invitee || payload?.invitee?.new_invitee || payload?.new_invitee_uri);
}

function getOldInviteeUri(payload) {
  return clean(payload?.old_invitee || payload?.invitee?.old_invitee || payload?.old_invitee_uri);
}

function getEventMembershipUserUris(scheduledEvent) {
  const event = scheduledEvent?.resource || scheduledEvent || {};
  const memberships = event.event_memberships || [];
  return memberships
    .map(member => {
      if (typeof member.user === 'string') return clean(member.user);
      return clean(member.user_uri || member?.user?.uri);
    })
    .filter(Boolean);
}

function findAllowedHostUserUri(scheduledEvent, config = CONFIG) {
  const userUris = getEventMembershipUserUris(scheduledEvent);
  const allowedUris = userUris.filter(uri => config.ownerByCalendlyUserUri.has(uri));
  return allowedUris.length === 1 ? allowedUris[0] : '';
}

function getEventTypeUri(scheduledEvent) {
  const event = scheduledEvent?.resource || scheduledEvent || {};
  if (typeof event.event_type === 'string') return clean(event.event_type);
  return clean(event?.event_type?.uri || event.event_type_uri);
}

function getEventName(scheduledEvent) {
  const event = scheduledEvent?.resource || scheduledEvent || {};
  return clean(event.name) || 'Calendly meeting';
}

function getEventStart(scheduledEvent) {
  const event = scheduledEvent?.resource || scheduledEvent || {};
  return clean(event.start_time);
}

function getEventEnd(scheduledEvent) {
  const event = scheduledEvent?.resource || scheduledEvent || {};
  return clean(event.end_time);
}

function getCompanyNameFromPayload(payload) {
  const direct = clean(
    payload?.company
    || payload?.company_name
    || payload?.invitee?.company
    || payload?.invitee?.company_name,
  );
  if (direct) return direct;

  const questions = payload?.questions_and_answers || payload?.invitee?.questions_and_answers || [];
  for (const item of questions) {
    const question = lower(item?.question || item?.name || item?.label);
    if (!question) continue;
    if (question === 'company' || question === 'company name' || question.includes('company')) {
      const answer = clean(item?.answer || item?.value);
      if (answer) return answer;
    }
  }
  return '';
}

function getOrganizerName(hostUserUri, scheduledEvent, config = CONFIG) {
  const mapped = clean(config.organizerNameByCalendlyUserUri?.get(hostUserUri));
  if (mapped) return mapped;

  const event = scheduledEvent?.resource || scheduledEvent || {};
  const memberships = event.event_memberships || [];
  const match = memberships.find(member => {
    const userUri = typeof member.user === 'string' ? clean(member.user) : clean(member.user_uri || member?.user?.uri);
    return userUri === hostUserUri;
  });
  return clean(match?.user_name || match?.name || match?.user_email || match?.email) || 'Unknown Organizer';
}

function isRescheduled(payload) {
  return payload?.rescheduled === true || payload?.invitee?.rescheduled === true || Boolean(getNewInviteeUri(payload));
}

function shouldProcessScheduledEvent(scheduledEvent, config = CONFIG) {
  const eventTypeUri = getEventTypeUri(scheduledEvent);
  const hostUserUri = findAllowedHostUserUri(scheduledEvent, config);
  return {
    ok: config.allowedEventTypeUris.has(eventTypeUri) && Boolean(hostUserUri),
    eventTypeUri,
    hostUserUri,
    ownerId: hostUserUri ? config.ownerByCalendlyUserUri.get(hostUserUri) : '',
  };
}

function buildDealName({ companyName, organizerName, startTime }) {
  const company = clean(companyName) || 'Unknown Company';
  const organizer = clean(organizerName) || 'Unknown Organizer';
  const date = startTime ? new Date(startTime).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  return `${company} - ${organizer} - ${date}`;
}

function hubspotDateMs(date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return String(new Date(`${day}T00:00:00.000Z`).getTime());
}

function isCalendlyApiUri(uri) {
  return clean(uri).startsWith('https://api.calendly.com/');
}

function webhookProcessingKey(body) {
  const eventName = clean(body?.event);
  const payload = body?.payload || {};
  return [
    eventName,
    getInviteeUri(payload),
    getScheduledEventUri(payload),
    getOldInviteeUri(payload),
    getNewInviteeUri(payload),
  ].filter(Boolean).join('|');
}

function idempotencyRoot() {
  return process.env.CALENDLY_WEBHOOK_STATE_DIR
    || path.resolve(__dirname, '../../outputs/calendly-webhook-state');
}

function keyToFilename(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function acquireDurableProcessingRecord(key) {
  if (!key) return { acquired: true, skipped: false, key: '' };
  const root = idempotencyRoot();
  fs.mkdirSync(root, { recursive: true });
  const filename = keyToFilename(key);
  const processingPath = path.join(root, `${filename}.processing.json`);
  const succeededPath = path.join(root, `${filename}.succeeded.json`);

  const succeeded = readJsonFile(succeededPath);
  if (succeeded) return { acquired: false, skipped: true, key, status: 'succeeded', record: succeeded };

  try {
    const fd = fs.openSync(processingPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ key, status: 'processing', startedAt: new Date().toISOString() }));
    fs.closeSync(fd);
    return { acquired: true, skipped: false, key, processingPath, succeededPath };
  } catch (err) {
    if (err.code === 'EEXIST') {
      return { acquired: false, skipped: true, key, status: 'processing', record: readJsonFile(processingPath) };
    }
    throw err;
  }
}

function markDurableProcessingSucceeded(record, result) {
  if (!record?.processingPath || !record?.succeededPath) return;
  fs.writeFileSync(
    record.succeededPath,
    JSON.stringify({
      key: record.key,
      status: 'succeeded',
      completedAt: new Date().toISOString(),
      action: result?.action,
      dealId: result?.dealId,
      meetingId: result?.meetingId,
    }),
  );
  fs.rmSync(record.processingPath, { force: true });
}

function releaseDurableProcessingRecord(record) {
  if (!record?.processingPath) return;
  fs.rmSync(record.processingPath, { force: true });
}

async function searchObjects(objectType, filters, properties = [], limit = 10) {
  return hubspotRequest(`/crm/v3/objects/${objectType}/search`, {
    method: 'POST',
    body: {
      filterGroups: [{ filters }],
      properties,
      limit,
    },
  });
}

async function findContactByEmail(email) {
  if (!clean(email)) return null;
  const result = await searchObjects(
    'contacts',
    [{ propertyName: 'email', operator: 'EQ', value: clean(email) }],
    ['email', 'firstname', 'lastname'],
    1,
  );
  return (result.results || [])[0] || null;
}

async function createContact({ name, email }) {
  const nameParts = splitName(name);
  return hubspotRequest('/crm/v3/objects/contacts', {
    method: 'POST',
    body: {
      properties: {
        email: clean(email),
        ...nameParts,
      },
    },
  });
}

async function findDealByCalendlyIdentifiers({ inviteeUri, eventUri }) {
  const properties = ['dealname', 'dealstage', 'pipeline', 'hubspot_owner_id', 'calendly_event_uri', 'calendly_invitee_uri'];
  if (clean(inviteeUri)) {
    const byInvitee = await searchObjects(
      'deals',
      [{ propertyName: 'calendly_invitee_uri', operator: 'EQ', value: clean(inviteeUri) }],
      properties,
      1,
    );
    if ((byInvitee.results || [])[0]) return byInvitee.results[0];
  }
  if (clean(eventUri)) {
    const byEvent = await searchObjects(
      'deals',
      [{ propertyName: 'calendly_event_uri', operator: 'EQ', value: clean(eventUri) }],
      properties,
      1,
    );
    if ((byEvent.results || [])[0]) return byEvent.results[0];
  }
  return null;
}

async function findMeetingByCalendlyIdentifiers({ inviteeUri, eventUri }) {
  const properties = ['hs_meeting_title', 'hs_meeting_start_time', 'calendly_event_uri', 'calendly_invitee_uri'];
  if (clean(inviteeUri)) {
    const byInvitee = await searchObjects(
      'meetings',
      [{ propertyName: 'calendly_invitee_uri', operator: 'EQ', value: clean(inviteeUri) }],
      properties,
      1,
    );
    if ((byInvitee.results || [])[0]) return byInvitee.results[0];
  }
  if (clean(eventUri)) {
    const byEvent = await searchObjects(
      'meetings',
      [{ propertyName: 'calendly_event_uri', operator: 'EQ', value: clean(eventUri) }],
      properties,
      1,
    );
    if ((byEvent.results || [])[0]) return byEvent.results[0];
  }
  return null;
}

async function associate(fromType, fromId, toType, toId) {
  if (!fromId || !toId) return null;
  return hubspotRequest(`/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`, {
    method: 'PUT',
  });
}

async function createNote({ body, dealId, contactId }) {
  const note = await hubspotRequest('/crm/v3/objects/notes', {
    method: 'POST',
    body: {
      properties: {
        hs_timestamp: new Date().toISOString(),
        hs_note_body: body,
      },
    },
  });
  await Promise.all([
    dealId ? associate('notes', note.id, 'deals', dealId) : null,
    contactId ? associate('notes', note.id, 'contacts', contactId) : null,
  ].filter(Boolean));
  return note;
}

async function createDeal({ payload, scheduledEvent, contactId, ownerId, hostUserUri, eventTypeUri }) {
  const eventUri = getScheduledEventUri(payload);
  const inviteeUri = getInviteeUri(payload);
  const startTime = getEventStart(scheduledEvent);
  const deal = await hubspotRequest('/crm/v3/objects/deals', {
    method: 'POST',
    body: {
      properties: {
        dealname: buildDealName({
          companyName: getCompanyNameFromPayload(payload),
          organizerName: getOrganizerName(hostUserUri, scheduledEvent),
          startTime,
        }),
        pipeline: CONFIG.pipelineId,
        dealstage: CONFIG.newDealStageId,
        hubspot_owner_id: ownerId,
        calendly_event_uri: eventUri,
        calendly_invitee_uri: inviteeUri,
        calendly_event_uuid: lastUriPart(eventUri),
        calendly_event_type_uri: eventTypeUri,
        calendly_host_user_uri: hostUserUri,
      },
    },
  });
  await associate('deals', deal.id, 'contacts', contactId);
  return deal;
}

async function createMeeting({ payload, scheduledEvent, contactId, dealId, ownerId, hostUserUri, eventTypeUri }) {
  const eventUri = getScheduledEventUri(payload);
  const inviteeUri = getInviteeUri(payload);
  const startTime = getEventStart(scheduledEvent) || new Date().toISOString();
  const endTime = getEventEnd(scheduledEvent) || startTime;
  const meeting = await hubspotRequest('/crm/v3/objects/meetings', {
    method: 'POST',
    body: {
      properties: {
        hs_timestamp: startTime,
        hs_meeting_title: getEventName(scheduledEvent),
        hs_meeting_start_time: startTime,
        hs_meeting_end_time: endTime,
        hs_meeting_outcome: 'SCHEDULED',
        hubspot_owner_id: ownerId,
        calendly_event_uri: eventUri,
        calendly_invitee_uri: inviteeUri,
        calendly_event_uuid: lastUriPart(eventUri),
        calendly_event_type_uri: eventTypeUri,
        calendly_host_user_uri: hostUserUri,
      },
    },
  });
  await Promise.all([
    associate('meetings', meeting.id, 'contacts', contactId),
    associate('meetings', meeting.id, 'deals', dealId),
  ]);
  return meeting;
}

async function ensureContact({ payload }) {
  const email = clean(payload.email);
  if (!email) throw new Error('Calendly invitee payload missing email');
  const existing = await findContactByEmail(email);
  if (existing) return existing;
  return createContact({ name: payload.name, email });
}

async function handleInviteeCreated(payload, scheduledEvent, filter) {
  const contact = await ensureContact({ payload });
  const eventUri = getScheduledEventUri(payload);
  const inviteeUri = getInviteeUri(payload);
  const oldInviteeUri = getOldInviteeUri(payload);
  let foundByOldInvitee = false;
  let deal = null;
  let oldMeeting = null;
  if (oldInviteeUri) {
    deal = await findDealByCalendlyIdentifiers({ inviteeUri: oldInviteeUri, eventUri: '' });
    foundByOldInvitee = Boolean(deal);
    oldMeeting = await findMeetingByCalendlyIdentifiers({ inviteeUri: oldInviteeUri, eventUri: '' });
  }
  deal = deal || await findDealByCalendlyIdentifiers({ inviteeUri, eventUri });

  if (deal) {
    const properties = {
      calendly_event_uri: eventUri,
      calendly_invitee_uri: inviteeUri,
      calendly_event_uuid: lastUriPart(eventUri),
      calendly_event_type_uri: filter.eventTypeUri,
      calendly_host_user_uri: filter.hostUserUri,
      hubspot_owner_id: filter.ownerId,
    };
    if (foundByOldInvitee) properties.dealstage = CONFIG.newDealStageId;
    await hubspotRequest(`/crm/v3/objects/deals/${deal.id}`, {
      method: 'PATCH',
      body: { properties },
    });
    await associate('deals', deal.id, 'contacts', contact.id);
    if (foundByOldInvitee) {
      await createNote({ body: 'Meeting Rescheduled', dealId: deal.id, contactId: contact.id });
    }
  } else {
    deal = await createDeal({
      payload,
      scheduledEvent,
      contactId: contact.id,
      ownerId: filter.ownerId,
      hostUserUri: filter.hostUserUri,
      eventTypeUri: filter.eventTypeUri,
    });
  }

  let meeting = await findMeetingByCalendlyIdentifiers({ inviteeUri, eventUri });
  if (!meeting && oldMeeting) {
    await hubspotRequest(`/crm/v3/objects/meetings/${oldMeeting.id}`, {
      method: 'PATCH',
      body: {
        properties: {
          hs_timestamp: getEventStart(scheduledEvent) || new Date().toISOString(),
          hs_meeting_title: getEventName(scheduledEvent),
          hs_meeting_start_time: getEventStart(scheduledEvent) || new Date().toISOString(),
          hs_meeting_end_time: getEventEnd(scheduledEvent) || getEventStart(scheduledEvent) || new Date().toISOString(),
          hs_meeting_outcome: 'RESCHEDULED',
          hubspot_owner_id: filter.ownerId,
          calendly_event_uri: eventUri,
          calendly_invitee_uri: inviteeUri,
          calendly_event_uuid: lastUriPart(eventUri),
          calendly_event_type_uri: filter.eventTypeUri,
          calendly_host_user_uri: filter.hostUserUri,
        },
      },
    });
    meeting = { ...oldMeeting, id: oldMeeting.id };
  }
  if (!meeting) {
    meeting = await createMeeting({
      payload,
      scheduledEvent,
      contactId: contact.id,
      dealId: deal.id,
      ownerId: filter.ownerId,
      hostUserUri: filter.hostUserUri,
      eventTypeUri: filter.eventTypeUri,
    });
  } else {
    await Promise.all([
      associate('meetings', meeting.id, 'contacts', contact.id),
      associate('meetings', meeting.id, 'deals', deal.id),
    ]);
  }

  return { action: 'created_or_updated', contactId: contact.id, dealId: deal.id, meetingId: meeting.id };
}

async function handleInviteeCanceled(payload, scheduledEvent, filter) {
  const eventUri = getScheduledEventUri(payload);
  const inviteeUri = getInviteeUri(payload);
  const deal = await findDealByCalendlyIdentifiers({ inviteeUri, eventUri });
  const meeting = await findMeetingByCalendlyIdentifiers({ inviteeUri, eventUri });
  const contact = payload.email ? await findContactByEmail(payload.email) : null;

  if (!deal) return { action: 'cancel_ignored_no_deal' };

  if (isRescheduled(payload)) {
    return { action: 'reschedule_note_deferred_to_created_event', dealId: deal.id, meetingId: meeting?.id };
  }

  await hubspotRequest(`/crm/v3/objects/deals/${deal.id}`, {
    method: 'PATCH',
    body: {
      properties: {
        dealstage: CONFIG.closedLostStageId,
        closed_lost_reason: CONFIG.closedLostReason,
        closedate: hubspotDateMs(),
      },
    },
  });
  if (meeting) {
    await hubspotRequest(`/crm/v3/objects/meetings/${meeting.id}`, {
      method: 'PATCH',
      body: { properties: { hs_meeting_outcome: 'NO_SHOW' } },
    }).catch(() => null);
  }
  return { action: 'closed_lost_no_show', dealId: deal.id, meetingId: meeting?.id };
}

async function processCalendlyWebhook(body) {
  const processingKey = webhookProcessingKey(body);
  if (processingKey && inFlightWebhookKeys.has(processingKey)) return { action: 'ignored_in_flight_duplicate' };
  if (processingKey) inFlightWebhookKeys.add(processingKey);
  let durableRecord;
  try {
    durableRecord = acquireDurableProcessingRecord(processingKey);
    if (durableRecord.skipped) return { action: `ignored_${durableRecord.status}_duplicate` };
    const eventName = clean(body.event);
    const payload = body.payload || {};
    const eventUri = getScheduledEventUri(payload);
    if (!eventUri) return { action: 'ignored_missing_event_uri' };
    if (!isCalendlyApiUri(eventUri)) return { action: 'ignored_bad_event_uri' };

    const scheduledEvent = await calendlyRequest(eventUri);
    const filter = shouldProcessScheduledEvent(scheduledEvent);
    if (!filter.ok) {
      return {
        action: 'ignored_not_allowlisted',
        eventTypeAllowed: CONFIG.allowedEventTypeUris.has(filter.eventTypeUri),
        hostAllowed: Boolean(filter.hostUserUri),
      };
    }

    let result;
    if (eventName === 'invitee.created') result = await handleInviteeCreated(payload, scheduledEvent, filter);
    else if (eventName === 'invitee.canceled') result = await handleInviteeCanceled(payload, scheduledEvent, filter);
    else result = { action: 'ignored_event_type' };
    markDurableProcessingSucceeded(durableRecord, result);
    return result;
  } catch (err) {
    releaseDurableProcessingRecord(durableRecord);
    throw err;
  } finally {
    if (processingKey) inFlightWebhookKeys.delete(processingKey);
  }
}

async function handleCalendlyHubSpotWebhook(req, res, { logger = console } = {}) {
  let rawBody;
  try {
    rawBody = await readRequestBody(req);
  } catch (err) {
    logger.warn('Calendly webhook body read failed:', err.message);
    sendText(res, 413, 'body_too_large');
    return;
  }

  const signingKey = process.env.CALENDLY_WEBHOOK_SIGNING_KEY || process.env.CALENDLY_WEBHOOK_SECRET;
  const signature = validateCalendlySignature(rawBody, req.headers['calendly-webhook-signature'], signingKey);
  if (!signature.ok) {
    logger.warn('Calendly webhook signature rejected:', signature.reason);
    sendText(res, 401, 'invalid_signature');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    sendText(res, 400, 'invalid_json');
    return;
  }

  try {
    const result = await processCalendlyWebhook(parsed);
    logger.log('Calendly webhook processed:', JSON.stringify({
      event: parsed.event,
      action: result.action,
      dealId: result.dealId,
      meetingId: result.meetingId,
    }));
    sendText(res, 200, 'ok');
  } catch (err) {
    logger.error('Calendly webhook processing failed:', err.message);
    sendText(res, 500, 'webhook_failed');
  }
}

module.exports = {
  CONFIG,
  buildDealName,
  findAllowedHostUserUri,
  getCompanyNameFromPayload,
  getEventMembershipUserUris,
  getEventTypeUri,
  getOrganizerName,
  handleCalendlyHubSpotWebhook,
  hubspotDateMs,
  idempotencyRoot,
  isCalendlyApiUri,
  isRescheduled,
  parseSignatureHeader,
  processCalendlyWebhook,
  shouldProcessScheduledEvent,
  validateCalendlySignature,
  webhookProcessingKey,
};
