const { spawn } = require('child_process');
const fs=require('fs'); try{fs.unlinkSync('./data/db.json');}catch(e){}
require('./seed')(true);
const srv = spawn('node',['server.js'],{env:{...process.env,PORT:'4200'}});
const B='http://localhost:4200';
const J=r=>r.json();
const login=(e)=>fetch(B+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})}).then(J).then(x=>x.token);
const get=(p,t)=>fetch(B+p,{headers:t?{Authorization:'Bearer '+t}:{}}).then(J);
const post=(p,b,t)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:JSON.stringify(b||{})}).then(J);
(async()=>{
  for(let i=0;i<40;i++){try{await get('/api/health');break;}catch(e){await new Promise(r=>setTimeout(r,150));}}
  const R=[];
  const admin=await login('admin@demo.ng'), payer=await login('payer@demo.ng'),
        pharm=await login('pharmacy@demo.ng'), lab=await login('lab@demo.ng'),
        pt=await login('amaka@demo.ng'), doc=await login('tunde@demo.ng');

  // ADMIN: verify a pending doctor -> appears in marketplace
  let mkBefore=(await get('/api/doctors',pt)).length;
  const ov=await get('/api/admin/overview',admin);
  R.push(['admin sees pending doctors', ov.doctors.pending===2]);
  await post('/api/admin/doctors/doc_okon/verify',{approve:true},admin);
  let mkAfter=(await get('/api/doctors',pt)).length;
  R.push(['verifying a doctor adds them to marketplace', mkAfter===mkBefore+1]);

  // DOCTOR orders a lab test -> LAB sees it -> posts result -> PATIENT sees it in results
  await post('/api/doc/lab-order',{patientId:'p_amaka',tests:['Renal function']},doc);
  const labOrders=await get('/api/lab/orders',lab);
  R.push(['lab receives doctor order', labOrders.some(o=>o.tests.includes('Renal function'))]);
  const target=labOrders.find(o=>o.tests.includes('Renal function'));
  await post('/api/lab/orders/'+target.id+'/collect',{},lab);
  await post('/api/lab/orders/'+target.id+'/result',{results:[{test:'Creatinine',value:'0.9',unit:'mg/dL',flag:'normal',low:0.6,high:1.3,cl:0.2,ch:3}]},lab);
  const bundle=await get('/api/me/bundle',pt);
  R.push(['patient sees lab result in record', bundle.results.some(r=>r.test==='Creatinine')]);
  R.push(['lab result raised a claim', bundle.claims.some(c=>/Laboratory/.test(c.what))]);

  // DOCTOR prescribes -> PHARMACY queue -> dispense -> delivery + claim + stock down
  await post('/api/doc/prescribe',{patientId:'p_amaka',drug:'Metformin 500mg',sig:'1 twice daily'},doc);
  const q=await get('/api/pharm/queue',pharm);
  R.push(['pharmacy sees new prescription', q.some(x=>x.drug==='Metformin 500mg')]);
  const invBefore=(await get('/api/pharm/inventory',pharm)).find(i=>i.name==='Metformin 500mg').stock;
  const rxTarget=q.find(x=>x.drug==='Metformin 500mg');
  await post('/api/pharm/dispense/'+rxTarget.id,{},pharm);
  const invAfter=(await get('/api/pharm/inventory',pharm)).find(i=>i.name==='Metformin 500mg').stock;
  R.push(['dispensing decrements stock', invAfter===invBefore-1]);
  const bundle2=await get('/api/me/bundle',pt);
  R.push(['dispense creates a delivery for patient', bundle2.deliveries.some(d=>/Metformin/.test(d.drug))]);

  // PAYER: patient requests auth -> payer approves; payer adjudicates a claim
  await post('/api/authorizations',{what:'MRI scan',where:'Riverside Medical Centre'},pt);
  const auths=await get('/api/payer/authorizations',payer);
  R.push(['payer sees patient auth request', auths.some(a=>a.what==='MRI scan' && a.status==='Pending')]);
  const auth=auths.find(a=>a.what==='MRI scan');
  const decided=await post('/api/payer/authorizations/'+auth.id+'/decide',{approve:true},payer);
  R.push(['payer approves authorization', decided.status==='Approved']);
  const claims=await get('/api/payer/claims',payer);
  const claim=claims.find(c=>/Laboratory/.test(c.what));
  const adj=await post('/api/payer/claims/'+claim.id+'/adjudicate',{approve:true},payer);
  R.push(['payer adjudicates a claim', adj.status==='Paid']);

  // ADMIN settlements after a completed visit
  await post('/api/marketplace/book',{doctorId:'doc_ada',type:'video',time:'11:30'},pt);
  const ada=await login('ada@demo.ng');
  const sched=await get('/api/doc/schedule',ada);
  await post('/api/doc/appointments/'+sched[sched.length-1].id+'/complete',{},ada);
  const settle=await get('/api/admin/settlements',admin);
  R.push(['admin sees a payout due', settle.some(s=>s.doctorId==='doc_ada' && s.due>0)]);
  const payRes=await post('/api/admin/settlements/pay',{doctorId:'doc_ada'},admin);
  R.push(['admin pays out settlement', payRes.paid>0]);

  console.log('\nCROSS-APP LOOPS:');
  R.forEach(([n,ok])=>console.log('  '+(ok?'PASS':'FAIL')+'  '+n));
  console.log('\n'+(R.every(r=>r[1])?'ALL PASS':'SOME FAILED'));
  srv.kill(); process.exit(0);
})().catch(e=>{console.error(e); srv.kill(); process.exit(1);});
