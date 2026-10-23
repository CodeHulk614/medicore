'use strict';
/*
 * Walk-in / OTC sales at the pharmacy counter (cashier or pharmacy staff).
 *
 *   awaiting_approval -> billed -> paid -> [dispensing] -> completed
 *   awaiting_approval | billed -> cancelled
 *
 * - OTC items: anyone at the counter. Prescription-only items need a linked patient and a
 *   pharmacist's approval (pharmacy.verify), with the safety check run against that patient.
 * - billed -> paid only through billing.onSettled('pharmacy_sale'); stock is then deducted
 *   FEFO exactly once (paid -> dispensing claim). If stock ran out in the meantime the sale
 *   stays `paid` with stockShort=true and staff retry POST /pharmacy/sales/:id/complete.
 */
const express = require('express');
const db = require('../../db');
const { ah, body, query, t, bad, notFound, conflict, param } = require('../../lib/http');
const { id, now } = require('../../lib/util');
const { audit } = require('../../lib/audit');
const A = require('../../lib/auth');
const P = require('../patients');
const billing = require('../billing');
const safety = require('../../clinical/safety');
const { nextNumber } = require('../orgs');
const C = require('./common');

const router = express.Router();
const S_TRANSITIONS = { awaiting_approval: ['billed', 'cancelled'], billed: ['paid', 'cancelled'], paid: ['dispensing'], dispensing: ['completed', 'paid'], completed: [], cancelled: [] };

async function sTransition(saleId, orgId, from, to, set, by, extraFilter) {
  const ok = (Array.isArray(from) ? from : [from]).filter(s => S_TRANSITIONS[s].includes(to));
  return db.col('pharmacy_sales').findOneAndUpdate(Object.assign({ id: saleId, orgId, status: { $in: ok } }, extraFilter || {}), { $set: Object.assign({}, set || {}, { status: to, updatedAt: now() }), $push: { timeline: { status: to, at: now(), by: by || null } } });
}

async function raiseBill(sale, createdBy) {
  const bill = await billing.createBill({ orgId: sale.orgId, patientId: sale.patientId || null, lines: sale.lines.map(l => ({ code: l.drugCode || 'OTC-ITEM', name: l.name, category: 'drug', qty: l.qty, unitPriceKobo: l.unitPriceKobo })), source: { type: 'pharmacy_sale', id: sale.id }, createdBy, note: 'Counter sale ' + sale.number });
  return bill;
}

/** deduct stock for a paid sale exactly once */
async function completeSale(saleId, orgId, who) {
  const claimed = await sTransition(saleId, orgId, ['paid'], 'dispensing', {}, who.by);
  if (!claimed) return null;
  const agg = {}; claimed.lines.forEach(l => { agg[l.itemId] = (agg[l.itemId] || 0) + l.qty; });
  let takes;
  try { takes = await C.allocateFefo(orgId, Object.entries(agg).map(([itemId, qty]) => ({ itemId, qty }))); }
  catch (e) { await sTransition(saleId, orgId, ['dispensing'], 'paid', { stockShort: true, stockError: e.message }, who.by); return { error: e }; }
  const upd = await sTransition(saleId, orgId, ['dispensing'], 'completed', { allocations: takes.map(t => ({ itemId: t.itemId, batchId: t.batchId, batchNo: t.batchNo, expiry: t.expiry, qty: t.qty })), completedAt: now(), stockShort: false, stockError: null }, who.by);
  if (!upd) { await C.revertTakes(orgId, takes); return null; }
  const ref = { type: 'pharmacy_sale', id: saleId };
  await C.commitTakes(orgId, takes, { type: 'sale', ref, reason: 'counter sale', who });
  await C.registerControlled({ orgId, takes, patientId: claimed.patientId, ref, who });
  return { sale: upd };
}
billing.onSettled('pharmacy_sale', async (bill) => {
  const s = await sTransition(bill.source.id, bill.orgId, ['billed'], 'paid', { paidAt: now() }, null, { billId: bill.id });
  if (s) await completeSale(s.id, s.orgId, { by: s.createdBy, byName: s.createdByName, byMembershipId: s.createdByMembershipId });
});

async function saleView(s) {
  const v = Object.assign({}, s);
  if (s.billId) { const b = await db.col('bills').findOne({ id: s.billId }); v.bill = b ? { id: b.id, number: b.number, status: b.status, totalKobo: b.totalKobo, patientDueKobo: b.patientDueKobo, paidKobo: b.paidKobo } : null; }
  v.patientName = s.patientId ? await P.patientName(s.patientId) : null;
  return v;
}

