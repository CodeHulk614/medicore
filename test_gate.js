const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs=require('fs');
const PORT=4968,BASE='http://localhost:'+PORT,DB='/tmp/gate.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function tok(e){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token}
async function openApp(b,page,key,t,clockIn){ const ctx=await b.newContext({viewport:{width:390,height:760},geolocation:{latitude:6.4991,longitude:3.3541},permissions:['geolocation']}); const p=await ctx.newPage();
  await p.goto(BASE+'/'+page); await p.evaluate(([k,v])=>localStorage.setItem(k,v),[key,t]);
  if(clockIn){ await p.evaluate(async(tok)=>{ await fetch('/api/shift/clockin',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tok},body:'{}'}); },t); }
  await p.goto(BASE+'/'+page); await p.waitForTimeout(1200); return {ctx,p}; }
const gateVisible=p=>p.evaluate(()=>{const g=document.getElementById('mcClockGate');return !!g && getComputedStyle(g).display!=='none';});
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'g',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});let b;
try{for(let i=0;i<40;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
// 1) gated staff, NOT clocked in -> overlay blocks the app
const ph=await openApp(b,'pharmacy.html','mcpharm:token',await tok('pharmacy@demo.ng'),false);
E('pharmacy (clocked out) is blocked by the clock-in gate', await gateVisible(ph.p));
// clicking Clock in unlocks it
await ph.p.click('#mcGateBtn'); await ph.p.waitForTimeout(1500);
E('after clocking in, the gate disappears', !(await gateVisible(ph.p)));
const meOpen=await ph.p.evaluate(async()=>{const t=localStorage.getItem('mcpharm:token');return (await (await fetch('/api/shift/me',{headers:{Authorization:'Bearer '+t}})).json()).open;});
E('server now shows an open shift for the pharmacist', !!meOpen);
await ph.ctx.close();
// 2) gated staff who IS already clocked in -> no gate
const lab=await openApp(b,'lab.html','mclab:token',await tok('lab@demo.ng'),true);
E('lab (already clocked in) is NOT gated', !(await gateVisible(lab.p)));
await lab.ctx.close();
// 3) dispatch is gated too
const dsp=await openApp(b,'dispatch.html','mcdispatch:token',await tok('dispatch@demo.ng'),false);
E('dispatch (clocked out) is blocked by the gate', await gateVisible(dsp.p));
await dsp.ctx.close();
// 4) patient app is NOT a staff app -> never gated
const pat=await openApp(b,'index.html','mc:token',await tok('amaka@demo.ng'),false);
E('patient app is never gated', !(await gateVisible(pat.p)));
await pat.ctx.close();
// 5) admin (oversight) is not gated
const ad=await openApp(b,'admin.html','mcadmin:token',await tok('admin@demo.ng'),false);
E('admin app is not gated (oversight role)', !(await gateVisible(ad.p)));
await ad.ctx.close();
console.log('\nCLOCK GATE: '+ok+' passed, '+bad+' failed');
}catch(e){console.error('ERR',e.message);bad++}finally{if(b)await b.close();srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}})();
