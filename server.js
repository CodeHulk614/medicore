'use strict';
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const store = require('./store');
const seed = require('./seed');
const X = require('./integrations');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const PORT = process.env.PORT || 4000;
const BUILD = '2026-08-31 background-refresh+clock-gate';

seed();                 // ensure a starting record exists
// auto-seed on a fresh deploy so demo logins work immediately
if (!store.get().users || store.get().users.length === 0) { seed(true); }
const db = store.get();
const uid = p => p + '_' + Math.random().toString(36).slice(2, 9);

const app = express();
app.use(cors());
app.use(express.json());

/* ---- auth ---- */
function sign(user) { return jwt.sign({ id: user.id, role: user.role, patientId: user.patientId, doctorId: user.doctorId, hospitalId: user.hospitalId, status: user.status }, JWT_SECRET, { expiresIn: '30d' }); }
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'Sign in required' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch (e) { res.status(401).json({ error: 'Session expired, sign in again' }); }
}

app.post('/api/auth/register', async (req, res) => {
  // Patients cannot self-register. A hospital front desk registers a patient in person,
  // which attaches them to exactly one hospital.
  return res.status(403).json({ error: 'Patients are registered at a hospital front desk. Please visit or contact your hospital to be added.' });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.find(u => u.email === (email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.pass)) return res.status(401).json({ error: 'Wrong email or password' });
  res.json({ token: sign(user) });
});

/* ---- patient-scoped helpers ---- */
function mine(req, coll) { return db[coll].filter(x => x.patientId === req.user.patientId); }
function patient(req) { return db.patients.find(p => p.id === req.user.patientId); }

/* ---- multi-tenancy + presence + modules ---- */
function hospitalId(req) { return req.user.hospitalId; }
function hospitalById(id) { return (db.hospitals || []).find(h => h.id === id); }
function hospitalName(id) { const h = hospitalById(id); return h ? h.name : ''; }
function moduleEnabled(hid, key) { const h = hospitalById(hid); return !h || !h.modules || h.modules[key] !== false; }
function patientHospitals(p) { return (p && p.hospitalId) ? [p.hospitalId] : []; }
const ONLINE_MS = 35000;
function isOnline(userId) { return !!(db.presence && (Date.now() - (db.presence[userId] || 0) < ONLINE_MS)); }
function doctorUserId(doctorId) { const d = db.doctors.find(x => x.id === doctorId); return d ? d.userId : null; }
function ping(req) { if (!db.presence) db.presence = {}; db.presence[req.user.id] = Date.now(); }
function doctorOnline(doctorId) { const uid = doctorUserId(doctorId); return uid ? isOnline(uid) : false; }

/* ---- optional server-side clock-in enforcement (set ENFORCE_CLOCKIN=1) ----
 * When on, a clock-in staff role cannot perform write actions on their app's
 * endpoints until they have an open shift. Off by default so the demo and the
 * automated tests run without every actor having to clock in first. The in-app
 * clock-in lock (client) is always active regardless of this flag. */
const CLOCK_ROLES = ['pharmacy', 'lab', 'dispatch', 'rider', 'chw', 'frontdesk', 'doctor'];
const STAFF_WRITE_RE = /^\/api\/(pharm|lab|dispatch|rider|chw|frontdesk|doc)\//;
function openShiftFor(userId) { return db.shifts && db.shifts.find(s => s.userId === userId && !s.clockOut); }
app.use((req, res, next) => {
  if (process.env.ENFORCE_CLOCKIN !== '1') return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!STAFF_WRITE_RE.test(req.path)) return next();
  if (/\/shift\/(clockin|clockout)/.test(req.path)) return next();
  const h = req.headers.authorization || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return next();
  let u; try { u = jwt.verify(t, JWT_SECRET); } catch (e) { return next(); }
  if (!CLOCK_ROLES.includes(u.role)) return next();
  if (openShiftFor(u.id)) return next();
  return res.status(423).json({ error: 'Clock in to start your shift before doing this.' });
});

/* ---- the one bundle the app loads on open ---- */
app.get('/api/me/bundle', auth, (req, res) => {
  const p = patient(req);
  res.json({
    me: p ? Object.assign({}, p, { hospitalName: p.hospitalId ? hospitalName(p.hospitalId) : null }) : p,
    appointments: mine(req, 'appointments').map(a => Object.assign({}, a, joinability(a))),
    prescriptions: mine(req, 'prescriptions'),
    deliveries: mine(req, 'deliveries'),
    benefits: db.benefits,
    authorizations: mine(req, 'authorizations'),
    claims: mine(req, 'claims'),
    bills: mine(req, 'bills'),
    results: mine(req, 'results'),
    visits: mine(req, 'visits'),
    messages: mine(req, 'messages'),
    providers: db.providers,
    wearables: (db.wearables || []).filter(w => w.patientId === p.id).slice(-50),
  });
});

/* ---- appointments ---- */
// turn a fuzzy "day" + "HH:MM" into an absolute timestamp for scheduling/time-gates
function slotToTs(day, time) {
  const now = new Date(); const d = new Date(now);
  const dl = (day || '').toLowerCase();
  if (dl.includes('today') || dl.includes('now')) { /* today */ }
  else if (dl.includes('tomorrow')) d.setDate(d.getDate() + 1);
  else if (/in (\d+) day/.test(dl)) d.setDate(d.getDate() + parseInt(RegExp.$1, 10));
  else d.setDate(d.getDate() + 1);
  const m = (time || '').match(/(\d{1,2}):(\d{2})/);
  if (m) { d.setHours(+m[1], +m[2], 0, 0); if (d.getTime() < now.getTime() && !dl) d.setDate(d.getDate() + 1); }
  else { d.setTime(now.getTime() + 60 * 60000); }
  return d.getTime();
}
app.post('/api/appointments', auth, async (req, res) => {
  const { dept, type, day, time } = req.body || {};
  const a = { id: uid('a'), patientId: req.user.patientId, dept: dept || 'General consultation', doctor: 'Next available',
    type: type || 'in-person', date: day || 'Tomorrow', time: time || '10:00', where: type === 'video' ? 'Video visit' : 'Grandville Hospital', status: 'booked', scheduledAt: slotToTs(day, time) };
  db.appointments.push(a);
  db.events.push({ id: uid('e'), kind: 'appointment.booked', patientId: req.user.patientId, ref: a.id, at: Date.now() });
  store.save();
  const p = patient(req);
  await X.sendSMS({ to: p.phone, text: `MediCore: your ${a.type} visit is booked for ${a.date} at ${a.time}.` });
  res.json(a);
});

/* ---- prescriptions & refills ---- */
app.post('/api/prescriptions/:id/refill', auth, (req, res) => {
  const rx = db.prescriptions.find(x => x.id === req.params.id && x.patientId === req.user.patientId);
  if (!rx) return res.status(404).json({ error: 'Prescription not found' });
  const d = { id: uid('d'), patientId: req.user.patientId, drug: rx.drug + ' x30', stage: 0 };
  db.deliveries.unshift(d); store.save();
  res.json(d);
});
app.post('/api/deliveries/:id/advance', auth, (req, res) => {
  const d = db.deliveries.find(x => x.id === req.params.id && x.patientId === req.user.patientId);
  if (!d) return res.status(404).json({ error: 'Delivery not found' });
  if (d.stage < 3) d.stage++; store.save();
  res.json(d);
});

/* ---- messages ---- */
app.post('/api/messages', auth, (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Message is empty' });
  const m = { id: uid('m'), patientId: req.user.patientId, from: 'me', text, when: 'now' };
  db.messages.push(m);
  // simulated care-team ack; a real clinician reply comes from the hospital app
  const reply = { id: uid('m'), patientId: req.user.patientId, from: 'them', who: 'Care team', text: 'Thanks, a member of the team will reply shortly.', when: 'now' };
  db.messages.push(reply); store.save();
  res.json({ sent: m, reply });
});

