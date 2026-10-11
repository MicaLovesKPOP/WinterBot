'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createScheduler } = require('../src/scheduling/server');
const { ButtonInteraction, MessageFlags } = require('discord.js');
const { enroll, setDays } = require('../src/scheduling/core');
const { createActivityTest, GUILD_ID, CHANNEL_ID, LAUNCH_ID } =
  require('../src/scheduling/activityTest');

const CLIENT_ID='112233445566778899';
const USER_ID='998877665544332211';
const BOT_ID='123451234512345123';
const SECRET='activity-tests-secret-32-or-more-characters-only';

function fixture() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-embedded-test-'));
  const sent=[];
  const restCalls=[];
  const commands=[];
  const listeners=new Map();
  let access=true;
  const member={id:USER_ID,user:{id:USER_ID,bot:false},displayName:'Winter Tester'};
  const channel={
    id:CHANNEL_ID,guildId:GUILD_ID,isTextBased:()=>true,
    permissionsFor:()=>({has:()=>access}),
    async send(payload){sent.push(payload);return {id:'987654321',url:'https://discord.com/channels/'+GUILD_ID+'/'+CHANNEL_ID+'/987654321'};},
  };
  const guild={
    id:GUILD_ID,ownerId:USER_ID,memberCount:3,
    members:{async fetch({user}){if(user!==USER_ID)throw Error('Unknown member');return member;}},
    channels:{async fetch(id){return id===CHANNEL_ID?channel:null;}},
    commands:{async create(data){commands.push(data);return data;}},
  };
  const client={
    user:{id:BOT_ID},guilds:{async fetch(id){return id===GUILD_ID?guild:null;}},
    channels:{async fetch(id){return id===CHANNEL_ID?channel:null;}},
    rest:{async post(route,payload){restCalls.push({route,payload});return {};} },
    on(event,handler){listeners.set(event,handler);},
    off(event,handler){if(listeners.get(event)===handler)listeners.delete(event);},
  };
  const oauth=async (url)=>{
    if(String(url).endsWith('/oauth2/token')){
      return {ok:true,async json(){return {access_token:'oauth-token-private'};}};
    }
    if(String(url).endsWith('/users/@me')){
      return {ok:true,async json(){return {id:USER_ID,username:'Winter Tester'};}};
    }
    throw Error('Unexpected OAuth URL '+url);
  };
  const activity=createActivityTest({
    client,clientId:CLIENT_ID,clientSecret:'test-client-secret',sessionSecret:SECRET,
    dataFile:path.join(dir,'activity.json'),now:()=>new Date('2026-10-10T12:00:00Z'),
    fetchImpl:oauth,
  });
  return {
    client,activity,sent,restCalls,commands,listeners,member,
    setAccess(allowed){access=allowed;},
    clean(){fs.rmSync(dir,{recursive:true,force:true});},
    dataFile:path.join(dir,'activity.json'),
    demoFile:path.join(dir,'demo.json'),
  };
}
function headers(origin,extra={}){
  return {'Content-Type':'application/json','X-WinterBot-Activity':'1','Origin':origin,...extra};
}
async function start(f,port){
  const app=createScheduler({mode:'demo',host:'127.0.0.1',port,
    dataFile:f.demoFile,activityTest:f.activity});
  await app.start();
  return {app,url:'http://127.0.0.1:'+port};
}
function fakeInteraction(type,subcommand='invite',guildId=GUILD_ID,channelId=CHANNEL_ID){
  const calls={};
  const x={
    guildId,channelId,user:{id:USER_ID,bot:false},guild:{ownerId:USER_ID},
    member:{id:USER_ID,user:{id:USER_ID,bot:false}},
    memberPermissions:{has:()=>true},
    isButton:()=>type==='button',isChatInputCommand:()=>type==='command',
    commandName:'activitytest',customId:LAUNCH_ID,
    message:{author:{id:BOT_ID}},id:'112211221122112211',
    token:'fake-interaction-token',
    options:{getSubcommand:()=>subcommand},
    // Invoke discord.js's real method so the test detects missing auth:false.
    async launchActivity(opts) {
      return ButtonInteraction.prototype.launchActivity.call(this,opts);
    },
    async reply(data){calls.reply=data;x.replied=true;},
    async update(data){calls.update=data;x.replied=true;},
    async deferUpdate(){calls.deferUpdate=true;x.deferred=true;},
    async followUp(data){calls.followUp=data;},
    async showModal(data){calls.modal=data;},
    async fetchReply(){return {id:'999999999999999999'};},
    isModalSubmit:()=>type==='modal',
    isFromMessage:()=>false,
    async deferReply(data){calls.defer=data;x.deferred=true;},
    async editReply(data){calls.edit=data;},
  };
  return {x,calls};
}

