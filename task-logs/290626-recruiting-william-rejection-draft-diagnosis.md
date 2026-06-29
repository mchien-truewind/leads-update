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

## 2026-06-29 Deploy And Gmail Reclassification Audit

### What Was Done

- User approved broad deploy option 1.
- Committed and pushed recruiting fix:
  - Commit `1f97f08052e23c41d15fe1c9c3903d0a3026008e`
  - Message `Fix recruiting rejection draft send gate`
- Verified Railway deployment for recruiting worker:
  - Project `7b1c11b7-197d-4fbc-b7fd-e1693a5c45aa`
  - Service `fc4f1f54-5561-4dbb-8e34-4702080d8098`
  - Deployment `d5a6bd8e-a204-4a6c-b4f4-d581bd3f34e7`
  - Status `SUCCESS`
  - Commit hash `1f97f08052e23c41d15fe1c9c3903d0a3026008e`
- Read live worker logs after deploy:
  - `Reject drafts auto-sent: 25`
  - `Reject drafts auto-send skipped (first-name mismatch): 7`
  - `Reject drafts auto-send skipped (younger than threshold): 0`
  - `Reject drafts auto-send skipped (missing draft): 0`
  - `Rejected threads archived from ATS labels: 25`
  - `Rejected thread archive failures: 0`
- Investigated old Awaiting/blank rows and `Source=Superposition` rows against Gmail evidence using production Railway env.
- Reproduced the deployed worker's credential-file setup in one-off read-only audit commands:
  - `GOOGLE_GMAIL_CREDENTIALS_JSON` and `GOOGLE_GMAIL_TOKEN_JSON` were written to a temporary directory inside the command.
  - The temporary directory was removed by shell trap after the command.
  - No secret values were written to task logs or committed files.

### What Was Learned

- The no-response transition is not based on Notion `Date first entered`; it is based on a Gmail-detected assignment/proceed email plus no candidate reply after the configured wait period.
- Code path:
  - `RECRUITING_NO_RESPONSE_WAIT_DAYS` defaults to `14`.
  - The generic no-response block only runs when `decision not in {"proceed", "reject"}` and `current_status == "awaiting decision"`.
  - Rows with `Decision=Proceed` can therefore sit indefinitely if they are blank/Awaiting and have stale proceed/assignment evidence.
- Old Awaiting/blank audit:
  - 28 rows were older than 14 days by `Date first entered`.
  - 1 row was 60+ days old.
  - Initial reason counts:
    - `no_assignment_email_detected`: 23
    - `candidate_replied_after_assignment`: 2
    - `has_decision_value`: 2
    - `assignment_sent_less_than_14d_ago`: 1
- The 60+ day row was Paul Knox:
  - Actual Notion `Status` was blank; code normalizes blank status to Awaiting Decision.
  - `Decision=Proceed`
  - `Proceed draft id` present.
  - Gmail assignment/proceed email detected at `2026-05-15T16:12:35+00:00`.
  - No candidate reply after assignment was detected.
  - Root cause: no-response cleanup skips `Decision=Proceed`, and the proceed branch only sends an existing proceed draft when current status is already `Round 1 Scheduling`.

### Superposition Gmail Preview

- Created read-only preview artifact:
  - `task-logs/drafts/290626-superposition-gmail-reclass-preview.tsv`
- Target: all Notion rows where `Source=Superposition`.
- Rows reviewed: 23.
- Final suggested counts after QA refinement:
  - `Unclear`: 10
  - `Round 1 Scheduling`: 5
  - `Rejected`: 4
  - `Needs Attention`: 2
  - `Passed`: 2
- Existing terminal verification:
  - 4 rows were already `Rejected` and Gmail had matching sent rejection/no-response evidence.
- High-confidence terminal changes:
  - Rio Pesino: candidate said they were going to pass.
  - Alec McNees: candidate said compensation was significantly lower than needed and wished good luck.
  - Candidate-initiated pass/withdrawal appears to map to a terminal outcome, but do not write `Passed` until Mercedes confirms that `Passed` in this ATS means candidate passed/withdrew rather than "passed a stage."
- Active/non-terminal proposed changes:
  - Alex Tarr, PM Sam Grover, PM Marc Ciccarelli, Roberto Jimenez, Wing Chan -> `Round 1 Scheduling`.
  - PM Ian Johnstone, PM Erik Dauksavage -> `Needs Attention`.
- 10 rows remained `Unclear` because Gmail did not show assignment or terminal email evidence strong enough for a safe reclassification.

### QA Notes

- The first Superposition preview had a recurring false-positive pattern: quoted prior emails made candidate replies look like scheduling replies.
- Refined the preview classifier to:
  - Ignore quoted prior email text when classifying candidate replies.
  - Treat clear compensation-decline language as a candidate pass.
- Reran the preview after the classifier adjustment before considering any Notion mutation.
- No Notion rows were updated during this audit.

### Follow-Ups

- Safe immediate write scope, if approved after status semantics are confirmed: update only the two high-confidence Superposition terminal changes to the correct candidate-withdrew/pass terminal status.
- Broader workflow cleanup should be a separate mutation:
  - Sync active Superposition rows to `Round 1 Scheduling` or `Needs Attention`.
  - Fix the worker state machine so blank/Awaiting + `Decision=Proceed` rows cannot get stuck indefinitely.
