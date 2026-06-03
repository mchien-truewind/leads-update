const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

// Load .env.local if it exists (local dev), otherwise use environment variables (Railway)
const envPath = path.resolve(__dirname, '../../.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)="?(.*?)"?\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const { App: SlackBoltApp } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk').default;
const { google } = require('googleapis');
const {
  DEFAULT_CHANNEL: INSTANTLY_POSITIVE_REPLY_DEFAULT_CHANNEL,
  handleInstantlyPositiveReplyWebhook,
} = require('./instantly_positive_reply_alert');
const {
  handleCalendlyHubSpotWebhook,
} = require('./calendly_hubspot');
const {
  runLeadStatusSync,
} = require('./lead_status_sync');
const {
  buildMqlDiscoveryReport,
  formatMqlDiscoveryReport,
} = require('./mql_discovery_report');
const {
  buildDiscoveryDigestConfig,
  dedupeDigestMeetings,
  dedupeGrainRecordings,
  findBestGrainRecordingForMeeting,
  formatEmptyDiscoveryDigestMessage,
  formatGrainTranscriptText,
  formatNoShowMeetingLabel,
  getGrainParticipantEmails,
  getGrainRecordingId,
  getGrainRecordingStartMs,
  getGrainRecordingTitle,
  getGrainRecordingUrl,
  isLikelyGrainDiscoveryRecording,
  isLikelyHubSpotDiscoveryMeeting,
  normalizeDigestText,
  parseListItems,
} = require('./discovery_digest');

// ============================================================
// Google Sheets setup
// ============================================================
let tokenData;
const secretsPath = path.resolve(__dirname, '../../secrets/google-drive-token.json');
if (fs.existsSync(secretsPath)) {
  tokenData = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
} else {
  tokenData = {
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    token: process.env.GOOGLE_ACCESS_TOKEN,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  };
}
const oauth2Client = new google.auth.OAuth2(
  tokenData.client_id,
  tokenData.client_secret,
  'http://localhost'
);
oauth2Client.setCredentials({
  refresh_token: tokenData.refresh_token,
});
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

// ============================================================
// HubSpot setup
// ============================================================
const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN;
const DEFAULT_HTTP_TIMEOUT_MS = Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 30000);
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || process.env.FIRECRAWL_KEY;
const FIRECRAWL_API_BASE = (process.env.FIRECRAWL_API_BASE || 'https://api.firecrawl.dev/v1').replace(/\/$/, '');
const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || '43974586';
const HUBSPOT_ACTIVITY_PROPERTIES = {
  meetings: ['hs_meeting_title', 'hs_meeting_body', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_outcome', 'hs_activity_type', 'hs_timestamp', 'hubspot_owner_id'],
  calls: ['hs_call_title', 'hs_call_body', 'hs_call_disposition', 'hs_call_duration', 'hs_timestamp', 'hubspot_owner_id', 'hs_call_from_number', 'hs_call_to_number'],
  emails: ['hs_email_subject', 'hs_email_text', 'hs_email_html', 'hs_email_from_email', 'hs_email_to_email', 'hs_timestamp', 'hubspot_owner_id'],
  notes: ['hs_note_body', 'hs_timestamp', 'hubspot_owner_id'],
  tasks: ['hs_task_subject', 'hs_task_body', 'hs_task_status', 'hs_task_priority', 'hs_timestamp', 'hubspot_owner_id'],
};
const DEFAULT_NO_SHOW_KEYWORDS = ['no-show', 'no show', "didn't show", 'missed', 'did not attend'];
const HUBSPOT_OBJECT_TYPE_IDS = {
  contacts: '0-1',
  companies: '0-2',
  deals: '0-3',
  tickets: '0-5',
  calls: '0-48',
  emails: '0-49',
  meetings: '0-47',
  notes: '0-46',
  tasks: '0-27',
};

const TRUEWIND_HUBSPOT = {
  pipeline: '105321581',
  mqlDealStage: '1307720553',
  convertedLeadStatus: 'MQL',
  defaultLeadStatus: 'No one has contacted them',
  defaultOutboundLeadSource: 'Outbound - Sales Sourced List',
  defaultOwnerId: '89305622',
  defaultOwnerName: 'Xavier Marco',
  dealOwnerIds: {
    sarah: '84547076',
    xavier: '89305622',
  },
  contactToCompanyAssociationTypeId: 279,
  dealToContactAssociationTypeId: 3,
  dealToCompanyAssociationTypeId: 341,
  ownersByName: {
    'xavier marco': { id: '89305622', name: 'Xavier Marco' },
    xavier: { id: '89305622', name: 'Xavier Marco' },
    'mercedes chien': { id: '87811681', name: 'Mercedes Chien' },
    mercedes: { id: '87811681', name: 'Mercedes Chien' },
    'alex lee': { id: '559564379', name: 'Alex Lee' },
    alex: { id: '559564379', name: 'Alex Lee' },
    'amy vetter': { id: '92555980', name: 'Amy Vetter' },
    amy: { id: '92555980', name: 'Amy Vetter' },
    'aidan gleghorn': { id: '89053735', name: 'Aidan Gleghorn' },
    aidan: { id: '89053735', name: 'Aidan Gleghorn' },
    'noah salah': { id: '90960689', name: 'Noah Salah' },
    noah: { id: '90960689', name: 'Noah Salah' },
    'jenilee chen': { id: '91143842', name: 'Jenilee Chen' },
    jenilee: { id: '91143842', name: 'Jenilee Chen' },
    'brendan moody': { id: '91143844', name: 'Brendan Moody' },
    brendan: { id: '91143844', name: 'Brendan Moody' },
    'sarah elix': { id: '84547076', name: 'Sarah Elix' },
    sarah: { id: '84547076', name: 'Sarah Elix' },
  },
};

const DEFAULT_SLACK_TO_HUBSPOT_OWNER = {
  U0ATZSNCE5T: { id: '91143842', name: 'Jenilee Chen' },
  U0AURH4KMRN: { id: '91143844', name: 'Brendan Moody' },
  U0AKMHVCJMA: { id: '89305622', name: 'Xavier Marco' },
  U09QC3B292R: { id: '84547076', name: 'Sarah Elix' },
  U04BPMPR29G: { id: '559564379', name: 'Alex Lee' },
  U0B4MRN83FE: { id: '92555980', name: 'Amy Vetter' },
  U0ABULY5TEK: { id: '91143842', name: 'Jenilee Chen' },
};

function parseSlackOwnerMap() {
  const raw = process.env.SLACK_TO_HUBSPOT_OWNER_JSON || process.env.SLACK_USER_TO_HUBSPOT_OWNER_JSON || '';
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Invalid Slack owner map JSON: ${err.message}`);
    return {};
  }
}

const SLACK_TO_HUBSPOT_OWNER = {
  ...DEFAULT_SLACK_TO_HUBSPOT_OWNER,
  ...parseSlackOwnerMap(),
};
const hubspotContactPropertyCache = new Map();
const hubspotPropertyCache = new Map();

function parseDelimitedEnvSet(name) {
  return new Set(String(process.env[name] || '').split(',').map((value) => value.trim()).filter(Boolean));
}

const HUBSPOT_WRITE_ALLOWED_SLACK_USER_IDS = parseDelimitedEnvSet('HUBSPOT_WRITE_ALLOWED_SLACK_USER_IDS');
const HUBSPOT_WRITE_ALLOWED_SLACK_CHANNEL_IDS = parseDelimitedEnvSet('HUBSPOT_WRITE_ALLOWED_SLACK_CHANNEL_IDS');
const HUBSPOT_WRITE_REQUIRE_AUTH = process.env.HUBSPOT_WRITE_REQUIRE_AUTH !== 'false';
const RECRUITING_CALENDAR_ALLOWED_SLACK_USER_IDS = parseDelimitedEnvSet('RECRUITING_CALENDAR_ALLOWED_SLACK_USER_IDS');
const RECRUITING_CALENDAR_ALLOWED_SLACK_CHANNEL_IDS = parseDelimitedEnvSet('RECRUITING_CALENDAR_ALLOWED_SLACK_CHANNEL_IDS');
const RECRUITING_CALENDAR_REQUIRE_AUTH = process.env.RECRUITING_CALENDAR_REQUIRE_AUTH !== 'false';
const DEFAULT_RECRUITING_CALENDAR_SLACK_USER_ID = (
  process.env.RECRUITING_SLACK_MENTION_USER_ID
  || process.env.SLACK_USER_ID
  || 'U0ABULY5TEK'
).trim();

function createSlackApp() {
  if (require.main !== module) {
    return {
      client: { chat: { postMessage: async () => ({ ok: true }) } },
      event: () => {},
      start: async () => {},
    };
  }
  return new SlackBoltApp({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
  });
}

async function hubspotRequest(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint.startsWith('http') ? endpoint : `https://api.hubapi.com${endpoint}`);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${HUBSPOT_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        let parsed = {};
        if (data) {
          try { parsed = JSON.parse(data); } catch { parsed = data; }
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const responseMessage = parsed && typeof parsed === 'object'
            ? (parsed.message || parsed.error || JSON.stringify(parsed))
            : parsed;
          const err = new Error(`HubSpot ${res.statusCode}: ${responseMessage}`);
          err.statusCode = res.statusCode;
          err.body = parsed;
          reject(err);
          return;
        }

        resolve(parsed);
      });
    });
    req.setTimeout(DEFAULT_HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`HubSpot request timed out after ${DEFAULT_HTTP_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function resolveCredentialPath(envVar, defaultPath) {
  return path.resolve(__dirname, '../..', process.env[envVar] || defaultPath);
}

function loadJsonCredential({ jsonEnv, fileEnv, defaultFile, label }) {
  const raw = process.env[jsonEnv];
  if (raw && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid ${jsonEnv}: ${err.message}`);
    }
  }

  const credentialPath = resolveCredentialPath(fileEnv, defaultFile);
  if (!fs.existsSync(credentialPath)) {
    throw new Error(`Missing ${label}. Set ${jsonEnv} or ${fileEnv}, or place it at ${credentialPath}`);
  }
  return JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
}

function createCalendarOAuthClient() {
  const token = loadJsonCredential({
    jsonEnv: 'GOOGLE_CALENDAR_TOKEN_JSON',
    fileEnv: 'GOOGLE_CALENDAR_TOKEN_FILE',
    defaultFile: 'secrets/google-calendar-token.json',
    label: 'Google Calendar OAuth token',
  });
  let credentials = {};
  try {
    credentials = loadJsonCredential({
      jsonEnv: 'GOOGLE_CALENDAR_CREDENTIALS_JSON',
      fileEnv: 'GOOGLE_CALENDAR_CREDENTIALS_FILE',
      defaultFile: 'secrets/google-calendar-credentials.json',
      label: 'Google Calendar OAuth client credentials',
    });
  } catch {
    credentials = {};
  }

  const installed = credentials.installed || credentials.web || {};
  const clientId = token.client_id || installed.client_id || process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = token.client_secret || installed.client_secret || process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing Google Calendar OAuth client_id/client_secret in token, credentials file, or environment.');
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost');
  auth.setCredentials({
    access_token: token.access_token || token.token,
    refresh_token: token.refresh_token,
    scope: token.scope,
    token_type: token.token_type,
    expiry_date: token.expiry_date,
  });
  return auth;
}

function trustedSlackMetadata(input = {}) {
  return input.__trusted_slack_metadata || {};
}

function isRecruitingCalendarWriteAuthorized(input = {}) {
  if (!RECRUITING_CALENDAR_REQUIRE_AUTH) {
    return { authorized: true, reason: 'calendar write auth disabled' };
  }
  const trusted = trustedSlackMetadata(input);
  const slackUserId = String(trusted.slack_user_id || '').trim();
  const channelId = String(trusted.channel_id || '').trim();

  if (slackUserId && RECRUITING_CALENDAR_ALLOWED_SLACK_USER_IDS.has(slackUserId)) {
    return { authorized: true, reason: 'Slack user explicitly allowed for recruiting calendar writes' };
  }
  if (
    slackUserId
    && RECRUITING_CALENDAR_ALLOWED_SLACK_USER_IDS.size === 0
    && slackUserId === DEFAULT_RECRUITING_CALENDAR_SLACK_USER_ID
  ) {
    return { authorized: true, reason: 'default recruiting Slack reviewer is allowed' };
  }
  if (channelId && RECRUITING_CALENDAR_ALLOWED_SLACK_CHANNEL_IDS.has(channelId)) {
    return { authorized: true, reason: 'Slack channel allowed for recruiting calendar writes' };
  }
  return {
    authorized: false,
    reason: 'Slack user/channel is not allowed for recruiting calendar writes. Set RECRUITING_CALENDAR_ALLOWED_SLACK_USER_IDS or RECRUITING_CALENDAR_ALLOWED_SLACK_CHANNEL_IDS.',
  };
}

