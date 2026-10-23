'use strict';
/*
 * Community health workers (module 'chw', role chw, app chw).
 *
 * Offline-first: the CHW app records households, clients, visits, immunisations, antenatal
 * contacts and referrals offline, each with a client-generated UUID (clientRef), and posts them
 * in batches to /api/chw/sync. Sync is idempotent: (orgId, clientRef) is unique, so re-sending
 * a record returns the id it already created. Each record gets its own result so the app can
 * clear exactly the records that landed.
 *
 * Clients become patients linked to the CHW's provider, by the same rules as front desk
 * registration: a phone that already belongs to a MediCore patient elsewhere is never revealed;
 * the patient gets an SMS code and the CHW links only with that code.
 *
 * A CHW sees only the households and clients they registered or that were assigned to them.
 * Danger signs create an urgent referral that lands in the provider's triage queue.
 */
const express = require('express');
const db = require('../db');
const config = require('../config');
const { ah, body, query, t, bad, notFound, conflict, param, validate } = require('../lib/http');
const A = require('../lib/auth');
const { id, now, todayLagos, addDays, utcToLagos } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const otp = require('../lib/otp');
const P = require('./patients');

db.index('chw_sync', ['orgId', 'clientRef'], { unique: true });
db.index('chw_households', ['orgId', 'chwUserId']);
db.index('chw_clients', ['orgId', 'chwUserId']);
db.index('chw_clients', ['orgId', 'householdId']);
db.index('chw_clients', ['orgId', 'patientId']);
db.index('chw_visits', ['orgId', 'clientId', 'kind']);
db.index('chw_visits', ['orgId', 'chwUserId', 'createdAt']);
db.index('chw_visits', ['patientId', 'createdAt']);

const router = express.Router();
router.use('/chw', (req, res, next) => (require('../lib/settings').feature('chw', req.ctx && req.ctx.org) ? next() : res.status(403).json({ error: 'Community health is switched off on MediCore', code: 'feature_off' })));
const field = [A.requireStaff({ perm: 'chw.field', module: 'chw' })];
const fieldWrite = [A.requireStaff({ perm: 'chw.field', module: 'chw' }), A.requireOnShift];
const supervisor = A.requireStaff({ anyPerm: ['admin.reports', 'admin.staff'], module: 'chw' });

const KINDS = ['household', 'client', 'visit', 'immunization', 'anc', 'referral'];
const MAX_BATCH = 200;
const UUID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

const DANGER_SIGNS = ['convulsions', 'unable_to_feed', 'vomiting_everything', 'lethargic_unconscious', 'fast_breathing', 'chest_indrawing', 'high_fever', 'severe_dehydration',
  'severe_malnutrition', 'bleeding', 'severe_headache', 'blurred_vision', 'swelling_face_hands', 'reduced_fetal_movement', 'leaking_fluid', 'severe_abdominal_pain', 'fever_pregnancy', 'difficulty_breathing', 'other'];
const DANGER_LABELS = { convulsions: 'Convulsions', unable_to_feed: 'Unable to drink or breastfeed', vomiting_everything: 'Vomits everything', lethargic_unconscious: 'Lethargic or unconscious', fast_breathing: 'Fast breathing',
  chest_indrawing: 'Chest indrawing', high_fever: 'High fever', severe_dehydration: 'Severe dehydration', severe_malnutrition: 'Severe malnutrition (MUAC red)', bleeding: 'Vaginal bleeding', severe_headache: 'Severe headache',
  blurred_vision: 'Blurred vision', swelling_face_hands: 'Swelling of face or hands', reduced_fetal_movement: 'Reduced fetal movement', leaking_fluid: 'Leaking fluid', severe_abdominal_pain: 'Severe abdominal pain', fever_pregnancy: 'Fever in pregnancy', difficulty_breathing: 'Difficulty breathing', other: 'Other danger sign' };

/* Nigerian National Programme on Immunization routine schedule. ageDays or ageMonths from birth. */
const NPI = [
  { code: 'BCG', label: 'BCG', at: { days: 0 } }, { code: 'OPV0', label: 'OPV 0', at: { days: 0 } }, { code: 'HEPB0', label: 'Hepatitis B birth dose', at: { days: 0 } },
  { code: 'PENTA1', label: 'Pentavalent 1', at: { days: 42 } }, { code: 'PCV1', label: 'PCV 1', at: { days: 42 } }, { code: 'OPV1', label: 'OPV 1', at: { days: 42 } }, { code: 'ROTA1', label: 'Rotavirus 1', at: { days: 42 } },
  { code: 'PENTA2', label: 'Pentavalent 2', at: { days: 70 } }, { code: 'PCV2', label: 'PCV 2', at: { days: 70 } }, { code: 'OPV2', label: 'OPV 2', at: { days: 70 } }, { code: 'ROTA2', label: 'Rotavirus 2', at: { days: 70 } },
  { code: 'PENTA3', label: 'Pentavalent 3', at: { days: 98 } }, { code: 'PCV3', label: 'PCV 3', at: { days: 98 } }, { code: 'OPV3', label: 'OPV 3', at: { days: 98 } }, { code: 'ROTA3', label: 'Rotavirus 3', at: { days: 98 } }, { code: 'IPV', label: 'IPV', at: { days: 98 } },
  { code: 'MEASLES1', label: 'Measles 1', at: { months: 9 } }, { code: 'YF', label: 'Yellow fever', at: { months: 9 } }, { code: 'MENA', label: 'Meningitis A', at: { months: 9 } },
  { code: 'MEASLES2', label: 'Measles 2', at: { months: 15 } },
];
const VACCINES = NPI.map(v => v.code);
/* WHO 2016 eight-contact ANC model, adopted in Nigeria: gestational weeks */
const ANC_CONTACTS = [12, 20, 26, 30, 34, 36, 38, 40];

