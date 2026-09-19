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
const TRAILING_URL_PUNCTUATION = /[),.!?;:'"]+$/;

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.values === 'function') return Array.from(value.values());
  return Object.values(value);
}

function extractUrls(content) {
  const matches = String(content || '').match(URL_PATTERN) || [];
  return matches.map((url) => url.replace(TRAILING_URL_PUNCTUATION, ''));
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

function evaluateMediaOnly(message) {
  const attachments = toArray(message?.attachments);
  const embeds = toArray(message?.embeds);
  const urls = Array.from(new Set(extractUrls(message?.content)));

  if (attachments.some((attachment) => !isMediaAttachment(attachment))) {
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
        reason: 'contains a link that did not resolve to image, video, or audio media',
      };
    }
  }

  if (mediaAttachments.length === 0 && mediaEmbeds.length === 0) {
    return {
      allowed: false,
      reason: 'does not contain image, video, or audio media',
    };
  }

  return { allowed: true, reason: null };
}

function hostnameMatches(hostname, domain, allowSubdomains) {
  if (hostname === domain) return true;
  return allowSubdomains && hostname.endsWith(`.${domain}`);
}

function urlMatchesRequiredLinkRule(rawUrl, rule) {
  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    return false;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return false;

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!rule.domains.some((domain) => hostnameMatches(hostname, domain, rule.allowSubdomains))) {
    return false;
  }

  if (
    rule.pathPrefixes.length > 0 &&
    !rule.pathPrefixes.some((prefix) => parsed.pathname.startsWith(prefix))
  ) {
    return false;
  }

  for (const [name, requirement] of Object.entries(rule.queryParams)) {
    const value = parsed.searchParams.get(name);
    if (value === null) return false;
    if (requirement !== true && !new RegExp(requirement).test(value)) return false;
  }

  return true;
}

function describeRequiredLinkRule(rule) {
  const domainText = rule.domains.join(' or ');
  if (rule.pathPrefixes.length === 0) return `a link to ${domainText}`;
  return `a matching link to ${domainText}`;
}

function evaluateRequiredLink(message, rule) {
  const urls = Array.from(new Set(extractUrls(message?.content)));
  const matches = urls.filter((url) => urlMatchesRequiredLinkRule(url, rule));

  if (matches.length < rule.minMatches) {
    return {
      allowed: false,
      reason: `requires at least ${rule.minMatches} ${describeRequiredLinkRule(rule)}`,
    };
  }

  if (rule.rejectOtherLinks && matches.length !== urls.length) {
    return {
      allowed: false,
      reason: 'contains a link that does not match the allowed link requirements',
    };
  }

  return { allowed: true, reason: null };
}

const RULE_EVALUATORS = {
  mediaOnly: (message) => evaluateMediaOnly(message),
  requiredLink: (message, rule) => evaluateRequiredLink(message, rule),
};

function evaluateMessageRequirements(message, policy) {
  for (const rule of policy.requirements) {
    const evaluator = RULE_EVALUATORS[rule.type];
    if (!evaluator) {
      return {
        allowed: false,
        reason: `has an unsupported configured requirement type: ${rule.type}`,
      };
    }

    const result = evaluator(message, rule);
    if (!result.allowed) return result;
  }

  return { allowed: true, reason: null };
}

function policyNeedsEmbedRefresh(policy) {
  return policy.requirements.some((rule) => rule.type === 'mediaOnly');
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isUnknownMessageError(error) {
  return Number(error?.code || error?.rawError?.code) === 10008;
}

function getPolicyForMessage(message, policies) {
  if (!message?.channelId) return null;
  return policies[String(message.channelId)] || null;
}

function shouldIgnoreMessage(message, policy, botUserId) {
  if (!policy) return true;
  if (message.system) return true;
  if (botUserId && String(message.author?.id || '') === String(botUserId)) return true;
  if (policy.ignoreBots && message.author?.bot) return true;
  return false;
}

async function fetchFreshMessage(message) {
  if (typeof message?.fetch !== 'function') return message;
  return message.fetch(true);
}

async function enforceMessageRequirements(
  message,
  { policies, botUserId, embedGraceMs, forceRefresh = false }
) {
  let policy = getPolicyForMessage(message, policies);
  if (shouldIgnoreMessage(message, policy, botUserId)) return;

  let currentMessage = message;

  try {
    if (currentMessage.partial || forceRefresh) {
      currentMessage = await fetchFreshMessage(currentMessage);
      policy = getPolicyForMessage(currentMessage, policies);
      if (shouldIgnoreMessage(currentMessage, policy, botUserId)) return;
    }

    if (
      policyNeedsEmbedRefresh(policy) &&
      extractUrls(currentMessage?.content).length > 0 &&
      embedGraceMs > 0
    ) {
      await sleep(embedGraceMs);
      currentMessage = await fetchFreshMessage(currentMessage);
      policy = getPolicyForMessage(currentMessage, policies);
      if (shouldIgnoreMessage(currentMessage, policy, botUserId)) return;
    }
  } catch (error) {
    if (isUnknownMessageError(error)) return;

    await logError('messageRequirements.refreshMessage', error, {
      channelId: message?.channelId,
      messageId: message?.id,
    });
    return;
  }

  const result = evaluateMessageRequirements(currentMessage, policy);
  if (result.allowed) return;

  if (currentMessage?.deletable === false) {
    logWarn(
      `Cannot delete message ${currentMessage.id} that failed channel requirements; check WinterBot's Manage Messages permission.`,
      {
        source: 'messageRequirements',
        channelId: currentMessage.channelId,
        messageId: currentMessage.id,
        reason: result.reason,
      }
    );
    return;
  }

  try {
    await currentMessage.delete();

    logInfo(`Deleted message ${currentMessage.id} that failed channel requirements: ${result.reason}.`, {
      source: 'messageRequirements',
      channelId: currentMessage.channelId,
      messageId: currentMessage.id,
      authorId: currentMessage.author?.id,
      reason: result.reason,
    });
  } catch (error) {
    if (isUnknownMessageError(error)) return;

    await logError('messageRequirements.deleteMessage', error, {
      channelId: currentMessage?.channelId,
      messageId: currentMessage?.id,
      reason: result.reason,
    });
  }
}

function registerMessageRequirementHandlers(client) {
  const config = getConfig();
  const policies = config.messageRequirements || {};
  const channelIds = Object.keys(policies);

  if (channelIds.length === 0) return;

  const pendingMessageIds = new Set();

  function queueEnforcement(message, source, forceRefresh = false) {
    const policy = getPolicyForMessage(message, policies);
    if (shouldIgnoreMessage(message, policy, client.user?.id)) return;
    if (!message?.id || pendingMessageIds.has(message.id)) return;

    pendingMessageIds.add(message.id);

    enforceMessageRequirements(message, {
      policies,
      botUserId: client.user?.id,
      embedGraceMs: config.messageRequirementsEmbedGraceMs,
      forceRefresh,
    })
      .catch((error) =>
        logError(`messageRequirements.${source}`, error, {
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

  logInfo(`Message requirements enabled for ${channelIds.length} channel(s).`, {
    source: 'messageRequirements',
    channelIds,
  });
}

module.exports = {
  extractUrls,
  isMediaAttachment,
  isMediaEmbed,
  urlMatchesRequiredLinkRule,
  evaluateMediaOnly,
  evaluateRequiredLink,
  evaluateMessageRequirements,
  registerMessageRequirementHandlers,
};