function parseCalendarIsoWithZone(value, fieldName) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${fieldName} is required`);
  if (!/T/.test(text) || !/(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new Error(`${fieldName} must be ISO datetime with timezone, e.g. 2026-05-28T14:00:00-07:00`);
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`${fieldName} is not a valid datetime`);
  return { text, date };
}

function isoWithoutMillis(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function cleanRecruitingCalendarTitleText(value = '') {
  return String(value || '')
    .trim()
    .replace(/\[hiring@\]/gi, '')
    .replace(/^\s*(?:(?:re|fwd?|fw):\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function recruitingCalendarTitle(input = {}, candidateName = '', candidateEmail = '') {
  const raw = String(
    input.title
    || input.email_subject
    || input.gmail_subject
    || input.thread_subject
    || input.summary
    || ''
  ).trim();
  const cleaned = cleanRecruitingCalendarTitleText(raw);
  return cleaned || `Truewind Intro Call - ${candidateName || candidateEmail}`;
}

function hasRecruitingCalendarTitleInput(input = {}) {
  return Boolean(cleanRecruitingCalendarTitleText(
    input.title
    || input.email_subject
    || input.gmail_subject
    || input.thread_subject
    || input.summary
    || ''
  ).trim());
}

function recruitingCalendarTitleFromCandidate(candidate = {}) {
  const role = String(candidate.role || '').trim();
  const name = String(candidate.candidate_name || candidate.name || '').trim();
  const usableRole = role && role.toLowerCase() !== 'unknown' ? role : '';
  const usableName = name && name.toLowerCase() !== 'unknown' ? name : '';
  if (usableRole && usableName) return `${usableRole} - ${usableName}`;
  return usableRole || usableName || '';
}

function buildRecruitingCalendarInvite(input = {}) {
  const candidateEmail = normalizeEmail(input.candidate_email || input.email || input.attendee_email);
  if (!isValidEmail(candidateEmail)) throw new Error('candidate_email is required and must be a valid email');
  const candidateName = String(input.candidate_name || input.name || '').trim();
  const start = parseCalendarIsoWithZone(input.start_datetime || input.start_at || input.start, 'start_datetime');
  const durationRaw = input.duration_minutes === undefined || input.duration_minutes === null || input.duration_minutes === ''
    ? 20
    : Number(input.duration_minutes);
  if (!Number.isFinite(durationRaw)) throw new Error('duration_minutes must be a number');
  const durationMinutes = Math.min(Math.max(durationRaw, 5), 180);
  const end = input.end_datetime || input.end_at || input.end
    ? parseCalendarIsoWithZone(input.end_datetime || input.end_at || input.end, 'end_datetime')
    : { date: new Date(start.date.getTime() + durationMinutes * 60000) };
  if (end.date <= start.date) throw new Error('end_datetime must be after start_datetime');
  const endDateTime = end.text || isoWithoutMillis(end.date);

  const timezone = String(
    input.timezone
    || process.env.RECRUITING_SCHEDULING_TIMEZONE
    || process.env.GOOGLE_CALENDAR_DEFAULT_TIMEZONE
    || 'America/Los_Angeles'
  ).trim();
  const calendarId = String(
    input.calendar_id
    || process.env.RECRUITING_CALENDAR_ID
    || process.env.GOOGLE_CALENDAR_DEFAULT_CALENDAR_ID
    || 'primary'
  ).trim();
  const sendUpdates = String(input.send_updates || process.env.GOOGLE_CALENDAR_SEND_UPDATES || 'all').trim();
  if (!['all', 'externalOnly', 'none'].includes(sendUpdates)) {
    throw new Error('send_updates must be all, externalOnly, or none');
  }

  const summary = recruitingCalendarTitle(input, candidateName, candidateEmail);
  const extraAttendees = Array.isArray(input.extra_attendees)
    ? input.extra_attendees.map(normalizeEmail).filter(isValidEmail)
    : [];
  const attendeeEmails = Array.from(new Set([candidateEmail, ...extraAttendees]));
  const descriptionParts = [
    String(input.description || '').trim(),
    'Scheduled from Slack by Truewind recruiting coordinator.',
  ].filter(Boolean);
  const trusted = trustedSlackMetadata(input);
  const requestSeed = [
    trusted.channel_id || '',
    trusted.thread_ts || '',
    candidateEmail,
    start.text,
    endDateTime,
  ].join('|');
  const stableId = `rc${crypto.createHash('sha256').update(requestSeed).digest('hex').slice(0, 32)}`;

  return {
    calendarId,
    conferenceDataVersion: input.with_meet === false ? 0 : 1,
    sendUpdates,
    event: {
      id: stableId,
      summary,
      description: descriptionParts.join('\n\n'),
      start: { dateTime: start.text, timeZone: timezone },
      end: { dateTime: endDateTime, timeZone: timezone },
      attendees: attendeeEmails.map((email) => ({ email })),
      ...(input.with_meet === false ? {} : {
        conferenceData: {
          createRequest: {
            requestId: crypto.createHash('sha256').update(requestSeed).digest('hex').slice(0, 32),
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      }),
    },
  };
}

async function findRecruitingCandidateByEmail(email, options = {}) {
  const candidateEmail = normalizeEmail(email);
  if (!isValidEmail(candidateEmail)) return null;
  const databaseId = getEnvFirst('NOTION_DATABASE_ID', 'NOTION_ATS_DB_ID').replace(/-/g, '');
  const notionToken = getEnvFirst('NOTION_INTERNAL_INTEGRATION_SECRET', 'NOTION_INTERNAL_INTEGRATION');
  if (!databaseId || !notionToken) return null;
  const request = options.notionRequest || notionRequest;
  try {
    const databaseSchema = await request(`/v1/databases/${encodeURIComponent(databaseId)}`);
    const propMap = recruitingNotionPropertyMap(databaseSchema);
    const response = await request(`/v1/databases/${encodeURIComponent(databaseId)}/query`, 'POST', {
      page_size: 1,
      filter: {
        property: propMap.email,
        email: { equals: candidateEmail },
      },
    });
    const [page] = response.results || [];
    return page ? buildRecruitingCandidateFromNotionPage(page, propMap) : null;
  } catch (err) {
    console.warn(`Recruiting ATS title lookup failed for calendar invite: ${err.message}`);
    return null;
  }
}

async function createRecruitingCalendarInvite(input = {}) {
  const authorization = isRecruitingCalendarWriteAuthorized(input);
  if (!authorization.authorized) {
    return `Error: not authorized to create recruiting calendar invite: ${authorization.reason}`;
  }
  let enrichedInput = input;
  if (!hasRecruitingCalendarTitleInput(input)) {
    const candidateEmail = normalizeEmail(input.candidate_email || input.email || input.attendee_email);
    if (!isValidEmail(candidateEmail)) throw new Error('candidate_email is required and must be a valid email');
    parseCalendarIsoWithZone(input.start_datetime || input.start_at || input.start, 'start_datetime');
    const candidate = await findRecruitingCandidateByEmail(candidateEmail, { notionRequest: input.__notion_request });
    const atsTitle = recruitingCalendarTitleFromCandidate(candidate || {});
    if (atsTitle) enrichedInput = { ...input, title: atsTitle };
  }
  const payload = buildRecruitingCalendarInvite(enrichedInput);
  const calendar = input.__calendar_service || google.calendar({ version: 'v3', auth: createCalendarOAuthClient() });
  let created;
  try {
    created = await calendar.events.insert({
      calendarId: payload.calendarId,
      requestBody: payload.event,
      conferenceDataVersion: payload.conferenceDataVersion,
      sendUpdates: payload.sendUpdates,
    });
  } catch (err) {
    if (err.code !== 409 && err.status !== 409) throw err;
    created = await calendar.events.get({
      calendarId: payload.calendarId,
      eventId: payload.event.id,
    });
  }
  const event = created.data || {};
  const meetUrl = (event.conferenceData?.entryPoints || [])
    .find((entry) => entry.entryPointType === 'video')?.uri || '';
  return JSON.stringify({
    id: event.id || '',
    summary: event.summary || payload.event.summary,
    htmlLink: event.htmlLink || '',
    meetUrl,
    start: event.start || payload.event.start,
    end: event.end || payload.event.end,
    attendees: (event.attendees || payload.event.attendees || []).map((attendee) => attendee.email).filter(Boolean),
    calendarId: payload.calendarId,
    sendUpdates: payload.sendUpdates,
  });
}

function requireHubSpotObjectId(response, operation) {
  if (!response || typeof response !== 'object') {
    throw new Error(`${operation} did not return a JSON object from HubSpot`);
  }
  if (!response.id) {
    throw new Error(`${operation} succeeded but HubSpot response did not include top-level id: ${JSON.stringify(response)}`);
  }
  return String(response.id);
}

function formatHubSpotObjectResponse(response, objectTypeId) {
  const id = requireHubSpotObjectId(response, 'HubSpot object write');
  const properties = response.properties || {};
  return {
    ...properties,
    id,
    hubspot_id: id,
    url: hubspotRecordUrl(objectTypeId, id),
    properties,
  };
}

function hubspotRecordUrl(objectTypeId, objectId) {
  return `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/${objectTypeId}/${objectId}`;
}

function hubspotPrimaryAssociatedRecordUrl({ dealId, contactId, companyId } = {}) {
  if (dealId) return hubspotRecordUrl('0-3', dealId);
  if (contactId) return hubspotRecordUrl('0-1', contactId);
  if (companyId) return hubspotRecordUrl('0-2', companyId);
  return '';
}

async function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.setTimeout(options.timeout || DEFAULT_HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`HTTP request timed out after ${options.timeout || DEFAULT_HTTP_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function getEnvFirst(...names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

function cleanNotionText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function notionPropValue(prop = {}) {
  const propType = prop.type;
  if (propType === 'title') {
    return cleanNotionText((prop.title || []).map((item) => item.plain_text || item.text?.content || '').join(''));
  }
  if (propType === 'rich_text') {
    return cleanNotionText((prop.rich_text || []).map((item) => item.plain_text || item.text?.content || '').join(''));
  }
  if (propType === 'select') return cleanNotionText(prop.select?.name || '');
  if (propType === 'multi_select') {
    return (prop.multi_select || []).map((item) => cleanNotionText(item.name)).filter(Boolean).join(', ');
  }
  if (propType === 'email') return cleanNotionText(prop.email || '');
  if (propType === 'url') return cleanNotionText(prop.url || '');
  if (propType === 'phone_number') return cleanNotionText(prop.phone_number || '');
  if (propType === 'date') return cleanNotionText(prop.date?.start || '');
  if (propType === 'number') return prop.number === undefined || prop.number === null ? '' : String(prop.number);
  if (propType === 'checkbox') return prop.checkbox ? 'true' : 'false';
  return '';
}

function notionPropValues(prop = {}) {
  if (prop.type === 'multi_select') {
    return (prop.multi_select || []).map((item) => cleanNotionText(item.name)).filter(Boolean);
  }
  const value = notionPropValue(prop);
  return value ? [value] : [];
}

function notionPageUrl(pageId = '') {
  const cleaned = String(pageId || '').replace(/-/g, '');
  return cleaned ? `https://www.notion.so/${cleaned}` : '';
}

function resolveNotionPropertyName(properties = {}, preferred = '', aliases = []) {
  if (preferred && properties[preferred]) return preferred;
  for (const alias of aliases) {
    if (properties[alias]) return alias;
  }
  return preferred;
}

function resolveNotionTitlePropertyName(properties = {}, preferred = '') {
  if (preferred && properties[preferred]?.type === 'title') return preferred;
  const match = Object.entries(properties).find(([, schema]) => schema?.type === 'title');
  if (!match) throw new Error('Notion ATS database must contain a title property');
  return match[0];
}

function recruitingNotionPropertyMap(databaseSchema = {}) {
  const properties = databaseSchema.properties || {};
  return {
    candidateName: resolveNotionTitlePropertyName(
      properties,
      process.env.RECRUITING_NOTION_PROP_CANDIDATE_NAME || 'Candidate Name'
    ),
    email: resolveNotionPropertyName(properties, process.env.RECRUITING_NOTION_PROP_EMAIL || 'Email', ['Email']),
    source: resolveNotionPropertyName(properties, process.env.RECRUITING_NOTION_PROP_SOURCE || 'Source', ['Source']),
    role: resolveNotionPropertyName(
      properties,
      process.env.RECRUITING_NOTION_PROP_ROLE_AT_TRUEWIND
        || process.env.RECRUITING_NOTION_PROP_ROLE
        || 'Role at Truewind',
      ['Role at Truewind', 'Role @ Truewind', 'Role']
    ),
    currentTitle: resolveNotionPropertyName(
      properties,
      process.env.RECRUITING_NOTION_PROP_CURRENT_ROLE
        || process.env.RECRUITING_NOTION_PROP_CURRENT_TITLE
        || 'Current Role',
      ['Current Role', 'Current Title', 'Title']
    ),
    company: resolveNotionPropertyName(
      properties,
      process.env.RECRUITING_NOTION_PROP_CURRENT_COMPANY
        || process.env.RECRUITING_NOTION_PROP_COMPANY
        || 'Current Company',
      ['Current Company', 'Company']
    ),
    careerStage: resolveNotionPropertyName(properties, process.env.RECRUITING_NOTION_PROP_CAREER_STAGE || 'Career Stage', ['Career Stage']),
    location: resolveNotionPropertyName(properties, process.env.RECRUITING_NOTION_PROP_LOCATION || 'Location', ['Location']),
    linkedinUrl: resolveNotionPropertyName(properties, process.env.RECRUITING_NOTION_PROP_LINKEDIN_URL || 'LinkedIn URL', ['LinkedIn URL', 'LinkedIn']),
    resumeUrl: resolveNotionPropertyName(properties, process.env.RECRUITING_NOTION_PROP_RESUME_URL || 'Resume URL', ['Resume URL', 'Resume']),
    dateFirstEntered: resolveNotionPropertyName(properties, process.env.RECRUITING_NOTION_PROP_DATE_FIRST_ENTERED || 'Date first entered', ['Date first entered']),
    gmailThreadId: resolveNotionPropertyName(properties, process.env.RECRUITING_NOTION_PROP_GMAIL_THREAD_ID || 'Gmail thread id', ['Gmail thread id']),
    status: resolveNotionPropertyName(properties, process.env.RECRUITING_NOTION_PROP_STATUS || 'Status', ['Status']),
  };
}

function statusIsTerminal(status) {
  return new Set(['rejected', 'passed', 'accepted', 'n/a']).has(cleanNotionText(status).toLowerCase());
}

function shouldExcludeFromActiveAtsDigest(status) {
  return cleanNotionText(status).toLowerCase() === 'reject pending';
}

async function notionRequest(endpoint, method = 'GET', body = null) {
  const token = getEnvFirst('NOTION_INTERNAL_INTEGRATION_SECRET', 'NOTION_INTERNAL_INTEGRATION');
  if (!token) throw new Error('Notion ATS is not configured. Set NOTION_INTERNAL_INTEGRATION_SECRET or NOTION_INTERNAL_INTEGRATION.');
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.notion.com',
      path: endpoint,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Notion-Version': process.env.NOTION_VERSION || '2022-06-28',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        let parsed = {};
        if (data) {
          try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Notion ${res.statusCode}: ${parsed.message || parsed.error || data}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.setTimeout(DEFAULT_HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`Notion request timed out after ${DEFAULT_HTTP_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function queryAllNotionDatabasePages(databaseId, queryBody = {}) {
  const pages = [];
  let startCursor = '';
  do {
    const body = { page_size: 100, ...queryBody };
    if (startCursor) body.start_cursor = startCursor;
    const response = await notionRequest(`/v1/databases/${encodeURIComponent(databaseId)}/query`, 'POST', body);
    pages.push(...(response.results || []));
    startCursor = response.has_more ? response.next_cursor : '';
  } while (startCursor);
  return pages;
}

function buildRecruitingCandidateFromNotionPage(page, propMap) {
  const props = page.properties || {};
  const roleValues = notionPropValues(props[propMap.role]);
  return {
    candidate_name: notionPropValue(props[propMap.candidateName]) || 'Unknown',
    email: notionPropValue(props[propMap.email]),
    source: notionPropValue(props[propMap.source]),
    role: roleValues.length ? roleValues.join(', ') : (notionPropValue(props[propMap.role]) || 'Unknown'),
    current_title: notionPropValue(props[propMap.currentTitle]) || 'Unknown',
    company: notionPropValue(props[propMap.company]) || 'Unknown',
    career_stage: notionPropValue(props[propMap.careerStage]) || 'Unknown',
    location: notionPropValue(props[propMap.location]) || 'Unknown',
    linkedin_url: notionPropValue(props[propMap.linkedinUrl]),
    resume_url: notionPropValue(props[propMap.resumeUrl]),
    thread_id: notionPropValue(props[propMap.gmailThreadId]),
    status: notionPropValue(props[propMap.status]) || 'Awaiting Decision',
    notion_url: page.url || notionPageUrl(page.id),
    date_first_entered: notionPropValue(props[propMap.dateFirstEntered]),
  };
}

async function listRecruitingOutstandingCandidates(input = {}) {
  const databaseId = getEnvFirst('NOTION_DATABASE_ID', 'NOTION_ATS_DB_ID').replace(/-/g, '');
  if (!databaseId) throw new Error('Notion ATS database is not configured. Set NOTION_DATABASE_ID or NOTION_ATS_DB_ID.');
  const databaseSchema = await notionRequest(`/v1/databases/${encodeURIComponent(databaseId)}`);
  const propMap = recruitingNotionPropertyMap(databaseSchema);
  const pages = await queryAllNotionDatabasePages(databaseId);
  const mode = cleanNotionText(input.mode || 'active').toLowerCase();
  const roleFilter = cleanNotionText(input.role || '').toLowerCase();
  const statusFilter = cleanNotionText(input.status || '').toLowerCase();
  const limit = Math.min(Math.max(Number(input.limit || 25), 1), 100);

  const candidates = pages
    .map((page) => buildRecruitingCandidateFromNotionPage(page, propMap))
    .filter((candidate) => {
      const status = candidate.status || 'Awaiting Decision';
      if (mode === 'awaiting_decision') {
        if (cleanNotionText(status).toLowerCase() !== 'awaiting decision') return false;
        if (cleanNotionText(candidate.source).toLowerCase() === 'superposition') return false;
        if (!candidate.thread_id) return false;
      } else if (statusIsTerminal(status) || shouldExcludeFromActiveAtsDigest(status)) {
        return false;
      }
      if (roleFilter && !cleanNotionText(candidate.role).toLowerCase().includes(roleFilter)) return false;
      if (statusFilter && cleanNotionText(status).toLowerCase() !== statusFilter) return false;
      return true;
    })
    .sort((a, b) => (
      cleanNotionText(a.status).localeCompare(cleanNotionText(b.status))
      || cleanNotionText(a.date_first_entered).localeCompare(cleanNotionText(b.date_first_entered))
      || cleanNotionText(a.candidate_name).localeCompare(cleanNotionText(b.candidate_name))
    ));

  const statusSummary = {};
  for (const candidate of candidates) {
    statusSummary[candidate.status] = (statusSummary[candidate.status] || 0) + 1;
  }
  return JSON.stringify({
    mode,
    total: candidates.length,
    returned: Math.min(candidates.length, limit),
    status_summary: statusSummary,
    candidates: candidates.slice(0, limit),
  });
}

function titleCase(value) {
  return String(value || '')
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function parseNameFromEmail(email) {
  const localPart = normalizeEmail(email).split('@')[0] || '';
  const cleaned = localPart
    .replace(/\+.*$/, '')
    .replace(/[0-9]+/g, ' ')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = cleaned.split(' ').filter(Boolean);
  return {
    firstname: titleCase(parts[0] || ''),
    lastname: titleCase(parts.slice(1).join(' ')),
  };
}

function getEmailDomain(email) {
  const parts = normalizeEmail(email).split('@');
  return parts.length === 2 ? parts[1] : '';
}

function inferCompanyFromEmail(email) {
  const domain = getEmailDomain(email);
  if (!domain) return { company: '', domain: '' };
  const genericDomains = new Set([
    'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
    'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'hey.com', 'msn.com', 'live.com',
  ]);
  if (genericDomains.has(domain)) return { company: '', domain };
  const root = domain.split('.').slice(0, -1).join(' ') || domain.split('.')[0];
  return { company: titleCase(root), domain };
}

function compactProperties(properties, options = {}) {
  const preserveEmptyKeys = new Set(options.preserveEmptyKeys || []);
  return Object.fromEntries(
    Object.entries(properties || {}).filter(([key, value]) => (
      value !== undefined && value !== null && (value !== '' || preserveEmptyKeys.has(key))
    ))
  );
}

function deduceLeadSource(contextText) {
  const text = String(contextText || '').toLowerCase();
  if (/\b(webinar|web cast|webcast)\b/.test(text)) return 'Webinar';
  if (/\b(referred by|referral|referred|intro(?:duced)? by|introduction from)\b/.test(text)) return 'Referral';
  if (/\b(they contacted us|inbound|came inbound|reached out to us|contacted us)\b/.test(text)) return 'Self serve';
  if (/\b(met at|conference|event|summit|meetup|trade show|booth|expo)\b/.test(text)) return 'Event';
  if (/\b(reached out|contacted|outbound|prospect(?:ed)?|sales sourced)\b/.test(text)) return TRUEWIND_HUBSPOT.defaultOutboundLeadSource;
  return TRUEWIND_HUBSPOT.defaultOutboundLeadSource;
}

function resolveExplicitHubSpotOwner(input = {}) {
  const ownerName = String(input.owner_name || input.owner || '').trim().toLowerCase();
  if (ownerName && TRUEWIND_HUBSPOT.ownersByName[ownerName]) {
    return { ...TRUEWIND_HUBSPOT.ownersByName[ownerName], source: 'explicit owner' };
  }
  return null;
}

function resolveHubSpotOwner(input = {}) {
  const explicitOwner = resolveExplicitHubSpotOwner(input);
  if (explicitOwner) return explicitOwner;

  const metadata = getSlackMetadata(input);
  const slackUserId = String(input.slack_user_id || input.slackUserId || metadata.slack_user_id || '').trim();
  const mapped = slackUserId ? SLACK_TO_HUBSPOT_OWNER[slackUserId] : null;
  if (mapped) {
    if (typeof mapped === 'string') {
      const byIdName = Object.values(TRUEWIND_HUBSPOT.ownersByName).find((owner) => owner.id === mapped)?.name || `HubSpot owner ${mapped}`;
      return { id: mapped, name: byIdName, source: 'from Slack tag' };
    }
    if (mapped.id) return { id: String(mapped.id), name: mapped.name || `HubSpot owner ${mapped.id}`, source: 'from Slack tag' };
  }

  return {
    id: TRUEWIND_HUBSPOT.defaultOwnerId,
    name: TRUEWIND_HUBSPOT.defaultOwnerName,
    source: slackUserId ? 'default; Slack user not mapped' : 'default',
  };
}

function isAllowedDealOwner(owner = {}) {
  const ownerId = String(owner.id || '').trim();
  return ownerId === TRUEWIND_HUBSPOT.dealOwnerIds.sarah || ownerId === TRUEWIND_HUBSPOT.dealOwnerIds.xavier;
}

function stableOwnerHash(value) {
  const text = String(value || '').trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function resolveDealHubSpotOwner(input = {}, requesterOwner = null) {
  const explicitOwner = resolveExplicitHubSpotOwner(input);
  if (explicitOwner && isAllowedDealOwner(explicitOwner)) {
    return { ...explicitOwner, source: 'explicit deal owner' };
  }
  if (requesterOwner && isAllowedDealOwner(requesterOwner)) {
    return { ...requesterOwner, source: 'requester is deal owner' };
  }

  const assignmentKey = [
    input.company,
    input.company_name,
    input.dealname,
    input.email,
    input.context,
  ].filter(Boolean).join('|');
  const useSarah = stableOwnerHash(assignmentKey) % 2 === 0;
  return useSarah
    ? { id: TRUEWIND_HUBSPOT.dealOwnerIds.sarah, name: 'Sarah Elix', source: 'company split between Sarah/Xavier' }
    : { id: TRUEWIND_HUBSPOT.dealOwnerIds.xavier, name: 'Xavier Marco', source: 'company split between Sarah/Xavier' };
}

async function resolveHubSpotOwnerForProspect(input = {}) {
  const explicitOwner = resolveExplicitHubSpotOwner(input);
  if (explicitOwner) return explicitOwner;

  const metadata = getSlackMetadata(input);
  const slackUserId = String(input.slack_user_id || input.slackUserId || metadata.slack_user_id || '').trim();
  let slackUserEmail = String(input.slack_user_email || input.slackUserEmail || '').trim().toLowerCase();
  if (!slackUserEmail && slackUserId) {
    slackUserEmail = (await getSlackUserEmail(slackUserId)).trim().toLowerCase();
  }
  if (slackUserEmail) {
    try {
      const owners = await hubspotRequest('/crm/v3/owners/?limit=100');
      const owner = (owners.results || []).find((candidate) => (
        String(candidate.email || '').trim().toLowerCase() === slackUserEmail
      ));
      if (owner?.id) {
        const name = [owner.firstName, owner.lastName].filter(Boolean).join(' ') || owner.email || `HubSpot owner ${owner.id}`;
        return { id: String(owner.id), name, source: 'from Slack tag' };
      }
    } catch (err) {
      console.error(`Could not map Slack user email to HubSpot owner: ${err.message}`);
    }
  }

  return resolveHubSpotOwner(input);
}

async function resolveRequesterHubSpotOwnerForProspect(input = {}) {
  return resolveHubSpotOwnerForProspect({
    ...input,
    owner_name: '',
    owner: '',
  });
}

function getSlackMetadata(input = {}) {
  const context = String(input.context || input.context_text || input.notes || '');
  const metadataMatch = context.match(/\[Slack metadata:\s*([^\]]+)\]/i);
  const metadata = {};
  if (metadataMatch) {
    for (const pair of metadataMatch[1].split(',')) {
      const [rawKey, ...rawValueParts] = pair.split('=');
      const key = rawKey?.trim();
      const value = rawValueParts.join('=').trim();
      if (key && value) metadata[key] = value;
    }
  }
  return {
    channel_id: input.channel_id || input.channelId || metadata.channel_id || '',
    slack_user_id: input.slack_user_id || input.slackUserId || metadata.slack_user_id || '',
  };
}

function isHubSpotWriteAuthorized(input, owner) {
  if (!HUBSPOT_WRITE_REQUIRE_AUTH) return { authorized: true, reason: 'auth disabled' };
  const metadata = getSlackMetadata(input);
  const slackUserId = String(metadata.slack_user_id || '').trim();
  const channelId = String(metadata.channel_id || '').trim();
  if (slackUserId && HUBSPOT_WRITE_ALLOWED_SLACK_USER_IDS.has(slackUserId)) {
    return { authorized: true, reason: 'allowed Slack user' };
  }
  if (slackUserId && SLACK_TO_HUBSPOT_OWNER[slackUserId]) {
    return { authorized: true, reason: 'Slack user maps to HubSpot owner' };
  }
  if (channelId && HUBSPOT_WRITE_ALLOWED_SLACK_CHANNEL_IDS.has(channelId)) {
    return { authorized: true, reason: 'allowed Slack channel' };
  }
  if (owner?.source === 'from Slack tag') {
    return { authorized: true, reason: 'Slack user maps to HubSpot owner' };
  }
  return {
    authorized: false,
    reason: 'HubSpot writes require a mapped HubSpot owner or an allowed Slack user/channel',
  };
}

async function firecrawlRequest(endpoint, body) {
  if (!FIRECRAWL_API_KEY) {
    return { success: false, error: 'Firecrawl not configured. Set FIRECRAWL_API_KEY.' };
  }
  const payload = await httpRequest(`${FIRECRAWL_API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
    timeout: Number(process.env.FIRECRAWL_TIMEOUT_MS || DEFAULT_HTTP_TIMEOUT_MS),
  });
  if (!payload || payload.success === false) {
    return { success: false, error: payload?.error || payload?.message || JSON.stringify(payload) };
  }
  return payload;
}

function isLinkedInProfileUrl(url) {
  return /^https?:\/\/([a-z]{2,3}\.)?www\.linkedin\.com\/in\//i.test(String(url || ''));
}

function normalizeLinkedInUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return String(url).split('?')[0].replace(/\/$/, '');
  }
}

function scoreLinkedInResult(result, email, inputName) {
  const haystack = `${result.title || ''} ${result.description || ''} ${result.url || ''}`.toLowerCase();
  let score = 0;
  if (isLinkedInProfileUrl(result.url)) score += 5;
  const domain = getEmailDomain(email).split('.')[0];
  if (domain && haystack.includes(domain.toLowerCase())) score += 1;
  for (const part of String(inputName || '').toLowerCase().split(/\s+/).filter(Boolean)) {
    if (haystack.includes(part)) score += 1;
  }
  if (haystack.includes('linkedin')) score += 1;
  return score;
}

function extractLinkedInProfile(markdown, fallback = {}) {
  const text = String(markdown || '');
  const title = String(fallback.title || '');
  const description = String(fallback.description || '');
  const combined = `${title}\n${description}\n${text}`.replace(/\s+/g, ' ').trim();
  const result = {};

  const titleParts = title.split('|')[0].split(' - ');
  if (titleParts[0] && !/linkedin/i.test(titleParts[0])) {
    const nameParts = titleParts[0].trim().split(/\s+/);
    if (nameParts.length >= 2) {
      result.firstname = titleCase(nameParts[0]);
      result.lastname = titleCase(nameParts.slice(1).join(' '));
    }
  }

  const headline = titleParts.slice(1).join(' - ') || description;
  const atMatch = headline.match(/(.+?)\s+(?:at|@)\s+(.+?)(?:\s+\||$)/i);
  if (atMatch) {
    result.jobtitle = atMatch[1].trim();
    result.company = atMatch[2].replace(/\s*\|.*$/, '').trim();
  }

  const currentMatch = combined.match(/Current:\s*([^.;|]+?)(?:\.|;|\||$)/i);
  if (!result.jobtitle && currentMatch) result.jobtitle = currentMatch[1].trim();

  return compactProperties(result);
}

async function findLinkedInEnrichment({ email, firstname, lastname }) {
  const emailName = parseNameFromEmail(email);
  const fullName = [firstname || emailName.firstname, lastname || emailName.lastname].filter(Boolean).join(' ');
  const queries = [
    `"${email}" LinkedIn`,
    fullName ? `"${fullName}" LinkedIn` : '',
  ].filter(Boolean);

  const candidates = [];
  const seenUrls = new Set();
  for (const query of queries) {
    let payload;
    try {
      payload = await firecrawlRequest('/search', {
        query,
        limit: Number(process.env.FIRECRAWL_LINKEDIN_SEARCH_LIMIT || 5),
        scrapeOptions: { formats: ['markdown'] },
      });
    } catch (err) {
      return { found: false, error: err.message, candidates: [] };
    }
    if (!payload.success) return { found: false, error: payload.error, candidates: [] };

    for (const item of payload.data || []) {
      if (!isLinkedInProfileUrl(item.url)) continue;
      const url = normalizeLinkedInUrl(item.url);
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      candidates.push({
        url,
        title: item.title || '',
        description: item.description || '',
        profile: extractLinkedInProfile(item.markdown, item),
        score: scoreLinkedInResult(item, email, fullName),
      });
    }
    if (candidates.length > 0) break;
  }

  if (candidates.length === 0) return { found: false, candidates: [] };
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  const tied = candidates.filter((candidate) => candidate.score === top.score);
  if (tied.length > 1 && top.score < 8) {
    return { found: false, needsDisambiguation: true, candidates: candidates.slice(0, 5) };
  }
  return { found: true, url: top.url, profile: top.profile, candidates: candidates.slice(0, 5) };
}

async function getHubSpotContactProperty(propertyName) {
  if (hubspotContactPropertyCache.has(propertyName)) {
    return hubspotContactPropertyCache.get(propertyName);
  }
  try {
    const property = await getHubSpotProperty('contacts', propertyName);
    hubspotContactPropertyCache.set(propertyName, property);
    return property;
  } catch (err) {
    if (err.statusCode === 404) {
      hubspotContactPropertyCache.set(propertyName, null);
      return null;
    }
    if (err.statusCode === 401 || err.statusCode === 403) {
      console.error(`Cannot read HubSpot contact property ${propertyName}: ${err.message}`);
      hubspotContactPropertyCache.set(propertyName, null);
      return null;
    }
    throw err;
  }
}

async function getHubSpotProperty(objectType, propertyName) {
  const cacheKey = `${objectType}:${propertyName}`;
  if (hubspotPropertyCache.has(cacheKey)) return hubspotPropertyCache.get(cacheKey);
  try {
    const property = await hubspotRequest(`/crm/v3/properties/${encodeURIComponent(objectType)}/${encodeURIComponent(propertyName)}`);
    hubspotPropertyCache.set(cacheKey, property);
    return property;
  } catch (err) {
    if (err.statusCode === 404) {
      hubspotPropertyCache.set(cacheKey, null);
      return null;
    }
    throw err;
  }
}

function normalizeHubSpotPropertyValue(property, value) {
  if (value === undefined || value === null || value === '') return value;
  const options = Array.isArray(property?.options) ? property.options : [];
  if (options.length === 0) return value;

  const stringValue = String(value);
  if (options.some((option) => String(option.value) === stringValue)) return value;

  const labelMatch = options.find((option) => String(option.label || '').toLowerCase() === stringValue.toLowerCase());
  if (labelMatch) return labelMatch.value;

  const allowed = options.map((option) => option.value).filter(Boolean).join(', ');
  throw new Error(`Invalid HubSpot ${property.name} value "${stringValue}". Use one of: ${allowed}`);
}

function isReadOnlyHubSpotProperty(property) {
  const metadata = property?.modificationMetadata || {};
  return Boolean(
    property?.readOnlyValue
    || property?.calculated
    || metadata.readOnlyValue
  );
}

async function validateHubSpotProperties(objectType, properties) {
  const normalized = {};
  for (const [propertyName, value] of Object.entries(properties || {})) {
    const property = await getHubSpotProperty(objectType, propertyName);
    if (!property) {
      throw new Error(`Invalid HubSpot ${objectType} property "${propertyName}"`);
    }
    if (isReadOnlyHubSpotProperty(property)) {
      throw new Error(`HubSpot ${objectType} property "${propertyName}" is read-only and cannot be updated`);
    }
    normalized[propertyName] = normalizeHubSpotPropertyValue(property, value);
  }
  return normalized;
}

async function getExistingContactProperties(propertyNames, fallbackPropertyNames = []) {
  const checks = await Promise.all(propertyNames.map(async (propertyName) => ({
    propertyName,
    property: await getHubSpotContactProperty(propertyName),
  })));
  const writable = checks.filter((check) => (
    check.property
    && !check.property.readOnlyValue
    && !check.property.calculated
  )).map((check) => check.propertyName);
  return writable.length > 0 ? writable : fallbackPropertyNames;
}

async function resolveContactTypeValue() {
  const requested = process.env.TRUEWIND_HUBSPOT_CONTACT_TYPE || 'Prospective Customer';
  const property = await getHubSpotContactProperty('contact_type');
  const options = property?.options || [];
  if (options.some((option) => option.value === requested)) return requested;
  if (options.some((option) => option.label === requested)) {
    return options.find((option) => option.label === requested).value;
  }
  const legacy = options.find((option) => option.value === 'Prospective Customer' || option.label === 'Prospective Customer');
  if (legacy) return legacy.value;
  return requested;
}

async function searchHubSpotObject(objectType, filters, properties, limit = 10) {
  const res = await hubspotRequest(`/crm/v3/objects/${objectType}/search`, 'POST', {
    filterGroups: [{ filters }],
    properties,
    limit,
  });
  return res.results || [];
}

async function findContactByEmail(email) {
  const linkedinProperties = await getExistingContactProperties(
    ['linkedin___profile', 'hs_linkedin_url', 'linkedin_profile_url'],
    ['linkedin___profile', 'hs_linkedin_url']
  );
  const results = await searchHubSpotObject(
    'contacts',
    [{ propertyName: 'email', operator: 'EQ', value: normalizeEmail(email) }],
    ['email', 'firstname', 'lastname', 'company', 'jobtitle', 'lifecyclestage', 'hs_lead_status', 'contact_type', 'erp', 'lead_source', ...linkedinProperties],
    10
  );
  return results[0] || null;
}

async function findOrCreateCompany(companyName, domain) {
  const properties = ['name', 'domain'];
  let results = [];
  if (domain) {
    results = await searchHubSpotObject('companies', [{ propertyName: 'domain', operator: 'EQ', value: domain }], properties, 1);
  }
  if (results.length === 0 && companyName) {
    results = await searchHubSpotObject('companies', [{ propertyName: 'name', operator: 'EQ', value: companyName }], properties, 1);
  }
  if (results[0]) return { record: results[0], created: false };

  const companyProps = await validateHubSpotProperties('companies', compactProperties({ name: companyName, domain }));
  const res = await hubspotRequest('/crm/v3/objects/companies', 'POST', {
    properties: companyProps,
  });
  return { record: res, created: true };
}

async function findExistingDeal(dealName) {
  const results = await searchHubSpotObject(
    'deals',
    [
      { propertyName: 'dealname', operator: 'EQ', value: dealName },
      { propertyName: 'pipeline', operator: 'EQ', value: TRUEWIND_HUBSPOT.pipeline },
    ],
    ['dealname', 'pipeline', 'dealstage', 'closedate', 'amount'],
    1
  );
  return results[0] || null;
}

async function createHubSpotAssociation(fromType, fromId, toType, toId, associationTypeId) {
  return hubspotRequest(
    `/crm/v4/objects/${fromType}/${encodeURIComponent(fromId)}/associations/${toType}/${encodeURIComponent(toId)}`,
    'PUT',
    [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId }]
  );
}

function normalizeDateInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
}

function parseGrainSearchDateRange(dateRange = {}) {
  if (typeof dateRange === 'string') {
    const trimmed = dateRange.trim();
    if (!trimmed) return {};
    const [startRaw, endRaw] = trimmed.split(/\s*(?:to|\.\.|,)\s*/i);
    return {
      start: normalizeDateInput(startRaw),
      end: normalizeDateInput(endRaw),
    };
  }
  if (!dateRange || typeof dateRange !== 'object') return {};
  return {
    start: normalizeDateInput(dateRange.start || dateRange.start_date || dateRange.after),
    end: normalizeDateInput(dateRange.end || dateRange.end_date || dateRange.before),
  };
}

