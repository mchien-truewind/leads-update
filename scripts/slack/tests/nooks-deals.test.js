const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NooksDeals, handleNooksDealRequest } = require('../nooks-deals');

function fixture() {
  const calls = [], ensured = [];
  const service = new NooksDeals({ env: { NOOKS_WORKSPACE_ID:'workspace', NOOKS_MEETING_DISPOSITION_IDS:'meeting' },
    pool: { async connect() { return { async query(sql) { calls.push(sql); return { rows:[{locked:true}] }; }, release() { calls.push('released'); } }; } },
    async request(path) {
      if (path.startsWith('/crm/v3/owners?')) return { results:[{id:'123',email:'ae@example.test',archived:false}] };
      if (path.includes('idProperty=email')) return {id:'10',properties:{email:'lead@example.test'}};
      throw new Error('Unexpected request');
    } });
  service.deals.ensure = async input => { ensured.push(input); return {id:'20'}; };
  const event = {event:'call.logged',callData:{workspaceId:'workspace',callId:'call',status:'completed',disposition:{id:'meeting'},prospectData:{email:'lead@example.test'},userData:{email:'ae@example.test'},accountData:{name:'Example'}}};
  return {service,event,calls,ensured};
}
test('booked meeting resolves rep by verified owner email and uses shared deal creation', async () => {
  const f=fixture();
  assert.deepEqual(await f.service.process(f.event),{status:'processed',dealId:'20'});
  assert.equal(f.ensured[0].ownerId,'123');
  assert.equal(f.ensured[0].companyName,'Example');
  assert.equal(f.calls.at(-1),'released');
});
test('ordinary calls are ignored; unmapped configuration and missing identity remain retryable', async () => {
  const f=fixture();
  f.event.callData.disposition.id='no-answer';
  assert.deepEqual(await f.service.process(f.event),{status:'ignored'});
  assert.equal(f.ensured.length,0);
  f.service.dispositions.clear();
  await assert.rejects(f.service.process(f.event),/dispositions_required/);
  f.service.dispositions.add('no-answer');
  f.event.callData.prospectData.email=null;
  await assert.rejects(f.service.process(f.event),/email_missing/);
});
test('unknown AE never falls back to a random owner', async () => {
  const f=fixture(); f.event.callData.userData.email='unknown@example.test';
  await assert.rejects(f.service.process(f.event),/owner_unresolved/);
  assert.equal(f.ensured.length,0); assert.equal(f.calls.at(-1),'released');
});
test('internal forwarding requires authentication and returns retry on CRM failure', async () => {
  let status;
  const res={writeHead(value){status=value;},end(){}};
  await handleNooksDealRequest({method:'POST',headers:{authorization:'Bearer wrong'}},res,{token:'secret',readBody:async()=>{throw new Error('must not read');}});
  assert.equal(status,401);
  await handleNooksDealRequest({method:'POST',headers:{authorization:'Bearer secret'}},res,{token:'secret',readBody:async()=>'{}',service:{process:async()=>{throw new Error('CRM down');}}});
  assert.equal(status,503);
});
