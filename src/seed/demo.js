'use strict';
/*
 * Demo data, loaded ONLY when DEMO_MODE=1 (never in production).
 * Shows every package working on its own:
 *   Grandville Hospital    full hospital: clinic, pharmacy+delivery, ambulance, lab, CHW
 *   Lekki Family Clinic    clinic only (no pharmacy, no lab, no ambulance)
 *   Yaba Care Pharmacy     standalone pharmacy with its own dispatcher and riders
 *   SwiftAid Ambulance     standalone ambulance service with dispatcher and crew
 *   ClearPath Diagnostics  standalone laboratory
 *   Harbor Health HMO      an HMO (payer)
 *   Crestview Hospitals    a hospital GROUP with two branches (Ikeja, Ajah): group console + branch admins
 * Network: Yaba Care Pharmacy and Grandville Hospital are partners and have an open referral;
 * Lekki Family Clinic and ClearPath Diagnostics are partners; ClearPath has asked Crestview Ikeja to partner.
 * All names are fictional. All demo passwords are DEMO_PASSWORD below.
 */
const db = require('../db');
const A = require('../lib/auth');
const { id, now, naira } = require('../lib/util');

const DEMO_PASSWORD = 'Demo2026!';

const ORGS = {
  hospital: { type: 'hospital', name: 'Grandville Hospital', modules: ['frontdesk', 'clinic', 'pharmacy', 'delivery', 'ambulance', 'lab', 'hmo', 'chw'], location: { lat: 6.4990, lng: 3.3540, area: 'Surulere', city: 'Lagos', state: 'Lagos' }, contact: { phone: '+2348030000001', email: 'info@grandville.demo', address: '12 Adeniran Ogunsanya St, Surulere' } },
  clinic: { type: 'clinic', name: 'Lekki Family Clinic', modules: ['frontdesk', 'clinic', 'hmo'], location: { lat: 6.4474, lng: 3.4723, area: 'Lekki Phase 1', city: 'Lagos', state: 'Lagos' }, contact: { phone: '+2348030000002', email: 'hello@lekkifamily.demo', address: '5 Admiralty Way, Lekki' } },
  pharmacy: { type: 'pharmacy', name: 'Yaba Care Pharmacy', modules: ['frontdesk', 'pharmacy', 'delivery', 'hmo'], location: { lat: 6.5095, lng: 3.3711, area: 'Yaba', city: 'Lagos', state: 'Lagos' }, contact: { phone: '+2348030000003', email: 'rx@yabacare.demo', address: '40 Herbert Macaulay Way, Yaba' } },
  ambulance: { type: 'ambulance', name: 'SwiftAid Ambulance', modules: ['frontdesk', 'ambulance', 'hmo'], location: { lat: 6.6018, lng: 3.3515, area: 'Ikeja', city: 'Lagos', state: 'Lagos' }, contact: { phone: '+2348030000004', email: 'ops@swiftaid.demo', address: '3 Obafemi Awolowo Way, Ikeja' } },
  lab: { type: 'lab', name: 'ClearPath Diagnostics', modules: ['frontdesk', 'lab', 'hmo'], location: { lat: 6.4541, lng: 3.4316, area: 'Ikoyi', city: 'Lagos', state: 'Lagos' }, contact: { phone: '+2348030000005', email: 'lab@clearpath.demo', address: '18 Awolowo Rd, Ikoyi' } },
  hmo: { type: 'hmo', name: 'Harbor Health HMO', modules: ['payer'], location: { lat: 6.4300, lng: 3.4200, area: 'Victoria Island', city: 'Lagos', state: 'Lagos' }, contact: { phone: '+2348030000006', email: 'care@harborhmo.demo', address: '1 Adeola Odeku St, VI' } },
};

