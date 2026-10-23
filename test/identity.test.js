'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');
const { demoNinOf } = require('../src/seed/demo');

let h, hmo, fdG, fdL;
before(async () => {
  h = await boot();
  hmo = await h.as('payer', 'owner@harborhmo.demo');
  fdG = await h.as('frontdesk', 'fdmanager@grandville.demo');
  fdL = await h.as('frontdesk', 'reception@lekkifamily.demo');
});
after(async () => { await h.close(); });

async function signup(phone, first, last, nin) {
  const pc = h.client('patient');
  const st = await pc.post('/api/patients/register/start', { phone });
  const r = await pc.post('/api/patients/register', { phone, code: st.body.devCode, firstName: first, lastName: last, dob: '1990-05-05', password: 'Strong2026pw', consent: true, nin });
  return { pc, r };
}

test('self-registration needs a NIN that NIMC knows and that matches; the NIN is never stored', async () => {
  assert.equal((await signup('08065550001', 'Ada', 'Eze')).r.status, 400, 'no NIN');
  assert.equal((await signup('08065550002', 'Ada', 'Eze', '123')).r.status, 400, 'not 11 digits');
  assert.match((await signup('08065550003', 'Ada', 'Eze', '00011122233')).r.body.error, /NIMC has no record/);
  assert.match((await signup('08065550004', 'Ada', 'Eze', '99911122233')).r.body.error, /does not match/);
  const { pc, r } = await signup('08065550005', 'Ada', 'Eze', '21112223334');
  assert.equal(r.status, 200);
  const me = (await pc.get('/api/me/profile')).body;
  assert.equal(me.ninStatus, 'verified'); assert.equal(me.ninLast4, '3334');
  const raw = await h.db.col('patients').findOne({ id: r.body.patientId });
  assert.ok(raw.ninHash && !JSON.stringify(raw).includes('21112223334'), 'only a keyed hash is kept');
  const dup = await signup('08065550006', 'Ada', 'Eze', '21112223334');
  assert.equal(dup.r.status, 409); assert.equal(dup.r.body.code, 'nin_exists');
});

test('the first provider is free; more providers need the marketplace subscription', async () => {
  const { pc } = await signup('08065550010', 'Bayo', 'Ade', '21112223340');
  const list = (await pc.get('/api/join/providers')).body;
  assert.ok(list.length > 3, 'a new patient sees the providers on the platform');
  const lekki = list.find(x => x.name === 'Lekki Family Clinic'); const yaba = list.find(x => x.name === 'Yaba Care Pharmacy');
  const a1 = await pc.post('/api/me/applications', { orgId: lekki.branches[0].id });
  assert.equal(a1.status, 200);
  const a2 = await pc.post('/api/me/applications', { orgId: yaba.branches[0].id });
  assert.equal(a2.status, 403); assert.equal(a2.body.code, 'subscription_required');
  const pid = (await pc.get('/api/me/profile')).body.id;
  await h.db.col('market_subs').insertOne({ id: 'ms_test1', patientId: pid, status: 'active', plan: 'monthly', startsAt: Date.now(), endsAt: Date.now() + 30 * 86400e3, createdAt: Date.now() });
  const a3 = await pc.post('/api/me/applications', { orgId: yaba.branches[0].id });
  assert.equal(a3.status, 200, 'a subscriber joins more providers');
});

test('an existing patient without a NIN must add one before applying', async () => {
  const { pc, r } = await signup('08065550020', 'Chi', 'Obi', '21112223350');
  await h.db.col('patients').updateOne({ id: r.body.patientId }, { $unset: { ninHash: '', ninLast4: '', ninStatus: '' } });
  const list = (await pc.get('/api/join/providers')).body;
  const a = await pc.post('/api/me/applications', { orgId: list[0].branches[0].id });
  assert.equal(a.status, 400); assert.equal(a.body.code, 'nin_required');
  assert.equal((await pc.post('/api/me/nin', { nin: '21112223350' })).status, 200);
  assert.equal((await pc.post('/api/me/applications', { orgId: list[0].branches[0].id })).status, 200);
});

