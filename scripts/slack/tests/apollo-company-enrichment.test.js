const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ApolloCompanyEnricher, FIELDS } = require('../apollo-company-enrichment');
const { COMPANY_KEY_PROPERTY } = require('../demo-request-deals');

function fixture({ nameOnly = false, failPatch = false } = {}) {
  const company = { id: '200', properties: { name: nameOnly ? 'Example Business' : 'example.business',
    ...(nameOnly ? {} : { domain: 'example.business' }),
    [COMPANY_KEY_PROPERTY]: nameOnly ? 'name:example business' : 'domain:example.business' } };
  const org = { id: 'org-1', name: 'Example Business', primary_domain: 'example.business', website_url: 'https://example.business',
    linkedin_url: 'https://www.linkedin.com/company/example', industry: 'computer software', estimated_num_employees: 100,
    annual_revenue: 2000000, phone: '+1-555-0100', city: 'San Francisco', state: 'California', country: 'United States',
    postal_code: '94101', short_description: 'Business software.', founded_year: 2010 };
  const calls = [], patches = []; let cached, fail = failPatch;
  const f = { company, org, calls, patches,
    search: { organizations: [{ ...org }], accounts: [], pagination: { total_entries: 1 } },
    onApollo() {},
  };
  const service = new ApolloCompanyEnricher({ apiKey: 'fixture-key',
    request: async (path, options = {}) => {
      if (path.endsWith('/industry')) return { options: [{ label: 'Computer Software', value: 'COMPUTER_SOFTWARE' }] };
      if (options.method === 'PATCH') {
        patches.push(options.body.properties);
        if (fail) { fail = false; throw new Error('HubSpot unavailable'); }
        Object.assign(company.properties, options.body.properties); return {};
      }
      return structuredClone(company);
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options }); f.onApollo();
      return Response.json(url.includes('/mixed_companies/search') ? f.search : { organization: f.org });
    },
  });
  f.service = service;
  f.run = async () => { await service.initialize(); return service.enrich('200', cached, async value => { cached = structuredClone(value); }); };
  f.cache = () => cached;
  return f;
}

test('enriches blank HubSpot fields and resolves a generated domain-only company name', async () => {
  const f = fixture(); assert.equal(await f.run(), 'enriched');
  assert.equal(f.company.properties.name, 'Example Business');
  assert.equal(f.company.properties.website, 'https://example.business/');
  assert.equal(f.company.properties.linkedin_company_page, 'https://www.linkedin.com/company/example');
  assert.equal(f.company.properties.industry, 'COMPUTER_SOFTWARE');
  assert.equal(f.company.properties.numberofemployees, '100');
  assert.equal(f.company.properties.annualrevenue, '2000000');
  assert.equal(f.company.properties.city, 'San Francisco');
  assert.equal(f.calls[0].options.headers['X-Api-Key'], 'fixture-key');
  assert.ok(!f.calls[0].url.includes('fixture-key'));
});

test('re-reads after Apollo so manually maintained values and edits during lookup are preserved', async () => {
  const f = fixture();
  f.company.properties.phone = 'Curated phone';
  f.onApollo = () => { f.company.properties.name = 'Curated Name'; f.company.properties.city = 'Seattle'; };
  await f.run();
  assert.equal(f.company.properties.phone, 'Curated phone');
  assert.equal(f.company.properties.name, 'Curated Name');
  assert.equal(f.company.properties.city, 'Seattle');
  assert.equal(f.patches[0].name, undefined);
});

test('failed HubSpot write reuses cached Apollo data without another paid lookup', async () => {
  const f = fixture({ failPatch: true });
  await assert.rejects(f.run(), /HubSpot unavailable/);
  assert.ok(f.cache().properties.website);
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.company.properties.website, 'https://example.business/');
});

test('name-only lookup supports saved Apollo accounts and fills a verified domain', async () => {
  const f = fixture({ nameOnly: true });
  f.search = { accounts: [{ name: 'Example Business', organization_id: 'org-1', primary_domain: 'example.business' }], organizations: [], pagination: { total_entries: 1 } };
  await f.run();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].options.method, 'POST');
  assert.equal(f.company.properties.domain, 'example.business');
});

test('ambiguous, partial or incomplete name search results never become a domain guess', async () => {
  for (const search of [
    { organizations: [{ name: 'Example Business', primary_domain: 'one.business' }, { name: 'Example Business', primary_domain: 'two.business' }], pagination: { total_entries: 2 } },
    { organizations: [{ name: 'Example Business', primary_domain: 'one.business' }], pagination: { total_entries: 200 } },
    { organizations: [{ name: 'Other Example Business', primary_domain: 'one.business' }], pagination: { total_entries: 1 } },
    { organizations: [{ name: 'Example Business', primary_domain: 'one.business' }], pagination: { total_entries: 1 }, partial_results_only: true },
  ]) {
    const f = fixture({ nameOnly: true }); f.search = search;
    assert.equal(await f.run(), 'no_verified_match');
    assert.equal(f.calls.length, 1);
    assert.equal(f.patches.length, 0);
  }
});

test('a mismatching Apollo organization does not update the company', async () => {
  const f = fixture(); f.org.primary_domain = 'different.business'; f.org.website_url = 'https://different.business';
  assert.equal(await f.run(), 'no_verified_match');
  assert.equal(f.patches.length, 0);
});

test('company identity changes invalidate the cache instead of applying stale firmographics', async () => {
  const f = fixture(); f.onApollo = () => { f.company.properties.domain = 'different.business'; };
  await assert.rejects(f.run(), /identity_changed/);
  assert.equal(f.patches.length, 0);
});

test('complete records do not spend Apollo credits', async () => {
  const f = fixture(); for (const field of FIELDS) f.company.properties[field] = 'Already known';
  assert.equal(await f.run(), 'already_complete');
  assert.equal(f.calls.length, 0);
});

test('unknown industry and invalid numeric fields are omitted from the HubSpot write', async () => {
  const f = fixture(); f.org.industry = 'Unmapped Industry'; f.org.annual_revenue = 'unknown'; f.org.estimated_num_employees = -1;
  await f.run();
  assert.equal(f.patches[0].industry, undefined);
  assert.equal(f.patches[0].annualrevenue, undefined);
  assert.equal(f.patches[0].numberofemployees, undefined);
});

test('rate limits return a safe retry delay and never cache a provider error', async () => {
  const f = fixture(); f.service.fetchImpl = async () => new Response('{}', { status: 429, headers: { 'retry-after': '120' } });
  await assert.rejects(f.run(), error => error.message === 'apollo_company_http_429' && error.retryAfterMs === 120000);
  assert.equal(f.cache(), undefined);
  assert.equal(f.patches.length, 0);
});
