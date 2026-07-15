const assert = require('assert');
const test = require('node:test');

const {
  PostgresSlackStateStore,
  createPostgresSlackStateStore,
  interactionJobId,
  minimalInteractionPayload,
} = require('../slack_state_store');

function samplePayload() {
  return {
    type: 'block_actions',
    api_app_id: 'A_TEST',
    team: { id: 'T_TEST' },
    user: { id: 'U_TEST', name: 'sensitive-name' },
    channel: { id: 'C_TEST', name: 'private-channel' },
    container: { channel_id: 'C_TEST', message_ts: '1770000000.000100' },
    message: { ts: '1770000000.000100', text: 'sensitive prospect context' },
    token: 'deprecated-secret-token',
    response_url: 'https://hooks.slack.com/actions/secret',
    actions: [{
      action_id: 'select_deal_source_for_structured_deal',
      action_ts: '1770000001.000100',
      block_id: 'deal_source_request:00000000-0000-4000-8000-000000000001',
      selected_option: { value: 'Referral', text: { text: 'Inbound - Referral' } },
    }],
  };
}

test('interaction identity is stable and changes with action timestamp', () => {
  const payload = samplePayload();
  const first = interactionJobId(payload);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.strictEqual(interactionJobId(payload), first);
  const changed = samplePayload();
  changed.actions[0].action_ts = '1770000002.000100';
  assert.notStrictEqual(interactionJobId(changed), first);
});

test('minimal payload excludes Slack secrets and message text', () => {
  const minimal = minimalInteractionPayload(samplePayload());
  const serialized = JSON.stringify(minimal);
  assert.doesNotMatch(serialized, /deprecated-secret-token|hooks\.slack\.com|sensitive prospect|private-channel|sensitive-name/);
  assert.strictEqual(minimal.actions[0].selected_option.value, 'Referral');
  assert.strictEqual(minimal.container.channel_id, 'C_TEST');
});

test('store enqueues idempotently and claims atomically through SQL contract', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO slack_interaction_jobs')) return { rowCount: 1, rows: [{ job_id: params[0] }] };
      if (sql.includes("SET status = 'processing'")) return { rowCount: 1, rows: [{ payload: minimalInteractionPayload(samplePayload()), attempts: 1 }] };
      return { rowCount: 1, rows: [] };
    },
  };
  const store = new PostgresSlackStateStore({ pool });
  const enqueued = await store.enqueueInteraction(samplePayload());
  assert.strictEqual(enqueued.inserted, true);
  assert.match(enqueued.jobId, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(calls[0].params[1], /deprecated-secret-token|sensitive prospect/);
  const claim = await store.claimInteraction(enqueued.jobId);
  assert.strictEqual(claim.attempts, 1);
  assert.match(calls[1].sql, /status = 'processing'/);
  assert.match(calls[1].sql, /AND status = 'pending'/);
  assert.doesNotMatch(calls[1].sql, /locked_at < NOW/);
});

test('pending deal request is atomically bound to one interaction job', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [{ payload: { company: 'Acme' } }] };
    },
  };
  const store = new PostgresSlackStateStore({ pool });
  const payload = await store.claimPendingDealSourceRequest(
    '00000000-0000-4000-8000-000000000001',
    'job-1',
  );
  assert.deepStrictEqual(payload, { company: 'Acme' });
  assert.match(calls[0].sql, /SET status = 'processing', claimed_by = \$2/);
  assert.match(calls[0].sql, /WHERE request_id = \$1 AND status = 'pending'/);
});

test('stale processing jobs move to needs_review instead of replaying', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [{ job_id: 'stale-job' }] };
    },
  };
  const store = new PostgresSlackStateStore({ pool, staleLockMs: 1000 });
  const ids = await store.markStaleInteractionsForReview();
  assert.deepStrictEqual(ids, ['stale-job']);
  assert.match(calls[0].sql, /SET status = 'needs_review'/);
  assert.match(calls[0].sql, /status = 'processing'/);
});

test('missing connection string fails closed by returning no store', () => {
  assert.strictEqual(createPostgresSlackStateStore({ connectionString: '' }), null);
});