function addMonths(date, n) { const d = new Date(date + 'T00:00:00Z'); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return d.toISOString().slice(0, 10); }
const dueOf = (dob, at) => (at.months ? addMonths(dob, at.months) : addDays(dob, at.days));

/* ---------------- visibility ---------------- */
async function myHouseholdIds(req) {
  const uid = req.ctx.user.id;
  const hs = await db.col('chw_households').find({ orgId: req.ctx.org.id, $or: [{ chwUserId: uid }, { assignedTo: uid }] }, { projection: { id: 1 } });
  return hs.map(h => h.id);
}
async function clientFilter(req) {
  const uid = req.ctx.user.id; const hh = await myHouseholdIds(req);
  const or = [{ chwUserId: uid }, { assignedTo: uid }]; if (hh.length) or.push({ householdId: { $in: hh } });
  return { orgId: req.ctx.org.id, $or: or };
}
async function visibleClient(req, clientId) {
  const c = await db.col('chw_clients').findOne(Object.assign({ id: clientId }, await clientFilter(req)));
  return c || null;
}
async function visibleHousehold(req, householdId) {
  const uid = req.ctx.user.id;
  return db.col('chw_households').findOne({ id: householdId, orgId: req.ctx.org.id, $or: [{ chwUserId: uid }, { assignedTo: uid }] });
}
/** resolve a server id or a clientRef from an earlier sync to the visible record */
async function resolveRef(req, kind, serverId, ref) {
  let rid = serverId || null;
  if (!rid && ref) { const s = await db.col('chw_sync').findOne({ orgId: req.ctx.org.id, clientRef: ref, kind, status: 'done' }); rid = s ? s.recordId : null; }
  if (!rid) return null;
  return kind === 'client' ? visibleClient(req, rid) : visibleHousehold(req, rid);
}

/* ---------------- per-kind schemas ---------------- */
const signs = () => t.arr(t.enum(DANGER_SIGNS), { max: 12 });
const SCHEMAS = {
  household: { name: t.str({ required: true, max: 100, label: 'Household name' }), address: t.str({ max: 300 }), area: t.str({ max: 80 }), ward: t.str({ max: 80 }), lga: t.str({ max: 80 }), phone: t.phone(), members: t.int({ min: 1, max: 60 }) },
  client: { firstName: t.str({ required: true, max: 60, label: 'First name' }), lastName: t.str({ required: true, max: 60, label: 'Last name' }), dob: t.date({ label: 'Date of birth' }), sex: t.enum(['female', 'male', 'other', 'unknown']),
    phone: t.phone(), householdId: t.id(), householdRef: t.str({ max: 64, pattern: UUID_RE }), relationship: t.str({ max: 40 }), pregnant: t.bool(), lmp: t.date({ label: 'Last menstrual period' }), consent: t.bool({ required: true }), noKnownAllergies: t.bool() },
  visit: { clientId: t.id(), forClientRef: t.str({ max: 64, pattern: UUID_RE }), purpose: t.enum(['routine', 'followup', 'sick', 'newborn', 'postnatal', 'nutrition', 'other'], { default: 'routine' }), dangerSigns: signs(),
    tempC: t.num({ min: 30, max: 45 }), muacCm: t.num({ min: 5, max: 40 }), weightKg: t.num({ min: 0.3, max: 300 }), respRate: t.int({ min: 5, max: 120 }), notes: t.text({ max: 1000 }), outcome: t.enum(['ok', 'advised', 'treated', 'referred']) },
  immunization: { clientId: t.id(), forClientRef: t.str({ max: 64, pattern: UUID_RE }), vaccine: t.enum(VACCINES, { required: true }), givenOn: t.date({ required: true }), batchNo: t.str({ max: 40 }), notes: t.str({ max: 300 }) },
  anc: { clientId: t.id(), forClientRef: t.str({ max: 64, pattern: UUID_RE }), givenOn: t.date(), lmp: t.date(), gestWeeks: t.int({ min: 1, max: 45 }), bpSys: t.int({ min: 50, max: 260 }), bpDia: t.int({ min: 30, max: 160 }), weightKg: t.num({ min: 20, max: 300 }),
    fundalHeightCm: t.num({ min: 5, max: 50 }), dangerSigns: signs(), ironFolate: t.bool(), iptpDose: t.int({ min: 0, max: 6 }), llinGiven: t.bool(), notes: t.text({ max: 1000 }), nextVisitOn: t.date() },
  referral: { clientId: t.id(), forClientRef: t.str({ max: 64, pattern: UUID_RE }), reason: t.str({ required: true, max: 300 }), urgency: t.enum(['urgent', 'routine'], { default: 'routine' }), dangerSigns: signs() },
};

