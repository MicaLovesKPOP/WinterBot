const { getConfig } = require('../config');
const { logError, logInfo, setLoggingClient, scheduleDailySummary } = require('../logging/logger');
const { loadEvents } = require('../persistence/eventsStore');
const { loadUptime, saveUptime, formatDurationFromMinutes } = require('../persistence/uptimeStore');
const { createScheduledEventSynchronizer } = require('./scheduledEvents');
const { getTextChannelOrThrow } = require('./guildResources');

let uptimeSaveIntervalId = null;
let synchronizer = null;

function registerEventHandlers(client, botVersion = '') {
  const config = getConfig();
  setLoggingClient(client);

  client.once('clientReady', async () => {
    logInfo(`Logged in as ${client.user.tag} v${botVersion}.`, { source: 'discord.ready' });

    try {
      await loadEvents();
    } catch (error) {
      await logError('discord.ready.loadEvents', error);
    }

    try {
      const { startupMessage, processOfflineMinutes } = await loadUptime(client, botVersion);

      let finalMessage = startupMessage;

      if (processOfflineMinutes > 0) {
        finalMessage = finalMessage.replace(
          'is now online',
          `is now online, after being offline for ${formatDurationFromMinutes(processOfflineMinutes)}`
        );
      }

      const channel = await getTextChannelOrThrow(client, config.logChannelId);
      await channel.send(finalMessage);
    } catch (error) {
      await logError('discord.ready.startupMessage', error);
    }

    if (!uptimeSaveIntervalId) {
      uptimeSaveIntervalId = setInterval(() => {
        saveUptime(client).catch(() => {});
      }, config.uptimeSaveIntervalMs);

      uptimeSaveIntervalId.unref?.();
    }

    try {
      if (!synchronizer) {
        synchronizer = createScheduledEventSynchronizer(client);
      }
      synchronizer.start();
    } catch (error) {
      await logError('discord.ready.startSynchronizer', error);
    }

    scheduleDailySummary();
  });
}

module.exports = { registerEventHandlers };