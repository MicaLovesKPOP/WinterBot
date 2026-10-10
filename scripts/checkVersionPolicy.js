'use strict';

/**
 * Release policy guard.
 *
 * IMPORTANT: WinterBot assigns installation-local versions automatically
 * using src/versioning/versionTracker.js. Normal code changes must NEVER
 * edit package.json's version or the matching root package-lock versions.
 *
 * Run by npm test and by GitHub CI against the PR base or push-before SHA.
 * This protects the existing CI-gated DiscordBotHosting updater too.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SHA = /^[0-9a-f]{40}$/i;
const ZERO_SHA = /^0{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

// Historical package baseline when automatic-only policy was introduced.
// The runtime .versionState.json advances automatically above this value.
// This anchor is a guard, NEVER a release number to bump manually.
const FROZEN_PACKAGE_BASELINE = '2.8.0';

function readJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('Cannot read ' + label + ': ' + error.message);
  }
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    const reason = String(result.stderr || result.error?.message || 'git returned an error').trim();
    throw new Error('Version policy could not inspect Git (' + args.join(' ') + '): ' + reason);
  }
  return result.stdout.trim();
}

function tryGit(cwd, ...args) {
  try { return git(cwd, ...args); } catch (_) { return null; }
}

function determineBaseRef({ cwd, env = process.env }) {
  const supplied = String(env.VERSION_POLICY_BASE_SHA || '').trim();
  if (supplied && !ZERO_SHA.test(supplied)) {
    if (!SHA.test(supplied)) {
      throw new Error('VERSION_POLICY_BASE_SHA must be a valid 40-character Git commit SHA.');
    }
    // Fail closed if CI did not fetch the actual base commit.
    git(cwd, 'cat-file', '-e', supplied + '^{commit}');
    return supplied;
  }

  // Local developers compare their branch to main, not merely to HEAD^.
  // That catches a version edit hidden in an earlier feature-branch commit.
  const remoteMain = tryGit(cwd, 'rev-parse', '--verify', 'refs/remotes/origin/main');
  const head = git(cwd, 'rev-parse', 'HEAD');
  if (remoteMain) {
    return head === remoteMain ? head : git(cwd, 'merge-base', head, remoteMain);
  }

  // An existing committed release can contain historical version changes.
  // Without an explicit CI comparison base, compare the current worktree to
  // HEAD rather than retroactively rejecting an earlier formal release.
  // CI always supplies the actual PR base or push-before SHA for enforcement.
  return head;
}

function compareManifestVersions(before, after) {
  const base = before?.version;
  const current = after?.version;
  if (!VERSION.test(String(base || '')) || !VERSION.test(String(current || ''))) {
    throw new Error('package.json must contain a valid MAJOR.MINOR.PATCH version.');
  }
  if (base !== current) {
    throw new Error(
      'MANUAL VERSION CHANGE BLOCKED: package.json version changed from ' +
      base + ' to ' + current + '. WinterBot computes its own patch/minor ' +
      'version at runtime from source changes. Restore the existing ' +
      'package.json version; do not run npm version or alter version state. ' +
      'If version selection needs improving, refine the automatic version tracker, not the version number.'
    );
  }
}

function compareLockVersions(before, after, manifestVersion) {
  if (!before && !after) return;
  if (!before || !after) {
    throw new Error('The committed package-lock.json must remain present.');
  }
  const baseTop = before.version;
  const baseRoot = before.packages?.['']?.version;
  const nowTop = after.version;
  const nowRoot = after.packages?.['']?.version;
  if (nowTop !== manifestVersion || nowRoot !== manifestVersion) {
    throw new Error('package-lock.json root versions must match the unchanged package.json version.');
  }
  if (baseTop !== nowTop || baseRoot !== nowRoot) {
    throw new Error('MANUAL VERSION CHANGE BLOCKED: package-lock.json root version changed.');
  }
}

function checkVersionPolicy({ cwd = path.resolve(__dirname, '..'), env = process.env } = {}) {
  const baseRef = determineBaseRef({ cwd, env });
  const before = readJson(git(cwd, 'show', baseRef + ':package.json'), 'baseline package.json');
  const after = readJson(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'), 'current package.json');
  compareManifestVersions(before, after);
  if (after.version !== FROZEN_PACKAGE_BASELINE) {
    throw new Error(
      'MANUAL VERSION CHANGE BLOCKED: package.json is ' + after.version +
      ', but the frozen historical manifest baseline is ' + FROZEN_PACKAGE_BASELINE +
      '. WinterBot calculates installed versions automatically in .versionState.json. ' +
      'Never bump the package baseline to publish features.'
    );
  }

  const trackedRuntimeState = tryGit(cwd, 'ls-files', '--', '.versionState.json', '.versionState.json.bak');
  if (trackedRuntimeState) {
    throw new Error('Runtime .versionState.json files must never be tracked or committed to Git.');
  }

  const oldLockText = tryGit(cwd, 'show', baseRef + ':package-lock.json');
  const currentLockFile = path.join(cwd, 'package-lock.json');
  const oldLock = oldLockText === null ? null : readJson(oldLockText, 'baseline package-lock.json');
  const newLock = fs.existsSync(currentLockFile)
    ? readJson(fs.readFileSync(currentLockFile, 'utf8'), 'current package-lock.json')
    : null;
  compareLockVersions(oldLock, newLock, after.version);

  return { baseRef, version: after.version };
}

if (require.main === module) {
  try {
    const result = checkVersionPolicy();
    process.stdout.write(
      'Version policy passed: package.json and root package-lock versions remain ' +
      result.version + ' (baseline ' + result.baseRef.slice(0, 8) + ').\n'
    );
  } catch (error) {
    console.error('\nWINTERBOT AUTOMATIC VERSION POLICY VIOLATION\n' + error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = {
  checkVersionPolicy, compareManifestVersions, compareLockVersions,
  determineBaseRef, FROZEN_PACKAGE_BASELINE,
};
