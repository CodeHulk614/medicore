'use strict';
/*
 * The provider network: hospitals, clinics, pharmacies, labs and ambulance services on MediCore working together.
 *
 *  Directory     providers see other listed providers (settings.networkListed). Patients never see this directory.
 *  Connections   provider A asks provider B to partner; B accepts. Partners are shown on each other's profile
 *                (everyone can see that A and B work together, never what they discuss).
 *  Messages      private provider-to-provider threads (only the two providers' staff can read them).
 *  Referrals     a digital referral note: patient, urgency, reason, a summary of the record, consent and HMO cover.
 *                The receiving provider accepts (the patient is registered there with the referral attached to the
 *                record), declines with a reason, marks arrival (patient joins the triage queue) and reports the outcome,
 *                which the referring provider sees. Any fee arrangement between the two stays between them, off the platform.
 *
 *  referral statuses: sent -> accepted -> arrived -> completed ; sent -> declined | cancelled | expired ; accepted -> cancelled
 */
const express = require('express');
const db = require('../db');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param } = require('../lib/http');
const A = require('../lib/auth');
const S = require('../lib/settings');
const { id, now } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const P = require('./patients');
const { nextNumber, publicOrg } = require('./orgs');

db.index('network_connections', ['pairKey']);
db.index('network_connections', ['fromOrgId', 'status']);
db.index('network_connections', ['toOrgId', 'status']);
db.index('network_threads', ['pairKey']);
db.index('network_threads', ['orgIds', 'lastAt']);
db.index('network_messages', ['threadId', 'at']);
db.index('referrals', ['toOrgId', 'status', 'createdAt']);
db.index('referrals', ['fromOrgId', 'createdAt']);
db.index('referrals', ['patientId', 'createdAt']);

const router = express.Router();
const URGENCY = ['emergency', 'urgent', 'routine', 'elective'];
const SERVICES = ['consultation', 'specialist', 'admission', 'emergency_care', 'lab', 'imaging', 'pharmacy', 'ambulance', 'maternity', 'physiotherapy', 'other'];
const TRANSITIONS = { sent: ['accepted', 'declined', 'cancelled', 'expired'], accepted: ['arrived', 'cancelled', 'completed'], arrived: ['completed'], declined: [], cancelled: [], expired: [], completed: [] };
const pairKey = (a, b) => [a, b].sort().join(':');
const anyNet = A.requireStaff({ anyPerm: ['referral.send', 'referral.receive', 'network.manage'] });
const manage = A.requireStaff({ perm: 'network.manage' });
const sendG = A.requireStaff({ perm: 'referral.send' });
const recvG = A.requireStaff({ perm: 'referral.receive' });
const on = () => { if (!S.feature('referralNetwork')) throw forbidden('The provider network is switched off'); };

/** do these two providers work together? (same group, or an accepted connection) */
async function arePartners(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [oa, ob] = [await db.col('orgs').findOne({ id: a }, { projection: { groupId: 1 } }), await db.col('orgs').findOne({ id: b }, { projection: { groupId: 1 } })];
  if (oa && ob && oa.groupId && oa.groupId === ob.groupId) return true;
  return !!(await db.col('network_connections').findOne({ pairKey: pairKey(a, b), status: 'accepted' }));
}
async function connectionOf(a, b) { return db.col('network_connections').findOne({ pairKey: pairKey(a, b), status: { $in: ['pending', 'accepted'] } }); }
async function groupName(o) { if (!o || !o.groupId) return null; const g = await db.col('groups').findOne({ id: o.groupId }, { projection: { name: 1 } }); return g ? g.name : null; }
const listedFilter = me => ({ status: 'active', type: { $ne: 'hmo' }, id: { $ne: me }, 'settings.networkListed': { $ne: false } });

