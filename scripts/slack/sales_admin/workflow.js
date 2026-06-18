const path = require('path');
const https = require('https');
const {
  dedupeDigestMeetings,
  dedupeGrainRecordings,
  findBestGrainRecordingForMeeting,
  formatGrainTranscriptText,
  getGrainParticipantEmails,
  getGrainRecordingId,
  getGrainRecordingStartMs,
  getGrainRecordingTitle,
  getGrainRecordingUrl,
  normalizeDigestText,
} = require('../discovery_digest');
const { GrainClient } = require('./grain_client');
const { HubSpotSalesAdminClient } = require('./hubspot_sales_admin');
const { createSalesAdminState } = require('./state');

const DEFAULT_AE_ROSTER = [
  { name: 'Xavier Marco', hubspotOwnerId: '89305622', email: 'xavier@trytruewind.com', slackUserId: 'U0AKMHVCJMA', salesAdminChannel: 'gtm-salesadmin-xavier' },
  { name: 'Sarah Elix', hubspotOwnerId: '84547076', email: 'sarah@trytruewind.com', slackUserId: 'U09QC3B292R', salesAdminChannel: 'gtm-salesadmin-sarah' },
  { name: 'Jenilee Chen', hubspotOwnerId: '91143842', email: 'jenilee@trytruewind.com', slackUserId: 'U0ATZSNCE5T', salesAdminChannel: 'gtm-salesadmin-jenilee' },
  { name: 'Mercedes Chien', hubspotOwnerId: '87811681', email: 'mercedes@trytruewind.com', slackUserId: 'U0ABULY5TEK', salesAdminChannel: 'gtm-salesadmin-mercedes' },
  { name: 'Alex Lee', hubspotOwnerId: '559564379', email: 'alex@trytruewind.com', slackUserId: 'U04BPMPR29G', salesAdminChannel: 'gtm-salesadmin-alex' },
  { name: 'Amy Vetter', hubspotOwnerId: '92555980', email: 'amy@trytruewind.com', slackUserId: 'U0B4MRN83FE', salesAdminChannel: 'gtm-salesadmin-amy' },
];

const INTERNAL_DOMAINS = new Set(['trytruewind.com']);
const POST_ACTIONS = {
  confirm: 'sales_admin_confirm',
  edit: 'sales_admin_edit',
  stageSelect: 'sales_admin_stage_select',
  noShow: 'sales_admin_no_show',
  ignore: 'sales_admin_ignore',
  editSubmit: 'sales_admin_edit_submit',
};

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseNumber(value, defaultValue) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseRoster(rawValue = '') {
  const raw = String(rawValue || '').trim();
  const roster = raw ? JSON.parse(raw) : DEFAULT_AE_ROSTER;
  if (!Array.isArray(roster)) throw new Error('SALES_ADMIN_AE_ROSTER_JSON must be a JSON array');
  return roster.map((item, index) => {
    const ae = {
      name: String(item.name || '').trim(),
      hubspotOwnerId: String(item.hubspotOwnerId || item.hubspot_owner_id || '').trim(),
      email: String(item.email || '').trim().toLowerCase(),
      slackUserId: String(item.slackUserId || item.slack_user_id || '').trim(),
      salesAdminChannel: String(item.salesAdminChannel || item.sales_admin_channel || item.channel || '').trim().replace(/^#/, ''),
    };
    const missing = ['name', 'hubspotOwnerId', 'email', 'slackUserId', 'salesAdminChannel'].filter(key => !ae[key]);
    if (missing.length) throw new Error(`AE roster item ${index + 1} missing: ${missing.join(', ')}`);
    return ae;
  });
}

function buildConfig(env = process.env) {
  return {
    enabled: parseBoolean(env.SALES_ADMIN_ENABLED, false),
    timezone: env.SALES_ADMIN_TZ || 'America/Los_Angeles',
    morningHour: parseNumber(env.SALES_ADMIN_MORNING_HOUR, 8),
    morningMinute: parseNumber(env.SALES_ADMIN_MORNING_MINUTE, 0),
    tomorrowHour: parseNumber(env.SALES_ADMIN_TOMORROW_HOUR, 17),
    tomorrowMinute: parseNumber(env.SALES_ADMIN_TOMORROW_MINUTE, 0),
    postMeetingDelayMin: parseNumber(env.SALES_ADMIN_POST_MEETING_DELAY_MIN, 10),
    postMeetingLookbackHours: parseNumber(env.SALES_ADMIN_POST_MEETING_LOOKBACK_HOURS, 2),
    scanIntervalMin: parseNumber(env.SALES_ADMIN_SCAN_MIN, 5),
    cancelScanMin: parseNumber(env.SALES_ADMIN_CANCEL_SCAN_MIN, 5),
    cancelLookbackMin: parseNumber(env.SALES_ADMIN_CANCEL_LOOKBACK_MIN, 30),
    cancelPastGraceHours: parseNumber(env.SALES_ADMIN_CANCEL_PAST_GRACE_HOURS, 24),
    createTasks: parseBoolean(env.SALES_ADMIN_CREATE_TASKS, false),
    portalId: env.HUBSPOT_PORTAL_ID || '43974586',
    statePath: env.SALES_ADMIN_STATE_PATH || path.resolve(process.cwd(), 'data/sales_admin_state.json'),
    hubspotNextStepProperty: env.SALES_ADMIN_HUBSPOT_NEXT_STEP_PROPERTY || 'hs_next_step',
    grainToken: env.GRAIN_API_TOKEN || env.GRAIN_API || env.GRAIN_ACCESS_TOKEN || env.GRAIN_WORKSPACE_TOKEN || '',
    grainBaseUrl: env.GRAIN_API_BASE || 'https://api.grain.com/_/public-api/v2',
    grainTeamId: String(env.SALES_ADMIN_GRAIN_TEAM_ID || '').trim(),
    calendlyToken: env.CALENDLY_API_MASTER || env.CALENDLY_API || env.CALENDLY_API_KEY || '',
    calendlyBaseUrl: (env.CALENDLY_API_BASE || 'https://api.calendly.com').replace(/\/$/, ''),
    calendlyOrganization: String(env.CALENDLY_ORGANIZATION || '').trim(),
    roster: parseRoster(env.SALES_ADMIN_AE_ROSTER_JSON),
  };
}

// Calendly is the source of truth for booked intro meetings. AE Calendly user URIs,
// keyed by work email (stable; avoids HubSpot owner-id ambiguity). Pulled from the
// Calendly org membership list. A roster entry's optional calendlyUserUri overrides.
const CALENDLY_USER_URI_BY_EMAIL = {
  'sarah@trytruewind.com': 'https://api.calendly.com/users/069e97c6-0691-4472-84f2-cad9c76b6e01',
  'xavier@trytruewind.com': 'https://api.calendly.com/users/ac8a0acf-71b8-4db8-b74d-31ea6eaef11d',
  'amy@trytruewind.com': 'https://api.calendly.com/users/faa4a75c-b934-4b35-8b42-eef03611a78b',
  'andrew@trytruewind.com': 'https://api.calendly.com/users/44374fd3-909c-488f-a2d9-82228913696e',
  'ari@trytruewind.com': 'https://api.calendly.com/users/39bb9112-8657-42a1-b28e-8038fae1f506',
  'alex@trytruewind.com': 'https://api.calendly.com/users/e48355a2-611c-4757-bc0c-670e4d8061f3',
  'brendan@trytruewind.com': 'https://api.calendly.com/users/eed5543c-719e-408a-8342-f1af44fff9fe',
  'jenilee@trytruewind.com': 'https://api.calendly.com/users/53fad818-0025-4434-96f3-1941e6146b57',
  'mercedes@trytruewind.com': 'https://api.calendly.com/users/bd163793-9165-4b66-83d8-66f0e528cc9a',
  'noah@trytruewind.com': 'https://api.calendly.com/users/c01da68a-1dec-4c65-be1a-443e4fcd57e4',
  'tenn@trytruewind.com': 'https://api.calendly.com/users/c461478b-2453-4642-bf77-82dd5c468f6c',
};

function calendlyUserUriForAe(ae = {}) {
  return ae.calendlyUserUri || CALENDLY_USER_URI_BY_EMAIL[String(ae.email || '').trim().toLowerCase()] || '';
}

function calendlyHttpGetJson(url, token, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    // Calendly sits behind Cloudflare, which 1010-bans requests with no/bot User-Agent.
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    };
    const req = https.request(url, { method: 'GET', headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Calendly ${res.statusCode}: ${String(data).slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Calendly request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return asUtc - date.getTime();
}

function zonedLocalToUtc(year, month, day, hour, minute, second, timeZone) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offset = getTimeZoneOffsetMs(guess, timeZone);
  return new Date(guess.getTime() - offset);
}

function getLocalDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    dateKey: `${values.year}-${values.month}-${values.day}`,
  };
}

function getLocalDayRange(now = new Date(), timeZone = 'America/Los_Angeles', dayOffset = 0) {
  const baseParts = getLocalDateParts(now, timeZone);
  const targetNoon = zonedLocalToUtc(baseParts.year, baseParts.month, baseParts.day + dayOffset, 12, 0, 0, timeZone);
  const parts = getLocalDateParts(targetNoon, timeZone);
  const start = zonedLocalToUtc(parts.year, parts.month, parts.day, 0, 0, 0, timeZone);
  const nextDayNoon = zonedLocalToUtc(parts.year, parts.month, parts.day + 1, 12, 0, 0, timeZone);
  const nextParts = getLocalDateParts(nextDayNoon, timeZone);
  const end = zonedLocalToUtc(nextParts.year, nextParts.month, nextParts.day, 0, 0, 0, timeZone);
  return { start, end, dateKey: parts.dateKey };
}

function isWeekendLocalDate(date = new Date(), timeZone = 'America/Los_Angeles') {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(date);
  return weekday === 'Sat' || weekday === 'Sun';
}

