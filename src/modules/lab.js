'use strict';
/*
 * Laboratory: per-lab catalogue and prices, orders (from a doctor anywhere, self-requested by a
 * patient, or a walk-in at the lab desk), sample reception with accession numbers, result entry,
 * verification, release, critical-value callbacks and amended reports.
 *
 * Works for a standalone lab (ClearPath) and a hospital lab (Grandville): every staff query is
 * scoped by labOrgId = the caller's provider; referring doctors see orders by referringOrgId.
 *
 * Rules (v1 audit fixes):
 *  - Flags (low/high/abnormal/critical) are computed on the server from the lab's own range.
 *    A flag sent by the client is never read.
 *  - Every status change is a conditional update from an allowed FROM state (TRANSITIONS).
 *  - An order becomes paid only through billing.onSettled('lab_order').
 *  - A released result is never overwritten: corrections create a new version with a reason.
 */
const express = require('express');
const db = require('../db');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param } = require('../lib/http');
const A = require('../lib/auth');
const { id, now, utcToLagos, haversineKm } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const RL = require('../lib/ratelimit');
const S = require('../lib/settings');
const P = require('./patients');
const orgs = require('./orgs');
const billing = require('./billing');
const labtests = require('../clinical/labtests');

db.index('lab_catalog', ['orgId', 'code'], { unique: true });
db.index('lab_orders', ['labOrgId', 'status', 'createdAt']);
db.index('lab_orders', ['referringOrgId', 'createdAt']);
db.index('lab_orders', ['patientId', 'createdAt']);
db.index('lab_orders', ['accession'], { unique: true, sparse: true });

const router = express.Router();

const TRANSITIONS = {
  awaiting_lab: ['ordered', 'cancelled'],
  ordered: ['paid', 'sample_collected', 'cancelled'], // ordered -> sample_collected only with an urgent override
  paid: ['sample_collected', 'cancelled'],
  sample_collected: ['in_progress'],
  in_progress: ['resulted'],
  resulted: ['verified', 'in_progress'], // back to in_progress = reopened for correction
  verified: ['released', 'in_progress'],
  released: [], // corrections after release are amendments (new version), status stays released
  cancelled: [],
};
const STATUS_LABEL = { awaiting_lab: 'Choose a lab', ordered: 'Awaiting payment', paid: 'Paid, awaiting sample', sample_collected: 'Sample collected', in_progress: 'Testing', resulted: 'Results entered', verified: 'Verified', released: 'Results ready', cancelled: 'Cancelled' };
const OPEN = ['ordered', 'paid', 'sample_collected', 'in_progress', 'resulted', 'verified'];
const PRIORITIES = ['routine', 'urgent'];

/* ---------------- catalogue helpers ---------------- */
const componentsOf = code => { const r = labtests.BY_CODE[code]; return r && r.panel ? r.panel.slice() : [code]; };
async function catalogMap(orgId) { const rows = await db.col('lab_catalog').find({ orgId }); return Object.fromEntries(rows.map(r => [r.code, r])); }
/** the lab's range for a code: reference list overridden by the lab's own values */
function rangeFor(cat, code) {
  const ref = labtests.BY_CODE[code];
  if (!ref) return null;
  const o = (cat[code] && cat[code].range) || {};
  const r = { unit: ref.unit, low: ref.low, high: ref.high, critLow: ref.critLow, critHigh: ref.critHigh, qualitative: ref.qualitative, normalText: ref.normalText };
  for (const k of ['unit', 'low', 'high', 'critLow', 'critHigh', 'normalText']) if (o[k] !== undefined && o[k] !== null) r[k] = o[k];
  return r;
}
const tatOf = (cat, code) => (cat[code] && cat[code].tatHours) || (labtests.BY_CODE[code] || {}).tatHours || 24;
function catalogView(entry, code) {
  const ref = labtests.BY_CODE[code || entry.code];
  return { code: ref.code, name: ref.name, loinc: ref.loinc, specimen: ref.specimen, panel: ref.panel ? ref.panel.map(c => ({ code: c, name: labtests.BY_CODE[c].name })) : null,
    priceKobo: entry ? entry.priceKobo : null, tatHours: entry && entry.tatHours ? entry.tatHours : ref.tatHours, active: entry ? !!entry.active : false, inCatalogue: !!entry,
    range: rangeFor(entry ? { [ref.code]: entry } : {}, ref.code), reference: { unit: ref.unit, low: ref.low, high: ref.high, critLow: ref.critLow, critHigh: ref.critHigh, qualitative: ref.qualitative, normalText: ref.normalText } };
}
async function labOrgOr404(orgId) {
  const o = orgId ? await db.col('orgs').findOne({ id: orgId, status: 'active' }) : null;
  if (!o || !(o.modules || []).includes('lab')) throw notFound('Laboratory not found');
  return o;
}
/** price every ordered code at this lab; throws if the lab does not offer one of them */
async function priceAt(labOrgId, codes) {
  const cat = await catalogMap(labOrgId);
  const missing = codes.filter(c => !(cat[c] && cat[c].active && Number.isInteger(cat[c].priceKobo)));
  if (missing.length) throw bad('This lab does not offer: ' + missing.join(', '), [{ field: 'tests', error: 'not offered', codes: missing }]);
  return { cat, lines: codes.map(c => ({ code: 'LAB-' + c, name: labtests.BY_CODE[c].name, category: 'lab', qty: 1, unitPriceKobo: cat[c].priceKobo })) };
}
function normTests(tests) {
  const codes = [...new Set((tests || []).map(x => String(typeof x === 'string' ? x : (x && x.code) || '').toUpperCase()))].filter(Boolean);
  if (!codes.length) throw bad('Choose at least one test');
  if (codes.length > 20) throw bad('Too many tests in one order (max 20)');
  const unknown = codes.filter(c => !labtests.BY_CODE[c]);
  if (unknown.length) throw bad('Unknown test code: ' + unknown.join(', '));
  return codes;
}

/* ---------------- orders ---------------- */
async function raiseBill(order, labOrgId, lines) {
  const bill = await billing.createBill({ orgId: labOrgId, patientId: order.patientId, lines, source: { type: 'lab_order', id: order.id }, createdBy: order.orderedByUserId || 'patient', note: 'Lab order ' + order.number });
  await db.col('lab_orders').updateOne({ id: order.id }, { $set: { billId: bill.id } });
  return bill;
}

