'use strict';

const state = {
  me: null, rounds: [], round: null, tab: 'availability',
  day: null, picked: new Set(), slots: {}, votePicked: null,
  persona: localStorage.getItem('winterbot-demo-persona') || 'owner',
};
const el = id => document.getElementById(id);
const escapeHtml = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
function shortDate(date) {
  return new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB',
    { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
}
function longDate(date) {
  return new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB',
    { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
}
function humanTime(iso, zone) {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit' });
}
function relative(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'Deadline reached';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return mins + ' min left';
  if (mins < 48 * 60) return Math.ceil(mins / 60) + ' hours left';
  return Math.ceil(mins / 1440) + ' days left';
}
function phaseText(phase) {
  return { collecting: 'Collecting availability', review: 'Reviewing suggestions',
    voting: 'Voting open', final: 'Ready to schedule' }[phase] || phase;
}
function phasePill(phase) {
  return '<span class="pill ' + (phase === 'collecting' ? 'ok' : phase === 'voting' ? 'accent' : 'warn') + '">' +
    escapeHtml(phaseText(phase)) + '</span>';
}
function btn(text, action, klass = '', attrs = '') {
  return '<button type="button" class="btn ' + klass + '" data-action="' + action + '" ' + attrs + '>' + text + '</button>';
}
function announce(text, bad = false) {
  el('flash').innerHTML = '<div class="toast ' + (bad ? 'bad' : '') + '">' + escapeHtml(text) + '</div>';
  setTimeout(() => { if (el('flash')) el('flash').innerHTML = ''; }, 5000);
}
async function api(path, data) {
  const opts = { headers: { 'X-Demo-User': state.persona, 'X-WinterBot-Request': '1' }, credentials: 'same-origin' };
  if (data !== undefined) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(data);
  }
  const result = await fetch(path, opts);
  let json = {};
  try { json = await result.json(); } catch (_) {}
  if (!result.ok) throw new Error(json.error || 'Network request failed (' + result.status + ').');
  return json;
}
async function refresh() {
  const me = await api('/api/me');
  state.me = me;
  state.rounds = (await api('/api/rounds')).rounds;
  const wanted = new URLSearchParams(location.search).get('round');
  const desired = wanted || state.round?.id || state.rounds[0]?.id;
  if (!state.rounds.some(r => r.id === desired)) {
    state.round = null;
  } else {
    state.round = (await api('/api/rounds/' + encodeURIComponent(desired))).round;
    if (!state.day || !state.round.dates.includes(state.day)) state.day = state.round.dates[0];
  }
  if (!state.me.admin && state.tab !== 'availability') state.tab = 'availability';
  render();
}
async function post(action, body = {}) {
  if (!state.round) return;
  const response = await api('/api/rounds/' + state.round.id + '/' + action, body);
  if (response.round) state.round = response.round;
  state.votePicked = null;
  render();
  return response;
}
function pickRound(id) {
  state.round = null;
  state.day = null;
  state.picked.clear();
  state.slots = {};
  const u = new URL(location.href);
  u.searchParams.set('round', id);
  history.replaceState(null, '', u);
  refresh().catch(error => announce(error.message, true));
}
function nav(tab) {
  state.tab = tab;
  render();
}
function badgeRow() {
  const r = state.round;
  if (!r) return '';
  return '<div class="row"><span class="pill">' + escapeHtml(r.timezone) + '</span>' +
    '<span class="pill">' + escapeHtml(r.durationMinutes) + '-minute event</span>' +
    '<span class="pill">Max 1 event per day</span></div>';
}
function pageHeader(title, description, right = '') {
  return '<div class="topline"><div class="headline"><p class="eyebrow">WINTERBOT / ' +
    escapeHtml(state.tab.toUpperCase()) + '</p><h1>' + escapeHtml(title) +
    '</h1><p class="subhead">' + escapeHtml(description || '') + '</p></div>' + right + '</div>';
}
function roundPicker() {
  if (!state.rounds.length) return '';
  return '<div class="field round-switch"><label for="round-picker">Planning round</label><select id="round-picker" class="select">' +
    state.rounds.map(r => '<option value="' + escapeHtml(r.id) + '"' +
      (state.round?.id === r.id ? ' selected' : '') + '>' + escapeHtml(r.title) + ' · ' +
      escapeHtml(phaseText(r.phase)) + '</option>').join('') + '</select></div>';
}
function demoPersonSelect(id) {
  return '<div class="field"><label for="' + id + '">Demo identity</label><select id="' + id +
    '" class="select">' + state.me.demoPeople.map(p => '<option value="' + escapeHtml(p.id) + '"' +
      (state.persona === p.id ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('') +
    '</select></div>';
}
function renderChrome() {
  const me = state.me;
  const organizerNav = el('nav-organizer'), newNav = el('nav-new');
  organizerNav.style.display = me.admin ? '' : 'none';
  newNav.style.display = me.admin ? '' : 'none';
  el('nav-availability').classList.toggle('active', state.tab === 'availability');
  organizerNav.classList.toggle('active', state.tab === 'organizer');
  newNav.classList.toggle('active', state.tab === 'new');
  el('mobile-nav').innerHTML = '<option value="availability">My availability</option>' +
    (me.admin ? '<option value="organizer">Organizer board</option><option value="new">New planning round</option>' : '');
  el('mobile-nav').value = state.tab;
  el('profile').innerHTML = '<div class="profile"><div class="avatar">' +
    escapeHtml(me.name.slice(0, 1).toUpperCase()) + '</div><div><strong>' + escapeHtml(me.name) +
    '</strong><small>' + (me.admin ? 'Organizer' : 'Participant') + '</small></div></div>' +
    (me.demo ? '' : '<a class="tiny muted" href="/logout">Sign out</a>');
  el('demo-switch').innerHTML = me.demo ? (demoPersonSelect('persona') +
    (me.admin ? '<div style="margin-top:9px">' + btn('↻ Restart demo', 'reset-demo', 'small full') + '</div>' : '')) : '';
  el('mode-footer').textContent = me.demo ? 'Safe local demo mode' : 'Discord-authenticated';
}
function statusOf(date) {
  return state.round.availability[state.me.id]?.[date]?.status || 'unanswered';
}
function entryOf(date) {
  return state.round.availability[state.me.id]?.[date] || { status: 'unanswered', windows: [] };
}
function dayStrip() {
  return '<div class="day-strip" aria-label="Dates in the scheduling round">' +
    state.round.dates.map(d => {
      const s = statusOf(d);
      return '<button type="button" class="day ' + s + (state.day === d ? ' active' : '') +
        '" data-action="choose-day" data-date="' + d + '"><span>' + escapeHtml(shortDate(d)) +
        '</span><strong>' + escapeHtml(d.slice(5)) +
        '</strong><span class="row"><span class="indicator">' +
        (s === 'available' ? '✓' : s === 'unavailable' ? '×' : '?') +
        '</span>' + escapeHtml(s === 'unanswered' ? 'Not answered' : s) + '</span></button>';
    }).join('') + '</div>';
}
function timeOptions(selected, isEnd) {
  let result = '';
  const from = isEnd ? 1 : 0, through = isEnd ? 96 : 95;
  for (let i = from; i <= through; i++) {
    const hour = String(Math.floor(i / 4)).padStart(2, '0');
    const min = String((i % 4) * 15).padStart(2, '0');
    const time = hour + ':' + min;
    result += '<option value="' + time + '"' + (selected === time ? ' selected' : '') + '>' +
      (time === '24:00' ? '24:00 (midnight)' : time) + '</option>';
  }
  return result;
}
function capOptions(window) {
  const a = window.start.split(':').map(Number);
  const b = window.end.split(':').map(Number);
  const length = (b[0] * 60 + b[1]) - (a[0] * 60 + a[1]);
  let result = '<option value=""' + (window.maxMinutes == null ? ' selected' : '') + '>No limit</option>';
  for (let m = 15; m <= length; m += 15) {
    const label = m % 60 === 0 ? (m / 60) + ' hour' + (m === 60 ? '' : 's') : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    result += '<option value="' + m + '"' + (m === window.maxMinutes ? ' selected' : '') + '>' + label + '</option>';
  }
  return result;
}
function renderAvailabilityEditor() {
  const r = state.round;
  const day = state.day;
  const entry = entryOf(day);
  const answered = r.dates.filter(d => statusOf(d) !== 'unanswered').length;
  const pct = Math.round(answered / r.dates.length * 100);
  const allowed = r.participants.some(p => p.id === state.me.id) || r.rosterMode === 'open';
  let html = pageHeader('Your availability', r.title + ' · ' + shortDate(r.startDate) + ' – ' + shortDate(r.endDate), roundPicker());
  html += '<div class="flow">' + badgeRow();
  html += '<div class="card"><div class="panel-title"><div><strong>' + answered + ' of ' + r.dates.length +
    ' days answered</strong><div class="muted small">Edit freely until the collection deadline</div></div>' +
    '<span class="pill ok">' + escapeHtml(relative(r.collectionClosesAt)) + '</span></div>' +
    '<div class="track"><div style="width:' + pct + '%"></div></div></div>';
  if (!allowed) {
    return html + '<div class="note">This round has a fixed participant list. You are not on it.</div></div>';
  }
  html += dayStrip();
  html += '<div class="card flow"><div class="panel-title"><h2>' + escapeHtml(longDate(day)) +
    '</h2><span class="pill">' + escapeHtml(r.timezone) + '</span></div>' +
    '<div class="segmented" role="group" aria-label="Availability for selected day">' +
    [['available','Available'],['unavailable','Unavailable'],['unanswered','Not decided']].map(s =>
      '<button type="button" class="option ' + (entry.status === s[0] ? 'active' : '') +
      '" data-action="day-status" data-status="' + s[0] + '">' + s[1] + '</button>').join('') + '</div>';
  if (entry.status === 'available') {
    html += '<p class="muted small">Choose when you could attend. Optional limits mean you can attend only part of that window.</p>' +
      '<div class="row">' + btn('All day · 00–24', 'all-day', 'small') +
      btn('Evening · 18–23', 'evening', 'small') + '</div>';
    entry.windows.forEach((w, i) => {
      html += '<div class="window"><div class="window-head"><strong>Availability window ' + (i + 1) +
        '</strong>' + btn('Remove', 'remove-window', 'ghost small', 'data-index="' + i + '"') + '</div>' +
        '<div class="window-controls"><div class="field"><label for="start-' + i + '">From</label>' +
        '<select class="select" id="start-' + i + '" data-window="' + i + '" data-field="start">' +
        timeOptions(w.start, false) + '</select></div>' +
        '<div class="field"><label for="end-' + i + '">Until</label>' +
        '<select class="select" id="end-' + i + '" data-window="' + i + '" data-field="end">' +
        timeOptions(w.end, true) + '</select></div>' +
        '<div class="field"><label for="cap-' + i + '">Maximum stay</label><select class="select" id="cap-' + i +
        '" data-window="' + i + '" data-field="maxMinutes">' + capOptions(w) + '</select></div></div></div>';
    });
    html += btn('＋ Add another window', 'add-window') +
      '<div class="info-line">Example: available 18:00–23:00 with a 2-hour maximum means any suitable 2-hour event in that window works.</div>';
  } else {
    html += '<div class="note">' + (entry.status === 'unavailable'
      ? 'You have marked this entire day unavailable. No event time on this day will count you as available.'
      : 'This date has no answer yet. It will remain unanswered until you choose a status.') + '</div>';
  }
  html += '<div class="divider"></div><div class="action-bar"><div class="row">' +
    btn('Copy this day to unanswered', 'copy-day', 'small') +
    btn('Mark other unanswered days unavailable', 'mark-rest', 'small') +
    '</div>' + btn(answered === r.dates.length ? '✓ All days saved' : 'Finish / check answers',
      'finish', 'primary') + '</div></div></div>';
  return html;
}
function fitsMyAvailability(option) {
  const entry = entryOf(option.date);
  if (entry.status !== 'available') return false;
  const minute = time => Number(time.split(':')[0]) * 60 + Number(time.split(':')[1]);
  const start = minute(option.time), end = start + state.round.durationMinutes;
  return entry.windows.some(w => minute(w.start) <= start && minute(w.end) >= end &&
    (w.maxMinutes == null || w.maxMinutes >= state.round.durationMinutes));
}
function renderVoting() {
  const r = state.round, b = r.ballot;
  if (!r.participants.some(p => p.id === state.me.id)) {
    return pageHeader('Voting is open', r.title) + '<div class="note">Voting is available to participants in this round.</div>';
  }
  const saved = b.votes[state.me.id] || [];
  if (!state.votePicked) state.votePicked = new Set(saved);
  let html = pageHeader('Vote on the best times', r.title + ' · Select every option you would prefer.');
  html += '<div class="flow">' + badgeRow() + '<div class="card flow"><div class="panel-title"><h2>Your preferences</h2>' +
    '<span class="pill ok">' + escapeHtml(relative(b.closesAt)) + '</span></div>' +
    '<p class="muted small">Choose any number of options, including none. You can change your vote until voting closes.</p>';
  b.options.forEach(o => {
    html += '<label class="vote-option"><input type="checkbox" class="check" data-vote="' + escapeHtml(o.id) + '"' +
      (state.votePicked.has(o.id) ? ' checked' : '') + '><span><strong>' + escapeHtml(longDate(o.date)) +
      '</strong><small>' + escapeHtml(humanTime(o.startAt, r.timezone)) + '–' +
      escapeHtml(humanTime(o.endAt, r.timezone)) + ' · ' + escapeHtml(r.timezone) + '</small>' +
      (fitsMyAvailability(o) ? '<small class="green">Fits your availability</small>' :
        '<small style="color:var(--amber)">Outside your submitted availability</small>') +
      '</span></label>';
  });
  html += '<div class="row between"><span class="muted small">' +
    (Object.hasOwn(b.votes, state.me.id) ? 'Your previous vote is saved.' : 'No vote submitted yet.') +
    '</span>' + btn('Save my vote', 'save-vote', 'primary') + '</div></div></div>';
  return html;
}
function renderParticipant() {
  const r = state.round;
  if (r.phase === 'collecting') return renderAvailabilityEditor();
  if (r.phase === 'voting') return renderVoting();
  let html = pageHeader(r.phase === 'review' ? 'Suggestions are being reviewed' : 'Scheduling results',
    r.title + ' · ' + shortDate(r.startDate) + ' – ' + shortDate(r.endDate), roundPicker());
  html += '<div class="flow">' + badgeRow() + '<div class="card flow">' +
    '<div class="panel-title"><h2>' + (r.phase === 'review' ? 'Your availability is locked' : 'Voting has finished') +
    '</h2>' + phasePill(r.phase) + '</div>';
  html += '<p class="muted">Your availability is preserved. The organizer is choosing when to hold the event.</p>';
  if (r.phase === 'final' && r.ballot) {
    html += '<div class="note">' + r.ballot.winnerIds.length + ' voted options survived; options that were never voted on remain available to the organizer.</div>';
  }
  if (r.publications.length) {
    html += '<h3>Scheduled events</h3>' + r.publications.map(p => '<div class="timeline-row"><strong>' +
      escapeHtml(longDate(p.date)) + ' at ' + escapeHtml(humanTime(p.startAt, r.timezone)) +
      '</strong>' + (p.eventUrl ? '<a href="' + escapeHtml(p.eventUrl) +
      '" target="_blank" rel="noopener">View Discord event ↗</a>' : '<span class="pill ok">Demo event created</span>') +
      '</div>').join('');
  }
  html += '</div></div>';
  return html;
}
function overviewStats() {
  const r = state.round;
  const deadline = r.phase === 'collecting' ? r.collectionClosesAt : r.phase === 'voting' ? r.ballot.closesAt : null;
  return '<div class="grid-3"><div class="stat"><div class="stat-value">' + r.stats.completed +
    '<span class="soft">/' + r.stats.participantCount + '</span></div><div class="stat-label">Fully responded</div></div>' +
    '<div class="stat"><div class="stat-value">' + r.stats.candidateCount + '</div><div class="stat-label">Eligible candidate groups</div></div>' +
    '<div class="stat"><div class="stat-value">' + (deadline ? escapeHtml(relative(deadline)) : escapeHtml(String(r.stats.bestAttendance))) +
    '</div><div class="stat-label">' + (deadline ? 'Until phase closes' : 'Highest attendance') + '</div></div></div>';
}
function ballotSummary() {
  const r = state.round, b = r.ballot;
  if (!b) return '';
  const count = Object.keys(b.votes).length;
  let html = '<div class="card"><div class="panel-title"><h2>Community voting</h2>' +
    (r.phase === 'voting' ? '<span class="pill accent">Open · ' + escapeHtml(relative(b.closesAt)) +
      '</span>' : '<span class="pill ok">Completed</span>') + '</div>';
  html += '<p class="muted small">' + count + ' of ' + r.participants.length +
    ' participants voted. Ties are preserved. Unvoted candidates are never removed.</p>';
  html += '<div class="timeline">';
  b.options.forEach(o => {
    const voted = r.phase === 'voting' ? (Object.values(b.votes).filter(ids => ids.includes(o.id)).length) : o.votes;
    html += '<div class="timeline-row"><div><strong>' + escapeHtml(shortDate(o.date)) +
      ' · ' + escapeHtml(humanTime(o.startAt, r.timezone)) + '</strong> ' +
      (b.closedAt ? (b.loserIds.includes(o.id) ? '<span class="pill red">Lost</span>' :
        '<span class="pill ok">Survived</span>') : '') +
      '</div><strong>' + voted + ' votes</strong></div>';
  });
  html += '</div>';
  if (r.phase === 'voting') html += '<div class="divider"></div>' +
    btn('Close voting now', 'close-vote', 'danger small');
  return html + '</div>';
}
function candidateBoard() {
  const r = state.round;
  if (!r.candidates.length) return '<div class="empty"><h2>No feasible slots found</h2>' +
    '<p>No full-length event fits the declared availability. Consider a shorter event or another scheduling round.</p></div>';
  let html = '<div class="row between"><div><h2 style="margin:0">Best suggested times</h2>' +
    '<p class="muted small">Ranked by full-event attendance · at least ' +
    Math.round(r.threshold * 100) + '% of the best attendance · grouped by equivalent start times</p></div>' +
    '<span class="pill">' + r.candidates.length + ' groups</span></div>';
  const grouped = {};
  r.candidates.forEach(c => { (grouped[c.date] ||= []).push(c); });
  const publicationByDate = new Map(r.publications.map(p => [p.date, p]));
  Object.keys(grouped).sort().forEach(date => {
    html += '<div class="day-group"><div class="day-group-title"><h3>' + escapeHtml(longDate(date)) +
      '</h3><span class="pill">1 event max</span></div><div class="candidates">';
    grouped[date].forEach(c => {
      const publishedHere = publicationByDate.get(c.date);
      const retry = publishedHere && publishedHere.candidateId === c.id && publishedHere.status !== 'created';
      const scheduled = Boolean(publishedHere && !retry);
      const attendees = r.participants.filter(p => c.availableIds.includes(p.id)).map(p => escapeHtml(p.name));
      const share = r.participants.length ? Math.round(c.count / r.participants.length * 100) : 0;
      const ballotOption = r.ballot?.options.find(o => o.candidateId === c.id);
      const resultLabel = r.ballot && r.phase === 'final'
        ? (ballotOption ? '<span class="pill ok">Vote winner</span>' : '<span class="pill">Not voted on</span>') : '';
      const chosenSlot = retry ? publishedHere.startAt : (ballotOption && r.phase === 'final' ? ballotOption.startAt : (state.slots[c.id] || ballotOption?.startAt || c.slots[0].startAt));
      html += '<div class="candidate' + (scheduled ? ' scheduled' : '') + '">' +
        '<div class="candidate-main"><div class="row">' +
        (['review','final'].includes(r.phase) && !scheduled
          ? '<label class="choice"><input type="checkbox" class="check" data-candidate="' + escapeHtml(c.id) +
            '"' + (state.picked.has(c.id) ? ' checked' : '') + '><strong>Select</strong></label>' : '') +
        '<div><h3>' + escapeHtml(c.slots[0].time) +
        (c.slots.length > 1 ? '–' + escapeHtml(c.slots[c.slots.length - 1].time) : '') +
        '</h3><span class="small muted">Possible start times · ' + r.durationMinutes + '-min event</span></div></div>' +
        '<div class="score ' + (c.count === r.bestAttendance ? 'green' : '') + '">' +
        c.count + '/' + r.participants.length +
        '<div class="tiny muted">' + share + '% of participants</div></div></div>';
      html += '<div class="track"><div style="width:' + share + '%"></div></div>';
      html += '<div class="row between">' +
        '<div class="field"><label for="slot-' + c.id + '">Exact start</label><select class="select" id="slot-' +
        c.id + '" data-slot="' + c.id + '"' + (r.phase === 'voting' || scheduled || retry || (r.phase === 'final' && ballotOption) ? ' disabled' : '') + '>' +
        c.slots.map(s => '<option value="' + escapeHtml(s.startAt) + '"' +
          (s.startAt === chosenSlot ? ' selected' : '') + '>' + escapeHtml(s.time) + '</option>').join('') +
        '</select></div><div class="row">' + resultLabel +
        (c.count === r.bestAttendance ? '<span class="pill ok">Best attendance</span>' :
          '<span class="pill accent">Near best</span>') +
        (scheduled ? '<span class="pill">Day already scheduled</span>' : '') +
        (retry ? '<span class="pill warn">Retry publication</span>' : '') + '</div></div>';
      html += '<details><summary>Who can attend (' + c.count + ')</summary><p>' +
        attendees.join(', ') + '</p></details></div>';
    });
    html += '</div></div>';
  });
  if (['review','final'].includes(r.phase)) {
    html += '<div class="sticky-actions"><span class="strong">' + state.picked.size +
      ' selected</span><div class="row">' +
      (r.phase === 'review' && !r.publications.length ? btn('Put to vote', 'start-vote') : '') +
      btn('Schedule selected', 'publish', 'primary') + '</div></div>';
  }
  return html;
}
function renderOrganizer() {
  const r = state.round;
  let html = pageHeader('Organizer board', r.title + ' · ' + shortDate(r.startDate) + ' – ' + shortDate(r.endDate), roundPicker());
  html += '<div class="flow">' + '<div class="row between">' + badgeRow() + phasePill(r.phase) + '</div>';
  html += overviewStats();
  if (r.phase === 'collecting') {
    html += '<div class="card flow"><div class="panel-title"><h2>Availability collection</h2>' +
      '<span class="pill ok">' + escapeHtml(relative(r.collectionClosesAt)) + '</span></div>' +
      '<p class="muted">Members may edit their availability until the deadline. Missing days remain unanswered.</p>' +
      '<div class="timeline">';
    r.participants.forEach(p => {
      const answered = r.dates.filter(d => r.availability[p.id]?.[d]).length;
      html += '<div class="timeline-row"><strong>' + escapeHtml(p.name) + '</strong>' +
        '<span class="pill ' + (answered === r.dates.length ? 'ok' : '') + '">' +
        answered + '/' + r.dates.length + ' dates</span></div>';
    });
    html += '</div><div class="row">' +
      btn('Copy invitation link', 'copy-link') +
      btn('Post / update Discord invitation', 'announce', '', state.me.demo ? 'disabled title="Live mode only"' : '') +
      btn('Close collection now', 'close-collection', 'danger') + '</div></div>';
  } else {
    if (r.ballot) html += ballotSummary();
    if (r.phase === 'voting') html += '<div class="note">The candidate list will remain intact until the vote ends. Losing voted options are then hidden; options not put to a vote remain available.</div>';
    if (r.phase === 'review' || r.phase === 'final') html += '<div class="info-line">Select one or more candidates to schedule, or put a subset to a vote. Only one actual event can be created per day.</div>';
    html += candidateBoard();
    if (r.publications.length) {
      html += '<div class="card"><h2>Published events</h2><div class="timeline">' +
        r.publications.map(p => '<div class="timeline-row"><div><strong>' + escapeHtml(shortDate(p.date)) +
          ' · ' + escapeHtml(humanTime(p.startAt, r.timezone)) + '</strong><div class="muted tiny">' +
          escapeHtml(p.status) + (p.error ? ' · ' + escapeHtml(p.error) : '') +
          '</div></div>' + (p.eventUrl ? '<a href="' + escapeHtml(p.eventUrl) +
          '" target="_blank" rel="noopener">Discord ↗</a>' :
          p.status === 'created' ? '<span class="pill ok">Demo event</span>' : '') + '</div>').join('') + '</div></div>';
    }
    if (r.phase === 'voting') html += '<div class="row">' + btn('Update Discord announcement', 'announce', '',
      state.me.demo ? 'disabled' : '') + '</div>';
  }
  return html + '</div>';
}
function newRoundForm() {
  const today = new Date();
  const dateFrom = new Date(today.getTime() + 6 * 86400000).toISOString().slice(0, 10);
  const dateTo = new Date(today.getTime() + 8 * 86400000).toISOString().slice(0, 10);
  let html = pageHeader('Start a planning round', 'Collect availability, discover the best times, then schedule or vote.', roundPicker());
  html += '<form id="create-round" class="card flow"><div class="panel-title"><h2>Event details</h2>' +
    '<span class="pill accent">72h collection · 24h voting</span></div>';
  html += '<div class="field"><label for="title">Event title</label><input id="title" name="title" required minlength="3" maxlength="90" value="Game Night"></div>';
  html += '<div class="grid-2"><div class="field"><label for="startDate">First possible date</label><input type="date" id="startDate" name="startDate" value="' +
    dateFrom + '" required></div><div class="field"><label for="endDate">Last possible date</label><input type="date" id="endDate" name="endDate" value="' +
    dateTo + '" required></div></div>';
  html += '<div class="grid-2"><div class="field"><label for="timezone">Planning time zone</label><input id="timezone" name="timezone" value="Europe/Amsterdam" required></div>' +
    '<div class="field"><label for="durationMinutes">Event duration (minutes)</label><input id="durationMinutes" name="durationMinutes" type="number" min="15" max="720" step="15" value="120" required></div></div>';
  html += '<div class="grid-2"><div class="field"><label for="collectionHours">Availability window (hours)</label><input id="collectionHours" name="collectionHours" type="number" min=".5" max="336" step=".5" value="72"></div>' +
    '<div class="field"><label for="voteHours">Optional vote window (hours)</label><input id="voteHours" name="voteHours" type="number" min=".5" max="168" step=".5" value="24"></div></div>';
  html += '<div class="grid-2"><div class="field"><label for="stepMinutes">Start-time precision</label><select id="stepMinutes" name="stepMinutes"><option value="15">15 minutes</option>' +
    '<option value="30" selected>30 minutes</option><option value="60">60 minutes</option></select></div>' +
    '<div class="field"><label for="threshold">Near-best threshold (%)</label><input type="number" id="threshold" name="threshold" min="0" max="100" value="90"></div></div>';
  html += '<div class="field"><label for="participants">Optional fixed participants</label><textarea id="participants" name="participants" placeholder="Discord user ID,display name (one per line)"></textarea>' +
    '<span class="help">Leave empty for open enrollment. With a fixed list, only those users can submit availability and vote. IDs in live mode must be Discord user IDs.</span></div>';
  html += '<div class="field"><label for="voiceChannelId">Discord voice channel ID (optional)</label>' +
    '<input id="voiceChannelId" name="voiceChannelId" inputmode="numeric" pattern="[0-9]{15,22}" placeholder="Paste the voice channel ID">' +
    '<span class="help">If supplied, create a joinable voice-channel event. Otherwise use the external event location below.</span></div>' +
    '<div class="field"><label for="location">External event location</label>' +
    '<input id="location" name="location" value="Discord" maxlength="100"></div>';
  html += '<div class="row between"><span class="muted small">The event will only be created when you explicitly approve it.</span>' +
    '<button class="btn primary" type="submit">Create planning round</button></div></form>';
  return html;
}
function render() {
  if (!state.me) return;
  renderChrome();
  if (state.tab === 'new' && state.me.admin) {
    el('app-content').innerHTML = newRoundForm();
  } else if (!state.round) {
    el('app-content').innerHTML = pageHeader('Welcome to WinterBot', 'Start by creating a planning round.') +
      '<div class="empty"><h2>No planning rounds yet</h2><p>Create your first round to begin collecting availability.</p>' +
      (state.me.admin ? btn('＋ Create a round', 'new', 'primary') : '') + '</div>';
  } else if (state.tab === 'organizer' && state.me.admin) {
    el('app-content').innerHTML = renderOrganizer();
  } else {
    el('app-content').innerHTML = renderParticipant();
  }
  if (state.me.demo && !el('persona-inline')) {
    // The inline selector is visible on mobile as well as desktop.
    el('app-content').insertAdjacentHTML('afterbegin',
      '<div class="row between" style="margin-bottom:16px"><div class="row"><span class="pill accent">Local demo · no Discord changes</span>' +
      (state.me.admin ? btn('↻ Restart demo', 'reset-demo', 'small') : '') + '</div>' +
      '<div style="width:210px">' + demoPersonSelect('persona-inline') + '</div></div>');
  }
}
function currentWindows() {
  return structuredClone(entryOf(state.day).windows);
}
async function saveDays(days, message = 'Availability saved') {
  await post('availability', { days });
  announce(message);
}
async function statusChange(status) {
  const previous = entryOf(state.day);
  const windows = status === 'available'
    ? (previous.windows.length ? previous.windows : [{ start: '18:00', end: '23:00', maxMinutes: null }]) : [];
  await saveDays([{ date: state.day, status, windows }]);
}
function freeWindow(windows) {
  const presets = [['09:00','12:00'],['13:00','16:00'],['18:00','21:00'],['21:00','23:00']];
  const min = s => Number(s.split(':')[0]) * 60 + Number(s.split(':')[1]);
  for (const p of presets) {
    if (windows.every(w => min(p[1]) <= min(w.start) || min(p[0]) >= min(w.end))) {
      return { start: p[0], end: p[1], maxMinutes: null };
    }
  }
  return null;
}
async function handleAction(node) {
  const action = node.dataset.action;
  const r = state.round;
  if (action === 'new') return nav('new');
  if (action === 'reset-demo') {
    if (!state.me.demo || !state.me.admin) return;
    if (!confirm('Restart the demo from its original sample data? This clears all demo planning rounds, votes and events.')) return;
    await api('/api/demo/reset', {});
    state.day = null;
    state.round = null;
    state.picked.clear();
    state.slots = {};
    state.votePicked = null;
    state.tab = 'organizer';
    const url = new URL(location.href); url.searchParams.delete('round'); history.replaceState(null, '', url);
    await refresh();
    return announce('Demo restarted. All sample participants and deadlines are fresh.');
  }
  if (action === 'choose-day') { state.day = node.dataset.date; return render(); }
  if (action === 'day-status') return statusChange(node.dataset.status);
  if (action === 'all-day' || action === 'evening') {
    const window = action === 'all-day'
      ? { start: '00:00', end: '24:00', maxMinutes: null }
      : { start: '18:00', end: '23:00', maxMinutes: null };
    return saveDays([{date: state.day, status: 'available', windows: [window]}], 'Availability preset saved');
  }
  if (action === 'add-window') {
    const windows = currentWindows();
    const w = freeWindow(windows);
    if (!w) return announce('No free preset window. Adjust an existing window first.', true);
    windows.push(w);
    return saveDays([{ date: state.day, status: 'available', windows }], 'Window added');
  }
  if (action === 'remove-window') {
    const windows = currentWindows();
    if (windows.length === 1) return announce('Keep at least one window, or mark the day unavailable.', true);
    windows.splice(Number(node.dataset.index), 1);
    return saveDays([{ date: state.day, status: 'available', windows }], 'Window removed');
  }
  if (action === 'copy-day') {
    const entry = entryOf(state.day);
    if (entry.status === 'unanswered') return announce('Choose your availability for this day first.', true);
    const dates = r.dates.filter(d => d !== state.day && statusOf(d) === 'unanswered');
    if (!dates.length) return announce('No unanswered dates remain.');
    return saveDays(dates.map(date => ({ date, status: entry.status, windows: entry.windows })),
      'Copied to ' + dates.length + ' unanswered day(s)');
  }
  if (action === 'mark-rest') {
    const dates = r.dates.filter(d => statusOf(d) === 'unanswered');
    if (!dates.length) return announce('All dates already answered.');
    if (!confirm('Mark ' + dates.length + ' unanswered day(s) unavailable?')) return;
    return saveDays(dates.map(date => ({ date, status: 'unavailable', windows: [] })), 'Remaining dates marked unavailable');
  }
  if (action === 'finish') {
    const unanswered = r.dates.filter(d => statusOf(d) === 'unanswered').length;
    return announce(unanswered ? unanswered + ' day(s) are still unanswered. Your other answers are saved.' :
      'All days answered and saved. You can edit them until collection closes.');
  }
  if (action === 'close-collection') {
    if (confirm('End availability collection now and lock all participants’ answers?')) {
      await post('close-collection'); state.picked.clear(); announce('Collection locked; suggestions calculated.');
    }
    return;
  }
  if (action === 'close-vote') {
    if (confirm('End voting now? Vote results will be final.')) {
      await post('close-vote'); state.picked.clear(); announce('Voting closed. Losing voted options removed.');
    }
    return;
  }
  if (action === 'save-vote') {
    await post('vote', { candidateIds: [...(state.votePicked || new Set())] });
    return announce('Your vote has been saved.');
  }
  if (action === 'copy-link') {
    const link = location.origin + '/?round=' + encodeURIComponent(r.id);
    await navigator.clipboard.writeText(link);
    return announce('Invitation link copied.');
  }
  if (action === 'announce') {
    const result = await api('/api/rounds/' + r.id + '/announce', {});
    return announce(result.notice || 'Discord invitation posted or updated.');
  }
  if (action === 'start-vote' || action === 'publish') {
    const selected = r.candidates.filter(c => state.picked.has(c.id)).map(c => {
      const pending = r.publications.find(p => p.candidateId === c.id && p.status !== 'created');
      const voted = r.phase === 'final' ? r.ballot?.options.find(o => o.candidateId === c.id) : null;
      return { candidateId: c.id,
        startAt: pending?.startAt || voted?.startAt || state.slots[c.id] || c.slots[0].startAt,
        date: c.date };
    });
    if (!selected.length) return announce('Select a candidate first.', true);
    if (action === 'start-vote') {
      if (selected.length < 2) return announce('Select at least two candidate options to hold a vote.', true);
      if (!confirm('Open voting for ' + selected.length + ' option(s) for ' + r.voteHours + ' hours?')) return;
      await post('start-vote', { selected });
      state.picked.clear();
      return announce('Voting is open. Members can now submit their preferences.');
    }
    const dates = selected.map(s => s.date);
    if (new Set(dates).size !== dates.length) return announce('Only one scheduled event per calendar day. Choose one option from each day.', true);
    if (!confirm('Create ' + selected.length + ' scheduled event(s)' +
      (state.me.demo ? ' in safe demo mode' : ' on Discord') + '?')) return;
    const retryIds = new Set(selected.filter(s => r.publications.some(p =>
      p.candidateId === s.candidateId && p.status !== 'created')).map(s => s.candidateId));
    if (!state.me.demo && retryIds.size > 0 &&
      !confirm('IMPORTANT: An earlier event-creation attempt may already have succeeded. Check the Discord Scheduled Events list BEFORE retrying. Have you verified that no duplicate event exists?')) return;
    for (const s of selected) {
      try {
        await post('publish', { candidateId: s.candidateId, startAt: s.startAt,
          confirmedRetry: retryIds.has(s.candidateId) && !state.me.demo });
      } catch (error) {
        await refresh().catch(() => {});
        throw error;
      }
    }
    state.picked.clear();
    return announce(selected.length + (state.me.demo ? ' simulated event(s) created.' : ' Discord event(s) created.'));
  }
}
document.addEventListener('click', event => {
  const node = event.target.closest('[data-action]');
  if (!node || node.disabled) return;
  node.disabled = true;
  Promise.resolve(handleAction(node)).catch(error => announce(error.message, true)).finally(() => {
    if (node.isConnected) node.disabled = false;
  });
});
document.addEventListener('change', event => {
  const node = event.target;
  if (node.id === 'persona' || node.id === 'persona-inline') {
    state.persona = node.value;
    localStorage.setItem('winterbot-demo-persona', state.persona);
    state.picked.clear();
    state.votePicked = null;
    return refresh().catch(error => announce(error.message, true));
  }
  if (node.id === 'round-picker') return pickRound(node.value);
  if (node.id === 'mobile-nav') return nav(node.value);
  if (node.hasAttribute('data-candidate')) {
    if (node.checked) state.picked.add(node.dataset.candidate);
    else state.picked.delete(node.dataset.candidate);
    return render();
  }
  if (node.hasAttribute('data-slot')) {
    state.slots[node.dataset.slot] = node.value;
    return;
  }
  if (node.hasAttribute('data-vote')) {
    if (!state.votePicked) state.votePicked = new Set();
    if (node.checked) state.votePicked.add(node.dataset.vote);
    else state.votePicked.delete(node.dataset.vote);
    return;
  }
  if (node.hasAttribute('data-window')) {
    const windows = currentWindows();
    const i = Number(node.dataset.window), field = node.dataset.field;
    windows[i][field] = field === 'maxMinutes' ? (node.value === '' ? null : Number(node.value)) : node.value;
    saveDays([{ date: state.day, status: 'available', windows }])
      .catch(error => { announce(error.message, true); render(); });
  }
});
document.addEventListener('submit', event => {
  if (event.target.id !== 'create-round') return;
  event.preventDefault();
  const form = event.target;
  const fd = new FormData(form);
  const pairs = String(fd.get('participants') || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const participants = pairs.map(s => {
    const parts = s.split(',');
    return { id: parts[0].trim(), name: (parts[1] || parts[0]).trim() };
  });
  const body = {
    title: fd.get('title'), startDate: fd.get('startDate'), endDate: fd.get('endDate'),
    timezone: fd.get('timezone'), durationMinutes: Number(fd.get('durationMinutes')),
    stepMinutes: Number(fd.get('stepMinutes')), collectionHours: Number(fd.get('collectionHours')),
    voteHours: Number(fd.get('voteHours')), threshold: Number(fd.get('threshold')) / 100,
    participants, location: fd.get('location'), voiceChannelId: fd.get('voiceChannelId'),
  };
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  api('/api/rounds', body).then(result => {
    state.round = result.round; state.rounds.push({
      id: result.round.id, title: result.round.title, phase: result.round.phase,
    });
    state.day = result.round.dates[0]; state.tab = 'organizer'; state.picked.clear();
    const url = new URL(location.href); url.searchParams.set('round', state.round.id);
    history.replaceState(null, '', url);
    render(); announce('Planning round created. You can now share the invitation.');
  }).catch(error => announce(error.message, true)).finally(() => {
    if (submit.isConnected) submit.disabled = false;
  });
});
el('nav-availability').addEventListener('click', () => nav('availability'));
el('nav-organizer').addEventListener('click', () => nav('organizer'));
el('nav-new').addEventListener('click', () => nav('new'));
refresh().catch(error => {
  if (error.message.includes('sign in') || error.message.includes('401')) {
    el('app-content').innerHTML = '<div class="card"><h1>Welcome to WinterBot</h1>' +
      '<p>Sign in with Discord to set your availability and take part in event planning.</p>' +
      '<p><a class="btn primary" href="/login?round=' + escapeHtml(new URLSearchParams(location.search).get('round') || '') + '">Sign in with Discord</a></p></div>';
    return;
  }
  el('app-content').innerHTML = '<div class="empty"><h2>Could not load planner</h2><p>' +
    escapeHtml(error.message) + '</p><button class="btn" onclick="location.reload()">Retry</button></div>';
});
setInterval(() => {
  if (!state.me || !state.round || document.activeElement?.matches('select,input,textarea')) return;
  if (['collecting','voting'].includes(state.round.phase)) {
    const deadline = state.round.phase === 'collecting' ? state.round.collectionClosesAt : state.round.ballot.closesAt;
    if (Date.parse(deadline) <= Date.now()) refresh().catch(() => {});
  }
}, 15000);