function formatLocalDate(date, timeZone = 'America/Los_Angeles') {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function formatLocalTime(iso, timeZone = 'America/Los_Angeles') {
  if (!iso) return 'time unknown';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'time unknown';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function formatLocalDateTime(iso, timeZone = 'America/Los_Angeles') {
  if (!iso) return 'time unknown';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'time unknown';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function classifyMeetingStatus(meeting) {
  // Calendly is the source of truth for booked meetings — its verdict overrides
  // HubSpot's (possibly stale/duplicate) record when we were able to check it.
  if (meeting?._calendlyStatus === 'canceled') return 'cancelled';
  const props = meeting?.properties || {};
  const title = normalizeDigestText(props.hs_meeting_title || meeting?.title || '');
  const outcome = String(props.hs_meeting_outcome || '').trim().toUpperCase();
  if (outcome === 'CANCELED' || outcome === 'CANCELLED') return 'cancelled';
  if (title.startsWith('canceled:') || title.startsWith('cancelled:')) return 'cancelled';
  if (/^\[cancell?ed\]/.test(title)) return 'cancelled';
  // Any other terminal outcome means this isn't a live upcoming call. Calendly often
  // leaves a duplicate of a cancelled meeting marked NO_SHOW; treating these as
  // resolved keeps them out of the "upcoming calls" digest.
  if (outcome === 'NO_SHOW' || outcome === 'COMPLETED' || outcome === 'RESCHEDULED') return 'resolved';
  return 'scheduled';
}

function cancellationSourceLabel(meeting) {
  const props = meeting?.properties || {};
  const title = normalizeDigestText(props.hs_meeting_title || '');
  if (String(props.hs_object_source_detail_1 || '').toLowerCase() === 'calendly') return 'Calendly';
  if (String(props.hs_object_source_id || '').toLowerCase() === 'calendarsync') return 'CalendarSync';
  if (String(props.hs_meeting_source || '').toUpperCase() === 'BIDIRECTIONAL_SYNC') return 'CalendarSync';
  if (title.includes('calendly')) return 'Calendly';
  return 'Unknown';
}

function cancellationDedupeTitle(meeting) {
  return normalizeDigestText(meetingTitle(meeting))
    .replace(/^\[cancell?ed\]\s*/, '')
    .replace(/^cancell?ed:\s*/, '')
    .replace(/^calendly:\s*/, '')
    .trim();
}

function cancellationStateKeys(meeting, ae) {
  const startMs = Date.parse(meeting?.properties?.hs_meeting_start_time || '');
  const contact = primaryContact(meeting);
  const company = primaryCompany(meeting);
  const participantKey = normalizeDigestText(contact?.email || contactLabel(contact) || company?.name || companyNameForMeeting(meeting));
  const titleKey = cancellationDedupeTitle(meeting);
  return [
    `cancel:${meeting.id}:${ae.hubspotOwnerId}`,
    `cancel-dedupe:${ae.hubspotOwnerId}:${Number.isFinite(startMs) ? startMs : ''}:${participantKey}:${titleKey}`,
  ];
}

function postPromptMarker(meetingId, ownerId) {
  return `sales_admin_post_prompt:${ownerId}:${meetingId}`;
}

function meetingEndMs(meeting, defaultDurationMin = 60) {
  const props = meeting?.properties || {};
  const end = props.hs_meeting_end_time ? Date.parse(props.hs_meeting_end_time) : 0;
  if (Number.isFinite(end) && end > 0) return end;
  const start = props.hs_meeting_start_time ? Date.parse(props.hs_meeting_start_time) : 0;
  return Number.isFinite(start) && start > 0 ? start + defaultDurationMin * 60 * 1000 : 0;
}

function meetingTitle(meeting) {
  return String(meeting?.properties?.hs_meeting_title || meeting?.title || 'Untitled meeting').trim();
}

function primaryContact(meeting) {
  return meeting?._contacts?.[0] || null;
}

function primaryCompany(meeting) {
  return meeting?._companies?.[0] || null;
}

function primaryDeal(meeting) {
  return meeting?._deals?.[0] || null;
}

function contactLabel(contact) {
  if (!contact) return '';
  const name = `${contact.firstname || ''} ${contact.lastname || ''}`.trim();
  const company = contact.company ? ` (${contact.company})` : '';
  return `${name || contact.email || 'Contact'}${company}`;
}

function companyNameForMeeting(meeting) {
  return primaryCompany(meeting)?.name
    || primaryDeal(meeting)?.dealname
    || primaryContact(meeting)?.company
    || meetingTitle(meeting);
}

function slackLink(url, label) {
  return url ? `<${url}|${label}>` : label;
}

function slackPlainText(value, maxLength = 75) {
  const text = String(value || '').trim() || 'Option';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function meetingLinks(hubspot, meeting) {
  const links = [slackLink(hubspot.recordUrl('meetings', meeting.id), 'HubSpot meeting')];
  const contact = primaryContact(meeting);
  const company = primaryCompany(meeting);
  const deal = primaryDeal(meeting);
  if (contact?.id) links.push(slackLink(hubspot.recordUrl('contacts', contact.id), contactLabel(contact)));
  if (company?.id) links.push(slackLink(hubspot.recordUrl('companies', company.id), company.name || 'Company'));
  if (deal?.id) links.push(slackLink(hubspot.recordUrl('deals', deal.id), deal.dealname || 'Deal'));
  return links.join(' | ');
}

function hubspotDealLine(hubspot, meeting) {
  const deal = primaryDeal(meeting);
  if (!deal) return 'HubSpot deal: No associated deal found';
  const dealName = deal.dealname || 'Associated deal';
  const dealRecord = deal.id ? slackLink(hubspot.recordUrl('deals', deal.id), dealName) : slackMrkdwn(dealName);
  return `HubSpot deal: ${dealRecord}${deal.id ? ` (ID: ${deal.id})` : ''}`;
}

function tomorrowMeetingText({ hubspot, meeting, timeZone, stageDecision = null }) {
  const companyName = companyNameForMeeting(meeting);
  const title = meetingTitle(meeting);
  const lines = [
    `*${formatLocalTime(meeting.properties?.hs_meeting_start_time, timeZone)} — ${slackMrkdwn(companyName)}*`,
  ];
  if (title && title !== companyName) lines.push(slackMrkdwn(title));
  if (stageDecision?.currentStageIsClosed) {
    // A closed deal shouldn't have an upcoming call. Don't hide it — flag it loudly so
    // the rep verifies whether the meeting is real (it may have been cancelled on the
    // calendar without HubSpot picking it up) or the deal status needs fixing.
    lines.push(`:rotating_light: *${slackMrkdwn(stageDecision.currentStageLabel)} — please check.* Deal is closed but a call is still on the calendar. Confirm this meeting is really happening; it may have been cancelled.`);
  } else if (stageDecision?.currentStageLabel) {
    lines.push(`Deal stage: ${slackMrkdwn(stageDecision.currentStageLabel)}`);
  } else if (!primaryDeal(meeting)) {
    lines.push('_No deal attached._');
  }
  lines.push(meetingLinks(hubspot, meeting));
  return lines.join('\n');
}

function isInternalEmail(email) {
  const normalized = normalizeDigestText(email);
  const domain = normalized.includes('@') ? normalized.split('@').pop() : '';
  return INTERNAL_DOMAINS.has(domain);
}

function getMeetingEmails(meeting) {
  return (meeting?._contacts || [])
    .map(contact => normalizeDigestText(contact.email))
    .filter(Boolean);
}

function recordingDirectlyMatchesMeeting(recording, meeting) {
  const meetingId = String(meeting?.id || '').trim();
  const sourceId = String(meeting?.properties?.hs_meeting_source_id || '').trim();
  const externalUrl = String(meeting?.properties?.hs_meeting_external_url || '').trim();
  const hubspotPayload = JSON.stringify(recording?.hubspot || recording?.hubspot_metadata || recording?.hubspot_event || {});
  if (meetingId && hubspotPayload.includes(meetingId)) return true;

  const event = recording?.calendar_event || recording?.calendarEvent || {};
  const eventValues = [
    event.id,
    event.uid,
    event.event_id,
    event.calendar_event_id,
    event.html_link,
    event.htmlLink,
    event.url,
  ].map(value => String(value || '').trim()).filter(Boolean);
  if (sourceId && eventValues.some(value => value === sourceId || value.includes(sourceId))) return true;
  if (externalUrl && eventValues.some(value => value === externalUrl)) return true;
  return false;
}

function getRecordingText(recording) {
  const actionItems = recording?.ai_action_items || recording?.action_items || recording?.next_steps || [];
  const summary = recording?.ai_summary || recording?.summary || recording?.overview || '';
  const transcript = formatGrainTranscriptText(recording);
  const actionText = Array.isArray(actionItems)
    ? actionItems.map(item => (typeof item === 'string' ? item : item.text || item.description || item.title || '')).filter(Boolean).join('\n')
    : String(actionItems || '');
  return [actionText, typeof summary === 'object' ? JSON.stringify(summary) : summary, transcript].filter(Boolean).join('\n\n');
}

function aiSummaryText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  return String(value.summary || value.text || value.overview || '').trim();
}

function cleanSalesSummaryText(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^[*-]\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactSalesLeaderSummary(value, maxLength = 280) {
  const text = cleanSalesSummaryText(value);
  if (!text) return '';
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 20);
  const scored = sentences
    .map((sentence, index) => {
      const score = [
        /evaluat|interest|need|decid|timeline|follow|next|pilot|proposal|pricing|scope/i.test(sentence) ? 3 : 0,
        /client|prospect|customer|company|team|buyer|edops|acme/i.test(sentence) ? 2 : 0,
        sentence.length <= maxLength ? 1 : 0,
        -index / 100,
      ].reduce((sum, item) => sum + item, 0);
      return { sentence, score };
    })
    .sort((left, right) => right.score - left.score);
  const summary = scored[0]?.sentence || text;
  return truncateText(summary, maxLength);
}

function wordParts(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean);
}

function truncateToCompletePhrase(value, maxWords) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const words = wordParts(text);
  if (!maxWords || words.length <= maxWords) return text;

  const candidate = words.slice(0, maxWords).join(' ');
  const boundaryMatches = [...candidate.matchAll(/[.;!?](?=\s|$)/g)];
  const lastBoundary = boundaryMatches[boundaryMatches.length - 1];
  if (lastBoundary) {
    const complete = candidate.slice(0, lastBoundary.index).replace(/[.;!?\s]+$/g, '').trim();
    if (wordParts(complete).length >= 6) return complete;
  }

  const trimmed = candidate
    .replace(/\s+(?:and|or|but|to|for|with|about|after|before|confirm|check|send|share|schedule|attend|cover|follow|review|discuss|finalize)$/i, '')
    .trim();
  return trimmed || candidate;
}

function compactCroNextStepPhrase(value, extraction = null) {
  let phrase = cleanSalesSummaryText(value)
    .replace(/^(?:\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{1,2}-\d{1,2}|\?\?\/\?\?|tbd)\s*:\s*/i, '')
    .replace(/\s*\((?:owner|due):[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const summary = cleanSalesSummaryText(extraction?.summary || '');
  if (wordParts(phrase).length < 10 && summary) {
    phrase = `${phrase}; ${summary}`.replace(/\s+/g, ' ').trim();
  }
  const words = wordParts(phrase);
  if (words.length > 20) return truncateToCompletePhrase(phrase, 20);
  return phrase;
}

function formatPacificDatePrefix(date = new Date(), timeZone = 'America/Los_Angeles') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.month}/${values.day}`;
}

function splitLeadingNextStepDate(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{1,2}-\d{1,2})\s*:\s*(.+)$/);
  if (!match) return { dueDate: '', text };
  return { dueDate: match[1], text: match[2].trim() };
}

function futureNextStepScore(step) {
  const text = normalizeDigestText(step?.text || '');
  let score = 0;
  if (/\b(schedule|call|meeting|demo|follow|reach|circle|send|share|confirm|proposal|pricing|contract|next week|tomorrow)\b/.test(text)) score += 6;
  if (/\b(decision|timeline|close|approval|buyer|sponsor|scope|pilot|poc|legal|procurement)\b/.test(text)) score += 3;
  if (/\b(internal|internally|debrief|regroup)\b/.test(text)) score -= 2;
  if (/\b(no action|none|n\/a)\b/.test(text)) score -= 10;
  return score;
}

function futureFacingNextStepPhrase(step, extraction = null) {
  const rawText = String(step?.text || '').trim();
  const normalized = normalizeDigestText(rawText);
  if (/\b(internal|internally|debrief)\b/.test(normalized) && /\b(decide|move forward|decision)\b/.test(normalized)) {
    return 'Circle back internally and reach back out next week to confirm decision path';
  }
  if (/\bregroup\b/.test(normalized) && /\bnext week|tomorrow|call|meeting\b/.test(normalized)) {
    return 'Schedule regroup call and confirm decision path, timing, and next buyer milestone';
  }
  return compactCroNextStepPhrase(rawText, extraction);
}

function formatCroNextStepLine(step, extraction = null, datePrefix = formatPacificDatePrefix()) {
  return `${datePrefix}: ${futureFacingNextStepPhrase(step, extraction)}`;
}

function hubspotNextStepFromExtraction({ meeting, extraction, datePrefix = formatPacificDatePrefix() } = {}) {
  const steps = extraction?.nextSteps || [];
  if (steps.length) {
    const selectedStep = [...steps].sort((left, right) => futureNextStepScore(right) - futureNextStepScore(left))[0];
    return truncateText(formatCroNextStepLine(selectedStep, extraction, datePrefix), 700);
  }
  const summary = String(extraction?.summary || '').trim();
  if (summary) return `${datePrefix}: ${compactCroNextStepPhrase(summary, extraction)}`;
  return `${datePrefix}: AE to confirm next follow-up for ${companyNameForMeeting(meeting)}`;
}

async function summarizeSalesLeaderText({ anthropic, text, logger = console }) {
  const fallback = compactSalesLeaderSummary(text);
  if (!text || !anthropic) return fallback;
  try {
    const res = await anthropic.messages.create({
      model: process.env.SALES_ADMIN_CLAUDE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 120,
      system: 'Write concise CRM sales summaries. Return one sentence only.',
      messages: [{
        role: 'user',
        content: `Write a one-sentence sales-leader summary for HubSpot Next step. Maximum 35 words. Focus on buyer status, decision/timeline, and immediate next action. No bullets, headings, markdown, or invented facts.\n\nMeeting notes:\n${String(text || '').slice(0, 7000)}`,
      }],
    });
    const responseText = res.content?.find(block => block.type === 'text')?.text || '';
    return compactSalesLeaderSummary(responseText || fallback);
  } catch (err) {
    logger.warn(`Sales admin short summary generation failed: ${err.message}`);
    return fallback;
  }
}

function normalizeExtraction(raw = {}) {
  const nextSteps = Array.isArray(raw.next_steps) ? raw.next_steps : [];
  return {
    outcome: String(raw.outcome || '').trim() || 'Needs AE confirmation',
    summary: compactSalesLeaderSummary(raw.summary || raw.sales_summary || ''),
    nextSteps: nextSteps.map(step => {
      const rawText = String(step.text || step.description || step.action || step || '').trim();
      const leadingDate = splitLeadingNextStepDate(rawText);
      return {
        text: leadingDate.text,
        owner: String(step.owner || '').trim(),
        dueDate: String(step.due_date || step.dueDate || leadingDate.dueDate || '').trim(),
      };
    }).filter(step => step.text),
    confidence: ['high', 'medium', 'low'].includes(String(raw.confidence || '').toLowerCase())
      ? String(raw.confidence).toLowerCase()
      : 'low',
    source: raw.source || 'unknown',
  };
}

async function extractNextSteps({ anthropic, recording, logger = console }) {
  const actionItems = recording?.ai_action_items || recording?.action_items || recording?.next_steps;
  if (Array.isArray(actionItems) && actionItems.length > 0) {
    const rawSummary = aiSummaryText(recording?.ai_summary || recording?.summary || recording?.overview);
    const actionText = actionItems.map(item => (typeof item === 'string' ? item : item.text || item.description || item.title || '')).filter(Boolean).join('\n');
    const summary = await summarizeSalesLeaderText({ anthropic, text: [rawSummary, actionText].filter(Boolean).join('\n\n'), logger });
    return normalizeExtraction({
      outcome: 'Meeting completed; review next steps.',
      summary,
      next_steps: actionItems.map(item => (typeof item === 'string' ? { text: item } : item)),
      confidence: 'high',
      source: 'grain_ai_action_items',
    });
  }

  const text = getRecordingText(recording).slice(0, 8000);
  if (!text || !anthropic) {
    return normalizeExtraction({ source: recording ? 'grain_recording_no_extractable_notes' : 'no_grain_recording' });
  }

  try {
    const res = await anthropic.messages.create({
      model: process.env.SALES_ADMIN_CLAUDE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 700,
      system: 'Extract CRO-readable sales meeting next steps. Return only valid JSON. Never invent facts.',
      messages: [{
        role: 'user',
        content: `From these meeting notes/transcript, extract a very short sales-leader summary and explicit follow-up items for a CRO to scan deal health and close likelihood. If no follow-up items are explicit, return an empty next_steps array and confidence low.\n\nRules for next_steps:\n- text must be a concise 10-20 word phrase.\n- Include buyer status, close path, risk, or decision momentum only if explicitly discussed.\n- due_date must be an explicit date from the meeting, preferably YYYY-MM-DD. Leave blank if no date was stated. Do not invent dates.\n\nJSON schema:\n{"outcome":"Meeting completed; review next steps.","summary":"1-2 short sentences for a sales leader","next_steps":[{"text":"10-20 word CRO-readable phrase","owner":"string","due_date":"YYYY-MM-DD or blank"}],"confidence":"high|medium|low"}\n\nMeeting content:\n${text}`,
      }],
    });
    const responseText = res.content?.find(block => block.type === 'text')?.text || '{}';
    const jsonText = responseText.match(/\{[\s\S]*\}/)?.[0] || '{}';
    return normalizeExtraction({ ...JSON.parse(jsonText), source: 'grain_transcript_claude' });
  } catch (err) {
    logger.warn(`Sales admin next-step extraction failed: ${err.message}`);
    return normalizeExtraction({ source: 'extraction_failed' });
  }
}

async function extractPriorTips({ anthropic, priorMeeting, logger = console }) {
  if (!priorMeeting) return ['No prior meeting context found.'];
  const props = priorMeeting.properties || {};
  const text = [props.hs_meeting_title, props.hs_meeting_body].filter(Boolean).join('\n\n').slice(0, 5000);
  if (!text) return ['Prior meeting found, but no notes were available.'];
  if (!anthropic) return [String(props.hs_meeting_title || 'Review prior HubSpot meeting notes.')];
  try {
    const res = await anthropic.messages.create({
      model: process.env.SALES_ADMIN_CLAUDE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 300,
      system: 'Extract concise reminders for an AE before a follow-up sales meeting.',
      messages: [{
        role: 'user',
        content: `Return 1-3 short bullet reminders from this prior meeting. No preamble.\n\n${text}`,
      }],
    });
    const responseText = res.content?.find(block => block.type === 'text')?.text || '';
    const tips = responseText.split(/\n+/).map(line => line.replace(/^[-*•]\s*/, '').trim()).filter(Boolean).slice(0, 3);
    return tips.length ? tips : ['Review prior HubSpot meeting notes.'];
  } catch (err) {
    logger.warn(`Sales admin prior-tip extraction failed: ${err.message}`);
    return ['Review prior HubSpot meeting notes.'];
  }
}

function inputElement(initialValue) {
  const element = { type: 'plain_text_input', action_id: 'value', multiline: true };
  if (String(initialValue || '').trim()) element.initial_value = String(initialValue);
  return element;
}

function slackMrkdwn(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncateText(value, maxLength = 2900) {
  const text = String(value || '');
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function nextStepsBlockText(extraction) {
  const steps = extraction?.nextSteps || [];
  if (!steps.length) {
    return '*Suggested follow-up from Grain*\n_No follow-up items were found in Grain._';
  }
  const lines = steps.slice(0, 8).map((step, index) => {
    const suffix = [step.owner ? `Owner: ${slackMrkdwn(step.owner)}` : '', step.dueDate ? `Due: ${slackMrkdwn(step.dueDate)}` : ''].filter(Boolean).join(', ');
    return `${index + 1}. ${slackMrkdwn(step.text)}${suffix ? ` _(${suffix})_` : ''}`;
  });
  if (steps.length > lines.length) lines.push(`_${steps.length - lines.length} more follow-up items omitted._`);
  return truncateText(`*Suggested follow-up from Grain*\n${lines.join('\n')}`);
}

function hubspotNextStepSummary({ meeting, extraction, datePrefix = formatPacificDatePrefix() } = {}) {
  return hubspotNextStepFromExtraction({ meeting, extraction, datePrefix });
}

function hubspotNextStepBlockText({ meeting, extraction, datePrefix } = {}) {
  return truncateText([
    '*HubSpot Next Step*',
    'Please confirm this short summary should be saved to HubSpot under `Next step`:',
    `>${slackMrkdwn(hubspotNextStepSummary({ meeting, extraction, datePrefix }))}`,
  ].join('\n'));
}

function stageBlockText(stageDecision) {
  if (!stageDecision) return '';
  const recommendedVerb = stageDecision.recommendedStageId === stageDecision.currentStageId ? 'keep it in' : 'move it to';
  return [
    `*Deal stage: ${slackMrkdwn(stageDecision.dealName)}*`,
    `Current stage: *${slackMrkdwn(stageDecision.currentStageLabel)}*`,
    `Recommended: *${recommendedVerb} ${slackMrkdwn(stageDecision.recommendedStageLabel)}*`,
    'Dropdown default is the recommendation. Choose the current stage if the deal should stay put.',
  ].join('\n');
}

function stageLabel(stage) {
  return stage?.label || stage?.id || '';
}

function isClosedStage(stage) {
  return String(stage?.metadata?.isClosed || '').trim().toLowerCase() === 'true';
}

function buildStageDecision({ deal, stages = [] } = {}) {
  if (!deal?.id || !Array.isArray(stages) || stages.length === 0) return null;
  const currentStageId = String(deal.dealstage || '').trim();
  const currentIndex = stages.findIndex(stage => stage.id === currentStageId);
  if (currentIndex < 0) return null;
  const options = stages.slice(currentIndex);
  const recommendedIndex = Math.min(currentIndex + 1, stages.length - 1);
  const recommendedStage = stages[recommendedIndex];
  const currentStage = stages[currentIndex];
  return {
    dealId: deal.id,
    dealName: deal.dealname || 'Associated deal',
    pipelineId: deal.pipeline || '105321581',
    currentStageId,
    currentStageLabel: stageLabel(currentStage),
    currentStageIsClosed: isClosedStage(currentStage),
    recommendedStageId: recommendedStage.id,
    recommendedStageLabel: stageLabel(recommendedStage),
    options,
    recommendationReason: recommendedStage.id === currentStageId
      ? 'Deal is already in the last configured stage.'
      : 'Default recommendation is the next pipeline stage after this meeting.',
  };
}

function shouldSkipAutomaticPostMeetingPrompt(stageDecision) {
  return Boolean(stageDecision?.currentStageIsClosed);
}

function stageSelectElement(stageDecision, selectedStageId) {
  if (!stageDecision?.options?.length) return null;
  const options = stageDecision.options.slice(0, 100).map(stage => ({
    text: { type: 'plain_text', text: slackPlainText(stage.label), emoji: true },
    value: stage.id,
  }));
  const initialValue = selectedStageId || stageDecision.recommendedStageId || stageDecision.currentStageId;
  const initialOption = options.find(option => option.value === initialValue) || options[0];
  return {
    type: 'static_select',
    action_id: POST_ACTIONS.stageSelect,
    placeholder: { type: 'plain_text', text: 'Move deal to...', emoji: true },
    options,
    ...(initialOption ? { initial_option: initialOption } : {}),
  };
}

function selectedStageFromInteraction(body, fallbackStageId = '') {
  const values = body?.state?.values || {};
  for (const block of Object.values(values)) {
    for (const actionValue of Object.values(block || {})) {
      if (actionValue?.action_id === POST_ACTIONS.stageSelect && actionValue?.selected_option?.value) {
        return String(actionValue.selected_option.value);
      }
    }
  }
  return fallbackStageId || '';
}

function selectedStageLabel(stageDecision, stageId) {
  return stageDecision?.options?.find(stage => stage.id === stageId)?.label || '';
}

function shouldDefaultNoShow({ grainSource = '', extraction = null } = {}) {
  const source = String(grainSource || extraction?.source || '').trim().toLowerCase();
  return source === 'no_grain_recording';
}

function buildWritebackNote({ ae, meeting, status, extraction, grainUrl = '', hubspotNextStep = '', nextStepDatePrefix = '', stageDecision = null, selectedStageId = '', stageUpdate = null, nextStepPropertyUpdate = null }) {
  const lines = [
    'Sales Admin Confirmed Meeting Outcome',
    `AE: ${ae.name} <${ae.email}>`,
    `Status: ${status}`,
    `Meeting: ${meetingTitle(meeting)}`,
    `Meeting time: ${meeting.properties?.hs_meeting_start_time || ''}`,
  ];
  if (grainUrl) lines.push(`Grain recording: ${grainUrl}`);
  if (stageDecision) {
    lines.push(`Deal stage before confirmation: ${stageDecision.currentStageLabel}`);
    if (status !== 'no_show') lines.push(`Confirmed deal stage: ${selectedStageLabel(stageDecision, selectedStageId) || selectedStageId || 'Not selected'}`);
    if (stageUpdate?.updated) lines.push(`Deal stage updated in HubSpot: ${stageUpdate.fromLabel} -> ${stageUpdate.toLabel}`);
    if (stageUpdate && !stageUpdate.updated) lines.push(`Deal stage update: ${stageUpdate.reason}`);
  }
  if (status === 'no_show') {
    lines.push('Outcome: No show');
  } else {
    lines.push('Outcome: Meeting completed; review next steps.');
    lines.push(`HubSpot Next step: ${hubspotNextStep || hubspotNextStepSummary({ meeting, extraction, datePrefix: nextStepDatePrefix })}`);
    if (nextStepPropertyUpdate?.updated) lines.push(`HubSpot Next step property updated: ${nextStepPropertyUpdate.propertyName}`);
    if (nextStepPropertyUpdate && !nextStepPropertyUpdate.updated) lines.push(`HubSpot Next step property update: ${nextStepPropertyUpdate.reason}`);
    const steps = extraction?.nextSteps || [];
    lines.push('Grain suggested follow-up:');
    if (steps.length) {
      for (const step of steps) lines.push(`- ${step.text}${step.owner ? ` (Owner: ${step.owner})` : ''}${step.dueDate ? ` (Due: ${step.dueDate})` : ''}`);
    } else {
      lines.push('- None confirmed');
    }
  }
  return lines.join('\n');
}

function postMeetingActionElements(promptKey, defaultNoShow = false) {
  if (defaultNoShow) {
    return [
      { type: 'button', text: { type: 'plain_text', text: 'No-Show' }, style: 'primary', action_id: POST_ACTIONS.noShow, value: promptKey },
      { type: 'button', text: { type: 'plain_text', text: 'Confirm Completed' }, action_id: POST_ACTIONS.confirm, value: promptKey },
      { type: 'button', text: { type: 'plain_text', text: 'Edit Notes' }, action_id: POST_ACTIONS.edit, value: promptKey },
      {
        type: 'overflow',
        action_id: POST_ACTIONS.ignore,
        options: [{ text: { type: 'plain_text', text: 'Not this meeting', emoji: true }, value: promptKey }],
      },
    ];
  }
  return [
    { type: 'button', text: { type: 'plain_text', text: 'Confirm & Save' }, style: 'primary', action_id: POST_ACTIONS.confirm, value: promptKey },
    { type: 'button', text: { type: 'plain_text', text: 'Edit Notes' }, action_id: POST_ACTIONS.edit, value: promptKey },
    { type: 'button', text: { type: 'plain_text', text: 'No-Show' }, style: 'danger', action_id: POST_ACTIONS.noShow, value: promptKey },
    {
      type: 'overflow',
      action_id: POST_ACTIONS.ignore,
      options: [{ text: { type: 'plain_text', text: 'Not this meeting', emoji: true }, value: promptKey }],
    },
  ];
}

function buildPostMeetingBlocks({ ae, meeting, hubspot, extraction, promptKey, grainUrl, grainSource = '', nextStepDatePrefix = '', stageDecision }) {
  const companyName = companyNameForMeeting(meeting);
  const defaultNoShow = shouldDefaultNoShow({ grainSource, extraction });
  const contextLine = {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `${formatLocalDateTime(meeting.properties?.hs_meeting_start_time)} | ${meetingLinks(hubspot, meeting)}${grainUrl ? ` | <${grainUrl}|Grain recording>` : ''}` }],
  };

  if (defaultNoShow) {
    // No recording → almost certainly a no-show. Keep it to a single ask; stage
    // and next-step don't apply to a no-show, so don't clutter the message.
    const contact = primaryContact(meeting);
    const who = contact ? contactLabel(contact) : 'the attendee';
    return [
      { type: 'section', text: { type: 'mrkdwn', text: `*${slackMrkdwn(companyName)} — ${slackMrkdwn(who)}*\nDoesn't look like they showed up (no Grain recording). Mark as a confirmed *No-Show* in HubSpot?` } },
      contextLine,
      { type: 'actions', elements: postMeetingActionElements(promptKey, true) },
    ];
  }

  // Meeting happened → keep the useful actions: the deal-stage dropdown and the
  // HubSpot Next step. The verbose "Suggested follow-up from Grain" block is removed.
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*${slackMrkdwn(companyName)}* — meeting completed.` } },
    contextLine,
    ...(stageDecision ? [{
      type: 'section',
      block_id: 'deal_stage',
      text: { type: 'mrkdwn', text: stageBlockText(stageDecision) },
      accessory: stageSelectElement(stageDecision, stageDecision.recommendedStageId),
    }] : []),
    { type: 'section', text: { type: 'mrkdwn', text: hubspotNextStepBlockText({ meeting, extraction, datePrefix: nextStepDatePrefix }) } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: stageDecision
          ? ':information_source: *Confirm & Save* updates HubSpot `Next step`, writes a note, and applies the selected deal stage.'
          : ':information_source: *Confirm & Save* updates HubSpot `Next step` and writes a note.',
      }],
    },
    { type: 'actions', elements: postMeetingActionElements(promptKey, false) },
  ];
}

async function findChannelIdByName(client, token, channelName, types) {
  let cursor = '';
  do {
    const res = await client.conversations.list({
      token,
      exclude_archived: true,
      types,
      limit: 1000,
      cursor: cursor || undefined,
    });
    const channel = (res.channels || []).find(item => item.name === channelName);
    if (channel) return channel.id;
    cursor = res.response_metadata?.next_cursor || '';
  } while (cursor);
  return '';
}

async function resolveChannelId(client, token, channelName, { includePrivate = false, logger = console } = {}) {
  const normalizedName = String(channelName || '').replace(/^#/, '');
  if (/^[CDG][A-Z0-9]+$/.test(normalizedName)) return normalizedName;
  const publicChannelId = await findChannelIdByName(client, token, normalizedName, 'public_channel');
  if (publicChannelId) return publicChannelId;
  if (!includePrivate) return '';
  try {
    return await findChannelIdByName(client, token, normalizedName, 'private_channel');
  } catch (err) {
    if (err?.data?.error === 'missing_scope') {
      logger.warn(`Sales admin private channel lookup skipped for #${normalizedName}: missing Slack scope groups:read`);
      return '';
    }
    throw err;
  }
}

