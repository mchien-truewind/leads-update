const crypto = require('node:crypto');
const { DemoRequestDeals } = require('./demo-request-deals');

class NooksDeals {
  constructor({ request, pool, env = process.env }) {
    Object.assign(this, { request, pool, env });
    this.dispositions = new Set((env.NOOKS_MEETING_DISPOSITION_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
    this.deals = new DemoRequestDeals({ request, sourceLabel: 'Outbound - Sales Sourced List' });
  }

  async process(event) {
    if (!this.dispositions.size) throw new Error('nooks_meeting_dispositions_required');
    const call = event.callData;
    if (event.event !== 'call.logged' || !call?.callId || call.workspaceId !== this.env.NOOKS_WORKSPACE_ID) throw new Error('nooks_event_identity_invalid');
    if (call.status !== 'completed' || !this.dispositions.has(String(call.disposition?.id))) return { status: 'ignored' };
    const email = String(call.prospectData?.email || '').trim().toLowerCase();
    const repEmail = String(call.userData?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !repEmail) throw new Error('nooks_contact_or_owner_email_missing');
    const client = await this.pool.connect();
    let locked = false;
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`demo-submission:${email}`])).rows[0]?.locked;
      if (!locked) throw new Error('nooks_contact_busy');
      const owners = [];
      let after;
      const cursors = new Set();
      do {
        const page = await this.request(`/crm/v3/owners?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
        owners.push(...page.results);
        after = page.paging?.next?.after;
        if (after && cursors.has(String(after))) throw new Error('nooks_owner_pagination_invalid');
        if (after) cursors.add(String(after));
      } while (after);
      const matches = owners.filter(x => x.archived === false && String(x.email).toLowerCase() === repEmail);
      if (matches.length !== 1) throw new Error('nooks_owner_unresolved');
      const lookup = async () => {
        try { return await this.request(`/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email&properties=email,company`); }
        catch (error) { if (error.statusCode === 404) return null; throw error; }
      };
      let contact = await lookup();
      if (!contact) {
        try {
          contact = await this.request('/crm/v3/objects/contacts', { method: 'POST', body: { properties: {
            email, ...(call.accountData?.name ? { company: call.accountData.name } : {}),
            contact_type: 'Prospective Customer', hs_lead_status: 'MQL', hubspot_owner_id: String(matches[0].id),
          } } });
        } catch (error) { contact = await lookup(); if (!contact) throw error; }
      }
      const deal = await this.deals.ensure({ contactId: contact.id, email, companyName: call.accountData?.name,
        ownerId: String(matches[0].id), saveDeal: async () => {} });
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
  } catch {
    // The receiver keeps the durable event and retries; no false success.
    res.writeHead(503); res.end(JSON.stringify({ status: 'retry' }));
  }
}
module.exports = { NooksDeals, handleNooksDealRequest };
