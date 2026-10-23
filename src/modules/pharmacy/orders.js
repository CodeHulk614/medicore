'use strict';
/*
 * Prescription orders (rx_orders): a prescription from ANY provider, sent by the patient (or
 * their doctor) to the pharmacy they chose.
 *
 *   received -> verified -> priced -> paid -> [allocating] -> ready -> collected
 *            \-> queried -/                                       \-> out_for_delivery -> delivered
 *   received | queried | verified -> rejected
 *   received | queried | verified | priced | paid | ready -> cancelled
 *   out_for_delivery -> ready (delivery failed and returned to the pharmacy)
 *
 * - priced -> paid happens ONLY in billing.onSettled('rx_order').
 * - Stock leaves the shelf exactly once, at paid -> allocating -> ready (conditional claim).
 * - Every transition is a conditional findOneAndUpdate on the current status.
 */
const express = require('express');
const db = require('../../db');
const { ah, body, query, t, bad, forbidden, notFound, conflict, locked, param } = require('../../lib/http');
const { id, now } = require('../../lib/util');
const { audit } = require('../../lib/audit');
const { notify } = require('../../lib/notify');
const A = require('../../lib/auth');
const RL = require('../../lib/ratelimit');
const P = require('../patients');
const billing = require('../billing');
const safety = require('../../clinical/safety');
const C = require('./common');

const router = express.Router();

const TRANSITIONS = {
  received: ['verified', 'queried', 'rejected', 'cancelled', 'priced'], // received -> priced only when HQ switches off requirePharmacistVerify
  queried: ['verified', 'rejected', 'cancelled'],
  verified: ['priced', 'rejected', 'cancelled'],
  priced: ['priced', 'paid', 'cancelled'],
  paid: ['allocating', 'cancelled'],
  allocating: ['ready', 'paid'],
  ready: ['collected', 'out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered', 'ready'],
  collected: [], delivered: [], rejected: [], cancelled: [],
};
const ACTIVE = ['received', 'queried', 'verified', 'priced', 'paid', 'allocating', 'ready', 'out_for_delivery'];

/**
 * Conditional status change. `from` is the list of states the caller accepts; each must be
 * allowed to move to `to` by TRANSITIONS. Returns the updated order, or null if it was not in
 * one of those states (already done, or wrong state).
 */
async function transition(orderId, pharmacyOrgId, from, to, set, who, note, extraFilter) {
  const ok = (Array.isArray(from) ? from : [from]).filter(s => TRANSITIONS[s] && TRANSITIONS[s].includes(to));
  if (!ok.length) return null;
  const f = Object.assign({ id: orderId, pharmacyOrgId, status: { $in: ok } }, extraFilter || {});
  return db.col('rx_orders').findOneAndUpdate(f, { $set: Object.assign({}, set || {}, { status: to, updatedAt: now() }), $push: { timeline: { status: to, at: now(), by: who || null, note: note || null } } });
}
async function mustTransition(req, order, from, to, set, note, extraFilter) {
  const r = await transition(order.id, order.pharmacyOrgId, from, to, set, req && req.ctx && req.ctx.user ? req.ctx.user.id : null, note, extraFilter);
  if (!r) { const cur = await db.col('rx_orders').findOne({ id: order.id, pharmacyOrgId: order.pharmacyOrgId }); throw conflict('This order is ' + (cur ? cur.status : 'gone') + '. It cannot move to ' + to + '.', 'wrong_state'); }
  return r;
}
/** give the prescription back to the patient so they can send it to another pharmacy */
async function releasePrescription(order) {
  await db.col('prescriptions').updateOne({ id: order.prescriptionId, 'routedTo.rxOrderId': order.id }, { $set: { status: 'active', routedTo: null, releasedAt: now() } });
}
const releaseKey = order => ({ rxKey: order.prescriptionId + ':' + order.id });

