// Inbound deal-flow reconciler (backstop to the leads-update Calendly webhook).
//   Existing deals are read only: ownership changes require an explicit human request.
//   Symptom #1: round-robin ownerless, non-booker demo-form contacts to the AE roster.
// Idempotent + guarded: re-reads each record immediately before writing; only writes when needed.
// DRY_RUN (default true) logs intended changes without writing.
//
// Ported from the retired gtm-ops repo. The run loop now lives in ../gtm_ops_bot.js (the
// worker entrypoint); this module only exports the reconcile logic so it stays testable.

const { hub, getOwners, searchAll, associations, sleep } = require("./hubspot");
const cfg = require("./config");
const { createDemoRouter, routingEnabled, SUBMISSION_PROPERTY } = require('../demo-routing');
const { protectContact, reconcileRoutedSubmissions } = require('../demo-routing-assignment');
let sharedRouter;
function getDemoRouter() {
  if (!routingEnabled()) return null;
  if (!sharedRouter) sharedRouter = createDemoRouter({ request: (path, options = {}) => hub(options.method || 'GET', path, options.body) });
  return sharedRouter;
}

function log(...a) { console.log(new Date().toISOString(), ...a); }

// Deterministic, balanced AE pick so repeated runs assign the same contact to the same AE.
function pickAE(contactId) {
  let h = 0;
  for (const ch of String(contactId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return cfg.AE_ROSTER[h % cfg.AE_ROSTER.length];
}

function isRemovedRoundRobinOwner(ownerId) {
  return cfg.REMOVED_ROUND_ROBIN_OWNER_IDS.includes(String(ownerId || ""));
}

// Demo contacts owned by removed roster members move onto the current roster.
// Existing deals are never reassigned.
async function reassignRemovedContactOwners(owners, { api = null, dryRun = cfg.DRY_RUN, isContactManaged = async () => false, demoRouter = getDemoRouter() } = {}) {
  const crm = api || { hub, searchAll, sleep };
  const removed = cfg.REMOVED_ROUND_ROBIN_OWNER_IDS;
  if (!removed.length) return { checked: 0, reassigned: 0 };

  const contacts = await crm.searchAll("contacts", {
    filterGroups: removed.map((id) => ({ filters: [
      { propertyName: "recent_conversion_event_name", operator: "CONTAINS_TOKEN", value: cfg.DEMO_FORM_TOKEN },
      { propertyName: "hubspot_owner_id", operator: "EQ", value: id },
    ] })),
    properties: ["email", "hubspot_owner_id", SUBMISSION_PROPERTY],
    limit: 100,
  });

  let reassigned = 0;
  for (const contact of contacts) {
    if (await protectContact(contact, demoRouter, { dryRun, isContactManaged })) continue;
    const from = String(contact.properties.hubspot_owner_id || "");
    const email = contact.properties.email || "";
    if (!isRemovedRoundRobinOwner(from)) continue;
    if (cfg.INTERNAL_EMAIL_RE.test(email)) { log(`removed-owner: skip internal ${email}`); continue; }
    const ae = pickAE(contact.id);
    if (owners.size && !owners.has(ae.id)) {
      log(`removed-owner: skip contact ${contact.id} roster owner ${ae.id} inactive/unknown`);
      continue;
    }
    log(`removed-owner: contact ${contact.id} (${email}) ${owners.get(from)?.name || from} -> ${ae.name}`);
    if (!dryRun) {
      const cur = await crm.hub("GET", `/crm/v3/objects/contacts/${contact.id}?properties=hubspot_owner_id`);
      if (!isRemovedRoundRobinOwner(cur.properties.hubspot_owner_id)) continue;
      await crm.hub("PATCH", `/crm/v3/objects/contacts/${contact.id}`, { properties: { hubspot_owner_id: ae.id } });
      await crm.sleep(150);
    }
    reassigned++;
  }

  return { checked: contacts.length, reassigned };
}

// ---------- Symptom #1: round-robin ownerless non-booker demo contacts ----------
async function roundRobinNonBookers(owners, { isContactManaged = async () => false, demoRouter = getDemoRouter() } = {}) {
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
    properties: ["email", "createdate", "hubspot_owner_id", SUBMISSION_PROPERTY],
    limit: 100,
  });
  if (!contacts.length) { log("symptom#1: no ownerless demo contacts in window"); return { checked: 0, assigned: 0 }; }

  const ids = contacts.map((c) => String(c.id));
  const cToMeetings = await associations("contacts", ids, "meetings");

  let assigned = 0;
  for (const c of contacts) {
    if (await protectContact(c, demoRouter, { dryRun: cfg.DRY_RUN, isContactManaged })) continue;
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

async function runCycle(overrideStore = null) {
  log(`reconciler start | DRY_RUN=${cfg.DRY_RUN} | pipeline=${cfg.ACTIVE_PIPELINE}`);
  const owners = await getOwners();
  const router = getDemoRouter();
  const isContactManaged = async contactId => {
    if (!overrideStore?.pool) throw new Error('demo_submission_assignment_guard_database_required');
    const table = (await overrideStore.pool.query("SELECT to_regclass('public.demo_submission_lifecycle') AS name")).rows[0]?.name;
    if (!table) return false; // notification worker has not been rolled out yet
    return (await overrideStore.pool.query('SELECT 1 FROM demo_submission_lifecycle WHERE contact_id = $1 LIMIT 1', [String(contactId)])).rows.length > 0;
  };
  const routed = await reconcileRoutedSubmissions(router, { searchAll }, { dryRun: cfg.DRY_RUN, isContactManaged });
  const s1 = await roundRobinNonBookers(owners, { isContactManaged });
  const removed = await reassignRemovedContactOwners(owners, { isContactManaged });
  log(`reconciler done | routed checked=${routed.checked} protected=${routed.protected} | symptom#1 checked=${s1.checked} assigned=${s1.assigned} | removed-owner checked=${removed.checked} reassigned=${removed.reassigned}`);
  return { s1, removed };
}

module.exports = { runCycle, reassignRemovedContactOwners, roundRobinNonBookers, pickAE, log };
