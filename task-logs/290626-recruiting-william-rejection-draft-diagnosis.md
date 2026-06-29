# 290626 - Recruiting William Rejection Draft Diagnosis

## What Was Asked

Mercedes asked why a specific recruiting rejection email draft for William was not being sent from Gmail Drafts.

## What Was Done

- Used the `/investigate` workflow because this was a production behavior/root-cause question.
- Tried to fetch the top-level `/Users/mc/projects/truewind` repo first; fetch failed because its remote points at an inaccessible `virtualseal/truewind-local` repository.
- Switched to the nested operational repo at `/Users/mc/projects/truewind/leads-update` and fetched it successfully.
- Inspected `scripts/recruiting/coordinator_cli.py`, `README.md`, `.env.recruiting.example`, and relevant task logs:
  - `task-logs/020626-recruiting-autosend-proceed-drafts.md`
  - `task-logs/020626-recruiting-greeting-only-rejection-verifier.md`
  - `task-logs/020626-recruiting-rerun-reliability.md`
- Verified Railway identity through the guarded command before reading production state:
  - `npm run railway:truewind -- whoami --json`
  - Confirmed `mercedes@trytruewind.com` and workspace `Truewind`.
- Read production Railway state for the recruiting worker using explicit IDs:
  - Project `7b1c11b7-197d-4fbc-b7fd-e1693a5c45aa`
  - Service `fc4f1f54-5561-4dbb-8e34-4702080d8098`
- Read non-secret production config shape and recent logs. A secret-like value was accidentally printed by the variable sanitizer because it did not redact all API-like variable names; do not repeat that output.
- After Mercedes explicitly authorized production Railway secret use for a read-only one-off, ran a scoped Notion/Gmail diagnostic for `William`.
- Patched local source so terminal `Rejected` rows with a pending rejection draft are not skipped before the rejection send gate.
- Added unit coverage for the terminal-skip decision.

## Decisions Made

- Treated the email body itself as unlikely to be the blocker. It matches the rejection language patterns and has a plausible `Hi William,` greeting.
- Focused on the actual auto-send gates instead of copy polish:
  - Reject decision/status must resolve to rejected.
  - A `Reject draft id` must exist and Gmail must still be able to read that draft.
  - The Gmail draft must have a usable `internalDate`.
  - The draft must be at least `RECRUITING_REJECT_DRAFT_AUTO_SEND_AGE_HOURS` old; production does not set this variable, so code default is `48`.
  - The greeting-name verifier must approve; failures leave the draft unsent and notify Slack.
- Identified the exact root cause after the authorized production read: William Smithers already has `Status=Rejected`, `Decision=Reject`, and a valid `Reject draft id`, but `process_decisions_cmd` skipped all terminal statuses before reaching the rejection-draft send branch.
- Chose a narrow local fix: preserve terminal skipping for normal terminal rows, but let `Rejected` + `Reject` + non-empty `Reject draft id` continue into the existing draft age/name verification/send logic.

## Mistakes, Blockers, And Fixes

- The top-level repo fetch failed due inaccessible remote; worked from local state for that repo and used the nested `leads-update` repo for the actual worker.
- Local `leads-update` has no `.env.local` and no local Gmail/Notion OAuth secrets, so William's specific Gmail draft and Notion row could not be directly read locally.
- The available Google Workspace MCP tools exposed Docs/Drive/Sheets helpers but no Gmail draft/message lookup.
- Initial conclusion over-weighted the worker-not-reaching-decisions hypothesis. The later authorized Gmail/Notion read showed the stronger code-path bug: even when `process-decisions` reaches William, the terminal-status shortcut skips him.
- Gmail thread metadata can include draft messages in thread reads. The helper `thread_latest_manual_rejection_sent_at_any_thread` reported William's draft timestamp as a sent rejection timestamp, but direct message labels showed that Mercedes's only message in the thread was labeled `DRAFT`, not `SENT`.
- Two Claude-backed review attempts were run before the final production read. `claude-planning-review` failed because Claude Fable was unavailable. A fallback Claude Code completion review correctly flagged that William-specific Gmail/Notion state was still not directly verified. A separate compact `claude-review` returned an obviously false claim about the local file being a placeholder; local file reads disproved that claim, so it was not treated as a valid blocker.

## What Was Learned

- William Smithers production state at read time:
  - `Decision=Reject`
  - `Status=Rejected`
  - `Reject draft id=r4495365371433427349`
  - `Gmail thread id=19ed1900dc503861`
  - Draft message label: `DRAFT`
  - Draft created: `2026-06-17T21:25:47+00:00`
  - Draft age at probe: about `287.78` hours
  - Greeting: `William`
  - Rejection language detected: true
- The direct code bug is in the ordering inside `process_decisions_cmd`: terminal status handling ran before the reject decision branch.
- Prior task log `020626-recruiting-rerun-reliability.md` documented worker reliability issues before decision processing. That can still delay sends, but it was not the root cause for William once his row state was read.

## Verification

- Verified Railway identity before Railway reads.
- Verified `leads-update` repo fetched from `mchien-truewind/leads-update`.
- Used production Railway secrets only after explicit user authorization for a read-only Notion/Gmail probe.
- Before deploy, ran a read-only pre-mutation QA preview using production Railway env.
  - Artifact: `task-logs/drafts/290626-recruiting-reject-deploy-preview.json`
  - Newly unskipped rows after deploy: `32`
  - Rows old enough with draft/rejection language that would reach send attempt path: `32`
  - Deterministic first-name pass: `27`
  - Deterministic first-name mismatch: `5`
- Did not mutate Gmail, Notion, or Railway.
- Changed local source files:
  - `scripts/recruiting/coordinator_cli.py`
  - `scripts/recruiting/tests/test_coordinator_roles.py`
- Test run: `.venv/bin/python -m unittest scripts/recruiting/tests/test_coordinator_roles.py scripts/recruiting/tests/test_coordinator_resume_extraction.py`
  - Result: `Ran 39 tests ... OK`

## Follow-Ups

- Do not deploy this blindly: deploying the fix can send eligible pending rejection drafts, not just William.
- Before push/deploy, run a pre-mutation QA preview of all `Rejected` rows with non-empty `Reject draft id`.
- If the desired immediate action is only William, manually send William's Gmail draft or run a scoped one-off send that targets only his draft ID after explicit approval.
- After the preview, deployment was blocked pending user clarification because deploying the broad fix would affect 32 candidate drafts and 5 have deterministic greeting-name mismatches.
