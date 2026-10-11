import { DiscordSDK, RPCCloseCodes } from '@discord/embedded-app-sdk';

// Focused, isolated Activity UX pilot. Unlike message components, calendar
// interaction is entirely client-side; server writes happen in the background.
const root=document.getElementById('app');
let model=null;
let selectedDay=null;
let multi=false;
let chosen=new Set();
let batch={kind:'confirmed',start:null,end:null,mode:'hours'};
let view='week';
let popup=null;
let notice='';
let noticeError=false;
let saving=false;
let saveTimer=null;
let dirty=new Map();
let reviewReady=false;
let reviewSeenBottom=false;
let errorSaving=false;
let preferenceClock='24';
let discordSdk=null;
let templateDraft={};
let templateReturnView='week';
let templateOrigin='blank';
let templateSeenBottom=false;
let templateBusy=false;

const icon={
  check:'✓', unsure:'?', off:'×', empty:'·', arrow:'›', copy:'⧉',
};
function esc(value){
  return String(value??'').replace(/[&<>"']/g,ch=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  })[ch]);
}
function minutes(value){
  if(value==='24:00')return 1440;
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)))return NaN;
  const [h,m]=value.split(':').map(Number);
  return h*60+m;
}
function clock(m){return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');}
function formatTime(value){
  if(preferenceClock==='24')return value;
  if(value==='24:00')return '12:00 AM (end of day)';
  const h=Number(value.slice(0,2));
  return String(h%12||12)+value.slice(2)+(h<12?' AM':' PM');
}
function datestring(date,style='long'){
  const d=new Date(date+'T12:00:00Z');
  return new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',
    weekday:style==='mini'?'short':'long',
    month:style==='mini'?'short':'long',day:'numeric'}).format(d);
}
function weekday(date){
  return new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',weekday:'long'})
    .format(new Date(date+'T12:00:00Z'));
}
function inTemplate(){return view==='template'||view==='template-review';}
function draftForWeekdays(source){
  const answers={};
  if(!source)return answers;
  for(const date of model.round.dates){
    const day=source[date]||source[weekday(date)];
    if(day)answers[date]=copy(day);
  }
  return answers;
}
function dayEntry(date){return (inTemplate()?templateDraft:model.member.draft)[date]||null;}
function hasRevision(){return Boolean(model?.member?.submitted&&
  JSON.stringify(model.member.draft)!==JSON.stringify(model.member.submitted));}
