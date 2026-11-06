# Google Calendar → deal Next Meeting Start Time

HubSpot's `hs_next_meeting_start_time` is read-only. HubSpot derives it from upcoming meetings associated with a deal. This worker reads Google Calendar, reuses or creates HubSpot meeting activities, and supplies missing deal/contact associations. It never writes the system date property or changes Google events/invitations.

## Deployment

Prepare the hidden unique **meeting** property from `config/hubspot/google-calendar-meeting-property.json`. The worker validates it at startup. This property was prepared in the Truewind portal during implementation; do not recreate it.

Enable `GOOGLE_CALENDAR_DEAL_SYNC_ENABLED=true` only on the HTTP worker (`leads-update`). It needs the existing HubSpot token, Slack state PostgreSQL pool, and Google Calendar OAuth credentials. The job only starts for `BOT_ROLE=worker` or `all`; a PostgreSQL advisory lock prevents concurrent service instances from syncing together. It starts at boot and repeats every minute. Actual display updates also depend on HubSpot's asynchronous calculation.

The calendar roster comes from the current owners of all open deals, resolved to their HubSpot owner email addresses. Only those owners’ calendars are read. Unassigned deals or owners without a resolvable active email are skipped; there is no fallback to a different person’s calendar. The roster refreshes each scan, including after ownership changes. This does not enumerate the Workspace directory or grant additional Google permissions. A calendar needs event-detail access, not just free/busy. Unavailable calendars are reported in the job summary and never treated as cancellations. The current 70 open deals belong to Sarah, Xavier, Dillon and Alex; all four calendars are readable. Other team calendars are excluded.

`GOOGLE_CALENDAR_DEAL_SYNC_INTERVAL_MS` defaults to 60000 (minimum 60000). `GOOGLE_CALENDAR_DEAL_SYNC_HORIZON_DAYS` defaults to 365 (maximum 730) so recurring series have a finite expansion. Each scan considers all open deals and qualifying events on their respective owners’ calendars within that rolling horizon. Calendar reads run concurrently; deal/contact and meeting associations are fetched in batches. Existing links and unchanged meeting properties are not rewritten on every poll. Already tracked occurrences are fetched individually when absent, including moves outside the horizon.

## Matching and updates

- Exact attendee email, including HubSpot contact aliases, must match a contact already linked to an open deal **and the event must appear on that deal owner’s calendar**. An event seen only on Xavier’s calendar cannot qualify for Sarah’s deal. Matching uses the selected owner’s copy for dates and tracking, even when other owners have copies of the same event. Company-domain guesses are not used. Declined attendees, resources, private/incomplete events, internal-only events, all-day events, and non-meeting event types are excluded.
- If the contact belongs to several deals, a single existing event-to-deal link can resolve it. Otherwise the event is skipped as ambiguous. A meeting linked to a conflicting deal is left for review.
- Google event source IDs/links identify native HubSpot meetings. Older Calendly/manual records require exact start/end/title plus an associated attendee contact. Multiple indistinguishable matches are skipped. Existing owners and explicit completed/no-show outcomes are preserved.
- Cross-calendar copies are deduplicated by iCalUID and recurring original occurrence time, with the organizer copy preferred. Rescheduling keeps that identity. A hidden unique property prevents duplicate creation after lost responses; a durable mapping is saved before associations so partial work retries safely.
- Confirmed Google cancellation (or 404/410 on the specific event after its calendar was successfully read) marks the corresponding HubSpot meeting canceled. A reschedule updates its existing start/end time. After reassignment, the previous owner’s tracked calendar event is not fetched for that deal; the new owner’s copy must qualify first. Missing-window events are fetched directly rather than presumed canceled. Only deal associations added by this sync are removed when an event no longer contains an external customer; preexisting links remain under human control. Closing a deal preserves its historical meeting association.

The job logs aggregate counts, unavailable calendar IDs, and sanitized error codes. No attendee emails, event descriptions, tokens, or Slack messages are emitted. Turning the flag off stops future updates; existing CRM activities/associations remain. Search results over 10,000 or incomplete contact reads fail safely rather than applying a partial deal index.

## Read-only validation

Owner-scoped implementation preview: 70 open deals, 4 readable owner calendars, 329 eligible deduplicated events, 27 clear event matches across 26 deals. The complete snapshot and matching preview took 4.6 seconds and 9 HubSpot read requests in one observed run; this is a measurement, not an end-to-end latency guarantee. Polling adds up to one minute before the next scan, followed by scan time and HubSpot’s asynchronous calculation. All 27 could reuse existing HubSpot meeting records; 12 were missing the deal link. One conflicting existing association was skipped. These counts are a preview, not evidence that production associations were changed.

References: [HubSpot deal properties](https://knowledge.hubspot.com/properties/hubspots-default-deal-properties), [Meetings API](https://developers.hubspot.com/docs/api-reference/legacy/crm/activities/meetings/guide), [Google events list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

## Last Meeting Date

`truewind_last_meeting_date` (label **Last Meeting Date**) is a separate writable deal datetime property. HubSpot's built-in `engagements_last_meeting_booked` remains unchanged because it is read-only and specific to HubSpot scheduling links.

Prepare the schema in `config/hubspot/google-calendar-last-meeting-property.json` and set `GOOGLE_CALENDAR_LAST_MEETING_ENABLED=true` on the HTTP worker. The property is validated before the feature starts. The date is the **start of the most recent event that has already ended**, matched on the current open-deal owner's calendar using the same contact-email and ambiguity rules. Future and ongoing events, private/incomplete events, canceled events, and HubSpot records marked canceled, no-show or rescheduled are excluded. Calendar history alone cannot verify attendance; this is not a claim that every elapsed event actually took place.

Recent dates advance with the one-minute sync, which includes the previous day when this feature is enabled. A separate historical job runs immediately at boot and every 15 minutes by default (`GOOGLE_CALENDAR_LAST_MEETING_HISTORY_INTERVAL_MS`, minimum 60000). It queries all available past Google Calendar history with no lower date cutoff, using a separate concurrency lock so it does not hold the upcoming sync's lock. Calendar responses omit unused fields, and the historical job uses paginated meeting listing rather than the rate-limited CRM search endpoint.

A complete historical scan can move the date backward or clear it if its source was canceled, deleted, reassigned or no longer matches. Recent scans only advance it. Failed/inaccessible calendars and unresolved newer ambiguities preserve existing values. Fresh owner, open-status and current-value checks avoid applying a stale snapshot after reassignment, deal closure or another date update. No historical HubSpot meeting records are created by this feature, and existing meeting outcomes are not changed to claim completion.

Historical corrections can take up to the history interval plus scan time. The historical job reads all meeting pages and avoids the CRM search 10,000-result cap. Failed or incomplete reads prevent historical date writes; the upcoming sync continues independently. Logs report only aggregate counts and sanitized errors. Disabling the flag stops both historical/recent custom-date updates, retaining existing deal values.
