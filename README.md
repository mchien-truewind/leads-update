# agentic-lite

A bare-bones extraction of `agentic-os` focused on:
- Agent handbook (`AGENTS.md`)
- Task logs + per-task worktrees
- Minimal SOPs/templates
- `.codex` skill sync

## Quick Start

1. Set `AGENTIC_HOME`:
   ```sh
   export AGENTIC_HOME="$PWD"
   ```
2. Run preflight (warn-only):
   ```sh
   ./scripts/core/preflight.sh
   ```
3. Create a task log + worktree:
   ```sh
   ./scripts/task/task-bootstrap.sh --name "$(date +%Y%m%d%H%M%S)-example" --slug "Example task"
   ```
4. Sync skills into Codex discovery directory:
   ```sh
   ./.codex/scripts/codex-skills/sync_codex_skills.sh
   ```

## SOPs

- HubSpot credential setup and safe verification: `docs/instructions/hubspot-credential-verification.md`

## Slack Claude Bot (Railway)

The Slack Cloudbot runs with:

```sh
npm start
```

That starts `node scripts/slack/slack_bot.js`.

Required Claude/Anthropic env:

```sh
ANTHROPIC_API_KEY=...
CLAUDE_MODEL_DEFAULT=claude-sonnet-4-6
CLAUDE_MODEL_HIGH=claude-opus-4-1-20250805
CLAUDE_DIGEST_MODEL=claude-sonnet-4-6
```

The Slack reply path routes simple/direct asks to `CLAUDE_MODEL_DEFAULT` and more complex asks to `CLAUDE_MODEL_HIGH`.
`CLAUDE_DIGEST_MODEL` controls the discovery digest transcript extraction model separately.
All model variables are optional in code; use exact Anthropic API model IDs, not Claude.ai plan names.

Required for HubSpot writes:

```sh
HUBSPOT_PRIVATE_TOKEN=...
FIRECRAWL_API_KEY=...
```

Optional owner mapping for the end-to-end HubSpot prospect workflow:

```sh
SLACK_TO_HUBSPOT_OWNER_JSON='{"U12345678":{"id":"87811681","name":"Mercedes Chien"}}'
HUBSPOT_WRITE_ALLOWED_SLACK_USER_IDS=U12345678,U23456789
HUBSPOT_WRITE_ALLOWED_SLACK_CHANNEL_IDS=C12345678
```

The workflow first tries to match the Slack tagger's Slack email to a HubSpot owner. That requires Slack `users:read.email` scope; if unavailable, it checks the optional Slack user mapping. HubSpot writes are authorized when the tagger maps to a HubSpot owner or the Slack user/channel is allowlisted. If no owner can be mapped for an authorized request, it defaults to Xavier Marco (`89305622`). Firecrawl is used to find and scrape LinkedIn profiles before contact creation; without `FIRECRAWL_API_KEY`, the workflow falls back to email/company parsing.

## Daily Lead Progress Slack Post (Railway)

The Railway Slack bot posts the report to `#gtm-general` at 6:07 PM Pacific on Sunday and Monday-Friday. Counts come from HubSpot deals created from Monday 00:00 Pacific through the report run time in the active pipeline. Obvious test/internal deals are skipped, and duplicate normalized deal names are counted once before grouping by the configured deal source property. When duplicate normalized deal names exist, the report keeps the most complete deal for reporting fields, preferring records with populated `deal_source`, owner, amount, close date, and stage; created date is only the tie-breaker.

- `deal_source` starting with `Inbound` counts as Inbound.
- `deal_source` starting with `Outbound` counts as Outbound, including values like `Outbound - Event`.
- Blank or nonmatching deal source values count as Unknown and appear as `Unknown: X`.

Required env:

```sh
SLACK_BOT_TOKEN=xoxb-...
HUBSPOT_PRIVATE_TOKEN=...
LEAD_REPORT_TARGET_CHANNEL=gtm-general
LEAD_REPORT_TRIGGER_SECRET=...
```

Optional overrides:

```sh
LEAD_REPORT_DEAL_SOURCE_PROPERTY=deal_source
LEAD_REPORT_PIPELINE_ID=105321581
LEAD_REPORT_WEEKLY_GOAL=30
```

Manual test post from Railway:

