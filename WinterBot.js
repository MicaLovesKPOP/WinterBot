const { loadConfig } = require('./src/config');
const { initializeLogger, logInfo, logError } = require('./src/logging/logger');
const { initializeEventsStore, saveEvents } = require('./src/persistence/eventsStore');
const { initializeUptimeStore, saveUptime } = require('./src/persistence/uptimeStore');
const { createDiscordClient, loginDiscordClient } = require('./src/discord/client');
const { registerEventHandlers, stopEventHandlers } = require('./src/discord/events');
const { initializeVersionTracker } = require('./src/versioning/versionTracker');
const {
  startNightlySelfUpdate,
  stopNightlySelfUpdate,
} = require('./src/update/updateMonitor');

const SHUTDOWN_TIMEOUT_MS = 10_000;

let client = null;
let schedulingServer = null;
let schedulingNgrokTunnel = null;
let shuttingDown = false;

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)),
          timeoutMs
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function shutdown(reason, exitCode = 0, error = null) {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    logInfo(`Shutdown requested via ${reason}.`, { source: 'app.shutdown', exitCode });
  } catch (_) {}

  if (error) {
    try {
      await withTimeout(logError(`app.${reason}`, error), 3_000, 'Error logging');
    } catch (_) {}
  }

  try {
    stopNightlySelfUpdate();
  } catch (_) {}

  try {
    stopEventHandlers();
  } catch (_) {}

  try {
    if (schedulingNgrokTunnel) {
      await withTimeout(schedulingNgrokTunnel.close(), 4_000, 'Scheduling ngrok tunnel shutdown');
      schedulingNgrokTunnel = null;
    }
  } catch (error) {
    try { await logError('app.shutdown.schedulingNgrok', error); } catch (_) {}
  }

  try {
    if (schedulingServer) {
      await withTimeout(schedulingServer.stop(), 5_000, 'Scheduling server shutdown');
      schedulingServer = null;
    }
  } catch (error) {
    try { await logError('app.shutdown.schedulingServer', error); } catch (_) {}
  }

  try {
    const results = await withTimeout(
      Promise.allSettled([
        client ? saveUptime(client) : Promise.resolve(),
        saveEvents(),
      ]),
      SHUTDOWN_TIMEOUT_MS,
      'Persistence cleanup'
    );

    const failures = results.filter(
      (result) => result.status === 'rejected'
    );

    for (const failure of failures) {
      try {
        await logError(
          'app.shutdown.persistence',
          failure.reason
        );
      } catch (_) {}
    }
  } catch (cleanupError) {
    try {
      await logError('app.shutdown.persistence', cleanupError);
    } catch (_) {}
  }

  try {
    if (client) {
      await withTimeout(client.destroy(), 5_000, 'Discord client shutdown');
    }
  } catch (destroyError) {
    try {
      await logError('app.shutdown.destroyClient', destroyError);
    } catch (_) {}
  }

  process.exit(exitCode);
}

function registerProcessHandlers() {
  process.once('SIGINT', () => {
    shutdown('SIGINT', 0).catch(() => process.exit(1));
  });

  process.once('SIGTERM', () => {
    shutdown('SIGTERM', 0).catch(() => process.exit(1));
  });

  process.once('uncaughtException', (error) => {
    shutdown('uncaughtException', 1, error).catch(() => process.exit(1));
  });

  process.once('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    shutdown('unhandledRejection', 1, error).catch(() => process.exit(1));
  });
}