/* staff per provider: [key, role, name] -> email key@<org>.demo */
const STAFF = {
  hospital: [['reception', 'receptionist', 'Ada Umeh'], ['cashier', 'cashier', 'Bola Ade'], ['nurse', 'nurse', 'Ngozi Okafor'], ['fdmanager', 'frontdesk_manager', 'Kemi Bello'],
    ['dr.tunde', 'doctor', 'Dr. Tunde Bello'], ['dr.bisi', 'doctor', 'Dr. Bisi Adewale'], ['pharmacist', 'pharmacist', 'Pharm. Chika Obi'], ['dispatch.rx', 'delivery_dispatcher', 'Sade Lawal'],
    ['rider', 'rider', 'Chidi Eze'], ['dispatch', 'ambulance_dispatcher', 'Femi Ojo'], ['crew', 'crew', 'Emeka Nwosu'], ['lab', 'lab_scientist', 'Halima Musa'], ['lab2', 'lab_scientist', 'Yusuf Bello'], ['chw', 'chw', 'Grace Umeh'], ['admin', 'admin', 'Tola Hassan']],
  clinic: [['reception', 'receptionist', 'Ifeoma Nnaji'], ['cashier', 'cashier', 'Dayo Ogun'], ['dr.ada', 'doctor', 'Dr. Ada Nwosu']],
  pharmacy: [['counter', 'cashier', 'Rita James'], ['pharmacist', 'pharmacist', 'Pharm. Musa Ibrahim'], ['dispatch', 'delivery_dispatcher', 'Joy Okon'], ['rider', 'rider', 'Sam Udo'], ['rider2', 'rider', 'Ken Ali']],
  ambulance: [['callcentre', 'receptionist', 'Mary Etim'], ['dispatch', 'ambulance_dispatcher', 'Lanre Shittu'], ['crew', 'crew', 'Paul Okeke'], ['crew2', 'crew', 'Aisha Lawal']],
  lab: [['reception', 'lab_reception', 'Joke Ade'], ['scientist', 'lab_scientist', 'Dr. Femi Cole'], ['manager', 'lab_manager', 'Funke Ojo'], ['cashier', 'cashier', 'Tobi Ayo']],
  hmo: [['officer', 'payer_officer', 'Uche Obi']],
};
const DOMAIN = { hospital: 'grandville.demo', clinic: 'lekkifamily.demo', pharmacy: 'yabacare.demo', ambulance: 'swiftaid.demo', lab: 'clearpath.demo', hmo: 'harborhmo.demo' };

const SERVICES = {
  hospital: [['REG', 'Registration card', 'registration', 2000], ['CONS-GP', 'GP consultation', 'consultation', 8000], ['CONS-SPEC', 'Specialist consultation', 'consultation', 15000], ['VIDEO-GP', 'Video consultation', 'video', 6000], ['AMB-CALL', 'Ambulance call-out', 'ambulance', 25000], ['AMB-KM', 'Ambulance per km', 'ambulance', 500], ['DELIV', 'Medication delivery', 'delivery', 1500], ['INJ', 'Injection administration', 'procedure', 1500]],
  clinic: [['REG', 'Registration', 'registration', 3000], ['CONS-GP', 'Family doctor consultation', 'consultation', 10000], ['VIDEO-GP', 'Video consultation', 'video', 7000]],
  pharmacy: [['DELIV', 'Home delivery', 'delivery', 1500], ['COUNSEL', 'Pharmacist consultation', 'consultation', 2000]],
  ambulance: [['AMB-CALL', 'Emergency call-out (BLS)', 'ambulance', 30000], ['AMB-ALS', 'Advanced life support call-out', 'ambulance', 55000], ['AMB-KM', 'Per km transported', 'ambulance', 600], ['AMB-TRANSFER', 'Inter-facility transfer', 'ambulance', 40000]],
  lab: [['SAMPLE-HOME', 'Home sample collection', 'delivery', 3000]],
  hmo: [],
};

