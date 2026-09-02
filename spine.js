'use strict';
/* ============================================================================
 * THE SPINE
 * ----------------------------------------------------------------------------
 * One order object travels the whole system. Every department is a window onto
 * the same order. An in-process event bus turns one change into all of its
 * consequences (notifications now; billing, dispatch, etc. later just subscribe).
 *
 *   Lab order:    ordered -> in_progress -> resulted -> closed
 *   Prescription: ordered -> verified -> ready -> collected -> closed
 *
 * This module OWNS the canonical order routes. The old fragmented lab/pharmacy/
 * doctor-order endpoints were removed from server.js and now live here.
 * ==========================================================================*/

module.exports = function mountSpine(app, ctx) {
  const { db, store, uid, auth, doctorOnly, roleOnly, pname, myDoctor, X, logAudit } = ctx;

  /* ---- collections (safe on an older db file) ---- */
  if (!db.orders) db.orders = [];
  if (!db.notifications) db.notifications = [];
  if (!db.events) db.events = [];

  const PICKUP_WINDOW_MS = 2 * 24 * 3600e3; // 2 days to collect before it is "missed"

  /* ---- the event bus ---- */
  const subscribers = {};
  function on(type, fn) { (subscribers[type] || (subscribers[type] = [])).push(fn); }
  function emit(type, data) {
    const ev = { id: uid('ev'), type, at: Date.now(), data: evData(data) };
    db.events.push(ev);
    if (db.events.length > 500) db.events.splice(0, db.events.length - 500);
    (subscribers[type] || []).forEach(fn => { try { fn(data); } catch (e) { /* a subscriber must never break the caller */ } });
    (subscribers['*'] || []).forEach(fn => { try { fn(ev); } catch (e) {} });
    return ev;
  }
  // store a light copy in the event log (ids, not the whole nested object)
  function evData(d) { const o = d && d.order; return o ? { orderId: o.id, type: o.type, status: o.status, patientId: o.patientId, hospitalId: o.hospitalId } : (d || {}); }

  function notify(userId, kind, text, link) {
    if (!userId) return;
    db.notifications.push({ id: uid('nt'), userId, kind, text: text, link: link || '', read: false, at: Date.now() });
    if (db.notifications.length > 800) db.notifications.splice(0, db.notifications.length - 800);
  }

  /* ---- small lookups ---- */
  function patientUserId(pid) { const u = db.users.find(x => x.role === 'patient' && x.patientId === pid); return u ? u.id : null; }
  function ngn(n) { return '\u20a6' + (Number(n) || 0).toLocaleString('en-NG'); }
  const DELIVERY_FEE = 1500; // dispatch fee, paid directly to the rider on delivery (never in-app)
  function gencode() { return String(Math.floor(100000 + Math.random() * 900000)); }
  function hospName(hid) { const h = (db.hospitals || []).find(x => x.id === hid); return h ? h.name : ''; }
  function orderById(id) { return db.orders.find(o => o.id === id); }
  function orderLabel(o) { return o.type === 'lab' ? ((o.detail.tests || []).join(', ') || 'tests') : (o.detail.drug || 'medication'); }
  function myHid(req) { return req.user.hospitalId; }
  function setStatus(o, status, byName, note) { o.status = status; o.updatedAt = Date.now(); o.events.push({ at: Date.now(), status, by: byName || '', note: note || '' }); }

  /* ---- order factory ---- */
  function createOrder({ hospitalId, patientId, type, byUserId, byName, detail }) {
    const o = {
      id: uid(type === 'lab' ? 'lo' : 'rx'),
      hospitalId, patientId, patientName: pname(patientId),
      type, by: byUserId, byName: byName || 'Doctor',
      status: 'ordered', detail: detail || {}, result: null, dueAt: null, missedFlagged: false,
      events: [{ at: Date.now(), status: 'ordered', by: byName || 'Doctor', note: '' }],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    db.orders.push(o);
    emit('order.created', { order: o });
    return o;
  }

  /* ---- subscribers: events become notifications (the closed loop) ---- */
  on('order.created', ({ order: o }) => {
    const role = o.type === 'lab' ? 'lab' : 'pharmacy';
    db.users.filter(u => u.role === role && u.hospitalId === o.hospitalId && u.status !== 'pending')
      .forEach(u => notify(u.id, 'order', (o.type === 'lab' ? 'New lab order: ' : 'New prescription: ') + orderLabel(o) + ' for ' + o.patientName, 'orders'));
  });
  on('order.ready', ({ order: o }) => {
    notify(patientUserId(o.patientId), 'pickup', 'Your medication ' + orderLabel(o) + ' is ready for pickup at ' + hospName(o.hospitalId) + '.', 'orders');
  });
  on('order.resulted', ({ order: o }) => {
    notify(patientUserId(o.patientId), 'result', 'Your lab results for ' + orderLabel(o) + ' are ready to view.', 'orders');
    notify(o.by, 'result', 'Results posted for ' + o.patientName + ': ' + orderLabel(o), 'orders');
  });
  on('order.collected', ({ order: o }) => {
    notify(o.by, 'done', o.patientName + ' collected ' + orderLabel(o) + '.', 'orders');
  });
  on('order.missed', ({ order: o }) => {
    notify(patientUserId(o.patientId), 'reminder', 'Reminder: your medication ' + orderLabel(o) + ' is still waiting at ' + hospName(o.hospitalId) + '. Please collect it.', 'orders');
  });

  // expose the bus so later modules (dispatch, billing) can publish/subscribe
  app.locals.spine = { emit, on, notify, createOrder, orderById };

  /* ---- serialisers ---- */
  function pharmView(o) { return { items: o.items || null, drugTotal: o.drugTotal != null ? o.drugTotal : null, fulfilment: o.fulfilment || null, address: o.address || null, paid: !!o.paid, pickupCode: o.pickupCode || null, dispatchFee: o.dispatchFee != null ? o.dispatchFee : null, delivered: !!o.delivered }; }
  function forStaff(o) { return Object.assign({ id: o.id, type: o.type, status: o.status, patient: o.patientName, patientId: o.patientId, by: o.byName, detail: o.detail, result: o.result, dueAt: o.dueAt, overdue: isOverdue(o), createdAt: o.createdAt, updatedAt: o.updatedAt, events: o.events }, pharmView(o)); }
  function forDoctor(o) { return { id: o.id, type: o.type, status: o.status, patient: o.patientName, patientId: o.patientId, label: orderLabel(o), detail: o.detail, result: o.result, hospital: hospName(o.hospitalId), createdAt: o.createdAt, updatedAt: o.updatedAt }; }
  function forPatient(o) { return Object.assign({ id: o.id, type: o.type, status: o.status, label: orderLabel(o), detail: o.detail, result: o.result, by: o.byName, hospital: hospName(o.hospitalId), dueAt: o.dueAt, createdAt: o.createdAt, updatedAt: o.updatedAt }, pharmView(o)); }
  function isOverdue(o) { return o.type === 'rx' && o.status === 'ready' && o.dueAt && Date.now() > o.dueAt; }

  /* ========================= NOTIFICATIONS (shared) ========================= */
  app.get('/api/notifications', auth, (req, res) => {
    const list = db.notifications.filter(n => n.userId === req.user.id).sort((a, b) => b.at - a.at).slice(0, 50);
    res.json({ unread: list.filter(n => !n.read).length, items: list });
  });
  app.get('/api/notifications/count', auth, (req, res) => {
    res.json({ unread: db.notifications.filter(n => n.userId === req.user.id && !n.read).length });
  });
  app.post('/api/notifications/read', auth, (req, res) => {
    db.notifications.forEach(n => { if (n.userId === req.user.id) n.read = true; }); store.save(); res.json({ ok: true });
  });
  app.post('/api/notifications/:id/read', auth, (req, res) => {
    const n = db.notifications.find(x => x.id === req.params.id && x.userId === req.user.id); if (n) n.read = true; store.save(); res.json({ ok: true });
  });

  /* ========================= DOCTOR: create + track orders ================= */
  function docCreate(req, res, type) {
    const b = req.body || {};
    if (!b.patientId) return res.status(400).json({ error: 'Choose a patient first' });
    let detail;
    if (type === 'lab') {
      const tests = b.tests || (b.test ? [b.test] : []);
      if (!tests.length) return res.status(400).json({ error: 'Add at least one test' });
      detail = { tests };
    } else {
      if (!b.drug) return res.status(400).json({ error: 'Enter the medication' });
      detail = { drug: b.drug, sig: b.sig || 'As directed', qty: b.qty || '' };
    }
    const d = myDoctor(req);
    const o = createOrder({ hospitalId: req.user.hospitalId, patientId: b.patientId, type, byUserId: req.user.id, byName: d ? d.name : (req.user.name || 'Doctor'), detail });
    logAudit(d ? d.name : 'Doctor', type === 'lab' ? 'lab.ordered' : 'prescribe', orderLabel(o));
    store.save();
    res.json(forDoctor(o));
  }
  app.post('/api/doc/orders', auth, doctorOnly, (req, res) => docCreate(req, res, (req.body && req.body.type) === 'lab' ? 'lab' : 'rx'));
  app.get('/api/doc/orders', auth, doctorOnly, (req, res) => {
    res.json(db.orders.filter(o => o.by === req.user.id).sort((a, b) => b.updatedAt - a.updatedAt).map(forDoctor));
  });
  // back-compat aliases for the existing doctor UI
  app.post('/api/doc/lab-order', auth, doctorOnly, (req, res) => docCreate(req, res, 'lab'));
  app.post('/api/doc/prescribe', auth, doctorOnly, (req, res) => docCreate(req, res, 'rx'));

  /* ========================= LAB ========================================== */
  app.get('/api/lab/overview', auth, roleOnly('lab'), (req, res) => {
    const mine = db.orders.filter(o => o.type === 'lab' && o.hospitalId === myHid(req));
    const sod = new Date(); sod.setHours(0, 0, 0, 0); const dayStart = sod.getTime();
    const evAt = (o, st) => { const e = (o.events || []).find(x => x.status === st); return e ? e.at : null; };
    const resultedToday = mine.filter(o => ['resulted', 'closed'].includes(o.status) && (evAt(o, 'resulted') || o.updatedAt || 0) >= dayStart);
    const turns = mine.filter(o => ['resulted', 'closed'].includes(o.status)).map(o => { const a = evAt(o, 'ordered') || o.createdAt, b = evAt(o, 'resulted') || o.updatedAt; return (a && b && b >= a) ? (b - a) / 60000 : null; }).filter(x => x != null);
    res.json({ facility: hospName(myHid(req)), ordered: mine.filter(o => o.status === 'ordered').length, in_progress: mine.filter(o => o.status === 'in_progress').length, resulted: mine.filter(o => ['resulted', 'closed'].includes(o.status)).length,
      pending: mine.filter(o => ['ordered', 'in_progress'].includes(o.status)).length, resultedToday: resultedToday.length,
      avgTurnaroundMin: turns.length ? Math.round(turns.reduce((s, x) => s + x, 0) / turns.length) : null,
      breakdown: { ordered: mine.filter(o => o.status === 'ordered').length, in_progress: mine.filter(o => o.status === 'in_progress').length, resulted: mine.filter(o => ['resulted', 'closed'].includes(o.status)).length } });
  });
  app.get('/api/lab/orders', auth, roleOnly('lab'), (req, res) => {
    const mine = db.orders.filter(o => o.type === 'lab' && o.hospitalId === myHid(req));
    const active = mine.filter(o => ['ordered', 'in_progress'].includes(o.status)).sort((a, b) => a.createdAt - b.createdAt);
    const done = mine.filter(o => ['resulted', 'closed'].includes(o.status)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
    res.json({ active: active.map(forStaff), done: done.map(forStaff) });
  });
  app.post('/api/lab/orders/:id/collect', auth, roleOnly('lab'), (req, res) => {
    const o = orderById(req.params.id); if (!o || o.type !== 'lab') return res.status(404).json({ error: 'Order not found' });
    if (o.hospitalId !== myHid(req)) return res.status(403).json({ error: 'Not your hospital' });
    setStatus(o, 'in_progress', 'Lab', 'sample collected'); emit('order.collected_sample', { order: o });
    logAudit('Lab', 'sample.collected', orderLabel(o)); store.save(); res.json(forStaff(o));
  });
  app.post('/api/lab/orders/:id/result', auth, roleOnly('lab'), async (req, res) => {
    const o = orderById(req.params.id); if (!o || o.type !== 'lab') return res.status(404).json({ error: 'Order not found' });
    if (o.hospitalId !== myHid(req)) return res.status(403).json({ error: 'Not your hospital' });
    let rows = (req.body && req.body.results) || [];
    if (!rows.length) return res.status(400).json({ error: 'Enter at least one result value' });
    rows = rows.map(r => { const f = app.locals.labFlag ? app.locals.labFlag(myHid(req), r.test, r.value) : {}; return Object.assign({}, r, { flag: r.flag || f.flag || 'normal', low: (r.low != null ? r.low : f.low), high: (r.high != null ? r.high : f.high), unit: r.unit || f.unit || '', refText: f.refText || r.refText || '' }); });
    o.result = rows;
    rows.forEach(r => db.results.push({ id: uid('r'), patientId: o.patientId, test: r.test, value: r.value, unit: r.unit || '', flag: r.flag || 'normal', low: r.low, high: r.high, when: 'just now' }));
    setStatus(o, 'resulted', 'Lab', rows.length + ' result(s) posted');
    emit('order.resulted', { order: o });
    setStatus(o, 'closed', 'Lab', 'order complete');
    db.claims.push({ id: uid('c'), patientId: o.patientId, what: 'Laboratory: ' + orderLabel(o), amount: 12000, status: 'Processing', when: 'now' });
    logAudit('Lab', 'result.posted', orderLabel(o));
    try { await X.sendSMS({ to: (db.patients.find(p => p.id === o.patientId) || {}).phone, text: 'MediCore: your lab results are ready in the app.' }); } catch (e) {}
    store.save(); res.json(forStaff(o));
  });

  /* ========================= PHARMACY ===================================== */
  app.get('/api/pharm/overview', auth, roleOnly('pharmacy'), (req, res) => {
    const mine = db.orders.filter(o => o.type === 'rx' && o.hospitalId === myHid(req));
    const inv = db.inventory.filter(i => i.facility === staffFacility(req));
    const sod = new Date(); sod.setHours(0, 0, 0, 0); const dayStart = sod.getTime();
    const evAt = (o, st) => { const e = (o.events || []).find(x => x.status === st); return e ? e.at : null; };
    const doneToday = mine.filter(o => o.status === 'collected' && (evAt(o, 'collected') || o.updatedAt || 0) >= dayStart);
    const turns = mine.filter(o => ['ready', 'collected', 'closed'].includes(o.status)).map(o => { const a = evAt(o, 'ordered') || o.createdAt, b = evAt(o, 'ready') || o.updatedAt; return (a && b && b >= a) ? (b - a) / 60000 : null; }).filter(x => x != null);
    res.json({ facility: hospName(myHid(req)), queue: mine.filter(o => ['ordered', 'verified'].includes(o.status)).length,
      ready: mine.filter(o => o.status === 'ready').length, overdue: mine.filter(isOverdue).length,
      low: inv.filter(i => i.stock > 0 && i.stock <= 10).length, out: inv.filter(i => i.stock === 0).length,
      dispensedToday: doneToday.length,
      breakdown: { ordered: mine.filter(o => o.status === 'ordered').length, verified: mine.filter(o => o.status === 'verified').length, ready: mine.filter(o => o.status === 'ready').length, collected: mine.filter(o => ['collected', 'closed'].includes(o.status)).length },
      avgTurnaroundMin: turns.length ? Math.round(turns.reduce((s, x) => s + x, 0) / turns.length) : null });
  });
  app.get('/api/pharm/queue', auth, roleOnly('pharmacy'), (req, res) => {
    const mine = db.orders.filter(o => o.type === 'rx' && o.hospitalId === myHid(req));
    // raise a one-time reminder for anything now overdue
    mine.filter(isOverdue).forEach(o => { if (!o.missedFlagged) { o.missedFlagged = true; emit('order.missed', { order: o }); } });
    const active = mine.filter(o => ['ordered', 'verified', 'priced', 'ready', 'dispatched'].includes(o.status)).sort((a, b) => a.createdAt - b.createdAt);
    const done = mine.filter(o => ['collected', 'delivered'].includes(o.status)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
    store.save();
    res.json({ active: active.map(forStaff), done: done.map(forStaff) });
  });
  function staffFacility(req) { const u = db.users.find(x => x.id === req.user.id); return u ? u.facility : null; }
  app.post('/api/pharm/orders/:id/verify', auth, roleOnly('pharmacy'), (req, res) => {
    const o = orderById(req.params.id); if (!o || o.type !== 'rx') return res.status(404).json({ error: 'Order not found' });
    if (o.hospitalId !== myHid(req)) return res.status(403).json({ error: 'Not your hospital' });
    setStatus(o, 'verified', 'Pharmacy', 'checked and verified'); logAudit('Pharmacy', 'rx.verified', orderLabel(o)); store.save(); res.json(forStaff(o));
  });
  app.post('/api/pharm/orders/:id/ready', auth, roleOnly('pharmacy'), (req, res) => {
    const o = orderById(req.params.id); if (!o || o.type !== 'rx') return res.status(404).json({ error: 'Order not found' });
    if (o.hospitalId !== myHid(req)) return res.status(403).json({ error: 'Not your hospital' });
    o.dueAt = Date.now() + PICKUP_WINDOW_MS; o.missedFlagged = false;
    setStatus(o, 'ready', 'Pharmacy', 'dispensed, ready for pickup');
    // decrement real inventory (FEFO, by dispensed quantity) if the item exists
    try { if (app.locals.invDispenseByName) { const qty = (o.items && o.items[0] && o.items[0].qty) || 1; app.locals.invDispenseByName(myHid(req), req, o.detail.drug || '', qty, o.id); } } catch (e) {}
    emit('order.ready', { order: o });
    logAudit('Pharmacy', 'rx.ready', orderLabel(o)); store.save(); res.json(forStaff(o));
  });
  app.post('/api/pharm/orders/:id/collect', auth, roleOnly('pharmacy'), (req, res) => {
    const o = orderById(req.params.id); if (!o || o.type !== 'rx') return res.status(404).json({ error: 'Order not found' });
    if (o.hospitalId !== myHid(req)) return res.status(403).json({ error: 'Not your hospital' });
    // paid in-app orders can only be released against the patient's pickup code (identity check)
    if (o.pickupCode) {
      if (o.fulfilment === 'deliver') return res.status(400).json({ error: 'This order is for delivery, not pickup' });
      const code = ((req.body || {}).code || '').toString().trim();
      if (code !== o.pickupCode) return res.status(400).json({ error: 'Pickup code does not match. Ask the patient for the 6-digit code in their app.' });
    }
    setStatus(o, 'collected', 'Pharmacy', 'collected by patient' + (o.pickupCode ? ' (code verified)' : '')); emit('order.collected', { order: o });
    logAudit('Pharmacy', 'rx.collected', orderLabel(o)); store.save(); res.json(forStaff(o));
  });
  // pharmacy attaches per-drug pricing to a prescription (drugs only; inventory suggests prices)
  app.post('/api/pharm/orders/:id/price', auth, roleOnly('pharmacy'), (req, res) => {
    const o = orderById(req.params.id); if (!o || o.type !== 'rx') return res.status(404).json({ error: 'Order not found' });
    if (o.hospitalId !== myHid(req)) return res.status(403).json({ error: 'Not your hospital' });
    let items = (req.body && req.body.items) || null;
    if (!items) { const nm = o.detail.drug || 'Medication'; const pr = app.locals.invPriceByName ? app.locals.invPriceByName(myHid(req), nm) : null; items = [{ name: nm, qty: 1, price: pr && pr.price ? pr.price : 2500 }]; }
    items = items.map(it => ({ name: (it.name || 'Item').toString().slice(0, 80), qty: Math.max(1, parseInt(it.qty, 10) || 1), price: Math.max(0, Math.round(Number(it.price) || 0)) }));
    o.items = items; o.drugTotal = items.reduce((s, it) => s + it.price * it.qty, 0);
    setStatus(o, 'priced', 'Pharmacy', 'priced, awaiting patient payment & collection choice');
    notify(patientUserId(o.patientId), 'pickup', 'Your prescription ' + orderLabel(o) + ' is priced (' + ngn(o.drugTotal) + '). Choose delivery or pickup and pay in the app.', 'orders');
    logAudit('Pharmacy', 'rx.priced', orderLabel(o) + ' ' + ngn(o.drugTotal)); store.save(); res.json(forStaff(o));
  });
  app.get('/api/pharm/price-suggest', auth, roleOnly('pharmacy'), (req, res) => {
    const p = app.locals.invPriceByName ? app.locals.invPriceByName(myHid(req), req.query.drug || '') : null;
    res.json(p || { price: null, unit: null, inStock: null });
  });
  app.post('/api/pharm/orders/:id/remind', auth, roleOnly('pharmacy'), (req, res) => {
    const o = orderById(req.params.id); if (!o || o.type !== 'rx') return res.status(404).json({ error: 'Order not found' });
    if (o.hospitalId !== myHid(req)) return res.status(403).json({ error: 'Not your hospital' });
    emit('order.missed', { order: o }); logAudit('Pharmacy', 'rx.remind', orderLabel(o)); store.save(); res.json({ ok: true });
  });

  // PATIENT: choose collection method + pay for the DRUGS only (in-app). A pickup code is issued.
  // Delivery (dispatch) fee is NOT charged in-app; it is paid directly to the rider on delivery.
  app.post('/api/patient/rx/:id/pay', auth, async (req, res) => {
    if (!req.user.patientId) return res.status(403).json({ error: 'Patients only' });
    const o = orderById(req.params.id); if (!o || o.type !== 'rx' || o.patientId !== req.user.patientId) return res.status(404).json({ error: 'Prescription not found' });
    if (o.status !== 'priced') return res.status(400).json({ error: o.paid ? 'This prescription is already paid.' : 'This prescription has not been priced yet.' });
    const b = req.body || {}; const fulfilment = b.fulfilment === 'deliver' ? 'deliver' : 'collect';
    let address = null;
    if (fulfilment === 'deliver') { address = (b.address || '').toString().trim(); if (!address) { const p = db.patients.find(x => x.id === o.patientId); address = p && p.address ? p.address : ''; } if (!address) return res.status(400).json({ error: 'A delivery address is required' }); }
    // charge the drug total in-app (dev-mode payment)
    try { if (X && X.initPayment) await X.initPayment({ amount: o.drugTotal, ref: 'rx-' + o.id, description: 'Medication ' + orderLabel(o) }); } catch (e) {}
    o.paid = true; o.paidAt = Date.now(); o.fulfilment = fulfilment; o.address = address; o.pickupCode = gencode();
    db.claims = db.claims || []; db.claims.push({ id: uid('c'), patientId: o.patientId, what: 'Medication: ' + orderLabel(o), amount: o.drugTotal, status: 'Paid', when: 'now' });
    if (fulfilment === 'collect') {
      o.dueAt = Date.now() + PICKUP_WINDOW_MS;
      setStatus(o, 'ready', 'Patient', 'paid, collecting in person');
      notify(patientUserId(o.patientId), 'pickup', 'Payment received. Show code ' + o.pickupCode + ' at ' + hospName(o.hospitalId) + ' to collect ' + orderLabel(o) + '.', 'orders');
    } else {
      o.dispatchFee = DELIVERY_FEE;
      db.deliveries = db.deliveries || [];
      const _pk = (db.hospitals || []).find(h => h.id === o.hospitalId);
      const _pp = (db.patients || []).find(p => p.id === o.patientId);
      const pickup = _pk && _pk.lat != null ? { lat: _pk.lat, lng: _pk.lng, name: _pk.name } : null;
      const dLat = parseFloat(b.lat), dLng = parseFloat(b.lng);
      const dropoff = { lat: isFinite(dLat) ? dLat : (_pp && _pp.homeLat != null ? _pp.homeLat : null), lng: isFinite(dLng) ? dLng : (_pp && _pp.homeLng != null ? _pp.homeLng : null), address: address };
      db.deliveries.push({ id: uid('dl'), orderId: o.id, hospitalId: o.hospitalId, patientId: o.patientId, patientName: o.patientName, address: address, code: o.pickupCode, dispatchFee: o.dispatchFee, label: orderLabel(o), status: 'transit', progress: 0, pickup: pickup, dropoff: dropoff, riderLat: pickup ? pickup.lat : null, riderLng: pickup ? pickup.lng : null, assignedRiderId: null, createdAt: Date.now() });
      setStatus(o, 'dispatched', 'Patient', 'paid, out for delivery to ' + address);
      db.users.filter(u => u.role === 'rider' && u.hospitalId === o.hospitalId).forEach(u => notify(u.id, 'delivery', 'New medication delivery to ' + address + '. Collect ' + ngn(o.dispatchFee) + ' from patient on delivery.', 'deliveries'));
      notify(patientUserId(o.patientId), 'pickup', 'Payment received. A rider will deliver ' + orderLabel(o) + '. Pay the ' + ngn(o.dispatchFee) + ' dispatch fee to the rider on delivery, and give code ' + o.pickupCode + ' to confirm.', 'orders');
    }
    store.save();
    res.json(forPatient(o));
  });
  // RIDER: mark a medication delivery as delivered, confirming the patient's pickup code
  app.post('/api/rider/deliveries/:id/deliver', auth, roleOnly('rider'), (req, res) => {
    db.deliveries = db.deliveries || [];
    const d = db.deliveries.find(x => x.id === req.params.id && x.hospitalId === req.user.hospitalId);
    if (!d) return res.status(404).json({ error: 'Delivery not found' });
    if (d.assignedRiderId && d.assignedRiderId !== req.user.id) return res.status(403).json({ error: 'This run is assigned to another rider' });
    const code = ((req.body || {}).code || '').toString().trim();
    if (code !== d.code) return res.status(400).json({ error: 'Delivery code does not match the patient app' });
    d.status = 'delivered'; d.deliveredAt = Date.now(); d.assignedRiderId = d.assignedRiderId || req.user.id;
    const o = orderById(d.orderId); if (o) { o.delivered = true; setStatus(o, 'delivered', 'Rider', 'delivered, dispatch fee ' + ngn(d.dispatchFee) + ' paid to rider'); emit('order.collected', { order: o }); }
    logAudit('Rider', 'rx.delivered', d.label + ' -> ' + d.address); store.save();
    res.json({ ok: true, order: o ? forStaff(o) : null });
  });
  // RIDER: accept (claim) a delivery so it is theirs; others then see it as taken
  app.post('/api/rider/deliveries/:id/claim', auth, roleOnly('rider'), (req, res) => {
    db.deliveries = db.deliveries || [];
    const d = db.deliveries.find(x => x.id === req.params.id && x.hospitalId === req.user.hospitalId);
    if (!d) return res.status(404).json({ error: 'Delivery not found' });
    if (app.locals.riderVerified && !app.locals.riderVerified(req.user.id)) return res.status(403).json({ error: 'Your rider onboarding is not verified yet. Ask your hospital admin.' });
    if (d.assignedRiderId && d.assignedRiderId !== req.user.id) return res.status(409).json({ error: 'Already accepted by another rider' });
    d.assignedRiderId = req.user.id; store.save();
    res.json({ ok: true });
  });
  app.get('/api/rider/deliveries', auth, roleOnly('rider'), (req, res) => {
    db.deliveries = db.deliveries || [];
    const nameOf = uid => { const u = db.users.find(x => x.id === uid); return u ? u.name : null; };
    res.json(db.deliveries.filter(d => d.hospitalId === req.user.hospitalId && d.status !== 'delivered')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(d => Object.assign({}, d, { mine: d.assignedRiderId === req.user.id, claimed: !!d.assignedRiderId, claimedByOther: !!d.assignedRiderId && d.assignedRiderId !== req.user.id, riderName: d.assignedRiderId ? nameOf(d.assignedRiderId) : null })));
  });

  // PATIENT: track my medication delivery on a map (pharmacy -> rider -> my address)
  app.get('/api/patient/rx/:id/track', auth, (req, res) => {
    if (!req.user.patientId) return res.status(403).json({ error: 'Patients only' });
    const o = orderById(req.params.id); if (!o || o.patientId !== req.user.patientId) return res.status(404).json({ error: 'Order not found' });
    db.deliveries = db.deliveries || [];
    const d = db.deliveries.find(x => x.orderId === o.id);
    if (!d) return res.json({ active: false });
    res.json({ active: d.status !== 'delivered', status: d.status, label: d.label, code: d.code, dispatchFee: d.dispatchFee, etaSec: d.etaSec != null ? d.etaSec : null, pickup: d.pickup || null, dropoff: d.dropoff || null, rider: d.riderLat != null ? { lat: d.riderLat, lng: d.riderLng } : null });
  });

  // PATIENT: my current active medication delivery (for the home live banner/mini-map)
  app.get('/api/patient/delivery', auth, (req, res) => {
    if (!req.user.patientId) return res.status(403).json({ error: 'Patients only' });
    db.deliveries = db.deliveries || [];
    const d = db.deliveries.filter(x => x.patientId === req.user.patientId && x.orderId && x.status && x.status !== 'delivered').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    if (!d) return res.json({ active: false });
    res.json({ active: true, orderId: d.orderId, status: d.status, label: d.label, code: d.code, dispatchFee: d.dispatchFee, etaSec: d.etaSec != null ? d.etaSec : null, pickup: d.pickup || null, dropoff: d.dropoff || null, rider: d.riderLat != null ? { lat: d.riderLat, lng: d.riderLng } : null });
  });

  // Demo movement: walk each in-transit delivery from the pharmacy to the patient's
  // address so the rider position is live on the map. Real deployments replace this
  // with the rider phone's GPS; the code-confirmed handover is what proves delivery.
  // Demo: a delivery drives itself from pharmacy to patient, and if no one confirms
  // the handover it auto-completes after a short dwell at the door, so the whole
  // rider process plays out on its own, exactly like a crewless ambulance finishing
  // its run. A real rider still closes it earlier with the patient's code; production
  // would drop the auto-handover and keep the code as the proof of delivery.
  const DELIVERY_STEP = parseFloat(process.env.DELIVERY_STEP) || 0.05;              // fraction of the trip per second (~20s door to door)
  const DELIVERY_DWELL_MS = parseInt(process.env.DELIVERY_DWELL_MS, 10) || 12000;   // pause at the door before the demo auto-hands-over
  function stepDeliveries() {
    let changed = false; const now = Date.now();
    (db.deliveries || []).forEach(d => {
      if (!d.pickup || !d.dropoff || d.dropoff.lat == null) return;
      if (d.status === 'transit') {
        d.progress = Math.min(1, (d.progress || 0) + DELIVERY_STEP);
        d.riderLat = d.pickup.lat + (d.dropoff.lat - d.pickup.lat) * d.progress;
        d.riderLng = d.pickup.lng + (d.dropoff.lng - d.pickup.lng) * d.progress;
        d.etaSec = Math.round((1 - d.progress) * (1 / DELIVERY_STEP));
        if (d.progress >= 1) {
          d.status = 'arriving'; d.arrivedAt = now; d.etaSec = 0; d.riderLat = d.dropoff.lat; d.riderLng = d.dropoff.lng;
          const uid2 = patientUserId(d.patientId);
          if (uid2) notify(uid2, 'orders', 'Your rider has arrived with ' + d.label + '. Give the 6-digit code to confirm handover.', 'orders');
        }
        changed = true;
      } else if (d.status === 'arriving' && d.arrivedAt && (now - d.arrivedAt) >= DELIVERY_DWELL_MS) {
        d.status = 'delivered'; d.deliveredAt = now; d.auto = true;
        const o = orderById(d.orderId); if (o) { o.delivered = true; setStatus(o, 'delivered', 'Rider', 'delivered (demo auto-handover)'); emit('order.collected', { order: o }); }
        const uid2 = patientUserId(d.patientId);
        if (uid2) notify(uid2, 'orders', 'Your medication ' + d.label + ' has been delivered.', 'orders');
        changed = true;
      }
    });
    if (changed) store.save();
  }
  app.locals.deliveryTick = stepDeliveries;
  if (!process.env.MC_SERVERLESS) { const _delTimer = setInterval(stepDeliveries, 1000); if (_delTimer.unref) _delTimer.unref(); }

  /* ========================= PATIENT: my orders + results ================= */
  app.get('/api/patient/orders', auth, (req, res) => {
    if (!req.user.patientId) return res.status(403).json({ error: 'Patients only' });
    const mine = db.orders.filter(o => o.patientId === req.user.patientId).sort((a, b) => b.updatedAt - a.updatedAt);
    res.json(mine.map(forPatient));
  });

  return { emit, on, notify, createOrder };
};