function copy(value){return structuredClone(value);}
function validateDay(raw){
  if(!raw||raw.status==='unanswered')return null;
  if(raw.status==='unavailable')return {status:'unavailable',windows:[]};
  if(raw.status!=='available'||!Array.isArray(raw.windows)||
      raw.windows.length<1||raw.windows.length>10)throw Error('Add between one and ten time ranges.');
  const windows=raw.windows.map(w=>{
    const start=minutes(w.start),end=minutes(w.end),kind=w.kind||'confirmed';
    if(!Number.isFinite(start)||!Number.isFinite(end)||
      start>=end||start<0||end>1440||start%5!==0||end%5!==0)
      throw Error('Each time range must be valid, increasing and use 5-minute steps.');
    if(!['confirmed','tentative'].includes(kind))throw Error('Unknown availability type.');
    const max=w.maxMinutes==null?null:Number(w.maxMinutes);
    if(max!==null&&(!Number.isInteger(max)||max<5||max>end-start||max%5!==0))
      throw Error('Maximum stay must fit inside that time range.');
    return {start:w.start,end:w.end,kind,maxMinutes:max};
  }).sort((a,b)=>minutes(a.start)-minutes(b.start));
  for(let i=1;i<windows.length;i++)if(minutes(windows[i].start)<minutes(windows[i-1].end))
    throw Error('Time ranges cannot overlap. Adjust or remove one of them.');
  return {status:'available',windows};
}
function allDay(kind='confirmed'){
  return {status:'available',windows:[{kind,start:'00:00',end:'24:00',maxMinutes:null}]};
}
function allPermittedDay(date,kind='confirmed'){
  const limits=inTemplate()?null:model?.round?.allowedHoursByDate?.[date];
  if(!limits)return allDay(kind);
  const ranges=Array.isArray(limits)?limits:[limits];
  return validateDay({status:'available',windows:ranges.map(w=>({
    start:w.start,end:w.end,kind,maxMinutes:null,
  }))});
}
function summary(day){
  if(!day)return 'Not answered';
  if(day.status==='unavailable')return 'Unavailable';
  return day.windows.map(w=>{
    const duration=w.start==='00:00'&&w.end==='24:00'?'All day':
      formatTime(w.start)+'–'+formatTime(w.end);
    return duration+(w.kind==='tentative'?' (tentative)':'')+
      (w.maxMinutes?' · max '+w.maxMinutes+'m':'');
  }).join('  ·  ');
}
function dayKind(day){
  if(!day)return 'empty';
  if(day.status==='unavailable')return 'off';
  if(day.windows.every(w=>w.kind==='tentative'))return 'unsure';
  if(day.windows.some(w=>w.kind==='tentative'))return 'mixed';
  return 'yes';
}
function makeButton(text,action,cls='',extra=''){
  return '<button type="button" class="button '+cls+'" data-action="'+action+'" '+extra+'>'+esc(text)+'</button>';
}
function saveLabel(){
  if(inTemplate())return 'Template changes not saved yet';
  if(errorSaving)return 'Could not save · Retry';
  if(saving||dirty.size)return 'Saving draft…';
  return model?.member?.submittedAt?'Draft saved':'Saved as draft';
}
function setAlert(value,isError=false){notice=value;noticeError=isError;render();}
function changeDay(date,day,renderNow=true){
  const normalized=validateDay(day);
  if(inTemplate()){
    if(normalized)templateDraft[date]=normalized;
    else delete templateDraft[date];
    if(renderNow)render();
    return;
  }
  if(normalized)model.member.draft[date]=normalized;
  else delete model.member.draft[date];
  model.progress.reviewed=false;
  const payload=normalized?{date,...copy(normalized)}:{date,status:'unanswered'};
  dirty.set(date,payload);
  errorSaving=false;
  scheduleSave();
  if(renderNow)render();
}
function changeDays(changes){
  if(inTemplate()){
    for(const {date,day} of changes){
      const normalized=validateDay(day);
      if(normalized)templateDraft[date]=copy(normalized);
      else delete templateDraft[date];
    }
    render();
    return;
  }
  for(const {date,day} of changes){
    const normalized=validateDay(day);
    if(normalized)model.member.draft[date]=copy(normalized);
    else delete model.member.draft[date];
    dirty.set(date,normalized?{date,...copy(normalized)}:{date,status:'unanswered'});
  }
  model.progress.reviewed=false;
  errorSaving=false;
  scheduleSave();
  render();
}
function changeMany(dates,day){
  changeDays(dates.map(date=>({date,day})));
}
function stageHeader(){
  const dates=model.round.dates;
  const answered=dates.filter(d=>dayEntry(d)).length;
  const pct=Math.round(answered/dates.length*100);
  return '<header class="mast"><div class="brand-lockup">'+
    '<div class="brand-symbol" aria-hidden="true"><span>W</span></div>'+
    '<div><p class="eyebrow">WINTERBOT / COMMUNITY SCHEDULING</p>'+
    '<div class="brand-name">'+(inTemplate()?'Your usual week':'Your availability')+'</div></div></div>'+
    '<div class="mast-actions"><span class="environment-tag">TEST ACTIVITY</span>'+
    makeButton('Exit','exit-activity','exit-button','aria-label="Exit WinterBot Activity"')+
    '</div></header>'+
    '<section class="hero"><div class="hero-copy"><p class="eyebrow">GAME NIGHT · '+esc(model.round.timezone)+'</p>'+
    '<h1>'+(inTemplate()?'Repeats every week':
      esc(datestring(dates[0],'mini'))+' – '+esc(datestring(dates.at(-1),'mini')))+'</h1>'+
    '<p>'+(inTemplate()?'Independent of your submitted availability.':
      'Pick your days, adjust your hours and review before submitting.')+'</p></div>'+
    '<div class="progress-panel"><div class="progress-top"><strong>'+answered+' <span>/ '+dates.length+'</span></strong>'+
    '<span>'+(inTemplate()?'weekdays set':'days answered')+'</span></div><div class="progress-track"><div class="progress-fill" style="width:'+pct+'%"></div></div>'+
    '<div class="save-indicator'+(errorSaving?' error':'')+'" data-role="save" role="status">'+esc(saveLabel())+'</div>'+
    '<button type="button" class="retry-save" data-action="retry"'+(errorSaving?'':' hidden')+'>Retry saving</button></div>'+
    '</section>';
}
function dayCards(){
  return model.round.dates.map(date=>{
    const item=dayEntry(date),kind=dayKind(item),isActive=selectedDay===date&&!multi;
    const chosenHere=chosen.has(date);
    const chosenClass=multi&&chosenHere?' is-chosen':'';
    const iso=new Date(date+'T12:00:00Z');
    const day=iso.toLocaleDateString('en-GB',{weekday:'short',timeZone:'UTC'});
    const n=inTemplate()?day:iso.toLocaleDateString('en-GB',{day:'numeric',timeZone:'UTC'});
    const mark=kind==='yes'?icon.check:kind==='mixed'?'◒':kind==='unsure'?icon.unsure:kind==='off'?icon.off:icon.empty;
    const status=kind==='yes'?'Available':kind==='mixed'?'Mixed':kind==='unsure'?'Tentative':
      kind==='off'?'Unavailable':'Not set';
    return '<button type="button" class="day-card state-'+kind+
      (inTemplate()?' template-day':'')+
      (isActive?' is-active':'')+chosenClass+'" data-action="pick-day" data-date="'+date+
      '" aria-pressed="'+(multi?chosenHere:isActive)+
      '" aria-label="'+esc(datestring(date)+': '+status)+
      '" title="'+esc(datestring(date)+': '+status)+'">'+
      '<div class="day-head"><span>'+esc(day)+'</span><span class="day-mark">'+mark+'</span></div>'+
      '<strong>'+esc(n)+'</strong><span class="day-status">'+status+'</span></button>';
  }).join('');
}
function weekCard(){
  return '<section class="week-section" aria-label="Weekly dates">'+
    '<div class="section-title"><div><h2>'+
    (inTemplate()?'Weekly template':'Your week')+'</h2></div></div>'+
    '<div class="week-mode-toggle" role="group" aria-label="Availability editing mode">'+
    '<button type="button" data-action="mode-single" aria-pressed="'+!multi+'"'+
    ' class="mode-button'+(!multi?' active':'')+'">Single day</button>'+
    '<button type="button" data-action="multi" aria-pressed="'+multi+'"'+
    ' class="mode-button'+(multi?' active':'')+'">Multiple days'+
    (multi&&chosen.size?' ('+chosen.size+')':'')+'</button></div>'+
    '<div class="week-grid">'+dayCards()+'</div>'+
    '<div class="week-template-actions">'+
    (inTemplate()?'<span class="template-scope-label">Template only · Event unaffected</span>':
      makeButton(model.template?'Edit usual week':'Create usual week',
        'open-template','outline template-entry')+
      (model.template?makeButton('Reuse','reuse','minor','title="Reuse saved weekly template"'):''))+
    '</div></section>';
}
function intervalIntersection(a,b){
  const result=[];
  for(const [as,ae] of a)for(const [bs,be] of b){
    const start=Math.max(as,bs),end=Math.min(ae,be);
    if(end-start>=5)result.push([start,end]);
  }
  return result;
}
function freeClockIntervals(spec) {
  const dates=spec.source==='batch'?model.round.dates.filter(d=>chosen.has(d)):[spec.date];
  let shared=[[0,1440]];
  for(const date of dates) {
    const restriction=inTemplate()?null:model.round.allowedHoursByDate?.[date];
    const permitted=(Array.isArray(restriction)?restriction:
      restriction?[restriction]:[{start:'00:00',end:'24:00'}])
      .map(w=>[minutes(w.start),minutes(w.end)])
      .filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b-a>=5);
    let ranges=permitted;
    const entry=dayEntry(date);
    if(spec.source!=='batch'&&entry?.status==='available'){
      entry.windows.forEach((w,i)=>{
        if(spec.source==='single'&&i===spec.index)return;
        const busyStart=minutes(w.start),busyEnd=minutes(w.end);
        ranges=ranges.flatMap(([a,b])=>{
          if(b<=busyStart||a>=busyEnd)return [[a,b]];
          const free=[];
          if(busyStart-a>=5)free.push([a,busyStart]);
          if(b-busyEnd>=5)free.push([busyEnd,b]);
          return free;
        });
      });
    }
    shared=intervalIntersection(shared,ranges);
  }
  return shared;
}
function timeRail(windows){
  const ticks=[0,6,12,18,24].map(h=>
    '<span style="left:'+h/24*100+'%">'+String(h).padStart(2,'0')+':00</span>').join('');
  const segments=(windows||[]).map(w=>{
    const begin=minutes(w.start),end=minutes(w.end);
    return '<div class="timeline-segment '+(w.kind==='tentative'?'tentative':'confirmed')+
      '" style="left:'+(begin/1440*100)+'%;width:'+((end-begin)/1440*100)+'%" title="'+
      esc(summary({status:'available',windows:[w]}))+'"></div>';
  }).join('');
  return '<div class="time-visual" aria-label="Visual timeline for the selected day">'+
    '<div class="time-track">'+segments+'</div><div class="time-ticks">'+ticks+'</div></div>';
}
function statusText(day) {
  if(!day)return '<div class="review-time-labels"><span class="status-label empty">Not answered</span></div>';
  if(day.status==='unavailable')return '<div class="review-time-labels"><span class="status-label unavailable">Unavailable</span></div>';
  return '<div class="review-time-labels">'+day.windows.map(w=>{
    const all=w.start==='00:00'&&w.end==='24:00';
    const time=all?'All day':formatTime(w.start)+'–'+formatTime(w.end);
    return '<span class="status-label '+(w.kind==='tentative'?'tentative':'confirmed')+'">'+
      esc(time)+(w.kind==='tentative'?' (tentative)':'')+
      (w.maxMinutes?' · max '+w.maxMinutes+'m':'')+'</span>';
  }).join('')+'</div>';
}
function miniTimeBar(day){
  let segments='';
  if(day?.status==='unavailable')segments='<span class="bar-segment unavailable" style="left:0;width:100%"></span>';
  else if(day?.status==='available')segments=day.windows.map(w=>{
    const a=minutes(w.start),b=minutes(w.end);
    return '<span class="bar-segment '+w.kind+'" style="left:'+(a/1440*100)+
      '%;width:'+((b-a)/1440*100)+'%" title="'+esc(summary({status:'available',windows:[w]}))+'"></span>';
  }).join('');
  return '<div class="mini-time-bar '+(!day?'unanswered':day.status==='unavailable'?'fully-unavailable':'')+'" role="img" aria-label="'+
    esc(summary(day))+ '">'+segments+'</div>';
}
function statusWithBar(day){
  return '<div class="review-summary">'+statusText(day)+miniTimeBar(day)+'</div>';
}
function timeInput(date,index,field,value){
  const label=field==='start'?'From':'Until';
  const shown=value==null?'Choose time':value==='24:00'?
    (preferenceClock==='12'?'12:00 AM · End':'24:00 · End'):formatTime(value);
  return '<button type="button" class="clock-trigger" data-action="edit-range"'+
    ' data-index="'+index+'" data-which="'+field+'"'+
    ' aria-label="Edit '+label.toLowerCase()+' time, '+esc(shown)+'">'+
    '<span>'+esc(shown)+'</span>'+
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"'+
    ' fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">'+
    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></button>';
}
function durationOptions(current){
  const options=[{value:'',text:'No limit'}];
  for(const m of [30,60,90,120,150,180,240,300,360,480,600,720]){
    options.push({value:String(m),text:m%60===0?(m/60)+'h':Math.floor(m/60)+'h '+m%60+'m'});
  }
  if(current!=null&&!options.some(x=>x.value===String(current)))
    options.push({value:String(current),text:String(current)+' min'});
  return options.map(o=>'<option value="'+o.value+'"'+
    (String(current??'')===o.value?' selected':'')+'>'+o.text+'</option>').join('');
}
function windowEditor(date,day,index,w){
  return '<article class="range-row"><div class="range-top">'+
    '<div class="range-tag '+w.kind+'">'+(w.kind==='tentative'?'Tentative hours':'Available hours')+'</div>'+
    '<div class="range-actions">'+
    makeButton(w.kind==='tentative'?'Mark available':'Mark tentative','toggle-kind','minor',
      'data-index="'+index+'" aria-label="Change certainty for window '+(index+1)+'"')+
    '<button type="button" class="icon-button" data-action="remove-window" data-index="'+index+'" aria-label="Remove window '+(index+1)+'">Remove</button>'+
    '</div></div><div class="range-grid">'+
    '<div class="field"><label>From</label>'+timeInput(date,index,'start',w.start)+'</div>'+
    '<div class="field"><label>Until</label>'+timeInput(date,index,'end',w.end)+'</div>'+
    '<div class="field"><label>Max. stay</label><select data-date="'+date+'" data-index="'+index+
    '" data-field="maxMinutes">'+durationOptions(w.maxMinutes)+'</select></div></div></article>';
}
function addWindowPlaceholder(first=false,disabled=false){
  return '<button type="button" data-action="add-window" class="window-placeholder"'+
    (disabled?' disabled':'')+'><span class="placeholder-plus" aria-hidden="true">+</span>'+
    '<span><strong>'+(first?'Add availability':'Add another time window')+'</strong>'+
    '<small>'+(disabled?'No unused permitted hours remain':
      'Choose From and Until on the clock')+'</small></span></button>';
}
function singleEditor(){
  const date=selectedDay||model.round.dates[0],entry=dayEntry(date);
  const kind=entry?.status==='available'?'hours':entry?.status==='unavailable'?'off':'none';
  const isTentative=entry?.status==='available'&&entry.windows.every(w=>w.kind==='tentative');
  const hasTentative=entry?.status==='available'&&entry.windows.some(w=>w.kind==='tentative');
  const badge=kind==='hours'?(isTentative?'Tentative':hasTentative?'Mixed availability':'Available'):
    kind==='off'?'Unavailable':'Not answered';
  const title='<div class="editor-heading"><div><p class="eyebrow">STEP 2 · EDIT DAY</p><h2>'+
    esc(inTemplate()?weekday(date):datestring(date))+'</h2></div><span class="pill '+dayKind(entry)+'">'+
    esc(badge)+'</span></div>';
  const buttons='<div class="choice-row">'+
    makeButton('All day','all-day','choice'+(entry?.status==='available'&&
      entry.windows.length===1&&entry.windows[0].start==='00:00'&&
      entry.windows[0].end==='24:00'?' selected':''))+
    makeButton('Unavailable','unavailable','choice'+(kind==='off'?' selected':''))+
    (entry?makeButton('Clear answer','clear-day','minor'):'')+'</div>';
  const header='<div class="day-overview">'+title+buttons+
    (entry?.status==='available'?timeRail(entry.windows):'')+'</div>';
  const canAdd=freeClockIntervals({source:'new',date,index:-2}).some(([a,b])=>b-a>=5);
  let windows='';
  if(entry?.status==='available')
    windows=entry.windows.map((w,i)=>windowEditor(date,entry,i,w)).join('')+
      addWindowPlaceholder(false,!canAdd)+
      '<div class="editor-footer">'+makeButton('Copy this day','copy','outline')+'</div>';
  else windows=addWindowPlaceholder(true,!canAdd)+
    (kind==='off'?'<p class="hint">Adding hours will replace Unavailable for this day.</p>':
      '<p class="hint">Nothing is saved until you choose and apply a range.</p>');
  return '<section class="editor-card day-editor">'+header+
    '<div class="window-list">'+windows+'</div></section>';
}
function batchEditor(){
  const dates=model.round.dates.filter(d=>chosen.has(d));
  const replaced=dates.filter(d=>dayEntry(d)).length;
  const ready=dates.length>0;
  const body='<div class="editor-heading"><div><p class="eyebrow">STEP 2 · BULK EDIT</p><h2>'+
    (ready?'Edit '+dates.length+' selected day(s)':'Choose days in the calendar')+'</h2></div></div>'+
    '<p class="hint">Select days from the calendar, then apply their shared availability. Other days stay unchanged.</p>'+
    (replaced?'<div class="notice-inline">'+replaced+' selected day(s) already have answers. You will review replacements before applying.</div>':'')+
    '<div class="choice-row">'+
    makeButton('Available hours','batch-mode','choice '+(batch.mode==='hours'?'selected':'soft'),'data-mode="hours"')+
    makeButton('All day','batch-mode','choice '+(batch.mode==='all'?'selected':'soft'),'data-mode="all"')+
    makeButton('Unavailable','batch-mode','choice '+(batch.mode==='off'?'selected':'soft'),'data-mode="off"')+
    '</div>'+
    (batch.mode==='hours'?'<div class="batch-fields"><div class="field"><label>From</label>'+
      timeInput(null,-1,'start',batch.start)+'</div>'+
      '<div class="field"><label>Until</label>'+
      timeInput(null,-1,'end',batch.end)+
      '</div><div class="field"><label>Certainty</label>'+
      '<div class="certainty-toggle" role="group" aria-label="Availability certainty">'+
      '<button type="button" class="certainty-choice confirmed'+
        (batch.kind==='confirmed'?' active':'')+'" data-action="batch-kind" data-kind="confirmed"'+
        ' aria-pressed="'+(batch.kind==='confirmed')+'">Available</button>'+
      '<button type="button" class="certainty-choice tentative'+
        (batch.kind==='tentative'?' active':'')+'" data-action="batch-kind" data-kind="tentative"'+
        ' aria-pressed="'+(batch.kind==='tentative')+'">Tentative</button></div></div></div>':'')+
    '<div class="editor-footer">'+makeButton('Apply to '+dates.length+' day(s)','apply-batch','primary',
      ready&&(batch.mode!=='hours'||(batch.start&&batch.end))?'':'disabled')+'</div>';
  return '<section class="editor-card">'+body+'</section>';
}

