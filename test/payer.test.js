'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

let h, officer, manager, cashier, rival, rivalOrg;
const N = n => n * 100;
before(async () => {
  h = await boot();
  officer = await h.as('payer', 'officer@harborhmo.demo');
  manager = await h.as('payer', 'owner@harborhmo.demo');
  cashier = await h.as('frontdesk', 'cashier@grandville.demo');
  const orgs = require('../src/modules/orgs');
  ({ org: rivalOrg } = await orgs.createOrg({ type: 'hmo', name: 'Rival Health HMO', status: 'active', contact: {}, owner: { name: 'Rival Owner', email: 'owner@rivalhmo.demo', password: 'Rival2026x' } }));
  rival = await h.as('payer', 'owner@rivalhmo.demo', { password: 'Rival2026x' });
});
after(async () => { await h.close(); });

async function bill(patientKey, code = 'CONS-GP', qty = 1) {
  const r = await cashier.post('/api/bills', { patientId: h.ctx.patients[patientKey].id, items: [{ serviceCode: code, qty }] });
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body;
}
async function amakaCover() {
  const r = await cashier.get('/api/hmo/patients/' + h.ctx.patients.amaka.id + '/cover');
  assert.equal(r.status, 200); return r.body.find(c => c.payerOrgId === h.ctx.orgs.hmo.id);
}

test('demo seed: active cover, approved preauth, paid claim and flagged duplicate', async () => {
  const covs = await officer.get('/api/payer/coverages?status=active');
  assert.equal(covs.status, 200); assert.ok(covs.body.length >= 2);
  const claims = await officer.get('/api/payer/claims');
  assert.ok(claims.body.some(c => c.status === 'paid'));
  assert.ok(claims.body.some(c => c.flags.some(f => f.code === 'duplicate')));
  const pre = await officer.get('/api/payer/preauths?status=approved'); assert.ok(pre.body.length >= 1 && pre.body[0].authCode);
  const dash = await officer.get('/api/payer/dashboard'); assert.equal(dash.status, 200); assert.ok(dash.body.flaggedOpen >= 1); assert.ok(dash.body.byProvider.length >= 1);
});

test('patient adds cover -> pending -> HMO activates with limits', async () => {
  const pat = await h.as('patient', 'kunle@patient.demo');
  const r = await pat.post('/api/me/coverages', { payerOrgId: h.ctx.orgs.hmo.id, memberNo: 'hh-555001', planName: 'Harbor Bronze' });
  assert.equal(r.status, 200); assert.equal(r.body.status, 'pending'); assert.equal(r.body.memberNo, 'HH-555001');
  assert.equal((await pat.post('/api/me/coverages', { payerOrgId: h.ctx.orgs.hmo.id, memberNo: 'HH-555002' })).status, 409, 'one cover per HMO');
  const bad = await officer.post('/api/payer/coverages/' + r.body.id + '/activate', { validTo: '2030-01-01' });
  assert.equal(bad.status, 400);
  const ok = await officer.post('/api/payer/coverages/' + r.body.id + '/activate', { limits: { consultation: N(50000), drug: N(10000) }, validTo: '2030-01-01' });
  assert.equal(ok.status, 200); assert.equal(ok.body.status, 'active'); assert.equal(ok.body.member.name, 'Kunle Martins');
  assert.equal((await officer.post('/api/payer/coverages/' + r.body.id + '/activate', { limits: { consultation: 1 }, validTo: '2030-01-01' })).status, 409, 'one-way');
  const mine = await pat.get('/api/me/coverages');
  const c = mine.body.find(x => x.id === r.body.id); assert.equal(c.status, 'active'); assert.equal(c.remainingKobo.consultation, N(50000)); assert.equal(c.remainingKobo.lab, 0);
  // suspend / reactivate / end
  assert.equal((await officer.post('/api/payer/coverages/' + r.body.id + '/suspend', { reason: 'Premium unpaid' })).body.status, 'suspended');
  assert.equal((await officer.post('/api/payer/coverages/' + r.body.id + '/reactivate')).body.status, 'active');
});

