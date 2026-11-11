const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NooksCalls } = require('../nooks-calls');
const { NooksDeals } = require('../nooks-deals');
function fixture() {
  const rows = new Map(), records = new Map(), requests = [];
  let creates = 0, uncertain = false, rejection = false, associationFails = false, native = false;
  const client = {release(){},async query(sql,args=[]) {
    if (sql.includes('advisory')) return {rows:[{locked:true}]};
    const key = args.slice(0,2).join(':');
    if (sql.startsWith('INSERT')) {if(!rows.has(key)) rows.set(key,{create_claimed:false,ingress_sequence:'0'});}
    if(sql.startsWith('SELECT *')) return {rows:[{...rows.get(key)}]};
    const row=rows.get(key);
    if(sql.includes('create_claimed=TRUE')) row.create_claimed=true;
    if(sql.includes('create_claimed=FALSE')) row.create_claimed=false;
    if(sql.includes('SET hubspot_call_id')) row.hubspot_call_id=args[2];
    if(sql.includes('SET ingress_sequence=$3')) row.ingress_sequence=args[2];
    if(sql.includes('SET digest')) Object.assign(row,{digest:args[2],ingress_sequence:args[3]});
    return {rows:[]};
  }};
  const event={event:'call.logged',ingressSequence:'1',callData:{workspaceId:'w',callId:'call',status:'completed',callDirection:'outbound',startedAt:'2026-11-11T10:00:00.000Z',durationSeconds:1.5,disposition:{id:'vm',name:'Left voicemail'},prospectData:{prospectId:'10',email:'lead@example.test',name:'Person',phoneNumber:'+15555550100'},userData:{email:'rep@example.test'},notes:'<script>unsafe</script>\nDetails',transcriptUrl:'https://nooks.example/transcript',recordingUrl:'https://nooks.example/recording',sequenceData:{sequenceName:'Outbound',sequenceStep:'Call 2'}}};
  const service = new NooksCalls({pool:{connect:async()=>client,query:async()=>({})},env:{NOOKS_WORKSPACE_ID:'w',NOOKS_CALL_DISPOSITION_MAP:'{"vm":"hs-vm"}'},async request(path,options={}) {
    requests.push({path,...options});
    if(path.startsWith('/crm/v3/owners')) return {results:[{id:'7',email:'rep@example.test',archived:false}]};
    if(path==='/calling/v1/dispositions') return [{id:'hs-vm'}];
    if(path.startsWith('/crm/v3/objects/contacts/')) return {id:'10',properties:{email:'lead@example.test'},associations:{companies:{results:[{id:'20'}]}}};
    if(path.endsWith('/calls/search')) {
      const external=options.body.filterGroups[0].filters[0].propertyName==='hs_call_external_id';
      const results=[...records].filter(([id])=>native ? !external : external).map(([id,properties])=>({id,properties}));
      return {results,total:results.length};
    }
    if(path==='/crm/v3/objects/calls') {
      creates++;
      if(rejection) { const e=new Error('rejected');e.statusCode=429;throw e; }
      records.set('30',{...options.body.properties});
      if(uncertain) throw new Error('connection reset after successful create');
      return {id:'30'};
    }
    if(options.method==='PUT') {if(associationFails) throw new Error('association failed');return {};}
    if(path.startsWith('/crm/v3/objects/calls/')) {
      const id=path.split('/')[5].split('?')[0];
      if(options.method==='PATCH') records.set(id,{...options.body.properties});
      return {id,properties:records.get(id),associations:{contacts:{results:[{id:'10'}]}}};
    }
    throw new Error(`Unexpected ${path}`);
  }});
  return {event,service,rows,records,requests,get creates(){return creates;},set uncertain(x){uncertain=x;},set rejection(x){rejection=x;},set associationFails(x){associationFails=x;},set native(x){native=x;}};
}
test('all outcomes sync as calls with full details, correct units and associations; retries do not duplicate',async()=>{
  const f=fixture(); await f.service.initialize();
  assert.deepEqual(await f.service.process(f.event),{status:'processed',callId:'30'});
  const p=f.records.get('30');assert.equal(p.hs_call_duration,'1500');assert.equal(p.hs_call_disposition,'hs-vm');assert.equal(p.hubspot_owner_id,'7');assert.equal(p.hs_call_to_number,'+15555550100');assert.match(p.hs_call_body,/&lt;script&gt;/);assert.match(p.hs_call_body,/Call 2/);assert.match(p.hs_call_body,/Nooks transcript/);
  assert.equal(f.requests.filter(x=>x.method==='PUT').length,2);
  await f.service.process({...f.event,eventId:'retry'});assert.equal(f.creates,1);
});
test('revisions update one call and a late older receipt cannot overwrite it',async()=>{
  const f=fixture();await f.service.process(f.event);
  const old=structuredClone(f.event);f.event.ingressSequence='3';f.event.callData.notes='latest';await f.service.process(f.event);
  await f.service.process(old);assert.match(f.records.get('30').hs_call_body,/latest/);assert.equal(f.creates,1);
});
test('uncertain successful create is reconciled, and an absent uncertain create is never repeated',async()=>{
  const f=fixture();f.uncertain=true;await assert.rejects(f.service.process(f.event));
  await f.service.process(f.event);assert.equal(f.creates,1);
  const g=fixture();g.uncertain=true;await assert.rejects(g.service.process(g.event));g.records.clear();
  await assert.rejects(g.service.process(g.event),/create_uncertain/);assert.equal(g.creates,1);
});
test('explicit rate limit permits retry; failed associations are retried against the same call',async()=>{
  const f=fixture();f.rejection=true;await assert.rejects(f.service.process(f.event));f.rejection=false;f.associationFails=true;
  await assert.rejects(f.service.process(f.event));f.associationFails=false;await f.service.process(f.event);assert.equal(f.creates,2);assert.ok(f.rows.get('w:call').digest);
});
test('existing native Nooks call without external ID is reused',async()=>{
  const f=fixture();f.native=true;f.records.set('99',{hs_call_direction:'OUTBOUND',hs_call_duration:'1500'});
  assert.equal((await f.service.process(f.event)).callId,'99');assert.equal(f.creates,0);
});
test('unknown outcome and rep stay blank with source details and explanation preserved; inbound phone maps correctly',async()=>{
  const f=fixture();f.event.callData.disposition={id:'unknown',name:'New outcome'};f.event.callData.userData.email='unknown@example.test';f.event.callData.callDirection='inbound';
  await f.service.process(f.event);const p=f.records.get('30');assert.equal(p.hs_call_disposition,undefined);assert.equal(p.hubspot_owner_id,undefined);assert.match(p.hs_call_body,/mapping missing/);assert.match(p.hs_call_body,/unknown@example.test/);assert.equal(p.hs_call_from_number,'+15555550100');
});
test('identity conflicts, invalid directions and missing receipt ordering fail before CRM create',async()=>{
  for(const mutate of [e=>e.callData.workspaceId='other',e=>e.callData.prospectData.email='different@example.test',e=>e.callData.callDirection='unknown',e=>delete e.ingressSequence]) {
    const f=fixture();mutate(f.event);await assert.rejects(f.service.process(f.event));assert.equal(f.creates,0);
  }
});
test('call-only consumer does not enable deal creation',async()=>{
  const f=fixture(), consumer=new NooksDeals({request:f.service.request,pool:f.service.pool,env:{NOOKS_WORKSPACE_ID:'w'}});consumer.calls=f.service;
  assert.equal((await consumer.process(f.event)).callId,'30');assert.equal(f.creates,1);
});

