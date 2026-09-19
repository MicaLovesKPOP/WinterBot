const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getStatusLabel,
  toSubscriberRecord,
  fitEventContent,
  upsertEventMessage,
  selectContinuousSubscriberRecord,
  reconcileRemovedEvents,
} = require('../src/discord/scheduledEvents');

test('getStatusLabel maps Discord statuses', () => {
  assert.equal(getStatusLabel(1), '(upcoming)');
  assert.equal(getStatusLabel(2), '(currently happening)');
  assert.equal(getStatusLabel(3), '(past event)');
  assert.equal(getStatusLabel(4), '(canceled)');
});

test('toSubscriberRecord preserves timestamp for continuous subscriptions', () => {
  const record = toSubscriberRecord(
    {
      user: { id: '1', username: 'mica' },
      member: { nick: 'Mica' },
    },
    {
      userId: '1',
      timestamp: 50,
      lastKnownUsername: 'old',
      lastKnownDisplayName: 'Old',
    }
  );

  assert.equal(record.userId, '1');
  assert.equal(record.timestamp, 50);
  assert.equal(record.lastKnownUsername, 'mica');
  assert.equal(record.lastKnownDisplayName, 'Mica');
});

test('re-registration does not reuse deregistration history as subscription history', () => {
  const eventRecord = {
    subscribedUsers: {},
    unsubscribedUsers: {
      '1': {
        userId: '1',
        timestamp: 50,
      },
    },
  };

  assert.equal(
    selectContinuousSubscriberRecord(eventRecord, '1'),
    null
  );

  const before = Date.now();
  const record = toSubscriberRecord(
    { user: { id: '1', username: 'mica' } },
    selectContinuousSubscriberRecord(eventRecord, '1')
  );

  assert.ok(record.timestamp >= before);
  assert.notEqual(record.timestamp, 50);
});

test('fitEventContent always respects the Discord message limit', () => {
  const registeredLines = Array.from(
    { length: 200 },
    (_, index) => `${index + 1}. player_${index}_${'x'.repeat(30)}`
  );

  const content = fitEventContent(
    '**Registered players for Stress Test** (upcoming):',
    registeredLines,
    ['former_player'],
    500
  );

  assert.ok(content.length <= 500);
  assert.match(content, /more registered player/);
});

test('upsertEventMessage recreates only an actually missing Discord message', async () => {
  let sends = 0;
  const channel = {
    messages: {
      fetch: async () => {
        const error = new Error('Unknown Message');
        error.code = 10008;
        throw error;
      },
    },
    send: async () => {
      sends += 1;
      return { id: 'new-message', content: 'content' };
    },
  };

  const record = { messageId: 'old-message' };
  const result = await upsertEventMessage(
    channel,
    record,
    'content'
  );

  assert.equal(result.created, true);
  assert.equal(record.messageId, 'new-message');
  assert.equal(sends, 1);
});

test('upsertEventMessage propagates transient/permission failures instead of duplicating', async () => {
  let sends = 0;
  const channel = {
    messages: {
      fetch: async () => {
        const error = new Error('Missing Permissions');
        error.code = 50013;
        throw error;
      },
    },
    send: async () => {
      sends += 1;
      return { id: 'duplicate' };
    },
  };

  await assert.rejects(
    upsertEventMessage(
      channel,
      { messageId: 'existing' },
      'content'
    ),
    /Missing Permissions/
  );

  assert.equal(sends, 0);
});

test('removed events require consecutive missing polls before deletion', async () => {
  const eventData = {
    event1: {
      eventName: 'Party',
      eventMessage: '**Registered players for Party** ',
      eventStatus: '(upcoming)',
      messageId: '',
      subscribedUsers: {},
      unsubscribedUsers: {},
      missingEventPolls: 0,
    },
  };

  let sends = 0;
  const channel = {
    send: async (content) => {
      sends += 1;
      return { id: 'past-message', content };
    },
  };

  const config = {
    missingEventGraceCycles: 3,
    userDisplayMode: 2,
  };

  await reconcileRemovedEvents(
    {},
    channel,
    eventData,
    new Set(),
    config
  );
  assert.ok(eventData.event1);
  assert.equal(eventData.event1.missingEventPolls, 1);

  await reconcileRemovedEvents(
    {},
    channel,
    eventData,
    new Set(),
    config
  );
  assert.ok(eventData.event1);
  assert.equal(eventData.event1.missingEventPolls, 2);

  await reconcileRemovedEvents(
    {},
    channel,
    eventData,
    new Set(),
    config
  );
  assert.equal(eventData.event1, undefined);
  assert.equal(sends, 1);
});