router.post('/pharmacy/sales', C.G.sale, C.G.onShift, ah(async (req, res) => {
  const b = body(req, {
    patientId: t.id(),
    lines: t.arr(t.obj({ itemId: t.id({ required: true }), qty: t.int({ required: true, min: 1, max: 1000, label: 'Quantity' }) }), { required: true, min: 1, max: 50 }),
    overrideReason: t.str({ max: 300 }), note: t.str({ max: 300 }),
  });
  const orgId = req.ctx.org.id;
  let patient = null;
  if (b.patientId) patient = (await P.requireLinked(req, b.patientId)).patient;
  const lines = []; const need = {};
  for (const l of b.lines) {
    const it = await db.col('pharmacy_items').findOne({ id: l.itemId, orgId, active: { $ne: false } });
    if (!it) throw notFound('Item not found');
    lines.push({ itemId: it.id, drugCode: it.drugCode, name: it.name, qty: l.qty, unitPriceKobo: it.sellPriceKobo, totalKobo: it.sellPriceKobo * l.qty, rxOnly: !!it.rxOnly, controlled: !!it.controlled });
    need[it.id] = (need[it.id] || 0) + l.qty;
  }
  for (const [itemId, q] of Object.entries(need)) { const have = await C.availableQty(orgId, itemId); if (have < q) throw conflict('Not enough ' + lines.find(x => x.itemId === itemId).name + ' in stock: ' + have + ' usable.', 'insufficient_stock'); }
  const rxLines = lines.filter(l => l.rxOnly);
  if (rxLines.length && !patient) throw bad('Prescription-only items need a registered patient. Link the patient first.');
  const isPharmacist = A.has(req, 'pharmacy.verify');
  let approval = null;
  if (rxLines.length && isPharmacist) {
    const s = safety.check({ patient, items: rxLines.map(l => ({ drugCode: l.drugCode, drugName: l.name, quantity: l.qty })) });
    if (s.blocking && (!b.overrideReason || b.overrideReason.length < 5)) { const e = bad('Blocking safety alerts for this patient. Record your reason to proceed.', s.alerts); e.code = 'safety_blocking'; throw e; }
    approval = { by: req.ctx.user.id, byName: req.ctx.user.name, at: now(), alerts: s.alerts, blocking: s.blocking, overrideReason: b.overrideReason || null };
  }
  const n = await nextNumber('sale_' + orgId);
  const who = C.actor(req);
  const sale = { id: id('psl'), orgId, number: 'S' + String(n).padStart(6, '0'), patientId: patient ? patient.id : null, lines, totalKobo: lines.reduce((s, l) => s + l.totalKobo, 0), note: b.note || null,
    status: rxLines.length && !approval ? 'awaiting_approval' : 'billed', approval, billId: null, allocations: [], stockShort: false,
    createdBy: who.by, createdByName: who.byName, createdByMembershipId: who.byMembershipId, createdAt: now(), updatedAt: now(), timeline: [{ status: 'created', at: now(), by: who.by }] };
  await db.col('pharmacy_sales').insertOne(sale);
  let out = sale;
  if (sale.status === 'billed') {
    const bill = await raiseBill(sale, req.ctx.user.id);
    out = await db.col('pharmacy_sales').findOneAndUpdate({ id: sale.id, orgId }, { $set: { billId: bill.id } });
    if (bill.status === 'paid') { await db.col('pharmacy_sales').updateOne({ id: sale.id, status: 'billed' }, { $set: { status: 'paid' } }); await completeSale(sale.id, orgId, who); out = await db.col('pharmacy_sales').findOne({ id: sale.id }); }
  }
  await audit(req, 'pharmacy.sale_create', { type: 'pharmacy_sale', id: sale.id, patientId: sale.patientId }, { lines: lines.length, totalKobo: sale.totalKobo, rxOnly: rxLines.length });
  res.json(await saleView(out));
}));

