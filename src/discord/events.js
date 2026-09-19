const { getConfig } = require('../config');
const {
  logError,
  logInfo,
  setLoggingClient,
  scheduleDailySummary,
  stopDailySummary,
} = require('../logging/logger');
const { loadEvents } = require('../persistence/eventsStore');
const {
  loadUptime,
  saveUptime,
  formatDurationFromMinutes,
} = require('../persistence/uptimeStore');
const { postErrorReport } = require('../reporting/errorReport');
const { createScheduledEventSynchronizer } = require('./scheduledEvents');
const {
  getTextChannelOrThrow,
  validateConfiguredResources,
} = require('./guildResources');
const { registerMessageRequirementHandlers } = require('./messageRequirements');

let uptimeSaveIntervalId = null;
let weeklyReportIntervalId = null;
let synchronizer = null;

function registerEventHandlers(client, botVersion = '') {
  const config = getConfig();
  setLoggingClient(client);
  registerMessageRequirementHandlers(client);

  client.once('clientReady', async () => {
    logInfo(`Logged in as ${client.user.tag} v${botVersion}.`, {
      source: 'discord.ready',
    });

    await validateConfiguredResources(client, config);
    logInfo('Discord resource and permission validation passed.', {
      source: 'discord.ready',
    });

    await loadEvents();

    const { startupMessage, processOfflineMinutes } = await loadUptime(
      client,
      botVersion
    );

    let finalMessage = startupMessage;
    if (processOfflineMinutes > 0) {
      finalMessage = finalMessage.replace(
        'is now online',
        `is now online, after being offline for ${formatDurationFromMinutes(
          processOfflineMinutes
        )}`
      );
    }

    try {
      const channel = await getTextChannelOrThrow(client, config.logChannelId);
      await channel.send(finalMessage);
    } catch (error) {
      await logError('discord.ready.startupMessage', error);
    }

    if (!uptimeSaveIntervalId) {
      uptimeSaveIntervalId = setInterval(() => {
        saveUptime(client).catch((error) => {
          logError('uptimeStore.periodicSave', error).catch(() => {});
        });
      }, config.uptimeSaveIntervalMs);
      uptimeSaveIntervalId.unref?.();
    }

    if (!synchronizer) {
      synchronizer = createScheduledEventSynchronizer(client);
    }
    synchronizer.start();

    scheduleDailySummary();

    if (!weeklyReportIntervalId) {
      weeklyReportIntervalId = setInterval(() => {
        postErrorReport(client).catch((error) => {
          logError('errorReport.interval', error).catch(() => {});
        });
      }, config.weeklyReportIntervalMs);
      weeklyReportIntervalId.unref?.();
    }
  });
}

function stopEventHandlers() {
  if (uptimeSaveIntervalId) {
    clearInterval(uptimeSaveIntervalId);
    uptimeSaveIntervalId = null;
  }

  if (weeklyReportIntervalId) {
    clearInterval(weeklyReportIntervalId);
    weeklyReportIntervalId = null;
  }

  if (synchronizer) {
    synchronizer.stop();
    synchronizer = null;
  }

  stopDailySummary();
}

module.exports = {
  registerEventHandlers,
  stopEventHandlers,
};
