'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DateTime } = require('luxon');
const { PermissionFlagsBits, Collection } = require('discord.js');
const { createRound, setDay, calculateCandidates, closeCollection } = require('../src/scheduling/core');
const {
  CHANNELS, DEFAULT_ROLES, configureChannelPolicy, destinationFor, mayUseSetupInteraction,
  isOrganizerMember, isVerifiedMember,
} = require('../src/scheduling/channelPolicy');
const { buildInvitation, buildEventAnnouncement } = require('../src/scheduling/memberAnnouncements');
const { createScheduler } = require('../src/scheduling/server');

const LOGS='332575578383187970';
const MANAGEMENT='123456789012345678';
const VERIFY1='234567890123456789';
const VERIFY2='345678901234567890';
const policy=configureChannelPolicy({
  guildId:CHANNELS.guildId,logChannelId:LOGS,demo:false,
},{
  SCHEDULING_MANAGEMENT_ROLE_ID:MANAGEMENT,
  SCHEDULING_VERIFIED_ROLE_IDS:VERIFY1+','+VERIFY2,
});

function date(offset) {
  return DateTime.now().setZone('Europe/Amsterdam').plus({days:offset}).toISODate();
}
function seedRound(overrides = {}) {
  return createRound({
    title:'Discord league match',timezone:'Europe/Amsterdam',
    startDate:date(9),endDate:date(11),durationMinutes:120,
    participants:[{id:'u1',name:'Alice'},{id:'u2',name:'Bob'}],
    ...overrides,
  });
}
test('fixed channel roles and two-role verification are required',()=>{
  assert.equal(CHANNELS.mod,'332572234885365766');
  assert.equal(CHANNELS.league,'387323214105411599');
  assert.equal(CHANNELS.public,'343084103228456970');
  assert.equal(destinationFor({destination:'league'},policy).channelId,CHANNELS.league);
  assert.equal(destinationFor({destination:'public'},policy).channelId,CHANNELS.public);
  assert.equal(destinationFor({destination:'public',testMode:true},policy).channelId,LOGS);
  const user=(id,roles)=>({id,user:{id},roles:{cache:{has:r=>roles.includes(r)}}});
  assert.ok(isOrganizerMember(user('admin',[MANAGEMENT]),policy));
  assert.equal(isOrganizerMember(user('u1',[VERIFY1,VERIFY2]),policy),false);
  assert.ok(isVerifiedMember(user('u1',[VERIFY1,VERIFY2]),policy));
  assert.equal(isVerifiedMember(user('u1',[VERIFY1]),policy),false);
  const management=user('admin',[MANAGEMENT]);
  const check=channelId=>({
    guildId:CHANNELS.guildId,channelId,member:management,
    guild:{ownerId:'unrelated'},
  });
  assert.doesNotThrow(()=>mayUseSetupInteraction(check(CHANNELS.mod),policy,false));
  assert.throws(()=>mayUseSetupInteraction(check(LOGS),policy,false),/#bot-logs|Management\/mod/);
  assert.doesNotThrow(()=>mayUseSetupInteraction(check(LOGS),policy,true));
  assert.throws(()=>mayUseSetupInteraction(check(CHANNELS.mod),policy,true),/#bot-logs/);
  assert.throws(()=>configureChannelPolicy({guildId:CHANNELS.guildId,logChannelId:LOGS,demo:false},{
    SCHEDULING_MANAGEMENT_ROLE_ID:MANAGEMENT,SCHEDULING_VERIFIED_ROLE_IDS:VERIFY1,
  }),/BOTH/);
});

test('organizer selects dates, per-date hour restrictions and event duration range',()=>{
  const r=seedRound({
    selectedDates:[date(9),date(11)],
    dayLimits:{[date(9)]:{start:'18:00',end:'22:00'}},
    minDurationMinutes:60,maxDurationMinutes:180,durationStepMinutes:30,
  });
  assert.deepEqual(r.selectedDates,[date(9),date(11)]);
  assert.equal(r.dayLimits[date(9)].start,'18:00');
  assert.equal(r.maxDurationMinutes,180);
  for(const p of r.participants) {
    setDay(r,p.id,date(9),{status:'available',windows:[{start:'00:00',end:'24:00'}]});
    setDay(r,p.id,date(11),{status:'available',windows:[{start:'18:00',end:'23:00'}]});
  }
  const groups=calculateCandidates(r).candidates;
  assert.ok(groups.length > 0);
  assert.ok(groups.some(g=>g.durationMinutes===180),'return longer event times with full attendance');
  assert.ok(groups.every(g=>r.selectedDates.includes(g.date)));
  assert.ok(groups.filter(g=>g.date===date(9)).every(g=>g.slots.every(s=>s.time>='18:00')));
  assert.ok(!groups.some(g=>g.date===date(10)));
  assert.throws(()=>seedRound({dayLimits:{[date(9)]:{start:'22:00',end:'18:00'}}}),/positive length/);
});

test('invitation and TEST simulated event are professionally structured Discord embeds',()=>{
  const r=seedRound({testMode:true,destination:'public'});
  const invite=buildInvitation(r,'https://calendar.example.org');
  assert.equal(invite.embeds.length,1);
  const embed=invite.embeds[0].toJSON();
  assert.match(embed.title,/\[TEST\]/);
  assert.match(embed.description,/#bot-logs/);
  assert.equal(invite.allowedMentions.parse.length,0);
  assert.equal(invite.components.length,1);
  const candidate={id:'candidate1',count:2};
  r.candidates=[candidate];
  const p={
    id:'intent1',candidateId:'candidate1',status:'simulated',
    startAt:DateTime.now().plus({days:9}).toISO(),
    endAt:DateTime.now().plus({days:9,hours:2}).toISO(),eventUrl:null,
  };
  const announcement=buildEventAnnouncement(r,p);
  assert.equal(announcement.components.length,0);
  assert.match(announcement.embeds[0].toJSON().title,/\[TEST ONLY\]/);
  assert.match(announcement.embeds[0].toJSON().description,/No Discord Scheduled Event/);
});

function fixture(allowRealEvents=false) {
  const sent = {};
  let eventCreateCalls=0;
  let newMessage=0;
  const botUser={id:'987654321098765432'};
  const roleIds={owner:[MANAGEMENT,VERIFY1,VERIFY2],u1:[VERIFY1,VERIFY2],u2:[VERIFY1]};
  const members=new Map(Object.entries(roleIds).map(([id,roles])=>[id,{
    id,user:{id},displayName:id,roles:{cache:{has:r=>roles.includes(r)}},
    permissions:{has:()=>false},
  }]));
  const channels=new Map([CHANNELS.mod,CHANNELS.league,CHANNELS.public,LOGS].map(id=>{
    const cache=new Collection();
    const channel={
      id,guildId:CHANNELS.guildId,isTextBased:()=>true,
      client:{user:botUser},
      permissionsFor(member){
        return {has(flag){
          if(member?.id===botUser.id) return true;
          return flag===PermissionFlagsBits.ViewChannel;
        }};
      },
      messages:{fetch:async id=>{
        if(typeof id==='object')return cache;
        const msg=cache.get(id);
        if(!msg){const err=new Error('Unknown Message');err.code=10008;throw err;}
        return msg;
      }},
      async send(payload){
        const id='msg'+(++newMessage);
        const msg={id,author:botUser,embeds:payload.embeds?.map(e=>e.toJSON()) || [],
          async edit(change){
            Object.assign(this,{embeds:change.embeds?.map(e=>e.toJSON())||[]});
            return this;
          }};
        cache.set(id,msg);
        (sent[channel.id] ||= []).push(payload);
        return msg;
      },
    };
    return [id,channel];
  }));
  const guild={
    id:CHANNELS.guildId,ownerId:'another-user',
    roles:{fetch:async id=>({id,guild:{id:CHANNELS.guildId}})},
    members:{fetch:async({user})=>members.get(user)||Promise.reject(new Error('Not a member'))},
    channels:{fetch:async id=>channels.get(id)},
    commands:{create:async()=>({})},
    scheduledEvents:{fetch:async()=>new Collection(),create:async opts=>{
      eventCreateCalls++;
      if (!allowRealEvents) throw new Error('TEST MODE MUST NEVER CREATE A REAL EVENT');
      return {id:'100000000000000001',description:opts.description,scheduledStartAt:new Date(opts.scheduledStartTime)};
    }},
  };
  const client={user:botUser,guilds:{fetch:async()=>guild},on(){},off(){}};
  return {client,channels,sent,get eventCreateCalls(){return eventCreateCalls;}};
}
function headers(id,secret,host,post=false) {
  const payload=Buffer.from(JSON.stringify({id,name:id,exp:Date.now()+600000})).toString('base64url');
  const signature=crypto.createHmac('sha256',secret).update(payload).digest('base64url');
  return {cookie:'winterbot_session='+payload+'.'+signature,
    ...(post?{'Content-Type':'application/json','X-Winterbot-Request':'1',Origin:host}:{})};
}
async function appFixture(testMode,port,allowRealEvents=false) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-channels-'));
  const secret='a-long-test-only-session-secret-that-is-private';
  const host='https://schedule.example.org';
  const client=fixture(allowRealEvents);
  const scheduler=createScheduler({
    mode:'live',host:'127.0.0.1',port,
    client:client.client,guildId:CHANNELS.guildId,
    policy,logChannelId:LOGS,channelId:CHANNELS.mod,
    testMode,clientId:'client-id',clientSecret:'secret',
    sessionSecret:secret,baseUrl:host,
    dataFile:path.join(dir,'scheduling.json'),
  });
  await scheduler.start();
  const url='http://127.0.0.1:'+port;
  const req=async(method,urlPath,id='owner',body)=>{
    const result=await fetch(url+urlPath,{method,
      headers:headers(id,secret,host,body!==undefined),
      ...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return {status:result.status,body:await result.json()};
  };
  return {client,scheduler,req,async stop(){await scheduler.stop();fs.rmSync(dir,{recursive:true,force:true});}};
}
test('Discord TEST mode contains ALL invitation and publication messages inside #bot-logs',async()=>{
  const t=await appFixture(true,12193);
  try {
    const identity=await t.req('GET','/api/me','owner');
    assert.equal(identity.body.testMode,true,'browser must display TEST mode visibly');
    const created=await t.req('POST','/api/rounds','owner',{
      title:'Test match',timezone:'Europe/Amsterdam',
      startDate:date(9),endDate:date(9),selectedDates:[date(9)],
      durationMinutes:120,destination:'public',testMode:false,
    });
    assert.equal(created.status,201,JSON.stringify(created.body));
    assert.equal(created.body.round.testMode,true,'browser cannot turn off server-side test mode');
    assert.equal(created.body.round.submissionChannelId,LOGS);
    assert.equal(t.client.sent[LOGS]?.length,1,'invitation must be in #bot-logs');
    assert.ok(!t.client.sent[CHANNELS.league]&&!t.client.sent[CHANNELS.public]);
    const id=created.body.round.id;

    const unverified=await t.req('POST','/api/rounds/'+id+'/availability','u2',{
      days:[{date:date(9),status:'unavailable'}],
    });
    assert.equal(unverified.status,403,'both checkmark roles are mandatory');
    const submitted=await t.req('POST','/api/rounds/'+id+'/availability','u1',{
      days:[{date:date(9),status:'available',windows:[{start:'18:00',end:'23:00'}]}],
    });
    assert.equal(submitted.status,200,JSON.stringify(submitted.body));
    const closed=await t.req('POST','/api/rounds/'+id+'/close-collection','owner',{});
    assert.equal(closed.body.round.phase,'review');
    const candidate=closed.body.round.candidates[0];
    assert.ok(candidate);
    const published=await t.req('POST','/api/rounds/'+id+'/publish','owner',{
      candidateId:candidate.id,startAt:candidate.slots[0].startAt,
    });
    assert.equal(published.status,200,JSON.stringify(published.body));
    assert.equal(published.body.publication.status,'simulated');
    assert.equal(t.client.eventCreateCalls,0);
    assert.equal(t.client.sent[LOGS]?.length,2,'only invite and test event in logs');
    assert.ok(!t.client.sent[CHANNELS.league]&&!t.client.sent[CHANNELS.public]);
    const last=t.client.sent[LOGS][1];
    assert.match(last.embeds[0].toJSON().title,/\[TEST ONLY\]/);
    assert.equal(last.components.length,0);
  }finally{await t.stop();}
});

test('normal mode sends invitation only to League by default, or Public when explicitly chosen',async()=>{
  const t=await appFixture(false,12194);
  try{
    const template={
      title:'Normal match',timezone:'Europe/Amsterdam',
      startDate:date(9),endDate:date(10),durationMinutes:120,
    };
    const first=await t.req('POST','/api/rounds','owner',template);
    const second=await t.req('POST','/api/rounds','owner',{...template,title:'Public round',destination:'public'});
    assert.equal(first.status,201,JSON.stringify(first.body));
    assert.equal(second.status,201,JSON.stringify(second.body));
    assert.equal(first.body.round.submissionChannelId,CHANNELS.league);
    assert.equal(second.body.round.submissionChannelId,CHANNELS.public);
    assert.equal(first.body.round.testMode,false);
    assert.equal(t.client.sent[CHANNELS.league]?.length,1);
    assert.equal(t.client.sent[CHANNELS.public]?.length,1);
    assert.equal(t.client.sent[LOGS]?.length||0,0,'logs stay separate in normal mode');
    assert.equal(t.client.sent[CHANNELS.mod]?.length||0,0,'setup controls do not generate member spam in Mod');
  }finally{await t.stop();}
});


test('test mode cannot access, update or leak a normal scheduling round',async()=>{
  const t=await appFixture(true,12195);
  try{
    const real=seedRound({testMode:false,destination:'league'});
    await t.scheduler.store.transaction(s=>{s.rounds.push(real);});
    const list=await t.req('GET','/api/rounds','owner');
    assert.ok(!list.body.rounds.some(r=>r.id===real.id),'normal rounds must not be visible in test mode');
    const access=await t.req('GET','/api/rounds/'+real.id,'owner');
    assert.equal(access.status,403);
    const announcement=await t.req('POST','/api/rounds/'+real.id+'/announce','owner',{});
    assert.equal(announcement.status,403,'test runtime cannot accidentally announce to League or Public');
    assert.equal(t.client.sent[CHANNELS.league]?.length||0,0);
    assert.equal(t.client.sent[CHANNELS.public]?.length||0,0);
  }finally{await t.stop();}
});

test('test simulations do not occupy a real Discord Scheduled Event day',async()=>{
  const {SchedulingStore}=require('../src/scheduling/store');
  const {publishCandidate}=require('../src/scheduling/publisher');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-simulation-day-'));
  try{
    const store=new SchedulingStore(path.join(dir,'state.json'));store.initialize();
    const testRound=seedRound({testMode:true,endDate:date(9)});
    const realRound=seedRound({testMode:false,endDate:date(9)});
    for(const round of [testRound,realRound]){
      for(const p of round.participants) setDay(round,p.id,date(9),
        {status:'available',windows:[{start:'18:00',end:'23:00'}]});
      closeCollection(round,new Date(),true);
    }
    await store.transaction(s=>{s.rounds.push(testRound,realRound);});
    const a=testRound.candidates[0],b=realRound.candidates[0];
    const sim=await publishCandidate(store,testRound.id,a.id,a.slots[0].startAt,{testMode:true,demo:false});
    assert.equal(sim.status,'simulated');
    const real=await publishCandidate(store,realRound.id,b.id,b.slots[0].startAt,{demo:true});
    assert.equal(real.status,'created','simulated tests must not reserve real calendar dates');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('management slash command is allowed in bot-logs only during test mode',async()=>{
  const {attachSchedulingCommands}=require('../src/scheduling/slashCommands');
  const calls=[];
  const fakeClient={
    guilds:{fetch:async()=>({commands:{create:async def=>calls.push({registered:def})}})},
    on:()=>{},off:()=>{},
  };
  const commands=attachSchedulingCommands(fakeClient,{read:()=>({rounds:[]})},{
    policy,baseUrl:'https://calendar.example.org',testMode:true,
  });
  await commands.initialize();
  assert.equal(calls[0].registered.name,'schedule');
  const manager={id:'owner',user:{id:'owner'},roles:{cache:{has:id=>id===MANAGEMENT}}};
  const interaction=(channelId,member=manager)=>({
    guildId:CHANNELS.guildId,channelId,guild:{ownerId:'someone'},
    member,isChatInputCommand:()=>true,commandName:'schedule',
    options:{getSubcommand:()=> 'create'},
    reply:async p=>calls.push({reply:p}),
  });
  await commands.onInteraction(interaction(LOGS));
  assert.match(calls.at(-1).reply.embeds[0].toJSON().title,/\[TEST\]/);
  await commands.onInteraction(interaction(CHANNELS.mod));
  assert.match(calls.at(-1).reply.content,/#bot-logs/);
  commands.stop();
});


test('normal mode posts a separate confirmed-event announcement only in the chosen Public channel',async()=>{
  const t=await appFixture(false,12196,true);
  try{
    const day=date(9);
    const created=await t.req('POST','/api/rounds','owner',{
      title:'Public event live test',timezone:'Europe/Amsterdam',
      startDate:day,endDate:day,selectedDates:[day],destination:'public',
      durationMinutes:120,
    });
    assert.equal(created.status,201,JSON.stringify(created.body));
    const id=created.body.round.id;
    assert.equal(t.client.sent[CHANNELS.public]?.length,1);
    const submitted=await t.req('POST','/api/rounds/'+id+'/availability','u1',{
      days:[{date:day,status:'available',windows:[{start:'18:00',end:'23:00'}]}],
    });
    assert.equal(submitted.status,200,JSON.stringify(submitted.body));
    const closed=await t.req('POST','/api/rounds/'+id+'/close-collection','owner',{});
    assert.equal(closed.status,200);
    const candidate=closed.body.round.candidates[0];
    assert.ok(candidate,'optimizer should offer a slot');
    const payload={candidateId:candidate.id,startAt:candidate.slots[0].startAt};
    const published=await t.req('POST','/api/rounds/'+id+'/publish','owner',payload);
    assert.equal(published.status,200,JSON.stringify(published.body));
    assert.equal(published.body.publication.status,'created');
    assert.equal(t.client.eventCreateCalls,1);
    assert.equal(t.client.sent[CHANNELS.public]?.length,2,'one invitation plus one confirmed event');
    assert.ok(!t.client.sent[CHANNELS.league]);
    assert.ok(!t.client.sent[LOGS]);
    const eventPayload=t.client.sent[CHANNELS.public][1];
    assert.equal(eventPayload.components.length,1);
    assert.match(eventPayload.embeds[0].toJSON().title,/Public event live test/);
    const again=await t.req('POST','/api/rounds/'+id+'/publish','owner',payload);
    assert.equal(again.body.publication.status,'created');
    assert.equal(t.client.eventCreateCalls,1,'idempotent event creation');
    assert.equal(t.client.sent[CHANNELS.public]?.length,2,'retry must edit existing announcement, not duplicate it');
  }finally{await t.stop();}
});


test('Discord OAuth login preserves the Management setup wizard after authentication',()=>{
  const {createAuth}=require('../src/scheduling/auth');
  const auth=createAuth({
    mode:'live',client:{},guildId:CHANNELS.guildId,
    clientId:'123456789012345678',clientSecret:'private-for-test',
    sessionSecret:'a-very-long-private-session-secret-for-test',
    baseUrl:'https://calendar.example.org',policy,
  });
  const captured={};
  const response={
    writeHead(code,headers){captured.code=code;captured.headers=headers;},
    end(){},
  };
  auth.login({url:'/login?view=new',headers:{}},response);
  assert.equal(captured.code,302);
  assert.match(captured.headers.Location,/discord\.com\/oauth2\/authorize/);
  const cookies=captured.headers['Set-Cookie'];
  assert.ok(cookies.some(x=>x.startsWith('winterbot_view=new;')),
    'the setup wizard view should survive Discord OAuth');
});


test('official Management and both checkmark role IDs work without extra env configuration',()=>{
  const defaults=configureChannelPolicy({
    guildId:CHANNELS.guildId,logChannelId:LOGS,demo:false,
  },{});
  assert.equal(DEFAULT_ROLES.management,'332571825127292929');
  assert.deepEqual(DEFAULT_ROLES.verification,['826810836302823484','826799764829372416']);
  assert.equal(defaults.managementRoleId,DEFAULT_ROLES.management);
  assert.deepEqual(defaults.verifiedRoleIds,DEFAULT_ROLES.verification);

  const user=(id,roles)=>({id,user:{id},roles:{cache:{has:r=>roles.includes(r)}}});
  assert.ok(isOrganizerMember(user('manager',[DEFAULT_ROLES.management]),defaults));
  assert.equal(isOrganizerMember(user('verified',DEFAULT_ROLES.verification),defaults),false);
  assert.ok(isVerifiedMember(user('verified',DEFAULT_ROLES.verification),defaults));
  assert.equal(isVerifiedMember(user('one-role',[DEFAULT_ROLES.verification[0]]),defaults),false);
  assert.equal(isVerifiedMember(user('other-role',[DEFAULT_ROLES.verification[1]]),defaults),false);
  assert.equal(isVerifiedMember(user('no-roles',[]),defaults),false);
  // Explicit hosting configuration remains supported, but is no longer required
  // just to identify the existing roles in this specific Discord server.
  assert.equal(policy.managementRoleId,MANAGEMENT);
  assert.deepEqual(policy.verifiedRoleIds,[VERIFY1,VERIFY2]);
});
