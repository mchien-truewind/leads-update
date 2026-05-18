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
  buildDiscoveryDigestConfig,
  dedupeDigestMeetings,
  dedupeGrainRecordings,
  findBestGrainRecordingForMeeting,
  formatEmptyDiscoveryDigestMessage,
  formatGrainTranscriptText,
  formatNoShowMeetingLabel,
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

const TRUEWIND_HUBSPOT = {
  pipeline: '105321581',
  mqlDealStage: '1307720553',
  convertedLeadStatus: 'MQL',
  defaultLeadStatus: 'No one has contacted them',
  defaultOutboundLeadSource: 'Outbound - Sales Sourced List',
  defaultOwnerId: '89305622',
  defaultOwnerName: 'Xavier Marco',
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
    'aidan gleghorn': { id: '89053735', name: 'Aidan Gleghorn' },
    aidan: { id: '89053735', name: 'Aidan Gleghorn' },
    'noah salah': { id: '90960689', name: 'Noah Salah' },
    noah: { id: '90960689', name: 'Noah Salah' },
    'jenilee chen': { id: '91143842', name: 'Jenilee Chen' },
    jenilee: { id: '91143842', name: 'Jenilee Chen' },
    'sarah elix': { id: '84547076', name: 'Sarah Elix' },
    sarah: { id: '84547076', name: 'Sarah Elix' },
  },
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

const SLACK_TO_HUBSPOT_OWNER = parseSlackOwnerMap();
const hubspotContactPropertyCache = new Map();
const hubspotPropertyCache = new Map();

function parseDelimitedEnvSet(name) {
  return new Set(String(process.env[name] || '').split(',').map((value) => value.trim()).filter(Boolean));
}