/* ---- bills & payments ---- */
app.post('/api/bills/:id/pay', auth, async (req, res) => {
  const bill = db.bills.find(b => b.id === req.params.id && b.patientId === req.user.patientId);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  const p = patient(req);
  const ref = 'MC' + Date.now();
  const pay = await X.initPayment({ email: (db.users.find(u => u.patientId === p.id) || {}).email, amount: bill.amount, reference: ref });
  db.payments.push({ id: uid('pay'), patientId: p.id, amount: bill.amount, reference: ref, method: req.body && req.body.method, mode: pay.mode, at: Date.now() });
  db.bills = db.bills.filter(b => b.id !== bill.id);
  db.claims.unshift({ id: uid('c'), patientId: p.id, what: 'Payment (your share)', amount: bill.amount, status: 'Paid', when: 'Just now' });
  store.save();
  res.json({ ok: true, payment: pay, authorization_url: pay.authorization_url });
});

/* ---- video visit ---- */
app.post('/api/video/room', auth, async (req, res) => {
  const room = await X.createVideoRoom({ name: 'visit-' + req.user.patientId.slice(-6) });
  res.json(room);
});

/* ---- real WebRTC signalling relay (HTTP long-ish poll) ----
 * room id = appointment id. The patient is the caller (offerer), the doctor the answerer.
 * Signals (offer/answer/ICE candidates) are relayed in-memory between the two peers. */
