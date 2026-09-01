const { chromium } = require('playwright'); const { spawn } = require('child_process'); const path=require('path'),fs=require('fs');
const PORT=4939,BASE='http://localhost:'+PORT,DB=path.join(__dirname,'data','dbg.json');
try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{ const srv=spawn('node',['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'d',DISABLE_OSRM:'1'},stdio:['ignore','ignore','inherit']});
 let b; try{ for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
 const tok=(await(await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@demo.ng',password:'demo1234'})})).json()).token;
 b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
 const ctx=await b.newContext({viewport:{width:390,height:720}}); const p=await ctx.newPage();
 const errs=[]; p.on('pageerror',e=>errs.push('PAGEERR: '+e.message)); p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE: '+m.text());});
 await p.goto(BASE+'/admin.html'); await p.evaluate(([k,t])=>localStorage.setItem(k,t),['mcadmin:token',tok]); await p.goto(BASE+'/admin.html'); await p.waitForTimeout(1600);
 const info=await p.evaluate(()=>({ lockDisp:getComputedStyle(document.getElementById('lock')).display, appVis:document.getElementById('app')?getComputedStyle(document.getElementById('app')).visibility:'no-app', viewLen:(document.getElementById('view')||{}).innerHTML?.length||0, bodyText:(document.body.innerText||'').slice(0,120) }));
 console.log('ERRORS:',errs.length?errs.join(' | '):'none'); console.log(JSON.stringify(info,null,0));
 await ctx.close();
 }catch(e){console.error(e)} finally{ if(b)await b.close(); srv.kill(); try{fs.unlinkSync(DB)}catch(e){} }
})();
