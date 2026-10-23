'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

let h, amaka, tobi, kunle, tunde, ada, recH, nurseH, recK, adminH, fdmH, cashH;
const used = new Set();

before(async () => {
  h = await boot({ patientMode: 'open' });
  // one sign-in per account: the login rate limit is 30 per 5 minutes per IP
  amaka = await h.as('patient', 'amaka@patient.demo');
  tobi = await h.as('patient', 'tobi@patient.demo');
  kunle = await h.as('patient', 'kunle@patient.demo');
  tunde = await h.as('doctor', 'dr.tunde@grandville.demo');
  ada = await h.as('doctor', 'dr.ada@lekkifamily.demo');
  recH = await h.as('frontdesk', 'reception@grandville.demo');
  nurseH = await h.as('frontdesk', 'nurse@grandville.demo');
  recK = await h.as('frontdesk', 'reception@lekkifamily.demo');
  fdmH = await h.as('frontdesk', 'fdmanager@grandville.demo');
  cashH = await h.as('frontdesk', 'cashier@grandville.demo');
  adminH = await h.as('admin', 'admin@grandville.demo');
});
after(async () => { await h.close(); });

const put = (c, path, b) => c.req('PUT', path, b);
const mem = (org, key) => h.ctx.staff[org][key].membership.id;
const ids = () => ({ amaka: h.ctx.patients.amaka.id, tobi: h.ctx.patients.tobi.id, zainab: h.ctx.patients.zainab.id, kunle: h.ctx.patients.kunle.id });

/** next free slot for a doctor that no other test has used yet */
async function freeSlot(client, membershipId) {
  const { todayLagos, addDays } = require('../src/lib/util');
  for (let i = 0; i < 20; i++) {
    const date = addDays(todayLagos(), i);
    const r = await client.get('/api/doctors/' + membershipId + '/slots?date=' + date);
    assert.equal(r.status, 200);
    const s = r.body.slots.find(x => x.available && !used.has(membershipId + date + x.time));
    if (s) { used.add(membershipId + date + s.time); return { date, time: s.time }; }
  }
  throw new Error('no free slot');
}
async function payDemo(patient, billId) {
  const p = await patient.post('/api/me/bills/' + billId + '/pay');
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const c = await patient.post('/api/pay/demo/' + p.body.paymentId + '/complete');
  assert.equal(c.status, 200);
}
/** walk-in for a doctor and the doctor starts the consultation */
async function openEncounter(desk, doctor, patientId, doctorMembershipId) {
  const q = await desk.post('/api/fd/queue', { patientId, servicePoint: 'doctor', doctorMembershipId, complaint: 'Review' });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  const e = await doctor.post('/api/doc/encounters', { queueId: q.body.id });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  return e.body;
}

test('doctor directory and computed slots', async () => {
  const pub = h.client('patient');
  const list = await pub.get('/api/doctors');
  assert.equal(list.status, 200);
  const names = list.body.map(d => d.name);
  assert.ok(names.includes('Dr. Tunde Bello') && names.includes('Dr. Ada Nwosu'));
  const tb = list.body.find(d => d.membershipId === mem('hospital', 'dr.tunde'));
  assert.equal(tb.feeKobo, 800000); assert.equal(tb.videoFeeKobo, 600000); assert.equal(tb.slotMin, 20);
  const clinicOnly = await pub.get('/api/doctors?orgId=' + h.ctx.orgs.clinic.id);
  assert.ok(clinicOnly.body.every(d => d.orgId === h.ctx.orgs.clinic.id) && clinicOnly.body.length === 2);
  assert.equal(clinicOnly.body.find(d => d.name === 'Dr. Ada Nwosu').feeKobo, 1000000);
  const spec = await pub.get('/api/doctors?specialty=internal');
  assert.ok(spec.body.length >= 1 && spec.body.every(d => /internal/i.test(d.specialty)));
  // a Sunday has no slots; a working day has 24 slots of 20 minutes from 09:00 to 17:00
  const { todayLagos, addDays } = require('../src/lib/util');
  let d = addDays(todayLagos(), 1); while (new Date(d + 'T00:00:00Z').getUTCDay() !== 0) d = addDays(d, 1);
  const sun = await pub.get('/api/doctors/' + mem('hospital', 'dr.tunde') + '/slots?date=' + d);
  assert.equal(sun.body.slots.length, 0);
  const mon = await pub.get('/api/doctors/' + mem('hospital', 'dr.tunde') + '/slots?date=' + addDays(d, 1));
  assert.equal(mon.body.slots.length, 24); assert.equal(mon.body.slots[0].time, '09:00'); assert.equal(mon.body.slots[23].time, '16:40');
  assert.equal((await pub.get('/api/doctors/' + mem('hospital', 'reception') + '/slots?date=' + d)).status, 404, 'non-doctors are not listed');
});