/* ---------------- record handlers: each returns { id, status, extra } ---------------- */
class RecErr extends Error { constructor(msg, code) { super(msg); this.code = code || 'invalid'; } }
const loc = rec => (rec.lat != null && rec.lng != null ? { lat: rec.lat, lng: rec.lng } : null);

async function createHousehold(req, rec, d) {
  const hh = { id: id('hh'), orgId: req.ctx.org.id, chwUserId: req.ctx.user.id, chwMembershipId: req.ctx.membership.id, assignedTo: [], clientRef: rec.clientRef, name: d.name, address: d.address || null, area: d.area || null, ward: d.ward || null, lga: d.lga || null,
    phone: d.phone || null, members: d.members || null, loc: loc(rec), recordedAt: rec.recordedAt, createdAt: now() };
  await db.col('chw_households').insertOne(hh);
  await audit(req, 'chw.household', { type: 'chw_household', id: hh.id });
  return { id: hh.id, status: 'created' };
}

async function createClient(req, rec, d) {
  if (!d.consent) throw new RecErr('The person must agree to the privacy notice before registration', 'consent_required');
  if (d.dob && d.dob > todayLagos()) throw new RecErr('Date of birth is in the future');
  let household = null;
  if (d.householdId || d.householdRef) { household = await resolveRef(req, 'household', d.householdId, d.householdRef); if (!household) throw new RecErr('Household not found', 'not_found'); }
  const orgId = req.ctx.org.id;
  const base = { id: id('cc'), orgId, chwUserId: req.ctx.user.id, chwMembershipId: req.ctx.membership.id, assignedTo: [], clientRef: rec.clientRef, householdId: household ? household.id : null, relationship: d.relationship || null,
    firstName: d.firstName, lastName: d.lastName, dob: d.dob || null, sex: d.sex || 'unknown', pregnant: !!d.pregnant, lmp: d.lmp || null, loc: loc(rec), recordedAt: rec.recordedAt, createdAt: now() };
  if (d.phone) {
    const ex = await db.col('patients').findOne({ phone: d.phone });
    if (ex && ex.status !== 'removed') {
      if (await P.linkOf(orgId, ex.id)) {
        const c = Object.assign(base, { patientId: ex.id, status: 'active', via: 'existing_link' });
        await db.col('chw_clients').insertOne(c);
        await audit(req, 'chw.client_existing', { type: 'chw_client', id: c.id, patientId: ex.id });
        return { id: c.id, status: 'created', extra: { patientId: ex.id, existing: true } };
      }
      // exists elsewhere on MediCore: nothing is revealed; the patient must give the code
      const c = Object.assign(base, { patientId: null, status: 'pending_link', pendingPhone: d.phone });
      await db.col('chw_clients').insertOne(c);
      const extra = await otp.issue('link:' + orgId, d.phone, req.ctx.org.name + ' wants to open your MediCore record. Give the health worker this code only if you agree: {code}');
      await audit(req, 'chw.client_link_requested', { type: 'chw_client', id: c.id, patientId: ex.id });
      return { id: c.id, status: 'link_requested', extra: Object.assign({ message: 'This person already has a MediCore record. They have been sent a code by SMS; enter it to link them.' }, extra) };
    }
  }
  const p = { id: id('pat'), firstName: d.firstName, lastName: d.lastName, dob: d.dob || null, sex: d.sex || 'unknown', phone: d.phone || undefined, email: null, address: household ? household.address : null, homeLoc: loc(rec),
    bloodGroup: null, genotype: null, weightKg: null, nokName: null, nokPhone: null, allergies: [], noKnownAllergies: !!d.noKnownAllergies, conditions: [], status: 'active', createdAt: now(), createdVia: 'chw', createdByOrg: orgId, userId: null };
  if (!p.phone) delete p.phone;
  try { await db.col('patients').insertOne(p); } catch (e) { if (e.code === 11000) throw new RecErr('This phone number was registered a moment ago. Sync again.', 'retry'); throw e; }
  await P.ensureLink(orgId, p.id, req.ctx.user.id, 'chw');
  await P.recordConsent(p.id, 'chw:' + orgId, true);
  const c = Object.assign(base, { patientId: p.id, status: 'active', via: 'registered' });
  await db.col('chw_clients').insertOne(c);
  await audit(req, 'chw.client_register', { type: 'chw_client', id: c.id, patientId: p.id });
  if (p.phone) await notify({ patientId: p.id, title: 'Welcome to MediCore', body: req.ctx.org.name + ' registered you. Download the MediCore app and sign up with this number to see your records.', sms: p.phone, kind: 'welcome' });
  return { id: c.id, status: 'created', extra: { patientId: p.id } };
}

