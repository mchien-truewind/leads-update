const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DemoRequestDeals, CONTACT_KEY_PROPERTY, PIPELINE_ID, STAGE_ID } = require('../demo-request-deals');

function fixture({ company = true, openDeal = false, timeout = false, companyLinkFailure = false } = {}) {
  const calls = [], saved = [], deals = new Map();
  if (openDeal) deals.set('90', { id: '90', properties: { pipeline: PIPELINE_ID, dealstage: STAGE_ID, hs_lastmodifieddate: '2026-10-30T00:00:00Z', hubspot_owner_id: 'existing-owner' } });
  let failLink = companyLinkFailure;
  const request = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path.startsWith('/crm/v3/objects/contacts/1?')) return { id: '1', properties: { email: 'lead@gmail.com', firstname: 'Fixture', lastname: 'Lead' } };
    if (path === `/crm/v3/properties/deals/${CONTACT_KEY_PROPERTY}`) return { name: CONTACT_KEY_PROPERTY, type: 'string', hasUniqueValue: true };
    if (path === `/crm/v3/pipelines/deals/${PIPELINE_ID}`) return { stages: [{ id: STAGE_ID, metadata: { isClosed: 'false' } }] };
    if (path === '/automation/v4/flows/1901925124') return { isEnabled: false };
    if (path.startsWith('/crm/v4/objects/contacts/1/associations/companies?')) return { results: company ? [{ toObjectId: '2', associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 279 }] }] : [] };
    if (path.startsWith('/crm/v3/objects/companies/2?')) return { id: '2', properties: { name: 'Fixture Company', domain: 'fixture.example' } };
    if (/\/associations\/deals\?/.test(path)) return { results: openDeal ? [{ toObjectId: '90' }] : [] };
    if (path === '/crm/v3/objects/deals/batch/read') return { results: options.body.inputs.map(x => deals.get(x.id)) };
    if (path === '/crm/v3/objects/deals' && options.method === 'POST') {
      const props = options.body.properties;
      assert.ok(![...deals.values()].some(x => x.properties[CONTACT_KEY_PROPERTY] === props[CONTACT_KEY_PROPERTY]), 'unique property prevents duplicate creation');
      const deal = { id: '100', properties: { ...props } }; deals.set(deal.id, deal);
      if (timeout) throw new Error('response lost after successful create');
      return deal;
    }
    if (path.startsWith('/crm/v3/objects/deals/') && options.method !== 'PATCH') {
      const url = new URL('https://api.hubapi.com' + path), id = url.pathname.split('/').pop();
      const deal = url.searchParams.has('idProperty') ? [...deals.values()].find(x => x.properties[CONTACT_KEY_PROPERTY] === id) : deals.get(id);
      if (!deal) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return structuredClone(deal);
    }
    if (options.method === 'PATCH') { Object.assign(deals.get(path.split('/').pop()).properties, options.body.properties); return {}; }
    if (options.method === 'PUT') {
      if (failLink && path.endsWith('/companies/2')) { failLink = false; throw new Error('temporary association failure'); }
      return {};
    }
    throw new Error('Unexpected request ' + path);
  };
  const service = new DemoRequestDeals({ request });
  return { service, calls, saved, deals, ensure: (dealId) => service.ensure({ contactId: '1', email: 'lead@gmail.com', dealId, saveDeal: async id => { saved.push(id); } }) };
}

test('new demo request creates Discovery deal with atomic contact/company links and a unique retry key', async () => {
  const f = fixture(); await f.service.initialize();
  assert.equal((await f.ensure()).id, '100');
  const create = f.calls.find(c => c.method === 'POST' && c.path === '/crm/v3/objects/deals');
  assert.equal(create.body.properties.pipeline, PIPELINE_ID);
  assert.equal(create.body.properties.dealstage, STAGE_ID);
  assert.equal(create.body.properties[CONTACT_KEY_PROPERTY], '1');
  assert.deepEqual(create.body.associations.map(a => a.to.id), ['1', '2']);
  assert.deepEqual(f.saved, ['100']);
});

test('personal email with no company still creates a deal and visibly flags missing company', async () => {
  const f = fixture({ company: false }); const deal = await f.ensure();
  assert.match(deal.properties.dealname, /Company missing/);
  assert.match(deal.properties.description, /COMPANY MISSING/);
  assert.equal(f.calls.find(c => c.path === '/crm/v3/objects/deals' && c.method === 'POST').body.associations.length, 1);
  assert.ok(!f.calls.some(c => c.path === '/crm/v3/objects/companies' && c.method === 'POST'));
});

