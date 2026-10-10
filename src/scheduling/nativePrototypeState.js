'use strict';

// Isolated TEST-ONLY state. The production planner is intentionally untouched.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DateTime } = require('luxon');

const GRACE_MINUTES = Object.freeze([0, 1, 2, 3, 5, 10, 15]);
const DEFAULT_GRACE_MINUTES = 5;
const DAY_KEYS = Object.freeze(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
const clone = value => structuredClone(value);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function minute(value, end = false) {
  if (end && value === '24:00') return 1440;
  assert(typeof value === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value), 'Choose a valid time.');
  const [h, m] = value.split(':').map(Number);
  assert(m % 5 === 0, 'Choose times in five-minute increments.');
  return h * 60 + m;
}
function normalizedDay(raw) {
  if (raw?.status === 'unavailable') return { status: 'unavailable', windows: [] };
  assert(raw?.status === 'available' && Array.isArray(raw.windows) &&
    raw.windows.length > 0 && raw.windows.length <= 10,
  'Add one to ten time windows or mark the day unavailable.');
  const windows = raw.windows.map(w => {
    const start = minute(w.start), end = minute(w.end, true);
    assert(start < end, 'The end must be later than the start.');
    const kind = w.kind || 'confirmed';
    assert(['confirmed', 'tentative'].includes(kind), 'Invalid availability type.');
    const maxMinutes = w.maxMinutes == null ? null : Number(w.maxMinutes);
    assert(maxMinutes === null || (Number.isInteger(maxMinutes) && maxMinutes >= 5 &&
      maxMinutes <= end - start && maxMinutes % 5 === 0), 'Maximum stay must fit within the time window.');
    return { start: w.start, end: w.end, kind, maxMinutes };
  }).sort((a, b) => minute(a.start) - minute(b.start));
  for (let i = 1; i < windows.length; i++) {
    assert(minute(windows[i].start) >= minute(windows[i - 1].end, true),
      'Confirmed and tentative windows cannot overlap.');
  }
  return { status: 'available', windows };
}
function addWindow(day, window, editIndex = -1) {
  const windows = day?.status === 'available' ? clone(day.windows) : [];
  if (editIndex >= 0) {
    assert(editIndex < windows.length, 'That window no longer exists.');
    windows.splice(editIndex, 1);
  }
  windows.push(window);
  return normalizedDay({status: 'available', windows});
}
function removeWindow(day, index) {
  assert(day?.status === 'available' && index >= 0 && index < day.windows.length, 'No matching window.');
  const windows = day.windows.filter((_, i) => i !== index);
  return windows.length ? normalizedDay({status:'available', windows}) : null;
}
function allDay(kind = 'confirmed') {
  return normalizedDay({status:'available', windows:[
    {start:'00:00', end:'24:00', kind, maxMinutes:null},
  ]});
}
function weekday(date) {
  return DAY_KEYS[DateTime.fromISO(date).weekday - 1];
}
function displayTime(value,format='24') {
  if (format!=='12') return value;
  if (value==='24:00') return '12:00 AM (end)';
  const h=Number(value.slice(0,2));
  return String(h%12 || 12)+value.slice(2)+(h<12?' AM':' PM');
}
function summary(day,format='24') {
  if (!day) return 'Not answered';
  if (day.status === 'unavailable') return 'Unavailable';
  return day.windows.map(w =>
    (w.kind === 'tentative' ? '?' : '') + displayTime(w.start,format)+'-'+displayTime(w.end,format)+
    (w.maxMinutes ? ' (max ' + w.maxMinutes + 'm)' : '')).join(', ');
}
function startOfDemoWeek(weeksAhead = 0, now = DateTime.now()) {
  assert(Number.isInteger(weeksAhead) && weeksAhead >= 0 && weeksAhead <= 8, 'Week offset must be 0-8.');
  const local = now.setZone('Europe/Amsterdam');
  return local.startOf('week').plus({weeks: weeksAhead + 1});
}
function makeRound(weeksAhead = 0, now = DateTime.now()) {
  const start = startOfDemoWeek(weeksAhead, now);
  return {id: crypto.randomBytes(6).toString('hex'), title:'[TEST] Game Night Availability',
    timezone:'Europe/Amsterdam', createdAt: new Date().toISOString(),
    dates: Array.from({length:7},(_,i)=>start.plus({days:i}).toISODate()), members:{}};
}
function memberOf(round, userId) {
  if (!round.members[userId]) round.members[userId] = {
    draft:{}, submitted:null, submittedAt:null, undo:null, selection:[], pending:null,
    reviewedSnapshot:null,
  };
  return round.members[userId];
}
function prepareChange(member) {
  member.undo = clone(member.draft);
  member.reviewedSnapshot = null;
}
function applyDays(member, round, dates, day) {
  assert(Array.isArray(dates) && dates.length > 0 && dates.length <= 25 &&
    dates.every(d => round.dates.includes(d)), 'Select valid dates.');
  const normalized = day === null ? null : normalizedDay(day);
  prepareChange(member);
  for (const date of dates) {
    if (normalized) member.draft[date] = clone(normalized);
    else delete member.draft[date];
  }
  member.pending = null;
  member.selection = [];
}
function applyTemplate(member, round, template) {
  assert(template && typeof template === 'object', 'No saved usual week is available.');
  const dates = round.dates.filter(d => template[weekday(d)]);
  assert(dates.length > 0, 'Your usual week does not cover any candidate dates.');
  prepareChange(member);
  for (const date of dates) member.draft[date] = normalizedDay(template[weekday(date)]);
  member.pending = null;
  member.selection = [];
  member.reviewedSnapshot = null;
  return dates;
}
function isComplete(round, member) {
  return round.dates.every(d => member.draft[d]);
}
function reviewSnapshot(round, member) {
  return JSON.stringify(round.dates.map(d=>member.draft[d]||null));
}
function confirmSubmission(member, round) {
  assert(isComplete(round, member), 'Answer every date before submitting.');
  assert(member.reviewedSnapshot === reviewSnapshot(round,member),
    'Your answers changed since review. Please review them again.');
  for (const d of round.dates) member.draft[d] = normalizedDay(member.draft[d]);
  member.submitted = clone(member.draft);
  member.submittedAt = new Date().toISOString();
  member.undo = null;
  member.reviewedSnapshot = null;
  return member.submitted;
}
function templateFromSubmission(round, member) {
  assert(member.submitted, 'Submit your week before saving it as a template.');
  const template = {};
  for (const date of round.dates) {
    if (member.submitted[date]) template[weekday(date)] = clone(member.submitted[date]);
  }
  return template;
}
function unsubmittedChanges(member) {
  return JSON.stringify(member.draft) !== JSON.stringify(member.submitted || {});
}

