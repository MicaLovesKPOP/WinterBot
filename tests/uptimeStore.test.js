const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatDurationFromMinutes,
  calculateSessionDelta,
  recoverUptimeFromAnchor,
} = require('../src/persistence/uptimeStore');

const REPAIR_ANCHOR = {
  anchorLastSavedAt: 1775466023011,
  anchorUptimeMinutes: 288551,
  anchorDowntimeMinutes: 8652,
};

test('formatDurationFromMinutes reproduces the corrupt display accurately', () => {
  assert.equal(
    formatDurationFromMinutes(2457714207),
    '4676 years, 5 days, 23 hours'
  );
});

test('session accounting adds only newly elapsed session minutes', () => {
  assert.equal(calculateSessionDelta(1, 0), 1);
  assert.equal(calculateSessionDelta(2, 1), 1);
  assert.equal(calculateSessionDelta(61, 60), 1);
  assert.equal(calculateSessionDelta(61, 61), 0);
});

test('session accounting handles an unexpected session counter reset', () => {
  assert.equal(calculateSessionDelta(2, 120), 2);
});

test('repair reconstructs the exact frozen Sep 19 checkpoint', () => {
  const recovered = recoverUptimeFromAnchor(
    {
      totalDowntimeMinutes: 26633,
      lastSavedAt: 1789810113216,
    },
    REPAIR_ANCHOR
  );

  assert.equal(recovered, 509638);
  assert.equal(
    formatDurationFromMinutes(recovered, 5),
    '11 months, 3 weeks, 2 days, 21 hours, 58 minutes'
  );
});

test('repair also matches the earlier production archive checkpoint', () => {
  const recovered = recoverUptimeFromAnchor(
    {
      totalDowntimeMinutes: 26630,
      lastSavedAt: 1789805644782,
    },
    REPAIR_ANCHOR
  );

  assert.equal(recovered, 509566);
});

test('repair rejects an incompatible anchor', () => {
  assert.throws(
    () =>
      recoverUptimeFromAnchor(
        {
          totalDowntimeMinutes: 100,
          lastSavedAt: 1000,
        },
        {
          anchorLastSavedAt: 2000,
          anchorUptimeMinutes: 50,
          anchorDowntimeMinutes: 10,
        }
      ),
    /incompatible/
  );
});
