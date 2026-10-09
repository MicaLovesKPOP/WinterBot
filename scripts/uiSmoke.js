'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright-core');
const { createScheduler } = require('../src/scheduling/server');

const EDGE = process.env.WINTERBOT_BROWSER ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'winterbot-ui-test-'));
const PORT = 11989;
const base = 'http://127.0.0.1:' + PORT;
const scheduler = createScheduler({
  mode: 'demo', host: '127.0.0.1', port: PORT,
  dataFile: path.join(DIR, 'demo.json'),
});

function info(label) { console.log('✓ ' + label); }

async function run() {
  await scheduler.start();
  const browser = await chromium.launch({
    headless: true, executablePath: EDGE,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    page.on('dialog', d => d.accept());
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.locator('h1').first().waitFor({ timeout: 12000 });
    assert.equal(await page.locator('h1').first().innerText(), 'Your availability');
    info('Organizer and participant interface loads');

    await page.locator('#persona-inline').selectOption('p1');
    await page.locator('[data-action="choose-day"]').last().click();
    await page.locator('[data-action="day-status"][data-status="available"]').click();
    await page.locator('[data-action="add-window"]').click();
    await page.locator('#cap-1').selectOption('120');
    const saveState = await page.locator('#cap-1').inputValue();
    assert.equal(saveState, '120');
    info('Participant updates availability, adds multiple windows and sets max duration');

    const editingCtx = await browser.newContext({viewport:{width:390,height:890},isMobile:true});
    const editingPage = await editingCtx.newPage();
    editingPage.on('pageerror', error => pageErrors.push(error.message));
    await editingPage.goto(base,{waitUntil:'networkidle'});
    await editingPage.locator('#persona-inline').selectOption('p1');
    await editingPage.locator('[data-action="choose-day"]').last().click();
    await editingPage.locator('#cap-1').waitFor();
    fs.mkdirSync(path.join(process.cwd(), 'preview-screens'), {recursive:true});
    await editingPage.screenshot({path:path.join(process.cwd(),'preview-screens','mobile-availability.png'),fullPage:true});
    await editingCtx.close();

    await page.locator('#persona-inline').selectOption('owner');
    await page.locator('#nav-organizer').click();
    await page.locator('[data-action="close-collection"]').click();
    await page.getByText('Best suggested times').waitFor();
    const original = await page.locator('.candidate').count();
    assert.ok(original >= 3, 'expected at least three optimized candidate groups, got ' + original);
    info('Organizer closes collection and sees ranked candidate groups (' + original + ')');

    await page.locator('[data-candidate]').nth(0).check();
    await page.locator('[data-candidate]').nth(1).check();
    await page.locator('[data-action="start-vote"]').click();
    await page.getByText('Community voting').waitFor();
    info('Organizer starts approval vote on a subset');

    await page.locator('#persona-inline').selectOption('p1');
    await page.locator('[data-vote]').first().check();
    await page.locator('[data-action="save-vote"]').click();
    await page.locator('#persona-inline').selectOption('p2');
    await page.locator('[data-vote]').first().check();
    await page.locator('[data-action="save-vote"]').click();
    info('Participants submit votes');

    await page.locator('#persona-inline').selectOption('owner');
    await page.locator('#nav-organizer').click();
    await page.locator('[data-action="close-vote"]').click();
    await page.getByText('Ready to schedule', { exact: true }).first().waitFor();
    const remaining = await page.locator('.candidate').count();
    assert.equal(remaining, original - 1, 'only the losing voted option should disappear');
    info('Voting excludes only losing voted choices; unvoted candidates remain');

    await page.locator('[data-candidate]').first().check();
    await page.locator('[data-action="publish"]').click();
    await page.getByText('Published events').waitFor();
    assert.equal(await page.locator('.timeline-row').filter({ hasText: 'created' }).count() >= 1, true);
    info('Final selection publishes a safe simulated Discord event');

    const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 890 }, isMobile: true });
    const mobile = await mobileCtx.newPage();
    mobile.on('pageerror', error => pageErrors.push(error.message));
    await mobile.goto(base, { waitUntil: 'networkidle' });
    await mobile.locator('h1').first().waitFor({timeout:12000});
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, 'mobile layout overflows horizontally by ' + overflow + 'px');
    fs.mkdirSync(path.join(process.cwd(), 'preview-screens'), {recursive:true});
    await mobile.screenshot({path:path.join(process.cwd(), 'preview-screens', 'mobile.png'),fullPage:true});
    await page.screenshot({path:path.join(process.cwd(), 'preview-screens', 'desktop.png'),fullPage:true});
    assert.deepEqual(pageErrors, [], 'no browser JavaScript errors');
    info('Mobile layout works without horizontal overflow; screenshots saved');

    await page.locator('[data-action="reset-demo"]').first().click();
    await page.getByText('Availability collection').first().waitFor();
    const resetResponse = await page.request.get(base + '/api/rounds', {headers:{'X-Demo-User':'owner'}});
    const resetData = await resetResponse.json();
    assert.equal(resetData.rounds.length, 1);
    assert.equal(resetData.rounds[0].phase,'collecting');
    info('Organizer can restart the demo with fresh sample data');

    const smallCtx=await browser.newContext({viewport:{width:320,height:720},isMobile:true});
    const smallPage=await smallCtx.newPage();
    smallPage.on('pageerror',error=>pageErrors.push(error.message));
    await smallPage.goto(base,{waitUntil:'networkidle'});
    await smallPage.locator('#mobile-nav').selectOption('new');
    await smallPage.locator('[data-planning-date]').first().waitFor();
    const setupOverflow=await smallPage.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
    assert.ok(setupOverflow<=1,'320px mobile setup wizard must not overflow: '+setupOverflow);
    await smallPage.screenshot({path:path.join(process.cwd(),'preview-screens','mobile-setup.png'),fullPage:true});
    await smallCtx.close();
    info('320px mobile setup wizard has no page-wide horizontal overflow');

    await page.locator('#nav-new').click();
    await page.locator('#title').fill('Voice chat event');
    await page.locator('#voiceChannelId').fill('123456789012345678');
    const dateRows=page.locator('[data-planning-date]');
    assert.equal(await dateRows.count(),3,'three default setup dates should appear');
    const firstDate=await dateRows.first().getAttribute('data-planning-date');
    const secondDate=await dateRows.nth(1).getAttribute('data-planning-date');
    await dateRows.nth(1).locator('[data-include-date]').uncheck();
    await dateRows.first().locator('[data-limit-date]').check();
    await dateRows.first().locator('[data-limited-start]').selectOption('19:00');
    await dateRows.first().locator('[data-limited-end]').selectOption('23:00');
    await page.locator('#minDurationMinutes').fill('90');
    await page.locator('#maxDurationMinutes').fill('150');
    await page.locator('#destination').selectOption('public');
    assert.equal(await page.locator('#create-round').evaluate(f => f.checkValidity()), true);
    await page.locator('#create-round [type=submit]').click();
    await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Organizer board', null, { timeout: 15000 });
    const allRounds=await (await page.request.get(base+'/api/rounds',
      {headers:{'X-Demo-User':'owner'}})).json();
    const newId=allRounds.rounds.find(r=>r.title==='Voice chat event')?.id;
    assert.ok(newId,'new round should be created');
    const createdRound=await (await page.request.get(base+'/api/rounds/'+newId,
      {headers:{'X-Demo-User':'owner'}})).json();
    assert.equal(createdRound.round.voiceChannelId,'123456789012345678');
    assert.equal(createdRound.round.destination,'public');
    assert.equal(createdRound.round.minDurationMinutes,90);
    assert.equal(createdRound.round.maxDurationMinutes,150);
    assert.ok(createdRound.round.selectedDates.includes(firstDate));
    assert.ok(!createdRound.round.selectedDates.includes(secondDate));
    assert.deepEqual(createdRound.round.dayLimits[firstDate],{start:'19:00',end:'23:00'});
    info('Organizer setup saves individual dates, restricted hours, duration range, destination and voice channel');
  } finally {
    await browser.close();
  }
}

run().catch(error => {console.error(error);process.exitCode=1;}).finally(async () => {
  await scheduler.stop();
  fs.rmSync(DIR, {recursive:true,force:true});
});
