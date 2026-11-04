const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DemoRequestDeals, CONTACT_KEY_PROPERTY, COMPANY_KEY_PROPERTY, PIPELINE_ID, STAGE_ID } = require('../demo-request-deals');

function fixture({ company = true, openDeal = false, timeout = false, companyLinkFailure = false, sourceValue = 'inbound', leadSource = '' } = {}) {
  const calls = [], saved = [], deals = new Map();
  if (openDeal) deals.set('90', { id: '90', properties: { pipeline: PIPELINE_ID, dealstage: STAGE_ID, hs_lastmodifieddate: '2026-10-30T00:00:00Z', hubspot_owner_id: 'existing-owner' } });
  let failLink = companyLinkFailure;
  const request = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path === '/crm/v3/properties/contacts/lead_source') return { options: [
      { label: 'Inbound - Website (OLD)', value: 'PR', hidden: true },
      { label: 'Inbound - Website', value: 'Website Form Submit', hidden: false },
    ] };
    if (path === '/crm/v3/objects/contacts/1' && options.method === 'PATCH') return {};
    if (path === '/crm/v3/properties/deals/deal_source') return { options: [{ label: 'Inbound - Website', value: sourceValue }] };
    if (path.startsWith('/crm/v3/objects/contacts/1?')) return { id: '1', properties: { email: 'lead@gmail.com', firstname: 'Fixture', lastname: 'Lead', lead_source: leadSource } };
    if (path === `/crm/v3/properties/companies/${COMPANY_KEY_PROPERTY}`) return { name: COMPANY_KEY_PROPERTY, type: 'string', hasUniqueValue: true };
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
    if (path === '/crm/v3/objects/companies/2' && options.method === 'PATCH') return {};
    if (options.method === 'PATCH') { Object.assign(deals.get(path.split('/').pop()).properties, options.body.properties); return {}; }
    if (options.method === 'PUT') {
      if (failLink && path.endsWith('/companies/2')) { failLink = false; throw new Error('temporary association failure'); }
      return {};
    }
    throw new Error('Unexpected request ' + path);
  };
  const service = new DemoRequestDeals({ request });
  return { service, calls, saved, deals, ensure: (dealId) => service.ensure({ ownerId: '102500801', bookingUri: 'https://api.calendly.com/scheduled_events/fixture/invitees/fixture', contactId: '1', email: 'lead@gmail.com', dealId, saveDeal: async id => { saved.push(id); } }) };
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

test('missing company identity leaves creation pending instead of creating an orphan deal', async () => {
  const f = fixture({ company: false });
  await assert.rejects(f.ensure(), /company_required/);
  assert.ok(!f.calls.some(c => c.path === '/crm/v3/objects/deals' && c.method === 'POST'));
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

  assert.equal(f.deals.get('90').properties.hubspot_owner_id, 'existing-owner');
  assert.ok(!f.calls.some(c => c.path === '/crm/v3/objects/deals' && c.method === 'POST'));
  assert.ok(f.calls.some(c => c.path === '/crm/v4/objects/deals/90/associations/default/contacts/1'));
});

