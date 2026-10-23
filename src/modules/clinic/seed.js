'use strict';
/*
 * Clinic demo data: doctor schedules, Amaka's hypertension history at Grandville Hospital
 * (two past visits, vitals, an amlodipine prescription), Kunle's warfarin at Lekki Family
 * Clinic, one upcoming appointment for Amaka, and one message thread.
 */
const db = require('../../db');
const { id, now, todayLagos, addDays, lagosToUtc } = require('../../lib/util');
const C = require('./common');

const WEEK = [1, 2, 3, 4, 5, 6].map(dow => ({ dow, start: '09:00', end: '17:00' }));
const workday = date => { let d = date; while (C.dowOf(d) === 0) d = addDays(d, 1); return d; };
const pastWorkday = date => { let d = date; while (C.dowOf(d) === 0) d = addDays(d, -1); return d; };

async function fee(orgId, code) { const s = await require('../orgs').service(orgId, code); return s ? s.priceKobo : null; }

async function schedule(m, orgId, o) {
  const s = Object.assign({ id: id('sch'), orgId, membershipId: m.id, userId: m.userId, weekly: WEEK, slotMin: 20, types: ['in_person', 'video'], acceptingBookings: true,
    feeKobo: await fee(orgId, 'CONS-GP'), videoFeeKobo: await fee(orgId, 'VIDEO-GP'), languages: ['English'], bio: null, createdAt: now(), updatedAt: now(), updatedBy: 'demo' }, o);
  await db.col('schedules').insertOne(s);
  return s;
}

/** a past, completed and paid consultation with its encounter */
async function pastVisit({ org, m, doctorName, patient, daysAgo, notes, diagnoses, vitals, rx, specialty }) {
  const billing = require('../billing');
  const date = pastWorkday(addDays(todayLagos(), -daysAgo));
  const startUtc = lagosToUtc(date, '10:00'), endUtc = startUtc + 20 * 60000;
  const feeKobo = await fee(org.id, 'CONS-GP');
  const appt = { id: id('apt'), orgId: org.id, patientId: patient.id, doctorMembershipId: m.id, doctorUserId: m.userId, doctorName, specialty, date, time: '10:00', startUtc, endUtc, durationMin: 20,
    type: 'in_person', reason: notes.complaint, status: 'completed', slotKey: m.id + '|' + startUtc, feeKobo, billId: null, paid: false, paidAt: null, refundDue: false,
    bookedBy: 'patient', bookedByUserId: patient.userId || 'demo', createdAt: startUtc - 3 * 86400e3, checkedInAt: startUtc - 10 * 60000, startedAt: startUtc, completedAt: endUtc, encounterId: null, queueId: null };
  await db.col('appointments').insertOne(appt);
  const bill = await billing.createBill({ orgId: org.id, patientId: patient.id, source: { type: 'appointment', id: appt.id }, createdBy: 'demo',
    lines: [{ code: 'CONS-GP', name: 'Consultation with ' + doctorName, category: 'consultation', qty: 1, unitPriceKobo: feeKobo }] });
  await db.col('appointments').updateOne({ id: appt.id }, { $set: { billId: bill.id } });
  await db.col('payments').insertOne({ id: id('pay'), billId: bill.id, orgId: org.id, patientId: patient.id, amountKobo: feeKobo, method: 'pos', provider: 'counter', reference: 'CTR-' + org.code + '-DEMO-' + appt.id.slice(-6), status: 'success', recordedBy: 'demo', at: startUtc, confirmedAt: startUtc });
  await billing.applyToBill(bill.id, feeKobo, 'pos');
  const encId = id('enc');
  await db.col('encounters').insertOne({ id: encId, orgId: org.id, patientId: patient.id, appointmentId: appt.id, queueId: null, doctorMembershipId: m.id, doctorUserId: m.userId, doctorName,
    type: 'in_person', status: 'completed', startedAt: startUtc, completedAt: endUtc, updatedAt: endUtc, notes, diagnoses, followUp: { date: addDays(date, 28), note: 'Review blood pressure' }, labOrderIds: [] });
  await db.col('appointments').updateOne({ id: appt.id }, { $set: { encounterId: encId } });
  if (vitals) {
    const v = Object.assign({ id: id('vt'), orgId: org.id, patientId: patient.id, at: startUtc - 5 * 60000, by: 'demo', byName: 'Front desk (demo)', queueId: null, encounterId: encId }, vitals);
    Object.assign(v, require('./frontdesk').assess(vitals));
    await db.col('vitals').insertOne(v);
  }
  if (rx) {
    await db.col('prescriptions').insertOne({ id: id('rx'), orgId: org.id, patientId: patient.id, encounterId: encId, prescriberUserId: m.userId, prescriberMembershipId: m.id, prescriberName: doctorName,
      items: rx, safety: { alerts: [], blocking: false, overrideReason: null, checkedAt: endUtc }, status: 'active', routedTo: null, sendTo: 'patient_choice', pregnant: false, createdAt: endUtc });
  }
  return { appt, encId };
}