async function targetClient(req, d) {
  if (!d.clientId && !d.forClientRef) throw new RecErr('clientId or forClientRef is required');
  const c = await resolveRef(req, 'client', d.clientId, d.forClientRef);
  if (!c) throw new RecErr('Client not found', 'not_found');
  return c;
}

async function makeReferral(req, rec, client, { reason, urgency, dangerSigns, fromVisitId }) {
  const ref = { id: id('cr'), orgId: req.ctx.org.id, kind: 'referral', patientId: client.patientId || null, clientId: client.id, householdId: client.householdId || null, chwUserId: req.ctx.user.id, clientRef: fromVisitId ? null : rec.clientRef,
    reason, urgency, dangerSigns: dangerSigns || [], fromVisitId: fromVisitId || null, status: 'open', queueId: null, loc: loc(rec), recordedAt: rec.recordedAt, createdAt: now() };
  if (client.patientId) {
    const q = { id: id('q'), orgId: req.ctx.org.id, patientId: client.patientId, appointmentId: null, servicePoint: 'triage', doctorMembershipId: null, priority: urgency === 'urgent' ? 'urgent' : 'normal', status: 'waiting', at: now(), source: 'chw', referralId: ref.id };
    await db.col('queue').insertOne(q);
    ref.queueId = q.id; ref.status = 'queued';
  }
  await db.col('chw_visits').insertOne(ref);
  await audit(req, 'chw.referral', { type: 'chw_referral', id: ref.id, patientId: ref.patientId }, { urgency, signs: ref.dangerSigns.length, queued: !!ref.queueId });
  await notify({ orgId: req.ctx.org.id, role: 'receptionist', title: urgency === 'urgent' ? 'Urgent community referral' : 'Community referral', body: client.patientId ? 'A community health worker referred a patient. They are in the triage queue.' : 'A community health worker referred a person who is not yet linked. Expect them at the desk.', kind: 'chw_referral', ref: { type: 'chw_referral', id: ref.id } });
  return ref;
}

async function createVisit(req, rec, d, kind) {
  const client = await targetClient(req, d);
  const orgId = req.ctx.org.id;
  if (kind === 'immunization') {
    if (d.givenOn > todayLagos()) throw new RecErr('Vaccination date is in the future');
    if (client.dob && d.givenOn < client.dob) throw new RecErr('Vaccination date is before the date of birth');
    const dup = await db.col('chw_visits').findOne({ orgId, clientId: client.id, kind: 'immunization', vaccine: d.vaccine });
    if (dup) throw new RecErr(d.vaccine + ' is already recorded for this child', 'duplicate');
  }
  const v = Object.assign({ id: id('cv'), orgId, kind, patientId: client.patientId || null, clientId: client.id, householdId: client.householdId || null, chwUserId: req.ctx.user.id, clientRef: rec.clientRef, loc: loc(rec), recordedAt: rec.recordedAt, createdAt: now() }, d);
  delete v.forClientRef;
  if (kind === 'anc' && !v.givenOn) v.givenOn = utcToLagos(rec.recordedAt).date;
  if (kind === 'referral') {
    const ref = await makeReferral(req, rec, client, { reason: d.reason, urgency: d.urgency || 'routine', dangerSigns: d.dangerSigns });
    return { id: ref.id, status: 'created', extra: { referralId: ref.id, queueId: ref.queueId } };
  }
  await db.col('chw_visits').insertOne(v);
  if (kind === 'anc' && (d.lmp || client.pregnant === false)) await db.col('chw_clients').updateOne({ id: client.id, orgId }, { $set: Object.assign({ pregnant: true }, d.lmp ? { lmp: d.lmp } : {}) });
  await audit(req, 'chw.' + kind, { type: 'chw_' + kind, id: v.id, patientId: v.patientId }, kind === 'immunization' ? { vaccine: d.vaccine } : { signs: (d.dangerSigns || []).length });
  const extra = {};
  if ((kind === 'visit' || kind === 'anc') && d.dangerSigns && d.dangerSigns.length) {
    const ref = await makeReferral(req, rec, client, { reason: 'Danger signs: ' + d.dangerSigns.map(s => DANGER_LABELS[s]).join(', '), urgency: 'urgent', dangerSigns: d.dangerSigns, fromVisitId: v.id });
    await db.col('chw_visits').updateOne({ id: v.id, orgId }, { $set: { referralId: ref.id, outcome: 'referred' } });
    extra.referralId = ref.id; extra.queueId = ref.queueId;
  }
  return { id: v.id, status: 'created', extra };
}