test('repeated requests and an ambiguous successful create reuse the same deal', async () => {
  const f = fixture({ timeout: true });
  assert.equal((await f.ensure()).id, '100');
  assert.equal((await f.ensure()).id, '100');
  assert.equal(f.calls.filter(c => c.path === '/crm/v3/objects/deals' && c.method === 'POST').length, 1);
});

test('association failure saves the deal first and recovers without another create', async () => {
  const f = fixture({ companyLinkFailure: true });
  await assert.rejects(f.ensure(), /association failure/);
  assert.deepEqual(f.saved, ['100']);
  assert.equal((await f.ensure(f.saved[0])).id, '100');
  assert.equal(f.calls.filter(c => c.path === '/crm/v3/objects/deals' && c.method === 'POST').length, 1);
});

test('existing open company opportunity is associated with the contact and its owner is preserved', async () => {
  const f = fixture({ openDeal: true });
  assert.equal((await f.ensure()).id, '90');
  await f.service.syncOwner('90', '1', 'new-owner');
  assert.equal(f.deals.get('90').properties.hubspot_owner_id, 'existing-owner');
  assert.ok(!f.calls.some(c => c.path === '/crm/v3/objects/deals' && c.method === 'POST'));
  assert.ok(f.calls.some(c => c.path === '/crm/v4/objects/deals/90/associations/default/contacts/1'));
});

test('created deal receives the assigned contact owner, but later manual owner edits are preserved', async () => {
  const f = fixture(); await f.ensure();
  await f.service.syncOwner('100', '1', 'assigned-owner');
  assert.equal(f.deals.get('100').properties.hubspot_owner_id, 'assigned-owner');
  await f.service.syncOwner('100', '1', 'other-owner');
  assert.equal(f.deals.get('100').properties.hubspot_owner_id, 'assigned-owner');
});

test('saved deal remains authoritative after sales closes it; resubmission does not reopen or duplicate it', async () => {
  const f = fixture(); await f.ensure();
  f.deals.get('100').properties.dealstage = 'closed';
  const deal = await f.ensure('100');
  assert.equal(deal.properties.dealstage, 'closed');
  assert.equal(f.deals.size, 1);
});

test('schema readiness rejects a non-unique property before enabling creation', async () => {
  const service = new DemoRequestDeals({ request: async () => ({ name: CONTACT_KEY_PROPERTY, type: 'string', hasUniqueValue: false }) });
  await assert.rejects(service.initialize(), /unique_property_required/);
});

test('initialization blocks a competing active demo deal workflow', async () => {
  const f = fixture(); const request = f.service.request;
  f.service.request = async (path, options) => path.startsWith('/automation/') ? { isEnabled: true } : request(path, options);
  await assert.rejects(f.service.initialize(), /conflicting_workflow/);
});

test('company resolution uses a unique corporate-domain match and rejects ambiguous matches', async () => {
  const f = fixture({ company: false }); const request = f.service.request;
  let ambiguous = false;
  f.service.request = async (path, options) => {
    if (path.startsWith('/crm/v3/objects/contacts/1?')) return { id: '1', properties: { email: 'lead@fixture.example' } };
    if (path === '/crm/v3/objects/companies/search') return { total: ambiguous ? 2 : 1, results: ambiguous
      ? [{ id: '2', properties: { name: 'Fixture', domain: 'fixture.example' } }, { id: '3', properties: { domain: 'fixture.example' } }]
      : [{ id: '2', properties: { name: 'Fixture', domain: 'fixture.example' } }] };
    return request(path, options);
  };
  const company = await f.service.company({ id: '1', properties: { email: 'lead@fixture.example' } });
  assert.equal(company.id, '2');
  ambiguous = true;
  const unresolved = await f.service.company({ id: '1', properties: { email: 'lead@fixture.example' } });
  assert.equal(unresolved.id, undefined);
  assert.match(unresolved.reason, /multiple/);
});

test('personal email can still match an explicitly provided company name', async () => {
  const f = fixture({ company: false }); const request = f.service.request;
  f.service.request = async (path, options) => {
    if (path === '/crm/v3/objects/companies/search') {
      assert.equal(options.body.filterGroups[0].filters[0].propertyName, 'name');
      return { results: [{ id: '2', properties: { name: 'Fixture Company' } }] };
    }
    return request(path, options);
  };
  assert.equal((await f.service.company({ id: '1', properties: { email: 'lead@gmail.com', company: 'Fixture Company' } })).id, '2');
});

test('company lookup failure never turns into a missing-company deal create', async () => {
  const f = fixture(); const request = f.service.request;
  f.service.request = async (path, options) => {
    if (path.includes('/associations/companies?')) throw new Error('HubSpot unavailable');
    return request(path, options);
  };
  await assert.rejects(f.ensure(), /unavailable/);
  assert.ok(!f.calls.some(c => c.path === '/crm/v3/objects/deals' && c.method === 'POST'));
});
