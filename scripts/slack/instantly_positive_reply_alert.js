const crypto = require('crypto');

const DEFAULT_CHANNEL = 'gtm-outbound';
const POSITIVE_EVENT_TYPES = new Set([
  'lead_interested',
  'lead_positive',
  'positive_reply',
]);

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function truncate(value, maxLength = 800) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function normalizeChannel(value) {
  const channel = firstNonEmpty(value, DEFAULT_CHANNEL);
  return channel.startsWith('#') ? channel.slice(1) : channel;
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function readHeader(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
  }
  return '';
}

function validateWebhookSecret(headers, expectedSecret) {
  if (!expectedSecret) return true;
  const received = firstNonEmpty(
    readHeader(headers, 'x-instantly-webhook-secret'),
    readHeader(headers, 'x-webhook-secret'),
    readHeader(headers, 'authorization').replace(/^Bearer\s+/i, ''),
  );
  return timingSafeEqualString(received, expectedSecret);
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
  return output;
}

function eventLooksPositive(payload) {
  const strings = collectStrings(payload).map(value => value.toLowerCase());
  const explicitEvent = firstNonEmpty(
    payload.event_type,
    payload.eventType,
    payload.event,
    payload.type,
  ).toLowerCase();

  if (explicitEvent && POSITIVE_EVENT_TYPES.has(explicitEvent)) return true;
  if (strings.some(value => POSITIVE_EVENT_TYPES.has(value))) return true;

  const interestStatus = firstNonEmpty(
    payload.interest_status_label,
    payload.interestStatusLabel,
    payload.lead?.interest_status_label,
    payload.lead?.interestStatusLabel,
    payload.label?.interest_status_label,
    payload.label?.interestStatusLabel,
  ).toLowerCase();
  if (interestStatus === 'positive') return true;

  const labels = strings.filter(value => value.includes('positive') || value.includes('interested'));
  return labels.some(value => value === 'positive' || value === 'interested' || value.includes('positive reply'));
}

function eventLooksNonPositive(payload) {
  const explicitEvent = firstNonEmpty(
    payload.event_type,
    payload.eventType,
    payload.event,
    payload.type,
  ).toLowerCase();
  if (explicitEvent && !POSITIVE_EVENT_TYPES.has(explicitEvent) && explicitEvent.startsWith('lead_')) {
    return true;
  }

  const status = firstNonEmpty(
    payload.interest_status_label,
    payload.interestStatusLabel,
    payload.lead?.interest_status_label,
    payload.lead?.interestStatusLabel,
    payload.label?.interest_status_label,
    payload.label?.interestStatusLabel,
  ).toLowerCase();
  return ['negative', 'neutral'].includes(status);
}

function extractLead(payload) {
  const lead = payload.lead || payload.data?.lead || payload.payload?.lead || payload;
  const campaign = payload.campaign || payload.data?.campaign || payload.payload?.campaign || lead.campaign || {};
  const email = firstNonEmpty(
    lead.email,
    lead.email_address,
    lead.emailAddress,
    payload.lead_email,
    payload.leadEmail,
    payload.email,
    payload.email_address,
  );
  const firstName = firstNonEmpty(lead.first_name, lead.firstName, payload.first_name, payload.firstName);
  const lastName = firstNonEmpty(lead.last_name, lead.lastName, payload.last_name, payload.lastName);
  const name = firstNonEmpty(lead.name, payload.name, [firstName, lastName].filter(Boolean).join(' '));
  const company = firstNonEmpty(lead.company_name, lead.companyName, lead.company, payload.company_name, payload.company);
  const title = firstNonEmpty(lead.title, lead.job_title, lead.jobTitle, payload.title, payload.job_title);
  const campaignName = firstNonEmpty(
    campaign.name,
    campaign.campaign_name,
    campaign.campaignName,
    lead.campaign_name,
    payload.campaign_name,
    payload.campaignName,
  );
  const campaignId = firstNonEmpty(
    campaign.id,
    campaign.campaign_id,
    campaign.campaignId,
    lead.campaign,
    lead.campaign_id,
    payload.campaign,
    payload.campaign_id,
    payload.campaignId,
  );
  const replyText = stripHtml(firstNonEmpty(
    payload.reply_text,
    payload.replyText,
    payload.email?.body?.text,
    payload.email?.body?.html,
    payload.message?.text,
    payload.message?.body,
    payload.body?.text,
    payload.body?.html,
    payload.text,
  ));
  const instantlyUrl = firstNonEmpty(
    payload.url,
    payload.instantly_url,
    payload.instantlyUrl,
    lead.url,
    lead.instantly_url,
    lead.instantlyUrl,
  );

  return {
    email,
    name,
    company,
    title,
    campaignName,
    campaignId,
    replyText,
    instantlyUrl,
  };
}

