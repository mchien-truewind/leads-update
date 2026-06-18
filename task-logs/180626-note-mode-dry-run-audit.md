# 180626 - Note Mode Dry Run Audit

## What Was Asked

Mercedes asked to run the Phase 1 HubSpot lead-status note-mode dry run to see what it looks like.

## What Was Done

- Ran the local Phase 1 code in dry-run mode against HubSpot using the Truewind project-scoped token from `/Users/mc/projects/truewind/.env.local`.
- Mapped `HUBSPOT_MERCEDES_CLAUDE` to `HUBSPOT_PRIVATE_TOKEN` only for the command because `leads-update` expects `HUBSPOT_PRIVATE_TOKEN`.
- Command shape:

```sh
node scripts/slack/lead_status_sync.js --dry-run --skip-slack --touchpoint-source notes --preview-limit 10
```

- Saved the full dry-run JSON to `/tmp/truewind-lead-status-notes-dry-run.json`.
- Ran two small read-only follow-up audits against HubSpot note records, without printing note bodies or contact details:
  - sampled note `hubspot_owner_id` / `hs_created_by_user_id`;
  - sampled note owner/source-related properties from the notes property schema.

## Decisions Made

- Do not enable note mode for live scheduled writes yet.
- Keep the Phase 1 code conservative: it should not count notes without a trustworthy BDR owner mapping.
- Treat the dry-run result as a data-shape blocker, not a code failure.

## Mistakes, Blockers, And Fixes

- The first dry-run command failed because the Truewind env file does not define `HUBSPOT_PRIVATE_TOKEN`; it defines `HUBSPOT_MERCEDES_CLAUDE`. Fixed by command-scoped mapping without printing the token.
- The dry run found that associated note reads work, but note attribution is not currently usable:
  - `notesScanned`: `836`
  - `notesCounted`: `0`
  - `noteExclusions.non_bdr_owner`: `828`
  - `noteExclusions.outside_window`: `8`
- A 25-contact / 56-note read-only sample showed:
  - `hubspot_owner_id`: blank on all sampled notes;
  - `hs_created_by_user_id`: blank on all sampled notes;
  - `hs_all_owner_ids`: blank on all sampled notes;
  - `hs_object_source_detail_1`: `Glue` or `mercedes-claude`.

## What Was Learned

- The HubSpot contact-to-note association API path works for list `694` contacts.
- The notes currently appear to be integration-created and do not carry activity owner fields that map directly to BDR owner IDs.
- If `LEAD_STATUS_SYNC_TOUCHPOINT_SOURCE=notes` were enabled as-is, it would likely recalculate many `bdr_touchpoints_90d` fields to `0`, which is not acceptable.
- The next implementation step is to identify a reliable attribution source for Glue / mercedes-claude-created notes, likely by parsing a structured, non-PII source marker or by mapping integration-generated note formats to BDRs from safe metadata.

## Verification

- Dry run was read-only: `--dry-run --skip-slack --touchpoint-source notes`.
- No HubSpot writes were performed by the dry run because `dryRun=true`.
- No Slack messages were posted because `skipSlack=true`.
- Follow-up audits were read-only HubSpot API calls and did not print note body text.

## Follow-Ups

- Do not set `LEAD_STATUS_SYNC_TOUCHPOINT_SOURCE=notes` in Railway yet.
- Inspect a sanitized sample of Glue / mercedes-claude note body formats to determine whether BDR attribution and channel can be recovered safely.
- Consider adding an explicit metadata-writing fix upstream so future notes include `hubspot_owner_id` or another deterministic BDR owner field.
- Once attribution is solved, rerun the same dry run and confirm `notesCounted` is nonzero and spot-check preview rows before enabling live note-mode writes.
