'use strict';
/* The collaborative marketplace: patient subscription and access, HMO network access, joining and using providers,
 * stock and capacity, shared care, documents, emergency transfers to public hospitals, and HMOs on the platform. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

let h, hq, kunle, tobi, amaka, ngozi, fdG, fdC, labM, ph, drT, hmoM, ownerG, ownerLab;
const PNG = n => 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(n || 600, 7)]).toString('base64');
const JPG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(900, 3)]).toString('base64');
async function payDemo(pt, billId) {
  const p = await pt.post('/api/me/bills/' + billId + '/pay');
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const c = await pt.post('/api/pay/demo/' + p.body.paymentId + '/complete');
  assert.equal(c.status, 200, JSON.stringify(c.body));
}

before(async () => {
  h = await boot();
  hq = await h.as('hq', 'hq@medicore.demo');
  kunle = await h.as('patient', 'kunle@patient.demo');
  tobi = await h.as('patient', 'tobi@patient.demo');
  amaka = await h.as('patient', 'amaka@patient.demo');
  ngozi = await h.as('patient', 'ngozi@patient.demo');
  fdG = await h.as('frontdesk', 'fdmanager@grandville.demo');
  fdC = await h.as('frontdesk', 'reception@lekkifamily.demo');
  labM = await h.as('lab', 'manager@clearpath.demo');
  ph = await h.as('pharmacy', 'pharmacist@yabacare.demo');
  drT = await h.as('doctor', 'dr.tunde@grandville.demo');
  hmoM = await h.as('payer', 'owner@harborhmo.demo');
  ownerG = await h.as('admin', 'owner@grandville.demo');
  ownerLab = await h.as('admin', 'owner@clearpath.demo');
});
after(async () => { await h.close(); });

/* ---------------- marketplace access ---------------- */
test('without a subscription a patient sees a teaser; HMO members see their HMO network free', async () => {
  const k = await kunle.get('/api/market/providers');
  assert.equal(k.status, 200); assert.equal(k.body.access, 'none'); assert.equal(k.body.providers.length, 0); assert.ok(k.body.teaser.types.length);
  const st = await kunle.get('/api/market/status');
  assert.equal(st.body.full, false); assert.ok(st.body.prices.monthly.amountKobo > 0);
  // Tobi has active Harbor cover: Harbor's network (hospital, clinic, pharmacy, lab, ambulance) is open to him
  const t = await tobi.get('/api/market/providers');
  assert.equal(t.body.access, 'hmo');
  const ids = t.body.providers.map(p => p.id);
  assert.ok(ids.includes(h.ctx.orgs.clinic.id) && ids.includes(h.ctx.orgs.lab.id));
  assert.ok(!ids.includes(h.ctx.branches.ikeja.id), 'Crestview is not in the Harbor network');
  assert.ok(t.body.providers.every(p => p.viaHmo || p.yours !== undefined));
  // a provider outside the network stays hidden
  assert.equal((await tobi.get('/api/market/providers/' + h.ctx.branches.ikeja.id)).status, 404);
});

