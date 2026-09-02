const {spawn}=require('child_process');const {chromium}=require('playwright');const fs=require('fs');
const PORT=4928,BASE='http://localhost:'+PORT,DB='/tmp/lb.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function tok(e){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token}
async function C(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))};}
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'lb',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});let b;
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const lab=await tok('lab@demo.ng'); const doc=await tok('tunde@demo.ng');
const cat=(await C(lab,'GET','/api/lab/catalog')).j;
E('lab catalog has tests with reference ranges', cat.length>=8 && cat.some(t=>t.refLow!=null) && cat.some(t=>t.qualitative), 'tests='+cat.length);
// add a test
const add=await C(lab,'POST','/api/lab/catalog',{name:'Potassium',unit:'mmol/L',refLow:3.5,refHigh:5.1,price:2500});
E('add a test to the catalog', add.s===200 && add.j.name==='Potassium' && add.j.refHigh===5.1);
// doctor orders labs, lab posts results -> auto-flagged
const ord=await C(doc,'POST','/api/doc/lab-order',{patientId:'p_amaka',tests:['Haemoglobin','Fasting blood glucose','Malaria RDT']});
const orders=(await C(lab,'GET','/api/lab/orders')).j; const o=(orders.active||[]).find(x=>x.patientId==='p_amaka'&&x.status!=='closed')||(orders.active||[])[0];
await C(lab,'POST','/api/lab/orders/'+o.id+'/collect',{});
const post=await C(lab,'POST','/api/lab/orders/'+o.id+'/result',{results:[{test:'Haemoglobin',value:'8.5'},{test:'Fasting blood glucose',value:'4.8'},{test:'Malaria RDT',value:'Positive'}]});
E('results auto-flag low/normal/abnormal from ranges', (()=>{ const r=post.j.result||[]; const hb=r.find(x=>/Haemo/.test(x.test)); const glu=r.find(x=>/glucose/i.test(x.test)); const mal=r.find(x=>/Malaria/.test(x.test));
  return hb&&hb.flag==='low' && glu&&glu.flag==='normal' && mal&&mal.flag==='abnormal'; })(), JSON.stringify((post.j.result||[]).map(r=>r.test+':'+r.flag)));
// UI check: catalog tab + result entry shows ref + live flag
b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const ctx=await b.newContext({viewport:{width:412,height:915},deviceScaleFactor:2}); const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto(BASE+'/lab.html'); await p.evaluate(([k,v])=>{localStorage.setItem(k,v);localStorage.setItem('mc:nogate','1');},['mclab:token',lab]);
await p.goto(BASE+'/lab.html'); await sleep(1800);
await p.evaluate(()=>switchTab('catalog')); await sleep(900);
const catUI=await p.evaluate(()=>({rows:document.querySelectorAll('#catList .card').length,ref:/ref /.test(document.getElementById('catList').innerText)}));
E('catalog screen lists tests with ranges', catUI.rows>=8 && catUI.ref, JSON.stringify(catUI));
await p.screenshot({path:'/tmp/labcat.png'});
E('no JS errors', errs.length===0, errs[0]);
console.log('\nLAB: '+ok+' passed, '+bad+' failed');
}catch(e){console.error('ERR',e.message,e.stack);bad++}finally{if(b)await b.close();srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}})();
