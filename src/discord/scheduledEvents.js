const { getConfig } = require('../config');
const { fetchSubscribedUsers } = require('./api');
const { logError, logInfo, logWarn } = require('../logging/logger');
const { getEventData, saveEvents } = require('../persistence/eventsStore');
const { formatUserDisplay } = require('./display');
const { getGuildOrThrow, getTextChannelOrThrow, resolveGuildMember } = require('./guildResources');

function getStatusLabel(status) {
  if (status === 2) return '(currently happening)';
  if (status === 3) return '(past event)';
  if (status === 4) return '(canceled)';
  return '(upcoming)';
}

function toSubscriberRecord(rawUser, previousRecord = null) {
  const userId = String(rawUser?.user?.id || previousRecord?.userId || '');
  const username = String(rawUser?.user?.username || previousRecord?.lastKnownUsername || userId);
  const displayName = String(
    rawUser?.member?.nick ||
    rawUser?.member?.display_name ||
    previousRecord?.lastKnownDisplayName ||
    username
  );

  return {
    userId,
    lastKnownUsername: username,
    lastKnownDisplayName: displayName,
    timestamp: previousRecord?.timestamp || Date.now(),
    apiCheckCounter: 0,
  };
}

async function renderEventContent(guild, eventRecord, config) {
  const lines = [`${eventRecord.eventMessage}${eventRecord.eventStatus}:`];
  let count = 1;

  const subscribedUsers = Object.values(eventRecord.subscribedUsers || {}).sort(
    (left, right) => left.timestamp - right.timestamp
  );

  for (const record of subscribedUsers) {
    const member = await resolveGuildMember(guild, record.userId);
    if (member) {
      record.lastKnownUsername = member.user.username;
      record.lastKnownDisplayName = member.displayName;
    }
    lines.push(`${count}. ${formatUserDisplay({ member, record, mode: config.userDisplayMode })}`);
    count += 1;
  }

  const unsubscribedUsers = Object.values(eventRecord.unsubscribedUsers || {});
  if (unsubscribedUsers.length > 0) {
    const formatted = [];
    for (const record of unsubscribedUsers) {
      const member = await resolveGuildMember(guild, record.userId);
      if (member) {
        record.lastKnownUsername = member.user.username;
        record.lastKnownDisplayName = member.displayName;
      }
      formatted.push(formatUserDisplay({ member, record, mode: config.userDisplayMode }));
    }
    lines.push('');
    lines.push(`Deregistered players: ${formatted.join(', ')}`);
  }

  return lines.join('\n');
}

async function upsertEventMessage(channel, eventRecord, content) {
  if (eventRecord.messageId) {
    try {
      const message = await channel.messages.fetch(eventRecord.messageId);
      if (message.content !== content) {
        await message.edit(content);
      }
      return message;
    } catch (_) {}
  }

  const message = await channel.send(content);
  eventRecord.messageId = message.id;
  return message;
}

async function reconcileRemovedEvents(guild, channel, eventData, fetchedEventIds, config) {
  let changed = false;

  for (const [eventId, eventRecord] of Object.entries(eventData)) {
    if (fetchedEventIds.has(eventId)) continue;

    eventRecord.eventStatus = '(past event)';
    const content = await renderEventContent(guild, eventRecord, config);
    await upsertEventMessage(channel, eventRecord, content);
    delete eventData[eventId];
    changed = true;

    logInfo(`Marked removed event ${eventId} as past and removed from active tracking.`, {
      source: 'scheduledEvents',
      eventId,
    });
  }

  return changed;
}

