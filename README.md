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
DEBUG_LOGGING=0
```

### Name display modes

- `0` = nickname / display name only
- `1` = username only
- `2` = display name plus username when they differ

## Local development

```bash
npm install
npm test
npm start
```

## Architecture

- `src/config` – environment loading and validation
- `src/discord` – Discord client, event lifecycle, display formatting, scheduled-event sync, API helpers
- `src/logging` – structured logging, alert suppression, Discord-safe message chunking
- `src/persistence` – atomic save/load logic for event data and uptime data
- `src/reporting` – weekly operational summaries
- `src/versioning` – bot version lookup from `package.json`
- `tests` – focused tests for the most failure-prone behavior

## License

GNU GPLv3
