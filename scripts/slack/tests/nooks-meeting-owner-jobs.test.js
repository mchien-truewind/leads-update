const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {NooksMeetingOwnerJobs,DELAY}=require('../nooks-meeting-owner-jobs');
const {createNooksOwnerNotifier}=require('../nooks-owner-notification');
async function fixture(){
  const db=new PGlite();let clock=1000000,owner='123',lookups=0,patches=0,alerts=0,fail=false,alertFail=false,lost=false;
  const query=(sql,args)=>sql.includes('advisory')?Promise.resolve({rows:[{locked:true}]}):db.query(sql,args);
  const pool={query,connect:async()=>({query,release(){}})};
  await query('CREATE TABLE nooks_meeting_deals(deal_id TEXT,verified_at TIMESTAMPTZ)');
  await query("INSERT INTO nooks_meeting_deals VALUES('20',NOW())");
  const options={pool,now:()=>clock,logger:{warn(){}},resolveMeetingOwner:async()=>{lookups++;if(fail)throw new Error('nooks_meeting_not_found');return '456';},
    request:async(path,options={})=>{if(options.method==='PATCH'){patches++;owner=options.body.properties.hubspot_owner_id;if(lost){lost=false;throw new Error('lost response');}}return{id:'20',properties:{hubspot_owner_id:owner}};},
    notify:async()=>{if(alertFail)throw new Error('Slack down');alerts++;}};
  const jobs=new NooksMeetingOwnerJobs(options);await jobs.initialize();
  const schedule=()=>jobs.schedule({query},{dealId:'20',workspaceId:'w',callId:'call',contactId:'10',email:'lead@example.test',repEmail:'sdr@trytruewind.com',initialOwner:'123'});
  await schedule();
  return{db,jobs,options,schedule,query,get lookups(){return lookups;},get patches(){return patches;},get alerts(){return alerts;},get owner(){return owner;},set owner(x){owner=x;},set fail(x){fail=x;},set alertFail(x){alertFail=x;},set lost(x){lost=x;},advance:ms=>{clock+=ms;},row:async()=> (await query('SELECT * FROM nooks_meeting_owner_jobs')).rows[0]};
}
test('no calendar search before five minutes; restart and duplicate scheduling preserve deadline; AE update verified',async()=>{
 const f=await fixture();try{await f.jobs.tick();f.advance(DELAY-1);await f.schedule();await new NooksMeetingOwnerJobs(f.options).tick();assert.equal(f.lookups,0);assert.equal(f.patches,0);
 f.advance(1);await f.jobs.tick();assert.equal(f.owner,'456');assert.equal(f.lookups,1);assert.equal((await f.row()).state,'completed');assert.equal(f.alerts,0);await f.jobs.tick();assert.equal(f.patches,1);}finally{await f.db.close();}
});
test('missing meeting alerts once after wait and retries until calendar matches',async()=>{
 const f=await fixture();try{f.fail=true;await f.jobs.tick();assert.equal(f.alerts,0);f.advance(DELAY);await f.jobs.tick();assert.equal(f.alerts,1);assert.equal(f.owner,'123');assert.equal((await f.row()).state,'pending');
 f.advance(60000);await new NooksMeetingOwnerJobs(f.options).tick();assert.equal(f.alerts,1);f.fail=false;f.advance(60000);await f.jobs.tick();assert.equal(f.owner,'456');assert.equal((await f.row()).state,'completed');}finally{await f.db.close();}
});
test('ambiguous match leaves owner unchanged and sends a deduplicated alert',async()=>{
 const f=await fixture();try{f.jobs.resolveMeetingOwner=async()=>{throw new Error('nooks_meeting_ae_ambiguous');};f.advance(DELAY);await f.jobs.tick();assert.equal(f.owner,'123');assert.equal(f.alerts,1);assert.equal((await f.row()).last_error,'nooks_meeting_ae_ambiguous');}finally{await f.db.close();}
});
test('failed Slack delivery retries without losing pending owner work',async()=>{
 const f=await fixture();try{f.fail=true;f.alertFail=true;f.advance(DELAY);await f.jobs.tick();assert.equal((await f.row()).alerted_at,null);f.alertFail=false;f.advance(60000);await f.jobs.tick();assert.equal(f.alerts,1);assert.ok((await f.row()).alerted_at);}finally{await f.db.close();}
});
test('manual owner change is preserved without calendar lookup and alerts Mercedes',async()=>{
 const f=await fixture();try{f.owner='789';f.advance(DELAY);await f.jobs.tick();assert.equal(f.owner,'789');assert.equal(f.lookups,0);assert.equal(f.alerts,1);assert.equal((await f.row()).state,'preserved');}finally{await f.db.close();}
});
test('lost PATCH response recovers verified target without a second reassignment',async()=>{
 const f=await fixture();try{f.lost=true;f.advance(DELAY);await f.jobs.tick();assert.equal(f.owner,'456');assert.equal((await f.row()).state,'pending');f.advance(60000);await f.jobs.tick();assert.equal((await f.row()).state,'completed');assert.equal(f.patches,1);}finally{await f.db.close();}
});
test('unverified contact/company links prevent delayed reassignment',async()=>{
 const f=await fixture();try{await f.query('UPDATE nooks_meeting_deals SET verified_at=NULL');f.advance(DELAY);await f.jobs.tick();assert.equal(f.lookups,0);assert.equal(f.patches,0);}finally{await f.db.close();}
});
test('existing Slack bot targets gtm-general, tags configured Mercedes identity and includes actionable deal context',async()=>{
 const posts=[];const notify=createNooksOwnerNotifier({resolveChannelId:async name=>{assert.equal(name,'gtm-general');return 'C_GTM';},client:{chat:{postMessage:async input=>{posts.push(input);return{ok:true,ts:'1.2'};}}}});
 await notify({job:{deal_id:'20',call_id:'call',email:'<@everyone>&'},code:'nooks_meeting_not_found',messageId:'stable'});
 assert.equal(posts[0].channel,'C_GTM');assert.match(posts[0].text,/<@U0ABULY5TEK>/);assert.match(posts[0].text,/five-minute/);assert.match(posts[0].text,/record\/0-3\/20/);assert.match(posts[0].text,/&lt;@everyone&gt;&amp;/);assert.equal(posts[0].client_msg_id,'stable');
});
test('Slack missing channel or rejected post is not counted as delivery',async()=>{
 await assert.rejects(createNooksOwnerNotifier({resolveChannelId:async()=>null,client:{}})({job:{},code:'x'}),/channel_unavailable/);
 await assert.rejects(createNooksOwnerNotifier({resolveChannelId:async()=> 'C',client:{chat:{postMessage:async()=>({ok:false})}}})({job:{},code:'x'}),/delivery_unverified/);
});
