const { findOpenDemoDeal } = require('./demo-open-deal');
const { getEmailDomain, isUsableCompanyDomain } = require('./calendly_hubspot');

const CONTACT_KEY_PROPERTY = 'truewind_demo_request_contact_id';
const COMPANY_KEY_PROPERTY = 'truewind_demo_company_key';
const PIPELINE_ID = '105321581';
const STAGE_ID = '1307720553';
const normalize = value => String(value || '').trim().toLowerCase();

class DemoRequestDeals {
  constructor({ request, logger = console, sourceLabel = 'Inbound - Website' }) { this.request = request; this.logger = logger; this.sourceLabel = sourceLabel; }

  async initialize() {
    const property = await this.request(`/crm/v3/properties/deals/${CONTACT_KEY_PROPERTY}`);
    if (property.name !== CONTACT_KEY_PROPERTY || property.type !== 'string' || property.hasUniqueValue !== true) {
      throw new Error('demo_request_unique_property_required');
    }
    const companyProperty = await this.request(`/crm/v3/properties/companies/${COMPANY_KEY_PROPERTY}`);
    if (companyProperty.name !== COMPANY_KEY_PROPERTY || companyProperty.type !== 'string' || companyProperty.hasUniqueValue !== true) {
      throw new Error('demo_request_unique_company_property_required');
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
      return await this.request(`/crm/v3/objects/deals/${encodeURIComponent(id)}?properties=${CONTACT_KEY_PROPERTY},hubspot_owner_id,dealname,description,deal_source,calendly_invitee_uri${unique ? `&idProperty=${CONTACT_KEY_PROPERTY}` : ''}`);
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
    // Match existing records before creating a company from an explicit name
    // or business email domain. Personal email domains are never companies.
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
    if (!name && !isUsableCompanyDomain(domain)) return { reason: 'no company name or business email domain' };
    const key = isUsableCompanyDomain(domain) ? `domain:${domain}` : `name:${normalize(name)}`;
    const path = `/crm/v3/objects/companies/${encodeURIComponent(key)}?idProperty=${COMPANY_KEY_PROPERTY}&properties=name,domain,${COMPANY_KEY_PROPERTY}`;
    const read = async () => {
      try { return await this.request(path); }
      catch (error) { if (error.statusCode === 404) return null; throw error; }
    };
    let created = await read();
    if (!created) {
      try {
        created = await this.request('/crm/v3/objects/companies', { method: 'POST', body: { properties: {
          name: name || domain, type: 'Company', hs_lead_status: 'NEW',
          ...(isUsableCompanyDomain(domain) ? { domain } : {}),
          [COMPANY_KEY_PROPERTY]: key,
        } } });
      } catch (error) {
        // Recover a committed create after a lost response or unique-key
        // conflict without depending on HubSpot search indexing.
        created = await read();
        if (!created) throw error;
      }
    }
    if (!/^\d+$/.test(String(created.id)) || created.archived || created.properties?.[COMPANY_KEY_PROPERTY] !== key) throw new Error('demo_request_created_company_invalid');
    return { id: String(created.id), name: created.properties.name || name || domain };
  }

  async inboundSourceValue(objectType = 'deals', propertyName = 'deal_source') {
    // HubSpot option labels and internal values are separate. Resolve the live
    // value so an administrator's option change cannot leave a stale code value.
    const property = await this.request(`/crm/v3/properties/${objectType}/${propertyName}`);
    const matches = (property.options || []).filter(option =>
      option.label === this.sourceLabel && option.hidden !== true && String(option.value || '').trim());
    if (matches.length !== 1) throw new Error('demo_request_inbound_source_unavailable');
    return matches[0].value;
  }

  async ensure({ contactId, email, dealId, saveDeal, companyName, bookingUri, ownerId }) {
    if ((this.sourceLabel === 'Inbound - Website' || bookingUri) && !/^https:\/\/api\.calendly\.com\/scheduled_events\/[\w-]+\/invitees\/[\w-]+$/.test(bookingUri || '')) throw new Error('demo_request_confirmed_booking_required');
    const inboundSource = await this.inboundSourceValue();
    const contact = await this.request(`/crm/v3/objects/contacts/${contactId}?properties=email,firstname,lastname,company,hubspot_owner_id,lead_source,contact_type,hs_lead_status,lifecyclestage`);
    if (String(contact.id) !== String(contactId) || contact.archived || normalize(contact.properties?.email) !== normalize(email)) throw new Error('demo_request_contact_identity_invalid');
    if (!String(contact.properties.company || '').trim() && String(companyName || '').trim()) {
      contact.properties = { ...contact.properties, company: String(companyName).trim() };
    }
    // The contact and deal properties have different option values. Replace
    // only blank/retired website attribution on this confirmed website booking.
    if (this.sourceLabel === 'Inbound - Website' && (!contact.properties.lead_source || contact.properties.lead_source === 'PR')) {
      const leadSource = await this.inboundSourceValue('contacts', 'lead_source');
      await this.request(`/crm/v3/objects/contacts/${contactId}`, {
        method: 'PATCH', body: { properties: { lead_source: leadSource } },
      });
    }
    const company = await this.company(contact);
    if (!company.id) throw new Error('demo_request_company_required: ' + company.reason);
    await this.classify(contact, company.id);
    let deal = dealId ? await this.readDeal(dealId) : await this.readDeal(contactId, true);
    if (!deal) deal = await findOpenDemoDeal({ request: this.request, contactId, companyId: company.id, pipelineId: PIPELINE_ID });
    let action = 'reused_existing_deal';
    if (!deal) {
      if (!/^\d+$/.test(String(ownerId || ''))) throw new Error('demo_request_owner_required');
      action = 'created';
      const name = company.name || [contact.properties.firstname, contact.properties.lastname].filter(Boolean).join(' ') || email;
      const properties = {
        dealname: `${name} - Demo Request`,
        hubspot_owner_id: String(ownerId),
        pipeline: PIPELINE_ID, dealstage: STAGE_ID,
        deal_source: inboundSource, ...(bookingUri ? { calendly_invitee_uri: bookingUri } : {}),
        [CONTACT_KEY_PROPERTY]: String(contactId),
        description: this.sourceLabel === 'Inbound - Website' ? 'Created from a confirmed website demo booking.' : 'Created from a Nooks booked meeting.',
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
        action = 'recovered_committed_create';
      }
    }
    if (!/^\d+$/.test(String(deal.id)) || deal.archived) throw new Error('demo_request_deal_unavailable');
    this.logger.info?.('demo_deal_creation', { action, contactId: String(contactId), dealId: String(deal.id), bookingUri, reason: this.sourceLabel === 'Inbound - Website' ? 'confirmed_website_booking' : 'nooks_booked_meeting' });
    await saveDeal(String(deal.id));
    // Only repair attribution on this automation's own opportunity, with the
    // booking evidence that authorized this run. Preserve manually set sources.
    if (deal.properties?.[CONTACT_KEY_PROPERTY] === String(contactId)) {
      const properties = {
        ...(!deal.properties.deal_source ? { deal_source: inboundSource } : {}),
        ...(bookingUri && !deal.properties.calendly_invitee_uri ? { calendly_invitee_uri: bookingUri } : {}),
      };
      if (Object.keys(properties).length) {
        await this.request(`/crm/v3/objects/deals/${deal.id}`, { method: 'PATCH', body: { properties } });
        deal.properties = { ...deal.properties, ...properties };
      }
    }

    await this.request(`/crm/v4/objects/deals/${deal.id}/associations/default/contacts/${contactId}`, { method: 'PUT' });
    if (company.id) {
      await this.request(`/crm/v4/objects/contacts/${contactId}/associations/default/companies/${company.id}`, { method: 'PUT' });
      await this.request(`/crm/v4/objects/deals/${deal.id}/associations/default/companies/${company.id}`, { method: 'PUT' });
      if (deal.properties?.[CONTACT_KEY_PROPERTY] === String(contactId)
        && deal.properties.dealname?.endsWith(' - Demo Request [Company missing]')
        && deal.properties.description?.startsWith('Created from a confirmed website demo booking. COMPANY MISSING:')) {
        const properties = { dealname: `${company.name} - Demo Request`, description: 'Created from a confirmed website demo booking.' };
        await this.request(`/crm/v3/objects/deals/${deal.id}`, { method: 'PATCH', body: { properties } });
        deal.properties = { ...deal.properties, ...properties };
      }
    }
    return { ...deal, id: String(deal.id), company: company.id ? company : null };
  }

  async classify(contact, companyId) {
    const contactProperties = contact.properties || {};
    const company = await this.request(`/crm/v3/objects/companies/${companyId}?properties=type,lifecyclestage,hs_current_customer,monday_is_current_customer`);
    const cp = company.properties || {};
    if (contactProperties.lifecyclestage !== 'customer' && contactProperties.contact_type !== 'Customer') {
      await this.request(`/crm/v3/objects/contacts/${contact.id}`, { method: 'PATCH', body: { properties: {
        contact_type: 'Prospective Customer', hs_lead_status: 'MQL',
      } } });
    }
    if (cp.lifecyclestage !== 'customer' && !['true', 'yes'].includes(String(cp.hs_current_customer).toLowerCase()) && String(cp.monday_is_current_customer) !== 'true') {
      await this.request(`/crm/v3/objects/companies/${companyId}`, { method: 'PATCH', body: { properties: {
        ...(!cp.type || cp.type === 'Company' ? { type: 'Company' } : {}), hs_lead_status: 'OPEN_DEAL',
      } } });
    }
  }
}

module.exports = { DemoRequestDeals, CONTACT_KEY_PROPERTY, COMPANY_KEY_PROPERTY, PIPELINE_ID, STAGE_ID };