function getGrainRecordingSearchText(recording) {
  const participants = (recording?.participants || recording?.attendees || recording?.people || [])
    .map((participant) => [
      participant?.name,
      participant?.email,
      participant?.email_address,
      participant?.company,
      participant?.organization,
    ].filter(Boolean).join(' '))
    .join(' ');
  return normalizeDigestText([
    getGrainRecordingTitle(recording),
    recording?.description,
    recording?.calendar_event?.title,
    recording?.calendar_event?.description,
    participants,
  ].filter(Boolean).join(' '));
}

function grainRecordingMatchesSearch(recording, { companyName = '', participantEmail = '', start = '', end = '' } = {}) {
  const startMs = getGrainRecordingStartMs(recording);
  const lowerBound = start ? new Date(start).getTime() : 0;
  const upperBound = end ? new Date(end).getTime() : 0;
  if (lowerBound && startMs && startMs < lowerBound) return false;
  if (upperBound && startMs && startMs > upperBound) return false;

  const normalizedCompany = normalizeDigestText(companyName);
  const normalizedEmail = normalizeEmail(participantEmail);
  const text = getGrainRecordingSearchText(recording);
  const participantEmails = getGrainParticipantEmails(recording);

  if ((lowerBound || upperBound) && !startMs) return false;
  if (normalizedEmail && !participantEmails.includes(normalizedEmail) && !text.includes(normalizedEmail)) {
    return false;
  }
  if (normalizedCompany) {
    const companyTokens = normalizedCompany.split(/[^a-z0-9]+/).filter(token => token.length >= 3);
    if (companyTokens.length && !companyTokens.every(token => text.includes(token))) return false;
  }
  return Boolean(normalizedCompany || normalizedEmail || start || end);
}

async function searchGrainRecordings(input = {}) {
  if (!GRAIN_API_TOKEN) return { error: 'Grain not configured' };

  const dateRange = parseGrainSearchDateRange(input.date_range || input.dateRange || {});
  const search = {
    companyName: input.company_name || input.companyName || '',
    participantEmail: input.participant_email || input.participantEmail || '',
    start: dateRange.start || '',
    end: dateRange.end || '',
  };
  if (!search.companyName && !search.participantEmail && !search.start && !search.end) {
    return { error: 'Provide company_name, participant_email, or date_range' };
  }

  const recordings = [];
  let cursor = '';
  const maxPagesRaw = Number(input.max_pages || process.env.GRAIN_SEARCH_MAX_PAGES || 20);
  const pageSizeRaw = Number(input.page_size || process.env.GRAIN_SEARCH_PAGE_SIZE || 100);
  const maxPages = Number.isFinite(maxPagesRaw) && maxPagesRaw > 0 ? Math.floor(maxPagesRaw) : 20;
  const pageSizeNumber = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(Math.floor(pageSizeRaw), 100) : 100;
  const pageSize = String(pageSizeNumber);
  let stoppedBecauseOfPageLimit = false;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ limit: pageSize });
    if (cursor && !cursor.startsWith('http')) params.set('cursor', cursor);
    const endpoint = cursor && cursor.startsWith('http') ? cursor : `/recordings?${params}`;
    const payload = await grainRequest(endpoint);
    if (payload?.error) return { error: payload.error };

    const { items, cursor: nextCursor, hasMore } = parseListItems(payload);
    recordings.push(...items);
    if (!hasMore || !nextCursor || items.length === 0) break;
    if (page === maxPages - 1) {
      stoppedBecauseOfPageLimit = true;
      break;
    }
    cursor = nextCursor;
  }

  const limit = Math.min(Number(input.limit || 25), 50);
  const matches = dedupeGrainRecordings(recordings)
    .filter(recording => grainRecordingMatchesSearch(recording, search))
    .sort((a, b) => getGrainRecordingStartMs(b) - getGrainRecordingStartMs(a))
    .slice(0, limit);
  return {
    matches,
    searched: recordings.length,
    search,
    coverage: {
      method: 'client-side scan of accessible Grain recordings',
      max_pages: maxPages,
      page_size: pageSizeNumber,
      truncated: stoppedBecauseOfPageLimit,
      warning: stoppedBecauseOfPageLimit
        ? 'Grain recording scan reached GRAIN_SEARCH_MAX_PAGES before exhausting available recordings. Results may be incomplete; state this limitation.'
        : '',
    },
  };
}

function hubSpotObjectType(type) {
  return HUBSPOT_OBJECT_TYPE_IDS[type] || type;
}

function hubSpotPipelineEndpoint(pipelineId = TRUEWIND_HUBSPOT.pipeline) {
  const id = String(pipelineId || TRUEWIND_HUBSPOT.pipeline).trim() || TRUEWIND_HUBSPOT.pipeline;
  return `/crm/v3/pipelines/deals/${encodeURIComponent(id)}`;
}

