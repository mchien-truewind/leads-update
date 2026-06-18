# 180626 - Phase 1 Note Touchpoint Sync

## What Was Asked

Mercedes approved Phase 1 for the HubSpot lead-status sync and specified that Claude Opus 4.8 should be used for review. Phase 1 should support deterministic notes-based BDR touchpoint audit/counting without adding Postgres, AI sentiment, or AI-driven DNC/disqualification automation.

## What Was Done

- Updated `scripts/slack/lead_status_sync.js`:
  - Kept legacy engagement touchpoint counting as the default via `LEAD_STATUS_SYNC_TOUCHPOINT_SOURCE=engagements`.
  - Added opt-in `notes` and `hybrid` touchpoint source modes.
  - Added contact-associated note fetching through `/crm/v4/objects/contacts/{contactId}/associations/notes`.
  - Added note batch reads through `/crm/v3/objects/notes/batch/read`.
  - Added conservative note parsing for BDR-owned outbound email-sent and LinkedIn-message-sent patterns.
  - Excluded opens, clicks, bounces, sequence/list/workflow notes, inbound replies, meeting/booked notes, empty notes, non-BDR notes, outside-window notes, unmatched notes, and duplicates.
  - Added dedupe by channel, `hubspot_owner_id`, five-minute timestamp bucket, and normalized body hash.
  - Added dry-run/audit stats: `touchpointSource`, `notesScanned`, `notesCounted`, `duplicateNotes`, `noteExclusions`, and a bounded `preview` array without note body text.
- Updated `scripts/slack/slack_bot.js`:
  - Added an in-process run guard so scheduled and manual lead-status syncs cannot overlap in the same worker process.
  - Allowed manual `/run-lead-status-sync` calls to pass `touchpointSource=notes` for Phase 1 dry-run audits.
- Updated `README.md`:
  - Documented `LEAD_STATUS_SYNC_TOUCHPOINT_SOURCE=engagements|notes|hybrid`.
  - Documented that note mode is opt-in and requires note `hubspot_owner_id` to match configured BDR owner IDs.
  - Added a manual note-mode dry-run curl example.
- Updated `scripts/slack/tests/lead_status_sync.test.js` with coverage for:
  - note include/exclude parsing;
  - email-open exclusion;
  - LinkedIn message-sent inclusion;
  - owner filtering;
  - note dedupe and exclusion counts;
  - notes-mode HubSpot call shape;
  - stats preview and summary fields.

## Decisions Made

- Do not switch production to note mode yet. The default remains legacy `engagements`, preserving current scheduled behavior.
- Require `hubspot_owner_id` for note BDR attribution. A reviewer caught that `hs_created_by_user_id` is not the same as a HubSpot owner ID or email, so the fallback was removed instead of guessing.
- Keep note parser conservative for Phase 1. Undercounting is acceptable for dry-run audit; false positive touchpoints are more dangerous.
- Do not include note body text in `preview`, to avoid leaking PII or sales-note content into Slack/API output.
- Do not add Postgres in Phase 1. The run guard is in-process only; distributed locking can be revisited if the Railway deployment uses multiple replicas or if AI-driven review queues are added later.

## Mistakes, Blockers, And Fixes

- Initial implementation treated `hs_created_by_user_id` as a BDR owner/email fallback. Independent reviewer flagged this as a blocker because HubSpot user IDs are not owner IDs or emails. Fixed by trusting only note `hubspot_owner_id` and documenting the exclusion behavior.
- The first Claude wrapper attempts returned orientation text or hit turn limits. A compact login-backed Claude Opus 4.8 review eventually returned conditional findings, including one production-behavior concern that did not match the actual diff. Verified the scheduled path does not pass `dryRun`, and `runLeadStatusSync` still writes unless `config.dryRun` is truthy.
- Claude also warned about numeric HubSpot timestamps; the implemented `noteTimestampMs` already handles numeric epoch-millisecond strings before falling back to `Date.parse`.

## What Was Learned

- Existing production behavior is preserved because `scheduleLeadStatusSync()` calls `runLeadStatusSyncForSlack({ mode })` without `dryRun`, and `runLeadStatusSync()` writes updates when `!config.dryRun`.
- Note mode can be tested safely with:

```sh
curl -H "x-lead-status-sync-token: $LEAD_STATUS_SYNC_TRIGGER_SECRET" \
  "https://leads-update-production.up.railway.app/run-lead-status-sync?dryRun=1&skipSlack=1&touchpointSource=notes"
```

- The first production dry run should inspect `noteExclusions.non_bdr_owner` closely. High counts there may mean HubSpot notes do not reliably carry `hubspot_owner_id`, or the BDR owner allowlist is stale.

## Verification

- `node scripts/slack/tests/lead_status_sync.test.js` passed.
- `node scripts/slack/tests/slack_bot_hubspot.test.js` passed.
- `npm test` passed with 70 tests.
- `git diff --check -- README.md scripts/slack/lead_status_sync.js scripts/slack/slack_bot.js scripts/slack/tests/lead_status_sync.test.js` passed.
- Independent code reviewer reran focused tests and `git diff --check`; after the BDR attribution fix there were no remaining independent-review blockers.
- Claude Opus 4.8 was invoked through the login-backed CLI. Its final review was conditional; the actionable concerns were checked against the actual code and are either already handled or documented as dry-run audit risks.

## Follow-Ups

- Run the manual note-mode dry run against Railway with `dryRun=1&skipSlack=1&touchpointSource=notes`.
- Inspect counts for `notesScanned`, `notesCounted`, `duplicateNotes`, `noteExclusions`, and `preview`.
- Confirm the HubSpot notes association API returns the expected shape in production.
- Tune note patterns only from sanitized real examples.
- Do not enable note mode as the scheduled production source until the dry-run audit is reviewed and approved.