const videoRooms = {};
function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) list.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
  return list;
}
function videoAccess(req, appt) {
  if (req.user.patientId && appt.patientId === req.user.patientId) return 'patient';
  if (req.user.role === 'doctor') { const d = db.doctors.find(x => x.userId === req.user.id); if (!appt.doctorId || (d && appt.doctorId === d.id)) return 'doctor'; }
  return null;
}
app.post('/api/video/:room/join', auth, (req, res) => {
  const appt = db.appointments.find(a => a.id === req.params.room);
  if (!appt) return res.status(404).json({ error: 'Visit not found' });
  const role = videoAccess(req, appt);
  if (!role) return res.status(403).json({ error: 'Not your visit' });
  const j = joinability(appt);
  if (!j.joinable) return res.status(425).json({ error: 'This visit opens at ' + new Date(appt.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
  const r = videoRooms[appt.id] || (videoRooms[appt.id] = { seq: 0, signals: [], parties: {} });
  r.parties[role] = Date.now();
  const peer = role === 'patient' ? 'doctor' : 'patient';
  res.json({ role, iceServers: iceServers(), peerPresent: !!(r.parties[peer] && Date.now() - r.parties[peer] < 15000), room: appt.id });
});
app.post('/api/video/:room/signal', auth, (req, res) => {
  const appt = db.appointments.find(a => a.id === req.params.room); if (!appt) return res.status(404).json({ error: 'Visit not found' });
  const role = videoAccess(req, appt); if (!role) return res.status(403).json({ error: 'Not your visit' });
  const r = videoRooms[appt.id] || (videoRooms[appt.id] = { seq: 0, signals: [], parties: {} });
  r.parties[role] = Date.now();
  const b = req.body || {};
  if (!['offer', 'answer', 'candidate', 'bye'].includes(b.kind)) return res.status(400).json({ error: 'Bad signal' });
  r.signals.push({ id: ++r.seq, from: role, kind: b.kind, data: b.data, at: Date.now() });
  if (r.signals.length > 200) r.signals = r.signals.slice(-120);
  res.json({ ok: true, seq: r.seq });
});
app.get('/api/video/:room/poll', auth, (req, res) => {
  const appt = db.appointments.find(a => a.id === req.params.room); if (!appt) return res.status(404).json({ error: 'Visit not found' });
  const role = videoAccess(req, appt); if (!role) return res.status(403).json({ error: 'Not your visit' });
  const r = videoRooms[appt.id] || (videoRooms[appt.id] = { seq: 0, signals: [], parties: {} });
  r.parties[role] = Date.now();
  const since = parseInt(req.query.since, 10) || 0;
  const peer = role === 'patient' ? 'doctor' : 'patient';
  const out = r.signals.filter(s => s.id > since && s.from !== role);
  res.json({ signals: out, since: r.seq, peerPresent: !!(r.parties[peer] && Date.now() - r.parties[peer] < 15000) });
});
// Time gate: a scheduled visit (video or appointment) cannot be joined/started before its time.
// A 10-minute grace window before the slot is allowed.
const JOIN_GRACE_MS = 10 * 60000;
function joinability(a) {
  if (!a || !a.scheduledAt) return { joinable: true, opensAt: null };
  const opensAt = a.scheduledAt - JOIN_GRACE_MS;
  return { joinable: Date.now() >= opensAt, opensAt, scheduledAt: a.scheduledAt };
}
app.post('/api/appointments/:id/join', auth, async (req, res) => {
  const a = db.appointments.find(x => x.id === req.params.id && x.patientId === req.user.patientId);
  if (!a) return res.status(404).json({ error: 'Appointment not found' });
  const j = joinability(a);
  if (!j.joinable) {
    const t = new Date(a.scheduledAt);
    return res.status(425).json({ error: 'This visit opens at ' + t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '. Please come back then.', opensAt: j.opensAt, scheduledAt: a.scheduledAt });
  }
  a.status = 'in-progress';
  let room = null; if (a.type === 'video') room = await X.createVideoRoom({ name: 'visit-' + a.id.slice(-6) });
  store.save();
  res.json({ ok: true, appointment: a, room });
});

/* ============================================================
 * HOSPITAL side of the SAME record. This is what proves patient
 * and hospital share one source of truth: a booking the patient
 * makes appears here immediately. A real clinician app would use
 * these endpoints (role-gated to staff).
 * ============================================================ */
function staff(req, res, next) { if (req.user.role === 'patient') return res.status(403).json({ error: 'Staff only' }); next(); }
app.get('/api/hospital/appointments', auth, staff, (req, res) => res.json(db.appointments));
app.get('/api/hospital/patients', auth, staff, (req, res) => res.json(db.patients));
app.post('/api/hospital/messages/reply', auth, staff, (req, res) => {
  const { patientId, text, who } = req.body || {};
  const m = { id: uid('m'), patientId, from: 'them', who: who || 'Dr. Tunde Bello', text, when: 'now' };
  db.messages.push(m); store.save(); res.json(m);
});

/* ============================================================
 * DOCTOR MARKETPLACE (discover and book any listed clinician)
 * ============================================================ */
app.get('/api/doctors', auth, (req, res) => {
  const q = (req.query.q || '').toLowerCase(), spec = req.query.specialty, lang = req.query.language;
  const hids = patientHospitals(patient(req)).filter(h => moduleEnabled(h, 'marketplace'));
  let list = db.doctors.filter(d => (d.status || 'verified') === 'verified' && hids.includes(d.hospitalId));
  if (q) list = list.filter(d => (d.name + ' ' + d.specialty + ' ' + d.facility + ' ' + d.area).toLowerCase().includes(q));
  if (spec && spec !== 'All') list = list.filter(d => d.specialty === spec);
  if (lang && lang !== 'All') list = list.filter(d => d.languages.includes(lang));
  res.json(list.map(d => ({ ...d, userId: undefined, hospitalName: hospitalName(d.hospitalId), online: doctorOnline(d.id) })));
});
app.get('/api/doctors/:id', auth, (req, res) => {
  const d = db.doctors.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'Doctor not found' });
  res.json({ ...d, userId: undefined });
});

/* book any marketplace doctor (extends the earlier appointment route) */
app.post('/api/marketplace/book', auth, async (req, res) => {
  const { doctorId, type, day, time } = req.body || {};
  const d = db.doctors.find(x => x.id === doctorId);
  if (!d) return res.status(404).json({ error: 'Doctor not found' });
  const fee = type === 'video' ? (d.feeVideo != null ? d.feeVideo : d.fee) : (d.feeInPerson != null ? d.feeInPerson : d.fee);
  const a = { id: uid('a'), patientId: req.user.patientId, doctorId, dept: d.specialty, doctor: d.name,
    type: type || 'in-person', date: day || 'Tomorrow', time: time || (d.slots[0] || '10:00'),
    where: type === 'video' ? 'Video visit' : d.facility, status: 'booked', fee: fee, scheduledAt: slotToTs(day, time || (d.slots[0] || '10:00')) };
  db.appointments.push(a);
  db.events.push({ id: uid('e'), kind: 'marketplace.booked', patientId: req.user.patientId, doctorId, ref: a.id, at: Date.now() });
  store.save();
  const p = patient(req);
  await X.sendSMS({ to: p.phone, text: `MediCore: your ${a.type} visit with ${d.name} is booked for ${a.date} at ${a.time}.` });
  res.json(a);
});

/* ============================================================
 * DOCTOR APP API (provider side, doctor token)
 * ============================================================ */
function doctorOnly(req, res, next) { if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Doctors only' }); const u = db.users.find(x => x.id === req.user.id); if (u && u.status === 'pending') return res.status(403).json({ error: 'Your account is awaiting admin approval' }); next(); }
function myDoctor(req) { return db.doctors.find(d => d.id === req.user.doctorId) || db.doctors.find(d => d.userId === req.user.id); }

app.get('/api/doc/me', auth, doctorOnly, (req, res) => {
  const d = myDoctor(req);
  const appts = db.appointments.filter(a => a.doctorId === (d && d.id));
  const earnings = appts.filter(a => a.status === 'completed').reduce((s, a) => s + (a.fee != null ? a.fee : (d ? d.fee : 0)), 0);
  res.json({ doctor: d, fees: d ? { feeInPerson: d.feeInPerson != null ? d.feeInPerson : d.fee, feeVideo: d.feeVideo != null ? d.feeVideo : d.fee } : null, stats: { today: appts.length, completed: appts.filter(a => a.status === 'completed').length, earnings } });
});
// doctor sets their own consultation fees (separate in-person and video pricing)
app.post('/api/doc/fees', auth, doctorOnly, (req, res) => {
  const d = myDoctor(req); if (!d) return res.status(404).json({ error: 'Doctor profile not found' });
  const b = req.body || {};
  const ip = Number(b.feeInPerson), vid = Number(b.feeVideo);
  if (!(ip >= 0) || !(vid >= 0) || ip > 1000000 || vid > 1000000) return res.status(400).json({ error: 'Enter valid fees (0 or more)' });
  d.feeInPerson = Math.round(ip); d.feeVideo = Math.round(vid); d.fee = d.feeInPerson;
  store.save();
  res.json({ ok: true, fees: { feeInPerson: d.feeInPerson, feeVideo: d.feeVideo } });
});
app.get('/api/doc/schedule', auth, doctorOnly, (req, res) => {
  const d = myDoctor(req);
  res.json(db.appointments.filter(a => a.doctorId === (d && d.id)).map(a => Object.assign({}, a, joinability(a))));
});
app.get('/api/doc/patients', auth, doctorOnly, (req, res) => {
  const d = myDoctor(req);
  const ids = new Set(db.appointments.filter(a => a.doctorId === (d && d.id)).map(a => a.patientId));
  db.messages.forEach(m => ids.add(m.patientId));
  res.json(db.patients.filter(p => ids.has(p.id)));
});
app.get('/api/doc/thread/:patientId', auth, doctorOnly, (req, res) => {
  res.json(db.messages.filter(m => m.patientId === req.params.patientId));
});
app.post('/api/doc/reply', auth, doctorOnly, async (req, res) => {
  const { patientId, text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Message is empty' });
  const d = myDoctor(req);
  const m = { id: uid('m'), patientId, from: 'them', who: d ? d.name : 'Care team', text, when: 'now' };
  db.messages.push(m); store.save();
  const p = db.patients.find(x => x.id === patientId);
  if (p) await X.sendSMS({ to: p.phone, text: `MediCore: new message from ${m.who}.` });
  res.json(m);
});
app.post('/api/doc/appointments/:id/complete', auth, doctorOnly, (req, res) => {
  const a = db.appointments.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Appointment not found' });
  a.status = 'completed';
  db.visits.push({ id: uid('v'), patientId: a.patientId, reason: (req.body && req.body.reason) || a.dept, doctor: a.doctor, when: 'Just now' });
  store.save();
  res.json(a);
});
app.post('/api/doc/availability', auth, doctorOnly, (req, res) => {
  const d = myDoctor(req);
  if (d) d.available = !!(req.body && req.body.available);
  store.save();
  res.json({ available: d ? d.available : false });
});

/* ============================================================
 * ANALYTICS (aggregate, de-identified population view)
 * ============================================================ */
app.get('/api/analytics', auth, (req, res) => {
  const bySpecialty = {}, byArea = {};
  db.appointments.forEach(a => { bySpecialty[a.dept] = (bySpecialty[a.dept] || 0) + 1; });
  db.doctors.forEach(d => { byArea[d.area] = (byArea[d.area] || 0) + 1; });
  const conditions = {};
  db.patients.forEach(p => (p.conditions || []).forEach(c => { conditions[c.name] = (conditions[c.name] || 0) + 1; }));
  res.json({
    generatedAt: Date.now(),
    totals: { patients: db.patients.length, doctors: db.doctors.length, appointments: db.appointments.length, visits: db.visits.length },
    appointmentsBySpecialty: bySpecialty,
    doctorsByArea: byArea,
    diseaseBurden: conditions,
    note: 'Aggregate counts only. No personal identifiers are included in this response.',
  });
});

/* ============================================================
 * WEARABLES (ingest device metrics, patient reads them back)
 * ============================================================ */
app.post('/api/wearables', auth, (req, res) => {
  const { type, value, unit } = req.body || {};
  if (!type || value == null) return res.status(400).json({ error: 'type and value are required' });
  const w = { id: uid('w'), patientId: req.user.patientId, type, value, unit: unit || '', at: Date.now() };
  db.wearables.push(w); store.save();
  res.json(w);
});
app.get('/api/wearables', auth, (req, res) => {
  res.json(db.wearables.filter(w => w.patientId === req.user.patientId).slice(-50));
});

/* ============================================================
 * USSD (feature-phone access, no internet). A telco aggregator
 * POSTs {sessionId, phoneNumber, text} on each keypress; we reply
 * with a menu. Prefix "CON " keeps the session open, "END " closes.
 * ============================================================ */
app.post('/api/ussd', (req, res) => {
  const { sessionId, phoneNumber, text } = req.body || {};
  const steps = (text || '').split('*').filter(s => s !== '');
  res.set('Content-Type', 'text/plain');
  const patient = db.patients.find(p => (p.phone || '').replace(/\s/g, '').endsWith((phoneNumber || '').replace(/\s/g, '').slice(-7)));
  if (steps.length === 0) {
    return res.send('CON MediCore\n1. My cover balance\n2. Find a hospital\n3. Book a visit\n4. Request a refill');
  }
  if (steps[0] === '1') {
    const used = (db.benefits || []).reduce((s, b) => s + b.used, 0), lim = (db.benefits || []).reduce((s, b) => s + b.limit, 0);
    return res.send('END Cover: ' + (patient ? patient.plan : 'Active') + '\nRemaining: N' + (lim - used).toLocaleString());
  }
  if (steps[0] === '2') {
    return res.send('END Nearest covered:\n' + db.providers.filter(p => p.covered).slice(0, 3).map(p => p.name + ' (' + p.area + ')').join('\n'));
  }
  if (steps[0] === '3') {
    if (steps.length === 1) return res.send('CON Choose a doctor:\n' + db.doctors.slice(0, 3).map((d, i) => (i + 1) + '. ' + d.name.replace('Dr. ', '') + ' (' + d.specialty + ')').join('\n'));
    const d = db.doctors[parseInt(steps[1], 10) - 1];
    if (d && patient) { db.appointments.push({ id: uid('a'), patientId: patient.id, doctorId: d.id, dept: d.specialty, doctor: d.name, type: 'in-person', date: 'Tomorrow', time: d.slots[0] || '10:00', where: d.facility, status: 'booked' }); store.save(); }
    return res.send('END Booked with ' + (d ? d.name : 'the next available doctor') + ' for tomorrow. You will get an SMS.');
  }
  if (steps[0] === '4') {
    return res.send('END Refill requested. The pharmacy will confirm by SMS.');
  }
  res.send('END Sorry, that option was not recognised.');
});

/* collections that may be missing on an older db file */
['inventory', 'laborders', 'settlements', 'audit'].forEach(k => { if (!db[k]) db[k] = []; });
function roleOnly(role) { return (req, res, next) => {
  if (req.user.role !== role) return res.status(403).json({ error: 'Not allowed for this account' });
  const u = db.users.find(x => x.id === req.user.id);
  if (u && u.status === 'pending') return res.status(403).json({ error: 'Your account is awaiting admin approval' });
  next();
}; }
function pname(id) { const p = db.patients.find(x => x.id === id); return p ? (p.first + ' ' + p.last) : 'Patient'; }
function logAudit(actor, action, detail) { db.audit.unshift({ id: uid('ad'), actor, action, detail, at: Date.now() }); if (db.audit.length > 200) db.audit.pop(); }

/* ============================================================
 * ADMIN / OPERATIONS  (scoped to the admin's own hospital)
 * ============================================================ */
function adminHid(req) { return req.user.hospitalId; }
const { permsFor: staffPerms } = require('./perms');
function requirePerm(perm) {
  return (req, res, next) => {
    const u = db.users.find(x => x.id === req.user.id);
    if (!u) return res.status(401).json({ error: 'Sign in required' });
    if (u.status === 'pending') return res.status(403).json({ error: 'Your account is awaiting admin approval' });
    if (!staffPerms(u).includes(perm)) return res.status(403).json({ error: 'Your role does not have access to this' });
    next();
  };
}
function hospDoctors(hid) { return db.doctors.filter(d => d.hospitalId === hid); }
function hospPatients(hid) { return db.patients.filter(p => p.hospitalId === hid); }
function hospStaff(hid) { return db.users.filter(u => u.hospitalId === hid && u.role !== 'patient'); }
app.get('/api/admin/overview', auth, requirePerm('admin.overview'), (req, res) => {
  const hid = adminHid(req);
  const docs = hospDoctors(hid);
  const pIds = new Set(hospPatients(hid).map(p => p.id));
  res.json({
    hospital: hospitalName(hid),
    modules: (hospitalById(hid) || {}).modules || {},
    doctors: { verified: docs.filter(d => d.status === 'verified').length, pending: docs.filter(d => d.status === 'pending').length },
    facilities: { verified: (db.providers || []).filter(p => p.status === 'verified').length, pending: (db.providers || []).filter(p => p.status === 'pending').length },
    staff: { active: hospStaff(hid).filter(u => u.status === 'active').length, pending: hospStaff(hid).filter(u => u.status === 'pending').length },
    patients: hospPatients(hid).length,
    appointments: db.appointments.filter(a => pIds.has(a.patientId)).length,
    claims: db.claims.filter(c => pIds.has(c.patientId)).length,
    audit: db.audit.slice(0, 8),
    ops: (() => { const sod = new Date(); sod.setHours(0, 0, 0, 0); const ds = sod.getTime();
      const q = (db.queue || []).filter(e => e.hospitalId === hid);
      return { waiting: q.filter(e => e.status === 'waiting').length, withDoctor: q.filter(e => e.status === 'in_progress').length,
        seenToday: q.filter(e => e.status === 'done' && (e.doneAt || 0) >= ds).length,
        onDuty: (db.shifts || []).filter(s => !s.clockOut && s.hospitalId === hid).length,
        activeEmergencies: (db.emergencies || []).filter(e => e.hospitalId === hid && e.status !== 'closed').length,
        claimsToday: db.claims.filter(c => pIds.has(c.patientId)).length }; })(),
    permissions: staffPerms(db.users.find(u => u.id === req.user.id)),
    roleLabel: (require('./perms').SUBROLE_LABEL[(db.users.find(u => u.id === req.user.id) || {}).subrole]) || 'Hospital admin',
  });
});
app.get('/api/admin/doctors', auth, requirePerm('admin.doctors'), (req, res) => res.json(hospDoctors(adminHid(req))));
app.post('/api/admin/doctors/:id/verify', auth, requirePerm('admin.doctors'), (req, res) => {
  const d = db.doctors.find(x => x.id === req.params.id && x.hospitalId === adminHid(req)); if (!d) return res.status(404).json({ error: 'Doctor not found in your hospital' });
  d.status = req.body && req.body.approve ? 'verified' : 'rejected';
  const u = db.users.find(x => x.id === d.userId); if (u) u.status = d.status === 'verified' ? 'active' : 'rejected';
  logAudit(hospitalName(adminHid(req)), 'doctor.' + d.status, d.name); store.save(); res.json(d);
});
app.get('/api/admin/facilities', auth, requirePerm('admin.facilities'), (req, res) => res.json(db.providers.map((p, i) => ({ ...p, _i: i }))));
app.post('/api/admin/facilities/:i/verify', auth, requirePerm('admin.facilities'), (req, res) => {
  const p = db.providers[parseInt(req.params.i, 10)]; if (!p) return res.status(404).json({ error: 'Facility not found' });
  p.status = req.body && req.body.approve ? 'verified' : 'rejected';
  logAudit('Operations', 'facility.' + p.status, p.name); store.save(); res.json(p);
});
app.get('/api/admin/settlements', auth, requirePerm('admin.settlements'), (req, res) => {
  const rows = db.doctors.map(d => {
    const done = db.appointments.filter(a => a.doctorId === d.id && a.status === 'completed');
    const gross = done.length * (d.fee || 0);
    const paid = db.settlements.filter(s => s.doctorId === d.id).reduce((s2, x) => s2 + x.amount, 0);
    return { doctorId: d.id, name: d.name, visits: done.length, gross, paid, due: gross - paid };
  }).filter(r => r.gross > 0);
  res.json(rows);
});
app.post('/api/admin/settlements/pay', auth, requirePerm('admin.settlements'), (req, res) => {
  const d = db.doctors.find(x => x.id === (req.body && req.body.doctorId)); if (!d) return res.status(404).json({ error: 'Doctor not found' });
  const done = db.appointments.filter(a => a.doctorId === d.id && a.status === 'completed').length;
  const gross = done * (d.fee || 0);
  const paid = db.settlements.filter(s => s.doctorId === d.id).reduce((s2, x) => s2 + x.amount, 0);
  const due = gross - paid; if (due <= 0) return res.status(400).json({ error: 'Nothing due' });
  db.settlements.push({ id: uid('st'), doctorId: d.id, amount: due, at: Date.now() });
  logAudit('Operations', 'payout', d.name + ' ' + due); store.save(); res.json({ paid: due });
});
app.get('/api/admin/users', auth, requirePerm('admin.staff'), (req, res) => res.json(db.users.map(u => ({ id: u.id, role: u.role, name: u.name, email: u.email }))));

/* ============================================================
 * HMO / PAYER
 * ============================================================ */
function payerHmo(req) { const u = db.users.find(x => x.id === req.user.id); return u ? u.hmo : null; }
app.get('/api/payer/overview', auth, roleOnly('payer'), (req, res) => {
  const hmo = payerHmo(req);
  const members = db.patients.filter(p => p.hmo === hmo);
  const memberIds = new Set(members.map(m => m.id));
  const claims = db.claims.filter(c => memberIds.has(c.patientId));
  const byStatus = {}; claims.forEach(c => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });
  const amountByStatus = {}; claims.forEach(c => { amountByStatus[c.status] = (amountByStatus[c.status] || 0) + (c.amount || 0); });
  const flagged = claims.filter(c => c.amount >= 100000).length;
  res.json({ hmo, members: members.length, pendingAuths: db.authorizations.filter(a => memberIds.has(a.patientId) && a.status === 'Pending').length,
    claims: claims.length, claimsByStatus: byStatus, amountByStatus,
    pendingAmount: (amountByStatus['Pending'] || 0) + (amountByStatus['Processing'] || 0),
    approvedAmount: amountByStatus['Approved'] || 0,
    spend: claims.filter(c => c.status === 'Paid').reduce((s, c) => s + c.amount, 0), flagged });
});
app.get('/api/payer/members', auth, roleOnly('payer'), (req, res) => {
  const hmo = payerHmo(req);
  res.json(db.patients.filter(p => p.hmo === hmo).map(p => ({ id: p.id, name: p.first + ' ' + p.last, member: p.member, tier: p.tier,
    used: db.benefits.reduce((s, b) => s + b.used, 0), limit: db.benefits.reduce((s, b) => s + b.limit, 0) })));
});
app.get('/api/payer/authorizations', auth, roleOnly('payer'), (req, res) => {
  const hmo = payerHmo(req); const ids = new Set(db.patients.filter(p => p.hmo === hmo).map(p => p.id));
  res.json(db.authorizations.filter(a => ids.has(a.patientId)).map(a => ({ ...a, patient: pname(a.patientId) })));
});
app.post('/api/payer/authorizations/:id/decide', auth, roleOnly('payer'), (req, res) => {
  const a = db.authorizations.find(x => x.id === req.params.id); if (!a) return res.status(404).json({ error: 'Not found' });
  a.status = req.body && req.body.approve ? 'Approved' : 'Denied';
  logAudit(payerHmo(req), 'auth.' + a.status, a.what); store.save(); res.json(a);
});
app.get('/api/payer/claims', auth, roleOnly('payer'), (req, res) => {
  const hmo = payerHmo(req); const ids = new Set(db.patients.filter(p => p.hmo === hmo).map(p => p.id));
  res.json(db.claims.filter(c => ids.has(c.patientId)).map(c => ({ ...c, patient: pname(c.patientId), flag: c.amount >= 100000 })));
});
app.post('/api/payer/claims/:id/adjudicate', auth, roleOnly('payer'), (req, res) => {
  const c = db.claims.find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: 'Not found' });
  const approve = !!(req.body && req.body.approve);
  c.status = approve ? 'Paid' : 'Denied';
  if (approve) { const b = db.benefits[0]; if (b) b.used = Math.min(b.limit, b.used + Math.round(c.amount * 0.0)); } // benefit already reserved when raised
  logAudit(payerHmo(req), 'claim.' + c.status, c.what + ' ' + c.amount); store.save(); res.json(c);
});