function parseHubSpotDateBoundary(value, fieldName) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${fieldName} is required`);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(text)) {
    throw new Error(`${fieldName} must be an ISO date/time with timezone or YYYY-MM-DD`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    return pacificLocalToUtcDate(year, month, day, 0, 0, 0);
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`${fieldName} must be a valid ISO date or YYYY-MM-DD date`);
  return date;
}

function parseHubSpotAsOfBoundary(value, fieldName) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-').map(Number);
    const nextDate = shiftPacificDate({ year, month, day }, 1);
    return {
      date: pacificLocalToUtcDate(nextDate.year, nextDate.month, nextDate.day, 0, 0, 0),
      exclusive: true,
      input: text,
    };
  }
  return {
    date: parseHubSpotDateBoundary(text, fieldName),
    exclusive: false,
    input: text,
  };
}

function getHubSpotDealStageHistoryEntries(deal) {
  const history = deal?.propertiesWithHistory?.dealstage;
  if (Array.isArray(history)) {
    return history
      .map((entry) => ({
        value: String(entry.value || '').trim(),
        timestamp: entry.timestamp || entry.updatedAt || entry.sourceTimestamp || '',
        sourceType: entry.sourceType || '',
      }))
      .filter((entry) => entry.value && entry.timestamp)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }
  return [];
}

function dealEnteredStageInRange(deal, stageId, startDate, endDate) {
  const entries = getHubSpotDealStageHistoryEntries(deal);
  const matchingEntries = entries.filter((entry) => {
    if (entry.value !== stageId) return false;
    const timestamp = new Date(entry.timestamp);
    return !Number.isNaN(timestamp.getTime()) && timestamp >= startDate && timestamp < endDate;
  });
  return matchingEntries[0] || null;
}

function isOnOrBeforeAsOf(timestamp, asOfBoundary) {
  if (!asOfBoundary) return true;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return false;
  return asOfBoundary.exclusive ? date < asOfBoundary.date : date <= asOfBoundary.date;
}

function firstOutcomeAfterEntry(deal, entry, outcomeStageIds, asOfBoundary = null) {
  const entryDate = new Date(entry?.timestamp || entry?.entered_stage_at || '');
  if (Number.isNaN(entryDate.getTime())) return null;
  const outcomeSet = new Set(outcomeStageIds.map((stageId) => String(stageId || '').trim()).filter(Boolean));
  if (!outcomeSet.size) return null;

  return getHubSpotDealStageHistoryEntries(deal).find((historyEntry) => {
    if (!outcomeSet.has(historyEntry.value)) return false;
    const outcomeDate = new Date(historyEntry.timestamp);
    return !Number.isNaN(outcomeDate.getTime())
      && outcomeDate > entryDate
      && isOnOrBeforeAsOf(historyEntry.timestamp, asOfBoundary);
  }) || null;
}

function normalizeHubSpotOutcomeTracking(input = {}) {
  const trackOutcomes = input.track_outcomes || input.trackOutcomes;
  if (!trackOutcomes) return null;
  const stages = Array.isArray(trackOutcomes.stages)
    ? trackOutcomes.stages
    : (Array.isArray(trackOutcomes.outcome_stages) ? trackOutcomes.outcome_stages : []);
  const outcomeStageIds = Array.from(new Set(stages.map((stageId) => String(stageId || '').trim()).filter(Boolean)));
  if (!outcomeStageIds.length) throw new Error('track_outcomes.stages must include at least one outcome stage ID');
  return {
    outcomeStageIds,
    asOfBoundary: parseHubSpotAsOfBoundary(trackOutcomes.as_of_date || trackOutcomes.asOfDate, 'track_outcomes.as_of_date'),
    includeDealDetails: trackOutcomes.include_deal_details === true || trackOutcomes.includeDealDetails === true,
  };
}

function summarizeHubSpotStageCohortOutcomes(cohortDeals, outcomeTracking) {
  if (!outcomeTracking) return null;
  const outcomes = { still_active: 0 };
  const dealIdsByOutcome = { still_active: [] };
  const dealDetailsByOutcome = outcomeTracking.includeDealDetails ? { still_active: [] } : null;
  const outcomeDays = {};

  for (const stageId of outcomeTracking.outcomeStageIds) {
    outcomes[stageId] = 0;
    dealIdsByOutcome[stageId] = [];
    if (dealDetailsByOutcome) dealDetailsByOutcome[stageId] = [];
    outcomeDays[stageId] = [];
  }

  for (const cohortDeal of cohortDeals) {
    const outcome = firstOutcomeAfterEntry(
      cohortDeal.deal,
      cohortDeal.entry,
      outcomeTracking.outcomeStageIds,
      outcomeTracking.asOfBoundary,
    );
    const key = outcome ? outcome.value : 'still_active';
    outcomes[key] += 1;
    dealIdsByOutcome[key].push(cohortDeal.id);

    const detail = {
      id: cohortDeal.id,
      dealname: cohortDeal.dealname,
      entered_stage_at: cohortDeal.entered_stage_at,
      current_stage_id: cohortDeal.current_stage_id,
      url: cohortDeal.url,
    };

    if (outcome) {
      const entryMs = new Date(cohortDeal.entered_stage_at).getTime();
      const outcomeMs = new Date(outcome.timestamp).getTime();
      const daysToOutcome = (outcomeMs - entryMs) / 86400000;
      outcomeDays[key].push(daysToOutcome);
      Object.assign(detail, {
        outcome_stage_id: outcome.value,
        outcome_entered_at: new Date(outcome.timestamp).toISOString(),
        days_to_outcome: Number(daysToOutcome.toFixed(2)),
      });
    }

    if (dealDetailsByOutcome) dealDetailsByOutcome[key].push(detail);
  }

  const averageDaysToOutcome = {};
  for (const [stageId, days] of Object.entries(outcomeDays)) {
    averageDaysToOutcome[stageId] = days.length
      ? Number((days.reduce((sum, dayCount) => sum + dayCount, 0) / days.length).toFixed(2))
      : null;
  }

  return {
    outcome_stage_ids: outcomeTracking.outcomeStageIds,
    as_of_date: outcomeTracking.asOfBoundary ? outcomeTracking.asOfBoundary.input : '',
    as_of_cutoff: outcomeTracking.asOfBoundary ? outcomeTracking.asOfBoundary.date.toISOString() : '',
    as_of_cutoff_exclusive: outcomeTracking.asOfBoundary ? outcomeTracking.asOfBoundary.exclusive : false,
    outcome_selection: 'first_tracked_outcome_after_entry',
    outcomes,
    deal_ids_by_outcome: dealIdsByOutcome,
    average_days_to_outcome: averageDaysToOutcome,
    ...(dealDetailsByOutcome ? { deal_details_by_outcome: dealDetailsByOutcome } : {}),
  };
}

async function searchHubSpotDealsForPipeline(pipelineId, maxDeals = 10000) {
  const deals = [];
  let after;

  while (deals.length < maxDeals) {
    const body = {
      filterGroups: [{
        filters: [{ propertyName: 'pipeline', operator: 'EQ', value: pipelineId }],
      }],
      properties: ['dealname', 'pipeline', 'dealstage', 'createdate', 'hs_lastmodifieddate', 'hubspot_owner_id', 'amount', 'closedate'],
      sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
      limit: Math.min(100, maxDeals - deals.length),
    };
    if (after) body.after = after;

    const response = await hubspotRequest('/crm/v3/objects/deals/search', 'POST', body);
    deals.push(...(response.results || []));
    after = response.paging?.next?.after;
    if (!after) break;
  }

  return {
    deals,
    truncated: Boolean(after),
  };
}

async function batchReadHubSpotDealStageHistory(dealIds) {
  const results = [];
  const propertyHistoryBatchLimit = 50;
  for (let i = 0; i < dealIds.length; i += propertyHistoryBatchLimit) {
    const chunk = dealIds.slice(i, i + propertyHistoryBatchLimit);
    const response = await hubspotRequest('/crm/v3/objects/deals/batch/read', 'POST', {
      properties: ['dealname', 'pipeline', 'dealstage', 'createdate', 'hs_lastmodifieddate'],
      propertiesWithHistory: ['dealstage'],
      inputs: chunk.map((id) => ({ id })),
    });
    results.push(...(response.results || []));
  }
  return results;
}

async function countHubSpotDealsEnteredStage(input = {}) {
  const pipelineId = String(input.pipeline_id || TRUEWIND_HUBSPOT.pipeline).trim() || TRUEWIND_HUBSPOT.pipeline;
  const stageId = String(input.stage_id || '').trim();
  if (!stageId) throw new Error('stage_id is required');
  const startDate = parseHubSpotDateBoundary(input.start_date, 'start_date');
  const endDate = parseHubSpotDateBoundary(input.end_date, 'end_date');
  if (endDate <= startDate) throw new Error('end_date must be after start_date');
  const outcomeTracking = normalizeHubSpotOutcomeTracking(input);

  const maxDeals = Math.min(Math.max(Number(input.max_deals || 10000), 1), 10000);
  const { deals: pipelineDeals, truncated: searchTruncated } = await searchHubSpotDealsForPipeline(pipelineId, maxDeals);
  const dealIds = pipelineDeals.map((deal) => String(deal.id)).filter(Boolean);
  const dealsWithHistory = await batchReadHubSpotDealStageHistory(dealIds);
  const byId = new Map(pipelineDeals.map((deal) => [String(deal.id), deal]));
  const matches = [];
  const missingHistory = [];
  const cohortDeals = [];

  for (const deal of dealsWithHistory) {
    const entry = dealEnteredStageInRange(deal, stageId, startDate, endDate);
    if (entry) {
      const properties = deal.properties || {};
      const match = {
        id: String(deal.id),
        dealname: properties.dealname || '',
        entered_stage_at: new Date(entry.timestamp).toISOString(),
        current_stage_id: properties.dealstage || '',
        createdate: properties.createdate || '',
        url: hubspotRecordUrl('0-3', deal.id),
      };
      matches.push(match);
      cohortDeals.push({ ...match, deal, entry });
      continue;
    }
    const fallbackDeal = byId.get(String(deal.id));
    if (!deal?.propertiesWithHistory?.dealstage && fallbackDeal?.properties?.dealstage === stageId) {
      missingHistory.push({
        id: String(deal.id),
        dealname: fallbackDeal.properties?.dealname || '',
        current_stage_id: stageId,
      });
    }
  }

  matches.sort((a, b) => new Date(a.entered_stage_at).getTime() - new Date(b.entered_stage_at).getTime());
  cohortDeals.sort((a, b) => new Date(a.entered_stage_at).getTime() - new Date(b.entered_stage_at).getTime());
  const outcomeSummary = summarizeHubSpotStageCohortOutcomes(cohortDeals, outcomeTracking);

  return {
    pipeline_id: pipelineId,
    stage_id: stageId,
    start_date: startDate.toISOString(),
    end_date: endDate.toISOString(),
    count: matches.length,
    deals_scanned: dealIds.length,
    search_truncated: searchTruncated,
    coverage: {
      method: 'HubSpot dealstage property history via propertiesWithHistory=dealstage',
      warning: searchTruncated
        ? `Scanned the first ${dealIds.length} pipeline deals and stopped at max_deals; result may be incomplete.`
        : '',
      missing_history_current_stage_deals: missingHistory.length,
    },
    results: matches,
    missing_history_current_stage_deals: missingHistory,
    ...(outcomeSummary ? { cohort_outcomes: outcomeSummary } : {}),
  };
}

async function fetchHubSpotAssociationIds(fromType, fromId, toType, maxRecords = 500) {
  const ids = [];
  let after = '';
  let truncated = false;
  while (ids.length < maxRecords) {
    const params = new URLSearchParams({ limit: String(Math.min(500, maxRecords - ids.length)) });
    if (after) params.set('after', after);
    const res = await hubspotRequest(`/crm/v4/objects/${hubSpotObjectType(fromType)}/${encodeURIComponent(fromId)}/associations/${hubSpotObjectType(toType)}?${params}`);
    ids.push(...(res.results || []).map(item => String(item.toObjectId || item.id || '').trim()).filter(Boolean));
    after = res.paging?.next?.after || '';
    if (!after) break;
  }
  if (after) truncated = true;
  return { ids, truncated };
}

function chunkArray(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

async function batchReadHubSpotObjects(objectType, ids, properties) {
  const records = [];
  for (const chunk of chunkArray(ids, 100)) {
    const result = await hubspotRequest(`/crm/v3/objects/${hubSpotObjectType(objectType)}/batch/read`, 'POST', {
      properties,
      inputs: chunk.map(id => ({ id })),
    });
    records.push(...(result.results || []));
  }
  return records;
}

function parseBatchAssociationResults(result) {
  const map = new Map();
  for (const row of result?.results || []) {
    const fromId = String(row.from?.id || row.fromObjectId || row.from?.fromObjectId || '').trim();
    const toItems = Array.isArray(row.to) ? row.to : (Array.isArray(row.toObjectIds) ? row.toObjectIds : []);
    const ids = toItems.map(item => String(item.toObjectId || item.id || item).trim()).filter(Boolean);
    if (fromId) map.set(fromId, ids);
  }
  return map;
}

async function fetchBatchActivityContexts(type, ids) {
  const contexts = new Map(ids.map(id => [id, {}]));
  for (const toType of ['contacts', 'companies']) {
    try {
      for (const chunk of chunkArray(ids, 100)) {
        const result = await hubspotRequest(`/crm/v4/associations/${hubSpotObjectType(type)}/${hubSpotObjectType(toType)}/batch/read`, 'POST', {
          inputs: chunk.map(id => ({ id })),
        });
        const associatedByFromId = parseBatchAssociationResults(result);
        for (const id of chunk) {
          contexts.get(id)[toType] = { ids: associatedByFromId.get(id) || [], truncated: false };
        }
      }
    } catch (err) {
      for (const id of ids) {
        contexts.get(id)[toType] = { error: err.message };
      }
    }
  }
  return contexts;
}

async function getHubSpotAssociatedActivities(input = {}) {
  const dealId = String(input.deal_id || input.dealId || '').trim();
  if (!dealId) return { error: 'deal_id is required' };

  const requestedTypes = Array.isArray(input.activity_types) && input.activity_types.length
    ? input.activity_types
    : Object.keys(HUBSPOT_ACTIVITY_PROPERTIES);
  const activityTypes = requestedTypes
    .map(type => String(type || '').trim().toLowerCase())
    .filter(type => HUBSPOT_ACTIVITY_PROPERTIES[type]);
  const maxPerTypeRaw = Number(input.limit_per_type || 500);
  const maxPerType = Number.isFinite(maxPerTypeRaw) && maxPerTypeRaw > 0 ? Math.min(Math.floor(maxPerTypeRaw), 500) : 500;
  const activities = {};
  const coverage = {};

  for (const type of activityTypes) {
    try {
      const { ids, truncated } = await fetchHubSpotAssociationIds('deals', dealId, type, maxPerType);
      coverage[type] = {
        associated_count_returned: ids.length,
        truncated,
        warning: truncated ? `More than ${maxPerType} associated ${type} exist; returned the first ${maxPerType}.` : '',
      };
      activities[type] = [];
      const activityIds = ids.slice(0, maxPerType);
      const [records, activityContexts] = await Promise.all([
        batchReadHubSpotObjects(type, activityIds, HUBSPOT_ACTIVITY_PROPERTIES[type]),
        fetchBatchActivityContexts(type, activityIds),
      ]);
      const recordsById = new Map(records.map(record => [String(record.id || '').trim(), record]));
      for (const id of activityIds) {
        const record = recordsById.get(id) || { id, properties: {} };
        activities[type].push({
          id: String(record.id || id),
          object_type: type,
          url: hubspotRecordUrl(record.objectTypeId || HUBSPOT_OBJECT_TYPE_IDS[type] || type, record.id || id),
          associations: activityContexts.get(id) || {},
          properties: record.properties || {},
        });
      }
    } catch (err) {
      activities[type] = { error: err.message };
      coverage[type] = { error: err.message };
    }
  }

  return { deal_id: dealId, activities, coverage };
}

function normalizeActivityKeywords(keywords) {
  const values = Array.isArray(keywords) && keywords.length ? keywords : DEFAULT_NO_SHOW_KEYWORDS;
  return Array.from(new Set(values.map((keyword) => String(keyword || '').trim()).filter(Boolean)));
}

function normalizeHubSpotActivityTypes(types, fallback = ['meetings', 'calls', 'notes', 'emails']) {
  const requested = Array.isArray(types) && types.length ? types : fallback;
  return Array.from(new Set(
    requested
      .map((type) => String(type || '').trim().toLowerCase())
      .filter((type) => HUBSPOT_ACTIVITY_PROPERTIES[type])
  ));
}

function stripHubSpotHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function activityDisplayFields(type, properties = {}) {
  if (type === 'meetings') {
    return {
      title: properties.hs_meeting_title || '',
      outcome: properties.hs_meeting_outcome || '',
      body_excerpt: stripHubSpotHtml(properties.hs_meeting_body).slice(0, 500),
    };
  }
  if (type === 'calls') {
    return {
      title: properties.hs_call_title || '',
      outcome: properties.hs_call_disposition || '',
      body_excerpt: stripHubSpotHtml(properties.hs_call_body).slice(0, 500),
    };
  }
  if (type === 'emails') {
    return {
      title: properties.hs_email_subject || '',
      from: properties.hs_email_from_email || '',
      to: properties.hs_email_to_email || '',
      body_excerpt: stripHubSpotHtml(properties.hs_email_text || properties.hs_email_html).slice(0, 500),
    };
  }
  if (type === 'notes') {
    return {
      body_excerpt: stripHubSpotHtml(properties.hs_note_body).slice(0, 500),
    };
  }
  return {};
}

function activitySearchText(type, properties = {}) {
  return Object.values(activityDisplayFields(type, properties)).join('\n').toLowerCase();
}

function matchingActivityKeywords(type, properties, keywords) {
  const haystack = activitySearchText(type, properties);
  return keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
}

async function fetchActivitiesForDealsAnalysis(dealIds, activityTypes, maxPerType) {
  const activitiesByDeal = new Map(dealIds.map((dealId) => [dealId, []]));
  const coverageByDeal = Object.fromEntries(dealIds.map((dealId) => [dealId, {}]));
  for (const type of activityTypes) {
    const associatedByDeal = new Map(dealIds.map((dealId) => [dealId, []]));
    try {
      for (const chunk of chunkArray(dealIds, 100)) {
        const result = await hubspotRequest(`/crm/v4/associations/${HUBSPOT_OBJECT_TYPE_IDS.deals}/${hubSpotObjectType(type)}/batch/read`, 'POST', {
          inputs: chunk.map((id) => ({ id })),
        });
        const chunkMap = parseBatchAssociationResults(result);
        for (const dealId of chunk) {
          associatedByDeal.set(dealId, chunkMap.get(dealId) || []);
        }
      }

      const uniqueActivityIds = Array.from(new Set(
        Array.from(associatedByDeal.values()).flatMap((ids) => ids.slice(0, maxPerType))
      ));
      const records = await batchReadHubSpotObjects(type, uniqueActivityIds, HUBSPOT_ACTIVITY_PROPERTIES[type]);
      const recordsById = new Map(records.map((record) => [String(record.id || '').trim(), record]));

      for (const dealId of dealIds) {
        const ids = associatedByDeal.get(dealId) || [];
        const truncated = ids.length > maxPerType;
        coverageByDeal[dealId][type] = {
          associated_count_returned: Math.min(ids.length, maxPerType),
          truncated,
          warning: truncated ? `More than ${maxPerType} associated ${type} exist; scanned the first ${maxPerType}.` : '',
        };
        for (const id of ids.slice(0, maxPerType)) {
          const record = recordsById.get(id);
          if (record) activitiesByDeal.get(dealId).push({ type, record });
        }
      }
    } catch (err) {
      for (const dealId of dealIds) {
        coverageByDeal[dealId][type] = { error: err.message };
      }
    }
  }
  return { activitiesByDeal, coverageByDeal };
}

async function analyzeHubSpotDealActivities(input = {}) {
  const pipelineId = String(input.pipeline_id || TRUEWIND_HUBSPOT.pipeline).trim() || TRUEWIND_HUBSPOT.pipeline;
  const keywords = normalizeActivityKeywords(input.activity_keywords || input.keywords);
  const activityTypes = normalizeHubSpotActivityTypes(input.activity_types);
  const maxDealsRaw = Number(input.max_deals || 500);
  const maxDeals = Number.isFinite(maxDealsRaw) && maxDealsRaw > 0 ? Math.min(Math.floor(maxDealsRaw), 500) : 500;
  const maxActivitiesPerTypeRaw = Number(input.limit_per_type || input.max_activities_per_type || 100);
  const maxActivitiesPerType = Number.isFinite(maxActivitiesPerTypeRaw) && maxActivitiesPerTypeRaw > 0
    ? Math.min(Math.floor(maxActivitiesPerTypeRaw), 500)
    : 100;

  const { deals, truncated: searchTruncated } = await searchHubSpotDealsForPipeline(pipelineId, maxDeals);
  const dealIds = deals.map((deal) => String(deal.id || '').trim()).filter(Boolean);
  const { activitiesByDeal, coverageByDeal } = await fetchActivitiesForDealsAnalysis(dealIds, activityTypes, maxActivitiesPerType);
  const keywordCounts = Object.fromEntries(keywords.map((keyword) => [keyword, 0]));
  const activityTypeCounts = Object.fromEntries(activityTypes.map((type) => [type, 0]));
  const dealsWithMatches = [];

  for (const deal of deals) {
    const dealId = String(deal.id || '').trim();
    if (!dealId) continue;
    const activities = activitiesByDeal.get(dealId) || [];
    const matchingActivities = [];

    for (const { type, record } of activities) {
      const properties = record.properties || {};
      const matchedKeywords = matchingActivityKeywords(type, properties, keywords);
      if (!matchedKeywords.length) continue;
      for (const keyword of matchedKeywords) keywordCounts[keyword] = (keywordCounts[keyword] || 0) + 1;
      activityTypeCounts[type] = (activityTypeCounts[type] || 0) + 1;
      matchingActivities.push({
        id: String(record.id || ''),
        object_type: type,
        url: hubspotRecordUrl(record.objectTypeId || HUBSPOT_OBJECT_TYPE_IDS[type] || type, record.id),
        timestamp: properties.hs_timestamp || properties.hs_meeting_start_time || '',
        matched_keywords: matchedKeywords,
        fields: activityDisplayFields(type, properties),
      });
    }

    if (matchingActivities.length) {
      const properties = deal.properties || {};
      dealsWithMatches.push({
        deal_id: dealId,
        dealname: properties.dealname || '',
        stage_id: properties.dealstage || '',
        owner_id: properties.hubspot_owner_id || '',
        amount: properties.amount || '',
        closedate: properties.closedate || '',
        url: hubspotRecordUrl('0-3', dealId),
        matching_activities: matchingActivities,
      });
    }
  }

  return {
    pipeline_id: pipelineId,
    activity_keywords: keywords,
    activity_types: activityTypes,
    total_deals_analyzed: deals.length,
    deals_with_matching_activities_count: dealsWithMatches.length,
    deals_with_matching_activities: dealsWithMatches,
    summary_counts_by_keyword: keywordCounts,
    summary_counts_by_activity_type: activityTypeCounts,
    coverage: {
      max_deals: maxDeals,
      max_activities_per_type: maxActivitiesPerType,
      search_truncated: searchTruncated,
      warning: searchTruncated
        ? `Scanned the first ${deals.length} pipeline deals and stopped at max_deals; result may be incomplete.`
        : '',
      activity_coverage_by_deal: coverageByDeal,
    },
  };
}

function mergeExistingContactUpdate({ proposed, existingProperties, explicitKeys }) {
  const merged = {};
  for (const [key, value] of Object.entries(proposed)) {
    if (key === 'email') continue;
    const existingValue = existingProperties?.[key];
    const isBlank = existingValue === undefined || existingValue === null || existingValue === '';
    if (explicitKeys.has(key) || isBlank) {
      merged[key] = value;
    }
  }
  return merged;
}

function formatWorkflowError(err, partial) {
  const lines = [`Error: ${err.message}`];
  const partialLines = [];
  if (partial.contactId) partialLines.push(`Contact ID: ${partial.contactId}`);
  if (partial.companyId) partialLines.push(`Company ID: ${partial.companyId}`);
  if (partial.dealId) partialLines.push(`Deal ID: ${partial.dealId}`);
  if (partial.linkedinUrl) partialLines.push(`LinkedIn URL: ${partial.linkedinUrl}`);
  if (partialLines.length > 0) {
    lines.push('Partial HubSpot work completed before the error:');
    lines.push(...partialLines);
  }
  return lines.join('\n');
}

function extractStructuredField(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp(`^\\s*${escaped}\\s*:?\\s+(.+)$`, 'im'));
  return match ? match[1].trim() : '';
}

function extractStructuredBlockField(text, label, stopLabels = []) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const source = String(text || '');
  const match = source.match(new RegExp(`^\\s*${escaped}\\s*:?\\s*(.*)$`, 'im'));
  if (!match) return '';

  const startIndex = match.index + match[0].length;
  const firstLine = match[1] || '';
  const rest = source.slice(startIndex).replace(/^\r?\n/, '');
  const stopPattern = stopLabels.length
    ? new RegExp(`^\\s*(?:${stopLabels.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*:`, 'i')
    : null;
  const continuation = [];
  for (const line of rest.split(/\r?\n/)) {
    if (stopPattern && stopPattern.test(line)) break;
    continuation.push(line);
  }
  return [firstLine, ...continuation].join('\n').trim();
}

function extractStructuredEmail(text) {
  const field = extractStructuredField(text, 'Email');
  const source = field || text;
  const mailtoMatch = source.match(/<mailto:([^|>]+)(?:\|[^>]+)?>/i);
  if (mailtoMatch) return normalizeEmail(mailtoMatch[1]);
  const emailMatch = source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return emailMatch ? normalizeEmail(emailMatch[0]) : '';
}

function parseStructuredDealRequest(text) {
  const clean = stripMention(text);
  if (!/\b(create|add|push)\b[\s\S]{0,80}\bdeal\b/i.test(clean)) return null;

  const company = extractStructuredField(clean, 'Company');
  const contact = extractStructuredField(clean, 'Contact');
  const email = extractStructuredEmail(clean);
  const ownerName = extractStructuredField(clean, 'Deal owner') || extractStructuredField(clean, 'Owner');
  const source = extractStructuredField(clean, 'Source');
  const type = extractStructuredField(clean, 'Type');
  const meetingBooked = extractStructuredField(clean, 'Meeting booked for') || extractStructuredField(clean, 'Meeting');
  const notes = extractStructuredBlockField(clean, 'Notes', [
    'Company',
    'Type',
    'Contact',
    'Email',
    'LinkedIn',
    'Amount',
    'Close date',
    'Deal owner',
    'Owner',
    'Source',
    'Meeting booked for',
    'Meeting',
  ]);

  if (!company && !contact && !email) return null;

  return {
    company,
    contact,
    email,
    owner_name: ownerName,
    lead_source: source,
    type,
    meeting_booked: meetingBooked,
    notes,
    dealstage: TRUEWIND_HUBSPOT.mqlDealStage,
  };
}

function normalizeExplicitDealSource(input = {}) {
  return String(input.deal_source || input.lead_source || input.source || '').trim();
}

function missingDealSourceMessage() {
  return [
    'Missing required deal source. No HubSpot deal was created.',
    'Please provide the deal source before I create the deal.',
    'Valid deal sources: Outbound - Sales Sourced List, Event, In-Person Socials, Webinar, PR, Self serve, Referral, Inbound - Direct.',
  ].join('\n');
}

function splitFullName(name, email = '') {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return parseNameFromEmail(email);
  if (parts.length === 1) return { firstname: titleCase(parts[0]), lastname: '' };
  return { firstname: titleCase(parts[0]), lastname: titleCase(parts.slice(1).join(' ')) };
}

async function createDefaultHubSpotAssociation(fromType, fromId, toType, toId) {
  if (!fromId || !toId) return null;
  return hubspotRequest(
    `/crm/v4/objects/${fromType}/${encodeURIComponent(fromId)}/associations/default/${toType}/${encodeURIComponent(toId)}`,
    'PUT'
  );
}

function escapeHubSpotNoteText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildDealNoteBody(input = {}) {
  const lines = [
    input.type ? `Type: ${input.type}` : '',
    input.meeting_booked ? `Meeting booked for: ${input.meeting_booked}` : '',
    input.notes ? `Notes: ${input.notes}` : '',
  ].filter(Boolean);
  return lines.map((line) => escapeHubSpotNoteText(line).replace(/\r?\n/g, '<br>')).join('<br>');
}

async function createStructuredDealNote({ dealId, contactId, companyId, body }) {
  if (!String(body || '').trim()) return null;
  const note = await hubspotRequest('/crm/v3/objects/notes', 'POST', {
    properties: {
      hs_timestamp: new Date().toISOString(),
      hs_note_body: body,
    },
  });
  const noteId = requireHubSpotObjectId(note, 'HubSpot note create');
  await Promise.all([
    createDefaultHubSpotAssociation('notes', noteId, 'deals', dealId),
    contactId ? createDefaultHubSpotAssociation('notes', noteId, 'contacts', contactId) : null,
    companyId ? createDefaultHubSpotAssociation('notes', noteId, 'companies', companyId) : null,
  ].filter(Boolean));
  return note;
}

async function runStructuredDealCreateWorkflow(input) {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) {
    return 'Error: missing valid Email. No HubSpot deal was created.';
  }
  if (!String(input.company || '').trim()) {
    return 'Error: missing Company. No HubSpot deal was created.';
  }
  const leadSource = normalizeExplicitDealSource(input);
  if (!leadSource) {
    return `Error: ${missingDealSourceMessage()}`;
  }

  const contactOwner = resolveHubSpotOwner({ context: input.context, slack_user_id: input.slack_user_id, channel_id: input.channel_id });
  const dealOwner = resolveDealHubSpotOwner(input, contactOwner);
  const authorization = isHubSpotWriteAuthorized(input, contactOwner);
  if (!authorization.authorized) {
    return `Error: not authorized to write to HubSpot: ${authorization.reason}. No HubSpot deal was created.`;
  }

  const partial = {};
  try {
    const nameParts = splitFullName(input.contact, email);
    const companyName = String(input.company || '').trim();
    const inferred = inferCompanyFromEmail(email);

    const existingContact = await findContactByEmail(email);
    let contactRes = existingContact;
    if (!contactRes) {
      const contactProps = await validateHubSpotProperties('contacts', compactProperties({
        email,
        firstname: nameParts.firstname,
        lastname: nameParts.lastname,
        company: companyName,
        lead_source: leadSource,
        hubspot_owner_id: contactOwner.id,
      }));
      contactRes = await hubspotRequest('/crm/v3/objects/contacts', 'POST', { properties: contactProps });
    }
    const contactId = requireHubSpotObjectId(contactRes, existingContact ? 'HubSpot contact search' : 'HubSpot contact create');
    partial.contactId = contactId;

    const companyResult = await findOrCreateCompany(companyName, inferred.domain);
    const companyId = requireHubSpotObjectId(companyResult.record, companyResult.created ? 'HubSpot company create' : 'HubSpot company search');
    partial.companyId = companyId;

    const dealName = input.dealname || `${companyName} - New Deal`;
    const dealProps = await validateHubSpotProperties('deals', compactProperties({
      dealname: dealName,
      pipeline: TRUEWIND_HUBSPOT.pipeline,
      dealstage: input.dealstage || TRUEWIND_HUBSPOT.mqlDealStage,
      hubspot_owner_id: dealOwner.id,
      deal_source: leadSource,
    }));
    const dealRes = await hubspotRequest('/crm/v3/objects/deals', 'POST', { properties: dealProps });
    const dealId = requireHubSpotObjectId(dealRes, 'HubSpot deal create');
    partial.dealId = dealId;

    await Promise.all([
      createHubSpotAssociation('contacts', contactId, 'companies', companyId, TRUEWIND_HUBSPOT.contactToCompanyAssociationTypeId),
      createHubSpotAssociation('deals', dealId, 'contacts', contactId, TRUEWIND_HUBSPOT.dealToContactAssociationTypeId),
      createHubSpotAssociation('deals', dealId, 'companies', companyId, TRUEWIND_HUBSPOT.dealToCompanyAssociationTypeId),
    ]);

    let noteSummary = null;
    const noteBody = buildDealNoteBody(input);
    if (noteBody) {
      try {
        const note = await createStructuredDealNote({
          dealId,
          contactId,
          companyId,
          body: noteBody,
        });
        noteSummary = note?.id ? { id: String(note.id) } : { error: 'HubSpot note create succeeded but did not return a note ID' };
      } catch (err) {
        console.error(`Structured deal note create failed: ${err.message}`);
        noteSummary = { error: err.message };
      }
    }

    const dealUrl = hubspotRecordUrl('0-3', dealId);
    const contactUrl = hubspotRecordUrl('0-1', contactId);
    const companyUrl = hubspotRecordUrl('0-2', companyId);
    const lines = [
      `:white_check_mark: Deal created: ${dealName}`,
      `Deal ID: ${dealId}`,
      `Deal link: ${dealUrl}`,
      `Contact ID: ${contactId}`,
      `Contact link: ${contactUrl}`,
      `Company ID: ${companyId}`,
      `Company link: ${companyUrl}`,
    ];
    if (noteSummary?.id) {
      lines.push(`Note added to deal: ${noteSummary.id}`);
    } else if (noteSummary?.error) {
      lines.push(`! Note was not added: ${noteSummary.error}`);
    }
    return lines.join('\n');
  } catch (err) {
    return `Error: ${err.message}\nNo completion claimed.${partial.dealId ? `\nDeal ID: ${partial.dealId}` : ''}${partial.contactId ? `\nContact ID: ${partial.contactId}` : ''}${partial.companyId ? `\nCompany ID: ${partial.companyId}` : ''}`;
  }
}

function shouldSetLifecycleToOpportunity(currentLifecycleStage) {
  const current = String(currentLifecycleStage || '').toLowerCase();
  if (!current) return true;
  const order = ['subscriber', 'lead', 'marketingqualifiedlead', 'salesqualifiedlead', 'opportunity', 'customer'];
  const currentIndex = order.indexOf(current);
  const opportunityIndex = order.indexOf('opportunity');
  return currentIndex === -1 || currentIndex <= opportunityIndex;
}

function formatProspectWorkflowResponse(summary) {
  const contactOwner = summary.contactOwner || summary.owner || {};
  const dealOwner = summary.dealOwner || summary.owner || contactOwner;
  const linkedinLine = summary.linkedinUrl
    ? `✓ LinkedIn found: ${summary.linkedinUrl}`
    : `✓ LinkedIn found: not found; used email/company fallback${summary.linkedinError ? ` (${summary.linkedinError})` : ''}`;
  const title = summary.contact.jobtitle ? `, ${summary.contact.jobtitle}` : '';
  const contactUrl = hubspotRecordUrl('0-1', summary.contact.id);
  const dealUrl = hubspotRecordUrl('0-3', summary.deal.id);
  const companyUrl = hubspotRecordUrl('0-2', summary.company.id);
  const lines = [
    linkedinLine,
    `✓ Contact created/updated: ${summary.contact.name}${title} at ${summary.company.name} (ID: ${summary.contact.id})`,
    `Contact link: ${contactUrl}`,
    `✓ Deal ${summary.deal.created ? 'created' : 'matched'}: ${summary.deal.name} (ID: ${summary.deal.id})`,
    `Deal link: ${dealUrl}`,
    `✓ Company ${summary.company.created ? 'created' : 'matched'}: ${summary.company.name} (ID: ${summary.company.id})`,
    `Company link: ${companyUrl}`,
    `✓ Lead source: ${summary.leadSource}`,
  ];
  if (contactOwner.name && dealOwner.name && (contactOwner.id !== dealOwner.id || contactOwner.name !== dealOwner.name)) {
    lines.splice(-1, 0, `✓ Contact owner: ${contactOwner.name} (${contactOwner.source})`);
    lines.splice(-1, 0, `✓ Deal owner: ${dealOwner.name} (${dealOwner.source})`);
  } else if (dealOwner.name || contactOwner.name) {
    const owner = dealOwner.name ? dealOwner : contactOwner;
    lines.splice(-1, 0, `✓ Owner: ${owner.name} (${owner.source})`);
  }
  if (summary.note?.id) {
    lines.push(`✓ Note added to deal: ${summary.note.id}`);
  } else if (summary.note?.error) {
    lines.push(`! Note was not added: ${summary.note.error}`);
  }
  return lines.join('\n');
}

async function runTruewindHubSpotProspectWorkflow(input) {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) {
    return 'Missing required email. Please provide a valid prospect email address before I push this to HubSpot.';
  }

  const context = input.context || input.context_text || input.notes || '';
  const leadSource = normalizeExplicitDealSource(input);
  if (!leadSource) {
    return missingDealSourceMessage();
  }
  const parsedName = parseNameFromEmail(email);
  const inferred = inferCompanyFromEmail(email);
  const contactOwner = await resolveRequesterHubSpotOwnerForProspect(input);
  const dealOwner = resolveDealHubSpotOwner(input, contactOwner);
  const authorization = isHubSpotWriteAuthorized(input, contactOwner);
  if (!authorization.authorized) {
    return `Not authorized to write to HubSpot: ${authorization.reason}. Ask an admin to set HUBSPOT_WRITE_ALLOWED_SLACK_USER_IDS or HUBSPOT_WRITE_ALLOWED_SLACK_CHANNEL_IDS, or map your Slack account to a HubSpot owner.`;
  }
  const erp = input.erp || '';
  const noteBody = buildDealNoteBody(input);

  let linkedin = { found: false, candidates: [] };
  if (input.linkedin_url) {
    linkedin = { found: true, url: normalizeLinkedInUrl(input.linkedin_url), profile: {} };
  } else {
    linkedin = await findLinkedInEnrichment({
      email,
      firstname: input.firstname || parsedName.firstname,
      lastname: input.lastname || parsedName.lastname,
    });
    if (linkedin.needsDisambiguation) {
      return [
        'Multiple possible LinkedIn profiles matched. Please reply with the correct URL:',
        ...linkedin.candidates.map((candidate, index) => `${index + 1}. ${candidate.title || candidate.url} - ${candidate.url}`),
      ].join('\n');
    }
  }

  const firstname = input.firstname || linkedin.profile?.firstname || parsedName.firstname;
  const lastname = input.lastname || linkedin.profile?.lastname || parsedName.lastname;
  const jobtitle = input.jobtitle || linkedin.profile?.jobtitle || '';
  const companyName = input.company || linkedin.profile?.company || inferred.company;
  const companyDomain = inferred.domain;

  if (!companyName) {
    return `I found the email (${email}) but could not determine the company from LinkedIn or the email domain. Please provide the company name.`;
  }

  const partial = { linkedinUrl: linkedin.url || '' };
  try {
    const linkedinProperties = await getExistingContactProperties(
      ['linkedin___profile', 'hs_linkedin_url', 'linkedin_profile_url'],
      ['linkedin___profile', 'hs_linkedin_url']
    );
    const linkedinProps = Object.fromEntries(linkedinProperties.map((propertyName) => [propertyName, linkedin.url || '']));
    const contactType = await resolveContactTypeValue();
    const baseContactProps = compactProperties({
      email,
      firstname,
      lastname,
      jobtitle,
      company: companyName,
      contact_type: contactType,
      erp,
      lead_source: leadSource,
      hubspot_owner_id: contactOwner.id,
      ...linkedinProps,
    });

    const existingContact = await findContactByEmail(email);
    const explicitKeys = new Set([
      ...['firstname', 'lastname', 'jobtitle', 'company', 'erp', 'lead_source'].filter((key) => input[key]),
      ...linkedinProperties.filter(() => input.linkedin_url),
    ]);
    const contactProps = existingContact
      ? mergeExistingContactUpdate({
          proposed: baseContactProps,
          existingProperties: existingContact.properties || {},
          explicitKeys,
        })
      : {
          ...baseContactProps,
          lifecyclestage: 'lead',
          hs_lead_status: TRUEWIND_HUBSPOT.defaultLeadStatus,
        };

    let contactRes;
    if (existingContact && Object.keys(contactProps).length === 0) {
      contactRes = existingContact;
    } else if (existingContact) {
      const validatedContactProps = await validateHubSpotProperties('contacts', contactProps);
      contactRes = await hubspotRequest(`/crm/v3/objects/contacts/${encodeURIComponent(existingContact.id)}`, 'PATCH', { properties: validatedContactProps });
    } else {
      const validatedContactProps = await validateHubSpotProperties('contacts', contactProps);
      contactRes = await hubspotRequest('/crm/v3/objects/contacts', 'POST', { properties: validatedContactProps });
    }
    const contactId = requireHubSpotObjectId(contactRes, existingContact ? 'HubSpot contact update' : 'HubSpot contact create');
    partial.contactId = contactId;

    const companyResult = await findOrCreateCompany(companyName, companyDomain);
    const companyId = requireHubSpotObjectId(companyResult.record, companyResult.created ? 'HubSpot company create' : 'HubSpot company search');
    partial.companyId = companyId;

    const dealName = input.dealname || `${companyName} - New Deal`;
    const dealProps = compactProperties({
      dealname: dealName,
      pipeline: TRUEWIND_HUBSPOT.pipeline,
      dealstage: TRUEWIND_HUBSPOT.mqlDealStage,
      hubspot_owner_id: dealOwner.id,
      deal_source: leadSource,
      erp,
      amount: input.amount === undefined || input.amount === null ? '' : String(input.amount),
      closedate: input.closedate || '',
    });
    const validatedDealProps = await validateHubSpotProperties('deals', dealProps);
    const existingDeal = await findExistingDeal(dealName);
    const dealRes = existingDeal || await hubspotRequest('/crm/v3/objects/deals', 'POST', { properties: validatedDealProps });
    const dealId = requireHubSpotObjectId(dealRes, 'HubSpot deal create');
    partial.dealId = dealId;

    await createHubSpotAssociation('contacts', contactId, 'companies', companyId, TRUEWIND_HUBSPOT.contactToCompanyAssociationTypeId);
    await createHubSpotAssociation('deals', dealId, 'contacts', contactId, TRUEWIND_HUBSPOT.dealToContactAssociationTypeId);
    await createHubSpotAssociation('deals', dealId, 'companies', companyId, TRUEWIND_HUBSPOT.dealToCompanyAssociationTypeId);

    let noteSummary = null;
    if (noteBody) {
      try {
        const note = await createStructuredDealNote({
          dealId,
          contactId,
          companyId,
          body: noteBody,
        });
        noteSummary = note?.id ? { id: String(note.id) } : { error: 'HubSpot note create succeeded but did not return a note ID' };
      } catch (err) {
        console.error(`Prospect deal note create failed: ${err.message}`);
        noteSummary = { error: err.message };
      }
    }

    const conversionProps = { hs_lead_status: TRUEWIND_HUBSPOT.convertedLeadStatus };
    if (shouldSetLifecycleToOpportunity(existingContact?.properties?.lifecyclestage)) {
      conversionProps.lifecyclestage = 'opportunity';
    }
    const validatedConversionProps = await validateHubSpotProperties('contacts', conversionProps);
    await hubspotRequest(`/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, 'PATCH', {
      properties: validatedConversionProps,
    });

    return formatProspectWorkflowResponse({
      linkedinUrl: linkedin.url || '',
      linkedinError: linkedin.error || '',
      contact: {
        id: contactId,
        name: [firstname, lastname].filter(Boolean).join(' ') || email,
        jobtitle,
      },
      company: {
        id: companyId,
        name: companyName,
        created: companyResult.created,
      },
      deal: {
        id: dealId,
        name: dealName,
        created: !existingDeal,
      },
      contactOwner,
      dealOwner,
      leadSource,
      note: noteSummary,
    });
  } catch (err) {
    return formatWorkflowError(err, partial);
  }
}