/* ================= directory ================= */
router.get('/network/providers', anyNet, ah(async (req, res) => {
  on();
  const q = query(req, { q: t.str({ max: 60 }), type: t.enum(['hospital', 'clinic', 'pharmacy', 'ambulance', 'lab', 'other']), module: t.enum(['clinic', 'pharmacy', 'lab', 'ambulance', 'delivery', 'chw']), partners: t.bool(), limit: t.int({ min: 1, max: 200 }) });
  if (!S.feature('providerDirectory') && !q.partners) throw forbidden('The provider directory is switched off. You can still refer to your partners.');
  const me = req.ctx.org.id;
  const f = listedFilter(me); if (q.type) f.type = q.type; if (q.module) f.modules = q.module;
  let rows = await db.col('orgs').find(f, { limit: 2000 });
  if (q.q) { const s = q.q.toLowerCase(); rows = rows.filter(o => o.name.toLowerCase().includes(s) || ((o.location || {}).area || '').toLowerCase().includes(s) || ((o.location || {}).city || '').toLowerCase().includes(s)); }
  const conns = await db.col('network_connections').find({ $or: [{ fromOrgId: me }, { toOrgId: me }], status: { $in: ['pending', 'accepted'] } });
  const st = {}; conns.forEach(c => { const other = c.fromOrgId === me ? c.toOrgId : c.fromOrgId; st[other] = { id: c.id, status: c.status, direction: c.fromOrgId === me ? 'out' : 'in' }; });
  const from = req.ctx.org.location && req.ctx.org.location.lat != null ? req.ctx.org.location : null;
  const out = [];
  for (const o of rows) {
    const sameGroup = !!(o.groupId && o.groupId === req.ctx.org.groupId);
    const c = st[o.id] || null;
    if (q.partners && !sameGroup && !(c && c.status === 'accepted')) continue;
    out.push(Object.assign(publicOrg(o, from), { groupName: await groupName(o), sameGroup, connection: c, acceptsReferrals: (o.settings || {}).acceptsReferrals !== false }));
  }
  out.sort((a, b) => (b.sameGroup - a.sameGroup) || (((b.connection || {}).status === 'accepted') - ((a.connection || {}).status === 'accepted')) || ((a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)) || a.name.localeCompare(b.name));
  res.json(out.slice(0, q.limit || 100));
}));
router.get('/network/providers/:id', anyNet, ah(async (req, res) => {
  on();
  const o = await db.col('orgs').findOne(Object.assign(listedFilter(req.ctx.org.id), { id: param(req, 'id') }));
  if (!o) throw notFound('Provider not found');
  const partners = await db.col('network_connections').find({ $or: [{ fromOrgId: o.id }, { toOrgId: o.id }], status: 'accepted' }, { limit: 200 });
  const pnames = partners.map(c => (c.fromOrgId === o.id ? { id: c.toOrgId, name: c.toOrgName } : { id: c.fromOrgId, name: c.fromOrgName }));
  const services = await db.col('services').find({ orgId: o.id, active: { $ne: false }, public: { $ne: false } }, { sort: { category: 1, name: 1 }, limit: 300 });
  const c = await connectionOf(req.ctx.org.id, o.id);
  res.json(Object.assign(publicOrg(o), { groupName: await groupName(o), sameGroup: !!(o.groupId && o.groupId === req.ctx.org.groupId), acceptsReferrals: (o.settings || {}).acceptsReferrals !== false, email: (o.contact || {}).email || null, address: (o.contact || {}).address || null,
    partners: pnames, services: services.map(s => ({ code: s.code, name: s.name, category: s.category, priceKobo: s.priceKobo })), connection: c ? { id: c.id, status: c.status, direction: c.fromOrgId === req.ctx.org.id ? 'out' : 'in' } : null }));
}));

