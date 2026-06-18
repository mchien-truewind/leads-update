# 180626 — Consolidate the sales-admin bot into the leads-update repo

## What was asked
Move the GTM sales-admin feature (calendar digests, post-meeting prompts, no-show
handling, Calendly verification) out of the separate `gtm-salesadmin-slack-bot` repo and
into `leads-update`, so there's one codebase that auto-deploys and no service drift.

## Why (context discovered this session)
The `gtm-salesadmin-slack-bot` Railway service had stopped auto-deploying and ran a
**June-8 build for 10 days** — so every fix we merged to that repo was invisible in prod.
Separate repos/services also caused: duplicate HubSpot/Slack load (429s, socket
splitting), and code drift (two `createNote`s, two owner maps, the Alex Lee owner-id
mismatch). Consolidation removes all of that.

## Architecture decision
Sales-admin has **interactive buttons** (No-Show / Confirm & Save / Edit Notes) that need
a live Socket Mode connection — so it can't be a worker cron, and it shouldn't ride on the
conversational bot's socket (would re-introduce the heartbeat starvation we fixed by
splitting bot/worker). So it runs as its **own dedicated process** from the leads-update
repo.

## What was done — branch `fix/consolidate-sales-admin`
- Copied `scripts/slack/sales_admin/{workflow,grain_client,state,hubspot_sales_admin}.js`
  into `leads-update`. Its only shared dep, `discovery_digest`, already exists here with
  the exact exports it needs (verified — module imports clean).
- New entrypoint `scripts/slack/sales_admin_bot.js`: own Bolt app (Socket Mode for
  buttons), own `hubspotRequest` with 429/5xx retry, Anthropic client, health server,
  connection watchdog, then `createSalesAdminWorkflow` → `registerHandlers` →
  `app.start` → `initializeChannels` → `scheduleSalesAdminWorkflow`.
- Added `npm run sales-admin` script.
- Copied tests (`sales_admin_workflow.test.js`, `grain_client.test.js`). 42 + 3 pass.

## Deploy plan (separate step, after PR merges)
Repoint the existing `gtm-salesadmin-slack-bot` Railway service to deploy the
**`leads-update`** repo with start command `node scripts/slack/sales_admin_bot.js`. It
already has the env (sales-admin Slack tokens, HubSpot, Grain, Calendly, roster,
SALES_ADMIN_*), so no env migration. This also fixes the stale auto-deploy (it'll track
`leads-update` main). Then archive the `gtm-salesadmin-slack-bot` repo.

## Open questions / next steps
- After repoint, confirm only ONE sales-admin process runs (no double digests/scans).
- State file (`data/sales_admin_state.json`) is ephemeral without a volume — same as
  before; consider a Railway volume so prompt dedup survives redeploys.
- The gtm repo's `slack_bot.js` (a stale fork of the conversational bot) can be deleted
  once the service is repointed.