test('owner is set at creation and never patched on retries, even after manual removal', async () => {
  const f = fixture(); await f.ensure();
  assert.equal(f.deals.get('100').properties.hubspot_owner_id, '102500801');
  f.deals.get('100').properties.hubspot_owner_id = '';
  await f.ensure();
  assert.equal(f.deals.get('100').properties.hubspot_owner_id, '');
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

test('newly created company is linked to both the contact and the newly created deal', async () => {
  const f = fixture({ company: false }); const request = f.service.request;
  let company;
  f.service.request = async (path, options = {}) => {
    if (path.startsWith('/crm/v3/objects/contacts/1?')) return { id: '1', properties: { email: 'lead@example.business', company: 'Example Business' } };
    if (path === '/crm/v3/objects/companies/search') return { results: [] };
    if (path.includes('/crm/v3/objects/companies/') && path.includes('idProperty=')) {
      if (!company) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return company;
    }
    if (path === '/crm/v3/objects/companies' && options.method === 'POST') {
      company = { id: '200', properties: { ...options.body.properties } }; return company;
    }
    if (path.startsWith('/crm/v3/objects/companies/200?')) return company;
    if (path === '/crm/v3/objects/companies/200' && options.method === 'PATCH') return {};
    if (path.startsWith('/crm/v4/objects/companies/200/associations/deals?')) return { results: [] };
    return request(path, options);
  };
  const deal = await f.service.ensure({ ownerId: '102500801', bookingUri: 'https://api.calendly.com/scheduled_events/fixture/invitees/fixture', contactId: '1', email: 'lead@example.business', saveDeal: async id => f.saved.push(id) });
  assert.deepEqual(deal.company, { id: '200', name: 'Example Business' });
  const create = f.calls.find(c => c.path === '/crm/v3/objects/deals' && c.method === 'POST');
  assert.deepEqual(create.body.associations.map(a => a.to.id), ['1', '200']);
  assert.equal(create.body.properties.dealname, 'Example Business - Demo Request');
  assert.ok(f.calls.some(c => c.path === '/crm/v4/objects/contacts/1/associations/default/companies/200'));
  assert.ok(f.calls.some(c => c.path === '/crm/v4/objects/deals/100/associations/default/companies/200'));
});


test('linking a newly known company clears only the generated missing-company title and description', async () => {
  const f = fixture(); const request = f.service.request;
  f.deals.set('100', { id: '100', properties: {
    [CONTACT_KEY_PROPERTY]: '1', dealname: 'Fixture Lead - Demo Request [Company missing]',
    description: 'Created from a confirmed website demo booking. COMPANY MISSING: no company.',
  } });
  await f.ensure('100');
  assert.equal(f.deals.get('100').properties.dealname, 'Fixture Company - Demo Request');
  assert.equal(f.deals.get('100').properties.description, 'Created from a confirmed website demo booking.');
});

test('form alone cannot create a deal even with an owner', async () => {
  const f = fixture();
  await assert.rejects(f.service.ensure({ contactId:'1', email:'lead@gmail.com', ownerId:'89305622', saveDeal: async()=>{} }), /confirmed_booking_required/);
  assert.equal(f.calls.length,0);
});

test('verified booking repairs missing source only on the automation-owned deal', async () => {
  const f = fixture();
  f.deals.set('100', { id: '100', properties: { [CONTACT_KEY_PROPERTY]: '1' } });
  await f.ensure('100');
  assert.equal(f.deals.get('100').properties.deal_source, 'inbound');
  f.deals.get('100').properties.deal_source = 'Referral';
  await f.ensure('100');
  assert.equal(f.deals.get('100').properties.deal_source, 'Referral');
});

test('source uses the current HubSpot option value rather than a hard-coded legacy value', async () => {
  const f = fixture({ sourceValue: 'Inbound' });
  await f.ensure();
  assert.equal(f.deals.get('100').properties.deal_source, 'Inbound');
});

test('missing or ambiguous inbound option prevents writes rather than guessing', async () => {
  for (const options of [[], [{ label: 'Inbound - Website', value: 'inbound', hidden: true }],
    [{ label: 'Inbound - Website', value: 'one' }, { label: 'Inbound - Website', value: 'two' }]]) {
    const f = fixture(); const request = f.service.request;
    f.service.request = (path, args) => path === '/crm/v3/properties/deals/deal_source' ? { options } : request(path, args);
    await assert.rejects(f.ensure(), /inbound_source_unavailable/);
    assert.ok(!f.calls.some(call => ['POST', 'PUT', 'PATCH'].includes(call.method)));
  }
});

test('contact attribution uses Website Form Submit while deal attribution uses its own option', async () => {
  for (const leadSource of ['', 'PR']) {
    const f = fixture({ leadSource, sourceValue: 'deal-inbound' });
    await f.ensure();
    const update = f.calls.find(c => c.path === '/crm/v3/objects/contacts/1' && c.method === 'PATCH');
    assert.equal(update.body.properties.lead_source, 'Website Form Submit');
    assert.equal(f.deals.get('100').properties.deal_source, 'deal-inbound');
  }
});

test('confirmed website booking preserves existing nonlegacy contact attribution', async () => {
  const f = fixture({ leadSource: 'Referral' });
  await f.ensure();
  assert.ok(!f.calls.some(c => c.path === '/crm/v3/objects/contacts/1' && c.method === 'PATCH' && c.body.properties.lead_source));
});

test('prospect classification uses the verified internal HubSpot values', async () => {
  const f=fixture(); await f.ensure();
  assert.ok(f.calls.some(c => c.path === '/crm/v3/objects/contacts/1' && c.body?.properties.contact_type === 'Prospective Customer' && c.body.properties.hs_lead_status === 'MQL'));
  assert.ok(f.calls.some(c => c.path === '/crm/v3/objects/companies/2' && c.body?.properties.type === 'Company' && c.body.properties.hs_lead_status === 'OPEN_DEAL'));
});

test('existing customers retain their classifications', async () => {
  const calls=[];
  const service=new DemoRequestDeals({request:async(path,options)=>{
    calls.push({path,options});
    return {id:'2',properties:{lifecyclestage:'customer',type:'Company'}};
  }});
  await service.classify({id:'1',properties:{lifecyclestage:'customer',contact_type:'Customer'}},'2');
  assert.ok(calls.every(c=>c.options?.method !== 'PATCH'));
});

for (const reverse of [false, true]) {
  test(`company resolution selects the primary among ordinary associations (reverse=${reverse})`, async () => {
    const rows = [
      { toObjectId: '2', associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 279 }] },
      { toObjectId: '3', associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 279 }, { category: 'HUBSPOT_DEFINED', typeId: 1 }] },
    ];
    if (reverse) rows.reverse();
    const calls = [];
    const service = new DemoRequestDeals({ request: async path => {
      calls.push(path);
      if (path.includes('/associations/companies?')) return { results: rows };
      assert.equal(path, '/crm/v3/objects/companies/3?properties=name,domain');
      return { id: '3', properties: { name: 'Primary Company' } };
    } });
    assert.deepEqual(await service.company({ id: '1', properties: {} }), { id: '3', name: 'Primary Company' });
    assert.equal(calls.length, 2);
  });
}

