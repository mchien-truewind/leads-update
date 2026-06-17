# 170626 — HubSpot write auth for full team + Slack bot reliability diagnosis

## What was asked
The `mercedes-claude` Slack bot (this repo's `scripts/slack/slack_bot.js`, deployed as
Railway service `leads-update` in project `mchien-truewind`) had two reported problems:
1. It was only writing to HubSpot for *some* users; the team is now ~10 people and
   everyone needs to be able to write.
2. Reliability: intermittent non-responses, sometimes not responding at all.

## What was done

### Diagnosis (live, against production = `origin/main`, commit eac508ca)
- **Bot location:** repo `mchien-truewind/leads-update`, `scripts/slack/slack_bot.js`
  (Socket Mode Bolt app). "mercedes-claude" is the Railway account name, not the code.
- **Issue 1 root cause:** `isHubSpotWriteAuthorized` only allowed writes for a Slack
  user in `HUBSPOT_WRITE_ALLOWED_SLACK_USER_IDS` (live: just `U0ABULY5TEK`), in the
  static 7-person `SLACK_TO_HUBSPOT_OWNER` default map, or in an allowlisted channel
  (live: `C0AECSHATK3`). Newer owners (e.g. Andrew Moyer `93961770`, Ari Nachman
  `93961773`, seen in prod logs) were unmapped → writes denied outside the one
  allowlisted channel, and attribution fell back to Xavier Marco.
- **Trusted-metadata bug:** the `executeTool` gate authorized on the *model-supplied*
  `input`, not the server-injected `toolInput.__trusted_slack_metadata`. It worked only
  because Claude happened to echo `slack_user_id`/`channel_id` into tool args.
- **Issue 2 root cause:** confirmed a single Railway instance / single deployment
  (numReplicas default 1), running continuously since 2026-06-15 with no crash loop.
  `gmail-triage-worker` (same project) uses no Slack tokens, so only `leads-update`
  connects this Slack app. The intermittent silence points at **Socket Mode connection
  wedging with no watchdog/supervisor to recover** (unlike `mini-mercedes-harness`,
  which already has `supervisor.js` + a connection watchdog). Compounded by one process
  doing interactive Slack + 3 cron jobs + webhooks, and most messages routing to the
  slow `claude-opus-4-1` path. No code change made for Issue 2 yet (verify-first).

### Fix implemented (Issue 1) — branch `fix/hubspot-writes-dynamic-owner-auth`
- Added `getSlackUserProfile(slackId)` (cached) returning `{email, realName}`;
  `getSlackUserEmail` now wraps it.
- Added `getHubSpotOwnersCached()` (paginated, TTL cache, degrades to stale/empty).
- Added pure `pickHubSpotOwnerForProfile(profile, owners)` (email match, then name
  fallback) + `matchHubSpotOwnerToSlackUser(slackId)` wrapper (cached).
- `isHubSpotWriteAuthorized` is now async and authorizes any Slack user who resolves
  to a real HubSpot owner; existing allowlist/channel/owner-tag checks kept.
- `getSlackMetadata` now prefers `__trusted_slack_metadata` over model-supplied args;
  `executeTool` gate now passes `toolInput`.
- Attribution: `resolveHubSpotOwnerForProspect` and the structured-deal workflow route
  through the dynamic matcher, so a teammate's records are owned by them.
- Updated the 3 auth call sites to `await`; updated tests to await; added
  `testDynamicOwnerMatchByEmailAndName`. All slack test files pass.

## Decisions made
- **Approach for Issue 1:** dynamic Slack-profile → HubSpot-owner resolution (chosen by
  Mercedes over expanding env allowlists or disabling the gate). Keeps the security gate
  (only real HubSpot owners can write) while scaling to the whole team automatically.
- **Match on Slack ID + name:** events carry a Slack user ID; resolve ID → profile →
  owner by email, with name as the fallback when Slack/HubSpot emails differ (per
  Mercedes's clarification).
- **Based the branch on `origin/main` (production), not local `main`.**

## What was learned
- **Local `leads-update` `main` is ~615 lines ahead of `origin/main`/production** (HubSpot
  object helpers etc.) and is unpushed. Production runs `origin/main`. The unpushed work
  does NOT touch auth/owner logic, so this fix is compatible, but the divergence should
  be reconciled.
- The bot's reliability is a single-connection Socket Mode process with no watchdog.

## Open questions / next steps
- **Issue 2 (reliability):** still needs fixing — recommend porting the watchdog +
  supervised restart from `mini-mercedes-harness`, adding event dedup, and bounding the
  agentic loop. Also confirm no stray laptop process holds the same `SLACK_APP_TOKEN`.
- Reconcile the unpushed local `main` divergence with `origin/main`.
- PR is for review only — not merged, not deployed.
