const {spawn}=require('child_process');const path=require('path'),fs=require('fs');
const PORT=4984,BASE='http://localhost:'+PORT,DB=path.join(__dirname,'data','pz.json');try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;
const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
(async()=>{const srv=spawn('node',['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'z',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});
try{for(let i=0;i<40;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const login=async e=>(await(await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token;
const call=async(t,m,u,b)=>{const r=await fetch(BASE+u,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))}};
const amaka=await login('amaka@demo.ng'), tunde=await login('tunde@demo.ng');
const dm=await call(tunde,'GET','/api/doc/me'); E('doctor sees separate in-person & video fees',dm.j.fees&&dm.j.fees.feeInPerson===5000&&dm.j.fees.feeVideo===4000,JSON.stringify(dm.j.fees));
const setf=await call(tunde,'POST','/api/doc/fees',{feeInPerson:6000,feeVideo:4500}); E('doctor can update fees',setf.s===200&&setf.j.fees.feeVideo===4500);
E('rejects invalid fee',(await call(tunde,'POST','/api/doc/fees',{feeInPerson:-5,feeVideo:10})).s===400);
const docs=await call(amaka,'GET','/api/doctors'); const t=(docs.j||[]).find(d=>/Tunde/.test(d.name));
E('patient listing shows both fees',t&&t.feeInPerson===6000&&t.feeVideo===4500,JSON.stringify(t&&{ip:t.feeInPerson,v:t.feeVideo}));
const bk=await call(amaka,'POST','/api/marketplace/book',{doctorId:'doc_tunde',type:'video',day:'Tomorrow',time:'10:00'});
E('video booking records the VIDEO fee',bk.j.fee===4500,JSON.stringify({fee:bk.j.fee}));
E('booking sets a scheduledAt timestamp',typeof bk.j.scheduledAt==='number');
const bun=await call(amaka,'GET','/api/me/bundle'); const appts=bun.j.appointments||[];
const future=appts.find(a=>a.type==='video'&&a.scheduledAt>Date.now()+20*60000);
const nowish=appts.find(a=>a.type==='video'&&a.scheduledAt<=Date.now());
E('a future video visit is NOT joinable yet',future&&future.joinable===false,JSON.stringify(future&&{j:future.joinable}));
E('a due video visit IS joinable',nowish&&nowish.joinable===true,JSON.stringify(nowish&&{j:nowish.joinable}));
const early=await call(amaka,'POST','/api/appointments/'+future.id+'/join');
E('join BLOCKED before scheduled time (425)',early.s===425&&/opens at/i.test(early.j.error||''),JSON.stringify({s:early.s}));
const okjoin=await call(amaka,'POST','/api/appointments/'+nowish.id+'/join');
E('join SUCCEEDS at scheduled time + returns a room',okjoin.s===200&&!!okjoin.j.room,JSON.stringify({s:okjoin.s,room:!!okjoin.j.room}));
console.log('\nPRICING/TIME-GATE: '+ok+' passed, '+bad+' failed');
}catch(e){console.error('ERR',e.message);bad++}finally{srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}})();