async function processRecord(req, raw) {
  const outer = validate(raw, { clientRef: t.str({ required: true, max: 64, pattern: UUID_RE, label: 'clientRef' }), kind: t.enum(KINDS, { required: true }), data: t.any({ required: true, maxBytes: 6000 }), recordedAt: t.int({ min: 1500000000000, max: 9999999999999 }), lat: t.lat(), lng: t.lng() });
  if (!outer.data || typeof outer.data !== 'object' || Array.isArray(outer.data)) throw new RecErr('data must be an object');
  if (!outer.recordedAt || outer.recordedAt > now() + 10 * 60000) outer.recordedAt = Math.min(outer.recordedAt || now(), now());
  const d = validate(outer.data, SCHEMAS[outer.kind]);
  const orgId = req.ctx.org.id;
  const s = { id: id('cs'), orgId, clientRef: outer.clientRef, kind: outer.kind, status: 'processing', recordId: null, chwUserId: req.ctx.user.id, at: now() };
  try { await db.col('chw_sync').insertOne(s); }
  catch (e) {
    if (e.code !== 11000) throw e;
    const ex = await db.col('chw_sync').findOne({ orgId, clientRef: outer.clientRef });
    if (!ex) throw new RecErr('Please sync again', 'retry');
    if (ex.chwUserId !== req.ctx.user.id || ex.kind !== outer.kind) throw new RecErr('That clientRef is already used', 'ref_conflict');
    if (ex.status !== 'done') throw new RecErr('This record is still being saved. Sync again shortly.', 'retry');
    return Object.assign({ clientRef: outer.clientRef, kind: outer.kind, ok: true, status: 'existing', id: ex.recordId }, ex.extra || {});
  }
  try {
    let r;
    if (outer.kind === 'household') r = await createHousehold(req, outer, d);
    else if (outer.kind === 'client') r = await createClient(req, outer, d);
    else r = await createVisit(req, outer, d, outer.kind);
    const extra = Object.assign({}, r.extra || {}); delete extra.devCode; delete extra.message;
    await db.col('chw_sync').updateOne({ id: s.id }, { $set: { status: 'done', recordId: r.id, result: r.status, extra } });
    return Object.assign({ clientRef: outer.clientRef, kind: outer.kind, ok: true, status: r.status, id: r.id }, r.extra || {});
  } catch (e) {
    await db.col('chw_sync').deleteOne({ id: s.id });
    throw e;
  }
}

router.post('/chw/sync', ...fieldWrite, ah(async (req, res) => {
  const b = body(req, { records: t.arr(t.any({ maxBytes: 8000 }), { required: true, min: 1, max: MAX_BATCH }) });
  const results = [];
  for (const raw of b.records) {
    const clientRef = raw && typeof raw.clientRef === 'string' ? raw.clientRef.slice(0, 64) : null;
    try { results.push(await processRecord(req, raw)); }
    catch (e) {
      if (e instanceof RecErr) results.push({ clientRef, kind: raw && raw.kind, ok: false, error: e.code, message: e.message, retry: e.code === 'retry' });
      else if (e && e.status === 400) results.push({ clientRef, kind: raw && raw.kind, ok: false, error: 'invalid', message: e.message, details: e.details, retry: false });
      else { console.error('[chw] sync record failed', e && e.message); results.push({ clientRef, kind: raw && raw.kind, ok: false, error: 'server_error', message: 'Could not save this record. Sync again.', retry: true }); }
    }
  }
  res.json({ ok: results.every(r => r.ok), saved: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results, serverTime: now() });
}));

