'use strict';

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, MessageFlags,
} = require('discord.js');
const { mayUseSetupInteraction } = require('./channelPolicy');

const COMMAND = 'schedule';
const BLUE = 0x829de9;
function commandDefinition(testMode = false) {
  const command = new SlashCommandBuilder()
    .setName(COMMAND)
    .setDescription('Manage WinterBot availability scheduling')
    .setDMPermission(false)
    .addSubcommand(s=>s.setName('create').setDescription('Set up dates and invite verified members'))
    .addSubcommand(s=>s.setName('manage').setDescription('Review availability, votes and event options'))
    .addSubcommand(s=>s.setName('status').setDescription('View recent scheduling rounds'));
  if (testMode) {
    command.addSubcommand(s=>s.setName('preview')
      .setDescription('[TEST ONLY] Post a native Discord availability UX invitation')
      .addIntegerOption(o=>o.setName('weeks_ahead')
        .setDescription('Additional weeks after next Monday (0-8)').setMinValue(0).setMaxValue(8)));
    command.addSubcommand(s=>s.setName('preview-event')
      .setDescription('[TEST ONLY] Try graceful event shutdown controls'));
  }
  return command;
}
function wizardResponse(baseUrl, testMode = false) {
  const embed=new EmbedBuilder()
    .setColor(BLUE)
    .setAuthor({name:'WINTERBOT | MANAGEMENT'})
    .setTitle(testMode ? '[TEST] Create a scheduling round' : 'Create a scheduling round')
    .setDescription('Use the setup wizard to choose dates, optional time restrictions per date, an event-duration range and the member channel.')
    .addFields(
      {name:'For organizers',value:'Setup and final approvals stay in this Management channel.',inline:false},
      {name:'For participants',value:testMode
        ? 'TEST MODE: member invitations and final simulated event announcements go exclusively to #bot-logs. No real events are created.'
        : 'League receives one availability invitation by default. You can choose Public instead; only members with both verification roles can submit.',inline:false},
      {name:'For bot logs',value:'Operational errors and audit messages stay in #bot-logs.',inline:false}
    );
  const button=new ButtonBuilder().setLabel('Open setup wizard')
    .setStyle(ButtonStyle.Link).setURL(baseUrl.replace(/\/$/,'')+'/?view=new');
  return {embeds:[embed],components:[new ActionRowBuilder().addComponents(button)],
    flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}};
}
function manageResponse(baseUrl, rounds) {
  const embed=new EmbedBuilder().setColor(BLUE)
    .setAuthor({name:'WINTERBOT | MANAGEMENT'})
    .setTitle('Scheduling control center')
    .setDescription('Review availability, choose proposed times, optionally open voting and approve Discord Scheduled Events.');
  const recent=rounds.slice(-5).reverse();
  if(recent.length) embed.addFields({
    name:'Recent rounds',
    value:recent.map(r=>'• '+String(r.title).slice(0,60)+' — '+r.phase+' ('+r.participants.length+' participants)').join('\n'),
    inline:false,
  });
  else embed.addFields({name:'Planning rounds',value:'None created yet.',inline:false});
  return {embeds:[embed],components:[new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Open organizer board').setStyle(ButtonStyle.Link)
      .setURL(baseUrl.replace(/\/$/,'')+'/?view=organizer')
  )],flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}};
}

function attachSchedulingCommands(client, store, context, {logger=console.error}={}) {
  const policy=context.policy;
  const testMode=context.testMode===true;
  const native = testMode ? require('./nativePrototype').createNativePrototype({
    policy, testMode:true, logger,
  }) : null;
  let initialized=false;
  let eventTimer=null;
  const handler=async interaction=>{
    if (native && String(interaction.customId || '').startsWith('wbux:')) {
      await native.handle(interaction);
      return;
    }
    if (native && String(interaction.customId || '').startsWith('wbend:')) {
      await native.eventPreview.handle(interaction);
      return;
    }
    if(!interaction.isChatInputCommand?.() || interaction.commandName!==COMMAND) return;
    try {
      mayUseSetupInteraction(interaction,policy,testMode);
      const cmd=interaction.options.getSubcommand();
      if(cmd==='preview' && native) {
        const weeksAhead=interaction.options.getInteger('weeks_ahead') ?? 0;
        await native.startPreview(interaction,weeksAhead);
      } else if(cmd==='preview-event' && native) {
        await native.eventPreview.start(interaction);
      } else if(cmd==='create') await interaction.reply(wizardResponse(context.baseUrl,testMode));
      else if(cmd==='manage' || cmd==='status') {
        await interaction.reply(manageResponse(context.baseUrl,store.read().rounds));
      } else await interaction.reply({content:'Unknown scheduling action.',flags:MessageFlags.Ephemeral});
    } catch(error) {
      const response={
        content:String(error.message || 'Scheduling is temporarily unavailable.').slice(0,350),
        flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]},
      };
      const fn=interaction.deferred||interaction.replied ? interaction.followUp : interaction.reply;
      await fn.call(interaction,response).catch(e=>logger('Scheduling command reply failed:',e));
    }
  };
  async function initialize() {
    if(initialized) return;
    const guild=await client.guilds.fetch(policy.guildId);
    await guild.commands.create(commandDefinition(testMode).toJSON());
    client.on('interactionCreate',handler);
    if(native) {
      eventTimer=setInterval(()=>native.eventPreview.tick(client).catch(e=>logger('TEST event tick failed:',e)),10000);
      eventTimer.unref?.();
    }
    initialized=true;
  }
  function stop() {
    if(initialized) client.off('interactionCreate',handler);
    if(eventTimer) clearInterval(eventTimer);
    eventTimer=null;
    initialized=false;
  }
  return {initialize,stop,onInteraction:handler,commandDefinition,native};
}

module.exports = {commandDefinition,wizardResponse,manageResponse,attachSchedulingCommands};
