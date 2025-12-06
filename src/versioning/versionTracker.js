// Version tracking based on WinterBot.js modification time.
// Preserves original behaviour of auto-incrementing the patch version when the
// entry file's mtime changes, storing the current version and last mtime in
// version.txt.

const fs = require('fs');
const path = require('path');

const versionFile = path.resolve(__dirname, '..', '..', 'version.txt');
const botFile = path.resolve(__dirname, '..', '..', 'WinterBot.js');

let botVersion = '1.0.0';
let lastBotMTime = 0;
let initialized = false;

function applyVersionCheck() {
  try {
    if (fs.existsSync(versionFile)) {
      const saved = fs.readFileSync(versionFile, 'utf8').split(',');
      if (saved.length === 2) {
        botVersion = saved[0];
        lastBotMTime = Number(saved[1]) || 0;
      }
    }

    const stats = fs.statSync(botFile);
    const mtimeMs = stats.mtimeMs;

    if (mtimeMs > lastBotMTime) {
      const parts = botVersion.split('.').map(Number);
      if (parts.length === 3) {
        parts[2] += 1;
        botVersion = parts.join('.');
      } else {
        botVersion += '.0.1';
      }
      try {
        fs.writeFileSync(versionFile, `${botVersion},${mtimeMs}`, 'utf8');
        lastBotMTime = mtimeMs;
      } catch (_) {}
    }
  } catch (err) {
    try {
      console.error('Version-check failed:', err && err.message ? err.message : err);
    } catch (_) {}
  }

  return { version: botVersion, lastModified: lastBotMTime };
}

function initializeVersionTracker() {
  if (initialized) {
    return { version: botVersion, lastModified: lastBotMTime };
  }
  initialized = true;
  return applyVersionCheck();
}

function updateVersionIfNeeded() {
  return applyVersionCheck();
}

function getVersion() {
  return botVersion;
}

module.exports = {
  initializeVersionTracker,
  updateVersionIfNeeded,
  getVersion,
};
