---
project: truewind-leads-update
task_type: investigation
systems: [Notion ATS, Slack]
outcome: completed
sensitivity: client-confidential
---

# 150726 - Recruiting Outstanding Count Correction

## What Was Asked

Explain why the first two candidates in the 14-item outstanding reminder still appeared after Slack reactions.

## What Was Done

- Inspected the exact individual Slack posts and reactions for Abhi Varde and Ahmad Marhaba.
- Recalculated all current inbound Awaiting Decision rows using only individual review posts, explicitly excluding messages containing `ATS_AWAITING_DIGEST_RUN_ID:`.

## Decisions Made

- Continue treating only `white_check_mark` and `x` as Proceed/Reject decisions.
- Continue treating `arrow_right` as a separate Tenn-forward action, not a completed ATS decision.

## Mistakes, Blockers, And Fixes

- The prior temporary counter indexed every message containing an `ATS_THREAD_ID`. Digest messages include candidate markers, so a newer no-reaction digest could replace the original reacted post in the lookup. This caused the 14-item reminder to include five candidates who had already reacted.
- Corrected the read-only calculation by excluding digest run-marker messages before selecting the latest individual review post.

## What Was Learned

- Abhi's original post has `x` and is handled.
- Ahmad's original post has only `arrow_right`, so Ahmad remains outstanding for Proceed/Reject.
- Correct live count at read time: 9 outstanding; 12 reacted but still blank in ATS; 21 ATS rows still blank total.

## Verification

- All current counted rows were Source Inbound, Status Awaiting Decision, Decision blank, and had Gmail thread IDs.
- Corrected outstanding names count: 9.

## Follow-Ups

- Any future reaction-aware reminder builder must exclude digest messages and inspect only individual candidate review posts.
