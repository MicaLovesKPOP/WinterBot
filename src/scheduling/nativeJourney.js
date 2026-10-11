'use strict';

// Complete, PRIVATE-GUILD-ONLY WinterBot planning experience in Discord.
// Reuses the real core optimizer, candidate selection and vote mathematics.
// Does not call Discord Scheduled Event creation, role assignment or channel
// creation APIs. The final check-in/permissions lifecycle is simulated.
const crypto=require('node:crypto');
const path=require('node:path');
const {DateTime}=require('luxon');
const {
  EmbedBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,
  StringSelectMenuBuilder,ModalBuilder,TextInputBuilder,TextInputStyle,
  MessageFlags,PermissionFlagsBits,
}=require('discord.js');
const {
  createRound,enroll,setDays,listDays,allowedWindowForDate,minuteOf,
  closeCollection,visibleCandidates,startVote,castVote,closeVote,getSlot,stats,
}=require('./core');
const {PreviewStore,GRACE_MINUTES}=require('./nativePrototypeState');

const COLOR=0x8e90f2,GOOD=0x42b797,WARN=0xe4b46d;
const fmtTime=iso=>DateTime.fromISO(iso,{setZone:true})
  .setZone('Europe/Amsterdam').toFormat('ccc dd LLL, HH:mm');
const dateText=date=>DateTime.fromISO(date).toFormat('ccc dd LLL');
const id=()=>crypto.randomBytes(6).toString('hex');
const key=(action,sid='')=>'wbflow:'+action+(sid?':'+sid:'');
const row=(...controls)=>new ActionRowBuilder().addComponents(...controls);
const btn=(action,sid,label,style=ButtonStyle.Secondary,disabled=false)=>
  new ButtonBuilder().setCustomId(key(action,sid)).setLabel(label)
    .setStyle(style).setDisabled(disabled);
const payload=(embeds,components=[],privateReply=true)=>({
  embeds:Array.isArray(embeds)?embeds:[embeds],components,
  ...(privateReply?{flags:MessageFlags.Ephemeral}:{}),
  allowedMentions:{parse:[]},
});
const cap=(text,length=1024)=>String(text).slice(0,length);
const validate=(ok,message)=>{if(!ok)throw Error(message);};
function textField(id,label,initial,{min=0,max=100,required=true,placeholder}={}){
  const input=new TextInputBuilder().setCustomId(id).setLabel(label)
    .setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(max);
  if(min)input.setMinLength(min);
  if(initial!==undefined&&initial!==null)input.setValue(String(initial));
  if(placeholder)input.setPlaceholder(placeholder);
  return row(input);
}
function panel(title,body,{accent=COLOR,footer='ISOLATED TEST · no real Discord events, channels or roles'}={}){
  return new EmbedBuilder().setColor(accent).setTitle(title)
    .setDescription(cap(body,4000)).setFooter({text:footer});
}
function values(modal,fields){return Object.fromEntries(fields.map(k=>[
  k,String(modal.fields.getTextInputValue(k)||'').trim(),
]));}
function localMonday(now){
  return DateTime.fromJSDate(new Date(now)).setZone('Europe/Amsterdam')
    .startOf('week').plus({weeks:1}).toISODate();
}
function validDate(value){
  const d=DateTime.fromISO(value,{zone:'Europe/Amsterdam'});
  return d.isValid&&d.toISODate()===value;
}
function hours(value){
  const parts=String(value).split(/\s*[-–—]\s*/);
  validate(parts.length===2,'Use a time window like 12:00-24:00.');
  const a=minuteOf(parts[0]),b=minuteOf(parts[1],true);
  validate(b>a,'End time must be later than start time.');
  return {start:parts[0],end:parts[1]};
}
function choicesFor(round,minAttendance){
  return visibleCandidates(round).filter(c=>c.count>=minAttendance);
}
function configured(round){
  return listDays(round).map(d=>{
    const allowed=allowedWindowForDate(round,d);
    return '**'+dateText(d)+'** · '+allowed.start+'–'+allowed.end;
  }).join('\n');
}
function samplesLabel(journey){
  return journey.sampleIds?.length?
    ' ('+journey.sampleIds.length+' clearly labeled **sample attendees**)':'';
}
function attendance(round){
  const s=stats(round);
  return '**'+s.completed+'/'+s.participantCount+'** completed responses'+
    (s.started>s.completed?' · '+s.started+' started':'');
}
function resultLines(journey){
  const r=journey.round;
  const eligible=choicesFor(r,journey.options.minAttendance);
  const ranked=eligible.slice(0,7);
  if(!ranked.length)return 'No qualifying time suggestions yet. '+
    'A candidate must cover the full event duration and satisfy the minimum '+
    'attendance setting ('+journey.options.minAttendance+').';
  return ranked.map((c,i)=>'**'+(i+1)+'. '+dateText(c.date)+
    '** · '+c.slots[0].time+' · '+c.durationMinutes+' min · **'+c.count+
    ' attending**'+(c.slots.length>1?' ('+c.slots.length+' possible starts)':'')).join('\n');
}
function modalNew(now){
  return new ModalBuilder().setCustomId(key('new')).setTitle('New test planning round')
    .addComponents(
      textField('title','Event name','Game Night',{min:3,max:90}),
      textField('first','First candidate date (YYYY-MM-DD)',localMonday(now)),
      textField('days','Number of candidate days (1-14)','7',{max:2}),
      textField('hours','Allowed event hours, HH:mm-HH:mm','12:00-24:00',{max:11}),
      textField('duration','Event duration in minutes','120',{max:3}),
    );
}
function modalAdvanced(j){
  return new ModalBuilder().setCustomId(key('advanced',j.id))
    .setTitle('Advanced planning settings')
    .addComponents(
      textField('duration','Min-max duration, minutes',
        j.round.minDurationMinutes+'-'+j.round.maxDurationMinutes),
      textField('minPeople','Minimum attendance',j.options.minAttendance,{max:2}),
      textField('collection','Collect answers for (hours)',j.round.collectionHours,{max:3}),
      textField('vote','Voting deadline (hours)',j.round.voteHours,{max:3}),
      textField('precision','Start-time step in minutes',j.round.stepMinutes,{max:2}),
    );
}
function modalHours(j,date){
  const lim=allowedWindowForDate(j.round,date);
  return new ModalBuilder().setCustomId(key('hours',j.id)+':'+date)
    .setTitle('Availability · '+date)
    .addComponents(
      textField('start','Available from, HH:mm',lim.start),
      textField('end','Available until, HH:mm',lim.end),
      textField('moreStart','Second window from (optional)','',{required:false}),
      textField('moreEnd','Second window until (optional)','',{required:false}),
      textField('limit','Maximum stay in minutes (optional)','',{required:false}),
    );
}
function dashboard(journey){
  if(!journey)return payload(panel('WinterBot · Organizer tests',
    'Build a complete test planning round inside Discord. The existing attendance '+
    'engine, voting logic and event lifecycle are reused; final channel and role '+
    'changes are **simulated only**.\n\nUse **New test round** to begin.'),
    [row(btn('new','','New test round',ButtonStyle.Primary))]);
  const r=journey.round,s=stats(r),sid=journey.id;
  let description='**'+r.title+'** · '+r.phase.toUpperCase()+'\n'+
    '**Dates:** '+dateText(r.startDate)+' – '+dateText(r.endDate)+'\n'+
    '**Event hours:** '+allowedWindowForDate(r,r.startDate).start+'–'+
      allowedWindowForDate(r,r.startDate).end+'\n'+
    '**Duration:** '+r.minDurationMinutes+'–'+r.maxDurationMinutes+' min\n'+
    '**Minimum attendance:** '+journey.options.minAttendance+
    ' · **Start precision:** '+r.stepMinutes+' min\n'+
    '**Collection deadline:** <t:'+Math.floor(Date.parse(r.collectionClosesAt)/1000)+':f>\n'+
    attendance(r)+samplesLabel(journey)+'\n'+
    '**Invitation:** '+(journey.messages.invite?'Posted in #winterbot-testing':'Not posted yet');
  if(r.phase!=='collecting')description+='\n\n**Best counted attendance:** '+r.bestAttendance+
    '\n**Qualifying suggestions:** '+choicesFor(r,journey.options.minAttendance).length;
  if(journey.event)description+='\n\n**Test event:** '+journey.event.status+
    ' · '+dateText(journey.event.date);
  const controls=[
    row(btn('new','','New test round'),
      btn('refresh',sid,'Refresh',ButtonStyle.Secondary)),
  ];
  if(r.phase==='collecting'){
    controls.push(row(btn('advanced',sid,'Advanced settings',
      ButtonStyle.Secondary,Boolean(r.participants.length)),
      btn('invite',sid,'Publish invitation',ButtonStyle.Primary,Boolean(journey.messages.invite))));
    controls.push(row(btn('sample',sid,'Load 8 sample attendees',
      ButtonStyle.Secondary,Boolean(journey.sampleIds.length)),
      btn('close',sid,'Close collection / Results',ButtonStyle.Success)));
  }else if(journey.event){
    controls.push(row(btn('event',sid,'Event & check-in simulation',ButtonStyle.Primary),
      btn('results',sid,'Results')));
  }else controls.push(row(btn('results',sid,'Attendance results',ButtonStyle.Primary)));
  return payload(panel('Organizer · '+r.title,description),controls);
}
function invitation(journey){
  const r=journey.round;
  return payload(panel('[TEST] Availability invitation', '**'+r.title+'**\n\n'+
    'Candidate dates:\n'+configured(r)+'\n\n'+
    'Event duration: '+r.minDurationMinutes+'–'+r.maxDurationMinutes+' minutes.\n'+
    'Submit **confirmed availability** or mark a date unavailable. All dates '+
    'must be reviewed before submitting. Alternatively, you can **import a '+
    'previously reviewed Activity submission** when its dates match this round; '+
    'the import shows exact converted hours before confirmation.\n\n'+
    'Deadline: <t:'+Math.floor(Date.parse(r.collectionClosesAt)/1000)+':R>.',
    {accent:COLOR}),[row(btn('join',journey.id,'Enter test availability',ButtonStyle.Primary),
      btn('import',journey.id,'Import reviewed Activity week'))],false);
}
function personPanel(journey,uid,{review=false}={}){
  const r=journey.round,draft=journey.drafts[uid]||{};
  const dates=listDays(r),picked=journey.selectedDay[uid]||dates[0];
  const complete=dates.every(d=>draft[d]&&draft[d].status!=='unanswered');
  const explanation=dates.map(d=>{
    const day=draft[d],label=day?
      day.status==='unavailable'?'Unavailable':
      day.windows.map(w=>w.start+'–'+w.end).join(', '):
      'Not answered';
    return (day?'✓ ':'○ ')+'**'+dateText(d)+'** · '+label;
  }).join('\n');
  const text='**'+r.title+'** · **Draft only** (not submitted)\n'+
    explanation+'\n\n'+(review?'**Review every date above before submitting.**':
    'Choose a date, edit it, then review the complete week.')+
    '\n\nCurrently selected: **'+dateText(picked)+'**.';
  const select=new StringSelectMenuBuilder().setCustomId(key('date',journey.id))
    .setPlaceholder('Choose date to edit').setMinValues(1).setMaxValues(1)
    .addOptions(dates.map(d=>({label:dateText(d),
      value:d,description:draft[d]?
        (draft[d].status==='unavailable'?'Unavailable':'Available'):'Not answered',
      default:d===picked})));
  return payload(panel(review?'Review test availability':'My test availability',text),
    review?[row(btn('person',journey.id,'Back to editing'),
      btn('submit',journey.id,'Confirm & submit',ButtonStyle.Success,!complete))]:
    [row(select),
      row(btn('hours',journey.id,'Set available hours',ButtonStyle.Primary),
        btn('off',journey.id,'Unavailable'),btn('dayall',journey.id,'All permitted hours')),
      row(btn('review',journey.id,'Review before submitting',ButtonStyle.Success))]);
}

