const assert = require('node:assert/strict');
const { before, beforeEach, after, test } = require('node:test');
const { PGlite } = require('@electric-sql/pglite');
const { DemoSubmissionLifecycle, WINDOW_MS, CHANNEL_ID } = require('../demo-submission-lifecycle');
const { CONFIG } = require('../calendly_hubspot');
const { DemoNotificationStore, processEvent } = require('../hubspot_demo');

const submittedAt = Date.parse('2026-10-30T12:00:00Z');
const formEvent = { objectId: 123, propertyValue: String(submittedAt), occurredAt: submittedAt };
const hostUri = 'https://api.calendly.com/users/069e97c6-0691-4472-84f2-cad9c76b6e01';
const eventType = [...CONFIG.allowedEventTypeUris][0];
let db, pool, lifecycle, time, posts, updates, assignments, contactOwner, bookings, discoverCalls, failDiscovery, failPost;

function booking(seconds = 100, ownerId = '84547076', id = 'one') {
  return {
    payload: { uri: `https://api.calendly.com/scheduled_events/${id}/invitees/i`, email: 'nik@squadtalent.xyz', created_at: new Date(submittedAt + seconds * 1000).toISOString() },
    scheduledEvent: { uri: `https://api.calendly.com/scheduled_events/${id}`, name: 'Truewind Demo', status: 'active',
      start_time: '2026-11-04T15:00:00Z', end_time: '2026-11-04T15:30:00Z', event_type: eventType,
      event_memberships: [{ user: hostUri, user_name: 'Sarah Elix' }], location: { join_url: 'https://zoom.us/j/demo' } },
    filter: { ok: true, ownerId, hostUserUri: hostUri },
  };
}

before(async () => {
  time = submittedAt;
  db = new PGlite();
  const query = async (sql, params) => {
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] };
    if (/pg_advisory_unlock/.test(sql)) return { rows: [] };
    const result = await db.query(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  pool = { query, async connect() { return { query, release() {} }; } };
  lifecycle = new DemoSubmissionLifecycle({ pool, refreshOwners: async () => {}, env: { SLACK_BOT_TOKEN: 'test' }, now: () => time, randomInt: () => 1,
    logger: { error() {} },
    async hubspotRequest(path, options) {
      if (path.startsWith('/crm/v3/owners/')) return { id: path.split('/').pop(), archived: false };
      if (path.endsWith('/search')) return { results: [] };
      if (options?.method === 'PATCH') {
        contactOwner = options.body.properties.hubspot_owner_id;
        assignments.push(contactOwner);
        return {};
      }
      return { id: '123', properties: { email: 'nik@squadtalent.xyz', firstname: 'Nikhil', lastname: 'Goel',
        erp: 'QBO', jobtitle: 'Head of Operations', how_did_you_hear_about_us: 'Search engine (Google, Bing, etc.)',
        createdate: '2026-10-30T12:00:00Z', hubspot_owner_id: contactOwner } };
    },
    async calendlyRequest(url) {
      discoverCalls.push(url);
      if (failDiscovery) throw new Error('provider unavailable');
      if (url.endsWith('/users/me')) return { resource: { current_organization: 'https://api.calendly.com/organizations/org' } };
      if (url.includes('/scheduled_events?')) return { collection: bookings.map(b => b.scheduledEvent) };
      if (url.includes('/invitees?')) return { collection: bookings.filter(b => url.startsWith(b.scheduledEvent.uri + '/')).map(b => b.payload) };
      throw new Error('unexpected Calendly URL');
    },
    async fetchImpl(url, options) {
      assert.ok(['https://slack.com/api/chat.postMessage', 'https://slack.com/api/chat.update'].includes(url));
      const message = JSON.parse(options.body);
      if (url.endsWith('chat.update')) {
        updates.push(message);
        return Response.json({ ok: true, ts: message.ts, channel: CHANNEL_ID });
      }
      posts.push(message);
      if (failPost) throw new Error('connection reset after send');
      return Response.json({ ok: true, ts: `${posts.length}.001`, channel: CHANNEL_ID });
    },
  });
  await lifecycle.initialize();
});
beforeEach(async () => {
  await db.exec('TRUNCATE demo_submission_lifecycle, demo_submission_bookings');
  time = submittedAt;
  posts = []; updates = []; assignments = []; bookings = []; discoverCalls = [];
  contactOwner = '91143842'; failDiscovery = false; failPost = false;
  // The lookup behavior is tested independently below; avoid real requests in lifecycle tests.
  lifecycle.discoverBookings = async function (row) {
    discoverCalls.push(row.email);
    if (failDiscovery) throw new Error('provider unavailable');
    for (const b of bookings) if (Date.parse(b.payload.created_at) >= Number(row.submitted_at)) await this.saveBooking(b.payload, b.scheduledEvent, b.filter);
  };
});
after(async () => { await db.close(); });
const row = async () => (await pool.query('SELECT * FROM demo_submission_lifecycle')).rows[0];

