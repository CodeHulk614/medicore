'use strict';
/*
 * Patients: one identity per person, linked to every provider they use.
 *
 * Two ways in, same result:
 *   1. Self-registration in the patient app (phone verified by SMS code).
 *   2. A provider's front desk registers them. If the phone already belongs to a MediCore
 *      patient, the desk cannot see that record; it sends the patient a code and links only
 *      when the patient reads the code back (consent). Otherwise a new record is created and
 *      the patient can later claim it by signing up with the same phone.
 *
 * Privacy rule used everywhere: staff at provider X can see patient P only if P is linked to X.
 * Records created by OTHER providers are visible to X only if P has switched on sharing for X
 * (and only in 'open' patient mode; in 'provider' mode records move between providers only through referrals).
 *
 * Branches: a hospital group's branches are one data controller. A patient linked at one branch is a patient
 * of every branch (the link is created on first use, with the same group-wide record number), and staff at
 * any branch see records from all branches of the group (process.branches.shareRecordsAcrossBranches).
 *
 * Patient mode (HQ > Configuration > Processes > patients.mode, overridable per provider):
 *   provider (default)  patients join a provider by being registered there, or by applying in the app and being
 *                       approved by that provider. The patient app shows one provider at a time (X-MC-Provider
 *                       header) and never lists other providers' doctors or services.
 *   open                platform-wide directory and booking (needs PCN aggregator registration for pharmacy).
 */
const express = require('express');
const db = require('../db');
const config = require('../config');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param, normPhone } = require('../lib/http');
const A = require('../lib/auth');
const { id, now, maskPhone } = require('../lib/util');
const { audit } = require('../lib/audit');
const RL = require('../lib/ratelimit');
const otp = require('../lib/otp');
const { notify } = require('../lib/notify');
const { nextNumber } = require('./orgs');
const formulary = require('../clinical/formulary');
const S = require('../lib/settings');

db.index('patients', ['phone'], { unique: true, sparse: true });
db.index('patient_links', ['patientId', 'orgId'], { unique: true });
db.index('patient_links', ['orgId', 'mrn'], { unique: true });
db.index('patient_links', ['orgId', 'createdAt']);
db.index('consents', ['patientId', 'at']);
db.index('privacy_requests', ['status', 'at']);
db.index('patient_links', ['groupId', 'patientId']);
db.index('patient_applications', ['orgId', 'status', 'createdAt']);
db.index('patient_applications', ['patientId', 'createdAt']);

const router = express.Router();

/* ---------------- shared helpers (exported for every module) ---------------- */
const shareAcrossBranches = () => S.get('process.branches.shareRecordsAcrossBranches', true) !== false;
/** ids of every branch in this org's group (or just the org) */
async function groupOrgIds(org) {
  if (!org) return [];
  if (!org.groupId || !shareAcrossBranches()) return [org.id];
  const rows = await db.col('orgs').find({ groupId: org.groupId, status: { $nin: ['rejected', 'removed'] } }, { projection: { id: 1 } });
  const ids = rows.map(r => r.id); if (!ids.includes(org.id)) ids.push(org.id);
  return ids;
}
async function linkOf(orgId, patientId) {
  const l = await db.col('patient_links').findOne({ orgId, patientId, status: { $ne: 'removed' } });
  if (l || !shareAcrossBranches()) return l;
  const org = await db.col('orgs').findOne({ id: orgId }, { projection: { id: 1, groupId: 1 } });
  if (!org || !org.groupId) return null;
  const sib = await db.col('patient_links').findOne({ groupId: org.groupId, patientId, status: { $ne: 'removed' } });
  if (!sib) return null;
  // same company: the record follows the patient to every branch, with the same record number
  const nl = { id: id('pl'), patientId, orgId, groupId: org.groupId, mrn: sib.mrn, createdAt: now(), createdBy: null, via: 'branch', fromLinkId: sib.id, shareHistory: false, status: 'active' };
  try { await db.col('patient_links').insertOne(nl); } catch (e) { if (e.code === 11000) return db.col('patient_links').findOne({ orgId, patientId, status: { $ne: 'removed' } }); throw e; }
  return nl;
}
/** throws 404 unless the patient is linked to the caller's provider */
async function requireLinked(req, patientId) {
  const l = await linkOf(req.ctx.org.id, patientId);
  if (!l) throw notFound('Patient not found');
  const p = await db.col('patients').findOne({ id: patientId });
  if (!p || p.status === 'removed') throw notFound('Patient not found');
  return { link: l, patient: p };
}
/** creates the link if missing (used when a patient chooses a provider, e.g. sends a prescription to a pharmacy) */
async function ensureLink(orgId, patientId, createdBy, via, extra) {
  const existing = await linkOf(orgId, patientId);
  if (existing) return existing;
  const org = await db.col('orgs').findOne({ id: orgId });
  const group = org && org.groupId ? await db.col('groups').findOne({ id: org.groupId }) : null;
  // a group numbers records once for all its branches
  const n = await nextNumber('mrn_' + (group ? group.id : orgId));
  const prefix = group && group.mrnPrefix ? group.mrnPrefix : (org && org.mrnPrefix ? org.mrnPrefix : 'MC');
  const l = Object.assign({ id: id('pl'), patientId, orgId, mrn: prefix + '-' + String(n).padStart(6, '0'), createdAt: now(), createdBy: createdBy || null, via: via || 'staff', shareHistory: false, status: 'active' }, extra || {});
  if (group) l.groupId = group.id;
  try { await db.col('patient_links').insertOne(l); } catch (e) { if (e.code === 11000) return linkOf(orgId, patientId); throw e; }
  return l;
}
const patientMode = org => (S.get('process.patients.mode', 'provider', org) === 'open' ? 'open' : 'provider');
const crossSharingAllowed = org => patientMode(org) === 'open' || !!S.get('process.patients.crossProviderSharing', false, org);
/** can staff at orgId see clinical records that ANOTHER provider (outside its group) created for this patient? */
async function sharesWith(orgId, patientId) {
  const org = await db.col('orgs').findOne({ id: orgId });
  if (!crossSharingAllowed(org)) return false;
  const l = await linkOf(orgId, patientId); return !!(l && l.shareHistory);
}
/** Mongo-style filter for clinical records of a patient that the caller's org may see (own group always) */
async function visibleRecordFilter(req, patientId, orgField = 'orgId') {
  if (await sharesWith(req.ctx.org.id, patientId)) return { patientId };
  const ids = await groupOrgIds(req.ctx.org);
  return ids.length > 1 ? { patientId, [orgField]: { $in: ids } } : { patientId, [orgField]: req.ctx.org.id };
}

