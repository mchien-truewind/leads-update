# Google Calendar → deal Next Meeting Start Time

HubSpot's `hs_next_meeting_start_time` is read-only. HubSpot derives it from upcoming meetings associated with a deal. This worker reads Google Calendar, reuses or creates HubSpot meeting activities, and supplies missing deal/contact associations. It never writes the system date property or changes Google events/invitations.

## Deployment

Prepare the hidden unique **meeting** property from `config/hubspot/google-calendar-meeting-property.json`. The worker validates it at startup. This property was prepared in the Truewind portal during implementation; do not recreate it.

Enable `GOOGLE_CALENDAR_DEAL_SYNC_ENABLED=true` only on the HTTP worker (`leads-update`). It needs the existing HubSpot token, Slack state PostgreSQL pool, and Google Calendar OAuth credentials. The job only starts for `BOT_ROLE=worker` or `all`; a PostgreSQL advisory lock prevents concurrent service instances from syncing together. It starts at boot and repeats every five minutes. Actual display updates also depend on HubSpot's asynchronous calculation.

The calendar roster comes from active HubSpot owners with Truewind work emails. Add other readable calendar IDs as a comma-separated `GOOGLE_CALENDAR_DEAL_SYNC_CALENDARS` value. This does not enumerate the Workspace directory or grant additional Google permissions. A calendar needs event-detail access, not just free/busy. Unavailable calendars are reported in the job summary and never treated as cancellations. The existing connection can read 13 individual calendars; three group accounts return404.

`GOOGLE_CALENDAR_DEAL_SYNC_INTERVAL_MS` defaults to300000 (minimum60000). `GOOGLE_CALENDAR_DEAL_SYNC_HORIZON_DAYS` defaults to365 (maximum730) so recurring series have a finite expansion. Each scan considers all open deals and qualifying events within that rolling horizon. Already tracked occurrences are fetched individually when absent, including moves outside the horizon.

## Matching and updates

- Exact attendee email, including HubSpot contact aliases, must match a contact already linked to an open deal. Company-domain guesses are not used. Declined attendees, resources, private/incomplete events, internal-only events, all-day events, and non-meeting event types are excluded.
- If the contact belongs to several deals, a single existing event-to-deal link can resolve it. Otherwise the event is skipped as ambiguous. A meeting linked to a conflicting deal is left for review.
- Google event source IDs/links identify native HubSpot meetings. Older Calendly/manual records require exact start/end/title plus an associated attendee contact. Multiple indistinguishable matches are skipped. Existing owners and explicit completed/no-show outcomes are preserved.
- Cross-calendar copies are deduplicated by iCalUID and recurring original occurrence time, with the organizer copy preferred. Rescheduling keeps that identity. A hidden unique property prevents duplicate creation after lost responses; a durable mapping is saved before associations so partial work retries safely.
- Confirmed Google cancellation (or404/410 on the specific event after its calendar was successfully read) marks the corresponding HubSpot meeting canceled. A reschedule updates its existing start/end time. Missing-window events are fetched directly rather than presumed canceled. Only deal associations added by this sync are removed when an event no longer contains an external customer; preexisting links remain under human control. Closing a deal preserves its historical meeting association.

The job logs aggregate counts, unavailable calendar IDs, and sanitized error codes. No attendee emails, event descriptions, tokens, or Slack messages are emitted. Turning the flag off stops future updates; existing CRM activities/associations remain. Search results over10,000 or incomplete contact reads fail safely rather than applying a partial deal index.

## Read-only validation

Implementation preview: 70 open deals, 13 readable individual calendars, 425 eligible deduplicated events, 27 clear event matches across26 deals. All27 could reuse existing HubSpot meeting records; 12 were missing the deal link. One conflicting existing association was skipped. These counts are a preview, not evidence that production associations were changed.

References: [HubSpot deal properties](https://knowledge.hubspot.com/properties/hubspots-default-deal-properties), [Meetings API](https://developers.hubspot.com/docs/api-reference/legacy/crm/activities/meetings/guide), [Google events list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).
