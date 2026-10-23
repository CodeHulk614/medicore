'use strict';
/*
 * Inventory: items, batches, movement ledger, adjustments and counts, returns, recalls,
 * expiry write-off, suppliers, purchase orders, alerts and the controlled-drug register.
 * Every query is scoped to req.ctx.org.id.
 */
const express = require('express');
const db = require('../../db');
const { ah, body, query, t, bad, notFound, conflict, param } = require('../../lib/http');
const { id, now, naira } = require('../../lib/util');
const { audit } = require('../../lib/audit');
const { nextNumber } = require('../orgs');
const F = require('../../clinical/formulary');
const C = require('./common');

const router = express.Router();
const org = req => req.ctx.org.id;

/* ---------- items ---------- */
const itemRules = {
  drugCode: t.str({ max: 24, upper: true }), name: t.str({ max: 120 }), form: t.str({ max: 40 }), strength: t.str({ max: 40 }), unit: t.str({ max: 40 }),
  reorderLevel: t.int({ min: 0, max: 1000000 }), controlled: t.bool(), rxOnly: t.bool(), sellPriceKobo: t.money({ min: 0, max: naira(5000000) }),
};

async function createItem(orgId, b) {
  const d = C.defaultsFor(b.drugCode);
  if (b.drugCode && !d.drug) throw bad('Unknown formulary code ' + b.drugCode + '. Leave drugCode empty for items not in the formulary.');
  const name = b.name || (d.drug ? d.drug.name : null);
  if (!name) throw bad('Item name is required');
  if (b.sellPriceKobo == null) throw bad('Selling price is required');
  const itemId = id('pit');
  const it = { id: itemId, orgId, drugCode: d.drug ? d.drug.code : null, codeKey: d.drug ? d.drug.code : 'X:' + itemId, name, form: b.form || null, strength: b.strength || null, unit: b.unit || null,
    reorderLevel: b.reorderLevel || 0, controlled: d.controlled || !!b.controlled, rxOnly: d.controlled || !!b.controlled ? true : (b.rxOnly != null ? b.rxOnly : d.rxOnly), sellPriceKobo: b.sellPriceKobo, active: true, createdAt: now() };
  try { await db.col('pharmacy_items').insertOne(it); } catch (e) { if (e.code === 11000) throw conflict('This drug is already in your inventory'); throw e; }
  return it;
}

router.get('/pharmacy/items', C.G.readOrReports, ah(async (req, res) => {
  const q = query(req, { q: t.str({ max: 60 }), lowOnly: t.bool(), includeInactive: t.bool() });
  const f = { orgId: org(req) }; if (!q.includeInactive) f.active = { $ne: false };
  let items = await db.col('pharmacy_items').find(f, { sort: { name: 1 }, limit: 2000 });
  if (q.q) { const s = q.q.toLowerCase(); items = items.filter(i => i.name.toLowerCase().includes(s) || (i.drugCode || '').toLowerCase().includes(s)); }
  let out = []; for (const it of items) out.push(await C.itemView(it));
  if (q.lowOnly) out = out.filter(v => v.lowStock);
  res.json(out);
}));
router.get('/pharmacy/formulary', C.G.read, ah(async (req, res) => {
  const q = query(req, { q: t.str({ max: 60 }) });
  res.json(F.search(q.q, 30).map(d => ({ code: d.code, name: d.name, controlled: d.controlled, defaultRxOnly: C.defaultsFor(d.code).rxOnly })));
}));
router.post('/pharmacy/items', C.G.stock, ah(async (req, res) => {
  const b = body(req, itemRules);
  const it = await createItem(org(req), b);
  await audit(req, 'pharmacy.item_create', { type: 'pharmacy_item', id: it.id }, { drugCode: it.drugCode, sellPriceKobo: it.sellPriceKobo });
  res.json(await C.itemView(it));
}));
router.patch('/pharmacy/items/:id', C.G.stock, ah(async (req, res) => {
  const b = body(req, { name: t.str({ max: 120 }), form: t.str({ max: 40 }), strength: t.str({ max: 40 }), unit: t.str({ max: 40 }), reorderLevel: t.int({ min: 0, max: 1000000 }), controlled: t.bool(), rxOnly: t.bool(), sellPriceKobo: t.money({ min: 0, max: naira(5000000) }), active: t.bool() });
  const cur = await db.col('pharmacy_items').findOne({ id: param(req, 'id'), orgId: org(req) });
  if (!cur) throw notFound('Item not found');
  const d = C.defaultsFor(cur.drugCode);
  if (d.controlled && b.controlled === false) throw bad('This drug is controlled in the formulary and must stay in the controlled register');
  if ((d.controlled || cur.controlled || b.controlled) && b.rxOnly === false) throw bad('Controlled drugs are always prescription-only');
  if (!Object.keys(b).length) throw bad('Nothing to change');
  const set = Object.assign({ updatedAt: now() }, b);
  if (b.controlled) set.rxOnly = true;
  const it = await db.col('pharmacy_items').findOneAndUpdate({ id: cur.id, orgId: org(req) }, { $set: set });
  await audit(req, 'pharmacy.item_update', { type: 'pharmacy_item', id: it.id }, { fields: Object.keys(b) });
  res.json(await C.itemView(it));
}));
router.get('/pharmacy/items/:id', C.G.readOrReports, ah(async (req, res) => {
  const it = await db.col('pharmacy_items').findOne({ id: param(req, 'id'), orgId: org(req) });
  if (!it) throw notFound('Item not found');
  const batches = await db.col('pharmacy_batches').find({ orgId: org(req), itemId: it.id }, { sort: { expiry: 1 } });
  const moves = await db.col('stock_moves').find({ orgId: org(req), itemId: it.id }, { sort: { at: -1 }, limit: 50 });
  res.json({ item: await C.itemView(it), batches: batches.map(C.batchView), moves });
}));

