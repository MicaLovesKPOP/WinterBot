// Weekly error and uptime reporting
// Implements the legacy weekly report behavior by reading error logs (including
// recent rotated backups), formatting uptime/downtime metrics, splitting long
// messages, and sending them to the configured log/report channel.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('../config/index.js');
const { formatDuration, getUptimeTotals, saveUptime } = require('../persistence/uptimeStore.js');
const { logError, logInfo, splitMessageIntoChunks } = require('../logging/logger.js');

// Include the primary log plus a limited number of rotated backups to reflect
// the past week's activity without overwhelming output.
const MAX_ROTATED_LOGS = 2; // Reads error.log plus error.log.1 and error.log.2
const DEFAULT_DISCORD_CHUNK_SIZE = 2000;

function getLogFilePaths() {
  const baseLogPath = path.join(process.cwd(), 'logs', 'error.log');
  const paths = [baseLogPath];

  for (let i = 1; i <= MAX_ROTATED_LOGS; i++) {
    paths.push(`${baseLogPath}.${i}`);
  }

  return paths;
}

async function readLogFile(filePath) {
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return content;
  } catch (err) {
    if (err && err.code === 'ENOENT') return '';
    await logError('Error reading log file for report', err);
    return '';
  }
}

async function buildErrorSection() {
  const logFilePaths = getLogFilePaths();
  const parts = [];

  for (const logPath of logFilePaths) {
    // eslint-disable-next-line no-await-in-loop
    const content = await readLogFile(logPath);
    if (!content || !content.trim()) continue;

    parts.push(`--- ${path.basename(logPath)} ---\n${content.trim()}`);
  }

  if (!parts.length) {
    return 'No errors reported this week.';
  }

  return `\`\`\`\n${parts.join('\n\n')}\n\`\`\``;
}

async function buildReportMessage(client) {
  await saveUptime(client);

  const currentUptimeMinutes = Math.floor((client && typeof client.uptime === 'number' ? client.uptime : 0) / 60000);
  const { totalUptimeMinutes, totalDowntimeMinutes } = getUptimeTotals();
  const errorSection = await buildErrorSection();

  const header =
    `Current uptime: \`${formatDuration(currentUptimeMinutes)}\`\n` +
    `Total uptime: \`${formatDuration(totalUptimeMinutes)}\`\n` +
    `Total downtime: \`${formatDuration(totalDowntimeMinutes)}\`\n\n`;

  return `${header}Weekly error report:\n${errorSection}`;
}

async function sendReport(client, reportText) {
  const config = getConfig();
  const channel = client && client.channels && client.channels.cache.get(config.logChannelId);
  if (!channel) return;

  const chunks = splitMessageIntoChunks(reportText, DEFAULT_DISCORD_CHUNK_SIZE);
  for (const chunk of chunks) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await channel.send(chunk);
    } catch (err) {
      await logError('Error sending error report chunk', err);
      break;
    }
  }
}

async function postErrorReport(client) {
  try {
    const report = await buildReportMessage(client);
    await sendReport(client, report);
    logInfo('Weekly error report posted.');
  } catch (error) {
    await logError('Error posting error report', error);
  }
}

module.exports = { postErrorReport };
