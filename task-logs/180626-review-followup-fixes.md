# 180626 — Fix issues found by the code-review agents

## What was asked
After consolidating the sales-admin bot, run an independent review of everything shipped
this session and fix the findings.

## Findings (from 3 adversarial reviewer agents) + fixes
1. **Auth gate spoofable on `hubspot_push_truewind_prospect`** — handler passed raw model
   `input` (no trusted metadata) into the workflow, so auth + owner used model-supplied
   slack_user_id/channel_id. Fixed: pass `toolInput` (server-trusted metadata).
2. **Calendly silently self-disabled** — `getCalendlyOrganization` cached `''` permanently
   after one transient `/users/me` failure. Fixed: cache only a real org; never cache a
   transient failure.
3. **Scheduler scans could overlap + held the event loop** — `setInterval` scans + no
   `unref`. Fixed: `unref` all timers + self-rescheduling `setTimeout` (next run only after
   current settles) + idempotency guard against double-scheduling.
4. **Durable no-double-prompt guard was dead** — post-prompt marker note was orphaned
   (notes can't attach to meetings). Fixed: anchor the marker note to the meeting's
   deal/contact/company and look it up via those records in `hasMeetingNoteContaining`.
5. **Calendly cancel match was exact-ms** — sub-minute skew missed the cancel. Fixed:
   ±60s tolerance.
6. **`HUBSPOT_MAX_ATTEMPTS` NaN → infinite retry loop.** Fixed: validate finite ≥1, else 5.
7. **Health server had no `error` handler** — EADDRINUSE crashed boot opaquely. Fixed:
   `.on('error')` → log + exit(1).
8. **`override` keyword false-positive on negated prose** ("do not override"). Fixed:
   negation guard.

## Tests
Updated the marker-dedup test for the new `(meeting, marker)` signature; added override
negation cases, Calendly ±60s tolerance, and a marker-anchoring/lookup test. All pass
(43 sales-admin + slack_bot_hubspot + 3 grain).

## Notes
Reviewer-verified-correct areas left unchanged (owner rule, filters, no-show writeback,
role gating, watchdog tolerance, token sanitize). Findings 2 and 4 were silent failures
(no error logs), so worth catching before relying on prod.
