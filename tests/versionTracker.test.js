const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  initializeVersionTracker,
  getVersion,
} = require('../src/versioning/versionTracker');

test('version tracker reads package version without mutating package.json', () => {
  const packagePath = path.join(process.cwd(), 'package.json');
  const before = fs.readFileSync(packagePath, 'utf8');
  const packageVersion = JSON.parse(before).version;

  const result = initializeVersionTracker();
  const after = fs.readFileSync(packagePath, 'utf8');

  assert.equal(result.version, packageVersion);
  assert.equal(getVersion(), packageVersion);
  assert.equal(after, before);
});
