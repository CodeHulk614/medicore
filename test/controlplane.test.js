'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

let h, hq, dev;
before(async () => { h = await boot({ patientMode: 'open' }); hq = await h.as('hq', 'hq@medicore.demo'); dev = await h.as('hq', 'dev@medicore.demo'); });
after(async () => { await h.close(); });

test('apps read branding, content and features without signing in', async () => {
  const r = await h.client('doctor').get('/api/meta/config');
  assert.equal(r.status, 200); assert.equal(r.body.branding.app.title, 'MediCore Doctor'); assert.ok(r.body.features);
  assert.ok(!JSON.stringify(r.body).includes('secretKey'));
});

test('only the MediCore team can read or change platform settings', async () => {
  const admin = await h.as('admin', 'owner@grandville.demo');
  assert.equal((await admin.get('/api/hq/config')).status, 403);
  assert.equal((await h.client('hq').get('/api/hq/config')).status, 401);
});

test('branding change applies immediately and is versioned', async () => {
  const cur = await hq.get('/api/hq/config');
  const r = await hq.patch('/api/hq/config/branding', { patch: { productName: 'MediCore NG', apps: { doctor: { hue: '#224488', title: 'Doctor Desk' } } }, expectVersion: cur.body.version, note: 'rebrand' });
  assert.equal(r.status, 200); assert.ok(r.body.changed.includes('branding.apps.doctor.hue'));
  const pub = await h.client('doctor').get('/api/meta/config');
  assert.equal(pub.body.branding.app.title, 'Doctor Desk'); assert.equal(pub.body.branding.productName, 'MediCore NG');
  const stale = await hq.patch('/api/hq/config/branding', { patch: { productName: 'X' }, expectVersion: cur.body.version });
  assert.equal(stale.status, 409);
  const bad = await hq.patch('/api/hq/config/branding', { patch: { apps: { doctor: { hue: 'red' } } } });
  assert.equal(bad.status, 400);
});

test('history and restore', async () => {
  const hist = await hq.get('/api/hq/config/history');
  assert.ok(hist.body.length >= 1);
  const first = hist.body[hist.body.length - 1];
  const r = await hq.post('/api/hq/config/restore', { version: first.version });
  assert.equal(r.status, 200);
});

test('integration keys: only the owner can set them, and they are never shown back', async () => {
  assert.equal((await dev.patch('/api/hq/config/integrations', { patch: { paystack: { secretKey: 'sk_test_abc123' } } })).status, 403);
  const r = await hq.patch('/api/hq/config/integrations', { patch: { paystack: { publicKey: 'pk_test_x', secretKey: 'sk_test_abc12345' } } });
  assert.equal(r.status, 200);
  const c = await hq.get('/api/hq/config');
  assert.deepEqual(c.body.settings.integrations.paystack.secretKey, { set: true, last4: '2345' });
  assert.ok(!JSON.stringify(c.body).includes('sk_test_abc12345'));
  // saving another field keeps the stored secret
  await hq.patch('/api/hq/config/integrations', { patch: { paystack: { publicKey: 'pk_test_y' } } });
  const c2 = await hq.get('/api/hq/config'); assert.equal(c2.body.settings.integrations.paystack.secretKey.set, true);
  // clear it again so the rest of the suite stays in demo payment mode
  await hq.patch('/api/hq/config/integrations', { patch: { paystack: { secretKey: '' } } });
  const c3 = await hq.get('/api/hq/config'); assert.equal(c3.body.settings.integrations.paystack.secretKey.set, false);
});

test('role permissions can be changed without code, and take effect on the next request', async () => {
  const rec = await h.as('frontdesk', 'reception@grandville.demo');
  const amaka = h.ctx.patients.amaka.id;
  const cash = await h.as('frontdesk', 'cashier@grandville.demo');
  const bill = await cash.post('/api/bills', { patientId: amaka, items: [{ serviceCode: 'REG' }] });
  assert.equal(bill.status, 200);
  assert.equal((await rec.get('/api/bills')).status, 403, 'receptionist cannot see bills by default');
  await hq.patch('/api/hq/config/roles', { patch: { overrides: { receptionist: { addPerms: ['billing.create'] } } } });
  assert.equal((await rec.get('/api/bills')).status, 200, 'after HQ grants billing.create');
  await hq.patch('/api/hq/config/roles', { patch: { overrides: { receptionist: { addPerms: [] } } } });
  assert.equal((await rec.get('/api/bills')).status, 403);
});

test('a custom role created in HQ can be assigned by a provider admin', async () => {
  const r = await hq.patch('/api/hq/config/roles', { patch: { custom: { triage_officer: { label: 'Triage officer', app: 'frontdesk', module: 'frontdesk', clock: true, perms: ['patient.read', 'queue.manage', 'vitals.record'] } } } });
  assert.equal(r.status, 200);
  const owner = await h.as('admin', 'owner@grandville.demo');
  const list = await owner.get('/api/admin/staff');
  assert.ok(list.body.roles.some(x => x.key === 'triage_officer'));
  const add = await owner.post('/api/admin/staff', { name: 'Tri Age', email: 'triage@grandville.demo', role: 'triage_officer' });
  assert.equal(add.status, 200);
  const badRole = await hq.patch('/api/hq/config/roles', { patch: { custom: { hacker: { label: 'X', app: 'hq', perms: [] } } } });
  assert.equal(badRole.status, 400);
});

