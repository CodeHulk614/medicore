'use strict';
/*
 * Stores and capacity for every unit that is not the pharmacy (the pharmacy keeps its own batch inventory).
 *
 *  Store items   consumables, reagents, equipment, blood, vaccines, oxygen... per department (ward, theatre, lab,
 *                ambulance...). Every change is a movement in a ledger (receive, issue, adjust, count, waste), and the
 *                quantity only moves through a conditional $inc, so two people issuing at once cannot go below zero.
 *  Public items  an item marked public shows to patients on the provider's marketplace page as available / running
 *                low / out of stock (never the quantity), e.g. blood groups, oxygen, vaccines, delivery packs.
 *  Capacity      beds per ward (total and free) and whether the provider is taking emergencies now. Shown in the
 *                emergency transfer finder and, as "taking emergencies", on the marketplace.
 *
 * Pharmacy medicines are shown to patients from the pharmacy's own stock (publicPharmacyStock), never quantities.
 */
const express = require('express');
const db = require('../db');
const { ah, body, query, t, bad, notFound, conflict, param, forbidden } = require('../lib/http');
const A = require('../lib/auth');
const S = require('../lib/settings');
const { id, now, naira, todayLagos, daysBetween } = require('../lib/util');
const { audit } = require('../lib/audit');

db.index('store_items', ['orgId', 'dept', 'name']);
db.index('store_items', ['orgId', 'public']);
db.index('store_moves', ['orgId', 'itemId', 'at']);
db.index('capacity', ['orgId'], { unique: true });

const router = express.Router();
const DEPTS = ['general', 'ward', 'emergency', 'theatre', 'maternity', 'clinic', 'lab', 'ambulance', 'dialysis', 'radiology'];
const CATS = ['consumable', 'reagent', 'equipment', 'blood', 'vaccine', 'oxygen', 'linen', 'other'];
const WARDS = ['emergency', 'general', 'maternity', 'paediatric', 'icu', 'nicu', 'hdu', 'isolation', 'dialysis', 'theatre', 'psychiatric', 'burns'];
const MOVE_TYPES = ['receive', 'issue', 'adjust', 'count', 'waste', 'return'];
const featureOn = (req, res, next) => (S.feature('inventory', req.ctx && req.ctx.org) ? next() : next(forbidden('Stores are switched off on MediCore')));
const readG = [A.requireStaff({ anyPerm: ['inventory.read', 'inventory.manage', 'inventory.issue'] }), featureOn];
const manageG = [A.requireStaff({ perm: 'inventory.manage' }), featureOn];
const issueG = [A.requireStaff({ anyPerm: ['inventory.issue', 'inventory.manage'] }), featureOn];

function stockState(it) {
  if (!it.qty || it.qty <= 0) return 'out';
  if (it.reorderLevel && it.qty <= it.reorderLevel) return 'low';
  return 'in_stock';
}
function itemView(it) {
  const dte = it.expiry ? daysBetween(todayLagos(), it.expiry) : null;
  return Object.assign({}, it, { state: stockState(it), lowStock: stockState(it) !== 'in_stock', daysToExpiry: dte, nearExpiry: dte != null && dte >= 0 && dte <= 60, expired: dte != null && dte < 0 });
}
async function move(req, it, type, qty, balanceAfter, reason, extra) {
  const m = Object.assign({ id: id('smv'), orgId: it.orgId, itemId: it.id, type, qty, balanceAfter, reason: reason || null, by: req.ctx.user.id, byName: req.ctx.user.name, at: now() }, extra || {});
  await db.col('store_moves').insertOne(m);
  return m;
}
/** departments a provider can use: general always, the rest by its apps */
function deptsFor(org) {
  const mods = org.modules || [];
  return DEPTS.filter(d => (d === 'lab' ? mods.includes('lab') : d === 'ambulance' ? mods.includes('ambulance') : d === 'clinic' ? mods.includes('clinic') : true));
}

