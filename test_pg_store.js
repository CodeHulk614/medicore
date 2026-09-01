// Verifies the Netlify Postgres store: writes persist and concurrent writes don't clobber.
// Requires a Postgres at DATABASE_URL (set it before running). Skips cleanly if unset.
process.env.MC_SERVERLESS='1';
if(!process.env.DATABASE_URL){ console.log('SKIP: set DATABASE_URL to run this test'); process.exit(0); }
const fn=require('./netlify/functions/api.js'); const {Pool}=require('pg');
let ok=0,bad=0; const E=(n,c)=>{console.log((c?'  PASS  ':'  FAIL  ')+n);c?ok++:bad++};
function ev(m,p,b,t){return {httpMethod:m,path:p,rawUrl:'http://x'+p,headers:Object.assign({'content-type':'application/json'},t?{authorization:'Bearer '+t}:{}),body:b?JSON.stringify(b):null};}
async function call(m,p,b,t){const r=await fn.handler(ev(m,p,b,t),{});let j={};try{j=JSON.parse(r.body);}catch(e){}return{s:r.statusCode,j};}
(async()=>{const pool=new Pool({connectionString:process.env.DATABASE_URL});
 await pool.query('CREATE TABLE IF NOT EXISTS medicore_store(id int primary key, doc jsonb)');await pool.query('DELETE FROM medicore_store');
 const orders=async()=>((await pool.query("SELECT doc->'orders' o FROM medicore_store WHERE id=1")).rows[0]||{o:[]}).o||[];
 await call('GET','/api/health');
 const ph=(await call('POST','/api/auth/login',{email:'pharmacy@demo.ng',password:'demo1234'})).j.token;
 const doc=(await call('POST','/api/auth/login',{email:'tunde@demo.ng',password:'demo1234'})).j.token;
 await Promise.all([call('POST','/api/shift/clockin',{},ph),call('GET','/api/shift/me',null,ph),call('GET','/api/pharm/queue',null,ph)]);
 E('clock-in sticks under concurrent polling', !!(await call('GET','/api/shift/me',null,ph)).j.open);
 const rx=(await call('POST','/api/doc/orders',{type:'rx',patientId:'p_amaka',drug:'X',sig:'1'},doc)).j;
 E('write persists to Postgres', (await orders()).some(o=>o.id===rx.id));
 const [a,b]=await Promise.all([call('POST','/api/doc/orders',{type:'rx',patientId:'p_amaka',drug:'A',sig:'1'},doc),call('POST','/api/doc/orders',{type:'lab',patientId:'p_amaka',test:'B'},doc)]);
 const os=await orders(); E('concurrent writes both persist (no clobber)', os.some(o=>o.id===a.j.id)&&os.some(o=>o.id===b.j.id));
 await pool.end(); console.log('\nPG STORE: '+ok+' passed, '+bad+' failed'); process.exit(bad?1:0);
})().catch(e=>{console.error(e.message);process.exit(1)});
