// A committed row reservation precedes the Sheets write. Retrying writes the same
// cells, so an ambiguous Google timeout cannot append a second issue.
class IssueLogStore {
  constructor(pool) { this.pool = pool; }

  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS slack_issue_log_requests (
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      requester_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('clarifying', 'reserved', 'completed')),
      sheet_row INTEGER UNIQUE CHECK (sheet_row > 1),
      cells JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (channel_id, thread_ts)
    )`);
  }

  async withLock(fn) {
    const client = await this.pool.connect();
    let locked = false;
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('truewind-leads-issue-sheet'))");
      locked = true;
      const state = {
        get: async (channel, thread) => {
          const r = await client.query('SELECT * FROM slack_issue_log_requests WHERE channel_id=$1 AND thread_ts=$2', [channel, thread]);
          return r.rows[0] || null;
        },
        clarify: async (channel, thread, requester) => {
          await client.query(`INSERT INTO slack_issue_log_requests (channel_id,thread_ts,requester_id,status)
            VALUES ($1,$2,$3,'clarifying') ON CONFLICT (channel_id,thread_ts) DO NOTHING`, [channel, thread, requester]);
        },
        reserve: async (channel, thread, requester, nextRow, cells) => {
          const r = await client.query(`INSERT INTO slack_issue_log_requests (channel_id,thread_ts,requester_id,status,sheet_row,cells)
            VALUES ($1,$2,$3,'reserved',GREATEST($4,(SELECT COALESCE(MAX(sheet_row),1)+1 FROM slack_issue_log_requests)),$5::jsonb)
            ON CONFLICT (channel_id,thread_ts) DO UPDATE SET status='reserved',sheet_row=EXCLUDED.sheet_row,cells=EXCLUDED.cells,updated_at=NOW()
            RETURNING *`, [channel, thread, requester, nextRow, JSON.stringify(cells)]);
          return r.rows[0];
        },
        complete: async (channel, thread) => {
          await client.query("UPDATE slack_issue_log_requests SET status='completed',updated_at=NOW() WHERE channel_id=$1 AND thread_ts=$2", [channel, thread]);
        },
      };
      return await fn(state);
    } finally {
      // Destroy a connection if releasing its session lock fails.
      let releaseError;
      if (locked) {
        try { await client.query("SELECT pg_advisory_unlock(hashtext('truewind-leads-issue-sheet'))"); }
        catch (error) { releaseError = error; }
      }
      client.release(releaseError);
    }
  }
}
module.exports = { IssueLogStore };