// ============================================================
// Tool definitions for Claude
// ============================================================
const TOOLS = [
  // --- Google Sheets tools ---
  {
    name: 'read_spreadsheet',
    description: 'Read data from a Google Spreadsheet. Use this to check existing content before adding rows.',
    input_schema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'The spreadsheet ID from the URL' },
        range: { type: 'string', description: 'A1 notation range, e.g. "Sheet1!A1:Z100"' },
      },
      required: ['spreadsheet_id', 'range'],
    },
  },
  {
    name: 'append_rows',
    description: 'Append rows to the bottom of a Google Spreadsheet. Each row is an array of cell values.',
    input_schema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'The spreadsheet ID from the URL' },
        range: { type: 'string', description: 'A1 notation for the target sheet/range, e.g. "Sheet1!A:Z"' },
        rows: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'Array of rows, each row is an array of cell values',
        },
      },
      required: ['spreadsheet_id', 'range', 'rows'],
    },
  },
  {
    name: 'update_cells',
    description: 'Update specific cells in a Google Spreadsheet.',
    input_schema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string', description: 'The spreadsheet ID from the URL' },
        range: { type: 'string', description: 'A1 notation range to update, e.g. "Sheet1!A5:C5"' },
        values: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'Array of rows with cell values to write',
        },
      },
      required: ['spreadsheet_id', 'range', 'values'],
    },
  },
  // --- HubSpot tools ---
  {
    name: 'hubspot_search',
    description: 'Search HubSpot CRM objects (contacts, companies, deals, meetings). Returns matching records with requested properties.',
    input_schema: {
      type: 'object',
      properties: {
        object_type: { type: 'string', description: 'CRM object type: contacts, companies, deals, meetings, calls, emails, notes, tasks' },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              propertyName: { type: 'string' },
              operator: { type: 'string', description: 'EQ, NEQ, GT, GTE, LT, LTE, CONTAINS_TOKEN, etc.' },
              value: { type: 'string' },
            },
          },
          description: 'Array of filter objects',
        },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Properties to return, e.g. ["firstname", "lastname", "email"]',
        },
        sorts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              propertyName: { type: 'string' },
              direction: { type: 'string', description: 'ASCENDING or DESCENDING' },
            },
          },
          description: 'Optional sort order',
        },
        limit: { type: 'number', description: 'Max results (default 10, max 100)' },
      },
      required: ['object_type', 'properties'],
    },
  },
  {
    name: 'hubspot_get',
    description: 'Get a specific HubSpot CRM record by ID with requested properties.',
    input_schema: {
      type: 'object',
      properties: {
        object_type: { type: 'string', description: 'CRM object type: contacts, companies, deals, meetings' },
        object_id: { type: 'string', description: 'The record ID' },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Properties to return',
        },
      },
      required: ['object_type', 'object_id', 'properties'],
    },
  },
  {
    name: 'hubspot_list_owners',
    description: 'List all HubSpot owners (users/team members). Use this to map owner IDs to names.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'hubspot_get_pipeline',
    description: 'Get HubSpot pipeline configuration with stage names and IDs.',
    input_schema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string', description: 'Pipeline ID (default: 105321581 for Active Pipeline)' },
      },
    },
  },
  {
    name: 'hubspot_count_deals_entered_stage',
    description: 'Count deals that entered a specific HubSpot deal stage during a date range using dealstage property history. Use this for stage cohort questions such as "how many SQLs did we have in January" including deals that later moved past that stage.',
    input_schema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string', description: 'Pipeline ID (default: Active Pipeline 105321581)' },
        stage_id: { type: 'string', description: 'Exact HubSpot stage ID from hubspot_get_pipeline, e.g. SQL stage ID.' },
        start_date: { type: 'string', description: 'Inclusive start date/time. Use ISO with timezone for business-month boundaries, e.g. 2026-02-01T00:00:00-08:00, or YYYY-MM-DD for Pacific midnight.' },
        end_date: { type: 'string', description: 'Exclusive end date/time. Use ISO with timezone for business-month boundaries, e.g. 2026-03-01T00:00:00-08:00, or YYYY-MM-DD for Pacific midnight.' },
        max_deals: { type: 'number', description: 'Safety cap for pipeline deals scanned (default 10000, max 10000). coverage.warning is set if truncated.' },
        track_outcomes: {
          type: 'object',
          description: 'Optional cohort outcome tracking. Use this to answer questions like "of deals that entered SQL in January, how many later became Won or Closed/Lost?" Outcomes are classified by the first tracked outcome stage entered after the cohort entry event.',
          properties: {
            stages: {
              type: 'array',
              items: { type: 'string' },
              description: 'Outcome stage IDs to track, e.g. ["1166230571", "190380587"] for Won and Closed/Lost.',
            },
            as_of_date: {
              type: 'string',
              description: 'Optional cutoff. YYYY-MM-DD means through that Pacific business date using an exclusive next-midnight Pacific cutoff; ISO date/time with timezone means up to that exact instant.',
            },
            include_deal_details: {
              type: 'boolean',
              description: 'When true, include deal-level details grouped by outcome in addition to counts and IDs.',
            },
          },
        },
      },
      required: ['stage_id', 'start_date', 'end_date'],
    },
  },
  {
    name: 'hubspot_analyze_deal_activities',
    description: 'Analyze HubSpot activities across deals in a pipeline to find no-shows, ghosted deals, missed meetings, or other activity text patterns. Scans associated meetings, calls, notes, and emails for keywords and returns matching deal/activity context with coverage metadata.',
    input_schema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string', description: 'Pipeline ID (default: Active Pipeline 105321581).' },
        activity_keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords or phrases to search. Defaults to no-show patterns: no-show, no show, didn\'t show, missed, did not attend.',
        },
        max_deals: { type: 'number', description: 'Safety cap for pipeline deals scanned (default 500, max 500). coverage.warning is set if truncated.' },
        max_activities_per_type: { type: 'number', description: 'Safety cap per activity type per deal (default 100, max 500).' },
        activity_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Activity types to scan. Defaults to meetings, calls, notes, and emails.',
        },
      },
    },
  },
  {
    name: 'hubspot_push_truewind_prospect',
    description: 'End-to-end Truewind HubSpot workflow. Use this when asked to push/add/create a prospect, lead, opportunity, or new deal in HubSpot. It requires email and explicit lead_source/deal source, enriches LinkedIn via Firecrawl, creates/updates contact first, creates the MQL deal, creates all required associations, creates a HubSpot note associated to the deal/contact/company when notes are supplied, sets contact lifecycle to opportunity and lead status internal value MQL, and returns exact IDs. If the user did not provide a source, ask for it before calling this tool.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Prospect email. Required.' },
        context: { type: 'string', description: 'Original Slack request and relevant thread context for lead source deduction.' },
        channel_id: { type: 'string', description: 'Slack channel_id from Slack metadata for write authorization, if available.' },
        slack_user_id: { type: 'string', description: 'Slack user_id from Slack metadata for owner mapping, if available.' },
        owner_name: { type: 'string', description: 'Explicit owner name only if the user specified one.' },
        firstname: { type: 'string', description: 'Optional first name if already known.' },
        lastname: { type: 'string', description: 'Optional last name if already known.' },
        company: { type: 'string', description: 'Optional company name if already known or if email domain is generic.' },
        jobtitle: { type: 'string', description: 'Optional title if already known.' },
        linkedin_url: { type: 'string', description: 'Optional LinkedIn profile URL if the user already supplied it or selected a disambiguated match.' },
        erp: { type: 'string', description: 'Optional ERP value. Leave unset unless specified.' },
        lead_source: { type: 'string', description: 'Required explicit lead/deal source from the user. Do not infer or default it. Valid values: Outbound - Sales Sourced List, Event, In-Person Socials, Webinar, PR, Self serve, Referral, Inbound - Direct.' },
        type: { type: 'string', description: 'Optional deal/prospect type if specified by the user. Included in the HubSpot note when present.' },
        meeting_booked: { type: 'string', description: 'Optional meeting booked date/time text if specified by the user. Included in the HubSpot note when present.' },
        notes: { type: 'string', description: 'Optional notes from the user request. Pass the full note text exactly; the workflow creates a HubSpot note associated to the deal, contact, and company.' },
        amount: { type: 'number', description: 'Optional deal amount if specified.' },
        closedate: { type: 'string', description: 'Optional close date if specified, in HubSpot-compatible date format.' },
      },
      required: ['email', 'lead_source'],
    },
  },
  // --- HubSpot write tools ---
  {
    name: 'hubspot_create_contact',
    description: 'Create a new contact in HubSpot. Returns the new contact ID and properties.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Contact email address (required)' },
        firstname: { type: 'string', description: 'First name' },
        lastname: { type: 'string', description: 'Last name' },
        company: { type: 'string', description: 'Company name' },
        jobtitle: { type: 'string', description: 'Job title' },
        phone: { type: 'string', description: 'Phone number' },
        context: { type: 'string', description: 'Original Slack request/context for write authorization.' },
        channel_id: { type: 'string', description: 'Slack channel ID for write authorization.' },
        slack_user_id: { type: 'string', description: 'Slack user ID for write authorization.' },
        properties: {
          type: 'object',
          description: 'Writable contact properties as key-value pairs (e.g. lifecyclestage, contact_type, hubspot_owner_id, linkedin___profile, lead_source, enterprise_smb_industry). Do not include HubSpot read-only/system fields.',
        },
      },
      required: ['email'],
    },
  },
  {
    name: 'hubspot_update_contact',
    description: 'Update an existing HubSpot contact by ID.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'The contact ID to update' },
        context: { type: 'string', description: 'Original Slack request/context for write authorization.' },
        channel_id: { type: 'string', description: 'Slack channel ID for write authorization.' },
        slack_user_id: { type: 'string', description: 'Slack user ID for write authorization.' },
        properties: {
          type: 'object',
          description: 'Properties to update as key-value pairs',
        },
      },
      required: ['contact_id', 'properties'],
    },
  },
  {
    name: 'hubspot_create_deal',
    description: 'Create a new deal in HubSpot. Requires explicit deal_source from the user. If the user did not provide a source, ask for it before calling this tool. Active Pipeline ID is 105321581. Stages: MQL=1307720553, SQL=190380582, Full Product Demo=190380583, POC=190380586, Proposal=190380584, Won=1166230571, Closed/Lost=190380587.',
    input_schema: {
      type: 'object',
      properties: {
        dealname: { type: 'string', description: 'Deal name' },
        pipeline: { type: 'string', description: 'Pipeline ID (default: Active Pipeline 105321581)' },
        dealstage: { type: 'string', description: 'Stage ID' },
        deal_source: { type: 'string', description: 'Required explicit deal source from the user. Do not infer or default it. Valid values: Outbound - Sales Sourced List, Event, In-Person Socials, Webinar, PR, Self serve, Referral, Inbound - Direct.' },
        amount: { type: 'number', description: 'Deal amount' },
        context: { type: 'string', description: 'Original Slack request/context for write authorization.' },
        channel_id: { type: 'string', description: 'Slack channel ID for write authorization.' },
        slack_user_id: { type: 'string', description: 'Slack user ID for write authorization.' },
        properties: {
          type: 'object',
          description: 'Writable deal properties (e.g. hubspot_owner_id, closedate). Do not include deal_source here; pass it as the top-level required deal_source field. Do not include HubSpot read-only/system fields such as hs_deal_stage_probability_shadow, notes_last_updated, or hs_object_source_detail_1.',
        },
      },
      required: ['dealname', 'dealstage', 'deal_source'],
    },
  },
  {
    name: 'hubspot_update_deal',
    description: 'Update an existing HubSpot deal by ID.',
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string', description: 'The deal ID to update' },
        context: { type: 'string', description: 'Original Slack request/context for write authorization.' },
        channel_id: { type: 'string', description: 'Slack channel ID for write authorization.' },
        slack_user_id: { type: 'string', description: 'Slack user ID for write authorization.' },
        properties: {
          type: 'object',
          description: 'Properties to update as key-value pairs',
        },
      },
      required: ['deal_id', 'properties'],
    },
  },
  {
    name: 'hubspot_create_association',
    description: 'Associate two HubSpot records. Common type IDs: contact_to_company=279, deal_to_contact=3, deal_to_company=341, contact_to_deal=4.',
    input_schema: {
      type: 'object',
      properties: {
        from_type: { type: 'string', description: 'Source object type (contacts, companies, deals)' },
        from_id: { type: 'string', description: 'Source object ID' },
        to_type: { type: 'string', description: 'Target object type (contacts, companies, deals)' },
        to_id: { type: 'string', description: 'Target object ID' },
        association_type_id: { type: 'number', description: 'Association type ID (e.g. 279 for contact_to_company)' },
        context: { type: 'string', description: 'Original Slack request/context for write authorization.' },
        channel_id: { type: 'string', description: 'Slack channel ID for write authorization.' },
        slack_user_id: { type: 'string', description: 'Slack user ID for write authorization.' },
      },
      required: ['from_type', 'from_id', 'to_type', 'to_id', 'association_type_id'],
    },
  },
  {
    name: 'hubspot_create_note',
    description: 'Create a HubSpot note and associate it to an existing deal, contact, and/or company. Use this when the user asks to add notes to an existing HubSpot record. HubSpot notes do not have reliable standalone record URLs, so return the attached record URL instead.',
    input_schema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Full note text to write to HubSpot.' },
        deal_id: { type: 'string', description: 'Optional HubSpot deal ID to attach the note to.' },
        contact_id: { type: 'string', description: 'Optional HubSpot contact ID to attach the note to.' },
        company_id: { type: 'string', description: 'Optional HubSpot company ID to attach the note to.' },
        context: { type: 'string', description: 'Original Slack request/context for write authorization.' },
        channel_id: { type: 'string', description: 'Slack channel ID for write authorization.' },
        slack_user_id: { type: 'string', description: 'Slack user ID for write authorization.' },
      },
      required: ['body'],
    },
  },
  {
    name: 'hubspot_get_associations',
    description: 'Get associations for a HubSpot record (e.g. find all deals for a contact).',
    input_schema: {
      type: 'object',
      properties: {
        from_type: { type: 'string', description: 'Source object type (contacts, companies, deals)' },
        from_id: { type: 'string', description: 'Source object ID' },
        to_type: { type: 'string', description: 'Target object type (contacts, companies, deals)' },
      },
      required: ['from_type', 'from_id', 'to_type'],
    },
  },
  {
    name: 'hubspot_get_associated_activities',
    description: 'Get HubSpot meetings, calls, emails, notes, and tasks associated to a deal. Use this for deal notes or summarize-the-deal requests before synthesizing the recap.',
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string', description: 'HubSpot deal ID' },
        activity_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional activity types. Defaults to meetings, calls, emails, notes, and tasks.',
        },
        limit_per_type: { type: 'number', description: 'Max associated records to fetch per activity type (default 500, max 500). The response includes coverage.truncated if this cap is reached.' },
      },
      required: ['deal_id'],
    },
  },
  // --- Recruiting calendar tools ---
  {
    name: 'recruiting_list_outstanding_candidates',
    description: 'List outstanding candidates from the Notion ATS. Use for recruiting pipeline, hiring pipeline, outstanding candidates, active candidates, or candidates needing review in #hiring-review. This is separate from the HubSpot sales pipeline.',
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: 'active lists all non-terminal candidates excluding Reject Pending. awaiting_decision lists new applicant review candidates only. Default active.',
        },
        role: { type: 'string', description: 'Optional role filter such as AE, BDR, or Growth Generalist.' },
        status: { type: 'string', description: 'Optional exact status filter.' },
        limit: { type: 'number', description: 'Max candidates to return. Default 25, max 100.' },
      },
    },
  },
  {
    name: 'recruiting_create_calendar_invite',
    description: 'Create a Google Calendar invite with Google Meet for a recruiting interview. Use only when the Slack user asks to schedule/book a recruiting interview or first-round call and provides a concrete candidate email plus exact date/time. If the user gives a natural-language time, convert it to ISO with timezone before calling. Ask for missing email or exact time before using this tool. If no title or Gmail subject is supplied, the tool attempts to infer the title from the Notion ATS candidate role and name.',
    input_schema: {
      type: 'object',
      properties: {
        candidate_email: { type: 'string', description: 'Candidate email address. Required.' },
        candidate_name: { type: 'string', description: 'Candidate name when known.' },
        start_datetime: { type: 'string', description: 'Interview start as ISO datetime with timezone, e.g. 2026-05-28T14:00:00-07:00. Required.' },
        end_datetime: { type: 'string', description: 'Optional end as ISO datetime with timezone. Omit to use duration_minutes.' },
        duration_minutes: { type: 'number', description: 'Duration when end_datetime is omitted. Default 20.' },
        title: { type: 'string', description: 'Optional calendar title. Use the Gmail email subject when available; the tool removes [hiring@] and reply prefixes.' },
        email_subject: { type: 'string', description: 'Original Gmail thread/email subject. Preferred source for the calendar title; [hiring@], Re:, and Fwd: prefixes are removed.' },
        description: { type: 'string', description: 'Optional event description.' },
        timezone: { type: 'string', description: 'IANA timezone for display, default America/Los_Angeles.' },
        calendar_id: { type: 'string', description: 'Calendar ID. Defaults to RECRUITING_CALENDAR_ID, GOOGLE_CALENDAR_DEFAULT_CALENDAR_ID, then primary.' },
        send_updates: { type: 'string', description: 'Google notification behavior: all, externalOnly, or none. Default all.' },
        with_meet: { type: 'boolean', description: 'Whether to create a Google Meet link. Default true.' },
        extra_attendees: { type: 'array', items: { type: 'string' }, description: 'Optional additional attendee emails.' },
      },
      required: ['candidate_email', 'start_datetime'],
    },
  },
  // --- Grain tools ---
  {
    name: 'grain_list_recordings',
    description: 'List recent Grain recordings with titles, dates, participants, IDs, and transcript links.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max recordings to return (default 10, max 50)' },
      },
    },
  },
  {
    name: 'grain_search_recordings',
    description: 'Search Grain recordings by company name, participant email, and/or date range. Use this for deal notes and deal summaries to find all relevant customer recordings before calling grain_get_recording for each match.',
    input_schema: {
      type: 'object',
      properties: {
        company_name: { type: 'string', description: 'Company or account name to match against recording titles, event metadata, and participants.' },
        participant_email: { type: 'string', description: 'Participant email to match exactly against Grain participants.' },
        date_range: {
          type: 'object',
          properties: {
            start_date: { type: 'string', description: 'Optional inclusive start date/time.' },
            end_date: { type: 'string', description: 'Optional inclusive end date/time.' },
          },
          description: 'Optional date range for recordings.',
        },
        limit: { type: 'number', description: 'Max matches to return (default 25, max 50)' },
        max_pages: { type: 'number', description: 'Optional max Grain recording-list pages to scan. The response includes coverage.truncated if the scan hits this cap.' },
      },
    },
  },
  {
    name: 'grain_get_recording',
    description: 'Get full details of a Grain recording including summary, participants, transcript, and transcript link.',
    input_schema: {
      type: 'object',
      properties: {
        recording_id: { type: 'string', description: 'The Grain recording ID' },
      },
      required: ['recording_id'],
    },
  },
];

// ============================================================
// Tool execution
// ============================================================
function stripInternalToolInput(input = {}) {
  return Object.fromEntries(
    Object.entries(input || {}).filter(([key]) => !String(key).startsWith('__'))
  );
}

async function executeTool(name, input = {}, runtimeContext = {}) {
  try {
    const toolInput = {
      ...stripInternalToolInput(input),
      __trusted_slack_metadata: {
        channel_id: runtimeContext.channel_id || '',
        slack_user_id: runtimeContext.slack_user_id || '',
        thread_ts: runtimeContext.thread_ts || '',
      },
      ...(runtimeContext.calendar_service ? { __calendar_service: runtimeContext.calendar_service } : {}),
      ...(runtimeContext.notion_request ? { __notion_request: runtimeContext.notion_request } : {}),
    };
    const hubspotWriteTools = new Set([
      'hubspot_create_contact',
      'hubspot_update_contact',
      'hubspot_create_deal',
      'hubspot_update_deal',
      'hubspot_create_association',
      'hubspot_create_note',
    ]);
    if (hubspotWriteTools.has(name)) {
      const authorization = isHubSpotWriteAuthorized(input, resolveHubSpotOwner(input));
      if (!authorization.authorized) {
        return `Error: not authorized to write to HubSpot: ${authorization.reason}`;
      }
    }

    // --- Google Sheets ---
    if (name === 'read_spreadsheet') {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: input.spreadsheet_id,
        range: input.range,
      });
      return JSON.stringify(res.data.values || []);
    }
    if (name === 'append_rows') {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId: input.spreadsheet_id,
        range: input.range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: input.rows },
      });
      return `Appended ${res.data.updates.updatedRows} row(s)`;
    }
    if (name === 'update_cells') {
      const res = await sheets.spreadsheets.values.update({
        spreadsheetId: input.spreadsheet_id,
        range: input.range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: input.values },
      });
      return `Updated ${res.data.updatedCells} cell(s)`;
    }

    // --- HubSpot ---
    if (name === 'hubspot_search') {
      const body = {
        properties: input.properties,
        limit: input.limit || 10,
      };
      if (input.filters && input.filters.length > 0) {
        body.filterGroups = [{ filters: input.filters }];
      }
      if (input.sorts) body.sorts = input.sorts;
      const res = await hubspotRequest(`/crm/v3/objects/${input.object_type}/search`, 'POST', body);
      return JSON.stringify({ total: res.total, results: (res.results || []).map(r => ({ id: r.id, ...r.properties })) });
    }
    if (name === 'hubspot_get') {
      const props = input.properties.join(',');
      const res = await hubspotRequest(`/crm/v3/objects/${input.object_type}/${input.object_id}?properties=${props}`);
      return JSON.stringify({ id: res.id, ...res.properties });
    }
    if (name === 'hubspot_list_owners') {
      const res = await hubspotRequest('/crm/v3/owners/?limit=100');
      const owners = (res.results || []).map(o => ({ id: o.id, email: o.email, firstName: o.firstName, lastName: o.lastName }));
      return JSON.stringify(owners);
    }
    if (name === 'hubspot_get_pipeline') {
      const res = await hubspotRequest(hubSpotPipelineEndpoint(input.pipeline_id));
      return JSON.stringify({
        id: res.id,
        label: res.label,
        displayOrder: res.displayOrder,
        stages: res.stages || [],
      });
    }
    if (name === 'hubspot_count_deals_entered_stage') {
      const result = await countHubSpotDealsEnteredStage(input);
      return JSON.stringify(result);
    }
    if (name === 'hubspot_analyze_deal_activities') {
      const result = await analyzeHubSpotDealActivities(input);
      return JSON.stringify(result);
    }
    if (name === 'hubspot_push_truewind_prospect') {
      return await runTruewindHubSpotProspectWorkflow(input);
    }

    // --- HubSpot write ---
    if (name === 'hubspot_create_contact') {
      const props = { email: input.email };
      if (input.firstname) props.firstname = input.firstname;
      if (input.lastname) props.lastname = input.lastname;
      if (input.company) props.company = input.company;
      if (input.jobtitle) props.jobtitle = input.jobtitle;
      if (input.phone) props.phone = input.phone;
      if (input.properties) Object.assign(props, input.properties);
      const validatedProps = await validateHubSpotProperties('contacts', props);
      const res = await hubspotRequest('/crm/v3/objects/contacts', 'POST', { properties: validatedProps });
      return JSON.stringify(formatHubSpotObjectResponse(res, '0-1'));
    }
    if (name === 'hubspot_update_contact') {
      const contactId = encodeURIComponent(input.contact_id);
      const validatedProps = await validateHubSpotProperties('contacts', input.properties || {});
      const res = await hubspotRequest(`/crm/v3/objects/contacts/${contactId}`, 'PATCH', { properties: validatedProps });
      return JSON.stringify(formatHubSpotObjectResponse(res, '0-1'));
    }
    if (name === 'hubspot_create_deal') {
      const dealSource = normalizeExplicitDealSource(input);
      if (!dealSource) {
        return `Error: ${missingDealSourceMessage()}`;
      }
      const props = { dealname: input.dealname, dealstage: input.dealstage, pipeline: input.pipeline || '105321581', deal_source: dealSource };
      if (input.amount) props.amount = String(input.amount);
      if (input.properties) Object.assign(props, input.properties);
      props.deal_source = dealSource;
      const validatedProps = await validateHubSpotProperties('deals', props);
      const res = await hubspotRequest('/crm/v3/objects/deals', 'POST', { properties: validatedProps });
      return JSON.stringify(formatHubSpotObjectResponse(res, '0-3'));
    }
    if (name === 'hubspot_update_deal') {
      const dealId = encodeURIComponent(input.deal_id);
      const validatedProps = await validateHubSpotProperties('deals', input.properties || {});
      const res = await hubspotRequest(`/crm/v3/objects/deals/${dealId}`, 'PATCH', { properties: validatedProps });
      return JSON.stringify(formatHubSpotObjectResponse(res, '0-3'));
    }
    if (name === 'hubspot_create_association') {
      const res = await hubspotRequest(
        `/crm/v4/objects/${input.from_type}/${input.from_id}/associations/${input.to_type}/${input.to_id}`,
        'PUT',
        [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: input.association_type_id }]
      );
      return JSON.stringify(res);
    }
    if (name === 'hubspot_create_note') {
      if (!String(input.body || '').trim()) return 'Error: note body is required';
      if (!input.deal_id && !input.contact_id && !input.company_id) {
        return 'Error: provide at least one of deal_id, contact_id, or company_id';
      }
      const note = await createStructuredDealNote({
        dealId: input.deal_id,
        contactId: input.contact_id,
        companyId: input.company_id,
        body: escapeHubSpotNoteText(input.body).replace(/\r?\n/g, '<br>'),
      });
      const noteId = requireHubSpotObjectId(note, 'HubSpot note create');
      const attachedRecordUrl = hubspotPrimaryAssociatedRecordUrl({
        dealId: input.deal_id,
        contactId: input.contact_id,
        companyId: input.company_id,
      });
      return JSON.stringify({
        id: noteId,
        hubspot_id: noteId,
        url: attachedRecordUrl,
        attached_record_url: attachedRecordUrl,
        url_note: 'HubSpot notes are activities on CRM records; open the attached record URL to view the note.',
        deal_id: input.deal_id || '',
        contact_id: input.contact_id || '',
        company_id: input.company_id || '',
      });
    }
    if (name === 'hubspot_get_associations') {
      const res = await hubspotRequest(`/crm/v4/objects/${input.from_type}/${input.from_id}/associations/${input.to_type}`);
      return JSON.stringify(res.results || []);
    }
    if (name === 'hubspot_get_associated_activities') {
      const result = await getHubSpotAssociatedActivities(input);
      if (result.error) return `Error: ${result.error}`;
      return JSON.stringify(result);
    }
    if (name === 'recruiting_list_outstanding_candidates') {
      return await listRecruitingOutstandingCandidates(input);
    }
    if (name === 'recruiting_create_calendar_invite') {
      return await createRecruitingCalendarInvite(toolInput);
    }

    // --- Grain ---
    if (name === 'grain_list_recordings') {
      const limit = input.limit || 10;
      const res = await grainRequest(`/recordings?limit=${Math.min(limit, 50)}`);
      if (res.error) return `Error: ${res.error}`;
      const { items: recordings } = parseListItems(res);
      return JSON.stringify(recordings.map(recording => ({
        id: getGrainRecordingId(recording),
        title: getGrainRecordingTitle(recording),
        date: getGrainRecordingStartMs(recording) ? new Date(getGrainRecordingStartMs(recording)).toISOString() : '',
        participants: recording.participants || recording.attendees,
        transcript_url: getGrainRecordingUrl(recording),
      })));
    }
    if (name === 'grain_search_recordings') {
      const result = await searchGrainRecordings(input);
      if (result.error) return `Error: ${result.error}`;
      return JSON.stringify({
        searched: result.searched,
        search: result.search,
        coverage: result.coverage,
        results: result.matches.map(recording => ({
          id: getGrainRecordingId(recording),
          title: getGrainRecordingTitle(recording),
          date: getGrainRecordingStartMs(recording) ? new Date(getGrainRecordingStartMs(recording)).toISOString() : '',
          participants: recording.participants || recording.attendees,
          transcript_url: getGrainRecordingUrl(recording),
        })),
      });
    }
    if (name === 'grain_get_recording') {
      const detail = await fetchGrainRecordingDetail({ id: input.recording_id });
      if (detail.error) return `Error: ${detail.error}`;
      return JSON.stringify({
        ...detail,
        transcript_url: getGrainRecordingUrl(detail),
        transcript_text: formatGrainTranscriptText(detail),
      });
    }

    return `Unknown tool: ${name}`;
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// ============================================================
// Slack app setup
// ============================================================
const app = createSlackApp();

