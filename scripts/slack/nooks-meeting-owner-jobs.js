const { createHash } = require('node:crypto');
const DELAY = 5 * 60 * 1000;
const reason = error => /^nooks_[a-z_]+$/.test(error?.message || '') ? error.message : 'nooks_calendar_or_crm_unavailable';
class NooksMeetingOwnerJobs {
  constructor({ pool, request, resolveMeetingOwner, notify, now = Date.now, logger = console }) {
    Object.assign(this, { pool, request, resolveMeetingOwner, notify, now, logger });
  }
  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nooks_meeting_owner_jobs (
      deal_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, call_id TEXT NOT NULL,
      contact_id TEXT NOT NULL, email TEXT NOT NULL, rep_email TEXT NOT NULL,
      initial_owner TEXT NOT NULL, not_before BIGINT NOT NULL, next_check BIGINT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', target_owner TEXT, alerted_at TIMESTAMPTZ, last_error TEXT
    )`);
    await this.pool.query("CREATE INDEX IF NOT EXISTS nooks_owner_due ON nooks_meeting_owner_jobs(next_check) WHERE state='pending'");
  }
  async schedule(client, { dealId, workspaceId, callId, contactId, email, repEmail, initialOwner }) {
    const due = this.now() + DELAY;
    await client.query(`INSERT INTO nooks_meeting_owner_jobs
      (deal_id,workspace_id,call_id,contact_id,email,rep_email,initial_owner,not_before,next_check)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT DO NOTHING`,
    [String(dealId),workspaceId,callId,String(contactId),email,repEmail,String(initialOwner),due]);
  }
  async alert(client, job, code) {
    if (job.alerted_at || !this.notify) return;
    const hash = createHash('sha256').update(`nooks-owner:${job.deal_id}`).digest('hex');
    const messageId = `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
    await this.notify({ job, code, messageId });
    await client.query('UPDATE nooks_meeting_owner_jobs SET alerted_at=NOW() WHERE deal_id=$1', [job.deal_id]);
  }
  async tick() {
    const due = await this.pool.query(`SELECT deal_id FROM nooks_meeting_owner_jobs j
      WHERE state='pending' AND not_before <= $1 AND next_check <= $1
      AND EXISTS (SELECT 1 FROM nooks_meeting_deals d WHERE d.deal_id=j.deal_id AND d.verified_at IS NOT NULL)
      ORDER BY next_check LIMIT 25`, [this.now()]);
    for (const { deal_id: id } of due.rows) {
      const client = await this.pool.connect();
      let locked = false;
      try {
        locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`nooks-owner:${id}`])).rows[0]?.locked;
        if (!locked) continue;
        const job = (await client.query("SELECT * FROM nooks_meeting_owner_jobs WHERE deal_id=$1 AND state='pending' AND not_before <= $2 AND next_check <= $2", [id,this.now()])).rows[0];
        if (!job) continue;
        try {
          const read = () => this.request(`/crm/v3/objects/deals/${id}?properties=hubspot_owner_id`);
          const deal = await read();
          if (deal.archived || String(deal.id) !== id) throw new Error('nooks_deal_unavailable');
          if (job.target_owner && String(deal.properties?.hubspot_owner_id) === job.target_owner) {
            await client.query("UPDATE nooks_meeting_owner_jobs SET state='completed',last_error=NULL WHERE deal_id=$1", [id]);
            continue;
          }
          // Preserve a human's reassignment while this delayed job was waiting.
          if (String(deal.properties?.hubspot_owner_id || '') !== job.initial_owner) {
            await this.alert(client, job, 'nooks_deal_owner_changed');
            await client.query("UPDATE nooks_meeting_owner_jobs SET state='preserved',last_error='nooks_deal_owner_changed' WHERE deal_id=$1", [id]);
            continue;
          }
          const ownerId = String(await this.resolveMeetingOwner({ email: job.email, repEmail: job.rep_email }));
          if (!/^[1-9][0-9]*$/.test(ownerId)) throw new Error('nooks_meeting_owner_unverified');
          const beforeWrite = await read();
          if (beforeWrite.archived || String(beforeWrite.id) !== id || String(beforeWrite.properties?.hubspot_owner_id || '') !== job.initial_owner) throw new Error('nooks_deal_owner_changed');
          await client.query('UPDATE nooks_meeting_owner_jobs SET target_owner=$2 WHERE deal_id=$1', [id,ownerId]);
          await this.request(`/crm/v3/objects/deals/${id}`, {method:'PATCH',body:{properties:{hubspot_owner_id:ownerId}}});
          const updated = await read();
          if (updated.archived || String(updated.id) !== id || String(updated.properties?.hubspot_owner_id) !== ownerId) throw new Error('nooks_deal_owner_readback_failed');
          await client.query("UPDATE nooks_meeting_owner_jobs SET state='completed',last_error=NULL WHERE deal_id=$1", [id]);
        } catch (error) {
          const code = reason(error);
          await client.query('UPDATE nooks_meeting_owner_jobs SET next_check=$2,last_error=$3 WHERE deal_id=$1', [id,this.now()+60000,code]);
          try { await this.alert(client, job, code); }
          catch { this.logger.warn?.('nooks_owner_alert_retry', {dealId:id}); }
        }
      } finally {
        try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`nooks-owner:${id}`]); }
        finally { client.release(); }
      }
    }
  }
  start() {
    const run = async () => { try { await this.tick(); } catch { this.logger.warn?.('nooks_owner_worker_retry'); } };
    void run();
    this.timer = setInterval(run, 60000);
    this.timer.unref?.();
  }
}
module.exports = { NooksMeetingOwnerJobs, DELAY };
