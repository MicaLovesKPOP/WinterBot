const { execFileSync } = require('child_process');
const { logInfo, logWarn, logError } = require('../logging/logger');

const UPDATE_TIME_ZONE = 'Europe/Amsterdam';
const UPDATE_HOUR = 4;
const UPDATE_MINUTE = 45;
const MIN_UPDATE_AGE_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const REQUIRED_WORKFLOW_NAME = 'Test';

let updateTimer = null;
let updateCheckRunning = false;

function parseGitHubRepository(gitAddress) {
  let raw = String(gitAddress || '').trim();
  if (!raw) return null;

  if (/^git@github\.com:/i.test(raw)) {
    raw = `https://github.com/${raw.replace(/^git@github\.com:/i, '')}`;
  } else if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }

  try {
    const parsed = new URL(raw);
    if (parsed.hostname.toLowerCase() !== 'github.com') return null;

    const parts = parsed.pathname
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/i, '')
      .split('/')
      .filter(Boolean);

    if (parts.length !== 2) return null;
    return `${parts[0]}/${parts[1]}`;
  } catch (_) {
    return null;
  }
}

function getSelfUpdateConfig(env = process.env) {
  const gitAddress = String(env.GIT_ADDRESS || '').trim();
  const repository = parseGitHubRepository(gitAddress);
  const branch = String(env.BRANCH || 'main').trim() || 'main';

  return {
    enabled: String(env.AUTO_UPDATE || '').trim() === '1' && Boolean(repository),
    repository,
    branch,
    timeZone: UPDATE_TIME_ZONE,
    hour: UPDATE_HOUR,
    minute: UPDATE_MINUTE,
    minAgeMs: MIN_UPDATE_AGE_MS,
    workflowName: REQUIRED_WORKFLOW_NAME,
  };
}

function getTimeZoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function getTimeZoneOffsetMs(epochMs, timeZone) {
  const roundedEpochMs = Math.trunc(epochMs / 1000) * 1000;
  const parts = getTimeZoneParts(new Date(roundedEpochMs), timeZone);
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return representedAsUtc - roundedEpochMs;
}

function zonedDateTimeToUtc(
  { year, month, day, hour, minute, second = 0 },
  timeZone
) {
  const localAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second
  );

  let candidate = localAsUtc;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const offset = getTimeZoneOffsetMs(candidate, timeZone);
    const nextCandidate = localAsUtc - offset;
    if (nextCandidate === candidate) break;
    candidate = nextCandidate;
  }

  return new Date(candidate);
}

function addCalendarDay({ year, month, day }) {
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function getNextUpdateCheckTime(
  now = new Date(),
  {
    timeZone = UPDATE_TIME_ZONE,
    hour = UPDATE_HOUR,
    minute = UPDATE_MINUTE,
  } = {}
) {
  const localNow = getTimeZoneParts(now, timeZone);
  const currentMinutes = localNow.hour * 60 + localNow.minute;
  const targetMinutes = hour * 60 + minute;

  let targetDate = {
    year: localNow.year,
    month: localNow.month,
    day: localNow.day,
  };

  if (
    currentMinutes > targetMinutes ||
    (currentMinutes === targetMinutes && localNow.second > 0)
  ) {
    targetDate = addCalendarDay(targetDate);
  }

  let target = zonedDateTimeToUtc(
    {
      ...targetDate,
      hour,
      minute,
      second: 0,
    },
    timeZone
  );

  if (target.getTime() <= now.getTime()) {
    targetDate = addCalendarDay(targetDate);
    target = zonedDateTimeToUtc(
      {
        ...targetDate,
        hour,
        minute,
        second: 0,
      },
      timeZone
    );
  }

  return target;
}

function runGit(args, cwd = process.cwd()) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
  }).trim();
}

function getLocalGitState(cwd = process.cwd()) {
  return {
    sha: runGit(['rev-parse', 'HEAD'], cwd),
    branch: runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    trackedChanges: runGit(
      ['status', '--porcelain', '--untracked-files=no'],
      cwd
    ),
  };
}