router.post('/pharmacy/sales/:id/approve', C.G.verify, C.G.onShift, ah(async (req, res) => {
  const b = body(req, { overrideReason: t.str({ max: 300 }) });
  const s = await db.col('pharmacy_sales').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!s) throw notFound('Sale not found');
  if (s.status !== 'awaiting_approval') throw conflict('This sale is ' + s.status, 'wrong_state');
  const { patient } = await P.requireLinked(req, s.patientId);
  const sc = safety.check({ patient, items: s.lines.filter(l => l.rxOnly).map(l => ({ drugCode: l.drugCode, drugName: l.name, quantity: l.qty })) });
  if (sc.blocking && (!b.overrideReason || b.overrideReason.length < 5)) { const e = bad('Blocking safety alerts for this patient. Record your reason to proceed.', sc.alerts); e.code = 'safety_blocking'; throw e; }
  const approval = { by: req.ctx.user.id, byName: req.ctx.user.name, at: now(), alerts: sc.alerts, blocking: sc.blocking, overrideReason: b.overrideReason || null };
  const upd = await sTransition(s.id, s.orgId, ['awaiting_approval'], 'billed', { approval }, req.ctx.user.id);
  if (!upd) throw conflict('This sale was already approved or cancelled', 'wrong_state');
  const bill = await raiseBill(upd, req.ctx.user.id);
  let out = await db.col('pharmacy_sales').findOneAndUpdate({ id: s.id, orgId: s.orgId }, { $set: { billId: bill.id } });
  if (bill.status === 'paid') { await db.col('pharmacy_sales').updateOne({ id: s.id, status: 'billed' }, { $set: { status: 'paid' } }); await completeSale(s.id, s.orgId, C.actor(req)); out = await db.col('pharmacy_sales').findOne({ id: s.id }); }
  await audit(req, 'pharmacy.sale_approve', { type: 'pharmacy_sale', id: s.id, patientId: s.patientId }, { blocking: sc.blocking });
  res.json(await saleView(out));
}));

router.post('/pharmacy/sales/:id/complete', C.G.sale, C.G.onShift, ah(async (req, res) => {
  const s = await db.col('pharmacy_sales').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!s) throw notFound('Sale not found');
  if (s.status !== 'paid') throw conflict(s.status === 'billed' ? 'This sale is not paid yet' : 'This sale is ' + s.status, 'wrong_state');
  const r = await completeSale(s.id, s.orgId, C.actor(req));
  if (!r) throw conflict('This sale is already being completed', 'wrong_state');
  if (r.error) throw r.error;
  await audit(req, 'pharmacy.sale_complete', { type: 'pharmacy_sale', id: s.id, patientId: s.patientId });
  res.json(await saleView(r.sale));
}));

router.post('/pharmacy/sales/:id/cancel', C.G.sale, C.G.onShift, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 3, max: 300 }) });
  const s = await db.col('pharmacy_sales').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!s) throw notFound('Sale not found');
  if (s.status === 'billed' && s.billId) {
    const v = await db.col('bills').findOneAndUpdate({ id: s.billId, orgId: s.orgId, status: 'open', paidKobo: 0 }, { $set: { status: 'void', voidedAt: now(), voidedBy: req.ctx.user.id, voidReason: 'Sale cancelled' } });
    if (!v) throw conflict('Payment has started on this sale. Use a refund instead.', 'already_paid');
  }
  const upd = await sTransition(s.id, s.orgId, ['awaiting_approval', 'billed'], 'cancelled', { cancelReason: b.reason, cancelledBy: req.ctx.user.id }, req.ctx.user.id);
  if (!upd) throw conflict('This sale is ' + s.status + ' and cannot be cancelled', 'wrong_state');
  await audit(req, 'pharmacy.sale_cancel', { type: 'pharmacy_sale', id: s.id, patientId: s.patientId });
  res.json(await saleView(upd));
}));

router.get('/pharmacy/sales', C.G.sale, ah(async (req, res) => {
  const q = query(req, { status: t.enum(Object.keys(S_TRANSITIONS)), limit: t.int({ min: 1, max: 500 }) });
  const f = { orgId: req.ctx.org.id }; if (q.status) f.status = q.status;
  const rows = await db.col('pharmacy_sales').find(f, { sort: { createdAt: -1 }, limit: q.limit || 100 });
  const out = []; for (const s of rows) out.push(await saleView(s));
  res.json(out);
}));
router.get('/pharmacy/sales/:id', C.G.sale, ah(async (req, res) => {
  const s = await db.col('pharmacy_sales').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!s) throw notFound('Sale not found');
  res.json(await saleView(s));
}));
/* items the counter can sell (with OTC flag and usable stock) */
router.get('/pharmacy/counter/items', C.G.sale, ah(async (req, res) => {
  const q = query(req, { q: t.str({ max: 60 }) });
  let items = await db.col('pharmacy_items').find({ orgId: req.ctx.org.id, active: { $ne: false } }, { sort: { name: 1 } });
  if (q.q) { const s = q.q.toLowerCase(); items = items.filter(i => i.name.toLowerCase().includes(s) || (i.drugCode || '').toLowerCase().includes(s)); }
  const out = []; for (const it of items) out.push({ id: it.id, drugCode: it.drugCode, name: it.name, unit: it.unit, sellPriceKobo: it.sellPriceKobo, rxOnly: !!it.rxOnly, controlled: !!it.controlled, available: await C.availableQty(req.ctx.org.id, it.id) });
  res.json(out);
}));

module.exports = { router, S_TRANSITIONS, completeSale };
