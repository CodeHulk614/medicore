const { chromium } = require('playwright'); const { spawn } = require('child_process'); const path=require('path'),fs=require('fs');
const PORT=4973,BASE='http://localhost:'+PORT,DB=path.join(__dirname,'data','ap.json');try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let pass=0,fail=0;const ok=(n,c,x)=>{if(c){pass++;console.log('  PASS  '+n)}else{fail++;console.log('  FAIL  '+n+(x?' -> '+x:''))}};
async function tok(e){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token}
async function tabs(b,tokn){const ctx=await b.newContext({viewport:{width:390,height:720}});const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));await p.goto(BASE+'/admin.html');await p.evaluate(([k,t])=> { localStorage.setItem(k,t); localStorage.setItem('mc:nogate','1'); },['mcadmin:token',tokn]);await p.goto(BASE+'/admin.html');await p.waitForTimeout(1500);const t=await p.evaluate(()=>Array.from(document.querySelectorAll('.tab span,.tabbar-inner .tab')).map(s=>s.textContent).filter(Boolean));const body=await p.evaluate(()=>document.body.innerText);await ctx.close();return {t,errs,body}}
(async()=>{const srv=spawn('node',['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'ap',DISABLE_OSRM:'1'},stdio:['ignore','ignore','inherit']});let b;
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const admin=await tabs(b,await tok('admin@demo.ng'));
ok('hospital admin sees Verify + Payouts', admin.t.includes('Verify')&&admin.t.includes('Payouts'), JSON.stringify(admin.t));
ok('hospital admin sees the live ops dashboard', /Seen today|Staff on duty|With a doctor/i.test(admin.body));
ok('admin app: no JS errors', admin.errs.length===0, admin.errs[0]);
const mgr=await tabs(b,await tok('frontdesk@demo.ng'));
ok('manager sees Overview', mgr.t.includes('Overview'), JSON.stringify(mgr.t));
ok('manager does NOT see Payouts (no settlements perm)', !mgr.t.includes('Payouts'), JSON.stringify(mgr.t));
ok('manager does NOT see Verify (no doctors/facilities perm)', !mgr.t.includes('Verify'), JSON.stringify(mgr.t));
ok('manager admin app: no JS errors', mgr.errs.length===0, mgr.errs[0]);
console.log('\nPASS '+pass+'   FAIL '+fail);
}catch(e){console.error(e);fail++}finally{if(b)await b.close();srv.kill();try{fs.unlinkSync(DB)}catch(e){};process.exit(fail?1:0)}})();
