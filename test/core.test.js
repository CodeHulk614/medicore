'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

let h;
before(async () => { h = await boot({ patientMode: 'open' }); });
after(async () => { await h.close(); });

test('health reports ok and memory db', async () => {
  const r = await h.client('patient').get('/api/health');
  assert.equal(r.status, 200); assert.equal(r.body.db, 'memory');
});

test('mutations without the app header are refused (CSRF guard)', async () => {
  const r = await fetch(h.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'x@y.z', password: 'x' }) });
  assert.equal(r.status, 403);
});

test('wrong password gives one generic message, then locks after 5 tries', async () => {
  const c = h.client('frontdesk');
  for (let i = 0; i < 5; i++) { const r = await c.post('/api/auth/login', { identifier: 'cashier@clearpath.demo', password: 'Wrong1234' }); assert.equal(r.status, 401); assert.match(r.body.error, /Wrong email\/phone or password/); }
  const r = await c.post('/api/auth/login', { identifier: 'cashier@clearpath.demo', password: h.ctx.password });
  assert.equal(r.status, 401); assert.match(r.body.error, /Too many failed attempts/);
  const r2 = await c.post('/api/auth/login', { identifier: 'nobody@nowhere.demo', password: 'Wrong1234' });
  assert.equal(r2.status, 401); assert.match(r2.body.error, /Wrong email\/phone or password/);
});

test('a role can only sign into its own app', async () => {
  const r = await h.client('admin').post('/api/auth/login', { identifier: 'rider@grandville.demo', password: h.ctx.password });
  assert.equal(r.status, 403);
  const r2 = await h.client('patient').post('/api/auth/login', { identifier: 'reception@grandville.demo', password: h.ctx.password });
  assert.equal(r2.status, 403);
});

test('a doctor at two providers is asked to choose', async () => {
  const c = h.client('doctor');
  const r = await c.post('/api/auth/login', { identifier: 'dr.bisi@grandville.demo', password: h.ctx.password });
  assert.equal(r.status, 200); assert.equal(r.body.chooseOrg.length, 2);
  await c.login('dr.bisi@grandville.demo', undefined, h.ctx.orgs.clinic.id);
  const me = await c.get('/api/auth/me'); assert.equal(me.body.org.id, h.ctx.orgs.clinic.id); assert.equal(me.body.otherOrgs.length, 1);
});

test('front desk sees only its own provider\'s patients', async () => {
  const hosp = await h.as('frontdesk', 'reception@grandville.demo');
  const clin = await h.as('frontdesk', 'reception@lekkifamily.demo');
  const zainab = h.ctx.patients.zainab.id;          // linked to hospital + ambulance, NOT the clinic
  assert.equal((await hosp.get('/api/fd/patients/' + zainab)).status, 200);
  assert.equal((await clin.get('/api/fd/patients/' + zainab)).status, 404);
  const list = await clin.get('/api/fd/patients');
  assert.ok(!list.body.some(p => p.id === zainab));
});

test('front desk links an existing MediCore patient only with the patient\'s SMS code', async () => {
  const amb = await h.as('frontdesk', 'callcentre@swiftaid.demo');
  const tobiPhone = h.ctx.patients.tobi.phone;
  const r = await amb.post('/api/fd/patients/lookup', { phone: tobiPhone });
  assert.equal(r.body.status, 'exists_elsewhere'); assert.ok(!r.body.patient, 'no details leak before consent');
  const bad = await amb.post('/api/fd/patients/link', { phone: tobiPhone, code: '000000' });
  assert.equal(bad.status, 400);
  const ok = await amb.post('/api/fd/patients/link', { phone: tobiPhone, code: r.body.devCode });
  assert.equal(ok.status, 200); assert.equal(ok.body.patient.firstName, 'Tobi');
});

test('registering a phone that already exists is refused (use link instead)', async () => {
  const fd = await h.as('frontdesk', 'reception@lekkifamily.demo');
  const r = await fd.post('/api/fd/patients', { firstName: 'X', lastName: 'Y', phone: h.ctx.patients.tobi.phone, consent: true });
  assert.equal(r.status, 409);
});

