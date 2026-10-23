'use strict';
/*
 * Bills and payments, shared by every service module.
 *
 * Rules that make the money trustworthy:
 *  - Amounts are always computed on the server from the provider's price list (or from the
 *    order being billed). A client never sends the amount it pays.
 *  - A bill is marked paid only when (a) Paystack confirms it through a signed webhook or the
 *    verify API, or (b) a cashier records cash/POS with a receipt number (audited), or
 *    (c) an HMO covers the full amount. Demo payments exist only in DEMO_MODE without Paystack keys.
 *  - Each payment is applied exactly once (conditional status change), so a webhook that
 *    arrives twice or a double click cannot pay twice.
 *  - When a bill is settled, the module that raised it is told once (onSettled hooks), e.g.
 *    the pharmacy order moves from priced to paid.
 */
const express = require('express');
const crypto = require('crypto');
const https = require('https');
const db = require('../db');
const config = require('../config');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param } = require('../lib/http');
const A = require('../lib/auth');
const { id, now, naira } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const P = require('./patients');
const orgs = require('./orgs');

db.index('bills', ['orgId', 'createdAt']);
db.index('bills', ['patientId', 'createdAt']);
db.index('bills', ['source.type', 'source.id']);
db.index('payments', ['reference'], { unique: true });
db.index('payments', ['billId']);

const router = express.Router();
const hooks = {};
/** modules register: onSettled('rx_order', async (bill, how) => {...}) */
function onSettled(sourceType, fn) { (hooks[sourceType] = hooks[sourceType] || []).push(fn); }
async function fireSettled(bill, how) {
  try { await require('../lib/events').emit('bill.paid', { billId: bill.id, orgId: bill.orgId, totalKobo: bill.totalKobo, how }); } catch (e) { /* best effort */ }
  for (const fn of hooks[bill.source && bill.source.type] || []) {
    try { await fn(bill, how); } catch (e) { console.error('[billing] settle hook failed', bill.source.type, e.message); }
  }
}

function lineFromService(svc, qty) { return { code: svc.code, name: svc.name, category: svc.category, qty, unitPriceKobo: svc.priceKobo, totalKobo: svc.priceKobo * qty }; }

/**
 * createBill({ orgId, patientId, lines:[{code,name,category,qty,unitPriceKobo}], source:{type,id}, createdBy, note })
 * lines must already carry server-side prices. Returns the bill.
 */
async function createBill({ orgId, patientId, lines, source, createdBy, note, dueBy }) {
  if (!lines || !lines.length) throw bad('A bill needs at least one item');
  for (const l of lines) {
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 1000) throw bad('Quantity must be between 1 and 1000');
    if (!Number.isInteger(l.unitPriceKobo) || l.unitPriceKobo < 0 || l.unitPriceKobo > naira(50000000)) throw bad('Price is out of range');
    l.totalKobo = l.unitPriceKobo * l.qty;
  }
  const total = lines.reduce((s, l) => s + l.totalKobo, 0);
  const n = await orgs.nextNumber('bill_' + orgId);
  const bill = { id: id('bil'), number: 'B' + String(n).padStart(6, '0'), orgId, patientId, lines, totalKobo: total, hmo: null, patientDueKobo: total, paidKobo: 0,
    status: total === 0 ? 'paid' : 'open', source: source || { type: 'manual', id: null }, note: note || null, createdBy: createdBy || null, createdAt: now(), dueBy: dueBy || null, paidAt: total === 0 ? now() : null };
  await db.col('bills').insertOne(bill);
  if (bill.status === 'paid') await fireSettled(bill, 'free');
  return bill;
}

