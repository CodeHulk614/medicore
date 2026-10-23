'use strict';
/*
 * HMOs that are NOT on the platform (most of them, at first), and the provider's own data export.
 *
 * HMO panel: each provider lists the HMOs it is accredited with: on-platform HMOs (claims flow through the HMO desk
 * automatically) and off-platform HMOs with their contacts (pre-authorisation email / WhatsApp, claims email, portal).
 * For off-platform HMOs the front desk:
 *   1. records the patient's cover (member number, plan, employer),
 *   2. sends a pre-authorisation request (email through the email gateway, and a ready WhatsApp message to the HMO's
 *      number), then records the HMO's answer and authorisation code,
 *   3. puts the HMO's share on the bill (the patient pays the rest),
 *   4. sends claim batches: a CSV per HMO and period, emailed to the HMO's claims address, and records payment.
 *
 * Data export: the provider (data controller) can download all its records at any time.
 */
const express = require('express');
const db = require('../db');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param } = require('../lib/http');
const A = require('../lib/auth');
const RL = require('../lib/ratelimit');
const WA = require('../lib/whatsapp');
const EMAIL = require('../lib/email');
const { id, now, naira } = require('../lib/util');
const { audit } = require('../lib/audit');
const P = require('./patients');
const { nextNumber } = require('./orgs');

db.index('hmo_panel', ['orgId', 'active']);
db.index('external_covers', ['orgId', 'patientId']);
db.index('external_preauths', ['orgId', 'status', 'createdAt']);
db.index('external_claim_batches', ['orgId', 'createdAt']);

const router = express.Router();
const N = k => 'NGN ' + (Math.round(k) / 100).toLocaleString('en-NG');
const panelRules = {
  payerOrgId: t.id(), name: t.str({ max: 120, plain: true }), code: t.str({ max: 20, plain: true }), contactName: t.str({ max: 100, plain: true }),
  phone: t.str({ max: 20 }), whatsapp: t.str({ max: 20 }), email: t.email(), preauthEmail: t.email(), claimsEmail: t.email(),
  portalUrl: t.str({ max: 300, pattern: /^(https:\/\/|$)/, label: 'Portal link (https)' }), notes: t.text({ max: 1000 }), active: t.bool(),
};
function normPanel(b) {
  const out = Object.assign({}, b);
  for (const k of ['phone', 'whatsapp']) if (b[k]) { const n = WA.normIntl(b[k]); if (!n) throw bad('Enter a valid ' + (k === 'phone' ? 'phone' : 'WhatsApp') + ' number'); out[k] = n; }
  return out;
}
const panelView = p => Object.assign({}, p, { onPlatform: !!p.payerOrgId, chatLink: p.whatsapp ? WA.chatLink(p.whatsapp) : null });

/* ---------------- panel (admin) ---------------- */
const panelAdmin = A.requireStaff({ anyPerm: ['admin.settings', 'admin.finance'] });
router.get('/admin/hmos', panelAdmin, ah(async (req, res) => {
  const rows = await db.col('hmo_panel').find({ orgId: req.ctx.org.id }, { sort: { name: 1 } });
  const platform = await db.col('orgs').find({ type: 'hmo', status: 'active' }, { sort: { name: 1 } });
  res.json({ panel: rows.map(panelView), platformHmos: platform.map(o => ({ id: o.id, name: o.name, code: o.code })), emailReady: EMAIL.configured() });
}));
router.post('/admin/hmos', panelAdmin, ah(async (req, res) => {
  const b = normPanel(body(req, panelRules));
  let name = b.name;
  if (b.payerOrgId) { const h = await db.col('orgs').findOne({ id: b.payerOrgId, type: 'hmo', status: 'active' }); if (!h) throw notFound('HMO not found'); name = h.name; if (await db.col('hmo_panel').findOne({ orgId: req.ctx.org.id, payerOrgId: h.id })) throw conflict('That HMO is already on your panel'); }
  if (!name) throw bad('Give the HMO\'s name');
  const p = Object.assign({ id: id('hp'), orgId: req.ctx.org.id, active: true, createdAt: now(), createdBy: req.ctx.user.id }, b, { name });
  await db.col('hmo_panel').insertOne(p);
  await audit(req, 'hmo_panel.add', { type: 'hmo_panel', id: p.id }, { onPlatform: !!p.payerOrgId });
  res.json(panelView(p));
}));
router.patch('/admin/hmos/:id', panelAdmin, ah(async (req, res) => {
  const { payerOrgId: _ignore, ...editRules } = panelRules;
  const b = normPanel(body(req, editRules));
  // an empty string clears an email or link field
  for (const k of ['email', 'preauthEmail', 'claimsEmail', 'whatsapp', 'phone', 'portalUrl']) if (req.body && req.body[k] === '') b[k] = '';
  const p = await db.col('hmo_panel').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id }, { $set: b });
  if (!p) throw notFound('HMO not found');
  await audit(req, 'hmo_panel.update', { type: 'hmo_panel', id: p.id }, { fields: Object.keys(b) });
  res.json(panelView(p));
}));

