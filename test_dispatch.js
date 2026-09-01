'use strict';
/* Dispatch/AVL end-to-end: tenancy, address pickup, AUTOMATIC progression, patient tracking. */
const { spawn } = require('child_process');
const path = require('path'); const fs = require('fs');
const PORT = 4917, BASE = 'http://localhost:' + PORT;
const DB = path.join(__dirname, 'data', 'test_dispatch_db.json');
try { fs.unlinkSync(DB); } catch (e) {}
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  -> ' + x : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(token, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; } return { status: r.status, body: j };
}
const login = async e => (await api(null, 'POST', '/api/auth/login', { email: e, password: 'demo1234' })).body.token;

(async () => {
  // fast movement + short dwell so a whole run auto-completes in a few seconds, routing disabled (offline straight-line)
  const srv = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT), DB_FILE: DB, JWT_SECRET: 'test', DISPATCH_SPEED_KMH: '6000', DISPATCH_LOAD_MS: '600', DISPATCH_HANDOVER_MS: '600', DISABLE_OSRM: '1' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await sleep(200); }
    const disp = await login('dispatch@demo.ng');     // Grandville
    const disp2 = await login('dispatch2@demo.ng');   // Riverside
    const crew = await login('crew@demo.ng');
    const admin = await login('admin@demo.ng');       // Grandville admin
    const pat = await login('amaka@demo.ng');
    ok('all roles log in (incl Riverside dispatch)', disp && disp2 && crew && admin && pat);

    // ---- TENANCY: each dispatcher sees only their own hospital ----
    let g = (await api(disp, 'GET', '/api/dispatch/board')).body;
    let r = (await api(disp2, 'GET', '/api/dispatch/board')).body;
    ok('Grandville board is scoped to Grandville', g.units.every(u => u.hospitalId === 'h_grand') && g.hospitalName.includes('Grandville'));
    ok('Riverside board is scoped to Riverside', r.units.every(u => u.hospitalId === 'h_river') && r.hospitalName.includes('Riverside'));
    ok('map shows ONLY the own hospital', g.hospitals.length === 1 && g.hospitals[0].id === 'h_grand');
    ok('Grandville does not see the other hospital units', !g.units.some(u => u.hospitalId === 'h_river'));

    // ---- ADDRESS + SOS: patient summons from a chosen hospital, pickup = home ----
    const hosps = (await api(pat, 'GET', '/api/patient/hospitals')).body;
    ok('patient sees their registered hospitals', Array.isArray(hosps) && hosps.length >= 1);
    // update home address (coords from a dropped pin)
    await api(pat, 'POST', '/api/patient/address', { address: '20 Bode Thomas, Surulere', lat: 6.498, lng: 3.353 });
    const sos = await api(pat, 'POST', '/api/patient/sos', { kind: 'Chest pain', hospitalId: 'h_grand' });
    ok('patient SOS to their hospital creates a case at home coords', sos.status === 200 && sos.body.case.lat === 6.498);
    const caseId = sos.body.case.id;

    // patient cannot summon a hospital they are NOT registered with
    const bad = await api(pat, 'POST', '/api/patient/sos', { kind: 'Test', hospitalId: 'h_nope' });
    ok('patient blocked from summoning an unregistered hospital', bad.status === 403);

    // case is visible to Grandville dispatch, NOT Riverside
    g = (await api(disp, 'GET', '/api/dispatch/board')).body;
    r = (await api(disp2, 'GET', '/api/dispatch/board')).body;
    ok('SOS case shows on the correct hospital board', g.cases.some(c => c.id === caseId));
    ok('SOS case hidden from the other hospital', !r.cases.some(c => c.id === caseId));

    // ---- ASSIGN: only same-hospital units; goes straight to en route (auto-roll) ----
    const asg = await api(disp, 'POST', '/api/dispatch/cases/' + caseId + '/assign', {});
    ok('assign auto-rolls the unit to EN ROUTE (no manual confirm)', asg.body.unit.status === 'enroute', JSON.stringify(asg.body));
    const unitId = asg.body.unit.id;
    ok('assigned unit belongs to the case hospital', asg.body.unit.hospitalId === 'h_grand');
    ok('unit carries a route to follow', Array.isArray(asg.body.unit.route) && asg.body.unit.route.length >= 2);

    // patient is notified + can track live
    let trk = (await api(pat, 'GET', '/api/patient/track')).body;
    ok('patient can track the inbound ambulance live', trk.active && trk.unit && trk.unit.id === unitId);

    // ---- AUTOMATIC progression: no manual taps from here ----
    let sawOnscene = false, sawTransport = false, sawArrived = false, sawFreed = false;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const b = (await api(disp, 'GET', '/api/dispatch/board')).body;
      const u = b.units.find(x => x.id === unitId);
      const c = (b.cases.find(x => x.id === caseId)) || (b.recent.find(x => x.id === caseId));
      if (u.status === 'onscene') sawOnscene = true;
      if (u.status === 'transporting') sawTransport = true;
      if (u.status === 'athospital' || (c && c.status === 'arrived')) sawArrived = true;
      if (u.status === 'available') { sawFreed = true; break; }
    }
    ok('AUTO: unit reached the scene on its own', sawOnscene);
    ok('AUTO: unit began transport on its own (no button)', sawTransport);
    ok('AUTO: unit arrived at hospital on its own', sawArrived);
    ok('AUTO: run auto-cleared and unit returned to base available', sawFreed);

    // receiving hospital got the inbound alert during the auto run
    const adminN = (await api(admin, 'GET', '/api/notifications')).body;
    ok('receiving hospital got the INBOUND ETA alert', adminN.items.some(n => /INBOUND/i.test(n.text) && /ETA/i.test(n.text)));

    // patient tracking clears once the run is closed
    trk = (await api(pat, 'GET', '/api/patient/track')).body;
    ok('patient tracking clears after the run closes', trk.active === false);

    console.log('\n============ DISPATCH TEST ============');
    console.log('PASS ' + pass + '   FAIL ' + fail);
    console.log('======================================');
  } catch (e) { console.error('ERROR', e); fail++; }
  finally { srv.kill(); try { fs.unlinkSync(DB); } catch (e) {} process.exit(fail ? 1 : 0); }
})();
