const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const email = value => String(value || '').trim().toLowerCase();
const httpsUrl = value => {
  if (!value) return '';
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('nooks_url_invalid');
  return url.href;
};

// HubSpot collapses whitespace in rich-text HTML. Compare the preserved JSON
// details instead of requiring the server's HTML serialization to be identical.
function preservesCallDetails(body, call) {
  if (typeof body !== 'string') return false;
  const block = /<pre(?:\s[^>]*)?>([\s\S]*?)<\/pre>/i.exec(body);
  if (!block) return false;
  const entities = {quot:'"',apos:"'",lt:'<',gt:'>',amp:'&',nbsp:'\u00a0'};
  try {
    const text = block[1].replace(/&(#x[0-9a-f]+|#[0-9]+|quot|apos|lt|gt|amp|nbsp);/gi, (whole, value) => {
      if (value[0] !== '#') return entities[value.toLowerCase()];
      return String.fromCodePoint(value[1].toLowerCase() === 'x' ? parseInt(value.slice(2),16) : parseInt(value.slice(1),10));
    });
    return isDeepStrictEqual(JSON.parse(text), call);
  } catch { return false; }
}

class NooksCalls {
  constructor({ request, pool, env = process.env }) {
    Object.assign(this, { request, pool, env });
    this.mapping = JSON.parse(env.NOOKS_CALL_DISPOSITION_MAP || '{}');
    if (!this.mapping || Array.isArray(this.mapping) || typeof this.mapping !== 'object'
      || Object.values(this.mapping).some(x => typeof x !== 'string' || !x)) throw new Error('nooks_disposition_map_invalid');
  }

  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS nooks_call_sync (
      workspace_id TEXT NOT NULL, call_id TEXT NOT NULL, hubspot_call_id TEXT,
      create_claimed BOOLEAN NOT NULL DEFAULT FALSE, digest TEXT,
      ingress_sequence BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(workspace_id, call_id)
    )`);
  }

  async owners() {
    const owners = [], seen = new Set();
    let after;
    do {
      const page = await this.request(`/crm/v3/owners?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`);
      owners.push(...page.results);
      after = page.paging?.next?.after;
      if (after && seen.has(String(after))) throw new Error('nooks_owner_pagination_invalid');
      if (after) seen.add(String(after));
    } while (after);
    return owners;
  }

  async contact(call) {
    const prospect = call.prospectData || {}, address = email(prospect.email);
    let byId;
    if (/^[1-9][0-9]{0,24}$/.test(String(prospect.prospectId || ''))) {
      try { byId = await this.request(`/crm/v3/objects/contacts/${prospect.prospectId}?properties=email,hs_additional_emails&associations=companies`); }
      catch (error) { if (error.statusCode !== 404) throw error; }
    }
    let byEmail;
    if (address) {
      try { byEmail = await this.request(`/crm/v3/objects/contacts/${encodeURIComponent(address)}?idProperty=email&properties=email&associations=companies`); }
      catch (error) { if (error.statusCode !== 404) throw error; }
    }
    if (byId && address) {
      const addresses = [byId.properties?.email, ...(byId.properties?.hs_additional_emails || '').split(';')].map(email);
      if (!addresses.includes(address) || (byEmail && String(byId.id) !== String(byEmail.id))) throw new Error('nooks_contact_identity_conflict');
    }
    const result = byId || byEmail;
    if (!result || result.archived) throw new Error('nooks_contact_unresolved');
    return result;
  }

  async properties(call, contact) {
    const owners = (await this.owners()).filter(x => x.archived === false && email(x.email) === email(call.userData?.email) && email(x.email));
    if (owners.length > 1) throw new Error('nooks_owner_ambiguous');
    const outcomes = (await this.request('/calling/v1/dispositions')).filter(x => !x.deleted);
    // Nooks can carry the actual HubSpot disposition GUID. Never guess by label.
    const outcome = this.mapping[call.disposition?.id] || call.disposition?.id;
    const knownOutcome = outcomes.some(x => x.id === outcome);
    const warnings = [];
    if (!owners.length) warnings.push('HubSpot owner unresolved; Nooks rep details preserved below.');
    if (!knownOutcome) warnings.push('HubSpot outcome mapping missing; Nooks disposition preserved below.');
    const properties = {
      hs_timestamp: new Date(call.startedAt).toISOString(),
      hs_call_title: `[Nooks Call] - ${call.disposition?.name || 'Outcome unavailable'} - ${call.prospectData?.name || 'Call'}`.slice(0, 255),
      hs_call_status: 'COMPLETED', hs_call_direction: call.callDirection.toUpperCase(),
      hs_call_external_id: call.callId, hs_call_external_account_id: call.workspaceId,
      hs_call_callee_object_id: String(contact.id), hs_call_callee_object_type: 'CONTACT',
      hs_call_body: `<p>${escape(call.notes || '').replace(/\n/g, '<br>')}</p>`
        + warnings.map(x => `<p>${escape(x)}</p>`).join('')
        + `<pre>${escape(JSON.stringify(call, null, 2))}</pre>`,
    };
    if (call.durationSeconds != null) {
      if (typeof call.durationSeconds !== 'number' || !Number.isFinite(call.durationSeconds) || call.durationSeconds < 0) throw new Error('nooks_duration_invalid');
      properties.hs_call_duration = String(Math.round(call.durationSeconds * 1000));
    }
    if (knownOutcome) properties.hs_call_disposition = outcome;
    if (owners.length) properties.hubspot_owner_id = String(owners[0].id);
    if (call.recordingUrl) properties.hs_call_recording_url = httpsUrl(call.recordingUrl);
    if (call.transcriptUrl) properties.hs_call_body = `<p><a href="${escape(httpsUrl(call.transcriptUrl))}">Nooks transcript</a></p>` + properties.hs_call_body;
    if (properties.hs_call_body.length > 65536) throw new Error('nooks_call_details_too_large');
    const number = call.prospectData?.phoneNumber;
    if (number) properties[call.callDirection === 'inbound' ? 'hs_call_from_number' : 'hs_call_to_number'] = String(number);
    return properties;
  }

  async existingNative(call, contact) {
    // Native Nooks calls in this portal omit hs_call_external_id. Reconcile by
    // source, exact prospect association and provider start time before create.
    const stamp = Date.parse(call.startedAt);
    const page = await this.request('/crm/v3/objects/calls/search', {method:'POST',body:{
      filterGroups:[{filters:[
        {propertyName:'hs_object_source_detail_1',operator:'EQ',value:'Nooks'},
        {propertyName:'hs_timestamp',operator:'GTE',value:String(stamp-1000)},
        {propertyName:'hs_timestamp',operator:'LTE',value:String(stamp+1000)},
      ]}], properties:['hs_call_direction','hs_call_duration','hs_call_external_id'],limit:100,
    }});
    if (page.paging?.next) throw new Error('nooks_native_call_candidates_exceeded');
    const matches = [];
    for (const candidate of page.results) {
      const record = await this.request(`/crm/v3/objects/calls/${candidate.id}?associations=contacts`);
      if (!(record.associations?.contacts?.results || []).some(x => String(x.id) === String(contact.id))) continue;
      const p = candidate.properties;
      if ((p.hs_call_external_id && p.hs_call_external_id !== call.callId)
        || p.hs_call_direction !== call.callDirection.toUpperCase()
        || (call.durationSeconds != null && Math.abs(Number(p.hs_call_duration)-call.durationSeconds*1000) > 1000)) throw new Error('nooks_native_call_conflict');
      matches.push(String(candidate.id));
    }
    if (matches.length > 1) throw new Error('nooks_native_call_ambiguous');
    return matches[0];
  }

  async process(event) {
    const call = event.callData;
    if (event.event !== 'call.logged' || typeof call?.callId !== 'string' || !call.callId
      || call.workspaceId !== this.env.NOOKS_WORKSPACE_ID) throw new Error('nooks_event_identity_invalid');
    if (call.status !== 'completed') throw new Error('nooks_call_not_finalized');
    if (!['inbound','outbound'].includes(call.callDirection) || !Number.isFinite(Date.parse(call.startedAt))) throw new Error('nooks_call_metadata_invalid');
    const sequence = String(event.ingressSequence || '');
    if (!/^[1-9][0-9]{0,17}$/.test(sequence)) throw new Error('nooks_ingress_sequence_required');
    const digest = crypto.createHash('sha256').update(JSON.stringify(call)).digest('hex');
    const key = [call.workspaceId, call.callId];
    const client = await this.pool.connect();
    let locked = false;
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`nooks-call:${JSON.stringify(key)}`])).rows[0]?.locked;
      if (!locked) throw new Error('nooks_call_busy');
      await client.query('INSERT INTO nooks_call_sync(workspace_id,call_id) VALUES($1,$2) ON CONFLICT DO NOTHING', key);
      const row = (await client.query('SELECT * FROM nooks_call_sync WHERE workspace_id=$1 AND call_id=$2', key)).rows[0];
      if (row.hubspot_call_id && BigInt(sequence) < BigInt(row.ingress_sequence)) return {status:'processed',callId:row.hubspot_call_id};
      if (row.hubspot_call_id && row.digest === digest) {
        await client.query('UPDATE nooks_call_sync SET ingress_sequence=$3 WHERE workspace_id=$1 AND call_id=$2', [...key,sequence]);
        return {status:'processed',callId:row.hubspot_call_id};
      }
      const contact = await this.contact(call);
      const properties = await this.properties(call, contact);
      let id = row.hubspot_call_id;
      if (!id) {
        const found = await this.request('/crm/v3/objects/calls/search', {method:'POST',body:{
          filterGroups:[{filters:[{propertyName:'hs_call_external_id',operator:'EQ',value:call.callId}]}],
          properties:['hs_call_external_account_id'],limit:2,
        }});
        if (found.total > 1 || found.results.length > 1) throw new Error('nooks_existing_call_ambiguous');
        if (found.results.length) {
          const existing = found.results[0];
          if (existing.properties?.hs_call_external_account_id && existing.properties.hs_call_external_account_id !== call.workspaceId) throw new Error('nooks_existing_call_workspace_conflict');
          id = String(existing.id);
        } else if ((id = await this.existingNative(call, contact))) {
          // Bind the existing native activity instead of creating a duplicate.
        } else {
          // A timeout may mean the create succeeded. Read/search reconciliation
          // is safe; a second create is not. Hold pending until it is resolved.
          if (row.create_claimed) throw new Error('nooks_call_create_uncertain');
          await client.query('UPDATE nooks_call_sync SET create_claimed=TRUE WHERE workspace_id=$1 AND call_id=$2', key);
          try {
            const created = await this.request('/crm/v3/objects/calls', {method:'POST',body:{properties}});
            if (!created?.id) throw new Error('nooks_call_create_unconfirmed');
            id = String(created.id);
          } catch (error) {
            // Explicit rejections did not create a record and may be retried.
            if ([400,401,403,404,422,429].includes(error.statusCode)) await client.query('UPDATE nooks_call_sync SET create_claimed=FALSE WHERE workspace_id=$1 AND call_id=$2', key);
            throw error;
          }
        }
        await client.query('UPDATE nooks_call_sync SET hubspot_call_id=$3 WHERE workspace_id=$1 AND call_id=$2', [...key,id]);
      }
      await this.request(`/crm/v3/objects/calls/${id}`, {method:'PATCH',body:{properties}});
      await this.request(`/crm/v4/objects/calls/${id}/associations/default/contacts/${contact.id}`, {method:'PUT'});
      for (const company of contact.associations?.companies?.results || []) {
        await this.request(`/crm/v4/objects/calls/${id}/associations/default/companies/${company.id}`, {method:'PUT'});
      }
      const check = await this.request(`/crm/v3/objects/calls/${id}?properties=${Object.keys(properties).join(',')}`);
      for (const [name,value] of Object.entries(properties)) {
        const actual = check.properties?.[name];
        const matches = name === 'hs_call_body' ? preservesCallDetails(actual, call)
          : name === 'hs_timestamp' ? Date.parse(actual) === Date.parse(value) : String(actual) === value;
        if (!matches) throw new Error('nooks_call_readback_mismatch');
      }
      await client.query('UPDATE nooks_call_sync SET digest=$3,ingress_sequence=$4,updated_at=NOW() WHERE workspace_id=$1 AND call_id=$2', [...key,digest,sequence]);
      return {status:'processed',callId:id};
    } finally {
      try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`nooks-call:${JSON.stringify(key)}`]); }
      finally { client.release(); }
    }
  }
}
module.exports = { NooksCalls, preservesCallDetails };