/* patient raises a pre-authorization request (payer sees it) */
app.post('/api/authorizations', auth, (req, res) => {
  const { what, where } = req.body || {};
  if (!what) return res.status(400).json({ error: 'What is being authorised?' });
  const a = { id: uid('au'), patientId: req.user.patientId, what, where: where || 'Grandville Hospital', status: 'Pending', when: 'now' };
  db.authorizations.push(a); store.save(); res.json(a);
});

/* ============================================================
 * PHARMACY
 * ============================================================ */
function staffFacility(req) { const u = db.users.find(x => x.id === req.user.id); return u ? u.facility : null; }
/* pharmacy overview + queue + dispense lifecycle now live in spine.js (unified orders) */
app.get('/api/pharm/inventory', auth, roleOnly('pharmacy'), (req, res) => res.json(db.inventory.filter(i => i.facility === staffFacility(req))));
app.post('/api/pharm/inventory/:id/adjust', auth, roleOnly('pharmacy'), (req, res) => {
  const i = db.inventory.find(x => x.id === req.params.id); if (!i) return res.status(404).json({ error: 'Item not found' });
  i.stock = Math.max(0, i.stock + parseInt((req.body && req.body.delta) || 0, 10)); store.save(); res.json(i);
});

/* ============================================================
 * LAB / DIAGNOSTICS
 * ============================================================ */
