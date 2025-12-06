// Uptime tracking persistence
// Responsible for loading and saving uptime/downtime data with atomic writes,
// computing offline gaps, and formatting durations. Behavior mirrors the
// original WinterBot.js implementation while keeping Discord messaging
// responsibilities external to this module.

const fs = require('fs');
const path = require('path');
const { getTimestamp, logInfo, safeWriteError } = require('../logging/logger.js');

let previousUptimeMinutes = 0;
let totalUptimeMinutes = 0;
let totalDowntimeMinutes = 0;
let lastSavedUptime = 0;
let lastSavedAt = 0;
let diskFull = false;

const uptimeFile = path.join(process.cwd(), 'uptimeData.json');

function initializeUptimeStore() {
  previousUptimeMinutes = 0;
  totalUptimeMinutes = 0;
  totalDowntimeMinutes = 0;
  lastSavedUptime = 0;
  lastSavedAt = 0;
  diskFull = false;
}

function formatDuration(minutes) {
  if (minutes < 1) return `${Math.floor(minutes * 60)} seconds`;
  if (minutes < 60) return `${Math.floor(minutes)} minutes`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hours`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)} days`;
  if (minutes < 43200) return `${Math.floor(minutes / 10080)} weeks`;
  if (minutes < 525600) return `${Math.floor(minutes / 43200)} months`;
  return `${Math.floor(minutes / 525600)} years`;
}

function getSafeClientUptimeMinutes(client) {
  const uptimeMs = client && typeof client.uptime === 'number' ? client.uptime : 0;
  return Math.floor(uptimeMs / 60000);
}

async function saveUptime(client) {
  try {
    const currentUptimeMinutes = getSafeClientUptimeMinutes(client);
    const delta = currentUptimeMinutes - lastSavedUptime;

    if (delta > 0) {
      totalUptimeMinutes += delta;
      lastSavedUptime = currentUptimeMinutes;
    }

    lastSavedAt = Date.now();

    const data = {
      totalUptimeMinutes,
      previousUptimeMinutes: totalUptimeMinutes,
      totalDowntimeMinutes,
      lastSavedAt,
    };

    const tmpFile = `${uptimeFile}.tmp`;
    try {
      await fs.promises.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
      await fs.promises.rename(tmpFile, uptimeFile);
    } catch (err) {
      if (err && err.code === 'ENOSPC') {
        diskFull = true;
        const msg = `[${getTimestamp()}] Disk full while saving uptime data; skipping write.`;
        try { console.error(msg); } catch (_) {}
        return;
      }

      const msg = `[${getTimestamp()}] Failed saving uptime data: ${err && err.message ? err.message : err}`;
      safeWriteError(msg);
      return;
    }

    logInfo('Uptime data saved successfully.');
  } catch (error) {
    const msg = `[${getTimestamp()}] Error saving uptime data: ${error}`;
    safeWriteError(msg);
  }
}

async function loadUptime(client, botVersion = '') {
  try {
    const tmpFile = `${uptimeFile}.tmp`;
    try {
      if (fs.existsSync(tmpFile)) {
        if (!fs.existsSync(uptimeFile)) {
          fs.renameSync(tmpFile, uptimeFile);
        } else {
          fs.unlinkSync(tmpFile);
        }
      }
    } catch (tmpErr) {
      const msg = `[${getTimestamp()}] Error handling temp uptime file: ${tmpErr}`;
      safeWriteError(msg);
    }

    let jsonData;
    try {
      jsonData = await fs.promises.readFile(uptimeFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') jsonData = '{}';
      else throw err;
    }

    const data = JSON.parse(jsonData || '{}');

    previousUptimeMinutes = Number(data.previousUptimeMinutes) || 0;
    totalUptimeMinutes = Number(data.totalUptimeMinutes ?? previousUptimeMinutes) || 0;
    totalDowntimeMinutes = Number(data.totalDowntimeMinutes) || 0;
    lastSavedAt = Number(data.lastSavedAt) || 0;

    if (lastSavedAt > 0) {
      const now = Date.now();
      const clientUptimeMs = client && typeof client.uptime === 'number' ? client.uptime : 0;
      const offlineMs = now - lastSavedAt - clientUptimeMs;
      if (offlineMs > 0) {
        const offlineMinutes = Math.floor(offlineMs / 60000);
        if (offlineMinutes > 0) {
          totalDowntimeMinutes += offlineMinutes;
        }
      }
    }

    logInfo('Uptime data loaded successfully.');

    lastSavedUptime = getSafeClientUptimeMinutes(client);

    try {
      await saveUptime(client);
    } catch (_) { /* save handles its own errors */ }

    const botLabel = client && client.user ? client.user : 'Bot';
    const versionLabel = botVersion ? ` v${botVersion}` : '';
    const startupMessage =
      `[${getTimestamp()}] ${botLabel}${versionLabel} is now online!\n\n` +
      `Total uptime: \`${formatDuration(totalUptimeMinutes)}\`\n` +
      `Total downtime: \`${formatDuration(totalDowntimeMinutes)}\``;

    return { startupMessage };
  } catch (error) {
    const msg = `[${getTimestamp()}] Error loading uptime data: ${error}`;
    safeWriteError(msg);
    return { startupMessage: '' };
  }
}

function getUptimeTotals() {
  return {
    previousUptimeMinutes,
    totalUptimeMinutes,
    totalDowntimeMinutes,
    lastSavedAt,
  };
}

function getLastSavedTimestamp() {
  return lastSavedAt;
}

module.exports = {
  initializeUptimeStore,
  loadUptime,
  saveUptime,
  getUptimeTotals,
  getLastSavedTimestamp,
  formatDuration,
};