/** apply money to a bill exactly once per payment record. Returns the updated bill. */
async function applyToBill(billId, amountKobo, how) {
  const bill = await db.col('bills').findOne({ id: billId });
  if (!bill) throw notFound('Bill not found');
  if (bill.status !== 'open') throw conflict('This bill is already ' + bill.status);
  const remaining = bill.patientDueKobo - bill.paidKobo;
  if (amountKobo <= 0 || amountKobo > remaining) throw bad('Amount must be between 1 kobo and the amount due');
  // optimistic: only apply if paidKobo has not moved since we read it
  const upd = await db.col('bills').findOneAndUpdate({ id: billId, status: 'open', paidKobo: bill.paidKobo }, { $inc: { paidKobo: amountKobo } });
  if (!upd) throw conflict('The bill changed while paying. Refresh and try again.');
  if (upd.paidKobo >= upd.patientDueKobo) {
    const settled = await db.col('bills').findOneAndUpdate({ id: billId, status: 'open' }, { $set: { status: 'paid', paidAt: now(), settledBy: how } });
    if (settled) { await fireSettled(settled, how); return settled; }
  }
  return upd;
}

/** HMO cover from the payer module: reduces what the patient pays. Settles the bill if fully covered. */
async function setHmoCover(billId, { coverageId, payerOrgId, coveredKobo, preauthId }) {
  const bill = await db.col('bills').findOne({ id: billId });
  if (!bill || bill.status !== 'open' || bill.paidKobo > 0 || bill.hmoExternal) throw conflict('HMO cover can only be added to an unpaid open bill');
  if (coveredKobo < 0 || coveredKobo > bill.totalKobo) throw bad('Cover amount is out of range');
  const upd = await db.col('bills').findOneAndUpdate({ id: billId, status: 'open', paidKobo: 0 }, { $set: { hmo: { coverageId, payerOrgId, coveredKobo, preauthId: preauthId || null, claimStatus: 'not_submitted' }, patientDueKobo: bill.totalKobo - coveredKobo } });
  if (!upd) throw conflict('The bill changed. Refresh and try again.');
  if (upd.patientDueKobo === 0) { const s = await db.col('bills').findOneAndUpdate({ id: billId, status: 'open' }, { $set: { status: 'paid', paidAt: now(), settledBy: 'hmo' } }); if (s) await fireSettled(s, 'hmo'); return s; }
  return upd;
}

/** void an unpaid open bill (used when the order it belongs to is cancelled). Exactly once. */
async function voidBill(billId, { orgId, reason, by }) {
  const b = await db.col('bills').findOneAndUpdate({ id: billId, orgId, status: 'open', paidKobo: 0 }, { $set: { status: 'void', voidedAt: now(), voidedBy: by || 'system', voidReason: reason || 'Order cancelled' } });
  return b; // null when already paid, already void or not found: the caller then raises a refund instead
}
function billView(b) { return b; }

