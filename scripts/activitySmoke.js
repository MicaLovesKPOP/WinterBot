'use strict';

// Real browser render and interaction coverage with a mocked Discord SDK and
// API. The mock never grants backend access; Activity OAuth is separately
// exercised in authenticated HTTP tests.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright-core');
const {createScheduler}=require('../src/scheduling/server');
const {createActivityTest}=require('../src/scheduling/activityTest');

const EDGE=process.env.WINTERBOT_BROWSER ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-activity-browser-'));
const port=12421,base='http://127.0.0.1:'+port;
const id='112233445566778899';
const fakeClient={
  guilds:{async fetch(){throw Error('No live Discord in UI smoke test');}},
};
const activity=createActivityTest({
  client:fakeClient,clientId:id,clientSecret:'not-real',
  sessionSecret:'this-is-only-a-local-activity-test-secret-1234',
  dataFile:path.join(dir,'activity.json'),
});
const app=createScheduler({
  mode:'demo',host:'127.0.0.1',port,activityTest:activity,
  dataFile:path.join(dir,'demo.json'),
});
const dates=['2026-10-17','2026-10-18','2026-10-19'];
let round={
  id:'browser-activity-test',title:'WinterBot Activity Test Night',
  timezone:'Europe/Amsterdam',phase:'collecting',
  dates, dayLimits:{
    [dates[0]]:{start:'17:30',end:'24:00'},
    [dates[1]]:{start:'10:00',end:'24:00'},
    [dates[2]]:{start:'14:00',end:'22:00'},
  },
  minDurationMinutes:60,maxDurationMinutes:180,
  availability:{},ballot:null,
};
const savedVotes=[];
function json(data,status=200) {
  return {status,contentType:'application/json',body:JSON.stringify(data)};
}
async function run(){
  await app.start();
  const browser=await chromium.launch({
    headless:true,executablePath:EDGE,
    args:['--no-sandbox','--disable-gpu'],
  });
  try{
    const context=await browser.newContext({viewport:{width:900,height:950}});
    await context.addInitScript(()=>{
      window.__WINTERBOT_ACTIVITY_SDK_FACTORY__=()=>({
        ready:async()=>{},
        commands:{
          authorize:async()=>({code:'test-code'}),
          authenticate:async()=>({id:'user-from-discord'}),
        },
      });
    });
    const page=await context.newPage();
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/activity/api/**',async route=>{
      const request=route.request();
      const pathName=new URL(request.url()).pathname;
      const req=request.postDataJSON?.()||{};
      if(pathName.endsWith('/config'))return route.fulfill(json({clientId:id}));
      if(pathName.endsWith('/token'))return route.fulfill(json({access_token:'mock-token'}));
      if(pathName.endsWith('/state'))return route.fulfill(json({
        user:{id:'p1',name:'Test Participant'},round,
      }));
      if(pathName.endsWith('/availability')){
        for(const day of req.days||[]){
          if(day.status==='unanswered')delete round.availability[day.date];
          else round.availability[day.date]={
            status:day.status, windows:day.windows||[],
            ...(day.maxMinutes==null?{}:{maxMinutes:day.maxMinutes}),
          };
        }
        return route.fulfill(json({round}));
      }
      if(pathName.endsWith('/vote')){
        savedVotes.splice(0,savedVotes.length,...req.candidateIds);
        round.ballot.votes=[...savedVotes];
        return route.fulfill(json({round}));
      }
      return route.fulfill(json({error:'Unrecognized browser test API'},404));
    });
    await page.goto(base+'/activity/',{waitUntil:'networkidle'});
    await page.getByText('WinterBot Activity Test Night').waitFor();
    assert.equal(await page.locator('.day').count(),3);
    assert.equal(await page.locator('[data-action="status"]').count(),3);

    await page.locator('[data-action="status"][data-status="available"]').click();
    await page.locator('#start-0').waitFor();
    const values=await page.locator('#start-0 option').evaluateAll(options=>options.map(x=>x.value));
    assert.equal(values[0],'17:30');
    assert.ok(!values.includes('16:00'));
    await page.locator('#end-0').selectOption('19:00');
    await page.waitForFunction(()=>document.querySelector('#end-0')?.value==='19:00');
    await page.locator('#cap-0').selectOption('60');
    await page.waitForFunction(()=>document.querySelector('#cap-0')?.value==='60');
    await page.locator('[data-action="add"]').click();
    await page.locator('#start-1').waitFor();
    await page.locator('#day-cap').selectOption('120');
    await page.waitForFunction(()=>document.querySelector('#day-cap')?.value==='120');
    assert.equal(round.availability[dates[0]].maxMinutes,120);
    assert.equal(round.availability[dates[0]].windows.length,2);
    assert.equal(round.availability[dates[0]].windows[0].maxMinutes,60);
    await page.reload({waitUntil:'networkidle'});
    assert.equal(await page.locator('#day-cap').inputValue(),'120');
    assert.equal(await page.locator('#start-1').inputValue(),'19:00');
    console.log('Activity availability saves multiple bounded windows and daily cap');

    await page.locator('[data-action="day"]').nth(1).click();
    await page.locator('[data-action="status"][data-status="unavailable"]').click();
    await page.getByText('2 of 3 dates answered').waitFor();
    assert.equal(round.availability[dates[1]].status,'unavailable');
    console.log('Activity individual dates and progress update correctly');

    for(const width of [375,320]){
      await page.setViewportSize({width,height:780});
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
      assert.ok(overflow<=1,'Activity must not overflow at '+width+'px, got '+overflow);
    }
    await page.locator('[data-action="day"]').first().click();
    fs.mkdirSync(path.join(process.cwd(),'preview-screens'),{recursive:true});
    await page.screenshot({
      path:path.join(process.cwd(),'preview-screens','embedded-activity-mobile.png'),
      fullPage:true,
    });
    assert.equal(errors.length,0,JSON.stringify(errors));
    console.log('Activity renders inside a compact Discord-sized mobile viewport');

    round.phase='voting';
    round.ballot={closesAt:new Date(Date.now()+3600000).toISOString(),votes:[],
      options:[
        {id:'candidate-a',date:dates[0],time:'18:00',durationMinutes:120},
        {id:'candidate-b',date:dates[1],time:'20:00',durationMinutes:90},
      ],
    };
    await page.reload({waitUntil:'networkidle'});
    await page.getByText('Vote on the suggested times').waitFor();
    await page.locator('[data-vote="candidate-b"]').check();
    await page.locator('[data-action="save-vote"]').click();
    await page.getByText('Your vote has been saved').waitFor();
    assert.deepEqual(savedVotes,['candidate-b']);
    console.log('Activity voting uses the same embedded UI');
    await context.close();

    // A normal browser never substitutes for a Discord Activity.
    const normal=await browser.newPage();
    await normal.goto(base+'/activity/',{waitUntil:'networkidle'});
    await normal.getByText('Open inside Discord').waitFor();
    await normal.close();
    console.log('Direct browsers receive a clear Discord-only instruction');
  }finally{
    await browser.close();
    await app.stop();
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
run().catch(err=>{console.error(err);process.exitCode=1;});
