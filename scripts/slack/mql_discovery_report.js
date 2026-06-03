const DEFAULT_PIPELINE_ID = '105321581';
const DEFAULT_MQL_STAGE_ID = '1307720553';
const NEXT_MEETING_PROPERTY = 'hs_next_meeting_start_time';
const MQL_ENTERED_PROPERTY = 'hs_v2_date_entered_1307720553';
const MQL_EXITED_PROPERTY = 'hs_v2_date_exited_1307720553';
const DEFAULT_TIMEZONE = 'America/Los_Angeles';
const DEFAULT_PORTAL_ID = '43974586';

const STAGE_LABELS = {
  1307720553: 'Stage 1: MQL',
  190380582: 'Stage 2: SQL',
  190380583: 'Stage 3: Full Product Demo',
  190380586: 'Stage 4: POC',
  190380584: 'Stage 5: Proposal',
  1166230571: 'Closed Won',
  190380587: 'Closed Lost',
};

const OPEN_ADVANCED_STAGE_IDS = new Set(['190380582', '190380583', '190380586', '190380584']);
const CLOSED_WON_STAGE_IDS = new Set(['1166230571']);
const CLOSED_LOST_STAGE_IDS = new Set(['190380587']);

const REPORT_DEAL_PROPERTIES = [
  'dealname',
  'dealstage',
  'pipeline',
  'createdate',
  'closedate',
  'amount',
  'hubspot_owner_id',
  NEXT_MEETING_PROPERTY,
  MQL_ENTERED_PROPERTY,
  MQL_EXITED_PROPERTY,
];

const OUTCOME_ORDER = [
  'stillMql',
  'advancedOpen',
  'closedWon',
  'closedLost',
  'rescheduledFuture',
  'missingNextMeeting',
  'other',
];

const OUTCOME_LABELS = {
  stillMql: 'Still MQL',
  advancedOpen: 'Advanced to Stage 2 SQL or later open stage',
  closedWon: 'Closed won',
  closedLost: 'Closed lost',
  rescheduledFuture: 'Rescheduled/future meeting',
  missingNextMeeting: 'Missing next meeting time',
  other: 'Other',
};

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
  timeZone: DEFAULT_TIMEZONE,
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

const PACIFIC_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: DEFAULT_TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

