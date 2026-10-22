const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Readable } = require('node:stream');
const { createDemoRouter, appliesToSubmission, readRegistry } = require('../demo-routing');
const { handleDemoRoutingRequest } = require('../demo-routing-http');
const { protectContact, protectDeal, reconcileRoutedSubmissions } = require('../demo-routing-assignment');

const registry = [{ ownerId: '40', calendlyUrl: 'https://calendly.com/account-owner/intro', slackUserId: 'UOWNER',
  hostUris: ['https://api.calendly.com/users/host'], eventTypeUris: ['https://api.calendly.com/event_types/intro'] }];
const environment = { DEMO_ROUTING_ENABLED: 'true', DEMO_ROUTING_ACTIVATED_AT: '2026-10-22T00:00:00Z',
  DEMO_ROUTING_INTERNAL_TOKEN: 'a'.repeat(32), DEMO_ROUTING_OWNERS_JSON: JSON.stringify(registry),
  DEMO_ROUTING_REGISTRY_VERIFIED: 'true', DEMO_ROUTING_WORKFLOWS_VERIFIED: 'true' };
const logger = { error() {}, info() {} };

function fixture(overrides = {}) {
  const state = {
    contact: { id: '10', properties: { email: 'person@bessemer.com', hubspot_owner_id: '99', demo_form_submission_datetime: '2026-10-23T00:00:00Z' } },
    companies: [{ id: '20' }],
    associations: { 'contacts/10/companies': ['20', '20'], 'contacts/10/deals': [], 'companies/20/deals': ['30', '30'], 'deals/30/contacts': ['10'] },
    deals: [{ id: '30', archived: false, properties: { pipeline: '105321581', dealstage: 'open', hubspot_owner_id: '40', hs_lastmodifieddate: '2026-10-20T00:00:00Z' } }],
    owner: { id: '40', archived: false, firstName: 'Deal', lastName: 'Owner' }, writes: [], ...overrides,
  };
  async function request(path, options = {}) {
    const method = options.method || 'GET';
    if (method === 'PATCH') {
      state.writes.push({ path, ...options });
      Object.assign(state.contact.properties, options.body.properties);
      return {};
    }
    if (method === 'PUT') { state.writes.push({ path, ...options }); return {}; }
    if (path === '/account-info/v3/details') return { portalId: 43974586 };
    if (path.endsWith('/contacts/search')) return { results: state.duplicateContacts ? [state.contact, state.contact] : state.contact ? [state.contact] : [] };
    if (path.endsWith('/companies/search')) return { results: state.companies };
    if (path.includes('/pipelines/')) return { stages: [{ id: 'open', metadata: { isClosed: 'false' } }, { id: 'won', metadata: { isClosed: 'true' } }] };
    if (path.endsWith('/deals/search')) return { results: state.deals };
    if (path.endsWith('/deals/batch/read')) return { results: state.deals.filter(d => options.body.inputs.some(i => i.id === d.id)) };
    if (path.startsWith('/crm/v3/owners/')) return { ...state.owner, id: path.split('/').at(-1) };
    const association = path.match(/\/crm\/v4\/objects\/(\w+)\/(\d+)\/associations\/(\w+)\?/);
    if (association) {
      const key = `${association[1]}/${association[2]}/${association[3]}`;
      return { results: (state.associations[key] || []).map(toObjectId => ({ toObjectId })) };
    }
    if (path.startsWith('/crm/v3/objects/contacts/10?')) return structuredClone(state.contact);
    const deal = path.match(/\/crm\/v3\/objects\/deals\/(\d+)\?/);
    if (deal) return structuredClone(state.deals.find(d => d.id === deal[1]));
    throw new Error(`unexpected request: ${method} ${path}`);
  }
  return { state, request, router: createDemoRouter({ request, env: { ...environment, ...overrides.env }, logger }) };
}

