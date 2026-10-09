'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, escapeMarkdown,
} = require('discord.js');
const { DateTime } = require('luxon');
const { destinationFor, assertRule } = require('./channelPolicy');

const inflight = new Map();
const COLOR = {
  collecting: 0x829de9,
  review: 0x72849d,
  voting: 0xb09af0,
  final: 0x58b8a5,
};

function safeText(value, max = 180) {
  return escapeMarkdown(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, max);
}
function unixTime(iso) {
  return Math.floor(Date.parse(iso) / 1000);
}
function roundMarker(round) {
  return 'WinterBot planning round • ' + round.id;
}
function publicationMarker(publication) {
  return 'WinterBot event announcement • ' + publication.id;
}
function durationLabel(round) {
  const min = round.minDurationMinutes || round.durationMinutes;
  const max = round.maxDurationMinutes || round.durationMinutes;
  if (min === max) return min + ' minutes';
  return min + '–' + max + ' minutes';
}
function daysSummary(round) {
  const dates = round.selectedDates || [];
  const days = dates.length ? dates : (() => {
    const list = [];
    for (let d = DateTime.fromISO(round.startDate); d <= DateTime.fromISO(round.endDate); d=d.plus({days:1})) list.push(d.toISODate());
    return list;
  })();
  if (days.length > 10) return days.length + ' selected dates • ' +
    safeText(round.startDate, 10) + ' to ' + safeText(round.endDate, 10);
  return days.map(date => {
    const limit = round.dayLimits?.[date];
    const dt=DateTime.fromISO(date, {zone:round.timezone});
    return dt.toFormat('ccc dd LLL') + (limit ? ' · ' + limit.start + '–' + limit.end : '');
  }).join('\n') || 'No dates selected';
}
function buildInvitation(round, baseUrl) {
  assertRule(/^https:\/\//.test(baseUrl), 'Live Discord invitations require a public HTTPS planner URL.', 400);
  const stage = round.phase;
  const st = {
    collecting: { title: 'Set your availability', detail: 'Mark available or unavailable days, and optionally add more than one time window each day.' },
    review: { title: 'Availability collected', detail: 'Submissions are locked. Management is reviewing the times that work for the most people.' },
    voting: { title: 'Vote on proposed times', detail: 'Management has shortlisted some options. Choose the ones you would prefer; you can change your vote before the deadline.' },
    final: { title: 'Planning results', detail: 'Voting is complete. Management is selecting which events to schedule.' },
  }[stage] || { title: 'Event planning', detail: '' };
  const count = round.participants?.length || 0;
  const deadline = stage === 'collecting' ? round.collectionClosesAt :
    stage === 'voting' ? round.ballot?.closesAt : null;
  const embed = new EmbedBuilder()
    .setColor(COLOR[stage] || COLOR.collecting)
    .setAuthor({name:round.testMode ? 'WINTERBOT • PRIVATE TEST MODE' : 'WINTERBOT • COMMUNITY SCHEDULING'})
    .setTitle((round.testMode ? '[TEST] ' : '') + st.title + ' · ' + safeText(round.title, 75))
    .setDescription((round.testMode ? 'Test round: no real Discord events will be created. All scheduling messages remain in #bot-logs.\n\n' : '') + st.detail)
    .addFields(
      {name:'Possible dates & hours',value:daysSummary(round).slice(0,1000),inline:false},
      {name:'Event duration',value:durationLabel(round),inline:true},
      {name:'Time zone',value:safeText(round.timezone,80),inline:true},
      {name:'Responses',value:count ? count + ' participant' + (count===1?'':'s') : 'Open for verified members',inline:true},
    )
    .setFooter({text:roundMarker(round)});
  if (deadline) embed.addFields({
    name:stage==='collecting' ? 'Submit by' : 'Vote by',
    value:'<t:'+unixTime(deadline)+':F> · <t:'+unixTime(deadline)+':R>',
    inline:false,
  });
  const url=baseUrl.replace(/\/$/,'')+'/?round='+encodeURIComponent(round.id);
  const actionText = stage==='collecting'?'Enter availability':
    stage==='voting'?'Vote on times':'View planning status';
  const button = new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(actionText).setURL(url);
  return { embeds:[embed], components:[new ActionRowBuilder().addComponents(button)],
    allowedMentions:{parse:[]} };
}
function buildEventAnnouncement(round, publication) {
  const simulated = round.testMode === true && publication?.status === 'simulated';
  assertRule(simulated || publication?.status === 'created',
    'Only confirmed or simulated events may be announced.', 400);
  const eventUrl=publication.eventUrl;
  if (!simulated) assertRule(/^https:\/\/discord\.com\/events\/\d+\/\d+$/.test(eventUrl),
    'Discord event URL was not confirmed.', 400);
  const candidate=round.candidates.find(c=>c.id===publication.candidateId);
  const dt=DateTime.fromISO(publication.startAt).setZone(round.timezone);
  const end=DateTime.fromISO(publication.endAt).setZone(round.timezone);
  const attendees = candidate?.count || 0;
  const total = round.participants.length;
  const embed = new EmbedBuilder()
    .setColor(simulated ? 0xe1af6f : 0x58b8a5)
    .setAuthor({name:simulated ? 'WINTERBOT • TEST EVENT SIMULATION' : 'WINTERBOT • EVENT CONFIRMED'})
    .setTitle((simulated ? '[TEST ONLY] ' : '') + safeText(round.title,75))
    .setDescription(simulated
      ? 'This is a dry run in #bot-logs. No Discord Scheduled Event has been created and no users have been notified in League or Public.'
      : 'The event has been scheduled in Discord. Open the event to view details and register.')
    .addFields(
      {name:'Date',value:dt.toFormat('cccc, dd LLLL yyyy'),inline:true},
      {name:'Time',value:'<t:'+unixTime(publication.startAt)+':t>–<t:'+unixTime(publication.endAt)+':t>',inline:true},
      {name:'Duration',value:Math.round((Date.parse(publication.endAt)-Date.parse(publication.startAt))/60000)+' minutes',inline:true},
      {name:'Location',value:round.voiceChannelId?'<#'+round.voiceChannelId+'>':safeText(round.location||'Discord',95),inline:true},
      {name:'Availability match',value:attendees+' of '+total+' declared available for the full event',inline:false},
    )
    .setFooter({text:publicationMarker(publication)});
  if (!simulated) embed.setURL(eventUrl);
  return {
    embeds:[embed],
    components:simulated ? [] : [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('View Discord event').setURL(eventUrl)
    )],
    allowedMentions:{parse:[]},
  };
}
async function destinationChannel(context, round) {
  const { channelId }=destinationFor(round,context.policy);
  const guild=await context.client.guilds.fetch(context.policy.guildId);
  const channel=await guild.channels.fetch(channelId);
  assertRule(channel?.guildId===context.policy.guildId && channel.isTextBased?.(),
    'The specified League/Public channel is not accessible.',400);
  const permissions=channel.permissionsFor(context.client.user);
  assertRule(permissions?.has(PermissionFlagsBits.ViewChannel) &&
    permissions?.has(PermissionFlagsBits.SendMessages) &&
    permissions?.has(PermissionFlagsBits.EmbedLinks) &&
    permissions?.has(PermissionFlagsBits.ReadMessageHistory),
    'WinterBot needs View Channel, Send Messages, Read Message History and Embed Links in the selected channel.',400);
  return channel;
}
async function findByMarker(channel, marker) {
  if (!channel.messages?.fetch) return null;
  const latest=await channel.messages.fetch({limit:50});
  return latest.find(m=>m.author?.id===channel.client?.user?.id &&
    m.embeds?.some(e=>e.footer?.text===marker)) || null;
}
async function updateStoredId(store, roundId, publicationId, messageId) {
  await store.transaction(state=>{
    const r=state.rounds.find(x=>x.id===roundId);
    if (!r) throw new Error('Scheduling round disappeared.');
    if (publicationId) {
      const p=r.publications.find(x=>x.id===publicationId);
      if (!p) throw new Error('Publication disappeared.');
      p.eventAnnouncementMessageId=messageId;
      p.eventAnnouncementStatus='sent';
    } else {
      r.announcementMessageId=messageId;
      r.announcementPhase=r.phase;
    }
  });
}
async function upsertMessage(store, roundId, publicationId, context) {
  const round=store.read().rounds.find(r=>r.id===roundId);
  assertRule(round,'Round not found.',404);
  const channel=await destinationChannel(context,round);
  const publication=publicationId?round.publications.find(p=>p.id===publicationId):null;
  if (publicationId) assertRule(publication,'Publication not found.',404);
  const marker=publication?publicationMarker(publication):roundMarker(round);
  const payload=publication?buildEventAnnouncement(round,publication):
    buildInvitation(round,context.baseUrl);
  let message = null;
  const existingId=publication?publication.eventAnnouncementMessageId:round.announcementMessageId;
  if(existingId) {
    try {
      message=await channel.messages.fetch(existingId);
    } catch(error) {
      if(Number(error?.code)!==10008) throw error;
    }
  }
  if(!message) message=await findByMarker(channel,marker);
  if(message) {
    await message.edit(payload);
  } else {
    message=await channel.send(payload);
  }
  await updateStoredId(store,roundId,publicationId,message.id);
  return {messageId:message.id,channelId:channel.id};
}
function singleFlight(key, task) {
  if(inflight.has(key)) return inflight.get(key);
  const promise=Promise.resolve().then(task);
  inflight.set(key,promise);
  promise.finally(()=>{if(inflight.get(key)===promise) inflight.delete(key);}).catch(()=>{});
  return promise;
}
function postSubmissionPanel(store,roundId,context) {
  return singleFlight('panel:'+roundId,()=>upsertMessage(store,roundId,null,context));
}
function postEventAnnouncement(store,roundId,publicationId,context) {
  return singleFlight('event:'+publicationId,()=>upsertMessage(store,roundId,publicationId,context));
}

module.exports = {
  buildInvitation, buildEventAnnouncement, postSubmissionPanel,
  postEventAnnouncement, durationLabel, daysSummary,
};
