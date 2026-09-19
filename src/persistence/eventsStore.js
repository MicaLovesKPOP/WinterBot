const fs = require('fs');
const path = require('path');
const {
  logInfo,
  logError,
  logWarn,
  getTimestamp,
} = require('../logging/logger');

let eventData = {};
let saveQueue = Promise.resolve();
let hasLoadedEventData = false;

const dataFilePath = path.join(
  process.cwd(),
  'data.json'
);
const backupFilePath = `${dataFilePath}.bak`;
const tempFilePath = `${dataFilePath}.tmp`;

function initializeEventsStore() {
  eventData = {};
  saveQueue = Promise.resolve();
  hasLoadedEventData = false;
}

function safeTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? numeric
    : Date.now();
}

function cloneEventForSave(event) {
  const subscribedUsers = {};

  for (const [userId, user] of Object.entries(
    event.subscribedUsers || {}
  )) {
    subscribedUsers[userId] = {
      userId,
      lastKnownUsername:
        user.lastKnownUsername || '',
      lastKnownDisplayName:
        user.lastKnownDisplayName || '',
      timestamp: safeTimestamp(user.timestamp),
      apiCheckCounter:
        Number(user.apiCheckCounter) || 0,
    };
  }

  const unsubscribedUsers = {};

  for (const [userId, user] of Object.entries(
    event.unsubscribedUsers || {}
  )) {
    unsubscribedUsers[userId] = {
      userId,
      lastKnownUsername:
        user.lastKnownUsername || '',
      lastKnownDisplayName:
        user.lastKnownDisplayName || '',
      timestamp: safeTimestamp(user.timestamp),
    };
  }

  return {
    eventName: event.eventName || '',
    eventMessage: event.eventMessage || '',
    eventStatus: event.eventStatus || '',
    messageId: event.messageId || '',
    missingEventPolls:
      Number(event.missingEventPolls) || 0,
    subscribedUsers,
    unsubscribedUsers,
  };
}

function normalizeLegacyUserRecord(key, value) {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return {
      userId: value.userId
        ? String(value.userId)
        : String(key),
      lastKnownUsername: String(
        value.lastKnownUsername ||
          value.username ||
          key
      ),
      lastKnownDisplayName: String(
        value.lastKnownDisplayName ||
          value.displayName ||
          value.username ||
          key
      ),
      timestamp: safeTimestamp(value.timestamp),
      apiCheckCounter:
        Number(value.apiCheckCounter) || 0,
    };
  }

  return {
    userId: String(key),
    lastKnownUsername: String(key),
    lastKnownDisplayName: String(key),
    timestamp: Date.now(),
    apiCheckCounter: 0,
  };
}

function normalizeLegacyUnsubscribedRecord(
  key,
  value
) {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return {
      userId: value.userId
        ? String(value.userId)
        : String(key),
      lastKnownUsername: String(
        value.lastKnownUsername ||
          value.username ||
          key
      ),
      lastKnownDisplayName: String(
        value.lastKnownDisplayName ||
          value.displayName ||
          value.username ||
          key
      ),
      timestamp: safeTimestamp(value.timestamp),
    };
  }

  if (typeof value === 'number') {
    return {
      userId: String(key),
      lastKnownUsername: String(key),
      lastKnownDisplayName: String(key),
      timestamp: safeTimestamp(value),
    };
  }

  return {
    userId: String(key),
    lastKnownUsername: String(key),
    lastKnownDisplayName: String(key),
    timestamp: Date.now(),
  };
}

function normalizeEventStore(raw) {
  const normalized = {};
  const source =
    raw && typeof raw === 'object'
      ? raw
      : {};

  for (const [eventId, event] of Object.entries(
    source
  )) {
    const safeEvent =
      event && typeof event === 'object'
        ? event
        : {};
    const subscribedUsers = {};
    const unsubscribedUsers = {};

    const subscribedSource =
      safeEvent.subscribedUsers &&
      typeof safeEvent.subscribedUsers === 'object'
        ? safeEvent.subscribedUsers
        : {};
    const unsubscribedSource =
      safeEvent.unsubscribedUsers &&
      typeof safeEvent.unsubscribedUsers === 'object'
        ? safeEvent.unsubscribedUsers
        : {};

    for (const [key, value] of Object.entries(
      subscribedSource
    )) {
      const record = normalizeLegacyUserRecord(
        key,
        value
      );
      subscribedUsers[record.userId] = record;
    }

    for (const [key, value] of Object.entries(
      unsubscribedSource
    )) {
      const record =
        normalizeLegacyUnsubscribedRecord(
          key,
          value
        );
      unsubscribedUsers[record.userId] = record;
    }

    normalized[eventId] = {
      eventName: String(
        safeEvent.eventName || ''
      ),
      eventMessage: String(
        safeEvent.eventMessage ||
          `**Registered players for ${safeEvent.eventName || 'event'}** `
      ),
      eventStatus: String(
        safeEvent.eventStatus || ''
      ),
      messageId: String(
        safeEvent.messageId || ''
      ),
      missingEventPolls:
        Number(safeEvent.missingEventPolls) || 0,
      subscribedUsers,
      unsubscribedUsers,
    };
  }

  return normalized;
}