test('five-minute deadline persists; random owner is assigned before parent and no-booking thread', async () => {
  await lifecycle.enqueue(formEvent);
  await lifecycle.tick();
  time += WINDOW_MS - 1;
  await lifecycle.tick();
  assert.equal(posts.length, 0);
  time++;
  await lifecycle.tick();
  assert.equal(contactOwner, '89305622');
  assert.deepEqual(assignments, ['89305622']);
  assert.equal(posts.length, 2);
  assert.ok(posts[0].text.startsWith('<@U0AKMHVCJMA>\nNew DEMO Submission\nNikhil Goel'));
  for (const field of ['ERP: QBO', 'Job Title: Head of Operations', 'How did you hear about us?', 'Finance team size:', 'Phone:', 'Date Created: 10/30/26']) assert.ok(posts[0].text.includes(field));
  assert.equal(posts[0].channel, CHANNEL_ID);
  assert.equal(posts[1].thread_ts, '1.001');
  assert.match(posts[1].text, /<@U0AKMHVCJMA>.*did NOT book/);
  await lifecycle.enqueue({ ...formEvent, occurredAt: time });
  time += WINDOW_MS;
  await lifecycle.tick();
  assert.equal(posts.length, 2);
  assert.equal(assignments.length, 1);
});

test('booking before five minutes assigns calendar host, tags host on parent, and has no unbooked reply', async () => {
  await lifecycle.enqueue(formEvent);
  const b = booking();
  bookings.push(b);
  time += 100000;
  await lifecycle.observeBooking('invitee.created', b.payload, b.scheduledEvent, b.filter);
  await lifecycle.tick();
  assert.equal(contactOwner, '84547076');
  assert.equal(posts.length, 1);
  assert.ok(posts[0].text.startsWith('<@U09QC3B292R>\nNew DEMO Submission'));
  assert.match(posts[0].text, /within five minutes/);
  assert.match(posts[0].text, /2026-11-04T15:00:00.000Z/);
  assert.equal((await row()).booked_state, 'sent');
});

test('late booking replies on original thread with meeting details and verified current owner', async () => {
  await lifecycle.enqueue(formEvent);
  time += WINDOW_MS;
  await lifecycle.tick();
  const b = booking(400);
  time = submittedAt + 400000;
  bookings.push(b);
  const observed = await lifecycle.observeBooking('invitee.created', b.payload, b.scheduledEvent, b.filter);
  await lifecycle.reconcileBooking(observed);
  await lifecycle.tick();
  assert.equal(posts.length, 3);
  assert.equal(posts[2].thread_ts, posts[1].thread_ts);
  assert.match(posts[2].text, /<@U0AKMHVCJMA>.*after the first five minutes/);
  assert.equal(contactOwner, '89305622');
  for (const detail of ['Truewind Demo', 'Sarah Elix', '2026-11-04T15:00:00.000Z', '2026-11-04T15:30:00.000Z', 'https://zoom.us/j/demo']) assert.ok(posts[2].text.includes(detail));
  await lifecycle.observeBooking('invitee.created', b.payload, b.scheduledEvent, b.filter);
  await lifecycle.tick();
  assert.equal(posts.length, 3);
});

