// Shares the Slack service's PostgreSQL pool; no credentials or invitee payloads are persisted here.
class DemoBookingStore {
  constructor(pool) { this.pool = pool; }

  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS demo_booking_links (
      invitee_uri TEXT PRIMARY KEY,
      event_uri TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      deal_id TEXT NOT NULL,
      meeting_id TEXT,
      reused_existing_deal BOOLEAN NOT NULL,
      notification_state TEXT NOT NULL DEFAULT 'pending',
      canceled BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  }

  async get(inviteeUri) {
    return (await this.pool.query('SELECT * FROM demo_booking_links WHERE invitee_uri = $1', [inviteeUri])).rows[0] || null;
  }

  async put({ inviteeUri, eventUri, contactId, dealId, meetingId = null, reusedExistingDeal }) {
    const row = (await this.pool.query(`INSERT INTO demo_booking_links
      (invitee_uri, event_uri, contact_id, deal_id, meeting_id, reused_existing_deal)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (invitee_uri) DO UPDATE SET
        meeting_id = COALESCE(demo_booking_links.meeting_id, EXCLUDED.meeting_id), updated_at = NOW()
      WHERE demo_booking_links.deal_id = EXCLUDED.deal_id
        AND demo_booking_links.contact_id = EXCLUDED.contact_id
        AND demo_booking_links.reused_existing_deal = EXCLUDED.reused_existing_deal
      RETURNING *`, [inviteeUri, eventUri, contactId, dealId, meetingId, reusedExistingDeal])).rows[0];
    if (!row) throw new Error('booking_link_conflict');
    return row;
  }

  async markCanceled(inviteeUri) {
    await this.pool.query('UPDATE demo_booking_links SET canceled = true, updated_at = NOW() WHERE invitee_uri = $1', [inviteeUri]);
  }

  async claimNotification(inviteeUri) {
    return (await this.pool.query(`UPDATE demo_booking_links SET notification_state = 'sending', updated_at = NOW()
      WHERE invitee_uri = $1 AND notification_state = 'pending' RETURNING invitee_uri`, [inviteeUri])).rowCount === 1;
  }

  async finishNotification(inviteeUri) {
    await this.pool.query("UPDATE demo_booking_links SET notification_state = 'sent', updated_at = NOW() WHERE invitee_uri = $1", [inviteeUri]);
  }

  async quarantineNotification(inviteeUri) {
    await this.pool.query("UPDATE demo_booking_links SET notification_state = 'needs_review', updated_at = NOW() WHERE invitee_uri = $1", [inviteeUri]);
  }

  // A connection-scoped advisory lock serializes all events for the same invitee across replicas.
  async withLock(key, operation) {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
      // Use this same client for the guarded work. Holding every pool client for
      // locks while requesting another for the work can exhaust the pool.
      return await operation(new DemoBookingStore(client));
    } finally {
      try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]); }
      finally { client.release(); }
    }
  }
}

module.exports = { DemoBookingStore };
