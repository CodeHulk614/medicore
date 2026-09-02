'use strict';
/*
 * MediCore pharmacy inventory (Phase 1 + 2), hospital-scoped.
 * Real model, not a single number:
 *  - Item catalog (SKU, form, controlled flag, reorder point)
 *  - Batch/lot stock (batch no, expiry, qty on hand, cost, supplier, status)
 *  - Immutable movement ledger (receive / dispense / adjust / count / return / recall / reserve / release)
 *  - Derived states: on-hand = sum of active batches; committed = open reservations; available = on-hand - committed
 *  - FEFO dispensing (earliest expiry first), by actual quantity, blocked when short or expired
 *  - Suppliers + purchase orders (create -> receive into batches)
 *  - Customer returns (back to batch) and supplier returns (with credit)
 *  - Batch recall (quarantine + return claim)
 * Exposes app.locals.invDispenseByName / invPriceByName so the prescription flow uses real stock.
 */
module.exports = function (app, ctx) {
  const { db, store, uid, auth, roleOnly, logAudit } = ctx;
  ['invItems', 'invBatches', 'invMoves', 'invReservations', 'suppliers', 'purchaseOrders', 'recalls'].forEach(k => { if (!db[k]) db[k] = []; });

  const hid = req => req.user.hospitalId;
  const uname = req => { const u = db.users.find(x => x.id === req.user.id); return u ? u.name : 'Staff'; };
  const today = () => new Date().toISOString().slice(0, 10);
  const daysTo = expiry => { if (!expiry) return null; return Math.floor((new Date(expiry + 'T00:00:00Z') - new Date(today() + 'T00:00:00Z')) / 86400000); };
  const round = n => Math.max(0, Math.round(Number(n) || 0));

  function move(h, itemId, batchId, type, qty, reason, ref, req) {
    const m = { id: uid('mv'), hospitalId: h, itemId, batchId: batchId || null, type, qty, reason: reason || '', ref: ref || '', userId: req.user.id, userName: uname(req), at: new Date().toISOString() };
    db.invMoves.unshift(m); if (db.invMoves.length > 5000) db.invMoves.pop(); return m;
  }
  const itemBatches = (h, itemId) => db.invBatches.filter(b => b.hospitalId === h && b.itemId === itemId && b.status === 'active');
  const onHand = (h, itemId) => itemBatches(h, itemId).reduce((s, b) => s + b.qtyOnHand, 0);
  const committed = (h, itemId) => db.invReservations.filter(r => r.hospitalId === h && r.itemId === itemId && r.status === 'open').reduce((s, r) => s + r.qty, 0);
  const available = (h, itemId) => onHand(h, itemId) - committed(h, itemId);
  function itemView(h, it) {
    const bs = itemBatches(h, it.id); const oh = bs.reduce((s, b) => s + b.qtyOnHand, 0); const cm = committed(h, it.id);
    const soon = bs.filter(b => b.qtyOnHand > 0 && daysTo(b.expiry) !== null && daysTo(b.expiry) <= 90);
    const expired = bs.filter(b => b.qtyOnHand > 0 && daysTo(b.expiry) !== null && daysTo(b.expiry) < 0);
    return { id: it.id, sku: it.sku, name: it.name, form: it.form, strength: it.strength, unit: it.unit, controlled: !!it.controlled,
      price: it.price, reorderPoint: it.reorderPoint, reorderQty: it.reorderQty,
      onHand: oh, committed: cm, available: oh - cm, batches: bs.length,
      low: (oh - cm) <= (it.reorderPoint || 0), out: oh <= 0,
      nearExpiry: soon.length, expired: expired.length,
      earliestExpiry: bs.filter(b => b.qtyOnHand > 0).map(b => b.expiry).sort()[0] || null };
  }
  const itemById = (h, id) => db.invItems.find(i => i.id === id && i.hospitalId === h);
  const batchById = (h, id) => db.invBatches.find(b => b.id === id && b.hospitalId === h);

  /* ---------- overview ---------- */
  app.get('/api/pharm/inv/overview', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const items = db.invItems.filter(i => i.hospitalId === h);
    const views = items.map(i => itemView(h, i));
    const batches = db.invBatches.filter(b => b.hospitalId === h && b.status === 'active' && b.qtyOnHand > 0);
    const exp = d => batches.filter(b => daysTo(b.expiry) !== null && daysTo(b.expiry) >= (d === 30 ? 0 : d === 60 ? 31 : 61) && daysTo(b.expiry) <= (d === 30 ? 30 : d === 60 ? 60 : 90)).length;
    res.json({
      items: items.length,
      lowStock: views.filter(v => v.low && !v.out).length,
      outOfStock: views.filter(v => v.out).length,
      controlled: items.filter(i => i.controlled).length,
      stockValue: batches.reduce((s, b) => s + b.qtyOnHand * (b.cost || 0), 0),
      expiring: { d30: exp(30), d60: exp(60), d90: exp(90), expired: batches.filter(b => daysTo(b.expiry) < 0).length },
      quarantined: db.invBatches.filter(b => b.hospitalId === h && b.status === 'quarantined').length,
      openPOs: db.purchaseOrders.filter(p => p.hospitalId === h && (p.status === 'draft' || p.status === 'sent')).length,
      openRecalls: db.recalls.filter(r => r.hospitalId === h && r.claimStatus !== 'credited').length,
    });
  });

  /* ---------- catalog ---------- */
  app.get('/api/pharm/inv/items', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); res.json(db.invItems.filter(i => i.hospitalId === h).map(i => itemView(h, i)));
  });
  app.post('/api/pharm/inv/items', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const b = req.body || {};
    const name = (b.name || '').trim(); if (!name) return res.status(400).json({ error: 'Item name is required' });
    const sku = (b.sku || '').trim() || ('SKU-' + Math.floor(10000 + Math.random() * 89999));
    if (db.invItems.find(i => i.hospitalId === h && i.sku === sku)) return res.status(409).json({ error: 'That SKU already exists' });
    const it = { id: uid('it'), hospitalId: h, sku, name, form: b.form || '', strength: b.strength || '', unit: b.unit || 'unit',
      controlled: !!b.controlled, price: round(b.price), reorderPoint: round(b.reorderPoint), reorderQty: round(b.reorderQty) || 0 };
    db.invItems.push(it); logAudit('Pharmacy', 'inv.item.add', name); store.save(); res.json(itemView(h, it));
  });
  app.post('/api/pharm/inv/items/:id', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const it = itemById(h, req.params.id); if (!it) return res.status(404).json({ error: 'Item not found' });
    const b = req.body || {}; ['name', 'form', 'strength', 'unit'].forEach(k => { if (b[k] !== undefined) it[k] = b[k]; });
    ['price', 'reorderPoint', 'reorderQty'].forEach(k => { if (b[k] !== undefined) it[k] = round(b[k]); });
    if (b.controlled !== undefined) it.controlled = !!b.controlled;
    store.save(); res.json(itemView(h, it));
  });
  app.get('/api/pharm/inv/items/:id', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const it = itemById(h, req.params.id); if (!it) return res.status(404).json({ error: 'Item not found' });
    const batches = db.invBatches.filter(b => b.hospitalId === h && b.itemId === it.id).map(b => ({ ...b, days: daysTo(b.expiry) })).sort((a, b) => (a.expiry || '').localeCompare(b.expiry || ''));
    const moves = db.invMoves.filter(m => m.hospitalId === h && m.itemId === it.id).slice(0, 40);
    res.json({ item: itemView(h, it), batches, moves });
  });

  /* ---------- receiving (add stock as a batch) ---------- */
  function receive(h, req, itemId, batchNo, expiry, qty, cost, supplierId, ref) {
    const it = itemById(h, itemId); if (!it) throw new Error('Item not found');
    qty = round(qty); if (qty <= 0) throw new Error('Quantity must be positive');
    const batch = { id: uid('bt'), hospitalId: h, itemId, batchNo: (batchNo || 'B' + Date.now()).toString(), expiry: expiry || '',
      qtyReceived: qty, qtyOnHand: qty, cost: round(cost), supplierId: supplierId || '', receivedAt: new Date().toISOString(), status: 'active' };
    db.invBatches.push(batch); move(h, itemId, batch.id, 'receive', qty, 'goods received', ref, req);
    return batch;
  }
  app.post('/api/pharm/inv/receive', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const b = req.body || {};
    try { const batch = receive(h, req, b.itemId, b.batchNo, b.expiry, b.qty, b.cost, b.supplierId, b.ref);
      logAudit('Pharmacy', 'inv.receive', (itemById(h, b.itemId) || {}).name + ' x' + batch.qtyReceived); store.save(); res.json(batch);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  /* ---------- FEFO dispense (by actual quantity) ---------- */
  function fefoDispense(h, req, itemId, qty, ref, reason) {
    qty = round(qty); if (qty <= 0) throw new Error('Quantity must be positive');
    // consume a matching open reservation if present
    const resv = db.invReservations.find(r => r.hospitalId === h && r.itemId === itemId && r.ref === ref && r.status === 'open');
    const avail = resv ? onHand(h, itemId) : available(h, itemId);
    if (avail < qty) { const e = new Error('Not enough stock: ' + avail + ' available, ' + qty + ' requested'); e.short = true; throw e; }
    const batches = itemBatches(h, itemId).filter(b => b.qtyOnHand > 0 && daysTo(b.expiry) >= 0).sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999'));
    let need = qty; const used = [];
    for (const bt of batches) { if (need <= 0) break; const take = Math.min(bt.qtyOnHand, need); bt.qtyOnHand -= take; need -= take;
      if (bt.qtyOnHand === 0) bt.status = 'active'; move(h, itemId, bt.id, 'dispense', -take, reason || 'dispensed', ref, req); used.push({ batchNo: bt.batchNo, qty: take, expiry: bt.expiry }); }
    if (need > 0) { const e = new Error('Only usable (non-expired) stock is short by ' + need); e.short = true; throw e; }
    if (resv) resv.status = 'consumed';
    return { dispensed: qty, batches: used };
  }
  app.post('/api/pharm/inv/dispense', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const b = req.body || {};
    try { const r = fefoDispense(h, req, b.itemId, b.qty, b.ref || '', b.reason); logAudit('Pharmacy', 'inv.dispense', (itemById(h, b.itemId) || {}).name + ' x' + r.dispensed); store.save(); res.json(r); }
    catch (e) { res.status(e.short ? 409 : 400).json({ error: e.message }); }
  });

  /* ---------- reservations (commit stock on order) ---------- */
  app.post('/api/pharm/inv/reserve', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const b = req.body || {}; const qty = round(b.qty);
    if (!itemById(h, b.itemId)) return res.status(404).json({ error: 'Item not found' });
    if (available(h, b.itemId) < qty) return res.status(409).json({ error: 'Not enough available to reserve' });
    const r = { id: uid('rs'), hospitalId: h, itemId: b.itemId, qty, ref: b.ref || '', status: 'open', at: new Date().toISOString() };
    db.invReservations.push(r); move(h, b.itemId, null, 'reserve', qty, 'reserved for ' + (b.ref || 'order'), b.ref, req); store.save(); res.json(r);
  });
  app.post('/api/pharm/inv/release', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const ref = (req.body || {}).ref || '';
    const list = db.invReservations.filter(r => r.hospitalId === h && r.ref === ref && r.status === 'open');
    list.forEach(r => { r.status = 'released'; move(h, r.itemId, null, 'release', -r.qty, 'reservation released', ref, req); });
    store.save(); res.json({ released: list.length });
  });

  /* ---------- adjust / cycle count / take-down ---------- */
  app.post('/api/pharm/inv/items/:id/adjust', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const it = itemById(h, req.params.id); if (!it) return res.status(404).json({ error: 'Item not found' });
    const b = req.body || {}; const delta = parseInt(b.delta, 10) || 0; const reason = (b.reason || '').trim() || 'manual adjustment';
    let bt = b.batchId ? batchById(h, b.batchId) : itemBatches(h, it.id).sort((a, c) => (a.expiry || '9999').localeCompare(c.expiry || '9999'))[0];
    if (delta < 0) { if (!bt) return res.status(400).json({ error: 'No batch to remove from' }); if (bt.qtyOnHand + delta < 0) return res.status(400).json({ error: 'Cannot remove more than the batch holds' }); bt.qtyOnHand += delta; }
    else { if (!bt) return res.status(400).json({ error: 'Receive stock first (no batch to add to)' }); bt.qtyOnHand += delta; }
    move(h, it.id, bt.id, 'adjust', delta, reason, '', req); logAudit('Pharmacy', 'inv.adjust', it.name + ' ' + (delta > 0 ? '+' : '') + delta + ' (' + reason + ')'); store.save(); res.json(itemView(h, it));
  });
  app.post('/api/pharm/inv/batches/:id/count', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const bt = batchById(h, req.params.id); if (!bt) return res.status(404).json({ error: 'Batch not found' });
    const counted = round((req.body || {}).counted); const variance = counted - bt.qtyOnHand;
    bt.qtyOnHand = counted; move(h, bt.itemId, bt.id, 'count', variance, 'cycle count' + (variance ? (' variance ' + (variance > 0 ? '+' : '') + variance) : ''), '', req);
    logAudit('Pharmacy', 'inv.count', bt.batchNo + ' -> ' + counted); store.save(); res.json({ ok: true, variance });
  });

  /* ---------- returns ---------- */
  app.post('/api/pharm/inv/return-in', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const b = req.body || {}; const bt = batchById(h, b.batchId); if (!bt) return res.status(404).json({ error: 'Batch not found' });
    const qty = round(b.qty); bt.qtyOnHand += qty; if (bt.status === 'quarantined') return res.status(400).json({ error: 'Cannot restock a quarantined batch' });
    move(h, bt.itemId, bt.id, 'return-in', qty, (b.reason || 'customer return') , '', req); logAudit('Pharmacy', 'inv.return.in', bt.batchNo + ' +' + qty); store.save(); res.json({ ok: true });
  });
  app.post('/api/pharm/inv/return-supplier', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const b = req.body || {}; const bt = batchById(h, b.batchId); if (!bt) return res.status(404).json({ error: 'Batch not found' });
    const qty = round(b.qty); if (qty > bt.qtyOnHand) return res.status(400).json({ error: 'Cannot return more than the batch holds' });
    bt.qtyOnHand -= qty; const credit = qty * (bt.cost || 0);
    move(h, bt.itemId, bt.id, 'return-supplier', -qty, 'returned to supplier (credit ' + credit + ')', b.supplierId || bt.supplierId, req);
    logAudit('Pharmacy', 'inv.return.supplier', bt.batchNo + ' -' + qty + ' credit ' + credit); store.save(); res.json({ ok: true, credit });
  });

  /* ---------- recall (quarantine a batch + return claim) ---------- */
  app.post('/api/pharm/inv/recall', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const b = req.body || {}; const bt = batchById(h, b.batchId); if (!bt) return res.status(404).json({ error: 'Batch not found' });
    const removed = bt.qtyOnHand; bt.status = 'quarantined';
    move(h, bt.itemId, bt.id, 'recall', -removed, 'RECALL: ' + (b.reason || 'safety recall'), '', req);
    const rc = { id: uid('rc'), hospitalId: h, itemId: bt.itemId, batchId: bt.id, batchNo: bt.batchNo, reason: b.reason || 'safety recall', qty: removed, at: new Date().toISOString(), claimStatus: 'open' };
    db.recalls.unshift(rc); logAudit('Pharmacy', 'inv.recall', bt.batchNo + ' (' + removed + ' quarantined)'); store.save(); res.json({ ok: true, quarantined: removed, recall: rc });
  });
  app.get('/api/pharm/inv/recalls', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); res.json(db.recalls.filter(r => r.hospitalId === h).map(r => ({ ...r, item: (itemById(h, r.itemId) || {}).name })));
  });
  app.post('/api/pharm/inv/recalls/:id/claim', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const rc = db.recalls.find(r => r.id === req.params.id && r.hospitalId === h); if (!rc) return res.status(404).json({ error: 'Recall not found' });
    rc.claimStatus = (req.body || {}).status || 'sent'; store.save(); res.json(rc);
  });

  /* ---------- suppliers ---------- */
  app.get('/api/pharm/inv/suppliers', auth, roleOnly('pharmacy'), (req, res) => res.json(db.suppliers.filter(s => s.hospitalId === hid(req))));
  app.post('/api/pharm/inv/suppliers', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const b = req.body || {}; if (!(b.name || '').trim()) return res.status(400).json({ error: 'Supplier name required' });
    const s = { id: uid('sp'), hospitalId: h, name: b.name.trim(), phone: b.phone || '', email: b.email || '' }; db.suppliers.push(s); store.save(); res.json(s);
  });

  /* ---------- purchase orders (create -> receive) ---------- */
  app.get('/api/pharm/inv/po', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); res.json(db.purchaseOrders.filter(p => p.hospitalId === h).map(p => ({ ...p, supplier: (db.suppliers.find(s => s.id === p.supplierId) || {}).name })));
  });
  app.post('/api/pharm/inv/po', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const b = req.body || {}; const lines = (b.lines || []).map(l => ({ itemId: l.itemId, name: (itemById(h, l.itemId) || {}).name || '', qty: round(l.qty), cost: round(l.cost) })).filter(l => l.qty > 0);
    if (!lines.length) return res.status(400).json({ error: 'Add at least one line' });
    const po = { id: uid('po'), hospitalId: h, code: 'PO-' + Math.floor(1000 + Math.random() * 8999), supplierId: b.supplierId || '', status: 'sent', lines, createdAt: new Date().toISOString(), createdBy: uname(req) };
    db.purchaseOrders.unshift(po); logAudit('Pharmacy', 'inv.po.create', po.code + ' (' + lines.length + ' lines)'); store.save(); res.json(po);
  });
  app.post('/api/pharm/inv/po/:id/receive', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const po = db.purchaseOrders.find(p => p.id === req.params.id && p.hospitalId === h); if (!po) return res.status(404).json({ error: 'PO not found' });
    if (po.status === 'received') return res.status(400).json({ error: 'Already received' });
    const recv = (req.body || {}).lines || [];  // [{itemId, batchNo, expiry, qty, cost}]
    let n = 0; recv.forEach(l => { try { receive(h, req, l.itemId, l.batchNo, l.expiry, l.qty || (po.lines.find(x => x.itemId === l.itemId) || {}).qty, l.cost != null ? l.cost : (po.lines.find(x => x.itemId === l.itemId) || {}).cost, po.supplierId, po.code); n++; } catch (e) {} });
    po.status = 'received'; po.receivedAt = new Date().toISOString(); logAudit('Pharmacy', 'inv.po.receive', po.code + ' (' + n + ' lines)'); store.save(); res.json({ ok: true, received: n, po });
  });
  app.post('/api/pharm/inv/po/:id/cancel', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); const po = db.purchaseOrders.find(p => p.id === req.params.id && p.hospitalId === h); if (!po) return res.status(404).json({ error: 'PO not found' });
    if (po.status === 'received') return res.status(400).json({ error: 'Cannot cancel a received PO' }); po.status = 'cancelled'; store.save(); res.json(po);
  });

  /* ---------- ledger ---------- */
  app.get('/api/pharm/inv/moves', auth, roleOnly('pharmacy'), (req, res) => {
    const h = hid(req); let m = db.invMoves.filter(x => x.hospitalId === h); if (req.query.itemId) m = m.filter(x => x.itemId === req.query.itemId);
    res.json(m.slice(0, 100).map(x => ({ ...x, item: (itemById(h, x.itemId) || {}).name })));
  });

  /* ---------- hooks for the prescription flow (real stock instead of -1) ---------- */
  app.locals.invByName = function (h, drug) {
    const nm = (drug || '').toLowerCase(); if (!nm) return null;
    return db.invItems.find(i => i.hospitalId === h && (nm.startsWith((i.name || '').toLowerCase().split(' ')[0]) || (i.name || '').toLowerCase().startsWith(nm.split(' ')[0])));
  };
  app.locals.invPriceByName = function (h, drug) { const it = app.locals.invByName(h, drug); if (!it) return null; return { price: it.price, unit: it.unit, inStock: available(h, it.id) }; };
  app.locals.invDispenseByName = function (h, req, drug, qty, ref) { const it = app.locals.invByName(h, drug); if (!it) return { matched: false }; try { const r = fefoDispense(h, req, it.id, qty || 1, ref || '', 'prescription dispense'); return { matched: true, ...r }; } catch (e) { return { matched: true, error: e.message }; } };
};