test('booking exactly at five minutes is early and uses booking creation time, not meeting time', async () => {
  await lifecycle.enqueue(formEvent);
  bookings.push(booking(300));
  time += WINDOW_MS;
  await lifecycle.tick();
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /within five minutes/);
});

test('out-of-order booking before form webhook is correlated without a second parent', async () => {
  const b = booking();
  time += 120000;
  bookings.push(b);
  assert.equal(await lifecycle.observeBooking('invitee.created', b.payload, b.scheduledEvent, b.filter), null);
  await lifecycle.enqueue(formEvent);
  await lifecycle.tick();
  assert.equal(posts.length, 1);
  assert.equal(contactOwner, '84547076');
});

test('restart recovers queued deadline and delayed late webhook retains random assignment then sends booked reply', async () => {
  await lifecycle.enqueue(formEvent);
  time += 420000;
  bookings.push(booking(400));
  await lifecycle.initialize();
  await lifecycle.tick();
  assert.equal(posts.length, 3);
  assert.match(posts[0].text, /^<@U0AKMHVCJMA>/);
  assert.match(posts[1].text, /^<@U0AKMHVCJMA>.*did NOT book/);
  assert.match(posts[2].text, /^<@U0AKMHVCJMA>.*booked a meeting/);
  assert.equal(contactOwner, '89305622');
});

test('provider errors never become a false no-booking alert', async () => {
  await lifecycle.enqueue(formEvent);
  time += WINDOW_MS;
  failDiscovery = true;
  await lifecycle.tick();
  assert.equal(posts.length, 0);
  failDiscovery = false;
  time += 30000;
  await lifecycle.tick();
  assert.equal(posts.length, 2);
});

test('ambiguous parent delivery is quarantined and never resent after restart', async () => {
  await lifecycle.enqueue(formEvent);
  time += WINDOW_MS;
  failPost = true;
  await lifecycle.tick();
  assert.equal((await row()).parent_state, 'needs_review');
  failPost = false;
  time += WINDOW_MS;
  await lifecycle.initialize();
  await lifecycle.tick();
  assert.equal(posts.length, 1);
});

test('crash between Slack write and persistence is quarantined under the contact lock', async () => {
  await lifecycle.enqueue(formEvent);
  await pool.query("UPDATE demo_submission_lifecycle SET parent_state = 'sending'");
  time += WINDOW_MS;
  await lifecycle.tick();
  assert.equal((await row()).parent_state, 'needs_review');
  assert.equal(posts.length, 0);
});

test('unmapped booking owner fails closed before posting', async () => {
  await lifecycle.enqueue(formEvent);
  bookings.push(booking(100, '99999'));
  time += WINDOW_MS;
  await lifecycle.tick();
  assert.equal(posts.length, 0);
});

test('repeated forms before the first notification retain the original clock and one parent', async () => {
  await lifecycle.enqueue(formEvent);
  await lifecycle.enqueue({ ...formEvent, propertyValue: String(submittedAt + 60000) });
  const rows = (await pool.query('SELECT * FROM demo_submission_lifecycle')).rows;
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].submitted_at), submittedAt);
  time = submittedAt + WINDOW_MS;
  await lifecycle.tick();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].thread_ts, '1.001');
});

test('signed webhook processing queues rather than immediately posting when lifecycle is enabled', async () => {
  const legacyStore = new DemoNotificationStore(pool);
  await legacyStore.initialize();
  const result = await processEvent(formEvent, { store: legacyStore, demoLifecycle: lifecycle });
  assert.equal(result, 'queued');
  assert.equal(posts.length, 0);
});