/* ---------- receiving ---------- */
const batchRules = { batchNo: t.str({ required: true, max: 40, pattern: /^[A-Za-z0-9._\/-]+$/, label: 'Batch number' }), expiry: t.date({ required: true, label: 'Expiry date' }), qty: t.int({ required: true, min: 1, max: 1000000, label: 'Quantity' }), costKobo: t.money({ max: naira(5000000), label: 'Unit cost' }) };

/** receive a batch (or more of an existing batch with the same expiry). Used by routes, PO receive and the demo seed. */
async function receiveBatch(orgId, { itemId, batchNo, expiry, qty, costKobo, supplierId, poId, reason, who }) {
  const it = await db.col('pharmacy_items').findOne({ id: itemId, orgId });
  if (!it) throw notFound('Item not found');
  if (expiry < C.today()) throw bad('That batch has already expired. Do not receive expired stock.');
  if (!Number.isInteger(qty) || qty < 1) throw bad('Quantity must be a positive whole number');
  if (supplierId && !(await db.col('suppliers').findOne({ id: supplierId, orgId }))) throw notFound('Supplier not found');
  const existing = await db.col('pharmacy_batches').findOne({ orgId, itemId, batchNo });
  let batch;
  if (existing) {
    if (existing.expiry !== expiry) throw bad('Batch ' + batchNo + ' is already in stock with expiry ' + existing.expiry + '. Check the batch number.');
    if (existing.status === 'quarantined' || existing.recalledAt) throw conflict('Batch ' + batchNo + ' is quarantined or recalled. Do not receive more of it.');
    batch = await C.addToBatch(orgId, existing.id, qty);
    await db.col('pharmacy_batches').updateOne({ id: existing.id }, { $inc: { qtyReceived: qty } });
  } else {
    batch = { id: id('pbt'), orgId, itemId, batchNo, expiry, qty, qtyReceived: qty, costKobo: costKobo || 0, supplierId: supplierId || null, poId: poId || null, status: 'active', recalledAt: null, receivedAt: now(), updatedAt: now() };
    try { await db.col('pharmacy_batches').insertOne(batch); } catch (e) { if (e.code === 11000) return receiveBatch(orgId, { itemId, batchNo, expiry, qty, costKobo, supplierId, poId, reason, who }); throw e; }
  }
  await C.writeMove({ orgId, itemId, batchId: batch.id, type: 'receive', qty, balanceAfter: batch.qty, reason: reason || 'goods received', ref: poId ? { type: 'purchase_order', id: poId } : null, who });
  return batch;
}

