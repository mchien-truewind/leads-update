const crypto = require('crypto');

const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1000;

function interactionJobId(payload = {}) {
  const action = payload.actions?.[0] || {};
  const parts = [
    payload.api_app_id || '',
    payload.team?.id || '',
    action.action_id || '',
    payload.user?.id || '',
    payload.message?.ts || payload.container?.message_ts || '',
    action.action_ts || '',
  ];
  if (parts.slice(2).some((value) => !value)) return '';
  return crypto.createHash('sha256').update(parts.join(':')).digest('hex');
}

function minimalInteractionPayload(payload = {}) {
  const action = payload.actions?.[0] || {};
  return {
    type: payload.type || '',
    api_app_id: payload.api_app_id || '',
    team: { id: payload.team?.id || '' },
    user: { id: payload.user?.id || '' },
    channel: { id: payload.channel?.id || payload.container?.channel_id || '' },
    container: {
      channel_id: payload.container?.channel_id || payload.channel?.id || '',
      message_ts: payload.container?.message_ts || payload.message?.ts || '',
    },
    message: {
      ts: payload.message?.ts || payload.container?.message_ts || '',
      thread_ts: payload.message?.thread_ts || '',
    },
    actions: [{
      action_id: action.action_id || '',
      action_ts: action.action_ts || '',
      block_id: action.block_id || '',
      selected_option: action.selected_option || null,
    }],
  };
}

