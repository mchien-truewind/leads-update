# 150526 - Railway HTTP Startup Hotfix

## What Was Asked

The user asked to merge and deploy the Calendly HubSpot deal-name change.

## What Was Done

- Created PR #53 for the deal-name format change and merged it into `main`.
- Railway reported success for merge commit `457fa32caa63c03916ad93b6eb52d409db149aeb`.
- Production smoke checks against `https://leads-update-production.up.railway.app/` and `/webhooks/calendly` returned Railway edge `502`.
- Railway CLI was unauthenticated locally, so deployment logs could not be read from CLI.
- Reproduced a startup failure mode locally: `slack_bot.js` did not start its HTTP server until after Slack Socket Mode connected.
- Added a hotfix in `scripts/slack/slack_bot.js`:
  - Extract `startHttpServer()`.
  - Start HTTP routes before Slack Socket Mode.
  - Catch Slack startup failures so HTTP routes remain available.
  - Start Slack-dependent schedules only after Slack connects.
  - Log unhandled async errors instead of crashing the process.

## Decisions Made

- Kept the emergency fix focused on preserving Calendly webhook availability even if Slack auth/env is broken.
- Did not alter Calendly webhook business logic or HubSpot write logic.
- Accepted that Slack-dependent HTTP routes may still fail in degraded mode, but they should not take down the Calendly webhook route.

## Mistakes, Blockers, And Fixes

- Initial deploy check relied on GitHub/Railway status, which reported success even though the public service returned `502`.
- Railway CLI was not authenticated, blocking direct log inspection.
- Local dummy Slack credentials showed that Slack startup failures could crash the process before HTTP routes were usable. Fixed by starting HTTP first and catching Slack startup failures.

## What Was Learned

- The Railway health route must not depend on successful Slack Socket Mode connection.
- Calendly webhook handling is self-contained and does not need Slack to be connected.
- GitHub commit status can report Railway deployment success while the public app is still not responding.

## Verification

- `node --check scripts/slack/slack_bot.js` passed.
- `node --check scripts/slack/calendly_hubspot.js` passed.
- `node scripts/slack/tests/calendly_hubspot.test.js` passed.
- `npm test -- --test-reporter=spec` passed: 13 tests, 13 passing.
- Local degraded-mode startup test with dummy Slack auth kept HTTP running:
  - `GET /` returned `200 ok`.
  - unsigned `POST /webhooks/calendly` returned `401 invalid_signature`.
- Claude reviewed the hotfix and recommended shipping it as an emergency fix.

## Follow-Ups

- Re-authenticate Railway CLI if deeper deployment logs are needed.
- Consider hardening Slack-dependent manual HTTP routes in degraded mode.
- Confirm real production smoke checks after hotfix deploy.
