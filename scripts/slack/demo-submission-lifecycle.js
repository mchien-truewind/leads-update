const crypto = require('crypto');
const { buildMessage } = require('./hubspot_demo');
const { getOwnerSlackMap } = require('./slack-owner-map');
const { CONFIG, ensureCalendlyOwnerMap, shouldProcessScheduledEvent, getOrganizerName } = require('./calendly_hubspot');

const WINDOW_MS = 5 * 60 * 1000;
const CHANNEL_ID = 'C066P0YFF6Z';
const RANDOM_OWNER_IDS = ['84547076', '89305622']; // Sarah Elix, Xavier Marco
const PROPERTIES = ['firstname', 'lastname', 'email', 'erp', 'jobtitle', 'how_did_you_hear_about_us', 'finance_team_size', 'phone', 'createdate', 'hubspot_owner_id'];
const ms = value => /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const escape = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class DemoSubmissionLifecycle {
  constructor({ pool, hubspotRequest, calendlyRequest, fetchImpl = fetch, env = process.env, logger = console, now = Date.now, randomInt = crypto.randomInt, refreshOwners = ensureCalendlyOwnerMap }) {
    Object.assign(this, { pool, hubspotRequest, calendlyRequest, fetchImpl, env, logger, now, randomInt, refreshOwners });
    this.ownerSlackMap = getOwnerSlackMap(env);
  }

  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS demo_submission_activation (
      id INTEGER PRIMARY KEY CHECK (id = 1), activated_at BIGINT NOT NULL
    )`);
    await this.pool.query('INSERT INTO demo_submission_activation (id, activated_at) VALUES (1,$1) ON CONFLICT DO NOTHING', [this.now()]);
    this.activatedAt = Number((await this.pool.query('SELECT activated_at FROM demo_submission_activation WHERE id = 1')).rows[0].activated_at);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS demo_submission_lifecycle (
      submission_key TEXT PRIMARY KEY, contact_id TEXT NOT NULL, submitted_at BIGINT NOT NULL,
      email TEXT NOT NULL, assigned_owner TEXT, parent_ts TEXT, thread_root_key TEXT,
      parent_state TEXT NOT NULL DEFAULT 'pending', parent_update_state TEXT NOT NULL DEFAULT 'pending', no_booking_state TEXT NOT NULL DEFAULT 'pending',
      booked_state TEXT NOT NULL DEFAULT 'pending', booking_uri TEXT,
      next_check BIGINT NOT NULL, last_error TEXT,
      UNIQUE(contact_id, submitted_at)
    )`);
    await this.pool.query("ALTER TABLE demo_submission_lifecycle ADD COLUMN IF NOT EXISTS thread_root_key TEXT");
    await this.pool.query("ALTER TABLE demo_submission_lifecycle ADD COLUMN IF NOT EXISTS parent_update_state TEXT NOT NULL DEFAULT 'pending'");
    await this.pool.query(`CREATE INDEX IF NOT EXISTS demo_submission_due ON demo_submission_lifecycle(next_check)
      WHERE booked_state = 'pending' AND parent_state != 'needs_review'`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS demo_submission_bookings (
      invitee_uri TEXT PRIMARY KEY, email TEXT NOT NULL, booked_at BIGINT NOT NULL,
      owner_id TEXT NOT NULL, details JSONB NOT NULL, canceled BOOLEAN NOT NULL DEFAULT false
    )`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS demo_submission_booking_email ON demo_submission_bookings(email, booked_at)');
  }

  async enqueue(event) {
    const submittedAt = ms(event.propertyValue);
    if (!Number.isFinite(submittedAt)) throw new Error('invalid_submission_time');
    const contact = await this.hubspotRequest(`/crm/v3/objects/contacts/${event.objectId}?properties=email`);
    const email = normalizeEmail(contact.properties?.email);
    if (!email || String(contact.id) !== String(event.objectId)) throw new Error('submission_contact_unavailable');
    // Serialize by normalized email, including Calendly-first delivery on a held DB client.
    const client = typeof this.pool.release === 'function' ? this.pool : await this.pool.connect();
    const borrowed = client !== this.pool;
    try {
      await client.query('BEGIN');
      const locked = (await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked', [`demo-email:${email}`])).rows[0]?.locked;
      if (!locked) throw new Error('submission_email_busy');
      const existing = (await client.query(`SELECT * FROM demo_submission_lifecycle WHERE email = $1
        AND thread_root_key IS NULL ORDER BY submitted_at, submission_key LIMIT 1`, [email])).rows[0];
      const key = `${event.objectId}:${submittedAt}`;
      let targetKey = key;
      if (existing && !existing.parent_ts && existing.booked_state === 'pending') {
        // Re-entering the form before the first notification must not restart its clock.
        targetKey = existing.submission_key;
      } else {
        await client.query(`INSERT INTO demo_submission_lifecycle
          (submission_key, contact_id, submitted_at, email, next_check, thread_root_key, assigned_owner)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (contact_id, submitted_at) DO NOTHING`,
        [key, String(event.objectId), submittedAt, email, submittedAt + WINDOW_MS,
          existing && existing.submission_key !== key ? existing.submission_key : null, existing?.assigned_owner || null]);
      }
      await client.query(`UPDATE demo_submission_lifecycle SET next_check = $2 WHERE submission_key = $1
        AND EXISTS (SELECT 1 FROM demo_submission_bookings b WHERE b.email = demo_submission_lifecycle.email
          AND b.booked_at >= submitted_at AND b.canceled = false)`, [targetKey, this.now()]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { if (borrowed) client.release(); }
    return 'queued';
  }

  async withContactLock(contactId, operation) {
    const client = await this.pool.connect();
    const key = `demo-submission:${contactId}`;
    let locked = false;
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [key])).rows[0]?.locked === true;
      if (!locked) return null;
      return await operation(client);
    } finally {
      try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]); }
      finally { client.release(); }
    }
  }

  async saveBooking(payload, scheduledEvent, filter) {
    const event = scheduledEvent.resource || scheduledEvent;
    const bookedAt = ms(payload.created_at);
    const email = normalizeEmail(payload.email);
    if (!email || !Number.isFinite(bookedAt) || !payload.uri || !filter.ok || !filter.ownerId) return null;
    if (!Number.isFinite(Date.parse(event.start_time)) || !Number.isFinite(Date.parse(event.end_time))) throw new Error('booking_meeting_times_unavailable');
    const details = {
      name: event.name || 'Calendly meeting', start: event.start_time, end: event.end_time,
      host: getOrganizerName(filter.hostUserUri, scheduledEvent),
      location: event.location?.join_url || event.location?.location || event.location?.type || '',
    };
    await this.pool.query(`INSERT INTO demo_submission_bookings (invitee_uri,email,booked_at,owner_id,details)
      VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (invitee_uri) DO UPDATE SET details = EXCLUDED.details, owner_id = EXCLUDED.owner_id`,
    [payload.uri, email, bookedAt, String(filter.ownerId), JSON.stringify(details)]);
    await this.pool.query(`UPDATE demo_submission_lifecycle SET next_check = $2
      WHERE email = $1 AND submitted_at <= $3 AND booked_state = 'pending'`, [email, this.now(), bookedAt]);
    return { email, bookedAt, ownerId: String(filter.ownerId), uri: payload.uri };
  }

  async observeBooking(eventName, payload, scheduledEvent, filter) {
    if (eventName === 'invitee.canceled' || (scheduledEvent.resource || scheduledEvent).status === 'canceled') {
      await this.saveBooking(payload, scheduledEvent, filter);
      await this.pool.query('UPDATE demo_submission_bookings SET canceled = true WHERE invitee_uri = $1', [payload.uri]);
      return null;
    }
    if (eventName !== 'invitee.created') return null;
    const booking = await this.saveBooking(payload, scheduledEvent, filter);
    if (!booking) return null;
    const linked = await this.findBookingSubmission(booking);
    if (linked) {
      if (linked.bookedState === 'sent' && linked.bookingUri !== booking.uri) {
        const delivered = (await this.pool.query(`SELECT 1 FROM demo_submission_lifecycle
          WHERE email = $1 AND booking_uri = $2 AND booked_state = 'sent' LIMIT 1`, [booking.email, booking.uri])).rows.length;
        if (!delivered) {
          // A second Calendly booking can arrive without another HubSpot form event.
          await this.enqueue({ objectId: linked.contactId, propertyValue: String(booking.bookedAt) });
          const followup = await this.findBookingSubmission(booking);
          if (!followup) throw new Error('submission_booking_correlation_unavailable');
          return followup;
        }
      }
      return linked;
    }
    // Calendly may arrive before the form webhook. Recover the form identity from HubSpot
    // so the old standalone booking alert is suppressed for this submission as well.
    const contacts = await this.hubspotRequest('/crm/v3/objects/contacts/search', {
      method: 'POST', body: { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: booking.email }] }],
        properties: ['email', 'demo_form_submission_datetime'], limit: 2 },
    });
    if (!Array.isArray(contacts.results) || contacts.results.length > 1 || contacts.paging?.next) throw new Error('submission_contact_lookup_ambiguous');
    const contact = contacts.results[0];
    const submittedAt = ms(contact?.properties?.demo_form_submission_datetime);
    if (!contact || !Number.isFinite(submittedAt) || submittedAt < this.activatedAt || submittedAt > booking.bookedAt) return null;
    await this.enqueue({ objectId: contact.id, propertyValue: String(submittedAt) });
    const recovered = await this.findBookingSubmission(booking);
    if (!recovered) throw new Error('submission_booking_correlation_unavailable');
    return recovered;
  }

  async findBookingSubmission(booking) {
    const result = await this.pool.query(`SELECT contact_id, submitted_at, thread_root_key, booked_state, booking_uri FROM demo_submission_lifecycle
      WHERE email = $1 AND submitted_at <= $2 ORDER BY submitted_at DESC LIMIT 1`, [booking.email, booking.bookedAt]);
    if (result.rows[0]) return { ...booking, contactId: result.rows[0].contact_id, submittedAt: Number(result.rows[0].submitted_at), threadRootKey: result.rows[0].thread_root_key, bookedState: result.rows[0].booked_state, bookingUri: result.rows[0].booking_uri };
    return null;
  }

  async hasContact(contactId) {
    return (await this.pool.query('SELECT 1 FROM demo_submission_lifecycle WHERE contact_id = $1 LIMIT 1', [String(contactId)])).rows.length > 0;
  }

  async reconcileBooking(booking) {
    if (!booking || booking.threadRootKey || booking.bookedAt > booking.submittedAt + WINDOW_MS) return;
    await this.withContactLock(booking.email, async client => {
      const newer = (await client.query('SELECT 1 FROM demo_submission_lifecycle WHERE contact_id = $1 AND submitted_at > $2 LIMIT 1', [booking.contactId, booking.bookedAt])).rows.length;
      if (newer) return;
      await this.assignOwner(booking.contactId, booking.ownerId);
    });
  }

  async apiCollection(url) {
    const rows = [];
    const visited = new Set();
    while (url) {
      const target = new URL(url);
      if (target.origin !== 'https://api.calendly.com' || visited.has(url)) throw new Error('invalid_calendly_pagination');
      visited.add(url);
      const page = await this.calendlyRequest(url);
      if (!Array.isArray(page.collection)) throw new Error('invalid_calendly_collection');
      rows.push(...page.collection);
      url = page.pagination?.next_page;
    }
    return rows;
  }

  async discoverBookings(row) {
    // Ask Calendly directly before saying a lead did not book: webhook delivery can lag.
    const me = await this.calendlyRequest('https://api.calendly.com/users/me');
    const organization = me.resource?.current_organization;
    if (!organization) throw new Error('calendly_organization_unavailable');
    await this.refreshOwners();
    const query = new URLSearchParams({ organization, invitee_email: row.email, status: 'active', count: '100' });
    const events = await this.apiCollection(`https://api.calendly.com/scheduled_events?${query}`);
    for (const event of events) {
      const filter = shouldProcessScheduledEvent(event);
      if (!filter.ok && CONFIG.allowedEventTypeUris.has(event.event_type)) throw new Error('calendly_host_unresolved');
      if (!filter.ok) continue;
      if (!/^https:\/\/api\.calendly\.com\/scheduled_events\/[\w-]+$/.test(event.uri)) throw new Error('invalid_calendly_event_uri');
      const invitees = await this.apiCollection(`${event.uri}/invitees?status=active&count=100`);
      for (const invitee of invitees) {
        if (normalizeEmail(invitee.email) !== row.email) continue;
        const createdAt = ms(invitee.created_at);
        if (!Number.isFinite(createdAt)) throw new Error('booking_creation_time_unavailable');
        if (createdAt >= Number(row.submitted_at)) await this.saveBooking(invitee, event, filter);
      }
    }
  }

  async assignOwner(contactId, ownerId) {
    if (!this.ownerSlackMap[ownerId]) throw new Error('contact_owner_slack_mapping_missing');
    const owner = await this.hubspotRequest(`/crm/v3/owners/${ownerId}`);
    if (owner.archived !== false || String(owner.id) !== ownerId) throw new Error('contact_owner_inactive_or_unverified');
    await this.hubspotRequest(`/crm/v3/objects/contacts/${contactId}`, {
      method: 'PATCH', body: { properties: { hubspot_owner_id: ownerId } },
    });
    const contact = await this.hubspotRequest(`/crm/v3/objects/contacts/${contactId}?properties=${PROPERTIES.join(',')}`);
    if (String(contact.id) !== String(contactId) || String(contact.properties?.hubspot_owner_id) !== ownerId) throw new Error('contact_owner_verification_failed');
    return contact;
  }

  meetingText(booking) {
    const d = booking.details;
    const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : 'unavailable';
    return [`Meeting: ${escape(d.name)}`, `Host: ${escape(d.host)}`,
      `Starts: ${date(d.start)} (UTC)`, `Ends: ${date(d.end)} (UTC)`,
      ...(d.location ? [`Location: ${escape(d.location)}`] : [])].join('\n');
  }

  async send(client, row, stateColumn, message) {
    if (!['parent_state', 'parent_update_state', 'no_booking_state', 'booked_state'].includes(stateColumn)) throw new Error('invalid_notification_phase');
    // State is persisted before the external write, while holding the contact lock.
    const claim = await client.query(`UPDATE demo_submission_lifecycle SET ${stateColumn} = 'sending'
      WHERE submission_key = $1 AND ${stateColumn} = 'pending' RETURNING submission_key`, [row.submission_key]);
    if (!claim.rows.length) return null;
    const updating = stateColumn === 'parent_update_state';
    let definitelyRejected = updating;
    try {
      const response = await this.fetchImpl(`https://slack.com/api/${updating ? 'chat.update' : 'chat.postMessage'}`, {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${this.env.SLACK_BOT_TOKEN.replace(/\s+/g, '')}`, 'content-type': 'application/json' },
        body: JSON.stringify(updating
          ? { channel: CHANNEL_ID, ts: row.parent_ts, text: message.text, blocks: message.blocks }
          : { channel: CHANNEL_ID, unfurl_links: false, unfurl_media: false, ...message }),
      });
      if (response.status === 429) { definitelyRejected = true; throw new Error('slack_rate_limited'); }
      if (!response.ok) throw new Error('slack_http_delivery_unknown');
      const result = await response.json();
      if (result.ok === false) { definitelyRejected = true; throw new Error('slack_rejected'); }
      if (result.ok !== true || !result.ts || result.channel !== CHANNEL_ID) throw new Error('slack_delivery_unknown');
      await client.query(`UPDATE demo_submission_lifecycle SET ${stateColumn} = 'sent'
        ${stateColumn === 'parent_state' ? ', parent_ts = $2' : ''} WHERE submission_key = $1`,
      stateColumn === 'parent_state' ? [row.submission_key, result.ts] : [row.submission_key]);
      return result.ts;
    } catch (error) {
      await client.query(`UPDATE demo_submission_lifecycle SET ${stateColumn} = $2, last_error = $3
        WHERE submission_key = $1`, [row.submission_key, definitelyRejected ? 'pending' : 'needs_review', definitelyRejected ? 'slack_rejected' : 'slack_delivery_unknown']);
      this.logger.error(definitelyRejected ? 'demo_submission_delivery_rejected' : 'demo_submission_delivery_needs_review', { submissionKey: row.submission_key, phase: stateColumn });
      throw error;
    }
  }

  async processRow(key) {
    const initial = (await this.pool.query('SELECT * FROM demo_submission_lifecycle WHERE submission_key = $1', [key])).rows[0];
    if (!initial) return;
    await this.withContactLock(initial.email, async client => {
      const row = (await client.query('SELECT * FROM demo_submission_lifecycle WHERE submission_key = $1', [key])).rows[0];
      if (Number(row.next_check) > this.now() || row.parent_state === 'needs_review' || row.booked_state !== 'pending') return;
      for (const column of ['parent_state', 'parent_update_state', 'no_booking_state', 'booked_state']) {
        if (row[column] === 'sending') {
          if (column === 'parent_update_state') {
            await client.query("UPDATE demo_submission_lifecycle SET parent_update_state = 'pending' WHERE submission_key = $1", [key]);
            row[column] = 'pending';
            continue;
          }
          await client.query(`UPDATE demo_submission_lifecycle SET ${column} = 'needs_review', last_error = 'slack_delivery_unknown'
            WHERE submission_key = $1`, [key]);
          row[column] = 'needs_review';
        }
      }
      if (row.parent_state === 'needs_review' || row.booked_state !== 'pending') return;
      const repeat = Boolean(row.thread_root_key);
      if (repeat) {
        const root = (await client.query('SELECT * FROM demo_submission_lifecycle WHERE submission_key = $1', [row.thread_root_key])).rows[0];
        if (!root?.parent_ts || root.parent_state !== 'sent') return;
        row.parent_ts = root.parent_ts;
        row.parent_state = 'sent';
        row.no_booking_state = 'sent';
        await client.query(`UPDATE demo_submission_lifecycle SET parent_ts = $2, parent_state = 'sent', no_booking_state = 'sent'
          WHERE submission_key = $1`, [key, root.parent_ts]);
      }
      // Discover outside no state assumptions: this also recovers missed late webhooks.
      const scoped = Object.create(this);
      scoped.pool = client;
      await scoped.discoverBookings(row);
      const booking = (await client.query(`SELECT b.* FROM demo_submission_bookings b WHERE b.email = $1
        AND b.booked_at >= $2 AND b.canceled = false
        AND NOT EXISTS (SELECT 1 FROM demo_submission_lifecycle s WHERE s.email = $1
          AND s.submitted_at > $2 AND s.submitted_at <= b.booked_at)
        ORDER BY b.booked_at, b.invitee_uri LIMIT 1`, [row.email, row.submitted_at])).rows[0];
      if (booking) {
        const notified = (await client.query(`SELECT 1 FROM demo_submission_lifecycle
          WHERE email = $1 AND booking_uri = $2 AND booked_state = 'sent' AND submission_key != $3 LIMIT 1`,
        [row.email, booking.invitee_uri, key])).rows.length > 0;
        if (notified) {
          await client.query("UPDATE demo_submission_lifecycle SET booked_state = 'sent', booking_uri = $2 WHERE submission_key = $1", [key, booking.invitee_uri]);
          return;
        }
      }
      const early = !repeat && booking && Number(booking.booked_at) <= Number(row.submitted_at) + WINDOW_MS;
      if (!booking && this.now() < Number(row.submitted_at) + WINDOW_MS) return;
      const newer = (await client.query('SELECT 1 FROM demo_submission_lifecycle WHERE contact_id = $1 AND submitted_at > $2 AND thread_root_key IS NULL LIMIT 1', [row.contact_id, row.submitted_at])).rows.length > 0;
      let ownerId = early ? booking.owner_id : row.assigned_owner;
      if (!ownerId) {
        ownerId = RANDOM_OWNER_IDS[this.randomInt(RANDOM_OWNER_IDS.length)];
        await client.query('UPDATE demo_submission_lifecycle SET assigned_owner = $2 WHERE submission_key = $1', [key, ownerId]);
      }
      let contact;
      if (newer || (row.parent_ts && !early)) {
        contact = await this.hubspotRequest(`/crm/v3/objects/contacts/${row.contact_id}?properties=${PROPERTIES.join(',')}`);
        ownerId = String(contact.properties?.hubspot_owner_id || '');
        if (!this.ownerSlackMap[ownerId]) throw new Error('contact_owner_slack_mapping_missing');
      } else {
        contact = await this.assignOwner(row.contact_id, ownerId);
      }
      const mention = `<@${this.ownerSlackMap[ownerId]}>`;
      let parentTs = row.parent_ts;
      if (row.parent_state === 'pending' || (early && row.parent_ts)) {
        const message = buildMessage(contact, { slackUserId: this.ownerSlackMap[ownerId] });
        if (early) {
          message.text += `\n- Booked a meeting within five minutes.\n${this.meetingText(booking)}`;
          message.blocks[0].text.text = message.text;
        }
        if (row.parent_ts) {
          await this.send(client, row, 'parent_update_state', message);
        } else {
          parentTs = await this.send(client, row, 'parent_state', message);
        }
      }
      if (!parentTs) return;
      if (!early && row.no_booking_state === 'pending') {
        await this.send(client, row, 'no_booking_state', {
          thread_ts: parentTs, text: `${mention} This lead did NOT book a meeting within the first five minutes. Please follow up.`,
        });
      }
      if (booking) {
        const bookedOwner = early && !newer ? booking.owner_id : ownerId;
        const bookedMention = `<@${this.ownerSlackMap[bookedOwner]}>`;
        if (!early || row.parent_ts) {
          await this.send(client, row, 'booked_state', {
            thread_ts: parentTs, text: `${bookedMention} This lead booked a meeting${repeat ? '' : early ? ' within the first five minutes (booking confirmation arrived later)' : ' after the first five minutes'}.\n${this.meetingText(booking)}`,
          });
        } else {
          await client.query("UPDATE demo_submission_lifecycle SET booked_state = 'sent' WHERE submission_key = $1", [key]);
        }
        await client.query('UPDATE demo_submission_lifecycle SET booking_uri = $2 WHERE submission_key = $1', [key, booking.invitee_uri]);
        if (repeat) await client.query("UPDATE demo_submission_lifecycle SET booked_state = 'sent', booking_uri = COALESCE(booking_uri, $2) WHERE submission_key = $1", [row.thread_root_key, booking.invitee_uri]);
      }
      await client.query('UPDATE demo_submission_lifecycle SET next_check = $2, last_error = NULL WHERE submission_key = $1', [key, this.now() + WINDOW_MS]);
    });
  }

  async tick() {
    const rows = (await this.pool.query(`SELECT submission_key FROM demo_submission_lifecycle
      WHERE next_check <= $1 AND booked_state = 'pending' AND parent_state != 'needs_review'
      ORDER BY next_check LIMIT 25`, [this.now()])).rows;
    for (const row of rows) {
      try { await this.processRow(row.submission_key); }
      catch {
        await this.pool.query('UPDATE demo_submission_lifecycle SET next_check = $2 WHERE submission_key = $1', [row.submission_key, this.now() + 30000]);
        this.logger.error('demo_submission_retry_pending', { submissionKey: row.submission_key });
      }
    }
  }

  start() {
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try { await this.tick(); } catch { this.logger.error('demo_submission_worker_failed'); }
      finally { running = false; }
    };
    const timer = setInterval(run, 15000);
    timer.unref();
    void run();
    return timer;
  }
}

module.exports = { DemoSubmissionLifecycle, WINDOW_MS, RANDOM_OWNER_IDS, CHANNEL_ID };
