const { readRegistry } = require('./demo-routing');
const { eligible, externalAttendees, occurrenceKey } = require('./google-calendar-deal-sync');
const normalize = value => String(value || '').trim().toLowerCase();

// Unlike the existing-deal calendar sync, this starts with the registered AEs:
// the prospect has no deal owner yet. Read every calendar before choosing one.
function createNooksMeetingOwnerResolver({ request, calendar, env = process.env, now = Date.now }) {
  const registry = readRegistry(env);
  if (!registry.size) throw new Error('nooks_ae_registry_required');
  return async ({ email, repEmail }) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalize(repEmail))) throw new Error('nooks_sdr_email_required');
    const owners = new Map();
    for (const ownerId of registry.keys()) {
      const owner = await request(`/crm/v3/owners/${encodeURIComponent(ownerId)}`);
      const address = normalize(owner.email);
      if (owner.archived !== false || String(owner.id) !== ownerId || !address.includes('@') || owners.has(address)) {
        throw new Error('nooks_ae_owner_unverified');
      }
      owners.set(address, ownerId);
    }
    const start = now();
    const until = start + 365 * 86400000;
    const events = new Map();
    for (const calendarId of owners.keys()) {
      let pageToken;
      const seen = new Set();
      do {
        const response = await calendar.events.list({ calendarId, timeMin: new Date(start).toISOString(),
          timeMax: new Date(until).toISOString(), singleEvents: true, showDeleted: false,
          maxResults: 2500, ...(pageToken ? { pageToken } : {}),
        }, { timeout: 20000 });
        const page = response.data;
        if (!['owner', 'writer', 'reader'].includes(page?.accessRole) || !Array.isArray(page.items)) {
          throw new Error('nooks_ae_calendar_unavailable');
        }
        for (const event of page.items) {
          if (!eligible(event, start, until) || !externalAttendees(event).includes(normalize(email))) continue;
          const key = occurrenceKey(event);
          if (!events.has(key)) events.set(key, []);
          events.get(key).push({ event, calendarId });
        }
        pageToken = page.nextPageToken;
        if (pageToken && seen.has(pageToken)) throw new Error('nooks_ae_calendar_pagination_invalid');
        if (pageToken) seen.add(pageToken);
      } while (pageToken);
    }
    const meetings = [];
    for (const copies of events.values()) {
      // Copies must agree on the host and slot. Conflicting or stale copies
      // remain pending until Google Calendar converges.
      const candidates = new Set();
      const starts = new Set();
      for (const { event, calendarId } of copies) {
        starts.add(Date.parse(event.start.dateTime));
        const attendees = new Set((event.attendees || []).filter(a => !a.resource && a.responseStatus !== 'declined').map(a => normalize(a.email)));
        const organizer = normalize(event.organizer?.email);
        const hosts = owners.has(organizer) && organizer !== normalize(repEmail) && attendees.has(organizer)
          ? [organizer] : [...attendees].filter(a => owners.has(a) && a !== normalize(repEmail));
        if (hosts.length !== 1 || !attendees.has(calendarId)) throw new Error('nooks_meeting_ae_ambiguous');
        candidates.add(owners.get(hosts[0]));
      }
      if (starts.size !== 1 || candidates.size !== 1) throw new Error('nooks_meeting_ae_ambiguous');
      meetings.push({ start: [...starts][0], ownerId: [...candidates][0] });
    }
    meetings.sort((a, b) => a.start - b.start);
    if (!meetings.length) throw new Error('nooks_meeting_not_found');
    const next = meetings.filter(m => m.start === meetings[0].start);
    if (next.length !== 1) throw new Error('nooks_meeting_ae_ambiguous');
    return next[0].ownerId;
  };
}
module.exports = { createNooksMeetingOwnerResolver };