/* ================= contract: createOrderFromPrescription ================= */
async function createOrderFromPrescription({ prescription, pharmacyOrgId, fulfilment, address, location, requestedBy }) {
  if (!prescription || !prescription.id) throw bad('Prescription is required');
  const rx = await db.col('prescriptions').findOne({ id: prescription.id });
  if (!rx) throw notFound('Prescription not found');
  if (!['pickup', 'delivery'].includes(fulfilment)) throw bad('Choose pickup or delivery');
  if (!['doctor', 'patient'].includes(requestedBy)) throw bad('requestedBy must be doctor or patient');
  const ph = await db.col('orgs').findOne({ id: pharmacyOrgId, status: 'active' });
  if (!ph || !(ph.modules || []).includes('pharmacy')) throw notFound('Pharmacy not found');
  if (fulfilment === 'delivery') {
    if (!C.homeDelivery(ph)) throw bad('Home delivery is not available at the moment. Choose pickup.');
    if (!(ph.modules || []).includes('delivery')) throw bad(ph.name + ' does not deliver. Choose pickup or another pharmacy.');
    if (!address) throw bad('A delivery address is required');
  }
  if (!Array.isArray(rx.items) || !rx.items.length) throw bad('This prescription has no items');
  const patient = await db.col('patients').findOne({ id: rx.patientId });
  if (!patient || patient.status === 'removed') throw notFound('Patient not found');

  // claim the prescription: active and unsent (or pre-marked sent to this pharmacy by the clinic)
  const claimed = await db.col('prescriptions').findOneAndUpdate(
    { id: rx.id, $or: [{ status: 'active', routedTo: null }, { status: 'sent', 'routedTo.pharmacyOrgId': pharmacyOrgId, 'routedTo.rxOrderId': null }] },
    { $set: { status: 'sent', routedTo: { pharmacyOrgId, rxOrderId: null }, sentAt: now() } });
  if (!claimed) throw conflict(rx.status === 'cancelled' ? 'This prescription was cancelled by the prescriber' : 'This prescription has already been sent to a pharmacy', 'already_sent');

  const prescOrg = await db.col('orgs').findOne({ id: rx.orgId });
  const oid = id('rxo');
  const order = {
    id: oid, orgId: pharmacyOrgId, pharmacyOrgId, patientId: rx.patientId, prescriptionId: rx.id, rxKey: rx.id,
    prescriberOrgId: rx.orgId, prescriberOrgName: prescOrg ? prescOrg.name : null, prescriberName: rx.prescriberName || null, prescriberUserId: rx.prescriberUserId || null, encounterId: rx.encounterId || null,
    items: rx.items, prescriberSafety: rx.safety || null, prescribedAt: rx.createdAt || null,
    fulfilment, address: address || null, location: location || (fulfilment === 'delivery' ? patient.homeLoc || null : null), requestedBy,
    status: 'received', verification: null, lines: [], billId: null, deliveryFeeKobo: 0, totalKobo: 0, priceRev: 0,
    allocations: [], pickupCodeHash: null, pickupNonce: null, pickupAttempts: 0, deliveryId: null, refundDue: null,
    timeline: [{ status: 'received', at: now(), by: null, note: 'sent by ' + requestedBy }], createdAt: now(), updatedAt: now(),
  };
  try { await db.col('rx_orders').insertOne(order); }
  catch (e) {
    await db.col('prescriptions').updateOne({ id: rx.id, 'routedTo.rxOrderId': null, 'routedTo.pharmacyOrgId': pharmacyOrgId }, { $set: { status: rx.status === 'sent' ? 'sent' : 'active', routedTo: rx.routedTo || null } });
    if (e.code === 11000) throw conflict('This prescription already has an order', 'already_sent');
    throw e;
  }
  await db.col('prescriptions').updateOne({ id: rx.id }, { $set: { 'routedTo.rxOrderId': oid } });
  await P.ensureLink(pharmacyOrgId, rx.patientId, null, requestedBy === 'patient' ? 'patient' : 'prescriber');
  await notify({ orgId: pharmacyOrgId, role: 'pharmacist', title: 'New prescription received', body: 'A ' + fulfilment + ' order is waiting for verification.', kind: 'rx_order', ref: { type: 'rx_order', id: oid } });
  return order;
}

/* ================= views ================= */
async function billSummary(billId) {
  if (!billId) return null;
  const b = await db.col('bills').findOne({ id: billId });
  return b ? { id: b.id, number: b.number, status: b.status, totalKobo: b.totalKobo, patientDueKobo: b.patientDueKobo, paidKobo: b.paidKobo, lines: b.lines, hmo: b.hmo ? { coveredKobo: b.hmo.coveredKobo } : null } : null;
}
function stripSecrets(o) { const v = Object.assign({}, o); delete v.pickupCodeHash; delete v.pickupNonce; delete v.rxKey; return v; }
function collectBy(o, org) { return o.status === 'ready' && o.fulfilment === 'pickup' && o.readyAt ? o.readyAt + C.pickupWindowDays(org) * 86400e3 : null; }
async function staffOrderView(o) {
  const org = await db.col('orgs').findOne({ id: o.pharmacyOrgId });
  const v = stripSecrets(o);
  v.collectBy = collectBy(o, org); v.pickupOverdue = !!(v.collectBy && Date.now() > v.collectBy);
  v.bill = await billSummary(o.billId);
  if (o.deliveryId) { const d = await db.col('deliveries').findOne({ id: o.deliveryId, orgId: o.pharmacyOrgId }); v.delivery = d ? { id: d.id, status: d.status, riderMembershipId: d.riderMembershipId || null, locked: !!d.locked } : null; }
  v.pickupLocked = o.pickupAttempts >= C.codeTries(org);
  return v;
}
async function patientOrderView(o) {
  const ph = await db.col('orgs').findOne({ id: o.pharmacyOrgId });
  const v = {
    id: o.id, status: o.status === 'allocating' ? 'paid' : o.status, fulfilment: o.fulfilment, prescriptionId: o.prescriptionId,
    pharmacy: ph ? { id: ph.id, name: ph.name, phone: (ph.contact || {}).phone || null, address: (ph.contact || {}).address || null, location: ph.location ? { lat: ph.location.lat, lng: ph.location.lng } : null } : null,
    items: o.items.map(i => ({ drugName: i.drugName, doseText: i.doseText || null, frequency: i.frequency || null, durationDays: i.durationDays || null, quantity: i.quantity, instructions: i.instructions || null })),
    lines: (o.lines || []).map(l => ({ name: l.name, qty: l.qty, unitPriceKobo: l.unitPriceKobo, totalKobo: l.totalKobo, substituted: !!l.substitutedFor, substitutionReason: l.substitutionReason || null, supplied: l.supplied !== false })),
    deliveryFeeKobo: o.deliveryFeeKobo || 0, totalKobo: o.totalKobo || 0, address: o.address, bill: await billSummary(o.billId),
    pickupCode: null, collectBy: collectBy(o, ph), delivery: null, message: null, refundDue: o.refundDue || null,
    timeline: (o.timeline || []).filter(x => x.status !== 'allocating').map(x => ({ status: x.status, at: x.at })), createdAt: o.createdAt,
  };
  if (['rejected', 'queried'].includes(o.status) && o.verification) v.message = o.verification.reason;
  if (o.status === 'cancelled') v.message = o.cancelReason || null;
  if (o.status === 'ready' && o.fulfilment === 'pickup' && o.pickupNonce) {
    if (o.pickupAttempts >= C.codeTries(ph)) v.message = 'Your pickup code was locked after too many wrong tries. Ask the pharmacist for a new code.';
    else v.pickupCode = C.codeFor('pickup', o.id, o.pickupNonce);
  }
  if (o.deliveryId) {
    const d = await db.col('deliveries').findOne({ id: o.deliveryId, patientId: o.patientId });
    if (d) v.delivery = { id: d.id, status: d.status, deliveryCode: ['pending', 'assigned', 'picked_up'].includes(d.status) && !d.locked ? C.codeFor('delivery', d.id, d.codeNonce) : null };
  }
  return v;
}
async function loadStaffOrder(req) {
  const o = await db.col('rx_orders').findOne({ id: param(req, 'id'), pharmacyOrgId: req.ctx.org.id });
  if (!o) throw notFound('Order not found');
  return o;
}

