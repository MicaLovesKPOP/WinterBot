const test = require('node:test');
const assert = require('node:assert/strict');
const { USER_DISPLAY_MODES } = require('../src/config');
const { formatUserDisplay } = require('../src/discord/display');

test('formatUserDisplay prefers display name', () => {
  const result = formatUserDisplay({
    member: { displayName: 'Winter', user: { username: 'winter_bot' } },
    mode: USER_DISPLAY_MODES.DISPLAY_NAME,
  });
  assert.equal(result, 'Winter');
});

test('formatUserDisplay prefers username', () => {
  const result = formatUserDisplay({
    member: { displayName: 'Winter', user: { username: 'winter_bot' } },
    mode: USER_DISPLAY_MODES.USERNAME,
  });
  assert.equal(result, 'winter_bot');
});

test('formatUserDisplay shows both without duplicates', () => {
  assert.equal(
    formatUserDisplay({
      member: { displayName: 'Winter', user: { username: 'winter_bot' } },
      mode: USER_DISPLAY_MODES.BOTH,
    }),
    'Winter (winter_bot)'
  );

  assert.equal(
    formatUserDisplay({
      member: { displayName: 'Winter', user: { username: 'Winter' } },
      mode: USER_DISPLAY_MODES.BOTH,
    }),
    'Winter'
  );
});
