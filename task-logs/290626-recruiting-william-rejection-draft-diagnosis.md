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

### Deployment

- Committed scoped recruiting no-response changes to `main`:
  - Commit `12c4079525dea2d2652c1dab4dba5b61f988065a`
  - Message `Update recruiting no-response closeouts`
- Pushed `main` to GitHub.
- Railway created deployment `d4028c28-8e90-4e4c-a73b-ecc0d80450d9` for that commit, then a later `main` merge deployment superseded it:
  - Latest deployment `ae9784ad-c3cd-4ee1-b4b5-b36487c42607`
  - Latest commit `d5c4ecd3597023085f89adf37a66a349f37337bb`
  - Verified `12c4079525dea2d2652c1dab4dba5b61f988065a` is an ancestor of `origin/main`, so the latest deployment includes the recruiting changes.
  - Railway status: `SUCCESS`
- Log readback showed the new recruiting container started and emitted `[recruiting-worker] cycle_start 2026-06-29T23:39:16Z`.
- The first cycle had not yet printed `cycle_success` in the observed log window; visible output showed document extraction warnings only, with no crash or Python traceback.
- Claude review note: compact Claude review of the final 7-business-day diff timed out with no output. Earlier Claude completion review approved the template/status portion as coherent, and local compile/tests passed.

## 2026-06-29 Rejection Retry And Email-Body Name Evidence

### What Was Asked

- User manually sent some blocked rejection drafts and wanted confirmation that rejection emails are being sent regularly.
- User asked to fix the retry behavior so corrected first-name drafts can be sent after a first-name verifier failure.
- User asked the first-name verifier to scan the candidate's original email body because candidates often sign off with the first name that should be used.

### What Was Done

- Updated `scripts/recruiting/coordinator_cli.py`:
  - Added `should_process_reject_draft(...)`.
  - Rejection draft send gate now allows `Status=Needs Attention` as well as `Status=Rejected` when `Decision=Reject` and `Reject draft id` is present.
  - Added candidate email-body first-name evidence extraction:
    - `first_names_from_email_body(...)`
    - `candidate_email_body_first_names(...)`
  - `build_rejection_first_name_evidence(...)` now includes an `email_body` evidence source from candidate-authored Gmail messages.
  - Email-body evidence strips quoted replies and requires signature candidates to look like person names, preventing Mercedes/signature text or ordinary sentences from becoming false first-name evidence.
- Updated tests:
  - `scripts/recruiting/tests/test_coordinator_roles.py`
    - Confirms `Needs Attention` + `Decision=Reject` + draft id can retry the send gate.
  - `scripts/recruiting/tests/test_coordinator_resume_extraction.py`
    - Confirms first names are extracted from sign-offs like `Best, Chun-Chi`.
    - Confirms first names are extracted from final signature lines like `Aishwarya Babuji`.
    - Confirms names present only in quoted prior emails are ignored.

### Verification

- `.venv/bin/python -m py_compile scripts/recruiting/coordinator_cli.py`
- `.venv/bin/python -m unittest scripts/recruiting/tests/test_coordinator_roles.py scripts/recruiting/tests/test_coordinator_resume_extraction.py`
  - Result: `Ran 46 tests ... OK`
- Production log readback after user manually sent blocked rejection drafts:
  - Earlier cycle: `Reject drafts auto-send skipped (first-name mismatch): 7`.
  - Later cycle: `Manual rejection sends auto-marked: 7`.
  - Later cycle: `Rejected threads archived from ATS labels: 7`.
  - Later cycle printed `[recruiting-worker] cycle_success`.

### What Was Learned

- The worker already runs regularly and reconciles manually sent rejection emails.
- Manual sends are detected by `thread_latest_manual_rejection_sent_at_any_thread(...)`; the worker then clears the draft state, keeps/sets `Status=Rejected`, and archives ATS labels.
- Before this patch, correcting a Gmail draft after a first-name failure was not enough because the row had been moved to `Needs Attention` and the send gate only retried `Status=Rejected`.
- After this patch, future corrected drafts with `Decision=Reject` and `Reject draft id` can retry from `Needs Attention`.

### Deployment

- The retry/name-evidence commit initially landed on branch `codex/slack-http-events-api` as `cb40223`; it was cherry-picked onto `main` as:
  - Commit `2bd7ac80665b237cb54a89715c838501626a1b1b`
  - Message `Retry reviewed rejection drafts`