test('booking happy path: slot taken, bill raised from the doctor fee, visible to patient and front desk', async () => {
  const s = await freeSlot(amaka, mem('hospital', 'dr.tunde'));
  const r = await amaka.post('/api/me/appointments', { doctorMembershipId: mem('hospital', 'dr.tunde'), date: s.date, time: s.time, type: 'in_person', reason: 'Headache', feeKobo: 1, status: 'completed' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'booked'); assert.equal(r.body.feeKobo, 800000); assert.ok(r.body.billId); assert.equal(r.body.paid, false);
  assert.equal(r.body.orgName, 'Grandville Hospital'); assert.equal(r.body.doctorName, 'Dr. Tunde Bello');
  const bills = await amaka.get('/api/me/bills');
  const bill = bills.body.find(b => b.id === r.body.billId);
  assert.equal(bill.totalKobo, 800000); assert.deepEqual(bill.source, { type: 'appointment', id: r.body.id });
  const slots = await amaka.get('/api/doctors/' + mem('hospital', 'dr.tunde') + '/slots?date=' + s.date);
  assert.equal(slots.body.slots.find(x => x.time === s.time).available, false);
  const up = await amaka.get('/api/me/appointments?scope=upcoming');
  assert.ok(up.body.some(a => a.id === r.body.id && a.canCancel === (a.startUtc - Date.now() > 2 * 3600e3)));
  const fd = await recH.get('/api/fd/appointments?date=' + s.date);
  const row = fd.body.find(a => a.id === r.body.id);
  assert.equal(row.patient.name, 'Amaka Eze'); assert.ok(row.patient.mrn);
  const mine = await tunde.get('/api/doc/appointments?date=' + s.date);
  assert.ok(mine.body.some(a => a.id === r.body.id));
});

test('double booking the same slot is rejected, also in parallel', async () => {
  const doc = mem('hospital', 'dr.tunde');
  const s = await freeSlot(tobi, doc);
  const first = await tobi.post('/api/me/appointments', { doctorMembershipId: doc, date: s.date, time: s.time, type: 'in_person' });
  assert.equal(first.status, 200);
  const second = await kunle.post('/api/me/appointments', { doctorMembershipId: doc, date: s.date, time: s.time, type: 'in_person' });
  assert.equal(second.status, 409); assert.equal(second.body.code, 'slot_taken');
  const s2 = await freeSlot(tobi, doc);
  const rs = await Promise.all([tobi, kunle, amaka].map(c => c.post('/api/me/appointments', { doctorMembershipId: doc, date: s2.date, time: s2.time, type: 'video' })));
  assert.equal(rs.filter(r => r.status === 200).length, 1, JSON.stringify(rs.map(r => r.status)));
  assert.equal(rs.filter(r => r.status === 409).length, 2);
  const all = await h.db.col('appointments').find({ doctorMembershipId: doc, date: s2.date, time: s2.time, status: 'booked' });
  assert.equal(all.length, 1);
});

test('booking outside the schedule, off the slot grid, in the past or of a type not offered is rejected', async () => {
  const doc = mem('hospital', 'dr.tunde');
  const { todayLagos, addDays } = require('../src/lib/util');
  let d = addDays(todayLagos(), 1); while (new Date(d + 'T00:00:00Z').getUTCDay() !== 0) d = addDays(d, 1);
  const base = { doctorMembershipId: doc, type: 'in_person' };
  const r1 = await amaka.post('/api/me/appointments', Object.assign({ date: addDays(d, 1), time: '08:00' }, base));
  assert.equal(r1.status, 400); assert.equal(r1.body.code, 'outside_schedule');
  assert.equal((await amaka.post('/api/me/appointments', Object.assign({ date: addDays(d, 1), time: '09:10' }, base))).body.code, 'outside_schedule');
  assert.equal((await amaka.post('/api/me/appointments', Object.assign({ date: d, time: '10:00' }, base))).body.code, 'outside_schedule', 'Sunday');
  assert.equal((await amaka.post('/api/me/appointments', Object.assign({ date: addDays(todayLagos(), -6), time: '10:00' }, base))).status, 400);
  assert.equal((await amaka.post('/api/me/appointments', Object.assign({ date: addDays(todayLagos(), 90), time: '10:00' }, base))).body.code, 'too_far_ahead');
  assert.equal((await amaka.post('/api/me/appointments', Object.assign({ date: addDays(d, 1), time: '10:00', type: 'house_call' }, { doctorMembershipId: doc }))).status, 400);
  assert.equal((await amaka.post('/api/me/appointments', { doctorMembershipId: mem('hospital', 'nurse'), date: addDays(d, 1), time: '10:00', type: 'in_person' })).status, 404);
  // admin switches video off for Dr. Bisi: video bookings are refused
  const bisi = mem('hospital', 'dr.bisi');
  const off = await put(adminH, '/api/admin/doctors/' + bisi + '/schedule', { types: ['in_person'] });
  assert.equal(off.status, 200); assert.deepEqual(off.body.types, ['in_person']);
  const s = await freeSlot(amaka, bisi);
  const v = await amaka.post('/api/me/appointments', { doctorMembershipId: bisi, date: s.date, time: s.time, type: 'video' });
  assert.equal(v.status, 400); assert.equal(v.body.code, 'type_not_offered');
  assert.equal((await put(adminH, '/api/admin/doctors/' + bisi + '/schedule', { types: ['in_person', 'video'] })).status, 200);
  assert.equal((await put(adminH, '/api/admin/doctors/' + bisi + '/schedule', { weekly: [{ dow: 1, start: '10:00', end: '09:00' }] })).status, 400);
});

test('appointment flow is exactly-once: check-in, start consult, complete', async () => {
  const doc = mem('hospital', 'dr.tunde');
  const s = await freeSlot(tobi, doc);
  const a = (await tobi.post('/api/me/appointments', { doctorMembershipId: doc, date: s.date, time: s.time, type: 'in_person', reason: 'Sugar review' })).body;
  const ci = await Promise.all([1, 2].map(() => recH.post('/api/fd/queue', { patientId: ids().tobi, appointmentId: a.id, servicePoint: 'doctor' })));
  assert.deepEqual(ci.map(r => r.status).sort(), [200, 409]);
  const item = ci.find(r => r.status === 200).body;
  assert.equal(item.doctorMembershipId, doc); assert.equal(item.status, 'waiting'); assert.match(item.number, /^D-\d{3}$/);
  assert.equal((await recH.get('/api/fd/appointments/' + a.id)).body.status, 'checked_in');
  const q = await tunde.get('/api/fd/queue?servicePoint=doctor&mine=true');
  assert.ok(q.body.some(x => x.id === item.id));
  const st = await Promise.all([1, 2].map(() => tunde.post('/api/doc/encounters', { appointmentId: a.id })));
  assert.deepEqual(st.map(r => r.status).sort(), [200, 409]);
  const enc = st.find(r => r.status === 200).body;
  assert.equal(enc.status, 'open'); assert.equal(enc.notes.complaint, 'Sugar review');
  assert.equal((await tunde.post('/api/doc/encounters', { queueId: item.id })).status, 409, 'queue entry already consulted');
  assert.equal((await recH.get('/api/fd/appointments/' + a.id)).body.status, 'in_consult');
  const bad = await tunde.patch('/api/doc/encounters/' + enc.id, { diagnoses: [{ code: 'not-a-code' }] });
  assert.equal(bad.status, 400);
  const p = await tunde.patch('/api/doc/encounters/' + enc.id, { notes: { history: 'Polyuria for 2 weeks', examination: 'Well' }, diagnoses: [{ code: 'E11.9' }] });
  assert.equal(p.status, 200); assert.equal(p.body.diagnoses[0].text, 'Type 2 diabetes mellitus without complications'); assert.equal(p.body.diagnoses[0].primary, true);
  const done = await Promise.all([1, 2].map(() => tunde.post('/api/doc/encounters/' + enc.id + '/complete', { notes: { plan: 'Continue metformin' } })));
  assert.deepEqual(done.map(r => r.status).sort(), [200, 409]);
  assert.equal((await recH.get('/api/fd/appointments/' + a.id)).body.status, 'completed');
  const qi = (await recH.get('/api/fd/queue?status=today')).body.find(x => x.id === item.id);
  assert.equal(qi.status, 'done');
  assert.equal((await tunde.patch('/api/doc/encounters/' + enc.id, { notes: { plan: 'x' } })).status, 409, 'completed notes are locked');
  assert.equal((await tobi.post('/api/me/appointments/' + a.id + '/cancel', {})).status, 409);
  const sums = await tobi.get('/api/me/encounters');
  assert.ok(sums.body.some(e => e.id === enc.id && e.diagnoses[0].code === 'E11.9' && e.plan === 'Continue metformin'));
});

test('patient cancels more than 2 hours ahead: slot freed, unpaid bill voided, exactly once', async () => {
  const doc = mem('hospital', 'dr.tunde');
  const { todayLagos, addDays } = require('../src/lib/util');
  // pick a slot at least a day away
  let s; for (;;) { s = await freeSlot(kunle, doc); if (s.date > todayLagos()) break; }
  const a = (await kunle.post('/api/me/appointments', { doctorMembershipId: doc, date: s.date, time: s.time, type: 'in_person' })).body;
  const c = await Promise.all([1, 2].map(() => kunle.post('/api/me/appointments/' + a.id + '/cancel', { reason: 'Travelling' })));
  assert.deepEqual(c.map(r => r.status).sort(), [200, 409]);
  const slots = await kunle.get('/api/doctors/' + doc + '/slots?date=' + s.date);
  assert.equal(slots.body.slots.find(x => x.time === s.time).available, true);
  const bill = await h.db.col('bills').findOne({ id: a.billId });
  assert.equal(bill.status, 'void');
  void addDays;
  const again = await tobi.post('/api/me/appointments', { doctorMembershipId: doc, date: s.date, time: s.time, type: 'in_person' });
  assert.equal(again.status, 200, 'the freed slot can be booked again');
});

test('another provider\'s doctor gets 404 on appointments, encounters and charts', async () => {
  const hospAppt = (await h.db.col('appointments').findOne({ orgId: h.ctx.orgs.hospital.id, patientId: ids().amaka }));
  assert.equal((await ada.get('/api/doc/appointments/' + hospAppt.id)).status, 404);
  assert.equal((await recK.get('/api/fd/appointments/' + hospAppt.id)).status, 404);
  const hospEnc = await h.db.col('encounters').findOne({ orgId: h.ctx.orgs.hospital.id, patientId: ids().amaka });
  assert.equal((await ada.get('/api/doc/encounters/' + hospEnc.id)).status, 404);
  assert.equal((await ada.patch('/api/doc/encounters/' + hospEnc.id, { notes: { plan: 'x' } })).status, 404);
  assert.equal((await ada.get('/api/doc/patients/' + ids().zainab + '/chart')).status, 404, 'zainab is not linked to the clinic');
  assert.equal((await ada.post('/api/fd/queue/' + (await h.db.col('queue').findOne({ orgId: h.ctx.orgs.hospital.id })).id + '/call')).status, 404);
  const chart = await tunde.get('/api/doc/patients/' + ids().amaka + '/chart');
  assert.equal(chart.status, 200);
  const audit = await h.db.col('audit').find({ action: 'clinic.chart_view', patientId: ids().amaka });
  assert.ok(audit.length >= 1 && !JSON.stringify(audit).includes('Amaka'));
});

test('a clinic doctor sees hospital encounters for Amaka only when she shares with the clinic', async () => {
  const c1 = await ada.get('/api/doc/patients/' + ids().amaka + '/chart');
  assert.equal(c1.status, 200);
  assert.equal(c1.body.sharing.shareHistory, false);
  assert.equal(c1.body.encounters.filter(e => e.orgId === h.ctx.orgs.hospital.id).length, 0);
  assert.equal(c1.body.prescriptions.filter(r => r.orgId === h.ctx.orgs.hospital.id).length, 0);
  assert.equal(c1.body.vitals.filter(v => v.orgId === h.ctx.orgs.hospital.id).length, 0);
  assert.equal(c1.body.allergies[0].substance, 'Penicillin');
  // the hospital (which she shares with) sees its own records
  const ch = await tunde.get('/api/doc/patients/' + ids().amaka + '/chart');
  assert.ok(ch.body.encounters.some(e => e.diagnoses.some(d => d.code === 'I10')));
  assert.ok(ch.body.currentMedicines.some(m => m.drugCode === 'AMLO5'));
  assert.ok(ch.body.vitals.length >= 3);
  assert.equal((await amaka.post('/api/me/providers/' + h.ctx.orgs.clinic.id + '/share', { share: true })).status, 200);
  const c2 = await ada.get('/api/doc/patients/' + ids().amaka + '/chart');
  assert.ok(c2.body.encounters.some(e => e.orgId === h.ctx.orgs.hospital.id && e.orgName === 'Grandville Hospital'));
  assert.ok(c2.body.prescriptions.some(r => r.items[0].drugCode === 'AMLO5'));
  await amaka.post('/api/me/providers/' + h.ctx.orgs.clinic.id + '/share', { share: false });
  const c3 = await ada.get('/api/doc/patients/' + ids().amaka + '/chart');
  assert.equal(c3.body.encounters.filter(e => e.orgId === h.ctx.orgs.hospital.id).length, 0);
});

test('prescribing amoxicillin to Amaka (penicillin allergy) needs an override reason', async () => {
  const enc = await openEncounter(recH, tunde, ids().amaka, mem('hospital', 'dr.tunde'));
  const item = { drugCode: 'AMOX500', doseMg: 500, doseText: '1 capsule', frequency: 'tds', durationDays: 5, quantity: 15 };
  const dry = await tunde.post('/api/doc/safety-check', { patientId: ids().amaka, items: [item] });
  assert.equal(dry.status, 200); assert.equal(dry.body.blocking, true);
  assert.ok(dry.body.currentMeds.some(m => m.drugCode === 'AMLO5'), 'current meds come from her recent prescriptions');
  const r = await tunde.post('/api/doc/encounters/' + enc.id + '/prescriptions', { items: [item], sendTo: 'patient_choice' });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'safety_alerts');
  assert.ok(r.body.details.alerts.some(a => a.type === 'allergy' && a.level === 'contraindicated'));
  assert.equal((await tunde.post('/api/doc/encounters/' + enc.id + '/prescriptions', { items: [item], sendTo: 'patient_choice', overrideReason: 'short' })).status, 400);
  assert.equal(await h.db.col('prescriptions').count({ encounterId: enc.id }), 0, 'nothing stored without override');
  const ok = await tunde.post('/api/doc/encounters/' + enc.id + '/prescriptions', { items: [item], sendTo: 'patient_choice', overrideReason: 'Desensitised under allergist supervision in 2024' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const rx = ok.body.prescription;
  assert.equal(rx.status, 'active'); assert.equal(rx.safety.blocking, true); assert.match(rx.safety.overrideReason, /Desensitised/);
  assert.equal(rx.items[0].drugName, 'Amoxicillin 500mg capsule'); assert.equal(rx.prescriberName, 'Dr. Tunde Bello');
  // unknown codes and unknown frequencies are refused
  assert.equal((await tunde.post('/api/doc/encounters/' + enc.id + '/prescriptions', { items: [Object.assign({}, item, { drugCode: 'NOPE1' })], sendTo: 'patient_choice' })).status, 400);
  assert.equal((await tunde.post('/api/doc/encounters/' + enc.id + '/prescriptions', { items: [Object.assign({}, item, { frequency: 'hourly' })], sendTo: 'patient_choice' })).status, 400);
  // a safe prescription sent to the hospital's own pharmacy (routed when the pharmacy module is ready)
  const para = await tunde.post('/api/doc/encounters/' + enc.id + '/prescriptions', { items: [{ drugCode: 'PARA500', doseMg: 1000, doseText: '2 tablets', frequency: 'tds', durationDays: 3, quantity: 18 }], sendTo: 'internal' });
  assert.equal(para.status, 200, JSON.stringify(para.body));
  assert.ok(para.body.routing.sentTo === h.ctx.orgs.hospital.id || para.body.routing.reason);
  // front desk staff cannot prescribe
  assert.equal((await recH.post('/api/doc/encounters/' + enc.id + '/prescriptions', { items: [item], sendTo: 'patient_choice' })).status, 403);
  await tunde.post('/api/doc/encounters/' + enc.id + '/complete', { diagnoses: [{ code: 'J02.9' }] });
});

test('warfarin + aspirin for Kunle is flagged', async () => {
  const enc = await openEncounter(recK, ada, ids().kunle, mem('clinic', 'dr.ada'));
  const asp = { drugCode: 'ASP75', doseMg: 75, doseText: '1 tablet', frequency: 'od', durationDays: 30, quantity: 30 };
  const dry = await ada.post('/api/doc/safety-check', { patientId: ids().kunle, items: [asp] });
  assert.equal(dry.body.blocking, true);
  assert.ok(dry.body.alerts.some(a => a.type === 'interaction' && /warfarin/i.test(a.message)), JSON.stringify(dry.body.alerts));
  const r = await ada.post('/api/doc/encounters/' + enc.id + '/prescriptions', { items: [asp], sendTo: 'patient_choice' });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'safety_alerts');
  const internal = await ada.post('/api/doc/encounters/' + enc.id + '/prescriptions', { items: [{ drugCode: 'PARA500', doseMg: 500, doseText: '1 tablet', frequency: 'prn', durationDays: 5, quantity: 10 }], sendTo: 'internal' });
  assert.equal(internal.status, 200); assert.equal(internal.body.routing.reason, 'no_internal_pharmacy', 'the clinic has no pharmacy');
});

test('lab orders: test codes validated; routed through the lab module when it is ready', async () => {
  const enc = await openEncounter(recH, tunde, ids().tobi, mem('hospital', 'dr.tunde'));
  const bad = await tunde.post('/api/doc/encounters/' + enc.id + '/lab-orders', { tests: [{ code: 'FBC' }, { code: 'XYZ' }], sendTo: 'internal' });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /XYZ/);
  const r = await tunde.post('/api/doc/encounters/' + enc.id + '/lab-orders', { tests: [{ code: 'FBC' }, { code: 'MP' }], priority: 'urgent', clinicalNote: 'Fever 3 days', sendTo: 'internal' });
  assert.ok([200, 503].includes(r.status), JSON.stringify(r.body));
  if (r.status === 503) assert.equal(r.body.code, 'lab_module_not_ready');
  else assert.equal(r.body.routedInternally, true);
  await tunde.post('/api/doc/encounters/' + enc.id + '/complete', { diagnoses: [{ code: 'B54' }] });
});

