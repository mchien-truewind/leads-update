# 170526 - Slackbot HubSpot Write Audit

## What Was Asked

The user asked to go through the Slackbot backend and fix bugs that make HubSpot deal/create/update requests unreliable or hallucinatory. The desired behavior is for the Slackbot to act like an AE assistant for HubSpot: execute CRM actions, return concrete IDs/links or exact errors, and avoid unrelated invented summaries.

## What Was Done

- Audited `scripts/slack/slack_bot.js`, focusing on HubSpot write tools, message context handling, authorization, and error responses.
- Confirmed earlier deployed fix already handled:
  - HubSpot `readOnlyDefinition` misclassification.
  - Structured current-message deal creation bypassing Claude.
- Added authorization enforcement to low-level HubSpot write tools:
  - `hubspot_create_contact`
  - `hubspot_update_contact`
  - `hubspot_create_deal`
  - `hubspot_update_deal`
  - `hubspot_create_association`
- Added `context`, `channel_id`, and `slack_user_id` schema fields to low-level HubSpot write tools so Claude can pass Slack metadata into the authorization gate.
- Changed fresh non-thread Slack messages to use only the current message instead of fetching the last 20 channel messages.
- Kept full thread-history fetching for actual Slack threads.
- Tightened the system prompt so the bot reports exact tool/API errors instead of claiming it can always act.
- Changed Claude API failure response from a vague "brain fried" message to an explicit error with no completion claim.
- Updated `scripts/slack/tests/slack_bot_hubspot.test.js` to cover low-level HubSpot write authorization.

## Decisions Made

- Prioritized fail-closed behavior for low-level HubSpot writes. If Claude omits Slack metadata, the write is blocked rather than allowed.
- Removed broad channel-history context for fresh mentions because it was a direct source of unrelated Lafayette/PKF/Sound Community output in a ThinkScan create-deal request.
- Preserved thread history for actual threaded workflows where context is explicitly connected.

## Mistakes, Blockers, And Fixes

- No external HubSpot write smoke test was run in this audit pass. Verification remained local and code-review based to avoid making production CRM changes without a fresh explicit test record request.
- Claude review noted that optional metadata fields can still be omitted by Claude, causing a fail-closed auth error for low-level writes. Accepted because the preferred workflow and structured-deal bypass already provide deterministic paths, and unauthorized writes are worse than blocked writes.

## What Was Learned

- The low-level HubSpot write tools previously did not enforce the same authorization check as `hubspot_push_truewind_prospect`.
- Fresh non-thread channel mentions should not include recent channel history in a CRM action prompt; unrelated channel chatter can be interpreted as tasks or completed work.
- Honest failure output is part of the backend contract for CRM automation.

## Verification

- `node --check scripts/slack/slack_bot.js` passed.
- `node scripts/slack/tests/slack_bot_hubspot.test.js` passed.
- `npm test -- --test-reporter=spec` passed: 13 tests, 13 passing.
- Claude reviewed the uncommitted patch and found no blockers.

## Follow-Ups

- If the team wants full AE parity, add more deterministic structured handlers for common update cases, such as closing a deal lost/won, changing owner, updating deal stage, and adding notes from Slack fields.
- Consider requiring `channel_id` and `slack_user_id` in low-level HubSpot write tool schemas if Claude ever omits them too often.