class SalesAdminWorkflow {
  constructor({ app, hubspotRequest, anthropic, env = process.env, logger = console } = {}) {
    this.app = app;
    this.anthropic = anthropic;
    this.env = env;
    this.logger = logger;
    this.config = buildConfig(env);
    this.state = createSalesAdminState(this.config.statePath, logger);
    this.hubspot = new HubSpotSalesAdminClient({ hubspotRequest, portalId: this.config.portalId, logger });
    this.grain = new GrainClient({ token: this.config.grainToken, baseUrl: this.config.grainBaseUrl, logger });
    this.channelIdsByOwnerId = new Map();
    this.missingChannelsByOwnerId = new Set();
    this.inFlight = new Set();
  }

  isEnabled() {
    return this.config.enabled;
  }

  async initializeChannels() {
    if (!this.app?.client || !this.isEnabled()) return;
    for (const ae of this.config.roster) {
      try {
        const channelId = await resolveChannelId(this.app.client, this.env.SLACK_BOT_TOKEN, ae.salesAdminChannel, {
          includePrivate: this.env.SALES_ADMIN_RESOLVE_PRIVATE_CHANNELS === 'true',
          logger: this.logger,
        });
        if (!channelId) {
          this.logger.error(`Sales admin channel not found for ${ae.name}: #${ae.salesAdminChannel}; skipping this AE until the channel exists and the bot is invited.`);
          this.missingChannelsByOwnerId.add(ae.hubspotOwnerId);
          continue;
        }
        this.missingChannelsByOwnerId.delete(ae.hubspotOwnerId);
        this.channelIdsByOwnerId.set(ae.hubspotOwnerId, channelId);
      } catch (err) {
        this.logger.error(`Sales admin channel resolution failed for ${ae.name}: ${err.message}`);
      }
    }
  }