/* ---------------- reads ---------------- */
function clientView(c, extra) {
  return Object.assign({ id: c.id, clientRef: c.clientRef, householdId: c.householdId, patientId: c.patientId, status: c.status, firstName: c.firstName, lastName: c.lastName, name: c.firstName + ' ' + c.lastName, dob: c.dob, sex: c.sex,
    pregnant: !!c.pregnant, lmp: c.lmp || null, relationship: c.relationship || null, createdAt: c.createdAt }, extra || {});
}
router.get('/chw/schedule', ...field, (req, res) => {
  res.json({ immunization: NPI.map(v => ({ code: v.code, label: v.label, ageDays: v.at.days != null ? v.at.days : null, ageMonths: v.at.months || null })), ancContactsWeeks: ANC_CONTACTS, dangerSigns: DANGER_SIGNS.map(k => ({ code: k, label: DANGER_LABELS[k] })), maxBatch: MAX_BATCH });
});
router.get('/chw/roster', ...field, ah(async (req, res) => {
  const uid = req.ctx.user.id;
  const hhs = await db.col('chw_households').find({ orgId: req.ctx.org.id, $or: [{ chwUserId: uid }, { assignedTo: uid }] }, { sort: { createdAt: -1 } });
  const clients = await db.col('chw_clients').find(await clientFilter(req), { sort: { createdAt: -1 } });
  const last = {};
  if (clients.length) (await db.col('chw_visits').find({ orgId: req.ctx.org.id, clientId: { $in: clients.map(c => c.id) } }, { projection: { clientId: 1, createdAt: 1, recordedAt: 1 } })).forEach(v => { const at = v.recordedAt || v.createdAt; if (!last[v.clientId] || last[v.clientId] < at) last[v.clientId] = at; });
  const cv = c => clientView(c, { lastVisitAt: last[c.id] || null, assigned: c.chwUserId !== uid });
  res.json({
    households: hhs.map(h => ({ id: h.id, clientRef: h.clientRef, name: h.name, address: h.address, area: h.area, ward: h.ward, lga: h.lga, members: h.members, loc: h.loc, assigned: h.chwUserId !== uid, createdAt: h.createdAt, clients: clients.filter(c => c.householdId === h.id).map(cv) })),
    clientsWithoutHousehold: clients.filter(c => !c.householdId || !hhs.some(h => h.id === c.householdId)).map(cv),
    counts: { households: hhs.length, clients: clients.length, pendingLink: clients.filter(c => c.status === 'pending_link').length },
  });
}));
router.get('/chw/clients/:id', ...field, ah(async (req, res) => {
  const c = await visibleClient(req, param(req, 'id'));
  if (!c) throw notFound('Client not found');
  const rows = await db.col('chw_visits').find({ orgId: req.ctx.org.id, clientId: c.id }, { sort: { createdAt: -1 }, limit: 300 });
  if (c.patientId) await audit(req, 'chw.client_view', { type: 'chw_client', id: c.id, patientId: c.patientId });
  const strip = v => { const o = Object.assign({}, v); delete o.orgId; return o; };
  res.json(Object.assign(clientView(c), { visits: rows.filter(v => v.kind === 'visit').map(strip), immunizations: rows.filter(v => v.kind === 'immunization').map(strip), anc: rows.filter(v => v.kind === 'anc').map(strip), referrals: rows.filter(v => v.kind === 'referral').map(strip), due: dueForClient(c, rows, 60) }));
}));
router.post('/chw/clients/:id/link', ...fieldWrite, ah(async (req, res) => {
  const b = body(req, { code: t.str({ required: true, max: 6 }) });
  const c = await visibleClient(req, param(req, 'id'));
  if (!c) throw notFound('Client not found');
  if (c.status !== 'pending_link') throw conflict('This client is already linked');
  const p = await db.col('patients').findOne({ phone: c.pendingPhone });
  if (!p || p.status === 'removed') throw notFound('Patient not found');
  await otp.verify('link:' + req.ctx.org.id, c.pendingPhone, b.code);
  await P.ensureLink(req.ctx.org.id, p.id, req.ctx.user.id, 'consent_code');
  const upd = await db.col('chw_clients').findOneAndUpdate({ id: c.id, orgId: req.ctx.org.id, status: 'pending_link' }, { $set: { status: 'active', patientId: p.id, linkedAt: now() }, $unset: { pendingPhone: '' } });
  if (!upd) throw conflict('This client is already linked');
  await db.col('chw_visits').updateMany({ orgId: req.ctx.org.id, clientId: c.id, patientId: null }, { $set: { patientId: p.id } });
  await audit(req, 'chw.client_linked', { type: 'chw_client', id: c.id, patientId: p.id });
  if (p.userId) await notify({ patientId: p.id, title: 'Linked to ' + req.ctx.org.name, body: 'A community health worker linked your MediCore record.', kind: 'link' });
  res.json(clientView(upd));
}));

function dueForClient(c, rows, days) {
  const today = todayLagos(); const until = addDays(today, days); const out = [];
  if (c.dob && c.dob > addDays(today, -5 * 366)) {
    const given = new Set(rows.filter(r => r.kind === 'immunization').map(r => r.vaccine));
    for (const v of NPI) {
      if (given.has(v.code)) continue;
      const dueOn = dueOf(c.dob, v.at);
      if (dueOn <= until) out.push({ type: 'immunization', code: v.code, label: v.label, dueOn, overdue: dueOn < today });
    }
  }
  if (c.pregnant && c.lmp) {
    const ga = Math.floor((Date.parse(today + 'T00:00:00Z') - Date.parse(c.lmp + 'T00:00:00Z')) / 86400000 / 7);
    const done = rows.filter(r => r.kind === 'anc').length;
    if (ga <= 42 && done < ANC_CONTACTS.length) {
      const wk = ANC_CONTACTS[done]; const dueOn = addDays(c.lmp, wk * 7);
      if (dueOn <= until) out.push({ type: 'anc', code: 'ANC' + (done + 1), label: 'Antenatal contact ' + (done + 1) + ' (' + wk + ' weeks)', dueOn, overdue: dueOn < today, gestWeeks: ga });
    }
  }
  return out.sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1));
}
router.get('/chw/due', ...field, ah(async (req, res) => {
  const q = query(req, { days: t.int({ min: 0, max: 180 }) });
  const clients = (await db.col('chw_clients').find(await clientFilter(req))).filter(c => c.dob || (c.pregnant && c.lmp));
  const rows = clients.length ? await db.col('chw_visits').find({ orgId: req.ctx.org.id, clientId: { $in: clients.map(c => c.id) }, kind: { $in: ['immunization', 'anc'] } }) : [];
  const out = { immunizations: [], anc: [] };
  for (const c of clients) {
    for (const d of dueForClient(c, rows.filter(r => r.clientId === c.id), q.days == null ? 30 : q.days)) {
      const item = Object.assign({ clientId: c.id, name: c.firstName + ' ' + c.lastName, householdId: c.householdId }, d);
      (d.type === 'anc' ? out.anc : out.immunizations).push(item);
    }
  }
  out.immunizations.sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1)); out.anc.sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1));
  res.json(out);
}));
router.get('/chw/referrals', ...field, ah(async (req, res) => {
  const rows = await db.col('chw_visits').find({ orgId: req.ctx.org.id, kind: 'referral', chwUserId: req.ctx.user.id }, { sort: { createdAt: -1 }, limit: 200 });
  const qs = rows.filter(r => r.queueId).length ? await db.col('queue').find({ orgId: req.ctx.org.id, id: { $in: rows.filter(r => r.queueId).map(r => r.queueId) } }, { projection: { status: 1 } }) : [];
  const qst = Object.fromEntries(qs.map(q => [q.id, q.status]));
  const cl = rows.length ? await db.col('chw_clients').find({ orgId: req.ctx.org.id, id: { $in: [...new Set(rows.map(r => r.clientId))] } }, { projection: { firstName: 1, lastName: 1 } }) : [];
  const nm = Object.fromEntries(cl.map(c => [c.id, c.firstName + ' ' + c.lastName]));
  res.json(rows.map(r => ({ id: r.id, clientId: r.clientId, name: nm[r.clientId] || null, patientId: r.patientId, reason: r.reason, urgency: r.urgency, dangerSigns: r.dangerSigns, status: r.status, queueId: r.queueId, queueStatus: r.queueId ? qst[r.queueId] || null : null, fromVisitId: r.fromVisitId, createdAt: r.createdAt })));
}));

