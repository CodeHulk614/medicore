const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs=require('fs');
const PORT=4939,BASE='http://localhost:'+PORT,DB='/tmp/hq.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'hq',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});let b;
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
// ---- register page ----
let ctx=await b.newContext({viewport:{width:1000,height:1200},deviceScaleFactor:1}); let p=await ctx.newPage(); const e1=[]; p.on('pageerror',e=>e1.push(e.message));
await p.goto(BASE+'/register.html'); await sleep(1000);
const tiers=await p.evaluate(()=>document.querySelectorAll('.tier').length);
E('register page shows subscription tiers', tiers===4, 'tiers='+tiers);
await p.evaluate(()=>{ document.getElementById('hn').value='Hilltop Clinic'; document.getElementById('area').value='Ikeja'; document.getElementById('an').value='Dr Bello'; document.getElementById('ae').value='hilltop@demo.ng'; document.getElementById('ap').value='hill123'; });
await p.evaluate(()=>pick('clinic'));
await p.evaluate(()=>register()); await sleep(1200);
const done=await p.evaluate(()=>/live on the Clinic plan/.test(document.getElementById('done').innerText));
E('a hospital can register from the public page', done);
await p.screenshot({path:'/tmp/register.png'}); await ctx.close();
// ---- HQ app ----
ctx=await b.newContext({viewport:{width:900,height:1300},deviceScaleFactor:1}); p=await ctx.newPage(); const e2=[]; p.on('pageerror',e=>e2.push(e.message));
await p.goto(BASE+'/superadmin.html'); await sleep(800);
await p.evaluate(()=>{ document.getElementById('email').value='super@demo.ng'; document.getElementById('pass').value='demo1234'; });
await p.evaluate(()=>doLogin()); await sleep(1500);
const hosp=await p.evaluate(()=>document.querySelectorAll('#hospitals .card').length);
E('HQ lists all hospitals (incl. the new one)', hosp>=3, 'hospitals='+hosp);
const kpis=await p.evaluate(()=>document.querySelectorAll('#kpis .kpi').length);
E('HQ shows platform KPIs (incl. MRR)', kpis>=5);
// toggle a module off then on, change a tier
await p.evaluate(()=>{ const m=document.querySelector('#hospitals .mod.on'); if(m)m.click(); }); await sleep(700);
E('module toggle works (no JS errors)', e2.length===0, e2[0]);
await p.screenshot({path:'/tmp/hq.png',fullPage:true}); await ctx.close();
console.log('\nHQ + REGISTER: '+ok+' passed, '+bad+' failed');
}catch(e){console.error('ERR',e.message);bad++}finally{if(b)await b.close();srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}})();
