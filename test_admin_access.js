const {spawn}=require('child_process');const fs=require('fs');
const PORT=4949,BASE='http://localhost:'+PORT,DB='/tmp/ac2.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function tok(e){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token}
async function call(t,m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))}}
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'ac2',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const admin=await tok('admin@demo.ng');
const acc=await call(admin,'GET','/api/admin/access');
E('admin can list staff access', acc.s===200 && Array.isArray(acc.j.staff) && acc.j.levels.length>0, JSON.stringify({staff:acc.j.staff&&acc.j.staff.length,levels:acc.j.levels&&acc.j.levels.length}));
// pick a lab tech at grand and grant "operations" admin
const lab=acc.j.staff.find(s=>/lab/i.test(s.role)); 
const set=await call(admin,'POST','/api/admin/access/'+lab.id,{level:'operations'});
E('admin grants an operations-admin level to a lab tech', set.s===200 && set.j.adminPermissions.includes('admin.overview')&&set.j.adminPermissions.includes('admin.staff'), JSON.stringify(set.j.adminPermissions));
// that lab tech can now hit the admin dashboard (admin.overview) but NOT settlements (finance)
const labTok=await tok('lab@demo.ng'); // lab@ is a grand lab tech
const ov=await call(labTok,'GET','/api/admin/overview'); const settle=await call(labTok,'GET','/api/admin/settlements');
E('granted staff can now open the hospital dashboard', ov.s===200, ov.s);
E('but is still blocked from settlements (not in their level)', settle.s===403, settle.s);
// revoke
const rev=await call(admin,'POST','/api/admin/access/'+lab.id,{level:'none'});
const ov2=await call(labTok,'GET','/api/admin/overview');
E('revoking removes their dashboard access', rev.s===200 && ov2.s===403, JSON.stringify({rev:rev.s,ov:ov2.s}));
// scoping: grand admin cannot edit a river staffer
const acc2=await tok('admin2@demo.ng'); const riverStaff=(await call(acc2,'GET','/api/admin/access')).j.staff[0];
const cross=await call(admin,'POST','/api/admin/access/'+riverStaff.id,{level:'full'});
E('admin cannot grant access to another hospital staff', cross.s===404, cross.s);
console.log('\nADMIN ACCESS LEVELS: '+ok+' passed, '+bad+' failed');
srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}catch(e){console.error('ERR',e.message);srv.kill('SIGKILL');process.exit(1)}})();
