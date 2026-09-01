const {spawn}=require('child_process');const path=require('path'),fs=require('fs');
const PORT=4986,BASE='http://localhost:'+PORT,DB=path.join(__dirname,'data','fl.json');try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;
const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
(async()=>{const srv=spawn('node',['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'f',DISPATCH_SPEED_KMH:'600',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});
try{for(let i=0;i<40;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const login=async e=>(await(await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token;
const call=async(t,m,u,b)=>{const r=await fetch(BASE+u,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))}};
const admin=await login('admin@demo.ng'), disp=await login('dispatch@demo.ng'), amaka=await login('amaka@demo.ng');
// admin fleet endpoint
const fl=await call(admin,'GET','/api/admin/fleet');
E('admin fleet returns units for the hospital',fl.s===200&&Array.isArray(fl.j.units)&&fl.j.units.length>=1,JSON.stringify(fl.j.stats));
E('fleet units carry position + crewed flag',fl.j.units.every(u=>typeof u.lat==='number'&&'crewed'in u));
E('fleet is scoped to the admin hospital',fl.j.units.every(u=>u.hospitalId===fl.j.units[0].hospitalId));
// patient SOS -> dispatch a SPECIFIC unit (no crew online) -> it should still MOVE (demo movement)
await call(amaka,'POST','/api/patient/sos',{hospitalId:'h_grand'});
const board=await call(disp,'GET','/api/dispatch/board'); const cse=board.j.cases.find(c=>c.status==='requested'); const avail=board.j.units.find(u=>u.status==='available');
const asg=await call(disp,'POST','/api/dispatch/cases/'+cse.id+'/assign',{responderId:avail.id});
E('dispatch can assign a SPECIFIC ambulance',asg.s===200&&asg.j.unit.id===avail.id,JSON.stringify({want:avail.id,got:asg.j.unit&&asg.j.unit.id}));
// capture position, wait for the auto tick to move it (no crew involved)
const p1=await call(amaka,'GET','/api/patient/track'); const pos1=p1.j.unit?{lat:p1.j.unit.lat,lng:p1.j.unit.lng}:null;
await sleep(2500);
const p2=await call(amaka,'GET','/api/patient/track'); const pos2=p2.j.unit?{lat:p2.j.unit.lat,lng:p2.j.unit.lng}:null;
E('ambulance auto-moves with NO crew (demo movement)', pos1&&pos2&&(pos1.lat!==pos2.lat||pos1.lng!==pos2.lng), JSON.stringify({pos1,pos2}));
E('patient track exposes the moving unit + route for a map', !!p2.j.unit && Array.isArray(p2.j.unit.route||p1.j.unit.route||[]));
console.log('\nFLEET/DEMO: '+ok+' passed, '+bad+' failed');
}catch(e){console.error('ERR',e.message);bad++}finally{srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}})();
