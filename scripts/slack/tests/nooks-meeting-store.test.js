const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {NooksDeals}=require('../nooks-deals');

test('Postgres-compatible journal preserves deal identity and activation across service initialization',async()=>{
  const db=new PGlite();
  try{
    const env={NOOKS_DEALS_ENABLED:'true',NOOKS_MEETING_DISPOSITION_IDS:'meeting',NOOKS_DEALS_ACTIVATED_AT:'2026-11-11T00:00:00Z'};
    const make=()=>{const service=new NooksDeals({request:async()=>{throw new Error('unexpected HTTP');},pool:{query:(...args)=>db.query(...args)},env});service.deals.initialize=async()=>{};return service;};
    await make().initialize();
    await db.query('INSERT INTO nooks_meeting_deals(workspace_id,call_id,contact_id,deal_id) VALUES($1,$2,$3,$4)',['w','call','10','20']);
    await make().initialize();
    assert.equal((await db.query('SELECT deal_id FROM nooks_meeting_deals')).rows[0].deal_id,'20');
    const first=(await db.query('SELECT activated_at FROM nooks_deal_activation')).rows[0].activated_at;
    env.NOOKS_DEALS_ACTIVATED_AT='2026-11-12T00:00:00Z';await assert.rejects(make().initialize(),/activation_changed/);
    assert.equal(String((await db.query('SELECT activated_at FROM nooks_deal_activation')).rows[0].activated_at),String(first));
  }finally{await db.close();}
});