const PATIENTS = [
  { key: 'amaka', firstName: 'Amaka', lastName: 'Eze', dob: '1991-04-12', sex: 'female', phone: '+2348031234567', email: 'amaka@patient.demo', address: '15 Adeniran Ogunsanya St, Surulere', homeLoc: { lat: 6.4966, lng: 3.3512 }, bloodGroup: 'O+', genotype: 'AA', weightKg: 64, allergies: [{ substance: 'Penicillin', class: 'penicillin', reaction: 'Rash and swelling', severity: 'severe', source: 'staff' }], conditions: [{ name: 'Hypertension', code: 'I10' }], account: true, links: ['hospital', 'clinic', 'pharmacy', 'lab'], cover: true },
  { key: 'tobi', firstName: 'Tobi', lastName: 'Adeyemi', dob: '1985-09-30', sex: 'male', phone: '+2348039876543', email: 'tobi@patient.demo', address: '22 Herbert Macaulay Way, Yaba', homeLoc: { lat: 6.5070, lng: 3.3750 }, bloodGroup: 'A+', genotype: 'AS', weightKg: 82, allergies: [], noKnownAllergies: true, conditions: [{ name: 'Type 2 diabetes', code: 'E11' }], account: true, links: ['hospital', 'pharmacy'], cover: true },
  { key: 'zainab', firstName: 'Zainab', lastName: 'Bello', dob: '2019-02-14', sex: 'female', phone: '+2348025550101', address: '4 Allen Avenue, Ikeja', homeLoc: { lat: 6.6010, lng: 3.3550 }, bloodGroup: 'B+', genotype: 'AA', weightKg: 19, allergies: [{ substance: 'Sulfa drugs', class: 'sulfonamide', reaction: 'Hives', severity: 'moderate', source: 'staff' }], account: false, links: ['hospital', 'ambulance'] },
  { key: 'kunle', firstName: 'Kunle', lastName: 'Martins', dob: '1958-11-03', sex: 'male', phone: '+2348077770202', email: 'kunle@patient.demo', address: '9 Bourdillon Rd, Ikoyi', homeLoc: { lat: 6.4520, lng: 3.4350 }, bloodGroup: 'O-', genotype: 'AA', weightKg: 90, allergies: [], noKnownAllergies: true, conditions: [{ name: 'Atrial fibrillation', code: 'I48' }], meds: ['WARF5'], account: true, links: ['clinic', 'lab'] },
];

async function mkUser({ name, email, phone, patientId, platformRole }) {
  const u = { id: id('usr'), name, passHash: await A.hashPassword(DEMO_PASSWORD), status: 'active', mustChangePassword: false, createdAt: now(), demo: true };
  if (email) u.email = email; if (phone) u.phone = phone; if (patientId) u.patientId = patientId; if (platformRole) u.platformRole = platformRole;
  await db.col('users').insertOne(u); return u;
}

