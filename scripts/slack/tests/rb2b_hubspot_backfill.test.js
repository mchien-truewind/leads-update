const assert = require('assert');
const { test } = require('node:test');

const {
  buildCompanyPlans,
  buildContactPlans,
  sha256,
  validateTimelineAudit,
  validatePreviewArtifact,
} = require('../../rb2b_hubspot_backfill');
const { initialVisitUniqueId } = require('../rb2b_hubspot');

function record(id, properties = {}) {
  return {
    id,
    properties: {
      createdate: '2026-07-27T19:05:06.000Z',
      rb2b_captured_at: '2026-07-27T00:00:00.000Z',
      rb2b_last_logged_activity: '2026-07-27T00:00:00.000Z',
      rb2b_source: 'true',
      hs_object_source_id: '4209312',
      hs_object_source_detail_1: 'RB2B for CRM',
      hubspot_owner_id: '',
      ...properties,
    },
  };
}

function timelineAudit(events = [
  {
    contactId: 'contact-1',
    eventId: 'eventIntegrations-1785171900000-1',
    timestamp: '2026-07-27T17:05:00.000Z',
  },
]) {
  return {
    schemaVersion: 1,
    integrationId: '4209312',
    generatedAt: '2026-07-27T22:57:00.000Z',
    windowStart: '2026-07-20T22:57:00.000Z',
    events,
  };
}

test('builds PII-free deterministic contact and company plans', () => {
  const contactPlans = buildContactPlans([record('contact-1')], new Map(), timelineAudit());
  const companyPlans = buildCompanyPlans([record('company-1')]);
  assert.deepStrictEqual(Object.keys(contactPlans[0]).sort(), [
    'contactId',
    'createdAt',
    'currentOwnerId',
    'notes',
    'ownerAction',
    'proposedOwnerId',
    'rb2bCapturedAt',
    'rb2bLatestActivity',
    'sourceValidated',
  ].sort());
  assert.strictEqual(contactPlans[0].notes[0].body, '07/27/2026 visited main website');
  assert.strictEqual(contactPlans[0].notes[0].action, 'create');
  assert.strictEqual(contactPlans[0].notes[0].uniqueId, initialVisitUniqueId('contact-1'));
  assert.strictEqual(contactPlans[0].proposedOwnerId, '94834941');
  assert.strictEqual(companyPlans[0].ownerAction, 'assign');
});

test('marks already-existing notes and owners as no-op actions', () => {
  const contact = record('contact-1', { hubspot_owner_id: '94834941' });
  const uniqueId = initialVisitUniqueId(contact.id);
  const plans = buildContactPlans(
    [contact],
    new Map([[uniqueId, { id: 'note-1' }]]),
    timelineAudit(),
  );
  assert.strictEqual(plans[0].ownerAction, 'skip_already_owned');
  assert.strictEqual(plans[0].notes[0].action, 'skip_existing');
  assert.strictEqual(plans[0].notes[0].existingNoteId, 'note-1');
});

test('keeps multiple RB2B timeline events as distinct notes', () => {
  const audit = timelineAudit([
    {
      contactId: 'contact-1',
      eventId: 'eventIntegrations-1785171900000-1',
      timestamp: '2026-07-27T17:05:00.000Z',
    },
    {
      contactId: 'contact-1',
      eventId: 'eventIntegrations-1785172500000-2',
      timestamp: '2026-07-27T17:15:00.000Z',
    },
  ]);
  const [plan] = buildContactPlans([record('contact-1')], new Map(), audit);
  assert.strictEqual(plan.notes.length, 2);
  assert.notStrictEqual(plan.notes[0].uniqueId, plan.notes[1].uniqueId);
  assert.strictEqual(plan.notes[0].body, plan.notes[1].body);
});

test('rejects broad or mismatched attribution', () => {
  assert.throws(
    () => buildContactPlans(
      [record('contact-1', { hs_object_source_detail_1: 'Other' })],
      new Map(),
      timelineAudit(),
    ),
    /failed exact RB2B source validation/,
  );
  assert.throws(
    () => buildCompanyPlans([record('company-1', { rb2b_source: 'false' })]),
    /failed exact RB2B source validation/,
  );
});

test('timeline audit requires exact scoped contact coverage and unique event IDs', () => {
  assert.doesNotThrow(() => validateTimelineAudit(timelineAudit(), [record('contact-1')], '4209312'));
  assert.throws(
    () => validateTimelineAudit(timelineAudit([]), [record('contact-1')], '4209312'),
    /missing 1 scoped contacts/,
  );
});

test('validates the artifact hash and required source parity', () => {
  const preview = {
    schemaVersion: 2,
    mode: 'preview',
    target: { integrationId: '4209312' },
    qa: {
      ownerIdentityValidated: true,
      exactSourceParity: { contacts: true, companies: true },
    },
    timelineAudit: timelineAudit(),
    contactPlans: [{ contactId: 'contact-1', sourceValidated: true }],
    companyPlans: [{ sourceValidated: true }],
  };
  preview.previewHash = sha256(preview);
  assert.doesNotThrow(() => validatePreviewArtifact(preview));
  const tampered = JSON.parse(JSON.stringify(preview));
  tampered.contactPlans.push({ sourceValidated: true });
  assert.throws(() => validatePreviewArtifact(tampered), /hash validation failed/);
});
