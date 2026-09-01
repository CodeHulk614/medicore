const {spawn}=require('child_process');const fs=require('fs');
const PORT=4960,BASE='http://localhost:'+PORT,DB='/tmp/dl.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function tok(e){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token}
async function call(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))}}
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'d',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const doc=await tok('tunde@demo.ng'),ph=await tok('pharmacy@demo.ng'),pt=await tok('amaka@demo.ng'),rider=await tok('rider@demo.ng');
const rx=(await call(doc,'POST','/api/doc/orders',{type:'rx',patientId:'p_amaka',drug:'Amlodipine 5mg',sig:'1 daily'})).j;
await call(ph,'POST','/api/pharm/orders/'+rx.id+'/price',{items:[{name:'Amlodipine 5mg',qty:30,price:4000}]});
const pay=await call(pt,'POST','/api/patient/rx/'+rx.id+'/pay',{fulfilment:'deliver',address:'15 Adeniran Ogunsanya St, Surulere'});
E('patient pays for delivery',pay.s===200,pay.s);
const dels=await call(rider,'GET','/api/rider/deliveries'); const d=(dels.j||[])[0];
E('rider delivery carries pickup coords (pharmacy)', !!(d&&d.pickup&&d.pickup.lat!=null), JSON.stringify(d&&d.pickup));
E('rider delivery carries dropoff coords (patient home)', !!(d&&d.dropoff&&d.dropoff.lat!=null), JSON.stringify(d&&d.dropoff));
E('rider delivery has a live rider position', d&&d.riderLat!=null, d&&d.status);
let trk=await call(pt,'GET','/api/patient/rx/'+rx.id+'/track');
E('patient can track the delivery', trk.j.active===true&&!!trk.j.rider, JSON.stringify({a:trk.j.active,s:trk.j.status}));
const p0=trk.j.rider?{...trk.j.rider}:null; await sleep(3200);
trk=await call(pt,'GET','/api/patient/rx/'+rx.id+'/track');
const moved=p0&&trk.j.rider&&(Math.abs(trk.j.rider.lat-p0.lat)>1e-6||Math.abs(trk.j.rider.lng-p0.lng)>1e-6);
E('rider position moves toward the patient (demo live tracking)', moved, 'status '+trk.j.status);
// deliver with code closes it
const del=await call(rider,'POST','/api/rider/deliveries/'+d.id+'/deliver',{code:trk.j.code});
E('code-confirmed handover marks it delivered', del.s===200, del.s);
const trk2=await call(pt,'GET','/api/patient/rx/'+rx.id+'/track');
E('after delivery, tracking shows not active', trk2.j.active===false, JSON.stringify(trk2.j));
console.log('\nDELIVERY TRACKING: '+ok+' passed, '+bad+' failed');
srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}catch(e){console.error('ERR',e.message);srv.kill('SIGKILL');process.exit(1)}})();