async function load() {
  const orgsMod = require('../modules/orgs');
  const P = require('../modules/patients');
  await orgsMod.ensurePlans();
  const ctx = { orgs: {}, staff: {}, users: {}, patients: {}, password: DEMO_PASSWORD, now: now(), naira };

  // platform team
  ctx.users.hq = await mkUser({ name: 'MediCore HQ (demo)', email: 'hq@medicore.demo', platformRole: 'platform_owner' });
  ctx.users.dev = await mkUser({ name: 'MediCore Developer (demo)', email: 'dev@medicore.demo', platformRole: 'developer' });

  for (const [k, spec] of Object.entries(ORGS)) {
    const { org } = await orgsMod.createOrg(Object.assign({}, spec, { status: 'active', seats: 60, owner: { name: spec.name + ' Owner', email: 'owner@' + DOMAIN[k], password: DEMO_PASSWORD } }));
    await db.col('users').updateOne({ email: 'owner@' + DOMAIN[k] }, { $set: { demo: true } });
    await db.col('orgs').updateOne({ id: org.id }, { $set: { modules: spec.modules, 'plan.status': 'active', demo: true } });
    ctx.orgs[k] = Object.assign(org, { modules: spec.modules });
    ctx.staff[k] = {};
    for (const [key, role, name] of STAFF[k]) {
      const u = await mkUser({ name, email: key + '@' + DOMAIN[k] });
      const m = { id: id('mem'), userId: u.id, orgId: org.id, role, extraPerms: [], removedPerms: [], status: 'active', isOwner: false, createdAt: now(), createdBy: 'demo' };
      await db.col('memberships').insertOne(m);
      ctx.staff[k][key] = { user: u, membership: m };
    }
    for (const [code, name, category, price] of SERVICES[k]) await db.col('services').insertOne({ id: id('svc'), orgId: org.id, code, name, category, priceKobo: naira(price), active: true, public: true, createdAt: now() });
  }
  // a doctor who also does sessions at the clinic (one person, two providers)
  await db.col('memberships').insertOne({ id: id('mem'), userId: ctx.staff.hospital['dr.bisi'].user.id, orgId: ctx.orgs.clinic.id, role: 'doctor', extraPerms: [], removedPerms: [], status: 'active', isOwner: false, createdAt: now(), createdBy: 'demo' });

  for (const p of PATIENTS) {
    const doc = { id: id('pat'), firstName: p.firstName, lastName: p.lastName, dob: p.dob, sex: p.sex, phone: p.phone, phoneVerified: true, email: p.email || null, address: p.address, homeLoc: p.homeLoc, bloodGroup: p.bloodGroup, genotype: p.genotype, weightKg: p.weightKg,
      allergies: (p.allergies || []).map(a => Object.assign({ at: now() }, a)), noKnownAllergies: !!p.noKnownAllergies, conditions: (p.conditions || []).map(c => Object.assign({ at: now() }, c)), status: 'active', createdAt: now(), createdVia: 'demo', userId: null,
      consent: { version: '2026-10', accepted: true, at: now(), channel: 'demo' } };
    await db.col('patients').insertOne(doc);
    if (p.account) { const u = await mkUser({ name: p.firstName + ' ' + p.lastName, email: p.email, phone: p.phone, patientId: doc.id }); await db.col('patients').updateOne({ id: doc.id }, { $set: { userId: u.id } }); ctx.users[p.key] = u; }
    for (const ok of p.links) await P.ensureLink(ctx.orgs[ok].id, doc.id, 'demo', 'demo');
    ctx.patients[p.key] = Object.assign(doc, { meds: p.meds || [], cover: !!p.cover });
  }
  // Amaka shares her history with the hospital, not with the others
  await db.col('patient_links').updateOne({ patientId: ctx.patients.amaka.id, orgId: ctx.orgs.hospital.id }, { $set: { shareHistory: true } });

  // each service module adds its own demo records
  for (const m of require('../modules')) if (typeof m.seedDemo === 'function') { try { await m.seedDemo(ctx); } catch (e) { console.error('[demo] seed failed in', m.name, e.message); throw e; } }
  await seedGroupAndNetwork(ctx);
  await db.col('meta').findOneAndUpdate({ id: 'demo' }, { $set: { id: 'demo', at: now() } }, { upsert: true });
  return ctx;
}

