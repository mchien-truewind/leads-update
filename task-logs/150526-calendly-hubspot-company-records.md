# 150526 - Calendly HubSpot Company Records

## What Was Asked

The user asked to update the Calendly-to-HubSpot automation so that when a Calendly booking creates a HubSpot deal, it also creates a HubSpot company record for that account.

## What Was Done

- Updated `scripts/slack/calendly_hubspot.js`.
- Added company identity extraction:
  - Company name from Calendly direct fields or company-related Q&A.
  - Domain from invitee email when it is not a common free-email provider.
  - Best-effort company name inference from business email domain when company name is missing.
- Added HubSpot company find/create flow:
  - Search companies by domain first.
  - Search by company name second.
  - Create company with `name` and/or `domain` when no match exists.
- Associated company records to:
  - Contact.
  - Deal.
  - Meeting.
- Included `companyId` in durable webhook success metadata.
- Updated `scripts/slack/tests/calendly_hubspot.test.js` for company identity extraction helpers.

## Decisions Made

- Use find-or-create instead of blindly creating companies to reduce duplicates.
- Do not create companies from common free-email domains alone.
- If no company identity is available, leave company creation as a no-op rather than creating `Unknown Company` records.
- Keep company creation additive and null-safe so existing contact/deal/meeting behavior continues if company extraction fails.

## Mistakes, Blockers, And Fixes

- No Railway logs were available through CLI because Railway auth is not currently active locally.
- No HubSpot write smoke test was run for this change; validation stayed local plus Claude review to avoid creating CRM test records without an explicit fresh smoke-test request.

## What Was Learned

- Calendly company data may come from custom Q&A rather than a first-class field, so extraction must be defensive.
- Company domain is a better dedupe key than company name when available.
- Free-email domains should not produce company records on their own.

## Verification

- `node --check scripts/slack/calendly_hubspot.js` passed.
- `node --check scripts/slack/slack_bot.js` passed.
- `node scripts/slack/tests/calendly_hubspot.test.js` passed.
- `npm test -- --test-reporter=spec` passed: 13 tests, 13 passing.
- Claude reviewed the company-record change and found no blockers.

## Follow-Ups

- After deployment, run a live test booking with a company-name answer and verify HubSpot has the company associated to the created contact, deal, and meeting.
- Consider adding mocked integration tests for company search/create/associate behavior.
