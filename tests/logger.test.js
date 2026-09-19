const test = require('node:test');
const assert = require('node:assert/strict');
const { splitMessageIntoChunks, normalizeErrorSignature } = require('../src/logging/logger');

test('splitMessageIntoChunks keeps line boundaries where possible', () => {
  const message = ['alpha', 'beta', 'gamma', 'delta'].join('\n');
  const chunks = splitMessageIntoChunks(message, 11);
  assert.deepEqual(chunks, ['alpha\nbeta', 'gamma\ndelta']);
});

test('normalizeErrorSignature uses first error line', () => {
  const signature = normalizeErrorSignature('source', new Error('Boom'));
  assert.match(signature, /^source \| Error: Boom/);
});