/* ---------------- supervisors (admins) ---------------- */
router.get('/chw/workers', supervisor, ah(async (req, res) => {
  const ms = await db.col('memberships').find({ orgId: req.ctx.org.id, role: 'chw', status: { $ne: 'removed' } });
  const us = ms.length ? await db.col('users').find({ id: { $in: ms.map(m => m.userId) } }, { projection: { name: 1 } }) : [];
  const nm = Object.fromEntries(us.map(u => [u.id, u.name]));
  const out = [];
  for (const m of ms) out.push({ membershipId: m.id, userId: m.userId, name: nm[m.userId] || 'CHW', status: m.status, households: await db.col('chw_households').count({ orgId: req.ctx.org.id, chwUserId: m.userId }), clients: await db.col('chw_clients').count({ orgId: req.ctx.org.id, chwUserId: m.userId }) });
  res.json(out);
}));
router.post('/chw/assign', A.requireStaff({ perm: 'admin.staff', module: 'chw' }), ah(async (req, res) => {
  const b = body(req, { kind: t.enum(['household', 'client'], { required: true }), id: t.id({ required: true }), chwMembershipId: t.id({ required: true }), unassign: t.bool() });
  const m = await db.col('memberships').findOne({ id: b.chwMembershipId, orgId: req.ctx.org.id, role: 'chw', status: 'active' });
  if (!m) throw notFound('Community health worker not found');
  const col = b.kind === 'household' ? 'chw_households' : 'chw_clients';
  const upd = await db.col(col).findOneAndUpdate({ id: b.id, orgId: req.ctx.org.id }, b.unassign ? { $pull: { assignedTo: m.userId } } : { $addToSet: { assignedTo: m.userId } });
  if (!upd) throw notFound(b.kind === 'household' ? 'Household not found' : 'Client not found');
  await audit(req, b.unassign ? 'chw.unassign' : 'chw.assign', { type: 'chw_' + b.kind, id: upd.id, patientId: upd.patientId || null }, { membershipId: m.id });
  res.json({ ok: true, id: upd.id, assignedTo: upd.assignedTo });
}));
function weekKey(ts) { const d = new Date(ts + 3600e3); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); }
router.get('/chw/supervisor/summary', supervisor, ah(async (req, res) => {
  const q = query(req, { weeks: t.int({ min: 1, max: 26 }) });
  const weeks = q.weeks || 4; const since = now() - weeks * 7 * 86400e3;
  const rows = await db.col('chw_visits').find({ orgId: req.ctx.org.id, createdAt: { $gte: since } }, { projection: { chwUserId: 1, kind: 1, createdAt: 1, recordedAt: 1, urgency: 1 } });
  const newClients = await db.col('chw_clients').find({ orgId: req.ctx.org.id, createdAt: { $gte: since } }, { projection: { chwUserId: 1, createdAt: 1 } });
  const ms = await db.col('memberships').find({ orgId: req.ctx.org.id, role: 'chw' });
  const us = ms.length ? await db.col('users').find({ id: { $in: ms.map(m => m.userId) } }, { projection: { name: 1 } }) : [];
  const nm = Object.fromEntries(us.map(u => [u.id, u.name]));
  const by = {};
  const slot = (uid, wk) => { by[uid] = by[uid] || {}; by[uid][wk] = by[uid][wk] || { week: wk, visits: 0, immunizations: 0, anc: 0, referrals: 0, urgentReferrals: 0, newClients: 0 }; return by[uid][wk]; };
  rows.forEach(r => { const s = slot(r.chwUserId, weekKey(r.recordedAt || r.createdAt)); if (r.kind === 'visit') s.visits++; else if (r.kind === 'immunization') s.immunizations++; else if (r.kind === 'anc') s.anc++; else if (r.kind === 'referral') { s.referrals++; if (r.urgency === 'urgent') s.urgentReferrals++; } });
  newClients.forEach(c => { slot(c.chwUserId, weekKey(c.createdAt)).newClients++; });
  const workers = [...new Set(ms.map(m => m.userId).concat(Object.keys(by)))].map(uid => {
    const wks = Object.values(by[uid] || {}).sort((a, b) => (a.week < b.week ? -1 : 1));
    const tot = wks.reduce((s, w) => { Object.keys(w).forEach(k => { if (k !== 'week') s[k] = (s[k] || 0) + w[k]; }); return s; }, { visits: 0, immunizations: 0, anc: 0, referrals: 0, urgentReferrals: 0, newClients: 0 });
    return { userId: uid, name: nm[uid] || 'CHW', weeks: wks, totals: tot };
  });
  res.json({ since, weeks, workers });
}));

