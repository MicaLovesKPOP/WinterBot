'use strict';

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, MessageFlags,
} = require('discord.js');
const { mayUseSetupInteraction } = require('./channelPolicy');

const COMMAND = 'schedule';
const BLUE = 0x829de9;
function commandDefinition() {
  return new SlashCommandBuilder()
    .setName(COMMAND)
    .setDescription('Manage WinterBot availability scheduling')
    .setDMPermission(false)
    .addSubcommand(s=>s.setName('create').setDescription('Set up dates and invite verified members'))
    .addSubcommand(s=>s.setName('manage').setDescription('Review availability, votes and event options'))
    .addSubcommand(s=>s.setName('status').setDescription('View recent scheduling rounds'));
}
function wizardResponse(baseUrl, testMode = false) {
  const embed=new EmbedBuilder()
    .setColor(BLUE)
    .setAuthor({name:'WINTERBOT • MANAGEMENT'})
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
    .setAuthor({name:'WINTERBOT • MANAGEMENT'})
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
  let initialized=false;
  const handler=async interaction=>{
    if(!interaction.isChatInputCommand?.() || interaction.commandName!==COMMAND) return;
    try {
      mayUseSetupInteraction(interaction,policy,context.testMode===true);
      const cmd=interaction.options.getSubcommand();
      if(cmd==='create') await interaction.reply(wizardResponse(context.baseUrl,context.testMode===true));
      else if(cmd==='manage' || cmd==='status') {
        await interaction.reply(manageResponse(context.baseUrl,store.read().rounds));
      } else await interaction.reply({content:'Unknown scheduling action.',flags:MessageFlags.Ephemeral});
    } catch(error) {
      await interaction.reply({
        content:String(error.message || 'Scheduling is temporarily unavailable.').slice(0,350),
        flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]},
      }).catch(e=>logger('Scheduling command reply failed:',e));
    }
  };
  async function initialize() {
    if(initialized) return;
    const guild=await client.guilds.fetch(policy.guildId);
    await guild.commands.create(commandDefinition().toJSON());
    client.on('interactionCreate',handler);
    initialized=true;
  }
  function stop() {
    if(initialized) client.off('interactionCreate',handler);
    initialized=false;
  }
  return {initialize,stop,onInteraction:handler,commandDefinition};
}

module.exports = {commandDefinition,wizardResponse,manageResponse,attachSchedulingCommands};
