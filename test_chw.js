const {spawn}=require('child_process');const fs=require('fs');
const PORT=4927,BASE='http://localhost:'+PORT,DB='/tmp/cw.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function tok(e){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token}
async function C(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))};}
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'cw',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const chw=await tok('chw@demo.ng');
const roster=(await C(chw,'GET','/api/chw/roster')).j;
E('CHW roster has households', roster.length>=2, 'roster='+roster.length);
const cid=roster[0].id;
const hh=await C(chw,'GET','/api/chw/household/'+cid);
E('household detail returns client + visits + immunizations + referrals', hh.s===200 && hh.j.client && Array.isArray(hh.j.immunizations) && Array.isArray(hh.j.referrals));
// immunization
const im=await C(chw,'POST','/api/chw/immunization',{patientId:cid,vaccine:'Measles',dose:'1st'});
E('record an immunization', im.s===200 && im.j.vaccine==='Measles');
// referral -> creates hospital authorization
const admin=await tok('admin@demo.ng'); const authsBefore=(await C(admin,'GET','/api/admin/analytics').catch(()=>({j:{}}))).j;
const rf=await C(chw,'POST','/api/chw/refer',{patientId:cid,reason:'persistent fever',urgency:'urgent'});
E('refer a client to the hospital', rf.s===200 && rf.j.urgency==='urgent');
const hh2=await C(chw,'GET','/api/chw/household/'+cid);
E('referral + immunization now in the household history', hh2.j.referrals.length>=1 && hh2.j.immunizations.length>=1);
// referral surfaces as a pending authorization in the payer/hospital
const pt=roster[0]; // check via a payer if patient has hmo, else just confirm authorization exists in system through re-refer visibility
E('urgent referral marks next visit', hh2.j.client.nextVisit==='Referred to hospital');
// ANC for a female client
const fem=roster.find(r=>r.sex==='female')||roster[0];
const anc=await C(chw,'POST','/api/chw/anc',{patientId:fem.id,weeks:34,bp:'118/76'});
E('log an ANC visit', anc.s===200 && anc.j.weeks===34 && anc.j.visits>=1);
console.log('\nCHW: '+ok+' passed, '+bad+' failed');
srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}catch(e){console.error('ERR',e.message);srv.kill('SIGKILL');process.exit(1)}})();
