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
    guildId,channelId,user:{id:USER_ID},guild:{ownerId:USER_ID},
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
  const source=fs.readFileSync(path.join(__dirname,'../src/scheduling/activity-client/main.js'));
  const expected=crypto.createHash('sha256').update(source).digest('hex');
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