router.post('/pharmacy/stock/receive', C.G.stock, C.G.onShift, ah(async (req, res) => {
  const b = body(req, Object.assign({ itemId: t.id({ required: true }), supplierId: t.id() }, batchRules));
  const batch = await receiveBatch(org(req), Object.assign({}, b, { who: C.actor(req) }));
  await audit(req, 'pharmacy.stock_receive', { type: 'pharmacy_batch', id: batch.id }, { itemId: b.itemId, qty: b.qty });
  res.json(C.batchView(batch));
}));

/* ---------- per-batch operations ---------- */
async function getBatch(req) { const b = await db.col('pharmacy_batches').findOne({ id: param(req, 'id'), orgId: org(req) }); if (!b) throw notFound('Batch not found'); return b; }

router.post('/pharmacy/batches/:id/adjust', C.G.stock, C.G.onShift, ah(async (req, res) => {
  const b = body(req, { delta: t.int({ required: true, min: -1000000, max: 1000000 }), reason: t.enum(['damaged', 'breakage', 'theft_loss', 'found', 'data_correction', 'sample', 'other'], { required: true }), note: t.str({ max: 300 }) });
  if (b.delta === 0) throw bad('Change must not be zero');
  if (b.reason === 'other' && !b.note) throw bad('Explain the adjustment in the note');
  const bt = await getBatch(req);
  let after;
  if (b.delta < 0) {
    after = await C.takeFromBatch(org(req), bt.id, -b.delta, { anyStatus: true });
    if (!after) throw conflict('Cannot remove ' + (-b.delta) + ': the batch holds ' + ((await db.col('pharmacy_batches').findOne({ id: bt.id })) || {}).qty + '. Stock cannot go below zero.', 'insufficient_stock');
  } else {
    if (bt.recalledAt) throw conflict('This batch is recalled');
    after = await C.addToBatch(org(req), bt.id, b.delta);
  }
  const mv = await C.writeMove({ orgId: org(req), itemId: bt.itemId, batchId: bt.id, type: 'adjust', qty: b.delta, balanceAfter: after.qty, reason: b.reason + (b.note ? ': ' + b.note : ''), who: C.actor(req) });
  await audit(req, 'pharmacy.stock_adjust', { type: 'pharmacy_batch', id: bt.id }, { delta: b.delta, reason: b.reason });
  res.json({ batch: C.batchView(Object.assign(after, { status: after.qty === 0 && after.status === 'active' ? 'depleted' : after.status })), move: mv });
}));

router.post('/pharmacy/batches/:id/count', C.G.stock, C.G.onShift, ah(async (req, res) => {
  const b = body(req, { counted: t.int({ required: true, min: 0, max: 1000000, label: 'Counted quantity' }), note: t.str({ max: 300 }) });
  const bt = await getBatch(req);
  if (bt.status === 'expired') throw conflict('This batch was written off as expired');
  const variance = b.counted - bt.qty;
  const set = { qty: b.counted, countedAt: now(), updatedAt: now() };
  if (bt.status === 'depleted' && b.counted > 0) set.status = 'active';
  if (bt.status === 'active' && b.counted === 0) set.status = 'depleted';
  // optimistic: only if nobody moved the batch since we read it
  const after = await db.col('pharmacy_batches').findOneAndUpdate({ id: bt.id, orgId: org(req), qty: bt.qty }, { $set: set });
  if (!after) throw conflict('Stock on this batch changed while counting. Count again.');
  const mv = await C.writeMove({ orgId: org(req), itemId: bt.itemId, batchId: bt.id, type: 'count', qty: variance, balanceAfter: after.qty, reason: 'stock count' + (b.note ? ': ' + b.note : ''), who: C.actor(req) });
  await audit(req, 'pharmacy.stock_count', { type: 'pharmacy_batch', id: bt.id }, { variance });
  res.json({ batch: C.batchView(after), variance, move: mv });
}));

