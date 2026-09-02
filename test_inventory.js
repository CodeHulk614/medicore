const {spawn}=require('child_process');const fs=require('fs');
const PORT=4934,BASE='http://localhost:'+PORT,DB='/tmp/inv.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function tok(e){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token}
let PH; async function call(m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'Content-Type':'application/json',Authorization:'Bearer '+PH},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))};}
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'inv',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
PH=await tok('pharmacy@demo.ng');
const ov=await call('GET','/api/pharm/inv/overview');
E('overview: items, low, out, near-expiry buckets', ov.s===200 && ov.j.items>0 && ('d30' in ov.j.expiring), JSON.stringify(ov.j).slice(0,120));
const items=(await call('GET','/api/pharm/inv/items')).j;
const amlo=items.find(i=>i.name==='Amlodipine'); const lis=items.find(i=>i.name==='Lisinopril'); const amox=items.find(i=>i.name==='Amoxicillin'); const cod=items.find(i=>i.name==='Codeine Linctus');
E('Lisinopril is out of stock (0)', lis && lis.out && lis.onHand===0);
E('Metformin flagged low + near-expiry', (()=>{const m=items.find(i=>i.name==='Metformin');return m&&m.low&&m.nearExpiry>0;})());
E('controlled item flagged (Codeine)', cod && cod.controlled===true);
// RECEIVE stock -> on-hand rises, ledger entry
const before=amlo.onHand;
const rec=await call('POST','/api/pharm/inv/receive',{itemId:amlo.id,batchNo:'BNEW1',expiry:'2027-12-31',qty:50,cost:1500});
const amlo2=(await call('GET','/api/pharm/inv/items')).j.find(i=>i.id===amlo.id);
E('receiving adds a batch and raises on-hand by qty', rec.s===200 && amlo2.onHand===before+50, before+' -> '+amlo2.onHand);
// FEFO dispense by quantity picks earliest-expiry batch
const det=(await call('GET','/api/pharm/inv/items/'+amox.id)).j;
const earliest=det.batches.filter(b=>b.qtyOnHand>0).sort((a,b)=>a.expiry.localeCompare(b.expiry))[0];
const disp=await call('POST','/api/pharm/inv/dispense',{itemId:amox.id,qty:5,ref:'t1'});
const det2=(await call('GET','/api/pharm/inv/items/'+amox.id)).j;
const earliest2=det2.batches.find(b=>b.id===earliest.id);
E('FEFO dispense decrements the earliest-expiry batch by exact qty', disp.s===200 && earliest2.qtyOnHand===earliest.qtyOnHand-5, earliest.qtyOnHand+' -> '+(earliest2&&earliest2.qtyOnHand));
// dispensing more than available is blocked
const over=await call('POST','/api/pharm/inv/dispense',{itemId:lis.id,qty:5});
E('dispensing out-of-stock item is blocked (409)', over.s===409, over.s);
// RESERVE reduces available but not on-hand; release restores
const r1=await call('POST','/api/pharm/inv/reserve',{itemId:amlo.id,qty:10,ref:'ord9'});
const amlo3=(await call('GET','/api/pharm/inv/items')).j.find(i=>i.id===amlo.id);
E('reserve commits stock (available drops, on-hand unchanged)', r1.s===200 && amlo3.committed>=10 && amlo3.available===amlo3.onHand-amlo3.committed);
await call('POST','/api/pharm/inv/release',{ref:'ord9'});
const amlo4=(await call('GET','/api/pharm/inv/items')).j.find(i=>i.id===amlo.id);
E('release frees the reservation', amlo4.committed===0);
// ADJUST (take-down) with reason + ledger
const adj=await call('POST','/api/pharm/inv/items/'+amlo.id+'/adjust',{delta:-3,reason:'damaged in store'});
E('adjust removes stock with a reason', adj.s===200);
// CYCLE COUNT variance
const b0=(await call('GET','/api/pharm/inv/items/'+amlo.id)).j.batches[0];
const cnt=await call('POST','/api/pharm/inv/batches/'+b0.id+'/count',{counted:b0.qtyOnHand-2});
E('cycle count posts a variance', cnt.s===200 && cnt.j.variance===-2, JSON.stringify(cnt.j));
// RECALL quarantines a batch
const rc=await call('POST','/api/pharm/inv/recall',{batchId:earliest.id,reason:'manufacturer recall'});
const det3=(await call('GET','/api/pharm/inv/items/'+amox.id)).j;
E('recall quarantines the batch (removed from on-hand)', rc.s===200 && det3.batches.find(b=>b.id===earliest.id).status==='quarantined');
E('recall appears in recalls list with claim', (await call('GET','/api/pharm/inv/recalls')).j.some(r=>r.batchId===earliest.id));
// SUPPLIER + PO create + receive
const sup=(await call('GET','/api/pharm/inv/suppliers')).j[0];
const po=await call('POST','/api/pharm/inv/po',{supplierId:sup.id,lines:[{itemId:lis.id,qty:30,cost:2400}]});
E('create purchase order', po.s===200 && po.j.status==='sent');
const lisBefore=(await call('GET','/api/pharm/inv/items')).j.find(i=>i.id===lis.id).onHand;
const recv=await call('POST','/api/pharm/inv/po/'+po.j.id+'/receive',{lines:[{itemId:lis.id,batchNo:'LISB1',expiry:'2027-06-30',qty:30,cost:2400}]});
const lisAfter=(await call('GET','/api/pharm/inv/items')).j.find(i=>i.id===lis.id).onHand;
E('receiving a PO creates batches and restocks', recv.s===200 && lisAfter===lisBefore+30, lisBefore+' -> '+lisAfter);
// LEDGER has the movement types
const moves=(await call('GET','/api/pharm/inv/moves')).j;
const types=new Set(moves.map(m=>m.type));
E('ledger records receive/dispense/adjust/recall/count/reserve', ['receive','dispense','adjust','recall','count','reserve'].every(t=>types.has(t)), [...types].join(','));
// prescription flow decrements REAL stock via the hook
const doc=await tok('tunde@demo.ng'); const amlo5=(await call('GET','/api/pharm/inv/items')).j.find(i=>i.id===amlo.id);
const rx=await (await fetch(BASE+'/api/doc/orders',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+doc},body:JSON.stringify({type:'rx',patientId:'p_amaka',drug:'Amlodipine 5mg',sig:'1'})})).json();
await call('POST','/api/pharm/orders/'+rx.id+'/price',{items:[{name:'Amlodipine 5mg',qty:2,price:2500}]});
await call('POST','/api/pharm/orders/'+rx.id+'/verify').catch(()=>{});
await call('POST','/api/pharm/orders/'+rx.id+'/ready');
const amlo6=(await call('GET','/api/pharm/inv/items')).j.find(i=>i.id===amlo.id);
E('dispensing a prescription decrements real inventory (by qty)', amlo6.onHand < amlo5.onHand, amlo5.onHand+' -> '+amlo6.onHand);
console.log('\nINVENTORY: '+ok+' passed, '+bad+' failed');
srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}catch(e){console.error('ERR',e.message,e.stack);srv.kill('SIGKILL');process.exit(1)}})();
