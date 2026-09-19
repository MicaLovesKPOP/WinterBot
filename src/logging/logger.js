const fs = require('fs');
const path = require('path');
const { getConfig } = require('../config');
const { registerError, buildDailySummaryAndReset } = require('./errorRegistry');

let discordClient = null;
let initialized = false;
let logChannelId = null;
let errorSummaryIntervalMs = 24 * 60 * 60 * 1000;
let errorRegistryMaxSize = 500;
let summaryTimer = null;

const LOG_DIR = path.join(process.cwd(), 'logs');
const HUMAN_LOG_FILE = path.join(LOG_DIR, 'error.log');
const STRUCTURED_LOG_FILE = path.join(LOG_DIR, 'events.jsonl');
const MAX_SIZE = 1 * 1024 * 1024;
const MAX_BACKUPS = 5;
const DEFAULT_CHUNK_SIZE = 1900;

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function initializeLogger() {
  if (initialized) return;
  ensureLogDir();

  try {
    const config = getConfig();
    logChannelId = config.logChannelId;
    errorSummaryIntervalMs = config.errorSummaryIntervalMs;
    errorRegistryMaxSize = config.errorRegistryMaxSize;
  } catch (_) {}

  initialized = true;
}

function setLoggingClient(client) {
  discordClient = client;
}

function getTimestamp(date = new Date()) {
  const year = date.getFullYear().toString().slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day} ${hours}:${minutes}:${seconds}`;
}

function normalizeErrorSignature(source, error) {
  const raw = error && error.stack ? error.stack : String(error ?? 'Unknown error');
  const firstLine = String(raw).split('\n')[0].trim();
  return `${source} | ${firstLine}`;
}

function toErrorDetails(error) {
  if (!error) return { message: 'Unknown error', stack: '' };
  if (error instanceof Error) {
    return { message: error.message || error.name || 'Error', stack: error.stack || String(error) };
  }
  return { message: String(error), stack: String(error) };
}

function rotateLogsIfNeeded(filePath) {
  if (!fs.existsSync(filePath)) return;
  const stats = fs.statSync(filePath);
  if (stats.size < MAX_SIZE) return;

  const oldest = `${filePath}.${MAX_BACKUPS}`;
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

  for (let index = MAX_BACKUPS - 1; index >= 1; index -= 1) {
    const from = `${filePath}.${index}`;
    const to = `${filePath}.${index + 1}`;
    if (fs.existsSync(from)) fs.renameSync(from, to);
  }

  fs.renameSync(filePath, `${filePath}.1`);
}

function appendFileSafely(filePath, content) {
  ensureLogDir();

  try {
    rotateLogsIfNeeded(filePath);
    fs.appendFileSync(filePath, content, 'utf8');
    return true;
  } catch (error) {
    try {
      console.error(`[${getTimestamp()}] File log write failed: ${error && error.stack ? error.stack : error}`);
    } catch (_) {}
    return false;
  }
}

function writeStructuredEntry(entry) {
  appendFileSafely(STRUCTURED_LOG_FILE, `${JSON.stringify(entry)}\n`);
}

function writeHumanEntry(entry) {
  appendFileSafely(
    HUMAN_LOG_FILE,
    `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}\n`
  );
}

function createLogEntry(level, source, message, metadata = {}) {
  return {
    timestamp: getTimestamp(),
    isoTimestamp: new Date().toISOString(),
    level,
    source,
    message,
    metadata,
  };
}

function recordEntry(entry) {
  initializeLogger();

  try {
    const printable = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}`;
    if (entry.level === 'error' || entry.level === 'fatal') console.error(printable);
    else console.log(printable);
  } catch (_) {}

  writeStructuredEntry(entry);

  if (entry.level === 'error' || entry.level === 'fatal' || entry.level === 'warn') {
    writeHumanEntry(entry);
  }

  return entry;
}

function splitMessageIntoChunks(message, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (message.length <= chunkSize) return [message];

  const lines = message.split('\n');
  const chunks = [];
  let current = '';

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= chunkSize) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    if (line.length <= chunkSize) {
      current = line;
      continue;
    }

    let remaining = line;
    while (remaining.length > chunkSize) {
      chunks.push(remaining.slice(0, chunkSize));
      remaining = remaining.slice(chunkSize);
    }
    current = remaining;
  }

  if (current) chunks.push(current);
  return chunks;
}

function getDiscordLogChannel() {
  try {
    if (!discordClient || !discordClient.isReady?.()) return null;
    return discordClient.channels.cache.get(logChannelId) || null;
  } catch (_) {
    return null;
  }
}

async function sendToDiscord(message) {
  const channel = getDiscordLogChannel();
  if (!channel) return false;

  const chunks = splitMessageIntoChunks(message);
  for (let index = 0; index < chunks.length; index += 1) {
    const prefix = chunks.length > 1 ? `[${index + 1}/${chunks.length}]\n` : '';
    try {
      await channel.send(`${prefix}${chunks[index]}`);
    } catch (_) {
      return false;
    }
  }

  return true;
}

function logDebug(message, metadata = {}) {
  return recordEntry(createLogEntry('debug', metadata.source || 'app', message, metadata));
}

function logInfo(message, metadata = {}) {
  return recordEntry(createLogEntry('info', metadata.source || 'app', message, metadata));
}

function logWarn(message, metadata = {}) {
  return recordEntry(createLogEntry('warn', metadata.source || 'app', message, metadata));
}

async function logError(source, error, metadata = {}) {
  const details = toErrorDetails(error);
  const signature = normalizeErrorSignature(source, error);

  const entry = recordEntry(createLogEntry('error', source, details.message, {
    ...metadata,
    signature,
    stack: details.stack,
  }));

  const registration = registerError({
    source,
    message: details.message,
    metadata,
    timestamp: Date.now(),
    maxSize: errorRegistryMaxSize,
  });

  if (registration.isFirstOccurrence) {
    await sendToDiscord(`⚠️ ${source}: ${details.message}`);
  }

  return entry;
}

function scheduleDailySummary() {
  if (summaryTimer) return;
  summaryTimer = setInterval(async () => {
    const summary = buildDailySummaryAndReset();
    if (summary) {
      await sendToDiscord(summary);
    }
  }, errorSummaryIntervalMs);
  summaryTimer.unref?.();
}

function getLogPaths() {
  return {
    humanLogFile: HUMAN_LOG_FILE,
    structuredLogFile: STRUCTURED_LOG_FILE,
  };
}

module.exports = {
  initializeLogger,
  setLoggingClient,
  logDebug,
  logInfo,
  logWarn,
  logError,
  sendToDiscord,
  scheduleDailySummary,
  getTimestamp,
  splitMessageIntoChunks,
  getLogPaths,
  normalizeErrorSignature,
};