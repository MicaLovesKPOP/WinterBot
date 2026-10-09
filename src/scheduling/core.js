'use strict';

const crypto = require('node:crypto');
const { DateTime, IANAZone } = require('luxon');

const MAX_DAYS = 45;
const MAX_PARTICIPANTS = 250;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
function minuteOf(value, allowEndOfDay = false) {
  if (allowEndOfDay && value === '24:00') return 1440;
  invariant(typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value), 'Time must be HH:mm (24:00 only allowed as end time).');
  const [h, m] = value.split(':').map(Number);
  invariant(m % 15 === 0, 'Times must use 15-minute increments.');
  return h * 60 + m;
}
function timeOf(minutes) {
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}
function isoDate(value, zone) {
  const dt = DateTime.fromISO(value, { zone });
  invariant(dt.isValid && dt.toISODate() === value && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Invalid calendar date: ' + value);
  return dt;
}
function listDays(round) {
  const a = isoDate(round.startDate, round.timezone);
  const b = isoDate(round.endDate, round.timezone);
  const dates = [];
  for (let d = a; d.toMillis() <= b.toMillis(); d = d.plus({ days: 1 })) dates.push(d.toISODate());
  return dates;
}
function assertParticipant(round, userId) {
  invariant(round.participants.some(p => p.id === String(userId)), 'You are not in this scheduling round.');
}
function createRound(input, now = new Date()) {
  const timezone = String(input.timezone || 'Europe/Amsterdam');
  invariant(IANAZone.isValidZone(timezone), 'Invalid IANA time zone.');
  const start = isoDate(String(input.startDate || ''), timezone);
  const end = isoDate(String(input.endDate || ''), timezone);
  const days = Math.round(end.diff(start, 'days').days) + 1;
  invariant(days >= 1 && days <= MAX_DAYS, 'A scheduling round must cover 1–45 days.');
  const title = String(input.title || '').trim();
  invariant(title.length >= 3 && title.length <= 90, 'Title must be 3–90 characters.');
  const durationMinutes = Number(input.durationMinutes || 120);
  invariant(Number.isInteger(durationMinutes) && durationMinutes >= 15 && durationMinutes <= 720 && durationMinutes % 15 === 0, 'Event duration must be 15–720 minutes in 15-minute increments.');
  const stepMinutes = Number(input.stepMinutes || 30);
  invariant([15, 30, 60].includes(stepMinutes), 'Start-time precision must be 15, 30 or 60 minutes.');
  const collectionHours = Number(input.collectionHours || 72);
  const voteHours = Number(input.voteHours || 24);
  invariant(Number.isFinite(collectionHours) && collectionHours >= 0.01 && collectionHours <= 336, 'Collection duration must be within 0.01–336 hours.');
  invariant(Number.isFinite(voteHours) && voteHours >= 0.01 && voteHours <= 168, 'Voting duration must be within 0.01–168 hours.');
  const threshold = input.threshold == null ? 0.9 : Number(input.threshold);
  invariant(threshold >= 0 && threshold <= 1, 'Attendance threshold must be between 0 and 1.');
  const targetCount = input.targetCount == null ? 5 : Number(input.targetCount);
  invariant(Number.isInteger(targetCount) && targetCount >= 1 && targetCount <= 30, 'Shortlist target must be 1–30.');
  const participants = [];
  const seen = new Set();
  for (const p of input.participants || []) {
    const id = String(p.id || '').trim();
    invariant(id && id.length <= 32, 'Invalid participant ID.');
    if (seen.has(id)) continue;
    seen.add(id);
    participants.push({ id, name: String(p.name || id).slice(0, 70) });
  }
  invariant(participants.length <= MAX_PARTICIPANTS, 'Too many participants.');
  return {
    id: crypto.randomUUID(), title, timezone, startDate: start.toISODate(), endDate: end.toISODate(),
    durationMinutes, stepMinutes, collectionHours, voteHours, threshold, targetCount,
    location: String(input.location || 'Discord').trim().slice(0, 100),
    description: String(input.description || '').slice(0, 1000),
    rosterMode: participants.length ? 'fixed' : 'open', participants, availability: {}, phase: 'collecting',
    createdAt: new Date(now).toISOString(),
    collectionClosesAt: new Date(new Date(now).getTime() + collectionHours * 3600000).toISOString(),
    lockedAt: null, candidates: [], bestAttendance: 0,
    ballot: null, excludedCandidateIds: [], publications: [], announcementMessageId: null,
  };
}
function enroll(round, userId, displayName) {
  const id = String(userId);
  if (round.participants.some(p => p.id === id)) return;
  invariant(round.phase === 'collecting', 'Enrollment has closed.');
  invariant(round.rosterMode === 'open', 'This round has a fixed participant list.');
  invariant(round.participants.length < MAX_PARTICIPANTS, 'Participant limit reached.');
  round.participants.push({ id, name: String(displayName || id).slice(0, 70) });
}
function normalizeWindows(windows) {
  invariant(Array.isArray(windows) && windows.length >= 1 && windows.length <= 10, 'An available day needs 1–10 time windows.');
  const result = windows.map(w => {
    const from = minuteOf(String(w.start || ''));
    const to = minuteOf(String(w.end || ''), true);
    invariant(to > from, 'Each range must end after it starts, on the same day.');
    const cap = w.maxMinutes == null || w.maxMinutes === '' ? null : Number(w.maxMinutes);
    invariant(cap == null || (Number.isInteger(cap) && cap >= 15 && cap <= to - from && cap % 15 === 0), 'Maximum duration must fit its window in 15-minute increments.');
    return { start: timeOf(from), end: timeOf(to), maxMinutes: cap };
  }).sort((a, b) => minuteOf(a.start) - minuteOf(b.start));
  for (let i = 1; i < result.length; i++) invariant(
    minuteOf(result[i].start) >= minuteOf(result[i - 1].end, true), 'Availability ranges must not overlap.'
  );
  return result;
}
function setDay(round, userId, date, input, now = new Date()) {
  invariant(round.phase === 'collecting' && new Date(now).getTime() < Date.parse(round.collectionClosesAt), 'Availability is locked.');
  assertParticipant(round, userId);
  invariant(listDays(round).includes(date), 'Date is outside the scheduling period.');
  const status = input.status;
  invariant(['available', 'unavailable', 'unanswered'].includes(status), 'Invalid availability status.');
  if (!round.availability[userId]) round.availability[userId] = {};
  if (status === 'unanswered') delete round.availability[userId][date];
  else round.availability[userId][date] = {
    status, windows: status === 'available' ? normalizeWindows(input.windows) : [],
  };
  return round.availability[userId][date] || { status: 'unanswered', windows: [] };
}
function setDays(round, userId, inputs, now = new Date()) {
  invariant(Array.isArray(inputs) && inputs.length <= MAX_DAYS, 'Invalid days payload.');
  const next = structuredClone(round);
  for (const entry of inputs) setDay(next, userId, entry.date, entry, now);
  round.availability = next.availability;
}
function localTime(date, minute, zone) {
  const dt = DateTime.fromISO(date + 'T' + timeOf(minute), { zone, setZone: true });
  if (!dt.isValid || dt.toISODate() !== date || dt.toFormat('HH:mm') !== timeOf(minute)) return null;
  if (typeof dt.getPossibleOffsets === 'function' && dt.getPossibleOffsets().length > 1) return null;
  return dt;
}
function candidateSlots(round, now = new Date()) {
  const result = [];
  const duration = round.durationMinutes;
  for (const date of listDays(round)) {
    for (let m = 0; m + duration <= 1440; m += round.stepMinutes) {
      const start = localTime(date, m, round.timezone);
      if (!start || start.toMillis() <= new Date(now).getTime() + 60000) continue;
      const end = start.plus({ minutes: duration });
      const em = m + duration;
      const ed = em === 1440 ? isoDate(date, round.timezone).plus({ days: 1 }).toISODate() : date;
      const et = em === 1440 ? '00:00' : timeOf(em);
      // Avoid silently misrepresenting real elapsed time during DST gaps or folds.
      if (end.toISODate() !== ed || end.toFormat('HH:mm') !== et || end.offset !== start.offset) continue;
      const availableIds = round.participants.filter(p => {
        const entry = round.availability[p.id]?.[date];
        if (!entry || entry.status !== 'available') return false;
        return entry.windows.some(w => minuteOf(w.start) <= m &&
          minuteOf(w.end, true) >= m + duration &&
          (w.maxMinutes == null || w.maxMinutes >= duration));
      }).map(p => p.id);
      if (availableIds.length) result.push({
        date, startAt: start.toUTC().toISO(), endAt: end.toUTC().toISO(),
        time: timeOf(m), minute: m, availableIds, count: availableIds.length,
      });
    }
  }
  return result;
}
function calculateCandidates(round, now = new Date()) {
  const raw = candidateSlots(round, now);
  const groups = [];
  for (const slot of raw) {
    const prev = groups[groups.length - 1];
    if (prev && prev.date === slot.date && prev.availableIds.join(',') === slot.availableIds.join(',') &&
      slot.minute === prev.lastMinute + round.stepMinutes) {
      prev.slots.push({ startAt: slot.startAt, endAt: slot.endAt, time: slot.time });
      prev.lastMinute = slot.minute;
    } else groups.push({
      id: '', date: slot.date, availableIds: slot.availableIds, count: slot.count,
      lastMinute: slot.minute, slots: [{ startAt: slot.startAt, endAt: slot.endAt, time: slot.time }],
    });
  }
  for (const g of groups) {
    g.id = crypto.createHash('sha256').update(round.id + ':' + g.date + ':' + g.slots[0].startAt).digest('hex').slice(0, 16);
    delete g.lastMinute;
  }
  const best = Math.max(0, ...groups.map(g => g.count));
  const eligible = groups.filter(g => best > 0 && g.count / best >= round.threshold)
    .sort((a, b) => b.count - a.count || a.date.localeCompare(b.date) || a.slots[0].time.localeCompare(b.slots[0].time));
  const selected = [];
  for (const group of eligible) {
    if (group.count === best || selected.length < round.targetCount) selected.push(group);
    else break;
  }
  return { bestAttendance: best, candidates: selected };
}
function closeCollection(round, now = new Date(), force = false) {
  if (round.phase !== 'collecting' || (!force && Date.parse(round.collectionClosesAt) > new Date(now).getTime())) return false;
  const results = calculateCandidates(round, now);
  round.bestAttendance = results.bestAttendance;
  round.candidates = results.candidates;
  round.lockedAt = new Date(now).toISOString();
  round.phase = 'review';
  return true;
}
function visibleCandidates(round) {
  const hidden = new Set(round.excludedCandidateIds || []);
  return round.candidates.filter(c => !hidden.has(c.id));
}
function getSlot(round, candidateId, startAt) {
  const candidate = visibleCandidates(round).find(c => c.id === candidateId);
  invariant(candidate, 'Candidate is not available.');
  const slot = candidate.slots.find(s => s.startAt === startAt);
  invariant(slot, 'Choose one of the candidate start times.');
  if (round.phase === 'final' && round.ballot) {
    const voted = round.ballot.options.find(o => o.candidateId === candidateId);
    invariant(!voted || voted.startAt === startAt, 'A winning voted option must keep its exact start time.');
  }
  return { candidate, slot };
}
function startVote(round, selected, now = new Date()) {
  invariant(round.phase === 'review' && !round.ballot, 'Voting cannot start in this phase.');
  invariant(Array.isArray(selected) && selected.length >= 2 && selected.length <= 30, 'Select 2–30 options to vote on.');
  const ids = new Set();
  const options = selected.map(item => {
    const { candidate, slot } = getSlot(round, item.candidateId, item.startAt);
    invariant(!ids.has(candidate.id), 'Choose each candidate only once.');
    ids.add(candidate.id);
    return { id: candidate.id, candidateId: candidate.id, date: candidate.date,
      startAt: slot.startAt, endAt: slot.endAt, time: slot.time, votes: 0 };
  });
  round.ballot = {
    options, votes: {}, openedAt: new Date(now).toISOString(),
    closesAt: new Date(new Date(now).getTime() + round.voteHours * 3600000).toISOString(),
    closedAt: null, winnerIds: [], loserIds: [],
  };
  round.phase = 'voting';
  return round.ballot;
}
function castVote(round, userId, candidateIds, now = new Date()) {
  invariant(round.phase === 'voting' && new Date(now).getTime() < Date.parse(round.ballot.closesAt), 'Voting is closed.');
  assertParticipant(round, userId);
  invariant(Array.isArray(candidateIds), 'Votes must be an array.');
  const eligible = new Set(round.ballot.options.map(o => o.id));
  const selected = [...new Set(candidateIds.map(String))];
  invariant(selected.every(id => eligible.has(id)), 'Vote includes an unknown option.');
  round.ballot.votes[String(userId)] = selected;
}
function closeVote(round, now = new Date(), force = false) {
  if (round.phase !== 'voting' || (!force && Date.parse(round.ballot.closesAt) > new Date(now).getTime())) return false;
  const counts = Object.fromEntries(round.ballot.options.map(o => [o.id, 0]));
  for (const choices of Object.values(round.ballot.votes)) {
    for (const id of choices) if (Object.hasOwn(counts, id)) counts[id]++;
  }
  const best = Math.max(0, ...Object.values(counts));
  const winners = best === 0 ? Object.keys(counts) : Object.keys(counts).filter(id => counts[id] === best);
  const losers = best === 0 ? [] : Object.keys(counts).filter(id => counts[id] !== best);
  round.ballot.options.forEach(o => { o.votes = counts[o.id]; });
  round.ballot.winnerIds = winners;
  round.ballot.loserIds = losers;
  round.ballot.closedAt = new Date(now).toISOString();
  round.excludedCandidateIds = losers;
  round.phase = 'final';
  return true;
}
function advance(round, now = new Date()) {
  return closeCollection(round, now) || closeVote(round, now);
}
function stats(round) {
  const dates = listDays(round);
  const completed = round.participants.filter(p => dates.every(d => round.availability[p.id]?.[d])).length;
  const started = round.participants.filter(p => dates.some(d => round.availability[p.id]?.[d])).length;
  return { participantCount: round.participants.length, started, completed,
    candidateCount: visibleCandidates(round).length, bestAttendance: round.bestAttendance };
}
module.exports = {
  createRound, enroll, setDay, setDays, listDays, calculateCandidates, closeCollection,
  visibleCandidates, getSlot, startVote, castVote, closeVote, advance, stats,
  normalizeWindows, localTime, minuteOf, invariant,
};
