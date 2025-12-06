// Scheduled events polling and channel message management
// Mirrors the legacy WinterBot.js scheduled event synchronization logic.

const { getConfig } = require('../config/index.js');
const { fetchSubscribedUsers } = require('./api.js');
const { logError, logInfo } = require('../logging/logger.js');
const { getEventData, saveEvents } = require('../persistence/eventsStore.js');

const eventMessages = {};

function startScheduledEventLoop(client) {
  const config = getConfig();
  const eventData = getEventData();

  async function updateEventMessages() {
    try {
      const guild = client.guilds.cache.get(config.guildId);
      const events = await guild.scheduledEvents.fetch();
      logInfo(`Fetched ${events.size} ${events.size === 1 ? 'event' : 'events'}`);

      const delay = events.size > 0 ? 5000 : 0;
      const knownEventIds = Object.keys(eventData);
      const fetchedEventIds = events.map((event) => event.id);
      const removedEventIds = knownEventIds.filter((eventId) => !fetchedEventIds.includes(eventId));

      for (const eventId of removedEventIds) {
        eventData[eventId].eventStatus = '(past event)';
        let content = `${eventData[eventId].eventMessage}${eventData[eventId].eventStatus}:\n`;
        let count = 1;
        Object.entries(eventData[eventId].subscribedUsers).forEach(([username]) => {
          content += `${count}. ${username}\n`;
          count += 1;
        });

        const unsubscribedUsernamesString = Object.keys(eventData[eventId].unsubscribedUsers).join(', ');

        if (unsubscribedUsernamesString.length > 0) {
          content += `\nDeregistered players: ${unsubscribedUsernamesString}\n`;
        }

        if (eventData[eventId].messageId) {
          try {
            const channel = client.channels.cache.get(config.channelId);
            const message = await channel.messages.fetch(eventData[eventId].messageId);
            await message.edit(content);
          } catch (error) {
            await logError('Error updating message', error);
          }
        } else if (eventMessages[eventId]) {
          await eventMessages[eventId].edit(content);
        }

        delete eventData[eventId];
      }

      for (const event of events.values()) {
        const eventId = event.id;
        logInfo(`Processing event ${eventId}: '${event.name}'`);

        if (event && !event.ended) {
          let users;
          if (!client.subscribedUsersPromise) client.subscribedUsersPromise = {};
          if (!client.subscribedUsersPromise[eventId]) {
            client.subscribedUsersPromise[eventId] = fetchSubscribedUsers(config.guildId, eventId);
          }
          users = await client.subscribedUsersPromise[eventId];
          delete client.subscribedUsersPromise[eventId];

          let usernames = [];
          if (Array.isArray(users)) {
            usernames = users.map((user) => user.user.username);
          } else {
            await logError('Error: users is not an array', new Error(JSON.stringify(users)));
          }

          if (!eventData[eventId]) {
            eventData[eventId] = {
              subscribedUsers: {},
              unsubscribedUsers: {},
              unsubscribedTimestamps: {},
              eventMessage: `**Registered players for ${event.name}** `,
              eventStatus: '',
            };
          } else if (!eventData[eventId].unsubscribedUsers) {
            eventData[eventId].unsubscribedUsers = {};
          }

          if (eventData[eventId].eventName !== event.name) {
            eventData[eventId].eventName = event.name;
            eventData[eventId].eventMessage = `**Registered players for ${event.name}** `;
          }
          let content = `${eventData[eventId].eventMessage}${eventData[eventId].eventStatus}**:**\n`;

          usernames.forEach((username) => {
            if (!eventData[eventId].subscribedUsers[username]) {
              eventData[eventId].subscribedUsers[username] = {
                timestamp: Date.now(),
                apiCheckCounter: 0,
              };
            }
            if (eventData[eventId].unsubscribedUsers[username]) {
              delete eventData[eventId].unsubscribedUsers[username];
            }
          });

          const previousUsernames = Object.keys(eventData[eventId].subscribedUsers);
          const unsubscribedUsernames = previousUsernames.filter((username) => !usernames.includes(username));

          unsubscribedUsernames.forEach((username) => {
            eventData[eventId].subscribedUsers[username].apiCheckCounter += 1;
          });

          const delayApiChecks = 6;
          unsubscribedUsernames.forEach((username) => {
            if (eventData[eventId].subscribedUsers[username].apiCheckCounter >= delayApiChecks) {
              delete eventData[eventId].subscribedUsers[username];
              eventData[eventId].unsubscribedUsers[username] = Date.now();
            }
          });

          if (event.status === 3) {
            eventData[eventId].eventStatus = '(past event)';
          } else if (event.status === 2) {
            eventData[eventId].eventStatus = '(currently happening)';
          } else {
            eventData[eventId].eventStatus = '(upcoming)';
          }

          content = `${eventData[eventId].eventMessage}${eventData[eventId].eventStatus}:\n`;

          let count = 1;
          Object.entries(eventData[eventId].subscribedUsers).forEach(([username]) => {
            content += `${count}. ${username}\n`;
            count += 1;
          });

          const unsubscribedUsernamesString = Object.keys(eventData[eventId].unsubscribedUsers).join(', ');

          if (unsubscribedUsernamesString.length > 0) {
            content += `\nDeregistered players: ${unsubscribedUsernamesString}\n`;
          }

          if (eventData[eventId].messageId) {
            try {
              const channel = client.channels.cache.get(config.channelId);
              const message = await channel.messages.fetch(eventData[eventId].messageId);
              await message.edit(content);
            } catch (error) {
              await logError('Handled Error updating message', error);
              const channel = client.channels.cache.get(config.channelId);
              if (!channel) throw new Error('Channel not found');
              const message = await channel.send(content);
              eventMessages[eventId] = message;
              eventData[eventId].messageId = message.id;
            }
          } else if (eventMessages[eventId]) {
            await eventMessages[eventId].edit(content);
          } else {
            const channel = client.channels.cache.get(config.channelId);
            if (!channel) throw new Error('Channel not found');
            const message = await channel.send(content);
            eventMessages[eventId] = message;
            eventData[eventId].messageId = message.id;
          }

          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      await saveEvents();
      logInfo('Update completed.');
    } catch (error) {
      await logError('Handled Error in updateEventMessages', error);
    } finally {
      setTimeout(
        updateEventMessages,
        Object.keys(eventData).length > 0 ? 500 : 30000
      );
    }
  }

  return updateEventMessages();
}

module.exports = { startScheduledEventLoop };
