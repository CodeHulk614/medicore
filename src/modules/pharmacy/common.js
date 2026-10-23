'use strict';
/*
 * Pharmacy shared pieces: indexes, guards, stock primitives (atomic, never negative),
 * FEFO allocation, the immutable movement ledger, the controlled-drug register and
 * the hashed 6-digit codes used for pickup and delivery.
 *
 * Stock rules:
 *  - a batch quantity only changes through a conditional $inc ({ qty: { $gte: n } } for removals),
 *    so two parallel removals can never take the same units and qty never goes below 0
 *  - everything is validated BEFORE stock changes; a multi-batch allocation that cannot be
 *    completed is reverted before anything is written to the ledger
 *  - the ledger (stock_moves) is insert-only: no route updates or deletes a move
 */
const crypto = require('crypto');
const db = require('../../db');
const config = require('../../config');
const A = require('../../lib/auth');
const { conflict, bad } = require('../../lib/http');
const { id, now, sha256, todayLagos, addDays, daysBetween } = require('../../lib/util');
const F = require('../../clinical/formulary');

db.index('pharmacy_items', ['orgId', 'codeKey'], { unique: true });
db.index('pharmacy_items', ['orgId', 'name']);
db.index('pharmacy_batches', ['orgId', 'itemId', 'batchNo'], { unique: true });
db.index('pharmacy_batches', ['orgId', 'itemId', 'status', 'expiry']);
db.index('stock_moves', ['orgId', 'at']);
db.index('stock_moves', ['orgId', 'itemId', 'at']);
db.index('suppliers', ['orgId', 'name']);
db.index('purchase_orders', ['orgId', 'createdAt']);
db.index('recalls', ['orgId', 'at']);
db.index('controlled_register', ['orgId', 'at']);
db.index('rx_orders', ['pharmacyOrgId', 'status', 'createdAt']);
db.index('rx_orders', ['patientId', 'createdAt']);
db.index('rx_orders', ['rxKey'], { unique: true });
db.index('prescriptions', ['patientId', 'createdAt']);
db.index('pharmacy_sales', ['orgId', 'createdAt']);
db.index('deliveries', ['orgId', 'status', 'createdAt']);
db.index('deliveries', ['riderMembershipId', 'status']);
db.index('deliveries', ['patientId', 'createdAt']);
db.index('rider_profiles', ['membershipId'], { unique: true });
db.index('rider_profiles', ['orgId', 'status']);

/* ---------- guards ---------- */
const READ_PERMS = ['pharmacy.verify', 'pharmacy.dispense', 'pharmacy.stock'];
const G = {
  read: A.requireStaff({ module: 'pharmacy', anyPerm: READ_PERMS }),
  readOrReports: A.requireStaff({ module: 'pharmacy', anyPerm: READ_PERMS.concat(['admin.reports']) }),
  stock: A.requireStaff({ module: 'pharmacy', perm: 'pharmacy.stock' }),
  verify: A.requireStaff({ module: 'pharmacy', perm: 'pharmacy.verify' }),
  dispense: A.requireStaff({ module: 'pharmacy', perm: 'pharmacy.dispense' }),
  orderAct: A.requireStaff({ module: 'pharmacy', anyPerm: ['pharmacy.verify', 'pharmacy.dispense'] }),
  sale: A.requireStaff({ module: 'pharmacy', anyPerm: ['pharmacy.dispense', 'billing.create'] }),
  dispatch: A.requireStaff({ module: 'delivery', perm: 'delivery.dispatch' }),
  dispatchOrPharmacy: A.requireStaff({ module: 'delivery', anyPerm: ['delivery.dispatch', 'pharmacy.dispense'] }),
  riderAdmin: A.requireStaff({ module: 'delivery', anyPerm: ['delivery.dispatch', 'admin.staff'] }),
  ride: A.requireStaff({ module: 'delivery', perm: 'delivery.ride' }),
  onShift: A.requireOnShift,
};

/* ---------- dates ---------- */
const today = () => todayLagos();
const daysTo = expiry => (expiry ? daysBetween(today(), expiry) : null);
const NEAR_EXPIRY_DAYS = 90;

/* ---------- OTC list (default; each item can be changed by the pharmacy) ---------- */
const OTC_CODES = new Set(['PARA500', 'PARA1G', 'IBU400', 'ASP75', 'ORS', 'ZINC20', 'ANTACID', 'CETI10', 'LORA10', 'CPM4', 'VITBCO', 'FOLIC5', 'FESO4', 'ALB400', 'MEBE100', 'LOPE2', 'AL2040']);
function defaultsFor(drugCode) {
  const d = drugCode ? F.find(drugCode) : null;
  return { drug: d, controlled: !!(d && d.controlled), rxOnly: d ? (!!d.controlled || !OTC_CODES.has(d.code)) : true };
}