async function fetchGitHubJson(url, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'WinterBot-self-update',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `GitHub API request failed with HTTP ${response.status}.`
      );
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function getRemoteBranchState(
  repository,
  branch,
  fetchImpl = globalThis.fetch
) {
  const encodedRepository = repository
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  const encodedBranch = encodeURIComponent(branch);

  const commit = await fetchGitHubJson(
    `https://api.github.com/repos/${encodedRepository}/commits/${encodedBranch}`,
    fetchImpl
  );

  const committedAt =
    commit?.commit?.committer?.date ||
    commit?.commit?.author?.date;

  if (!commit?.sha || !committedAt) {
    throw new Error('GitHub returned an incomplete branch commit response.');
  }

  return {
    sha: String(commit.sha),
    committedAt: new Date(committedAt),
  };
}

async function getPushCiState(
  repository,
  branch,
  sha,
  workflowName = REQUIRED_WORKFLOW_NAME,
  fetchImpl = globalThis.fetch
) {
  const encodedRepository = repository
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  const params = new URLSearchParams({
    branch,
    event: 'push',
    head_sha: sha,
    per_page: '100',
  });

  const data = await fetchGitHubJson(
    `https://api.github.com/repos/${encodedRepository}/actions/runs?${params}`,
    fetchImpl
  );

  const runs = Array.isArray(data?.workflow_runs)
    ? data.workflow_runs
    : [];
  const run = runs.find(
    (candidate) =>
      candidate?.name === workflowName &&
      candidate?.event === 'push' &&
      candidate?.head_sha === sha
  );

  if (!run) {
    return {
      found: false,
      status: null,
      conclusion: null,
    };
  }

  return {
    found: true,
    status: run.status || null,
    conclusion: run.conclusion || null,
  };
}

function evaluateUpdateCandidate({
  now = new Date(),
  localSha,
  localBranch,
  trackedChanges,
  expectedBranch,
  remoteSha,
  remoteCommittedAt,
  ci,
  minAgeMs = MIN_UPDATE_AGE_MS,
}) {
  if (localBranch !== expectedBranch) {
    return {
      ready: false,
      reason: `local branch is ${localBranch}, expected ${expectedBranch}`,
    };
  }

  if (trackedChanges) {
    return {
      ready: false,
      reason: 'tracked working-tree changes are present',
    };
  }

  if (localSha === remoteSha) {
    return {
      ready: false,
      reason: 'already up to date',
    };
  }

  const committedAtMs = remoteCommittedAt instanceof Date
    ? remoteCommittedAt.getTime()
    : new Date(remoteCommittedAt).getTime();

  if (!Number.isFinite(committedAtMs)) {
    return {
      ready: false,
      reason: 'remote commit timestamp is invalid',
    };
  }

  const ageMs = now.getTime() - committedAtMs;
  if (ageMs < minAgeMs) {
    return {
      ready: false,
      reason: 'newest commit is not old enough yet',
      ageMs,
    };
  }

  if (!ci?.found) {
    return {
      ready: false,
      reason: 'no exact-commit push CI run was found',
    };
  }

  if (ci.status !== 'completed' || ci.conclusion !== 'success') {
    return {
      ready: false,
      reason: `exact-commit CI is ${ci.status || 'unknown'}/${ci.conclusion || 'pending'}`,
    };
  }

  return {
    ready: true,
    reason: 'update is old enough and exact-commit CI passed',
    ageMs,
  };
}

