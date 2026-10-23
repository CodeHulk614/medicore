'use strict';
/*
 * Shared care: several providers looking after the same patient at the same time.
 *
 * A referral hands a patient over. Shared care keeps every provider involved: a hospital shares a patient with the
 * pharmacy that dispenses their long-term medicines, the lab that runs their monthly tests and the physiotherapist
 * who treats them, and they all work from one record.
 *
 *   1. The patient's provider (the one sharing) picks another provider on MediCore, says why and for how long.
 *   2. The patient agrees: in the app, or by reading back an SMS code at the desk (no consent needed when HQ says so).
 *   3. The other provider accepts: the patient is registered there (same record number rules as any registration).
 *   4. While the share is active both providers (and all branches of their groups) see each other's records for this
 *      patient, and every provider on the patient's care team writes in one private care-team conversation.
 *   5. The patient sees their care team in the app and can withdraw any share; either provider can end it; it ends by
 *      itself on its end date.
 *
 *  statuses: pending_patient -> pending_provider -> active -> ended | revoked | expired ; pending_* -> declined | cancelled
 */
const express = require('express');
const db = require('../db');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param } = require('../lib/http');
const A = require('../lib/auth');
const S = require('../lib/settings');
const RL = require('../lib/ratelimit');
const otp = require('../lib/otp');
const { id, now } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const P = require('./patients');
const { nextNumber } = require('./orgs');

db.index('care_shares', ['patientId', 'status']);
db.index('care_shares', ['toOrgId', 'status', 'createdAt']);
db.index('care_shares', ['fromOrgId', 'createdAt']);
db.index('care_messages', ['patientId', 'at']);

const router = express.Router();
const OPEN = ['pending_patient', 'pending_provider', 'active'];
const PURPOSES = ['ongoing_treatment', 'medicines', 'lab_monitoring', 'specialist_care', 'physiotherapy', 'maternity', 'home_care', 'second_opinion', 'other'];
const featureOn = (req, res, next) => (S.feature('careSharing', req.ctx && req.ctx.org) ? next() : next(forbidden('Shared care is switched off on MediCore')));
const manageG = [A.requireStaff({ perm: 'careshare.manage' }), featureOn];
const readG = [A.requireStaff({ anyPerm: ['careshare.manage', 'patient.read', 'clinic.consult'] }), featureOn];
const isLive = s => s.status === 'active' && (!s.endsAt || s.endsAt > now());
const effStatus = s => (s.status === 'active' && s.endsAt && s.endsAt <= now() ? 'expired' : s.status);

