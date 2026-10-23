'use strict';
/*
 * Shared helpers for the clinic module: state machines, conditional transitions,
 * doctor identity, schedules -> slots, and record views.
 */
const db = require('../../db');
const { HttpError, conflict, notFound } = require('../../lib/http');
const { utcToLagos, lagosToUtc, addDays } = require('../../lib/util');
const SET = require('../../lib/settings');

/* tunables from the settings layer (HQ, per-provider overrides), code constants as fallback */
const tun = {
  cancelMs: org => Number(SET.get('process.appointments.patientCancelHours', 2, org)) * 3600e3,
  slotMin: org => Number(SET.get('process.appointments.defaultSlotMinutes', 20, org)) || 20,
  earlyMs: org => Number(SET.get('process.appointments.videoJoinEarlyMinutes', 15, org)) * 60000,
  lateMs: org => Number(SET.get('process.appointments.videoJoinLateMinutes', 60, org)) * 60000,
  payBeforeVideo: org => (org && org.settings && typeof org.settings.payBeforeVideo === 'boolean' ? org.settings.payBeforeVideo : SET.get('process.appointments.payBeforeVideo', true, org) !== false),
  video: org => SET.feature('videoVisits', org),
  marketplace: org => SET.feature('marketplace', org),
};
async function orgDoc(orgId, cache) {
  if (cache && cache['doc:' + orgId] !== undefined) return cache['doc:' + orgId];
  const o = await db.col('orgs').findOne({ id: orgId }); if (cache) cache['doc:' + orgId] = o; return o;
}

/* ---------------- state machines ---------------- */
const APPT_TRANSITIONS = {
  booked: ['checked_in', 'in_consult', 'cancelled', 'no_show'],
  checked_in: ['in_consult', 'cancelled'],
  in_consult: ['completed'],
  completed: [], cancelled: [], no_show: [],
};
const QUEUE_TRANSITIONS = {
  waiting: ['called', 'in_service', 'left'],
  called: ['in_service', 'left'],
  in_service: ['done'],
  done: [], left: [],
};
const ENCOUNTER_TRANSITIONS = { open: ['completed'], completed: [] };
const CARE_TRANSITIONS = { open: ['pending', 'resolved'], pending: ['open', 'resolved'], resolved: ['open'] };
const THREAD_TRANSITIONS = { open: ['closed'], closed: ['open'] };
const ACTIVE_APPT = ['booked', 'checked_in', 'in_consult'];
const ACTIVE_QUEUE = ['waiting', 'called', 'in_service'];

/**
 * Conditional status change: only applies when the record is in a state that may move to `to`
 * (optionally narrowed with `from`). Returns the updated doc, or null when it was already done
 * or is in the wrong state (callers turn null into a 409).
 */
async function move(colName, map, filter, to, set = {}, opts = {}) {
  let froms = Object.keys(map).filter(f => map[f].includes(to));
  if (opts.from) froms = froms.filter(f => [].concat(opts.from).includes(f));
  if (!froms.length) return null;
  const upd = Object.assign({ $set: Object.assign({ status: to }, set) }, opts.extra || {});
  return db.col(colName).findOneAndUpdate(Object.assign({}, filter, { status: { $in: froms } }), upd);
}
function stateConflict(what, current, to) {
  return conflict('This ' + what + ' is ' + String(current || 'unknown').replace('_', ' ') + ' and cannot be moved to ' + to.replace('_', ' ') + '.', 'wrong_state');
}

/* ---------------- doctors ---------------- */
function isDoctor(m) {
  if (!m || m.status !== 'active') return false;
  if ((m.removedPerms || []).includes('clinic.consult')) return false;
  return m.role === 'doctor' || (m.extraPerms || []).includes('clinic.consult');
}
async function userName(userId) { const u = userId ? await db.col('users').findOne({ id: userId }, { projection: { name: 1 } }) : null; return u ? u.name : null; }
/** a doctor membership at a given org (404 otherwise) */
async function doctorAt(orgId, membershipId) {
  const m = await db.col('memberships').findOne({ id: membershipId, orgId });
  if (!isDoctor(m)) throw notFound('Doctor not found');
  return m;
}

/* ---------------- time ---------------- */
const dowOf = date => new Date(date + 'T00:00:00Z').getUTCDay();
const minutes = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const hhmm = mins => String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
const dayRangeUtc = date => ({ start: lagosToUtc(date, '00:00'), end: lagosToUtc(addDays(date, 1), '00:00') });

/** all slots a schedule offers on a Lagos date: [{ time, startUtc, endUtc }] */
function scheduleSlots(sched, date) {
  if (!sched) return [];
  const dow = dowOf(date); const step = sched.slotMin || 20; const out = [];
  for (const w of (sched.weekly || []).filter(x => x.dow === dow).sort((a, b) => minutes(a.start) - minutes(b.start))) {
    for (let t = minutes(w.start); t + step <= minutes(w.end); t += step) {
      const startUtc = lagosToUtc(date, hhmm(t));
      out.push({ time: hhmm(t), startUtc, endUtc: startUtc + step * 60000 });
    }
  }
  return out;
}
const overlaps = (a, b) => a.startUtc < b.endUtc && b.startUtc < a.endUtc;

