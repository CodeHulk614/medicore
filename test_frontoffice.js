'use strict';
/* Front office: sub-role permission scoping, clock-in + geofence, intake -> doctor queue. */
const { spawn } = require('child_process'); const path = require('path'); const fs = require('fs');
const PORT = 4959, BASE = 'http://localhost:' + PORT, DB = path.join(__dirname, 'data', 'fo_db.json');
try { fs.unlinkSync(DB); } catch (e) {}
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? ' -> ' + x : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(t, m, u, b) { const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); const x = await r.text(); let j; try { j = JSON.parse(x); } catch (e) { j = x; } return { status: r.status, body: j }; }
const login = async e => (await api(null, 'POST', '/api/auth/login', { email: e, password: 'demo1234' })).body.token;

(async () => {
  const srv = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT), DB_FILE: DB, JWT_SECRET: 'fo', DISABLE_OSRM: '1' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await sleep(200); }
    const recept = await login('reception@demo.ng');
    const cashier = await login('cashier@demo.ng');
    const cs = await login('cs@demo.ng');
    const mgr = await login('frontdesk@demo.ng');
    const doc = await login('tunde@demo.ng');
    const recept2 = await login('reception2@demo.ng'); // Riverside
    ok('all front-office roles + doctor log in', recept && cashier && cs && mgr && doc && recept2);

    // ---- PERMISSION SCOPING ----
    ok('receptionist CAN read patients', (await api(recept, 'GET', '/api/frontdesk/patients')).status === 200);
    ok('receptionist CANNOT touch billing', (await api(recept, 'POST', '/api/frontdesk/bill', { patientId: 'p_amaka', amount: 1000 })).status === 403);
    ok('receptionist CANNOT open CS log', (await api(recept, 'GET', '/api/frontdesk/cs')).status === 403);
    ok('cashier CAN verify cover', (await api(cashier, 'GET', '/api/frontdesk/cover/p_amaka')).status === 200);
    ok('cashier CANNOT check in a patient', (await api(cashier, 'POST', '/api/frontdesk/checkin', { patientId: 'p_amaka' })).status === 403);
    ok('customer success CAN read CS log', (await api(cs, 'GET', '/api/frontdesk/cs')).status === 200);
    ok('customer success CANNOT register a patient', (await api(cs, 'POST', '/api/frontdesk/register', { first: 'X', last: 'Y' })).status === 403);
    ok('manager CAN see who is on duty (shift.view)', (await api(mgr, 'GET', '/api/shift/onduty')).status === 200);
    ok('receptionist CANNOT see who is on duty', (await api(recept, 'GET', '/api/shift/onduty')).status === 403);

    // ---- CLOCK-IN + GEOFENCE ----
    // Grandville is at lat 6.499, lng 3.354. Clock in from on-site coords.
    const ci = await api(recept, 'POST', '/api/shift/clockin', { lat: 6.4991, lng: 3.3541, accuracy: 12 });
    ok('clock-in records a shift with time', ci.status === 200 && ci.body.shift && ci.body.shift.clockIn > 0);
    ok('clock-in geofence marks ON-SITE near the hospital', ci.body.shift.onSite === true, JSON.stringify(ci.body.shift));
    const meShift = await api(recept, 'GET', '/api/shift/me');
    ok('shift/me shows the open shift', meShift.body.open && !meShift.body.open.clockOut);
    // off-site clock-in for the cashier (far away)
    const ciFar = await api(cashier, 'POST', '/api/shift/clockin', { lat: 6.6, lng: 3.6, accuracy: 20 });
    ok('off-site clock-in flagged NOT on-site', ciFar.body.shift.onSite === false, JSON.stringify(ciFar.body.shift));
    // manager sees both on duty
    const onduty = await api(mgr, 'GET', '/api/shift/onduty');
    ok('manager sees clocked-in staff on duty', Array.isArray(onduty.body) && onduty.body.length >= 2);
    // clock out
    ok('clock-out closes the shift', (await api(recept, 'POST', '/api/shift/clockout')).body.shift.clockOut > 0);

    // ---- INTAKE -> DOCTOR QUEUE (the handoff) ----
    const before = (await api(doc, 'GET', '/api/doc/queue')).body.length; // seeded waiting patients
    ok('doctor sees the seeded waiting room', before >= 2);
    const chk = await api(recept, 'POST', '/api/frontdesk/checkin', { patientId: 'p_amaka', complaint: 'Headache and fever', priority: 'urgent', vitals: { bp: '120/80', temp: '38.5' }, dept: 'General OPD' });
    ok('receptionist checks a patient in (gets a token)', chk.status === 200 && /^A\d\d$/.test(chk.body.token), JSON.stringify(chk.body));
    const qId = chk.body.id;
    const docQ = await api(doc, 'GET', '/api/doc/queue');
    ok('checked-in patient appears in the doctor waiting room', docQ.body.some(e => e.id === qId && e.patient.includes('Amaka')));
    ok('the doctor sees the triage vitals + complaint', docQ.body.find(e => e.id === qId).vitals.temp === '38.5');
    const start = await api(doc, 'POST', '/api/doc/queue/' + qId + '/start');
    ok('doctor starts the consultation (takes over)', start.body.status === 'in_progress' && start.body.doctor);
    const done = await api(doc, 'POST', '/api/doc/queue/' + qId + '/done');
    ok('doctor completes it (creates a visit)', done.body.status === 'done');

    // ---- TENANCY: Riverside receptionist cannot see Grandville queue ----
    const rq = await api(recept2, 'GET', '/api/frontdesk/queue');
    ok('Riverside front desk does NOT see Grandville queue', rq.status === 200 && !rq.body.some(e => e.patient.includes('Tobi')));

    // ---- DASHBOARD ----
    const ov = await api(mgr, 'GET', '/api/frontdesk/overview');
    ok('dashboard returns today counts + role + on-duty', ov.status === 200 && ov.body.today && ov.body.me.roleLabel && Array.isArray(ov.body.onDuty));
    const ovR = await api(recept, 'GET', '/api/frontdesk/overview');
    ok('receptionist dashboard omits on-duty (no shift.view)', ovR.status === 200 && ovR.body.onDuty === undefined);

    // ---- UNIFIED ADMIN-SIDE PERMISSIONS ----
    const admin = await login('admin@demo.ng');
    ok('hospital admin CAN view settlements', (await api(admin, 'GET', '/api/admin/settlements')).status === 200);
    ok('hospital admin CAN verify doctors list', (await api(admin, 'GET', '/api/admin/doctors')).status === 200);
    const aov = await api(admin, 'GET', '/api/admin/overview');
    ok('admin overview now returns the caller permissions', aov.status === 200 && Array.isArray(aov.body.permissions) && aov.body.permissions.includes('admin.settlements'));
    // manager gets a defined admin SLICE
    ok('manager CAN view the hospital dashboard (admin.overview)', (await api(mgr, 'GET', '/api/admin/overview')).status === 200);
    ok('manager CAN manage staff (admin.staff)', (await api(mgr, 'GET', '/api/admin/staff')).status === 200);
    ok('manager CANNOT touch settlements (no admin.settlements)', (await api(mgr, 'GET', '/api/admin/settlements')).status === 403);
    ok('manager CANNOT verify doctors (no admin.doctors)', (await api(mgr, 'GET', '/api/admin/doctors')).status === 403);
    // receptionist has NO admin access at all
    ok('receptionist CANNOT open the hospital dashboard', (await api(recept, 'GET', '/api/admin/overview')).status === 403);
    ok('receptionist CANNOT manage staff', (await api(recept, 'GET', '/api/admin/staff')).status === 403);

    console.log('\n========== FRONT OFFICE TEST ==========');
    console.log('PASS ' + pass + '   FAIL ' + fail);
    console.log('=======================================');
  } catch (e) { console.error('ERROR', e); fail++; }
  finally { srv.kill(); try { fs.unlinkSync(DB); } catch (e) {} process.exit(fail ? 1 : 0); }
})();