test('video: only the paid appointment\'s patient and doctor can join, inside the window; signals stay in the DB', async () => {
  const doc = mem('hospital', 'dr.tunde');
  const s = await freeSlot(amaka, doc);
  const a = (await amaka.post('/api/me/appointments', { doctorMembershipId: doc, date: s.date, time: s.time, type: 'video' })).body;
  assert.equal(a.feeKobo, 600000);
  assert.equal((await tobi.post('/api/video/' + a.id + '/join')).status, 404, 'other patient');
  assert.equal((await ada.post('/api/video/' + a.id + '/join')).status, 404, 'doctor at another provider');
  assert.equal((await recH.post('/api/video/' + a.id + '/join')).status, 403, 'front desk');
  const unpaid = await amaka.post('/api/video/' + a.id + '/join');
  assert.equal(unpaid.status, 402); assert.equal(unpaid.body.code, 'payment_required');
  assert.equal((await tunde.post('/api/doc/encounters', { appointmentId: a.id })).status, 402);
  await payDemo(amaka, a.billId);
  assert.equal((await amaka.get('/api/me/appointments/' + a.id)).body.paid, true);
  // move the appointment to start in 5 minutes so the window is open
  const start = Date.now() + 5 * 60000;
  await h.db.col('appointments').updateOne({ id: a.id }, { $set: { startUtc: start, endUtc: start + 20 * 60000 } });
  const pj = await amaka.post('/api/video/' + a.id + '/join');
  assert.equal(pj.status, 200, JSON.stringify(pj.body)); assert.equal(pj.body.role, 'callee');
  assert.equal(pj.body.iceServers[0].urls, 'stun:stun.l.google.com:19302');
  const dj = await tunde.post('/api/video/' + a.id + '/join');
  assert.equal(dj.body.role, 'caller');
  assert.equal((await tunde.post('/api/video/' + a.id + '/signal', { type: 'offer', data: { sdp: 'v=0 offer' } })).status, 200);
  assert.equal((await tunde.post('/api/video/' + a.id + '/signal', { type: 'ice', data: { candidate: 'c1' } })).status, 200);
  const got = await amaka.get('/api/video/' + a.id + '/signals?after=0');
  assert.equal(got.status, 200); assert.deepEqual(got.body.signals.map(x => x.type), ['offer', 'ice']);
  assert.equal((await amaka.post('/api/video/' + a.id + '/signal', { type: 'answer', data: { sdp: 'v=0 answer' } })).status, 200);
  const mine = await amaka.get('/api/video/' + a.id + '/signals?after=' + got.body.signals[1].seq);
  assert.equal(mine.body.signals.length, 0, 'own signals are not echoed back');
  const forDoc = await tunde.get('/api/video/' + a.id + '/signals?after=0');
  assert.deepEqual(forDoc.body.signals.map(x => x.type), ['answer']);
  assert.equal((await amaka.post('/api/video/' + a.id + '/signal', { type: 'ice', data: { big: 'x'.repeat(17000) } })).status, 400);
  assert.equal((await amaka.post('/api/video/' + a.id + '/signal', { type: 'chat', data: {} })).status, 400);
  assert.equal(await h.db.col('video_signals').count({ appointmentId: a.id }), 3);
  // outside the window
  await h.db.col('appointments').updateOne({ id: a.id }, { $set: { startUtc: Date.now() - 2 * 3600e3 } });
  const late = await amaka.post('/api/video/' + a.id + '/join');
  assert.equal(late.status, 409); assert.equal(late.body.code, 'window_closed');
});