test('identical later receipt advances ordering before an older changed revision arrives',async()=>{
  const f=fixture();await f.service.process(f.event);
  f.event.ingressSequence='3';await f.service.process(f.event);
  f.event.ingressSequence='2';f.event.callData.notes='stale';await f.service.process(f.event);
  assert.doesNotMatch(f.records.get('30').hs_call_body,/stale/);
});
test('ambiguous native activities and conflicting native metadata remain pending',async()=>{
  for(const conflict of [false,true]) {
    const f=fixture();f.native=true;
    f.records.set('98',{hs_call_direction:conflict?'INBOUND':'OUTBOUND',hs_call_duration:'1500'});
    if(!conflict) f.records.set('99',{hs_call_direction:'OUTBOUND',hs_call_duration:'1500'});
    await assert.rejects(f.service.process(f.event),/native_call_(ambiguous|conflict)/);assert.equal(f.creates,0);
  }
});
test('verified HubSpot GUID works without a custom mapping and missing duration stays blank',async()=>{
  const f=fixture();f.event.callData.disposition.id='hs-vm';delete f.event.callData.durationSeconds;
  await f.service.process(f.event);assert.equal(f.records.get('30').hs_call_disposition,'hs-vm');assert.equal(f.records.get('30').hs_call_duration,undefined);
});