function candidateLabel(c){
  return dateText(c.date)+' · '+c.slots[0].time+' · '+c.count+' attending';
}
function resultsPanel(journey,uid){
  const r=journey.round,sid=journey.id;
  const opts=choicesFor(r,journey.options.minAttendance).slice(0,20);
  const selected=(journey.selectedCandidates[uid]||[]).filter(x=>opts.some(o=>o.id===x));
  const stage=r.phase==='review'?'Choose options for voting or a test event':
    r.phase==='voting'?'Voting in progress':r.phase==='final'?'Voting complete · choose an event':
      r.phase==='collecting'?'Still collecting availability':'Test event selected';
  let description='**'+r.title+'**\n'+attendance(r)+samplesLabel(journey)+
    '\n**Minimum required:** '+journey.options.minAttendance+
    '\n**Best attendance:** '+r.bestAttendance+'\n\n**Suggested dates and times**\n'+
    resultLines(journey)+'\n\n'+stage;
  if(r.ballot){
    const voted=Object.keys(r.ballot.votes).length;
    description+='\n\n**Ballot:** '+r.ballot.options.length+' options · '+
      voted+' participant vote(s) · '+(r.ballot.closedAt?'Closed':'Open')+
      (r.ballot.closedAt?'\n'+r.ballot.options.map(o=>
        dateText(o.date)+' '+o.time+' — '+o.votes+' votes'+
        (r.ballot.winnerIds.includes(o.id)?' (winner/tied)':'')).join('\n'):'');
  }
  const controls=[];
  if(opts.length&&r.phase!=='voting'&&!journey.event){
    controls.push(row(new StringSelectMenuBuilder()
      .setCustomId(key('choose',sid))
      .setPlaceholder('Select times for a vote or test event')
      .setMinValues(1).setMaxValues(Math.min(5,opts.length))
      .addOptions(opts.map(c=>({
        label:cap(candidateLabel(c),100),
        description:cap(c.durationMinutes+' min · '+c.slots.length+' possible start(s)',100),
        value:c.id,default:selected.includes(c.id),
      })))));
  }
  if(r.phase==='review'){
    controls.push(row(btn('times',sid,'Choose exact start times',
      ButtonStyle.Secondary,selected.length===0)));
    controls.push(row(btn('startvote',sid,'Put selected times to vote',
      ButtonStyle.Primary,selected.length<2),
      btn('approve',sid,'Approve 1 test event',
        ButtonStyle.Success,selected.length!==1)));
  }else if(r.phase==='voting'){
    controls.push(row(btn('votepanel',sid,'Open test ballot'),
      btn('endvote',sid,'Close voting / Results',ButtonStyle.Primary)));
  }else if(r.phase==='final'&&!journey.event){
    controls.push(row(btn('times',sid,'Choose exact start time',
      ButtonStyle.Secondary,selected.length!==1)));
    controls.push(row(btn('approve',sid,'Approve 1 test event',ButtonStyle.Success,
      selected.length!==1)));
  }
  controls.push(row(btn('refresh',sid,'Organizer overview'),btn('new','','New test round')));
  return payload(panel('Attendance results · '+r.title,description,{
    accent:r.phase==='final'?GOOD:COLOR,
  }),controls);
}
function exactTimesPanel(journey,uid){
  const sid=journey.id,r=journey.round;
  const ids=(journey.selectedCandidates[uid]||[])
    .filter(cid=>choicesFor(r,journey.options.minAttendance).some(c=>c.id===cid));
  validate(ids.length>0,'Select a candidate on the attendance board first.');
  const all=choicesFor(r,journey.options.minAttendance);
  const focus=ids.includes(journey.focusedCandidate[uid])?
    journey.focusedCandidate[uid]:ids[0];
  const candidate=all.find(c=>c.id===focus);
  const maxPage=Math.max(0,Math.ceil(candidate.slots.length/25)-1);
  const page=Math.min(journey.startPages[uid]||0,maxPage);
  const selectedStart=journey.chosenStarts[uid]?.[focus]||candidate.slots[0].startAt;
  const overview=ids.map(cid=>{
    const c=all.find(c=>c.id===cid);
    const chosen=journey.chosenStarts[uid]?.[cid]||c.slots[0].startAt;
    return (cid===focus?'**► ':'• ')+dateText(c.date)+
      ' · '+DateTime.fromISO(chosen).setZone(r.timezone).toFormat('HH:mm')+
      ' · '+c.durationMinutes+' min'+(cid===focus?'**':'');
  }).join('\n');
  const rows=[];
  if(ids.length>1)rows.push(row(new StringSelectMenuBuilder()
    .setCustomId(key('timecandidate',sid))
    .setPlaceholder('Which candidate should be timed?')
    .addOptions(ids.map(cid=>{
      const c=all.find(c=>c.id===cid);
      return {label:cap(candidateLabel(c),100),value:cid,default:cid===focus};
    }))));
  rows.push(row(new StringSelectMenuBuilder()
    .setCustomId(key('timeslot',sid))
    .setPlaceholder('Exact local start time')
    .addOptions(candidate.slots.slice(page*25,(page+1)*25).map(s=>({
      label:DateTime.fromISO(s.startAt).setZone(r.timezone).toFormat('HH:mm')+
        '–'+DateTime.fromISO(s.endAt).setZone(r.timezone).toFormat('HH:mm'),
      description:dateText(candidate.date)+' · '+candidate.count+' attending',
      value:s.startAt,default:selectedStart===s.startAt,
    })))));
  if(maxPage>0)rows.push(row(
    btn('prevslots',sid,'Previous starts',ButtonStyle.Secondary,page===0),
    btn('nextslots',sid,'More starts',ButtonStyle.Secondary,page===maxPage)));
  rows.push(row(btn('results',sid,'Back to results',ButtonStyle.Primary)));
  return payload(panel('Exact event times · TEST', overview+
    '\n\n**Editing:** '+dateText(candidate.date)+' · '+
    'candidate group '+(ids.indexOf(focus)+1)+'/'+ids.length+
    '.\nUse the dropdown to choose a precise start. The organizer preview and '+
    'subsequent vote or event will use that start; a voted-on winner’s start '+
    'cannot change after voting.\n'+
    (maxPage>0?'\nStart-time page '+(page+1)+'/'+(maxPage+1):'')),rows);
}