const INSTANTLY_POSITIVE_REPLY_CHANNEL = (
  process.env.INSTANTLY_POSITIVE_REPLY_SLACK_CHANNEL
  || INSTANTLY_POSITIVE_REPLY_DEFAULT_CHANNEL
);
const INSTANTLY_POSITIVE_REPLY_MENTION_USER_ID = (
  process.env.INSTANTLY_POSITIVE_REPLY_SLACK_MENTION_USER_ID
  || process.env.SLACK_USER_ID
  || ''
).trim();
const INSTANTLY_WEBHOOK_SECRET = (process.env.INSTANTLY_WEBHOOK_SECRET || '').trim();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_DEFAULT_MODEL = process.env.CLAUDE_MODEL_DEFAULT
  || process.env.CLAUDE_MODEL_SONNET
  || 'claude-sonnet-4-6';
const CLAUDE_HIGH_MODEL = process.env.CLAUDE_MODEL_HIGH
  || process.env.CLAUDE_MODEL_OPUS
  || 'claude-opus-4-1-20250805';
const CLAUDE_DIGEST_MODEL = process.env.CLAUDE_DIGEST_MODEL || CLAUDE_DEFAULT_MODEL;

const PRIORITY_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1RSdbMzBer3O5-dMExLsn3I3ZCCL8vNYMKWs44Z36hnI/edit?gid=0#gid=0';
const PRIORITY_SHEET_ID = '1RSdbMzBer3O5-dMExLsn3I3ZCCL8vNYMKWs44Z36hnI';

function getSystemPrompt() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  return `You are Truewind's internal AI assistant in Slack. You have tools for Google Sheets, HubSpot CRM, and Grain meeting transcripts. Use tools for action requests. If a tool is missing, unavailable, unauthorized, or returns an error, say exactly that.

## Accuracy
NEVER fabricate, hallucinate, or invent information. If you do not have real data from a tool call or explicit context to support a claim, say "I don't know" or "I don't have that information." Do not fill gaps with plausible-sounding details. Do not summarize, list, or describe things you cannot verify. If a question requires data you don't have access to, say exactly what is missing and why. Accuracy over completeness, always.

Today's date is ${today}. Never use em dashes.

## CRITICAL: When someone says "add to prio list" or "add to priority list"
You MUST do the following steps using your tools. Do NOT just summarize -- actually write to the sheet:
1. Use read_spreadsheet to read the current sheet and understand the structure
2. Use append_rows to add the new row
3. Respond with the confirmation message below

## Priority List
- Spreadsheet ID: ${PRIORITY_SHEET_ID}
- URL: ${PRIORITY_SHEET_URL}

## Column structure (5 columns, this exact order)
1. **Category** -- Be specific. NEVER write just "Marketing". Use one of: Sales Enablement, Product Marketing, Social Media, Content Marketing, Brand, Events, Demand Gen, PR / Comms, Partnerships Marketing, Customer Marketing. If none fit, write a specific descriptor.
2. **Urgency** -- High, Medium, or Low
3. **Description** -- MAX 150 CHARACTERS. Focus on the DELIVERABLE/ACTION ITEM, not the backstory. Write it as a clear, concise task. Do NOT summarize the conversation. Example: "Develop plan to maximize ROI from AI Native Accounting Foundation sponsorship (co-marketing, speaking slots, content partnerships)."
4. **Date Added** -- Use thread_date from the Slack metadata (date of original thread post), NOT today
5. **Slack link** -- Build from metadata: https://truewindai.slack.com/archives/{channel_id}/p{thread_ts_with_dot_removed}

## Response format for priority list
After successfully appending, respond with EXACTLY this and nothing else:
:white_check_mark: Done. Priority list here: ${PRIORITY_SHEET_URL}

## HubSpot
You have access to HubSpot CRM. You can search contacts, companies, deals, meetings, and other objects. You can also look up owners (team members) by ID. Use hubspot_list_owners to map owner IDs to names when reporting.

### Daily progress notifications
Daily progress notification counts are based on HubSpot deal records in pipeline ${PROGRESS_PIPELINE_ID} using the deal property ${PROGRESS_DEAL_SOURCE_PROPERTY}. Do not diagnose the progress report from contact lead_source; if a report shows Unknown, it means the counted deal records are missing an Inbound/Outbound value in ${PROGRESS_DEAL_SOURCE_PROPERTY}.

### HubSpot stage verification rule
ALWAYS call hubspot_get_pipeline with pipeline_id 105321581 at the start of any request involving:
- Deal stages, stage names, or stage movements.
- Pipeline summaries or deal counts by stage.
- Any mention of S1, S2, S3, S4, S5, MQL, SQL, POC, Proposal, Full Product Demo, Closed/Lost, Won, or similar stage shorthand.
- Questions about "where is [deal name]", deal status, or the current state of an opportunity.

Never rely on hardcoded stage mappings, previous responses, memory, or stale prompt examples. HubSpot stage names and IDs change frequently. The only source of truth for stage configuration is the real-time API response from hubspot_get_pipeline. After fetching the pipeline configuration, use those exact stage names and IDs for all subsequent HubSpot operations in that conversation.

For historical stage cohort questions like "how many SQLs did we have in January" or "how many deals entered S2 last month", first call hubspot_get_pipeline, then call hubspot_count_deals_entered_stage with the exact stage ID and date boundaries. Use Pacific business-month boundaries unless the user specifies another timezone, for example January 2026 is start_date=2026-01-01T00:00:00-08:00 and end_date=2026-02-01T00:00:00-08:00. Do not use createdate, current dealstage only, or hs_date_entered_{stageId} as the primary answer for historical stage-entry counts. The dealstage property history is the correct source for deals that have already moved past the requested stage.

For true cohort conversion questions like "of the 26 SQLs from January, how many later moved to Won or Closed/Lost?", use the same hubspot_count_deals_entered_stage tool with track_outcomes.stages set to the exact Won/Lost stage IDs from hubspot_get_pipeline. Interpret cohort_outcomes.outcomes.still_active as deals that have not entered any tracked outcome stage by the as_of_date cutoff, not as deals currently in the SQL stage.

For no-show, ghosted, missed meeting, or prospect-did-not-attend questions across deals, call hubspot_analyze_deal_activities. Use the default Active Pipeline 105321581 unless the user specifies another pipeline. The tool scans associated meetings, calls, notes, and emails for no-show language and returns coverage metadata; mention coverage.warning if present.

### Critical HubSpot data freshness
You MUST call the relevant HubSpot API for every HubSpot question, even if you just answered a similar question moments ago. Never say "as I mentioned" or "based on what we just discussed" for HubSpot data. Configuration, stages, owners, records, counts, and associations change constantly. Always fetch fresh data before answering or acting. No exceptions.

### Truewind prospect push workflow
When the current message itself is a structured request to create a new deal with fields like Company, Contact, Email, Deal owner, Source, Meeting booked, and Notes, the backend handles it directly before Claude runs. If you are responding after that flow, only relay the tool's concrete ID/link result. Do not add unrelated thread summaries.

When someone asks you to add, push, create, or update a prospect/lead/opportunity/deal in HubSpot, use hubspot_push_truewind_prospect. Do not manually chain the low-level HubSpot write tools unless the user asks for a custom one-off update.
When someone asks you to add a note to an existing HubSpot deal/contact/company, use hubspot_create_note. If they give a company or deal name instead of an ID, search HubSpot first, choose the unambiguous matching record, then call hubspot_create_note with the matching record ID. Never say you lack a note tool; hubspot_create_note is available. Do not invent or share standalone note record URLs. HubSpot notes are activities on CRM records, so share the attached deal/contact/company record URL returned by the tool.

### Deal notes and deal summaries
When someone asks for "deal notes", "summarize the deal", "deal recap", or a similar recap for a company/deal, you are responsible for creating a comprehensive synthesis from available systems. Do not expect manual AE documentation, and do not say "no notes available" if Grain recordings or HubSpot activities exist.

Required process:
1. Find the deal in HubSpot by company/deal name using hubspot_search. If multiple deals match, choose only if unambiguous; otherwise ask a concise clarification.
2. Get the deal details, including dealname, dealstage, amount, closedate, hubspot_owner_id, pipeline, hs_lastmodifieddate, createdate, and days-in-stage fields when available.
3. Get all associated contacts with hubspot_get_associations, then hubspot_get each contact for firstname, lastname, email, jobtitle, company, phone, lastmodifieddate, and recent conversion/engagement fields when available.
4. Get all associated HubSpot activity with hubspot_get_associated_activities for meetings, calls, emails, notes, and tasks. Even when a meeting has no internal notes, use participant, timing, title, and outcome context.
5. Search Grain recordings with grain_search_recordings by company_name and by each associated contact's participant_email. Use a reasonable date_range if the deal has a createdate or close window. This tool scans accessible Grain recordings and returns coverage metadata; if Grain search is unavailable, returns an error, or coverage.truncated is true, explicitly state that limitation and do not present missing recordings as definitive.
6. For every relevant Grain match, call grain_get_recording and read the transcript_text, summary, participants, and transcript_url. Extract pain points, requirements, objections, budget, timeline, competitors, technical requirements, decision criteria, and next steps from the transcript. Never rely only on recording titles.
7. Synthesize patterns across HubSpot and Grain. Do not merely list raw activities.

Deal recap output format:
**Deal Snapshot**
- Stage, amount, close date, owner, days in current stage when available.

**Key Stakeholders & Engagement**
- All contacts, roles, meeting participation frequency, and last interaction.

**Current Situation**
- Current status from latest activity and Grain conversations, last meeting discussion, and pending decisions.

**Pain Points & Requirements**
- Specific problems, must-have capabilities, and success criteria from transcripts.

**Risks & Blockers**
- Concerns, competitors, budget/approval challenges, and technical limits raised.

**Deal Momentum**
- Positive signals, negative/stalling signals, and engagement trend.

**Immediate Action Items**
- Next steps, owners/people to involve, upcoming meetings, deadlines.

**Conversation History**
- Chronological HubSpot and Grain history. Include Grain links for recordings and concise key points for emails/calls/meetings.

Rules enforced by the backend tool:
- Contact first, deal second. Contact is the anchor record.
- Email is required. If email is missing, ask for it.
- Deal source is required for every new HubSpot deal. If the user does not provide a deal source/source, ask for it before creating or pushing the deal. Do not infer, deduce, or default deal source from context.
- Valid deal source values are: Outbound - Sales Sourced List, Event, In-Person Socials, Webinar, PR, Self serve, Referral, Inbound - Direct.
- Company is required, but the tool can infer it from LinkedIn or a non-generic email domain. Only ask if the tool says company is unclear.
- The tool searches Firecrawl for LinkedIn, stores the LinkedIn URL in Truewind's writable HubSpot LinkedIn contact property, creates or updates the contact, creates or matches a deal in pipeline 105321581 at MQL stage 1307720553, creates contact-company, deal-contact, and deal-company associations, then updates the contact to lifecycle opportunity and lead status internal value MQL (HubSpot label Converted).
- Pass the full Slack request/thread in the context field for write authorization and notes context, but pass the user's explicit source in lead_source/deal_source.
- If the request includes notes, referral context, meeting-booked text, or deal/prospect type, pass notes, meeting_booked, and type into hubspot_push_truewind_prospect. The backend creates a HubSpot note object associated to the deal, contact, and company and reports the note ID or exact note error.
- Pass channel_id and slack_user_id from Slack metadata on every HubSpot write tool call. The backend uses them for HubSpot write authorization and owner mapping. If the user explicitly names an owner, pass owner_name; explicit owner_name overrides Slack owner mapping. Otherwise it looks up the Slack user's HubSpot owner by Slack email, then uses any configured Slack mapping, otherwise defaults to Xavier.
- Never ask for deal stage, owner, ERP, or name/title unless the backend tool explicitly needs clarification. Always ask for deal source before deal creation when the user has not provided one.
- Never say done without actual record IDs from the tool result. If the tool fails, show the exact error. Do not summarize unrelated earlier thread or channel messages as completed work.
- Do not pass read-only HubSpot properties into low-level write tools. The backend validates properties before write and will reject system-managed fields such as hs_deal_stage_probability_shadow, notes_last_updated, and hs_object_source_detail_1.

Deal source rule:
- Never deduce or default deal source for a new HubSpot deal. If the user says "create/push/add a deal" without source, ask: "What deal source should I use? Valid options: Outbound - Sales Sourced List, Event, In-Person Socials, Webinar, PR, Self serve, Referral, Inbound - Direct."

## Recruiting calendar scheduling
For recruiting pipeline questions in #hiring-review, use recruiting_list_outstanding_candidates. The recruiting/hiring candidate pipeline is the Notion ATS, not the HubSpot sales deal pipeline.
- "Outstanding candidates", "active candidates", "who is in the hiring pipeline", or "who still needs review" should call recruiting_list_outstanding_candidates.
- Use mode=active by default. Use mode=awaiting_decision when the user asks specifically for new applicants needing Proceed/Reject/Forward review.
- Summarize by status first, then list candidate name, role, status, current title/company when available, and the Notion link.
- If the tool returns an error, show the exact error and do not answer from memory.

When someone asks you to schedule, book, or create an invite for a recruiting interview, first-round call, intro call, or candidate screen, use recruiting_create_calendar_invite.
- Only use it for recruiting/interview scheduling. For customer sales meetings, do not use this tool unless the user explicitly says it is a recruiting interview.
- Required fields: candidate email and exact start time.
- Title the calendar event from the Gmail email/thread subject whenever you have it. Pass that subject as title or email_subject; the tool will remove the [hiring@] tag and leading Re:/Fwd: prefixes.
- If no Gmail subject is available, omit the title instead of inventing one; the tool will look up the candidate in the Notion ATS by email and infer a title from role and candidate name when possible.
- If candidate email is missing, ask for the email.
- If the time is ambiguous, ask for the exact date/time/timezone.
- Convert natural language times to ISO datetime with timezone before calling the tool. Use America/Los_Angeles when the user does not specify a timezone.
- Default duration is 20 minutes unless the user gives a different duration.
- Pass channel_id, thread_ts, and slack_user_id from Slack metadata on every tool call.
- Do not say the invite was created unless the tool returns a calendar event ID or link. If the tool returns an error, show that error.

Key owner IDs:
- Xavier Marco: 89305622
- Mercedes Chien: 87811681
- Alex Lee: 559564379
- Amy Vetter: 92555980
- Aidan Gleghorn: 89053735
- Noah Salah: 90960689
- Jenilee Chen: 91143842
- Brendan Moody: 91143844
- Sarah Elix: 84547076

## Grain
You have access to Grain meeting transcripts. You can list recent recordings and get full details including summaries, participants, transcript text, and transcript links. Use this when asked about customer calls, meeting notes, or transcripts.

## General behavior
- Keep responses short and direct
- You receive full thread history. Use it to understand context.
- The Slack metadata (channel_id, thread_ts, thread_date) is appended to the last message.
- NEVER lie or fabricate results. If a tool call fails, show the actual error message. If you cannot do something, say exactly why (e.g. missing scope, token expired, tool not available). Do NOT say "done" or "created" unless you received a successful response with an ID back from the API.
- If a HubSpot record was just created and search can't find it, explain that HubSpot search indexing has a delay and provide the direct record ID/URL instead of claiming it doesn't exist.`;
}

function getMessageContentText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (!block) return '';
    if (typeof block === 'string') return block;
    if (typeof block.text === 'string') return block.text;
    if (typeof block.content === 'string') return block.content;
    return '';
  }).filter(Boolean).join('\n');
}

function selectClaudeModelForMessages(messages) {
  const text = messages
    .filter((message) => message.role === 'user')
    .map((message) => getMessageContentText(message.content))
    .join('\n')
    .toLowerCase();

  const highIntent = /\b(review|analy[sz]e|analysis|strategy|strategic|planning|debug|troubleshoot|root cause|investigate|architecture|design|compare|evaluate|recommend|recommendation|decide|decision|tradeoff|risk|risks|complex|deep|think hard|think deeply|implementation|proposal|prioriti[sz]e|roadmap|hubspot|prospect|opportunit(?:y|ies)|deal|crm)\b/.test(text);
  const multiStepAsk = /\b(step by step|multi-step|multiple steps|end to end|from scratch)\b/.test(text);
  const longContext = text.length > Number(process.env.CLAUDE_HIGH_CONTEXT_CHARS || 3000);
  const longThread = messages.filter((message) => message.role === 'user').length >= Number(process.env.CLAUDE_HIGH_THREAD_MESSAGES || 5);
  const repeatedQuestions = (text.match(/\?/g) || []).length >= 3;

  if (highIntent || multiStepAsk || longContext || longThread || repeatedQuestions) {
    return {
      model: CLAUDE_HIGH_MODEL,
      tier: 'high',
      reason: highIntent ? 'high_intent'
        : multiStepAsk ? 'multi_step'
          : longContext ? 'long_context'
            : longThread ? 'long_thread'
              : 'repeated_questions',
    };
  }

  return { model: CLAUDE_DEFAULT_MODEL, tier: 'default', reason: 'simple_or_direct' };
}

// ============================================================
// Slack message handling
// ============================================================
function stripMention(text) {
  return text.replace(/<@[A-Z0-9]+>/g, '').trim();
}

async function getSlackUserEmail(slackUserId) {
  if (!slackUserId) return '';
  const tokens = [process.env.SLACK_BOT_TOKEN, process.env.SLACK_USER_TOKEN].filter(Boolean);
  for (const token of tokens) {
    try {
      const result = await app.client.users.info({ token, user: slackUserId });
      const email = result.user?.profile?.email || '';
      if (email) return email;
    } catch (err) {
      console.error(`Could not fetch Slack user email for ${slackUserId}: ${err.message}`);
    }
  }
  return '';
}

// Returns { messages, parentTs } where parentTs is the timestamp of the first/parent message
async function fetchThreadHistory(channel, threadTs, isThread) {
  const tokens = [process.env.SLACK_BOT_TOKEN, process.env.SLACK_USER_TOKEN].filter(Boolean);

  for (const token of tokens) {
    try {
      if (isThread) {
        const result = await app.client.conversations.replies({ token, channel, ts: threadTs });
        if (!result.ok || !result.messages) continue;
        console.log(`Fetched ${result.messages.length} thread messages (token=${token.slice(0,8)}...)`);

        const parentTs = result.messages[0].ts; // First message is always the parent
        const messages = [];
        for (const msg of result.messages) {
          const content = stripMention(msg.text || '');
          if (!content) continue;
          if (msg.bot_id) {
            messages.push({ role: 'assistant', content });
          } else {
            messages.push({ role: 'user', content });
          }
        }
        return { messages, parentTs };
      } else {
        const result = await app.client.conversations.history({ token, channel, limit: 20 });
        if (!result.ok || !result.messages) continue;
        console.log(`Fetched ${result.messages.length} channel messages (token=${token.slice(0,8)}...)`);

        const channelMsgs = result.messages.reverse();
        const messages = [];
        for (const msg of channelMsgs) {
          const content = stripMention(msg.text || '');
          if (!content) continue;
          if (msg.bot_id) {
            messages.push({ role: 'assistant', content });
          } else {
            messages.push({ role: 'user', content });
          }
        }
        return { messages, parentTs: null };
      }
    } catch (err) {
      console.error(`Error fetching history (token=${token.slice(0,8)}...): ${err.message}`);
      continue;
    }
  }
  console.error('All tokens failed to fetch history');
  return { messages: [], parentTs: null };
}

function mergeMessages(messages) {
  const merged = [];
  for (const msg of messages) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      merged[merged.length - 1].content += '\n' + msg.content;
    } else {
      merged.push({ ...msg });
    }
  }
  if (merged.length > 0 && merged[0].role !== 'user') merged.shift();
  if (merged.length > 0 && merged[merged.length - 1].role !== 'user') merged.pop();
  return merged;
}

function redactedToolInputForLog(name, input = {}) {
  if (name !== 'recruiting_create_calendar_invite') return JSON.stringify(input);
  const allowedKeys = new Set([
    'start_datetime',
    'start_at',
    'start',
    'end_datetime',
    'end_at',
    'end',
    'duration_minutes',
    'timezone',
    'calendar_id',
    'send_updates',
    'with_meet',
  ]);
  const redacted = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (allowedKeys.has(key)) {
      redacted[key] = value;
    } else {
      redacted[key] = Array.isArray(value) ? value.map(() => '[redacted]') : '[redacted]';
    }
  }
  return JSON.stringify(redacted);
}