```sh
curl -H "x-lead-report-token: $LEAD_REPORT_TRIGGER_SECRET" \
  https://leads-update-production.up.railway.app/run-daily-progress
```

To intentionally post a second copy for same-day testing, append `?allowDuplicate=1`.

Legacy local fallback:

1. Put your token in `.env.local`:
   ```sh
   SLACK_USER_TOKEN=xoxp-...
   ```
2. Optional overrides in `.env.local`:
   ```sh
   LEAD_REPORT_TARGET_CHANNEL=gtm-general
   LEAD_REPORT_INBOUND_CHANNEL=leads
   LEAD_REPORT_OUTBOUND_CHANNEL=gtm-outbound
   LEAD_REPORT_INBOUND_PHRASE=Booked Calendly Meeting
   LEAD_REPORT_OUTBOUND_PHRASE=New Meeting
   LEAD_REPORT_TIMEZONE=America/Los_Angeles
   ```
3. Test with Slack keyword counts to `#gtm-general`:
   ```sh
   python3 scripts/slack/post_daily_progress.py --target-channel gtm-general
   ```
4. Install daily scheduler (macOS `launchd`, 18:07 local machine time):
   ```sh
   ./scripts/slack/install_daily_progress_launchd.sh
   ```
5. Trigger it immediately (optional):
   ```sh
   launchctl kickstart -k gui/$(id -u)/com.agenticlite.daily-lead-progress
   ```

Notes:
- The Railway Slack bot is the production source of truth for this report.
- The target Slack channel must be public or otherwise visible to Slack `conversations.list`.
- The "This week so far" total includes Monday through the current report run, then restarts on Monday.
- It posts with the same message format used in local runs.
- The local fallback uses Slack keyword counts, so Unknown is always `0` there; production HubSpot counts include blank and nonmatching `deal_source` values in Unknown.

## Daily HubSpot Lead Status Sync (Railway)

The Railway Slack bot also runs a daily HubSpot contact sync for list `694` (`[GTM Team] All Open Leads`) at 7:30 PM Pacific and posts a summary to `#slack-testing`.

The sync is deterministic and does not call an LLM. Daily incremental runs search recent HubSpot activity timestamp fields with a 28-hour lookback, intersect those contacts with list `694`, then inspect only allowed contact engagements for those candidates. Allowed touchpoints are outbound `EMAIL`, outbound `CALL`, `MEETING`, and `TASK` engagements owned by the configured BDRs or sent from configured BDR emails. Segment/list membership changes do not count as touchpoints. Full-list mode is available by manual trigger, or by setting an optional weekly full-run weekday.

Status rules:
- New: `No one has contacted them` when there is no counted outreach activity.
- Working: `Has contacted but no response` when BDR touchpoints exist and no reply signal exists.
- Nurturing: `has contacted & responded` when a reply or meeting-booked signal exists.
- Disqualified: `Disqualified (all)` when deterministic disqualification signals exist; `disqualified_reasons` is preserved or backfilled.
- Protected statuses are not overwritten: `MQL`, existing disqualified contacts, and customer/opportunity/evangelist lifecycle contacts.

Required env:

```sh
SLACK_BOT_TOKEN=xoxb-...
HUBSPOT_PRIVATE_TOKEN=...
LEAD_STATUS_SYNC_TRIGGER_SECRET=...
```

Optional overrides:

```sh
LEAD_STATUS_SYNC_TARGET_CHANNEL=slack-testing
LEAD_STATUS_SYNC_LIST_ID=694
LEAD_STATUS_SYNC_LOOKBACK_HOURS=28
LEAD_STATUS_SYNC_TOUCHPOINT_DAYS=90
LEAD_STATUS_SYNC_BDR_OWNER_IDS=84547076,89305622,91143842,91143844
LEAD_STATUS_SYNC_BDR_EMAILS=sarah@trytruewind.com,xavier@trytruewind.com,jenilee@trytruewind.com,brendan@trytruewind.com
LEAD_STATUS_SYNC_TARGET_HOUR=19
LEAD_STATUS_SYNC_TARGET_MINUTE=30
LEAD_STATUS_SYNC_WEEKLY_FULL_DAY=0  # optional; 0=Sunday, blank disables scheduled full runs
```

Manual dry run from Railway:

