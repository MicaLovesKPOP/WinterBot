'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os');
const fs=require('node:fs');
const path=require('node:path');
const {DateTime}=require('luxon');
const {
  GRACE_MINUTES,DEFAULT_GRACE_MINUTES,makeRound,memberOf,
  normalizedDay,addWindow,removeWindow,allDay,applyDays,applyTemplate,
  isComplete,confirmSubmission,reviewSnapshot,templateFromSubmission,
  weekday,PreviewStore,
}=require('../src/scheduling/nativePrototypeState');
const UI=require('../src/scheduling/nativePrototypeUi');
const {createNativePrototype}=require('../src/scheduling/nativePrototype');

const USER_ID='123456789012345678';
const GUILD='199916140183420928';
const LOG='332575578383187970';
const MANAGEMENT='332571825127292929';
const VERIFIED=['826810836302823484','826799764829372416'];
const policy={guildId:GUILD,logChannelId:LOG,managementRoleId:MANAGEMENT,verifiedRoleIds:VERIFIED};

function temporaryFile(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-native-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return path.join(dir,'preview.json');
}
function windowOf(start='19:00',end='23:00',kind='confirmed',maxMinutes=null){
  return {start,end,kind,maxMinutes};
}
function demo(){
  const round=makeRound(0,DateTime.fromISO('2026-10-10T12:00:00',{zone:'Europe/Amsterdam'}));
  return {round, member:memberOf(round,USER_ID)};
}
test('grace defaults are 5 minutes, including 1/2/3 and excluding 30',()=>{
  assert.deepEqual(GRACE_MINUTES,[0,1,2,3,5,10,15]);
  assert.equal(DEFAULT_GRACE_MINUTES,5);
});
test('native preview week is seven candidate dates in Europe/Amsterdam',()=>{
  const {round}=demo();
  assert.deepEqual(round.dates,[
    '2026-10-12','2026-10-13','2026-10-14','2026-10-15',
    '2026-10-16','2026-10-17','2026-10-18',
  ]);
});
test('confirmed and tentative windows are distinct and cannot overlap',()=>{
  const day=normalizedDay({status:'available',windows:[
    windowOf('21:00','23:00','tentative'),windowOf('18:00','21:00','confirmed'),
  ]});
  assert.equal(day.windows[0].kind,'confirmed');
  assert.equal(day.windows[1].kind,'tentative');
  assert.throws(()=>addWindow(day,windowOf('20:55','21:30','tentative')),/overlap/);
  assert.throws(()=>addWindow(day,windowOf('22:00','24:00','confirmed')),/overlap/);
  assert.equal(addWindow(day,windowOf('21:00','22:00','confirmed'),1).windows[1].kind,'confirmed');
  assert.equal(removeWindow(day,1).windows.length,1);
  assert.throws(()=>normalizedDay({status:'available',windows:[windowOf('19:07','21:00')]}),/five-minute/);
  assert.equal(allDay().windows[0].end,'24:00');
});
test('bulk copying is a snapshot and submission is impossible without review',()=>{
  const {round,member}=demo();
  const [monday,tuesday]=round.dates;
  const d=normalizedDay({status:'available',windows:[windowOf('18:00','20:00')]});
  applyDays(member,round,[monday,tuesday],d);
  assert.equal(member.draft[monday].windows[0].start,'18:00');
  member.draft[monday].windows[0].start='19:00';
  assert.equal(member.draft[tuesday].windows[0].start,'18:00');
  for(const date of round.dates.slice(2)) applyDays(member,round,[date],allDay());
  assert.equal(isComplete(round,member),true);
  assert.throws(()=>confirmSubmission(member,round),/review/);
  member.reviewedSnapshot=reviewSnapshot(round,member);
  applyDays(member,round,[round.dates[3]],{status:'unavailable',windows:[]});
  assert.throws(()=>confirmSubmission(member,round),/review/);
  member.reviewedSnapshot=reviewSnapshot(round,member);
  confirmSubmission(member,round);
  assert.equal(member.submitted[tuesday].windows[0].start,'18:00');
  applyDays(member,round,[tuesday],{status:'unavailable',windows:[]});
  assert.equal(member.submitted[tuesday].status,'available','published answers remain unchanged while editing');
});
test('saved usual week applies by weekday without updating the template',()=>{
  const {round,member}=demo();
  for(const date of round.dates) applyDays(member,round,[date],allDay());
  member.reviewedSnapshot=reviewSnapshot(round,member);
  confirmSubmission(member,round);
  const template=templateFromSubmission(round,member);
  assert.equal(Object.keys(template).length,7);
  const next=makeRound(1,DateTime.fromISO('2026-10-10T12:00:00',{zone:'Europe/Amsterdam'}));
  const other=memberOf(next,USER_ID);
  const dates=applyTemplate(other,next,template);
  assert.equal(dates.length,7);
  assert.equal(weekday(next.dates[0]),'Monday');
  applyDays(other,next,[next.dates[0]],{status:'unavailable',windows:[]});
  assert.equal(template.Monday.status,'available');
});
test('preview UI builds native components and a modal with five dropdown fields',()=>{
  const {round,member}=demo();
  const overview=UI.overview(round,member,null);
  assert.equal(overview.embeds,undefined);
  assert.equal(overview.components.length,1);
  assert.equal(overview.flags,64|32768);
  for(const item of overview.components) assert.doesNotThrow(()=>item.toJSON());
  const day=UI.dayView(round,member,round.dates[0]);
  assert.equal(day.components.length,1);
  assert.equal(UI.quickModal(round.id,[round.dates[0]],member).toJSON().components.length,5);
  assert.equal(UI.copyModal(round.id,round,member,round.dates[0]).toJSON().components.length,1);
  const win=UI.windowModal(round.id,round.dates[0],'tentative','12');
  assert.equal(win.toJSON().components.length,5);
  assert.match(JSON.stringify(win.toJSON()),/end of day/);
});
function fakeInteraction(id, kind='button', values=[], roles=[MANAGEMENT,...VERIFIED]){
  const result={replied:null,updated:null,modal:null,followup:null,deferred:false};
  const i={
    guildId:GUILD,channelId:LOG,user:{id:USER_ID},
    member:{id:USER_ID,roles:{cache:{has:id=>roles.includes(id)}}},
    guild:{ownerId:'888888888888888888'},
    customId:id, values, fields:null,
    isModalSubmit:()=>kind==='modal',
    isFromMessage:()=>kind==='modal',
    async reply(v){result.replied=v;},async update(v){result.updated=v;},
    async deferUpdate(){result.deferred=true;},
    async followUp(v){result.followup=v;},async showModal(v){result.modal=v;},

  };
  return {i,result};
}
test('test-only Discord prototype supports a full draft, review, submit, and template workflow',async t=>{
  const preview=createNativePrototype({policy,testMode:true,dataFile:temporaryFile(t)});
  const start=fakeInteraction('', 'button');
  await preview.startPreview(start.i,0);
  assert.match(start.result.replied.embeds[0].toJSON().title,/\[TEST\]/);
  const sid=Object.keys(preview.store.read().rounds)[0];
  const open=fakeInteraction('wbux:open:'+sid);
  await preview.handle(open.i);
  assert.equal(open.result.replied.flags,64|32768);
  const bad=fakeInteraction('wbux:open:'+sid,'button',[],[]);
  await preview.handle(bad.i);
  assert.match(bad.result.replied.content,/eligible/);
  const bulk=fakeInteraction('wbux:bulk:'+sid);
  await preview.handle(bulk.i);
  const dates=preview.store.read().rounds[sid].dates;
  const selected=fakeInteraction('wbux:dates:'+sid+':all','select',dates);
  await preview.handle(selected.i);
  const preset=fakeInteraction('wbux:bulkset:'+sid+':all');
  await preview.handle(preset.i);
  const confirm=fakeInteraction('wbux:apply:'+sid);
  await preview.handle(confirm.i);
  let m=preview.store.read().rounds[sid].members[USER_ID];
  assert.equal(Object.keys(m.draft).length,7);
  assert.equal(m.submitted,null);
  const review=fakeInteraction('wbux:review:'+sid);
  await preview.handle(review.i);
  assert.match(JSON.stringify(review.result.updated.components.map(c=>c.toJSON())),/Review & Submit/);
  const submit=fakeInteraction('wbux:submit:'+sid);
  await preview.handle(submit.i);
  m=preview.store.read().rounds[sid].members[USER_ID];
  assert.ok(m.submitted);
  const templateBtn=fakeInteraction('wbux:template:'+sid);
  await preview.handle(templateBtn.i);
  await preview.handle(fakeInteraction('wbux:apply:'+sid).i);
  assert.equal(Object.keys(preview.store.read().templates[USER_ID]).length,7);
  const monday=dates[0];
  await preview.handle(fakeInteraction('wbux:off:'+sid+':'+monday).i);
  m=preview.store.read().rounds[sid].members[USER_ID];
  assert.equal(m.draft[monday].status,'unavailable');
  assert.equal(m.submitted[monday].status,'available');
  const stale=fakeInteraction('wbux:submit:'+sid);
  await preview.handle(stale.i);
  assert.match(stale.result.replied.content,/review/);
});
test('preview state survives a new store instance',async t=>{
  const f=temporaryFile(t);
  const store=new PreviewStore(f);
  await store.transaction(state=>{state.rounds.test={id:'test',createdAt:'now',dates:[],members:{}};});
  const second=new PreviewStore(f);
  assert.ok(second.read().rounds.test);
});
test('preview is disabled outside TEST mode',()=>{
  assert.throws(()=>createNativePrototype({policy,testMode:false,dataFile:'do-not-create.json'}),/TEST mode/);
});

