const test = require('node:test');
const assert = require('node:assert/strict');
const { USER_DISPLAY_MODES } = require('../src/config');
const {
  formatUserDisplay,
  sanitizeDisplayText,
} = require('../src/discord/display');

test('formatUserDisplay prefers display name', () => {
  const result = formatUserDisplay({
    member: {
      displayName: 'Winter',
      user: { username: 'winter_bot' },
    },
    mode: USER_DISPLAY_MODES.DISPLAY_NAME,
  });

  assert.equal(result, 'Winter');
});

test('formatUserDisplay escapes markdown in usernames', () => {
  const result = formatUserDisplay({
    member: {
      displayName: 'Winter',
      user: { username: 'winter_bot' },
    },
    mode: USER_DISPLAY_MODES.USERNAME,
  });

  assert.equal(result, 'winter\\_bot');
});

test('formatUserDisplay shows both without duplicate names', () => {
  assert.equal(
    formatUserDisplay({
      member: {
        displayName: 'Winter',
        user: { username: 'winter_bot' },
      },
      mode: USER_DISPLAY_MODES.BOTH,
    }),
    'Winter (winter\\_bot)'
  );

  assert.equal(
    formatUserDisplay({
      member: {
        displayName: 'Winter',
        user: { username: 'Winter' },
      },
      mode: USER_DISPLAY_MODES.BOTH,
    }),
    'Winter'
  );
});

test('sanitizeDisplayText neutralizes markdown characters', () => {
  assert.equal(
    sanitizeDisplayText('**admin** _name_'),
    '\\*\\*admin\\*\\* \\_name\\_'
  );
});
