'use strict';
/*
 * HMO (payer) module.
 *
 * Two sides:
 *  - Provider side (module 'hmo', every provider): check a linked patient's cover, request
 *    pre-authorisation, apply cover to an open bill, submit claims from paid bills, answer queries.
 *  - Payer side (module 'payer', HMO orgs): verify and manage member cover, decide
 *    pre-authorisations, review, approve and pay claims, dashboards.
 *
 * Patients add their cover in the patient app; HMOs can also bulk-enrol by phone, which the
 * patient confirms. Payer staff only ever see records carrying their own payerOrgId.
 *
 * Money safety:
 *  - coverage.usedKobo per category only grows through one conditional $inc whose filter
 *    re-checks that the new total stays within the limit, so parallel bills never exceed it.
 *  - one cover application per bill (unique index), one claim per bill (unique index),
 *    one bill per approved pre-authorisation.
 *  - every status change is a conditional findOneAndUpdate on the expected FROM state.
 */
const express = require('express');
const db = require('../db');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param, validate } = require('../lib/http');
const A = require('../lib/auth');
const { id, now, naira, todayLagos, digits } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const P = require('./patients');
const orgs = require('./orgs');

db.index('coverages', ['payerOrgId', 'memberNo'], { unique: true });
db.index('coverages', ['patientId', 'status']);
db.index('coverages', ['phone', 'status']);
db.index('preauths', ['payerOrgId', 'status', 'createdAt']);
db.index('preauths', ['providerOrgId', 'createdAt']);
db.index('cover_applications', ['billId'], { unique: true });
db.index('claims', ['billId'], { unique: true });
db.index('claims', ['payerOrgId', 'status', 'submittedAt']);
db.index('claims', ['providerOrgId', 'status', 'submittedAt']);
db.index('claims', ['payerOrgId', 'patientId', 'submittedAt']);
db.index('payer_settings', ['id'], { unique: true });

const router = express.Router();

const CATS = ['consultation', 'drug', 'lab', 'ambulance', 'delivery', 'procedure', 'other'];
const CAT_MAP = { video: 'consultation', registration: 'other' };
const catOf = c => CAT_MAP[c] || (CATS.includes(c) ? c : 'other');
const DEFAULT_THRESHOLD = naira(50000);
const PREAUTH_VALID_DAYS = 30;
const MAX_LIMIT = naira(100000000);

const COVERAGE_TRANSITIONS = { pending: ['active', 'rejected', 'declined'], active: ['suspended', 'ended'], suspended: ['active', 'ended'], rejected: [], declined: [], ended: [] };
const PREAUTH_TRANSITIONS = { pending: ['approved', 'denied', 'queried'], queried: ['pending'], approved: [], denied: [] };
const CLAIM_TRANSITIONS = { submitted: ['under_review'], under_review: ['approved', 'denied', 'queried'], queried: ['resubmitted'], resubmitted: ['under_review'], approved: ['paid'], denied: [], paid: [] };
const CLAIM_OPEN = ['submitted', 'under_review', 'queried', 'resubmitted'];

/* evidence that the billed service really happened: source collection + accepted statuses */
const EVIDENCE = {
  appointment: ['appointments', ['completed']],
  encounter: ['encounters', ['completed', 'closed', 'signed']],
  rx_order: ['rx_orders', ['collected', 'delivered']],
  lab_order: ['lab_orders', ['released']],
  incident: ['incidents', ['closed']],
};

/* ---------------- helpers ---------------- */
const limitsRule = (o) => t.obj(Object.fromEntries(CATS.map(c => [c, t.money({ max: MAX_LIMIT })])), o);
const zeroUsed = (used) => Object.fromEntries(CATS.map(c => [c, Number((used || {})[c]) || 0]));
const fullLimits = (l) => Object.fromEntries(CATS.map(c => [c, Number((l || {})[c]) || 0]));
function remainingOf(cov) {
  const out = {}; for (const c of CATS) out[c] = Math.max(0, ((cov.limits || {})[c] || 0) - ((cov.usedKobo || {})[c] || 0)); return out;
}
const isActive = c => !!c && c.status === 'active' && (!c.validTo || c.validTo >= todayLagos());
/** HMO's own setting (payer desk) > per-provider override set in HQ > platform setting > code default */
async function payerSettings(payerOrgId) {
  const S = require('../lib/settings');
  const org = await orgs.getOrg(payerOrgId);
  const s = await db.col('payer_settings').findOne({ id: payerOrgId });
  const platformThreshold = Number(S.get('process.hmo.preauthThresholdKobo', DEFAULT_THRESHOLD, org));
  return { preauthThresholdKobo: s && Number.isInteger(s.preauthThresholdKobo) ? s.preauthThresholdKobo : (Number.isFinite(platformThreshold) ? platformThreshold : DEFAULT_THRESHOLD), thresholdSource: s && Number.isInteger(s.preauthThresholdKobo) ? 'hmo' : 'platform',
    preauthValidDays: (s && s.preauthValidDays) || PREAUTH_VALID_DAYS,
    duplicateWindowHours: Number(S.get('process.hmo.duplicateWindowHours', 24, org)) || 24, frequencyLimitPer30Days: Number(S.get('process.hmo.frequencyLimitPer30Days', 3, org)) || 3 };
}
const claimsOn = (req, res, next) => (require('../lib/settings').feature('hmoClaims', req.ctx.org) ? next() : next(forbidden('HMO claims are switched off on MediCore')));
const orgNameCache = async (ids) => {
  const out = {}; const list = [...new Set(ids.filter(Boolean))];
  if (list.length) (await db.col('orgs').find({ id: { $in: list } }, { projection: { name: 1 } })).forEach(o => { out[o.id] = o.name; });
  return out;
};
const patientNames = async (ids) => {
  const out = {}; const list = [...new Set(ids.filter(Boolean))];
  if (list.length) (await db.col('patients').find({ id: { $in: list } }, { projection: { firstName: 1, lastName: 1 } })).forEach(p => { out[p.id] = p.firstName + ' ' + p.lastName; });
  return out;
};
const hours = ms => Math.round(ms / 360000) / 10;

/* ---------------- guards ---------------- */
const payer = perm => [A.requireStaff({ perm, module: 'payer' }), (req, res, next) => (req.ctx.org.type === 'hmo' ? next() : next(forbidden('Only HMOs use the payer desk')))];
const payerAny = perms => [A.requireStaff({ anyPerm: perms, module: 'payer' }), (req, res, next) => (req.ctx.org.type === 'hmo' ? next() : next(forbidden('Only HMOs use the payer desk')))];
const prov = perm => A.requireStaff({ perm, module: 'hmo' });