test('Activity uses a completely separate persisted round and registers only a test-guild command',async()=>{
  const f=fixture();
  try{
    await f.activity.start();
    assert.equal(f.commands.length,1);
    assert.equal(f.commands[0].name,'activitytest');
    assert.equal(f.commands[0].default_member_permissions,'32');
    assert.ok(f.listeners.has('interactionCreate'));
    const r=f.activity.store.read().rounds[0];
    assert.ok(r.testMode,'test round never publishes a real event');
    assert.equal(r.rosterMode,'open');
    assert.equal(r.participants.length,0);
    assert.ok(r.dayLimits[r.selectedDates[0]]);
    assert.ok(fs.existsSync(f.dataFile));
    await f.activity.start();
    assert.equal(f.commands.length,1,'idempotent startup');
    f.activity.stop();
    assert.ok(!f.listeners.has('interactionCreate'));
  }finally{f.clean();}
});

test('Discord Activity routes serve the SDK page with frame protection scoped correctly',async()=>{
  const f=fixture(), {app,url}=await start(f,12360);
  try{
    const [page,config,script,main]=await Promise.all([
      fetch(url+'/activity/'),fetch(url+'/activity/api/config'),
      fetch(url+'/activity/activity.js'),fetch(url+'/'),
    ]);
    assert.equal(page.status,200);
    assert.match(await page.text(),/WinterBot/);
    assert.equal(page.headers.get('x-frame-options'),null,
      'Activity may be framed inside Discord');
    assert.match(page.headers.get('content-security-policy'),/frame-ancestors/);
    assert.equal(script.status,200);
    assert.match(await script.text(),/WinterBot Activity source SHA256/);
    assert.deepEqual(await config.json(),{
      clientId:CLIENT_ID,guildId:GUILD_ID,channelId:CHANNEL_ID,
    });
    assert.equal(main.headers.get('x-frame-options'),'SAMEORIGIN',
      'existing browser planner retains anti-framing policy');
    const unknown=await fetch(url+'/activity/api/some-random-private-data');
    assert.equal(unknown.status,404);
  }finally{await app.stop();f.clean();}
});

