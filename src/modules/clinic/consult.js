'use strict';
/*
 * Consultations (encounters), the doctor's chart view, prescribing with safety checks,
 * lab orders, and the clinical reference searches (formulary, ICD-10, lab tests).
 *
 * An encounter starts from an appointment or a queue entry (exactly once: the conditional
 * status change on the appointment, or the claim of the queue entry, is the lock). Only the
 * doctor who started it can write to it, and only while it is open.
 */
const express = require('express');
const db = require('../../db');
const { HttpError, ah, body, query, t, bad, forbidden, notFound, param } = require('../../lib/http');
const A = require('../../lib/auth');
const { id, now, todayLagos } = require('../../lib/util');
const { audit } = require('../../lib/audit');
const { notify } = require('../../lib/notify');
const P = require('../patients');
const F = require('../../clinical/formulary');
const SAFETY = require('../../clinical/safety');
const LABTESTS = require('../../clinical/labtests');
const ICD = require('../../clinical/icd10');
const C = require('./common');
const FD = require('./frontdesk');

db.index('encounters', ['orgId', 'patientId', 'startedAt']);
db.index('encounters', ['patientId', 'startedAt']);
db.index('encounters', ['doctorMembershipId', 'status']);
db.index('prescriptions', ['patientId', 'createdAt']);
db.index('prescriptions', ['orgId', 'createdAt']);
db.index('prescriptions', ['encounterId']);

const router = express.Router();
const doc = A.requireStaff({ perm: 'clinic.consult', module: 'clinic' });
const prescriber = A.requireStaff({ perm: 'clinic.prescribe', module: 'clinic' });
const labOrderer = A.requireStaff({ perm: 'clinic.order_lab', module: 'clinic' });
const RX_LOOKBACK_MS = 90 * 86400e3;
const ROUTES = ['oral', 'iv', 'im', 'sc', 'topical', 'inhaled', 'rectal', 'vaginal', 'sublingual', 'ophthalmic', 'otic', 'nasal', 'other'];
const NOTE_FIELDS = ['complaint', 'history', 'examination', 'assessment', 'plan'];

/* ---------------- views ---------------- */
function encounterView(e, extra = {}) {
  return Object.assign({
    id: e.id, orgId: e.orgId, patientId: e.patientId, appointmentId: e.appointmentId || null, queueId: e.queueId || null,
    doctorMembershipId: e.doctorMembershipId, doctorName: e.doctorName, type: e.type, status: e.status,
    startedAt: e.startedAt, completedAt: e.completedAt || null, updatedAt: e.updatedAt,
    notes: e.notes || {}, diagnoses: e.diagnoses || [], followUp: e.followUp || null, labOrderIds: e.labOrderIds || [],
  }, extra);
}
function rxView(r) {
  return { id: r.id, orgId: r.orgId, patientId: r.patientId, encounterId: r.encounterId, prescriberMembershipId: r.prescriberMembershipId, prescriberName: r.prescriberName,
    items: r.items, safety: r.safety, status: r.status, routedTo: r.routedTo || null, sendTo: r.sendTo || null, createdAt: r.createdAt, cancelledAt: r.cancelledAt || null, cancelReason: r.cancelReason || null };
}

/* ---------------- shared rules ---------------- */
const notesRule = t.obj(Object.fromEntries(NOTE_FIELDS.map(k => [k, t.text({ max: 5000 })])));
const diagRule = t.arr(t.obj({ code: t.str({ required: true, max: 10, upper: true, label: 'ICD-10 code' }), text: t.str({ max: 200 }), primary: t.bool() }), { max: 20 });
const followRule = t.obj({ date: t.date(), note: t.str({ max: 300 }) });
const itemRule = t.obj({
  drugCode: t.str({ max: 24, upper: true }), drugName: t.str({ max: 120 }), doseMg: t.num({ min: 0.001, max: 100000 }), doseText: t.str({ required: true, max: 80, label: 'Dose' }),
  frequency: t.enum(Object.keys(SAFETY.FREQ), { required: true }), durationDays: t.int({ required: true, min: 1, max: 365, label: 'Duration (days)' }),
  quantity: t.int({ required: true, min: 1, max: 10000 }), route: t.enum(ROUTES, { default: 'oral' }), instructions: t.str({ max: 300 }),
});

