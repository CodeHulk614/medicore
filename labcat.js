'use strict';
/*
 * MediCore laboratory catalog (hospital-scoped).
 * A catalog of tests, each with a specimen, unit, and reference range (numeric low/high,
 * or a qualitative expected result). Results posted by the lab are auto-flagged
 * low / high / abnormal against the catalog. Exposes app.locals.labFlag for the order flow.
 */
module.exports = function (app, ctx) {
  const { db, store, uid, auth, roleOnly, logAudit } = ctx;
  if (!db.labCatalog) db.labCatalog = [];
  const hid = req => req.user.hospitalId;
  const num = v => (v === '' || v == null ? null : Number(v));
  const view = t => ({ id: t.id, code: t.code, name: t.name, specimen: t.specimen, unit: t.unit, refLow: t.refLow, refHigh: t.refHigh, refText: t.refText || '', price: t.price || 0, qualitative: (t.refLow == null && t.refHigh == null) });

  app.get('/api/lab/catalog', auth, roleOnly('lab'), (req, res) => res.json(db.labCatalog.filter(t => t.hospitalId === hid(req)).map(view)));
  app.post('/api/lab/catalog', auth, roleOnly('lab'), (req, res) => {
    const h = hid(req); const b = req.body || {}; if (!(b.name || '').trim()) return res.status(400).json({ error: 'Test name is required' });
    const t = { id: uid('lt'), hospitalId: h, code: (b.code || b.name.slice(0, 4).toUpperCase()), name: b.name.trim(), specimen: b.specimen || 'Blood',
      unit: b.unit || '', refLow: num(b.refLow), refHigh: num(b.refHigh), refText: b.refText || '', price: parseInt(b.price, 10) || 0 };
    db.labCatalog.push(t); logAudit('Lab', 'catalog.add', t.name); store.save(); res.json(view(t));
  });
  app.post('/api/lab/catalog/:id', auth, roleOnly('lab'), (req, res) => {
    const h = hid(req); const t = db.labCatalog.find(x => x.id === req.params.id && x.hospitalId === h); if (!t) return res.status(404).json({ error: 'Test not found' });
    const b = req.body || {}; ['name', 'code', 'specimen', 'unit', 'refText'].forEach(k => { if (b[k] !== undefined) t[k] = b[k]; });
    ['refLow', 'refHigh'].forEach(k => { if (b[k] !== undefined) t[k] = num(b[k]); }); if (b.price !== undefined) t.price = parseInt(b.price, 10) || 0;
    store.save(); res.json(view(t));
  });

  // authoritative flagging used when the lab posts results
  app.locals.labFlag = function (h, testName, value) {
    const nm = (testName || '').toLowerCase();
    const t = db.labCatalog.find(x => x.hospitalId === h && (nm.includes((x.name || '').toLowerCase()) || (x.name || '').toLowerCase().includes(nm)));
    if (!t) return { flag: 'normal' };
    if (t.refLow == null && t.refHigh == null) {
      if (t.refText) { const ok = ('' + value).trim().toLowerCase() === t.refText.trim().toLowerCase(); return { flag: ok ? 'normal' : 'abnormal', refText: t.refText, unit: t.unit }; }
      return { flag: 'normal', unit: t.unit };
    }
    const v = parseFloat(value); if (isNaN(v)) return { flag: 'normal', low: t.refLow, high: t.refHigh, unit: t.unit };
    let flag = 'normal'; if (t.refLow != null && v < t.refLow) flag = 'low'; else if (t.refHigh != null && v > t.refHigh) flag = 'high';
    return { flag: flag, low: t.refLow, high: t.refHigh, unit: t.unit };
  };
  app.locals.labCatalogFor = function (h) { return db.labCatalog.filter(t => t.hospitalId === h).map(view); };
};

module.exports.seed = function (db, uid) {
  uid = uid || (p => p + '_' + Math.random().toString(36).slice(2, 9));
  db.labCatalog = [];
  // name, specimen, unit, refLow, refHigh, refText, price
  const TESTS = [
    ['Haemoglobin', 'Blood', 'g/dL', 11, 16, '', 2500],
    ['White cell count', 'Blood', '10^9/L', 4, 11, '', 3000],
    ['Platelets', 'Blood', '10^9/L', 150, 400, '', 3000],
    ['Fasting blood glucose', 'Blood', 'mmol/L', 3.9, 5.5, '', 2000],
    ['Creatinine', 'Blood', 'umol/L', 60, 110, '', 3500],
    ['ALT (liver)', 'Blood', 'U/L', 7, 56, '', 3500],
    ['Total cholesterol', 'Blood', 'mmol/L', null, 5.2, '', 4000],
    ['Malaria RDT', 'Blood', '', null, null, 'Negative', 1500],
    ['Widal test', 'Blood', '', null, null, 'Negative', 2000],
    ['Urinalysis (protein)', 'Urine', '', null, null, 'Nil', 1800],
  ];
  ['h_grand', 'h_river'].forEach(h => {
    TESTS.forEach((r, i) => db.labCatalog.push({ id: uid('lt'), hospitalId: h, code: r[0].split(' ')[0].slice(0, 4).toUpperCase() + i, name: r[0], specimen: r[1], unit: r[2], refLow: r[3], refHigh: r[4], refText: r[5], price: r[6] }));
  });
};
