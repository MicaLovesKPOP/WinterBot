require('dotenv').config();

const Discord = require('discord.js');
const client = new Discord.Client({ intents: Discord.GatewayIntentBits.Guilds });
const fs = require('fs');
const path = require('path');

const guildId = '199916140183420928'; // Official Crashday discord
const channelId = '1113151362507755531'; // #reg-tracking channel
const logChannelId = '332575578383187970'; // #bot-logs channel

const logDir = path.join(process.cwd(), 'logs');
try { if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}

const logPath = path.join(logDir, 'error.log');
const MAX_SIZE = 1 * 1024 * 1024; // 1 MB
const MAX_BACKUPS = 5;

const versionFile = path.join(__dirname, 'version.txt');
const botFile = path.join(__dirname, 'WinterBot.js');

let eventMessages = {};
let eventData = {};

let previousUptimeMinutes = 0;
let totalUptimeMinutes = 0;
let totalDowntimeMinutes = 0;
let lastSavedUptime = 0;
let lastSavedAt = 0; // wall-clock ms when uptimeData.json was last saved

// --- Version auto-increment (keeps your existing behaviour) ---
let botVersion = '1.0.0';
let lastBotMTime = 0;
try {
    if (fs.existsSync(versionFile)) {
        const saved = fs.readFileSync(versionFile, 'utf8').split(',');
        if (saved.length === 2) {
            botVersion = saved[0];
            lastBotMTime = Number(saved[1]) || 0;
        }
    }

    const stats = fs.statSync(botFile);
    const mtimeMs = stats.mtimeMs;

    if (mtimeMs > lastBotMTime) {
        const parts = botVersion.split('.').map(Number); // [major, minor, patch]
        if (parts.length === 3) {
            parts[2] += 1;   // patch++
            botVersion = parts.join('.');
        } else {
            botVersion += '.0.1';
        }
        try { fs.writeFileSync(versionFile, `${botVersion},${mtimeMs}`, 'utf8'); } catch (_) {}
    }
} catch (err) {
    // avoid failing startup if version file or bot file stat fails
    console.error('Version-check failed:', err && err.message ? err.message : err);
}

console.log(`Running WinterBot v${botVersion}`);

// --------------------
// Log rotation + safe write helpers (hardened)
// --------------------
let diskFull = false;           // set to true on first ENOSPC to avoid recursion
let lastErrorSent = 0;          // cooldown for sending errors to Discord
const ERROR_COOLDOWN_MS = 60 * 1000; // 1 minute cooldown for Discord error posts

function rotateLogs() {
    try {
        if (!fs.existsSync(logPath)) return;
        const stats = fs.statSync(logPath);
        if (stats.size < MAX_SIZE) return;

        const oldest = `${logPath}.${MAX_BACKUPS}`;
        if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

        for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
            const src = `${logPath}.${i}`;
            const dest = `${logPath}.${i + 1}`;
            if (fs.existsSync(src)) fs.renameSync(src, dest);
        }

        fs.renameSync(logPath, `${logPath}.1`);
    } catch (err) {
        // Don't throw from rotateLogs; if rotation fails we still try to continue.
        console.error(`[${getTimestamp()}] rotateLogs failed: ${err && err.message ? err.message : err}`);
    }
}

/**
 * Safe file-write for errors.
 * - Stops trying to write after the first ENOSPC (diskFull flag).
 * - Catches other errors and logs them to console.
 */
function safeWriteError(message) {
    // Always output to console immediately so we have at least one record
    try { console.error(message); } catch (_) {}

    if (diskFull) return; // already detected disk full — avoid repeating writes

    try {
        rotateLogs();
        fs.appendFileSync(logPath, message + '\n', 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOSPC') {
            diskFull = true;
            try { console.error(`[${getTimestamp()}] Disk full detected; disabling file logging.`); } catch (_) {}
        } else {
            try { console.error(`[${getTimestamp()}] safeWriteError failed: ${err && err.stack ? err.stack : err}`); } catch (_) {}
        }
    }
}

/**
 * Human-readable timestamp
 */
