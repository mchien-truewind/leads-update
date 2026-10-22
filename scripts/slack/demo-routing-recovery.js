const { activationTime, routingEnabled } = require('./demo-routing');
const { processEvent } = require('./hubspot_demo');

async function recoverDemoNotifications(options) {
  if (!routingEnabled(options.env)) return;
  const rows = await options.store.retryableEvents(activationTime(options.env));
  for (const row of rows) {
    try { await processEvent(row.event, options); }
    catch { options.logger.error('demo_routing_recovery_pending', { eventKey: row.event_key }); }
  }
}

function startDemoRoutingRecovery(options) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await recoverDemoNotifications(options); }
    catch { options.logger.error('demo_routing_recovery_failed'); }
    finally { running = false; }
  }, 30000);
  timer.unref();
  return timer;
}

module.exports = { recoverDemoNotifications, startDemoRoutingRecovery };
