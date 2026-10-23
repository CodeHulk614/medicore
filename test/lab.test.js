'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

let h, L, rec, sci, mgr, cashier, kunle, amaka, drAda;
before(async () => {
  h = await boot({ patientMode: 'open' });
  L = require('../src/modules/lab');
  rec = await h.as('lab', 'reception@clearpath.demo');
  sci = await h.as('lab', 'scientist@clearpath.demo');
  mgr = await h.as('lab', 'manager@clearpath.demo');
  cashier = await h.as('frontdesk', 'cashier@clearpath.demo');
  kunle = await h.as('patient', 'kunle@patient.demo');
  amaka = await h.as('patient', 'amaka@patient.demo');
  drAda = await h.as('doctor', 'dr.ada@lekkifamily.demo');
});
after(async () => { await h.close(); });

const pay = async (billId) => { const b = await h.db.col('bills').findOne({ id: billId }); return cashier.post('/api/bills/' + billId + '/cash', { method: 'pos', amountKobo: b.patientDueKobo, receiptNo: 'R' + Math.random().toString(36).slice(2, 8) }); };
const clinicOrder = (patient, tests, extra = {}) => L.createLabOrder(Object.assign({ referringOrgId: h.ctx.orgs.clinic.id, labOrgId: h.ctx.orgs.lab.id, patientId: h.ctx.patients[patient].id, tests: tests.map(code => ({ code })),
  orderedByUserId: h.ctx.staff.clinic['dr.ada'].user.id, orderedByName: 'Dr. Ada Nwosu', priority: 'routine' }, extra));

test('public test list and catalogue management', async () => {
  const pub = await h.client('patient').get('/api/labs/' + h.ctx.orgs.lab.id + '/tests');
  assert.equal(pub.status, 200);
  const fbc = pub.body.tests.find(x => x.code === 'FBC');
  assert.equal(fbc.priceKobo, 650000); assert.equal(fbc.panel.length, 4);
  assert.equal((await h.client('patient').get('/api/labs/' + h.ctx.orgs.clinic.id + '/tests')).status, 404, 'a clinic is not a lab');
  const labs = (await h.client('patient').get('/api/labs?codes=INR,FBC')).body;
  assert.deepEqual(labs.map(l => l.name).sort(), ['ClearPath Diagnostics', 'Grandville Hospital']);
  assert.equal(labs.find(l => l.name === 'ClearPath Diagnostics').totalKobo, 800000 + 650000);
  assert.equal((await sci.req('PUT', '/api/lab/catalog/PSA', { priceKobo: 100 })).status, 403, 'scientist cannot edit prices');
  assert.equal((await mgr.req('PUT', '/api/lab/catalog/NOPE', { priceKobo: 100 })).status, 404);
  const up = await mgr.req('PUT', '/api/lab/catalog/INR', { priceKobo: 900000, tatHours: 3, range: { low: 0.9, high: 1.3, critHigh: 4.5 } });
  assert.equal(up.status, 200); assert.equal(up.body.range.critHigh, 4.5); assert.equal(up.body.range.low, 0.9);
  assert.equal((await mgr.req('PUT', '/api/lab/catalog/INR', { range: { low: 5, high: 1 } })).status, 400);
});

