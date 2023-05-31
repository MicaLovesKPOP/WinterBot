require('dotenv').config();

const Discord = require('discord.js');
const client = new Discord.Client({ intents: Discord.GatewayIntentBits.Guilds });
const fs = require('fs');
const errorLogStream = fs.createWriteStream('error.log', { flags: 'a' });

const botVersion = '1.0c'; // Current bot version
const guildId = '199916140183420928'; // Official Crashday discord
const channelId = '1113151362507755531'; // #reg-tracking channel
const logChannelId = '332575578383187970'; // #bot-logs channel

let eventMessages = {};
let eventData = {};
let previousUptime = 0;
let totalDowntime = 0;

function getTimestamp() {
    const now = new Date();
    const year = now.getFullYear().toString().slice(-2);
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    const milliseconds = now.getMilliseconds().toString().padStart(3, '0');
    return `${year}${month}${day} ${hours}:${minutes}:${seconds}`; // .${milliseconds}`;
}

async function saveData() {
    try {
        // Convert subscribedUsers and unsubscribedUsers objects to arrays
        Object.values(eventData).forEach(event => {
            if (event.subscribedUsers) {
                event.subscribedUsers = Object.entries(event.subscribedUsers);
            }
            if (event.unsubscribedUsers) {
                event.unsubscribedUsers = Object.entries(event.unsubscribedUsers);
            }
        });

        const data = JSON.stringify({ eventData }, null, 2);
        await fs.promises.writeFile('data.json', data);

        // Convert subscribedUsers and unsubscribedUsers arrays back to objects
        Object.values(eventData).forEach(event => {
            if (Array.isArray(event.subscribedUsers)) {
                event.subscribedUsers = Object.fromEntries(event.subscribedUsers);
            }
            if (Array.isArray(event.unsubscribedUsers)) {
                event.unsubscribedUsers = Object.fromEntries(event.unsubscribedUsers);
            }
        });

        console.log(`[${getTimestamp()}] Data saved successfully.`);
    } catch (error) {
        console.error(`[${getTimestamp()}] Handled Error saving data: ${error}`);
        errorLogStream.write(`[${getTimestamp()}] Handled Error saving data: ${error}\n`);
    }
}

async function loadData() {
    try {
        const data = JSON.parse(await fs.promises.readFile('data.json'));

        // Load eventData from data.json
        eventData = data.eventData || {};

        // Convert subscribedUsers and unsubscribedUsers arrays back to objects
        Object.values(eventData).forEach(event => {
            if (Array.isArray(event.subscribedUsers)) {
                event.subscribedUsers = Object.fromEntries(event.subscribedUsers);
            }
            if (Array.isArray(event.unsubscribedUsers)) {
                event.unsubscribedUsers = Object.fromEntries(event.unsubscribedUsers);
            } else if (!event.unsubscribedUsers) {
                // Ensure that event.unsubscribedUsers is defined
                event.unsubscribedUsers = {};
            }
        });

        console.log(`[${getTimestamp()}] Data loaded successfully.`);
    } catch (error) {
        console.error(`[${getTimestamp()}] Handled Error loading data: ${error}`);
        errorLogStream.write(`[${getTimestamp()}] Handled Error loading data: ${error}\n`);
    }
}

async function fetchSubscribedUsers(guildId, eventId) {
    try {
        const fetch = await import('node-fetch');
        const response = await fetch.default(`https://discord.com/api/v9/guilds/${guildId}/scheduled-events/${eventId}/users`, {
            headers: {
                'Authorization': `Bot ${process.env.BOT_TOKEN}`
            }
        });
        const data = await response.json();
        // console.log(`[${getTimestamp()}] Response from Discord API: ${JSON.stringify(data)}`); // logs API response for debugging
        if (data.retry_after) {
            // Handle rate limiting
            console.log(`[${getTimestamp()}] Rate limited. Waiting for ${data.retry_after} seconds before retrying...`);
            await new Promise(resolve => setTimeout(resolve, data.retry_after * 1000));
            return fetchSubscribedUsers(guildId, eventId);
        } else {
            return data;
        }
    } catch (error) {
        console.error(`[${getTimestamp()}] Error fetching subscribed users: ${error}`);
        errorLogStream.write(`[${getTimestamp()}] Error fetching subscribed users: ${error}\n`);
        return [];
    }
}

