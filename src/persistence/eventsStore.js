// Event subscription persistence
// Responsible for loading/saving scheduled event data to disk and maintaining
// an in-memory cache. Behavior mirrors the original WinterBot.js logic,
// including how subscribed/unsubscribed users are transformed for JSON
// serialization.

const fs = require('fs');
const path = require('path');
const { getTimestamp, logInfo, safeWriteError } = require('../logging/logger.js');

let eventData = {};
const dataFilePath = path.join(process.cwd(), 'data.json');

function initializeEventsStore() {
  // Prepare in-memory structures for event data.
  eventData = {};
}

async function saveEvents() {
  try {
    Object.values(eventData).forEach((event) => {
      if (event.subscribedUsers) {
        event.subscribedUsers = Object.entries(event.subscribedUsers);
      }
      if (event.unsubscribedUsers) {
        event.unsubscribedUsers = Object.entries(event.unsubscribedUsers);
      }
    });

    const data = JSON.stringify({ eventData }, null, 2);
    await fs.promises.writeFile(dataFilePath, data);

    Object.values(eventData).forEach((event) => {
      if (Array.isArray(event.subscribedUsers)) {
        event.subscribedUsers = Object.fromEntries(event.subscribedUsers);
      }
      if (Array.isArray(event.unsubscribedUsers)) {
        event.unsubscribedUsers = Object.fromEntries(event.unsubscribedUsers);
      }
    });

    logInfo('Data saved successfully.');
  } catch (error) {
    const msg = `[${getTimestamp()}] Handled Error saving data: ${error}`;
    try { console.error(msg); } catch (_) {}
    safeWriteError(msg);
  }
}

async function loadEvents() {
  try {
    let jsonData;
    try {
      jsonData = await fs.promises.readFile(dataFilePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        jsonData = '{"eventData":{}}';
      } else {
        throw err;
      }
    }

    const parsed = JSON.parse(jsonData);
    eventData = parsed.eventData || {};

    Object.values(eventData).forEach((event) => {
      if (Array.isArray(event.subscribedUsers)) {
        event.subscribedUsers = Object.fromEntries(event.subscribedUsers);
      }
      if (Array.isArray(event.unsubscribedUsers)) {
        event.unsubscribedUsers = Object.fromEntries(event.unsubscribedUsers);
      }
      if (!event.unsubscribedUsers) {
        event.unsubscribedUsers = {};
      }
    });

    logInfo('Data loaded successfully.');
    return eventData;
  } catch (error) {
    const msg = `[${getTimestamp()}] Handled Error loading data: ${error}`;
    try { console.error(msg); } catch (_) {}
    safeWriteError(msg);
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
};