test('front desk registers with a NIN or a reason, and finds people by NIN with their HMO before consent', async () => {
  assert.equal((await fdL.post('/api/fd/patients', { firstName: 'Dami', lastName: 'Ola', consent: true, noKnownAllergies: true })).status, 400, 'NIN or reason');
  assert.equal((await fdL.post('/api/fd/patients', { firstName: 'Baby', lastName: 'Ola', consent: true, noKnownAllergies: true, noNinReason: 'child' })).status, 200);
  const amaka = h.ctx.patients.amaka;
  const lk = await fdL.post('/api/fd/patients/lookup', { nin: demoNinOf(amaka.phone) });
  if (lk.body.status === 'linked') { assert.ok(lk.body.hmo.length); return; }
  assert.equal(lk.body.status, 'exists_elsewhere'); assert.ok(!lk.body.patient, 'nothing clinical before consent');
  assert.equal(lk.body.hmo[0].hmoName, 'Harbor Health HMO'); assert.equal(lk.body.hmo[0].inNetworkHere, true); assert.ok(!('memberNo' in lk.body.hmo[0]));
  const ln = await fdL.post('/api/fd/patients/link', { nin: demoNinOf(amaka.phone), code: lk.body.devCode });
  assert.equal(ln.status, 200); assert.ok(ln.body.hmo[0].memberNo && ln.body.hmo[0].networkProviders >= 1);
});

test('an HMO registers its clients as an institution; providers then see the HMO', async () => {
  const plans = (await hmo.get('/api/payer/plans')).body;
  const r = await hmo.post('/api/payer/members/register', { firstName: 'Femi', lastName: 'Bello', dob: '1985-02-02', phone: '08065550030', nin: '21112223360', planId: plans[0].id, consent: true });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'active'); assert.ok(r.body.cardCode);
  const p = await h.db.col('patients').findOne({ phone: '+2348065550030' });
  assert.equal(p.createdVia, 'hmo'); assert.equal(p.ninStatus, 'verified');
  assert.equal((await hmo.post('/api/payer/members/register', { firstName: 'Femi', lastName: 'Bello', nin: '21112223360', planId: plans[0].id, consent: true })).status, 409, 'already a member');
  // an existing MediCore person: a pending cover, nothing revealed
  await signup('08065550031', 'Halima', 'Sani', '21112223361');
  const ex = await hmo.post('/api/payer/members/register', { firstName: 'Halima', lastName: 'X', nin: '21112223361', planId: plans[0].id, consent: true });
  assert.equal(ex.status, 200, JSON.stringify(ex.body)); assert.equal(ex.body.status, 'pending'); assert.ok(!ex.body.patientId);
  const lk = await fdG.post('/api/fd/patients/lookup', { nin: '21112223360' });
  assert.equal(lk.body.status, 'exists_elsewhere'); assert.equal(lk.body.hmo[0].hmoName, 'Harbor Health HMO');
});

test('the uninsured browse every HMO free; the insured need the marketplace for other HMOs', async () => {
  const { pc } = await signup('08065550040', 'Gbenga', 'Lawal', '21112223370');
  assert.equal((await pc.get('/api/me/hmo/access')).body.reason, 'uninsured');
  const plans = (await pc.get('/api/me/hmo/plans')).body;
  assert.ok(plans.length >= 1);
  const amaka = await h.as('patient', 'amaka@patient.demo');
  const acc = (await amaka.get('/api/me/hmo/access')).body;
  assert.ok(['subscription_required', 'subscribed'].includes(acc.reason));
  if (acc.reason === 'subscription_required') {
    const mine = (await amaka.get('/api/me/hmo/plans')).body;
    assert.ok(mine.every(x => x.name === 'Harbor Health HMO'), 'only her own HMO');
  }
});

