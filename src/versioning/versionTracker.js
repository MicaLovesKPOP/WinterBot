const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_SCHEMA_VERSION = 2;
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const STATE_FILE_NAME = '.versionState.json';
const STATE_BACKUP_FILE_NAME = '.versionState.json.bak';

let cachedVersion = '0.0.0';

function normalizeRelativePath(baseDir, filePath) {
  return path.relative(baseDir, filePath).split(path.sep).join('/');
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || '').trim());
  if (!match) {
    throw new Error(
      `Invalid WinterBot version "${version}". Expected MAJOR.MINOR.PATCH.`
    );
  }

  return match.slice(1).map((value) => Number(value));
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }

  return 0;
}

function bumpVersion(version, bumpType = 'patch') {
  let [major, minor, patch] = parseVersion(version);

  if (bumpType === 'minor') {
    minor += 1;
    patch = 0;
  } else if (bumpType === 'patch') {
    patch += 1;
  } else {
    throw new Error(`Unsupported automatic version bump type: ${bumpType}.`);
  }

  return `${major}.${minor}.${patch}`;
}

function collectRuntimeSourceFiles(baseDir) {
  const files = [];
  const entryFile = path.join(baseDir, 'WinterBot.js');

  if (fs.existsSync(entryFile)) {
    files.push(entryFile);
  }

  const srcDir = path.join(baseDir, 'src');
  if (!fs.existsSync(srcDir)) return files;

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(fullPath);
      }
    }
  }

  walk(srcDir);
  return files;
}

function buildRuntimeSnapshot(baseDir = PROJECT_ROOT) {
  const sourceFiles = collectRuntimeSourceFiles(baseDir);
  const trackedFiles = [...sourceFiles];

  const packageManifest = path.join(baseDir, 'package.json');
  if (fs.existsSync(packageManifest)) {
    trackedFiles.push(packageManifest);
  }

  const uniqueTrackedFiles = Array.from(new Set(trackedFiles))
    .sort((left, right) =>
      normalizeRelativePath(baseDir, left).localeCompare(
        normalizeRelativePath(baseDir, right)
      )
    );

  const hasher = crypto.createHash('sha256');

  for (const filePath of uniqueTrackedFiles) {
    const relativePath = normalizeRelativePath(baseDir, filePath);
    hasher.update(relativePath);
    hasher.update('\0');
    hasher.update(fs.readFileSync(filePath));
    hasher.update('\0');
  }

  return {
    contentHash: hasher.digest('hex'),
    sourceFiles: sourceFiles
      .map((filePath) => normalizeRelativePath(baseDir, filePath))
      .sort(),
    trackedFiles: uniqueTrackedFiles.map((filePath) =>
      normalizeRelativePath(baseDir, filePath)
    ),
  };
}

function readPackageVersion(baseDir = PROJECT_ROOT) {
  const packageFile = path.join(baseDir, 'package.json');
  const raw = fs.readFileSync(packageFile, 'utf8');
  const pkg = JSON.parse(raw);
  const version = String(pkg.version || '').trim();

  parseVersion(version);
  return version;
}

function isCurrentState(state) {
  if (!state || typeof state !== 'object') return false;

  try {
    parseVersion(state.baseVersion);
    parseVersion(state.version);
  } catch (_) {
    return false;
  }

  return (
    state.schemaVersion === STATE_SCHEMA_VERSION &&
    typeof state.contentHash === 'string' &&
    state.contentHash.length > 0 &&
    Array.isArray(state.sourceFiles) &&
    state.sourceFiles.every((value) => typeof value === 'string')
  );
}

function sameStringArray(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function createState(packageVersion, runtimeVersion, snapshot) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    baseVersion: packageVersion,
    version: runtimeVersion,
    contentHash: snapshot.contentHash,
    sourceFiles: [...snapshot.sourceFiles],
    trackedFiles: [...snapshot.trackedFiles],
  };
}

