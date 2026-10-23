'use strict';
/*
 * Hospitals that are not on MediCore (government teaching hospitals, federal medical centres, general hospitals,
 * primary health centres, mission and military hospitals), and emergency transfers to any hospital.
 *
 * Private providers are MediCore's first customers; public tertiary hospitals will take longer to join. Until they do,
 * they are still on the map: HQ keeps a registry with their location, services and numbers (main line, emergency,
 * referral / transfer desk), imported from a spreadsheet or the Federal Ministry of Health facility registry, and
 * marked verified once someone has called the number. Providers can suggest a correction; HQ approves it.
 *
 * Emergency transfer finder (staff): hospitals near the patient that can take the case, MediCore hospitals (with their
 * beds and "taking emergencies" status) and public ones together, filtered by service (ICU, dialysis, burns...).
 * Tap a number to call. Each transfer is logged (who was called, what they said) and can carry:
 *   - a transfer pack: a link plus a 6-digit access code the receiving hospital opens without an account, showing
 *     the patient summary for 72 hours (configurable), with every opening logged;
 *   - an ambulance: an incident for the provider's own ambulance service (or one it chooses) with the destination set.
 * A hospital that IS on MediCore gets a referral instead (urgency emergency), through the referral network.
 *
 * Emergency map for everyone: /api/emergency/facilities lists emergency-capable hospitals near a point, with numbers.
 */
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param, normPhone } = require('../lib/http');
const A = require('../lib/auth');
const S = require('../lib/settings');
const RL = require('../lib/ratelimit');
const { id, now, haversineKm, etaMinutes, sha256, digits } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const P = require('./patients');
const { nextNumber } = require('./orgs');

db.index('public_facilities', ['status', 'state']);
db.index('facility_suggestions', ['status', 'createdAt']);
db.index('transfers', ['fromOrgId', 'createdAt']);
db.index('transfers', ['patientId', 'createdAt']);
db.index('transfers', ['packHash']);

const router = express.Router();
const KINDS = ['teaching', 'federal_medical_centre', 'specialist', 'general', 'cottage', 'phc', 'military', 'mission', 'private', 'other'];
const OWNERS = ['federal', 'state', 'lga', 'military', 'mission', 'private', 'other'];
const LEVELS = ['tertiary', 'secondary', 'primary'];
const SERVICES = ['emergency', 'icu', 'nicu', 'maternity', 'trauma', 'burns', 'dialysis', 'surgery', 'paediatrics', 'psychiatry', 'oncology', 'cardiology', 'neurosurgery', 'blood_bank', 'ct_scan', 'mri', 'isolation', 'antivenom'];
const PHONE_KINDS = ['main', 'emergency', 'transfer', 'ambulance', 'whatsapp', 'other'];
const OUTCOMES = ['requested', 'no_answer', 'accepted', 'declined', 'en_route', 'arrived', 'cancelled'];
const URGENCY = ['emergency', 'urgent', 'routine'];
const pubOn = () => S.feature('publicFacilities');
const transfersOn = (req, res, next) => (S.feature('transfers', req.ctx && req.ctx.org) ? next() : next(forbidden('Emergency transfers are switched off on MediCore')));