/* ---------------- covers (front desk) ---------------- */
const fdHmo = A.requireStaff({ anyPerm: ['hmo.check', 'hmo.claim'] });
async function panelOf(req, pid) { const p = await db.col('hmo_panel').findOne({ id: pid, orgId: req.ctx.org.id, active: { $ne: false } }); if (!p) throw notFound('HMO not on your panel'); return p; }
router.get('/fd/hmos', fdHmo, ah(async (req, res) => {
  res.json((await db.col('hmo_panel').find({ orgId: req.ctx.org.id, active: { $ne: false } }, { sort: { name: 1 } })).map(panelView));
}));
router.get('/fd/patients/:id/external-covers', fdHmo, ah(async (req, res) => {
  const { patient } = await P.requireLinked(req, param(req, 'id'));
  const rows = await db.col('external_covers').find({ orgId: req.ctx.org.id, patientId: patient.id }, { sort: { createdAt: -1 } });
  const names = {}; for (const r of rows) if (!names[r.panelId]) { const p = await db.col('hmo_panel').findOne({ id: r.panelId }); names[r.panelId] = p ? p.name : null; }
  res.json(rows.map(r => Object.assign({ hmoName: names[r.panelId] }, r)));
}));
router.post('/fd/patients/:id/external-covers', A.requireStaff({ perm: 'hmo.check' }), ah(async (req, res) => {
  const { patient } = await P.requireLinked(req, param(req, 'id'));
  const b = body(req, { panelId: t.id({ required: true }), memberNo: t.str({ required: true, max: 40, upper: true, pattern: /^[A-Za-z0-9\-/. ]+$/, label: 'Member number' }), planName: t.str({ max: 80, plain: true }), employer: t.str({ max: 120, plain: true }), validTo: t.date() });
  const p = await panelOf(req, b.panelId);
  if (p.payerOrgId) throw bad(p.name + ' is on MediCore. Check the patient\'s cover with HMO check instead.');
  const c = Object.assign({ id: id('xc'), orgId: req.ctx.org.id, patientId: patient.id, status: 'active', createdAt: now(), by: req.ctx.user.id }, b);
  await db.col('external_covers').insertOne(c);
  await audit(req, 'external_cover.add', { type: 'external_cover', id: c.id, patientId: patient.id }, { panelId: p.id });
  res.json(Object.assign({ hmoName: p.name }, c));
}));
router.patch('/fd/external-covers/:id', A.requireStaff({ perm: 'hmo.check' }), ah(async (req, res) => {
  const b = body(req, { status: t.enum(['active', 'ended']), planName: t.str({ max: 80, plain: true }), validTo: t.date() });
  const c = await db.col('external_covers').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id }, { $set: b });
  if (!c) throw notFound('Cover not found');
  await audit(req, 'external_cover.update', { type: 'external_cover', id: c.id, patientId: c.patientId }, b);
  res.json(c);
}));