function normDiagnoses(list) {
  const out = list.map(d => {
    if (!ICD.valid(d.code)) throw bad('"' + d.code + '" is not a valid ICD-10 code (for example I10 or B50.9)');
    const known = ICD.find(d.code);
    if (!known && !d.text) throw bad('Add a description for ' + d.code + ' (it is not in the MediCore list)');
    return { code: d.code, text: d.text || known.text, primary: !!d.primary };
  });
  if (out.length && !out.some(d => d.primary)) out[0].primary = true;
  if (out.filter(d => d.primary).length > 1) throw bad('Only one diagnosis can be primary');
  return out;
}
function normItems(items) {
  return items.map((it, i) => {
    let drug = it.drugCode ? F.find(it.drugCode) : null;
    if (it.drugCode && !drug) throw bad('Unknown drug code ' + it.drugCode + '. Search the formulary, or give only the drug name.');
    if (!drug && it.drugName) drug = F.find(it.drugName);
    if (!drug && !it.drugName) throw bad('Item ' + (i + 1) + ' needs a drug code or a drug name');
    return { drugCode: drug ? drug.code : null, drugName: drug ? drug.name : it.drugName, doseMg: it.doseMg != null ? it.doseMg : null, doseText: it.doseText, frequency: it.frequency,
      durationDays: it.durationDays, quantity: it.quantity, route: it.route || 'oral', instructions: it.instructions || null };
  });
}
/** this patient's medicines from the last 90 days that the caller's provider may see */
async function currentMeds(req, patientId) {
  const f = Object.assign(await P.visibleRecordFilter(req, patientId), { status: { $in: ['active', 'sent'] }, createdAt: { $gte: now() - RX_LOOKBACK_MS } });
  const rows = await db.col('prescriptions').find(f, { sort: { createdAt: -1 }, limit: 200 });
  return rows.flatMap(r => (r.items || []).map(i => ({ drugCode: i.drugCode, drugName: i.drugName, prescriptionId: r.id, orgId: r.orgId, at: r.createdAt })));
}
async function runSafety(req, patient, items, pregnant) {
  const meds = await currentMeds(req, patient.id);
  const r = SAFETY.check({ patient, items, currentMeds: meds, pregnant: !!pregnant && patient.sex !== 'male' });
  return Object.assign(r, { currentMeds: meds.map(m => ({ drugCode: m.drugCode, drugName: m.drugName, prescriptionId: m.prescriptionId })) });
}

/** the caller's own encounter at this provider (404 if not theirs or not here) */
async function ownEncounter(req, encId, { open } = {}) {
  const e = await db.col('encounters').findOne({ id: encId, orgId: req.ctx.org.id });
  if (!e) throw notFound('Consultation not found');
  if (e.doctorMembershipId !== req.ctx.membership.id) throw forbidden('Only the doctor running this consultation can change it');
  if (open && e.status !== 'open') throw C.stateConflict('consultation', e.status, 'changed');
  return e;
}