async function handleMessage(text, threadTs, channel, isThread, say, slackUserId = '') {
  const cleanText = stripMention(text);
  if (!cleanText) return;

  console.log(`handleMessage: channel=${channel}, threadTs=${threadTs}, isThread=${isThread}, text_chars=${cleanText.length}`);

  const structuredDeal = parseStructuredDealRequest(cleanText);
  if (structuredDeal) {
    const threadDate = new Date(parseFloat(threadTs) * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    structuredDeal.context = `${cleanText}\n\n[Slack metadata: channel_id=${channel}, thread_ts=${threadTs}, thread_date=${threadDate}${slackUserId ? `, slack_user_id=${slackUserId}` : ''}]`;
    structuredDeal.channel_id = channel;
    structuredDeal.slack_user_id = slackUserId;
    const reply = await runStructuredDealCreateWorkflow(structuredDeal);
    await say({ text: reply, thread_ts: threadTs });
    return;
  }

  const fetched = isThread
    ? await fetchThreadHistory(channel, threadTs, isThread)
    : { messages: [{ role: 'user', content: cleanText }], parentTs: threadTs };
  let messages = fetched.messages;
  const parentTs = fetched.parentTs || threadTs;

  if (messages.length === 0) {
    messages = [{ role: 'user', content: cleanText }];
  }
  messages = mergeMessages(messages);
  if (messages.length === 0) {
    messages = [{ role: 'user', content: cleanText }];
  }

  // Use the actual parent message timestamp for the date, not the reply timestamp
  const threadDate = new Date(parseFloat(parentTs) * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const lastMsg = messages[messages.length - 1];
  const slackUserPart = slackUserId ? `, slack_user_id=${slackUserId}` : '';
  lastMsg.content += `\n\n[Slack metadata: channel_id=${channel}, thread_ts=${parentTs}, thread_date=${threadDate}${slackUserPart}]`;

  const selectedModel = selectClaudeModelForMessages(messages);
  console.log(`Claude model selected: ${selectedModel.model} tier=${selectedModel.tier} reason=${selectedModel.reason}`);

  // Helper to call Claude with retries on overload (529)
  async function callClaude(msgs) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await anthropic.messages.create({
          model: selectedModel.model,
          max_tokens: 2048,
          system: getSystemPrompt(),
          tools: TOOLS,
          messages: msgs,
        });
      } catch (err) {
        if (err.status === 529 && attempt < 2) {
          console.log(`Overloaded, retrying in ${(attempt + 1) * 5}s...`);
          await new Promise((r) => setTimeout(r, (attempt + 1) * 5000));
          continue;
        }
        throw err;
      }
    }
  }

  try {
    // Agentic loop: keep calling Claude until it produces a final text response
    let response = await callClaude(messages);

    while (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      const toolResults = [];

      for (const block of toolUseBlocks) {
        console.log(`Tool call: ${block.name}(${redactedToolInputForLog(block.name, block.input)})`);
        const result = await executeTool(block.name, block.input, {
          channel_id: channel,
          slack_user_id: slackUserId,
          thread_ts: parentTs,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      response = await callClaude(messages);
    }

    const textBlock = response.content.find((b) => b.type === 'text');
    const reply = textBlock ? textBlock.text : '(No response)';
    await say({ text: reply, thread_ts: threadTs });
  } catch (err) {
    console.error('Claude API error:', err.message);
    await say({ text: `Error: Claude request failed: ${err.message}. No action completed by this response.`, thread_ts: threadTs });
  }
}

// Respond to @mentions in channels
app.event('app_mention', async ({ event, say }) => {
  const isThread = !!event.thread_ts;
  const threadTs = event.thread_ts || event.ts;
  console.log(`app_mention: thread_ts=${event.thread_ts}, ts=${event.ts}, isThread=${isThread}`);
  await handleMessage(event.text, threadTs, event.channel, isThread, say, event.user || '');
});

// Respond to DMs
app.event('message', async ({ event, say }) => {
  if (event.channel_type !== 'im') return;
  if (event.bot_id || event.subtype) return;
  const isThread = !!event.thread_ts;
  const threadTs = event.thread_ts || event.ts;
  await handleMessage(event.text, threadTs, event.channel, isThread, say, event.user || '');
});

// ============================================================
// Daily Discovery Call Digest
// ============================================================
const DISCOVERY_DIGEST_CHANNEL = process.env.DISCOVERY_DIGEST_CHANNEL || 'slack-testing'; // #slack-testing
const GRAIN_API_TOKEN = process.env.GRAIN_API_TOKEN
  || process.env.GRAIN_API
  || process.env.GRAIN_ACCESS_TOKEN
  || process.env.GRAIN_WORKSPACE_TOKEN;
const GRAIN_API_BASE = process.env.GRAIN_API_BASE || 'https://api.grain.com/_/public-api';
let discoveryDigestInFlight = null;

async function grainRequest(endpoint) {
  if (!GRAIN_API_TOKEN) return { error: 'Grain not configured' };
  const url = endpoint.startsWith('http') ? endpoint : `${GRAIN_API_BASE.replace(/\/$/, '')}${endpoint}`;
  try {
    return await httpRequest(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${GRAIN_API_TOKEN}`,
        'Accept': 'application/json',
      },
    });
  } catch (err) {
    console.error(`Grain request error: ${err.message}`);
    return { error: err.message };
  }
}

async function searchHubSpotMeetingsForDigest(startOfDay, endOfDay) {
  const meetings = [];
  let after = '';
  const MAX_PAGES = 10;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'hs_meeting_start_time', operator: 'GTE', value: startOfDay.toISOString() },
          { propertyName: 'hs_meeting_start_time', operator: 'LT', value: endOfDay.toISOString() },
        ],
      }],
      properties: [
        'hs_meeting_title',
        'hs_meeting_start_time',
        'hs_meeting_end_time',
        'hs_meeting_body',
        'hubspot_owner_id',
        'hubspot_owner_email',
      ],
      sorts: [{ propertyName: 'hs_meeting_start_time', direction: 'ASCENDING' }],
      limit: 100,
    };
    if (after) body.after = after;

    const res = await hubspotRequest('/crm/v3/objects/meetings/search', 'POST', body);
    const pageItems = res.results || [];
    meetings.push(...pageItems);
    after = res.paging?.next?.after || '';
    if (!after || pageItems.length === 0) break;
  }
  return meetings;
}

async function attachHubSpotContacts(meetings, config) {
  for (const meeting of meetings) {
    try {
      const assocRes = await hubspotRequest(`/crm/v4/objects/meetings/${meeting.id}/associations/contacts`);
      const contactIds = (assocRes.results || []).map(r => r.toObjectId);
      meeting._contactIds = contactIds;
      meeting._contacts = [];
      meeting._externalContacts = [];

      for (const cid of contactIds.slice(0, 5)) {
        const c = await hubspotRequest(`/crm/v3/objects/contacts/${cid}?properties=firstname,lastname,email,company,jobtitle`);
        if (!c.id) continue;
        meeting._contacts.push(c.properties);
        const email = normalizeDigestText(c.properties?.email);
        const domain = email.includes('@') ? email.split('@').pop() : '';
        if (email && !config.internalDomains.has(domain)) {
          meeting._externalContacts.push(c.properties);
        }
      }

      if (meeting._externalContacts.length === 0) {
        const companyAssoc = await hubspotRequest(`/crm/v4/objects/meetings/${meeting.id}/associations/companies`);
        const companyIds = (companyAssoc.results || []).map(r => r.toObjectId);
        for (const companyId of companyIds.slice(0, 3)) {
          const companyContactAssoc = await hubspotRequest(`/crm/v4/objects/companies/${companyId}/associations/contacts`);
          const companyContactIds = (companyContactAssoc.results || []).map(r => r.toObjectId);
          for (const cid of companyContactIds.slice(0, 5)) {
            if (meeting._contactIds.includes(cid)) continue;
            const c = await hubspotRequest(`/crm/v3/objects/contacts/${cid}?properties=firstname,lastname,email,company,jobtitle`);
            if (!c.id) continue;
            meeting._contactIds.push(cid);
            meeting._contacts.push(c.properties);
            const email = normalizeDigestText(c.properties?.email);
            const domain = email.includes('@') ? email.split('@').pop() : '';
            if (email && !config.internalDomains.has(domain)) {
              meeting._externalContacts.push(c.properties);
            }
          }
          if (meeting._externalContacts.length > 0) break;
        }
      }
    } catch (err) {
      console.error(`Failed to get contacts for meeting ${meeting.id}:`, err.message);
      meeting._contacts = [];
      meeting._externalContacts = [];
    }
  }
}

async function fetchGrainRecordingsForDay(startOfDay, endOfDay) {
  if (!GRAIN_API_TOKEN) {
    throw new Error('Missing Grain API token. Set GRAIN_API_TOKEN, GRAIN_API, GRAIN_ACCESS_TOKEN, or GRAIN_WORKSPACE_TOKEN.');
  }

  const recordings = [];
  let cursor = '';
  const maxPages = Number(process.env.GRAIN_DIGEST_MAX_PAGES || 20);
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ limit: process.env.GRAIN_DIGEST_PAGE_SIZE || '100' });
    if (cursor && !cursor.startsWith('http')) params.set('cursor', cursor);
    const endpoint = cursor && cursor.startsWith('http') ? cursor : `/recordings?${params}`;
    const payload = await grainRequest(endpoint);
    if (payload?.error) throw new Error(`Grain recordings API returned an error: ${payload.error}`);

    const { items, cursor: nextCursor, hasMore } = parseListItems(payload);
    recordings.push(...items);
    if (!hasMore || !nextCursor || items.length === 0) break;
    cursor = nextCursor;
  }

  return dedupeGrainRecordings(recordings).filter(recording => {
    const startMs = getGrainRecordingStartMs(recording);
    return startMs >= startOfDay.getTime() && startMs < endOfDay.getTime();
  });
}

async function fetchGrainRecordingDetail(recording) {
  const id = getGrainRecordingId(recording);
  if (!id) return recording;

  const detailEndpoints = [
    `/recordings/${encodeURIComponent(id)}?include=transcript,summary,participants`,
    `/recordings/${encodeURIComponent(id)}`,
    `/recordings/${encodeURIComponent(id)}/transcript?format=json`,
    `/recordings/${encodeURIComponent(id)}/transcript`,
  ];

  let merged = { ...recording };
  for (const endpoint of detailEndpoints) {
    const payload = await grainRequest(endpoint);
    if (!payload || payload.error) continue;
    if (Array.isArray(payload) || typeof payload === 'string') {
      merged.transcript = payload;
    } else if (payload.transcript || payload.transcript_text || payload.text || payload.id) {
      merged = { ...merged, ...payload };
    }
    if (formatGrainTranscriptText(merged)) break;
  }
  return merged;
}

async function applyGrainRecordingToMeeting(meeting, recording) {
  const detail = await fetchGrainRecordingDetail(recording);
  meeting._grainId = getGrainRecordingId(detail) || getGrainRecordingId(recording);
  meeting._transcriptUrl = getGrainRecordingUrl(detail) || getGrainRecordingUrl(recording);
  meeting._transcript = formatGrainTranscriptText(detail);
  meeting._summary = typeof detail.summary === 'object' ? detail.summary.overview : detail.summary;
  meeting._grainRecording = detail;
  return meeting;
}

async function resolveExternalGrainContacts(recording, config) {
  const contacts = [];
  const participants = recording?.participants || recording?.attendees || [];
  const externalParticipants = participants.filter(p => {
    const email = normalizeDigestText(p.email || p.email_address);
    const domain = email.includes('@') ? email.split('@').pop() : '';
    return email && !config.internalDomains.has(domain);
  });

  for (const participant of externalParticipants.slice(0, 3)) {
    const email = participant.email || participant.email_address;
    try {
      const searchRes = await hubspotRequest('/crm/v3/objects/contacts/search', 'POST', {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: ['firstname', 'lastname', 'email', 'company', 'jobtitle'],
        limit: 1,
      });
      if (searchRes.results?.length > 0) {
        contacts.push(searchRes.results[0].properties);
        continue;
      }
    } catch (err) {
      console.error(`Failed to resolve Grain participant ${email} in HubSpot:`, err.message);
    }

    const nameParts = String(participant.name || participant.full_name || '').trim().split(/\s+/);
    contacts.push({
      firstname: nameParts[0] || '',
      lastname: nameParts.slice(1).join(' '),
      email,
      company: participant.company || '',
      jobtitle: participant.title || participant.job_title || '',
    });
  }

  return contacts;
}

function getPacificDayRange(now = new Date()) {
  const labelFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const labelParts = Object.fromEntries(labelFormatter.formatToParts(now).map(part => [part.type, part.value]));
  const dateLabel = `${labelParts.weekday}, ${labelParts.month} ${Number(labelParts.day)}, ${labelParts.year}`;

  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(dateParts.map(part => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month) - 1;
  const day = Number(values.day);
  const ptLocal = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const utcLocal = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = ptLocal.getTime() - utcLocal.getTime();

  return {
    startOfDay: new Date(Date.UTC(year, month, day, 0, 0, 0) - offsetMs),
    endOfDay: new Date(Date.UTC(year, month, day + 1, 0, 0, 0) - offsetMs),
    dateLabel,
  };
}

async function runDiscoveryDigest(channelOverride) {
  if (discoveryDigestInFlight) {
    console.log('Discovery digest already running; joining in-flight run.');
    return discoveryDigestInFlight;
  }
  discoveryDigestInFlight = runDiscoveryDigestImpl(channelOverride).finally(() => {
    discoveryDigestInFlight = null;
  });
  return discoveryDigestInFlight;
}

async function runDiscoveryDigestImpl(channelOverride) {
  const channel = channelOverride || DISCOVERY_DIGEST_CHANNEL;
  console.log('Running discovery call digest...');

  const config = buildDiscoveryDigestConfig(process.env);
  if (config.salesEmails.size === 0 && config.salesOwnerIds.size === 0) {
    console.warn('Discovery digest: DISCOVERY_DIGEST_SALES_EMAILS or DISCOVERY_DIGEST_SALES_OWNER_IDS is not configured; classification will use discovery/external-participant heuristics only.');
  } else if (config.salesEmails.size > 0 && config.salesOwnerIds.size === 0) {
    console.warn('Discovery digest: DISCOVERY_DIGEST_SALES_EMAILS is configured without DISCOVERY_DIGEST_SALES_OWNER_IDS; HubSpot scheduled/no-show scoping depends on HubSpot returning hubspot_owner_email.');
  }
  const { startOfDay, endOfDay, dateLabel } = getPacificDayRange();

  try {
    const allMeetings = await searchHubSpotMeetingsForDigest(startOfDay, endOfDay);
    await attachHubSpotContacts(allMeetings, config);
    const hubspotDiscoveryMeetings = allMeetings.filter(meeting => isLikelyHubSpotDiscoveryMeeting(meeting, config));
    const canceled = hubspotDiscoveryMeetings.filter(m => normalizeDigestText(m.properties.hs_meeting_title).startsWith('canceled:'));
    const scheduled = hubspotDiscoveryMeetings.filter(m => !normalizeDigestText(m.properties.hs_meeting_title).startsWith('canceled:'));

    const grainToday = await fetchGrainRecordingsForDay(startOfDay, endOfDay);
    console.log(`Grain: fetched ${grainToday.length} recordings for ${startOfDay.toISOString()} to ${endOfDay.toISOString()}`);

    const matchedGrainIds = new Set();
    for (const meeting of scheduled) {
      const matched = findBestGrainRecordingForMeeting(meeting, grainToday, config, matchedGrainIds);
      if (!matched) continue;
      await applyGrainRecordingToMeeting(meeting, matched);
      if (meeting._grainId) matchedGrainIds.add(meeting._grainId);
    }

    const unmatchedGrainRecordings = grainToday.filter(recording => {
      const id = getGrainRecordingId(recording);
      return !id || !matchedGrainIds.has(id);
    });
    for (const recording of unmatchedGrainRecordings) {
      if (!isLikelyGrainDiscoveryRecording(recording, config)) continue;
      const detail = await fetchGrainRecordingDetail(recording);
      if (!isLikelyGrainDiscoveryRecording(detail, config)) continue;

      const contacts = await resolveExternalGrainContacts(detail, config);
      const startMs = getGrainRecordingStartMs(detail) || getGrainRecordingStartMs(recording);
      const fallbackMeeting = {
        id: `grain_${getGrainRecordingId(detail) || getGrainRecordingId(recording)}`,
        properties: {
          hs_meeting_title: getGrainRecordingTitle(detail) || getGrainRecordingTitle(recording) || 'Unknown',
          hs_meeting_start_time: startMs ? new Date(startMs).toISOString() : '',
        },
        _contacts: contacts,
        _externalContacts: contacts,
        _fromGrainFallback: true,
      };

      await applyGrainRecordingToMeeting(fallbackMeeting, detail);
      if (fallbackMeeting._grainId) matchedGrainIds.add(fallbackMeeting._grainId);
      scheduled.push(fallbackMeeting);
    }

    const uniqueCanceled = dedupeDigestMeetings(canceled);
    const uniqueScheduled = dedupeDigestMeetings(scheduled);

    // Completed means Grain has a matched recording with transcript or summary content.
    const hasContent = (m) => m._grainId && (m._summary || m._transcript);
    const completed = uniqueScheduled.filter(m => hasContent(m));
    const noShows = uniqueScheduled.filter(m => !hasContent(m));

    if (uniqueScheduled.length === 0 && uniqueCanceled.length === 0) {
      await app.client.chat.postMessage({
        token: process.env.SLACK_BOT_TOKEN,
        channel,
        text: formatEmptyDiscoveryDigestMessage(dateLabel),
      });
      console.log(`No discovery calls scheduled for ${dateLabel}.`);
      return;
    }

    // Use Claude to extract takeaways and quotes from completed calls.
    for (const meeting of completed) {
      let transcriptText = String(meeting._transcript || '').slice(0, 5000);
      if (!transcriptText && meeting._summary) {
        transcriptText = String(meeting._summary);
      }
      if (!transcriptText) continue;

      try {
        const claudeRes = await anthropic.messages.create({
          model: CLAUDE_DIGEST_MODEL,
          max_tokens: 500,
          system: `You extract key takeaways and pain point quotes from sales discovery call transcripts. Be concise. Never use em dashes.`,
          messages: [{
            role: 'user',
            content: `Extract from this discovery call transcript:
1. One-line takeaway (what the prospect needs/their situation)
2. One direct quote that illustrates their pain point (exact words from the transcript, with the speaker's name)

Transcript:
${transcriptText.slice(0, 4000)}

Reply in this exact format:
TAKEAWAY: ...
QUOTE: "..." -- [Speaker Name]`,
          }],
        });
        const text = claudeRes.content.find(b => b.type === 'text')?.text || '';
        const takeawayMatch = text.match(/TAKEAWAY:\s*(.+)/);
        const quoteMatch = text.match(/QUOTE:\s*(.+)/);
        meeting._takeaway = takeawayMatch ? takeawayMatch[1].trim() : null;
        meeting._quote = quoteMatch ? quoteMatch[1].trim() : null;
      } catch (err) {
        console.error(`Claude extraction failed for meeting ${meeting.id}:`, err.message);
      }
    }

    // 7. Format and post
    let msg = `*Discovery Call Digest -- ${dateLabel}*\n\n`;
    msg += `Scheduled: ${uniqueScheduled.length + uniqueCanceled.length}\n`;
    msg += `Completed: ${completed.length}\n`;
    msg += `No-shows: ${noShows.length}`;
    if (noShows.length > 0) {
      const noShowNames = noShows.map(m => {
        const ext = (m._externalContacts || [])[0];
        const name = ext ? `${ext.firstname || ''} ${ext.lastname || ''}`.trim() : (m.properties.hs_meeting_title || 'Unknown');
        const co = ext?.company || '';
        return co ? `${name} (${co})` : name;
      });
      msg += ` -- ${noShowNames.join(', ')}`;
    }
    msg += `\nCanceled: ${uniqueCanceled.length}`;
    if (uniqueCanceled.length > 0) {
      const cancelNames = uniqueCanceled.map(m => (m.properties.hs_meeting_title || '').replace('Canceled: ', '').replace(' and Sarah Elix', ''));
      msg += ` -- ${cancelNames.join(', ')}`;
    }
    if (noShows.length > 0) {
      msg += '\n\n*No-show details:*';
      for (const meeting of noShows) {
        msg += `\n- ${formatNoShowMeetingLabel(meeting)}`;
      }
    }
    msg += '\n';
    if (config.salesEmails.size === 0 && config.salesOwnerIds.size === 0) {
      msg += '\nWarning: sales owner scope is not configured; this digest used discovery-call heuristics only.\n';
    } else if (config.salesEmails.size > 0 && config.salesOwnerIds.size === 0) {
      msg += '\nWarning: HubSpot scheduled/no-show scoping depends on HubSpot owner-email data; configure DISCOVERY_DIGEST_SALES_OWNER_IDS if owner emails are unavailable.\n';
    }

    for (const meeting of completed) {
      const ext = (meeting._externalContacts || [])[0];
      const name = ext ? `${ext.firstname || ''} ${ext.lastname || ''}`.trim() : 'Unknown';
      const title = ext?.jobtitle || '';
      const company = ext?.company || '';
      const header = [name, title, company].filter(Boolean).join(' | ');

      msg += `\n---\n*${header}*\n`;
      if (meeting._takeaway) msg += `Takeaway: ${meeting._takeaway}\n`;
      if (meeting._quote) msg += `Pain quote: ${meeting._quote}\n`;
      if (meeting._transcriptUrl) msg += `Transcript: ${meeting._transcriptUrl}\n`;
    }

    await app.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel,
      text: msg,
    });
    console.log('Discovery digest posted.');
  } catch (err) {
    console.error('Discovery digest error:', err.message);
    await app.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel,
      text: `Discovery digest failed: ${err.message}`,
    });
  }
}

// Schedule weekdays at 4 PM PST (00:00 UTC next day during PST, 23:00 UTC during PDT)
function scheduleDiscoveryDigest() {
  const TARGET_HOUR_UTC = 0; // 4 PM PST = 00:00 UTC next day
  function msUntilNext() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(TARGET_HOUR_UTC, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    // Skip weekends (0=Sun, 6=Sat) -- digest runs Mon-Fri for today's calls
    while (next.getUTCDay() === 0 || next.getUTCDay() === 6) {
      next.setDate(next.getDate() + 1);
    }
    return next - now;
  }
  // Check if today's run was missed (e.g. service restarted after target time).
  // "Today" in PT: if it's past 4 PM PST on a weekday, run immediately.
  const now = new Date();
  const ptHour = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const ptDay = ptHour.getDay(); // 0=Sun, 6=Sat
  const isWeekday = ptDay >= 1 && ptDay <= 5;
  const isPastTarget = ptHour.getHours() >= 16; // 4 PM PT
  if (isWeekday && isPastTarget) {
    console.log(`  Discovery digest: missed today's run, triggering now`);
    runDiscoveryDigest();
  }
  function run() {
    runDiscoveryDigest();
    setTimeout(run, msUntilNext());
  }
  setTimeout(run, msUntilNext());
  const nextRun = new Date(Date.now() + msUntilNext());
  console.log(`  Discovery digest scheduled, next run: ${nextRun.toISOString()}`);
}

// ============================================================
// Daily deal progress post
// ============================================================
const DEFAULT_PROGRESS_WEEKLY_GOAL = 30;
const LEGACY_PROGRESS_WEEKLY_GOAL = 10;
const DEFAULT_PROGRESS_DEAL_SOURCE_PROPERTY = 'deal_source';
const LEGACY_PROGRESS_LEAD_SOURCE_PROPERTY = 'lead_source';

function parseProgressWeeklyGoal(rawValue) {
  if (rawValue == null || String(rawValue).trim() === '') {
    return DEFAULT_PROGRESS_WEEKLY_GOAL;
  }

  const weeklyGoal = Number.parseFloat(rawValue);
  if (Number.isNaN(weeklyGoal)) {
    throw new Error(`Invalid LEAD_REPORT_WEEKLY_GOAL: ${rawValue}`);
  }
  if (weeklyGoal === LEGACY_PROGRESS_WEEKLY_GOAL) {
    console.warn('Ignoring legacy LEAD_REPORT_WEEKLY_GOAL=10 override; using 30');
    return DEFAULT_PROGRESS_WEEKLY_GOAL;
  }
  return weeklyGoal;
}

function parseProgressDealSourceProperty(rawValue) {
  const configured = String(rawValue || '').trim();
  if (!configured) return DEFAULT_PROGRESS_DEAL_SOURCE_PROPERTY;
  if (configured === LEGACY_PROGRESS_LEAD_SOURCE_PROPERTY) {
    console.warn('Ignoring legacy LEAD_REPORT_DEAL_SOURCE_PROPERTY=lead_source override; using deal_source');
    return DEFAULT_PROGRESS_DEAL_SOURCE_PROPERTY;
  }
  return configured;
}

const PROGRESS_TARGET_CHANNEL = process.env.LEAD_REPORT_TARGET_CHANNEL || 'gtm-general';
const PROGRESS_DEAL_SOURCE_PROPERTY = parseProgressDealSourceProperty(process.env.LEAD_REPORT_DEAL_SOURCE_PROPERTY);
const PROGRESS_PIPELINE_ID = process.env.LEAD_REPORT_PIPELINE_ID || '105321581';
const PROGRESS_TRIGGER_SECRET = process.env.LEAD_REPORT_TRIGGER_SECRET || '';
const PROGRESS_WEEKLY_GOAL = parseProgressWeeklyGoal(process.env.LEAD_REPORT_WEEKLY_GOAL);
const PROGRESS_TEST_DEAL_PATTERNS = [/\btest\b/i, /truewind/i];
const PROGRESS_TIMEZONE = 'America/Los_Angeles';
const PROGRESS_TARGET_HOUR = 18;
const PROGRESS_TARGET_MINUTE = 7;
const PROGRESS_ALLOWED_WEEKDAY_INDEXES = new Set([0, 1, 2, 3, 4, 5]); // Sunday, Monday-Friday.
const LEAD_STATUS_SYNC_TARGET_CHANNEL = process.env.LEAD_STATUS_SYNC_TARGET_CHANNEL || 'slack-testing';
const LEAD_STATUS_SYNC_TRIGGER_SECRET = process.env.LEAD_STATUS_SYNC_TRIGGER_SECRET || PROGRESS_TRIGGER_SECRET || '';
const LEAD_STATUS_SYNC_TARGET_HOUR = Number(process.env.LEAD_STATUS_SYNC_TARGET_HOUR || 19);
const LEAD_STATUS_SYNC_TARGET_MINUTE = Number(process.env.LEAD_STATUS_SYNC_TARGET_MINUTE || 30);
const LEAD_STATUS_SYNC_WEEKLY_FULL_DAY = String(process.env.LEAD_STATUS_SYNC_WEEKLY_FULL_DAY || '').trim() === ''
  ? null
  : Number(process.env.LEAD_STATUS_SYNC_WEEKLY_FULL_DAY);
const MQL_DISCOVERY_REPORT_TARGET_CHANNEL = process.env.MQL_DISCOVERY_REPORT_TARGET_CHANNEL || 'slack-testing';
const MQL_DISCOVERY_REPORT_TRIGGER_SECRET = process.env.MQL_DISCOVERY_REPORT_TRIGGER_SECRET || PROGRESS_TRIGGER_SECRET || '';
const MQL_DISCOVERY_REPORT_TARGET_HOUR = Number(process.env.MQL_DISCOVERY_REPORT_TARGET_HOUR || 18);
const MQL_DISCOVERY_REPORT_TARGET_MINUTE = Number(process.env.MQL_DISCOVERY_REPORT_TARGET_MINUTE || 0);
const PACIFIC_WEEKDAY_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
const PACIFIC_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: PROGRESS_TIMEZONE,
  weekday: 'short',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  hourCycle: 'h23',
});

async function resolveChannelId(name) {
  let cursor;
  do {
    const res = await app.client.conversations.list({
      token: process.env.SLACK_BOT_TOKEN,
      exclude_archived: true,
      types: 'public_channel',
      limit: 1000,
      cursor: cursor || undefined,
    });
    const ch = (res.channels || []).find(c => c.name === name);
    if (ch) return ch.id;
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return null;
}

function fmtNum(v) {
  const s = v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return s || '0';
}

function classifyProgressDealSource(source) {
  const normalized = String(source || '').trim().toLowerCase();
  if (normalized.startsWith('inbound')) return 'inbound';
  if (normalized.startsWith('outbound')) return 'outbound';
  return 'unknown';
}

function normalizeProgressDealKey(dealName) {
  return String(dealName || '')
    .toLowerCase()
    .replace(/\s+-\s+new deal$/i, '')
    .replace(/\s+-\s+s\d+$/i, '')
    .replace(/,?\s+inc\.?$/i, '')
    .replace(/\s+-\s+truewind intro meeting.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isObviousTestProgressDeal(deal) {
  const properties = deal.properties || {};
  const dealName = String(properties.dealname || '');
  return PROGRESS_TEST_DEAL_PATTERNS.some(pattern => pattern.test(dealName));
}

function getProgressDealCompletenessScore(deal) {
  const properties = deal.properties || {};
  let score = 0;

  if (String(properties[PROGRESS_DEAL_SOURCE_PROPERTY] || '').trim()) score += 100;
  if (String(properties.hubspot_owner_id || '').trim()) score += 25;
  if (String(properties.amount || '').trim()) score += 10;
  if (String(properties.closedate || '').trim()) score += 10;
  if (String(properties.dealstage || '').trim()) score += 5;

  return score;
}

function compareProgressDealCompleteness(candidate, current) {
  const candidateScore = getProgressDealCompletenessScore(candidate);
  const currentScore = getProgressDealCompletenessScore(current);
  if (candidateScore !== currentScore) return candidateScore - currentScore;

  const candidateCreated = new Date(candidate.properties?.createdate || 0).getTime();
  const currentCreated = new Date(current.properties?.createdate || 0).getTime();
  return currentCreated - candidateCreated;
}

function dedupeProgressDeals(deals) {
  const byKey = new Map();
  const duplicates = [];

  for (const deal of deals) {
    const properties = deal.properties || {};
    const key = normalizeProgressDealKey(properties.dealname) || `deal:${deal.id}`;
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, deal);
      continue;
    }

    if (compareProgressDealCompleteness(deal, existing) > 0) {
      duplicates.push({
        id: existing.id,
        dealname: existing.properties?.dealname || '',
        key,
        replacedBy: deal.id,
      });
      byKey.set(key, deal);
      continue;
    }

    duplicates.push({
      id: deal.id,
      dealname: properties.dealname || '',
      key,
      keptBy: existing.id,
    });
  }

  return { kept: Array.from(byKey.values()), duplicates };
}

function getPacificParts(date = new Date()) {
  const parsed = {};
  for (const part of PACIFIC_DATE_FORMATTER.formatToParts(date)) {
    if (part.type !== 'literal') parsed[part.type] = part.value;
  }
  const hour = Number(parsed.hour) === 24 ? 0 : Number(parsed.hour);
  return {
    year: Number(parsed.year),
    month: Number(parsed.month),
    day: Number(parsed.day),
    hour,
    minute: Number(parsed.minute),
    second: Number(parsed.second),
    weekdayIndex: PACIFIC_WEEKDAY_INDEX[parsed.weekday],
  };
}

function shiftPacificDate(parts, dayDelta) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  shifted.setUTCDate(shifted.getUTCDate() + dayDelta);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function pacificLocalToUtcDate(year, month, day, hour = 0, minute = 0, second = 0) {
  for (const utcOffsetHours of [7, 8]) {
    const candidate = new Date(Date.UTC(year, month - 1, day, hour + utcOffsetHours, minute, second));
    const parts = getPacificParts(candidate);
    if (
      parts.year === year
      && parts.month === month
      && parts.day === day
      && parts.hour === hour
      && parts.minute === minute
      && parts.second === second
    ) {
      return candidate;
    }
  }
  throw new Error(`Unable to resolve Pacific local time ${year}-${month}-${day} ${hour}:${minute}:${second}`);
}

function formatPacificDateLabel(parts) {
  return `${parts.month}/${parts.day}/${String(parts.year).slice(-2)}`;
}

function getDailyProgressWindow(now = new Date()) {
  const nowPacific = getPacificParts(now);
  const todayStartUtc = pacificLocalToUtcDate(nowPacific.year, nowPacific.month, nowPacific.day, 0, 0, 0);
  const daysSinceMonday = (nowPacific.weekdayIndex + 6) % 7;
  const weekStartDate = shiftPacificDate(nowPacific, -daysSinceMonday);
  const weekStartUtc = pacificLocalToUtcDate(weekStartDate.year, weekStartDate.month, weekStartDate.day, 0, 0, 0);
  const targetRunUtc = pacificLocalToUtcDate(
    nowPacific.year,
    nowPacific.month,
    nowPacific.day,
    PROGRESS_TARGET_HOUR,
    PROGRESS_TARGET_MINUTE,
    0,
  );
  return {
    latest: now.getTime() / 1000,
    now,
    nowPacific,
    targetRunUtc,
    todayStartUtc,
    weekStartUtc,
    todayOldest: todayStartUtc.getTime() / 1000,
  };
}

function shouldRunDailyProgressOnPacificDay(weekdayIndex) {
  return PROGRESS_ALLOWED_WEEKDAY_INDEXES.has(weekdayIndex);
}

function getNextDailyProgressRun(referenceDate = new Date()) {
  const currentPacific = getPacificParts(referenceDate);
  let nextDate = {
    year: currentPacific.year,
    month: currentPacific.month,
    day: currentPacific.day,
  };
  let nextRunUtc = pacificLocalToUtcDate(
    nextDate.year,
    nextDate.month,
    nextDate.day,
    PROGRESS_TARGET_HOUR,
    PROGRESS_TARGET_MINUTE,
    0,
  );

  if (nextRunUtc <= referenceDate) {
    nextDate = shiftPacificDate(nextDate, 1);
    nextRunUtc = pacificLocalToUtcDate(
      nextDate.year,
      nextDate.month,
      nextDate.day,
      PROGRESS_TARGET_HOUR,
      PROGRESS_TARGET_MINUTE,
      0,
    );
  }

  while (!shouldRunDailyProgressOnPacificDay(getPacificParts(nextRunUtc).weekdayIndex)) {
    nextDate = shiftPacificDate(nextDate, 1);
    nextRunUtc = pacificLocalToUtcDate(
      nextDate.year,
      nextDate.month,
      nextDate.day,
      PROGRESS_TARGET_HOUR,
      PROGRESS_TARGET_MINUTE,
      0,
    );
  }

  return { nextDate, nextRunUtc };
}

async function searchProgressDeals(startDate, endDate) {
  const deals = [];
  let after;

  for (let page = 0; page < 100; page += 1) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'createdate', operator: 'GTE', value: startDate.toISOString() },
          { propertyName: 'createdate', operator: 'LT', value: endDate.toISOString() },
          { propertyName: 'pipeline', operator: 'EQ', value: PROGRESS_PIPELINE_ID },
        ],
      }],
      properties: [
        'dealname',
        'createdate',
        PROGRESS_DEAL_SOURCE_PROPERTY,
        'pipeline',
        'dealstage',
        'hubspot_owner_id',
        'amount',
        'closedate',
      ],
      sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
      limit: 100,
    };
    if (after) body.after = after;

    const response = await hubspotRequest('/crm/v3/objects/deals/search', 'POST', body);
    deals.push(...(response.results || []));
    after = response.paging?.next?.after;
    if (!after) break;
  }

  return deals;
}