/* lab overview/orders/collect/result + doctor order entry now live in spine.js (unified orders) */

/* collections that may be missing on an older db file */
['responders', 'emergencies'].forEach(k => { if (!db[k]) db[k] = []; });

/* ============================================================
 * DELIVERY / RIDER
 * ============================================================ */
app.get('/api/rider/jobs', auth, roleOnly('rider'), (req, res) => {
  res.json(db.deliveries.filter(d => (d.stage || 1) < 4).map(d => ({ ...d, patient: pname(d.patientId), mine: d.assignedTo === req.user.id })));
});
app.post('/api/rider/jobs/:id/accept', auth, roleOnly('rider'), (req, res) => {
  const d = db.deliveries.find(x => x.id === req.params.id); if (!d) return res.status(404).json({ error: 'Job not found' });
  d.assignedTo = req.user.id; if ((d.stage || 1) < 2) d.stage = 2;
  logAudit('Rider', 'delivery.accepted', d.drug); store.save(); res.json(d);
});
app.post('/api/rider/deliveries/:id/advance', auth, roleOnly('rider'), async (req, res) => {
  const d = db.deliveries.find(x => x.id === req.params.id); if (!d) return res.status(404).json({ error: 'Job not found' });
  if (d.assignedTo && d.assignedTo !== req.user.id) return res.status(403).json({ error: 'Assigned to another rider' });
  d.assignedTo = d.assignedTo || req.user.id; d.stage = Math.min(4, (d.stage || 1) + 1);
  if (d.stage === 4) { await X.sendSMS({ to: (db.patients.find(p => p.id === d.patientId) || {}).phone, text: 'MediCore: your medication ' + d.drug + ' has been delivered.' }); logAudit('Rider', 'delivery.delivered', d.drug); }
  store.save(); res.json(d);
});

/* ============================================================
 * EMERGENCY / DISPATCH
 * ============================================================ */
/* emergency + dispatch (CAD/AVL) now live in dispatch.js, mounted after the spine */

/* ============================================================
 * COMMUNITY HEALTH WORKER (field, offline-first client)
 * ============================================================ */
