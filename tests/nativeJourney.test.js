'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os'),fs=require('node:fs'),path=require('node:path');
const {MessageFlags,PermissionFlagsBits}=require('discord.js');
const {createNativeJourney}=require('../src/scheduling/nativeJourney');

const GUILD='818423564901416991',CHANNEL='1558470955930755162';
const OWNER='123456789012345678',MEMBER='234567890123456789',BOT='345678901234567890';
function fixture(t,{activityAvailability=null}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-native-journey-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let time=new Date('2026-10-12T10:00:00Z');
  const messages=[],permissions=[];
  const channel={id:CHANNEL,guildId:GUILD,isTextBased:()=>true,
    async send(content){
      const m={id:String(800000000000000000n+BigInt(messages.length+1)),
        content,updates:[],
        async edit(payload){m.updates.push(payload);m.content=payload;return m;}};
      messages.push(m);return m;
    },
    messages:{async fetch(mid){return messages.find(m=>m.id===mid)||null;}},
  };
  const client={user:{id:BOT},
    channels:{async fetch(cid){assert.equal(cid,CHANNEL);return channel;}},
    // These APIs must NEVER be called by the isolated planning journey.
    guilds:{async fetch(){throw Error('No production Discord server fetches allowed');}},
    events:{async create(){throw Error('Real events must never be created');}},
  };
  const journey=createNativeJourney({client,guildId:GUILD,channelId:CHANNEL,
    dataFile:path.join(dir,'journey.json'),now:()=>new Date(time),
    activityAvailability});
  const interaction=(action='',sid='',{type='button',uid=OWNER,manager=true,
    values=[],fields={},extra='',guildId=GUILD,channelId=CHANNEL}={})=>{
    const calls={reply:null,update:null,modal:null,followUp:null};
    const discord={
      guildId,channelId,user:{id:uid,username:'Tester',bot:false},
      guild:{ownerId:OWNER},member:{id:uid,displayName:'Test member'},
      memberPermissions:{has:permission=>manager&&permission===PermissionFlagsBits.ManageGuild},
      customId:'wbflow:'+action+(sid?':'+sid:'')+(extra?':'+extra:''),
      values,
      isChatInputCommand:()=>false,
      isModalSubmit:()=>type==='modal',
      isFromMessage:()=>true,
      fields:{getTextInputValue:k=>fields[k]||''},
      async reply(content){calls.reply=content;},
      async update(content){calls.update=content;},
      async showModal(modal){calls.modal=modal;},
      async followUp(content){calls.followUp=content;},
    };
    return {discord,calls};
  };
  const act=async(action,sid,opts={})=>{
    const x=interaction(action,sid,opts);
    await journey.handle(x.discord);
    return x.calls;
  };
  const create=async({title='Community Game Night',first='2026-10-19',days='7',
    hours='12:00-24:00',duration='120'}={})=>{
    const x=await act('new','',{type:'modal',fields:{title,first,days,hours,duration}});
    assert.ok(x.reply?.embeds,'New organizer round should reply with a dashboard');
    return Object.values(journey.store.read().journeys)[0];
  };
  const state=(sid)=>journey.read(sid);
  return {journey,act,create,state,messages,permissions,
    setTime:v=>{time=new Date(v);},interaction,OWNER,MEMBER};
}
const title=ui=>ui?.embeds?.[0]?.data?.title||ui?.embeds?.[0]?.toJSON?.().title;
const description=ui=>ui?.embeds?.[0]?.data?.description||ui?.embeds?.[0]?.toJSON?.().description;