test('Activity OAuth session uses partitioned cookies, channel permission and anti-CSRF',async()=>{
  const f=fixture(), {app,url}=await start(f,12361);
  try{
    const origin=f.activity.origin;
    let result=await fetch(url+'/activity/api/state');
    assert.equal(result.status,401,'anonymous user denied');
    result=await fetch(url+'/activity/api/token',{
      method:'POST',headers:headers('https://not-discord.example'),
      body:JSON.stringify({code:'valid-auth-code'}),
    });
    assert.equal(result.status,403,'wrong request origin denied');
    result=await fetch(url+'/activity/api/token',{
      method:'POST',headers:headers(origin),
      body:JSON.stringify({code:'valid-auth-code'}),
    });
    assert.equal(result.status,200);
    const cookie=result.headers.get('set-cookie');
    assert.match(cookie,/Secure/);
    assert.match(cookie,/HttpOnly/);
    assert.match(cookie,/SameSite=None/);
    assert.match(cookie,/Partitioned/);
    assert.match(cookie,new RegExp('Domain='+CLIENT_ID+'\\.discordsays\\.com'));
    const cookiePair=cookie.split(';')[0];
    result=await fetch(url+'/activity/api/state',{headers:{Cookie:cookiePair}});
    assert.equal(result.status,200);
    const state=(await result.json()).round;
    assert.equal(state.phase,'collecting');
    assert.equal(state.dates.length,3);
    assert.equal(state.availability[USER_ID],undefined,
      'only one current identity is returned, not guild-wide private details');

    const day=state.dates[0];
    result=await fetch(url+'/activity/api/availability',{
      method:'POST',headers:headers(origin,{Cookie:cookiePair}),
      body:JSON.stringify({days:[{date:day,status:'available',
        windows:[{start:'17:30',end:'22:30',maxMinutes:180}],maxMinutes:120}]}),
    });
    assert.equal(result.status,200);
    const saved=(await result.json()).round;
    assert.equal(saved.availability[day].maxMinutes,120);
    assert.equal(saved.availability[day].windows[0].maxMinutes,180);
    assert.equal(f.activity.store.read().rounds[0].participants.length,1);

    result=await fetch(url+'/activity/api/availability',{
      method:'POST',headers:headers(origin,{Cookie:cookiePair}),
      body:JSON.stringify({days:[{date:day,status:'available',
        windows:[{start:'16:00',end:'22:30'}]}]}),
    });
    assert.equal(result.status,400);
    result=await fetch(url+'/activity/api/availability',{
      method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookiePair},
      body:JSON.stringify({days:[{date:day,status:'unavailable'}]}),
    });
    assert.equal(result.status,403,'missing anti-CSRF header denied');

    f.setAccess(false);
    result=await fetch(url+'/activity/api/state',{headers:{Cookie:cookiePair}});
    assert.equal(result.status,403,'revoked channel visibility blocks reads');
    f.setAccess(true);
    const altered=cookiePair.slice(0,-1)+(cookiePair.endsWith('x')?'y':'x');
    result=await fetch(url+'/activity/api/state',{headers:{Cookie:altered}});
    assert.equal(result.status,401,'tampered session denied');
  }finally{await app.stop();f.clean();}
});

