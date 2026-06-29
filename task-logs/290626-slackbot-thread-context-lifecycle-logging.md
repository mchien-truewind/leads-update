# 290626 - Slackbot Thread Context And Lifecycle Logging

## What Was Asked

Mercedes asked to add structured logging around the Slackbot lifecycle and separately explain what was wrong with the bot after it replied without context to a thread question: `@mercedes-claude what's the source for this?`

## What Was Done

- Updated `scripts/slack/slack_bot.js`.
- Added structured JSON lifecycle logs for Slack mention handling:
  - `app_mention_received`
  - `received`
  - `history_fetched`
  - `history_fetch_error`
  - `history_fetch_failed`
  - `context_prepared`
  - `model_selected`
  - `tool_call`
  - `reply_posted`
  - `handler_error`
- Kept lifecycle logs metadata-only: channel/thread IDs, counts, roles, model/tool names, reply length, and sanitized error strings. No raw Slack text is logged in the new structured lifecycle events.
- Added `sanitizeLogValue()` for token-like values in new error logs and Slack-facing Claude error replies.
- Fixed the thread context bug:
  - The old path coalesced messages and dropped a leading non-user message so the Anthropic API payload started with a user role.
  - In bot-alert threads, that leading non-user message was the exact parent alert context the user was asking about.
  - Added `mergeSlackThreadMessages()` to preserve leading bot-authored context by folding it into the first user message as prior Slack thread context.
- Fixed the edited-mention no-response case:
  - The pasted follow-up was edited to add `@mercedes-claude`.
  - Production logs showed the earlier 1:30 `app_mention` but no later `app_mention` for the edited follow-up.
  - Added a `message_changed` path that responds only when an edit newly adds this bot's Slack mention.
  - Added dedupe for edited-message mention events so repeated Slack retries or duplicate edit events do not double-handle the same edited message.
- Hardened Socket Mode watchdog behavior:
  - The old watchdog used `auth.test()`, which can succeed even when the Socket Mode WebSocket is disconnected.
  - The watchdog now tracks actual socket lifecycle state and exits if the socket stays non-connected beyond `SLACK_WATCHDOG_MAX_DISCONNECTED_MS` (default 120 seconds), allowing Railway to restart a fresh process.
- Exported the new merge/sanitize helpers for tests.
- Updated `scripts/slack/tests/slack_bot_hubspot.test.js` with tests for:
  - Preserving leading bot context for the pasted demo/Calendly-style thread.
  - Keeping normal user/assistant/user conversation shape unchanged.
  - Synthesizing a user message when only bot context remains.
  - Maintaining alternation after folding leading bot context.
  - Redacting Slack/Anthropic/Bearer token-like strings in log values.

## Decisions Made

- Preserved bot-authored parent alerts as user-side context rather than as assistant messages because Anthropic message arrays must start with a user role.
- Did not log raw Slack message content in the lifecycle events, even though the handler still passes full thread context to Claude for functionality.
- Did not deploy from the local working tree because there are unrelated dirty changes in `scripts/slack/sales_admin/workflow.js` and `scripts/slack/tests/sales_admin_workflow.test.js`.

## Mistakes, Blockers, And Fixes

- Initial implementation called the old `mergeMessages()` inside the new merge helper, which had already dropped leading assistant context. The focused test caught this. Fixed by splitting out `coalesceConsecutiveMessages()` and using it directly in `mergeSlackThreadMessages()`.
- Claude code review flagged possible secret leakage in error logs. Fixed by sanitizing token-like strings before logging or posting Claude handler errors.
- Deployment remains blocked by unrelated dirty worktree state; shipping from the current directory could include unrelated sales-admin changes.

## What Was Learned

- The pasted `what's the source for this?` failure was not a Socket Mode miss. The bot received the mention and responded, but it had lost the parent thread context before calling Claude.
- The pasted edited follow-up (`cc @mercedes-claude (edited)`) is a no-response bug caused by Slack edit semantics: adding the bot mention via edit does not arrive as a normal `app_mention`, so the bot needs an explicit `message_changed` path.
- `fetchThreadHistory()` marks Slack `bot_id` messages as `assistant`. That is useful for normal assistant conversation history but dangerous when a thread starts with automated bot alerts that the user later asks about.
- Socket Mode reconnects may still explain true no-response cases, but this specific example was a context-preparation bug.

## Verification

- `node --check scripts/slack/slack_bot.js`
- `node --check scripts/slack/tests/slack_bot_hubspot.test.js`
- `node --test scripts/slack/tests/slack_bot_hubspot.test.js`
- `node --test scripts/slack/tests/slack_bot_hubspot.test.js scripts/slack/tests/lead_status_sync.test.js scripts/slack/tests/calendly_hubspot.test.js scripts/slack/tests/gtm_ops.test.js`
  - Result: 12/12 tests passed.
- Added tests for edited-mention helper detection/dedupe.
- Claude review:
  - Completion review returned `complete=true`.
  - Code review confirmed the diagnosis/fix shape and requested sanitizer + edge tests.
  - Re-review found no remaining blocker on the call site, sanitizer, or edge-test coverage.

## Follow-Ups

- Deploy through a clean commit/PR path that includes only the Slackbot fix files, or first resolve the unrelated sales-admin dirty changes.
- After deployment, inspect Railway logs for `slack_message_lifecycle` events and correlate missed mentions against `app_mention_received`, `history_fetched`, `context_prepared`, and `reply_posted`.
- After deployment, verify edited-message mentions log `edited_app_mention_received`.
- Continue monitoring Socket Mode pong timeout/reconnect windows for true no-response incidents where no `app_mention_received` event appears.