/* ================= connections ================= */
function connView(c, me) { const out = c.fromOrgId === me; return { id: c.id, status: c.status, direction: out ? 'out' : 'in', orgId: out ? c.toOrgId : c.fromOrgId, orgName: out ? c.toOrgName : c.fromOrgName, note: c.note || null, createdAt: c.createdAt, decidedAt: c.decidedAt || null, byName: c.byName || null }; }
router.get('/network/connections', anyNet, ah(async (req, res) => {
  on();
  const me = req.ctx.org.id;
  const rows = await db.col('network_connections').find({ $or: [{ fromOrgId: me }, { toOrgId: me }], status: { $in: ['pending', 'accepted'] } }, { sort: { createdAt: -1 } });
  res.json(rows.map(c => connView(c, me)));
}));
router.post('/network/connections', manage, ah(async (req, res) => {
  on();
  const b = body(req, { toOrgId: t.id({ required: true }), note: t.str({ max: 300, plain: true }) });
  const me = req.ctx.org;
  const o = await db.col('orgs').findOne(Object.assign(listedFilter(me.id), { id: b.toOrgId }));
  if (!o) throw notFound('Provider not found');
  if (o.groupId && o.groupId === me.groupId) throw bad('Branches of your group already work together');
  const ex = await connectionOf(me.id, o.id);
  if (ex) {
    if (ex.status === 'accepted') throw conflict('You are already partners');
    if (ex.toOrgId === me.id) { const acc = await decide(req, ex, 'accepted'); return res.json(connView(acc, me.id)); } // they asked first: this accepts
    throw conflict('You have already asked to partner with this provider');
  }
  const c = { id: id('nc'), pairKey: pairKey(me.id, o.id), fromOrgId: me.id, fromOrgName: me.name, toOrgId: o.id, toOrgName: o.name, status: 'pending', note: b.note || null, createdAt: now(), by: req.ctx.user.id, byName: req.ctx.user.name };
  await db.col('network_connections').insertOne(c);
  await audit(req, 'network.connect_request', { type: 'network_connection', id: c.id }, { toOrgId: o.id });
  await notify({ orgId: o.id, role: 'admin', title: 'Partnership request', body: me.name + ' would like to partner with you on MediCore.', kind: 'network', ref: { type: 'network_connection', id: c.id } });
  await notify({ orgId: o.id, role: 'owner', title: 'Partnership request', body: me.name + ' would like to partner with you on MediCore.', kind: 'network', ref: { type: 'network_connection', id: c.id } });
  res.json(connView(c, me.id));
}));
async function decide(req, c, to) {
  const u = await db.col('network_connections').findOneAndUpdate({ id: c.id, status: c.status }, { $set: { status: to, decidedAt: now(), decidedBy: req.ctx.user.id } });
  if (!u) throw conflict('This request changed. Refresh and try again.');
  await audit(req, 'network.connect_' + to, { type: 'network_connection', id: c.id }, { other: c.fromOrgId === req.ctx.org.id ? c.toOrgId : c.fromOrgId });
  if (to === 'accepted') await notify({ orgId: c.fromOrgId === req.ctx.org.id ? c.toOrgId : c.fromOrgId, role: 'admin', title: 'Partnership accepted', body: req.ctx.org.name + ' accepted your partnership on MediCore.', kind: 'network', ref: { type: 'network_connection', id: c.id } });
  return u;
}
router.post('/network/connections/:id/:action', manage, ah(async (req, res) => {
  on();
  const action = req.params.action;
  if (!['accept', 'decline', 'end'].includes(action)) throw notFound();
  const me = req.ctx.org.id;
  const c = await db.col('network_connections').findOne({ id: param(req, 'id'), $or: [{ fromOrgId: me }, { toOrgId: me }] });
  if (!c) throw notFound('Request not found');
  if (action === 'accept') { if (c.status !== 'pending' || c.toOrgId !== me) throw conflict('Only a request sent to you can be accepted'); return res.json(connView(await decide(req, c, 'accepted'), me)); }
  if (action === 'decline') { if (c.status !== 'pending') throw conflict('This request is no longer pending'); return res.json(connView(await decide(req, c, c.toOrgId === me ? 'declined' : 'withdrawn'), me)); }
  if (c.status !== 'accepted') throw conflict('You are not partners');
  res.json(connView(await decide(req, c, 'ended'), me));
}));

