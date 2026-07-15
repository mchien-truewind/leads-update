const assert = require('assert');
const crypto = require('crypto');
const test = require('node:test');
const { Pool } = require('pg');

const { PostgresSlackStateStore } = require('../slack_state_store');

const connectionString = process.env.SLACK_STATE_TEST_DATABASE_URL || '';

test('real Postgres enforces pending-request single claim and stale quarantine', {
  skip: !connectionString,
}, async () => {
  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 3000, query_timeout: 3000 });
  const store = new PostgresSlackStateStore({ pool, staleLockMs: 1 });
  const requestId = crypto.randomUUID();
  const messageTs = `${Date.now()}.000100`;
  const basePayload = {
    type: 'block_actions',
    api_app_id: 'A_INTEGRATION',
    team: { id: 'T_INTEGRATION' },
    user: { id: 'U_INTEGRATION' },
    channel: { id: 'C_INTEGRATION' },
    container: { channel_id: 'C_INTEGRATION', message_ts: messageTs },
    message: { ts: messageTs },
    actions: [{
      action_id: 'select_deal_source_for_structured_deal',
      action_ts: `${Date.now()}.000200`,
      block_id: `deal_source_request:${requestId}`,
      selected_option: { value: 'Referral', text: { text: 'Inbound - Referral' } },
    }],
  };
  const secondPayload = JSON.parse(JSON.stringify(basePayload));
  secondPayload.actions[0].action_ts = `${Date.now() + 1}.000300`;
  const jobIds = [];

  try {
    await store.initialize();
    await store.savePendingDealSourceRequest(requestId, { company: 'Integration Test Co' });
    const first = await store.enqueueInteraction(basePayload);
    const second = await store.enqueueInteraction(secondPayload);
    jobIds.push(first.jobId, second.jobId);
    await Promise.all(jobIds.map((jobId) => store.claimInteraction(jobId)));

    const claims = await Promise.all(jobIds.map((jobId) => (
      store.claimPendingDealSourceRequest(requestId, jobId)
    )));
    assert.strictEqual(claims.filter(Boolean).length, 1);

    await pool.query(
      `UPDATE slack_interaction_jobs SET locked_at = NOW() - INTERVAL '1 minute' WHERE job_id = ANY($1::text[])`,
      [jobIds],
    );
    const quarantined = await store.markStaleInteractionsForReview();
    assert.strictEqual(jobIds.every((jobId) => quarantined.includes(jobId)), true);
    const pendingReadback = await pool.query(
      'SELECT status, claimed_by FROM slack_pending_deal_source_requests WHERE request_id = $1',
      [requestId],
    );
    assert.strictEqual(pendingReadback.rows[0].status, 'needs_review');
    assert.strictEqual(jobIds.includes(pendingReadback.rows[0].claimed_by), true);
    const recoverable = await store.recoverableInteractionIds(100);
    assert.strictEqual(jobIds.some((jobId) => recoverable.includes(jobId)), false);
  } finally {
    if (jobIds.length > 0) {
      await pool.query('DELETE FROM slack_interaction_jobs WHERE job_id = ANY($1::text[])', [jobIds]).catch(() => {});
    }
    await pool.query('DELETE FROM slack_pending_deal_source_requests WHERE request_id = $1', [requestId]).catch(() => {});
    await pool.end();
  }
});
