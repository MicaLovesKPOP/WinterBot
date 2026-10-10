# WinterBot automatic versioning — one-time GitHub protection

WinterBot versions itself. Normal feature work, including AI-generated
changes, must never change package.json's version or the root
package-lock.json version fields. Runtime versioning is performed by
src/versioning/versionTracker.js, using automatic PATCH/MINOR detection.

## Already enforced in the repository

- AGENTS.md is the cross-agent instruction.
- CLAUDE.md and .github/copilot-instructions.md target common coding tools.
- The pull-request template explicitly asks authors to preserve the version.
- npm test invokes scripts/checkVersionPolicy.js automatically.
- GitHub Actions' **Test** workflow includes a separate
  **version-policy** job that must succeed before the Node 18/24 test matrix
  can run.
- The checker compares against the PR base or Git push-before commit, plus
  the pinned historical 2.8.0 package-manifest baseline, making it reject
  invalid version changes even across multiple successive commits.
- Any tracked .versionState.json runtime files are rejected.
- WinterBot's existing nightly updater requires a successful exact-commit
  Test workflow before it automatically deploys code.

## Important one-time GitHub setting for stronger enforcement

As of the initial setup, the public MicaLovesKPOP/WinterBot repository has
no visible repository rulesets. Automated checks alone are not a perfect
barrier to an agent that has permission to change or remove its own checks.
To make policy failures block merges and direct pushes, the owner should
enable a REQUIRED repository ruleset.

GitHub web interface:

1. Open https://github.com/MicaLovesKPOP/WinterBot/settings/rules
2. Choose New ruleset > New branch ruleset.
3. Give it a name such as WinterBot automatic versioning; select Active.
4. Target the DEFAULT branch, main.
5. Require a pull request before merging if desired (recommended for all
   AI-authored changes). Consider whether the account has other eligible
   reviewers before selecting required approval counts.
6. Require status checks to pass before merging. Select the checks from
   WinterBot's Test workflow:
   - version-policy
   - test (18.20.8)
   - test (24)
7. Block force pushes and branch deletion. Do not grant AI automation
   tokens bypass permissions to this ruleset.
8. Save. Verify enforcement by opening a test PR with a temporary bad
   version change and ensuring the version-policy check fails and merging
   is blocked; close the test PR without merging.

The separate version-policy job becomes visible in the GitHub UI after this
safeguard is first pushed and its workflow has run.

Repository rules are a user-owned GitHub admin setting and are NOT changed
by an ordinary code commit. Until they are enabled, CI rejects accidental
manual bumps and stops WinterBot's guarded automatic updater from deploying
the failing commit, but direct pushes and policy-removal commits are not
strictly blocked at GitHub's server level.

## What is and isn't manual versioning

Allowed: refining or adding tests to the automatic runtime version tracker,
including improving classification of patch vs minor changes.

Not allowed: running npm version, changing version numbers in package or
lock files, manually editing .versionState.json, or editing the frozen
policy baseline to get an AI-authored release through.

If you encounter a version-policy failure, restore the baseline version
fields in package.json and package-lock.json to the original values,
then update the actual source normally. WinterBot automatically decides the
new runtime version on startup.
