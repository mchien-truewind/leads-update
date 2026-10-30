const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DemoRequestDeals, COMPANY_KEY_PROPERTY } = require('../demo-request-deals');

function fixture({ timeout = false, failCreate = false, ambiguous = false } = {}) {
  const companies = new Map(), calls = [];
  const service = new DemoRequestDeals({ request: async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path.includes('/associations/companies?')) return { results: [] };
    if (path === '/crm/v3/objects/companies/search') return { results: ambiguous
      ? [{ id: '10', properties: { domain: 'example.business' } }, { id: '11', properties: { domain: 'example.business' } }] : [] };
    if (path.startsWith('/crm/v3/objects/companies/') && path.includes('idProperty=')) {
      const key = decodeURIComponent(new URL('https://api.hubapi.com' + path).pathname.split('/').pop());
      if (!companies.has(key)) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return structuredClone(companies.get(key));
    }
    if (path === '/crm/v3/objects/companies' && options.method === 'POST') {
      if (failCreate) throw new Error('write unavailable');
      const key = options.body.properties[COMPANY_KEY_PROPERTY];
      if (companies.has(key)) throw Object.assign(new Error('unique key conflict'), { statusCode: 409 });
      const created = { id: '200', properties: { ...options.body.properties } };
      companies.set(key, created);
      if (timeout) throw new Error('response lost after commit');
      return structuredClone(created);
    }
    throw new Error('Unexpected request ' + path);
  } });
  return { service, companies, calls };
}

test('creates a company from the submitted name and business domain', async () => {
  const f = fixture();
  const company = await f.service.company({ id: '1', properties: { email: 'lead@example.business', company: 'Example Business' } });
  assert.deepEqual(company, { id: '200', name: 'Example Business' });
  const properties = f.calls.find(c => c.method === 'POST' && c.path === '/crm/v3/objects/companies').body.properties;
  assert.equal(properties.domain, 'example.business');
  assert.equal(properties[COMPANY_KEY_PROPERTY], 'domain:example.business');
});

test('a business domain alone supplies a transparent company name', async () => {
  const f = fixture();
  assert.equal((await f.service.company({ id: '1', properties: { email: 'lead@example.business' } })).name, 'example.business');
});

test('personal email plus an explicit company name creates a name-only company', async () => {
  const f = fixture();
  assert.equal((await f.service.company({ id: '1', properties: { email: 'lead@gmail.com', company: 'Example Business' } })).id, '200');
  const properties = f.calls.find(c => c.path === '/crm/v3/objects/companies').body.properties;
  assert.equal(properties.domain, undefined);
  assert.equal(properties[COMPANY_KEY_PROPERTY], 'name:example business');
});

test('personal email without a company name does not invent a company', async () => {
  const f = fixture();
  assert.equal((await f.service.company({ id: '1', properties: { email: 'lead@gmail.com' } })).id, undefined);
  assert.ok(!f.calls.some(c => c.path === '/crm/v3/objects/companies'));
});

test('lost create response and another contact at the same domain reuse one company before search indexing', async () => {
  const f = fixture({ timeout: true });
  assert.equal((await f.service.company({ id: '1', properties: { email: 'one@example.business' } })).id, '200');
  assert.equal((await f.service.company({ id: '2', properties: { email: 'two@example.business' } })).id, '200');
  assert.equal(f.calls.filter(c => c.path === '/crm/v3/objects/companies' && c.method === 'POST').length, 1);
});

test('ambiguous existing matches are flagged rather than producing a third company', async () => {
  const f = fixture({ ambiguous: true });
  assert.match((await f.service.company({ id: '1', properties: { email: 'lead@example.business' } })).reason, /multiple/);
  assert.ok(!f.calls.some(c => c.path === '/crm/v3/objects/companies'));
});

test('failed company creation propagates so the durable worker retries', async () => {
  const f = fixture({ failCreate: true });
  await assert.rejects(f.service.company({ id: '1', properties: { email: 'lead@example.business' } }), /write unavailable/);
});


test('concurrent leads sharing a business domain recover unique-key conflicts', async () => {
  const f = fixture();
  const results = await Promise.all([
    f.service.company({ id: '1', properties: { email: 'one@example.business' } }),
    f.service.company({ id: '2', properties: { email: 'two@example.business' } }),
  ]);
  assert.deepEqual(results.map(c => c.id), ['200', '200']);
  assert.equal(f.companies.size, 1);
});
