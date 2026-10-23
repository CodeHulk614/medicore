'use strict';
/*
 * Appointments: booked by the patient (any marketplace provider, or one they are linked to)
 * or by the provider's front desk for a linked patient.
 *
 * One appointment per doctor slot: `slotKey` = doctorMembershipId|startUtc has a unique index,
 * so two parallel bookings of the same slot cannot both succeed. Cancelling removes slotKey,
 * which frees the slot. A bill is raised from the doctor's fee; video visits must be paid
 * before the room opens (billing.onSettled('appointment') marks the appointment paid).
 */
const express = require('express');
const db = require('../../db');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param } = require('../../lib/http');
const A = require('../../lib/auth');
const { id, now, todayLagos, addDays } = require('../../lib/util');
const { audit } = require('../../lib/audit');
const { notify } = require('../../lib/notify');
const RL = require('../../lib/ratelimit');
const P = require('../patients');
const billing = require('../billing');
const C = require('./common');
const S = require('./schedules');

db.index('appointments', ['slotKey'], { unique: true, sparse: true });
db.index('appointments', ['orgId', 'startUtc']);
db.index('appointments', ['doctorMembershipId', 'startUtc']);
db.index('appointments', ['doctorUserId', 'startUtc']);
db.index('appointments', ['patientId', 'startUtc']);

const router = express.Router();
const MIN_LEAD_MS = 5 * 60000;

billing.onSettled('appointment', async (bill) => {
  await db.col('appointments').updateOne({ id: bill.source.id, orgId: bill.orgId }, { $set: { paid: true, paidAt: now() } });
});