test('patient self-registration claims a record a provider created', async () => {
  const fd = await h.as('frontdesk', 'reception@lekkifamily.demo');
  const reg = await fd.post('/api/fd/patients', { firstName: 'Nkem', lastName: 'Obi', dob: '1999-01-01', sex: 'female', phone: '08061112222', consent: true, noKnownAllergies: true, nin: '22223334445' });
  assert.equal(reg.status, 200);
  const pc = h.client('patient');
  const s = await pc.post('/api/patients/register/start', { phone: '08061112222' });
  assert.equal(s.status, 200); assert.ok(s.body.devCode);
  const done = await pc.post('/api/patients/register', { phone: '08061112222', code: s.body.devCode, firstName: 'Nkem', lastName: 'Obi', password: 'Strong2026pw', consent: true, nin: '22223334445' });
  assert.equal(done.status, 200); assert.equal(done.body.patientId, reg.body.patient.id);
  const prov = await pc.get('/api/me/providers');
  assert.equal(prov.body.length, 1); assert.equal(prov.body[0].name, 'Lekki Family Clinic');
});

test('weak passwords are refused', async () => {
  const pc = h.client('patient');
  const s = await pc.post('/api/patients/register/start', { phone: '08069998888' });
  const r = await pc.post('/api/patients/register', { phone: '08069998888', code: s.body.devCode, firstName: 'A', lastName: 'B', password: 'demo1234', consent: true });
  assert.equal(r.status, 400);
});