/* ================= billing hook: the only way to reach `paid` ================= */
async function onPaid(bill, how) {
  const o = await transition(bill.source.id, bill.orgId, ['priced'], 'paid', { paidAt: now(), paidHow: how || null }, null, 'payment settled', { billId: bill.id });
  if (!o) return;
  await notify({ orgId: o.pharmacyOrgId, role: 'pharmacist', title: 'Prescription order paid', body: 'An order is paid and ready to prepare.', kind: 'rx_order', ref: { type: 'rx_order', id: o.id } });
}
billing.onSettled('rx_order', onPaid);

/* ================= staff: queue and detail ================= */
router.get('/pharmacy/orders', C.G.read, ah(async (req, res) => {
  const q = query(req, { status: t.enum(Object.keys(TRANSITIONS)), active: t.bool(), fulfilment: t.enum(['pickup', 'delivery']), patientId: t.id(), limit: t.int({ min: 1, max: 500 }) });
  const f = { pharmacyOrgId: req.ctx.org.id };
  if (q.status) f.status = q.status; else if (q.active) f.status = { $in: ACTIVE };
  if (q.fulfilment) f.fulfilment = q.fulfilment; if (q.patientId) f.patientId = q.patientId;
  const rows = await db.col('rx_orders').find(f, { sort: { createdAt: -1 }, limit: q.limit || 100 });
  const names = {}; for (const pid of [...new Set(rows.map(r => r.patientId))]) names[pid] = await P.patientName(pid);
  res.json(rows.map(o => ({ id: o.id, status: o.status, fulfilment: o.fulfilment, patientId: o.patientId, patientName: names[o.patientId], prescriberName: o.prescriberName, prescriberOrgName: o.prescriberOrgName, itemCount: o.items.length, totalKobo: o.totalKobo, billId: o.billId, deliveryId: o.deliveryId, createdAt: o.createdAt, updatedAt: o.updatedAt })));
}));
router.get('/pharmacy/orders/:id', C.G.read, ah(async (req, res) => {
  const o = await loadStaffOrder(req);
  const { patient, link } = await P.requireLinked(req, o.patientId);
  await audit(req, 'pharmacy.order_view', { type: 'rx_order', id: o.id, patientId: o.patientId });
  res.json(Object.assign(await staffOrderView(o), { patient: P.staffView(patient, link) }));
}));

async function currentMedsFor(orgId, patientId, excludeId) {
  const since = now() - 90 * 86400e3;
  const rows = await db.col('rx_orders').find({ pharmacyOrgId: orgId, patientId, status: { $in: ['ready', 'collected', 'delivered', 'out_for_delivery'] }, updatedAt: { $gte: since } });
  const out = [];
  rows.filter(r => r.id !== excludeId).forEach(r => (r.lines || []).filter(l => l.supplied !== false).forEach(l => out.push({ drugCode: l.drugCode, drugName: l.name })));
  return out;
}
async function runSafety(req, o, pregnant) {
  const { patient } = await P.requireLinked(req, o.patientId);
  const items = o.items.map(i => ({ drugCode: i.drugCode, drugName: i.drugName, doseMg: i.doseMg, frequency: i.frequency, durationDays: i.durationDays, quantity: i.quantity }));
  return safety.check({ patient, items, currentMeds: await currentMedsFor(req.ctx.org.id, o.patientId, o.id), pregnant: !!pregnant });
}
/* preview the safety check (no state change) */
router.get('/pharmacy/orders/:id/safety', C.G.verify, ah(async (req, res) => {
  const q = query(req, { pregnant: t.bool() });
  const o = await loadStaffOrder(req);
  res.json(Object.assign({ prescriberSafety: o.prescriberSafety }, await runSafety(req, o, q.pregnant)));
}));

