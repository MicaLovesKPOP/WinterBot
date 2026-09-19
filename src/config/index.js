const path = require('path');
const dotenv = require('dotenv');
const {
  loadMessageRequirements,
  parseSnowflakeList,
  resolveMessageRequirementsPath,
} = require('./messageRequirements');

const USER_DISPLAY_MODES = {
  DISPLAY_NAME: 0,
  USERNAME: 1,
  BOTH: 2,
};

const SNOWFLAKE_PATTERN = /^\d{15,22}$/;

let loadedConfig = null;

function parseInteger(value, fallback, { min = null, max = null } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid integer configuration value: "${value}".`);
  }
  if (min !== null && parsed < min) {
    throw new Error(`Configuration value ${parsed} must be at least ${min}.`);
  }
  if (max !== null && parsed > max) {
    throw new Error(`Configuration value ${parsed} must be at most ${max}.`);
  }
  return parsed;
}

function validateSnowflake(value, variableName) {
  const normalized = String(value ?? '').trim();
  if (!SNOWFLAKE_PATTERN.test(normalized)) {
    throw new Error(`${variableName} must be a valid Discord snowflake ID.`);
  }
  return normalized;
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

  const userDisplayMode = parseInteger(
    process.env.USER_NAME_DISPLAY_MODE,
    USER_DISPLAY_MODES.BOTH,
    { min: 0, max: 2 }
  );

  const legacyMediaOnlyChannelIds = parseSnowflakeList(
    process.env.MEDIA_ONLY_CHANNEL_IDS,
    'MEDIA_ONLY_CHANNEL_IDS'
  );
  const explicitRequirementsFile = String(
    process.env.MESSAGE_REQUIREMENTS_FILE || ''
  ).trim();
  const messageRequirementsFile = resolveMessageRequirementsPath(
    process.cwd(),
    explicitRequirementsFile
  );
  const messageRequirements = loadMessageRequirements({
    filePath: messageRequirementsFile,
    explicitFilePath: Boolean(explicitRequirementsFile),
    jsonValue: process.env.MESSAGE_REQUIREMENTS_JSON,
    legacyMediaOnlyChannelIds,
  });

  loadedConfig = {
    botToken: String(requiredVars.botToken).trim(),
    guildId: validateSnowflake(requiredVars.guildId, 'GUILD_ID'),
    channelId: validateSnowflake(requiredVars.channelId, 'CHANNEL_ID'),
    logChannelId: validateSnowflake(requiredVars.logChannelId, 'LOG_CHANNEL_ID'),
    eventPollIntervalMs: parseInteger(
      process.env.EVENT_POLL_INTERVAL_MS,
      30_000,
      { min: 5_000 }
    ),
    activeEventPollIntervalMs: parseInteger(
      process.env.ACTIVE_EVENT_POLL_INTERVAL_MS,
      5_000,
      { min: 1_000 }
    ),
    uptimeSaveIntervalMs: parseInteger(
      process.env.UPTIME_SAVE_INTERVAL_MS,
      60_000,
      { min: 10_000 }
    ),
    weeklyReportIntervalMs: parseInteger(
      process.env.WEEKLY_REPORT_INTERVAL_MS,
      7 * 24 * 60 * 60 * 1000,
      { min: 60_000 }
    ),
    errorSummaryIntervalMs: parseInteger(
      process.env.ERROR_SUMMARY_INTERVAL_MS,
      24 * 60 * 60 * 1000,
      { min: 60_000 }
    ),
    unsubscribeGraceCycles: parseInteger(
      process.env.UNSUBSCRIBE_GRACE_CYCLES,
      6,
      { min: 1, max: 100 }
    ),
    missingEventGraceCycles: parseInteger(
      process.env.MISSING_EVENT_GRACE_CYCLES,
      3,
      { min: 1, max: 20 }
    ),
    maxApiRetries: parseInteger(
      process.env.MAX_API_RETRIES,
      4,
      { min: 0, max: 20 }
    ),
    retryBaseDelayMs: parseInteger(
      process.env.RETRY_BASE_DELAY_MS,
      1_000,
      { min: 100, max: 60_000 }
    ),
    apiRequestTimeoutMs: parseInteger(
      process.env.API_REQUEST_TIMEOUT_MS,
      15_000,
      { min: 1_000, max: 120_000 }
    ),
    errorRegistryMaxSize: parseInteger(
      process.env.ERROR_REGISTRY_MAX_SIZE,
      500,
      { min: 10, max: 5000 }
    ),
    messageRequirements,
    messageRequirementsFile,
    messageRequirementsEmbedGraceMs: parseInteger(
      process.env.MESSAGE_REQUIREMENTS_EMBED_GRACE_MS ??
        process.env.MEDIA_ONLY_EMBED_GRACE_MS,
      4_000,
      { min: 0, max: 15_000 }
    ),
    userDisplayMode,
    userDisplayModes: USER_DISPLAY_MODES,
    debugLoggingEnabled:
      String(process.env.DEBUG_LOGGING || '').trim() === '1',
  };

  return loadedConfig;
}

function getConfig() {
  if (!loadedConfig) {
    throw new Error(
      'Configuration has not been loaded. Call loadConfig() first.'
    );
  }
  return loadedConfig;
}

module.exports = {
  loadConfig,
  getConfig,
  USER_DISPLAY_MODES,
  validateSnowflake,
  parseInteger,
};
