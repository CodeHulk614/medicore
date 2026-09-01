// Server-side clock enforcement (runs the server with ENFORCE_CLOCKIN=1).
const { spawn } = require('child_process'); const fs=require('fs');
const PORT=4966,BASE='http://localhost:'+PORT,DB='/tmp/enf.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function login(e){const r=await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})});return (await r.json()).token;}
async function call(tok,method,path,body){const r=await fetch(BASE+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+tok},body:body?JSON.stringify(body):undefined});return {status:r.status,j:await r.json().catch(()=>({}))};}
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'e',DISABLE_OSRM:'1',ENFORCE_CLOCKIN:'1'},stdio:['ignore','ignore','ignore']});
try{for(let i=0;i<40;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const health=await (await fetch(BASE+'/api/health')).json();
E('health reports enforceClockIn on', health.enforceClockIn===true, JSON.stringify(health.build));
const pharm=await login('pharmacy@demo.ng');
// a pharmacy write BEFORE clocking in -> blocked 423
const q=await call(pharm,'GET','/api/pharm/queue');
const anyOrder=(q.j&&(q.j.orders||q.j)||[])[0];
const before=await call(pharm,'POST','/api/pharm/price-suggest',{items:[{name:'Test',qty:1}]});
E('pharmacy write is blocked (423) before clock-in', before.status===423, before.status+' '+JSON.stringify(before.j).slice(0,60));
// GET still allowed
E('pharmacy read is still allowed before clock-in', q.status===200, q.status);
// clock in, then the same write is allowed
const ci=await call(pharm,'POST','/api/shift/clockin',{});
E('clock-in succeeds', ci.status===200, ci.status);
const after=await call(pharm,'POST','/api/pharm/price-suggest',{items:[{name:'Test',qty:1}]});
E('pharmacy write is allowed after clock-in', after.status!==423, after.status);
// a non-clock role (patient) is never blocked by this guard
const pat=await login('amaka@demo.ng');
const pb=await call(pat,'GET','/api/me/bundle');
E('patient endpoints unaffected by enforcement', pb.status===200, pb.status);
console.log('\nCLOCK ENFORCEMENT: '+ok+' passed, '+bad+' failed');
}catch(e){console.error('ERR',e.message);bad++}finally{srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}})();