function reviewPage(){
  const dates=model.round.dates,answered=dates.filter(d=>dayEntry(d)).length;
  const full=answered===dates.length;
  const rows=dates.map(d=>{
    const answer=dayEntry(d),kind=dayKind(answer);
    return '<div class="review-row"><div class="review-date"><span class="status-dot '+kind+'"></span>'+
      '<strong>'+esc(datestring(d,'mini'))+'</strong></div>'+
      statusWithBar(answer)+
      makeButton('Edit','review-edit','minor','data-date="'+d+'"')+'</div>';
  }).join('');
  return '<section class="review-card"><div class="section-title">'+
    '<div><p class="eyebrow">STEP 3</p><h2>Review your availability</h2></div>'+
    '<span class="pill">'+answered+'/'+dates.length+' answered</span></div>'+
    '<p class="hint">Check every day and time before submitting. Only a confirmed submission counts.</p>'+
    '<div class="review-list">'+rows+'</div>'+
    (!full?'<p class="warning-text">'+(dates.length-answered)+' unanswered day(s). Finish them before submitting.</p>':'')+
    '<p class="review-scroll-hint" data-role="review-scroll" hidden>Scroll through all dates to enable submission.</p>'+
    '<div class="bottom-actions">'+makeButton('Back to editing','back','outline')+
    (model.member.submitted?makeButton('Cancel editing','exit-revision','outline'):'')+
    makeButton('Confirm & submit','submit','primary',full&&!errorSaving&&!dirty.size&&reviewReady&&!saving&&reviewSeenBottom?'':'disabled')+
    '</div></section>';
}
function templateReviewPage(){
  const answered=model.round.dates.filter(d=>dayEntry(d)).length;
  const rows=model.round.dates.map(date=>{
    const day=dayEntry(date);
    return '<div class="review-row"><div class="review-date"><span class="status-dot '+
      dayKind(day)+'"></span><strong>'+esc(weekday(date))+'</strong></div>'+
      statusWithBar(day)+
      makeButton('Edit','template-edit-day','minor','data-date="'+date+'"')+'</div>';
  }).join('');
  return '<section class="review-card template-review"><div class="section-title">'+
    '<div><p class="eyebrow">REUSABLE SCHEDULE</p><h2>Review your usual week</h2></div>'+
    '<span class="pill">'+answered+'/7 set</span></div>'+
    '<p class="hint">This saves a reusable starting point, not an event response. Unanswered weekdays will stay blank when reused.</p>'+
    '<div class="review-list">'+rows+'</div>'+
    '<p class="review-scroll-hint" data-role="template-scroll" hidden>Review all weekdays before saving.</p>'+
    '<div class="bottom-actions">'+makeButton('Back to editing','template-review-back','outline')+
    makeButton('Save usual week','template-commit','primary',
      answered>0&&templateSeenBottom&&!templateBusy?'':'disabled')+
    '</div></section>';
}
function templateFooter(){
  const source=templateOrigin==='submitted'?'Prefilled from submitted week':
    templateOrigin==='existing'?'Editing your saved usual week':
    templateOrigin==='draft'?'Prefilled from your current draft':'New blank usual week';
  return '<footer class="action-footer template-footer"><div>'+
    '<strong>Usual week · Not saved</strong><small>'+source+' · Does not change event submission</small></div>'+
    '<div class="footer-buttons">'+
    makeButton('Cancel','template-cancel','outline')+
    makeButton('Reset','template-reset','outline')+
    makeButton('Review template','template-review-open','primary')+'</div></footer>';
}

