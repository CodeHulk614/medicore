const { chromium } = require('playwright'); const { spawn } = require('child_process'); const path=require('path'),fs=require('fs');
const PORT=4977,BASE='http://localhost:'+PORT,DB=path.join(__dirname,'data','sp.json');try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let pass=0,fail=0;const ok=(n,c,x)=>{if(c){pass++;console.log('  PASS  '+n)}else{fail++;console.log('  FAIL  '+n+(x?' -> '+x:''))}};
async function tok(e){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token}
async function load(b,t){const ctx=await b.newContext({viewport:{width:390,height:780}});const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));await p.goto(BASE+'/');await p.evaluate(([k,v])=>localStorage.setItem(k,v),['mc:token',t]);await p.goto(BASE+'/');await p.waitForTimeout(1400);const body=await p.evaluate(()=>document.body.innerText);const hasGlance=await p.evaluate(()=>!!document.getElementById('glanceCard'));await ctx.close();return {body,errs,hasGlance}}
(async()=>{const srv=spawn('node',['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'sp',DISABLE_OSRM:'1'},stdio:['ignore','ignore','inherit']});let b;
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const am=await load(b,await tok('amaka@demo.ng'));
ok('amaka: home renders the glance card', am.hasGlance);
ok('amaka: glance shows the three sections', /at a glance/i.test(am.body)&&/Upcoming visit/i.test(am.body)&&/Active orders/i.test(am.body)&&/Cover/i.test(am.body));
ok('amaka: cover reflects her HMO', /Avon HMO/i.test(am.body));
ok('amaka: no JS errors', am.errs.length===0, am.errs[0]);
// blessing has NO appointments (would previously crash on appt.time)
const bl=await load(b,await tok('blessing@demo.ng'));
ok('blessing (no appointments): home still renders', bl.hasGlance&&bl.body.length>60);
ok('blessing: glance shows "None booked" upcoming', /None booked|tap to book/i.test(bl.body), bl.body.slice(0,200));
ok('blessing: self-pay cover shown', /Self-pay/i.test(bl.body));
ok('blessing: NO crash / no JS errors', bl.errs.length===0, bl.errs[0]);
console.log('\nPASS '+pass+'   FAIL '+fail);
}catch(e){console.error(e);fail++}finally{if(b)await b.close();srv.kill();try{fs.unlinkSync(DB)}catch(e){};process.exit(fail?1:0)}})();