/* verify: pharmacist re-runs safety against the patient and records a decision */
router.post('/pharmacy/orders/:id/verify', C.G.verify, C.G.onShift, ah(async (req, res) => {
  const b = body(req, { decision: t.enum(['proceed', 'reject', 'query'], { required: true }), reason: t.str({ max: 500 }), pregnant: t.bool() });
  const o = await loadStaffOrder(req);
  if (!['received', 'queried'].includes(o.status)) throw conflict('This order is ' + o.status + ' and has already been verified', 'wrong_state');
  const s = await runSafety(req, o, b.pregnant);
  if (b.decision === 'proceed' && s.blocking && (!b.reason || b.reason.length < 5)) {
    const e = bad('This order has blocking safety alerts. Record your reason to proceed, or reject or query it with the prescriber.', s.alerts); e.code = 'safety_blocking'; throw e;
  }
  if (b.decision !== 'proceed' && (!b.reason || b.reason.length < 5)) throw bad('Give a reason (at least 5 characters)');
  const verification = { by: req.ctx.user.id, byName: req.ctx.user.name, at: now(), alerts: s.alerts, blocking: s.blocking, decision: b.decision, reason: b.reason || null, pregnant: !!b.pregnant };
  const to = { proceed: 'verified', reject: 'rejected', query: 'queried' }[b.decision];
  const set = { verification };
  if (to === 'rejected') Object.assign(set, releaseKey(o));
  const upd = await mustTransition(req, o, ['received', 'queried'], to, set, b.decision === 'proceed' ? (s.blocking ? 'override: ' + b.reason : null) : b.reason);
  if (to === 'rejected') {
    await releasePrescription(upd);
    await notify({ patientId: o.patientId, title: 'Pharmacy could not fill your prescription', body: 'Open the MediCore app to see why. You can send it to another pharmacy.', kind: 'rx_order', ref: { type: 'rx_order', id: o.id } });
  }
  if (to === 'queried' && o.prescriberUserId) await notify({ userId: o.prescriberUserId, title: 'Pharmacy query on a prescription', body: req.ctx.org.name + ' has a question about a prescription you wrote. Please call the pharmacy.', kind: 'rx_query', ref: { type: 'rx_order', id: o.id } });
  await audit(req, 'pharmacy.order_verify', { type: 'rx_order', id: o.id, patientId: o.patientId }, { decision: b.decision, blocking: s.blocking, alerts: s.alerts.length });
  res.json(await staffOrderView(upd));
}));

