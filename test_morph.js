const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs=require('fs');
const PORT=4967,BASE='http://localhost:'+PORT,DB='/tmp/morph.json';try{fs.unlinkSync(DB)}catch(e){}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ok=0,bad=0;const E=(n,c,x)=>{console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':' -> '+x));c?ok++:bad++};
async function tok(e){return (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:'demo1234'})})).json()).token}
(async()=>{const srv=spawn('node',['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(PORT),DB_FILE:DB,JWT_SECRET:'m',DISABLE_OSRM:'1'},stdio:['ignore','ignore','ignore']});let b;
try{for(let i=0;i<40;i++){try{if((await fetch(BASE+'/api/health')).ok)break}catch(e){}await sleep(200)}
b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
// morph unit test in the page
const ctx=await b.newContext(); const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto(BASE+'/refresh.js'); // ensure served
await p.goto(BASE+'/'); await p.addScriptTag({url:'/refresh.js'});
const r=await p.evaluate(()=>{
  const host=document.createElement('div'); host.id='mtest'; document.body.appendChild(host);
  mcMorph(host,'<div class="a"><p id="keepme">one</p><input id="fld" value="x"><div id="map" data-keep></div></div>');
  const p1=document.getElementById('keepme'); const map=document.getElementById('map');
  map.appendChild(document.createTextNode('LEAFLET-CHILD')); // simulate a live map child
  document.getElementById('fld').focus(); document.getElementById('fld').value='typed';
  // now re-morph with changed text + same structure
  mcMorph(host,'<div class="a"><p id="keepme">two</p><input id="fld" value="x"><div id="map" data-keep></div></div>');
  const p2=document.getElementById('keepme');
  return {
    samePara: p1===p2,                                  // node preserved (not recreated)
    textUpdated: p2.textContent==='two',                // text changed in place
    mapChildKept: document.getElementById('map').textContent.includes('LEAFLET-CHILD'), // data-keep protected
    focusKept: document.activeElement && document.activeElement.id==='fld', // focus preserved
    typedKept: document.getElementById('fld').value==='typed'               // typed value not clobbered
  };
});
E('morph preserves an unchanged node (no full rebuild)', r.samePara);
E('morph updates changed text in place', r.textUpdated);
E('morph never touches data-keep subtrees (maps/video safe)', r.mapChildKept);
E('morph preserves focus on the field being typed in', r.focusKept);
E('morph does not clobber a value being typed', r.typedKept);
E('no JS errors', errs.length===0, errs[0]);
await ctx.close();
console.log('\nMORPH: '+ok+' passed, '+bad+' failed');
}catch(e){console.error('ERR',e.message);bad++}finally{if(b)await b.close();srv.kill('SIGKILL');try{fs.unlinkSync(DB)}catch(e){};process.exit(bad?1:0)}})();
