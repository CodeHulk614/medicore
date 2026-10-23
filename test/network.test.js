'use strict';
/* Provider network: directory, partnerships, private messages, referrals with record summary, HMO and consent. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

let h, ph, fdG, fdC, labM;
before(async () => {
  h = await boot();
  ph = await h.as('pharmacy', 'pharmacist@yabacare.demo');
  fdG = await h.as('frontdesk', 'reception@grandville.demo');
  fdC = await h.as('frontdesk', 'reception@lekkifamily.demo');
  labM = await h.as('lab', 'manager@clearpath.demo');
});
after(async () => { await h.close(); });

test('patients cannot see the provider directory; staff can', async () => {
  const pt = await h.as('patient', 'amaka@patient.demo');
  assert.equal((await pt.get('/api/network/providers')).status, 403);
  const r = await ph.get('/api/network/providers');
  assert.equal(r.status, 200);
  assert.ok(!r.body.some(o => o.type === 'hmo'), 'HMOs are not in the directory');
  const gv = r.body.find(o => o.id === h.ctx.orgs.hospital.id);
  assert.equal(gv.connection.status, 'accepted');
  assert.equal(r.body[0].id, h.ctx.orgs.hospital.id, 'partners first');
  const partners = await ph.get('/api/network/providers?partners=true');
  assert.deepEqual(partners.body.map(o => o.id), [h.ctx.orgs.hospital.id]);
  const prof = await ph.get('/api/network/providers/' + h.ctx.orgs.hospital.id);
  assert.ok(prof.body.partners.some(p => p.id === h.ctx.orgs.pharmacy.id), 'partnership is visible on the profile');
});

test('the demo referral arrives at the hospital front desk with the record summary', async () => {
  const inbox = await fdG.get('/api/referrals?box=in');
  assert.equal(inbox.status, 200); assert.equal(inbox.body.counts.newIn, 1);
  const r = inbox.body.referrals[0];
  assert.equal(r.number, 'RF000001'); assert.equal(r.urgency, 'urgent'); assert.equal(r.patientName, 'Tobi Adeyemi');
  const full = await fdG.get('/api/referrals/' + r.id);
  assert.ok(full.body.snapshot && full.body.snapshot.patient.name === 'Tobi Adeyemi');
  assert.ok(Array.isArray(full.body.snapshot.conditions) && full.body.snapshot.conditions.some(c => /diabetes/i.test(c.name)));
  assert.match(full.body.clinicalNote, /metformin/);
  // a third provider cannot read it
  assert.equal((await labM.get('/api/referrals/' + r.id)).status, 404);
});

test('accept, arrive (triage queue), outcome; the referrer and the patient are told', async () => {
  const r = (await fdG.get('/api/referrals?box=in')).body.referrals[0];
  assert.equal((await ph.post('/api/referrals/' + r.id + '/accept', {})).status, 403, 'sender cannot accept');
  const a = await fdG.post('/api/referrals/' + r.id + '/accept', { note: 'Come to the emergency desk' });
  assert.equal(a.status, 200); assert.equal(a.body.status, 'accepted'); assert.ok(a.body.receiverMrn);
  assert.equal((await fdG.post('/api/referrals/' + r.id + '/accept', {})).status, 409, 'exactly once');
  const arr = await fdG.post('/api/referrals/' + r.id + '/arrived', {});
  assert.equal(arr.status, 200); assert.ok(arr.body.queueId);
  const q = await h.db.col('queue').findOne({ id: arr.body.queueId });
  assert.equal(q.source, 'referral'); assert.equal(q.priority, 'urgent');
  const done = await fdG.post('/api/referrals/' + r.id + '/complete', { outcome: 'Admitted for blood sugar control. Discharge plan to follow.' });
  assert.equal(done.status, 200); assert.equal(done.body.status, 'completed');
  const out = await ph.get('/api/referrals/' + r.id);
  assert.match(out.body.outcome, /Admitted/);
  const notes = await h.db.col('notifications').find({ patientId: h.ctx.patients.tobi.id, kind: 'referral' });
  assert.ok(notes.some(n => /accepted/.test(n.title)), 'patient told about the acceptance');
  const mine = await (await h.as('patient', 'tobi@patient.demo')).get('/api/me/referrals');
  assert.equal(mine.body[0].status, 'completed'); assert.equal(mine.body[0].clinicalNote, undefined, 'no clinical note to the patient app');
});

test('send a referral: consent required (except emergencies), HMO cover attached, partner sees it', async () => {
  const doc = await h.as('doctor', 'dr.ada@lekkifamily.demo');
  const kunle = h.ctx.patients.kunle;
  const noConsent = await doc.post('/api/referrals', { patientId: kunle.id, toOrgId: h.ctx.orgs.lab.id, urgency: 'routine', service: 'lab', reason: 'INR check after dose change' });
  assert.equal(noConsent.status, 400);
  const r = await doc.post('/api/referrals', { patientId: kunle.id, toOrgId: h.ctx.orgs.lab.id, urgency: 'routine', service: 'lab', reason: 'INR check after dose change', consent: true, consentMethod: 'verbal' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'sent'); assert.ok(r.body.snapshot);
  const inbox = await labM.get('/api/referrals?box=in');
  assert.ok(inbox.body.referrals.some(x => x.id === r.body.id));
  const em = await doc.post('/api/referrals', { patientId: kunle.id, toOrgId: h.ctx.orgs.hospital.id, urgency: 'emergency', service: 'emergency_care', reason: 'Fast irregular pulse with chest pain' });
  assert.equal(em.status, 200, 'emergency without recorded consent is allowed'); assert.equal(em.body.consent.method, 'emergency');
  // not linked patient
  const notMine = await doc.post('/api/referrals', { patientId: h.ctx.patients.tobi.id, toOrgId: h.ctx.orgs.lab.id, urgency: 'routine', service: 'lab', reason: 'test reason', consent: true });
  assert.equal(notMine.status, 404);
  // decline with a reason, then cancel is impossible
  const d = await labM.post('/api/referrals/' + r.body.id + '/decline', { reason: 'No INR reagent this week' });
  assert.equal(d.status, 200); assert.equal(d.body.status, 'declined');
  assert.equal((await doc.post('/api/referrals/' + r.body.id + '/cancel', { reason: 'changed mind' })).status, 409);
});

test('HMO cover travels with the referral', async () => {
  const amaka = h.ctx.patients.amaka;
  const cov = await h.db.col('coverages').findOne({ patientId: amaka.id });
  assert.ok(cov, 'demo cover exists');
  if (cov.status !== 'active') await h.db.col('coverages').updateOne({ id: cov.id }, { $set: { status: 'active' } });
  const r = await fdC.post('/api/referrals', { patientId: amaka.id, toOrgId: h.ctx.orgs.hospital.id, urgency: 'elective', service: 'specialist', specialty: 'Cardiology', reason: 'Blood pressure not controlled on two drugs', consent: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.hmo.coverageId, cov.id); assert.ok(r.body.hmo.payerName);
});

test('partnerships: request, accept, private messages only between partners', async () => {
  const adm = await h.as('admin', 'admin.ikeja@crestview.demo');
  const conns = await adm.get('/api/network/connections');
  const req1 = conns.body.find(c => c.direction === 'in' && c.status === 'pending');
  assert.ok(req1, 'ClearPath asked to partner');
  const labAdm = await h.as('admin', 'owner@clearpath.demo');
  const early = await labAdm.post('/api/network/threads', { toOrgId: h.ctx.branches.ikeja.id, text: 'Hello' });
  assert.equal(early.status, 403, 'not partners yet');
  assert.equal((await adm.post('/api/network/connections/' + req1.id + '/accept')).status, 200);
  const th = await labAdm.post('/api/network/threads', { toOrgId: h.ctx.branches.ikeja.id, text: 'Our courier collects samples at 2 pm daily.' });
  assert.equal(th.status, 200);
  const list = await adm.get('/api/network/threads');
  const t = list.body.threads.find(x => x.id === th.body.id);
  assert.equal(t.unread, 1);
  const msgs = await adm.get('/api/network/threads/' + th.body.id + '/messages');
  assert.equal(msgs.body.messages[0].text, 'Our courier collects samples at 2 pm daily.');
  // another provider cannot read the thread
  const other = await h.as('admin', 'owner@yabacare.demo');
  assert.equal((await other.get('/api/network/threads/' + th.body.id + '/messages')).status, 404);
  // only network.manage roles can request partnerships
  assert.equal((await ph.post('/api/network/connections', { toOrgId: h.ctx.orgs.lab.id })).status, 403);
});

test('a provider can stop accepting referrals; HQ can require partnership first', async () => {
  const own = await h.as('admin', 'owner@swiftaid.demo');
  assert.equal((await own.patch('/api/admin/org', { settings: { acceptsReferrals: false } })).status, 200);
  const doc = await h.as('doctor', 'dr.tunde@grandville.demo');
  const r = await doc.post('/api/referrals', { patientId: h.ctx.patients.amaka.id, toOrgId: h.ctx.orgs.ambulance.id, urgency: 'routine', service: 'ambulance', reason: 'Transfer for dialysis', consent: true });
  assert.equal(r.status, 403);
  const hq = await h.as('hq', 'hq@medicore.demo');
  await hq.patch('/api/hq/config/process', { patch: { referrals: { requireConnection: true } } });
  const r2 = await doc.post('/api/referrals', { patientId: h.ctx.patients.amaka.id, toOrgId: h.ctx.orgs.lab.id, urgency: 'routine', service: 'lab', reason: 'Lipid profile', consent: true });
  assert.equal(r2.status, 403, 'not partners');
  const r3 = await (await h.as('pharmacy', 'pharmacist@yabacare.demo')).post('/api/referrals', { patientId: h.ctx.patients.tobi.id, toOrgId: h.ctx.orgs.hospital.id, urgency: 'routine', service: 'consultation', reason: 'Review of medicines', consent: true });
  assert.equal(r3.status, 200, 'partners can still refer');
  await hq.patch('/api/hq/config/process', { patch: { referrals: { requireConnection: false } } });
});