/* price: lines from this pharmacy's own sell prices; quantities from the prescription */
router.post('/pharmacy/orders/:id/price', C.G.dispense, C.G.onShift, ah(async (req, res) => {
  const b = body(req, {
    lines: t.arr(t.obj({ rxIndex: t.int({ required: true, min: 0, max: 99 }), itemId: t.id(), supply: t.bool({ default: true }), substitutionReason: t.str({ max: 300 }), notSuppliedReason: t.str({ max: 300 }) }), { max: 100 }),
  });
  const o = await loadStaffOrder(req);
  const priceFrom = C.requireVerify(req.ctx.org) ? ['verified', 'priced'] : ['received', 'verified', 'priced'];
  if (!priceFrom.includes(o.status)) throw conflict(['paid', 'allocating', 'ready', 'collected', 'out_for_delivery', 'delivered'].includes(o.status) ? 'This order is already paid. Re-pricing after payment is not allowed.' : 'Verify the order before pricing it (it is ' + o.status + ')', 'wrong_state');
  const orgId = req.ctx.org.id;
  const spec = {}; for (const l of b.lines || []) { if (spec[l.rxIndex]) throw bad('Each prescription item can be priced once'); if (l.rxIndex >= o.items.length) throw bad('No prescription item at position ' + l.rxIndex); spec[l.rxIndex] = l; }
  const lines = [];
  for (let i = 0; i < o.items.length; i++) {
    const rxi = o.items[i]; const s = spec[i] || {};
    if (s.supply === false) { if (!s.notSuppliedReason || s.notSuppliedReason.length < 5) throw bad('Say why ' + rxi.drugName + ' is not supplied'); lines.push({ rxIndex: i, supplied: false, name: rxi.drugName, notSuppliedReason: s.notSuppliedReason, qty: 0, unitPriceKobo: 0, totalKobo: 0 }); continue; }
    if (!Number.isInteger(rxi.quantity) || rxi.quantity < 1 || rxi.quantity > 1000) throw bad('The prescription has no valid quantity for ' + rxi.drugName + '. Query the prescriber.');
    let it = null;
    if (s.itemId) it = await db.col('pharmacy_items').findOne({ id: s.itemId, orgId, active: { $ne: false } });
    else if (rxi.drugCode) it = await db.col('pharmacy_items').findOne({ orgId, drugCode: rxi.drugCode, active: { $ne: false } });
    if (!it) throw (s.itemId ? notFound('Item not found') : bad('No stock item matches ' + rxi.drugName + '. Choose an item to substitute, or mark it not supplied.'));
    const substituted = !rxi.drugCode || it.drugCode !== rxi.drugCode;
    if (substituted && !C.allowSubstitution(req.ctx.org)) throw bad('Substitutions are switched off. ' + rxi.drugName + ' must be supplied as prescribed or marked not supplied.');
    if (substituted && (!s.substitutionReason || s.substitutionReason.length < 5)) throw bad('Give a substitution reason for ' + rxi.drugName + ' (at least 5 characters)');
    lines.push({ rxIndex: i, supplied: true, itemId: it.id, drugCode: it.drugCode, name: it.name, controlled: !!it.controlled, qty: rxi.quantity, unitPriceKobo: it.sellPriceKobo, totalKobo: it.sellPriceKobo * rxi.quantity,
      substitutedFor: substituted ? (rxi.drugCode || rxi.drugName) : null, substitutionReason: substituted ? s.substitutionReason : null });
  }
  const supplied = lines.filter(l => l.supplied);
  if (!supplied.length) throw bad('At least one item must be supplied. Reject the order instead.');
  const need = {}; supplied.forEach(l => { need[l.itemId] = (need[l.itemId] || 0) + l.qty; });
  for (const [itemId, q] of Object.entries(need)) { const have = await C.availableQty(orgId, itemId); if (have < q) { const it = supplied.find(l => l.itemId === itemId); throw conflict('Not enough ' + it.name + ' in stock: ' + have + ' usable, ' + q + ' needed.', 'insufficient_stock'); } }
  if (o.status === 'received') {
    // verification is switched off: the safety check still runs and blocking alerts still need a pharmacist
    const sc = await runSafety(req, o);
    if (sc.blocking) { const e = bad('This order has blocking safety alerts. A pharmacist must verify it first.', sc.alerts); e.code = 'safety_blocking'; throw e; }
  }
  const deliveryFeeKobo = o.fulfilment === 'delivery' ? ((req.ctx.org.settings || {}).deliveryFeeKobo || 0) : 0;

  // claim this pricing round so two parallel price calls cannot both raise a bill
  const claimed = await db.col('rx_orders').findOneAndUpdate({ id: o.id, pharmacyOrgId: orgId, status: o.status, priceRev: o.priceRev }, { $inc: { priceRev: 1 } });
  if (!claimed) throw conflict('This order changed while pricing. Refresh and try again.', 'wrong_state');
  if (o.billId) {
    const voided = await db.col('bills').findOneAndUpdate({ id: o.billId, orgId, status: 'open', paidKobo: 0 }, { $set: { status: 'void', voidedAt: now(), voidedBy: req.ctx.user.id, voidReason: 'Order re-priced' } });
    if (!voided) throw conflict('Payment has started on this order. Re-pricing after payment is not allowed.', 'already_paid');
  }
  const billLines = supplied.map(l => ({ code: l.drugCode || 'RX-ITEM', name: l.name, category: 'drug', qty: l.qty, unitPriceKobo: l.unitPriceKobo }));
  if (deliveryFeeKobo > 0) billLines.push({ code: 'DELIV', name: 'Home delivery', category: 'delivery', qty: 1, unitPriceKobo: deliveryFeeKobo });
  const bill = await billing.createBill({ orgId, patientId: o.patientId, lines: billLines, source: { type: 'rx_order', id: o.id }, createdBy: req.ctx.user.id });
  const totalKobo = bill.totalKobo;
  const upd = await transition(o.id, orgId, [o.status], 'priced', { lines, billId: bill.id, deliveryFeeKobo, totalKobo, pricedAt: now(), pricedBy: req.ctx.user.id }, req.ctx.user.id, o.status === 'priced' ? 're-priced' : null, { priceRev: o.priceRev + 1 });
  if (!upd) { await db.col('bills').updateOne({ id: bill.id, status: 'open', paidKobo: 0 }, { $set: { status: 'void', voidedAt: now(), voidReason: 'Order changed while pricing' } }); throw conflict('This order changed while pricing. Refresh and try again.', 'wrong_state'); }
  if (bill.status === 'paid') await onPaid(bill, 'free');
  await audit(req, 'pharmacy.order_price', { type: 'rx_order', id: o.id, patientId: o.patientId }, { totalKobo, lines: supplied.length, substitutions: supplied.filter(l => l.substitutedFor).length, billId: bill.id });
  if (o.status === 'verified') await notify({ patientId: o.patientId, title: 'Your prescription is ready to pay', body: 'Open the MediCore app to pay for your order at ' + req.ctx.org.name + '.', kind: 'rx_order', ref: { type: 'rx_order', id: o.id } });
  res.json(await staffOrderView(await db.col('rx_orders').findOne({ id: o.id })));
}));