async function reconcileSingleEvent(guild, channel, event, eventData, config) {
  const eventId = event.id;
  const statusLabel = getStatusLabel(event.status);

  const record = eventData[eventId] || {
    eventName: event.name,
    eventMessage: `**Registered players for ${event.name}** `,
    eventStatus: statusLabel,
    messageId: '',
    subscribedUsers: {},
    unsubscribedUsers: {},
  };

  let changed = !eventData[eventId];
  eventData[eventId] = record;

  if (record.eventName !== event.name) {
    record.eventName = event.name;
    record.eventMessage = `**Registered players for ${event.name}** `;
    changed = true;
  }

  if (record.eventStatus !== statusLabel) {
    logInfo(`Event ${eventId} "${event.name}" status changed to ${statusLabel}.`, {
      source: 'scheduledEvents',
      eventId,
      eventStatus: statusLabel,
    });
    record.eventStatus = statusLabel;
    changed = true;
  }

  let fetchFailed = false;
  let rawUsers = [];

  try {
    rawUsers = await fetchSubscribedUsers(config.guildId, eventId);
  } catch (error) {
    fetchFailed = true;
    await logError('scheduledEvents.fetchSubscribedUsers', error, {
      eventId,
      eventName: event.name,
    });
  }

  if (!fetchFailed) {
    const currentUsersById = new Map();
    for (const rawUser of rawUsers) {
      if (!rawUser?.user?.id) continue;
      currentUsersById.set(String(rawUser.user.id), rawUser);
    }

    logInfo(
      `Event ${eventId} "${event.name}": status=${event.status}, fetchedUsers=${currentUsersById.size}, storedSubscribed=${Object.keys(record.subscribedUsers).length}, storedUnsubscribed=${Object.keys(record.unsubscribedUsers).length}`,
      { source: 'scheduledEvents', eventId }
    );

    for (const [userId, rawUser] of currentUsersById.entries()) {
      const previousRecord = record.subscribedUsers[userId] || record.unsubscribedUsers[userId] || null;
      const nextRecord = toSubscriberRecord(rawUser, previousRecord);

      if (!record.subscribedUsers[userId]) changed = true;
      record.subscribedUsers[userId] = nextRecord;
      delete record.unsubscribedUsers[userId];
    }

    for (const [userId, existing] of Object.entries(record.subscribedUsers)) {
      if (currentUsersById.has(userId)) {
        existing.apiCheckCounter = 0;
        continue;
      }

      existing.apiCheckCounter = Number(existing.apiCheckCounter || 0) + 1;

      if (existing.apiCheckCounter < config.unsubscribeGraceCycles) {
        logInfo(
          `Pending removal for event ${eventId}: ${userId} apiCheckCounter=${existing.apiCheckCounter}/${config.unsubscribeGraceCycles}`,
          { source: 'scheduledEvents', eventId, userId }
        );
        continue;
      }

      record.unsubscribedUsers[userId] = {
        userId,
        lastKnownUsername: existing.lastKnownUsername,
        lastKnownDisplayName: existing.lastKnownDisplayName,
        timestamp: Date.now(),
      };
      delete record.subscribedUsers[userId];
      changed = true;
    }
  } else {
    logWarn(
      `Using cached subscriber state for event ${eventId} "${event.name}" because subscriber fetch failed.`,
      { source: 'scheduledEvents', eventId }
    );
  }

  const content = await renderEventContent(guild, record, config);
  await upsertEventMessage(channel, record, content);
  return changed;
}

function createScheduledEventSynchronizer(client) {
  const config = getConfig();
  const eventData = getEventData();
  let timer = null;
  let isRunning = false;
  let isStarted = false;

  async function tick() {
    if (isRunning) return;
    isRunning = true;

    try {
      const guild = await getGuildOrThrow(client, config.guildId);
      const channel = await getTextChannelOrThrow(client, config.channelId);
      const events = await guild.scheduledEvents.fetch();

      logInfo(`Fetched ${events.size} scheduled event(s).`, { source: 'scheduledEvents.tick' });

      let changed = await reconcileRemovedEvents(
        guild,
        channel,
        eventData,
        new Set(events.map((event) => event.id)),
        config
      );

      for (const event of events.values()) {
        changed = (await reconcileSingleEvent(guild, channel, event, eventData, config)) || changed;
      }

      if (changed) {
        await saveEvents();
      }
    } catch (error) {
      await logError('scheduledEvents.tick', error);
    } finally {
      isRunning = false;
      if (isStarted) {
        const interval =
          Object.keys(eventData).length > 0
            ? config.activeEventPollIntervalMs
            : config.eventPollIntervalMs;

        timer = setTimeout(() => {
          tick().catch(() => {});
        }, interval);
        timer.unref?.();
      }
    }
  }

  return {
    start() {
      if (isStarted) return;
      isStarted = true;
      tick().catch(() => {});
    },
    stop() {
      isStarted = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    tick,
  };
}

module.exports = {
  createScheduledEventSynchronizer,
  getStatusLabel,
  toSubscriberRecord,
  renderEventContent,
};