app.post('/api/chw/register', auth, roleOnly('chw'), (req, res) => {
  const { first, last, phone, area, sex, dob } = req.body || {};
  if (!first || !last) return res.status(400).json({ error: 'Client name is required' });
  const p = { id: uid('p'), first, last, hn: 'CH-' + Math.floor(100000 + Math.random() * 900000), member: '', dob: dob || '', sex: sex || '', bg: '', phone: phone || '', plan: 'Self-pay', tier: 'Community', hmo: '', allergies: [], conditions: [], registeredBy: req.user.id, area: area || '', nextVisit: 'First visit due' };
  db.patients.push(p); logAudit('CHW', 'client.registered', first + ' ' + last); store.save(); res.json(p);
});
app.get('/api/chw/roster', auth, roleOnly('chw'), (req, res) => res.json(db.patients.filter(p => p.registeredBy === req.user.id)));
app.post('/api/chw/visit', auth, roleOnly('chw'), (req, res) => {
  const { patientId, note, danger } = req.body || {};
  const p = db.patients.find(x => x.id === patientId); if (!p) return res.status(404).json({ error: 'Client not found' });
  db.visits.push({ id: uid('v'), patientId, reason: note || 'Home visit', doctor: (db.users.find(u => u.id === req.user.id) || {}).name || 'CHW', when: 'just now' });
  if (danger) db.authorizations.push({ id: uid('au'), patientId, what: 'Urgent referral (CHW danger sign)', where: 'Grandville Hospital', status: 'Pending', when: 'now' });
  p.nextVisit = 'Follow-up scheduled';
  logAudit('CHW', 'visit.logged', p.first + ' ' + p.last + (danger ? ' (referred)' : '')); store.save(); res.json({ ok: true, referred: !!danger });
});

/* ============================================================
 * HOSPITALS, REGISTRATION, SUPER-ADMIN, STAFF MANAGEMENT
 * ============================================================ */
app.get('/api/hospitals', (req, res) => res.json((db.hospitals || []).map(h => ({ id: h.id, name: h.name, area: h.area, code: h.code }))));

// A patient belongs to exactly one hospital and cannot attach themselves. To move,
// they request removal from their current hospital; once a staff member approves it,
// the patient is unattached and another hospital's front desk can add them.
app.post('/api/patient/transfer-request', auth, (req, res) => {
  const p = patient(req); if (!p) return res.status(400).json({ error: 'Not a patient account' });
  if (!p.hospitalId) return res.status(400).json({ error: 'You are not attached to a hospital yet' });
  p.transferRequested = true;
  const hn = (hospitalById(p.hospitalId) || {}).name || 'your hospital';
  db.users.filter(u => (u.role === 'admin' || (u.role === 'frontdesk')) && u.hospitalId === p.hospitalId)
    .forEach(u => { if (app.locals.spine) app.locals.spine.notify(u.id, 'transfer', (p.first || '') + ' ' + (p.last || '') + ' has requested to leave ' + hn + '.', 'transfers'); });
  logAudit(p.first + ' ' + p.last, 'transfer.requested', hn); store.save();
  res.json({ ok: true, transferRequested: true, hospital: hn });
});
app.post('/api/patient/transfer-cancel', auth, (req, res) => {
  const p = patient(req); if (!p) return res.status(400).json({ error: 'Not a patient account' });
  p.transferRequested = false; store.save(); res.json({ ok: true, transferRequested: false });
});

app.post('/api/auth/register-staff', (req, res) => {
  const { name, email, password, role, hospitalCode } = req.body || {};
  const STAFF = ['doctor', 'pharmacy', 'lab', 'rider', 'dispatch', 'chw'];
  if (!name || !email || !password || !STAFF.includes(role)) return res.status(400).json({ error: 'name, email, password and a valid role are required' });
  if (db.users.find(u => u.email === email.toLowerCase())) return res.status(409).json({ error: 'That email already has an account' });
  const h = (db.hospitals || []).find(x => x.code === (hospitalCode || '').toUpperCase());
  if (!h) return res.status(404).json({ error: 'Unknown hospital code' });
  const u = { id: uid('u'), role, hospitalId: h.id, status: 'pending', name, email: email.toLowerCase(), pass: bcrypt.hashSync(password, 10) };
  if (role === 'doctor') { const did = uid('doc'); u.doctorId = did; db.doctors.push({ id: did, userId: u.id, name, specialty: req.body.specialty || 'General Physician', facility: h.name, area: h.area, languages: ['English'], fee: req.body.fee || 5000, rating: 0, reviews: 0, bio: '', available: true, slots: ['09:00', '10:00', '11:00'], status: 'pending', hospitalId: h.id }); }
  db.users.push(u); logAudit(h.name, 'staff.applied', role + ' ' + name); store.save();
  res.json({ ok: true, status: 'pending', hospital: h.name, message: 'Application received. A hospital admin will approve your account.' });
});

app.get('/api/admin/staff', auth, requirePerm('admin.staff'), (req, res) => {
  res.json(hospStaff(adminHid(req)).map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status || 'active', doctorId: u.doctorId, online: isOnline(u.id) })));
});
// Deep, hospital-scoped analytics: figures and chart data pulled from every app.
app.get('/api/admin/analytics', auth, requirePerm('admin.overview'), (req, res) => {
  const hid = adminHid(req);
  const pats = hospPatients(hid); const pIds = new Set(pats.map(p => p.id));
  const docs = hospDoctors(hid);
  const staff = hospStaff(hid);
  const sod = new Date(); sod.setHours(0, 0, 0, 0); const ds = sod.getTime();
  const orders = (db.orders || []).filter(o => o.hospitalId === hid || pIds.has(o.patientId));
  const rx = orders.filter(o => o.type === 'rx');
  const labs = orders.filter(o => o.type === 'lab').concat((db.laborders || []).filter(l => pIds.has(l.patientId)));
  const appts = (db.appointments || []).filter(a => pIds.has(a.patientId));
  const ems = (db.emergencies || []).filter(e => e.hospitalId === hid);
  const dels = (db.deliveries || []).filter(d => d.hospitalId === hid && d.orderId);
  const claims = (db.claims || []).filter(c => pIds.has(c.patientId));
  const bills = (db.bills || []).filter(b => pIds.has(b.patientId));
  const queue = (db.queue || []).filter(e => e.hospitalId === hid);
  const shifts = (db.shifts || []).filter(s => s.hospitalId === hid);

  // revenue by category (paid drugs + settled bills/claims)
  const drugRevenue = rx.filter(o => o.paid).reduce((s, o) => s + (o.drugTotal || 0), 0);
  const claimRevenue = claims.reduce((s, c) => s + (c.amount || 0), 0);
  const consultRevenue = appts.filter(a => a.status === 'done' || a.paid).reduce((s, a) => s + (a.fee || 0), 0);

  // staff by role
  const byRole = {}; staff.forEach(u => { const r = u.role === 'frontdesk' ? 'front office' : u.role; byRole[r] = (byRole[r] || 0) + 1; });

  // rx pipeline funnel
  const rxFunnel = {
    ordered: rx.length,
    priced: rx.filter(o => ['priced', 'ready', 'dispatched', 'delivered', 'collected'].includes(o.status)).length,
    paid: rx.filter(o => o.paid).length,
    fulfilled: rx.filter(o => ['delivered', 'collected'].includes(o.status)).length,
  };

  // doctor leaderboard (visits + earnings) within this hospital
  const leaderboard = docs.map(d => {
    const mine = appts.filter(a => a.doctorId === d.id);
    const done = mine.filter(a => a.status === 'done' || a.paid);
    return { name: d.name, specialty: d.specialty, visits: mine.length, completed: done.length, earnings: done.reduce((s, a) => s + (a.fee || 0), 0), rating: d.rating || null };
  }).sort((a, b) => b.visits - a.visits).slice(0, 6);

  // 7-day activity trend, bucketed from real timestamps where present
  const days = []; for (let i = 6; i >= 0; i--) { const d = new Date(ds - i * 86400000); days.push({ key: d.getTime(), label: d.toLocaleDateString('en-NG', { weekday: 'short' }) }); }
  const bucket = ts => { if (!ts) return -1; const d = new Date(ts); d.setHours(0, 0, 0, 0); return days.findIndex(x => x.key === d.getTime()); };
  const series = { orders: new Array(7).fill(0), emergencies: new Array(7).fill(0), appointments: new Array(7).fill(0) };
  orders.forEach(o => { const i = bucket(o.updatedAt || o.createdAt); if (i >= 0) series.orders[i]++; });
  ems.forEach(e => { const i = bucket(e.at || e.updatedAt); if (i >= 0) series.emergencies[i]++; });
  appts.forEach(a => { const i = bucket(a.scheduledAt); if (i >= 0) series.appointments[i]++; });

  // emergency response time (avg minutes scene arrival - raised)
  const resp = ems.filter(e => e.status === 'closed').map(e => { const a = e.at, b = (e.timeline || []).find(x => x.status === 'onscene'); return (a && b && b.at >= a) ? (b.at - a) / 60000 : null; }).filter(x => x != null);

  res.json({
    hospital: hospitalName(hid),
    generatedAt: Date.now(),
    kpis: {
      patients: pats.length,
      appointments: appts.length,
      consultsDone: appts.filter(a => a.status === 'done' || a.paid).length,
      prescriptions: rx.length,
      labOrders: labs.length,
      activeEmergencies: ems.filter(e => e.status !== 'closed').length,
      activeDeliveries: dels.filter(d => d.status !== 'delivered').length,
      staffOnDuty: shifts.filter(s => !s.clockOut).length,
      staffTotal: staff.length,
      revenue: drugRevenue + claimRevenue + consultRevenue,
    },
    revenueByCategory: [
      { label: 'Pharmacy', value: drugRevenue },
      { label: 'Consults', value: consultRevenue },
      { label: 'Claims/HMO', value: claimRevenue },
    ],
    appointmentsByType: [
      { label: 'In-person', value: appts.filter(a => a.type !== 'video').length },
      { label: 'Video', value: appts.filter(a => a.type === 'video').length },
    ],
    staffByRole: Object.keys(byRole).map(r => ({ label: r, value: byRole[r] })).sort((a, b) => b.value - a.value),
    rxFunnel,
    queueFunnel: {
      waiting: queue.filter(e => e.status === 'waiting').length,
      withDoctor: queue.filter(e => e.status === 'in_progress').length,
      seenToday: queue.filter(e => e.status === 'done' && (e.doneAt || 0) >= ds).length,
    },
    emergencies: { total: ems.length, active: ems.filter(e => e.status !== 'closed').length, closed: ems.filter(e => e.status === 'closed').length, avgResponseMin: resp.length ? Math.round(resp.reduce((s, x) => s + x, 0) / resp.length) : null, units: (db.responders || []).filter(u => u.hospitalId === hid).length },
    deliveries: { total: dels.length, active: dels.filter(d => d.status !== 'delivered').length, delivered: dels.filter(d => d.status === 'delivered').length, riders: staff.filter(u => u.role === 'rider').length },
    trend: { days: days.map(d => d.label), orders: series.orders, emergencies: series.emergencies, appointments: series.appointments },
    leaderboard,
  });
});

