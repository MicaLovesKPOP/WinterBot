'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DateTime } = require('luxon');
const {
  createRound, enroll, setDay, setDays, calculateCandidates, closeCollection,
  visibleCandidates, getSlot, startVote, castVote, closeVote, advance,
} = require('../src/scheduling/core');
const { SchedulingStore } = require('../src/scheduling/store');
const { publishCandidate } = require('../src/scheduling/publisher');
const { createScheduler } = require('../src/scheduling/server');

function futureDate(days = 9) {
  return DateTime.now().setZone('Europe/Amsterdam').plus({ days }).toISODate();
}
function roundWithPeople(count = 10, overrides = {}) {
  return createRound({
    title: 'Scheduling Test Round', timezone: 'Europe/Amsterdam',
    startDate: futureDate(), endDate: futureDate(10), durationMinutes: 120,
    stepMinutes: 30,
    participants: Array.from({ length: count }, (_, i) => ({ id: 'p' + i, name: 'Person ' + i })),
    ...overrides,
  });
}
function available(round, userId, day, windows) {
  setDay(round, userId, day, { status: 'available', windows });
}
function fullWindow(start, end, maxMinutes = null) {
  return { start, end, maxMinutes };
}

test('supports unavailable, unanswered, multiple ranges, caps and copy-like bulk edits', () => {
  const r = roundWithPeople(2);
  const d = futureDate();
  assert.equal(r.availability.p0, undefined);
  setDay(r, 'p0', d, { status: 'unavailable', windows: [] });
  assert.equal(r.availability.p0[d].status, 'unavailable');
  setDays(r, 'p0', [
    { date: d, status: 'available', windows: [fullWindow('09:00', '11:00'), fullWindow('18:00', '23:00', 120)] },
    { date: futureDate(10), status: 'unavailable' },
  ]);
  assert.equal(r.availability.p0[d].windows.length, 2);
  assert.equal(r.availability.p0[d].windows[1].maxMinutes, 120);
  assert.throws(() => available(r, 'p0', d, [fullWindow('09:00', '12:00'), fullWindow('11:00', '13:00')]), /overlap/);
  assert.throws(() => available(r, 'p0', d, [fullWindow('22:00', '02:00')]), /after it starts/);
  assert.throws(() => available(r, 'p0', d, [fullWindow('18:00', '21:00', 210)]), /Maximum duration/);
  assert.equal(r.availability.p0[d].windows.length, 2, 'invalid edit cannot overwrite saved answer');
  setDay(r, 'p0', d, { status: 'unanswered' });
  assert.equal(r.availability.p0[d], undefined);
});

test('an attendance cap limits duration, not the choice of start time', () => {
  const r = roundWithPeople(2, { endDate: futureDate() });
  const d = futureDate();
  available(r, 'p0', d, [fullWindow('18:00', '23:00', 120)]);
  available(r, 'p1', d, [fullWindow('18:00', '23:00', 60)]);
  const slots = calculateCandidates(r);
  assert.equal(slots.bestAttendance, 1);
  const choices = slots.candidates.flatMap(c => c.slots.map(s => s.time));
  for (const t of ['18:00','18:30','19:00','19:30','20:00','20:30','21:00']) {
    assert.ok(choices.includes(t), 'expected feasible start ' + t);
  }
  assert.ok(!choices.includes('21:30'), 'event cannot overrun its availability window');
});

test('90% of best is inclusive; lower-attendance candidates are excluded', () => {
  const r = roundWithPeople(10);
  for (let i = 0; i < 10; i++) available(r, 'p' + i, futureDate(), [fullWindow('10:00','12:00')]);
  for (let i = 0; i < 9; i++) available(r, 'p' + i, futureDate(10), [fullWindow('18:00','20:00')]);
  closeCollection(r, new Date(), true);
  assert.equal(r.bestAttendance, 10);
  assert.deepEqual([...new Set(r.candidates.map(c => c.count))], [10, 9]);
});

test('equivalent adjacent start times group into one candidate, but different attendees do not', () => {
  const r = roundWithPeople(3, { endDate: futureDate() });
  const d = futureDate();
  available(r,'p0',d,[fullWindow('18:00','23:00')]);
  available(r,'p1',d,[fullWindow('18:00','23:00')]);
  available(r,'p2',d,[fullWindow('20:00','23:00')]);
  const result = calculateCandidates(r);
  assert.ok(result.candidates.some(c => c.slots.length > 1));
  const bestGroup = result.candidates.find(c => c.count === 3);
  assert.ok(bestGroup.slots.every(s => s.time >= '20:00'));
});