/* ready: stock allocated FEFO and deducted exactly once */
router.post('/pharmacy/orders/:id/ready', C.G.dispense, C.G.onShift, ah(async (req, res) => {
  const o = await loadStaffOrder(req);
  if (o.status !== 'paid') throw conflict(o.status === 'priced' ? 'This order is not paid yet' : 'This order is ' + o.status, 'wrong_state');
  const claimed = await mustTransition(req, o, ['paid'], 'allocating', { allocatingAt: now() });
  const orgId = req.ctx.org.id;
  const agg = {}; claimed.lines.filter(l => l.supplied !== false).forEach(l => { agg[l.itemId] = (agg[l.itemId] || 0) + l.qty; });
  let takes;
  try { takes = await C.allocateFefo(orgId, Object.entries(agg).map(([itemId, qty]) => ({ itemId, qty }))); }
  catch (e) { await transition(o.id, orgId, ['allocating'], 'paid', {}, req.ctx.user.id, 'allocation failed'); throw e; }
  const who = C.actor(req); const ref = { type: 'rx_order', id: o.id };
  const set = { allocations: takes.map(t => ({ itemId: t.itemId, batchId: t.batchId, batchNo: t.batchNo, expiry: t.expiry, qty: t.qty })), readyAt: now(), dispensedBy: req.ctx.user.id, dispensedByName: req.ctx.user.name };
  let code = null;
  if (o.fulfilment === 'pickup') { code = C.newCode('pickup', o.id); Object.assign(set, { pickupCodeHash: code.hash, pickupNonce: code.nonce, pickupAttempts: 0 }); }
  const upd = await transition(o.id, orgId, ['allocating'], 'ready', set, req.ctx.user.id);
  if (!upd) { await C.revertTakes(orgId, takes); throw conflict('This order changed while preparing it', 'wrong_state'); }
  await C.commitTakes(orgId, takes, { type: 'dispense', ref, reason: 'prescription dispensed', who });
  await C.registerControlled({ orgId, takes, patientId: o.patientId, ref, who });
  const patient = await db.col('patients').findOne({ id: o.patientId });
  let final = upd;
  if (o.fulfilment === 'pickup') {
    await notify({ patientId: o.patientId, title: 'Your medicines are ready', body: 'Collect them at ' + req.ctx.org.name + '. Pickup code: ' + code.code, kind: 'rx_ready', ref, sms: patient && patient.phone });
  } else {
    const D = require('./delivery');
    const d = await D.createDelivery({ orgId, kind: 'medication', rxOrderId: o.id, patientId: o.patientId, address: o.address, location: o.location });
    final = await db.col('rx_orders').findOneAndUpdate({ id: o.id, pharmacyOrgId: orgId }, { $set: { deliveryId: d.id } });
    await notify({ patientId: o.patientId, title: 'Your medicines are packed', body: req.ctx.org.name + ' will send a rider soon. Your delivery code is in the app.', kind: 'rx_ready', ref });
  }
  await audit(req, 'pharmacy.order_ready', { type: 'rx_order', id: o.id, patientId: o.patientId }, { batches: takes.length, units: takes.reduce((s, t) => s + t.qty, 0) });
  res.json(await staffOrderView(final));
}));

/* collect: pickup only, with the patient's 6-digit code; 5 wrong tries lock the code */
router.post('/pharmacy/orders/:id/collect', C.G.dispense, C.G.onShift, ah(async (req, res) => {
  const b = body(req, { code: t.str({ required: true, max: 6, pattern: /^\d{6}$/, label: 'Pickup code' }) });
  const o = await loadStaffOrder(req);
  if (o.status !== 'ready' || o.fulfilment !== 'pickup') throw conflict(o.fulfilment !== 'pickup' ? 'This order is for delivery' : 'This order is ' + o.status, 'wrong_state');
  const tries = C.codeTries(req.ctx.org);
  if (o.pickupAttempts >= tries) throw locked('Too many wrong codes. A pharmacist must issue a new pickup code.', 'code_locked');
  if (!C.codeMatches('pickup', o.id, b.code, o.pickupCodeHash)) {
    const after = await db.col('rx_orders').findOneAndUpdate({ id: o.id, pharmacyOrgId: req.ctx.org.id, status: 'ready', pickupAttempts: { $lt: tries } }, { $inc: { pickupAttempts: 1 } });
    await audit(req, 'pharmacy.pickup_code_wrong', { type: 'rx_order', id: o.id, patientId: o.patientId }, { attempts: after ? after.pickupAttempts : null });
    if (!after || after.pickupAttempts >= tries) throw locked('Too many wrong codes. A pharmacist must issue a new pickup code.', 'code_locked');
    throw bad('That pickup code is not correct');
  }
  const upd = await mustTransition(req, o, ['ready'], 'collected', { collectedAt: now(), collectedBy: req.ctx.user.id }, null, { fulfilment: 'pickup', pickupCodeHash: o.pickupCodeHash, pickupAttempts: { $lt: tries } });
  await audit(req, 'pharmacy.order_collect', { type: 'rx_order', id: o.id, patientId: o.patientId });
  res.json(await staffOrderView(upd));
}));
router.post('/pharmacy/orders/:id/reissue-code', C.G.verify, C.G.onShift, ah(async (req, res) => {
  const o = await loadStaffOrder(req);
  if (o.status !== 'ready' || o.fulfilment !== 'pickup') throw conflict('Only ready pickup orders have a pickup code', 'wrong_state');
  const code = C.newCode('pickup', o.id);
  const upd = await db.col('rx_orders').findOneAndUpdate({ id: o.id, pharmacyOrgId: req.ctx.org.id, status: 'ready' }, { $set: { pickupCodeHash: code.hash, pickupNonce: code.nonce, pickupAttempts: 0 } });
  if (!upd) throw conflict('This order changed', 'wrong_state');
  const patient = await db.col('patients').findOne({ id: o.patientId });
  await notify({ patientId: o.patientId, title: 'New pickup code', body: 'Your new pickup code for ' + req.ctx.org.name + ' is ' + code.code, kind: 'rx_ready', ref: { type: 'rx_order', id: o.id }, sms: patient && patient.phone });
  await audit(req, 'pharmacy.pickup_code_reissue', { type: 'rx_order', id: o.id, patientId: o.patientId });
  res.json({ ok: true });
}));

