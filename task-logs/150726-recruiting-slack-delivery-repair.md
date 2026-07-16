---
project: truewind-leads-update
task_type: implementation
systems: [Notion ATS, Slack, Gmail, Railway, GitHub]
outcome: completed
sensitivity: client-confidential
---

# 150726 - Recruiting Slack Delivery Repair

## What Was Asked

Implement and roll out durable ATS-to-Slack delivery receipts, repair the 23 eligible inbound Awaiting Decision rows, post one 21-candidate backlog digest, and reclassify the 16 Superposition Awaiting Decision rows from Gmail evidence without sending Superposition candidates to Slack.

## What Was Done

- Added the Notion URL property contract `Slack Review URL` and ATS-wide reconciliation for exact Inbound, Awaiting Decision, blank Decision, present Gmail thread, and blank receipt rows.
- Added fully paginated exact `ATS_THREAD_ID` history lookup, immediate pre-post recheck, permalink persistence, fail-closed errors, and a process mutex.
- Kept Slack reaction decision processing independent from delivery receipts and excluded Superposition from individual posts and digests.
- Added dry-run/apply reconciliation, metadata-only Superposition audit, SHA-256-gated status apply with full-batch preflight/readback, and idempotent digest commands.
- Added sender verification, conflict holds, and conservative Superposition status rules. Unknown senders and missing/conflicting evidence remain unchanged.
- Merged PRs #108-#114, including production fixes for Slack's documented GET permalink transport, bounded parallel permalink hydration, exact 16-row Superposition scope, unknown-sender holds, and explicit compensation declines.
- Deployed Railway commit `2f15342` through the repository's automatic main-branch deployment.
- Recovered 21 existing inbound Slack permalinks and posted exactly one review each for Serena Wang and Danny Kobayashi. All 23 eligible inbound rows now have receipts.
- Posted one 21-item digest with run ID `2026-07-15-backlog-repair-v1`; immediate rerun returned `already_posted`.
- Applied the exact Superposition artifact SHA `92c4418e9f0d5d2f6badd9343cdb5dae658d6ca6f441d75dc8f0cb52efc11d13`: 1 row to Passed, 4 to Round 1 Scheduling, and 11 held unchanged.

## Decisions Made

- Treated a blank or wrong-type receipt schema as fail-closed; dry-run never creates the schema.
- Required positively verified candidate/company senders for all automatic evidence rules.
- Required explicit terminal language before compensation mismatch can map to Passed, so negotiation stays non-terminal.
- Used a bounded eight-worker permalink pool after serial lookups exceeded Railway's one-off command window; Slack documents a hundreds-per-minute allowance.
- Kept future Superposition creation behavior unchanged (`Awaiting Decision`) while excluding it from Slack reconciliation.

## Mistakes, Blockers, And Fixes

- The first GitHub guard path was wrong inside the worktree and the branch push ran because the command list was not fail-fast. Verified `mchien-truewind` from `/Users/mc/projects/truewind/scripts/ensure-truewind-gh-account.cjs` before every PR/merge afterward.
- Railway cannot truly scale this service to zero through the current CLI; `us-west2=0` removed an override and caused a single-replica replacement. No two replicas ran. Used the known ingestion phase between clean single-replica replacements for controlled one-offs.
- Slack `chat.getPermalink` returned `invalid_arguments` because the client used JSON POST for a documented GET method. Corrected transport and added a regression test.
- Serial hydration of 37 marker permalinks exceeded Railway's roughly 25-second local `run` window, causing partial receipt progress. Bounded parallel hydration fixed it; marker recovery prevented duplicates.
- The first Superposition preview selected 23 rows across all statuses. The pre-mutation gate stopped apply; the audit was restricted to the approved 16 Awaiting Decision rows.
- The first 16-row classifier preview exposed broad scheduling false positives from unknown senders and an HTML/calendar token after an explicit compensation decline. Unknown senders now hold, and compensation decline requires verified candidate authorship plus need/require and terminal language.
- Claude Fable was used successfully for several completion gates, but two compact transport-review attempts returned unusable narration/hallucinated context. Independent reviewer agents supplied the missing review signal for that change.

## What Was Learned

- Slack's official `chat.getPermalink` contract uses GET with `channel` and `message_ts`; the previous shared POST helper was not reliable for this method.
- Railway `run` can terminate longer successful local commands without preserving stdout, so deterministic readback is required and long Slack hydration must stay bounded.
- The production recruiting service is one sequential `us-west2` replica with no deployment overlap. Scaling past one replica still requires a distributed lock.

## Verification

- Recruiting unit suite: 62/62 passed; `py_compile` and `git diff --check` passed.
- Code Quality and Engineering Completion reviewer gates approved each substantive fix; unresolved reviewer blockers were fixed and rerun.
- Railway identity: `mercedes@trytruewind.com`, workspace `Truewind`; final service status SUCCESS with one configured/running replica.
- ATS readback: 23/23 eligible inbound rows have Slack Review URLs; reconciliation dry-run returns zero eligible/missing/posted/recovered.
- Slack readback: Serena marker count 1, Danny marker count 1, both include configured mention plus Notion/resume links; digest marker count 1.
- Superposition readback: all 16 artifact rows matched; counts are Awaiting Decision 11, Passed 1, Round 1 Scheduling 4; zero mismatches.

## Follow-Ups

- Before configuring more than one Railway replica, add a distributed reconciliation lock.
- Consider adding a first-class maintenance/pause control for future live repairs; Railway zero-replica scaling was not available through this service configuration.
