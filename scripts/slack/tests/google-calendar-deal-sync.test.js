const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { GoogleCalendarDealSync, EVENT_KEY, occurrenceKey, eligible, externalAttendees, chooseDeal, nativeIdentity } = require('../google-calendar-deal-sync');
const NOW = Date.parse('2026-10-30T12:00:00Z');
const event = (extra = {}) => ({ id: 'gcal1', iCalUID: 'uid@example.com', summary: 'Intro to Truewind',
  start: { dateTime: '2026-11-01T15:00:00Z' }, end: { dateTime: '2026-11-01T15:30:00Z' },
  attendees: [{ email: 'buyer@example.com' }, { email: 'sarah@trytruewind.com' }],
  htmlLink: 'https://calendar.google.com/calendar/event?eid=abc', status: 'confirmed', ...extra });
const prepared = extra => { const e = event(extra); return { ...e, key: occurrenceKey(e), ids: new Set([e.id]), calendarId: 'sarah@trytruewind.com', ownerId: '42', calendarCopies: new Map([['42', { ...e, calendarId: 'sarah@trytruewind.com', ownerId: '42' }]]) }; };
function snapshot(events = [prepared()], meetings = []) {
  return { now: NOW, until: NOW + 365 * 86400000, events: new Map(events.map(e => [e.key, e])),
    readable: new Set(['sarah@trytruewind.com']), unavailable: [], deals: [{ id: '10' }], meetings, dealOwners: new Map([['10', { ownerId: '42', calendarId: 'sarah@trytruewind.com' }]]),
    emailContacts: new Map([['buyer@example.com', new Set(['1'])]]), contactDeals: new Map([['1', new Set(['10'])]]) };
}
function fixture({ meetings = [], lostCreate = false } = {}) {
  const calls = [], records = new Map(meetings.map(m => [String(m.id), structuredClone(m)])), links = new Map(), contacts = new Map();
  const request = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path.includes('/properties/meetings/')) return { type: 'string', hasUniqueValue: true };
    if (/\/associations\/(deals|contacts)\?/.test(path)) {
      const id = path.split('/')[5], target = path.includes('/deals?') ? links : contacts;
      return { results: (target.get(id) || []).map(toObjectId => ({ toObjectId })) };
    }
    if (path.includes('/associations/default/')) {
      const parts = path.split('/'), target = parts[8] === 'deals' ? links : contacts;
      target.set(parts[5], [...new Set([...(target.get(parts[5]) || []), parts[9]])]); return {};
    }
    if (options.method === 'DELETE') { links.set(path.split('/')[5], []); return {}; }
    if (path === '/crm/v3/objects/meetings' && options.method === 'POST') {
      assert.ok(![...records.values()].some(m => m.properties[EVENT_KEY] === options.body.properties[EVENT_KEY]));
      const m = { id: '100', properties: { ...options.body.properties } }; records.set('100', m);
      if (lostCreate) throw Error('response lost'); return structuredClone(m);
    }
    if (options.method === 'PATCH') { Object.assign(records.get(path.split('/').pop()).properties, options.body.properties); return {}; }
    if (path.startsWith('/crm/v3/objects/meetings/')) {
      const u = new URL('https://api.hubapi.com' + path), id = u.pathname.split('/').pop();
      const m = u.searchParams.has('idProperty') ? [...records.values()].find(m => m.properties[EVENT_KEY] === id) : records.get(id);
      if (!m) throw Object.assign(Error('missing'), { statusCode: 404 }); return structuredClone(m);
    }
    throw Error('Unexpected path ' + path);
  };
  const s = snapshot([prepared()], meetings);
  const sync = new GoogleCalendarDealSync({ request, now: () => NOW, env: {}, logger: { info() {}, error() {} },
    calendar: { events: { get: async () => ({ data: event({ status: 'cancelled' }) }) } } });
  sync.snapshot = async () => s;
  return { sync, s, calls, records, links, contacts };
}
async function database(t, sync) {
  const db = new PGlite();
  t.after(() => db.close());
  const client = { query: async (sql, args) => /pg_try_advisory_lock/.test(sql) ? { rows: [{ acquired: true }] }
    : /pg_advisory_unlock/.test(sql) ? { rows: [{}] } : db.query(sql, args), release() {} };
  sync.pool = { query: client.query, connect: async () => client };
  await sync.initialize();
  return db;
}