/**
 * createLabOrder({ referringOrgId, labOrgId|null, patientId, tests:[{code}], orderedByUserId, orderedByName, encounterId, priority, clinicalNote })
 * labOrgId null -> status awaiting_lab (patient chooses the lab). Otherwise the lab must offer every test;
 * the patient is linked at the lab and a bill is raised from the lab's prices.
 * Extra optional fields used inside this module: selfRequested, source ('referral'|'self'|'walk_in'), referrerName.
 */
async function createLabOrder({ referringOrgId, labOrgId, patientId, tests, orderedByUserId, orderedByName, encounterId, priority, clinicalNote, selfRequested, source, referrerName }) {
  const codes = normTests(tests);
  if (!patientId) throw bad('Patient is required');
  if (priority && !PRIORITIES.includes(priority)) throw bad('Priority must be routine or urgent');
  let priced = null;
  if (labOrgId) { await labOrgOr404(labOrgId); priced = await priceAt(labOrgId, codes); }
  const refOrg = referringOrgId ? await orgs.getOrg(referringOrgId) : null;
  const cat = priced ? priced.cat : {};
  const n = await orgs.nextNumber('lab_order');
  const t0 = now();
  const order = {
    id: id('lo'), number: 'LO' + String(n).padStart(6, '0'), referringOrgId: referringOrgId || null, referringOrgName: refOrg ? refOrg.name : null, referrerName: referrerName || null,
    labOrgId: labOrgId || null, patientId, tests: codes.map(c => ({ code: c, name: labtests.BY_CODE[c].name, components: componentsOf(c) })),
    orderedByUserId: orderedByUserId || null, orderedByName: orderedByName || null, encounterId: encounterId || null, priority: priority || 'routine', clinicalNote: clinicalNote ? String(clinicalNote).slice(0, 1000) : null,
    selfRequested: !!selfRequested, source: source || (selfRequested ? 'self' : 'referral'),
    status: labOrgId ? 'ordered' : 'awaiting_lab', paid: false, paidVia: null, billId: null, accession: null, specimen: null, results: [], hasUnverified: false,
    enteredBy: null, verifiedBy: null, releasedAt: null, version: 0, versions: [], amendments: [], critical: { has: false, acknowledged: false, callbacks: [] },
    tatHours: labOrgId ? Math.max(...codes.map(c => tatOf(cat, c))) : null, times: { created: t0 }, timeline: [{ status: labOrgId ? 'ordered' : 'awaiting_lab', at: t0, by: orderedByUserId || 'patient', byName: orderedByName || null }],
    createdAt: t0, sentAt: labOrgId ? t0 : null,
  };
  await db.col('lab_orders').insertOne(order);
  if (labOrgId) {
    await P.ensureLink(labOrgId, patientId, orderedByUserId || null, 'lab_order');
    const bill = await raiseBill(order, labOrgId, priced.lines);
    order.billId = bill.id;
    return (await db.col('lab_orders').findOne({ id: order.id })) || order;
  }
  return order;
}

billing.onSettled('lab_order', async (bill, how) => {
  const set = { paid: true, paidVia: how, 'times.paid': now() };
  const o = await db.col('lab_orders').findOneAndUpdate({ id: bill.source.id, labOrgId: bill.orgId, status: 'ordered' }, { $set: Object.assign({ status: 'paid' }, set), $push: { timeline: { status: 'paid', at: now(), by: 'billing', byName: how === 'hmo' ? 'HMO cover' : 'Payment' } } });
  if (!o) await db.col('lab_orders').updateOne({ id: bill.source.id, labOrgId: bill.orgId, paid: false }, { $set: set }); // e.g. sample collected earlier under an urgent override
});

async function transition(order, to, actor, extra = {}, fromList) {
  const from = fromList || Object.keys(TRANSITIONS).filter(s => TRANSITIONS[s].includes(to));
  const t0 = now();
  const upd = { $set: Object.assign({ status: to, ['times.' + to]: t0 }, extra.set || {}), $push: { timeline: { status: to, at: t0, by: actor.id, byName: actor.name, note: extra.note || null } } };
  if (extra.unset) upd.$unset = extra.unset;
  return db.col('lab_orders').findOneAndUpdate(Object.assign({ id: order.id, labOrgId: order.labOrgId, status: { $in: from } }, extra.filter || {}), upd);
}
const actor = req => ({ id: req.ctx.user.id, name: req.ctx.user.name });
async function myOrder(req, oid) {
  const o = await db.col('lab_orders').findOne({ id: oid || param(req, 'id'), labOrgId: req.ctx.org.id });
  if (!o) throw notFound('Lab order not found');
  return o;
}
const wrongState = async (oid, verb) => { const cur = await db.col('lab_orders').findOne({ id: oid }); return conflict('Cannot ' + verb + ': this order is ' + (cur ? STATUS_LABEL[cur.status].toLowerCase() : 'gone'), 'wrong_state'); };

/** server-side result computation: unknown codes rejected, flags from the lab's range, client flags never read */
function computeResults(order, cat, inputs, { requireAll }) {
  const allowed = [...new Set(order.tests.flatMap(x => x.components))];
  const seen = new Set();
  const out = [];
  for (const r of inputs) {
    const code = String(r.code).toUpperCase();
    if (!allowed.includes(code)) throw bad('Test ' + code + ' is not part of this order');
    if (seen.has(code)) throw bad('Test ' + code + ' appears twice');
    seen.add(code);
    const range = rangeFor(cat, code);
    const f = labtests.flag(range, r.value);
    out.push({ code, name: labtests.BY_CODE[code].name, value: String(r.value), unit: range.unit || '', flag: f.flag, critical: f.critical, comment: r.comment || null,
      range: { low: range.low, high: range.high, critLow: range.critLow, critHigh: range.critHigh, normalText: range.normalText, qualitative: !!range.qualitative } });
  }
  if (requireAll) { const missing = allowed.filter(c => !seen.has(c)); if (missing.length) throw bad('Enter a result for: ' + missing.join(', ')); }
  return out;
}
const resultRule = t.arr(t.obj({ code: t.str({ required: true, max: 12, upper: true }), value: t.str({ required: true, max: 200, label: 'Result value' }), comment: t.str({ max: 300 }) }), { required: true, min: 1, max: 60 });

