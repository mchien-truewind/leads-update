# 170526 - Slackbot HubSpot Response Links

## What Was Asked

The user showed that a Slackbot deal-create confirmation included HubSpot IDs but not a clickable HubSpot deal URL, and asked that every newly created deal response include the HubSpot URL link.

## What Was Done

- Updated `scripts/slack/slack_bot.js`.
- Added reusable `hubspotRecordUrl(objectTypeId, objectId)`.
- Updated `formatHubSpotObjectResponse` to use the shared URL helper.
- Updated `formatProspectWorkflowResponse` so the preferred `hubspot_push_truewind_prospect` workflow includes:
  - Contact link.
  - Deal link.
  - Company link.
- Updated the structured deal-create workflow to use the same URL helper for its existing links.
- Added regression coverage in `scripts/slack/tests/slack_bot_hubspot.test.js`.

## Decisions Made

- Included contact and company links too because the workflow already reports those IDs and they are useful for AE follow-up.
- Kept the link format aligned with existing HubSpot object links:
  - Contact object type `0-1`
  - Company object type `0-2`
  - Deal object type `0-3`

## Mistakes, Blockers, And Fixes

- The structured deal-create path already included links, but the broader prospect workflow did not. This explains why the ThinkScan response had IDs but no URL.

## What Was Learned

- `hubspot_push_truewind_prospect` is still used for some deal-create confirmations, so output formatting must be hardened there, not only in the deterministic structured parser.

## Verification

- `node --check scripts/slack/slack_bot.js` passed.
- `node scripts/slack/tests/slack_bot_hubspot.test.js` passed.
- `npm test -- --test-reporter=spec` passed: 13 tests, 13 passing.

## Follow-Ups

- If users prefer only the deal URL, simplify the response later. For now, all related record links are included for auditability.
