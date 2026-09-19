const fs = require('fs');
const path = require('path');
const { logInfo, logError, getTimestamp } = require('../logging/logger');

let eventData = {};
const dataFilePath = path.join(process.cwd(), 'data.json');

function initializeEventsStore() {
  eventData = {};
}

function cloneEventForSave(event) {
  const subscribedUsers = {};
  for (const [userId, user] of Object.entries(event.subscribedUsers || {})) {
    subscribedUsers[userId] = {
      userId,
      lastKnownUsername: user.lastKnownUsername || '',
      lastKnownDisplayName: user.lastKnownDisplayName || '',
      timestamp: Number(user.timestamp) || Date.now(),
      apiCheckCounter: Number(user.apiCheckCounter) || 0,
    };
  }

  const unsubscribedUsers = {};
  for (const [userId, user] of Object.entries(event.unsubscribedUsers || {})) {
    unsubscribedUsers[userId] = {
      userId,
      lastKnownUsername: user.lastKnownUsername || '',
      lastKnownDisplayName: user.lastKnownDisplayName || '',
      timestamp: Number(user.timestamp) || Date.now(),
    };
  }

  return {
    eventName: event.eventName || '',
    eventMessage: event.eventMessage || '',
    eventStatus: event.eventStatus || '',
    messageId: event.messageId || '',
    subscribedUsers,
    unsubscribedUsers,
  };
}

function normalizeLegacyUserRecord(key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      userId: value.userId ? String(value.userId) : String(key),
      lastKnownUsername: String(value.lastKnownUsername || value.username || key),
      lastKnownDisplayName: String(value.lastKnownDisplayName || value.displayName || value.username || key),
      timestamp: Number(value.timestamp) || Date.now(),
      apiCheckCounter: Number(value.apiCheckCounter) || 0,
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

function normalizeLegacyUnsubscribedRecord(key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      userId: value.userId ? String(value.userId) : String(key),
      lastKnownUsername: String(value.lastKnownUsername || value.username || key),
      lastKnownDisplayName: String(value.lastKnownDisplayName || value.displayName || value.username || key),
      timestamp: Number(value.timestamp) || Date.now(),
    };
  }

  if (typeof value === 'number') {
    return {
      userId: String(key),
      lastKnownUsername: String(key),
      lastKnownDisplayName: String(key),
      timestamp: value,
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
  const source = raw && typeof raw === 'object' ? raw : {};

  for (const [eventId, event] of Object.entries(source)) {
    const safeEvent = event && typeof event === 'object' ? event : {};
    const subscribedUsers = {};
    const unsubscribedUsers = {};

    const subscribedSource =
      safeEvent.subscribedUsers && typeof safeEvent.subscribedUsers === 'object'
        ? safeEvent.subscribedUsers
        : {};
    const unsubscribedSource =
      safeEvent.unsubscribedUsers && typeof safeEvent.unsubscribedUsers === 'object'
        ? safeEvent.unsubscribedUsers
        : {};

    for (const [key, value] of Object.entries(subscribedSource)) {
      const record = normalizeLegacyUserRecord(key, value);
      subscribedUsers[record.userId] = record;
    }

    for (const [key, value] of Object.entries(unsubscribedSource)) {
      const record = normalizeLegacyUnsubscribedRecord(key, value);
      unsubscribedUsers[record.userId] = record;
    }

    normalized[eventId] = {
      eventName: String(safeEvent.eventName || ''),
      eventMessage: String(safeEvent.eventMessage || `**Registered players for ${safeEvent.eventName || 'event'}** `),
      eventStatus: String(safeEvent.eventStatus || ''),
      messageId: String(safeEvent.messageId || ''),
      subscribedUsers,
      unsubscribedUsers,
    };
  }

  return normalized;
}

async function saveEvents() {
  const snapshot = {};
  for (const [eventId, event] of Object.entries(eventData)) {
    snapshot[eventId] = cloneEventForSave(event);
  }

  const payload = JSON.stringify({ eventData: snapshot }, null, 2);
  const tempFilePath = `${dataFilePath}.tmp`;

  try {
    await fs.promises.writeFile(tempFilePath, payload, 'utf8');
    await fs.promises.rename(tempFilePath, dataFilePath);
    logInfo('Event data saved successfully.', { source: 'eventsStore' });
  } catch (error) {
    await logError('eventsStore.saveEvents', error);
    try {
      await fs.promises.unlink(tempFilePath);
    } catch (_) {}
  }
}

async function loadEvents() {
  const tempFilePath = `${dataFilePath}.tmp`;

  try {
    if (fs.existsSync(tempFilePath) && !fs.existsSync(dataFilePath)) {
      fs.renameSync(tempFilePath, dataFilePath);
    }
  } catch (error) {
    await logError('eventsStore.loadEvents.tempFileRecovery', error);
  }

  try {
    const jsonData = await fs.promises.readFile(dataFilePath, 'utf8');
    const parsed = JSON.parse(jsonData || '{}');
    eventData = normalizeEventStore(parsed.eventData || {});
    logInfo('Event data loaded successfully.', { source: 'eventsStore' });
    return eventData;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      eventData = {};
      logInfo('No event data file found; starting with empty state.', { source: 'eventsStore' });
      return eventData;
    }

    if (error instanceof SyntaxError) {
      const corruptPath = `${dataFilePath}.corrupt.${getTimestamp().replace(/[: ]/g, '-')}`;
      try {
        await fs.promises.rename(dataFilePath, corruptPath);
      } catch (_) {}
      eventData = {};
      await logError('eventsStore.loadEvents.parse', error, {
        recoveryAction: `Moved corrupt file to ${path.basename(corruptPath)} and reset event store`,
      });
      return eventData;
    }

    await logError('eventsStore.loadEvents', error);
    return eventData;
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
};