function resolveVersionState(packageVersion, previousState, snapshot) {
  parseVersion(packageVersion);

  if (!isCurrentState(previousState)) {
    return {
      action: 'initialized',
      state: createState(packageVersion, packageVersion, snapshot),
    };
  }

  if (previousState.baseVersion !== packageVersion) {
    const runtimeVersion =
      compareVersions(packageVersion, previousState.version) >= 0
        ? packageVersion
        : previousState.version;

    return {
      action: 'release-baseline',
      state: createState(packageVersion, runtimeVersion, snapshot),
    };
  }

  if (previousState.contentHash === snapshot.contentHash) {
    return {
      action: 'unchanged',
      state: {
        ...previousState,
        trackedFiles: [...snapshot.trackedFiles],
      },
    };
  }

  const sourceStructureChanged = !sameStringArray(
    previousState.sourceFiles,
    snapshot.sourceFiles
  );
  const bumpType = sourceStructureChanged ? 'minor' : 'patch';

  return {
    action: bumpType,
    state: createState(
      packageVersion,
      bumpVersion(previousState.version, bumpType),
      snapshot
    ),
  };
}

function getStatePaths(baseDir = PROJECT_ROOT) {
  return {
    stateFile: path.join(baseDir, STATE_FILE_NAME),
    backupFile: path.join(baseDir, STATE_BACKUP_FILE_NAME),
    tempFile: path.join(baseDir, `${STATE_FILE_NAME}.tmp`),
  };
}

function tryReadJson(filePath) {
  try {
    return {
      found: true,
      value: JSON.parse(fs.readFileSync(filePath, 'utf8')),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { found: false, value: null };
    }
    return { found: true, value: null, error };
  }
}

function readPreviousState(baseDir = PROJECT_ROOT) {
  const { stateFile, backupFile } = getStatePaths(baseDir);
  const primary = tryReadJson(stateFile);

  if (primary.found && primary.value && isCurrentState(primary.value)) {
    return primary.value;
  }

  const backup = tryReadJson(backupFile);
  if (backup.found && backup.value && isCurrentState(backup.value)) {
    const looksLikeLegacyState = Boolean(
      primary.value &&
        typeof primary.value.signature === 'string' &&
        Number.isFinite(Number(primary.value.fileCount))
    );

    if (!looksLikeLegacyState) {
      return backup.value;
    }
  }

  return primary.value || backup.value || null;
}

function writeState(baseDir, state, { seedBackup = false } = {}) {
  const { stateFile, backupFile, tempFile } = getStatePaths(baseDir);

  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), 'utf8');

  if (!seedBackup && fs.existsSync(stateFile)) {
    try {
      const current = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (isCurrentState(current)) {
        fs.copyFileSync(stateFile, backupFile);
      }
    } catch (_) {}
  }

  try {
    fs.renameSync(tempFile, stateFile);
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) {
      throw error;
    }

    fs.rmSync(stateFile, { force: true });
    fs.renameSync(tempFile, stateFile);
  }

  if (seedBackup) {
    fs.copyFileSync(stateFile, backupFile);
  }
}

function initializeVersionTracker({ baseDir = PROJECT_ROOT } = {}) {
  const packageVersion = readPackageVersion(baseDir);
  const snapshot = buildRuntimeSnapshot(baseDir);
  const previousState = readPreviousState(baseDir);
  const result = resolveVersionState(packageVersion, previousState, snapshot);

  if (result.action !== 'unchanged') {
    writeState(baseDir, result.state, {
      seedBackup:
        result.action === 'initialized' ||
        result.action === 'release-baseline',
    });
  }

  cachedVersion = result.state.version;

  return {
    version: cachedVersion,
    action: result.action,
  };
}

function getVersion() {
  return cachedVersion;
}

module.exports = {
  initializeVersionTracker,
  getVersion,
  buildRuntimeSnapshot,
  resolveVersionState,
  bumpVersion,
  compareVersions,
  isCurrentState,
};
