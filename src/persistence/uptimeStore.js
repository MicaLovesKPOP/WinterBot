const fs = require('fs');
const path = require('path');
const {
  logInfo,
  logWarn,
} = require('../logging/logger');

const UPTIME_SCHEMA_VERSION = 2;
const MINUTE_MS = 60_000;
const MAX_REASONABLE_UPTIME_MINUTES =
  10 * 365 * 24 * 60;

let totalUptimeMinutes = 0;
let totalDowntimeMinutes = 0;
let lastSavedAt = 0;
let lastSavedSessionUptimeMinutes = 0;
let saveQueue = Promise.resolve();
let hasLoadedUptimeData = false;

function initializeUptimeStore() {
  totalUptimeMinutes = 0;
  totalDowntimeMinutes = 0;
  lastSavedAt = 0;
  lastSavedSessionUptimeMinutes = 0;
  saveQueue = Promise.resolve();
  hasLoadedUptimeData = false;
}

function resolveUptimeFilePath() {
  const legacyPath = path.join(
    process.cwd(),
    'upTimeData.json'
  );
  const currentPath = path.join(
    process.cwd(),
    'uptimeData.json'
  );

  return fs.existsSync(legacyPath)
    ? legacyPath
    : currentPath;
}

function resolveRepairFilePath() {
  return path.join(
    process.cwd(),
    'uptime-repair.json'
  );
}

function toNonNegativeInteger(
  value,
  fallback = 0
) {
  const numeric = Number(value);

  if (
    !Number.isFinite(numeric) ||
    numeric < 0
  ) {
    return fallback;
  }

  return Math.floor(numeric);
}

function formatDurationFromMinutes(
  minutes,
  maxUnits = 3
) {
  const ms = Math.max(
    0,
    Number(minutes) * MINUTE_MS
  );

  const units = [
    ['year', 365 * 24 * 60 * 60 * 1000],
    ['month', 30 * 24 * 60 * 60 * 1000],
    ['week', 7 * 24 * 60 * 60 * 1000],
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
    ['second', 1000],
  ];

  let remaining = ms;
  const output = [];

  for (const [name, value] of units) {
    const amount = Math.floor(
      remaining / value
    );

    if (amount > 0) {
      output.push(
        `${amount} ${name}${amount === 1 ? '' : 's'}`
      );
      remaining -= amount * value;
    }

    if (output.length >= maxUnits) break;
  }

  return output.length > 0
    ? output.join(', ')
    : '0 seconds';
}

function getUptimeMinutes(client) {
  return Math.floor(
    Math.max(
      0,
      Number(client?.uptime) || 0
    ) / MINUTE_MS
  );
}

function calculateSessionDelta(
  currentSessionMinutes,
  previousSessionMinutes
) {
  const current = toNonNegativeInteger(
    currentSessionMinutes
  );
  const previous = toNonNegativeInteger(
    previousSessionMinutes
  );

  if (current >= previous) {
    return current - previous;
  }

  return current;
}

function recoverUptimeFromAnchor(
  currentData,
  repair
) {
  const anchorLastSavedAt =
    toNonNegativeInteger(
      repair?.anchorLastSavedAt,
      -1
    );
  const anchorUptimeMinutes =
    toNonNegativeInteger(
      repair?.anchorUptimeMinutes,
      -1
    );
  const anchorDowntimeMinutes =
    toNonNegativeInteger(
      repair?.anchorDowntimeMinutes,
      -1
    );
  const checkpointLastSavedAt =
    toNonNegativeInteger(
      currentData?.lastSavedAt,
      -1
    );
  const checkpointDowntimeMinutes =
    toNonNegativeInteger(
      currentData?.totalDowntimeMinutes,
      -1
    );

  if (
    anchorLastSavedAt < 0 ||
    anchorUptimeMinutes < 0 ||
    anchorDowntimeMinutes < 0 ||
    checkpointLastSavedAt <
      anchorLastSavedAt ||
    checkpointDowntimeMinutes <
      anchorDowntimeMinutes
  ) {
    throw new Error(
      'Uptime repair anchor is incompatible with the persisted uptime data.'
    );
  }

  const elapsedMinutes = Math.floor(
    (
      checkpointLastSavedAt -
      anchorLastSavedAt
    ) / MINUTE_MS
  );
  const additionalDowntimeMinutes =
    checkpointDowntimeMinutes -
    anchorDowntimeMinutes;
  const additionalUptimeMinutes =
    Math.max(
      0,
      elapsedMinutes -
        additionalDowntimeMinutes
    );

  return (
    anchorUptimeMinutes +
    additionalUptimeMinutes
  );
}

async function maybeRepairCorruptedUptime(
  storedData
) {
  if (
    totalUptimeMinutes <=
    MAX_REASONABLE_UPTIME_MINUTES
  ) {
    return false;
  }

  let repair;

  try {
    const raw = await fs.promises.readFile(
      resolveRepairFilePath(),
      'utf8'
    );
    repair = JSON.parse(raw || '{}');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      logWarn(
        'Uptime total looks corrupt, but no uptime-repair.json file was found; leaving it unchanged.',
        {
          source: 'uptimeStore',
          totalUptimeMinutes,
        }
      );
      return false;
    }

    throw error;
  }

  const before = totalUptimeMinutes;

  totalUptimeMinutes =
    recoverUptimeFromAnchor(
      storedData,
      repair
    );

  logWarn(
    `Recovered corrupt uptime total: ${before} -> ${totalUptimeMinutes} minutes.`,
    {
      source: 'uptimeStore',
      beforeUptimeMinutes: before,
      repairedUptimeMinutes:
        totalUptimeMinutes,
      repairId: String(repair?.id || ''),
    }
  );

  return true;
}

