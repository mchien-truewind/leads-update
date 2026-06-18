// Shared config for the inbound deal-flow reconciler.
// Ported from the retired gtm-ops repo into leads-update so this backstop lives in the
// same codebase as its root-cause fix (the Calendly webhook). The IDs below MUST stay in
// sync with CONFIG in ../calendly_hubspot.js — gtm_ops_bot.js asserts this on startup and
// refuses to run live if they drift.

// Inbound demo funnel pipeline + first stage (HubSpot portal 43974586).
const ACTIVE_PIPELINE = process.env.ACTIVE_PIPELINE_ID || "105321581";
const MQL_STAGE = process.env.MQL_STAGE_ID || "1307720553";

// Demo form conversion-event signal (recent_conversion_event_name CONTAINS_TOKEN this).
const DEMO_FORM_TOKEN = process.env.DEMO_FORM_TOKEN || "Book Demo Form";

// Round-robin AE roster for ownerless non-booker leads (symptom #1).
// Confirmed by Mercedes 2026-06-17. Owner IDs in HubSpot.
// NOTE: this is intentionally NOT the same set as the Calendly host->owner map in
// calendly_hubspot.js. That map = who *hosts* a booked demo (owns the booked deal).
// This roster = which AEs get *new ownerless* leads round-robined. The two legitimately differ.
const AE_ROSTER = (process.env.AE_ROSTER_JSON
  ? JSON.parse(process.env.AE_ROSTER_JSON)
  : [
      { id: "84547076", name: "Sarah Elix" },
      { id: "89305622", name: "Xavier Marco" },
      { id: "93961770", name: "Andrew Moyer" },
      { id: "93961773", name: "Ari Nachman" },
      { id: "559564379", name: "Alex Lee" },
    ]);

// Don't round-robin internal/test submissions (own domain).
const INTERNAL_EMAIL_RE = /@trytruewind\.com$/i;

// How far back the reconciler looks each run.
const MEETING_LOOKBACK_MIN = Number(process.env.MEETING_LOOKBACK_MIN || 180); // symptom #2: meetings modified in last N min
const CONTACT_MIN_AGE_MIN = Number(process.env.CONTACT_MIN_AGE_MIN || 30);    // symptom #1: grace period before round-robin
const CONTACT_MAX_AGE_DAYS = Number(process.env.CONTACT_MAX_AGE_DAYS || 7);   // symptom #1: don't reach back forever

const DRY_RUN = process.env.DRY_RUN !== "false"; // default true; set DRY_RUN=false to write

module.exports = {
  ACTIVE_PIPELINE,
  MQL_STAGE,
  DEMO_FORM_TOKEN,
  AE_ROSTER,
  INTERNAL_EMAIL_RE,
  MEETING_LOOKBACK_MIN,
  CONTACT_MIN_AGE_MIN,
  CONTACT_MAX_AGE_DAYS,
  DRY_RUN,
};