/* ---------------- start a consultation ---------------- */
router.post('/doc/encounters', doc, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { appointmentId: t.id(), queueId: t.id() });
  if (!b.appointmentId && !b.queueId) throw bad('Start a consultation from an appointment or a queue entry');
  const orgId = req.ctx.org.id, me = req.ctx.membership.id;
  let appt = null, item = null;
  if (b.queueId) {
    item = await db.col('queue').findOne({ id: b.queueId, orgId, servicePoint: 'doctor' });
    if (!item) throw notFound('Queue entry not found');
    if (item.doctorMembershipId && item.doctorMembershipId !== me) throw forbidden('This patient is waiting for another doctor');
    if (item.appointmentId && !b.appointmentId) b.appointmentId = item.appointmentId;
  }
  if (b.appointmentId) {
    appt = await db.col('appointments').findOne({ id: b.appointmentId, orgId });
    if (!appt) throw notFound('Appointment not found');
    if (appt.doctorMembershipId !== me) throw forbidden('This appointment is with another doctor');
    if (item && item.appointmentId && item.appointmentId !== appt.id) throw bad('The queue entry belongs to a different appointment');
    if (!item && appt.queueId) item = await db.col('queue').findOne({ id: appt.queueId, orgId });
    if (appt.type === 'video' && C.tun.payBeforeVideo(req.ctx.org)) {
      const bill = appt.billId ? await db.col('bills').findOne({ id: appt.billId, orgId }) : null;
      if (!bill || bill.status !== 'paid') throw new HttpError(402, 'This video visit has not been paid yet.', 'payment_required');
    }
  }
  const patientId = appt ? appt.patientId : item.patientId;
  await P.requireLinked(req, patientId);
  const encId = id('enc'), t0 = now();
  if (appt) {
    const moved = await C.move('appointments', C.APPT_TRANSITIONS, { id: appt.id, orgId, doctorMembershipId: me }, 'in_consult', { startedAt: t0, encounterId: encId }, { from: ['booked', 'checked_in'] });
    if (!moved) { const cur = await db.col('appointments').findOne({ id: appt.id }); throw C.stateConflict('appointment', cur && cur.status, 'in_consult'); }
  }
  if (item) {
    const claimed = await db.col('queue').findOneAndUpdate({ id: item.id, orgId, servicePoint: 'doctor', status: { $in: C.ACTIVE_QUEUE }, encounterId: null, doctorMembershipId: { $in: [me, null] } },
      { $set: { status: 'in_service', startedAt: item.startedAt || t0, startedBy: req.ctx.user.id, doctorMembershipId: me, encounterId: encId } });
    if (!claimed && !appt) { const cur = await db.col('queue').findOne({ id: item.id }); throw C.stateConflict('queue entry', cur && (cur.encounterId ? 'already in consultation' : cur.status), 'in_service'); }
  }
  const e = {
    id: encId, orgId, patientId, appointmentId: appt ? appt.id : null, queueId: item ? item.id : null, doctorMembershipId: me, doctorUserId: req.ctx.user.id, doctorName: req.ctx.user.name,
    type: appt ? appt.type : 'walk_in', status: 'open', startedAt: t0, completedAt: null, updatedAt: t0,
    notes: { complaint: (item && item.complaint) || (appt && appt.reason) || null, history: null, examination: null, assessment: null, plan: null }, diagnoses: [], followUp: null, labOrderIds: [],
  };
  await db.col('encounters').insertOne(e);
  await audit(req, 'clinic.encounter_start', { type: 'encounter', id: e.id, patientId }, { appointmentId: e.appointmentId, queueId: e.queueId });
  res.json(encounterView(e, { patient: await C.patientBrief(patientId, orgId) }));
}));

function encounterUpdate(b) {
  const set = {};
  if (b.notes) NOTE_FIELDS.forEach(k => { if (b.notes[k] !== undefined) set['notes.' + k] = C.plainText(b.notes[k]); });
  if (b.diagnoses) set.diagnoses = normDiagnoses(b.diagnoses);
  if (b.followUp) set.followUp = { date: b.followUp.date || null, note: b.followUp.note || null };
  return set;
}
const encBody = { notes: notesRule, diagnoses: diagRule, followUp: followRule };

router.patch('/doc/encounters/:id', doc, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, encBody);
  const e = await ownEncounter(req, param(req, 'id'), { open: true });
  const set = encounterUpdate(b);
  if (!Object.keys(set).length) throw bad('Nothing to change');
  set.updatedAt = now();
  const upd = await db.col('encounters').findOneAndUpdate({ id: e.id, orgId: e.orgId, doctorMembershipId: e.doctorMembershipId, status: 'open' }, { $set: set });
  if (!upd) throw C.stateConflict('consultation', 'completed', 'changed');
  await audit(req, 'clinic.encounter_update', { type: 'encounter', id: e.id, patientId: e.patientId }, { fields: Object.keys(set) });
  res.json(encounterView(upd));
}));

