# Deals for new demo requests

The `leads-update` HTTP worker can create a HubSpot deal for each new demo-request contact, without waiting for a meeting. This is separate from the five-minute Slack notification window. The worker polls every 15 seconds; API failures retry every 30 seconds.

It reuses the saved deal or the newest open Active Pipeline deal associated with the contact or its companies. Otherwise it creates **Stage 1: Discovery** in **Active Pipeline**, with contact and known-company associations in the creation request. HubSpot's unique `truewind_demo_request_contact_id` property prevents duplicate creates after an ambiguous API response or process restart. Association retries retain the deal ID in PostgreSQL. Repeated forms and later Calendly bookings use the same opportunity.

Company selection prefers the primary associated company, then a sole associated company, then a unique corporate-domain or explicitly supplied company-name match. Missing or ambiguous company information does not stop deal creation: the deal title includes `[Company missing]` and its description explains what needs review. The worker does not invent company records from personal email addresses. Existing opportunities retain their owners and stages. New unowned form deals receive the verified form-routing owner when available. Canceling or rescheduling a meeting does not close or reopen the saved form opportunity.

## Activation

The feature defaults to **off**. Deploying this PR alone does not enable it.

1. Confirm the hidden unique deal property matches `config/hubspot/demo-request-deal-property.json`. Create it using `POST /crm/v3/properties/deals` if absent; never replace an existing non-unique property with the same name. The worker verifies the schema and Discovery stage before starting.
2. Merge the reviewed PR and verify the exact merged commit deployed successfully to production `leads-update` (service `600dc5b7-e5f2-4399-8eac-4b596c84f56e`, Truewind Railway project `67b145f8-d6d9-4402-aa0d-310f005122be`). Keep the feature off during this deployment.
3. Back up and disable only HubSpot workflow `1901925124`, **[EK] Book Demo + Calendly booked -> Stage 1 Discovery deal**. This worker replaces its demo-form deal creation. Leave the form timestamp webhook, lead-source workflow, contact/deal property copying, association workflows, and separate HubSpot Meetings round-robin flow enabled. Check the replaced workflow has no active enrollments before activation.
4. On the HTTP worker only, set `DEMO_REQUEST_DEALS_ENABLED=true` and `DEMO_REQUEST_DEALS_ACTIVATED_AT` to the UTC activation timestamp, then deploy the configuration. The worker refuses to start if the replaced workflow is still enabled. Do not set these variables on the socket bot or `gtm-ops`.
5. Confirm the deployment is healthy. Read new lifecycle rows and the associated live HubSpot deal/contact/company records for the first genuine incoming submission. Do not manufacture a production CRM lead or Slack notification merely to test activation.

The activation cutoff prevents historical backfills. An email that already has a pre-activation notification root is an existing lead; a coalesced repeat does not generate a fresh opportunity just because this feature was enabled. The unique key and saved deal ID also prevent a previously closed form opportunity from being recreated on a repeat submission.

## Rollback

Set `DEMO_REQUEST_DEALS_ENABLED=false` and deploy. Do not delete deals, the unique property, or lifecycle linkage. Existing form-deal cancellation/reschedule protection remains based on saved PostgreSQL linkage while the flag is off. Restore the backed-up HubSpot workflow only after the worker is confirmed off. Deal owner edits made manually are preserved.

## Validation

Run `node --test scripts/slack/tests/*.test.js scripts/slack/test/*.test.js`. Focused tests cover new forms, missing/ambiguous companies, existing open deals, repeat submissions, lost creation responses, association retries, notification-independent retries, booking-first delivery, historical exclusion, owner preservation, and meeting cancellation. PostgreSQL migration/locking verification uses temporary shadow tables with mocked HubSpot and Slack writes, and rolls back the outer transaction.
