const fs = require('fs');
const { getConfig } = require('../config');
const {
  formatDurationFromMinutes,
  getUptimeTotals,
  saveUptime,
} = require('../persistence/uptimeStore');
const {
  logError,
  logInfo,
  splitMessageIntoChunks,
  getLogPaths,
} = require('../logging/logger');
const { getTextChannelOrThrow } = require('../discord/guildResources');

const MAX_LOG_BACKUPS = 5;

async function readStructuredEntries(periodMs = null) {
  const { structuredLogFile } = getLogPaths();
  const files = [
    ...Array.from(
      { length: MAX_LOG_BACKUPS },
      (_, index) => `${structuredLogFile}.${MAX_LOG_BACKUPS - index}`
    ),
    structuredLogFile,
  ];

  const entries = [];

  for (const file of files) {
    let content;
    try {
      content = await fs.promises.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      await logError('errorReport.readStructuredEntries', error, { file });
      continue;
    }

    for (const line of content.split('\n').filter(Boolean)) {
      try {
        entries.push(JSON.parse(line));
      } catch (_) {}
    }
  }

  if (!periodMs) return entries;

  const cutoff = Date.now() - periodMs;
  return entries.filter((entry) => {
    const timestamp = Date.parse(entry.isoTimestamp || '');
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  });
}

function summarizeErrors(entries) {
  const errors = entries.filter(
    (entry) =>
      entry.level === 'error' ||
      entry.level === 'fatal' ||
      entry.level === 'warn'
  );
  const grouped = new Map();

  for (const entry of errors) {
    const signature =
      entry.metadata?.signature || `${entry.source}|${entry.message}`;
    const existing = grouped.get(signature);

    if (existing) {
      existing.count += 1;
      existing.lastTimestamp = entry.timestamp;
      continue;
    }

    grouped.set(signature, {
      source: entry.source,
      message: entry.message,
      count: 1,
      firstTimestamp: entry.timestamp,
      lastTimestamp: entry.timestamp,
      recoveryAction: entry.metadata?.recoveryAction || '',
    });
  }

  return [...grouped.values()].sort(
    (left, right) => right.count - left.count
  );
}

function buildUptimeLines(currentUptimeMinutes, totalUptimeMinutes, totalDowntimeMinutes) {
  return [
    'Uptime',
    `- Current uptime: ${formatDurationFromMinutes(currentUptimeMinutes)}`,
    `- Total uptime: ${formatDurationFromMinutes(totalUptimeMinutes)}`,
    `- Total downtime: ${formatDurationFromMinutes(totalDowntimeMinutes)}`,
  ];
}

async function buildReportMessage(client) {
  const config = getConfig();
  await saveUptime(client);

  const currentUptimeMinutes = Math.floor(
    Math.max(0, Number(client?.uptime) || 0) / 60_000
  );
  const { totalUptimeMinutes, totalDowntimeMinutes } = getUptimeTotals();
  const entries = await readStructuredEntries(config.weeklyReportIntervalMs);
  const summary = summarizeErrors(entries).slice(0, 10);

  const lines = [
    'WinterBot weekly report',
    '',
    ...buildUptimeLines(
      currentUptimeMinutes,
      totalUptimeMinutes,
      totalDowntimeMinutes
    ),
    '',
    'Error summary',
  ];

  if (summary.length === 0) {
    lines.push('- No warnings or errors recorded this period.');
  } else {
    for (const item of summary) {
      lines.push(`- ${item.source}: ${item.message} — ${item.count}x`);
      if (item.recoveryAction) {
        lines.push(`  Recovery: ${item.recoveryAction}`);
      }
    }
  }

  return lines.join('\n');
}

async function sendReport(client, reportText) {
  const config = getConfig();
  const channel = await getTextChannelOrThrow(client, config.logChannelId);
  const chunks = splitMessageIntoChunks(reportText, 1900);

  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

async function postErrorReport(client) {
  try {
    const reportText = await buildReportMessage(client);
    await sendReport(client, reportText);
    logInfo('Weekly error report posted.', { source: 'errorReport' });
    return true;
  } catch (error) {
    await logError('errorReport.post', error);
    return false;
  }
}

module.exports = {
  postErrorReport,
  buildReportMessage,
  summarizeErrors,
  buildUptimeLines,
  readStructuredEntries,
};