router.post('/doc/encounters/:id/complete', doc, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, encBody);
  const e = await ownEncounter(req, param(req, 'id'));
  const set = encounterUpdate(b);
  const diagnoses = set.diagnoses || e.diagnoses || [];
  const assessment = set['notes.assessment'] !== undefined ? set['notes.assessment'] : (e.notes || {}).assessment;
  if (!diagnoses.length && !assessment) throw bad('Add at least one diagnosis or an assessment before completing');
  Object.assign(set, { completedAt: now(), updatedAt: now() });
  const done = await C.move('encounters', C.ENCOUNTER_TRANSITIONS, { id: e.id, orgId: e.orgId, doctorMembershipId: e.doctorMembershipId }, 'completed', set);
  if (!done) throw C.stateConflict('consultation', 'completed', 'completed');
  if (done.appointmentId) await C.move('appointments', C.APPT_TRANSITIONS, { id: done.appointmentId, orgId: done.orgId }, 'completed', { completedAt: now() }, { from: ['in_consult'] });
  if (done.queueId) await C.move('queue', C.QUEUE_TRANSITIONS, { id: done.queueId, orgId: done.orgId }, 'done', { doneAt: now(), doneBy: req.ctx.user.id }, { extra: { $unset: { activeKey: '' } } });
  await audit(req, 'clinic.encounter_complete', { type: 'encounter', id: done.id, patientId: done.patientId }, { diagnoses: (done.diagnoses || []).map(d => d.code) });
  await notify({ patientId: done.patientId, title: 'Visit summary ready', body: 'Your consultation at ' + req.ctx.org.name + ' is complete. See the summary in the app.', kind: 'encounter', ref: { type: 'encounter', id: done.id } });
  res.json(encounterView(done));
}));

router.get('/doc/encounters', doc, ah(async (req, res) => {
  const q = query(req, { status: t.enum(Object.keys(C.ENCOUNTER_TRANSITIONS)), date: t.date(), limit: t.int({ min: 1, max: 200 }) });
  const f = { orgId: req.ctx.org.id, doctorMembershipId: req.ctx.membership.id };
  if (q.status) f.status = q.status;
  if (q.date) { const r = C.dayRangeUtc(q.date); f.startedAt = { $gte: r.start, $lt: r.end }; }
  const rows = await db.col('encounters').find(f, { sort: { startedAt: -1 }, limit: q.limit || 50 });
  const out = []; for (const e of rows) out.push(encounterView(e, { patient: await C.patientBrief(e.patientId, e.orgId) }));
  res.json(out);
}));

router.get('/doc/encounters/:id', doc, ah(async (req, res) => {
  const e = await db.col('encounters').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!e) throw notFound('Consultation not found');
  await P.requireLinked(req, e.patientId);
  const rx = await db.col('prescriptions').find({ encounterId: e.id, orgId: e.orgId }, { sort: { createdAt: 1 } });
  const vit = await db.col('vitals').find({ orgId: e.orgId, patientId: e.patientId, at: { $gte: e.startedAt - 12 * 3600e3, $lte: e.completedAt || now() } }, { sort: { at: -1 } });
  await audit(req, 'clinic.encounter_view', { type: 'encounter', id: e.id, patientId: e.patientId });
  res.json(encounterView(e, { patient: await C.patientBrief(e.patientId, e.orgId), prescriptions: rx.map(rxView), vitals: vit.map(FD.vitalsView), own: e.doctorMembershipId === req.ctx.membership.id }));
}));

/* doctors record vitals during the consultation */
router.post('/doc/encounters/:id/vitals', doc, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, FD.VITAL_FIELDS);
  const e = await ownEncounter(req, param(req, 'id'), { open: true });
  const v = await FD.recordVitals(req, e.patientId, b, { encounterId: e.id, queueId: e.queueId });
  res.json(FD.vitalsView(v));
}));