test('a network provider gets an uninsured patient onto an HMO plan at the desk', async () => {
  const reg = await fdG.post('/api/fd/patients', { firstName: 'Ife', lastName: 'Ojo', consent: true, noKnownAllergies: true, nin: '21112223380', phone: '08065550050' });
  assert.equal(reg.status, 200);
  const offer = (await fdG.get('/api/fd/patients/' + reg.body.patient.id + '/hmo-plans')).body;
  assert.equal(offer.insured, false); const plan = offer.hmos[0].plans[0];
  const en = await fdG.post('/api/fd/patients/' + reg.body.patient.id + '/hmo-enrol', { planId: plan.id, period: 'monthly', consent: true });
  assert.equal(en.status, 200); assert.ok(en.body.billId && en.body.amountKobo > 0);
  const sum = (await fdG.get('/api/fd/patients/' + reg.body.patient.id + '/hmo-summary')).body;
  assert.equal(sum[0].status, 'pending'); assert.equal(sum[0].isPrimaryHere, true);
});

test('staff IDs are keyed and checkable; signed clock-ins expose edits and deletions', async () => {
  const crew = await h.as('crew', 'crew@swiftaid.demo');
  const id = (await crew.get('/api/shift/my-id')).body;
  assert.match(id.staffUid, /^MC-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  const pub = h.client('patient');
  const ok = (await pub.get('/api/verify/staff/' + id.staffUid)).body;
  assert.equal(ok.valid, true); assert.equal(ok.provider, 'SwiftAid Ambulance'); assert.equal(ok.onDutyNow, true);
  const fake = id.staffUid.slice(0, -1) + (id.staffUid.endsWith('A') ? 'B' : 'A');
  assert.equal((await pub.get('/api/verify/staff/' + fake)).body.valid, false);
  const owner = await h.as('admin', 'owner@swiftaid.demo');
  let v = (await owner.get('/api/shift/attendance/verify')).body;
  assert.equal(v.intact, true); assert.ok(v.checked >= 1);
  const sh = await h.db.col('shifts').findOne({ membershipId: { $exists: true }, orgId: h.ctx.orgs.ambulance.id, seq: { $gt: 0 } });
  await h.db.col('shifts').updateOne({ id: sh.id }, { $set: { in: sh.in - 3600e3 } });
  v = (await owner.get('/api/shift/attendance/verify')).body;
  assert.equal(v.intact, false); assert.equal(v.tampered[0].id, sh.id);
  const rows = (await owner.get('/api/shift/attendance')).body;
  assert.equal(rows.find(r => r.id === sh.id).intact, false); assert.ok(!('sig' in rows[0]) || rows[0].sig === undefined);
});

test('one person, one record: a MediCore patient ID for life; email cannot be reused', async () => {
  const { pc, r } = await signup('08065550060', 'Jide', 'Coker', '21112223390');
  const me = (await pc.get('/api/me/profile')).body;
  assert.match(me.uid, /^MCP-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const lk = await fdG.post('/api/fd/patients/lookup', { uid: me.uid });
  assert.equal(lk.body.status, 'exists_elsewhere');
  await pc.req('PATCH', '/api/me/profile', { email: 'jide.coker@example.com' });
  assert.equal((await fdG.post('/api/fd/patients/lookup', { email: 'jide.coker@example.com' })).body.status, 'exists_elsewhere');
  const dupe = await fdG.post('/api/fd/patients', { firstName: 'J', lastName: 'C', consent: true, noKnownAllergies: true, email: 'jide.coker@example.com', noNinReason: 'not_enrolled' });
  assert.equal(dupe.status, 409); assert.equal(dupe.body.code, 'patient_exists');
  const st = await h.client('patient').post('/api/patients/register/start', { phone: '08065550061' });
  void st; assert.ok(r.body.patientId);
});
