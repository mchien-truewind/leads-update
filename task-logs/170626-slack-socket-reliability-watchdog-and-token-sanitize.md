# 170626 — Slack bot reliability: confirmed root cause + watchdog + token sanitization

## What was asked
Fix the `leads-update` Slack bot's intermittent non-responses ("sometimes doesn't
respond at all"), and confirm whether the suspected cause is the real one.

## Confirmation (this is the key part)
Earlier the cause was only *hypothesized* (single instance, no watchdog). A wider
scan of the production deploy logs produced direct evidence:

```
[WARN] socket-mode:SlackWebSocket:1 A pong wasn't received from the server before the timeout of 5000ms!   (×3+)
[WARN] bolt-app http request failed Invalid character in header content ["Authorization"]                  (×2)
```

Two confirmed problems:
1. **Socket Mode is flapping.** Missed heartbeat pongs cause the socket-mode client to
   tear down + reconnect; events Slack sends during the gap are lost (Socket Mode does
   not redeliver). A pong missed within 5s frequently means the **Node event loop was
   blocked** (heavy Claude/cron work in this single overloaded process) so the client
   couldn't answer the ping — i.e. the process starves its own heartbeat.
2. **`SLACK_USER_TOKEN` is corrupted** — it contains an embedded newline + spaces at
   character ~59 (a wrapped copy-paste). That produces the "Invalid character in header
   content" failures on Slack Web API calls that use the user token (thread history,
   user profile lookups), and the same class of bug would silently break a reply if the
   bot token were affected.

There was **no socket-health logging** before (Bolt `logLevel` unset, no custom logs),
which is why this couldn't be confirmed sooner.

## What was done — branch `fix/slack-socket-reliability`
- **Token sanitization:** added `sanitizeToken()` and normalize `SLACK_BOT_TOKEN`,
  `SLACK_APP_TOKEN`, `SLACK_USER_TOKEN` in place at startup (strips all whitespace, so a
  wrapped/newline-injected token is harmless). Logs `sanitized_credential_env` when it
  cleans one. Fixes the confirmed Authorization-header bug for every consumer.
- **Connection watchdog:** `startConnectionWatchdog(app)` — (a) attaches best-effort
  listeners to the Socket Mode client and logs `slack_socket_lifecycle` so flapping is
  now observable, and (b) probes `auth.test()` every 30s; after 5 consecutive failures
  it `process.exit(1)` so Railway's `ON_FAILURE` policy restarts a fresh process.
  Tunable via `SLACK_WATCHDOG_INTERVAL_MS` / `SLACK_WATCHDOG_MAX_FAILURES`.
- Tests: `testSanitizeTokenStripsWhitespace`. All slack tests pass.

## Decisions made
- **Watchdog only (no `supervisor.js`).** On Railway the platform restarts on non-zero
  exit (`restartPolicyType=ON_FAILURE`, confirmed live), so the laptop-style supervisor
  wrapper from `mini-mercedes-harness` isn't needed here — we copied the *idea*, not the
  process model. The watchdog is the safety net; transient pong-timeout reconnects are
  already handled by the socket-mode client itself.
- **Fix the token in code, not (only) in env.** Code sanitization makes the bot robust
  to a malformed env var regardless of how it was set.

## Open questions / next steps
- **Deeper fix for event-loop starvation:** the pong timeouts point at one process doing
  interactive Slack + 3 cron jobs + webhooks + long Opus agentic loops. The durable fix
  is to move the heavy/cron/webhook workload off the socket process (separate Railway
  service or worker) so the heartbeat is never starved. Larger change — not in this PR.
- **Railway:** bump `restartPolicyMaxRetries` (currently 10) so a burst of restarts
  doesn't exhaust the policy and leave the bot down.
- **Clean the `SLACK_USER_TOKEN` Railway var** too (code handles it, but hygiene).
- Confirm no stray laptop process holds the same `SLACK_APP_TOKEN`.
- PR is review-only — not merged, not deployed.