test('a new corporate contact resolves through its exact company domain without writing CRM', async () => {
  const { router, state } = fixture({ contact: null });
  const route = await router.resolve({ email: ' Person@Bessemer.COM ' });
  assert.equal(route.status, 'existing_deal');
  assert.equal(route.dealId, '30');
  assert.equal(route.companyId, '20');
  assert.equal(route.ownerId, '40');
  assert.equal(route.calendlyUrl, registry[0].calendlyUrl);
  assert.equal(state.writes.length, 0);
});

test('deal owner wins over an existing contact owner and ownership is read back', async () => {
  const { router, state } = fixture();
  const route = await router.alignContact({ email: state.contact.properties.email, contactId: '10' });
  assert.equal(route.ownerId, '40');
  assert.equal(state.contact.properties.hubspot_owner_id, '40');
  assert.equal(state.writes.filter(w => w.method === 'PATCH').length, 1);
  assert.ok(state.writes.some(w => w.path.includes('/associations/default/deals/30')));
  assert.ok(state.writes.every(w => !w.path.startsWith('/crm/v3/objects/companies') && !w.path.startsWith('/crm/v3/objects/deals')));
  await router.alignContact({ email: state.contact.properties.email, contactId: '10' });
  assert.equal(state.writes.filter(w => w.method === 'PATCH').length, 1);
});

test('latest modified open deal wins, ties use numeric IDs beyond safe integer range', async () => {
  const { router, state } = fixture();
  const original = state.deals[0];
  state.deals.push({ ...original, id: '90071992547409930', properties: { ...original.properties, hs_lastmodifieddate: '2026-10-21T00:00:00Z' } },
    { ...original, id: '90071992547409931', properties: { ...original.properties, hs_lastmodifieddate: '2026-10-21T00:00:00Z' } },
    { ...original, id: '99', properties: { ...original.properties, dealstage: 'won', hs_lastmodifieddate: '2026-10-24T00:00:00Z' } });
  state.associations['companies/20/deals'] = state.deals.map(d => d.id);
  assert.equal((await router.resolve({ email: state.contact.properties.email })).dealId, '90071992547409931');
});

test('closed or archived deals do not block new-lead behavior', async () => {
  for (const mode of ['closed', 'archived']) {
    const { state, router } = fixture();
    if (mode === 'closed') state.deals[0].properties.dealstage = 'won';
    else state.deals[0].archived = true;
    assert.equal((await router.resolve({ email: state.contact.properties.email })).status, 'no_open_deal');
  }
});

test('duplicate contacts and ambiguous company domains fail closed', async () => {
  const duplicate = fixture({ duplicateContacts: true });
  assert.equal((await duplicate.router.resolve({ email: 'person@bessemer.com' })).reason, 'ambiguous_contacts');
  const ambiguous = fixture({ contact: null, companies: [{ id: '20' }, { id: '21' }] });
  assert.equal((await ambiguous.router.resolve({ email: 'person@bessemer.com' })).reason, 'ambiguous_companies');
});

test('unavailable HubSpot, inactive owners, and missing calendars never become no-open-deal', async () => {
  const failure = createDemoRouter({ request: async () => { throw new Error('429'); }, env: environment, logger });
  assert.equal((await failure.resolve({ email: 'person@bessemer.com' })).status, 'unresolved');
  const inactive = fixture({ owner: { id: '40', archived: true } });
  assert.equal((await inactive.router.resolve({ email: 'person@bessemer.com' })).reason, 'inactive_deal_owner');
  const missing = fixture({ env: { DEMO_ROUTING_OWNERS_JSON: '[]' } });
  const route = await missing.router.resolve({ email: 'person@bessemer.com' });
  assert.equal(route.status, 'existing_deal');
  assert.equal(route.calendlyUrl, null);
  assert.equal(route.reason, 'missing_owner_mapping');
});