```sh
curl -H "x-lead-status-sync-token: $LEAD_STATUS_SYNC_TRIGGER_SECRET" \
  "https://leads-update-production.up.railway.app/run-lead-status-sync?dryRun=1&skipSlack=1"
```

Manual full run:

```sh
curl -H "x-lead-status-sync-token: $LEAD_STATUS_SYNC_TRIGGER_SECRET" \
  "https://leads-update-production.up.railway.app/run-lead-status-sync?mode=full"
```

## Overnight Apollo Phone Enrichment (Webhook + Google Sheets)

This runner submits Apollo `people/match` requests with `reveal_phone_number=true`, polls webhook callbacks, and continuously writes updates into a target sheet tab.

Script:
- `scripts/contact_enrichment/apollo_webhook_sheet_enrich.py`

Required env:
- `APOLLO_SEARCH` in `.env.local`

Required auth file:
- `secrets/google-drive-token.json` (Drive scope)

Example run:
```sh
python3 scripts/contact_enrichment/apollo_webhook_sheet_enrich.py \
  --sheet-id 1ftKEvAFFyietBwBKieylaEc5LvVjwE0_GvmrfnjmUP4 \
  --source-tab "Non-Accounting Firm Buyers (2025)" \
  --target-tab "Non-Accounting Buyers Enriched" \
  --state-file outputs/contact_enrichment/apollo_webhook_enrichment_state.json \
  --summary-file outputs/contact_enrichment/apollo_webhook_enrichment_summary.json \
  --max-poll-minutes 480
```

Resume an interrupted run:
```sh
python3 scripts/contact_enrichment/apollo_webhook_sheet_enrich.py \
  --sheet-id 1ftKEvAFFyietBwBKieylaEc5LvVjwE0_GvmrfnjmUP4 \
  --resume \
  --state-file outputs/contact_enrichment/apollo_webhook_enrichment_state.json \
  --summary-file outputs/contact_enrichment/apollo_webhook_enrichment_summary.json
```

Run overnight (detached):
```sh
mkdir -p outputs/contact_enrichment
nohup python3 scripts/contact_enrichment/apollo_webhook_sheet_enrich.py \
  --sheet-id 1ftKEvAFFyietBwBKieylaEc5LvVjwE0_GvmrfnjmUP4 \
  --source-tab "Non-Accounting Firm Buyers (2025)" \
  --target-tab "Non-Accounting Buyers Enriched" \
  --state-file outputs/contact_enrichment/apollo_webhook_enrichment_state.json \
  --summary-file outputs/contact_enrichment/apollo_webhook_enrichment_summary.json \
  --max-poll-minutes 480 \
  > outputs/contact_enrichment/apollo_webhook_overnight.log 2>&1 &
```

Tail logs:
```sh
tail -f outputs/contact_enrichment/apollo_webhook_overnight.log
```
## Google Calendar Meeting Creation

Use this local CLI to create meetings from Codex.

1. Create a virtual environment and install dependencies:
   ```sh
   python3 -m venv .venv
   source .venv/bin/activate
   python3 -m pip install -r requirements-google-calendar.txt
   ```
2. Copy calendar env defaults:
   ```sh
   cp .env.google-calendar.example .env
   mkdir -p secrets
   ```
3. In Google Cloud Console:
   - Enable Google Calendar API
   - Create OAuth client credentials (Desktop app)
   - Save the JSON to `secrets/google-calendar-credentials.json`
4. Authenticate once:
   ```sh
   python3 scripts/google_calendar/calendar_cli.py auth
   ```
5. Create a meeting:
   ```sh
   python3 scripts/google_calendar/calendar_cli.py create \
     --title "1:1 with Alex" \
     --start "2026-02-24T14:00" \
     --duration-minutes 30 \
     --attendee "alex@example.com" \
     --description "Weekly sync" \
     --with-meet
   ```

If `pip` is not found on your machine, always use `python3 -m pip ...`.

## Pre-Meeting 1:1 Focus Briefs

Generate a focus brief for upcoming 1:1 meetings by combining Calendar events + matching 1:1 Google Docs.

1. Ensure Workspace token exists with Docs + Drive metadata scopes:
   ```sh
   python3 scripts/google_workspace/premeeting_briefs.py --lookahead-hours 1
   ```
   The first run may open a browser for OAuth consent.

