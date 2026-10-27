const { appliesToSubmission, routingEnabled, SUBMISSION_PROPERTY } = require('./demo-routing');

// Return null only when the legacy new-lead booking path is safe to run.
async function routeBooking({ eventName, payload, scheduledEvent, filter, options, api }) {
  const { demoRouter: router, demoBookingStore: store } = options;
  if (!router || !store) return null;
  const inviteeUri = api.getInviteeUri(payload);
  const eventUri = api.getScheduledEventUri(payload);
  if (!inviteeUri) throw new Error('missing_invitee_uri');
  let link = await store.get(inviteeUri);
  const oldInviteeUri = api.getOldInviteeUri(payload);
  const oldLink = oldInviteeUri ? await store.get(oldInviteeUri) : null;
  const prior = link || oldLink;
  if (prior && !prior.reused_existing_deal) return null;
  if (!prior && !routingEnabled(router.env)) return null;
  const gateContact = !prior ? await api.findContactByEmail(payload.email) : null;
  const submissionTime = gateContact?.properties?.[SUBMISSION_PROPERTY] || payload.created_at || options.eventCreatedAt;
  if (!prior && routingEnabled(router.env) && !submissionTime) throw new Error('missing_booking_timestamp');
  // Persisted links stay protected even if the feature is subsequently disabled.
  if (!prior?.reused_existing_deal && !appliesToSubmission(submissionTime, router.env)) return null;

  // Provider identifiers take precedence over account matching. A prior legacy
  // booking may have created its deal before persisting its local linkage.
  // Reclassifying that deal on retry would change its cancellation semantics.
  if (!prior) {
    const identifiedDeal = (oldInviteeUri && await api.findDealByCalendlyIdentifiers({ inviteeUri: oldInviteeUri, eventUri: '' }))
      || await api.findDealByCalendlyIdentifiers({ inviteeUri, eventUri });
    if (identifiedDeal) return null;
  }

  if (eventName === 'invitee.canceled') {
    if (!link?.reused_existing_deal) {
      // A cancel can precede creation. Never run the legacy close-lost mutation
      // against an unidentified existing opportunity.
      const route = await router.resolve({ email: payload.email });
      if (route.status === 'unresolved') throw new Error('booking_routing_unresolved');
      if (route.status === 'no_open_deal') return null;
      const contact = await api.findContactByEmail(payload.email);
      if (!contact) throw new Error('booking_contact_not_available');
      link = await store.put({ inviteeUri, eventUri, contactId: String(contact.id), dealId: route.dealId, reusedExistingDeal: true });
    }
    await store.markCanceled(inviteeUri);
    if (link.meeting_id) await api.request(`/crm/v3/objects/meetings/${link.meeting_id}`, {
      method: 'PATCH', body: { properties: { hs_meeting_outcome: api.isRescheduled(payload) ? 'RESCHEDULED' : 'CANCELED' } },
    });
    return { action: 'existing_deal_booking_canceled', dealId: link.deal_id, meetingId: link.meeting_id };
  }
  if (eventName !== 'invitee.created') return null;
  if (link?.canceled) return { action: 'ignored_canceled_booking', dealId: link.deal_id };
  if (prior && !prior.reused_existing_deal) return null;

  let route = await router.resolve({ email: payload.email, ...(prior ? { dealId: prior.deal_id } : {}) });
  if (route.status === 'unresolved') throw new Error('booking_routing_unresolved');
  if (route.status === 'no_open_deal') {
    if (prior) throw new Error('linked_booking_deal_unavailable');
    return null;
  }
  const contact = await api.ensureContact({ payload, ownerId: route.ownerId });
  // Claim the identity before creating the meeting. Retries must never fall through
  // to legacy deal creation after a partial write or a later deal-stage change.
  link = await store.put({ inviteeUri, eventUri, contactId: String(contact.id), dealId: route.dealId, reusedExistingDeal: true });
  route = await router.alignContact({ email: payload.email, contactId: String(contact.id), dealId: link.deal_id });
  if (route.status !== 'existing_deal' || route.dealId !== link.deal_id) throw new Error('booking_owner_reconciliation_failed');

  // A new invitee gets its own meeting, including reschedules. Do not overwrite
  // another booking's event identifiers on the shared opportunity or meeting.
  let meeting = link.meeting_id ? { id: link.meeting_id } : await api.findMeetingByCalendlyIdentifiers({ inviteeUri, eventUri: '' });
  if (!meeting) meeting = await api.createMeeting({ payload, scheduledEvent,
    contactId: contact.id, companyId: route.companyId, dealId: route.dealId,
    ownerId: filter.ownerId, hostUserUri: filter.hostUserUri, eventTypeUri: filter.eventTypeUri });
  await store.put({ inviteeUri, eventUri, contactId: String(contact.id), dealId: route.dealId,
    meetingId: String(meeting.id), reusedExistingDeal: true });
  await api.associate('meetings', meeting.id, 'contacts', contact.id);
  await api.associate('meetings', meeting.id, 'deals', route.dealId);
  if (route.companyId) await api.associate('meetings', meeting.id, 'companies', route.companyId);
  if (oldLink?.meeting_id) {
    await api.request(`/crm/v3/objects/meetings/${oldLink.meeting_id}`, { method: 'PATCH', body: { properties: { hs_meeting_outcome: 'RESCHEDULED' } } });
  }

  // Check the owner again immediately before the external notification.
  route = await router.alignContact({ email: payload.email, contactId: String(contact.id), dealId: link.deal_id });
  if (route.status !== 'existing_deal') throw new Error('booking_owner_reconciliation_failed');
  if (!api.isRescheduled(payload) && !route.slackUserId) throw new Error('booking_owner_notification_mapping_missing');
  if (!api.isRescheduled(payload) && await store.claimNotification(inviteeUri)) {
    // Ambiguous sends remain 'sending' for review, never automatically reposted.
    try {
      await api.postBookedDemoSlackAlert({ ...options, payload, scheduledEvent,
        contactId: contact.id, companyName: '', ownerId: route.ownerId, ownerName: route.ownerName,
        meetingHostName: api.getOrganizerName(filter.hostUserUri, scheduledEvent), dealId: route.dealId,
        alertAttempts: 1,
        ownerSlackUserByHubSpotOwnerId: route.slackUserId ? { [route.ownerId]: route.slackUserId } : {},
      });
      await store.finishNotification(inviteeUri);
    } catch (error) {
      await store.quarantineNotification(inviteeUri);
      (options.logger || console).error('demo_booking_notification_needs_review', { dealId: route.dealId, contactId: String(contact.id) });
      throw error;
    }
  }
  return { action: 'existing_deal_booking', contactId: String(contact.id), companyId: route.companyId,
    dealId: route.dealId, meetingId: String(meeting.id) };
}

module.exports = { routeBooking };