router.post('/pharmacy/batches/:id/return-in', C.G.dispense, C.G.onShift, ah(async (req, res) => {
  const b = body(req, { qty: t.int({ required: true, min: 1, max: 100000 }), reason: t.str({ required: true, min: 3, max: 300 }), rxOrderId: t.id(), saleId: t.id() });
  const bt = await getBatch(req);
  if (bt.status === 'quarantined' || bt.recalledAt) throw conflict('Cannot restock a quarantined or recalled batch');
  if (bt.expiry < C.today()) throw conflict('Cannot restock an expired batch');
  const dispensedOut = -(await db.col('stock_moves').find({ orgId: org(req), batchId: bt.id, type: { $in: ['dispense', 'sale'] } })).reduce((s, m) => s + m.qty, 0);
  const returned = (await db.col('stock_moves').find({ orgId: org(req), batchId: bt.id, type: 'return_in' })).reduce((s, m) => s + m.qty, 0);
  if (b.qty > dispensedOut - returned) throw bad('More than was dispensed from this batch cannot be returned');
  const after = await C.addToBatch(org(req), bt.id, b.qty);
  const ref = b.rxOrderId ? { type: 'rx_order', id: b.rxOrderId } : b.saleId ? { type: 'pharmacy_sale', id: b.saleId } : null;
  const mv = await C.writeMove({ orgId: org(req), itemId: bt.itemId, batchId: bt.id, type: 'return_in', qty: b.qty, balanceAfter: after.qty, reason: b.reason, ref, who: C.actor(req) });
  await audit(req, 'pharmacy.stock_return_in', { type: 'pharmacy_batch', id: bt.id }, { qty: b.qty });
  res.json({ batch: C.batchView(after), move: mv });
}));

router.post('/pharmacy/batches/:id/return-supplier', C.G.stock, C.G.onShift, ah(async (req, res) => {
  const b = body(req, { qty: t.int({ required: true, min: 1, max: 1000000 }), reason: t.str({ required: true, min: 3, max: 300 }) });
  const bt = await getBatch(req);
  const after = await C.takeFromBatch(org(req), bt.id, b.qty, { anyStatus: true });
  if (!after) throw conflict('Cannot return more than the batch holds', 'insufficient_stock');
  const creditKobo = b.qty * (bt.costKobo || 0);
  const mv = await C.writeMove({ orgId: org(req), itemId: bt.itemId, batchId: bt.id, type: 'return_supplier', qty: -b.qty, balanceAfter: after.qty, reason: b.reason, ref: bt.supplierId ? { type: 'supplier', id: bt.supplierId } : null, who: C.actor(req), meta: { creditKobo } });
  await audit(req, 'pharmacy.stock_return_supplier', { type: 'pharmacy_batch', id: bt.id }, { qty: b.qty, creditKobo });
  res.json({ batch: C.batchView(after), creditKobo, move: mv });
}));