/* ---------------- demo ---------------- */
async function seedDemo(ctx) {
  const chw = ctx.staff.hospital && ctx.staff.hospital.chw;
  if (!chw) return;
  const orgId = ctx.orgs.hospital.id;
  const t0 = now();
  const hh = { id: id('hh'), orgId, chwUserId: chw.user.id, chwMembershipId: chw.membership.id, assignedTo: [], clientRef: 'demo-hh-' + id('x').slice(2), name: 'Okonkwo household', address: '7 Lawanson Rd, Surulere', area: 'Lawanson', ward: 'Ward C', lga: 'Surulere', phone: null, members: 5, loc: { lat: 6.5002, lng: 3.3488 }, recordedAt: t0, createdAt: t0 };
  await db.col('chw_households').insertOne(hh);
  const mk = async (first, last, dob, sex, extra) => {
    const p = { id: id('pat'), firstName: first, lastName: last, dob, sex, email: null, address: hh.address, homeLoc: hh.loc, bloodGroup: null, genotype: null, weightKg: null, nokName: null, nokPhone: null, allergies: [], noKnownAllergies: true, conditions: [], status: 'active', createdAt: t0, createdVia: 'chw', createdByOrg: orgId, userId: null, consent: { version: config.PRIVACY_NOTICE_VERSION, accepted: true, at: t0, channel: 'chw:' + orgId } };
    await db.col('patients').insertOne(p);
    await P.ensureLink(orgId, p.id, chw.user.id, 'chw');
    const c = Object.assign({ id: id('cc'), orgId, chwUserId: chw.user.id, chwMembershipId: chw.membership.id, assignedTo: [], clientRef: 'demo-cc-' + id('x').slice(2), householdId: hh.id, relationship: null, firstName: first, lastName: last, dob, sex, pregnant: false, lmp: null, loc: hh.loc, recordedAt: t0, createdAt: t0, patientId: p.id, status: 'active', via: 'registered' }, extra || {});
    await db.col('chw_clients').insertOne(c);
    return c;
  };
  const mum = await mk('Chioma', 'Okonkwo', '1996-06-02', 'female', { pregnant: true, lmp: addDays(todayLagos(), -20 * 7), relationship: 'mother' });
  const baby = await mk('Ebuka', 'Okonkwo', addDays(todayLagos(), -50), 'male', { relationship: 'child' });
  for (const v of ['BCG', 'OPV0', 'HEPB0']) await db.col('chw_visits').insertOne({ id: id('cv'), orgId, kind: 'immunization', patientId: baby.patientId, clientId: baby.id, householdId: hh.id, chwUserId: chw.user.id, clientRef: null, vaccine: v, givenOn: baby.dob, recordedAt: t0, createdAt: t0 });
  await db.col('chw_visits').insertOne({ id: id('cv'), orgId, kind: 'anc', patientId: mum.patientId, clientId: mum.id, householdId: hh.id, chwUserId: chw.user.id, clientRef: null, givenOn: addDays(todayLagos(), -6 * 7), gestWeeks: 14, bpSys: 118, bpDia: 76, ironFolate: true, recordedAt: t0 - 42 * 86400e3, createdAt: t0 - 42 * 86400e3 });
  await db.col('chw_visits').insertOne({ id: id('cv'), orgId, kind: 'visit', patientId: baby.patientId, clientId: baby.id, householdId: hh.id, chwUserId: chw.user.id, clientRef: null, purpose: 'newborn', dangerSigns: [], weightKg: 4.6, outcome: 'ok', recordedAt: t0 - 7 * 86400e3, createdAt: t0 - 7 * 86400e3 });
}

module.exports = { name: 'chw', router, seedDemo, NPI, ANC_CONTACTS, DANGER_SIGNS, dueForClient };
