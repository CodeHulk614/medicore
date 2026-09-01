const { spawn } = require('child_process');
const fs = require('fs');
try { fs.unlinkSync('./data/db.json'); } catch(e){}
require('./seed')(true);
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT: '4055' } });
const base = 'http://localhost:4055';
const J = (r) => r.json();
async function post(p, body, tok){ return fetch(base+p, { method:'POST', headers:{'Content-Type':'application/json', ...(tok?{Authorization:'Bearer '+tok}:{})}, body: JSON.stringify(body) }).then(J); }
async function get(p, tok){ return fetch(base+p, { headers: tok?{Authorization:'Bearer '+tok}:{} }).then(J); }
(async () => {
  for (let i=0;i<30;i++){ try{ await get('/api/health'); break; }catch(e){ await new Promise(r=>setTimeout(r,150)); } }
  const results = [];
  const p = await post('/api/auth/login', { email:'amaka@demo.ng', password:'demo1234' });
  const PTOK = p.token;
  await post('/api/marketplace/book', { doctorId:'doc_ada', type:'video', time:'11:30' }, PTOK);
  const a = await post('/api/auth/login', { email:'ada@demo.ng', password:'demo1234' });
  const ATOK = a.token;
  const me = await get('/api/doc/me', ATOK);
  results.push(['doctor profile loads', me.doctor && me.doctor.name === 'Dr. Ada Nwosu']);
  const sched = await get('/api/doc/schedule', ATOK);
  results.push(['doctor sees patient booking', Array.isArray(sched) && sched.some(x=>x.patientId==='p_amaka' && x.type==='video')]);
  const reply = await post('/api/doc/reply', { patientId:'p_amaka', text:'Book a follow-up in 2 weeks.' }, ATOK);
  results.push(['doctor reply attributed to doctor', reply.who === 'Dr. Ada Nwosu']);
  const bundle = await get('/api/me/bundle', PTOK);
  const last = bundle.messages[bundle.messages.length-1];
  results.push(['patient sees the reply', last.text === 'Book a follow-up in 2 weeks.' && last.who === 'Dr. Ada Nwosu']);
  const done = await post('/api/doc/appointments/'+sched[sched.length-1].id+'/complete', { reason:'Cardiology review' }, ATOK);
  results.push(['appointment marked complete', done.status === 'completed']);
  const av = await post('/api/doc/availability', { available:false }, ATOK);
  results.push(['availability toggles', av.available === false]);
  console.log('\nDOCTOR APP LOOP:');
  results.forEach(([n,ok]) => console.log('  ' + (ok?'PASS':'FAIL') + '  ' + n));
  console.log('\n' + (results.every(r=>r[1]) ? 'ALL PASS' : 'SOME FAILED'));
  srv.kill();
  process.exit(0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