/* recall: quarantine the batch exactly once and list the orders it went to */
router.post('/pharmacy/batches/:id/recall', C.G.stock, C.G.onShift, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 5, max: 300 }), reference: t.str({ max: 80, label: 'NAFDAC / manufacturer reference' }) });
  const bt = await getBatch(req);
  const after = await db.col('pharmacy_batches').findOneAndUpdate({ id: bt.id, orgId: org(req), recalledAt: null }, { $set: { status: 'quarantined', recalledAt: now(), recallReason: b.reason, updatedAt: now() } });
  if (!after) throw conflict('This batch has already been recalled', 'already_recalled');
  const orders = await db.col('rx_orders').find({ pharmacyOrgId: org(req), 'allocations.batchId': bt.id }, { projection: { id: 1, patientId: 1 } });
  const sales = await db.col('pharmacy_sales').find({ orgId: org(req), 'allocations.batchId': bt.id }, { projection: { id: 1, patientId: 1 } });
  const rc = { id: id('rcl'), orgId: org(req), itemId: bt.itemId, batchId: bt.id, batchNo: bt.batchNo, reason: b.reason, reference: b.reference || null, quarantinedQty: after.qty, affectedOrderIds: orders.map(o => o.id), affectedSaleIds: sales.map(s => s.id), claimStatus: 'open', at: now(), by: req.ctx.user.id };
  await db.col('recalls').insertOne(rc);
  await C.writeMove({ orgId: org(req), itemId: bt.itemId, batchId: bt.id, type: 'recall', qty: 0, balanceAfter: after.qty, reason: 'RECALL: ' + b.reason, ref: { type: 'recall', id: rc.id }, who: C.actor(req), meta: { quarantinedQty: after.qty } });
  await audit(req, 'pharmacy.batch_recall', { type: 'pharmacy_batch', id: bt.id }, { recallId: rc.id, quarantinedQty: after.qty, affectedOrders: orders.length });
  res.json({ recall: rc, batch: C.batchView(after) });
}));
router.get('/pharmacy/recalls', C.G.read, ah(async (req, res) => { res.json(await db.col('recalls').find({ orgId: org(req) }, { sort: { at: -1 }, limit: 200 })); }));
router.post('/pharmacy/recalls/:id/claim', C.G.stock, ah(async (req, res) => {
  const b = body(req, { claimStatus: t.enum(['sent', 'credited', 'closed'], { required: true }), note: t.str({ max: 300 }) });
  const order = { open: 0, sent: 1, credited: 2, closed: 3 };
  const rc = await db.col('recalls').findOne({ id: param(req, 'id'), orgId: org(req) });
  if (!rc) throw notFound('Recall not found');
  if (order[b.claimStatus] <= order[rc.claimStatus]) throw conflict('The claim is already ' + rc.claimStatus);
  const upd = await db.col('recalls').findOneAndUpdate({ id: rc.id, orgId: org(req), claimStatus: rc.claimStatus }, { $set: { claimStatus: b.claimStatus, claimNote: b.note || null, claimAt: now() } });
  if (!upd) throw conflict('The recall changed. Refresh and try again.');
  await audit(req, 'pharmacy.recall_claim', { type: 'recall', id: rc.id }, { claimStatus: b.claimStatus });
  res.json(upd);
}));

/* expiry write-off: every active batch past its expiry is marked expired and removed from stock */
router.post('/pharmacy/stock/expire-sweep', C.G.stock, C.G.onShift, ah(async (req, res) => {
  const expired = await db.col('pharmacy_batches').find({ orgId: org(req), status: 'active', expiry: { $lt: C.today() } });
  const out = [];
  for (const bt of expired) {
    const after = await db.col('pharmacy_batches').findOneAndUpdate({ id: bt.id, orgId: org(req), status: 'active', qty: bt.qty }, { $set: { status: 'expired', qty: 0, expiredQty: bt.qty, updatedAt: now() } });
    if (!after) continue;
    await C.writeMove({ orgId: org(req), itemId: bt.itemId, batchId: bt.id, type: 'expire', qty: -bt.qty, balanceAfter: 0, reason: 'expired ' + bt.expiry, who: C.actor(req), meta: { valueKobo: bt.qty * (bt.costKobo || 0) } });
    out.push({ batchId: bt.id, batchNo: bt.batchNo, qty: bt.qty });
  }
  await audit(req, 'pharmacy.expire_sweep', { type: 'org', id: org(req) }, { batches: out.length });
  res.json({ expired: out });
}));

