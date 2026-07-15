---
project: truewind
task_type: implementation
systems: [Slack, Railway, PostgreSQL, leads-update]
outcome: partial
sensitivity: client-confidential
autonomy_matrix:
  scope: "Durable Slack pending actions, atomic idempotency, and restart recovery"
  mutation_type: "code_tests_docs_stacked_pr"
  external_state: "provision dedicated Railway PostgreSQL only after adapter review; no transport change"
  risk_level: "high"
  trigger: "signed Slack HTTP interactive callback"
  policy: "persist before ACK, atomically claim, retry after crash, fail closed without durable state"
  deterministic_surface: "PostgreSQL schema/store, queue transitions, validators, recovery loop, tests"
  judgment_surface: "existing Claude and HubSpot business decisions remain unchanged"
  trust_layer: "atomic keys, status transitions, bounded retries, sanitized audit logs, reviewer receipts"
  user_experience: "deal-source clicks survive Railway restarts without duplicate execution"
  verification: "unit/integration tests with store adapter, failure/restart/replay cases, broader suite"
---

# 150726 - Slack Durable Interaction State

## What Was Asked

Continue implementing the reliability work after the signed HTTP interactions foundation merged in PR #105, and add the required durable service to Truewind Railway.

## What Was Done

- Created this task log before worktree creation.
- Verified PR #105 deployed successfully to both production Railway services at commit `23c8fff`.
- Verified production remains safely on Socket Mode (`SLACK_EVENT_TRANSPORT` unset/default).
- Added PostgreSQL schema/state adapter for durable pending deal-source requests and minimal Slack interaction jobs.
- Added persist-before-ACK, atomic job claim, atomic pending-request claim, terminal `needs_review` quarantine, retention cleanup, and an operator readback command.
- Added unit tests and a real PostgreSQL integration test for distinct concurrent clicks claiming one pending request and stale processing quarantine.
- Provisioned a dedicated private Railway PostgreSQL service (`d6cab29c-11af-4086-a504-832bdd91e01c`, displayed name `Postgres`) in the Truewind `mchien-truewind` production environment. It is healthy but not bound to either app service.

## Decisions Made

- Use a dedicated PostgreSQL-backed state adapter for atomic shared claims and restart persistence.
- Do not store sensitive prospect/deal request payloads in Slack message metadata.
- Provision/bind PostgreSQL only after the adapter passes tests and review; do not change production transport in this slice.
- Use at-most-once automatic execution across the HubSpot side-effect boundary: jobs that began and then failed/staled go to `needs_review` and are never automatically replayed.
- Recover only jobs durably queued but never started. This prevents an ambiguous crash after a successful HubSpot write from creating a duplicate deal.

## Mistakes, Blockers, And Fixes

- The login-backed planning-review wrapper returned no output; no Claude plan approval is claimed.
- Initial review found that job-level atomicity did not prevent two different clicks from reading the same pending request. Added a second atomic pending-request claim bound to one job.
- Initial stale-lock recovery could replay an uncertain HubSpot write. Replaced automatic stale retry with terminal `needs_review` quarantine and a manual inspection command.
- The first real database run created v1 status constraints. Added idempotent schema migration logic with v2 constraints before rerunning integration successfully.

## What Was Learned

- PR #105 merged to `main` as `23c8fff` and both Railway deployments reached `SUCCESS`.
- Exactly-once execution cannot be guaranteed across PostgreSQL and HubSpot without a shared transaction/idempotency primitive. Quarantining uncertain outcomes is safer than automated replay.

## Verification

- Railway deployment and transport variables read back successfully.
- Relevant local suite passed: 17/17 tests before the final safety revision; targeted store + Slackbot tests passed after revision.
- Real Railway PostgreSQL integration passed, including two distinct click jobs competing for one pending request and stale processing jobs moving to `needs_review` without recovery.
- `slack_state_admin.js list-needs-review` ran against Railway PostgreSQL and returned zero outstanding jobs.
- Reviewer re-checks approved provisioning the unused dedicated database; HTTP cutover remains blocked until final code review and delivery.
- Final relevant local suite passed: 19/19 tests plus syntax and diff checks.
- Final code-quality, security/reliability, and Boolean completion reviews all approved PR delivery with `complete=true`.
- Production safety boundary: keep the database unbound until this PR merges and deploys; then bind only the public `leads-update` worker while remaining on Socket Mode.
- Login-backed Claude was invoked with file-reading access for review but returned no final verdict; no Claude approval is claimed.

## Follow-Ups

- Deliver the reviewed durable state adapter and recovery flow through PR.
- The dedicated Railway PostgreSQL service is provisioned; keep it unbound until the merged code deploys.
- After merge/deploy, bind the private Postgres URL only as `SLACK_STATE_DATABASE_URL` on `leads-update`, verify schema/readback/health, and leave `leads-update-bot` unbound.
- Perform Slack HTTP transport cutover as a separate controlled operation.

## Delivery

- Commit: `00f72ab` (`Persist Slack interaction state in Postgres`)
- Branch: `codex/slack-durable-interaction-state`
- Pull request: `https://github.com/mchien-truewind/leads-update/pull/106`
- Railway PostgreSQL: healthy and unbound; production Slack transport unchanged.