- Pushed `main` to GitHub.
- Verified Railway identity before deploy checks:
  - Email `mercedes@trytruewind.com`
  - Workspace `Truewind`
- Railway deployment:
  - Deployment `d9edebd5-2fd7-4e0c-831e-264adf7c955f`
  - Service `recruiting-sync-worker`
  - Commit `2bd7ac80665b237cb54a89715c838501626a1b1b`
  - Status `SUCCESS`
- Post-deploy log readback:
  - Container started.
  - Worker emitted `[recruiting-worker] cycle_start 2026-06-30T00:35:54Z`.
  - The observed log window showed document parsing/conversion warnings from attachment extraction, but no crash or Python traceback.
  - A `cycle_success` line had not appeared yet within the observed post-deploy window.
- Claude review note: `claude-review` was invoked with a compact review packet, but it did not return an approval/blocker. It attempted file inspection and ended with an interrupted request. Local compile/tests passed and the deploy was verified directly.

## 2026-06-29 Kris Thomas No-Response Correction

### What Was Asked

- User asked why `1kristhomas@gmail.com` was still open rather than terminal.
- User clarified the expected behavior: send the passed/no-response email, then mark ATS status `No response` as the terminal step.

### What Was Found

- Direct ATS readback for `1kristhomas@gmail.com`:
  - Candidate `Kris Thomas`
  - Status `Round 1 Scheduling`
  - Decision `Proceed`
  - Role `Other`
  - Gmail thread `19e471a2c9861377`
- Gmail evidence:
  - Candidate applied on `2026-05-20`.
  - Mercedes sent an assignment-style proceed email on `2026-05-22`.
  - No candidate reply was found after that email.
- Root cause:
  - The row was `Role=Other`, so it was not classified into the CustomGPT no-response path.
  - It was also `Round 1 Scheduling`, and that branch exited before the generic no-response logic.
  - The no-response closeout rule therefore never ran for assignment-style proceed emails on non-CustomGPT `Round 1 Scheduling` rows.

### External Mutation

- Ran a guarded Kris-only helper under Railway production env.
- Dry-run checked:
  - Exactly one ATS row matched.
  - Status was `Round 1 Scheduling`.
  - Decision was `Proceed`.
  - Assignment email existed.
  - No candidate reply existed after assignment.
  - Seven-business-day threshold had passed.
  - No prior no-response closeout was already sent.
  - Planned greeting was `Hi Kris,`.
- Sent the no-response closeout email to `1kristhomas@gmail.com`.
- Updated the ATS row:
  - Status `No response`
  - Decision `Reject`
  - Decision time set
  - Reject draft/send fields cleared
  - Hiring label archived

### Readback

- ATS readback after mutation:
  - Status `No response`
  - Decision `Reject`
  - Reject draft id blank
  - Reject send at blank
- Gmail readback after mutation:
  - New sent message on `2026-06-30T00:53:33Z`
  - Body snippet begins `Hi Kris, Haven't heard from you in a while...`

### Code Fix

- Updated `scripts/recruiting/coordinator_cli.py` so `Round 1 Scheduling` rows with assignment-style proceed emails can close out after no reply:
  - Detect assignment email with `thread_latest_assignment_sent_at_any_thread(...)`.
  - Require no candidate reply since assignment.
  - Require `RECRUITING_NO_RESPONSE_WAIT_BUSINESS_DAYS` threshold.
  - Skip the closeout branch if the current pass already prepared a scheduling/status update.
  - Check for an already-sent no-response closeout before sending, so a partial Notion failure does not duplicate-send next run.
  - Send the no-response closeout and then update ATS to `No response` / `Reject`.
- Added `business_day_no_response_due(...)` and test coverage that a reply suppresses closeout.

### Verification

- `.venv/bin/python -m py_compile scripts/recruiting/coordinator_cli.py`
- `.venv/bin/python -m unittest scripts/recruiting/tests/test_coordinator_roles.py scripts/recruiting/tests/test_coordinator_resume_extraction.py`
  - Result: `Ran 47 tests ... OK`
- Read-only preview before targeted Kris correction found two due assignment/no-reply rows:
  - Kris Thomas
  - Michael Goldstein
- Direct readback for Michael showed he was already terminal:
  - Status `Rejected`
  - Decision `Reject`
  - Reject fields blank
  - Gmail had no-response closeout sent on `2026-06-29`.
- Read-only preview after Kris correction showed no due assignment/no-reply `Round 1 Scheduling` rows remaining.

### Review Notes

