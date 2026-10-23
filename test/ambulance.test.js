'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { boot } = require('./helpers');

let h, disp, crew, gvDisp;
const ip = n => ({ 'X-Forwarded-For': '10.9.' + n + '.1' });
before(async () => {
  h = await boot();
  disp = await h.as('dispatch', 'dispatch@swiftaid.demo');
  gvDisp = await h.as('dispatch', 'dispatch@grandville.demo');
});
after(async () => { await h.close(); });

async function units(c) { return (await c.get('/api/ambulance/units')).body; }
const byName = (list, s) => list.find(u => u.name.includes(s));

test('units are not dispatchable until a verified crew member is on shift', async () => {
  let us = await units(disp);
  assert.equal(byName(us, 'SwiftAid 1').dispatchable, false);
  assert.deepEqual(byName(us, 'SwiftAid 1').notReadyReasons, ['no_crew_on_shift']);
  assert.deepEqual(byName(us, 'Moto').notReadyReasons, ['no_crew']);
  assert.ok(byName(us, 'SwiftAid 1').compliance.insurance.expiringSoon, 'insurance within 90 days is flagged');
  crew = await h.as('crew', 'crew@swiftaid.demo');
  us = await units(disp);
  assert.equal(byName(us, 'SwiftAid 1').dispatchable, true);
  assert.equal(byName(us, 'SwiftAid 2').dispatchable, false);
  // another provider's dispatcher never sees SwiftAid units
  assert.ok(!(await units(gvDisp)).some(u => u.name.includes('SwiftAid')));
});

test('fleet: add a unit, crew profile edits need re-verification', async () => {
  const u = await disp.post('/api/ambulance/units', { name: 'SwiftAid 4', type: 'BLS', plate: 'abc-123-xy', registrationExpiry: '2020-01-01' });
  assert.equal(u.status, 200); assert.equal(u.body.plate, 'ABC-123-XY'); assert.ok(u.body.compliance.registration.expired);
  assert.equal((await disp.post('/api/ambulance/units', { name: 'X', type: 'tank', plate: 'Q' })).status, 400);
  const crewList = (await disp.get('/api/ambulance/crew')).body;
  const c2 = crewList.find(c => c.name === 'Aisha Lawal');
  assert.equal(c2.profile.verified, true);
  const put = await disp.req('PUT', '/api/ambulance/crew/' + c2.membershipId, { certification: 'EMT-B', licenceNo: 'NEW-1', licenceExpiry: '2030-01-01' });
  assert.equal(put.body.verified, false);
  const v = await disp.post('/api/ambulance/crew/' + c2.membershipId + '/verify', { verified: true });
  assert.equal(v.status, 200); assert.equal(v.body.verified, true);
  // unknown membership from another provider
  const gvCrew = (await gvDisp.get('/api/ambulance/crew')).body[0];
  assert.equal((await disp.req('PUT', '/api/ambulance/crew/' + gvCrew.membershipId, { certification: 'EMT-B', licenceNo: 'x', licenceExpiry: '2030-01-01' })).status, 404);
  // crew of another provider cannot be put on a SwiftAid unit
  assert.equal((await disp.patch('/api/ambulance/units/' + u.body.id, { crewMembershipIds: [gvCrew.membershipId] })).status, 400);
});

