const PIPELINE_ID = '105321581';
const SUBMISSION_PROPERTY = 'demo_form_submission_datetime';
const PERSONAL_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'live.com', 'msn.com']);

function timestamp(value) {
  if (value === undefined || value === null || value === '') return NaN;
  return /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
}

function activationTime(env) {
  return timestamp(env.DEMO_ROUTING_ACTIVATED_AT);
}

function routingEnabled(env = process.env) {
  return env.DEMO_ROUTING_ENABLED === 'true' && Number.isFinite(activationTime(env));
}

function appliesToSubmission(value, env = process.env) {
  return routingEnabled(env) && timestamp(value) >= activationTime(env);
}

function readRegistry(env = process.env) {
  const rows = JSON.parse(env.DEMO_ROUTING_OWNERS_JSON || '[]');
  if (!Array.isArray(rows)) throw new Error('invalid_owner_registry');
  const registry = new Map();
  const hosts = new Set();
  for (const row of rows) {
    const url = new URL(row.calendlyUrl);
    if (!/^\d+$/.test(row.ownerId) || registry.has(row.ownerId)
      || url.protocol !== 'https:' || url.hostname !== 'calendly.com' || url.username || url.password
      || !/^\/[\w-]+\/[\w-]+\/?$/.test(url.pathname) || url.search || url.hash
      || !/^[UW][A-Z0-9]+$/.test(row.slackUserId)
      || !Array.isArray(row.hostUris) || !row.hostUris.length
      || !Array.isArray(row.eventTypeUris) || !row.eventTypeUris.length
      || row.hostUris.some(uri => !/^https:\/\/api\.calendly\.com\/users\/[\w-]+$/.test(uri))
      || row.eventTypeUris.some(uri => !/^https:\/\/api\.calendly\.com\/event_types\/[\w-]+$/.test(uri))) {
      throw new Error('invalid_owner_registry');
    }
    if (row.hostUris.some(uri => hosts.has(uri))) throw new Error('duplicate_calendar_host');
    for (const uri of row.hostUris) hosts.add(uri);
    registry.set(row.ownerId, Object.freeze({ ...row }));
  }
  return registry;
}

