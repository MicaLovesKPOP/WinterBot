'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DateTime } = require('luxon');
const { SchedulingStore } = require('./store');
const {
  invariant, createRound, enroll, setDays, listDays, closeCollection, startVote,
  castVote, closeVote, visibleCandidates, advance, stats,
} = require('./core');
const { createAuth } = require('./auth');
const { publishCandidate, postRoundPanel } = require('./publisher');

const PUBLIC = path.join(__dirname, 'public');

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readJson(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (type !== 'application/json') throw httpError(415, 'Expected application/json.');
  let received = 0;
  const chunks = [];
  for await (const chunk of req) {
    received += chunk.length;
    if (received > 65536) throw httpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_) {
    throw httpError(400, 'Invalid JSON body.');
  }
}
function getRound(state, id) {
  const round = state.rounds.find(r => r.id === id);
  if (!round) throw httpError(404, 'Scheduling round not found.');
  return round;
}
function publicRound(round, me) {
  const copy = structuredClone(round);
  copy.stats = stats(copy);
  copy.dates = listDays(copy);
  copy.candidates = visibleCandidates(copy);
  if (!me.admin) {
    copy.availability = { [me.id]: copy.availability[me.id] || {} };
    copy.candidates.forEach(c => { delete c.availableIds; });
    if (copy.ballot) {
      copy.ballot.votes = { [me.id]: copy.ballot.votes[me.id] || [] };
      if (copy.phase === 'voting') copy.ballot.options.forEach(o => { delete o.votes; });
    }
    copy.publications = copy.publications.filter(p => p.status === 'created')
      .map(p => ({ candidateId: p.candidateId, date: p.date, startAt: p.startAt, eventUrl: p.eventUrl, status: p.status }));
  }
  return copy;
}
async function initializeDemo(store, auth) {
  if (store.read().rounds.length) return;
  const zone = 'Europe/Amsterdam';
  const from = DateTime.now().setZone(zone).plus({ days: 6 }).startOf('day');
  const startDate = from.toISODate();
  const endDate = from.plus({ days: 2 }).toISODate();
  const participants = auth.demoPeople.filter(p => !p.admin).map(({ id, name }) => ({ id, name }));
  const r = createRound({
    title: 'WinterBot Game Night', startDate, endDate, timezone: zone,
    durationMinutes: 120, stepMinutes: 30, collectionHours: 72, voteHours: 24,
    location: 'WinterBot Discord voice chat', participants,
  });
  const days = listDays(r);
  const patterns = [
    [['18:00','23:00',120],['18:00','23:00',120],['17:00','22:00',null]],
    [['19:00','23:00',null],['18:00','23:00',null],['18:00','21:00',null]],
    [['18:00','22:00',null],['20:00','24:00',null],null],
    [['17:00','23:00',null],['18:00','23:00',null],['18:00','22:00',null]],
    [['18:00','21:00',null],['19:00','24:00',null],['17:00','21:00',null]],
    [['19:00','24:00',null],null,['18:00','23:00',null]],
    [['18:00','23:00',null],['18:00','22:00',null],['18:00','22:00',null]],
    [null,['19:00','24:00',null],['16:00','22:00',null]],
  ];
  participants.forEach((p, index) => {
    r.availability[p.id] = {};
    days.forEach((date, i) => {
      const pattern = patterns[index][i];
      r.availability[p.id][date] = pattern
        ? { status: 'available', windows: [{ start: pattern[0], end: pattern[1], maxMinutes: pattern[2] }] }
        : { status: 'unavailable', windows: [] };
    });
  });
  // One day remains unanswered for the first person, so the editor can demonstrate that state.
  delete r.availability.p1[days[2]];
  await store.transaction(state => { state.rounds.push(r); });
}