test('vote removes losing voted options but never unvoted options', () => {
  const r = roundWithPeople(3);
  const d1 = futureDate(), d2 = futureDate(10);
  for (const p of r.participants) {
    available(r,p.id,d1,[fullWindow('10:00','13:00'),fullWindow('18:00','21:00')]);
    available(r,p.id,d2,[fullWindow('10:00','13:00'),fullWindow('18:00','21:00')]);
  }
  closeCollection(r, new Date(), true);
  assert.ok(r.candidates.length >= 3);
  const untouched = r.candidates[2];
  const options = r.candidates.slice(0,2).map(c => ({ candidateId:c.id, startAt:c.slots[0].startAt }));
  startVote(r,options);
  castVote(r,'p0',[options[0].candidateId]);
  castVote(r,'p1',[options[0].candidateId]);
  castVote(r,'p2',[options[1].candidateId]);
  closeVote(r,new Date(),true);
  const remain = visibleCandidates(r).map(c => c.id);
  assert.ok(remain.includes(options[0].candidateId));
  assert.ok(!remain.includes(options[1].candidateId));
  assert.ok(remain.includes(untouched.id));
  assert.equal(r.candidates.length >= 3, true, 'historical candidates remain stored');
});

test('no-vote outcome eliminates nothing; ties survive', () => {
  const make = () => {
    const r = roundWithPeople(2);
    for (const p of r.participants) {
      available(r,p.id,futureDate(),[fullWindow('10:00','12:00'),fullWindow('18:00','20:00')]);
    }
    closeCollection(r,new Date(),true);
    const sel = r.candidates.slice(0,2).map(c => ({candidateId:c.id,startAt:c.slots[0].startAt}));
    startVote(r,sel);
    return {r,sel};
  };
  const {r,sel} = make();
  closeVote(r,new Date(),true);
  assert.equal(r.excludedCandidateIds.length,0);
  const second = make();
  castVote(second.r,'p0',[second.sel[0].candidateId]);
  castVote(second.r,'p1',[second.sel[1].candidateId]);
  closeVote(second.r,new Date(),true);
  assert.equal(second.r.excludedCandidateIds.length,0);
});

test('deadline enforcement prevents edits and ballots after expiration', () => {
  const r = roundWithPeople(2, { collectionHours:0.01 });
  const d = futureDate();
  assert.throws(() => setDay(r,'p0',d,{status:'unavailable'},new Date(Date.parse(r.collectionClosesAt)+1)), /locked/);
  assert.equal(advance(r,new Date(Date.parse(r.collectionClosesAt)+1)),true);
  assert.equal(r.phase,'review');
});

test('DST transition avoids phantom or ambiguous local start times', () => {
  const r = createRound({
    title:'DST transition test', timezone:'Europe/Amsterdam',
    startDate:'2026-10-25',endDate:'2026-10-25',
    durationMinutes:120, stepMinutes:30,
    participants:[{id:'p0',name:'User'}],
  });
  // No automatic UTC offset assumptions; reject slots that would span a clock change.
  r.availability.p0 = {'2026-10-25':{status:'available',windows:[fullWindow('00:00','06:00')]}};
  const choices = calculateCandidates(r).candidates.flatMap(c => c.slots.map(s => s.time));
  assert.ok(choices.includes('03:00'));
  assert.ok(!choices.includes('01:30'));
  assert.ok(!choices.includes('02:00'));
});