/* ---------------- views ---------------- */
function patientCoverView(c, payerName) {
  return { id: c.id, payerOrgId: c.payerOrgId, payerName: payerName || null, memberNo: c.memberNo, planName: c.planName || null, status: c.status,
    patientConfirmed: !!c.patientConfirmed, payerVerified: !!c.payerVerified, enrolledBy: c.enrolledBy, limits: c.limits || null, usedKobo: c.usedKobo || null,
    remainingKobo: c.limits ? remainingOf(c) : null, validTo: c.validTo || null, statusReason: c.statusReason || null, createdAt: c.createdAt, planId: c.planId || null, principalCoverageId: c.principalCoverageId || null, relation: c.relation || 'self', primaryOrgId: c.primaryOrgId || null };
}
async function payerCoverView(c) {
  let member;
  if (c.patientId && c.patientConfirmed) {
    const p = await db.col('patients').findOne({ id: c.patientId }, { projection: { firstName: 1, lastName: 1, dob: 1, sex: 1, phone: 1 } });
    member = p ? { name: p.firstName + ' ' + p.lastName, dob: p.dob || null, sex: p.sex || null, phone: p.phone || null } : { name: 'Removed', dob: null, sex: null, phone: null };
  } else member = { name: c.enrolName || null, dob: null, sex: null, phone: c.phone || null };
  return Object.assign(patientCoverView(c), { patientId: c.patientConfirmed ? c.patientId : null, member, history: c.history || [], updatedAt: c.updatedAt || c.createdAt });
}
function preauthView(p, names = {}) {
  const decidedOrNow = p.decidedAt || now();
  return { id: p.id, number: p.number, providerOrgId: p.providerOrgId, providerName: names[p.providerOrgId] || null, payerOrgId: p.payerOrgId, payerName: names[p.payerOrgId] || null,
    patientId: p.patientId, patientName: names[p.patientId] || null, coverageId: p.coverageId, memberNo: p.memberNo, services: p.services, requestedKobo: p.requestedKobo,
    diagnosis: p.diagnosis, note: p.note || null, status: p.status, approvedKobo: p.approvedKobo || null, authCode: p.authCode || null, denyReason: p.denyReason || null,
    question: p.question || null, answer: p.answer || null, validUntil: p.validUntil || null, usedBillId: p.usedBillId || null, createdAt: p.createdAt, decidedAt: p.decidedAt || null,
    ageMinutes: Math.round((now() - p.createdAt) / 60000), turnaroundMinutes: p.decidedAt ? Math.round((p.decidedAt - p.createdAt) / 60000) : null, waitingMinutes: p.decidedAt ? null : Math.round((decidedOrNow - (p.lastSubmittedAt || p.createdAt)) / 60000), history: p.history || [] };
}
function claimView(c, names = {}) {
  return { id: c.id, number: c.number, providerOrgId: c.providerOrgId, providerName: names[c.providerOrgId] || null, payerOrgId: c.payerOrgId, payerName: names[c.payerOrgId] || null,
    patientId: c.patientId, patientName: names[c.patientId] || null, memberNo: c.memberNo, coverageId: c.coverageId, billId: c.billId, billNumber: c.billNumber, serviceDate: c.serviceDate,
    lines: c.lines, billTotalKobo: c.billTotalKobo, claimedKobo: c.claimedKobo, approvedKobo: c.approvedKobo == null ? null : c.approvedKobo, paidKobo: c.paidKobo == null ? null : c.paidKobo,
    paymentRef: c.paymentRef || null, diagnosis: c.diagnosis || null, preauthId: c.preauthId || null, preauthCode: c.preauthCode || null, flags: c.flags || [], flagged: !!(c.flags && c.flags.length),
    status: c.status, denyReason: c.denyReason || null, question: c.question || null, answer: c.answer || null, decisionNote: c.decisionNote || null,
    submittedAt: c.submittedAt, decidedAt: c.decidedAt || null, paidAt: c.paidAt || null,
    ageHours: hours(now() - c.submittedAt), turnaroundHours: c.decidedAt ? hours(c.decidedAt - c.submittedAt) : null, history: c.history || [] };
}
async function namesFor(rows) {
  const o = await orgNameCache(rows.flatMap(r => [r.providerOrgId, r.payerOrgId]));
  const p = await patientNames(rows.map(r => r.patientId));
  return Object.assign(o, p);
}
const hist = (req, from, to, extra) => Object.assign({ at: now(), from, to, by: req && req.ctx && req.ctx.user ? req.ctx.user.id : 'system', orgId: req && req.ctx && req.ctx.org ? req.ctx.org.id : null }, extra || {});

/* ================= patient app ================= */
router.get('/me/coverages', A.requirePatient, ah(async (req, res) => {
  const p = req.ctx.patient;
  const or = [{ patientId: p.id }]; if (p.phone) or.push({ patientId: null, phone: p.phone });
  const rows = await db.col('coverages').find({ $or: or }, { sort: { createdAt: -1 } });
  const names = await orgNameCache(rows.map(r => r.payerOrgId));
  res.json(rows.map(c => patientCoverView(c, names[c.payerOrgId])));
}));

router.post('/me/coverages', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { payerOrgId: t.id({ required: true }), memberNo: t.str({ required: true, max: 40, upper: true, pattern: /^[A-Za-z0-9\-/.]+$/, label: 'Member number' }), planName: t.str({ max: 80 }) });
  const hmo = await db.col('orgs').findOne({ id: b.payerOrgId, type: 'hmo', status: 'active' });
  if (!hmo) throw notFound('HMO not found');
  const pid = req.ctx.patient.id;
  const mine = await db.col('coverages').findOne({ patientId: pid, payerOrgId: hmo.id, status: { $in: ['pending', 'active', 'suspended'] } });
  if (mine) throw conflict('You already have cover with this HMO on MediCore');
  const c = { id: id('cov'), patientId: pid, phone: req.ctx.patient.phone || null, payerOrgId: hmo.id, memberNo: b.memberNo, planName: b.planName || null, status: 'pending', patientConfirmed: true, payerVerified: false,
    enrolledBy: 'patient', limits: null, usedKobo: zeroUsed(), validTo: null, createdAt: now(), history: [{ at: now(), from: null, to: 'pending', by: req.ctx.user.id }] };
  try { await db.col('coverages').insertOne(c); } catch (e) { if (e.code === 11000) throw conflict('That member number is already registered on MediCore. Contact your HMO.'); throw e; }
  await audit(req, 'hmo.cover_add', { type: 'coverage', id: c.id, patientId: pid, orgId: hmo.id });
  await notify({ orgId: hmo.id, role: 'payer_officer', title: 'New member cover to verify', body: 'Member ' + c.memberNo + ' added their cover in the MediCore app.', kind: 'hmo_cover', ref: { type: 'coverage', id: c.id } });
  res.json(patientCoverView(c, hmo.name));
}));

async function patientDecide(req, to) {
  const p = req.ctx.patient;
  const or = [{ patientId: p.id }]; if (p.phone) or.push({ patientId: null, phone: p.phone });
  const cur = await db.col('coverages').findOne({ id: param(req, 'id'), $or: or });
  if (!cur) throw notFound('Cover not found');
  const next = to === 'confirm' ? (cur.payerVerified ? 'active' : 'pending') : 'declined';
  const set = { patientId: p.id, patientConfirmed: to === 'confirm', status: next, updatedAt: now() };
  const c = await db.col('coverages').findOneAndUpdate({ id: cur.id, status: 'pending', patientConfirmed: false, $or: or }, { $set: set, $push: { history: { at: now(), from: 'pending', to: next, by: req.ctx.user.id, action: to } } });
  if (!c) throw conflict('This cover is not waiting for your confirmation');
  await audit(req, to === 'confirm' ? 'hmo.cover_confirm' : 'hmo.cover_decline', { type: 'coverage', id: c.id, patientId: p.id, orgId: c.payerOrgId });
  const o = await orgs.getOrg(c.payerOrgId);
  return patientCoverView(c, o && o.name);
}
router.post('/me/coverages/:id/confirm', A.requirePatient, ah(async (req, res) => { res.json(await patientDecide(req, 'confirm')); }));
router.post('/me/coverages/:id/decline', A.requirePatient, ah(async (req, res) => { res.json(await patientDecide(req, 'decline')); }));

/* ================= payer: members and cover ================= */
router.get('/payer/coverages', ...payerAny(['payer.members', 'payer.preauth', 'payer.claims']), ah(async (req, res) => {
  const q = query(req, { status: t.enum(Object.keys(COVERAGE_TRANSITIONS)), q: t.str({ max: 60 }), limit: t.int({ min: 1, max: 500 }) });
  const f = { payerOrgId: req.ctx.org.id }; if (q.status) f.status = q.status;
  let rows = await db.col('coverages').find(f, { sort: { createdAt: -1 }, limit: q.q ? 5000 : (q.limit || 200) });
  const out = []; for (const c of rows) out.push(await payerCoverView(c));
  let list = out;
  if (q.q) { const s = q.q.toLowerCase(); list = out.filter(c => c.memberNo.toLowerCase().includes(s) || (c.member.name || '').toLowerCase().includes(s) || (c.member.phone || '').includes(s)); }
  res.json(list.slice(0, q.limit || 200));
}));
router.get('/payer/coverages/:id', ...payerAny(['payer.members', 'payer.preauth', 'payer.claims']), ah(async (req, res) => {
  const c = await db.col('coverages').findOne({ id: param(req, 'id'), payerOrgId: req.ctx.org.id });
  if (!c) throw notFound('Cover not found');
  await audit(req, 'payer.cover_view', { type: 'coverage', id: c.id, patientId: c.patientConfirmed ? c.patientId : null });
  const v = await payerCoverView(c);
  v.claims = (await db.col('claims').find({ coverageId: c.id, payerOrgId: req.ctx.org.id }, { sort: { submittedAt: -1 }, limit: 50 })).map(x => ({ id: x.id, number: x.number, status: x.status, claimedKobo: x.claimedKobo, approvedKobo: x.approvedKobo || null, submittedAt: x.submittedAt }));
  res.json(v);
}));