  isAeChannelReady(ae) {
    if (/^[CDG][A-Z0-9]+$/.test(ae.salesAdminChannel)) return true;
    return this.channelIdsByOwnerId.has(ae.hubspotOwnerId) && !this.missingChannelsByOwnerId.has(ae.hubspotOwnerId);
  }

  channelFor(ae) {
    return this.channelIdsByOwnerId.get(ae.hubspotOwnerId) || ae.salesAdminChannel;
  }

  async safePostMessage(ae, payload) {
    if (!this.isAeChannelReady(ae)) {
      throw new Error(`Configured sales-admin channel is not ready for ${ae.name}: #${ae.salesAdminChannel}`);
    }
    const channel = this.channelFor(ae);
    try {
      return await this.app.client.chat.postMessage({
        token: this.env.SLACK_BOT_TOKEN,
        channel,
        ...payload,
      });
    } catch (err) {
      this.logger.error(`Sales admin Slack post failed for ${ae.name} in ${channel}: ${err.message}`);
      throw err;
    }
  }

  async withLock(name, fn) {
    if (this.inFlight.has(name)) {
      this.logger.log(`Sales admin ${name} already running; skipping duplicate run.`);
      return { skipped: true, reason: 'in_flight' };
    }
    this.inFlight.add(name);
    try {
      return await fn();
    } finally {
      this.inFlight.delete(name);
    }
  }

