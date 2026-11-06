const { isUsableCompanyDomain } = require('./calendly_hubspot');
const { COMPANY_KEY_PROPERTY } = require('./demo-request-deals');

const FIELDS = ['name', 'domain', 'website', 'linkedin_company_page', 'industry', 'numberofemployees', 'annualrevenue',
  'phone', 'city', 'state', 'country', 'zip', 'description', 'founded_year'];
const blank = value => value === undefined || value === null || String(value).trim() === '';
const normalizedName = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const industryKey = value => normalizedName(value).replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

function domainOf(value) {
  try {
    const url = new URL(/^https?:\/\//i.test(String(value)) ? value : `https://${value}`);
    const domain = url.hostname.toLowerCase().replace(/^www\./, '');
    return !url.username && !url.password && !/^\d+(\.\d+){3}$/.test(domain) && isUsableCompanyDomain(domain) ? domain : '';
  } catch { return ''; }
}

function webUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : '';
  } catch { return ''; }
}

class ApolloCompanyEnricher {
  constructor({ request, apiKey, fetchImpl = fetch }) {
    Object.assign(this, { request, apiKey, fetchImpl });
    this.industries = new Map();
  }

  async initialize() {
    const property = await this.request('/crm/v3/properties/companies/industry');
    if (!Array.isArray(property.options)) throw new Error('apollo_company_industry_metadata_invalid');
    for (const option of property.options) {
      if (!option.hidden) {
        this.industries.set(industryKey(option.label), option.value);
        this.industries.set(industryKey(option.value), option.value);
      }
    }
  }

  async apollo(path, params, method = 'GET') {
    const url = new URL(`https://api.apollo.io/api/v1/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method, headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.timeout(10000),
      });
    } catch { throw new Error('apollo_company_request_failed'); }
    if (!response.ok) {
      const error = new Error(`apollo_company_http_${response.status}`);
      error.retryAfterMs = [401, 403].includes(response.status) ? 3600000
        : Math.min(3600000, Math.max(60000, Number(response.headers?.get('retry-after') || 0) * 1000));
      throw error;
    }
    try { return await response.json(); }
    catch { throw new Error('apollo_company_response_invalid'); }
  }

  async lookup(company) {
    let domain = domainOf(company.domain) || domainOf(company.website);
    let matchedId;
    if (!domain) {
      if (blank(company.name)) return {};
      const page = await this.apollo('mixed_companies/search', { q_organization_name: company.name, page: 1, per_page: 100 }, 'POST');
      if (!Array.isArray(page.organizations) && !Array.isArray(page.accounts)) throw new Error('apollo_company_search_invalid');
      const rows = [...(page.organizations || []), ...(page.accounts || []).map(row => ({
        ...row, id: row.organization_id, primary_domain: row.primary_domain || row.domain,
      }))];
      const unique = [...new Map(rows.map(row => [row.id || `${normalizedName(row.name)}:${domainOf(row.primary_domain)}`, row])).values()];
      const total = Number(page.pagination?.total_entries);
      if (page.partial_results_only || !Number.isFinite(total) || total > unique.length) return {};
      const matches = unique.filter(row => normalizedName(row.name) === normalizedName(company.name));
      if (matches.length !== 1) return {};
      domain = domainOf(matches[0].primary_domain) || domainOf(matches[0].website_url);
      matchedId = matches[0].id;
      if (!domain) return {};
    }
    const result = await this.apollo('organizations/enrich', { domain });
    if (!Object.hasOwn(result, 'organization')) throw new Error('apollo_company_response_invalid');
    const org = result.organization;
    if (!org || org.is_placeholder_organization) return {};
    if (matchedId && String(org.id) !== String(matchedId)) return {};
    if (domainOf(org.primary_domain) !== domain && domainOf(org.website_url) !== domain) return {};
    const properties = {};
    const put = (key, value) => { if (!blank(value)) properties[key] = String(value); };
    put('name', org.name);
    put('domain', domain);
    // Keep a matching website only; a cross-domain result needs review.
    if (domainOf(org.website_url) === domain) put('website', webUrl(org.website_url));
    if (/^https?:\/\/(www\.)?linkedin\.com\/company\//i.test(String(org.linkedin_url))) put('linkedin_company_page', webUrl(org.linkedin_url));
    put('industry', this.industries.get(industryKey(org.industry)));
    for (const [target, value] of [['numberofemployees', org.estimated_num_employees], ['annualrevenue', org.annual_revenue ?? org.organization_revenue]]) {
      if (Number.isFinite(Number(value)) && Number(value) > 0) put(target, Number(value));
    }
    put('phone', org.primary_phone?.number || org.phone);
    for (const name of ['city', 'state', 'country']) put(name, org[name]);
    put('zip', org.postal_code);
    put('description', org.short_description);
    if (Number.isInteger(Number(org.founded_year)) && Number(org.founded_year) > 1000 && Number(org.founded_year) <= 3000) put('founded_year', org.founded_year);
    return properties;
  }

  async enrich(companyId, cachedProperties, saveCache) {
    const path = `/crm/v3/objects/companies/${companyId}?properties=${[...FIELDS, COMPANY_KEY_PROPERTY].join(',')}`;
    const before = await this.request(path);
    if (String(before.id) !== String(companyId)) throw new Error('apollo_company_identity_invalid');
    if (before.archived) return 'archived';
    if (FIELDS.every(field => !blank(before.properties?.[field]))) return 'already_complete';
    let cached = cachedProperties;
    if (cached === null || cached === undefined) {
      const properties = await this.lookup(before.properties || {});
      cached = { properties, source: {
        domain: domainOf(before.properties?.domain) || domainOf(before.properties?.website),
        name: normalizedName(before.properties?.name),
      } };
      // Cache the normalized public company fields before any HubSpot write;
      // retries after a failed PATCH must not spend another Apollo credit.
      await saveCache(cached);
    }
    if (!cached.properties || !cached.source) throw new Error('apollo_company_cache_invalid');
    const candidates = cached.properties;
    const current = await this.request(path);
    if (String(current.id) !== String(companyId) || current.archived) return 'archived';
    const currentDomain = domainOf(current.properties?.domain) || domainOf(current.properties?.website);
    if ((cached.source.domain && currentDomain !== cached.source.domain)
      || (!cached.source.domain && (normalizedName(current.properties?.name) !== cached.source.name
        || (currentDomain && currentDomain !== candidates.domain)))) throw new Error('apollo_company_identity_changed');
    const properties = {};
    for (const field of FIELDS) {
      if (field === 'industry' && ![...this.industries.values()].includes(candidates[field])) continue;
      if (!blank(candidates[field]) && blank(current.properties?.[field])) properties[field] = candidates[field];
    }
    const domain = domainOf(current.properties?.domain);
    if (current.properties?.[COMPANY_KEY_PROPERTY]?.startsWith('domain:') && domain
      && normalizedName(current.properties.name) === domain && !blank(candidates.name)) properties.name = candidates.name;
    if (Object.keys(properties).length) await this.request(`/crm/v3/objects/companies/${companyId}`, { method: 'PATCH', body: { properties } });
    return Object.keys(candidates).length ? 'enriched' : 'no_verified_match';
  }
}

module.exports = { ApolloCompanyEnricher, FIELDS, domainOf };