class PreviewStore {
  constructor(file) {
    this.file = path.resolve(file);
    this.queue = Promise.resolve();
    fs.mkdirSync(path.dirname(this.file), {recursive:true});
    let state = {version:1, rounds:{}, templates:{}, events:{}};
    if (fs.existsSync(this.file)) {
      try {
        state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch(error) {
        if (!fs.existsSync(this.file + '.bak')) throw error;
        state = JSON.parse(fs.readFileSync(this.file + '.bak', 'utf8'));
      }
    }
    assert(state.version === 1 && state.rounds && state.templates, 'Invalid preview state.');
    state.events ||= {};
    this.state = state;
  }
  read() { return clone(this.state); }
  async transaction(change) {
    const run = async () => {
      const next = clone(this.state);
      const value = await change(next);
      const tmp = this.file + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(next,null,2),'utf8');
      if (fs.existsSync(this.file)) await fs.promises.copyFile(this.file, this.file + '.bak');
      await fs.promises.rename(tmp, this.file);
      this.state = next;
      return value;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}
module.exports = {
  GRACE_MINUTES, DEFAULT_GRACE_MINUTES, DAY_KEYS,
  minute, normalizedDay, addWindow, removeWindow, allDay, weekday, summary, displayTime,
  makeRound, memberOf, applyDays, applyTemplate, isComplete, confirmSubmission,
  templateFromSubmission, unsubmittedChanges, reviewSnapshot, PreviewStore, assert,
};