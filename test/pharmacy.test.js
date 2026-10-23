'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

let h, phY, phH, dispY, riderY, riderH, counterY, kunle, amaka, tobi, ownerY;
const items = {};

before(async () => {
  h = await boot({ patientMode: 'open' });
  phY = await h.as('pharmacy', 'pharmacist@yabacare.demo');
  phH = await h.as('pharmacy', 'pharmacist@grandville.demo');
  dispY = await h.as('pharmacy', 'dispatch@yabacare.demo');
  riderY = await h.as('rider', 'rider@yabacare.demo');
  riderH = await h.as('rider', 'rider@grandville.demo');
  counterY = await h.as('frontdesk', 'counter@yabacare.demo');
  kunle = await h.as('patient', 'kunle@patient.demo');
  amaka = await h.as('patient', 'amaka@patient.demo');
  tobi = await h.as('patient', 'tobi@patient.demo');
  ownerY = await h.as('admin', 'owner@yabacare.demo');
  const list = await phY.get('/api/pharmacy/items');
  list.body.forEach(i => { items[i.drugCode] = i; });
});
after(async () => { await h.close(); });

/* a prescription written by another provider (clinic module contract shape) */
async function mkRx(orgKey, patientKey, rxItems, safety) {
  const dr = orgKey === 'clinic' ? h.ctx.staff.clinic['dr.ada'] : h.ctx.staff.hospital['dr.tunde'];
  const doc = { id: 'rx_t' + Math.random().toString(36).slice(2, 12), orgId: h.ctx.orgs[orgKey].id, patientId: h.ctx.patients[patientKey].id, encounterId: null, prescriberUserId: dr.user.id, prescriberMembershipId: dr.membership.id, prescriberName: dr.user.name,
    items: rxItems.map(i => Object.assign({ doseMg: null, doseText: '1 tab', frequency: 'od', durationDays: 30, route: 'oral', instructions: null }, i)),
    safety: safety || { alerts: [], blocking: false, overrideReason: null, checkedAt: Date.now() }, status: 'active', routedTo: null, createdAt: Date.now() };
  await h.db.col('prescriptions').insertOne(doc);
  return doc;
}
const batchesOf = async (orgKey, itemId) => h.db.col('pharmacy_batches').find({ orgId: h.ctx.orgs[orgKey].id, itemId }, { sort: { expiry: 1 } });
const sumQty = bs => bs.reduce((s, b) => s + b.qty, 0);
async function pay(patient, billId) {
  const init = await patient.post('/api/me/bills/' + billId + '/pay');
  assert.equal(init.status, 200, JSON.stringify(init.body));
  return init.body.paymentId;
}
/** send -> verify -> price -> pay -> ready */
async function toReady(patient, rx, fulfilment, extra = {}) {
  const s = await patient.post('/api/me/prescriptions/' + rx.id + '/send', Object.assign({ pharmacyOrgId: h.ctx.orgs.pharmacy.id, fulfilment }, extra));
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const oid = s.body.id;
  assert.equal((await phY.post('/api/pharmacy/orders/' + oid + '/verify', { decision: 'proceed' })).status, 200);
  const pr = await phY.post('/api/pharmacy/orders/' + oid + '/price', {});
  assert.equal(pr.status, 200, JSON.stringify(pr.body));
  const pid = await pay(patient, pr.body.billId);
  assert.equal((await patient.post('/api/pay/demo/' + pid + '/complete')).status, 200);
  const r = await phY.post('/api/pharmacy/orders/' + oid + '/ready');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

let kunleOrderId;

test('seed: inventory, alerts, riders and the patient data are in place', async () => {
  assert.ok(Object.keys(items).length >= 20);
  ['AMOX500', 'AMLO5', 'METF500', 'PARA500', 'AL2040', 'ASP75', 'WARF5'].forEach(c => assert.equal(items[c].batches, 2, c + ' has 2 batches'));
  assert.equal(items.TRAM50.controlled, true); assert.equal(items.TRAM50.rxOnly, true); assert.equal(items.PARA500.rxOnly, false);
  const al = await phY.get('/api/pharmacy/alerts');
  assert.ok(al.body.lowStock.some(x => x.itemId === items.AMLO5.id), 'amlodipine is low');
  assert.ok(al.body.expiring.some(x => x.itemId === items.AMOX500.id && x.daysToExpiry < 90), 'one amoxicillin batch near expiry');
  const pos = await phY.get('/api/pharmacy/purchase-orders');
  assert.ok(pos.body.some(p => p.status === 'received'));
  const riders = await dispY.get('/api/delivery/riders');
  assert.equal(riders.body.filter(r => r.status === 'verified').length, 2);
  const hosp = await phH.get('/api/pharmacy/items'); assert.ok(hosp.body.length >= 20);
  const mine = await tobi.get('/api/me/prescriptions');
  assert.ok(mine.body.some(p => p.canSend && p.items[0].drugCode === 'METF500' && p.prescriberOrgName === 'Grandville Hospital'));
  const orders = await tobi.get('/api/me/rx-orders');
  assert.ok(orders.body.some(o => o.status === 'delivered'));
});

test('standalone pharmacy receives a prescription a patient sends from another provider; other pharmacies get 404', async () => {
  const rx = await mkRx('clinic', 'kunle', [{ drugCode: 'AMLO5', drugName: 'Amlodipine 5mg tablet', doseMg: 5, quantity: 30 }]);
  const list = await kunle.get('/api/me/prescriptions');
  const p = list.body.find(x => x.id === rx.id); assert.ok(p.canSend); assert.equal(p.prescriberOrgName, 'Lekki Family Clinic');
  assert.equal((await kunle.post('/api/me/prescriptions/' + rx.id + '/send', { pharmacyOrgId: h.ctx.orgs.clinic.id, fulfilment: 'pickup' })).status, 404, 'clinic has no pharmacy');
  const s = await kunle.post('/api/me/prescriptions/' + rx.id + '/send', { pharmacyOrgId: h.ctx.orgs.pharmacy.id, fulfilment: 'pickup' });
  assert.equal(s.status, 200); assert.equal(s.body.status, 'received');
  kunleOrderId = s.body.id;
  const again = await kunle.post('/api/me/prescriptions/' + rx.id + '/send', { pharmacyOrgId: h.ctx.orgs.hospital.id, fulfilment: 'pickup' });
  assert.equal(again.status, 409);
  const q = await phY.get('/api/pharmacy/orders?active=true');
  assert.ok(q.body.some(o => o.id === kunleOrderId && o.patientName === 'Kunle Martins'));
  const detail = await phY.get('/api/pharmacy/orders/' + kunleOrderId);
  assert.equal(detail.status, 200); assert.equal(detail.body.patient.firstName, 'Kunle'); assert.ok(!('pickupCodeHash' in detail.body));
  assert.equal((await phH.get('/api/pharmacy/orders/' + kunleOrderId)).status, 404);
  assert.equal((await phH.post('/api/pharmacy/orders/' + kunleOrderId + '/verify', { decision: 'proceed' })).status, 404);
  const after2 = await kunle.get('/api/me/prescriptions');
  assert.equal(after2.body.find(x => x.id === rx.id).order.status, 'received');
});

test('verify re-runs safety against the patient: penicillin for Amaka is flagged and needs a decision', async () => {
  const rx = await mkRx('hospital', 'amaka', [{ drugCode: 'AMOX500', drugName: 'Amoxicillin 500mg capsule', doseMg: 500, frequency: 'tds', durationDays: 7, quantity: 21 }],
    { alerts: [{ level: 'contraindicated', type: 'allergy' }], blocking: true, overrideReason: 'Specialist advice', checkedAt: Date.now() });
  const s = await amaka.post('/api/me/prescriptions/' + rx.id + '/send', { pharmacyOrgId: h.ctx.orgs.pharmacy.id, fulfilment: 'pickup' });
  assert.equal(s.status, 200);
  const preview = await phY.get('/api/pharmacy/orders/' + s.body.id + '/safety');
  assert.equal(preview.body.blocking, true);
  assert.equal((await dispY.post('/api/pharmacy/orders/' + s.body.id + '/verify', { decision: 'proceed', reason: 'whatever reason' })).status, 403, 'dispatcher is not a pharmacist');
  const v = await phY.post('/api/pharmacy/orders/' + s.body.id + '/verify', { decision: 'proceed' });
  assert.equal(v.status, 400); assert.equal(v.body.code, 'safety_blocking');
  assert.ok(v.body.details.some(a => a.level === 'contraindicated' && a.type === 'allergy'));
  const qd = await phY.post('/api/pharmacy/orders/' + s.body.id + '/verify', { decision: 'query', reason: 'Documented severe penicillin allergy. Please choose an alternative.' });
  assert.equal(qd.status, 200); assert.equal(qd.body.status, 'queried'); assert.equal(qd.body.verification.blocking, true);
  assert.ok(await h.db.col('notifications').findOne({ userId: h.ctx.staff.hospital['dr.tunde'].user.id, kind: 'rx_query' }));
  assert.equal((await phY.post('/api/pharmacy/orders/' + s.body.id + '/price', {})).status, 409, 'cannot price an unverified order');
  const rj = await phY.post('/api/pharmacy/orders/' + s.body.id + '/verify', { decision: 'reject', reason: 'Prescriber did not respond; allergy risk.' });
  assert.equal(rj.body.status, 'rejected');
  const mine = await amaka.get('/api/me/prescriptions');
  const p = mine.body.find(x => x.id === rx.id);
  assert.equal(p.canSend, true, 'prescription released so she can send it elsewhere');
  assert.equal(p.previousOrders[0].status, 'rejected');
  const ov = await amaka.get('/api/me/rx-orders/' + s.body.id); assert.match(ov.body.message, /allergy/);
});

test('price -> paid only through bill settlement, exactly once; re-pricing after payment refused', async () => {
  assert.equal((await phY.post('/api/pharmacy/orders/' + kunleOrderId + '/ready')).status, 409, 'not verified');
  assert.equal((await phY.post('/api/pharmacy/orders/' + kunleOrderId + '/verify', { decision: 'proceed' })).status, 200);
  const [p1, p2] = await Promise.all([phY.post('/api/pharmacy/orders/' + kunleOrderId + '/price', {}), phY.post('/api/pharmacy/orders/' + kunleOrderId + '/price', {})]);
  const ok = [p1, p2].filter(r => r.status === 200);
  assert.ok(ok.length >= 1);
  const order = (await phY.get('/api/pharmacy/orders/' + kunleOrderId)).body;
  assert.equal(order.status, 'priced'); assert.equal(order.totalKobo, items.AMLO5.sellPriceKobo * 30);
  const openBills = await h.db.col('bills').find({ 'source.id': kunleOrderId, status: 'open' });
  assert.equal(openBills.length, 1, 'only one open bill for the order');
  // re-pricing before payment is fine (voids the old bill)
  const rp = await phY.post('/api/pharmacy/orders/' + kunleOrderId + '/price', {}); assert.equal(rp.status, 200);
  assert.notEqual(rp.body.billId, order.billId);
  assert.equal((await h.db.col('bills').findOne({ id: order.billId })).status, 'void');
  // no way to mark it paid directly
  assert.equal((await phY.post('/api/pharmacy/orders/' + kunleOrderId + '/paid')).status, 404);
  assert.equal((await phY.post('/api/pharmacy/orders/' + kunleOrderId + '/ready')).status, 409, 'not paid');
  // other patients cannot pay or view it
  assert.equal((await amaka.get('/api/me/rx-orders/' + kunleOrderId)).status, 404);
  const pid = await pay(kunle, rp.body.billId);
  const [a, b] = await Promise.all([kunle.post('/api/pay/demo/' + pid + '/complete'), kunle.post('/api/pay/demo/' + pid + '/complete')]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const paid = await h.db.col('rx_orders').findOne({ id: kunleOrderId });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.timeline.filter(x => x.status === 'paid').length, 1, 'paid exactly once');
  const re = await phY.post('/api/pharmacy/orders/' + kunleOrderId + '/price', {});
  assert.equal(re.status, 409); assert.match(re.body.error, /Re-pricing after payment is not allowed/);
});

test('ready deducts stock FEFO exactly once even with parallel calls; collection needs the right code', async () => {
  const before = await batchesOf('pharmacy', items.AMLO5.id);
  const usable = before.filter(b => b.status === 'active' && b.qty > 0).sort((x, y) => x.expiry.localeCompare(y.expiry));
  const total = sumQty(before);
  const rs = await Promise.all([1, 2, 3].map(() => phY.post('/api/pharmacy/orders/' + kunleOrderId + '/ready')));
  assert.equal(rs.filter(r => r.status === 200).length, 1, 'exactly one ready succeeds');
  assert.ok(rs.filter(r => r.status !== 200).every(r => r.status === 409));
  const after = await batchesOf('pharmacy', items.AMLO5.id);
  assert.equal(sumQty(after), total - 30, 'deducted once');
  const ord = await h.db.col('rx_orders').findOne({ id: kunleOrderId });
  assert.equal(ord.status, 'ready');
  assert.equal(ord.allocations[0].batchId, usable[0].id, 'earliest expiry first');
  assert.equal(ord.allocations[0].qty, usable[0].qty, 'earliest batch emptied first');
  assert.equal(ord.allocations.reduce((s, a) => s + a.qty, 0), 30);
  const moves = await h.db.col('stock_moves').find({ 'ref.id': kunleOrderId, type: 'dispense' });
  assert.equal(moves.reduce((s, m) => s + m.qty, 0), -30);
  assert.equal((await h.db.col('pharmacy_batches').findOne({ id: usable[0].id })).status, 'depleted');
  const view = await kunle.get('/api/me/rx-orders/' + kunleOrderId);
  assert.match(view.body.pickupCode, /^\d{6}$/);
  const wrong = view.body.pickupCode === '000000' ? '111111' : '000000';
  assert.equal((await phY.post('/api/pharmacy/orders/' + kunleOrderId + '/collect', { code: wrong })).status, 400);
  assert.equal((await phY.post('/api/pharmacy/orders/' + kunleOrderId + '/collect', { code: 'abc' })).status, 400);
  const ok = await phY.post('/api/pharmacy/orders/' + kunleOrderId + '/collect', { code: view.body.pickupCode });
  assert.equal(ok.status, 200); assert.equal(ok.body.status, 'collected');
  assert.equal((await phY.post('/api/pharmacy/orders/' + kunleOrderId + '/collect', { code: view.body.pickupCode })).status, 409);
  assert.equal(sumQty(await batchesOf('pharmacy', items.AMLO5.id)), total - 30, 'still only one deduction');
  const db = await h.db.col('rx_orders').findOne({ id: kunleOrderId });
  assert.ok(db.pickupCodeHash && !JSON.stringify(db).includes('"' + view.body.pickupCode + '"'), 'code stored hashed only');
});

test('walk-in OTC sale at the counter; prescription-only items need a patient and a pharmacist', async () => {
  const before = sumQty(await batchesOf('pharmacy', items.PARA500.id));
  const s = await counterY.post('/api/pharmacy/sales', { lines: [{ itemId: items.PARA500.id, qty: 2 }] });
  assert.equal(s.status, 200, JSON.stringify(s.body)); assert.equal(s.body.status, 'billed'); assert.equal(s.body.patientId, null);
  assert.equal(s.body.bill.totalKobo, items.PARA500.sellPriceKobo * 2);
  const paid = await counterY.post('/api/bills/' + s.body.billId + '/cash', { method: 'cash', amountKobo: s.body.bill.totalKobo, receiptNo: 'OTC-1' });
  assert.equal(paid.status, 200);
  const done = await counterY.get('/api/pharmacy/sales/' + s.body.id);
  assert.equal(done.body.status, 'completed');
  assert.equal(sumQty(await batchesOf('pharmacy', items.PARA500.id)), before - 2);
  assert.equal((await counterY.post('/api/pharmacy/sales/' + s.body.id + '/complete')).status, 409, 'cannot deduct twice');
  const anon = await counterY.post('/api/pharmacy/sales', { lines: [{ itemId: items.AMOX500.id, qty: 10 }] });
  assert.equal(anon.status, 400, 'prescription-only needs a patient');
  const rxs = await counterY.post('/api/pharmacy/sales', { patientId: h.ctx.patients.tobi.id, lines: [{ itemId: items.AMOX500.id, qty: 10 }] });
  assert.equal(rxs.status, 200); assert.equal(rxs.body.status, 'awaiting_approval'); assert.equal(rxs.body.billId, null);
  assert.equal((await counterY.post('/api/pharmacy/sales/' + rxs.body.id + '/approve', {})).status, 403);
  const ap = await phY.post('/api/pharmacy/sales/' + rxs.body.id + '/approve', {});
  assert.equal(ap.status, 200); assert.equal(ap.body.status, 'billed'); assert.ok(ap.body.billId);
  assert.equal((await phY.post('/api/pharmacy/sales/' + rxs.body.id + '/approve', {})).status, 409);
  assert.equal((await counterY.post('/api/pharmacy/sales', { lines: [{ itemId: items.PARA500.id, qty: 0 }] })).status, 400);
  assert.equal((await counterY.post('/api/pharmacy/sales', { lines: [{ itemId: items.PARA500.id, qty: 99999 }] })).status, 400);
});

let tobiDeliveryId, tobiDeliveryOrder;
test('delivery: pharmacy prepares, dispatcher assigns, rider location shows to the patient, delivery needs the code', async () => {
  const mine = await tobi.get('/api/me/prescriptions');
  const rx = mine.body.find(p => p.canSend && p.items[0].drugCode === 'METF500');
  assert.equal((await tobi.post('/api/me/prescriptions/' + rx.id + '/send', { pharmacyOrgId: h.ctx.orgs.pharmacy.id, fulfilment: 'delivery' })).status, 200 , 'falls back to profile address');
  const sent = (await tobi.get('/api/me/prescriptions')).body.find(p => p.id === rx.id);
  const oid = sent.order.id; tobiDeliveryOrder = oid;
  assert.equal((await phY.post('/api/pharmacy/orders/' + oid + '/verify', { decision: 'proceed' })).status, 200);
  const pr = await phY.post('/api/pharmacy/orders/' + oid + '/price', {});
  assert.equal(pr.body.deliveryFeeKobo, 150000);
  assert.equal(pr.body.bill.totalKobo, items.METF500.sellPriceKobo * 60 + 150000);
  const pid = await pay(tobi, pr.body.billId);
  await tobi.post('/api/pay/demo/' + pid + '/complete');
  const ready = await phY.post('/api/pharmacy/orders/' + oid + '/ready');
  assert.equal(ready.status, 200); assert.ok(ready.body.deliveryId);
  tobiDeliveryId = ready.body.deliveryId;
  const d = await dispY.get('/api/delivery/deliveries/' + tobiDeliveryId);
  assert.equal(d.body.status, 'pending'); assert.ok(!('codeHash' in d.body));
  const riders = (await dispY.get('/api/delivery/riders')).body;
  const sam = riders.find(r => r.name === 'Sam Udo'); assert.equal(sam.onDuty, true);
  const ken = riders.find(r => r.name === 'Ken Ali'); assert.equal(ken.onDuty, false, 'rider2 not clocked in');
  assert.equal((await dispY.post('/api/delivery/deliveries/' + tobiDeliveryId + '/assign', { riderMembershipId: ken.membershipId })).status, 409, 'off duty rider');
  const hospRider = h.ctx.staff.hospital.rider.membership.id;
  assert.equal((await dispY.post('/api/delivery/deliveries/' + tobiDeliveryId + '/assign', { riderMembershipId: hospRider })).status, 404, 'rider of another provider');
  const as = await dispY.post('/api/delivery/deliveries/' + tobiDeliveryId + '/assign', { riderMembershipId: sam.membershipId });
  assert.equal(as.status, 200); assert.equal(as.body.status, 'assigned');
  assert.equal((await riderH.get('/api/rider/jobs/' + tobiDeliveryId)).status, 404, 'rider of another pharmacy');
  assert.equal((await riderH.post('/api/rider/jobs/' + tobiDeliveryId + '/pickup')).status, 404);
  assert.equal((await phH.get('/api/delivery/deliveries/' + tobiDeliveryId)).status, 404);
  const jobs = await riderY.get('/api/rider/jobs');
  assert.ok(jobs.body.active.some(j => j.id === tobiDeliveryId && j.patient.firstName === 'Tobi'));
  const pu = await riderY.post('/api/rider/jobs/' + tobiDeliveryId + '/pickup');
  assert.equal(pu.status, 200); assert.equal(pu.body.status, 'picked_up');
  assert.equal((await h.db.col('rx_orders').findOne({ id: oid })).status, 'out_for_delivery');
  assert.equal((await riderY.post('/api/rider/location', { lat: 200, lng: 3.37 })).status, 400);
  const loc = await riderY.post('/api/rider/location', { lat: 6.5085, lng: 3.3720, accuracy: 12, heading: 90 });
  assert.equal(loc.status, 200); assert.equal(loc.body.jobsUpdated, 1);
  const track = await tobi.get('/api/me/deliveries/' + tobiDeliveryId);
  assert.equal(track.status, 200); assert.equal(track.body.status, 'picked_up');
  assert.equal(track.body.rider.firstName, 'Sam');
  assert.equal(track.body.riderLocation.lat, 6.5085);
  assert.equal(typeof track.body.etaMinutes, 'number');
  assert.match(track.body.deliveryCode, /^\d{6}$/);
  assert.equal((await amaka.get('/api/me/deliveries/' + tobiDeliveryId)).status, 404, 'other patients see nothing');
  assert.ok(!(await amaka.get('/api/me/deliveries')).body.some(x => x.id === tobiDeliveryId));
  const wrong = track.body.deliveryCode === '123456' ? '654321' : '123456';
  const w = await riderY.post('/api/rider/jobs/' + tobiDeliveryId + '/deliver', { code: wrong });
  assert.equal(w.status, 400);
  const ok = await riderY.post('/api/rider/jobs/' + tobiDeliveryId + '/deliver', { code: track.body.deliveryCode });
  assert.equal(ok.status, 200); assert.equal(ok.body.status, 'delivered');
  assert.equal((await h.db.col('rx_orders').findOne({ id: oid })).status, 'delivered');
  assert.equal((await riderY.post('/api/rider/jobs/' + tobiDeliveryId + '/deliver', { code: track.body.deliveryCode })).status, 409);
});

test('delivery code: 5 wrong tries lock and alert the dispatcher; controlled drug goes in the register', async () => {
  const rx = await mkRx('hospital', 'tobi', [{ drugCode: 'TRAM50', drugName: 'Tramadol 50mg capsule', doseMg: 50, frequency: 'bd', durationDays: 5, quantity: 10 }]);
  const ready = await toReady(tobi, rx, 'delivery', { address: '22 Herbert Macaulay Way, Yaba', location: { lat: 6.507, lng: 3.375 } });
  const cd = await phY.get('/api/pharmacy/controlled-register?itemId=' + items.TRAM50.id);
  assert.ok(cd.body.some(r => r.patientId === h.ctx.patients.tobi.id && r.qty === 10 && r.batchNo && r.byName === 'Pharm. Musa Ibrahim'));
  const did = ready.deliveryId;
  const sam = (await dispY.get('/api/delivery/riders')).body.find(r => r.name === 'Sam Udo');
  await dispY.post('/api/delivery/deliveries/' + did + '/assign', { riderMembershipId: sam.membershipId });
  // pharmacy can also confirm the hand-over
  assert.equal((await phY.post('/api/delivery/deliveries/' + did + '/handover')).status, 200);
  const code = (await tobi.get('/api/me/deliveries/' + did)).body.deliveryCode;
  const wrong = code === '999999' ? '888888' : '999999';
  const res = [];
  for (let i = 0; i < 5; i++) res.push((await riderY.post('/api/rider/jobs/' + did + '/deliver', { code: wrong })).status);
  assert.deepEqual(res, [400, 400, 400, 400, 423]);
  assert.equal((await riderY.post('/api/rider/jobs/' + did + '/deliver', { code })).status, 423, 'locked even with the right code');
  assert.ok(await h.db.col('notifications').findOne({ orgId: h.ctx.orgs.pharmacy.id, role: 'delivery_dispatcher', kind: 'delivery_alert' }));
  assert.equal((await tobi.get('/api/me/deliveries/' + did)).body.codeLocked, true);
  const un = await dispY.post('/api/delivery/deliveries/' + did + '/unlock');
  assert.equal(un.status, 200);
  const code2 = (await tobi.get('/api/me/deliveries/' + did)).body.deliveryCode;
  assert.equal((await riderY.post('/api/rider/jobs/' + did + '/deliver', { code: code2 })).status, 200);
});

test('failed delivery is returned to the pharmacy and can be retried', async () => {
  const rx = await mkRx('hospital', 'tobi', [{ drugCode: 'PARA500', drugName: 'Paracetamol 500mg tablet', doseMg: 500, frequency: 'tds', durationDays: 3, quantity: 9 }]);
  const ready = await toReady(tobi, rx, 'delivery', { address: 'Yaba' });
  const did = ready.deliveryId;
  const sam = (await dispY.get('/api/delivery/riders')).body.find(r => r.name === 'Sam Udo');
  await dispY.post('/api/delivery/deliveries/' + did + '/assign', { riderMembershipId: sam.membershipId });
  await riderY.post('/api/rider/jobs/' + did + '/pickup');
  assert.equal((await riderY.post('/api/rider/jobs/' + did + '/fail', { reason: 'other' })).status, 400, 'other needs a note');
  const f = await riderY.post('/api/rider/jobs/' + did + '/fail', { reason: 'patient_unreachable' });
  assert.equal(f.body.status, 'failed');
  assert.equal((await phY.post('/api/pharmacy/orders/' + ready.id + '/cancel', { reason: 'test cancel' })).status, 409, 'cannot cancel while out for delivery');
  const r = await dispY.post('/api/delivery/deliveries/' + did + '/returned');
  assert.equal(r.body.status, 'returned');
  assert.equal((await h.db.col('rx_orders').findOne({ id: ready.id })).status, 'ready');
  const rt = await dispY.post('/api/delivery/deliveries/' + did + '/retry');
  assert.equal(rt.body.status, 'pending'); assert.equal(rt.body.attempts, 2);
  // cancel a ready order: stock returns to its batches and a refund is noted
  const stockBefore = sumQty(await batchesOf('pharmacy', items.PARA500.id));
  const c = await phY.post('/api/pharmacy/orders/' + ready.id + '/cancel', { reason: 'Patient no longer needs it' });
  assert.equal(c.status, 200); assert.ok(c.body.refundDue.amountKobo > 0);
  assert.equal(sumQty(await batchesOf('pharmacy', items.PARA500.id)), stockBefore + 9);
  assert.equal((await h.db.col('deliveries').findOne({ id: did })).status, 'cancelled');
});

test('patient can cancel before paying; the prescription can then be sent elsewhere', async () => {
  const rx = await mkRx('clinic', 'kunle', [{ drugCode: 'ASP75', drugName: 'Aspirin 75mg tablet', quantity: 28 }]);
  const s = await kunle.post('/api/me/prescriptions/' + rx.id + '/send', { pharmacyOrgId: h.ctx.orgs.pharmacy.id, fulfilment: 'pickup' });
  const c = await kunle.post('/api/me/rx-orders/' + s.body.id + '/cancel', { reason: 'Found it closer to home' });
  assert.equal(c.status, 200); assert.equal(c.body.status, 'cancelled');
  const s2 = await kunle.post('/api/me/prescriptions/' + rx.id + '/send', { pharmacyOrgId: h.ctx.orgs.hospital.id, fulfilment: 'pickup' });
  assert.equal(s2.status, 200, 'hospital pharmacy accepts it');
  assert.equal((await phH.get('/api/pharmacy/orders/' + s2.body.id)).status, 200);
  assert.equal((await phY.get('/api/pharmacy/orders/' + s2.body.id)).status, 404);
});

test('stock never goes negative; bad input rejected', async () => {
  assert.equal((await phY.post('/api/pharmacy/stock/receive', { itemId: items.ZINC20.id, batchNo: 'NEG-1', expiry: '2030-01-01', qty: -5 })).status, 400);
  assert.equal((await phY.post('/api/pharmacy/stock/receive', { itemId: items.ZINC20.id, batchNo: 'OLD-1', expiry: '2020-01-01', qty: 5 })).status, 400, 'expired stock refused');
  assert.equal((await phY.post('/api/pharmacy/stock/receive', { itemId: items.ZINC20.id, batchNo: 'X 1;', expiry: '2030-01-01', qty: 5 })).status, 400);
  const r = await phY.post('/api/pharmacy/stock/receive', { itemId: items.ZINC20.id, batchNo: 'PAR-1', expiry: '2030-01-01', qty: 5, costKobo: 800 });
  assert.equal(r.status, 200);
  assert.equal((await phY.post('/api/pharmacy/batches/' + r.body.id + '/adjust', { delta: -6, reason: 'damaged' })).status, 409);
  const rs = await Promise.all([1, 2, 3].map(() => phY.post('/api/pharmacy/batches/' + r.body.id + '/adjust', { delta: -2, reason: 'breakage' })));
  assert.equal(rs.filter(x => x.status === 200).length, 2);
  assert.equal((await h.db.col('pharmacy_batches').findOne({ id: r.body.id })).qty, 1);
  assert.equal((await phY.post('/api/pharmacy/batches/' + r.body.id + '/count', { counted: -1 })).status, 400);
  const cnt = await phY.post('/api/pharmacy/batches/' + r.body.id + '/count', { counted: 3 });
  assert.equal(cnt.body.variance, 2);
  const all = await h.db.col('pharmacy_batches').find({ orgId: h.ctx.orgs.pharmacy.id });
  assert.ok(all.every(b => b.qty >= 0));
  assert.equal((await phY.post('/api/pharmacy/items', { drugCode: 'NOPE1', sellPriceKobo: 100 })).status, 400);
  assert.equal((await phY.post('/api/pharmacy/items', { drugCode: 'AMOX500', sellPriceKobo: 100 })).status, 409, 'already stocked');
  assert.equal((await phY.patch('/api/pharmacy/items/' + items.TRAM50.id, { controlled: false })).status, 400);
  assert.equal((await counterY.post('/api/pharmacy/stock/receive', { itemId: items.ZINC20.id, batchNo: 'C-1', expiry: '2030-01-01', qty: 1 })).status, 403, 'cashier cannot receive stock');
  assert.equal((await phH.post('/api/pharmacy/batches/' + r.body.id + '/adjust', { delta: -1, reason: 'damaged' })).status, 404, 'other pharmacy');
});

test('purchase order: lines must be on the PO, receiving creates batches, cannot over-receive', async () => {
  const sup = (await phY.get('/api/pharmacy/suppliers')).body[0];
  const po = await phY.post('/api/pharmacy/purchase-orders', { supplierId: sup.id, lines: [{ itemId: items.LISI10.id, qty: 50, costKobo: 3800 }] });
  assert.equal(po.status, 200); assert.equal(po.body.status, 'draft');
  const line = { itemId: items.LISI10.id, batchNo: 'PO-LISI-1', expiry: '2029-06-30', qty: 20 };
  assert.equal((await phY.post('/api/pharmacy/purchase-orders/' + po.body.id + '/receive', { lines: [line] })).status, 409, 'draft cannot be received');
  assert.equal((await phY.post('/api/pharmacy/purchase-orders/' + po.body.id + '/send')).status, 200);
  assert.equal((await phY.post('/api/pharmacy/purchase-orders/' + po.body.id + '/send')).status, 409);
  assert.equal((await phY.post('/api/pharmacy/purchase-orders/' + po.body.id + '/receive', { lines: [Object.assign({}, line, { itemId: items.AMLO5.id })] })).status, 400, 'not on the PO');
  assert.equal((await phY.post('/api/pharmacy/purchase-orders/' + po.body.id + '/receive', { lines: [Object.assign({}, line, { qty: 60 })] })).status, 400, 'over-receive');
  const r1 = await phY.post('/api/pharmacy/purchase-orders/' + po.body.id + '/receive', { lines: [line] });
  assert.equal(r1.status, 200); assert.equal(r1.body.po.status, 'partially_received'); assert.equal(r1.body.batches[0].qty, 20);
  assert.equal(r1.body.batches[0].costKobo, 3800);
  const r2 = await phY.post('/api/pharmacy/purchase-orders/' + po.body.id + '/receive', { lines: [{ itemId: items.LISI10.id, batchNo: 'PO-LISI-2', expiry: '2029-09-30', qty: 30 }] });
  assert.equal(r2.body.po.status, 'received');
  assert.equal((await phY.post('/api/pharmacy/purchase-orders/' + po.body.id + '/receive', { lines: [line] })).status, 409);
  const bs = await h.db.col('pharmacy_batches').find({ poId: po.body.id });
  assert.equal(sumQty(bs), 50);
  assert.equal((await phH.get('/api/pharmacy/purchase-orders/' + po.body.id)).status, 404);
});

test('recall happens once and the batch is no longer dispensed', async () => {
  const bs = (await batchesOf('pharmacy', items.WARF5.id)).filter(b => b.status === 'active');
  const target = bs[0];
  const before = (await phY.get('/api/pharmacy/items/' + items.WARF5.id)).body.item.onHand;
  const rs = await Promise.all([1, 2].map(() => phY.post('/api/pharmacy/batches/' + target.id + '/recall', { reason: 'NAFDAC recall notice' })));
  assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
  assert.equal((await phY.post('/api/pharmacy/batches/' + target.id + '/recall', { reason: 'NAFDAC recall notice' })).status, 409);
  const after = (await phY.get('/api/pharmacy/items/' + items.WARF5.id)).body.item;
  assert.equal(after.onHand, before - target.qty); assert.equal(after.quarantinedQty, target.qty);
  assert.equal((await phY.post('/api/pharmacy/batches/' + target.id + '/return-in', { qty: 1, reason: 'customer return' })).status, 409);
  assert.equal((await h.db.col('recalls').find({ batchId: target.id })).length, 1);
  const sale = await phY.post('/api/pharmacy/sales', { patientId: h.ctx.patients.tobi.id, lines: [{ itemId: items.WARF5.id, qty: before - target.qty + 1 }] });
  assert.equal(sale.status, 409, 'quarantined stock is not available');
});

test('dashboard, valuation and daily sales for pharmacists and admins; riders and dispatchers cannot see them', async () => {
  const d = await phY.get('/api/pharmacy/dashboard');
  assert.equal(d.status, 200); assert.ok(d.body.lowStock >= 1); assert.ok(d.body.today.revenueKobo > 0);
  const v = await ownerY.get('/api/pharmacy/reports/valuation');
  assert.equal(v.status, 200); assert.ok(v.body.totals.costKobo > 0); assert.ok(v.body.totals.sellKobo > v.body.totals.costKobo);
  const s = await ownerY.get('/api/pharmacy/reports/daily-sales');
  assert.equal(s.status, 200); assert.ok(s.body.bySource.rx_order.count >= 1); assert.ok(s.body.bySource.pharmacy_sale.count >= 1);
  assert.equal((await dispY.get('/api/pharmacy/reports/valuation')).status, 403);
  assert.equal((await riderY.get('/api/pharmacy/dashboard')).status, 403);
  assert.equal((await counterY.get('/api/pharmacy/controlled-register')).status, 403);
});

test('HQ settings: per-provider overrides for substitution, home delivery and verification', async () => {
  const orgs = h.db.col('orgs'); const yid = h.ctx.orgs.pharmacy.id;
  await orgs.updateOne({ id: yid }, { $set: { overrides: { features: { homeDelivery: false }, process: { pharmacy: { allowSubstitution: false, requirePharmacistVerify: false } } } } });
  try {
    const rx = await mkRx('clinic', 'kunle', [{ drugCode: 'LOSA50', drugName: 'Losartan 50mg tablet', quantity: 30 }]);
    const d = await kunle.post('/api/me/prescriptions/' + rx.id + '/send', { pharmacyOrgId: yid, fulfilment: 'delivery', address: 'Ikoyi' });
    assert.equal(d.status, 400, 'home delivery switched off');
    const s = await kunle.post('/api/me/prescriptions/' + rx.id + '/send', { pharmacyOrgId: yid, fulfilment: 'pickup' });
    assert.equal(s.status, 200);
    const sub = await phY.post('/api/pharmacy/orders/' + s.body.id + '/price', { lines: [{ rxIndex: 0, itemId: items.AMLO5.id, substitutionReason: 'Out of losartan today' }] });
    assert.equal(sub.status, 400); assert.match(sub.body.error, /Substitutions are switched off/);
    const pr = await phY.post('/api/pharmacy/orders/' + s.body.id + '/price', {});
    assert.equal(pr.status, 200, 'priced straight from received when verification is off'); assert.equal(pr.body.status, 'priced');
  } finally { await orgs.updateOne({ id: yid }, { $unset: { overrides: '' } }); }
});