function getTimestamp() {
    const now = new Date();
    const year = now.getFullYear().toString().slice(-2);
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    return `${year}${month}${day} ${hours}:${minutes}:${seconds}`;
}

function splitMessageIntoChunks(message, chunkSize) {
    let chunks = [];
    while (message.length > chunkSize) {
        let chunk = message.substring(0, chunkSize);
        chunks.push(chunk);
        message = message.substring(chunkSize);
    }
    chunks.push(message);
    return chunks;
}

// --------------------
// Summary-safe Discord + file error logger (throttled)
// --------------------
function safeGetLogChannel() {
    try {
        if (!client || !client.isReady?.()) return null;
        const ch = client.channels.cache.get(logChannelId);
        return ch || null;
    } catch (_) { return null; }
}

/**
 * Writes the error to logs and posts to Discord, but with:
 * - diskFull protection (safeWriteError)
 * - a cooldown for Discord posts (ERROR_COOLDOWN_MS)
 */
async function logErrorEverywhere(prefix, err) {
    const ts = getTimestamp();
    const msg = `[${ts}] ${prefix}: ${err && err.stack ? err.stack : err}`;

    // Always write to console and (attempt) file safely
    try { console.error(msg); } catch (_) {}
    safeWriteError(msg);

    // Throttle sending to Discord
    const now = Date.now();
    if (now - lastErrorSent < ERROR_COOLDOWN_MS) return;
    lastErrorSent = now;

    const ch = safeGetLogChannel();
    if (ch) {
        try { await ch.send(msg); } catch (_) { /* ignore send errors */ }
    }
}

// --------------------
// Data persistence helpers (events)
// --------------------
async function saveData() {
    try {
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
        safeWriteError(`[${getTimestamp()}] Handled Error saving data: ${error}`);
    }
}

async function loadData() {
    try {
        let jsonData;
        try {
            jsonData = await fs.promises.readFile('data.json', 'utf8');
        } catch (err) {
            if (err.code === 'ENOENT') {
                jsonData = '{"eventData":{}}';
            } else {
                throw err;
            }
        }

        const parsed = JSON.parse(jsonData);
        eventData = parsed.eventData || {};

        Object.values(eventData).forEach(event => {
            if (Array.isArray(event.subscribedUsers)) {
                event.subscribedUsers = Object.fromEntries(event.subscribedUsers);
            }
            if (Array.isArray(event.unsubscribedUsers)) {
                event.unsubscribedUsers = Object.fromEntries(event.unsubscribedUsers);
            }
            if (!event.unsubscribedUsers) {
                event.unsubscribedUsers = {};
            }
        });

        console.log(`[${getTimestamp()}] Data loaded successfully.`);
    } catch (error) {
        console.error(`[${getTimestamp()}] Handled Error loading data: ${error}`);
        safeWriteError(`[${getTimestamp()}] Handled Error loading data: ${error}`);
    }
}

// --------------------
// HTTP/Discord fetch for subscribed users — replace errorLogStream usage
// --------------------
async function fetchSubscribedUsers(guildId, eventId, retryCount = 0) {
    const MAX_RETRIES = 3;
    try {
        const fetch = await import('node-fetch');
        const response = await fetch.default(
            `https://discord.com/api/v9/guilds/${guildId}/scheduled-events/${eventId}/users`,
            { headers: { 'Authorization': `Bot ${process.env.BOT_TOKEN}` } }
        );

        if (!response.ok) {
            const text = await response.text();
            const errMsg = `[${getTimestamp()}] Discord API ${response.status}: ${text}`;
            safeWriteError(errMsg);

            if (response.status === 429) {
                const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
                await new Promise(res => setTimeout(res, retryAfter * 1000));
                return fetchSubscribedUsers(guildId, eventId, retryCount + 1);
            }

            if (response.status >= 500 && retryCount < MAX_RETRIES) {
                const backoff = Math.pow(2, retryCount) * 1000;
                await new Promise(res => setTimeout(res, backoff));
                return fetchSubscribedUsers(guildId, eventId, retryCount + 1);
            }

            return [];
        }

        const ct = response.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
            const text = await response.text();
            safeWriteError(`[${getTimestamp()}] Unexpected content-type ${ct}: ${text}`);
            return [];
        }

        return await response.json();
    } catch (error) {
        safeWriteError(`[${getTimestamp()}] Fetch error (${error && error.name}): ${error && error.message ? error.message : error}`);
        if (retryCount < MAX_RETRIES) {
            const backoff = Math.pow(2, retryCount) * 1000;
            await new Promise(res => setTimeout(res, backoff));
            return fetchSubscribedUsers(guildId, eventId, retryCount + 1);
        }
        return [];
    }
}

