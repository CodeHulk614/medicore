const {spawn}=require('child_process');const fs=require('fs');
const PORT=4950,BASE='http://localhost:'+PORT,DB='/tmp/cl.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function tok(e){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token}
async function call(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))}}
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'cl',DISABLE_OSRM:'1',DELIVERY_STEP:'0.001'},stdio:['ignore','ignore','ignore']});
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const doc=await tok('tunde@demo.ng'),ph=await tok('pharmacy@demo.ng'),pt=await tok('amaka@demo.ng');
const rx=(await call(doc,'POST','/api/doc/orders',{type:'rx',patientId:'p_amaka',drug:'Amlodipine 5mg',sig:'1'})).j;
await call(ph,'POST','/api/pharm/orders/'+rx.id+'/price',{items:[{name:'Amlodipine 5mg',qty:30,price:4000}]});
await call(pt,'POST','/api/patient/rx/'+rx.id+'/pay',{fulfilment:'deliver',address:'15 Adeniran Ogunsanya St, Surulere'});
// two Grandville riders
const r1=await tok('rider@demo.ng'), r3=await tok('rider3@demo.ng');
let l1=await call(r1,'GET','/api/rider/deliveries'); const d=l1.j[0];
E('both riders see the unassigned run', d && d.claimed===false && d.mine===false, JSON.stringify(d&&{claimed:d.claimed,mine:d.mine}));
// rider 1 accepts
const c1=await call(r1,'POST','/api/rider/deliveries/'+d.id+'/claim',{});
E('rider 1 can accept the run', c1.s===200, c1.s);
// rider 3 cannot claim it now
const c3=await call(r3,'POST','/api/rider/deliveries/'+d.id+'/claim',{});
E('rider 3 is blocked from claiming (already taken)', c3.s===409, c3.s);
// lists reflect ownership
l1=await call(r1,'GET','/api/rider/deliveries'); const l3=await call(r3,'GET','/api/rider/deliveries');
E('rider 1 sees it as mine', l1.j[0].mine===true);
E('rider 3 sees it as taken by another', l3.j[0].claimedByOther===true && !!l3.j[0].riderName, JSON.stringify({other:l3.j[0].claimedByOther,name:l3.j[0].riderName}));
// rider 3 cannot deliver it
const badDel=await call(r3,'POST','/api/rider/deliveries/'+d.id+'/deliver',{code:d.code});
E('rider 3 cannot deliver a run owned by another', badDel.s===403, badDel.s);
// rider 1 delivers with code
const okDel=await call(r1,'POST','/api/rider/deliveries/'+d.id+'/deliver',{code:d.code});
E('assigned rider 1 delivers with the code', okDel.s===200, okDel.s);
// dispatcher sees the assigned rider name
const disp=await tok('dispatch@demo.ng'); // after delivery it's closed, so raise another to check name
const rx2=(await call(doc,'POST','/api/doc/orders',{type:'rx',patientId:'p_amaka',drug:'Paracetamol',sig:'1'})).j;
await call(ph,'POST','/api/pharm/orders/'+rx2.id+'/price',{items:[{name:'Paracetamol',qty:1,price:800}]});
await call(pt,'POST','/api/patient/rx/'+rx2.id+'/pay',{fulfilment:'deliver',address:'X'});
const l=await call(r1,'GET','/api/rider/deliveries'); const d2=l.j.find(x=>x.orderId===rx2.id); await call(r1,'POST','/api/rider/deliveries/'+d2.id+'/claim',{});
const board=await call(disp,'GET','/api/dispatch/board'); const bd=(board.j.deliveries||[]).find(x=>x.id===d2.id);
E('dispatcher sees which rider is assigned', bd && !!bd.riderName, JSON.stringify(bd&&bd.riderName));
console.log('\nRIDER ASSIGNMENT: '+ok+' passed, '+bad+' failed');
srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}catch(e){console.error('ERR',e.message);srv.kill('SIGKILL');process.exit(1)}})();