const itemRules = {
  name: t.str({ required: true, max: 120, plain: true, label: 'Item name' }), dept: t.enum(DEPTS, { required: true, label: 'Department' }), category: t.enum(CATS, { default: 'consumable' }),
  unit: t.str({ max: 30, plain: true }), reorderLevel: t.int({ min: 0, max: 10000000 }), location: t.str({ max: 80, plain: true }), costKobo: t.money({ max: naira(10000000) }),
  public: t.bool(), publicLabel: t.str({ max: 120, plain: true }), priceKobo: t.money({ max: naira(10000000) }), note: t.str({ max: 300, plain: true }),
};

router.get('/store/meta', ...readG, ah(async (req, res) => { res.json({ depts: deptsFor(req.ctx.org), categories: CATS, wards: WARDS, moveTypes: MOVE_TYPES }); }));
router.get('/store/items', ...readG, ah(async (req, res) => {
  const q = query(req, { dept: t.enum(DEPTS), q: t.str({ max: 60 }), low: t.bool(), includeInactive: t.bool() });
  const f = { orgId: req.ctx.org.id }; if (q.dept) f.dept = q.dept; if (!q.includeInactive) f.active = { $ne: false };
  let rows = (await db.col('store_items').find(f, { sort: { name: 1 }, limit: 3000 })).map(itemView);
  if (q.q) { const s = q.q.toLowerCase(); rows = rows.filter(r => r.name.toLowerCase().includes(s) || (r.location || '').toLowerCase().includes(s)); }
  if (q.low) rows = rows.filter(r => r.lowStock || r.nearExpiry || r.expired);
  res.json(rows);
}));
router.get('/store/alerts', ...readG, ah(async (req, res) => {
  const rows = (await db.col('store_items').find({ orgId: req.ctx.org.id, active: { $ne: false } }, { limit: 3000 })).map(itemView);
  res.json({ low: rows.filter(r => r.state === 'low').length, out: rows.filter(r => r.state === 'out').length, nearExpiry: rows.filter(r => r.nearExpiry).length, expired: rows.filter(r => r.expired).length,
    items: rows.filter(r => r.lowStock || r.nearExpiry || r.expired).slice(0, 50) });
}));
router.post('/store/items', ...manageG, ah(async (req, res) => {
  const b = body(req, Object.assign({}, itemRules, { qty: t.int({ min: 0, max: 10000000 }), expiry: t.date(), batchNo: t.str({ max: 40, plain: true }) }));
  if (!deptsFor(req.ctx.org).includes(b.dept)) throw bad('That department is not switched on for your provider');
  if (await db.col('store_items').findOne({ orgId: req.ctx.org.id, dept: b.dept, nameKey: b.name.toLowerCase(), active: { $ne: false } })) throw conflict('An item with that name already exists in this department');
  const it = { id: id('sti'), orgId: req.ctx.org.id, dept: b.dept, name: b.name, nameKey: b.name.toLowerCase(), category: b.category || 'consumable', unit: b.unit || null, qty: b.qty || 0, reorderLevel: b.reorderLevel || 0,
    location: b.location || null, costKobo: b.costKobo || 0, expiry: b.expiry || null, batchNo: b.batchNo || null, public: !!b.public, publicLabel: b.publicLabel || null, priceKobo: b.priceKobo == null ? null : b.priceKobo, note: b.note || null, active: true, createdAt: now(), createdBy: req.ctx.user.id };
  await db.col('store_items').insertOne(it);
  if (it.qty) await move(req, it, 'receive', it.qty, it.qty, 'Opening stock');
  await audit(req, 'store.item_create', { type: 'store_item', id: it.id }, { dept: it.dept, qty: it.qty });
  res.json(itemView(it));
}));
router.get('/store/items/:id', ...readG, ah(async (req, res) => {
  const it = await db.col('store_items').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!it) throw notFound('Item not found');
  res.json({ item: itemView(it), moves: await db.col('store_moves').find({ orgId: req.ctx.org.id, itemId: it.id }, { sort: { at: -1 }, limit: 100 }) });
}));
router.patch('/store/items/:id', ...manageG, ah(async (req, res) => {
  const rules = Object.assign({}, itemRules, { active: t.bool(), expiry: t.date(), batchNo: t.str({ max: 40, plain: true }) }); rules.name = t.str({ max: 120, plain: true }); rules.dept = t.enum(DEPTS);
  const b = body(req, rules);
  if (!Object.keys(b).length) throw bad('Nothing to change');
  if (b.dept && !deptsFor(req.ctx.org).includes(b.dept)) throw bad('That department is not switched on for your provider');
  const set = Object.assign({ updatedAt: now() }, b); if (b.name) set.nameKey = b.name.toLowerCase();
  const it = await db.col('store_items').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id }, { $set: set });
  if (!it) throw notFound('Item not found');
  await audit(req, 'store.item_update', { type: 'store_item', id: it.id }, { fields: Object.keys(b) });
  res.json(itemView(it));
}));
/** receive, issue, waste, return, or count (sets the quantity) */
router.post('/store/items/:id/move', A.requireStaff({ anyPerm: ['inventory.issue', 'inventory.manage'] }), featureOn, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { type: t.enum(MOVE_TYPES, { required: true }), qty: t.int({ required: true, min: 0, max: 10000000, label: 'Quantity' }), reason: t.str({ max: 200, plain: true }), expiry: t.date(), batchNo: t.str({ max: 40, plain: true }), patientId: t.id(), to: t.str({ max: 80, plain: true }) });
  const cur = await db.col('store_items').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id, active: { $ne: false } });
  if (!cur) throw notFound('Item not found');
  const manage = req.ctx.perms.includes('inventory.manage');
  if (['receive', 'adjust', 'count'].includes(b.type) && !manage) throw forbidden('Only store managers can receive stock or change counts');
  if (b.type !== 'count' && b.type !== 'adjust' && b.qty < 1) throw bad('Quantity must be at least 1');
  if (b.type === 'waste' && !b.reason) throw bad('Say why the stock is being written off');
  if (b.patientId) await require('./patients').requireLinked(req, b.patientId);
  let it;
  if (b.type === 'receive' || b.type === 'return') {
    const set = { updatedAt: now() }; if (b.expiry) set.expiry = b.expiry; if (b.batchNo) set.batchNo = b.batchNo;
    it = await db.col('store_items').findOneAndUpdate({ id: cur.id, orgId: cur.orgId }, { $inc: { qty: b.qty }, $set: set });
  } else if (b.type === 'issue' || b.type === 'waste') {
    it = await db.col('store_items').findOneAndUpdate({ id: cur.id, orgId: cur.orgId, qty: { $gte: b.qty } }, { $inc: { qty: -b.qty }, $set: { updatedAt: now() } });
    if (!it) throw conflict('Not enough in stock: ' + cur.qty + ' left', 'insufficient_stock');
  } else {
    // count or adjust: set the counted quantity, only if nobody moved it since it was read
    it = await db.col('store_items').findOneAndUpdate({ id: cur.id, orgId: cur.orgId, qty: cur.qty }, { $set: { qty: b.qty, countedAt: now(), updatedAt: now() } });
    if (!it) throw conflict('The stock changed while you were counting. Refresh and count again.');
  }
  const delta = b.type === 'count' || b.type === 'adjust' ? b.qty - cur.qty : b.type === 'issue' || b.type === 'waste' ? -b.qty : b.qty;
  const m = await move(req, it, b.type, delta, it.qty, b.reason, { patientId: b.patientId || null, to: b.to || null });
  await audit(req, 'store.' + b.type, { type: 'store_item', id: it.id, patientId: b.patientId || null }, { qty: delta });
  res.json({ item: itemView(it), move: m });
}));

