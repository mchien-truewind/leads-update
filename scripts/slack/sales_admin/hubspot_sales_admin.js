function escapeHubSpotHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlLines(lines) {
  return lines
    .flatMap(line => String(line || '').split(/\r?\n/))
    .map(line => escapeHubSpotHtml(line))
    .join('<br>');
}

function compact(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function uniqueValues(values = []) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function hubspotRecordUrl(portalId, objectTypeId, recordId) {
  if (!recordId) return '';
  return `https://app.hubspot.com/contacts/${portalId}/record/${objectTypeId}/${recordId}`;
}

const OBJECT_TYPE_IDS = {
  contacts: '0-1',
  companies: '0-2',
  deals: '0-3',
  meetings: '0-47',
  notes: '0-46',
  tasks: '0-27',
};

const MEETING_PROPERTIES = [
  'hs_meeting_title',
  'hs_meeting_body',
  'hs_meeting_start_time',
  'hs_meeting_end_time',
  'hs_meeting_outcome',
  'hs_meeting_source',
  'hs_meeting_source_id',
  'hs_meeting_external_url',
  'hs_object_source',
  'hs_object_source_id',
  'hs_object_source_label',
  'hs_object_source_detail_1',
  'hs_object_source_detail_2',
  'hs_object_source_detail_3',
  'hs_lastmodifieddate',
  'hubspot_owner_id',
];

class HubSpotSalesAdminClient {
  constructor({ hubspotRequest, portalId = '43974586', logger = console } = {}) {
    if (!hubspotRequest) throw new Error('hubspotRequest is required');
    this.hubspotRequest = hubspotRequest;
    this.portalId = portalId;
    this.logger = logger;
  }

  async searchMeetings(filters, { limit = 100, sorts = [] } = {}) {
    const meetings = [];
    let after = '';
    do {
      const body = {
        filterGroups: [{ filters }],
        properties: MEETING_PROPERTIES,
        limit: Math.min(limit, 100),
      };
      if (sorts.length) body.sorts = sorts;
      if (after) body.after = after;
      const res = await this.hubspotRequest('/crm/v3/objects/meetings/search', 'POST', body);
      meetings.push(...(res.results || []));
      after = res.paging?.next?.after || '';
    } while (after && meetings.length < limit);
    return meetings;
  }

  async searchMeetingsForOwnerBetween(ownerId, startDate, endDate) {
    return this.searchMeetings([
      { propertyName: 'hubspot_owner_id', operator: 'EQ', value: String(ownerId) },
      { propertyName: 'hs_meeting_start_time', operator: 'GTE', value: startDate.toISOString() },
      { propertyName: 'hs_meeting_start_time', operator: 'LT', value: endDate.toISOString() },
    ], {
      limit: 200,
      sorts: [{ propertyName: 'hs_meeting_start_time', direction: 'ASCENDING' }],
    });
  }

  async searchRecentlyUpdatedMeetingsForOwner(ownerId, updatedSince, startAfter) {
    const filters = [
      { propertyName: 'hubspot_owner_id', operator: 'EQ', value: String(ownerId) },
      { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: updatedSince.toISOString() },
    ];
    if (startAfter) {
      filters.push({ propertyName: 'hs_meeting_start_time', operator: 'GTE', value: startAfter.toISOString() });
    }
    return this.searchMeetings(filters, {
      limit: 200,
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
    });
  }

  async getAssociations(fromType, fromId, toType) {
    if (!fromId) return [];
    const res = await this.hubspotRequest(`/crm/v4/objects/${fromType}/${encodeURIComponent(fromId)}/associations/${toType}`);
    return (res.results || []).map(item => item.toObjectId).filter(Boolean);
  }

  async getObject(objectType, objectId, properties) {
    const props = encodeURIComponent(properties.join(','));
    return this.hubspotRequest(`/crm/v3/objects/${objectType}/${encodeURIComponent(objectId)}?properties=${props}`);
  }

  async getDealPipelineStages(pipelineId = '105321581') {
    const pipeline = await this.hubspotRequest(`/crm/v3/pipelines/deals/${encodeURIComponent(pipelineId)}`);
    return (pipeline.stages || [])
      .map(stage => ({
        id: String(stage.id || '').trim(),
        label: String(stage.label || stage.id || '').trim(),
        displayOrder: Number(stage.displayOrder || 0),
        metadata: stage.metadata || {},
      }))
      .filter(stage => stage.id)
      .sort((a, b) => a.displayOrder - b.displayOrder);
  }

  async updateDealStage(dealId, stageId) {
    return this.hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, 'PATCH', {
      properties: { dealstage: String(stageId) },
    });
  }

  async updateDealProperty(dealId, propertyName, value) {
    if (!dealId || !propertyName) return null;
    return this.hubspotRequest(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, 'PATCH', {
      properties: { [propertyName]: String(value || '') },
    });
  }

  async updateMeetingOutcome(meetingId, outcome) {
    if (!meetingId || !outcome) return null;
    return this.hubspotRequest(`/crm/v3/objects/meetings/${encodeURIComponent(meetingId)}`, 'PATCH', {
      properties: { hs_meeting_outcome: String(outcome) },
    });
  }

  async fallbackDealIdsForMeeting(contactIds = [], companyIds = []) {
    const dealIds = [];
    for (const companyId of companyIds.slice(0, 3)) {
      const ids = await this.getAssociations('companies', companyId, 'deals').catch(err => {
        this.logger.warn(`Sales admin company deal associations failed for company ${companyId}: ${err.message}`);
        return [];
      });
      dealIds.push(...ids);
    }
    for (const contactId of contactIds.slice(0, 5)) {
      const ids = await this.getAssociations('contacts', contactId, 'deals').catch(err => {
        this.logger.warn(`Sales admin contact deal associations failed for contact ${contactId}: ${err.message}`);
        return [];
      });
      dealIds.push(...ids);
    }
    return uniqueValues(dealIds);
  }

  async attachAssociations(meeting) {
    const enriched = {
      ...meeting,
      _contacts: [],
      _companies: [],
      _deals: [],
      _contactIds: [],
      _companyIds: [],
      _dealIds: [],
    };
    const id = meeting.id;
    const [contactIds, companyIds, dealIds] = await Promise.all([
      this.getAssociations('meetings', id, 'contacts').catch(err => {
        this.logger.warn(`Sales admin contact associations failed for meeting ${id}: ${err.message}`);
        return [];
      }),
      this.getAssociations('meetings', id, 'companies').catch(err => {
        this.logger.warn(`Sales admin company associations failed for meeting ${id}: ${err.message}`);
        return [];
      }),
      this.getAssociations('meetings', id, 'deals').catch(err => {
        this.logger.warn(`Sales admin deal associations failed for meeting ${id}: ${err.message}`);
        return [];
      }),
    ]);
    enriched._contactIds = contactIds;
    enriched._companyIds = companyIds;
    const directDealIds = uniqueValues(dealIds);
    enriched._dealIds = directDealIds;

    enriched._contacts = await Promise.all(contactIds.slice(0, 5).map(async contactId => {
      const contact = await this.getObject('contacts', contactId, ['firstname', 'lastname', 'email', 'company', 'jobtitle']);
      return { id: contact.id, ...(contact.properties || {}) };
    })).catch(() => []);

    enriched._companies = await Promise.all(companyIds.slice(0, 3).map(async companyId => {
      const company = await this.getObject('companies', companyId, ['name', 'domain']);
      return { id: company.id, ...(company.properties || {}) };
    })).catch(() => []);

    if (enriched._dealIds.length === 0) {
      enriched._dealIds = await this.fallbackDealIdsForMeeting(contactIds, companyIds);
    }

    enriched._deals = await Promise.all(enriched._dealIds.slice(0, 3).map(async dealId => {
      const deal = await this.getObject('deals', dealId, ['dealname', 'dealstage', 'pipeline', 'amount', 'closedate']);
      return { id: deal.id, ...(deal.properties || {}), _associationSource: directDealIds.includes(dealId) ? 'meeting' : 'fallback' };
    })).catch(() => []);

    return enriched;
  }

  async getPriorMeetingsForRecord(objectType, objectId, beforeIso, limit = 10) {
    const meetingIds = await this.getAssociations(objectType, objectId, 'meetings').catch(() => []);
    const meetings = [];
    for (const meetingId of meetingIds.slice(0, 100)) {
      try {
        const meeting = await this.getObject('meetings', meetingId, MEETING_PROPERTIES);
        const start = meeting.properties?.hs_meeting_start_time;
        if (start && start < beforeIso) meetings.push(meeting);
      } catch (err) {
        this.logger.warn(`Sales admin prior meeting fetch failed for ${meetingId}: ${err.message}`);
      }
    }
    return meetings
      .sort((a, b) => new Date(b.properties?.hs_meeting_start_time || 0) - new Date(a.properties?.hs_meeting_start_time || 0))
      .slice(0, limit);
  }

  async findPriorMeeting(meeting) {
    const beforeIso = meeting.properties?.hs_meeting_start_time;
    if (!beforeIso) return null;
    if (meeting._dealIds?.[0]) {
      const deals = await this.getPriorMeetingsForRecord('deals', meeting._dealIds[0], beforeIso, 1);
      if (deals[0]) return deals[0];
    }
    if (meeting._contactIds?.[0]) {
      const contacts = await this.getPriorMeetingsForRecord('contacts', meeting._contactIds[0], beforeIso, 1);
      if (contacts[0]) return contacts[0];
    }
    return null;
  }

  async createDefaultAssociation(fromType, fromId, toType, toId) {
    if (!fromId || !toId) return null;
    return this.hubspotRequest(`/crm/v4/objects/${fromType}/${encodeURIComponent(fromId)}/associations/default/${toType}/${encodeURIComponent(toId)}`, 'PUT');
  }

  async createNote({ body, meeting, contacts = [], companies = [], deals = [] }) {
    const note = await this.hubspotRequest('/crm/v3/objects/notes', 'POST', {
      properties: {
        hs_timestamp: new Date().toISOString(),
        hs_note_body: htmlLines([body]),
      },
    });
    const noteId = note.id;
    // Notes can only be associated to contacts/companies/deals. HubSpot has NO
    // notes<->meetings association type, so associating to the meeting 400s
    // ("Invalid Association Creation Requests") and previously failed the whole write.
    // Associate to the meeting's contacts/companies/deals instead, and isolate each
    // association so one failure can't drop the note.
    const targets = [
      ...contacts.slice(0, 5).map(contact => ['contacts', contact.id || contact]),
      ...companies.slice(0, 3).map(company => ['companies', company.id || company]),
      ...deals.slice(0, 3).map(deal => ['deals', deal.id || deal]),
    ];
    await Promise.all(targets.map(([toType, toId]) => this.createDefaultAssociation('notes', noteId, toType, toId)
      .catch(err => this.logger.warn(`Sales admin note association ${toType}/${toId} failed: ${err.message}`))));
    return note;
  }

  async hasMeetingNoteContaining(meetingId, marker) {
    if (!meetingId || !marker) return false;
    const noteIds = await this.getAssociations('meetings', meetingId, 'notes');
    for (const noteId of noteIds.slice(0, 100)) {
      try {
        const note = await this.getObject('notes', noteId, ['hs_note_body']);
        if (String(note.properties?.hs_note_body || '').includes(marker)) return true;
      } catch (err) {
        this.logger.warn(`Sales admin note marker fetch failed for note ${noteId}: ${err.message}`);
      }
    }
    return false;
  }

  async createPostPromptMarker({ marker, meeting, ae, slackChannel, slackTs, promptKey, grainUrl = '', grainSource = '' }) {
    return this.createNote({
      meeting,
      body: [
        'Sales Admin post-meeting prompt sent',
        `Marker: ${marker}`,
        `Prompt key: ${promptKey}`,
        `AE notified: ${ae?.name || ''} <${ae?.email || ''}>`,
        `Slack channel: ${slackChannel || ''}`,
        `Slack timestamp: ${slackTs || ''}`,
        `Grain source: ${grainSource || ''}`,
        grainUrl ? `Grain recording: ${grainUrl}` : '',
      ].filter(Boolean).join('\n'),
    });
  }

  async createTask({ subject, body, dueDate, ownerId, meeting, contacts = [], companies = [], deals = [] }) {
    const parsedDueDate = dueDate ? new Date(dueDate) : null;
    const timestamp = parsedDueDate && Number.isFinite(parsedDueDate.getTime())
      ? parsedDueDate.toISOString()
      : new Date().toISOString();
    const task = await this.hubspotRequest('/crm/v3/objects/tasks', 'POST', {
      properties: compact({
        hs_task_subject: subject,
        hs_task_body: body,
        hs_task_status: 'NOT_STARTED',
        hs_task_priority: 'MEDIUM',
        hs_timestamp: timestamp,
        hubspot_owner_id: ownerId,
      }),
    });
    const taskId = task.id;
    const associations = [];
    if (meeting?.id) associations.push(this.createDefaultAssociation('tasks', taskId, 'meetings', meeting.id));
    for (const contact of contacts.slice(0, 3)) associations.push(this.createDefaultAssociation('tasks', taskId, 'contacts', contact.id || contact));
    for (const company of companies.slice(0, 2)) associations.push(this.createDefaultAssociation('tasks', taskId, 'companies', company.id || company));
    for (const deal of deals.slice(0, 2)) associations.push(this.createDefaultAssociation('tasks', taskId, 'deals', deal.id || deal));
    await Promise.all(associations.filter(Boolean));
    return task;
  }

  recordUrl(objectType, recordId) {
    return hubspotRecordUrl(this.portalId, OBJECT_TYPE_IDS[objectType] || objectType, recordId);
  }
}

module.exports = {
  HubSpotSalesAdminClient,
  MEETING_PROPERTIES,
  escapeHubSpotHtml,
  htmlLines,
  hubspotRecordUrl,
};
