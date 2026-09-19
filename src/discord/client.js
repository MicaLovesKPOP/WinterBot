const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { getConfig } = require('../config');
const { logError } = require('../logging/logger');

let discordClient = null;

function createDiscordClient() {
  if (discordClient) return discordClient;

  const config = getConfig();
  const intents = [GatewayIntentBits.Guilds];
  const partials = [];

  if (Object.keys(config.messageRequirements).length > 0) {
    intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
    partials.push(Partials.Message);
  }

  discordClient = new Client({
    intents,
    partials,
    allowedMentions: {
      parse: [],
      repliedUser: false,
    },
  });

  return discordClient;
}

async function loginDiscordClient(client = discordClient) {
  if (!client) {
    throw new Error('Discord client has not been created.');
  }

  try {
    await client.login(getConfig().botToken);
    return client;
  } catch (error) {
    await logError('discordClient.login', error);
    throw error;
  }
}

function getDiscordClient() {
  return discordClient;
}

module.exports = {
  createDiscordClient,
  loginDiscordClient,
  getDiscordClient,
};
