'use strict';

// Isolated Discord Activity experiment. Never publishes to the production
// Crashday guild; all Discord actions are restricted to these test IDs.
// Test-mode/HTTPS configuration is gated again in WinterBot bootstrap.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DateTime } = require('luxon');
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  PermissionFlagsBits, SlashCommandBuilder, MessageFlags, ApplicationFlags,
} = require('discord.js');
const { SchedulingStore } = require('./store');
const {
  createRound, listDays, enroll, setDays, advance, closeCollection,
  calculateCandidates, startVote, castVote,
} = require('./core');

const GUILD_ID = '818423564901416991';
const CHANNEL_ID = '1558470955930755162';
const LAUNCH_ID = 'winterbot:activity:test:launch';
const COOKIE = 'winterbot_activity_session';
const PUBLIC = path.join(__dirname, 'activity-public');
const MAX_REQUEST = 32768;

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}
function assert(condition, message, status = 400) {
  if (!condition) throw fail(status, message);
}
function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function jsonBody(req) {
  assert(String(req.headers['content-type'] || '').split(';')[0] === 'application/json',
    'Content-Type must be application/json.', 415);
  let size = 0;
  const buffers = [];
  for await (const chunk of req) {
    size += chunk.length;
    assert(size <= MAX_REQUEST, 'Request too large.', 413);
    buffers.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid JSON object.');
    return value;
  } catch (error) {
    if (error.status) throw error;
    throw fail(400, 'Invalid JSON.');
  }
}
function parseCookies(req) {
  const raw = String(req.headers.cookie || '');
  return Object.fromEntries(raw.split(';').map(x => {
    const i = x.indexOf('=');
    return i === -1 ? ['', ''] : [x.slice(0, i).trim(), x.slice(i + 1).trim()];
  }));
}
function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function createActivityTest({ client, clientId, clientSecret, sessionSecret,
  dataFile, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  assert(client && typeof client.guilds?.fetch === 'function', 'Discord bot client is required.');
  assert(/^\d{15,22}$/.test(String(clientId || '')), 'A valid Discord application ID is required.');
  assert(clientSecret && typeof clientSecret === 'string', 'Discord client secret is required.');
  assert(typeof sessionSecret === 'string' && sessionSecret.length >= 32,
    'A 32+ character session secret is required.');
  const origin = 'https://' + clientId + '.discordsays.com';
  const store = new SchedulingStore(dataFile || path.join(process.cwd(), 'scheduling-activity-test.json'));
  store.initialize();
  let initialized = false;

  const sign = data => crypto.createHmac('sha256', sessionSecret).update(data).digest('base64url');
  const cookieHeader = user => {
    const data = Buffer.from(JSON.stringify({
      id: user.id, exp: now().getTime() + 86400000,
    })).toString('base64url');
    // Discord Activity iframes require Partitioned + SameSite=None.
    return COOKIE + '=' + data + '.' + sign(data) + '; HttpOnly; Secure; SameSite=None;' +
      ' Partitioned; Domain=' + clientId + '.discordsays.com; Path=/; Max-Age=86400';
  };
  function session(req) {
    const token = parseCookies(req)[COOKIE];
    if (!token || token.length > 1024) return null;
    const index = token.lastIndexOf('.');
    if (index < 1 || !same(token.slice(index + 1), sign(token.slice(0, index)))) return null;
    try {
      const data = JSON.parse(Buffer.from(token.slice(0, index), 'base64url').toString('utf8'));
      if (data.exp <= now().getTime() || !/^\d{15,22}$/.test(String(data.id))) return null;
      return String(data.id);
    } catch (_) { return null; }
  }
  async function access(userId) {
    const guild = await client.guilds.fetch(GUILD_ID);
    assert(guild, 'WinterBot must be invited to the Activity test server.', 503);
    let member;
    try {
      member = await guild.members.fetch({ user: userId, force: true });
    } catch (_) {
      throw fail(403, 'You must be a member of the WinterBot test server.');
    }
    const channel = await guild.channels.fetch(CHANNEL_ID);
    assert(channel?.guildId === GUILD_ID &&
      channel.permissionsFor?.(member)?.has(PermissionFlagsBits.ViewChannel),
      'You must have access to the WinterBot test channel.', 403);
    assert(member && !member.user?.bot,
      'Bot accounts cannot submit availability.', 403);
    return { id: userId, name: String(member.displayName || member.user?.username || userId).slice(0, 70) };
  }
  async function requireUser(req) {
    const id = session(req);
    if (!id) throw fail(401, 'Your Discord Activity session has expired. Relaunch the Activity.');
    return access(id);
  }
  function writeAllowed(req) {
    assert(req.headers.origin === origin &&
      req.headers['x-winterbot-activity'] === '1',
      'Invalid Activity request origin or anti-CSRF header.', 403);
  }
  function currentRound() {
    const rounds = store.read().rounds;
    return rounds[rounds.length - 1] || null;
  }
  async function ensureRound() {
    if (currentRound()) return currentRound();
    await store.transaction(data => {
      if (data.rounds.length) return;
      const start = DateTime.fromJSDate(now()).setZone('Europe/Amsterdam')
        .plus({ days: 7 }).startOf('day');
      const r = createRound({
        title: 'WinterBot Activity Test Night',
        startDate: start.toISODate(), endDate: start.plus({ days: 2 }).toISODate(),
        timezone: 'Europe/Amsterdam', selectedDates: [
          start.toISODate(), start.plus({ days: 1 }).toISODate(), start.plus({ days: 2 }).toISODate(),
        ],
        dayLimits: {
          [start.toISODate()]: { start: '17:30', end: '24:00' },
          [start.plus({ days: 1 }).toISODate()]: { start: '10:00', end: '24:00' },
          [start.plus({ days: 2 }).toISODate()]: { start: '14:00', end: '22:00' },
        },
        minDurationMinutes: 60, maxDurationMinutes: 180, durationStepMinutes: 30,
        collectionHours: 336, voteHours: 24, testMode: true,
        destination: 'league', location: 'Isolated Discord Activity test',
      }, now());
      data.rounds.push(r);
    });
    return currentRound();
  }
  function publicRound(round, userId) {
    const own = round.availability[userId] || {};
    return {
      id: round.id, title: round.title, timezone: round.timezone,
      phase: round.phase, dates: listDays(round),
      dayLimits: round.dayLimits || {}, minDurationMinutes: round.minDurationMinutes,
      maxDurationMinutes: round.maxDurationMinutes,
      collectionClosesAt: round.collectionClosesAt,
      availability: structuredClone(own),
      ballot: round.phase === 'voting' && round.ballot
        ? { closesAt: round.ballot.closesAt, options: round.ballot.options.map(x => ({
          id: x.id, date: x.date, time: x.time,
          durationMinutes: x.durationMinutes,
        })), votes: round.ballot.votes[userId] || [] }
        : null,
    };
  }

  async function handle(req, res, url) {
    const pathName = url.pathname;
    try {
      if (req.method === 'GET' && pathName === '/activity/api/config') {
        return send(res, 200, { clientId, guildId: GUILD_ID, channelId: CHANNEL_ID });
      }
      if (req.method === 'GET' && [
        '/activity/', '/activity/index.html', '/activity/activity.js', '/activity/styles.css',
      ].includes(pathName)) {
        const name = pathName.endsWith('/') ? 'index.html' : pathName.split('/').at(-1);
        const contentType = name.endsWith('.html') ? 'text/html' :
          name.endsWith('.css') ? 'text/css' : 'text/javascript';
        res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8', 'Cache-Control': 'no-store' });
        fs.createReadStream(path.join(PUBLIC, name)).pipe(res);
        return;
      }
      if (!pathName.startsWith('/activity/api/')) throw fail(404, 'Activity resource not found.');
      if (req.method === 'POST' && pathName === '/activity/api/token') {
        writeAllowed(req);
        const body = await jsonBody(req);
        assert(typeof body.code === 'string' && body.code.length >= 4 && body.code.length <= 512,
          'Invalid Discord authorization code.');
        const response = await fetchImpl('https://discord.com/api/v10/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId, client_secret: clientSecret,
            grant_type: 'authorization_code', code: body.code,
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw fail(401, 'Discord authorization failed. Relaunch the Activity.');
        const tokens = await response.json();
        assert(tokens && typeof tokens.access_token === 'string' && tokens.access_token.length,
          'Discord did not return a valid access token.', 401);
        const userResponse = await fetchImpl('https://discord.com/api/v10/users/@me', {
          headers: { Authorization: 'Bearer ' + tokens.access_token },
          signal: AbortSignal.timeout(10000),
        });
        if (!userResponse.ok) throw fail(401, 'Unable to verify your Discord account.');
        const user = await userResponse.json();
        assert(/^\d{15,22}$/.test(String(user?.id || '')), 'Discord returned an invalid user.', 401);
        await access(String(user.id));
        res.setHeader('Set-Cookie', cookieHeader(user));
        return send(res, 200, { access_token: tokens.access_token });
      }
      if (req.method === 'GET' && pathName === '/activity/api/state') {
        const user = await requireUser(req);
        const round = await ensureRound();
        return send(res, 200, { user, round: publicRound(round, user.id),
          sandbox: true, neverCreatesDiscordEvents: true });
      }
      if (req.method === 'POST' && pathName === '/activity/api/availability') {
        writeAllowed(req);
        const user = await requireUser(req);
        const body = await jsonBody(req);
        assert(Array.isArray(body.days) && body.days.length > 0,
          'Select at least one date to save.');
        await ensureRound();
        await store.transaction(data => {
          const round = data.rounds.at(-1);
          advance(round, now());
          if (round.rosterMode === 'open') enroll(round, user.id, user.name);
          setDays(round, user.id, body.days, now());
        });
        return send(res, 200, { round: publicRound(currentRound(), user.id) });
      }
      if (req.method === 'POST' && pathName === '/activity/api/vote') {
        writeAllowed(req);
        const user = await requireUser(req);
        const body = await jsonBody(req);
        assert(Array.isArray(body.candidateIds), 'Provide selected candidate IDs.');
        await store.transaction(data => {
          const round = data.rounds.at(-1);
          assert(round, 'Test round does not exist.', 404);
          advance(round, now());
          castVote(round, user.id, body.candidateIds, now());
        });
        return send(res, 200, { round: publicRound(currentRound(), user.id) });
      }
      throw fail(404, 'Activity resource not found.');
    } catch (error) {
      const status = error.status || 400;
      if (status >= 500) console.error('WinterBot Activity test request failed:', error.message);
      return send(res, status, { error: error.message || 'Activity request failed.' });
    }
  }

  function command() {
    return new SlashCommandBuilder()
      .setName('activitytest')
      .setDescription('WinterBot embedded Activity testing, isolated to the test server')
      .setDMPermission(false)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand(x => x.setName('invite').setDescription('Post a private-server Activity test invitation'))
      .addSubcommand(x => x.setName('status').setDescription('Check whether Discord has enabled the test Activity'))
      .addSubcommand(x => x.setName('vote').setDescription('Close test availability and open a test ballot'))
      .addSubcommand(x => x.setName('reset').setDescription('Reset isolated Activity test data'));
  }
  function launchButton() {
    return new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(LAUNCH_ID).setStyle(ButtonStyle.Primary)
      .setLabel('Open availability planner in Discord'));
  }
  async function onInteraction(interaction) {
    if (interaction.isButton?.() && interaction.customId === LAUNCH_ID) {
      if (interaction.guildId !== GUILD_ID || interaction.channelId !== CHANNEL_ID ||
        interaction.message?.author?.id !== client.user.id) {
        return interaction.reply({ content: 'This Activity is restricted to the WinterBot test channel.',
          flags: MessageFlags.Ephemeral });
      }
      // Discord.js handles type-12 LAUNCH_ACTIVITY callbacks directly.
      // Unlike a normal bot-authenticated REST call, interaction responses
      // MUST use auth:false. The supported method also tracks ACK state.
      try {
        await interaction.launchActivity();
      } catch (error) {
        const code = Number(error?.code) || null;
        const status = Number(error?.status) || null;
        const detail = String(error?.message || 'Unknown Discord API error')
          .replace(/\s+/g, ' ').slice(0, 180);
        // No interaction IDs, tokens, bot tokens or OAuth secrets in logs.
        console.error('WinterBot test Activity launch failed:', {
          code, status, detail,
        });
        // An actionable private reply is much better than silently letting
        // the interaction time out. If Discord rejected the ACK too late,
        // preserve the diagnostic in the host console.
        await interaction.reply({
          content: 'WinterBot could not launch the Discord Activity. ' +
            'Check Activities are enabled for WinterBot in the Developer Portal. ' +
            (code ? 'Discord error ' + code + '. ' : '') + detail,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        }).catch(replyError => {
          console.error('WinterBot test Activity error reply also failed:', {
            code: Number(replyError?.code) || null,
            status: Number(replyError?.status) || null,
          });
        });
      }
      return;
    }
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'activitytest') return;
    try {
      assert(interaction.guildId === GUILD_ID && interaction.channelId === CHANNEL_ID,
        'This command works only in the WinterBot test channel.', 403);
      const owner = interaction.guild?.ownerId === interaction.user.id;
      assert(owner || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild),
        'Manage Server permission is required for test setup.', 403);
      const option = interaction.options.getSubcommand();
      if (option === 'status') {
        const app = await client.application.fetch();
        const enabled = Boolean(app.flags?.has(ApplicationFlags.Embedded));
        await interaction.reply({
          content: enabled
            ? 'Discord reports that WinterBot Activities are ENABLED. ' +
              'If the launch button fails, check Activities → URL Mappings in the Developer Portal. ' +
              'The expected test mapping is / → pension-aground-bullpen.ngrok-free.dev/activity/.'
            : 'Discord reports that WinterBot Activities are NOT ENABLED. ' +
              'In the Developer Portal, configure Activities → URL Mappings, ' +
              'then turn on Activities → Settings → Enable Activities. ' +
              'The /activitytest invitation works without this, but launching the Activity does not.',
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
        return;
      }
      if (option === 'reset') {
        await store.transaction(data => { data.rounds = []; });
        await ensureRound();
        await interaction.reply({ content: 'Isolated Activity test data reset. No main-server data changed.',
          flags: MessageFlags.Ephemeral });
        return;
      }
      const round = await ensureRound();
      if (option === 'invite') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const channel = await client.channels.fetch(CHANNEL_ID);
        assert(channel?.guildId === GUILD_ID, 'Test channel is not accessible.', 503);
        const msg = await channel.send({
          embeds: [new EmbedBuilder().setColor(0x859df3).setTitle('WinterBot · Discord Activity test')
            .setDescription('Test the member availability planner **inside Discord**. ' +
              'All responses are isolated from the main Crashday server and no real events are created.')
            .addFields(
              { name: 'Possible dates', value: listDays(round).join('\n') },
              { name: 'Status', value: round.phase === 'voting' ? 'Test ballot open' : 'Test availability open' },
            ).setFooter({ text: 'WinterBot Activity · test server only' })],
          components: [launchButton()],
          allowedMentions: { parse: [] },
        });
        await interaction.editReply('Posted Activity invitation in this channel: ' + msg.url);
        return;
      }
      if (option === 'vote') {
        assert(round.phase === 'collecting', 'Test round is not collecting availability.');
        await store.transaction(data => {
          closeCollection(data.rounds.at(-1), now(), true);
          const r = data.rounds.at(-1);
          const options = r.candidates.slice(0, 8).map(c => ({
            candidateId: c.id, startAt: c.slots[0].startAt,
          }));
          assert(options.length >= 2,
            'At least two feasible scheduling options are needed. Submit more availability first.');
          startVote(r, options, now());
        });
        const channel = await client.channels.fetch(CHANNEL_ID);
        await channel.send({
          embeds: [new EmbedBuilder().setColor(0xa59cf1)
            .setTitle('WinterBot · Test vote is open')
            .setDescription('A new vote announcement, separate from the original availability invitation. ' +
              'Open the Activity to choose your preferred times.')
            .setFooter({ text: 'No real scheduled events will be created.' })],
          components: [launchButton()], allowedMentions: { parse: [] },
        });
        await interaction.reply({ content: 'Test vote opened and announced in a new message.',
          flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('Activity test failed: ' + error.message).catch(() => {});
      } else {
        await interaction.reply({ content: 'Activity test failed: ' + error.message,
          flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  }

  async function start() {
    if (initialized) return;
    // Never register the command in the production guild.
    const guild = await client.guilds.fetch(GUILD_ID);
    assert(guild, 'WinterBot has not been invited to the isolated test server.', 503);
    const channel = await guild.channels.fetch(CHANNEL_ID);
    assert(channel?.guildId === GUILD_ID && channel.isTextBased?.(),
      'WinterBot cannot access the isolated test channel.', 503);
    await ensureRound();
    await guild.commands.create(command().toJSON());
    client.on('interactionCreate', onInteraction);
    initialized = true;
  }
  function stop() {
    if (initialized) client.off('interactionCreate', onInteraction);
    initialized = false;
  }
  return {
    handle, start, stop, store, ensureRound, publicRound, onInteraction,
    get testIds() { return {guildId:GUILD_ID,channelId:CHANNEL_ID}; },
    get origin() { return origin; },
  };
}

module.exports = { createActivityTest, GUILD_ID, CHANNEL_ID, LAUNCH_ID };