/** org ids in the same group as orgId (or just orgId) */
async function groupIds(orgId) {
  const o = await db.col('orgs').findOne({ id: orgId }, { projection: { id: 1, groupId: 1 } });
  if (!o) return [orgId];
  return P.groupOrgIds(o);
}
/** org ids whose records the caller's group may see for this patient through active shares */
async function sharedOrgIds(myOrgIds, patientId) {
  if (!S.feature('careSharing')) return [];
  const rows = await db.col('care_shares').find({ patientId, status: 'active', $or: [{ fromOrgId: { $in: myOrgIds } }, { toOrgId: { $in: myOrgIds } }] });
  const out = new Set();
  for (const s of rows.filter(isLive)) {
    const other = myOrgIds.includes(s.fromOrgId) ? s.toOrgId : s.fromOrgId;
    (await groupIds(other)).forEach(x => out.add(x));
  }
  myOrgIds.forEach(x => out.delete(x));
  return [...out];
}
/** every provider on a patient's care team: providers with an active share involving them */
async function careTeamOrgIds(patientId) {
  const rows = (await db.col('care_shares').find({ patientId, status: 'active' })).filter(isLive);
  return [...new Set(rows.flatMap(s => [s.fromOrgId, s.toOrgId]))];
}
async function onTeam(req, patientId) {
  const mine = await P.groupOrgIds(req.ctx.org);
  const team = await careTeamOrgIds(patientId);
  return team.some(x => mine.includes(x));
}
async function orgName(oid, cache) { if (cache && oid in cache) return cache[oid]; const o = await db.col('orgs').findOne({ id: oid }, { projection: { name: 1, type: 1 } }); const v = o ? o.name : null; if (cache) cache[oid] = v; return v; }
async function shareView(s, me) {
  const cache = {};
  return { id: s.id, number: s.number, patientId: s.patientId, patientName: s.patientName, fromOrgId: s.fromOrgId, fromOrgName: await orgName(s.fromOrgId, cache), toOrgId: s.toOrgId, toOrgName: await orgName(s.toOrgId, cache),
    direction: me ? (s.toOrgId === me ? 'in' : 'out') : null, purpose: s.purpose, note: s.note || null, status: effStatus(s), consent: s.consent || null, createdAt: s.createdAt, createdByName: s.createdByName || null,
    acceptedAt: s.acceptedAt || null, endsAt: s.endsAt || null, endedAt: s.endedAt || null, endReason: s.endReason || null, declineReason: s.declineReason || null, timeline: s.timeline || [] };
}
async function move(req, s, from, to, set, note) {
  const by = req.ctx.user ? { by: req.ctx.user.id, byName: req.ctx.user.name } : { by: 'system', byName: null };
  const u = await db.col('care_shares').findOneAndUpdate({ id: s.id, status: { $in: [].concat(from) } }, { $set: Object.assign({ status: to, updatedAt: now() }, set || {}), $push: { timeline: Object.assign({ status: to, at: now(), note: note || null, orgName: req.ctx.org ? req.ctx.org.name : null }, by) } });
  if (!u) throw conflict('This shared-care request changed. Refresh and try again.', 'wrong_state');
  await audit(req, 'careshare.' + to, { type: 'care_share', id: s.id, patientId: s.patientId, orgId: req.ctx.org ? req.ctx.org.id : null }, { from: s.status });
  return u;
}
async function tellProvider(s) {
  for (const role of ['receptionist', 'records', 'frontdesk_manager', 'pharmacist', 'lab_manager', 'owner']) await notify({ orgId: s.toOrgId, role, title: 'Shared care request ' + s.number, body: s.fromOrgName + ' wants to share the care of a patient with you.', kind: 'care_share', ref: { type: 'care_share', id: s.id } });
}