test('messaging: sender name comes from the server, text is plain, unread counts work', async () => {
  const start = await amaka.post('/api/me/threads', { orgId: h.ctx.orgs.hospital.id, doctorMembershipId: mem('hospital', 'dr.tunde'), subject: 'Question', text: 'Hello <script>alert(1)</script>doctor, BP < 140 today', senderName: 'Dr. Fake', from: 'staff' });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(start.body.message.senderName, 'Amaka Eze'); assert.equal(start.body.message.from, 'patient');
  assert.ok(!start.body.message.text.includes('<script>')); assert.ok(start.body.message.text.includes('BP < 140'));
  const th = start.body.thread.id;
  const inbox = await tunde.get('/api/msg/threads');
  const row = inbox.body.threads.find(x => x.id === th);
  assert.equal(row.unread, 1); assert.ok(inbox.body.unreadTotal >= 1);
  const reply = await tunde.post('/api/msg/threads/' + th + '/messages', { text: 'Thanks, keep taking it.', senderName: 'Amaka Eze', from: 'patient' });
  assert.equal(reply.body.message.senderName, 'Dr. Tunde Bello'); assert.equal(reply.body.message.from, 'staff');
  const list = await amaka.get('/api/me/threads');
  assert.equal(list.body.threads.find(x => x.id === th).unread, 1);
  const msgs = await amaka.get('/api/me/threads/' + th + '/messages');
  assert.deepEqual(msgs.body.messages.map(m => m.from), ['patient', 'staff']);
  assert.equal((await amaka.get('/api/me/threads')).body.threads.find(x => x.id === th).unread, 1, 'GET does not mark read');
  await amaka.post('/api/me/threads/' + th + '/read');
  assert.equal((await amaka.get('/api/me/threads')).body.threads.find(x => x.id === th).unread, 0);
  assert.equal((await tobi.get('/api/me/threads/' + th + '/messages')).status, 404, 'other patient');
  assert.equal((await ada.get('/api/msg/threads/' + th + '/messages')).status, 404, 'other provider');
  assert.equal((await fdmH.get('/api/msg/threads/' + th + '/messages')).status, 200, 'customer care at the same provider');
  assert.equal((await tobi.post('/api/me/threads', { orgId: h.ctx.orgs.clinic.id, subject: 'Hi', text: 'Hello' })).status, 404, 'tobi is not linked to the clinic');
  assert.equal((await amaka.post('/api/me/threads/' + th + '/messages', { text: 'x'.repeat(2001) })).status, 400);
  assert.equal((await tunde.post('/api/msg/threads/' + th + '/close')).status, 200);
  assert.equal((await amaka.post('/api/me/threads/' + th + '/messages', { text: 'more' })).status, 409);
  // the demo thread is there with its unread reply
  assert.ok(list.body.threads.some(x => x.subject === 'Amlodipine and ankle swelling'));
});

