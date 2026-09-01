const {spawn}=require('child_process');const fs=require('fs');
const PORT=4953,BASE='http://localhost:'+PORT,DB='/tmp/au.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function tok(e){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token}
async function call(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))}}
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'au',DISABLE_OSRM:'1',DELIVERY_STEP:'0.34',DELIVERY_DWELL_MS:'1200'},stdio:['ignore','ignore','ignore']});
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const doc=await tok('tunde@demo.ng'),ph=await tok('pharmacy@demo.ng'),pt=await tok('amaka@demo.ng');
const rx=(await call(doc,'POST','/api/doc/orders',{type:'rx',patientId:'p_amaka',drug:'Amlodipine 5mg',sig:'1 daily'})).j;
await call(ph,'POST','/api/pharm/orders/'+rx.id+'/price',{items:[{name:'Amlodipine 5mg',qty:30,price:4000}]});
await call(pt,'POST','/api/patient/rx/'+rx.id+'/pay',{fulfilment:'deliver',address:'15 Adeniran Ogunsanya St, Surulere'});
// observe it drive itself: transit (with ETA) -> arriving -> delivered, no manual action
let sawTransit=false,sawEta=false,sawArriving=false,delivered=false;
for(let i=0;i<40;i++){ const t=await call(pt,'GET','/api/patient/rx/'+rx.id+'/track');
  if(t.j.status==='transit'){ sawTransit=true; if(t.j.etaSec!=null) sawEta=true; }
  if(t.j.status==='arriving') sawArriving=true;
  if(t.j.active===false){ delivered=true; break; }
  await sleep(400);
}
E('rider auto-moves in transit', sawTransit);
E('delivery reports an ETA while moving', sawEta);
E('delivery reaches the door (arriving) on its own', sawArriving);
E('delivery AUTO-COMPLETES with no manual action (demo self-run)', delivered);
// and a manual code handover still works (fresh delivery)
const rx2=(await call(doc,'POST','/api/doc/orders',{type:'rx',patientId:'p_amaka',drug:'Paracetamol 1g',sig:'prn'})).j;
await call(ph,'POST','/api/pharm/orders/'+rx2.id+'/price',{items:[{name:'Paracetamol 1g',qty:20,price:1500}]});
const pay2=await call(pt,'POST','/api/patient/rx/'+rx2.id+'/pay',{fulfilment:'deliver',address:'X'});
const rider=await tok('rider@demo.ng'); const dels=await call(rider,'GET','/api/rider/deliveries'); const d2=(dels.j||[]).find(x=>x.orderId===rx2.id);
const del=await call(rider,'POST','/api/rider/deliveries/'+d2.id+'/deliver',{code:pay2.j.pickupCode||d2.code});
E('manual code handover still works', del.s===200, del.s);
console.log('\nRIDER SELF-RUN DEMO: '+ok+' passed, '+bad+' failed');
srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}catch(e){console.error('ERR',e.message);srv.kill('SIGKILL');process.exit(1)}})();