  async meetingsForDayOffset(ae, now = new Date(), dayOffset = 0) {
    const { start, end } = getLocalDayRange(now, this.config.timezone, dayOffset);
    const meetings = await this.hubspot.searchMeetingsForOwnerBetween(ae.hubspotOwnerId, start, end);
    const enriched = await Promise.all(meetings.map(meeting => this.hubspot.attachAssociations(meeting)));
    const deduped = dedupeDigestMeetings(enriched);
    await this.annotateCalendlyStatus(ae, deduped, { start, end });
    return deduped;
  }

  // Calendly is the booking source of truth (used for intro meetings). Org-level event
  // reads require the organization URI alongside the user URI; fetch it once and cache.
  async getCalendlyOrganization() {
    if (this.config.calendlyOrganization) return this.config.calendlyOrganization;
    if (this._calendlyOrgUri !== undefined) return this._calendlyOrgUri;
    this._calendlyOrgUri = '';
    try {
      const me = await calendlyHttpGetJson(`${this.config.calendlyBaseUrl}/users/me`, this.config.calendlyToken);
      this._calendlyOrgUri = me?.resource?.current_organization || '';
    } catch (err) {
      this.logger.warn(`Sales admin Calendly org lookup failed: ${err.message}`);
    }
    return this._calendlyOrgUri;
  }

  async fetchCalendlyEvents({ userUri, status, minStart, maxStart }) {
    const token = this.config.calendlyToken;
    if (!token || !userUri) return [];
    const organization = await this.getCalendlyOrganization();
    const params = new URLSearchParams({
      user: userUri,
      min_start_time: new Date(minStart).toISOString(),
      max_start_time: new Date(maxStart).toISOString(),
      count: '100',
    });
    if (organization) params.set('organization', organization);
    if (status) params.set('status', status);
    const res = await calendlyHttpGetJson(`${this.config.calendlyBaseUrl}/scheduled_events?${params.toString()}`, token);
    return Array.isArray(res?.collection) ? res.collection : [];
  }

  // Override a HubSpot meeting's status with Calendly's when Calendly says the booked
  // event at that start time was canceled. Safe no-op when there's no Calendly token /
  // user URI or on any error — the digest then falls back to the HubSpot signal.
  async annotateCalendlyStatus(ae, meetings = [], { start, end } = {}) {
    const userUri = calendlyUserUriForAe(ae);
    if (!this.config.calendlyToken || !userUri || !meetings.length) return meetings;
    try {
      const canceled = await this.fetchCalendlyEvents({ userUri, status: 'canceled', minStart: start, maxStart: end });
      const canceledStartMs = new Set(canceled.map(event => Date.parse(event.start_time)).filter(Number.isFinite));
      if (!canceledStartMs.size) return meetings;
      for (const meeting of meetings) {
        const startMs = Date.parse(meeting.properties?.hs_meeting_start_time || '');
        if (Number.isFinite(startMs) && canceledStartMs.has(startMs)) meeting._calendlyStatus = 'canceled';
      }
    } catch (err) {
      this.logger.warn(`Sales admin Calendly verification skipped for ${ae.name}: ${err.message}`);
    }
    return meetings;
  }

  async meetingsForToday(ae, now = new Date()) {
    return this.meetingsForDayOffset(ae, now, 0);
  }

  async meetingsForTomorrow(ae, now = new Date()) {
    return this.meetingsForDayOffset(ae, now, 1);
  }

