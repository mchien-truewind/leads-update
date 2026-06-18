// One-time historical backfill (DRY_RUN by default).
//   Part A: Active Pipeline deals with a booked meeting where owner != host -> set owner = host.
//   Part B: ownerless, non-booker demo-form contacts -> round-robin to the AE roster.
// Skips deals whose host is an inactive/unknown owner, and internal-domain test contacts.
// Re-reads each record immediately before writing.
//
// Ported from the retired gtm-ops repo. Run manually:  npm run gtm-ops:backfill[:live]

const { hub, getOwners, searchAll, associations, batchRead, sleep } = require("./hubspot");
const cfg = require("./config");

function log(...a) { console.log(...a); }
function pickAE(i) { return cfg.AE_ROSTER[i % cfg.AE_ROSTER.length]; }
function latestHost(ids, props) {
  const top = ids.map((id) => ({ id, p: props.get(id) || {} }))
    .sort((a, b) => Number(b.p.hs_meeting_start_time || b.p.hs_timestamp || 0) - Number(a.p.hs_meeting_start_time || a.p.hs_timestamp || 0))[0];
  return top && top.p.hubspot_owner_id ? String(top.p.hubspot_owner_id) : null;
}

async function main() {
  const dealDays = Number(process.env.DEAL_LOOKBACK_DAYS || 120);
  const contactDays = Number(process.env.CONTACT_LOOKBACK_DAYS || 150);
  log(`MODE: ${cfg.DRY_RUN ? "DRY-RUN (no writes)" : "LIVE (writing)"}\n`);
  const owners = await getOwners();

  // ---- Part A ----
  // Closed stages excluded: reassigning a Won/Closed-Lost deal only rewrites history.
  const CLOSED_STAGES = new Set(["1166230571", "190380587"]); // Won, Closed/Lost
  const deals = await searchAll("deals", {
    filterGroups: [{ filters: [
      { propertyName: "pipeline", operator: "EQ", value: cfg.ACTIVE_PIPELINE },
      { propertyName: "createdate", operator: "GTE", value: String(Date.now() - dealDays * 86400000) },
    ] }],
    sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    properties: ["dealname", "hubspot_owner_id", "pipeline", "dealstage"],
    limit: 100,
  });
  const dealIds = deals.map((d) => String(d.id));
  const dMeetings = await associations("deals", dealIds, "meetings");
  const mProps = await batchRead("meetings", [...new Set([...dMeetings.values()].flat())], ["hubspot_owner_id", "hs_meeting_start_time", "hs_timestamp"]);
  const planA = [];
  for (const d of deals) {
    if (CLOSED_STAGES.has(String(d.properties.dealstage))) continue; // open deals only
    const owner = d.properties.hubspot_owner_id ? String(d.properties.hubspot_owner_id) : null;
    const host = latestHost(dMeetings.get(String(d.id)) || [], mProps);
    if (host && owner && host !== owner) {
      if (!owners.has(host)) { log(`SKIP deal ${d.id} (${d.properties.dealname}): host ${host} inactive/unknown`); continue; }
      planA.push({ id: String(d.id), name: d.properties.dealname, from: owner, to: host });
    }
  }

  // ---- Part B ----
  const contacts = await searchAll("contacts", {
    filterGroups: [{ filters: [
      { propertyName: "recent_conversion_event_name", operator: "CONTAINS_TOKEN", value: cfg.DEMO_FORM_TOKEN },
      { propertyName: "createdate", operator: "GTE", value: String(Date.now() - contactDays * 86400000) },
      { propertyName: "hubspot_owner_id", operator: "NOT_HAS_PROPERTY" },
    ] }],
    sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
    properties: ["email", "hubspot_owner_id"],
    limit: 100,
  });
  const cIds = contacts.map((c) => String(c.id));
  const cMeetings = await associations("contacts", cIds, "meetings");
  const planB = [];
  let rr = 0;
  for (const c of contacts) {
    if ((cMeetings.get(String(c.id)) || []).length > 0) continue;
    const email = c.properties.email || "";
    if (cfg.INTERNAL_EMAIL_RE.test(email)) { log(`SKIP internal ${email}`); continue; }
    planB.push({ id: String(c.id), email, ae: pickAE(rr++) });
  }

  log(`\nPart A (deal owner -> host): ${planA.length}`);
  for (const p of planA) log(`  ${p.id} ${p.name}: ${owners.get(p.from)?.name} -> ${owners.get(p.to)?.name}`);
  log(`\nPart B (round-robin contacts): ${planB.length}`);
  for (const p of planB) log(`  ${p.id} ${p.email} -> ${p.ae.name}`);

  if (cfg.DRY_RUN) { log("\nDRY-RUN: nothing written. Set DRY_RUN=false to apply."); return; }

  let aDone = 0, bDone = 0;
  for (const p of planA) {
    const cur = await hub("GET", `/crm/v3/objects/deals/${p.id}?properties=hubspot_owner_id`);
    if (String(cur.properties.hubspot_owner_id || "") !== p.from) continue;
    await hub("PATCH", `/crm/v3/objects/deals/${p.id}`, { properties: { hubspot_owner_id: p.to } });
    aDone++; await sleep(150);
  }
  for (const p of planB) {
    const cur = await hub("GET", `/crm/v3/objects/contacts/${p.id}?properties=hubspot_owner_id`);
    if (cur.properties.hubspot_owner_id) continue;
    await hub("PATCH", `/crm/v3/objects/contacts/${p.id}`, { properties: { hubspot_owner_id: p.ae.id } });
    bDone++; await sleep(150);
  }
  log(`\nLIVE done. Deals updated ${aDone}; contacts assigned ${bDone}.`);
}

main().catch((e) => { console.error("backfill FAILED:", e.message); process.exit(1); });