/* ---------- ledger, alerts, controlled register ---------- */
router.get('/pharmacy/moves', C.G.readOrReports, ah(async (req, res) => {
  const q = query(req, { itemId: t.id(), batchId: t.id(), type: t.enum(C.MOVE_TYPES), limit: t.int({ min: 1, max: 500 }) });
  const f = { orgId: org(req) }; if (q.itemId) f.itemId = q.itemId; if (q.batchId) f.batchId = q.batchId; if (q.type) f.type = q.type;
  res.json(await db.col('stock_moves').find(f, { sort: { at: -1 }, limit: q.limit || 100 }));
}));
async function alertsFor(orgId) {
  const items = await db.col('pharmacy_items').find({ orgId, active: { $ne: false } });
  const views = []; for (const it of items) views.push(await C.itemView(it));
  const td = C.today(); const horizon = C.addDays(td, C.NEAR_EXPIRY_DAYS);
  const nm = Object.fromEntries(items.map(i => [i.id, i.name]));
  const batches = await db.col('pharmacy_batches').find({ orgId, status: 'active', qty: { $gt: 0 }, expiry: { $lte: horizon } }, { sort: { expiry: 1 } });
  return {
    lowStock: views.filter(v => v.lowStock).map(v => ({ itemId: v.id, name: v.name, onHand: v.onHand, reorderLevel: v.reorderLevel, outOfStock: v.outOfStock })),
    expiring: batches.filter(b => b.expiry >= td).map(b => ({ batchId: b.id, itemId: b.itemId, name: nm[b.itemId] || '', batchNo: b.batchNo, expiry: b.expiry, daysToExpiry: C.daysTo(b.expiry), qty: b.qty })),
    expired: batches.filter(b => b.expiry < td).map(b => ({ batchId: b.id, itemId: b.itemId, name: nm[b.itemId] || '', batchNo: b.batchNo, expiry: b.expiry, qty: b.qty })),
  };
}
router.get('/pharmacy/alerts', C.G.readOrReports, ah(async (req, res) => { res.json(await alertsFor(org(req))); }));
router.get('/pharmacy/controlled-register', A_ctrl(), ah(async (req, res) => {
  const q = query(req, { itemId: t.id(), from: t.date(), to: t.date(), limit: t.int({ min: 1, max: 1000 }) });
  const { lagosToUtc } = require('../../lib/util');
  const f = { orgId: org(req) }; if (q.itemId) f.itemId = q.itemId;
  if (q.from || q.to) { f.at = {}; if (q.from) f.at.$gte = lagosToUtc(q.from, '00:00'); if (q.to) f.at.$lt = lagosToUtc(C.addDays(q.to, 1), '00:00'); }
  const rows = await db.col('controlled_register').find(f, { sort: { at: -1 }, limit: q.limit || 200 });
  const P = require('../patients');
  const names = {}; for (const pid of [...new Set(rows.map(r => r.patientId).filter(Boolean))]) names[pid] = await P.patientName(pid);
  await audit(req, 'pharmacy.controlled_register_view', { type: 'org', id: org(req) }, { rows: rows.length });
  res.json(rows.map(r => Object.assign({ patientName: r.patientId ? names[r.patientId] : null }, r)));
}));
function A_ctrl() { return require('../../lib/auth').requireStaff({ module: 'pharmacy', anyPerm: ['pharmacy.verify', 'admin.reports'] }); }

/* ---------- suppliers ---------- */
const supplierRules = { name: t.str({ required: true, max: 120 }), phone: t.phone(), email: t.email(), address: t.str({ max: 300 }), contactName: t.str({ max: 100 }) };
router.get('/pharmacy/suppliers', C.G.read, ah(async (req, res) => { res.json(await db.col('suppliers').find({ orgId: org(req) }, { sort: { name: 1 } })); }));
router.post('/pharmacy/suppliers', C.G.stock, ah(async (req, res) => {
  const b = body(req, supplierRules);
  const s = Object.assign({ id: id('sup'), orgId: org(req), active: true, createdAt: now() }, b);
  await db.col('suppliers').insertOne(s);
  await audit(req, 'pharmacy.supplier_create', { type: 'supplier', id: s.id });
  res.json(s);
}));
router.patch('/pharmacy/suppliers/:id', C.G.stock, ah(async (req, res) => {
  const r = Object.assign({}, supplierRules, { name: t.str({ max: 120 }), active: t.bool() });
  const b = body(req, r);
  if (!Object.keys(b).length) throw bad('Nothing to change');
  const s = await db.col('suppliers').findOneAndUpdate({ id: param(req, 'id'), orgId: org(req) }, { $set: b });
  if (!s) throw notFound('Supplier not found');
  await audit(req, 'pharmacy.supplier_update', { type: 'supplier', id: s.id }, { fields: Object.keys(b) });
  res.json(s);
}));

