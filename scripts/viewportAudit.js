'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createScheduler } = require('../src/scheduling/server');
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-viewport-audit-'));
const port = 11993, url = 'http://127.0.0.1:'+port;
const s = createScheduler({mode:'demo',host:'127.0.0.1',port,dataFile:path.join(dir,'state.json')});
const widths=[320,360,375,390,430,600,768,780,781,800,1024,1280,1440,1600,1920];
const metrics=async(page)=>page.evaluate(()=>{
 const doc=document.documentElement, b=document.body;
 const nav=document.querySelector('.mobile-header'), top=document.querySelector('.topline'), card=document.querySelector('.card');
 const shown=e=>e&&getComputedStyle(e).display!=='none';
 const overflowing=[...document.querySelectorAll('body *')].filter(e=>{
  const r=e.getBoundingClientRect();
  return shown(e)&&r.width>0&&r.right>window.innerWidth+3 && r.left<window.innerWidth && !e.closest('.day-strip') && !e.closest('.side') && !e.closest('.day-strip');
 }).slice(0,10).map(e=>({tag:e.tagName,cls:(e.className||'').toString().slice(0,70),width:Math.round(e.getBoundingClientRect().width),right:Math.round(e.getBoundingClientRect().right)}));
 return { viewport:window.innerWidth, docW:doc.scrollWidth, bodyW:b.scrollWidth, overflow:doc.scrollWidth-window.innerWidth, navW:nav&&Math.round(nav.getBoundingClientRect().width), heading:document.querySelector('h1')?.textContent, badElements:overflowing };
});
(async()=>{
 await s.start();
 const browser = await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,args:['--no-sandbox','--disable-gpu']});
 try {
  let failures=0;
  const res=await fetch(url+'/api/rounds',{headers:{'X-Demo-User':'owner'}});const id=(await res.json()).rounds[0].id;
  const states=['collecting','review','voting','final'];
  for(const phase of states){
   if(phase==='review'){
    await fetch(url+'/api/rounds/'+id+'/close-collection',{method:'POST',headers:{'X-Demo-User':'owner','Content-Type':'application/json'},body:'{}'});
   } else if(phase==='voting'){
    const r=await (await fetch(url+'/api/rounds/'+id,{headers:{'X-Demo-User':'owner'}})).json();
    const selected=r.round.candidates.slice(0,2).map(c=>({candidateId:c.id,startAt:c.slots[0].startAt}));
    await fetch(url+'/api/rounds/'+id+'/start-vote',{method:'POST',headers:{'X-Demo-User':'owner','Content-Type':'application/json'},body:JSON.stringify({selected})});
   } else if(phase==='final'){
    await fetch(url+'/api/rounds/'+id+'/close-vote',{method:'POST',headers:{'X-Demo-User':'owner','Content-Type':'application/json'},body:'{}'});
   }
   console.log('\nPHASE',phase);
   for(const width of widths){
    const ctx=await browser.newContext({viewport:{width,height:width<=430?680:width<=800?840:900},isMobile:width<=780,deviceScaleFactor:width<=780?2:1});
    const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(url+'/?round='+id,{waitUntil:'networkidle'});
    if(phase==='collecting'){
      await page.locator('#persona-inline').selectOption('p1');
    } else {
      await page.locator('#persona-inline').selectOption(phase==='voting'?'p1':'owner');
      if(phase!=='voting'){
       const side=page.locator('#nav-organizer');
       if(await side.isVisible()) await side.click(); else await page.locator('#mobile-nav').selectOption('organizer');
      }
    }
    await page.locator('h1').first().waitFor();
    const m=await metrics(page); const text=phase+' '+String(width).padStart(4)+'px viewport '+m.viewport+' overflow '+m.overflow+'px';
    if(m.overflow>1||errors.length){failures++;console.log('FAIL',text,JSON.stringify({errors,bad:m.badElements}));}
    else console.log('PASS',text);
    if((width===320||width===768)&&phase==='collecting'){
      fs.mkdirSync(path.join(process.cwd(),'preview-screens'),{recursive:true});
      await page.screenshot({path:path.join(process.cwd(),'preview-screens', 'viewport-'+width+'.png'),fullPage:true});
      await page.evaluate(()=>{document.body.style.zoom='1.25'});
      const zoom=await metrics(page);console.log('ZOOM',width,'overflow',zoom.overflow,'bad',JSON.stringify(zoom.badElements));
    }
    await ctx.close();
   }
  }
  console.log('TOTAL FAILURES',failures);process.exitCode=failures?1:0;
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await s.stop();fs.rmSync(dir,{recursive:true,force:true})});
