// Inbound deal-flow reconciler (backstop to the leads-update Calendly webhook).
//   Symptom #2: for Active Pipeline deals with a booked meeting, set deal owner = meeting host.
//   Symptom #1: round-robin ownerless, non-booker demo-form contacts to the AE roster.
// Idempotent + guarded: re-reads each record immediately before writing; only writes when needed.
// DRY_RUN (default true) logs intended changes without writing.
//
// Ported from the retired gtm-ops repo. The run loop now lives in ../gtm_ops_bot.js (the
// worker entrypoint); this module only exports the reconcile logic so it stays testable.

const { hub, getOwners, searchAll, associations, batchRead, sleep } = require("./hubspot");
const cfg = require("./config");

function log(...a) { console.log(new Date().toISOString(), ...a); }

// Deterministic, balanced AE pick so repeated runs assign the same contact to the same AE.
function pickAE(contactId) {
  let h = 0;
  for (const ch of String(contactId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return cfg.AE_ROSTER[h % cfg.AE_ROSTER.length];
}

function latestMeetingHost(meetingIds, meetingProps) {
  const sorted = meetingIds
    .map((id) => ({ id, p: meetingProps.get(id) || {} }))
    .sort((a, b) => Number(b.p.hs_meeting_start_time || b.p.hs_timestamp || 0) - Number(a.p.hs_meeting_start_time || a.p.hs_timestamp || 0));
  const top = sorted[0];
  return top && top.p.hubspot_owner_id ? String(top.p.hubspot_owner_id) : null;
}

// ---------- Symptom #2: deal owner = meeting host ----------
async function reconcileDealOwners(owners) {
  const cutoff = Date.now() - cfg.MEETING_LOOKBACK_MIN * 60000;
  const recentMeetings = await searchAll("meetings", {
    filterGroups: [{ filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(cutoff) }] }],
    sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
    properties: ["hubspot_owner_id", "hs_meeting_start_time", "hs_timestamp"],
    limit: 100,
  });
  if (!recentMeetings.length) { log("symptom#2: no meetings modified in window"); return { checked: 0, fixed: 0 }; }

  // recent meetings -> candidate deals (Active Pipeline only)
  const meetingIds = recentMeetings.map((m) => String(m.id));
  const mToDeals = await associations("meetings", meetingIds, "deals");
  const candidateDealIds = [...new Set([...mToDeals.values()].flat())];
  if (!candidateDealIds.length) { log("symptom#2: no deals on recent meetings"); return { checked: 0, fixed: 0 }; }

  const dealProps = await batchRead("deals", candidateDealIds, ["dealname", "hubspot_owner_id", "pipeline"]);
  const activeDealIds = candidateDealIds.filter((id) => (dealProps.get(id) || {}).pipeline === cfg.ACTIVE_PIPELINE);

  // for each candidate deal, fetch ALL its meetings to pick the *latest* host (not just the one that fired)
  const dToMeetings = await associations("deals", activeDealIds, "meetings");
  const allMeetingIds = [...new Set([...dToMeetings.values()].flat())];
  const meetingProps = await batchRead("meetings", allMeetingIds, ["hubspot_owner_id", "hs_meeting_start_time", "hs_timestamp"]);

  let fixed = 0;
  for (const dealId of activeDealIds) {
    const p = dealProps.get(dealId) || {};
    const ownerId = p.hubspot_owner_id ? String(p.hubspot_owner_id) : null;
    const host = latestMeetingHost(dToMeetings.get(dealId) || [], meetingProps);
    if (!host) continue;
    if (!owners.has(host)) { log(`symptom#2: skip deal ${dealId} (${p.dealname}) host ${host} inactive/unknown`); continue; }
    if (ownerId === host) continue;

    log(`symptom#2: deal ${dealId} (${p.dealname}) owner ${ownerId ? owners.get(ownerId)?.name : "(none)"} -> ${owners.get(host).name}`);
    if (!cfg.DRY_RUN) {
      const cur = await hub("GET", `/crm/v3/objects/deals/${dealId}?properties=hubspot_owner_id`);
      if (String(cur.properties.hubspot_owner_id || "") === host) continue; // changed since read
      await hub("PATCH", `/crm/v3/objects/deals/${dealId}`, { properties: { hubspot_owner_id: host } });
      await sleep(150);
    }
    fixed++;
  }
  return { checked: activeDealIds.length, fixed };
}

// ---------- Symptom #1: round-robin ownerless non-booker demo contacts ----------
async function roundRobinNonBookers(owners) {
  const now = Date.now();
  const minCreate = now - cfg.CONTACT_MAX_AGE_DAYS * 86400000;
  const maxCreate = now - cfg.CONTACT_MIN_AGE_MIN * 60000; // grace period to allow a booking to land first
  const contacts = await searchAll("contacts", {
    filterGroups: [{ filters: [
      { propertyName: "recent_conversion_event_name", operator: "CONTAINS_TOKEN", value: cfg.DEMO_FORM_TOKEN },
      { propertyName: "createdate", operator: "GTE", value: String(minCreate) },
      { propertyName: "createdate", operator: "LTE", value: String(maxCreate) },
      { propertyName: "hubspot_owner_id", operator: "NOT_HAS_PROPERTY" },
    ] }],
    sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
    properties: ["email", "createdate", "hubspot_owner_id"],
    limit: 100,
  });
  if (!contacts.length) { log("symptom#1: no ownerless demo contacts in window"); return { checked: 0, assigned: 0 }; }

  const ids = contacts.map((c) => String(c.id));
  const cToMeetings = await associations("contacts", ids, "meetings");

  let assigned = 0;
  for (const c of contacts) {
    const id = String(c.id);
    const email = c.properties.email || "";
    if (cfg.INTERNAL_EMAIL_RE.test(email)) { log(`symptom#1: skip internal ${email}`); continue; }
    if ((cToMeetings.get(id) || []).length > 0) continue; // they booked -> handled by webhook / symptom #2
    const ae = pickAE(id);

    log(`symptom#1: contact ${id} (${email}) -> ${ae.name}`);
    if (!cfg.DRY_RUN) {
      const cur = await hub("GET", `/crm/v3/objects/contacts/${id}?properties=hubspot_owner_id`);
      if (cur.properties.hubspot_owner_id) continue; // got an owner since read -> don't stomp (incl. BDRs)
      await hub("PATCH", `/crm/v3/objects/contacts/${id}`, { properties: { hubspot_owner_id: ae.id } });
      await sleep(150);
    }
    assigned++;
  }
  return { checked: contacts.length, assigned };
}

async function runCycle() {
  log(`reconciler start | DRY_RUN=${cfg.DRY_RUN} | pipeline=${cfg.ACTIVE_PIPELINE}`);
  const owners = await getOwners();
  const s2 = await reconcileDealOwners(owners);
  const s1 = await roundRobinNonBookers(owners);
  log(`reconciler done | symptom#2 checked=${s2.checked} fixed=${s2.fixed} | symptom#1 checked=${s1.checked} assigned=${s1.assigned}`);
  return { s1, s2 };
}

module.exports = { runCycle, reconcileDealOwners, roundRobinNonBookers, pickAE, latestMeetingHost, log };