test('Calendly lookup filters invitee email and creation time and follows pagination', async () => {
  delete lifecycle.discoverBookings;
  const b = booking();
  bookings.push(b);
  {
    await lifecycle.enqueue(formEvent);
    await lifecycle.discoverBookings(await row());
    const saved = (await pool.query('SELECT * FROM demo_submission_bookings')).rows;
    assert.equal(saved.length, 1);
    assert.ok(discoverCalls.some(url => url.includes('invitee_email=nik%40squadtalent.xyz')));
    assert.ok(discoverCalls.some(url => url.includes('/invitees?status=active')));
  }
});

test('Sarah is also an eligible random owner', async () => {
  const pick = lifecycle.randomInt;
  lifecycle.randomInt = () => 0;
  try {
    await lifecycle.enqueue(formEvent);
    time += WINDOW_MS;
    await lifecycle.tick();
    assert.equal(contactOwner, '84547076');
    assert.match(posts[0].text, /^<@U09QC3B292R>/);
    assert.match(posts[1].text, /^<@U09QC3B292R>/);
  } finally { lifecycle.randomInt = pick; }
});

test('booking webhook recovers the recent form from HubSpot before the form webhook arrives', async () => {
  const request = lifecycle.hubspotRequest;
  lifecycle.hubspotRequest = async (path, options) => path.endsWith('/search')
    ? { results: [{ id: '123', properties: { demo_form_submission_datetime: String(submittedAt), email: 'nik@squadtalent.xyz' } }] }
    : request(path, options);
  try {
    const b = booking();
    time += 100000;
    bookings.push(b);
    const observed = await lifecycle.observeBooking('invitee.created', b.payload, b.scheduledEvent, b.filter);
    assert.equal(observed.contactId, '123');
    await lifecycle.tick();
    assert.equal(posts.length, 1);
    assert.equal((await row()).booked_state, 'sent');
    await lifecycle.enqueue(formEvent);
    await lifecycle.tick();
    assert.equal(posts.length, 1);
  } finally { lifecycle.hubspotRequest = request; }
});

test('historical form properties do not claim unrelated standalone bookings', async () => {
  const request = lifecycle.hubspotRequest;
  lifecycle.hubspotRequest = async (path, options) => path.endsWith('/search')
    ? { results: [{ id: '123', properties: { demo_form_submission_datetime: String(submittedAt - 86400000) } }] }
    : request(path, options);
  try {
    const b = booking();
    assert.equal(await lifecycle.observeBooking('invitee.created', b.payload, b.scheduledEvent, b.filter), null);
    assert.equal(await row(), undefined);
  } finally { lifecycle.hubspotRequest = request; }
});

test('a delayed early booking corrects the existing thread rather than creating another parent', async () => {
  await lifecycle.enqueue(formEvent);
  time += WINDOW_MS;
  await lifecycle.tick();
  const b = booking(299);
  bookings.push(b);
  time += 60000;
  await lifecycle.observeBooking('invitee.created', b.payload, b.scheduledEvent, b.filter);
  await lifecycle.tick();
  assert.equal(posts.length, 3);
  assert.equal(posts[2].thread_ts, '1.001');
  assert.match(posts[2].text, /within the first five minutes \(booking confirmation arrived later\)/);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].ts, '1.001');
  assert.match(updates[0].text, /^<@U09QC3B292R>/);
  assert.match(updates[0].text, /within five minutes/);
});

test('definite Slack rejection retries without reassigning the random owner or repeating the parent', async () => {
  const send = lifecycle.fetchImpl;
  let reject = true;
  lifecycle.fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.thread_ts && reject) return Response.json({ ok: false, error: 'ratelimited' });
    return send(url, options);
  };
  try {
    await lifecycle.enqueue(formEvent);
    time += WINDOW_MS;
    await lifecycle.tick();
    assert.equal(posts.length, 1);
    assert.equal((await row()).no_booking_state, 'pending');
    reject = false;
    time += 30000;
    await lifecycle.tick();
    assert.equal(posts.length, 2);
    assert.equal(posts[1].thread_ts, '1.001');
    assert.deepEqual(assignments, ['89305622']);
  } finally { lifecycle.fetchImpl = send; }
});

