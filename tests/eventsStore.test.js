const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEventStore } = require('../src/persistence/eventsStore');

test('normalizeEventStore upgrades legacy username keyed data', () => {
  const normalized = normalizeEventStore({
    '123': {
      eventName: 'Party',
      subscribedUsers: {
        Mica: { timestamp: 10, apiCheckCounter: 2 },
      },
      unsubscribedUsers: {
        Winter: 20,
      },
    },
  });

  assert.equal(normalized['123'].subscribedUsers.Mica.userId, 'Mica');
  assert.equal(normalized['123'].subscribedUsers.Mica.lastKnownDisplayName, 'Mica');
  assert.equal(normalized['123'].unsubscribedUsers.Winter.timestamp, 20);
});
