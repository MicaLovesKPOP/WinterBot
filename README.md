# WinterBot

WinterBot is a Discord bot for tracking scheduled-event registrations and enforcing optional per-channel message requirements.

## Highlights

- Tracks scheduled-event signups in registration order
- Preserves registration state with atomic writes and rolling backups
- Uses stable Discord user IDs internally
- Displays names as nicknames, usernames, or both
- Handles deregistration and later re-registration without corrupting signup order
- Uses grace cycles before treating missing users or scheduled events as permanently removed
- Enforces configurable media/link requirements per channel
- Suppresses bot-generated mentions and escapes user-controlled Markdown
- Posts daily error summaries and weekly health reports
- Includes automated regression tests for the most failure-prone behavior

## Availability-based scheduling (opt-in preview)

WinterBot also includes a mobile-friendly scheduling planner that collects each member's available/unavailable days, supports multiple time windows and maximum attendance durations, finds best-attendance time slots, optionally lets participants vote on a selected subset, and creates organizer-approved Discord Scheduled Events (at most one per calendar day). The existing event-registration tracker is unchanged.

**Try it without Discord credentials:** run `npm ci`, then `npm run scheduler:demo` and open `http://127.0.0.1:8791` on the same computer. The demo cannot post to Discord or create real events. Switch between sample participants and Organizer to test all stages.

See **[SCHEDULING.md](SCHEDULING.md)** for the complete UX, rules, architecture, testing steps, opt-in live OAuth setup and limitations. The new **[channel routing and TEST mode guide](SCHEDULING_CHANNELS.md)** documents Management-only setup, default League / optional Public invitations, and safe end-to-end simulations confined to #bot-logs. The browser planner is implemented; a **separately gated test-server Discord Activity prototype** (not yet publicly verified) is documented in **[SCHEDULING_ACTIVITY_TEST_SETUP.md](SCHEDULING_ACTIVITY_TEST_SETUP.md)**. Main-guild Activity integration and live-server end-to-end verification remain future steps. For secure test-only access on DiscordBotHosting without changing its Startup Command, see **[the ngrok HTTPS setup guide](SCHEDULING_NGROK_SETUP.md)**. Do not enable `SCHEDULING_ENABLED=1` on a production server before completing live testing.

## Runtime

WinterBot requires Node.js 18.20 or newer.

Node.js 24 LTS is recommended for production. Older supported runtimes may still work, but using a currently maintained LTS release gives the bot current platform security fixes.

## Configuration

Create a `.env` file in the project root.

```env
BOT_TOKEN=YOUR_BOT_TOKEN
GUILD_ID=YOUR_GUILD_ID
CHANNEL_ID=YOUR_EVENT_CHANNEL_ID
LOG_CHANNEL_ID=YOUR_LOG_CHANNEL_ID

USER_NAME_DISPLAY_MODE=2

EVENT_POLL_INTERVAL_MS=30000
ACTIVE_EVENT_POLL_INTERVAL_MS=5000
UPTIME_SAVE_INTERVAL_MS=60000
WEEKLY_REPORT_INTERVAL_MS=604800000
ERROR_SUMMARY_INTERVAL_MS=86400000

UNSUBSCRIBE_GRACE_CYCLES=6
MISSING_EVENT_GRACE_CYCLES=3

MAX_API_RETRIES=4
RETRY_BASE_DELAY_MS=1000
API_REQUEST_TIMEOUT_MS=15000

ERROR_REGISTRY_MAX_SIZE=500
DEBUG_LOGGING=0

MESSAGE_REQUIREMENTS_FILE=message-requirements.json
MESSAGE_REQUIREMENTS_EMBED_GRACE_MS=4000
```

Explicit invalid numeric settings fail fast instead of silently falling back.

### Name display modes

- `0` = nickname/display name only
- `1` = username only
- `2` = display name plus username when they differ

### Scheduled-event behavior

WinterBot polls Discord scheduled events and maintains one tracking message per event.

Important reliability behavior:

- A subscriber must be absent for `UNSUBSCRIBE_GRACE_CYCLES` successful subscriber polls before being marked deregistered.
- An event must be absent for `MISSING_EVENT_GRACE_CYCLES` successful event polls before being marked past and removed from active tracking.
- Transient Discord errors do not cause WinterBot to create duplicate tracking messages.
- If an event message grows too large for Discord, WinterBot keeps it within the content limit and shows an omission summary.
- User-controlled names cannot create mentions through WinterBot messages.

### Per-channel message requirements

Copy `message-requirements.example.json` to `message-requirements.json` and configure rules by Discord channel ID.

The runtime file is ignored by Git so each server can have its own policy without modifying WinterBot source.

Each channel contains a `requirements` array. All requirements in that array must pass.

Supported requirement types:

- `mediaOnly` — requires at least one real image, video, or audio attachment/embed. Captions, contextual links, and other extras are allowed once real media is present. Message updates are re-checked only when WinterBot can verify a fresh user edit; embed/metadata-only updates and partial historical updates are ignored.
- `requiredLink` — requires one or more links matching configured domains, optional path prefixes, and optional query-parameter rules.

Example:

```json
{
  "123456789012345678": {
    "requirements": [
      {
        "type": "mediaOnly"
      }
    ]
  },
  "234567890123456789": {
    "requirements": [
      {
        "type": "requiredLink",
        "domains": ["steamcommunity.com"],
        "pathPrefixes": [
          "/sharedfiles/filedetails",
          "/workshop/filedetails"
        ],
        "queryParams": {
          "id": "^\\d+$"
        },
        "minMatches": 1
      }
    ]
  }
}
```

`requiredLink` options:

- `domains` is required.
- Subdomains are accepted by default; set `allowSubdomains` to `false` for exact-host matching.
- `pathPrefixes` is optional. Prefixes are matched on path boundaries rather than arbitrary string prefixes.
- `queryParams` is optional. Use `true` to require a parameter, or a regular-expression string to validate its value.
- `minMatches` defaults to `1`.
- `rejectOtherLinks` defaults to `false`. Set it to `true` if every link in the message must match.
- `ignoreBots` is a per-channel policy option and defaults to `true`.

The same JSON can be supplied through `MESSAGE_REQUIREMENTS_JSON`. Entries there override channels with the same ID from the file.

`MEDIA_ONLY_CHANNEL_IDS` remains supported as a backwards-compatible shorthand.

When at least one message-requirement channel is configured, enable **Message Content Intent** for WinterBot in the Discord Developer Portal.

WinterBot validates required guilds/channels and permissions on startup.

## Persistence and recovery

WinterBot persists:

- `data.json` — scheduled-event registration state
- `uptimeData.json` — cumulative uptime/downtime state

Both stores:

- serialize overlapping writes through an internal queue
- write through a temporary file
- keep a last-known-good `.bak` generation
- validate stored JSON
- recover automatically from a valid backup when possible

If event state and its backup are both unusable, WinterBot refuses to continue with an empty store rather than silently discarding registration history.

### Legacy uptime repair

`uptime-repair.json` is an optional one-time migration aid for known historical counter corruption. Normal installations do not need it.

The repository contains `uptime-repair.example.json`, while a real repair file is intentionally Git-ignored because repair anchors are installation-specific.

Once a corrupt total has been repaired and rewritten as a sane value, the repair is not applied again.

## Error reporting and logging

- Routine successful poll telemetry is logged only when `DEBUG_LOGGING=1`.
- Warnings/errors are written to rotating log files.
- Daily error summaries remain queued if Discord delivery fails.
- Weekly reports include uptime and warnings/errors from the configured weekly window.
- Fatal uncaught exceptions and unhandled promise rejections trigger bounded persistence cleanup and a non-zero process exit so a process manager can restart WinterBot cleanly.

## Discord API robustness

Subscriber REST requests have:

- bounded retry counts
- exponential backoff with jitter
- explicit request timeouts
- rate-limit handling
- pagination cursor-loop protection
- a hard pagination safety limit

## Versioning

**Versioning is fully automatic. Do not edit the `version` in `package.json` or root `package-lock.json` and do not run `npm version` for normal updates.** The existing `package.json` value is a historical starting baseline, not a release counter to maintain. WinterBot keeps an installation-local `.versionState.json` and calculates patch/minor increments from source changes without modifying tracked source files. AI may refine the automatic algorithm, but must never assign versions manually. See [AGENTS.md](AGENTS.md) and the [GitHub version-policy protection guide](.github/VERSIONING_PROTECTION.md).

The automatic signature hashes actual file contents, not mtimes. It watches only:

- `WinterBot.js`
- `src/**/*.js`
- `package.json`

Tests, docs, backup folders, logs, `.github/`, file timestamps, and `package-lock.json` are deliberately ignored.

Version behavior:

- first start of a formal release: use the `package.json` version and create a new baseline
- same watched file set with changed contents: patch bump (`2.6.1` → `2.6.2`)
- runtime source file added, removed, or renamed: minor bump (`2.6.2` → `2.7.0`)
- no watched-content change: no bump
- existing historical `package.json` baselines are recognized for backward compatibility; **new AI-managed changes must never modify these version fields**

The state file uses a versioned schema and keeps `.versionState.json.bak` as a recovery copy. Legacy size/mtime state files are safely migrated to the current release baseline rather than causing a fake version bump.

Do not copy `.versionState.json` between unrelated installations. It is runtime state and is Git-ignored.

## Nightly self-update

When the hosting environment has its existing Git updater enabled with `AUTO_UPDATE=1` and `GIT_ADDRESS` points to a GitHub repository, WinterBot schedules one update check per day at **04:45 Europe/Amsterdam**.

A restart for an update is allowed only when all of the following are true:

- the configured branch contains a different commit than the currently running checkout
- the newest branch commit is at least 60 minutes old
- the local tracked Git working tree is clean
- WinterBot is running the configured branch
- the exact remote commit has a completed successful GitHub Actions push run named `Test`

If all checks pass, WinterBot performs its normal persistence cleanup and intentionally exits non-zero. The host process manager restarts it, and the existing hosting startup command performs the Git pull and dependency install before WinterBot starts again.

Embed/runtime state and ignored installation files are not part of this Git update decision. If GitHub is unavailable, CI has not passed, or any safety check is uncertain, WinterBot leaves the running process untouched and tries again at the next nightly check.

The schedule is calculated in the `Europe/Amsterdam` time zone so it remains 04:45 local time across daylight-saving changes.

## Local development

```bash
npm ci
npm test
npm run check
npm start
```

## CI

The included GitHub Actions workflow runs the same checks on both the production-host runtime (Node.js 18.20.8) and Node.js 24:

1. `npm ci`
2. `npm test`
3. a production dependency audit for high-severity findings

## Architecture

- `src/config` – environment loading and requirement validation
- `src/discord` – Discord client, lifecycle, message requirements, scheduled-event synchronization, REST helpers
- `src/logging` – structured logging, error grouping, log rotation, Discord-safe chunking
- `src/persistence` – queued atomic save/load logic and recovery
- `src/reporting` – weekly operational summaries
- `src/update` – guarded nightly GitHub update detection and restart scheduling
- `src/versioning` – content-hash runtime version tracking
- `tests` – focused regression tests

## License

GNU GPLv3