/* ---------- ledger ---------- */
function actor(req) {
  const c = (req && req.ctx) || {};
  return { by: c.user ? c.user.id : 'system', byName: c.user ? c.user.name : 'System', byMembershipId: c.membership ? c.membership.id : null };
}
async function writeMove({ orgId, itemId, batchId, type, qty, balanceAfter, reason, ref, who, meta }) {
  const m = Object.assign({ id: id('mv'), orgId, itemId, batchId: batchId || null, type, qty, balanceAfter: balanceAfter == null ? null : balanceAfter, reason: reason || null, ref: ref || null, at: now() }, who || actor(null));
  if (meta) m.meta = meta;
  await db.col('stock_moves').insertOne(m);
  return m;
}
const MOVE_TYPES = ['receive', 'dispense', 'sale', 'adjust', 'count', 'return_in', 'return_supplier', 'recall', 'expire'];

/* ---------- batch primitives ---------- */
/** remove n units from one batch, only if it holds at least n. Returns the updated batch or null. */
async function takeFromBatch(orgId, batchId, n, opts = {}) {
  if (!Number.isInteger(n) || n <= 0) throw bad('Quantity must be a positive whole number');
  const f = { id: batchId, orgId, qty: { $gte: n } };
  f.status = opts.anyStatus ? { $in: ['active', 'quarantined', 'expired'] } : 'active';
  if (opts.usableOnly) f.expiry = { $gte: today() };
  const b = await db.col('pharmacy_batches').findOneAndUpdate(f, { $inc: { qty: -n }, $set: { updatedAt: now() } });
  if (b && b.qty === 0 && b.status === 'active') await db.col('pharmacy_batches').updateOne({ id: b.id, qty: 0, status: 'active' }, { $set: { status: 'depleted' } });
  return b;
}
/** put n units back on a batch (returns, reverts, positive adjustments). Depleted batches become active again. */
async function addToBatch(orgId, batchId, n) {
  if (!Number.isInteger(n) || n <= 0) throw bad('Quantity must be a positive whole number');
  const b = await db.col('pharmacy_batches').findOneAndUpdate({ id: batchId, orgId }, { $inc: { qty: n }, $set: { updatedAt: now() } });
  if (b && b.status === 'depleted' && b.qty > 0) await db.col('pharmacy_batches').updateOne({ id: b.id, status: 'depleted', qty: { $gt: 0 } }, { $set: { status: 'active' } });
  return b;
}

/** usable batches of an item in FEFO order (earliest expiry first; expired, quarantined and empty skipped) */
async function usableBatches(orgId, itemId) {
  return db.col('pharmacy_batches').find({ orgId, itemId, status: 'active', qty: { $gt: 0 }, expiry: { $gte: today() } }, { sort: { expiry: 1, receivedAt: 1 } });
}
async function availableQty(orgId, itemId) { return (await usableBatches(orgId, itemId)).reduce((s, b) => s + b.qty, 0); }

/**
 * FEFO allocation for several lines at once: [{ itemId, qty }]. Either every line is fully
 * allocated or nothing changes (takes are reverted). Returns takes: [{ itemId, batchId, batchNo, expiry, qty, balanceAfter, costKobo }].
 * Does NOT write the ledger; call commitTakes() after the caller's own state change succeeded.
 */
async function allocateFefo(orgId, lines) {
  const takes = [];
  try {
    for (const line of lines) {
      let need = line.qty;
      for (let round = 0; round < 5 && need > 0; round++) {
        const batches = await usableBatches(orgId, line.itemId);
        if (!batches.length) break;
        for (const b of batches) {
          if (need <= 0) break;
          const n = Math.min(b.qty, need);
          const after = await takeFromBatch(orgId, b.id, n, { usableOnly: true });
          if (!after) continue; // someone else took it first; re-read next round
          takes.push({ itemId: line.itemId, batchId: b.id, batchNo: b.batchNo, expiry: b.expiry, qty: n, balanceAfter: after.qty, costKobo: b.costKobo || 0 });
          need -= n;
        }
      }
      if (need > 0) { const it = await db.col('pharmacy_items').findOne({ id: line.itemId, orgId }); throw conflict('Not enough usable stock of ' + (it ? it.name : 'an item') + ': short by ' + need + '. Receive stock first.', 'insufficient_stock'); }
    }
  } catch (e) {
    await revertTakes(orgId, takes);
    throw e;
  }
  return takes;
}
async function revertTakes(orgId, takes) { for (const t of takes) await addToBatch(orgId, t.batchId, t.qty); }
async function commitTakes(orgId, takes, { type, ref, reason, who }) {
  for (const t of takes) await writeMove({ orgId, itemId: t.itemId, batchId: t.batchId, type, qty: -t.qty, balanceAfter: t.balanceAfter, reason, ref, who });
}

