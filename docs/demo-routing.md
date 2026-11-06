# Existing-deal demo routing

This feature spans `leads-update` and the WWW application in `truewind-core`. It ships disabled.
It changes only contacts with a demo submission at or after `DEMO_ROUTING_ACTIVATED_AT`.
The selected open deal's current owner is authoritative; company owners are never written.

## Configuration

Set the same activation timestamp and `DEMO_ROUTING_OWNERS_JSON` on the Slack worker and GTM-ops service.
Each registry row contains `ownerId`, `calendlyUrl`, `slackUserId`, `hostUris`, and `eventTypeUris`.
IDs and links must come from the actual HubSpot owner, Slack user, and active Calendly personal event.
Do not guess a missing link or use a pooled event as an owner's personal calendar.
The registry is independent of the new-lead round-robin roster. An empty registry cannot pass coverage.

Generate a dedicated random `DEMO_ROUTING_INTERNAL_TOKEN` of at least 32 characters in the secret store.
Set that same secret on WWW; set `DEMO_ROUTING_SERVICE_URL` there to the Slack worker's HTTPS origin.
WWW's `DEMO_ROUTING_ENABLED` remains false until the worker and workflows are ready. Optional
`DEMO_ROUTING_FALLBACK_CALENDLY_URL` overrides the website's existing default general calendar.
Existing form fields, consent behavior, and the public `{ message, calendlyUrl }` response are preserved.

`POST /internal/demo-routing/resolve` requires `Authorization: Bearer <dedicated secret>` and accepts
`{ email, contactId? }`. It is read-only and returns `existing_deal`, `no_open_deal`, or `unresolved`.
Internal IDs never go into the public form response. A missing calendar is an existing-deal resolution
with a null `calendlyUrl`; the website uses the general fallback without claiming this is a new lead.
The service has a 4.5-second resolution deadline and WWW a 5-second total routing deadline.

## Workflow changes required before activation

Read-only inspection on 2026-10-22 found these enabled workflows in portal 43974586:

| Workflow | Required exclusion |
| --- | --- |
| `1622919047` Demo Form Submission / Self-Serve Leads | Skip rotation (action 26) and legacy demo Slack delivery for matched future existing-deal submissions. Retain date stamping, source fields, and existing new-lead/self-serve behavior. |
| `1894814870` Sales Demo RR — Set Contact owner from meeting host | Exclude matched future existing-deal submissions from contact-owner actions 3 and 5. Its name says DRAFT OFF, but its enabled flag was true. |
| `1901925124` Book Demo + Calendly booked -> Stage 1 Discovery deal | Prevent action 1 from creating another deal for matched future submissions. Its `num_associated_deals < 1` check alone is insufficient before asynchronous associations settle. |
| `1901998750` demo form webhook | Preserve its timestamp action and repeated-submission trigger. |
| `1905382931` Company owner -> Contacts on companies with open deals | Found disabled; keep disabled for matched submissions. |
| `1905383078` Open deal owner -> Company owner | Existing workflow is outside this change. Confirm its enrollment remains tied to actual owner changes; routing must not rewrite the deal or company owner. |

Workflow exclusions must run after the current submission's routing has resolved, including newly created
contacts whose company associations have not yet settled. On unresolved routing, defer assignment,
legacy notification, and deal creation; do not treat a missing association as permission to proceed.
Do not add only an immediate association check and declare this verified. These live workflow changes
are a separate coordinated rollout operation; the code does not edit workflow definitions.
Set `DEMO_ROUTING_WORKFLOWS_VERIFIED=true` only after controlled tests prove these exclusions.
Also verify the account-level company-to-contact owner inheritance setting does not undo the result.

## Readiness and rollout

1. Deploy both PRs with routing disabled. The existing notification store adds a routing-context column;
   the booking store is initialized only when an activation timestamp is configured. No manual production
   migration or historical record repair is needed.
2. Verify all eligible owners' actual calendar events and Slack identities. Set
   `DEMO_ROUTING_REGISTRY_VERIFIED=true` after collecting the verified registry. Startup also checks
   open-deal owner coverage, Calendly account/host identity, active scheduling links, and Slack identity.
3. Make the workflow exclusions above, test them, then set the workflow verification flag.
4. With project-scoped credentials injected, run `node scripts/demo-routing-check.js --email <test-email>`
   for read-only matching and `node scripts/demo-routing-check.js` for coverage/provider readiness.
   Neither command updates CRM or starts a worker. Use synthetic fixtures for write-enabled tests; do not
   replay historical production form events or bookings.
5. Set an explicit UTC activation timestamp and enable the Slack worker, GTM-ops, and WWW together.
   Monitor `demo_routing_unresolved`, `demo_routing_calendar_fallback`, owner corrections, recovery errors,
   and notification review events. Configure internal error alerts for these events before activation.

Calendar access was verified on 2026-10-22 as the Truewind account `mercedes@trytruewind.com`.
The earlier HTTP 403 was reproduced with the validation client's default headers; explicitly identified
requests succeeded with both the previous production credential and the newly supplied key. The HTTP
clients now identify themselves consistently. The new key was saved to the production service's
configuration with deployment skipped.

The current open-deal owner coverage is Alex, Sarah, and Xavier. Their active personal event links,
single-host memberships, HubSpot owner identities, and existing active Truewind Slack-ID mappings were
verified. The registry is staged on `leads-update` and `gtm-ops`, with routing explicitly disabled and
no deployment triggered. Re-run coverage before activation because ownership can change.

The Slack app lacks `users:read.email`. When email is exposed, validation requires an exact owner-email
match. When it is hidden, validation accepts only the exact existing configured owner-to-Slack-ID mapping
and checks that the returned user ID is active. It never infers identity from a display name. Calendar
validation checks the event's actual hosts, because listing a user's events can include shared events.
The workflow verification flag remains unset; this calendar validation does not clear that rollout gate.

## Failure handling and rollback

Provider failures are unresolved, never a verified absence of a deal. The form still submits and shows
the general fallback. Signed submission notifications retry incomplete ownership reconciliation; a
30-second recovery loop reclaims pending notifications. Ambiguous Slack delivery is quarantined rather
than automatically reposted. Inspect `hubspot_demo_notifications.routing`, `status`, and `last_error`.

Booking links are keyed by invitee URI in PostgreSQL. Connection-scoped advisory locks serialize replica
processing; the same client performs the guarded database work. Each invitee has a separate meeting.
Do not overwrite shared deal event identifiers. A canceled reused-opportunity booking updates meeting
activity only, including after the feature is disabled. Review `demo_booking_links.notification_state`
when `needs_review` or stale `sending` appears; reconcile delivery before any manual replay.

For rollback, disable routing across WWW and workers. Retain the activation timestamp, registry, database
and updated booking handler so persisted reused-deal bookings remain protected. Do not revert to a handler
that can close existing opportunities on cancellation. Stop/restrict assignment workers before restoring
legacy workflows, because historical roster cleanup can otherwise undo ownership on protected contacts.
