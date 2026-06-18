#!/usr/bin/env node
// Dedicated GTM-ops reconciler worker (consolidated from the retired gtm-ops repo).
// Backstop to the leads-update Calendly webhook:
//   Symptom #2: Active Pipeline deal owner = booked meeting host.
//   Symptom #1: round-robin ownerless non-booker demo-form contacts to the AE roster.
//
// Runs as its OWN Railway service from this repo (process-isolated from the Slack bots so
// its HubSpot scans never starve a Socket Mode heartbeat) with start command:
//   node scripts/slack/gtm_ops_bot.js
// Env it needs: HUBSPOT_PRIVATE_TOKEN, DRY_RUN (set "false" to write), INTERVAL_MIN (poll
// cadence, default 5), plus optional overrides in gtm_ops/config.js. PORT for the health check.
const fs = require('fs');
const path = require('path');
const http = require('http');

// Load .env.local for local dev; Railway injects env directly. Must run BEFORE requiring the
// reconciler, because gtm_ops/hubspot.js throws at require time if no HubSpot token is set.
const envPath = path.resolve(__dirname, '../../.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)="?(.*?)"?\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const cfg = require('./gtm_ops/config');
const { runCycle } = require('./gtm_ops/reconciler');
const { CONFIG } = require('./calendly_hubspot');

const INTERVAL_MIN = (() => {
  const n = Number(process.env.INTERVAL_MIN);
  return Number.isFinite(n) && n > 0 ? n : 5; // poll every 5 min by default
})();
// If a cycle hasn't succeeded in this long, the worker is wedged -> exit so Railway restarts.
const STALE_MS = Math.max(INTERVAL_MIN * 3, 15) * 60000;

let lastSuccessAt = Date.now(); // seed at boot so the staleness check has a baseline
let lastError = null;
let cycles = 0;
let everSucceeded = false; // distinguishes "never succeeded yet" from "was healthy, now wedged"

function log(...a) { console.log(new Date().toISOString(), '[gtm-ops]', ...a); }

// The reconciler's pipeline/stage IDs MUST match the Calendly webhook's CONFIG (single source of
// truth for the funnel). If they ever drift, a backstop would write against a different funnel
// than the webhook it backs up. Refuse to run live on mismatch; warn (don't block) in dry-run.
function assertConstantsInSync() {
  const mismatches = [];
  if (cfg.ACTIVE_PIPELINE !== CONFIG.pipelineId) mismatches.push(`pipeline ${cfg.ACTIVE_PIPELINE} != webhook ${CONFIG.pipelineId}`);
  if (cfg.MQL_STAGE !== CONFIG.newDealStageId) mismatches.push(`MQL stage ${cfg.MQL_STAGE} != webhook ${CONFIG.newDealStageId}`);
  if (!mismatches.length) return;
  log('CONSTANT DRIFT vs calendly_hubspot CONFIG:', mismatches.join('; '));
  if (!cfg.DRY_RUN) {
    log('refusing to run live with drifted funnel constants; exiting so this is fixed before writing');
    process.exit(1);
  }
}

// Minimal HTTP server so Railway's health check has a port. Reports staleness as 503.
function startHealthServer() {
  const port = Number(process.env.PORT || 8080);
  const server = http.createServer((req, res) => {
    const stale = Date.now() - lastSuccessAt > STALE_MS;
    const body = JSON.stringify({
      ok: !stale,
      dry_run: cfg.DRY_RUN,
      interval_min: INTERVAL_MIN,
      cycles,
      last_success_at: new Date(lastSuccessAt).toISOString(),
      last_error: lastError,
    });
    res.writeHead(stale ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  server.on('error', (err) => {
    console.error(`Health server failed to bind port ${port}: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, () => log(`health check on port ${port}`));
}

// Independent of the loop: if no cycle has SUCCEEDED within STALE_MS, the worker is wedged
// (hung fetch, stuck loop) — exit so Railway's restart policy brings up a fresh process.
function startStalenessWatchdog() {
  const timer = setInterval(() => {
    // Until the first cycle ever succeeds, allow a longer grace (cold-start scans, a HubSpot
    // rate-limit/outage) so a slow first run isn't killed into a tight crash-loop. Once we've
    // seen one success, hold the worker to the normal staleness bound.
    const limit = everSucceeded ? STALE_MS : Math.max(STALE_MS, INTERVAL_MIN * 60000 * 4);
    if (Date.now() - lastSuccessAt > limit) {
      log(`no successful cycle in ${Math.round((Date.now() - lastSuccessAt) / 60000)}min (limit ${Math.round(limit / 60000)}min); exiting for restart`);
      process.exit(1);
    }
  }, 60000);
  timer.unref();
}

async function main() {
  startHealthServer();
  assertConstantsInSync();
  log(`worker start | DRY_RUN=${cfg.DRY_RUN} | every ${INTERVAL_MIN}min | pipeline=${cfg.ACTIVE_PIPELINE}`);
  log(`HubSpot: ${process.env.HUBSPOT_PRIVATE_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN ? 'ready' : 'NOT CONFIGURED'}`);
  startStalenessWatchdog();

  // Sequential loop (never overlaps): run a cycle, then sleep INTERVAL_MIN.
  for (;;) {
    try {
      await runCycle();
      lastSuccessAt = Date.now();
      lastError = null;
      everSucceeded = true;
      cycles++;
    } catch (e) {
      lastError = e && e.message ? e.message : String(e);
      console.error('cycle error:', lastError);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MIN * 60000));
  }
}

if (require.main === module) {
  process.on('unhandledRejection', (err) => console.error('Unhandled async error:', err?.message || err));
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { assertConstantsInSync, INTERVAL_MIN };