test('queue check-in needs a linked patient and a doctor of the same provider; transitions are exactly-once', async () => {
  const r = await recK.post('/api/fd/queue', { patientId: ids().zainab, servicePoint: 'doctor' });
  assert.equal(r.status, 404);
  assert.equal((await recK.post('/api/fd/queue', { patientId: ids().kunle, servicePoint: 'doctor', doctorMembershipId: mem('hospital', 'dr.tunde') })).status, 404);
  assert.equal((await cashH.post('/api/fd/queue', { patientId: ids().amaka, servicePoint: 'cashier' })).status, 403, 'cashier has no queue.manage');
  const q = await recH.post('/api/fd/queue', { patientId: ids().amaka, servicePoint: 'pharmacy' });
  assert.equal(q.status, 200);
  assert.equal((await recH.post('/api/fd/queue', { patientId: ids().amaka, servicePoint: 'pharmacy' })).body.code, 'already_queued');
  const calls = await Promise.all([1, 2].map(() => recH.post('/api/fd/queue/' + q.body.id + '/call')));
  assert.deepEqual(calls.map(c => c.status).sort(), [200, 409]);
  assert.equal((await recH.post('/api/fd/queue/' + q.body.id + '/done')).status, 409, 'cannot finish before starting');
  assert.equal((await recH.post('/api/fd/queue/' + q.body.id + '/start')).status, 200);
  assert.equal((await recH.post('/api/fd/queue/' + q.body.id + '/done')).status, 200);
  assert.equal((await recH.post('/api/fd/queue', { patientId: ids().amaka, servicePoint: 'pharmacy' })).status, 200, 'can queue again after done');
});