/* ---- a hospital group with two branches, and the provider network ---- */
const GROUP = { name: 'Crestview Hospitals', domain: 'crestview.demo', branches: [
  { key: 'ikeja', branchName: 'Ikeja', location: { lat: 6.6000, lng: 3.3500, area: 'Ikeja GRA', city: 'Lagos', state: 'Lagos' }, contact: { phone: '+2348030000011', email: 'ikeja@crestview.demo', address: '7 Joel Ogunnaike St, Ikeja GRA' },
    staff: [['admin.ikeja', 'admin', 'Bayo Akin'], ['reception.ikeja', 'receptionist', 'Funmi Ade'], ['dr.kola', 'doctor', 'Dr. Kola Ajayi'], ['pharmacist.ikeja', 'pharmacist', 'Pharm. Rose Eke']] },
  { key: 'ajah', branchName: 'Ajah', location: { lat: 6.4698, lng: 3.5852, area: 'Ajah', city: 'Lagos', state: 'Lagos' }, contact: { phone: '+2348030000012', email: 'ajah@crestview.demo', address: '2 Addo Rd, Ajah' },
    staff: [['admin.ajah', 'admin', 'Nneka Obi'], ['reception.ajah', 'receptionist', 'Seyi Bankole'], ['dr.ifeanyi', 'doctor', 'Dr. Ifeanyi Okoro'], ['lab.ajah', 'lab_manager', 'Hauwa Sani']] },
] };
async function seedGroupAndNetwork(ctx) {
  const orgsMod = require('../modules/orgs'); const groups = require('../modules/groups'); const P = require('../modules/patients');
  const owner = await mkUser({ name: 'Crestview Group Owner', email: 'owner@' + GROUP.domain });
  const g = await groups.createGroup({ name: GROUP.name, ownerUserId: owner.id, status: 'active', contact: { phone: '+2348030000010', email: 'hq@crestview.demo', address: '7 Joel Ogunnaike St, Ikeja GRA' }, createdBy: 'demo' });
  await db.col('groups').updateOne({ id: g.id }, { $set: { demo: true } });
  const ops = await mkUser({ name: 'Crestview Operations', email: 'ops@' + GROUP.domain });
  await db.col('group_members').insertOne({ id: id('gm'), userId: ops.id, groupId: g.id, role: 'group_admin', isOwner: false, status: 'active', createdAt: now(), createdBy: 'demo' });
  ctx.group = g; ctx.branches = {};
  for (const b of GROUP.branches) {
    const { org } = await orgsMod.createOrg({ type: 'hospital', name: GROUP.name + ' - ' + b.branchName, modules: ['frontdesk', 'clinic', 'pharmacy', 'lab', 'hmo'], contact: b.contact, location: b.location, status: 'active', seats: 40, owner: { name: owner.name, email: owner.email } });
    await db.col('orgs').updateOne({ id: org.id }, { $set: { groupId: g.id, branchName: b.branchName, mrnPrefix: g.mrnPrefix, demo: true, 'plan.status': 'active' } });
    ctx.branches[b.key] = Object.assign(org, { groupId: g.id });
    for (const [key, role, name] of b.staff) {
      const u = await mkUser({ name, email: key + '@' + GROUP.domain });
      const mem = { id: id('mem'), userId: u.id, orgId: org.id, role, extraPerms: [], removedPerms: [], status: 'active', isOwner: false, createdAt: now(), createdBy: 'demo' };
      await db.col('memberships').insertOne(mem);
      if (role === 'doctor') await db.col('schedules').insertOne({ id: id('sch'), orgId: org.id, membershipId: mem.id, userId: u.id, weekly: [1, 2, 3, 4, 5, 6].map(dow => ({ dow, start: '08:00', end: '16:00' })), slotMin: 20, types: ['in_person', 'video'], acceptingBookings: true,
        feeKobo: naira(9000), videoFeeKobo: naira(7000), specialty: b.key === 'ikeja' ? 'Family medicine' : 'Paediatrics', languages: ['English', b.key === 'ikeja' ? 'Yoruba' : 'Igbo'], bio: null, createdAt: now(), updatedAt: now(), updatedBy: 'demo' });
    }
    for (const [code, name, category, price] of [['REG', 'Registration card', 'registration', 2500], ['CONS-GP', 'GP consultation', 'consultation', 9000], ['CONS-SPEC', 'Specialist consultation', 'consultation', 16000]]) await db.col('services').insertOne({ id: id('svc'), orgId: org.id, code, name, category, priceKobo: naira(price), active: true, public: true, createdAt: now() });
  }
  await groups.refreshGroupSubscription(g.id);
  // a patient registered at the Ikeja branch is a patient of the Ajah branch too
  const doc = { id: id('pat'), firstName: 'Ngozi', lastName: 'Okafor', dob: '1979-06-21', sex: 'female', phone: '+2348061112233', phoneVerified: true, email: 'ngozi@patient.demo', address: '11 Isaac John St, Ikeja GRA', homeLoc: { lat: 6.5810, lng: 3.3560 }, bloodGroup: 'A+', genotype: 'AA', weightKg: 70,
    allergies: [], noKnownAllergies: true, conditions: [{ name: 'Asthma', code: 'J45', at: now() }], status: 'active', createdAt: now(), createdVia: 'demo', userId: null, consent: { version: '2026-10', accepted: true, at: now(), channel: 'demo' } };
  await db.col('patients').insertOne(doc);
  const nu = await mkUser({ name: 'Ngozi Okafor', email: doc.email, phone: doc.phone, patientId: doc.id }); await db.col('patients').updateOne({ id: doc.id }, { $set: { userId: nu.id } });
  await P.ensureLink(ctx.branches.ikeja.id, doc.id, 'demo', 'demo');
  ctx.patients.ngozi = doc; ctx.users.ngozi = nu;
  // Tobi asked to join Crestview (Ajah branch) in the app: waiting for the front desk
  await db.col('patient_applications').insertOne({ id: id('pa'), number: 'PA000001', patientId: ctx.patients.tobi.id, orgId: ctx.branches.ajah.id, groupId: g.id, status: 'pending', note: 'I moved to Ajah and need a hospital close to home.', createdAt: now() - 3600e3, expiresAt: now() + 29 * 86400e3 });
  await db.col('counters').findOneAndUpdate({ id: 'papp' }, { $set: { n: 1 }, $setOnInsert: { id: 'papp' } }, { upsert: true });
  // network connections
  const pk = (a, b) => [a, b].sort().join(':');
  const conn = (a, b, status) => db.col('network_connections').insertOne({ id: id('nc'), pairKey: pk(a.id, b.id), fromOrgId: a.id, fromOrgName: a.name, toOrgId: b.id, toOrgName: b.name, status, note: null, createdAt: now() - 86400e3, decidedAt: status === 'accepted' ? now() - 80000e3 : null, byName: 'Demo' });
  await conn(ctx.orgs.pharmacy, ctx.orgs.hospital, 'accepted');
  await conn(ctx.orgs.clinic, ctx.orgs.lab, 'accepted');
  await conn(ctx.orgs.lab, ctx.branches.ikeja, 'pending');
  // an open referral: Yaba Care's pharmacist refers Tobi to Grandville (blood sugar too high for pharmacy care)
  const ph = ctx.staff.pharmacy.pharmacist;
  const fakeReq = { headers: {}, ctx: { org: ctx.orgs.pharmacy, user: ph.user, role: 'pharmacist', perms: [] } };
  const net = require('../modules/network');
  const snap = await net.buildSnapshot(fakeReq, await db.col('patients').findOne({ id: ctx.patients.tobi.id }));
  const th = { id: id('nth'), pairKey: pk(ctx.orgs.pharmacy.id, ctx.orgs.hospital.id) + ':demo', orgIds: [ctx.orgs.pharmacy.id, ctx.orgs.hospital.id], orgNames: { [ctx.orgs.pharmacy.id]: ctx.orgs.pharmacy.name, [ctx.orgs.hospital.id]: ctx.orgs.hospital.name }, createdAt: now(), lastAt: now(), lastText: 'Patient is on his way by taxi.', unread: { [ctx.orgs.hospital.id]: 1, [ctx.orgs.pharmacy.id]: 0 }, referralId: null, subject: 'Referral RF000001' };
  const ref = { id: id('ref'), number: 'RF000001', fromOrgId: ctx.orgs.pharmacy.id, fromOrgName: ctx.orgs.pharmacy.name, fromGroupId: null, fromUserId: ph.user.id, fromName: ph.user.name, fromRole: 'pharmacist', fromRoleLabel: 'Pharmacist',
    toOrgId: ctx.orgs.hospital.id, toOrgName: ctx.orgs.hospital.name, toGroupId: null, patientId: ctx.patients.tobi.id, patientName: 'Tobi Adeyemi', urgency: 'urgent', service: 'consultation', specialty: 'Endocrinology',
    reason: 'Random blood sugar 19.8 mmol/L at the counter, thirsty and passing urine often. Needs a doctor today.', clinicalNote: 'Known type 2 diabetic on metformin. Says he ran out 2 weeks ago. No vomiting, alert and walking.',
    snapshot: snap, hmo: null, consent: { given: true, method: 'verbal', recordedBy: ph.user.id, at: now() }, status: 'sent', createdAt: now() - 1800e3, updatedAt: now() - 1800e3, expiresAt: now() + 29 * 86400e3, timeline: [{ status: 'sent', at: now() - 1800e3, by: ph.user.id, byName: ph.user.name, orgName: ctx.orgs.pharmacy.name }], threadId: th.id };
  th.referralId = ref.id;
  await db.col('network_threads').insertOne(th);
  await db.col('network_messages').insertOne({ id: id('nm'), threadId: th.id, fromOrgId: ctx.orgs.pharmacy.id, fromUserId: ph.user.id, fromName: ph.user.name, fromRole: 'pharmacist', text: 'Patient is on his way by taxi.', system: false, at: now() - 1700e3 });
  await db.col('referrals').insertOne(ref);
  await db.col('counters').findOneAndUpdate({ id: 'referral' }, { $set: { n: 1 }, $setOnInsert: { id: 'referral' } }, { upsert: true });
  await seedContactsAndHmos(ctx);
}