/* numbers: Nigerian or international, stored as +digits */
function normAnyPhone(raw) {
  const ng = normPhone(raw); if (ng) return ng;
  const s = String(raw || '').replace(/[\s\-().]/g, '');
  if (/^0[1-9]\d{6,9}$/.test(s)) return '+234' + s.slice(1); // landlines such as 01 2345678
  if (/^\+\d{8,15}$/.test(s)) return s;
  return null;
}
const phoneRule = t.obj({ label: t.str({ max: 40, plain: true }), number: t.str({ required: true, max: 24 }), kind: t.enum(PHONE_KINDS, { default: 'main' }) });
const facRules = {
  name: t.str({ required: true, max: 160, plain: true }), kind: t.enum(KINDS, { required: true }), ownership: t.enum(OWNERS, { required: true }), level: t.enum(LEVELS, { required: true }),
  state: t.str({ max: 40, plain: true }), lga: t.str({ max: 60, plain: true }), address: t.str({ max: 300, plain: true }), location: t.obj({ lat: t.lat({ required: true }), lng: t.lng({ required: true }) }),
  phones: t.arr(phoneRule, { max: 8 }), services: t.arr(t.enum(SERVICES), { max: SERVICES.length }), open24h: t.bool(), notes: t.text({ max: 1000 }), hfrId: t.str({ max: 40, plain: true }), onPlatformOrgId: t.id(), verified: t.bool(), status: t.enum(['active', 'hidden']),
};
function normPhones(list) {
  return (list || []).map(p => { const n = normAnyPhone(p.number); if (!n) throw bad('Phone number "' + p.number + '" is not valid'); return { label: p.label || null, number: n, kind: p.kind || 'main' }; });
}
function facView(f, from) {
  const d = from && f.location ? haversineKm(from, f.location) : null;
  return { id: f.id, source: 'public', name: f.name, kind: f.kind, ownership: f.ownership, level: f.level, state: f.state || null, lga: f.lga || null, address: f.address || null, location: f.location || null,
    phones: (f.phones || []).map(p => Object.assign({}, p, { tel: 'tel:' + p.number })), services: f.services || [], open24h: !!f.open24h, notes: f.notes || null, verified: !!f.verified, verifiedAt: f.verifiedAt || null,
    onPlatformOrgId: f.onPlatformOrgId || null, distanceKm: d == null ? null : Math.round(d * 10) / 10, etaMin: d == null ? null : etaMinutes(d), updatedAt: f.updatedAt || f.createdAt };
}