/* ================= staff ================= */
router.post('/care-shares', ...manageG, ah(async (req, res) => {
  const b = body(req, { patientId: t.id({ required: true }), toOrgId: t.id({ required: true }), purpose: t.enum(PURPOSES, { required: true }), note: t.text({ max: 1000 }), days: t.int({ min: 1, max: 730 }) });
  const { patient } = await P.requireLinked(req, b.patientId);
  const to = await db.col('orgs').findOne({ id: b.toOrgId, status: 'active', type: { $ne: 'hmo' } });
  if (!to || (to.settings || {}).acceptsReferrals === false) throw notFound('That provider does not take shared patients on MediCore');
  const mine = await P.groupOrgIds(req.ctx.org);
  if (mine.includes(to.id)) throw bad('Branches of your group already share records. Pick a provider outside your group.');
  if (await db.col('care_shares').findOne({ patientId: patient.id, status: { $in: OPEN }, $or: [{ fromOrgId: { $in: mine }, toOrgId: to.id }, { toOrgId: { $in: mine }, fromOrgId: to.id }] })) throw conflict('This patient is already shared with ' + to.name + ' (or a request is waiting)');
  await RL.limit('cshare_' + req.ctx.org.id, 200, 86400);
  const maxDays = Number(S.get('process.careShare.maxDays', 730)) || 730;
  const days = Math.min(b.days || Number(S.get('process.careShare.defaultDays', 180)) || 180, maxDays);
  const needConsent = S.get('process.careShare.requirePatientConsent', true, req.ctx.org) !== false;
  const n = await nextNumber('careshare');
  const s = { id: id('csh'), number: 'CS' + String(n).padStart(6, '0'), patientId: patient.id, patientName: patient.firstName + ' ' + patient.lastName, fromOrgId: req.ctx.org.id, fromOrgName: req.ctx.org.name, toOrgId: to.id, toOrgName: to.name, purpose: b.purpose, note: b.note || null, days,
    status: needConsent ? 'pending_patient' : 'pending_provider', consent: needConsent ? null : { method: 'not_required', at: now() }, createdAt: now(), createdBy: req.ctx.user.id, createdByName: req.ctx.user.name,
    timeline: [{ status: needConsent ? 'pending_patient' : 'pending_provider', at: now(), by: req.ctx.user.id, byName: req.ctx.user.name, orgName: req.ctx.org.name }] };
  await db.col('care_shares').insertOne(s);
  await audit(req, 'careshare.request', { type: 'care_share', id: s.id, patientId: patient.id }, { toOrgId: to.id, purpose: b.purpose });
  if (needConsent && patient.userId) await notify({ patientId: patient.id, title: 'Share your care with ' + to.name + '?', body: req.ctx.org.name + ' wants ' + to.name + ' to help look after you and see your records. Open MediCore to agree or say no.', kind: 'care_share', ref: { type: 'care_share', id: s.id } });
  if (!needConsent) await tellProvider(s);
  res.json(Object.assign(await shareView(s, req.ctx.org.id), { patientHasApp: !!patient.userId, canUseCode: S.get('process.careShare.allowCodeConsent', true) !== false && !!patient.phone }));
}));
async function myShare(req, sid, side) {
  const mine = await P.groupOrgIds(req.ctx.org);
  const f = { id: sid }; if (side === 'from') f.fromOrgId = { $in: mine }; else if (side === 'to') f.toOrgId = { $in: mine }; else f.$or = [{ fromOrgId: { $in: mine } }, { toOrgId: { $in: mine } }];
  const s = await db.col('care_shares').findOne(f);
  if (!s) throw notFound('Shared-care request not found');
  return s;
}
router.post('/care-shares/:id/consent-code/send', ...manageG, ah(async (req, res) => {
  const s = await myShare(req, param(req, 'id'), 'from');
  if (s.status !== 'pending_patient') throw conflict('The patient\'s agreement is not needed now');
  if (S.get('process.careShare.allowCodeConsent', true) === false) throw forbidden('Consent by SMS code is switched off. The patient agrees in the app.');
  const p = await db.col('patients').findOne({ id: s.patientId });
  if (!p || !p.phone) throw bad('This patient has no phone number. Ask them to agree in the app, or add their phone number.');
  await RL.limit('csotp_' + s.id, 5, 3600);
  const extra = await otp.issue('careshare:' + s.id, p.phone, 'MediCore: to let ' + s.toOrgName + ' share your care with ' + s.fromOrgName + ', tell the staff this code: {code}');
  res.json(Object.assign({ ok: true }, extra));
}));
router.post('/care-shares/:id/consent-code/verify', ...manageG, ah(async (req, res) => {
  const b = body(req, { code: t.str({ required: true, max: 6 }) });
  const s = await myShare(req, param(req, 'id'), 'from');
  if (s.status !== 'pending_patient') throw conflict('The patient\'s agreement is not needed now');
  const p = await db.col('patients').findOne({ id: s.patientId });
  await otp.verify('careshare:' + s.id, p.phone, b.code);
  const u = await move(req, s, 'pending_patient', 'pending_provider', { consent: { method: 'code', at: now(), byStaff: req.ctx.user.id } }, 'Patient agreed by SMS code');
  await tellProvider(u);
  res.json(await shareView(u, req.ctx.org.id));
}));
router.get('/care-shares', ...readG, ah(async (req, res) => {
  const q = query(req, { box: t.enum(['in', 'out', 'all']), status: t.enum(['pending_patient', 'pending_provider', 'active', 'ended', 'declined', 'revoked', 'cancelled', 'expired']), patientId: t.id() });
  const mine = await P.groupOrgIds(req.ctx.org);
  const f = q.box === 'in' ? { toOrgId: { $in: mine } } : q.box === 'out' ? { fromOrgId: { $in: mine } } : { $or: [{ fromOrgId: { $in: mine } }, { toOrgId: { $in: mine } }] };
  if (q.patientId) f.patientId = q.patientId;
  const rows = await db.col('care_shares').find(f, { sort: { createdAt: -1 }, limit: 300 });
  let out = []; for (const s of rows) out.push(await shareView(s, req.ctx.org.id));
  if (q.status) out = out.filter(x => x.status === q.status);
  res.json({ shares: out, waiting: out.filter(x => x.direction === 'in' && x.status === 'pending_provider').length });
}));
router.get('/care-shares/:id', ...readG, ah(async (req, res) => { res.json(await shareView(await myShare(req, param(req, 'id')), req.ctx.org.id)); }));
router.post('/care-shares/:id/accept', ...manageG, ah(async (req, res) => {
  const s = await myShare(req, param(req, 'id'), 'to');
  if (s.status !== 'pending_provider') throw conflict(s.status === 'pending_patient' ? 'The patient has not agreed yet' : 'This request is ' + effStatus(s));
  const l = await P.ensureLink(req.ctx.org.id, s.patientId, req.ctx.user.id, 'care_share', { careShareId: s.id });
  const u = await move(req, s, 'pending_provider', 'active', { acceptedAt: now(), acceptedBy: req.ctx.user.id, endsAt: now() + (s.days || 180) * 86400e3, toMrn: l.mrn });
  for (const role of ['receptionist', 'records', 'frontdesk_manager', 'owner']) await notify({ orgId: s.fromOrgId, role, title: s.toOrgName + ' joined the care team', body: 'Shared care ' + s.number + ' is active.', kind: 'care_share', ref: { type: 'care_share', id: s.id } });
  await notify({ patientId: s.patientId, title: s.toOrgName + ' is on your care team', body: s.fromOrgName + ' and ' + s.toOrgName + ' now look after you together. You can stop this any time in the app.', kind: 'care_share', ref: { type: 'care_share', id: s.id } });
  try { await require('../lib/events').emit('careshare.active', { careShareId: s.id, fromOrgId: s.fromOrgId, toOrgId: s.toOrgId }); } catch (e) { /* best effort */ }
  res.json(Object.assign(await shareView(u, req.ctx.org.id), { mrn: l.mrn }));
}));
router.post('/care-shares/:id/decline', ...manageG, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 3, max: 300, plain: true }) });
  const s = await myShare(req, param(req, 'id'), 'to');
  const u = await move(req, s, ['pending_provider', 'pending_patient'], 'declined', { declineReason: b.reason, endedAt: now() }, b.reason);
  for (const role of ['receptionist', 'frontdesk_manager', 'owner']) await notify({ orgId: s.fromOrgId, role, title: s.toOrgName + ' declined shared care', body: s.number + ': ' + b.reason, kind: 'care_share', ref: { type: 'care_share', id: s.id } });
  res.json(await shareView(u, req.ctx.org.id));
}));
router.post('/care-shares/:id/end', ...manageG, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 3, max: 300, plain: true }) });
  const s = await myShare(req, param(req, 'id'));
  const to = s.status === 'active' ? 'ended' : 'cancelled';
  const u = await move(req, s, OPEN, to, { endReason: b.reason, endedAt: now(), endedBy: req.ctx.user.id }, b.reason);
  const other = (await P.groupOrgIds(req.ctx.org)).includes(s.fromOrgId) ? s.toOrgId : s.fromOrgId;
  for (const role of ['receptionist', 'frontdesk_manager', 'owner']) await notify({ orgId: other, role, title: 'Shared care ' + to, body: s.number + ': ' + b.reason, kind: 'care_share', ref: { type: 'care_share', id: s.id } });
  res.json(await shareView(u, req.ctx.org.id));
}));

