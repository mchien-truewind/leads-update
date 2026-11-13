const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NooksDeals, handleNooksDealRequest } = require('../nooks-deals');

function fixture() {
  const queries=[],ensured=[],rows=new Map(),contactCreates=[];let activation;let existing=true;
  const client={async query(sql,args=[]){
    queries.push(sql);
    if(sql.includes('advisory'))return {rows:[{locked:true}]};
    if(sql.startsWith('INSERT INTO nooks_meeting_deals')){const key=args.slice(0,2).join(':');if(!rows.has(key))rows.set(key,{contact_id:args[2],deal_id:null});}
    if(sql.startsWith('SELECT * FROM nooks_meeting_deals'))return {rows:[{...rows.get(args.join(':'))}]};
    if(sql.includes('SET deal_id=$3'))rows.get(args.slice(0,2).join(':')).deal_id=args[2];
    if(sql.includes('SET verified_at=NOW()'))rows.get(args.join(':')).verified=true;
    if(sql.startsWith('INSERT INTO nooks_deal_activation')&&activation===undefined)activation=args[0];
    if(sql.startsWith('SELECT activated_at'))return {rows:[{activated_at:activation}]};
    return {rows:[]};
  },release(){queries.push('released');}};
  const env={NOOKS_DEALS_ENABLED:'true',NOOKS_WORKSPACE_ID:'workspace',NOOKS_MEETING_DISPOSITION_IDS:'meeting,hubspot-meeting',NOOKS_DEALS_ACTIVATED_AT:'2026-11-11T00:00:00Z'};
  const service=new NooksDeals({env,resolveMeetingOwner:async()=> '456',pool:{connect:async()=>client,query:(...args)=>client.query(...args)},async request(path,options={}){
    if(path.startsWith('/crm/v3/owners?'))return {results:[{id:'123',email:'ae@example.test',archived:false}]};
    if(path.includes('idProperty=email')){if(!existing)throw Object.assign(new Error('not found'),{statusCode:404});return {id:'10',properties:{email:'lead@example.test'}};}
    if(path==='/crm/v3/objects/contacts'&&options.method==='POST'){contactCreates.push(options.body.properties);existing=true;return {id:'10',properties:{email:'lead@example.test'}};}
    throw new Error('Unexpected request '+path);
  }});
  service.deals.initialize=async()=>{};
  service.deals.ensure=async input=>{input.ownerId=await input.resolveOwner();ensured.push(input);await input.saveDeal('20');return {id:'20',company:{id:'30'}};};
  const event={event:'call.logged',callData:{workspaceId:'workspace',callId:'call',startedAt:'2026-11-11T01:00:00Z',status:'completed',disposition:{id:'meeting'},prospectData:{email:'lead@example.test'},userData:{email:'ae@example.test'},accountData:{name:'Example'}}};
  return {service,event,queries,ensured,rows,contactCreates,set missingContact(value){existing=!value;}};
}
test('booked meeting initially resolves booking SDR, uses shared inbound helper with outbound source and saves verified receipt',async()=>{
  const f=fixture();await f.service.initialize();
  assert.deepEqual(await f.service.process(f.event),{status:'processed',dealId:'20'});
  assert.equal(f.service.deals.sourceLabel,'Outbound - SDR');assert.equal(f.ensured[0].ownerId,'123');assert.equal(f.ensured[0].companyName,'Example');assert.equal(f.rows.get('workspace:call').verified,true);assert.equal(f.queries.at(-1),'released');
});
test('both actual Nooks and HubSpot meeting IDs trigger; names alone never trigger',async()=>{
  for(const id of ['meeting','hubspot-meeting']){const f=fixture();f.event.callData.disposition.id=id;assert.equal((await f.service.process(f.event)).dealId,'20');}
  const f=fixture();f.event.callData.disposition={id:'not-meeting',name:'Meeting Booked'};assert.deepEqual(await f.service.process(f.event),{status:'ignored'});assert.equal(f.ensured.length,0);
});
test('historical receipts and incomplete calls do not create deals; call logging still runs',async()=>{
  for(const mutate of [e=>e.callData.startedAt='2026-11-10T23:59:59Z',e=>e.callData.status='in-progress',e=>e.callData.disposition.id='no-answer']){
    const f=fixture();mutate(f.event);let logged=0;f.service.calls={process:async()=>{logged++;return {status:'processed',callId:'99'};}};
    assert.equal((await f.service.process(f.event)).callId,'99');assert.equal(f.ensured.length,0);assert.equal(logged,1);
  }
});
test('disabled deals preserve call-only mode',async()=>{
  const f=fixture();f.service.env.NOOKS_DEALS_ENABLED='false';f.service.calls={process:async()=>({status:'processed',callId:'99'})};
  assert.deepEqual(await f.service.process(f.event),{status:'processed',callId:'99'});assert.equal(f.ensured.length,0);
});
test('activation and disposition configuration are required and activation cannot move on restart',async()=>{
  const f=fixture();await f.service.initialize();f.service.env.NOOKS_DEALS_ACTIVATED_AT='2026-11-12T00:00:00Z';await assert.rejects(f.service.initialize(),/activation_changed/);
  f.service.env.NOOKS_DEALS_ACTIVATED_AT='';await assert.rejects(f.service.process(f.event),/activation_required/);
  f.service.env.NOOKS_DEALS_ACTIVATED_AT='2026-11-11T00:00:00Z';f.service.dispositions.clear();await assert.rejects(f.service.process(f.event),/dispositions_required/);
});
test('missing timestamps, mismatched workspace and missing email fail without deal writes',async()=>{
  for(const mutate of [e=>delete e.callData.startedAt,e=>e.callData.workspaceId='other',e=>e.callData.prospectData.email=null]){
    const f=fixture();mutate(f.event);await assert.rejects(f.service.process(f.event));assert.equal(f.ensured.length,0);
  }
});
test('a lost response after deal save recovers the same saved deal on retry',async()=>{
  const f=fixture();let first=true;const ensure=f.service.deals.ensure;
  f.service.deals.ensure=async input=>{const deal=await ensure(input);if(first){first=false;throw new Error('association readback failed');}return deal;};
  await assert.rejects(f.service.process(f.event),/readback failed/);assert.equal(f.rows.get('workspace:call').deal_id,'20');assert.equal(f.rows.get('workspace:call').verified,undefined);
  assert.equal((await f.service.process(f.event)).dealId,'20');assert.equal(f.ensured[1].dealId,'20');
});
test('changed contact identity cannot reuse a saved meeting receipt',async()=>{
  const f=fixture();f.rows.set('workspace:call',{contact_id:'other',deal_id:'20'});await assert.rejects(f.service.process(f.event),/contact_changed/);assert.equal(f.ensured.length,0);
});
test('eligible missing contact is created before call-log retry; other call errors do not create deals',async()=>{
  const f=fixture();f.missingContact=true;let attempts=0;
  f.service.calls={process:async()=>{if(!attempts++)throw new Error('nooks_contact_unresolved');return {status:'processed',callId:'99'};}};
  assert.deepEqual(await f.service.process(f.event),{status:'processed',callId:'99',dealId:'20'});assert.equal(attempts,2);
  const g=fixture();g.service.calls={process:async()=>{throw new Error('hubspot unavailable');}};
  await assert.rejects(g.service.process(g.event),/unavailable/);assert.equal(g.ensured.length,0);
});
test('explicit numeric prospect IDs must agree with the existing contact; missing IDs never create replacement contacts',async()=>{
  const f=fixture();f.event.callData.prospectData.prospectId='999';await assert.rejects(f.service.process(f.event),/identity_conflict/);assert.equal(f.ensured.length,0);
  f.missingContact=true;await assert.rejects(f.service.process(f.event),/identity_conflict/);assert.equal(f.ensured.length,0);
});
test('internal forwarding authenticates and retains a failed deal receipt for retry',async()=>{
  let status;const res={writeHead(value){status=value;},end(){}};
  await handleNooksDealRequest({method:'POST',headers:{authorization:'Bearer wrong'}},res,{token:'secret',readBody:async()=>{throw new Error('must not read');}});assert.equal(status,401);
  await handleNooksDealRequest({method:'POST',headers:{authorization:'Bearer secret'}},res,{token:'secret',readBody:async()=>'{}',service:{process:async()=>{throw new Error('CRM down');}}});assert.equal(status,503);
});

test('a superseded Meeting Booked revision cannot create a deal after a newer call revision',async()=>{
  const f=fixture();f.service.calls={process:async()=>({status:'processed',callId:'99',stale:true})};
  assert.equal((await f.service.process(f.event)).stale,true);assert.equal(f.ensured.length,0);
});

test('new contact stays owned by SDR while new deal initially waits under SDR ownership',async()=>{const f=fixture();f.missingContact=true;await f.service.process(f.event);assert.equal(f.contactCreates[0].hubspot_owner_id,'123');assert.equal(f.ensured[0].ownerId,'123');});