// --------------------
// Event update loop (unchanged except error logging uses safeWriteError/logErrorEverywhere)
// --------------------
async function updateEventMessages() {
    try {
        const guild = client.guilds.cache.get(guildId);
        const events = await guild.scheduledEvents.fetch();
        console.log(`[${getTimestamp()}] Fetched ${events.size} ${events.size === 1 ? 'event' : 'events'}`);

        const delay = events.size > 0 ? 5000 : 0;
        const knownEventIds = Object.keys(eventData);
        const fetchedEventIds = events.map(event => event.id);
        const removedEventIds = knownEventIds.filter(eventId => !fetchedEventIds.includes(eventId));

        for (const eventId of removedEventIds) {
            eventData[eventId].eventStatus = '(past event)';
            let content = eventData[eventId].eventMessage + eventData[eventId].eventStatus + ':\n';
            let count = 1;
            Object.entries(eventData[eventId].subscribedUsers).forEach(([username, timestamp]) => {
                content += `${count}. ${username}\n`;
                count++;
            });

            const unsubscribedUsernamesString = Object.keys(eventData[eventId].unsubscribedUsers).join(', ');

            if (unsubscribedUsernamesString.length > 0) {
                content += `\nDeregistered players: ${unsubscribedUsernamesString}\n`;
            }

            if (eventData[eventId].messageId) {
                try {
                    const channel = client.channels.cache.get(channelId);
                    const message = await channel.messages.fetch(eventData[eventId].messageId);
                    await message.edit(content);
                } catch (error) {
                    console.error(`[${getTimestamp()}] Error updating message: ${error}`);
                    safeWriteError(`[${getTimestamp()}] Error updating message: ${error}`);
                }
            } else if (eventMessages[eventId]) {
                await eventMessages[eventId].edit(content);
            }

            delete eventData[eventId];
        }

        for (const event of events.values()) {
            const eventId = event.id;
            console.log(`[${getTimestamp()}] Processing event ${eventId}: '${event.name}'`);

            if (event && !event.ended) {
                let users;
                if (!client.subscribedUsersPromise) client.subscribedUsersPromise = {};
                if (!client.subscribedUsersPromise[eventId]) client.subscribedUsersPromise[eventId] = fetchSubscribedUsers(guildId, eventId);
                users = await client.subscribedUsersPromise[eventId];
                delete client.subscribedUsersPromise[eventId];

                let usernames = [];
                if (Array.isArray(users)) {
                    usernames = users.map(user => user.user.username);
                } else {
                    console.error(`[${getTimestamp()}] Error: users is not an array: ${JSON.stringify(users)}`);
                    safeWriteError(`[${getTimestamp()}] Error: users is not an array: ${JSON.stringify(users)}`);
                }

                if (!eventData[eventId]) {
                    eventData[eventId] = {
                        subscribedUsers: {},
                        unsubscribedUsers: {},
                        unsubscribedTimestamps: {},
                        eventMessage: `**Registered players for ${event.name}** `,
                        eventStatus: ''
                    };
                } else if (!eventData[eventId].unsubscribedUsers) {
                    eventData[eventId].unsubscribedUsers = {};
                }

                if (eventData[eventId].eventName !== event.name) {
                    eventData[eventId].eventName = event.name;
                    eventData[eventId].eventMessage = `**Registered players for ${event.name}** `;
                }
                let content = eventData[eventId].eventMessage + eventData[eventId].eventStatus + '**:**\n';

                usernames.forEach(username => {
                    if (!eventData[eventId].subscribedUsers[username]) {
                        eventData[eventId].subscribedUsers[username] = {
                            timestamp: Date.now(),
                            apiCheckCounter: 0
                        };
                    }
                    if (eventData[eventId].unsubscribedUsers[username]) {
                        delete eventData[eventId].unsubscribedUsers[username];
                    }
                });

                const previousUsernames = Object.keys(eventData[eventId].subscribedUsers);
                const unsubscribedUsernames = previousUsernames.filter(username => !usernames.includes(username));

                unsubscribedUsernames.forEach(username => {
                    eventData[eventId].subscribedUsers[username].apiCheckCounter++;
                });

                const delayApiChecks = 6;
                unsubscribedUsernames.forEach(username => {
                    if (eventData[eventId].subscribedUsers[username].apiCheckCounter >= delayApiChecks) {
                        delete eventData[eventId].subscribedUsers[username];
                        eventData[eventId].unsubscribedUsers[username] = Date.now();
                    }
                });

                if (event.status === 3) {
                    eventData[eventId].eventStatus = '(past event)';
                } else if (event.status === 2) {
                    eventData[eventId].eventStatus = '(currently happening)';
                } else {
                    eventData[eventId].eventStatus = '(upcoming)';
                }

                content = eventData[eventId].eventMessage + eventData[eventId].eventStatus + ':\n';

                let count = 1;
                Object.entries(eventData[eventId].subscribedUsers).forEach(([username, timestamp]) => {
                    content += `${count}. ${username}\n`;
                    count++;
                });

                const unsubscribedUsernamesString = Object.keys(eventData[eventId].unsubscribedUsers).join(', ');

                if (unsubscribedUsernamesString.length > 0) {
                    content += `\nDeregistered players: ${unsubscribedUsernamesString}\n`;
                }

                if (eventData[eventId].messageId) {
                    try {
                        const channel = client.channels.cache.get(channelId);
                        const message = await channel.messages.fetch(eventData[eventId].messageId);
                        await message.edit(content);
                    } catch (error) {
                        console.error(`[${getTimestamp()}] Handled Error updating message: ${error}`);
                        safeWriteError(`[${getTimestamp()}] Handled Error updating message: ${error}`);
                        const channel = client.channels.cache.get(channelId);
                        if (!channel) throw new Error('Channel not found');
                        const message = await channel.send(content);
                        eventMessages[eventId] = message;
                        eventData[eventId].messageId = message.id;
                    }
                } else if (eventMessages[eventId]) {
                    await eventMessages[eventId].edit(content);
                } else {
                    const channel = client.channels.cache.get(channelId);
                    if (!channel) throw new Error('Channel not found');
                    const message = await channel.send(content);
                    eventMessages[eventId] = message;
                    eventData[eventId].messageId = message.id;
                }

                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        await saveData();
        console.log(`[${getTimestamp()}] Update completed.`);
    } catch (error) {
        console.error(`[${getTimestamp()}] Handled Error in updateEventMessages: ${error}`);
        safeWriteError(`[${getTimestamp()}] Handled Error in updateEventMessages: ${error}`);
    } finally {
        setTimeout(updateEventMessages, Object.keys(eventData).length > 0 ? 500 : 30000);
    }
}

// --------------------
// Uptime helpers & file-safe saving (atomic)
// --------------------
function formatDuration(minutes) {
    if (minutes < 1) return `${Math.floor(minutes * 60)} seconds`;
    if (minutes < 60) return `${Math.floor(minutes)} minutes`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)} hours`;
    if (minutes < 10080) return `${Math.floor(minutes / 1440)} days`;
    if (minutes < 43200) return `${Math.floor(minutes / 10080)} weeks`;
    if (minutes < 525600) return `${Math.floor(minutes / 43200)} months`;
    return `${Math.floor(minutes / 525600)} years`;
}

const uptimeFile = path.join(process.cwd(), 'uptimeData.json');

// --------------------
// Save uptime/downtime to file (robust, atomic, with lastSavedAt)
// --------------------
async function saveUptimeData() {
    try {
        const currentUptimeMinutes = Math.floor(client.uptime / 60000);
        const delta = currentUptimeMinutes - lastSavedUptime;

        if (delta > 0) {
            totalUptimeMinutes += delta; // add only new uptime
            lastSavedUptime = currentUptimeMinutes;
        }

        // Persist the wall-clock time we saved at
        lastSavedAt = Date.now();

        // Prepare data
        const data = {
            totalUptimeMinutes,
            previousUptimeMinutes: totalUptimeMinutes,
            totalDowntimeMinutes,
            lastSavedAt
        };

        // Atomic write: write tmp then rename
        const tmpFile = uptimeFile + '.tmp';
        try {
            await fs.promises.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
            await fs.promises.rename(tmpFile, uptimeFile);
        } catch (err) {
            if (err && err.code === 'ENOSPC') {
                diskFull = true;
                console.error(`[${getTimestamp()}] Disk full while saving uptime data; skipping write.`);
            } else {
                console.error(`[${getTimestamp()}] Failed saving uptime data: ${err && err.message ? err.message : err}`);
            }
        }

        console.log(`[${getTimestamp()}] Uptime data saved successfully.`);
    } catch (error) {
        console.error(`[${getTimestamp()}] Error saving uptime data: ${error}`);
        safeWriteError(`[${getTimestamp()}] Error saving uptime data: ${error}`);
    }
}

// --------------------
// Synchronous save for shutdown / signal handling
// --------------------
function saveUptimeDataSync() {
    try {
        // compute current uptime minutes safely (client may not be ready)
        const currentUptimeMinutes = Math.floor((client && client.uptime) ? client.uptime / 60000 : 0);
        const delta = currentUptimeMinutes - lastSavedUptime;

        if (delta > 0) {
            totalUptimeMinutes += delta;
            lastSavedUptime = currentUptimeMinutes;
        }

        const previousTotal = previousUptimeMinutes + totalDowntimeMinutes;
        totalDowntimeMinutes = Math.max(0, previousTotal - totalUptimeMinutes);

        lastSavedAt = Date.now();

        const data = {
            totalUptimeMinutes,
            previousUptimeMinutes: totalUptimeMinutes,
            totalDowntimeMinutes,
            lastSavedAt
        };

        // Atomic-ish synchronous write: write tmp, then rename
        const tmp = uptimeFile + '.tmp';
        try {
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
            try { fs.renameSync(tmp, uptimeFile); } catch (e) { /* non-fatal */ }
        } catch (err) {
            if (err && err.code === 'ENOSPC') {
                diskFull = true;
                try { console.error(`[${getTimestamp()}] Disk full while saving uptime (sync).`); } catch(_) {}
            } else {
                try { console.error(`[${getTimestamp()}] Failed sync save uptime: ${err && err.message ? err.message : err}`); } catch(_) {}
            }
        }
    } catch (err) {
        // keep minimal in signal path; avoid throwing
        try { console.error(`[${getTimestamp()}] saveUptimeDataSync failed: ${err && err.message ? err.message : err}`); } catch(_) {}
    }
}

// Install handlers to attempt final save on graceful shutdown/restart
process.on('SIGTERM', () => {
    try { saveUptimeDataSync(); } catch (_) {}
    // allow a short grace period for the write, then exit
    setTimeout(() => process.exit(0), 250);
});
process.on('SIGINT', () => {
    try { saveUptimeDataSync(); } catch (_) {}
    setTimeout(() => process.exit(0), 250);
});
process.on('beforeExit', (code) => {
    try { saveUptimeDataSync(); } catch (_) {}
});


// --------------------
// Load uptime/downtime from file (robust, calculates offline duration)
// --------------------
async function loadUptimeData() {
    try {
        let jsonData;
        try {
            jsonData = await fs.promises.readFile(uptimeFile, 'utf8');
        } catch (err) {
            if (err.code === 'ENOENT') jsonData = '{}';
            else throw err;
        }

        const data = JSON.parse(jsonData || '{}');

        // Restore totals (or start at zero)
        previousUptimeMinutes = Number(data.previousUptimeMinutes) || 0;
        totalUptimeMinutes = Number(data.totalUptimeMinutes ?? previousUptimeMinutes) || 0;
        totalDowntimeMinutes = Number(data.totalDowntimeMinutes) || 0;
        lastSavedAt = Number(data.lastSavedAt) || 0;

        // Compute offline interval since lastSavedAt:
        // offlineMs = time since last save - current uptime (ms)
        // If > 0, that's time bot was offline
        if (lastSavedAt > 0) {
            const now = Date.now();
            const offlineMs = now - lastSavedAt - client.uptime; // client.uptime is ms
            if (offlineMs > 0) {
                const offlineMinutes = Math.floor(offlineMs / 60000);
                if (offlineMinutes > 0) {
                    totalDowntimeMinutes += offlineMinutes;
                }
            }
        }

        console.log(`[${getTimestamp()}] Uptime data loaded successfully.`);

        // Reset lastSavedUptime to current uptime (avoid double counting)
        lastSavedUptime = Math.floor(client.uptime / 60000);

        // Persist immediately so lastSavedAt is up-to-date on disk (helps if crash follows)
        try { await saveUptimeData(); } catch (_) { /* save already handles errors */ }

        // Send startup message
        const currentUptimeMinutes = lastSavedUptime;
        const message =
            `[${getTimestamp()}] ${client.user} v${botVersion} is now online!\n\n` +
            // `Current uptime: \`${formatDuration(currentUptimeMinutes)}\`\n` +
            `Total uptime: \`${formatDuration(totalUptimeMinutes)}\`\n` +
            `Total downtime: \`${formatDuration(totalDowntimeMinutes)}\``;

        const channel = client.channels.cache.get(logChannelId);
        if (channel) await channel.send(message);

    } catch (error) {
        console.error(`[${getTimestamp()}] Error loading uptime data: ${error}`);
        safeWriteError(`[${getTimestamp()}] Error loading uptime data: ${error}`);
    }
}