/* ================= HQ registry ================= */
const hqRead = A.requirePlatform('platform.read');
const hqWrite = A.requirePlatform('platform.config');
router.get('/hq/facilities', hqRead, ah(async (req, res) => {
  const q = query(req, { q: t.str({ max: 60 }), state: t.str({ max: 40 }), status: t.enum(['active', 'hidden']), unverified: t.bool() });
  const f = {}; if (q.status) f.status = q.status; if (q.state) f.state = q.state;
  let rows = await db.col('public_facilities').find(f, { sort: { name: 1 }, limit: 5000 });
  if (q.q) { const s = q.q.toLowerCase(); rows = rows.filter(r => r.name.toLowerCase().includes(s) || (r.lga || '').toLowerCase().includes(s)); }
  if (q.unverified) rows = rows.filter(r => !r.verified);
  res.json({ facilities: rows.map(r => facView(r)), suggestions: await db.col('facility_suggestions').count({ status: 'open' }), meta: { kinds: KINDS, ownership: OWNERS, levels: LEVELS, services: SERVICES, phoneKinds: PHONE_KINDS } });
}));
router.post('/hq/facilities', hqWrite, ah(async (req, res) => {
  const b = body(req, facRules);
  const f = Object.assign({ id: id('pfc'), status: 'active', createdAt: now(), createdBy: req.ctx.user.id, source: 'hq' }, b, { phones: normPhones(b.phones), services: b.services || [], open24h: !!b.open24h });
  if (b.verified) Object.assign(f, { verifiedAt: now(), verifiedBy: req.ctx.user.id });
  await db.col('public_facilities').insertOne(f);
  await audit(req, 'facility.create', { type: 'public_facility', id: f.id, orgId: null });
  res.json(facView(f));
}));
router.patch('/hq/facilities/:id', hqWrite, ah(async (req, res) => {
  const rules = Object.assign({}, facRules); rules.name = t.str({ max: 160, plain: true }); rules.kind = t.enum(KINDS); rules.ownership = t.enum(OWNERS); rules.level = t.enum(LEVELS);
  const b = body(req, rules);
  if (!Object.keys(b).length) throw bad('Nothing to change');
  const set = Object.assign({ updatedAt: now(), updatedBy: req.ctx.user.id }, b);
  if (b.phones) set.phones = normPhones(b.phones);
  if (b.verified === true) Object.assign(set, { verifiedAt: now(), verifiedBy: req.ctx.user.id });
  const f = await db.col('public_facilities').findOneAndUpdate({ id: param(req, 'id') }, { $set: set });
  if (!f) throw notFound('Facility not found');
  await audit(req, 'facility.update', { type: 'public_facility', id: f.id, orgId: null }, { fields: Object.keys(b) });
  res.json(facView(f));
}));
/** CSV import. Columns (header row, any order): name, kind, ownership, level, state, lga, address, lat, lng,
 *  main_phone, emergency_phone, transfer_phone, services (separated by |), open24h (yes/no), hfr_id */
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim()));
}
router.post('/hq/facilities/import', hqWrite, ah(async (req, res) => {
  const b = body(req, { csv: t.str({ required: true, max: 190000, trim: false }), dryRun: t.bool(), markVerified: t.bool() });
  const rows = parseCsv(b.csv);
  if (rows.length < 2) throw bad('The file needs a header row and at least one facility');
  const head = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const col = k => head.indexOf(k);
  if (col('name') < 0) throw bad('The header row needs a "name" column');
  const pick = (r, k) => (col(k) >= 0 ? String(r[col(k)] || '').trim() : '');
  const results = []; let created = 0, updated = 0;
  for (let i = 1; i < rows.length && i <= 2000; i++) {
    const r = rows[i]; const name = pick(r, 'name'); if (!name) { results.push({ row: i + 1, ok: false, error: 'No name' }); continue; }
    try {
      const phones = [['main_phone', 'main'], ['emergency_phone', 'emergency'], ['transfer_phone', 'transfer']].filter(([k]) => pick(r, k)).map(([k, kind]) => ({ number: pick(r, k), kind }));
      const lat = Number(pick(r, 'lat')), lng = Number(pick(r, 'lng'));
      const doc = {
        name: name.slice(0, 160), kind: KINDS.includes(pick(r, 'kind')) ? pick(r, 'kind') : 'other', ownership: OWNERS.includes(pick(r, 'ownership')) ? pick(r, 'ownership') : 'other', level: LEVELS.includes(pick(r, 'level')) ? pick(r, 'level') : 'secondary',
        state: pick(r, 'state').slice(0, 40) || null, lga: pick(r, 'lga').slice(0, 60) || null, address: pick(r, 'address').slice(0, 300) || null,
        location: Number.isFinite(lat) && Number.isFinite(lng) && pick(r, 'lat') !== '' && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null,
        phones: normPhones(phones), services: pick(r, 'services').split('|').map(x => x.trim().toLowerCase()).filter(x => SERVICES.includes(x)), open24h: /^(y|yes|true|1)$/i.test(pick(r, 'open24h')), hfrId: pick(r, 'hfr_id').slice(0, 40) || null,
      };
      const existing = doc.hfrId ? await db.col('public_facilities').findOne({ hfrId: doc.hfrId }) : await db.col('public_facilities').findOne({ name: doc.name, state: doc.state });
      if (!b.dryRun) {
        if (existing) { await db.col('public_facilities').updateOne({ id: existing.id }, { $set: Object.assign(doc, { updatedAt: now(), source: 'import' }, b.markVerified ? { verified: true, verifiedAt: now(), verifiedBy: req.ctx.user.id } : {}) }); updated++; }
        else { await db.col('public_facilities').insertOne(Object.assign({ id: id('pfc'), status: 'active', createdAt: now(), createdBy: req.ctx.user.id, source: 'import', verified: !!b.markVerified, verifiedAt: b.markVerified ? now() : null }, doc)); created++; }
      }
      results.push({ row: i + 1, ok: true, name: doc.name, action: existing ? 'update' : 'create', warnings: doc.location ? [] : ['no map location'] });
    } catch (e) { results.push({ row: i + 1, ok: false, name, error: e.message }); }
  }
  if (!b.dryRun) await audit(req, 'facility.import', { type: 'public_facility', id: null, orgId: null }, { created, updated, rows: rows.length - 1 });
  res.json({ dryRun: !!b.dryRun, created, updated, failed: results.filter(r => !r.ok).length, results: results.slice(0, 500) });
}));
router.get('/hq/facility-suggestions', hqRead, ah(async (req, res) => {
  const rows = await db.col('facility_suggestions').find({ status: 'open' }, { sort: { createdAt: -1 }, limit: 200 });
  const out = []; for (const s of rows) { const f = await db.col('public_facilities').findOne({ id: s.facilityId }); out.push(Object.assign({}, s, { facilityName: f ? f.name : null })); }
  res.json(out);
}));
router.post('/hq/facility-suggestions/:id/:action', hqWrite, ah(async (req, res) => {
  const action = req.params.action; if (!['apply', 'dismiss'].includes(action)) throw notFound();
  const s = await db.col('facility_suggestions').findOneAndUpdate({ id: param(req, 'id'), status: 'open' }, { $set: { status: action === 'apply' ? 'applied' : 'dismissed', decidedAt: now(), decidedBy: req.ctx.user.id } });
  if (!s) throw conflict('This suggestion was already handled');
  if (action === 'apply' && s.phone) {
    const f = await db.col('public_facilities').findOne({ id: s.facilityId });
    if (f) { const phones = (f.phones || []).filter(p => p.kind !== s.phone.kind || p.number === s.phone.number); if (!phones.some(p => p.number === s.phone.number)) phones.push(s.phone); await db.col('public_facilities').updateOne({ id: f.id }, { $set: { phones, verified: true, verifiedAt: now(), verifiedBy: req.ctx.user.id, updatedAt: now() } }); }
  }
  await audit(req, 'facility.suggestion_' + action, { type: 'facility_suggestion', id: s.id, orgId: null });
  res.json({ ok: true });
}));

