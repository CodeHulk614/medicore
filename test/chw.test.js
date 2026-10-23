'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { boot } = require('./helpers');

let h, chw, chw2, chw2MemId;
const uuid = () => crypto.randomUUID();
before(async () => {
  h = await boot();
  chw = await h.as('chw', 'chw@grandville.demo');
  const owner = await h.as('admin', 'owner@grandville.demo');
  const add = await owner.post('/api/admin/staff', { name: 'Second CHW', email: 'chw2@grandville.demo', role: 'chw' });
  assert.equal(add.status, 200, JSON.stringify(add.body)); chw2MemId = add.body.member.id;
  const c = h.client('chw'); await c.login('chw2@grandville.demo', add.body.tempPassword);
  await c.post('/api/auth/password', { current: add.body.tempPassword, next: 'SecondChw2026' });
  await c.clockIn(); chw2 = c;
});
after(async () => { await h.close(); });

test('sync creates household, client (new patient), visit; resend is idempotent', async () => {
  const hhRef = uuid(), cRef = uuid(), vRef = uuid();
  const recs = [
    { clientRef: hhRef, kind: 'household', data: { name: 'Adebayo household', address: '3 Ojuelegba Rd', members: 4 }, recordedAt: Date.now() - 3600e3, lat: 6.5, lng: 3.36 },
    { clientRef: cRef, kind: 'client', data: { firstName: 'Bisola', lastName: 'Adebayo', dob: '2026-08-01', sex: 'female', householdRef: hhRef, consent: true } },
    { clientRef: vRef, kind: 'visit', data: { forClientRef: cRef, purpose: 'newborn', weightKg: 4.1 } },
  ];
  const r = await chw.post('/api/chw/sync', { records: recs });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.saved, 3, JSON.stringify(r.body));
  assert.ok(r.body.results[1].patientId);
  const again = await chw.post('/api/chw/sync', { records: recs });
  assert.equal(again.body.saved, 3);
  assert.ok(again.body.results.every(x => x.status === 'existing'));
  assert.deepEqual(again.body.results.map(x => x.id), r.body.results.map(x => x.id));
  const [p1, p2] = await Promise.all([chw.post('/api/chw/sync', { records: [{ clientRef: 'par-' + uuid(), kind: 'household', data: { name: 'P' } }] }), Promise.resolve(null)]);
  assert.equal(p1.body.saved, 1); void p2;
  const roster = await chw.get('/api/chw/roster');
  const hh = roster.body.households.find(x => x.clientRef === hhRef);
  assert.equal(hh.clients.length, 1, 'one client despite resend');
  // the new patient is linked to the hospital and visible to its front desk
  const fd = await h.as('frontdesk', 'reception@grandville.demo');
  assert.equal((await fd.get('/api/fd/patients/' + r.body.results[1].patientId)).status, 200);
  // due list includes the 6 week vaccines
  const due = await chw.get('/api/chw/due?days=60');
  assert.ok(due.body.immunizations.some(d => d.clientId === r.body.results[1].id && d.code === 'BCG' && d.overdue));
});

test('parallel resend of the same clientRef creates one record', async () => {
  const ref = uuid();
  const rec = { clientRef: ref, kind: 'household', data: { name: 'Twin send' } };
  const rs = await Promise.all([1, 2, 3].map(() => chw.post('/api/chw/sync', { records: [rec] })));
  const ids = new Set(rs.flatMap(r => r.body.results.filter(x => x.ok).map(x => x.id)));
  assert.equal(ids.size, 1);
  const n = await h.db.col('chw_households').count({ clientRef: ref }); assert.equal(n, 1);
});

test('bad records fail individually without blocking others', async () => {
  const r = await chw.post('/api/chw/sync', { records: [
    { clientRef: uuid(), kind: 'client', data: { firstName: 'No', lastName: 'Consent', consent: false } },
    { clientRef: 'x', kind: 'household', data: { name: 'bad ref' } },
    { clientRef: uuid(), kind: 'immunization', data: { forClientRef: uuid(), vaccine: 'BCG', givenOn: '2026-01-01' } },
    { clientRef: uuid(), kind: 'household', data: { name: 'Good' } } ] });
  assert.equal(r.body.saved, 1); assert.equal(r.body.failed, 3);
  assert.equal(r.body.results[0].error, 'consent_required'); assert.equal(r.body.results[2].error, 'not_found');
  assert.ok(r.body.results.filter(x => !x.ok).every(x => x.retry === false));
  const big = await chw.post('/api/chw/sync', { records: Array.from({ length: 201 }, () => ({ clientRef: uuid(), kind: 'household', data: { name: 'x' } })) });
  assert.equal(big.status, 400);
});