async function coverTransition(req, from, to, set, action, meta, extraFilter) {
  const filter = Object.assign({ id: param(req, 'id'), payerOrgId: req.ctx.org.id, status: Array.isArray(from) ? { $in: from } : from }, extraFilter || {});
  const before = await db.col('coverages').findOne({ id: filter.id, payerOrgId: req.ctx.org.id });
  if (!before) throw notFound('Cover not found');
  const c = await db.col('coverages').findOneAndUpdate(filter, { $set: Object.assign({ status: to, updatedAt: now() }, set || {}), $push: { history: hist(req, before.status, to, meta ? { reason: meta.reason || null } : undefined) } });
  if (!c) throw conflict('This cover is ' + before.status + (before.status === 'pending' && !before.patientConfirmed ? ' and waiting for the member to confirm' : '') + '; that action is not possible now', 'wrong_state');
  await audit(req, 'payer.' + action, { type: 'coverage', id: c.id, patientId: c.patientConfirmed ? c.patientId : null }, meta && meta.audit);
  if (c.patientId && c.patientConfirmed) await notify({ patientId: c.patientId, title: 'HMO cover ' + (to === 'active' ? 'active' : to), body: req.ctx.org.name + ' updated your cover (' + c.memberNo + ').', kind: 'hmo_cover', ref: { type: 'coverage', id: c.id } });
  return payerCoverView(c);
}
router.post('/payer/coverages/:id/activate', ...payer('payer.members'), ah(async (req, res) => {
  const b = body(req, { limits: limitsRule({ required: true }), validTo: t.date({ required: true, label: 'Valid to' }), planName: t.str({ max: 80 }) });
  if (b.validTo < todayLagos()) throw bad('Valid-to date is in the past');
  const set = { limits: fullLimits(b.limits), validTo: b.validTo, payerVerified: true, verifiedBy: req.ctx.user.id, verifiedAt: now() };
  if (b.planName) set.planName = b.planName;
  const cur = await db.col('coverages').findOne({ id: param(req, 'id'), payerOrgId: req.ctx.org.id });
  if (cur) set.usedKobo = zeroUsed(cur.usedKobo);
  res.json(await coverTransition(req, 'pending', 'active', set, 'cover_activate', { audit: { validTo: b.validTo } }, { patientConfirmed: true }));
}));
router.post('/payer/coverages/:id/reject', ...payer('payer.members'), ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 3, max: 300 }) });
  res.json(await coverTransition(req, 'pending', 'rejected', { statusReason: b.reason }, 'cover_reject', { reason: b.reason }));
}));
router.post('/payer/coverages/:id/suspend', ...payer('payer.members'), ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 3, max: 300 }) });
  res.json(await coverTransition(req, 'active', 'suspended', { statusReason: b.reason }, 'cover_suspend', { reason: b.reason }));
}));
router.post('/payer/coverages/:id/reactivate', ...payer('payer.members'), ah(async (req, res) => {
  res.json(await coverTransition(req, 'suspended', 'active', { statusReason: null }, 'cover_reactivate'));
}));
router.post('/payer/coverages/:id/end', ...payer('payer.members'), ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 3, max: 300 }) });
  res.json(await coverTransition(req, ['active', 'suspended'], 'ended', { statusReason: b.reason, endedAt: now() }, 'cover_end', { reason: b.reason }));
}));
router.post('/payer/coverages/:id/limits', ...payer('payer.members'), ah(async (req, res) => {
  const b = body(req, { limits: limitsRule({ required: true }), validTo: t.date(), planName: t.str({ max: 80 }) });
  const cur = await db.col('coverages').findOne({ id: param(req, 'id'), payerOrgId: req.ctx.org.id });
  if (!cur) throw notFound('Cover not found');
  const set = { updatedAt: now() };
  // only the categories sent are changed; each is a separate field so a parallel $inc on usedKobo is not lost
  Object.entries(b.limits).forEach(([k, v]) => { set['limits.' + k] = v; });
  if (b.validTo) set.validTo = b.validTo; if (b.planName) set.planName = b.planName;
  const c = await db.col('coverages').findOneAndUpdate({ id: cur.id, payerOrgId: req.ctx.org.id, status: { $in: ['active', 'suspended'] } }, { $set: set, $push: { history: hist(req, cur.status, cur.status, { action: 'limits' }) } });
  if (!c) throw conflict('Limits can only be changed on active or suspended cover', 'wrong_state');
  await audit(req, 'payer.cover_limits', { type: 'coverage', id: c.id, patientId: c.patientConfirmed ? c.patientId : null }, { limits: b.limits, validTo: b.validTo || null });
  res.json(await payerCoverView(c));
}));

/* bulk enrolment by phone: creates pending cover the member confirms in the patient app.
   The response never says whether a phone already belongs to a MediCore patient. */
router.post('/payer/coverages/enrol', ...payer('payer.members'), ah(async (req, res) => {
  const b = body(req, { members: t.arr(t.any({ maxBytes: 2000 }), { required: true, min: 1, max: 200 }) });
  const rule = { phone: t.phone({ required: true }), memberNo: t.str({ required: true, max: 40, upper: true, pattern: /^[A-Za-z0-9\-/.]+$/, label: 'Member number' }), name: t.str({ max: 100 }), planName: t.str({ max: 80 }), limits: limitsRule({ required: true }), validTo: t.date({ required: true }) };
  const results = [];
  for (let i = 0; i < b.members.length; i++) {
    let m;
    try { m = validate(b.members[i], rule); } catch (e) { results.push({ index: i, ok: false, error: e.message }); continue; }
    if (m.validTo < todayLagos()) { results.push({ index: i, memberNo: m.memberNo, ok: false, error: 'Valid-to date is in the past' }); continue; }
    const p = await db.col('patients').findOne({ phone: m.phone, status: { $ne: 'removed' } }, { projection: { id: 1 } });
    const c = { id: id('cov'), patientId: p ? p.id : null, phone: m.phone, enrolName: m.name || null, payerOrgId: req.ctx.org.id, memberNo: m.memberNo, planName: m.planName || null, status: 'pending', patientConfirmed: false, payerVerified: true,
      verifiedBy: req.ctx.user.id, verifiedAt: now(), enrolledBy: 'payer', limits: fullLimits(m.limits), usedKobo: zeroUsed(), validTo: m.validTo, createdAt: now(), history: [{ at: now(), from: null, to: 'pending', by: req.ctx.user.id, action: 'enrol' }] };
    try { await db.col('coverages').insertOne(c); } catch (e) { if (e.code === 11000) { results.push({ index: i, memberNo: m.memberNo, ok: false, error: 'Member number already enrolled' }); continue; } throw e; }
    if (p) await notify({ patientId: p.id, title: 'Confirm your HMO cover', body: req.ctx.org.name + ' has enrolled you. Open MediCore to confirm.', kind: 'hmo_cover', ref: { type: 'coverage', id: c.id } });
    results.push({ index: i, memberNo: m.memberNo, ok: true, coverageId: c.id, status: 'pending' });
  }
  await audit(req, 'payer.cover_enrol', { type: 'coverage', id: null }, { rows: b.members.length, enrolled: results.filter(r => r.ok).length });
  res.json({ enrolled: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
}));

router.get('/payer/settings', ...payerAny(['payer.members', 'payer.preauth', 'payer.claims', 'admin.settings']), ah(async (req, res) => { res.json(await payerSettings(req.ctx.org.id)); }));
router.patch('/payer/settings', A.requireStaff({ perm: 'admin.settings', module: 'payer' }), ah(async (req, res) => {
  if (req.ctx.org.type !== 'hmo') throw forbidden();
  const b = body(req, { preauthThresholdKobo: t.money({ max: naira(100000000) }), preauthValidDays: t.int({ min: 1, max: 365 }) });
  if (!Object.keys(b).length) throw bad('Nothing to change');
  await db.col('payer_settings').findOneAndUpdate({ id: req.ctx.org.id }, { $set: Object.assign({ updatedAt: now() }, b), $setOnInsert: { id: req.ctx.org.id } }, { upsert: true });
  await audit(req, 'payer.settings', { type: 'org', id: req.ctx.org.id }, b);
  res.json(await payerSettings(req.ctx.org.id));
}));

/* ================= provider: cover check ================= */
router.get('/hmo/patients/:patientId/cover', prov('hmo.check'), ah(async (req, res) => {
  const { patient } = await P.requireLinked(req, param(req, 'patientId'));
  const rows = (await db.col('coverages').find({ patientId: patient.id, status: 'active', patientConfirmed: true })).filter(isActive);
  const names = await orgNameCache(rows.map(r => r.payerOrgId));
  const out = [];
  for (const c of rows) {
    const hmo = await orgs.getOrg(c.payerOrgId);
    if (!hmo || hmo.status !== 'active') continue;
    const s = await payerSettings(c.payerOrgId);
    out.push({ coverageId: c.id, payerOrgId: c.payerOrgId, payerName: names[c.payerOrgId], memberNo: c.memberNo, planName: c.planName, validTo: c.validTo, limits: c.limits, usedKobo: c.usedKobo, remainingKobo: remainingOf(c), preauthThresholdKobo: s.preauthThresholdKobo });
  }
  await audit(req, 'hmo.cover_check', { type: 'patient', id: patient.id, patientId: patient.id }, { active: out.length });
  res.json(out);
}));

/* ================= pre-authorisation ================= */
const serviceRule = t.obj({ code: t.str({ required: true, max: 24, upper: true }), name: t.str({ required: true, max: 120 }), category: t.enum(CATS, { required: true }), qty: t.int({ min: 1, max: 1000, default: 1 }), amountKobo: t.money({ required: true, min: 1, max: naira(50000000), label: 'Amount' }) });
router.post('/hmo/preauths', prov('hmo.check'), A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { patientId: t.id({ required: true }), payerOrgId: t.id({ required: true }), coverageId: t.id({ required: true }), services: t.arr(serviceRule, { required: true, min: 1, max: 30 }),
    diagnosis: t.obj({ code: t.str({ max: 12 }), text: t.str({ required: true, max: 200 }) }, { required: true }), note: t.text({ max: 1000 }) });
  const { patient } = await P.requireLinked(req, b.patientId);
  const cov = await db.col('coverages').findOne({ id: b.coverageId, patientId: patient.id, payerOrgId: b.payerOrgId, patientConfirmed: true });
  if (!cov) throw notFound('Cover not found');
  if (!isActive(cov)) throw conflict('This cover is not active', 'cover_inactive');
  // price-list prices override what the client sends; unknown codes keep the quoted estimate
  const services = [];
  for (const s of b.services) {
    const svc = await orgs.service(req.ctx.org.id, s.code);
    const unit = svc ? svc.priceKobo : s.amountKobo;
    services.push({ code: s.code, name: svc ? svc.name : s.name, category: svc ? catOf(svc.category) : s.category, qty: s.qty, unitKobo: unit, amountKobo: unit * s.qty, priced: svc ? 'price_list' : 'quoted' });
  }
  const pa = { id: id('pa'), number: 'PA' + String(await orgs.nextNumber('preauth_' + cov.payerOrgId)).padStart(6, '0'), providerOrgId: req.ctx.org.id, payerOrgId: cov.payerOrgId, patientId: patient.id, coverageId: cov.id, memberNo: cov.memberNo,
    services, requestedKobo: services.reduce((s, x) => s + x.amountKobo, 0), diagnosis: { code: b.diagnosis.code || null, text: b.diagnosis.text }, note: b.note || null, status: 'pending',
    requestedBy: req.ctx.user.id, createdAt: now(), lastSubmittedAt: now(), usedBillId: null, history: [{ at: now(), from: null, to: 'pending', by: req.ctx.user.id, orgId: req.ctx.org.id }] };
  await db.col('preauths').insertOne(pa);
  await audit(req, 'hmo.preauth_request', { type: 'preauth', id: pa.id, patientId: patient.id }, { payerOrgId: pa.payerOrgId, requestedKobo: pa.requestedKobo });
  await notify({ orgId: pa.payerOrgId, role: 'payer_officer', title: 'Pre-authorisation request ' + pa.number, body: req.ctx.org.name + ' requests approval for member ' + pa.memberNo + '.', kind: 'preauth', ref: { type: 'preauth', id: pa.id } });
  res.json(preauthView(pa, await namesFor([pa])));
}));
router.get('/hmo/preauths', prov('hmo.check'), ah(async (req, res) => {
  const q = query(req, { status: t.enum(Object.keys(PREAUTH_TRANSITIONS)), patientId: t.id(), limit: t.int({ min: 1, max: 500 }) });
  const f = { providerOrgId: req.ctx.org.id }; if (q.status) f.status = q.status; if (q.patientId) f.patientId = q.patientId;
  const rows = await db.col('preauths').find(f, { sort: { createdAt: -1 }, limit: q.limit || 100 });
  const n = await namesFor(rows); res.json(rows.map(r => preauthView(r, n)));
}));
router.get('/hmo/preauths/:id', prov('hmo.check'), ah(async (req, res) => {
  const p = await db.col('preauths').findOne({ id: param(req, 'id'), providerOrgId: req.ctx.org.id });
  if (!p) throw notFound('Pre-authorisation not found');
  res.json(preauthView(p, await namesFor([p])));
}));
router.post('/hmo/preauths/:id/answer', prov('hmo.check'), A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { answer: t.text({ required: true, max: 1000 }) });
  const p = await db.col('preauths').findOneAndUpdate({ id: param(req, 'id'), providerOrgId: req.ctx.org.id, status: 'queried' }, { $set: { status: 'pending', answer: b.answer, lastSubmittedAt: now() }, $push: { history: hist(req, 'queried', 'pending', { action: 'answer' }) } });
  if (!p) { const ex = await db.col('preauths').findOne({ id: param(req, 'id'), providerOrgId: req.ctx.org.id }); if (!ex) throw notFound('Pre-authorisation not found'); throw conflict('This request is ' + ex.status + ', not waiting for an answer', 'wrong_state'); }
  await audit(req, 'hmo.preauth_answer', { type: 'preauth', id: p.id, patientId: p.patientId });
  await notify({ orgId: p.payerOrgId, role: 'payer_officer', title: 'Query answered: ' + p.number, body: 'The provider answered your question.', kind: 'preauth', ref: { type: 'preauth', id: p.id } });
  res.json(preauthView(p, await namesFor([p])));
}));