/* ---------------- staff routes ---------------- */
router.get('/bills', A.requireStaff({ anyPerm: ['billing.create', 'billing.cash', 'admin.finance', 'admin.reports', 'hmo.claim'] }), ah(async (req, res) => {
  const q = query(req, { status: t.enum(['open', 'paid', 'void']), patientId: t.id(), limit: t.int({ min: 1, max: 500 }) });
  const f = { orgId: req.ctx.org.id }; if (q.status) f.status = q.status; if (q.patientId) f.patientId = q.patientId;
  const rows = await db.col('bills').find(f, { sort: { createdAt: -1 }, limit: q.limit || 100 });
  const names = {}; for (const pid of [...new Set(rows.map(r => r.patientId))]) names[pid] = await P.patientName(pid);
  res.json(rows.map(b => Object.assign({ patientName: names[b.patientId] }, billView(b))));
}));
router.get('/bills/:id', A.requireStaff({ anyPerm: ['billing.create', 'billing.cash', 'admin.finance', 'patient.read'] }), ah(async (req, res) => {
  const b = await db.col('bills').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!b) throw notFound('Bill not found');
  res.json(Object.assign({ patientName: await P.patientName(b.patientId), payments: await db.col('payments').find({ billId: b.id, status: 'success' }) }, b));
}));
router.post('/bills', A.requireStaff({ perm: 'billing.create' }), A.requireOnShift, ah(async (req, res) => {
  const b = body(req, {
    patientId: t.id({ required: true }),
    items: t.arr(t.obj({ serviceCode: t.str({ required: true, max: 24, upper: true }), qty: t.int({ min: 1, max: 100, default: 1 }) }), { max: 50 }),
    customItems: t.arr(t.obj({ name: t.str({ required: true, max: 120 }), unitPriceKobo: t.money({ required: true, min: 100, max: naira(5000000) }), qty: t.int({ min: 1, max: 100, default: 1 }) }), { max: 10 }),
    note: t.str({ max: 300 }),
  });
  await P.requireLinked(req, b.patientId);
  const lines = [];
  for (const it of b.items || []) { const s = await orgs.service(req.ctx.org.id, it.serviceCode); if (!s) throw bad('Unknown service code ' + it.serviceCode); lines.push(lineFromService(s, it.qty)); }
  if ((b.customItems || []).length) { if (!A.has(req, 'billing.custom')) throw forbidden('Your role can only bill items from the price list'); b.customItems.forEach(c => lines.push({ code: 'CUSTOM', name: c.name, category: 'other', qty: c.qty, unitPriceKobo: c.unitPriceKobo })); }
  const bill = await createBill({ orgId: req.ctx.org.id, patientId: b.patientId, lines, source: { type: 'manual', id: null }, createdBy: req.ctx.user.id, note: b.note });
  await audit(req, 'bill.create', { type: 'bill', id: bill.id, patientId: bill.patientId }, { totalKobo: bill.totalKobo, lines: lines.length });
  res.json(bill);
}));
router.post('/bills/:id/void', A.requireStaff({ perm: 'billing.void' }), ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 5, max: 300 }) });
  const bill = await db.col('bills').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id, status: 'open', paidKobo: 0 }, { $set: { status: 'void', voidedAt: now(), voidedBy: req.ctx.user.id, voidReason: b.reason } });
  if (!bill) throw conflict('Only unpaid open bills can be voided. Use a refund for paid bills.');
  await audit(req, 'bill.void', { type: 'bill', id: bill.id, patientId: bill.patientId }, { reason: b.reason });
  res.json(bill);
}));
router.post('/bills/:id/cash', A.requireStaff({ perm: 'billing.cash' }), A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { method: t.enum(['cash', 'pos', 'transfer'], { required: true }), amountKobo: t.money({ required: true, min: 1 }), receiptNo: t.str({ required: true, max: 40, label: 'Receipt / POS reference' }) });
  const bill = await db.col('bills').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!bill) throw notFound('Bill not found');
  const pay = { id: id('pay'), billId: bill.id, orgId: bill.orgId, patientId: bill.patientId, amountKobo: b.amountKobo, method: b.method, provider: 'counter', reference: 'CTR-' + req.ctx.org.code + '-' + b.receiptNo, status: 'pending', recordedBy: req.ctx.user.id, at: now() };
  try { await db.col('payments').insertOne(pay); } catch (e) { if (e.code === 11000) throw conflict('That receipt number was already recorded'); throw e; }
  let updated;
  try { updated = await applyToBill(bill.id, b.amountKobo, b.method); }
  catch (e) { await db.col('payments').updateOne({ id: pay.id }, { $set: { status: 'failed', error: e.message } }); throw e; }
  await db.col('payments').updateOne({ id: pay.id }, { $set: { status: 'success', confirmedAt: now() } });
  await audit(req, 'payment.counter', { type: 'bill', id: bill.id, patientId: bill.patientId }, { method: b.method, amountKobo: b.amountKobo, receiptNo: b.receiptNo });
  res.json(updated);
}));
router.post('/bills/:id/refund-request', A.requireStaff({ perm: 'billing.void' }), ah(async (req, res) => {
  const b = body(req, { amountKobo: t.money({ required: true, min: 1 }), reason: t.str({ required: true, min: 5, max: 300 }) });
  const bill = await db.col('bills').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id, status: 'paid' });
  if (!bill) throw notFound('Paid bill not found');
  const already = (bill.refunds || []).reduce((s, r) => s + r.amountKobo, 0);
  if (b.amountKobo > bill.paidKobo - already) throw bad('Refund is more than was paid');
  const r = { id: id('rf'), amountKobo: b.amountKobo, reason: b.reason, by: req.ctx.user.id, at: now(), status: 'approved_manual' };
  await db.col('bills').updateOne({ id: bill.id }, { $push: { refunds: r } });
  await audit(req, 'bill.refund', { type: 'bill', id: bill.id, patientId: bill.patientId }, { amountKobo: b.amountKobo });
  res.json({ ok: true, refund: r, note: 'Pay the refund to the patient from your bank or POS. Automatic Paystack refunds need the Paystack account to be live.' });
}));

