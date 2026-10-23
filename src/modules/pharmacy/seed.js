'use strict';
/* Demo data for the pharmacy module (DEMO_MODE only): stock, supplier, a received PO, riders,
 * an active prescription for Tobi and one delivered past order. */
const db = require('../../db');
const { id, now, naira, addDays, todayLagos } = require('../../lib/util');
const F = require('../../clinical/formulary');
const C = require('./common');

/* [code, form, strength, unit, sellNaira (per unit), costNaira, reorderLevel, batches: [[daysToExpiry, qty]] | 'po'] */
const CATALOG = [
  ['AMOX500', 'Capsule', '500mg', 'capsule', 60, 35, 60, [[45, 40], [420, 200]]],
  ['AMLO5', 'Tablet', '5mg', 'tablet', 40, 22, 50, [[120, 12], [500, 20]]],
  ['METF500', 'Tablet', '500mg', 'tablet', 30, 15, 100, [[200, 150], [540, 300]]],
  ['PARA500', 'Tablet', '500mg', 'tablet', 20, 8, 200, [[70, 100], [600, 500]]],
  ['AL2040', 'Tablet', '20/120mg', 'tablet', 125, 70, 72, [[150, 48], [480, 96]]],
  ['ASP75', 'Tablet', '75mg', 'tablet', 15, 6, 60, [[80, 30], [700, 200]]],
  ['WARF5', 'Tablet', '5mg', 'tablet', 55, 30, 40, [[60, 28], [400, 84]]],
  ['TRAM50', 'Capsule', '50mg', 'capsule', 90, 45, 30, [[300, 60]]],
  ['IBU400', 'Tablet', '400mg', 'tablet', 25, 10, 100, [[365, 300]]],
  ['CIPRO500', 'Tablet', '500mg', 'tablet', 110, 60, 40, [[300, 100]]],
  ['AUG625', 'Tablet', '625mg', 'tablet', 350, 210, 30, [[260, 70]]],
  ['LISI10', 'Tablet', '10mg', 'tablet', 70, 38, 60, [[330, 120]]],
  ['LOSA50', 'Tablet', '50mg', 'tablet', 85, 45, 60, [[400, 90]]],
  ['OMEP20', 'Capsule', '20mg', 'capsule', 45, 20, 60, 'po'],
  ['CETI10', 'Tablet', '10mg', 'tablet', 30, 12, 50, 'po'],
  ['ORS', 'Sachet', '20.5g', 'sachet', 150, 80, 40, [[500, 120]]],
  ['ZINC20', 'Tablet', '20mg', 'tablet', 20, 8, 60, [[450, 200]]],
  ['FOLIC5', 'Tablet', '5mg', 'tablet', 10, 3, 100, [[550, 400]]],
  ['FESO4', 'Tablet', '200mg', 'tablet', 12, 5, 100, [[480, 300]]],
  ['VITBCO', 'Tablet', '', 'tablet', 10, 4, 100, [[400, 500]]],
  ['GLIB5', 'Tablet', '5mg', 'tablet', 35, 15, 60, [[360, 150]]],
  ['ATOR20', 'Tablet', '20mg', 'tablet', 95, 50, 60, [[420, 90]]],
  ['METRO400', 'Tablet', '400mg', 'tablet', 25, 10, 80, [[390, 200]]],
  ['SALBINH', 'Inhaler', '100mcg', 'inhaler', 3500, 2200, 5, [[500, 12]]],
];