test('pagination deduplicates association IDs and batch read errors are unresolved', async () => {
  const f = fixture();
  let pages = 0;
  const router = createDemoRouter({ env: environment, logger, request: async (path, options) => {
    if (path.includes('/companies/20/associations/deals')) {
      pages++;
      return pages === 1 ? { results: [{ toObjectId: '30' }], paging: { next: { after: 'cursor' } } } : { results: [{ toObjectId: '30' }] };
    }
    return f.request(path, options);
  } });
  assert.equal((await router.resolve({ email: 'person@bessemer.com' })).dealId, '30');
  assert.equal(pages, 2);
  f.state.deals = [];
  assert.equal((await f.router.resolve({ email: 'person@bessemer.com' })).status, 'unresolved');
});

test('manual deal owner changes during alignment are re-resolved', async () => {
  const f = fixture();
  let changed = false;
  const router = createDemoRouter({ env: { ...environment, DEMO_ROUTING_OWNERS_JSON: JSON.stringify([...registry, { ...registry[0], ownerId: '41', hostUris: ['https://api.calendly.com/users/other'] }]) }, logger,
    request: async (path, options) => {
      const result = await f.request(path, options);
      if (options?.method === 'PATCH' && !changed) { changed = true; f.state.deals[0].properties.hubspot_owner_id = '41'; }
      return result;
    } });
  const result = await router.alignContact({ email: 'person@bessemer.com', contactId: '10' });
  assert.equal(result.ownerId, '41');
  assert.equal(f.state.contact.properties.hubspot_owner_id, '41');
});

test('future submission on an old contact is protected; historical submissions are untouched', async () => {
  const f = fixture();
  assert.ok(await protectContact(f.state.contact, f.router));
  f.state.contact.properties.demo_form_submission_datetime = '2026-10-21T00:00:00Z';
  assert.equal(await protectContact(f.state.contact, f.router), false);
  assert.equal(appliesToSubmission('2026-10-23T00:00:00Z', {}), false);
  const contacts = [];
  await reconcileRoutedSubmissions(f.router, { async searchAll(type, body) { contacts.push(body); return []; } });
  assert.equal(contacts[0].filterGroups[0].filters[0].propertyName, 'demo_form_submission_datetime');
});

test('removed-roster cleanup cannot change a deal used by a future submission', async () => {
  const f = fixture();
  assert.ok(await protectDeal('30', f.router, { async batchRead() { return new Map([['10', f.state.contact.properties]]); } }));
});

test('coverage blocks activation when any open-deal owner lacks a verified mapping', async () => {
  await fixture().router.validateCoverage();
  await assert.rejects(fixture({ env: { DEMO_ROUTING_OWNERS_JSON: '[]' } }).router.validateCoverage(), /coverage_incomplete/);
  await assert.rejects(fixture({ env: { DEMO_ROUTING_WORKFLOWS_VERIFIED: '' } }).router.validateCoverage(), /rollout_checks_required/);
  assert.throws(() => readRegistry({ DEMO_ROUTING_OWNERS_JSON: JSON.stringify([{ ...registry[0], calendlyUrl: 'https://evil.test/intro' }]) }), /invalid_owner_registry/);
});

async function http({ token = environment.DEMO_ROUTING_INTERNAL_TOKEN, body = { email: 'person@bessemer.com' }, router = fixture().router, env = environment } = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = 'POST'; req.headers = { authorization: `Bearer ${token}` };
  const res = { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
  await handleDemoRoutingRequest(req, res, { router, env, logger });
  return res;
}

test('internal resolver requires a dedicated credential and rejects malformed requests', async () => {
  assert.equal((await http({ token: 'wrong' })).status, 401);
  assert.equal((await http({ body: {} })).status, 400);
  assert.equal((await http({ env: { ...environment, DEMO_ROUTING_ENABLED: '' } })).status, 503);
  const result = await http();
  assert.equal(result.status, 200);
  assert.equal(result.body.ownerId, '40');
});

module.exports = { fixture, environment, registry };
