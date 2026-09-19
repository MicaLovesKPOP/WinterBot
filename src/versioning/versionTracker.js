const fs = require('fs');
const path = require('path');

const packageFile = path.resolve(__dirname, '..', '..', 'package.json');
const stateFile = path.resolve(__dirname, '..', '..', '.versionState.json');

let cachedVersion = '0.0.0';
let initialized = false;

function getAllJsFiles(dir, collected = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'logs'].includes(entry.name)) continue;
      getAllJsFiles(fullPath, collected);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.js')) {
      const stats = fs.statSync(fullPath);
      collected.push({
        path: fullPath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    }
  }

  return collected;
}

function buildSignature(baseDir) {
  const files = getAllJsFiles(baseDir).sort((left, right) => left.path.localeCompare(right.path));
  const signature = files.map((file) => `${file.path}:${file.size}:${file.mtimeMs}`).join('|');
  return {
    signature,
    fileCount: files.length,
  };
}

function readPackageJson() {
  try {
    const raw = fs.readFileSync(packageFile, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return { name: 'winterbot', version: '0.0.0' };
  }
}

function writePackageJson(pkg) {
  fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2), 'utf8');
}

function readState() {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return { signature: '', fileCount: 0 };
  }
}

function writeState(state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

function bumpVersion(currentVersion, bumpType = 'patch') {
  let [major, minor, patch] = String(currentVersion || '0.0.0')
    .split('.')
    .map((value) => Number.parseInt(value, 10) || 0);

  if (bumpType === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }

  return `${major}.${minor}.${patch}`;
}

function initializeVersionTracker() {
  if (initialized) return { version: cachedVersion };

  const pkg = readPackageJson();
  const previousState = readState();
  const currentState = buildSignature(path.resolve(__dirname, '..', '..'));

  if (!pkg.version) {
    pkg.version = '0.0.0';
  }

if (!previousState.signature) {
  pkg.version = bumpVersion(pkg.version, 'patch');
  writePackageJson(pkg);
  writeState(currentState);
  cachedVersion = String(pkg.version);
  initialized = true;
  return { version: cachedVersion };
}

  if (currentState.signature !== previousState.signature) {
    const bumpType = currentState.fileCount !== previousState.fileCount ? 'minor' : 'patch';
    pkg.version = bumpVersion(pkg.version, bumpType);
    writePackageJson(pkg);
    writeState(currentState);
  }

  cachedVersion = String(pkg.version);
  initialized = true;
  return { version: cachedVersion };
}

function getVersion() {
  return cachedVersion;
}

module.exports = { initializeVersionTracker, getVersion };