async function bootstrap() {
  loadConfig();
  initializeLogger();
  initializeEventsStore();
  initializeUptimeStore();
  registerProcessHandlers();

  const { version: botVersion, action: versionAction } = initializeVersionTracker();

  logInfo(`Booting WinterBot v${botVersion}.`, {
    source: 'app.bootstrap',
    versionAction,
  });

  if (versionAction === 'patch' || versionAction === 'minor') {
    logInfo(
      `Automatic ${versionAction} version bump applied; runtime version is now v${botVersion}.`,
      { source: 'versionTracker', versionAction, botVersion }
    );
  } else if (versionAction === 'initialized' || versionAction === 'release-baseline') {
    logInfo(`Version baseline initialized at v${botVersion}.`, {
      source: 'versionTracker',
      versionAction,
      botVersion,
    });
  }

  client = createDiscordClient();
  registerEventHandlers(client, botVersion);
  await loginDiscordClient(client);

  // Scheduling is strictly opt-in. A failed optional web feature must never
  // prevent the established registration-tracking bot from starting.
  if (process.env.SCHEDULING_ENABLED === '1') {
    try {
      const config = require('./src/config').getConfig();
      const { createScheduler } = require('./src/scheduling/server');
      const { configureChannelPolicy } = require('./src/scheduling/channelPolicy');
      const { getSchedulingNgrokSettings, startSchedulingNgrokTunnel } = require('./src/scheduling/ngrokTunnel');
      const ngrokSettings = getSchedulingNgrokSettings(process.env);
      let activityTest = null;
      if (process.env.SCHEDULING_ACTIVITY_TEST_ENABLED === '1') {
        try {
          if (!ngrokSettings || process.env.SCHEDULING_TEST_MODE !== '1') {
            throw new Error('Isolated Activity testing requires the existing TEST-only ngrok scheduler.');
          }
          const { createActivityTest } = require('./src/scheduling/activityTest');
          activityTest = createActivityTest({
            client,
            clientId: process.env.DISCORD_CLIENT_ID,
            clientSecret: process.env.DISCORD_CLIENT_SECRET,
            sessionSecret: process.env.SCHEDULING_SESSION_SECRET,
          });
        } catch (error) {
          // Activity is disposable: a corrupt test-only store or unsupported
          // test configuration must never bring down the existing planner.
          activityTest = null;
          await logError('scheduling.activityTest.optionalStartup', error)
            .catch(() => console.warn('Isolated Activity test disabled:', error.message));
        }
      }
      const policy = configureChannelPolicy({
        guildId: config.guildId, logChannelId: config.logChannelId, demo: false,
      });
      schedulingServer = createScheduler({
        activityTest,
        policy,
        testMode: process.env.SCHEDULING_TEST_MODE === '1',
        reportError: (source, error) => logError('scheduling.' + source, error),
        mode: 'live',
        client,
        guildId: config.guildId,
        channelId: process.env.SCHEDULING_CHANNEL_ID || config.channelId,
        clientId: process.env.DISCORD_CLIENT_ID,
        clientSecret: process.env.DISCORD_CLIENT_SECRET,
        sessionSecret: process.env.SCHEDULING_SESSION_SECRET,
        baseUrl: ngrokSettings?.baseUrl || process.env.SCHEDULING_BASE_URL,
        adminIds: String(process.env.SCHEDULING_ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean),
        host: process.env.SCHEDULING_HOST || '127.0.0.1',
        port: Number(process.env.SCHEDULING_PORT || 8791),
      });
      const { url } = await schedulingServer.start({
        onHttpReady: ngrokSettings ? async () => {
          schedulingNgrokTunnel = await startSchedulingNgrokTunnel(ngrokSettings, {
            onStatusChange: status => {
              // No secret values or authentication tokens are logged.
              logInfo('Scheduling ngrok tunnel status: ' + String(status).slice(0, 35),
                { source: 'scheduling.ngrok.status' });
            },
          });
          logInfo('Scheduling TEST planner accessible at ' + schedulingNgrokTunnel.url,
            { source: 'scheduling.ngrok.start' });
        } : undefined,
      });
      logInfo('Scheduling web server running at ' + url, { source: 'scheduling.start' });
    } catch (error) {
      // Log the failure but continue running WinterBot's existing features.
      try { if (schedulingNgrokTunnel) await schedulingNgrokTunnel.close(); } catch (_) {}
      schedulingNgrokTunnel = null;
      try {
        if (schedulingServer) await schedulingServer.stop();
      } catch (_) {}
      schedulingServer = null;
      try {
        await logError('scheduling.optionalStartup', error);
      } catch (_) {
        console.error('Optional scheduling startup failed:', error.message);
      }
    }
  }

  startNightlySelfUpdate(async () => {
    await shutdown('automaticUpdate', 1);
  });
}

bootstrap().catch(async (error) => {
  await shutdown('bootstrap', 1, error);
});