/* ---------------- patient scope (provider mode) ---------------- */
/** the providers a patient belongs to, one entry per standalone provider or per group (with its branches) */
async function patientProviders(patientId) {
  const links = await db.col('patient_links').find({ patientId, status: { $ne: 'removed' } });
  const out = []; const byGroup = {};
  for (const l of links) {
    const o = await db.col('orgs').findOne({ id: l.orgId });
    if (!o || o.status !== 'active') continue;
    if (o.groupId) {
      if (!byGroup[o.groupId]) {
        const g = await db.col('groups').findOne({ id: o.groupId });
        if (!g || g.status !== 'active') continue;
        const branches = await db.col('orgs').find({ groupId: g.id, status: 'active' }, { sort: { name: 1 } });
        byGroup[g.id] = { key: g.id, kind: 'group', name: g.name, mrn: l.mrn, linkedAt: l.createdAt, orgIds: shareAcrossBranches() ? branches.map(b => b.id) : [], modules: [...new Set(branches.flatMap(b => b.modules || []))],
          branches: branches.map(b => ({ orgId: b.id, name: b.name, branchName: b.branchName || b.name, area: (b.location || {}).area || null, modules: b.modules, phone: (b.contact || {}).phone || null })), logoUrl: g.logoUrl || null };
        out.push(byGroup[g.id]);
      }
      if (!byGroup[o.groupId].orgIds.includes(o.id)) byGroup[o.groupId].orgIds.push(o.id);
      // the branch where the patient was first registered (their "home" branch)
      if (l.via !== 'branch' && (!byGroup[o.groupId].homeAt || l.createdAt < byGroup[o.groupId].homeAt)) { byGroup[o.groupId].homeOrgId = o.id; byGroup[o.groupId].homeAt = l.createdAt; }
      byGroup[o.groupId].linkedAt = Math.min(byGroup[o.groupId].linkedAt, l.createdAt);
    } else out.push({ key: o.id, kind: 'org', name: o.name, mrn: l.mrn, linkedAt: l.createdAt, orgIds: [o.id], homeOrgId: o.id, modules: o.modules, type: o.type, branches: [{ orgId: o.id, name: o.name, branchName: o.name, area: (o.location || {}).area || null, modules: o.modules, phone: (o.contact || {}).phone || null }], shareHistory: !!l.shareHistory });
  }
  out.sort((a, b) => a.linkedAt - b.linkedAt);
  return out;
}
/** org ids whose records this patient request should LIST (the chosen provider), or null in open mode */
async function patientScope(req) {
  if (patientMode() === 'open') return null;
  if (req.ctx._scope !== undefined) return req.ctx._scope;
  const provs = await patientProviders(req.ctx.patient.id);
  const want = String(req.headers['x-mc-provider'] || '');
  const sel = want ? provs.find(p => p.key === want) : null;
  req.ctx._scope = sel ? sel.orgIds : [...new Set(provs.flatMap(p => p.orgIds))];
  return req.ctx._scope;
}
/** Mongo filter that limits a patient's lists to the chosen provider ({} in open mode) */
async function scopeFilter(req, field = 'orgId') {
  const ids = await patientScope(req);
  if (!ids) return {};
  if (Array.isArray(field)) return { $or: field.map(f => ({ [f]: { $in: ids } })) };
  return { [field]: { $in: ids } };
}
/** may this patient use (book, order from, message) this org? Any of their providers counts, not only the chosen one. */
async function patientCanUse(req, orgId) {
  if (patientMode() === 'open') return true;
  const provs = await patientProviders(req.ctx.patient.id);
  return provs.some(p => p.orgIds.includes(orgId));
}
const age = dob => { if (!dob) return null; const d = new Date(dob + 'T00:00:00Z'); const n = new Date(); let a = n.getUTCFullYear() - d.getUTCFullYear(); if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) a--; return a; };
/** what staff see: demographics + safety info, never the login */
function staffView(p, link) {
  return { id: p.id, mrn: link ? link.mrn : null, firstName: p.firstName, lastName: p.lastName, name: p.firstName + ' ' + p.lastName, dob: p.dob || null, age: age(p.dob), sex: p.sex || null,
    phone: p.phone || null, email: p.email || null, address: p.address || null, homeLoc: p.homeLoc || null, bloodGroup: p.bloodGroup || null, genotype: p.genotype || null,
    allergies: p.allergies || [], noKnownAllergies: !!p.noKnownAllergies, conditions: p.conditions || [], weightKg: p.weightKg || null, nokName: p.nokName || null, nokPhone: p.nokPhone || null,
    lang: p.lang || 'en', whatsappOptIn: !!p.whatsappOptIn, whatsapp: p.whatsapp || null, whatsappOptInAt: p.whatsappOptInAt || null, claimed: !!p.userId, shareHistory: link ? !!link.shareHistory : false, linkedAt: link ? link.createdAt : null };
}
function selfView(p) { const v = staffView(p, null); delete v.mrn; delete v.shareHistory; delete v.linkedAt; v.ussdPinSet = !!p.ussdPinHash; v.consent = p.consent || null; v.whatsapp = p.whatsapp || null; v.whatsappOptIn = !!p.whatsappOptIn; return v; }
async function patientName(patientId) { const p = await db.col('patients').findOne({ id: patientId }, { projection: { firstName: 1, lastName: 1 } }); return p ? p.firstName + ' ' + p.lastName : 'Patient'; }

