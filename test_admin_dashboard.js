const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs=require('fs');
const PORT=4951,BASE='http://localhost:'+PORT,DB='/tmp/dh.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function tok(e){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token}
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'dh',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});let b;
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const ctx=await b.newContext({viewport:{width:411,height:1000},deviceScaleFactor:2}); const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const t=await tok('admin@demo.ng');
await p.goto(BASE+'/admin.html'); await p.evaluate(([k,v])=>{localStorage.setItem(k,v);localStorage.setItem('mc:nogate','1');},['mcadmin:token',t]);
await p.goto(BASE+'/admin.html'); await sleep(2500);
const ui=await p.evaluate(()=>{ const svgs=document.querySelectorAll('#view svg').length; const kpis=document.querySelectorAll('#view .stat').length; const hasLeaderboard=[...document.querySelectorAll('#view .section-h h2')].some(h=>/leaderboard/i.test(h.textContent)); const hasTrend=[...document.querySelectorAll('#view .section-h h2')].some(h=>/7-day/i.test(h.textContent)); return { svgs, kpis, hasLeaderboard, hasTrend, txt:(document.querySelector('#view .hello')||{}).textContent }; });
E('dashboard renders KPI figures', ui.kpis>=9, 'kpis='+ui.kpis);
E('dashboard renders charts (SVG)', ui.svgs>=4, 'svgs='+ui.svgs);
E('has 7-day trend', ui.hasTrend);
E('has doctor leaderboard', ui.hasLeaderboard);
E('scoped to the hospital', /Grandville/.test(ui.txt||''), ui.txt);
E('no JS errors', errs.length===0, errs[0]);
await p.screenshot({path:'/tmp/dash.png',fullPage:true});
console.log('\nADMIN DASHBOARD: '+ok+' passed, '+bad+' failed');
}catch(e){console.error('ERR',e.message);bad++}finally{if(b)await b.close();srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}})();
