const test = require('node:test');
const assert = require('node:assert/strict');
const { getStatusLabel, toSubscriberRecord } = require('../src/discord/scheduledEvents');

test('getStatusLabel maps Discord statuses', () => {
  assert.equal(getStatusLabel(1), '(upcoming)');
  assert.equal(getStatusLabel(2), '(currently happening)');
  assert.equal(getStatusLabel(3), '(past event)');
});

test('toSubscriberRecord preserves prior timestamp while updating names', () => {
  const record = toSubscriberRecord(
    { user: { id: '1', username: 'mica' }, member: { nick: 'Mica' } },
    { userId: '1', timestamp: 50, lastKnownUsername: 'old', lastKnownDisplayName: 'Old' }
  );

  assert.equal(record.userId, '1');
  assert.equal(record.timestamp, 50);
  assert.equal(record.lastKnownUsername, 'mica');
  assert.equal(record.lastKnownDisplayName, 'Mica');
});