const allergyRule = t.obj({ substance: t.str({ required: true, max: 80 }), reaction: t.str({ max: 120 }), severity: t.enum(['mild', 'moderate', 'severe', 'unknown']) });
function normAllergies(list, source) {
  return (list || []).map(a => ({ substance: a.substance, class: formulary.allergyClassOf(a.substance), reaction: a.reaction || null, severity: a.severity || 'unknown', source: source || 'staff', at: now() }));
}
const demographics = {
  firstName: t.str({ required: true, max: 60, label: 'First name', plain: true }), lastName: t.str({ required: true, max: 60, label: 'Last name', plain: true }),
  dob: t.date({ label: 'Date of birth' }), sex: t.enum(['female', 'male', 'other', 'unknown']),
  email: t.email(), address: t.str({ max: 300, plain: true }), homeLoc: t.obj({ lat: t.lat({ required: true }), lng: t.lng({ required: true }) }),
  bloodGroup: t.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown']), genotype: t.enum(['AA', 'AS', 'SS', 'AC', 'SC', 'unknown']),
  weightKg: t.num({ min: 0.3, max: 400 }), nokName: t.str({ max: 100, plain: true }), nokPhone: t.phone(),
  lang: t.enum(['en', 'pcm', 'yo', 'ha', 'ig']),
};

async function recordConsent(patientId, channel, accepted) {
  const c = { id: id('cs'), patientId, version: config.PRIVACY_NOTICE_VERSION, accepted: !!accepted, channel, at: now() };
  await db.col('consents').insertOne(c);
  await db.col('patients').updateOne({ id: patientId }, { $set: { consent: { version: c.version, accepted: c.accepted, at: c.at, channel } } });
}

/* ================= patient self-service ================= */
router.post('/patients/register/start', ah(async (req, res) => {
  const b = body(req, { phone: t.phone({ required: true }) });
  await RL.limitIp(req, 'psignup', 60, 3600);
  await RL.limit('psignup_ph_' + b.phone, 3, 3600);
  const u = await db.col('users').findOne({ phone: b.phone });
  if (u && u.patientId) throw conflict('This phone number already has a MediCore account. Sign in, or reset your password.', 'account_exists');
  const extra = await otp.issue('signup', b.phone, 'Your MediCore sign-up code is {code}');
  res.json(Object.assign({ ok: true }, extra));
}));

router.post('/patients/register', ah(async (req, res) => {
  const b = body(req, Object.assign({}, demographics, {
    phone: t.phone({ required: true }), code: t.str({ required: true, max: 6, label: 'SMS code' }),
    password: t.str({ required: true, trim: false, max: 128 }), consent: t.bool({ required: true }),
    allergies: t.arr(allergyRule, { max: 20 }), noKnownAllergies: t.bool(),
  }));
  if (!b.consent) throw bad('Please accept the privacy notice to create an account');
  A.checkPassword(b.password);
  await otp.verify('signup', b.phone, b.code);
  let user = await db.col('users').findOne({ phone: b.phone });
  if (user && user.patientId) throw conflict('This phone number already has a MediCore account. Sign in instead.', 'account_exists');
  if (b.email) { const e = await db.col('users').findOne({ email: b.email }); if (e && (!user || e.id !== user.id)) throw conflict('That email is already used by another account'); }

  // claim a record a provider created earlier for this phone, or make a new one
  let patient = await db.col('patients').findOne({ phone: b.phone });
  const fields = { firstName: b.firstName, lastName: b.lastName, dob: b.dob || null, sex: b.sex || 'unknown', email: b.email || null, address: b.address || null, homeLoc: b.homeLoc || null, lang: b.lang || 'en' };
  if (patient) {
    const set = {}; Object.entries(fields).forEach(([k, v]) => { if (v != null && !patient[k]) set[k] = v; });
    if (b.allergies && b.allergies.length) set.allergies = (patient.allergies || []).concat(normAllergies(b.allergies, 'patient'));
    await db.col('patients').updateOne({ id: patient.id }, { $set: Object.assign(set, { phoneVerified: true }) });
  } else {
    patient = Object.assign({ id: id('pat'), phone: b.phone, phoneVerified: true, status: 'active', createdAt: now(), createdVia: 'self', allergies: normAllergies(b.allergies, 'patient'), noKnownAllergies: !!b.noKnownAllergies, conditions: [] }, fields);
    await db.col('patients').insertOne(patient);
  }
  if (user) {
    await db.col('users').updateOne({ id: user.id }, { $set: { patientId: patient.id, phoneVerified: true } });
  } else {
    user = { id: id('usr'), name: b.firstName + ' ' + b.lastName, phone: b.phone, phoneVerified: true, passHash: await A.hashPassword(b.password), status: 'active', patientId: patient.id, createdAt: now() };
    if (b.email) user.email = b.email;
    await db.col('users').insertOne(user);
  }
  await db.col('patients').updateOne({ id: patient.id }, { $set: { userId: user.id } });
  await recordConsent(patient.id, 'self_signup', true);
  await A.createSession(res, { user, app: 'patient', req });
  req.ctx.user = user;
  await audit(req, 'patient.self_register', { type: 'patient', id: patient.id, patientId: patient.id, orgId: null }, { claimedExisting: patient.createdVia !== 'self' });
  res.json({ ok: true, patientId: patient.id });
}));