/* ================= provider-to-provider messages ================= */
async function threadFor(orgA, orgB, extra) {
  const key = pairKey(orgA.id, orgB.id) + (extra && extra.referralId ? ':' + extra.referralId : '');
  let th = await db.col('network_threads').findOne({ pairKey: key });
  if (th) return th;
  th = Object.assign({ id: id('nth'), pairKey: key, orgIds: [orgA.id, orgB.id], orgNames: { [orgA.id]: orgA.name, [orgB.id]: orgB.name }, createdAt: now(), lastAt: now(), lastText: null, unread: { [orgA.id]: 0, [orgB.id]: 0 }, referralId: null, subject: null }, extra || {});
  await db.col('network_threads').insertOne(th);
  return th;
}
function threadView(th, me) { const other = th.orgIds.find(x => x !== me) || me; return { id: th.id, orgId: other, orgName: th.orgNames[other], referralId: th.referralId || null, subject: th.subject || null, lastAt: th.lastAt, lastText: th.lastText, unread: (th.unread || {})[me] || 0 }; }
async function postMessage(req, th, text, system) {
  const me = req.ctx.org.id;
  const other = th.orgIds.find(x => x !== me) || me;
  const m = { id: id('nm'), threadId: th.id, fromOrgId: me, fromUserId: system ? null : req.ctx.user.id, fromName: system ? null : req.ctx.user.name, fromRole: system ? null : req.ctx.role, text, system: !!system, at: now() };
  await db.col('network_messages').insertOne(m);
  await db.col('network_threads').updateOne({ id: th.id }, { $set: { lastAt: m.at, lastText: text.slice(0, 140) }, $inc: { ['unread.' + other]: 1 } });
  return m;
}
const msgG = (req) => { if (!S.feature('providerMessaging')) throw forbidden('Provider messaging is switched off'); };
router.get('/network/threads', anyNet, ah(async (req, res) => {
  on(); msgG(req);
  const rows = await db.col('network_threads').find({ orgIds: req.ctx.org.id }, { sort: { lastAt: -1 }, limit: 200 });
  const out = rows.map(th => threadView(th, req.ctx.org.id));
  res.json({ threads: out, unreadTotal: out.reduce((s, x) => s + x.unread, 0) });
}));
router.post('/network/threads', anyNet, ah(async (req, res) => {
  on(); msgG(req);
  const b = body(req, { toOrgId: t.id({ required: true }), text: t.text({ required: true, max: 2000 }) });
  const o = await db.col('orgs').findOne({ id: b.toOrgId, status: 'active' });
  if (!o || o.id === req.ctx.org.id) throw notFound('Provider not found');
  if (!(await arePartners(req.ctx.org.id, o.id))) throw forbidden('You can message partners and branches of your group. Send a partnership request first.');
  const th = await threadFor(req.ctx.org, o);
  await postMessage(req, th, b.text);
  await notify({ orgId: o.id, role: 'admin', title: 'Message from ' + req.ctx.org.name, body: 'Open Network > Messages to read it.', kind: 'network_message', ref: { type: 'network_thread', id: th.id } });
  await audit(req, 'network.message', { type: 'network_thread', id: th.id }, { toOrgId: o.id });
  res.json(threadView(await db.col('network_threads').findOne({ id: th.id }), req.ctx.org.id));
}));
async function myThread(req) { const th = await db.col('network_threads').findOne({ id: param(req, 'id'), orgIds: req.ctx.org.id }); if (!th) throw notFound('Conversation not found'); return th; }
router.get('/network/threads/:id/messages', anyNet, ah(async (req, res) => {
  on(); msgG(req);
  const th = await myThread(req);
  const rows = await db.col('network_messages').find({ threadId: th.id }, { sort: { at: 1 }, limit: 500 });
  await db.col('network_threads').updateOne({ id: th.id }, { $set: { ['unread.' + req.ctx.org.id]: 0 } });
  res.json({ thread: threadView(th, req.ctx.org.id), messages: rows.map(m => ({ id: m.id, mine: m.fromOrgId === req.ctx.org.id, fromOrgName: th.orgNames[m.fromOrgId], fromName: m.fromName, text: m.text, system: !!m.system, at: m.at })) });
}));
router.post('/network/threads/:id/messages', anyNet, ah(async (req, res) => {
  on(); msgG(req);
  const b = body(req, { text: t.text({ required: true, max: 2000 }) });
  const th = await myThread(req);
  const m = await postMessage(req, th, b.text);
  const other = th.orgIds.find(x => x !== req.ctx.org.id);
  if (other) await notify({ orgId: other, role: 'admin', title: 'Message from ' + req.ctx.org.name, body: 'Open Network > Messages to read it.', kind: 'network_message', ref: { type: 'network_thread', id: th.id } });
  res.json({ id: m.id, mine: true, text: m.text, at: m.at, fromName: m.fromName });
}));

