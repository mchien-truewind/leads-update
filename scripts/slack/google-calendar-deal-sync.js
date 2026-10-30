const { createHash } = require('node:crypto');

const EVENT_KEY = 'truewind_google_calendar_event_key';
const DAY = 86400000;
const normalize = value => String(value || '').trim().toLowerCase();
const INTERNAL_DOMAINS = new Set(['trytruewind.com', 'truewind.ai', 'truewindai.com']);
const internal = email => INTERNAL_DOMAINS.has(normalize(email).split('@')[1]);
const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const MEETING_PROPERTIES = ['hs_timestamp', EVENT_KEY, 'hs_meeting_source_id', 'hs_meeting_external_url', 'hs_meeting_start_time',
  'hs_meeting_end_time', 'hs_meeting_title', 'hs_meeting_outcome', 'hubspot_owner_id', 'calendly_event_uuid'];

function occurrenceKey(event) {
  if (!event.iCalUID) throw new Error('calendar_occurrence_identity_missing');
  const original = event.originalStartTime?.dateTime ? new Date(event.originalStartTime.dateTime).toISOString() : event.originalStartTime?.date || '';
  return createHash('sha256').update(JSON.stringify([event.iCalUID, original])).digest('hex');
}

function externalAttendees(event) {
  return [...new Set((event.attendees || []).filter(a => !a.resource && a.responseStatus !== 'declined')
    .map(a => normalize(a.email)).filter(e => e.includes('@') && !internal(e)))];
}

function eligible(event, now, until) {
  const start = time(event.start?.dateTime), end = time(event.end?.dateTime);
  return event.status !== 'cancelled' && (!event.eventType || event.eventType === 'default')
    && event.visibility !== 'private' && !event.attendeesOmitted && start !== null && end !== null && end > start
    && start >= now && start < until && externalAttendees(event).length > 0;
}

function nativeIdentity(meeting, event) {
  const p = meeting.properties || {};
  if (p[EVENT_KEY] === event.key || (p.hs_meeting_source_id && event.ids.has(p.hs_meeting_source_id))) return true;
  try {
    const url = new URL(p.hs_meeting_external_url);
    if (!['calendar.google.com', 'www.google.com'].includes(url.hostname)) return false;
    const encoded = url.searchParams.get('eid');
    return encoded && event.ids.has(Buffer.from(encoded, 'base64url').toString().split(' ')[0]);
  } catch { return false; }
}

function chooseDeal(candidateIds, existingDealIds = []) {
  const candidates = [...new Set(candidateIds)];
  if (candidates.length === 1) return candidates[0];
  const linked = candidates.filter(id => existingDealIds.includes(id));
  return linked.length === 1 ? linked[0] : null;
}

class GoogleCalendarDealSync {
  constructor({ pool, request, calendar, logger = console, now = Date.now, env = process.env }) {
    Object.assign(this, { pool, request, calendar, logger, now, env });
    this.horizonDays = Math.min(730, Math.max(1, Number(env.GOOGLE_CALENDAR_DEAL_SYNC_HORIZON_DAYS) || 365));
    this.intervalMs = Math.max(60000, Number(env.GOOGLE_CALENDAR_DEAL_SYNC_INTERVAL_MS) || 60000);
  }

