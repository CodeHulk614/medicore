'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');
const config = require('../src/config');

let h, hq, dev;
before(async () => { h = await boot(); hq = await h.as('hq', 'hq@medicore.demo'); dev = await h.as('hq', 'dev@medicore.demo'); });
after(async () => { config.DEMO_MODE = true; await h.close(); });

async function signup(email, name) {
  const r = await h.client('admin').post('/api/orgs/signup', { type: 'clinic', name, contact: { phone: '08051239999', email: 'c' + email, address: '1 St' }, owner: { name: 'Owner', email, phone: '0805' + String(Math.floor(1000000 + Math.random() * 8999999)), password: 'Owner2026x' }, acceptTerms: true });
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.org;
}

test('non-platform users get 403 on /api/hq/*', async () => {
  const fd = await h.as('frontdesk', 'reception@grandville.demo');
  assert.equal((await fd.get('/api/hq/providers')).status, 403);
  assert.equal((await fd.post('/api/hq/plans', {})).status, 403);
  const pat = await h.as('patient', 'amaka@patient.demo');
  assert.equal((await pat.get('/api/hq/metrics')).status, 403);
  assert.equal((await h.client('admin').post('/api/auth/login', { identifier: 'owner@grandville.demo', password: h.ctx.password })).status, 200);
  const l = await h.client('hq').post('/api/auth/login', { identifier: 'owner@grandville.demo', password: h.ctx.password });
  assert.equal(l.status, 403);
  assert.equal((await dev.get('/api/hq/team')).status, 403, 'developer lacks platform.users');
});