/* ================= referrals ================= */
async function buildSnapshot(req, patient) {
  const vis = await P.visibleRecordFilter(req, patient.id);
  const encs = await db.col('encounters').find(Object.assign({}, vis, { status: 'completed' }), { sort: { startedAt: -1 }, limit: 5 });
  const orgNames = {}; const on2 = async oid => { if (!(oid in orgNames)) { const o = await db.col('orgs').findOne({ id: oid }, { projection: { name: 1 } }); orgNames[oid] = o ? o.name : null; } return orgNames[oid]; };
  const encounters = [];
  for (const e of encs) encounters.push({ date: new Date(e.startedAt + 3600e3).toISOString().slice(0, 10), orgName: await on2(e.orgId), doctorName: e.doctorName || null, complaint: (e.notes || {}).complaint || null, diagnoses: (e.diagnoses || []).map(d => ({ code: d.code || null, text: d.text, primary: !!d.primary })), plan: (e.notes || {}).plan || null });
  let meds = []; try { meds = (await require('./clinic/consult').currentMeds(req, patient.id)).map(m => ({ drugName: m.drugName, at: m.at })); } catch (e) { meds = []; }
  let labs = []; try { labs = ((await require('./lab').resultsForPatient(req, patient.id)) || []).slice(0, 8).map(r => ({ number: r.number || null, releasedAt: r.releasedAt || null, lab: r.lab ? r.lab.name : (r.labName || null), results: (Array.isArray(r.results) ? r.results : []).slice(0, 20).map(x => ({ name: x.name || x.code, value: x.value != null ? String(x.value) : null, unit: x.unit || null, flag: x.flag || null })) })); } catch (e) { labs = []; }
  const vit = await db.col('vitals').findOne(vis, { sort: { at: -1 } });
  return {
    at: now(), byOrgName: req.ctx.org.name,
    patient: { name: patient.firstName + ' ' + patient.lastName, dob: patient.dob || null, age: P.age(patient.dob), sex: patient.sex || null, phone: patient.phone || null, bloodGroup: patient.bloodGroup || null, genotype: patient.genotype || null, weightKg: patient.weightKg || null },
    allergies: (patient.allergies || []).map(a => ({ substance: a.substance, reaction: a.reaction || null, severity: a.severity || null })), noKnownAllergies: !!patient.noKnownAllergies,
    conditions: (patient.conditions || []).map(c => ({ name: c.name, code: c.code || null })), currentMedicines: meds, recentEncounters: encounters, recentLabResults: labs,
    lastVitals: vit ? { at: vit.at, bpSys: vit.bpSys || null, bpDia: vit.bpDia || null, pulse: vit.pulse || null, tempC: vit.tempC || null, spo2: vit.spo2 || null, respRate: vit.rr || null, weightKg: vit.weightKg || null, glucose: vit.glucose || null } : null,
  };
}
async function referralView(r, me, full) {
  const v = { id: r.id, number: r.number, direction: r.toOrgId === me ? 'in' : 'out', fromOrgId: r.fromOrgId, fromOrgName: r.fromOrgName, fromName: r.fromName, fromRoleLabel: r.fromRoleLabel || null, toOrgId: r.toOrgId, toOrgName: r.toOrgName,
    patientId: r.patientId, patientName: r.patientName, urgency: r.urgency, service: r.service, specialty: r.specialty || null, reason: r.reason, status: isOverdue(r) ? 'expired' : r.status, createdAt: r.createdAt, expiresAt: r.expiresAt || null,
    decidedAt: r.decidedAt || null, decidedByName: r.decidedByName || null, declineReason: r.declineReason || null, cancelReason: r.cancelReason || null, arrivedAt: r.arrivedAt || null, completedAt: r.completedAt || null, outcome: r.outcome || null, threadId: r.threadId || null, hmo: r.hmo || null, consent: r.consent || null };
  if (full) { v.clinicalNote = r.clinicalNote || null; v.snapshot = r.snapshot || null; v.timeline = r.timeline || []; v.receiverMrn = r.receiverMrn || null; v.queueId = r.queueId || null; }
  return v;
}
async function moveReferral(req, r, to, set, note) {
  const out = await moveReferral0(req, r, to, set, note);
  if (['accepted', 'declined', 'completed'].includes(to)) { try { await require('../lib/events').emit('referral.' + to, { referralId: r.id, fromOrgId: r.fromOrgId, toOrgId: r.toOrgId, urgency: r.urgency, service: r.service }); } catch (e) { /* best effort */ } }
  return out;
}
async function moveReferral0(req, r, to, set, note) {
  if (isOverdue(r) && to !== 'expired') { await db.col('referrals').updateOne({ id: r.id, status: 'sent' }, { $set: { status: 'expired', updatedAt: now() } }); throw conflict('This referral expired before anyone acted on it. Ask the referring provider to send a new one.', 'expired'); }
  if (!(TRANSITIONS[r.status] || []).includes(to)) throw conflict('This referral is ' + r.status + '; that is not possible now', 'wrong_state');
  const ev = { status: to, at: now(), by: req.ctx.user.id, byName: req.ctx.user.name, orgName: req.ctx.org.name, note: note || null };
  const u = await db.col('referrals').findOneAndUpdate({ id: r.id, status: r.status }, { $set: Object.assign({ status: to, updatedAt: now() }, set || {}), $push: { timeline: ev } });
  if (!u) throw conflict('This referral changed. Refresh and try again.');
  await audit(req, 'referral.' + to, { type: 'referral', id: r.id, patientId: r.patientId }, { from: r.status });
  return u;
}
const isOverdue = r => r.status === 'sent' && r.expiresAt && r.expiresAt < now();

