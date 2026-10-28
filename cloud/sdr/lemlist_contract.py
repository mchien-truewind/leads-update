"""Supervised one-task proof adapted from the installed test-flow adapter.

The user authorized an empirical completion of one pinned task. A missing step
ID remains unknown until its manualDone activity proves the expected linkage;
known contradictory IDs always stop dispatch. This is not a production gate.
No launch/resume/skip.
"""
import datetime
import re
import time
from urllib.parse import urlencode

CALL_TASK_TITLE = 'M0 Call in Nooks'
FIELDS = {'hubspot_contact_id', 'campaign_id', 'sequence_id', 'call_step_id',
          'continuation_step_id', 'task_id', 'lead_id', 'contact_id',
          'assigned_rep_id', 'workspace_id', 'starts_at', 'expires_at'}

def validate_scope(scope):
    if not isinstance(scope, dict) or set(scope) != FIELDS:
        raise ValueError('exact test flow scope required')
    for field, prefix in (('campaign_id', 'cam_'), ('sequence_id', 'seq_'),
            ('call_step_id', 'stp_'), ('continuation_step_id', 'stp_'),
            ('task_id', 'opp_'), ('lead_id', 'lea_'), ('contact_id', 'ctc_'),
            ('assigned_rep_id', 'usr_')):
        if not isinstance(scope[field], str) or not re.fullmatch(prefix+r'[A-Za-z0-9]{1,80}', scope[field]):
            raise ValueError('invalid test identity')
    if (not isinstance(scope['hubspot_contact_id'], str)
            or not re.fullmatch(r'[1-9][0-9]{0,24}', scope['hubspot_contact_id'])
            or not isinstance(scope['workspace_id'], str)
            or not re.fullmatch(r'[A-Za-z0-9]{1,100}', scope['workspace_id'])
            or scope['call_step_id'] == scope['continuation_step_id']):
        raise ValueError('invalid test scope')
    if (any(type(scope[k]) is not int for k in ('starts_at', 'expires_at'))
            or not 0 < scope['starts_at'] < scope['expires_at'] <= scope['starts_at'] + 172800):
        raise ValueError('test window must be at most 48 hours')

def active(scope, now=None):
    now = time.time() if now is None else now
    if not scope['starts_at'] <= now < scope['expires_at']:
        raise ValueError('test window closed')

def activities(scope, fetch):
    """Bounded, complete activity read; never expose contact text or notes."""
    found, seen = [], set()
    for offset in range(0, 500, 100):
        rows = fetch('/api/activities?' + urlencode({'campaignId': scope['campaign_id'],
            'leadId': scope['lead_id'], 'type': 'manualDone', 'minDate': scope['starts_at'],
            'limit': 100, 'offset': offset}))
        if not isinstance(rows, list) or len(rows) > 100:
            raise ValueError('incomplete activity page')
        for row in rows:
            if (not isinstance(row, dict) or not isinstance(row.get('_id'), str)
                    or not re.fullmatch(r'act_[A-Za-z0-9]{1,80}', row['_id'])
                    or row['_id'] in seen or row.get('campaignId') != scope['campaign_id']
                    or row.get('leadId') != scope['lead_id'] or row.get('type') != 'manualDone'
                    or row.get('contactId', scope['contact_id']) != scope['contact_id']):
                raise ValueError('activity correlation mismatch')
            seen.add(row['_id'])
            if row.get('opportunityId') != scope['task_id']:
                continue
            stamp = datetime.datetime.fromisoformat(row['createdAt'].replace('Z', '+00:00'))
            if stamp.tzinfo is None or stamp.timestamp() < scope['starts_at']:
                raise ValueError('activity predates test')
            # Missing historic fields are incomplete evidence, never inferred.
            for field, prefix in (('stepId', 'stp_'), ('sequenceId', 'seq_')):
                if row.get(field) is not None and (not isinstance(row[field], str)
                        or not re.fullmatch(prefix+r'[A-Za-z0-9]{1,80}', row[field])):
                    raise ValueError('invalid activity step evidence')
            found.append({'activity_id': row['_id'], 'task_id': scope['task_id'],
                'step_id': row.get('stepId'), 'sequence_id': row.get('sequenceId'),
                'created_at': stamp.timestamp()})
        if len(rows) < 100:
            if len(found) > 1:
                raise ValueError('ambiguous completion activities')
            return found
    raise ValueError('activity page limit')