/* ---------------- chart ---------------- */
async function labResults(req, patientId) {
  try {
    const lab = require('../lab');
    if (typeof lab.resultsForPatient !== 'function') return [];
    return (await lab.resultsForPatient(req, patientId)) || [];
  } catch (e) { return []; }
}
router.get('/doc/patients/:id/chart', doc, ah(async (req, res) => {
  const pid = param(req, 'id');
  const { patient, link } = await P.requireLinked(req, pid);
  const vis = await P.visibleRecordFilter(req, pid);
  const shared = !vis.orgId;
  const orgCache = {};
  const encs = await db.col('encounters').find(vis, { sort: { startedAt: -1 }, limit: 100 });
  const encounters = [];
  for (const e of encs) encounters.push(encounterView(e, { orgName: await C.orgName(e.orgId, orgCache), own: e.orgId === req.ctx.org.id }));
  const rx = await db.col('prescriptions').find(vis, { sort: { createdAt: -1 }, limit: 100 });
  const prescriptions = [];
  for (const r of rx) prescriptions.push(Object.assign(rxView(r), { orgName: await C.orgName(r.orgId, orgCache) }));
  const vit = await db.col('vitals').find(vis, { sort: { at: -1 }, limit: 50 });
  const appts = await db.col('appointments').find({ orgId: req.ctx.org.id, patientId: pid }, { sort: { startUtc: -1 }, limit: 20 });
  const meds = await currentMeds(req, pid);
  await audit(req, 'clinic.chart_view', { type: 'patient', id: pid, patientId: pid }, { shared });
  res.json({
    patient: P.staffView(patient, link),
    sharing: { shareHistory: shared, note: shared ? 'The patient shares records from all their providers with you.' : 'Showing only records from this provider. The patient has not switched on sharing for you.' },
    allergies: patient.allergies || [], noKnownAllergies: !!patient.noKnownAllergies, conditions: patient.conditions || [],
    currentMedicines: meds.map(m => ({ drugCode: m.drugCode, drugName: m.drugName, prescriptionId: m.prescriptionId, orgId: m.orgId, at: m.at })),
    vitals: vit.map(FD.vitalsView), encounters, prescriptions, labResults: await labResults(req, pid),
    appointments: appts.map(a => C.apptBase(a, req.ctx.org)),
  });
}));

/* ---------------- prescribing ---------------- */
router.post('/doc/safety-check', prescriber, ah(async (req, res) => {
  const b = body(req, { patientId: t.id({ required: true }), items: t.arr(itemRule, { required: true, min: 1, max: 20 }), pregnant: t.bool() });
  const { patient } = await P.requireLinked(req, b.patientId);
  const r = await runSafety(req, patient, normItems(b.items), b.pregnant);
  res.json({ alerts: r.alerts, blocking: r.blocking, currentMeds: r.currentMeds });
}));