/* ---------------- pre-authorisation requests ---------------- */
function preauthText(org, p, patient, cover, pa) {
  return [
    'Pre-authorisation request ' + pa.number + ' from ' + org.name,
    'HMO: ' + p.name,
    'Enrollee: ' + patient.firstName + ' ' + patient.lastName + (patient.dob ? ', born ' + patient.dob : '') + (patient.sex ? ', ' + patient.sex : ''),
    'Member number: ' + (cover ? cover.memberNo : 'not given') + (cover && cover.planName ? ' (' + cover.planName + ')' : '') + (cover && cover.employer ? ', ' + cover.employer : ''),
    'Diagnosis: ' + pa.diagnosis,
    'Services requested:', ...pa.items.map(i => '- ' + i.name + ': ' + N(i.amountKobo)),
    'Total: ' + N(pa.totalKobo),
    pa.note ? 'Note: ' + pa.note : null,
    'Please reply with the authorisation code. Contact: ' + ((org.contact || {}).phone || '') + ' ' + ((org.contact || {}).email || ''),
  ].filter(Boolean).join('\n');
}
router.post('/fd/external-preauths', A.requireStaff({ perm: 'hmo.check' }), ah(async (req, res) => {
  const b = body(req, {
    patientId: t.id({ required: true }), panelId: t.id({ required: true }), coverId: t.id(), diagnosis: t.str({ required: true, min: 3, max: 300, label: 'Diagnosis' }), note: t.text({ max: 1000 }),
    items: t.arr(t.obj({ serviceCode: t.str({ max: 24, upper: true }), name: t.str({ max: 120, plain: true }), amountKobo: t.money({ max: naira(50000000) }), qty: t.int({ min: 1, max: 100, default: 1 }) }), { required: true, min: 1, max: 30 }),
    sendEmail: t.bool({ default: true }),
  });
  const { patient } = await P.requireLinked(req, b.patientId);
  const p = await panelOf(req, b.panelId);
  const cover = b.coverId ? await db.col('external_covers').findOne({ id: b.coverId, orgId: req.ctx.org.id, patientId: patient.id }) : await db.col('external_covers').findOne({ orgId: req.ctx.org.id, patientId: patient.id, panelId: p.id, status: 'active' });
  const items = [];
  for (const it of b.items) {
    if (it.serviceCode) { const s = await require('./orgs').service(req.ctx.org.id, it.serviceCode); if (!s) throw bad('Unknown service code ' + it.serviceCode); items.push({ code: s.code, name: s.name, qty: it.qty || 1, amountKobo: s.priceKobo * (it.qty || 1) }); }
    else { if (!it.name || it.amountKobo == null) throw bad('Each item needs a service code, or a name and an amount'); items.push({ code: null, name: it.name, qty: it.qty || 1, amountKobo: it.amountKobo * (it.qty || 1) }); }
  }
  const n = await nextNumber('xpa_' + req.ctx.org.id);
  const pa = { id: id('xpa'), number: 'EPA' + String(n).padStart(5, '0'), orgId: req.ctx.org.id, patientId: patient.id, panelId: p.id, hmoName: p.name, coverId: cover ? cover.id : null, memberNo: cover ? cover.memberNo : null, items, totalKobo: items.reduce((s, i) => s + i.amountKobo, 0), diagnosis: b.diagnosis, note: b.note || null, status: 'requested', sentVia: [], createdAt: now(), by: req.ctx.user.id, byName: req.ctx.user.name };
  pa.message = preauthText(req.ctx.org, p, patient, cover, pa);
  let emailSent = false;
  if (b.sendEmail !== false && (p.preauthEmail || p.email) && EMAIL.configured()) { const r = await EMAIL.send({ to: p.preauthEmail || p.email, subject: 'Pre-authorisation request ' + pa.number + ' - ' + req.ctx.org.name, text: pa.message, replyTo: (req.ctx.org.contact || {}).email }); emailSent = r.sent; if (r.sent) pa.sentVia.push('email'); }
  await db.col('external_preauths').insertOne(pa);
  await audit(req, 'external_preauth.request', { type: 'external_preauth', id: pa.id, patientId: patient.id }, { panelId: p.id, totalKobo: pa.totalKobo, emailSent });
  res.json(Object.assign({}, pa, { emailSent, whatsappLink: p.whatsapp ? WA.chatLink(p.whatsapp, pa.message) : null, portalUrl: p.portalUrl || null, patientName: patient.firstName + ' ' + patient.lastName }));
}));
router.get('/fd/external-preauths', fdHmo, ah(async (req, res) => {
  const q = query(req, { status: t.enum(['requested', 'approved', 'denied', 'cancelled']), panelId: t.id(), patientId: t.id(), limit: t.int({ min: 1, max: 300 }) });
  const f = { orgId: req.ctx.org.id }; if (q.status) f.status = q.status; if (q.panelId) f.panelId = q.panelId; if (q.patientId) f.patientId = q.patientId;
  const rows = await db.col('external_preauths').find(f, { sort: { createdAt: -1 }, limit: q.limit || 100 });
  const out = []; for (const r of rows) out.push(Object.assign({ patientName: await P.patientName(r.patientId) }, r));
  res.json(out);
}));
router.post('/fd/external-preauths/:id/decide', A.requireStaff({ perm: 'hmo.check' }), ah(async (req, res) => {
  const b = body(req, { status: t.enum(['approved', 'denied', 'cancelled'], { required: true }), authCode: t.str({ max: 60, plain: true, label: 'Authorisation code' }), approvedKobo: t.money({ max: naira(50000000) }), reason: t.str({ max: 300 }) });
  if (b.status === 'approved' && !b.authCode) throw bad('Enter the authorisation code the HMO gave you');
  if (b.status === 'denied' && !b.reason) throw bad('Enter the reason the HMO gave');
  const pa = await db.col('external_preauths').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id, status: 'requested' }, { $set: { status: b.status, authCode: b.authCode || null, approvedKobo: b.status === 'approved' ? (b.approvedKobo != null ? b.approvedKobo : undefined) : null, reason: b.reason || null, decidedAt: now(), decidedBy: req.ctx.user.id } });
  if (!pa) throw conflict('This request has already been decided');
  if (b.status === 'approved' && b.approvedKobo == null) await db.col('external_preauths').updateOne({ id: pa.id }, { $set: { approvedKobo: pa.totalKobo } });
  await audit(req, 'external_preauth.' + b.status, { type: 'external_preauth', id: pa.id, patientId: pa.patientId }, { authCode: b.authCode || null });
  res.json(await db.col('external_preauths').findOne({ id: pa.id }));
}));

