// Centralized logging utilities and Discord error reporting
// Implements timestamping, log rotation, file writes, and Discord logging with cooldown/summarization.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('../config/index.js');

let diskFull = false;
let lastErrorSent = 0;
let cooldownTimer = null;
let pendingDiscordErrors = [];
let discordClient = null;
let logChannelId = null;
let errorCooldownMs = 60 * 1000; // default fallback
let logPath = path.join(process.cwd(), 'logs', 'error.log');

const MAX_SIZE = 1 * 1024 * 1024; // 1 MB
const MAX_BACKUPS = 5;
const DEFAULT_DISCORD_CHUNK_SIZE = 1900;

function initializeLogger() {
  const config = getConfig();
  logChannelId = config.logChannelId;
  errorCooldownMs = Number(config.logCooldownMs) || errorCooldownMs;

  const logDir = path.dirname(logPath);
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  } catch (_) {
    // Ignore directory creation failures; console logging remains.
  }
}

function setLoggingClient(client) {
  discordClient = client;
}

function getTimestamp() {
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');
  return `${year}${month}${day} ${hours}:${minutes}:${seconds}`;
}

function rotateLogs() {
  try {
    if (!fs.existsSync(logPath)) return;
    const stats = fs.statSync(logPath);
    if (stats.size < MAX_SIZE) return;

    const oldest = `${logPath}.${MAX_BACKUPS}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      const src = `${logPath}.${i}`;
      const dest = `${logPath}.${i + 1}`;
      if (fs.existsSync(src)) fs.renameSync(src, dest);
    }

    fs.renameSync(logPath, `${logPath}.1`);
  } catch (err) {
    try {
      console.error(`[${getTimestamp()}] rotateLogs failed: ${err && err.message ? err.message : err}`);
    } catch (_) {
      // Swallow logging failures.
    }
  }
}

function safeWriteError(message) {
  try { console.error(message); } catch (_) {}

  if (diskFull) return;

  try {
    rotateLogs();
    fs.appendFileSync(logPath, message + '\n', 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOSPC') {
      diskFull = true;
      try { console.error(`[${getTimestamp()}] Disk full detected; disabling file logging.`); } catch (_) {}
    } else {
      try {
        console.error(`[${getTimestamp()}] safeWriteError failed: ${err && err.stack ? err.stack : err}`);
      } catch (_) {}
    }
  }
}

function splitMessageIntoChunks(message, chunkSize = DEFAULT_DISCORD_CHUNK_SIZE) {
  const chunks = [];
  let remaining = message;

  while (remaining.length > chunkSize) {
    const chunk = remaining.substring(0, chunkSize);
    chunks.push(chunk);
    remaining = remaining.substring(chunkSize);
  }

  chunks.push(remaining);
  return chunks;
}

function getDiscordLogChannel() {
  try {
    if (!discordClient || !discordClient.isReady?.()) return null;
    const channel = discordClient.channels.cache.get(logChannelId);
    return channel || null;
  } catch (_) {
    return null;
  }
}

async function sendToDiscord(message) {
  const channel = getDiscordLogChannel();
  if (!channel) return;

  const chunks = splitMessageIntoChunks(message);
  for (const chunk of chunks) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await channel.send(chunk);
    } catch (_) {
      // Ignore Discord send errors.
    }
  }
}

async function flushQueuedErrors() {
  const queued = pendingDiscordErrors;
  pendingDiscordErrors = [];
  cooldownTimer = null;

  if (!queued.length) return;

  const summaryHeader = `⚠️ ${queued.length} error(s) occurred during the logging cooldown.`;
  const firstError = queued[0];
  const lastError = queued[queued.length - 1];
  const summaryBody = queued.length === 1
    ? `Last error: ${firstError}`
    : `First error: ${firstError}\nLast error: ${lastError}`;
  await sendToDiscord(`${summaryHeader}\n${summaryBody}`);

  lastErrorSent = Date.now();
}

async function logError(prefix, err) {
  const ts = getTimestamp();
  const details = err && err.stack ? err.stack : err;
  const message = `[${ts}] ${prefix}: ${details}`;

  safeWriteError(message);

  const now = Date.now();
  const elapsed = now - lastErrorSent;

  if (elapsed >= errorCooldownMs) {
    if (pendingDiscordErrors.length) {
      await flushQueuedErrors();
    }
    await sendToDiscord(message);
    lastErrorSent = Date.now();
    return;
  }

  pendingDiscordErrors.push(message);

  if (!cooldownTimer) {
    const remaining = Math.max(errorCooldownMs - elapsed, 0);
    cooldownTimer = setTimeout(() => {
      flushQueuedErrors();
    }, remaining);
  }
}

function logInfo(message) {
  try {
    console.log(`[${getTimestamp()}] ${message}`);
  } catch (_) {
    // Ignore logging failures.
  }
}

module.exports = {
  initializeLogger,
  setLoggingClient,
  logError,
  logInfo,
  safeWriteError,
  splitMessageIntoChunks,
  getTimestamp,
};
