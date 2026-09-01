const {spawn}=require('child_process');const path=require('path'),fs=require('fs');
const PORT=4980,BASE='http://localhost:'+PORT,DB=path.join(__dirname,'data','vid.json');try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;
const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
(async()=>{const srv=spawn('node',['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'v',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});
try{for(let i=0;i<40;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
const login=async e=>(await(await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token;
const call=async(t,m,u,b)=>{const r=await fetch(BASE+u,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});return {s:r.status,j:await r.json().catch(()=>({}))}};
const amaka=await login('amaka@demo.ng'), kunle=await login('kunle@demo.ng');
// find amaka's due-now video visit (doc_kunle)
const bun=await call(amaka,'GET','/api/me/bundle'); const appt=(bun.j.appointments||[]).find(a=>a.type==='video'&&a.scheduledAt<=Date.now());
E('a due video visit exists for the patient',!!appt,JSON.stringify((bun.j.appointments||[]).map(a=>a.type)));
const room=appt.id;
// signalling relay
const pj=await call(amaka,'POST','/api/video/'+room+'/join'); E('patient joins room -> role patient + ICE servers',pj.s===200&&pj.j.role==='patient'&&Array.isArray(pj.j.iceServers)&&pj.j.iceServers.length>0,JSON.stringify({s:pj.s,role:pj.j.role}));
const dj=await call(kunle,'POST','/api/video/'+room+'/join'); E('assigned doctor joins room -> role doctor',dj.s===200&&dj.j.role==='doctor',JSON.stringify({s:dj.s,role:dj.j.role}));
await call(amaka,'POST','/api/video/'+room+'/signal',{kind:'offer',data:{sdp:'x'}});
const poll=await call(kunle,'GET','/api/video/'+room+'/poll?since=0'); E('doctor polls and receives the patient offer',poll.j.signals.some(s=>s.kind==='offer'&&s.from==='patient'));
const selfPoll=await call(amaka,'GET','/api/video/'+room+'/poll?since=0'); E('sender does NOT receive its own signals',!selfPoll.j.signals.some(s=>s.from==='patient'));
// access control + time gate
const other=await login('tobi@demo.ng'); E('an unrelated patient is blocked from the room',(await call(other,'POST','/api/video/'+room+'/join')).s===403);
const future=(bun.j.appointments||[]).find(a=>a.type==='video'&&a.scheduledAt>Date.now()+20*60000);
if(future) E('joining a not-yet-due visit is blocked (425)',(await call(amaka,'POST','/api/video/'+future.id+'/join')).s===425);

// REAL peer connection with fake media (two Chromium contexts, host candidates on loopback)
let pw; try{ pw=require('playwright'); }catch(e){ console.log('  SKIP  browser P2P test (playwright not installed)'); }
if(pw){
  const b=await pw.chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required']});
  const mkPeer=async(token)=>{ const ctx=await b.newContext(); const p=await ctx.newPage();
    await p.goto(BASE+'/'); // same-origin so fetch works
    const res=await p.evaluate(async ({base,token,room})=>{
      // inline the connection using the same signalling API
      const H=t=>({Authorization:'Bearer '+t});
      const join=await (await fetch(base+'/api/video/'+room+'/join',{method:'POST',headers:{'Content-Type':'application/json',...H(token)},body:'{}'})).json();
      const stream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
      const pc=new RTCPeerConnection({iceServers:join.iceServers});
      stream.getTracks().forEach(t=>pc.addTrack(t,stream));
      let since=0, made=false, gotRemote=false;
      pc.onicecandidate=e=>{ if(e.candidate) fetch(base+'/api/video/'+room+'/signal',{method:'POST',headers:{'Content-Type':'application/json',...H(token)},body:JSON.stringify({kind:'candidate',data:e.candidate})}); };
      pc.ontrack=e=>{ gotRemote=true; };
      async function offer(){ if(made)return; made=true; const o=await pc.createOffer(); await pc.setLocalDescription(o); await fetch(base+'/api/video/'+room+'/signal',{method:'POST',headers:{'Content-Type':'application/json',...H(token)},body:JSON.stringify({kind:'offer',data:o})}); }
      async function loop(){ for(let i=0;i<25;i++){ const r=await (await fetch(base+'/api/video/'+room+'/poll?since='+since,{headers:H(token)})).json(); since=r.since;
        for(const s of r.signals){ try{ if(s.kind==='offer'){ await pc.setRemoteDescription(s.data); const a=await pc.createAnswer(); await pc.setLocalDescription(a); await fetch(base+'/api/video/'+room+'/signal',{method:'POST',headers:{'Content-Type':'application/json',...H(token)},body:JSON.stringify({kind:'answer',data:a})}); } else if(s.kind==='answer'){ if(!pc.currentRemoteDescription) await pc.setRemoteDescription(s.data); } else if(s.kind==='candidate'){ try{await pc.addIceCandidate(s.data);}catch(e){} } }catch(e){} }
        if(join.role==='patient'&&r.peerPresent&&!made) await offer();
        if(pc.connectionState==='connected') break; await new Promise(r=>setTimeout(r,400)); }
        return {state:pc.connectionState, ice:pc.iceConnectionState, gotRemote}; }
      if(join.role==='patient') setTimeout(offer,800);
      return await loop();
    },{base:BASE, token, room});
    return {ctx,res}; };
  const [P,D]=await Promise.all([mkPeer(amaka), mkPeer(kunle)]);
  const connected=(P.res.state==='connected'||P.res.ice==='connected'||P.res.ice==='completed')&&(D.res.state==='connected'||D.res.ice==='connected'||D.res.ice==='completed');
  E('REAL WebRTC peer connection establishes (both peers connected)',connected,JSON.stringify({patient:P.res,doctor:D.res}));
  E('each peer receives the other\'s media track',P.res.gotRemote&&D.res.gotRemote,JSON.stringify({p:P.res.gotRemote,d:D.res.gotRemote}));
  await b.close();
}
console.log('\nVIDEO: '+ok+' passed, '+bad+' failed');
}catch(e){console.error('ERR',e.message,e.stack);bad++}finally{srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}})();
