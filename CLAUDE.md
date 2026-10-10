# WinterBot instructions for Claude and other AI assistants

Read and follow [AGENTS.md](AGENTS.md) before touching this repository.

**Hard requirement:** WinterBot computes its own runtime version. Never edit
package.json's version, the root package-lock.json versions, or the installed
.versionState.json during ordinary coding, dependency updates or releases.
Never run npm version. Do not bypass the CI version policy checker.
