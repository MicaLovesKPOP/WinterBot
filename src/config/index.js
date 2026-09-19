const path = require('path');

let dotenv = { config: () => ({}) };
try {
  dotenv = require('dotenv');
} catch (_) {}

const USER_DISPLAY_MODES = {
  DISPLAY_NAME: 0,
  USERNAME: 1,
  BOTH: 2,
};

let loadedConfig = null;

function parseInteger(value, fallback, { min = null, max = null } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (min !== null && parsed < min) return fallback;
  if (max !== null && parsed > max) return fallback;
  return parsed;
}

function loadConfig() {
  if (loadedConfig) return loadedConfig;

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

  if (missing.length > 0) {
    throw new Error(
      `Missing required configuration values: ${missing.join(', ')}. Please set them in your environment or .env file.`
    );
  }

  const userDisplayMode = parseInteger(process.env.USER_NAME_DISPLAY_MODE, USER_DISPLAY_MODES.BOTH, {
    min: 0,
    max: 2,
  });

  loadedConfig = {
    botToken: String(requiredVars.botToken),
    guildId: String(requiredVars.guildId),
    channelId: String(requiredVars.channelId),
    logChannelId: String(requiredVars.logChannelId),
    logCooldownMs: parseInteger(process.env.LOG_COOLDOWN_MS, 60_000, { min: 1_000 }),
    eventPollIntervalMs: parseInteger(process.env.EVENT_POLL_INTERVAL_MS, 30_000, { min: 5_000 }),
    activeEventPollIntervalMs: parseInteger(process.env.ACTIVE_EVENT_POLL_INTERVAL_MS, 5_000, { min: 1_000 }),
    uptimeSaveIntervalMs: parseInteger(process.env.UPTIME_SAVE_INTERVAL_MS, 60_000, { min: 10_000 }),
    weeklyReportIntervalMs: parseInteger(process.env.WEEKLY_REPORT_INTERVAL_MS, 7 * 24 * 60 * 60 * 1000, {
      min: 60_000,
    }),
    errorSummaryIntervalMs: parseInteger(process.env.ERROR_SUMMARY_INTERVAL_MS, 24 * 60 * 60 * 1000, {
      min: 60_000,
    }),
    unsubscribeGraceCycles: parseInteger(process.env.UNSUBSCRIBE_GRACE_CYCLES, 6, { min: 1, max: 100 }),
    maxApiRetries: parseInteger(process.env.MAX_API_RETRIES, 4, { min: 0, max: 20 }),
    retryBaseDelayMs: parseInteger(process.env.RETRY_BASE_DELAY_MS, 1_000, { min: 100 }),
    errorRegistryMaxSize: parseInteger(process.env.ERROR_REGISTRY_MAX_SIZE, 500, { min: 10, max: 5000 }),
    userDisplayMode,
    userDisplayModes: USER_DISPLAY_MODES,
    debugLoggingEnabled: String(process.env.DEBUG_LOGGING || '').trim() === '1',
  };

  return loadedConfig;
}

function getConfig() {
  if (!loadedConfig) {
    throw new Error('Configuration has not been loaded. Call loadConfig() first.');
  }
  return loadedConfig;
}

module.exports = { loadConfig, getConfig, USER_DISPLAY_MODES };