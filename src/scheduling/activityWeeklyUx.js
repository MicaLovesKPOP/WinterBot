'use strict';

// Seven-day, strictly test-only Activity UX state. It deliberately does not
// touch the existing main scheduler's round, roles, publications or channels.
const path=require('node:path');
const {DateTime}=require('luxon');
const {
  PreviewStore,makeRound,memberOf,normalizedDay,applyDays,
  applyTemplate,confirmSubmission,templateFromSubmission,reviewSnapshot,
  isComplete,assert,
}=require('./nativePrototypeState');

function toMinute(value){
  if(value==='24:00')return 1440;
  assert(typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value),
    'Invalid allowed-hours restriction.');
  const [h,m]=value.split(':').map(Number);
  return h*60+m;
}
function createActivityWeeklyUx({dataFile,now=()=>new Date()}={}) {
  const file=dataFile||path.join(process.cwd(),'scheduling-activity-weekly-ux.json');
  const store=new PreviewStore(file);
  const key='weekly';

  function newWeek(base=null){
    const dt=base?DateTime.fromISO(base).setZone('Europe/Amsterdam').plus({days:1}):
      DateTime.fromJSDate(now()).setZone('Europe/Amsterdam');
    return makeRound(0,dt);
  }
  function assertAllowed(round,date,day){
    const limits=round.allowedHoursByDate?.[date];
    if(day?.status!=='available'||!limits)return;
    const allowed=(Array.isArray(limits)?limits:[limits]).map(w=>({
      start:toMinute(w.start),end:toMinute(w.end),
    }));
    for(const w of day.windows){
      const start=toMinute(w.start),end=toMinute(w.end);
      assert(allowed.some(l=>start>=l.start&&end<=l.end),
        'Availability must remain inside the allowed hours for '+date+'.');
    }
  }
  async function ensureWeek(){
    if(store.read().rounds[key]) return;
    await store.transaction(state=>{ if(!state.rounds[key]) state.rounds[key]=newWeek(); });
  }
  function present(state,userId) {
    const round=state.rounds[key];
    assert(round,'The test week is unavailable.');
    const m=round.members[userId]||{draft:{}};
    return {
      sandbox:true,
      round:{id:round.id,title:'Weekly Game Night',dates:[...round.dates],
        timezone:round.timezone,
        allowedHoursByDate:structuredClone(round.allowedHoursByDate||{})},
      member:{draft:structuredClone(m.draft||{}),
        submitted:structuredClone(m.submitted||null),
        submittedAt:m.submittedAt||null,clockFormat:m.clockFormat||'24'},
      template:structuredClone(state.templates[userId]||null),
      progress:{answered:round.dates.filter(d=>m.draft?.[d]).length,total:round.dates.length,
        reviewed:m.reviewedSnapshot===reviewSnapshot(round,m),complete:isComplete(round,m)},
    };
  }
  async function read(userId){
    await ensureWeek();
    return present(store.read(),String(userId));
  }
  async function mutate(userId,action,body={}) {
    await ensureWeek();
    let result;
    await store.transaction(state=>{
      const round=state.rounds[key];
      const member=memberOf(round,String(userId));
      if(action==='draft') {
        assert(Array.isArray(body.days)&&body.days.length>=1&&body.days.length<=7,
          'Choose between one and seven valid dates.');
        const unique=new Set();
        for(const change of body.days){
          assert(change&&round.dates.includes(change.date)&&!unique.has(change.date),
            'A date is invalid or included more than once.');
          unique.add(change.date);
          let day=null;
          if(change.status!=='unanswered'&&change.status!==null)
            day=normalizedDay(change);
          assertAllowed(round,change.date,day);
          applyDays(member,round,[change.date],day);
        }
      } else if(action==='review') {
        assert(body.confirmReview===true,'Open the review before submitting.');
        member.reviewedSnapshot=reviewSnapshot(round,member);
      } else if(action==='submit') {
        assert(body.confirm===true,'Explicit confirmation is required.');
        for(const date of round.dates)assertAllowed(round,date,member.draft[date]);
        confirmSubmission(member,round);
      } else if(action==='template-save') {
        assert(body.confirm===true,'Confirm the weekly template update.');
        state.templates[userId]=templateFromSubmission(round,member);
      } else if(action==='template-apply') {
        assert(body.confirm===true,'Confirm before applying your usual week.');
        applyTemplate(member,round,state.templates[userId]);
        for(const date of round.dates)assertAllowed(round,date,member.draft[date]);
      } else if(action==='preference') {
        assert(body.clock==='12'||body.clock==='24','Clock format must be 12h or 24h.');
        member.clockFormat=body.clock;
      } else throw new Error('Unknown weekly Activity operation.');
      result=present(state,String(userId));
    });
    return result;
  }
  async function advanceWeek(){
    await ensureWeek();
    await store.transaction(state=>{
      const old=state.rounds[key];
      state.rounds[key]=newWeek(old?.dates[0]);
    });
    return store.read().rounds[key];
  }
  async function reset(){
    await store.transaction(state=>{
      state.rounds={};state.templates={};
    });
    await ensureWeek();
  }
  return {read,mutate,advanceWeek,reset,store};
}
module.exports={createActivityWeeklyUx};
