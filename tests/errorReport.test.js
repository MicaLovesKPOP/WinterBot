const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeErrors } = require('../src/reporting/errorReport');

test('summarizeErrors groups by signature and counts correctly', () => {
  const result = summarizeErrors([
    { level: 'error', source: 'a', message: 'boom', timestamp: '1', metadata: { signature: 'sig1' } },
    { level: 'error', source: 'a', message: 'boom', timestamp: '2', metadata: { signature: 'sig1' } },
    { level: 'warn', source: 'b', message: 'oops', timestamp: '3', metadata: { signature: 'sig2' } },
  ]);

  assert.equal(result[0].count, 2);
  assert.equal(result[0].source, 'a');
  assert.equal(result[1].count, 1);
});