router.get('/payer/preauths', ...payerAny(['payer.preauth', 'payer.claims']), ah(async (req, res) => {
  const q = query(req, { status: t.enum(Object.keys(PREAUTH_TRANSITIONS)), limit: t.int({ min: 1, max: 500 }) });
  const f = { payerOrgId: req.ctx.org.id }; if (q.status) f.status = q.status;
  const rows = await db.col('preauths').find(f, { sort: { createdAt: q.status === 'pending' ? 1 : -1 }, limit: q.limit || 100 });
  const n = await namesFor(rows); res.json(rows.map(r => preauthView(r, n)));
}));
router.get('/payer/preauths/:id', ...payerAny(['payer.preauth', 'payer.claims']), ah(async (req, res) => {
  const p = await db.col('preauths').findOne({ id: param(req, 'id'), payerOrgId: req.ctx.org.id });
  if (!p) throw notFound('Pre-authorisation not found');
  await audit(req, 'payer.preauth_view', { type: 'preauth', id: p.id, patientId: p.patientId });
  const v = preauthView(p, await namesFor([p]));
  const cov = await db.col('coverages').findOne({ id: p.coverageId, payerOrgId: req.ctx.org.id });
  v.cover = cov ? { status: cov.status, validTo: cov.validTo, limits: cov.limits, usedKobo: cov.usedKobo, remainingKobo: remainingOf(cov) } : null;
  res.json(v);
}));
async function preauthDecide(req, to, set, action, meta) {
  const pid = param(req, 'id');
  const stamp = to === 'queried' ? { queriedAt: now(), queriedBy: req.ctx.user.id } : { decidedAt: now(), decidedBy: req.ctx.user.id };
  const p = await db.col('preauths').findOneAndUpdate({ id: pid, payerOrgId: req.ctx.org.id, status: 'pending' }, { $set: Object.assign({ status: to }, stamp, set), $push: { history: hist(req, 'pending', to) } });
  if (!p) { const ex = await db.col('preauths').findOne({ id: pid, payerOrgId: req.ctx.org.id }); if (!ex) throw notFound('Pre-authorisation not found'); throw conflict('This request is already ' + ex.status, 'wrong_state'); }
  await audit(req, 'payer.' + action, { type: 'preauth', id: p.id, patientId: p.patientId }, meta);
  await notify({ orgId: p.providerOrgId, role: 'cashier', title: 'Pre-authorisation ' + p.number + ' ' + to, body: req.ctx.org.name + ' has ' + (to === 'queried' ? 'a question' : to + ' the request') + '.', kind: 'preauth', ref: { type: 'preauth', id: p.id } });
  return preauthView(p, await namesFor([p]));
}
router.post('/payer/preauths/:id/approve', ...payer('payer.preauth'), ah(async (req, res) => {
  const b = body(req, { approvedKobo: t.money({ required: true, min: 1, max: naira(50000000) }), authCode: t.str({ max: 30, upper: true, pattern: /^[A-Za-z0-9\-/]+$/ }), note: t.str({ max: 500 }) });
  const cur = await db.col('preauths').findOne({ id: param(req, 'id'), payerOrgId: req.ctx.org.id });
  if (!cur) throw notFound('Pre-authorisation not found');
  if (b.approvedKobo > cur.requestedKobo) throw bad('Approved amount cannot be more than the amount requested');
  const s = await payerSettings(req.ctx.org.id);
  const code = b.authCode || ('AUTH-' + req.ctx.org.code.slice(0, 4) + '-' + digits(6));
  res.json(await preauthDecide(req, 'approved', { approvedKobo: b.approvedKobo, authCode: code, decisionNote: b.note || null, validUntil: now() + s.preauthValidDays * 86400e3 }, 'preauth_approve', { approvedKobo: b.approvedKobo }));
}));
router.post('/payer/preauths/:id/deny', ...payer('payer.preauth'), ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 3, max: 500 }) });
  res.json(await preauthDecide(req, 'denied', { denyReason: b.reason }, 'preauth_deny'));
}));
router.post('/payer/preauths/:id/query', ...payer('payer.preauth'), ah(async (req, res) => {
  const b = body(req, { question: t.str({ required: true, min: 3, max: 500 }) });
  res.json(await preauthDecide(req, 'queried', { question: b.question, answer: null }, 'preauth_query'));
}));