/* ---- department numbers, HMO panels with an off-platform HMO, and a WhatsApp chat (all fictional numbers) ---- */
async function seedContactsAndHmos(ctx) {
  const c = (phone, wa, extra) => Object.assign({ phone, whatsapp: wa, show: true }, extra || {});
  await db.col('orgs').updateOne({ id: ctx.orgs.hospital.id }, { $set: { contacts: {
    main: c('+2348030000001', '+2348030000101', { hours: 'Mon-Sat 8am-8pm' }), emergency: c('+2348030000111', '+2348030000111', { hours: '24 hours' }), appointments: c('+2348030000102', '+2348030000102'),
    pharmacy: c('+2348030000103', '+2348030000103'), lab: c('+2348030000104', '+2348030000104'), billing: c('+2348030000105', '+2348030000105', { email: 'billing@grandville.demo' }), care: c('+2348030000106', '+2348030000106') } } });
  await db.col('orgs').updateOne({ id: ctx.orgs.pharmacy.id }, { $set: { contacts: { main: c('+2348030000003', '+2348030000303', { hours: 'Mon-Sun 8am-10pm' }), pharmacy: c('+2348030000003', '+2348030000303') } } });
  await db.col('orgs').updateOne({ id: ctx.orgs.clinic.id }, { $set: { contacts: { main: c('+2348030000002', '+2348030000202'), appointments: c('+2348030000202', '+2348030000202') } } });
  for (const [k, b] of Object.entries(ctx.branches)) await db.col('orgs').updateOne({ id: b.id }, { $set: { contacts: { main: c(b.contact.phone, b.contact.phone), emergency: c(k === 'ikeja' ? '+2348030000911' : '+2348030000912', null, { hours: '24 hours' }) } } });
  await db.col('groups').updateOne({ id: ctx.group.id }, { $set: { contacts: { main: c('+2348030000010', '+2348030000010', { hours: 'Mon-Fri 9am-5pm' }), billing: c('+2348030000013', null, { email: 'accounts@crestview.demo' }) } } });
  // Grandville's HMO panel: Harbor Health (on the platform) and an HMO that is not on the platform yet
  await db.col('hmo_panel').insertOne({ id: id('hp'), orgId: ctx.orgs.hospital.id, payerOrgId: ctx.orgs.hmo.id, name: ctx.orgs.hmo.name, active: true, createdAt: now(), createdBy: 'demo' });
  const ext = { id: id('hp'), orgId: ctx.orgs.hospital.id, payerOrgId: null, name: 'Bluewater HMO (off-platform demo)', code: 'BWH', contactName: 'Provider relations', phone: '+2348030000501', whatsapp: '+2348030000502', email: 'providers@bluewater.demo', preauthEmail: 'preauth@bluewater.demo', claimsEmail: 'claims@bluewater.demo', portalUrl: '', notes: 'Pre-authorisation answers within 1 hour on weekdays.', active: true, createdAt: now(), createdBy: 'demo' };
  await db.col('hmo_panel').insertOne(ext);
  await db.col('external_covers').insertOne({ id: id('xc'), orgId: ctx.orgs.hospital.id, patientId: ctx.patients.tobi.id, panelId: ext.id, memberNo: 'BWH/1029/01', planName: 'Gold', employer: 'Yaba Tech Ltd', status: 'active', createdAt: now(), by: 'demo' });
  // a WhatsApp chat waiting in Grandville's inbox
  const conv = { id: id('wac'), orgId: ctx.orgs.hospital.id, dept: 'appointments', waId: '2348031234567', phone: '+2348031234567', patientId: ctx.patients.amaka.id, name: 'Amaka Eze', status: 'open', priority: 'normal', createdAt: now() - 900e3, lastAt: now() - 600e3, lastInboundAt: now() - 600e3, lastText: 'Good morning, can I move my Thursday appointment to Friday?', unread: 1, assignedTo: null, fromPhoneNumberId: null };
  await db.col('wa_conversations').insertOne(conv);
  await db.col('wa_messages').insertOne({ id: id('wam'), convId: conv.id, dir: 'in', type: 'text', text: 'Good morning, can I move my Thursday appointment to Friday?', at: now() - 600e3 });
  await db.col('patients').updateOne({ id: ctx.patients.amaka.id }, { $set: { whatsappOptIn: true, whatsappOptInAt: now(), whatsappOptInVia: 'demo' } });
}