- `claude-review` returned a stale/incorrect blocker report first, claiming `render_no_response_template` was undefined even though local AST and tests confirmed it exists.
- The useful review risks were handled anyway:
  - Added `not update_payload` gate so no-response cannot overwrite an active scheduling/status update prepared in the same pass.
  - Added prior no-response sent detection before sending.
- Second `claude-review` attempt could not read files in its own environment and refused to approve. This is a review shortfall; local tests and live readbacks were used as the verification basis.

### Deployment

- Committed and pushed:
  - Commit `448d5c2`
  - Message `Close stale round-one assignment no-responses`
- Railway deployment:
  - Deployment `9781d84e-8804-458f-b20f-63621c36d625`
  - Commit `448d5c2`
  - Status `SUCCESS`
- Post-deploy readback for Kris remained correct:
  - Status `No response`
  - Decision `Reject`
  - Gmail showed three messages, including the no-response closeout sent at `2026-06-30T00:53:33Z`.
- New worker container emitted `[recruiting-worker] cycle_start 2026-06-30T00:59:16Z`.
- Observed post-deploy logs showed attachment parsing warnings, but no Python traceback or crash. A `cycle_success` line had not appeared yet in the observed window.

## 2026-06-29 Role Parsing And Backfill

### What Was Asked

- User asked why Kris Thomas had `Role=Other` when the role was clearly in the subject title.
- User asked to make sure roles are parsed correctly.

### What Was Found

- Current parser already handled the simple subject `[hiring@] Account Executive - Kris Thomas` as `AE`, so Kris was likely stale/historical data.
- Another real subject shape was broken:
  - `[hiring@] ATTN: Kyle - Account Executive - Michael Goldstein`
  - Old parse result: role `Other`, candidate `Account Executive - Michael Goldstein`
  - Desired parse: role `AE`, candidate `Michael Goldstein`
- Existing rows are intentionally protected from profile-field overwrite on ingest, so a stale `Other` role could remain forever unless explicitly backfilled.

### Pre-Mutation QA

- Built and ran a subject-only role backfill preview for rows with blank/`Unknown`/`Other` role.
- First broader preview exposed false positives from body scanning:
  - Google moderator spam digest
  - Generic careers application
  - Founding engineer inquiry
- Tightened the preview and code to use conservative subject/title evidence for backfill and to reject invalid subject fragments before role matching.
- Final preview proposed 11 clear subject-based updates:
  - `Account Executive Candidate` -> `AE`
  - `Application for BDR...` -> `BDR`
  - `Account Executive - Michael Goldstein` -> `AE`
  - `Kris Thomas` -> `AE`
  - `Tanner Hoskin` -> `Growth Generalist`
  - `Nkechi Zita Ejikeme` -> `AE`
  - `Devika Sureshbabu` -> `Growth Generalist`
  - `Jon Breault` -> `AE`
  - `Forrest Lloyd` -> `AE`
  - `Olivia Regina` -> `AE`
  - `Arayla Caldwell` -> `Growth Generalist`

### External Mutation

- Applied the 11 Notion role updates from the final preview.
- Readback preview returned zero remaining subject-based role updates.
- Direct readback for Kris:
  - Role `AE`
  - Status `No response`
  - Decision `Reject`

### Code Fix

- Updated `scripts/recruiting/coordinator_cli.py`:
  - Added conservative `infer_truewind_role_from_subject(...)`.
  - `parse_required_subject(...)` now scans hyphen-separated subject parts, so attention prefixes like `ATTN: Kyle - Account Executive - Michael Goldstein` do not block role/name parsing.
  - `canonicalize_truewind_role(...)` now handles common typo/variant subjects:
    - `acount executive`
    - `genaralist`
    - `growth marketing`
  - Invalid fragments like `moderator's spam report` are rejected before role matching.
  - Existing ATS rows backfill `Role at Truewind` only when the current role is weak: blank, `Unknown`, or `Other`.
  - Existing specific/manual roles remain protected from overwrite.

### Verification

- `.venv/bin/python -m py_compile scripts/recruiting/coordinator_cli.py`
- `.venv/bin/python -m unittest scripts/recruiting/tests/test_coordinator_roles.py scripts/recruiting/tests/test_coordinator_resume_extraction.py`
  - Result: `Ran 51 tests ... OK`
- Claude review approved the patch.
- Explicit decision: `Other` is treated as a weak placeholder for this workflow and can be overwritten by specific subject/title evidence. This is intentional because it is how stale rows like Kris get repaired.
