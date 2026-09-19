const fs = require('fs');
const path = require('path');

const packageFile = path.resolve(__dirname, '..', '..', 'package.json');

let cachedVersion = '0.0.0';

function readPackageVersion() {
  try {
    const raw = fs.readFileSync(packageFile, 'utf8');
    const pkg = JSON.parse(raw);
    return String(pkg.version || '0.0.0');
  } catch (_) {
    return '0.0.0';
  }
}

function initializeVersionTracker() {
  cachedVersion = readPackageVersion();
  return { version: cachedVersion };
}

function getVersion() {
  if (cachedVersion === '0.0.0') {
    cachedVersion = readPackageVersion();
  }
  return cachedVersion;
}

module.exports = { initializeVersionTracker, getVersion };