test('test invitation button launches Activity callback 12 only in the test channel',async()=>{
  const f=fixture();
  try{
    const {x,calls}=fakeInteraction('command','invite');
    await f.activity.onInteraction(x);
    assert.ok(calls.defer);
    assert.ok(calls.edit?.includes('Posted Activity invitation'));
    assert.equal(f.sent.length,1);
    assert.match(JSON.stringify(f.sent[0]),/Open availability planner in Discord/);
    assert.ok(!JSON.stringify(f.sent[0]).includes('@everyone'));
    assert.deepEqual(f.sent[0].allowedMentions,{parse:[]});

    const button=fakeInteraction('button');
    button.x.client=f.client;
    await f.activity.onInteraction(button.x);
    assert.equal(f.restCalls.length,1);
    assert.equal(f.restCalls[0].payload.body.type,12);
    assert.equal(f.restCalls[0].payload.auth,false,
      'Discord interaction callbacks must not attach the bot Authorization header');
    assert.equal(button.x.replied,true,'discord.js tracks the type-12 acknowledgment');
    assert.match(f.restCalls[0].route,/\/interactions\//);

    const wrong=fakeInteraction('button','invite',GUILD_ID,'387323214105411599');
    await f.activity.onInteraction(wrong.x);
    assert.equal(f.restCalls.length,1,'launch blocked outside test channel');
    assert.match(wrong.calls.reply.content,/restricted/);

    const rejected=fakeInteraction('button');
    rejected.x.launchActivity=async()=> {
      throw Object.assign(new Error('Application Activities have not been enabled'),{
        code:50118,status:400,
      });
    };
    // No secrets or interaction tokens are logged by the fallback.
    const captured=[];
    const prior=console.error;
    console.error=(...args)=>captured.push(args);
    try { await f.activity.onInteraction(rejected.x); }
    finally { console.error=prior; }
    assert.match(rejected.calls.reply.content,/Discord error 50118/);
    assert.equal(rejected.calls.reply.flags,MessageFlags.Ephemeral);
    assert.equal(rejected.calls.reply.allowedMentions.parse.length,0);
    assert.equal(f.restCalls.length,1,'failed launch must not start a second REST callback');
    assert.match(JSON.stringify(captured),/50118/);
    assert.doesNotMatch(JSON.stringify(captured),/fake-interaction-token/,
      'logs must not expose interaction credentials');
  }finally{f.clean();}
});

test('test vote posts a separate new notification and never creates a real event',async()=>{
  const f=fixture();
  try{
    const r=await f.activity.ensureRound();
    const day=r.selectedDates[0];
    await f.activity.store.transaction(data=>{
      const round=data.rounds[0];
      enroll(round,USER_ID,'Winter Tester');
      setDays(round,USER_ID,[
        {date:day,status:'available',windows:[
          {start:'17:30',end:'20:00'},
          {start:'21:00',end:'24:00'},
        ]},
      ],new Date('2026-10-10T12:00:00Z'));
    });
    const invite=fakeInteraction('command','invite');
    await f.activity.onInteraction(invite.x);
    const voting=fakeInteraction('command','vote');
    await f.activity.onInteraction(voting.x);
    assert.equal(f.sent.length,2,'one invite and a SEPARATE vote announcement');
    assert.match(JSON.stringify(f.sent[1]),/Test vote is open/);
    const changed=f.activity.store.read().rounds[0];
    assert.equal(changed.phase,'voting');
    assert.ok(changed.ballot.options.length>=2);
    assert.equal(changed.publications.length,0,'never create actual Discord events');
  }finally{f.clean();}
});

test('compiled Activity bundle stays synchronized with its source',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/scheduling/activity-client/main.js'),'utf8')
    .replace(/\r\n/g,'\n');
  const expected=crypto.createHash('sha256').update(source,'utf8').digest('hex');
  const bundle=fs.readFileSync(path.join(__dirname,'../src/scheduling/activity-public/activity.js'),'utf8');
  assert.match(bundle,new RegExp('^/\\* WinterBot Activity source SHA256: '+expected+' \\*/'));
});


test('test-guild diagnostic command distinguishes enabled and disabled Discord Activities',async()=>{
  const f=fixture();
  try {
    f.client.application={
      async fetch(){return {flags:{has:()=>true}};},
    };
    const enabled=fakeInteraction('command','status');
    await f.activity.onInteraction(enabled.x);
    assert.match(enabled.calls.reply.content,/ENABLED/);
    assert.match(enabled.calls.reply.content,/URL Mappings/);
    assert.equal(enabled.calls.reply.flags,MessageFlags.Ephemeral);

    f.client.application.fetch=async()=>({flags:{has:()=>false}});
    const disabled=fakeInteraction('command','status');
    await f.activity.onInteraction(disabled.x);
    assert.match(disabled.calls.reply.content,/NOT ENABLED/);
    assert.match(disabled.calls.reply.content,/Enable Activities/);
    assert.equal(f.sent.length,0,'diagnostics never post public channel messages');
  }finally {f.clean();}
});