function enqueueSave(operation) {
  const task = saveQueue
    .catch(() => {})
    .then(operation);

  saveQueue = task;
  return task;
}

async function persistUptimeData(file) {
  const backupFile = `${file}.bak`;
  const temporaryFile = `${file}.tmp`;

  const data = {
    schemaVersion:
      UPTIME_SCHEMA_VERSION,
    totalUptimeMinutes,
    totalDowntimeMinutes,
    lastSavedAt,
  };

  await fs.promises.writeFile(
    temporaryFile,
    JSON.stringify(data, null, 2),
    'utf8'
  );

  JSON.parse(
    await fs.promises.readFile(
      temporaryFile,
      'utf8'
    )
  );

  try {
    await fs.promises.copyFile(
      file,
      backupFile
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.promises.rename(
    temporaryFile,
    file
  );
}

async function saveUptime(client) {
  if (!hasLoadedUptimeData) {
    logWarn('Skipping uptime save because persisted state has not been loaded yet.', {
      source: 'uptimeStore',
    });
    return false;
  }

  return enqueueSave(async () => {
    const file =
      resolveUptimeFilePath();
    const sessionUptimeMinutes =
      getUptimeMinutes(client);
    const deltaMinutes =
      calculateSessionDelta(
        sessionUptimeMinutes,
        lastSavedSessionUptimeMinutes
      );

    totalUptimeMinutes += deltaMinutes;
    lastSavedSessionUptimeMinutes =
      sessionUptimeMinutes;
    lastSavedAt = Date.now();

    await persistUptimeData(file);
  });
}

async function readUptimeData(file) {
  const raw = await fs.promises.readFile(
    file,
    'utf8'
  );
  return JSON.parse(raw || '{}');
}

async function loadPrimaryOrBackup(file) {
  try {
    return {
      data: await readUptimeData(file),
      recoveredFromBackup: false,
    };
  } catch (primaryError) {
    const backupFile = `${file}.bak`;

    try {
      const data =
        await readUptimeData(
          backupFile
        );

      await fs.promises.copyFile(
        backupFile,
        file
      );

      logWarn(
        'Recovered uptime data from the last-known-good backup.',
        {
          source: 'uptimeStore',
          primaryError:
            primaryError.message,
        }
      );

      return {
        data,
        recoveredFromBackup: true,
      };
    } catch (backupError) {
      if (
        primaryError?.code ===
          'ENOENT' &&
        backupError?.code ===
          'ENOENT'
      ) {
        return {
          data: {},
          recoveredFromBackup: false,
        };
      }

      throw new Error(
        `Unable to load uptime data or its backup. Primary: ${primaryError.message}; backup: ${backupError.message}`
      );
    }
  }
}

async function loadUptime(
  client,
  botVersion = ''
) {
  const file =
    resolveUptimeFilePath();

  const { data: storedData } =
    await loadPrimaryOrBackup(file);

  totalUptimeMinutes =
    toNonNegativeInteger(
      storedData.totalUptimeMinutes
    );
  totalDowntimeMinutes =
    toNonNegativeInteger(
      storedData.totalDowntimeMinutes
    );
  lastSavedAt =
    toNonNegativeInteger(
      storedData.lastSavedAt
    );

  if (
    Object.keys(storedData).length > 0
  ) {
    await maybeRepairCorruptedUptime(
      storedData
    );
  }

  const offlineMs =
    lastSavedAt > 0
      ? Math.max(
          0,
          Date.now() -
            lastSavedAt -
            (Number(client?.uptime) || 0)
        )
      : 0;

  const offlineMinutes = Math.floor(
    offlineMs / MINUTE_MS
  );
  totalDowntimeMinutes +=
    offlineMinutes;

  const currentSessionMinutes =
    getUptimeMinutes(client);
  totalUptimeMinutes +=
    currentSessionMinutes;
  lastSavedSessionUptimeMinutes =
    currentSessionMinutes;
  lastSavedAt = Date.now();

  await enqueueSave(() =>
    persistUptimeData(file)
  );
  hasLoadedUptimeData = true;

  logInfo(
    'Uptime data loaded successfully.',
    {
      source: 'uptimeStore',
      totalUptimeMinutes,
      totalDowntimeMinutes,
    }
  );

  const startupMessage =
    `${client?.user?.tag || 'WinterBot'} v${botVersion} is now online.\n` +
    `Total uptime: ${formatDurationFromMinutes(totalUptimeMinutes)}\n` +
    `Total downtime: ${formatDurationFromMinutes(totalDowntimeMinutes)}`;

  return {
    startupMessage,
    processOfflineMinutes:
      offlineMinutes,
  };
}

async function saveHeartbeat(client) {
  await saveUptime(client);
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
  calculateSessionDelta,
  recoverUptimeFromAnchor,
  loadPrimaryOrBackup,
};