function createDemoRouter({ request, env = process.env, logger = console, now = Date.now }) {
  const registry = readRegistry(env);
  let pipelineCache;
  let pipelineExpires = 0;

  async function openStages() {
    if (pipelineCache && now() < pipelineExpires) return pipelineCache;
    const pipeline = await request(`/crm/v3/pipelines/deals/${PIPELINE_ID}`);
    if (!Array.isArray(pipeline.stages) || !pipeline.stages.length) throw new Error('invalid_pipeline_metadata');
    const stages = new Set();
    for (const stage of pipeline.stages) {
      const closed = stage.metadata?.isClosed;
      if (![true, false, 'true', 'false'].includes(closed)) throw new Error('invalid_pipeline_metadata');
      if (closed === false || closed === 'false') stages.add(String(stage.id));
    }
    pipelineCache = stages;
    pipelineExpires = now() + 300000;
    return stages;
  }

  async function search(type, property, value) {
    const result = await request(`/crm/v3/objects/${type}/search`, {
      method: 'POST', body: {
        filterGroups: [{ filters: [{ propertyName: property, operator: 'EQ', value }] }],
        properties: type === 'contacts' ? ['email', 'hubspot_owner_id', SUBMISSION_PROPERTY] : ['domain'], limit: 2,
      },
    });
    if (!Array.isArray(result.results)) throw new Error('invalid_search_response');
    if (result.paging?.next || result.total > 1 || result.results.length > 1) throw new Error(`ambiguous_${type}`);
    return result.results[0] || null;
  }

  async function associations(type, id, target) {
    const ids = new Set();
    const cursors = new Set();
    let after = '';
    do {
      const page = await request(`/crm/v4/objects/${type}/${id}/associations/${target}?limit=500${after ? `&after=${encodeURIComponent(after)}` : ''}`);
      if (!Array.isArray(page.results)) throw new Error('invalid_association_response');
      for (const row of page.results) {
        const associatedId = String(row.toObjectId);
        if (!/^\d+$/.test(associatedId)) throw new Error('invalid_association_response');
        ids.add(associatedId);
      }
      after = page.paging?.next?.after;
      if (after && cursors.has(String(after))) throw new Error('invalid_association_pagination');
      if (after) cursors.add(String(after));
    } while (after);
    return [...ids];
  }

  async function readDeals(ids) {
    const rows = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const page = await request('/crm/v3/objects/deals/batch/read', {
        method: 'POST', body: { properties: ['dealname', 'pipeline', 'dealstage', 'hubspot_owner_id', 'hs_lastmodifieddate'], inputs: chunk.map(id => ({ id })) },
      });
      if (!Array.isArray(page.results) || page.errors?.length || page.results.length !== chunk.length) throw new Error('incomplete_deal_read');
      rows.push(...page.results);
    }
    return rows;
  }

  async function resolve({ email, contactId, dealId }) {
    let context = {};
    try {
      const normalized = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || (contactId && !/^\d+$/.test(String(contactId)))) throw new Error('invalid_routing_input');
      // Always search by email, even when given an ID, to detect duplicate matches.
      let contact = await search('contacts', 'email', normalized);
      if (contactId && contact && String(contact.id) !== String(contactId)) throw new Error('contact_identity_mismatch');
      if (contactId && !contact) {
        contact = await request(`/crm/v3/objects/contacts/${contactId}?properties=email,hubspot_owner_id,${SUBMISSION_PROPERTY}`);
        if (String(contact.id) !== String(contactId) || String(contact.properties?.email).trim().toLowerCase() !== normalized) throw new Error('contact_identity_mismatch');
      }
      context = { contactId: contact ? String(contact.id) : null };
      let companyIds = contact ? await associations('contacts', contact.id, 'companies') : [];
      if (!companyIds.length) {
        const domain = normalized.split('@')[1];
        if (!PERSONAL_DOMAINS.has(domain)) {
          const company = await search('companies', 'domain', domain);
          if (company) companyIds = [String(company.id)];
        }
      }
      const dealCompanies = new Map();
      const ids = new Set(contact ? await associations('contacts', contact.id, 'deals') : []);
      for (const companyId of companyIds) {
        for (const id of await associations('companies', companyId, 'deals')) {
          ids.add(id);
          if (!dealCompanies.has(id)) dealCompanies.set(id, companyId);
        }
      }
      const stages = await openStages();
      const deals = (await readDeals([...ids])).filter(d => !d.archived && d.properties?.pipeline === PIPELINE_ID && stages.has(d.properties.dealstage));
      for (const deal of deals) {
        if (!/^\d+$/.test(String(deal.id)) || !Number.isFinite(timestamp(deal.properties.hs_lastmodifieddate))) throw new Error('invalid_deal_metadata');
      }
      deals.sort((a, b) => timestamp(b.properties.hs_lastmodifieddate) - timestamp(a.properties.hs_lastmodifieddate)
        || (BigInt(a.id) < BigInt(b.id) ? 1 : BigInt(a.id) > BigInt(b.id) ? -1 : 0));
      const deal = dealId ? deals.find(d => String(d.id) === String(dealId)) : deals[0];
      if (!deal) return { status: 'no_open_deal', reason: 'no_open_deal', ...context };
      const ownerId = String(deal.properties.hubspot_owner_id || '');
      context = { ...context, dealId: String(deal.id), companyId: dealCompanies.get(String(deal.id)) || null, ownerId,
        dealModifiedAt: deal.properties.hs_lastmodifieddate };
      if (!ownerId) throw new Error('missing_deal_owner');
      const owner = await request(`/crm/v3/owners/${ownerId}`);
      if (owner.archived !== false || String(owner.id) !== ownerId) throw new Error('inactive_deal_owner');
      const route = registry.get(ownerId);
      return { status: 'existing_deal', ...context, calendlyUrl: route?.calendlyUrl || null,
        slackUserId: route?.slackUserId || null, ownerName: `${owner.firstName || ''} ${owner.lastName || ''}`.trim(),
        reason: route ? 'latest_modified_open_deal' : 'missing_owner_mapping' };
    } catch (error) {
      // Only expose known categorical reasons. Provider error messages can contain CRM data.
      const reason = /^(ambiguous_|invalid_|inactive_|missing_|contact_identity|incomplete_)/.test(error.message) ? error.message : 'hubspot_lookup_failed';
      logger.error('demo_routing_unresolved', { reason, ...context });
      return { status: 'unresolved', reason, ...context };
    }
  }

  async function alignContact(input) {
    // A fresh resolution on every attempt makes manual deal-owner changes authoritative.
    for (let attempt = 0; attempt < 3; attempt++) {
      const route = await resolve(input);
      if (route.status !== 'existing_deal' || !route.contactId) return route;
      const current = await request(`/crm/v3/objects/deals/${route.dealId}?properties=hubspot_owner_id,dealstage,pipeline`);
      if (current.properties?.hubspot_owner_id !== route.ownerId || current.properties?.pipeline !== PIPELINE_ID || !(await openStages()).has(current.properties?.dealstage)) continue;
      if (route.companyId) await request(`/crm/v4/objects/contacts/${route.contactId}/associations/default/companies/${route.companyId}`, { method: 'PUT' });
      await request(`/crm/v4/objects/contacts/${route.contactId}/associations/default/deals/${route.dealId}`, { method: 'PUT' });
      const contact = await request(`/crm/v3/objects/contacts/${route.contactId}?properties=hubspot_owner_id`);
      if (contact.properties?.hubspot_owner_id !== route.ownerId) {
        await request(`/crm/v3/objects/contacts/${route.contactId}`, { method: 'PATCH', body: { properties: { hubspot_owner_id: route.ownerId } } });
        logger.info('demo_routing_owner_corrected', { contactId: route.contactId, dealId: route.dealId, ownerId: route.ownerId });
      }
      const verified = await request(`/crm/v3/objects/contacts/${route.contactId}?properties=hubspot_owner_id`);
      const fresh = await resolve(input);
      if (fresh.status === 'existing_deal' && fresh.dealId === route.dealId && fresh.ownerId === route.ownerId && verified.properties?.hubspot_owner_id === route.ownerId) return fresh;
    }
    throw new Error('demo_owner_changed_during_reconciliation');
  }

  async function validateCoverage() {
    if (!routingEnabled(env)) return;
    if ((await request('/account-info/v3/details')).portalId !== 43974586) throw new Error('demo_routing_portal_mismatch');
    if (!env.DEMO_ROUTING_INTERNAL_TOKEN || env.DEMO_ROUTING_INTERNAL_TOKEN.length < 32
      || env.DEMO_ROUTING_REGISTRY_VERIFIED !== 'true' || env.DEMO_ROUTING_WORKFLOWS_VERIFIED !== 'true') throw new Error('demo_routing_rollout_checks_required');
    const stages = await openStages();
    const ownerIds = new Set();
    let after;
    do {
      const page = await request('/crm/v3/objects/deals/search', { method: 'POST', body: {
        filterGroups: [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: PIPELINE_ID }] }],
        properties: ['dealstage', 'hubspot_owner_id'], limit: 100, ...(after ? { after } : {}),
      } });
      if (!Array.isArray(page.results) || page.total >= 10000) throw new Error('demo_routing_coverage_scan_incomplete');
      for (const deal of page.results) {
        if (!stages.has(deal.properties?.dealstage)) continue;
        const ownerId = String(deal.properties?.hubspot_owner_id || '');
        if (ownerId) ownerIds.add(ownerId);
        else logger.error('demo_routing_missing_deal_owner', { dealId: String(deal.id) });
      }
      after = page.paging?.next?.after;
    } while (after);
    for (const ownerId of ownerIds) {
      const owner = await request(`/crm/v3/owners/${ownerId}`);
      if (owner.archived === true) {
        logger.error('demo_routing_inactive_deal_owner', { ownerId });
        continue;
      }
      if (owner.archived !== false || String(owner.id) !== ownerId) throw new Error('demo_routing_owner_unverified');
      if (!registry.has(ownerId)) throw new Error('demo_routing_calendar_coverage_incomplete');
    }
  }

  return { resolve, alignContact, associations, readDeals, validateCoverage, registry, env };
}

module.exports = { createDemoRouter, readRegistry, routingEnabled, appliesToSubmission, activationTime, timestamp, SUBMISSION_PROPERTY };