class PostgresSlackStateStore {
  constructor({ pool, logger = console, staleLockMs = DEFAULT_STALE_LOCK_MS } = {}) {
    if (!pool) throw new Error('PostgresSlackStateStore requires a pool');
    this.pool = pool;
    this.logger = logger;
    this.staleLockMs = Number.isFinite(staleLockMs) && staleLockMs > 0 ? staleLockMs : DEFAULT_STALE_LOCK_MS;
  }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS slack_pending_deal_source_requests (
        request_id UUID PRIMARY KEY,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'needs_review')),
        claimed_by TEXT,
        locked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS slack_interaction_jobs (
        job_id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'needs_review')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        locked_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS deal_owner_overrides (
        deal_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        requested_by_slack_user_id TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (BTRIM(deal_id) <> ''),
        CHECK (BTRIM(owner_id) <> '')
      );
      CREATE INDEX IF NOT EXISTS slack_interaction_jobs_recovery_idx
        ON slack_interaction_jobs (status, available_at, locked_at);
      ALTER TABLE slack_pending_deal_source_requests
        ADD COLUMN IF NOT EXISTS claimed_by TEXT,
        ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS last_error TEXT;
      ALTER TABLE slack_pending_deal_source_requests
        DROP CONSTRAINT IF EXISTS slack_pending_deal_source_requests_status_check;
      ALTER TABLE slack_interaction_jobs
        DROP CONSTRAINT IF EXISTS slack_interaction_jobs_status_check;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_pending_deal_source_requests_status_check_v2') THEN
          ALTER TABLE slack_pending_deal_source_requests
            ADD CONSTRAINT slack_pending_deal_source_requests_status_check_v2
            CHECK (status IN ('pending', 'processing', 'completed', 'needs_review')) NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_interaction_jobs_status_check_v2') THEN
          ALTER TABLE slack_interaction_jobs
            ADD CONSTRAINT slack_interaction_jobs_status_check_v2
            CHECK (status IN ('pending', 'processing', 'completed', 'needs_review')) NOT VALID;
        END IF;
      END $$;
    `);
  }

  async savePendingDealSourceRequest(requestId, payload) {
    await this.pool.query(
      `INSERT INTO slack_pending_deal_source_requests (request_id, payload)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (request_id) DO NOTHING`,
      [requestId, JSON.stringify(payload)],
    );
  }

  async getPendingDealSourceRequest(requestId) {
    const result = await this.pool.query(
      `SELECT payload FROM slack_pending_deal_source_requests
       WHERE request_id = $1 AND status = 'pending'`,
      [requestId],
    );
    return result.rows[0]?.payload || null;
  }

  async claimPendingDealSourceRequest(requestId, jobId) {
    const result = await this.pool.query(
      `UPDATE slack_pending_deal_source_requests
       SET status = 'processing', claimed_by = $2, locked_at = NOW()
       WHERE request_id = $1 AND status = 'pending'
       RETURNING payload`,
      [requestId, jobId],
    );
    return result.rows[0]?.payload || null;
  }

  async completePendingDealSourceRequest(requestId, jobId = null) {
    await this.pool.query(
      `UPDATE slack_pending_deal_source_requests
       SET status = 'completed', completed_at = NOW(), locked_at = NULL
       WHERE request_id = $1 AND status = 'processing' AND ($2::text IS NULL OR claimed_by = $2)`,
      [requestId, jobId],
    );
  }

  async markPendingDealSourceNeedsReview(requestId, jobId, error) {
    await this.pool.query(
      `UPDATE slack_pending_deal_source_requests
       SET status = 'needs_review', locked_at = NULL, last_error = $3
       WHERE request_id = $1 AND status = 'processing' AND claimed_by = $2`,
      [requestId, jobId, String(error || '').slice(0, 1000)],
    );
  }

  async enqueueInteraction(payload) {
    const jobId = interactionJobId(payload);
    if (!jobId) throw new Error('invalid_interaction_identity');
    const minimalPayload = minimalInteractionPayload(payload);
    const result = await this.pool.query(
      `INSERT INTO slack_interaction_jobs (job_id, payload)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (job_id) DO NOTHING
       RETURNING job_id`,
      [jobId, JSON.stringify(minimalPayload)],
    );
    return { jobId, inserted: result.rowCount === 1 };
  }

  async claimInteraction(jobId) {
    const result = await this.pool.query(
      `UPDATE slack_interaction_jobs
       SET status = 'processing', attempts = attempts + 1, locked_at = NOW(), updated_at = NOW()
       WHERE job_id = $1
         AND status = 'pending'
         AND available_at <= NOW()
       RETURNING payload, attempts`,
      [jobId],
    );
    return result.rows[0] || null;
  }

  async completeInteraction(jobId) {
    await this.pool.query(
      `UPDATE slack_interaction_jobs
       SET status = 'completed', completed_at = NOW(), locked_at = NULL, last_error = NULL, updated_at = NOW()
       WHERE job_id = $1 AND status = 'processing'`,
      [jobId],
    );
  }

  async failInteraction(jobId, error) {
    await this.pool.query(
      `UPDATE slack_interaction_jobs
       SET status = 'needs_review',
           locked_at = NULL,
           last_error = $2,
           updated_at = NOW()
       WHERE job_id = $1 AND status = 'processing'`,
      [jobId, String(error || '').slice(0, 1000)],
    );
  }

  async markStaleInteractionsForReview() {
    const result = await this.pool.query(
      `WITH stale_jobs AS (
         UPDATE slack_interaction_jobs
         SET status = 'needs_review', locked_at = NULL,
             last_error = COALESCE(last_error, 'processing lock expired; external side effects require reconciliation'),
             updated_at = NOW()
         WHERE status = 'processing' AND locked_at < NOW() - ($1 * INTERVAL '1 millisecond')
         RETURNING job_id
       ), quarantined_requests AS (
         UPDATE slack_pending_deal_source_requests AS pending
         SET status = 'needs_review', locked_at = NULL,
             last_error = COALESCE(pending.last_error, 'claimed interaction became stale; reconcile before manual action')
         FROM stale_jobs
         WHERE pending.status = 'processing' AND pending.claimed_by = stale_jobs.job_id
         RETURNING pending.request_id
       )
       SELECT job_id FROM stale_jobs`,
      [this.staleLockMs],
    );
    return result.rows.map((row) => row.job_id);
  }

  async recoverableInteractionIds(limit = 25) {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 25;
    const result = await this.pool.query(
      `SELECT job_id FROM slack_interaction_jobs
       WHERE status = 'pending' AND available_at <= NOW()
       ORDER BY created_at ASC
       LIMIT $1`,
      [safeLimit],
    );
    return result.rows.map((row) => row.job_id);
  }

  async pruneCompleted(retentionDays = 30) {
    const days = Number.isFinite(retentionDays) && retentionDays > 0 ? Math.min(Math.floor(retentionDays), 365) : 30;
    await this.pool.query(
      `DELETE FROM slack_interaction_jobs
       WHERE status = 'completed' AND completed_at < NOW() - ($1 * INTERVAL '1 day')`,
      [days],
    );
    await this.pool.query(
      `DELETE FROM slack_pending_deal_source_requests
       WHERE status = 'completed' AND completed_at < NOW() - ($1 * INTERVAL '1 day')`,
      [days],
    );
  }

  async pruneExpired({ pendingDays = 7, reviewDays = 90 } = {}) {
    const safePendingDays = Number.isFinite(pendingDays) && pendingDays > 0 ? Math.min(Math.floor(pendingDays), 30) : 7;
    const safeReviewDays = Number.isFinite(reviewDays) && reviewDays > 0 ? Math.min(Math.floor(reviewDays), 365) : 90;
    const result = await this.pool.query(
      `WITH deleted_pending AS (
         DELETE FROM slack_pending_deal_source_requests
         WHERE status = 'pending' AND created_at < NOW() - ($1 * INTERVAL '1 day')
         RETURNING 1
       ), deleted_review_requests AS (
         DELETE FROM slack_pending_deal_source_requests
         WHERE status = 'needs_review' AND created_at < NOW() - ($2 * INTERVAL '1 day')
         RETURNING 1
       ), deleted_review_jobs AS (
         DELETE FROM slack_interaction_jobs
         WHERE status = 'needs_review' AND created_at < NOW() - ($2 * INTERVAL '1 day')
         RETURNING 1
       )
       SELECT
         (SELECT COUNT(*) FROM deleted_pending)::int AS pending_deleted,
         (SELECT COUNT(*) FROM deleted_review_requests)::int AS review_requests_deleted,
         (SELECT COUNT(*) FROM deleted_review_jobs)::int AS review_jobs_deleted`,
      [safePendingDays, safeReviewDays],
    );
    return result.rows[0] || { pending_deleted: 0, review_requests_deleted: 0, review_jobs_deleted: 0 };
  }

  async listNeedsReview(limit = 50) {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 50;
    const result = await this.pool.query(
      `SELECT jobs.job_id, jobs.attempts, jobs.last_error, jobs.created_at, jobs.updated_at,
              jobs.payload #>> '{channel,id}' AS channel_id,
              jobs.payload #>> '{message,ts}' AS message_ts,
              jobs.payload #>> '{user,id}' AS user_id,
              jobs.payload #>> '{actions,0,action_id}' AS action_id,
              pending.request_id, pending.status AS pending_status
       FROM slack_interaction_jobs AS jobs
       LEFT JOIN slack_pending_deal_source_requests AS pending ON pending.claimed_by = jobs.job_id
       WHERE jobs.status = 'needs_review'
       ORDER BY jobs.updated_at ASC
       LIMIT $1`,
      [safeLimit],
    );
    return result.rows;
  }

  async setDealOwnerOverride({ dealId, ownerId, requestedBySlackUserId = '' } = {}) {
    const normalizedDealId = String(dealId || '').trim();
    const normalizedOwnerId = String(ownerId || '').trim();
    if (!normalizedDealId || !normalizedOwnerId) {
      throw new Error('deal owner override requires non-empty dealId and ownerId');
    }
    const result = await this.pool.query(
      `INSERT INTO deal_owner_overrides (deal_id, owner_id, requested_by_slack_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (deal_id) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           requested_by_slack_user_id = EXCLUDED.requested_by_slack_user_id,
           updated_at = NOW()
       RETURNING deal_id, owner_id, requested_by_slack_user_id, created_at, updated_at`,
      [normalizedDealId, normalizedOwnerId, String(requestedBySlackUserId || '').trim()],
    );
    return result.rows[0] || null;
  }

  async getDealOwnerOverrides(dealIds = []) {
    const normalizedIds = [...new Set((dealIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!normalizedIds.length) return new Map();
    const result = await this.pool.query(
      `SELECT deal_id, owner_id, requested_by_slack_user_id, created_at, updated_at
       FROM deal_owner_overrides
       WHERE deal_id = ANY($1::text[])`,
      [normalizedIds],
    );
    return new Map((result.rows || []).map((row) => [String(row.deal_id), {
      dealId: String(row.deal_id),
      ownerId: String(row.owner_id),
      requestedBySlackUserId: String(row.requested_by_slack_user_id || ''),
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
    }]));
  }

  async close() {
    if (typeof this.pool.end === 'function') await this.pool.end();
  }
}

function createPostgresSlackStateStore({ connectionString, logger = console, PoolClass } = {}) {
  const url = String(connectionString || '').trim();
  if (!url) return null;
  const Pool = PoolClass || require('pg').Pool;
  const pool = new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 1500,
    query_timeout: 2000,
  });
  return new PostgresSlackStateStore({ pool, logger });
}

module.exports = {
  PostgresSlackStateStore,
  createPostgresSlackStateStore,
  interactionJobId,
  minimalInteractionPayload,
};