/* ---------------- capacity: beds and emergencies ---------------- */
function capacityView(c) {
  if (!c) return { wards: [], acceptingEmergencies: null, note: null, updatedAt: null, totalBeds: 0, freeBeds: 0, stale: true };
  const wards = (c.wards || []).map(w => ({ key: w.key, total: w.total, available: Math.min(w.available, w.total) }));
  return { wards, acceptingEmergencies: c.acceptingEmergencies, note: c.note || null, updatedAt: c.updatedAt, updatedByName: c.updatedByName || null,
    totalBeds: wards.reduce((s, w) => s + w.total, 0), freeBeds: wards.reduce((s, w) => s + w.available, 0), stale: now() - (c.updatedAt || 0) > 24 * 3600e3 };
}
async function capacityOf(orgId) { return capacityView(await db.col('capacity').findOne({ orgId })); }
router.get('/store/capacity', A.requireStaff({}), ah(async (req, res) => { res.json(Object.assign(await capacityOf(req.ctx.org.id), { wardKeys: WARDS })); }));
router.put('/store/capacity', A.requireStaff({ perm: 'capacity.update' }), ah(async (req, res) => {
  const b = body(req, { wards: t.arr(t.obj({ key: t.enum(WARDS, { required: true }), total: t.int({ required: true, min: 0, max: 5000 }), available: t.int({ required: true, min: 0, max: 5000 }) }), { max: WARDS.length }), acceptingEmergencies: t.bool({ required: true }), note: t.str({ max: 200, plain: true }) });
  const seen = new Set(); for (const w of b.wards || []) { if (seen.has(w.key)) throw bad('Each ward can appear once'); seen.add(w.key); if (w.available > w.total) throw bad('Free beds cannot be more than total beds'); }
  const doc = { orgId: req.ctx.org.id, wards: b.wards || [], acceptingEmergencies: b.acceptingEmergencies, note: b.note || null, updatedAt: now(), updatedBy: req.ctx.user.id, updatedByName: req.ctx.user.name };
  await db.col('capacity').findOneAndUpdate({ orgId: req.ctx.org.id }, { $set: doc, $setOnInsert: { id: id('cap') } }, { upsert: true });
  await audit(req, 'capacity.update', { type: 'capacity', id: req.ctx.org.id }, { acceptingEmergencies: b.acceptingEmergencies, freeBeds: (b.wards || []).reduce((s, w) => s + w.available, 0) });
  res.json(await capacityOf(req.ctx.org.id));
}));

