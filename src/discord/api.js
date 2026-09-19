const { getConfig } = require('../config');
const { logWarn } = require('../logging/logger');

const MAX_PAGES = 1000;

function withJitter(delayMs) {
  const jitter = Math.floor(
    Math.random() * Math.min(250, delayMs * 0.25)
  );
  return delayMs + jitter;
}

function getFetchImplementation() {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error(
      'WinterBot requires a Node.js runtime with the built-in fetch API.'
    );
  }
  return globalThis.fetch;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSubscribedUsers(guildId, eventId) {
  const config = getConfig();
  const fetchImpl = getFetchImplementation();
  const users = [];
  const seenCursors = new Set();

  let after = null;
  let page = 0;

  while (page < MAX_PAGES) {
    page += 1;

    const url = new URL(
      `https://discord.com/api/v10/guilds/${guildId}/scheduled-events/${eventId}/users`
    );
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);

    let attempt = 0;
    let response = null;

    while (attempt <= config.maxApiRetries) {
      try {
        response = await fetchWithTimeout(
          fetchImpl,
          url.toString(),
          {
            headers: {
              Authorization: `Bot ${config.botToken}`,
              'Content-Type': 'application/json',
            },
          },
          config.apiRequestTimeoutMs
        );

        if (response.status === 429) {
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfterSeconds = Number.parseFloat(
            retryAfterHeader || '1'
          );
          const waitMs = Math.max(
            250,
            Math.ceil(retryAfterSeconds * 1000)
          );

          logWarn(
            `Rate limited while fetching subscribers for event ${eventId}; retrying in ${waitMs}ms.`,
            { source: 'discord.api', eventId }
          );

          if (attempt >= config.maxApiRetries) break;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          attempt += 1;
          continue;
        }

        if (response.status >= 500) {
          if (attempt >= config.maxApiRetries) break;
          const delayMs = withJitter(
            config.retryBaseDelayMs * 2 ** attempt
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          attempt += 1;
          continue;
        }

        break;
      } catch (error) {
        if (attempt >= config.maxApiRetries) {
          throw error;
        }

        const delayMs = withJitter(
          config.retryBaseDelayMs * 2 ** attempt
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        attempt += 1;
      }
    }

    if (!response || !response.ok) {
      const body = response
        ? await response.text().catch(() => '')
        : '';
      throw new Error(
        `HTTP ${response ? response.status : 'unknown'} ${body}`.trim()
      );
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error('Subscriber payload is not an array');
    }

    users.push(...payload);
    if (payload.length < 100) return users;

    const nextAfter = String(
      payload[payload.length - 1]?.user?.id || ''
    );
    if (!nextAfter) return users;

    if (seenCursors.has(nextAfter)) {
      throw new Error(
        `Subscriber pagination repeated cursor ${nextAfter} for event ${eventId}.`
      );
    }

    seenCursors.add(nextAfter);
    after = nextAfter;
  }

  throw new Error(
    `Subscriber pagination exceeded ${MAX_PAGES} pages for event ${eventId}.`
  );
}

module.exports = {
  fetchSubscribedUsers,
  fetchWithTimeout,
};