/* ---------------- patient routes ---------------- */
router.get('/me/bills', A.requirePatient, ah(async (req, res) => {
  const rows = await db.col('bills').find(Object.assign({ patientId: req.ctx.patient.id, status: { $ne: 'void' } }, await P.scopeFilter(req)), { sort: { createdAt: -1 }, limit: 200 });
  const orgNames = {}; for (const oid of [...new Set(rows.map(r => r.orgId))]) { const o = await orgs.getOrg(oid); orgNames[oid] = o ? o.name : ''; }
  res.json(rows.map(b => Object.assign({ orgName: orgNames[b.orgId] }, b)));
}));

const PAY = require('../lib/payments');

router.post('/me/bills/:id/pay', A.requirePatient, ah(async (req, res) => {
  const bill = await db.col('bills').findOne({ id: param(req, 'id'), patientId: req.ctx.patient.id });
  if (!bill) throw notFound('Bill not found');
  if (bill.status !== 'open') throw conflict('This bill is already ' + bill.status);
  const amount = bill.patientDueKobo - bill.paidKobo;
  if (amount <= 0) throw conflict('Nothing to pay');
  const gw = PAY.active();
  const S = require('../lib/settings');
  if (!S.feature('onlinePayments')) throw conflict('Online payment is switched off. Please pay at the counter.', 'payments_off');
  const live = gw.configured && gw.name !== 'none';
  const reference = 'MC-' + bill.number + '-' + crypto.randomBytes(5).toString('hex');
  const pay = { id: id('pay'), billId: bill.id, orgId: bill.orgId, patientId: bill.patientId, amountKobo: amount, method: 'online', provider: live ? gw.name : 'demo', reference, status: 'pending', at: now() };
  if (!live && !config.DEMO_MODE) throw conflict('Online payment is not set up for this provider yet. Please pay at the counter.', 'payments_not_configured');
  await db.col('payments').insertOne(pay);
  await audit(req, 'payment.start', { type: 'bill', id: bill.id, patientId: bill.patientId, orgId: bill.orgId }, { amountKobo: amount, provider: pay.provider });
  if (!live) return res.json({ mode: 'demo', paymentId: pay.id, reference, amountKobo: amount, message: 'Demo mode: no card is charged.' });
  const email = req.ctx.patient.email || req.ctx.user.email || ('p' + req.ctx.patient.id.slice(-10) + '@patients.medicore.ng');
  const org = await orgs.getOrg(bill.orgId);
  const r = await gw.gateway.init({ reference, amountKobo: amount, email, phone: req.ctx.patient.phone || null, name: req.ctx.patient.firstName + ' ' + req.ctx.patient.lastName, callbackUrl: (config.PUBLIC_URL || '') + '/index.html#/pay/' + reference, org, billId: bill.id });
  if (!r.ok) { await db.col('payments').updateOne({ id: pay.id }, { $set: { status: 'failed', error: r.error || 'init_failed' } }); throw conflict('Could not start the payment. Please try again or pay at the counter.', 'payment_init_failed'); }
  await db.col('payments').updateOne({ id: pay.id }, { $set: { accessCode: r.providerRef || null } });
  res.json({ mode: gw.name, gatewayLabel: gw.label, reference, authorizationUrl: r.authorizationUrl, accessCode: gw.name === 'paystack' ? r.providerRef : undefined, amountKobo: amount });
}));

