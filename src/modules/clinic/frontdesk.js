'use strict';
/*
 * Front desk for every provider type: check-in queue per service point, vitals and triage,
 * and customer care cases. Only linked patients can be queued; a doctor on a queue item must
 * work at the same provider. `activeKey` (unique, sparse) stops the same patient being queued
 * twice at the same service point while an earlier entry is still active.
 */
const express = require('express');
const db = require('../../db');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param } = require('../../lib/http');
const A = require('../../lib/auth');
const { id, now, todayLagos } = require('../../lib/util');
const { audit } = require('../../lib/audit');
const { notify } = require('../../lib/notify');
const P = require('../patients');
const { nextNumber } = require('../orgs');
const C = require('./common');

db.index('queue', ['activeKey'], { unique: true, sparse: true });
db.index('queue', ['orgId', 'servicePoint', 'status']);
db.index('queue', ['orgId', 'at']);
db.index('vitals', ['patientId', 'at']);
db.index('vitals', ['orgId', 'at']);
db.index('care_cases', ['orgId', 'status', 'updatedAt']);

const router = express.Router();
const SERVICE_POINTS = ['doctor', 'pharmacy', 'lab', 'cashier', 'triage'];
const PRIORITIES = ['emergency', 'urgent', 'routine'];
const PRI_RANK = { emergency: 0, urgent: 1, routine: 2 };
const SP_PREFIX = { doctor: 'D', pharmacy: 'P', lab: 'L', cashier: 'C', triage: 'T' };

/* ---------------- views ---------------- */
async function queueView(q, nameCache = {}) {
  const pb = await C.patientBrief(q.patientId, q.orgId);
  let doctorName = null;
  if (q.doctorMembershipId) {
    if (nameCache[q.doctorMembershipId] === undefined) { const m = await db.col('memberships').findOne({ id: q.doctorMembershipId }); nameCache[q.doctorMembershipId] = m ? await C.userName(m.userId) : null; }
    doctorName = nameCache[q.doctorMembershipId];
  }
  const v = await db.col('vitals').findOne({ orgId: q.orgId, patientId: q.patientId, at: { $gte: q.at - 12 * 3600e3 } }, { sort: { at: -1 } });
  return {
    id: q.id, number: q.number, patientId: q.patientId, patient: { name: pb.name, mrn: pb.mrn, age: pb.age, sex: pb.sex }, appointmentId: q.appointmentId || null,
    servicePoint: q.servicePoint, doctorMembershipId: q.doctorMembershipId || null, doctorName, priority: q.priority, status: q.status, complaint: q.complaint || null,
    at: q.at, calledAt: q.calledAt || null, startedAt: q.startedAt || null, doneAt: q.doneAt || null, leftAt: q.leftAt || null, encounterId: q.encounterId || null,
    waitMin: Math.max(0, Math.round(((q.startedAt || (C.ACTIVE_QUEUE.includes(q.status) ? now() : (q.doneAt || q.leftAt || now()))) - q.at) / 60000)),
    latestVitals: v ? vitalsView(v) : null,
  };
}