router.post('/referrals', sendG, ah(async (req, res) => {
  on();
  const b = body(req, {
    patientId: t.id({ required: true }), toOrgId: t.id({ required: true }), urgency: t.enum(URGENCY, { required: true }), service: t.enum(SERVICES, { required: true }), specialty: t.str({ max: 80, plain: true }),
    reason: t.str({ required: true, min: 5, max: 500, label: 'Reason for referral' }), clinicalNote: t.text({ max: 3000 }), includeRecord: t.bool({ default: true }),
    consent: t.bool(), consentMethod: t.enum(['verbal', 'written', 'app', 'emergency']), coverageId: t.id(),
  });
  const me = req.ctx.org;
  const { patient } = await P.requireLinked(req, b.patientId);
  const to = await db.col('orgs').findOne({ id: b.toOrgId, status: 'active' });
  if (!to || to.type === 'hmo' || to.id === me.id) throw notFound('Provider not found');
  if ((to.settings || {}).acceptsReferrals === false) throw forbidden(to.name + ' is not accepting referrals on MediCore at the moment');
  const partners = await arePartners(me.id, to.id);
  if (!partners && (to.settings || {}).networkListed === false) throw notFound('Provider not found');
  if (!partners && (to.settings || {}).referralsFromPartnersOnly) throw forbidden(to.name + ' accepts referrals from its partners only. Send a partnership request first.');
  if (!partners && S.get('process.referrals.requireConnection', false)) throw forbidden('You can refer to partners and branches of your group. Send a partnership request first.');
  const needConsent = S.get('process.referrals.requirePatientConsent', true) !== false;
  if (needConsent && !b.consent && b.urgency !== 'emergency') throw bad('Confirm that the patient agrees to the referral and to sharing their record summary');
  await require('../lib/ratelimit').limit('referral_' + req.ctx.user.id, 120, 3600);
  let hmo = null;
  if (b.coverageId) {
    const c = await db.col('coverages').findOne({ id: b.coverageId, patientId: patient.id });
    if (!c) throw bad('That HMO cover does not belong to this patient');
    const payer = await db.col('orgs').findOne({ id: c.payerOrgId }, { projection: { name: 1 } });
    hmo = { coverageId: c.id, payerOrgId: c.payerOrgId, payerName: payer ? payer.name : null, memberNo: c.memberNo, planName: c.planName || null, status: c.status };
  } else {
    const c = await db.col('coverages').findOne({ patientId: patient.id, status: 'active' });
    if (c) { const payer = await db.col('orgs').findOne({ id: c.payerOrgId }, { projection: { name: 1 } }); hmo = { coverageId: c.id, payerOrgId: c.payerOrgId, payerName: payer ? payer.name : null, memberNo: c.memberNo, planName: c.planName || null, status: c.status }; }
  }
  const n = await nextNumber('referral');
  const days = Number(S.get('process.referrals.expireDays', 30)) || 30;
  const roles = require('../lib/roles').ROLES;
  const r = {
    id: id('ref'), number: 'RF' + String(n).padStart(6, '0'), fromOrgId: me.id, fromOrgName: me.name, fromGroupId: me.groupId || null, fromUserId: req.ctx.user.id, fromName: req.ctx.user.name, fromRole: req.ctx.role, fromRoleLabel: (roles[req.ctx.role] || {}).label || null,
    toOrgId: to.id, toOrgName: to.name, toGroupId: to.groupId || null, patientId: patient.id, patientName: patient.firstName + ' ' + patient.lastName,
    urgency: b.urgency, service: b.service, specialty: b.specialty || null, reason: b.reason, clinicalNote: b.clinicalNote || null,
    snapshot: b.includeRecord !== false ? await buildSnapshot(req, patient) : null, hmo,
    consent: { given: !!b.consent, method: b.consent ? (b.consentMethod || 'verbal') : (b.urgency === 'emergency' ? 'emergency' : null), recordedBy: req.ctx.user.id, at: now() },
    status: 'sent', createdAt: now(), updatedAt: now(), expiresAt: now() + days * 86400e3, timeline: [{ status: 'sent', at: now(), by: req.ctx.user.id, byName: req.ctx.user.name, orgName: me.name }],
  };
  const th = await threadFor(me, to, { referralId: r.id, subject: 'Referral ' + r.number });
  r.threadId = th.id;
  await db.col('referrals').insertOne(r);
  await audit(req, 'referral.sent', { type: 'referral', id: r.id, patientId: patient.id }, { toOrgId: to.id, urgency: r.urgency, service: r.service, includeRecord: !!r.snapshot });
  try { await require('../lib/events').emit('referral.sent', { referralId: r.id, fromOrgId: me.id, toOrgId: to.id, urgency: r.urgency, service: r.service }); } catch (e) { /* best effort */ }
  const title = (r.urgency === 'emergency' ? 'EMERGENCY referral from ' : r.urgency === 'urgent' ? 'Urgent referral from ' : 'Referral from ') + me.name;
  await notify({ orgId: to.id, role: '*', title, body: r.patientName + ': ' + r.reason.slice(0, 120), kind: 'referral', ref: { type: 'referral', id: r.id } });
  if (S.get('process.referrals.notifyPatient', true) !== false) await notify({ patientId: patient.id, title: 'You have been referred to ' + to.name, body: me.name + ' sent your referral. ' + to.name + ' will contact you or you can visit them.', kind: 'referral', ref: { type: 'referral', id: r.id } });
  res.json(await referralView(r, me.id, true));
}));
router.get('/referrals', A.requireStaff({ anyPerm: ['referral.send', 'referral.receive'] }), ah(async (req, res) => {
  on();
  const q = query(req, { box: t.enum(['in', 'out', 'all']), status: t.enum(Object.keys(TRANSITIONS)), patientId: t.id(), limit: t.int({ min: 1, max: 300 }) });
  const me = req.ctx.org.id;
  const box = q.box || 'in';
  const f = box === 'in' ? { toOrgId: me } : box === 'out' ? { fromOrgId: me } : { $or: [{ toOrgId: me }, { fromOrgId: me }] };
  if (box === 'in' && !A.has(req, 'referral.receive')) throw forbidden('Your role does not receive referrals');
  if (q.status) f.status = q.status; if (q.patientId) f.patientId = q.patientId;
  const rows = await db.col('referrals').find(f, { sort: { createdAt: -1 }, limit: q.limit || 100 });
  const urg = { emergency: 0, urgent: 1, routine: 2, elective: 3 };
  if (box === 'in' && !q.status) rows.sort((a, b) => ((a.status === 'sent' ? 0 : 1) - (b.status === 'sent' ? 0 : 1)) || (urg[a.urgency] - urg[b.urgency]) || (b.createdAt - a.createdAt));
  const out = []; for (const r of rows) out.push(await referralView(r, me, false));
  res.json({ referrals: out, counts: { newIn: await db.col('referrals').count({ toOrgId: me, status: 'sent', expiresAt: { $gte: now() } }) } });
}));
async function loadReferral(req) {
  const r = await db.col('referrals').findOne({ id: param(req, 'id') });
  const me = req.ctx.org.id;
  if (!r || (r.toOrgId !== me && r.fromOrgId !== me)) throw notFound('Referral not found');
  return r;
}
router.get('/referrals/:id', A.requireStaff({ anyPerm: ['referral.send', 'referral.receive'] }), ah(async (req, res) => {
  on();
  const r = await loadReferral(req);
  await audit(req, 'referral.view', { type: 'referral', id: r.id, patientId: r.patientId });
  res.json(await referralView(r, req.ctx.org.id, true));
}));
router.post('/referrals/:id/accept', recvG, ah(async (req, res) => {
  on();
  const b = body(req, { note: t.str({ max: 500 }) });
  const r = await loadReferral(req);
  if (r.toOrgId !== req.ctx.org.id) throw forbidden('Only the receiving provider can accept');
  const l = await P.ensureLink(req.ctx.org.id, r.patientId, req.ctx.user.id, 'referral', { referralId: r.id });
  const u = await moveReferral(req, r, 'accepted', { decidedAt: now(), decidedBy: req.ctx.user.id, decidedByName: req.ctx.user.name, receiverMrn: l.mrn, acceptNote: b.note || null }, b.note);
  const th = await db.col('network_threads').findOne({ id: r.threadId });
  if (th) await postMessage(req, th, 'Referral accepted by ' + req.ctx.org.name + (b.note ? ': ' + b.note : '.'), true);
  await notify({ orgId: r.fromOrgId, userId: null, role: '*', title: 'Referral accepted', body: req.ctx.org.name + ' accepted referral ' + r.number + ' for ' + r.patientName + '.', kind: 'referral', ref: { type: 'referral', id: r.id } });
  await notify({ userId: r.fromUserId, title: 'Referral accepted', body: req.ctx.org.name + ' accepted referral ' + r.number + '.', kind: 'referral', ref: { type: 'referral', id: r.id } });
  if (S.get('process.referrals.notifyPatient', true) !== false) await notify({ patientId: r.patientId, title: req.ctx.org.name + ' accepted your referral', body: (b.note || 'They will contact you to arrange your visit.') + ' Your record number there is ' + l.mrn + '.', kind: 'referral', ref: { type: 'referral', id: r.id } });
  res.json(await referralView(u, req.ctx.org.id, true));
}));
router.post('/referrals/:id/decline', recvG, ah(async (req, res) => {
  on();
  const b = body(req, { reason: t.str({ required: true, min: 5, max: 500, label: 'Reason' }), suggestOrgId: t.id() });
  const r = await loadReferral(req);
  if (r.toOrgId !== req.ctx.org.id) throw forbidden('Only the receiving provider can decline');
  const u = await moveReferral(req, r, 'declined', { decidedAt: now(), decidedBy: req.ctx.user.id, decidedByName: req.ctx.user.name, declineReason: b.reason, suggestOrgId: b.suggestOrgId || null }, b.reason);
  const th = await db.col('network_threads').findOne({ id: r.threadId });
  if (th) await postMessage(req, th, 'Referral declined: ' + b.reason, true);
  await notify({ userId: r.fromUserId, title: 'Referral declined', body: req.ctx.org.name + ' could not take referral ' + r.number + ': ' + b.reason, kind: 'referral', ref: { type: 'referral', id: r.id } });
  if (S.get('process.referrals.notifyPatient', true) !== false) await notify({ patientId: r.patientId, title: 'Referral update', body: req.ctx.org.name + ' could not take your referral. ' + r.fromOrgName + ' will advise you on next steps.', kind: 'referral', ref: { type: 'referral', id: r.id } });
  res.json(await referralView(u, req.ctx.org.id, true));
}));
router.post('/referrals/:id/arrived', recvG, ah(async (req, res) => {
  on();
  const b = body(req, { queue: t.bool({ default: true }) });
  const r = await loadReferral(req);
  if (r.toOrgId !== req.ctx.org.id) throw forbidden('Only the receiving provider records arrival');
  let queueId = null;
  if (b.queue !== false && (req.ctx.org.modules || []).includes('frontdesk')) {
    const q = { id: id('q'), orgId: req.ctx.org.id, patientId: r.patientId, appointmentId: null, servicePoint: 'triage', doctorMembershipId: null, priority: r.urgency === 'emergency' ? 'emergency' : r.urgency === 'urgent' ? 'urgent' : 'routine', status: 'waiting', at: now(), source: 'referral', referralId: r.id };
    await db.col('queue').insertOne(q); queueId = q.id;
  }
  const u = await moveReferral(req, r, 'arrived', { arrivedAt: now(), queueId });
  await notify({ userId: r.fromUserId, title: 'Referred patient arrived', body: r.patientName + ' arrived at ' + req.ctx.org.name + '.', kind: 'referral', ref: { type: 'referral', id: r.id } });
  res.json(await referralView(u, req.ctx.org.id, true));
}));
router.post('/referrals/:id/complete', recvG, ah(async (req, res) => {
  on();
  const b = body(req, { outcome: t.text({ required: true, min: 5, max: 2000, label: 'Outcome for the referring provider' }) });
  const r = await loadReferral(req);
  if (r.toOrgId !== req.ctx.org.id) throw forbidden('Only the receiving provider reports the outcome');
  const u = await moveReferral(req, r, 'completed', { completedAt: now(), outcome: b.outcome }, null);
  const th = await db.col('network_threads').findOne({ id: r.threadId });
  if (th) await postMessage(req, th, 'Outcome: ' + b.outcome, true);
  await notify({ userId: r.fromUserId, title: 'Referral outcome', body: req.ctx.org.name + ' reported the outcome of referral ' + r.number + '.', kind: 'referral', ref: { type: 'referral', id: r.id } });
  res.json(await referralView(u, req.ctx.org.id, true));
}));
router.post('/referrals/:id/cancel', sendG, ah(async (req, res) => {
  on();
  const b = body(req, { reason: t.str({ required: true, min: 5, max: 300 }) });
  const r = await loadReferral(req);
  if (r.fromOrgId !== req.ctx.org.id) throw forbidden('Only the referring provider can cancel');
  const u = await moveReferral(req, r, 'cancelled', { cancelReason: b.reason }, b.reason);
  await notify({ orgId: r.toOrgId, role: '*', title: 'Referral cancelled', body: r.fromOrgName + ' cancelled referral ' + r.number + '.', kind: 'referral', ref: { type: 'referral', id: r.id } });
  res.json(await referralView(u, req.ctx.org.id, true));
}));
router.post('/referrals/:id/messages', A.requireStaff({ anyPerm: ['referral.send', 'referral.receive'] }), ah(async (req, res) => {
  on(); msgG(req);
  const b = body(req, { text: t.text({ required: true, max: 2000 }) });
  const r = await loadReferral(req);
  const th = await db.col('network_threads').findOne({ id: r.threadId });
  if (!th) throw notFound('Conversation not found');
  const m = await postMessage(req, th, b.text);
  const other = r.toOrgId === req.ctx.org.id ? r.fromOrgId : r.toOrgId;
  await notify({ orgId: other, role: '*', title: 'Referral ' + r.number + ': new message', body: req.ctx.org.name + ' wrote about ' + r.patientName + '.', kind: 'referral', ref: { type: 'referral', id: r.id } });
  res.json({ id: m.id, mine: true, text: m.text, at: m.at, fromName: m.fromName });
}));

/* the patient sees their own referrals (no clinical note or record summary) */
router.get('/me/referrals', A.requirePatient, ah(async (req, res) => {
  const rows = await db.col('referrals').find({ patientId: req.ctx.patient.id }, { sort: { createdAt: -1 }, limit: 50 });
  res.json(rows.map(r => ({ id: r.id, number: r.number, fromOrgId: r.fromOrgId, fromOrgName: r.fromOrgName, toOrgId: r.toOrgId, toOrgName: r.toOrgName, urgency: r.urgency, service: r.service, reason: r.reason, status: r.status, createdAt: r.createdAt, decidedAt: r.decidedAt || null, declineReason: r.declineReason || null })));
}));

module.exports = { name: 'network', router, arePartners, buildSnapshot, URGENCY, SERVICES, TRANSITIONS };