test('vitals: out of range values rejected, flags and triage computed', async () => {
  const pid = ids().amaka;
  assert.equal((await nurseH.post('/api/fd/vitals', { patientId: pid, bpSys: 400, bpDia: 90 })).status, 400);
  assert.equal((await nurseH.post('/api/fd/vitals', { patientId: pid, tempC: 50 })).status, 400);
  assert.equal((await nurseH.post('/api/fd/vitals', { patientId: pid, spo2: 120 })).status, 400);
  assert.equal((await nurseH.post('/api/fd/vitals', { patientId: pid, bpSys: 80, bpDia: 120 })).status, 400);
  assert.equal((await nurseH.post('/api/fd/vitals', { patientId: pid, bpSys: 120 })).status, 400, 'needs both BP values');
  assert.equal((await nurseH.post('/api/fd/vitals', { patientId: pid })).status, 400, 'empty');
  assert.equal((await nurseH.post('/api/fd/vitals', { patientId: pid, pulse: 'fast' })).status, 400);
  assert.equal((await recK.post('/api/fd/vitals', { patientId: ids().zainab, pulse: 80 })).status, 403, 'receptionist has no vitals.record');
  const q = await recH.post('/api/fd/queue', { patientId: ids().tobi, servicePoint: 'triage', priority: 'routine' });
  const v = await nurseH.post('/api/fd/vitals', { patientId: ids().tobi, queueId: q.body.id, bpSys: 150, bpDia: 95, pulse: 88, tempC: 38.6, spo2: 97, weightKg: 82, heightCm: 178 });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.ok(v.body.flags.some(f => f.field === 'bp' && f.level === 'high'));
  assert.equal(v.body.suggestedPriority, 'urgent'); assert.equal(v.body.bmi, 25.9);
  const item = (await recH.get('/api/fd/queue?servicePoint=triage')).body.find(x => x.id === q.body.id);
  assert.equal(item.priority, 'urgent'); assert.equal(item.latestVitals.tempC, 38.6);
  const hist = await nurseH.get('/api/fd/patients/' + pid + '/vitals');
  assert.equal(hist.status, 200); assert.ok(hist.body.length >= 3);
  await recH.post('/api/fd/queue/' + q.body.id + '/left');
});

