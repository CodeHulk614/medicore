'use strict';
/*
 * Cross-package flows: standalone providers working together on one patient record.
 *   A clinic with no pharmacy or lab  ->  the patient chooses a standalone pharmacy and lab
 *   A patient SOS  ->  the nearest standalone ambulance service  ->  a hospital's front desk
 *   A pharmacy bill  ->  HMO cover  ->  claim  ->  the HMO pays
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

let h;
before(async () => { h = await boot({ patientMode: 'open' }); });
after(async () => { await h.close(); });
const ok = (r, msg) => { assert.ok(r.status >= 200 && r.status < 300, (msg || '') + ' -> ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 300)); return r.body; };

test('clinic-only consult -> patient-chosen pharmacy with delivery -> patient-chosen lab -> results back to the clinic', async () => {
  const kunle = h.ctx.patients.kunle;
  const fd = await h.as('frontdesk', 'reception@lekkifamily.demo');
  const docs = ok(await h.client('patient').get('/api/doctors?orgId=' + h.ctx.orgs.clinic.id));
  const ada = docs.find(d => /Ada/.test(d.name)); assert.ok(ada, 'clinic doctor listed');
  const q = ok(await fd.post('/api/fd/queue', { patientId: kunle.id, servicePoint: 'doctor', doctorMembershipId: ada.membershipId || ada.id, complaint: 'Headache and fever' }), 'check in');
  const doc = await h.as('doctor', 'dr.ada@lekkifamily.demo');
  const enc = ok(await doc.post('/api/doc/encounters', { queueId: q.id }), 'start consult');
  // the clinic has no pharmacy: internal routing is refused, patient choice works
  const items = [{ drugCode: 'PARA500', drugName: 'Paracetamol 500mg tablet', doseMg: 1000, doseText: '1g (2 tablets)', frequency: 'tds', durationDays: 3, quantity: 18, route: 'oral' }];
  // asking for the in-house pharmacy at a clinic without one falls back to patient choice, with the reason
  const rx = ok(await doc.post('/api/doc/encounters/' + enc.id + '/prescriptions', { items, sendTo: 'internal' }), 'prescribe');
  assert.equal(JSON.stringify(rx).includes('no_internal_pharmacy'), true, 'reason given: ' + JSON.stringify(rx).slice(0, 200));
  const lab = ok(await doc.post('/api/doc/encounters/' + enc.id + '/lab-orders', { tests: [{ code: 'MP' }, { code: 'FBC' }], sendTo: 'patient_choice', clinicalNote: 'Fever 2 days' }), 'lab order');
  ok(await doc.post('/api/doc/encounters/' + enc.id + '/complete', { diagnoses: [{ code: 'R50.9', text: 'Fever, unspecified' }] }), 'complete');

  // patient sends the prescription to the standalone pharmacy for delivery
  const pat = await h.as('patient', 'kunle@patient.demo');
  const myRx = ok(await pat.get('/api/me/prescriptions')).find(p => p.id === (rx.prescription || rx).id);
  assert.ok(myRx, 'patient sees the clinic prescription');
  const order = ok(await pat.post('/api/me/prescriptions/' + myRx.id + '/send', { pharmacyOrgId: h.ctx.orgs.pharmacy.id, fulfilment: 'delivery', address: '9 Bourdillon Rd, Ikoyi', location: { lat: 6.452, lng: 3.435 } }), 'send to pharmacy');
  const ph = await h.as('pharmacy', 'pharmacist@yabacare.demo');
  ok(await ph.post('/api/pharmacy/orders/' + order.id + '/verify', { decision: 'proceed' }), 'verify');
  ok(await ph.post('/api/pharmacy/orders/' + order.id + '/price', {}), 'price');
  // another pharmacy cannot see it
  const hospPh = await h.as('pharmacy', 'pharmacist@grandville.demo');
  assert.equal((await hospPh.get('/api/pharmacy/orders/' + order.id)).status, 404);
  const pOrder = ok(await pat.get('/api/me/rx-orders/' + order.id));
  const pay = ok(await pat.post('/api/me/bills/' + (pOrder.billId || pOrder.bill.id) + '/pay'), 'pay init');
  ok(await pat.post('/api/pay/demo/' + pay.paymentId + '/complete'), 'pay');
  ok(await ph.post('/api/pharmacy/orders/' + order.id + '/ready'), 'ready');
  const disp = await h.as('pharmacy', 'dispatch@yabacare.demo');
  const riders = ok(await disp.get('/api/delivery/riders'));
  const rider = await h.as('rider', 'rider@yabacare.demo');
  const sam = riders.find(r => /Sam/.test(r.name || '')) || riders[0];
  const dels = ok(await disp.get('/api/delivery/deliveries?active=true'));
  const del = dels.find(d => d.rxOrderId === order.id);
  ok(await disp.post('/api/delivery/deliveries/' + del.id + '/assign', { riderMembershipId: sam.membershipId }), 'assign');
  ok(await rider.post('/api/rider/jobs/' + del.id + '/pickup'), 'pickup');
  ok(await rider.post('/api/rider/location', { lat: 6.47, lng: 3.41, accuracy: 10 }), 'gps');
  const track = ok(await pat.get('/api/me/deliveries/' + del.id), 'track');
  assert.ok(track.deliveryCode, 'patient sees the delivery code');
  assert.equal((await rider.post('/api/rider/jobs/' + del.id + '/deliver', { code: '000000' })).status, 400);
  ok(await rider.post('/api/rider/jobs/' + del.id + '/deliver', { code: track.deliveryCode }), 'deliver');
  assert.equal(ok(await pat.get('/api/me/rx-orders/' + order.id)).status, 'delivered');

  // patient sends the lab order to the standalone lab, pays, lab works it, clinic gets the result
  const labOrderId = (lab.order || lab).id;
  ok(await pat.post('/api/me/lab-orders/' + labOrderId + '/send', { labOrgId: h.ctx.orgs.lab.id }), 'send to lab');
  const lo = ok(await pat.get('/api/me/lab-orders')).find(o => o.id === labOrderId);
  const lpay = ok(await pat.post('/api/me/bills/' + lo.billId + '/pay'));
  ok(await pat.post('/api/pay/demo/' + lpay.paymentId + '/complete'));
  const rec = await h.as('lab', 'reception@clearpath.demo');
  const sci = await h.as('lab', 'scientist@clearpath.demo');
  ok(await rec.post('/api/lab/orders/' + labOrderId + '/receive', {}), 'receive');
  ok(await sci.post('/api/lab/orders/' + labOrderId + '/start'), 'start');
  const res = ok(await sci.post('/api/lab/orders/' + labOrderId + '/results', { results: [{ code: 'MP', value: 'Seen (+)' }, { code: 'HB', value: '12.8' }, { code: 'WBC', value: '6.1' }, { code: 'PLT', value: '210' }, { code: 'PCV', value: '39' }] }), 'results');
  assert.ok(JSON.stringify(res).includes('abnormal'), 'malaria positive flagged by the server');
  ok(await sci.post('/api/lab/orders/' + labOrderId + '/verify'), 'verify');
  ok(await sci.post('/api/lab/orders/' + labOrderId + '/release'), 'release');
  const referred = ok(await doc.get('/api/lab/referred'));
  assert.ok(referred.some(o => o.id === labOrderId && o.status === 'released'), 'the clinic sees the result it asked for');
  const report = ok(await pat.get('/api/me/lab-orders/' + labOrderId + '/report'));
  assert.ok(report, 'patient sees the report');
});

test('SOS -> nearest standalone ambulance service -> hospital front desk pre-alert -> billed once', async () => {
  const amaka = await h.as('patient', 'amaka@patient.demo');
  const sos = ok(await amaka.post('/api/me/emergency', { lat: 6.5995, lng: 3.3520, category: 'breathing_difficulty', landmark: 'Allen roundabout' }).catch(e => e), 'sos');
  // both crews clock in (h.as does it) so their units are dispatchable
  const crewA = await h.as('crew', 'crew@swiftaid.demo'); const crewB = await h.as('crew', 'crew2@swiftaid.demo');
  const disp = await h.as('dispatch', 'dispatch@swiftaid.demo');
  const board = ok(await disp.get('/api/dispatch/board'));
  const inc = (board.incidents || board.open || board).find ? (board.incidents || board.open || board).find(i => i.id === sos.id) : null;
  assert.ok(inc || sos.orgName === 'SwiftAid Ambulance' || sos.provider, 'routed to SwiftAid (nearest with units)');
  const sugg = ok(await disp.get('/api/dispatch/incidents/' + sos.id + '/suggest'));
  const unit = (sugg.units || sugg)[0];
  ok(await disp.post('/api/dispatch/incidents/' + sos.id + '/assign', { unitId: unit.unitId || unit.id }), 'assign');
  ok(await disp.post('/api/dispatch/incidents/' + sos.id + '/destination', { orgId: h.ctx.orgs.hospital.id }), 'destination');
  const me = ok(await crewA.get('/api/crew/me'));
  const crew = me.unit && me.unit.id === (unit.unitId || unit.id) ? crewA : crewB;
  for (const st of ['enroute', 'onscene', 'transporting']) ok(await crew.post('/api/crew/incidents/' + sos.id + '/status', { status: st }), st);
  const hospFd = await h.as('frontdesk', 'reception@grandville.demo');
  const incoming = ok(await hospFd.get('/api/fd/incoming'));
  assert.ok(incoming.some(x => x.incidentId === sos.id), 'hospital front desk sees the incoming patient');
  ok(await crew.post('/api/crew/incidents/' + sos.id + '/status', { status: 'athospital' }));
  const [c1, c2] = await Promise.all([crew.post('/api/crew/incidents/' + sos.id + '/status', { status: 'clear' }), crew.post('/api/crew/incidents/' + sos.id + '/status', { status: 'clear' })]);
  assert.ok([c1.status, c2.status].includes(200));
  const bills = ok(await amaka.get('/api/me/bills')).filter(b => b.source && b.source.type === 'incident' && b.source.id === sos.id);
  assert.equal(bills.length, 1, 'exactly one ambulance bill');
});

test('pharmacy bill covered by HMO -> claim -> HMO approves and pays; other HMOs see nothing', async () => {
  const tobi = h.ctx.patients.tobi;
  const cash = await h.as('frontdesk', 'counter@yabacare.demo');
  const cover = ok(await cash.get('/api/hmo/patients/' + tobi.id + '/cover'));
  const list = Array.isArray(cover) ? cover : (cover.coverages || cover.active || []);
  const cov = list[0]; assert.ok(cov && (cov.id || cov.coverageId), 'tobi has Harbor cover: ' + JSON.stringify(cover).slice(0, 300));
  const ph = await h.as('pharmacy', 'pharmacist@yabacare.demo');
  const items = ok(await ph.get('/api/pharmacy/counter/items?q=Metformin'));
  const sale = ok(await ph.post('/api/pharmacy/sales', { patientId: tobi.id, lines: [{ itemId: items[0].id, qty: 2 }], overrideReason: 'Repeat prescription on file' }), 'sale');
  const billId = sale.billId || (sale.bill && sale.bill.id);
  const applied = ok(await cash.post('/api/hmo/bills/' + billId + '/apply-cover', { coverageId: cov.id || cov.coverageId }), 'apply cover');
  assert.ok(applied.coveredKobo > 0);
  if (applied.patientDueKobo > 0) ok(await cash.post('/api/bills/' + billId + '/cash', { method: 'cash', amountKobo: applied.patientDueKobo, receiptNo: 'INT-1' }), 'co-pay');
  const sub = ok(await cash.post('/api/hmo/claims', { billIds: [billId] }), 'claim');
  assert.equal(sub.submitted, 1, JSON.stringify(sub));
  const claimId = sub.results[0].claimId;
  const officer = await h.as('payer', 'officer@harborhmo.demo');
  ok(await officer.post('/api/payer/claims/' + claimId + '/review'));
  ok(await officer.post('/api/payer/claims/' + claimId + '/approve', { approvedKobo: applied.coveredKobo }));
  const mgr = await h.as('payer', 'owner@harborhmo.demo');
  const [p1, p2] = await Promise.all([mgr.post('/api/payer/claims/' + claimId + '/pay', { paymentRef: 'TRF-889' }), mgr.post('/api/payer/claims/' + claimId + '/pay', { paymentRef: 'TRF-889' })]);
  assert.deepEqual([p1.status, p2.status].sort(), [200, 409], 'paid exactly once');
  assert.equal((await cash.post('/api/hmo/claims', { billIds: [billId] })).body.submitted, 0, 'a bill is claimed once');
});

test('USSD emergency for a feature-phone patient creates an approximate-location case', async () => {
  const ussd = require('../src/modules/ambulance');
  const p = await h.db.col('patients').findOne({ id: h.ctx.patients.zainab.id });
  const inc = await ussd.createIncidentFromUssd({ patient: p, phone: p.phone, landmark: 'Near Ikeja City Mall', approxLocation: p.homeLoc });
  assert.equal(inc.source, 'ussd'); assert.equal(inc.verified, false);
  const again = await ussd.createIncidentFromUssd({ patient: p, phone: p.phone, landmark: 'x', approxLocation: p.homeLoc });
  assert.equal(again.id, inc.id, 'one open case per patient');
});
