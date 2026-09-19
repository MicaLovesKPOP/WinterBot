const errorRegistry = new Map();

const ERROR_GROUPS = [
  {
    name: 'Discord/API connectivity issues',
    patterns: [
      'service unavailable',
      'internal server error',
      'gateway timeout',
      'bad gateway',
      'getaddrinfo',
      'enotfound',
      'eai_again',
      'econnreset',
      'etimedout',
      'socket hang up',
      'fetch failed',
      'request aborted',
      'this operation was aborted',
      'operation was aborted',
      'aborted',
      'timeout',
      'http 500',
      'http 502',
      'http 503',
      'http 504',
    ],
  },
  {
    name: 'Discord/API rate limit issues',
    patterns: [
      'rate limited',
      'rate limit',
      'too many requests',
      'http 429',
      '429',
    ],
  },
  {
    name: 'Storage/persistence issues',
    patterns: [
      'enospc',
      'no space left',
      'unexpected end of json input',
      'json',
      'permission denied',
      'eacces',
      'enoent',
      'write failed',
      'read failed',
    ],
  },
  {
    name: 'Discord permission/configuration issues',
    patterns: [
      'missing permissions',
      'forbidden',
      'unauthorized',
      'unknown channel',
      'unknown guild',
      'unknown message',
      'missing access',
      'invalid token',
      'missing required configuration',
    ],
  },
  {
    name: 'Bot/runtime errors',
    patterns: [
      'typeerror',
      'referenceerror',
      'syntaxerror',
      'rangeerror',
      'cannot read',
      'cannot access',
      'is not a function',
      'is not iterable',
      'undefined',
      'null',
    ],
  },
];

function normalizeSignature(source, message) {
  return `${source} | ${message}`;
}

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

function classifyError(record) {
  const text = normalizeText(`${record.source} ${record.message}`);

  for (const group of ERROR_GROUPS) {
    if (group.patterns.some((pattern) => text.includes(pattern))) {
      return group.name;
    }
  }

  return 'Other errors';
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString();
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString();
}

function registerError({ source, message, metadata = {}, timestamp = Date.now(), maxSize = 500 }) {
  const signature = normalizeSignature(source, message);
  let record = errorRegistry.get(signature);

  if (!record) {
    record = {
      source,
      message,
      count: 1,
      firstTimestamp: timestamp,
      lastTimestamp: timestamp,
      metadata,
    };

    errorRegistry.set(signature, record);

    if (errorRegistry.size > maxSize) {
      const oldestKey = [...errorRegistry.entries()].reduce((left, right) =>
        left[1].firstTimestamp <= right[1].firstTimestamp ? left : right
      )[0];

      errorRegistry.delete(oldestKey);
    }

    return { signature, record, isFirstOccurrence: true };
  }

  record.count += 1;
  record.lastTimestamp = timestamp;

  if (metadata && Object.keys(metadata).length > 0) {
    record.metadata = { ...record.metadata, ...metadata };
  }

  return { signature, record, isFirstOccurrence: false };
}

function buildGroupedSummary(records) {
  const groups = new Map();

  for (const record of records) {
    const groupName = classifyError(record);

    if (!groups.has(groupName)) {
      groups.set(groupName, {
        name: groupName,
        count: 0,
        firstTimestamp: record.firstTimestamp,
        lastTimestamp: record.lastTimestamp,
        records: [],
      });
    }

    const group = groups.get(groupName);
    group.count += record.count;
    group.firstTimestamp = Math.min(group.firstTimestamp, record.firstTimestamp);
    group.lastTimestamp = Math.max(group.lastTimestamp, record.lastTimestamp);
    group.records.push(record);
  }

  return [...groups.values()].sort((left, right) => right.count - left.count);
}

function buildDailySummary() {
  if (errorRegistry.size === 0) return null;

  const records = [...errorRegistry.values()];
  const groups = buildGroupedSummary(records);
  const reportDate = formatDate(Date.now());

  const lines = [`**Daily Error Report** - ${reportDate}`];

  for (const [groupIndex, group] of groups.entries()) {
    lines.push(
      `${groupIndex + 1}. ${group.name} — ${group.count}x ` +
      `(First: ${formatTime(group.firstTimestamp)}, Last: ${formatTime(group.lastTimestamp)})`
    );

    const sortedRecords = group.records.sort((left, right) => right.count - left.count);

    for (const record of sortedRecords) {
      lines.push(`   - ${record.source} — ${record.message} — ${record.count}x`);
    }
  }

  return lines.join('\n');
}

function clearErrorRegistry() {
  errorRegistry.clear();
}

function buildDailySummaryAndReset() {
  const summary = buildDailySummary();
  if (summary) clearErrorRegistry();
  return summary;
}

module.exports = {
  registerError,
  buildDailySummary,
  clearErrorRegistry,
  buildDailySummaryAndReset,
};