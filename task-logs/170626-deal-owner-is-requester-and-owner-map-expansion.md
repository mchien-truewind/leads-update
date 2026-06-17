# 170626 — Deals owned by the requesting teammate + owner-map expansion

## What was asked
"Most of the time, the person asking to create a deal is the deal owner" — so deals
should be owned by the requesting teammate, not always split between Sarah/Xavier. Also
wire in the 6 current Slack→HubSpot owner mappings so the bot makes it easy for the team
to add deals. Supersede PR #77 (which targeted the same goal but was stale/conflicting).

## What was done — branch `fix/deal-owner-is-requester` (off `main` after #79/#80)
- **Deal ownership:** `resolveDealHubSpotOwner` now returns the requester as the deal
  owner whenever they resolved to a real HubSpot owner (`source === 'from Slack tag'`),
  not just when they are Sarah/Xavier. The deterministic Sarah/Xavier split now only
  applies as the fallback when the requester can't be identified. Removed the now-unused
  `isAllowedDealOwner` helper.
- **Owner map expansion:** added Andrew Moyer and Ari Nachman to both
  `DEFAULT_SLACK_TO_HUBSPOT_OWNER` and `TRUEWIND_HUBSPOT.ownersByName`.
- **Tests:** updated `testDealOwnerResolution` (requester owns deal + fallback split),
  added Andrew/Ari to `testGtmSlackUsersMapToHubSpotOwners`. All slack tests pass.

## Owner IDs — verified against the HubSpot owners API (15 owners)
| Name | Slack | HubSpot owner ID | Note |
|---|---|---|---|
| Xavier Marco | U0AKMHVCJMA | 89305622 | confirmed |
| Sarah Elix | U09QC3B292R | 84547076 | confirmed |
| Amy Vetter | U0B4MRN83FE | 92555980 | confirmed |
| Alex Lee | U04BPMPR29G | **559564379** | already in code |
| Andrew Moyer | U0BAMU9DYR4 | 93961770 | added |
| Ari Nachman | U0BARRLR6Q1 | 93961773 | added |

**Key correction:** the value provided for Alex Lee (`60918610`) is **not** a HubSpot
owner ID — it does not exist in the owners list. It's his HubSpot *user* ID. HubSpot
assigns records by *owner* ID; Alex's real owner ID is `559564379` (`alex@trytruewind.com`,
active), which the code already had. Owner ID ≠ user ID in HubSpot.

## Decisions made
- **Deals owned by requester** (per Mercedes), with Sarah/Xavier split as fallback only.
- **Implement fresh on `main` rather than resurrecting #77.** #77 was ~90% superseded by
  #78 (already merged: explicit-owner priority + `resolveProspectWorkflowOwner` + writing
  `hubspot_owner_id`) and would have conflicted with / regressed #78. The only net-new
  idea in #77 — deals owned by the requester — is implemented here cleanly. **#77 closed.**
- Kept the dynamic Slack-profile→owner resolution from #79; the static map is the
  deterministic fast path / fallback. With both, Andrew/Ari/Alex resolve correctly even
  if one path fails.

## Open questions / next steps
- Confirm in production that a deal created by Amy/Andrew/Ari lands with them as owner.
- The static map still lists Jenilee/Brendan (SDRs) — harmless; left as-is.