function summarizeProgressDeals(deals, todayStartUtc) {
  const nonTestDeals = [];
  const skippedTests = [];
  for (const deal of deals) {
    if (isObviousTestProgressDeal(deal)) {
      const properties = deal.properties || {};
      skippedTests.push({
        id: deal.id,
        dealname: properties.dealname || '',
      });
      continue;
    }
    nonTestDeals.push(deal);
  }

  const { kept: countableDeals, duplicates } = dedupeProgressDeals(nonTestDeals);
  const summary = {
    today: { inbound: 0, outbound: 0, unknown: 0 },
    week: { inbound: 0, outbound: 0, unknown: 0 },
    unknown: [],
    skippedTests,
    duplicates,
    sourceBreakdown: {},
  };

  for (const deal of countableDeals) {
    const properties = deal.properties || {};
    const source = properties[PROGRESS_DEAL_SOURCE_PROPERTY] || '';
    const sourceKey = source || '(blank)';
    summary.sourceBreakdown[sourceKey] = (summary.sourceBreakdown[sourceKey] || 0) + 1;

    const bucket = classifyProgressDealSource(source);
    if (bucket === 'unknown') {
      summary.unknown.push({
        id: deal.id,
        dealname: properties.dealname || '',
        source: sourceKey,
      });
    }
    summary.week[bucket] += 1;
    const createdAt = new Date(properties.createdate);
    if (!Number.isNaN(createdAt.getTime()) && createdAt >= todayStartUtc) {
      summary.today[bucket] += 1;
    }
  }

  return summary;
}

function isAuthorizedProgressTrigger(reqUrl, headers = {}) {
  if (!PROGRESS_TRIGGER_SECRET) return false;

  const params = new URL(reqUrl, 'http://localhost').searchParams;
  const provided = params.get('token') || headers['x-lead-report-token'] || '';
  const expectedBuffer = Buffer.from(PROGRESS_TRIGGER_SECRET);
  const providedBuffer = Buffer.from(String(provided));
  return providedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function isAuthorizedLeadStatusSyncTrigger(reqUrl, headers = {}) {
  if (!LEAD_STATUS_SYNC_TRIGGER_SECRET) return false;

  const params = new URL(reqUrl, 'http://localhost').searchParams;
  const provided = params.get('token')
    || headers['x-lead-status-sync-token']
    || headers['x-lead-report-token']
    || '';
  const expectedBuffer = Buffer.from(LEAD_STATUS_SYNC_TRIGGER_SECRET);
  const providedBuffer = Buffer.from(String(provided));
  return providedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function isAuthorizedMqlDiscoveryReportTrigger(reqUrl, headers = {}) {
  if (!MQL_DISCOVERY_REPORT_TRIGGER_SECRET) return false;

  const params = new URL(reqUrl, 'http://localhost').searchParams;
  const provided = params.get('token')
    || headers['x-mql-discovery-report-token']
    || headers['x-lead-report-token']
    || '';
  const expectedBuffer = Buffer.from(MQL_DISCOVERY_REPORT_TRIGGER_SECRET);
  const providedBuffer = Buffer.from(String(provided));
  return providedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

async function runDailyProgress(channelOverride, options = {}) {
  const force = Boolean(options.force);
  const allowDuplicate = Boolean(options.allowDuplicate);
  const targetName = channelOverride || PROGRESS_TARGET_CHANNEL;
  try {
    const targetId = await resolveChannelId(targetName);
    if (!targetId) throw new Error(`Channel not found: #${targetName}`);

    const { latest, now, nowPacific, targetRunUtc, todayStartUtc, weekStartUtc, todayOldest } = getDailyProgressWindow();
    const dateLabel = formatPacificDateLabel(nowPacific);

    if (!force && !shouldRunDailyProgressOnPacificDay(nowPacific.weekdayIndex)) {
      console.log(`Daily progress: skipped non-reporting day ${dateLabel} PT`);
      return;
    }

    if (!force && now < targetRunUtc) {
      console.log(`Daily progress: deferred until ${targetRunUtc.toISOString()} for ${dateLabel} PT`);
      return;
    }

    const deals = await searchProgressDeals(weekStartUtc, now);
    const dealSummary = summarizeProgressDeals(deals, todayStartUtc);
    const weekInbound = dealSummary.week.inbound;
    const weekOutbound = dealSummary.week.outbound;
    const todayInbound = dealSummary.today.inbound;
    const todayOutbound = dealSummary.today.outbound;
    const weekUnknown = dealSummary.week.unknown;
    const todayUnknown = dealSummary.today.unknown;
    const todayTotal = todayInbound + todayOutbound + todayUnknown;
    const weekTotal = weekInbound + weekOutbound + weekUnknown;
    const remaining = Math.max(PROGRESS_WEEKLY_GOAL - weekTotal, 0);

    if (dealSummary.unknown.length) {
      const examples = dealSummary.unknown.slice(0, 5)
        .map(d => `${d.id}:${d.source}`)
        .join(', ');
      console.log(
        `Daily progress: counted ${dealSummary.unknown.length} unknown deals without Inbound/Outbound `
        + `${PROGRESS_DEAL_SOURCE_PROPERTY} prefix (${examples})`,
      );
    }
    if (dealSummary.skippedTests.length) {
      const examples = dealSummary.skippedTests.slice(0, 5)
        .map(d => `${d.id}:${d.dealname}`)
        .join(', ');
      console.log(`Daily progress: skipped ${dealSummary.skippedTests.length} obvious test/internal deals (${examples})`);
    }
    if (dealSummary.duplicates.length) {
      const examples = dealSummary.duplicates.slice(0, 5)
        .map(d => `${d.id}:${d.key}`)
        .join(', ');
      console.log(`Daily progress: deduped ${dealSummary.duplicates.length} duplicate deals (${examples})`);
    }

    if (!allowDuplicate) {
      const dupCheck = await app.client.conversations.history({
        token: process.env.SLACK_BOT_TOKEN,
        channel: targetId,
        oldest: String(todayOldest),
        latest: String(latest),
        inclusive: true,
        limit: 50,
      });
      const prefix = `Today ${dateLabel}`;
      const alreadyPosted = (dupCheck.messages || []).some(m => (m.text || '').startsWith(prefix));
      if (alreadyPosted) {
        console.log(`Daily progress: skipped duplicate for ${dateLabel} in #${targetName}`);
        return;
      }
    }

    const text = `Today ${dateLabel}\n`
      + `Inbound: ${todayInbound}\n`
      + `Outbound: ${todayOutbound}\n`
      + `Unknown: ${todayUnknown}\n`
      + `Total: ${todayTotal}\n`
      + `\n\n`
      + `This week so far\n`
      + `Inbound: ${weekInbound}\n`
      + `Outbound: ${weekOutbound}\n`
      + `Unknown: ${weekUnknown}\n`
      + `Total: ${weekTotal}\n`
      + `\n`
      + `Weekly Goal: ${fmtNum(PROGRESS_WEEKLY_GOAL)}\n`
      + `:star2: How many more do we need? ${fmtNum(remaining)}`;

    await app.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel: targetId,
      text,
    });
    console.log(
      `Daily progress: posted to #${targetName} from HubSpot deals `
      + `(today=${todayInbound}+${todayOutbound}+${todayUnknown}, week=${weekInbound}+${weekOutbound}+${weekUnknown})`,
    );
  } catch (err) {
    console.error('Daily progress error:', err.message);
  }
}

function scheduleDailyProgress() {
  const scheduleNext = () => {
    const { nextDate, nextRunUtc } = getNextDailyProgressRun();
    const delayMs = Math.max(nextRunUtc.getTime() - Date.now(), 1000);
    setTimeout(async () => {
      await runDailyProgress();
      scheduleNext();
    }, delayMs);
    console.log(
      `  Daily progress scheduled, next run: ${nextRunUtc.toISOString()} `
      + `(${nextDate.month}/${nextDate.day}/${String(nextDate.year).slice(-2)} `
      + `${String(PROGRESS_TARGET_HOUR).padStart(2, '0')}:${String(PROGRESS_TARGET_MINUTE).padStart(2, '0')} PT)`,
    );
  };

  runDailyProgress().catch(err => {
    console.error('Daily progress startup check error:', err.message);
  });
  scheduleNext();
}

function parseHubSpotFetchBody(options = {}) {
  if (!options.body) return null;
  if (typeof options.body === 'string') return JSON.parse(options.body);
  return options.body;
}

async function hubspotRequestFromFetchOptions(endpoint, options = {}) {
  return hubspotRequest(endpoint, options.method || 'GET', parseHubSpotFetchBody(options));
}

async function postLeadStatusSyncMessage(text, channelName = LEAD_STATUS_SYNC_TARGET_CHANNEL) {
  const targetId = await resolveChannelId(channelName);
  if (!targetId) throw new Error(`Channel not found: #${channelName}`);

  await app.client.chat.postMessage({
    token: process.env.SLACK_BOT_TOKEN,
    channel: targetId,
    text,
  });
}

async function runLeadStatusSyncForSlack(options = {}) {
  const stats = await runLeadStatusSync({
    ...options,
    targetChannel: options.targetChannel || LEAD_STATUS_SYNC_TARGET_CHANNEL,
    hubspot: options.hubspot || hubspotRequestFromFetchOptions,
    postSlackMessage: options.postSlackMessage || postLeadStatusSyncMessage,
    logger: console,
  });

  console.log(
    `Lead status sync: mode=${stats.mode} candidates=${stats.candidateCount} `
    + `updates=${stats.updatedContacts} status=${stats.statusUpdates} `
    + `touchpoints=${stats.touchpointUpdates} errors=${stats.errors}`,
  );
  return stats;
}

async function postMqlDiscoveryReport(options = {}) {
  const report = await buildMqlDiscoveryReport(hubspotRequest, {
    portalId: HUBSPOT_PORTAL_ID,
    now: options.now || new Date(),
  });
  const text = formatMqlDiscoveryReport(report);

  if (!options.skipSlack) {
    const channelName = options.channel || MQL_DISCOVERY_REPORT_TARGET_CHANNEL;
    const targetId = await resolveChannelId(channelName);
    if (!targetId) throw new Error(`Channel not found: #${channelName}`);
    await app.client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel: targetId,
      text,
    });
    console.log(`MQL discovery report: posted to #${channelName}`);
  }

  return {
    generatedAt: report.generatedAt,
    today: report.today,
    nextBusinessDay: report.nextBusinessDay,
    currentMqlNextBusinessDayCount: report.currentNextBusinessDayMqlDeals.length,
    todaysCallCount: report.todaysCallDeals.length,
    mqlAtStartCount: report.mqlAtStartCount,
    outcomeCounts: Object.fromEntries(
      Object.entries(report.outcomes).map(([key, deals]) => [key, deals.length]),
    ),
    dataQualityNoteCount: report.dataQualityNotes.length,
    text,
  };
}

function getNextMqlDiscoveryReportRun(referenceDate = new Date()) {
  const currentPacific = getPacificParts(referenceDate);
  let nextDate = {
    year: currentPacific.year,
    month: currentPacific.month,
    day: currentPacific.day,
  };
  let nextRunUtc = pacificLocalToUtcDate(
    nextDate.year,
    nextDate.month,
    nextDate.day,
    MQL_DISCOVERY_REPORT_TARGET_HOUR,
    MQL_DISCOVERY_REPORT_TARGET_MINUTE,
    0,
  );

  if (nextRunUtc <= referenceDate) {
    nextDate = shiftPacificDate(nextDate, 1);
    nextRunUtc = pacificLocalToUtcDate(
      nextDate.year,
      nextDate.month,
      nextDate.day,
      MQL_DISCOVERY_REPORT_TARGET_HOUR,
      MQL_DISCOVERY_REPORT_TARGET_MINUTE,
      0,
    );
  }

  return { nextDate, nextRunUtc };
}

function scheduleMqlDiscoveryReport() {
  const scheduleNext = () => {
    const { nextDate, nextRunUtc } = getNextMqlDiscoveryReportRun();
    const delayMs = Math.max(nextRunUtc.getTime() - Date.now(), 1000);
    setTimeout(async () => {
      try {
        await postMqlDiscoveryReport();
      } catch (err) {
        console.error('MQL discovery report scheduled run failed:', err.message);
      }
      scheduleNext();
    }, delayMs);
    console.log(
      `  MQL discovery report scheduled, next run: ${nextRunUtc.toISOString()} `
      + `(${nextDate.month}/${nextDate.day}/${String(nextDate.year).slice(-2)} `
      + `${String(MQL_DISCOVERY_REPORT_TARGET_HOUR).padStart(2, '0')}:`
      + `${String(MQL_DISCOVERY_REPORT_TARGET_MINUTE).padStart(2, '0')} PT)`,
    );
  };

  scheduleNext();
}

function getNextLeadStatusSyncRun(referenceDate = new Date()) {
  const currentPacific = getPacificParts(referenceDate);
  let nextDate = {
    year: currentPacific.year,
    month: currentPacific.month,
    day: currentPacific.day,
  };
  let nextRunUtc = pacificLocalToUtcDate(
    nextDate.year,
    nextDate.month,
    nextDate.day,
    LEAD_STATUS_SYNC_TARGET_HOUR,
    LEAD_STATUS_SYNC_TARGET_MINUTE,
    0,
  );

  if (nextRunUtc <= referenceDate) {
    nextDate = shiftPacificDate(nextDate, 1);
    nextRunUtc = pacificLocalToUtcDate(
      nextDate.year,
      nextDate.month,
      nextDate.day,
      LEAD_STATUS_SYNC_TARGET_HOUR,
      LEAD_STATUS_SYNC_TARGET_MINUTE,
      0,
    );
  }

  return { nextDate, nextRunUtc };
}

function leadStatusSyncModeForDate(date = new Date()) {
  return LEAD_STATUS_SYNC_WEEKLY_FULL_DAY != null
    && getPacificParts(date).weekdayIndex === LEAD_STATUS_SYNC_WEEKLY_FULL_DAY
    ? 'full'
    : 'incremental';
}

function scheduleLeadStatusSync() {
  const scheduleNext = () => {
    const { nextDate, nextRunUtc } = getNextLeadStatusSyncRun();
    const delayMs = Math.max(nextRunUtc.getTime() - Date.now(), 1000);
    setTimeout(async () => {
      try {
        await runLeadStatusSyncForSlack({ mode: leadStatusSyncModeForDate(new Date()) });
      } catch (err) {
        console.error('Lead status sync scheduled run failed:', err.message);
        try {
          await postLeadStatusSyncMessage(`Lead status sync failed: ${err.message}`);
        } catch (slackErr) {
          console.error('Lead status sync failure Slack post failed:', slackErr.message);
        }
      }
      scheduleNext();
    }, delayMs);
    console.log(
      `  Lead status sync scheduled, next run: ${nextRunUtc.toISOString()} `
      + `(${nextDate.month}/${nextDate.day}/${String(nextDate.year).slice(-2)} `
      + `${String(LEAD_STATUS_SYNC_TARGET_HOUR).padStart(2, '0')}:`
      + `${String(LEAD_STATUS_SYNC_TARGET_MINUTE).padStart(2, '0')} PT)`,
    );
  };

  scheduleNext();
}

function startHttpServer() {
  // Health check server for Railway (needs a port to know the service is alive)
  const PORT = process.env.PORT || 3000;
  const server = http.createServer(async (req, res) => {
    if (req.url.split('?')[0] === '/webhooks/instantly/positive-reply') {
      try {
        await handleInstantlyPositiveReplyWebhook(req, res, {
          slackClient: app.client,
          slackToken: process.env.SLACK_BOT_TOKEN,
          channel: INSTANTLY_POSITIVE_REPLY_CHANNEL,
          mentionUserId: INSTANTLY_POSITIVE_REPLY_MENTION_USER_ID,
          webhookSecret: INSTANTLY_WEBHOOK_SECRET,
          logger: console,
        });
      } catch (err) {
        console.error('Instantly positive reply webhook failed:', err.message);
        res.writeHead(500);
        res.end('webhook_failed');
      }
      return;
    }
    if (req.method === 'POST' && req.url.split('?')[0] === '/webhooks/calendly') {
      try {
        await handleCalendlyHubSpotWebhook(req, res, { logger: console });
      } catch (err) {
        console.error('Calendly HubSpot webhook failed:', err.message);
        res.writeHead(500);
        res.end('webhook_failed');
      }
      return;
    }
    if (req.url.split('?')[0] === '/run-mql-discovery-report') {
      const qs = new URL(req.url, 'http://localhost').searchParams;
      if (!isAuthorizedMqlDiscoveryReportTrigger(req.url, req.headers)) {
        res.writeHead(401);
        res.end('unauthorized');
        return;
      }
      try {
        const stats = await postMqlDiscoveryReport({
          channel: qs.get('channel') || undefined,
          skipSlack: qs.get('skipSlack') === '1' || qs.get('skipSlack') === 'true',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
      } catch (err) {
        console.error('MQL discovery report manual trigger failed:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    if (req.url.split('?')[0] === '/run-daily-progress') {
      const qs = new URL(req.url, 'http://localhost').searchParams;
      if (!isAuthorizedProgressTrigger(req.url, req.headers)) {
        res.writeHead(401);
        res.end('unauthorized');
        return;
      }
      runDailyProgress(undefined, {
        force: true,
        allowDuplicate: qs.get('allowDuplicate') === '1',
      });
      res.writeHead(200);
      res.end('Daily progress triggered');
      return;
    }
    if (req.url.split('?')[0] === '/run-lead-status-sync') {
      const qs = new URL(req.url, 'http://localhost').searchParams;
      if (!isAuthorizedLeadStatusSyncTrigger(req.url, req.headers)) {
        res.writeHead(401);
        res.end('unauthorized');
        return;
      }
      try {
        const stats = await runLeadStatusSyncForSlack({
          mode: qs.get('mode') === 'full' ? 'full' : 'incremental',
          dryRun: qs.get('dryRun') === '1' || qs.get('dryRun') === 'true',
          skipSlack: qs.get('skipSlack') === '1' || qs.get('skipSlack') === 'true',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
      } catch (err) {
        console.error('Lead status sync manual trigger failed:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    res.writeHead(200);
    res.end('ok');
  }).listen(PORT, () => {
    console.log(`  Health check on port ${PORT}`);
  });
  return server;
}

async function startSlackBot() {
  const shouldRunMqlDiscoveryReportCli = process.argv.includes('--run-mql-discovery-report');
  if (shouldRunMqlDiscoveryReportCli) {
    const skipSlack = process.argv.includes('--skip-slack');
    const stats = await postMqlDiscoveryReport({ skipSlack });
    if (skipSlack) console.log(stats.text);
    return;
  }

  startHttpServer();

  let slackStarted = false;
  try {
    await app.start();
    slackStarted = true;
    console.log('Slack bot is running in socket mode');
  } catch (err) {
    console.error('Slack socket mode failed to start; HTTP webhook routes remain available:', err.message);
  }
  console.log(`  Google Sheets: ready`);
  console.log(`  HubSpot: ${HUBSPOT_TOKEN ? 'ready' : 'NOT CONFIGURED'}`);
  console.log(`  Firecrawl: ${FIRECRAWL_API_KEY ? 'ready' : 'NOT CONFIGURED'}`);

  if (!slackStarted) return;

  // Schedule Slack posts only after Slack is connected.
  scheduleMqlDiscoveryReport();
  scheduleDailyProgress();
  scheduleLeadStatusSync();

  // Manual CLI trigger is handled before socket mode starts so it posts once and exits.
}

if (require.main === module) {
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled async error:', err?.message || err);
  });

  startSlackBot().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  TOOLS,
  TRUEWIND_HUBSPOT,
  buildDealNoteBody,
  buildRecruitingCalendarInvite,
  classifyProgressDealSource,
  compactProperties,
  countHubSpotDealsEnteredStage,
  analyzeHubSpotDealActivities,
  activityDisplayFields,
  matchingActivityKeywords,
  createRecruitingCalendarInvite,
  deduceLeadSource,
  dealEnteredStageInRange,
  executeTool,
  findRecruitingCandidateByEmail,
  extractStructuredBlockField,
  firstOutcomeAfterEntry,
  formatProspectWorkflowResponse,
  formatWorkflowError,
  getSystemPrompt,
  getSlackMetadata,
  grainRecordingMatchesSearch,
  hubSpotPipelineEndpoint,
  hubSpotObjectType,
  hubspotPrimaryAssociatedRecordUrl,
  hubspotPropertyCache,
  hubspotRecordUrl,
  isHubSpotWriteAuthorized,
  isReadOnlyHubSpotProperty,
  isRecruitingCalendarWriteAuthorized,
  hasRecruitingCalendarTitleInput,
  listRecruitingOutstandingCandidates,
  notionPropValue,
  recruitingCalendarTitleFromCandidate,
  recruitingNotionPropertyMap,
  normalizeHubSpotPropertyValue,
  normalizeHubSpotOutcomeTracking,
  parseHubSpotAsOfBoundary,
  parseHubSpotDateBoundary,
  parseGrainSearchDateRange,
  parseStructuredDealRequest,
  parseProgressDealSourceProperty,
  postMqlDiscoveryReport,
  redactedToolInputForLog,
  resolveDealHubSpotOwner,
  runLeadStatusSyncForSlack,
  resolveHubSpotOwner,
  resolveHubSpotOwnerForProspect,
  runStructuredDealCreateWorkflow,
  shouldSetLifecycleToOpportunity,
  startSlackBot,
  summarizeHubSpotStageCohortOutcomes,
  validateHubSpotProperties,
};