test('weekly Activity API is test-guild authenticated, CSRF protected and isolated from legacy voting',async()=>{
  const f=fixture(), {app,url}=await start(f,12386);
  try{
    let response=await fetch(url+'/activity/api/ux/state');
    assert.equal(response.status,401,'no Activity cookie may access UX data');
    response=await fetch(url+'/activity/api/token',{
      method:'POST',headers:headers(f.activity.origin),
      body:JSON.stringify({code:'valid-weekly-ux-code'}),
    });
    assert.equal(response.status,200);
    const cookie=response.headers.get('set-cookie').split(';')[0];

    response=await fetch(url+'/activity/api/ux/state',{headers:{Cookie:cookie}});
    assert.equal(response.status,200);
    const initial=await response.json();
    assert.equal(initial.round.dates.length,7);
    assert.equal(initial.progress.answered,0);
    assert.equal(initial.member.submitted,null);
    const date=initial.round.dates[0];

    response=await fetch(url+'/activity/api/ux/draft',{
      method:'POST',headers:headers('https://untrusted.example',{Cookie:cookie}),
      body:JSON.stringify({days:[{date,status:'unavailable',windows:[]}]}),
    });
    assert.equal(response.status,403);
    response=await fetch(url+'/activity/api/ux/draft',{
      method:'POST',headers:headers(f.activity.origin,{Cookie:cookie}),
      body:JSON.stringify({days:[{date,status:'unavailable',windows:[]}]}),
    });
    assert.equal(response.status,200);
    const saved=await response.json();
    assert.equal(saved.progress.answered,1);
    assert.equal(saved.member.draft[date].status,'unavailable');
    assert.equal(saved.member.submitted,null);

    response=await fetch(url+'/activity/api/ux/submit',{
      method:'POST',headers:headers(f.activity.origin,{Cookie:cookie}),
      body:JSON.stringify({confirm:true}),
    });
    assert.equal(response.status,400,'incomplete week cannot be submitted');
    response=await fetch(url+'/activity/api/state',{headers:{Cookie:cookie}});
    assert.equal(response.status,200);
    const legacy=(await response.json()).round;
    assert.equal(legacy.dates.length,3,'existing Activity test round untouched');
    assert.equal(legacy.availability[USER_ID],undefined);
    assert.equal(f.activity.weeklyUx.store.read().rounds.weekly.members[USER_ID].draft[date].status,'unavailable');
  }finally{await app.stop();f.clean();}
});


test('Activity API preserves submitted attendance when cancelling revisions and editing templates',async()=>{
  const f=fixture(),{app,url}=await start(f,12390);
  try{
    let response=await fetch(url+'/activity/api/token',{
      method:'POST',headers:headers(f.activity.origin),
      body:JSON.stringify({code:'valid-weekly-ux-code'}),
    });
    assert.equal(response.status,200);
    const cookie=response.headers.get('set-cookie').split(';')[0];
    const apiHeaders=headers(f.activity.origin,{Cookie:cookie});
    response=await fetch(url+'/activity/api/ux/state',{headers:{Cookie:cookie}});
    assert.equal(response.status,200);
    const dates=(await response.json()).round.dates;
    const updates=dates.map(date=>({date,status:'unavailable',windows:[]}));
    response=await fetch(url+'/activity/api/ux/draft',{
      method:'POST',headers:apiHeaders,body:JSON.stringify({days:updates}),
    });
    assert.equal(response.status,200);
    response=await fetch(url+'/activity/api/ux/review',{
      method:'POST',headers:apiHeaders,body:JSON.stringify({confirmReview:true}),
    });
    assert.equal(response.status,200);
    response=await fetch(url+'/activity/api/ux/submit',{
      method:'POST',headers:apiHeaders,body:JSON.stringify({confirm:true}),
    });
    assert.equal(response.status,200);
    const original=(await response.json()).member.submitted;

    const usual={Monday:{status:'available',windows:[{
      start:'19:00',end:'22:00',kind:'tentative',maxMinutes:null,
    }]}};
    response=await fetch(url+'/activity/api/ux/template-update',{
      method:'POST',headers:headers('https://untrusted.example',{Cookie:cookie}),
      body:JSON.stringify({confirm:true,days:usual}),
    });
    assert.equal(response.status,403,'template updates must respect CSRF rules');
    response=await fetch(url+'/activity/api/ux/template-update',{
      method:'POST',headers:apiHeaders,body:JSON.stringify({confirm:true,days:usual}),
    });
    assert.equal(response.status,200);
    assert.deepEqual((await response.json()).template,usual);

    response=await fetch(url+'/activity/api/ux/draft',{
      method:'POST',headers:apiHeaders,body:JSON.stringify({days:[{
        date:dates[0],status:'available',windows:[{
          start:'18:00',end:'22:00',kind:'confirmed',maxMinutes:null,
        }],
      }]}),
    });
    assert.equal(response.status,200);
    response=await fetch(url+'/activity/api/ux/discard-revision',{
      method:'POST',headers:apiHeaders,body:JSON.stringify({confirm:true}),
    });
    assert.equal(response.status,200);
    const restored=await response.json();
    assert.deepEqual(restored.member.draft,original);
    assert.deepEqual(restored.member.submitted,original);
    assert.deepEqual(restored.template,usual);
    assert.equal(f.activity.store.read().rounds.length,0,
      'Template edits must not create a legacy test round');
  }finally{
    await app.stop();
    f.clean();
  }
});


