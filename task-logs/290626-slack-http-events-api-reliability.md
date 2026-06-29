---
autonomy_matrix:
  scope: "Slackbot HTTP Events API reliability implementation"
  mutation_type: "code_and_tests"
  external_state: "none_yet"
  risk_level: "medium"
  qa_gate: "focused code/test review; no external Slack/Railway mutation in implementation step"
---

# 290626 - Slack HTTP Events API Reliability

## What Was Asked

Mercedes asked to implement the plan to add Slack HTTP Events API support in Slack/Railway so the `@mercedes-claude` bot is less dependent on Socket Mode delivery.

## What Was Done

- Updated `scripts/slack/slack_bot.js`.
- Added `POST /slack/events` to the existing HTTP server.
- Added Slack Events API request verification:
  - raw request body parsing
  - `X-Slack-Signature` HMAC SHA256 verification
  - `X-Slack-Request-Timestamp` freshness check
  - signed `url_verification` challenge handling
  - `event_callback` fast `200 ok` ack before async processing
- Routed HTTP Events API callbacks through the existing Slackbot behavior:
  - `app_mention`
  - edited-message mentions via `message_changed`
  - direct messages
- Added a Slack Web API `say` adapter so HTTP events can reuse `handleMessage`.
- Added in-process event dedupe keyed by canonical Slack message identity (`channel:message_ts`, with edited timestamp for edits).
- Added explicit `SLACK_EVENT_TRANSPORT` gating:
  - `socket` default preserves current Socket Mode behavior and rollback.
  - `http` disables Socket Mode startup and ignores Socket Mode events, so split Railway services do not double-process the same Slack event.
  - `dual` is available only for deliberate canary/local testing.
- Exported testable helpers for signature verification, HTTP event normalization, transport resolution, route startup, and event dedupe.
- Updated `scripts/slack/tests/slack_bot_hubspot.test.js` with tests for:
  - transport resolution and role behavior
  - Slack signature verification
  - app mention normalization
  - edited mention normalization
  - retry dedupe
  - signed `/slack/events` URL verification
  - invalid signature rejection
  - malformed JSON rejection
  - `event_callback` fast ack

## Decisions Made

- Chose a hard single-transport cutover instead of trying to make HTTP and Socket Mode simultaneously active in production.
- Kept `socket` as the default transport so the merged code is a safe no-op until Railway/Slack are deliberately cut over.
- Used `http` as the production cutover transport; this allows the worker service to handle Slack Events API callbacks while the old bot service can remain available but will not open or process Socket Mode.
- Kept the missed-mention backfill scanner out of this slice. HTTP Events API improves delivery/retry behavior, but backfill is still the stronger follow-up for recovery after outages beyond Slack's retry window.

## Mistakes, Blockers, And Fixes

- Initial implementation only deduped inside the HTTP route. Reviewer flagged that if Socket Mode and HTTP both received the same event during migration, app mentions and DMs could run twice.
- Added shared canonical dedupe keys across HTTP and Socket handlers.
- Reviewer then flagged the real Railway split-service issue: in-process dedupe does not cross `leads-update-bot` and `leads-update`.
- Fixed by adding `SLACK_EVENT_TRANSPORT` as a hard single-transport gate. In `http` mode, Socket Mode startup is disabled and Socket handlers ignore events.
- The Claude review wrapper hung with no output, and `claude-planning-review` failed because Claude Fable was unavailable. Used login-backed direct `claude -p` once, but it also timed out. Completed required review with independent reviewer agents instead.

## What Was Learned

- A safe Slack Events API migration in this repo must account for the existing split Railway services, not just duplicate events inside one Node process.
- In this Slack app, Socket Mode and HTTP Events API should be treated as a cutover choice, not a simultaneous production architecture.
- HTTP Events API code can be shipped ahead of Slack admin changes because the default `SLACK_EVENT_TRANSPORT=socket` preserves current behavior.

## Verification

- `node --check scripts/slack/slack_bot.js`
- `node --check scripts/slack/tests/slack_bot_hubspot.test.js`
- `node --test scripts/slack/tests/slack_bot_hubspot.test.js`
- `node --test scripts/slack/tests/slack_bot_hubspot.test.js scripts/slack/tests/lead_status_sync.test.js scripts/slack/tests/calendly_hubspot.test.js scripts/slack/tests/gtm_ops.test.js scripts/slack/tests/test_instantly_positive_reply_alert.js`
  - Result: 13/13 tests passed.
- `git diff --check -- scripts/slack/slack_bot.js scripts/slack/tests/slack_bot_hubspot.test.js task-logs/290626-slack-http-events-api-reliability.md`
- Reviewer feedback:
  - Code-quality reviewer initially found duplicate-processing risk during HTTP/Socket migration.
  - Completion reviewer marked the code slice complete but recommended route-level tests and documenting process-local dedupe limits.
  - Re-review found the split-service dedupe issue; fixed with hard transport gating.
  - Final code-quality re-review found no remaining blocker. It confirmed `SLACK_EVENT_TRANSPORT=http` resolves the split-service duplicate-processing risk by preventing Socket Mode startup and making Socket handlers return early.
  - Final completion re-review returned `complete=true`.
  - Non-blocking caveat from review: `createSlackApp()` still constructs Bolt with `socketMode: true`, so the HTTP worker should keep `SLACK_APP_TOKEN` present unless app construction is made transport-aware later.

## Follow-Ups

- Deploy this code through the normal PR path with only the Slackbot files and this task log staged; there are unrelated dirty repo files that should not be included.
- Slack/Railway cutover after deploy:
  - Set Slack Events API request URL to `https://leads-update-production.up.railway.app/slack/events`.
  - Complete Slack URL verification.
  - Set `SLACK_EVENT_TRANSPORT=http` on the Railway service that should handle HTTP events, likely `leads-update`.
  - Ensure the old `leads-update-bot` Socket Mode service is not processing events, either by the same env gate or by stopping/repurposing it.
  - Keep `SLACK_EVENT_TRANSPORT=socket` rollback available if HTTP setup fails.
- Add the missed-mention backfill scanner as the next reliability layer.
