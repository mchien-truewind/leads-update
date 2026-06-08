# 080626 - Slackbot HubSpot Duplicate Deal Guard

## What Was Asked

Update the Truewind Claude Slack bot HubSpot prospect workflow so `hubspot_push_truewind_prospect` checks for existing open deals before creating a new deal, returns a structured duplicate error, and supports `check_duplicates=true` by default with an explicit override.

## What Was Done

- Located the Slack/Claude HubSpot bot in `leads-update-pr52/scripts/slack/slack_bot.js`.
- Added default-on duplicate checking with `check_duplicates=false` override support.
- Added `findDuplicateOpenDeal` to search:
  - active-pipeline deals by exact default deal name and fuzzy company/deal name token match;
  - deals associated to the matched/created company;
  - deals associated to the matched/created contact;
  - deals associated to exact-email contacts and non-generic same-domain contacts.
- Added structured duplicate response formatting:
  - `error: duplicate_deal_exists`
  - `existing_deal.id/name/stage/owner/url`
  - user-facing update prompt message.
- Wired the duplicate guard into both:
  - `runTruewindHubSpotProspectWorkflow`
  - `runStructuredDealCreateWorkflow`
- Updated the Claude tool schema and system prompt so Claude leaves duplicate checks enabled unless the user explicitly asks for a second separate deal.
- Added tests in `leads-update-pr52/scripts/slack/tests/slack_bot_hubspot.test.js` covering duplicate blocking in both the structured workflow and primary `hubspot_push_truewind_prospect` tool path, explicit override, and ignoring associated open deals outside the active pipeline.
- Rebased the follow-up branch onto current `origin/main` after PR #52 was already merged.
- Pushed branch `hubspot-duplicate-deal-guard` and opened PR #69: `https://github.com/mchien-truewind/leads-update/pull/69`.

## Decisions Made

- Kept the guard scoped to the preferred prospect workflow rather than changing low-level `hubspot_create_deal`, because the user specifically called out `hubspot_push_truewind_prospect` and low-level tools may be used for custom one-off admin operations.
- Used existing HubSpot request helpers and association/batch-read utilities instead of introducing a new API client.
- Treated generic email domains as unsafe for same-domain duplicate checks, matching the existing company inference behavior.
- Returned the duplicate error as JSON from the workflow so Slack/Claude can relay exact deal details without claiming a create succeeded.

## Mistakes, Blockers, And Fixes

- Initial implementation did not filter association-derived deals back to `TRUEWIND_HUBSPOT.pipeline`; a reviewer caught that an open deal in another pipeline could falsely block active-pipeline creation.
- Fixed by making `isOpenHubSpotDeal` return false when a candidate deal has a pipeline different from `TRUEWIND_HUBSPOT.pipeline`.
- Added a regression test where an associated open deal in another pipeline is ignored and the new active-pipeline deal is created.
- Added a test-only HubSpot request override to exercise workflow paths without live HubSpot calls.

## What Was Learned

- `hubspot_push_truewind_prospect` already had exact `dealname` reuse, but not a broader duplicate guard across company/contact associations.
- Association-derived deal reads must always be filtered by the active pipeline before being treated as blockers.
- Tests for this file can use a local request override cleanly because most workflow helpers share the same `hubspotRequest` function.

## Verification

- Ran `node scripts/slack/tests/slack_bot_hubspot.test.js` from `leads-update-pr52`; passed.
- Ran `npm test` from `leads-update-pr52`; passed with 17 tests after rebasing onto current `origin/main`.
- `gh pr view 69` showed `mergeStateStatus=CLEAN` with no GitHub status checks configured.
- Review signals:
  - Codex reviewer approved the initial implementation with non-blocking caveats.
  - Second Codex reviewer blocked on cross-pipeline association candidates; blocker was fixed.
  - Login-backed Claude Code approved the initial implementation and approved the blocker fix re-review.
- No live HubSpot writes, Railway actions, or credential reads were performed.

## Follow-Ups

- Deploy/update the running Railway Slack bot service separately if this worktree is the source of the production bot.
- A non-implementer still needs to merge the follow-up PR, per the repo separation-of-duties rule.
- Railway CLI was authenticated as `chienmercedes@gmail.com` in the personal workspace, not `mercedes@trytruewind.com` / `Truewind`, so direct Railway deploy/log verification was blocked. After merge, verify Railway auto-deploy through GitHub deployment records or with a correctly authenticated Truewind Railway CLI session.
