# 150526 - Calendly HubSpot Deal Name Format

## What Was Asked

The user asked to change automatically-created HubSpot deal names from the Calendly webhook to `Company Name - Organizer Name - YYYY-MM-DD`, and said to explain the UI path only if it could not be done in code.

## What Was Done

- Updated `scripts/slack/calendly_hubspot.js`.
- Added Sarah/Xavier organizer display-name mapping keyed by Calendly host user URI.
- Added `getCompanyNameFromPayload` to extract company name from direct Calendly payload fields or `questions_and_answers` entries containing "company".
- Added `getOrganizerName` to derive organizer name from the configured Sarah/Xavier map, with a scheduled-event membership fallback.
- Changed `buildDealName` to produce `Company - Organizer - YYYY-MM-DD`.
- Updated `scripts/slack/tests/calendly_hubspot.test.js` for the new format and helper behavior.

## Decisions Made

- Kept the change in code because the existing integration owns deal creation and deal-name construction.
- Used `Unknown Company` and `Unknown Organizer` fallbacks if Calendly payload data is missing, rather than reverting to the old invitee/event-title format.
- Left existing webhook routing, idempotency, HubSpot object creation, cancellation, and reschedule behavior unchanged.

## Mistakes, Blockers, And Fixes

- Initial test coverage only covered top-level `questions_and_answers`. Claude review flagged the nested `invitee.questions_and_answers` path, so a test was added.

## What Was Learned

- The company name is not already a first-class helper in the webhook module, so it must be extracted defensively from Calendly payload fields and custom form answers.
- Organizer name should use the already-validated host URI rather than the Calendly event title.

## Verification

- `node --check scripts/slack/calendly_hubspot.js` passed.
- `node --check scripts/slack/slack_bot.js` passed.
- `node scripts/slack/tests/calendly_hubspot.test.js` passed.
- `npm test -- --test-reporter=spec` passed: 13 tests, 13 passing.
- Claude Code reviewed the focused change and reported no blockers.

## Follow-Ups

- Deploy the branch/PR before expecting production HubSpot deal names to change.
- Confirm the relevant Calendly forms ask for company name in a question containing the word "company"; otherwise deals will use `Unknown Company`.
