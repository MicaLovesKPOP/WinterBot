const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseInteger,
  validateSnowflake,
} = require('../src/config');

test('parseInteger accepts bounded integers and rejects malformed values', () => {
  assert.equal(
    parseInteger('15', 10, { min: 1, max: 20 }),
    15
  );

  assert.equal(
    parseInteger('', 10, { min: 1, max: 20 }),
    10
  );

  assert.throws(
    () =>
      parseInteger('15oops', 10, {
        min: 1,
        max: 20,
      }),
    /Invalid integer/
  );

  assert.throws(
    () =>
      parseInteger('21', 10, {
        min: 1,
        max: 20,
      }),
    /at most 20/
  );
});

test('validateSnowflake rejects malformed Discord IDs', () => {
  assert.equal(
    validateSnowflake(
      '199916140183420928',
      'TEST_ID'
    ),
    '199916140183420928'
  );

  assert.throws(
    () => validateSnowflake('abc', 'TEST_ID'),
    /valid Discord snowflake/
  );
});
