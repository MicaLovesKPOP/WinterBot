const { loadConfig } = require('./src/config');
const { initializeLogger, logInfo, logError } = require('./src/logging/logger');
const { initializeEventsStore, saveEvents } = require('./src/persistence/eventsStore');
const { initializeUptimeStore, saveUptime } = require('./src/persistence/uptimeStore');
const { createDiscordClient, loginDiscordClient } = require('./src/discord/client');
const { registerEventHandlers, stopEventHandlers } = require('./src/discord/events');
const { initializeVersionTracker } = require('./src/versioning/versionTracker');
const { createScheduler } = require('./src/scheduling/server');
const {
  startNightlySelfUpdate,
  stopNightlySelfUpdate,
} = require('./src/update/updateMonitor');

const SHUTDOWN_TIMEOUT_MS = 10_000;

let client = null;
let schedulingServer = null;
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

  if (process.env.SCHEDULING_ENABLED === '1') {
    const config = require('./src/config').getConfig();
    schedulingServer = createScheduler({
      mode: 'live',
      client,
      guildId: config.guildId,
      channelId: process.env.SCHEDULING_CHANNEL_ID || config.channelId,
      clientId: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
      sessionSecret: process.env.SCHEDULING_SESSION_SECRET,
      baseUrl: process.env.SCHEDULING_BASE_URL,
      adminIds: String(process.env.SCHEDULING_ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean),
      host: process.env.SCHEDULING_HOST || '127.0.0.1',
      port: Number(process.env.SCHEDULING_PORT || 8791),
    });
    const { url } = await schedulingServer.start();
    logInfo('Scheduling web server running at ' + url, { source: 'scheduling.start' });
  }

  startNightlySelfUpdate(async () => {
    await shutdown('automaticUpdate', 1);
  });
}

bootstrap().catch(async (error) => {
  await shutdown('bootstrap', 1, error);
});