/* ---------------- what patients may see ---------------- */
/** public store items: name, department, state (in stock / low / out), price only when the provider shows prices */
async function publicStoreItems(org) {
  if ((org.settings || {}).showInventoryToPatients === false) return [];
  const rows = await db.col('store_items').find({ orgId: org.id, public: true, active: { $ne: false } }, { sort: { name: 1 }, limit: 300 });
  const prices = (org.settings || {}).showPricesToPatients !== false;
  return rows.map(r => ({ id: r.id, name: r.publicLabel || r.name, category: r.category, dept: r.dept, state: stockState(r), priceKobo: prices ? r.priceKobo : null, updatedAt: r.updatedAt || r.createdAt }));
}
/** the pharmacy's medicines as patients see them: name, form, strength, state, prescription-only, price when shown */
async function publicPharmacyStock(org, q, limit) {
  if ((org.settings || {}).showInventoryToPatients === false || !(org.modules || []).includes('pharmacy')) return [];
  let items = await db.col('pharmacy_items').find({ orgId: org.id, active: { $ne: false } }, { sort: { name: 1 }, limit: 3000 });
  if (q) { const s = q.toLowerCase(); items = items.filter(i => i.name.toLowerCase().includes(s) || (i.drugCode || '').toLowerCase() === s); }
  items = items.slice(0, limit || 60);
  const C = require('./pharmacy/common');
  const prices = (org.settings || {}).showPricesToPatients !== false;
  const out = [];
  for (const it of items) {
    const qty = await C.availableQty(org.id, it.id);
    const state = qty <= 0 ? 'out' : (it.reorderLevel && qty <= it.reorderLevel ? 'low' : 'in_stock');
    out.push({ id: it.id, name: it.name, form: it.form || null, strength: it.strength || null, rxOnly: !!it.rxOnly, controlled: !!it.controlled, state, priceKobo: prices && !it.controlled ? it.sellPriceKobo : null });
  }
  return out;
}