test('customer care cases', async () => {
  const c = await fdmH.post('/api/fd/care-cases', { patientId: ids().amaka, channel: 'phone', category: 'billing', subject: 'Asked about consultation fee', note: 'Explained fee' });
  assert.equal(c.status, 200); assert.equal(c.body.status, 'open'); assert.equal(c.body.notes[0].byName, 'Kemi Bello');
  assert.equal((await fdmH.post('/api/fd/care-cases/' + c.body.id + '/notes', { text: 'Called back' })).body.notes.length, 2);
  assert.equal((await fdmH.post('/api/fd/care-cases/' + c.body.id + '/status', { status: 'resolved' })).status, 200);
  assert.equal((await fdmH.post('/api/fd/care-cases/' + c.body.id + '/status', { status: 'resolved' })).status, 409);
  assert.equal((await fdmH.post('/api/fd/care-cases/' + c.body.id + '/status', { status: 'open' })).status, 200);
  assert.equal((await recH.get('/api/fd/care-cases')).status, 403);
  assert.equal((await fdmH.post('/api/fd/care-cases', { patientId: 'pat_notlinkedanywhere1', channel: 'phone', subject: 'Not ours' })).status, 404);
});

test('clinical search, doctor schedule editing and earnings', async () => {
  const icd = await tunde.get('/api/clinical/icd10?q=malaria');
  assert.ok(icd.body.some(c => c.code === 'B54') && icd.body.some(c => c.code === 'B50.9'));
  assert.equal((await tunde.get('/api/clinical/icd10?q=I10')).body[0].code, 'I10');
  assert.equal((await tunde.get('/api/clinical/icd10?q=high bp')).body[0].code, 'I10');
  assert.ok((await tunde.get('/api/clinical/drugs?q=amox')).body.some(d => d.code === 'AMOX500'));
  assert.ok((await tunde.get('/api/clinical/frequencies')).body.some(f => f.key === 'bd'));
  const sch = await put(ada, '/api/doc/schedule', { bio: 'Updated bio', languages: ['English', 'Igbo', 'Pidgin'], slotMin: 30 });
  assert.equal(sch.status, 200); assert.equal(sch.body.bio, 'Updated bio'); assert.equal(sch.body.slotMin, 30);
  assert.equal((await put(ada, '/api/doc/schedule', { slotMin: 7 })).status, 400);
  assert.equal((await put(recH, '/api/admin/doctors/' + mem('hospital', 'dr.tunde') + '/schedule', { bio: 'x' })).status, 403);
  assert.equal((await put(adminH, '/api/admin/doctors/' + mem('clinic', 'dr.ada') + '/schedule', { bio: 'x' })).status, 404, 'other provider\'s doctor');
  const earn = await tunde.get('/api/doc/earnings?from=2020-01-01');
  assert.equal(earn.status, 200);
  assert.ok(earn.body.paidCount >= 2 && earn.body.paidKobo >= 1600000, JSON.stringify(earn.body));
  assert.equal(earn.body.payouts.available, false);
  const rev = await adminH.get('/api/admin/clinic/revenue?from=2020-01-01');
  assert.equal(rev.status, 200);
  assert.ok(rev.body.doctors.some(d => d.doctorName === 'Dr. Tunde Bello' && d.paidKobo >= 1600000));
  assert.equal((await tunde.get('/api/admin/clinic/revenue')).status, 403);
  const summaries = await amaka.get('/api/me/encounters');
  assert.ok(summaries.body.filter(e => e.orgName === 'Grandville Hospital' && e.diagnoses.some(d => d.code === 'I10')).length >= 2);
  const up = await amaka.get('/api/me/appointments?scope=upcoming');
  assert.ok(up.body.some(a => a.reason === 'Blood pressure review after starting amlodipine'));
});