/* ---------- purchase orders: draft -> sent -> partially_received -> received | cancelled ---------- */
const PO_TRANSITIONS = { draft: ['sent', 'cancelled'], sent: ['partially_received', 'received', 'cancelled'], partially_received: ['partially_received', 'received'], received: [], cancelled: [] };
const poLineRules = t.arr(t.obj({ itemId: t.id({ required: true }), qty: t.int({ required: true, min: 1, max: 1000000 }), costKobo: t.money({ max: naira(5000000) }) }), { required: true, min: 1, max: 100 });
async function poLines(orgId, lines) {
  const seen = new Set(); const out = [];
  for (const l of lines) {
    if (seen.has(l.itemId)) throw bad('Each item can appear only once on a purchase order'); seen.add(l.itemId);
    const it = await db.col('pharmacy_items').findOne({ id: l.itemId, orgId });
    if (!it) throw notFound('Item not found');
    out.push({ itemId: it.id, name: it.name, qty: l.qty, costKobo: l.costKobo || 0, receivedQty: 0 });
  }
  return out;
}
async function createPO(orgId, { supplierId, lines, note, createdBy }) {
  if (!(await db.col('suppliers').findOne({ id: supplierId, orgId }))) throw notFound('Supplier not found');
  const n = await nextNumber('po_' + orgId);
  const po = { id: id('po'), orgId, number: 'PO' + String(n).padStart(5, '0'), supplierId, status: 'draft', lines: await poLines(orgId, lines), note: note || null, rev: 0, createdBy: createdBy || null, createdAt: now(), timeline: [{ status: 'draft', at: now(), by: createdBy || null }] };
  po.totalKobo = po.lines.reduce((s, l) => s + l.qty * l.costKobo, 0);
  await db.col('purchase_orders').insertOne(po);
  return po;
}
router.get('/pharmacy/purchase-orders', C.G.read, ah(async (req, res) => {
  const q = query(req, { status: t.enum(Object.keys(PO_TRANSITIONS)) });
  const f = { orgId: org(req) }; if (q.status) f.status = q.status;
  const rows = await db.col('purchase_orders').find(f, { sort: { createdAt: -1 }, limit: 200 });
  const sup = Object.fromEntries((await db.col('suppliers').find({ orgId: org(req) })).map(s => [s.id, s.name]));
  res.json(rows.map(p => Object.assign({ supplierName: sup[p.supplierId] || null }, p)));
}));
router.get('/pharmacy/purchase-orders/:id', C.G.read, ah(async (req, res) => {
  const po = await db.col('purchase_orders').findOne({ id: param(req, 'id'), orgId: org(req) });
  if (!po) throw notFound('Purchase order not found');
  res.json(Object.assign({ batches: await db.col('pharmacy_batches').find({ orgId: org(req), poId: po.id }) }, po));
}));
router.post('/pharmacy/purchase-orders', C.G.stock, ah(async (req, res) => {
  const b = body(req, { supplierId: t.id({ required: true }), lines: poLineRules, note: t.str({ max: 300 }) });
  const po = await createPO(org(req), Object.assign({ createdBy: req.ctx.user.id }, b));
  await audit(req, 'pharmacy.po_create', { type: 'purchase_order', id: po.id }, { lines: po.lines.length, totalKobo: po.totalKobo });
  res.json(po);
}));
router.patch('/pharmacy/purchase-orders/:id', C.G.stock, ah(async (req, res) => {
  const b = body(req, { lines: poLineRules, note: t.str({ max: 300 }) });
  const lines = await poLines(org(req), b.lines);
  const po = await db.col('purchase_orders').findOneAndUpdate({ id: param(req, 'id'), orgId: org(req), status: 'draft' }, { $set: { lines, note: b.note || null, totalKobo: lines.reduce((s, l) => s + l.qty * l.costKobo, 0), updatedAt: now() }, $inc: { rev: 1 } });
  if (!po) throw conflict('Only draft purchase orders can be edited');
  await audit(req, 'pharmacy.po_update', { type: 'purchase_order', id: po.id }, { lines: lines.length });
  res.json(po);
}));
async function poTransition(req, from, to, extra) {
  const po = await db.col('purchase_orders').findOneAndUpdate({ id: param(req, 'id'), orgId: org(req), status: { $in: from } }, { $set: Object.assign({ status: to, updatedAt: now() }, extra || {}), $push: { timeline: { status: to, at: now(), by: req.ctx.user.id } }, $inc: { rev: 1 } });
  if (!po) { const ex = await db.col('purchase_orders').findOne({ id: param(req, 'id'), orgId: org(req) }); if (!ex) throw notFound('Purchase order not found'); throw conflict('This purchase order is ' + ex.status); }
  return po;
}
router.post('/pharmacy/purchase-orders/:id/send', C.G.stock, ah(async (req, res) => {
  const po = await poTransition(req, ['draft'], 'sent', { sentAt: now() });
  await audit(req, 'pharmacy.po_send', { type: 'purchase_order', id: po.id }); res.json(po);
}));
router.post('/pharmacy/purchase-orders/:id/cancel', C.G.stock, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 3, max: 300 }) });
  const po = await poTransition(req, ['draft', 'sent'], 'cancelled', { cancelReason: b.reason });
  await audit(req, 'pharmacy.po_cancel', { type: 'purchase_order', id: po.id }); res.json(po);
}));