/* ================= finder (staff) ================= */
const WARD_SERVICE = { emergency: 'emergency', icu: 'icu', nicu: 'nicu', maternity: 'maternity', dialysis: 'dialysis', isolation: 'isolation', burns: 'burns', psychiatric: 'psychiatry', paediatric: 'paediatrics', theatre: 'surgery', hdu: 'icu' };
async function platformHospitals(from, service) {
  const inv = require('./inventory');
  const rows = await db.col('orgs').find({ status: 'active', type: { $in: ['hospital', 'clinic'] } }, { limit: 3000 });
  const out = [];
  for (const o of rows) {
    if (!o.location || o.location.lat == null) continue;
    const cap = await inv.capacityOf(o.id);
    const services = [...new Set(cap.wards.filter(w => w.total > 0).map(w => WARD_SERVICE[w.key]).filter(Boolean))];
    if (service === 'emergency' ? cap.acceptingEmergencies === false : service && !services.includes(service)) continue;
    const d = from ? haversineKm(from, o.location) : null;
    const phones = [];
    if ((o.contact || {}).phone) phones.push({ label: null, number: o.contact.phone, kind: 'main' });
    const em = (o.contacts || {}).emergency; if (em && em.phone) phones.push({ label: null, number: em.phone, kind: 'emergency' });
    const amb = (o.contacts || {}).ambulance; if (amb && amb.phone) phones.push({ label: null, number: amb.phone, kind: 'ambulance' });
    out.push({ id: o.id, source: 'platform', name: o.name, kind: o.type, level: null, address: (o.contact || {}).address || null, location: { lat: o.location.lat, lng: o.location.lng }, area: o.location.area || null,
      phones: phones.map(p => Object.assign(p, { tel: 'tel:' + p.number })), services, takingEmergencies: cap.stale ? null : cap.acceptingEmergencies, freeBeds: cap.stale ? null : cap.freeBeds, capacity: cap.stale ? null : cap.wards, capacityUpdatedAt: cap.updatedAt,
      acceptsReferrals: (o.settings || {}).acceptsReferrals !== false, distanceKm: d == null ? null : Math.round(d * 10) / 10, etaMin: d == null ? null : etaMinutes(d), verified: true });
  }
  return out;
}
async function finder({ from, service, radiusKm, includePlatform, includePublic, exceptOrgIds }) {
  let list = [];
  if (includePlatform) list = list.concat((await platformHospitals(from, service)).filter(x => !(exceptOrgIds || []).includes(x.id)));
  if (includePublic && pubOn()) {
    const pubs = await db.col('public_facilities').find({ status: 'active' }, { limit: 5000 });
    list = list.concat(pubs.filter(f => !f.onPlatformOrgId && (!service || (f.services || []).includes(service))).map(f => facView(f, from)));
  }
  if (from && radiusKm) list = list.filter(x => x.distanceKm == null || x.distanceKm <= radiusKm);
  list.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
  return list;
}
router.get('/facilities/finder', A.requireStaff({ anyPerm: ['transfer.manage', 'ambulance.dispatch', 'referral.send'] }), transfersOn, ah(async (req, res) => {
  const q = query(req, { lat: t.lat(), lng: t.lng(), service: t.enum(SERVICES), radiusKm: t.num({ min: 1, max: 1000 }), source: t.enum(['all', 'platform', 'public']), limit: t.int({ min: 1, max: 300 }) });
  const from = q.lat != null && q.lng != null ? { lat: q.lat, lng: q.lng } : (req.ctx.org.location && req.ctx.org.location.lat != null ? req.ctx.org.location : null);
  const src = q.source || 'all';
  const mine = await P.groupOrgIds(req.ctx.org);
  const list = await finder({ from, service: q.service, radiusKm: q.radiusKm || 50, includePlatform: src !== 'public', includePublic: src !== 'platform', exceptOrgIds: mine });
  res.json({ from, facilities: list.slice(0, q.limit || 100), services: SERVICES });
}));
router.post('/facilities/:id/suggest', A.requireStaff({ anyPerm: ['transfer.manage', 'ambulance.dispatch'] }), ah(async (req, res) => {
  const b = body(req, { number: t.str({ max: 24 }), kind: t.enum(PHONE_KINDS), label: t.str({ max: 40, plain: true }), note: t.text({ required: true, max: 500 }) });
  const f = await db.col('public_facilities').findOne({ id: param(req, 'id') });
  if (!f) throw notFound('Facility not found');
  await RL.limit('facsug_' + req.ctx.org.id, 30, 86400);
  let phone = null; if (b.number) { const n = normAnyPhone(b.number); if (!n) throw bad('That phone number is not valid'); phone = { number: n, kind: b.kind || 'main', label: b.label || null }; }
  const s = { id: id('fsg'), facilityId: f.id, orgId: req.ctx.org.id, orgName: req.ctx.org.name, byName: req.ctx.user.name, phone, note: b.note, status: 'open', createdAt: now() };
  await db.col('facility_suggestions').insertOne(s);
  await audit(req, 'facility.suggest', { type: 'public_facility', id: f.id });
  res.json({ ok: true });
}));

