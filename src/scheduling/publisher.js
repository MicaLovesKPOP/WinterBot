'use strict';

const crypto = require('node:crypto');
const {
  GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown,
} = require('discord.js');
const { advance, getSlot, invariant } = require('./core');
const { DateTime } = require('luxon');

// Serializes publication of the SAME intent in this Node.js process. All
// attempts also reconcile via the persistent marker in the Discord event.
const publicationFlights = new Map();
const announcementFlights = new Map();

function publicationMarker(id) {
  return '[WinterBot scheduling ID: ' + id + ']';
}

function eventDescription(userDescription, marker) {
  // The marker must NEVER be truncated: it is needed to identify a previously
  // created event after a network timeout or process restart.
  const maxText = 1000 - marker.length - 1;
  const text = String(userDescription || '').slice(0, Math.max(0, maxText)).trim();
  return [text, marker].filter(Boolean).join('\n');
}

async function updatePublication(store, roundId, id, change) {
  await store.transaction(state => {
    const round = state.rounds.find(r => r.id === roundId);
    invariant(round, 'Scheduling round no longer exists.');
    const record = round.publications.find(p => p.id === id);
    invariant(record, 'Publication intent no longer exists.');
    Object.assign(record, change);
  });
}

async function createScheduledDiscordEvent(guild, round, publication, marker) {
  const description = eventDescription(round.description, marker);
  const options = {
    name: round.title.slice(0, 100),
    description,
    scheduledStartTime: publication.startAt,
    scheduledEndTime: publication.endAt,
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    reason: 'WinterBot organizer-approved availability schedule',
  };

  if (round.voiceChannelId) {
    const channel = await guild.channels.fetch(round.voiceChannelId);
    invariant(channel && channel.type === ChannelType.GuildVoice,
      'The selected voice channel ID must refer to an ordinary voice channel in this Discord server.');
    options.entityType = GuildScheduledEventEntityType.Voice;
    options.channel = channel.id;
  } else {
    options.entityType = GuildScheduledEventEntityType.External;
    options.entityMetadata = { location: round.location || 'Discord' };
  }
  return guild.scheduledEvents.create(options);
}

async function publishCandidate(store, roundId, candidateId, startAt, context) {
  let publication;
  let roundSnapshot;
  let newIntent = false;

  // This transaction reserves the day before any external Discord call begins.
  await store.transaction(state => {
    const round = state.rounds.find(r => r.id === roundId);
    invariant(round, 'Round not found.');
    advance(round);
    invariant(['review', 'final'].includes(round.phase), 'Candidates cannot be scheduled in this phase.');
    const { candidate, slot } = getSlot(round, candidateId, startAt);
    invariant(Date.parse(slot.startAt) > Date.now() + 60000,
      'The proposed event must start at least one minute in the future.');
    const thisIsTest = round.testMode === true || context.testMode === true;
    for (const r of state.rounds) {
      // Test simulations never reserve a real Discord event calendar date.
      if (r.id !== round.id && (r.testMode === true) !== thisIsTest) continue;
      for (const p of r.publications) {
        if (p.date !== candidate.date) continue;
        if (r.id === round.id && p.candidateId === candidateId && p.startAt === startAt) {
          publication = p;
          roundSnapshot = structuredClone(round);
          return;
        }
        invariant(false, 'WinterBot already has an event or pending publication on this date. Only one event per day is allowed.');
      }
    }
    publication = {
      id: crypto.randomUUID(), candidateId, date: candidate.date,
      startAt: slot.startAt, endAt: slot.endAt, status: 'pending',
      eventId: null, eventUrl: null, error: null, requestedAt: new Date().toISOString(),
    };
    round.publications.push(publication);
    roundSnapshot = structuredClone(round);
    newIntent = true;
  });

  if (publication.status === 'created' || publication.status === 'simulated') return publication;

  // A second HTTP request arriving before the first has returned must join
  // the existing operation, not start another create request.
  const existingFlight = publicationFlights.get(publication.id);
  if (existingFlight) return existingFlight;

  const flight = (async () => {
    try {
      let eventId;
      let eventUrl;
      const simulated = !context.demo && (context.testMode === true || roundSnapshot.testMode === true);
      if (context.demo || simulated) {
        eventId = context.demo ? 'demo-' + publication.id : null;
        eventUrl = null;
      } else {
        const guild = await context.client.guilds.fetch(context.guildId);
        const marker = publicationMarker(publication.id);
        const events = await guild.scheduledEvents.fetch();
        let event = events.find(e => String(e.description || '').includes(marker));
        if (!event) {
          const conflictingEvent = events.find(e => {
            if (!String(e.description || '').includes('[WinterBot scheduling ID: ')) return false;
            const timestamp = Number(e.scheduledStartTimestamp) || new Date(e.scheduledStartAt).getTime();
            return Number.isFinite(timestamp) &&
              DateTime.fromMillis(timestamp).setZone(roundSnapshot.timezone).toISODate() === publication.date;
          });
          invariant(!conflictingEvent, 'Discord already has another WinterBot-created event on this date. Resolve it before scheduling another.');
        }

        // An unacknowledged prior attempt may have succeeded even though
        // WinterBot never received a confirmation. Reconcile first; without
        // explicit operator confirmation, never blindly retry the create.
        if (!event && !newIntent && context.confirmedRetry !== true) {
          throw new Error(
            'A previous Discord creation request may have succeeded. ' +
            'Check the Discord Scheduled Events list, then explicitly confirm a retry if no matching event exists.'
          );
        }

        if (!event) event = await createScheduledDiscordEvent(guild, roundSnapshot, publication, marker);
        eventId = String(event.id);
        eventUrl = 'https://discord.com/events/' + context.guildId + '/' + eventId;
      }

      await updatePublication(store, roundId, publication.id, {
        eventId, eventUrl,
        status: (!context.demo && (context.testMode === true || roundSnapshot.testMode === true)) ? 'simulated' : 'created',
        error: null, createdAt: new Date().toISOString(),
      });
      return store.read().rounds.find(r => r.id === roundId)
        .publications.find(p => p.id === publication.id);
    } catch (error) {
      await updatePublication(store, roundId, publication.id, {
        status: 'needs_attention',
        error: String(error.message || error).slice(0, 300),
      });
      throw error;
    }
  })();

  publicationFlights.set(publication.id, flight);
  try {
    return await flight;
  } finally {
    if (publicationFlights.get(publication.id) === flight) publicationFlights.delete(publication.id);
  }
}