// Per-person admin access: view and configure which admin capabilities each staff member has.
app.get('/api/admin/access', auth, requirePerm('admin.staff'), (req, res) => {
  const perms = require('./perms'); const hid = adminHid(req);
  const staff = hospStaff(hid).filter(u => u.role !== 'admin').map(u => ({
    id: u.id, name: u.name, email: u.email, role: u.role === 'frontdesk' ? ('front office' + (u.subrole ? (' · ' + u.subrole) : '')) : u.role,
    adminPermissions: (u.adminPermissions || []).filter(p => perms.ADMIN_PERMS.indexOf(p) >= 0),
  }));
  res.json({ staff, catalog: perms.ADMIN_PERMS.map(p => ({ key: p, label: perms.PERM_LABEL[p] })), levels: Object.keys(perms.ADMIN_LEVELS).map(k => ({ key: k, label: perms.ADMIN_LEVELS[k].label, perms: perms.ADMIN_LEVELS[k].perms })) });
});
app.post('/api/admin/access/:id', auth, requirePerm('admin.staff'), (req, res) => {
  const perms = require('./perms'); const hid = adminHid(req);
  const u = db.users.find(x => x.id === req.params.id && x.hospitalId === hid && x.role !== 'patient');
  if (!u) return res.status(404).json({ error: 'Staff member not found at your hospital' });
  if (u.role === 'admin') return res.status(400).json({ error: 'The hospital admin already has full access' });
  const body = req.body || {};
  let wanted = [];
  if (body.level && perms.ADMIN_LEVELS[body.level]) wanted = perms.ADMIN_LEVELS[body.level].perms.slice();
  else if (Array.isArray(body.permissions)) wanted = body.permissions.filter(p => perms.ADMIN_PERMS.indexOf(p) >= 0);
  u.adminPermissions = wanted;
  logAudit('Admin', 'access.set', u.name + ' -> ' + (wanted.length ? wanted.join(', ') : 'no admin access'));
  store.save();
  res.json({ ok: true, id: u.id, adminPermissions: u.adminPermissions });
});
app.get('/api/admin/pending', auth, requirePerm('admin.staff'), (req, res) => {
  res.json(hospStaff(adminHid(req)).filter(u => u.status === 'pending').map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role })));
});
app.post('/api/admin/staff', auth, requirePerm('admin.staff'), (req, res) => {
  const { name, email, password, role } = req.body || {};
  const STAFF = ['doctor', 'pharmacy', 'lab', 'rider', 'dispatch', 'chw'];
  if (!name || !email || !password || !STAFF.includes(role)) return res.status(400).json({ error: 'name, email, password and a valid role are required' });
  if (db.users.find(u => u.email === email.toLowerCase())) return res.status(409).json({ error: 'That email already has an account' });
  const hid = adminHid(req), h = hospitalById(hid);
  const u = { id: uid('u'), role, hospitalId: hid, status: 'active', name, email: email.toLowerCase(), pass: bcrypt.hashSync(password, 10) };
  if (role === 'doctor') { const did = uid('doc'); u.doctorId = did; db.doctors.push({ id: did, userId: u.id, name, specialty: req.body.specialty || 'General Physician', facility: h.name, area: h.area, languages: ['English'], fee: req.body.fee || 5000, rating: 0, reviews: 0, bio: '', available: true, slots: ['09:00', '10:00', '11:00'], status: 'verified', hospitalId: hid }); }
  db.users.push(u); logAudit(h.name, 'staff.created', role + ' ' + name); store.save();
  res.json({ ok: true, id: u.id });
});
app.post('/api/admin/staff/:id/approve', auth, requirePerm('admin.staff'), (req, res) => {
  const u = db.users.find(x => x.id === req.params.id && x.hospitalId === adminHid(req)); if (!u) return res.status(404).json({ error: 'Staff not found in your hospital' });
  const ok = !!(req.body && req.body.approve);
  u.status = ok ? 'active' : 'rejected';
  if (u.doctorId) { const d = db.doctors.find(x => x.id === u.doctorId); if (d) d.status = ok ? 'verified' : 'rejected'; }
  logAudit(hospitalName(adminHid(req)), 'staff.' + u.status, u.role + ' ' + u.name); store.save(); res.json({ ok: true, status: u.status });
});
app.get('/api/admin/modules', auth, requirePerm('admin.modules'), (req, res) => res.json((hospitalById(adminHid(req)) || {}).modules || {}));