const HUBSPOT_WRITE_ALLOWED_SLACK_USER_IDS = parseDelimitedEnvSet('HUBSPOT_WRITE_ALLOWED_SLACK_USER_IDS');
const HUBSPOT_WRITE_ALLOWED_SLACK_CHANNEL_IDS = parseDelimitedEnvSet('HUBSPOT_WRITE_ALLOWED_SLACK_CHANNEL_IDS');
const HUBSPOT_WRITE_REQUIRE_AUTH = process.env.HUBSPOT_WRITE_REQUIRE_AUTH !== 'false';

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
    url: `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/${objectTypeId}/${id}`,
    properties,
  };
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
  const notes = extractStructuredField(clean, 'Notes');

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

  const owner = resolveHubSpotOwner({ owner_name: input.owner_name, context: input.context, slack_user_id: input.slack_user_id, channel_id: input.channel_id });
  const authorization = isHubSpotWriteAuthorized(input, owner);
  if (!authorization.authorized) {
    return `Error: not authorized to write to HubSpot: ${authorization.reason}. No HubSpot deal was created.`;
  }

  const partial = {};
  try {
    const nameParts = splitFullName(input.contact, email);
    const companyName = String(input.company || '').trim();
    const inferred = inferCompanyFromEmail(email);
    const leadSource = input.lead_source || deduceLeadSource(input.context || input.notes || '');

    const existingContact = await findContactByEmail(email);
    let contactRes = existingContact;
    if (!contactRes) {
      const contactProps = await validateHubSpotProperties('contacts', compactProperties({
        email,
        firstname: nameParts.firstname,
        lastname: nameParts.lastname,
        company: companyName,
        lead_source: leadSource,
        hubspot_owner_id: owner.id,
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
      hubspot_owner_id: owner.id,
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

    const noteLines = [
      input.type ? `Type: ${input.type}` : '',
      input.meeting_booked ? `Meeting booked for: ${input.meeting_booked}` : '',
      input.notes ? `Notes: ${input.notes}` : '',
    ].filter(Boolean);
    if (noteLines.length) {
      await createStructuredDealNote({
        dealId,
        contactId,
        companyId,
        body: noteLines.join('<br>'),
      }).catch((err) => {
        console.error(`Structured deal note create failed: ${err.message}`);
      });
    }

    const dealUrl = `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-3/${dealId}`;
    const contactUrl = `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${contactId}`;
    const companyUrl = `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-2/${companyId}`;
    return [
      `:white_check_mark: Deal created: ${dealName}`,
      `Deal ID: ${dealId}`,
      `Deal link: ${dealUrl}`,
      `Contact ID: ${contactId}`,
      `Contact link: ${contactUrl}`,
      `Company ID: ${companyId}`,
      `Company link: ${companyUrl}`,
    ].join('\n');
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
  const linkedinLine = summary.linkedinUrl
    ? `✓ LinkedIn found: ${summary.linkedinUrl}`
    : `✓ LinkedIn found: not found; used email/company fallback${summary.linkedinError ? ` (${summary.linkedinError})` : ''}`;
  const title = summary.contact.jobtitle ? `, ${summary.contact.jobtitle}` : '';
  return [
    linkedinLine,
    `✓ Contact created/updated: ${summary.contact.name}${title} at ${summary.company.name} (ID: ${summary.contact.id})`,
    `✓ Deal ${summary.deal.created ? 'created' : 'matched'}: ${summary.deal.name} (ID: ${summary.deal.id})`,
    `✓ Company ${summary.company.created ? 'created' : 'matched'}: ${summary.company.name} (ID: ${summary.company.id})`,
    `✓ Owner: ${summary.owner.name} (${summary.owner.source})`,
    `✓ Lead source: ${summary.leadSource}`,
  ].join('\n');
}

async function runTruewindHubSpotProspectWorkflow(input) {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) {
    return 'Missing required email. Please provide a valid prospect email address before I push this to HubSpot.';
  }

  const context = input.context || input.context_text || input.notes || '';
  const parsedName = parseNameFromEmail(email);
  const inferred = inferCompanyFromEmail(email);
  const owner = await resolveHubSpotOwnerForProspect(input);
  const authorization = isHubSpotWriteAuthorized(input, owner);
  if (!authorization.authorized) {
    return `Not authorized to write to HubSpot: ${authorization.reason}. Ask an admin to set HUBSPOT_WRITE_ALLOWED_SLACK_USER_IDS or HUBSPOT_WRITE_ALLOWED_SLACK_CHANNEL_IDS, or map your Slack account to a HubSpot owner.`;
  }
  const leadSource = input.lead_source || deduceLeadSource(context);
  const erp = input.erp || '';

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
      hubspot_owner_id: owner.id,
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
      hubspot_owner_id: owner.id,
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
      owner,
      leadSource,
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
    name: 'hubspot_push_truewind_prospect',
    description: 'End-to-end Truewind HubSpot workflow. Use this when asked to push/add/create a prospect, lead, opportunity, or new deal in HubSpot. It requires email, enriches LinkedIn via Firecrawl, creates/updates contact first, creates the MQL deal, creates all required associations, sets contact lifecycle to opportunity and lead status internal value MQL, and returns exact IDs.',
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
        lead_source: { type: 'string', description: 'Optional lead source only if explicitly known. Otherwise the tool deduces it from context.' },
        amount: { type: 'number', description: 'Optional deal amount if specified.' },
        closedate: { type: 'string', description: 'Optional close date if specified, in HubSpot-compatible date format.' },
      },
      required: ['email'],
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
    description: 'Create a new deal in HubSpot. Active Pipeline ID is 105321581. Stages: MQL=1307720553, SQL=190380582, Full Product Demo=190380583, POC=190380586, Proposal=190380584, Won=1166230571, Closed/Lost=190380587.',
    input_schema: {
      type: 'object',
      properties: {
        dealname: { type: 'string', description: 'Deal name' },
        pipeline: { type: 'string', description: 'Pipeline ID (default: Active Pipeline 105321581)' },
        dealstage: { type: 'string', description: 'Stage ID' },
        amount: { type: 'number', description: 'Deal amount' },
        properties: {
          type: 'object',
          description: 'Writable deal properties (e.g. hubspot_owner_id, closedate). Do not include HubSpot read-only/system fields such as hs_deal_stage_probability_shadow, notes_last_updated, or hs_object_source_detail_1.',
        },
      },
      required: ['dealname', 'dealstage'],
    },
  },
  {
    name: 'hubspot_update_deal',
    description: 'Update an existing HubSpot deal by ID.',
    input_schema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string', description: 'The deal ID to update' },
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
      },
      required: ['from_type', 'from_id', 'to_type', 'to_id', 'association_type_id'],
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
async function executeTool(name, input) {
  try {
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
      const props = { dealname: input.dealname, dealstage: input.dealstage, pipeline: input.pipeline || '105321581' };
      if (input.amount) props.amount = String(input.amount);
      if (input.properties) Object.assign(props, input.properties);
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
    if (name === 'hubspot_get_associations') {
      const res = await hubspotRequest(`/crm/v4/objects/${input.from_type}/${input.from_id}/associations/${input.to_type}`);
      return JSON.stringify(res.results || []);
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
  return `You are Truewind's internal AI assistant in Slack. You have tools for Google Sheets, HubSpot CRM, and Grain meeting transcripts. You MUST use them when asked to take actions. NEVER say you can't do something -- you have the tools, use them.

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

### Truewind prospect push workflow
When the current message itself is a structured request to create a new deal with fields like Company, Contact, Email, Deal owner, Source, Meeting booked, and Notes, the backend handles it directly before Claude runs. If you are responding after that flow, only relay the tool's concrete ID/link result. Do not add unrelated thread summaries.

When someone asks you to add, push, create, or update a prospect/lead/opportunity/deal in HubSpot, use hubspot_push_truewind_prospect. Do not manually chain the low-level HubSpot write tools unless the user asks for a custom one-off update.

Rules enforced by the backend tool:
- Contact first, deal second. Contact is the anchor record.
- Email is required. If email is missing, ask for it.
- Company is required, but the tool can infer it from LinkedIn or a non-generic email domain. Only ask if the tool says company is unclear.
- The tool searches Firecrawl for LinkedIn, stores the LinkedIn URL in Truewind's writable HubSpot LinkedIn contact property, creates or updates the contact, creates or matches a deal in pipeline 105321581 at MQL stage 1307720553, creates contact-company, deal-contact, and deal-company associations, then updates the contact to lifecycle opportunity and lead status internal value MQL (HubSpot label Converted).
- Pass the full Slack request/thread in the context field so the backend can deduce lead source.
- Pass channel_id and slack_user_id from Slack metadata when present. The backend uses them for HubSpot write authorization and owner mapping. If the user explicitly names an owner, pass owner_name; explicit owner_name overrides Slack owner mapping. Otherwise it looks up the Slack user's HubSpot owner by Slack email, then uses any configured Slack mapping, otherwise defaults to Xavier.
- Never ask for deal stage, owner, ERP, name/title, or lead source unless the backend tool explicitly needs clarification.
- Never say done without actual contact and deal IDs from the tool result. If the tool fails, show the exact error.
- Do not pass read-only HubSpot properties into low-level write tools. The backend validates properties before write and will reject system-managed fields such as hs_deal_stage_probability_shadow, notes_last_updated, and hs_object_source_detail_1.

Lead source deduction:
- "met at [conference/event]" -> Event
- "reached out" or "contacted" -> Outbound - Sales Sourced List
- "they contacted us" or "inbound" -> Self serve
- "webinar" -> Webinar
- "referred by" -> Referral
- default -> Outbound - Sales Sourced List

Key owner IDs:
- Xavier Marco: 89305622
- Mercedes Chien: 87811681
- Alex Lee: 559564379
- Aidan Gleghorn: 89053735
- Noah Salah: 90960689
- Jenilee Chen: 91143842
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

async function handleMessage(text, threadTs, channel, isThread, say, slackUserId = '') {
  const cleanText = stripMention(text);
  if (!cleanText) return;

  console.log(`handleMessage: channel=${channel}, threadTs=${threadTs}, isThread=${isThread}, text="${cleanText}"`);

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

  const fetched = await fetchThreadHistory(channel, threadTs, isThread);
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
        console.log(`Tool call: ${block.name}(${JSON.stringify(block.input)})`);
        const result = await executeTool(block.name, block.input);
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
    await say({ text: `My brain suddenly fried. :cry: Please try again in a few seconds.`, thread_ts: threadTs });
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

const PROGRESS_TARGET_CHANNEL = process.env.LEAD_REPORT_TARGET_CHANNEL || 'gtm-general';
const PROGRESS_DEAL_SOURCE_PROPERTY = process.env.LEAD_REPORT_DEAL_SOURCE_PROPERTY || 'deal_source';
const PROGRESS_PIPELINE_ID = process.env.LEAD_REPORT_PIPELINE_ID || '105321581';
const PROGRESS_TRIGGER_SECRET = process.env.LEAD_REPORT_TRIGGER_SECRET || '';
const PROGRESS_WEEKLY_GOAL = parseProgressWeeklyGoal(process.env.LEAD_REPORT_WEEKLY_GOAL);
const PROGRESS_TEST_DEAL_PATTERNS = [/\btest\b/i, /truewind/i];
const PROGRESS_TIMEZONE = 'America/Los_Angeles';
const PROGRESS_TARGET_HOUR = 18;
const PROGRESS_TARGET_MINUTE = 7;
const PROGRESS_ALLOWED_WEEKDAY_INDEXES = new Set([0, 1, 2, 3, 4, 5]); // Sunday, Monday-Friday.
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
    if (req.url.startsWith('/run-digest')) {
      const qs = new URL(req.url, 'http://localhost').searchParams;
      const channel = qs.get('channel') || undefined;
      runDiscoveryDigest(channel);
      res.writeHead(200);
      res.end(`Digest triggered${channel ? ` → #${channel}` : ''}`);
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
    res.writeHead(200);
    res.end('ok');
  }).listen(PORT, () => {
    console.log(`  Health check on port ${PORT}`);
  });
  return server;
}

async function startSlackBot() {
  const shouldRunDigestCli = process.argv.includes('--run-digest');
  if (shouldRunDigestCli) {
    await runDiscoveryDigest();
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
  console.log(`  Grain: ${GRAIN_API_TOKEN ? 'ready' : 'NOT CONFIGURED'}`);

  if (!slackStarted) return;

  // Schedule daily discovery digest and HubSpot deal progress only after Slack is connected.
  scheduleDiscoveryDigest();
  scheduleDailyProgress();

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
  TRUEWIND_HUBSPOT,
  compactProperties,
  deduceLeadSource,
  executeTool,
  formatWorkflowError,
  getSlackMetadata,
  hubspotPropertyCache,
  isHubSpotWriteAuthorized,
  isReadOnlyHubSpotProperty,
  normalizeHubSpotPropertyValue,
  parseStructuredDealRequest,
  resolveHubSpotOwner,
  resolveHubSpotOwnerForProspect,
  runStructuredDealCreateWorkflow,
  shouldSetLifecycleToOpportunity,
  startSlackBot,
  validateHubSpotProperties,
};