  async initialize() {
    const property = await this.request(`/crm/v3/properties/meetings/${EVENT_KEY}`);
    if (property.type !== 'string' || property.hasUniqueValue !== true) throw new Error('calendar_unique_meeting_property_required');
    await this.pool.query(`CREATE TABLE IF NOT EXISTS google_calendar_deal_meetings (
      event_key TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, calendar_id TEXT NOT NULL, event_id TEXT NOT NULL,
      start_at TIMESTAMPTZ NOT NULL, owned_deal_id TEXT, deal_id TEXT, active BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await this.pool.query('ALTER TABLE google_calendar_deal_meetings ADD COLUMN IF NOT EXISTS deal_id TEXT');
  }

  async pages(path, field = 'results', initialAfter) {
    const rows = [], cursors = new Set();
    let after = initialAfter;
    do {
      const page = await this.request(`${path}${after == null ? '' : `&after=${encodeURIComponent(after)}`}`);
      if (!Array.isArray(page[field])) throw new Error('calendar_hubspot_page_invalid');
      rows.push(...page[field]);
      after = page.paging?.next?.after;
      if (after != null && cursors.has(String(after))) throw new Error('calendar_cursor_repeated');
      if (after != null) cursors.add(String(after));
    } while (after != null);
    return rows;
  }

  async associations(type, id, target) {
    const rows = await this.pages(`/crm/v4/objects/${type}/${id}/associations/${target}?limit=500`);
    if (rows.some(row => !/^\d+$/.test(String(row.toObjectId)))) throw new Error('calendar_association_id_invalid');
    return [...new Set(rows.map(row => String(row.toObjectId)))];
  }

  async associationIndex(type, ids, target) {
    const index = new Map();
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000).map(String);
      const page = await this.request(`/crm/v4/associations/${type}/${target}/batch/read`, {
        method: 'POST', body: { inputs: chunk.map(id => ({ id })) },
      });
      if (page.status !== 'COMPLETE' || !Array.isArray(page.results)) throw new Error('calendar_association_batch_incomplete');
      for (const error of page.errors || []) {
        const missing = error.context?.fromObjectId;
        if (error.subCategory !== 'crm.associations.NO_ASSOCIATIONS_FOUND' || !Array.isArray(missing)) throw new Error('calendar_association_batch_error');
        for (const id of missing.map(String)) {
          if (!chunk.includes(id) || index.has(id)) throw new Error('calendar_association_batch_identity');
          index.set(id, []);
        }
      }
      for (const row of page.results) {
        const id = String(row.from?.id);
        if (!chunk.includes(id) || index.has(id) || !Array.isArray(row.to)) throw new Error('calendar_association_batch_identity');
        const rest = row.paging?.next?.after == null ? [] : await this.pages(
          `/crm/v4/objects/${type}/${id}/associations/${target}?limit=500`, 'results', row.paging.next.after);
        const related = [...row.to, ...rest].map(r => String(r.toObjectId));
        if (related.some(id => !/^\d+$/.test(id))) throw new Error('calendar_association_id_invalid');
        index.set(id, [...new Set(related)]);
      }
      if (chunk.some(id => !index.has(id))) throw new Error('calendar_association_batch_incomplete');
    }
    return index;
  }

  async search(type, filters, properties) {
    const rows = [], cursors = new Set();
    let after;
    do {
      const page = await this.request(`/crm/v3/objects/${type}/search`, { method: 'POST', body: {
        filterGroups: [{ filters }], properties, limit: 200, ...(after == null ? {} : { after }),
      } });
      if (!Array.isArray(page.results) || page.total > 10000) throw new Error('calendar_search_incomplete');
      rows.push(...page.results);
      after = page.paging?.next?.after;
      if (after != null && cursors.has(String(after))) throw new Error('calendar_search_cursor_repeated');
      if (after != null) cursors.add(String(after));
    } while (after != null);
    return rows;
  }

  async contacts(ids) {
    const rows = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const page = await this.request('/crm/v3/objects/contacts/batch/read', { method: 'POST', body: {
        properties: ['email', 'hs_additional_emails'], inputs: chunk.map(id => ({ id })),
      } });
      if (!Array.isArray(page.results) || page.errors?.length || page.results.length !== chunk.length
        || new Set(page.results.map(row => String(row.id))).size !== chunk.length
        || page.results.some(row => !chunk.includes(String(row.id)))) throw new Error('calendar_contacts_incomplete');
      rows.push(...page.results.filter(row => !row.archived));
    }
    return rows;
  }

  async snapshot() {
    const now = this.now(), until = now + this.horizonDays * DAY;
    const deals = await this.search('deals', [{ propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' }], ['dealname', 'hubspot_owner_id', 'hs_next_meeting_start_time']);
    const owners = await this.pages('/crm/v3/owners?limit=100&archived=false');
    const ownerById = new Map(owners.filter(o => !o.archived && normalize(o.email).includes('@')).map(o => [String(o.id), normalize(o.email)]));
    const dealOwners = new Map(), roster = new Map();
    for (const deal of deals) {
      const ownerId = String(deal.properties.hubspot_owner_id || ''), calendarId = ownerById.get(ownerId);
      if (!calendarId) continue;
      dealOwners.set(String(deal.id), { ownerId, calendarId });
      roster.set(calendarId, ownerId);
    }
    const events = new Map(), readable = new Set(), unavailable = [];
    const calendars = await Promise.all([...roster].map(async ([calendarId, ownerId]) => {
      let pageToken;
      const cursors = new Set(), copies = [];
      try {
        do {
          const { data } = await this.calendar.events.list({ calendarId, timeMin: new Date(now).toISOString(),
            timeMax: new Date(until).toISOString(), singleEvents: true, showDeleted: false, maxResults: 2500, pageToken }, { timeout: 20000 });
          if (!['owner', 'writer', 'reader'].includes(data.accessRole) || (data.items != null && !Array.isArray(data.items))) throw new Error('calendar_event_details_unavailable');
          copies.push(...(data.items || []));
          pageToken = data.nextPageToken;
          if (pageToken && cursors.has(pageToken)) throw new Error('calendar_page_token_repeated');
          if (pageToken) cursors.add(pageToken);
        } while (pageToken);
        readable.add(calendarId);
      } catch (error) {
        // A failed/partial calendar read must never imply that its meetings were cancelled.
        unavailable.push({ calendarId, status: Number(error.code || error.statusCode) || 'unavailable' });
        return null;
      }
      return { calendarId, ownerId, copies };
    }));
    for (const calendar of calendars.filter(Boolean)) {
      const { calendarId, ownerId, copies } = calendar;
      for (const copy of copies) {
        if (!copy.iCalUID) continue;
        const key = occurrenceKey(copy), existing = events.get(key);
        const variant = { ...copy, key, calendarId, ownerId, ids: new Set([copy.id]), calendarCopies: new Map([[ownerId, { ...copy, calendarId, ownerId }]]) };
        if (!existing) events.set(key, variant);
        else {
          const ids = new Set([...existing.ids, copy.id]);
          const calendarCopies = new Map([...existing.calendarCopies, ...variant.calendarCopies]);
          // Prefer the organizer's authoritative copy over an invitee's stale copy.
          const organizerCopy = normalize(copy.organizer?.email) === normalize(calendarId);
          const wasOrganizer = normalize(existing.organizer?.email) === normalize(existing.calendarId);
          if ((organizerCopy && !wasOrganizer) || (organizerCopy === wasOrganizer && time(copy.updated) > time(existing.updated))) events.set(key, { ...variant, ids, calendarCopies });
          else { existing.ids = ids; existing.calendarCopies = calendarCopies; }
        }
      }
    }
    if (roster.size && !readable.size) throw new Error('calendar_no_readable_calendars');
    for (const [key, event] of events) if (!eligible(event, now, until)) events.delete(key);
    const contactDeals = new Map();
    const dealContacts = await this.associationIndex('deals', [...dealOwners.keys()], 'contacts');
    for (const deal of deals) {
      for (const id of dealContacts.get(String(deal.id)) || []) {
        if (!contactDeals.has(id)) contactDeals.set(id, new Set());
        contactDeals.get(id).add(String(deal.id));
      }
    }
    const emailContacts = new Map();
    for (const contact of await this.contacts([...contactDeals.keys()])) {
      for (const email of [contact.properties.email, ...(contact.properties.hs_additional_emails || '').split(';')].map(normalize)) {
        if (!email || internal(email)) continue;
        if (!emailContacts.has(email)) emailContacts.set(email, new Set());
        emailContacts.get(email).add(String(contact.id));
      }
    }
    const meetings = await this.search('meetings', [
      { propertyName: 'hs_meeting_start_time', operator: 'GTE', value: String(now - DAY) },
      { propertyName: 'hs_meeting_start_time', operator: 'LT', value: String(until) },
    ], MEETING_PROPERTIES);
    const meetingIds = meetings.map(m => String(m.id));
    const [meetingDeals, meetingContacts] = await Promise.all([
      this.associationIndex('meetings', meetingIds, 'deals'), this.associationIndex('meetings', meetingIds, 'contacts'),
    ]);
    return { now, until, events, readable, unavailable, deals, meetings, emailContacts, contactDeals, dealOwners, meetingDeals, meetingContacts };
  }

  async plan(snapshot, event) {
    const contacts = [...new Set(externalAttendees(event).flatMap(email => [...(snapshot.emailContacts.get(email) || [])]))];
    const ownedContact = (contactId, dealId) => {
      const owner = snapshot.dealOwners.get(dealId), copy = owner && event.calendarCopies?.get(owner.ownerId);
      return copy && copy.calendarId === owner.calendarId && eligible(copy, snapshot.now, Infinity)
        && externalAttendees(copy).some(email => snapshot.emailContacts.get(email)?.has(contactId));
    };
    const candidates = [...new Set(contacts.flatMap(id => [...(snapshot.contactDeals.get(id) || [])].filter(dealId => ownedContact(id, dealId))))];
    if (!candidates.length) return { reason: 'no_customer_deal' };
    let matches = snapshot.meetings.filter(m => nativeIdentity(m, event));
    if (!matches.length) {
      // Older Calendly/manual records lack a Google event ID. Require the exact
      // start, end, title AND an associated attendee contact before reusing one.
      const sameSlot = snapshot.meetings.filter(m => time(m.properties.hs_meeting_start_time) === time(event.start.dateTime)
        && time(m.properties.hs_meeting_end_time) === time(event.end.dateTime)
        && normalize(m.properties.hs_meeting_title) === normalize(event.summary));
      for (const m of sameSlot) {
        const associated = snapshot.meetingContacts?.get(String(m.id)) || await this.associations('meetings', m.id, 'contacts');
        if (associated.some(id => contacts.includes(id))) matches.push(m);
      }
    }
    const matchDeals = new Map();
    for (const meeting of matches) matchDeals.set(meeting.id, snapshot.meetingDeals?.get(String(meeting.id)) || await this.associations('meetings', meeting.id, 'deals'));
    const dealId = chooseDeal(candidates, [...matchDeals.values()].flat());
    if (!dealId) return { reason: 'ambiguous_deal' };
    // A matching meeting already assigned elsewhere is not silently moved.
    const identityMatches = matches.length;
    matches = matches.filter(m => !(matchDeals.get(m.id) || []).length || matchDeals.get(m.id).includes(dealId));
    if (identityMatches && !matches.length) return { reason: 'ambiguous_existing_association' };
    if (matches.length > 1) {
      const linked = matches.filter(m => matchDeals.get(m.id).includes(dealId));
      if (linked.length === 1) matches = linked;
      else return { reason: 'ambiguous_meeting' };
    }
    const meeting = matches[0];
    const owner = snapshot.dealOwners.get(dealId), copy = event.calendarCopies.get(owner.ownerId);
    return { dealId, contacts: contacts.filter(id => snapshot.contactDeals.get(id)?.has(dealId) && ownedContact(id, dealId)), meeting,
      calendarId: owner.calendarId, ownerId: owner.ownerId, eventId: copy.id, copy,
      existingDeals: meeting && matchDeals.get(meeting.id), existingContacts: meeting && snapshot.meetingContacts?.get(String(meeting.id)),
      linked: meeting ? matchDeals.get(meeting.id).includes(dealId) : false };
  }

  async uniqueMeeting(key) {
    try { return await this.request(`/crm/v3/objects/meetings/${key}?idProperty=${EVENT_KEY}&properties=${MEETING_PROPERTIES.join(',')}`); }
    catch (error) { if (error.statusCode === 404) return null; throw error; }
  }

  async persist(client, event, plan, prior) {
    let meeting = prior
      ? (String(plan.meeting?.id) === prior.meeting_id ? plan.meeting : await this.request(`/crm/v3/objects/meetings/${prior.meeting_id}?properties=${MEETING_PROPERTIES.join(',')}`))
      : plan.meeting || await this.uniqueMeeting(event.key);
    if (meeting?.archived) throw new Error('calendar_meeting_archived');
    const properties = { hs_timestamp: event.start.dateTime, hs_meeting_start_time: event.start.dateTime,
      hs_meeting_end_time: event.end.dateTime, hs_meeting_title: event.summary || 'Customer meeting',
      hs_meeting_external_url: event.htmlLink || '', [EVENT_KEY]: event.key };
    if (!meeting) properties.hs_meeting_source_id = event.id;
    // Preserve an explicitly recorded no-show/completed outcome. Future canceled
    // or rescheduled meetings can become scheduled again when Calendar confirms it.
    if (!['COMPLETED', 'NO_SHOW'].includes(meeting?.properties?.hs_meeting_outcome)) properties.hs_meeting_outcome = 'SCHEDULED';
    if (!meeting?.properties?.hubspot_owner_id && event.ownerId) properties.hubspot_owner_id = event.ownerId;
    if (!meeting) {
      try { meeting = await this.request('/crm/v3/objects/meetings', { method: 'POST', body: { properties } }); }
      catch (error) { meeting = await this.uniqueMeeting(event.key); if (!meeting) throw error; }
    } else if (Object.entries(properties).some(([key, value]) => {
      if (['hs_timestamp', 'hs_meeting_start_time', 'hs_meeting_end_time'].includes(key)) return time(meeting.properties[key]) !== time(value);
      return (meeting.properties[key] || '') !== value;
    })) {
      await this.request(`/crm/v3/objects/meetings/${meeting.id}`, { method: 'PATCH', body: { properties } });
    }
    const sameMeeting = String(plan.meeting?.id) === String(meeting.id);
    const linked = sameMeeting && plan.existingDeals ? plan.existingDeals : await this.associations('meetings', meeting.id, 'deals');
    const linkedContacts = sameMeeting && plan.existingContacts ? plan.existingContacts : await this.associations('meetings', meeting.id, 'contacts');
    const ownedDeal = prior?.owned_deal_id || (!linked.includes(plan.dealId) ? plan.dealId : null);
    // Save identity before any associations so a partial failure is retryable.
    await client.query(`INSERT INTO google_calendar_deal_meetings(event_key,meeting_id,calendar_id,event_id,start_at,owned_deal_id,deal_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_key) DO UPDATE SET meeting_id=$2,calendar_id=$3,event_id=$4,start_at=$5,owned_deal_id=$6,deal_id=$7,active=true,updated_at=now()`,
    [event.key, String(meeting.id), event.calendarId, event.id, event.start.dateTime, ownedDeal, plan.dealId]);
    if (prior?.owned_deal_id && prior.owned_deal_id !== plan.dealId) {
      await this.request(`/crm/v4/objects/meetings/${meeting.id}/associations/deals/${prior.owned_deal_id}`, { method: 'DELETE' });
      await client.query('UPDATE google_calendar_deal_meetings SET owned_deal_id=$2 WHERE event_key=$1', [event.key, plan.dealId]);
    }
    for (const [target, ids] of [['contacts', plan.contacts], ['deals', [plan.dealId]]]) {
      const existing = target === 'contacts' ? linkedContacts : linked;
      for (const id of ids.filter(id => !existing.includes(id))) await this.request(`/crm/v4/objects/meetings/${meeting.id}/associations/default/${target}/${id}`, { method: 'PUT' });
    }
    return String(meeting.id);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    let client, locked = false;
    try {
      client = await this.pool.connect();
      locked = (await client.query("SELECT pg_try_advisory_lock(hashtextextended('google-calendar-deal-sync',0)) AS acquired")).rows[0].acquired;
      if (!locked) return;
      const snapshot = await this.snapshot();
      const stats = { calendars: snapshot.readable.size, unavailable: snapshot.unavailable, deals: snapshot.deals.length, synced: 0, cancelled: 0, ambiguous: 0, failed: 0 };
      const tracked = (await client.query('SELECT * FROM google_calendar_deal_meetings WHERE active=true')).rows;
      const blocked = new Set();
      for (const row of tracked) {
        if (!snapshot.meetings.some(m => String(m.id) === row.meeting_id)) {
          try {
            const meeting = await this.request(`/crm/v3/objects/meetings/${row.meeting_id}?properties=${MEETING_PROPERTIES.join(',')}`);
            if (meeting.archived) throw new Error('calendar_meeting_archived');
            snapshot.meetings.push(meeting);
          } catch (error) {
            blocked.add(row.event_key);
            stats.failed++;
            this.logger.error('Calendar tracked CRM meeting unavailable', { code: error.statusCode || error.code || error.name });
          }
        }
      }
      const prior = new Map(tracked.map(row => [row.event_key, row]));
      const process = async event => {
        if (blocked.has(event.key)) return;
        const plan = await this.plan(snapshot, event);
        if (plan.reason) {
          if (plan.reason.startsWith('ambiguous')) stats.ambiguous++;
          // A contact/deal disappearing from the open-deal index (for example,
          // a won deal) must not erase its historical meeting association.
          return;
        }
        await this.persist(client, { ...plan.copy, key: event.key, calendarId: plan.calendarId, id: plan.eventId, ownerId: plan.ownerId }, plan, prior.get(event.key));
        stats.synced++;
      };
      for (const event of snapshot.events.values()) {
        try { await process(event); } catch (error) { stats.failed++; this.logger.error('Calendar deal event sync failed', { code: error.statusCode || error.code || error.name }); }
      }
      for (const row of tracked) {
        if (blocked.has(row.event_key) || snapshot.events.has(row.event_key) || !snapshot.readable.has(row.calendar_id)) continue;
        const owner = snapshot.dealOwners.get(row.deal_id);
        // Reassigned, unassigned, or closed deals must never cause an event read
        // from the previous owner's calendar. A new owner's copy is required.
        if (!owner || owner.calendarId !== row.calendar_id) continue;
        // Check the specific occurrence: absence from the time window alone is
        // insufficient evidence of cancellation (it may have been rescheduled).
        try {
          let event;
          try { event = (await this.calendar.events.get({ calendarId: row.calendar_id, eventId: row.event_id }, { timeout: 20000 })).data; }
          catch (error) { if ([404, 410].includes(Number(error.code))) event = { status: 'cancelled' }; else throw error; }
          if (event.status === 'cancelled') {
            await this.request(`/crm/v3/objects/meetings/${row.meeting_id}`, { method: 'PATCH', body: { properties: { hs_meeting_outcome: 'CANCELED' } } });
            await client.query('UPDATE google_calendar_deal_meetings SET active=false WHERE event_key=$1', [row.event_key]);
            stats.cancelled++;
          } else if (event.start?.dateTime && time(event.start.dateTime) < snapshot.now) {
            await this.request(`/crm/v3/objects/meetings/${row.meeting_id}`, { method: 'PATCH', body: { properties: {
              hs_timestamp: event.start.dateTime, hs_meeting_start_time: event.start.dateTime, hs_meeting_end_time: event.end.dateTime,
            } } });
            await client.query('UPDATE google_calendar_deal_meetings SET active=false WHERE event_key=$1', [row.event_key]);
          } else if (eligible(event, snapshot.now, Infinity)) {
            await process({ ...event, key: row.event_key, calendarId: row.calendar_id, ids: new Set([event.id]), ownerId: owner.ownerId,
              calendarCopies: new Map([[owner.ownerId, { ...event, calendarId: row.calendar_id, ownerId: owner.ownerId }]]) });
          } else if (!event.attendeesOmitted && event.visibility !== 'private') {
            await this.retire(client, row);
          }
        } catch (error) { stats.failed++; this.logger.error('Calendar tracked meeting refresh failed', { code: error.statusCode || error.code || error.name }); }
      }
      this.logger.info('Google Calendar deal sync', stats);
      return stats;
    } finally {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('google-calendar-deal-sync',0))").catch(() => { client.release(true); client = null; });
      client?.release();
      this.running = false;
    }
  }

  async retire(client, row) {
    if (row.owned_deal_id) {
      await this.request(`/crm/v4/objects/meetings/${row.meeting_id}/associations/deals/${row.owned_deal_id}`, { method: 'DELETE' });
      await client.query('UPDATE google_calendar_deal_meetings SET active=false,owned_deal_id=NULL WHERE event_key=$1', [row.event_key]);
    }
  }

  start() {
    if (this.timer) return;
    const run = () => this.tick().catch(error => this.logger.error('Google Calendar deal sync failed', { code: error.statusCode || error.code || error.name }));
    run();
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}

module.exports = { GoogleCalendarDealSync, EVENT_KEY, occurrenceKey, externalAttendees, eligible, nativeIdentity, chooseDeal };