test('occurrence identity coalesces team copies and distinguishes recurring instances after reschedule', () => {
  const a = event({ originalStartTime: { dateTime: '2026-11-01T08:00:00-07:00' } });
  assert.equal(occurrenceKey(a), occurrenceKey({ ...a, id: 'other', start: { dateTime: '2026-11-02T15:00:00Z' }, originalStartTime: { dateTime: '2026-11-01T15:00:00Z' } }));
  assert.notEqual(occurrenceKey(a), occurrenceKey(event({ originalStartTime: { dateTime: '2026-11-08T15:00:00Z' } })));
});
test('only upcoming timed customer events with complete attendees qualify', () => {
  assert.ok(eligible(event(), NOW, Infinity));
  for (const extra of [{ status: 'cancelled' }, { visibility: 'private' }, { attendeesOmitted: true },
    { start: { date: '2026-11-01' } }, { eventType: 'outOfOffice' }, { attendees: [{ email: 'x@trytruewind.com' }] },
    { attendees: [{ email: 'buyer@example.com', responseStatus: 'declined' }] }, { start: { dateTime: '2026-01-01T00:00:00Z' } }]) assert.equal(eligible(event(extra), NOW, Infinity), false);
  assert.deepEqual(externalAttendees(event()), ['buyer@example.com']);
});
test('deal choice requires a unique contact match or one existing linked deal', () => {
  assert.equal(chooseDeal(['10', '20']), null);
  assert.equal(chooseDeal(['10', '20'], ['20']), '20');
  assert.equal(chooseDeal(['10', '20'], ['10', '20']), null);
});
test('native Google source ID and decoded calendar link are recognized', () => {
  const e = prepared();
  assert.ok(nativeIdentity({ properties: { hs_meeting_source_id: 'gcal1' } }, e));
  const eid = Buffer.from('gcal1 sarah@trytruewind.com').toString('base64url');
  assert.ok(nativeIdentity({ properties: { hs_meeting_external_url: `https://www.google.com/calendar/event?eid=${eid}` } }, e));
  assert.equal(nativeIdentity({ properties: { hs_meeting_source_id: 'different' } }, e), false);
});
test('creates one meeting, links contact/deal, and survives a lost create response and later ticks', async t => {
  const f = fixture({ lostCreate: true }); const db = await database(t, f.sync);
  assert.equal((await f.sync.tick()).synced, 1);
  assert.deepEqual(f.links.get('100'), ['10']); assert.deepEqual(f.contacts.get('100'), ['1']);
  assert.equal((await f.sync.tick()).synced, 1);
  assert.equal(f.calls.filter(c => c.path === '/crm/v3/objects/meetings' && c.method === 'POST').length, 1);
  assert.equal((await db.query('SELECT * FROM google_calendar_deal_meetings')).rows.length, 1);
  assert.ok(!f.calls.some(c => c.path.includes('/objects/deals/') && c.method === 'PATCH'));
});
test('reuses native Google meeting, preserves its owner, and supplies the missing deal association', async t => {
  const f = fixture({ meetings: [{ id: '50', properties: { hs_meeting_source_id: 'gcal1', hubspot_owner_id: '7' } }] });
  await database(t, f.sync); await f.sync.tick();
  assert.deepEqual(f.links.get('50'), ['10']); assert.equal(f.records.get('50').properties.hubspot_owner_id, '7');
  assert.ok(!f.calls.some(c => c.path === '/crm/v3/objects/meetings' && c.method === 'POST'));
});
test('reuses older Calendly meeting only with exact title/time and matching contact', async () => {
  const e = prepared(); const m = { id: '50', properties: { hs_meeting_title: e.summary, hs_meeting_start_time: e.start.dateTime, hs_meeting_end_time: e.end.dateTime, calendly_event_uuid: 'uuid' } };
  const f = fixture({ meetings: [m] }); f.contacts.set('50', ['1']);
  assert.equal((await f.sync.plan(f.s, e)).meeting.id, '50');
  f.contacts.set('50', ['2']); assert.equal((await f.sync.plan(f.s, e)).meeting, undefined);
});
test('ambiguous deals, duplicate meetings and conflicting existing associations are skipped', async () => {
  const f = fixture(); f.s.contactDeals.set('1', new Set(['10', '20'])); f.s.dealOwners.set('20', { ownerId: '42', calendarId: 'sarah@trytruewind.com' });
  assert.equal((await f.sync.plan(f.s, prepared())).reason, 'ambiguous_deal');
  f.s.contactDeals.set('1', new Set(['10']));
  f.s.meetings = [{ id: '50', properties: { hs_meeting_source_id: 'gcal1' } }]; f.links.set('50', ['20']);
  assert.equal((await f.sync.plan(f.s, prepared())).reason, 'ambiguous_existing_association');
  f.links.set('50', []); f.s.meetings.push({ id: '51', properties: { hs_meeting_source_id: 'gcal1' } });
  assert.equal((await f.sync.plan(f.s, prepared())).reason, 'ambiguous_meeting');
});
test('rescheduled events update existing record; cancellation advances the deal rollup without another meeting', async t => {
  const f = fixture(); const db = await database(t, f.sync); await f.sync.tick();
  const changed = prepared({ start: { dateTime: '2026-11-02T15:00:00Z' }, end: { dateTime: '2026-11-02T15:30:00Z' } });
  f.s.events.set(changed.key, changed); await f.sync.tick();
  assert.equal(f.records.get('100').properties.hs_meeting_start_time, changed.start.dateTime);
  f.s.events.clear(); assert.equal((await f.sync.tick()).cancelled, 1);
  assert.equal(f.records.get('100').properties.hs_meeting_outcome, 'CANCELED');
  assert.equal((await db.query('SELECT active FROM google_calendar_deal_meetings')).rows[0].active, false);
});
test('calendar access failure never marks an absent tracked meeting canceled', async t => {
  const f = fixture(); await database(t, f.sync); await f.sync.tick();
  f.s.events.clear(); f.s.readable.clear(); await f.sync.tick();
  assert.equal(f.records.get('100').properties.hs_meeting_outcome, 'SCHEDULED');
});
test('missing window event is fetched directly and a future reschedule outside the horizon is retained', async t => {
  const f = fixture(); await database(t, f.sync); await f.sync.tick(); f.s.events.clear();
  f.sync.calendar.events.get = async () => ({ data: event({ start: { dateTime: '2028-11-01T15:00:00Z' }, end: { dateTime: '2028-11-01T15:30:00Z' } }) });
  assert.equal((await f.sync.tick()).synced, 1);
  assert.equal(f.records.get('100').properties.hs_meeting_start_time, '2028-11-01T15:00:00Z');
});
test('removing the customer detaches only sync-owned deal links', async t => {
  const f = fixture(); await database(t, f.sync); await f.sync.tick(); f.s.events.clear();
  f.sync.calendar.events.get = async () => ({ data: event({ attendees: [] }) });
  await f.sync.tick(); assert.deepEqual(f.links.get('100'), []);
});
test('session lock prevents multiple workers from writing concurrently', async () => {
  const f = fixture(); let released = false;
  f.sync.pool = { connect: async () => ({ query: async () => ({ rows: [{ acquired: false }] }), release() { released = true; } }) };
  f.sync.snapshot = async () => { throw Error('must not run'); };
  await f.sync.tick(); assert.ok(released); assert.equal(f.calls.length, 0);
});

