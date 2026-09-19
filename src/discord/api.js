const nodeFetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { getConfig } = require('../config');
const { logWarn } = require('../logging/logger');

async function getFetchImplementation() {
  if (typeof fetch === 'function') return fetch;
  return nodeFetch;
}

function withJitter(delayMs) {
  const jitter = Math.floor(Math.random() * Math.min(250, delayMs * 0.25));
  return delayMs + jitter;
}

async function fetchSubscribedUsers(guildId, eventId) {
  const config = getConfig();
  const fetchImpl = await getFetchImplementation();
  const users = [];
  let after = null;

  while (true) {
    const url = new URL(`https://discord.com/api/v10/guilds/${guildId}/scheduled-events/${eventId}/users`);
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);

    let attempt = 0;
    let response = null;

    while (attempt <= config.maxApiRetries) {
      try {
        response = await fetchImpl(url.toString(), {
          headers: {
            Authorization: `Bot ${config.botToken}`,
            'Content-Type': 'application/json',
          },
        });

        if (response.status === 429) {
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfterSeconds = Number.parseFloat(retryAfterHeader || '1');
          const waitMs = Math.max(250, Math.ceil(retryAfterSeconds * 1000));
          logWarn(`Rate limited while fetching subscribers for event ${eventId}; retrying in ${waitMs}ms.`, {
            source: 'discord.api',
            eventId,
          });
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          attempt += 1;
          continue;
        }

        if (response.status >= 500) {
          if (attempt >= config.maxApiRetries) break;
          const delayMs = withJitter(config.retryBaseDelayMs * (2 ** attempt));
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          attempt += 1;
          continue;
        }

        break;
      } catch (error) {
        if (attempt >= config.maxApiRetries) {
          throw error;
        }
        const delayMs = withJitter(config.retryBaseDelayMs * (2 ** attempt));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        attempt += 1;
      }
    }

    if (!response || !response.ok) {
      const body = response ? await response.text().catch(() => '') : '';
      throw new Error(`HTTP ${response ? response.status : 'unknown'} ${body}`.trim());
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error('Subscriber payload is not an array');
    }

    users.push(...payload);
    if (payload.length < 100) break;

    after = payload[payload.length - 1]?.user?.id;
    if (!after) break;
  }

  return users;
}

module.exports = { fetchSubscribedUsers };