/* the patient's care team, seen by a provider on it */
router.get('/care-team/:patientId', ...readG, ah(async (req, res) => {
  const { patient } = await P.requireLinked(req, param(req, 'patientId'));
  const mine = await P.groupOrgIds(req.ctx.org);
  const shares = (await db.col('care_shares').find({ patientId: patient.id }, { sort: { createdAt: -1 } }));
  const cache = {}; const team = {};
  for (const s of shares.filter(isLive)) for (const oid of [s.fromOrgId, s.toOrgId]) if (!team[oid]) team[oid] = { orgId: oid, name: await orgName(oid, cache), you: mine.includes(oid), since: s.acceptedAt, shareId: s.id };
  const views = []; for (const s of shares) views.push(await shareView(s, req.ctx.org.id));
  const member = Object.values(team).some(x => x.you);
  const msgs = member ? await db.col('care_messages').find({ patientId: patient.id }, { sort: { at: 1 }, limit: 300 }) : [];
  if (member) await audit(req, 'careteam.view', { type: 'patient', id: patient.id, patientId: patient.id });
  res.json({ team: Object.values(team), shares: views, messages: msgs.map(m => ({ id: m.id, orgId: m.orgId, orgName: m.orgName, byName: m.byName, role: m.role || null, text: m.text, at: m.at, you: mine.includes(m.orgId) })), canWrite: member });
}));
router.post('/care-team/:patientId/messages', A.requireStaff({ anyPerm: ['careshare.manage', 'clinic.consult', 'patient.read'] }), featureOn, ah(async (req, res) => {
  const b = body(req, { text: t.text({ required: true, max: 2000 }) });
  const pid = param(req, 'patientId');
  await P.requireLinked(req, pid);
  if (!(await onTeam(req, pid))) throw forbidden('Only providers on the patient\'s care team can write here');
  await RL.limit('ctmsg_' + req.ctx.user.id, 120, 3600);
  const role = require('../lib/roles').ROLES[req.ctx.role];
  const m = { id: id('ctm'), patientId: pid, orgId: req.ctx.org.id, orgName: req.ctx.org.name, byId: req.ctx.user.id, byName: req.ctx.user.name, role: role ? role.label : null, text: b.text, at: now() };
  await db.col('care_messages').insertOne(m);
  const team = await careTeamOrgIds(pid); const mine = await P.groupOrgIds(req.ctx.org);
  for (const oid of team.filter(x => !mine.includes(x))) for (const r of ['doctor', 'frontdesk_manager', 'pharmacist', 'lab_manager']) await notify({ orgId: oid, role: r, title: 'Care team message from ' + req.ctx.org.name, body: 'About a patient you share. Open the patient\'s care team.', kind: 'care_message', ref: { type: 'patient', id: pid } });
  await audit(req, 'careteam.message', { type: 'patient', id: pid, patientId: pid });
  res.json({ ok: true, message: Object.assign({}, m, { you: true }) });
}));

