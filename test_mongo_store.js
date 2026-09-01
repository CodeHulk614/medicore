// Verifies the MongoDB persistence + write-lock logic using an in-memory driver fake.
// (No live Mongo needed; exercises exports._runWithMongo.)
process.env.MC_SERVERLESS='1'; process.env.DISABLE_OSRM='1'; process.env.JWT_SECRET='mg';
const fn=require('./netlify/functions/api.js');
let ok=0,bad=0; const E=(n,c)=>{console.log((c?'  PASS  ':'  FAIL  ')+n);c?ok++:bad++};
function makeColl(){ const docs=new Map();
  const match=(d,f)=>{ for(const k of Object.keys(f)){ if(k==='$or'){ if(!f.$or.some(x=>match(d,x)))return false; continue;} const c=f[k],v=d?d[k]:undefined;
    if(c&&typeof c==='object'){ if('$ne'in c&&v===c.$ne)return false; if('$lt'in c&&!(v<c.$lt))return false; if(!('$ne'in c)&&!('$lt'in c)&&v!==c)return false; } else if(v!==c)return false; } return true; };
  const apply=(d,u,ins)=>{ if(u.$set)Object.assign(d,u.$set); if(u.$setOnInsert&&ins)Object.assign(d,u.$setOnInsert); return d; };
  return { async findOne(f){for(const d of docs.values())if(match(d,f))return JSON.parse(JSON.stringify(d));return null;},
    async updateOne(f,u,o={}){for(const d of docs.values())if(match(d,f)){apply(d,u,false);return{matchedCount:1};} if(o.upsert){const id=f._id,d={_id:id};apply(d,u,true);docs.set(id,d);return{upsertedCount:1};}return{matchedCount:0};},
    async findOneAndUpdate(f,u,o={}){for(const d of docs.values())if(match(d,f)){const b=JSON.parse(JSON.stringify(d));apply(d,u,false);return o.returnDocument==='before'?b:JSON.parse(JSON.stringify(d));}return null;},
    _data(){const d=docs.get(1);return d?d.data:null;} };
}
const coll=makeColl();
function ev(m,p,b,t){return{httpMethod:m,path:p,rawUrl:'http://x'+p,headers:Object.assign({'content-type':'application/json'},t?{authorization:'Bearer '+t}:{}),body:b?JSON.stringify(b):null};}
const isW=m=>!['GET','HEAD','OPTIONS'].includes(m);
async function call(m,p,b,t){const r=await fn._runWithMongo(coll,ev(m,p,b,t),{},isW(m));let j={};try{j=JSON.parse(r.body);}catch(e){}return{s:r.statusCode,j};}
(async()=>{ await call('GET','/api/health'); E('seeded to Mongo doc', !!(coll._data()&&coll._data().users.length));
 const ph=(await call('POST','/api/auth/login',{email:'pharmacy@demo.ng',password:'demo1234'})).j.token;
 const doc=(await call('POST','/api/auth/login',{email:'tunde@demo.ng',password:'demo1234'})).j.token;
 await Promise.all([call('POST','/api/shift/clockin',{},ph),call('GET','/api/shift/me',null,ph),call('GET','/api/pharm/queue',null,ph),call('GET','/api/shift/me',null,ph)]);
 E('clock-in sticks under concurrent polling', !!(await call('GET','/api/shift/me',null,ph)).j.open);
 const rx=(await call('POST','/api/doc/orders',{type:'rx',patientId:'p_amaka',drug:'X',sig:'1'},doc)).j;
 E('write persists to Mongo doc', (coll._data().orders||[]).some(o=>o.id===rx.id));
 const [a,b]=await Promise.all([call('POST','/api/doc/orders',{type:'rx',patientId:'p_amaka',drug:'A',sig:'1'},doc),call('POST','/api/doc/orders',{type:'lab',patientId:'p_amaka',test:'B'},doc)]);
 const os=coll._data().orders||[]; E('concurrent writes both persist (no clobber)', os.some(o=>o.id===a.j.id)&&os.some(o=>o.id===b.j.id));
 console.log('\nMONGO STORE: '+ok+' passed, '+bad+' failed'); process.exit(bad?1:0);
})().catch(e=>{console.error(e.message);process.exit(1)});
