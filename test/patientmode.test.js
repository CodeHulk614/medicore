'use strict';
/* Provider patient mode (default): patients belong to their providers; one provider at a time; applications. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

let h, amaka;
before(async () => { h = await boot(); amaka = await h.as('patient', 'amaka@patient.demo'); });
after(async () => { await h.close(); });
const P = key => ({ 'X-MC-Provider': key });

test('the patient app lists the patient\'s providers and the mode', async () => {
  const s = await amaka.get('/api/me/providers/summary');
  assert.equal(s.status, 200); assert.equal(s.body.mode, 'provider'); assert.equal(s.body.crossProviderSharing, false);
  assert.equal(s.body.providers.length, 4);
  const cfg = await amaka.get('/api/meta/config');
  assert.equal(cfg.body.patients.mode, 'provider');
});

test('choosing a provider scopes every list to it', async () => {
  const hosp = h.ctx.orgs.hospital.id, clinic = h.ctx.orgs.clinic.id;
  const all = await amaka.get('/api/me/appointments');
  const onlyClinic = await amaka.get('/api/me/appointments', P(clinic));
  assert.ok(onlyClinic.body.every(a => a.orgId === clinic || (a.org && a.org.id === clinic)));
  assert.ok(all.body.length >= onlyClinic.body.length);
  const bills = await amaka.get('/api/me/bills', P(hosp));
  assert.ok(bills.body.every(b => b.orgId === hosp));
  const docs = await amaka.get('/doctors'.replace('/doctors', '/api/doctors'), P(clinic));
  assert.ok(docs.body.length > 0 && docs.body.every(d => d.orgId === clinic), 'find care shows the chosen provider only');
  const dir = await amaka.get('/api/directory', P(hosp));
  assert.deepEqual(dir.body.map(o => o.id), [hosp]);
  // a header for a provider the patient does not belong to gives nothing extra
  const foreign = await amaka.get('/api/me/bills', P(h.ctx.orgs.ambulance.id));
  assert.ok(foreign.body.every(b => [hosp, clinic, h.ctx.orgs.pharmacy.id, h.ctx.orgs.lab.id].includes(b.orgId)));
});

test('no marketplace: patients cannot see or book doctors of providers they do not belong to', async () => {
  const kunle = await h.as('patient', 'kunle@patient.demo'); // clinic + lab only
  const docs = await kunle.get('/api/doctors');
  assert.ok(docs.body.every(d => d.orgId === h.ctx.orgs.clinic.id));
  const hospDoc = await h.db.col('schedules').findOne({ orgId: h.ctx.orgs.hospital.id });
  assert.ok(hospDoc);
  assert.equal((await kunle.get('/api/doctors/' + hospDoc.membershipId)).status, 404);
  const book = await kunle.post('/api/me/appointments', { doctorMembershipId: hospDoc.membershipId, date: '2030-01-07', time: '10:00', type: 'in_person' });
  assert.equal(book.status, 404);
  const anon = await h.client('patient').get('/api/doctors');
  assert.equal(anon.body.length, 0, 'no public doctor marketplace in provider mode');
});

test('record sharing between providers is off in provider mode', async () => {
  const r = await amaka.post('/api/me/providers/' + h.ctx.orgs.clinic.id + '/share', { share: true });
  assert.equal(r.status, 403);
  const doc = await h.as('doctor', 'dr.ada@lekkifamily.demo');
  const chart = await doc.get('/api/doc/patients/' + h.ctx.patients.amaka.id + '/chart');
  assert.equal(chart.status, 200);
  assert.ok(chart.body.encounters.every(e => e.own), 'only the clinic\'s own records');
});

test('prescriptions go to own or partner pharmacies only', async () => {
  const kunle = await h.as('patient', 'kunle@patient.demo');
  const part = await kunle.get('/api/me/partners?module=pharmacy');
  assert.equal(part.status, 200);
  assert.ok(!part.body.some(o => o.id === h.ctx.orgs.pharmacy.id), 'Yaba Care is not a partner of the clinic');
  const rx = await h.db.col('prescriptions').findOne({ patientId: h.ctx.patients.kunle.id, status: 'active' });
  if (rx && !rx.routedTo) {
    const r = await kunle.post('/api/me/prescriptions/' + rx.id + '/send', { pharmacyOrgId: h.ctx.orgs.pharmacy.id, fulfilment: 'pickup' });
    assert.equal(r.status, 403);
  }
  const tobi = await h.as('patient', 'tobi@patient.demo');
  const tp = await tobi.get('/api/me/partners?module=pharmacy');
  assert.ok(tp.body.some(o => o.id === h.ctx.orgs.pharmacy.id && o.yours));
});

test('apply to join a provider; the front desk approves; then the provider appears', async () => {
  const kunle = await h.as('patient', 'kunle@patient.demo');
  const list = await kunle.get('/api/join/providers?q=Crestview');
  assert.equal(list.body.length, 1); assert.equal(list.body[0].kind, 'group'); assert.equal(list.body[0].branches.length, 2);
  const ikeja = list.body[0].branches.find(b => b.branchName === 'Ikeja');
  const a = await kunle.post('/api/me/applications', { orgId: ikeja.id, note: 'Closer to my office' });
  assert.equal(a.status, 200); assert.equal(a.body.approved, false);
  assert.equal((await kunle.post('/api/me/applications', { orgId: ikeja.id })).status, 409, 'one pending application per provider');
  const fd = await h.as('frontdesk', 'reception.ikeja@crestview.demo');
  const q = await fd.get('/api/fd/applications');
  const mine = q.body.find(x => x.id === a.body.application.id);
  assert.ok(mine && mine.patient.name === 'Kunle Martins' && mine.note === 'Closer to my office');
  const other = await h.as('frontdesk', 'reception@grandville.demo');
  assert.equal((await other.post('/api/fd/applications/' + mine.id + '/approve')).status, 404);
  const ok = await fd.post('/api/fd/applications/' + mine.id + '/approve');
  assert.equal(ok.status, 200); assert.ok(ok.body.patient.mrn);
  assert.equal((await fd.post('/api/fd/applications/' + mine.id + '/approve')).status, 409);
  const sum = await kunle.get('/api/me/providers/summary');
  assert.ok(sum.body.providers.some(p => p.name === 'Crestview Hospitals'));
});

test('decline with a reason; a front desk without the permission cannot decide', async () => {
  const tobiApp = await h.db.col('patient_applications').findOne({ patientId: h.ctx.patients.tobi.id, status: 'pending' });
  const cashier = await h.as('frontdesk', 'cashier@grandville.demo');
  assert.equal((await cashier.get('/api/fd/applications')).status, 403);
  const fd = await h.as('frontdesk', 'reception.ajah@crestview.demo');
  assert.equal((await fd.post('/api/fd/applications/' + tobiApp.id + '/decline', {})).status, 400);
  const d = await fd.post('/api/fd/applications/' + tobiApp.id + '/decline', { reason: 'Please register in person with your ID' });
  assert.equal(d.status, 200); assert.equal(d.body.status, 'declined');
  const note = await h.db.col('notifications').findOne({ patientId: h.ctx.patients.tobi.id, kind: 'patient_application' });
  assert.ok(note);
});

test('a provider can stop online applications; HQ can switch off approval or multiple providers', async () => {
  const adm = await h.as('admin', 'owner@swiftaid.demo');
  await adm.patch('/api/admin/org', { settings: { acceptsPatientApplications: false } });
  const tobi = await h.as('patient', 'tobi@patient.demo');
  assert.equal((await tobi.post('/api/me/applications', { orgId: h.ctx.orgs.ambulance.id })).status, 403);
  const hq = await h.as('hq', 'hq@medicore.demo');
  await hq.patch('/api/hq/config/process', { patch: { patients: { applicationsNeedApproval: false } } });
  const r = await tobi.post('/api/me/applications', { orgId: h.ctx.orgs.lab.id });
  assert.equal(r.status, 200); assert.equal(r.body.approved, true); assert.ok(r.body.mrn);
  await hq.patch('/api/hq/config/process', { patch: { patients: { applicationsNeedApproval: true, allowMultipleProviders: false } } });
  assert.equal((await tobi.post('/api/me/applications', { orgId: h.ctx.orgs.clinic.id })).status, 403);
  await hq.patch('/api/hq/config/process', { patch: { patients: { allowMultipleProviders: true } } });
  assert.equal((await hq.patch('/api/hq/config/process', { patch: { patients: { mode: 'everyone' } } })).status, 400);
});

test('switching HQ to open mode restores the marketplace', async () => {
  const hq = await h.as('hq', 'hq@medicore.demo');
  await hq.patch('/api/hq/config/process', { patch: { patients: { mode: 'open' } } });
  const kunle = await h.as('patient', 'kunle@patient.demo');
  const docs = await kunle.get('/api/doctors');
  assert.ok(docs.body.some(d => d.orgId === h.ctx.orgs.hospital.id));
  await hq.patch('/api/hq/config/process', { patch: { patients: { mode: 'provider' } } });
});