test('HMO bulk-enrols by phone; patient sees and confirms', async () => {
  const r = await officer.post('/api/payer/coverages/enrol', { members: [
    { phone: '0803 987 6543', memberNo: 'HH-777001', name: 'Tobi A', limits: { consultation: N(1000) }, validTo: '2030-12-31' },
    { phone: 'not a phone', memberNo: 'HH-777002', limits: {}, validTo: '2030-12-31' },
    { phone: '08060000999', memberNo: 'HH-777003', limits: { drug: N(500) }, validTo: '2030-12-31' } ] });
  assert.equal(r.status, 200); assert.equal(r.body.enrolled, 2); assert.equal(r.body.failed, 1);
  // tobi already has Harbor cover through the seed, but enrolment by phone is still offered for confirmation
  const pat = await h.as('patient', 'tobi@patient.demo');
  const list = await pat.get('/api/me/coverages');
  const pend = list.body.find(c => c.memberNo === 'HH-777001'); assert.equal(pend.status, 'pending'); assert.equal(pend.patientConfirmed, false);
  assert.equal((await officer.post('/api/payer/coverages/' + pend.id + '/activate', { limits: { consultation: 1 }, validTo: '2030-01-01' })).status, 409, 'waits for member');
  const [a, b] = await Promise.all([pat.post('/api/me/coverages/' + pend.id + '/confirm'), pat.post('/api/me/coverages/' + pend.id + '/confirm')]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((a.status === 200 ? a : b).body.status, 'active');
  // another patient cannot confirm it
  const amaka = await h.as('patient', 'amaka@patient.demo');
  assert.equal((await amaka.post('/api/me/coverages/' + pend.id + '/confirm')).status, 404);
});

test('cover check needs a linked patient; payer isolation on coverages', async () => {
  const clinic = await h.as('frontdesk', 'cashier@lekkifamily.demo');
  assert.equal((await clinic.get('/api/hmo/patients/' + h.ctx.patients.tobi.id + '/cover')).status, 404);
  const c = await amakaCover(); assert.ok(c.remainingKobo.consultation > 0);
  assert.equal((await rival.get('/api/payer/coverages/' + c.coverageId)).status, 404);
  assert.ok(!(await rival.get('/api/payer/coverages')).body.some(x => x.id === c.coverageId));
  assert.equal((await rival.post('/api/payer/coverages/' + c.coverageId + '/suspend', { reason: 'nope nope' })).status, 404);
});

test('preauth: request, exactly-once decision, isolation, threshold enforced on bills', async () => {
  const c = await amakaCover();
  const r = await cashier.post('/api/hmo/preauths', { patientId: h.ctx.patients.amaka.id, payerOrgId: h.ctx.orgs.hmo.id, coverageId: c.coverageId,
    services: [{ code: 'CONS-SPEC', name: 'x', category: 'consultation', qty: 4, amountKobo: 1 }], diagnosis: { code: 'I10', text: 'Hypertension' } });
  assert.equal(r.status, 200); assert.equal(r.body.status, 'pending');
  assert.equal(r.body.requestedKobo, N(15000) * 4, 'price from the price list, not the client');
  assert.equal((await rival.get('/api/payer/preauths/' + r.body.id)).status, 404);
  assert.equal((await rival.post('/api/payer/preauths/' + r.body.id + '/approve', { approvedKobo: 100 })).status, 404);
  const q = await officer.post('/api/payer/preauths/' + r.body.id + '/query', { question: 'Send BP readings' });
  assert.equal(q.body.status, 'queried');
  assert.equal((await cashier.post('/api/hmo/preauths/' + r.body.id + '/answer', { answer: '160/100 twice' })).body.status, 'pending');
  assert.equal((await officer.post('/api/payer/preauths/' + r.body.id + '/approve', { approvedKobo: N(70000) })).status, 400, 'not above requested');
  const [a, b] = await Promise.all([
    officer.post('/api/payer/preauths/' + r.body.id + '/approve', { approvedKobo: N(55000) }),
    officer.post('/api/payer/preauths/' + r.body.id + '/approve', { approvedKobo: N(55000) })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const pa = a.status === 200 ? a.body : b.body;
  assert.equal((await officer.post('/api/payer/preauths/' + r.body.id + '/deny', { reason: 'Too late' })).status, 409);
  // a 60k bill: above the 50k threshold, needs the preauth
  const bl = await bill('amaka', 'CONS-SPEC', 4);
  const no = await cashier.post('/api/hmo/bills/' + bl.id + '/apply-cover', { coverageId: c.coverageId });
  assert.equal(no.status, 409); assert.equal(no.body.code, 'preauth_required');
  if (pa) {
    const ok = await cashier.post('/api/hmo/bills/' + bl.id + '/apply-cover', { coverageId: c.coverageId, preauthId: pa.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.coveredKobo, N(55000)); assert.equal(ok.body.patientDueKobo, N(5000));
    const bl2 = await bill('amaka', 'CONS-SPEC', 4);
    const again = await cashier.post('/api/hmo/bills/' + bl2.id + '/apply-cover', { coverageId: c.coverageId, preauthId: pa.id });
    assert.equal(again.status, 409); assert.equal(again.body.code, 'preauth_used');
    assert.equal((await cashier.post('/api/hmo/bills/' + bl.id + '/apply-cover', { coverageId: c.coverageId })).status, 409, 'cover once per bill');
  }
});

test('cover never exceeds the limit under parallel apply', async () => {
  const en = await rival.post('/api/payer/coverages/enrol', { members: [{ phone: h.ctx.patients.amaka.phone, memberNo: 'RV-1', limits: { consultation: N(20000) }, validTo: '2030-12-31' }] });
  const pat = await h.as('patient', 'amaka@patient.demo');
  assert.equal((await pat.post('/api/me/coverages/' + en.body.results[0].coverageId + '/confirm')).body.status, 'active');
  const covId = en.body.results[0].coverageId;
  const bills = []; for (let i = 0; i < 5; i++) bills.push(await bill('amaka', 'CONS-GP'));
  const rs = await Promise.all(bills.map(b => cashier.post('/api/hmo/bills/' + b.id + '/apply-cover', { coverageId: covId })));
  const covered = rs.filter(r => r.status === 200).reduce((s, r) => s + r.body.coveredKobo, 0);
  assert.equal(covered, N(20000));
  assert.ok(rs.filter(r => r.status === 409).every(r => r.body.code === 'not_covered' || r.body.code === 'retry'));
  const v = await rival.get('/api/payer/coverages/' + covId);
  assert.equal(v.body.usedKobo.consultation, N(20000)); assert.equal(v.body.remainingKobo.consultation, 0);
});

test('claims: once per bill, one-way, exactly-once approve and pay, payer isolation', async () => {
  const c = await amakaCover();
  const open = await bill('amaka', 'INJ');
  const notPaid = await cashier.post('/api/hmo/claims', { billIds: [open.id] });
  assert.equal(notPaid.body.results[0].error, 'no_cover');
  const b = await bill('amaka', 'INJ');
  const ap = await cashier.post('/api/hmo/bills/' + b.id + '/apply-cover', { coverageId: c.coverageId });
  assert.equal(ap.status, 200); assert.equal(ap.body.bill.status, 'paid');
  const [s1, s2] = await Promise.all([cashier.post('/api/hmo/claims', { billIds: [b.id] }), cashier.post('/api/hmo/claims', { billIds: [b.id] })]);
  const oks = [s1, s2].map(r => r.body.results[0]).filter(r => r.ok);
  assert.equal(oks.length, 1, 'one claim per bill');
  const again = await cashier.post('/api/hmo/claims', { billIds: [b.id] }); assert.equal(again.body.results[0].error, 'already_claimed');
  const cid = oks[0].claimId;
  assert.ok(oks[0].flags.includes('no_evidence'), 'manual bill has no service record');
  // isolation
  assert.equal((await rival.get('/api/payer/claims/' + cid)).status, 404);
  assert.equal((await rival.post('/api/payer/claims/' + cid + '/review')).status, 404);
  assert.equal((await h.as('frontdesk', 'cashier@lekkifamily.demo').then(x => x.get('/api/hmo/claims/' + cid))).status, 404);
  // cannot approve before review
  assert.equal((await officer.post('/api/payer/claims/' + cid + '/approve', { approvedKobo: 100 })).status, 409);
  assert.equal((await officer.post('/api/payer/claims/' + cid + '/review')).body.status, 'under_review');
  assert.equal((await officer.post('/api/payer/claims/' + cid + '/query', { question: 'Which injection?' })).body.status, 'queried');
  assert.equal((await cashier.post('/api/hmo/claims/' + cid + '/resubmit', { answer: 'IM ceftriaxone' })).body.status, 'resubmitted');
  assert.equal((await officer.post('/api/payer/claims/' + cid + '/review')).body.status, 'under_review');
  const [a1, a2] = await Promise.all([officer.post('/api/payer/claims/' + cid + '/approve', { approvedKobo: N(1000) }), officer.post('/api/payer/claims/' + cid + '/approve', { approvedKobo: N(1000) })]);
  assert.deepEqual([a1.status, a2.status].sort(), [200, 409]);
  const approved = true; const a1b = a1.status === 200 ? a1 : a2;
  if (approved) {
    assert.equal(a1b.body.approvedKobo, N(1000), 'partial approval');
    assert.equal((await officer.post('/api/payer/claims/' + cid + '/deny', { reason: 'Changed mind' })).status, 409);
    assert.equal((await officer.post('/api/payer/claims/' + cid + '/pay', { paymentRef: 'X1' })).status, 403, 'officer cannot pay');
    const [p1, p2] = await Promise.all([manager.post('/api/payer/claims/' + cid + '/pay', { paymentRef: 'TRF-1' }), manager.post('/api/payer/claims/' + cid + '/pay', { paymentRef: 'TRF-2' })]);
    assert.deepEqual([p1.status, p2.status].sort(), [200, 409]);
    const fin = await cashier.get('/api/hmo/claims/' + cid); assert.equal(fin.body.status, 'paid'); assert.equal(fin.body.paidKobo, N(1000));
    assert.equal((await manager.post('/api/payer/claims/' + cid + '/review')).status, 409, 'paid is final');
  }
  const dash = await cashier.get('/api/hmo/dashboard'); assert.equal(dash.status, 200); assert.ok(dash.body.payers.length >= 1);
});

test('fraud flags: duplicate, frequency, missing_preauth', async () => {
  const c = await amakaCover();
  const ids = [];
  for (let i = 0; i < 4; i++) { const b = await bill('amaka', 'REG'); const r = await cashier.post('/api/hmo/bills/' + b.id + '/apply-cover', { coverageId: c.coverageId }); assert.equal(r.status, 200, JSON.stringify(r.body)); ids.push(b.id); }
  const r = await cashier.post('/api/hmo/claims', { billIds: ids });
  assert.equal(r.body.submitted, 4);
  assert.ok(r.body.results.every(x => x.flags.includes('duplicate')));
  assert.ok(r.body.results[3].flags.includes('frequency')); assert.ok(!r.body.results[0].flags.includes('frequency'));
  // lower the threshold below an already-covered amount: claim is flagged missing_preauth
  const s = await manager.patch('/api/payer/settings', { preauthThresholdKobo: N(10000) });
  assert.equal(s.status, 200);
  const b = await bill('amaka', 'CONS-SPEC');
  assert.equal((await cashier.post('/api/hmo/bills/' + b.id + '/apply-cover', { coverageId: c.coverageId })).body.code, 'preauth_required');
  await manager.patch('/api/payer/settings', { preauthThresholdKobo: N(50000) });
  assert.equal((await cashier.post('/api/hmo/bills/' + b.id + '/apply-cover', { coverageId: c.coverageId })).status, 200);
  await manager.patch('/api/payer/settings', { preauthThresholdKobo: N(10000) });
  const cl = await cashier.post('/api/hmo/claims', { billIds: [b.id] });
  assert.ok(cl.body.results[0].flags.includes('missing_preauth'));
  await manager.patch('/api/payer/settings', { preauthThresholdKobo: N(50000) });
  const flagged = await officer.get('/api/payer/claims?flagged=true'); assert.ok(flagged.body.length >= 5);
});

test('permissions and validation', async () => {
  const rec = await h.as('frontdesk', 'reception@grandville.demo');
  assert.equal((await rec.post('/api/hmo/claims', { billIds: ['bil_xxxxxxxx'] })).status, 403, 'receptionist cannot claim');
  assert.equal((await cashier.get('/api/payer/claims')).status, 403, 'provider staff not on payer desk');
  assert.equal((await cashier.post('/api/hmo/preauths', { patientId: h.ctx.patients.amaka.id })).status, 400);
  assert.equal((await officer.patch('/api/payer/settings', { preauthThresholdKobo: 1 })).status, 403);
});