function reportView(o, lab) {
  return { id: o.id, number: o.number, status: o.status, lab: lab ? { id: lab.id, name: lab.name, phone: (lab.contact || {}).phone || null, address: (lab.contact || {}).address || null } : null,
    referringOrgName: o.referringOrgName, orderedByName: o.orderedByName, selfRequested: !!o.selfRequested, accession: o.accession, collectedAt: o.specimen ? o.specimen.collectedAt : null,
    tests: o.tests.map(x => ({ code: x.code, name: x.name })), results: o.results, verifiedBy: o.verifiedBy ? { name: o.verifiedBy.name, at: o.verifiedBy.at } : null,
    releasedAt: o.releasedAt, version: o.version, amended: o.version > 1, amendments: (o.amendments || []).map(a => ({ version: a.version, reason: a.reason, at: a.at, byName: a.byName })),
    critical: o.critical && o.critical.has ? { has: true, acknowledged: !!o.critical.acknowledged } : { has: false, acknowledged: false } };
}
function summaryView(o) {
  const dueAt = o.specimen && o.specimen.collectedAt && o.tatHours ? o.specimen.collectedAt + o.tatHours * 3600e3 : null;
  const done = ['released', 'cancelled'].includes(o.status);
  return { id: o.id, number: o.number, status: o.status, statusLabel: STATUS_LABEL[o.status], priority: o.priority, tests: o.tests.map(x => ({ code: x.code, name: x.name })),
    accession: o.accession, paid: !!o.paid, paidVia: o.paidVia, billId: o.billId, collectedAt: o.specimen ? o.specimen.collectedAt : null, urgentOverride: !!(o.specimen && o.specimen.urgentOverride),
    tatHours: o.tatHours, dueAt, overdue: !!(dueAt && !done && now() > dueAt), minutesLeft: dueAt && !done ? Math.round((dueAt - now()) / 60000) : null,
    hasUnverified: !!o.hasUnverified, criticalPending: !!(o.critical && o.critical.has && !o.critical.acknowledged && o.status === 'released'),
    referringOrgName: o.referringOrgName, referrerName: o.referrerName, orderedByName: o.orderedByName, selfRequested: !!o.selfRequested, source: o.source, createdAt: o.createdAt, releasedAt: o.releasedAt, version: o.version };
}
async function withPatient(rows, orgId) {
  const ids = [...new Set(rows.map(r => r.patientId))];
  const ps = ids.length ? await db.col('patients').find({ id: { $in: ids } }) : [];
  const links = ids.length ? await db.col('patient_links').find({ orgId, patientId: { $in: ids } }) : [];
  return rows.map(r => { const p = ps.find(x => x.id === r.patientId); const l = links.find(x => x.patientId === r.patientId);
    return Object.assign(summaryView(r), { patient: p ? { id: p.id, name: p.firstName + ' ' + p.lastName, mrn: l ? l.mrn : null, age: P.age(p.dob), sex: p.sex || null } : null }); });
}

/**
 * resultsForPatient(req, patientId): released results the caller's provider may see:
 * its own lab's results, results it referred, and others only when the patient shares history
 * with it (self-requested tests are the patient's alone).
 */
async function resultsForPatient(req, patientId) {
  const orgId = req.ctx.org.id;
  const shares = await P.sharesWith(orgId, patientId);
  const mine = await P.groupOrgIds(req.ctx.org); // every branch of the caller's group
  const rows = await db.col('lab_orders').find({ patientId, status: 'released' }, { sort: { releasedAt: -1 } });
  const visible = rows.filter(o => mine.includes(o.labOrgId) || (o.referringOrgId && mine.includes(o.referringOrgId)) || (shares && !o.selfRequested));
  const labs = {}; for (const o of visible) if (!labs[o.labOrgId]) labs[o.labOrgId] = await orgs.getOrg(o.labOrgId);
  return visible.map(o => reportView(o, labs[o.labOrgId]));
}

/* ===================== public: labs and their tests ===================== */
router.get('/labs', ah(async (req, res) => {
  const q = query(req, { codes: t.str({ max: 300 }), lat: t.lat(), lng: t.lng() });
  const codes = q.codes ? normTests(q.codes.split(',').map(s => s.trim())) : [];
  const lf = { status: 'active', modules: 'lab', 'settings.marketplace': { $ne: false } };
  // provider mode: a patient sees the labs of their providers and their providers' partners
  if (req.ctx && req.ctx.kind === 'patient' && P.patientMode() === 'provider') {
    const sc = await P.patientScope(req); const ids = new Set(sc || []);
    const conns = await db.col('network_connections').find({ status: 'accepted', $or: [{ fromOrgId: { $in: [...ids] } }, { toOrgId: { $in: [...ids] } }] });
    conns.forEach(c => { ids.add(c.fromOrgId); ids.add(c.toOrgId); });
    lf.id = { $in: [...ids] }; delete lf['settings.marketplace'];
  }
  const rows = await db.col('orgs').find(lf);
  const from = q.lat != null && q.lng != null ? { lat: q.lat, lng: q.lng } : null;
  const out = [];
  for (const o of rows) {
    const cat = await catalogMap(o.id);
    if (codes.some(c => !(cat[c] && cat[c].active))) continue;
    out.push(Object.assign(orgs.publicOrg(o, from), { acceptsWalkIns: (o.settings || {}).acceptsWalkIns !== false, totalKobo: codes.length ? codes.reduce((s, c) => s + cat[c].priceKobo, 0) : null,
      tatHours: codes.length ? Math.max(...codes.map(c => tatOf(cat, c))) : null }));
  }
  out.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) || a.name.localeCompare(b.name));
  res.json(out);
}));
router.get('/labs/:orgId/tests', ah(async (req, res) => {
  const o = await labOrgOr404(param(req, 'orgId'));
  const rows = await db.col('lab_catalog').find({ orgId: o.id, active: true }, { sort: { code: 1 } });
  res.json({ lab: Object.assign(orgs.publicOrg(o), { acceptsWalkIns: (o.settings || {}).acceptsWalkIns !== false }),
    tests: rows.filter(r => labtests.BY_CODE[r.code]).map(r => { const v = catalogView(r); return { code: v.code, name: v.name, specimen: v.specimen, panel: v.panel, priceKobo: v.priceKobo, tatHours: v.tatHours }; }) });
}));

