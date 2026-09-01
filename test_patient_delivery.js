const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs=require('fs');
const PORT=4957,BASE='http://localhost:'+PORT,DB='/tmp/pd.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function tok(e){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token}
async function call(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))}}
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'pd',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});let b;
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const doc=await tok('tunde@demo.ng'),ph=await tok('pharmacy@demo.ng'),pt=await tok('amaka@demo.ng');
const rx=(await call(doc,'POST','/api/doc/orders',{type:'rx',patientId:'p_amaka',drug:'Amlodipine 5mg',sig:'1 daily'})).j;
await call(ph,'POST','/api/pharm/orders/'+rx.id+'/price',{items:[{name:'Amlodipine 5mg',qty:30,price:4000}]});
await call(pt,'POST','/api/patient/rx/'+rx.id+'/pay',{fulfilment:'deliver',address:'15 Adeniran Ogunsanya St, Surulere'});
const dv=await call(pt,'GET','/api/patient/delivery');
E('patient has an active delivery endpoint', dv.j.active===true&&!!dv.j.rider, JSON.stringify({a:dv.j.active,s:dv.j.status}));
b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const ctx=await b.newContext({viewport:{width:411,height:900},deviceScaleFactor:2}); const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto(BASE+'/'); await p.evaluate(([k,v])=>{localStorage.setItem(k,v);localStorage.setItem('mc:nogate','1');},['mc:token',pt]);
await p.goto(BASE+'/'); await sleep(5000);
const ui=await p.evaluate(()=>{ const banner=document.getElementById('delivBanner'); const mini=document.getElementById('delivMiniMap'); return { bannerText:(banner&&banner.textContent||'').trim().slice(0,60), hasMini:!!document.getElementById('delivMiniInner'), miniH:(document.getElementById('delivMiniInner')||{}).offsetHeight||0, miniHasMap:!!(mini&&(mini.querySelector('svg')||mini.querySelector('.leaflet-container'))) }; });
E('home shows a live "medication on the way" banner', /medication/i.test(ui.bannerText), ui.bannerText);
E('home shows a delivery mini-map', ui.hasMini && ui.miniH>100, JSON.stringify(ui));
E('mini-map renders content', ui.miniHasMap, JSON.stringify(ui));
// tapping the banner opens the full track screen
await p.evaluate(()=>{ const bl=document.querySelector('#delivBanner button'); if(bl)bl.click(); }); await sleep(4000);
const full=await p.evaluate(()=>({ onTrack: !!document.getElementById('rxTrackMap'), h:(document.getElementById('rxTrackMap')||{}).offsetHeight||0 }));
E('tapping opens the full delivery map', full.onTrack&&full.h>150, JSON.stringify(full));
E('no JS errors', errs.length===0, errs[0]);
await p.goBack&&0; await p.evaluate(()=>{ if(window.switchTab)switchTab('home'); }); await sleep(1500);
await p.screenshot({path:'/tmp/patdel.png',fullPage:true});
console.log('\nPATIENT LIVE DELIVERY: '+ok+' passed, '+bad+' failed');
}catch(e){console.error('ERR',e.message);bad++}finally{if(b)await b.close();srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}})();