async function seedDemo(ctx) {
  const H = ctx.orgs.hospital, K = ctx.orgs.clinic;
  const tunde = ctx.staff.hospital['dr.tunde'], bisi = ctx.staff.hospital['dr.bisi'], ada = ctx.staff.clinic['dr.ada'];
  const bisiClinic = await db.col('memberships').findOne({ userId: bisi.user.id, orgId: K.id });
  await schedule(tunde.membership, H.id, { specialty: 'General practice', bio: 'Family physician with a special interest in hypertension and diabetes.', languages: ['English', 'Yoruba'] });
  await schedule(bisi.membership, H.id, { specialty: 'Internal medicine', bio: 'Consultant physician.', languages: ['English', 'Yoruba'], weekly: [1, 3, 5].map(dow => ({ dow, start: '09:00', end: '17:00' })) });
  await schedule(ada.membership, K.id, { specialty: 'Family medicine', bio: 'Family doctor for adults and children.', languages: ['English', 'Igbo'] });
  if (bisiClinic) await schedule(bisiClinic, K.id, { specialty: 'Internal medicine', bio: 'Visiting consultant physician.', languages: ['English', 'Yoruba'], weekly: [2, 4, 6].map(dow => ({ dow, start: '09:00', end: '17:00' })) });

  const amaka = ctx.patients.amaka, kunle = ctx.patients.kunle;
  const tundeName = tunde.user.name, adaName = ada.user.name;
  await pastVisit({ org: H, m: tunde.membership, doctorName: tundeName, specialty: 'General practice', patient: amaka, daysAgo: 75,
    notes: { complaint: 'Headaches and high readings on home BP monitor', history: 'Two weeks of morning headaches. No chest pain. Father has hypertension.', examination: 'Well. BP 156/98. Heart sounds normal.', assessment: 'Stage 2 hypertension', plan: 'Lifestyle advice: less salt, regular exercise. Home BP diary. Review in 4 weeks.' },
    diagnoses: [{ code: 'I10', text: 'Essential (primary) hypertension', primary: true }], vitals: { bpSys: 156, bpDia: 98, pulse: 82, tempC: 36.7, spo2: 98, weightKg: 64, heightCm: 165 } });
  await pastVisit({ org: H, m: tunde.membership, doctorName: tundeName, specialty: 'General practice', patient: amaka, daysAgo: 20,
    notes: { complaint: 'Blood pressure review', history: 'Home readings still around 145/92 despite lifestyle changes.', examination: 'BP 148/94. No oedema.', assessment: 'Hypertension not controlled with lifestyle alone', plan: 'Start amlodipine 5mg once daily. Review in 4 weeks.' },
    diagnoses: [{ code: 'I10', text: 'Essential (primary) hypertension', primary: true }], vitals: { bpSys: 148, bpDia: 94, pulse: 78, tempC: 36.6, spo2: 99, weightKg: 63.5 },
    rx: [{ drugCode: 'AMLO5', drugName: 'Amlodipine 5mg tablet', doseMg: 5, doseText: '1 tablet', frequency: 'od', durationDays: 30, quantity: 30, route: 'oral', instructions: 'Take every morning' }] });
  // an older vitals reading from a nurse check
  const old = Object.assign({ id: id('vt'), orgId: H.id, patientId: amaka.id, at: now() - 120 * 86400e3, by: 'demo', byName: 'Nurse (demo)', queueId: null, encounterId: null }, { bpSys: 138, bpDia: 88, pulse: 76 });
  Object.assign(old, require('./frontdesk').assess({ bpSys: 138, bpDia: 88, pulse: 76 }));
  await db.col('vitals').insertOne(old);

  await pastVisit({ org: K, m: ada.membership, doctorName: adaName, specialty: 'Family medicine', patient: kunle, daysAgo: 25,
    notes: { complaint: 'Palpitations', history: 'Known atrial fibrillation, transferred care to this clinic.', examination: 'Irregularly irregular pulse 84. BP 132/80.', assessment: 'Atrial fibrillation, rate controlled', plan: 'Continue warfarin. INR check in 2 weeks.' },
    diagnoses: [{ code: 'I48', text: 'Atrial fibrillation and flutter', primary: true }], vitals: { bpSys: 132, bpDia: 80, pulse: 84, spo2: 97, weightKg: 90 },
    rx: [{ drugCode: 'WARF5', drugName: 'Warfarin 5mg tablet', doseMg: 5, doseText: '1 tablet', frequency: 'od', durationDays: 30, quantity: 30, route: 'oral', instructions: 'Take at the same time each evening' }] });

  // upcoming: Amaka with Dr. Tunde on the next working day at 10:00
  const date = workday(addDays(todayLagos(), 1));
  const startUtc = lagosToUtc(date, '10:00');
  const feeKobo = await fee(H.id, 'CONS-GP');
  const up = { id: id('apt'), orgId: H.id, patientId: amaka.id, doctorMembershipId: tunde.membership.id, doctorUserId: tunde.user.id, doctorName: tundeName, specialty: 'General practice', date, time: '10:00', startUtc, endUtc: startUtc + 20 * 60000, durationMin: 20,
    type: 'in_person', reason: 'Blood pressure review after starting amlodipine', status: 'booked', slotKey: tunde.membership.id + '|' + startUtc, feeKobo, billId: null, paid: false, paidAt: null, refundDue: false,
    bookedBy: 'patient', bookedByUserId: (ctx.users.amaka || {}).id || 'demo', createdAt: now(), encounterId: null, queueId: null };
  await db.col('appointments').insertOne(up);
  const bill = await require('../billing').createBill({ orgId: H.id, patientId: amaka.id, source: { type: 'appointment', id: up.id }, createdBy: 'demo', lines: [{ code: 'CONS-GP', name: 'Consultation with ' + tundeName, category: 'consultation', qty: 1, unitPriceKobo: feeKobo }] });
  await db.col('appointments').updateOne({ id: up.id }, { $set: { billId: bill.id } });

  // a message thread: Amaka asks Dr. Tunde a question, he replies
  const t1 = now() - 2 * 86400e3, t2 = t1 + 3 * 3600e3;
  const th = { id: id('th'), orgId: H.id, orgName: H.name, patientId: amaka.id, patientName: amaka.firstName + ' ' + amaka.lastName, doctorMembershipId: tunde.membership.id, doctorUserId: tunde.user.id, doctorName: tundeName,
    subject: 'Amlodipine and ankle swelling', status: 'open', startedBy: 'patient', createdAt: t1, lastAt: t2, lastFrom: 'staff', lastPreview: 'Mild ankle swelling can happen with amlodipine.', unreadForPatient: 1, unreadForStaff: 0, seq: 2 };
  await db.col('message_threads').insertOne(th);
  await db.col('messages').insertOne({ id: id('msg'), threadId: th.id, orgId: H.id, patientId: amaka.id, seq: 1, from: 'patient', senderUserId: (ctx.users.amaka || {}).id || 'demo', senderName: th.patientName, senderRole: null, text: 'Good afternoon doctor. My ankles look a little swollen since I started the new tablets. Should I stop them?', at: t1 });
  await db.col('messages').insertOne({ id: id('msg'), threadId: th.id, orgId: H.id, patientId: amaka.id, seq: 2, from: 'staff', senderUserId: tunde.user.id, senderName: tundeName, senderRole: 'doctor', text: 'Mild ankle swelling can happen with amlodipine. Please do not stop it. Raise your feet when sitting and we will review at your appointment. If you have breathlessness or chest pain, come in straight away.', at: t2 });
}

module.exports = { seedDemo };
