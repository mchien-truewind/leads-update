const crypto = require('node:crypto');
const { DemoRequestDeals } = require('./demo-request-deals');

class NooksDeals {
  constructor({ request, pool, resolveMeetingOwner, env = process.env }) {
    Object.assign(this, { request, pool, env, resolveMeetingOwner });
    this.dispositions = new Set((env.NOOKS_MEETING_DISPOSITION_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
    this.deals = new DemoRequestDeals({ request, sourceLabel: 'Outbound - Sales Sourced List' });
  }

  async initialize() {
    const activation = Date.parse(this.env.NOOKS_DEALS_ACTIVATED_AT || '');
    if (!Number.isFinite(activation) || activation <= 0) throw new Error('nooks_deal_activation_required');
    if (!this.dispositions.size) throw new Error('nooks_meeting_dispositions_required');
    await this.deals.initialize();
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nooks_meeting_deals (
      workspace_id TEXT NOT NULL, call_id TEXT NOT NULL, contact_id TEXT NOT NULL,
      deal_id TEXT, verified_at TIMESTAMPTZ,
      PRIMARY KEY(workspace_id,call_id)
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nooks_deal_activation (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), activated_at BIGINT NOT NULL
    )`);
    await this.pool.query('INSERT INTO nooks_deal_activation(singleton,activated_at) VALUES(1,$1) ON CONFLICT DO NOTHING', [activation]);
    const saved = (await this.pool.query('SELECT activated_at FROM nooks_deal_activation WHERE singleton=1')).rows[0];
    if (Number(saved?.activated_at) !== activation) throw new Error('nooks_deal_activation_changed');
  }

  async process(event) {
    const call = event.callData;
    if (event.event !== 'call.logged' || typeof call?.callId !== 'string' || !call.callId || call.workspaceId !== this.env.NOOKS_WORKSPACE_ID) throw new Error('nooks_event_identity_invalid');
    const dealsEnabled = this.env.NOOKS_DEALS_ENABLED === 'true';
    let eligible = false;
    if (dealsEnabled) {
      const activation = Date.parse(this.env.NOOKS_DEALS_ACTIVATED_AT || '');
      if (!Number.isFinite(activation) || activation <= 0) throw new Error('nooks_deal_activation_required');
      if (!this.dispositions.size) throw new Error('nooks_meeting_dispositions_required');
      if (call.status === 'completed' && this.dispositions.has(String(call.disposition?.id))) {
        const startedAt = Date.parse(call.startedAt || '');
        if (!Number.isFinite(startedAt)) throw new Error('nooks_meeting_time_required');
        eligible = startedAt >= activation;
      }
    }
    let logged;
    if (this.calls) {
      try { logged = await this.calls.process(event); }
      catch (error) {
        // An eligible meeting can create a missing contact before logging its
        // call. All other call failures keep the original durable receipt pending.
        if (!eligible || error.message !== 'nooks_contact_unresolved') throw error;
      }
    }
    if (logged?.stale || !eligible) return logged || {status:'ignored'};
    const result = await this.processMeeting(call);
    if (this.calls && !logged) logged = await this.calls.process(event);
    return { ...logged, ...result };
  }

  async processMeeting(call) {
    const email = String(call.prospectData?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('nooks_contact_or_owner_email_missing');
    const client = await this.pool.connect();
    let locked = false;
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`demo-submission:${email}`])).rows[0]?.locked;
      if (!locked) throw new Error('nooks_contact_busy');
      const lookup = async () => {
        try { return await this.request(`/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email&properties=email,company`); }
        catch (error) { if (error.statusCode === 404) return null; throw error; }
      };
      let contact = await lookup();
      if (!contact) {
        if (/^[1-9][0-9]*$/.test(String(call.prospectData?.prospectId || ''))) throw new Error('nooks_contact_identity_conflict');
        try {
          contact = await this.request('/crm/v3/objects/contacts', { method: 'POST', body: { properties: {
            email, ...(call.accountData?.name ? { company: call.accountData.name } : {}),
            contact_type: 'Prospective Customer', hs_lead_status: 'MQL',
          } } });
        } catch (error) { contact = await lookup(); if (!contact) throw error; }
      }
      if (contact.archived || !/^[1-9][0-9]*$/.test(String(contact.id))
        || String(contact.properties?.email || '').trim().toLowerCase() !== email) throw new Error('nooks_contact_identity_invalid');
      const prospectId = String(call.prospectData?.prospectId || '');
      if (/^[1-9][0-9]*$/.test(prospectId) && prospectId !== String(contact.id)) throw new Error('nooks_contact_identity_conflict');
      const key = [call.workspaceId,call.callId];
      await client.query('INSERT INTO nooks_meeting_deals(workspace_id,call_id,contact_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [...key,String(contact.id)]);
      const saved = (await client.query('SELECT * FROM nooks_meeting_deals WHERE workspace_id=$1 AND call_id=$2', key)).rows[0];
      if (saved?.contact_id !== String(contact.id)) throw new Error('nooks_meeting_contact_changed');
      const deal = await this.deals.ensure({ contactId: contact.id, email, companyName: call.accountData?.name,
        resolveOwner: async () => {
          if (!this.resolveMeetingOwner) throw new Error('nooks_meeting_owner_unavailable');
          return this.resolveMeetingOwner({ email, repEmail: call.userData?.email });
        }, dealId: saved.deal_id || undefined,
        saveDeal: async id => {
          await client.query('UPDATE nooks_meeting_deals SET deal_id=$3,verified_at=NULL WHERE workspace_id=$1 AND call_id=$2', [...key,String(id)]);
        } });
      await client.query('UPDATE nooks_meeting_deals SET verified_at=NOW() WHERE workspace_id=$1 AND call_id=$2', key);
      return { status: 'processed', dealId: deal.id };
    } finally {
      try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`demo-submission:${email}`]); }
      finally { client.release(); }
    }
  }
}

async function handleNooksDealRequest(req, res, { service, token, readBody }) {
  const supplied = String(req.headers.authorization || '');
  const expected = `Bearer ${token || ''}`;
  if (!token || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    res.writeHead(401); res.end(); return;
  }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  try {
    if (!service) throw new Error('nooks_processing_unavailable');
    const result = await service.process(JSON.parse(await readBody(req)));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  } catch (error) {
    const code = /^nooks_[a-z_]+$/.test(error.message || '') ? error.message : 'nooks_crm_or_storage_unavailable';
    console.warn(JSON.stringify({ event: 'nooks_sync_retry', code }));
    // The receiver keeps the durable event and retries; no false success.
    res.writeHead(503); res.end(JSON.stringify({ status: 'retry' }));
  }
}
module.exports = { NooksDeals, handleNooksDealRequest };