test('file store writes atomically, recovers backup, and preserves last-known-good data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-schedule-test-'));
  try {
    const filename = path.join(dir,'test.json');
    const store = new SchedulingStore(filename);
    store.initialize();
    await store.transaction(state => state.rounds.push(roundWithPeople(2)));
    await store.transaction(state => state.rounds[0].title = 'New Name');
    assert.ok(fs.existsSync(filename + '.bak'));
    fs.writeFileSync(filename,'{corrupt');
    const recovered = new SchedulingStore(filename);
    recovered.initialize();
    assert.equal(recovered.read().rounds[0].title,'Scheduling Test Round');
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('publishing is idempotent and enforces one event per day even between rounds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-publish-test-'));
  try {
    const store = new SchedulingStore(path.join(dir,'state.json'));
    store.initialize();
    const r = roundWithPeople(2,{endDate:futureDate()});
    for (const p of r.participants) available(r,p.id,futureDate(),[fullWindow('18:00','23:00')]);
    closeCollection(r,new Date(),true);
    await store.transaction(s => {s.rounds.push(r);});
    const c = r.candidates[0], start = c.slots[0].startAt;
    const first = await publishCandidate(store,r.id,c.id,start,{demo:true});
    const again = await publishCandidate(store,r.id,c.id,start,{demo:true});
    assert.equal(again.eventId,first.eventId);
    assert.equal(store.read().rounds[0].publications.length,1);
    if (c.slots.length>1) await assert.rejects(
      publishCandidate(store,r.id,c.id,c.slots[1].startAt,{demo:true}), /one event per day/i
    );
  } finally {
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('HTTP demo requires organizer authority, saves availability and closes collection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-http-test-'));
  const port = 11987;
  const app = createScheduler({mode:'demo',host:'127.0.0.1',port,dataFile:path.join(dir,'demo.json')});
  await app.start();
  try {
    const request = async (method,url,persona,body) => {
      const res = await fetch('http://127.0.0.1:' + port + url, {
        method, headers:{'X-Demo-User':persona,...(body ? {'Content-Type':'application/json'} : {})},
        ...(body ? {body:JSON.stringify(body)} : {}),
      });
      return {status:res.status,data:await res.json()};
    };
    const rounds = await request('GET','/api/rounds','owner');
    const id = rounds.data.rounds[0].id;
    const read = await request('GET','/api/rounds/'+id,'p1');
    assert.equal(read.status,200);
    assert.ok(read.data.round.availability.p1);
    assert.ok(!read.data.round.availability.p2, 'members cannot see others responses');
    const denied = await request('POST','/api/rounds/'+id+'/close-collection','p1',{});
    assert.equal(denied.status,403);
    const day = read.data.round.dates[2];
    const update = await request('POST','/api/rounds/'+id+'/availability','p1',{
      days:[{date:day,status:'unavailable',windows:[]}],
    });
    assert.equal(update.status,200);
    assert.equal(update.data.round.availability.p1[day].status,'unavailable');
    const done = await request('POST','/api/rounds/'+id+'/close-collection','owner',{});
    assert.equal(done.status,200);
    assert.equal(done.data.round.phase,'review');
    assert.ok(done.data.round.candidates.length >= 1);
    const tooLate = await request('POST','/api/rounds/'+id+'/availability','p1',{
      days:[{date:day,status:'available',windows:[fullWindow('18:00','21:00')]}],
    });
    assert.notEqual(tooLate.status,200);
  } finally {
    await app.stop();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});


test('winning voted option cannot be moved to another time after voting', () => {
  const r = roundWithPeople(2, { endDate: futureDate() });
  const day = futureDate();
  for (const p of r.participants) available(r,p.id,day,[
    fullWindow('09:00','13:00'),fullWindow('18:00','23:00'),
  ]);
  closeCollection(r,new Date(),true);
  const c = r.candidates.find(x => x.slots.length > 1);
  const other = r.candidates.find(x => x.id !== c.id);
  assert.ok(c && other);
  const selected = [
    {candidateId:c.id,startAt:c.slots[0].startAt},
    {candidateId:other.id,startAt:other.slots[0].startAt},
  ];
  startVote(r,selected);
  castVote(r,'p0',[c.id]);
  closeVote(r,new Date(),true);
  assert.equal(getSlot(r,c.id,c.slots[0].startAt).slot.startAt,c.slots[0].startAt);
  assert.throws(() => getSlot(r,c.id,c.slots[1].startAt),/exact start time/);
});

test('a failed publication is recoverable without creating a second intent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-retry-test-'));
  try {
    const store = new SchedulingStore(path.join(dir,'state.json'));
    store.initialize();
    const r = roundWithPeople(2,{endDate:futureDate()});
    for (const p of r.participants) available(r,p.id,futureDate(),[fullWindow('18:00','23:00')]);
    closeCollection(r,new Date(),true);
    await store.transaction(s => {s.rounds.push(r);});
    const c = r.candidates[0], start = c.slots[0].startAt;
    await assert.rejects(
      publishCandidate(store,r.id,c.id,start,{
        demo:false,client:{guilds:{fetch:async()=>{throw new Error('connection failed');}}},guildId:'123',
      }),
      /connection failed/
    );
    assert.equal(store.read().rounds[0].publications[0].status,'needs_attention');
    const retry = await publishCandidate(store,r.id,c.id,start,{demo:true});
    assert.equal(retry.status,'created');
    assert.equal(store.read().rounds[0].publications.length,1);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});