def check_sequence(scope, sequences):
    if not isinstance(sequences, dict) or set(sequences) != {scope['sequence_id']}:
        raise ValueError('test campaign sequence changed')
    sequence = sequences[scope['sequence_id']]
    if not isinstance(sequence, dict) or sequence.get('_id') != scope['sequence_id'] or sequence.get('level') != 0:
        raise ValueError('test root sequence changed')
    steps = sequence.get('steps')
    if (not isinstance(steps, list) or len(steps) != 2 or any(not isinstance(step, dict)
            or type(step.get('index')) is not int or step['index'] < 0 for step in steps)):
        raise ValueError('exactly two manual steps required')
    ordered = sorted(steps, key=lambda step: step['index'])
    if (ordered[0]['index'] == ordered[1]['index']
            or [step.get('_id') for step in ordered] != [scope['call_step_id'], scope['continuation_step_id']]
            or any(step.get('type') != 'manual' or step.get('sequenceId') != scope['sequence_id'] for step in ordered)
            or ordered[0].get('title') != 'M0 Call in Nooks'):
        raise ValueError('test manual-step contract changed')

def task_correlation(task, expected_campaign_id):
    """Normalize provider IDs only; never infer a step from a title or position.

    Search Tasks v2 nests sequenceId under campaign. Older responses may also
    carry a top-level sequenceId; conflicting or foreign evidence must fail.
    """
    nested = task.get('campaign')
    if nested is not None and (not isinstance(nested, dict)
            or nested.get('id') != expected_campaign_id):
        raise ValueError('task campaign correlation mismatch')
    sequences = [task.get('sequenceId'), nested.get('sequenceId') if nested else None]
    metadata = {}
    for target, prefix, values in (
            ('provider_step_id', 'stp_', [task.get('stepId')]),
            ('provider_sequence_id', 'seq_', sequences)):
        present = [value for value in values if value is not None]
        if any(not isinstance(value, str) or not re.fullmatch(prefix+r'[A-Za-z0-9]{1,80}', value)
               for value in present) or len(set(present)) > 1:
            raise ValueError('invalid task correlation field')
        metadata[target] = present[0] if present else None
    # v2 uses assignedTo; older task responses use userId. Never prefer one
    # conflicting non-null owner over another.
    owners = [task.get('assignedTo'), task.get('userId')]
    present = [value for value in owners if value is not None]
    if any(not isinstance(value, str) or not re.fullmatch(r'usr_[A-Za-z0-9]{1,80}', value)
           for value in present) or len(set(present)) > 1:
        raise ValueError('invalid task representative')
    metadata['assigned_rep_id'] = present[0] if present else None
    return metadata

def get_task(campaign, task_id, fetch):
    page=fetch('/api/v2/tasks?'+urlencode({'campaignId':campaign['campaign_id'],'taskId':task_id,'limit':2,'page':1}))
    if not isinstance(page,dict) or page.get('total')!=1 or not isinstance(page.get('results'),list) or len(page['results'])!=1:
        raise ValueError('task not uniquely found')
    task=page['results'][0]
    if not isinstance(task,dict) or task.get('_id')!=task_id or task.get('campaignId')!=campaign['campaign_id'] or task.get('title')!=CALL_TASK_TITLE or task.get('type')!='manual':
        raise ValueError('task gate mismatch')
    lead_id=task.get('leadId')
    if not isinstance(lead_id,str) or not re.fullmatch(r'lea_[A-Za-z0-9]{1,80}',lead_id):
        raise ValueError('missing lead correlation')
    status=task.get('status')
    if status not in ('due','upcoming','paused','done','ignored'):
        raise ValueError('unknown task status')
    return dict(task_correlation(task,campaign['campaign_id']), task_id=task_id,
                campaign_id=campaign['campaign_id'],lead_id=lead_id,done=status=='done',status=status)