  async runMorningSummaries(now = new Date()) {
    if (!this.isEnabled()) return { skipped: true, reason: 'disabled' };
    if (isWeekendLocalDate(now, this.config.timezone)) {
      return { posted: 0, skipped: this.config.roster.length, errors: 0, reason: 'weekend' };
    }
    return this.withLock('morning', async () => {
      const { dateKey } = getLocalDayRange(now, this.config.timezone);
      const stats = { posted: 0, skipped: 0, errors: 0 };
      for (const ae of this.config.roster) {
        if (!this.isAeChannelReady(ae)) { stats.skipped += 1; continue; }
        const key = `morning:${dateKey}:${ae.hubspotOwnerId}`;
        if (this.state.has(key)) { stats.skipped += 1; continue; }
        try {
          const meetings = await this.meetingsForToday(ae, now);
          const scheduled = meetings.filter(meeting => classifyMeetingStatus(meeting) === 'scheduled');
          const cancelled = meetings.filter(meeting => classifyMeetingStatus(meeting) === 'cancelled' && !this.state.has(`cancel:${meeting.id}:${ae.hubspotOwnerId}`));
          const lines = [`Good morning <@${ae.slackUserId}>. Here are your meetings for today.`];
          if (scheduled.length === 0) lines.push('\nNo scheduled meetings found.');
          for (const meeting of scheduled) {
            const prior = await this.hubspot.findPriorMeeting(meeting);
            const tips = await extractPriorTips({ anthropic: this.anthropic, priorMeeting: prior, logger: this.logger });
            lines.push(`\n*${formatLocalTime(meeting.properties?.hs_meeting_start_time, this.config.timezone)} - ${meetingTitle(meeting)}*`);
            lines.push(meetingLinks(this.hubspot, meeting));
            lines.push(`Tips: ${tips.map(tip => `• ${tip}`).join(' ')}`);
          }
          if (cancelled.length > 0) {
            lines.push('\n*Cancelled today, not yet separately alerted:*');
            for (const meeting of cancelled) lines.push(`- ${formatLocalTime(meeting.properties?.hs_meeting_start_time, this.config.timezone)} - ${meetingTitle(meeting)}`);
          }
          const posted = await this.safePostMessage(ae, { text: lines.join('\n') });
          this.state.set(key, { type: 'morning', ae, dateKey, slackTs: posted.ts, slackChannel: posted.channel || this.channelFor(ae), status: 'posted' });
          stats.posted += 1;
        } catch (err) {
          stats.errors += 1;
          this.logger.error(`Sales admin morning summary failed for ${ae.name}: ${err.message}`);
        }
      }
      return stats;
    });
  }

  async runTomorrowSummaries(now = new Date()) {
    if (!this.isEnabled()) return { skipped: true, reason: 'disabled' };
    const targetDay = getLocalDayRange(now, this.config.timezone, 1);
    if (isWeekendLocalDate(targetDay.start, this.config.timezone)) {
      return { posted: 0, skipped: this.config.roster.length, errors: 0, reason: 'weekend_tomorrow', dateKey: targetDay.dateKey };
    }
    return this.withLock('tomorrow', async () => {
      const { start, dateKey } = targetDay;
      const dateLabel = formatLocalDate(start, this.config.timezone);
      const stats = { posted: 0, skipped: 0, errors: 0 };
      for (const ae of this.config.roster) {
        if (!this.isAeChannelReady(ae)) { stats.skipped += 1; continue; }
        const key = `tomorrow:${dateKey}:${ae.hubspotOwnerId}`;
        if (this.state.has(key)) { stats.skipped += 1; continue; }
        try {
          const meetings = await this.meetingsForTomorrow(ae, now);
          const scheduled = meetings.filter(meeting => classifyMeetingStatus(meeting) === 'scheduled');
          const cancelled = meetings.filter(meeting => classifyMeetingStatus(meeting) === 'cancelled');
          const lines = [
            `:calendar: *Tomorrow's calls — ${dateLabel}*`,
            `<@${ae.slackUserId}>, here are the calls on your calendar tomorrow.`,
          ];
          if (scheduled.length === 0) {
            lines.push('\nNo scheduled calls found for tomorrow.');
          } else {
            for (const meeting of scheduled) {
              const stageDecision = await this.buildStageDecisionForMeeting(meeting);
              lines.push(`\n${tomorrowMeetingText({ hubspot: this.hubspot, meeting, timeZone: this.config.timezone, stageDecision })}`);
            }
          }
          if (cancelled.length > 0) {
            lines.push('\n*Cancelled tomorrow:*');
            for (const meeting of cancelled) lines.push(`- ${formatLocalTime(meeting.properties?.hs_meeting_start_time, this.config.timezone)} — ${slackMrkdwn(meetingTitle(meeting))}`);
          }
          const posted = await this.safePostMessage(ae, { text: truncateText(lines.join('\n'), 39000) });
          this.state.set(key, { type: 'tomorrow', ae, dateKey, slackTs: posted.ts, slackChannel: posted.channel || this.channelFor(ae), status: 'posted' });
          stats.posted += 1;
        } catch (err) {
          stats.errors += 1;
          this.logger.error(`Sales admin tomorrow summary failed for ${ae.name}: ${err.message}`);
        }
      }
      return stats;
    });
  }

  async runCancellationScan(now = new Date()) {
    if (!this.isEnabled()) return { skipped: true, reason: 'disabled' };
    return this.withLock('cancel', async () => {
      const stats = { alerted: 0, skipped: 0, errors: 0 };
      const updatedSince = new Date(now.getTime() - this.config.cancelLookbackMin * 60 * 1000);
      const startAfter = new Date(now.getTime() - this.config.cancelPastGraceHours * 60 * 60 * 1000);
      for (const ae of this.config.roster) {
        if (!this.isAeChannelReady(ae)) { stats.skipped += 1; continue; }
        try {
          const meetings = await this.hubspot.searchRecentlyUpdatedMeetingsForOwner(ae.hubspotOwnerId, updatedSince, startAfter);
          for (const rawMeeting of meetings) {
            if (classifyMeetingStatus(rawMeeting) !== 'cancelled') continue;
            const meeting = await this.hubspot.attachAssociations(rawMeeting);
            const keys = cancellationStateKeys(meeting, ae);
            if (keys.some(key => this.state.has(key))) { stats.skipped += 1; continue; }
            const source = cancellationSourceLabel(meeting);
            const text = [
              `:warning: <@${ae.slackUserId}> meeting cancelled: *${meetingTitle(meeting)}*`,
              `Original time: ${formatLocalDateTime(meeting.properties?.hs_meeting_start_time, this.config.timezone)}`,
              `Source: ${source}`,
              hubspotDealLine(this.hubspot, meeting),
              meetingLinks(this.hubspot, meeting),
            ].join('\n');
            const posted = await this.safePostMessage(ae, { text });
            const alertRecord = { type: 'cancel', ae, meetingId: meeting.id, source, slackTs: posted.ts, slackChannel: posted.channel || this.channelFor(ae), status: 'alerted', hubspotNoteStatus: 'pending' };
            for (const key of keys) this.state.set(key, alertRecord);
            try {
              const note = await this.hubspot.createNote({
                meeting,
                contacts: meeting._contacts,
                companies: meeting._companies,
                deals: meeting._deals,
                body: [
                  'Sales Admin cancellation notification',
                  `AE notified: ${ae.name} <${ae.email}>`,
                  `Slack channel: ${posted.channel || this.channelFor(ae)}`,
                  `Slack timestamp: ${posted.ts}`,
                  `Detected source: ${source}`,
                  `Cancellation signal: ${meeting.properties?.hs_meeting_title || ''}`,
                ].join('\n'),
              });
              for (const key of keys) this.state.update(key, { hubspotNoteId: note.id, hubspotNoteStatus: 'created' });
            } catch (err) {
              this.logger.warn(`Sales admin cancellation note write failed for meeting ${meeting.id}: ${err.message}`);
              for (const key of keys) this.state.update(key, { hubspotNoteStatus: 'failed', hubspotNoteError: err.message });
            }
            stats.alerted += 1;
          }
        } catch (err) {
          stats.errors += 1;
          this.logger.error(`Sales admin cancellation scan failed for ${ae.name}: ${err.message}`);
        }
      }
      return stats;
    });
  }

  async fetchGrainForMeeting(ae, meeting) {
    if (!this.grain.isConfigured()) return { recording: null, grainUrl: '', source: 'grain_not_configured' };
    const startMs = Date.parse(meeting.properties?.hs_meeting_start_time || '');
    if (!Number.isFinite(startMs)) return { recording: null, grainUrl: '', source: 'missing_meeting_start' };
    const recordings = await this.grain.listRecordings({
      start: new Date(startMs - 45 * 60 * 1000),
      end: new Date(startMs + 45 * 60 * 1000),
      teamId: this.config.grainTeamId,
      maxPages: Number(this.env.SALES_ADMIN_GRAIN_MAX_PAGES || 5),
    });
    const config = { matchWindowMs: 45 * 60 * 1000 };
    const dedupedRecordings = dedupeGrainRecordings(recordings);
    let matched = dedupedRecordings.find(recording => recordingDirectlyMatchesMeeting(recording, meeting)) || null;
    if (!matched) matched = findBestGrainRecordingForMeeting(meeting, dedupedRecordings, config);
    if (!matched) {
      const meetingEmails = new Set(getMeetingEmails(meeting));
      matched = dedupeGrainRecordings(recordings).find(recording => {
        const emails = getGrainParticipantEmails(recording);
        return emails.includes(ae.email) && emails.some(email => meetingEmails.has(email) || !isInternalEmail(email));
      }) || null;
    }
    if (!matched) return { recording: null, grainUrl: '', source: 'no_grain_recording' };
    const id = getGrainRecordingId(matched);
    let detail = matched;
    try {
      if (id) detail = { ...matched, ...(await this.grain.getRecording(id)) };
      if (id && !formatGrainTranscriptText(detail)) detail.transcript = await this.grain.getTranscript(id);
    } catch (err) {
      this.logger.warn(`Sales admin Grain detail fetch failed for ${id || getGrainRecordingTitle(matched)}: ${err.message}`);
    }
    return { recording: detail, grainUrl: getGrainRecordingUrl(detail) || getGrainRecordingUrl(matched), source: 'grain_matched' };
  }