test('full snapshot pages calendars, coalesces organizer copies, reads contact aliases, and ignores partial calendars', async () => {
  const calls = [], a = event({ organizer: { email: 'sarah@trytruewind.com' } });
  const request = async (path, options = {}) => {
    if (path.startsWith('/crm/v3/owners?')) return { results: [{ id: '42', email: 'sarah@trytruewind.com' }, { id: '43', email: 'mercedes@trytruewind.com' }, { id: '44', email: 'gtm@trytruewind.com' }] };
    if (path === '/crm/v3/objects/deals/search') return { total: 3, results: ['42', '43', '44'].map((id, i) => ({ id: String(10 + i), properties: { hubspot_owner_id: id } })) };
    if (path === '/crm/v3/objects/meetings/search') return { total: 0, results: [] };
    if (path.startsWith('/crm/v4/associations/')) return { status: 'COMPLETE', results: options.body.inputs.map(({ id }) => ({ from: { id }, to: id === '10' ? [{ toObjectId: '1' }] : [] })) };
    if (path === '/crm/v3/objects/contacts/batch/read') return { results: [{ id: '1', properties: { email: 'primary@example.com', hs_additional_emails: 'buyer@example.com;alias@example.com' } }] };
    throw Error(path);
  };
  const calendar = { events: { list: async params => {
    calls.push(params);
    if (params.calendarId.startsWith('gtm')) {
      if (params.pageToken) throw Object.assign(Error('access denied'), { code: 403 });
      return { data: { accessRole: 'reader', items: [event({ id: 'partial', iCalUID: 'other' })], nextPageToken: 'bad' } };
    }
    if (params.calendarId.startsWith('sarah')) {
      if (!params.pageToken) return { data: { accessRole: 'reader', items: [], nextPageToken: 'second' } };
      return { data: { accessRole: 'reader', items: [a] } };
    }
    return { data: { accessRole: 'owner', items: [{ ...a, id: 'copy', summary: 'Stale copy', updated: '2026-10-30T12:00:00Z' }] } };
  } } };
  const sync = new GoogleCalendarDealSync({ request, calendar, now: () => NOW, env: {} });
  const s = await sync.snapshot();
  assert.equal(s.readable.size, 2); assert.equal(s.unavailable[0].status, 403);
  assert.equal(s.events.size, 1); assert.equal([...s.events.values()][0].summary, a.summary);
  assert.deepEqual([...s.events.values()][0].ids, new Set(['gcal1', 'copy']));
  assert.deepEqual([...s.emailContacts.get('alias@example.com')], ['1']);
  assert.ok(calls.some(p => p.pageToken === 'second'));
});
test('authoritative organizer removing attendees overrides a stale eligible invitee copy', async () => {
  const request = async (path, options = {}) => {
    if (path.startsWith('/crm/v3/owners?')) return { results: [{ id: '1', email: 'mercedes@trytruewind.com' }, { id: '2', email: 'sarah@trytruewind.com' }] };
    if (path === '/crm/v3/objects/deals/search') return { total: 2, results: [{ id: '10', properties: { hubspot_owner_id: '1' } }, { id: '11', properties: { hubspot_owner_id: '2' } }] };
    if (path.endsWith('/search')) return { total: 0, results: [] };
    if (path.startsWith('/crm/v4/associations/')) return { status: 'COMPLETE', results: options.body.inputs.map(({ id }) => ({ from: { id }, to: [] })) };
    throw Error(path);
  };
  const sync = new GoogleCalendarDealSync({ request, now: () => NOW, env: {}, calendar: { events: { list: async ({ calendarId }) => ({ data: {
    accessRole: 'reader', items: [event({ organizer: { email: 'sarah@trytruewind.com' }, ...(calendarId.startsWith('sarah') ? { attendees: [] } : {}) })],
  } }) } } });
  assert.equal((await sync.snapshot()).events.size, 0);
});
test('incomplete HubSpot contact batches fail safely before any matching', async () => {
  const sync = new GoogleCalendarDealSync({ request: async () => ({ results: [] }), env: {} });
  await assert.rejects(sync.contacts(['1']), /contacts_incomplete/);
});
test('association failure retries the saved meeting instead of creating a second one', async t => {
  const f = fixture(); const db = await database(t, f.sync), original = f.sync.request;
  let fail = true;
  f.sync.request = async (path, options) => {
    if (fail && path.includes('/associations/default/deals/')) { fail = false; throw Error('temporary error'); }
    return original(path, options);
  };
  assert.equal((await f.sync.tick()).failed, 1);
  assert.equal((await db.query('SELECT meeting_id FROM google_calendar_deal_meetings')).rows[0].meeting_id, '100');
  assert.equal((await f.sync.tick()).synced, 1);
  assert.deepEqual(f.links.get('100'), ['10']);
  assert.equal(f.calls.filter(c => c.path === '/crm/v3/objects/meetings' && c.method === 'POST').length, 1);
});
test('an existing manually linked deal is retained when the customer is removed', async t => {
  const f = fixture({ meetings: [{ id: '50', properties: { hs_meeting_source_id: 'gcal1' } }] }); f.links.set('50', ['10']);
  await database(t, f.sync); await f.sync.tick(); f.s.events.clear();
  f.sync.calendar.events.get = async () => ({ data: event({ attendees: [] }) });
  await f.sync.tick(); assert.deepEqual(f.links.get('50'), ['10']);
});
test('an unavailable old CRM meeting does not block unrelated deal updates or trigger recreation', async t => {
  const f = fixture(); const db = await database(t, f.sync);
  await db.query(`INSERT INTO google_calendar_deal_meetings(event_key,meeting_id,calendar_id,event_id,start_at) VALUES('missing-key','999','sarah@trytruewind.com','gone','2026-11-01T12:00:00Z')`);
  const stats = await f.sync.tick(); assert.equal(stats.failed, 1); assert.equal(stats.synced, 1);
  assert.deepEqual(f.links.get('100'), ['10']);
});
test('closing a deal preserves its previously synchronized meeting association', async t => {
  const f = fixture(); await database(t, f.sync); await f.sync.tick();
  f.s.contactDeals.clear(); f.s.deals = [];
  await f.sync.tick(); assert.deepEqual(f.links.get('100'), ['10']);
});

