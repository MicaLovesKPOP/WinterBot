'use strict';

const crypto = require('node:crypto');
const {
  GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown,
} = require('discord.js');
const { advance, getSlot, invariant } = require('./core');

async function publishCandidate(store, roundId, candidateId, startAt, context) {
  let publication;
  let roundSnapshot;
  await store.transaction(state => {
    const round = state.rounds.find(r => r.id === roundId);
    invariant(round, 'Round not found.');
    advance(round);
    invariant(['review', 'final'].includes(round.phase), 'Candidates cannot be scheduled in this phase.');
    const { candidate, slot } = getSlot(round, candidateId, startAt);
    invariant(Date.parse(slot.startAt) > Date.now() + 60000, 'The proposed event must start in the future.');
    for (const r of state.rounds) {
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
  });
  if (publication.status === 'created') return publication;

  try {
    let eventId;
    let eventUrl;
    if (context.demo) {
      eventId = 'demo-' + publication.id;
      eventUrl = null;
    } else {
      const guild = await context.client.guilds.fetch(context.guildId);
      const marker = '[WinterBot scheduling ID: ' + publication.id + ']';
      const existingEvents = await guild.scheduledEvents.fetch();
      let event = existingEvents.find(e => String(e.description || '').includes(marker));
      if (!event) {
        const description = [roundSnapshot.description, marker].filter(Boolean).join('\n');
        event = await guild.scheduledEvents.create({
          name: roundSnapshot.title.slice(0, 100),
          description: description.slice(0, 1000),
          scheduledStartTime: publication.startAt,
          scheduledEndTime: publication.endAt,
          privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
          entityType: GuildScheduledEventEntityType.External,
          entityMetadata: { location: roundSnapshot.location || 'Discord' },
          reason: 'WinterBot organizer-approved availability schedule',
        });
      }
      eventId = event.id;
      eventUrl = 'https://discord.com/events/' + context.guildId + '/' + eventId;
    }
    await store.transaction(state => {
      const round = state.rounds.find(r => r.id === roundId);
      const record = round.publications.find(p => p.id === publication.id);
      record.eventId = eventId;
      record.eventUrl = eventUrl;
      record.status = 'created';
      record.error = null;
      record.createdAt = new Date().toISOString();
    });
  } catch (error) {
    await store.transaction(state => {
      const round = state.rounds.find(r => r.id === roundId);
      const record = round.publications.find(p => p.id === publication.id);
      record.status = 'needs_attention';
      record.error = String(error.message || error).slice(0, 300);
    });
    throw error;
  }
  return store.read().rounds.find(r => r.id === roundId).publications.find(p => p.id === publication.id);
}

async function postRoundPanel(store, roundId, context) {
  invariant(!context.demo, 'Demo mode never posts to Discord.');
  let snapshot = store.read().rounds.find(r => r.id === roundId);
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

module.exports = { publishCandidate, postRoundPanel };
