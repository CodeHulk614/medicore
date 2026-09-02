'use strict';
/*
 * MediCore fleet & personnel management (hospital-scoped, admin).
 * Ambulances (vehicles):  add / edit / service-status (in-service | maintenance | retired),
 *   with compliance dates (registration, insurance, inspection) and expiry alerts (<=90d),
 *   odometer and last-service. Only in-service units are dispatchable or crewable.
 * Riders (delivery): onboarding profile (vehicle type, plate, licence, insurance, phone) and a
 *   verification state (pending | verified | rejected). Unverified riders can't accept runs.
 * Crew (ambulance): certification (EMT-Basic / Intermediate / Paramedic / Driver) and licence.
 */
module.exports = function (app, ctx) {
  const { db, store, uid, auth, roleOnly, logAudit, hospitalById } = ctx;
  ['riderProfiles', 'crewProfiles'].forEach(k => { if (!db[k]) db[k] = []; });
  const hid = req => req.user.hospitalId;
  const today = () => new Date().toISOString().slice(0, 10);
  const daysTo = d => (d ? Math.floor((new Date(d + 'T00:00:00Z') - new Date(today() + 'T00:00:00Z')) / 86400000) : null);
  function docFlags(obj) {
    const out = [];
    [['registration', 'regExpiry'], ['insurance', 'insuranceExpiry'], ['inspection', 'inspectionExpiry'], ['licence', 'licenseExpiry']].forEach(([lbl, k]) => {
      const d = daysTo(obj[k]); if (d == null) return; if (d < 0) out.push({ doc: lbl, state: 'expired', days: d }); else if (d <= 90) out.push({ doc: lbl, state: 'expiring', days: d });
    });
    return out;
  }

  /* ---------------- AMBULANCE VEHICLES ---------------- */
  function vehView(u) {
    return { id: u.id, name: u.name, type: u.type, plate: u.plate, make: u.make || '', model: u.model || '', area: u.area || '',
      serviceStatus: u.serviceStatus || 'in-service', dispatchStatus: u.status,
      crewName: (db.users.find(x => x.id === u.crewUserId) || {}).name || u.crew || null, crewed: !!u.crewUserId,
      odometer: u.odometer || 0, regExpiry: u.regExpiry || '', insuranceExpiry: u.insuranceExpiry || '', inspectionExpiry: u.inspectionExpiry || '', lastServiceAt: u.lastServiceAt || '',
      docFlags: docFlags(u) };
  }
  app.get('/api/admin/fleet/vehicles', auth, roleOnly('admin'), (req, res) => {
    const h = hid(req); res.json(db.responders.filter(r => r.hospitalId === h && r.serviceStatus !== 'retired').map(vehView));
  });
  app.post('/api/admin/fleet/vehicles', auth, roleOnly('admin'), (req, res) => {
    const h = hid(req); const b = req.body || {};
    if (!(b.name || '').trim() || !(b.plate || '').trim()) return res.status(400).json({ error: 'Name and number plate are required' });
    const hosp = hospitalById ? hospitalById(h) : null; const base = hosp && hosp.lat ? { lat: hosp.lat, lng: hosp.lng } : { lat: 6.5, lng: 3.35 };
    const u = { id: uid('amb'), name: b.name.trim(), type: b.type || 'Basic life support', plate: b.plate.trim().toUpperCase(), make: b.make || '', model: b.model || '',
      hospitalId: h, area: b.area || (hosp && hosp.area) || '', status: 'available', serviceStatus: 'in-service',
      lat: base.lat, lng: base.lng, homeLat: base.lat, homeLng: base.lng, assignedCase: null, target: null, crewUserId: null, crew: b.crew || 'Unassigned',
      odometer: parseInt(b.odometer, 10) || 0, regExpiry: b.regExpiry || '', insuranceExpiry: b.insuranceExpiry || '', inspectionExpiry: b.inspectionExpiry || '', lastServiceAt: b.lastServiceAt || '' };
    db.responders.push(u); logAudit('Admin', 'fleet.vehicle.add', u.name + ' ' + u.plate); store.save(); res.json(vehView(u));
  });
  app.post('/api/admin/fleet/vehicles/:id', auth, roleOnly('admin'), (req, res) => {
    const h = hid(req); const u = db.responders.find(x => x.id === req.params.id && x.hospitalId === h); if (!u) return res.status(404).json({ error: 'Vehicle not found' });
    const b = req.body || {}; ['name', 'type', 'make', 'model', 'area', 'crew'].forEach(k => { if (b[k] !== undefined) u[k] = b[k]; });
    if (b.plate) u.plate = b.plate.toUpperCase();
    ['regExpiry', 'insuranceExpiry', 'inspectionExpiry', 'lastServiceAt'].forEach(k => { if (b[k] !== undefined) u[k] = b[k]; });
    if (b.odometer !== undefined) u.odometer = parseInt(b.odometer, 10) || 0;
    store.save(); res.json(vehView(u));
  });
  app.post('/api/admin/fleet/vehicles/:id/status', auth, roleOnly('admin'), (req, res) => {
    const h = hid(req); const u = db.responders.find(x => x.id === req.params.id && x.hospitalId === h); if (!u) return res.status(404).json({ error: 'Vehicle not found' });
    const s = (req.body || {}).serviceStatus; if (!['in-service', 'maintenance', 'retired'].includes(s)) return res.status(400).json({ error: 'status must be in-service, maintenance or retired' });
    u.serviceStatus = s; if (s !== 'in-service' && u.crewUserId) u.crewUserId = null;   // pulling a unit frees its crew
    logAudit('Admin', 'fleet.vehicle.status', u.name + ' -> ' + s); store.save(); res.json(vehView(u));
  });

  /* ---------------- RIDERS (onboarding + vehicle) ---------------- */
  const riderProfile = id => db.riderProfiles.find(p => p.userId === id);
  function riderView(u) { const p = riderProfile(u.id) || {}; return { userId: u.id, name: u.name, email: u.email, status: u.status || 'active',
    vehicleType: p.vehicleType || '', plate: p.plate || '', licenseNo: p.licenseNo || '', licenseExpiry: p.licenseExpiry || '', insuranceExpiry: p.insuranceExpiry || '', phone: p.phone || '',
    verification: p.verification || 'pending', docFlags: docFlags(p) }; }
  app.get('/api/admin/fleet/riders', auth, roleOnly('admin'), (req, res) => {
    const h = hid(req); res.json(db.users.filter(u => u.role === 'rider' && u.hospitalId === h && u.status !== 'removed').map(riderView));
  });
  app.post('/api/admin/fleet/riders/:userId/profile', auth, roleOnly('admin'), (req, res) => {
    const h = hid(req); const u = db.users.find(x => x.id === req.params.userId && x.role === 'rider' && x.hospitalId === h); if (!u) return res.status(404).json({ error: 'Rider not found' });
    let p = riderProfile(u.id); if (!p) { p = { userId: u.id, hospitalId: h, verification: 'pending' }; db.riderProfiles.push(p); }
    const b = req.body || {}; ['vehicleType', 'plate', 'licenseNo', 'licenseExpiry', 'insuranceExpiry', 'phone'].forEach(k => { if (b[k] !== undefined) p[k] = b[k]; });
    logAudit('Admin', 'fleet.rider.profile', u.name); store.save(); res.json(riderView(u));
  });
  app.post('/api/admin/fleet/riders/:userId/verify', auth, roleOnly('admin'), (req, res) => {
    const h = hid(req); const u = db.users.find(x => x.id === req.params.userId && x.role === 'rider' && x.hospitalId === h); if (!u) return res.status(404).json({ error: 'Rider not found' });
    let p = riderProfile(u.id); if (!p) { p = { userId: u.id, hospitalId: h }; db.riderProfiles.push(p); }
    const v = (req.body || {}).verification; if (!['pending', 'verified', 'rejected'].includes(v)) return res.status(400).json({ error: 'bad verification' });
    if (v === 'verified' && (!p.vehicleType || !p.plate || !p.licenseNo)) return res.status(400).json({ error: 'Add vehicle type, plate and licence before verifying' });
    p.verification = v; logAudit('Admin', 'fleet.rider.verify', u.name + ' -> ' + v); store.save(); res.json(riderView(u));
  });
  // a rider must be verified to accept delivery runs (used by the delivery flow)
  app.locals.riderVerified = id => { const p = riderProfile(id); return !!p && p.verification === 'verified'; };

  /* ---------------- CREW (certification + licence) ---------------- */
  const crewProfile = id => db.crewProfiles.find(p => p.userId === id);
  function crewView(u) { const p = crewProfile(u.id) || {}; return { userId: u.id, name: u.name, email: u.email, status: u.status || 'active',
    cert: p.cert || '', licenseNo: p.licenseNo || '', licenseExpiry: p.licenseExpiry || '', phone: p.phone || '', docFlags: docFlags(p) }; }
  app.get('/api/admin/fleet/crew', auth, roleOnly('admin'), (req, res) => {
    const h = hid(req); res.json(db.users.filter(u => u.role === 'crew' && u.hospitalId === h && u.status !== 'removed').map(crewView));
  });
  app.post('/api/admin/fleet/crew/:userId/profile', auth, roleOnly('admin'), (req, res) => {
    const h = hid(req); const u = db.users.find(x => x.id === req.params.userId && x.role === 'crew' && x.hospitalId === h); if (!u) return res.status(404).json({ error: 'Crew member not found' });
    let p = crewProfile(u.id); if (!p) { p = { userId: u.id, hospitalId: h }; db.crewProfiles.push(p); }
    const b = req.body || {}; ['cert', 'licenseNo', 'licenseExpiry', 'phone'].forEach(k => { if (b[k] !== undefined) p[k] = b[k]; });
    logAudit('Admin', 'fleet.crew.profile', u.name); store.save(); res.json(crewView(u));
  });

  /* ---------------- overview (readiness + compliance) ---------------- */
  app.get('/api/admin/fleet/overview', auth, roleOnly('admin'), (req, res) => {
    const h = hid(req);
    const veh = db.responders.filter(r => r.hospitalId === h && r.serviceStatus !== 'retired');
    const riders = db.users.filter(u => u.role === 'rider' && u.hospitalId === h && u.status !== 'removed');
    const crew = db.users.filter(u => u.role === 'crew' && u.hospitalId === h && u.status !== 'removed');
    res.json({
      vehicles: veh.length,
      inService: veh.filter(u => (u.serviceStatus || 'in-service') === 'in-service').length,
      maintenance: veh.filter(u => u.serviceStatus === 'maintenance').length,
      vehExpiring: veh.filter(u => docFlags(u).length).length,
      riders: riders.length,
      ridersVerified: riders.filter(u => { const p = riderProfile(u.id); return p && p.verification === 'verified'; }).length,
      ridersPending: riders.filter(u => { const p = riderProfile(u.id); return !p || p.verification !== 'verified'; }).length,
      crew: crew.length,
    });
  });
};

