'use strict';
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const path=require('path'),fs=require('fs');
const PORT=4961,BASE='http://localhost:'+PORT,DB=path.join(__dirname,'data','sfd.json');
try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{if(c){pass++;console.log('  PASS  '+n)}else{fail++;console.log('  FAIL  '+n+(x?' -> '+x:''))}};
async function token(e){const r=await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})});return (await r.json()).token}
async function open(browser,page,key,tok,geo){const ctx=await browser.newContext({viewport:{width:390,height:720},...(geo?{geolocation:geo,permissions:['geolocation']}:{})});const p=await ctx.newPage();await p.goto(BASE+'/'+page);await p.evaluate(([k,t])=> { localStorage.setItem(k,t); localStorage.setItem('mc:nogate','1'); },[key,tok]);await p.goto(BASE+'/'+page);return {ctx,p}}
(async()=>{
 const srv=spawn('node',['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'sfd',DISABLE_OSRM:'1'},stdio:['ignore','ignore','inherit']});
 let b;
 try{
  for(let i=0;i<60;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
  b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
  const recTok=await token('reception@demo.ng'),cashTok=await token('cashier@demo.ng'),docTok=await token('tunde@demo.ng');

  // Receptionist: clock-in gate -> clock in on-site -> app with role tabs
  const rec=await open(b,'frontdesk.html','mcfd:token',recTok,{latitude:6.4991,longitude:3.3541});
  await rec.p.waitForTimeout(1000);
  ok('front desk shows the clock-in gate first', /clock in/i.test(await rec.p.evaluate(()=>document.body.innerText)));
  await rec.p.evaluate(()=>doClockIn()); await rec.p.waitForTimeout(1200);
  const recTabs=await rec.p.evaluate(()=>Array.from(document.querySelectorAll('.tab span')).map(s=>s.textContent));
  ok('after clock-in the app loads with tabs', recTabs.length>=3, JSON.stringify(recTabs));
  ok('receptionist SEES Reception tab', recTabs.includes('Reception'));
  ok('receptionist does NOT see Cashier tab', !recTabs.includes('Cashier'), JSON.stringify(recTabs));
  ok('on-site badge shows in header', /on-site/i.test(await rec.p.evaluate(()=>document.getElementById('header').innerText)));

  // Cashier: different role -> Cashier tab present, no Reception check-in duties beyond read
  const cash=await open(b,'frontdesk.html','mcfd:token',cashTok,{latitude:6.499,longitude:3.354});
  await cash.p.waitForTimeout(900); await cash.p.evaluate(()=>doClockIn()); await cash.p.waitForTimeout(1100);
  const cashTabs=await cash.p.evaluate(()=>Array.from(document.querySelectorAll('.tab span')).map(s=>s.textContent));
  ok('cashier SEES Cashier tab', cashTabs.includes('Cashier'), JSON.stringify(cashTabs));

  // Reception checks a patient in (API) -> Doctor waiting room shows them
  await fetch(BASE+'/api/frontdesk/checkin',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+recTok},body:JSON.stringify({patientId:'p_amaka',complaint:'Fever',priority:'urgent',vitals:{bp:'120/80',temp:'38.4'}})});
  const doc=await open(b,'doctor.html','mcd:token',docTok);
  await doc.p.waitForTimeout(1500);
  const docText=await doc.p.evaluate(()=>document.body.innerText);
  ok('doctor home shows a Waiting room', /waiting room/i.test(docText));
  ok('doctor sees the checked-in patient + start button', /Start consultation/i.test(docText));
  ok('doctor home shows a clock-in control', /clock in|clocked in/i.test(docText));

  console.log('\n========= SMOKE FRONT DESK (UI) =========');
  console.log('PASS '+pass+'   FAIL '+fail);
  console.log('=========================================');
 }catch(e){console.error('ERROR',e);fail++}
 finally{if(b)await b.close();srv.kill();try{fs.unlinkSync(DB)}catch(e){};process.exit(fail?1:0)}
})();
