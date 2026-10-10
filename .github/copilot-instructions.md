# GitHub Copilot repository instructions — WinterBot

Read [AGENTS.md](../AGENTS.md) for the full repository-wide requirements.

**Mandatory automatic version policy:** Do not edit the version field in
package.json or root package-lock.json; do not run npm version; do not touch
.versionState.json. WinterBot automatically calculates PATCH vs MINOR from
source changes at runtime. Feature work and deployment must preserve the
existing package version. GitHub CI and npm test reject manual changes.
Do not disable or bypass scripts/checkVersionPolicy.js or its workflow.
