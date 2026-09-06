const {spawn}=require('child_process');const fs=require('fs');
const PORT=4921,BASE='http://localhost:'+PORT,DB='/tmp/sc.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function tok(e){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token}
async function C(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))};}
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'sc',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const pat=await tok('amaka@demo.ng'); const disp=await tok('dispatch@demo.ng');
// order from Magboro (current location), address supplied
const sos=await C(pat,'POST','/api/patient/sos',{kind:'Chest pain',lat:6.7218,lng:3.4560,address:'Magboro, Obafemi Owode, Ogun, Nigeria'});
E('SOS accepted', sos.s===200 && sos.j.case, JSON.stringify(sos.j).slice(0,50));
E('case area is the pickup (Magboro), not home (Surulere)', sos.j.case.area==='Magboro', 'area='+sos.j.case.area);
E('case carries the full pickup address', /Magboro/.test(sos.j.case.address||''), sos.j.case.address);
E('case coordinates are the pickup', Math.abs(sos.j.case.lat-6.7218)<0.01, sos.j.case.lat);
// dispatch sees it with Magboro
const cases=(await C(disp,'GET','/api/dispatch/cases')).j || (await C(disp,'GET','/api/dispatch/board')).j;
const arr=Array.isArray(cases)?cases:(cases.cases||[]);
const mine=arr.find(c=>c.id===sos.j.case.id);
E('dispatch board shows the case at Magboro', mine && mine.area==='Magboro', mine?('area='+mine.area):'not found');
// control: ordering with no location falls back to home (Surulere)
const sos2=await C(pat,'POST','/api/patient/sos',{kind:'Medical emergency'});
E('no-location order still falls back to home area', sos2.j.case.area && sos2.j.case.area!=='Magboro', 'area='+(sos2.j.case&&sos2.j.case.area));
console.log('\nSOS LOCATION: '+ok+' passed, '+bad+' failed');
srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}catch(e){console.error('ERR',e.message);srv.kill('SIGKILL');process.exit(1)}})();
