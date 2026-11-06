# Deals for new demo requests

The `leads-update` HTTP worker can create a HubSpot deal for each new demo-request contact, without waiting for a meeting. This is separate from the five-minute Slack notification window. The worker polls every 15 seconds; API failures retry every 30 seconds.

It reuses the saved deal or the newest open Active Pipeline deal associated with the contact or its companies. Otherwise it creates **Stage 1: Discovery** in **Active Pipeline**, with contact and known-company associations in the creation request. HubSpot's unique `truewind_demo_request_contact_id` property prevents duplicate creates after an ambiguous API response or process restart. Association retries retain the deal ID in PostgreSQL. Repeated forms and later Calendly bookings use the same opportunity.

Company selection prefers the primary associated company, then a sole associated company, then a unique corporate-domain or explicitly supplied company-name match. If none exists, it creates a company using the supplied name and business domain, or the business domain as its name. An explicit company name can also create a company for a personal-email lead; the personal email domain is never used. A hidden unique company key prevents duplicate creates after lost responses and across contacts sharing the same identity. Calendly reuses the lifecycle company instead of independently creating another. Missing or ambiguous company information does not stop deal creation: the deal title includes `[Company missing]` and its description explains what needs review. A personal email without a company name still gets the missing-company flag. Existing opportunities retain their owners and stages. New unowned form deals receive the verified form-routing owner when available. Canceling or rescheduling a meeting does not close or reopen the saved form opportunity.

## Activation

The feature defaults to **off**. Deploying this PR alone does not enable it.

1. Confirm the hidden unique deal property matches `config/hubspot/demo-request-deal-property.json`. Create it using `POST /crm/v3/properties/deals` if absent; never replace an existing non-unique property with the same name. Also prepare the hidden unique company property from `config/hubspot/demo-request-company-property.json` using `POST /crm/v3/properties/companies`. The worker verifies both schemas and the Discovery stage before starting.
2. Merge the reviewed PR and verify the exact merged commit deployed successfully to production `leads-update` (service `600dc5b7-e5f2-4399-8eac-4b596c84f56e`, Truewind Railway project `67b145f8-d6d9-4402-aa0d-310f005122be`). Keep the feature off during this deployment.
3. Back up and disable only HubSpot workflow `1901925124`, **[EK] Book Demo + Calendly booked -> Stage 1 Discovery deal**. This worker replaces its demo-form deal creation. Leave the form timestamp webhook, lead-source workflow, contact/deal property copying, association workflows, and separate HubSpot Meetings round-robin flow enabled. Check the replaced workflow has no active enrollments before activation.
4. On the HTTP worker only, set `DEMO_REQUEST_DEALS_ENABLED=true` and `DEMO_REQUEST_DEALS_ACTIVATED_AT` to the UTC activation timestamp, then deploy the configuration. The worker refuses to start if the replaced workflow is still enabled. Do not set these variables on the socket bot or `gtm-ops`.
5. Confirm the deployment is healthy. Read new lifecycle rows and the associated live HubSpot deal/contact/company records for the first genuine incoming submission. Do not manufacture a production CRM lead or Slack notification merely to test activation.

The activation cutoff prevents historical backfills. An email that already has a pre-activation notification root is an existing lead; a coalesced repeat does not generate a fresh opportunity just because this feature was enabled. The unique key and saved deal ID also prevent a previously closed form opportunity from being recreated on a repeat submission.

For an already-active installation, prepare the unique company property before deploying this extension. Keep the existing deal activation cutoff and workflow settings. The existing enabled worker will start company creation automatically; `APOLLO_API_KEY` enables enrichment after the same deployment. No historical company backfill is run.

## Rollback

Set `DEMO_REQUEST_DEALS_ENABLED=false` and deploy. Do not delete deals, the unique property, or lifecycle linkage. Existing form-deal cancellation/reschedule protection remains based on saved PostgreSQL linkage while the flag is off. Restore the backed-up HubSpot workflow only after the worker is confirmed off. Deal owner edits made manually are preserved.

## Apollo company enrichment

Set `APOLLO_API_KEY` on the HTTP worker to enable the separate company-enrichment worker. Company/deal creation and Slack notifications do not wait for Apollo. Company IDs are queued durably even when no key is configured, so adding the key and deploying can pick up pending enrichment.

Apollo fills blank website, domain, LinkedIn URL, industry, employee count, annual revenue, phone, city, state, country, postal code, description and founding year when a verified match provides them. It can replace a generated domain-as-name label on an automatically created company; otherwise it preserves existing company fields. It re-reads the company after the lookup to preserve intervening edits and rejects results whose domain or organization identity does not match. Industry values use the live HubSpot enumeration.

Domain/website identifies the company directly. For name-only companies, one search page must contain a unique exact name match across Apollo organizations and saved accounts; incomplete, partial or ambiguous results do not supply a guessed domain. Explicit company names from Calendly are persisted before processing so failures cannot lose them. Once a company is linked, generated missing-company deal flags are cleared; existing curated deal names are retained.

The per-company PostgreSQL queue uses advisory locks and caches mapped Apollo fields before HubSpot writes. Failed writes reuse that cache rather than repeating a paid lookup. New submissions can refresh a completed enrichment after 30 days; complete company records skip Apollo. HTTP failures and rate limits use an independent exponential backoff, while authentication failures wait an hour. Company identity changes discard the stale cache. Provider errors and keys are never logged. Public API references: [organization enrichment](https://docs.apollo.io/reference/organization-enrichment), [organization search](https://docs.apollo.io/reference/organization-search).

## Validation

Run `node --test scripts/slack/tests/*.test.js scripts/slack/test/*.test.js`. Focused tests cover new forms, missing/ambiguous companies, existing open deals, repeat submissions, lost creation responses, association retries, notification-independent retries, booking-first delivery, historical exclusion, owner preservation, and meeting cancellation. PostgreSQL migration/locking verification uses temporary shadow tables with mocked HubSpot and Slack writes, and rolls back the outer transaction.
