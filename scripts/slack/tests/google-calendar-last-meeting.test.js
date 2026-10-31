const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GoogleCalendarDealSync, occurrenceKey } = require('../google-calendar-deal-sync');
const { LastMeetingDates, LAST_MEETING_DATE } = require('../google-calendar-last-meeting');
const NOW = Date.parse('2026-10-30T12:00:00Z');
function past(id, start = '2026-10-29T15:00:00Z', extra = {}) {
  const raw = { id, iCalUID: id + '@example.com', summary: 'Customer meeting', status: 'confirmed',
    start: { dateTime: start }, end: { dateTime: new Date(Date.parse(start) + 1800000).toISOString() },
    attendees: [{ email: 'buyer@example.com' }], ...extra };
  return { ...raw, key: occurrenceKey(raw), calendarId: 'xavier@trytruewind.com', ownerId: '43', ids: new Set([id]),
    calendarCopies: new Map([['43', { ...raw, calendarId: 'xavier@trytruewind.com', ownerId: '43' }]]) };
}
function fixture({ events = [past('one')], current = '', outcome, owner = '43' } = {}) {
  const calls = [], records = new Map([['10', { id: '10', properties: { hubspot_owner_id: owner, [LAST_MEETING_DATE]: current } }]]);
  const request = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path.includes('/properties/deals/')) return { name: LAST_MEETING_DATE, type: 'datetime', modificationMetadata: { readOnlyValue: false } };
    if (path.startsWith('/crm/v3/objects/deals/')) {
      const id = path.split('/').pop().split('?')[0], row = records.get(id);
      if (options.method === 'PATCH') { Object.assign(row.properties, options.body.properties); return structuredClone(row); }
      return structuredClone(row);
    }
    if (path.includes('/associations/')) return { results: [] };
    throw Error(path);
  };
  const sync = new GoogleCalendarDealSync({ request, pool: {}, calendar: {}, now: () => NOW,
    env: { GOOGLE_CALENDAR_LAST_MEETING_ENABLED: 'true' }, logger: { info() {}, error() {} } });
  const snapshot = { now: NOW, from: -Infinity, until: NOW, events: new Map(events.map(e => [e.key, e])),
    deals: [...records.values()].map(row => structuredClone(row)), dealOwners: new Map([['10', { ownerId: '43', calendarId: 'xavier@trytruewind.com' }]]),
    readable: new Set(['xavier@trytruewind.com']), emailContacts: new Map([['buyer@example.com', new Set(['1'])]]),
    contactDeals: new Map([['1', new Set(['10'])]]), meetings: [], meetingDeals: new Map(), meetingContacts: new Map() };
  if (outcome) {
    snapshot.meetings = [{ id: '90', properties: { hs_meeting_source_id: events[0].id, hs_meeting_outcome: outcome } }];
    snapshot.meetingDeals.set('90', ['10']);
  }
  return { sync, service: sync.lastMeetings, snapshot, records, calls };
}