/** book a slot. by: 'patient' | 'staff'. Returns the appointment. */
async function book(req, b, by) {
  const m = await db.col('memberships').findOne({ id: b.doctorMembershipId });
  if (!C.isDoctor(m)) throw notFound('Doctor not found');
  if (by === 'staff' && m.orgId !== req.ctx.org.id) throw notFound('Doctor not found');
  const org = await db.col('orgs').findOne({ id: m.orgId });
  if (!(await S.canSeeOrg(req, org))) throw notFound('Doctor not found');
  const s = await db.col('schedules').findOne({ orgId: org.id, membershipId: m.id });
  if (!s || !s.acceptingBookings) throw conflict('This doctor is not taking bookings right now.', 'not_accepting');
  if (by === 'patient' && (org.settings || {}).acceptsOnlineBooking === false) throw conflict(org.name + ' takes bookings at its front desk or by phone only. Call them to book.', 'no_online_booking');
  if (b.type === 'video' && !C.tun.video(org)) throw C.httpError(400, 'Video visits are not available at the moment.', 'video_disabled');
  if (!(s.types || []).includes(b.type)) throw C.httpError(400, b.type === 'video' ? 'This doctor does not offer video visits.' : 'This doctor does not offer in-person visits.', 'type_not_offered');
  const fee = await C.feeFor(s, org.id, b.type);
  if (fee == null) throw conflict('This provider has not set a fee for this kind of visit yet.', 'no_fee');
  if (b.date > addDays(todayLagos(), S.MAX_DAYS_AHEAD)) throw C.httpError(400, 'You can book up to ' + S.MAX_DAYS_AHEAD + ' days ahead.', 'too_far_ahead');
  const slot = C.scheduleSlots(s, b.date).find(x => x.time === b.time);
  if (!slot) throw C.httpError(400, 'That time is not in the doctor\'s schedule. Choose one of the available slots.', 'outside_schedule');
  if (slot.startUtc <= now() + MIN_LEAD_MS) throw C.httpError(400, 'That time has already passed. Choose a later slot.', 'slot_in_past');
  const taken = await S.bookedIntervals(m.userId, b.date);
  if (taken.some(x => C.overlaps(x, slot))) throw conflict('That slot has just been taken. Please choose another time.', 'slot_taken');
  const mine = await db.col('appointments').find({ patientId: b.patientId, status: { $in: C.ACTIVE_APPT }, startUtc: { $gte: slot.startUtc - 4 * 3600e3, $lt: slot.endUtc } });
  if (mine.some(x => C.overlaps(x, slot))) throw conflict('There is already an appointment for this patient at that time.', 'patient_busy');

  const doctorName = await C.userName(m.userId);
  const appt = {
    id: id('apt'), orgId: org.id, patientId: b.patientId, doctorMembershipId: m.id, doctorUserId: m.userId, doctorName, specialty: s.specialty || null,
    date: b.date, time: b.time, startUtc: slot.startUtc, endUtc: slot.endUtc, durationMin: s.slotMin, type: b.type, reason: b.reason || null,
    status: 'booked', slotKey: m.id + '|' + slot.startUtc, feeKobo: fee, billId: null, paid: false, paidAt: null, refundDue: false,
    bookedBy: by, bookedByUserId: req.ctx.user.id, createdAt: now(), encounterId: null, queueId: null,
  };
  try { await db.col('appointments').insertOne(appt); } catch (e) { if (e.code === 11000) throw conflict('That slot has just been taken. Please choose another time.', 'slot_taken'); throw e; }
  await P.ensureLink(org.id, b.patientId, req.ctx.user.id, 'booking');
  let bill;
  try {
    bill = await billing.createBill({ orgId: org.id, patientId: b.patientId, source: { type: 'appointment', id: appt.id }, createdBy: req.ctx.user.id, dueBy: b.type === 'video' ? slot.startUtc : null,
      lines: [{ code: C.FEE_CODES[b.type], name: (b.type === 'video' ? 'Video consultation with ' : 'Consultation with ') + doctorName, category: b.type === 'video' ? 'video' : 'consultation', qty: 1, unitPriceKobo: fee }] });
  } catch (e) {
    await db.col('appointments').updateOne({ id: appt.id }, { $set: { status: 'cancelled', cancelledAt: now(), cancelledBy: 'system', cancelReason: 'billing_failed' }, $unset: { slotKey: '' } });
    throw e;
  }
  const saved = await db.col('appointments').findOneAndUpdate({ id: appt.id }, { $set: { billId: bill.id } });
  await audit(req, 'clinic.appointment_book', { type: 'appointment', id: appt.id, patientId: appt.patientId, orgId: org.id }, { by, type: appt.type, startUtc: appt.startUtc, feeKobo: fee });
  await notify({ userId: m.userId, title: 'New appointment', body: (b.type === 'video' ? 'Video visit' : 'In-person visit') + ' on ' + b.date + ' at ' + b.time + '.', kind: 'appointment', ref: { type: 'appointment', id: appt.id } });
  if (by === 'staff') await notify({ patientId: appt.patientId, title: 'Appointment booked at ' + org.name, body: 'With ' + doctorName + ' on ' + b.date + ' at ' + b.time + '.', kind: 'appointment', ref: { type: 'appointment', id: appt.id } });
  return saved;
}

/** cancel with side effects: free slot, void an unpaid bill or flag a refund, take the patient off the queue */
async function cancel(req, appt, { from, by, reason }) {
  const done = await C.move('appointments', C.APPT_TRANSITIONS, { id: appt.id, orgId: appt.orgId }, 'cancelled',
    { cancelledAt: now(), cancelledBy: by, cancelledByUserId: req.ctx.user.id, cancelReason: reason || null, freedSlotKey: appt.slotKey || null }, { from, extra: { $unset: { slotKey: '' } } });
  if (!done) { const cur = await db.col('appointments').findOne({ id: appt.id }); throw C.stateConflict('appointment', cur && cur.status, 'cancelled'); }
  let result = done;
  if (done.billId) {
    const voided = await db.col('bills').findOneAndUpdate({ id: done.billId, orgId: done.orgId, status: 'open', paidKobo: 0 }, { $set: { status: 'void', voidedAt: now(), voidedBy: req.ctx.user.id, voidReason: 'Appointment cancelled' } });
    if (!voided) {
      const bill = await db.col('bills').findOne({ id: done.billId });
      if (bill && (bill.status === 'paid' || bill.paidKobo > 0)) {
        result = await db.col('appointments').findOneAndUpdate({ id: done.id }, { $set: { refundDue: true } });
        await notify({ orgId: done.orgId, role: 'cashier', title: 'Refund due', body: 'A paid appointment was cancelled. Bill ' + bill.number + ' needs a refund.', kind: 'refund', ref: { type: 'bill', id: bill.id } });
      }
    }
  }
  await db.col('queue').updateMany({ orgId: done.orgId, appointmentId: done.id, status: { $in: ['waiting', 'called'] } }, { $set: { status: 'left', leftAt: now() }, $unset: { activeKey: '' } });
  await audit(req, 'clinic.appointment_cancel', { type: 'appointment', id: done.id, patientId: done.patientId, orgId: done.orgId }, { by, refundDue: !!result.refundDue });
  if (by !== 'patient') await notify({ patientId: done.patientId, title: 'Appointment cancelled', body: 'Your appointment on ' + done.date + ' at ' + done.time + ' was cancelled by the provider.', kind: 'appointment', ref: { type: 'appointment', id: done.id } });
  else await notify({ userId: done.doctorUserId, title: 'Appointment cancelled', body: 'The patient cancelled the visit on ' + done.date + ' at ' + done.time + '.', kind: 'appointment', ref: { type: 'appointment', id: done.id } });
  return result;
}