/* ---------------- check-in ---------------- */
router.post('/fd/queue', A.requireStaff({ perm: 'queue.manage' }), A.requireOnShift, ah(async (req, res) => {
  const b = body(req, {
    patientId: t.id({ required: true }), appointmentId: t.id(), servicePoint: t.enum(SERVICE_POINTS, { required: true }),
    doctorMembershipId: t.id(), priority: t.enum(PRIORITIES, { default: 'routine' }), complaint: t.str({ max: 300 }),
  });
  const orgId = req.ctx.org.id;
  await P.requireLinked(req, b.patientId);
  let appt = null;
  if (b.appointmentId) {
    appt = await db.col('appointments').findOne({ id: b.appointmentId, orgId, patientId: b.patientId });
    if (!appt) throw notFound('Appointment not found');
    if (b.servicePoint !== 'doctor') throw bad('An appointment check-in goes to the doctor service point');
    if (appt.status !== 'booked') throw C.stateConflict('appointment', appt.status, 'checked_in');
  }
  const docId = b.doctorMembershipId || (appt ? appt.doctorMembershipId : null);
  if (docId) {
    if (b.servicePoint !== 'doctor') throw bad('Only the doctor service point takes a doctor');
    if (appt && docId !== appt.doctorMembershipId) throw bad('The appointment is with a different doctor');
    await C.doctorAt(orgId, docId);
  }
  const n = await nextNumber('queue_' + orgId + '_' + todayLagos());
  const item = {
    id: id('q'), orgId, patientId: b.patientId, appointmentId: appt ? appt.id : null, servicePoint: b.servicePoint, doctorMembershipId: docId || null,
    priority: b.priority, complaint: b.complaint || (appt ? appt.reason : null) || null, status: 'waiting', number: SP_PREFIX[b.servicePoint] + '-' + String(n).padStart(3, '0'),
    at: now(), activeKey: orgId + '|' + b.patientId + '|' + b.servicePoint, checkedInBy: req.ctx.user.id, encounterId: null,
  };
  try { await db.col('queue').insertOne(item); } catch (e) { if (e.code === 11000) throw conflict('This patient is already waiting at that service point.', 'already_queued'); throw e; }
  if (appt) {
    const moved = await C.move('appointments', C.APPT_TRANSITIONS, { id: appt.id, orgId }, 'checked_in', { checkedInAt: now(), queueId: item.id }, { from: ['booked'] });
    if (!moved) { await db.col('queue').deleteOne({ id: item.id, orgId }); const cur = await db.col('appointments').findOne({ id: appt.id }); throw C.stateConflict('appointment', cur && cur.status, 'checked_in'); }
  }
  await audit(req, 'clinic.queue_checkin', { type: 'queue', id: item.id, patientId: item.patientId }, { servicePoint: item.servicePoint, appointmentId: item.appointmentId, priority: item.priority });
  if (docId) { const m = await db.col('memberships').findOne({ id: docId }); if (m) await notify({ userId: m.userId, title: 'Patient checked in', body: 'Ticket ' + item.number + ' is waiting for you.', kind: 'queue', ref: { type: 'queue', id: item.id } }); }
  res.json(await queueView(item));
}));

const queueRead = A.requireStaff({ anyPerm: ['queue.manage', 'vitals.record', 'clinic.consult', 'billing.cash', 'billing.create', 'pharmacy.dispense', 'lab.receive', 'patient.read'] });
router.get('/fd/queue', queueRead, ah(async (req, res) => {
  const q = query(req, { servicePoint: t.enum(SERVICE_POINTS), status: t.enum(['active', 'today'].concat(Object.keys(C.QUEUE_TRANSITIONS))), doctorMembershipId: t.id(), mine: t.bool() });
  const f = { orgId: req.ctx.org.id };
  if (q.servicePoint) f.servicePoint = q.servicePoint;
  const st = q.status || 'active';
  if (st === 'active') f.status = { $in: C.ACTIVE_QUEUE };
  else if (st === 'today') f.at = { $gte: C.dayRangeUtc(todayLagos()).start };
  else { f.status = st; f.at = { $gte: C.dayRangeUtc(todayLagos()).start }; }
  if (q.mine) f.doctorMembershipId = { $in: [req.ctx.membership.id, null] };
  else if (q.doctorMembershipId) f.doctorMembershipId = q.doctorMembershipId;
  const rows = await db.col('queue').find(f, { limit: 500 });
  rows.sort((a, b) => (C.ACTIVE_QUEUE.includes(a.status) ? 0 : 1) - (C.ACTIVE_QUEUE.includes(b.status) ? 0 : 1) || PRI_RANK[a.priority] - PRI_RANK[b.priority] || a.at - b.at);
  const cache = {}; const out = [];
  for (const r of rows) out.push(await queueView(r, cache));
  res.json(out);
}));

