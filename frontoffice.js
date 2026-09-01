'use strict';
/* ============================================================================
 * FRONT OFFICE  -  sub-admin roles, clock-in/attendance, patient intake + queue
 * ----------------------------------------------------------------------------
 * Front-desk staff are scoped by SUB-ROLE (receptionist, cashier, records,
 * customer success, manager). Each only reaches the operations their permission
 * set allows. A shared clock-in captures time + location (with a geofence check)
 * and is usable by any app. Reception check-in pushes patients into a live queue
 * the Doctor app reads, the handoff from front desk to clinician.
 * ==========================================================================*/
module.exports = function mountFrontOffice(app, ctx) {
  const { db, store, uid, auth, roleOnly, logAudit, hospitalById, hospitalName } = ctx;
  const spine = app.locals.spine || { notify() {}, emit() {} };
  if (!db.shifts) db.shifts = [];
  if (!db.queue) db.queue = [];
  if (!db.cslog) db.cslog = [];

  /* ---- permission model (shared, see perms.js) ---- */
  const { SUBROLE_PERMS, SUBROLE_LABEL, permsFor } = require('./perms');
  const me = req => db.users.find(u => u.id === req.user.id);
  function requirePerm(perm) {
    return (req, res, next) => {
      const u = me(req);
      if (!u) return res.status(401).json({ error: 'Sign in required' });
      if (u.status === 'pending') return res.status(403).json({ error: 'Your account is awaiting admin approval' });
      if (!permsFor(u).includes(perm)) return res.status(403).json({ error: 'Your role does not have access to this' });
      req.staff = u; next();
    };
  }
  const myHid = req => req.user.hospitalId;

  /* ---- geo (geofence for clock-in) ---- */
  const toRad = d => d * Math.PI / 180;
  function km(a, b) { if (!a || !b || a.lat == null || b.lat == null) return null; const R = 6371, dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng); const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(s))); }

  /* ============================ CLOCK-IN / ATTENDANCE ============================ */
  const openShift = uid2 => db.shifts.find(s => s.userId === uid2 && !s.clockOut);
  const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  function shiftView(s) { return { id: s.id, clockIn: s.clockIn, clockOut: s.clockOut || null, onSite: s.onSite, distanceM: s.distanceM, lat: s.lat, lng: s.lng, minutes: Math.round(((s.clockOut || Date.now()) - s.clockIn) / 60000), name: s.name, role: s.roleLabel, scheduledStart: s.scheduledStart || null, lateMinutes: s.lateMinutes != null ? s.lateMinutes : null, punctuality: s.punctuality || null }; }

  app.post('/api/shift/clockin', auth, (req, res) => {
    const u = me(req); if (!u) return res.status(401).json({ error: 'Sign in required' });
    const existing = openShift(u.id); if (existing) return res.json({ shift: shiftView(existing), already: true });
    const b = req.body || {}; const h = hospitalById(u.hospitalId);
    const dist = (b.lat != null && h && h.lat != null) ? km({ lat: b.lat, lng: b.lng }, { lat: h.lat, lng: h.lng }) : null;
    const onSite = dist == null ? null : dist <= 0.5; // within 500 m of the facility
    // punctuality against today's roster, if one exists
    const today = new Date().toISOString().slice(0, 10);
    const sched = (db.schedules || []).find(x => x.staffId === u.id && x.date === today);
    let scheduledStart = null, lateMinutes = null, punctuality = null;
    if (sched) {
      scheduledStart = sched.start;
      const [hh, mm] = sched.start.split(':').map(Number);
      const schedTs = new Date(); schedTs.setHours(hh, mm, 0, 0);
      lateMinutes = Math.round((Date.now() - schedTs.getTime()) / 60000);
      punctuality = lateMinutes <= 5 ? 'on-time' : 'late';
    }
    const s = { id: uid('sh'), userId: u.id, hospitalId: u.hospitalId, name: u.name, roleLabel: SUBROLE_LABEL[u.subrole] || (u.role.charAt(0).toUpperCase() + u.role.slice(1)), clockIn: Date.now(), clockOut: null, lat: b.lat != null ? b.lat : null, lng: b.lng != null ? b.lng : null, accuracy: b.accuracy || null, distanceM: dist == null ? null : Math.round(dist * 1000), onSite, scheduledStart, lateMinutes, punctuality };
    db.shifts.push(s); logAudit(u.name, 'shift.clockin', (onSite === false ? 'off-site' : 'on-site') + (punctuality ? ' / ' + punctuality : '')); store.save();
    res.json({ shift: shiftView(s) });
  });
  app.post('/api/shift/clockout', auth, (req, res) => {
    const u = me(req); const s = openShift(u.id); if (!s) return res.status(400).json({ error: 'You are not clocked in' });
    s.clockOut = Date.now(); logAudit(u.name, 'shift.clockout', Math.round((s.clockOut - s.clockIn) / 60000) + ' min'); store.save();
    res.json({ shift: shiftView(s) });
  });
  app.get('/api/shift/me', auth, (req, res) => {
    const u = me(req); const open = openShift(u.id);
    const todays = db.shifts.filter(s => s.userId === u.id && s.clockIn >= startOfDay());
    const minutes = todays.reduce((m, s) => m + Math.round(((s.clockOut || Date.now()) - s.clockIn) / 60000), 0);
    const today = new Date().toISOString().slice(0, 10);
    const sched = (db.schedules || []).find(x => x.staffId === u.id && x.date === today) || null;
    res.json({ open: open ? shiftView(open) : null, todayMinutes: minutes, todaySchedule: sched ? { start: sched.start, end: sched.end, duty: sched.duty } : null });
  });

  /* ---- rostering / scheduling (admin & manager) ---- */
  const isoDate = ts => new Date(ts).toISOString().slice(0, 10);
  app.get('/api/admin/roster', auth, requirePerm('admin.staff'), (req, res) => {
    db.schedules = db.schedules || []; const hid = myHid(req); const date = req.query.date;
    let list = db.schedules.filter(s => s.hospitalId === hid);
    if (date) list = list.filter(s => s.date === date);
    list.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    res.json(list);
  });
  app.post('/api/admin/roster', auth, requirePerm('admin.staff'), (req, res) => {
    db.schedules = db.schedules || []; const b = req.body || {}; const hid = myHid(req);
    const staff = db.users.find(u => u.id === b.staffId && u.hospitalId === hid && !['patient', 'payer', 'superadmin'].includes(u.role));
    if (!staff) return res.status(404).json({ error: 'Staff member not at this hospital' });
    if (!b.date || !b.start || !b.end) return res.status(400).json({ error: 'Date, start and end are required' });
    const s = { id: uid('rs'), hospitalId: hid, staffId: staff.id, staffName: staff.name, role: staff.subrole || staff.role, date: b.date, start: b.start, end: b.end, duty: b.duty || '', createdBy: req.staff ? req.staff.name : 'Admin' };
    db.schedules.push(s); logAudit(req.staff ? req.staff.name : 'Admin', 'roster.assign', staff.name + ' ' + b.date + ' ' + b.start + '-' + b.end); store.save();
    res.json(s);
  });
  app.delete('/api/admin/roster/:id', auth, requirePerm('admin.staff'), (req, res) => {
    db.schedules = db.schedules || []; const i = db.schedules.findIndex(s => s.id === req.params.id && s.hospitalId === myHid(req));
    if (i < 0) return res.status(404).json({ error: 'Not found' });
    db.schedules.splice(i, 1); store.save(); res.json({ ok: true });
  });
  app.get('/api/shift/schedule', auth, (req, res) => {
    const u = me(req); const today = new Date().toISOString().slice(0, 10);
    const list = (db.schedules || []).filter(s => s.staffId === u.id && s.date >= today).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    res.json(list.slice(0, 14));
  });
  // attendance register for a day: who clocked in/out, on-site, and punctuality vs roster
  app.get('/api/admin/attendance', auth, requirePerm('shift.view'), (req, res) => {
    const hid = myHid(req); const date = req.query.date || new Date().toISOString().slice(0, 10);
    const dayStart = new Date(date + 'T00:00:00').getTime(), dayEnd = dayStart + 86400000;
    const shifts = db.shifts.filter(s => s.hospitalId === hid && s.clockIn >= dayStart && s.clockIn < dayEnd);
    const rows = shifts.map(s => ({ name: s.name, role: s.roleLabel, clockIn: s.clockIn, clockOut: s.clockOut, onSite: s.onSite, scheduledStart: s.scheduledStart || null, lateMinutes: s.lateMinutes, punctuality: s.punctuality || (s.scheduledStart ? null : 'unscheduled'), minutes: Math.round(((s.clockOut || Date.now()) - s.clockIn) / 60000) }));
    rows.sort((a, b) => a.clockIn - b.clockIn);
    const scheduled = (db.schedules || []).filter(s => s.hospitalId === hid && s.date === date).length;
    res.json({ date, rows, summary: { present: rows.length, onTime: rows.filter(r => r.punctuality === 'on-time').length, late: rows.filter(r => r.punctuality === 'late').length, scheduled } });
  });
  app.get('/api/shift/onduty', auth, requirePerm('shift.view'), (req, res) => {
    res.json(db.shifts.filter(s => !s.clockOut && s.hospitalId === myHid(req)).map(shiftView));
  });

  /* ============================ PATIENT INTAKE ============================ */
  const pFull = p => ({ id: p.id, name: (p.first || '') + ' ' + (p.last || ''), hn: p.hn, phone: p.phone, sex: p.sex, dob: p.dob, plan: p.plan, hmo: p.hmo, tier: p.tier, member: p.member, area: p.area, conditions: p.conditions, allergies: p.allergies });

  app.get('/api/frontdesk/patients', auth, requirePerm('patient.read'), (req, res) => {
    const q = (req.query.q || '').toLowerCase().trim(); const hid = myHid(req);
    // this hospital's patients, plus any UNATTACHED patient (so they can be added here)
    let list = db.patients.filter(p => p.hospitalId === hid || !p.hospitalId);
    if (q) list = list.filter(p => ((p.first + ' ' + p.last).toLowerCase().includes(q) || (p.hn || '').toLowerCase().includes(q) || (p.phone || '').includes(q)));
    res.json(list.slice(0, 25).map(p => Object.assign(pFull(p), { hospitalId: p.hospitalId || null, attached: p.hospitalId === hid, unattached: !p.hospitalId })));
  });
  app.post('/api/frontdesk/register', auth, requirePerm('patient.register'), (req, res) => {
    const b = req.body || {}; if (!b.first || !b.last) return res.status(400).json({ error: 'First and last name are required' });
    const hid = myHid(req);
    const p = { id: uid('p'), first: b.first, last: b.last, hn: 'GH-' + Math.floor(100000 + Math.random() * 900000), member: b.member || '', dob: b.dob || '', sex: b.sex || '', bg: '', phone: b.phone || '', plan: b.plan || 'Self-pay', tier: b.tier || 'Standard', hmo: b.hmo || '', address: b.address || '', area: b.area || '', allergies: [], conditions: [], hospitalId: hid, registeredBy: req.user.id };
    db.patients.push(p); logAudit(req.staff.name, 'patient.registered', p.first + ' ' + p.last); store.save();
    res.json(pFull(p));
  });
  // attach an EXISTING unattached patient to this hospital (used after a transfer-out was approved elsewhere)
  app.post('/api/frontdesk/attach/:id', auth, requirePerm('patient.register'), (req, res) => {
    const p = db.patients.find(x => x.id === req.params.id); if (!p) return res.status(404).json({ error: 'Patient not found' });
    if (p.hospitalId) { const at = (hospitalById(p.hospitalId) || {}).name || 'another hospital'; return res.status(409).json({ error: 'This patient is still registered at ' + at + '. They must request removal there first.' }); }
    p.hospitalId = myHid(req); p.transferRequested = false;
    logAudit(req.staff.name, 'patient.attached', p.first + ' ' + p.last); store.save();
    res.json(pFull(p));
  });
  // pending removal requests at this hospital, and approval (detaches the patient)
  app.get('/api/frontdesk/transfers', auth, requirePerm('patient.register'), (req, res) => {
    res.json(db.patients.filter(p => p.hospitalId === myHid(req) && p.transferRequested).map(p => ({ id: p.id, name: (p.first || '') + ' ' + (p.last || ''), hn: p.hn, phone: p.phone })));
  });
  app.post('/api/frontdesk/transfers/:id/approve', auth, requirePerm('patient.register'), (req, res) => {
    const p = db.patients.find(x => x.id === req.params.id && x.hospitalId === myHid(req)); if (!p) return res.status(404).json({ error: 'Not a patient at this hospital' });
    p.hospitalId = null; p.transferRequested = false; p.registeredBy = null;
    const uid2 = (db.users.find(u => u.role === 'patient' && u.patientId === p.id) || {}).id;
    if (uid2 && spine.notify) spine.notify(uid2, 'transfer', 'You have been removed from your hospital. Another hospital can now register you.', 'home');
    logAudit(req.staff.name, 'transfer.approved', p.first + ' ' + p.last); store.save();
    res.json({ ok: true });
  });

  /* ============================ CHECK-IN + LIVE QUEUE ============================ */
  function queueView(e) { return { id: e.id, patientId: e.patientId, patient: e.patientName, complaint: e.complaint, priority: e.priority, vitals: e.vitals, dept: e.dept, doctorId: e.doctorId, doctor: e.doctorName, status: e.status, token: e.token, checkedInBy: e.checkedInByName, checkedInAt: e.checkedInAt, waitedMin: Math.round((Date.now() - e.checkedInAt) / 60000), routedTo: e.routedTo }; }
  function nextToken(hid) { const today = db.queue.filter(e => e.hospitalId === hid && e.checkedInAt >= startOfDay()); return 'A' + String(today.length + 1).padStart(2, '0'); }

  app.post('/api/frontdesk/checkin', auth, requirePerm('queue.manage'), (req, res) => {
    const b = req.body || {}; const hid = myHid(req);
    const p = db.patients.find(x => x.id === b.patientId); if (!p) return res.status(404).json({ error: 'Patient not found' });
    if (p.hospitalId !== hid) return res.status(403).json({ error: p.hospitalId ? 'This patient belongs to another hospital.' : 'Add this patient to your hospital first.' });
    const doc = b.doctorId ? db.doctors.find(d => d.id === b.doctorId) : null;
    const e = { id: uid('q'), hospitalId: hid, patientId: p.id, patientName: (p.first || '') + ' ' + (p.last || ''), complaint: b.complaint || 'General consultation', priority: b.priority || 'routine', vitals: b.vitals || {}, dept: b.dept || 'General OPD', doctorId: doc ? doc.id : null, doctorName: doc ? doc.name : null, status: 'waiting', token: nextToken(hid), checkedInBy: req.user.id, checkedInByName: req.staff.name, checkedInAt: Date.now(), startedAt: null, doneAt: null, routedTo: null };
    db.queue.unshift(e);
    db.users.filter(u => u.role === 'doctor' && u.hospitalId === hid).forEach(u => spine.notify(u.id, 'queue', p.first + ' ' + p.last + ' checked in (' + e.token + ', ' + e.priority + '): ' + e.complaint, 'queue'));
    logAudit(req.staff.name, 'patient.checkin', e.patientName + ' ' + e.token); store.save();
    res.json(queueView(e));
  });
  app.get('/api/frontdesk/queue', auth, requirePerm('queue.manage'), (req, res) => {
    const hid = myHid(req);
    res.json(db.queue.filter(e => e.hospitalId === hid && ['waiting', 'in_progress'].includes(e.status)).map(queueView));
  });
  app.post('/api/frontdesk/queue/:id/route', auth, requirePerm('queue.manage'), (req, res) => {
    const e = db.queue.find(x => x.id === req.params.id && x.hospitalId === myHid(req)); if (!e) return res.status(404).json({ error: 'Not in queue' });
    const to = (req.body || {}).to || 'done'; e.routedTo = to; if (to === 'done') { e.status = 'done'; e.doneAt = Date.now(); } logAudit(req.staff.name, 'queue.route', e.patientName + ' -> ' + to); store.save();
    res.json(queueView(e));
  });

  /* ============================ BILLING (cashier) ============================ */
  app.get('/api/frontdesk/cover/:patientId', auth, requirePerm('billing.manage'), (req, res) => {
    const p = db.patients.find(x => x.id === req.params.patientId); if (!p) return res.status(404).json({ error: 'Patient not found' });
    res.json({ patient: (p.first || '') + ' ' + (p.last || ''), plan: p.plan, hmo: p.hmo || '', tier: p.tier, member: p.member || '', eligible: !!(p.hmo && p.member), note: p.hmo ? (p.member ? 'HMO cover on file' : 'HMO named but no member ID') : 'Self-pay' });
  });
  app.post('/api/frontdesk/bill', auth, requirePerm('billing.manage'), (req, res) => {
    const b = req.body || {}; const p = db.patients.find(x => x.id === b.patientId); if (!p) return res.status(404).json({ error: 'Patient not found' });
    const bill = { id: uid('b'), patientId: p.id, what: b.what || 'Consultation', amount: Number(b.amount) || 0, status: b.paid ? 'Paid' : 'Unpaid', when: 'now', by: req.staff.name };
    db.bills.push(bill); logAudit(req.staff.name, 'bill.created', bill.what + ' N' + bill.amount); store.save();
    res.json(bill);
  });
  app.post('/api/frontdesk/bill/:id/pay', auth, requirePerm('billing.manage'), (req, res) => {
    const bill = db.bills.find(x => x.id === req.params.id); if (!bill) return res.status(404).json({ error: 'Bill not found' });
    bill.status = 'Paid'; logAudit(req.staff.name, 'bill.paid', bill.what); store.save(); res.json(bill);
  });

  /* ============================ CUSTOMER SUCCESS ============================ */
  app.get('/api/frontdesk/cs', auth, requirePerm('cs.manage'), (req, res) => res.json(db.cslog.filter(c => c.hospitalId === myHid(req)).slice(0, 50)));
  app.post('/api/frontdesk/cs', auth, requirePerm('cs.manage'), (req, res) => {
    const b = req.body || {}; const p = b.patientId ? db.patients.find(x => x.id === b.patientId) : null;
    const c = { id: uid('cs'), hospitalId: myHid(req), patientId: p ? p.id : null, patient: p ? (p.first + ' ' + p.last) : (b.name || 'Walk-in'), type: b.type || 'followup', note: b.note || '', status: 'open', by: req.staff.name, at: Date.now() };
    db.cslog.unshift(c); logAudit(req.staff.name, 'cs.' + c.type, c.patient); store.save(); res.json(c);
  });
  app.post('/api/frontdesk/cs/:id/close', auth, requirePerm('cs.manage'), (req, res) => {
    const c = db.cslog.find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: 'Not found' }); c.status = 'closed'; store.save(); res.json(c);
  });

  /* ============================ DASHBOARD ============================ */
  app.get('/api/frontdesk/overview', auth, (req, res) => {
    const u = me(req); if (!u) return res.status(401).json({ error: 'Sign in required' });
    const perms = permsFor(u); const hid = myHid(req); const dayStart = startOfDay();
    const q = db.queue.filter(e => e.hospitalId === hid);
    const out = {
      me: { name: u.name, role: u.role, subrole: u.subrole || null, roleLabel: SUBROLE_LABEL[u.subrole] || 'Hospital admin', permissions: perms, hospital: hospitalName(hid) },
      today: {
        registered: db.patients.filter(p => p.registeredBy && db.audit.some(a => a.action === 'patient.registered')).length,
        checkedIn: q.filter(e => e.checkedInAt >= dayStart).length,
        waiting: q.filter(e => e.status === 'waiting').length,
        inProgress: q.filter(e => e.status === 'in_progress').length,
        seen: q.filter(e => e.status === 'done' && (e.doneAt || 0) >= dayStart).length,
      },
    };
    if (perms.includes('shift.view')) out.onDuty = db.shifts.filter(s => !s.clockOut && s.hospitalId === hid).map(shiftView);
    if (perms.includes('cs.manage')) out.openCs = db.cslog.filter(c => c.hospitalId === hid && c.status === 'open').length;
    res.json(out);
  });

  /* ============================ DOCTOR: the waiting room (handoff) ============================ */
  app.get('/api/doc/queue', auth, roleOnly('doctor'), (req, res) => {
    const hid = req.user.hospitalId;
    res.json(db.queue.filter(e => e.hospitalId === hid && ['waiting', 'in_progress'].includes(e.status))
      .filter(e => !e.doctorId || e.doctorId === req.user.doctorId || e.status === 'waiting')
      .map(queueView));
  });
  app.post('/api/doc/queue/:id/start', auth, roleOnly('doctor'), (req, res) => {
    const e = db.queue.find(x => x.id === req.params.id && x.hospitalId === req.user.hospitalId); if (!e) return res.status(404).json({ error: 'Not in queue' });
    const d = db.doctors.find(x => x.userId === req.user.id);
    e.status = 'in_progress'; e.startedAt = Date.now(); if (d) { e.doctorId = d.id; e.doctorName = d.name; }
    store.save(); res.json(queueView(e));
  });
  app.post('/api/doc/queue/:id/done', auth, roleOnly('doctor'), (req, res) => {
    const e = db.queue.find(x => x.id === req.params.id && x.hospitalId === req.user.hospitalId); if (!e) return res.status(404).json({ error: 'Not in queue' });
    e.status = 'done'; e.doneAt = Date.now();
    db.visits.push({ id: uid('v'), patientId: e.patientId, reason: e.complaint, doctor: e.doctorName || 'Doctor', when: 'just now' });
    store.save(); res.json(queueView(e));
  });

  /* ---- lightweight identity for the shared clock-in widget ---- */
  app.get('/api/whoami', auth, (req, res) => {
    const u = me(req); if (!u) return res.status(401).json({ error: 'Sign in required' });
    const perms = permsFor(u);
    res.json({ name: u.name, role: u.role, subrole: u.subrole || null, roleLabel: SUBROLE_LABEL[u.subrole] || (u.role.charAt(0).toUpperCase() + u.role.slice(1)), hospital: hospitalName(u.hospitalId), canSeeOnDuty: perms.includes('shift.view') });
  });

  /* ---- dashboard metrics for apps that lacked them ---- */
  const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
  app.get('/api/rider/stats', auth, roleOnly('rider'), (req, res) => {
    const d = db.deliveries || [];
    res.json({ open: d.filter(x => !x.assignedTo && (x.stage || 0) < 3).length, inTransit: d.filter(x => x.assignedTo && (x.stage || 0) < 3).length, deliveredToday: d.filter(x => (x.stage || 0) >= 3).length, total: d.length });
  });
  app.get('/api/chw/stats', auth, roleOnly('chw'), (req, res) => {
    const roster = db.patients.filter(p => p.registeredBy === req.user.id);
    const ids = new Set(roster.map(p => p.id));
    res.json({ roster: roster.length, visitsToday: (db.visits || []).filter(v => ids.has(v.patientId)).length, due: roster.filter(p => /due/i.test(p.nextVisit || '')).length });
  });

  return { permsFor };
};
