const {spawn}=require('child_process');const path=require('path'),fs=require('fs');
const PORT=4988,BASE='http://localhost:'+PORT,DB=path.join(__dirname,'data','ro.json');try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;
const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
(async()=>{const srv=spawn('node',['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'r',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});
try{for(let i=0;i<40;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const login=async e=>(await(await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token;
const call=async(t,m,u,b)=>{const r=await fetch(BASE+u,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))}};
const admin=await login('admin@demo.ng');
// find a Grandville staff member to schedule (pharmacy@)
const staff=await call(admin,'GET','/api/admin/staff'); const target=(staff.j||[]).find(s=>/pharmacy@/.test(s.email))||staff.j[0];
const today=new Date().toISOString().slice(0,10);
// assign a shift starting a bit ago so clock-in is "late", and store timestamps
const past=new Date(Date.now()-45*60000);const startHHMM=String(past.getHours()).padStart(2,'0')+':'+String(past.getMinutes()).padStart(2,'0');
const asg=await call(admin,'POST','/api/admin/roster',{staffId:target.id,date:today,start:startHHMM,end:'17:00',duty:'Dispensary'});
E('admin can assign a roster shift',asg.s===200&&asg.j.staffId===target.id,JSON.stringify(asg.j).slice(0,80));
const ros=await call(admin,'GET','/api/admin/roster'); E('roster lists the assigned shift',ros.j.some(s=>s.staffId===target.id));
// staff clocks in -> timestamps + punctuality vs roster
const ph=await login('pharmacy@demo.ng');
const ci=await call(ph,'POST','/api/shift/clockin',{lat:6.4991,lng:3.3541});
E('clock-in stores a clockIn timestamp',!!ci.j.shift&&typeof ci.j.shift.clockIn==='number');
E('clock-in computes punctuality vs roster (late)',ci.j.shift.punctuality==='late',JSON.stringify({p:ci.j.shift.punctuality,late:ci.j.shift.lateMinutes}));
E('staff sees their schedule',(await call(ph,'GET','/api/shift/schedule')).j.some(s=>s.date===today));
const me=await call(ph,'GET','/api/shift/me'); E('shift/me returns todaySchedule',!!me.j.todaySchedule&&me.j.todaySchedule.duty==='Dispensary');
// clock out stores clockOut timestamp
const co=await call(ph,'POST','/api/shift/clockout'); E('clock-out stores a clockOut timestamp',!!co.j.shift&&typeof co.j.shift.clockOut==='number');
// attendance register shows them with punctuality
const att=await call(admin,'GET','/api/admin/attendance'); E('attendance shows the staff + punctuality summary',att.j.rows.some(r=>/late/.test(r.punctuality||''))&&att.j.summary.late>=1,JSON.stringify(att.j.summary));
console.log('\nROSTER/ATTENDANCE: '+ok+' passed, '+bad+' failed');
}catch(e){console.error('ERR',e.message);bad++}finally{srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}})();
