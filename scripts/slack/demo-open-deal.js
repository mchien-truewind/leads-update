// Read associations directly so a just-created form deal need not wait for
// HubSpot's search index before a Calendly booking can reuse it.
async function findOpenDemoDeal({ request, contactId, companyId, pipelineId }) {
  const ids = new Set();
  async function associated(type, id, target) {
    const found = new Set();
    if (!id) return [];
    let after;
    const seen = new Set();
    do {
      const page = await request(`/crm/v4/objects/${type}/${id}/associations/${target}?limit=500${after ? `&after=${encodeURIComponent(after)}` : ''}`);
      if (!Array.isArray(page.results)) throw new Error('invalid_demo_deal_associations');
      for (const row of page.results) {
        if (!/^\d+$/.test(String(row.toObjectId))) throw new Error('invalid_demo_deal_id');
        found.add(String(row.toObjectId));
      }
      after = page.paging?.next?.after;
      if (after != null && seen.has(String(after))) throw new Error('repeated_demo_deal_cursor');
      if (after != null) seen.add(String(after));
    } while (after != null);
    return [...found];
  }
  for (const id of await associated('contacts', contactId, 'deals')) ids.add(id);
  const companies = new Set(await associated('contacts', contactId, 'companies'));
  if (companyId) companies.add(String(companyId));
  for (const company of companies) {
    for (const id of await associated('companies', company, 'deals')) ids.add(id);
  }
  if (!ids.size) return null;
  const pipeline = await request(`/crm/v3/pipelines/deals/${pipelineId}`);
  if (!Array.isArray(pipeline.stages) || !pipeline.stages.length
    || pipeline.stages.some(stage => ![true, false, 'true', 'false'].includes(stage.metadata?.isClosed))) {
    throw new Error('invalid_demo_deal_pipeline');
  }
  const open = new Set(pipeline.stages.filter(stage => [false, 'false'].includes(stage.metadata.isClosed)).map(stage => String(stage.id)));
  const all = [...ids];
  const deals = [];
  for (let i = 0; i < all.length; i += 100) {
    const chunk = all.slice(i, i + 100);
    const page = await request('/crm/v3/objects/deals/batch/read', {
      method: 'POST', body: {
        properties: ['dealname', 'pipeline', 'dealstage', 'hubspot_owner_id', 'hs_lastmodifieddate', 'calendly_event_uri', 'calendly_invitee_uri'],
        inputs: chunk.map(id => ({ id })),
      },
    });
    if (!Array.isArray(page.results) || page.errors?.length
      || new Set(page.results.map(row => String(row.id))).size !== chunk.length
      || page.results.some(row => !chunk.includes(String(row.id)))) throw new Error('incomplete_demo_deal_read');
    deals.push(...page.results.filter(row => !row.archived && row.properties?.pipeline === pipelineId && open.has(row.properties.dealstage)));
  }
  if (deals.some(row => !Number.isFinite(Date.parse(row.properties.hs_lastmodifieddate)))) throw new Error('invalid_demo_deal_modified_time');
  deals.sort((a, b) => Date.parse(b.properties.hs_lastmodifieddate) - Date.parse(a.properties.hs_lastmodifieddate)
    || (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
  return deals[0] || null;
}

module.exports = { findOpenDemoDeal };
