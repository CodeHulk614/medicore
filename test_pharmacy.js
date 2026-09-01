const {spawn}=require('child_process');const path=require('path'),fs=require('fs');
const PORT=4982,BASE='http://localhost:'+PORT,DB=path.join(__dirname,'data','ph.json');try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;
const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
(async()=>{const srv=spawn('node',['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'p',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});
try{for(let i=0;i<40;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const login=async e=>(await(await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token;
const call=async(t,m,u,b)=>{const r=await fetch(BASE+u,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))}};
const doc=await login('tunde@demo.ng'), ph=await login('pharmacy@demo.ng'), amaka=await login('amaka@demo.ng'), rider=await login('rider@demo.ng');

// two fresh prescriptions (one for collect, one for deliver)
const rx1=(await call(doc,'POST','/api/doc/orders',{type:'rx',patientId:'p_amaka',drug:'Amoxicillin 500mg',sig:'1 cap 3x daily'})).j;
const rx2=(await call(doc,'POST','/api/doc/orders',{type:'rx',patientId:'p_amaka',drug:'Metformin 500mg',sig:'1 tab twice daily'})).j;

// inventory exists + price suggestion
const sug=await call(ph,'GET','/api/pharm/price-suggest?drug=Metformin 500mg');
E('pharmacy has an inventory that suggests a price',sug.s===200&&sug.j.price>0,JSON.stringify(sug.j));

// pharmacy prices both
const pr1=await call(ph,'POST','/api/pharm/orders/'+rx1.id+'/price',{items:[{name:'Amoxicillin 500mg',qty:1,price:3500}]});
E('pharmacy prices a prescription -> priced',pr1.s===200&&pr1.j.status==='priced'&&pr1.j.drugTotal===3500,JSON.stringify({s:pr1.j.status,t:pr1.j.drugTotal}));
const pr2=await call(ph,'POST','/api/pharm/orders/'+rx2.id+'/price',{items:[{name:'Metformin 500mg',qty:2,price:3200}]});
E('line items x qty sum into drugTotal',pr2.j.drugTotal===6400,JSON.stringify({t:pr2.j.drugTotal}));

// patient sees priced orders with items + total
const po=await call(amaka,'GET','/api/patient/orders'); const seen=po.j.find(o=>o.id===rx1.id);
E('patient sees the priced order with items + total',seen&&seen.status==='priced'&&Array.isArray(seen.items)&&seen.drugTotal===3500);

// COLLECT path: pay -> ready + pickup code; only drug total charged in-app
const payC=await call(amaka,'POST','/api/patient/rx/'+rx1.id+'/pay',{fulfilment:'collect'});
E('pay (collect) -> ready + 6-digit pickup code',payC.s===200&&payC.j.status==='ready'&&/^\d{6}$/.test(payC.j.pickupCode||''),JSON.stringify({s:payC.j.status,code:payC.j.pickupCode}));
E('collect path has NO dispatch fee',payC.j.dispatchFee==null);
// pharmacy collect: wrong code fails, right code works
const wrong=await call(ph,'POST','/api/pharm/orders/'+rx1.id+'/collect',{code:'000000'});
E('pharmacy collect with WRONG code is rejected',wrong.s===400);
const right=await call(ph,'POST','/api/pharm/orders/'+rx1.id+'/collect',{code:payC.j.pickupCode});
E('pharmacy collect with RIGHT code -> collected',right.s===200&&right.j.status==='collected');

// DELIVER path: pay with address -> dispatched + delivery job w/ dispatch fee + code
const payD=await call(amaka,'POST','/api/patient/rx/'+rx2.id+'/pay',{fulfilment:'deliver',address:'12 Adeola Odeku, VI'});
E('pay (deliver) -> dispatched + dispatch fee recorded (pay-on-delivery)',payD.s===200&&payD.j.status==='dispatched'&&payD.j.dispatchFee===1500,JSON.stringify({s:payD.j.status,fee:payD.j.dispatchFee}));
const dv=await call(rider,'GET','/api/rider/deliveries'); const job=dv.j.find(d=>d.orderId===rx2.id);
E('rider sees the delivery job with address + code',!!job&&job.address==='12 Adeola Odeku, VI'&&/^\d{6}$/.test(job.code));
const dWrong=await call(rider,'POST','/api/rider/deliveries/'+job.id+'/deliver',{code:'111111'});
E('rider deliver with WRONG code rejected',dWrong.s===400);
const dRight=await call(rider,'POST','/api/rider/deliveries/'+job.id+'/deliver',{code:job.code});
E('rider deliver with RIGHT code -> delivered',dRight.s===200&&dRight.j.order.status==='delivered');

// ONLY drugs were paid in-app; dispatch fee never hit the in-app charges
const bun=await call(amaka,'GET','/api/me/bundle'); const claims=(bun.j.claims||bun.j.billing||[]);
const paidClaims=claims.filter(c=>/Medication/.test(c.what)&&c.status==='Paid');
E('only DRUG totals were charged in-app (3500 + 6400)',paidClaims.some(c=>c.amount===3500)&&paidClaims.some(c=>c.amount===6400),JSON.stringify(paidClaims.map(c=>c.amount)));
E('no in-app charge equals the dispatch fee (1500)',!claims.some(c=>c.amount===1500));

// guard: cannot pay an unpriced order
const rx3=(await call(doc,'POST','/api/doc/orders',{type:'rx',patientId:'p_amaka',drug:'Vitamin C',sig:'daily'})).j;
E('cannot pay before pricing',(await call(amaka,'POST','/api/patient/rx/'+rx3.id+'/pay',{fulfilment:'collect'})).s===400);

console.log('\nPHARMACY FLOW: '+ok+' passed, '+bad+' failed');
}catch(e){console.error('ERR',e.message,e.stack);bad++}finally{srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}})();