2. Run the briefing command:
   ```sh
   python3 scripts/google_workspace/premeeting_briefs.py --lookahead-hours 168
   ```

Output includes, per person:
- Meeting title/time
- Calendar link
- Matched 1:1 doc link
- Suggested focus bullets extracted from recent actionable lines in that doc

## Gmail Inbox Auto-Filter + Draft Drafting

Auto-process inbox threads with this workflow:
- Auto-reply/subscription style emails -> label `gen-auto` + archive
- Marketing/promotional emails -> label `gen-marketing` + archive
- Conference/event threads -> label `gen-conference` + archive
- Conversation threads -> create draft replies in Gmail Drafts (never auto-send), but only when:
  - explicit actionable intent is detected, and
  - draft confidence meets threshold (`--min-draft-confidence`, default `2`)
- Low-confidence conversation threads are labeled `gen-needs-review` instead of drafting.

Script:
- `scripts/google_workspace/gmail_inbox_triage.py`

1. Ensure Gmail OAuth credentials exist:
   - `secrets/google-gmail-credentials.json`

2. Authenticate (first run or after scope changes):
   ```sh
   python3 scripts/google_workspace/gmail_inbox_triage.py auth
   ```

3. Run safely in dry-run mode first:
   ```sh
   python3 scripts/google_workspace/gmail_inbox_triage.py run --max-threads 25 --dry-run
   ```

4. Configure Slack response-needed alerts before running with mutations enabled.
   Real runs fail closed unless Slack notifications are configured. Set either a DM/user target:
   ```sh
   export SLACK_USER_ID=U1234567890
   ```

   Or set a channel plus an explicit mention:
   ```sh
   export GMAIL_TRIAGE_SLACK_CHANNEL=hiring-review
   export GMAIL_TRIAGE_SLACK_MENTION_USER_ID=U1234567890
   ```

   The token defaults to `SLACK_BOT_TOKEN`, then `SLACK_USER_TOKEN`. Use `--slack-token-env` to point at another env var. Use `--no-slack-notifications` only for an intentional non-alerting run.

5. Run with mutations enabled:
   ```sh
   python3 scripts/google_workspace/gmail_inbox_triage.py run --max-threads 25
   ```

Optional: force-refresh existing drafts for unchanged inbound messages:
```sh
python3 scripts/google_workspace/gmail_inbox_triage.py run --max-threads 25 --refresh-existing-drafts
```

Optional: control style-learning cache behavior (default reuses cached profile for 24h):
```sh
python3 scripts/google_workspace/gmail_inbox_triage.py run --max-threads 25 --style-cache-ttl-hours 24
python3 scripts/google_workspace/gmail_inbox_triage.py run --max-threads 25 --refresh-style-profile
```

6. Audit drafts addressed to blocked/no-reply senders (report-only):
   ```sh
   python3 scripts/google_workspace/gmail_inbox_triage.py audit-blocked-drafts --max-drafts 500 --dry-run
   ```

7. Delete blocked drafts found by the audit:
   ```sh
   python3 scripts/google_workspace/gmail_inbox_triage.py audit-blocked-drafts --max-drafts 500 --delete
   ```

Outputs:
- Triage state: `outputs/gmail/inbox_triage_state.json`
- Learned style profile: `outputs/gmail/style_profile.json`
## Notion ATS Recruiting Coordinator (Draft-Only)

Treat Notion as your ATS for every candidate email in Gmail label `hiring@`.

Workflow:
- Ingest candidate emails + resumes from Gmail label.
- Require subject format: `ROLE - CANDIDATE NAME` where `ROLE` is `BDR` or `Growth Generalist`.
- Require subject prefix: `[hiring@]` before role/name.
- Upload resumes to Google Drive folder and store resume links in Notion.
- Set one `Career Stage` dropdown value (`Early`, `Mid`, `Late`).
- Set `Role` column from subject (`BDR` / `Growth Generalist`).
- Extract and store `LinkedIn URL`.
- Set `Company` and `Current Title` from LinkedIn URL enrichment (overwrites prior values when found).
- Classify `Location` as `U.S.` or `non-U.S.`.
- Set `Date first entered` from the first email timestamp in each `hiring@` thread.
- Post every newly-ingested candidate to Slack `#hiring-review` with resume and Notion links.
- Sync Slack reaction decisions into Notion:
  - React `:white_check_mark:` -> `Proceed`
  - React `:x:` -> `Reject`