/** confirm a payment record exactly once and apply it */
async function confirmPayment(reference, paidAmountKobo, source) {
  const pay = await db.col('payments').findOneAndUpdate({ reference, status: 'pending' }, { $set: { status: 'confirming', confirmSource: source } });
  if (!pay) return { already: true };
  if (paidAmountKobo !== pay.amountKobo) { await db.col('payments').updateOne({ id: pay.id }, { $set: { status: 'mismatch', paidAmountKobo } }); console.warn('[pay] amount mismatch on', reference); return { mismatch: true }; }
  try { await applyToBill(pay.billId, pay.amountKobo, 'online'); }
  catch (e) { await db.col('payments').updateOne({ id: pay.id }, { $set: { status: 'needs_review', error: e.message } }); return { error: e.message }; }
  await db.col('payments').updateOne({ id: pay.id }, { $set: { status: 'success', confirmedAt: now() } });
  await notify({ patientId: pay.patientId, title: 'Payment received', body: 'Thank you. Your payment was successful.', kind: 'payment' });
  try { await require('../lib/events').emit('payment.success', { billId: pay.billId, orgId: pay.orgId, amountKobo: pay.amountKobo, reference, provider: pay.provider }); } catch (e) { /* best effort */ }
  return { ok: true };
}

router.post('/pay/demo/:paymentId/complete', A.requirePatient, ah(async (req, res) => {
  if (!config.DEMO_MODE) throw forbidden('Demo payments are switched off');
  const pay = await db.col('payments').findOne({ id: param(req, 'paymentId'), patientId: req.ctx.patient.id });
  if (!pay) throw notFound('Payment not found');
  if (pay.provider !== 'demo') throw forbidden('This payment goes through the live gateway');
  const r = await confirmPayment(pay.reference, pay.amountKobo, 'demo');
  if (r.error) throw conflict(r.error);
  res.json({ ok: true, already: !!r.already });
}));

router.get('/pay/verify/:reference', A.requirePatient, ah(async (req, res) => {
  const ref = String(req.params.reference || '').slice(0, 80);
  const pay = await db.col('payments').findOne({ reference: ref, patientId: req.ctx.patient.id });
  if (!pay) throw notFound('Payment not found');
  if (pay.status === 'success') return res.json({ status: 'success' });
  const g = PAY.gateway(pay.provider);
  if (!g || !g.configured()) return res.json({ status: pay.status });
  const v = await g.verify(ref);
  if (v.status === 'success') { const c = await confirmPayment(ref, v.amountKobo, 'verify'); if (c.ok || c.already) { const p2 = await db.col('payments').findOne({ id: pay.id }); return res.json({ status: p2.status === 'success' ? 'success' : p2.status }); } return res.json({ status: c.mismatch ? 'mismatch' : 'needs_review' }); }
  res.json({ status: v.status === 'failed' ? 'failed' : pay.status });
}));

/* gateway webhooks: each gateway's signature is checked against the raw body; gateways retry until they get 200 */
router.post('/pay/:provider/webhook', ah(async (req, res) => {
  const name = String(req.params.provider || '');
  const g = PAY.gateway(name);
  if (!g || !g.configured()) return res.status(404).end();
  const r = await g.webhook(req);
  if (!r.ok) return res.status(401).end();
  for (const ev of r.events || []) if (ev.status === 'success' && ev.reference) {
    const pay = await db.col('payments').findOne({ reference: ev.reference });
    if (pay && pay.provider === name) await confirmPayment(ev.reference, Number(ev.amountKobo), 'webhook');
  }
  res.json({ ok: true });
}));

module.exports = { name: 'billing', router, fireSettledExternal: (b) => fireSettled(b, 'hmo_external'), createBill, voidBill, applyToBill, setHmoCover, onSettled, lineFromService, confirmPayment };