async function seedInventory(org, prefix, priceFactor, who) {
  const I = require('./inventory');
  const items = {};
  for (const [code, form, strength, unit, sell, , reorder] of CATALOG) {
    items[code] = await I.createItem(org.id, { drugCode: code, form, strength: strength || null, unit, reorderLevel: reorder, sellPriceKobo: naira(Math.round(sell * priceFactor)) });
  }
  const supplier = { id: id('sup'), orgId: org.id, name: 'Emzor Pharmaceutical (demo)', phone: '+2348031110000', email: 'orders@emzor.demo', address: 'Isolo, Lagos', contactName: 'Sales desk', active: true, createdAt: now() };
  const supplier2 = { id: id('sup'), orgId: org.id, name: 'Fidson Healthcare (demo)', phone: '+2348062220000', email: 'orders@fidson.demo', address: 'Ota, Ogun', contactName: 'Sales desk', active: true, createdAt: now() };
  await db.col('suppliers').insertOne(supplier); await db.col('suppliers').insertOne(supplier2);
  const td = todayLagos();
  for (const [code, , , , , cost, , batches] of CATALOG) {
    if (batches === 'po') continue;
    let k = 0;
    for (const [days, qty] of batches) {
      await I.receiveBatch(org.id, { itemId: items[code].id, batchNo: prefix + '-' + code + '-' + (2601 + k), expiry: addDays(td, days), qty, costKobo: naira(cost), supplierId: k % 2 ? supplier2.id : supplier.id, reason: 'opening stock', who });
      k++;
    }
  }
  // a purchase order that was sent and received in full
  const po = await I.createPO(org.id, { supplierId: supplier.id, lines: [{ itemId: items.OMEP20.id, qty: 200, costKobo: naira(20) }, { itemId: items.CETI10.id, qty: 150, costKobo: naira(12) }], note: 'Monthly restock', createdBy: who.by });
  await db.col('purchase_orders').updateOne({ id: po.id }, { $set: { status: 'sent', sentAt: now() }, $push: { timeline: { status: 'sent', at: now(), by: who.by } }, $inc: { rev: 1 } });
  await I.receivePO(org.id, po.id, [{ itemId: items.OMEP20.id, batchNo: prefix + '-OMEP20-PO1', expiry: addDays(td, 540), qty: 200 }, { itemId: items.CETI10.id, batchNo: prefix + '-CETI10-PO1', expiry: addDays(td, 480), qty: 150 }], who);
  // a draft order for the low-stock item
  await I.createPO(org.id, { supplierId: supplier2.id, lines: [{ itemId: items.AMLO5.id, qty: 300, costKobo: naira(22) }], note: 'Amlodipine is low', createdBy: who.by });
  return { items, supplier };
}

async function seedRider(org, staff, vehicle, plate, licence) {
  await db.col('rider_profiles').insertOne({ id: id('rdp'), orgId: org.id, membershipId: staff.membership.id, userId: staff.user.id, vehicle, plate, licence, status: 'verified', verifiedBy: 'demo', verifiedAt: now(), lastLoc: null, createdAt: now(), updatedAt: now() });
}