/* ================= emergency map (anyone) ================= */
router.get('/emergency/facilities', ah(async (req, res) => {
  const q = query(req, { lat: t.lat({ required: true }), lng: t.lng({ required: true }), service: t.enum(SERVICES), radiusKm: t.num({ min: 1, max: 200 }) });
  await RL.limitIp(req, 'emfac', 120, 3600);
  const list = await finder({ from: { lat: q.lat, lng: q.lng }, service: q.service || null, radiusKm: q.radiusKm || 30, includePlatform: true, includePublic: true, exceptOrgIds: [] });
  // the public view: names, distance, numbers, emergency status; no bed counts
  res.json({ facilities: list.filter(x => x.source === 'public' ? (x.services || []).includes('emergency') || x.open24h || x.level === 'tertiary' : x.takingEmergencies !== false).slice(0, 40).map(x => ({ id: x.id, source: x.source, name: x.name, kind: x.kind, level: x.level || null, address: x.address, location: x.location, distanceKm: x.distanceKm, etaMin: x.etaMin,
    phones: (x.phones || []).filter(p => ['main', 'emergency', 'ambulance'].includes(p.kind)), open24h: !!x.open24h, takingEmergencies: x.source === 'platform' ? x.takingEmergencies : null, verified: !!x.verified })), national: S.get('content.global.emergencyNumbers', '112') });
}));