function voteInvitation(journey){
  const r=journey.round;
  return payload(panel('[TEST] Vote on event times', '**'+r.title+'**\n\n'+
    r.ballot.options.map((o,i)=>
      '**'+(i+1)+'.** '+fmtTime(o.startAt)+' · '+o.durationMinutes+' min').join('\n')+
    '\n\nChoose any number of options (including none). You may update your vote '+
    'until the voting period closes. No actual Discord event will be created.\n\n'+
    'Voting closes <t:'+Math.floor(Date.parse(r.ballot.closesAt)/1000)+':R>.'),
    [row(btn('votepanel',journey.id,'Vote in Discord',ButtonStyle.Primary))],false);
}
function votePanel(journey,uid){
  const r=journey.round,sid=journey.id;
  const options=r.ballot?.options||[],picked=journey.draftVotes[uid]||
    r.ballot?.votes[uid]||[];
  const lines=options.map((o,i)=>{
    const marked=picked.includes(o.id)?'✓':'○';
    return marked+' **'+(i+1)+'.** '+fmtTime(o.startAt)+' · '+
      o.durationMinutes+' minutes';
  }).join('\n');
  const select=new StringSelectMenuBuilder().setCustomId(key('voteselect',sid))
    .setPlaceholder('Select preferred times (you may choose none)')
    .setMinValues(0).setMaxValues(options.length)
    .addOptions(options.map((o,i)=>({
      label:cap((i+1)+'. '+fmtTime(o.startAt),100),value:o.id,
      description:o.durationMinutes+' minutes',default:picked.includes(o.id),
    })));
  return payload(panel('My test vote · '+r.title,
    lines+'\n\n**Choose every time you prefer.** Saving an empty selection means '+
    'you support none of the options.'),
    [row(select),row(btn('savevote',sid,'Save my vote',ButtonStyle.Primary))]);
}
function eventSimulationPanel(journey,uid,manager){
  const e=journey.event,sid=journey.id;
  validate(e,'No test event has been approved yet.');
  const names=[
    e.options.checkinChannel?'#event-check-in (simulated)':'No separate check-in channel',
    e.options.chat?'#event-chat (simulated)':'Event chat disabled',
    e.options.voice?'Event voice (simulated)':'Event voice disabled',
  ];
  const checked=e.checkedIn?.[uid]||null;
  const archived=e.status==='ended'&&e.options.persistentChat;
  let description='**'+journey.round.title+'**\n'+
    '**Time:** '+fmtTime(e.startAt)+' – '+
      DateTime.fromISO(e.endAt).setZone('Europe/Amsterdam').toFormat('HH:mm')+
    '\n**State:** '+e.status.replaceAll('-',' ')+
    '\n**Attendees eligible:** '+e.eligibleIds.length+
    '\n**Checked in:** '+Object.keys(e.checkedIn||{}).length+
    '\n**Check-in normally opens:** <t:'+Math.floor(Date.parse(e.checkinOpensAt)/1000)+':f> '+
    '('+e.options.checkInMinutes+' minutes before start)\n'+
    '**Late check-in:** '+(e.options.lateCheckins?'Allowed':'Closed at event start')+
    ' · **Overtime:** '+(e.options.overtime?'Manual moderator ending':'Disabled')+
    '\n**Wrap-up grace:** '+e.options.graceMinutes+' minutes\n\n'+
    '**Planned channels (PREVIEW ONLY)**\n'+names.join('\n')+
    '\n\n**Event role:** simulated; would be granted only upon check-in. '+
    'No permissions, channels or roles have been changed.';
  if(e.status==='grace')
    description+='\n\n**Wrap-up deadline:** <t:'+Math.floor(Date.parse(e.graceEndsAt)/1000)+':R> '+
      '(new check-ins blocked).';
  if(archived)description+='\n\n**Persistent chat:** would remain moderator-only, read-only.';
  if(checked)description+='\n\n**Your test check-in:** ✓ simulated access granted.';
  const controls=[];
  if(manager){
    if(e.status==='planned')controls.push(row(
      btn('eventopts',sid,'Advanced channel settings'),
      btn('opencheck',sid,'Open check-in [TEST]',ButtonStyle.Primary)));
    if(e.status==='checkin-open')controls.push(row(
      btn('start',sid,'Start event [TEST]',ButtonStyle.Primary),
      btn('eventopts',sid,'Advanced settings')));
    if(e.status==='running')controls.push(row(
      btn('beginend',sid,'Start grace / End event',ButtonStyle.Primary)));
    if(e.status==='grace'){
      if(e.confirmNow)controls.push(row(
        btn('confirmend',sid,'Confirm end now',ButtonStyle.Danger),
        btn('keepend',sid,'Keep countdown')));
      else controls.push(row(
        btn('extend1',sid,'+1 minute'),btn('extend5',sid,'+5 minutes'),
        btn('cancelend',sid,'Cancel ending',ButtonStyle.Secondary),
        btn('endnow',sid,'End now',ButtonStyle.Danger)));
    }
    controls.push(row(btn('results',sid,'Back to attendance results')));
  }
  if(e.status==='checkin-open'||e.status==='running'){
    controls.push(row(btn('checkin',sid,checked?'Checked in ✓':'Check in (simulation)',
      ButtonStyle.Success,Boolean(checked)),
      btn('access',sid,'My access preview')));
  }else controls.push(row(btn('access',sid,'My access preview')));
  return payload(panel('Event, check-in & channels · TEST',description,{
    accent:e.status==='ended'?0x838c9d:GOOD,
  }),controls);
}
function publicEvent(journey){
  const e=journey.event,r=journey.round;
  const open=e.status==='checkin-open'||
    (e.status==='running'&&e.options.lateCheckins);
  const stateLine=e.status==='planned'?'Check-in has not opened yet.':
    e.status==='checkin-open'?'Check-in is OPEN (test simulation).':
    e.status==='running'?(open?'Event in progress; late check-ins allowed.':
      'Event in progress; late check-ins closed.'):
    e.status==='grace'?'Wrapping up; new check-ins closed.':
      'Event closed; simulated access has been revoked.';
  return payload(panel('[TEST] Event and check-in invitation',
    '**'+r.title+'**\n'+fmtTime(e.startAt)+' · '+
    e.durationMinutes+' minutes\n\n**'+stateLine+'**\n'+
    'Checked in: **'+Object.keys(e.checkedIn).length+'**\n'+
    'Check-in normally opens '+e.options.checkInMinutes+
    ' minutes before start. A moderator may trigger it for testing.\n'+
    '**No actual roles, channels or permissions are created.**'),
    [row(btn('checkin',journey.id,'Check in (test)',ButtonStyle.Success,!open),
      btn('access',journey.id,'My access preview'))],false);
}
function accessPanel(journey,uid){
  const e=journey.event;
  validate(e,'No event selected yet.');
  const checked=Boolean(e.checkedIn[uid]);
  const ended=e.status==='ended';
  const access=checked&&!ended?'UNLOCKED (simulated)':ended?'CLOSED':'LOCKED';
  const ch=e.options;
  return payload(panel('My simulated event access',
    '**'+journey.round.title+'**\n'+
    '**Check-in:** '+(checked?'✓ checked in':'Not checked in')+
    '\n**Event role:** '+(checked&&!ended?'Would be granted':'Not granted')+
    '\n**Event chat:** '+(ch.chat?access:'Not requested')+
    '\n**Event voice:** '+(ch.voice?access:'Not requested')+
    '\n**Check-in channel:** '+(ch.checkinChannel?'Would be created':'Not requested')+
    '\n**When ending:** temporary channels would be removed after the configured '+
    'grace period.'+(ended&&ch.persistentChat?
      '\n**Archive:** moderator-only, read-only chat retained.':'')+
    '\n\nThis is an inspection of the planned behavior. **No real Discord access changes occur.**'),
    [row(btn('event',journey.id,'Back to event'))]);
}
function eventOptionsPanel(journey){
  const e=journey.event;
  const options=e.options,sid=journey.id;
  const toggle=(action,label,value)=>btn(action,sid,
    (value?'✓ ':'○ ')+label,value?ButtonStyle.Success:ButtonStyle.Secondary);
  return payload(panel('Advanced event settings · TEST',
    'Server defaults are shown below. This page affects only the **simulated** '+
    'test event; no channel or role changes occur.\n\n'+
    '**Check-in begins:** '+options.checkInMinutes+' minutes before event\n'+
    '**Wrap-up grace:** '+options.graceMinutes+' minutes\n'+
    '**Persistent chat:** if enabled, moderators retain a read-only archive '+
      'after participants lose access.'),
    [row(toggle('optchat','Event chat',options.chat),
      toggle('optvoice','Voice channel',options.voice)),
     row(toggle('optcheckchannel','Check-in channel',options.checkinChannel),
      toggle('optarchive','Persistent mod archive',options.persistentChat)),
     row(toggle('optlate','Late check-ins',options.lateCheckins),
      toggle('optovertime','Manual overtime',options.overtime)),
     row(new StringSelectMenuBuilder().setCustomId(key('grace',sid))
      .setPlaceholder('Wrap-up grace period').setMinValues(1).setMaxValues(1)
      .addOptions(GRACE_MINUTES.map(n=>({label:n+' minutes'+(n===5?' (default)':''),
        value:String(n),default:n===options.graceMinutes})))),
     row(btn('event',sid,'Back to event',ButtonStyle.Primary))]);
}

