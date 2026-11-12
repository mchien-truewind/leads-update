const escape = value => String(value || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const REASONS = {
  nooks_meeting_not_found: 'No matching upcoming calendar meeting was found.',
  nooks_meeting_ae_ambiguous: 'The calendar meeting does not identify one clear AE.',
  nooks_deal_owner_changed: 'The deal owner changed while the calendar check was waiting. That owner was preserved.',
};
function createNooksOwnerNotifier({ client, resolveChannelId }) {
  return async ({ job, code, messageId }) => {
    const channel = await resolveChannelId('gtm-general');
    if (!channel) throw new Error('nooks_alert_channel_unavailable');
    const preserved = code === 'nooks_deal_owner_changed';
    const result = await client.chat.postMessage({ channel, client_msg_id:messageId,
      unfurl_links:false, unfurl_media:false,
      text: `<@U0ABULY5TEK> A Nooks booked meeting needs attention.\n` +
        `Contact: ${escape(job.email)}\n` +
        `<https://app.hubspot.com/contacts/43974586/record/0-3/${encodeURIComponent(job.deal_id)}|View deal> · Nooks call: ${escape(job.call_id)}\n` +
        `${REASONS[code] || 'The calendar or HubSpot ownership check could not be verified.'}\n` +
        (preserved ? 'Automatic reassignment has stopped for this deal.' : 'The five-minute waiting period has elapsed. The deal keeps its current owner while the bot retries. Please check the booking and AE attendees.'),
    });
    if (!result?.ok || !result.ts) throw new Error('nooks_alert_delivery_unverified');
  };
}
module.exports = { createNooksOwnerNotifier };