test('validates the custom datetime property and rejects a read-only field', async () => {
  const f = fixture(); await f.service.initialize();
  f.sync.request = async () => ({ name: LAST_MEETING_DATE, type: 'datetime', modificationMetadata: { readOnlyValue: true } });
  await assert.rejects(f.service.initialize(), /writable_property_required/);
});
test('stores the latest finished meeting start and never a future or in-progress meeting', async () => {
  const f = fixture({ events: [past('older', '2026-10-01T15:00:00Z'), past('latest'), past('future', '2026-11-01T12:00:00Z'), past('running', '2026-10-30T11:50:00Z')] });
  assert.equal((await f.service.update(f.snapshot, true)).updated, 1);
  assert.equal(f.records.get('10').properties[LAST_MEETING_DATE], '2026-10-29T15:00:00.000Z');
  const writes = f.calls.filter(c => c.method === 'PATCH');
  assert.deepEqual(Object.keys(writes[0].body.properties), [LAST_MEETING_DATE]);
});
test('recorded no-shows, canceled and rescheduled HubSpot activities are excluded', async () => {
  for (const outcome of ['NO_SHOW', 'CANCELED', 'RESCHEDULED']) {
    const f = fixture({ outcome }); await f.service.update(f.snapshot, true);
    assert.equal(f.records.get('10').properties[LAST_MEETING_DATE], '');
  }
  const f = fixture({ outcome: 'COMPLETED' }); assert.equal((await f.service.update(f.snapshot, true)).updated, 1);
});
test('latest date comes from the selected deal owners calendar copy', async () => {
  const e = past('shared');
  e.calendarCopies.get('43').start.dateTime = '2026-10-28T15:00:00Z';
  e.calendarCopies.get('43').end.dateTime = '2026-10-28T15:30:00Z';
  const f = fixture({ events: [e] }); await f.service.update(f.snapshot, true);
  assert.equal(f.records.get('10').properties[LAST_MEETING_DATE], '2026-10-28T15:00:00.000Z');
});
test('an event on a different owner calendar cannot populate the field', async () => {
  const f = fixture(); f.snapshot.dealOwners.set('10', { ownerId: '42', calendarId: 'sarah@trytruewind.com' }); f.snapshot.readable.add('sarah@trytruewind.com');
  assert.equal((await f.service.update(f.snapshot, true)).updated, 0);
});
test('full history corrects a canceled/deleted latest date to the previous meeting or clears it', async () => {
  const f = fixture({ current: '2026-10-30T01:00:00Z' }); await f.service.update(f.snapshot, true);
  assert.equal(f.records.get('10').properties[LAST_MEETING_DATE], '2026-10-29T15:00:00.000Z');
  f.snapshot.deals = [...f.records.values()].map(row => structuredClone(row)); f.snapshot.events.clear();
  assert.equal((await f.service.update(f.snapshot, true)).cleared, 1);
});
test('recent scan advances the date but cannot clear or move it backward', async () => {
  const f = fixture({ current: '2026-10-30T01:00:00Z' });
  assert.equal((await f.service.update(f.snapshot, false)).updated, 0);
  f.snapshot.events.clear(); assert.equal((await f.service.update(f.snapshot, false)).cleared, 0);
  const g = fixture({ current: '2026-09-01T00:00:00Z' }); assert.equal((await g.service.update(g.snapshot, false)).updated, 1);
});
test('calendar access failure preserves a previously populated date', async () => {
  const f = fixture({ current: '2026-10-01T00:00:00Z', events: [] }); f.snapshot.readable.clear();
  const stats = await f.service.update(f.snapshot, true); assert.equal(stats.unavailable, 1);
  assert.equal(f.records.get('10').properties[LAST_MEETING_DATE], '2026-10-01T00:00:00Z');
});
test('a more recent ambiguous event prevents writing an older misleading date', async () => {
  const f = fixture({ events: [past('ambiguous'), past('older', '2026-10-01T15:00:00Z')] });
  const original = f.sync.plan.bind(f.sync);
  f.sync.plan = (s, e) => e.id === 'ambiguous' ? { reason: 'ambiguous_deal', candidates: ['10'] } : original(s, e);
  const stats = await f.service.update(f.snapshot, true); assert.equal(stats.ambiguous, 1); assert.equal(stats.updated, 0);
});
test('older ambiguity does not block a newer unambiguous finished meeting', async () => {
  const f = fixture({ events: [past('latest'), past('ambiguous', '2026-10-01T15:00:00Z')] });
  const original = f.sync.plan.bind(f.sync);
  f.sync.plan = (s, e) => e.id === 'ambiguous' ? { reason: 'ambiguous_deal', candidates: ['10'] } : original(s, e);
  assert.equal((await f.service.update(f.snapshot, true)).updated, 1);
});
test('fresh owner/date checks prevent stale scans from overwriting reassignment or concurrent updates', async () => {
  for (const change of [{ hubspot_owner_id: '42' }, { [LAST_MEETING_DATE]: '2026-10-30T01:00:00Z' }]) {
    const f = fixture(); Object.assign(f.records.get('10').properties, change);
    const stats = await f.service.update(f.snapshot, true); assert.equal(stats.stale, 1);
    assert.ok(!f.calls.some(c => c.method === 'PATCH'));
  }
});
test('unchanged dates avoid writes; one failed deal does not abort the job', async () => {
  const f = fixture({ current: '2026-10-29T15:00:00Z' }); await f.service.update(f.snapshot, true);
  assert.ok(!f.calls.some(c => c.method === 'PATCH'));
  const g = fixture(), original = g.sync.request;
  g.sync.request = (p, o) => o?.method === 'PATCH' ? Promise.reject(Object.assign(Error('temporary'), { statusCode: 503 })) : original(p, o);
  assert.equal((await g.service.update(g.snapshot, true)).failed, 1);
});
test('historical job has its own lock and requests the full past snapshot', async () => {
  const f = fixture(); let released = false, requested;
  f.sync.pool = { connect: async () => ({ query: async sql => { assert.ok(sql.includes('google-calendar-last-meeting')); return { rows: [{ acquired: true }] }; }, release() { released = true; } }) };
  f.sync.snapshot = async options => { requested = options; return f.snapshot; };
  assert.equal((await f.service.tick()).updated, 1); assert.deepEqual(requested, { history: true }); assert.ok(released);
});
test('another historical worker holding the lock suppresses the duplicate run', async () => {
  const f = fixture(); f.sync.pool = { connect: async () => ({ query: async () => ({ rows: [{ acquired: false }] }), release() {} }) };
  f.sync.snapshot = async () => { throw Error('must not run'); }; await f.service.tick(); assert.equal(f.calls.length, 0);
});

