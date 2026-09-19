const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { getConfig } = require('../config');
const { logError } = require('../logging/logger');
const { saveUptime } = require('../persistence/uptimeStore');
const { saveEvents } = require('../persistence/eventsStore');

let discordClient = null;
let handlersRegistered = false;

function registerProcessHandlers() {
  if (handlersRegistered) return;

  process.on('unhandledRejection', async (reason) => {
    await saveUptime(discordClient).catch(() => {});
    await saveEvents().catch(() => {});
    await logError('process.unhandledRejection', reason);
  });

  process.on('uncaughtException', async (error) => {
    await saveUptime(discordClient).catch(() => {});
    await saveEvents().catch(() => {});
    await logError('process.uncaughtException', error);
  });

  handlersRegistered = true;
}

async function createDiscordClient() {
  if (discordClient) return discordClient;

  const config = getConfig();
  const intents = [GatewayIntentBits.Guilds];
  const partials = [];

  if (Object.keys(config.messageRequirements).length > 0) {
    intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
    partials.push(Partials.Message);
  }

  discordClient = new Client({ intents, partials });
  registerProcessHandlers();

  try {
    await discordClient.login(config.botToken);
  } catch (error) {
    await logError('discordClient.login', error);
    throw error;
  }

  return discordClient;
}

function getDiscordClient() {
  return discordClient;
}

module.exports = { createDiscordClient, getDiscordClient };