- Read `Decision` from Notion and create draft-only replies:
  - `Proceed` -> intro call draft
  - `Reject` -> delayed rejection draft after 24 hours
  - After candidate reply -> propose first available 20-minute slot and draft scheduling reply

No calendar event is auto-created in this flow.

### Setup

1. Install dependencies:

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements-recruiting.txt
```

`requirements-recruiting.txt` now includes `docling`, which the recruiter uses as the primary parser for resume PDFs/docx to improve latest role/company and LinkedIn extraction quality.

2. Configure env vars in `.env.local`.

You can use canonical names:
- `NOTION_INTERNAL_INTEGRATION_SECRET`
- `NOTION_DATABASE_ID`
- `GOOGLE_DRIVE_FOLDER_ID`

Or the aliases already used in your setup:
- `NOTION_INTERNAL_INTEGRATION`
- `NOTION_ATS_DB_ID`
- `GOOGLE_DRIVE_FOLDER_ATS`

Use `.env.recruiting.example` as the reference.

3. Ensure OAuth credential files exist under `secrets/`:
- `google-gmail-credentials.json`
- `google-drive-credentials.json`
- `google-calendar-credentials.json`
4. Ensure People Data Labs API key is set for LinkedIn enrichment:
- `PDL_API` (or `PDL_API_KEY`)
5. Configure Slack review channel integration:
- `SLACK_BOT_TOKEN` (or `SLACK_USER_TOKEN`)
- `RECRUITING_SLACK_REVIEW_CHANNEL=hiring-review`
- Optional: `RECRUITING_SLACK_REVIEW_CHANNEL_ID=<channel-id>` (recommended to avoid extra Slack API lookups)
- Invite the Slack app/user token identity to `#hiring-review`

### Commands

Authenticate + verify schema:

```sh
python3 scripts/recruiting/coordinator_cli.py auth
python3 scripts/recruiting/coordinator_cli.py schema-check
```

Run ingestion only:

```sh
python3 scripts/recruiting/coordinator_cli.py ingest
```

Process Notion decisions only:

```sh
python3 scripts/recruiting/coordinator_cli.py process-decisions
```

Sync Slack reactions into Notion decisions:

```sh
python3 scripts/recruiting/coordinator_cli.py sync-slack-decisions
```

Run full cycle:

```sh
python3 scripts/recruiting/coordinator_cli.py run
```

### Run Every 10 Minutes

Install launchd scheduler (macOS):

```sh
./scripts/recruiting/install_recruiting_sync_launchd.sh
```

Manual trigger:

```sh
launchctl kickstart -k gui/$(id -u)/com.agenticlite.recruiting-sync
```

Logs:

- `~/Library/Logs/agentic-lite/recruiting-sync.out.log`
- `~/Library/Logs/agentic-lite/recruiting-sync.err.log`

### Always-On (GitHub Actions)

If your laptop sleeps, use the cloud scheduler in `.github/workflows/recruiting-sync.yml`.

Required repository secrets:
- `NOTION_INTERNAL_INTEGRATION_SECRET`
- `NOTION_ATS_DB_ID`
- `GOOGLE_DRIVE_FOLDER_ATS`
- `RECRUITING_FROM_EMAIL`
- `SLACK_BOT_TOKEN` or `SLACK_USER_TOKEN`
- `GOOGLE_GMAIL_CREDENTIALS_JSON`
- `GOOGLE_GMAIL_TOKEN_JSON`
- `GOOGLE_DRIVE_CREDENTIALS_JSON`
- `GOOGLE_DRIVE_TOKEN_JSON`
- `GOOGLE_CALENDAR_CREDENTIALS_JSON`
- `GOOGLE_CALENDAR_TOKEN_JSON`
- Optional: `PDL_API`

Recommended repository variables:
- `RECRUITING_SLACK_REVIEW_CHANNEL_ID` (for example `C0AHRKW87LN`)
- `RECRUITING_SLACK_REVIEW_CHANNEL` (fallback channel name, default `hiring-review`)

Behavior:
- Runs every 10 minutes (`*/10 * * * *`) regardless of laptop sleep.
- You can also trigger it manually from GitHub Actions via **Run workflow**.
