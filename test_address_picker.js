const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs=require('fs');
const PORT=4955,BASE='http://localhost:'+PORT,DB='/tmp/ad.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function tok(e){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token}
async function call(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))}}
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'ad',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});let b;
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const doc=await tok('tunde@demo.ng'),ph=await tok('pharmacy@demo.ng'),pt=await tok('amaka@demo.ng');
const rx=(await call(doc,'POST','/api/doc/orders',{type:'rx',patientId:'p_amaka',drug:'Amlodipine 5mg',sig:'1 daily'})).j;
await call(ph,'POST','/api/pharm/orders/'+rx.id+'/price',{items:[{name:'Amlodipine 5mg',qty:30,price:4000}]});
b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const ctx=await b.newContext({viewport:{width:411,height:900},deviceScaleFactor:2,geolocation:{latitude:6.605,longitude:3.349},permissions:['geolocation']}); const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto(BASE+'/'); await p.evaluate(([k,v])=>{localStorage.setItem(k,v);localStorage.setItem('mc:nogate','1');},['mc:token',pt]);
await p.goto(BASE+'/'); await sleep(1500);
// open the address screen directly
await p.evaluate((id)=>{ payRx(id,'deliver'); }, rx.id); await sleep(4000);
const ui=await p.evaluate(()=>({ hasSearch:!!document.getElementById('dlvSearch'), hasCurrentBtn:[...document.querySelectorAll('button')].some(b=>/current location/i.test(b.textContent)), hasMap:!!document.getElementById('dlvMap'), mapH:(document.getElementById('dlvMap')||{}).offsetHeight||0, hasField:!!document.getElementById('dlvAddrText') }));
E('address screen has a search box', ui.hasSearch);
E('address screen has a "use current location" button', ui.hasCurrentBtn);
E('address screen has an interactive map', ui.hasMap && ui.mapH>100, JSON.stringify(ui));
E('address screen has an address field', ui.hasField);
// simulate the patient picking a point on the map (Lekki), distinct from home (Surulere)
await p.evaluate(()=>{ DADDR.lat=6.4400; DADDR.lng=3.4700; DADDR.text='Pick on map, Lekki'; const t=document.getElementById('dlvAddrText'); if(t)t.value='Pick on map, Lekki'; });
// confirm & pay
await p.evaluate((id)=>{ confirmAddr(id); }, rx.id); await sleep(2500);
const dv=await call(pt,'GET','/api/patient/delivery');
E('delivery uses the PICKED coordinates (not home)', dv.j.active && dv.j.dropoff && Math.abs(dv.j.dropoff.lat-6.44)<0.01 && Math.abs(dv.j.dropoff.lng-3.47)<0.01, JSON.stringify(dv.j.dropoff));
E('delivery address text is the picked address', dv.j.dropoff && /Lekki/.test(dv.j.dropoff.address||''), JSON.stringify(dv.j.dropoff&&dv.j.dropoff.address));
E('no JS errors', errs.length===0, errs.slice(0,2).join(' | '));
await p.evaluate((id)=>{ /* re-open to screenshot */ if(!document.getElementById('dlvMap')) payRx(id,'deliver'); }, rx.id);
console.log('\nADDRESS PICKER: '+ok+' passed, '+bad+' failed');
}catch(e){console.error('ERR',e.message);bad++}finally{if(b)await b.close();srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}})();
