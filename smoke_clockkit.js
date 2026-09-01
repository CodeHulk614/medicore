'use strict';
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const path=require('path'),fs=require('fs');
const PORT=4963,BASE='http://localhost:'+PORT,DB=path.join(__dirname,'data','ck.json');
try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{if(c){pass++;console.log('  PASS  '+n)}else{fail++;console.log('  FAIL  '+n+(x?' -> '+x:''))}};
async function token(e){const r=await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})});return (await r.json()).token}
async function open(browser,page,key,tok,geo){const ctx=await browser.newContext({viewport:{width:390,height:720},geolocation:geo,permissions:['geolocation']});const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));await p.goto(BASE+'/'+page);await p.evaluate(([k,t])=> { localStorage.setItem(k,t); localStorage.setItem('mc:nogate','1'); },[key,tok]);await p.goto(BASE+'/'+page);return {ctx,p,errs}}
(async()=>{
 const srv=spawn('node',['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'ck',DISABLE_OSRM:'1'},stdio:['ignore','ignore','inherit']});
 let b;
 try{
  for(let i=0;i<60;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
  b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
  const pharmTok=await token('pharmacy@demo.ng'),adminTok=await token('admin@demo.ng');

  // Pharmacy: widget shows "Clock in", clocking in on-site flips it, no shift.view section
  const ph=await open(b,'pharmacy.html','mcpharm:token',pharmTok,{latitude:6.4991,longitude:3.3541});
  await ph.p.waitForTimeout(1400);
  ok('pharmacy: widget mounts with Clock in state', /clock in/i.test(await ph.p.evaluate(()=>document.getElementById('mc-ck-chip').innerText)));
  await ph.p.evaluate(()=>__mcck.in()); await ph.p.waitForTimeout(1200);
  const chipTxt=await ph.p.evaluate(()=>document.getElementById('mc-ck-chip').innerText);
  ok('pharmacy: after clock-in chip shows On + time', /On/.test(chipTxt), chipTxt);
  // server recorded an on-site shift for the pharmacy user
  const meShift=await (await fetch(BASE+'/api/shift/me',{headers:{Authorization:'Bearer '+pharmTok}})).json();
  ok('pharmacy: server has an OPEN on-site shift', meShift.open && meShift.open.onSite===true, JSON.stringify(meShift.open));
  await ph.p.evaluate(()=>__mcck.chipClick?0:document.getElementById('mc-ck-chip').click()); await ph.p.waitForTimeout(400);
  ok('pharmacy: profile sheet opens', await ph.p.evaluate(()=>document.getElementById('mc-ck-sheet').classList.contains('on')));
  ok('pharmacy: NO on-duty section (no shift.view)', !(await ph.p.evaluate(()=>!!document.getElementById('mc-ck-onduty'))));
  ok('pharmacy: no JS errors from the widget', ph.errs.length===0, ph.errs[0]);

  // Admin: has shift.view -> on-duty section appears
  const ad=await open(b,'admin.html','mcadmin:token',adminTok,{latitude:6.499,longitude:3.354});
  await ad.p.waitForTimeout(1400);
  await ad.p.evaluate(()=>__mcck.in()); await ad.p.waitForTimeout(1000);
  await ad.p.evaluate(()=>document.getElementById('mc-ck-chip').click()); await ad.p.waitForTimeout(500);
  ok('admin: profile sheet shows On duty section (shift.view)', await ad.p.evaluate(()=>!!document.getElementById('mc-ck-onduty')));
  ok('admin: accent swatches present (customization)', (await ad.p.evaluate(()=>document.querySelectorAll('#mc-ck-sheet .sw').length))>=4);

  console.log('\n========= SMOKE CLOCKKIT (UI) =========');
  console.log('PASS '+pass+'   FAIL '+fail);
  console.log('=======================================');
 }catch(e){console.error('ERROR',e);fail++}
 finally{if(b)await b.close();srv.kill();try{fs.unlinkSync(DB)}catch(e){};process.exit(fail?1:0)}
})();
