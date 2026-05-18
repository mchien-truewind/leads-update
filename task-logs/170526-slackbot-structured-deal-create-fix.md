# 170526 - Slackbot Structured Deal Create Fix

## What Was Asked

The user showed a Slack request to create a ThinkScan S1 deal and a bad bot response that hallucinated unrelated HubSpot actions, claimed basic HubSpot fields were read-only, and failed to create the deal. The user asked to fix this and review with Claude so tagged deal-create requests simply create the deal and return the HubSpot ID/link without lies or hallucinations.

## What Was Done

- Updated `scripts/slack/slack_bot.js`.
- Fixed `isReadOnlyHubSpotProperty` so HubSpot `modificationMetadata.readOnlyDefinition` no longer blocks value writes. Only actual `readOnlyValue` and calculated fields are treated as unwritable.
- Added deterministic structured deal parsing for current-message Slack requests with fields such as:
  - `Company`
  - `Type`
  - `Contact`
  - `Email`
  - `Deal owner`
  - `Source`
  - `Meeting booked for`
  - `Notes`
- Added a backend shortcut in `handleMessage` so structured deal-create requests bypass Claude/thread-history summarization entirely.
- Added `runStructuredDealCreateWorkflow`, which:
  - Validates email and company before writes.
  - Enforces the existing HubSpot write authorization gate.
  - Reuses or creates the contact.
  - Reuses or creates the company.
  - Creates a new S1/MQL deal.
  - Associates contact-company, deal-contact, and deal-company.
  - Adds a note with type, meeting-booked text, and notes when present.
  - Returns only concrete HubSpot IDs and links, or an explicit error with no completion claim.
- Updated `scripts/slack/tests/slack_bot_hubspot.test.js` for:
  - `readOnlyDefinition` not blocking writable standard fields like `dealname` and `firstname`.
  - ThinkScan-style structured request parsing.
  - Slack `<mailto:...|...>` email parsing.
  - Non-deal and incomplete deal messages returning `null`.

## Decisions Made

- Bypass Claude for structured deal-create requests because the failure mode was Claude mixing unrelated thread context and narrating actions it did not perform.
- Preserve existing authorization rules rather than making all Slack users able to write to HubSpot.
- Create a fresh deal for structured `create a new deal` requests instead of matching an existing deal by name, because the user asked for simple creation and exact ID/link output.
- Save user-provided type/meeting/notes as a HubSpot note instead of guessing custom deal properties.

## Mistakes, Blockers, And Fixes

- Initial parser assumed `Meeting booked for:` would use a colon. The user's sample used `Meeting booked for Monday May 18`; the parser now supports both.
- Claude review flagged a dead stage ternary and suggested extra parser tests. Removed the dead ternary and added tests.

## What Was Learned

- HubSpot `readOnlyDefinition` is about property schema mutability, not whether record values can be written. Treating it as read-only made the bot reject standard writable fields.
- Structured Slack requests should be handled deterministically before fetching broader thread history.
- The bot should return concrete HubSpot IDs/links from API responses and avoid broad summaries for CRM write requests.

## Verification

- `node --check scripts/slack/slack_bot.js` passed.
- `node scripts/slack/tests/slack_bot_hubspot.test.js` passed.
- `npm test -- --test-reporter=spec` passed: 13 tests, 13 passing.
- Claude reviewed the change and found no blockers after noting minor cleanup items that were applied.

## Follow-Ups

- After deployment, retry the ThinkScan Slack request. The expected response should include a HubSpot deal ID and deal link, or an exact authorization/API error.
- If notes should use a specific HubSpot activity/meeting object instead of a note, add that as a separate scoped change.
