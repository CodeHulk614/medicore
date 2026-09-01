const {spawn}=require('child_process');const fs=require('fs');
const PORT=4940,BASE='http://localhost:'+PORT,DB='/tmp/sub.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function tok(e,p){const r=await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:p||'demo1234'})});return {s:r.status,j:await r.json().catch(()=>({}))};}
async function call(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'Content-Type':'application/json',Authorization:t?('Bearer '+t):undefined},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))};}
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'sub',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
// public tiers
const tiers=await call(null,'GET','/api/tiers'); E('public tiers list', tiers.s===200 && tiers.j.length===4 && tiers.j[0].apps.length>0, JSON.stringify(tiers.j.map(t=>t.key)));
// public hospital registration (self-service)
const reg=await call(null,'POST','/api/hospitals/register',{hospitalName:'Sunrise Clinic',area:'Yaba',adminName:'Dr Ada',adminEmail:'sunrise@demo.ng',adminPassword:'sunrise1',tier:'clinic'});
E('a hospital can self-register on a plan', reg.s===200 && reg.j.hospital.tier==='Clinic', JSON.stringify(reg.j).slice(0,80));
E('the new hospital admin can log in', (await tok('sunrise@demo.ng','sunrise1')).s===200);
// the clinic tier disabled ambulance -> new hospital modules reflect it
const super_=(await tok('super@demo.ng')).j.token;
const hs=await call(super_,'GET','/api/super/hospitals'); const sun=hs.j.find(h=>h.name==='Sunrise Clinic');
E('registered on Clinic tier -> ambulance module OFF', sun && sun.modules.ambulance===false && sun.modules.lab===true, JSON.stringify(sun&&sun.modules));
E('super sees subscription tier on each hospital', hs.j.every(h=>h.subscription&&h.subscription.tier), JSON.stringify(hs.j.map(h=>h.subscription&&h.subscription.tier)));
// HQ upgrades Sunrise to Hospital tier -> ambulance turns ON
await call(super_,'POST','/api/super/hospitals/'+sun.id+'/tier',{tier:'hospital'});
const hs2=await call(super_,'GET','/api/super/hospitals'); const sun2=hs2.j.find(h=>h.id===sun.id);
E('HQ upgrade to Hospital tier turns ambulance ON', sun2.modules.ambulance===true && sun2.subscription.tier==='hospital');
// admin of Sunrise can read their plan
const sunAdmin=(await tok('sunrise@demo.ng','sunrise1')).j.token; const mh=await call(sunAdmin,'GET','/api/me/hospital');
E('a hospital user can read its own plan/modules', mh.s===200 && mh.j.modules.ambulance===true && mh.j.subscription.tier==='hospital');
// HQ suspends Sunrise -> its users cannot log in (but super can)
await call(super_,'POST','/api/super/hospitals/'+sun.id+'/status',{status:'suspended'});
E('suspending a hospital blocks its users at login', (await tok('sunrise@demo.ng','sunrise1')).s===403);
E('MediCore HQ (superadmin) still logs in fine', (await tok('super@demo.ng')).s===200);
console.log('\nSUBSCRIPTION LAYER: '+ok+' passed, '+bad+' failed');
srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}catch(e){console.error('ERR',e.message);srv.kill('SIGKILL');process.exit(1)}})();