router.post('/doc/encounters/:id/prescriptions', prescriber, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { items: t.arr(itemRule, { required: true, min: 1, max: 20 }), overrideReason: t.str({ min: 10, max: 500, label: 'Override reason' }), pregnant: t.bool(),
    sendTo: t.enum(['internal', 'patient_choice'], { required: true }), fulfilment: t.enum(['pickup', 'delivery'], { default: 'pickup' }) });
  const e = await ownEncounter(req, param(req, 'id'), { open: true });
  const { patient } = await P.requireLinked(req, e.patientId);
  const items = normItems(b.items);
  const safety = await runSafety(req, patient, items, b.pregnant);
  if (safety.blocking && !b.overrideReason) {
    throw new HttpError(409, 'This prescription has safety alerts. Change it, or give an override reason of at least 10 characters.', 'safety_alerts', { alerts: safety.alerts, blocking: true });
  }
  const org = req.ctx.org;
  let rx = {
    id: id('rx'), orgId: org.id, patientId: e.patientId, encounterId: e.id, prescriberUserId: req.ctx.user.id, prescriberMembershipId: req.ctx.membership.id, prescriberName: req.ctx.user.name,
    items, safety: { alerts: safety.alerts, blocking: safety.blocking, overrideReason: safety.blocking ? b.overrideReason : null, checkedAt: now() },
    status: 'active', routedTo: null, sendTo: b.sendTo, pregnant: !!b.pregnant, createdAt: now(),
  };
  await db.col('prescriptions').insertOne(rx);
  await audit(req, 'clinic.prescribe', { type: 'prescription', id: rx.id, patientId: rx.patientId }, { items: items.length, alerts: safety.alerts.length, overridden: !!rx.safety.overrideReason, sendTo: b.sendTo });
  const routing = { sentTo: null, rxOrderId: null, reason: null };
  if (b.sendTo === 'internal') {
    let ph = null; try { ph = require('../pharmacy'); } catch (err) { ph = null; }
    if (!(org.modules || []).includes('pharmacy')) routing.reason = 'no_internal_pharmacy';
    else if (!ph || typeof ph.createOrderFromPrescription !== 'function') routing.reason = 'pharmacy_module_not_ready';
    else {
      try {
        const order = await ph.createOrderFromPrescription({ prescription: rx, pharmacyOrgId: org.id, fulfilment: b.fulfilment || 'pickup', address: null, location: null, requestedBy: 'doctor' });
        const sent = await db.col('prescriptions').findOneAndUpdate({ id: rx.id, status: 'active' }, { $set: { status: 'sent', routedTo: { pharmacyOrgId: org.id, rxOrderId: order && order.id } } });
        rx = sent || await db.col('prescriptions').findOne({ id: rx.id });
        Object.assign(routing, { sentTo: org.id, rxOrderId: order && order.id });
      } catch (err) { routing.reason = 'pharmacy_error'; routing.error = err instanceof HttpError ? err.message : 'The pharmacy could not take the order. The patient can send it from the app.'; }
    }
  }
  await notify({ patientId: rx.patientId, title: 'New prescription', body: routing.sentTo ? 'Your prescription was sent to the ' + org.name + ' pharmacy.' : 'Open the app to choose a pharmacy for your prescription.', kind: 'prescription', ref: { type: 'prescription', id: rx.id } });
  res.json({ prescription: rxView(rx), safety: { alerts: safety.alerts, blocking: safety.blocking }, routing });
}));

router.post('/doc/prescriptions/:id/cancel', prescriber, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 3, max: 300 }) });
  const rx = await db.col('prescriptions').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!rx) throw notFound('Prescription not found');
  if (rx.prescriberMembershipId !== req.ctx.membership.id) throw forbidden('Only the prescriber can cancel this prescription');
  const done = await db.col('prescriptions').findOneAndUpdate({ id: rx.id, orgId: rx.orgId, status: 'active', routedTo: null }, { $set: { status: 'cancelled', cancelledAt: now(), cancelReason: b.reason } });
  if (!done) throw C.stateConflict('prescription', rx.status === 'active' ? 'already sent to a pharmacy' : rx.status, 'cancelled');
  await audit(req, 'clinic.prescription_cancel', { type: 'prescription', id: rx.id, patientId: rx.patientId });
  res.json(rxView(done));
}));

/* ---------------- lab orders ---------------- */
router.post('/doc/encounters/:id/lab-orders', labOrderer, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { tests: t.arr(t.obj({ code: t.str({ required: true, max: 20, upper: true }) }), { required: true, min: 1, max: 30 }), priority: t.enum(['routine', 'urgent'], { default: 'routine' }),
    clinicalNote: t.str({ max: 500 }), sendTo: t.enum(['internal', 'patient_choice'], { required: true }) });
  const e = await ownEncounter(req, param(req, 'id'), { open: true });
  const codes = [...new Set(b.tests.map(x => x.code))];
  const unknown = codes.filter(c => !LABTESTS.BY_CODE[c]);
  if (unknown.length) throw bad('Unknown test code' + (unknown.length > 1 ? 's: ' : ': ') + unknown.join(', '));
  let lab = null; try { lab = require('../lab'); } catch (err) { lab = null; }
  if (!lab || typeof lab.createLabOrder !== 'function') throw new HttpError(503, 'Lab ordering is not available yet: the lab module is still being set up. Try again later.', 'lab_module_not_ready');
  const internal = b.sendTo === 'internal' && (req.ctx.org.modules || []).includes('lab');
  const order = await lab.createLabOrder({ referringOrgId: req.ctx.org.id, labOrgId: internal ? req.ctx.org.id : null, patientId: e.patientId, tests: codes.map(code => ({ code })),
    orderedByUserId: req.ctx.user.id, orderedByName: req.ctx.user.name, encounterId: e.id, priority: b.priority, clinicalNote: C.plainText(b.clinicalNote) || null });
  if (order && order.id) await db.col('encounters').updateOne({ id: e.id, orgId: e.orgId }, { $push: { labOrderIds: order.id }, $set: { updatedAt: now() } });
  await audit(req, 'clinic.lab_order', { type: 'lab_order', id: order && order.id, patientId: e.patientId }, { tests: codes, internal, priority: b.priority });
  res.json({ order, routedInternally: internal, note: b.sendTo === 'internal' && !internal ? 'This provider has no lab, so the patient will choose a lab in the app.' : null });
}));