test('maintenance mode blocks provider writes but not HQ', async () => {
  await hq.patch('/api/hq/config/features', { patch: { maintenanceMode: true, maintenanceMessage: 'Upgrading, back at 11pm' } });
  const cash = await h.as('frontdesk', 'cashier@grandville.demo');
  const r = await cash.post('/api/bills', { patientId: h.ctx.patients.amaka.id, items: [{ serviceCode: 'REG' }] });
  assert.equal(r.status, 503); assert.match(r.body.error, /Upgrading/);
  assert.equal((await cash.get('/api/bills')).status, 200, 'reads still work');
  await hq.patch('/api/hq/config/features', { patch: { maintenanceMode: false } });
  const ok = await cash.post('/api/bills', { patientId: h.ctx.patients.amaka.id, items: [{ serviceCode: 'REG' }] });
  assert.equal(ok.status, 200);
});

test('per-provider overrides change one provider only', async () => {
  const r = await hq.patch('/api/hq/config/orgs/' + h.ctx.orgs.clinic.id + '/overrides', { features: { videoVisits: false } });
  assert.equal(r.status, 200);
  const clinicFd = await h.as('frontdesk', 'reception@lekkifamily.demo');
  const hospFd = await h.as('frontdesk', 'reception@grandville.demo');
  assert.equal((await clinicFd.get('/api/meta/config')).body.features.videoVisits, false);
  assert.equal((await hospFd.get('/api/meta/config')).body.features.videoVisits, true);
});

test('process settings: password length and validation', async () => {
  assert.equal((await hq.patch('/api/hq/config/process', { patch: { security: { passwordMinLength: 4 } } })).status, 400);
  assert.equal((await hq.patch('/api/hq/config/process', { patch: { security: { nope: 1 } } })).status, 400);
  assert.equal((await hq.patch('/api/hq/config/process', { patch: { appointments: { patientCancelHours: 4 } } })).status, 200);
});

test('support: provider raises a ticket, HQ answers, other providers cannot see it', async () => {
  const owner = await h.as('admin', 'owner@yabacare.demo');
  const tk = await owner.post('/api/admin/support', { category: 'billing_subscription', priority: 'high', subject: 'Charged twice for October', text: 'Our plan was debited twice.' });
  assert.equal(tk.status, 200); assert.match(tk.body.number, /^MC-/);
  const other = await h.as('admin', 'owner@clearpath.demo');
  assert.equal((await other.get('/api/admin/support/' + tk.body.id)).status, 404);
  const q = await hq.get('/api/hq/support'); assert.ok(q.body.some(x => x.id === tk.body.id));
  await hq.post('/api/hq/support/' + tk.body.id + '/reply', { text: 'Internal: check Paystack', internal: true });
  await hq.post('/api/hq/support/' + tk.body.id + '/reply', { text: 'We have refunded the second charge.', status: 'resolved' });
  const seen = await owner.get('/api/admin/support/' + tk.body.id);
  assert.equal(seen.body.status, 'resolved'); assert.equal(seen.body.messages.length, 2, 'internal note hidden from provider');
  assert.equal((await owner.post('/api/admin/support/' + tk.body.id + '/close', { rating: 5 })).status, 200);
  assert.equal((await owner.post('/api/admin/support/' + tk.body.id + '/reply', { text: 'again' })).status, 409);
});

test('custom packages: any app mix is priced, and admins switch apps with a confirmed price', async () => {
  const q = await h.client('register').post('/api/pricing/quote', { type: 'pharmacy', modules: ['pharmacy', 'delivery', 'lab'], seats: 8 });
  assert.equal(q.status, 200);
  assert.deepEqual(q.body.modules.sort(), ['delivery', 'frontdesk', 'hmo', 'lab', 'pharmacy']);
  assert.equal(q.body.discount.percent, 10, 'three service apps get the bundle discount');
  assert.equal(q.body.seats.extra, 3); assert.equal(q.body.bankChargePerPaymentKobo, 220000);
  assert.equal((await h.client('register').post('/api/pricing/quote', { type: 'clinic', modules: ['delivery'] })).status, 400, 'delivery needs pharmacy or lab');
  const owner = await h.as('admin', 'owner@clearpath.demo');
  const first = await owner.post('/api/admin/org/modules', { module: 'pharmacy', enabled: true });
  assert.equal(first.body.needsConfirm, true);
  const done = await owner.post('/api/admin/org/modules', { module: 'pharmacy', enabled: true, confirmPriceKobo: first.body.quote.monthlyKobo });
  assert.equal(done.status, 200); assert.ok(done.body.modules.includes('pharmacy'));
  // HQ can switch to request mode: the change becomes a support ticket
  await hq.patch('/api/hq/config/pricing', { patch: { selfServeModules: false } });
  const q2 = await owner.post('/api/admin/org/modules', { module: 'clinic', enabled: true });
  const req2 = await owner.post('/api/admin/org/modules', { module: 'clinic', enabled: true, confirmPriceKobo: q2.body.quote.monthlyKobo });
  assert.equal(req2.body.requested, true);
  await hq.patch('/api/hq/config/pricing', { patch: { selfServeModules: true } });
  const hqPrice = await hq.patch('/api/hq/config/pricing', { patch: { modulesKobo: { lab: 2500000 } } });
  assert.equal(hqPrice.status, 200);
  const p = await h.client('register').get('/api/pricing'); assert.equal(p.body.modulesKobo.lab, 2500000);
});
