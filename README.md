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
MEDIA_ONLY_CHANNEL_IDS=
MEDIA_ONLY_EMBED_GRACE_MS=4000
DEBUG_LOGGING=0
```

### Name display modes

- `0` = nickname / display name only
- `1` = username only
- `2` = display name plus username when they differ

### Media-only channels

Set `MEDIA_ONLY_CHANNEL_IDS` to one or more Discord channel IDs separated by commas or spaces. Leave it empty to disable the feature.

In configured channels, WinterBot allows a message only when it contains image, video, or audio media. Captions are allowed, but the payload stays strict:

- Every uploaded attachment must be image, video, or audio media.
- Every URL in the message must resolve to a Discord embed containing image, video, or audio media.
- Common audio-provider embeds such as SoundCloud, Spotify, Bandcamp, Apple Music, TIDAL, Deezer, Mixcloud, and Audiomack are recognized from Discord's provider metadata.
- At least one qualifying attachment or embed must be present.
- Non-media files, plain text, suppressed/unembedded links, and ordinary webpage links are deleted.
- WinterBot's own messages and Discord system messages are exempt.

`MEDIA_ONLY_EMBED_GRACE_MS` controls how long WinterBot waits before re-fetching a link message so Discord has time to build its embed. The default is 4000 ms.

When at least one media-only channel is configured, enable the **Message Content Intent** for WinterBot in the Discord Developer Portal. WinterBot also needs **View Channel**, **Read Message History**, and **Manage Messages** in each enforced channel. When no media-only channels are configured, WinterBot does not request the privileged Message Content intent.

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