test('subscribing opens every listed provider, with stock, tests, doctors and capacity; joining registers at once', async () => {
  const sub = await kunle.post('/api/market/subscribe', { plan: 'monthly', consent: true });
  assert.equal(sub.status, 200, JSON.stringify(sub.body)); assert.ok(sub.body.billId);
  assert.equal((await kunle.get('/api/market/providers')).body.access, 'none', 'nothing opens before payment');
  await payDemo(kunle, sub.body.billId);
  const st = await kunle.get('/api/market/status');
  assert.equal(st.body.full, true); assert.equal(st.body.subscription.plan, 'monthly'); assert.ok(st.body.subscription.endsAt > Date.now() + 25 * 86400e3);
  // search near Surulere: the hospital is taking emergencies and shows free beds
  const list = await kunle.get('/api/market/providers?lat=6.50&lng=3.35&radiusKm=30');
  assert.equal(list.body.access, 'full');
  const gv = list.body.providers.find(p => p.id === h.ctx.orgs.hospital.id);
  assert.ok(gv && gv.takingEmergencies === true && gv.freeBeds > 0 && gv.doctors >= 1);
  assert.ok(list.body.providers[0].distanceKm <= list.body.providers[list.body.providers.length - 1].distanceKm, 'nearest first');
  // filters: a drug in stock, a lab test, emergencies only
  const drug = await kunle.get('/api/market/providers?drug=para');
  assert.ok(drug.body.providers.length >= 1 && drug.body.providers.every(p => (p.drugMatches || []).length));
  const em = await kunle.get('/api/market/providers?emergency=true');
  assert.ok(em.body.providers.every(p => p.takingEmergencies === true));
  // the hospital's page: services with prices, doctors, public stock (state only), capacity and HMOs
  const page = await kunle.get('/api/market/providers/' + h.ctx.orgs.hospital.id);
  assert.equal(page.status, 200);
  assert.ok(page.body.services.length && page.body.doctors.length && page.body.hmos.some(x => x.network));
  const blood = page.body.storeItems.find(i => /O\+/.test(i.name));
  assert.ok(blood && blood.state === 'in_stock' && blood.qty === undefined, 'patients see availability, never quantities');
  assert.ok(page.body.storeItems.some(i => i.state === 'out'));
  const stock = await kunle.get('/api/market/providers/' + h.ctx.orgs.pharmacy.id + '/stock');
  assert.ok(stock.body.length && stock.body.every(i => ['in_stock', 'low', 'out'].includes(i.state)));
  // join the pharmacy: registered at once (no approval) and it shows in the switcher
  const j = await kunle.post('/api/market/providers/' + h.ctx.orgs.pharmacy.id + '/join');
  assert.equal(j.status, 200, JSON.stringify(j.body)); assert.equal(j.body.approved, true); assert.ok(j.body.mrn);
  const provs = await kunle.get('/api/me/providers/summary');
  assert.ok(provs.body.providers.some(p => p.orgIds.includes(h.ctx.orgs.pharmacy.id)));
  const link = await h.db.col('patient_links').findOne({ patientId: h.ctx.patients.kunle.id, orgId: h.ctx.orgs.pharmacy.id });
  assert.equal(link.via, 'marketplace');
});

test('a subscriber books a doctor at a provider they never visited; it registers them there', async () => {
  const docs = (await kunle.get('/api/market/providers/' + h.ctx.branches.ikeja.id)).body.doctors;
  assert.ok(docs.length);
  const { todayLagos, addDays } = require('../src/lib/util');
  let slot;
  for (let i = 1; i < 10 && !slot; i++) { const d = addDays(todayLagos(), i); const s = await kunle.get('/api/doctors/' + docs[0].membershipId + '/slots?date=' + d); assert.equal(s.status, 200, JSON.stringify(s.body)); const f = s.body.slots.find(x => x.available); if (f) slot = { date: d, time: f.time }; }
  const b = await kunle.post('/api/me/appointments', { doctorMembershipId: docs[0].membershipId, date: slot.date, time: slot.time, type: 'in_person', reason: 'Chest pain review' });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.ok(await h.db.col('patient_links').findOne({ patientId: h.ctx.patients.kunle.id, orgId: h.ctx.branches.ikeja.id }));
});

test('medicine orders through the marketplace follow the PCN switch', async () => {
  await hq.patch('/api/hq/config/features', { patch: { marketplacePharmacy: false } });
  const st = await kunle.get('/api/market/status');
  assert.equal(st.body.pharmacyOrders, false);
  await hq.patch('/api/hq/config/features', { patch: { marketplacePharmacy: true } });
});