/* ---------------- clinical reference ---------------- */
const anyStaff = A.requireStaff({});
router.get('/clinical/drugs', anyStaff, ah(async (req, res) => {
  const q = query(req, { q: t.str({ max: 60 }), limit: t.int({ min: 1, max: 100 }) });
  res.json(F.search(q.q, q.limit || 20).map(d => ({ code: d.code, name: d.name, classes: d.classes, unitMg: d.unitMg, maxDailyMg: d.maxDailyMg, controlled: d.controlled, pregnancy: d.pregnancy })));
}));
router.get('/clinical/frequencies', anyStaff, ah(async (req, res) => {
  res.json(Object.keys(SAFETY.FREQ).map(k => ({ key: k, label: SAFETY.FREQ_LABEL[k], perDay: SAFETY.FREQ[k] })));
}));
router.get('/clinical/icd10', anyStaff, ah(async (req, res) => {
  const q = query(req, { q: t.str({ max: 60 }), limit: t.int({ min: 1, max: 100 }) });
  res.json(ICD.search(q.q, q.limit || 20).map(c => ({ code: c.code, text: c.text, group: c.group })));
}));
router.get('/clinical/labtests', anyStaff, ah(async (req, res) => {
  const q = query(req, { q: t.str({ max: 60 }), limit: t.int({ min: 1, max: 200 }) });
  const s = (q.q || '').toLowerCase();
  const rows = LABTESTS.TESTS.filter(x => !s || x.code.toLowerCase().includes(s) || x.name.toLowerCase().includes(s));
  res.json(rows.slice(0, q.limit || 100).map(x => ({ code: x.code, name: x.name, specimen: x.specimen, unit: x.unit, panel: x.panel, tatHours: x.tatHours })));
}));

/* ---------------- patient: visit summaries ---------------- */
router.get('/me/encounters', A.requirePatient, ah(async (req, res) => {
  const rows = await db.col('encounters').find(Object.assign({ patientId: req.ctx.patient.id, status: 'completed' }, await P.scopeFilter(req)), { sort: { startedAt: -1 }, limit: 200 });
  const cache = {}; const out = [];
  for (const e of rows) {
    const rxCount = await db.col('prescriptions').count({ encounterId: e.id, status: { $ne: 'cancelled' } });
    out.push({ id: e.id, orgId: e.orgId, orgName: await C.orgName(e.orgId, cache), doctorName: e.doctorName, type: e.type, date: C.utcToLagos(e.startedAt).date, startedAt: e.startedAt, completedAt: e.completedAt,
      complaint: (e.notes || {}).complaint || null, diagnoses: (e.diagnoses || []).map(d => ({ code: d.code, text: d.text, primary: d.primary })), plan: (e.notes || {}).plan || null,
      followUp: e.followUp || null, prescriptionCount: rxCount, labOrderCount: (e.labOrderIds || []).length });
  }
  res.json(out);
}));

module.exports = { router, currentMeds, runSafety, normItems, normDiagnoses, encounterView, rxView, todayLagos };