/* ---------------- bill: the HMO's share ---------------- */
router.post('/bills/:id/external-hmo', A.requireStaff({ anyPerm: ['hmo.check', 'billing.create'] }), ah(async (req, res) => {
  const b = body(req, { panelId: t.id({ required: true }), coverId: t.id(), preauthId: t.id(), coveredKobo: t.money({ required: true }), authCode: t.str({ max: 60, plain: true }) });
  const bill = await db.col('bills').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!bill) throw notFound('Bill not found');
  if (bill.status !== 'open' || bill.paidKobo > 0 || bill.hmo || bill.hmoExternal) throw conflict('HMO cover can only be added once, to an unpaid open bill');
  if (b.coveredKobo > bill.totalKobo) throw bad('The HMO\'s share cannot be more than the bill');
  const p = await panelOf(req, b.panelId);
  const pa = b.preauthId ? await db.col('external_preauths').findOne({ id: b.preauthId, orgId: req.ctx.org.id, patientId: bill.patientId, status: 'approved' }) : null;
  if (b.preauthId && !pa) throw bad('That pre-authorisation is not approved for this patient');
  const cover = b.coverId ? await db.col('external_covers').findOne({ id: b.coverId, orgId: req.ctx.org.id, patientId: bill.patientId }) : await db.col('external_covers').findOne({ orgId: req.ctx.org.id, patientId: bill.patientId, panelId: p.id, status: 'active' });
  const ext = { panelId: p.id, hmoName: p.name, coverId: cover ? cover.id : null, memberNo: cover ? cover.memberNo : null, preauthId: pa ? pa.id : null, authCode: b.authCode || (pa ? pa.authCode : null), coveredKobo: b.coveredKobo, claimStatus: 'not_submitted', batchId: null, at: now(), by: req.ctx.user.id };
  const upd = await db.col('bills').findOneAndUpdate({ id: bill.id, status: 'open', paidKobo: 0 }, { $set: { hmoExternal: ext, patientDueKobo: bill.totalKobo - b.coveredKobo } });
  if (!upd) throw conflict('The bill changed. Refresh and try again.');
  let out = upd;
  if (upd.patientDueKobo === 0) { const billing = require('./billing'); const s = await db.col('bills').findOneAndUpdate({ id: bill.id, status: 'open' }, { $set: { status: 'paid', paidAt: now(), settledBy: 'hmo_external' } }); if (s) { out = s; try { await billing.fireSettledExternal(s); } catch (e) { /* hooks are best effort here */ } } }
  await audit(req, 'bill.external_hmo', { type: 'bill', id: bill.id, patientId: bill.patientId }, { panelId: p.id, coveredKobo: b.coveredKobo });
  res.json(out);
}));

