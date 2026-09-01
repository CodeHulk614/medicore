const {spawn}=require('child_process');const path=require('path'),fs=require('fs');
const PORT=4989,BASE='http://localhost:'+PORT,DB=path.join(__dirname,'data','ac.json');try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;
const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
(async()=>{const srv=spawn('node',['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'a',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});
try{for(let i=0;i<40;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const login=async e=>(await(await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token;
const call=async(t,m,u,b)=>{const r=await fetch(BASE+u,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))}};
const amaka=await login('amaka@demo.ng'), disp=await login('dispatch@demo.ng'), crew=await login('crew@demo.ng');
// patient raises SOS at their hospital
const sos=await call(amaka,'POST','/api/patient/sos',{hospitalId:'h_grand'}); E('patient SOS creates a case',[200,201].includes(sos.s),JSON.stringify(sos.j).slice(0,80));
// crew clocks into a unit first
const cme0=await call(crew,'GET','/api/crew/me'); const unit=(cme0.j.fleet||[])[0];
await call(crew,'POST','/api/crew/pick',{responderId:unit.id});
// dispatch assigns the case to the nearest available unit (the crew's)
const board=await call(disp,'GET','/api/dispatch/board'); const cse=(board.j.cases||[])[0];
await call(disp,'POST','/api/dispatch/cases/'+cse.id+'/assign',{responderId:unit.id});
await sleep(300);
let cme=await call(crew,'GET','/api/crew/me');
E('crew has an assigned case',!!cme.j.case, JSON.stringify(cme.j).slice(0,80));
// crew sends a message to the patient
const cs=await call(crew,'POST','/api/crew/chat',{text:'We are 5 minutes away, stay calm.'});
E('crew can message the patient',cs.s===200&&cs.j.chat.some(m=>m.from==='crew'));
// patient sees it on the tracker and replies
const trk=await call(amaka,'GET','/api/patient/track');
E('patient sees the crew message on the tracker',(trk.j.chat||[]).some(m=>m.from==='crew'&&/5 minutes/.test(m.text)),JSON.stringify(trk.j.chat||[]).slice(0,100));
const pr=await call(amaka,'POST','/api/patient/track/chat',{text:'Okay, the gate is open.'});
E('patient can reply to the ambulance',pr.s===200&&pr.j.chat.some(m=>m.from==='patient'));
// crew sees the reply
const cme2=await call(crew,'GET','/api/crew/me');
E('crew sees the patient reply',(cme2.j.chat||[]).some(m=>m.from==='patient'&&/gate is open/.test(m.text)));
console.log('\nAMBULANCE CHAT: '+ok+' passed, '+bad+' failed');
}catch(e){console.error('ERR',e.message);bad++}finally{srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}})();