test('organizer setup recovers the existing core round rules with advanced hidden',async t=>{
  const f=fixture(t);
  const home=await f.journey.start({
    guildId:GUILD,channelId:CHANNEL,guild:{ownerId:OWNER},user:{id:OWNER,bot:false},
    memberPermissions:{has:()=>true},async reply(p){this.payload=p;},
  });
  const newCall=await f.act('new');
  assert.equal(newCall.modal?.data?.title,'New test planning round');
  assert.equal(newCall.modal.toJSON().components.length,5);
  const j=await f.create();
  const r=j.round;
  assert.equal(r.phase,'collecting');
  assert.equal(r.testMode,true);
  assert.equal(r.rosterMode,'open');
  assert.equal(r.minDurationMinutes,120);
  assert.equal(r.dayLimits[r.startDate].start,'12:00');
  assert.equal(r.dayLimits[r.startDate].end,'24:00');
  assert.equal(r.threshold,.9);
  assert.equal(j.options.minAttendance,5);
  assert.equal(f.messages.length,0,'No invitation was posted without explicit action');

  const advanced=await f.act('advanced',j.id);
  assert.equal(advanced.modal.toJSON().components.length,5);
  const updated=await f.act('advanced',j.id,{type:'modal',fields:{
    duration:'90-180',minPeople:'5',collection:'168',vote:'24',precision:'30',
  }});
  assert.match(description(updated.reply||updated.update),/90–180 min/);
  assert.equal(f.state(j.id).round.maxDurationMinutes,180);

  const firstInvite=await f.act('invite',j.id);
  assert.equal(f.messages.length,1);
  assert.match(title(f.messages[0].content),/\[TEST\]/);
  assert.match(description(firstInvite.update),/Posted in #winterbot-testing/);
  const duplicate=await f.act('invite',j.id);
  assert.match(duplicate.reply.content,/already published/);
  assert.equal(f.messages.length,1,'Invitations are idempotent');

  const blocked=await f.act('advanced',j.id,{uid:MEMBER,manager:false});
  assert.match(blocked.reply.content,/Only test moderators/);
  const outside=await f.act('sample',j.id,{guildId:'199916140183420928'});
  assert.match(outside.reply.content,/only work in #winterbot-testing/);
  assert.equal(f.state(j.id).round.participants.length,0);
});

test('real test-channel participants review before committing availability; optimized attendance uses real core',async t=>{
  const f=fixture(t),j=await f.create();
  const uid=MEMBER,dates=j.round.selectedDates;
  const join=await f.act('join',j.id,{uid,manager:false});
  assert.match(description(join.reply),/Draft only/);
  const premature=await f.act('review',j.id,{uid,manager:false});
  assert.match(premature.reply.content,/Answer every candidate date/);
  const use=async(date,status)=>{
    await f.act('date',j.id,{uid,manager:false,values:[date]});
    return f.act(status,j.id,{uid,manager:false});
  };
  for(const date of dates)await use(date,'dayall');
  assert.equal(f.state(j.id).round.participants.length,0,
    'Editing an unreviewed draft must not count toward attendance');
  const review=await f.act('review',j.id,{uid,manager:false});
  assert.match(title(review.update),/Review/);
  const submitted=await f.act('submit',j.id,{uid,manager:false});
  assert.match(title(submitted.update),/Availability submitted/);
  assert.equal(f.state(j.id).round.participants.length,1);
  assert.equal(Object.keys(f.state(j.id).round.availability[uid]).length,dates.length);
  await f.act('sample',j.id);
  assert.equal(f.state(j.id).round.participants.length,9);
  assert.equal(f.state(j.id).sampleIds.length,8);
  assert.ok(f.state(j.id).round.participants.some(p=>p.name.includes('[SAMPLE]')));
  const closed=await f.act('close',j.id);
  assert.match(title(closed.update),/Attendance results/);
  assert.equal(f.state(j.id).round.phase,'review');
  assert.ok(f.state(j.id).round.bestAttendance>=5);
  assert.ok(f.state(j.id).round.candidates.length>=2);
  const after=await f.act('dayall',j.id,{uid,manager:false});
  assert.match(after.reply.content,/Availability collection has ended/);
});

test('optional candidate vote honors pure optimizer and keeps unvoted winners and ties',async t=>{
  const f=fixture(t),j=await f.create();
  await f.act('sample',j.id);
  await f.act('close',j.id);
  const state=f.state(j.id);
  const selected=state.round.candidates.slice(0,3).map(c=>c.id);
  assert.ok(selected.length>=2,'Seeded attendance must produce multiple candidates');
  const sel=await f.act('choose',j.id,{values:selected});
  assert.match(title(sel.update),/Attendance results/);
  const open=await f.act('startvote',j.id);
  assert.match(description(open.update),/Voting in progress/);
  assert.equal(f.state(j.id).round.phase,'voting');
  assert.equal(f.messages.length,1,'A public ballot is posted only in the private test channel');
  assert.match(title(f.messages[0].content),/Vote/);
  const ballot=f.state(j.id).round.ballot;
  assert.equal(ballot.options.length,selected.length);
  // The user has to submit eligibility before they may vote.
  const noRoster=await f.act('votepanel',j.id,{uid:MEMBER,manager:false});
  assert.match(noRoster.reply.content,/Submit availability before voting/);
  // Simulate a seeded participant voting through the exact core voter path.
  await f.journey.store.transaction(data=>{
    const x=data.journeys[j.id];
    x.round.participants.push({id:MEMBER,name:'Real test participant'});
  });
  const voter=await f.act('votepanel',j.id,{uid:MEMBER,manager:false});
  assert.match(title(voter.reply),/My test vote/);
  const ids=ballot.options.slice(0,2).map(o=>o.id);
  const selectedVote=await f.act('voteselect',j.id,{uid:MEMBER,manager:false,values:ids});
  assert.match(title(selectedVote.update),/My test vote/);
  await f.act('savevote',j.id,{uid:MEMBER,manager:false});
  assert.deepEqual(f.state(j.id).round.ballot.votes[MEMBER],ids);
  await f.act('endvote',j.id);
  assert.equal(f.state(j.id).round.phase,'final');
  assert.ok(f.state(j.id).round.ballot.winnerIds.length>=1);
  assert.ok(f.state(j.id).round.ballot.loserIds.length>=1);
});

test('simulated event approval, check-in roles, channel options, overtime and archive',async t=>{
  const f=fixture(t),j=await f.create();
  await f.act('sample',j.id);
  await f.act('close',j.id);
  const option=f.state(j.id).round.candidates[0];
  await f.act('choose',j.id,{values:[option.id]});
  const approval=await f.act('approve',j.id);
  assert.match(title(approval.update),/Event, check-in/);
  assert.equal(f.messages.length,1,'Event invitation stays in the private test channel');
  let current=f.state(j.id).event;
  assert.equal(current.status,'planned');
  assert.equal(current.options.checkInMinutes,30);
  assert.equal(current.options.graceMinutes,5);
  assert.equal(current.options.lateCheckins,true);
  assert.equal(current.options.overtime,true);
  assert.deepEqual(current.checkedIn,{});
  const participant=f.act('checkin',j.id,{uid:MEMBER,manager:false});
  assert.match((await participant).reply.content,/Check-in is not open/);
  const opts=await f.act('eventopts',j.id);
  assert.match(title(opts.update),/Advanced event settings/);
  await f.act('optarchive',j.id);
  assert.equal(f.state(j.id).event.options.persistentChat,true);
  await f.act('optvoice',j.id);
  assert.equal(f.state(j.id).event.options.voice,false);
  await f.act('grace',j.id,{values:['2']});
  assert.equal(f.state(j.id).event.options.graceMinutes,2);
  await f.act('opencheck',j.id);
  assert.equal(f.state(j.id).event.status,'checkin-open');
  const entered=await f.act('checkin',j.id);
  assert.match(title(entered.reply),/Check-in recorded/);
  assert.equal(f.state(j.id).event.checkedIn[OWNER].managerTestOverride,true);
  const preview=await f.act('access',j.id,{uid:OWNER});
  assert.match(description(preview.reply),/UNLOCKED/);
  await f.act('start',j.id);
  await f.act('beginend',j.id);
  assert.equal(f.state(j.id).event.status,'grace');
  const late=await f.act('checkin',j.id,{uid:MEMBER,manager:false});
  assert.match(late.reply.content,/Check-in is not open/);
  await f.act('extend1',j.id);
  await f.act('cancelend',j.id);
  assert.equal(f.state(j.id).event.status,'running');
  await f.act('beginend',j.id);
  await f.act('endnow',j.id);
  await f.act('confirmend',j.id);
  assert.equal(f.state(j.id).event.status,'ended');
  const archive=await f.act('access',j.id,{uid:OWNER});
  assert.match(description(archive.reply),/moderator-only, read-only/);
  assert.equal(f.messages.length,1);
  assert.equal(f.permissions.length,0);
});

test('automated test clock closes vote and grace without real Discord side effects',async t=>{
  const f=fixture(t),j=await f.create();
  await f.act('sample',j.id);
  await f.act('close',j.id);
  const option=f.state(j.id).round.candidates[0];
  await f.act('choose',j.id,{values:[option.id]});
  await f.act('approve',j.id);
  await f.act('opencheck',j.id);
  await f.act('start',j.id);
  await f.act('beginend',j.id);
  const before=f.state(j.id).event.graceEndsAt;
  f.setTime(new Date(Date.parse(before)+1500).toISOString());
  await f.journey.tick();
  assert.equal(f.state(j.id).event.status,'ended');
  assert.ok(f.messages[0].updates.length>=1,'Public test event is updated after grace closes');
});


test('real participant can edit two windows through a Discord modal, with validation and required review',async t=>{
  const f=fixture(t),j=await f.create(),uid=MEMBER,date=j.round.startDate;
  await f.act('join',j.id,{uid,manager:false});
  const modal=await f.act('hours',j.id,{uid,manager:false});
  assert.equal(modal.modal.toJSON().components.length,5);
  const bad=await f.act('hours',j.id,{type:'modal',uid,manager:false,extra:date,fields:{
    start:'18:07',end:'22:00',moreStart:'',moreEnd:'',limit:'',
  }});
  assert.match(bad.reply.content,/15-minute increments/);
  assert.equal(f.state(j.id).drafts[uid]?.[date],undefined);
  const saved=await f.act('hours',j.id,{type:'modal',uid,manager:false,extra:date,fields:{
    start:'18:00',end:'20:00',moreStart:'21:00',moreEnd:'23:00',limit:'120',
  }});
  assert.match(title(saved.update||saved.reply),/My test availability/);
  assert.equal(f.state(j.id).drafts[uid][date].windows.length,2);
  assert.equal(f.state(j.id).drafts[uid][date].windows[0].maxMinutes,120);
  const dates=j.round.selectedDates;
  for(const next of dates.slice(1)){
    await f.act('date',j.id,{uid,manager:false,values:[next]});
    await f.act('off',j.id,{uid,manager:false});
  }
  await f.act('review',j.id,{uid,manager:false});
  await f.act('date',j.id,{uid,manager:false,values:[dates[1]]});
  await f.act('dayall',j.id,{uid,manager:false});
  const stale=await f.act('submit',j.id,{uid,manager:false});
  assert.match(stale.reply.content,/Review your latest changes/);
  assert.equal(f.state(j.id).round.participants.length,0);
  await f.act('review',j.id,{uid,manager:false});
  await f.act('submit',j.id,{uid,manager:false});
  assert.equal(f.state(j.id).round.participants.length,1);
  assert.equal(f.state(j.id).round.availability[uid][date].windows.length,2);
});

test('exact grouped start time is honored by an approved event and by voting',async t=>{
  const f=fixture(t),j=await f.create();
  await f.act('sample',j.id);
  await f.act('close',j.id);
  const candidate=f.state(j.id).round.candidates.find(c=>c.slots.length>1);
  assert.ok(candidate,'Representative attendance should produce start-time ranges');
  await f.act('choose',j.id,{values:[candidate.id]});
  const time=await f.act('times',j.id);
  assert.match(title(time.update),/Exact event times/);
  const last=candidate.slots.at(-1).startAt;
  const menu=await f.act('timeslot',j.id,{values:[last]});
  assert.match(description(menu.update),/Editing:/);
  await f.act('results',j.id);
  await f.act('approve',j.id);
  assert.equal(f.state(j.id).event.startAt,last,
    'Event must use the explicitly selected exact start, not the first in group');

  const g=fixture(t),k=await g.create();
  await g.act('sample',k.id);await g.act('close',k.id);
  const candidates=g.state(k.id).round.candidates.slice(0,2);
  await g.act('choose',k.id,{values:candidates.map(c=>c.id)});
  await g.act('times',k.id);
  for(const c of candidates){
    await g.act('timecandidate',k.id,{values:[c.id]});
    const selected=c.slots.at(-1).startAt;
    await g.act('timeslot',k.id,{values:[selected]});
  }
  await g.act('startvote',k.id);
  assert.deepEqual(g.state(k.id).round.ballot.options.map(o=>o.startAt),
    candidates.map(c=>c.slots.at(-1).startAt));
  await g.act('endvote',k.id);
  const surviving=g.state(k.id).round.candidates.filter(c=>
    g.state(k.id).round.ballot.winnerIds.includes(c.id));
  assert.ok(surviving.length>=1);
});

test('automatic check-in, no-overtime end, and 5-minute grace use the test clock',async t=>{
  const f=fixture(t),j=await f.create();
  await f.act('sample',j.id);await f.act('close',j.id);
  const candidate=f.state(j.id).round.candidates[0];
  await f.act('choose',j.id,{values:[candidate.id]});
  await f.act('approve',j.id);
  assert.equal(f.state(j.id).event.status,'planned');
  const e=f.state(j.id).event;
  f.setTime(new Date(Date.parse(e.checkinOpensAt)+500).toISOString());
  await f.journey.tick();
  assert.equal(f.state(j.id).event.status,'checkin-open',
    'Check-in must open 30 minutes before scheduled start by default');
  assert.ok(f.messages[0].updates.length>=1);
  await f.act('optovertime',j.id);
  assert.equal(f.state(j.id).event.options.overtime,false);
  await f.act('start',j.id);
  f.setTime(new Date(Date.parse(e.endAt)+500).toISOString());
  await f.journey.tick();
  assert.equal(f.state(j.id).event.status,'grace',
    'When overtime is disabled, the event automatically starts grace');
  f.setTime(new Date(Date.parse(f.state(j.id).event.graceEndsAt)+500).toISOString());
  await f.journey.tick();
  assert.equal(f.state(j.id).event.status,'ended');
  assert.equal(f.state(j.id).event.checkedIn[MEMBER],undefined);
});


test('reviewed Activity submission can be imported conservatively without treating tentative hours as confirmed',async t=>{
  const dates=Array.from({length:7},(_,i)=>Date.UTC(2026,9,19+i))
    .map(ms=>new Date(ms).toISOString().slice(0,10));
  const submitted=Object.fromEntries(dates.map((d,i)=>[d,
    i===1?{status:'unavailable',windows:[]}:
    {status:'available',windows:[
      {start:i===0?'18:05':'18:00',end:i===0?'21:55':'23:00',
        kind:'confirmed',maxMinutes:i===0?95:null},
      ...(i===0?[{start:'21:55',end:'23:00',kind:'tentative',maxMinutes:null}]:[]),
    ]}]));
  let snapshot={round:{dates},member:{submitted:structuredClone(submitted),
    submittedAt:'2026-10-12T09:00:00.000Z'}};
  const f=fixture(t,{activityAvailability:async()=>structuredClone(snapshot)});
  const j=await f.create();
  const invite=await f.act('invite',j.id);
  assert.ok(f.messages[0].content.components[0].components
    .some(c=>c.data.label.includes('Import reviewed Activity week')));
  const preview=await f.act('import',j.id,{uid:MEMBER,manager:false});
  assert.match(title(preview.reply),/Review Activity import/);
  assert.match(description(preview.reply),/Tentative windows are/);
  assert.match(description(preview.reply),/18:15–21:45/);
  assert.equal(f.state(j.id).round.participants.length,0,
    'Preview cannot count unconfirmed imported data');
  const converted=f.state(j.id).importPreview[MEMBER];
  assert.equal(converted.rounded,1);
  assert.equal(converted.excludedTentative,1);
  assert.equal(converted.hours[0].windows[0].maxMinutes,90);
  assert.equal(converted.hours[0].windows.length,1);

  snapshot.member.submitted[dates[0]].windows[0].end='21:45';
  const stale=await f.act('importconfirm',j.id,{uid:MEMBER,manager:false});
  assert.match(stale.reply.content,/changed/);
  assert.equal(f.state(j.id).round.participants.length,0);
  // Re-review the fresh version, then explicitly import.
  await f.act('import',j.id,{uid:MEMBER,manager:false});
  const success=await f.act('importconfirm',j.id,{uid:MEMBER,manager:false});
  assert.match(title(success.update),/Activity week imported/);
  assert.equal(f.state(j.id).round.participants.length,1);
  assert.equal(f.state(j.id).round.availability[MEMBER][dates[0]].windows[0].start,'18:15');
  assert.equal(f.state(j.id).round.availability[MEMBER][dates[0]].windows[0].end,'21:45');
  assert.equal(snapshot.member.submitted[dates[0]].windows.length,2,
    'The source Activity submission is never rewritten');
  assert.equal(f.state(j.id).imported[MEMBER].excludedTentative,1);
});

test('Activity import rejects unmatched dates and never guesses answers for missing days',async t=>{
  const f=fixture(t,{activityAvailability:async()=>({
    round:{dates:['2026-11-02']},
    member:{submitted:{'2026-11-02':{status:'available',windows:[
      {start:'19:00',end:'22:00',kind:'confirmed'}]}},
      submittedAt:'2026-10-12T09:00:00.000Z'},
  })});
  const j=await f.create();
  const failed=await f.act('import',j.id,{uid:MEMBER,manager:false});
  assert.match(failed.reply.content,/does not cover all candidate dates/);
  assert.equal(f.state(j.id).round.participants.length,0);
  assert.deepEqual(f.state(j.id).importPreview,{});
});