/* ---------------- claims to off-platform HMOs ---------------- */
const claimG = A.requireStaff({ perm: 'hmo.claim' });
const dayStart = d => Date.parse(d + 'T00:00:00+01:00'); const dayEnd = d => Date.parse(d + 'T23:59:59+01:00');
async function claimableBills(req, panelId, from, to, billIds) {
  const f = { orgId: req.ctx.org.id, 'hmoExternal.panelId': panelId, 'hmoExternal.claimStatus': 'not_submitted', status: { $ne: 'void' } };
  if (from || to) f.createdAt = Object.assign({}, from ? { $gte: dayStart(from) } : {}, to ? { $lte: dayEnd(to) } : {});
  if (billIds) f.id = { $in: billIds };
  return db.col('bills').find(f, { sort: { createdAt: 1 }, limit: 2000 });
}
const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
async function claimsCsv(rows) {
  const head = ['Date', 'Bill number', 'Patient', 'Date of birth', 'Member number', 'Authorisation code', 'Services', 'Bill total (NGN)', 'HMO share (NGN)', 'Patient paid (NGN)'];
  const lines = [head.join(',')];
  for (const b of rows) {
    const p = await db.col('patients').findOne({ id: b.patientId }, { projection: { firstName: 1, lastName: 1, dob: 1 } });
    lines.push([new Date(b.createdAt + 3600e3).toISOString().slice(0, 10), b.number, p ? p.firstName + ' ' + p.lastName : '', p ? p.dob || '' : '', b.hmoExternal.memberNo || '', b.hmoExternal.authCode || '', (b.lines || []).map(l => l.name + ' x' + l.qty).join('; '), (b.totalKobo / 100).toFixed(2), (b.hmoExternal.coveredKobo / 100).toFixed(2), ((b.totalKobo - b.hmoExternal.coveredKobo) / 100).toFixed(2)].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}
router.get('/fd/external-claims', claimG, ah(async (req, res) => {
  const q = query(req, { panelId: t.id({ required: true }), from: t.date(), to: t.date() });
  const p = await panelOf(req, q.panelId);
  const rows = await claimableBills(req, p.id, q.from, q.to);
  const out = []; for (const b of rows) out.push({ id: b.id, number: b.number, createdAt: b.createdAt, patientName: await P.patientName(b.patientId), memberNo: b.hmoExternal.memberNo, authCode: b.hmoExternal.authCode, totalKobo: b.totalKobo, coveredKobo: b.hmoExternal.coveredKobo });
  res.json({ hmo: panelView(p), bills: out, totalCoveredKobo: out.reduce((s, b) => s + b.coveredKobo, 0), emailReady: EMAIL.configured() && !!(p.claimsEmail || p.email) });
}));
router.get('/fd/external-claims/export', claimG, ah(async (req, res) => {
  const q = query(req, { panelId: t.id({ required: true }), from: t.date(), to: t.date(), batchId: t.id() });
  const p = await panelOf(req, q.panelId);
  let rows;
  if (q.batchId) { const bt = await db.col('external_claim_batches').findOne({ id: q.batchId, orgId: req.ctx.org.id }); if (!bt) throw notFound('Batch not found'); rows = await db.col('bills').find({ id: { $in: bt.billIds }, orgId: req.ctx.org.id }); }
  else rows = await claimableBills(req, p.id, q.from, q.to);
  await audit(req, 'external_claims.export', { type: 'hmo_panel', id: p.id }, { bills: rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="claims-' + (p.code || p.name).replace(/[^A-Za-z0-9]+/g, '-') + '.csv"');
  res.send(await claimsCsv(rows));
}));
router.post('/fd/external-claims/batches', claimG, ah(async (req, res) => {
  const b = body(req, { panelId: t.id({ required: true }), billIds: t.arr(t.id(), { required: true, min: 1, max: 2000 }), sendEmail: t.bool({ default: true }), note: t.str({ max: 300 }) });
  const p = await panelOf(req, b.panelId);
  const rows = await claimableBills(req, p.id, null, null, b.billIds);
  if (rows.length !== b.billIds.length) throw conflict('Some bills are already claimed or are not for this HMO. Refresh the list.');
  const n = await nextNumber('xcb_' + req.ctx.org.id);
  const bt = { id: id('xcb'), number: 'CB' + String(n).padStart(5, '0'), orgId: req.ctx.org.id, panelId: p.id, hmoName: p.name, billIds: rows.map(x => x.id), count: rows.length, totalCoveredKobo: rows.reduce((s, x) => s + x.hmoExternal.coveredKobo, 0), status: 'submitted', sentVia: [], note: b.note || null, createdAt: now(), by: req.ctx.user.id, byName: req.ctx.user.name, paidKobo: 0 };
  // claim each bill exactly once
  for (const x of rows) { const u = await db.col('bills').findOneAndUpdate({ id: x.id, 'hmoExternal.claimStatus': 'not_submitted' }, { $set: { 'hmoExternal.claimStatus': 'submitted', 'hmoExternal.batchId': bt.id } }); if (!u) throw conflict('Bill ' + x.number + ' was claimed by someone else just now. Refresh.'); }
  const csv = await claimsCsv(rows);
  let emailSent = false;
  if (b.sendEmail !== false && (p.claimsEmail || p.email) && EMAIL.configured()) { const r = await EMAIL.send({ to: p.claimsEmail || p.email, subject: 'Claims ' + bt.number + ' from ' + req.ctx.org.name + ': ' + bt.count + ' bills, ' + N(bt.totalCoveredKobo), text: 'Please find attached claim batch ' + bt.number + ' from ' + req.ctx.org.name + ' (' + bt.count + ' bills, total ' + N(bt.totalCoveredKobo) + ').' + (bt.note ? '\n\n' + bt.note : ''), attachments: [{ filename: 'claims-' + bt.number + '.csv', content: csv, type: 'text/csv' }], replyTo: (req.ctx.org.contact || {}).email }); emailSent = r.sent; if (r.sent) bt.sentVia.push('email'); }
  await db.col('external_claim_batches').insertOne(bt);
  await audit(req, 'external_claims.batch', { type: 'external_claim_batch', id: bt.id }, { panelId: p.id, count: bt.count, totalKobo: bt.totalCoveredKobo, emailSent });
  res.json(Object.assign({}, bt, { emailSent, whatsappLink: p.whatsapp ? WA.chatLink(p.whatsapp, 'Claim batch ' + bt.number + ' from ' + req.ctx.org.name + ': ' + bt.count + ' bills, total ' + N(bt.totalCoveredKobo) + '. Sent to your claims email.') : null, portalUrl: p.portalUrl || null }));
}));
router.get('/fd/external-claims/batches', claimG, ah(async (req, res) => {
  const q = query(req, { panelId: t.id() });
  const f = { orgId: req.ctx.org.id }; if (q.panelId) f.panelId = q.panelId;
  res.json(await db.col('external_claim_batches').find(f, { sort: { createdAt: -1 }, limit: 200 }));
}));
router.post('/fd/external-claims/batches/:id/payment', claimG, ah(async (req, res) => {
  const b = body(req, { paidKobo: t.money({ required: true, min: 1 }), reference: t.str({ required: true, max: 80, label: 'Payment reference' }), rejectedBillIds: t.arr(t.id(), { max: 2000 }) });
  const bt = await db.col('external_claim_batches').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!bt) throw notFound('Batch not found');
  if (bt.status === 'paid') throw conflict('This batch is already marked paid');
  const paid = (bt.paidKobo || 0) + b.paidKobo;
  const status = paid >= bt.totalCoveredKobo ? 'paid' : 'part_paid';
  await db.col('external_claim_batches').updateOne({ id: bt.id }, { $set: { paidKobo: paid, status, lastPaymentRef: b.reference, lastPaymentAt: now() }, $push: { payments: { amountKobo: b.paidKobo, reference: b.reference, at: now(), by: req.ctx.user.id } } });
  for (const bid of bt.billIds) await db.col('bills').updateOne({ id: bid, orgId: req.ctx.org.id }, { $set: { 'hmoExternal.claimStatus': (b.rejectedBillIds || []).includes(bid) ? 'rejected' : (status === 'paid' ? 'paid' : 'submitted') } });
  await audit(req, 'external_claims.payment', { type: 'external_claim_batch', id: bt.id }, { paidKobo: b.paidKobo, status });
  res.json(await db.col('external_claim_batches').findOne({ id: bt.id }));
}));

/* ---------------- the provider's own data export ---------------- */
async function exportOrg(orgId) {
  const org = await db.col('orgs').findOne({ id: orgId });
  const links = await db.col('patient_links').find({ orgId });
  const pids = links.map(l => l.patientId);
  const patients = pids.length ? await db.col('patients').find({ id: { $in: pids } }) : [];
  const byP = Object.fromEntries(links.map(l => [l.patientId, l]));
  const members = await db.col('memberships').find({ orgId });
  const users = members.length ? await db.col('users').find({ id: { $in: members.map(m => m.userId) } }, { projection: { name: 1, email: 1, phone: 1 } }) : [];
  const strip = rows => rows.map(r => { const o = Object.assign({}, r); delete o._id; delete o.codeHash; delete o.pickupCodeHash; delete o.deliveryCodeHash; return o; });
  const out = {
    format: 'MediCore provider export v1', exportedAt: new Date().toISOString(),
    provider: { id: org.id, name: org.name, type: org.type, code: org.code, modules: org.modules, contact: org.contact, location: org.location, groupId: org.groupId || null },
    staff: members.map(m => { const u = users.find(x => x.id === m.userId) || {}; return { name: u.name, email: u.email || null, phone: u.phone || null, role: m.role, status: m.status, since: m.createdAt }; }),
    patients: patients.map(p => P.staffView(p, byP[p.id])),
  };
  for (const [name, f] of Object.entries({ appointments: { orgId }, encounters: { orgId }, prescriptions: { orgId }, vitals: { orgId }, bills: { orgId }, payments: { orgId }, rx_orders: { pharmacyOrgId: orgId }, deliveries: { orgId }, lab_orders: { $or: [{ labOrgId: orgId }, { referringOrgId: orgId }] }, incidents: { orgId }, referrals: { $or: [{ fromOrgId: orgId }, { toOrgId: orgId }] }, services: { orgId }, external_covers: { orgId }, external_preauths: { orgId }, external_claim_batches: { orgId }, hmo_panel: { orgId } })) out[name] = strip(await db.col(name).find(f, { limit: 100000 }));
  return out;
}
router.get('/admin/export', A.requireStaff({ anyPerm: ['admin.privacy', 'admin.settings'] }), ah(async (req, res) => {
  if (!req.ctx.membership.isOwner && !A.has(req, 'admin.privacy')) throw forbidden('Only the owner or the data protection lead can export all records');
  await RL.limit('orgexport_' + req.ctx.org.id, 5, 86400);
  const data = await exportOrg(req.ctx.org.id);
  await audit(req, 'org.export', { type: 'org', id: req.ctx.org.id }, { patients: data.patients.length });
  res.setHeader('Content-Disposition', 'attachment; filename="' + (req.ctx.org.code || 'provider') + '-export.json"');
  res.json(data);
}));
router.get('/group/export', A.requireGroup(), ah(async (req, res) => {
  if (!req.ctx.groupMember.isOwner) throw forbidden('Only the group owner can export all records');
  const q = query(req, { branchId: t.id() });
  const branches = await db.col('orgs').find(Object.assign({ groupId: req.ctx.group.id }, q.branchId ? { id: q.branchId } : {}));
  if (!branches.length) throw notFound('Branch not found');
  await RL.limit('grpexport_' + req.ctx.group.id, 5, 86400);
  const out = { format: 'MediCore group export v1', exportedAt: new Date().toISOString(), group: { id: req.ctx.group.id, name: req.ctx.group.name, code: req.ctx.group.code }, branches: [] };
  for (const o of branches) out.branches.push(await exportOrg(o.id));
  await audit(req, 'group.export', { type: 'group', id: req.ctx.group.id, orgId: null }, { branches: branches.length });
  res.setHeader('Content-Disposition', 'attachment; filename="' + req.ctx.group.code + '-export.json"');
  res.json(out);
}));

module.exports = { name: 'hmopanel', router, exportOrg };