/* ===================== catalogue (lab.catalog) ===================== */
const labAny = A.requireStaff({ anyPerm: ['lab.receive', 'lab.result', 'lab.verify', 'lab.catalog', 'billing.cash', 'billing.create'], module: 'lab' });
router.get('/lab/catalog', labAny, ah(async (req, res) => {
  const cat = await catalogMap(req.ctx.org.id);
  res.json(labtests.TESTS.map(r => catalogView(cat[r.code] || null, r.code)));
}));
const numOrNull = () => t.num({ min: -1e6, max: 1e6 });
router.put('/lab/catalog/:code', A.requireStaff({ perm: 'lab.catalog', module: 'lab' }), ah(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!labtests.BY_CODE[code]) throw notFound('Unknown test code');
  const b = body(req, { priceKobo: t.money({ min: 0, max: 1000000000 }), tatHours: t.int({ min: 1, max: 24 * 60 }), active: t.bool(),
    range: t.obj({ unit: t.str({ max: 20 }), low: numOrNull(), high: numOrNull(), critLow: numOrNull(), critHigh: numOrNull(), normalText: t.str({ max: 80 }) }) });
  const orgId = req.ctx.org.id;
  const cur = await db.col('lab_catalog').findOne({ orgId, code });
  const price = b.priceKobo !== undefined ? b.priceKobo : cur ? cur.priceKobo : null;
  const active = b.active !== undefined ? b.active : cur ? cur.active : true;
  if (active && !Number.isInteger(price)) throw bad('Set a price before offering this test');
  if (b.range && b.range.low != null && b.range.high != null && b.range.low > b.range.high) throw bad('Low limit must be below high limit');
  const set = { priceKobo: price, active, updatedAt: now(), updatedBy: req.ctx.user.id };
  if (b.tatHours !== undefined) set.tatHours = b.tatHours;
  if (b.range) set.range = b.range;
  const e = await db.col('lab_catalog').findOneAndUpdate({ orgId, code }, { $set: set, $setOnInsert: { id: id('lc'), orgId, code, createdAt: now() } }, { upsert: true });
  await audit(req, 'lab.catalog', { type: 'lab_catalog', id: e.id }, { code, priceKobo: e.priceKobo, active: e.active, range: !!b.range });
  res.json(catalogView(e));
}));

