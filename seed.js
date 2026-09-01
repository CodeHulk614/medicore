'use strict';
/* Seeds the database with a demo patient account and a coherent starting record.
 * Login: amaka@demo.ng / demo1234   (change or add real accounts via /api/auth/register)
 */
const bcrypt = require('bcryptjs');
const store = require('./store');

function uid(p){ return p + '_' + Math.random().toString(36).slice(2, 9); }

function seed(force) {
  store.load();
  const db = store.get();
  if (db.users.length && !force) return db;

  // reset
  Object.keys(db).forEach(k => { db[k] = []; });

  const patientId = 'p_amaka';
  db.patients.push({
    id: patientId, first: 'Amaka', last: 'Eze', hn: 'GH-024881', member: 'AVN-4471-2288',
    dob: '1991-04-12', sex: 'female', bg: 'O+', phone: '0803 123 4567',
    plan: 'Avon HMO', tier: 'Premium', hmo: 'Avon HMO', hospitalId: 'h_grand',
    address: '15 Adeniran Ogunsanya St, Surulere', homeLat: 6.4966, homeLng: 3.3512, area: 'Surulere',
    allergies: ['Penicillin'], conditions: [{ name: 'Hypertension', code: 'I10', since: '2023' }],
  });
  db.users.push({
    id: 'u_amaka', role: 'patient', patientId,
    email: 'amaka@demo.ng', name: 'Amaka Eze',
    pass: bcrypt.hashSync('demo1234', 10),
  });
  db.users.push({
    id: 'u_tunde', role: 'doctor', name: 'Dr. Tunde Bello',
    email: 'tunde@demo.ng', pass: bcrypt.hashSync('demo1234', 10),
  });

  db.appointments.push(
    { id: uid('a'), patientId, dept: 'General OPD', doctor: 'Dr. Tunde Bello', doctorId: 'doc_tunde', type: 'in-person', date: 'in 2 days', time: '09:00', where: 'Grandville Hospital', status: 'booked', fee: 5000, feeInPerson: 5000, feeVideo: 4000, scheduledAt: Date.now() + 2 * 86400000 },
    { id: uid('a'), patientId, dept: 'Chest clinic', doctor: 'Dr. Ada Nwosu', doctorId: 'doc_ada', type: 'video', date: 'Today', time: 'in ~40 min', where: 'Video visit', status: 'booked', fee: 10000, feeInPerson: 10000, feeVideo: 8500, scheduledAt: Date.now() + 40 * 60000 },
    { id: uid('a'), patientId, dept: 'Follow-up', doctor: 'Dr. Kunle Balogun', doctorId: 'doc_kunle', type: 'video', date: 'Today', time: 'now', where: 'Video visit', status: 'booked', fee: 4500, feeInPerson: 4500, feeVideo: 4000, scheduledAt: Date.now() - 2 * 60000 },
  );
  db.prescriptions.push(
    { id: 'rx1', patientId, drug: 'Amlodipine 5mg', sig: '1 tablet each morning', status: 'Active', refill: true },
    { id: 'rx2', patientId, drug: 'Paracetamol 1g', sig: 'As needed for pain', status: 'Completed', refill: false },
  );
  db.deliveries.push({ id: uid('d'), patientId, drug: 'Amlodipine 5mg x30', stage: 1 });
  db.benefits.push(
    { name: 'Outpatient care', used: 38000, limit: 150000 },
    { name: 'Drugs & pharmacy', used: 52000, limit: 80000 },
    { name: 'Laboratory', used: 12000, limit: 60000 },
    { name: 'Specialist & admission', used: 0, limit: 500000 },
    { name: 'Dental & optical', used: 15000, limit: 40000 },
  );
  db.authorizations.push(
    { id: uid('au'), patientId, what: 'Chest X-ray', where: 'Grandville Hospital', status: 'Approved', when: 'Today' },
    { id: uid('au'), patientId, what: 'Specialist referral (Cardiology)', where: 'Grandville Hospital', status: 'Pending', when: '2h ago' },
  );
  db.claims.push(
    { id: uid('c'), patientId, what: 'Consultation + FBC', amount: 8500, status: 'Paid', when: 'Last week' },
    { id: uid('c'), patientId, what: 'Antenatal review', amount: 15200, status: 'Processing', when: '3 days ago' },
    { id: uid('c'), patientId, what: 'Pharmacy top-up', amount: 4000, status: 'Query', when: '6 days ago', note: 'Pre-authorisation code needed' },
  );
  db.bills.push({ id: uid('b'), patientId, what: 'Consultation (out-of-pocket share)', amount: 500 });
  db.results.push(
    { id: uid('r'), patientId, test: 'Blood pressure', value: '128/82', unit: 'mmHg', flag: 'normal', when: '2 days ago' },
    { id: uid('r'), patientId, test: 'Haemoglobin', value: '12.6', unit: 'g/dL', flag: 'normal', low: 12, high: 16, cl: 7, ch: 20, when: '2 weeks ago' },
    { id: uid('r'), patientId, test: 'Fasting glucose', value: '5.4', unit: 'mmol/L', flag: 'normal', low: 3.9, high: 7.8, cl: 2.5, ch: 25, when: '2 weeks ago' },
  );
  db.visits.push(
    { id: uid('v'), patientId, reason: 'Hypertension review', doctor: 'Dr. Tunde Bello', when: '2 days ago' },
    { id: uid('v'), patientId, reason: 'Malaria treatment', doctor: 'Dr. Ada Nwosu', when: '4 months ago' },
  );
  db.messages.push(
    { id: uid('m'), patientId, from: 'them', who: 'Dr. Tunde Bello', text: 'Your recent BP readings look good. Keep taking the amlodipine each morning.', when: '2d' },
    { id: uid('m'), patientId, from: 'me', text: 'Thank you doctor. Should I still reduce salt?', when: '2d' },
    { id: uid('m'), patientId, from: 'them', who: 'Dr. Tunde Bello', text: 'Yes, keep salt low and stay active. See you at your review.', when: '1d' },
  );
  db.providers.push(
    { name: 'Grandville Hospital', kind: 'Hospital', area: 'Surulere', km: 1.2, covered: true },
    { name: 'Lagoon Clinic', kind: 'Clinic', area: 'Ikeja', km: 4.5, covered: true },
    { name: 'HealthPlus Pharmacy', kind: 'Pharmacy', area: 'Yaba', km: 2.1, covered: true },
    { name: 'Riverside Medical Centre', kind: 'Hospital', area: 'Lekki', km: 9.8, covered: true },
    { name: 'CarePoint Diagnostics', kind: 'Laboratory', area: 'Ikoyi', km: 6.3, covered: false },
  );

  // ---- doctor marketplace directory (across facilities) ----
  const docs = [
    { id: 'doc_tunde', userId: 'u_tunde', name: 'Dr. Tunde Bello', specialty: 'General Physician', facility: 'Grandville Hospital', area: 'Surulere', languages: ['English', 'Yoruba'], fee: 5000, feeInPerson: 5000, feeVideo: 4000, rating: 4.8, reviews: 212, bio: 'Consultant physician with 12 years in internal medicine and chronic-disease care.', available: true, slots: ['09:00', '09:30', '10:00', '11:00', '15:00'] },
    { id: 'doc_ada', userId: 'u_ada', name: 'Dr. Ada Nwosu', specialty: 'Cardiology', facility: 'Riverside Medical Centre', area: 'Lekki', languages: ['English', 'Igbo'], fee: 12000, feeInPerson: 12000, feeVideo: 10000, rating: 4.9, reviews: 168, bio: 'Cardiologist focused on hypertension and heart failure.', available: true, slots: ['10:30', '11:30', '14:00'] },
    { id: 'doc_ifeoma', userId: 'u_ifeoma', name: 'Dr. Ifeoma Okeke', specialty: 'Paediatrics', facility: 'Lagoon Clinic', area: 'Ikeja', languages: ['English', 'Igbo'], fee: 7000, feeInPerson: 7000, feeVideo: 6000, rating: 4.7, reviews: 240, bio: 'Paediatrician, newborn to adolescent care.', available: true, slots: ['08:30', '09:30', '12:00', '16:00'] },
    { id: 'doc_musa', userId: 'u_musa', name: 'Dr. Musa Ibrahim', specialty: 'Family Medicine', facility: 'HealthPlus Clinic', area: 'Yaba', languages: ['English', 'Hausa'], fee: 4000, feeInPerson: 4000, feeVideo: 3500, rating: 4.6, reviews: 301, bio: 'Family doctor, whole-household primary care.', available: false, slots: ['13:00', '13:30', '14:30'] },
    { id: 'doc_chidinma', userId: 'u_chidinma', name: 'Dr. Chidinma Eze', specialty: 'Dermatology', facility: 'CarePoint Clinic', area: 'Ikoyi', languages: ['English'], fee: 10000, feeInPerson: 10000, feeVideo: 8500, rating: 4.8, reviews: 97, bio: 'Skin, hair and nail conditions.', available: true, slots: ['10:00', '11:00', '15:30'] },
    { id: 'doc_bisi', userId: 'u_bisi', name: 'Dr. Bisi Adewale', specialty: 'Obstetrics & Gynaecology', facility: 'Grandville Hospital', area: 'Surulere', languages: ['English', 'Yoruba'], fee: 15000, feeInPerson: 15000, feeVideo: 13000, rating: 4.9, reviews: 155, bio: 'Antenatal care and women\u2019s health.', available: true, slots: ['09:00', '10:30', '13:00'] },
    { id: 'doc_kunle', userId: 'u_kunle', name: 'Dr. Kunle Balogun', specialty: 'General Physician', facility: 'Grandville Hospital', area: 'Surulere', languages: ['English', 'Yoruba'], fee: 5000, feeInPerson: 5000, feeVideo: 4000, rating: 4.7, reviews: 133, bio: 'Internal medicine and outpatient care.', available: true, slots: ['08:30', '09:30', '11:00', '14:00'] },
    { id: 'doc_halima', userId: 'u_halima', name: 'Dr. Halima Yusuf', specialty: 'Neurology', facility: 'Riverside Medical Centre', area: 'Lekki', languages: ['English', 'Hausa'], fee: 14000, feeInPerson: 14000, feeVideo: 12000, rating: 4.8, reviews: 88, bio: 'Headache, stroke and nerve disorders.', available: true, slots: ['10:00', '12:30', '15:00'] },
  ];
  db.doctors = docs;
  docs.forEach(d => {
    if (!db.users.find(u => u.id === d.userId)) {
      db.users.push({ id: d.userId, role: 'doctor', doctorId: d.id, name: d.name,
        email: d.name.split(' ')[1].toLowerCase() + '@demo.ng', pass: bcrypt.hashSync('demo1234', 10) });
    } else {
      const u = db.users.find(u => u.id === d.userId); u.doctorId = d.id;
    }
  });
  const now = Date.now(), HR = 3600e3;
  db.wearables = [
    { id: 'w_1', patientId: 'p_amaka', type: 'Heart rate', value: 72, unit: 'bpm', at: now - 26 * HR },
    { id: 'w_2', patientId: 'p_amaka', type: 'Heart rate', value: 68, unit: 'bpm', at: now - 2 * HR },
    { id: 'w_3', patientId: 'p_amaka', type: 'Blood pressure', value: '118/76', unit: 'mmHg', at: now - 2 * HR },
    { id: 'w_4', patientId: 'p_amaka', type: 'SpO2', value: 98, unit: '%', at: now - 2 * HR },
    { id: 'w_5', patientId: 'p_amaka', type: 'Steps', value: 6420, unit: 'steps', at: now - 1 * HR },
    { id: 'w_6', patientId: 'p_amaka', type: 'Blood glucose', value: 5.4, unit: 'mmol/L', at: now - 5 * HR },
  ];
  db.ussd_sessions = [];

  // ---- verification status on the directory ----
  db.doctors.forEach(d => { d.status = 'verified'; });
  db.providers.forEach(p => { p.status = 'verified'; });
  // pending applicants waiting in the admin queue
  const pendingDocs = [
    { id: 'doc_okon', userId: 'u_okon', name: 'Dr. Emeka Okonkwo', specialty: 'Orthopaedics', facility: 'Riverside Medical Centre', area: 'Lekki', languages: ['English', 'Igbo'], fee: 11000, feeInPerson: 11000, feeVideo: 9500, rating: 0, reviews: 0, bio: 'Orthopaedic surgeon, joints and trauma.', available: true, slots: ['10:00', '12:00'], status: 'pending' },
    { id: 'doc_yakubu', userId: 'u_yakubu', name: 'Dr. Aisha Yakubu', specialty: 'Endocrinology', facility: 'Lagoon Clinic', area: 'Ikeja', languages: ['English', 'Hausa'], fee: 13000, feeInPerson: 13000, feeVideo: 11000, rating: 0, reviews: 0, bio: 'Diabetes and hormonal disorders.', available: true, slots: ['09:00', '11:30'], status: 'pending' },
  ];
  pendingDocs.forEach(d => { db.doctors.push(d); db.users.push({ id: d.userId, role: 'doctor', doctorId: d.id, name: d.name, email: d.name.split(' ')[1].toLowerCase() + '@demo.ng', pass: bcrypt.hashSync('demo1234', 10) }); });
  db.providers.push({ name: 'Bright Star Clinic', kind: 'Clinic', area: 'Ajah', km: 14, covered: false, status: 'pending' });

  // ---- operator / payer / facility staff accounts (all demo1234) ----
  db.users.push(
    { id: 'u_admin', role: 'admin', name: 'Operations', email: 'admin@demo.ng', pass: bcrypt.hashSync('demo1234', 10) },
    { id: 'u_payer', role: 'payer', hmo: 'Avon HMO', name: 'Avon HMO Desk', email: 'payer@demo.ng', pass: bcrypt.hashSync('demo1234', 10) },
    { id: 'u_pharm', role: 'pharmacy', facility: 'HealthPlus Pharmacy', name: 'HealthPlus Pharmacy', email: 'pharmacy@demo.ng', pass: bcrypt.hashSync('demo1234', 10) },
    { id: 'u_lab', role: 'lab', facility: 'CarePoint Diagnostics', name: 'CarePoint Diagnostics', email: 'lab@demo.ng', pass: bcrypt.hashSync('demo1234', 10) },
  );

  // ---- pharmacy inventory ----
  db.inventory = [
    { id: 'inv_1', facility: 'HealthPlus Pharmacy', name: 'Amlodipine 5mg', stock: 120, price: 2500, unit: 'pack of 30' },
    { id: 'inv_2', facility: 'HealthPlus Pharmacy', name: 'Paracetamol 1g', stock: 300, price: 800, unit: 'pack of 20' },
    { id: 'inv_3', facility: 'HealthPlus Pharmacy', name: 'Metformin 500mg', stock: 9, price: 3200, unit: 'pack of 30' },
    { id: 'inv_4', facility: 'HealthPlus Pharmacy', name: 'Lisinopril 10mg', stock: 0, price: 4100, unit: 'pack of 30' },
  ];

  // ---- a prescription waiting to dispense + a lab order waiting to run ----
  const rx = db.prescriptions.find(p => p.id === 'rx1');
  if (rx) { rx.facility = 'HealthPlus Pharmacy'; rx.dispenseStatus = 'pending'; rx.qtyLabel = 'x30'; }
  db.laborders = [
    { id: 'lo_1', patientId: 'p_amaka', facility: 'CarePoint Diagnostics', tests: ['Lipid profile', 'HbA1c'], orderedBy: 'Dr. Tunde Bello', status: 'ordered', when: 'Today' },
  ];
  db.settlements = [];
  db.audit = [];

  // ---- logistics + emergency + field-health accounts (all demo1234) ----
  db.users.push(
    { id: 'u_rider', role: 'rider', name: 'Chidi (HealthPlus rider)', email: 'rider@demo.ng', pass: bcrypt.hashSync('demo1234', 10) },
    { id: 'u_dispatch', role: 'dispatch', name: 'Dispatch Desk', email: 'dispatch@demo.ng', pass: bcrypt.hashSync('demo1234', 10) },
    { id: 'u_crew', role: 'crew', name: 'Ambulance Crew', email: 'crew@demo.ng', pass: bcrypt.hashSync('demo1234', 10) },
    { id: 'u_chw', role: 'chw', name: 'Grace Umeh', email: 'chw@demo.ng', pass: bcrypt.hashSync('demo1234', 10) },
  );
  db.deliveries.forEach(d => { d.pickup = 'HealthPlus Pharmacy'; d.dropoff = 'Surulere'; d.assignedTo = null; });

  // ---- emergency responders (ambulances) with base coordinates for AVL ----
  db.responders = [
    { id: 'amb_1', name: 'Ambulance A1', type: 'Advanced life support', hospitalId: 'h_grand', plate: 'LAG-114-AM', crew: 'Chidi & Ngozi', area: 'Surulere', status: 'available', lat: 6.501, lng: 3.358, homeLat: 6.501, homeLng: 3.358, assignedCase: null, target: null, crewUserId: null },
    { id: 'amb_2', name: 'Ambulance A2', type: 'Basic life support', hospitalId: 'h_grand', plate: 'LAG-207-AM', crew: 'Sola & Bimpe', area: 'Yaba', status: 'available', lat: 6.512, lng: 3.382, homeLat: 6.512, homeLng: 3.382, assignedCase: null, target: null, crewUserId: null },
    { id: 'amb_3', name: 'Rapid responder R1', type: 'Motorbike medic', hospitalId: 'h_grand', plate: 'LAG-330-MR', crew: 'Emeka', area: 'Ikeja', status: 'available', lat: 6.601, lng: 3.351, homeLat: 6.601, homeLng: 3.351, assignedCase: null, target: null, crewUserId: null },
    { id: 'amb_4', name: 'Ambulance R2', type: 'Advanced life support', hospitalId: 'h_river', plate: 'LAG-421-AM', crew: 'Tunde & Kemi', area: 'Lekki', status: 'available', lat: 6.448, lng: 3.508, homeLat: 6.448, homeLng: 3.508, assignedCase: null, target: null, crewUserId: null },
  ];
  db.emergencies = [
    { id: 'em_seed', kind: 'Road traffic accident', area: 'Surulere', name: 'Bystander caller', phone: '0803 555 0110', address: 'Adeniran Ogunsanya, near the mall', patientId: null, lat: 6.507, lng: 3.362, priority: 'high', source: 'call', status: 'requested', responderId: null, hospitalId: 'h_grand', at: Date.now() - 120000, timeline: [{ at: Date.now() - 120000, status: 'requested', note: 'case raised (call)' }] },
  ];

  // ---- CHW roster: households registered in the field, visits due ----
  db.patients.push(
    { id: 'p_ngozi', first: 'Ngozi', last: 'Abah', hn: 'CH-100241', member: '', dob: '1994-06-02', sex: 'female', bg: '', phone: '0803 900 1122', plan: 'Self-pay', tier: 'Community', hmo: '', allergies: [], conditions: [{ name: 'Pregnancy (32 weeks)', code: 'Z34', since: '2026' }], registeredBy: 'u_chw', area: 'Makoko', nextVisit: 'Antenatal check due' },
    { id: 'p_sadiq', first: 'Sadiq', last: 'Bello', hn: 'CH-100242', member: '', dob: '2024-01-15', sex: 'male', bg: '', phone: '0806 200 3344', plan: 'Self-pay', tier: 'Community', hmo: '', allergies: [], conditions: [], registeredBy: 'u_chw', area: 'Makoko', nextVisit: 'Immunization due (6 weeks)' },
  );

  /* ============================================================
   * MULTI-TENANCY: hospitals are the root. Everyone belongs to one
   * (patients can belong to several). Each hospital enables modules.
   * ============================================================ */
  const H = () => bcrypt.hashSync('demo1234', 10);
  db.hospitals = [
    { id: 'h_grand', name: 'Grandville Hospital', area: 'Surulere', code: 'GRAND', lat: 6.499, lng: 3.354,
      modules: { marketplace: true, pharmacy: true, lab: true, ambulance: true, chw: true, analytics: true, wearables: true } },
    { id: 'h_river', name: 'Riverside Medical Centre', area: 'Lekki', code: 'RIVER', lat: 6.446, lng: 3.512,
      modules: { marketplace: true, pharmacy: true, lab: true, ambulance: true, chw: false, analytics: true, wearables: true } },
  ];
  const DOCH = { doc_tunde: 'h_grand', doc_bisi: 'h_grand', doc_ifeoma: 'h_grand', doc_musa: 'h_grand', doc_yakubu: 'h_grand', doc_ada: 'h_river', doc_chidinma: 'h_river', doc_okon: 'h_river', doc_kunle: 'h_grand', doc_halima: 'h_river' };
  db.doctors.forEach(d => { d.hospitalId = DOCH[d.id] || 'h_grand'; });
  db.users.forEach(u => {
    if (u.role === 'doctor') { const d = db.doctors.find(x => x.userId === u.id); u.hospitalId = d ? d.hospitalId : 'h_grand'; u.status = 'active'; }
  });
  [['u_admin', 'h_grand'], ['u_pharm', 'h_grand'], ['u_lab', 'h_grand'], ['u_rider', 'h_grand'], ['u_dispatch', 'h_grand'], ['u_crew', 'h_grand'], ['u_chw', 'h_grand']]
    .forEach(([id, h]) => { const u = db.users.find(x => x.id === id); if (u) { u.hospitalId = h; u.status = 'active'; } });
  const uAdmin = db.users.find(x => x.id === 'u_admin'); if (uAdmin) uAdmin.name = 'Grandville Admin';
  db.users.push(
    { id: 'u_super', role: 'superadmin', name: 'MediCore HQ', email: 'super@demo.ng', pass: H() },
    { id: 'u_admin2', role: 'admin', hospitalId: 'h_river', status: 'active', name: 'Riverside Admin', email: 'admin2@demo.ng', pass: H() },
    { id: 'u_dispatch2', role: 'dispatch', hospitalId: 'h_river', status: 'active', name: 'Riverside Dispatch', email: 'dispatch2@demo.ng', pass: H() },
    { id: 'u_crew2', role: 'crew', hospitalId: 'h_river', status: 'active', name: 'Riverside Crew', email: 'crew2@demo.ng', pass: H() },
    { id: 'u_pharm_g2', role: 'pharmacy', hospitalId: 'h_grand', status: 'active', name: 'Grandville Pharmacy 2', email: 'pharmacy3@demo.ng', pass: H() },
    { id: 'u_lab_g2', role: 'lab', hospitalId: 'h_grand', status: 'active', name: 'Grandville Lab 2', email: 'lab3@demo.ng', pass: H() },
    { id: 'u_recept_g2', role: 'frontdesk', subrole: 'receptionist', hospitalId: 'h_grand', status: 'active', name: 'Ada Umeh', email: 'reception3@demo.ng', pass: H() }
  );
  ['p_ngozi', 'p_sadiq'].forEach(id => { const p = db.patients.find(x => x.id === id); if (p) p.hospitalId = 'h_grand'; });

  /* ============================================================
   * IMMERSIVE TEST ROSTER: more patients (with logins) across both
   * hospitals, second-hospital staff, and pre-populated staff queues.
   * All passwords are demo1234.
   * ============================================================ */
  const morePatients = [
    { id: 'p_tobi', first: 'Tobi', last: 'Umeh', hn: 'GH-024902', member: 'AVN-5521-0090', dob: '1985-09-20', sex: 'male', bg: 'A+', phone: '0803 411 2200', plan: 'Avon HMO', tier: 'Standard', hmo: 'Avon HMO', address: '7 Bode Thomas St, Surulere', homeLat: 6.5008, homeLng: 3.3496, area: 'Surulere', allergies: [], conditions: [{ name: 'Type 2 diabetes', code: 'E11', since: '2021' }], hospitalId: 'h_grand' },
    { id: 'p_fatima', first: 'Fatima', last: 'Sani', hn: 'RV-071145', member: 'HYG-2210-7781', dob: '1997-02-11', sex: 'female', bg: 'B+', phone: '0806 778 4512', plan: 'Hygeia HMO', tier: 'Premium', hmo: 'Hygeia HMO', address: '12 Admiralty Way, Lekki', homeLat: 6.4459, homeLng: 3.4772, area: 'Lekki', allergies: ['Sulfa'], conditions: [], hospitalId: 'h_river' },
    { id: 'p_chidi', first: 'Chidi', last: 'Okafor', hn: 'GH-024933', member: 'AVN-6640-1122', dob: '1979-12-03', sex: 'male', bg: 'O-', phone: '0805 220 9931', plan: 'Avon HMO', tier: 'Standard', hmo: 'Avon HMO', address: '3 Herbert Macaulay Way, Yaba', homeLat: 6.5095, homeLng: 3.3776, area: 'Yaba', allergies: [], conditions: [{ name: 'Asthma', code: 'J45', since: '2010' }], hospitalId: 'h_grand' },
    { id: 'p_blessing', first: 'Blessing', last: 'Ade', hn: 'RV-071188', member: '', dob: '2000-07-19', sex: 'female', bg: 'AB+', phone: '0807 552 6677', plan: 'Self-pay', tier: 'Community', hmo: '', address: '5 Addo Rd, Ajah', homeLat: 6.4698, homeLng: 3.5652, area: 'Ajah', allergies: [], conditions: [], hospitalId: 'h_river' },
    { id: 'p_kelvin', first: 'Kelvin', last: 'Obi', hn: 'GH-024977', member: 'AVN-7788-3300', dob: '1988-03-08', sex: 'male', bg: 'B-', phone: '0803 707 1180', plan: 'Avon HMO', tier: 'Standard', hmo: 'Avon HMO', address: '9 Ogunlana Dr, Surulere', homeLat: 6.4972, homeLng: 3.3560, area: 'Surulere', allergies: [], conditions: [], hospitalId: 'h_grand' },
    { id: 'p_zainab', first: 'Zainab', last: 'Bello', hn: 'RV-071205', member: 'HYG-3311-5522', dob: '1995-11-25', sex: 'female', bg: 'O+', phone: '0806 220 7788', plan: 'Hygeia HMO', tier: 'Premium', hmo: 'Hygeia HMO', address: '2 Freedom Way, Lekki', homeLat: 6.4441, homeLng: 3.4712, area: 'Lekki', allergies: [], conditions: [{ name: 'Migraine', code: 'G43', since: '2019' }], hospitalId: 'h_river' },
    { id: 'p_uche', first: 'Uche', last: 'Nwankwo', hn: 'GH-025010', member: 'AVN-8811-2200', dob: '1990-06-14', sex: 'male', bg: 'A+', phone: '0803 900 1122', plan: 'Avon HMO', tier: 'Standard', hmo: 'Avon HMO', address: '18 Bode Thomas St, Surulere', homeLat: 6.5001, homeLng: 3.3489, area: 'Surulere', allergies: [], conditions: [], hospitalId: 'h_grand' },
    { id: 'p_bola', first: 'Bola', last: 'Ade', hn: 'GH-025044', member: '', dob: '1983-01-30', sex: 'female', bg: 'O+', phone: '0805 700 3344', plan: 'Self-pay', tier: 'Standard', hmo: '', address: '4 Ogunlana Dr, Surulere', homeLat: 6.4959, homeLng: 3.3547, area: 'Surulere', allergies: ['Penicillin'], conditions: [], hospitalId: 'h_grand' },
    { id: 'p_grace', first: 'Grace', last: 'Etim', hn: 'RV-071230', member: 'HYG-4422-6611', dob: '1992-10-05', sex: 'female', bg: 'B+', phone: '0806 550 7788', plan: 'Hygeia HMO', tier: 'Standard', hmo: 'Hygeia HMO', address: '10 Admiralty Way, Lekki', homeLat: 6.4468, homeLng: 3.4759, area: 'Lekki', allergies: [], conditions: [], hospitalId: 'h_river' },
    { id: 'p_yusuf', first: 'Yusuf', last: 'Danladi', hn: 'RV-071255', member: '', dob: '1987-04-22', sex: 'male', bg: 'AB+', phone: '0807 220 9911', plan: 'Self-pay', tier: 'Standard', hmo: '', address: '7 Freedom Way, Lekki', homeLat: 6.4433, homeLng: 3.4705, area: 'Lekki', allergies: [], conditions: [{ name: 'Hypertension', code: 'I10', since: '2020' }], hospitalId: 'h_river' },
  ];
  morePatients.forEach(p => db.patients.push(p));
  const patientLogins = [
    ['u_tobi', 'p_tobi', 'tobi@demo.ng', 'Tobi Umeh'],
    ['u_fatima', 'p_fatima', 'fatima@demo.ng', 'Fatima Sani'],
    ['u_chidi', 'p_chidi', 'chidi@demo.ng', 'Chidi Okafor'],
    ['u_blessing', 'p_blessing', 'blessing@demo.ng', 'Blessing Ade'],
    ['u_kelvin', 'p_kelvin', 'kelvin@demo.ng', 'Kelvin Obi'],
    ['u_zainab', 'p_zainab', 'zainab@demo.ng', 'Zainab Bello'],
    ['u_uche', 'p_uche', 'uche@demo.ng', 'Uche Nwankwo'],
    ['u_bola', 'p_bola', 'bola@demo.ng', 'Bola Ade'],
    ['u_grace', 'p_grace', 'grace@demo.ng', 'Grace Etim'],
    ['u_yusuf', 'p_yusuf', 'yusuf@demo.ng', 'Yusuf Danladi'],
    ['u_ngozi', 'p_ngozi', 'ngozi@demo.ng', 'Ngozi Abah'],
  ];
  patientLogins.forEach(([id, pid, email, name]) => db.users.push({ id, role: 'patient', patientId: pid, email, name, pass: H() }));
  const png = db.patients.find(p => p.id === 'p_ngozi'); if (png) { png.homeLat = 6.4899; png.homeLng = 3.3908; png.address = 'Waterside, Makoko'; }

  db.users.push(
    { id: 'u_lab2', role: 'lab', hospitalId: 'h_river', status: 'active', name: 'Riverside Lab', email: 'lab2@demo.ng', pass: H() },
    { id: 'u_pharm2', role: 'pharmacy', hospitalId: 'h_river', status: 'active', name: 'Riverside Pharmacy', email: 'pharmacy2@demo.ng', pass: H() },
    { id: 'u_rider2', role: 'rider', hospitalId: 'h_river', status: 'active', name: 'Riverside Rider', email: 'rider2@demo.ng', pass: H() },
  );

  // ---- FRONT OFFICE: sub-admin roles (all demo1234), Grandville ----
  db.users.push(
    { id: 'u_recept', role: 'frontdesk', subrole: 'receptionist', hospitalId: 'h_grand', status: 'active', name: 'Grace Okon', email: 'reception@demo.ng', pass: H() },
    { id: 'u_cashier', role: 'frontdesk', subrole: 'cashier', hospitalId: 'h_grand', status: 'active', name: 'Yusuf Bello', email: 'cashier@demo.ng', pass: H() },
    { id: 'u_records', role: 'frontdesk', subrole: 'records', hospitalId: 'h_grand', status: 'active', name: 'Ada Nnamdi', email: 'records@demo.ng', pass: H() },
    { id: 'u_cs', role: 'frontdesk', subrole: 'cs', hospitalId: 'h_grand', status: 'active', name: 'Bola Ade', email: 'cs@demo.ng', pass: H() },
    { id: 'u_fdmgr', role: 'frontdesk', subrole: 'manager', hospitalId: 'h_grand', status: 'active', name: 'Ngozi Frontdesk', email: 'frontdesk@demo.ng', pass: H() },
    // a receptionist on the second hospital, for tenancy testing
    { id: 'u_recept2', role: 'frontdesk', subrole: 'receptionist', hospitalId: 'h_river', status: 'active', name: 'Tari West', email: 'reception2@demo.ng', pass: H() },
    // second-hospital front office (Riverside), so both hospitals have a full desk
    { id: 'u_cashier2', role: 'frontdesk', subrole: 'cashier', hospitalId: 'h_river', status: 'active', name: 'Ibrahim Sule', email: 'cashier2@demo.ng', pass: H() },
    { id: 'u_fdmgr2', role: 'frontdesk', subrole: 'manager', hospitalId: 'h_river', status: 'active', name: 'Ronke Bassey', email: 'frontdesk2@demo.ng', pass: H() },
    // a second HMO payer (Hygeia) and a second community health worker
    { id: 'u_payer2', role: 'payer', hmo: 'Hygeia HMO', name: 'Hygeia HMO Desk', email: 'payer2@demo.ng', pass: H() },
    { id: 'u_chw2', role: 'chw', hospitalId: 'h_river', status: 'active', name: 'Peace Etim', email: 'chw2@demo.ng', pass: H() },
  );
  // a couple of patients already checked in and waiting, so the doctor's waiting room shows people
  db.queue = [
    { id: 'q_seed1', hospitalId: 'h_grand', patientId: 'p_tobi', patientName: 'Tobi Umeh', complaint: 'Persistent cough, 5 days', priority: 'routine', vitals: { bp: '128/84', temp: '37.2', pulse: '78', weight: '81' }, dept: 'General OPD', doctorId: null, doctorName: null, status: 'waiting', token: 'A01', checkedInBy: 'u_recept', checkedInByName: 'Grace Okon', checkedInAt: Date.now() - 600000, startedAt: null, doneAt: null, routedTo: null },
    { id: 'q_seed2', hospitalId: 'h_grand', patientId: 'p_chidi', patientName: 'Chidi Okafor', complaint: 'Chest tightness on exertion', priority: 'urgent', vitals: { bp: '142/95', temp: '36.9', pulse: '92', weight: '90' }, dept: 'General OPD', doctorId: null, doctorName: null, status: 'waiting', token: 'A02', checkedInBy: 'u_recept', checkedInByName: 'Grace Okon', checkedInAt: Date.now() - 300000, startedAt: null, doneAt: null, routedTo: null },
    { id: 'q_seed3', hospitalId: 'h_river', patientId: 'p_fatima', patientName: 'Fatima Sani', complaint: 'Recurrent headaches', priority: 'routine', vitals: { bp: '124/80', temp: '36.8', pulse: '74', weight: '63' }, dept: 'General OPD', doctorId: null, doctorName: null, status: 'waiting', token: 'R01', checkedInBy: 'u_recept2', checkedInByName: 'Tari West', checkedInAt: Date.now() - 420000, startedAt: null, doneAt: null, routedTo: null },
  ];

  db.appointments.push(
    { id: uid('a'), patientId: 'p_tobi', dept: 'General OPD', doctor: 'Dr. Tunde Bello', type: 'in-person', date: 'in 3 days', time: '10:00', where: 'Grandville Hospital', status: 'booked' },
    { id: uid('a'), patientId: 'p_fatima', dept: 'Chest clinic', doctor: 'Dr. Ada Nwosu', type: 'video', date: 'Thu', time: '11:30', where: 'Video visit', status: 'booked' },
    { id: uid('a'), patientId: 'p_chidi', dept: 'General OPD', doctor: 'Dr. Bisi Adewale', type: 'in-person', date: 'Mon', time: '09:30', where: 'Grandville Hospital', status: 'booked' },
  );


  /* CHAT threads (one per patient-doctor pair) + presence */
  const tnow = Date.now();
  db.threads = [
    { id: 't_grand_tunde', patientId: 'p_amaka', doctorId: 'doc_tunde', hospitalId: 'h_grand', updatedAt: tnow - 3600e3, messages: [
      { from: 'patient', who: 'Amaka Eze', text: 'Good morning doctor, my BP readings have been a bit high this week.', at: tnow - 3700e3 },
      { from: 'doctor', who: 'Dr. Tunde Bello', text: 'Thanks Amaka. Keep logging them morning and night, and ease off salt. Any headaches?', at: tnow - 3600e3 },
    ] },
    { id: 't_river_ada', patientId: 'p_amaka', doctorId: 'doc_ada', hospitalId: 'h_river', updatedAt: tnow - 86400e3, messages: [
      { from: 'doctor', who: 'Dr. Ada Nwosu', text: 'Your ECG from last visit looked good. Any chest pain or palpitations since?', at: tnow - 86400e3 },
    ] },
  ];
  db.presence = {};

  /* ---- SPINE: unified orders (one object every department sees) ---- */
  const torder = (over) => Object.assign({
    id: uid(over.type === 'lab' ? 'lo' : 'rx'), hospitalId: 'h_grand', patientId: 'p_amaka', patientName: 'Amaka Eze',
    by: 'u_tunde', byName: 'Dr. Tunde Bello', status: 'ordered', detail: {}, result: null, dueAt: null, missedFlagged: false,
    events: [], createdAt: tnow, updatedAt: tnow,
  }, over);
  db.orders = [
    torder({ type: 'lab', detail: { tests: ['Lipid profile', 'HbA1c'] }, status: 'ordered',
      events: [{ at: tnow - 1800e3, status: 'ordered', by: 'Dr. Tunde Bello', note: '' }], createdAt: tnow - 1800e3, updatedAt: tnow - 1800e3 }),
    torder({ type: 'rx', detail: { drug: 'Amlodipine 5mg', sig: '1 tablet each morning', qty: 'x30' }, status: 'ready', dueAt: tnow + 2 * 24 * 3600e3,
      events: [{ at: tnow - 7200e3, status: 'ordered', by: 'Dr. Tunde Bello', note: '' }, { at: tnow - 3600e3, status: 'verified', by: 'Pharmacy', note: '' }, { at: tnow - 1800e3, status: 'ready', by: 'Pharmacy', note: 'ready for pickup' }],
      createdAt: tnow - 7200e3, updatedAt: tnow - 1800e3 }),
    torder({ type: 'rx', detail: { drug: 'Metformin 500mg', sig: '1 tablet twice daily', qty: 'x60' }, status: 'ordered',
      events: [{ at: tnow - 600e3, status: 'ordered', by: 'Dr. Tunde Bello', note: '' }], createdAt: tnow - 600e3, updatedAt: tnow - 600e3 }),
    torder({ type: 'lab', detail: { tests: ['Full blood count'] }, status: 'closed',
      result: [{ test: 'Haemoglobin', value: '12.6', unit: 'g/dL', flag: 'normal', low: 12, high: 16 }, { test: 'White cell count', value: '6.1', unit: 'x10^9/L', flag: 'normal', low: 4, high: 11 }],
      events: [{ at: tnow - 3 * 86400e3, status: 'ordered', by: 'Dr. Tunde Bello', note: '' }, { at: tnow - 3 * 86400e3 + 3600e3, status: 'in_progress', by: 'Lab', note: '' }, { at: tnow - 2 * 86400e3, status: 'resulted', by: 'Lab', note: '' }, { at: tnow - 2 * 86400e3, status: 'closed', by: 'Lab', note: '' }],
      createdAt: tnow - 3 * 86400e3, updatedAt: tnow - 2 * 86400e3 }),
  ];
  // extra spine orders for the wider test roster (so lab + pharmacy queues show several patients per tenant)
  const xo = (id, hid, pid, pn, type, status, detail, result) => db.orders.push({ id, hospitalId: hid, patientId: pid, patientName: pn, type, by: 'u_tunde', byName: 'Dr. Tunde Bello', status, detail: detail || {}, result: result || null, dueAt: null, missedFlagged: false, events: [{ at: tnow - 3600e3, status: 'ordered', by: 'Dr. Tunde Bello', note: '' }, { at: tnow, status, by: status === 'ordered' ? 'Dr. Tunde Bello' : (type === 'lab' ? 'Lab' : 'Pharmacy'), note: '' }], createdAt: tnow - 3600e3, updatedAt: tnow });
  xo('lo_tobi', 'h_grand', 'p_tobi', 'Tobi Umeh', 'lab', 'in_progress', { tests: ['Fasting glucose', 'HbA1c'] });
  xo('lo_chidi', 'h_grand', 'p_chidi', 'Chidi Okafor', 'lab', 'ordered', { tests: ['Full blood count'] });
  xo('rx_tobi', 'h_grand', 'p_tobi', 'Tobi Umeh', 'rx', 'ordered', { drug: 'Metformin 500mg', sig: '1 tablet twice daily', qty: 'x60' });
  xo('lo_fatima', 'h_river', 'p_fatima', 'Fatima Sani', 'lab', 'ordered', { tests: ['Urinalysis'] });
  xo('rx_blessing', 'h_river', 'p_blessing', 'Blessing Ade', 'rx', 'verified', { drug: 'Salbutamol inhaler', sig: '2 puffs as needed', qty: 'x1' });
  db.notifications = [];

  // ---- extra accounts for deep, multi-user testing (all password demo1234) ----
  (function addTestAccounts() {
    const H2 = () => bcrypt.hashSync('demo1234', 10);
    // more patients (2 per hospital) with app logins
    const xp = [
      { id: 'p_ada2', first: 'Adaeze', last: 'Nwafor', hn: 'GH-025500', member: 'AVN-9001-2210', dob: '1993-05-12', sex: 'female', bg: 'O+', phone: '0803 111 2020', plan: 'Avon HMO', tier: 'Standard', hmo: 'Avon HMO', address: '22 Ogunlana Dr, Surulere', homeLat: 6.4969, homeLng: 3.3552, area: 'Surulere', allergies: [], conditions: [], hospitalId: 'h_grand', email: 'adaeze@demo.ng' },
      { id: 'p_femi', first: 'Femi', last: 'Adeyemi', hn: 'GH-025533', member: '', dob: '1979-08-03', sex: 'male', bg: 'A-', phone: '0805 333 4040', plan: 'Self-pay', tier: 'Standard', hmo: '', address: '5 Adeniran Ogunsanya, Surulere', homeLat: 6.4990, homeLng: 3.3540, area: 'Surulere', allergies: ['Penicillin'], conditions: [{ name: 'Hypertension', code: 'I10', since: '2018' }], hospitalId: 'h_grand', email: 'femi@demo.ng' },
      { id: 'p_ifeoma2', first: 'Ifeoma', last: 'Chukwu', hn: 'RV-072100', member: 'HYG-5500-9911', dob: '1996-01-22', sex: 'female', bg: 'B+', phone: '0806 555 6060', plan: 'Hygeia HMO', tier: 'Premium', hmo: 'Hygeia HMO', address: '14 Admiralty Way, Lekki', homeLat: 6.4462, homeLng: 3.4766, area: 'Lekki', allergies: [], conditions: [], hospitalId: 'h_river', email: 'ifeomac@demo.ng' },
      { id: 'p_sadiq', first: 'Sadiq', last: 'Bello', hn: 'RV-072133', member: '', dob: '1990-11-09', sex: 'male', bg: 'O-', phone: '0807 777 8080', plan: 'Self-pay', tier: 'Community', hmo: '', address: '9 Addo Rd, Ajah', homeLat: 6.4702, homeLng: 3.5660, area: 'Ajah', allergies: [], conditions: [], hospitalId: 'h_river', email: 'sadiq@demo.ng' },
    ];
    xp.forEach(p => { const email = p.email; delete p.email; db.patients.push(p); db.users.push({ id: 'u_' + p.id.slice(2), role: 'patient', patientId: p.id, hospitalId: p.hospitalId, name: p.first + ' ' + p.last, email, pass: H2() }); });
    // two more verified doctors (one per hospital), with logins + fees
    const xd = [
      { id: 'doc_ngozi', userId: 'u_docngozi', name: 'Dr. Ngozi Umeh', specialty: 'General Physician', facility: 'Grandville Hospital', hospitalId: 'h_grand', area: 'Surulere', languages: ['English', 'Igbo'], fee: 6000, feeInPerson: 6000, feeVideo: 5000, rating: 4.7, reviews: 61, bio: 'Outpatient and chronic care.', available: true, slots: ['09:00', '10:00', '12:00'], status: 'verified', email: 'ngozidr@demo.ng' },
      { id: 'doc_sola', userId: 'u_docsola', name: 'Dr. Sola Martins', specialty: 'Paediatrics', facility: 'Riverside Medical Centre', hospitalId: 'h_river', area: 'Lekki', languages: ['English', 'Yoruba'], fee: 8000, feeInPerson: 8000, feeVideo: 6500, rating: 4.8, reviews: 74, bio: 'Child and newborn health.', available: true, slots: ['10:00', '11:30', '14:00'], status: 'verified', email: 'sola@demo.ng' },
    ];
    xd.forEach(d => { const email = d.email; delete d.email; db.doctors.push(d); db.users.push({ id: d.userId, role: 'doctor', doctorId: d.id, hospitalId: d.hospitalId, status: 'active', name: d.name, email, pass: H2() }); });
    // extra logistics/emergency staff so two people can run the same app per hospital
    db.users.push(
      { id: 'u_crew3', role: 'crew', hospitalId: 'h_grand', status: 'active', name: 'Grandville Crew 2', email: 'crew3@demo.ng', pass: H2() },
      { id: 'u_crew4', role: 'crew', hospitalId: 'h_river', status: 'active', name: 'Riverside Crew 2', email: 'crew4@demo.ng', pass: H2() },
      { id: 'u_rider3', role: 'rider', hospitalId: 'h_grand', status: 'active', name: 'Grandville Rider 2', email: 'rider3@demo.ng', pass: H2() },
      { id: 'u_dispatch3', role: 'dispatch', hospitalId: 'h_grand', status: 'active', name: 'Grandville Dispatch 2', email: 'dispatch3@demo.ng', pass: H2() },
      { id: 'u_chw3', role: 'chw', hospitalId: 'h_grand', status: 'active', name: 'Field Health 2', email: 'chw3@demo.ng', pass: H2() }
    );
    // give the two new ambulances so the extra crews have vehicles
    db.responders.push(
      { id: 'amb_5', name: 'Ambulance A3', type: 'Basic life support', hospitalId: 'h_grand', plate: 'LAG-556-AM', crew: 'Relief crew', area: 'Surulere', status: 'available', lat: 6.499, lng: 3.355, homeLat: 6.499, homeLng: 3.355, assignedCase: null, target: null, crewUserId: null },
      { id: 'amb_6', name: 'Ambulance R3', type: 'Basic life support', hospitalId: 'h_river', plate: 'LAG-662-AM', crew: 'Relief crew', area: 'Lekki', status: 'available', lat: 6.447, lng: 3.507, homeLat: 6.447, homeLng: 3.507, assignedCase: null, target: null, crewUserId: null }
    );
    // a further batch so every app has several concurrent testers
    const xp2 = [
      { id: 'p_ck', first: 'Chiamaka', last: 'Obi', hn: 'GH-025601', member: 'AVN-1212-3434', dob: '1991-03-17', sex: 'female', bg: 'A+', phone: '0803 210 3030', plan: 'Avon HMO', tier: 'Standard', hmo: 'Avon HMO', address: '3 Bode Thomas, Surulere', homeLat: 6.4988, homeLng: 3.3535, area: 'Surulere', allergies: [], conditions: [], hospitalId: 'h_grand', email: 'chiamaka@demo.ng' },
      { id: 'p_tj', first: 'Tunde', last: 'James', hn: 'GH-025602', member: '', dob: '1984-06-02', sex: 'male', bg: 'O+', phone: '0805 210 4040', plan: 'Self-pay', tier: 'Standard', hmo: '', address: '8 Ogunlana, Surulere', homeLat: 6.4966, homeLng: 3.3549, area: 'Surulere', allergies: [], conditions: [], hospitalId: 'h_grand', email: 'tundej@demo.ng' },
      { id: 'p_nb', first: 'Ngozi', last: 'Bassey', hn: 'RV-072201', member: 'HYG-7777-8888', dob: '1998-09-28', sex: 'female', bg: 'B+', phone: '0806 210 5050', plan: 'Hygeia HMO', tier: 'Premium', hmo: 'Hygeia HMO', address: '16 Admiralty, Lekki', homeLat: 6.4460, homeLng: 3.4768, area: 'Lekki', allergies: [], conditions: [], hospitalId: 'h_river', email: 'ngozib@demo.ng' },
      { id: 'p_ak', first: 'Abdul', last: 'Kareem', hn: 'RV-072202', member: '', dob: '1989-12-14', sex: 'male', bg: 'AB+', phone: '0807 210 6060', plan: 'Self-pay', tier: 'Community', hmo: '', address: '11 Addo Rd, Ajah', homeLat: 6.4705, homeLng: 3.5665, area: 'Ajah', allergies: [], conditions: [], hospitalId: 'h_river', email: 'abdul@demo.ng' },
    ];
    xp2.forEach(p => { const email = p.email; delete p.email; db.patients.push(p); db.users.push({ id: 'u_' + p.id.slice(2), role: 'patient', patientId: p.id, hospitalId: p.hospitalId, name: p.first + ' ' + p.last, email, pass: H2() }); });
    db.users.push(
      { id: 'u_pharm_g3', role: 'pharmacy', hospitalId: 'h_grand', status: 'active', name: 'Grandville Pharmacy 3', email: 'pharmacy4@demo.ng', pass: H2() },
      { id: 'u_lab_g3', role: 'lab', hospitalId: 'h_grand', status: 'active', name: 'Grandville Lab 3', email: 'lab4@demo.ng', pass: H2() },
      { id: 'u_recept_g3', role: 'frontdesk', subrole: 'receptionist', hospitalId: 'h_grand', status: 'active', name: 'Grandville Reception 4', email: 'reception4@demo.ng', pass: H2() },
      { id: 'u_rider_r2', role: 'rider', hospitalId: 'h_river', status: 'active', name: 'Riverside Rider 2', email: 'rider4@demo.ng', pass: H2() }
    );
  })();

  store.save();
  return db;
}

if (require.main === module) { seed(true); console.log('Seeded', store.FILE); }
module.exports = seed;