test('deal must match its own owner calendar; the same customer on another calendar cannot qualify', async () => {
  const f = fixture(), e = prepared();
  f.s.dealOwners.set('10', { ownerId: '43', calendarId: 'xavier@trytruewind.com' });
  assert.equal((await f.sync.plan(f.s, e)).reason, 'no_customer_deal');
  e.calendarCopies.set('43', { ...event(), id: 'xavier-copy', calendarId: 'xavier@trytruewind.com', ownerId: '43' });
  const p = await f.sync.plan(f.s, e);
  assert.equal(p.dealId, '10'); assert.equal(p.calendarId, 'xavier@trytruewind.com'); assert.equal(p.eventId, 'xavier-copy');
});
test('same-contact deals owned by different people are resolved using the calendar owner', async () => {
  const f = fixture(); f.s.contactDeals.set('1', new Set(['10', '20']));
  f.s.dealOwners.set('20', { ownerId: '43', calendarId: 'xavier@trytruewind.com' });
  assert.equal((await f.sync.plan(f.s, prepared())).dealId, '10');
});
test('after reassignment the old owner calendar is never fetched for a tracked deal', async t => {
  const f = fixture(); await database(t, f.sync); await f.sync.tick(); f.s.events.clear();
  f.s.dealOwners.set('10', { ownerId: '43', calendarId: 'xavier@trytruewind.com' });
  let fetched = false; f.sync.calendar.events.get = async () => { fetched = true; throw Error('must not fetch old owner'); };
  await f.sync.tick(); assert.equal(fetched, false); assert.deepEqual(f.links.get('100'), ['10']);
});
test('new-owner copy updates tracked identity and supplies dates from that owners calendar', async t => {
  const f = fixture(); const db = await database(t, f.sync); await f.sync.tick();
  const e = prepared();
  e.calendarCopies.set('43', { ...event({ start: { dateTime: '2026-11-03T15:00:00Z' }, end: { dateTime: '2026-11-03T15:30:00Z' } }), id: 'xavier-copy', calendarId: 'xavier@trytruewind.com', ownerId: '43' });
  f.s.events.set(e.key, e); f.s.dealOwners.set('10', { ownerId: '43', calendarId: 'xavier@trytruewind.com' });
  assert.equal((await f.sync.tick()).synced, 1);
  const row = (await db.query('SELECT * FROM google_calendar_deal_meetings')).rows[0];
  assert.equal(row.calendar_id, 'xavier@trytruewind.com'); assert.equal(row.event_id, 'xavier-copy'); assert.equal(row.deal_id, '10');
  assert.equal(f.records.get('100').properties.hs_meeting_start_time, '2026-11-03T15:00:00Z');
  assert.equal(f.records.size, 1);
});
test('only owners of open deals are polled; other owners and extra-calendar settings cannot broaden scope', async () => {
  const polled = [];
  const request = async (path, options = {}) => {
    if (path.includes('/owners?')) return { results: [{ id: '42', email: 'sarah@trytruewind.com' }, { id: '43', email: 'xavier@trytruewind.com' }, { id: '44', email: 'other@trytruewind.com' }] };
    if (path === '/crm/v3/objects/deals/search') return { total: 2, results: [{ id: '10', properties: { hubspot_owner_id: '43' } }, { id: '11', properties: {} }] };
    if (path === '/crm/v3/objects/meetings/search') return { total: 0, results: [] };
    if (path.startsWith('/crm/v4/associations/')) return { status: 'COMPLETE', results: options.body.inputs.map(({ id }) => ({ from: { id }, to: [] })) };
    throw Error(path);
  };
  const sync = new GoogleCalendarDealSync({ request, now: () => NOW, env: { GOOGLE_CALENDAR_DEAL_SYNC_CALENDARS: 'other@trytruewind.com' }, calendar: { events: {
    list: async ({ calendarId }) => { polled.push(calendarId); return { data: { accessRole: 'reader', items: [] } }; },
  } } });
  const s = await sync.snapshot(); assert.deepEqual(polled, ['xavier@trytruewind.com']); assert.equal(s.dealOwners.has('11'), false);
});
test('batch association reads handle known empty rows and finish per-record pagination', async () => {
  const calls = [];
  const sync = new GoogleCalendarDealSync({ env: {}, request: async (path, options) => {
    calls.push(path);
    if (options?.method === 'POST') return { status: 'COMPLETE', results: [{ from: { id: '10' }, to: [{ toObjectId: '1' }], paging: { next: { after: 'next' } } }],
      errors: [{ subCategory: 'crm.associations.NO_ASSOCIATIONS_FOUND', context: { fromObjectId: ['11'] } }] };
    assert.ok(path.endsWith('&after=next')); return { results: [{ toObjectId: '2' }] };
  } });
  const index = await sync.associationIndex('deals', ['10', '11'], 'contacts');
  assert.deepEqual(index.get('10'), ['1', '2']); assert.deepEqual(index.get('11'), []); assert.equal(calls.length, 2);
});
test('incomplete association batches or unexpected errors never produce a partial deal index', async () => {
  const sync = new GoogleCalendarDealSync({ env: {}, request: async () => ({ status: 'COMPLETE', results: [] }) });
  await assert.rejects(sync.associationIndex('deals', ['10'], 'contacts'), /batch_incomplete/);
  sync.request = async () => ({ status: 'COMPLETE', results: [], errors: [{ subCategory: 'permission_denied' }] });
  await assert.rejects(sync.associationIndex('deals', ['10'], 'contacts'), /batch_error/);
});
test('already linked meetings avoid repeated association writes on the one-minute poll', async t => {
  const e = prepared(), f = fixture({ meetings: [{ id: '50', properties: { hs_meeting_source_id: 'gcal1' } }] });
  f.links.set('50', ['10']); f.contacts.set('50', ['1']);
  f.s.meetingDeals = new Map([['50', ['10']]]); f.s.meetingContacts = new Map([['50', ['1']]]);
  await database(t, f.sync); await f.sync.tick();
  assert.ok(!f.calls.some(c => c.method === 'PUT')); assert.equal(f.sync.intervalMs, 60000);
});
test('enabled recent-date sync handles past events without creating historical meeting activities', async t => {
  const { LastMeetingDates, LAST_MEETING_DATE } = require('../google-calendar-last-meeting');
  const f = fixture(); await database(t, f.sync);
  const original = f.sync.request, dates = [];
  f.sync.request = async (path, options = {}) => {
    if (path.startsWith('/crm/v3/objects/deals/10?')) return { id: '10', properties: { hubspot_owner_id: '42' } };
    if (path === '/crm/v3/objects/deals/10' && options.method === 'PATCH') { dates.push(options.body.properties); return {}; }
    return original(path, options);
  };
  f.sync.lastMeetings = new LastMeetingDates({ sync: f.sync }); f.s.from = NOW - 86400000;
  f.s.deals = [{ id: '10', properties: { hubspot_owner_id: '42' } }];
  const past = prepared({ start: { dateTime: '2026-10-30T10:00:00Z' }, end: { dateTime: '2026-10-30T10:30:00Z' } });
  f.s.events = new Map([[past.key, past]]);
  const stats = await f.sync.tick();
  assert.equal(stats.synced, 0); assert.equal(stats.lastMeetingDates.updated, 1); assert.equal(f.records.size, 0);
  assert.equal(dates[0][LAST_MEETING_DATE], '2026-10-30T10:00:00.000Z');
});
test('a custom-date failure cannot abort upcoming meeting synchronization', async t => {
  const f = fixture(); await database(t, f.sync);
  f.sync.lastMeetings = { update: async () => { throw Error('history unavailable'); } };
  const stats = await f.sync.tick(); assert.equal(stats.synced, 1); assert.equal(stats.failed, 1);
  assert.deepEqual(f.links.get('100'), ['10']);
});
test('a future meeting moved into the recent past still updates its existing activity and leaves the upcoming rollup', async t => {
  const f = fixture(); const db = await database(t, f.sync); await f.sync.tick();
  const past = prepared({ start: { dateTime: '2026-10-30T10:00:00Z' }, end: { dateTime: '2026-10-30T10:30:00Z' } });
  f.s.from = NOW - 86400000; f.s.events.set(past.key, past);
  f.sync.calendar.events.get = async () => ({ data: past });
  await f.sync.tick();
  assert.equal(f.records.get('100').properties.hs_meeting_start_time, past.start.dateTime);
  assert.equal((await db.query('SELECT active FROM google_calendar_deal_meetings')).rows[0].active, false);
  assert.equal(f.records.size, 1);
});
