'use strict';
/* ============================================================================
 * EMERGENCY DISPATCH (CAD) + AUTOMATIC VEHICLE LOCATION (AVL)  -  multi-tenant
 * ----------------------------------------------------------------------------
 * Every ambulance belongs to a hospital. A patient may only summon a unit from a
 * hospital they are registered with. A dispatcher, and the map, only ever see
 * their own hospital's units, cases and patients.
 *
 * Stages advance AUTOMATICALLY from the unit's position and dwell time (arriving
 * on scene, loading the patient, arriving at hospital, handover). The manual
 * buttons remain only as an offline override for the crew.
 *
 *   Unit:  available -> enroute -> onscene -> transporting -> athospital -> returning -> available
 *   Case:  requested -> enroute -> onscene -> transporting -> arrived   -> closed
 *
 * The unit follows a real road route when the routing service is reachable, and
 * falls back to a direct line offline. Honest note: real AVL needs a GPS device
 * in each vehicle; here the position is simulated along that route at road speed.
 * Everything else (tenancy, assignment, ETA, routing, notifications) is real.
 * ==========================================================================*/

module.exports = function mountDispatch(app, ctx) {
  const { db, store, uid, auth, roleOnly, logAudit } = ctx;
  const spine = app.locals.spine || { notify() {}, emit() {} };

  const SPEED_KMH = Number(process.env.DISPATCH_SPEED_KMH || 42);
  const LOAD_MS = Number(process.env.DISPATCH_LOAD_MS || 9000);
  const HANDOVER_MS = Number(process.env.DISPATCH_HANDOVER_MS || 9000);
  const ARRIVE_KM = 0.05;

  if (!db.responders) db.responders = [];
  if (!db.emergencies) db.emergencies = [];

  const toRad = d => d * Math.PI / 180;
  function haversineKm(a, b) { if (!a || !b) return 0; const R = 6371, dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng); const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(s))); }
  const hospital = id => (db.hospitals || []).find(h => h.id === id);
  const hospCoords = id => { const h = hospital(id); return h && h.lat ? { lat: h.lat, lng: h.lng } : null; };
  const unitById = id => db.responders.find(r => r.id === id);
  const caseById = id => db.emergencies.find(e => e.id === id);
  const patientUserId = pid => { const u = db.users.find(x => x.role === 'patient' && x.patientId === pid); return u ? u.id : null; };
  const etaSec = (from, to) => Math.max(0, Math.round(haversineKm(from, to) / SPEED_KMH * 3600));
  const stamp = (c, status, note) => { c.status = status; (c.timeline = c.timeline || []).push({ at: Date.now(), status, note: note || '' }); c.updatedAt = Date.now(); };
  const hospitalAdmins = hid => db.users.filter(u => u.role === 'admin' && u.hospitalId === hid);
  const notifyHospital = (hid, kind, text) => hospitalAdmins(hid).forEach(u => spine.notify(u.id, kind, text, 'emergency'));
  const notifyPatient = (pid, kind, text) => { const uid2 = patientUserId(pid); if (uid2) spine.notify(uid2, kind, text, 'track'); };

  async function getRoute(a, b) {
    try {
      if (process.env.DISABLE_OSRM) throw new Error('routing disabled');
      const url = 'https://router.project-osrm.org/route/v1/driving/' + a.lng + ',' + a.lat + ';' + b.lng + ',' + b.lat + '?overview=full&geometries=geojson';
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 3500);
      const res = await fetch(url, { signal: ctrl.signal }); clearTimeout(to);
      const j = await res.json();
      const coords = j && j.routes && j.routes[0] && j.routes[0].geometry && j.routes[0].geometry.coordinates;
      if (coords && coords.length) return coords.map(c => ({ lat: c[1], lng: c[0] }));
    } catch (e) { /* offline -> straight line */ }
    return [{ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng }];
  }
  function setDestination(u, target) {
    u.target = { lat: target.lat, lng: target.lng };
    u.route = [{ lat: u.lat, lng: u.lng }, { lat: target.lat, lng: target.lng }]; u.routeI = 0;
    getRoute({ lat: u.lat, lng: u.lng }, target).then(r => { if (r && r.length >= 2 && u.target && u.target.lat === target.lat && u.target.lng === target.lng) { u.route = r; u.routeI = 0; } }).catch(() => {});
  }
  function advanceAlong(u, stepKm) {
    if (!u.route || u.route.length < 2) { if (!u.target) return true; u.route = [{ lat: u.lat, lng: u.lng }, u.target]; u.routeI = 0; }
    let rem = stepKm, guard = 0;
    while (rem > 0 && u.routeI < u.route.length - 1 && guard++ < 5000) {
      const cur = { lat: u.lat, lng: u.lng }, nxt = u.route[u.routeI + 1];
      const seg = haversineKm(cur, nxt);
      if (seg <= 1e-6) { u.routeI++; continue; }
      if (rem >= seg) { u.lat = nxt.lat; u.lng = nxt.lng; u.routeI++; rem -= seg; }
      else { const f = rem / seg; u.lat = cur.lat + (nxt.lat - cur.lat) * f; u.lng = cur.lng + (nxt.lng - cur.lng) * f; rem = 0; }
    }
    const target = u.route[u.route.length - 1];
    return u.routeI >= u.route.length - 1 || haversineKm(u, target) <= ARRIVE_KM;
  }

  let lastTick = Date.now();
  function tick() {
    const now = Date.now(), dt = (now - lastTick) / 1000; lastTick = now; if (dt <= 0) return;
    const step = SPEED_KMH / 3600 * dt; let changed = false;
    db.responders.forEach(u => {
      if (['enroute', 'transporting', 'returning'].includes(u.status) && u.target) { changed = true; if (advanceAlong(u, step)) onArrive(u); }
      else if (u.status === 'onscene' && u.onsceneSince && now - u.onsceneSince >= LOAD_MS) { changed = true; autoTransport(u); }
      else if (u.status === 'athospital' && u.athospitalSince && now - u.athospitalSince >= HANDOVER_MS) { changed = true; autoClear(u); }
    });
    if (changed) store.save();
  }
  function onArrive(u) {
    const c = u.assignedCase ? caseById(u.assignedCase) : null; u.target = null; u.route = null; u.routeI = 0;
    if (u.status === 'enroute') {
      u.status = 'onscene'; u.onsceneSince = Date.now();
      if (c) { u.lat = c.lat; u.lng = c.lng; stamp(c, 'onscene', 'arrived on scene'); notifyHospital(c.hospitalId, 'emergency', u.name + ' is on scene for ' + c.kind + '.'); notifyPatient(c.patientId, 'track', 'Your ambulance (' + u.name + ') has arrived at the pickup point.'); }
    } else if (u.status === 'transporting') {
      u.status = 'athospital'; u.athospitalSince = Date.now();
      if (c) { const hc = hospCoords(c.hospitalId); if (hc) { u.lat = hc.lat; u.lng = hc.lng; } stamp(c, 'arrived', 'arrived at hospital'); notifyHospital(c.hospitalId, 'emergency', u.name + ' has ARRIVED with the patient. Receive now.'); }
    } else if (u.status === 'returning') { u.status = 'available'; u.assignedCase = null; }
  }
  function autoTransport(u) {
    const c = caseById(u.assignedCase); if (!c) return; const hid = c.hospitalId || u.hospitalId; const hc = hospCoords(hid); if (!hc) return;
    c.hospitalId = hid; u.status = 'transporting'; u.onsceneSince = null; setDestination(u, hc);
    stamp(c, 'transporting', 'transporting to ' + (hospital(hid) || {}).name);
    const eta = etaSec(u, hc);
    notifyHospital(hid, 'emergency', 'INBOUND: ' + u.name + ' transporting ' + (c.name || 'a patient') + ' (' + c.kind + '), ETA ' + Math.max(1, Math.round(eta / 60)) + ' min. Ready a bed.');
    notifyPatient(c.patientId, 'track', 'You are being transported to ' + (hospital(hid) || {}).name + '.');
  }
  function autoClear(u) {
    const c = caseById(u.assignedCase);
    if (c) { stamp(c, 'closed', 'run complete'); db.claims.push({ id: uid('c'), patientId: c.patientId || null, what: 'Ambulance: ' + c.kind, amount: 25000, status: 'Processing', when: 'now' }); }
    u.status = 'returning'; u.athospitalSince = null; setDestination(u, { lat: u.homeLat, lng: u.homeLng });
  }
  app.locals.dispatchTick = tick;
  if (!process.env.MC_SERVERLESS) { const timer = setInterval(tick, 1000); if (timer.unref) timer.unref(); }

  function unitView(u) {
    let eta = null; if (u.target && ['enroute', 'transporting'].includes(u.status)) eta = etaSec(u, u.target);
    return { id: u.id, name: u.name, type: u.type, plate: u.plate, crew: u.crew, crewed: !!u.crewUserId, status: u.status, lat: r5(u.lat), lng: r5(u.lng), hospital: (hospital(u.hospitalId) || {}).name || '', hospitalId: u.hospitalId, assignedCase: u.assignedCase, eta, route: u.route || null };
  }
  function caseView(c) {
    return { id: c.id, kind: c.kind, priority: c.priority, area: c.area, lat: r5(c.lat), lng: r5(c.lng), name: c.name, phone: c.phone, address: c.address, status: c.status, source: c.source, responderId: c.responderId, responder: c.responderId ? (unitById(c.responderId) || {}).name : null, hospitalId: c.hospitalId, hospital: (hospital(c.hospitalId) || {}).name || null, patientId: c.patientId, at: c.at, timeline: c.timeline || [] };
  }
  const r5 = n => typeof n === 'number' ? Math.round(n * 1e5) / 1e5 : n;

  function nearestHospitalId(pt, allowed) {
    let hs = (db.hospitals || []).filter(h => h.lat); if (allowed) hs = hs.filter(h => allowed.includes(h.id));
    if (!hs.length) return null; hs.sort((a, b) => haversineKm(pt, a) - haversineKm(pt, b)); return hs[0].id;
  }
  function newCase(o) {
    const pt = { lat: o.lat || 6.505, lng: o.lng || 3.36 };
    const hid = o.hospitalId || nearestHospitalId(pt, o.allowed);
    const e = { id: uid('em'), kind: o.kind || 'Medical emergency', area: o.area || 'Unknown', name: o.name || 'Caller', phone: o.phone || '', address: o.address || '', patientId: o.patientId || null, lat: pt.lat, lng: pt.lng, priority: o.priority || 'high', source: o.source || 'call', status: 'requested', responderId: null, hospitalId: hid, at: Date.now(), timeline: [{ at: Date.now(), status: 'requested', note: 'case raised (' + (o.source || 'call') + ')' }] };
    db.emergencies.unshift(e);
    db.users.filter(u => u.role === 'dispatch' && u.hospitalId === hid).forEach(u => spine.notify(u.id, 'emergency', 'New emergency: ' + e.kind + ' at ' + e.area + '.', 'cases'));
    logAudit('Emergency', 'case.raised', e.kind + ' at ' + e.area); store.save();
    return e;
  }
  app.post('/api/emergency', (req, res) => { const b = req.body || {}; res.json({ case: caseView(newCase({ kind: b.kind, area: b.area, name: b.name, phone: b.phone, lat: b.lat, lng: b.lng, priority: b.priority, source: b.source || 'call', hospitalId: b.hospitalId })) }); });

  app.post('/api/patient/sos', auth, (req, res) => {
    if (!req.user.patientId) return res.status(403).json({ error: 'Patients only' });
    const p = db.patients.find(x => x.id === req.user.patientId) || {}; const b = req.body || {};
    const allowed = p.hospitalId ? [p.hospitalId] : [];
    let hid = b.hospitalId; if (hid && !allowed.includes(hid)) return res.status(403).json({ error: 'You are not registered with that hospital' });
    let lat = b.lat, lng = b.lng, address = b.address;
    if (lat == null || lng == null) { lat = p.homeLat; lng = p.homeLng; address = p.address; }
    if (lat == null || lng == null) { const hc = hospCoords(allowed[0]); lat = (hc || {}).lat || 6.505; lng = (hc || {}).lng || 3.36; }
    if (!hid) hid = nearestHospitalId({ lat, lng }, allowed);
    if (!hid) return res.status(400).json({ error: 'No hospital available to dispatch from' });
    const e = newCase({ kind: b.kind || 'Medical emergency', area: p.area || 'your area', name: (p.first || '') + ' ' + (p.last || ''), phone: p.phone, patientId: p.id, lat, lng, address, priority: 'high', source: 'patient app', hospitalId: hid });
    res.json({ case: caseView(e) });
  });

  app.post('/api/patient/address', auth, (req, res) => {
    if (!req.user.patientId) return res.status(403).json({ error: 'Patients only' });
    const p = db.patients.find(x => x.id === req.user.patientId); if (!p) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {}; if (b.address != null) p.address = b.address; if (b.lat != null) p.homeLat = b.lat; if (b.lng != null) p.homeLng = b.lng;
    store.save(); res.json({ address: p.address, homeLat: p.homeLat, homeLng: p.homeLng });
  });
  app.get('/api/patient/hospitals', auth, (req, res) => {
    if (!req.user.patientId) return res.status(403).json({ error: 'Patients only' });
    const p = db.patients.find(x => x.id === req.user.patientId) || {};
    res.json((p.hospitalId ? [p.hospitalId] : []).map(id => hospital(id)).filter(Boolean).map(h => ({ id: h.id, name: h.name, area: h.area, lat: h.lat, lng: h.lng })));
  });
  app.get('/api/patient/track', auth, (req, res) => {
    if (!req.user.patientId) return res.status(403).json({ error: 'Patients only' });
    const c = db.emergencies.find(e => e.patientId === req.user.patientId && e.status !== 'closed');
    if (!c) return res.json({ active: false });
    const u = c.responderId ? unitById(c.responderId) : null;
    const hc = hospCoords(c.hospitalId);
    res.json({ active: true, case: caseView(c), unit: u ? unitView(u) : null,
      chat: c.chat || [],
      pickup: { lat: c.lat, lng: c.lng, address: c.address }, hospital: hc ? { lat: hc.lat, lng: hc.lng, name: (hospital(c.hospitalId) || {}).name } : null,
      bounds: mapBounds([{ lat: c.lat, lng: c.lng }, hc, u ? { lat: u.lat, lng: u.lng } : null]) });
  });
  // patient <-> ambulance chat on the active emergency
  app.post('/api/patient/track/chat', auth, (req, res) => {
    if (!req.user.patientId) return res.status(403).json({ error: 'Patients only' });
    const c = db.emergencies.find(e => e.patientId === req.user.patientId && e.status !== 'closed');
    if (!c) return res.status(404).json({ error: 'No active emergency' });
    const text = ((req.body || {}).text || '').toString().slice(0, 500).trim(); if (!text) return res.status(400).json({ error: 'Empty message' });
    c.chat = c.chat || []; const p = db.patients.find(x => x.id === c.patientId) || {};
    c.chat.push({ id: uid('m'), from: 'patient', fromName: (p.first || 'Patient'), text: text, at: Date.now() });
    const u = c.responderId ? unitById(c.responderId) : null;
    if (u && u.crewUserId && app.locals.spine) app.locals.spine.notify(u.crewUserId, 'emergency', 'Patient: ' + text, 'run');
    store.save(); res.json({ chat: c.chat });
  });

  const myHid = req => req.user.hospitalId;
  // admin live fleet: every ambulance registered to the admin's hospital, plus active cases
  app.get('/api/admin/fleet', auth, roleOnly('admin'), (req, res) => {
    const hid = req.user.hospitalId;
    const units = db.responders.filter(r => r.hospitalId === hid).map(function (u) { return Object.assign(unitView(u), { crewed: !!u.crewUserId, crewName: (db.users.find(function (x) { return x.id === u.crewUserId; }) || {}).name || null }); });
    const cases = db.emergencies.filter(function (c) { return c.hospitalId === hid && c.status !== 'closed'; }).map(caseView);
    const pts = units.map(function (u) { return { lat: u.lat, lng: u.lng }; }).concat(cases.map(function (c) { return { lat: c.lat, lng: c.lng }; }));
    const hc = hospCoords(hid); if (hc) pts.push(hc);
    res.json({
      hospital: (hospital(hid) || {}).name || '', hospitalPt: hc, units: units, cases: cases, bounds: mapBounds(pts),
      stats: { total: units.length, available: units.filter(function (u) { return u.status === 'available'; }).length, active: units.filter(function (u) { return ['enroute', 'onscene', 'transporting'].includes(u.status); }).length, crewed: units.filter(function (u) { return u.crewed; }).length, activeCases: cases.length }
    });
  });
  app.get('/api/dispatch/board', auth, roleOnly('dispatch'), (req, res) => {
    const hid = myHid(req);
    const units = db.responders.filter(r => r.hospitalId === hid);
    const cases = db.emergencies.filter(c => c.hospitalId === hid && c.status !== 'closed');
    const allClosed = db.emergencies.filter(c => c.hospitalId === hid && c.status === 'closed');
    const sod = new Date(); sod.setHours(0, 0, 0, 0); const ds = sod.getTime();
    const tAt = (c, st) => { const e = (c.timeline || []).find(x => x.status === st); return e ? e.at : null; };
    const closedToday = allClosed.filter(c => (tAt(c, 'closed') || c.updatedAt || 0) >= ds);
    const resp = allClosed.map(c => { const a = c.at, b = tAt(c, 'onscene'); return (a && b && b >= a) ? (b - a) / 60000 : null; }).filter(x => x != null);
    res.json({
      hospitalId: hid, hospitalName: (hospital(hid) || {}).name || '',
      units: units.map(unitView),
      cases: cases.map(caseView),
      recent: allClosed.slice(0, 6).map(caseView),
      deliveries: (db.deliveries || []).filter(d => d.hospitalId === hid && d.status !== 'delivered').map(d => { const ru = d.assignedRiderId ? (db.users.find(u => u.id === d.assignedRiderId) || {}).name : null; return { id: d.id, label: d.label, patientName: d.patientName, address: d.address, status: d.status, dispatchFee: d.dispatchFee, riderName: ru, pickup: d.pickup || null, dropoff: d.dropoff || null, rider: d.riderLat != null ? { lat: d.riderLat, lng: d.riderLng } : null }; }),
      hospitals: (db.hospitals || []).filter(h => h.id === hid && h.lat).map(h => ({ id: h.id, name: h.name, lat: h.lat, lng: h.lng })),
      bounds: mapBounds(units.map(u => ({ lat: u.lat, lng: u.lng })).concat(cases.map(c => ({ lat: c.lat, lng: c.lng }))).concat([hospCoords(hid)])),
      speedKmh: SPEED_KMH,
      stats: {
        available: units.filter(u => u.status === 'available').length,
        active: units.filter(u => ['enroute', 'onscene', 'transporting'].includes(u.status)).length,
        returning: units.filter(u => u.status === 'returning').length,
        activeCases: cases.length,
        runsToday: closedToday.length,
        avgResponseMin: resp.length ? Math.round(resp.reduce((s, x) => s + x, 0) / resp.length) : null,
        fleet: { available: units.filter(u => u.status === 'available').length, enroute: units.filter(u => u.status === 'enroute').length, onscene: units.filter(u => u.status === 'onscene').length, transporting: units.filter(u => u.status === 'transporting').length, returning: units.filter(u => u.status === 'returning').length },
      },
    });
  });
  app.get('/api/dispatch/cases', auth, roleOnly('dispatch'), (req, res) => res.json(db.emergencies.filter(c => c.hospitalId === myHid(req)).map(caseView)));
  app.get('/api/dispatch/responders', auth, roleOnly('dispatch'), (req, res) => res.json(db.responders.filter(r => r.hospitalId === myHid(req)).map(unitView)));

  app.post('/api/dispatch/cases/:id/assign', auth, roleOnly('dispatch'), (req, res) => {
    const c = caseById(req.params.id); if (!c) return res.status(404).json({ error: 'Case not found' });
    if (c.hospitalId !== myHid(req)) return res.status(403).json({ error: 'That case belongs to another hospital' });
    if (c.responderId) return res.status(400).json({ error: 'Already assigned' });
    let u = (req.body && req.body.responderId) ? db.responders.find(x => x.id === req.body.responderId && x.hospitalId === c.hospitalId && x.status === 'available') : null;
    if (!u) { const avail = db.responders.filter(x => x.hospitalId === c.hospitalId && x.status === 'available'); if (!avail.length) return res.status(400).json({ error: 'No units available at ' + ((hospital(c.hospitalId) || {}).name || 'this hospital') }); avail.sort((a, b) => haversineKm(a, c) - haversineKm(b, c)); u = avail[0]; }
    u.status = 'enroute'; u.assignedCase = c.id; u.onsceneSince = null; u.athospitalSince = null; setDestination(u, { lat: c.lat, lng: c.lng });
    c.responderId = u.id; stamp(c, 'enroute', u.name + ' dispatched, en route');
    notifyHospital(c.hospitalId, 'emergency', u.name + ' dispatched to ' + c.kind + ' at ' + c.area + '. Prepare to receive.');
    notifyPatient(c.patientId, 'track', u.name + ' is on the way to you. Track it live in the app.');
    logAudit('Dispatch', 'unit.dispatched', u.name + ' -> ' + c.kind); store.save();
    res.json({ unit: unitView(u), case: caseView(c) });
  });
  app.post('/api/dispatch/cases/:id/:action', auth, roleOnly('dispatch'), (req, res) => { const c = caseById(req.params.id); if (c && c.hospitalId !== myHid(req)) return res.status(403).json({ error: 'Another hospital' }); act(req, res, c); });

  app.post('/api/crew/pick', auth, roleOnly('crew'), (req, res) => { const u = unitById((req.body || {}).responderId); if (!u) return res.status(404).json({ error: 'Unit not found' }); db.responders.forEach(r => { if (r.crewUserId === req.user.id) r.crewUserId = null; }); u.crewUserId = req.user.id; store.save(); res.json(unitView(u)); });
  app.post('/api/crew/clockout', auth, roleOnly('crew'), (req, res) => { db.responders.forEach(r => { if (r.crewUserId === req.user.id) r.crewUserId = null; }); store.save(); res.json({ ok: true }); });
  app.get('/api/crew/me', auth, roleOnly('crew'), (req, res) => {
    const u = db.responders.find(r => r.crewUserId === req.user.id);
    const fleet = db.responders.filter(r => r.hospitalId === req.user.hospitalId && (!r.crewUserId || r.crewUserId === req.user.id)).map(unitView);
    if (!u) return res.json({ unit: null, fleet });
    const c = u.assignedCase ? caseById(u.assignedCase) : null;
    res.json({ unit: unitView(u), case: c ? caseView(c) : null, chat: (c && c.chat) || [], fleet, pickup: c ? { lat: c.lat, lng: c.lng } : null, hospitalPt: c ? hospCoords(c.hospitalId) : null, hospitals: (db.hospitals || []).filter(h => h.id === req.user.hospitalId).map(h => ({ id: h.id, name: h.name })), bounds: c ? mapBounds([{ lat: c.lat, lng: c.lng }, hospCoords(c.hospitalId), { lat: u.lat, lng: u.lng }]) : null });
  });
  // crew -> patient chat on the active run
  app.post('/api/crew/chat', auth, roleOnly('crew'), (req, res) => {
    const u = db.responders.find(r => r.crewUserId === req.user.id); if (!u || !u.assignedCase) return res.status(400).json({ error: 'No active assignment' });
    const c = caseById(u.assignedCase); if (!c) return res.status(404).json({ error: 'Case not found' });
    const text = ((req.body || {}).text || '').toString().slice(0, 500).trim(); if (!text) return res.status(400).json({ error: 'Empty message' });
    c.chat = c.chat || []; c.chat.push({ id: uid('m'), from: 'crew', fromName: u.name || 'Ambulance', text: text, at: Date.now() });
    const pu = c.patientId ? (db.users.find(x => x.role === 'patient' && x.patientId === c.patientId) || {}) : {};
    if (pu.id && app.locals.spine) app.locals.spine.notify(pu.id, 'emergency', 'Ambulance: ' + text, 'track');
    store.save(); res.json({ chat: c.chat });
  });
  app.post('/api/crew/:action', auth, roleOnly('crew'), (req, res) => { const u = db.responders.find(r => r.crewUserId === req.user.id); if (!u) return res.status(400).json({ error: 'Pick a unit first' }); if (!u.assignedCase) return res.status(400).json({ error: 'No active assignment' }); act(req, res, caseById(u.assignedCase)); });

  function act(req, res, c) {
    if (!c) return res.status(404).json({ error: 'Case not found' });
    const u = unitById(c.responderId); if (!u) return res.status(400).json({ error: 'No unit on this case' });
    const action = req.params.action, b = req.body || {};
    if (action === 'confirm') { u.status = 'enroute'; setDestination(u, { lat: c.lat, lng: c.lng }); stamp(c, 'enroute', u.name + ' en route'); }
    else if (action === 'onscene') { u.status = 'onscene'; u.onsceneSince = Date.now(); u.lat = c.lat; u.lng = c.lng; u.target = null; u.route = null; stamp(c, 'onscene', 'on scene (manual)'); }
    else if (action === 'transport') { const hid = b.hospitalId || c.hospitalId || u.hospitalId; const hc = hospCoords(hid); if (!hc) return res.status(400).json({ error: 'Receiving hospital has no location' }); c.hospitalId = hid; u.status = 'transporting'; u.onsceneSince = null; setDestination(u, hc); stamp(c, 'transporting', 'transporting (manual)'); notifyHospital(hid, 'emergency', 'INBOUND: ' + u.name + ' transporting ' + (c.name || 'a patient') + ' (' + c.kind + '), ETA ' + Math.max(1, Math.round(etaSec(u, hc) / 60)) + ' min.'); }
    else if (action === 'arrived') { u.status = 'athospital'; u.athospitalSince = Date.now(); const hc = hospCoords(c.hospitalId); if (hc) { u.lat = hc.lat; u.lng = hc.lng; } u.target = null; u.route = null; stamp(c, 'arrived', 'arrived (manual)'); notifyHospital(c.hospitalId, 'emergency', u.name + ' has arrived with the patient.'); }
    else if (action === 'clear') { stamp(c, 'closed', 'run complete (manual)'); db.claims.push({ id: uid('c'), patientId: c.patientId || null, what: 'Ambulance: ' + c.kind, amount: 25000, status: 'Processing', when: 'now' }); u.status = 'returning'; u.athospitalSince = null; setDestination(u, { lat: u.homeLat, lng: u.homeLng }); }
    else return res.status(400).json({ error: 'Unknown action' });
    logAudit('Dispatch', 'case.' + action, u.name + ' / ' + c.kind); store.save();
    res.json({ unit: unitView(u), case: caseView(c) });
  }

  app.get('/api/emergency/hospitals', auth, (req, res) => res.json((db.hospitals || []).filter(h => h.lat).map(h => ({ id: h.id, name: h.name }))));

  function mapBounds(pts) {
    const p = pts.filter(Boolean); if (!p.length) return { latMin: 6.42, latMax: 6.63, lngMin: 3.31, lngMax: 3.56 };
    let latMin = Math.min(...p.map(x => x.lat)), latMax = Math.max(...p.map(x => x.lat)), lngMin = Math.min(...p.map(x => x.lng)), lngMax = Math.max(...p.map(x => x.lng));
    const padLat = Math.max(0.01, (latMax - latMin) * 0.35), padLng = Math.max(0.01, (lngMax - lngMin) * 0.35);
    return { latMin: latMin - padLat, latMax: latMax + padLat, lngMin: lngMin - padLng, lngMax: lngMax + padLng };
  }

  return { tick, getRoute };
};
