process.env.DISABLE_OSRM='1'; process.env.DELIVERY_STEP='0.5'; process.env.JWT_SECRET='fn';
const fn=require('/home/claude/work/medicore-netlify/netlify/functions/api.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); let ok=0,bad=0; const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
function ev(method,path,body,token){ return { httpMethod:method, path, rawUrl:'http://x'+path, headers:Object.assign({'content-type':'application/json'}, token?{authorization:'Bearer '+token}:{}), body: body?JSON.stringify(body):null, isBase64Encoded:false }; }
async function call(method,path,body,token){ const r=await fn.handler(ev(method,path,body,token),{}); let j={}; try{ j=JSON.parse(r.body); }catch(e){} return { s:r.statusCode, j }; }
(async()=>{
 const h=await call('GET','/api/health'); E('health via function', h.s===200 && h.j.ok===true, JSON.stringify(h.j).slice(0,60));
 const login=await call('POST','/api/auth/login',{email:'amaka@demo.ng',password:'demo1234'}); E('login via function', login.s===200 && !!login.j.token, login.s);
 const pt=login.j.token;
 const doc=(await call('POST','/api/auth/login',{email:'tunde@demo.ng',password:'demo1234'})).j.token;
 const ph=(await call('POST','/api/auth/login',{email:'pharmacy@demo.ng',password:'demo1234'})).j.token;
 const bundle=await call('GET','/api/me/bundle',null,pt); E('patient bundle loads', bundle.s===200 && (bundle.j.profile||bundle.j.patient||bundle.j.me||bundle.j.orders), bundle.s);
 // prescription -> delivery, then movement should advance across calls (lazy catchUp)
 const rx=(await call('POST','/api/doc/orders',{type:'rx',patientId:'p_amaka',drug:'Amlodipine 5mg',sig:'1'},doc)).j;
 await call('POST','/api/pharm/orders/'+rx.id+'/price',{items:[{name:'Amlodipine 5mg',qty:30,price:4000}]},ph);
 await call('POST','/api/patient/rx/'+rx.id+'/pay',{fulfilment:'deliver',address:'15 Adeniran Ogunsanya St, Surulere'},pt);
 let t1=await call('GET','/api/patient/rx/'+rx.id+'/track',null,pt);
 const p0=t1.j.rider?{...t1.j.rider}:null;
 E('delivery created with rider position', t1.j.active===true && !!t1.j.rider, JSON.stringify({a:t1.j.active}));
 await sleep(2200); // real time passes; next request should advance movement lazily
 let t2=await call('GET','/api/patient/rx/'+rx.id+'/track',null,pt);
 const moved = p0 && t2.j.rider && (Math.abs(t2.j.rider.lat-p0.lat)>1e-6 || t2.j.status!=='transit');
 E('rider advances lazily on read (serverless movement)', moved, 'status '+t2.j.status);
 console.log('\nNETLIFY FUNCTION (local): '+ok+' passed, '+bad+' failed');
 process.exit(bad?1:0);
})();
