# WinterBot

WinterBot is a Discord bot for tracking the registration order of scheduled events in a server and keeping one message per event up to date.

## Highlights

- Tracks scheduled-event signups in registration order
- Uses stable Discord user IDs internally
- Displays names as nicknames, usernames, or both
- Uses atomic persistence for event data and uptime data
- Posts compact, structured weekly health reports instead of raw log dumps
- Suppresses repeated error spam and summarizes repeated incidents
- Includes focused automated tests for the core logic

## Configuration

Create a `.env` file in the project root.

```env
BOT_TOKEN=YOUR_BOT_TOKEN
GUILD_ID=YOUR_GUILD_ID
CHANNEL_ID=YOUR_EVENT_CHANNEL_ID
LOG_CHANNEL_ID=YOUR_LOG_CHANNEL_ID
USER_NAME_DISPLAY_MODE=2
LOG_COOLDOWN_MS=60000
EVENT_POLL_INTERVAL_MS=30000
ACTIVE_EVENT_POLL_INTERVAL_MS=5000
UPTIME_SAVE_INTERVAL_MS=60000
WEEKLY_REPORT_INTERVAL_MS=604800000
UNSUBSCRIBE_GRACE_CYCLES=6
MAX_API_RETRIES=4
RETRY_BASE_DELAY_MS=1000
MESSAGE_REQUIREMENTS_FILE=message-requirements.json
MESSAGE_REQUIREMENTS_EMBED_GRACE_MS=4000
DEBUG_LOGGING=0
```

### Name display modes

- `0` = nickname / display name only
- `1` = username only
- `2` = display name plus username when they differ

### Per-channel message requirements

WinterBot can enforce declarative requirements on any channel it can see. Copy `message-requirements.example.json` to `message-requirements.json` and configure rules by Discord channel ID. The runtime file is ignored by Git so each server owner can keep their own policy without modifying WinterBot's source.

Each channel contains a `requirements` array. All requirements in that array must pass. Supported rule types are currently:

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
        "pathPrefixes": ["/sharedfiles/filedetails", "/workshop/filedetails"],
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

- `domains` is required. Subdomains are accepted by default; set `allowSubdomains` to `false` for exact-host matching.
- `pathPrefixes` is optional. When provided, a link must begin with one of those URL paths.
- `queryParams` is optional. Use `true` to require a parameter to exist, or a regular-expression string to validate its value.
- `minMatches` defaults to `1`.
- `rejectOtherLinks` defaults to `false`. Set it to `true` if every link in the message must match the rule.
- `ignoreBots` is a per-channel policy option and defaults to `true`.

You may also provide the same JSON through `MESSAGE_REQUIREMENTS_JSON`; entries there override channels with the same ID from the file. `MEDIA_ONLY_CHANNEL_IDS` remains supported as a backwards-compatible shorthand and is merged into the generic rules.

`MESSAGE_REQUIREMENTS_EMBED_GRACE_MS` controls how long WinterBot waits before re-fetching messages whose `mediaOnly` rule depends on Discord-generated embeds. The default is 4000 ms.

When at least one channel has message requirements, enable the **Message Content Intent** for WinterBot in the Discord Developer Portal. WinterBot also needs **View Channel**, **Read Message History**, and **Manage Messages** in each enforced channel. When no requirements are configured, WinterBot does not request the privileged Message Content intent.

## Local development

```bash
npm install
npm test
npm start
```

## Architecture

- `src/config` – environment loading and validation
- `src/discord` – Discord client, event lifecycle, message requirements, display formatting, scheduled-event sync, API helpers
- `src/logging` – structured logging, alert suppression, Discord-safe message chunking
- `src/persistence` – atomic save/load logic for event data and uptime data
- `src/reporting` – weekly operational summaries
- `src/versioning` – bot version lookup from `package.json`
- `tests` – focused tests for the most failure-prone behavior

## License

GNU GPLv3
