'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createActivityWeeklyUx}=require('../src/scheduling/activityWeeklyUx');

const USER='998877665544332211',OTHER='887766554433221199';
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-weekly-activity-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return createActivityWeeklyUx({dataFile:path.join(dir,'ux.json'),
    now:()=>new Date('2026-10-11T11:00:00Z')});
}
const available=(start='18:00',end='23:00',kind='confirmed')=>({
  status:'available',windows:[{start,end,kind,maxMinutes:null}],
});
test('fresh Activity UX has seven next-week days and no submitted data',async t=>{
  const ux=fixture(t);
  const s=await ux.read(USER);
  assert.equal(s.round.dates.length,7);
  assert.deepEqual(s.round.dates,['2026-10-12','2026-10-13','2026-10-14',
    '2026-10-15','2026-10-16','2026-10-17','2026-10-18']);
  assert.equal(s.progress.answered,0);
  assert.equal(s.member.submitted,null);
  assert.equal(s.template,null);
  assert.equal(s.sandbox,true);
});
test('background draft edits are persistent; review and explicit submit are mandatory',async t=>{
  const ux=fixture(t);
  const dates=(await ux.read(USER)).round.dates;
  const changes=dates.map((date,i)=>({date,...(i===5?{status:'unavailable',windows:[]}:available())}));
  await ux.mutate(USER,'draft',{days:changes});
  assert.equal((await ux.read(USER)).progress.answered,7);
  await assert.rejects(()=>ux.mutate(USER,'submit',{confirm:true}),/review/);
  await ux.mutate(USER,'review',{confirmReview:true});
  const result=await ux.mutate(USER,'submit',{confirm:true});
  assert.ok(result.member.submittedAt);
  assert.equal(result.member.submitted[dates[5]].status,'unavailable');
  assert.equal((await ux.read(OTHER)).progress.answered,0);
  const uxReloaded=createActivityWeeklyUx({dataFile:ux.store.file,
    now:()=>new Date('2026-10-11T11:00:00Z')});
  assert.equal((await uxReloaded.read(USER)).member.submitted[dates[5]].status,'unavailable');

  // A changed draft must not replace the previously submitted answer.
  await ux.mutate(USER,'draft',{days:[{date:dates[5],...available('20:00','22:00')}]});
  assert.equal((await ux.read(USER)).member.submitted[dates[5]].status,'unavailable');
  await assert.rejects(()=>ux.mutate(USER,'submit',{confirm:true}),/review/);
  await ux.mutate(USER,'review',{confirmReview:true});
  await ux.mutate(USER,'submit',{confirm:true});
  assert.equal((await ux.read(USER)).member.submitted[dates[5]].status,'available');
});
test('a mixed confirmed/tentative day is validated without touching unrelated days',async t=>{
  const ux=fixture(t);
  const dates=(await ux.read(USER)).round.dates;
  const day={status:'available',windows:[
    {start:'18:00',end:'21:00',kind:'confirmed',maxMinutes:120},
    {start:'21:00',end:'23:00',kind:'tentative',maxMinutes:null},
  ]};
  await ux.mutate(USER,'draft',{days:[{date:dates[0],...day}]});
  const result=await ux.read(USER);
  assert.equal(result.member.draft[dates[0]].windows[1].kind,'tentative');
  await assert.rejects(()=>ux.mutate(USER,'draft',{days:[{
    date:dates[1],status:'available',windows:[
      {start:'18:00',end:'21:00',kind:'confirmed'},
      {start:'20:00',end:'23:00',kind:'tentative'},
    ],
  }]}),/overlap/);
  assert.equal((await ux.read(USER)).member.draft[dates[1]],undefined);
  await assert.rejects(()=>ux.mutate(USER,'draft',{days:[{date:dates[1],
    ...available('19:07','23:00')}]}),/five-minute/);
  assert.equal((await ux.read(USER)).member.draft[dates[0]].windows.length,2);
});
test('weekly template stays independent of a specific week and supports next-week reuse',async t=>{
  const ux=fixture(t);
  const dates=(await ux.read(USER)).round.dates;
  await ux.mutate(USER,'draft',{days:dates.map(date=>({date,...available()}))});
  await ux.mutate(USER,'review',{confirmReview:true});
  await ux.mutate(USER,'submit',{confirm:true});
  await assert.rejects(()=>ux.mutate(USER,'template-save',{}),/Confirm/);
  const saved=await ux.mutate(USER,'template-save',{confirm:true});
  assert.equal(Object.keys(saved.template).length,7);
  const monday=saved.template.Monday.windows[0].start;
  await ux.advanceWeek();
  const week2=await ux.read(USER);
  assert.equal(week2.progress.answered,0);
  assert.ok(week2.template);
  const applied=await ux.mutate(USER,'template-apply',{confirm:true});
  assert.equal(applied.progress.answered,7);
  await ux.mutate(USER,'draft',{days:[{date:applied.round.dates[0],status:'unavailable',windows:[]}]});
  assert.equal((await ux.read(USER)).template.Monday.windows[0].start,monday);
  assert.equal((await ux.read(USER)).template.Monday.status,'available');
});
test('draft rejects unknown dates, duplicate dates and unrequested submissions',async t=>{
  const ux=fixture(t);
  const dates=(await ux.read(USER)).round.dates;
  await assert.rejects(()=>ux.mutate(USER,'draft',{days:[
    {date:dates[0],...available()},
    {date:dates[0],...available()},
  ]}),/once/);
  await assert.rejects(()=>ux.mutate(USER,'draft',{days:[{
    date:'2027-01-01',...available(),
  }]}),/invalid/);
  await assert.rejects(()=>ux.mutate(USER,'submit',{confirm:false}),/confirmation/);
  await assert.rejects(()=>ux.mutate(USER,'template-apply',{confirm:true}),/No saved usual week/);
  assert.equal((await ux.read(USER)).progress.answered,0);
});
