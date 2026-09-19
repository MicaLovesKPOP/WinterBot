const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const eventsStorePath = path.join(
  process.cwd(),
  'src',
  'persistence',
  'eventsStore.js'
);

function runStoreScript(cwd, source) {
  return spawnSync(
    process.execPath,
    ['-e', source],
    {
      cwd,
      encoding: 'utf8',
    }
  );
}

test('event store restores a valid backup when data.json is corrupt', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'winterbot-events-')
  );

  try {
    fs.writeFileSync(
      path.join(tempDir, 'data.json'),
      '{ definitely not json',
      'utf8'
    );

    fs.writeFileSync(
      path.join(tempDir, 'data.json.bak'),
      JSON.stringify(
        {
          eventData: {
            event1: {
              eventName: 'Recovered Party',
              subscribedUsers: {},
              unsubscribedUsers: {},
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );

    const source = [
      `process.chdir(${JSON.stringify(tempDir)});`,
      `const store = require(${JSON.stringify(eventsStorePath)});`,
      'store.initializeEventsStore();',
      'store.loadEvents()',
      '.then((data) => {',
      "  console.log('RESULT:' + data.event1.eventName);",
      '})',
      '.catch((error) => {',
      "  console.error('ERROR:' + error.message);",
      '  process.exitCode = 2;',
      '});',
    ].join('\n');

    const result = runStoreScript(
      tempDir,
      source
    );

    assert.equal(
      result.status,
      0,
      result.stderr
    );
    assert.match(
      result.stdout,
      /RESULT:Recovered Party/
    );

    const restored = JSON.parse(
      fs.readFileSync(
        path.join(tempDir, 'data.json'),
        'utf8'
      )
    );

    assert.equal(
      restored.eventData.event1.eventName,
      'Recovered Party'
    );

    const corruptFiles = fs
      .readdirSync(tempDir)
      .filter((name) =>
        name.startsWith('data.json.corrupt.')
      );

    assert.equal(corruptFiles.length, 1);
  } finally {
    fs.rmSync(tempDir, {
      recursive: true,
      force: true,
    });
  }
});

test('event store refuses to erase corrupt state when no backup exists', () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'winterbot-events-')
  );

  try {
    const dataPath = path.join(
      tempDir,
      'data.json'
    );

    fs.writeFileSync(
      dataPath,
      '{ still broken',
      'utf8'
    );

    const source = [
      `process.chdir(${JSON.stringify(tempDir)});`,
      `const store = require(${JSON.stringify(eventsStorePath)});`,
      'store.initializeEventsStore();',
      'store.loadEvents()',
      ".then(() => { process.exitCode = 3; })",
      '.catch((error) => {',
      "  console.log('EXPECTED:' + error.message);",
      '});',
    ].join('\n');

    const result = runStoreScript(
      tempDir,
      source
    );

    assert.equal(
      result.status,
      0,
      result.stderr
    );
    assert.match(
      result.stdout,
      /refusing to start with empty state/
    );
    assert.equal(
      fs.readFileSync(dataPath, 'utf8'),
      '{ still broken'
    );
  } finally {
    fs.rmSync(tempDir, {
      recursive: true,
      force: true,
    });
  }
});