/** receive goods against a PO. Lines must be on the PO and not exceed what is still outstanding. */
async function receivePO(orgId, poId, lines, who) {
  const po = await db.col('purchase_orders').findOne({ id: poId, orgId });
  if (!po) throw notFound('Purchase order not found');
  if (!['sent', 'partially_received'].includes(po.status)) throw conflict(po.status === 'draft' ? 'Send the purchase order before receiving goods' : 'This purchase order is ' + po.status);
  const want = {};
  for (const l of lines) {
    const pl = po.lines.find(x => x.itemId === l.itemId);
    if (!pl) throw bad('That item is not on this purchase order');
    want[l.itemId] = (want[l.itemId] || 0) + l.qty;
    if (want[l.itemId] > pl.qty - (pl.receivedQty || 0)) throw bad('More ' + pl.name + ' than is outstanding on the order (' + (pl.qty - (pl.receivedQty || 0)) + ')');
    if (l.expiry < C.today()) throw bad('Batch ' + l.batchNo + ' has already expired. Do not receive expired stock.');
    const ex = await db.col('pharmacy_batches').findOne({ orgId, itemId: l.itemId, batchNo: l.batchNo });
    if (ex && (ex.expiry !== l.expiry || ex.recalledAt)) throw bad('Batch ' + l.batchNo + ' is already in stock with a different expiry or is recalled. Check the batch number.');
  }
  // claim the PO revision so two receipts cannot both pass the outstanding check
  const claimed = await db.col('purchase_orders').findOneAndUpdate({ id: po.id, orgId, rev: po.rev, status: po.status }, { $inc: { rev: 1 } });
  if (!claimed) throw conflict('This purchase order changed while receiving. Refresh and try again.');
  const batches = [];
  for (const l of lines) {
    const pl = po.lines.find(x => x.itemId === l.itemId);
    batches.push(await receiveBatch(orgId, { itemId: l.itemId, batchNo: l.batchNo, expiry: l.expiry, qty: l.qty, costKobo: l.costKobo != null ? l.costKobo : pl.costKobo, supplierId: po.supplierId, poId: po.id, reason: 'received on ' + po.number, who }));
  }
  const newLines = po.lines.map(pl => Object.assign({}, pl, { receivedQty: (pl.receivedQty || 0) + (want[pl.itemId] || 0) }));
  const full = newLines.every(pl => pl.receivedQty >= pl.qty);
  const status = full ? 'received' : 'partially_received';
  const upd = await db.col('purchase_orders').findOneAndUpdate({ id: po.id, orgId, rev: po.rev + 1 }, { $set: { lines: newLines, status, updatedAt: now(), receivedAt: full ? now() : null }, $push: { timeline: { status, at: now(), by: who ? who.by : null } }, $inc: { rev: 1 } });
  return { po: upd, batches };
}
router.post('/pharmacy/purchase-orders/:id/receive', C.G.stock, C.G.onShift, ah(async (req, res) => {
  const b = body(req, { lines: t.arr(t.obj(Object.assign({ itemId: t.id({ required: true }) }, batchRules)), { required: true, min: 1, max: 100 }) });
  const r = await receivePO(org(req), param(req, 'id'), b.lines, C.actor(req));
  await audit(req, 'pharmacy.po_receive', { type: 'purchase_order', id: r.po.id }, { batches: r.batches.length, status: r.po.status });
  res.json({ po: r.po, batches: r.batches.map(C.batchView) });
}));

module.exports = { router, createItem, receiveBatch, createPO, receivePO, alertsFor };