/* ===================== lab desk and worklist ===================== */
router.get('/lab/worklist', labAny, ah(async (req, res) => {
  const q = query(req, { status: t.enum(Object.keys(TRANSITIONS)), overdue: t.bool(), limit: t.int({ min: 1, max: 500 }) });
  const f = { labOrgId: req.ctx.org.id, status: q.status ? q.status : { $in: OPEN } };
  let rows = await db.col('lab_orders').find(f, { sort: { createdAt: 1 }, limit: q.limit || 200 });
  if (!q.status) { const crit = await db.col('lab_orders').find({ labOrgId: req.ctx.org.id, status: 'released', 'critical.has': true, 'critical.acknowledged': false }); rows = rows.concat(crit); }
  let out = await withPatient(rows, req.ctx.org.id);
  if (q.overdue) out = out.filter(o => o.overdue);
  out.sort((a, b) => (b.criticalPending - a.criticalPending) || ((b.priority === 'urgent') - (a.priority === 'urgent')) || (b.overdue - a.overdue) || a.createdAt - b.createdAt);
  res.json(out);
}));
router.get('/lab/accession/:acc', labAny, ah(async (req, res) => {
  const acc = String(req.params.acc || '').toUpperCase();
  if (!/^[A-Z0-9-]{4,40}$/.test(acc)) throw notFound('Accession not found');
  const o = await db.col('lab_orders').findOne({ accession: acc, labOrgId: req.ctx.org.id });
  if (!o) throw notFound('Accession not found');
  res.json((await withPatient([o], req.ctx.org.id))[0]);
}));
router.get('/lab/orders/:id', labAny, ah(async (req, res) => {
  const o = await myOrder(req);
  const [sum] = await withPatient([o], req.ctx.org.id);
  await audit(req, 'lab.view', { type: 'lab_order', id: o.id, patientId: o.patientId });
  res.json(Object.assign(sum, { clinicalNote: o.clinicalNote, specimen: o.specimen, results: o.results, enteredBy: o.enteredBy, verifiedBy: o.verifiedBy, versions: o.versions, amendments: o.amendments,
    critical: o.critical, timeline: o.timeline, components: o.tests.map(x => ({ code: x.code, components: x.components.map(c => ({ code: c, name: labtests.BY_CODE[c].name })) })) }));
}));
/* walk-in order at the lab desk (patient registered or linked through /api/fd/patients first) */
router.post('/lab/orders', A.requireStaff({ anyPerm: ['lab.receive', 'billing.create'], module: 'lab' }), A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { patientId: t.id({ required: true }), tests: t.arr(t.str({ max: 12, upper: true }), { required: true, min: 1, max: 20 }), priority: t.enum(PRIORITIES), clinicalNote: t.text({ max: 1000 }), referrerName: t.str({ max: 120 }) });
  await P.requireLinked(req, b.patientId);
  const o = await createLabOrder({ referringOrgId: null, labOrgId: req.ctx.org.id, patientId: b.patientId, tests: b.tests, orderedByUserId: req.ctx.user.id, orderedByName: req.ctx.user.name, priority: b.priority, clinicalNote: b.clinicalNote, source: 'walk_in', referrerName: b.referrerName });
  await audit(req, 'lab.order_walkin', { type: 'lab_order', id: o.id, patientId: o.patientId }, { tests: o.tests.map(x => x.code) });
  res.json(summaryView(o));
}));
router.post('/lab/orders/:id/receive', A.requireStaff({ perm: 'lab.receive', module: 'lab' }), A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { urgentOverride: t.obj({ reason: t.str({ required: true, min: 5, max: 300 }) }), specimenNote: t.str({ max: 200 }) });
  const o = await myOrder(req);
  let from = ['paid'];
  if (o.status === 'ordered') {
    if (!b.urgentOverride) throw conflict('This order is not paid yet. Collect payment first, or use an urgent override with a reason.', 'payment_required');
    if (o.priority !== 'urgent') throw forbidden('Only urgent orders can be collected before payment');
    if (!S.get('process.lab.collectBeforePaymentForUrgent', true, req.ctx.org)) throw forbidden('Collecting before payment is switched off. Collect payment first.');
    from = ['ordered'];
  }
  const org = req.ctx.org; const d = utcToLagos(now()).date.replace(/-/g, '').slice(2);
  const accession = (org.code + '-' + d + '-' + String(await orgs.nextNumber('acc_' + org.id + '_' + d)).padStart(4, '0')).toUpperCase();
  const specimen = { collectedAt: now(), collectedBy: req.ctx.user.id, collectorName: req.ctx.user.name, types: [...new Set(o.tests.map(x => labtests.BY_CODE[x.code].specimen))], note: b.specimenNote || null,
    urgentOverride: from[0] === 'ordered' ? { reason: b.urgentOverride.reason, by: req.ctx.user.id, at: now() } : null };
  const u = await transition(o, 'sample_collected', actor(req), { set: { accession, barcode: accession, specimen }, note: specimen.urgentOverride ? 'Urgent override: collected before payment' : null }, from);
  if (!u) throw await wrongState(o.id, 'collect the sample');
  await audit(req, specimen.urgentOverride ? 'lab.receive_urgent_override' : 'lab.receive', { type: 'lab_order', id: u.id, patientId: u.patientId }, { accession, override: !!specimen.urgentOverride, reason: specimen.urgentOverride ? b.urgentOverride.reason : undefined });
  res.json(summaryView(u));
}));
router.post('/lab/orders/:id/start', A.requireStaff({ perm: 'lab.result', module: 'lab' }), A.requireOnShift, ah(async (req, res) => {
  const o = await myOrder(req);
  const u = await transition(o, 'in_progress', actor(req), {}, ['sample_collected']);
  if (!u) throw await wrongState(o.id, 'start testing');
  await audit(req, 'lab.start', { type: 'lab_order', id: u.id, patientId: u.patientId });
  res.json(summaryView(u));
}));
router.post('/lab/orders/:id/results', A.requireStaff({ perm: 'lab.result', module: 'lab' }), A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { results: resultRule });
  const o = await myOrder(req);
  if (o.status !== 'in_progress') throw conflict('Results can only be entered while the order is in progress', 'wrong_state');
  const results = computeResults(o, await catalogMap(o.labOrgId), b.results, { requireAll: true });
  const hasUnverified = results.some(r => r.flag === 'unverified');
  const u = await transition(o, 'resulted', actor(req), { set: { results, hasUnverified, enteredBy: { userId: req.ctx.user.id, name: req.ctx.user.name, at: now() } } }, ['in_progress']);
  if (!u) throw await wrongState(o.id, 'enter results');
  await audit(req, 'lab.result', { type: 'lab_order', id: u.id, patientId: u.patientId }, { count: results.length, unverified: hasUnverified });
  res.json(Object.assign(summaryView(u), { results: u.results }));
}));
router.post('/lab/orders/:id/reopen', A.requireStaff({ anyPerm: ['lab.result', 'lab.verify'], module: 'lab' }), A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 5, max: 300 }) });
  const o = await myOrder(req);
  const u = await transition(o, 'in_progress', actor(req), { note: 'Reopened: ' + b.reason, set: { verifiedBy: null } }, ['resulted', 'verified']);
  if (!u) throw await wrongState(o.id, 'reopen');
  await audit(req, 'lab.reopen', { type: 'lab_order', id: u.id, patientId: u.patientId }, { reason: b.reason });
  res.json(summaryView(u));
}));
router.post('/lab/orders/:id/verify', A.requireStaff({ perm: 'lab.verify', module: 'lab' }), A.requireOnShift, ah(async (req, res) => {
  const o = await myOrder(req);
  if (o.status !== 'resulted') throw await wrongState(o.id, 'verify');
  if (o.hasUnverified) throw conflict('Some values are not valid numbers. Reopen the order and correct them before verifying.', 'unverified_values');
  if (((req.ctx.org.settings || {}).twoStepLabVerify || S.get('process.lab.twoStepVerifyDefault', false, req.ctx.org)) && o.enteredBy && o.enteredBy.userId === req.ctx.user.id) throw forbidden('Two-step verification is on: a different scientist must verify results you entered');
  const u = await transition(o, 'verified', actor(req), { set: { verifiedBy: { userId: req.ctx.user.id, name: req.ctx.user.name, at: now() } }, filter: { hasUnverified: false } }, ['resulted']);
  if (!u) throw await wrongState(o.id, 'verify');
  await audit(req, 'lab.verify', { type: 'lab_order', id: u.id, patientId: u.patientId });
  res.json(summaryView(u));
}));
async function notifyRelease(o, lab, amended) {
  const patient = await db.col('patients').findOne({ id: o.patientId });
  const pname = patient ? patient.firstName + ' ' + patient.lastName : 'Patient';
  await notify({ patientId: o.patientId, title: amended ? 'Your lab report was updated' : 'Your lab result is ready', body: 'From ' + lab.name + '. Open the MediCore app to view it.', kind: 'lab_result', ref: { type: 'lab_order', id: o.id }, sms: patient && !amended ? patient.phone : null });
  if (o.referringOrgId && o.orderedByUserId) await notify({ userId: o.orderedByUserId, title: (amended ? 'Amended lab report: ' : 'Lab result released: ') + pname, body: o.tests.map(x => x.name).join(', ') + ' from ' + lab.name, kind: 'lab_result', ref: { type: 'lab_order', id: o.id } });
  const crit = o.results.filter(r => r.critical);
  if (crit.length) {
    const msg = { title: 'URGENT: critical lab value for ' + pname, body: crit.map(r => r.name + ' ' + r.value + ' ' + r.unit).join('; ') + '. Please acknowledge.', kind: 'lab_critical', ref: { type: 'lab_order', id: o.id } };
    if (o.referringOrgId && !o.selfRequested) {
      if (o.orderedByUserId) await notify(Object.assign({ userId: o.orderedByUserId }, msg));
      await notify(Object.assign({ orgId: o.referringOrgId, role: 'doctor' }, msg));
    } else {
      await notify({ patientId: o.patientId, title: 'Please contact ' + lab.name + ' today', body: 'The lab needs to speak with you about your result.', kind: 'lab_critical', ref: { type: 'lab_order', id: o.id }, sms: patient ? patient.phone : null });
    }
    await notify(Object.assign({ orgId: o.labOrgId, role: 'lab_manager' }, msg, { title: 'Critical value released: call back needed' }));
  }
}
router.post('/lab/orders/:id/release', A.requireStaff({ perm: 'lab.verify', module: 'lab' }), A.requireOnShift, ah(async (req, res) => {
  const o = await myOrder(req);
  const hasCrit = o.results.some(r => r.critical);
  const u = await transition(o, 'released', actor(req), { set: { releasedAt: now(), version: 1, critical: { has: hasCrit, acknowledged: false, callbacks: [], notifiedAt: hasCrit ? now() : null } } }, ['verified']);
  if (!u) throw await wrongState(o.id, 'release');
  await notifyRelease(u, req.ctx.org, false);
  await audit(req, 'lab.release', { type: 'lab_order', id: u.id, patientId: u.patientId }, { critical: hasCrit });
  res.json(summaryView(u));
}));
router.post('/lab/orders/:id/critical-callback', A.requireStaff({ anyPerm: ['lab.result', 'lab.verify'], module: 'lab' }), A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { to: t.str({ required: true, max: 120, label: 'Person informed' }), method: t.enum(['phone', 'in_person', 'other'], { default: 'phone' }), note: t.str({ max: 300 }) });
  const o = await myOrder(req);
  const cb = { to: b.to, method: b.method, note: b.note || null, at: now(), by: req.ctx.user.id, byName: req.ctx.user.name, side: 'lab' };
  const u = await db.col('lab_orders').findOneAndUpdate({ id: o.id, labOrgId: o.labOrgId, status: 'released', 'critical.has': true }, { $set: { 'critical.acknowledged': true, 'critical.acknowledgedAt': now() }, $push: { 'critical.callbacks': cb } });
  if (!u) throw conflict('This order has no released critical value', 'wrong_state');
  await audit(req, 'lab.critical_callback', { type: 'lab_order', id: u.id, patientId: u.patientId }, { method: b.method });
  res.json({ ok: true, critical: u.critical });
}));
router.post('/lab/orders/:id/amend', A.requireStaff({ perm: 'lab.verify', module: 'lab' }), A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 5, max: 300 }), results: resultRule });
  const o = await myOrder(req);
  if (o.status !== 'released') throw conflict('Only released results are amended. Before release, reopen the order instead.', 'wrong_state');
  const changes = computeResults(o, await catalogMap(o.labOrgId), b.results, { requireAll: false });
  if (changes.some(r => r.flag === 'unverified')) throw bad('Amended values must be valid for each test');
  const results = o.results.map(r => changes.find(c => c.code === r.code) || r);
  const prev = { version: o.version, results: o.results, verifiedBy: o.verifiedBy, releasedAt: o.releasedAt, supersededAt: now() };
  const amendment = { version: o.version + 1, reason: b.reason, at: now(), by: req.ctx.user.id, byName: req.ctx.user.name, codes: changes.map(c => c.code) };
  const hasCrit = results.some(r => r.critical);
  const critical = hasCrit ? { has: true, acknowledged: false, callbacks: (o.critical || {}).callbacks || [], notifiedAt: now() } : Object.assign({}, o.critical || {}, { has: false });
  const u = await db.col('lab_orders').findOneAndUpdate({ id: o.id, labOrgId: o.labOrgId, status: 'released', version: o.version },
    { $set: { results, version: o.version + 1, verifiedBy: { userId: req.ctx.user.id, name: req.ctx.user.name, at: now() }, releasedAt: now(), critical }, $push: { versions: prev, amendments: amendment, timeline: { status: 'released', at: now(), by: req.ctx.user.id, byName: req.ctx.user.name, note: 'Amended (v' + amendment.version + '): ' + b.reason } } });
  if (!u) throw conflict('This report changed while you were editing. Refresh and try again.', 'stale');
  await notifyRelease(u, req.ctx.org, true);
  await audit(req, 'lab.amend', { type: 'lab_order', id: u.id, patientId: u.patientId }, { version: u.version, codes: amendment.codes, reason: b.reason });
  res.json(Object.assign(summaryView(u), { results: u.results, amendments: u.amendments }));
}));
router.post('/lab/orders/:id/cancel', A.requireStaff({ perm: 'lab.receive', module: 'lab' }), A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 5, max: 300 }) });
  const o = await myOrder(req);
  const u = await transition(o, 'cancelled', actor(req), { note: b.reason, set: { cancelReason: b.reason } }, ['ordered', 'paid']);
  if (!u) throw await wrongState(o.id, 'cancel');
  await audit(req, 'lab.cancel', { type: 'lab_order', id: u.id, patientId: u.patientId }, { reason: b.reason });
  res.json(Object.assign(summaryView(u), { billNote: u.paid ? 'This order was paid. Raise a refund from the bill.' : 'Void the open bill at the front desk.' }));
}));

