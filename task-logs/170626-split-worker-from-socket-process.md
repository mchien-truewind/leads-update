# 170626 — Split background workload off the Socket Mode process (BOT_ROLE)

## What was asked
Follow-up to the reliability work: fully address the Socket Mode "pong timeout"
flapping by moving the heavy/non-interactive workload (cron jobs + webhooks) off the
process that holds the Slack Socket Mode connection, so the heartbeat isn't starved.

## What was done — branch `fix/split-worker-from-socket` (off `main`)
- Added `resolveBotRoles(role)` and a `BOT_ROLE` env switch in `startSlackBot`:
  - `all` (default) — Socket Mode + webhooks + crons in one process (legacy behavior;
    nothing changes for the current single service).
  - `bot` — Socket Mode interactive only; no scheduled jobs.
  - `worker` — crons + webhooks only; no Socket Mode (scheduled jobs post via the Slack
    Web API `app.client`, which works without a socket connection).
- The HTTP server (health check + webhook routes) runs in every role; webhook routes
  only receive traffic on whichever service the public domain points at.
- The connection watchdog only starts when Socket Mode is running.
- Test: `testResolveBotRoles`. All slack tests pass.

## Decisions made
- **Backward-compatible by default.** `BOT_ROLE` unset ⇒ `all` ⇒ identical to today, so
  this PR is safe to merge before any infra change.
- **No `supervisor.js`** — Railway restarts on exit (ON_FAILURE), as with the watchdog.
- Minor behavior improvement: in `all` mode, crons now run even if Socket Mode fails to
  start (they use the Web API), whereas before a socket failure skipped them.

## Deployment (the part that delivers the benefit — needs a Railway change)
The code split only helps once it runs as **two services in the same `mchien-truewind`
Railway project** (NOT a separate project — services share env vars + private networking):
1. Existing `leads-update` service → set `BOT_ROLE=bot` (interactive Slack only).
2. New service from the same repo → set `BOT_ROLE=worker`; **move the public webhook
   domain (Calendly/Instantly/Read.ai) to this worker service.**
3. Verify crons run in exactly one place (the worker) — they are disabled on the `bot`
   service, so no double-posting.

## Open questions / next steps
- Confirm the hypothesis post-split: watch for the disappearance of
  `socket-mode … pong wasn't received` warnings on the `bot` service once the worker
  carries the cron/webhook load.
- The pong-timeout → event-loop-starvation link is strong but not 100% proven; if flaps
  persist on a dedicated `bot` service, the cause is network, not load.