function minute5(value){
  if(value==='24:00')return 1440;
  validate(/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value)),
    'Activity supplied an invalid time.');
  const [h,m]=value.split(':').map(Number);
  validate(m%5===0,'Activity times must use five-minute increments.');
  return h*60+m;
}
function fromMinute(m){return m===1440?'24:00':
  String(Math.floor(m/60)).padStart(2,'0')+':'+
  String(m%60).padStart(2,'0');}
function convertActivitySubmission(snapshot,round){
  const source=snapshot?.member?.submitted;
  validate(source&&typeof source==='object',
    'Submit and review your availability in the calendar Activity first.');
  const dates=listDays(round),hours=[];
  validate(dates.every(date=>Object.hasOwn(source,date)),
    'Your submitted Activity week does not cover all candidate dates. '+
    'Use the native test editor or start a matching Activity week.');
  let excludedTentative=0,rounded=0,dropped=0;
  for(const date of dates){
    const day=source[date],bounds=allowedWindowForDate(round,date);
    if(day.status==='unavailable'){
      hours.push({date,status:'unavailable',windows:[],note:'Unavailable'});
      continue;
    }
    validate(day.status==='available'&&Array.isArray(day.windows),
      'The Activity submission contains an unsupported date status.');
    const permittedStart=minuteOf(bounds.start),permittedEnd=minuteOf(bounds.end,true);
    const windows=[];
    let tentativeHere=0;
    for(const window of day.windows){
      if(window.kind==='tentative'){
        excludedTentative++;tentativeHere++;
        continue;
      }
      validate(!window.kind||window.kind==='confirmed',
        'Unknown certainty in Activity submission.');
      const rawStart=minute5(window.start),rawEnd=minute5(window.end);
      const start=Math.ceil(Math.max(permittedStart,rawStart)/15)*15;
      const end=Math.floor(Math.min(permittedEnd,rawEnd)/15)*15;
      if(start!==rawStart||end!==rawEnd)rounded++;
      const max=window.maxMinutes==null?null:
        Math.floor(Number(window.maxMinutes)/15)*15;
      if(end-start<15||(max!==null&&max<15)){
        dropped++;continue;
      }
      windows.push({start:fromMinute(start),end:fromMinute(end),
        maxMinutes:max});
    }
    if(windows.length)hours.push({
      date,status:'available',windows:windows.sort((a,b)=>
        minuteOf(a.start)-minuteOf(b.start)),
      note:tentativeHere?'Tentative periods excluded from confirmed attendance':'',
    });
    else hours.push({date,status:'unavailable',windows:[],
      note:'No confirmed 15-minute availability (tentative is not counted)'});
  }
  const signature=crypto.createHash('sha256').update(JSON.stringify({
    roundId:round.id,dates,submittedAt:snapshot.member.submittedAt,
    source,
  })).digest('hex');
  return {signature,hours,sourceSubmittedAt:snapshot.member.submittedAt,
    excludedTentative,rounded,dropped};
}
function importPanel(journey,imported){
  const lines=imported.hours.map(entry=>
    '**'+dateText(entry.date)+'** · '+
    (entry.status==='unavailable'?'Unavailable (confirmed attendance: none)':
      entry.windows.map(w=>w.start+'–'+w.end).join(', '))+
    (entry.note?' · '+entry.note:''));
  return payload(panel('Review Activity import · TEST',
    '**'+journey.round.title+'**\n\n'+lines.join('\n')+
    '\n\n**Conversion before counting attendance:**\n'+
    '• Five-minute inputs are conservatively rounded **inward** to 15-minute boundaries.\n'+
    '• Tentative windows are **not counted as confirmed attendance**.\n'+
    '• Dates and times are clipped to organizer limits; insufficient windows '+
      'remain unavailable.\n'+
    '**Summary:** '+imported.rounded+' rounded/clipped windows · '+
      imported.excludedTentative+' tentative windows excluded · '+
      imported.dropped+' too-short windows omitted.\n\n'+
    'Confirming will replace your submitted answer for this **test planning round**. '+
    'The Activity submission itself will not change.'),
    [row(btn('importconfirm',journey.id,'Confirm imported availability',
      ButtonStyle.Success),
      btn('join',journey.id,'Edit directly instead'))]);
}