/* ================= transfers ================= */
const trG = [A.requireStaff({ perm: 'transfer.manage' }), transfersOn];
function transferView(x, full) {
  const v = { id: x.id, number: x.number, patientId: x.patientId, patientName: x.patientName, target: x.target, reason: x.reason, urgency: x.urgency, status: x.status, createdAt: x.createdAt, createdByName: x.createdByName, log: x.log || [],
    pack: x.packHash ? { expiresAt: x.packExpiresAt, views: x.packViews || 0, revoked: !!x.packRevoked } : null, incidentId: x.incidentId || null, referralId: x.referralId || null };
  if (full) v.clinicalNote = x.clinicalNote || null;
  return v;
}
router.post('/transfers', ...trG, ah(async (req, res) => {
  const b = body(req, { patientId: t.id({ required: true }), facilityId: t.id({ required: true }), reason: t.text({ required: true, max: 1000 }), clinicalNote: t.text({ max: 2000 }), urgency: t.enum(URGENCY, { default: 'emergency' }) });
  const { patient } = await P.requireLinked(req, b.patientId);
  const f = await db.col('public_facilities').findOne({ id: b.facilityId, status: 'active' });
  if (!f) throw notFound('Choose a hospital from the finder. Hospitals on MediCore get a referral instead.');
  const n = await nextNumber('transfer_' + req.ctx.org.id);
  const x = { id: id('trf'), number: 'TR' + String(n).padStart(6, '0'), fromOrgId: req.ctx.org.id, patientId: patient.id, patientName: patient.firstName + ' ' + patient.lastName, target: { kind: 'public', id: f.id, name: f.name, phones: f.phones || [], location: f.location || null },
    reason: b.reason, clinicalNote: b.clinicalNote || null, urgency: b.urgency || 'emergency', status: 'requested', createdAt: now(), createdBy: req.ctx.user.id, createdByName: req.ctx.user.name, log: [{ at: now(), outcome: 'requested', byName: req.ctx.user.name, note: null }] };
  await db.col('transfers').insertOne(x);
  await audit(req, 'transfer.create', { type: 'transfer', id: x.id, patientId: patient.id }, { facilityId: f.id, urgency: x.urgency });
  res.json(transferView(x, true));
}));
router.get('/transfers', A.requireStaff({ anyPerm: ['transfer.manage', 'ambulance.dispatch'] }), transfersOn, ah(async (req, res) => {
  const q = query(req, { patientId: t.id(), open: t.bool() });
  const f = { fromOrgId: req.ctx.org.id }; if (q.patientId) f.patientId = q.patientId; if (q.open) f.status = { $nin: ['arrived', 'cancelled', 'declined'] };
  res.json((await db.col('transfers').find(f, { sort: { createdAt: -1 }, limit: 200 })).map(x => transferView(x)));
}));
router.get('/transfers/:id', A.requireStaff({ anyPerm: ['transfer.manage', 'ambulance.dispatch'] }), transfersOn, ah(async (req, res) => {
  const x = await db.col('transfers').findOne({ id: param(req, 'id'), fromOrgId: req.ctx.org.id });
  if (!x) throw notFound('Transfer not found');
  res.json(transferView(x, true));
}));
router.post('/transfers/:id/log', ...trG, ah(async (req, res) => {
  const b = body(req, { outcome: t.enum(OUTCOMES, { required: true }), contactName: t.str({ max: 100, plain: true }), numberCalled: t.str({ max: 24 }), note: t.text({ max: 500 }) });
  const e = { at: now(), outcome: b.outcome, contactName: b.contactName || null, numberCalled: b.numberCalled ? normAnyPhone(b.numberCalled) : null, note: b.note || null, byName: req.ctx.user.name };
  const x = await db.col('transfers').findOneAndUpdate({ id: param(req, 'id'), fromOrgId: req.ctx.org.id, status: { $nin: ['arrived', 'cancelled'] } }, { $set: { status: b.outcome, updatedAt: now() }, $push: { log: e } });
  if (!x) throw conflict('This transfer is closed');
  await audit(req, 'transfer.' + b.outcome, { type: 'transfer', id: x.id, patientId: x.patientId });
  res.json(transferView(x, true));
}));
/** a transfer pack for a hospital that is not on MediCore: link + code, both shown once */
router.post('/transfers/:id/pack', ...trG, ah(async (req, res) => {
  const x = await db.col('transfers').findOne({ id: param(req, 'id'), fromOrgId: req.ctx.org.id });
  if (!x) throw notFound('Transfer not found');
  if (['arrived', 'cancelled'].includes(x.status)) throw conflict('This transfer is closed');
  const { patient } = await P.requireLinked(req, x.patientId);
  const snapshot = await require('./network').buildSnapshot(req, patient);
  const token = crypto.randomBytes(18).toString('base64url'); const code = digits(6);
  const hours = Number(S.get('process.transfers.packHours', 72)) || 72;
  await db.col('transfers').updateOne({ id: x.id }, { $set: { packHash: sha256('tp:' + token), packCodeHash: sha256('tpc:' + x.id + ':' + code), packExpiresAt: now() + hours * 3600e3, packViews: 0, packFails: 0, packRevoked: false, snapshot, packCreatedAt: now(), packCreatedBy: req.ctx.user.id } });
  await audit(req, 'transfer.pack', { type: 'transfer', id: x.id, patientId: x.patientId }, { hours });
  const base = (require('../config').PUBLIC_URL || '').replace(/\/$/, '');
  const path = '/register.html#/transfer/' + token;
  res.json({ link: (base || '') + path, path, code, expiresAt: now() + hours * 3600e3, message: 'Patient transfer from ' + req.ctx.org.name + ' (' + x.number + '). Open ' + (base || '') + path + ' and enter the code we give you by phone. Valid for ' + hours + ' hours.' });
}));
router.post('/transfers/:id/pack/revoke', ...trG, ah(async (req, res) => {
  const x = await db.col('transfers').findOneAndUpdate({ id: param(req, 'id'), fromOrgId: req.ctx.org.id }, { $set: { packRevoked: true } });
  if (!x) throw notFound('Transfer not found');
  await audit(req, 'transfer.pack_revoke', { type: 'transfer', id: x.id, patientId: x.patientId });
  res.json({ ok: true });
}));
/** send an ambulance: this provider's own service, or another ambulance service it picks */
router.post('/transfers/:id/ambulance', ...trG, ah(async (req, res) => {
  const b = body(req, { ambulanceOrgId: t.id() });
  const x = await db.col('transfers').findOne({ id: param(req, 'id'), fromOrgId: req.ctx.org.id });
  if (!x) throw notFound('Transfer not found');
  if (x.incidentId) throw conflict('An ambulance is already requested for this transfer');
  const AMB = require('./ambulance');
  const from = req.ctx.org.location && req.ctx.org.location.lat != null ? req.ctx.org.location : null;
  if (!from) throw bad('Set your provider\'s map location in Admin first, so the ambulance knows where to come');
  const route = await AMB.routeProvider(from, b.ambulanceOrgId || ((req.ctx.org.modules || []).includes('ambulance') ? req.ctx.org.id : null));
  const patient = await db.col('patients').findOne({ id: x.patientId });
  const inc = await AMB.createIncident({ org: route.org, source: 'transfer', caller: { name: req.ctx.org.name + ' (' + req.ctx.user.name + ')', phone: (req.ctx.org.contact || {}).phone || null }, patient, location: { lat: from.lat, lng: from.lng, address: (req.ctx.org.contact || {}).address || null, landmark: req.ctx.org.name },
    category: 'other', priority: x.urgency === 'emergency' ? 'P1' : x.urgency === 'urgent' ? 'P2' : 'P3', overrideBy: req.ctx.user.id, verified: true, note: 'Inter-facility transfer ' + x.number + ' to ' + x.target.name + '. ' + x.reason, createdBy: { by: req.ctx.user.id, byName: req.ctx.user.name }, noUnitAvailable: route.noUnitAvailable });
  await db.col('incidents').updateOne({ id: inc.id }, { $set: { destination: { orgId: null, name: x.target.name, lat: x.target.location ? x.target.location.lat : null, lng: x.target.location ? x.target.location.lng : null, address: null }, transferId: x.id } });
  if (route.org.id !== req.ctx.org.id) await P.ensureLink(route.org.id, x.patientId, req.ctx.user.id, 'emergency');
  await db.col('transfers').updateOne({ id: x.id }, { $set: { incidentId: inc.id, ambulanceOrgId: route.org.id }, $push: { log: { at: now(), outcome: 'requested', note: 'Ambulance requested from ' + route.org.name + ' (' + inc.number + ')' + (route.noUnitAvailable ? ', no unit free now' : ''), byName: req.ctx.user.name } } });
  await audit(req, 'transfer.ambulance', { type: 'transfer', id: x.id, patientId: x.patientId }, { incidentId: inc.id, ambulanceOrgId: route.org.id });
  res.json({ ok: true, incidentId: inc.id, incidentNumber: inc.number, ambulanceOrgName: route.org.name, noUnitAvailable: route.noUnitAvailable });
}));