/* ================= apply cover to a bill ================= */
/**
 * applyCover({ orgId, billId, coverageId, preauthId, userId })
 * Computes the covered amount from remaining limits per category (capped by an approved
 * pre-authorisation), reserves it on the coverage atomically, then calls billing.setHmoCover.
 */
async function applyCover({ orgId, billId, coverageId, preauthId, userId }) {
  const billing = require('./billing');
  const bill = await db.col('bills').findOne({ id: billId, orgId });
  if (!bill) throw notFound('Bill not found');
  if (bill.status !== 'open' || bill.paidKobo > 0 || bill.hmo) throw conflict('HMO cover can only be added once, to an unpaid open bill', 'bill_not_open');
  const cov = await db.col('coverages').findOne({ id: coverageId, patientId: bill.patientId, patientConfirmed: true });
  if (!cov) throw notFound('Cover not found');
  if (!isActive(cov)) throw conflict('This cover is not active', 'cover_inactive');
  const hmo = await orgs.getOrg(cov.payerOrgId);
  if (!hmo || hmo.status !== 'active') throw conflict('This HMO is not active on MediCore', 'payer_inactive');
  const settings = await payerSettings(cov.payerOrgId);
  let pa = null;
  if (preauthId) {
    pa = await db.col('preauths').findOne({ id: preauthId, providerOrgId: orgId, patientId: bill.patientId, coverageId: cov.id });
    if (!pa) throw notFound('Pre-authorisation not found');
    if (pa.status !== 'approved') throw conflict('This pre-authorisation is ' + pa.status, 'preauth_not_approved');
    if (pa.usedBillId) throw conflict('This pre-authorisation has already been used on another bill', 'preauth_used');
    if (pa.validUntil && pa.validUntil < now()) throw conflict('This pre-authorisation has expired', 'preauth_expired');
  }
  const need = {};
  bill.lines.forEach(l => { const c = catOf(l.category); need[c] = (need[c] || 0) + l.totalKobo; });

  const lock = { id: id('ca'), billId, orgId, coverageId: cov.id, payerOrgId: cov.payerOrgId, status: 'applying', at: now(), by: userId || null };
  try { await db.col('cover_applications').insertOne(lock); } catch (e) { if (e.code === 11000) throw conflict('HMO cover has already been applied to this bill', 'already_covered'); throw e; }
  let reserved = null; let paUsed = false;
  try {
    if (pa) {
      const u = await db.col('preauths').findOneAndUpdate({ id: pa.id, status: 'approved', usedBillId: null }, { $set: { usedBillId: billId, usedAt: now() } });
      if (!u) throw conflict('This pre-authorisation has already been used on another bill', 'preauth_used');
      paUsed = true;
    }
    let alloc = null, total = 0;
    for (let attempt = 0; attempt < 8 && !reserved; attempt++) {
      const c = await db.col('coverages').findOne({ id: cov.id });
      if (!isActive(c)) throw conflict('This cover is not active', 'cover_inactive');
      alloc = {}; total = 0;
      const rem = remainingOf(c);
      for (const cat of CATS) { if (!need[cat]) continue; const a = Math.min(rem[cat], need[cat]); if (a > 0) { alloc[cat] = a; total += a; } }
      if (pa && total > pa.approvedKobo) {
        let over = total - pa.approvedKobo;
        for (const cat of CATS.slice().reverse()) { if (!alloc[cat] || over <= 0) continue; const cut = Math.min(alloc[cat], over); alloc[cat] -= cut; over -= cut; if (!alloc[cat]) delete alloc[cat]; }
        total = pa.approvedKobo;
      }
      if (total === 0) throw conflict('Nothing on this bill is covered: the limits are used up or these services are not covered', 'not_covered');
      if (!pa && total > settings.preauthThresholdKobo) throw conflict('This HMO needs pre-authorisation for amounts above ' + (settings.preauthThresholdKobo / 100) + ' naira', 'preauth_required');
      const filter = { id: c.id, status: 'active' }; const inc = {};
      for (const [cat, a] of Object.entries(alloc)) { filter['usedKobo.' + cat] = { $lte: ((c.limits || {})[cat] || 0) - a }; inc['usedKobo.' + cat] = a; }
      const upd = await db.col('coverages').findOneAndUpdate(filter, { $inc: inc });
      if (upd) reserved = { alloc, total };
    }
    if (!reserved) throw conflict('The cover changed while applying. Please try again.', 'retry');
    let b2;
    try { b2 = await billing.setHmoCover(billId, { coverageId: cov.id, payerOrgId: cov.payerOrgId, coveredKobo: reserved.total, preauthId: pa ? pa.id : null }); }
    catch (e) {
      const dec = {}; Object.entries(reserved.alloc).forEach(([cat, a]) => { dec['usedKobo.' + cat] = -a; });
      await db.col('coverages').updateOne({ id: cov.id }, { $inc: dec });
      reserved = null; throw e;
    }
    await db.col('cover_applications').updateOne({ id: lock.id }, { $set: { status: 'applied', coveredKobo: reserved.total, byCategory: reserved.alloc, preauthId: pa ? pa.id : null } });
    return { bill: b2, coveredKobo: reserved.total, byCategory: reserved.alloc, patientDueKobo: b2.patientDueKobo, coverage: { id: cov.id, memberNo: cov.memberNo, payerOrgId: cov.payerOrgId } };
  } catch (e) {
    await db.col('cover_applications').deleteOne({ id: lock.id });
    if (paUsed) await db.col('preauths').updateOne({ id: pa.id, usedBillId: billId }, { $set: { usedBillId: null, usedAt: null } });
    throw e;
  }
}

router.post('/hmo/bills/:billId/apply-cover', prov('hmo.check'), A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { coverageId: t.id({ required: true }), preauthId: t.id() });
  const billId = param(req, 'billId');
  const bill = await db.col('bills').findOne({ id: billId, orgId: req.ctx.org.id });
  if (!bill) throw notFound('Bill not found');
  await P.requireLinked(req, bill.patientId);
  const r = await applyCover({ orgId: req.ctx.org.id, billId, coverageId: b.coverageId, preauthId: b.preauthId, userId: req.ctx.user.id });
  await audit(req, 'hmo.cover_apply', { type: 'bill', id: billId, patientId: bill.patientId }, { coverageId: b.coverageId, coveredKobo: r.coveredKobo, preauthId: b.preauthId || null });
  res.json(r);
}));