function donePage(){
  return '<section class="receipt"><div class="receipt-icon" aria-hidden="true">✓</div>'+
    '<p class="eyebrow">SUBMISSION COMPLETE</p><h2>Your week is submitted</h2>'+
    '<p>WinterBot recorded your reviewed availability for this test round. You can update it before collection closes.</p>'+
    '<div class="review-list">'+model.round.dates.map(d=>
      '<div class="review-row"><strong>'+esc(datestring(d,'mini'))+'</strong>'+
      '<span>'+esc(summary(model.member.submitted?.[d]))+'</span></div>').join('')+'</div>'+
    '<div class="bottom-actions">'+makeButton('Edit availability','back','outline')+
    makeButton(model.template?'Edit usual week':'Create usual week','open-template','primary')+
    '</div></section>';
}
function facePoint(value,radius) {
  const angle=2*Math.PI*value/12-Math.PI/2;
  return {x:110+radius*Math.cos(angle),y:110+radius*Math.sin(angle)};
}
function eligibleClockMinute(p,t) {
  const endpoint=p.which;
  if(!Number.isFinite(t))return false;
  if(!p.allowed.some(([a,b])=>endpoint==='start'?
      (t>=a&&t+5<=b):(t>=a+5&&t<=b)))return false;
  const other=endpoint==='end'?'start':'end';
  if(p.touched[other].hour&&p.touched[other].minute&&p[other]){
    const otherMinute=minutes(p[other]);
    if(endpoint==='end'&&t<=otherMinute)return false;
    if(endpoint==='start'&&t>=otherMinute)return false;
    if(!p.allowed.some(([a,b])=>endpoint==='start'?
        (t>=a&&otherMinute<=b&&otherMinute>t):
        (otherMinute>=a&&t<=b&&t>otherMinute)))return false;
  }
  return true;
}
function clockOptionAvailable(p,value) {
  const which=p.which;
  const current=p[which]==='24:00'?'00:00':p[which]||'00:00';
  const existingHour=Number(current.slice(0,2));
  const hour=p.stage==='hour'?
    (preferenceClock==='24'?value:(value%12)+(p.period[which]==='PM'?12:0)):
    existingHour;
  const candidates=p.stage==='hour'?Array.from({length:12},(_,i)=>i*5):[value];
  return candidates.some(m=>{
    const t=which==='end'&&hour===0&&m===0?1440:hour*60+m;
    return eligibleClockMinute(p,t);
  });
}
function clockHeading(p,which){
  const raw=p[which],parts=p.touched[which];
  if(!parts.hour||!raw)return '--:--';
  if(raw==='24:00')return preferenceClock==='12'?'12:00 AM':'24:00';
  const hh=Number(raw.slice(0,2));
  if(!parts.minute)return preferenceClock==='24'?
    String(hh).padStart(2,'0')+':--':
    String(hh%12||12)+':-- '+p.period[which];
  return formatTime(raw);
}
function dialFace(p) {
  const time=p[p.which]==='24:00'?'00:00':p[p.which]||'00:00';
  const hour=Number(time.slice(0,2)),minute=Number(time.slice(3));
  const isHours=p.stage==='hour';
  let options;
  if(!isHours) {
    options=Array.from({length:12},(_,i)=>({
      value:i*5,label:String(i*5).padStart(2,'0'),position:i,radius:88,
      selected:minute===i*5,
    }));
  }else if(preferenceClock==='24'){
    options=[
      ...Array.from({length:12},(_,i)=>({
        value:i||12,label:String(i||12).padStart(2,'0'),position:i,radius:88,
        selected:hour===(i||12),
      })),
      ...Array.from({length:12},(_,i)=>({
        value:i===0?0:i+12,label:String(i===0?0:i+12).padStart(2,'0'),
        position:i,radius:56,inner:true,selected:hour===(i===0?0:i+12),
      })),
    ];
  }else{
    options=Array.from({length:12},(_,i)=>({
      value:i||12,label:String(i||12),position:i,radius:88,
      selected:(hour%12||12)===(i||12),
    }));
  }
  options=options.map(o=>({...o,
    selected:p.touched[p.which][p.stage]&&o.selected,
    disabled:!clockOptionAvailable(p,o.value),
  }));
  const active=options.find(x=>x.selected);
  const point=active?facePoint(active.position,active.radius):{x:110,y:110};
  return '<div class="clock-face" role="group" aria-label="'+
    (isHours?'Choose an hour':'Choose minutes in five-minute steps')+'">'+
    '<svg viewBox="0 0 220 220" aria-hidden="true" class="clock-hand-svg">'+
    (isHours&&preferenceClock==='24'?'<circle cx="110" cy="110" r="56" class="clock-inner-ring"/>':'')+
    '<line x1="110" y1="110" x2="'+point.x.toFixed(1)+'" y2="'+point.y.toFixed(1)+
    '" class="clock-hand"'+(!active?' visibility="hidden"':'')+
    '/><circle cx="110" cy="110" r="4" class="clock-hub"/></svg>'+
    options.map(option=>{
      const pos=facePoint(option.position,option.radius);
      return '<button type="button" data-action="clock-choice" data-value="'+option.value+
        '" class="clock-number'+(option.inner?' inner':'')+(option.selected?' selected':'')+
        (option.disabled?' disabled':'')+
        '" style="left:'+pos.x.toFixed(1)+'px;top:'+pos.y.toFixed(1)+'px"'+
        ' aria-label="'+(isHours?'Hour '+option.label:'Minute '+option.label)+
        (option.disabled?' unavailable':'')+'"'+
        ' aria-pressed="'+option.selected+'"'+(option.disabled?' disabled':'')+
        '>'+option.label+'</button>';
    }).join('')+'</div>';
}
function clockPopupHtml(p) {
  const is12=preferenceClock==='12';
  const ampm=p.period[p.which];
  const ready=Boolean(p.start&&p.end&&
    p.touched.start.hour&&p.touched.start.minute&&
    p.touched.end.hour&&p.touched.end.minute&&
    minutes(p.end)>minutes(p.start)&&
    p.allowed.some(([a,b])=>minutes(p.start)>=a&&minutes(p.end)<=b));
  return '<div class="overlay clock-overlay" data-action="dismiss-overlay">'+
    '<section class="dialog clock-dialog" role="dialog" aria-modal="true" aria-label="Choose availability hours">'+
    '<div class="dialog-header"><h2>Choose hours</h2><div class="clock-header-actions">'+
    '<label class="clock-format-setting"><input type="checkbox" data-clock-format'+
    (preferenceClock==='24'?' checked':'')+'><span>24-hour clock</span></label>'+
    makeButton('×','dismiss','icon-button','aria-label="Close clock picker"')+'</div></div>'+
    '<div class="clock-range-tabs" role="group" aria-label="Range endpoints">'+
    ['start','end'].map(which=>
      '<button type="button" class="clock-time-tab'+(p.which===which?' active':'')+
      '" data-action="clock-target" data-which="'+which+'"'+
      ' aria-pressed="'+(p.which===which)+'"><span>'+
      (which==='start'?'From':p.end==='24:00'?'Until · end of day':'Until')+
      '</span><strong>'+esc(clockHeading(p,which))+
      '</strong></button>').join('')+'</div>'+
    '<div class="clock-toolbar"><div class="clock-stages" role="group" aria-label="Choose hour or minute">'+
    makeButton('Hours','clock-stage',p.stage==='hour'?'active':'','data-stage="hour"')+
    makeButton('Minutes','clock-stage',p.stage==='minute'?'active':'','data-stage="minute"')+'</div>'+
    (is12?'<div class="clock-ampm" role="group" aria-label="AM or PM">'+
      makeButton('AM','clock-ampm',ampm==='AM'?'active':'','data-ampm="AM"')+
      makeButton('PM','clock-ampm',ampm==='PM'?'active':'','data-ampm="PM"')+'</div>':
      '<span class="clock-hint">Drag or tap the dial</span>')+'</div>'+
    dialFace(p)+
    '<div class="clock-bottom-line">'+
    '<span>'+(p.completed?'Range chosen · Apply when ready':
      p.stage==='hour'&&preferenceClock==='24'?
      'Drag · 01–12 outer, 13–00 inner':
      p.stage==='hour'?'Drag or tap an hour':'Drag or tap minutes · 5-minute steps')+'</span>'+
    (p.which==='end'?makeButton('End of day','clock-endday',
      p.end==='24:00'?'selected':'','title="Set the end to 24:00"'+
      (!eligibleClockMinute(p,1440)?' disabled':'')):'')+
    '</div>'+
    (p.error?'<p class="clock-error" role="alert">'+esc(p.error)+'</p>':'')+
    '<div class="bottom-actions clock-actions">'+
    makeButton('Cancel','dismiss','outline')+
    makeButton('Apply range','clock-save','primary',ready?'':'disabled')+
    '</div></section></div>';
}
function redrawClockOnly() {
  const layer=root.querySelector('.clock-overlay');
  if(layer&&popup?.type==='clock')layer.outerHTML=clockPopupHtml(popup);
}
function openClockPicker(element) {
  const index=Number(element.dataset.index);
  const sourceName=index===-1?'batch':index===-2?'new':'single';
  const source=sourceName==='batch'?batch:
    sourceName==='new'?{start:null,end:null}:
      dayEntry(selectedDay)?.windows?.[index];
  if(!source)throw Error('Select an available time window first.');
  const date=selectedDay;
  const spec={source:sourceName,date,index};
  const allowed=freeClockIntervals(spec);
  if(!allowed.length)throw Error('No unused hours remain inside this day’s allowed schedule.');
  const parts=value=>({hour:value!=null,minute:value!=null});
  const period=value=>value==null?'PM':Number(value.slice(0,2))>=12?'PM':'AM';
  popup={
    type:'clock',source:sourceName,date,index,
    start:source.start??null,end:source.end??null,
    touched:{start:parts(source.start),end:parts(source.end)},
    period:{start:period(source.start),end:period(source.end)},
    allowed,which:element.dataset.which||'start',
    stage:'hour',error:'',completed:false,
  };
  render();
}
function setClockDialValue(p,value) {
  if(!clockOptionAvailable(p,value))return false;
  const current=p[p.which]==='24:00'?'00:00':p[p.which]||'00:00';
  let hour=Number(current.slice(0,2)),minute=Number(current.slice(3));
  if(p.stage==='hour'){
    hour=preferenceClock==='24'?value:(value%12)+(p.period[p.which]==='PM'?12:0);
    p.period[p.which]=hour>=12?'PM':'AM';
  }else minute=value;
  p.touched[p.which][p.stage]=true;
  p[p.which]=p.which==='end'&&hour===0&&minute===0&&
    p.touched[p.which].minute?'24:00':clock(hour*60+minute);
  p.completed=false;
  p.error='';
  return true;
}
function advanceClockStep(p) {
  // A complete range takes four choices, without manual tab switching.
  if(p.stage==='hour')p.stage='minute';
  else if(p.which==='start'){
    p.which='end';
    p.stage='hour';
  }else{
    // Keep the selected end minutes visible for fine-tuning. Never submit
    // automatically: Apply range remains an explicit confirmation.
    p.completed=true;
  }
}
function completeClockChoice() {
  if(!popup||popup.type!=='clock')return;
  advanceClockStep(popup);
  redrawClockOnly();
  if(popup.completed)root.querySelector('.clock-dialog [data-action="clock-save"]')?.focus();
}
function chooseOnClock(value) {
  if(!popup||popup.type!=='clock')return;
  if(setClockDialValue(popup,value))completeClockChoice();
}
// Pointer capture makes the dial behave like a native clock: you can hold
// the mouse/touch down and sweep across numbers until you release. While
// dragging, update the hand and displayed time IN PLACE, never replacing the
// element that owns pointer capture.
let activeClockPointer=null;
let lastClockPointerRelease=-Infinity;
function clockValueAtPointer(face,event) {
  const rect=face.getBoundingClientRect();
  // Normalize coordinates so CSS-transformed/smaller faces work identically.
  const x=(event.clientX-rect.left)/rect.width*220-110;
  const y=(event.clientY-rect.top)/rect.height*220-110;
  const radius=Math.hypot(x,y);
  const fraction=((Math.atan2(y,x)+Math.PI/2+2*Math.PI)%(2*Math.PI))/(2*Math.PI);
  const sector=Math.round(fraction*12)%12;
  if(popup.stage==='minute')return sector*5;
  if(preferenceClock==='12')return sector||12;
  return radius<72?(sector===0?0:sector+12):(sector||12);
}
function updateClockPreview() {
  const p=popup,face=root.querySelector('.clock-face');
  if(!face||p?.type!=='clock')return;
  const shown=p[p.which]==='24:00'?'00:00':p[p.which]||'00:00';
  const hour=Number(shown.slice(0,2)),minute=Number(shown.slice(3));
  const selectedValue=p.stage==='minute'?minute:
    preferenceClock==='12'?(hour%12||12):hour;
  const selected=p.touched[p.which][p.stage]?
    face.querySelector('.clock-number[data-value="'+selectedValue+'"]'):null;
  for(const item of face.querySelectorAll('.clock-number')){
    const isActive=item===selected;
    item.classList.toggle('selected',isActive);
    item.setAttribute('aria-pressed',String(isActive));
  }
  const hand=face.querySelector('.clock-hand');
  if(hand)hand.setAttribute('visibility',selected?'visible':'hidden');
  if(selected){
    hand?.setAttribute('x2',String(parseFloat(selected.style.left)));
    hand?.setAttribute('y2',String(parseFloat(selected.style.top)));
  }
  const tab=root.querySelector('.clock-time-tab[data-which="'+p.which+'"] strong');
  if(tab)tab.textContent=clockHeading(p,p.which);
  // AM/PM might change while crossing the 12/24-hour boundary.
  for(const option of root.querySelectorAll('.clock-ampm [data-ampm]')){
    const active=p.period[p.which]===option.dataset.ampm;
    option.classList.toggle('active',active);
  }
}
function clockPointerDown(event) {
  if(!popup||popup.type!=='clock'||event.button>0||activeClockPointer)return;
  const face=event.target.closest('.clock-face');
  if(!face||!root.contains(face))return;
  event.preventDefault();
  const value=clockValueAtPointer(face,event);
  if(!clockOptionAvailable(popup,value))return;
  activeClockPointer={
    id:event.pointerId,face,original:popup[popup.which],
    originalTouched:copy(popup.touched[popup.which]),
    originalPeriod:popup.period[popup.which],
    which:popup.which,stage:popup.stage,
  };
  try{face.setPointerCapture(event.pointerId);}catch{
    // Keyboard and synthetic interactions may not support pointer capture.
  }
  setClockDialValue(popup,value);
  updateClockPreview();
}
function clockPointerMove(event) {
  const drag=activeClockPointer;
  if(!drag||drag.id!==event.pointerId||popup?.type!=='clock')return;
  event.preventDefault();
  if(setClockDialValue(popup,clockValueAtPointer(drag.face,event)))
    updateClockPreview();
}
function clockPointerUp(event) {
  const drag=activeClockPointer;
  if(!drag||drag.id!==event.pointerId)return;
  if(popup?.type!=='clock'){activeClockPointer=null;return;}
  event.preventDefault();
  // The same pointer-up completes tap OR drag, advancing only AFTER release.
  setClockDialValue(popup,clockValueAtPointer(drag.face,event));
  try{
    if(drag.face.hasPointerCapture(event.pointerId))
      drag.face.releasePointerCapture(event.pointerId);
  }catch{}
  activeClockPointer=null;
  lastClockPointerRelease=performance.now();
  completeClockChoice();
}
function clockPointerCancel(event) {
  const drag=activeClockPointer;
  if(!drag||drag.id!==event.pointerId)return;
  if(popup?.type==='clock'){
    popup[drag.which]=drag.original;
    popup.touched[drag.which]=drag.originalTouched;
    popup.period[drag.which]=drag.originalPeriod;
    popup.which=drag.which;
    popup.stage=drag.stage;
  }
  activeClockPointer=null;
  redrawClockOnly();
}

