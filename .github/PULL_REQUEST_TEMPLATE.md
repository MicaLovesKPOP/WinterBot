## Summary

Describe the change and how you verified it.

## WinterBot safety checks

- [ ] Left package.json's **version** field unchanged.
- [ ] Left the root package-lock.json version values unchanged.
- [ ] Did not manually modify .versionState.json or run npm version.
- [ ] Ran npm run check:version-policy and npm test.
- [ ] Did not expose any bot/GitHub/OAuth credentials or weaken test mode.

WinterBot's runtime version tracker, not the coding agent, determines
automatic patch/minor version changes. See [AGENTS.md](../AGENTS.md).