/* call / start / done / left */
const ACTIONS = { call: { to: 'called', stamp: 'calledAt' }, start: { to: 'in_service', stamp: 'startedAt' }, done: { to: 'done', stamp: 'doneAt' }, left: { to: 'left', stamp: 'leftAt' } };
const queueAct = A.requireStaff({ anyPerm: ['queue.manage', 'clinic.consult', 'vitals.record', 'billing.cash', 'pharmacy.dispense', 'lab.receive'] });
router.post('/fd/queue/:id/:action(call|start|done|left)', queueAct, A.requireOnShift, ah(async (req, res) => {
  const act = ACTIONS[req.params.action];
  const item = await db.col('queue').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!item) throw notFound('Queue entry not found');
  const set = { [act.stamp]: now(), [act.stamp.replace('At', 'By')]: req.ctx.user.id };
  const filter = { id: item.id, orgId: item.orgId };
  if (item.servicePoint === 'doctor' && !A.has(req, 'queue.manage')) {
    if (!A.has(req, 'clinic.consult')) throw forbidden('Only the front desk or a doctor can move this patient');
    if (item.doctorMembershipId && item.doctorMembershipId !== req.ctx.membership.id) throw forbidden('This patient is waiting for another doctor');
    filter.doctorMembershipId = { $in: [req.ctx.membership.id, null] };
    if (act.to === 'called' || act.to === 'in_service') set.doctorMembershipId = req.ctx.membership.id;
  }
  const extra = ['done', 'left'].includes(act.to) ? { $unset: { activeKey: '' } } : undefined;
  const done = await C.move('queue', C.QUEUE_TRANSITIONS, filter, act.to, set, { extra });
  if (!done) { const cur = await db.col('queue').findOne({ id: item.id }); throw C.stateConflict('queue entry', cur && cur.status, act.to); }
  await audit(req, 'clinic.queue_' + req.params.action, { type: 'queue', id: done.id, patientId: done.patientId }, { servicePoint: done.servicePoint });
  if (act.to === 'called') await notify({ patientId: done.patientId, title: 'It is your turn', body: 'Ticket ' + done.number + ': please come to the ' + done.servicePoint + '.', kind: 'queue', ref: { type: 'queue', id: done.id } });
  res.json(await queueView(done));
}));

router.post('/fd/queue/:id/triage', A.requireStaff({ anyPerm: ['queue.manage', 'vitals.record'] }), A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { priority: t.enum(PRIORITIES, { required: true }) });
  const done = await db.col('queue').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id, status: { $in: C.ACTIVE_QUEUE } }, { $set: { priority: b.priority, triagedAt: now(), triagedBy: req.ctx.user.id } });
  if (!done) throw notFound('Active queue entry not found');
  await audit(req, 'clinic.queue_triage', { type: 'queue', id: done.id, patientId: done.patientId }, { priority: b.priority });
  res.json(await queueView(done));
}));

/* ---------------- vitals ---------------- */
const VITAL_FIELDS = {
  bpSys: t.int({ min: 50, max: 260, label: 'Systolic blood pressure (mmHg)' }), bpDia: t.int({ min: 30, max: 160, label: 'Diastolic blood pressure (mmHg)' }),
  pulse: t.int({ min: 20, max: 250, label: 'Pulse (beats/min)' }), tempC: t.num({ min: 30, max: 45, label: 'Temperature (C)' }),
  spo2: t.int({ min: 50, max: 100, label: 'Oxygen saturation (%)' }), rr: t.int({ min: 4, max: 80, label: 'Respiratory rate (breaths/min)' }),
  weightKg: t.num({ min: 0.3, max: 400, label: 'Weight (kg)' }), heightCm: t.num({ min: 20, max: 250, label: 'Height (cm)' }),
  glucose: t.num({ min: 0.5, max: 40, label: 'Blood glucose (mmol/L)' }),
};
const VKEYS = Object.keys(VITAL_FIELDS);

/** flags + a suggested triage priority (adult thresholds; clinical judgement decides) */
function assess(v) {
  const flags = []; let pri = 'routine';
  const up = p => { if (PRI_RANK[p] < PRI_RANK[pri]) pri = p; };
  const f = (field, level, message, p) => { flags.push({ field, level, message }); if (p) up(p); };
  if (v.bpSys != null) {
    if (v.bpSys >= 180 || v.bpDia >= 120) f('bp', 'critical', 'Blood pressure in the crisis range', 'emergency');
    else if (v.bpSys >= 140 || v.bpDia >= 90) f('bp', 'high', 'High blood pressure');
    else if (v.bpSys < 90) f('bp', 'low', 'Low blood pressure', 'urgent');
  }
  if (v.pulse != null) { if (v.pulse > 130 || v.pulse < 40) f('pulse', 'critical', 'Pulse is dangerously ' + (v.pulse > 130 ? 'fast' : 'slow'), 'emergency'); else if (v.pulse > 100) f('pulse', 'high', 'Fast pulse', 'urgent'); else if (v.pulse < 50) f('pulse', 'low', 'Slow pulse'); }
  if (v.tempC != null) { if (v.tempC >= 40) f('tempC', 'critical', 'Very high fever', 'emergency'); else if (v.tempC >= 38) f('tempC', 'high', 'Fever', 'urgent'); else if (v.tempC < 35) f('tempC', 'critical', 'Low body temperature', 'emergency'); }
  if (v.spo2 != null) { if (v.spo2 < 90) f('spo2', 'critical', 'Low oxygen', 'emergency'); else if (v.spo2 < 94) f('spo2', 'low', 'Oxygen below normal', 'urgent'); }
  if (v.rr != null) { if (v.rr > 30 || v.rr < 8) f('rr', 'critical', 'Abnormal breathing rate', 'emergency'); else if (v.rr > 20) f('rr', 'high', 'Fast breathing', 'urgent'); }
  if (v.glucose != null) { if (v.glucose < 3.0) f('glucose', 'critical', 'Low blood sugar', 'emergency'); else if (v.glucose < 4.0) f('glucose', 'low', 'Blood sugar below normal', 'urgent'); else if (v.glucose >= 20) f('glucose', 'critical', 'Very high blood sugar', 'emergency'); else if (v.glucose >= 11.1) f('glucose', 'high', 'High blood sugar'); }
  return { flags, suggestedPriority: pri };
}
function vitalsView(v) {
  const out = { id: v.id, orgId: v.orgId, patientId: v.patientId, at: v.at, by: v.by, byName: v.byName || null, queueId: v.queueId || null, encounterId: v.encounterId || null, bmi: v.bmi || null, flags: v.flags || [], suggestedPriority: v.suggestedPriority || 'routine' };
  VKEYS.forEach(k => { out[k] = v[k] == null ? null : v[k]; });
  return out;
}