/* ===================== referring provider (doctor) ===================== */
const refG = A.requireStaff({ anyPerm: ['clinic.order_lab', 'clinic.consult'] });
router.get('/lab/referred', refG, ah(async (req, res) => {
  const q = query(req, { status: t.enum(Object.keys(TRANSITIONS)), patientId: t.id(), limit: t.int({ min: 1, max: 500 }) });
  const f = { referringOrgId: req.ctx.org.id, selfRequested: false }; if (q.status) f.status = q.status; if (q.patientId) f.patientId = q.patientId;
  const rows = await db.col('lab_orders').find(f, { sort: { createdAt: -1 }, limit: q.limit || 100 });
  const out = await withPatient(rows, req.ctx.org.id);
  const labs = {};
  for (const r of out) { const o = rows.find(x => x.id === r.id); if (o.labOrgId && !labs[o.labOrgId]) labs[o.labOrgId] = await orgs.getOrg(o.labOrgId); r.lab = o.labOrgId ? { id: o.labOrgId, name: labs[o.labOrgId].name } : null; }
  res.json(out);
}));
router.get('/lab/patient-results/:patientId', A.requireStaff({ anyPerm: ['clinic.consult', 'clinic.order_lab', 'lab.result', 'lab.verify'] }), ah(async (req, res) => {
  const pid = param(req, 'patientId');
  await P.requireLinked(req, pid);
  await audit(req, 'lab.results_view', { type: 'patient', id: pid, patientId: pid });
  res.json(await resultsForPatient(req, pid));
}));
router.post('/lab/referred/:id/ack-critical', refG, ah(async (req, res) => {
  const b = body(req, { note: t.str({ max: 300 }) });
  const cb = { to: req.ctx.user.name, method: 'app_ack', note: b.note || null, at: now(), by: req.ctx.user.id, byName: req.ctx.user.name, side: 'referrer' };
  const u = await db.col('lab_orders').findOneAndUpdate({ id: param(req, 'id'), referringOrgId: req.ctx.org.id, status: 'released', 'critical.has': true }, { $set: { 'critical.acknowledged': true, 'critical.acknowledgedAt': now() }, $push: { 'critical.callbacks': cb } });
  if (!u) throw notFound('Critical result not found');
  await audit(req, 'lab.critical_ack', { type: 'lab_order', id: u.id, patientId: u.patientId });
  res.json({ ok: true, critical: u.critical });
}));