let inrOrder;
test('patient sends an awaiting order to a lab that offers every test; bill once', async () => {
  const list = (await kunle.get('/api/me/lab-orders')).body;
  const awaiting = list.find(o => o.status === 'awaiting_lab');
  assert.ok(awaiting); assert.equal(awaiting.tests[0].code, 'INR');
  assert.equal((await kunle.post('/api/me/lab-orders/' + awaiting.id + '/send', { labOrgId: h.ctx.orgs.clinic.id })).status, 404);
  // lab must offer ALL ordered tests
  const two = await L.createLabOrder({ referringOrgId: h.ctx.orgs.clinic.id, labOrgId: null, patientId: h.ctx.patients.kunle.id, tests: [{ code: 'INR' }, { code: 'PSA' }], orderedByUserId: null, orderedByName: 'Dr. Ada Nwosu' });
  await mgr.req('PUT', '/api/lab/catalog/PSA', { active: false });
  const miss = await kunle.post('/api/me/lab-orders/' + two.id + '/send', { labOrgId: h.ctx.orgs.lab.id });
  assert.equal(miss.status, 400); assert.match(miss.body.error, /PSA/);
  const [a, b] = await Promise.all([kunle.post('/api/me/lab-orders/' + awaiting.id + '/send', { labOrgId: h.ctx.orgs.lab.id }), kunle.post('/api/me/lab-orders/' + awaiting.id + '/send', { labOrgId: h.ctx.orgs.lab.id })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const sent = a.status === 200 ? a.body : b.body;
  assert.equal(sent.status, 'ordered'); assert.equal(sent.lab.name, 'ClearPath Diagnostics');
  const bills = await h.db.col('bills').find({ 'source.type': 'lab_order', 'source.id': awaiting.id });
  assert.equal(bills.length, 1); assert.equal(bills[0].totalKobo, 900000, 'priced from the lab catalogue');
  inrOrder = sent;
  assert.equal((await kunle.post('/api/me/lab-orders/' + awaiting.id + '/send', { labOrgId: h.ctx.orgs.lab.id })).status, 409);
});

test('unpaid order cannot be collected; payment only through billing', async () => {
  const id = inrOrder.id;
  const r = await rec.post('/api/lab/orders/' + id + '/receive', {});
  assert.equal(r.status, 409); assert.equal(r.body.code, 'payment_required');
  assert.equal((await rec.post('/api/lab/orders/' + id + '/receive', { urgentOverride: { reason: 'Doctor asked' } })).status, 403, 'routine order: no override');
  assert.equal((await pay(inrOrder.billId)).status, 200);
  const w = (await rec.get('/api/lab/worklist?status=paid')).body;
  assert.ok(w.some(o => o.id === id && o.paid && o.paidVia === 'pos'));
  const [x, y] = await Promise.all([rec.post('/api/lab/orders/' + id + '/receive', {}), rec.post('/api/lab/orders/' + id + '/receive', {})]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  const got = x.status === 200 ? x.body : y.body;
  assert.match(got.accession, /^CLEAR-\d{6}-\d{4}$/); assert.equal(got.tatHours, 3);
  const look = await rec.get('/api/lab/accession/' + got.accession);
  assert.equal(look.status, 200); assert.equal(look.body.id, id); assert.equal(look.body.patient.name, 'Kunle Martins');
  const other = await h.as('lab', 'lab@grandville.demo');
  assert.equal((await other.get('/api/lab/accession/' + got.accession)).status, 404);
});

test('urgent order may be collected before payment with an audited reason', async () => {
  const o = await clinicOrder('amaka', ['RBS'], { priority: 'urgent' });
  const r = await rec.post('/api/lab/orders/' + o.id + '/receive', { urgentOverride: { reason: 'Patient drowsy, glucose needed now' } });
  assert.equal(r.status, 200); assert.equal(r.body.urgentOverride, true); assert.equal(r.body.paid, false);
  assert.ok(await h.db.col('audit').findOne({ action: 'lab.receive_urgent_override', targetId: o.id }));
  // HQ can switch collect-before-payment off for urgent orders
  const S = require('../src/lib/settings');
  await S.saveSection('process', { lab: { collectBeforePaymentForUrgent: false } }, { by: 'test' });
  const o2 = await clinicOrder('amaka', ['RBS'], { priority: 'urgent' });
  assert.equal((await rec.post('/api/lab/orders/' + o2.id + '/receive', { urgentOverride: { reason: 'Patient drowsy again' } })).status, 403);
  await S.saveSection('process', { lab: { collectBeforePaymentForUrgent: true } }, { by: 'test' });
  await pay(o.billId);
  const after = await h.db.col('lab_orders').findOne({ id: o.id });
  assert.equal(after.status, 'sample_collected', 'payment does not move the workflow back'); assert.equal(after.paid, true);
});

test('results: only from in progress, server flags (client flag ignored), unverified blocks release, critical callback', async () => {
  const id = inrOrder.id;
  assert.equal((await sci.post('/api/lab/orders/' + id + '/results', { results: [{ code: 'INR', value: '2.0' }] })).status, 409, 'not started yet');
  assert.equal((await sci.post('/api/lab/orders/' + id + '/start')).status, 200);
  assert.equal((await rec.post('/api/lab/orders/' + id + '/results', { results: [{ code: 'INR', value: '2.0' }] })).status, 403, 'reception cannot enter results');
  assert.equal((await sci.post('/api/lab/orders/' + id + '/results', { results: [{ code: 'HB', value: '12' }] })).status, 400, 'code not in order');
  assert.equal((await sci.post('/api/lab/orders/' + id + '/results', { results: [{ code: 'ZZZ', value: '1' }] })).status, 400);
  // non-numeric value for a numeric test: stored as unverified, cannot be verified
  const bad = await sci.post('/api/lab/orders/' + id + '/results', { results: [{ code: 'INR', value: 'clotted' }] });
  assert.equal(bad.status, 200); assert.equal(bad.body.results[0].flag, 'unverified'); assert.equal(bad.body.hasUnverified, true);
  const v1 = await mgr.post('/api/lab/orders/' + id + '/verify');
  assert.equal(v1.status, 409); assert.equal(v1.body.code, 'unverified_values');
  assert.equal((await sci.post('/api/lab/orders/' + id + '/reopen', { reason: 'Re-collected sample' })).status, 200);
  // the client says "normal"; the lab's range (critHigh 4.5) says high and critical
  const ok = await sci.post('/api/lab/orders/' + id + '/results', { results: [{ code: 'INR', value: '5.2', flag: 'normal', critical: false }] });
  assert.equal(ok.status, 200); assert.equal(ok.body.results[0].flag, 'high'); assert.equal(ok.body.results[0].critical, true); assert.equal(ok.body.results[0].range.high, 1.3);
  assert.equal((await mgr.post('/api/lab/orders/' + id + '/verify')).status, 200);
  assert.equal((await mgr.post('/api/lab/orders/' + id + '/verify')).status, 409, 'verify once');
  assert.equal((await kunle.get('/api/me/lab-orders/' + id + '/report')).status, 409, 'not released yet');
  const [r1, r2] = await Promise.all([mgr.post('/api/lab/orders/' + id + '/release'), mgr.post('/api/lab/orders/' + id + '/release')]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const pn = await h.db.col('notifications').find({ patientId: h.ctx.patients.kunle.id, kind: 'lab_result', 'ref.id': id });
  assert.equal(pn.length, 1, 'patient notified once');
  const docNotes = (await drAda.get('/api/notifications')).body;
  assert.ok(docNotes.some(n => n.kind === 'lab_critical' && n.ref.id === id), 'referring doctor gets an urgent notification');
  const wl = (await mgr.get('/api/lab/worklist')).body;
  assert.ok(wl.find(o => o.id === id).criticalPending);
  const cb = await sci.post('/api/lab/orders/' + id + '/critical-callback', { to: 'Dr. Ada Nwosu', method: 'phone' });
  assert.equal(cb.status, 200); assert.equal(cb.body.critical.acknowledged, true); assert.equal(cb.body.critical.callbacks[0].to, 'Dr. Ada Nwosu'); assert.ok(cb.body.critical.callbacks[0].at);
  const rep = await kunle.get('/api/me/lab-orders/' + id + '/report');
  assert.equal(rep.status, 200); assert.equal(rep.body.verifiedBy.name, 'Funke Ojo'); assert.ok(rep.body.releasedAt); assert.equal(rep.body.results[0].range.critHigh, 4.5);
});

test('amended results keep history and need a reason', async () => {
  const id = inrOrder.id;
  assert.equal((await mgr.post('/api/lab/orders/' + id + '/amend', { results: [{ code: 'INR', value: '3.1' }] })).status, 400, 'reason required');
  assert.equal((await mgr.post('/api/lab/orders/' + id + '/amend', { reason: 'Transcription error', results: [{ code: 'INR', value: 'abc' }] })).status, 400);
  const a = await mgr.post('/api/lab/orders/' + id + '/amend', { reason: 'Transcription error on analyser print-out', results: [{ code: 'INR', value: '3.1' }] });
  assert.equal(a.status, 200); assert.equal(a.body.version, 2); assert.equal(a.body.results[0].value, '3.1'); assert.equal(a.body.results[0].critical, false);
  const full = (await mgr.get('/api/lab/orders/' + id)).body;
  assert.equal(full.versions.length, 1); assert.equal(full.versions[0].results[0].value, '5.2'); assert.equal(full.versions[0].version, 1);
  const rep = (await kunle.get('/api/me/lab-orders/' + id + '/report')).body;
  assert.equal(rep.amended, true); assert.equal(rep.amendments[0].reason, 'Transcription error on analyser print-out'); assert.equal(rep.results[0].value, '3.1');
  assert.ok(await h.db.col('audit').findOne({ action: 'lab.amend', targetId: id }));
});

test('two-step verification needs a different scientist', async () => {
  const owner = await h.as('admin', 'owner@grandville.demo');
  assert.equal((await owner.patch('/api/admin/org', { settings: { twoStepLabVerify: true } })).status, 200);
  const s1 = await h.as('lab', 'lab@grandville.demo');
  const s2 = await h.as('lab', 'lab2@grandville.demo');
  const o = (await s1.get('/api/lab/worklist?status=in_progress')).body[0];
  assert.ok(o, 'seeded in-progress order at the hospital lab');
  const res = await s1.post('/api/lab/orders/' + o.id + '/results', { results: [{ code: 'RBS', value: '14.2' }, { code: 'NA', value: '131' }, { code: 'K', value: '4.0' }, { code: 'UREA', value: '9.1' }, { code: 'CREAT', value: '102' }] });
  assert.equal(res.status, 200);
  assert.equal((await s1.post('/api/lab/orders/' + o.id + '/verify')).status, 403);
  assert.equal((await s2.post('/api/lab/orders/' + o.id + '/verify')).status, 200);
});

test('incomplete result sets are rejected', async () => {
  const s1 = await h.as('lab', 'lab@grandville.demo');
  const o = await L.createLabOrder({ referringOrgId: h.ctx.orgs.hospital.id, labOrgId: h.ctx.orgs.hospital.id, patientId: h.ctx.patients.tobi.id, tests: [{ code: 'FBC' }], orderedByUserId: h.ctx.staff.hospital['dr.tunde'].user.id, orderedByName: 'Dr. Tunde Bello', priority: 'urgent' });
  await s1.post('/api/lab/orders/' + o.id + '/receive', { urgentOverride: { reason: 'Emergency department' } });
  await s1.post('/api/lab/orders/' + o.id + '/start');
  const r = await s1.post('/api/lab/orders/' + o.id + '/results', { results: [{ code: 'HB', value: '13' }] });
  assert.equal(r.status, 400); assert.match(r.body.error, /WBC/);
});

test('isolation: another lab gets 404, patients see only their own, clinic sees what it referred', async () => {
  const seeded = (await amaka.get('/api/me/lab-orders')).body.find(o => o.status === 'released');
  const otherLab = await h.as('lab', 'lab@grandville.demo');
  assert.equal((await otherLab.get('/api/lab/orders/' + seeded.id)).status, 404);
  assert.equal((await otherLab.post('/api/lab/orders/' + seeded.id + '/amend', { reason: 'Trying to change', results: [{ code: 'HB', value: '15' }] })).status, 404);
  assert.equal((await kunle.get('/api/me/lab-orders/' + seeded.id + '/report')).status, 404);
  assert.ok(!(await kunle.get('/api/me/lab-orders')).body.some(o => o.id === seeded.id));
  // referring clinic sees it (Amaka does not share history with the clinic)
  const ref = await drAda.get('/api/lab/patient-results/' + h.ctx.patients.amaka.id);
  assert.equal(ref.status, 200); assert.ok(ref.body.some(r => r.id === seeded.id && r.results.find(x => x.code === 'MP').flag === 'abnormal'));
  assert.ok((await drAda.get('/api/lab/referred')).body.some(r => r.id === seeded.id));
  // the hospital sees it only because Amaka shares her history with the hospital
  const tunde = await h.as('doctor', 'dr.tunde@grandville.demo');
  assert.ok((await tunde.get('/api/lab/patient-results/' + h.ctx.patients.amaka.id)).body.some(r => r.id === seeded.id));
  await h.db.col('patient_links').updateOne({ orgId: h.ctx.orgs.hospital.id, patientId: h.ctx.patients.amaka.id }, { $set: { shareHistory: false } });
  assert.ok(!(await tunde.get('/api/lab/patient-results/' + h.ctx.patients.amaka.id)).body.some(r => r.id === seeded.id));
  assert.equal((await tunde.get('/api/lab/patient-results/' + h.ctx.patients.kunle.id)).status, 404, 'not linked');
});

test('self-requested tests, walk-in orders and turnaround', async () => {
  assert.equal((await amaka.post('/api/me/lab-requests', { labOrgId: h.ctx.orgs.lab.id, tests: ['NOPE'] })).status, 400);
  const s = await amaka.post('/api/me/lab-requests', { labOrgId: h.ctx.orgs.lab.id, tests: ['FBS', 'HBA1C'] });
  assert.equal(s.status, 200); assert.equal(s.body.selfRequested, true); assert.equal(s.body.bill.totalKobo, 200000 + 1200000);
  const walk = await rec.post('/api/lab/orders', { patientId: h.ctx.patients.kunle.id, tests: ['ESR'], referrerName: 'Dr. Okafor (paper referral)' });
  assert.equal(walk.status, 200); assert.equal(walk.body.source, 'walk_in');
  assert.equal((await rec.post('/api/lab/orders', { patientId: h.ctx.patients.tobi.id, tests: ['ESR'] })).status, 404, 'patient not linked to this lab');
  await pay(walk.body.billId);
  await rec.post('/api/lab/orders/' + walk.body.id + '/receive', {});
  await h.db.col('lab_orders').updateOne({ id: walk.body.id }, { $set: { 'specimen.collectedAt': Date.now() - 5 * 3600e3 } });
  const wl = (await rec.get('/api/lab/worklist?overdue=true')).body;
  assert.ok(wl.some(o => o.id === walk.body.id && o.overdue && o.minutesLeft < 0));
});
