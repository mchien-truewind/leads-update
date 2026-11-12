const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNooksMeetingOwnerResolver } = require('../nooks-meeting-owner');
const now = () => Date.parse('2026-11-11T00:00:00Z');
function fixture() {
  const rows = ['1','2'].map(ownerId => ({ownerId,calendlyUrl:`https://calendly.com/ae${ownerId}/demo`,slackUserId:`UAE${ownerId}`,
    hostUris:[`https://api.calendly.com/users/ae${ownerId}`],eventTypeUris:[`https://api.calendly.com/event_types/ae${ownerId}`]}));
  const event = {id:'event',iCalUID:'uid',start:{dateTime:'2026-11-12T12:00:00Z'},end:{dateTime:'2026-11-12T12:30:00Z'},
    organizer:{email:'sdr@trytruewind.com'},attendees:[{email:'lead@example.test'},{email:'ae1@trytruewind.com'},{email:'sdr@trytruewind.com'}]};
  const pages = {'ae1@trytruewind.com':{accessRole:'reader',items:[event]},'ae2@trytruewind.com':{accessRole:'reader',items:[]}};
  const requests=[];
  const resolve = createNooksMeetingOwnerResolver({now,env:{DEMO_ROUTING_OWNERS_JSON:JSON.stringify(rows)},
    request:async path=>{const id=path.split('/').pop();return{id,archived:false,email:`ae${id}@trytruewind.com`};},
    calendar:{events:{list:async input=>{requests.push(input);return{data:pages[input.calendarId]};}}}});
  return {resolve,event,pages,requests};
}
const input = {email:'lead@example.test',repEmail:'sdr@trytruewind.com'};
test('SDR-organized meeting resolves the AE attendee through registered calendars',async()=>{
  const f=fixture();assert.equal(await f.resolve(input),'1');assert.equal(f.requests.length,2);
});
test('AE organizer takes precedence when another AE attends',async()=>{
  const f=fixture();f.event.organizer.email='ae1@trytruewind.com';f.event.attendees.push({email:'ae2@trytruewind.com'});assert.equal(await f.resolve(input),'1');
});
test('missing, declined, cancelled and private prospect meetings never assign an SDR',async()=>{
  for(const mutate of [e=>e.attendees[0].email='other@example.test',e=>e.attendees[0].responseStatus='declined',e=>e.status='cancelled',e=>e.visibility='private',e=>e.attendeesOmitted=true,e=>e.attendees[1].responseStatus='declined']){
    const f=fixture();mutate(f.event);await assert.rejects(f.resolve(input),/nooks_meeting_(not_found|ae_ambiguous)/);
  }
});
test('multiple AEs without an AE organizer or conflicting simultaneous meetings stay pending',async()=>{
  const f=fixture();f.event.attendees.push({email:'ae2@trytruewind.com'});await assert.rejects(f.resolve(input),/ae_ambiguous/);
  const g=fixture();g.pages['ae2@trytruewind.com'].items=[{...g.event,iCalUID:'other',attendees:[{email:'lead@example.test'},{email:'ae2@trytruewind.com'}]}];await assert.rejects(g.resolve(input),/ae_ambiguous/);
});
test('calendar failure and incomplete access are not treated as an empty calendar',async()=>{
  const f=fixture();f.pages['ae2@trytruewind.com'].accessRole='freeBusyReader';await assert.rejects(f.resolve(input),/calendar_unavailable/);
});
test('calendar pagination is consumed and repeated tokens fail closed',async()=>{
  const f=fixture();f.pages['ae2@trytruewind.com'].nextPageToken='repeat';await assert.rejects(f.resolve(input),/pagination_invalid/);assert.ok(f.requests.some(r=>r.pageToken==='repeat'));
});
test('SDR cannot receive deal ownership even if accidentally included in the AE roster',async()=>{
  const f=fixture();await assert.rejects(f.resolve({...input,repEmail:'ae1@trytruewind.com'}),/ae_ambiguous/);
});
test('earliest upcoming meeting selects its AE; duplicate calendar copies count once',async()=>{
  const f=fixture();f.pages['ae1@trytruewind.com'].items.push({...f.event,iCalUID:'later',start:{dateTime:'2026-11-13T12:00:00Z'},end:{dateTime:'2026-11-13T12:30:00Z'}});assert.equal(await f.resolve(input),'1');
  f.pages['ae1@trytruewind.com'].items.push(structuredClone(f.event));assert.equal(await f.resolve(input),'1');
});

test('missing SDR identity cannot bypass the SDR exclusion',async()=>{const f=fixture();await assert.rejects(f.resolve({email:input.email}),/sdr_email_required/);});
