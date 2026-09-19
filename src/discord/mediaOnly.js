const { getConfig } = require('../config');
const { logError, logInfo, logWarn } = require('../logging/logger');

const MEDIA_MIME_PREFIXES = ['image/', 'video/', 'audio/'];
const MEDIA_EMBED_TYPES = new Set(['image', 'video', 'gifv']);
const AUDIO_PROVIDER_NAMES = new Set([
  'spotify',
  'soundcloud',
  'bandcamp',
  'apple music',
  'tidal',
  'deezer',
  'mixcloud',
  'audiomack',
]);
const AUDIO_PROVIDER_HOSTS = [
  'spotify.com',
  'soundcloud.com',
  'bandcamp.com',
  'music.apple.com',
  'tidal.com',
  'deezer.com',
  'mixcloud.com',
  'audiomack.com',
];
const URL_PATTERN = /https?:\/\/[^\s<>]+/gi;

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.values === 'function') return Array.from(value.values());
  return Object.values(value);
}

function extractUrls(content) {
  return String(content || '').match(URL_PATTERN) || [];
}

function isMediaAttachment(attachment) {
  const contentType = String(attachment?.contentType || attachment?.content_type || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();

  if (MEDIA_MIME_PREFIXES.some((prefix) => contentType.startsWith(prefix))) {
    return true;
  }

  const hasDimensions =
    Number.isFinite(attachment?.width) &&
    attachment.width > 0 &&
    Number.isFinite(attachment?.height) &&
    attachment.height > 0;

  const hasAudioMetadata =
    (Number.isFinite(attachment?.duration) && attachment.duration > 0) ||
    Boolean(attachment?.waveform);

  return hasDimensions || hasAudioMetadata;
}

function isKnownAudioProvider(provider) {
  if (!provider) return false;

  const name = String(provider.name || '').trim().toLowerCase();
  if (AUDIO_PROVIDER_NAMES.has(name)) return true;

  try {
    const hostname = new URL(provider.url).hostname.toLowerCase().replace(/^www\./, '');
    return AUDIO_PROVIDER_HOSTS.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`)
    );
  } catch (_) {
    return false;
  }
}

function isMediaEmbed(embed) {
  const data = embed?.data || embed || {};
  const type = String(embed?.type || data.type || '').toLowerCase();
  const image = embed?.image || data.image;
  const video = embed?.video || data.video;
  const provider = embed?.provider || data.provider;

  if (MEDIA_EMBED_TYPES.has(type) || isKnownAudioProvider(provider)) return true;

  return Boolean(
    image?.url ||
    image?.proxyURL ||
    image?.proxy_url ||
    video?.url ||
    video?.proxyURL ||
    video?.proxy_url
  );
}

function evaluateMediaOnlyMessage(message) {
  const attachments = toArray(message?.attachments);
  const embeds = toArray(message?.embeds);
  const urls = Array.from(new Set(extractUrls(message?.content)));

  const nonMediaAttachments = attachments.filter((attachment) => !isMediaAttachment(attachment));
  if (nonMediaAttachments.length > 0) {
    return {
      allowed: false,
      reason: 'contains a non-media attachment',
    };
  }

  const mediaAttachments = attachments.filter(isMediaAttachment);
  const mediaEmbeds = embeds.filter(isMediaEmbed);

  if (urls.length > 0) {
    const nonMediaEmbeds = embeds.filter((embed) => !isMediaEmbed(embed));

    if (nonMediaEmbeds.length > 0 || mediaEmbeds.length < urls.length) {
      return {
        allowed: false,
        reason: 'contains a link that did not resolve to an image, video, or audio embed',
      };
    }
  }

  if (mediaAttachments.length === 0 && mediaEmbeds.length === 0) {
    return {
      allowed: false,
      reason: 'does not contain image, video, or audio media',
    };
  }

  return {
    allowed: true,
    reason: null,
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isUnknownMessageError(error) {
  return Number(error?.code || error?.rawError?.code) === 10008;
}

function shouldIgnoreMessage(message, channelIds, botUserId) {
  if (!message?.guildId) return true;
  if (!channelIds.has(String(message.channelId))) return true;
  if (message.system) return true;
  if (botUserId && String(message.author?.id || '') === String(botUserId)) return true;
  return false;
}

async function fetchFreshMessage(message) {
  if (typeof message?.fetch !== 'function') return message;
  return message.fetch(true);
}

async function enforceMediaOnlyMessage(
  message,
  { channelIds, botUserId, embedGraceMs, forceRefresh = false }
) {
  if (shouldIgnoreMessage(message, channelIds, botUserId)) return;

  let currentMessage = message;

  try {
    if (currentMessage.partial || forceRefresh) {
      currentMessage = await fetchFreshMessage(currentMessage);
    }

    if (extractUrls(currentMessage?.content).length > 0 && embedGraceMs > 0) {
      await sleep(embedGraceMs);
      currentMessage = await fetchFreshMessage(currentMessage);
    }
  } catch (error) {
    if (isUnknownMessageError(error)) return;

    await logError('mediaOnly.refreshMessage', error, {
      channelId: message?.channelId,
      messageId: message?.id,
    });
    return;
  }

  const result = evaluateMediaOnlyMessage(currentMessage);
  if (result.allowed) return;

  if (currentMessage?.deletable === false) {
    logWarn(
      `Cannot delete invalid media-only message ${currentMessage.id}; check WinterBot's Manage Messages permission.`,
      {
        source: 'mediaOnly',
        channelId: currentMessage.channelId,
        messageId: currentMessage.id,
        reason: result.reason,
      }
    );
    return;
  }

  try {
    await currentMessage.delete();

    logInfo(`Deleted invalid media-only message ${currentMessage.id}: ${result.reason}.`, {
      source: 'mediaOnly',
      channelId: currentMessage.channelId,
      messageId: currentMessage.id,
      authorId: currentMessage.author?.id,
      reason: result.reason,
    });
  } catch (error) {
    if (isUnknownMessageError(error)) return;

    await logError('mediaOnly.deleteMessage', error, {
      channelId: currentMessage?.channelId,
      messageId: currentMessage?.id,
      reason: result.reason,
    });
  }
}

