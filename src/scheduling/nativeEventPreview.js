'use strict';

// TEST-ONLY event lifecycle controls: no Discord roles, channels, scheduled
// events, or production registration records are created or modified.
const crypto=require('node:crypto');
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, MessageFlags,
}=require('discord.js');
const {isOrganizerMember}=require('./channelPolicy');
const {GRACE_MINUTES,DEFAULT_GRACE_MINUTES,assert}=require('./nativePrototypeState');

const name=id=>'wbend:'+id;
const makeButton=(id,label,style=ButtonStyle.Secondary)=>new ButtonBuilder()
  .setCustomId(name(id)).setLabel(label).setStyle(style);
const row=(...components)=>new ActionRowBuilder().addComponents(...components);

function eventPanel(event) {
  const running=event.status==='running', grace=event.status==='grace';
  const due=grace?Math.floor(Date.parse(event.dueAt)/1000):null;
  const status=running?'**Running — overtime allowed**\nOnly a moderator can start shutdown.':
    grace?'**Wrapping up**\nEvent closes <t:'+due+':R> (at <t:'+due+':T>).\nNo new check-ins during the grace period.':
      '**Closed**\nThis was a simulated event; nothing was deleted or unlocked.';
  const embeds=[new EmbedBuilder().setColor(running?0x43b581:grace?0xe3ad38:0x72849d)
    .setAuthor({name:'WINTERBOT | TEST EVENT LIFECYCLE'})
    .setTitle('[TEST] Game Night — '+(running?'In Progress':grace?'Wrapping Up':'Ended'))
    .setDescription(status+'\n\nGrace period: **'+event.graceMinutes+' minute(s)**.'+
      '\n\nNo real event, roles, check-ins or channels are affected.')
    .setFooter({text:'TEST ONLY | Bot logs channel'})];
  const components=[];
  if(running) {
    components.push(row(new StringSelectMenuBuilder()
      .setCustomId(name('duration:'+event.id))
      .setPlaceholder('Grace period')
      .setOptions(GRACE_MINUTES.map(n=>({
        label:n===DEFAULT_GRACE_MINUTES?'5 minutes (default)':n===0?'0 minutes (immediate)':n+' minute(s)',
        value:String(n),default:event.graceMinutes===n,
      })))));
    components.push(row(makeButton('end:'+event.id,'End Event (Start Grace Period)',ButtonStyle.Primary)));
  } else if(grace && !event.confirmNow) {
    components.push(row(
      makeButton('extend1:'+event.id,'Add 1 minute'),
      makeButton('extend5:'+event.id,'Add 5 minutes')
    ));
    components.push(row(
      makeButton('cancel:'+event.id,'Cancel Ending',ButtonStyle.Secondary),
      makeButton('asknow:'+event.id,'End Now',ButtonStyle.Danger)
    ));
  } else if(grace && event.confirmNow) {
    embeds[0].addFields({name:'Confirm immediate closure',value:'End this TEST event now, without waiting for the grace period?'});
    components.push(row(
      makeButton('now:'+event.id,'Confirm End Now',ButtonStyle.Danger),
      makeButton('keep:'+event.id,'Keep Countdown')
    ));
  }
  return {embeds,components,allowedMentions:{parse:[]}};
}

function createEventPreview({store,policy,logger=console.error}) {
  function assertManager(interaction) {
    assert(interaction.guildId===policy.guildId && interaction.channelId===policy.logChannelId,
      'Event lifecycle previews only run in #bot-logs.');
    assert(isOrganizerMember(interaction.member,policy,interaction.guild?.ownerId),
      'Only moderators can control the event.');
  }
  async function start(interaction) {
    assertManager(interaction);
    let event;
    await store.transaction(state=>{
      state.events ||= {};
      event={
        id:crypto.randomBytes(6).toString('hex'), status:'running',
        graceMinutes:DEFAULT_GRACE_MINUTES, dueAt:null,confirmNow:false,
        createdAt:new Date().toISOString(),messageId:null,
      };
      state.events[event.id]=event;
    });
    await interaction.reply(eventPanel(event));
    if (interaction.fetchReply) {
      try {
        const message=await interaction.fetchReply();
        if(message?.id) await store.transaction(state=>{state.events[event.id].messageId=message.id;});
      } catch(err) { logger('Preview message ID not captured:',err.message); }
    }
    return event;
  }
  async function handle(interaction) {
    if(!String(interaction.customId||'').startsWith('wbend:')) return false;
    try {
      assertManager(interaction);
      const [prefix,action,id]=interaction.customId.split(':');
      assert(prefix==='wbend'&&/^[a-f0-9]{12}$/.test(id),'Invalid test event.');
      let current;
      await store.transaction(state=>{
        const e=state.events?.[id];
        assert(e,'TEST event not found.');
        if(action==='duration') {
          assert(e.status==='running','The grace period cannot be changed after shutdown begins.');
          const n=Number(interaction.values?.[0]);
          assert(GRACE_MINUTES.includes(n),'Invalid grace period.');
          e.graceMinutes=n;
        } else if(action==='end') {
          assert(e.status==='running','This event is already closing.');
          e.status=e.graceMinutes===0?'ended':'grace';
          e.dueAt=e.graceMinutes===0?null:new Date(Date.now()+e.graceMinutes*60000).toISOString();
        } else if(action==='extend1'||action==='extend5') {
          assert(e.status==='grace','This event is not wrapping up.');
          e.dueAt=new Date(Math.max(Date.now(),Date.parse(e.dueAt))+
            (action==='extend1'?1:5)*60000).toISOString();
          e.confirmNow=false;
        } else if(action==='cancel') {
          assert(e.status==='grace','There is no active shutdown to cancel.');
          e.status='running';e.dueAt=null;e.confirmNow=false;
        } else if(action==='asknow') {
          assert(e.status==='grace','This event is not wrapping up.');
          e.confirmNow=true;
        } else if(action==='keep') {
          assert(e.status==='grace','This event is not wrapping up.');
          e.confirmNow=false;
        } else if(action==='now') {
          assert(e.status==='grace'&&e.confirmNow===true,'Confirm immediate closure first.');
          e.status='ended';e.dueAt=null;e.confirmNow=false;
        } else throw new Error('Unknown event action.');
        current=structuredClone(e);
      });
      await interaction.update(eventPanel(current));
    } catch(error) {
      try {await interaction.reply({
        content:'WinterBot TEST: '+String(error.message||error).slice(0,250),
        flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]},
      });}catch(replyError){logger('Event preview interaction failed:',replyError);}
    }
    return true;
  }
  async function tick(client) {
    const due=Object.values(store.read().events||{}).some(e=>
      e.status==='grace'&&Date.parse(e.dueAt)<=Date.now());
    if(!due) return;
    let closed=[];
    await store.transaction(state=>{
      for(const e of Object.values(state.events||{})) {
        if(e.status==='grace'&&Date.parse(e.dueAt)<=Date.now()) {
          e.status='ended';e.dueAt=null;e.confirmNow=false;
          closed.push(structuredClone(e));
        }
      }
    });
    if(!closed.length) return;
    try {
      const channel=await client.channels.fetch(policy.logChannelId);
      for(const e of closed) {
        if(!e.messageId) continue;
        try {
          const message=await channel.messages.fetch(e.messageId);
          await message.edit(eventPanel(e));
        } catch(error) {logger('TEST shutdown panel could not be updated:',error);}
      }
    } catch(error) {logger('TEST shutdown channel not accessible:',error);}
  }
  return {start,handle,tick};
}
module.exports={createEventPreview,eventPanel};