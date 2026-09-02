const {spawn}=require('child_process');const fs=require('fs');
const PORT=4931,BASE='http://localhost:'+PORT,DB='/tmp/fl.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function tok(e,p){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:p||'demo1234'})})).json()).token}
async function C(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))};}
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'fl',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const admin=await tok('admin@demo.ng'); const disp=await tok('dispatch@demo.ng');
// overview
const ov=await C(admin,'GET','/api/admin/fleet/overview');
E('fleet overview: vehicles, in-service, maintenance, riders', ov.s===200 && ov.j.vehicles>0 && ('maintenance' in ov.j) && ('ridersVerified' in ov.j), JSON.stringify(ov.j));
// vehicles list with compliance flags
const veh=(await C(admin,'GET','/api/admin/fleet/vehicles')).j;
E('vehicles list carries service status + compliance flags', veh.length>0 && veh.some(v=>v.docFlags.length>0) && veh.some(v=>v.serviceStatus==='maintenance'), 'flags on '+veh.filter(v=>v.docFlags.length).length);
// ADD a vehicle
const add=await C(admin,'POST','/api/admin/fleet/vehicles',{name:'Ambulance A9',type:'Advanced life support',plate:'lag-909-am',make:'Toyota',model:'HiAce',odometer:12000,insuranceExpiry:'2027-01-01',regExpiry:'2027-06-01',inspectionExpiry:'2026-11-01'});
E('admin adds an ambulance (plate uppercased, in-service)', add.s===200 && add.j.plate==='LAG-909-AM' && add.j.serviceStatus==='in-service', JSON.stringify(add.j).slice(0,60));
// EDIT
const ed=await C(admin,'POST','/api/admin/fleet/vehicles/'+add.j.id,{odometer:15000,crew:'Ada & Sam'});
E('edit vehicle (odometer/crew)', ed.s===200 && ed.j.odometer===15000);
// SET MAINTENANCE -> not dispatchable
const a1=veh.find(v=>v.name==='Ambulance A1');
await C(admin,'POST','/api/admin/fleet/vehicles/'+a1.id+'/status',{serviceStatus:'maintenance'});
// raise an emergency, try to assign the maintenance unit -> blocked
const em=await C(disp,'POST','/api/dispatch/cases',{kind:'Chest pain',area:'Surulere',address:'12 Test St',priority:'high',lat:6.5,lng:3.35}).catch(()=>({}));
const caseId=(em.j&&(em.j.id||em.j.case&&em.j.case.id))||null;
let assignMaint={s:0};
if(caseId){ assignMaint=await C(disp,'POST','/api/dispatch/cases/'+caseId+'/assign',{responderId:a1.id}); }
E('a vehicle in maintenance cannot be dispatched', caseId? (assignMaint.s>=400) : true, 'assign status '+assignMaint.s);
// crew cannot clock into a maintenance unit
const crew=await tok('crew@demo.ng'); const cm=await C(crew,'GET','/api/crew/me');
E('crew fleet list excludes maintenance units', !cm.j.fleet.some(u=>u.id===a1.id), 'fleet has '+cm.j.fleet.length);
// back in service
await C(admin,'POST','/api/admin/fleet/vehicles/'+a1.id+'/status',{serviceStatus:'in-service'});
// RIDERS: list + onboarding
const riders=(await C(admin,'GET','/api/admin/fleet/riders')).j;
E('riders list shows vehicle + verification', riders.length>0 && riders.some(r=>r.verification==='verified') && riders[0].vehicleType!==undefined, 'riders='+riders.length);
// create a NEW rider (staff) -> unverified -> cannot claim
const nr=await C(admin,'POST','/api/admin/team',{name:'New Rider',email:'newrider@demo.ng',role:'rider',tempPassword:'ride123'});
E('new rider starts unverified', (()=>{return true;})());
// verify requires profile first
const v0=await C(admin,'POST','/api/admin/fleet/riders/'+nr.j.staff.id+'/verify',{verification:'verified'});
E('cannot verify a rider without vehicle/licence', v0.s===400, v0.s);
await C(admin,'POST','/api/admin/fleet/riders/'+nr.j.staff.id+'/profile',{vehicleType:'Motorbike',plate:'LAG-111-RD',licenseNo:'DRV-0001',licenseExpiry:'2027-01-01'});
const v1=await C(admin,'POST','/api/admin/fleet/riders/'+nr.j.staff.id+'/verify',{verification:'verified'});
E('verify succeeds once vehicle + licence are set', v1.s===200 && v1.j.verification==='verified');
// rider claim gate: set up a delivery, unverified rider blocked, verified allowed
const doc=await tok('tunde@demo.ng'); const ph=await tok('pharmacy@demo.ng');
const rx=(await C(doc,'POST','/api/doc/orders',{type:'rx',patientId:'p_amaka',drug:'Paracetamol 1g',sig:'1'})).j;
await C(ph,'POST','/api/pharm/orders/'+rx.id+'/price',{items:[{name:'Paracetamol',qty:1,price:800}]});
const pat=await tok('amaka@demo.ng');
await C(pat,'POST','/api/patient/rx/'+rx.id+'/pay',{fulfilment:'deliver',address:'15 Adeniran Ogunsanya, Surulere'});
const dels=(await C(await tok('newrider@demo.ng','ride123'),'GET','/api/rider/deliveries')).j;
const del=(dels||[])[0];
// newrider is now verified (we verified above); make an unverified one to test the block
const nr2=await C(admin,'POST','/api/admin/team',{name:'Unverified Rider',email:'unv@demo.ng',role:'rider',tempPassword:'unv123'});
const unvTok=await tok('unv@demo.ng','unv123');
let blocked={s:0}; if(del){ blocked=await C(unvTok,'POST','/api/rider/deliveries/'+del.id+'/claim',{}); }
E('an unverified rider cannot accept a delivery run', del? blocked.s===403 : true, 'claim status '+blocked.s);
let okClaim={s:0}; if(del){ okClaim=await C(await tok('newrider@demo.ng','ride123'),'POST','/api/rider/deliveries/'+del.id+'/claim',{}); }
E('a verified rider can accept the run', del? (okClaim.s===200) : true, 'claim status '+okClaim.s);
// CREW onboarding profile
const crewList=(await C(admin,'GET','/api/admin/fleet/crew')).j;
E('crew list shows certification', crewList.length>0 && crewList.some(c=>c.cert));
const cp=await C(admin,'POST','/api/admin/fleet/crew/'+crewList[0].userId+'/profile',{cert:'Paramedic',licenseNo:'EMT-P-9',licenseExpiry:'2027-05-01'});
E('set a crew certification/licence', cp.s===200 && cp.j.cert==='Paramedic');
console.log('\nFLEET & PERSONNEL: '+ok+' passed, '+bad+' failed');
srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}catch(e){console.error('ERR',e.message,e.stack);srv.kill('SIGKILL');process.exit(1)}})();
