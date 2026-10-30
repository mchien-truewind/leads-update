const { appliesToSubmission, SUBMISSION_PROPERTY, activationTime } = require('./demo-routing');

async function protectContact(contact, router, { dryRun = false, isContactManaged = async () => false } = {}) {
  if (await isContactManaged(String(contact.id))) return true;
  if (!router || !appliesToSubmission(contact.properties?.[SUBMISSION_PROPERTY], router.env)) return false;
  const input = { email: contact.properties.email, contactId: String(contact.id) };
  try {
    const route = dryRun ? await router.resolve(input) : await router.alignContact(input);
    if (route.status === 'no_open_deal') return false;
    if (route.status === 'unresolved') console.error('assignment_routing_unresolved', { contactId: String(contact.id) });
    return true;
  } catch {
    // Block distribution for this contact while letting unrelated contacts proceed.
    console.error('assignment_routing_reconciliation_pending', { contactId: String(contact.id) });
    return true;
  }
}

async function protectDeal(dealId, router, crm) {
  if (!router) return false;
  const contactIds = await router.associations('deals', dealId, 'contacts');
  const contacts = await crm.batchRead('contacts', contactIds, ['email', SUBMISSION_PROPERTY]);
  for (const contactId of contactIds) {
    const properties = contacts.get(String(contactId));
    if (!properties) throw new Error('assignment_contact_read_incomplete');
    if (!appliesToSubmission(properties[SUBMISSION_PROPERTY], router.env)) continue;
    const route = await router.resolve({ email: properties.email, contactId: String(contactId) });
    if (route.status === 'unresolved') {
      console.error('assignment_routing_unresolved', { contactId: String(contactId), dealId: String(dealId) });
      return true;
    }
    if (route.status === 'existing_deal' && route.dealId === String(dealId)) return true;
  }
  return false;
}

async function reconcileRoutedSubmissions(router, crm, { dryRun = false, isContactManaged = async () => false } = {}) {
  if (!router) return { checked: 0, protected: 0 };
  const contacts = await crm.searchAll('contacts', {
    filterGroups: [{ filters: [{ propertyName: SUBMISSION_PROPERTY, operator: 'GTE', value: String(activationTime(router.env)) }] }],
    properties: ['email', 'hubspot_owner_id', SUBMISSION_PROPERTY], limit: 100,
  });
  let protectedCount = 0;
  for (const contact of contacts) if (await protectContact(contact, router, { dryRun, isContactManaged })) protectedCount++;
  return { checked: contacts.length, protected: protectedCount };
}

module.exports = { protectContact, protectDeal, reconcileRoutedSubmissions };