/* cancel (pharmacy side) */
async function cancelOrder(req, o, reason, allowed) {
  let cur = o;
  if (cur.status === 'priced' && allowed.includes('priced')) {
    const voided = await db.col('bills').findOneAndUpdate({ id: cur.billId, orgId: cur.pharmacyOrgId, status: 'open', paidKobo: 0 }, { $set: { status: 'void', voidedAt: now(), voidedBy: req.ctx.user.id, voidReason: 'Order cancelled' } });
    if (!voided) { cur = await db.col('rx_orders').findOne({ id: o.id }); if (cur.status === 'priced') throw conflict('Payment is in progress on this order. Try again in a moment.', 'payment_in_progress'); }
  }
  if (!allowed.includes(cur.status)) throw conflict('This order is ' + cur.status + ' and cannot be cancelled' + (cur.status === 'out_for_delivery' ? ' until the rider returns it' : ''), 'wrong_state');
  const set = Object.assign({ cancelledAt: now(), cancelReason: reason, cancelledBy: req.ctx.user.id }, releaseKey(cur));
  let bill = null;
  if (['paid', 'ready'].includes(cur.status)) { bill = await db.col('bills').findOne({ id: cur.billId }); if (bill && bill.paidKobo > 0) set.refundDue = { billId: bill.id, amountKobo: bill.paidKobo, note: 'Refund the patient: Bills > ' + bill.number + ' > Refund (needs billing.void).' }; }
  const upd = await mustTransition(req, cur, [cur.status], 'cancelled', set, reason);
  if (cur.status === 'ready') {
    // stock that was deducted for this order goes back to the same batches
    for (const a of cur.allocations || []) {
      const after = await C.addToBatch(cur.pharmacyOrgId, a.batchId, a.qty);
      await C.writeMove({ orgId: cur.pharmacyOrgId, itemId: a.itemId, batchId: a.batchId, type: 'return_in', qty: a.qty, balanceAfter: after ? after.qty : null, reason: 'order cancelled before hand-over', ref: { type: 'rx_order', id: cur.id }, who: C.actor(req) });
    }
    if (cur.deliveryId) await db.col('deliveries').updateOne({ id: cur.deliveryId, orgId: cur.pharmacyOrgId, status: { $in: ['pending', 'assigned'] } }, { $set: { status: 'cancelled', updatedAt: now() }, $push: { timeline: { status: 'cancelled', at: now(), by: req.ctx.user.id } } });
  }
  await releasePrescription(upd);
  return upd;
}
router.post('/pharmacy/orders/:id/cancel', C.G.orderAct, C.G.onShift, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 5, max: 300 }) });
  const o = await loadStaffOrder(req);
  const upd = await cancelOrder(req, o, b.reason, ['received', 'queried', 'verified', 'priced', 'paid', 'ready']);
  await notify({ patientId: o.patientId, title: 'Your pharmacy order was cancelled', body: 'Open the MediCore app for details.' + (upd.refundDue ? ' A refund is due to you.' : ''), kind: 'rx_order', ref: { type: 'rx_order', id: o.id } });
  await audit(req, 'pharmacy.order_cancel', { type: 'rx_order', id: o.id, patientId: o.patientId }, { from: o.status, refundDueKobo: upd.refundDue ? upd.refundDue.amountKobo : 0 });
  res.json(await staffOrderView(upd));
}));

