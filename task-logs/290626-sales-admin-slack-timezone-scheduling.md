# 290626 - Sales Admin Slack Timezone Scheduling

## What Was Asked

Sarah is in Eastern time, so Sales Admin morning calendar meetings and non-post-meeting updates were arriving too late. The user asked whether the bot could make the timing local to each person's Slack time.

## What Was Done

- Updated `scripts/slack/sales_admin/workflow.js`.
- Updated `scripts/slack/tests/sales_admin_workflow.test.js`.
- Added per-AE timezone resolution:
  - Prefer Slack profile timezone from `users.info` (`user.tz`).
  - Fall back to an optional roster timezone field (`timezone`, `timeZone`, or `time_zone`).
  - Fall back to global `SALES_ADMIN_TZ`, then Pacific.
- Added Sarah's default roster fallback timezone: `America/New_York`.
- Made morning summaries and tomorrow summaries compute date windows, weekend skips, idempotency date keys, and display times in each AE's resolved timezone.
- Changed daily morning/tomorrow scheduling to group AEs by resolved timezone, so Eastern users get the configured send hour in Eastern time and Pacific users keep Pacific timing.
- Kept post-meeting scan as an interval-based flow tied to actual meeting end time and existing delay/lookback behavior.
- Made cancellation notifications display the original meeting time in the AE's resolved timezone.
- Added startup log events:
  - `salesadmin_timezone_resolved`
  - includes AE name, HubSpot owner ID, resolved timezone, and source (`slack_profile`, `roster`, or `default`).
  - default fallback logs as a warning so missing Slack scope or missing roster timezone is visible.

## Decisions Made

- Slack profile timezone is the primary source of truth because the user asked for "that person's Slack time."
- Roster timezone remains as an explicit fallback for cases where Slack `users.info` is unavailable or lacks scope.
- Sarah gets a code-level `America/New_York` fallback, but production env can override the roster entirely with `SALES_ADMIN_AE_ROSTER_JSON`.
- Timezone groups are fixed at process startup. Slack profile timezone changes require a process restart before daily timers move.
- Did not change live Railway, Slack, HubSpot, or credentials.

## Mistakes, Blockers, And Fixes

- Initial implementation only added roster fallback and per-AE usage; the user clarified they wanted Slack-local timezone. Fixed by adding Slack `users.info` lookup and cache.
- Code quality review flagged two conditional blockers:
  - Verify Slack timezone caching happens before scheduling.
  - Verify timer math uses the target IANA timezone rather than host timezone.
- Verified the entrypoint awaits `salesAdminWorkflow.initializeChannels()` before `scheduleSalesAdminWorkflow()`.
- Added tests for `America/New_York` timer math and cached Slack timezone precedence.
- Renamed the standalone helper to `rosterTimeZoneForAe` to avoid confusion with the workflow method that includes Slack cache precedence.

## What Was Learned

- The Sales Admin bot startup path in `scripts/slack/sales_admin_bot.js` starts Slack Socket Mode, then awaits `initializeChannels()`, then schedules workflows.
- Slack timezone lookup requires `users.info`; if the app lacks `users:read`, the code now safely falls back and logs a warning.
- If production uses `SALES_ADMIN_AE_ROSTER_JSON` and Slack timezone lookup is unavailable, Sarah's code-level default roster timezone will not apply unless the env roster includes `timezone`/`time_zone`.

## Verification

- `node scripts/slack/tests/sales_admin_workflow.test.js` passed: 54/54.
- `npm test` passed: 83/83.
- Claude code-quality review initially returned conditional blockers; follow-up changes resolved them.
- Claude code-quality re-review approved with no blockers.
- Claude completion review returned `complete=true`.
- `claude-planning-review` on Fable was unavailable, so the completion review used the available login-backed `claude-review` wrapper instead.

## Follow-Ups

- On deploy, check Sales Admin startup logs for `salesadmin_timezone_resolved` and confirm Sarah resolves to `America/New_York` with source `slack_profile` or `roster`.
- If production `SALES_ADMIN_AE_ROSTER_JSON` fully replaces defaults and Slack `users.info` is missing scope, add `time_zone: "America/New_York"` for Sarah in the env roster or grant the Slack app `users:read`.
- Restart the Sales Admin process after Slack profile timezone changes.