test('Discord event description keeps durable duplicate-reconciliation marker even with long text', () => {
  const { eventDescription, publicationMarker } = require('../src/scheduling/publisher');
  const marker = publicationMarker('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  const description = eventDescription('x'.repeat(1000), marker);
  assert.equal(description.length, 1000);
  assert.ok(description.endsWith(marker));
});

test('two concurrent Discord publish requests produce one event and share their result', async () => {
  const { Collection } = require('discord.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winterbot-publish-flight-'));
  try {
    const store = new SchedulingStore(path.join(dir, 'state.json'));
    store.initialize();
    const r = roundWithPeople(2, { endDate: futureDate() });
    for (const p of r.participants) available(r, p.id, futureDate(), [fullWindow('18:00', '23:00')]);
    closeCollection(r, new Date(), true);
    await store.transaction(s => { s.rounds.push(r); });
    const events = new Collection();
    let created = 0;
    const guild = { scheduledEvents: {
      fetch: async () => events,
      create: async opts => {
        created += 1;
        await new Promise(resolve => setTimeout(resolve, 50));
        const result = { id: 'e' + created, description: opts.description, scheduledStartAt: new Date(opts.scheduledStartTime) };
        events.set(result.id, result);
        return result;
      },
    } };
    const ctx = { demo:false, client:{ guilds: {fetch:async () => guild} }, guildId:'123456789012345678' };
    const c = r.candidates[0], start = c.slots[0].startAt;
    const [one, two] = await Promise.all([
      publishCandidate(store, r.id, c.id, start, ctx),
      publishCandidate(store, r.id, c.id, start, ctx),
    ]);
    assert.equal(created, 1);
    assert.equal(one.eventId, two.eventId);
    assert.equal(store.read().rounds[0].publications.length, 1);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('ambiguous Discord failure reconciles an existing event without duplicating', async () => {
  const { Collection } = require('discord.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'winterbot-publish-reconcile-'));
  try {
    const store = new SchedulingStore(path.join(dir, 'state.json'));
    store.initialize();
    const r = roundWithPeople(2, {endDate:futureDate()});
    for (const p of r.participants) available(r, p.id, futureDate(), [fullWindow('18:00','23:00')]);
    closeCollection(r, new Date(), true);
    await store.transaction(s => {s.rounds.push(r);});
    const events = new Collection();
    let created = 0;
    const guild = { scheduledEvents: {
      fetch: async () => events,
      create: async opts => {
        created += 1;
        const event = { id:'known-' + created, description: opts.description, scheduledStartAt:new Date(opts.scheduledStartTime) };
        events.set(event.id, event);
        throw new Error('Network timeout after Discord accepted the event');
      },
    }};
    const ctx = {demo:false,client:{guilds:{fetch:async()=>guild}},guildId:'123456789012345678'};
    const c = r.candidates[0], start=c.slots[0].startAt;
    await assert.rejects(publishCandidate(store,r.id,c.id,start,ctx), /Network timeout/);
    assert.equal(store.read().rounds[0].publications[0].status,'needs_attention');
    const resolved = await publishCandidate(store,r.id,c.id,start,ctx);
    assert.equal(resolved.eventId,'known-1');
    assert.equal(resolved.status,'created');
    assert.equal(created,1);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('an uncertain failed publish requires explicit operator confirmation before recreation', async () => {
  const { Collection } = require('discord.js');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-retry-confirm-'));
  try {
    const store=new SchedulingStore(path.join(dir,'state.json'));store.initialize();
    const r=roundWithPeople(2,{endDate:futureDate()});
    for(const p of r.participants) available(r,p.id,futureDate(),[fullWindow('18:00','23:00')]);
    closeCollection(r,new Date(),true);
    await store.transaction(s=>{s.rounds.push(r);});
    let createCalls=0;
    const events=new Collection();
    const guild={scheduledEvents:{
      fetch:async()=>events,
      create:async opts=>{
        createCalls++;
        if(createCalls===1) throw new Error('Uncertain timeout');
        const e={id:'result',description:opts.description,scheduledStartAt:new Date(opts.scheduledStartTime)};
        events.set(e.id,e);return e;
      },
    }};
    const ctx={demo:false,client:{guilds:{fetch:async()=>guild}},guildId:'123456789012345678'};
    const c=r.candidates[0],start=c.slots[0].startAt;
    await assert.rejects(publishCandidate(store,r.id,c.id,start,ctx),/Uncertain timeout/);
    await assert.rejects(publishCandidate(store,r.id,c.id,start,ctx),/explicitly confirm/);
    assert.equal(createCalls,1,'an unconfirmed retry must never send a new create request');
    const result=await publishCandidate(store,r.id,c.id,start,{...ctx,confirmedRetry:true});
    assert.equal(createCalls,2);
    assert.equal(result.status,'created');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('Discord scheduled events can attach to a real voice channel instead of external location', async () => {
  const {Collection, ChannelType, GuildScheduledEventEntityType} = require('discord.js');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-voice-event-'));
  try {
    const store=new SchedulingStore(path.join(dir,'state.json'));store.initialize();
    const voiceChannelId='123456789012345678';
    const r=roundWithPeople(2,{endDate:futureDate(),voiceChannelId});
    for(const p of r.participants) available(r,p.id,futureDate(),[fullWindow('18:00','23:00')]);
    closeCollection(r,new Date(),true);
    await store.transaction(s=>{s.rounds.push(r);});
    let options;
    const guild={
      channels:{fetch:async id=>({id,type:ChannelType.GuildVoice})},
      scheduledEvents:{fetch:async()=>new Collection(),create:async opts=>{
        options=opts;return {id:'voice-event'};
      }},
    };
    const c=r.candidates[0];
    const result=await publishCandidate(store,r.id,c.id,c.slots[0].startAt,{
      demo:false,client:{guilds:{fetch:async()=>guild}},guildId:'987654321012345678',
    });
    assert.equal(result.status,'created');
    assert.equal(options.entityType,GuildScheduledEventEntityType.Voice);
    assert.equal(options.channel,voiceChannelId);
    assert.equal(options.entityMetadata,undefined);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});


test('live request authentication reuses a brief guild permission cache', async () => {
  const crypto = require('node:crypto');
  const { createAuth } = require('../src/scheduling/auth');
  const userId = '123456789012345678';
  const secret = 'this-is-a-test-session-secret-at-least-32-chars';
  const payload = Buffer.from(JSON.stringify({
    id: userId, name:'Test Member', exp: Date.now() + 60000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const req = { headers: { cookie: 'winterbot_session=' + payload + '.' + signature } };
  let memberFetches = 0;
  const guild = { ownerId:'999999999999999999', members: {
    fetch: async () => {
      memberFetches += 1;
      return { permissions: {has:()=>false} };
    },
  }};
  const auth = createAuth({
    mode:'live', client:{guilds:{fetch:async()=>guild}},
    guildId:'234567890123456789',clientId:'123',clientSecret:'secret',
    sessionSecret:secret,baseUrl:'https://example.org',
  });
  const first = await auth.identity(req);
  const second = await auth.identity(req);
  assert.equal(first.id, userId);
  assert.equal(second.id, userId);
  assert.equal(memberFetches,1,'avoid a new guild membership REST check for every autosave');
});


test('concurrent scheduling invitations do not create duplicate Discord messages', async () => {
  const { postRoundPanel } = require('../src/scheduling/publisher');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-announce-flight-'));
  try {
    const store = new SchedulingStore(path.join(dir,'state.json'));
    store.initialize();
    const round = roundWithPeople(2);
    await store.transaction(s=>{s.rounds.push(round);});
    let sends = 0;
    const channel = {
      isTextBased:()=>true,
      send:async()=>{sends++;await new Promise(resolve=>setTimeout(resolve,35));return {id:'announcement-message'};},
    };
    const guild={channels:{fetch:async()=>channel}};
    const ctx={
      client:{guilds:{fetch:async()=>guild}},guildId:'123456789012345678',
      channelId:'987654321098765432',baseUrl:'https://calendar.example.net',
      demo:false,
    };
    const [a,b]=await Promise.all([
      postRoundPanel(store,round.id,ctx),postRoundPanel(store,round.id,ctx),
    ]);
    assert.equal(sends,1);
    assert.equal(a.messageId,b.messageId);
    assert.equal(store.read().rounds[0].announcementMessageId,'announcement-message');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