router.get('/me/profile', A.requirePatient, ah(async (req, res) => { res.json(selfView(req.ctx.patient)); }));
router.patch('/me/profile', A.requirePatient, ah(async (req, res) => {
  const rules = Object.assign({}, demographics); rules.firstName = t.str({ max: 60, plain: true }); rules.lastName = t.str({ max: 60, plain: true });
  const b = body(req, Object.assign(rules, { addAllergies: t.arr(allergyRule, { max: 10 }), noKnownAllergies: t.bool() }));
  const upd = { $set: {} };
  for (const k of Object.keys(demographics)) if (b[k] !== undefined) upd.$set[k] = b[k];
  if (b.noKnownAllergies !== undefined) upd.$set.noKnownAllergies = b.noKnownAllergies;
  if (b.email) { const e = await db.col('users').findOne({ email: b.email }); if (e && e.id !== req.ctx.user.id) throw conflict('That email is already used by another account'); await db.col('users').updateOne({ id: req.ctx.user.id }, { $set: { email: b.email } }); }
  if (b.addAllergies && b.addAllergies.length) upd.$push = { allergies: { $each: normAllergies(b.addAllergies, 'patient') } };
  if (!Object.keys(upd.$set).length) delete upd.$set;
  if (!upd.$set && !upd.$push) throw bad('Nothing to change');
  const p = await db.col('patients').findOneAndUpdate({ id: req.ctx.patient.id }, upd);
  await audit(req, 'patient.profile_update', { type: 'patient', id: p.id, patientId: p.id, orgId: null }, { fields: Object.keys(b) });
  res.json(selfView(p));
}));

/* providers this patient is linked to, and the sharing switch for each */
router.get('/me/providers', A.requirePatient, ah(async (req, res) => {
  const links = await db.col('patient_links').find({ patientId: req.ctx.patient.id, status: { $ne: 'removed' } });
  const out = [];
  for (const l of links) { const o = await db.col('orgs').findOne({ id: l.orgId }); if (o) out.push({ orgId: o.id, name: o.name, type: o.type, groupId: o.groupId || null, mrn: l.mrn, shareHistory: !!l.shareHistory, linkedAt: l.createdAt, via: l.via }); }
  res.json(out);
}));
/* the patient app's provider switcher: one entry per provider or hospital group, plus the mode */
router.get('/me/providers/summary', A.requirePatient, ah(async (req, res) => {
  const providers = await patientProviders(req.ctx.patient.id);
  const pending = await db.col('patient_applications').find({ patientId: req.ctx.patient.id, status: 'pending' }, { sort: { createdAt: -1 } });
  const apps = []; for (const a of pending) apps.push(await applicationView(a, false));
  res.json({ mode: patientMode(), allowMultipleProviders: S.get('process.patients.allowMultipleProviders', true) !== false, crossProviderSharing: crossSharingAllowed(null), providers, pendingApplications: apps });
}));
/* providers this patient's provider works with (same group or accepted network partners), e.g. to send a prescription */
router.get('/me/partners', A.requirePatient, ah(async (req, res) => {
  const q = query(req, { module: t.enum(['pharmacy', 'lab', 'clinic', 'ambulance', 'delivery']), lat: t.lat(), lng: t.lng() });
  const { publicOrg } = require('./orgs');
  const scope = await patientScope(req);
  let ids;
  if (!scope) ids = null; // open mode: everything listed
  else {
    ids = new Set(scope);
    const conns = await db.col('network_connections').find({ status: 'accepted', $or: [{ fromOrgId: { $in: scope } }, { toOrgId: { $in: scope } }] });
    conns.forEach(c => { ids.add(c.fromOrgId); ids.add(c.toOrgId); });
    ids = [...ids];
  }
  const f = { status: 'active', type: { $ne: 'hmo' } }; if (ids) f.id = { $in: ids }; if (q.module) f.modules = q.module;
  const rows = await db.col('orgs').find(f, { limit: 300 });
  const from = q.lat != null && q.lng != null ? { lat: q.lat, lng: q.lng } : null;
  const out = rows.map(o => Object.assign(publicOrg(o, from), { yours: !scope || scope.includes(o.id), partner: !!scope && !scope.includes(o.id) }));
  out.sort((a, b) => (b.yours - a.yours) || ((a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)) || a.name.localeCompare(b.name));
  res.json(out);
}));
router.post('/me/providers/:orgId/share', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { share: t.bool({ required: true }) });
  if (!crossSharingAllowed(null)) throw forbidden('Sharing records between providers is switched off. Your records move to another provider only when one refers you.');
  const l = await db.col('patient_links').findOneAndUpdate({ patientId: req.ctx.patient.id, orgId: param(req, 'orgId') }, { $set: { shareHistory: b.share, shareChangedAt: now() } });
  if (!l) throw notFound('You are not linked to that provider');
  await audit(req, b.share ? 'patient.share_on' : 'patient.share_off', { type: 'link', id: l.id, patientId: l.patientId, orgId: l.orgId });
  res.json({ ok: true, shareHistory: l.shareHistory });
}));
/* patient joins a provider themselves (e.g. registering with a pharmacy before ordering) */
router.post('/me/providers/:orgId/join', A.requirePatient, ah(async (req, res) => {
  const o = await db.col('orgs').findOne({ id: param(req, 'orgId'), status: 'active' });
  if (!o || o.type === 'hmo') throw notFound('Provider not found');
  if (patientMode(o) === 'provider') { const r = await applyTo(req, o, null); return res.json(r); }
  const l = await ensureLink(o.id, req.ctx.patient.id, req.ctx.user.id, 'patient');
  await audit(req, 'patient.join_provider', { type: 'link', id: l.id, patientId: l.patientId, orgId: o.id });
  res.json({ ok: true, mrn: l.mrn });
}));

/* ---------------- patient applications (provider mode) ----------------
 * A patient asks to be registered with a provider (or a hospital group, choosing a branch). The provider's
 * front desk approves (creates the link, group-wide record number) or declines with a reason.
 */