/** controlled-drug register entry per batch taken for a controlled item */
async function registerControlled({ orgId, takes, patientId, ref, who }) {
  for (const t of takes) {
    const it = await db.col('pharmacy_items').findOne({ id: t.itemId, orgId });
    if (!it || !it.controlled) continue;
    await db.col('controlled_register').insertOne(Object.assign({ id: id('cd'), orgId, itemId: it.id, drugCode: it.drugCode || null, itemName: it.name, batchId: t.batchId, batchNo: t.batchNo, qty: t.qty, balanceAfter: t.balanceAfter, patientId: patientId || null, ref, at: now() }, who));
  }
}

/* ---------- item view ---------- */
async function itemView(it) {
  const batches = await db.col('pharmacy_batches').find({ orgId: it.orgId, itemId: it.id, status: { $in: ['active', 'quarantined'] } });
  const td = today();
  const usable = batches.filter(b => b.status === 'active' && b.qty > 0 && b.expiry >= td);
  const onHand = usable.reduce((s, b) => s + b.qty, 0);
  const nearExpiry = usable.filter(b => daysTo(b.expiry) <= NEAR_EXPIRY_DAYS);
  return {
    id: it.id, drugCode: it.drugCode || null, name: it.name, form: it.form || null, strength: it.strength || null, unit: it.unit || null,
    reorderLevel: it.reorderLevel || 0, controlled: !!it.controlled, rxOnly: !!it.rxOnly, sellPriceKobo: it.sellPriceKobo, active: it.active !== false,
    onHand, batches: usable.length, lowStock: onHand <= (it.reorderLevel || 0), outOfStock: onHand === 0,
    nearExpiryQty: nearExpiry.reduce((s, b) => s + b.qty, 0), earliestExpiry: usable.length ? usable.map(b => b.expiry).sort()[0] : null,
    expiredQty: batches.filter(b => b.status === 'active' && b.qty > 0 && b.expiry < td).reduce((s, b) => s + b.qty, 0),
    quarantinedQty: batches.filter(b => b.status === 'quarantined').reduce((s, b) => s + b.qty, 0),
  };
}
function batchView(b) { return Object.assign({}, b, { daysToExpiry: daysTo(b.expiry), nearExpiry: daysTo(b.expiry) != null && daysTo(b.expiry) <= NEAR_EXPIRY_DAYS && daysTo(b.expiry) >= 0, expired: daysTo(b.expiry) != null && daysTo(b.expiry) < 0 }); }

/* ---------- hashed 6-digit codes (pickup / delivery) ----------
 * The database stores only sha256(kind:docId:code). The code itself is derived from an HMAC
 * of a per-document nonce with the server secret, so the patient's app can show it again
 * without the code being stored readable in the database. */
function codeFor(kind, docId, nonce) {
  const h = crypto.createHmac('sha256', config.JWT_SECRET).update(kind + ':' + docId + ':' + nonce).digest('hex');
  return String(parseInt(h.slice(0, 12), 16) % 1000000).padStart(6, '0');
}
const codeHash = (kind, docId, code) => sha256(kind + ':' + docId + ':' + code);
function newCode(kind, docId) { const nonce = crypto.randomBytes(8).toString('hex'); const code = codeFor(kind, docId, nonce); return { nonce, code, hash: codeHash(kind, docId, code) }; }
function codeMatches(kind, docId, code, hash) {
  if (!hash || !/^\d{6}$/.test(String(code || ''))) return false;
  const a = Buffer.from(codeHash(kind, docId, code)), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const CODE_MAX_TRIES = 5;
/* tunables from the HQ settings layer (code constants are the fallback) */
const S = () => require('../../lib/settings');
const codeTries = org => { const n = Number(S().get('process.pharmacy.deliveryCodeAttempts', CODE_MAX_TRIES, org)); return Number.isInteger(n) && n >= 1 ? n : CODE_MAX_TRIES; };
const freshMs = org => { const s = Number(S().get('process.delivery.riderLocationFreshSeconds', 120, org)); return (s > 0 ? s : 120) * 1000; };
const pickupWindowDays = org => { const d = Number(S().get('process.pharmacy.pickupWindowDays', 2, org)); return d > 0 ? d : 2; };
const requireVerify = org => S().get('process.pharmacy.requirePharmacistVerify', true, org) !== false;
const allowSubstitution = org => S().get('process.pharmacy.allowSubstitution', true, org) !== false;
const homeDelivery = org => S().feature('homeDelivery', org);

module.exports = { G, today, daysTo, NEAR_EXPIRY_DAYS, OTC_CODES, defaultsFor, actor, writeMove, MOVE_TYPES, takeFromBatch, addToBatch, usableBatches, availableQty, allocateFefo, revertTakes, commitTakes, registerControlled, itemView, batchView, codeFor, codeHash, newCode, codeMatches, CODE_MAX_TRIES, codeTries, freshMs, pickupWindowDays, requireVerify, allowSubstitution, homeDelivery, addDays };
