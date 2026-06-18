#!/usr/bin/env node
// Dedicated Sales Admin bot process (consolidated from the gtm-salesadmin-slack-bot repo).
// Runs ONLY the sales-admin workflow — daily calendar digests, post-meeting prompts,
// cancellation/no-show handling, and Calendly verification — in its own Socket Mode
// connection + scheduler. Kept as a separate process from the conversational
// mercedes-claude bot so its HubSpot/Calendly scans never starve that bot's heartbeat.
//
// Deploy as its own Railway service from this repo with start command:
//   node scripts/slack/sales_admin_bot.js
// Env it needs: SLACK_BOT_TOKEN / SLACK_APP_TOKEN / SLACK_SIGNING_SECRET (the sales-admin
// Slack app), HUBSPOT_PRIVATE_TOKEN, GRAIN_API_TOKEN, ANTHROPIC_API_KEY,
// CALENDLY_API_MASTER, CALENDLY_ORGANIZATION, SALES_ADMIN_* (incl. SALES_ADMIN_AE_ROSTER_JSON).
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Load .env.local for local dev; Railway injects env directly.
const envPath = path.resolve(__dirname, '../../.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)="?(.*?)"?\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

// Slack tokens never contain whitespace; strip stray newlines/spaces from a wrapped paste.
function sanitizeToken(value) {
  return String(value == null ? '' : value).replace(/\s+/g, '');
}
for (const key of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_USER_TOKEN']) {
  if (process.env[key]) process.env[key] = sanitizeToken(process.env[key]);
}

const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk').default;
const { createSalesAdminWorkflow, scheduleSalesAdminWorkflow } = require('./sales_admin/workflow');

const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN;
const DEFAULT_HTTP_TIMEOUT_MS = Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 30000);
const HUBSPOT_MAX_ATTEMPTS = Number(process.env.HUBSPOT_MAX_ATTEMPTS || 5);

function hubspotRequestOnce(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint.startsWith('http') ? endpoint : `https://api.hubapi.com${endpoint}`);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        if (data) { try { parsed = JSON.parse(data); } catch { parsed = data; } }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = parsed && typeof parsed === 'object' ? (parsed.message || parsed.error || JSON.stringify(parsed)) : parsed;
          const err = new Error(`HubSpot ${res.statusCode}: ${msg}`);
          err.statusCode = res.statusCode;
          err.retryAfterMs = Number(res.headers['retry-after']) > 0 ? Number(res.headers['retry-after']) * 1000 : 0;
          reject(err);
          return;
        }
        resolve(parsed);
      });
    });
    req.setTimeout(DEFAULT_HTTP_TIMEOUT_MS, () => req.destroy(new Error(`HubSpot request timed out after ${DEFAULT_HTTP_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Retry HubSpot 429 (secondly limit) and transient 5xx with backoff, honoring Retry-After.
async function hubspotRequest(endpoint, method = 'GET', body = null) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await hubspotRequestOnce(endpoint, method, body);
    } catch (err) {
      const retryable = err.statusCode === 429 || (err.statusCode >= 500 && err.statusCode < 600);
      if (!retryable || attempt >= HUBSPOT_MAX_ATTEMPTS) throw err;
      const waitMs = err.retryAfterMs || Math.min(500 * 2 ** (attempt - 1), 8000);
      console.log(`HubSpot ${err.statusCode}; retry ${attempt}/${HUBSPOT_MAX_ATTEMPTS - 1} in ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

// Minimal HTTP server so Railway's health check has a port to hit.
function startHealthServer() {
  const port = Number(process.env.PORT || 8080);
  http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); })
    .listen(port, () => console.log(`  Health check on port ${port}`));
}

// Detect a wedged/flapping Socket Mode connection and exit so Railway restarts it.
function startConnectionWatchdog(app, { intervalMs = 30000, maxFailures = 5 } = {}) {
  let consecutiveFailures = 0;
  const timer = setInterval(async () => {
    try {
      await app.client.auth.test();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      console.log(JSON.stringify({ event: 'salesadmin_watchdog_check_failed', consecutive_failures: consecutiveFailures, error: error.data?.error || error.code || error.message }));
      if (consecutiveFailures >= maxFailures) {
        console.log(JSON.stringify({ event: 'salesadmin_watchdog_exit', reason: 'connection unhealthy; exiting so Railway restarts a fresh process' }));
        process.exit(1);
      }
    }
  }, intervalMs);
  timer.unref();
}

async function main() {
  startHealthServer();
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
  });
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const salesAdminWorkflow = createSalesAdminWorkflow({ app, hubspotRequest, anthropic, env: process.env, logger: console });
  salesAdminWorkflow.registerHandlers();

  await app.start();
  console.log('Sales Admin bot running in socket mode');
  startConnectionWatchdog(app);
  await salesAdminWorkflow.initializeChannels();
  scheduleSalesAdminWorkflow(salesAdminWorkflow);
  console.log(`  HubSpot: ${HUBSPOT_TOKEN ? 'ready' : 'NOT CONFIGURED'}`);
  console.log(`  Calendly verification: ${process.env.CALENDLY_API_MASTER || process.env.CALENDLY_API ? 'ready' : 'NOT CONFIGURED'}`);
}

if (require.main === module) {
  process.on('unhandledRejection', (err) => console.error('Unhandled async error:', err?.message || err));
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { hubspotRequest };
