'use strict';

// Optional, test-only HTTPS entry point for the existing WinterBot planner.
// Deliberately no ngrok session is started unless BOTH the scheduler and its
// dry-run mode are explicitly enabled. This module contains no Discord side
// effects and it never publishes real events.

const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function getSchedulingNgrokSettings(env = process.env) {
  if (env.SCHEDULING_NGROK_ENABLED !== '1') return null;

  if (env.SCHEDULING_ENABLED !== '1' || env.SCHEDULING_TEST_MODE !== '1') {
    throw new Error('ngrok test hosting requires SCHEDULING_ENABLED=1 and SCHEDULING_TEST_MODE=1. No tunnel was opened.');
  }

  const host = String(env.SCHEDULING_HOST || '127.0.0.1').trim();
  if (host !== '127.0.0.1') {
    throw new Error('ngrok test hosting requires SCHEDULING_HOST=127.0.0.1; never bind the HTTP planner publicly.');
  }

  const port = Number(env.SCHEDULING_PORT || 8791);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('SCHEDULING_PORT must be a valid unprivileged TCP port.');
  }

  const rawDomain = String(env.SCHEDULING_NGROK_DOMAIN || '').trim().toLowerCase();
  const domain = rawDomain.startsWith('https://') ? rawDomain.slice(8) : rawDomain;
  if (domain.length > 253 || !DOMAIN_PATTERN.test(domain)) {
    throw new Error('Set SCHEDULING_NGROK_DOMAIN to your assigned ngrok domain, without https://, port or path.');
  }
  // The domain must be reserved in the user's ngrok account. ngrok validates
  // ownership when establishing the listener. No new public DNS is invented.
  const baseUrl = 'https://' + domain;
  const suppliedBaseUrl = String(env.SCHEDULING_BASE_URL || '').trim().replace(/\/$/, '');
  if (suppliedBaseUrl && suppliedBaseUrl !== baseUrl) {
    throw new Error('SCHEDULING_BASE_URL does not match your ngrok development domain. Remove it or make it exactly ' + baseUrl + '.');
  }

  const authtoken = String(env.NGROK_AUTHTOKEN || '').trim();
  if (!authtoken) {
    throw new Error('Set NGROK_AUTHTOKEN privately in WinterBot hosting; never store it in Git or Discord.');
  }

  return Object.freeze({ host, port, domain, baseUrl, authtoken });
}

function redactError(error, authtoken) {
  let message = String(error?.message || error || 'Unknown ngrok connection failure.');
  if (authtoken) message = message.split(authtoken).join('[REDACTED]');
  return message.slice(0, 400);
}

async function startSchedulingNgrokTunnel(settings, { sdk, onStatusChange, timeoutMs = 20000 } = {}) {
  if (!settings?.domain || !settings?.authtoken) {
    throw new Error('The scheduling ngrok tunnel was not configured.');
  }
  const agent = sdk || require('@ngrok/ngrok');
  let listener;
  let connection;
  let timer;
  let timedOut = false;
  try {
    connection = Promise.resolve().then(() => agent.forward({
      addr: settings.host + ':' + settings.port,
      authtoken: settings.authtoken,
      domain: settings.domain,
      proto: 'http',
      schemes: ['HTTPS'],
      ...(onStatusChange ? { onStatusChange } : {}),
    }));
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error('ngrok did not connect before the startup timeout.'));
      }, timeoutMs);
    });
    listener = await Promise.race([connection, deadline]);
    const actual = String(listener?.url?.() || '');
    if (actual !== settings.baseUrl) {
      throw new Error('ngrok returned a different HTTPS domain than the configured OAuth redirect.');
    }
    let closed = false;
    return {
      url: actual,
      async close() {
        if (closed) return;
        closed = true;
        await listener.close();
      },
    };
  } catch (error) {
    if (listener) {
      try { await listener.close(); } catch (_) {}
    }
    if (timedOut && connection) {
      // A late native SDK success must not leave a public listener behind.
      connection.then(late => late?.close?.()).catch(() => {});
    }
    throw new Error(
      'WinterBot HTTPS tunnel could not start. Check ngrok credentials, domain ownership, account limits and host outbound access. Details: ' +
      redactError(error, settings.authtoken)
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { getSchedulingNgrokSettings, startSchedulingNgrokTunnel };