def observe(scope, fetch):
    validate_scope(scope)
    contacts = fetch('/api/contacts?' + urlencode({'crmIds':scope['hubspot_contact_id']}))
    if not isinstance(contacts,list) or len(contacts) != 1 or not isinstance(contacts[0],dict):
        raise ValueError('CRM contact not uniquely found')
    contact = contacts[0]
    sync = contact.get('crmSync')
    if (contact.get('_id') != scope['contact_id'] or contact.get('unsubscribed') is not False
            or not isinstance(sync,dict) or sync.get('provider') != 'hubspot'
            or sync.get('crmRecordId') != scope['hubspot_contact_id'] or sync.get('syncDisabled') is not False):
        raise ValueError('selected contact changed or suppressed')
    memberships = contact.get('campaigns')
    if not isinstance(memberships,list) or any(not isinstance(x,dict) for x in memberships):
        raise ValueError('invalid campaign memberships')
    matches = [x for x in memberships if x.get('campaignId') == scope['campaign_id']]
    if (len(matches) != 1 or matches[0].get('leadId') != scope['lead_id']
            or matches[0].get('campaignState') != 'running'):
        raise ValueError('selected lead is not in the running approved campaign')
    # Membership leadState describes a stage (e.g. scanned/contacted), not a
    # reliable pause flag. Never relabel an unknown stage as "running". Read
    # the pinned lead's authoritative isPaused flag independently instead.
    if matches[0].get('leadState') in ('paused','unsubscribed','interested','notInterested',
                                     'done','stopped','ended','archived'):
        raise ValueError('selected lead has a blocking stage')
    lead=fetch('/api/leads?'+urlencode({'id':scope['lead_id']}))
    if (not isinstance(lead,dict) or lead.get('_id')!=scope['lead_id']
            or lead.get('campaignId')!=scope['campaign_id'] or lead.get('contactId')!=scope['contact_id']
            or lead.get('isPaused') is not False):
        raise ValueError('selected lead identity or pause status is not verified')
    sequences = fetch('/api/campaigns/' + scope['campaign_id'] + '/sequences')
    check_sequence(scope,sequences)
    ordered = sorted(sequences[scope['sequence_id']]['steps'],key=lambda x:x['index'])
    if ordered[1].get('title') != 'M0 Continuation confirmed':
        raise ValueError('continuation contract changed')
    task = get_task({'campaign_id':scope['campaign_id']},scope['task_id'],fetch)
    if (task['lead_id'] != scope['lead_id'] or task['assigned_rep_id'] != scope['assigned_rep_id']
            or task['provider_sequence_id'] != scope['sequence_id']
            or task['provider_step_id'] not in (None,scope['call_step_id'])):
        raise ValueError('pinned task changed')
    page = fetch('/api/v2/tasks?' + urlencode({'campaignId':scope['campaign_id'],
        'leadId':scope['lead_id'],'type':'manual','limit':100,'page':1}))
    if (not isinstance(page,dict) or type(page.get('total')) is not int
            or not 0 <= page['total'] <= 100 or not isinstance(page.get('results'),list)
            or len(page['results']) != page['total']):
        raise ValueError('incomplete task page')
    found, candidates, seen = [], [], set()
    for row in page['results']:
        if (not isinstance(row,dict) or not isinstance(row.get('_id'),str)
                or not re.fullmatch(r'opp_[A-Za-z0-9]{1,80}',row['_id']) or row['_id'] in seen
                or row.get('campaignId') != scope['campaign_id'] or row.get('leadId') != scope['lead_id']
                or row.get('contactId') != scope['contact_id'] or row.get('type') != 'manual'):
            raise ValueError('task identity mismatch')
        seen.add(row['_id'])
        metadata = task_correlation(row,scope['campaign_id'])
        if row['_id'] == scope['task_id']:
            found.append(row)
            if row.get('status') != task['status'] or metadata != {k:task[k] for k in metadata}:
                raise ValueError('task readback changed')
        elif row.get('title') == 'M0 Continuation confirmed':
            if (metadata['provider_sequence_id'] != scope['sequence_id']
                    or metadata['assigned_rep_id'] != scope['assigned_rep_id']
                    or metadata['provider_step_id'] not in (None,scope['continuation_step_id'])
                    or row.get('status') not in ('due','upcoming')):
                raise ValueError('continuation is not pending in the approved sequence')
            candidates.append(dict(metadata,task_id=row['_id'],status=row['status']))
    if len(found) != 1 or len(candidates) > 1:
        raise ValueError('ambiguous task evidence')
    return {'scope':scope,'task':task,'completion_activities':activities(scope,fetch),
            'continuation_tasks':candidates}


def ready_before(evidence, scope):
    return (evidence.get('scope') == scope and evidence.get('task',{}).get('task_id') == scope['task_id']
            and evidence['task'].get('provider_step_id') in (None,scope['call_step_id'])
            and evidence['task'].get('provider_sequence_id') == scope['sequence_id']
            and evidence['task'].get('done') is False and evidence['task'].get('status') == 'due'
            and evidence.get('completion_activities') == [] and evidence.get('continuation_tasks') == [])


def complete(scope, fetch, write, *, clock=time.time):
    active(scope,clock())
    before = observe(scope,fetch)
    if before['task']['done']:
        return dict(before,write_attempted=False)
    if not ready_before(before,scope):
        raise ValueError('test is no longer at its initial call task')
    active(scope,clock())
    write('PATCH','/api/tasks',{'id':scope['task_id'],'done':True})
    return dict(observe(scope,fetch),write_attempted=True)