async function applicationView(a, forStaff) {
  const o = await db.col('orgs').findOne({ id: a.orgId });
  const g = a.groupId ? await db.col('groups').findOne({ id: a.groupId }) : null;
  const v = { id: a.id, number: a.number, orgId: a.orgId, orgName: o ? o.name : null, groupId: a.groupId || null, groupName: g ? g.name : null, status: a.status, note: a.note || null, reason: a.reason || null, createdAt: a.createdAt, decidedAt: a.decidedAt || null, expiresAt: a.expiresAt || null };
  if (forStaff) {
    const p = await db.col('patients').findOne({ id: a.patientId });
    if (p) v.patient = { id: p.id, name: p.firstName + ' ' + p.lastName, firstName: p.firstName, lastName: p.lastName, dob: p.dob || null, age: age(p.dob), sex: p.sex || null, phone: p.phone || null, email: p.email || null, address: p.address || null, lang: p.lang || 'en', phoneVerified: !!p.phoneVerified };
    v.decidedByName = a.decidedByName || null;
  }
  return v;
}
async function applyTo(req, org, note) {
  const pid = req.ctx.patient.id;
  if (org.type === 'hmo') throw bad('HMOs do not register patients this way. Add your HMO cover in Settings.');
  if ((org.settings || {}).acceptsPatientApplications === false) throw forbidden(org.name + ' registers new patients at its front desk only. Visit them to register.');
  if (await linkOf(org.id, pid)) throw conflict('You are already registered with ' + org.name, 'already_linked');
  const provs = await patientProviders(pid);
  if (S.get('process.patients.allowMultipleProviders', true, org) === false && provs.length) throw forbidden('You can be registered with one provider at a time on this platform.');
  const dup = await db.col('patient_applications').findOne({ patientId: pid, status: 'pending', $or: [{ orgId: org.id }].concat(org.groupId ? [{ groupId: org.groupId }] : []) });
  if (dup) throw conflict('You already have an application waiting with this provider', 'application_pending');
  await RL.limit('papply_' + pid, 10, 86400);
  const n = await nextNumber('papp');
  const days = Number(S.get('process.patients.applicationExpiryDays', 30, org)) || 30;
  const a = { id: id('pa'), number: 'PA' + String(n).padStart(6, '0'), patientId: pid, orgId: org.id, groupId: org.groupId || null, status: 'pending', note: note || null, createdAt: now(), expiresAt: now() + days * 86400e3 };
  const needApproval = typeof (org.settings || {}).applicationsNeedApproval === 'boolean' ? org.settings.applicationsNeedApproval : S.get('process.patients.applicationsNeedApproval', true, org) !== false;
  if (!needApproval) {
    const l = await ensureLink(org.id, pid, req.ctx.user.id, 'application');
    Object.assign(a, { status: 'approved', decidedAt: now(), decidedBy: 'auto', linkId: l.id });
    await db.col('patient_applications').insertOne(a);
    await audit(req, 'patient.application_auto', { type: 'patient_application', id: a.id, patientId: pid, orgId: org.id });
    return { ok: true, approved: true, application: await applicationView(a, false), mrn: l.mrn };
  }
  await db.col('patient_applications').insertOne(a);
  await audit(req, 'patient.application', { type: 'patient_application', id: a.id, patientId: pid, orgId: org.id });
  try { await require('../lib/events').emit('patient.application', { applicationId: a.id, orgId: org.id, groupId: org.groupId || null }); } catch (e) { /* best effort */ }
  for (const role of ['receptionist', 'records', 'frontdesk_manager']) await notify({ orgId: org.id, role, title: 'New patient application', body: 'A patient asked to register with you in the app. Review it in Front desk > Applications.', kind: 'patient_application', ref: { type: 'patient_application', id: a.id } });
  return { ok: true, approved: false, application: await applicationView(a, false), message: 'Your application has been sent to ' + org.name + '. You will be notified when they approve it.' };
}
router.post('/me/applications', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { orgId: t.id({ required: true }), note: t.str({ max: 300, plain: true }) });
  const o = await db.col('orgs').findOne({ id: b.orgId, status: 'active' });
  if (!o) throw notFound('Provider not found');
  if (o.groupId) { const g = await db.col('groups').findOne({ id: o.groupId }); if (!g || g.status !== 'active') throw notFound('Provider not found'); }
  res.json(await applyTo(req, o, b.note));
}));
router.get('/me/applications', A.requirePatient, ah(async (req, res) => {
  const rows = await db.col('patient_applications').find({ patientId: req.ctx.patient.id }, { sort: { createdAt: -1 }, limit: 50 });
  const out = []; for (const a of rows) out.push(await applicationView(a, false)); res.json(out);
}));
router.post('/me/applications/:id/cancel', A.requirePatient, ah(async (req, res) => {
  const a = await db.col('patient_applications').findOneAndUpdate({ id: param(req, 'id'), patientId: req.ctx.patient.id, status: 'pending' }, { $set: { status: 'cancelled', decidedAt: now() } });
  if (!a) throw conflict('This application is no longer pending');
  await audit(req, 'patient.application_cancel', { type: 'patient_application', id: a.id, patientId: a.patientId, orgId: a.orgId });
  res.json(await applicationView(a, false));
}));
/* providers a patient can apply to (public; no patient data). Groups appear once, with their branches. */
router.get('/join/providers', ah(async (req, res) => {
  const q = query(req, { q: t.str({ max: 60 }), type: t.enum(['hospital', 'clinic', 'pharmacy', 'ambulance', 'lab', 'other']), lat: t.lat(), lng: t.lng(), limit: t.int({ min: 1, max: 100 }) });
  const { publicOrg } = require('./orgs');
  const f = { status: 'active', type: { $ne: 'hmo' }, 'settings.acceptsPatientApplications': { $ne: false } }; if (q.type) f.type = q.type;
  let rows = await db.col('orgs').find(f, { limit: 1000 });
  const groups = {}; const from = q.lat != null && q.lng != null ? { lat: q.lat, lng: q.lng } : null;
  const out = [];
  for (const o of rows) {
    if (o.groupId) {
      if (!(o.groupId in groups)) { const g = await db.col('groups').findOne({ id: o.groupId, status: 'active' }); groups[o.groupId] = g ? { kind: 'group', id: g.id, name: g.name, type: o.type, branches: [] } : null; if (groups[o.groupId]) out.push(groups[o.groupId]); }
      if (groups[o.groupId]) groups[o.groupId].branches.push(Object.assign(publicOrg(o, from), { branchName: o.branchName || o.name }));
    } else out.push(Object.assign({ kind: 'org' }, publicOrg(o, from), { branches: [Object.assign(publicOrg(o, from), { branchName: o.name })] }));
  }
  for (const g of out) { g.distanceKm = g.branches.reduce((m, b) => (b.distanceKm != null && (m == null || b.distanceKm < m) ? b.distanceKm : m), null); g.area = (g.branches[0] || {}).area || null; g.city = (g.branches[0] || {}).city || null; }
  let list = out;
  if (q.q) { const s2 = q.q.toLowerCase(); list = list.filter(x => x.name.toLowerCase().includes(s2) || x.branches.some(b => (b.branchName || '').toLowerCase().includes(s2) || (b.area || '').toLowerCase().includes(s2) || (b.city || '').toLowerCase().includes(s2))); }
  if (from) list.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)); else list.sort((a, b) => a.name.localeCompare(b.name));
  res.json(list.slice(0, q.limit || 50));
}));

