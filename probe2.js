const {spawn}=require('child_process');const path=require('path'),fs=require('fs');
const PORT=4971,BASE='http://localhost:'+PORT,DB=path.join(__dirname,'data','pb2.json');try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{const srv=spawn('node',['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'p',DISABLE_OSRM:'1'},stdio:['ignore','ignore','inherit']});
try{for(let i=0;i<50;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const tok=async e=>(await(await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token;
const get=async(t,u)=>{const r=await fetch(BASE+u,{headers:{Authorization:'Bearer '+t}});return {s:r.status,j:await r.json().catch(()=>({}))}};
const ph=await tok('pharmacy@demo.ng'),lb=await tok('lab@demo.ng'),ad=await tok('admin@demo.ng'),ri=await tok('rider@demo.ng'),ch=await tok('chw@demo.ng');
const p=await get(ph,'/api/pharm/overview');console.log('pharm:',p.s,'queue',p.j.queue,'ready',p.j.ready,'turnaround',p.j.avgTurnaroundMin,'breakdown',JSON.stringify(p.j.breakdown));
const l=await get(lb,'/api/lab/overview');console.log('lab:',l.s,'pending',l.j.pending,'resultedToday',l.j.resultedToday,'turnaround',l.j.avgTurnaroundMin,'breakdown',JSON.stringify(l.j.breakdown));
const a=await get(ad,'/api/admin/overview');console.log('admin ops:',JSON.stringify(a.j.ops));
const r=await get(ri,'/api/rider/stats');console.log('rider:',r.s,JSON.stringify(r.j));
const c=await get(ch,'/api/chw/stats');console.log('chw:',c.s,JSON.stringify(c.j));
}catch(e){console.error(e)}finally{srv.kill();try{fs.unlinkSync(DB)}catch(e){}}})();