async function updateEventMessages() {
    try {
        const guild = client.guilds.cache.get(guildId);
        const events = await guild.scheduledEvents.fetch();
        console.log(`[${getTimestamp()}] Fetched ${events.size} event(s)`);

        // Calculate the delay between each API call
        const delay = events.size > 0 ? 5000 : 0; // any less than 5000ms and rate limiting occurs.
        // const delay = events.size > 0 ? Math.floor(10000 / events.size) : 0; // this old implementation gets badly rate limited with >2 events...

        const knownEventIds = Object.keys(eventData);
        const fetchedEventIds = events.map(event => event.id);
        const removedEventIds = knownEventIds.filter(eventId => !fetchedEventIds.includes(eventId));

        // Set the event message of removed events to "(past event)"
        for (const eventId of removedEventIds) {
            eventData[eventId].eventStatus = '(past event)';
            // Update the event message
            let content = eventData[eventId].eventMessage + eventData[eventId].eventStatus + ':\n';
            // Add subscribed users to the content
            let count = 1;
            Object.entries(eventData[eventId].subscribedUsers).forEach(([username, timestamp]) => {
                content += `${count}. ${username}\n`;
                count++;
            });

            // Add unsubscribed users to the content
            const unsubscribedUsernamesString = Object.keys(eventData[eventId].unsubscribedUsers).join(', ');

            if (unsubscribedUsernamesString.length > 0) {
                content += `\nDeregistered players: ${unsubscribedUsernamesString}\n`;
            }

            if (eventData[eventId].messageId) {
                try {
                    // Update existing message
                    const channel = client.channels.cache.get(channelId);
                    const message = await channel.messages.fetch(eventData[eventId].messageId);
                    await message.edit(content);
                } catch (error) {
                    console.error(`[${getTimestamp()}] Error updating message: ${error}`);
					errorLogStream.write(`[${getTimestamp()}] Error updating message: ${error}\n`);
                }
            } else if (eventMessages[eventId]) {
                // Update existing message
                await eventMessages[eventId].edit(content);
            }

            // Remove the event data
            delete eventData[eventId];
        }

        for (const event of events.values()) {
            const eventId = event.id;
            console.log(`[${getTimestamp()}] Processing event ${eventId}: '${event.name}'`);

            // Check if the event exists and has not ended
            if (event && !event.ended) {
                // Fetch subscribed users for this event
                let users;
                if (!client.subscribedUsersPromise) {
                    client.subscribedUsersPromise = {};
                }
                if (!client.subscribedUsersPromise[eventId]) {
                    client.subscribedUsersPromise[eventId] = fetchSubscribedUsers(guildId, eventId);
                }
                users = await client.subscribedUsersPromise[eventId];
                delete client.subscribedUsersPromise[eventId];

                let usernames = [];
                if (Array.isArray(users)) {
                    usernames = users.map(user => user.user.username);
                } else {
                    console.error(`[${getTimestamp()}] Error: users is not an array: ${JSON.stringify(users)}`);
					errorLogStream.write(`[${getTimestamp()}] Error: users is not an array: ${JSON.stringify(users)}\n`);
                }

                // Initialize the eventData[eventId] object if it does not exist
                if (!eventData[eventId]) {
                    eventData[eventId] = {
                        subscribedUsers: {},
                        unsubscribedUsers: {},
                        unsubscribedTimestamps: {},
                        eventMessage: `**Registered players for ${event.name}** `,
                        eventStatus: ''
                    };
                } else if (!eventData[eventId].unsubscribedUsers) {
                    // Ensure that eventData[eventId].unsubscribedUsers is defined
                    eventData[eventId].unsubscribedUsers = {};
                }

                // Update the event message
                if (eventData[eventId].eventName !== event.name) {
                    eventData[eventId].eventName = event.name;
                    eventData[eventId].eventMessage = `**Registered players for ${event.name}** `;
                }
                let content = eventData[eventId].eventMessage + eventData[eventId].eventStatus + '**:**\n';

                // Add subscribed users to eventData[eventId].subscribedUsers
                usernames.forEach(username => {
                    if (!eventData[eventId].subscribedUsers[username]) {
                        eventData[eventId].subscribedUsers[username] = {
                            timestamp: Date.now(),
                            apiCheckCounter: 0
                        };
                    }
                    // Remove the user from eventData[eventId].unsubscribedUsers if they exist there
                    if (eventData[eventId].unsubscribedUsers[username]) {
                        delete eventData[eventId].unsubscribedUsers[username];
                    }
                });

                // Find users who have unsubscribed
                const previousUsernames = Object.keys(eventData[eventId].subscribedUsers);
                const unsubscribedUsernames = previousUsernames.filter(username => !usernames.includes(username));

                // Increment the apiCheckCounter of unsubscribed users
                unsubscribedUsernames.forEach(username => {
                    eventData[eventId].subscribedUsers[username].apiCheckCounter++;
                });

                // Move unsubscribed users from eventData[eventId].subscribedUsers to eventData[eventId].unsubscribedUsers
                // if their apiCheckCounter is greater than or equal to the desired number of API checks
                const delayApiChecks = 6; // number of API checks to wait before moving a user
                unsubscribedUsernames.forEach(username => {
                    if (eventData[eventId].subscribedUsers[username].apiCheckCounter >= delayApiChecks) {
                        delete eventData[eventId].subscribedUsers[username];
                        eventData[eventId].unsubscribedUsers[username] = Date.now();
                    }
                });

                // Update the event status
                if (event.status === 3) {
                    eventData[eventId].eventStatus = '(past event)';
                } else if (event.status === 2) {
                    eventData[eventId].eventStatus = '(currently happening)';
                } else {
                    eventData[eventId].eventStatus = '(upcoming)';
                }

                // Update the event message
                content = eventData[eventId].eventMessage + eventData[eventId].eventStatus + ':\n';

                // Add subscribed users to the content
                let count = 1;
                Object.entries(eventData[eventId].subscribedUsers).forEach(([username, timestamp]) => {
                    content += `${count}. ${username}\n`;
                    count++;
                });

                // Add unsubscribed users to the content
                const unsubscribedUsernamesString = Object.keys(eventData[eventId].unsubscribedUsers).join(', ');

                if (unsubscribedUsernamesString.length > 0) {
                    content += `\nDeregistered players: ${unsubscribedUsernamesString}\n`;
                }

                if (eventData[eventId].messageId) {
                    try {
                        // Update existing message
                        const channel = client.channels.cache.get(channelId);
                        const message = await channel.messages.fetch(eventData[eventId].messageId);
                        await message.edit(content);
                    } catch (error) {
                        console.error(`[${getTimestamp()}] Handled Error updating message: ${error}`);
						errorLogStream.write(`[${getTimestamp()}] Handled Error updating message: ${error}\n`);
                        // Create new message
                        const channel = client.channels.cache.get(channelId);
                        const message = await channel.send(content);
                        eventMessages[eventId] = message;
                        eventData[eventId].messageId = message.id;
                    }
                } else if (eventMessages[eventId]) {
                    // Update existing message
                    await eventMessages[eventId].edit(content);
                } else {
                    // Create new message
                    const channel = client.channels.cache.get(channelId);
                    const message = await channel.send(content);
                    eventMessages[eventId] = message;
                    eventData[eventId].messageId = message.id;
                }

                // Wait for the specified delay before processing the next event
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        await saveData();
        console.log(`[${getTimestamp()}] Update completed.`);
    } catch (error) {
        console.error(`[${getTimestamp()}] Handled Error in updateEventMessages: ${error}`);
		errorLogStream.write(`[${getTimestamp()}] Handled Error in updateEventMessages: ${error}\n`);
    } finally {
        // Call updateEventMessages again after a delay
        setTimeout(updateEventMessages, Object.keys(eventData).length > 0 ? 500 : 30000); // 500ms extra delay to avoid rate limiting with fewer events present
    }
}

async function postErrorLog() {
    try {
        // Read the contents of the error log file
        const errorLog = await fs.promises.readFile('error.log', 'utf8');

        // Calculate the current uptime and total uptime
        const currentUptime = Math.floor(client.uptime / (24 * 60 * 60 * 1000));
        const totalUptime = currentUptime + previousUptime;

        // Update the total downtime
        totalDowntime += Math.max(0, 7 - currentUptime);

        // Send the contents of the error log file to the Discord channel
        const channel = client.channels.cache.get(logChannelId);
        await channel.send(`Current uptime: ${currentUptime} days\nTotal uptime: ${totalUptime} days\nTotal downtime: ${totalDowntime} days\n\nWeekly error report:\n${errorLog}`);

        // Clear the error log file
        await fs.promises.writeFile('error.log', '');

        // Update the previous uptime
        previousUptime = totalUptime;
    } catch (error) {
        console.error(`[${getTimestamp()}] Error posting error log: ${error}`);
		errorLogStream.write(`[${getTimestamp()}] Error posting error log: ${error}\n`);
    }
}

// Event: Bot is ready
client.on('ready', async () => {
    console.log(`[${getTimestamp()}] Logged in as ${client.user.tag} v${botVersion}!`);
	const channel = client.channels.cache.get(logChannelId);
    channel.send(`[${getTimestamp()}] ${client.user} v${botVersion} is now online!`);

    // Load event data and update event messages
    await loadData();
    await updateEventMessages();
});

// Log unhandled promise rejections
process.on('unhandledRejection', error => {
    console.error(`[${getTimestamp()}] Unhandled promise rejection:`, error);
    const channel = client.channels.cache.get(logChannelId);
    channel.send(`[${getTimestamp()}] Unhandled promise rejection: ${error}`);
	errorLogStream.write(`[${getTimestamp()}] ${error}\n`);
});

// Log uncaught exceptions
process.on('uncaughtException', error => {
    console.error(`[${getTimestamp()}] Uncaught exception:`, error);
    const channel = client.channels.cache.get(logChannelId);
    channel.send(`[${getTimestamp()}] Uncaught exception: ${error}`);
	errorLogStream.write(`[${getTimestamp()}] ${error}\n`);
});

// Log in to the Discord bot
client.login(process.env.BOT_TOKEN);

// Call postErrorLog every 7 days (in milliseconds)
setInterval(postErrorLog, 7 * 24 * 60 * 60 * 1000);
