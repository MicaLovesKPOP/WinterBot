'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {PreviewStore, GRACE_MINUTES,DEFAULT_GRACE_MINUTES}=require('../src/scheduling/nativePrototypeState');
const {createEventPreview,eventPanel}=require('../src/scheduling/nativeEventPreview');
const {commandDefinition}=require('../src/scheduling/slashCommands');

const USER_ID='123456789012345678';
const GUILD='199916140183420928',LOG='332575578383187970';
const ROLE='332571825127292929';
const policy={guildId:GUILD,logChannelId:LOG,managementRoleId:ROLE,verifiedRoleIds:[]};

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-grace-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new PreviewStore(path.join(dir,'state.json'));
  const manager=createEventPreview({store,policy});
  const interaction=(id='',values=[])=>{
    const output={reply:null,update:null};
    const i={guildId:GUILD,channelId:LOG,user:{id:USER_ID},
      member:{id:USER_ID,roles:{cache:{has:r=>r===ROLE}}},
      guild:{ownerId:'999999999999999999'},customId:id,values,
      async reply(value){output.reply=value;},async update(value){output.update=value;},
      async fetchReply(){return {id:'555555555555555555'};}};
    return {i,output};
  };
  return {store,manager,interaction};
}
test('grace-period controls have only 0, 1, 2, 3, 5, 10 and 15 minutes',()=>{
  const event={id:'aaaaaaaaaaaa',status:'running',graceMinutes:DEFAULT_GRACE_MINUTES};
  const options=eventPanel(event).components[0].components[0].toJSON().options;
  assert.deepEqual(options.map(o=>Number(o.value)),GRACE_MINUTES);
  assert.equal(options.find(o=>o.default).value,'5');
  assert.equal(options.some(o=>o.value==='30'),false);
});
test('a test lifecycle goes running, wrapping up, overtime again, and ended',async t=>{
  const {store,manager,interaction}=fixture(t);
  const opened=interaction();
  await manager.start(opened.i);
  assert.match(opened.output.reply.embeds[0].toJSON().title,/TEST/);
  const id=Object.keys(store.read().events)[0];
  assert.equal(store.read().events[id].graceMinutes,5);
  assert.equal(store.read().events[id].messageId,'555555555555555555');
  await manager.handle(interaction('wbend:duration:'+id,['2']).i);
  assert.equal(store.read().events[id].graceMinutes,2);
  await manager.handle(interaction('wbend:end:'+id).i);
  assert.equal(store.read().events[id].status,'grace');
  assert.ok(Date.parse(store.read().events[id].dueAt)>Date.now());
  await manager.handle(interaction('wbend:extend1:'+id).i);
  assert.ok(Date.parse(store.read().events[id].dueAt)>Date.now()+2*60000);
  await manager.handle(interaction('wbend:cancel:'+id).i);
  assert.equal(store.read().events[id].status,'running');
  await manager.handle(interaction('wbend:end:'+id).i);
  await manager.handle(interaction('wbend:asknow:'+id).i);
  assert.equal(store.read().events[id].confirmNow,true);
  await manager.handle(interaction('wbend:now:'+id).i);
  assert.equal(store.read().events[id].status,'ended');
});
test('expired TEST grace period closes and updates only the test channel message',async t=>{
  const {store,manager,interaction}=fixture(t);
  await manager.start(interaction().i);
  const id=Object.keys(store.read().events)[0];
  await manager.handle(interaction('wbend:end:'+id).i);
  await store.transaction(s=>{s.events[id].dueAt=new Date(Date.now()-1000).toISOString();});
  let channelAccesses=0,edits=0;
  const client={channels:{async fetch(cid){
    assert.equal(cid,LOG);
    channelAccesses++;
    return {messages:{async fetch(msgid){
      assert.equal(msgid,'555555555555555555');
      return {async edit(panel){
        edits++;
        assert.match(panel.embeds[0].toJSON().title,/Ended/);
      }};
    }}};
  }}};
  await manager.tick(client);
  assert.equal(store.read().events[id].status,'ended');
  assert.equal(channelAccesses,1);
  assert.equal(edits,1);
  await manager.tick(client);
  assert.equal(edits,1);
});
test('event lifecycle controls reject unverified channel and unauthorized moderators',async t=>{
  const {manager,interaction}=fixture(t);
  const bad=interaction();
  bad.i.channelId='111111111111111111';
  await assert.rejects(()=>manager.start(bad.i),/#bot-logs/);
});
test('preview commands are available in TEST mode only',()=>{
  const normal=commandDefinition(false).toJSON().options.map(o=>o.name);
  const testCmd=commandDefinition(true).toJSON().options.map(o=>o.name);
  assert.deepEqual(testCmd.slice(-2),['preview','preview-event']);
  assert.equal(normal.includes('preview'),false);
  assert.equal(normal.includes('preview-event'),false);
});