'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, LabelBuilder, ContainerBuilder, TextDisplayBuilder, MessageFlags,
} = require('discord.js');
const { DateTime } = require('luxon');
const { summary, displayTime, weekday, unsubmittedChanges } = require('./nativePrototypeState');

const BLUE=0x829de9, GREEN=0x43b581, YELLOW=0xe3ad38;
const key=(...parts)=>['wbux',...parts].join(':');
const row=(...items)=>new ActionRowBuilder().addComponents(...items);
const button=(id,label,style=ButtonStyle.Secondary,disabled=false)=>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const fmt=d=>DateTime.fromISO(d).toFormat('ccc d LLL');
const label=d=>DateTime.fromISO(d).toFormat('cccc d LLL');
const privatePayload=object=>({
  ...object,flags:MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  allowedMentions:{parse:[]},
});
const display=(value)=>new TextDisplayBuilder().setContent(value);
function panel(title,body,controls=[],color=BLUE,notice='') {
  const container=new ContainerBuilder().setAccentColor(color)
    .addTextDisplayComponents(display('## '+title))
    .addTextDisplayComponents(display((notice?'**'+notice+'**\n\n':'')+body));
  if(controls.length) container.addActionRowComponents(...controls);
  return privatePayload({components:[container]});
}
function details(day,format='24') {
  if(!day) return 'Not answered';
  if(day.status==='unavailable') return 'Unavailable';
  return day.windows.map(w=>
    (w.kind==='tentative'?'Tentative':'Available')+': '+
    displayTime(w.start,format)+' – '+displayTime(w.end,format)+
    (w.maxMinutes?' · max '+w.maxMinutes+' min':'')).join('\n');
}
function allLines(round,answers,format='24') {
  return round.dates.map(date=>{
    const a=answers?.[date];
    const sign=!a?'○':a.status==='unavailable'?'×':
      a.windows.every(w=>w.kind==='tentative')?'?':'✓';
    return sign+'  **'+fmt(date)+'**  ·  '+summary(a,format);
  }).join('\n');
}
function datePicker(op,sid,round,placeholder='Choose a date') {
  return new StringSelectMenuBuilder().setCustomId(key(op,sid))
    .setPlaceholder(placeholder).setMinValues(1).setMaxValues(1)
    .setOptions(round.dates.map(d=>({label:label(d),value:d})));
}
function dateMultiSelect(op,round,member,exclude=null) {
  const choices=round.dates.filter(d=>d!==exclude);
  return new StringSelectMenuBuilder().setCustomId(key(op,round.id,exclude||'all'))
    .setPlaceholder(member.selection.length?'Selected: '+member.selection.length+' date(s)':'Select dates')
    .setMinValues(op==='selectbulk'?0:1).setMaxValues(choices.length)
    .setOptions(choices.map(d=>({
      label:label(d),value:d,
      description:summary(member.draft[d],member.clockFormat).slice(0,95),
      default:member.selection.includes(d),
    })));
}
function overview(round,member,template,notice='') {
  const answered=round.dates.filter(d=>member.draft[d]).length;
  const changed=member.submitted&&unsubmittedChanges(member);
  const state=member.submitted ?
    changed?'**Draft changes** · Your previous submission is still active.':
      '**Submitted** · Your answers are saved.':
      '**Draft only** · Nothing has been submitted.';
  const selected=member.selection.filter(d=>round.dates.includes(d));
  const container=new ContainerBuilder().setAccentColor(BLUE)
    .addTextDisplayComponents(display('## Your Week · '+fmt(round.dates[0])+' – '+fmt(round.dates.at(-1))))
    .addTextDisplayComponents(display('**'+answered+'/'+round.dates.length+' dates answered**\n'+state));
  if(notice) container.addTextDisplayComponents(display('**'+notice+'**'));
  container
    .addTextDisplayComponents(display(allLines(round,member.draft,member.clockFormat)))
    .addTextDisplayComponents(display('**Edit several days at once**\nFirst select dates (you can select several), then choose Hours, All Day or Unavailable.'))
    .addActionRowComponents(row(dateMultiSelect('selectbulk',round,member)))
    .addActionRowComponents(row(
      button(key('quickbulk',round.id),'Choose Hours',ButtonStyle.Primary),
      button(key('bulkfast',round.id,'all'),'All Day',ButtonStyle.Success),
      button(key('bulkfast',round.id,'off'),'Unavailable',ButtonStyle.Secondary)
    ))
    .addTextDisplayComponents(display('**Or edit one day**\nChoose a date to open its editor.'))
    .addActionRowComponents(row(datePicker('jump',round.id,round,'Choose a day to edit')));
  const main=[
    button(key('review',round.id),'Review & Submit',ButtonStyle.Success),
    button(key('tools',round.id),'More Day Tools')
  ];
  if(template) main.unshift(button(key('reuse',round.id),'Reuse Usual Week'));
  container.addActionRowComponents(row(...main));
  const extras=[
    button(key('clock',round.id),member.clockFormat==='12'?'12-hour clock':'24-hour clock')
  ];
  if(member.undo) extras.push(button(key('undo',round.id),'Undo Last Edit'));
  if(member.submitted) extras.push(button(key('template',round.id),'Save Usual Week'));
  container.addActionRowComponents(row(...extras));
  return privatePayload({components:[container]});
}
function dayTools(round,member) {
  return panel('More Day Tools',
    'For less common changes: multiple time windows, maximum stay and copying a finished day. '+
    'Ordinary editing is faster from the weekly overview.\n\nChoose which date to manage:',
    [
      row(datePicker('detail',round.id,round,'Open detailed date editor')),
      row(button(key('home',round.id),'Back to Week',ButtonStyle.Primary)),
    ]);
}
function dayView(round,member,date,notice='') {
  const day=member.draft[date];
  const idx=round.dates.indexOf(date);
  const controls=[
    row(
      button(key('quickdate',round.id,date),'Set/Replace Hours',ButtonStyle.Primary),
      button(key('all',round.id,date),'All Day',ButtonStyle.Success),
      button(key('off',round.id,date),'Unavailable',ButtonStyle.Secondary)
    ),
    row(
      button(key('add',round.id,date,'confirmed'),'Add Available Window'),
      button(key('add',round.id,date,'tentative'),'Add Tentative Window'),
      button(key('copy',round.id,date),'Copy to Days',ButtonStyle.Secondary,!day)
    )
  ];
  if(day?.windows?.length) {
    const opts=day.windows.map((w,i)=>({
      label:(i+1)+'. '+(w.kind==='tentative'?'Tentative':'Available')+' '+w.start+'–'+w.end,
      value:String(i),
    }));
    controls.push(row(new StringSelectMenuBuilder().setCustomId(key('editwin',round.id,date))
      .setPlaceholder('Edit an existing window').setOptions(opts)));
    controls.push(row(new StringSelectMenuBuilder().setCustomId(key('delwin',round.id,date))
      .setPlaceholder('Remove a window').setOptions(opts)));
  }
  controls.push(row(
    button(key('home',round.id),'Week Overview'),
    button(key('day',round.id,round.dates[idx-1]||date),'← Previous',ButtonStyle.Secondary,idx===0),
    button(key('day',round.id,round.dates[idx+1]||date),'Next →',ButtonStyle.Secondary,idx===round.dates.length-1)
  ));
  return panel(label(date),'**Current answer**\n'+details(day,member.clockFormat)+
    '\n\nAdd more windows when you need separate confirmed and tentative hours. '+
    'Changes stay in your draft until final review.',controls,BLUE,notice);
}
function multiView(round,member,source=null,notice='') {
  const selected=member.selection.filter(d=>round.dates.includes(d)&&d!==source);
  const copy=Boolean(source);
  const body=(copy?'**Copy from '+label(source)+'**\n'+details(member.draft[source],member.clockFormat):
    'Select several dates and apply one common availability pattern.')+
    '\n\n**'+selected.length+' selected**'+(selected.length?'\n'+selected.map(fmt).join(', '):'');
  const controls=[row(dateMultiSelect(copy?'dest':'dates',round,member,source))];
  if(copy) {
    controls.push(row(button(key('proposecopy',round.id,source),'Review Copy',ButtonStyle.Primary,!selected.length),
      button(key('day',round.id,source),'Back')));
  } else {
    controls.push(row(
      button(key('bulkset',round.id,'all'),'All Day',ButtonStyle.Success,!selected.length),
      button(key('bulkset',round.id,'off'),'Unavailable',ButtonStyle.Secondary,!selected.length),
      button(key('bulkset',round.id,'maybe'),'Tentative All Day',ButtonStyle.Secondary,!selected.length)
    ));
    controls.push(row(
      button(key('bulkwin',round.id,'confirmed'),'Available Hours',ButtonStyle.Primary,!selected.length),
      button(key('bulkwin',round.id,'tentative'),'Tentative Hours',ButtonStyle.Secondary,!selected.length)
    ));
    controls.push(row(button(key('home',round.id),'Back to Week')));
  }
  return panel(copy?'Copy Day':'Edit Several Days',body,controls,BLUE,notice);
}
function pendingView(round,member,template) {
  const p=member.pending;
  const source=p?.source,dates=p?.dates||[];
  const description=p?.type==='copy'?'Copy from '+label(source):
    p?.type==='reuse'?'Reuse My Usual Week':
    p?.type==='template'?'Save Submitted Week as Template':'Apply to Selected Days';
  const changes=dates.map(d=>{
    const incoming=p?.type==='reuse'?template?.[weekday(d)]:
      p?.type==='copy'?member.draft[source]:p?.day;
    return '**'+fmt(d)+'**\n'+summary(member.draft[d],member.clockFormat)+
      ' → '+summary(incoming,member.clockFormat);
  }).join('\n');
  return panel('Review Changes','**'+description+'**\n\n'+
    (p?.type==='template'?'This changes only your future usual-week template.':changes)+
    '\n\nThese changes affect your **draft**, not your submitted response.',
    [row(
      button(key('apply',round.id),'Apply Changes',ButtonStyle.Success),
      button(key('cancel',round.id),'Cancel')
    )],YELLOW);
}
function reviewView(round,member) {
  const missing=round.dates.filter(d=>!member.draft[d]);
  const altered=member.submitted?round.dates.filter(d=>
    JSON.stringify(member.draft[d])!==JSON.stringify(member.submitted[d])):[];
  const body='These are the exact answers you are about to submit.\n\n'+
    allLines(round,member.draft,member.clockFormat)+
    (altered.length?'\n\n**Changes since last submission:** '+altered.map(fmt).join(', '):'')+
    (missing.length?'\n\n**Unanswered:** '+missing.map(fmt).join(', ')+
      '\nAnswer these before submitting.':'\n\n**All dates answered.**');
  const controls=[row(
    button(key('submit',round.id),'Confirm & Submit',ButtonStyle.Success,missing.length>0),
    button(key('home',round.id),'Back to Week')
  )];
  if(missing.length)controls.push(row(
    button(key('quickdate',round.id,missing[0]),'Edit First Unanswered',ButtonStyle.Primary)
  ));
  return panel('Review & Submit',body,controls,missing.length?YELLOW:GREEN);
}
function hourOptions(format,end=false) {
  return Array.from({length:end?25:24},(_,i)=>({
    value:String(i),
    label:i===24?(format==='12'?'12 AM (end of day)':'24:00 (end of day)'):
      format==='12'?String(i%12||12)+(i<12?' AM':' PM'):String(i).padStart(2,'0'),
  }));
}
function minuteOptions(){
  return Array.from({length:12},(_,i)=>({
    value:String(i*5).padStart(2,'0'),label:String(i*5).padStart(2,'0'),
  }));
}
function pick(id,options,selected){
  return new StringSelectMenuBuilder().setCustomId(id).setMinValues(1).setMaxValues(1)
    .setOptions(options.map(o=>({...o,default:selected!==undefined&&o.value===String(selected)})));
}
function labelled(text,select,description='') {
  const result=new LabelBuilder().setLabel(text).setStringSelectMenuComponent(select);
  if(description)result.setDescription(description);
  return result;
}
const numericHour=value=>String(Number(value.slice(0,2)));
function timeLabels(existing,format) {
  const start=existing?.start||'19:00',end=existing?.end||'23:00';
  return [
    labelled('Start hour',pick('start_h',hourOptions(format),numericHour(start))),
    labelled('Start minute',pick('start_m',minuteOptions(),start.slice(3))),
    labelled('End hour',pick('end_h',hourOptions(format,true),numericHour(end))),
    labelled('End minute',pick('end_m',minuteOptions(),end.slice(3))),
  ];
}
function quickModal(sid,dates,member,mode='day') {
  const isDay=mode==='day',date=isDay?dates[0]:null;
  const existing=isDay?member.draft[date]?.windows?.[0]:null;
  const status=isDay?(member.draft[date]?.status==='unavailable'?'off':
    existing?.kind||'confirmed'):'confirmed';
  const complex=isDay && (member.draft[date]?.windows?.length>1 || existing?.maxMinutes!=null);
  const warning=complex?'Warning: this replaces all existing windows and duration limits.':
    isDay?'All day and Unavailable ignore time fields; saving replaces this date.':
      'Saving replaces existing answers on all selected dates.';
  const options=[
    {label:'Available during these hours',value:'confirmed'},
    {label:'Tentative during these hours',value:'tentative'},
    {label:'Available all day',value:'all'},
    {label:'Tentative all day',value:'maybe'},
    {label:'Unavailable',value:'off'},
  ];
  return new ModalBuilder()
    .setCustomId(key('quickwin',sid,mode,date||'multi'))
    .setTitle(isDay?'Edit '+fmt(date):'Edit '+dates.length+' Selected Day(s)')
    .addLabelComponents(
      labelled('Availability',pick('quick_status',options,status),
        warning),
      ...timeLabels(existing,member.clockFormat||'24')
    );
}
function windowModal(sid,date,kind,format='24',existing=null,index=-1,bulk=false){
  const capOptions=[
    {value:'none',label:'No limit'},
    ...[30,45,60,90,120,150,180,240,300,360,480,600,720,960,1440].map(m=>({
      value:String(m),label:m%60===0?(m/60)+' hour(s)':m+' minutes',
    }))
  ];
  return new ModalBuilder().setCustomId(key('win',sid,bulk?'multi':date,kind,String(index)))
    .setTitle(bulk?'Set Hours for Selected Days':'Edit Time Window')
    .addLabelComponents(
      ...timeLabels(existing,format),
      labelled('Maximum time I can stay',pick('cap',capOptions,existing?.maxMinutes??'none'))
    );
}
function copyModal(sid,round,member,source){
  const choices=round.dates.filter(d=>d!==source);
  return new ModalBuilder().setCustomId(key('quickcopy',sid,source))
    .setTitle('Copy '+fmt(source)+' to Other Days')
    .addLabelComponents(
      labelled('Choose destination days',
        new StringSelectMenuBuilder().setCustomId('copy_targets')
          .setMinValues(1).setMaxValues(choices.length)
          .setOptions(choices.map(d=>({
            label:label(d),value:d,
            description:summary(member.draft[d],member.clockFormat).slice(0,90),
          }))),
        'Copies every window and replaces answers on selected days.')
    );
}
function invite(round) {
  return {
    embeds:[new EmbedBuilder().setColor(BLUE)
      .setTitle('[TEST] WinterBot weekly availability')
      .setDescription('Try the redesigned **native Discord** availability editor.\n\n'+
        'Open your private week, select dates and edit using Discord pop-ups.\n\n'+
        'Test week: **'+fmt(round.dates[0])+' – '+fmt(round.dates.at(-1))+'**')
      .setFooter({text:'TEST ONLY · No real events, roles or channels'})],
    components:[row(button(key('open',round.id),'Open My Weekly Availability',ButtonStyle.Primary))],
    allowedMentions:{parse:[]},
  };
}
module.exports={
  key,privatePayload,panel,overview,dayView,dayTools,multiView,pendingView,reviewView,
  quickModal,windowModal,copyModal,invite,summary,fmt,label,details,
};