/* ===================== patient ===================== */
async function patientOrderView(o) {
  const lab = o.labOrgId ? await orgs.getOrg(o.labOrgId) : null;
  const bill = o.billId ? await db.col('bills').findOne({ id: o.billId, patientId: o.patientId }) : null;
  return { id: o.id, number: o.number, status: o.status, statusLabel: STATUS_LABEL[o.status], tests: o.tests.map(x => ({ code: x.code, name: x.name })), priority: o.priority,
    lab: lab ? { id: lab.id, name: lab.name, phone: (lab.contact || {}).phone || null } : null, referringOrgName: o.referringOrgName, orderedByName: o.orderedByName, selfRequested: !!o.selfRequested,
    billId: o.billId, bill: bill ? { status: bill.status, totalKobo: bill.totalKobo, patientDueKobo: bill.patientDueKobo, paidKobo: bill.paidKobo } : null, paid: !!o.paid,
    resultReady: o.status === 'released', version: o.version, createdAt: o.createdAt, releasedAt: o.releasedAt };
}
router.get('/me/lab-orders', A.requirePatient, ah(async (req, res) => {
  const rows = await db.col('lab_orders').find(Object.assign({ patientId: req.ctx.patient.id }, await P.scopeFilter(req, ['labOrgId', 'referringOrgId'])), { sort: { createdAt: -1 }, limit: 200 });
  const out = []; for (const o of rows) out.push(await patientOrderView(o));
  res.json(out);
}));
router.post('/me/lab-orders/:id/send', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { labOrgId: t.id({ required: true }) });
  const o = await db.col('lab_orders').findOne({ id: param(req, 'id'), patientId: req.ctx.patient.id });
  if (!o) throw notFound('Lab order not found');
  if (o.status !== 'awaiting_lab') throw conflict('This order has already been sent to a lab', 'wrong_state');
  const lab = await labOrgOr404(b.labOrgId);
  if (!(await P.patientCanUse(req, lab.id)) && !(o.referringOrgId && await require('./network').arePartners(o.referringOrgId, lab.id))) throw forbidden('Choose a lab of your provider or one it works with.');
  const priced = await priceAt(lab.id, o.tests.map(x => x.code));
  const t0 = now();
  const u = await db.col('lab_orders').findOneAndUpdate({ id: o.id, patientId: req.ctx.patient.id, status: 'awaiting_lab' },
    { $set: { status: 'ordered', labOrgId: lab.id, sentAt: t0, 'times.ordered': t0, tatHours: Math.max(...o.tests.map(x => tatOf(priced.cat, x.code))) }, $push: { timeline: { status: 'ordered', at: t0, by: req.ctx.user.id, byName: 'Patient', note: null } } });
  if (!u) throw conflict('This order has already been sent to a lab', 'wrong_state');
  await P.ensureLink(lab.id, req.ctx.patient.id, req.ctx.user.id, 'lab_order');
  await raiseBill(u, lab.id, priced.lines);
  await audit(req, 'lab.send', { type: 'lab_order', id: u.id, patientId: u.patientId, orgId: lab.id }, { labOrgId: lab.id });
  res.json(await patientOrderView(await db.col('lab_orders').findOne({ id: u.id })));
}));
router.post('/me/lab-orders/:id/cancel', A.requirePatient, ah(async (req, res) => {
  const t0 = now();
  const u = await db.col('lab_orders').findOneAndUpdate({ id: param(req, 'id'), patientId: req.ctx.patient.id, status: 'awaiting_lab' }, { $set: { status: 'cancelled', 'times.cancelled': t0, cancelReason: 'Cancelled by patient' }, $push: { timeline: { status: 'cancelled', at: t0, by: req.ctx.user.id, byName: 'Patient' } } });
  if (!u) throw conflict('Only orders not yet sent to a lab can be cancelled here. Contact the lab.', 'wrong_state');
  await audit(req, 'lab.cancel_patient', { type: 'lab_order', id: u.id, patientId: u.patientId, orgId: null });
  res.json(await patientOrderView(u));
}));
router.post('/me/lab-requests', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { labOrgId: t.id({ required: true }), tests: t.arr(t.str({ max: 12, upper: true }), { required: true, min: 1, max: 20 }) });
  await RL.limit('labreq_' + req.ctx.patient.id, 10, 3600);
  const lab = await labOrgOr404(b.labOrgId);
  if (!(await P.patientCanUse(req, lab.id))) throw forbidden('You can request tests from labs you are registered with. Ask the lab to register you, or apply to join it in the app.');
  if ((lab.settings || {}).acceptsWalkIns === false) throw forbidden('This lab only accepts tests ordered by a doctor');
  const o = await createLabOrder({ referringOrgId: null, labOrgId: lab.id, patientId: req.ctx.patient.id, tests: b.tests, orderedByUserId: null, orderedByName: null, priority: 'routine', selfRequested: true, source: 'self' });
  await audit(req, 'lab.self_request', { type: 'lab_order', id: o.id, patientId: o.patientId, orgId: lab.id }, { tests: o.tests.map(x => x.code) });
  res.json(await patientOrderView(o));
}));
router.get('/me/lab-orders/:id/report', A.requirePatient, ah(async (req, res) => {
  const o = await db.col('lab_orders').findOne({ id: param(req, 'id'), patientId: req.ctx.patient.id });
  if (!o) throw notFound('Lab order not found');
  if (o.status !== 'released') throw conflict('Your results are not ready yet', 'not_ready');
  res.json(reportView(o, await orgs.getOrg(o.labOrgId)));
}));