/* NDPA rights: export everything, ask for deletion or correction */
const PATIENT_COLLECTIONS = ['appointments', 'encounters', 'prescriptions', 'rx_orders', 'deliveries', 'lab_orders', 'bills', 'payments', 'coverages', 'preauths', 'claims', 'incidents', 'messages', 'chw_visits', 'vitals', 'consents', 'notifications'];
router.get('/me/export', A.requirePatient, ah(async (req, res) => {
  await RL.limit('export_' + req.ctx.patient.id, 5, 3600);
  const pid = req.ctx.patient.id;
  const out = { exportedAt: new Date().toISOString(), format: 'MediCore patient export v1', profile: selfView(req.ctx.patient), providers: await db.col('patient_links').find({ patientId: pid }) };
  for (const c of PATIENT_COLLECTIONS) out[c] = await db.col(c).find({ patientId: pid }, { projection: { codeHash: 0, pickupCodeHash: 0, deliveryCodeHash: 0 } });
  await audit(req, 'patient.export', { type: 'patient', id: pid, patientId: pid, orgId: null });
  res.setHeader('Content-Disposition', 'attachment; filename="medicore-my-data.json"');
  res.json(out);
}));
router.post('/me/privacy-request', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { type: t.enum(['delete', 'correct', 'restrict', 'object'], { required: true }), note: t.text({ max: 1000 }) });
  const r = { id: id('pr'), patientId: req.ctx.patient.id, type: b.type, note: b.note || null, status: 'open', at: now(), dueAt: now() + 30 * 86400e3 };
  await db.col('privacy_requests').insertOne(r);
  await audit(req, 'patient.privacy_request', { type: 'privacy_request', id: r.id, patientId: r.patientId, orgId: null }, { kind: b.type });
  res.json({ ok: true, request: r, message: 'We have received your request and will respond within 30 days.' });
}));
router.get('/me/privacy-requests', A.requirePatient, ah(async (req, res) => { res.json(await db.col('privacy_requests').find({ patientId: req.ctx.patient.id }, { sort: { at: -1 } })); }));
router.post('/me/ussd-pin', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { pin: t.str({ required: true, pattern: /^\d{4}$/, label: 'PIN' }), password: t.str({ required: true, trim: false, max: 128 }) });
  if (!(await A.verifyPassword(b.password, req.ctx.user.passHash))) throw bad('Your password is not correct');
  if (/^(\d)\1{3}$|^1234$|^4321$/.test(b.pin)) throw bad('Choose a less obvious PIN');
  await db.col('patients').updateOne({ id: req.ctx.patient.id }, { $set: { ussdPinHash: await A.hashPassword('ussd:' + b.pin), ussdPinFails: 0 } });
  await audit(req, 'patient.ussd_pin', { type: 'patient', id: req.ctx.patient.id, patientId: req.ctx.patient.id, orgId: null });
  res.json({ ok: true });
}));
router.get('/me/notifications', A.requirePatient, ah(async (req, res) => {
  res.json(await db.col('notifications').find({ patientId: req.ctx.patient.id }, { sort: { at: -1 }, limit: 100 }));
}));
router.post('/me/notifications/read', A.requirePatient, ah(async (req, res) => {
  await db.col('notifications').updateMany({ patientId: req.ctx.patient.id, read: false }, { $set: { read: true } }); res.json({ ok: true });
}));

/* ================= front desk: register / link / search ================= */
const fd = perm => A.requireStaff({ perm });