/* ---------- seed realistic inventory per hospital ---------- */
module.exports.seed = function (db, uid) {
  uid = uid || (p => p + '_' + Math.random().toString(36).slice(2, 9));
  ['invItems', 'invBatches', 'invMoves', 'invReservations', 'suppliers', 'purchaseOrders', 'recalls'].forEach(k => { db[k] = []; });
  const iso = d => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  const supp = {};
  [['h_grand', 'Emzor Pharmaceutical', '0803 111 2222'], ['h_grand', 'Fidson Healthcare', '0806 333 4444'], ['h_river', 'May & Baker Nigeria', '0802 555 6666']]
    .forEach(([h, name, phone]) => { const s = { id: uid('sp'), hospitalId: h, name, phone, email: '' }; db.suppliers.push(s); (supp[h] = supp[h] || []).push(s); });
  // catalog per hospital: [name, form, strength, unit, price, reorderPoint, controlled]
  const CATALOG = {
    h_grand: [
      ['Amlodipine', 'Tablet', '5mg', 'pack of 30', 2500, 20, false],
      ['Paracetamol', 'Tablet', '1g', 'pack of 20', 800, 40, false],
      ['Metformin', 'Tablet', '500mg', 'pack of 30', 3200, 20, false],
      ['Lisinopril', 'Tablet', '10mg', 'pack of 30', 4100, 15, false],
      ['Amoxicillin', 'Capsule', '500mg', 'pack of 21', 3500, 25, false],
      ['Artemether/Lumefantrine', 'Tablet', '20/120mg', 'pack of 24', 1800, 30, false],
      ['Codeine Linctus', 'Syrup', '15mg/5ml', 'bottle 100ml', 2200, 10, true],
    ],
    h_river: [
      ['Amlodipine', 'Tablet', '5mg', 'pack of 30', 2600, 15, false],
      ['Paracetamol', 'Tablet', '1g', 'pack of 20', 850, 30, false],
      ['Amoxicillin', 'Capsule', '500mg', 'pack of 21', 3600, 20, false],
      ['Salbutamol', 'Inhaler', '100mcg', 'inhaler', 3900, 10, false],
    ],
  };
  const mv = (h, itemId, batchId, type, qty, reason) => db.invMoves.push({ id: uid('mv'), hospitalId: h, itemId, batchId, type, qty, reason, ref: '', userId: 'seed', userName: 'System', at: new Date().toISOString() });
  Object.keys(CATALOG).forEach(h => {
    CATALOG[h].forEach((row, idx) => {
      const [name, form, strength, unit, price, rop, controlled] = row;
      const it = { id: uid('it'), hospitalId: h, sku: (name.slice(0, 4).toUpperCase() + '-' + strength.replace(/[^0-9]/g, '')).slice(0, 12) + '-' + idx, name, form, strength, unit, controlled, price, reorderPoint: rop, reorderQty: rop * 2 };
      db.invItems.push(it);
      // give most items 1-2 batches with varied expiries; make a couple low / out / near-expiry
      const plans = [];
      if (name === 'Lisinopril') { /* out of stock */ }
      else if (name === 'Metformin') { plans.push([9, iso(20), price * 0.6]); }         // near-expiry, low
      else if (name === 'Amoxicillin') { plans.push([60, iso(400), price * 0.6], [40, iso(75), price * 0.6]); } // two batches, one expiring <90d
      else if (name === 'Paracetamol') { plans.push([300, iso(500), price * 0.5]); }
      else { plans.push([Math.max(rop * 2, 40), iso(300 + idx * 30), Math.round(price * 0.6)]); }
      plans.forEach((p, k) => { const bt = { id: uid('bt'), hospitalId: h, itemId: it.id, batchNo: 'B' + (2600 + idx * 10 + k), expiry: p[1], qtyReceived: p[0], qtyOnHand: p[0], cost: Math.round(p[2]), supplierId: (supp[h][0] || {}).id || '', receivedAt: new Date().toISOString(), status: 'active' }; db.invBatches.push(bt); mv(h, it.id, bt.id, 'receive', p[0], 'opening stock'); });
    });
  });
  // one open purchase order at Grandville (awaiting delivery)
  const g = db.invItems.filter(i => i.hospitalId === 'h_grand');
  const lis = g.find(i => i.name === 'Lisinopril'); const met = g.find(i => i.name === 'Metformin');
  db.purchaseOrders.push({ id: uid('po'), hospitalId: 'h_grand', code: 'PO-2041', supplierId: (supp['h_grand'][0] || {}).id, status: 'sent',
    lines: [lis && { itemId: lis.id, name: lis.name, qty: 30, cost: 2400 }, met && { itemId: met.id, name: met.name, qty: 40, cost: 1900 }].filter(Boolean),
    createdAt: new Date().toISOString(), createdBy: 'System' });
};
