'use strict';

const crypto = require('node:crypto');
const { isOrganizerMember, isVerifiedMember, memberCanSee } = require('./channelPolicy');

function cookieMap(req) {
  const pairs = String(req.headers.cookie || '').split(';');
  return Object.fromEntries(pairs.map(v => {
    const i = v.indexOf('=');
    return i < 0 ? ['', ''] : [v.slice(0, i).trim(), v.slice(i + 1).trim()];
  }));
}
function headerCookie(name, value, { secure = false, maxAge = 604800, clear = false } = {}) {
  return name + '=' + value + '; HttpOnly; SameSite=Lax; Path=/' +
    (secure ? '; Secure' : '') + '; Max-Age=' + (clear ? 0 : maxAge);
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}
function createAuth(options) {
  const demo = options.mode === 'demo';
  if (!demo) {
    if (!options.client || !options.guildId || !options.clientId || !options.clientSecret ||
      !options.sessionSecret || options.sessionSecret.length < 32 ||
      !options.baseUrl || !options.baseUrl.startsWith('https://')) {
      throw new Error('Live scheduling requires a logged-in Discord bot, guild ID, OAuth2 credentials, a 32+ character session secret and an HTTPS base URL.');
    }
  }
  const secure = !demo;
  const base = demo ? 'http://127.0.0.1:' + options.port : options.baseUrl.replace(/\/$/, '');
  const callback = base + '/oauth/callback';
  const demoPeople = [
    { id: 'owner', name: 'Organizer (you)', admin: true },
    { id: 'p1', name: 'Mica' }, { id: 'p2', name: 'Jisoo' },
    { id: 'p3', name: 'Mina' }, { id: 'p4', name: 'Yuna' },
    { id: 'p5', name: 'Lena' }, { id: 'p6', name: 'Kai' },
    { id: 'p7', name: 'Alex' }, { id: 'p8', name: 'Sophie' },
  ];
  const admins = new Set(options.adminIds || []);
  // Validated guild membership and permissions may be reused briefly to
  // avoid a Discord REST fetch for every availability autosave.
  const memberAuthCache = new Map();
  const MEMBER_AUTH_CACHE_MS = 60000;
  function getSession(req) {
    if (demo) {
      const requested = String(req.headers['x-demo-user'] || 'owner');
      const person = demoPeople.find(p => p.id === requested);
      if (!person) throw Object.assign(new Error('Unknown demo participant.'), { status: 401 });
      return { id: person.id, name: person.name, admin: Boolean(person.admin),
        verified: true, allowedChannelIds: [], demo: true };
    }
    const value = cookieMap(req).winterbot_session;
    if (!value) return null;
    const [payload, signature] = value.split('.');
    if (!payload || !signature || !safeEqual(signature, sign(payload, options.sessionSecret))) return null;
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!parsed.id || parsed.exp <= Date.now()) return null;
      return { id: String(parsed.id), name: String(parsed.name || parsed.id), admin: false, demo: false };
    } catch (_) {
      return null;
    }
  }
  async function identity(req) {
    const session = getSession(req);
    if (!session || demo) return session;
    const cached = memberAuthCache.get(session.id);
    if (cached && cached.expiresAt > Date.now()) return { ...session, ...cached.permissions };
    const guild = await options.client.guilds.fetch(options.guildId);
    let member;
    try {
      member = await guild.members.fetch({ user: session.id, force: true });
    } catch (_) {
      memberAuthCache.delete(session.id);
      return null;
    }
    if (!member) {
      memberAuthCache.delete(session.id);
      return null;
    }
    const policy = options.policy;
    let permissions;
    if (policy) {
      const [league, publicChannel, logs] = await Promise.all([
        guild.channels.fetch(policy.leagueChannelId), guild.channels.fetch(policy.publicChannelId),
        guild.channels.fetch(policy.logChannelId),
      ]);
      permissions = {
        admin: isOrganizerMember(member, policy, guild.ownerId),
        verified: isVerifiedMember(member, policy),
        allowedChannelIds: [league, publicChannel, logs].filter(channel =>
          channel && memberCanSee(member, channel)).map(channel => channel.id),
      };
    } else {
      permissions = { admin: guild.ownerId === session.id || admins.has(session.id),
        verified: true, allowedChannelIds: [] };
    }
    memberAuthCache.set(session.id, { permissions, expiresAt: Date.now() + MEMBER_AUTH_CACHE_MS });
    if (memberAuthCache.size > 512) memberAuthCache.delete(memberAuthCache.keys().next().value);
    return { ...session, ...permissions };
  }
  function requireOrigin(req) {
    if (demo) return;
    const expected = new URL(base).origin;
    if (req.headers.origin !== expected || req.headers['x-winterbot-request'] !== '1') {
      throw Object.assign(new Error('Request origin or anti-CSRF header is invalid.'), { status: 403 });
    }
  }
  function login(req, res) {
    const query = new URL(req.url, base).searchParams;
    const requestedRound = query.get('round') || '';
    const requestedView = query.get('view') || '';
    const returnRound = /^[a-f0-9-]{36}$/.test(requestedRound) ? requestedRound : '';
    const returnView = ['new','organizer'].includes(requestedView) ? requestedView : '';
    const state = crypto.randomBytes(24).toString('base64url');
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', options.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', callback);
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);
    res.writeHead(302, {
      Location: url.toString(),
      'Set-Cookie': [
        headerCookie('winterbot_state', state, { secure, maxAge: 600 }),
        headerCookie('winterbot_return', returnRound, { secure, maxAge: 600 }),
        headerCookie('winterbot_view', returnView, { secure, maxAge: 600 }),
      ],
      'Cache-Control': 'no-store',
    });
    res.end();
  }
  async function callbackHandler(req, res, parsed) {
    const params = parsed.searchParams;
    const state = cookieMap(req).winterbot_state;
    if (!state || !params.get('state') || !safeEqual(state, params.get('state')) || !params.get('code')) {
      throw Object.assign(new Error('Discord login state is invalid. Please try again.'), { status: 401 });
    }
    const body = new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      grant_type: 'authorization_code',
      code: params.get('code'),
      redirect_uri: callback,
    });
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body, signal: AbortSignal.timeout(10000),
    });
    if (!tokenResponse.ok) throw Object.assign(new Error('Discord authorization failed.'), { status: 401 });
    const token = await tokenResponse.json();
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + token.access_token },
      signal: AbortSignal.timeout(10000),
    });
    if (!userResponse.ok) throw Object.assign(new Error('Could not verify Discord identity.'), { status: 401 });
    const user = await userResponse.json();
    const guild = await options.client.guilds.fetch(options.guildId);
    try {
      await guild.members.fetch({ user: user.id, force: true });
    } catch (_) {
      throw Object.assign(new Error('You must be a member of the configured Discord server.'), { status: 403 });
    }
    const payload = Buffer.from(JSON.stringify({
      id: user.id, name: String(user.global_name || user.username).slice(0, 70),
      exp: Date.now() + 7 * 86400000,
    })).toString('base64url');
    const requestedRound = cookieMap(req).winterbot_return || '';
    const requestedView = cookieMap(req).winterbot_view || '';
    const returnParams = new URLSearchParams();
    if (/^[a-f0-9-]{36}$/.test(requestedRound)) returnParams.set('round',requestedRound);
    if (['new','organizer'].includes(requestedView)) returnParams.set('view',requestedView);
    const returnLocation = '/' + (returnParams.size ? '?' + returnParams.toString() : '');
    res.writeHead(302, {
      Location: returnLocation,
      'Set-Cookie': [
        headerCookie('winterbot_state', '', { secure, clear: true }),
        headerCookie('winterbot_return', '', { secure, clear: true }),
        headerCookie('winterbot_view', '', { secure, clear: true }),
        headerCookie('winterbot_session', payload + '.' + sign(payload, options.sessionSecret), { secure }),
      ],
      'Cache-Control': 'no-store',
    });
    res.end();
  }
  function logout(res) {
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': headerCookie('winterbot_session', '', { secure, clear: true }),
    });
    res.end();
  }
  return { identity, getSession, requireOrigin, login, callbackHandler, logout, demoPeople, base };
}

module.exports = { createAuth };
