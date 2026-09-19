const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  initializeVersionTracker,
  buildRuntimeSnapshot,
} = require('../src/versioning/versionTracker');

function makeProject() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'winterbot-version-')
  );

  fs.mkdirSync(path.join(dir, 'src'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dir, 'tests'), {
    recursive: true,
  });

  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'winterbot-test',
        version: '2.6.1',
        dependencies: {
          'discord.js': '^14.27.0',
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(dir, 'package-lock.json'),
    '{"lockfileVersion":3}\n'
  );
  fs.writeFileSync(
    path.join(dir, 'WinterBot.js'),
    "require('./src/a');\n"
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'a.js'),
    "module.exports = 'a';\n"
  );
  fs.writeFileSync(
    path.join(dir, 'tests', 'ignored.test.js'),
    "module.exports = 'ignored';\n"
  );

  return dir;
}

function readState(dir) {
  return JSON.parse(
    fs.readFileSync(
      path.join(dir, '.versionState.json'),
      'utf8'
    )
  );
}

function cleanup(dir) {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
  });
}

test('legacy state migrates to the package release without an accidental bump', () => {
  const dir = makeProject();

  try {
    fs.writeFileSync(
      path.join(dir, '.versionState.json'),
      JSON.stringify({
        signature: 'legacy-size-mtime-signature',
        fileCount: 21,
      })
    );

    const result = initializeVersionTracker({
      baseDir: dir,
    });
    const state = readState(dir);

    assert.equal(result.version, '2.6.1');
    assert.equal(result.action, 'initialized');
    assert.equal(state.schemaVersion, 2);
    assert.equal(state.baseVersion, '2.6.1');
    assert.equal(state.version, '2.6.1');
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(dir, '.versionState.json.bak'),
          'utf8'
        )
      ).version,
      '2.6.1'
    );
  } finally {
    cleanup(dir);
  }
});

test('mtime-only changes and ignored test files do not bump the version', () => {
  const dir = makeProject();

  try {
    assert.equal(
      initializeVersionTracker({ baseDir: dir }).version,
      '2.6.1'
    );

    const sourcePath = path.join(
      dir,
      'src',
      'a.js'
    );
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(sourcePath, future, future);

    let result = initializeVersionTracker({
      baseDir: dir,
    });
    assert.equal(result.version, '2.6.1');
    assert.equal(result.action, 'unchanged');

    fs.writeFileSync(
      path.join(dir, 'tests', 'ignored.test.js'),
      "module.exports = 'changed test only';\n"
    );

    result = initializeVersionTracker({
      baseDir: dir,
    });
    assert.equal(result.version, '2.6.1');
    assert.equal(result.action, 'unchanged');
  } finally {
    cleanup(dir);
  }
});

test('runtime content edits patch-bump and source-file structure changes minor-bump', () => {
  const dir = makeProject();

  try {
    initializeVersionTracker({ baseDir: dir });

    fs.writeFileSync(
      path.join(dir, 'src', 'a.js'),
      "module.exports = 'changed';\n"
    );

    let result = initializeVersionTracker({
      baseDir: dir,
    });
    assert.equal(result.version, '2.6.2');
    assert.equal(result.action, 'patch');

    fs.writeFileSync(
      path.join(dir, 'src', 'b.js'),
      "module.exports = 'new runtime file';\n"
    );

    result = initializeVersionTracker({
      baseDir: dir,
    });
    assert.equal(result.version, '2.7.0');
    assert.equal(result.action, 'minor');
  } finally {
    cleanup(dir);
  }
});

test('package manifest changes patch-bump but package-lock housekeeping is ignored', () => {
  const dir = makeProject();

  try {
    initializeVersionTracker({ baseDir: dir });

    fs.writeFileSync(
      path.join(dir, 'package-lock.json'),
      '{"lockfileVersion":3,"npmTouched":true}\n'
    );

    let result = initializeVersionTracker({
      baseDir: dir,
    });
    assert.equal(result.version, '2.6.1');
    assert.equal(result.action, 'unchanged');

    const packagePath = path.join(
      dir,
      'package.json'
    );
    const pkg = JSON.parse(
      fs.readFileSync(packagePath, 'utf8')
    );
    pkg.dependencies.dotenv = '^16.6.1';
    fs.writeFileSync(
      packagePath,
      JSON.stringify(pkg, null, 2)
    );

    result = initializeVersionTracker({
      baseDir: dir,
    });
    assert.equal(result.version, '2.6.2');
    assert.equal(result.action, 'patch');
  } finally {
    cleanup(dir);
  }
});

test('a formal package release establishes a new baseline without double-bumping', () => {
  const dir = makeProject();

  try {
    initializeVersionTracker({ baseDir: dir });

    fs.writeFileSync(
      path.join(dir, 'src', 'a.js'),
      "module.exports = 'changed';\n"
    );
    assert.equal(
      initializeVersionTracker({ baseDir: dir })
        .version,
      '2.6.2'
    );

    const packagePath = path.join(
      dir,
      'package.json'
    );
    const pkg = JSON.parse(
      fs.readFileSync(packagePath, 'utf8')
    );
    pkg.version = '2.7.0';
    fs.writeFileSync(
      packagePath,
      JSON.stringify(pkg, null, 2)
    );

    const result = initializeVersionTracker({
      baseDir: dir,
    });

    assert.equal(result.version, '2.7.0');
    assert.equal(
      result.action,
      'release-baseline'
    );
    assert.equal(
      initializeVersionTracker({
        baseDir: dir,
      }).version,
      '2.7.0'
    );
  } finally {
    cleanup(dir);
  }
});

test('a corrupt primary state recovers from the last valid state backup', () => {
  const dir = makeProject();

  try {
    initializeVersionTracker({ baseDir: dir });

    fs.writeFileSync(
      path.join(dir, 'src', 'a.js'),
      "module.exports = 'changed';\n"
    );
    assert.equal(
      initializeVersionTracker({ baseDir: dir })
        .version,
      '2.6.2'
    );

    fs.writeFileSync(
      path.join(dir, '.versionState.json'),
      '{broken json'
    );

    const recovered =
      initializeVersionTracker({
        baseDir: dir,
      });

    assert.equal(recovered.version, '2.6.2');
  } finally {
    cleanup(dir);
  }
});

test('runtime snapshot tracks only production JS and package.json', () => {
  const dir = makeProject();

  try {
    const snapshot =
      buildRuntimeSnapshot(dir);

    assert.deepEqual(
      snapshot.trackedFiles,
      [
        'package.json',
        'src/a.js',
        'WinterBot.js',
      ]
    );
  } finally {
    cleanup(dir);
  }
});

test('a schema-damaged primary state also recovers from the modern backup', () => {
  const dir = makeProject();

  try {
    initializeVersionTracker({ baseDir: dir });

    fs.writeFileSync(
      path.join(dir, 'src', 'a.js'),
      "module.exports = 'changed';\n"
    );
    assert.equal(
      initializeVersionTracker({ baseDir: dir })
        .version,
      '2.6.2'
    );

    fs.writeFileSync(
      path.join(dir, '.versionState.json'),
      JSON.stringify({
        schemaVersion: 2,
        baseVersion: 'broken',
        version: 'also-broken',
      })
    );

    const recovered =
      initializeVersionTracker({
        baseDir: dir,
      });

    assert.equal(recovered.version, '2.6.2');
  } finally {
    cleanup(dir);
  }
});