test('cancellation before a delayed creation stays canceled and cannot produce a booked alert', async () => {
  await lifecycle.enqueue(formEvent);
  const b = booking();
  await lifecycle.observeBooking('invitee.canceled', b.payload, b.scheduledEvent, b.filter);
  await lifecycle.observeBooking('invitee.created', b.payload, b.scheduledEvent, b.filter);
  time += WINDOW_MS;
  await lifecycle.tick();
  assert.equal(posts.length, 2);
  assert.match(posts[1].text, /did NOT book/);
  assert.equal((await row()).booked_state, 'pending');
});

test('an older delayed form does not overwrite the owner assigned by a newer booked submission', async () => {
  const newerAt = submittedAt + 60000;
  await lifecycle.enqueue({ ...formEvent, propertyValue: String(newerAt) });
  const b = booking(120);
  bookings.push(b);
  time += 180000;
  await lifecycle.observeBooking('invitee.created', b.payload, b.scheduledEvent, b.filter);
  await lifecycle.tick();
  assert.equal(contactOwner, '84547076');
  assignments.length = 0;
  await lifecycle.enqueue(formEvent);
  time += WINDOW_MS;
  await lifecycle.tick();
  assert.equal(contactOwner, '84547076');
  assert.deepEqual(assignments, []);
});

test('API pagination is followed and rejects a non-Calendly continuation without fetching it', async () => {
  const request = lifecycle.calendlyRequest;
  const urls = [];
  lifecycle.calendlyRequest = async url => {
    urls.push(url);
    return url.endsWith('/first') ? { collection: [1], pagination: { next_page: 'https://api.calendly.com/second' } }
      : { collection: [2], pagination: { next_page: 'https://example.com/private' } };
  };
  try {
    await assert.rejects(lifecycle.apiCollection('https://api.calendly.com/first'), /invalid_calendly_pagination/);
    assert.deepEqual(urls, ['https://api.calendly.com/first', 'https://api.calendly.com/second']);
  } finally { lifecycle.calendlyRequest = request; }
});

test('managed submissions are protected from background owner reassignment even without the old deal router', async () => {
  const { protectContact } = require('../demo-routing-assignment');
  await lifecycle.enqueue(formEvent);
  assert.equal(await protectContact({ id: '123' }, null, { isContactManaged: id => lifecycle.hasContact(id) }), true);
  assert.equal(await protectContact({ id: '456' }, null, { isContactManaged: id => lifecycle.hasContact(id) }), false);
});

test('a busy contact lock skips work without blocking the shared pool or unlocking another worker', async () => {
  const original = lifecycle.pool;
  const calls = [];
  let released = false;
  lifecycle.pool = { async connect() { return {
    async query(sql) { calls.push(sql); return { rows: [{ locked: false }] }; },
    release() { released = true; },
  }; } };
  try {
    let ran = false;
    await lifecycle.withContactLock('123', async () => { ran = true; });
    assert.equal(ran, false);
    assert.equal(released, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /pg_try_advisory_lock/);
  } finally { lifecycle.pool = original; }
});

test('worker uses the held client for booking persistence, so it works with a one-client pool', async () => {
  await lifecycle.enqueue(formEvent);
  time += WINDOW_MS;
  const original = lifecycle.pool;
  let held = false;
  lifecycle.pool = {
    async query(...args) { assert.equal(held, false, 'cannot request another pool client while contact lock is held'); return original.query(...args); },
    async connect() {
      const client = await original.connect();
      held = true;
      return { query: client.query, release() { held = false; client.release(); } };
    },
  };
  bookings.push(booking(100));
  try {
    await lifecycle.processRow(`${formEvent.objectId}:${submittedAt}`);
    assert.equal(posts.length, 1);
    assert.equal(held, false);
  } finally { lifecycle.pool = original; }
});