function createScheduler(options) {
  const demo = options.mode === 'demo';
  const host = options.host || '127.0.0.1';
  const port = Number(options.port || 8791);
  if (demo && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('Demo mode must bind only to localhost, never a public network interface.');
  }
  const config = { ...options, host, port };
  const auth = createAuth(config);
  const store = new SchedulingStore(options.dataFile ||
    path.join(process.cwd(), demo ? 'scheduling-demo.json' : 'scheduling.json'));
  store.initialize();
  let ticking = false;
  let timer = null;
  let httpServer = null;

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const due = store.read().rounds
        .filter(r => (r.phase === 'collecting' && Date.parse(r.collectionClosesAt) <= Date.now()) ||
          (r.phase === 'voting' && Date.parse(r.ballot.closesAt) <= Date.now()))
        .map(r => r.id);
      if (due.length) {
        const changed = [];
        await store.transaction(state => {
          for (const r of state.rounds) {
            if (due.includes(r.id) && advance(r)) changed.push(r.id);
          }
        });
        if (!demo) for (const id of changed) {
          if (!getRound(store.read(), id).announcementMessageId) continue;
          try { await postRoundPanel(store, id, { ...config, baseUrl: auth.base }); }
          catch (error) { console.error('Scheduling panel update failed:', error.message); }
        }
      }
    } finally {
      ticking = false;
    }
  }

  async function handler(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    const u = new URL(req.url || '/', auth.base);
    const pathname = u.pathname;
    try {
      if (req.method === 'GET' && pathname === '/health') {
        return send(res, 200, { ok: true, mode: options.mode, rounds: store.read().rounds.length });
      }
      if (req.method === 'GET' && pathname === '/login' && !demo) return auth.login(req, res);
      if (req.method === 'GET' && pathname === '/oauth/callback' && !demo) return await auth.callbackHandler(req, res, u);
      if (req.method === 'GET' && pathname === '/logout' && !demo) return auth.logout(res);
      if (req.method === 'GET' && ['/', '/index.html', '/app.js', '/styles.css'].includes(pathname)) {
        const file = pathname === '/' ? 'index.html' : pathname.slice(1);
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript';
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
        return fs.createReadStream(path.join(PUBLIC, file)).pipe(res);
      }
      if (!pathname.startsWith('/api/')) throw httpError(404, 'Not found.');
      const me = await auth.identity(req);
      if (!me) throw httpError(401, 'Please sign in with Discord.');
      if (req.method === 'GET' && pathname === '/api/me') {
        return send(res, 200, { ...me, demoPeople: demo ? auth.demoPeople : null });
      }
      if (req.method === 'GET' && pathname === '/api/rounds') {
        const rounds = store.read().rounds.map(r => ({
          id: r.id, title: r.title, phase: r.phase, startDate: r.startDate, endDate: r.endDate,
          collectionClosesAt: r.collectionClosesAt, participantCount: r.participants.length,
        }));
        return send(res, 200, { rounds });
      }
      const match = pathname.match(/^\/api\/rounds\/([a-f0-9-]+)(?:\/([a-z-]+))?$/);
      if (req.method === 'GET' && match && !match[2]) {
        return send(res, 200, { round: publicRound(getRound(store.read(), match[1]), me) });
      }
      if (req.method !== 'POST') throw httpError(404, 'Not found.');
      auth.requireOrigin(req);
      const body = await readJson(req);
      if (pathname === '/api/demo/reset') {
        if (!demo || !me.admin) throw httpError(403, 'Reset is only available to the local demo organizer.');
        await store.transaction(state => { state.rounds = []; });
        await initializeDemo(store, auth);
        return send(res, 200, { reset: true, rounds: store.read().rounds.length });
      }
      if (pathname === '/api/rounds') {
        if (!me.admin) throw httpError(403, 'Only an organizer can create rounds.');
        if (!demo && (body.participants || []).some(p => !/^\d{15,22}$/.test(String(p.id)))) {
          throw httpError(400, 'Fixed participants must have valid Discord user IDs.');
        }
        const round = createRound(body);
        await store.transaction(state => { state.rounds.push(round); });
        return send(res, 201, { round: publicRound(round, me) });
      }
      if (!match || !match[2]) throw httpError(404, 'Not found.');
      const id = match[1], action = match[2];
      if (action === 'availability') {
        await store.transaction(state => {
          const round = getRound(state, id);
          advance(round);
          if (round.rosterMode === 'open') enroll(round, me.id, me.name);
          else if (!round.participants.some(p => p.id === me.id)) throw httpError(403, 'You are not on the participant list.');
          setDays(round, me.id, body.days);
        });
      } else if (action === 'vote') {
        await store.transaction(state => { const r = getRound(state, id); advance(r); castVote(r, me.id, body.candidateIds); });
      } else if (action === 'close-collection') {
        if (!me.admin) throw httpError(403, 'Organizer permission required.');
        await store.transaction(state => { closeCollection(getRound(state, id), new Date(), true); });
      } else if (action === 'start-vote') {
        if (!me.admin) throw httpError(403, 'Organizer permission required.');
        await store.transaction(state => {
          const round = getRound(state, id);
          advance(round);
          invariant(round.publications.length === 0, 'Cannot start voting after publishing events.');
          startVote(round, body.selected);
        });
      } else if (action === 'close-vote') {
        if (!me.admin) throw httpError(403, 'Organizer permission required.');
        await store.transaction(state => { closeVote(getRound(state, id), new Date(), true); });
      } else if (action === 'publish') {
        if (!me.admin) throw httpError(403, 'Organizer permission required.');
        const publication = await publishCandidate(store, id, body.candidateId, body.startAt, {
          ...config, demo, confirmedRetry: body.confirmedRetry === true,
        });
        if (!demo && getRound(store.read(), id).announcementMessageId) {
          try { await postRoundPanel(store, id, { ...config, baseUrl: auth.base }); }
          catch (error) { console.error('Event announcement update failed:', error.message); }
        }
        return send(res, 200, { publication, round: publicRound(getRound(store.read(), id), me) });
      } else if (action === 'announce') {
        if (!me.admin) throw httpError(403, 'Organizer permission required.');
        if (demo) return send(res, 200, { demo: true, notice: 'Demo mode does not send messages to Discord.' });
        const result = await postRoundPanel(store, id, { ...config, baseUrl: auth.base });
        return send(res, 200, result);
      } else throw httpError(404, 'Not found.');
      if (!demo && ['close-collection','start-vote','close-vote'].includes(action) && getRound(store.read(), id).announcementMessageId) {
        try { await postRoundPanel(store, id, { ...config, baseUrl: auth.base }); }
        catch (error) { console.error('Round announcement update failed:', error.message); }
      }
      return send(res, 200, { round: publicRound(getRound(store.read(), id), me) });
    } catch (error) {
      const status = error.status || (error.message?.includes('not found') ? 404 : 400);
      if (status >= 500) console.error('WinterBot scheduling:', error);
      return send(res, status, { error: error.message || 'Request failed.' });
    }
  }

  async function start() {
    if (demo) await initializeDemo(store, auth);
    await tick();
    httpServer = http.createServer((req, res) => {
      handler(req, res).catch(error => {
        console.error('WinterBot scheduler unexpected failure:', error);
        if (!res.headersSent) send(res, 500, { error: 'Internal error.' });
        else res.destroy();
      });
    });
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, resolve);
    });
    timer = setInterval(() => tick().catch(error => console.error('Scheduler deadline check:', error)), 10000);
    timer.unref?.();
    return { url: 'http://' + host + ':' + port, store };
  }
  async function stop() {
    if (timer) clearInterval(timer);
    if (httpServer) await new Promise(resolve => httpServer.close(resolve));
    await store.queue;
  }
  return { start, stop, tick, store };
}

module.exports = { createScheduler };