function saveClockRange(){
  if(!popup||popup.type!=='clock')return;
  const p=popup;
  try{
    if(!p.start||!p.end||!['start','end'].every(which=>
      p.touched[which].hour&&p.touched[which].minute))
      throw Error('Choose both From and Until (hours and minutes).');
    const start=minutes(p.start),end=minutes(p.end);
    if(start>=end)throw Error('Until must be later than From.');
    if(!p.allowed.some(([a,b])=>start>=a&&end<=b))
      throw Error('The range must stay within unused, allowed hours.');
    if(p.source==='batch'){
      // Nothing is published until the separate multi-day Apply confirmation.
      batch.start=p.start;batch.end=p.end;
    }else{
      if(selectedDay!==p.date)throw Error('That day changed. Reopen its editor.');
      const current=dayEntry(p.date);
      const day=current?.status==='available'?copy(current):
        {status:'available',windows:[]};
      if(p.source==='new'){
        day.windows.push({start:p.start,end:p.end,kind:'confirmed',maxMinutes:null});
        nextWindowScroll='bottom';
      }else{
        if(!day.windows[p.index])throw Error('This time window no longer exists.');
        day.windows[p.index].start=p.start;
        day.windows[p.index].end=p.end;
        const duration=end-start;
        if(day.windows[p.index].maxMinutes>duration)
          day.windows[p.index].maxMinutes=duration;
      }
      validateDay(day);
      changeDay(p.date,day,false);
    }
    popup=null;
    render();
  }catch(error){
    p.error=String(error.message||error);
    redrawClockOnly();
  }
}