// --------------------
// Weekly error report (unchanged behavior)
// --------------------
async function postErrorLog() {
    try {
        let errorLog = '';
        try {
            errorLog = await fs.promises.readFile('error.log', 'utf8');
        } catch (_) { /* ignore missing file */ }

        const hasErrors = (errorLog || '').trim().length > 0;

        await saveUptimeData();

        const currentUptimeMinutes = Math.floor(client.uptime / 60000);

        const message =
            `Current uptime: \`${formatDuration(currentUptimeMinutes)}\`\n` +
            `Total uptime: \`${formatDuration(totalUptimeMinutes)}\`\n` +
            `Total downtime: \`${formatDuration(totalDowntimeMinutes)}\`\n\n` +
            `Weekly error report:\n${hasErrors ? `\`\`\`\n${errorLog.trim()}\n\`\`\`` : 'No errors reported this week.'}`;

        const channel = client.channels.cache.get(logChannelId);
        if (channel) {
            for (const chunk of splitMessageIntoChunks(message, 2000)) {
                await channel.send(chunk);
            }
        }

    } catch (error) {
        console.error(`[${getTimestamp()}] Error posting error log: ${error}`);
        safeWriteError(`[${getTimestamp()}] Error posting error log: ${error}`);
    }
}

// --------------------
// Install handlers & startup logic
// --------------------
process.on('unhandledRejection', async (reason, promise) => {
    await saveUptimeData().catch(()=>{});
    await logErrorEverywhere('Unhandled promise rejection', reason);
});

process.on('uncaughtException', async (error) => {
    await saveUptimeData().catch(()=>{});
    await logErrorEverywhere('Uncaught exception', error);
});

client.once('ready', async () => {
    console.log(`[${getTimestamp()}] Logged in as ${client.user.tag} v${botVersion}!`);

    await loadData();
    await loadUptimeData();

    // Save every 60 seconds to minimize lost time on unexpected restarts
    setInterval(saveUptimeData, 60 * 1000);

    await updateEventMessages();
});

client.login(process.env.BOT_TOKEN);

// Weekly report interval
setInterval(() => { if (client.isReady?.()) { postErrorLog(); } }, 604800000);
