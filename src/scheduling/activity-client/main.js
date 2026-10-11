import { DiscordSDK } from '@discord/embedded-app-sdk';

// Focused, isolated Activity UX pilot. Unlike message components, calendar
// interaction is entirely client-side; server writes happen in the background.
const root=document.getElementById('app');
let model=null;
let selectedDay=null;
let multi=false;
let chosen=new Set();
let batch={kind:'confirmed',start:'18:00',end:'23:00',mode:'hours'};
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
function dayEntry(date){return model.member.draft[date]||null;}
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
function summary(day){
  if(!day)return 'Not answered';
  if(day.status==='unavailable')return 'Unavailable';
  return day.windows.map(w=>{
    const duration=w.start==='00:00'&&w.end==='24:00'?'All day':
      formatTime(w.start)+'–'+formatTime(w.end);
    return (w.kind==='tentative'?'Tentative · ':'')+duration+
      (w.maxMinutes?' · max '+w.maxMinutes+'m':'');
  }).join('  ·  ');
}
function dayKind(day){
  if(!day)return 'empty';
  if(day.status==='unavailable')return 'off';
  if(day.windows.every(w=>w.kind==='tentative'))return 'unsure';
  return 'yes';
}
function makeButton(text,action,cls='',extra=''){
  return '<button type="button" class="button '+cls+'" data-action="'+action+'" '+extra+'>'+esc(text)+'</button>';
}
function saveLabel(){
  if(errorSaving)return 'Could not save · Retry';
  if(saving||dirty.size)return 'Saving draft…';
  return model?.member?.submittedAt?'Draft saved':'Saved as draft';
}
function setAlert(value,isError=false){notice=value;noticeError=isError;render();}
function changeDay(date,day,renderNow=true){
  const normalized=validateDay(day);
  if(normalized)model.member.draft[date]=normalized;
  else delete model.member.draft[date];
  model.progress.reviewed=false;
  const payload=normalized?{date,...copy(normalized)}:{date,status:'unanswered'};
  dirty.set(date,payload);
  errorSaving=false;
  scheduleSave();
  if(renderNow)render();
}
function changeMany(dates,day){
  const normalized=validateDay(day);
  for(const date of dates){
    if(normalized)model.member.draft[date]=copy(normalized);
    else delete model.member.draft[date];
    dirty.set(date,normalized?{date,...copy(normalized)}:{date,status:'unanswered'});
  }
  model.progress.reviewed=false;
  errorSaving=false;
  scheduleSave();
  render();
}
function stageHeader(){
  const dates=model.round.dates;
  const answered=dates.filter(d=>dayEntry(d)).length;
  const pct=Math.round(answered/dates.length*100);
  return '<header class="mast"><div class="brand-lockup">'+
    '<div class="brand-symbol" aria-hidden="true"><span>W</span></div>'+
    '<div><p class="eyebrow">WINTERBOT / COMMUNITY SCHEDULING</p>'+
    '<div class="brand-name">Your availability</div></div></div>'+
    '<span class="environment-tag">TEST ACTIVITY</span></header>'+
    '<section class="hero"><div class="hero-copy"><p class="eyebrow">GAME NIGHT · '+esc(model.round.timezone)+'</p>'+
    '<h1>'+esc(datestring(dates[0],'mini'))+' – '+esc(datestring(dates.at(-1),'mini'))+'</h1>'+
    '<p>Pick your days, adjust your hours and review before submitting.</p></div>'+
    '<div class="progress-panel"><div class="progress-top"><strong>'+answered+' <span>/ '+dates.length+'</span></strong>'+
    '<span>days answered</span></div><div class="progress-track"><div class="progress-fill" style="width:'+pct+'%"></div></div>'+
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
    const n=iso.toLocaleDateString('en-GB',{day:'numeric',timeZone:'UTC'});
    const mark=kind==='yes'?icon.check:kind==='unsure'?icon.unsure:kind==='off'?icon.off:icon.empty;
    const status=kind==='yes'?'Available':kind==='unsure'?'Tentative':
      kind==='off'?'Unavailable':'Not set';
    return '<button type="button" class="day-card state-'+kind+
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
    '<div class="section-title"><div><p class="eyebrow">STEP 1</p><h2>Your week</h2></div>'+
    '<div class="week-actions">'+
    (model.template?makeButton('Reuse','reuse','minor','title="Apply your saved usual week" aria-label="Reuse usual week"'):'')+
    makeButton(preferenceClock==='24'?'24h':'12h','clock','minor',
      'aria-label="'+(preferenceClock==='24'?'24-hour clock':'12-hour clock')+'"')+
    '<button class="text-button'+(multi?' active':'')+'" data-action="multi" type="button">'+
    (multi?'✓ Selecting':'Select days')+'</button></div></div>'+
    '<div class="week-grid">'+dayCards()+'</div>'+
    (multi?'<p class="small-note">'+chosen.size+' day(s) selected. Pick the days you want to edit together.</p>':'')+
    '</section>';
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
function timeInput(date,index,field,value){
  const label=field==='start'?'From':'Until';
  const shown=value==='24:00'?
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
    '<div class="range-tag">'+(w.kind==='tentative'?'Tentative hours':'Available hours')+'</div>'+
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
function singleEditor(){
  const date=selectedDay||model.round.dates[0],entry=dayEntry(date);
  const kind=entry?.status==='available'?'hours':entry?.status==='unavailable'?'off':'none';
  const isTentative=entry?.status==='available'&&entry.windows.every(w=>w.kind==='tentative');
  const badge=kind==='hours'?(isTentative?'Tentative':'Available'):
    kind==='off'?'Unavailable':'Not answered';
  const title='<div class="editor-heading"><div><p class="eyebrow">STEP 2 · EDIT DAY</p><h2>'+
    esc(datestring(date))+'</h2></div><span class="pill '+dayKind(entry)+'">'+
    esc(badge)+'</span></div>';
  let body='<div class="choice-row">'+
    makeButton('Available hours','set-hours','choice '+(kind==='hours'?'selected':'soft'))+
    makeButton('All day','all-day','choice')+
    makeButton('Unavailable','unavailable','choice '+(kind==='off'?'selected':'soft'))+
    '</div>';
  if(entry?.status==='available'){
    body+='<p class="hint">Green ranges are available. Mark a range tentative if you might be able to attend.</p>'+
      timeRail(entry.windows)+entry.windows.map((w,i)=>windowEditor(date,entry,i,w)).join('')+
      '<div class="editor-footer">'+makeButton('+ Add time window','add-window','outline')+
      makeButton('Copy this day','copy','outline')+'</div>';
  }else if(kind==='off'){
    body+='<div class="empty-editor"><strong>You are unavailable on this day.</strong>'+
      '<p>Change this anytime before submitting.</p>'+
      makeButton('Clear answer','clear-day','minor')+'</div>';
  }else{
    body+='<div class="empty-editor"><strong>No hours entered yet.</strong>'+
      '<p>Choose Available hours, All day or Unavailable above. An unanswered day cannot be submitted.</p></div>';
  }
  return '<section class="editor-card">'+title+body+'</section>';
}
function batchEditor(){
  const dates=model.round.dates.filter(d=>chosen.has(d));
  const replaced=dates.filter(d=>dayEntry(d)).length;
  const ready=dates.length>0;
  const body='<div class="editor-heading"><div><p class="eyebrow">STEP 2 · BULK EDIT</p><h2>'+
    (ready?'Edit '+dates.length+' selected day(s)':'Select days above')+'</h2></div></div>'+
    '<p class="hint">Set the same availability on multiple dates in one action. Your other days stay unchanged.</p>'+
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
      '</div><div class="field"><label>Certainty</label><select data-batch="kind">'+
      '<option value="confirmed"'+(batch.kind==='confirmed'?' selected':'')+'>Available</option>'+
      '<option value="tentative"'+(batch.kind==='tentative'?' selected':'')+'>Tentative</option>'+
      '</select></div></div>':'')+
    '<div class="editor-footer">'+makeButton('Apply to '+dates.length+' day(s)','apply-batch','primary',
      ready?'':'disabled')+'</div>';
  return '<section class="editor-card">'+body+'</section>';
}

function reviewPage(){
  const dates=model.round.dates,answered=dates.filter(d=>dayEntry(d)).length;
  const full=answered===dates.length;
  const rows=dates.map(d=>{
    const answer=dayEntry(d),kind=dayKind(answer);
    return '<div class="review-row"><div class="review-date"><span class="status-dot '+kind+'"></span>'+
      '<strong>'+esc(datestring(d,'mini'))+'</strong></div>'+
      '<div class="review-answer '+kind+'">'+esc(summary(answer))+'</div>'+
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
    makeButton('Confirm & submit','submit','primary',full&&!errorSaving&&!dirty.size&&reviewReady&&!saving&&reviewSeenBottom?'':'disabled')+
    '</div></section>';
}
function donePage(){
  return '<section class="receipt"><div class="receipt-icon" aria-hidden="true">✓</div>'+
    '<p class="eyebrow">SUBMISSION COMPLETE</p><h2>Your week is submitted</h2>'+
    '<p>WinterBot recorded your reviewed availability for this test round. You can update it before collection closes.</p>'+
    '<div class="review-list">'+model.round.dates.map(d=>
      '<div class="review-row"><strong>'+esc(datestring(d,'mini'))+'</strong>'+
      '<span>'+esc(summary(model.member.submitted?.[d]))+'</span></div>').join('')+'</div>'+
    '<div class="bottom-actions">'+makeButton('Edit my availability','back','outline')+
    makeButton(model.template?'Update usual week':'Save as my usual week','save-template','primary')+
    '</div></section>';
}
function facePoint(value,radius) {
  const angle=2*Math.PI*value/12-Math.PI/2;
  return {x:110+radius*Math.cos(angle),y:110+radius*Math.sin(angle)};
}
function dialFace(p) {
  const time=p[p.which]==='24:00'?'23:00':p[p.which];
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
  const active=options.find(x=>x.selected);
  const point=active?facePoint(active.position,active.radius):{x:110,y:22};
  return '<div class="clock-face" role="group" aria-label="'+
    (isHours?'Choose an hour':'Choose minutes in five-minute steps')+'">'+
    '<svg viewBox="0 0 220 220" aria-hidden="true" class="clock-hand-svg">'+
    (isHours&&preferenceClock==='24'?'<circle cx="110" cy="110" r="56" class="clock-inner-ring"/>':'')+
    '<line x1="110" y1="110" x2="'+point.x.toFixed(1)+'" y2="'+point.y.toFixed(1)+
    '" class="clock-hand"/><circle cx="110" cy="110" r="4" class="clock-hub"/></svg>'+
    options.map(option=>{
      const pos=facePoint(option.position,option.radius);
      return '<button type="button" data-action="clock-choice" data-value="'+option.value+
        '" class="clock-number'+(option.inner?' inner':'')+(option.selected?' selected':'')+
        '" style="left:'+pos.x.toFixed(1)+'px;top:'+pos.y.toFixed(1)+'px"'+
        ' aria-label="'+(isHours?'Hour '+option.label:'Minute '+option.label)+'"'+
        ' aria-pressed="'+option.selected+'">'+option.label+'</button>';
    }).join('')+'</div>';
}
function clockPopupHtml(p) {
  const format=value=>value==='24:00'?
    (preferenceClock==='12'?'12:00 AM':'24:00'):formatTime(value);
  const current=p[p.which]==='24:00'?'23:00':p[p.which];
  const is12=preferenceClock==='12';
  const ampm=Number(current.slice(0,2))<12?'AM':'PM';
  return '<div class="overlay clock-overlay" data-action="dismiss-overlay">'+
    '<section class="dialog clock-dialog" role="dialog" aria-modal="true" aria-label="Choose availability hours">'+
    '<div class="dialog-header"><h2>Choose availability hours</h2>'+
    makeButton('×','dismiss','icon-button','aria-label="Close clock picker"')+'</div>'+
    '<div class="clock-range-tabs" role="group" aria-label="Range endpoints">'+
    ['start','end'].map(which=>
      '<button type="button" class="clock-time-tab'+(p.which===which?' active':'')+
      '" data-action="clock-target" data-which="'+which+'"'+
      ' aria-pressed="'+(p.which===which)+'"><span>'+
      (which==='start'?'From':p.end==='24:00'?'Until · end of day':'Until')+
      '</span><strong>'+esc(format(p[which]))+
      '</strong></button>').join('')+'</div>'+
    '<div class="clock-toolbar"><div class="clock-stages" role="group" aria-label="Choose hour or minute">'+
    makeButton('Hours','clock-stage',p.stage==='hour'?'active':'','data-stage="hour"')+
    makeButton('Minutes','clock-stage',p.stage==='minute'?'active':'','data-stage="minute"')+'</div>'+
    (is12?'<div class="clock-ampm" role="group" aria-label="AM or PM">'+
      makeButton('AM','clock-ampm',ampm==='AM'?'active':'','data-ampm="AM"')+
      makeButton('PM','clock-ampm',ampm==='PM'?'active':'','data-ampm="PM"')+'</div>':
      '<span class="clock-hint">24-hour clock</span>')+'</div>'+
    dialFace(p)+
    '<div class="clock-bottom-line">'+
    '<span>'+(p.stage==='hour'&&preferenceClock==='24'?
      'Hours: 01–12 outer ring, 13–00 inner ring':
      p.stage==='hour'?'Choose the hour on the dial':'Minutes: 5-minute steps')+'</span>'+
    (p.which==='end'?makeButton('End of day','clock-endday',
      p.end==='24:00'?'selected':'','title="Set the end to 24:00"'):'')+
    '</div>'+
    (p.error?'<p class="clock-error" role="alert">'+esc(p.error)+'</p>':'')+
    '<div class="bottom-actions clock-actions">'+
    makeButton('Cancel','dismiss','outline')+
    makeButton('Apply range','clock-save','primary')+
    '</div></section></div>';
}
function redrawClockOnly() {
  const layer=root.querySelector('.clock-overlay');
  if(layer&&popup?.type==='clock')layer.outerHTML=clockPopupHtml(popup);
}
function openClockPicker(element) {
  const index=Number(element.dataset.index);
  const source=index===-1?batch:dayEntry(selectedDay)?.windows?.[index];
  if(!source)throw Error('Select an available time window first.');
  popup={
    type:'clock',source:index===-1?'batch':'single',date:selectedDay,index,
    start:source.start,end:source.end,which:element.dataset.which,
    stage:'hour',error:'',
  };
  render();
}
function chooseOnClock(value) {
  if(!popup||popup.type!=='clock')return;
  const p=popup;
  const current=p[p.which]==='24:00'?'23:00':p[p.which];
  let hour=Number(current.slice(0,2)),minute=Number(current.slice(3));
  if(p.stage==='hour'){
    hour=preferenceClock==='24'?value:(value%12)+(hour>=12?12:0);
    p.stage='minute';
  }else minute=value;
  p[p.which]=clock(hour*60+minute);
  p.error='';
  redrawClockOnly();
}
function saveClockRange(){
  if(!popup||popup.type!=='clock')return;
  const p=popup;
  try{
    if(minutes(p.start)>=minutes(p.end))throw Error('Until must be later than From.');
    if(p.source==='batch'){
      // Batch edits only apply after the user's separate review confirmation.
      batch.start=p.start;batch.end=p.end;
    }else{
      if(selectedDay!==p.date)throw Error('That day changed. Please reopen the time editor.');
      const day=copy(dayEntry(p.date));
      if(!day||day.status!=='available'||!day.windows[p.index])
        throw Error('The time window no longer exists.');
      day.windows[p.index].start=p.start;
      day.windows[p.index].end=p.end;
      const duration=minutes(p.end)-minutes(p.start);
      if(day.windows[p.index].maxMinutes>duration)
        day.windows[p.index].maxMinutes=duration;
      // Validate all windows together; do not save an invalid intermediate time.
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
    body='<p class="hint">Selected days will receive <strong>'+esc(summary(popup.day))+'</strong>.</p>'+
      '<div class="preview-list">'+popup.dates.map(d=>
        '<div><strong>'+esc(datestring(d,'mini'))+'</strong><span>'+
        esc(summary(dayEntry(d)))+' → '+esc(summary(popup.day))+'</span></div>').join('')+'</div>';
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
  }else if(popup.type==='template'){
    title=model.template?'Update your usual week?':'Save your usual week?';
    body='<p class="hint">This will be used as your starting point for future scheduling rounds. '+
      'It will never automatically submit availability.</p>';
    confirm=model.template?'Update my template':'Save my template';
  }
  return '<div class="overlay" data-action="dismiss-overlay"><div class="dialog" role="dialog" aria-modal="true" aria-label="'+esc(title)+'">'+
    '<div class="dialog-header"><h2>'+esc(title)+'</h2>'+
    makeButton('×','dismiss','icon-button')+'</div>'+body+
    '<div class="bottom-actions">'+makeButton('Cancel','dismiss','outline')+
    makeButton(confirm,'confirm-popup','primary',popup.type==='copy'&&!popup.dates.length?'disabled':'')+
    '</div></div></div>';
}
let lastEditorKey='';
function render(){
  if(!model)return;
  const oldY=window.scrollY;
  const editorKey=view==='week'?(multi?'batch':selectedDay):'';
  const editorScroll=editorKey===lastEditorKey?
    root.querySelector('.workspace>.editor-card')?.scrollTop||0:0;
  const content=view==='review'?reviewPage():view==='done'?donePage():
    '<div class="workspace">'+weekCard()+(multi?batchEditor():singleEditor())+'</div>';
  root.innerHTML='<main class="app-shell">'+stageHeader()+
    (notice?'<div class="message '+(noticeError?'danger':'')+'" role="status">'+esc(notice)+'</div>':'')+
    content+
    (view==='week'?'<footer class="action-footer"><div><strong>'+
      (!model.member.submitted?'Draft · Not submitted':
        JSON.stringify(model.member.draft)===JSON.stringify(model.member.submitted)?
          'Submitted · You can edit your response':'Changes not yet submitted')+
      '</strong><small>Edits save automatically. Review is required to submit.</small></div>'+
      makeButton('Review week →','review','primary')+'</footer>':'')+
    '<div class="privacy-note">TEST ONLY · Your answers stay in the isolated WinterBot testing system.</div>'+
    popupHtml()+'</main>';
  window.scrollTo(0,oldY);
  const editor=root.querySelector('.workspace>.editor-card');
  if(editor&&editorScroll)editor.scrollTop=editorScroll;
  lastEditorKey=editorKey;
  if(view==='review')setupReviewScroll();
}
function setupReviewScroll(){
  const list=root.querySelector('.review-list');
  if(!list)return;
  const update=()=>{
    const overflows=list.scrollHeight>list.clientHeight+2;
    if(!overflows||list.scrollTop+list.clientHeight>=list.scrollHeight-3)
      reviewSeenBottom=true;
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
function freeWindow(day){
  const occupied=(day?.windows||[]).map(w=>[minutes(w.start),minutes(w.end)])
    .sort((a,b)=>a[0]-b[0]);
  let current=9*60;
  for(const [start,end] of occupied){
    if(start-current>=30)return {start:clock(current),end:clock(Math.min(start,current+120)),
      kind:'confirmed',maxMinutes:null};
    current=Math.max(current,end);
  }
  if(1440-current>=30)return {start:clock(current),end:clock(Math.min(1440,current+120)),
    kind:'confirmed',maxMinutes:null};
  current=0;
  for(const [start,end] of occupied){
    if(start-current>=30)return {start:clock(current),end:clock(Math.min(start,current+120)),
      kind:'confirmed',maxMinutes:null};
    current=end;
  }
  if(1440-current>=30)return {start:clock(current),end:clock(Math.min(1440,current+120)),
    kind:'confirmed',maxMinutes:null};
  throw Error('No free time remains on this day. Adjust an existing range.');
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
      changeMany(active.dates,active.day);
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
    if(active.type==='template'){
      await flushAll();
      const response=await request('ux/template-save',{confirm:true});
      model=response;popup=null;notice='Usual week saved for future rounds.';render();return;
    }
  }catch(error){actionError(error);}
}
function openBatchConfirmation(){
  const dates=model.round.dates.filter(d=>chosen.has(d));
  if(!dates.length)throw Error('Select one or more days.');
  const day=batch.mode==='off'?{status:'unavailable',windows:[]}:
    batch.mode==='all'?allDay(batch.kind):validateDay({status:'available',windows:[
      {start:batch.start,end:batch.end,kind:batch.kind,maxMinutes:null},
    ]});
  const replacing=dates.some(d=>dayEntry(d));
  if(replacing){popup={type:'batch',dates,day};render();}
  else{changeMany(dates,day);multi=false;chosen.clear();notice='Availability applied to '+dates.length+' days.';render();}
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
        popup.stage='hour';popup.error='';
        redrawClockOnly();return;
      }
      if(action==='clock-stage'){
        popup.stage=element.dataset.stage;
        redrawClockOnly();return;
      }
      if(action==='clock-choice'){chooseOnClock(Number(element.dataset.value));return;}
      if(action==='clock-ampm'){
        const current=popup[popup.which]==='24:00'?'23:00':popup[popup.which];
        const h=Number(current.slice(0,2))%12;
        popup[popup.which]=clock((element.dataset.ampm==='PM'?12:0)*60+h*60+
          Number(current.slice(3)));
        popup.error='';redrawClockOnly();return;
      }
      if(action==='clock-endday'){
        popup.end='24:00';popup.which='end';popup.stage='hour';
        popup.error='';redrawClockOnly();return;
      }
      if(action==='clock-save'){saveClockRange();return;}
    }
    if(action==='confirm-popup'){confirmPopup();return;}
    if(action==='pick-day'){selectDay(element.dataset.date);return;}
    if(action==='multi'){
      multi=!multi;chosen.clear();notice='';render();return;
    }
    if(action==='set-hours'){
      const day=dayEntry(selectedDay);
      if(day?.status!=='available')
        changeDay(selectedDay,{status:'available',windows:[{
          start:'18:00',end:'23:00',kind:'confirmed',maxMinutes:null,
        }]});
      return;
    }
    if(action==='all-day'){changeDay(selectedDay,allDay());return;}
    if(action==='unavailable'){changeDay(selectedDay,{status:'unavailable',windows:[]});return;}
    if(action==='clear-day'){changeDay(selectedDay,null);return;}
    if(action==='add-window'){
      const day=dayEntry(selectedDay);
      const result=day?.status==='available'?copy(day):{status:'available',windows:[]};
      result.windows.push(freeWindow(result));
      changeDay(selectedDay,result);return;
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

    if(action==='batch-mode'){batch.mode=element.dataset.mode;render();return;}
    if(action==='apply-batch'){openBatchConfirmation();return;}
    if(action==='copy'){
      if(!dayEntry(selectedDay))throw Error('Enter availability for this day before copying it.');
      popup={type:'copy',dates:[]};render();return;
    }
    if(action==='reuse'){if(!model.template)throw Error('No usual week is saved yet.');
      popup={type:'reuse'};render();return;}
    if(action==='save-template'){
      if(!model.member.submitted)throw Error('Submit your week before saving a template.');
      popup={type:'template'};render();return;
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
  if(element.hasAttribute('data-batch')){
    const field=element.dataset.batch;
    batch[field]=element.value;
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