/* ---- SUPER-ADMIN (platform, above hospitals) ---- */
function superOnly(req, res, next) { return req.user.role === 'superadmin' ? next() : res.status(403).json({ error: 'Platform admin only' }); }
app.get('/api/super/hospitals', auth, superOnly, (req, res) => {
  res.json((db.hospitals || []).map(h => ({ ...h, doctors: hospDoctors(h.id).length, staff: hospStaff(h.id).length, patients: hospPatients(h.id).length })));
});
app.post('/api/super/hospitals', auth, superOnly, (req, res) => {
  const { name, area, code, adminName, adminEmail, adminPassword } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'Hospital name and code are required' });
  if ((db.hospitals || []).find(h => h.code === code.toUpperCase())) return res.status(409).json({ error: 'That hospital code is taken' });
  const h = { id: uid('h'), name, area: area || '', code: code.toUpperCase(), modules: { marketplace: true, pharmacy: true, lab: true, ambulance: true, chw: true, analytics: true, wearables: true } };
  db.hospitals.push(h);
  if (adminEmail && adminPassword) db.users.push({ id: uid('u'), role: 'admin', hospitalId: h.id, status: 'active', name: adminName || 'Hospital Admin', email: adminEmail.toLowerCase(), pass: bcrypt.hashSync(adminPassword, 10) });
  logAudit('MediCore HQ', 'hospital.created', name); store.save(); res.json(h);
});
app.post('/api/super/hospitals/:id/modules', auth, superOnly, (req, res) => {
  const h = hospitalById(req.params.id); if (!h) return res.status(404).json({ error: 'Hospital not found' });
  h.modules = Object.assign({}, h.modules, (req.body && req.body.modules) || {});
  logAudit('MediCore HQ', 'hospital.modules', h.name); store.save(); res.json(h);
});

/* ============================================================
 * PRESENCE + CHAT THREADS (multi-thread, live, presence-aware)
 * ============================================================ */
app.post('/api/presence/ping', auth, (req, res) => { ping(req); res.json({ ok: true }); });
function threadView(t) {
  const d = db.doctors.find(x => x.id === t.doctorId) || {};
  const last = t.messages[t.messages.length - 1] || {};
  const pu = db.users.find(x => x.patientId === t.patientId);
  return { id: t.id, doctorId: t.doctorId, doctorName: d.name, hospitalId: t.hospitalId, hospitalName: hospitalName(t.hospitalId),
    patientId: t.patientId, patientName: pname(t.patientId), doctorOnline: doctorOnline(t.doctorId), patientOnline: pu ? isOnline(pu.id) : false,
    last: last.text || '', lastFrom: last.from || '', updatedAt: t.updatedAt, count: t.messages.length };
}
app.get('/api/threads', auth, (req, res) => { ping(req);
  res.json((db.threads || []).filter(t => t.patientId === req.user.patientId).sort((a, b) => b.updatedAt - a.updatedAt).map(threadView));
});
app.get('/api/threads/:id', auth, (req, res) => { ping(req);
  const t = (db.threads || []).find(x => x.id === req.params.id && x.patientId === req.user.patientId);
  if (!t) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ ...threadView(t), messages: t.messages });
});
app.post('/api/threads/start', auth, (req, res) => {
  const d = db.doctors.find(x => x.id === (req.body && req.body.doctorId)); if (!d) return res.status(404).json({ error: 'Doctor not found' });
  if (!patientHospitals(patient(req)).includes(d.hospitalId)) return res.status(403).json({ error: 'That doctor is not in a hospital you belong to' });
  let t = (db.threads || []).find(x => x.patientId === req.user.patientId && x.doctorId === d.id);
  if (!t) { t = { id: uid('t'), patientId: req.user.patientId, doctorId: d.id, hospitalId: d.hospitalId, updatedAt: Date.now(), messages: [] }; db.threads.push(t); store.save(); }
  res.json({ id: t.id });
});
app.post('/api/threads/:id/message', auth, async (req, res) => { ping(req);
  const t = (db.threads || []).find(x => x.id === req.params.id && x.patientId === req.user.patientId);
  if (!t) return res.status(404).json({ error: 'Conversation not found' });
  const text = (req.body && req.body.text || '').trim(); if (!text) return res.status(400).json({ error: 'Message is empty' });
  t.messages.push({ from: 'patient', who: pname(t.patientId), text, at: Date.now() }); t.updatedAt = Date.now();
  const d = db.doctors.find(x => x.id === t.doctorId) || {};
  let auto = false;
  if (!doctorOnline(t.doctorId)) {
    t.messages.push({ from: 'system', who: 'Auto-reply', text: `${d.name || 'The doctor'} is offline right now. Your message is delivered and they will reply as soon as they are back.`, at: Date.now() + 1, auto: true });
    auto = true;
    await X.sendSMS({ to: (db.patients.find(p => p.id === t.patientId) || {}).phone, text: `MediCore: message sent to ${d.name || 'your doctor'}.` });
  }
  store.save(); res.json({ ok: true, auto, messages: t.messages });
});
app.get('/api/doc/threads', auth, doctorOnly, (req, res) => { ping(req);
  const d = myDoctor(req);
  res.json((db.threads || []).filter(t => t.doctorId === (d && d.id)).sort((a, b) => b.updatedAt - a.updatedAt).map(threadView));
});
app.get('/api/doc/threads/:id', auth, doctorOnly, (req, res) => { ping(req);
  const d = myDoctor(req);
  const t = (db.threads || []).find(x => x.id === req.params.id && x.doctorId === (d && d.id));
  if (!t) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ ...threadView(t), messages: t.messages });
});
app.post('/api/doc/threads/:id/message', auth, doctorOnly, async (req, res) => { ping(req);
  const d = myDoctor(req);
  const t = (db.threads || []).find(x => x.id === req.params.id && x.doctorId === (d && d.id));
  if (!t) return res.status(404).json({ error: 'Conversation not found' });
  const text = (req.body && req.body.text || '').trim(); if (!text) return res.status(400).json({ error: 'Message is empty' });
  t.messages.push({ from: 'doctor', who: d.name, text, at: Date.now() }); t.updatedAt = Date.now();
  store.save();
  await X.sendSMS({ to: (db.patients.find(p => p.id === t.patientId) || {}).phone, text: `MediCore: new message from ${d.name}.` });
  res.json({ ok: true, messages: t.messages });
});

/* ---- health check + static patient app ---- */
/* ============================================================
 * THE SPINE: unified order object + event bus + notifications.
 * Owns the canonical order routes for doctor / lab / pharmacy / patient.
 * ============================================================ */
require('./spine')(app, { db, store, uid, auth, doctorOnly, roleOnly, pname, myDoctor, X, logAudit });

/* ============================================================
 * EMERGENCY DISPATCH (CAD) + AVL. Uses the spine event bus for
 * receiving-hospital notifications. Mounted after the spine.
 * ============================================================ */
require('./dispatch')(app, { db, store, uid, auth, roleOnly, logAudit });

/* ============================================================
 * FRONT OFFICE: sub-admin roles (receptionist/cashier/records/
 * customer-success/manager), clock-in + attendance, patient
 * intake and the live queue the doctor app reads.
 * ============================================================ */
require('./frontoffice')(app, { db, store, uid, auth, roleOnly, logAudit, hospitalById, hospitalName });

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/api/health', (req, res) => res.json({ ok: true, build: BUILD, patients: db.patients.length, mode: {
  payments: process.env.PAYSTACK_SECRET ? 'live' : 'dev', sms: process.env.TERMII_KEY ? 'live' : 'dev', video: process.env.DAILY_KEY ? 'live' : 'dev' }, enforceClockIn: process.env.ENFORCE_CLOCKIN === '1' }));
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res, p) => { if (/\.(html|js|css)$/.test(p)) res.set('Cache-Control', 'no-cache'); } }));
app.get('/', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });

if (require.main === module) {
  app.listen(PORT, () => console.log('MediCore server on http://localhost:' + PORT +
    '  (payments ' + (process.env.PAYSTACK_SECRET ? 'live' : 'dev') +
    ', sms ' + (process.env.TERMII_KEY ? 'live' : 'dev') +
    ', video ' + (process.env.DAILY_KEY ? 'live' : 'dev') + ')'));
}
module.exports = app;