test('snapshot uses unrestricted past history and recent polling only adds one past day', async () => {
  const f = fixture(); const calls = [];
  f.sync.calendar.events = { list: async params => { calls.push(params); return { data: { accessRole: 'reader', items: [] } }; } };
  f.sync.search = async type => type === 'deals' ? [{ id: '10', properties: { hubspot_owner_id: '43' } }] : [];
  f.sync.pages = async path => path.includes('/owners?') ? [{ id: '43', email: 'xavier@trytruewind.com' }] : [];
  f.sync.associationIndex = async (type, ids) => new Map(ids.map(id => [id, []]));
  const history = await f.sync.snapshot({ history: true }); assert.equal(calls[0].timeMin, undefined); assert.equal(history.until, NOW);
  await f.sync.snapshot(); assert.equal(calls[1].timeMin, new Date(NOW - 86400000).toISOString());
});
test('a deal closed during the scan is not updated', async () => {
  const f = fixture(); f.records.get('10').properties.hs_is_closed = 'true';
  assert.equal((await f.service.update(f.snapshot, true)).stale, 1);
  assert.ok(!f.calls.some(c => c.method === 'PATCH'));
});
test('historical meeting listing includes old records without using capped meeting search', async () => {
  const f = fixture(), listed = [];
  f.sync.calendar.events = { list: async () => ({ data: { accessRole: 'reader', items: [] } }) };
  f.sync.search = async type => {
    assert.equal(type, 'deals', 'historical meetings must use listing instead of search');
    return [{ id: '10', properties: { hubspot_owner_id: '43' } }];
  };
  f.sync.pages = async path => {
    if (path.includes('/owners?')) return [{ id: '43', email: 'xavier@trytruewind.com' }];
    listed.push(path);
    return [{ id: '1', properties: { hs_meeting_start_time: '2020-01-01T12:00:00Z' } },
      { id: '2', properties: { hs_meeting_start_time: '2027-01-01T12:00:00Z' } }, { id: '3', properties: {} }];
  };
  f.sync.associationIndex = async (type, ids) => new Map(ids.map(id => [id, []]));
  const s = await f.sync.snapshot({ history: true }); assert.deepEqual(s.meetings.map(m => m.id), ['1']);
  assert.ok(listed[0].startsWith('/crm/v3/objects/meetings?limit=100&properties='));
});