test('all isolated test commands register only in Mica test guild, not Crashday',async()=>{
  const f=fixture();
  try{
    await f.activity.start();
    assert.equal(f.commands.length,1,'Only /activitytest is registered by the test subsystem');
    const definitions=f.commands[0].options.map(option=>option.name);
    assert.deepEqual(definitions,
      ['invite','status','vote','reset','next-week','preview-native','preview-event','tests']);
    const help=fakeInteraction('command','tests');
    await f.activity.onInteraction(help.x);
    assert.match(help.calls.reply.content,/preview-event/);
    assert.match(help.calls.reply.content,/preview-native/);
    assert.match(help.calls.reply.content,/not yet integrated/i);
    assert.match(help.calls.reply.content,/still to build/i);
    const wrong=fakeInteraction('command','preview-event','199916140183420928',CHANNEL_ID);
    await f.activity.onInteraction(wrong.x);
    assert.match(wrong.calls.reply.content,/test channel/);
    assert.equal(Object.keys(f.activity.nativeTest.store.read().events).length,0);
    const wrongChannel=fakeInteraction('command','preview-native',GUILD_ID,'777777777777777777');
    await f.activity.onInteraction(wrongChannel.x);
    assert.match(wrongChannel.calls.reply.content,/test channel/);
    assert.equal(Object.keys(f.activity.nativeTest.store.read().rounds).length,0);
  }finally{f.activity.stop();f.clean();}
});

test('event shutdown is a moderator-only, isolated Discord message simulation',async()=>{
  const f=fixture();
  try{
    await f.activity.start();
    const create=fakeInteraction('command','preview-event');
    await f.activity.onInteraction(create.x);
    assert.match(create.calls.reply.embeds[0].toJSON().title,/\[TEST\]/);
    assert.match(create.calls.reply.embeds[0].toJSON().description,/No real event, roles, check-ins or channels/i);
    assert.equal(f.sent.length,0,'Simulating an event does not publish into another channel');
    const ids=Object.keys(f.activity.nativeTest.store.read().events);
    assert.equal(ids.length,1);
    const eid=ids[0];
    assert.equal(f.activity.nativeTest.store.read().events[eid].graceMinutes,5);

    const choose=fakeInteraction('button');
    choose.x.customId='wbend:duration:'+eid;
    choose.x.values=['3'];
    await f.activity.onInteraction(choose.x);
    assert.ok(choose.calls.update,'A private-server event duration control should update its own message');
    assert.equal(f.activity.nativeTest.store.read().events[eid].graceMinutes,3);

    const end=fakeInteraction('button');
    end.x.customId='wbend:end:'+eid;
    await f.activity.onInteraction(end.x);
    assert.equal(f.activity.nativeTest.store.read().events[eid].status,'grace');
    assert.ok(f.activity.nativeTest.store.read().events[eid].dueAt);

    const unauthorized=fakeInteraction('button');
    unauthorized.x.customId='wbend:cancel:'+eid;
    unauthorized.x.user.id='887766554433221199';
    unauthorized.x.guild.ownerId=USER_ID;
    unauthorized.x.memberPermissions={has:()=>false};
    await f.activity.onInteraction(unauthorized.x);
    assert.match(unauthorized.calls.reply.content,/Only test moderators/i);
    assert.equal(f.activity.nativeTest.store.read().events[eid].status,'grace');

    const otherGuild=fakeInteraction('button','invite','199916140183420928',CHANNEL_ID);
    otherGuild.x.customId='wbend:cancel:'+eid;
    await f.activity.onInteraction(otherGuild.x);
    assert.equal(otherGuild.calls.reply,undefined,'Other guilds cannot invoke test event controls');
    assert.equal(f.activity.nativeTest.store.read().events[eid].status,'grace');

    const cancel=fakeInteraction('button');
    cancel.x.customId='wbend:cancel:'+eid;
    await f.activity.onInteraction(cancel.x);
    assert.equal(f.activity.nativeTest.store.read().events[eid].status,'running');
    assert.equal(f.activity.store.read().rounds.length,1,
      'Test event does not alter availability/voting round state');
  }finally{f.activity.stop();f.clean();}
});