async function seedDemo(ctx) {
  const ph = ctx.orgs.pharmacy, hosp = ctx.orgs.hospital;
  const whoP = { by: ctx.staff.pharmacy.pharmacist.user.id, byName: ctx.staff.pharmacy.pharmacist.user.name, byMembershipId: ctx.staff.pharmacy.pharmacist.membership.id };
  const whoH = { by: ctx.staff.hospital.pharmacist.user.id, byName: ctx.staff.hospital.pharmacist.user.name, byMembershipId: ctx.staff.hospital.pharmacist.membership.id };
  const yaba = await seedInventory(ph, 'YC', 1, whoP);
  await seedInventory(hosp, 'GV', 1.1, whoH);

  await seedRider(ph, ctx.staff.pharmacy.rider, 'motorcycle', 'LAG-123-YB', 'LG-DL-0099821');
  await seedRider(ph, ctx.staff.pharmacy.rider2, 'bicycle', null, 'LG-DL-0101552');
  await seedRider(hosp, ctx.staff.hospital.rider, 'motorcycle', 'LAG-456-SU', 'LG-DL-0087713');

  const tobi = ctx.patients.tobi; const dr = ctx.staff.hospital['dr.tunde'];
  const mkRx = (status, at, items) => ({ id: id('rx'), orgId: hosp.id, patientId: tobi.id, encounterId: null, prescriberUserId: dr.user.id, prescriberMembershipId: dr.membership.id, prescriberName: dr.user.name,
    items, safety: { alerts: [], blocking: false, overrideReason: null, checkedAt: at }, status, routedTo: null, createdAt: at, demo: true });
  const metformin = [{ drugCode: 'METF500', drugName: F.find('METF500').name, doseMg: 500, doseText: '500mg', frequency: 'bd', durationDays: 30, quantity: 60, route: 'oral', instructions: 'Take with breakfast and supper' }];

  // active prescription for Tobi, ready for him to send to a pharmacy he chooses
  const existing = await db.col('prescriptions').findOne({ patientId: tobi.id, orgId: hosp.id, status: 'active', 'items.drugCode': 'METF500' });
  if (!existing) await db.col('prescriptions').insertOne(mkRx('active', now() - 2 * 3600e3, metformin));

  // one delivered past order at Yaba Care (last month's refill)
  const past = now() - 30 * 86400e3;
  const rx = mkRx('sent', past - 86400e3, metformin);
  const oid = id('rxo'); rx.routedTo = { pharmacyOrgId: ph.id, rxOrderId: oid };
  await db.col('prescriptions').insertOne(rx);
  const P = require('../patients'); await P.ensureLink(ph.id, tobi.id, 'demo', 'patient');
  const item = yaba.items.METF500;
  const fee = (ph.settings || {}).deliveryFeeKobo || naira(1500);
  const lines = [{ rxIndex: 0, supplied: true, itemId: item.id, drugCode: 'METF500', name: item.name, controlled: false, qty: 60, unitPriceKobo: item.sellPriceKobo, totalKobo: item.sellPriceKobo * 60, substitutedFor: null, substitutionReason: null }];
  const billing = require('../billing');
  const bill = await billing.createBill({ orgId: ph.id, patientId: tobi.id, lines: [{ code: 'METF500', name: item.name, category: 'drug', qty: 60, unitPriceKobo: item.sellPriceKobo }, { code: 'DELIV', name: 'Home delivery', category: 'delivery', qty: 1, unitPriceKobo: fee }], source: { type: 'rx_order', id: oid }, createdBy: whoP.by });
  await db.col('bills').updateOne({ id: bill.id }, { $set: { status: 'paid', paidKobo: bill.totalKobo, paidAt: past + 3600e3, settledBy: 'online', createdAt: past } });
  const takes = await C.allocateFefo(ph.id, [{ itemId: item.id, qty: 60 }]);
  await C.commitTakes(ph.id, takes, { type: 'dispense', ref: { type: 'rx_order', id: oid }, reason: 'prescription dispensed', who: whoP });
  const did = id('dlv'); const code = C.newCode('delivery', did);
  const rider = ctx.staff.pharmacy.rider;
  const tl = (s, dt) => ({ status: s, at: past + dt, by: null, note: null });
  await db.col('rx_orders').insertOne({ id: oid, orgId: ph.id, pharmacyOrgId: ph.id, patientId: tobi.id, prescriptionId: rx.id, rxKey: rx.id, prescriberOrgId: hosp.id, prescriberOrgName: hosp.name, prescriberName: dr.user.name, prescriberUserId: dr.user.id, encounterId: null,
    items: metformin, prescriberSafety: rx.safety, prescribedAt: rx.createdAt, fulfilment: 'delivery', address: tobi.address, location: tobi.homeLoc, requestedBy: 'patient', status: 'delivered',
    verification: { by: whoP.by, byName: whoP.byName, at: past + 600e3, alerts: [], blocking: false, decision: 'proceed', reason: null }, lines, billId: bill.id, deliveryFeeKobo: fee, totalKobo: bill.totalKobo, priceRev: 1,
    allocations: takes.map(t => ({ itemId: t.itemId, batchId: t.batchId, batchNo: t.batchNo, expiry: t.expiry, qty: t.qty })), pickupCodeHash: null, pickupNonce: null, pickupAttempts: 0, deliveryId: did, refundDue: null,
    timeline: [tl('received', 0), tl('verified', 600e3), tl('priced', 900e3), tl('paid', 3600e3), tl('ready', 5400e3), tl('out_for_delivery', 6000e3), tl('delivered', 8400e3)], createdAt: past, updatedAt: past + 8400e3, deliveredAt: past + 8400e3, demo: true });
  await db.col('deliveries').insertOne({ id: did, orgId: ph.id, kind: 'medication', rxOrderId: oid, patientId: tobi.id, address: tobi.address, location: tobi.homeLoc, status: 'delivered', riderMembershipId: rider.membership.id, riderUserId: rider.user.id,
    codeHash: code.hash, codeNonce: code.nonce, codeAttempts: 0, locked: false, attempts: 1, failReason: null, failNote: null, lastLoc: null,
    timeline: [tl('pending', 5400e3), tl('assigned', 5500e3), tl('picked_up', 6000e3), tl('delivered', 8400e3)], createdAt: past + 5400e3, updatedAt: past + 8400e3, assignedAt: past + 5500e3, pickedUpAt: past + 6000e3, deliveredAt: past + 8400e3, demo: true });
}

module.exports = { seedDemo, CATALOG };