function parseDateValue(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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

function getPacificDayWindow(referenceDate = new Date()) {
  const parts = getPacificParts(referenceDate);
  const start = pacificLocalToUtcDate(parts.year, parts.month, parts.day, 0, 0, 0);
  const nextDay = shiftPacificDate(parts, 1);
  const end = pacificLocalToUtcDate(nextDay.year, nextDay.month, nextDay.day, 0, 0, 0);
  return { parts, start, end };
}

function getNextBusinessDayWindow(referenceDate = new Date()) {
  let nextParts = shiftPacificDate(getPacificParts(referenceDate), 1);
  while (true) {
    const noon = pacificLocalToUtcDate(nextParts.year, nextParts.month, nextParts.day, 12, 0, 0);
    const weekdayIndex = getPacificParts(noon).weekdayIndex;
    if (weekdayIndex !== 0 && weekdayIndex !== 6) break;
    nextParts = shiftPacificDate(nextParts, 1);
  }
  const start = pacificLocalToUtcDate(nextParts.year, nextParts.month, nextParts.day, 0, 0, 0);
  const following = shiftPacificDate(nextParts, 1);
  const end = pacificLocalToUtcDate(following.year, following.month, following.day, 0, 0, 0);
  return { parts: getPacificParts(start), start, end };
}

function formatPacificDateLabel(parts) {
  return `${parts.month}/${parts.day}/${String(parts.year).slice(-2)}`;
}

function formatPacificTime(isoValue) {
  const date = parseDateValue(isoValue);
  return date ? PACIFIC_TIME_FORMATTER.format(date).replace(/\s/g, ' ') : '';
}

function isInWindow(isoValue, start, end) {
  const date = parseDateValue(isoValue);
  return !!date && date >= start && date < end;
}

function dealUrl(dealId, portalId = DEFAULT_PORTAL_ID) {
  return `https://app.hubspot.com/contacts/${portalId}/deal/${dealId}`;
}

function slackDealLink(deal, portalId) {
  const name = deal.properties?.dealname || `Deal ${deal.id}`;
  return `<${dealUrl(deal.id, portalId)}|${name}>`;
}

function getStageLabel(stageId) {
  return STAGE_LABELS[stageId] || `Stage ${stageId || '(blank)'}`;
}

function getHistoryVersions(deal, propertyName) {
  const fromHistory = deal.propertiesWithHistory?.[propertyName];
  if (Array.isArray(fromHistory)) return fromHistory;
  const fromProperty = deal.properties?.[propertyName];
  if (Array.isArray(fromProperty?.versions)) return fromProperty.versions;
  return [];
}

function getUniquePropertyValues(deal, propertyName) {
  const values = new Set();
  const current = deal.properties?.[propertyName];
  if (typeof current === 'string' && current.trim()) values.add(current);
  for (const version of getHistoryVersions(deal, propertyName)) {
    const value = typeof version === 'string' ? version : version?.value;
    if (value) values.add(value);
  }
  return Array.from(values);
}

function wasMqlAtStartOfDay(deal, startOfDay) {
  const properties = deal.properties || {};
  const enteredAt = parseDateValue(properties[MQL_ENTERED_PROPERTY]);
  const exitedAt = parseDateValue(properties[MQL_EXITED_PROPERTY]);
  if (!enteredAt) return false;
  return enteredAt <= startOfDay && (!exitedAt || exitedAt > startOfDay);
}

function classifyCurrentOutcome(deal, todayStart, todayEnd) {
  const properties = deal.properties || {};
  const stageId = String(properties.dealstage || '');
  const nextMeeting = properties[NEXT_MEETING_PROPERTY] || '';
  const nextMeetingDate = parseDateValue(nextMeeting);

  if (CLOSED_WON_STAGE_IDS.has(stageId)) return 'closedWon';
  if (CLOSED_LOST_STAGE_IDS.has(stageId)) return 'closedLost';
  if (OPEN_ADVANCED_STAGE_IDS.has(stageId)) return 'advancedOpen';
  if (!nextMeeting) return 'missingNextMeeting';
  if (nextMeetingDate && nextMeetingDate >= todayEnd) return 'rescheduledFuture';
  if (stageId === DEFAULT_MQL_STAGE_ID) return 'stillMql';
  if (nextMeetingDate && nextMeetingDate < todayStart) return 'other';
  return 'other';
}

function buildDealSummary(deal, portalId) {
  const properties = deal.properties || {};
  const nextMeeting = properties[NEXT_MEETING_PROPERTY] || '';
  const pieces = [
    slackDealLink(deal, portalId),
    getStageLabel(properties.dealstage),
  ];
  if (nextMeeting) pieces.push(`${formatPacificTime(nextMeeting)} PT`);
  return pieces.join(' - ');
}

async function searchPipelineDeals(hubspot, pipelineId) {
  const deals = [];
  let after;

  for (let page = 0; page < 100; page += 1) {
    const body = {
      filterGroups: [{
        filters: [{ propertyName: 'pipeline', operator: 'EQ', value: pipelineId }],
      }],
      properties: REPORT_DEAL_PROPERTIES,
      limit: 100,
      sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
    };
    if (after) body.after = after;

    const response = await hubspot('/crm/v3/objects/deals/search', 'POST', body);
    deals.push(...(response.results || []));
    after = response.paging?.next?.after;
    if (!after) break;
  }

  return deals;
}

async function hydrateDealsWithHistory(hubspot, deals) {
  const hydrated = [];
  const notes = [];

  for (let index = 0; index < deals.length; index += 50) {
    const batch = deals.slice(index, index + 50);
    try {
      const response = await hubspot('/crm/v3/objects/deals/batch/read', 'POST', {
        properties: REPORT_DEAL_PROPERTIES,
        propertiesWithHistory: [NEXT_MEETING_PROPERTY, 'dealstage', MQL_ENTERED_PROPERTY, MQL_EXITED_PROPERTY],
        inputs: batch.map(deal => ({ id: deal.id })),
      });
      hydrated.push(...(response.results || []));
    } catch (err) {
      notes.push(`HubSpot property history batch read failed; fell back to current deal properties only (${err.message}).`);
      hydrated.push(...batch);
    }
  }

  return { deals: hydrated, notes };
}

function analyzeMqlDiscoveryDeals(deals, options = {}) {
  const now = options.now || new Date();
  const portalId = options.portalId || DEFAULT_PORTAL_ID;
  const todayWindow = getPacificDayWindow(now);
  const nextBusinessDayWindow = getNextBusinessDayWindow(now);
  const dataQualityNotes = [];

  const currentNextBusinessDayMqlDeals = deals
    .filter(deal => String(deal.properties?.dealstage || '') === DEFAULT_MQL_STAGE_ID)
    .filter(deal => isInWindow(deal.properties?.[NEXT_MEETING_PROPERTY], nextBusinessDayWindow.start, nextBusinessDayWindow.end))
    .sort((a, b) => String(a.properties?.[NEXT_MEETING_PROPERTY] || '').localeCompare(String(b.properties?.[NEXT_MEETING_PROPERTY] || '')));

  const missingMqlHistory = deals.filter(deal => {
    if (deal.properties?.[MQL_ENTERED_PROPERTY]) return false;
    const meetingValues = getUniquePropertyValues(deal, NEXT_MEETING_PROPERTY);
    return meetingValues.some(value => isInWindow(value, todayWindow.start, todayWindow.end));
  });
  if (missingMqlHistory.length) {
    dataQualityNotes.push(
      `${missingMqlHistory.length} deals with a current/history meeting today were missing ${MQL_ENTERED_PROPERTY}; they were excluded from the 00:00 PT MQL cohort.`,
    );
  }

  const mqlAtStartDeals = deals.filter(deal => wasMqlAtStartOfDay(deal, todayWindow.start));
  const todaysCallDeals = [];

  for (const deal of mqlAtStartDeals) {
    const meetingValues = getUniquePropertyValues(deal, NEXT_MEETING_PROPERTY);
    const hadTodayMeeting = meetingValues.some(value => isInWindow(value, todayWindow.start, todayWindow.end));
    if (!hadTodayMeeting) continue;

    const currentMeeting = deal.properties?.[NEXT_MEETING_PROPERTY] || '';
    const currentIsToday = isInWindow(currentMeeting, todayWindow.start, todayWindow.end);
    if (!currentMeeting) {
      dataQualityNotes.push(`${deal.properties?.dealname || deal.id} has a today meeting in ${NEXT_MEETING_PROPERTY} history, but current ${NEXT_MEETING_PROPERTY} is blank.`);
    } else if (!currentIsToday) {
      dataQualityNotes.push(`${deal.properties?.dealname || deal.id} has a today meeting in ${NEXT_MEETING_PROPERTY} history, but current value is ${currentMeeting}.`);
    }

    todaysCallDeals.push(deal);
  }

  const outcomes = Object.fromEntries(OUTCOME_ORDER.map(key => [key, []]));
  for (const deal of todaysCallDeals) {
    outcomes[classifyCurrentOutcome(deal, todayWindow.start, todayWindow.end)].push(deal);
  }
  for (const key of OUTCOME_ORDER) {
    outcomes[key].sort((a, b) => (a.properties?.dealname || '').localeCompare(b.properties?.dealname || ''));
  }

  return {
    generatedAt: now.toISOString(),
    today: {
      label: formatPacificDateLabel(todayWindow.parts),
      start: todayWindow.start.toISOString(),
      end: todayWindow.end.toISOString(),
    },
    nextBusinessDay: {
      label: formatPacificDateLabel(nextBusinessDayWindow.parts),
      start: nextBusinessDayWindow.start.toISOString(),
      end: nextBusinessDayWindow.end.toISOString(),
    },
    currentNextBusinessDayMqlDeals,
    mqlAtStartCount: mqlAtStartDeals.length,
    todaysCallDeals,
    outcomes,
    dataQualityNotes,
    portalId,
  };
}

function formatMqlDiscoveryReport(report) {
  const lines = [
    `*Daily HubSpot MQL Discovery Report -- ${report.today.label} PT*`,
    '',
    `*Current MQL deals with next meeting on next business day (${report.nextBusinessDay.label} PT): ${report.currentNextBusinessDayMqlDeals.length}*`,
  ];

  if (report.currentNextBusinessDayMqlDeals.length === 0) {
    lines.push('- None');
  } else {
    for (const deal of report.currentNextBusinessDayMqlDeals) {
      lines.push(`- ${buildDealSummary(deal, report.portalId)}`);
    }
  }

  lines.push('');
  lines.push(`*Today's discovery-call cohort: ${report.todaysCallDeals.length} calls from ${report.mqlAtStartCount} deals that were MQL at 00:00 PT*`);
  for (const key of OUTCOME_ORDER) {
    const deals = report.outcomes[key];
    lines.push(`${OUTCOME_LABELS[key]}: ${deals.length}`);
    for (const deal of deals.slice(0, 10)) {
      lines.push(`- ${buildDealSummary(deal, report.portalId)}`);
    }
    if (deals.length > 10) lines.push(`- ...and ${deals.length - 10} more`);
  }

  lines.push('');
  lines.push('*Data quality notes*');
  if (report.dataQualityNotes.length === 0) {
    lines.push('- None');
  } else {
    for (const note of report.dataQualityNotes.slice(0, 12)) lines.push(`- ${note}`);
    if (report.dataQualityNotes.length > 12) lines.push(`- ...and ${report.dataQualityNotes.length - 12} more`);
  }

  return lines.join('\n');
}

async function buildMqlDiscoveryReport(hubspot, options = {}) {
  const pipelineId = options.pipelineId || DEFAULT_PIPELINE_ID;
  const searchedDeals = await searchPipelineDeals(hubspot, pipelineId);
  const { deals, notes } = await hydrateDealsWithHistory(hubspot, searchedDeals);
  const report = analyzeMqlDiscoveryDeals(deals, options);
  report.dataQualityNotes.push(...notes);
  report.pipelineId = pipelineId;
  report.pipelineName = 'Active Pipeline';
  return report;
}

module.exports = {
  DEFAULT_MQL_STAGE_ID,
  DEFAULT_PIPELINE_ID,
  MQL_ENTERED_PROPERTY,
  MQL_EXITED_PROPERTY,
  NEXT_MEETING_PROPERTY,
  OUTCOME_LABELS,
  OUTCOME_ORDER,
  analyzeMqlDiscoveryDeals,
  buildMqlDiscoveryReport,
  classifyCurrentOutcome,
  formatMqlDiscoveryReport,
  getNextBusinessDayWindow,
  getPacificDayWindow,
  pacificLocalToUtcDate,
  wasMqlAtStartOfDay,
};
