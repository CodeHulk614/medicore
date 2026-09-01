const { chromium } = require('playwright'); const { spawn } = require('child_process'); const path=require('path'),fs=require('fs');
const PORT=4945,BASE='http://localhost:'+PORT,DB=path.join(__dirname,'data','dbg2.json');
try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{ const srv=spawn('node',['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'d',DISABLE_OSRM:'1'},stdio:['ignore','ignore','inherit']});
 let b; try{ for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
 const tok=(await(await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@demo.ng',password:'demo1234'})})).json()).token;
 b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
 const ctx=await b.newContext({viewport:{width:390,height:720}}); const p=await ctx.newPage();
 p.on('response',r=>{ if(r.status()>=400) console.log('HTTP',r.status(),r.url()); });
 p.on('pageerror',e=>console.log('PAGEERR:',e.message));
 await p.goto(BASE+'/admin.html'); await p.evaluate(([k,t])=>localStorage.setItem(k,t),['mcadmin:token',tok]); await p.goto(BASE+'/admin.html'); await p.waitForTimeout(1800);
 const html=await p.evaluate(()=>({viewHTML:(document.getElementById('view')||{}).innerHTML||'(no #view)', ovType:typeof window.DATA, ov:window.DATA?JSON.stringify(window.DATA.ov):'n/a'}));
 console.log('viewHTML len:', html.viewHTML.length, '| DATA.ov:', html.ov);
 await ctx.close();
 }catch(e){console.error(e)} finally{ if(b)await b.close(); srv.kill(); try{fs.unlinkSync(DB)}catch(e){} }
})();