function popupHtml(){
  if(!popup)return '';
  if(popup.type==='clock')return clockPopupHtml(popup);
  let body='',title='',confirm='';
  if(popup.type==='batch'){
    title='Apply to '+popup.dates.length+' days?';
    body='<p class="hint">Review how the selected days will change. Green is confirmed, yellow tentative, red unavailable.</p>'+
      '<div class="preview-list">'+popup.dates.map(d=>
        '<div class="preview-change"><strong>'+esc(datestring(d,'mini'))+'</strong>'+
        '<div class="preview-before">Before: '+statusText(dayEntry(d))+'</div>'+
        '<div class="preview-after">After: '+statusText(popup.changes.find(x=>x.date===d).day)+'</div>'+
        miniTimeBar(popup.changes.find(x=>x.date===d).day)+'</div>').join('')+'</div>';
    confirm='Apply to selected days';
  }else if(popup.type==='copy'){
    title='Copy '+datestring(selectedDay,'mini')+' to…';
    body='<p class="hint">Copy <strong>'+esc(summary(dayEntry(selectedDay)))+'</strong> to selected dates.</p>'+
      '<div class="copy-list">'+model.round.dates.filter(d=>d!==selectedDay).map(d=>
        '<label class="copy-option"><input type="checkbox" data-copy="'+d+'" '+
        (popup.dates.includes(d)?'checked':'')+'><span><strong>'+
        esc(datestring(d,'mini'))+'</strong><small>'+esc(summary(dayEntry(d)))+'</small></span></label>').join('')+
      '</div><p class="hint">'+popup.dates.length+' selected · existing answers will be replaced.</p>';
    confirm='Copy to '+popup.dates.length+' day(s)';
  }else if(popup.type==='reuse'){
    title='Reuse my usual week?';
    body='<p class="hint">Apply your saved weekday pattern to this test week. You can edit any exceptions before submitting.</p>'+
      '<div class="preview-list">'+model.round.dates.map(d=>
        '<div><strong>'+esc(datestring(d,'mini'))+'</strong><span>'+
        esc(summary(model.template?.[weekday(d)]))+'</span></div>').join('')+'</div>';
    confirm='Apply usual week';
  }else if(popup.type==='exit'){
    title='Exit WinterBot?';
    body='<p class="hint">'+(inTemplate()?
      'This usual-week template has not been saved. Exiting will discard those template edits.':
      model.member.submitted&&hasRevision()?
      'Your unsubmitted edits will remain a saved draft. Your previous submission stays active.':
      !model.member.submitted?
      'Any draft availability will stay saved, but it is not submitted.':
      'Your submitted availability will remain recorded.')+'</p>';
    confirm='Exit Activity';
  }else if(popup.type==='discard'){
    title='Discard unsubmitted changes?';
    body='<p class="hint">Your previously submitted week will remain exactly as it was. '+
      'Only changes made since that submission will be discarded.</p>';
    confirm='Discard changes';
  }else if(popup.type==='template-reset'){
    title='Reset usual-week editor?';
    body='<p class="hint">Choose a starting point for the reusable template. '+
      'This will replace your unsaved template edits, but not your actual event submission.</p>'+
      '<div class="template-reset-options">'+
      (model.member.submitted?makeButton('Copy submitted week','reset-template-submitted','outline'):'')+
      (Object.keys(model.member.draft).length?makeButton('Copy current event draft','reset-template-draft','outline'):'')+
      makeButton('Start with a blank week','reset-template-blank','outline')+'</div>';
    confirm='Keep current template';
  }
  return '<div class="overlay" data-action="dismiss-overlay"><div class="dialog" role="dialog" aria-modal="true" aria-label="'+esc(title)+'">'+
    '<div class="dialog-header"><h2>'+esc(title)+'</h2>'+
    makeButton('×','dismiss','icon-button')+'</div>'+body+
    '<div class="bottom-actions">'+makeButton('Cancel','dismiss','outline')+
    makeButton(confirm,popup.type==='template-reset'?'dismiss':'confirm-popup',
      popup.type==='discard'?'danger':'primary',
      popup.type==='copy'&&!popup.dates.length?'disabled':'')+
    '</div></div></div>';
}
let lastEditorKey='';
let nextWindowScroll=null;
function render(){
  if(!model)return;
  const oldY=window.scrollY;
  const editorKey=(view==='week'||view==='template')?
    view+'-'+(multi?'batch':selectedDay):'';
  const editorScroll=editorKey===lastEditorKey?
    (root.querySelector('.window-list')||
      root.querySelector('.workspace>.editor-card'))?.scrollTop||0:0;
  const content=view==='review'?reviewPage():view==='template-review'?templateReviewPage():
    view==='done'?donePage():
    '<div class="workspace">'+weekCard()+(multi?batchEditor():singleEditor())+'</div>';
  root.innerHTML='<main class="app-shell'+(inTemplate()?' template-mode':'')+'">'+stageHeader()+
    (notice?'<div class="message '+(noticeError?'danger':'')+'" role="status">'+esc(notice)+'</div>':'')+
    content+
    (view==='week'?'<footer class="action-footer"><div><strong>'+
      (!model.member.submitted?'Draft · Not submitted':
        hasRevision()?'Changes not yet submitted':'Submitted · You can edit your response')+
      '</strong><small>Drafts save automatically; only reviewed submissions count.</small></div>'+
      '<div class="footer-buttons">'+
      (model.member.submitted?makeButton('Cancel','exit-revision','outline'):'')+
      makeButton(model.member.submitted?'Submit changes →':'Review & submit →',
        'review','primary',model.member.submitted&&!hasRevision()?'disabled':'')+'</div></footer>':
      view==='template'?templateFooter():'')+
    '<div class="privacy-note">TEST ONLY · Your answers stay in the isolated WinterBot testing system.</div>'+
    popupHtml()+'</main>';
  window.scrollTo(0,oldY);
  const editor=root.querySelector('.window-list')||
    root.querySelector('.workspace>.editor-card');
  if(editor){
    if(nextWindowScroll==='bottom')editor.scrollTop=editor.scrollHeight;
    else if(editorScroll)editor.scrollTop=editorScroll;
  }
  nextWindowScroll=null;
  lastEditorKey=editorKey;
  if(view==='review'||view==='template-review')setupReviewScroll();
}
function setupReviewScroll(){
  const list=root.querySelector('.review-list');
  if(!list)return;
  const update=()=>{
    const overflows=list.scrollHeight>list.clientHeight+2;
    const atEnd=!overflows||list.scrollTop+list.clientHeight>=list.scrollHeight-3;
    if(view==='template-review'){
      if(atEnd)templateSeenBottom=true;
      const hint=root.querySelector('[data-role="template-scroll"]');
      if(hint)hint.hidden=!overflows||templateSeenBottom;
      const save=root.querySelector('[data-action="template-commit"]');
      if(save)save.disabled=!templateSeenBottom||templateBusy||
        !model.round.dates.some(d=>templateDraft[d]);
      return;
    }
    if(atEnd)reviewSeenBottom=true;
    const hint=root.querySelector('[data-role="review-scroll"]');
    if(hint)hint.hidden=!overflows||reviewSeenBottom;
    const submit=root.querySelector('[data-action="submit"]');
    if(submit)submit.disabled=!model.round.dates.every(dayEntry)||
      errorSaving||dirty.size>0||saving||!reviewReady||!reviewSeenBottom;
  };
  list.addEventListener('scroll',update,{passive:true});
  update();
}
function refreshSaveLabel(){
  const labelNode=root.querySelector('[data-role="save"]');
  if(labelNode){
    labelNode.textContent=saveLabel();
    labelNode.classList.toggle('error',errorSaving);
  }
  const retry=root.querySelector('.retry-save');
  if(retry)retry.hidden=!errorSaving;
}
function actionError(error){
  notice=String(error?.message||error||'Could not complete the action.');
  noticeError=true;
  render();
}
function request(path,body){
  // Discord maps /api to the free ngrok tunnel, but its proxy does not
  // automatically bypass ngrok's browser-warning interstitial. The static
  // Activity itself is instead served from GitHub Pages.
  const settings={credentials:'include',headers:{
    Accept:'application/json','ngrok-skip-browser-warning':'1',
  }};
  if(body!==undefined){
    settings.method='POST';settings.headers['Content-Type']='application/json';
    settings.headers['X-WinterBot-Activity']='1';settings.body=JSON.stringify(body);
  }
  return fetch('./api/'+path,settings).then(async response=>{
    const type=response.headers.get('content-type')||'';
    if(!type.includes('application/json'))
      throw Error('WinterBot API was not reachable. Check the /api Activity URL Mapping.');
    let data;
    try{data=await response.json();}catch{throw Error('WinterBot returned invalid JSON.');}
    if(!response.ok)throw Error(data.error||'Request failed ('+response.status+').');
    return data;
  });
}
function scheduleSave(){
  if(saveTimer)clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{saveTimer=null;flush().catch(actionError);},180);
  refreshSaveLabel();
}
async function flush(){
  if(saving)return;
  if(!dirty.size)return;
  const entries=[...dirty.entries()];
  dirty.clear();
  saving=true;refreshSaveLabel();
  try{
    await request('ux/draft',{days:entries.map(([,value])=>copy(value))});
    errorSaving=false;
  }catch(error){
    // Restore unsent changes without losing edits made during the request.
    for(const [date,value] of entries)if(!dirty.has(date))dirty.set(date,value);
    errorSaving=true;
    throw error;
  }finally{
    saving=false;
    refreshSaveLabel();
  }
  if(dirty.size){await flush();}
}
async function flushAll(){
  if(saveTimer){clearTimeout(saveTimer);saveTimer=null;}
  while(saving){await new Promise(resolve=>setTimeout(resolve,40));}
  if(dirty.size)await flush();
  if(errorSaving||dirty.size)throw Error('Save your draft before submitting.');
}
function selectDay(date){
  if(!model.round.dates.includes(date))return;
  notice='';
  if(multi){
    if(chosen.has(date))chosen.delete(date);else chosen.add(date);
  }else selectedDay=date;
  render();
}
async function openTemplateEditor(){
  // Finish writing the real event draft before switching to a completely
  // independent, explicitly-saved usual-week editor.
  await flushAll();
  templateReturnView=view==='done'?'done':'week';
  let source=null;
  if(model.template){
    templateOrigin='existing';
    source=model.template;
  }else if(model.member.submitted){
    templateOrigin='submitted';
    source=model.member.submitted;
  }else if(Object.keys(model.member.draft).length){
    templateOrigin='draft';
    source=model.member.draft;
  }else{
    templateOrigin='blank';
  }
  templateDraft=draftForWeekdays(source);
  templateSeenBottom=false;
  templateBusy=false;
  view='template';
  popup=null;selectedDay=model.round.dates[0];
  multi=false;chosen.clear();
  notice='';noticeError=false;
  render();
}
function resetTemplate(source){
  if(!inTemplate())return;
  if(source==='submitted'&&model.member.submitted){
    templateDraft=draftForWeekdays(model.member.submitted);
    templateOrigin='submitted';
  }else if(source==='draft'&&Object.keys(model.member.draft).length){
    templateDraft=draftForWeekdays(model.member.draft);
    templateOrigin='draft';
  }else{
    templateDraft={};
    templateOrigin='blank';
  }
  popup=null;view='template';templateSeenBottom=false;
  multi=false;chosen.clear();selectedDay=model.round.dates[0];
  notice='Template editor reset. Nothing was saved.';
  render();
}
function cancelTemplate(){
  templateDraft={};
  popup=null;view=templateReturnView;
  templateSeenBottom=false;templateBusy=false;
  multi=false;chosen.clear();
  notice='Template editing cancelled. Your saved data is unchanged.';
  render();
}
async function commitTemplate(){
  if(view!=='template-review'||!templateSeenBottom)return;
  const days={};
  for(const date of model.round.dates){
    if(templateDraft[date])days[weekday(date)]=copy(templateDraft[date]);
  }
  if(!Object.keys(days).length)throw Error('Set at least one weekday.');
  templateBusy=true;render();
  try{
    const response=await request('ux/template-update',{confirm:true,days});
    model=response;
    view=templateReturnView;
    templateDraft={};
    templateBusy=false;templateSeenBottom=false;
    multi=false;chosen.clear();
    notice='Your usual-week template is saved. Event submissions are unchanged.';
    render();
  }catch(error){
    templateBusy=false;
    actionError(error);
  }
}

