# WinterBot — repository instructions for ALL coding agents

These rules apply to every contributor, AI coding agent, automated worker,
pull request, branch and local edit in this repository. Read them before
editing any source files. They are not optional suggestions.

## CRITICAL: WinterBot owns its versions automatically

**DO NOT manually change WinterBot's version.** This includes:

- The top-level "version" field in package.json.
- The top-level "version" field and packages[""].version in package-lock.json.
- Runtime version records in .versionState.json or its backup.
- Any other "version bump" or "release number" workaround intended to force a
  higher or lower WinterBot release version.

**NEVER run npm version, npm pkg set version, yarn version, pnpm version, or
equivalent commands on this repository during ordinary development.**

WinterBot's source-aware versionTracker at
src/versioning/versionTracker.js determines version changes at runtime from
the watched code and package manifest:

- Existing watched source content changes -> PATCH bump.
- Added, removed or renamed watched source JS files -> MINOR bump.
- No watched-source change, e.g. .env, documentation, tests -> NO bump.
- package.json is normally watched for OTHER content changes; its version
  field itself must stay untouched.

The package.json version is a formal baseline, NOT a per-update release
counter. Leave its existing value exactly as it was, even when implementing
a major-looking feature, adding libraries, changing dependencies, merging a
PR, deploying to DiscordBotHosting, or cutting a new branch.

The historical package.json baseline is currently 2.8.0; it is a frozen
comparison anchor, not a value that an agent may increment. Never change
the anchor in scripts/checkVersionPolicy.js as a workaround.

The version policy is enforced by scripts/checkVersionPolicy.js, npm test
and GitHub Actions on both PRs and pushes. A violation must be fixed by
RESTORING the original package and lock version fields, never by removing,
altering, disabling, or bypassing tests, guard scripts, workflow steps, or
branch checks.

**No AI exception for manual versioning.** Even an explicit request to
"release", "update", "deploy" or "bump as warranted" is handled by the
automatic version tracker, not by changing a version string. If a request
cannot be fulfilled within the current automatic algorithm, propose or
implement a well-tested change to the algorithm instead. Do not change any
version string yourself.

Before committing and before offering a merge:
1. Verify package.json version is unchanged relative to main.
2. Verify package-lock.json's root versions remain the same.
3. Run npm run check:version-policy and npm test.
4. Fix any failure; never remove the safeguard to make a PR green.

## Keep other WinterBot safeguards

- Never commit secrets, bot tokens, Discord OAuth secrets, Git access tokens
  or hosting .env files.
- Respect the CI-gated automatic DiscordBotHosting update path.
- Scheduling test mode must not post to League/Public or create real events.
- Do not modify a second AI worker's uncommitted worktree without checking
  ownership and preserving changes.

## Why this rule exists

Multiple independent AI sessions previously edited package.json's version
field despite WinterBot already implementing automatic version management.
The repository-level instruction AND the GitHub build gate exist so this
cannot be silently repeated by a new session without shared chat context.