test('existing MediCore phone becomes a link request, nothing revealed', async () => {
  const cRef = uuid();
  const r = await chw.post('/api/chw/sync', { records: [{ clientRef: cRef, kind: 'client', data: { firstName: 'K', lastName: 'M', phone: h.ctx.patients.kunle.phone, consent: true } }] });
  const res = r.body.results[0];
  assert.equal(res.status, 'link_requested'); assert.ok(!res.patientId); assert.ok(res.devCode);
  assert.equal((await chw.post('/api/chw/clients/' + res.id + '/link', { code: '000000' })).status, 400);
  const ok = await chw.post('/api/chw/clients/' + res.id + '/link', { code: res.devCode });
  assert.equal(ok.status, 200); assert.equal(ok.body.patientId, h.ctx.patients.kunle.id);
});

test('danger signs create an urgent triage referral and notify reception', async () => {
  const cRef = uuid();
  const r = await chw.post('/api/chw/sync', { records: [
    { clientRef: cRef, kind: 'client', data: { firstName: 'Musa', lastName: 'Ali', dob: '2024-03-01', sex: 'male', consent: true } },
    { clientRef: uuid(), kind: 'visit', data: { forClientRef: cRef, purpose: 'sick', dangerSigns: ['convulsions', 'high_fever'], tempC: 39.8 } }] });
  assert.equal(r.body.saved, 2, JSON.stringify(r.body));
  const v = r.body.results[1]; assert.ok(v.referralId); assert.ok(v.queueId);
  const q = await h.db.col('queue').findOne({ id: v.queueId });
  assert.equal(q.orgId, h.ctx.orgs.hospital.id); assert.equal(q.servicePoint, 'triage'); assert.equal(q.priority, 'urgent'); assert.equal(q.status, 'waiting'); assert.equal(q.patientId, r.body.results[0].patientId);
  const fd = await h.as('frontdesk', 'reception@grandville.demo');
  const n = await fd.get('/api/notifications'); assert.ok(n.body.some(x => x.kind === 'chw_referral'));
  const refs = await chw.get('/api/chw/referrals'); assert.ok(refs.body.some(x => x.id === v.referralId && x.queueStatus === 'waiting'));
});

test('a CHW cannot see or write to another CHW\'s clients until assigned', async () => {
  const cRef = uuid();
  const r = await chw.post('/api/chw/sync', { records: [{ clientRef: cRef, kind: 'client', data: { firstName: 'Private', lastName: 'Client', consent: true } }] });
  const cid = r.body.results[0].id;
  assert.equal((await chw2.get('/api/chw/clients/' + cid)).status, 404);
  const ro = await chw2.get('/api/chw/roster'); assert.equal(ro.body.counts.clients, 0);
  const w = await chw2.post('/api/chw/sync', { records: [{ clientRef: uuid(), kind: 'visit', data: { clientId: cid } }, { clientRef: uuid(), kind: 'visit', data: { forClientRef: cRef } }] });
  assert.ok(w.body.results.every(x => x.error === 'not_found'));
  const reuse = await chw2.post('/api/chw/sync', { records: [{ clientRef: cRef, kind: 'client', data: { firstName: 'A', lastName: 'B', consent: true } }] });
  assert.equal(reuse.body.results[0].error, 'ref_conflict');
  const admin = await h.as('admin', 'owner@grandville.demo');
  assert.equal((await admin.post('/api/chw/assign', { kind: 'client', id: cid, chwMembershipId: chw2MemId })).status, 200);
  assert.equal((await chw2.get('/api/chw/clients/' + cid)).status, 200);
  const sum = await admin.get('/api/chw/supervisor/summary?weeks=2');
  assert.equal(sum.status, 200); assert.ok(sum.body.workers.some(x => x.totals.visits > 0));
  assert.equal((await chw.get('/api/chw/supervisor/summary')).status, 403);
});

test('clinic without the chw module is refused', async () => {
  const fd = await h.as('frontdesk', 'reception@lekkifamily.demo');
  assert.equal((await fd.post('/api/chw/sync', { records: [] })).status, 403);
});