test('weekly editor remains the same native Components V2 surface for common edits',async t=>{
  const preview=createNativePrototype({policy,testMode:true,dataFile:temporaryFile(t)});
  await preview.startPreview(fakeInteraction('').i);
  const sid=Object.keys(preview.store.read().rounds)[0];
  const dates=preview.store.read().rounds[sid].dates;

  // Opening a date opens a modal immediately, without replacing the week.
  const one=fakeInteraction('wbux:jump:'+sid,'select',[dates[0]]);
  await preview.handle(one.i);
  assert.ok(one.result.modal);
  assert.equal(one.result.updated,null);
  assert.equal(one.result.modal.toJSON().components.length,5);
  const fields={quick_status:['tentative'],start_h:['19'],start_m:['30'],
    end_h:['23'],end_m:['00']};
  const saved=fakeInteraction('wbux:quickwin:'+sid+':day:'+dates[0],'modal');
  saved.i.fields={getStringSelectValues:field=>fields[field]||[]};
  await preview.handle(saved.i);
  assert.equal(saved.result.updated.components.length,1,'a single week container is updated');
  assert.equal(preview.store.read().rounds[sid].members[USER_ID].draft[dates[0]].windows[0].kind,'tentative');

  // Selecting multiple days acknowledges quickly without rewriting the interface.
  const datesSelect=fakeInteraction('wbux:selectbulk:'+sid+':all','select',dates.slice(1,4));
  await preview.handle(datesSelect.i);
  assert.equal(datesSelect.result.deferred,true);
  assert.equal(datesSelect.result.updated,null);
  const bulkModal=fakeInteraction('wbux:quickbulk:'+sid);
  await preview.handle(bulkModal.i);
  assert.equal(bulkModal.result.modal.toJSON().components.length,5);
  const bulkFields={quick_status:['confirmed'],start_h:['18'],start_m:['00'],
    end_h:['22'],end_m:['00']};
  const bulkSubmit=fakeInteraction('wbux:quickwin:'+sid+':multi:multi','modal');
  bulkSubmit.i.fields={getStringSelectValues:field=>bulkFields[field]||[]};
  await preview.handle(bulkSubmit.i);
  assert.equal(bulkSubmit.result.updated.components.length,1);
  const m=preview.store.read().rounds[sid].members[USER_ID];
  assert.equal(m.selection.length,0);
  for(const d of dates.slice(1,4)) assert.equal(m.draft[d].windows[0].start,'18:00');
  assert.equal(m.submitted,null);
});
test('one-click multi-day presets and contextual copy keep data in draft',async t=>{
  const preview=createNativePrototype({policy,testMode:true,dataFile:temporaryFile(t)});
  await preview.startPreview(fakeInteraction('').i);
  const sid=Object.keys(preview.store.read().rounds)[0];
  const dates=preview.store.read().rounds[sid].dates;
  await preview.handle(fakeInteraction('wbux:selectbulk:'+sid+':all','select',dates.slice(0,2)).i);
  await preview.handle(fakeInteraction('wbux:bulkfast:'+sid+':all').i);
  const r=preview.store.read().rounds[sid];
  assert.equal(r.members[USER_ID].draft[dates[0]].windows[0].end,'24:00');
  assert.equal(r.members[USER_ID].draft[dates[1]].windows[0].end,'24:00');

  const tools=fakeInteraction('wbux:tools:'+sid);
  await preview.handle(tools.i);
  assert.match(JSON.stringify(tools.result.updated.components.map(c=>c.toJSON())),/More Day Tools/);
  const details=fakeInteraction('wbux:detail:'+sid,'select',[dates[0]]);
  await preview.handle(details.i);
  assert.match(JSON.stringify(details.result.updated.components.map(c=>c.toJSON())),/Current answer/);

  const copy=fakeInteraction('wbux:copy:'+sid+':'+dates[0]);
  await preview.handle(copy.i);
  assert.ok(copy.result.modal,'copy opens a destination picker modal from source day');
  const copied=fakeInteraction('wbux:quickcopy:'+sid+':'+dates[0],'modal');
  copied.i.fields={getStringSelectValues:()=>dates.slice(2,5)};
  await preview.handle(copied.i);
  assert.match(JSON.stringify(copied.result.updated.components.map(c=>c.toJSON())),/Review Changes/);
  await preview.handle(fakeInteraction('wbux:apply:'+sid).i);
  const m=preview.store.read().rounds[sid].members[USER_ID];
  for(const d of dates.slice(2,5)) assert.equal(m.draft[d].windows[0].end,'24:00');
  assert.equal(m.submitted,null,'copy never bypasses final review');
});
test('weekly overview groups controls below their instructions with stable ordering',()=>{
  const {round,member}=demo();
  const data=UI.overview(round,member,null).components[0].toJSON();
  const parts=data.components;
  const texts=parts.filter(c=>c.type===10).map(c=>c.content);
  assert.ok(texts.some(s=>s.includes('Edit several days at once')));
  assert.ok(texts.some(s=>s.includes('Or edit one day')));
  const firstSelectIndex=parts.findIndex(c=>c.type===1&&
    c.components?.some(v=>v.custom_id?.startsWith('wbux:selectbulk:')));
  const secondSelectIndex=parts.findIndex(c=>c.type===1&&
    c.components?.some(v=>v.custom_id?.startsWith('wbux:jump:')));
  assert.ok(firstSelectIndex>0&&secondSelectIndex>firstSelectIndex);
  assert.equal(data.type,17,'single stable V2 container');
  assert.equal(parts.filter(c=>c.type===1).length,5,'five Discord action rows maximum');
});