/* ================= claims ================= */
async function evidenceFor(bill) {
  const src = bill.source || {};
  const ev = EVIDENCE[src.type];
  if (!ev || !src.id) return { ok: false, doc: null };
  const doc = await db.col(ev[0]).findOne({ id: src.id, patientId: bill.patientId });
  return { ok: !!(doc && ev[1].includes(doc.status)), doc };
}
async function diagnosisFor(bill, srcDoc) {
  const pick = e => {
    if (!e) return null;
    const d = e.diagnosis || (Array.isArray(e.diagnoses) && (e.diagnoses.find(x => x.primary) || e.diagnoses[0])) || (e.assessment && e.assessment.diagnosis) || null;
    if (!d) return null;
    if (typeof d === 'string') return { code: null, text: d.slice(0, 200) };
    return { code: d.code || d.icd10 || null, text: String(d.text || d.name || d.label || '').slice(0, 200) || null };
  };
  const src = bill.source || {};
  let enc = null;
  if (src.type === 'encounter') enc = srcDoc;
  else if (src.type === 'appointment' && src.id) enc = await db.col('encounters').findOne({ appointmentId: src.id, patientId: bill.patientId });
  if (!enc && srcDoc && srcDoc.encounterId) enc = await db.col('encounters').findOne({ id: srcDoc.encounterId, patientId: bill.patientId });
  if (!enc && srcDoc && srcDoc.prescriptionId) { const rx = await db.col('prescriptions').findOne({ id: srcDoc.prescriptionId, patientId: bill.patientId }); if (rx && rx.encounterId) enc = await db.col('encounters').findOne({ id: rx.encounterId, patientId: bill.patientId }); }
  return pick(enc);
}
async function flagsFor(bill, cov, claimedKobo, preauthId, settings) {
  const flags = [];
  const codes = [...new Set(bill.lines.map(l => l.code).filter(Boolean))];
  // duplicate: same patient + same service code at the same provider within the window (default 24 h)
  const win = settings.duplicateWindowHours * 3600e3;
  const near = await db.col('bills').find({ orgId: bill.orgId, patientId: bill.patientId, status: { $ne: 'void' }, createdAt: { $gte: bill.createdAt - win, $lte: bill.createdAt + win } });
  const dupCodes = codes.filter(code => near.some(o => o.id !== bill.id && (o.lines || []).some(l => l.code === code)));
  if (dupCodes.length) flags.push({ code: 'duplicate', detail: 'Same service billed for this patient within ' + settings.duplicateWindowHours + ' hours', codes: dupCodes });
  // no evidence: source record not completed / released / delivered / closed
  const ev = await evidenceFor(bill);
  if (!ev.ok) flags.push({ code: 'no_evidence', detail: bill.source && EVIDENCE[bill.source.type] ? 'The service record is not completed' : 'No service record is attached to this bill' });
  // over limit
  if (!cov) flags.push({ code: 'over_limit', detail: 'Cover record not found' });
  else {
    const overCats = CATS.filter(c => ((cov.usedKobo || {})[c] || 0) > ((cov.limits || {})[c] || 0));
    if (overCats.length || claimedKobo > bill.totalKobo) flags.push({ code: 'over_limit', detail: 'Claim exceeds cover limits', categories: overCats });
    else if (cov.validTo && new Date(bill.createdAt + 3600e3).toISOString().slice(0, 10) > cov.validTo) flags.push({ code: 'over_limit', detail: 'Service date is after the cover end date' });
  }
  // frequency: more than 3 of the same service per patient per 30 days (claims to this HMO)
  const freqCodes = [];
  for (const code of codes) {
    const n = await db.col('claims').count({ payerOrgId: bill.hmo.payerOrgId, patientId: bill.patientId, submittedAt: { $gte: now() - 30 * 86400e3 }, 'lines.code': code });
    if (n >= settings.frequencyLimitPer30Days) freqCodes.push(code);
  }
  if (freqCodes.length) flags.push({ code: 'frequency', detail: 'More than ' + settings.frequencyLimitPer30Days + ' of the same service in 30 days', codes: freqCodes });
  if (!preauthId && claimedKobo > settings.preauthThresholdKobo) flags.push({ code: 'missing_preauth', detail: 'Amount is above the pre-authorisation threshold' });
  return flags;
}
async function syncBillClaim(claim) {
  await db.col('bills').updateOne({ id: claim.billId, orgId: claim.providerOrgId }, { $set: { 'hmo.claimStatus': claim.status, 'hmo.claimId': claim.id } });
}

async function submitClaimForBill({ orgId, billId, userId }) {
  const bill = await db.col('bills').findOne({ id: billId, orgId });
  if (!bill) return { billId, ok: false, error: 'not_found', message: 'Bill not found' };
  if (!bill.hmo || !bill.hmo.payerOrgId) return { billId, ok: false, error: 'no_cover', message: 'This bill has no HMO cover' };
  if (bill.status !== 'paid') return { billId, ok: false, error: 'not_settled', message: 'Only paid or settled bills can be claimed' };
  if (await db.col('claims').findOne({ billId })) return { billId, ok: false, error: 'already_claimed', message: 'This bill has already been claimed' };
  const cov = await db.col('coverages').findOne({ id: bill.hmo.coverageId, payerOrgId: bill.hmo.payerOrgId });
  const settings = await payerSettings(bill.hmo.payerOrgId);
  const pa = bill.hmo.preauthId ? await db.col('preauths').findOne({ id: bill.hmo.preauthId, providerOrgId: orgId }) : null;
  const ev = await evidenceFor(bill);
  const diagnosis = (await diagnosisFor(bill, ev.doc)) || (pa ? pa.diagnosis : null);
  const flags = await flagsFor(bill, cov, bill.hmo.coveredKobo, bill.hmo.preauthId, settings);
  const claim = { id: id('clm'), number: 'CL' + String(await orgs.nextNumber('claim_' + bill.hmo.payerOrgId)).padStart(6, '0'), providerOrgId: orgId, payerOrgId: bill.hmo.payerOrgId, patientId: bill.patientId,
    coverageId: bill.hmo.coverageId, memberNo: cov ? cov.memberNo : null, billId: bill.id, billNumber: bill.number, serviceDate: new Date(bill.createdAt + 3600e3).toISOString().slice(0, 10),
    lines: bill.lines.map(l => ({ code: l.code, name: l.name, category: catOf(l.category), qty: l.qty, unitPriceKobo: l.unitPriceKobo, totalKobo: l.totalKobo })),
    billTotalKobo: bill.totalKobo, claimedKobo: bill.hmo.coveredKobo, approvedKobo: null, paidKobo: null, diagnosis, preauthId: pa ? pa.id : null, preauthCode: pa ? pa.authCode : null,
    flags, status: 'submitted', submittedBy: userId || null, submittedAt: now(), history: [{ at: now(), from: null, to: 'submitted', by: userId || 'system', orgId }] };
  try { await db.col('claims').insertOne(claim); } catch (e) { if (e.code === 11000) return { billId, ok: false, error: 'already_claimed', message: 'This bill has already been claimed' }; throw e; }
  await syncBillClaim(claim);
  return { billId, ok: true, claim };
}

router.post('/hmo/claims', prov('hmo.claim'), claimsOn, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { billIds: t.arr(t.id(), { required: true, min: 1, max: 100 }) });
  const results = [];
  for (const billId of [...new Set(b.billIds)]) {
    const bill = await db.col('bills').findOne({ id: billId, orgId: req.ctx.org.id }, { projection: { patientId: 1 } });
    if (bill && !(await P.linkOf(req.ctx.org.id, bill.patientId))) { results.push({ billId, ok: false, error: 'not_found', message: 'Bill not found' }); continue; }
    const r = await submitClaimForBill({ orgId: req.ctx.org.id, billId, userId: req.ctx.user.id });
    if (r.ok) {
      await audit(req, 'hmo.claim_submit', { type: 'claim', id: r.claim.id, patientId: r.claim.patientId }, { billId, claimedKobo: r.claim.claimedKobo, flags: r.claim.flags.map(f => f.code) });
      await notify({ orgId: r.claim.payerOrgId, role: 'payer_officer', title: 'New claim ' + r.claim.number, body: req.ctx.org.name + ' submitted a claim' + (r.claim.flags.length ? ' (flagged)' : '') + '.', kind: 'claim', ref: { type: 'claim', id: r.claim.id } });
      results.push({ billId, ok: true, claimId: r.claim.id, number: r.claim.number, flags: r.claim.flags.map(f => f.code) });
    } else results.push(r);
  }
  res.json({ submitted: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
}));
router.get('/hmo/claims', prov('hmo.claim'), ah(async (req, res) => {
  const q = query(req, { status: t.enum(Object.keys(CLAIM_TRANSITIONS)), payerOrgId: t.id(), limit: t.int({ min: 1, max: 500 }) });
  const f = { providerOrgId: req.ctx.org.id }; if (q.status) f.status = q.status; if (q.payerOrgId) f.payerOrgId = q.payerOrgId;
  const rows = await db.col('claims').find(f, { sort: { submittedAt: -1 }, limit: q.limit || 100 });
  const n = await namesFor(rows); res.json(rows.map(r => claimView(r, n)));
}));
router.get('/hmo/claims/:id', prov('hmo.claim'), ah(async (req, res) => {
  const c = await db.col('claims').findOne({ id: param(req, 'id'), providerOrgId: req.ctx.org.id });
  if (!c) throw notFound('Claim not found');
  res.json(claimView(c, await namesFor([c])));
}));
router.post('/hmo/claims/:id/resubmit', prov('hmo.claim'), claimsOn, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { answer: t.text({ required: true, max: 1000 }) });
  const c = await db.col('claims').findOneAndUpdate({ id: param(req, 'id'), providerOrgId: req.ctx.org.id, status: 'queried' }, { $set: { status: 'resubmitted', answer: b.answer, resubmittedAt: now() }, $push: { history: hist(req, 'queried', 'resubmitted') } });
  if (!c) { const ex = await db.col('claims').findOne({ id: param(req, 'id'), providerOrgId: req.ctx.org.id }); if (!ex) throw notFound('Claim not found'); throw conflict('This claim is ' + ex.status + ', not queried', 'wrong_state'); }
  await syncBillClaim(c);
  await audit(req, 'hmo.claim_resubmit', { type: 'claim', id: c.id, patientId: c.patientId });
  await notify({ orgId: c.payerOrgId, role: 'payer_officer', title: 'Claim ' + c.number + ' resubmitted', body: 'The provider answered your query.', kind: 'claim', ref: { type: 'claim', id: c.id } });
  res.json(claimView(c, await namesFor([c])));
}));
router.get('/hmo/dashboard', A.requireStaff({ anyPerm: ['hmo.claim', 'admin.reports'], module: 'hmo' }), ah(async (req, res) => {
  const rows = await db.col('claims').find({ providerOrgId: req.ctx.org.id }, { projection: { status: 1, payerOrgId: 1, claimedKobo: 1, approvedKobo: 1, paidKobo: 1, submittedAt: 1 } });
  const byStatus = Object.fromEntries(Object.keys(CLAIM_TRANSITIONS).map(s => [s, { count: 0, claimedKobo: 0 }]));
  const byPayer = {};
  rows.forEach(c => {
    byStatus[c.status].count++; byStatus[c.status].claimedKobo += c.claimedKobo;
    const p = byPayer[c.payerOrgId] = byPayer[c.payerOrgId] || { payerOrgId: c.payerOrgId, claims: 0, pendingKobo: 0, approvedUnpaidKobo: 0, paidKobo: 0, deniedKobo: 0 };
    p.claims++;
    if (CLAIM_OPEN.includes(c.status)) p.pendingKobo += c.claimedKobo;
    if (c.status === 'approved') p.approvedUnpaidKobo += c.approvedKobo || 0;
    if (c.status === 'paid') p.paidKobo += c.paidKobo || 0;
    if (c.status === 'denied') p.deniedKobo += c.claimedKobo;
  });
  const names = await orgNameCache(Object.keys(byPayer));
  const payers = Object.values(byPayer).map(p => Object.assign(p, { payerName: names[p.payerOrgId] || null, outstandingKobo: p.pendingKobo + p.approvedUnpaidKobo }));
  const unclaimed = await db.col('bills').count({ orgId: req.ctx.org.id, status: 'paid', 'hmo.claimStatus': 'not_submitted' });
  const pre = await db.col('preauths').find({ providerOrgId: req.ctx.org.id, status: { $in: ['pending', 'queried'] } }, { projection: { status: 1 } });
  res.json({ byStatus, payers, outstandingKobo: payers.reduce((s, p) => s + p.outstandingKobo, 0), unclaimedBills: unclaimed, preauthsPending: pre.filter(p => p.status === 'pending').length, preauthsQueried: pre.filter(p => p.status === 'queried').length });
}));
/* paid bills with HMO cover not yet claimed (the claims screen picks from this) */
router.get('/hmo/claimable-bills', prov('hmo.claim'), ah(async (req, res) => {
  const rows = await db.col('bills').find({ orgId: req.ctx.org.id, status: 'paid', 'hmo.claimStatus': 'not_submitted' }, { sort: { createdAt: -1 }, limit: 300 });
  const n = await patientNames(rows.map(r => r.patientId)); const on = await orgNameCache(rows.map(r => r.hmo.payerOrgId));
  res.json(rows.map(b => ({ billId: b.id, number: b.number, patientId: b.patientId, patientName: n[b.patientId] || null, payerOrgId: b.hmo.payerOrgId, payerName: on[b.hmo.payerOrgId] || null, totalKobo: b.totalKobo, coveredKobo: b.hmo.coveredKobo, createdAt: b.createdAt })));
}));