async function exitDiscordActivity(){
  if(!discordSdk||typeof discordSdk.close!=='function'){
    throw Error('Discord could not close the Activity. Use the red Leave Activity control.');
  }
  // Event drafts remain drafts. Never submit on exit. The independent
  // template editor intentionally has no autosave and loses its local edits.
  if(saveTimer||saving||dirty.size)await flushAll();
  popup=null;
  discordSdk.close(RPCCloseCodes.CLOSE_NORMAL,'User exited WinterBot Activity');
}

async function discardRevision(){
  if(!model.member.submitted)throw Error('No previous submission exists.');
  // Wait for any in-flight background write before the authoritative reset,
  // but skip pending unsent edits. Do not force a failed draft to save.
  if(saveTimer){clearTimeout(saveTimer);saveTimer=null;}
  while(saving)await new Promise(resolve=>setTimeout(resolve,30));
  dirty.clear();errorSaving=false;
  const response=await request('ux/discard-revision',{confirm:true});
  model=response;
  popup=null;view='done';multi=false;chosen.clear();
  reviewReady=false;reviewSeenBottom=false;
  notice='Your previous submission is unchanged.';
  render();
}
async function openReview(){
  view='review';reviewReady=false;reviewSeenBottom=false;notice='';render();
  try{
    await flushAll();
    await request('ux/review',{confirmReview:true});
    reviewReady=true;render();
  }catch(error){actionError(error);}
}
async function submit(){
  const unanswered=model.round.dates.filter(d=>!dayEntry(d));
  if(unanswered.length)return actionError(Error('Answer every day before submitting.'));
  if(!reviewReady)return actionError(Error('Review your answers before submitting.'));
  try{
    await flushAll();
    const response=await request('ux/submit',{confirm:true});
    model=response;view='done';reviewReady=false;notice='';render();
  }catch(error){actionError(error);}
}
async function confirmPopup(){
  if(!popup)return;
  const active=popup;
  try{
    if(active.type==='batch'){
      changeDays(active.changes);
      multi=false;chosen.clear();popup=null;notice='';render();return;
    }
    if(active.type==='copy'){
      if(!active.dates.length)throw Error('Select at least one destination day.');
      changeMany(active.dates,dayEntry(selectedDay));
      popup=null;notice='Copied the complete day, including any tentative hours.';render();return;
    }
    if(active.type==='reuse'){
      await flushAll();
      const response=await request('ux/template-apply',{confirm:true});
      model=response;chosen.clear();multi=false;popup=null;view='week';
      notice='Usual week copied to this draft. Review before submitting.';render();return;
    }
    if(active.type==='discard'){
      await discardRevision();return;
    }
    if(active.type==='exit'){
      await exitDiscordActivity();return;
    }
  }catch(error){actionError(error);}
}
function openBatchConfirmation(){
  const dates=model.round.dates.filter(d=>chosen.has(d));
  if(!dates.length)throw Error('Select one or more days.');
  const hours=batch.mode==='hours'?validateDay({status:'available',windows:[
    {start:batch.start,end:batch.end,kind:batch.kind,maxMinutes:null},
  ]}):null;
  const changes=dates.map(date=>({date,day:batch.mode==='off'?
    {status:'unavailable',windows:[]}:
    batch.mode==='all'?allPermittedDay(date,batch.kind):hours}));
  const replacing=dates.some(d=>dayEntry(d));
  if(replacing){popup={type:'batch',dates,changes};render();}
  else{changeDays(changes);multi=false;chosen.clear();
    notice='Availability applied to '+dates.length+' days.';render();}
}
function onClick(event){
  const element=event.target.closest('[data-action]');
  if(!element||!model)return;
  const action=element.dataset.action;
  try{
    if(action==='dismiss-overlay'&&element===event.target){popup=null;render();return;}
    if(action==='dismiss'){popup=null;render();return;}
    if(action==='edit-range'){openClockPicker(element);return;}
    if(popup?.type==='clock'){
      if(action==='clock-target'){
        popup.which=element.dataset.which;
        popup.stage='hour';popup.error='';popup.completed=false;
        redrawClockOnly();return;
      }
      if(action==='clock-stage'){
        popup.stage=element.dataset.stage;
        popup.completed=false;
        redrawClockOnly();return;
      }
      if(action==='clock-choice'){
        // Mouse/touch pointer-up already chose and advanced the clock. Ignore
        // its subsequent synthesized click, but preserve keyboard clicks.
        if(event.detail>0 && performance.now()-lastClockPointerRelease<500)return;
        chooseOnClock(Number(element.dataset.value));return;
      }
      if(action==='clock-ampm'){
        const which=popup.which;
        popup.period[which]=element.dataset.ampm;
        if(popup.touched[which].hour&&popup[which]){
          const current=popup[which]==='24:00'?'00:00':popup[which];
          const h=Number(current.slice(0,2))%12;
          popup[which]=clock((element.dataset.ampm==='PM'?12:0)*60+h*60+
            Number(current.slice(3)));
        }
        popup.error='';popup.completed=false;redrawClockOnly();return;
      }
      if(action==='clock-endday'){
        if(!eligibleClockMinute({...popup,which:'end'},1440))return;
        popup.end='24:00';popup.touched.end={hour:true,minute:true};
        popup.period.end='AM';popup.which='end';popup.stage='minute';
        popup.error='';popup.completed=true;redrawClockOnly();return;
      }
      if(action==='clock-save'){saveClockRange();return;}
    }
    if(action==='confirm-popup'){confirmPopup();return;}
    if(action==='exit-activity'){
      popup={type:'exit'};render();return;
    }
    if(action==='open-template'){openTemplateEditor().catch(actionError);return;}
    if(action==='template-cancel'){cancelTemplate();return;}
    if(action==='template-reset'){popup={type:'template-reset'};render();return;}
    if(action==='reset-template-blank'){resetTemplate('blank');return;}
    if(action==='reset-template-submitted'){resetTemplate('submitted');return;}
    if(action==='reset-template-draft'){resetTemplate('draft');return;}
    if(action==='template-review-open'){
      templateSeenBottom=false;view='template-review';notice='';render();return;
    }
    if(action==='template-review-back'){
      templateSeenBottom=false;view='template';render();return;
    }
    if(action==='template-edit-day'){
      templateSeenBottom=false;view='template';
      selectedDay=element.dataset.date;multi=false;chosen.clear();
      render();return;
    }
    if(action==='template-commit'){commitTemplate().catch(actionError);return;}
    if(action==='pick-day'){selectDay(element.dataset.date);return;}
    if(action==='mode-single'){
      multi=false;chosen.clear();notice='';render();return;
    }
    if(action==='multi'){
      if(!multi)batch={kind:'confirmed',start:null,end:null,mode:'hours'};
      multi=true;chosen.clear();notice='';render();return;
    }
     if(action==='all-day'){changeDay(selectedDay,allPermittedDay(selectedDay));return;}
    if(action==='unavailable'){changeDay(selectedDay,{status:'unavailable',windows:[]});return;}
    if(action==='clear-day'){changeDay(selectedDay,null);return;}
    if(action==='add-window'){
      openClockPicker({dataset:{index:'-2',which:'start'}});
      return;
    }
    if(action==='toggle-kind'){
      const day=copy(dayEntry(selectedDay));
      const w=day?.windows[Number(element.dataset.index)];
      if(!w)throw Error('That time window is no longer available.');
      w.kind=w.kind==='tentative'?'confirmed':'tentative';
      changeDay(selectedDay,day);return;
    }
    if(action==='remove-window'){
      const day=copy(dayEntry(selectedDay));
      day.windows.splice(Number(element.dataset.index),1);
      changeDay(selectedDay,day.windows.length?day:null);return;
    }

    if(action==='batch-kind'){
      batch.kind=element.dataset.kind;
      render();return;
    }
    if(action==='batch-mode'){batch.mode=element.dataset.mode;render();return;}
    if(action==='apply-batch'){openBatchConfirmation();return;}
    if(action==='copy'){
      if(!dayEntry(selectedDay))throw Error('Enter availability for this day before copying it.');
      popup={type:'copy',dates:[]};render();return;
    }
    if(action==='reuse'){if(!model.template)throw Error('No usual week is saved yet.');
      popup={type:'reuse'};render();return;}
    if(action==='exit-revision'){
      if(!model.member.submitted)return;
      if(hasRevision()){
        popup={type:'discard'};render();
      }else{
        view='done';multi=false;chosen.clear();notice='';render();
      }
      return;
    }
    if(action==='review'){openReview();return;}
    if(action==='review-edit'){
      view='week';multi=false;selectedDay=element.dataset.date;reviewReady=false;reviewSeenBottom=false;render();return;
    }
    if(action==='back'){view='week';reviewReady=false;reviewSeenBottom=false;render();return;}
    if(action==='submit'){submit();return;}
    if(action==='retry'){flushAll().catch(actionError);return;}
    if(action==='clock'){
      preferenceClock=preferenceClock==='24'?'12':'24';
      request('ux/preference',{clock:preferenceClock}).catch(()=>{});
      render();return;
    }
  }catch(error){actionError(error);}
}
function onChange(event){
  const element=event.target;
  if(!model)return;
  if(element.hasAttribute('data-copy')){
    if(!popup||popup.type!=='copy')return;
    const date=element.dataset.copy;
    if(element.checked&&!popup.dates.includes(date))popup.dates.push(date);
    if(!element.checked)popup.dates=popup.dates.filter(d=>d!==date);
    render();return;
  }
  if(element.matches('[data-clock-format]')){
    preferenceClock=element.checked?'24':'12';
    model.member.clockFormat=preferenceClock;
    request('ux/preference',{clock:preferenceClock}).catch(()=>{});
    if(popup?.type==='clock')redrawClockOnly();
    else render();
    return;
  }
  if(element.hasAttribute('data-batch')){
    const field=element.dataset.batch;
    batch[field]=element.value;
    if(field==='kind'){
      element.classList.toggle('confirmed',batch.kind==='confirmed');
      element.classList.toggle('tentative',batch.kind==='tentative');
    }
    if(field==='start'||field==='end'){
      if(!Number.isFinite(minutes(element.value)))return actionError(Error('Choose a valid time.'));
    }
    // Leave focus on the edited field; local data already changed.
    return;
  }
  if(element.hasAttribute('data-field')){
    const index=Number(element.dataset.index),field=element.dataset.field;
    const day=copy(dayEntry(selectedDay));
    if(!day?.windows[index])return;
    day.windows[index][field]=field==='maxMinutes'?
      (element.value===''?null:Number(element.value)):element.value;
    try{changeDay(selectedDay,day);}
    catch(error){actionError(error);}
  }
}
function keydown(event){
  if(event.key==='Escape'&&popup){popup=null;render();}
}
root.addEventListener('pointerdown',clockPointerDown);
root.addEventListener('pointermove',clockPointerMove);
root.addEventListener('pointerup',clockPointerUp);
root.addEventListener('pointercancel',clockPointerCancel);
root.addEventListener('click',onClick);
root.addEventListener('change',onChange);
document.addEventListener('keydown',keydown);

