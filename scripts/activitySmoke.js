'use strict';

// Browser-level UX validation using a fake SDK and fake API only.
// OAuth, permissions and backend writes are separately tested over HTTP.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {chromium}=require('playwright-core');
const {createScheduler}=require('../src/scheduling/server');
const {createActivityTest}=require('../src/scheduling/activityTest');

const EDGE=process.env.WINTERBOT_BROWSER||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-activity-browser-'));
const port=12421,base='http://127.0.0.1:'+port;
const clientId='112233445566778899';
const activity=createActivityTest({
  client:{guilds:{async fetch(){throw Error('No live Discord in UI smoke test');}}},
  clientId,clientSecret:'test-only',
  sessionSecret:'activity-test-local-only-at-least-32-characters',
  dataFile:path.join(temp,'activity.json'),
});
const app=createScheduler({mode:'demo',host:'127.0.0.1',port,
  activityTest:activity,dataFile:path.join(temp,'demo.json')});
const dates=['2026-10-12','2026-10-13','2026-10-14','2026-10-15',
  '2026-10-16','2026-10-17','2026-10-18'];
const state={
  user:{id:'123456789012345678',name:'Test member'},
  round:{id:'weekly-ui',title:'Weekly Game Night',dates,timezone:'Europe/Amsterdam',
    allowedHoursByDate:{[dates[0]]:{start:'18:00',end:'24:00'}}},
  member:{draft:{},submitted:null,submittedAt:null,clockFormat:'24'},
  template:null,progress:{answered:0,total:7,complete:false,reviewed:false},
};
let serverReviewed=null,saves=0;
function snap(){
  state.progress.answered=dates.filter(d=>state.member.draft[d]).length;
  state.progress.complete=state.progress.answered===7;
  return structuredClone({...state,sandbox:true});
}
function json(data,status=200){
  return {status,contentType:'application/json',body:JSON.stringify(data)};
}
async function run(){
  await app.start();
  const browser=await chromium.launch({headless:true,executablePath:EDGE,
    args:['--no-sandbox','--disable-gpu']});
  try{
    const context=await browser.newContext({viewport:{width:1000,height:860}});
    await context.addInitScript(()=>{
      window.__WINTERBOT_ACTIVITY_SDK_FACTORY__=()=>({
        ready:async()=>{},commands:{
          authorize:async()=>({code:'mock-auth-code'}),
          authenticate:async()=>({id:'test-member'}),
        },
      });
    });
    const page=await context.newPage(),errors=[];
    page.setDefaultTimeout(8000);
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/activity/api/**',async route=>{
      const request=route.request(),pathname=new URL(request.url()).pathname;
      assert.equal(request.headers()['ngrok-skip-browser-warning'],'1',
        'Activity API must bypass the ngrok free-tier warning through Discord proxy');
      const body=request.postDataJSON?.()||{};
      if(pathname.endsWith('/config'))return route.fulfill(json({clientId}));
      if(pathname.endsWith('/token'))return route.fulfill(json({access_token:'mock-token'}));
      if(pathname.endsWith('/ux/state'))return route.fulfill(json(snap()));
      if(pathname.endsWith('/ux/draft')){
        saves++;
        // Simulate a slow network write. The browser must still respond instantly.
        await new Promise(resolve=>setTimeout(resolve,450));
        for(const entry of body.days||[]){
          if(entry.status==='unanswered')delete state.member.draft[entry.date];
          else state.member.draft[entry.date]={status:entry.status,windows:entry.windows||[]};
        }
        serverReviewed=null;
        return route.fulfill(json(snap()));
      }
      if(pathname.endsWith('/ux/review')){
        serverReviewed=JSON.stringify(state.member.draft);
        state.progress.reviewed=true;return route.fulfill(json(snap()));
      }
      if(pathname.endsWith('/ux/submit')){
        if(!state.progress.complete||serverReviewed!==JSON.stringify(state.member.draft))
          return route.fulfill(json({error:'Review and complete every date.'},400));
        state.member.submitted=structuredClone(state.member.draft);
        state.member.submittedAt=new Date().toISOString();
        return route.fulfill(json(snap()));
      }
      if(pathname.endsWith('/ux/discard-revision')){
        if(!body.confirm||!state.member.submitted)
          return route.fulfill(json({error:'No confirmed submission to restore.'},400));
        state.member.draft=structuredClone(state.member.submitted);
        serverReviewed=null;state.progress.reviewed=false;
        return route.fulfill(json(snap()));
      }
      if(pathname.endsWith('/ux/template-update')){
        if(!body.confirm||!Object.keys(body.days||{}).length)
          return route.fulfill(json({error:'Review your usual week.'},400));
        state.template=structuredClone(body.days);
        return route.fulfill(json(snap()));
      }
      if(pathname.endsWith('/ux/template-save')){
        state.template=Object.fromEntries(dates.map((d,i)=>[
          ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][i],
          structuredClone(state.member.submitted[d]),
        ]));
        return route.fulfill(json(snap()));
      }
      if(pathname.endsWith('/ux/template-apply')){
        for(let i=0;i<dates.length;i++)
          state.member.draft[dates[i]]=structuredClone(state.template[
            ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][i]]);
        return route.fulfill(json(snap()));
      }
      if(pathname.endsWith('/ux/preference')){
        state.member.clockFormat=body.clock;
        return route.fulfill(json(snap()));
      }
      return route.fulfill(json({error:'No mock route '+pathname},404));
    });
    await page.goto(base+'/activity/',{waitUntil:'networkidle'});
    await page.getByRole('heading',{name:'Your week',exact:true}).waitFor();
    assert.equal(await page.locator('.day-card').count(),7);
    assert.equal(await page.locator('.range-row').count(),0);

    // Immediate local selection and editing while prior save is slow.
    await page.locator('.day-card').nth(1).click();
    await page.getByRole('heading',{name:/Tuesday 13 October/}).waitFor();
    assert.equal(await page.locator('.range-row').count(),0);
    await page.locator('[data-action="add-window"]').click();
    await page.getByRole('dialog',{name:'Choose availability hours'}).waitFor();
    assert.equal(await page.locator('.range-row').count(),0,
      'Adding a range does not insert fabricated default hours');
    assert.equal(await page.locator('.clock-time-tab').first().innerText(), 'From\n--:--');
    assert.equal(await page.locator('.clock-time-tab').nth(1).innerText(), 'Until\n--:--');
    assert.equal(await page.locator('.clock-number.selected').count(),0,
      'A new range must start without a preselected hour');
    await page.setViewportSize({width:462,height:460});
    fs.mkdirSync(path.join(process.cwd(),'preview-screens'),{recursive:true});
    await page.screenshot({path:path.join(process.cwd(),'preview-screens',
      'clock-picker-empty-new-window.png')});
    await page.locator('.clock-number[data-value="19"]').click();
    await page.locator('.clock-number[data-value="30"]').click();
    assert.equal(await page.locator('[data-action="clock-target"][data-which="end"]').getAttribute('aria-pressed'),'true');
    await page.locator('.clock-number[data-value="23"]').click();
    await page.locator('.clock-number[data-value="0"]').click();
    await page.locator('[data-action="clock-save"]').click();
    await page.locator('.range-row').waitFor();
    assert.match(await page.locator('.range-row').innerText(),/19:30/);
    await page.locator('.day-card').nth(2).click();
    await page.getByRole('heading',{name:/Wednesday 14 October/}).waitFor();
    await page.locator('[data-action="unavailable"]').click();
    assert.equal(await page.locator('.day-card.state-off').count(),1);
    await page.locator('.day-card').nth(1).click();
    assert.equal(await page.locator('input[type="time"]').count(),0,
      'The Activity must not expose the browser scrolling time picker');
    // Invalid hours are grayed out rather than producing a mystery error.
    await page.locator('[data-action="edit-range"][data-which="start"]').first().click();
    await page.getByRole('dialog',{name:'Choose availability hours'}).waitFor();
    assert.equal(await page.locator('.clock-number[data-value="23"]').isDisabled(),true,
      'The starting hour cannot equal the existing 23:00 end');
    assert.equal(await page.locator('.clock-number[data-value="19"]').isDisabled(),false);
    await page.setViewportSize({width:462,height:460});
    const pickerBounds=await page.locator('.clock-dialog').boundingBox();
    assert.ok(pickerBounds.y>=0&&pickerBounds.y+pickerBounds.height<=460,
      'Clock must fit the short Discord window');
    await page.locator('[data-action="dismiss"]').last().click();
    assert.equal(await page.locator('[data-action="edit-range"][data-which="start"]').first()
      .getByText('19:30').count(),1,'Cancel must retain previously saved hours');

    await page.locator('[data-action="edit-range"][data-which="start"]').first().click();
    await page.getByRole('dialog',{name:'Choose availability hours'}).waitFor();
    assert.equal(await page.locator('.clock-number').count(),24,
      '24-hour clock uses the familiar outer/inner hour rings');
    await page.setViewportSize({width:462,height:460});
    const bounds=await page.locator('.clock-dialog').boundingBox();
    assert.ok(bounds.y>=0 && bounds.y+bounds.height<=460 && bounds.width<=462,
      'Clock dialog must fit the narrow 460px Activity: '+JSON.stringify(bounds));
    fs.mkdirSync(path.join(process.cwd(),'preview-screens'),{recursive:true});
    await page.screenshot({path:path.join(process.cwd(),'preview-screens','clock-picker-462x460-hour.png')});
    await page.setViewportSize({width:320,height:460});
    const minimumBounds=await page.locator('.clock-dialog').boundingBox();
    assert.ok(minimumBounds.x>=0&&minimumBounds.y>=0&&
      minimumBounds.x+minimumBounds.width<=320&&minimumBounds.y+minimumBounds.height<=460,
      'Clock picker must fit 320x460 without clipping: '+JSON.stringify(minimumBounds));
    await page.screenshot({path:path.join(process.cwd(),'preview-screens','clock-picker-320x460-hour.png')});
    await page.setViewportSize({width:462,height:460});
    await page.locator('.clock-number[data-value="19"]').click();
    assert.equal(await page.locator('[data-action="clock-target"][data-which="start"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('.clock-number').count(),12,
      'Hour selection advances to 5-minute clock face');
    await page.screenshot({path:path.join(process.cwd(),'preview-screens','clock-picker-462x460-minute.png')});
    await page.locator('.clock-number[data-value="30"]').click();
    assert.equal(await page.locator('[data-action="clock-target"][data-which="end"]').getAttribute('aria-pressed'),'true',
      'FROM minutes should automatically advance to UNTIL hours');
    assert.match(await page.locator('.clock-stages .button.active').innerText(),/Hours/);
    await page.locator('[data-action="clock-save"]').click();
    await page.locator('[data-action="edit-range"][data-which="start"]').first()
      .getByText('19:30').waitFor();
    await page.setViewportSize({width:1000,height:860});
    await page.locator('[data-action="toggle-kind"]').first().click();
    await page.getByText('Tentative hours').waitFor();
    console.log('Local editing remains immediate during background saves.');

    await page.locator('[data-action="multi"]').click();
    await page.locator('.day-card').nth(0).click();
    await page.locator('.day-card').nth(3).click();
    await page.locator('[data-action="batch-mode"][data-mode="hours"]').click();
    await page.locator('[data-action="edit-range"][data-which="start"]').click();
    await page.locator('.clock-number[data-value="20"]').click();
    await page.locator('.clock-number[data-value="0"]').click();
    assert.equal(await page.locator('[data-action="clock-target"][data-which="end"]').getAttribute('aria-pressed'),'true',
      'Batch clock also advances FROM minutes to UNTIL hour automatically');
    await page.locator('.clock-number[data-value="22"]').click();
    await page.locator('.clock-number[data-value="30"]').click();
    await page.getByText('Range chosen · Apply when ready').waitFor();
    assert.equal(await page.locator('[data-action="clock-save"]').count(),1,
      'UNTIL minute completion requires explicit Apply, never autosubmits');
    await page.locator('[data-action="clock-save"]').click();
    assert.match(await page.locator('[data-action="edit-range"][data-which="start"]').innerText(),/20:00/);
    assert.match(await page.locator('[data-action="edit-range"][data-which="end"]').innerText(),/22:30/);
    await page.locator('[data-action="apply-batch"]').click();
    await page.getByText('Your week',{exact:true}).waitFor().catch(()=>{});
    assert.equal(await page.locator('.day-card.state-yes').count(),2);
    // A configured moderator limit (Monday 18:00–24:00) disables times
    // outside that permitted range, while ordinary free hours remain usable.
    await page.locator('.day-card').nth(0).click();
    await page.locator('[data-action="edit-range"][data-which="start"]').click();
    assert.equal(await page.locator('.clock-number[data-value="9"]').isDisabled(),true);
    assert.equal(await page.locator('.clock-number[data-value="18"]').isDisabled(),false);
    assert.equal(await page.locator('.clock-number[data-value="23"]').isDisabled(),true);
    await page.locator('[data-action="dismiss"]').last().click();
    console.log('Moderator-restricted hours are visibly disabled on the clock.');

    // The multi-day change preview uses meaningful certainty colors,
    // including yellow tentative, red unavailable and green replacement.
    await page.locator('[data-action="multi"]').click();
    await page.locator('.day-card').nth(1).click(); // tentative
    await page.locator('.day-card').nth(2).click(); // unavailable
    await page.locator('[data-action="batch-mode"][data-mode="all"]').click();
    await page.locator('[data-action="apply-batch"]').click();
    await page.locator('.dialog .preview-before .status-label.tentative').waitFor();
    await page.locator('.dialog .preview-before .status-label.unavailable').waitFor();
    assert.equal(await page.locator('.dialog .preview-after .status-label.confirmed').count(),2);
    assert.equal(await page.locator('.dialog .mini-time-bar').count(),2);
    await page.setViewportSize({width:462,height:460});
    await page.screenshot({path:path.join(process.cwd(),'preview-screens',
      'weekly-activity-batch-preview-colors.png')});
    await page.locator('.dialog [data-action="dismiss"]').last().click();
    await page.locator('[data-action="mode-single"]').click();
    await page.setViewportSize({width:1000,height:860});

    await page.locator('[data-action="review"]').click();
    await page.getByRole('heading',{name:'Review your availability'}).waitFor();
    assert.equal(await page.locator('[data-action="submit"]').isDisabled(),true);
    console.log('Incomplete availability blocks final confirmation.');
    await page.locator('[data-action="back"]').click();

    for(const n of [4,5,6]){
      await page.locator('.day-card').nth(n).click();
      await page.locator('[data-action="all-day"]').click();
    }
    // The review must compactly list multiple time ranges with NO empty rows
    // between them. Build a realistic confirmed/tentative/confirmed Sunday.
    await page.locator('.day-card').nth(6).click();
    await page.locator('[data-action="clear-day"]').click();
    const addSundayWindow=async(sh,sm,eh,em,tentative=false)=>{
      await page.locator('[data-action="add-window"]').click();
      await page.locator('.clock-number[data-value="'+sh+'"]').click();
      await page.locator('.clock-number[data-value="'+sm+'"]').click();
      await page.locator('.clock-number[data-value="'+eh+'"]').click();
      await page.locator('.clock-number[data-value="'+em+'"]').click();
      await page.locator('[data-action="clock-save"]').click();
      if(tentative)await page.locator('[data-action="toggle-kind"]').last().click();
    };
    await addSundayWindow(8,0,11,0);
    await addSundayWindow(11,0,13,30,true);
    await addSundayWindow(13,30,21,0);
    await page.setViewportSize({width:462,height:460});
    await page.locator('[data-action="review"]').click();
    await page.getByRole('heading',{name:'Review your availability'}).waitFor();
    assert.equal(await page.locator('.review-row .mini-time-bar').count(),7,
      'All seven review dates get compact timelines');
    assert.equal(await page.locator('.review-row').nth(6)
      .locator('.review-time-labels .status-label').count(),3,
      'A day with three ranges must have exactly three compact time labels');
    assert.equal(await page.locator('.review-row .window-separator').count(),0,
      'No separator grid cells or blank rows between time windows');
    assert.equal(await page.locator('.review-row').nth(6)
      .locator('.bar-segment.confirmed').count(),2);
    assert.equal(await page.locator('.review-row').nth(6)
      .locator('.bar-segment.tentative').count(),1);
    assert.equal(await page.locator('.review-row').nth(1)
      .locator('.bar-segment.tentative').count(),1);
    assert.match(await page.locator('.review-row').nth(1)
      .locator('.status-label.tentative').innerText(),/\(tentative\)/i);
    assert.equal(await page.locator('.review-row').nth(2)
      .locator('.bar-segment.unavailable').count(),1);
    const colors=await page.evaluate(()=>{
      const first=document.querySelector('.review-row .status-label.confirmed');
      const tentative=document.querySelector('.review-row .status-label.tentative');
      return {confirmed:getComputedStyle(first).color,tentative:getComputedStyle(tentative).color};
    });
    assert.notEqual(colors.confirmed,colors.tentative,'Tentative cannot be styled green');
    await page.getByText('Scroll through all dates to enable submission.').waitFor();
    assert.equal(await page.locator('[data-action="submit"]').isDisabled(),true,
      'On a short viewport, users must scroll through the review before submitting');
    await page.locator('.review-list').evaluate(el=>{
      el.scrollTop=el.scrollHeight;
      el.dispatchEvent(new Event('scroll',{bubbles:true}));
    });
    await page.locator('[data-action="submit"]:not([disabled])').waitFor();
    fs.mkdirSync(path.join(process.cwd(),'preview-screens'),{recursive:true});
    await page.locator('.review-row').last().scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(process.cwd(),'preview-screens','multi-window-review-compact.png')});
    await page.screenshot({path:path.join(process.cwd(),'preview-screens','weekly-activity-review.png'),
      fullPage:true});
    const reviewBounds=await page.evaluate(()=>{
      const card=document.querySelector('.review-card');
      const actions=document.querySelector('.review-card .bottom-actions');
      return {documentHeight:document.documentElement.scrollHeight,viewportHeight:innerHeight,
        cardBottom:card?.getBoundingClientRect().bottom,
        actionsBottom:actions?.getBoundingClientRect().bottom};
    });
    assert.ok(reviewBounds.documentHeight<=reviewBounds.viewportHeight+1,
      'Final review should not scroll the entire Activity at 460px: '+JSON.stringify(reviewBounds));
    assert.ok(reviewBounds.actionsBottom<=460,'Submit controls must be visible in the fixed review');
    await page.screenshot({path:path.join(process.cwd(),'preview-screens','weekly-activity-review-compact.png')});
    await page.locator('[data-action="submit"]').click();
    await page.getByRole('heading',{name:'Your week is submitted'}).waitFor();
    assert.ok(state.member.submitted);
    const originalSubmission=structuredClone(state.member.submitted);
    await page.locator('[data-action="open-template"]').click();
    await page.getByRole('heading',{name:'Your usual week',exact:true}).waitFor();
    await page.setViewportSize({width:320,height:460});
    const narrowTemplate=await page.evaluate(()=>{
      const footer=document.querySelector('.template-footer');
      const rect=footer.getBoundingClientRect();
      return {
        width:document.documentElement.scrollWidth,
        height:document.documentElement.scrollHeight,
        footerBottom:rect.bottom,
        buttons:[...footer.querySelectorAll('button')].map(btn=>{
          const r=btn.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom};
        }),
      };
    });
    assert.ok(narrowTemplate.width<=321&&narrowTemplate.height<=461&&
      narrowTemplate.footerBottom<=461&&
      narrowTemplate.buttons.every(b=>b.left>=0&&b.right<=321&&b.bottom<=461),
      'Template footer must remain fully usable at 320x460: '+JSON.stringify(narrowTemplate));
    await page.screenshot({path:path.join(process.cwd(),'preview-screens',
      'usual-week-template-editor-320x460.png')});
    await page.setViewportSize({width:462,height:460});
    assert.equal(await page.locator('.day-card').count(),7);
    assert.equal(await page.locator('.day-card.state-off').count(),1,
      'Template initially copies actual submitted answers, not defaults');
    await page.locator('.day-card').nth(2).click();
    await page.locator('[data-action="all-day"]').click();
    assert.equal(state.template,null,'Editing a template must never autosave it');
    assert.deepEqual(state.member.submitted,originalSubmission);
    await page.locator('[data-action="template-cancel"]').click();
    await page.getByRole('heading',{name:'Your week is submitted'}).waitFor();
    assert.equal(state.template,null,'Cancelling template editing preserves old saved template');

    await page.locator('[data-action="open-template"]').click();
    await page.locator('[data-action="template-reset"]').click();
    await page.locator('[data-action="reset-template-blank"]').click();
    assert.equal(await page.locator('.day-card.state-empty').count(),7,
      'Start blank should clear only the temporary template editor');
    await page.locator('[data-action="template-reset"]').click();
    await page.locator('[data-action="reset-template-submitted"]').click();
    await page.screenshot({path:path.join(process.cwd(),'preview-screens','usual-week-template-editor-compact.png')});
    assert.equal(await page.locator('.day-card.state-empty').count(),0,
      'Reset from submitted should restore the starting point');
    await page.locator('.day-card').nth(2).click();
    await page.locator('[data-action="all-day"]').click();
    await page.locator('[data-action="template-review-open"]').click();
    await page.getByRole('heading',{name:'Review your usual week'}).waitFor();
    assert.equal(await page.locator('.template-review .mini-time-bar').count(),7);
    assert.equal(await page.locator('[data-action="template-commit"]').isDisabled(),true,
      'Usual week must be reviewed, not silently saved');
    await page.locator('.template-review .review-list').evaluate(el=>{
      el.scrollTop=el.scrollHeight;
      el.dispatchEvent(new Event('scroll',{bubbles:true}));
    });
    await page.locator('[data-action="template-commit"]:not([disabled])').waitFor();
    await page.screenshot({path:path.join(process.cwd(),'preview-screens',
      'usual-week-template-review-compact.png')});
    await page.locator('[data-action="template-commit"]').click();
    await page.getByRole('heading',{name:'Your week is submitted'}).waitFor();
    assert.equal(Object.keys(state.template).length,7);
    assert.equal(state.template.Wednesday.status,'available');
    assert.equal(originalSubmission[dates[2]].status,'unavailable');
    assert.deepEqual(state.member.submitted,originalSubmission,
      'Saving a revised usual week cannot change a submitted event response');
    assert.deepEqual(state.member.draft,originalSubmission);
    console.log('Editable usual week, reset, cancel, review and save are independent of event submissions.');

    // Keep editing UX visible for desktop/mobile screenshot and overflow checks.
    await page.locator('[data-action="back"]').click();
    assert.equal(await page.locator('[data-action="reuse"]').count(),1,
      'saved usual-week template should appear as a familiar shortcut');
    await page.locator('.day-card').nth(1).click();
    await page.locator('[data-action="edit-range"][data-which="start"]').first().click();
    await page.locator('[data-clock-format]').uncheck();
    assert.equal(await page.locator('[data-clock-format]').isChecked(),false,
      'The clock preference should have a clear unchecked 12-hour state');
    assert.equal(await page.locator('.clock-number').count(),12,
      '12-hour clock uses one familiar hour ring and AM/PM controls');
    await page.locator('[data-action="clock-ampm"][data-ampm="AM"]').click();
    await page.locator('.clock-number[data-value="7"]').click();
    await page.locator('.clock-number[data-value="30"]').click();
    assert.equal(await page.locator('[data-action="clock-target"][data-which="end"]').getAttribute('aria-pressed'),'true',
      'Completing FROM minutes must automatically open UNTIL hours');
    assert.match(await page.locator('.clock-stages .button.active').innerText(),/Hours/);
    // The user can still return to FROM and refine AM/PM before applying.
    await page.locator('[data-action="clock-target"][data-which="start"]').click();
    await page.locator('[data-action="clock-ampm"][data-ampm="PM"]').click();
    assert.match(await page.locator('[data-action="clock-target"][data-which="start"]').innerText(),/7:30 PM/);
    await page.locator('[data-action="clock-save"]').click();
    await page.locator('[data-action="edit-range"][data-which="start"]').first()
      .getByText('7:30 PM').waitFor();

    await page.locator('[data-action="edit-range"][data-which="end"]').first().click();
    await page.locator('[data-clock-format]').check();
    assert.equal(await page.locator('[data-clock-format]').isChecked(),true,
      'Checked preference uses the 24-hour face');
    await page.locator('[data-action="clock-endday"]').click();
    assert.match(await page.locator('[data-action="clock-target"][data-which="end"]').innerText(),/24:00/);
    await page.locator('[data-action="clock-save"]').click();
    await page.locator('[data-action="edit-range"][data-which="end"]').first().getByText(/24:00/).waitFor();
    // Selecting 00:00 on the Until clock means END OF THE SELECTED DAY
    // (24:00), rather than incorrectly comparing it as 00:00 before From.
    await page.locator('[data-action="edit-range"][data-which="end"]').first().click();
    await page.locator('.clock-number[data-value="0"]').click();
    await page.locator('.clock-number[data-value="0"]').click();
    assert.match(await page.locator('[data-action="clock-target"][data-which="end"]').innerText(),/24:00/);
    await page.locator('[data-action="clock-save"]').click();
    await page.locator('[data-action="edit-range"][data-which="end"]').first().getByText(/24:00/).waitFor();
    await page.locator('[data-action="edit-range"][data-which="end"]').first().click();
    await page.locator('.clock-number[data-value="23"]').click();
    await page.locator('.clock-number[data-value="0"]').click();
    await page.locator('[data-action="clock-save"]').click();
    await page.locator('[data-action="edit-range"][data-which="end"]').first().getByText('23:00').waitFor();

    // Real pointer drag: move back and forth while held. The hand and header
    // must track each movement, but the stage only advances upon release.
    await page.setViewportSize({width:462,height:460});
    const polar=(box,sector,radius)=>({
      x:box.x+box.width/2+radius*box.width/220*Math.sin(sector*Math.PI/6),
      y:box.y+box.height/2-radius*box.height/220*Math.cos(sector*Math.PI/6),
    });
    const moveTo=async(position,steps=8)=>page.mouse.move(position.x,position.y,{steps});
    await page.locator('[data-action="edit-range"][data-which="start"]').first().click();
    let face=await page.locator('.clock-face').boundingBox();
    await moveTo(polar(face,7,56),1); // 19 (inner ring)
    await page.mouse.down();
    await moveTo(polar(face,8,56));
    assert.match(await page.locator('[data-action="clock-target"][data-which="start"]').innerText(),/20:30/,
      'Dragging must update the FROM time before release');
    await moveTo(polar(face,9,56));
    assert.match(await page.locator('[data-action="clock-target"][data-which="start"]').innerText(),/21:30/,
      'Dragging the hand around the clock must keep tracking new choices');
    await moveTo(polar(face,8,88)); // outer ring (08), while still held
    assert.match(await page.locator('[data-action="clock-target"][data-which="start"]').innerText(),/08:30/,
      '24-hour dragging must allow freely moving between inner and outer hour rings');
    await moveTo(polar(face,8,56)); // inner ring again (20)
    assert.match(await page.locator('[data-action="clock-target"][data-which="start"]').innerText(),/20:30/);
    const liveHandX=Number(await page.locator('.clock-hand').getAttribute('x2'));
    assert.ok(liveHandX<100,'The clock hand must rotate along with the selected hour');
    assert.match(await page.locator('.clock-stages .button.active').innerText(),/Hours/,
      'The dial must not jump to minutes while the pointer is held');
    await page.mouse.up();
    assert.match(await page.locator('.clock-stages .button.active').innerText(),/Minutes/,
      'Releasing the hour advances to FROM minutes');
    face=await page.locator('.clock-face').boundingBox();
    await moveTo(polar(face,6,88),1); // 30 minutes
    await page.mouse.down();
    await moveTo(polar(face,7,88)); // 35 minutes
    assert.match(await page.locator('[data-action="clock-target"][data-which="start"]').innerText(),/20:35/,
      'Dragging minutes must update the preview continuously');
    assert.match(await page.locator('.clock-stages .button.active').innerText(),/Minutes/,
      'The minute dial must not jump while still dragging');
    await page.mouse.up();
    assert.equal(await page.locator('[data-action="clock-target"][data-which="end"]').getAttribute('aria-pressed'),'true',
      'Releasing FROM minutes must automatically advance to UNTIL hours');
    assert.match(await page.locator('.clock-stages .button.active').innerText(),/Hours/);
    face=await page.locator('.clock-face').boundingBox();
    await moveTo(polar(face,11,56),1); // 23
    await page.mouse.down();
    await moveTo(polar(face,10,56)); // 22
    await page.mouse.up();
    assert.match(await page.locator('.clock-stages .button.active').innerText(),/Minutes/);
    face=await page.locator('.clock-face').boundingBox();
    await moveTo(polar(face,0,88),1);
    await page.mouse.down();
    await moveTo(polar(face,3,88)); // 15
    await moveTo(polar(face,4,88)); // 20
    await moveTo(polar(face,3,88)); // back to 15
    await page.mouse.up();
    await page.getByText('Range chosen · Apply when ready').waitFor();
    assert.match(await page.locator('[data-action="clock-target"][data-which="end"]').innerText(),/22:15/);
    assert.equal(await page.locator('.clock-dialog').count(),1,
      'Dragging the final minute must not auto-submit the range');
    await page.locator('[data-action="clock-save"]').click();
    await page.locator('[data-action="edit-range"][data-which="start"]').first().getByText('20:35').waitFor();
    await page.locator('[data-action="edit-range"][data-which="end"]').first().getByText('22:15').waitFor();
    console.log('Mouse dragging previews continuously, then advances only after release.');

    // Touchscreen drag on the same custom face. The touch gestures must not
    // scroll the clock (touch-action:none) or require tapping each numeral.
    await page.locator('[data-action="edit-range"][data-which="end"]').first().click();
    const touch=await context.newCDPSession(page);
    await touch.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    const touchEvent=async(type,position)=>touch.send('Input.dispatchTouchEvent',{
      type,touchPoints:position?[{x:position.x,y:position.y,id:7,force:1}]:[],
    });
    face=await page.locator('.clock-face').boundingBox();
    await touchEvent('touchStart',polar(face,10,56)); // inner 22
    await touchEvent('touchMove',polar(face,11,56));  // inner 23
    assert.match(await page.locator('[data-action="clock-target"][data-which="end"]').innerText(),/23:15/,
      'A real touch drag must preview the new UNTIL time');
    await touchEvent('touchEnd');
    assert.match(await page.locator('.clock-stages .button.active').innerText(),/Minutes/);
    face=await page.locator('.clock-face').boundingBox();
    await touchEvent('touchStart',polar(face,3,88)); // minute 15
    await touchEvent('touchMove',polar(face,6,88));  // minute 30
    await touchEvent('touchEnd');
    await page.getByText('Range chosen · Apply when ready').waitFor();
    await page.locator('[data-action="clock-save"]').click();
    await page.locator('[data-action="edit-range"][data-which="end"]').first().getByText('23:30').waitFor();
    console.log('Touch dragging works with the same staged hour/minute progression.');

    // A cancelled touch gesture reverts its live preview. The dial remains
    // keyboard-accessible as well (Enter/Space on numbered buttons).
    await page.locator('[data-action="edit-range"][data-which="end"]').first().click();
    face=await page.locator('.clock-face').boundingBox();
    await touchEvent('touchStart',polar(face,11,56));
    await touchEvent('touchMove',polar(face,10,56));
    assert.match(await page.locator('[data-action="clock-target"][data-which="end"]').innerText(),/22:30/);
    await touchEvent('touchCancel');
    assert.match(await page.locator('[data-action="clock-target"][data-which="end"]').innerText(),/23:30/,
      'Cancelled touch drag must roll back the provisional edit');
    assert.match(await page.locator('.clock-stages .button.active').innerText(),/Hours/);
    await page.locator('.clock-number[data-value="22"]').focus();
    await page.keyboard.press('Enter');
    assert.match(await page.locator('.clock-stages .button.active').innerText(),/Minutes/);
    await page.locator('.clock-number[data-value="45"]').focus();
    await page.keyboard.press('Enter');
    await page.getByText('Range chosen · Apply when ready').waitFor();
    await page.locator('[data-action="clock-save"]').click();
    await page.locator('[data-action="edit-range"][data-which="end"]').first().getByText('22:45').waitFor();
    console.log('Pointer cancellation and keyboard time choices remain usable.');

    fs.mkdirSync(path.join(process.cwd(),'preview-screens'),{recursive:true});
    for(const width of [1024,720,375,320]){
      await page.setViewportSize({width,height:800});
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
      assert.ok(overflow<=1,'Horizontal overflow at '+width+'px: '+overflow);
      const shell=await page.locator('.app-shell').boundingBox();
      assert.ok(Math.abs(shell.width-Math.min(width,900))<=2,
        'Tall Activity should use the same 900px cap at '+width+'px');
      assert.ok(Math.abs(shell.x-(width-shell.x-shell.width))<=2,
        'Tall Activity should remain centered at '+width+'px');
      if(width===1024||width===375){
        await page.screenshot({path:path.join(process.cwd(),'preview-screens',
          width===1024?'weekly-activity-desktop.png':'weekly-activity-mobile.png'),
          fullPage:true});
      }
    }
    // The real Discord Activity is about 460px tall, at widths roughly
    // 462px (narrow) to 1018px (wide). Test the actual embedded viewport,
    // not just a conventional tall mobile/desktop browser.
    for(const [width,name] of [[1018,'wide'],[462,'narrow'],[650,'medium'],[900,'limit'],
      [1440,'ultrawide'],[1920,'maxwide']]){
      await page.setViewportSize({width,height:460});
      const metrics=await page.evaluate(()=>{
        const rect=query=>{const el=document.querySelector(query);
          if(!el)return null;const r=el.getBoundingClientRect();
          return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height};
        };
        const cards=[...document.querySelectorAll('.day-card')].map(e=>{
          const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,
            left:r.left,right:r.right,width:r.width};
        });
        return {innerHeight,innerWidth,bodyHeight:document.body.scrollHeight,
          pageHeight:document.documentElement.scrollHeight,
          documentWidth:document.documentElement.scrollWidth,
          shell:rect('.app-shell'),mast:rect('.mast'),hero:rect('.hero'),
          week:rect('.week-section'),
          workspace:rect('.workspace'),editor:rect('.editor-card'),
          footer:rect('.action-footer'),cards,
          editorScroll:document.querySelector('.editor-card').scrollHeight,
          editorClient:document.querySelector('.editor-card').clientHeight,
          footerAccessible:(()=>{
            const btn=document.querySelector('.action-footer button');
            if(!btn)return false;const r=btn.getBoundingClientRect();
            const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
            return hit===btn||btn.contains(hit);
          })()};
      });
      assert.ok(metrics.pageHeight<=461,'Document scrolls beyond 460px in '+name+': '+JSON.stringify(metrics));
      assert.ok(metrics.documentWidth<=width+1,'Horizontal overflow in '+name);
      // Never stretch beyond a comfortable reading width, and center the
      // application at all supported Discord viewport widths.
      const expectedWidth=Math.min(width,900);
      assert.ok(Math.abs((metrics.shell.right-metrics.shell.left)-expectedWidth)<=2,
        'Unexpected app width in '+name+': '+JSON.stringify(metrics.shell));
      assert.ok(Math.abs(metrics.shell.left-(width-metrics.shell.right))<=2,
        'App is not horizontally centered in '+name+': '+JSON.stringify(metrics.shell));
      assert.ok(metrics.footer?.bottom<=461&&metrics.footer?.top>=0,
        'Primary action footer hidden in '+name+': '+JSON.stringify(metrics));
      assert.equal(metrics.footerAccessible,true,
        'Primary footer button must be clickable, not covered by the editor in '+name);
      assert.ok(metrics.workspace.height>160,'Editor workspace too short in '+name);
      assert.ok(metrics.cards.every(c=>c.left>=0&&c.right<=width+1),
        'Calendar day cards spill outside viewport in '+name);
      if(name==='narrow')assert.ok(metrics.cards.every(c=>Math.abs(c.top-metrics.cards[0].top)<2),
        'The seven days should remain on one compact row at narrow width');
      await page.screenshot({path:path.join(process.cwd(),'preview-screens','weekly-activity-460-'+name+'.png')});
      if(name==='narrow'){
        // Complicated availability must scroll inside the editor, never cause
        // the Discord Activity frame or fixed review control to scroll away.
        await page.locator('[data-action="add-window"]').click();
        assert.equal(await page.locator('.range-row').count(),1,
          'Clicking the plus must not insert an arbitrary time window');
        assert.equal(await page.locator('[data-action="clock-save"]').isDisabled(),true,
          'A blank range should have an inactive Apply button');
        await page.locator('.clock-number[data-value="9"]').click();
        await page.locator('.clock-number[data-value="0"]').click();
        await page.locator('.clock-number[data-value="11"]').click();
        await page.locator('.clock-number[data-value="0"]').click();
        await page.locator('[data-action="clock-save"]').click();
        assert.equal(await page.locator('.range-row').count(),2);
        const details=await page.evaluate(()=>{
          const list=document.querySelector('.window-list');
          const header=document.querySelector('.day-overview');
          const footer=document.querySelector('.action-footer button');
          const r=footer.getBoundingClientRect();
          const headerTop=header.getBoundingClientRect().top;
          list.scrollTop=list.scrollHeight;
          return {documentHeight:document.documentElement.scrollHeight,
            internalScroll:list.scrollHeight>list.clientHeight,
            headerPinned:Math.abs(header.getBoundingClientRect().top-headerTop)<1,
            footerVisible:r.top>=0&&r.bottom<=innerHeight};
        });
        assert.ok(details.internalScroll,'Only the time-window list should scroll');
        assert.ok(details.headerPinned,'Day overview must remain fixed above scrolling windows');
        assert.equal(details.footerVisible,true,'Review must stay visible after adding windows');
        assert.ok(details.documentHeight<=461,'Two windows must not create outer scrolling');
        const scrollBefore=await page.locator('.window-list').evaluate(e=>e.scrollTop);
        await page.locator('[data-action="edit-range"][data-which="start"]').last().click();
        await page.locator('.clock-number[data-value="20"]').click();
        await page.locator('.clock-number[data-value="0"]').click();
        await page.locator('[data-action="clock-save"]').click();
        assert.equal(await page.locator('.clock-dialog').count(),0,
          'A valid range closes the clock popup instead of leaving an error overlay');
        const scrollAfter=await page.locator('.window-list').evaluate(e=>e.scrollTop);
        assert.ok(scrollAfter>0,
          'Editing a lower window should retain its visible scroll region');
        assert.equal(await page.locator('input[type="time"]').count(),0);
        await page.screenshot({path:path.join(process.cwd(),'preview-screens',
          'weekly-activity-460-narrow-two-windows.png')});
      }
      console.log('Discord-size Activity '+name+': workspace='+
        Math.round(metrics.workspace.height)+'px; editor viewport='+
        Math.round(metrics.editor.height)+'px; internal scroll='+
        (metrics.editorScroll>metrics.editorClient)+
        '; footer='+JSON.stringify(metrics.footer)+'; week='+JSON.stringify(metrics.week));
    }
    // A restricted date's All day shortcut means the full permitted portion,
    // not a forbidden 00:00–24:00 window.
    await page.locator('.day-card').nth(0).click();
    await page.locator('[data-action="all-day"]').click();
    assert.match(await page.locator('.range-row').first().innerText(),/18:00/);
    assert.match(await page.locator('.range-row').first().innerText(),/24:00/);
    console.log('All day respects moderator-defined daily limits.');

    // A submitted week remains authoritative even when a revision has been
    // autosaved. Abandoning the revision restores it on the backend.
    assert.equal(await page.locator('[data-action="exit-revision"]').count(),1);
    assert.match(await page.locator('[data-action="exit-revision"]').innerText(),/Discard changes/);
    await page.screenshot({path:path.join(process.cwd(),'preview-screens','revision-discard-footer-compact.png')});
    await page.locator('[data-action="exit-revision"]').click();
    await page.getByRole('dialog',{name:'Discard unsubmitted changes?'}).waitFor();
    await page.locator('.dialog [data-action="dismiss"]').last().click();
    assert.equal(await page.locator('.day-card').count(),7,
      'Cancelling the discard confirmation keeps editing open');
    await page.locator('[data-action="exit-revision"]').click();
    await page.locator('.dialog [data-action="confirm-popup"]').click();
    await page.getByRole('heading',{name:'Your week is submitted'}).waitFor();
    assert.deepEqual(state.member.draft,originalSubmission,
      'Discarding restores the last real submission, despite autosaved drafts');
    assert.deepEqual(state.member.submitted,originalSubmission);
    assert.equal(state.template.Wednesday.status,'available',
      'Discarding an event revision does not alter the usual-week template');
    await page.locator('[data-action="back"]').click();
    assert.match(await page.locator('[data-action="exit-revision"]').innerText(),/Back to submission/);
    await page.locator('[data-action="exit-revision"]').click();
    assert.equal(await page.locator('.dialog').count(),0,
      'No confirmation is necessary when there are no pending edits');
    await page.getByRole('heading',{name:'Your week is submitted'}).waitFor();
    console.log('Cancel and discard safely return from editing to the previous submission.');
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log('Responsive Activity stays inside a 460px Discord frame at both widths.');
    assert.ok(saves>=1,'draft edits must reach the server; coalescing should reduce round trips');
    await context.close();

    const outside=await browser.newPage();
    await outside.goto(base+'/activity/',{waitUntil:'networkidle'});
    await outside.getByText('Open inside Discord').waitFor();
    await outside.close();
    console.log('Non-Discord direct browser login is blocked by design.');
  }finally{
    await browser.close();
    await app.stop();
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
run().catch(e=>{console.error(e);process.exitCode=1;});