/* ================= patient ================= */
router.get('/me/care-team', A.requirePatient, ah(async (req, res) => {
  const rows = await db.col('care_shares').find({ patientId: req.ctx.patient.id }, { sort: { createdAt: -1 }, limit: 100 });
  const out = []; for (const s of rows) { const v = await shareView(s); delete v.timeline; out.push(v); }
  res.json({ shares: out, waitingForYou: out.filter(x => x.status === 'pending_patient').length, enabled: S.feature('careSharing') });
}));
router.post('/me/care-shares/:id/:action', A.requirePatient, ah(async (req, res) => {
  const action = req.params.action; if (!['approve', 'decline', 'revoke'].includes(action)) throw notFound();
  const s = await db.col('care_shares').findOne({ id: param(req, 'id'), patientId: req.ctx.patient.id });
  if (!s) throw notFound('Not found');
  let u;
  if (action === 'approve') { if (s.status !== 'pending_patient') throw conflict('This is not waiting for you'); u = await move(req, s, 'pending_patient', 'pending_provider', { consent: { method: 'patient_app', at: now() } }, 'Patient agreed in the app'); await tellProvider(u); }
  else if (action === 'decline') u = await move(req, s, 'pending_patient', 'declined', { declineReason: 'Patient said no', endedAt: now() }, 'Patient said no');
  else { u = await move(req, s, ['pending_patient', 'pending_provider', 'active'], 'revoked', { endReason: 'Withdrawn by the patient', endedAt: now() }, 'Withdrawn by the patient'); for (const oid of [s.fromOrgId, s.toOrgId]) for (const role of ['frontdesk_manager', 'owner']) await notify({ orgId: oid, role, title: 'Patient withdrew shared care', body: s.number, kind: 'care_share', ref: { type: 'care_share', id: s.id } }); }
  const v = await shareView(u); delete v.timeline; res.json(v);
}));

