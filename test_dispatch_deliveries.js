const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs=require('fs');
const PORT=4958,BASE='http://localhost:'+PORT,DB='/tmp/dd.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function tok(e){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token}
async function call(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))}}
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'dd',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});let b;
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
// create a delivery at Grandville
const doc=await tok('tunde@demo.ng'),ph=await tok('pharmacy@demo.ng'),pt=await tok('amaka@demo.ng');
const rx=(await call(doc,'POST','/api/doc/orders',{type:'rx',patientId:'p_amaka',drug:'Amlodipine 5mg',sig:'1 daily'})).j;
await call(ph,'POST','/api/pharm/orders/'+rx.id+'/price',{items:[{name:'Amlodipine 5mg',qty:30,price:4000}]});
await call(pt,'POST','/api/patient/rx/'+rx.id+'/pay',{fulfilment:'deliver',address:'15 Adeniran Ogunsanya St, Surulere'});
// dispatcher (grand) board shows the delivery + rider
const disp=await tok('dispatch@demo.ng'); const board=await call(disp,'GET','/api/dispatch/board');
const dels=board.j.deliveries||[];
E('dispatch board includes deliveries', dels.length>=1, JSON.stringify(dels.map(d=>d.status)));
E('delivery carries a live rider position', !!(dels[0]&&dels[0].rider&&dels[0].rider.lat!=null), JSON.stringify(dels[0]&&dels[0].rider));
// hospital scoping: Riverside dispatcher should NOT see the Grandville delivery
const disp2=await tok('dispatch2@demo.ng'); const board2=await call(disp2,'GET','/api/dispatch/board');
E('other hospital dispatcher does NOT see it (scoped)', (board2.j.deliveries||[]).length===0, JSON.stringify((board2.j.deliveries||[]).length));
// UI: dispatcher sees deliveries section + a rider marker on the map
b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const ctx=await b.newContext({viewport:{width:411,height:900},deviceScaleFactor:2}); const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto(BASE+'/dispatch.html'); await p.evaluate(([k,v])=>{localStorage.setItem(k,v);localStorage.setItem('mc:nogate','1');},['mcdispatch:token',disp]);
await p.goto(BASE+'/dispatch.html'); await sleep(4500);
const ui=await p.evaluate(()=>{ const sec=[...document.querySelectorAll('.section-h h2')].some(h=>/Medication deliveries/i.test(h.textContent)); const riderMark=!!document.querySelector('#dispMap .leaflet-marker-icon, #dispMap svg text'); const svgHasR=(document.querySelector('#dispMap svg')||{}).textContent||''; return { sec, riderMark, hasRglyph: /R/.test(svgHasR) }; });
E('dispatch board shows a "Medication deliveries" section', ui.sec);
E('dispatch map shows a rider marker', ui.riderMark);
E('no JS errors', errs.length===0, errs[0]);
await p.screenshot({path:'/tmp/dispdel.png',fullPage:true});
console.log('\nDISPATCH OBSERVES RIDERS: '+ok+' passed, '+bad+' failed');
}catch(e){console.error('ERR',e.message);bad++}finally{if(b)await b.close();srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}})();