const bookRules = {
  doctorMembershipId: t.id({ required: true }), date: t.date({ required: true }), time: t.time({ required: true }),
  type: t.enum(S.TYPES, { required: true }), reason: t.str({ max: 300 }),
};

/* ---------------- patient ---------------- */
router.post('/me/appointments', A.requirePatient, ah(async (req, res) => {
  const b = body(req, bookRules);
  await RL.limit('book_' + req.ctx.patient.id, 20, 3600);
  b.patientId = req.ctx.patient.id;
  const a = await book(req, b, 'patient');
  res.json(await C.apptForPatient(a));
}));
router.get('/me/appointments', A.requirePatient, ah(async (req, res) => {
  const q = query(req, { scope: t.enum(['upcoming', 'past', 'all']), limit: t.int({ min: 1, max: 200 }) });
  const f = Object.assign({ patientId: req.ctx.patient.id }, await P.scopeFilter(req));
  const scope = q.scope || 'all';
  if (scope === 'upcoming') { f.status = { $in: C.ACTIVE_APPT }; f.endUtc = { $gte: now() - C.VIDEO_LATE_MS }; }
  if (scope === 'past') f.$or = [{ status: { $in: ['completed', 'cancelled', 'no_show'] } }, { endUtc: { $lt: now() - C.VIDEO_LATE_MS } }];
  const rows = await db.col('appointments').find(f, { sort: { startUtc: scope === 'upcoming' ? 1 : -1 }, limit: q.limit || 100 });
  const cache = {}; const out = [];
  for (const a of rows) out.push(await C.apptForPatient(a, cache));
  res.json(out);
}));
router.get('/me/appointments/:id', A.requirePatient, ah(async (req, res) => {
  const a = await db.col('appointments').findOne({ id: param(req, 'id'), patientId: req.ctx.patient.id });
  if (!a) throw notFound('Appointment not found');
  res.json(await C.apptForPatient(a));
}));
router.post('/me/appointments/:id/cancel', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ max: 300 }) });
  const a = await db.col('appointments').findOne({ id: param(req, 'id'), patientId: req.ctx.patient.id });
  if (!a) throw notFound('Appointment not found');
  if (a.status !== 'booked') throw C.stateConflict('appointment', a.status, 'cancelled');
  const org = await db.col('orgs').findOne({ id: a.orgId });
  const hrs = C.tun.cancelMs(org) / 3600e3;
  if (a.startUtc - now() <= C.tun.cancelMs(org)) throw conflict('Appointments can be cancelled in the app up to ' + hrs + ' hour' + (hrs === 1 ? '' : 's') + ' before the start. Please call the provider.', 'too_late_to_cancel');
  const done = await cancel(req, a, { from: ['booked'], by: 'patient', reason: b.reason });
  res.json(await C.apptForPatient(done));
}));