test('a provider controls its listing; unlisted providers disappear from the marketplace', async () => {
  const prof = await ownerLab.get('/api/admin/market-profile');
  assert.equal(prof.status, 200); assert.equal(prof.body.listed, true);
  const u = await ownerLab.patch('/api/admin/market-profile', { listed: false, about: 'Diagnostics in Ikoyi' });
  assert.equal(u.status, 200); assert.equal(u.body.listed, false);
  const list = await kunle.get('/api/market/providers');
  assert.ok(!list.body.providers.some(p => p.id === h.ctx.orgs.lab.id));
  await ownerLab.patch('/api/admin/market-profile', { listed: true });
  const m = await hq.get('/api/hq/market');
  assert.equal(m.status, 200); assert.ok(m.body.activeSubscribers >= 2);
});

/* ---------------- stores and capacity ---------------- */
test('stores: receive, issue never below zero, count, alerts; capacity update', async () => {
  const meta = await labM.get('/api/store/meta');
  assert.ok(meta.body.depts.includes('lab') && !meta.body.depts.includes('ambulance'));
  const it = await labM.post('/api/store/items', { name: 'Urine containers', dept: 'lab', category: 'consumable', unit: 'pieces', qty: 5, reorderLevel: 3 });
  assert.equal(it.status, 200, JSON.stringify(it.body));
  const [a, b] = await Promise.all([labM.post('/api/store/items/' + it.body.id + '/move', { type: 'issue', qty: 4, reason: 'Morning clinic' }), labM.post('/api/store/items/' + it.body.id + '/move', { type: 'issue', qty: 4, reason: 'Morning clinic' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], 'only one issue of 4 fits in 5');
  const c = await labM.post('/api/store/items/' + it.body.id + '/move', { type: 'count', qty: 2, reason: 'Stock count' });
  assert.equal(c.status, 200); assert.equal(c.body.item.qty, 2); assert.equal(c.body.item.state, 'low');
  const sci = await h.as('lab', 'scientist@clearpath.demo');
  assert.equal((await sci.post('/api/store/items/' + it.body.id + '/move', { type: 'receive', qty: 10 })).status, 403, 'scientists issue, managers receive');
  const al = await labM.get('/api/store/alerts');
  assert.ok(al.body.low >= 1);
  const cap = await fdG.put('/api/store/capacity', { wards: [{ key: 'icu', total: 6, available: 0 }, { key: 'emergency', total: 8, available: 1 }], acceptingEmergencies: false, note: 'ICU full' });
  assert.equal(cap.status, 200, JSON.stringify(cap.body)); assert.equal(cap.body.freeBeds, 1);
  assert.equal((await fdG.put('/api/store/capacity', { wards: [{ key: 'icu', total: 2, available: 3 }], acceptingEmergencies: true })).status, 400);
  await fdG.put('/api/store/capacity', { wards: [{ key: 'icu', total: 6, available: 1 }, { key: 'emergency', total: 8, available: 2 }, { key: 'general', total: 60, available: 10 }], acceptingEmergencies: true });
});

/* ---------------- shared care ---------------- */
test('shared care: patient agrees in the app, the other provider accepts, both see records and talk', async () => {
  // Lekki Family Clinic shares Kunle with ClearPath Diagnostics for lab monitoring
  const before = await labM.get('/api/docs/patients/' + h.ctx.patients.kunle.id);
  assert.equal(before.status, 200);
  const up = await fdC.get('/api/docs/meta');
  assert.equal(up.status, 200);
  const clinicDoc = await fdC.post('/api/docs/patients/' + h.ctx.patients.kunle.id, { category: 'case_notes', title: 'Old clinic card', file: { name: 'card.jpg', mime: 'image/jpeg', data: JPG } });
  assert.equal(clinicDoc.status, 200, JSON.stringify(clinicDoc.body));
  assert.ok(!(await labM.get('/api/docs/patients/' + h.ctx.patients.kunle.id)).body.some(d => d.id === clinicDoc.body.id), 'not visible before sharing');
  const s = await fdC.post('/api/care-shares', { patientId: h.ctx.patients.kunle.id, toOrgId: h.ctx.orgs.lab.id, purpose: 'lab_monitoring', note: 'INR monthly while on warfarin' });
  assert.equal(s.status, 200, JSON.stringify(s.body)); assert.equal(s.body.status, 'pending_patient');
  assert.equal((await labM.post('/api/care-shares/' + s.body.id + '/accept')).status, 409, 'patient must agree first');
  const mine = await kunle.get('/api/me/care-team');
  assert.equal(mine.body.waitingForYou, 1);
  const ok = await kunle.post('/api/me/care-shares/' + s.body.id + '/approve');
  assert.equal(ok.status, 200); assert.equal(ok.body.status, 'pending_provider');
  const inbox = await labM.get('/api/care-shares?box=in');
  assert.ok(inbox.body.waiting >= 1);
  const acc = await labM.post('/api/care-shares/' + s.body.id + '/accept');
  assert.equal(acc.status, 200, JSON.stringify(acc.body)); assert.equal(acc.body.status, 'active');
  // the lab now sees the clinic's scan, the clinic sees the lab's
  assert.ok((await labM.get('/api/docs/patients/' + h.ctx.patients.kunle.id)).body.some(d => d.id === clinicDoc.body.id));
  const team = await fdC.get('/api/care-team/' + h.ctx.patients.kunle.id);
  assert.equal(team.body.team.length, 2); assert.equal(team.body.canWrite, true);
  const msg = await labM.post('/api/care-team/' + h.ctx.patients.kunle.id + '/messages', { text: 'INR 3.4 today, a bit high.' });
  assert.equal(msg.status, 200);
  assert.ok((await fdC.get('/api/care-team/' + h.ctx.patients.kunle.id)).body.messages.some(m => /INR 3.4/.test(m.text)));
  // a provider not on the team cannot write
  assert.equal((await ph.post('/api/care-team/' + h.ctx.patients.kunle.id + '/messages', { text: 'hello' })).status, 403);
  // the patient withdraws: records close again
  const rv = await kunle.post('/api/me/care-shares/' + s.body.id + '/revoke');
  assert.equal(rv.body.status, 'revoked');
  assert.ok(!(await labM.get('/api/docs/patients/' + h.ctx.patients.kunle.id)).body.some(d => d.id === clinicDoc.body.id));
});

test('shared care for a patient without the app: consent by SMS code at the desk', async () => {
  const z = h.ctx.patients.zainab.id;
  const s = await fdG.post('/api/care-shares', { patientId: z, toOrgId: h.ctx.orgs.ambulance.id, purpose: 'home_care' });
  assert.equal(s.status, 200, JSON.stringify(s.body)); assert.equal(s.body.patientHasApp, false); assert.equal(s.body.canUseCode, true);
  const dup = await fdG.post('/api/care-shares', { patientId: z, toOrgId: h.ctx.orgs.ambulance.id, purpose: 'home_care' });
  assert.equal(dup.status, 409);
  const send = await fdG.post('/api/care-shares/' + s.body.id + '/consent-code/send');
  assert.equal(send.status, 200); assert.ok(send.body.devCode);
  assert.equal((await fdG.post('/api/care-shares/' + s.body.id + '/consent-code/verify', { code: '000000' })).status, 400);
  const v = await fdG.post('/api/care-shares/' + s.body.id + '/consent-code/verify', { code: send.body.devCode });
  assert.equal(v.status, 200); assert.equal(v.body.status, 'pending_provider'); assert.equal(v.body.consent.method, 'code');
});

/* ---------------- documents ---------------- */
test('documents: scans checked by content, letters need a licence number and can be verified, signed forms', async () => {
  const p = h.ctx.patients.amaka.id;
  const fake = await fdG.post('/api/docs/patients/' + p, { category: 'other', title: 'Fake', file: { name: 'x.jpg', mime: 'image/jpeg', data: 'data:image/jpeg;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64') } });
  assert.equal(fake.status, 400, 'content must match the type');
  const d = await fdG.post('/api/docs/patients/' + p, { category: 'referral_letter', title: 'Letter from a mission hospital', docDate: '2025-02-01', file: { name: 'p1.png', mime: 'image/png', data: PNG() } });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const p2 = await fdG.post('/api/docs/' + d.body.id + '/files', { file: { name: 'p2.jpg', mime: 'image/jpeg', data: JPG } });
  assert.equal(p2.body.files.length, 2);
  const blob = await fdG.get('/api/docs/blobs/' + d.body.files[0].blobId);
  assert.equal(blob.status, 200); assert.match(blob.headers.get('content-type'), /image\/png/); assert.match(blob.headers.get('cache-control'), /no-store/);
  assert.equal((await fdC.get('/api/docs/blobs/' + d.body.files[0].blobId)).status, 404, 'another provider cannot open it');
  // a doctor without a licence number on file cannot issue a letter
  const drB = await h.as('doctor', 'dr.bisi@grandville.demo', { orgId: h.ctx.orgs.hospital.id });
  const noSig = await drB.post('/api/docs/patients/' + p + '/letters', { type: 'medical_report', body: 'Fit.' });
  assert.equal(noSig.status, 409);
  const sick = await drT.post('/api/docs/patients/' + p + '/letters', { type: 'sick_note', body: 'Unfit for work.', restFrom: '2026-10-22', restTo: '2026-10-24', addressedTo: 'The HR manager' });
  assert.equal(sick.status, 200, JSON.stringify(sick.body)); assert.ok(sick.body.verifyCode);
  const pub = h.client('register');
  const ver = await pub.get('/api/public/verify/' + sick.body.verifyCode);
  assert.equal(ver.body.valid, true); assert.equal(ver.body.patientInitials, 'A. E.'); assert.equal(ver.body.restTo, '2026-10-24'); assert.equal(ver.body.diagnosis, undefined);
  assert.equal((await pub.get('/api/public/verify/NOTAREALCODE')).body.valid, false);
  await drT.post('/api/docs/' + sick.body.id + '/cancel', { reason: 'Wrong dates' });
  assert.equal((await pub.get('/api/public/verify/' + sick.body.verifyCode)).body.valid, false, 'a cancelled letter no longer verifies');
  // a signed procedure consent with a witness
  const noWit = await drT.post('/api/docs/patients/' + p + '/forms', { templateId: 'std_consent_procedure', answers: { procedure: 'Excision of lipoma', anaesthesia: 'local', risks: 'bleeding, infection' }, signerName: 'Amaka Eze', signerRelation: 'self', signature: PNG() });
  assert.equal(noWit.status, 400);
  const f = await drT.post('/api/docs/patients/' + p + '/forms', { templateId: 'std_consent_procedure', answers: { procedure: 'Excision of lipoma', anaesthesia: 'local', risks: 'bleeding, infection' }, signerName: 'Amaka Eze', signerRelation: 'self', witnessName: 'Nurse Ngozi Okafor', signature: PNG() });
  assert.equal(f.status, 200, JSON.stringify(f.body)); assert.match(f.body.form.text, /Excision of lipoma/); assert.ok(f.body.form.signatureBlobId);
  // the patient sees letters and forms in the app and adds their own papers
  const mine = await amaka.get('/api/me/documents');
  assert.ok(mine.body.some(x => x.id === f.body.id));
  const own = await amaka.post('/api/me/documents', { category: 'immunisation', title: 'Childhood immunisation card', share: false, file: { name: 'card.jpg', mime: 'image/jpeg', data: JPG } });
  assert.equal(own.status, 200);
  assert.ok(!(await fdG.get('/api/docs/patients/' + p)).body.some(x => x.id === own.body.id), 'not shared yet');
  await amaka.post('/api/me/documents/' + own.body.id + '/share', { share: true });
  assert.ok((await fdG.get('/api/docs/patients/' + p)).body.some(x => x.id === own.body.id));
  assert.equal((await amaka.get('/api/me/documents/blobs/' + own.body.files[0].blobId)).status, 200);
  assert.equal((await kunle.get('/api/me/documents/blobs/' + own.body.files[0].blobId)).status, 404);
});

/* ---------------- facilities and transfers ---------------- */
test('public hospitals: HQ adds and imports; the finder mixes MediCore and public hospitals; anyone sees the emergency map', async () => {
  const c = await hq.post('/api/hq/facilities', { name: 'Test Federal Hospital', kind: 'federal_medical_centre', ownership: 'federal', level: 'tertiary', state: 'Lagos', location: { lat: 6.52, lng: 3.36 }, phones: [{ number: '01 2345678', kind: 'main' }, { number: '0803 111 2222', kind: 'transfer' }], services: ['emergency', 'icu', 'dialysis'], open24h: true });
  assert.equal(c.status, 200, JSON.stringify(c.body)); assert.equal(c.body.phones[0].number, '+23412345678');
  const csv = 'name,kind,ownership,level,state,lga,lat,lng,main_phone,emergency_phone,services,open24h\n"Imported General Hospital, Yaba",general,state,secondary,Lagos,Yaba,6.51,3.37,08031234000,08031234001,emergency|maternity,yes\nNo Location PHC,phc,lga,primary,Lagos,Ikeja,,,08031234002,,maternity,no\n';
  const dry = await hq.post('/api/hq/facilities/import', { csv, dryRun: true });
  assert.equal(dry.status, 200); assert.equal(dry.body.created, 0); assert.equal(dry.body.results.length, 2);
  const imp = await hq.post('/api/hq/facilities/import', { csv });
  assert.equal(imp.body.created, 2);
  assert.equal((await hq.post('/api/hq/facilities/import', { csv })).body.updated, 2, 'importing again updates');
  const fin = await fdG.get('/api/facilities/finder?lat=6.50&lng=3.35&service=dialysis');
  assert.equal(fin.status, 200);
  assert.ok(fin.body.facilities.some(x => x.name === 'Test Federal Hospital'));
  assert.ok(fin.body.facilities.every(x => (x.services || []).includes('dialysis')));
  const all = await fdG.get('/api/facilities/finder?lat=6.50&lng=3.35');
  assert.ok(all.body.facilities.some(x => x.source === 'platform') && all.body.facilities.some(x => x.source === 'public'));
  assert.ok(!all.body.facilities.some(x => x.id === h.ctx.orgs.hospital.id), 'not your own hospital');
  const anyone = h.client('patient');
  const em = await anyone.get('/api/emergency/facilities?lat=6.50&lng=3.35');
  assert.equal(em.status, 200); assert.ok(em.body.facilities.length);
  assert.ok(em.body.facilities.every(x => x.freeBeds === undefined), 'no bed counts in public');
});

test('transfer to a public hospital: log the call, a transfer pack with a code, and an ambulance', async () => {
  const f = (await fdG.get('/api/facilities/finder?lat=6.50&lng=3.35&source=public')).body.facilities[0];
  const tr = await fdG.post('/api/transfers', { patientId: h.ctx.patients.zainab.id, facilityId: f.id, reason: 'Needs paediatric ICU', clinicalNote: 'Severe asthma attack, SpO2 88% on oxygen', urgency: 'emergency' });
  assert.equal(tr.status, 200, JSON.stringify(tr.body));
  const lg = await fdG.post('/api/transfers/' + tr.body.id + '/log', { outcome: 'accepted', contactName: 'Dr. on call', numberCalled: f.phones[0].number });
  assert.equal(lg.body.status, 'accepted');
  const pack = await fdG.post('/api/transfers/' + tr.body.id + '/pack');
  assert.equal(pack.status, 200); assert.match(pack.body.code, /^\d{6}$/);
  const token = pack.body.path.split('/').pop();
  const pub = h.client('register');
  assert.equal((await pub.post('/api/public/transfer/' + token, { code: '111111' })).status, 400);
  const open = await pub.post('/api/public/transfer/' + token, { code: pack.body.code });
  assert.equal(open.status, 200); assert.equal(open.body.snapshot.patient.name, 'Zainab Bello'); assert.ok(open.body.snapshot.allergies.length);
  await fdG.post('/api/transfers/' + tr.body.id + '/pack/revoke');
  assert.equal((await pub.post('/api/public/transfer/' + token, { code: pack.body.code })).status, 404, 'a withdrawn pack closes');
  const amb = await fdG.post('/api/transfers/' + tr.body.id + '/ambulance', {});
  assert.equal(amb.status, 200, JSON.stringify(amb.body)); assert.ok(amb.body.incidentNumber);
  const inc = await h.db.col('incidents').findOne({ id: amb.body.incidentId });
  assert.equal(inc.source, 'transfer'); assert.equal(inc.destination.name, f.name); assert.equal(inc.triage.priority, 'P1');
  assert.equal((await fdG.post('/api/transfers/' + tr.body.id + '/ambulance', {})).status, 409);
});

/* ---------------- HMOs on the platform ---------------- */
test('HMO plans sold in the app: buy, pay the premium, active cover with a member card', async () => {
  const plans = await hmoM.get('/api/payer/plans');
  assert.equal(plans.status, 200); assert.ok(plans.body.length >= 2);
  const list = await kunle.get('/api/me/hmo/plans');
  assert.equal(list.status, 200);
  const harbor = list.body.find(x => x.payerOrgId === h.ctx.orgs.hmo.id);
  const silver = harbor.plans.find(p => p.name === 'Harbor Silver');
  const net = await kunle.get('/api/me/hmo/networks/' + h.ctx.orgs.hmo.id + '?primaryOnly=true');
  assert.ok(net.body.length >= 2 && net.body.every(p => p.primaryCare));
  assert.equal((await kunle.post('/api/me/hmo/buy', { planId: silver.id, period: 'monthly', primaryOrgId: h.ctx.orgs.pharmacy.id, consent: true })).status, 400, 'a pharmacy is not a primary care provider');
  const buy = await kunle.post('/api/me/hmo/buy', { planId: silver.id, period: 'monthly', primaryOrgId: h.ctx.orgs.clinic.id, consent: true });
  assert.equal(buy.status, 200, JSON.stringify(buy.body)); assert.equal(buy.body.coverage.status, 'pending'); assert.equal(buy.body.coverage.paymentDue, true);
  await payDemo(kunle, buy.body.billId);
  const cards = await kunle.get('/api/me/hmo/cards');
  const card = cards.body.find(c => c.payerOrgId === h.ctx.orgs.hmo.id);
  assert.equal(card.status, 'active'); assert.ok(card.cardCode && card.validTo); assert.equal(card.primaryOrgName, h.ctx.orgs.clinic.name); assert.ok(card.limits.consultation > 0);
  // primary provider changes are limited
  const tooSoon = await kunle.post('/api/me/hmo/' + card.id + '/primary', { orgId: h.ctx.orgs.hospital.id });
  assert.equal(tooSoon.status, 409, 'the choice at purchase counts; changes wait the HQ minimum'); assert.equal(tooSoon.body.code, 'too_soon');
  // the HMO can still move a member when needed
  const moved = await hmoM.post('/api/payer/coverages/' + card.id + '/details', { primaryOrgId: h.ctx.orgs.hospital.id });
  assert.equal(moved.status, 200); assert.equal(moved.body.primaryOrgName, h.ctx.orgs.hospital.name);
  // the HMO sees the online member and the premium
  const ov = await hmoM.get('/api/payer/overview');
  assert.ok(ov.body.onlineMembers >= 1);
});

test('member card at the desk: verify, register a dependant without a phone', async () => {
  const v = await fdG.get('/api/hmo/verify-card?code=HGCHIDE2');
  assert.equal(v.status, 200, JSON.stringify(v.body)); assert.equal(v.body.relation, 'child'); assert.equal(v.body.active, true); assert.equal(v.body.linkedHere, false); assert.equal(v.body.isPrimaryHere, true);
  assert.equal(v.body.limits, undefined, 'the desk sees status, not the money left');
  const r = await fdG.post('/api/hmo/verify-card/register', { code: 'HGCHIDE2' });
  assert.equal(r.status, 200); assert.ok(r.body.mrn);
  assert.equal((await fdG.get('/api/hmo/verify-card?code=HGCHIDE2')).body.linkedHere, true);
  // a provider outside Harbor's network and panel cannot read the card
  const fdIk = await h.as('frontdesk', 'reception.ikeja@crestview.demo');
  assert.equal((await fdIk.get('/api/hmo/verify-card?code=HGCHIDE2')).status, 404);
  // the principal sees the dependant's card in the app
  const cards = await amaka.get('/api/me/hmo/cards');
  assert.ok(cards.body.some(c => c.relation === 'child' && c.mine === false));
});

test('HMO network: invite, provider accepts (joins the panel), capitation statement paid once', async () => {
  const cand = await hmoM.get('/api/payer/network/candidates?lat=6.6&lng=3.35');
  const ik = cand.body.find(o => o.id === h.ctx.branches.ikeja.id);
  assert.ok(ik && ik.networkStatus === null);
  const inv = await hmoM.post('/api/payer/network', { orgId: ik.id, level: 'primary', primaryCare: true, capitationKobo: 120000 });
  assert.equal(inv.status, 200, JSON.stringify(inv.body)); assert.equal(inv.body.status, 'invited');
  assert.equal((await hmoM.post('/api/payer/network', { orgId: ik.id })).status, 409);
  const adIk = await h.as('admin', 'admin.ikeja@crestview.demo');
  const mine = await adIk.get('/api/admin/hmo-network');
  assert.equal(mine.body[0].status, 'invited');
  const acc = await adIk.post('/api/admin/hmo-network/' + mine.body[0].id + '/accept');
  assert.equal(acc.status, 200);
  assert.ok(await h.db.col('hmo_panel').findOne({ orgId: ik.id, payerOrgId: h.ctx.orgs.hmo.id }), 'the HMO is now on the branch panel');
  const month = new Date(Date.now() + 3600e3).toISOString().slice(0, 7);
  const cap = await hmoM.get('/api/payer/capitation?month=' + month);
  const row = cap.body.rows.find(r => r.orgId === h.ctx.orgs.hospital.id);
  assert.ok(row && row.enrollees >= 2 && row.amountKobo === row.enrollees * row.rateKobo);
  const pay = await hmoM.post('/api/payer/capitation/pay', { month, orgId: h.ctx.orgs.hospital.id, reference: 'TRF-001' });
  assert.equal(pay.status, 200);
  assert.equal((await hmoM.post('/api/payer/capitation/pay', { month, orgId: h.ctx.orgs.hospital.id, reference: 'TRF-002' })).status, 409, 'once per month');
  const prov = await ownerG.get('/api/hmo/capitation');
  assert.ok(prov.body.payments.some(p => p.reference === 'TRF-001'));
});

test('member requests: patient asks, HMO answers in the app', async () => {
  const cov = (await tobi.get('/api/me/hmo/cards')).body.find(c => c.mine);
  const r = await tobi.post('/api/me/hmo/requests', { coverageId: cov.id, type: 'add_dependant', subject: 'Add my son', text: 'Please add my son Dayo, born 2020.' });
  assert.equal(r.status, 200);
  const list = await hmoM.get('/api/payer/requests?status=open');
  assert.ok(list.body.some(x => x.id === r.body.id && x.unread));
  const rep = await hmoM.post('/api/payer/requests/' + r.body.id + '/reply', { text: 'Send his birth certificate here and we will add him.' });
  assert.equal(rep.body.status, 'answered');
  const mine = await tobi.get('/api/me/hmo/requests');
  assert.ok(mine.body.find(x => x.id === r.body.id).messages.some(m => m.by === 'hmo'));
  // the HMO adds the dependant; he gets his own member number and card
  const dep = await hmoM.post('/api/payer/coverages/' + cov.id + '/dependants', { firstName: 'Dayo', lastName: 'Adeyemi', dob: '2020-03-01', sex: 'male', relation: 'child' });
  assert.equal(dep.status, 409, 'Harbor Silver has no dependants');
});
