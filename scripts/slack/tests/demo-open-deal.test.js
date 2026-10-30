const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findOpenDemoDeal } = require('../demo-open-deal');

const deal = (id, stage = 'open', modified = '2026-10-30T10:00:00Z') => ({
  id, properties: { pipeline: '123', dealstage: stage, hs_lastmodifieddate: modified, hubspot_owner_id: 'owner' },
});

function fixture(overrides = {}) {
  const calls = [];
  const routes = {
    '/crm/v4/objects/contacts/1/associations/companies?limit=500': { results: [{ toObjectId: '2' }] },
    '/crm/v4/objects/contacts/1/associations/deals?limit=500': { results: [{ toObjectId: '10' }], paging: { next: { after: 'next' } } },
    '/crm/v4/objects/contacts/1/associations/deals?limit=500&after=next': { results: [{ toObjectId: '11' }] },
    '/crm/v4/objects/companies/2/associations/deals?limit=500': { results: [{ toObjectId: '10' }, { toObjectId: '12' }] },
    '/crm/v3/pipelines/deals/123': { stages: [{ id: 'open', metadata: { isClosed: 'false' } }, { id: 'closed', metadata: { isClosed: 'true' } }] },
    '/crm/v3/objects/deals/batch/read': { results: [deal('10'), deal('11', 'closed'), deal('12', 'open', '2026-10-30T11:00:00Z')] },
    ...overrides,
  };
  return { calls, request: async (path, options) => {
    calls.push({ path, options });
    assert.ok(Object.hasOwn(routes, path), `Unexpected request: ${path}`);
    if (routes[path] instanceof Error) throw routes[path];
    return routes[path];
  } };
}

test('reuses newest open opportunity across paginated contact/company associations without writes', async () => {
  const f = fixture();
  assert.equal((await findOpenDemoDeal({ ...f, contactId: '1', companyId: '2', pipelineId: '123' })).id, '12');
  assert.deepEqual(f.calls.at(-1).options.body.inputs, [{ id: '10' }, { id: '11' }, { id: '12' }]);
  assert.ok(f.calls.every(c => !c.options || c.path.endsWith('/batch/read')));
});

test('returns no opportunity for closed, archived or other-pipeline deals', async () => {
  const f = fixture({ '/crm/v3/objects/deals/batch/read': { results: [deal('10', 'closed'), { ...deal('11'), archived: true }, { ...deal('12'), properties: { ...deal('12').properties, pipeline: 'other' } }] } });
  assert.equal(await findOpenDemoDeal({ ...f, contactId: '1', companyId: '2', pipelineId: '123' }), null);
});

test('an ownerless form deal is still reused', async () => {
  const f = fixture({ '/crm/v3/objects/deals/batch/read': { results: [deal('10', 'closed'), deal('11', 'closed'), { ...deal('12'), properties: { ...deal('12').properties, hubspot_owner_id: '' } }] } });
  assert.equal((await findOpenDemoDeal({ ...f, contactId: '1', companyId: '2', pipelineId: '123' })).id, '12');
});

test('no associations means a new opportunity may be created', async () => {
  const f = fixture({ '/crm/v4/objects/contacts/1/associations/deals?limit=500': { results: [] }, '/crm/v4/objects/contacts/1/associations/companies?limit=500': { results: [] } });
  assert.equal(await findOpenDemoDeal({ ...f, contactId: '1', pipelineId: '123' }), null);
  assert.equal(f.calls.length, 2);
});

test('uses the contact company even when the booking has no company information', async () => {
  const f = fixture();
  assert.equal((await findOpenDemoDeal({ ...f, contactId: '1', pipelineId: '123' })).id, '12');
});

test('provider failures and incomplete reads fail closed instead of allowing duplicate creation', async () => {
  for (const response of [new Error('provider failed'), { results: [deal('10')] }, { results: [deal('10'), deal('10'), deal('12')] }, { results: [deal('10'), deal('11'), deal('99')] }]) {
    const f = fixture({ '/crm/v3/objects/deals/batch/read': response });
    await assert.rejects(findOpenDemoDeal({ ...f, contactId: '1', companyId: '2', pipelineId: '123' }));
  }
});

test('bad pipeline metadata and looping pagination prevent a new deal', async () => {
  const bad = fixture({ '/crm/v3/pipelines/deals/123': { stages: [{ id: 'open', metadata: {} }] } });
  await assert.rejects(findOpenDemoDeal({ ...bad, contactId: '1', companyId: '2', pipelineId: '123' }), /pipeline/);
  const loop = fixture({ '/crm/v4/objects/contacts/1/associations/deals?limit=500&after=next': { results: [], paging: { next: { after: 'next' } } } });
  await assert.rejects(findOpenDemoDeal({ ...loop, contactId: '1', pipelineId: '123' }), /cursor/);
});
