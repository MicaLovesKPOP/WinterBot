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

test('moderator day-hour bounds are exposed and enforced by the test backend',async t=>{
  const ux=fixture(t);
  const date=(await ux.read(USER)).round.dates[0];
  await ux.store.transaction(state=>{
    state.rounds.weekly.allowedHoursByDate={
      [date]:{start:'17:00',end:'22:00'},
    };
  });
  const state=await ux.read(USER);
  assert.deepEqual(state.round.allowedHoursByDate[date],
    {start:'17:00',end:'22:00'});
  await assert.rejects(()=>ux.mutate(USER,'draft',{days:[
    {date,...available('16:00','20:00')},
  ]}),/allowed hours/);
  await assert.rejects(()=>ux.mutate(USER,'draft',{days:[
    {date,...available('20:00','24:00')},
  ]}),/allowed hours/);
  await ux.mutate(USER,'draft',{days:[
    {date,...available('17:30','22:00')},
  ]});
  assert.equal((await ux.read(USER)).member.draft[date].windows[0].end,'22:00');
  assert.equal((await ux.read(OTHER)).progress.answered,0);
  // A saved usual-week template must not bypass a new moderator restriction.
  await ux.store.transaction(state=>{
    state.templates[USER]={Monday:available('00:00','24:00')};
  });
  await assert.rejects(()=>ux.mutate(USER,'template-apply',{confirm:true}),/allowed hours/);
  assert.equal((await ux.read(USER)).member.draft[date].windows[0].start,'17:30');
});

test('discard-revision restores the previous submission, not merely the visible editor',async t=>{
  const ux=fixture(t);
  const dates=(await ux.read(USER)).round.dates;
  await ux.mutate(USER,'draft',{days:dates.map(date=>({date,...available('18:00','21:00')}))});
  await ux.mutate(USER,'review',{confirmReview:true});
  await ux.mutate(USER,'submit',{confirm:true});
  const original=(await ux.read(USER)).member.submitted;
  await ux.mutate(USER,'draft',{days:[
    {date:dates[0],...available('09:00','11:00','tentative')},
    {date:dates[1],status:'unavailable',windows:[]},
  ]});
  await assert.rejects(()=>ux.mutate(USER,'discard-revision',{}),/Confirm/);
  const before=await ux.read(USER);
  assert.equal(before.member.submitted[dates[0]].windows[0].start,'18:00');
  assert.equal(before.member.draft[dates[0]].windows[0].start,'09:00');
  const discarded=await ux.mutate(USER,'discard-revision',{confirm:true});
  assert.deepEqual(discarded.member.draft,original);
  assert.deepEqual(discarded.member.submitted,original);
  await assert.rejects(()=>ux.mutate(OTHER,'discard-revision',{confirm:true}),/no submitted week/i);
  const reloaded=createActivityWeeklyUx({dataFile:ux.store.file});
  assert.deepEqual((await reloaded.read(USER)).member.draft,original);
});

test('editable usual week is independent, can be partial and never changes the submitted round',async t=>{
  const ux=fixture(t);
  const dates=(await ux.read(USER)).round.dates;
  await ux.mutate(USER,'draft',{days:dates.map(date=>({date,...available()}))});
  await ux.mutate(USER,'review',{confirmReview:true});
  await ux.mutate(USER,'submit',{confirm:true});
  const submitted=(await ux.read(USER)).member.submitted;
  const usual={
    Monday:available('08:00','12:00'),
    Tuesday:available('13:00','17:00','tentative'),
    Friday:{status:'unavailable',windows:[]},
  };
  await assert.rejects(()=>ux.mutate(USER,'template-update',{days:usual}),/Confirm/);
  await assert.rejects(()=>ux.mutate(USER,'template-update',{confirm:true,days:{
    Funday:available(),
  }}),/weekdays/);
  await assert.rejects(()=>ux.mutate(USER,'template-update',{confirm:true,days:{}}),/weekdays/);
  const updated=await ux.mutate(USER,'template-update',{confirm:true,days:usual});
  assert.deepEqual(updated.template,usual);
  assert.deepEqual(updated.member.draft,submitted);
  assert.deepEqual(updated.member.submitted,submitted);
  const next=await ux.advanceWeek();
  const applied=await ux.mutate(USER,'template-apply',{confirm:true});
  assert.equal(applied.member.draft[next.dates[0]].windows[0].start,'08:00');
  assert.equal(applied.member.draft[next.dates[1]].windows[0].kind,'tentative');
  assert.equal(applied.member.draft[next.dates[4]].status,'unavailable');
  assert.equal(applied.member.draft[next.dates[2]],undefined,
    'Unanswered template weekdays must not be invented as Available');
  const reloaded=createActivityWeeklyUx({dataFile:ux.store.file});
  assert.deepEqual((await reloaded.read(USER)).template,usual);
});
