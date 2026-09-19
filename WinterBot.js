const { loadConfig } = require('./src/config');
const { initializeLogger, logInfo, logError } = require('./src/logging/logger');
const { initializeEventsStore, saveEvents } = require('./src/persistence/eventsStore');
const { initializeUptimeStore, saveUptime } = require('./src/persistence/uptimeStore');
const { createDiscordClient } = require('./src/discord/client');
const { registerEventHandlers } = require('./src/discord/events');

// ✅ RESTORE PROPER VERSION SYSTEM
const { initializeVersionTracker } = require('./src/versioning/versionTracker');

let client = null;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    logInfo(`Shutdown requested via ${signal}.`, { source: 'app.shutdown' });
  } catch (_) {}

  try {
    if (client) await saveUptime(client);
  } catch (error) {
    await logError('app.shutdown.saveUptime', error);
  }

  try {
    await saveEvents();
  } catch (error) {
    await logError('app.shutdown.saveEvents', error);
  }

  try {
    if (client) client.destroy();
  } catch (error) {
    await logError('app.shutdown.destroyClient', error);
  }

  process.exit(0);
}

async function bootstrap() {
  loadConfig();
  initializeLogger();
  initializeEventsStore();
  initializeUptimeStore();

  logInfo(`Booting WinterBot`, { source: 'app.bootstrap' });

  client = await createDiscordClient();

  // ✅ RESTORED: your original automated versioning system
  const { version: botVersion } = initializeVersionTracker();

  registerEventHandlers(client, botVersion);

  process.once('SIGINT', () => shutdown('SIGINT').catch(() => process.exit(1)));
  process.once('SIGTERM', () => shutdown('SIGTERM').catch(() => process.exit(1)));
}

bootstrap().catch(async (error) => {
  try {
    await logError('app.bootstrap', error);
  } finally {
    process.exit(1);
  }
});