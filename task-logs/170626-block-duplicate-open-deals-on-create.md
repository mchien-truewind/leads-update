# 170626 — Block duplicate open deals on the generic create path + "override" keyword

## What was asked
When someone creates a new deal and an existing deal is already in the **open/active
pipeline (stages 1–5: MQL → Proposal; NOT stage 6 Closed/Won or stage 7 Closed/Lost)**,
block creation and tell them to coordinate with the deal owner. Allow a bypass when the
user explicitly types **"override"**. Goal: stop people creating duplicate deals.

## What already existed
- `findDuplicateOpenDeal` + `formatDuplicateDealError` + `isOpenHubSpotDeal` — and "open"
  already meant exactly stages 1–5 (Closed/Won and Closed/Lost are excluded via
  `TRUEWIND_CLOSED_DEAL_STAGE_IDS`). So the stage rule was already correct.
- The guard ran in the structured + prospect flows, but **not** in the generic
  `hubspot_create_deal` tool. Bypass was only `check_duplicates=false` (no "override" word).

## What was done — branch `fix/block-duplicate-open-deals` (stacked on #86)
- `hubspot_create_deal` handler now runs the open-duplicate guard before creating
  (using `company_name`/`email`/`company_id`/`contact_id`), returning
  `duplicate_deal_exists` instead of creating.
- Added a **code-level** `override` keyword: `hasDuplicateOverrideKeyword` /
  `shouldCheckDuplicates` skip the guard when the user's text contains the word
  "override" (word-boundary, case-insensitive) — deterministic, not prompt-only.
- Added identity + `check_duplicates` params to the `hubspot_create_deal` tool schema so
  Claude supplies what the guard needs.
- Updated `formatDuplicateDealError` message: "coordinate with the deal owner … reply
  with the word override".
- Updated the tool description + system prompt so Claude passes company identity,
  surfaces the block, and only proceeds on "override".
- Tests: `testDuplicateOverrideKeyword`, `testCreateDealToolBlocksOpenDuplicate`
  (blocks when open dup exists; "override" creates it). All slack tests pass.

## Decisions made
- **Override detected in code**, per the deterministic-harness principle — the bypass
  can't depend on the model alone.
- Reused the existing `findDuplicateOpenDeal`/`isOpenHubSpotDeal` so the stage definition
  stays single-sourced and identical across all creation paths.
- Stacked on #86 (both edit the same handler) to avoid a merge conflict.

## Open questions / next steps
- Merge order: **#86 first, then this** (this branch contains #86's commit).
- After deploy, confirm: creating a deal for a company that already has an open deal is
  blocked, and adding "override" lets it through.