async function performRoundPanel(store, roundId, context) {
  invariant(!context.demo, 'Demo mode never posts to Discord.');
  const snapshot = store.read().rounds.find(r => r.id === roundId);
  invariant(snapshot, 'Round not found.');
  const guild = await context.client.guilds.fetch(context.guildId);
  const channel = await guild.channels.fetch(context.channelId);
  invariant(channel?.isTextBased(), 'WinterBot channel is unavailable.');
  const link = context.baseUrl.replace(/\/$/, '') + '/?round=' + encodeURIComponent(roundId);
  const phase = snapshot.phase;
  const header = '**' + escapeMarkdown(snapshot.title) + '**';
  const deadline = phase === 'collecting' ? snapshot.collectionClosesAt :
    phase === 'voting' ? snapshot.ballot.closesAt : null;
  const publishedCount = snapshot.publications.filter(p => p.status === 'created').length;
  const description = publishedCount
    ? publishedCount + ' approved event(s) have been scheduled. You can view the latest results below.'
    : phase === 'collecting' ? 'Enter or edit your availability.' :
      phase === 'voting' ? 'Voting is open on the proposed times.' :
        phase === 'review' ? 'Availability collection is closed; the organizer is reviewing options.' :
          'Voting is closed; the organizer is finalizing the schedule.';
  const messageContent = header + '\n' + description +
    (deadline ? '\nCloses <t:' + Math.floor(Date.parse(deadline) / 1000) + ':R>.' : '') +
    '\n' + snapshot.startDate + ' to ' + snapshot.endDate + ' (' + snapshot.timezone + ')';
  const label = phase === 'collecting' ? 'Set availability' : phase === 'voting' ? 'Vote on times' : 'View schedule';
  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(link)
  )];
  let message = null;
  if (snapshot.announcementMessageId) {
    try {
      message = await channel.messages.fetch(snapshot.announcementMessageId);
      await message.edit({ content: messageContent, components, allowedMentions: { parse: [] } });
    } catch (error) {
      if (Number(error.code) !== 10008) throw error;
      message = null;
    }
  }
  if (!message) {
    message = await channel.send({ content: messageContent, components, allowedMentions: { parse: [] } });
    await store.transaction(state => {
      const round = state.rounds.find(r => r.id === roundId);
      round.announcementMessageId = message.id;
    });
  }
  return { messageId: message.id, url: link };
}

async function postRoundPanel(store, roundId, context) {
  const active = announcementFlights.get(roundId);
  if (active) return active;
  const flight = performRoundPanel(store, roundId, context);
  announcementFlights.set(roundId, flight);
  try {
    return await flight;
  } finally {
    if (announcementFlights.get(roundId) === flight) announcementFlights.delete(roundId);
  }
}

module.exports = { publishCandidate, postRoundPanel, eventDescription, publicationMarker };