/* seed vehicle compliance + rider/crew onboarding profiles */
module.exports.seed = function (db, uid) {
  uid = uid || (p => p + '_' + Math.random().toString(36).slice(2, 9));
  db.riderProfiles = []; db.crewProfiles = [];
  const iso = d => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  // vehicles: service status + compliance dates (one in maintenance, one insurance expiring)
  (db.responders || []).forEach((u, i) => {
    u.serviceStatus = u.serviceStatus || 'in-service';
    u.make = u.make || ['Toyota', 'Mercedes', 'Ford', 'Toyota', 'Nissan', 'Ford'][i % 6];
    u.model = u.model || ['HiAce', 'Sprinter', 'Transit', 'Hilux', 'Urvan', 'Transit'][i % 6];
    u.odometer = u.odometer || (40000 + i * 12000);
    u.regExpiry = u.regExpiry || iso(300 - i * 20);
    u.insuranceExpiry = u.insuranceExpiry || iso(200 - i * 30);
    u.inspectionExpiry = u.inspectionExpiry || iso(120 - i * 15);
    u.lastServiceAt = u.lastServiceAt || iso(-30 - i * 10);
  });
  const a2 = (db.responders || []).find(r => r.id === 'amb_2'); if (a2) { a2.serviceStatus = 'maintenance'; a2.insuranceExpiry = iso(40); }
  const a3 = (db.responders || []).find(r => r.id === 'amb_3'); if (a3) { a3.inspectionExpiry = iso(20); }  // expiring soon
  // riders: existing seeded riders are onboarded + verified; profiles vary
  const riderSeed = {
    u_rider: ['Motorbike', 'LAG-981-RD', 'DRV-3391', iso(400), 'verified'],
    u_rider2: ['Motorbike', 'LAG-774-RD', 'DRV-8820', iso(500), 'verified'],
    u_rider3: ['Bicycle', 'N/A', 'DRV-1180', iso(250), 'verified'],
    u_rider4: ['Car', 'LAG-552-RD', 'DRV-4410', iso(-10), 'pending'],  // licence expired -> pending onboarding
    u_rider_r2: ['Motorbike', 'LAG-668-RD', 'DRV-9014', iso(320), 'verified'],
  };
  Object.keys(riderSeed).forEach(id => { const u = (db.users || []).find(x => x.id === id); if (!u) return; const [vehicleType, plate, licenseNo, licenseExpiry, verification] = riderSeed[id];
    db.riderProfiles.push({ userId: id, hospitalId: u.hospitalId, vehicleType, plate, licenseNo, licenseExpiry, insuranceExpiry: iso(300), phone: '', verification }); });
  // crew: certification + licence
  const crewSeed = { u_crew: ['Paramedic', 'EMT-P-2231', iso(365)], u_crew2: ['EMT-Basic', 'EMT-B-5540', iso(210)] };
  Object.keys(crewSeed).forEach(id => { const u = (db.users || []).find(x => x.id === id); if (!u) return; const [cert, licenseNo, licenseExpiry] = crewSeed[id];
    db.crewProfiles.push({ userId: id, hospitalId: u.hospitalId, cert, licenseNo, licenseExpiry, phone: '' }); });
};
