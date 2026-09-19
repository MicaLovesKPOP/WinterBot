const fs = require('fs');
const { getConfig } = require('../config');
const { formatDuration, getUptimeTotals, saveUptime } = require('../persistence/uptimeStore');
const { logError, logInfo, splitMessageIntoChunks, getLogPaths } = require('../logging/logger');
const { getTextChannelOrThrow } = require('../discord/guildResources');

async function readStructuredEntries() {
  const { structuredLogFile } = getLogPaths();
  try {
    const content = await fs.promises.readFile(structuredLogFile, 'utf8');
    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    await logError('errorReport.readStructuredEntries', error);
    return [];
  }
}

function summarizeErrors(entries) {
  const errors = entries.filter((entry) => entry.level === 'error' || entry.level === 'fatal' || entry.level === 'warn');
  const grouped = new Map();

  for (const entry of errors) {
    const signature = entry.metadata?.signature || `${entry.source}|${entry.message}`;
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

  return [...grouped.values()].sort((left, right) => right.count - left.count);
}

async function buildReportMessage(client) {
  await saveUptime(client);

  const currentUptimeMinutes = Math.floor((client?.uptime || 0) / 60000);
  const { totalUptimeMinutes, totalDowntimeMinutes } = getUptimeTotals();
  const entries = await readStructuredEntries();
  const summary = summarizeErrors(entries);
  const latest = summary.slice(0, 10);

  const lines = [
    'WinterBot weekly report',
    '',
    'Uptime',
    `- Current uptime: ${formatDuration(currentUptimeMinutes)}`,
    `- Total uptime: ${formatDuration(totalUptimeMinutes)}`,
    `- Total downtime: ${formatDuration(totalDowntimeMinutes)}`,
    '',
    'Error summary',
  ];

  if (latest.length === 0) {
    lines.push('- No warnings or errors recorded this period.');
  } else {
    for (const item of latest) {
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
    // eslint-disable-next-line no-await-in-loop
    await channel.send(chunk);
  }
}

async function postErrorReport(client) {
  try {
    const report = await buildReportMessage(client);
    await sendReport(client, report);
    logInfo('Weekly error report posted.', { source: 'errorReport' });
  } catch (error) {
    await logError('errorReport.post', error);
  }
}

module.exports = { postErrorReport, buildReportMessage, summarizeErrors };
