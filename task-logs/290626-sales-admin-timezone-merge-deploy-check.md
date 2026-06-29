# 290626 - Sales Admin Timezone Merge Deploy Check

## What Was Asked

The user asked whether the Sales Admin Slack timezone scheduling change had been merged and deployed.

## What Was Done

- Checked local git status in `/Users/mc/projects/truewind/leads-update`.
- Fetched `origin`.
- Compared the touched Sales Admin files against `origin/main`.
- Verified Truewind Railway identity with the guarded command:
  - `npm run railway:truewind -- whoami --json`
- Read Railway production service list for project `67b145f8-d6d9-4402-aa0d-310f005122be`.

## Decisions Made

- Treated the patch as not merged because the timezone changes remain as local uncommitted modifications in:
  - `scripts/slack/sales_admin/workflow.js`
  - `scripts/slack/tests/sales_admin_workflow.test.js`
- Treated the patch as not deployed through the normal Railway path because it is not present on `origin/main`.

## Mistakes, Blockers, And Fixes

- A first attempt to run `railway status` with `--service` failed because this CLI command does not accept `--service`. Switched to guarded `service list --json`.

## What Was Learned

- Local branch is `main`.
- `main...origin/main` exists with local uncommitted Sales Admin timezone changes.
- `git diff origin/main -- scripts/slack/sales_admin/workflow.js` still shows the timezone implementation, including:
  - `America/New_York`
  - `resolveSlackUserTimeZone`
  - `salesadmin_timezone_resolved`
  - per-timezone scheduling group changes.
- Railway identity was correct:
  - Email: `mercedes@trytruewind.com`
  - Workspace: `Truewind`
- Railway production services show successful deployments from `mchien-truewind/leads-update`, including `leads-update-bot`, but those deployments cannot contain this local-only timezone patch.

## Verification

- `git status --short --branch` showed the Sales Admin timezone files modified locally.
- `git diff --stat origin/main -- scripts/slack/sales_admin/workflow.js scripts/slack/tests/sales_admin_workflow.test.js` showed the full patch still differs from `origin/main`.
- Railway service list read succeeded under the Truewind account.

## Follow-Ups

- To deploy the timezone change, commit it, push it, open/update the PR, merge through the normal delivery path, then verify the Railway deployment created after that merge.