  async runPostMeetingScan(now = new Date(), options = {}) {
    if (!this.isEnabled()) return { skipped: true, reason: 'disabled' };
    const force = options.force === true || options.force === 'true' || options.force === '1';
    if (!force && isWeekendLocalDate(now, this.config.timezone)) {
      return { prompted: 0, skipped: this.config.roster.length, errors: 0, reason: 'weekend' };
    }
    return this.withLock('post', async () => {
      const stats = { prompted: 0, skipped: 0, errors: 0 };
      const ownerId = String(options.ownerId || options.owner_id || '').trim();
      const meetingId = String(options.meetingId || options.meeting_id || '').trim();
      const allowClosed = options.allowClosed === true || options.allowClosed === 'true' || options.allowClosed === '1' || options.allow_closed === 'true' || options.allow_closed === '1';
      for (const ae of this.config.roster) {
        if (ownerId && ae.hubspotOwnerId !== ownerId) { stats.skipped += 1; continue; }
        if (!this.isAeChannelReady(ae)) { stats.skipped += 1; continue; }
        try {
          const meetings = await this.meetingsForToday(ae, now);
          for (const meeting of meetings) {
            if (meetingId && String(meeting.id) !== meetingId) { stats.skipped += 1; continue; }
            if (classifyMeetingStatus(meeting) !== 'scheduled') { stats.skipped += 1; continue; }
            const key = `post:${meeting.id}:${ae.hubspotOwnerId}`;
            if (!force && this.state.has(key)) { stats.skipped += 1; continue; }
            const endMs = meetingEndMs(meeting);
            if (!force && (!endMs || now.getTime() < endMs + this.config.postMeetingDelayMin * 60 * 1000)) { stats.skipped += 1; continue; }
            if (!force && this.config.postMeetingLookbackHours > 0 && now.getTime() > endMs + this.config.postMeetingLookbackHours * 60 * 60 * 1000) { stats.skipped += 1; continue; }
            const stageDecision = await this.buildStageDecisionForMeeting(meeting);
            if (!allowClosed && shouldSkipAutomaticPostMeetingPrompt(stageDecision)) {
              stats.skipped += 1;
              continue;
            }
            const marker = postPromptMarker(meeting.id, ae.hubspotOwnerId);
            if (!force) {
              const alreadyPrompted = await this.hubspot.hasMeetingNoteContaining(meeting.id, marker).catch(err => {
                this.logger.warn(`Sales admin post prompt marker check failed for meeting ${meeting.id}: ${err.message}`);
                return false;
              });
              if (alreadyPrompted) {
                this.state.set(key, { type: 'post', ae, meetingId: meeting.id, promptMarker: marker, status: 'prompted', source: 'hubspot_marker' });
                stats.skipped += 1;
                continue;
              }
            }
            const grain = await this.fetchGrainForMeeting(ae, meeting).catch(err => {
              this.logger.warn(`Sales admin Grain match failed for meeting ${meeting.id}: ${err.message}`);
              return { recording: null, grainUrl: '', source: 'grain_error' };
            });
            const extraction = await extractNextSteps({ anthropic: this.anthropic, recording: grain.recording, logger: this.logger });
            const promptRecord = {
              type: 'post',
              ae,
              meeting,
              meetingId: meeting.id,
              grainRecordingId: getGrainRecordingId(grain.recording),
              grainSource: grain.source,
              grainUrl: grain.grainUrl,
              extraction,
              promptMarker: marker,
              nextStepDatePrefix: formatPacificDatePrefix(new Date(), this.config.timezone),
              stageDecision,
              status: 'pending',
            };
            this.state.set(key, promptRecord);
            const posted = await this.safePostMessage(ae, {
              text: `Post-meeting check: ${meetingTitle(meeting)}`,
              blocks: buildPostMeetingBlocks({ ae, meeting, hubspot: this.hubspot, extraction, promptKey: key, grainUrl: grain.grainUrl, grainSource: grain.source, nextStepDatePrefix: promptRecord.nextStepDatePrefix, stageDecision: promptRecord.stageDecision }),
            });
            const slackChannel = posted.channel || this.channelFor(ae);
            this.state.update(key, { slackTs: posted.ts, slackChannel, status: 'prompted' });
            try {
              const note = await this.hubspot.createPostPromptMarker({
                marker,
                meeting,
                ae,
                slackChannel,
                slackTs: posted.ts,
                promptKey: key,
                grainUrl: grain.grainUrl,
                grainSource: grain.source,
              });
              this.state.update(key, { hubspotPromptMarkerNoteId: note.id, hubspotPromptMarkerStatus: 'created' });
            } catch (err) {
              this.logger.warn(`Sales admin post prompt marker write failed for meeting ${meeting.id}: ${err.message}`);
              this.state.update(key, { hubspotPromptMarkerStatus: 'failed', hubspotPromptMarkerError: err.message });
            }
            stats.prompted += 1;
          }
        } catch (err) {
          stats.errors += 1;
          this.logger.error(`Sales admin post-meeting scan failed for ${ae.name}: ${err.message}`);
        }
      }
      return stats;
    });
  }

  async buildStageDecisionForMeeting(meeting) {
    const deal = primaryDeal(meeting);
    if (!deal?.id || !deal.pipeline) return null;
    const stages = await this.hubspot.getDealPipelineStages(deal.pipeline).catch(err => {
      this.logger.warn(`Sales admin pipeline stage fetch failed for deal ${deal.id}: ${err.message}`);
      return [];
    });
    return buildStageDecision({ deal, stages });
  }

  async applySelectedStage(record, selectedStageId) {
    const stageDecision = record.stageDecision;
    if (!stageDecision || !selectedStageId) return { updated: false, reason: 'No deal stage selected.' };
    const selectedLabel = selectedStageLabel(stageDecision, selectedStageId) || selectedStageId;
    if (selectedStageId === stageDecision.currentStageId) {
      return { updated: false, reason: `Deal stayed in ${stageDecision.currentStageLabel}.`, fromLabel: stageDecision.currentStageLabel, toLabel: selectedLabel };
    }
    await this.hubspot.updateDealStage(stageDecision.dealId, selectedStageId);
    return { updated: true, dealId: stageDecision.dealId, fromStageId: stageDecision.currentStageId, toStageId: selectedStageId, fromLabel: stageDecision.currentStageLabel, toLabel: selectedLabel };
  }

  async updateHubSpotNextStep(record, value) {
    const dealId = record.stageDecision?.dealId || primaryDeal(record.meeting)?.id || '';
    if (!dealId) return { updated: false, reason: 'No associated deal found for HubSpot Next step.' };
    if (!this.config.hubspotNextStepProperty) return { updated: false, reason: 'No HubSpot Next step property configured.' };
    await this.hubspot.updateDealProperty(dealId, this.config.hubspotNextStepProperty, value);
    return { updated: true, dealId, propertyName: this.config.hubspotNextStepProperty };
  }

  async writeMeetingOutcome(promptKey, { status, hubspotNextStep = '', selectedStageId = '', slackUserId = '', responseChannel = '', responseThreadTs = '' } = {}) {
    const record = this.state.get(promptKey);
    if (!record) throw new Error(`Sales admin prompt state not found: ${promptKey}`);
    if (record.writebackStatus === 'written') return record;
    const meeting = record.meeting;
    const ae = record.ae;
    const effectiveStageId = status === 'no_show' ? '' : (selectedStageId || record.stageDecision?.recommendedStageId || '');
    const stageUpdate = status === 'no_show' ? { updated: false, reason: 'No-show confirmation does not move deal stage.' } : await this.applySelectedStage(record, effectiveStageId);
    const effectiveHubSpotNextStep = status === 'no_show' ? '' : (hubspotNextStep || hubspotNextStepSummary({ meeting, extraction: record.extraction, datePrefix: record.nextStepDatePrefix }));
    const nextStepPropertyUpdate = status === 'no_show'
      ? { updated: false, reason: 'No-show confirmation does not update HubSpot Next step.' }
      : await this.updateHubSpotNextStep(record, effectiveHubSpotNextStep).catch(err => ({ updated: false, reason: err.message }));
    const meetingOutcomeUpdate = status === 'no_show'
      ? await this.hubspot.updateMeetingOutcome(meeting.id, 'NO_SHOW')
          .then(() => ({ updated: true }))
          .catch(err => ({ updated: false, reason: err.message }))
      : { updated: false, reason: 'not a no-show' };
    const body = buildWritebackNote({
      ae,
      meeting,
      status,
      extraction: record.extraction,
      grainUrl: record.grainUrl,
      hubspotNextStep: effectiveHubSpotNextStep,
      nextStepDatePrefix: record.nextStepDatePrefix,
      stageDecision: record.stageDecision,
      selectedStageId: effectiveStageId,
      stageUpdate,
      nextStepPropertyUpdate,
    });
    const noShowOutcomeLine = status === 'no_show'
      ? `\nHubSpot meeting outcome set to No-Show.${meetingOutcomeUpdate.updated ? '' : ` (outcome update failed: ${meetingOutcomeUpdate.reason})`}`
      : '';
    const note = await this.hubspot.createNote({
      body: `${body}${noShowOutcomeLine}\nConfirmed by Slack user: ${slackUserId || 'unknown'}`,
      meeting,
      contacts: meeting._contacts || [],
      companies: meeting._companies || [],
      deals: meeting._deals || [],
    });
    const taskIds = [];
    if (this.config.createTasks && status !== 'no_show') {
      const steps = record.extraction?.nextSteps || [];
      for (const step of steps.slice(0, 5)) {
        const task = await this.hubspot.createTask({
          subject: `Follow up: ${meetingTitle(meeting)}`.slice(0, 250),
          body: step.text,
          dueDate: step.dueDate,
          ownerId: ae.hubspotOwnerId,
          meeting,
          contacts: meeting._contacts || [],
          companies: meeting._companies || [],
          deals: meeting._deals || [],
        });
        taskIds.push(task.id);
      }
    }
    const updated = this.state.update(promptKey, {
      confirmationStatus: status,
      hubspotNextStep: effectiveHubSpotNextStep,
      confirmedBySlackUser: slackUserId,
      hubspotNoteId: note.id,
      hubspotTaskIds: taskIds,
      selectedStageId: effectiveStageId,
      stageUpdate,
      nextStepPropertyUpdate,
      meetingOutcomeUpdate,
      writebackStatus: 'written',
      status: status === 'no_show' ? 'no_show' : 'confirmed',
    });
    const channel = responseChannel || record.slackChannel;
    const threadTs = responseThreadTs || record.slackTs;
    if (channel && threadTs) {
      await this.app.client.chat.postMessage({
        token: this.env.SLACK_BOT_TOKEN,
        channel,
        thread_ts: threadTs,
        text: `Recorded in HubSpot. Note ID: ${note.id}${status === 'no_show' ? '; marked No-Show' : ''}${nextStepPropertyUpdate?.updated ? '; Next step updated' : ''}${stageUpdate?.updated ? `; deal moved to ${stageUpdate.toLabel}` : ''}${taskIds.length ? `; tasks: ${taskIds.join(', ')}` : ''}`,
      }).catch(err => this.logger.warn(`Sales admin confirmation Slack reply failed: ${err.message}`));
    }
    return updated;
  }

