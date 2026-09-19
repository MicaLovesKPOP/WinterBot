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

- `mediaOnly` — requires image, video, or audio media. Captions are allowed, but non-media attachments and links that do not resolve to media are rejected.
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

WinterBot's version comes from `package.json`.

The bot no longer changes its own version at runtime. Tests, backup folders, file mtimes, or deployment extraction cannot silently bump the release version.

## Local development

```bash
npm ci
npm test
npm check
npm start
```

## CI

The included GitHub Actions workflow runs on Node.js 24 and performs:

1. `npm ci`
2. `npm test`
3. a production dependency audit for high-severity findings

## Architecture

- `src/config` – environment loading and requirement validation
- `src/discord` – Discord client, lifecycle, message requirements, scheduled-event synchronization, REST helpers
- `src/logging` – structured logging, error grouping, log rotation, Discord-safe chunking
- `src/persistence` – queued atomic save/load logic and recovery
- `src/reporting` – weekly operational summaries
- `src/versioning` – package-version lookup
- `tests` – focused regression tests

## License

GNU GPLv3
