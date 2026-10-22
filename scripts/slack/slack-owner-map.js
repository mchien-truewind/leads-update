const DEFAULT_SLACK_TO_HUBSPOT_OWNER = {
  U0ATZSNCE5T: { id: '91143842', name: 'Jenilee Chen' },
  U0AURH4KMRN: { id: '91143844', name: 'Brendan Moody' },
  U0AKMHVCJMA: { id: '89305622', name: 'Xavier Marco' },
  U09QC3B292R: { id: '84547076', name: 'Sarah Elix' },
  U04BPMPR29G: { id: '559564379', name: 'Alex Lee' },
  U0B4MRN83FE: { id: '92555980', name: 'Amy Vetter' },
  U0BAMU9DYR4: { id: '93961770', name: 'Andrew Moyer' },
  U0BARRLR6Q1: { id: '93961773', name: 'Ari Nachman' },
  U0ABULY5TEK: { id: '91143842', name: 'Jenilee Chen' },
};

function getOwnerSlackMap(env = process.env) {
  const raw = env.SLACK_TO_HUBSPOT_OWNER_JSON || env.SLACK_USER_TO_HUBSPOT_OWNER_JSON || '';
  const overrides = raw.trim() ? JSON.parse(raw) : {};
  const owners = {};
  for (const [userId, owner] of Object.entries({ ...DEFAULT_SLACK_TO_HUBSPOT_OWNER, ...overrides })) {
    const ownerId = owner?.id ? String(owner.id) : '';
    if (ownerId && userId && !owners[ownerId]) owners[ownerId] = userId;
  }
  return owners;
}

module.exports = { DEFAULT_SLACK_TO_HUBSPOT_OWNER, getOwnerSlackMap };
