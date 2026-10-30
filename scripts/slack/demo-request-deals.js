const { findOpenDemoDeal } = require('./demo-open-deal');
const { getEmailDomain, isUsableCompanyDomain } = require('./calendly_hubspot');

const CONTACT_KEY_PROPERTY = 'truewind_demo_request_contact_id';
const PIPELINE_ID = '105321581';
const STAGE_ID = '1307720553';
const normalize = value => String(value || '').trim().toLowerCase();

class DemoRequestDeals {
  constructor({ request }) { this.request = request; }

  async initialize() {
    const property = await this.request(`/crm/v3/properties/deals/${CONTACT_KEY_PROPERTY}`);
    if (property.name !== CONTACT_KEY_PROPERTY || property.type !== 'string' || property.hasUniqueValue !== true) {
      throw new Error('demo_request_unique_property_required');
    }
    const pipeline = await this.request(`/crm/v3/pipelines/deals/${PIPELINE_ID}`);
    if (!pipeline.stages?.some(s => s.id === STAGE_ID && [false, 'false'].includes(s.metadata?.isClosed))) {
      throw new Error('demo_request_stage_unavailable');
    }
    const oldWorkflow = await this.request('/automation/v4/flows/1901925124');
    if (oldWorkflow.isEnabled !== false) throw new Error('demo_request_conflicting_workflow_enabled');
  }

  async readDeal(id, unique = false) {
    try {
      return await this.request(`/crm/v3/objects/deals/${encodeURIComponent(id)}?properties=${CONTACT_KEY_PROPERTY},hubspot_owner_id${unique ? `&idProperty=${CONTACT_KEY_PROPERTY}` : ''}`);
    } catch (error) {
      if (unique && error.statusCode === 404) return null;
      throw error;
    }
  }

