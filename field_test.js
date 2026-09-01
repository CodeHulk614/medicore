const { spawn } = require('child_process');
const fs=require('fs'); try{fs.unlinkSync('./data/db.json');}catch(e){}
require('./seed')(true);
const srv = spawn('node',['server.js'],{env:{...process.env,PORT:'4400'}});
const B='http://localhost:4400', J=r=>r.json();
const login=e=>fetch(B+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})}).then(J).then(x=>x.token);
const get=(p,t)=>fetch(B+p,{headers:t?{Authorization:'Bearer '+t}:{}}).then(J);
const post=(p,b,t)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:JSON.stringify(b||{})}).then(J);
(async()=>{
  for(let i=0;i<40;i++){try{await get('/api/health');break;}catch(e){await new Promise(r=>setTimeout(r,150));}}
  const R=[];
  const pt=await login('amaka@demo.ng'), pharm=await login('pharmacy@demo.ng'),
        rider=await login('rider@demo.ng'), disp=await login('dispatch@demo.ng'), chw=await login('chw@demo.ng');

  // RIDER: pharmacy dispenses -> delivery appears -> rider accepts + advances -> patient tracker hits delivered
  const q=await get('/api/pharm/queue',pharm);
  await post('/api/pharm/dispense/'+q[0].id,{},pharm);
  let jobs=await get('/api/rider/jobs',rider);
  R.push(['rider sees delivery jobs', jobs.length>=1]);
  const job=jobs[0];
  await post('/api/rider/jobs/'+job.id+'/accept',{},rider);
  await post('/api/rider/deliveries/'+job.id+'/advance',{},rider); // ->3
  const done=await post('/api/rider/deliveries/'+job.id+'/advance',{},rider); // ->4
  R.push(['rider advances to delivered', done.stage===4]);
  const bundle=await get('/api/me/bundle',pt);
  R.push(['patient tracker reflects delivered', bundle.deliveries.some(d=>d.id===job.id && d.stage===4)]);

  // EMERGENCY: public report (no login) -> dispatcher assigns nearest -> status lifecycle -> hospital pre-alert
  const rep=await post('/api/emergency',{kind:'Road accident',area:'Surulere',name:'Bystander',phone:'08030000000'});
  R.push(['public emergency report works', !!rep.case && rep.nearbyHospitals.length>0]);
  const cases=await get('/api/dispatch/cases',disp);
  R.push(['dispatcher sees the case', cases.some(c=>c.kind==='Road accident')]);
  const cid=cases.find(c=>c.kind==='Road accident').id;
  const asg=await post('/api/dispatch/cases/'+cid+'/assign',{},disp);
  R.push(['assign picks nearest responder + pre-alerts hospital', asg.status==='dispatched' && !!asg.responder && asg.alerted && !!asg.hospital]);
  const resp=await get('/api/dispatch/responders',disp);
  R.push(['assigned responder marked busy', resp.find(r=>r.id===asg.responderId).available===false]);
  const st=await post('/api/dispatch/cases/'+cid+'/status',{status:'en_route'},disp);
  R.push(['case status advances', st.status==='en_route']);
  const cl=await post('/api/dispatch/cases/'+cid+'/status',{status:'closed'},disp);
  const resp2=await get('/api/dispatch/responders',disp);
  R.push(['closing frees the responder', resp2.find(r=>r.id===asg.responderId).available===true]);

  // CHW: roster preloaded -> register a client -> log a visit with danger sign -> referral raised
  let roster=await get('/api/chw/roster',chw);
  R.push(['CHW roster preloaded', roster.length>=2]);
  const reg=await post('/api/chw/register',{first:'Amina',last:'Sule',area:'Makoko',sex:'female'},chw);
  roster=await get('/api/chw/roster',chw);
  R.push(['CHW registers a new client', roster.some(p=>p.id===reg.id)]);
  const v=await post('/api/chw/visit',{patientId:reg.id,note:'Antenatal danger sign: high BP',danger:true},chw);
  R.push(['CHW visit logs + raises referral', v.ok && v.referred]);
  // the referral should show up on the payer/record side as a pending authorization
  const recVisit = (await get('/api/chw/roster',chw)).find(p=>p.id===reg.id).nextVisit;
  R.push(['client next-visit updated after visit', recVisit==='Follow-up scheduled']);

  console.log('\nFIELD / EMERGENCY / LOGISTICS LOOPS:');
  R.forEach(([n,ok])=>console.log('  '+(ok?'PASS':'FAIL')+'  '+n));
  console.log('\n'+(R.every(r=>r[1])?'ALL PASS':'SOME FAILED'));
  srv.kill(); process.exit(0);
})().catch(e=>{console.error(e); srv.kill(); process.exit(1);});