/** printable list of demo sign-ins (used by docs and the HQ demo panel) */
function accounts() {
  const rows = [['MediCore HQ', 'hq', 'hq@medicore.demo'], ['MediCore HQ (developer)', 'hq', 'dev@medicore.demo']];
  for (const [k, spec] of Object.entries(ORGS)) {
    rows.push([spec.name + ' (owner)', 'admin', 'owner@' + DOMAIN[k]]);
    for (const [key, role] of STAFF[k]) { const { ROLES } = require('../lib/roles'); rows.push([spec.name + ': ' + ROLES[role].label, ROLES[role].app, key + '@' + DOMAIN[k]]); }
  }
  rows.push([GROUP.name + ' (group owner)', 'group', 'owner@' + GROUP.domain], [GROUP.name + ' (group administrator)', 'group', 'ops@' + GROUP.domain]);
  for (const b of GROUP.branches) for (const [key, role] of b.staff) { const { ROLES } = require('../lib/roles'); rows.push([GROUP.name + ' ' + b.branchName + ': ' + ROLES[role].label, ROLES[role].app, key + '@' + GROUP.domain]); }
  PATIENTS.filter(p => p.account).forEach(p => rows.push(['Patient: ' + p.firstName + ' ' + p.lastName, 'patient', p.email]));
  rows.push(['Patient: Ngozi Okafor (Crestview)', 'patient', 'ngozi@patient.demo']);
  return { password: DEMO_PASSWORD, rows };
}

module.exports = { load, accounts, DEMO_PASSWORD, ORGS, STAFF, DOMAIN, PATIENTS };
