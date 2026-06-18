# 170626 — Generic hubspot_create_deal defaults owner to the requester

## What was asked
Guarantee that **every** way a user creates a deal via the bot assigns the deal to the
requesting teammate, unless an owner is explicitly stated.

## Gap found
The "requester owns the deal" rule was enforced in the two structured flows
(`runStructuredDealCreateWorkflow`, `runTruewindHubSpotProspectWorkflow`) but **not** in
the generic `hubspot_create_deal` tool (the free-form path Claude uses when a user just
asks "create a deal"). That handler only set dealname/stage/pipeline/source, so those
deals could land unassigned or on the integration default.

## What was done — branch `fix/create-deal-defaults-owner-to-requester`
- In the `hubspot_create_deal` handler, when `hubspot_owner_id` isn't already set,
  resolve the requester from the trusted Slack metadata
  (`resolveHubSpotOwnerForProspect` + `resolveDealHubSpotOwner`) and set
  `props.hubspot_owner_id`. Priority is explicit owner > requester > Sarah/Xavier split,
  mirroring the structured flows.
- Test `testCreateDealToolDefaultsOwnerToRequester`: a free-form create by Alex Lee
  (`U04BPMPR29G`) assigns owner `559564379`; an explicitly provided owner is respected.
- All slack tests pass.

## Decisions made
- Reused the existing resolver chain rather than duplicating logic, so the static map +
  dynamic Slack-profile match from #79/#82 apply uniformly.
- Explicit owner (in `properties.hubspot_owner_id`) is never overwritten.

## Open questions / next steps
- After deploy, confirm a free-form "create a deal" from a teammate lands owned by them.
- All three creation paths now share the same owner rule.
