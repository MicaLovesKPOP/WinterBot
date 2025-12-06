// Discord client creation and lifecycle hooks
// Responsible for instantiating the Discord client with the required intents,
// performing login using the configured bot token, and installing process-level
// error handlers that delegate to the centralized logger and uptime store.

const { Client, GatewayIntentBits } = require('discord.js');
const { getConfig } = require('../config/index.js');
const { logError } = require('../logging/logger.js');
const { saveUptime } = require('../persistence/uptimeStore.js');

let discordClient = null;
let handlersRegistered = false;

function registerProcessHandlers() {
  if (handlersRegistered) return;

  process.on('unhandledRejection', async (reason) => {
    await saveUptime(discordClient).catch(() => {});
    await logError('Unhandled promise rejection', reason);
  });

  process.on('uncaughtException', async (error) => {
    await saveUptime(discordClient).catch(() => {});
    await logError('Uncaught exception', error);
  });

  handlersRegistered = true;
}

function createDiscordClient() {
  if (discordClient) return discordClient;

  const config = getConfig();
  discordClient = new Client({ intents: GatewayIntentBits.Guilds });

  registerProcessHandlers();

  // Preserve original login flow; caller can await readiness elsewhere.
  try {
    discordClient.login(config.botToken).catch(async (err) => {
      await logError('Discord login failed', err);
    });
  } catch (err) {
    // Ensure failures are surfaced via centralized logging.
    logError('Discord login threw synchronously', err);
  }

  return discordClient;
}

function getDiscordClient() {
  return discordClient;
}

module.exports = { createDiscordClient, getDiscordClient };