/* payer side */
router.get('/payer/claims', ...payerAny(['payer.claims', 'payer.pay']), ah(async (req, res) => {
  const q = query(req, { status: t.enum(Object.keys(CLAIM_TRANSITIONS)), flagged: t.bool(), providerOrgId: t.id(), limit: t.int({ min: 1, max: 500 }) });
  const f = { payerOrgId: req.ctx.org.id }; if (q.status) f.status = q.status; if (q.providerOrgId) f.providerOrgId = q.providerOrgId;
  if (q.flagged === true) f['flags.0'] = { $exists: true };
  const rows = await db.col('claims').find(f, { sort: { submittedAt: 1 }, limit: q.limit || 200 });
  const n = await namesFor(rows); res.json(rows.map(r => claimView(r, n)));
}));
router.get('/payer/claims/:id', ...payerAny(['payer.claims', 'payer.pay']), ah(async (req, res) => {
  const c = await db.col('claims').findOne({ id: param(req, 'id'), payerOrgId: req.ctx.org.id });
  if (!c) throw notFound('Claim not found');
  await audit(req, 'payer.claim_view', { type: 'claim', id: c.id, patientId: c.patientId });
  const v = claimView(c, await namesFor([c]));
  const cov = await db.col('coverages').findOne({ id: c.coverageId, payerOrgId: req.ctx.org.id });
  v.cover = cov ? { status: cov.status, validTo: cov.validTo, limits: cov.limits, usedKobo: cov.usedKobo, remainingKobo: remainingOf(cov) } : null;
  res.json(v);
}));
async function claimMove(req, from, to, set, action, meta) {
  const cid = param(req, 'id');
  const c = await db.col('claims').findOneAndUpdate({ id: cid, payerOrgId: req.ctx.org.id, status: Array.isArray(from) ? { $in: from } : from },
    { $set: Object.assign({ status: to, updatedAt: now() }, set || {}), $push: { history: hist(req, Array.isArray(from) ? from.join('|') : from, to) } });
  if (!c) { const ex = await db.col('claims').findOne({ id: cid, payerOrgId: req.ctx.org.id }); if (!ex) throw notFound('Claim not found'); throw conflict('This claim is ' + ex.status + '; that action is not possible now', 'wrong_state'); }
  await syncBillClaim(c);
  await audit(req, 'payer.' + action, { type: 'claim', id: c.id, patientId: c.patientId }, meta);
  if (to !== 'under_review') await notify({ orgId: c.providerOrgId, role: 'cashier', title: 'Claim ' + c.number + ' ' + (to === 'queried' ? 'has a query' : to), body: req.ctx.org.name + ' updated the claim.', kind: 'claim', ref: { type: 'claim', id: c.id } });
  return claimView(c, await namesFor([c]));
}
router.post('/payer/claims/:id/review', ...payer('payer.claims'), ah(async (req, res) => {
  res.json(await claimMove(req, ['submitted', 'resubmitted'], 'under_review', { reviewerId: req.ctx.user.id, reviewStartedAt: now() }, 'claim_review'));
}));
router.post('/payer/claims/:id/approve', ...payer('payer.claims'), ah(async (req, res) => {
  const b = body(req, { approvedKobo: t.money({ required: true, min: 1 }), note: t.str({ max: 500 }) });
  const cur = await db.col('claims').findOne({ id: param(req, 'id'), payerOrgId: req.ctx.org.id });
  if (!cur) throw notFound('Claim not found');
  if (b.approvedKobo > cur.claimedKobo) throw bad('Approved amount cannot be more than the amount claimed');
  res.json(await claimMove(req, 'under_review', 'approved', { approvedKobo: b.approvedKobo, partial: b.approvedKobo < cur.claimedKobo, decisionNote: b.note || null, decidedAt: now(), decidedBy: req.ctx.user.id }, 'claim_approve', { approvedKobo: b.approvedKobo }));
}));
router.post('/payer/claims/:id/deny', ...payer('payer.claims'), ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 3, max: 500 }) });
  res.json(await claimMove(req, 'under_review', 'denied', { denyReason: b.reason, decidedAt: now(), decidedBy: req.ctx.user.id }, 'claim_deny'));
}));
router.post('/payer/claims/:id/query', ...payer('payer.claims'), ah(async (req, res) => {
  const b = body(req, { question: t.str({ required: true, min: 3, max: 500 }) });
  res.json(await claimMove(req, 'under_review', 'queried', { question: b.question, answer: null, queriedAt: now() }, 'claim_query'));
}));
router.post('/payer/claims/:id/pay', ...payer('payer.pay'), ah(async (req, res) => {
  const b = body(req, { paymentRef: t.str({ required: true, max: 60, label: 'Payment reference' }) });
  const cur = await db.col('claims').findOne({ id: param(req, 'id'), payerOrgId: req.ctx.org.id });
  if (!cur) throw notFound('Claim not found');
  res.json(await claimMove(req, 'approved', 'paid', { paidKobo: cur.approvedKobo, paymentRef: b.paymentRef, paidAt: now(), paidBy: req.ctx.user.id }, 'claim_pay', { paidKobo: cur.approvedKobo, paymentRef: b.paymentRef }));
}));