  registerHandlers() {
    if (!this.app?.action || !this.app?.view) return;
    this.app.action(POST_ACTIONS.confirm, async ({ ack, body, action, client }) => {
      await ack();
      try {
        await this.writeMeetingOutcome(action.value, {
          status: 'confirmed',
          selectedStageId: selectedStageFromInteraction(body),
          slackUserId: body.user?.id,
          responseChannel: body.channel?.id || body.container?.channel_id,
          responseThreadTs: body.message?.ts || body.container?.message_ts,
        });
      } catch (err) {
        await client.chat.postMessage({ token: this.env.SLACK_BOT_TOKEN, channel: body.channel?.id || body.container?.channel_id, thread_ts: body.message?.ts || body.container?.message_ts, text: `Sales admin HubSpot write failed: ${err.message}` });
      }
    });

    this.app.action(POST_ACTIONS.noShow, async ({ ack, body, action, client }) => {
      await ack();
      try {
        await this.writeMeetingOutcome(action.value, {
          status: 'no_show',
          slackUserId: body.user?.id,
          responseChannel: body.channel?.id || body.container?.channel_id,
          responseThreadTs: body.message?.ts || body.container?.message_ts,
        });
      } catch (err) {
        await client.chat.postMessage({ token: this.env.SLACK_BOT_TOKEN, channel: body.channel?.id || body.container?.channel_id, thread_ts: body.message?.ts || body.container?.message_ts, text: `Sales admin no-show write failed: ${err.message}` });
      }
    });

    this.app.action(POST_ACTIONS.stageSelect, async ({ ack }) => {
      await ack();
    });

    this.app.action(POST_ACTIONS.ignore, async ({ ack, body, action, client }) => {
      await ack();
      const promptKey = action.value || action.selected_option?.value || '';
      this.state.update(promptKey, { status: 'ignored', ignoredBySlackUser: body.user?.id });
      await client.chat.postMessage({ token: this.env.SLACK_BOT_TOKEN, channel: body.channel?.id || body.container?.channel_id, thread_ts: body.message?.ts || body.container?.message_ts, text: 'Marked as not this meeting. Nothing was written to HubSpot.' });
    });

    this.app.action(POST_ACTIONS.edit, async ({ ack, body, action, client }) => {
      const receivedAt = Date.now();
      await ack();
      const channel = body.channel?.id || body.container?.channel_id;
      const threadTs = body.message?.ts || body.container?.message_ts;
      const record = this.state.get(action.value);
      if (!record) {
        await client.chat.postMessage({ token: this.env.SLACK_BOT_TOKEN, channel, thread_ts: threadTs, text: `Sales admin prompt state not found: ${action.value}` });
        return;
      }
      const selectedStageId = selectedStageFromInteraction(body, record.stageDecision?.recommendedStageId || '');
      try {
        await client.views.open({
          token: this.env.SLACK_BOT_TOKEN,
          trigger_id: body.trigger_id,
          view: {
            type: 'modal',
            callback_id: POST_ACTIONS.editSubmit,
            private_metadata: JSON.stringify({ promptKey: action.value, channel, threadTs }),
            title: { type: 'plain_text', text: 'Edit HubSpot next step' },
            submit: { type: 'plain_text', text: 'Save to HubSpot' },
            close: { type: 'plain_text', text: 'Cancel' },
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: 'Edit the short text that will be saved to the HubSpot deal `Next step` field.' } },
              { type: 'input', block_id: 'hubspot_next_step', label: { type: 'plain_text', text: 'HubSpot Next step' }, element: inputElement(record.hubspotNextStep || hubspotNextStepSummary({ meeting: record.meeting, extraction: record.extraction, datePrefix: record.nextStepDatePrefix })) },
              ...(record.stageDecision ? [{ type: 'input', block_id: 'deal_stage', label: { type: 'plain_text', text: 'Confirm deal stage' }, element: stageSelectElement(record.stageDecision, selectedStageId) }] : []),
            ],
          },
        });
      } catch (err) {
        const elapsedMs = Date.now() - receivedAt;
        const slackError = err?.data?.error || err.message;
        this.logger.error(`Sales admin edit modal failed after ${elapsedMs}ms: ${slackError}`);
        await client.chat.postMessage({ token: this.env.SLACK_BOT_TOKEN, channel, thread_ts: threadTs, text: `Sales admin edit modal failed to open: ${err.message}` }).catch(() => {});
      }
    });

    this.app.view(POST_ACTIONS.editSubmit, async ({ ack, body, view }) => {
      await ack();
      const metadata = JSON.parse(view.private_metadata || '{}');
      const values = view.state?.values || {};
      const hubspotNextStep = values.hubspot_next_step?.value?.value || '';
      const selectedStageId = values.deal_stage?.[POST_ACTIONS.stageSelect]?.selected_option?.value || '';
      try {
        await this.writeMeetingOutcome(metadata.promptKey, {
          status: 'edited',
          hubspotNextStep,
          selectedStageId,
          slackUserId: body.user?.id,
          responseChannel: metadata.channel,
          responseThreadTs: metadata.threadTs,
        });
      } catch (err) {
        this.logger.error(`Sales admin edit submit write failed: ${err.message}`);
        if (metadata.channel) {
          await this.app.client.chat.postMessage({ token: this.env.SLACK_BOT_TOKEN, channel: metadata.channel, thread_ts: metadata.threadTs, text: `Sales admin edit write failed: ${err.message}` }).catch(() => {});
        }
      }
    });
  }
}

function msUntilNextLocalTime({ now = new Date(), timeZone, hour, minute }) {
  const parts = getLocalDateParts(now, timeZone);
  let target = zonedLocalToUtc(parts.year, parts.month, parts.day, hour, minute, 0, timeZone);
  if (target <= now) {
    const nextUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 12, 0, 0));
    const nextParts = getLocalDateParts(nextUtc, timeZone);
    target = zonedLocalToUtc(nextParts.year, nextParts.month, nextParts.day, hour, minute, 0, timeZone);
  }
  return target.getTime() - now.getTime();
}

function scheduleSalesAdminWorkflow(workflow) {
  if (!workflow.isEnabled()) {
    workflow.logger.log('  Sales admin: disabled');
    return [];
  }
  const timers = [];
  const scheduleMorning = () => {
    const delay = msUntilNextLocalTime({ timeZone: workflow.config.timezone, hour: workflow.config.morningHour, minute: workflow.config.morningMinute });
    timers.push(setTimeout(async () => {
      await workflow.runMorningSummaries().catch(err => workflow.logger.error(`Sales admin morning scheduled run failed: ${err.message}`));
      scheduleMorning();
    }, delay));
    workflow.logger.log(`  Sales admin morning scheduled in ${Math.round(delay / 60000)} min`);
  };
  scheduleMorning();
  const scheduleTomorrow = () => {
    const delay = msUntilNextLocalTime({ timeZone: workflow.config.timezone, hour: workflow.config.tomorrowHour, minute: workflow.config.tomorrowMinute });
    timers.push(setTimeout(async () => {
      await workflow.runTomorrowSummaries().catch(err => workflow.logger.error(`Sales admin tomorrow scheduled run failed: ${err.message}`));
      scheduleTomorrow();
    }, delay));
    workflow.logger.log(`  Sales admin tomorrow summary scheduled in ${Math.round(delay / 60000)} min`);
  };
  scheduleTomorrow();
  timers.push(setInterval(() => workflow.runCancellationScan().catch(err => workflow.logger.error(`Sales admin cancellation scheduled run failed: ${err.message}`)), workflow.config.cancelScanMin * 60 * 1000));
  timers.push(setInterval(() => workflow.runPostMeetingScan().catch(err => workflow.logger.error(`Sales admin post-meeting scheduled run failed: ${err.message}`)), workflow.config.scanIntervalMin * 60 * 1000));
  return timers;
}

function createSalesAdminWorkflow(deps) {
  return new SalesAdminWorkflow(deps);
}

module.exports = {
  DEFAULT_AE_ROSTER,
  POST_ACTIONS,
  SalesAdminWorkflow,
  buildConfig,
  buildWritebackNote,
  cancellationSourceLabel,
  classifyMeetingStatus,
  createSalesAdminWorkflow,
  extractNextSteps,
  getLocalDayRange,
  buildStageDecision,
  hubspotNextStepSummary,
  meetingEndMs,
  msUntilNextLocalTime,
  parseRoster,
  recordingDirectlyMatchesMeeting,
  resolveChannelId,
  selectedStageFromInteraction,
  scheduleSalesAdminWorkflow,
};