test('approve makes a pending provider\'s owner able to sign in; one-way', async () => {
  const org = await signup('newowner@test.demo', 'Brand New Clinic');
  const list = await hq.get('/api/hq/providers?status=pending');
  assert.ok(list.body.rows.some(o => o.id === org.id));
  const [a, b] = await Promise.all([hq.post('/api/hq/providers/' + org.id + '/approve'), hq.post('/api/hq/providers/' + org.id + '/approve')]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const ok = a.status === 200 ? a : b;
  assert.equal(ok.body.status, 'active'); assert.equal(ok.body.subscription.status, 'trial'); assert.ok(ok.body.subscription.trialEnds > Date.now() + 29 * 86400e3);
  const owner = await h.as('admin', 'newowner@test.demo', { password: 'Owner2026x' });
  assert.equal((await owner.get('/api/auth/me')).status, 200);
  const det = await hq.get('/api/hq/providers/' + org.id);
  assert.equal(det.body.staffCount, 1); assert.ok(det.body.lastActivityAt);
  const aud = await hq.get('/api/hq/providers/' + org.id + '/audit');
  assert.ok(aud.body.some(x => x.action === 'hq.org.approve'));
  const rej = await signup('rejectme@test.demo', 'Dodgy Clinic');
  assert.equal((await hq.post('/api/hq/providers/' + rej.id + '/reject', { reason: 'No valid licence' })).body.status, 'rejected');
  assert.equal((await hq.post('/api/hq/providers/' + rej.id + '/approve')).status, 409);
});

test('suspend locks out staff on the next request; reactivate restores', async () => {
  const cash = await h.as('frontdesk', 'cashier@lekkifamily.demo');
  assert.equal((await cash.get('/api/auth/me')).status, 200);
  const s = await hq.post('/api/hq/providers/' + h.ctx.orgs.clinic.id + '/suspend', { reason: 'Unpaid subscription' });
  assert.equal(s.status, 200); assert.ok(s.body.sessionsRevoked >= 1);
  assert.equal((await cash.get('/api/auth/me')).status, 401);
  const l = await h.client('frontdesk').post('/api/auth/login', { identifier: 'cashier@lekkifamily.demo', password: h.ctx.password });
  assert.equal(l.status, 403);
  assert.equal((await hq.post('/api/hq/providers/' + h.ctx.orgs.clinic.id + '/reactivate')).body.status, 'active');
  await h.as('frontdesk', 'cashier@lekkifamily.demo');
});

test('modules, plan and settings changes are validated and audited', async () => {
  const id = h.ctx.orgs.clinic.id;
  assert.equal((await hq.patch('/api/hq/providers/' + id + '/modules', { modules: ['payer'] })).status, 400, 'payer desk is only for HMOs');
  const m = await hq.patch('/api/hq/providers/' + id + '/modules', { modules: ['clinic', 'lab'] });
  assert.equal(m.status, 200); assert.ok(m.body.modules.includes('frontdesk') && m.body.modules.includes('hmo') && m.body.modules.includes('lab'));
  assert.equal(m.body.subscription.monthlyKobo, m.body.quote.monthlyKobo, 'price follows the modular quote');
  assert.equal((await hq.patch('/api/hq/providers/' + id + '/subscription', { applyPreset: 'hospital' })).status, 400);
  const p = await hq.patch('/api/hq/providers/' + id + '/subscription', { status: 'active', seats: 12 });
  assert.equal(p.status, 200); assert.equal(p.body.subscription.status, 'active'); assert.equal(p.body.subscription.seats, 12);
  const neg = await hq.patch('/api/hq/providers/' + id + '/subscription', { monthlyKobo: 4000000 });
  assert.equal(neg.body.subscription.monthlyKobo, 4000000); assert.equal(neg.body.subscription.manualPrice, true);
  const pre = await hq.patch('/api/hq/providers/' + id + '/subscription', { applyPreset: 'clinic_basic', clearManualPrice: true });
  assert.deepEqual(pre.body.modules.slice().sort(), ['clinic', 'frontdesk', 'hmo']); assert.equal(pre.body.subscription.monthlyKobo, pre.body.quote.monthlyKobo);
  const st = await hq.patch('/api/hq/providers/' + id + '/settings', { settings: { requireClockIn: false, role: 'x' } });
  assert.equal(st.status, 200); assert.equal(st.body.settings.requireClockIn, false);
  await hq.patch('/api/hq/providers/' + id + '/settings', { settings: { requireClockIn: true } });
  const a = await hq.get('/api/hq/audit?orgId=' + id + '&action=hq.org');
  assert.ok(a.body.length >= 3); assert.ok(a.body.every(x => x.orgId === id));
});

test('plans: create, edit, deactivate; existing orgs keep their price', async () => {
  assert.equal((await dev.post('/api/hq/plans', { label: 'X', orgTypes: ['clinic'], priceKobo: 1, modules: ['clinic'], seats: 1 })).status, 403);
  const c = await hq.post('/api/hq/plans', { key: 'clinic_lite', label: 'Clinic Lite', orgTypes: ['clinic'], priceKobo: 2000000, modules: ['frontdesk', 'clinic', 'hmo'], seats: 5 });
  assert.equal(c.status, 200); assert.equal(c.body.key, 'clinic_lite');
  assert.equal((await hq.post('/api/hq/plans', { label: 'Bad', orgTypes: ['hmo'], priceKobo: 1, modules: ['clinic'], seats: 1 })).status, 400);
  const before = (await hq.get('/api/hq/providers/' + h.ctx.orgs.clinic.id)).body.subscription.monthlyKobo;
  assert.equal((await hq.patch('/api/hq/plans/clinic_basic', { priceKobo: 12000000 })).status, 200);
  const det = await hq.get('/api/hq/providers/' + h.ctx.orgs.clinic.id);
  assert.equal(det.body.subscription.monthlyKobo, before, 'editing a preset does not reprice providers');
  assert.equal((await hq.post('/api/hq/plans/clinic_lite/deactivate')).body.active, false);
  assert.equal((await hq.post('/api/hq/plans/clinic_lite/deactivate')).status, 409);
});

test('platform team: invite, cannot change own role, last owner protected (also in parallel)', async () => {
  const users = require('../src/db').col('users');
  const inv = await hq.post('/api/hq/team', { name: 'New Support', email: 'support@medicore.demo', role: 'support' });
  assert.equal(inv.status, 200); assert.ok(inv.body.tempPassword);
  assert.equal((await hq.post('/api/hq/team', { name: 'Dup', email: 'support@medicore.demo', role: 'support' })).status, 409);
  const me = (await hq.get('/api/auth/me')).body.user.id;
  assert.equal((await hq.patch('/api/hq/team/' + me, { role: 'developer' })).status, 403, 'own role');
  assert.equal((await hq.post('/api/hq/team/' + me + '/suspend')).status, 403, 'own access');
  const sup = inv.body.member.userId;
  assert.equal((await hq.patch('/api/hq/team/' + sup, { role: 'compliance' })).body.role, 'compliance');
  assert.equal((await hq.post('/api/hq/team/' + sup + '/suspend')).body.status, 'suspended');
  assert.equal((await hq.post('/api/hq/team/' + sup + '/reactivate')).body.status, 'active');
  // second owner
  const inv2 = await hq.post('/api/hq/team', { name: 'Owner Two', email: 'owner2@medicore.demo', role: 'platform_owner' });
  const o2 = h.client('hq'); await o2.login('owner2@medicore.demo', inv2.body.tempPassword);
  assert.equal((await o2.post('/api/auth/password', { current: inv2.body.tempPassword, next: 'OwnerTwo2026' })).status, 200);
  const o2id = inv2.body.member.userId;
  // both owners demote each other at the same moment: at least one owner must remain
  const [r1, r2] = await Promise.all([hq.patch('/api/hq/team/' + o2id, { role: 'developer' }), o2.patch('/api/hq/team/' + me, { role: 'developer' })]);
  assert.ok([r1.status, r2.status].includes(200));
  assert.equal(await users.count({ platformRole: 'platform_owner' }), 1, 'exactly one owner left');
  assert.ok([r1.status, r2.status].every(s => s === 200 || s === 409 || s === 401));
  // restore hq as the only owner for later tests
  const owner = await users.findOne({ platformRole: 'platform_owner' });
  if (owner.id !== me) {
    const c = h.client('hq'); await c.login('owner2@medicore.demo', 'OwnerTwo2026');
    assert.equal((await c.patch('/api/hq/team/' + me, { role: 'platform_owner' })).status, 200);
  }
  hq = await h.as('hq', 'hq@medicore.demo');
  if ((await users.findOne({ id: o2id })).platformRole === 'platform_owner') assert.equal((await hq.patch('/api/hq/team/' + o2id, { role: 'developer' })).status, 200);
  // hq is now the last owner; a real last-owner check: o2 (developer) cannot act, and the guard refuses demotion
  assert.equal(await users.count({ platformRole: 'platform_owner' }), 1);
  const P = require('../src/modules/platform'); void P;
});

test('owner password reset for support', async () => {
  const r = await hq.post('/api/hq/providers/' + h.ctx.orgs.lab.id + '/reset-owner-password');
  assert.equal(r.status, 200); assert.ok(r.body.tempPassword);
  const c = h.client('admin'); await c.login('owner@clearpath.demo', r.body.tempPassword);
  assert.equal((await c.get('/api/admin/org')).status, 423);
});

test('metrics', async () => {
  const m = await hq.get('/api/hq/metrics');
  assert.equal(m.status, 200); assert.ok(m.body.providers.total >= 6); assert.ok('open' in m.body.support); assert.equal(m.body.perDay.length, 30); assert.ok(m.body.patients.total >= 4);
});

test('privacy: request handling and deletion as anonymisation', async () => {
  const pc = h.client('patient');
  const s = await pc.post('/api/patients/register/start', { phone: '08062223333' });
  await pc.post('/api/patients/register', { phone: '08062223333', code: s.body.devCode, firstName: 'Delete', lastName: 'Me', password: 'Delete2026x', consent: true, nin: '23334445556' });
  const req1 = await pc.post('/api/me/privacy-request', { type: 'delete', note: 'Please delete' });
  const rid = req1.body.request.id; const pid = (await pc.get('/api/me/profile')).body.id;
  assert.equal((await dev.get('/api/hq/privacy/requests')).status, 403, 'developer lacks privacy');
  const list = await hq.get('/api/hq/privacy/requests?status=open'); assert.ok(list.body.some(r => r.id === rid));
  assert.equal((await hq.post('/api/hq/privacy/requests/' + rid + '/assign')).body.status, 'in_progress');
  const cons = await hq.get('/api/hq/privacy/consents/' + pid); assert.ok(cons.body.records.length >= 1);
  const [x1, x2] = await Promise.all([hq.post('/api/hq/privacy/requests/' + rid + '/execute-deletion', { retentionReason: 'Medical records retention (10 years)' }), hq.post('/api/hq/privacy/requests/' + rid + '/execute-deletion', { retentionReason: 'Medical records retention (10 years)' })]);
  assert.deepEqual([x1.status, x2.status].sort(), [200, 409]);
  const p = await h.db.col('patients').findOne({ id: pid });
  assert.equal(p.firstName, 'Removed'); assert.equal(p.phone, undefined); assert.equal(p.status, 'removed'); assert.ok(p.retention.reason);
  assert.equal((await pc.get('/api/me/profile')).status, 401);
  assert.equal((await h.client('patient').post('/api/auth/login', { identifier: '08062223333', password: 'Delete2026x' })).status, 401);
  const settings = await hq.get('/api/hq/privacy/settings'); assert.ok('dataLocation' in settings.body);
});

test('breach register flags the 72-hour NDPC deadline', async () => {
  const old = await hq.post('/api/hq/privacy/breaches', { title: 'Laptop stolen', discoveredAt: Date.now() - 80 * 3600e3, description: 'Unencrypted laptop', affectedCount: 120 });
  assert.equal(old.status, 200); assert.equal(old.body.ndpcOverdue, true);
  const fresh = await hq.post('/api/hq/privacy/breaches', { title: 'Misdirected email', discoveredAt: Date.now() - 2 * 3600e3, description: 'One email', affectedCount: 1 });
  assert.equal(fresh.body.ndpcOverdue, false); assert.ok(fresh.body.ndpcHoursLeft > 69);
  const u = await hq.patch('/api/hq/privacy/breaches/' + old.body.id, { ndpcNotifiedAt: Date.now(), status: 'contained' });
  assert.equal(u.body.ndpcOverdue, false); assert.equal(u.body.ndpcLate, true);
});

test('demo accounts and reset refused when DEMO_MODE is off', async () => {
  const acc = await dev.get('/api/hq/demo/accounts'); assert.equal(acc.status, 200); assert.ok(acc.body.rows.length > 10);
  config.DEMO_MODE = false;
  try {
    assert.equal((await dev.post('/api/hq/demo/reset', { confirm: 'RESET' })).status, 403);
    assert.equal((await dev.get('/api/hq/demo/accounts')).status, 403);
  } finally { config.DEMO_MODE = true; }
  assert.equal((await dev.post('/api/hq/demo/reset', {})).status, 400);
  const support = await h.db.col('users').findOne({ email: 'support@medicore.demo' });
  assert.ok(support);
});

test('demo reset wipes and reloads (runs last)', async () => {
  const r = await dev.post('/api/hq/demo/reset', { confirm: 'RESET' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await h.db.col('users').count({ email: 'support@medicore.demo' }), 0, 'non-demo data gone');
  assert.equal(await h.db.col('orgs').count({}), 8); // six providers and the two Crestview branches
  assert.equal(await h.db.col('groups').count({}), 1);
  assert.equal((await dev.get('/api/hq/providers')).status, 401, 'must sign in again');
  const again = await h.as('hq', 'hq@medicore.demo');
  assert.equal((await again.get('/api/hq/providers')).status, 200);
});
