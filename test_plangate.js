const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs=require('fs');
const PORT=4938,BASE='http://localhost:'+PORT,DB='/tmp/pl.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function tok(e){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token}
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'pl',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});let b;
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const gate=async(app,key,email)=>{ const ctx=await b.newContext(); const p=await ctx.newPage(); const t=await tok(email);
  await p.goto(BASE+'/'+app); await p.evaluate(([k,v])=>localStorage.setItem(k,v),[key,t]); await p.goto(BASE+'/'+app); await sleep(2500);
  const gated=await p.evaluate(()=>{const g=document.getElementById('mcPlanGate');return !!g&&getComputedStyle(g).display!=='none';}); await ctx.close(); return gated; };
// river dispatch (ambulance off on clinic tier) -> gated
E('Riverside dispatch is gated (ambulance not in Clinic plan)', await gate('dispatch.html','mcdispatch:token','dispatch2@demo.ng'));
// grand dispatch (ambulance on, hospital tier) -> NOT gated
E('Grandville dispatch is NOT gated (ambulance included)', !(await gate('dispatch.html','mcdispatch:token','dispatch@demo.ng')));
// grand lab (lab on) -> not gated
E('Grandville lab is NOT gated', !(await gate('lab.html','mclab:token','lab@demo.ng')));
console.log('\nPLAN GATE: '+ok+' passed, '+bad+' failed');
}catch(e){console.error('ERR',e.message);bad++}finally{if(b)await b.close();srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}})();