/* ===================== demo data ===================== */
const PRICES = {
  // code: [ClearPath NGN, Grandville NGN]
  FBC: [6500, 6000], MP: [2500, 2000], MRDT: [2000, 1500], WIDAL: [3000, 2500], FBS: [2000, 1800], RBS: [1500, 1500], HBA1C: [12000, 11000], 'E-U-CR': [15000, 14000],
  LFT: [18000, 16500], LIPID: [16000, 15000], URINE: [2500, 2000], UCS: [9000, 8500], HIV: [5000, 4000], HBSAG: [4000, 3500], HCV: [6000, 5500], VDRL: [3500, 3000],
  PREG: [2500, 2000], GENO: [4000, 3500], BGRP: [2000, 1500], PSA: [15000, 14000], TSH: [14000, 13000], INR: [8000, 7500], ESR: [2000, 1500], STOOL: [3000, 2500],
};
async function seedDemo(ctx) {
  const lab = ctx.orgs.lab; const hosp = ctx.orgs.hospital; const clinic = ctx.orgs.clinic;
  const t0 = now();
  for (const [code, [cp, gv]] of Object.entries(PRICES)) {
    await db.col('lab_catalog').insertOne({ id: id('lc'), orgId: lab.id, code, priceKobo: cp * 100, tatHours: null, active: true, range: null, createdAt: t0, demo: true });
    await db.col('lab_catalog').insertOne({ id: id('lc'), orgId: hosp.id, code, priceKobo: gv * 100, tatHours: null, active: true, range: null, createdAt: t0, demo: true });
  }
  // hospital lab uses its own haemoglobin range for women and a faster FBC turnaround
  await db.col('lab_catalog').insertOne({ id: id('lc'), orgId: hosp.id, code: 'HB', priceKobo: 250000, active: true, range: { low: 12, high: 16 }, createdAt: t0, demo: true });
  await db.col('lab_catalog').updateOne({ orgId: hosp.id, code: 'FBC' }, { $set: { tatHours: 2 } });

  const sci = ctx.staff.lab.scientist.user; const mgr = ctx.staff.lab.manager.user; const rec = ctx.staff.lab.reception.user;
  const drAda = ctx.staff.clinic['dr.ada'].user; const drTunde = ctx.staff.hospital['dr.tunde'].user; const hl = ctx.staff.hospital.lab.user;
  const tl = (status, at, u, note) => ({ status, at, by: u.id, byName: u.name, note: note || null });

  // 1. Amaka: FBC + malaria at ClearPath, referred by Lekki Family Clinic, released
  let o = await createLabOrder({ referringOrgId: clinic.id, labOrgId: lab.id, patientId: ctx.patients.amaka.id, tests: [{ code: 'FBC' }, { code: 'MP' }], orderedByUserId: drAda.id, orderedByName: drAda.name, priority: 'routine', clinicalNote: 'Fever for 3 days' });
  await billing.applyToBill(o.billId, (await db.col('bills').findOne({ id: o.billId })).totalKobo, 'cash');
  o = await db.col('lab_orders').findOne({ id: o.id });
  const T = t0 - 2 * 86400e3; const h = 3600e3;
  const results = computeResults(o, await catalogMap(lab.id), [{ code: 'HB', value: '10.9' }, { code: 'WBC', value: '7.2' }, { code: 'PLT', value: '210' }, { code: 'PCV', value: '33' }, { code: 'MP', value: 'Seen (+)' }], { requireAll: true });
  const acc1 = lab.code + '-DEMO-0001';
  await db.col('lab_orders').updateOne({ id: o.id }, { $set: { status: 'released', accession: acc1, barcode: acc1, specimen: { collectedAt: T + h, collectedBy: rec.id, collectorName: rec.name, types: ['Blood'], note: null, urgentOverride: null },
    results, hasUnverified: false, enteredBy: { userId: sci.id, name: sci.name, at: T + 3 * h }, verifiedBy: { userId: mgr.id, name: mgr.name, at: T + 3.5 * h }, releasedAt: T + 3.6 * h, version: 1,
    critical: { has: false, acknowledged: false, callbacks: [] }, createdAt: T, 'times.sample_collected': T + h, 'times.released': T + 3.6 * h },
    $push: { timeline: { $each: [tl('sample_collected', T + h, rec), tl('in_progress', T + 1.5 * h, sci), tl('resulted', T + 3 * h, sci), tl('verified', T + 3.5 * h, mgr), tl('released', T + 3.6 * h, mgr)] } } });

  // 2. Kunle: INR ordered at the clinic, waiting for him to choose a lab
  await createLabOrder({ referringOrgId: clinic.id, labOrgId: null, patientId: ctx.patients.kunle.id, tests: [{ code: 'INR' }], orderedByUserId: drAda.id, orderedByName: drAda.name, priority: 'routine', clinicalNote: 'On warfarin, routine INR check' });

  // 3. Tobi: RBS + E/U/Cr at the hospital's own lab, in progress
  o = await createLabOrder({ referringOrgId: hosp.id, labOrgId: hosp.id, patientId: ctx.patients.tobi.id, tests: [{ code: 'RBS' }, { code: 'E-U-CR' }], orderedByUserId: drTunde.id, orderedByName: drTunde.name, priority: 'urgent', clinicalNote: 'Diabetic, vomiting' });
  await billing.applyToBill(o.billId, (await db.col('bills').findOne({ id: o.billId })).totalKobo, 'cash');
  const acc2 = hosp.code + '-DEMO-0001';
  await db.col('lab_orders').updateOne({ id: o.id, status: 'paid' }, { $set: { status: 'in_progress', accession: acc2, barcode: acc2, specimen: { collectedAt: t0 - 30 * 60000, collectedBy: hl.id, collectorName: hl.name, types: ['Blood'], note: null, urgentOverride: null }, 'times.sample_collected': t0 - 30 * 60000, 'times.in_progress': t0 - 20 * 60000, createdAt: t0 - 45 * 60000 },
    $push: { timeline: { $each: [tl('sample_collected', t0 - 30 * 60000, hl), tl('in_progress', t0 - 20 * 60000, hl)] } } });
}

/** a lab's active tests as patients see them (marketplace) */
async function publicTests(orgId) {
  const rows = await db.col('lab_catalog').find({ orgId, active: true }, { sort: { code: 1 } });
  return rows.filter(r => labtests.BY_CODE[r.code]).map(r => { const v = catalogView(r); return { code: v.code, name: v.name, specimen: v.specimen, priceKobo: v.priceKobo, tatHours: v.tatHours }; });
}

module.exports = { name: 'lab', router, seedDemo, createLabOrder, resultsForPatient, publicTests, TRANSITIONS };
