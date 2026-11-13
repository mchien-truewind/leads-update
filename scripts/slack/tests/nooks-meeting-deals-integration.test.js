const {test}=require('node:test');
const assert=require('node:assert/strict');
const {NooksDeals}=require('../nooks-deals');
const {CONTACT_KEY_PROPERTY,COMPANY_KEY_PROPERTY,PIPELINE_ID,STAGE_ID}=require('../demo-request-deals');
function fixture({existingDeal=false}={}){
  const calls=[],scheduled=[],receipts=new Map(),deals=new Map(),edges=new Map();let activation,creates=0,hideReverse=false;
  const add=(a,b)=>{if(!edges.has(a))edges.set(a,new Set());edges.get(a).add(b);};
  const link=(type,id,target,to)=>{add(type+':'+id,target+':'+to);add(target+':'+to,type+':'+id);};
  link('contacts','10','companies','30');link('contacts','10','companies','40');
  if(existingDeal){deals.set('90',{id:'90',properties:{pipeline:PIPELINE_ID,dealstage:STAGE_ID,hubspot_owner_id:'555',hs_lastmodifieddate:'2026-11-11T00:00:00Z'}});link('companies','40','deals','90');}
  const query=async(sql,args=[])=>{
    if(sql.startsWith('INSERT INTO nooks_meeting_owner_jobs'))scheduled.push(args);
    if(sql.includes('advisory'))return{rows:[{locked:true}]};
    const key=args.slice(0,2).join(':');
    if(sql.startsWith('INSERT INTO nooks_meeting_deals')&&!receipts.has(key))receipts.set(key,{contact_id:args[2]});
    if(sql.startsWith('SELECT * FROM nooks_meeting_deals'))return{rows:[{...receipts.get(key)}]};
    if(sql.includes('SET deal_id=$3'))receipts.get(key).deal_id=args[2];
    if(sql.includes('SET verified_at=NOW()'))receipts.get(key).verified=true;
    if(sql.startsWith('INSERT INTO nooks_deal_activation')&&activation===undefined)activation=args[0];
    if(sql.startsWith('SELECT activated_at'))return{rows:[{activated_at:activation}]};
    return{rows:[]};
  };
  const request=async(path,options={})=>{
    calls.push({path,...options});
    if(path===`/crm/v3/properties/deals/${CONTACT_KEY_PROPERTY}`)return{name:CONTACT_KEY_PROPERTY,type:'string',hasUniqueValue:true};
    if(path===`/crm/v3/properties/companies/${COMPANY_KEY_PROPERTY}`)return{name:COMPANY_KEY_PROPERTY,type:'string',hasUniqueValue:true};
    if(path===`/crm/v3/pipelines/deals/${PIPELINE_ID}`)return{stages:[{id:STAGE_ID,metadata:{isClosed:false}}]};
    if(path.startsWith('/automation/'))return{isEnabled:false};
    if(path.startsWith('/crm/v3/properties/deals/deal_source'))return{options:[{label:'Outbound - Sales Sourced List',value:'Outbound'},{label:'outbound - SDR',value:'sdr_internal_value'}]};
    if(path.startsWith('/crm/v3/owners?'))return{results:[{id:'123',email:'rep@example.test',archived:false}]};
    if(path.startsWith('/crm/v3/objects/contacts/')&&options.method!=='PATCH')return{id:'10',properties:{email:'lead@example.test',firstname:'Lead',company:'Primary Co'}};
    if(path.startsWith('/crm/v3/objects/companies/30?'))return{id:'30',properties:{name:'Primary Co'}};
    if(path==='/crm/v3/objects/deals/batch/read')return{results:options.body.inputs.map(x=>structuredClone(deals.get(x.id)))};
    if(path==='/crm/v3/objects/deals'&&options.method==='POST'){
      creates++;const d={id:'100',properties:{...options.body.properties}};deals.set('100',d);
      for(const association of options.body.associations)link('deals','100',association.types[0].associationTypeId===3?'contacts':'companies',association.to.id);
      return structuredClone(d);
    }
    if(path.startsWith('/crm/v3/objects/deals/')&&options.method!=='PATCH'){
      const url=new URL('https://example.test'+path);let d;
      if(url.searchParams.has('idProperty'))d=[...deals.values()].find(x=>x.properties[CONTACT_KEY_PROPERTY]===url.pathname.split('/').pop());
      else d=deals.get(url.pathname.split('/').pop());
      if(!d)throw Object.assign(new Error('missing'),{statusCode:404});return structuredClone(d);
    }
    if(options.method==='PATCH')return{};
    const match=/^\/crm\/v4\/objects\/(contacts|companies|deals)\/(\d+)\/associations\/(?:default\/)?(contacts|companies|deals)(?:\/(\d+))?/.exec(path);
    if(match){
      const [,type,id,target,to]=match;
      if(options.method==='PUT'){link(type,id,target,to);return{};}
      if(type==='contacts'&&target==='companies'){
        if(path.includes('after=next'))return{results:[{toObjectId:'30',associationTypes:[{category:'HUBSPOT_DEFINED',typeId:1}]}]};
        return{results:[{toObjectId:'40',associationTypes:[]}],paging:{next:{after:'next'}}};
      }
      if(hideReverse&&type==='companies'&&target==='contacts'&&id==='30')return{results:[]};
      return{results:[...(edges.get(type+':'+id)||[])].filter(x=>x.startsWith(target+':')).map(x=>({toObjectId:x.split(':')[1]}))};
    }
    throw new Error('Unexpected '+path);
  };
  const service=new NooksDeals({request,resolveMeetingOwner:async()=> '456',pool:{query,connect:async()=>({query,release(){}})},env:{NOOKS_DEALS_ENABLED:'true',NOOKS_DEALS_ACTIVATED_AT:'2026-11-11T00:00:00Z',NOOKS_WORKSPACE_ID:'w',NOOKS_MEETING_DISPOSITION_IDS:'6ace719d28ac2c000dbd3c71,887a2c18-be90-404f-8984-5611ca3655a6'}});
  const event={event:'call.logged',callData:{workspaceId:'w',callId:'call',startedAt:'2026-11-11T01:00:00Z',status:'completed',disposition:{id:'6ace719d28ac2c000dbd3c71',name:'Meeting Booked'},prospectData:{email:'lead@example.test'},userData:{email:'rep@example.test'}}};
  return{service,event,calls,scheduled,receipts,deals,get creates(){return creates;},set hideReverse(x){hideReverse=x;}};
}
test('real Nooks flow creates one Discovery deal and verifies all reciprocal links to the selected primary company',async()=>{
  const f=fixture();await f.service.initialize();const result=await f.service.process(f.event);
  assert.equal(result.dealId,'100');const deal=f.deals.get('100');assert.equal(deal.properties.dealstage,STAGE_ID);assert.equal(deal.properties.hubspot_owner_id,'123');assert.equal(deal.properties.deal_source,'sdr_internal_value');
  assert.ok(f.calls.some(x=>x.path.startsWith('/crm/v3/owners?')));assert.equal(f.scheduled.length,1);assert.equal(f.scheduled[0][0],'100');assert.equal(f.scheduled[0][6],'123');
  assert.equal(f.receipts.get('w:call').verified,true);await f.service.process(f.event);assert.equal(f.creates,1);
  for(const path of ['/contacts/10/associations/companies?','/companies/30/associations/contacts?','/contacts/10/associations/deals?','/deals/100/associations/contacts?','/companies/30/associations/deals?','/deals/100/associations/companies?'])assert.ok(f.calls.some(x=>x.path.includes(path)),path);
});
test('open-deal lookup includes all contact company associations and preserves the existing deal owner',async()=>{
  const f=fixture({existingDeal:true});f.service.resolveMeetingOwner=async()=>{throw new Error('must not resolve existing deal');};await f.service.initialize();assert.equal((await f.service.process(f.event)).dealId,'90');assert.equal(f.creates,0);assert.equal(f.scheduled.length,0);assert.equal(f.deals.get('90').properties.hubspot_owner_id,'555');
  assert.ok(f.calls.some(x=>x.path.includes('/companies/40/associations/deals?')));assert.ok(f.calls.some(x=>x.path.includes('/companies/30/associations/deals?')));
});
test('a missing reciprocal link leaves receipt pending; retry repairs the same saved deal',async()=>{
  const f=fixture();await f.service.initialize();f.hideReverse=true;await assert.rejects(f.service.process(f.event),/association_readback_missing/);assert.equal(f.receipts.get('w:call').deal_id,'100');assert.equal(f.receipts.get('w:call').verified,undefined);
  f.hideReverse=false;assert.equal((await f.service.process(f.event)).dealId,'100');assert.equal(f.creates,1);assert.equal(f.receipts.get('w:call').verified,true);
});

test('new deal is created under SDR ownership without a calendar lookup',async()=>{const f=fixture();f.service.resolveMeetingOwner=async()=>{throw new Error('must wait five minutes');};f.service.ownerJobs.resolveMeetingOwner=f.service.resolveMeetingOwner;await f.service.initialize();await f.service.process(f.event);assert.equal(f.creates,1);assert.equal(f.deals.get('100').properties.hubspot_owner_id,'123');});
