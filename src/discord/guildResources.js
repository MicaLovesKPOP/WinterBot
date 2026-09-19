async function getGuildOrThrow(client, guildId) {
  const cached = client.guilds.cache.get(guildId);
  if (cached) return cached;

  const fetched = await client.guilds.fetch(guildId);
  if (!fetched) throw new Error(`Guild ${guildId} could not be fetched.`);
  return fetched;
}

async function getTextChannelOrThrow(client, channelId) {
  const cached = client.channels.cache.get(channelId);
  if (cached) return cached;

  const fetched = await client.channels.fetch(channelId);
  if (!fetched) throw new Error(`Channel ${channelId} could not be fetched.`);
  return fetched;
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

module.exports = {
  getGuildOrThrow,
  getTextChannelOrThrow,
  resolveGuildMember,
};