function formatPositiveReplyMessage(payload, options = {}) {
  const mentionUserId = firstNonEmpty(options.mentionUserId);
  if (!mentionUserId) {
    throw new Error('Missing Instantly positive reply mention user id');
  }

  const lead = extractLead(payload);
  const identity = firstNonEmpty(
    [lead.name, lead.title, lead.company].filter(Boolean).join(' | '),
    lead.email,
    'Unknown lead',
  );
  const lines = [
    `<@${mentionUserId}> *Positive Instantly reply*`,
    `Lead: ${identity}`,
  ];

  if (lead.email && lead.email !== identity) lines.push(`Email: ${lead.email}`);
  if (lead.campaignName) lines.push(`Campaign: ${lead.campaignName}`);
  else if (lead.campaignId) lines.push(`Campaign ID: ${lead.campaignId}`);
  if (lead.replyText) lines.push(`Reply: ${truncate(lead.replyText)}`);
  if (lead.instantlyUrl) lines.push(`Instantly: ${lead.instantlyUrl}`);

  return lines.join('\n');
}

function parseJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
        reject(new Error('Webhook payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error(`Invalid JSON payload: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

async function handleInstantlyPositiveReplyWebhook(req, res, options) {
  const {
    slackClient,
    slackToken,
    channel = DEFAULT_CHANNEL,
    mentionUserId,
    webhookSecret = '',
    logger = console,
  } = options;

  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    res.end('method_not_allowed');
    return true;
  }

  if (!validateWebhookSecret(req.headers, webhookSecret)) {
    res.writeHead(401);
    res.end('unauthorized');
    return true;
  }

  let payload;
  try {
    payload = await parseJsonBody(req);
  } catch (err) {
    res.writeHead(400);
    res.end(err.message);
    return true;
  }

  if (eventLooksNonPositive(payload) && !eventLooksPositive(payload)) {
    res.writeHead(202);
    res.end('ignored_non_positive');
    return true;
  }

  if (!eventLooksPositive(payload)) {
    res.writeHead(202);
    res.end('ignored_unknown_event');
    return true;
  }

  let text;
  try {
    text = formatPositiveReplyMessage(payload, { mentionUserId });
  } catch (err) {
    logger.error(`Instantly positive reply alert skipped: ${err.message}`);
    res.writeHead(500);
    res.end('missing_mention_user_id');
    return true;
  }

  try {
    await slackClient.chat.postMessage({
      token: slackToken,
      channel: normalizeChannel(channel),
      text,
    });
    res.writeHead(200);
    res.end('ok');
    return true;
  } catch (err) {
    logger.error(`Instantly positive reply Slack post failed: ${err.message}`);
    res.writeHead(502);
    res.end('slack_post_failed');
    return true;
  }
}

module.exports = {
  DEFAULT_CHANNEL,
  POSITIVE_EVENT_TYPES,
  eventLooksPositive,
  eventLooksNonPositive,
  extractLead,
  formatPositiveReplyMessage,
  handleInstantlyPositiveReplyWebhook,
  normalizeChannel,
  truncate,
  validateWebhookSecret,
};
