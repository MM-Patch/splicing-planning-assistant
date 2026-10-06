// Read-only acceptance: real synced boards, actual card clicks, no mocked source records.
import {chromium} from 'playwright';import assert from 'node:assert/strict';import {mkdir,writeFile} from 'node:fs/promises';
const base=process.env.APP_URL||'https://splicing-planning-assistant.onrender.com',threshold=2000,baseline=process.env.BASELINE==='1';
const report={base,at:new Date().toISOString(),thresholdMs:threshold,measurement:'Card click dispatch through editable matching inspector and next two animation frames; source is timestamped full Monday sync, not a per-click Monday fetch.',selections:[],errors:[],failures:[],blockedRequests:[]};
await mkdir('test-results',{recursive:true});let browser;
try{
 report.build=await (await fetch(base+'/api/build')).json();assert.equal(report.build.syncComplete,true,'Live complete sync required');if(process.env.EXPECTED_COMMIT)assert.equal(report.build.commit,process.env.EXPECTED_COMMIT);
 browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const context=await browser.newContext({viewport:{width:1700,height:1100}}),page=await context.newPage();page.setDefaultTimeout(45000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.route('**/api/**',route=>{if(route.request().method()==='GET')return route.continue();report.blockedRequests.push(route.request().url());return route.abort();});
 const opening=Date.now();await page.goto(base,{waitUntil:'domcontentloaded',timeout:90000});await page.waitForFunction(()=>ALL.length>1000&&ALL[0].observationSource==='Monday sync'&&document.querySelector('#inspector[data-loading="false"] #pcNotes:not(:disabled)'),{},{timeout:90000});report.appOpenMs=Date.now()-opening;
 for(const board of ['18391791372','5077578194']){
  const source=await page.evaluate(id=>ALL.find(r=>r.sourceBoardId===id).source,board);await page.locator('#source').selectOption(source);await page.evaluate(()=>run());
  const candidates=await page.evaluate(id=>view.filter(r=>r.sourceBoardId===id).slice(0,5).map(r=>({id:String(r.itemId),name:r.name,board:r.sourceBoardId,observedAt:r.observedAt})),board);
  assert.equal(candidates.length,5);
  for(const r of candidates.slice(0,baseline?1:5)){
   await page.evaluate(id=>{window.selectionMeasurement=new Promise(resolve=>{
    const card=[...document.querySelectorAll('#list .card')].find(el=>el.getAttribute('onclick')?.includes("'"+id+"'"));
    card.addEventListener('click',()=>{const start=performance.now();function check(){const notes=document.querySelector('#inspector[data-loading="false"] #pcNotes:not(:disabled)');if(String(selected?.itemId)===id&&notes){requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({ms:performance.now()-start,blank:!document.querySelector('#inspector h2')?.textContent,editable:true})));}else if(performance.now()-start>45000)resolve({ms:performance.now()-start,editable:false});else requestAnimationFrame(check);}requestAnimationFrame(check);},{once:true,capture:true});
   });},r.id);
   await page.locator('#list .card').filter({has:page.getByRole('heading',{name:r.name,exact:true})}).first().click();
   const timing=await page.evaluate(()=>window.selectionMeasurement);report.selections.push({...r,...timing,pass:timing.ms<threshold&&timing.editable&&!timing.blank});
   await page.locator('#pcNotes').fill('LOCAL acceptance note '+r.id+' — DO NOT SEND');
  }
 }
 if(!baseline){
  const previous=report.selections[0],last=report.selections.at(-1);
  // Reloaded dropdowns must preserve intentionally cleared edits and notes.
  await page.locator('#pcOwner').selectOption('');await page.getByRole('button',{name:'Load dropdowns',exact:true}).click();assert.equal(await page.locator('#pcOwner').inputValue(),'');
  await page.evaluate(id=>selectId(id),previous.id);assert.equal(await page.locator('#pcNotes').inputValue(),'LOCAL acceptance note '+previous.id+' — DO NOT SEND');
  // A delayed older response must not paint the subsequently selected project.
  let release;const delayed=new Promise(r=>release=r);let started;const start=new Promise(r=>started=r);
  await page.route('**/api/item/*',async route=>{started();await delayed;await route.continue();});await page.evaluate(()=>{loadDetails();});await start;
  await page.evaluate(id=>selectId(id),last.id);await page.locator('#pcNotes').fill('LATEST LOCAL NOTES — must not be overwritten');release();await page.waitForTimeout(2000);
  assert.equal(await page.locator('#pcNotes').inputValue(),'LATEST LOCAL NOTES — must not be overwritten');assert.equal(await page.evaluate(()=>String(selected.itemId)),last.id);report.draftIsolation=true;
 }
 await page.screenshot({path:'test-results/'+(baseline?'baseline':'r22')+'-inspector.png',fullPage:true});
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.blockedRequests,[]);assert(report.selections.every(r=>r.pass),'At least one selection missed 2000ms');
}catch(e){report.failures.push(e.message);process.exitCode=1;}finally{await browser?.close();const times=report.selections.map(r=>r.ms);report.maxMs=Math.max(...times);report.meanMs=times.reduce((a,b)=>a+b,0)/times.length;await writeFile('test-results/'+(baseline?'baseline':'r22')+'-inspector.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
