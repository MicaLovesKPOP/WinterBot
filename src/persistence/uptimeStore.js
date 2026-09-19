const fs = require('fs');
const path = require('path');

let totalUptimeMinutes = 0;
let totalDowntimeMinutes = 0;
let lastSavedAt = 0;

// prevents double counting same session
let sessionCounted = false;

function initializeUptimeStore() {
  totalUptimeMinutes = 0;
  totalDowntimeMinutes = 0;
  lastSavedAt = 0;
  sessionCounted = false;
}

function resolveUptimeFilePath() {
  const p1 = path.join(process.cwd(), 'upTimeData.json');
  const p2 = path.join(process.cwd(), 'uptimeData.json');
  return fs.existsSync(p1) ? p1 : p2;
}

function formatDurationFromMinutes(minutes, maxUnits = 3) {
  const ms = Math.max(0, minutes * 60000);

  const units = [
    ['year', 365 * 24 * 60 * 60 * 1000],
    ['month', 30 * 24 * 60 * 60 * 1000],
    ['week', 7 * 24 * 60 * 60 * 1000],
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
    ['second', 1000],
  ];

  let r = ms;
  const out = [];

  for (const [name, value] of units) {
    const v = Math.floor(r / value);
    if (v > 0) {
      out.push(`${v} ${name}${v > 1 ? 's' : ''}`);
      r -= v * value;
    }
    if (out.length >= maxUnits) break;
  }

  return out.length ? out.join(', ') : '0 seconds';
}

function getUptimeMinutes(client) {
  return Math.floor((client?.uptime || 0) / 60000);
}

async function saveUptime(client) {
  const file = resolveUptimeFilePath();

  const sessionUptime = getUptimeMinutes(client);

  // ✅ ONLY COUNT ONCE PER SESSION
  if (!sessionCounted) {
    totalUptimeMinutes += sessionUptime;
    sessionCounted = true;
  }

  lastSavedAt = Date.now();

  const data = {
    totalUptimeMinutes,
    totalDowntimeMinutes,
    lastSavedAt,
  };

  await fs.promises.writeFile(file, JSON.stringify(data, null, 2));
}

async function loadUptime(client, botVersion = '') {
  const file = resolveUptimeFilePath();

  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    const d = JSON.parse(raw || '{}');

    totalUptimeMinutes = d.totalUptimeMinutes || 0;
    totalDowntimeMinutes = d.totalDowntimeMinutes || 0;
    lastSavedAt = d.lastSavedAt || 0;
  } catch {
    totalUptimeMinutes = 0;
    totalDowntimeMinutes = 0;
    lastSavedAt = 0;
  }

  // reset session guard on new startup
  sessionCounted = false;

  const offlineMs =
    lastSavedAt > 0
      ? Math.max(0, Date.now() - lastSavedAt - (client?.uptime || 0))
      : 0;

  const offlineMinutes = Math.floor(offlineMs / 60000);
  totalDowntimeMinutes += offlineMinutes;

  const startupMessage =
    `${client?.user?.tag || 'WinterBot'} v${botVersion} is now online.\n` +
    `Total uptime: ${formatDurationFromMinutes(totalUptimeMinutes)}\n` +
    `Total downtime: ${formatDurationFromMinutes(totalDowntimeMinutes)}`;

  return {
    startupMessage,
    processOfflineMinutes: offlineMinutes,
  };
}

function saveHeartbeat(client) {
  lastSavedAt = Date.now();
}

function getUptimeTotals() {
  return {
    totalUptimeMinutes,
    totalDowntimeMinutes,
    lastSavedAt,
  };
}

module.exports = {
  initializeUptimeStore,
  loadUptime,
  saveUptime,
  saveHeartbeat,
  getUptimeTotals,
  formatDurationFromMinutes,
};