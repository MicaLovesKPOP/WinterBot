const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerError,
  buildDailySummary,
  clearErrorRegistry,
} = require('../src/logging/errorRegistry');

test('daily summaries are not cleared until delivery is acknowledged', () => {
  clearErrorRegistry();

  registerError({
    source: 'test.delivery',
    message: 'keep me',
    timestamp: Date.now(),
  });

  const first = buildDailySummary();
  const second = buildDailySummary();

  assert.match(first, /test\.delivery/);
  assert.equal(second, first);

  clearErrorRegistry();
  assert.equal(buildDailySummary(), null);
});