test('re-entering the same email to book replies in the original thread instead of posting another parent', async () => {
  await lifecycle.enqueue(formEvent);
  time = submittedAt + WINDOW_MS;
  await lifecycle.tick();
  assert.equal(posts.length, 2);
  const repeatAt = submittedAt + 16 * 60000;
  time = repeatAt;
  await lifecycle.enqueue({ ...formEvent, propertyValue: String(repeatAt) });
  const b = booking(16 * 60 + 1);
  bookings.push(b);
  time += 1000;
  const observed = await lifecycle.observeBooking('invitee.created', b.payload, b.scheduledEvent, b.filter);
  await lifecycle.reconcileBooking(observed);
  await lifecycle.tick();
  assert.equal(posts.length, 3);
  assert.equal(posts[2].thread_ts, '1.001');
  assert.match(posts[2].text, /This lead booked a meeting\./);
  assert.match(posts[2].text, /Sarah Elix/);
  assert.equal(posts.filter(m => !m.thread_ts).length, 1);
  assert.equal(contactOwner, '89305622');
  const rows = (await pool.query('SELECT * FROM demo_submission_lifecycle ORDER BY submitted_at')).rows;
  assert.equal(rows[1].thread_root_key, rows[0].submission_key);
  assert.equal(rows[1].parent_ts, rows[0].parent_ts);
  assert.equal(rows[0].booked_state, 'sent');
  await lifecycle.enqueue({ ...formEvent, propertyValue: String(repeatAt) });
  await lifecycle.observeBooking('invitee.created', b.payload, b.scheduledEvent, b.filter);
  await lifecycle.tick();
  assert.equal(posts.length, 3);
});

test('booking-first delivery followed by repeat form webhook keeps one original thread', async () => {
  await lifecycle.enqueue(formEvent);
  time += WINDOW_MS;
  await lifecycle.tick();
  const b = booking(600);
  bookings.push(b);
  time = submittedAt + 600000;
  await lifecycle.observeBooking('invitee.created', b.payload, b.scheduledEvent, b.filter);
  await lifecycle.tick();
  assert.equal(posts.length, 3);
  await lifecycle.enqueue({ ...formEvent, propertyValue: String(time - 1000) });
  await lifecycle.tick();
  assert.equal(posts.filter(m => !m.thread_ts).length, 1);
  // The already-notified booking must not be repeated for a delayed form webhook.
  assert.equal(posts.length, 3);
});

test('a repeat form without a booking does not repeat the original unbooked alert', async () => {
  await lifecycle.enqueue(formEvent);
  time += WINDOW_MS;
  await lifecycle.tick();
  time += WINDOW_MS;
  await lifecycle.enqueue({ ...formEvent, propertyValue: String(time) });
  time += WINDOW_MS;
  await lifecycle.tick();
  assert.equal(posts.length, 2);
});

test('later bookings and delayed old form webhooks keep one thread without repeating an earlier booking', async () => {
  await lifecycle.enqueue(formEvent);
  const first = booking(100);
  bookings.push(first);
  time = submittedAt + 100000;
  await lifecycle.observeBooking('invitee.created', first.payload, first.scheduledEvent, first.filter);
  await lifecycle.tick();
  assert.equal(posts.length, 1);
  time = submittedAt + 600000;
  await lifecycle.enqueue({ ...formEvent, propertyValue: String(time) });
  const second = booking(601, '84547076', 'two');
  bookings.push(second);
  time += 1000;
  await lifecycle.observeBooking('invitee.created', second.payload, second.scheduledEvent, second.filter);
  await lifecycle.tick();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].thread_ts, '1.001');
  assert.equal((await row()).booking_uri, first.payload.uri);
  await lifecycle.enqueue({ ...formEvent, propertyValue: String(submittedAt + 99000) });
  await lifecycle.tick();
  assert.equal(posts.length, 2);
  assert.equal(posts.filter(m => !m.thread_ts).length, 1);
});