const EVENT_DEFAULTS=Object.freeze({
  checkInMinutes:30,checkinChannel:true,chat:true,voice:true,
  persistentChat:false,lateCheckins:true,overtime:true,graceMinutes:5,
});
function createNativeJourney({client,guildId,channelId,dataFile,now=()=>new Date(),
  activityAvailability=null,logger=console.error}){
  const store=new PreviewStore(dataFile||
    path.join(process.cwd(),'scheduling-private-journey-test.json'));
  const isManager=interaction=>Boolean(interaction.guild?.ownerId===interaction.user?.id||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
  const assertLocation=interaction=>{
    validate(interaction.guildId===guildId&&interaction.channelId===channelId,
      'WinterBot test journeys only work in #winterbot-testing.');
    validate(interaction.user?.id&&!interaction.user.bot,'Only real test-server members can use this.');
  };
  const assertManager=interaction=>{
    assertLocation(interaction);
    validate(isManager(interaction),'Only test moderators can manage this planning round.');
  };
  const get=(state,sid)=>{
    validate(/^[0-9a-f]{12}$/.test(sid),'Invalid test journey ID.');
    const journey=state.journeys?.[sid];
    validate(journey,'Test journey not found. Ask an organizer to start another.');
    return journey;
  };
  const latest=()=>Object.values(store.read().journeys||{})
    .sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0]||null;
  const read=sid=>get(store.read(),sid);
  const mutate=async(sid,fn)=>store.transaction(state=>{
    const journey=get(state,sid);
    const result=fn(journey,state);
    return result===undefined?structuredClone(journey):result;
  });
  function assertCollecting(journey){
    validate(journey.round.phase==='collecting'&&
      new Date(now()).getTime()<Date.parse(journey.round.collectionClosesAt),
      'Availability collection has ended.');
  }
  function assertParticipant(journey,uid){
    validate(journey.round.participants.some(p=>p.id===uid),
      'Submit availability before voting on this round.');
  }
  function getSelection(journey,uid){
    return (journey.selectedCandidates[uid]||[])
      .filter(cid=>choicesFor(journey.round,journey.options.minAttendance)
        .some(c=>c.id===cid));
  }
  const messagePayload=ui=>{
    const {flags,...fields}=ui;
    return fields;
  };
  async function show(interaction,ui,{separate=false}={}){
    if(separate||interaction.isChatInputCommand?.())
      return interaction.reply(ui);
    if(interaction.isModalSubmit?.()&&!interaction.isFromMessage?.())
      return interaction.reply(ui);
    return interaction.update(messagePayload(ui));
  }
  const failure=async(interaction,error)=>{
    const body='WinterBot TEST: '+cap(error.message||error,260);
    const response={content:body,flags:MessageFlags.Ephemeral,
      allowedMentions:{parse:[]}};
    try{
      if(interaction.replied||interaction.deferred)await interaction.followUp(response);
      else await interaction.reply(response);
    }catch(err){logger('WinterBot isolated journey UI reply failed:',err.message);}
  };
  async function testChannel(){
    const channel=await client.channels.fetch(channelId);
    validate(channel?.guildId===guildId&&channel.isTextBased?.(),
      'The isolated test channel is unavailable.');
    return channel;
  }
  async function post(ui){
    const channel=await testChannel();
    return channel.send(messagePayload(ui));
  }
  function setup(){
    const list=Object.values(store.read().journeys||{})
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,5);
    const body='**All steps stay in this private server.** The organizer setup, '+
      'attendance calculations and optional voting reuse WinterBot’s existing scheduling engine. '+
      'Check-in, roles, channels and event ending are **simulated only**.\n\n'+
      (list.length?'**Recent test rounds:**\n'+list.map(j=>
        '• '+j.round.title+' · '+j.round.phase+' · '+dateText(j.round.startDate)).join('\n'):
        'No test planning rounds yet.');
    const controls=[row(btn('new','','Create planning round',ButtonStyle.Primary))];
    if(list.length)controls.push(row(new StringSelectMenuBuilder()
      .setCustomId(key('resume')).setPlaceholder('Open a previous test round')
      .setOptions(list.map(j=>({label:cap(j.round.title,100),value:j.id,
        description:cap(j.round.phase+' · '+j.round.startDate,100)})))));
    return payload(panel('WinterBot · Organizer journey',body),controls);
  }
  async function start(interaction){
    assertManager(interaction);
    await interaction.reply(setup());
  }
  async function results(interaction){
    assertManager(interaction);
    const journey=latest();
    await interaction.reply(journey?
      journey.round.phase==='collecting'?dashboard(journey):
      resultsPanel(journey,interaction.user.id):setup());
  }
  async function checkinView(interaction){
    assertLocation(interaction);
    const j=Object.values(store.read().journeys||{})
      .filter(j=>j.event).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
    await interaction.reply(j?eventSimulationPanel(j,interaction.user.id,
      isManager(interaction)):
      payload(panel('Check-in and event channels · TEST',
        'No test event has been approved yet. Create a round, submit or load '+
        'sample availability, close collection and approve a candidate.')));
  }
  const reset=()=>store.transaction(state=>{state.journeys={};});
  async function newJourney(interaction){
    assertManager(interaction);
    const v=values(interaction,['title','first','days','hours','duration']);
    validate(validDate(v.first),'Use a valid first date in YYYY-MM-DD format.');
    const days=Number(v.days),duration=Number(v.duration);
    validate(Number.isInteger(days)&&days>=1&&days<=14,'Use 1–14 candidate days.');
    validate(Number.isInteger(duration)&&duration>=15&&duration<=720&&
      duration%15===0,'Duration must be 15–720 minutes in 15-minute steps.');
    const limit=hours(v.hours);
    const first=DateTime.fromISO(v.first,{zone:'Europe/Amsterdam'});
    validate(first.toMillis()>=DateTime.fromJSDate(new Date(now()))
      .setZone('Europe/Amsterdam').startOf('day').toMillis(),
      'Select a current or future candidate date.');
    const dates=Array.from({length:days},(_,i)=>first.plus({days:i}).toISODate());
    const dayLimits=Object.fromEntries(dates.map(date=>[date,limit]));
    const round=createRound({
      title:v.title,startDate:dates[0],endDate:dates.at(-1),selectedDates:dates,
      timezone:'Europe/Amsterdam',dayLimits,
      minDurationMinutes:duration,maxDurationMinutes:duration,stepMinutes:30,
      durationStepMinutes:30,collectionHours:168,voteHours:24,
      threshold:.9,targetCount:5,destination:'league',
      testMode:true,location:'WinterBot private Discord test',
    },now());
    const journey={id:id(),createdAt:new Date(now()).toISOString(),
      ownerId:interaction.user.id,round,
      sampleIds:[],selectedCandidates:{},chosenStarts:{},focusedCandidate:{},
      startPages:{},selectedDay:{},drafts:{},reviewed:{},draftVotes:{},
      importPreview:{},imported:{},messages:{},event:null,
      options:{minAttendance:5},};
    await store.transaction(state=>{
      state.journeys ||= {};
      // Keep a short recent history; never silently replace unfinished data.
      validate(Object.keys(state.journeys).length<20,
        'There are 20 stored test rounds. Reset the isolated tests before creating more.');
      state.journeys[journey.id]=journey;
    });
    await interaction.reply(dashboard(journey));
  }
  async function advanced(interaction,sid){
    assertManager(interaction);
    const j=read(sid);
    validate(j.round.phase==='collecting'&&j.round.participants.length===0,
      'Advanced planning settings cannot change after submissions begin.');
    await interaction.showModal(modalAdvanced(j));
  }
  async function saveAdvanced(interaction,sid){
    assertManager(interaction);
    const v=values(interaction,['duration','minPeople','collection','vote','precision']);
    const m=v.duration.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    validate(m,'Duration must look like 120 or 90-180.');
    const min=Number(m[1]),max=Number(m[2]||m[1]),people=Number(v.minPeople);
    const collection=Number(v.collection),vote=Number(v.vote),step=Number(v.precision);
    validate(Number.isInteger(people)&&people>=1&&people<=250,
      'Minimum attendance must be 1–250.');
    const updated=await mutate(sid,j=>{
      validate(j.round.phase==='collecting'&&j.round.participants.length===0,
        'Settings are locked after submissions begin.');
      const r=j.round;
      const replacement=createRound({
        ...r,minDurationMinutes:min,maxDurationMinutes:max,
        durationStepMinutes:30,stepMinutes:step,
        collectionHours:collection,voteHours:vote,
      },new Date(r.createdAt));
      replacement.id=r.id;
      j.round=replacement;
      j.options.minAttendance=people;
    });
    await show(interaction,dashboard(updated));
  }
  async function sendInvitation(interaction,sid){
    assertManager(interaction);
    const j=read(sid);
    validate(j.round.phase==='collecting','Invitations can only be published during collection.');
    validate(!j.messages.invite,'The invitation was already published.');
    const message=await post(invitation(j));
    const changed=await mutate(sid,current=>{
      if(!current.messages.invite)current.messages.invite=message.id;
    });
    await show(interaction,dashboard(changed));
  }
  function seedWindow(allowed,i,d){
    const startLimit=minuteOf(allowed.start),endLimit=minuteOf(allowed.end,true);
    const start=Math.min(endLimit-60,Math.max(startLimit,18*60+(i%3)*30));
    const end=Math.min(endLimit,start+(i%2?180:240));
    if(start<startLimit||end-start<60)return null;
    return {start:String(Math.floor(start/60)).padStart(2,'0')+':'+
      String(start%60).padStart(2,'0'),
      end:end===1440?'24:00':String(Math.floor(end/60)).padStart(2,'0')+':'+
      String(end%60).padStart(2,'0'),maxMinutes:null};
  }
  async function seedSample(interaction,sid){
    assertManager(interaction);
    const changed=await mutate(sid,j=>{
      assertCollecting(j);
      validate(j.sampleIds.length===0,'Sample attendees have already been loaded.');
      const dates=listDays(j.round),sampleIds=[];
      for(let i=0;i<8;i++){
        const uid='sample-'+(i+1);
        enroll(j.round,uid,'[SAMPLE] Participant '+(i+1));
        const days=dates.map((date,di)=>{
          const w=seedWindow(allowedWindowForDate(j.round,date),i,di);
          return {date,...((i+di)%5===0||!w?
            {status:'unavailable',windows:[]}:
            {status:'available',windows:[w]})};
        });
        setDays(j.round,uid,days,now());
        sampleIds.push(uid);
      }
      j.sampleIds=sampleIds;
    });
    await show(interaction,dashboard(changed));
  }

  async function previewActivityImport(interaction,sid){
    assertLocation(interaction);
    validate(typeof activityAvailability==='function',
      'Activity availability import is unavailable on this test host.');
    const uid=String(interaction.user.id),j=read(sid);
    assertCollecting(j);
    const snapshot=await activityAvailability(uid);
    const converted=convertActivitySubmission(snapshot,j.round);
    const updated=await mutate(sid,journey=>{
      assertCollecting(journey);
      journey.importPreview[uid]=converted;
    });
    await show(interaction,importPanel(updated,converted),{separate:true});
  }
  async function confirmActivityImport(interaction,sid){
    assertLocation(interaction);
    const uid=String(interaction.user.id);
    validate(typeof activityAvailability==='function',
      'Activity availability import is unavailable on this test host.');
    const current=read(sid);
    const prior=current.importPreview[uid];
    validate(prior,'Review the converted Activity week before importing it.');
    const fresh=convertActivitySubmission(await activityAvailability(uid),current.round);
    validate(fresh.signature===prior.signature,
      'Your Activity submission changed. Review its conversion again.');
    const j=await mutate(sid,journey=>{
      assertCollecting(journey);
      const preview=journey.importPreview[uid];
      validate(preview?.signature===fresh.signature,
        'Your reviewed import is outdated.');
      if(!journey.round.participants.some(p=>p.id===uid))
        enroll(journey.round,uid,interaction.member?.displayName||
          interaction.user.globalName||interaction.user.username||uid);
      setDays(journey.round,uid,fresh.hours.map(({date,status,windows})=>
        ({date,status,windows})),now());
      journey.imported[uid]={
        at:new Date(now()).toISOString(),
        sourceSubmittedAt:fresh.sourceSubmittedAt,
        sourceHash:fresh.signature,
        roundedWindows:fresh.rounded,
        excludedTentative:fresh.excludedTentative,
      };
      journey.drafts[uid]=Object.fromEntries(fresh.hours.map(
        ({date,status,windows})=>[date,{status,windows}]));
      journey.reviewed[uid]=null;
      delete journey.importPreview[uid];
    });
    await show(interaction,payload(panel('Activity week imported · TEST',
      'Your reviewed Activity submission has been mapped into the planning '+
      'round for **confirmed-attendance optimization**.\n\n'+
      attendance(j.round)+'\n'+
      'Tentative periods were not counted. All imported times are inside '+
      'the source availability and organizer allowed hours.\n\n'+
      'Your original Activity submission remains unchanged.'),
      [row(btn('join',sid,'Edit native test answer'))]));
  }

  async function openPerson(interaction,sid,{review=false,separate=false}={}){
    assertLocation(interaction);
    let journey=read(sid);
    validate(journey.round.phase==='collecting',
      'Availability is closed. View attendance results instead.');
    const uid=String(interaction.user.id);
    journey=await mutate(sid,j=>{
      j.drafts[uid] ||= structuredClone(j.round.availability[uid]||{});
      j.selectedDay[uid] ||= listDays(j.round)[0];
    });
    await show(interaction,personPanel(journey,uid,{review}),{separate});
  }
  async function editDate(interaction,sid,date,status){
    assertLocation(interaction);
    const uid=String(interaction.user.id);
    const journey=await mutate(sid,j=>{
      assertCollecting(j);
      validate(listDays(j.round).includes(date),'Choose a candidate date.');
      j.drafts[uid] ||= structuredClone(j.round.availability[uid]||{});
      j.selectedDay[uid]=date;
      if(status==='off')j.drafts[uid][date]={status:'unavailable',windows:[]};
      if(status==='all'){
        const permitted=allowedWindowForDate(j.round,date);
        j.drafts[uid][date]={status:'available',
          windows:[{start:permitted.start,end:permitted.end,maxMinutes:null}]};
      }
      j.reviewed[uid]=null;
    });
    await show(interaction,personPanel(journey,uid));
  }
  async function hoursSubmission(interaction,sid,date){
    assertLocation(interaction);
    const uid=String(interaction.user.id);
    const fields=values(interaction,['start','end','moreStart','moreEnd','limit']);
    validate(!fields.moreStart===!fields.moreEnd,
      'For a second window, provide both its From and Until time.');
    const windows=[{start:fields.start,end:fields.end,
      maxMinutes:fields.limit?Number(fields.limit):null}];
    if(fields.moreStart)windows.push({start:fields.moreStart,end:fields.moreEnd,
      maxMinutes:null});
    const journey=await mutate(sid,j=>{
      assertCollecting(j);
      validate(listDays(j.round).includes(date),'Date outside this round.');
      // Use core validation on a COPY, without registering/submitting yet.
      const fake={...j.round,
        participants:[...j.round.participants,{id:uid,name:interaction.user.username||uid}],
        availability:structuredClone(j.round.availability)};
      const {setDay}=require('./core');
      setDay(fake,uid,date,{status:'available',windows,maxMinutes:null},now());
      j.drafts[uid] ||= structuredClone(j.round.availability[uid]||{});
      j.drafts[uid][date]=fake.availability[uid][date];
      j.selectedDay[uid]=date;
      j.reviewed[uid]=null;
    });
    await show(interaction,personPanel(journey,uid));
  }
  function fingerprint(draft){
    return crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex');
  }
  async function reviewPerson(interaction,sid){
    assertLocation(interaction);
    const uid=String(interaction.user.id);
    const journey=await mutate(sid,j=>{
      assertCollecting(j);
      const draft=j.drafts[uid]||{};
      const dates=listDays(j.round);
      validate(dates.every(d=>draft[d]&&draft[d].status!=='unanswered'),
        'Answer every candidate date (including Unavailable) before reviewing.');
      j.reviewed[uid]=fingerprint(draft);
    });
    await show(interaction,personPanel(journey,uid,{review:true}));
  }
  async function submitPerson(interaction,sid){
    assertLocation(interaction);
    const uid=String(interaction.user.id);
    const journey=await mutate(sid,j=>{
      assertCollecting(j);
      const draft=j.drafts[uid]||{};
      validate(j.reviewed[uid]===fingerprint(draft),
        'Review your latest changes before submitting.');
      const dates=listDays(j.round);
      validate(dates.every(d=>draft[d]),'Every date must be answered.');
      if(!j.round.participants.some(p=>p.id===uid))
        enroll(j.round,uid,interaction.member?.displayName||
          interaction.user.globalName||interaction.user.username||uid);
      setDays(j.round,uid,dates.map(date=>({date,...draft[date]})),now());
    });
    await show(interaction,payload(panel('Availability submitted · TEST',
      'Your confirmed or unavailable days are recorded in the **isolated journey**.\n\n'+
      attendance(journey.round)+'\n\nOrganizer recommendations will recalculate when collection closes.\n'+
      'The calendar Activity remains a separate UX prototype for now.'),
      [row(btn('join',sid,'Revise my availability'),
        btn('refresh',sid,'Organizer overview'))]));
  }
  async function collectionClose(interaction,sid){
    assertManager(interaction);
    const j=await mutate(sid,j=>{
      validate(j.round.phase==='collecting','Collection is already closed.');
      closeCollection(j.round,now(),true);
    });
    await show(interaction,resultsPanel(j,interaction.user.id));
  }
  async function selectCandidates(interaction,sid){
    assertManager(interaction);
    const uid=String(interaction.user.id);
    const selected=(interaction.values||[]).map(String);
    const journey=await mutate(sid,j=>{
      const valid=new Set(choicesFor(j.round,j.options.minAttendance).map(c=>c.id));
      validate(selected.length>=1&&selected.length<=5&&
        selected.every(cid=>valid.has(cid)), 'Choose one to five qualifying times.');
      j.selectedCandidates[uid]=[...new Set(selected)];
      j.focusedCandidate[uid]=selected[0];j.startPages[uid]=0;
    });
    await show(interaction,resultsPanel(journey,uid));
  }
  async function showExactTimes(interaction,sid){
    assertManager(interaction);
    const j=read(sid);
    validate(['review','final'].includes(j.round.phase) && !j.event,
      'Exact times are editable only before the event is approved.');
    await show(interaction,exactTimesPanel(j,String(interaction.user.id)));
  }
  async function focusExactCandidate(interaction,sid){
    assertManager(interaction);
    const uid=String(interaction.user.id),cid=String(interaction.values?.[0]||'');
    const j=await mutate(sid,j=>{
      validate(getSelection(j,uid).includes(cid),'Choose one of your selected candidates.');
      j.focusedCandidate[uid]=cid;
      j.startPages[uid]=0;
    });
    await show(interaction,exactTimesPanel(j,uid));
  }
  async function selectExactSlot(interaction,sid){
    assertManager(interaction);
    const uid=String(interaction.user.id),slot=String(interaction.values?.[0]||'');
    const j=await mutate(sid,j=>{
      const focus=j.focusedCandidate[uid];
      validate(getSelection(j,uid).includes(focus),'Candidate is no longer selected.');
      const c=choicesFor(j.round,j.options.minAttendance).find(c=>c.id===focus);
      validate(c&&c.slots.some(s=>s.startAt===slot),
        'Choose an exact permitted start for this candidate.');
      (j.chosenStarts[uid] ||= {})[focus]=slot;
    });
    await show(interaction,exactTimesPanel(j,uid));
  }
  async function exactSlotPage(interaction,sid,delta){
    assertManager(interaction);
    const uid=String(interaction.user.id);
    const j=await mutate(sid,j=>{
      const focus=j.focusedCandidate[uid];
      validate(getSelection(j,uid).includes(focus),'Select a candidate first.');
      const c=choicesFor(j.round,j.options.minAttendance).find(c=>c.id===focus);
      const maxPage=Math.max(0,Math.ceil(c.slots.length/25)-1);
      j.startPages[uid]=Math.max(0,Math.min(maxPage,
        (j.startPages[uid]||0)+delta));
    });
    await show(interaction,exactTimesPanel(j,uid));
  }

  async function voteOpen(interaction,sid){
    assertManager(interaction);
    const uid=String(interaction.user.id);
    let journey=await mutate(sid,j=>{
      const selected=getSelection(j,uid);
      validate(j.round.phase==='review'&&selected.length>=2,
        'Select at least two time suggestions while reviewing results.');
      validate(!j.event,'Cannot start voting after selecting an event.');
      startVote(j.round,selected.map(cid=>{
        const c=choicesFor(j.round,j.options.minAttendance).find(c=>c.id===cid);
        return {candidateId:c.id,startAt:
          j.chosenStarts[uid]?.[c.id]||c.slots[0].startAt};
      }),now());
    });
    try{
      const message=await post(voteInvitation(journey));
      journey=await mutate(sid,j=>{j.messages.ballot=message.id;});
    }catch(error){
      logger('Test vote announcement failed; organizer can reopen results:',error.message);
    }
    await show(interaction,resultsPanel(journey,uid));
  }
  async function votePanelFor(interaction,sid){
    assertLocation(interaction);
    const j=read(sid);
    validate(j.round.phase==='voting','The vote is not currently open.');
    assertParticipant(j,String(interaction.user.id));
    await show(interaction,votePanel(j,String(interaction.user.id)),{separate:true});
  }
  async function voteSelect(interaction,sid){
    assertLocation(interaction);
    const uid=String(interaction.user.id);
    const chosen=(interaction.values||[]).map(String);
    const j=await mutate(sid,j=>{
      validate(j.round.phase==='voting','Voting is closed.');
      assertParticipant(j,uid);
      const valid=new Set(j.round.ballot.options.map(o=>o.id));
      validate(chosen.every(value=>valid.has(value)),'Unknown voting option.');
      j.draftVotes[uid]=[...new Set(chosen)];
    });
    await show(interaction,votePanel(j,uid));
  }
  async function voteSave(interaction,sid){
    assertLocation(interaction);
    const uid=String(interaction.user.id);
    const j=await mutate(sid,j=>{
      validate(j.round.phase==='voting','Voting is closed.');
      assertParticipant(j,uid);
      castVote(j.round,uid,j.draftVotes[uid]||
        j.round.ballot.votes[uid]||[],now());
    });
    await show(interaction,payload(panel('Vote saved · TEST',
      '**'+(j.round.ballot.votes[uid]||[]).length+
      '** preferred option(s) saved.\n\nYou can revise your choice until the ballot closes.'),
      [row(btn('votepanel',sid,'Change my vote',ButtonStyle.Primary))]));
  }
  async function voteClose(interaction,sid){
    assertManager(interaction);
    const j=await mutate(sid,j=>{
      validate(j.round.phase==='voting','Voting has already closed.');
      closeVote(j.round,now(),true);
      // Selections tied to excluded candidates must be actively re-picked.
      j.selectedCandidates={};
    });
    await show(interaction,resultsPanel(j,interaction.user.id));
  }
  async function approve(interaction,sid){
    assertManager(interaction);
    const uid=String(interaction.user.id);
    let journey=await mutate(sid,(j,state)=>{
      validate(['review','final'].includes(j.round.phase),
        'Approve an event only after availability collection closes.');
      validate(!j.event,'This test round already has an approved test event.');
      const chosen=getSelection(j,uid);
      validate(chosen.length===1,'Choose exactly one qualifying time first.');
      const c=choicesFor(j.round,j.options.minAttendance).find(c=>c.id===chosen[0]);
      validate(c,'The chosen time no longer meets minimum attendance.');
      validate(!Object.values(state.journeys||{}).some(other=>other.event&&
        other.event.date===c.date),
        'Another WinterBot test round already uses this date (one event per day).');
      const voted=j.round.ballot?.options.find(o=>o.candidateId===c.id);
      const selectedStart=voted?.startAt||
        j.chosenStarts[uid]?.[c.id]||c.slots[0].startAt;
      const {slot}=getSlot(j.round,c.id,selectedStart);
      const checkInMinutes=EVENT_DEFAULTS.checkInMinutes;
      j.event={
        id:id(),status:'planned',candidateId:c.id,date:c.date,
        startAt:slot.startAt,endAt:slot.endAt,
        durationMinutes:c.durationMinutes,eligibleIds:[...c.availableIds],
        checkinOpensAt:new Date(Date.parse(slot.startAt)-checkInMinutes*60000).toISOString(),
        options:{...EVENT_DEFAULTS},checkedIn:{},
        graceEndsAt:null,confirmNow:false,approvedAt:new Date(now()).toISOString(),
      };
    });
    try{
      const message=await post(publicEvent(journey));
      journey=await mutate(sid,j=>{j.messages.event=message.id;});
    }catch(error){
      logger('Test event preview message was not posted:',error.message);
    }
    await show(interaction,eventSimulationPanel(journey,uid,true));
  }
  async function checkIn(interaction,sid){
    assertLocation(interaction);
    const uid=String(interaction.user.id),manager=isManager(interaction);
    const j=await mutate(sid,j=>{
      const e=j.event;
      validate(e,'No test event yet.');
      validate(['checkin-open','running'].includes(e.status),
        'Check-in is not open yet (or the event is wrapping up).');
      validate(e.status!=='running'||e.options.lateCheckins,
        'Late check-ins are disabled.');
      validate(manager||e.eligibleIds.includes(uid),
        'You are not among the eligible participants for this test event.');
      e.checkedIn[uid]||={at:new Date(now()).toISOString(),
        managerTestOverride:manager&&!e.eligibleIds.includes(uid)};
    });
    await updatePublicEvent(j);
    await show(interaction,payload(panel('Check-in recorded · TEST',
      '✓ Your simulated event role has been granted in the test model.\n'+
      'No real Discord role was assigned and no channel permissions changed.\n'+
      (manager&&!j.event.eligibleIds.includes(uid)?
        'This was a **moderator-only test override**, not an eligible attendee check-in.':''),
      {accent:GOOD}),[row(btn('access',sid,'View simulated channel access'))]),{separate:true});
  }

  async function eventAction(interaction,sid,action){
    assertManager(interaction);
    const j=await mutate(sid,j=>{
      const e=j.event;
      validate(e,'No approved test event.');
      if(action==='opencheck'){
        validate(e.status==='planned','Check-in has already started.');
        e.status='checkin-open';
      }else if(action==='start'){
        validate(e.status==='checkin-open','Open check-in first.');
        e.status='running';
      }else if(action==='beginend'){
        validate(e.status==='running','The event must be running to end it.');
        if(e.options.graceMinutes===0){
          e.status='ended';
        }else{
          e.status='grace';
          e.graceEndsAt=new Date(new Date(now()).getTime()+
            e.options.graceMinutes*60000).toISOString();
        }
      }else if(action==='cancelend'){
        validate(e.status==='grace','No ending is in progress.');
        e.status='running';e.graceEndsAt=null;e.confirmNow=false;
      }else if(action==='extend1'||action==='extend5'){
        validate(e.status==='grace','Grace period not active.');
        const minutes=action==='extend1'?1:5;
        e.graceEndsAt=new Date(Math.max(new Date(now()).getTime(),
          Date.parse(e.graceEndsAt))+minutes*60000).toISOString();
        e.confirmNow=false;
      }else if(action==='endnow'){
        validate(e.status==='grace','The event is not wrapping up.');
        e.confirmNow=true;
      }else if(action==='keepend'){
        validate(e.status==='grace','There is no pending end confirmation.');
        e.confirmNow=false;
      }else if(action==='confirmend'){
        validate(e.status==='grace'&&e.confirmNow,
          'Confirm ending immediately first.');
        e.status='ended';e.graceEndsAt=null;e.confirmNow=false;
      }else throw Error('Unknown event lifecycle action.');
    });
    await updatePublicEvent(j);
    await show(interaction,eventSimulationPanel(j,interaction.user.id,true));
  }
  async function optionChange(interaction,sid,setting){
    assertManager(interaction);
    const labels={
      optchat:'chat',optvoice:'voice',optcheckchannel:'checkinChannel',
      optarchive:'persistentChat',optlate:'lateCheckins',
      optovertime:'overtime',
    };
    const field=labels[setting];
    validate(field,'Unknown advanced event setting.');
    const j=await mutate(sid,j=>{
      const e=j.event;
      validate(e&&['planned','checkin-open'].includes(e.status),
        'Advanced settings cannot change once the event is running.');
      e.options[field]=!e.options[field];
      if(!e.options.chat)e.options.persistentChat=false;
      if(e.options.persistentChat)e.options.chat=true;
    });
    await updatePublicEvent(j);
    await show(interaction,eventOptionsPanel(j));
  }
  async function graceSelect(interaction,sid){
    assertManager(interaction);
    const n=Number(interaction.values?.[0]);
    validate(GRACE_MINUTES.includes(n),'Invalid grace period.');
    const j=await mutate(sid,j=>{
      validate(j.event&&['planned','checkin-open'].includes(j.event.status),
        'Grace settings are locked after the event starts.');
      j.event.options.graceMinutes=n;
    });
    await updatePublicEvent(j);
    await show(interaction,eventOptionsPanel(j));
  }
  function eventView(interaction,sid){
    assertLocation(interaction);
    const j=read(sid);
    return show(interaction,eventSimulationPanel(j,interaction.user.id,
      isManager(interaction)));
  }
  async function updatePublicEvent(journey){
    const messageId=journey.messages?.event;
    if(!messageId)return;
    try{
      const channel=await testChannel();
      const message=await channel.messages?.fetch(messageId);
      if(message)await message.edit(messagePayload(publicEvent(journey)));
    }catch(error){logger('Unable to refresh simulated event invitation:',error.message);}
  }
  async function tick(){
    // All scheduling changes are made only in this isolated journey store.
    const before=store.read();
    const due=Object.values(before.journeys||{}).filter(j=>
      j.round.phase==='collecting'&&Date.parse(j.round.collectionClosesAt)<=now().getTime()||
      j.round.phase==='voting'&&Date.parse(j.round.ballot.closesAt)<=now().getTime()||
      j.event?.status==='planned'&&Date.parse(j.event.checkinOpensAt)<=now().getTime()||
      j.event?.status==='running'&&!j.event.options.overtime&&
        Date.parse(j.event.endAt)<=now().getTime()||
      j.event?.status==='grace'&&Date.parse(j.event.graceEndsAt)<=now().getTime());
    for(const item of due){
      let changed=false;
      const current=await mutate(item.id,j=>{
        const time=now();
        if(j.round.phase==='collecting'&&
          Date.parse(j.round.collectionClosesAt)<=time.getTime())
          changed=closeCollection(j.round,time)||changed;
        if(j.round.phase==='voting'&&
          Date.parse(j.round.ballot.closesAt)<=time.getTime())
          changed=closeVote(j.round,time)||changed;
        if(j.event?.status==='planned'&&
          Date.parse(j.event.checkinOpensAt)<=time.getTime()){
          j.event.status='checkin-open';changed=true;
        }
        if(j.event?.status==='running'&&!j.event.options.overtime&&
          Date.parse(j.event.endAt)<=time.getTime()){
          if(j.event.options.graceMinutes===0)j.event.status='ended';
          else{
            j.event.status='grace';
            j.event.graceEndsAt=new Date(time.getTime()+
              j.event.options.graceMinutes*60000).toISOString();
          }
          changed=true;
        }
        if(j.event?.status==='grace'&&
          Date.parse(j.event.graceEndsAt)<=time.getTime()){
          j.event.status='ended';j.event.graceEndsAt=null;
          j.event.confirmNow=false;changed=true;
        }
      });
      if(changed&&current.event)await updatePublicEvent(current);
    }
  }
  async function handle(interaction){
    if(!String(interaction.customId||'').startsWith('wbflow:'))return false;
    try{
      assertLocation(interaction);
      const [prefix,action,sid,extra]=interaction.customId.split(':');
      validate(prefix==='wbflow','Invalid test interaction.');
      const uid=String(interaction.user.id);
      const adminActions=new Set(['new','advanced','invite','sample','close',
        'choose','times','timecandidate','timeslot','prevslots','nextslots',
        'startvote','endvote','approve','opencheck','start',
        'beginend','cancelend','extend1','extend5','endnow','keepend','confirmend',
        'eventopts','optchat','optvoice','optcheckchannel','optarchive',
        'optlate','optovertime','grace']);
      if(adminActions.has(action))assertManager(interaction);
      if(action==='new'&&!interaction.isModalSubmit?.()){
        await interaction.showModal(modalNew(now()));
        return true;
      }
      if(action==='new'&&interaction.isModalSubmit?.()){
        await newJourney(interaction);return true;
      }
      if(action==='resume'){
        const picked=String(interaction.values?.[0]||'');
        const journey=read(picked);
        await show(interaction,journey.round.phase==='collecting'?
          dashboard(journey):journey.event?
          eventSimulationPanel(journey,uid,true):
          resultsPanel(journey,uid));
        return true;
      }
      if(action==='advanced'){
        if(interaction.isModalSubmit?.())await saveAdvanced(interaction,sid);
        else await advanced(interaction,sid);
        return true;
      }
      if(action==='refresh'){await show(interaction,dashboard(read(sid)));return true;}
      if(action==='invite'){await sendInvitation(interaction,sid);return true;}
      if(action==='sample'){await seedSample(interaction,sid);return true;}
      if(action==='close'){await collectionClose(interaction,sid);return true;}
      if(action==='join'){await openPerson(interaction,sid,{separate:true});return true;}
      if(action==='import'){
        await previewActivityImport(interaction,sid);return true;
      }
      if(action==='importconfirm'){
        await confirmActivityImport(interaction,sid);return true;
      }
      if(action==='person'){await openPerson(interaction,sid);return true;}
      if(action==='date'){
        const date=String(interaction.values?.[0]||'');
        await editDate(interaction,sid,date,null);return true;
      }
      if(action==='hours'&&!interaction.isModalSubmit?.()){
        const j=read(sid);
        const date=extra||j.selectedDay[uid]||listDays(j.round)[0];
        await interaction.showModal(modalHours(j,date));
        return true;
      }
      if(action==='hours'&&interaction.isModalSubmit?.()){
        await hoursSubmission(interaction,sid,extra);return true;
      }
      if(action==='off'||action==='dayall'){
        const j=read(sid);
        const date=j.selectedDay[uid]||listDays(j.round)[0];
        await editDate(interaction,sid,date,action==='off'?'off':'all');
        return true;
      }
      if(action==='review'){await reviewPerson(interaction,sid);return true;}
      if(action==='submit'){await submitPerson(interaction,sid);return true;}
      if(action==='results'){
        assertManager(interaction);
        const j=read(sid);
        await show(interaction,resultsPanel(j,uid));return true;
      }
      if(action==='choose'){await selectCandidates(interaction,sid);return true;}
      if(action==='times'){await showExactTimes(interaction,sid);return true;}
      if(action==='timecandidate'){await focusExactCandidate(interaction,sid);return true;}
      if(action==='timeslot'){await selectExactSlot(interaction,sid);return true;}
      if(action==='prevslots'){await exactSlotPage(interaction,sid,-1);return true;}
      if(action==='nextslots'){await exactSlotPage(interaction,sid,1);return true;}
      if(action==='startvote'){await voteOpen(interaction,sid);return true;}
      if(action==='votepanel'){await votePanelFor(interaction,sid);return true;}
      if(action==='voteselect'){await voteSelect(interaction,sid);return true;}
      if(action==='savevote'){await voteSave(interaction,sid);return true;}
      if(action==='endvote'){await voteClose(interaction,sid);return true;}
      if(action==='approve'){await approve(interaction,sid);return true;}
      if(action==='event'){await eventView(interaction,sid);return true;}
      if(action==='access'){
        await show(interaction,accessPanel(read(sid),uid),{separate:true});
        return true;
      }
      if(action==='checkin'){await checkIn(interaction,sid);return true;}
      if(action==='eventopts'){
        await show(interaction,eventOptionsPanel(read(sid)));return true;
      }
      if(action.startsWith('opt')){
        await optionChange(interaction,sid,action);return true;
      }
      if(action==='grace'){await graceSelect(interaction,sid);return true;}
      if(['opencheck','start','beginend','cancelend','extend1','extend5',
        'endnow','keepend','confirmend'].includes(action)){
        await eventAction(interaction,sid,action);return true;
      }
      throw Error('Unknown WinterBot test control.');
    }catch(error){await failure(interaction,error);}
    return true;
  }
  return {store,start,results,checkinView,handle,tick,reset,read,latest,
    isManager,dashboard,resultsPanel,eventSimulationPanel,
    testIds:{guildId,channelId}};
}
module.exports={createNativeJourney,EVENT_DEFAULTS};