/* ================= transfer pack (no account) ================= */
router.post('/public/transfer/:token', ah(async (req, res) => {
  const b = body(req, { code: t.str({ required: true, max: 6, label: 'Access code' }) });
  await RL.limitIp(req, 'tpack', 30, 3600);
  const token = String(req.params.token || '').slice(0, 64);
  const x = await db.col('transfers').findOne({ packHash: sha256('tp:' + token) });
  if (!x || x.packRevoked || !x.packExpiresAt || x.packExpiresAt < now()) throw notFound('This transfer link has expired or was withdrawn. Ask the sending hospital for a new one.');
  if ((x.packFails || 0) >= 5) throw forbidden('Too many wrong codes. Ask the sending hospital for a new link.');
  if ((x.packViews || 0) >= (Number(S.get('process.transfers.packMaxViews', 20)) || 20)) throw forbidden('This link has been opened too many times. Ask the sending hospital for a new one.');
  if (x.packCodeHash !== sha256('tpc:' + x.id + ':' + String(b.code).trim())) { await db.col('transfers').updateOne({ id: x.id }, { $inc: { packFails: 1 } }); throw bad('That access code is not correct.'); }
  await db.col('transfers').updateOne({ id: x.id }, { $inc: { packViews: 1 }, $push: { packOpens: { at: now(), ip: String(req.headers['x-nf-client-connection-ip'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim() } } });
  const org = await db.col('orgs').findOne({ id: x.fromOrgId });
  await audit(req, 'transfer.pack_open', { type: 'transfer', id: x.id, patientId: x.patientId, orgId: x.fromOrgId });
  await notify({ orgId: x.fromOrgId, role: 'frontdesk_manager', title: 'Transfer pack opened', body: x.number + ' was opened by the receiving hospital.', kind: 'transfer', ref: { type: 'transfer', id: x.id } });
  res.json({ number: x.number, urgency: x.urgency, reason: x.reason, clinicalNote: x.clinicalNote || null, target: { name: x.target.name }, createdAt: x.createdAt, createdByName: x.createdByName,
    from: { name: org ? org.name : null, phone: org ? (org.contact || {}).phone || null : null, address: org ? (org.contact || {}).address || null : null }, snapshot: x.snapshot || null, expiresAt: x.packExpiresAt });
}));

/* ================= demo ================= */
async function seedDemo() {
  // fictional public hospitals for the demo map (real ones are imported in HQ from a verified list)
  const demo = [
    ['Eko State Teaching Hospital (demo listing)', 'teaching', 'state', 'tertiary', 'Lagos', 'Ikeja', 6.5965, 3.3515, ['emergency', 'icu', 'nicu', 'maternity', 'trauma', 'burns', 'dialysis', 'surgery', 'blood_bank', 'ct_scan', 'neurosurgery'], '+2348000000101', '+2348000000102', '+2348000000103'],
    ['Federal Medical Centre Lagoon (demo listing)', 'federal_medical_centre', 'federal', 'tertiary', 'Lagos', 'Lagos Mainland', 6.4931, 3.3707, ['emergency', 'icu', 'maternity', 'surgery', 'paediatrics', 'psychiatry', 'oncology', 'cardiology', 'mri'], '+2348000000201', '+2348000000202', null],
    ['Island General Hospital (demo listing)', 'general', 'state', 'secondary', 'Lagos', 'Lagos Island', 6.4532, 3.3937, ['emergency', 'maternity', 'surgery', 'paediatrics', 'blood_bank'], '+2348000000301', '+2348000000302', null],
    ['Ajah Primary Health Centre (demo listing)', 'phc', 'lga', 'primary', 'Lagos', 'Eti-Osa', 6.4667, 3.5667, ['maternity'], '+2348000000401', null, null],
  ];
  for (const [name, kind, own, level, state, lga, lat, lng, services, main, em, tr] of demo) {
    const phones = [{ number: main, kind: 'main', label: null }]; if (em) phones.push({ number: em, kind: 'emergency', label: null }); if (tr) phones.push({ number: tr, kind: 'transfer', label: 'Referral desk' });
    await db.col('public_facilities').insertOne({ id: id('pfc'), name, kind, ownership: own, level, state, lga, address: lga + ', ' + state, location: { lat, lng }, phones, services, open24h: level !== 'primary', notes: 'Demo listing: the numbers are not real.', verified: false, status: 'active', source: 'demo', createdAt: now() });
  }
}

module.exports = { name: 'facilities', router, seedDemo, finder, SERVICES, normAnyPhone };