async function recordVitals(req, patientId, b, refs = {}) {
  const vals = {}; VKEYS.forEach(k => { if (b[k] != null) vals[k] = b[k]; });
  if (!Object.keys(vals).length) throw bad('Enter at least one measurement');
  if ((vals.bpSys == null) !== (vals.bpDia == null)) throw bad('Enter both systolic and diastolic blood pressure');
  if (vals.bpSys != null && vals.bpDia >= vals.bpSys) throw bad('Diastolic pressure must be lower than systolic pressure');
  const a = assess(vals);
  const doc = Object.assign({ id: id('vt'), orgId: req.ctx.org.id, patientId, at: now(), by: req.ctx.user.id, byName: req.ctx.user.name, queueId: refs.queueId || null, encounterId: refs.encounterId || null }, vals, a);
  if (vals.weightKg && vals.heightCm) doc.bmi = Math.round(vals.weightKg / ((vals.heightCm / 100) ** 2) * 10) / 10;
  await db.col('vitals').insertOne(doc);
  if (vals.weightKg) await db.col('patients').updateOne({ id: patientId }, { $set: { weightKg: vals.weightKg } });
  await audit(req, 'clinic.vitals_record', { type: 'vitals', id: doc.id, patientId }, { fields: Object.keys(vals), queueId: doc.queueId });
  return doc;
}

router.post('/fd/vitals', A.requireStaff({ perm: 'vitals.record' }), A.requireOnShift, ah(async (req, res) => {
  const b = body(req, Object.assign({ patientId: t.id({ required: true }), queueId: t.id() }, VITAL_FIELDS));
  await P.requireLinked(req, b.patientId);
  let item = null;
  if (b.queueId) { item = await db.col('queue').findOne({ id: b.queueId, orgId: req.ctx.org.id, patientId: b.patientId }); if (!item) throw notFound('Queue entry not found'); }
  const v = await recordVitals(req, b.patientId, b, { queueId: item ? item.id : null });
  // raise (never lower) the queue priority when the readings call for it
  if (item && PRI_RANK[v.suggestedPriority] < PRI_RANK[item.priority]) {
    await db.col('queue').updateOne({ id: item.id, orgId: item.orgId, status: { $in: C.ACTIVE_QUEUE }, priority: item.priority }, { $set: { priority: v.suggestedPriority, triagedAt: now(), triagedBy: 'vitals' } });
  }
  res.json(vitalsView(v));
}));
router.get('/fd/patients/:id/vitals', A.requireStaff({ anyPerm: ['vitals.record', 'clinic.consult', 'queue.manage', 'patient.read'] }), ah(async (req, res) => {
  const pid = param(req, 'id');
  await P.requireLinked(req, pid);
  const q = query(req, { limit: t.int({ min: 1, max: 200 }) });
  const rows = await db.col('vitals').find(await P.visibleRecordFilter(req, pid), { sort: { at: -1 }, limit: q.limit || 50 });
  await audit(req, 'clinic.vitals_view', { type: 'patient', id: pid, patientId: pid });
  res.json(rows.map(vitalsView));
}));