router.post('/fd/patients/lookup', fd('patient.register'), ah(async (req, res) => {
  const b = body(req, { phone: t.phone({ required: true }) });
  await RL.limit('fdlookup_' + req.ctx.user.id, 60, 3600);
  const p = await db.col('patients').findOne({ phone: b.phone });
  if (!p) return res.json({ status: 'new' });
  const l = await linkOf(req.ctx.org.id, p.id);
  if (l) { await audit(req, 'patient.view', { type: 'patient', id: p.id, patientId: p.id }); return res.json({ status: 'linked', patient: staffView(p, l) }); }
  // exists on MediCore but not with this provider: the desk sees nothing until the patient consents
  const extra = await otp.issue('link:' + req.ctx.org.id, b.phone, req.ctx.org.name + ' wants to open your MediCore record. Give them this code only if you agree: {code}');
  await audit(req, 'patient.link_requested', { type: 'patient', id: p.id, patientId: p.id });
  res.json(Object.assign({ status: 'exists_elsewhere', message: 'This person already has a MediCore record. We have sent them a code by SMS. Ask them for it to link their record to your provider.' }, extra));
}));
router.post('/fd/patients/link', fd('patient.register'), ah(async (req, res) => {
  const b = body(req, { phone: t.phone({ required: true }), code: t.str({ required: true, max: 6 }) });
  const p = await db.col('patients').findOne({ phone: b.phone });
  if (!p) throw notFound('Patient not found');
  await otp.verify('link:' + req.ctx.org.id, b.phone, b.code);
  const l = await ensureLink(req.ctx.org.id, p.id, req.ctx.user.id, 'consent_code');
  await audit(req, 'patient.linked', { type: 'patient', id: p.id, patientId: p.id });
  if (p.userId) await notify({ patientId: p.id, title: 'Linked to ' + req.ctx.org.name, body: 'You can choose whether they see your records from other providers in Settings.', kind: 'link' });
  res.json({ ok: true, patient: staffView(p, l) });
}));
router.post('/fd/patients', fd('patient.register'), ah(async (req, res) => {
  const b = body(req, Object.assign({}, demographics, { phone: t.phone({ label: 'Phone' }), allergies: t.arr(allergyRule, { max: 20 }), noKnownAllergies: t.bool(), consent: t.bool({ required: true }) }));
  if (!b.consent) throw bad('The patient must agree to the privacy notice before registration');
  if (b.phone) { const ex = await db.col('patients').findOne({ phone: b.phone }); if (ex) throw conflict('This phone number already has a MediCore record. Use "Find patient" to link it with the patient\'s code.', 'patient_exists'); }
  const p = { id: id('pat'), firstName: b.firstName, lastName: b.lastName, dob: b.dob || null, sex: b.sex || 'unknown', phone: b.phone || undefined, email: b.email || null, address: b.address || null, homeLoc: b.homeLoc || null,
    bloodGroup: b.bloodGroup || null, genotype: b.genotype || null, weightKg: b.weightKg || null, nokName: b.nokName || null, nokPhone: b.nokPhone || null,
    allergies: normAllergies(b.allergies, 'staff'), noKnownAllergies: !!b.noKnownAllergies, conditions: [], status: 'active', createdAt: now(), createdVia: 'provider', createdByOrg: req.ctx.org.id, userId: null };
  if (!p.phone) delete p.phone;
  await db.col('patients').insertOne(p);
  const l = await ensureLink(req.ctx.org.id, p.id, req.ctx.user.id, 'registered');
  await recordConsent(p.id, 'front_desk:' + req.ctx.org.id, true);
  await audit(req, 'patient.register', { type: 'patient', id: p.id, patientId: p.id });
  try { await require('../lib/events').emit('patient.registered', { orgId: req.ctx.org.id, patientId: p.id }); } catch (e) { /* best effort */ }
  if (p.phone) await notify({ patientId: p.id, title: 'Welcome to MediCore', body: req.ctx.org.name + ' registered you. Download the MediCore app and sign up with this number to see your records.', sms: p.phone, kind: 'welcome' });
  res.json({ ok: true, patient: staffView(p, l) });
}));
const appsGuard = A.requireStaff({ perm: 'patient.applications' });
router.get('/fd/applications', appsGuard, ah(async (req, res) => {
  const q = query(req, { status: t.enum(['pending', 'approved', 'declined', 'cancelled', 'expired']), limit: t.int({ min: 1, max: 200 }) });
  // no writes in a GET: an overdue pending application is shown as expired and cannot be approved
  const st = q.status || 'pending';
  const f = { orgId: req.ctx.org.id };
  if (st === 'pending') Object.assign(f, { status: 'pending', $or: [{ expiresAt: { $gte: now() } }, { expiresAt: null }, { expiresAt: { $exists: false } }] });
  else if (st === 'expired') f.$or = [{ status: 'expired' }, { status: 'pending', expiresAt: { $lt: now() } }];
  else f.status = st;
  const rows = await db.col('patient_applications').find(f, { sort: { createdAt: st !== 'pending' ? -1 : 1 }, limit: q.limit || 100 });
  const out = []; for (const a of rows) { const v = await applicationView(a, true); if (a.status === 'pending' && a.expiresAt && a.expiresAt < now()) v.status = 'expired'; out.push(v); } res.json(out);
}));
router.post('/fd/applications/:id/approve', appsGuard, ah(async (req, res) => {
  const a0 = await db.col('patient_applications').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!a0) throw notFound('Application not found');
  if (a0.status === 'pending' && a0.expiresAt && a0.expiresAt < now()) { await db.col('patient_applications').updateOne({ id: a0.id, status: 'pending' }, { $set: { status: 'expired' } }); throw conflict('This application has expired. Ask the patient to apply again or register them at the desk.'); }
  const a = await db.col('patient_applications').findOneAndUpdate({ id: a0.id, orgId: req.ctx.org.id, status: 'pending' }, { $set: { status: 'approved', decidedAt: now(), decidedBy: req.ctx.user.id, decidedByName: req.ctx.user.name } });
  if (!a) throw conflict('This application is already ' + a0.status);
  const l = await ensureLink(req.ctx.org.id, a.patientId, req.ctx.user.id, 'application');
  await db.col('patient_applications').updateOne({ id: a.id }, { $set: { linkId: l.id } });
  await audit(req, 'patient.application_approve', { type: 'patient_application', id: a.id, patientId: a.patientId });
  try { await require('../lib/events').emit('patient.application_approved', { applicationId: a.id, orgId: req.ctx.org.id, patientId: a.patientId }); } catch (e) { /* best effort */ }
  await notify({ patientId: a.patientId, title: 'Welcome to ' + req.ctx.org.name, body: 'Your registration was approved. Your record number is ' + l.mrn + '.', kind: 'patient_application', ref: { type: 'patient_application', id: a.id } });
  const p = await db.col('patients').findOne({ id: a.patientId });
  res.json({ ok: true, application: await applicationView(await db.col('patient_applications').findOne({ id: a.id }), true), patient: staffView(p, l) });
}));
router.post('/fd/applications/:id/decline', appsGuard, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 5, max: 300, label: 'Reason' }) });
  const a = await db.col('patient_applications').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id, status: 'pending' }, { $set: { status: 'declined', reason: b.reason, decidedAt: now(), decidedBy: req.ctx.user.id, decidedByName: req.ctx.user.name } });
  if (!a) throw conflict('This application is no longer pending');
  await audit(req, 'patient.application_decline', { type: 'patient_application', id: a.id, patientId: a.patientId }, { reason: b.reason });
  await notify({ patientId: a.patientId, title: req.ctx.org.name + ' could not approve your registration', body: b.reason, kind: 'patient_application', ref: { type: 'patient_application', id: a.id } });
  res.json(await applicationView(a, true));
}));