test('public emergency: validation, unverified flag, rate limits', async () => {
  const pub = h.client('patient');
  assert.equal((await pub.post('/api/emergency', { name: 'A', lat: 6.6, lng: 3.35, category: 'burns' }, ip(1))).status, 400, 'phone required');
  assert.equal((await pub.post('/api/emergency', { name: 'A', phone: '12345', lat: 6.6, lng: 3.35, category: 'burns' }, ip(1))).status, 400, 'bad phone');
  assert.equal((await pub.post('/api/emergency', { name: 'A', phone: '08031110000', lat: 51.5, lng: -0.1, category: 'burns' }, ip(1))).status, 400, 'outside Nigeria');
  assert.equal((await pub.post('/api/emergency', { name: 'A', phone: '08031110000', lat: 6.6, lng: 3.35, category: 'alien' }, ip(1))).status, 400, 'bad category');
  // no app header -> CSRF guard
  const raw = await fetch(h.base + '/api/emergency', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(raw.status, 403);
  const ok = await pub.post('/api/emergency', { name: 'Chinedu Okoro', phone: '0803 111 0000', lat: 6.6050, lng: 3.3500, address: 'Toyin St', category: 'burns' }, ip(1));
  assert.equal(ok.status, 200); assert.ok(ok.body.trackToken); assert.equal(ok.body.provider.name, 'SwiftAid Ambulance');
  // the per-IP limit (RL.limitIp, process.emergency.publicPerIpPerHour) is lifted under tests; the per-phone limit is not
  // per phone: the same phone from other networks gets the existing case, then is limited
  const again = await pub.post('/api/emergency', { name: 'Chinedu', phone: '+2348031110000', lat: 6.6, lng: 3.35, category: 'burns' }, ip(2));
  assert.equal(again.body.existing, true); assert.equal(again.body.incidentId, ok.body.incidentId);
  await pub.post('/api/emergency', { name: 'Chinedu', phone: '+2348031110000', lat: 6.6, lng: 3.35, category: 'burns' }, ip(3));
  assert.equal((await pub.post('/api/emergency', { name: 'Chinedu', phone: '+2348031110000', lat: 6.6, lng: 3.35, category: 'burns' }, ip(4))).status, 429);
  const board = (await disp.get('/api/dispatch/board')).body;
  const inc = board.incidents.find(i => i.id === ok.body.incidentId);
  assert.equal(inc.verified, false); assert.equal(inc.flags.unverified, true); assert.equal(inc.caller.phone, '+2348031110000');
  assert.equal(inc.triage.priority, 'P2'); assert.ok(!('publicTokenHash' in inc));
  const st = await pub.get('/api/emergency/' + inc.id + '/status?token=' + ok.body.trackToken);
  assert.equal(st.status, 200); assert.equal(st.body.status, 'new');
  assert.equal((await pub.get('/api/emergency/' + inc.id + '/status?token=wrong')).status, 404);
  const v = await disp.post('/api/dispatch/incidents/' + inc.id + '/verify'); assert.equal(v.body.verified, true);
  assert.equal((await disp.post('/api/dispatch/incidents/' + inc.id + '/verify')).status, 409, 'verify once');
  assert.equal((await disp.post('/api/dispatch/incidents/' + inc.id + '/cancel', { reason: 'Duplicate of call' })).status, 200);
});

test('public emergency line can be switched off from HQ settings', async () => {
  const S = require('../src/lib/settings');
  await S.saveSection('features', { publicEmergency: false }, { by: 'test' });
  const r = await h.client('patient').post('/api/emergency', { name: 'Off', phone: '08031119999', lat: 6.6, lng: 3.35, category: 'burns' }, ip(9));
  assert.equal(r.status, 404);
  await S.saveSection('features', { publicEmergency: true }, { by: 'test' });
});

test('SOS goes to the nearest provider with an available dispatchable unit', async () => {
  const amaka = await h.as('patient', 'amaka@patient.demo'); // Surulere: Grandville is next door but has no crew on shift
  const r = await amaka.post('/api/me/emergency', { lat: 6.4966, lng: 3.3512, category: 'breathing_difficulty' });
  assert.equal(r.status, 200); assert.equal(r.body.provider.name, 'SwiftAid Ambulance'); assert.equal(r.body.priority, 'P1');
  const dup = await amaka.post('/api/me/emergency', { lat: 6.4966, lng: 3.3512, category: 'breathing_difficulty' });
  assert.equal(dup.body.existing, true); assert.equal(dup.body.id, r.body.id);
  // the provider gets this patient's allergies and blood group for this incident
  const d = await disp.get('/api/dispatch/incidents/' + r.body.id);
  assert.equal(d.body.patientInfo.bloodGroup, 'O+'); assert.equal(d.body.patientInfo.allergies[0].substance, 'Penicillin');
  assert.ok(await h.db.col('patient_links').findOne({ orgId: h.ctx.orgs.ambulance.id, patientId: h.ctx.patients.amaka.id }), 'patient linked to the provider');
  assert.equal((await amaka.post('/api/me/emergency/' + r.body.id + '/cancel', {})).status, 200);
  assert.equal((await amaka.post('/api/me/emergency/' + r.body.id + '/cancel', {})).status, 409, 'cancel once');

  await h.as('crew', 'crew@grandville.demo'); // Grandville crew clocks in
  const tobi = await h.as('patient', 'tobi@patient.demo'); // Yaba: Grandville (about 2 km) is nearer than SwiftAid
  const r2 = await tobi.post('/api/me/emergency', { lat: 6.5070, lng: 3.3750, category: 'seizure' });
  assert.equal(r2.body.provider.name, 'Grandville Hospital');
  assert.equal((await disp.get('/api/dispatch/incidents/' + r2.body.id)).status, 404, 'SwiftAid cannot open a Grandville incident');
  assert.equal((await gvDisp.get('/api/dispatch/incidents/' + r2.body.id)).status, 200);
  assert.equal((await tobi.get('/api/me/emergency/active')).body.incident.id, r2.body.id);
  assert.equal((await amaka.get('/api/me/emergency/' + r2.body.id)).status, 404, 'another patient cannot track it');
  // a named provider must run ambulance
  assert.equal((await tobi.post('/api/me/emergency/' + r2.body.id + '/cancel', {})).status, 200);
  assert.equal((await tobi.post('/api/me/emergency', { lat: 6.5, lng: 3.37, category: 'other', providerOrgId: h.ctx.orgs.clinic.id })).status, 404);
  assert.equal((await tobi.post('/api/me/emergency', { lat: 60, lng: 3.37, category: 'other' })).status, 400);
});

test('two dispatchers cannot assign the same unit; wrong role is refused', async () => {
  const unitId = byName(await units(disp), 'SwiftAid 1').id;
  const a = await disp.post('/api/dispatch/incidents', { caller: { name: 'Caller A', phone: '08030001111' }, location: { lat: 6.60, lng: 3.35, address: 'Ikeja GRA' }, category: 'unconscious' });
  const b = await disp.post('/api/dispatch/incidents', { caller: { name: 'Caller B', phone: '08030002222' }, location: { lat: 6.61, lng: 3.36 }, category: 'other', priority: 'P2' });
  assert.equal(a.status, 200); assert.equal(b.body.triage.overridden, true);
  const disp2 = await h.as('dispatch', 'dispatch@swiftaid.demo', { clockIn: false });
  const [x, y] = await Promise.all([disp.post('/api/dispatch/incidents/' + a.body.id + '/assign', { unitId }), disp2.post('/api/dispatch/incidents/' + b.body.id + '/assign', { unitId })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  const loser = x.status === 200 ? b.body.id : a.body.id;
  const bls = byName(await units(disp), 'SwiftAid 2').id; // crew2 not on shift
  const r = await disp.post('/api/dispatch/incidents/' + loser + '/assign', { unitId: bls });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'not_dispatchable');
  const gvUnit = (await units(gvDisp))[0].id;
  assert.equal((await disp.post('/api/dispatch/incidents/' + loser + '/assign', { unitId: gvUnit })).status, 404, 'other provider unit');
  const desk = await h.as('frontdesk', 'callcentre@swiftaid.demo');
  assert.equal((await desk.post('/api/dispatch/incidents/' + loser + '/assign', { unitId })).status, 403);
  // a unit on a job cannot be taken off the road
  assert.equal((await disp.patch('/api/ambulance/units/' + unitId, { status: 'maintenance' })).status, 409);
  for (const i of [a.body.id, b.body.id]) assert.equal((await disp.post('/api/dispatch/incidents/' + i + '/cancel', { reason: 'Test clean-up' })).status, 200);
  assert.equal(byName(await units(disp), 'SwiftAid 1').availability, 'available');
});

test('full case: assign, crew GPS, destination pre-alert, transport, close once, bill once', async () => {
  const kunle = await h.as('patient', 'kunle@patient.demo');
  const sos = await kunle.post('/api/me/emergency', { lat: 6.4520, lng: 3.4350, category: 'stroke_symptoms', providerOrgId: h.ctx.orgs.ambulance.id, note: 'Face drooping' });
  assert.equal(sos.status, 200); assert.equal(sos.body.provider.name, 'SwiftAid Ambulance');
  const incId = sos.body.id;
  const sug = (await disp.get('/api/dispatch/incidents/' + incId + '/suggest')).body;
  assert.equal(sug[0].dispatchable, true); assert.ok(sug[0].etaMinutes > 0); assert.ok(sug[0].distanceKm > 0);
  const as = await disp.post('/api/dispatch/incidents/' + incId + '/assign', { unitId: sug[0].id });
  assert.equal(as.status, 200); assert.equal(as.body.status, 'assigned');
  assert.equal((await disp.post('/api/dispatch/incidents/' + incId + '/assign', { unitId: sug[0].id })).status, 409, 'assign once');

  const me = (await crew.get('/api/crew/me')).body;
  assert.equal(me.incident.id, incId); assert.equal(me.incident.patientInfo.firstName, 'Kunle');
  // crew of another provider cannot touch it
  const gvCrew = await h.as('crew', 'crew@grandville.demo', { clockIn: false });
  assert.equal((await gvCrew.post('/api/crew/incidents/' + incId + '/status', { status: 'enroute' })).status, 404);
  assert.equal((await crew.post('/api/crew/incidents/' + incId + '/status', { status: 'onscene' })).status, 409, 'cannot skip en route');
  const [e1, e2] = await Promise.all([crew.post('/api/crew/incidents/' + incId + '/status', { status: 'enroute' }), crew.post('/api/crew/incidents/' + incId + '/status', { status: 'enroute' })]);
  assert.deepEqual([e1.status, e2.status].sort(), [200, 409]);
  const l1 = await crew.post('/api/crew/location', { lat: 6.50, lng: 3.40, accuracy: 12, speed: 14, heading: 120 });
  const l2 = await crew.post('/api/crew/location', { lat: 6.49, lng: 3.41 });
  assert.equal(l1.body.tracked, true); assert.equal(l2.body.tracked, false, 'one track point per 10 s');
  assert.equal((await crew.post('/api/crew/location', { lat: 'x', lng: 3 })).status, 400);
  const track = await kunle.get('/api/me/emergency/' + incId);
  assert.equal(track.body.status, 'enroute'); assert.equal(track.body.unit.plate, 'LND-482-KJ'); assert.ok(track.body.unitLoc); assert.ok(track.body.etaMinutes > 0); assert.equal(track.body.etaTarget, 'you');
  assert.ok(!('patientInfo' in track.body) && !('care' in track.body));

  assert.equal((await crew.post('/api/crew/incidents/' + incId + '/status', { status: 'onscene' })).status, 200);
  assert.equal((await kunle.post('/api/me/emergency/' + incId + '/cancel', {})).status, 409, 'patient cannot cancel once the crew is on scene');
  assert.equal((await crew.post('/api/crew/incidents/' + incId + '/care', { vitals: { bpSys: 190, bpDia: 110, pulse: 96, spo2: 97, gcs: 14 }, interventions: ['FAST assessment'], handoverNote: 'Left-sided weakness from 07:40' })).status, 200);
  assert.equal((await crew.post('/api/crew/incidents/' + incId + '/status', { status: 'transporting' })).status, 400, 'destination needed');
  const dests = (await disp.get('/api/dispatch/destinations?lat=6.452&lng=3.435')).body;
  assert.ok(dests.some(d => d.name === 'Grandville Hospital')); assert.ok(!dests.some(d => d.name === 'ClearPath Diagnostics'));
  assert.equal((await disp.post('/api/dispatch/incidents/' + incId + '/destination', { orgId: h.ctx.orgs.lab.id })).status, 404, 'a lab is not a receiving hospital');
  assert.equal((await disp.post('/api/dispatch/incidents/' + incId + '/destination', { orgId: h.ctx.orgs.hospital.id })).status, 200);
  const fd = await h.as('frontdesk', 'reception@grandville.demo');
  const notes = (await fd.get('/api/notifications')).body;
  assert.ok(notes.some(n => n.kind === 'ambulance_incoming' && n.ref.id === incId));
  const inc1 = (await fd.get('/api/fd/incoming')).body.find(i => i.incidentId === incId);
  assert.equal(inc1.patient.firstName, 'Kunle'); assert.equal(inc1.priority, 'P1'); assert.ok(!('lastName' in inc1.patient) && !('phone' in inc1.patient));
  assert.equal((await (await h.as('frontdesk', 'reception@lekkifamily.demo')).get('/api/fd/incoming')).body.length, 0);

  assert.equal((await crew.post('/api/crew/incidents/' + incId + '/status', { status: 'transporting' })).status, 200);
  assert.ok((await fd.get('/api/fd/incoming')).body.find(i => i.incidentId === incId).etaMinutes > 0);
  assert.equal((await crew.post('/api/crew/incidents/' + incId + '/status', { status: 'athospital' })).status, 200);
  const [c1, c2] = await Promise.all([crew.post('/api/crew/incidents/' + incId + '/status', { status: 'clear' }), crew.post('/api/crew/incidents/' + incId + '/status', { status: 'clear' })]);
  assert.deepEqual([c1.status, c2.status].sort(), [200, 409]);
  assert.equal((await disp.post('/api/dispatch/incidents/' + incId + '/close', {})).status, 409);
  const bills = await h.db.col('bills').find({ 'source.type': 'incident', 'source.id': incId });
  assert.equal(bills.length, 1, 'exactly one bill');
  assert.deepEqual(bills[0].lines.map(l => l.code), ['AMB-ALS', 'AMB-KM', 'MC-EMERG']);
  assert.equal(bills[0].lines[2].unitPriceKobo, 150000); assert.equal(bills[0].lines[2].platform, true);
  assert.equal(bills[0].orgId, h.ctx.orgs.ambulance.id);
  const fin = (await kunle.get('/api/me/emergency/' + incId)).body;
  assert.equal(fin.status, 'closed'); assert.deepEqual(fin.timeline.map(x => x.status), ['new', 'assigned', 'enroute', 'onscene', 'transporting', 'athospital', 'closed']);
  assert.equal((await kunle.get('/api/me/emergency/active')).body.incident, null);
  assert.equal(byName(await units(disp), 'SwiftAid 1').availability, 'available');
  assert.equal((await fd.get('/api/fd/incoming')).body.filter(i => i.incidentId === incId).length, 0);
});

test('SOS is open to any patient: any service nearby, no subscription, no prior registration, always billed', async () => {
  const ngozi = await h.as('patient', 'ngozi@patient.demo');
  const pid = (await h.db.col('users').findOne({ email: 'ngozi@patient.demo' })).patientId;
  await h.db.col('patient_links').deleteMany({ patientId: pid, orgId: h.ctx.orgs.ambulance.id });
  await h.db.col('market_subs').deleteMany({ patientId: pid });
  // options list every ambulance service near her, any institute, free ones first
  const opt = await ngozi.get('/api/me/emergency/options?lat=6.5966&lng=3.3421');
  assert.equal(opt.status, 200); assert.equal(opt.body.choose, true); assert.equal(opt.body.bookingFeeKobo, 150000);
  const sw = opt.body.options.find(o => o.name === 'SwiftAid Ambulance');
  assert.ok(sw && sw.availableUnits >= 1 && sw.registered === false);
  assert.equal((await ngozi.get('/api/me/emergency/options?lat=51.5&lng=-0.1')).status, 400);
  // the service set no prices: the HQ fallback tariff still bills the trip
  await h.db.col('services').updateMany({ orgId: h.ctx.orgs.ambulance.id, category: 'ambulance' }, { $set: { active: false } });
  const sos = await ngozi.post('/api/me/emergency', { lat: 6.5966, lng: 3.3421, category: 'bleeding', providerOrgId: h.ctx.orgs.ambulance.id });
  assert.equal(sos.status, 200); assert.equal(sos.body.provider.name, 'SwiftAid Ambulance');
  const link = await h.db.col('patient_links').findOne({ patientId: pid, orgId: h.ctx.orgs.ambulance.id });
  assert.equal(link.via, 'emergency', 'added to the service by the SOS itself');
  const unit = (await disp.get('/api/dispatch/incidents/' + sos.body.id + '/suggest')).body[0];
  await disp.post('/api/dispatch/incidents/' + sos.body.id + '/assign', { unitId: unit.id });
  for (const st of ['enroute', 'onscene']) assert.equal((await crew.post('/api/crew/incidents/' + sos.body.id + '/status', { status: st })).status, 200);
  await disp.post('/api/dispatch/incidents/' + sos.body.id + '/destination', { orgId: h.ctx.orgs.hospital.id });
  for (const st of ['transporting', 'athospital', 'clear']) assert.equal((await crew.post('/api/crew/incidents/' + sos.body.id + '/status', { status: st })).status, 200);
  const bill = await h.db.col('bills').findOne({ 'source.type': 'incident', 'source.id': sos.body.id });
  assert.ok(bill, 'billed even without a price list'); assert.equal(bill.patientId, pid); assert.equal(bill.orgId, h.ctx.orgs.ambulance.id);
  assert.equal(bill.lines[0].unitPriceKobo, unit.type === 'ALS' ? 5500000 : 3000000);
  assert.ok(bill.lines.some(l => l.code === 'MC-EMERG'));
  await h.db.col('services').updateMany({ orgId: h.ctx.orgs.ambulance.id, category: 'ambulance' }, { $set: { active: true } });
});

test('response metrics for admins', async () => {
  const owner = await h.as('admin', 'owner@swiftaid.demo');
  const m = await owner.get('/api/ambulance/metrics');
  assert.equal(m.status, 200);
  assert.ok(m.body.byPriority.all.newToAssigned.n >= 2);
  assert.ok(m.body.byPriority.P1.assignedToOnscene.n >= 1);
  assert.equal(m.body.byPriority.P2.assignedToOnscene.p90Min, 9, 'seeded case: 9 minutes assigned to on scene');
  assert.equal((await crew.get('/api/ambulance/metrics')).status, 403);
});

test('demo drive exists only in DEMO_MODE and moves one step per call', async () => {
  const pt = await h.as('patient', 'amaka@patient.demo');
  const sos = await pt.post('/api/me/emergency', { lat: 6.5800, lng: 3.3600, category: 'other', providerOrgId: h.ctx.orgs.ambulance.id });
  await disp.post('/api/dispatch/incidents/' + sos.body.id + '/assign', { unitId: byName(await units(disp), 'SwiftAid 1').id });
  const before = (await crew.get('/api/crew/me')).body.unit.lastLoc;
  const d = await crew.post('/api/crew/demo-drive', { incidentId: sos.body.id });
  assert.equal(d.status, 200); assert.ok(d.body.loc.lat !== before.lat);
  const src = path.join(__dirname, '..', 'src', 'modules', 'ambulance.js');
  const out = execFileSync(process.execPath, ['-e', `const m=require(${JSON.stringify(src)});console.log(m.router.stack.some(l=>l.route&&l.route.path==='/crew/demo-drive'))`], { env: Object.assign({}, process.env, { DEMO_MODE: '0' }) }).toString().trim();
  assert.equal(out, 'false');
});
