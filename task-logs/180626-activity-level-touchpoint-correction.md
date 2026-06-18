# 180626 - Activity Level Touchpoint Correction

## What Was Asked

Mercedes clarified that `bdr_touchpoints_90d` does not need HubSpot owner/BDR attribution. The desired rule is activity-level: count a touchpoint when HubSpot activity shows a call, email sent, or message sent. Email opened is not a touchpoint. She provided three HubSpot contacts as expected examples.

## What Was Done

- Read the three example contacts through the HubSpot API using project-scoped Truewind credentials.
- Confirmed that email-sent examples from Glue are stored as HubSpot notes, while calls are stored as HubSpot call activities.
- Updated `scripts/slack/lead_status_sync.js`:
  - removed the note owner/BDR attribution requirement;
  - added associated call fetching in opt-in note/activity mode;
  - counted non-inbound call activities as touchpoints;
  - kept email-sent and message-sent note matching;
  - kept exclusions for email opens, clicks, bounces, sequence/list/workflow notes, inbound replies, inbound calls, outside-window activity, unmatched notes, empty notes, and duplicates;
  - added `callsScanned` and `callsCounted` stats.
- Updated `scripts/slack/tests/lead_status_sync.test.js` to cover call counting and owner-independent note counting.
- Updated `README.md` to describe activity-level note/call counting instead of BDR-owner-attributed note counting.
- Ran the corrected counter against the three examples:
  - `155862413201`: `0`
  - `222400038445`: `4`
  - `228948885832`: `3`
- Ran the corrected full read-only dry run and saved output to `/tmp/truewind-lead-status-activity-dry-run.json`.

## Decisions Made

- The implementation now follows the literal activity-level pattern: call, email sent, message sent.
- Existing production default remains legacy `engagements`; activity/note mode is still opt-in and should not be enabled live until the call-count ambiguity is resolved.
- Keep preview evidence body-free; activity IDs, channel, reason, timestamp, and owner ID are acceptable for audit.

## Mistakes, Blockers, And Fixes

- Earlier Phase 1 incorrectly required `hubspot_owner_id` on notes. That was removed after Mercedes clarified owner attribution is not needed.
- The middle example exposed a product/data ambiguity:
  - Mercedes expected `222400038445` to count as `1`.
  - The HubSpot API returns `3` associated non-inbound calls and `1` email-sent note in the last 90 days, so the literal activity-level rule counts `4`.
  - Claude Opus flagged this as the only blocker before enabling live note/activity mode: decide whether API-visible calls or UI-visible calls are the source of truth.

## What Was Learned

- HubSpot activity data for list `694` includes calls as separate associated `calls` objects, not notes.
- Glue email events are stored as notes such as `Email sent via Instantly...` and `Email opened...`.
- In the corrected full dry run:
  - `candidateCount`: `358`
  - `contactsEvaluated`: `358`
  - `proposedUpdatedContacts`: `317`
  - `proposedStatusChanges`: `24`
  - `proposedTouchpointFieldChanges`: `312`
  - `notesScanned`: `839`
  - `notesCounted`: `304`
  - `callsScanned`: `267`
  - `callsCounted`: `256`
  - `errors`: `0`

## Verification

- `node scripts/slack/tests/lead_status_sync.test.js` passed.
- `npm test` passed with 70 tests.
- `git diff --check -- README.md scripts/slack/lead_status_sync.js scripts/slack/slack_bot.js scripts/slack/tests/lead_status_sync.test.js` passed.
- Independent code reviewer approved, noting no blockers for Phase 1 dry-run handoff.
- Claude Opus 4.8 approved handoff and identified only the API-visible vs UI-visible call-count ambiguity as a blocker before live enablement.

## Follow-Ups

- Decide whether call touchpoints should count every associated non-inbound HubSpot call activity or only the calls visible/collapsed in the HubSpot UI.
- If the UI-visible count is the source of truth, implement call de-duplication/filtering before enabling `LEAD_STATUS_SYNC_TOUCHPOINT_SOURCE=notes` live.
- Do not enable note/activity mode as the scheduled source until that call-count decision is made.
