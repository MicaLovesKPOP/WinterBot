'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, LabelBuilder, MessageFlags,
} = require('discord.js');
const { DateTime } = require('luxon');
const { summary, displayTime, weekday, unsubmittedChanges } = require('./nativePrototypeState');

const BLUE = 0x829de9;
const GREEN = 0x43b581;
const YELLOW = 0xe3ad38;
const PREFIX = 'wbux';
const key = (...items) => [PREFIX, ...items].join(':');
const row = (...items) => new ActionRowBuilder().addComponents(...items);
const button = (id, label, style=ButtonStyle.Secondary, disabled=false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const fmt = date => DateTime.fromISO(date).toFormat('ccc dd LLL');
const label = date => DateTime.fromISO(date).toFormat('cccc dd LLL');
const privatePayload = object => ({...object, flags:MessageFlags.Ephemeral, allowedMentions:{parse:[]}});

function base(title, text, color=BLUE) {
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({name:'WINTERBOT | NATIVE SCHEDULING UX TEST'})
    .setTitle(title)
    .setDescription(text)
    .setFooter({text:'Private test editor | No real events, roles or channels'});
}
function details(day, format='24') {
  if (!day) return 'Not answered';
  if (day.status === 'unavailable') return 'Unavailable';
  return day.windows.map(w =>
    (w.kind === 'tentative' ? 'Tentative' : 'Available') + ': ' + displayTime(w.start,format) + ' to ' + displayTime(w.end,format) +
    (w.maxMinutes ? ' | max ' + w.maxMinutes + ' min' : '')).join('\n');
}
function allLines(round, answers, format='24') {
  return round.dates.map(d => {
    const a = answers?.[d];
    const symbol = !a ? '▫️' : a.status === 'unavailable' ? '❌' :
      a.windows.every(w=>w.kind==='tentative') ? '❔' : '✅';
    return symbol + ' **' + fmt(d) + '** — ' + summary(a,format);
  }).join('\n');
}
function datePicker(op, sid, round, placeholder='Select a date') {
  return new StringSelectMenuBuilder().setCustomId(key(op,sid))
    .setPlaceholder(placeholder).setMinValues(1).setMaxValues(1)
    .setOptions(round.dates.map(d=>({label:label(d), value:d})));
}
function overview(round, member, template, notice='') {
  const count=round.dates.filter(d=>member.draft[d]).length;
  const changed = member.submitted && unsubmittedChanges(member);
  const stateText = member.submitted
    ? changed ? 'Your previous submission remains active; these edits are only a draft.' :
      'Your availability has been submitted. You can still make changes.'
    : 'Your changes are saved as a private draft. Nothing has been submitted yet.';
  const embed=base('Your availability | '+fmt(round.dates[0])+' - '+fmt(round.dates.at(-1)),
    (notice ? '**'+notice+'**\n\n' : '') +
    '**'+count+'/'+round.dates.length+' dates answered**\n'+stateText+
    '\n\n'+allLines(round,member.draft,member.clockFormat));
  const components=[
    row(datePicker('jump',round.id,round,'Edit a specific date')),
    row(
      button(key('bulk',round.id),'Edit Multiple Days',ButtonStyle.Primary),
      button(key('reuse',round.id),'Use My Usual Week',ButtonStyle.Secondary,!template),
      button(key('review',round.id),'Review & Submit',ButtonStyle.Success)
    ),
    row(
      button(key('clock',round.id),member.clockFormat === '12' ? 'Clock: 12h' : 'Clock: 24h'),
      button(key('template',round.id),'Save as Usual Week',ButtonStyle.Secondary,!member.submitted),
      button(key('undo',round.id),'Undo Last Edit',ButtonStyle.Secondary,!member.undo)
    )
  ];
  return privatePayload({embeds:[embed],components});
}
function dayView(round, member, date, notice='') {
  const day=member.draft[date], idx=round.dates.indexOf(date);
  const embed=base(label(date),
    (notice ? '**'+notice+'**\n\n' : '') +
    '**Current answer**\n'+details(day,member.clockFormat)+
    '\n\nQuick choices replace this date. Adding hours preserves any non-overlapping windows.'+
    '\n\nChanges remain drafts until your final review.');
  const components=[
    row(
      button(key('all',round.id,date),'All Day',ButtonStyle.Success),
      button(key('off',round.id,date),'Unavailable',ButtonStyle.Danger)
    ),
    row(
      button(key('add',round.id,date,'confirmed'),'Add Available Hours',ButtonStyle.Primary),
      button(key('add',round.id,date,'tentative'),'Add Tentative Hours'),
      button(key('copy',round.id,date),'Copy to Days',ButtonStyle.Secondary,!day)
    )
  ];
  if(day?.windows?.length) {
    const options=day.windows.map((w,i)=>({
      label:(i+1)+'. '+(w.kind==='tentative'?'Tentative':'Available')+' '+w.start+'-'+w.end,
      value:String(i),
    }));
    components.push(row(new StringSelectMenuBuilder().setCustomId(key('editwin',round.id,date))
      .setPlaceholder('Edit a time window').setOptions(options)));
    components.push(row(new StringSelectMenuBuilder().setCustomId(key('delwin',round.id,date))
      .setPlaceholder('Remove a time window').setOptions(options)));
  }
  components.push(row(
    button(key('home',round.id),'Overview'),
    button(key('day',round.id,round.dates[idx-1] || date),'Previous',ButtonStyle.Secondary,idx===0),
    button(key('day',round.id,round.dates[idx+1] || date),'Next',ButtonStyle.Primary,idx===round.dates.length-1)
  ));
  return privatePayload({embeds:[embed],components});
}
function dateMultiSelect(op, round, member, exclude=null) {
  const choices=round.dates.filter(d=>d!==exclude);
  return new StringSelectMenuBuilder().setCustomId(key(op,round.id,exclude||'all'))
    .setPlaceholder('Choose destination dates')
    .setMinValues(1).setMaxValues(choices.length)
    .setOptions(choices.map(d=>({label:label(d),value:d,
      description:summary(member.draft[d],member.clockFormat).slice(0,95),
      default:member.selection.includes(d)})));
}
function multiView(round,member,source=null,notice='') {
  const copy=Boolean(source);
  const selected=member.selection.filter(d=>round.dates.includes(d)&&d!==source);
  const overwritten=selected.filter(d=>member.draft[d]);
  const embed=base(copy?'Copy '+label(source):'Edit Multiple Days',
    (notice ? notice+'\n\n' : '') +
    (copy
      ? 'Copy the complete answer from **'+label(source)+'**:\n'+details(member.draft[source],member.clockFormat)
      : 'Select dates first, then choose one answer to apply to all of them.')+
    '\n\n**Selected: '+selected.length+'**'+
    (selected.length?'\n'+selected.map(fmt).join(', '):'\nNone yet')+
    (overwritten.length?'\n\n**Existing answers affected: '+overwritten.length+'** (confirmation required)':'')+
    '\n\nAll changes remain drafts.');
  const components=[row(dateMultiSelect(copy?'dest':'dates',round,member,source))];
  if(copy) {
    components.push(row(
      button(key('proposecopy',round.id,source),'Review Copy',ButtonStyle.Primary,!selected.length),
      button(key('day',round.id,source),'Back to Day')
    ));
  } else {
    components.push(row(
      button(key('bulkset',round.id,'all'),'All Day',ButtonStyle.Success,!selected.length),
      button(key('bulkset',round.id,'off'),'Unavailable',ButtonStyle.Danger,!selected.length),
      button(key('bulkset',round.id,'maybe'),'Tentative All Day',ButtonStyle.Secondary,!selected.length)
    ));
    components.push(row(
      button(key('bulkwin',round.id,'confirmed'),'Choose Available Hours',ButtonStyle.Primary,!selected.length),
      button(key('bulkwin',round.id,'tentative'),'Choose Tentative Hours',ButtonStyle.Secondary,!selected.length)
    ));
    components.push(row(button(key('home',round.id),'Back to Overview')));
  }
  return privatePayload({embeds:[embed],components});
}
function pendingView(round,member,template) {
  const p=member.pending;
  const source=p?.source;
  const dates=p?.dates || [];
  const newDay=p?.day;
  const description = p?.type==='copy' ? 'Copy availability from '+label(source) :
    p?.type==='reuse' ? 'Apply My Usual Week' :
    p?.type==='template' ? 'Save current submitted answers as your usual week' :
    'Apply this availability to the selected dates';
  const changes=dates.map(d => {
    const incoming=p?.type==='reuse' ? template?.[weekday(d)] :
      p?.type==='copy' ? member.draft[source] : newDay;
    return '**'+fmt(d)+'**\nBefore: '+summary(member.draft[d],member.clockFormat)+'\nAfter: '+summary(incoming,member.clockFormat);
  }).join('\n\n');
  const embed=base('Confirm Changes', '**'+description+'**\n\n'+
    (p?.type==='template' ?
      'This replaces your saved weekly pattern, not any currently submitted availability.' :
      changes)+
    '\n\nNothing is applied until you confirm.',YELLOW);
  return privatePayload({embeds:[embed],components:[row(
    button(key('apply',round.id),'Confirm',ButtonStyle.Success),
    button(key('cancel',round.id),'Cancel')
  )]});
}
function reviewView(round,member) {
  const missing=round.dates.filter(d=>!member.draft[d]);
  const altered=member.submitted ? round.dates.filter(d=>
    JSON.stringify(member.draft[d])!==JSON.stringify(member.submitted[d])) : [];
  const embed=base('Review Before Submitting',
    'Read every date below. These are the **exact answers** WinterBot will receive if you confirm.\n\n'+
    allLines(round,member.draft,member.clockFormat)+
    (altered.length?'\n\n**Changed since previous submission:** '+altered.map(fmt).join(', '):'')+
    (missing.length?'\n\n**Unanswered dates:** '+missing.map(fmt).join(', ')+
      '\nAnswer each date before you can submit.':'\n\nAll dates are answered.'),
    missing.length?YELLOW:GREEN);
  const components=[row(
    button(key('submit',round.id),'Confirm & Submit',ButtonStyle.Success,missing.length>0),
    button(key('home',round.id),'Back to Editing')
  )];
  if(missing.length) components.push(row(
    button(key('day',round.id,missing[0]),'Go to First Unanswered Day',ButtonStyle.Primary)
  ));
  return privatePayload({embeds:[embed],components});
}
function hourOptions(format, forEnd) {
  const length=forEnd?25:24;
  return Array.from({length},(_,i)=>({
    value:String(i),
    label:i===24?(format==='12'?'12 AM (end of day)':'24:00 (end of day)') :
      format==='12'?String(i%12||12)+(i<12?' AM':' PM'):String(i).padStart(2,'0'),
  }));
}
function pick(id, options, selected) {
  return new StringSelectMenuBuilder().setCustomId(id).setMinValues(1).setMaxValues(1)
    .setOptions(options.map(x=>({...x, default: selected !== undefined && x.value===String(selected)})));
}
function modalLabel(text, selector) {
  return new LabelBuilder().setLabel(text).setStringSelectMenuComponent(selector);
}
function windowModal(sid, date, kind, format='24', existing=null, index=-1, bulk=false) {
  const sh=existing?String(Number(existing.start.slice(0,2))):'19';
  const sm=existing?existing.start.slice(3):'00';
  const eh=existing?String(Number(existing.end.slice(0,2))):'23';
  const em=existing?existing.end.slice(3):'00';
  const minuteOptions=Array.from({length:12},(_,i)=>({value:String(i*5).padStart(2,'0'),label:String(i*5).padStart(2,'0')}));
  const capOptions=[
    {value:'none',label:'No limit'},
    ...[30,45,60,90,120,150,180,240,300,360,480,600,720,960,1440]
      .map(m=>({value:String(m),label:m%60===0 ? m/60+' hour(s)' : m+' minutes'}))
  ];
  const id=key('win',sid,bulk?'multi':date,kind,String(index));
  const modal=new ModalBuilder().setCustomId(id)
    .setTitle(bulk?'Set Hours for Selected Days':'Edit Time Window')
    .addLabelComponents(
      modalLabel('Start hour',pick('start_h',hourOptions(format,false),sh)),
      modalLabel('Start minute',pick('start_m',minuteOptions,sm)),
      modalLabel('End hour',pick('end_h',hourOptions(format,true),eh)),
      modalLabel('End minute',pick('end_m',minuteOptions,em)),
      modalLabel('Maximum time I can stay',pick('cap',capOptions,existing?.maxMinutes??'none'))
    );
  return modal;
}
function invite(round) {
  return {
    embeds:[new EmbedBuilder().setColor(BLUE)
      .setTitle('[TEST] WinterBot availability editor')
      .setDescription('Try the **native Discord** availability flow. Your answers remain in an isolated test store and **do not affect real event scheduling**.\n\n'+
        'Planning week: **'+fmt(round.dates[0])+' - '+fmt(round.dates.at(-1))+'**\n'+
        'Try multi-day editing, tentative hours, copying days, weekly reuse and mandatory review.')
      .setFooter({text:'TEST ONLY | No roles, channels or events will be created'})],
    components:[row(button(key('open',round.id),'Open My Private Availability',ButtonStyle.Primary))],
    allowedMentions:{parse:[]},
  };
}
module.exports = {
  key, privatePayload, overview, dayView, multiView, pendingView, reviewView,
  windowModal, invite, summary, fmt, label, details,
};