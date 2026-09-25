// One-time historical backfill (DRY_RUN by default).
//   Ownerless, non-booker demo-form contacts -> round-robin to the AE roster.
//   Existing owners are not rewritten here. Removed roster members are reassigned
//   by the reconciler (reassignRemovedRoundRobinOwners).
// Re-reads each record immediately before writing.
//
// Ported from the retired gtm-ops repo. Run manually:  npm run gtm-ops:backfill[:live]

const { hub, searchAll, associations, sleep } = require("./hubspot");
const cfg = require("./config");

function log(...a) { console.log(...a); }
function pickAE(i) { return cfg.AE_ROSTER[i % cfg.AE_ROSTER.length]; }

async function main() {
  const contactDays = Number(process.env.CONTACT_LOOKBACK_DAYS || 150);
  log(`MODE: ${cfg.DRY_RUN ? "DRY-RUN (no writes)" : "LIVE (writing)"}\n`);

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
  const plan = [];
  let rr = 0;
  for (const c of contacts) {
    if ((cMeetings.get(String(c.id)) || []).length > 0) continue;
    const email = c.properties.email || "";
    if (cfg.INTERNAL_EMAIL_RE.test(email)) { log(`SKIP internal ${email}`); continue; }
    plan.push({ id: String(c.id), email, ae: pickAE(rr++) });
  }

  log(`\nRound-robin ownerless contacts: ${plan.length}`);
  for (const p of plan) log(`  ${p.id} ${p.email} -> ${p.ae.name}`);

  if (cfg.DRY_RUN) { log("\nDRY-RUN: nothing written. Set DRY_RUN=false to apply."); return; }

  let done = 0;
  for (const p of plan) {
    const cur = await hub("GET", `/crm/v3/objects/contacts/${p.id}?properties=hubspot_owner_id`);
    if (cur.properties.hubspot_owner_id) continue;
    await hub("PATCH", `/crm/v3/objects/contacts/${p.id}`, { properties: { hubspot_owner_id: p.ae.id } });
    done++; await sleep(150);
  }
  log(`\nLIVE done. Contacts assigned ${done}.`);
}

main().catch((e) => { console.error("backfill FAILED:", e.message); process.exit(1); });