  async company(contact) {
    const companies = new Map();
    let after;
    const seen = new Set();
    do {
      const page = await this.request(`/crm/v4/objects/contacts/${contact.id}/associations/companies?limit=500${after != null ? `&after=${encodeURIComponent(after)}` : ''}`);
      if (!Array.isArray(page.results)) throw new Error('demo_request_company_associations_invalid');
      for (const row of page.results) {
        if (!/^\d+$/.test(String(row.toObjectId))) throw new Error('demo_request_company_id_invalid');
        companies.set(String(row.toObjectId), companies.get(String(row.toObjectId)) || row.associationTypes?.some(t => t.category === 'HUBSPOT_DEFINED' && t.typeId === 279) || false);
      }
      after = page.paging?.next?.after;
      if (after != null && seen.has(String(after))) throw new Error('demo_request_company_cursor_repeated');
      if (after != null) seen.add(String(after));
    } while (after != null);
    const primary = [...companies].filter(([, isPrimary]) => isPrimary).map(([id]) => id);
    if (primary.length > 1 || (companies.size > 1 && !primary.length)) return { reason: 'multiple companies; primary company needs review' };
    const companyId = primary[0] || [...companies.keys()][0];
    if (companyId) {
      const company = await this.request(`/crm/v3/objects/companies/${companyId}?properties=name,domain`);
      if (company.archived || String(company.id) !== companyId) throw new Error('demo_request_company_unavailable');
      return { id: companyId, name: company.properties?.name || company.properties?.domain || 'Company' };
    }
    // Match an existing corporate company; do not invent a company from a
    // personal email address or create an unverified company record.
    const domain = getEmailDomain(contact.properties.email);
    if (isUsableCompanyDomain(domain)) {
      const page = await this.request('/crm/v3/objects/companies/search', {
        method: 'POST', body: { filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: domain }] }], properties: ['name', 'domain'], limit: 2 },
      });
      if (!Array.isArray(page.results)) throw new Error('demo_request_company_search_invalid');
      if (page.total > 1 || page.results.length > 1 || page.paging?.next) return { reason: 'multiple domain matches; company needs review' };
      const match = page.results[0];
      if (match) {
        if (!/^\d+$/.test(String(match.id)) || match.archived || normalize(match.properties?.domain) !== domain) throw new Error('demo_request_company_identity_invalid');
        return { id: String(match.id), name: match.properties?.name || domain };
      }
    }
    const name = String(contact.properties.company || '').trim();
    if (name) {
      const page = await this.request('/crm/v3/objects/companies/search', {
        method: 'POST', body: { filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: name }] }], properties: ['name', 'domain'], limit: 2 },
      });
      if (!Array.isArray(page.results)) throw new Error('demo_request_company_search_invalid');
      if (page.total > 1 || page.results.length > 1 || page.paging?.next) return { reason: 'multiple company name matches; company needs review' };
      const match = page.results[0];
      if (match) {
        if (!/^\d+$/.test(String(match.id)) || match.archived || normalize(match.properties?.name) !== normalize(name)) throw new Error('demo_request_company_identity_invalid');
        return { id: String(match.id), name: match.properties.name };
      }
    }
    return { reason: 'no associated or matching company record' };
  }

  async ensure({ contactId, email, dealId, saveDeal }) {
    const contact = await this.request(`/crm/v3/objects/contacts/${contactId}?properties=email,firstname,lastname,company,hubspot_owner_id`);
    if (String(contact.id) !== String(contactId) || contact.archived || normalize(contact.properties?.email) !== normalize(email)) throw new Error('demo_request_contact_identity_invalid');
    const company = await this.company(contact);
    let deal = dealId ? await this.readDeal(dealId) : await this.readDeal(contactId, true);
    if (!deal) deal = await findOpenDemoDeal({ request: this.request, contactId, companyId: company.id, pipelineId: PIPELINE_ID });
    if (!deal) {
      const name = company.name || [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(' ') || email;
      const properties = {
        dealname: `${name} - Demo Request${company.id ? '' : ' [Company missing]'}`,
        pipeline: PIPELINE_ID, dealstage: STAGE_ID,
        [CONTACT_KEY_PROPERTY]: String(contactId),
        description: `Created from a demo request.${company.id ? '' : ` COMPANY MISSING: ${company.reason}. Associate the correct company when available.`}`,
      };
      try {
        deal = await this.request('/crm/v3/objects/deals', {
          method: 'POST', body: { properties, associations: [
            { to: { id: String(contactId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] },
            ...(company.id ? [{ to: { id: company.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 341 }] }] : []),
          ] },
        });
      } catch (error) {
        // The unique contact property survives timeouts and process restarts.
        // A conflicting or ambiguously completed POST is recovered by direct
        // unique-property lookup rather than a lagging search index.
        deal = await this.readDeal(contactId, true);
        if (!deal) throw error;
      }
    }
    if (!/^\d+$/.test(String(deal.id)) || deal.archived) throw new Error('demo_request_deal_unavailable');
    await saveDeal(String(deal.id));
    await this.request(`/crm/v4/objects/deals/${deal.id}/associations/default/contacts/${contactId}`, { method: 'PUT' });
    if (company.id) {
      await this.request(`/crm/v4/objects/contacts/${contactId}/associations/default/companies/${company.id}`, { method: 'PUT' });
      await this.request(`/crm/v4/objects/deals/${deal.id}/associations/default/companies/${company.id}`, { method: 'PUT' });
    }
    return { ...deal, id: String(deal.id) };
  }

  async syncOwner(dealId, contactId, ownerId) {
    if (!dealId) return;
    const deal = await this.readDeal(dealId);
    if (deal.properties?.[CONTACT_KEY_PROPERTY] === String(contactId) && !deal.properties.hubspot_owner_id) {
      await this.request(`/crm/v3/objects/deals/${dealId}`, { method: 'PATCH', body: { properties: { hubspot_owner_id: String(ownerId) } } });
    }
  }
}

module.exports = { DemoRequestDeals, CONTACT_KEY_PROPERTY, PIPELINE_ID, STAGE_ID };
