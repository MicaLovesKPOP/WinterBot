// Discord REST helpers
// Implements the REST call for retrieving scheduled event subscribers with
// retry/backoff behavior identical to the legacy WinterBot.js implementation.

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { getConfig } = require('../config/index.js');
const { getTimestamp, safeWriteError } = require('../logging/logger.js');

async function fetchSubscribedUsers(guildId, eventId, retryCount = 0) {
  const MAX_RETRIES = 3;
  const config = getConfig();

  try {
    const response = await fetch(
      `https://discord.com/api/v9/guilds/${guildId}/scheduled-events/${eventId}/users`,
      { headers: { Authorization: `Bot ${config.botToken}` } }
    );

    if (!response.ok) {
      const text = await response.text();
      const errMsg = `[${getTimestamp()}] Discord API ${response.status}: ${text}`;
      safeWriteError(errMsg);

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
        await new Promise((res) => setTimeout(res, retryAfter * 1000));
        return fetchSubscribedUsers(guildId, eventId, retryCount + 1);
      }

      if (response.status >= 500 && retryCount < MAX_RETRIES) {
        const backoff = Math.pow(2, retryCount) * 1000;
        await new Promise((res) => setTimeout(res, backoff));
        return fetchSubscribedUsers(guildId, eventId, retryCount + 1);
      }

      return [];
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      safeWriteError(`[${getTimestamp()}] Unexpected content-type ${contentType}: ${text}`);
      return [];
    }

    return await response.json();
  } catch (error) {
    safeWriteError(
      `[${getTimestamp()}] Fetch error (${error && error.name}): ${
        error && error.message ? error.message : error
      }`
    );

    if (retryCount < MAX_RETRIES) {
      const backoff = Math.pow(2, retryCount) * 1000;
      await new Promise((res) => setTimeout(res, backoff));
      return fetchSubscribedUsers(guildId, eventId, retryCount + 1);
    }

    return [];
  }
}

module.exports = { fetchSubscribedUsers };