/* ---------------- front desk ---------------- */
const fdRead = A.requireStaff({ anyPerm: ['queue.manage', 'patient.register', 'billing.create', 'billing.cash'] });
const fdWrite = A.requireStaff({ anyPerm: ['queue.manage', 'patient.register'] });
router.post('/fd/appointments', fdWrite, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, Object.assign({ patientId: t.id({ required: true }) }, bookRules));
  await P.requireLinked(req, b.patientId);
  if (!(req.ctx.org.modules || []).includes('clinic')) throw forbidden('This provider does not offer consultations');
  const a = await book(req, b, 'staff');
  res.json(await C.apptForStaff(a));
}));
router.get('/fd/appointments', fdRead, ah(async (req, res) => {
  const q = query(req, { date: t.date(), doctorMembershipId: t.id(), status: t.enum(Object.keys(C.APPT_TRANSITIONS)), patientId: t.id() });
  const f = { orgId: req.ctx.org.id };
  if (q.patientId) { await P.requireLinked(req, q.patientId); f.patientId = q.patientId; }
  else { const r = C.dayRangeUtc(q.date || todayLagos()); f.startUtc = { $gte: r.start, $lt: r.end }; }
  if (q.doctorMembershipId) f.doctorMembershipId = q.doctorMembershipId;
  if (q.status) f.status = q.status;
  const rows = await db.col('appointments').find(f, { sort: { startUtc: 1 }, limit: 500 });
  const cache = {}; const out = []; for (const a of rows) out.push(await C.apptForStaff(a, cache));
  res.json(out);
}));
router.get('/fd/appointments/:id', fdRead, ah(async (req, res) => {
  const a = await db.col('appointments').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!a) throw notFound('Appointment not found');
  res.json(await C.apptForStaff(a));
}));
router.post('/fd/appointments/:id/cancel', fdWrite, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 3, max: 300 }) });
  const a = await db.col('appointments').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!a) throw notFound('Appointment not found');
  const done = await cancel(req, a, { from: ['booked', 'checked_in'], by: 'provider', reason: b.reason });
  res.json(await C.apptForStaff(done));
}));
router.post('/fd/appointments/:id/no-show', fdWrite, ah(async (req, res) => {
  const a = await db.col('appointments').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!a) throw notFound('Appointment not found');
  if (now() < a.startUtc) throw conflict('An appointment can be marked as a no-show only after its start time.', 'too_early');
  const done = await C.move('appointments', C.APPT_TRANSITIONS, { id: a.id, orgId: a.orgId }, 'no_show', { noShowAt: now(), noShowBy: req.ctx.user.id }, { from: ['booked'] });
  if (!done) throw C.stateConflict('appointment', a.status, 'no_show');
  await audit(req, 'clinic.appointment_no_show', { type: 'appointment', id: a.id, patientId: a.patientId });
  res.json(await C.apptForStaff(done));
}));

/* ---------------- doctor ---------------- */
const docRead = A.requireStaff({ perm: 'clinic.consult', module: 'clinic' });
router.get('/doc/appointments', docRead, ah(async (req, res) => {
  const q = query(req, { date: t.date(), scope: t.enum(['day', 'upcoming']), status: t.enum(Object.keys(C.APPT_TRANSITIONS)) });
  const f = { orgId: req.ctx.org.id, doctorMembershipId: req.ctx.membership.id };
  if (q.scope === 'upcoming') { f.status = { $in: C.ACTIVE_APPT }; f.endUtc = { $gte: now() - C.VIDEO_LATE_MS }; }
  else { const r = C.dayRangeUtc(q.date || todayLagos()); f.startUtc = { $gte: r.start, $lt: r.end }; }
  if (q.status) f.status = q.status;
  const rows = await db.col('appointments').find(f, { sort: { startUtc: 1 }, limit: 500 });
  const out = []; for (const a of rows) out.push(await C.apptForStaff(a));
  res.json(out);
}));
router.get('/doc/appointments/:id', docRead, ah(async (req, res) => {
  const a = await db.col('appointments').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id, doctorMembershipId: req.ctx.membership.id });
  if (!a) throw notFound('Appointment not found');
  res.json(await C.apptForStaff(a));
}));

module.exports = { router, book, cancel };