async function initialize(){
  try{
    if(window.top===window.self&&!window.__WINTERBOT_ACTIVITY_SDK_FACTORY__){
      root.innerHTML='<main class="app-shell"><section class="editor-card"><h2>Open inside Discord</h2>'+
        '<p>Launch WinterBot from the dedicated test server. This Activity does not accept external browser sign-in.</p></section></main>';
      return;
    }
    const config=await request('config');
    const sdk=window.__WINTERBOT_ACTIVITY_SDK_FACTORY__?
      window.__WINTERBOT_ACTIVITY_SDK_FACTORY__(config.clientId):new DiscordSDK(config.clientId);
    await sdk.ready();
    discordSdk=sdk;
    let code;
    try{
      code=await sdk.commands.authorize({client_id:config.clientId,response_type:'code',
        state:'',prompt:'none',scope:['identify']});
    }catch{
      code=await sdk.commands.authorize({client_id:config.clientId,response_type:'code',
        state:'',prompt:'consent',scope:['identify']});
    }
    if(!code?.code)throw Error('Discord could not authorize this Activity.');
    const token=await request('token',{code:code.code});
    const auth=await sdk.commands.authenticate({access_token:token.access_token});
    if(!auth)throw Error('Discord did not complete authentication.');
    model=await request('ux/state');
    preferenceClock=model.member.clockFormat||'24';
    selectedDay=model.round.dates[0];
    view=model.member.submitted &&
      JSON.stringify(model.member.submitted)===JSON.stringify(model.member.draft)?'done':'week';
    render();
  }catch(error){
    root.innerHTML='<main class="app-shell"><section class="editor-card">'+
      '<h2>Could not open WinterBot</h2><p>'+esc(error.message||'Unknown error')+'</p>'+
      '<p>Check the Activity URL mapping and your test-server permissions, then relaunch.</p></section></main>';
  }
}
initialize();
