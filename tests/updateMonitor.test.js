const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseGitHubRepository,
  getSelfUpdateConfig,
  getNextUpdateCheckTime,
  getRemoteBranchState,
  getPushCiState,
  evaluateUpdateCandidate,
} = require('../src/update/updateMonitor');

function jsonResponse(value, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return value;
    },
  };
}

test('GitHub repository parser accepts the host address formats without exposing credentials', () => {
  assert.equal(
    parseGitHubRepository('github.com/MicaLovesKPOP/WinterBot'),
    'MicaLovesKPOP/WinterBot'
  );
  assert.equal(
    parseGitHubRepository('https://user:secret@github.com/MicaLovesKPOP/WinterBot.git'),
    'MicaLovesKPOP/WinterBot'
  );
  assert.equal(
    parseGitHubRepository('git@github.com:MicaLovesKPOP/WinterBot.git'),
    'MicaLovesKPOP/WinterBot'
  );
  assert.equal(
    parseGitHubRepository('gitlab.com/MicaLovesKPOP/WinterBot'),
    null
  );
});

test('nightly self-update enables itself only with the host Git updater configured', () => {
  assert.equal(
    getSelfUpdateConfig({
      AUTO_UPDATE: '1',
      GIT_ADDRESS: 'github.com/MicaLovesKPOP/WinterBot',
      BRANCH: 'main',
    }).enabled,
    true
  );

  assert.equal(
    getSelfUpdateConfig({
      AUTO_UPDATE: '0',
      GIT_ADDRESS: 'github.com/MicaLovesKPOP/WinterBot',
      BRANCH: 'main',
    }).enabled,
    false
  );

  assert.equal(
    getSelfUpdateConfig({
      AUTO_UPDATE: '1',
      GIT_ADDRESS: '',
      BRANCH: 'main',
    }).enabled,
    false
  );
});

test('next update check is 04:45 Europe/Amsterdam during summer time', () => {
  assert.equal(
    getNextUpdateCheckTime(
      new Date('2026-10-01T00:00:00.000Z')
    ).toISOString(),
    '2026-10-01T02:45:00.000Z'
  );

  assert.equal(
    getNextUpdateCheckTime(
      new Date('2026-10-01T03:00:00.000Z')
    ).toISOString(),
    '2026-10-02T02:45:00.000Z'
  );
});

test('next update check remains 04:45 local time across the DST transition', () => {
  assert.equal(
    getNextUpdateCheckTime(
      new Date('2026-10-25T00:00:00.000Z')
    ).toISOString(),
    '2026-10-25T03:45:00.000Z'
  );

  assert.equal(
    getNextUpdateCheckTime(
      new Date('2026-11-01T00:00:00.000Z')
    ).toISOString(),
    '2026-11-01T03:45:00.000Z'
  );
});

test('candidate requires a different clean main commit that is at least one hour old', () => {
  const base = {
    now: new Date('2026-10-01T05:00:00.000Z'),
    localSha: 'local',
    localBranch: 'main',
    trackedChanges: '',
    expectedBranch: 'main',
    remoteSha: 'remote',
    remoteCommittedAt: new Date('2026-10-01T03:00:00.000Z'),
    ci: {
      found: true,
      status: 'completed',
      conclusion: 'success',
    },
    minAgeMs: 60 * 60 * 1000,
  };

  assert.equal(evaluateUpdateCandidate(base).ready, true);

  assert.match(
    evaluateUpdateCandidate({
      ...base,
      remoteSha: 'local',
    }).reason,
    /already up to date/
  );

  assert.match(
    evaluateUpdateCandidate({
      ...base,
      trackedChanges: ' M WinterBot.js',
    }).reason,
    /working-tree/
  );

  assert.match(
    evaluateUpdateCandidate({
      ...base,
      remoteCommittedAt: new Date('2026-10-01T04:30:00.000Z'),
    }).reason,
    /not old enough/
  );
});

test('candidate refuses missing, pending, or failed exact-commit CI', () => {
  const base = {
    now: new Date('2026-10-01T05:00:00.000Z'),
    localSha: 'local',
    localBranch: 'main',
    trackedChanges: '',
    expectedBranch: 'main',
    remoteSha: 'remote',
    remoteCommittedAt: new Date('2026-10-01T03:00:00.000Z'),
    minAgeMs: 60 * 60 * 1000,
  };

  assert.match(
    evaluateUpdateCandidate({
      ...base,
      ci: { found: false },
    }).reason,
    /no exact-commit/
  );

  assert.match(
    evaluateUpdateCandidate({
      ...base,
      ci: {
        found: true,
        status: 'in_progress',
        conclusion: null,
      },
    }).reason,
    /in_progress/
  );

  assert.match(
    evaluateUpdateCandidate({
      ...base,
      ci: {
        found: true,
        status: 'completed',
        conclusion: 'failure',
      },
    }).reason,
    /failure/
  );
});

test('GitHub branch lookup reads the exact branch SHA and commit time', async () => {
  let requestedUrl = null;

  const fetchImpl = async (url) => {
    requestedUrl = String(url);
    return jsonResponse({
      sha: 'abcdef123456',
      commit: {
        committer: {
          date: '2026-10-01T02:00:00Z',
        },
      },
    });
  };

  const result = await getRemoteBranchState(
    'MicaLovesKPOP/WinterBot',
    'main',
    fetchImpl
  );

  assert.equal(result.sha, 'abcdef123456');
  assert.equal(
    result.committedAt.toISOString(),
    '2026-10-01T02:00:00.000Z'
  );
  assert.match(requestedUrl, /commits\/main$/);
});

test('CI lookup accepts only the exact push Test run for the requested SHA', async () => {
  let requestedUrl = null;

  const fetchImpl = async (url) => {
    requestedUrl = String(url);
    return jsonResponse({
      workflow_runs: [
        {
          name: 'Test',
          event: 'pull_request',
          head_sha: 'wanted',
          status: 'completed',
          conclusion: 'success',
        },
        {
          name: 'Other workflow',
          event: 'push',
          head_sha: 'wanted',
          status: 'completed',
          conclusion: 'success',
        },
        {
          name: 'Test',
          event: 'push',
          head_sha: 'different',
          status: 'completed',
          conclusion: 'success',
        },
        {
          name: 'Test',
          event: 'push',
          head_sha: 'wanted',
          status: 'completed',
          conclusion: 'success',
        },
      ],
    });
  };

  const result = await getPushCiState(
    'MicaLovesKPOP/WinterBot',
    'main',
    'wanted',
    'Test',
    fetchImpl
  );

  assert.deepEqual(result, {
    found: true,
    status: 'completed',
    conclusion: 'success',
  });
  assert.match(requestedUrl, /event=push/);
  assert.match(requestedUrl, /head_sha=wanted/);
});