for (const primaryCount of [0, 2]) {
  test(`company resolution leaves ambiguous associations for review (${primaryCount} primaries)`, async () => {
    const service = new DemoRequestDeals({ request: async path => {
      assert.ok(path.includes('/associations/companies?'), 'must not search, create, or pick a company');
      return { results: ['2', '3'].map(toObjectId => ({ toObjectId, associationTypes: [
        { category: 'HUBSPOT_DEFINED', typeId: 279 },
        ...(primaryCount ? [{ category: 'HUBSPOT_DEFINED', typeId: 1 }] : []),
      ] })) };
    } });
    assert.deepEqual(await service.company({ id: '1', properties: { email: 'lead@example.com' } }),
      { reason: 'multiple companies; primary company needs review' });
  });
}

test('company resolution retains a primary label across paginated duplicate associations', async () => {
  const service = new DemoRequestDeals({ request: async path => {
    if (path.includes('after=next')) return { results: [
      { toObjectId: '3', associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 279 }] },
      { toObjectId: '2', associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 279 }] },
    ] };
    if (path.includes('/associations/companies?')) return { results: [
      { toObjectId: '3', associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 1 }] },
    ], paging: { next: { after: 'next' } } };
    assert.equal(path, '/crm/v3/objects/companies/3?properties=name,domain');
    return { id: '3', properties: { name: 'Primary Company' } };
  } });
  assert.equal((await service.company({ id: '1', properties: {} })).id, '3');
});
