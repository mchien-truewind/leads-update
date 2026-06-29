# 290626 - Sales Admin Grain Reviewer Gate

## What Was Asked

Implement the reviewed plan to prevent Sales Admin post-meeting recaps from surfacing the wrong Grain recording. The triggering issue was a Sarah recap where a sensitive CEO/executive call was surfaced instead of the actual customer call.

## What Was Done

- Updated `scripts/slack/sales_admin/workflow.js`.
- Added a fail-closed Grain match review gate inside `fetchGrainForMeeting`.
- Added deterministic match evidence and approval only for:
  - direct HubSpot/calendar metadata match, or
  - AE email present plus exact HubSpot meeting contact email overlap.
- Added an Anthropic-backed reviewer for ambiguous candidates using the existing runtime Anthropic client and strict JSON parsing.
- Routed reviewer reject/uncertain/error outcomes to `{ recording: null, grainUrl: '' }` with `grain_review_*` source values.
- Updated no-show/default Slack behavior so `grain_review_*` sources use the existing no-Grain prompt path and do not expose Grain links or transcript-derived summaries.
- Added state audit fields for `grainReview` decision, reason, reviewer, and matched emails.
- Added tests in `scripts/slack/tests/sales_admin_workflow.test.js` for the sensitive Sarah-style false positive, deterministic valid-match approvals, direct metadata approvals, reviewer errors, and no Grain URL in rejected Slack prompts.

## Decisions Made

- Fail closed by default: any ambiguous, rejected, malformed, unavailable, or errored reviewer path hides the Grain recording and treats it like no verified recording.
- Kept deterministic code responsible for candidate evidence, schema parsing, and routing.
- Used the LLM only for ambiguous judgment about whether the candidate call is truly the AE plus prospect/customer call.
- Did not change morning/tomorrow digests, Railway configuration, HubSpot write behavior, or deployment state.

## Mistakes, Blockers, And Fixes

- The first test assertion checked for the text `Grain recording`, but the no-show copy intentionally says `no Grain recording`. Fixed the test to assert that no `https://grain.com` URL appears in Slack blocks.
- `claude-review` hung and then returned an unusable review claiming corrupted tool observations. Replaced it with self-contained `claude -p` code-quality review packets.
- Pre-existing unrelated dirty files were present in `scripts/railway-truewind.js`, `scripts/slack/slack_bot.js`, and `scripts/slack/tests/slack_bot_hubspot.test.js`; they were not touched for this task.

## What Was Learned

- The risky pre-existing branch was the Grain fallback that could accept an AE plus any external email inside the time window.
- The safe gate is exact HubSpot contact overlap or direct metadata; anything broader needs reviewer approval and must fail closed.
- `grain_review_*` source values must route through the same Slack no-Grain/no-show path to keep sensitive links out of post-meeting recaps.

## Verification

- `node --test scripts/slack/tests/sales_admin_workflow.test.js` passed: 48/48.
- `node --test scripts/slack/tests/grain_client.test.js` passed: 3/3.
- Claude code-quality review via login-backed `claude -p --model claude-opus-4-8` returned `approval=yes` with no blockers.
- Claude completion review via login-backed `claude -p --model claude-opus-4-8` returned `complete=true`.
- Chokepoint grep confirmed post-meeting extraction, Slack blocks, prompt marker notes, and writeback state use `fetchGrainForMeeting` before any `grainUrl` from the selected candidate is exposed.

## Follow-Ups

- Deploy through the normal Truewind `leads-update` path when ready.
- If future debugging needs more observability, add structured metrics for `grain_review_rejected`, `grain_review_uncertain`, and `grain_review_error` counts.
