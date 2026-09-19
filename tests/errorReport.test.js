const test = require('node:test');
const assert = require('node:assert/strict');
const {
  summarizeErrors,
  buildUptimeLines,
} = require('../src/reporting/errorReport');

test('summarizeErrors groups by signature and counts correctly', () => {
  const result = summarizeErrors([
    {
      level: 'error',
      source: 'a',
      message: 'boom',
      timestamp: '1',
      metadata: { signature: 'sig1' },
    },
    {
      level: 'error',
      source: 'a',
      message: 'boom',
      timestamp: '2',
      metadata: { signature: 'sig1' },
    },
    {
      level: 'warn',
      source: 'b',
      message: 'oops',
      timestamp: '3',
      metadata: { signature: 'sig2' },
    },
  ]);

  assert.equal(result[0].count, 2);
  assert.equal(result[0].source, 'a');
  assert.equal(result[1].count, 1);
});

test('weekly report uptime formatting uses the live uptime formatter', () => {
  assert.deepEqual(
    buildUptimeLines(65, 1500, 30),
    [
      'Uptime',
      '- Current uptime: 1 hour, 5 minutes',
      '- Total uptime: 1 day, 1 hour',
      '- Total downtime: 30 minutes',
    ]
  );
});