/* ================= patient routes ================= */
router.get('/me/prescriptions', A.requirePatient, ah(async (req, res) => {
  const rows = await db.col('prescriptions').find(Object.assign({ patientId: req.ctx.patient.id }, await P.scopeFilter(req)), { sort: { createdAt: -1 }, limit: 200 });
  const orgName = {}; const out = [];
  for (const r of rows) {
    if (!(r.orgId in orgName)) { const o = await db.col('orgs').findOne({ id: r.orgId }); orgName[r.orgId] = o ? o.name : null; }
    let order = null;
    if (r.routedTo && r.routedTo.rxOrderId) {
      const o = await db.col('rx_orders').findOne({ id: r.routedTo.rxOrderId, patientId: req.ctx.patient.id });
      if (o) { const ph = await db.col('orgs').findOne({ id: o.pharmacyOrgId }); order = { id: o.id, status: o.status === 'allocating' ? 'paid' : o.status, fulfilment: o.fulfilment, pharmacyOrgId: o.pharmacyOrgId, pharmacyName: ph ? ph.name : null, totalKobo: o.totalKobo, billId: o.billId, deliveryId: o.deliveryId }; }
    }
    const past = await db.col('rx_orders').find({ prescriptionId: r.id, patientId: req.ctx.patient.id, status: { $in: ['rejected', 'cancelled'] } }, { projection: { id: 1, status: 1, pharmacyOrgId: 1 } });
    out.push({ id: r.id, prescriberOrgId: r.orgId, prescriberOrgName: orgName[r.orgId], prescriberName: r.prescriberName || null, createdAt: r.createdAt, status: r.status,
      items: (r.items || []).map(i => ({ drugCode: i.drugCode || null, drugName: i.drugName, doseText: i.doseText || null, frequency: i.frequency || null, durationDays: i.durationDays || null, quantity: i.quantity, route: i.route || null, instructions: i.instructions || null })),
      canSend: r.status === 'active' && !r.routedTo, order, previousOrders: past.map(p => ({ id: p.id, status: p.status, pharmacyOrgId: p.pharmacyOrgId })) });
  }
  res.json(out);
}));

router.post('/me/prescriptions/:id/send', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { pharmacyOrgId: t.id({ required: true }), fulfilment: t.enum(['pickup', 'delivery'], { required: true }), address: t.str({ max: 300 }), location: t.obj({ lat: t.lat({ required: true }), lng: t.lng({ required: true }) }) });
  await RL.limit('rxsend_' + req.ctx.patient.id, 20, 3600);
  const rx = await db.col('prescriptions').findOne({ id: param(req, 'id'), patientId: req.ctx.patient.id });
  if (!rx) throw notFound('Prescription not found');
  if (rx.status !== 'active' || rx.routedTo) throw conflict(rx.status === 'cancelled' ? 'This prescription was cancelled by the prescriber' : 'This prescription has already been sent to a pharmacy', 'already_sent');
  // provider mode: the patient's own providers, or pharmacies their prescriber works with (same group or network partner)
  if (!(await P.patientCanUse(req, b.pharmacyOrgId)) && !(await require('../network').arePartners(rx.orgId, b.pharmacyOrgId))) throw forbidden('Choose a pharmacy of your provider or one it works with.');
  const order = await createOrderFromPrescription({ prescription: rx, pharmacyOrgId: b.pharmacyOrgId, fulfilment: b.fulfilment, address: b.address || (b.fulfilment === 'delivery' ? req.ctx.patient.address : null), location: b.location || null, requestedBy: 'patient' });
  await audit(req, 'patient.rx_send', { type: 'rx_order', id: order.id, patientId: order.patientId, orgId: order.pharmacyOrgId }, { fulfilment: b.fulfilment, prescriptionId: rx.id });
  res.json(await patientOrderView(order));
}));

router.get('/me/rx-orders', A.requirePatient, ah(async (req, res) => {
  const rows = await db.col('rx_orders').find(Object.assign({ patientId: req.ctx.patient.id }, await P.scopeFilter(req, ['pharmacyOrgId', 'prescriberOrgId'])), { sort: { createdAt: -1 }, limit: 100 });
  const out = []; for (const o of rows) { const ph = await db.col('orgs').findOne({ id: o.pharmacyOrgId }); out.push({ id: o.id, status: o.status === 'allocating' ? 'paid' : o.status, fulfilment: o.fulfilment, pharmacyName: ph ? ph.name : null, totalKobo: o.totalKobo, billId: o.billId, deliveryId: o.deliveryId, createdAt: o.createdAt, updatedAt: o.updatedAt }); }
  res.json(out);
}));
router.get('/me/rx-orders/:id', A.requirePatient, ah(async (req, res) => {
  const o = await db.col('rx_orders').findOne({ id: param(req, 'id'), patientId: req.ctx.patient.id });
  if (!o) throw notFound('Order not found');
  res.json(await patientOrderView(o));
}));
router.post('/me/rx-orders/:id/cancel', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ max: 300 }) });
  const o = await db.col('rx_orders').findOne({ id: param(req, 'id'), patientId: req.ctx.patient.id });
  if (!o) throw notFound('Order not found');
  const reason = 'Cancelled by patient' + (b.reason ? ': ' + b.reason : '');
  const upd = await cancelOrder(req, o, reason, ['received', 'queried', 'verified', 'priced']);
  await notify({ orgId: o.pharmacyOrgId, role: 'pharmacist', title: 'Order cancelled by patient', body: 'A patient cancelled a prescription order.', kind: 'rx_order', ref: { type: 'rx_order', id: o.id } });
  await audit(req, 'patient.rx_cancel', { type: 'rx_order', id: o.id, patientId: o.patientId, orgId: o.pharmacyOrgId }, { from: o.status });
  res.json(await patientOrderView(upd));
}));

module.exports = { router, TRANSITIONS, ACTIVE, transition, createOrderFromPrescription, patientOrderView, staffOrderView };
