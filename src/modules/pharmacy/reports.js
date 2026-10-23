'use strict';
/*
 * Pharmacy dashboard, stock valuation and daily sales (pharmacists and admins with admin.reports).
 * Read-only: nothing here changes state.
 */
const express = require('express');
const db = require('../../db');
const { ah, query, t } = require('../../lib/http');
const A = require('../../lib/auth');
const { lagosToUtc, todayLagos, addDays } = require('../../lib/util');
const C = require('./common');

const router = express.Router();
const reportGuard = A.requireStaff({ module: 'pharmacy', anyPerm: ['admin.reports', 'pharmacy.verify', 'pharmacy.stock'] });

router.get('/pharmacy/dashboard', C.G.readOrReports, ah(async (req, res) => {
  const orgId = req.ctx.org.id;
  const orders = await db.col('rx_orders').aggregateCount({ pharmacyOrgId: orgId, status: { $in: ['received', 'queried', 'verified', 'priced', 'paid', 'allocating', 'ready', 'out_for_delivery'] } }, 'status');
  if (orders.allocating) { orders.paid = (orders.paid || 0) + orders.allocating; delete orders.allocating; }
  const { alertsFor } = require('./inventory');
  const al = await alertsFor(orgId);
  const start = lagosToUtc(todayLagos(), '00:00');
  const paidToday = await db.col('bills').find({ orgId, status: 'paid', paidAt: { $gte: start }, 'source.type': { $in: ['rx_order', 'pharmacy_sale'] } });
  const deliveries = (req.ctx.org.modules || []).includes('delivery') ? await db.col('deliveries').aggregateCount({ orgId, status: { $in: ['pending', 'assigned', 'picked_up', 'failed', 'returned'] } }, 'status') : null;
  res.json({
    orders, toVerify: (orders.received || 0) + (orders.queried || 0), toPrepare: orders.paid || 0, readyForPickup: await db.col('rx_orders').count({ pharmacyOrgId: orgId, status: 'ready', fulfilment: 'pickup' }),
    salesAwaitingApproval: await db.col('pharmacy_sales').count({ orgId, status: 'awaiting_approval' }), salesStockShort: await db.col('pharmacy_sales').count({ orgId, status: 'paid', stockShort: true }),
    today: { paidBills: paidToday.length, revenueKobo: paidToday.reduce((s, b) => s + b.totalKobo, 0) },
    lowStock: al.lowStock.length, outOfStock: al.lowStock.filter(x => x.outOfStock).length, expiringBatches: al.expiring.length, expiredBatches: al.expired.length,
    deliveries,
  });
}));

router.get('/pharmacy/reports/valuation', reportGuard, ah(async (req, res) => {
  const orgId = req.ctx.org.id; const td = C.today();
  const items = await db.col('pharmacy_items').find({ orgId }, { sort: { name: 1 } });
  const batches = await db.col('pharmacy_batches').find({ orgId, qty: { $gt: 0 } });
  const rows = []; const tot = { units: 0, costKobo: 0, sellKobo: 0, quarantinedCostKobo: 0, expiredCostKobo: 0 };
  for (const it of items) {
    const bs = batches.filter(b => b.itemId === it.id);
    const usable = bs.filter(b => b.status === 'active' && b.expiry >= td);
    const units = usable.reduce((s, b) => s + b.qty, 0);
    const costKobo = usable.reduce((s, b) => s + b.qty * (b.costKobo || 0), 0);
    const r = { itemId: it.id, name: it.name, drugCode: it.drugCode, units, costKobo, sellKobo: units * it.sellPriceKobo,
      quarantinedCostKobo: bs.filter(b => b.status === 'quarantined').reduce((s, b) => s + b.qty * (b.costKobo || 0), 0),
      expiredCostKobo: bs.filter(b => b.status === 'active' && b.expiry < td).reduce((s, b) => s + b.qty * (b.costKobo || 0), 0) };
    rows.push(r); Object.keys(tot).forEach(k => { tot[k] += r[k]; });
  }
  res.json({ asOf: Date.now(), totals: Object.assign(tot, { marginKobo: tot.sellKobo - tot.costKobo }), items: rows });
}));

router.get('/pharmacy/reports/daily-sales', reportGuard, ah(async (req, res) => {
  const q = query(req, { date: t.date() });
  const date = q.date || todayLagos();
  const from = lagosToUtc(date, '00:00'), to = lagosToUtc(addDays(date, 1), '00:00');
  const orgId = req.ctx.org.id;
  const bills = await db.col('bills').find({ orgId, status: 'paid', paidAt: { $gte: from, $lt: to }, 'source.type': { $in: ['rx_order', 'pharmacy_sale'] } });
  const bySource = { rx_order: { count: 0, totalKobo: 0 }, pharmacy_sale: { count: 0, totalKobo: 0 } };
  const byMethod = {}; const items = {};
  for (const b of bills) {
    bySource[b.source.type].count++; bySource[b.source.type].totalKobo += b.totalKobo;
    const m = b.settledBy || 'other'; byMethod[m] = (byMethod[m] || 0) + b.totalKobo;
    for (const l of b.lines) { if (l.category !== 'drug') continue; const k = l.name; items[k] = items[k] || { name: l.name, qty: 0, totalKobo: 0 }; items[k].qty += l.qty; items[k].totalKobo += l.totalKobo; }
  }
  const moves = await db.col('stock_moves').find({ orgId, type: { $in: ['dispense', 'sale'] }, at: { $gte: from, $lt: to } });
  const deliveryFees = bills.reduce((s, b) => s + b.lines.filter(l => l.category === 'delivery').reduce((x, l) => x + l.totalKobo, 0), 0);
  res.json({ date, bills: bills.length, totalKobo: bills.reduce((s, b) => s + b.totalKobo, 0), hmoCoveredKobo: bills.reduce((s, b) => s + (b.hmo ? b.hmo.coveredKobo : 0), 0), deliveryFeesKobo: deliveryFees,
    bySource, byMethod, unitsOut: -moves.reduce((s, m) => s + m.qty, 0), topItems: Object.values(items).sort((a, b) => b.totalKobo - a.totalKobo).slice(0, 20) });
}));

module.exports = { router };
