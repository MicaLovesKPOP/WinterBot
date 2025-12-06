# WinterBot [![Download](https://img.shields.io/badge/Download-Latest_Release-brightgreen)](https://github.com/MicaLovesKPOP/WinterBot/releases/latest)


This is a Discord bot built with Node.js and the Discord.js library. The bot is designed to track the order of user registrations for scheduled events on a Discord server. It fetches scheduled events from the server, posts an event message for each event, and then keeps each message up to date with newly registered and unregistered users.

## Table of Contents
- [Features](#features)
- [Architecture Overview](#architecture-overview)
- [Local Hosting](#local-hosting)
- [Cloud Hosting](#cloud-hosting)
- [Miscellaneous](#miscellaneous)
- [Acknowledgements](#acknowledgements)
- [Licenses](#license)


## Features

- Posts scheduled event information to specified channel
- Keeps track of registered users in order of registration
- Lists previously registed users
- Logs errors to a specified log channel
- Saves and loads event data to/from .json file
- Posts weekly error reports to a specified channel (added in v1.0c)

![Event Message Screenshot](https://i.imgur.com/RMabYb4.png)

## Architecture Overview

WinterBot now uses a small set of focused modules so the bot remains easy to reason about while preserving all legacy behavior:

- **Configuration (`src/config`)** – Loads `.env`, validates all required IDs/tokens, and exposes a typed config object for the rest of the bot.
- **Logging (`src/logging`)** – Handles timestamped file logging with rotation, console fallback, and Discord log-channel delivery with cooldown-aware summarization and message chunking.
- **Persistence (`src/persistence`)** – `eventsStore` loads/saves scheduled event subscriber data; `uptimeStore` tracks uptime/downtime with atomic writes and gap reconciliation.
- **Discord (`src/discord`)** – `client` builds and logs in the Discord client with global error hooks; `events` wires the ready lifecycle (startup messages, intervals, logger injection); `scheduledEvents` syncs Discord scheduled events to channel messages and persistence; `api` wraps REST calls for subscriber lists.
- **Reporting (`src/reporting`)** – Posts weekly error/uptime summaries by reading recent log files and formatting chunked reports to the log channel.
- **Versioning (`src/versioning`)** – Preserves the auto-incrementing `version.txt` logic based on source modification time.

### How It Works
1. **Entrypoint (`WinterBot.js`)** loads configuration and version info, sets up logging, persistence stores, and the Discord client.
2. Once the client is ready, lifecycle handlers load persisted data, send the startup uptime summary, and start recurring tasks (uptime saves, weekly reports, scheduled event synchronization).
3. The scheduled events synchronizer polls Discord for scheduled events, updates channel messages, and persists subscriber state; logging and reporting capture errors and uptime over time.
4. Process-level error hooks save uptime data and route errors through the centralized logger to files and the configured Discord log channel.

## Local Hosting

### Installation

1. Install [Node.js](https://nodejs.org/en/) on your system.
2. Clone this repository or [download the latest release](https://github.com/MicaLovesKPOP/WinterBot/releases/latest) and extract it.
3. Open a terminal or command prompt in the project directory and run `npm install` to install the required dependencies.

### Configuration

1. Create a `.env` file in the project directory with the following content:

```
BOT_TOKEN=YOUR_BOT_TOKEN_HERE
```

Replace `YOUR_BOT_TOKEN_HERE` with your bot's token.

2. Open `WinterBot.js` and update the values of `guildId`, `channelId`, and `logChannelId` to match your Discord server's IDs.

### Usage

1. Open a terminal or command prompt in the project directory and run `node WinterBot.js` to start the bot.
2. The bot will log in to Discord and start running.

## Cloud Hosting

If you are looking for a hosting solution for this bot, I can recommend using [discordbothosting.com](https://discordbothosting.com/).

Their €0,60/m tier is a perfect fit for this bot.

### Configuration

1. Sign up for an account on [discordbothosting.com](https://discordbothosting.com/).
2. Log in to your account and go to the `Files` tab.
3. [Download the latest WinterBot release](https://github.com/MicaLovesKPOP/WinterBot/releases/latest) and extract it.
4. Upload the bot's files to your account.
5. Go to the `Startup` tab and under `BOT JS FILE`, replace `index.js` with `WinterBot.js`.

### Usage

1. Go to the `CONSOLE` tab and click `START` to start the bot.
2. The bot will log in to Discord and start running.

<!---
## Screenshots

Here are some screenshots of WinterBot in action:

### Event Message

This is a screenshot of an event message showing subscribed and unsubscribed users:

![Event Message Screenshot](event-message-screenshot.png)

### Error Log Channel

This is a screenshot of the error log channel showing error messages posted by WinterBot:

![Error Log Channel Screenshot](error-log-channel-screenshot.png)

### Weekly Error Report

This is a screenshot of the weekly error report posted by WinterBot:

![Weekly Error Report Screenshot](weekly-error-report-screenshot.png)
-->
## Miscellaneous

WinterBot is named after my cat, Winter.

If you'd like to use the same picture of her as the bot's avatar, you can find it below.

<img src="https://i.imgur.com/oCS021f.png" alt="Cute Cat" width="192" height="192">

## Acknowledgements

This project uses code and text generated with the help of [Bing Chat](https://www.bing.com/search?q=Bing+AI&showconv=1) and [ChatGPT](https://chat.openai.com/).

## License

This project is licensed under the GNU GPLv3 License. See the [LICENSE](https://github.com/MicaLovesKPOP/WinterBot/blob/main/LICENSE) file for details.

