// Configuration loader and validator
// Responsible for loading environment variables, validating required values, and
// exposing a typed configuration object for the rest of the bot. Additional
// configuration flags will be added as other modules are migrated.

const path = require('path');
const dotenv = require('dotenv');

let loadedConfig = null;

function loadConfig() {
  if (loadedConfig) return loadedConfig;

  // Load environment variables from a .env file in the project root.
  dotenv.config({ path: path.join(process.cwd(), '.env') });

  const requiredVars = {
    botToken: process.env.BOT_TOKEN,
    guildId: process.env.GUILD_ID,
    channelId: process.env.CHANNEL_ID,
    logChannelId: process.env.LOG_CHANNEL_ID,
  };

  const missing = Object.entries(requiredVars)
    .filter(([, value]) => !value || String(value).trim() === '')
    .map(([key]) => key);

  if (missing.length) {
    throw new Error(
      `Missing required configuration values: ${missing.join(', ')}. ` +
        'Please set them in your environment or .env file.'
    );
  }

  const parsedLogCooldown = Number(process.env.LOG_COOLDOWN_MS || '60000');
  const logCooldownMs = Number.isFinite(parsedLogCooldown) ? parsedLogCooldown : 60000;

  loadedConfig = {
    botToken: String(requiredVars.botToken),
    guildId: String(requiredVars.guildId),
    channelId: String(requiredVars.channelId),
    logChannelId: String(requiredVars.logChannelId),
    logCooldownMs,
  };

  return loadedConfig;
}

function getConfig() {
  if (!loadedConfig) {
    throw new Error('Configuration has not been loaded. Call loadConfig() first.');
  }
  return loadedConfig;
}

module.exports = { loadConfig, getConfig };
