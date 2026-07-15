#!/usr/bin/env node

const { createPostgresSlackStateStore } = require('./slack_state_store');

function sanitizeError(value) {
  return String(value || '')
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, '[redacted-slack-token]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted-token]')
    .slice(0, 300);
}

async function main() {
  const command = process.argv[2] || 'list-needs-review';
  const store = createPostgresSlackStateStore({
    connectionString: process.env.SLACK_STATE_DATABASE_URL || process.env.DATABASE_URL,
  });
  if (!store) throw new Error('Set SLACK_STATE_DATABASE_URL before running Slack state administration');
  await store.initialize();

  if (command === 'list-needs-review') {
    const rows = await store.listNeedsReview(Number(process.env.SLACK_STATE_ADMIN_LIMIT || 50));
    console.log(JSON.stringify({
      count: rows.length,
      jobs: rows.map((row) => ({
        job_id: row.job_id,
        attempts: row.attempts,
        last_error: sanitizeError(row.last_error),
        channel_id: row.channel_id,
        message_ts: row.message_ts,
        user_id: row.user_id,
        action_id: row.action_id,
        request_id: row.request_id,
        pending_status: row.pending_status,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
    }, null, 2));
    await store.close();
    return;
  }

  await store.close();
  throw new Error(`Unsupported command: ${command}`);
}

main().catch((err) => {
  console.error(sanitizeError(err.message));
  process.exit(1);
});