/* ================= demo ================= */
async function seedDemoAfter(ctx) {
  const put = async (org, items) => { for (const [dept, name, category, unit, qty, reorder, pub, label] of items) await db.col('store_items').insertOne({ id: id('sti'), orgId: org.id, dept, name, nameKey: name.toLowerCase(), category, unit, qty, reorderLevel: reorder, location: null, costKobo: 0, expiry: null, batchNo: null, public: !!pub, publicLabel: label || null, priceKobo: null, note: null, active: true, createdAt: now(), createdBy: 'demo' }); };
  const h = ctx.orgs.hospital;
  if (h) {
    await put(h, [['ward', 'IV giving sets', 'consumable', 'pieces', 140, 50], ['ward', 'Normal saline 500 ml', 'consumable', 'bags', 36, 40], ['theatre', 'Surgical gloves size 7.5', 'consumable', 'pairs', 400, 100],
      ['emergency', 'Blood O+ (units)', 'blood', 'units', 6, 4, true, 'Blood group O+'], ['emergency', 'Blood O- (units)', 'blood', 'units', 1, 2, true, 'Blood group O-'], ['emergency', 'Blood A+ (units)', 'blood', 'units', 0, 2, true, 'Blood group A+'],
      ['general', 'Oxygen cylinders (full)', 'oxygen', 'cylinders', 9, 4, true, 'Medical oxygen'], ['maternity', 'Delivery packs', 'consumable', 'packs', 12, 5, true, 'Delivery packs'], ['general', 'Tetanus toxoid vaccine', 'vaccine', 'doses', 40, 10, true, 'Tetanus vaccine']]);
    await db.col('capacity').insertOne({ id: id('cap'), orgId: h.id, wards: [{ key: 'emergency', total: 8, available: 2 }, { key: 'general', total: 60, available: 11 }, { key: 'maternity', total: 20, available: 4 }, { key: 'paediatric', total: 16, available: 5 }, { key: 'icu', total: 6, available: 1 }, { key: 'theatre', total: 3, available: 1 }], acceptingEmergencies: true, note: 'ICU has 1 bed. Call the emergency line before sending ventilated patients.', updatedAt: now() - 2 * 3600e3, updatedBy: 'demo', updatedByName: 'Kemi Bello' });
  }
  if (ctx.orgs.lab) await put(ctx.orgs.lab, [['lab', 'Glucose reagent kit', 'reagent', 'kits', 3, 4], ['lab', 'EDTA sample bottles', 'consumable', 'pieces', 600, 200], ['lab', 'Malaria RDT kits', 'reagent', 'tests', 75, 50]]);
  if (ctx.orgs.ambulance) await put(ctx.orgs.ambulance, [['ambulance', 'Oxygen masks (adult)', 'consumable', 'pieces', 30, 20], ['ambulance', 'Cervical collars', 'equipment', 'pieces', 6, 4], ['ambulance', 'Trauma dressings', 'consumable', 'packs', 14, 20]]);
  for (const [k, cap] of [['ikeja', { wards: [{ key: 'emergency', total: 6, available: 3 }, { key: 'general', total: 40, available: 9 }, { key: 'icu', total: 4, available: 0 }], acceptingEmergencies: true }], ['ajah', { wards: [{ key: 'emergency', total: 4, available: 0 }, { key: 'general', total: 24, available: 2 }, { key: 'paediatric', total: 10, available: 3 }], acceptingEmergencies: false, note: 'Emergency unit full until about 6 pm.' }]]) {
    const b = ctx.branches && ctx.branches[k]; if (b) await db.col('capacity').insertOne(Object.assign({ id: id('cap'), orgId: b.id, updatedAt: now() - 3600e3, updatedBy: 'demo', updatedByName: 'Demo' }, cap));
  }
  if (ctx.orgs.clinic) await db.col('capacity').insertOne({ id: id('cap'), orgId: ctx.orgs.clinic.id, wards: [{ key: 'general', total: 4, available: 4 }], acceptingEmergencies: false, note: 'Clinic: no emergency unit.', updatedAt: now() - 5 * 3600e3, updatedBy: 'demo' });
}

module.exports = { name: 'inventory', router, seedDemoAfter, capacityOf, capacityView, publicStoreItems, publicPharmacyStock, WARDS, DEPTS, stockState };