function registerMediaOnlyChannelHandlers(client) {
  const config = getConfig();
  const channelIds = new Set(config.mediaOnlyChannelIds || []);

  if (channelIds.size === 0) return;

  const pendingMessageIds = new Set();

  function queueEnforcement(message, source, forceRefresh = false) {
    if (shouldIgnoreMessage(message, channelIds, client.user?.id)) return;
    if (!message?.id || pendingMessageIds.has(message.id)) return;

    pendingMessageIds.add(message.id);

    enforceMediaOnlyMessage(message, {
      channelIds,
      botUserId: client.user?.id,
      embedGraceMs: config.mediaOnlyEmbedGraceMs,
      forceRefresh,
    })
      .catch((error) =>
        logError(`mediaOnly.${source}`, error, {
          channelId: message?.channelId,
          messageId: message?.id,
        })
      )
      .finally(() => {
        pendingMessageIds.delete(message.id);
      });
  }

  client.on('messageCreate', (message) => {
    queueEnforcement(message, 'messageCreate');
  });

  client.on('messageUpdate', (_oldMessage, newMessage) => {
    queueEnforcement(newMessage, 'messageUpdate', true);
  });

  logInfo(`Media-only enforcement enabled for ${channelIds.size} channel(s).`, {
    source: 'mediaOnly',
    channelIds: Array.from(channelIds),
  });
}

module.exports = {
  extractUrls,
  isMediaAttachment,
  isMediaEmbed,
  evaluateMediaOnlyMessage,
  registerMediaOnlyChannelHandlers,
};
