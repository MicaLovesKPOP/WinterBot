# WinterBot

This is a Discord bot built with Node.js and the Discord.js library. The bot is designed to track the order of user registrations for scheduled events on a Discord server. It fetches scheduled events from the server, posts an event message for each event, and then keeps each message up to date with newly registered and unregistered users.

## Features

- Posts scheduled event information to specified channel
- Keeps track of registered users in order of registration
- Lists previously registed users
- Logs errors to a specified log channel
- Saves and loads event data to/from .json file
- Posts weekly error reports to a specified channel (v1.0c+)

## Preview

The screenshot below shows how WinterBot keeps track of the registration order.

![Event Message Screenshot](https://i.imgur.com/RMabYb4.png)

## Local Hosting

### Installation

1. Install [Node.js](https://nodejs.org/en/) on your system.
2. Clone this repository or download the code as a zip file and extract it.
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

If you are looking for a hosting solution for this bot, I can recommend using [discordbothosting.com](https://discordbothosting.com/). Their €0,60/m tier is a perfect fit for this bot.

### Configuration

1. Sign up for an account on [discordbothosting.com](https://discordbothosting.com/)
2. Log in to your account and go to the `Files` tab
3. Upload the bot's files to your account
4. Go to the `Startup` tab and under `BOT JS FILE`, replace `index.js` with `WinterBot.js`

### Usage

1. Go to the `CONSOLE` tab and click `START` to start the bot
2. The bot will log in to Discord and start running

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
## Acknowledgements

- This project uses code and text generated with the help of [Bing Chat]([https://discordbothosting.com/](https://www.bing.com/search?q=Bing+AI&showconv=1)) and [ChatGPT](https://chat.openai.com/)

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
