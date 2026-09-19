const { escapeMarkdown } = require('discord.js');
const { getConfig } = require('../config');
const { fetchSubscribedUsers } = require('./api');
const {
  logDebug,
  logError,
  logInfo,
  logWarn,
} = require('../logging/logger');
const { getEventData, saveEvents } = require('../persistence/eventsStore');
const { formatUserDisplay } = require('./display');
const {
  getGuildOrThrow,
  getTextChannelOrThrow,
  resolveGuildMember,
} = require('./guildResources');

const MAX_EVENT_MESSAGE_LENGTH = 1900;

function getStatusLabel(status) {
  if (status === 2) return '(currently happening)';
  if (status === 3) return '(past event)';
  if (status === 4) return '(canceled)';
  return '(upcoming)';
}

function toSubscriberRecord(rawUser, previousRecord = null) {
  const userId = String(
    rawUser?.user?.id ||
      previousRecord?.userId ||
      ''
  );
  const username = String(
    rawUser?.user?.username ||
      previousRecord?.lastKnownUsername ||
      userId
  );
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

function isUnknownMessageError(error) {
  return Number(error?.code || error?.rawError?.code) === 10008;
}

function selectContinuousSubscriberRecord(eventRecord, userId) {
  return eventRecord.subscribedUsers?.[userId] || null;
}

function buildOverflowFooter(omittedRegistered, deregisteredCount) {
  const lines = [];

  if (omittedRegistered > 0) {
    lines.push(
      `… ${omittedRegistered} more registered player${omittedRegistered === 1 ? '' : 's'} not shown.`
    );
  }

  if (deregisteredCount > 0) {
    lines.push(
      `Deregistered players: ${deregisteredCount} total (names omitted to fit Discord's message limit).`
    );
  }

  return lines;
}

function fitEventContent(
  header,
  registeredLines,
  deregisteredNames,
  limit = MAX_EVENT_MESSAGE_LENGTH
) {
  const fullLines = [header, ...registeredLines];

  if (deregisteredNames.length > 0) {
    fullLines.push('');
    fullLines.push(
      `Deregistered players: ${deregisteredNames.join(', ')}`
    );
  }

  const fullContent = fullLines.join('\n');
  if (fullContent.length <= limit) return fullContent;

  const lines = [header];
  let includedRegistered = 0;

  for (let index = 0; index < registeredLines.length; index += 1) {
    const nextIncluded = index + 1;
    const omittedRegistered =
      registeredLines.length - nextIncluded;
    const footer = buildOverflowFooter(
      omittedRegistered,
      deregisteredNames.length
    );
    const candidate = [
      ...lines,
      registeredLines[index],
      ...footer,
    ].join('\n');

    if (candidate.length > limit) break;

    lines.push(registeredLines[index]);
    includedRegistered = nextIncluded;
  }

  const omittedRegistered =
    registeredLines.length - includedRegistered;
  const footer = buildOverflowFooter(
    omittedRegistered,
    deregisteredNames.length
  );

  let content = [...lines, ...footer].join('\n');
  if (content.length <= limit) return content;

  const suffix = '\n… output truncated safely.';
  return (
    content.slice(0, Math.max(0, limit - suffix.length)) +
    suffix
  );
}

async function renderEventContent(guild, eventRecord, config) {
  const eventName = escapeMarkdown(
    String(eventRecord.eventName || 'event')
  );
  const header =
    `**Registered players for ${eventName}** ` +
    `${eventRecord.eventStatus}:`;

  const subscribedUsers = Object.values(
    eventRecord.subscribedUsers || {}
  ).sort(
    (left, right) => left.timestamp - right.timestamp
  );

  const registeredLines = [];
  let count = 1;

  for (const record of subscribedUsers) {
    const member = await resolveGuildMember(
      guild,
      record.userId
    );

    if (member) {
      record.lastKnownUsername = member.user.username;
      record.lastKnownDisplayName = member.displayName;
    }

    registeredLines.push(
      `${count}. ${formatUserDisplay({
        member,
        record,
        mode: config.userDisplayMode,
      })}`
    );
    count += 1;
  }

  const deregisteredNames = [];

  for (const record of Object.values(
    eventRecord.unsubscribedUsers || {}
  )) {
    const member = await resolveGuildMember(
      guild,
      record.userId
    );

    if (member) {
      record.lastKnownUsername = member.user.username;
      record.lastKnownDisplayName = member.displayName;
    }

    deregisteredNames.push(
      formatUserDisplay({
        member,
        record,
        mode: config.userDisplayMode,
      })
    );
  }

  return fitEventContent(
    header,
    registeredLines,
    deregisteredNames
  );
}

async function upsertEventMessage(
  channel,
  eventRecord,
  content
) {
  if (eventRecord.messageId) {
    try {
      const message = await channel.messages.fetch(
        eventRecord.messageId
      );

      if (message.content !== content) {
        await message.edit(content);
      }

      return { message, created: false };
    } catch (error) {
      if (!isUnknownMessageError(error)) {
        throw error;
      }

      logWarn(
        `Tracked Discord message ${eventRecord.messageId} no longer exists; recreating it.`,
        {
          source: 'scheduledEvents',
          messageId: eventRecord.messageId,
        }
      );
    }
  }

  const message = await channel.send(content);
  eventRecord.messageId = message.id;

  return { message, created: true };
}

async function reconcileRemovedEvents(
  guild,
  channel,
  eventData,
  fetchedEventIds,
  config
) {
  let changed = false;

  for (const [eventId, eventRecord] of Object.entries(
    eventData
  )) {
    if (fetchedEventIds.has(eventId)) continue;

    eventRecord.missingEventPolls =
      Number(eventRecord.missingEventPolls || 0) + 1;
    changed = true;

    if (
      eventRecord.missingEventPolls <
      config.missingEventGraceCycles
    ) {
      logDebug(
        `Event ${eventId} absent from fetch (${eventRecord.missingEventPolls}/${config.missingEventGraceCycles}); waiting before removal.`,
        { source: 'scheduledEvents', eventId }
      );
      continue;
    }

    eventRecord.eventStatus = '(past event)';
    const content = await renderEventContent(
      guild,
      eventRecord,
      config
    );
    await upsertEventMessage(
      channel,
      eventRecord,
      content
    );

    delete eventData[eventId];

    logInfo(
      `Marked removed event ${eventId} as past after ${config.missingEventGraceCycles} consecutive missing polls.`,
      {
        source: 'scheduledEvents',
        eventId,
      }
    );
  }

  return changed;
}

async function reconcileSingleEvent(
  guild,
  channel,
  event,
  eventData,
  config
) {
  const eventId = event.id;
  const statusLabel = getStatusLabel(event.status);

  const record = eventData[eventId] || {
    eventName: event.name,
    eventMessage:
      `**Registered players for ${event.name}** `,
    eventStatus: statusLabel,
    messageId: '',
    subscribedUsers: {},
    unsubscribedUsers: {},
    missingEventPolls: 0,
  };

  let changed = !eventData[eventId];
  eventData[eventId] = record;

  if (record.missingEventPolls) {
    record.missingEventPolls = 0;
    changed = true;
  }

  if (record.eventName !== event.name) {
    record.eventName = event.name;
    record.eventMessage =
      `**Registered players for ${event.name}** `;
    changed = true;
  }

  if (record.eventStatus !== statusLabel) {
    logInfo(
      `Event ${eventId} "${event.name}" status changed to ${statusLabel}.`,
      {
        source: 'scheduledEvents',
        eventId,
        eventStatus: statusLabel,
      }
    );
    record.eventStatus = statusLabel;
    changed = true;
  }

  let fetchFailed = false;
  let rawUsers = [];

  try {
    rawUsers = await fetchSubscribedUsers(
      config.guildId,
      eventId
    );
  } catch (error) {
    fetchFailed = true;
    await logError(
      'scheduledEvents.fetchSubscribedUsers',
      error,
      {
        eventId,
        eventName: event.name,
      }
    );
  }

  if (!fetchFailed) {
    const currentUsersById = new Map();

    for (const rawUser of rawUsers) {
      if (!rawUser?.user?.id) continue;
      currentUsersById.set(
        String(rawUser.user.id),
        rawUser
      );
    }

    logDebug(
      `Event ${eventId} "${event.name}": status=${event.status}, fetchedUsers=${currentUsersById.size}, storedSubscribed=${Object.keys(record.subscribedUsers).length}, storedUnsubscribed=${Object.keys(record.unsubscribedUsers).length}`,
      { source: 'scheduledEvents', eventId }
    );

    for (const [userId, rawUser] of currentUsersById.entries()) {
      const continuouslySubscribed =
        selectContinuousSubscriberRecord(record, userId);
      const wasUnsubscribed = Boolean(
        record.unsubscribedUsers[userId]
      );

      const nextRecord = toSubscriberRecord(
        rawUser,
        continuouslySubscribed
      );

      if (!continuouslySubscribed || wasUnsubscribed) {
        changed = true;
      }

      record.subscribedUsers[userId] = nextRecord;
      delete record.unsubscribedUsers[userId];
    }

    for (const [userId, existing] of Object.entries(
      record.subscribedUsers
    )) {
      if (currentUsersById.has(userId)) {
        if (existing.apiCheckCounter !== 0) {
          existing.apiCheckCounter = 0;
          changed = true;
        }
        continue;
      }

      existing.apiCheckCounter =
        Number(existing.apiCheckCounter || 0) + 1;
      changed = true;

      if (
        existing.apiCheckCounter <
        config.unsubscribeGraceCycles
      ) {
        logDebug(
          `Pending removal for event ${eventId}: ${userId} apiCheckCounter=${existing.apiCheckCounter}/${config.unsubscribeGraceCycles}`,
          {
            source: 'scheduledEvents',
            eventId,
            userId,
          }
        );
        continue;
      }

      record.unsubscribedUsers[userId] = {
        userId,
        lastKnownUsername:
          existing.lastKnownUsername,
        lastKnownDisplayName:
          existing.lastKnownDisplayName,
        timestamp: Date.now(),
      };

      delete record.subscribedUsers[userId];
      changed = true;
    }
  } else {
    logWarn(
      `Using cached subscriber state for event ${eventId} "${event.name}" because subscriber fetch failed.`,
      {
        source: 'scheduledEvents',
        eventId,
      }
    );
  }

  const content = await renderEventContent(
    guild,
    record,
    config
  );
  const { created } = await upsertEventMessage(
    channel,
    record,
    content
  );

  return changed || created;
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
      const guild = await getGuildOrThrow(
        client,
        config.guildId
      );
      const channel = await getTextChannelOrThrow(
        client,
        config.channelId
      );
      const events =
        await guild.scheduledEvents.fetch();

      logDebug(
        `Fetched ${events.size} scheduled event(s).`,
        { source: 'scheduledEvents.tick' }
      );

      let changed = await reconcileRemovedEvents(
        guild,
        channel,
        eventData,
        new Set(
          events.map((event) => event.id)
        ),
        config
      );

      for (const event of events.values()) {
        changed =
          (await reconcileSingleEvent(
            guild,
            channel,
            event,
            eventData,
            config
          )) || changed;
      }

      if (changed) {
        await saveEvents();
      }
    } catch (error) {
      await logError(
        'scheduledEvents.tick',
        error
      );
    } finally {
      isRunning = false;

      if (isStarted) {
        const interval =
          Object.keys(eventData).length > 0
            ? config.activeEventPollIntervalMs
            : config.eventPollIntervalMs;

        timer = setTimeout(() => {
          tick().catch((error) => {
            logError(
              'scheduledEvents.tick.timer',
              error
            ).catch(() => {});
          });
        }, interval);
        timer.unref?.();
      }
    }
  }

  return {
    start() {
      if (isStarted) return;
      isStarted = true;
      tick().catch((error) => {
        logError(
          'scheduledEvents.tick.start',
          error
        ).catch(() => {});
      });
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
  fitEventContent,
  upsertEventMessage,
  isUnknownMessageError,
  selectContinuousSubscriberRecord,
  reconcileRemovedEvents,
  reconcileSingleEvent,
};
