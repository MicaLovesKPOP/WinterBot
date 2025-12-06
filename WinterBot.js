// Entry point for WinterBot

const { loadConfig } = require('./src/config/index.js');
const { initializeLogger } = require('./src/logging/logger.js');
const { initializeEventsStore } = require('./src/persistence/eventsStore.js');
const { initializeUptimeStore } = require('./src/persistence/uptimeStore.js');
const { createDiscordClient } = require('./src/discord/client.js');
const { registerEventHandlers } = require('./src/discord/events.js');
const { initializeVersionTracker } = require('./src/versioning/versionTracker.js');

let client = null;

async function bootstrap() {
  loadConfig();

  const { version: botVersion } = initializeVersionTracker();
  try {
    console.log(`Running WinterBot v${botVersion}`);
  } catch (_) {}

  initializeLogger();
  initializeEventsStore();
  initializeUptimeStore();

  client = createDiscordClient();
  registerEventHandlers(client, botVersion);
}

bootstrap();