router.get('/payer/dashboard', ...payerAny(['payer.claims', 'payer.preauth', 'payer.members', 'admin.reports']), ah(async (req, res) => {
  const org = req.ctx.org.id;
  const claims = await db.col('claims').find({ payerOrgId: org }, { projection: { status: 1, providerOrgId: 1, patientId: 1, claimedKobo: 1, approvedKobo: 1, paidKobo: 1, submittedAt: 1, decidedAt: 1, flags: 1, number: 1 } });
  const queue = Object.fromEntries(Object.keys(CLAIM_TRANSITIONS).map(s => [s, 0])); claims.forEach(c => { queue[c.status]++; });
  const decided = claims.filter(c => c.decidedAt && c.decidedAt > now() - 90 * 86400e3);
  const open = claims.filter(c => CLAIM_OPEN.includes(c.status));
  const byProv = {};
  claims.forEach(c => { const p = byProv[c.providerOrgId] = byProv[c.providerOrgId] || { providerOrgId: c.providerOrgId, claims: 0, claimedKobo: 0, approvedKobo: 0, paidKobo: 0, flagged: 0 }; p.claims++; p.claimedKobo += c.claimedKobo; p.approvedKobo += c.approvedKobo || 0; p.paidKobo += c.paidKobo || 0; if ((c.flags || []).length) p.flagged++; });
  const names = await orgNameCache(Object.keys(byProv));
  const pre = await db.col('preauths').find({ payerOrgId: org }, { projection: { status: 1, createdAt: 1, decidedAt: 1, lastSubmittedAt: 1 } });
  const prePending = pre.filter(p => p.status === 'pending');
  const preDecided = pre.filter(p => p.decidedAt);
  const covs = await db.col('coverages').find({ payerOrgId: org, status: 'active' });
  const pn = await patientNames(covs.map(c => c.patientId));
  const util = covs.map(c => { const lim = CATS.reduce((s, k) => s + ((c.limits || {})[k] || 0), 0); const used = CATS.reduce((s, k) => s + ((c.usedKobo || {})[k] || 0), 0); return { coverageId: c.id, memberNo: c.memberNo, name: pn[c.patientId] || c.enrolName || null, limitKobo: lim, usedKobo: used, pct: lim ? Math.round(used / lim * 1000) / 10 : 0 }; }).sort((a, b) => b.pct - a.pct);
  const fl = open.filter(c => (c.flags || []).length).sort((a, b) => a.submittedAt - b.submittedAt);
  res.json({
    queue, openClaims: open.length, oldestOpenHours: open.length ? hours(now() - Math.min(...open.map(c => c.submittedAt))) : null,
    avgTurnaroundHours: decided.length ? hours(decided.reduce((s, c) => s + (c.decidedAt - c.submittedAt), 0) / decided.length) : null,
    flaggedOpen: fl.length, flagged: fl.slice(0, 20).map(c => ({ id: c.id, number: c.number, providerOrgId: c.providerOrgId, flags: c.flags.map(f => f.code), claimedKobo: c.claimedKobo, ageHours: hours(now() - c.submittedAt) })),
    totals: { claimedKobo: claims.reduce((s, c) => s + c.claimedKobo, 0), approvedKobo: claims.reduce((s, c) => s + (c.approvedKobo || 0), 0), paidKobo: claims.reduce((s, c) => s + (c.paidKobo || 0), 0), approvedUnpaidKobo: claims.filter(c => c.status === 'approved').reduce((s, c) => s + (c.approvedKobo || 0), 0) },
    byProvider: Object.values(byProv).map(p => Object.assign(p, { providerName: names[p.providerOrgId] || null })).sort((a, b) => b.claimedKobo - a.claimedKobo),
    preauths: { pending: prePending.length, queried: pre.filter(p => p.status === 'queried').length, oldestPendingMinutes: prePending.length ? Math.round((now() - Math.min(...prePending.map(p => p.lastSubmittedAt || p.createdAt))) / 60000) : null,
      avgTurnaroundMinutes: preDecided.length ? Math.round(preDecided.reduce((s, p) => s + (p.decidedAt - p.createdAt), 0) / preDecided.length / 60000) : null },
    members: { active: covs.length, pending: await db.col('coverages').count({ payerOrgId: org, status: 'pending' }), utilisation: util.slice(0, 20) },
  });
}));

/* ================= demo ================= */
async function seedDemo(ctx) {
  const billing = require('./billing');
  const hmo = ctx.orgs.hmo, hosp = ctx.orgs.hospital;
  const validTo = (new Date().getUTCFullYear() + 1) + '-12-31';
  const limits = { consultation: naira(200000), drug: naira(300000), lab: naira(150000), ambulance: naira(200000), delivery: naira(20000), procedure: naira(500000), other: naira(50000) };
  const covs = {};
  for (const [key, memberNo, plan] of [['amaka', 'HH-100234', 'Harbor Gold'], ['tobi', 'HH-100871', 'Harbor Silver']]) {
    const p = ctx.patients[key];
    covs[key] = { id: id('cov'), patientId: p.id, phone: p.phone, payerOrgId: hmo.id, memberNo, planName: plan, status: 'active', patientConfirmed: true, payerVerified: true, enrolledBy: 'payer', limits: Object.assign({}, limits), usedKobo: zeroUsed(), validTo, createdAt: now(), verifiedAt: now(), history: [{ at: now(), from: null, to: 'active', by: 'demo' }] };
    await db.col('coverages').insertOne(covs[key]);
  }
  const svc = async code => orgs.service(hosp.id, code);
  const sys = { userId: 'demo' };
  // an approved pre-authorisation (unused) for Amaka's specialist review
  const spec = await svc('CONS-SPEC');
  await db.col('preauths').insertOne({ id: id('pa'), number: 'PA' + String(await orgs.nextNumber('preauth_' + hmo.id)).padStart(6, '0'), providerOrgId: hosp.id, payerOrgId: hmo.id, patientId: ctx.patients.amaka.id, coverageId: covs.amaka.id, memberNo: covs.amaka.memberNo,
    services: [{ code: spec.code, name: spec.name, category: 'consultation', qty: 1, unitKobo: spec.priceKobo, amountKobo: spec.priceKobo, priced: 'price_list' }], requestedKobo: spec.priceKobo, diagnosis: { code: 'I10', text: 'Essential hypertension, review' }, note: 'Cardiology review',
    status: 'approved', approvedKobo: spec.priceKobo, authCode: 'AUTH-HARB-' + digits(6), validUntil: now() + 30 * 86400e3, requestedBy: sys.userId, createdAt: now() - 3 * 3600e3, lastSubmittedAt: now() - 3 * 3600e3, decidedAt: now() - 2 * 3600e3, usedBillId: null,
    history: [{ at: now() - 3 * 3600e3, from: null, to: 'pending', by: 'demo' }, { at: now() - 2 * 3600e3, from: 'pending', to: 'approved', by: 'demo' }] });
  // a paid claim: Amaka's GP consultation, fully covered
  const gp = await svc('CONS-GP');
  const anyAppt = await db.col('appointments').findOne({ orgId: hosp.id, patientId: ctx.patients.amaka.id, status: 'completed' });
  const b1 = await billing.createBill({ orgId: hosp.id, patientId: ctx.patients.amaka.id, lines: [billing.lineFromService(gp, 1)], source: anyAppt ? { type: 'appointment', id: anyAppt.id } : { type: 'manual', id: null }, createdBy: 'demo' });
  await applyCover({ orgId: hosp.id, billId: b1.id, coverageId: covs.amaka.id, userId: 'demo' });
  const r1 = await submitClaimForBill({ orgId: hosp.id, billId: b1.id, userId: 'demo' });
  const officer = ctx.staff.hmo.officer.user.id;
  await db.col('claims').updateOne({ id: r1.claim.id }, { $set: { status: 'paid', approvedKobo: r1.claim.claimedKobo, paidKobo: r1.claim.claimedKobo, paymentRef: 'HHTRF-' + digits(8), decidedAt: now(), decidedBy: officer, paidAt: now(), paidBy: officer },
    $push: { history: { $each: [{ at: now(), from: 'submitted', to: 'under_review', by: officer }, { at: now(), from: 'under_review', to: 'approved', by: officer }, { at: now(), from: 'approved', to: 'paid', by: officer }] } } });
  await syncBillClaim(Object.assign(r1.claim, { status: 'paid' }));
  // a flagged duplicate: Tobi billed the same GP consultation twice the same day, the second is claimed
  const b2 = await billing.createBill({ orgId: hosp.id, patientId: ctx.patients.tobi.id, lines: [billing.lineFromService(gp, 1)], source: { type: 'manual', id: null }, createdBy: 'demo' });
  await applyCover({ orgId: hosp.id, billId: b2.id, coverageId: covs.tobi.id, userId: 'demo' });
  const b3 = await billing.createBill({ orgId: hosp.id, patientId: ctx.patients.tobi.id, lines: [billing.lineFromService(gp, 1)], source: { type: 'manual', id: null }, createdBy: 'demo' });
  await applyCover({ orgId: hosp.id, billId: b3.id, coverageId: covs.tobi.id, userId: 'demo' });
  await submitClaimForBill({ orgId: hosp.id, billId: b3.id, userId: 'demo' });
}

module.exports = { name: 'payer', router, seedDemo, applyCover, submitClaimForBill, remainingOf, isActive, CATS, catOf, COVERAGE_TRANSITIONS, PREAUTH_TRANSITIONS, CLAIM_TRANSITIONS };
