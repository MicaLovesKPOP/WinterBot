import { DiscordSDK } from '@discord/embedded-app-sdk';

// Member-facing Activity, separate from the organizer's web setup wizard.
// The backend always verifies OAuth identity and test-channel access.
const root = document.getElementById('app');
let state = null;
let selectedDay = null;
let pending = false;
let notice = '';
let noticeError = false;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}
function minutes(time) {
  const [hours, mins] = time.split(':').map(Number);
  return hours * 60 + mins;
}
function hhmm(n) {
  return String(Math.floor(n / 60)).padStart(2,'0') + ':' +
    String(n % 60).padStart(2,'0');
}
function dateLabel(value, compact = false) {
  const date = new Date(value + 'T12:00:00Z');
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: compact ? 'short' : 'long',
    day: 'numeric', month: compact ? 'short' : 'long',
  }).format(date);
}
function capOptions(value, maximum, anyText) {
  let html = '<option value=""' + (value == null ? ' selected' : '') + '>' +
    escapeHtml(anyText) + '</option>';
  for (let m = 15; m <= Math.min(maximum, 720); m += 15) {
    const label = m % 60 === 0 ? m / 60 + (m === 60 ? ' hour' : ' hours') :
      Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2,'0') + 'm';
    html += '<option value="' + m + '"' + (m === value ? ' selected' : '') +
      '>' + label + '</option>';
  }
  return html;
}
function timeOptions(chosen, bounds, isEnd, partner) {
  const start = minutes(bounds.start), end = minutes(bounds.end);
  const from = isEnd ? Math.max(start + 15, minutes(partner) + 15) : start;
  const to = isEnd ? end : Math.min(end - 15, minutes(partner) - 15);
  let html = '';
  for (let m = from; m <= to; m += 15) {
    const value = hhmm(m);
    html += '<option value="' + value + '"' + (value === chosen ? ' selected' : '') +
      '>' + value + (value === '24:00' ? ' (midnight)' : '') + '</option>';
  }
  return html;
}
function allowed(date) {
  return state.round.dayLimits[date] || { start:'00:00', end:'24:00' };
}
function currentEntry() {
  return state.round.availability[selectedDay] || { status:'unanswered', windows:[] };
}
function canUse(windows, date) {
  const range = allowed(date);
  return windows.map(w => {
    const start = Math.max(minutes(w.start), minutes(range.start));
    const end = Math.min(minutes(w.end), minutes(range.end));
    if (end - start < 15) return null;
    return { start:hhmm(start), end:hhmm(end),
      maxMinutes:w.maxMinutes == null ? null : Math.min(w.maxMinutes,end-start) };
  }).filter(Boolean);
}
function freeWindow(windows, date) {
  const range = allowed(date);
  const begin = minutes(range.start), finish = minutes(range.end);
  let current = begin;
  for (const w of [...windows].sort((a,b)=>minutes(a.start)-minutes(b.start))) {
    if (minutes(w.start) - current >= 15) return {
      start:hhmm(current),end:hhmm(Math.min(minutes(w.start),current+180)),maxMinutes:null,
    };
    current = Math.max(current,minutes(w.end));
  }
  if (finish - current >= 15) return {
    start:hhmm(current),end:hhmm(Math.min(current+180,finish)),maxMinutes:null,
  };
  return null;
}
function button(label, action, extra = '', className = '') {
  return '<button type="button" class="btn ' + className + '" data-action="' + action + '"' +
    extra + '>' + escapeHtml(label) + '</button>';
}
function chrome(content) {
  const r = state.round;
  root.innerHTML = '<main class="shell">' +
    '<div class="top"><div><div class="kicker">WinterBot · embedded Discord Activity</div>' +
    '<div class="brand">Your availability</div><p class="sub">' +
    escapeHtml(r.title) + '</p></div><span class="test">TEST SERVER ONLY</span></div>' +
    (notice ? '<div class="status' + (noticeError ? ' error' : '') + '" role="status">' +
      escapeHtml(notice) + '</div>' : '') +
    content +
    '<div class="footer">Only your own answers are shown here. ' +
    'This test will never create real Discord events.</div></main>';
  if (pending) root.querySelectorAll('button,select,input').forEach(el => {el.disabled = true;});
}
function render() {
  if (!state) return;
  const r = state.round;
  if (r.phase === 'voting') return renderVote();
  if (r.phase !== 'collecting') {
    return chrome('<div class="card"><h2>Collection is closed</h2><p class="muted">' +
      'Management is reviewing the suggestions. You can close this Activity.</p></div>');
  }
  if (!selectedDay || !r.dates.includes(selectedDay)) selectedDay = r.dates[0];
  const entry = currentEntry();
  const windowList = canUse(entry.windows, selectedDay);
  const bounds = allowed(selectedDay);
  const done = r.dates.filter(d => r.availability[d]?.status &&
    r.availability[d].status !== 'unanswered').length;
  let html = '<div class="card"><div class="flex between">' +
    '<strong>' + done + ' of ' + r.dates.length + ' dates answered</strong>' +
    '<span class="pill">' + escapeHtml(r.timezone) + '</span></div>' +
    '<p class="small muted">Your changes are saved automatically. You may edit them until the deadline.</p></div>';
  html += '<div class="days">' + r.dates.map(date => {
    const answer = r.availability[date]?.status || 'unanswered';
    return '<button type="button" data-action="day" data-date="' + date +
      '" class="day' + (selectedDay === date ? ' active' : '') +
      (answer !== 'unanswered' ? ' answered' : '') + '">' +
      '<strong>' + escapeHtml(dateLabel(date, true)) + '</strong><span>' +
      escapeHtml(answer === 'unanswered' ? 'Not answered' : answer) + '</span></button>';
  }).join('') + '</div>';
  html += '<section class="card"><div class="flex between"><h2>' +
    escapeHtml(dateLabel(selectedDay)) + '</h2><span class="pill">' +
    escapeHtml(bounds.start) + '–' + escapeHtml(bounds.end) + '</span></div>' +
    '<p class="muted small">Events on this date can only be scheduled inside the listed hours.</p>' +
    '<div class="options">' + [['available','Available'],['unavailable','Unavailable'],
      ['unanswered','Not sure yet']].map(([status,label]) => button(
      label,'status',' data-status="' + status + '"',
      status === entry.status ? 'active' : 'soft',
    )).join('') + '</div>';
  if (entry.status === 'available') {
    html += '<div class="flex">' +
      button('All allowed hours', 'preset-all','','small') +
      button('Evening (if available)', 'preset-evening','','small') + '</div>';
    html += '<div class="cap"><div class="field">' +
      '<label for="day-cap">Maximum stay for this whole day</label>' +
      '<select id="day-cap">' +
      capOptions(entry.maxMinutes, r.maxDurationMinutes, 'No overall limit') +
      '</select></div><div class="help">Applies to any one event on this date, ' +
      'across every availability window. A shorter limit on an individual window still applies.</div></div>';
    windowList.forEach((w,i) => {
      html += '<div class="window"><div class="window-head"><h3>Availability window ' + (i+1) +
        '</h3>' + button('Remove','remove',' data-index="' + i + '"','small danger') +
        '</div><div class="grid3"><div class="field"><label for="start-' + i + '">From</label>' +
        '<select id="start-' + i + '" data-win="' + i + '" data-field="start">' +
        timeOptions(w.start,bounds,false,w.end) + '</select></div>' +
        '<div class="field"><label for="end-' + i + '">Until</label>' +
        '<select id="end-' + i + '" data-win="' + i + '" data-field="end">' +
        timeOptions(w.end,bounds,true,w.start) + '</select></div>' +
        '<div class="field"><label for="cap-' + i + '">Maximum stay</label>' +
        '<select id="cap-' + i + '" data-win="' + i + '" data-field="maxMinutes">' +
        capOptions(w.maxMinutes,minutes(w.end)-minutes(w.start),'No window limit') +
        '</select></div></div></div>';
    });
    html += '<div class="flex" style="margin-top:12px">' +
      button('＋ Add another window','add','','soft') + '</div>' +
      '<p class="help">Separate windows remain separate. An event must fit entirely inside one window.</p>';
  } else {
    html += '<p class="muted">' +
      (entry.status === 'unavailable' ? 'You marked this date unavailable.' :
        'You can decide later; unanswered dates are not treated as available.') +
      '</p>';
  }
  html += '</section>';
  chrome(html);
}
function renderVote() {
  const ballot = state.round.ballot;
  if (!ballot) return chrome('<div class="card"><h2>Ballot is unavailable</h2></div>');
  const votes = new Set(ballot.votes);
  const rows = ballot.options.map(option =>
    '<label class="vote"><input type="checkbox" data-vote="' + escapeHtml(option.id) +
    '"' + (votes.has(option.id) ? ' checked' : '') + '>' +
    escapeHtml(dateLabel(option.date)) + ' · ' +
    escapeHtml(option.time) + ' · ' + option.durationMinutes + ' minutes</label>'
  ).join('');
  chrome('<div class="card"><h2>Vote on the suggested times</h2>' +
    '<p class="muted">Choose every option you would prefer, then save your vote. ' +
    'You can change your selections while voting remains open.</p>' +
    rows + button('Save my vote','save-vote','','primary') + '</div>');
}
async function request(apiPath, body) {
  const init = {
    credentials:'include',
    headers:{'Accept':'application/json'},
  };
  if (body !== undefined) {
    init.method='POST';
    init.headers['Content-Type']='application/json';
    init.headers['X-WinterBot-Activity']='1';
    init.body=JSON.stringify(body);
  }
  const response=await fetch('./api/' + apiPath,init);
  let data;
  try { data=await response.json(); }
  catch { throw new Error('WinterBot returned an unreadable response.'); }
  if (!response.ok) throw new Error(data.error || 'Request failed (' + response.status + ').');
  return data;
}
async function save(entry) {
  const updated=await request('availability',{days:[{date:selectedDay,...entry}]});
  state.round=updated.round;
}
async function update(operation, label = 'Saved automatically') {
  if (pending) return;
  pending=true;
  const savedDay=selectedDay;
  render();
  try {
    await operation();
    selectedDay=savedDay;
    notice=label;
    noticeError=false;
  } catch(error) {
    notice=error.message || 'Could not save your answer.';
    noticeError=true;
  } finally {
    pending=false;
    render();
  }
}
root.addEventListener('click',event=>{
  const node=event.target.closest('[data-action]');
  if (!node || pending || !state) return;
  const action=node.dataset.action;
  const entry=currentEntry();
  const windows=canUse(entry.windows,selectedDay);
  if (action==='day') {selectedDay=node.dataset.date;notice='';return render();}
  if (action==='status') {
    return update(async()=>{
      const status=node.dataset.status;
      await save({status,windows: status==='available' ?
        (windows.length ? windows : [{...allowed(selectedDay),maxMinutes:null}]) : [],
        maxMinutes:status==='available'?entry.maxMinutes ?? null:null});
    });
  }
  if (action==='preset-all' || action==='preset-evening') {
    const r=allowed(selectedDay);
    let start=minutes(r.start),end=minutes(r.end);
    if (action==='preset-evening') {
      start=Math.max(start,18*60);
      end=Math.min(end,23*60);
      if(end-start<15){notice='No evening hours are allowed on this date.';noticeError=true;return render();}
    }
    return update(()=>save({status:'available',maxMinutes:entry.maxMinutes ?? null,
      windows:[{start:hhmm(start),end:hhmm(end),maxMinutes:null}]}));
  }
  if (action==='add') {
    const next=freeWindow(windows,selectedDay);
    if(!next){notice='No free time remains. Adjust an existing window first.';noticeError=true;return render();}
    return update(()=>save({status:'available',windows:[...windows,next]}));
  }
  if (action==='remove') {
    if(windows.length===1){notice='Keep one window or mark this date unavailable.';noticeError=true;return render();}
    windows.splice(Number(node.dataset.index),1);
    return update(()=>save({status:'available',windows}));
  }
  if (action==='save-vote') {
    // Snapshot checked options BEFORE update() redraws/locks the form.
    const candidateIds=[...root.querySelectorAll('[data-vote]:checked')].map(x=>x.dataset.vote);
    return update(async()=>{
      state.round=(await request('vote',{candidateIds})).round;
    },'Your vote has been saved');
  }
});
root.addEventListener('change',event=>{
  const node=event.target;
  if(!state||pending)return;
  const entry=currentEntry();
  if(node.id==='day-cap'){
    const windows=canUse(entry.windows,selectedDay);
    return update(()=>save({status:'available',windows,
      maxMinutes:node.value===''?null:Number(node.value)}));
  }
  if(node.hasAttribute('data-win')){
    const windows=canUse(entry.windows,selectedDay);
    const i=Number(node.dataset.win), field=node.dataset.field;
    if(!windows[i])return;
    windows[i][field]=field==='maxMinutes'
      ? (node.value===''?null:Number(node.value)) : node.value;
    return update(()=>save({status:'available',windows}));
  }
});
async function init() {
  try {
    // The SDK should only be instantiated inside the Activity iframe.
    // The explicit factory is used solely by isolated Playwright mock tests;
    // the backend never trusts the browser for authentication.
    if(window.top===window.self && !window.__WINTERBOT_ACTIVITY_SDK_FACTORY__) {
      root.innerHTML='<main class="shell"><div class="card"><h2>Open inside Discord</h2>' +
        '<p class="muted">Use WinterBot’s Activity button in the test channel. ' +
        'This is not a separate website sign-in.</p></div></main>';
      return;
    }
    const config=await request('config');
    const sdk=window.__WINTERBOT_ACTIVITY_SDK_FACTORY__
      ? window.__WINTERBOT_ACTIVITY_SDK_FACTORY__(config.clientId)
      : new DiscordSDK(config.clientId);
    await sdk.ready();
    let authorized;
    try {
      authorized=await sdk.commands.authorize({
        client_id:config.clientId,response_type:'code',state:'',
        prompt:'none',scope:['identify'],
      });
    } catch (_) {
      authorized=await sdk.commands.authorize({
        client_id:config.clientId,response_type:'code',state:'',
        prompt:'consent',scope:['identify'],
      });
    }
    if(!authorized?.code) throw new Error('Discord did not authorize the Activity.');
    const token=await request('token',{code:authorized.code});
    const auth=await sdk.commands.authenticate({access_token:token.access_token});
    if(!auth) throw new Error('Discord Activity authentication did not finish.');
    state=await request('state');
    selectedDay=state.round.dates[0];
    render();
  } catch(error) {
    root.innerHTML='<main class="shell"><div class="top"><div class="brand">WinterBot Activity</div>' +
      '<span class="test">TEST ONLY</span></div><div class="card"><h2>Could not open the planner</h2>' +
      '<p class="muted">' + escapeHtml(error.message || 'Unknown error') + '</p>' +
      '<p class="help">Check Activity URL mapping, Discord authorization and your access to the test channel. ' +
      'Close and reopen the Activity to try again.</p></div></main>';
  }
}
init();