test('input validation: unknown fields are ignored, bad types give 400, never a crash', async () => {
  const fd = await h.as('frontdesk', 'reception@grandville.demo');
  const r = await fd.post('/api/fd/patients', { firstName: { $ne: 1 }, lastName: 'Y', consent: true });
  assert.equal(r.status, 400);
  const r2 = await fetch(h.base + '/api/fd/patients', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MC-App': 'frontdesk', Cookie: Object.entries(fd.cookies).map(([k, v]) => k + '=' + v).join('; ') }, body: '{bad json' });
  assert.equal(r2.status, 400);
  const body = await r2.json(); assert.ok(!JSON.stringify(body).includes('/home/'), 'no stack trace or file paths');
  const health = await h.client('patient').get('/api/health'); assert.equal(health.status, 200);
});

test('staff escalation is blocked', async () => {
  const mgr = await h.as('admin', 'admin@grandville.demo');
  const list = await mgr.get('/api/admin/staff');
  const me = list.body.staff.find(s => s.email === 'admin@grandville.demo');
  const owner = list.body.staff.find(s => s.isOwner);
  assert.equal((await mgr.patch('/api/admin/staff/' + me.id, { extraPerms: ['admin.finance'] })).status, 403, 'cannot edit self');
  assert.equal((await mgr.patch('/api/admin/staff/' + owner.id, { status: 'suspended' })).status, 403, 'cannot touch owner');
  assert.equal((await mgr.post('/api/admin/staff', { name: 'Evil', email: 'evil@x.demo', role: 'admin' })).status, 403, 'only owner adds admins');
  assert.equal((await mgr.post('/api/admin/staff', { name: 'Evil2', email: 'evil2@x.demo', role: 'cashier', extraPerms: ['payer.pay'] })).status, 403, 'cannot grant perms not held');
  assert.equal((await mgr.post('/api/admin/staff', { name: 'Payer', email: 'p@x.demo', role: 'payer_officer' })).status, 400, 'payer role not for a hospital');
});

test('suspending a staff member ends their access on the next request', async () => {
  const owner = await h.as('admin', 'owner@clearpath.demo');
  const cash = await h.as('frontdesk', 'cashier@clearpath.demo', { password: h.ctx.password }).catch(() => null);
  // cashier@clearpath was locked by the lockout test; use the reception account instead
  const rec = await h.as('lab', 'reception@clearpath.demo');
  assert.equal((await rec.get('/api/auth/me')).status, 200);
  const list = await owner.get('/api/admin/staff');
  const target = list.body.staff.find(s => s.email === 'reception@clearpath.demo');
  assert.equal((await owner.patch('/api/admin/staff/' + target.id, { status: 'suspended' })).status, 200);
  const after = await rec.get('/api/auth/me');
  assert.equal(after.status, 401);
  void cash;
});

test('new staff get a temporary password and must change it before doing anything', async () => {
  const owner = await h.as('admin', 'owner@yabacare.demo');
  const r = await owner.post('/api/admin/staff', { name: 'New Tech', email: 'newtech@yabacare.demo', role: 'pharmacy_tech' });
  assert.equal(r.status, 200); assert.ok(r.body.tempPassword);
  const c = h.client('pharmacy'); await c.login('newtech@yabacare.demo', r.body.tempPassword);
  const blocked = await c.get('/api/shift/me'); assert.equal(blocked.status, 423); assert.equal(blocked.body.code, 'password_change_required');
  assert.equal((await c.post('/api/auth/password', { current: r.body.tempPassword, next: 'NewTech2026x' })).status, 200);
  assert.equal((await c.get('/api/shift/me')).status, 200);
});

test('clock-in is required for operational writes', async () => {
  const cash = await h.as('frontdesk', 'cashier@grandville.demo', { clockIn: false });
  const r = await cash.post('/api/bills', { patientId: h.ctx.patients.amaka.id, items: [{ serviceCode: 'CONS-GP' }] });
  assert.equal(r.status, 423); assert.equal(r.body.code, 'clock_in_required');
});

test('billing: price comes from the price list, cash recorded once, receipt numbers unique', async () => {
  const cash = await h.as('frontdesk', 'cashier@grandville.demo');
  const b = await cash.post('/api/bills', { patientId: h.ctx.patients.amaka.id, items: [{ serviceCode: 'CONS-GP', qty: 1 }], totalKobo: 1 });
  assert.equal(b.status, 200); assert.equal(b.body.totalKobo, 800000);
  const custom = await cash.post('/api/bills', { patientId: h.ctx.patients.amaka.id, customItems: [{ name: 'Anything', unitPriceKobo: -5000 }] });
  assert.equal(custom.status, 400);
  const p1 = await cash.post('/api/bills/' + b.body.id + '/cash', { method: 'pos', amountKobo: 800000, receiptNo: 'R-1' });
  assert.equal(p1.status, 200); assert.equal(p1.body.status, 'paid');
  const p2 = await cash.post('/api/bills/' + b.body.id + '/cash', { method: 'pos', amountKobo: 800000, receiptNo: 'R-2' });
  assert.equal(p2.status, 409);
  const other = await cash.post('/api/bills', { patientId: h.ctx.patients.zainab.id, items: [{ serviceCode: 'REG' }] });
  const dup = await cash.post('/api/bills/' + other.body.id + '/cash', { method: 'pos', amountKobo: other.body.totalKobo, receiptNo: 'R-1' });
  assert.equal(dup.status, 409);
});

test('billing: a patient pays online exactly once (demo mode)', async () => {
  const cash = await h.as('frontdesk', 'cashier@grandville.demo');
  const b = await cash.post('/api/bills', { patientId: h.ctx.patients.amaka.id, items: [{ serviceCode: 'REG' }] });
  const pat = await h.as('patient', 'amaka@patient.demo');
  const init = await pat.post('/api/me/bills/' + b.body.id + '/pay');
  assert.equal(init.status, 200); assert.equal(init.body.mode, 'demo');
  const [a, c] = await Promise.all([pat.post('/api/pay/demo/' + init.body.paymentId + '/complete'), pat.post('/api/pay/demo/' + init.body.paymentId + '/complete')]);
  assert.equal(a.status, 200); assert.equal(c.status, 200);
  const bills = await pat.get('/api/me/bills'); const mine = bills.body.find(x => x.id === b.body.id);
  assert.equal(mine.status, 'paid'); assert.equal(mine.paidKobo, b.body.totalKobo);
});

test('patient cannot see another patient\'s bill', async () => {
  const cash = await h.as('frontdesk', 'cashier@grandville.demo');
  const b = await cash.post('/api/bills', { patientId: h.ctx.patients.tobi.id, items: [{ serviceCode: 'REG' }] });
  const amaka = await h.as('patient', 'amaka@patient.demo');
  assert.equal((await amaka.post('/api/me/bills/' + b.body.id + '/pay')).status, 404);
});

test('patient data export and sharing switch', async () => {
  const pat = await h.as('patient', 'amaka@patient.demo');
  const ex = await pat.get('/api/me/export'); assert.equal(ex.status, 200); assert.equal(ex.body.profile.firstName, 'Amaka');
  const prov = await pat.get('/api/me/providers'); assert.ok(prov.body.length >= 3);
  const r = await pat.post('/api/me/providers/' + h.ctx.orgs.clinic.id + '/share', { share: true }); assert.equal(r.body.shareHistory, true);
});

test('provider signup is pending until approved, and its owner cannot sign in yet', async () => {
  const c = h.client('admin');
  const r = await c.post('/api/orgs/signup', { type: 'pharmacy', name: 'Test Pharmacy Ltd', contact: { phone: '08051230000', email: 'tp@test.demo', address: '1 Test St' }, owner: { name: 'T Owner', email: 'towner@test.demo', phone: '08051230001', password: 'Owner2026x' }, acceptTerms: true });
  assert.equal(r.status, 200); assert.equal(r.body.org.status, 'pending');
  const l = await c.post('/api/auth/login', { identifier: 'towner@test.demo', password: 'Owner2026x' });
  assert.equal(l.status, 403); assert.match(l.body.error, /awaiting MediCore approval/);
});