/* ---------------- customer care cases ---------------- */
const care = A.requireStaff({ perm: 'care.manage' });
const CHANNELS = ['phone', 'walk_in', 'whatsapp', 'email', 'app', 'sms', 'social', 'other'];
const CATEGORIES = ['enquiry', 'complaint', 'billing', 'appointment', 'results', 'prescription', 'feedback', 'other'];
const caseView = c => ({ id: c.id, number: c.number, orgId: c.orgId, patientId: c.patientId || null, patientName: c.patientName || null, channel: c.channel, category: c.category, priority: c.priority, subject: c.subject, status: c.status, notes: c.notes || [], createdAt: c.createdAt, createdByName: c.createdByName, updatedAt: c.updatedAt, resolvedAt: c.resolvedAt || null });
const noteOf = (req, text) => ({ id: id('cn'), at: now(), byUserId: req.ctx.user.id, byName: req.ctx.user.name, text: C.plainText(text) });

router.post('/fd/care-cases', care, ah(async (req, res) => {
  const b = body(req, { patientId: t.id(), channel: t.enum(CHANNELS, { required: true }), category: t.enum(CATEGORIES, { default: 'enquiry' }), priority: t.enum(['low', 'normal', 'high'], { default: 'normal' }), subject: t.str({ required: true, min: 3, max: 160 }), note: t.text({ max: 2000 }) });
  let patientName = null;
  if (b.patientId) { const { patient } = await P.requireLinked(req, b.patientId); patientName = patient.firstName + ' ' + patient.lastName; }
  const c = { id: id('cc'), number: 'CC-' + String(await nextNumber('care_' + req.ctx.org.id)).padStart(5, '0'), orgId: req.ctx.org.id, patientId: b.patientId || null, patientName, channel: b.channel, category: b.category, priority: b.priority,
    subject: C.plainText(b.subject), status: 'open', notes: b.note ? [noteOf(req, b.note)] : [], createdAt: now(), createdBy: req.ctx.user.id, createdByName: req.ctx.user.name, updatedAt: now(), resolvedAt: null };
  await db.col('care_cases').insertOne(c);
  await audit(req, 'clinic.care_case_create', { type: 'care_case', id: c.id, patientId: c.patientId }, { channel: c.channel, category: c.category });
  res.json(caseView(c));
}));
router.get('/fd/care-cases', care, ah(async (req, res) => {
  const q = query(req, { status: t.enum(Object.keys(C.CARE_TRANSITIONS)), patientId: t.id(), limit: t.int({ min: 1, max: 500 }) });
  const f = { orgId: req.ctx.org.id }; if (q.status) f.status = q.status; if (q.patientId) f.patientId = q.patientId;
  res.json((await db.col('care_cases').find(f, { sort: { updatedAt: -1 }, limit: q.limit || 100 })).map(caseView));
}));
router.get('/fd/care-cases/:id', care, ah(async (req, res) => {
  const c = await db.col('care_cases').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!c) throw notFound('Case not found');
  res.json(caseView(c));
}));
router.post('/fd/care-cases/:id/notes', care, ah(async (req, res) => {
  const b = body(req, { text: t.text({ required: true, max: 2000 }) });
  const c = await db.col('care_cases').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id }, { $push: { notes: noteOf(req, b.text) }, $set: { updatedAt: now() } });
  if (!c) throw notFound('Case not found');
  await audit(req, 'clinic.care_case_note', { type: 'care_case', id: c.id, patientId: c.patientId });
  res.json(caseView(c));
}));
router.post('/fd/care-cases/:id/status', care, ah(async (req, res) => {
  const b = body(req, { status: t.enum(Object.keys(C.CARE_TRANSITIONS), { required: true }) });
  const cur = await db.col('care_cases').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!cur) throw notFound('Case not found');
  const set = { updatedAt: now() }; if (b.status === 'resolved') set.resolvedAt = now();
  const c = await C.move('care_cases', C.CARE_TRANSITIONS, { id: cur.id, orgId: cur.orgId }, b.status, set);
  if (!c) throw C.stateConflict('case', cur.status, b.status);
  await audit(req, 'clinic.care_case_status', { type: 'care_case', id: c.id, patientId: c.patientId }, { status: b.status });
  res.json(caseView(c));
}));

module.exports = { router, recordVitals, vitalsView, assess, VITAL_FIELDS, SERVICE_POINTS, PRIORITIES };