test('native availability comparison is open to test-channel participants but only mods create it',async()=>{
  const f=fixture();
  try{
    await f.activity.start();
    const create=fakeInteraction('command','preview-native');
    await f.activity.onInteraction(create.x);
    assert.match(create.calls.reply.embeds[0].toJSON().title,/\[TEST\]/);
    assert.ok(create.calls.reply.components.length>0);
    const rounds=Object.keys(f.activity.nativeTest.store.read().rounds);
    assert.equal(rounds.length,1);
    const roundId=rounds[0];

    // A regular member is allowed to open the private test editor,
    // without a Manage Guild role or any Crashday verification roles.
    const member=fakeInteraction('button');
    member.x.customId='wbux:open:'+roundId;
    member.x.guild.ownerId='887766554433221199';
    member.x.memberPermissions={has:()=>false};
    await f.activity.onInteraction(member.x);
    assert.equal(member.calls.reply.flags,MessageFlags.Ephemeral|MessageFlags.IsComponentsV2);
    assert.equal(member.calls.reply.embeds,undefined);

    // The same ordinary member cannot spawn or control public test events.
    const restricted=fakeInteraction('command','preview-event');
    restricted.x.guild.ownerId='887766554433221199';
    restricted.x.memberPermissions={has:()=>false};
    await f.activity.onInteraction(restricted.x);
    assert.match(restricted.calls.reply.content,/Manage Server/i);

    const botMember=fakeInteraction('button');
    botMember.x.customId='wbux:open:'+roundId;
    botMember.x.user.bot=true;
    await f.activity.onInteraction(botMember.x);
    assert.match(botMember.calls.reply.content,/only available to members/i);

    const wrongChannel=fakeInteraction('button','invite',GUILD_ID,'777777777777777777');
    wrongChannel.x.customId='wbux:open:'+roundId;
    await f.activity.onInteraction(wrongChannel.x);
    assert.equal(wrongChannel.calls.reply,undefined);
    assert.equal(f.activity.store.read().rounds.length,1);

    // Single reset cleans ALL test-only stores; none of the prior
    // in-channel buttons can accidentally write into live data.
    const reset=fakeInteraction('command','reset');
    await f.activity.onInteraction(reset.x);
    assert.match(reset.calls.reply.content,/No main-server data changed/i);
    const state=f.activity.nativeTest.store.read();
    assert.deepEqual(state.rounds,{});
    assert.deepEqual(state.events,{});
    assert.deepEqual(state.templates,{});
    assert.equal(f.activity.weeklyUx.store.read().rounds.weekly.members[USER_ID],undefined);
  }finally{f.activity.stop();f.clean();}
});