- Before any broader write, rerun the preview and review borderline active rows; do not rely only on keyword matches from quoted email text.

## 2026-06-29 No-Response Template And Status Patch

### What Was Asked

- Confirm where the no-response email is triggered.
- Explain why it had not triggered for stale Superposition/scheduling rows.
- Change both no-response email types to use the CustomGPT/no-response closeout language.
- Ensure sent no-response closeouts update Notion ATS `Status` to `No response`, not `Rejected`.
- User identified `myap24@icloud.com` as another person who needs the passed/no-response email.

### What Was Done

- Updated `scripts/recruiting/coordinator_cli.py`:
  - `DEFAULT_NO_RESPONSE_TEMPLATE` now reuses `DEFAULT_CUSTOM_GPT_NO_RESPONSE_REJECTION_TEMPLATE`.
  - `NO_RESPONSE_SENT_RE` now recognizes the CustomGPT closeout wording.
  - CustomGPT no-response send path now updates status to `STATUS_NO_RESPONSE`.
  - No-response sent reconciliation path now keeps status as `STATUS_NO_RESPONSE`.
  - `close-stale-custom-gpt --send` now updates status to `STATUS_NO_RESPONSE`.
  - CLI help text now says the stale closeout marks candidates `No response`.
- Added tests in `scripts/recruiting/tests/test_coordinator_resume_extraction.py`:
  - Normal no-response template equals the CustomGPT closeout template.
  - Rendered normal no-response body includes first-name greeting and CustomGPT wording.
  - `NO_RESPONSE_SENT_RE` matches the new closeout wording.

### What Was Learned

- Production Railway worker runs `python scripts/recruiting/coordinator_cli.py run`.
- `run` only executes:
  - `ingest`
  - `sync-slack-decisions`
  - `process-decisions`
- The separate `close-stale-custom-gpt` command exists but is not part of the recurring production worker loop and defaults to dry-run unless invoked with `--send`.
- Existing always-on no-response behavior is narrow:
  - `Waiting on CustomGPT` can send a closeout after `RECRUITING_CUSTOM_GPT_NO_RESPONSE_WAIT_HOURS` when an assignment email is detected and no candidate reply exists.
  - Blank/Awaiting rows can create a no-response draft after `RECRUITING_NO_RESPONSE_WAIT_DAYS`, but only when `decision` is blank, status normalizes to `Awaiting Decision`, an assignment email is detected by assignment keywords, and no candidate reply exists.
- Stale Superposition scheduling nudges such as booking-link follow-ups often do not match the assignment keyword detector, so they do not start the current no-response clock.
- Rows with `Decision=Proceed` skip the generic Awaiting no-response draft branch entirely.

### Verification

- `.venv/bin/python -m py_compile scripts/recruiting/coordinator_cli.py`
- `.venv/bin/python -m unittest scripts/recruiting/tests/test_coordinator_roles.py scripts/recruiting/tests/test_coordinator_resume_extraction.py`
  - Result: `Ran 41 tests ... OK`

### Follow-Ups

- Still needed: implement a broader stale scheduling/no-response closeout rule for Superposition-style booking-link/reschedule nudges, including the user-confirmed cases:
  - `myap24@icloud.com`
  - Jeff Belleba
  - Robert Dunn
  - Jack Despain
  - Jesse Berkowitz
- Before sending closeouts, create a pre-mutation preview with candidate, email, detected last outreach, last candidate reply if any, proposed email body, proposed Notion status `No response`, and reason.

## 2026-06-29 Seven-Business-Day Reply Window

### What Was Asked

- User clarified that candidates should get at least 7 business days to reply before receiving the passed/no-response email.

### What Was Done

- Updated `scripts/recruiting/coordinator_cli.py`:
  - Replaced the generic no-response `timedelta(days=...)` check with `add_business_days(...)`.
  - Added config field `no_response_wait_business_days`.
  - New env var: `RECRUITING_NO_RESPONSE_WAIT_BUSINESS_DAYS`.
  - Backward-compatible fallback: old `RECRUITING_NO_RESPONSE_WAIT_DAYS` is still read if the new env var is absent, defaulting to `7`.
  - Updated `close-stale-custom-gpt --business-days` default from `3` to `7`.
- Updated `.env.recruiting.example` to document `RECRUITING_NO_RESPONSE_WAIT_BUSINESS_DAYS=7`.
- Updated tests:
  - Config helper now uses `no_response_wait_business_days`.
  - Added coverage that `add_business_days` skips weekends.

### Verification

- `.venv/bin/python -m py_compile scripts/recruiting/coordinator_cli.py`
- `.venv/bin/python -m unittest scripts/recruiting/tests/test_coordinator_roles.py scripts/recruiting/tests/test_coordinator_resume_extraction.py`
  - Result: `Ran 42 tests ... OK`

### Remaining Gap

- This changes the threshold once a qualifying outbound email is detected.
- It still does not broaden what counts as a qualifying outreach email for Superposition booking-link/reschedule nudges. That trigger expansion still needs a preview-first implementation before sending emails.
