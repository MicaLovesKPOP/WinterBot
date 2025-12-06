// Discord lifecycle event registration and startup sequencing
// Moves the ready-handler logic from the legacy WinterBot.js into a focused
// module that wires persistence, uptime tracking, and reporting once the
// Discord client is ready.

const { getConfig } = require('../config/index.js');
const { logError, logInfo, setLoggingClient } = require('../logging/logger.js');
const { loadEvents } = require('../persistence/eventsStore.js');
const { loadUptime, saveUptime } = require('../persistence/uptimeStore.js');
const { postErrorReport } = require('../reporting/errorReport.js');
const { startScheduledEventLoop } = require('./scheduledEvents.js');

const WEEKLY_REPORT_INTERVAL_MS = 604800000; // 7 days
const UPTIME_SAVE_INTERVAL_MS = 60 * 1000;

let weeklyReportIntervalId = null;

function registerEventHandlers(client, botVersion = '') {
  const config = getConfig();

  // Inject the Discord client into the logger after creation to avoid
  // circular dependencies while enabling Discord log-channel output.
  setLoggingClient(client);

  client.once('ready', async () => {
    logInfo(`Logged in as ${client.user.tag} v${botVersion}!`);

    try {
      await loadEvents();
    } catch (error) {
      await logError('Error loading events on ready', error);
    }

    try {
      const { startupMessage } = await loadUptime(client, botVersion);
      if (startupMessage) {
        try {
          const channel = client.channels.cache.get(config.logChannelId);
          if (channel) await channel.send(startupMessage);
        } catch (sendError) {
          await logError('Error sending startup uptime message', sendError);
        }
      }
    } catch (error) {
      await logError('Error loading uptime data on ready', error);
    }

    // Save uptime every 60 seconds to minimize lost time on unexpected restarts.
    setInterval(() => { saveUptime(client); }, UPTIME_SAVE_INTERVAL_MS);

    try {
      await startScheduledEventLoop(client);
    } catch (error) {
      await logError('Error starting scheduled events loop', error);
    }

    // Weekly error report interval (runs only if the client is ready).
    if (!weeklyReportIntervalId) {
      weeklyReportIntervalId = setInterval(() => {
        if (client.isReady?.()) {
          postErrorReport(client).catch(async (error) => {
            await logError('Error posting weekly error report', error);
          });
        }
      }, WEEKLY_REPORT_INTERVAL_MS);
    }
  });
}

module.exports = { registerEventHandlers };