function createSnapshot() {
  const snapshot = {};

  for (const [eventId, event] of Object.entries(
    eventData
  )) {
    snapshot[eventId] =
      cloneEventForSave(event);
  }

  return snapshot;
}

async function replaceWithBackup(
  destination,
  temporary,
  backup
) {
  try {
    await fs.promises.copyFile(
      destination,
      backup
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await fs.promises.rename(
    temporary,
    destination
  );
}

function enqueueSave(operation) {
  const task = saveQueue
    .catch(() => {})
    .then(operation);

  saveQueue = task;
  return task;
}

async function writeSnapshot(snapshot) {
  const payload = JSON.stringify(
    { eventData: snapshot },
    null,
    2
  );

  await fs.promises.writeFile(
    tempFilePath,
    payload,
    'utf8'
  );

  JSON.parse(
    await fs.promises.readFile(
      tempFilePath,
      'utf8'
    )
  );

  await replaceWithBackup(
    dataFilePath,
    tempFilePath,
    backupFilePath
  );

  logInfo(
    'Event data saved successfully.',
    { source: 'eventsStore' }
  );
}

async function saveEvents() {
  if (!hasLoadedEventData) {
    logWarn('Skipping event-data save because persisted state has not been loaded yet.', {
      source: 'eventsStore',
    });
    return false;
  }

  const snapshot = createSnapshot();

  return enqueueSave(async () => {
    try {
      await writeSnapshot(snapshot);
    } catch (error) {
      try {
        await fs.promises.unlink(tempFilePath);
      } catch (_) {}

      await logError(
        'eventsStore.saveEvents',
        error
      );
      throw error;
    }
  });
}

async function readEventFile(filePath) {
  const jsonData = await fs.promises.readFile(
    filePath,
    'utf8'
  );
  const parsed = JSON.parse(jsonData || '{}');
  return normalizeEventStore(
    parsed.eventData || {}
  );
}

async function recoverFromBackup(reason, preservePrimaryPath = null) {
  try {
    const recovered = await readEventFile(
      backupFilePath
    );

    if (preservePrimaryPath && fs.existsSync(dataFilePath)) {
      await fs.promises.rename(
        dataFilePath,
        preservePrimaryPath
      );
    }

    await fs.promises.copyFile(
      backupFilePath,
      dataFilePath
    );

    eventData = recovered;
    hasLoadedEventData = true;

    logWarn(
      `Recovered event data from data.json.bak after ${reason}.`,
      {
        source: 'eventsStore',
        recoveryAction:
          'Restored last-known-good event-data backup',
      }
    );

    return true;
  } catch (_) {
    return false;
  }
}

async function handleStaleTempFile() {
  try {
    if (!fs.existsSync(tempFilePath)) return;

    if (!fs.existsSync(dataFilePath)) {
      await fs.promises.rename(
        tempFilePath,
        dataFilePath
      );
      return;
    }

    await fs.promises.unlink(tempFilePath);
  } catch (error) {
    await logError(
      'eventsStore.loadEvents.tempFileRecovery',
      error
    );
  }
}

async function loadEvents() {
  await handleStaleTempFile();

  try {
    eventData = await readEventFile(
      dataFilePath
    );
    hasLoadedEventData = true;

    logInfo(
      'Event data loaded successfully.',
      { source: 'eventsStore' }
    );

    return eventData;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      if (
        await recoverFromBackup(
          'the primary file being missing'
        )
      ) {
        return eventData;
      }

      eventData = {};
      hasLoadedEventData = true;
      logInfo(
        'No event data file found; starting with empty state.',
        { source: 'eventsStore' }
      );
      return eventData;
    }

    if (error instanceof SyntaxError) {
      const corruptPath =
        `${dataFilePath}.corrupt.` +
        getTimestamp().replace(/[: ]/g, '-');

      if (
        await recoverFromBackup(
          'the primary file being corrupt',
          corruptPath
        )
      ) {
        return eventData;
      }

      await logError(
        'eventsStore.loadEvents.parse',
        error,
        {
          recoveryAction:
            `Primary file remains untouched because no valid backup was available (${path.basename(corruptPath)} was not created)`,
        }
      );

      throw new Error(
        'Event data is corrupt and no valid backup is available; refusing to start with empty state.'
      );
    }

    if (
      await recoverFromBackup(
        'a primary-file read failure'
      )
    ) {
      return eventData;
    }

    await logError(
      'eventsStore.loadEvents',
      error
    );
    throw error;
  }
}

function getEventData() {
  return eventData;
}

module.exports = {
  initializeEventsStore,
  loadEvents,
  saveEvents,
  getEventData,
  normalizeEventStore,
  cloneEventForSave,
};