router.get('/fd/patients', A.requireStaff({ perm: 'patient.read' }), ah(async (req, res) => {
  const q = query(req, { q: t.str({ max: 60 }), limit: t.int({ min: 1, max: 200 }) });
  // a branch sees its own patients; a search also finds patients registered at other branches of the group
  const gf = q.q && req.ctx.org.groupId && shareAcrossBranches() ? { groupId: req.ctx.org.groupId } : { orgId: req.ctx.org.id };
  let links = await db.col('patient_links').find(Object.assign(gf, { status: { $ne: 'removed' } }), { sort: { createdAt: -1 }, limit: 5000 });
  if (gf.groupId) { const seen = new Set(); links = links.filter(l => { if (seen.has(l.patientId)) return false; seen.add(l.patientId); return true; }); }
  const ids = links.map(l => l.patientId);
  const byId = Object.fromEntries(links.map(l => [l.patientId, l]));
  let ps = ids.length ? await db.col('patients').find({ id: { $in: ids }, status: { $ne: 'removed' } }) : [];
  if (q.q) {
    const s = q.q.toLowerCase(); const ph = normPhone(q.q);
    ps = ps.filter(p => (p.firstName + ' ' + p.lastName).toLowerCase().includes(s) || (ph && p.phone === ph) || (byId[p.id].mrn || '').toLowerCase() === s);
  }
  res.json(ps.slice(0, q.limit || 50).map(p => staffView(p, byId[p.id])));
}));
router.get('/fd/patients/:id', A.requireStaff({ perm: 'patient.read' }), ah(async (req, res) => {
  const { patient, link } = await requireLinked(req, param(req, 'id'));
  await audit(req, 'patient.view', { type: 'patient', id: patient.id, patientId: patient.id });
  res.json(staffView(patient, link));
}));
router.patch('/fd/patients/:id', A.requireStaff({ anyPerm: ['patient.register', 'vitals.record', 'clinic.consult'] }), ah(async (req, res) => {
  const { patient } = await requireLinked(req, param(req, 'id'));
  const rules = Object.assign({}, demographics); rules.firstName = t.str({ max: 60, plain: true }); rules.lastName = t.str({ max: 60, plain: true });
  const b = body(req, Object.assign(rules, { phone: t.phone(), addAllergies: t.arr(allergyRule, { max: 10 }), noKnownAllergies: t.bool(),
    addConditions: t.arr(t.obj({ name: t.str({ required: true, max: 120 }), code: t.str({ max: 12 }) }), { max: 10 }) }));
  const upd = { $set: {} };
  const canDemog = A.has(req, 'patient.register');
  for (const k of Object.keys(demographics)) if (b[k] !== undefined) { if (!canDemog && !['weightKg', 'bloodGroup', 'genotype'].includes(k)) throw forbidden('Your role cannot change patient details'); upd.$set[k] = b[k]; }
  if (b.phone && b.phone !== patient.phone) {
    if (!canDemog) throw forbidden('Your role cannot change patient details');
    if (patient.userId) throw forbidden('This patient manages their own phone number in the MediCore app');
    if (await db.col('patients').findOne({ phone: b.phone })) throw conflict('That phone number belongs to another MediCore record');
    upd.$set.phone = b.phone;
  }
  if (b.noKnownAllergies !== undefined) upd.$set.noKnownAllergies = b.noKnownAllergies;
  const push = {};
  if (b.addAllergies && b.addAllergies.length) push.allergies = { $each: normAllergies(b.addAllergies, 'staff:' + req.ctx.org.id) };
  if (b.addConditions && b.addConditions.length) { if (!A.has(req, 'clinic.consult')) throw forbidden('Only clinicians record diagnoses'); push.conditions = { $each: b.addConditions.map(c => Object.assign({ at: now(), orgId: req.ctx.org.id }, c)) }; }
  if (Object.keys(push).length) upd.$push = push;
  if (!Object.keys(upd.$set).length) delete upd.$set;
  if (!upd.$set && !upd.$push) throw bad('Nothing to change');
  const p = await db.col('patients').findOneAndUpdate({ id: patient.id }, upd);
  await audit(req, 'patient.update', { type: 'patient', id: p.id, patientId: p.id }, { fields: Object.keys(b) });
  res.json(staffView(p, await linkOf(req.ctx.org.id, p.id)));
}));

module.exports = { name: 'patients', router, linkOf, requireLinked, ensureLink, sharesWith, visibleRecordFilter, groupOrgIds, patientMode, crossSharingAllowed, patientProviders, patientScope, scopeFilter, patientCanUse, applicationView, staffView, selfView, patientName, normAllergies, allergyRule, demographics, recordConsent, age, PATIENT_COLLECTIONS };