/* ================= demo ================= */
async function seedDemo(ctx) {
  const amaka = ctx.patients && ctx.patients.amaka; const hosp = ctx.orgs.hospital; const ph = ctx.orgs.pharmacy; const lab = ctx.orgs.lab;
  if (!amaka || !hosp || !ph) return;
  const l = await P.ensureLink(ph.id, amaka.id, 'demo', 'care_share');
  const n = await nextNumber('careshare');
  const s = { id: id('csh'), number: 'CS' + String(n).padStart(6, '0'), patientId: amaka.id, patientName: amaka.firstName + ' ' + amaka.lastName, fromOrgId: hosp.id, fromOrgName: hosp.name, toOrgId: ph.id, toOrgName: ph.name, purpose: 'medicines', note: 'Monthly refills of her blood pressure medicines and BP checks at the pharmacy. Please tell us if readings stay above 150/95.', days: 180,
    status: 'active', consent: { method: 'patient_app', at: now() - 20 * 86400e3 }, createdAt: now() - 21 * 86400e3, createdBy: 'demo', createdByName: 'Dr. Tunde Bello', acceptedAt: now() - 20 * 86400e3, endsAt: now() + 160 * 86400e3, toMrn: l.mrn,
    timeline: [{ status: 'pending_patient', at: now() - 21 * 86400e3, byName: 'Dr. Tunde Bello', orgName: hosp.name }, { status: 'pending_provider', at: now() - 20.5 * 86400e3, byName: null, orgName: null, note: 'Patient agreed in the app' }, { status: 'active', at: now() - 20 * 86400e3, byName: 'Pharm. Musa Ibrahim', orgName: ph.name }] };
  await db.col('care_shares').insertOne(s);
  await db.col('care_messages').insertMany([
    { id: id('ctm'), patientId: amaka.id, orgId: ph.id, orgName: ph.name, byName: 'Pharm. Musa Ibrahim', role: 'Pharmacist', text: 'BP at refill today 148/92. She says she missed doses last week while travelling.', at: now() - 3 * 86400e3 },
    { id: id('ctm'), patientId: amaka.id, orgId: hosp.id, orgName: hosp.name, byName: 'Dr. Tunde Bello', role: 'Doctor', text: 'Thanks. Keep the same dose. I have booked her for review next week.', at: now() - 2.8 * 86400e3 },
  ]);
  if (lab && ctx.patients.tobi) {
    const n2 = await nextNumber('careshare');
    await db.col('care_shares').insertOne({ id: id('csh'), number: 'CS' + String(n2).padStart(6, '0'), patientId: ctx.patients.tobi.id, patientName: ctx.patients.tobi.firstName + ' ' + ctx.patients.tobi.lastName, fromOrgId: hosp.id, fromOrgName: hosp.name, toOrgId: lab.id, toOrgName: lab.name, purpose: 'lab_monitoring', note: 'HbA1c every 3 months and fasting sugar monthly.', days: 365,
      status: 'pending_provider', consent: { method: 'code', at: now() - 3600e3 }, createdAt: now() - 2 * 3600e3, createdBy: 'demo', createdByName: 'Bisi Adeyemi', timeline: [{ status: 'pending_patient', at: now() - 2 * 3600e3, byName: 'Bisi Adeyemi', orgName: hosp.name }, { status: 'pending_provider', at: now() - 3600e3, note: 'Patient agreed by SMS code', byName: 'Bisi Adeyemi', orgName: hosp.name }] });
  }
}

module.exports = { name: 'caresharing', router, seedDemoAfter: seedDemo, sharedOrgIds, careTeamOrgIds, PURPOSES };
