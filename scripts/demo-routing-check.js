#!/usr/bin/env node
// Read-only rollout/shadow check. Inject credentials with the project's approved runtime.
const { createDemoRouter } = require('./slack/demo-routing');
const { verifyOwnerRegistry } = require('./slack/demo-routing-readiness');

async function main() {
  const hubspotToken = process.env.HUBSPOT_PRIVATE_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN;
  const calendlyToken = process.env.CALENDLY_API_KEY || process.env.CALENDLY_API;
  async function json(url, token, options = {}) {
    if (!token) throw new Error('missing_provider_credential');
    const response = await fetch(url, { method: options.method || 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`${new URL(url).hostname}_http_${response.status}`);
    return response.json();
  }
  const request = (path, options) => json(`https://api.hubapi.com${path}`, hubspotToken, options);
  if ((await request('/account-info/v3/details')).portalId !== 43974586) throw new Error('hubspot_portal_mismatch');
  const router = createDemoRouter({ request });
  const index = process.argv.indexOf('--email');
  if (index !== -1) {
    // resolve() only searches/reads, even when production routing is enabled.
    const result = await router.resolve({ email: process.argv[index + 1] });
    console.log(JSON.stringify(result));
    if (result.status === 'unresolved' || (result.status === 'existing_deal' && !result.calendlyUrl)) process.exitCode = 1;
    return;
  }
  // Enable validation in this process only; this CLI never starts a worker or writes CRM.
  const checks = createDemoRouter({ request, env: { ...process.env, DEMO_ROUTING_ENABLED: 'true' } });
  await checks.validateCoverage();
  await verifyOwnerRegistry({ registry: checks.registry, hubspotRequest: request,
    calendlyRequest: url => json(url, calendlyToken),
    slackClient: { users: { info: ({ user }) => json(`https://slack.com/api/users.info?user=${encodeURIComponent(user)}`, process.env.SLACK_BOT_TOKEN) } } });
  console.log('demo_routing_readiness_passed');
}

main().catch(() => { console.error('demo_routing_readiness_failed; inspect provider permissions and registry configuration'); process.exitCode = 1; });