async function checkForNightlyUpdate({
  cwd = process.cwd(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const config = getSelfUpdateConfig(env);

  if (!config.enabled) {
    return {
      enabled: false,
      ready: false,
      reason: 'automatic host Git updates are not enabled/configured',
    };
  }

  const local = getLocalGitState(cwd);
  const remote = await getRemoteBranchState(
    config.repository,
    config.branch,
    fetchImpl
  );

  if (local.sha === remote.sha) {
    return {
      enabled: true,
      ready: false,
      reason: 'already up to date',
      local,
      remote,
      config,
    };
  }

  const ci = await getPushCiState(
    config.repository,
    config.branch,
    remote.sha,
    config.workflowName,
    fetchImpl
  );

  return {
    enabled: true,
    ...evaluateUpdateCandidate({
      now,
      localSha: local.sha,
      localBranch: local.branch,
      trackedChanges: local.trackedChanges,
      expectedBranch: config.branch,
      remoteSha: remote.sha,
      remoteCommittedAt: remote.committedAt,
      ci,
      minAgeMs: config.minAgeMs,
    }),
    local,
    remote,
    ci,
    config,
  };
}

function formatShortSha(sha) {
  return String(sha || '').slice(0, 7);
}

function scheduleNextCheck(onUpdateReady, options = {}) {
  const config = getSelfUpdateConfig(options.env || process.env);
  if (!config.enabled || updateTimer) return false;

  const now = options.now instanceof Date ? options.now : new Date();
  const nextCheck = getNextUpdateCheckTime(now, config);
  const delayMs = Math.max(1_000, nextCheck.getTime() - now.getTime());

  updateTimer = setTimeout(async () => {
    updateTimer = null;

    if (updateCheckRunning) {
      scheduleNextCheck(onUpdateReady, options);
      return;
    }

    updateCheckRunning = true;

    try {
      const result = await checkForNightlyUpdate({
        cwd: options.cwd,
        env: options.env,
        fetchImpl: options.fetchImpl,
      });

      if (result.ready) {
        logInfo(
          `Automatic update ready: ${formatShortSha(result.local.sha)} -> ${formatShortSha(result.remote.sha)}. Exact-commit CI passed; restarting for host Git update.`,
          {
            source: 'updateMonitor',
            localSha: result.local.sha,
            remoteSha: result.remote.sha,
            branch: result.config.branch,
          }
        );

        await onUpdateReady(result);
        return;
      }

      if (
        result.reason !== 'already up to date' &&
        result.reason !== 'newest commit is not old enough yet'
      ) {
        logWarn(`Automatic update skipped: ${result.reason}.`, {
          source: 'updateMonitor',
        });
      } else {
        logInfo(`Automatic update check: ${result.reason}.`, {
          source: 'updateMonitor',
        });
      }
    } catch (error) {
      await logError('updateMonitor.check', error);
    } finally {
      updateCheckRunning = false;
    }

    scheduleNextCheck(onUpdateReady, options);
  }, delayMs);

  updateTimer.unref?.();

  return {
    nextCheck,
    config,
  };
}

function startNightlySelfUpdate(onUpdateReady, options = {}) {
  if (typeof onUpdateReady !== 'function') {
    throw new Error('Nightly self-update requires an update callback.');
  }

  const scheduled = scheduleNextCheck(onUpdateReady, options);
  if (!scheduled) return false;

  logInfo(
    `Nightly automatic update check scheduled for ${String(scheduled.config.hour).padStart(2, '0')}:${String(scheduled.config.minute).padStart(2, '0')} ${scheduled.config.timeZone}; updates must be at least ${Math.round(scheduled.config.minAgeMs / 60000)} minutes old and pass exact-commit push CI.`,
    {
      source: 'updateMonitor',
      nextCheckAt: scheduled.nextCheck.toISOString(),
      repository: scheduled.config.repository,
      branch: scheduled.config.branch,
    }
  );

  return true;
}

function stopNightlySelfUpdate() {
  if (updateTimer) {
    clearTimeout(updateTimer);
    updateTimer = null;
  }
}

module.exports = {
  parseGitHubRepository,
  getSelfUpdateConfig,
  getNextUpdateCheckTime,
  getLocalGitState,
  getRemoteBranchState,
  getPushCiState,
  evaluateUpdateCandidate,
  checkForNightlyUpdate,
  startNightlySelfUpdate,
  stopNightlySelfUpdate,
};
