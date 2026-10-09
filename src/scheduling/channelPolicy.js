'use strict';

const { PermissionFlagsBits } = require('discord.js');

const CHANNELS = Object.freeze({
  guildId: '199916140183420928',
  mod: '332572234885365766',
  league: '387323214105411599',
  public: '343084103228456970',
});
const SNOWFLAKE = /^\d{15,22}$/;

function assertRule(condition, message, status = 403) {
  if (!condition) throw Object.assign(new Error(message), { status });
}

function getRoleIds(source) {
  return String(source || '').split(',').map(x => x.trim()).filter(Boolean);
}

function configureChannelPolicy(options, env = process.env) {
  const guildId = String(options.guildId || '');
  assertRule(guildId === CHANNELS.guildId,
    'WinterBot scheduling is restricted to its configured Official Crashday Discord server.', 400);
  const modChannelId = String(env.SCHEDULING_MOD_CHANNEL_ID || CHANNELS.mod);
  const leagueChannelId = String(env.SCHEDULING_LEAGUE_CHANNEL_ID || CHANNELS.league);
  const publicChannelId = String(env.SCHEDULING_PUBLIC_CHANNEL_ID || CHANNELS.public);
  const logChannelId = String(options.logChannelId || '');
  const managementRoleId = String(env.SCHEDULING_MANAGEMENT_ROLE_ID || '').trim();
  const verifiedRoleIds = getRoleIds(env.SCHEDULING_VERIFIED_ROLE_IDS);
  const allowed = [modChannelId, leagueChannelId, publicChannelId, logChannelId];
  assertRule(allowed.every(x => SNOWFLAKE.test(x)) && new Set(allowed).size === 4,
    'Scheduling requires four distinct, valid channels: Mod, League, Public and #bot-logs.', 400);
  if (!options.demo) {
    assertRule(SNOWFLAKE.test(managementRoleId), 'SCHEDULING_MANAGEMENT_ROLE_ID must be configured before live scheduling.', 400);
    assertRule(verifiedRoleIds.length === 2 && verifiedRoleIds.every(x => SNOWFLAKE.test(x)) &&
      verifiedRoleIds[0] !== verifiedRoleIds[1],
      'SCHEDULING_VERIFIED_ROLE_IDS needs BOTH verified/checkmark role IDs before live scheduling.', 400);
    assertRule(managementRoleId !== verifiedRoleIds[0] && managementRoleId !== verifiedRoleIds[1],
      'Management and verification roles must have different IDs.', 400);
  }
  return {
    guildId, modChannelId, leagueChannelId, publicChannelId, logChannelId,
    managementRoleId, verifiedRoleIds,
  };
}

function roleHas(member, roleId) {
  if (!roleId) return false;
  return Boolean(member?.roles?.cache?.has(roleId) ||
    (Array.isArray(member?.roles) && member.roles.includes(roleId)));
}

function isOrganizerMember(member, policy, guildOwnerId) {
  return Boolean(member && (
    String(guildOwnerId || member.guild?.ownerId || '') === String(member.id || member.user?.id) ||
    roleHas(member, policy.managementRoleId)
  ));
}

function isVerifiedMember(member, policy) {
  return Boolean(member && policy.verifiedRoleIds.length === 2 &&
    policy.verifiedRoleIds.every(id => roleHas(member, id)));
}

function destinationFor(round, policy) {
  const destination = round?.destination || 'league';
  assertRule(['league', 'public'].includes(destination), 'Invalid scheduling destination.', 400);
  const plannedId = destination === 'public' ? policy.publicChannelId : policy.leagueChannelId;
  const channelId = round?.testMode === true ? policy.logChannelId : plannedId;
  if (round?.submissionChannelId && round?.testMode !== true) {
    assertRule(round.submissionChannelId === plannedId,
      'Submission destination must be the configured League or Public channel.', 400);
  }
  return { destination, channelId, testMode: round?.testMode === true };
}

function memberCanSee(member, channel) {
  return Boolean(channel?.permissionsFor?.(member)?.has(PermissionFlagsBits.ViewChannel));
}

function validateMemberAccess(member, policy, channel) {
  assertRule(isVerifiedMember(member, policy),
    'Both verification/checkmark roles are required to participate in this planning round.');
  assertRule(memberCanSee(member, channel),
    'You must have access to the scheduling invitation channel to participate.');
}

function mayUseSetupInteraction(interaction, policy, testMode = false) {
  const expectedChannel = testMode ? policy.logChannelId : policy.modChannelId;
  assertRule(interaction.guildId === policy.guildId && interaction.channelId === expectedChannel,
    testMode ? 'Scheduling TEST commands are available only in #bot-logs.' :
      'WinterBot scheduling commands are available only in the Management/mod channel.');
  assertRule(isOrganizerMember(interaction.member, policy, interaction.guild?.ownerId),
    'Only members with the Management role may create or manage scheduling rounds.');
}

async function validateBotChannels(client, policy, options = {}) {
  const guild = await client.guilds.fetch(policy.guildId);
  for (const [name, id] of [
    ['Mod', policy.modChannelId], ['League', policy.leagueChannelId],
    ['Public', policy.publicChannelId], ['Bot logs', policy.logChannelId],
  ]) {
    if (options.testMode && name !== 'Bot logs') continue;
    const channel = await guild.channels.fetch(id);
    assertRule(channel?.guildId === policy.guildId && channel.isTextBased?.(),
      name + ' channel was not found or is not a suitable guild text channel.', 400);
    const permissions = channel.permissionsFor?.(client.user);
    assertRule(permissions?.has(PermissionFlagsBits.ViewChannel),
      'WinterBot lacks View Channel in ' + name + '.', 400);
    if (name === 'League' || name === 'Public' || name === 'Bot logs') {
      assertRule(permissions?.has(PermissionFlagsBits.SendMessages) &&
        permissions?.has(PermissionFlagsBits.EmbedLinks) &&
        permissions?.has(PermissionFlagsBits.ReadMessageHistory),
        'WinterBot needs Send Messages, Read Message History and Embed Links in ' + name + '.', 400);
    }
  }
  if (!options.skipRoles) {
    for (const id of [policy.managementRoleId, ...policy.verifiedRoleIds]) {
      const role = await guild.roles.fetch(id);
      assertRule(role && role.guild.id === policy.guildId,
        'A configured Management or verified/checkmark role could not be found in this Discord server.', 400);
    }
  }
  return guild;
}

module.exports = {
  CHANNELS, configureChannelPolicy, getRoleIds, roleHas, isOrganizerMember,
  isVerifiedMember, memberCanSee, destinationFor, validateMemberAccess, mayUseSetupInteraction,
  validateBotChannels, assertRule,
};