/* ---------------- fees ---------------- */
const FEE_CODES = { in_person: 'CONS-GP', video: 'VIDEO-GP' };
async function feeFor(sched, orgId, type) {
  const own = type === 'video' ? sched.videoFeeKobo : sched.feeKobo;
  if (own != null) return own;
  const svc = await require('../orgs').service(orgId, FEE_CODES[type]);
  return svc ? svc.priceKobo : null;
}

/* ---------------- views ---------------- */
async function orgName(orgId, cache) {
  if (cache && cache[orgId] !== undefined) return cache[orgId];
  const o = await db.col('orgs').findOne({ id: orgId }, { projection: { name: 1 } });
  const n = o ? o.name : null; if (cache) cache[orgId] = n; return n;
}
async function patientBrief(patientId, orgId) {
  const p = await db.col('patients').findOne({ id: patientId });
  const l = orgId ? await db.col('patient_links').findOne({ orgId, patientId }) : null;
  if (!p) return { id: patientId, name: 'Patient', mrn: l ? l.mrn : null };
  const P = require('../patients');
  return { id: p.id, name: p.firstName + ' ' + p.lastName, mrn: l ? l.mrn : null, age: P.age(p.dob), sex: p.sex || null, phone: p.phone || null };
}

const VIDEO_EARLY_MS = 15 * 60000, VIDEO_LATE_MS = 60 * 60000;
function videoWindow(a, org) { const e = tun.earlyMs(org), l = tun.lateMs(org); const n = Date.now(); return { opensAt: a.startUtc - e, closesAt: a.startUtc + l, open: n >= a.startUtc - e && n <= a.startUtc + l }; }
function apptBase(a, org) {
  return {
    id: a.id, orgId: a.orgId, doctorMembershipId: a.doctorMembershipId, doctorName: a.doctorName, specialty: a.specialty || null,
    date: a.date, time: a.time, startUtc: a.startUtc, endUtc: a.endUtc, durationMin: a.durationMin, type: a.type, reason: a.reason || null,
    status: a.status, feeKobo: a.feeKobo, billId: a.billId || null, paid: !!a.paid, refundDue: !!a.refundDue,
    videoWindow: a.type === 'video' ? videoWindow(a, org) : null,
    encounterId: a.encounterId || null, createdAt: a.createdAt, cancelledAt: a.cancelledAt || null, cancelledBy: a.cancelledBy || null, cancelReason: a.cancelReason || null,
  };
}
const PATIENT_CANCEL_MIN_MS = 2 * 3600e3;
async function apptForPatient(a, cache) {
  const org = await orgDoc(a.orgId, cache);
  const v = apptBase(a, org);
  v.orgName = org ? org.name : null;
  v.canCancel = a.status === 'booked' && a.startUtc - Date.now() > tun.cancelMs(org);
  v.canJoinVideo = a.type === 'video' && ACTIVE_APPT.includes(a.status) && (!!a.paid || !tun.payBeforeVideo(org)) && v.videoWindow.open && tun.video(org);
  return v;
}
async function apptForStaff(a, cache) {
  const v = apptBase(a, await orgDoc(a.orgId, cache));
  v.patient = await patientBrief(a.patientId, a.orgId);
  v.patientId = a.patientId;
  Object.assign(v, { bookedBy: a.bookedBy, checkedInAt: a.checkedInAt || null, startedAt: a.startedAt || null, completedAt: a.completedAt || null, noShowAt: a.noShowAt || null, queueId: a.queueId || null });
  return v;
}

function httpError(status, msg, code, details) { return new HttpError(status, msg, code, details); }

/* plain text only: drop control characters (keep newlines and tabs) and anything that looks like an HTML tag */
function plainText(s) {
  return String(s || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/<\/?[a-z!][^>]*>/gi, '').trim();
}

module.exports = {
  APPT_TRANSITIONS, QUEUE_TRANSITIONS, ENCOUNTER_TRANSITIONS, CARE_TRANSITIONS, THREAD_TRANSITIONS, ACTIVE_APPT, ACTIVE_QUEUE,
  move, stateConflict, isDoctor, userName, doctorAt, dowOf, minutes, hhmm, dayRangeUtc, scheduleSlots, overlaps, FEE_CODES, feeFor,
  tun, orgDoc, videoWindow, orgName, patientBrief, apptBase, apptForPatient, apptForStaff, PATIENT_CANCEL_MIN_MS, VIDEO_EARLY_MS, VIDEO_LATE_MS, httpError, plainText, utcToLagos,
};
