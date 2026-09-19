const { PermissionFlagsBits } = require('discord.js');

async function getGuildOrThrow(client, guildId) {
  const cached = client.guilds.cache.get(guildId);
  if (cached) return cached;

  const fetched = await client.guilds.fetch(guildId);
  if (!fetched) {
    throw new Error(`Guild ${guildId} could not be fetched.`);
  }
  return fetched;
}

async function getTextChannelOrThrow(client, channelId) {
  const cached = client.channels.cache.get(channelId);
  const channel = cached || (await client.channels.fetch(channelId));

  if (!channel) {
    throw new Error(`Channel ${channelId} could not be fetched.`);
  }
  if (!channel.isTextBased?.()) {
    throw new Error(`Channel ${channelId} is not text-based.`);
  }

  return channel;
}

async function resolveGuildMember(guild, userId) {
  const cached = guild.members.cache.get(userId);
  if (cached) return cached;

  try {
    return await guild.members.fetch(userId);
  } catch (_) {
    return null;
  }
}

function assertChannelPermissions(channel, user, requirements, label) {
  if (!channel.permissionsFor || !user) return;

  const permissions = channel.permissionsFor(user);
  if (!permissions) {
    throw new Error(`Could not resolve WinterBot permissions for ${label}.`);
  }

  const missing = requirements
    .filter(({ flag }) => !permissions.has(flag))
    .map(({ name }) => name);

  if (missing.length > 0) {
    throw new Error(
      `WinterBot is missing ${missing.join(', ')} in ${label} (${channel.id}).`
    );
  }
}

async function validateConfiguredResources(client, config) {
  const guild = await getGuildOrThrow(client, config.guildId);
  const eventChannel = await getTextChannelOrThrow(client, config.channelId);
  const logChannel = await getTextChannelOrThrow(client, config.logChannelId);

  if (eventChannel.guildId !== guild.id) {
    throw new Error(
      `CHANNEL_ID ${eventChannel.id} is not in configured guild ${guild.id}.`
    );
  }

  if (logChannel.guildId !== guild.id) {
    throw new Error(
      `LOG_CHANNEL_ID ${logChannel.id} is not in configured guild ${guild.id}.`
    );
  }

  const sendRequirements = [
    { flag: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
    { flag: PermissionFlagsBits.ReadMessageHistory, name: 'Read Message History' },
    { flag: PermissionFlagsBits.SendMessages, name: 'Send Messages' },
  ];

  assertChannelPermissions(
    eventChannel,
    client.user,
    sendRequirements,
    'scheduled-event channel'
  );
  assertChannelPermissions(
    logChannel,
    client.user,
    sendRequirements,
    'log channel'
  );

  const moderationRequirements = [
    { flag: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
    { flag: PermissionFlagsBits.ReadMessageHistory, name: 'Read Message History' },
    { flag: PermissionFlagsBits.ManageMessages, name: 'Manage Messages' },
  ];

  const requirementChannels = new Map();
  for (const channelId of Object.keys(config.messageRequirements || {})) {
    const channel = await getTextChannelOrThrow(client, channelId);
    if (!channel.guildId) {
      throw new Error(
        `Message requirements can only target guild channels (${channelId}).`
      );
    }
    requirementChannels.set(channelId, channel);
    assertChannelPermissions(
      channel,
      client.user,
      moderationRequirements,
      'message-requirement channel'
    );
  }

  return {
    guild,
    eventChannel,
    logChannel,
    requirementChannels,
  };
}

module.exports = {
  getGuildOrThrow,
  getTextChannelOrThrow,
  resolveGuildMember,
  validateConfiguredResources,
  assertChannelPermissions,
};
