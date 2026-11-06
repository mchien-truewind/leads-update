const LAST_MEETING_DATE = 'truewind_last_meeting_date';
const stamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

class LastMeetingDates {
  constructor({ sync }) {
    this.sync = sync;
    this.intervalMs = Math.max(60000, Number(sync.env.GOOGLE_CALENDAR_LAST_MEETING_HISTORY_INTERVAL_MS) || 900000);
  }

  async initialize() {
    const property = await this.sync.request(`/crm/v3/properties/deals/${LAST_MEETING_DATE}`);
    if (property.name !== LAST_MEETING_DATE || property.type !== 'datetime' || property.modificationMetadata?.readOnlyValue !== false) {
      throw new Error('calendar_last_meeting_writable_property_required');
    }
  }

  async update(snapshot, fullHistory) {
    const latest = new Map(), ambiguous = new Map();
    const stats = { updated: 0, cleared: 0, ambiguous: 0, unavailable: 0, stale: 0, failed: 0 };
    for (const event of snapshot.events.values()) {
      const start = stamp(event.start?.dateTime), end = stamp(event.end?.dateTime);
      // The date is the start of the last finished event, never a future or
      // currently running meeting. Calendar alone does not prove attendance.
      if (start === null || end === null || start >= snapshot.now || end > snapshot.now) continue;
      const plan = await this.sync.plan(snapshot, event);
      if (plan.reason) {
        for (const id of plan.candidates || []) ambiguous.set(id, Math.max(ambiguous.get(id) || -Infinity, start));
        continue;
      }
      const copyStart = stamp(plan.copy.start?.dateTime), copyEnd = stamp(plan.copy.end?.dateTime);
      if (copyStart === null || copyEnd === null || copyStart >= snapshot.now || copyEnd > snapshot.now) continue;
      if (['NO_SHOW', 'CANCELED', 'RESCHEDULED'].includes(plan.meeting?.properties?.hs_meeting_outcome)) continue;
      if (!latest.has(plan.dealId) || copyStart > latest.get(plan.dealId)) latest.set(plan.dealId, copyStart);
    }
    for (const deal of snapshot.deals) {
      const id = String(deal.id), owner = snapshot.dealOwners.get(id);
      if (!owner || !snapshot.readable.has(owner.calendarId)) { stats.unavailable++; continue; }
      const candidate = latest.get(id), current = stamp(deal.properties?.[LAST_MEETING_DATE]);
      if (ambiguous.has(id) && ambiguous.get(id) >= (candidate ?? -Infinity)) { stats.ambiguous++; continue; }
      // Recent scans only advance the date. A complete historical scan may move
      // it backward or clear it after cancellations, deletions or reassignment.
      if (!fullHistory && (candidate == null || (current !== null && current >= candidate))) continue;
      if ((candidate == null && current === null) || candidate === current) continue;
      const value = candidate == null ? '' : new Date(candidate).toISOString();
      try {
        const fresh = await this.sync.request(`/crm/v3/objects/deals/${id}?properties=hubspot_owner_id,hs_is_closed,${LAST_MEETING_DATE}`);
        if (fresh.archived || ['true', true].includes(fresh.properties?.hs_is_closed) || String(fresh.properties?.hubspot_owner_id || '') !== owner.ownerId
          || stamp(fresh.properties?.[LAST_MEETING_DATE]) !== current) { stats.stale++; continue; }
        await this.sync.request(`/crm/v3/objects/deals/${id}`, { method: 'PATCH', body: { properties: { [LAST_MEETING_DATE]: value } } });
        if (value) stats.updated++; else stats.cleared++;
      } catch (error) {
        stats.failed++;
        this.sync.logger.error('Last meeting date update failed', { code: error.statusCode || error.code || error.name });
      }
    }
    return stats;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    let client, locked = false;
    try {
      client = await this.sync.pool.connect();
      locked = (await client.query("SELECT pg_try_advisory_lock(hashtextextended('google-calendar-last-meeting',0)) AS acquired")).rows[0].acquired;
      if (!locked) return;
      const snapshot = await this.sync.snapshot({ history: true });
      const stats = await this.update(snapshot, true);
      this.sync.logger.info('Google Calendar last meeting history', { calendars: snapshot.readable.size, deals: snapshot.deals.length, ...stats });
      return stats;
    } finally {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('google-calendar-last-meeting',0))").catch(() => { client.release(true); client = null; });
      client?.release();
      this.running = false;
    }
  }

  start() {
    if (this.timer) return;
    const run = () => this.tick().catch(error => this.sync.logger.error('Last meeting history sync failed', { code: error.statusCode || error.code || error.name }));
    run();
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}

module.exports = { LastMeetingDates, LAST_MEETING_DATE };
