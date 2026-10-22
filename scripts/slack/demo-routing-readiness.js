// All checks are read-only. This is also run at service startup before enabling mutations.
async function verifyOwnerRegistry({ registry, hubspotRequest, calendlyRequest, slackClient }) {
  const me = await calendlyRequest('https://api.calendly.com/users/me');
  const organization = me.resource?.current_organization;
  if (!organization) throw new Error('calendar_organization_unverified');
  for (const [ownerId, row] of registry) {
    const owner = await hubspotRequest(`/crm/v3/owners/${ownerId}`);
    const email = String(owner.email || '').trim().toLowerCase();
    if (owner.archived !== false || !email) throw new Error('registry_owner_inactive');
    const activeEvents = new Map();
    for (const hostUri of row.hostUris) {
      const user = (await calendlyRequest(hostUri)).resource;
      if (user?.current_organization !== organization || String(user?.email || '').trim().toLowerCase() !== email) throw new Error('registry_calendar_identity_mismatch');
      let url = `https://api.calendly.com/event_types?user=${encodeURIComponent(hostUri)}&active=true&count=100`;
      const visited = new Set();
      while (url) {
        if (visited.has(url) || !url.startsWith('https://api.calendly.com/')) throw new Error('invalid_calendar_pagination');
        visited.add(url);
        const page = await calendlyRequest(url);
        if (!Array.isArray(page.collection)) throw new Error('calendar_events_unavailable');
        for (const event of page.collection) if (event.active === true) activeEvents.set(event.uri, event);
        url = page.pagination?.next_page || '';
      }
    }
    if (row.eventTypeUris.some(uri => !activeEvents.has(uri))
      || !row.eventTypeUris.some(uri => activeEvents.get(uri)?.pooling_type == null
        && activeEvents.get(uri)?.scheduling_url?.replace(/\/$/, '') === row.calendlyUrl.replace(/\/$/, ''))) throw new Error('registry_personal_calendar_unverified');
    const slack = await slackClient.users.info({ user: row.slackUserId });
    if (slack.ok !== true || slack.user?.deleted !== false || String(slack.user?.profile?.email || '').trim().toLowerCase() !== email) throw new Error('registry_slack_identity_mismatch');
  }
}

module.exports = { verifyOwnerRegistry };
