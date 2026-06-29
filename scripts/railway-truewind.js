#!/usr/bin/env node

const { spawnSync } = require('child_process');

const EXPECTED_EMAIL = 'mercedes@trytruewind.com';
const EXPECTED_WORKSPACE = 'Truewind';
const PROJECTS = [
  {
    id: '7b1c11b7-197d-4fbc-b7fd-e1693a5c45aa',
    name: 'Truewind recruiting worker',
    services: [
      { id: 'fc4f1f54-5561-4dbb-8e34-4702080d8098', name: 'recruiting-sync-worker' },
    ],
  },
  {
    id: '67b145f8-d6d9-4402-aa0d-310f005122be',
    name: 'Truewind Slack bot',
    services: [
      { id: '295937c7-9787-4918-b0ee-a10ecb444bc4', name: 'gmail-triage-worker' },
      { id: '8208df57-5e7e-43d2-b839-44d3a7652427', name: 'gtm-ops' },
      { id: '600dc5b7-e5f2-4399-8eac-4b596c84f56e', name: 'leads-update' },
      { id: 'de1aa05e-b712-4d71-ac50-93b94af210e1', name: 'leads-update-bot' },
    ],
  },
];

const BLOCKED_COMMANDS = [
  ['link'],
  ['unlink'],
  ['logout'],
  ['down'],
  ['delete'],
  ['remove'],
  ['rm'],
  ['project', 'link'],
  ['project', 'delete'],
  ['project', 'remove'],
  ['project', 'rm'],
  ['service', 'link'],
  ['service', 'delete'],
  ['service', 'remove'],
  ['service', 'rm'],
  ['environment', 'link'],
  ['environment', 'delete'],
  ['environment', 'remove'],
  ['environment', 'rm'],
];

const args = process.argv.slice(2);

function fail(message) {
  console.error(`Railway Truewind guard refused to run: ${message}`);
  process.exit(1);
}

function allServices() {
  return PROJECTS.flatMap((project) => project.services.map((service) => ({ ...service, project })));
}

function projectLabel() {
  return PROJECTS.map((project) => `${project.name} (${project.id})`).join(', ');
}

function serviceLabel() {
  return allServices().map((service) => `${service.name} (${service.id})`).join(', ');
}

function valueAfterFlag(flagNames) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (flagNames.includes(arg)) return args[index + 1] || '';
    for (const flag of flagNames) {
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    }
  }
  return '';
}

function validateCommandShape() {
  const command = args.filter((arg) => !arg.startsWith('-')).slice(0, 2);
  for (const blocked of BLOCKED_COMMANDS) {
    if (blocked.every((part, index) => command[index] === part)) {
      fail(`\`${blocked.join(' ')}\` is blocked by the Truewind Railway guard.`);
    }
  }
}

function validateExplicitTargets() {
  const project = valueAfterFlag(['--project', '-p']);
  const service = valueAfterFlag(['--service', '-s']);

  if (project && !PROJECTS.some((item) => item.id === project || item.name === project)) {
    fail(`--project must be one of: ${projectLabel()}; got ${project}`);
  }
  if (service && !allServices().some((item) => item.id === service || item.name === service)) {
    fail(`--service must be one of: ${serviceLabel()}; got ${service}`);
  }
}

function validateRailwayAccount() {
  const result = spawnSync('railway', ['whoami', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    fail(`could not read Railway identity. ${result.stderr || result.stdout}`.trim());
  }

  let whoami;
  try {
    whoami = JSON.parse(result.stdout);
  } catch {
    fail('Railway whoami did not return JSON.');
  }

  const email = String(whoami.email || '').trim().toLowerCase();
  const workspaces = (whoami.workspaces || []).map((workspace) => String(workspace.name || '').trim());
  if (email !== EXPECTED_EMAIL || !workspaces.includes(EXPECTED_WORKSPACE)) {
    fail(
      `expected Railway login ${EXPECTED_EMAIL} with workspace ${EXPECTED_WORKSPACE}; `
      + `got ${email || 'unknown'} with workspaces ${workspaces.join(', ') || 'none'}. `
      + 'Run `railway login --browserless` and choose the Truewind / mercedes-claude account before retrying.'
    );
  }
}

if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage:
  npm run railway:truewind -- <railway args>

Expected Railway identity:
  Email:     ${EXPECTED_EMAIL}
  Workspace: ${EXPECTED_WORKSPACE}

Allowed Truewind projects:
  ${projectLabel()}

Allowed services:
  ${serviceLabel()}

Examples:
  npm run railway:truewind -- whoami --json
  npm run railway:truewind -- logs --project 67b145f8-d6d9-4402-aa0d-310f005122be --service 600dc5b7-e5f2-4399-8eac-4b596c84f56e --lines 200
  npm run railway:truewind -- variable list --project 67b145f8-d6d9-4402-aa0d-310f005122be --service leads-update --json
`);
  process.exit(0);
}

validateCommandShape();
validateExplicitTargets();
validateRailwayAccount();

const env = {
  ...process.env,
  RAILWAY_CALLER: process.env.RAILWAY_CALLER || 'truewind-local-guard',
  RAILWAY_AGENT_SESSION: process.env.RAILWAY_AGENT_SESSION || `truewind-local-${Date.now()}`,
};

const result = spawnSync('railway', args, {
  encoding: 'utf8',
  stdio: 'inherit',
  env,
});

process.exit(result.status ?? 1);
