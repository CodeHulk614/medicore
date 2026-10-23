'use strict';
/*
 * HMOs running their business on MediCore (the HMO desk), paired with their members (patient app) and the providers
 * that treat them. When the HMO, the member and the provider are all on the platform, cover checks, approvals and
 * claims need no API integration and no phone calls.
 *
 *  Plans         benefit packages: individual, family or corporate; monthly and yearly premiums; limits per category;
 *                benefits and exclusions in plain words; "sell online" puts a plan in the patient app.
 *  Online sales  a patient buys a plan in the app and pays the premium through the payment gateway (it settles to the
 *                HMO's account). The cover activates on payment (or waits for the HMO, per plan) with a member number
 *                and a digital member card.
 *  Network       the HMO invites providers on the platform into its network (primary care or referral level, with a
 *                capitation rate for primary care); the provider accepts in its admin app and the HMO joins its panel.
 *                Members see the network on the marketplace map free of charge.
 *  Primary care  each member chooses a primary provider from the network; changes are limited (HQ: months between changes).
 *  Capitation    monthly statement per primary provider: enrollees x rate. The HMO records each payment once per month.
 *  Dependants    spouse and children under a principal's cover, with their own member numbers and cards.
 *  Employers     corporate clients whose staff are enrolled together.
 *  Member card   a card code the member shows at any network provider. The desk verifies it and can register the member.
 *  Requests      members message their HMO (change provider, add dependant, complaint, question) and get answers in the app.
 */
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param } = require('../lib/http');
const A = require('../lib/auth');
const S = require('../lib/settings');
const RL = require('../lib/ratelimit');
const { id, now, naira, todayLagos, addDays, haversineKm } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const orgs = require('./orgs');
const P = require('./patients');
const PAYER = require('./payer');
const billing = require('./billing');

db.index('hmo_plans', ['payerOrgId', 'active']);
db.index('hmo_network', ['payerOrgId', 'status']);
db.index('hmo_network', ['orgId', 'status']);
db.index('hmo_employers', ['payerOrgId']);
db.index('hmo_requests', ['payerOrgId', 'status', 'lastAt']);
db.index('hmo_requests', ['patientId', 'lastAt']);
db.index('capitation_payments', ['payerOrgId', 'month']);
db.index('capitation_payments', ['orgId', 'month']);
db.index('coverages', ['cardCode'], { unique: true, sparse: true });
db.index('coverages', ['principalCoverageId']);
db.index('coverages', ['primaryOrgId', 'status']);

const router = express.Router();
const CATS = PAYER.CATS;
const KINDS = ['individual', 'family', 'corporate'];
const RELATIONS = ['self', 'spouse', 'child', 'parent', 'other'];
const REQ_TYPES = ['change_provider', 'add_dependant', 'complaint', 'question', 'card', 'refund', 'other'];
const LEVELS = ['primary', 'secondary', 'tertiary', 'specialist', 'diagnostic', 'pharmacy'];
const CARD_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const cardCode = () => Array.from(crypto.randomBytes(8)).map(b => CARD_ALPHA[b % CARD_ALPHA.length]).join('');
const limitsRule = o => t.obj(Object.fromEntries(CATS.map(c => [c, t.money({ max: naira(100000000) })])), o);
const fullLimits = l => Object.fromEntries(CATS.map(c => [c, Number((l || {})[c]) || 0]));
const zeroUsed = () => Object.fromEntries(CATS.map(c => [c, 0]));
const monthKey = ts => new Date((ts || now()) + 3600e3).toISOString().slice(0, 7);

const payerOnly = (req, res, next) => (req.ctx.org.type === 'hmo' ? next() : next(forbidden('Only HMOs use the HMO desk')));
const payer = perm => [A.requireStaff({ perm, module: 'payer' }), payerOnly];
const payerAny = perms => [A.requireStaff({ anyPerm: perms, module: 'payer' }), payerOnly];
const anyPayer = payerAny(['payer.members', 'payer.preauth', 'payer.claims', 'payer.plans', 'payer.network', 'payer.care', 'admin.reports']);
const netOn = (req, res, next) => (S.feature('hmoNetwork') ? next() : next(forbidden('HMO networks are switched off on MediCore')));

/* ---------------- helpers used by other modules ---------------- */
/** active coverages of a patient, including dependants' covers they hold as principal */
async function activeCoversOf(patientId) {
  const rows = await db.col('coverages').find({ patientId, status: 'active' });
  return rows.filter(PAYER.isActive);
}
/** provider org ids in the active networks of the HMOs that cover this patient (marketplace access for HMO members) */
async function networkOrgIdsForPatient(patientId) {
  if (!S.feature('hmoNetwork')) return [];
  const covs = await activeCoversOf(patientId);
  if (!covs.length) return [];
  const nets = await db.col('hmo_network').find({ payerOrgId: { $in: [...new Set(covs.map(c => c.payerOrgId))] }, status: 'active' });
  return [...new Set(nets.map(n => n.orgId))];
}
/** HMOs on the platform whose network this provider is in, and HMOs on its panel */
async function hmosAccepted(orgId) {
  const nets = await db.col('hmo_network').find({ orgId, status: 'active' });
  const panel = await db.col('hmo_panel').find({ orgId, active: { $ne: false } });
  const out = {}; for (const n of nets) out[n.payerOrgId] = { payerOrgId: n.payerOrgId, network: true, level: n.level || null, primaryCare: !!n.primaryCare };
  for (const p of panel) { const k = p.payerOrgId || p.id; if (!out[k]) out[k] = { payerOrgId: p.payerOrgId || null, name: p.name, network: false }; }
  const ids = Object.values(out).filter(x => x.payerOrgId).map(x => x.payerOrgId);
  if (ids.length) (await db.col('orgs').find({ id: { $in: ids } }, { projection: { name: 1 } })).forEach(o => { Object.values(out).forEach(x => { if (x.payerOrgId === o.id) x.name = o.name; }); });
  return Object.values(out).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
async function nextMemberNo(hmo) {
  const n = await orgs.nextNumber('member_' + hmo.id);
  return (hmo.code || 'HMO').slice(0, 5) + '/' + String(n).padStart(6, '0');
}
async function newCardCode() { for (let i = 0; i < 6; i++) { const c = cardCode(); if (!(await db.col('coverages').findOne({ cardCode: c }))) return c; } return cardCode() + cardCode().slice(0, 2); }
async function inNetwork(payerOrgId, orgId, primaryOnly) {
  const f = { payerOrgId, orgId, status: 'active' }; if (primaryOnly) f.primaryCare = true;
  return db.col('hmo_network').findOne(f);
}

/* ---------------- views ---------------- */
function planView(p) {
  return { id: p.id, payerOrgId: p.payerOrgId, name: p.name, code: p.code || null, kind: p.kind, premiumMonthlyKobo: p.premiumMonthlyKobo, premiumAnnualKobo: p.premiumAnnualKobo, maxDependants: p.maxDependants || 0,
    limits: p.limits, benefits: p.benefits || '', exclusions: p.exclusions || '', waitingDays: p.waitingDays || 0, sellOnline: !!p.sellOnline, activateOnPayment: p.activateOnPayment !== false, active: p.active !== false, updatedAt: p.updatedAt || p.createdAt };
}
async function cardView(c, names) {
  const hmo = await orgs.getOrg(c.payerOrgId);
  const prim = c.primaryOrgId ? await orgs.getOrg(c.primaryOrgId) : null;
  const pat = c.patientId ? await db.col('patients').findOne({ id: c.patientId }, { projection: { firstName: 1, lastName: 1, dob: 1, sex: 1 } }) : null;
  return { id: c.id, memberNo: c.memberNo, cardCode: c.cardCode || null, name: pat ? pat.firstName + ' ' + pat.lastName : (c.enrolName || null), dob: pat ? pat.dob || null : null, relation: c.relation || 'self',
    planName: c.planName || null, planId: c.planId || null, status: c.status, validTo: c.validTo || null, payerOrgId: c.payerOrgId, hmoName: hmo ? hmo.name : null,
    hmoPhone: hmo ? (hmo.contact || {}).phone || null : null, hmoEmail: hmo ? (hmo.contact || {}).email || null : null, hmoWhatsapp: hmo ? (hmo.contact || {}).whatsapp || null : null,
    primaryOrgId: c.primaryOrgId || null, primaryOrgName: prim ? prim.name : null, primaryChangedAt: c.primaryChangedAt || null, paymentDue: c.paymentStatus === 'due', billId: c.paymentStatus === 'due' ? c.billId || null : null,
    principalCoverageId: c.principalCoverageId || null, employerName: names && c.employerId ? names[c.employerId] || null : null, limits: c.limits || null, usedKobo: c.usedKobo || null, remainingKobo: c.limits ? PAYER.remainingOf(c) : null };
}

/* ================= HMO desk: plans ================= */
const planRules = {
  name: t.str({ required: true, max: 80, plain: true, label: 'Plan name' }), code: t.str({ max: 20, plain: true }), kind: t.enum(KINDS, { required: true }),
  premiumMonthlyKobo: t.money({ max: naira(10000000), label: 'Monthly premium' }), premiumAnnualKobo: t.money({ max: naira(100000000), label: 'Yearly premium' }), maxDependants: t.int({ min: 0, max: 12 }),
  limits: limitsRule({ required: true }), benefits: t.text({ max: 3000 }), exclusions: t.text({ max: 3000 }), waitingDays: t.int({ min: 0, max: 365 }), sellOnline: t.bool(), activateOnPayment: t.bool(),
};
router.get('/payer/plans', ...anyPayer, ah(async (req, res) => {
  const rows = await db.col('hmo_plans').find({ payerOrgId: req.ctx.org.id }, { sort: { name: 1 } });
  const out = []; for (const p of rows) out.push(Object.assign(planView(p), { members: await db.col('coverages').count({ payerOrgId: req.ctx.org.id, planId: p.id, status: 'active' }) }));
  res.json(out);
}));
router.post('/payer/plans', ...payer('payer.plans'), ah(async (req, res) => {
  const b = body(req, planRules);
  if (b.sellOnline && !b.premiumMonthlyKobo && !b.premiumAnnualKobo) throw bad('A plan sold online needs a monthly or yearly premium');
  const p = Object.assign({ id: id('hpl'), payerOrgId: req.ctx.org.id, active: true, createdAt: now(), createdBy: req.ctx.user.id }, b, { limits: fullLimits(b.limits), sellOnline: !!b.sellOnline, activateOnPayment: b.activateOnPayment !== false });
  await db.col('hmo_plans').insertOne(p);
  await audit(req, 'payer.plan_create', { type: 'hmo_plan', id: p.id }, { sellOnline: p.sellOnline });
  res.json(planView(p));
}));
router.patch('/payer/plans/:id', ...payer('payer.plans'), ah(async (req, res) => {
  const rules = Object.assign({}, planRules, { active: t.bool() }); rules.name = t.str({ max: 80, plain: true }); rules.kind = t.enum(KINDS); rules.limits = limitsRule();
  const b = body(req, rules);
  if (!Object.keys(b).length) throw bad('Nothing to change');
  if (b.limits) b.limits = fullLimits(b.limits);
  const p = await db.col('hmo_plans').findOneAndUpdate({ id: param(req, 'id'), payerOrgId: req.ctx.org.id }, { $set: Object.assign({ updatedAt: now() }, b) });
  if (!p) throw notFound('Plan not found');
  if (p.sellOnline && !p.premiumMonthlyKobo && !p.premiumAnnualKobo) { await db.col('hmo_plans').updateOne({ id: p.id }, { $set: { sellOnline: false } }); p.sellOnline = false; }
  await audit(req, 'payer.plan_update', { type: 'hmo_plan', id: p.id }, { fields: Object.keys(b) });
  res.json(planView(p));
}));

/* ================= HMO desk: provider network ================= */
async function networkRowView(n, orgCache) {
  const o = orgCache && orgCache[n.orgId] ? orgCache[n.orgId] : await orgs.getOrg(n.orgId);
  const enrollees = n.primaryCare ? await db.col('coverages').count({ payerOrgId: n.payerOrgId, primaryOrgId: n.orgId, status: 'active' }) : 0;
  return { id: n.id, orgId: n.orgId, orgName: o ? o.name : null, orgType: o ? o.type : null, area: o && o.location ? o.location.area || null : null, location: o && o.location ? { lat: o.location.lat, lng: o.location.lng } : null,
    status: n.status, level: n.level || 'primary', primaryCare: !!n.primaryCare, capitationKobo: n.capitationKobo || 0, note: n.note || null, invitedAt: n.invitedAt, acceptedAt: n.acceptedAt || null, enrollees };
}
router.get('/payer/network', ...anyPayer, netOn, ah(async (req, res) => {
  const q = query(req, { status: t.enum(['invited', 'active', 'declined', 'suspended', 'ended']) });
  const f = { payerOrgId: req.ctx.org.id }; if (q.status) f.status = q.status;
  const rows = await db.col('hmo_network').find(f, { sort: { invitedAt: -1 }, limit: 2000 });
  const out = []; for (const n of rows) out.push(await networkRowView(n));
  res.json(out);
}));
/** providers on MediCore an HMO may invite, nearest first */
router.get('/payer/network/candidates', ...payer('payer.network'), netOn, ah(async (req, res) => {
  const q = query(req, { q: t.str({ max: 60 }), type: t.enum(['hospital', 'clinic', 'pharmacy', 'lab', 'ambulance', 'other']), lat: t.lat(), lng: t.lng() });
  const f = { status: 'active', type: q.type ? q.type : { $ne: 'hmo' } };
  let rows = await db.col('orgs').find(f, { limit: 2000 });
  if (q.q) { const s = q.q.toLowerCase(); rows = rows.filter(o => o.name.toLowerCase().includes(s) || ((o.location || {}).area || '').toLowerCase().includes(s)); }
  const mine = await db.col('hmo_network').find({ payerOrgId: req.ctx.org.id, status: { $in: ['invited', 'active', 'suspended'] } });
  const st = Object.fromEntries(mine.map(n => [n.orgId, n.status]));
  const from = q.lat != null ? { lat: q.lat, lng: q.lng } : null;
  const out = rows.map(o => Object.assign(orgs.publicOrg(o, from), { networkStatus: st[o.id] || null }));
  out.sort((a, b) => (from ? (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) : a.name.localeCompare(b.name)));
  res.json(out.slice(0, 200));
}));
router.post('/payer/network', ...payer('payer.network'), netOn, ah(async (req, res) => {
  const b = body(req, { orgId: t.id({ required: true }), level: t.enum(LEVELS, { default: 'primary' }), primaryCare: t.bool(), capitationKobo: t.money({ max: naira(1000000) }), note: t.str({ max: 300, plain: true }) });
  const o = await db.col('orgs').findOne({ id: b.orgId, status: 'active', type: { $ne: 'hmo' } });
  if (!o) throw notFound('Provider not found');
  const cur = await db.col('hmo_network').findOne({ payerOrgId: req.ctx.org.id, orgId: o.id, status: { $in: ['invited', 'active', 'suspended'] } });
  if (cur) throw conflict(cur.status === 'invited' ? 'You already invited this provider' : 'This provider is already in your network');
  const n = { id: id('hnw'), payerOrgId: req.ctx.org.id, orgId: o.id, level: b.level || 'primary', primaryCare: b.primaryCare !== false && (b.level || 'primary') === 'primary', capitationKobo: b.capitationKobo || 0, note: b.note || null, status: 'invited', invitedAt: now(), invitedBy: req.ctx.user.id };
  await db.col('hmo_network').insertOne(n);
  for (const role of ['owner', 'admin']) await notify({ orgId: o.id, role, title: 'HMO network invitation', body: req.ctx.org.name + ' invited you into its provider network. Review it in Admin > HMOs we accept.', kind: 'hmo_network', ref: { type: 'hmo_network', id: n.id } });
  await audit(req, 'payer.network_invite', { type: 'hmo_network', id: n.id }, { orgId: o.id, level: n.level });
  res.json(await networkRowView(n));
}));
router.patch('/payer/network/:id', ...payer('payer.network'), netOn, ah(async (req, res) => {
  const b = body(req, { level: t.enum(LEVELS), primaryCare: t.bool(), capitationKobo: t.money({ max: naira(1000000) }), note: t.str({ max: 300, plain: true }) });
  if (!Object.keys(b).length) throw bad('Nothing to change');
  const n = await db.col('hmo_network').findOneAndUpdate({ id: param(req, 'id'), payerOrgId: req.ctx.org.id, status: { $in: ['invited', 'active', 'suspended'] } }, { $set: Object.assign({ updatedAt: now() }, b) });
  if (!n) throw notFound('Network entry not found');
  await audit(req, 'payer.network_update', { type: 'hmo_network', id: n.id }, { fields: Object.keys(b) });
  res.json(await networkRowView(n));
}));
for (const [action, from, to] of [['suspend', ['active'], 'suspended'], ['reactivate', ['suspended'], 'active'], ['end', ['invited', 'active', 'suspended'], 'ended']]) {
  router.post('/payer/network/:id/' + action, ...payer('payer.network'), netOn, ah(async (req, res) => {
    const b = body(req, { reason: t.str({ max: 300, plain: true }) });
    if (action !== 'reactivate' && !b.reason) throw bad('Give a reason');
    const n = await db.col('hmo_network').findOneAndUpdate({ id: param(req, 'id'), payerOrgId: req.ctx.org.id, status: { $in: from } }, { $set: { status: to, statusReason: b.reason || null, updatedAt: now() } });
    if (!n) throw conflict('That is not possible for this provider now');
    for (const role of ['owner', 'admin']) await notify({ orgId: n.orgId, role, title: 'HMO network ' + (to === 'active' ? 'restored' : to), body: req.ctx.org.name + (b.reason ? ': ' + b.reason : ''), kind: 'hmo_network', ref: { type: 'hmo_network', id: n.id } });
    await audit(req, 'payer.network_' + action, { type: 'hmo_network', id: n.id }, { orgId: n.orgId });
    res.json(await networkRowView(n));
  }));
}

/* provider side: invitations and memberships */
const provAdmin = A.requireStaff({ anyPerm: ['admin.settings', 'admin.finance', 'hmo.claim'] });
router.get('/admin/hmo-network', provAdmin, netOn, ah(async (req, res) => {
  const rows = await db.col('hmo_network').find({ orgId: req.ctx.org.id }, { sort: { invitedAt: -1 } });
  const names = {}; for (const r of rows) if (!(r.payerOrgId in names)) { const h = await orgs.getOrg(r.payerOrgId); names[r.payerOrgId] = h ? h.name : null; }
  const out = [];
  for (const r of rows) out.push({ id: r.id, payerOrgId: r.payerOrgId, hmoName: names[r.payerOrgId], status: r.status, level: r.level || 'primary', primaryCare: !!r.primaryCare, capitationKobo: r.capitationKobo || 0, note: r.note || null, invitedAt: r.invitedAt, acceptedAt: r.acceptedAt || null,
    enrollees: r.primaryCare ? await db.col('coverages').count({ payerOrgId: r.payerOrgId, primaryOrgId: r.orgId, status: 'active' }) : 0 });
  res.json(out);
}));
router.post('/admin/hmo-network/:id/:action', A.requireStaff({ anyPerm: ['admin.settings', 'admin.finance'] }), netOn, ah(async (req, res) => {
  const action = req.params.action;
  if (!['accept', 'decline', 'leave'].includes(action)) throw notFound();
  const b = body(req, { reason: t.str({ max: 300, plain: true }) });
  const from = action === 'leave' ? ['active', 'suspended'] : ['invited'];
  const to = action === 'accept' ? 'active' : action === 'decline' ? 'declined' : 'ended';
  if (action !== 'accept' && !b.reason) throw bad('Give a reason');
  const n = await db.col('hmo_network').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id, status: { $in: from } }, { $set: Object.assign({ status: to, updatedAt: now(), statusReason: b.reason || null }, to === 'active' ? { acceptedAt: now(), acceptedBy: req.ctx.user.id } : {}) });
  if (!n) throw conflict('This invitation is no longer open');
  if (to === 'active' && !(await db.col('hmo_panel').findOne({ orgId: req.ctx.org.id, payerOrgId: n.payerOrgId }))) {
    const h = await orgs.getOrg(n.payerOrgId);
    await db.col('hmo_panel').insertOne({ id: id('hp'), orgId: req.ctx.org.id, payerOrgId: n.payerOrgId, name: h ? h.name : 'HMO', code: h ? h.code : null, active: true, createdAt: now(), createdBy: req.ctx.user.id, via: 'network' });
  }
  for (const role of ['payer_manager', 'payer_officer']) await notify({ orgId: n.payerOrgId, role, title: 'Network ' + (to === 'active' ? 'invitation accepted' : to === 'declined' ? 'invitation declined' : 'provider left'), body: req.ctx.org.name + (b.reason ? ': ' + b.reason : ''), kind: 'hmo_network', ref: { type: 'hmo_network', id: n.id } });
  await audit(req, 'hmo_network.' + action, { type: 'hmo_network', id: n.id }, { payerOrgId: n.payerOrgId });
  res.json({ ok: true, status: n.status });
}));

/* ================= HMO desk: employers (corporate clients) ================= */
const empRules = { name: t.str({ required: true, max: 120, plain: true }), contactName: t.str({ max: 100, plain: true }), phone: t.phone(), email: t.email(), planId: t.id(), note: t.str({ max: 300, plain: true }), active: t.bool() };
router.get('/payer/employers', ...anyPayer, ah(async (req, res) => {
  const rows = await db.col('hmo_employers').find({ payerOrgId: req.ctx.org.id }, { sort: { name: 1 } });
  const out = []; for (const e of rows) out.push(Object.assign({}, e, { members: await db.col('coverages').count({ payerOrgId: req.ctx.org.id, employerId: e.id, status: 'active' }) }));
  res.json(out);
}));
router.post('/payer/employers', ...payer('payer.members'), ah(async (req, res) => {
  const b = body(req, empRules);
  if (b.planId && !(await db.col('hmo_plans').findOne({ id: b.planId, payerOrgId: req.ctx.org.id }))) throw notFound('Plan not found');
  const e = Object.assign({ id: id('hem'), payerOrgId: req.ctx.org.id, active: true, createdAt: now() }, b);
  await db.col('hmo_employers').insertOne(e);
  await audit(req, 'payer.employer_create', { type: 'hmo_employer', id: e.id });
  res.json(e);
}));
router.patch('/payer/employers/:id', ...payer('payer.members'), ah(async (req, res) => {
  const rules = Object.assign({}, empRules); rules.name = t.str({ max: 120, plain: true });
  const b = body(req, rules); if (!Object.keys(b).length) throw bad('Nothing to change');
  const e = await db.col('hmo_employers').findOneAndUpdate({ id: param(req, 'id'), payerOrgId: req.ctx.org.id }, { $set: Object.assign({ updatedAt: now() }, b) });
  if (!e) throw notFound('Employer not found');
  res.json(e);
}));

/* ================= HMO desk: members (plan, primary provider, dependants, card) ================= */
/** assign a plan, primary provider and employer to an existing member */
router.post('/payer/coverages/:id/details', ...payer('payer.members'), ah(async (req, res) => {
  const b = body(req, { planId: t.id(), primaryOrgId: t.id(), employerId: t.id(), relation: t.enum(RELATIONS) });
  const c = await db.col('coverages').findOne({ id: param(req, 'id'), payerOrgId: req.ctx.org.id });
  if (!c) throw notFound('Cover not found');
  const set = { updatedAt: now() };
  if (b.planId) { const p = await db.col('hmo_plans').findOne({ id: b.planId, payerOrgId: req.ctx.org.id }); if (!p) throw notFound('Plan not found'); set.planId = p.id; set.planName = p.name; }
  if (b.primaryOrgId) { if (!(await inNetwork(req.ctx.org.id, b.primaryOrgId, true))) throw bad('That provider is not a primary care provider in your network'); set.primaryOrgId = b.primaryOrgId; set.primaryChangedAt = now(); }
  if (b.employerId) { if (!(await db.col('hmo_employers').findOne({ id: b.employerId, payerOrgId: req.ctx.org.id }))) throw notFound('Employer not found'); set.employerId = b.employerId; }
  if (b.relation) set.relation = b.relation;
  if (!c.cardCode) set.cardCode = await newCardCode();
  const u = await db.col('coverages').findOneAndUpdate({ id: c.id }, { $set: set });
  await audit(req, 'payer.cover_details', { type: 'coverage', id: c.id, patientId: c.patientConfirmed ? c.patientId : null }, { fields: Object.keys(b) });
  res.json(await cardView(u));
}));
/** add a dependant (spouse, child) to a principal's cover. Children often have no phone: the dependant is a patient
 *  record without a login, presented at providers with their own member card. */
router.post('/payer/coverages/:id/dependants', ...payer('payer.members'), ah(async (req, res) => {
  const b = body(req, { firstName: t.str({ required: true, max: 60, plain: true }), lastName: t.str({ required: true, max: 60, plain: true }), dob: t.date(), sex: t.enum(['female', 'male', 'other', 'unknown']), relation: t.enum(['spouse', 'child', 'parent', 'other'], { required: true }), phone: t.phone() });
  const principal = await db.col('coverages').findOne({ id: param(req, 'id'), payerOrgId: req.ctx.org.id, status: { $in: ['active', 'pending'] } });
  if (!principal) throw notFound('Principal cover not found');
  if (principal.principalCoverageId) throw bad('Add dependants to the principal member, not to a dependant');
  const count = await db.col('coverages').count({ principalCoverageId: principal.id, status: { $in: ['active', 'pending', 'suspended'] } });
  const plan = principal.planId ? await db.col('hmo_plans').findOne({ id: principal.planId }) : null;
  const max = plan ? plan.maxDependants || 0 : Number(S.get('process.hmo.maxDependants', 6));
  if (count >= max) throw conflict('This plan allows ' + max + ' dependants');
  let pat = b.phone ? await db.col('patients').findOne({ phone: b.phone }) : null;
  if (!pat) {
    pat = { id: id('pat'), uid: P.newUid(), phone: b.phone || null, phoneVerified: false, status: 'active', createdAt: now(), createdVia: 'hmo_dependant', firstName: b.firstName, lastName: b.lastName, dob: b.dob || null, sex: b.sex || 'unknown', lang: 'en', allergies: [], noKnownAllergies: false, conditions: [], guardianPatientId: principal.patientId || null };
    if (!pat.phone) delete pat.phone;
    await db.col('patients').insertOne(pat);
  }
  const c = { id: id('cov'), patientId: pat.id, phone: pat.phone || null, payerOrgId: req.ctx.org.id, memberNo: principal.memberNo + '-' + (count + 1), planId: principal.planId || null, planName: principal.planName || null, status: principal.status, patientConfirmed: true, payerVerified: true,
    enrolledBy: 'payer', relation: b.relation, principalCoverageId: principal.id, primaryOrgId: principal.primaryOrgId || null, employerId: principal.employerId || null, limits: principal.limits ? Object.assign({}, principal.limits) : null, usedKobo: zeroUsed(), validTo: principal.validTo || null,
    cardCode: await newCardCode(), createdAt: now(), history: [{ at: now(), from: null, to: principal.status, by: req.ctx.user.id, action: 'dependant' }] };
  try { await db.col('coverages').insertOne(c); } catch (e) { if (e.code === 11000) throw conflict('That member number is already used'); throw e; }
  if (principal.patientId) await notify({ patientId: principal.patientId, title: 'Dependant added to your cover', body: b.firstName + ' ' + b.lastName + ' (' + c.memberNo + ') is now on your ' + req.ctx.org.name + ' cover.', kind: 'hmo_cover', ref: { type: 'coverage', id: c.id } });
  await audit(req, 'payer.dependant_add', { type: 'coverage', id: c.id, patientId: pat.id }, { principal: principal.id, relation: b.relation });
  res.json(await cardView(c));
}));
router.get('/payer/coverages/:id/family', ...anyPayer, ah(async (req, res) => {
  const c = await db.col('coverages').findOne({ id: param(req, 'id'), payerOrgId: req.ctx.org.id });
  if (!c) throw notFound('Cover not found');
  const root = c.principalCoverageId ? await db.col('coverages').findOne({ id: c.principalCoverageId }) : c;
  const deps = await db.col('coverages').find({ principalCoverageId: root.id }, { sort: { createdAt: 1 } });
  const out = []; for (const x of [root].concat(deps)) out.push(await cardView(x));
  res.json(out);
}));

/* ================= capitation ================= */
async function capitationRows(payerOrgId, month) {
  const nets = await db.col('hmo_network').find({ payerOrgId, status: { $in: ['active', 'suspended'] }, primaryCare: true });
  const pays = await db.col('capitation_payments').find({ payerOrgId, month });
  const out = [];
  for (const n of nets) {
    const o = await orgs.getOrg(n.orgId);
    const paid = pays.find(p => p.orgId === n.orgId);
    const enrollees = paid ? paid.enrollees : await db.col('coverages').count({ payerOrgId, primaryOrgId: n.orgId, status: 'active' });
    const rate = paid ? paid.rateKobo : n.capitationKobo || 0;
    out.push({ orgId: n.orgId, orgName: o ? o.name : null, month, enrollees, rateKobo: rate, amountKobo: enrollees * rate, paid: !!paid, paidAt: paid ? paid.paidAt : null, reference: paid ? paid.reference : null, networkStatus: n.status });
  }
  return out.sort((a, b) => b.amountKobo - a.amountKobo);
}
const monthRule = t.str({ pattern: /^\d{4}-(0[1-9]|1[0-2])$/, label: 'Month (YYYY-MM)' });
router.get('/payer/capitation', ...payerAny(['payer.network', 'payer.pay', 'admin.reports']), ah(async (req, res) => {
  const q = query(req, { month: monthRule });
  const month = q.month || monthKey();
  const rows = await capitationRows(req.ctx.org.id, month);
  res.json({ month, rows, totalKobo: rows.reduce((s, r) => s + r.amountKobo, 0), paidKobo: rows.filter(r => r.paid).reduce((s, r) => s + r.amountKobo, 0) });
}));
router.post('/payer/capitation/pay', ...payer('payer.pay'), ah(async (req, res) => {
  const b = body(req, { month: Object.assign({}, monthRule, { required: true }), orgId: t.id({ required: true }), reference: t.str({ required: true, max: 60, plain: true, label: 'Payment reference' }) });
  if (b.month > monthKey()) throw bad('You cannot pay capitation for a future month');
  const n = await db.col('hmo_network').findOne({ payerOrgId: req.ctx.org.id, orgId: b.orgId, primaryCare: true, status: { $in: ['active', 'suspended'] } });
  if (!n) throw notFound('This provider is not a primary care provider in your network');
  if (await db.col('capitation_payments').findOne({ payerOrgId: req.ctx.org.id, orgId: b.orgId, month: b.month })) throw conflict('Capitation for this provider and month is already recorded');
  const enrollees = await db.col('coverages').count({ payerOrgId: req.ctx.org.id, primaryOrgId: b.orgId, status: 'active' });
  const p = { id: id('cap'), payerOrgId: req.ctx.org.id, orgId: b.orgId, month: b.month, enrollees, rateKobo: n.capitationKobo || 0, amountKobo: enrollees * (n.capitationKobo || 0), reference: b.reference, paidAt: now(), paidBy: req.ctx.user.id };
  await db.col('capitation_payments').insertOne(p);
  for (const role of ['owner', 'admin']) await notify({ orgId: b.orgId, role, title: 'Capitation paid', body: req.ctx.org.name + ' paid capitation for ' + b.month + ' (' + enrollees + ' enrollees). Reference ' + b.reference + '.', kind: 'capitation', ref: { type: 'capitation', id: p.id } });
  await audit(req, 'payer.capitation_pay', { type: 'capitation', id: p.id }, { orgId: b.orgId, month: b.month, amountKobo: p.amountKobo });
  res.json(p);
}));
/* provider: what HMOs owe and paid in capitation */
router.get('/hmo/capitation', A.requireStaff({ anyPerm: ['admin.finance', 'admin.reports', 'hmo.claim'] }), ah(async (req, res) => {
  const nets = await db.col('hmo_network').find({ orgId: req.ctx.org.id, primaryCare: true, status: { $in: ['active', 'suspended'] } });
  const month = monthKey();
  const current = [];
  for (const n of nets) {
    const h = await orgs.getOrg(n.payerOrgId);
    const enrollees = await db.col('coverages').count({ payerOrgId: n.payerOrgId, primaryOrgId: req.ctx.org.id, status: 'active' });
    current.push({ payerOrgId: n.payerOrgId, hmoName: h ? h.name : null, month, enrollees, rateKobo: n.capitationKobo || 0, amountKobo: enrollees * (n.capitationKobo || 0), paid: !!(await db.col('capitation_payments').findOne({ payerOrgId: n.payerOrgId, orgId: req.ctx.org.id, month })) });
  }
  const pays = await db.col('capitation_payments').find({ orgId: req.ctx.org.id }, { sort: { paidAt: -1 }, limit: 60 });
  const names = {}; for (const p of pays) if (!(p.payerOrgId in names)) { const h = await orgs.getOrg(p.payerOrgId); names[p.payerOrgId] = h ? h.name : null; }
  res.json({ month, current, payments: pays.map(p => Object.assign({ hmoName: names[p.payerOrgId] }, p)) });
}));

/* ================= provider desk: member card ================= */
async function cardAllowed(org, payerOrgId) {
  if (S.get('process.hmo.verifyCardAnyProvider', false)) return true;
  if (await inNetwork(payerOrgId, org.id)) return true;
  return !!(await db.col('hmo_panel').findOne({ orgId: org.id, payerOrgId, active: { $ne: false } }));
}
async function coverByCard(code) {
  const c = await db.col('coverages').findOne({ cardCode: String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '') });
  return c;
}
router.get('/hmo/verify-card', A.requireStaff({ anyPerm: ['hmo.check', 'patient.register'] }), ah(async (req, res) => {
  const q = query(req, { code: t.str({ required: true, min: 6, max: 20, label: 'Card code' }) });
  await RL.limit('card_' + req.ctx.org.id, 120, 3600);
  const c = await coverByCard(q.code);
  if (!c || !(await cardAllowed(req.ctx.org, c.payerOrgId))) throw notFound('No member card with that code for an HMO you work with');
  const v = await cardView(c);
  const link = c.patientId ? await P.linkOf(req.ctx.org.id, c.patientId) : null;
  await audit(req, 'hmo.card_verify', { type: 'coverage', id: c.id, patientId: link ? c.patientId : null });
  res.json(Object.assign(v, { active: PAYER.isActive(c), isPrimaryHere: c.primaryOrgId === req.ctx.org.id, linkedHere: !!link, patientId: link ? c.patientId : null, mrn: link ? link.mrn : null, cardCode: undefined, limits: undefined, usedKobo: undefined }));
}));
/** presenting the card at the desk registers the member here (dependants without a phone included) */
router.post('/hmo/verify-card/register', A.requireStaff({ perm: 'patient.register' }), ah(async (req, res) => {
  const b = body(req, { code: t.str({ required: true, min: 6, max: 20 }) });
  await RL.limit('card_' + req.ctx.org.id, 120, 3600);
  const c = await coverByCard(b.code);
  if (!c || !c.patientId || !(await cardAllowed(req.ctx.org, c.payerOrgId))) throw notFound('No member card with that code for an HMO you work with');
  if (!PAYER.isActive(c)) throw conflict('This cover is not active');
  const l = await P.ensureLink(req.ctx.org.id, c.patientId, req.ctx.user.id, 'hmo_card', { coverageId: c.id });
  await audit(req, 'hmo.card_register', { type: 'coverage', id: c.id, patientId: c.patientId });
  res.json({ ok: true, patientId: c.patientId, mrn: l.mrn });
}));

/* ================= HMO desk: register a client as an institution =================
 * The HMO onboards its own clients with their NIN, like a hospital does. A NIN already on MediCore gets a cover the
 * member confirms in the app (the HMO sees nothing more); a new NIN gets a patient record and an active cover. Any
 * provider that later finds the person by NIN sees which HMO covers them and whether it is in that HMO's network. */
router.post('/payer/members/register', ...payer('payer.members'), ah(async (req, res) => {
  const b = body(req, { firstName: t.str({ required: true, max: 60, plain: true }), lastName: t.str({ required: true, max: 60, plain: true }), dob: t.date(), sex: t.enum(['female', 'male', 'other', 'unknown']),
    phone: t.phone(), email: t.email(), address: t.str({ max: 300, plain: true }), nin: t.str({ pattern: /^\d{11}$/, label: 'NIN (11 digits)' }), noNinReason: t.enum(P.NO_NIN_REASONS),
    planId: t.id({ required: true }), validTo: t.date(), employerId: t.id(), primaryOrgId: t.id(), consent: t.bool({ required: true }) });
  if (!b.consent) throw bad('The member must agree to MediCore\'s privacy notice on your enrolment form first');
  if (!b.nin && !(b.noNinReason && S.get('process.identity.allowNoNinWithReason', true) !== false)) throw bad('Type the member\'s NIN (11 digits), or choose why they have none.');
  const plan = await db.col('hmo_plans').findOne({ id: b.planId, payerOrgId: req.ctx.org.id, active: { $ne: false } });
  if (!plan) throw notFound('Plan not found');
  if (b.primaryOrgId && !(await inNetwork(req.ctx.org.id, b.primaryOrgId, true))) throw bad('Choose a primary provider from your network');
  await RL.limit('hmoreg_' + req.ctx.org.id, 500, 3600);
  const ID = require('../lib/identity');
  let existing = b.nin ? await db.col('patients').findOne({ ninHash: ID.ninHash(b.nin) }) : null;
  if (!existing && b.phone) existing = await db.col('patients').findOne({ phone: b.phone });
  if (!existing && b.email) existing = await db.col('patients').findOne({ email: String(b.email).toLowerCase() });
  const validTo = b.validTo || addDays(todayLagos(), 365);
  const base = { id: id('cov'), payerOrgId: req.ctx.org.id, memberNo: await nextMemberNo(req.ctx.org), planId: plan.id, planName: plan.name, relation: 'self', employerId: b.employerId || null,
    primaryOrgId: b.primaryOrgId || null, primaryChangedAt: b.primaryOrgId ? now() : null, limits: fullLimits(plan.limits), usedKobo: zeroUsed(), validTo, cardCode: await newCardCode(), enrolledBy: 'payer_register', verifiedBy: req.ctx.user.id, verifiedAt: now(), payerVerified: true, createdAt: now() };
  if (existing) {
    const dup = await db.col('coverages').findOne({ patientId: existing.id, payerOrgId: req.ctx.org.id, status: { $in: ['pending', 'active', 'suspended'] } });
    if (dup) throw conflict('This person is already your member', 'member_exists');
    const c = Object.assign(base, { patientId: existing.id, phone: existing.phone || null, status: 'pending', patientConfirmed: false, history: [{ at: now(), from: null, to: 'pending', by: req.ctx.user.id, action: 'register_existing' }] });
    await db.col('coverages').insertOne(c);
    await notify({ patientId: existing.id, title: 'Confirm your HMO cover', body: req.ctx.org.name + ' has registered you on ' + plan.name + '. Open MediCore to confirm.', kind: 'hmo_cover', ref: { type: 'coverage', id: c.id }, sms: existing.userId ? undefined : existing.phone });
    await audit(req, 'payer.member_register', { type: 'coverage', id: c.id, patientId: existing.id }, { existing: true });
    // the response never reveals anything about the existing record
    return res.json({ ok: true, coverageId: c.id, memberNo: c.memberNo, status: 'pending', message: 'This person is already on MediCore. They confirm the cover in their app or by SMS.' });
  }
  const nf = b.nin ? await P.ninFields(b.nin, { firstName: b.firstName, lastName: b.lastName, dob: b.dob }, null) : { noNinReason: b.noNinReason };
  const p = Object.assign({ id: id('pat'), uid: P.newUid(), firstName: b.firstName, lastName: b.lastName, dob: b.dob || null, sex: b.sex || 'unknown', email: b.email || null, address: b.address || null, allergies: [], noKnownAllergies: false, conditions: [],
    status: 'active', createdAt: now(), createdVia: 'hmo', createdByOrg: req.ctx.org.id, userId: null }, b.phone ? { phone: b.phone } : {}, nf);
  await db.col('patients').insertOne(p);
  await P.recordConsent(p.id, 'hmo:' + req.ctx.org.id, true);
  const c = Object.assign(base, { patientId: p.id, phone: b.phone || null, status: 'active', patientConfirmed: false, history: [{ at: now(), from: null, to: 'active', by: req.ctx.user.id, action: 'register_new' }] });
  await db.col('coverages').insertOne(c);
  if (b.phone) await notify({ patientId: p.id, title: 'Welcome to ' + req.ctx.org.name, body: 'Your HMO cover ' + c.memberNo + ' is active. Download MediCore and sign up with this number to see your card and network.', sms: b.phone, kind: 'welcome' });
  await audit(req, 'payer.member_register', { type: 'coverage', id: c.id, patientId: p.id }, { existing: false, ninStatus: p.ninStatus || null });
  res.json({ ok: true, coverageId: c.id, memberNo: c.memberNo, cardCode: c.cardCode, status: 'active', ninStatus: p.ninStatus || 'none_with_reason' });
}));

/* ================= front desk: get an uninsured patient onto a network HMO's plan =================
 * HMOs and providers collaborate: a provider in an HMO's network offers that HMO's plans at the desk. The cover waits
 * for the premium, which the patient pays in the app or at the desk (the bill belongs to the HMO). */
router.get('/fd/patients/:id/hmo-plans', A.requireStaff({ perm: 'patient.register' }), ah(async (req, res) => {
  const l = await P.linkOf(req.ctx.org.id, param(req, 'id'));
  if (!l) throw notFound('Patient not found');
  const nets = await db.col('hmo_network').find({ orgId: req.ctx.org.id, status: 'active' });
  const ids = [...new Set(nets.map(n => n.payerOrgId))];
  const hmos = ids.length ? await db.col('orgs').find({ id: { $in: ids }, type: 'hmo', status: 'active' }) : [];
  const plans = ids.length ? await db.col('hmo_plans').find({ payerOrgId: { $in: ids }, active: { $ne: false }, sellOnline: true }) : [];
  const covered = await db.col('coverages').find({ patientId: l.patientId, status: { $in: ['active', 'pending', 'suspended'] } });
  res.json({ insured: covered.length > 0, hmos: hmos.map(h => ({ payerOrgId: h.id, name: h.name, plans: plans.filter(p => p.payerOrgId === h.id).map(planView) })) });
}));
router.post('/fd/patients/:id/hmo-enrol', A.requireStaff({ perm: 'patient.register' }), A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { planId: t.id({ required: true }), period: t.enum(['monthly', 'annual'], { required: true }), consent: t.bool({ required: true }) });
  if (!b.consent) throw bad('The patient must agree to the plan terms and to sharing their details with the HMO');
  const l = await P.linkOf(req.ctx.org.id, param(req, 'id'));
  if (!l) throw notFound('Patient not found');
  const plan = await db.col('hmo_plans').findOne({ id: b.planId, active: { $ne: false }, sellOnline: true });
  if (!plan || !(await inNetwork(plan.payerOrgId, req.ctx.org.id))) throw notFound('Offer plans of HMOs whose network you are in');
  const hmo = await orgs.getOrg(plan.payerOrgId);
  const pat = await db.col('patients').findOne({ id: l.patientId });
  if (await db.col('coverages').findOne({ patientId: pat.id, payerOrgId: hmo.id, status: { $in: ['pending', 'active', 'suspended'] } })) throw conflict('This patient already has cover with ' + hmo.name);
  const c = { id: id('cov'), patientId: pat.id, phone: pat.phone || null, payerOrgId: hmo.id, memberNo: await nextMemberNo(hmo), planId: plan.id, planName: plan.name, status: 'pending', patientConfirmed: true, payerVerified: false,
    enrolledBy: 'provider', enrolledByOrgId: req.ctx.org.id, relation: 'self', primaryOrgId: (await inNetwork(hmo.id, req.ctx.org.id, true)) ? req.ctx.org.id : null, limits: null, usedKobo: zeroUsed(), validTo: null, cardCode: await newCardCode(), createdAt: now(),
    history: [{ at: now(), from: null, to: 'pending', by: req.ctx.user.id, action: 'provider_enrol', orgId: req.ctx.org.id }] };
  c.primaryChangedAt = c.primaryOrgId ? now() : null;
  await db.col('coverages').insertOne(c);
  const bill = await premiumBill({ ctx: { user: req.ctx.user, patient: pat } }, c, plan, b.period);
  await notify({ patientId: pat.id, title: 'Pay your ' + hmo.name + ' premium', body: req.ctx.org.name + ' started your ' + plan.name + ' cover. It starts when the premium is paid.', kind: 'hmo_cover', ref: { type: 'coverage', id: c.id } });
  for (const role of ['payer_manager', 'payer_officer']) await notify({ orgId: hmo.id, role, title: 'New member from ' + req.ctx.org.name, body: plan.name + ': waiting for the premium.', kind: 'hmo_cover', ref: { type: 'coverage', id: c.id } });
  await audit(req, 'hmo.provider_enrol', { type: 'coverage', id: c.id, patientId: pat.id }, { payerOrgId: hmo.id, planId: plan.id });
  res.json({ ok: true, coverageId: c.id, memberNo: c.memberNo, billId: bill.id, amountKobo: bill.totalKobo });
}));

/* ================= patient app ================= */
const retailOn = () => { if (!S.feature('hmoRetail')) throw forbidden('Buying HMO plans in the app is switched off'); };
/** who may browse which HMOs. No cover: every HMO, free (so the uninsured get insured). Already covered: their own HMOs,
 * and every other HMO only with a marketplace subscription. */
async function hmoAccess(patientId) {
  const covs = await db.col('coverages').find({ patientId, status: { $in: ['active', 'pending', 'suspended'] } });
  const own = [...new Set(covs.map(c => c.payerOrgId))];
  if (!own.length && S.get('process.hmo.uninsuredBuyFree', true) !== false) return { all: true, own, reason: 'uninsured' };
  if (S.get('process.hmo.otherHmosNeedSubscription', true) === false) return { all: true, own, reason: 'open' };
  const sub = (await require('./market').accessOf(patientId)) || {};
  if (!sub.on) return { all: true, own, reason: 'open' };
  if (sub.full) return { all: true, own, reason: 'subscribed' };
  return { all: false, own, reason: 'subscription_required' };
}
router.get('/me/hmo/access', A.requirePatient, ah(async (req, res) => { const a = await hmoAccess(req.ctx.patient.id); res.json({ all: a.all, reason: a.reason, ninOnFile: !!req.ctx.patient.ninHash }); }));
/** HMOs selling plans in the app, with their plans */
router.get('/me/hmo/plans', A.requirePatient, ah(async (req, res) => {
  retailOn();
  const acc = await hmoAccess(req.ctx.patient.id);
  res.setHeader('X-HMO-Access', acc.reason);
  const plans = (await db.col('hmo_plans').find({ sellOnline: true, active: { $ne: false } }, { sort: { name: 1 } })).filter(p => acc.all || acc.own.includes(p.payerOrgId));
  const hmoIds = [...new Set(plans.map(p => p.payerOrgId))];
  const hmos = hmoIds.length ? await db.col('orgs').find({ id: { $in: hmoIds }, status: 'active', type: 'hmo' }) : [];
  const out = [];
  for (const h of hmos) {
    const netCount = await db.col('hmo_network').count({ payerOrgId: h.id, status: 'active' });
    out.push({ payerOrgId: h.id, name: h.name, phone: (h.contact || {}).phone || null, email: (h.contact || {}).email || null, networkProviders: netCount, plans: plans.filter(p => p.payerOrgId === h.id).map(planView) });
  }
  res.json(out.sort((a, b) => a.name.localeCompare(b.name)));
}));
router.get('/me/hmo/networks/:payerOrgId', A.requirePatient, ah(async (req, res) => {
  const q = query(req, { lat: t.lat(), lng: t.lng(), primaryOnly: t.bool() });
  const h = await db.col('orgs').findOne({ id: param(req, 'payerOrgId'), type: 'hmo', status: 'active' });
  if (!h) throw notFound('HMO not found');
  const f = { payerOrgId: h.id, status: 'active' }; if (q.primaryOnly) f.primaryCare = true;
  const nets = await db.col('hmo_network').find(f);
  const from = q.lat != null ? { lat: q.lat, lng: q.lng } : (req.ctx.patient.homeLoc || null);
  const out = [];
  for (const n of nets) { const o = await orgs.getOrg(n.orgId); if (o && o.status === 'active') out.push(Object.assign(orgs.publicOrg(o, from), { level: n.level || 'primary', primaryCare: !!n.primaryCare })); }
  out.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) || a.name.localeCompare(b.name));
  res.json(out);
}));
async function premiumBill(req, cov, plan, period) {
  const price = period === 'annual' ? plan.premiumAnnualKobo : plan.premiumMonthlyKobo;
  if (!price) throw bad('This plan has no ' + (period === 'annual' ? 'yearly' : 'monthly') + ' premium');
  const bill = await billing.createBill({ orgId: plan.payerOrgId, patientId: cov.patientId, lines: [{ code: 'PREMIUM', name: plan.name + ' premium (' + (period === 'annual' ? '12 months' : '1 month') + ')', category: 'other', qty: 1, unitPriceKobo: price }], source: { type: 'hmo_premium', id: cov.id }, createdBy: req.ctx.user.id, note: period });
  await db.col('coverages').updateOne({ id: cov.id }, { $set: { billId: bill.id, paymentStatus: 'due', duePeriod: period } });
  return bill;
}
router.post('/me/hmo/buy', A.requirePatient, ah(async (req, res) => {
  retailOn();
  const b = body(req, { planId: t.id({ required: true }), period: t.enum(['monthly', 'annual'], { required: true }), primaryOrgId: t.id(), consent: t.bool({ required: true }) });
  if (!b.consent) throw bad('Please accept the plan\'s terms and agree to share your details with the HMO');
  const plan = await db.col('hmo_plans').findOne({ id: b.planId, sellOnline: true, active: { $ne: false } });
  if (!plan) throw notFound('Plan not found');
  const hmo = await db.col('orgs').findOne({ id: plan.payerOrgId, type: 'hmo', status: 'active' });
  if (!hmo) throw notFound('Plan not found');
  const pid = req.ctx.patient.id;
  if (S.get('process.identity.requireNin', true) !== false && !req.ctx.patient.ninHash) throw Object.assign(bad('Add your NIN in Settings first. HMOs register members with a confirmed NIN, so no paperwork is needed.'), { code: 'nin_required' });
  const acc = await hmoAccess(pid);
  if (!acc.all && !acc.own.includes(hmo.id)) throw Object.assign(forbidden('You already have HMO cover. To compare and join other HMOs, subscribe to the marketplace.'), { code: 'subscription_required' });
  const open = await db.col('coverages').findOne({ patientId: pid, payerOrgId: hmo.id, status: { $in: ['pending', 'active', 'suspended'] } });
  if (open && open.paymentStatus === 'due' && open.billId) { const bill = await db.col('bills').findOne({ id: open.billId }); if (bill && bill.status === 'open') return res.json({ coverage: await cardView(open), billId: bill.id, amountKobo: bill.patientDueKobo - bill.paidKobo, resumed: true }); }
  if (open) throw conflict('You already have cover with ' + hmo.name + '. Renew it from your HMO page.');
  if (b.primaryOrgId && !(await inNetwork(hmo.id, b.primaryOrgId, true))) throw bad('Choose a primary provider from this HMO\'s network');
  await RL.limit('hmobuy_' + pid, 10, 86400);
  const c = { id: id('cov'), patientId: pid, phone: req.ctx.patient.phone || null, payerOrgId: hmo.id, memberNo: await nextMemberNo(hmo), planId: plan.id, planName: plan.name, status: 'pending', patientConfirmed: true, payerVerified: false,
    enrolledBy: 'online', relation: 'self', primaryOrgId: b.primaryOrgId || null, primaryChangedAt: b.primaryOrgId ? now() : null, limits: null, usedKobo: zeroUsed(), validTo: null, cardCode: await newCardCode(), createdAt: now(), history: [{ at: now(), from: null, to: 'pending', by: req.ctx.user.id, action: 'buy' }] };
  await db.col('coverages').insertOne(c);
  const bill = await premiumBill(req, c, plan, b.period);
  await audit(req, 'hmo.plan_buy', { type: 'coverage', id: c.id, patientId: pid, orgId: hmo.id }, { planId: plan.id, period: b.period });
  res.json({ coverage: await cardView(Object.assign(c, { billId: bill.id, paymentStatus: 'due' })), billId: bill.id, amountKobo: bill.totalKobo });
}));
router.post('/me/hmo/:id/renew', A.requirePatient, ah(async (req, res) => {
  retailOn();
  const b = body(req, { period: t.enum(['monthly', 'annual'], { required: true }) });
  const c = await db.col('coverages').findOne({ id: param(req, 'id'), patientId: req.ctx.patient.id, status: { $in: ['active', 'pending'] }, principalCoverageId: { $exists: false } });
  if (!c || !c.planId) throw notFound('Cover not found');
  if (c.paymentStatus === 'due' && c.billId) { const bill = await db.col('bills').findOne({ id: c.billId }); if (bill && bill.status === 'open') return res.json({ billId: bill.id, amountKobo: bill.patientDueKobo - bill.paidKobo, resumed: true }); }
  const plan = await db.col('hmo_plans').findOne({ id: c.planId, active: { $ne: false } });
  if (!plan) throw conflict('This plan is no longer offered. Contact your HMO.');
  const bill = await premiumBill(req, c, plan, b.period);
  res.json({ billId: bill.id, amountKobo: bill.totalKobo });
}));
/* the premium is paid: activate or extend the cover (exactly once per bill) */
billing.onSettled('hmo_premium', async (bill) => {
  const c = await db.col('coverages').findOneAndUpdate({ id: bill.source.id, billId: bill.id, paymentStatus: 'due' }, { $set: { paymentStatus: 'paid', lastPaidAt: now() } });
  if (!c) return;
  const plan = c.planId ? await db.col('hmo_plans').findOne({ id: c.planId }) : null;
  const months = c.duePeriod === 'annual' ? 12 : 1;
  const start = c.validTo && c.validTo >= todayLagos() ? c.validTo : todayLagos();
  const d = new Date(start + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + months);
  const validTo = d.toISOString().slice(0, 10);
  const set = { validTo, updatedAt: now() };
  const auto = !plan || plan.activateOnPayment !== false;
  if (c.status === 'pending' && auto) Object.assign(set, { status: 'active', payerVerified: true, verifiedAt: now(), verifiedBy: 'payment', limits: plan ? fullLimits(plan.limits) : c.limits });
  await db.col('coverages').updateOne({ id: c.id }, { $set: set, $push: { history: { at: now(), from: c.status, to: set.status || c.status, by: 'payment', action: 'premium_paid', billId: bill.id } } });
  // dependants follow the principal's validity
  await db.col('coverages').updateMany({ principalCoverageId: c.id, status: { $in: ['active', 'pending'] } }, { $set: { validTo } });
  if (c.patientId) await notify({ patientId: c.patientId, title: 'HMO cover ' + (set.status === 'active' ? 'active' : 'paid'), body: 'Your premium is paid. Cover ' + c.memberNo + ' runs to ' + validTo + '.' + (set.status === 'active' || c.status === 'active' ? '' : ' Your HMO will confirm it shortly.'), kind: 'hmo_cover', ref: { type: 'coverage', id: c.id } });
  for (const role of ['payer_manager', 'payer_officer']) await notify({ orgId: c.payerOrgId, role, title: 'Premium paid online', body: 'Member ' + c.memberNo + (set.status === 'active' ? ' is active.' : ' paid and is waiting for activation.'), kind: 'hmo_cover', ref: { type: 'coverage', id: c.id } });
  try { await require('../lib/events').emit('hmo.premium_paid', { coverageId: c.id, payerOrgId: c.payerOrgId, amountKobo: bill.totalKobo }); } catch (e) { /* best effort */ }
});
/** the patient's member cards: own covers and their dependants' */
router.get('/me/hmo/cards', A.requirePatient, ah(async (req, res) => {
  const own = await db.col('coverages').find({ patientId: req.ctx.patient.id, status: { $nin: ['declined', 'rejected'] } }, { sort: { createdAt: -1 } });
  const deps = own.length ? await db.col('coverages').find({ principalCoverageId: { $in: own.map(c => c.id) }, status: { $nin: ['declined', 'rejected'] } }) : [];
  const emp = {}; for (const c of own.concat(deps)) if (c.employerId && !(c.employerId in emp)) { const e = await db.col('hmo_employers').findOne({ id: c.employerId }); emp[c.employerId] = e ? e.name : null; }
  const out = []; for (const c of own.concat(deps)) out.push(Object.assign(await cardView(c, emp), { mine: c.patientId === req.ctx.patient.id }));
  res.json(out);
}));
router.post('/me/hmo/:id/primary', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { orgId: t.id({ required: true }) });
  const c = await db.col('coverages').findOne({ id: param(req, 'id'), status: 'active' });
  const mine = c && (c.patientId === req.ctx.patient.id || (c.principalCoverageId && await db.col('coverages').findOne({ id: c.principalCoverageId, patientId: req.ctx.patient.id })));
  if (!mine) throw notFound('Cover not found');
  if (c.primaryOrgId === b.orgId) throw conflict('That is already your primary provider');
  if (!(await inNetwork(c.payerOrgId, b.orgId, true))) throw bad('Choose a primary care provider from your HMO\'s network');
  const months = Number(S.get('process.hmo.primaryChangeMinMonths', 6)) || 0;
  if (c.primaryOrgId && c.primaryChangedAt && months && now() - c.primaryChangedAt < months * 30 * 86400e3) throw conflict('You can change your primary provider once every ' + months + ' months. Ask your HMO if you need to change sooner.', 'too_soon');
  const u = await db.col('coverages').findOneAndUpdate({ id: c.id, status: 'active' }, { $set: { primaryOrgId: b.orgId, primaryChangedAt: now(), updatedAt: now() }, $push: { history: { at: now(), from: 'active', to: 'active', by: req.ctx.user.id, action: 'primary_change', orgId: b.orgId } } });
  await audit(req, 'hmo.primary_change', { type: 'coverage', id: c.id, patientId: c.patientId, orgId: c.payerOrgId }, { orgId: b.orgId });
  res.json(await cardView(u));
}));

/* ---------------- member requests (patient <-> HMO) ---------------- */
function requestView(r, forPayer) {
  return { id: r.id, number: r.number, payerOrgId: r.payerOrgId, coverageId: r.coverageId, memberNo: r.memberNo, type: r.type, subject: r.subject, status: r.status, messages: r.messages || [], createdAt: r.createdAt, lastAt: r.lastAt,
    unread: forPayer ? !!r.unreadPayer : !!r.unreadMember, memberName: forPayer ? r.memberName || null : undefined };
}
router.get('/me/hmo/requests', A.requirePatient, ah(async (req, res) => {
  const rows = await db.col('hmo_requests').find({ patientId: req.ctx.patient.id }, { sort: { lastAt: -1 }, limit: 100 });
  res.json(rows.map(r => requestView(r)));
}));
router.post('/me/hmo/requests', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { coverageId: t.id({ required: true }), type: t.enum(REQ_TYPES, { required: true }), subject: t.str({ required: true, max: 120, plain: true }), text: t.text({ required: true, max: 2000 }) });
  const c = await db.col('coverages').findOne({ id: b.coverageId, patientId: req.ctx.patient.id });
  if (!c) throw notFound('Cover not found');
  await RL.limit('hmoreq_' + req.ctx.patient.id, 20, 86400);
  const n = await orgs.nextNumber('hreq_' + c.payerOrgId);
  const r = { id: id('hrq'), number: 'MR' + String(n).padStart(6, '0'), payerOrgId: c.payerOrgId, coverageId: c.id, memberNo: c.memberNo, patientId: req.ctx.patient.id, memberName: req.ctx.patient.firstName + ' ' + req.ctx.patient.lastName, type: b.type, subject: b.subject, status: 'open',
    messages: [{ id: id('hm'), by: 'member', byName: req.ctx.patient.firstName, text: b.text, at: now() }], createdAt: now(), lastAt: now(), unreadPayer: true, unreadMember: false };
  await db.col('hmo_requests').insertOne(r);
  for (const role of ['payer_officer', 'payer_manager']) await notify({ orgId: c.payerOrgId, role, title: 'Member request ' + r.number, body: b.subject, kind: 'hmo_request', ref: { type: 'hmo_request', id: r.id } });
  await audit(req, 'hmo.request', { type: 'hmo_request', id: r.id, patientId: r.patientId, orgId: c.payerOrgId }, { type: b.type });
  res.json(requestView(r));
}));
router.post('/me/hmo/requests/:id/messages', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { text: t.text({ required: true, max: 2000 }) });
  const m = { id: id('hm'), by: 'member', byName: req.ctx.patient.firstName, text: b.text, at: now() };
  const r = await db.col('hmo_requests').findOneAndUpdate({ id: param(req, 'id'), patientId: req.ctx.patient.id, status: { $ne: 'closed' } }, { $push: { messages: m }, $set: { lastAt: now(), unreadPayer: true, status: 'open' } });
  if (!r) throw conflict('This request is closed. Open a new one.');
  res.json(requestView(r));
}));
router.post('/me/hmo/requests/:id/read', A.requirePatient, ah(async (req, res) => { await db.col('hmo_requests').updateOne({ id: param(req, 'id'), patientId: req.ctx.patient.id }, { $set: { unreadMember: false } }); res.json({ ok: true }); }));
router.get('/payer/requests', ...payerAny(['payer.care', 'payer.members']), ah(async (req, res) => {
  const q = query(req, { status: t.enum(['open', 'answered', 'closed']) });
  const f = { payerOrgId: req.ctx.org.id }; if (q.status) f.status = q.status;
  const rows = await db.col('hmo_requests').find(f, { sort: { lastAt: -1 }, limit: 300 });
  res.json(rows.map(r => requestView(r, true)));
}));
router.post('/payer/requests/:id/reply', ...payerAny(['payer.care', 'payer.members']), ah(async (req, res) => {
  const b = body(req, { text: t.text({ required: true, max: 2000 }), close: t.bool() });
  const m = { id: id('hm'), by: 'hmo', byName: req.ctx.user.name, text: b.text, at: now() };
  const r = await db.col('hmo_requests').findOneAndUpdate({ id: param(req, 'id'), payerOrgId: req.ctx.org.id }, { $push: { messages: m }, $set: { lastAt: now(), unreadMember: true, unreadPayer: false, status: b.close ? 'closed' : 'answered' } });
  if (!r) throw notFound('Request not found');
  await notify({ patientId: r.patientId, title: req.ctx.org.name + ' replied', body: r.subject, kind: 'hmo_request', ref: { type: 'hmo_request', id: r.id } });
  await audit(req, 'payer.request_reply', { type: 'hmo_request', id: r.id, patientId: r.patientId }, { close: !!b.close });
  res.json(requestView(r, true));
}));
router.post('/payer/requests/:id/read', ...payerAny(['payer.care', 'payer.members']), ah(async (req, res) => { await db.col('hmo_requests').updateOne({ id: param(req, 'id'), payerOrgId: req.ctx.org.id }, { $set: { unreadPayer: false } }); res.json({ ok: true }); }));

/* ---------------- HMO desk overview additions ---------------- */
router.get('/payer/overview', ...anyPayer, ah(async (req, res) => {
  const org = req.ctx.org.id;
  const plans = await db.col('hmo_plans').find({ payerOrgId: org, active: { $ne: false } });
  const byPlan = []; for (const p of plans) byPlan.push({ planId: p.id, name: p.name, members: await db.col('coverages').count({ payerOrgId: org, planId: p.id, status: 'active' }), sellOnline: !!p.sellOnline });
  const month = monthKey(); const cap = await capitationRows(org, month);
  res.json({ plans: byPlan, network: { active: await db.col('hmo_network').count({ payerOrgId: org, status: 'active' }), invited: await db.col('hmo_network').count({ payerOrgId: org, status: 'invited' }) },
    onlineMembers: await db.col('coverages').count({ payerOrgId: org, enrolledBy: 'online', status: 'active' }), dependants: await db.col('coverages').count({ payerOrgId: org, principalCoverageId: { $exists: true }, status: 'active' }),
    openRequests: await db.col('hmo_requests').count({ payerOrgId: org, status: 'open' }), capitation: { month, dueKobo: cap.filter(r => !r.paid).reduce((s, r) => s + r.amountKobo, 0), providers: cap.length } });
}));

/* ================= demo ================= */
async function seedDemo(ctx) {
  const hmo = ctx.orgs.hmo; if (!hmo) return;
  const limits = { consultation: naira(150000), drug: naira(200000), lab: naira(100000), ambulance: naira(150000), delivery: naira(10000), procedure: naira(300000), other: naira(30000) };
  const gold = { id: id('hpl'), payerOrgId: hmo.id, name: 'Harbor Gold', code: 'HG', kind: 'family', premiumMonthlyKobo: naira(18500), premiumAnnualKobo: naira(199000), maxDependants: 4, limits: Object.assign({}, limits, { procedure: naira(600000) }), benefits: 'GP and specialist visits, drugs on the plan list, lab tests, emergency ambulance, maternity after 12 months.', exclusions: 'Cosmetic surgery, fertility treatment, cancer treatment beyond the plan limit.', waitingDays: 30, sellOnline: true, activateOnPayment: true, active: true, createdAt: now() };
  const silver = { id: id('hpl'), payerOrgId: hmo.id, name: 'Harbor Silver', code: 'HS', kind: 'individual', premiumMonthlyKobo: naira(7500), premiumAnnualKobo: naira(80000), maxDependants: 0, limits, benefits: 'GP visits, basic drugs, common lab tests, emergency ambulance.', exclusions: 'Specialist surgery, maternity, dental and optical.', waitingDays: 14, sellOnline: true, activateOnPayment: true, active: true, createdAt: now() };
  await db.col('hmo_plans').insertMany([gold, silver]);
  const nets = [['hospital', true, 'primary', naira(1500)], ['clinic', true, 'primary', naira(1200)], ['pharmacy', false, 'pharmacy', 0], ['lab', false, 'diagnostic', 0], ['ambulance', false, 'secondary', 0]];
  for (const [k, pc, level, cap] of nets) {
    const o = ctx.orgs[k]; if (!o) continue;
    await db.col('hmo_network').insertOne({ id: id('hnw'), payerOrgId: hmo.id, orgId: o.id, level, primaryCare: pc, capitationKobo: cap, status: 'active', invitedAt: now() - 40 * 86400e3, acceptedAt: now() - 39 * 86400e3, invitedBy: 'demo' });
    if (!(await db.col('hmo_panel').findOne({ orgId: o.id, payerOrgId: hmo.id }))) await db.col('hmo_panel').insertOne({ id: id('hp'), orgId: o.id, payerOrgId: hmo.id, name: hmo.name, code: hmo.code, active: true, createdAt: now(), via: 'network' });
  }
  const emp = { id: id('hem'), payerOrgId: hmo.id, name: 'Lagoon Logistics Ltd', contactName: 'HR desk', planId: gold.id, active: true, createdAt: now() };
  await db.col('hmo_employers').insertOne(emp);
  const amakaCov = await db.col('coverages').findOne({ payerOrgId: hmo.id, memberNo: 'HH-100234' });
  if (amakaCov) {
    await db.col('coverages').updateOne({ id: amakaCov.id }, { $set: { planId: gold.id, planName: gold.name, primaryOrgId: ctx.orgs.hospital.id, primaryChangedAt: now() - 200 * 86400e3, employerId: emp.id, relation: 'self', cardCode: 'HGAMAKA7' } });
    const kid = { id: id('pat'), uid: P.newUid(), status: 'active', createdAt: now(), createdVia: 'hmo_dependant', firstName: 'Chidera', lastName: 'Eze', dob: '2017-05-14', sex: 'female', lang: 'en', allergies: [], noKnownAllergies: true, conditions: [], guardianPatientId: amakaCov.patientId };
    await db.col('patients').insertOne(kid);
    await db.col('coverages').insertOne({ id: id('cov'), patientId: kid.id, phone: null, payerOrgId: hmo.id, memberNo: 'HH-100234-1', planId: gold.id, planName: gold.name, status: 'active', patientConfirmed: true, payerVerified: true, enrolledBy: 'payer', relation: 'child', principalCoverageId: amakaCov.id, primaryOrgId: ctx.orgs.hospital.id, employerId: emp.id,
      limits: Object.assign({}, amakaCov.limits), usedKobo: zeroUsed(), validTo: amakaCov.validTo, cardCode: 'HGCHIDE2', createdAt: now(), history: [{ at: now(), from: null, to: 'active', by: 'demo', action: 'dependant' }] });
  }
  const tobiCov = await db.col('coverages').findOne({ payerOrgId: hmo.id, memberNo: 'HH-100871' });
  if (tobiCov) await db.col('coverages').updateOne({ id: tobiCov.id }, { $set: { planId: silver.id, planName: silver.name, primaryOrgId: (ctx.orgs.clinic || ctx.orgs.hospital).id, primaryChangedAt: now() - 30 * 86400e3, relation: 'self', cardCode: 'HSTOBI45' } });
  if (amakaCov) {
    const n = await orgs.nextNumber('hreq_' + hmo.id);
    await db.col('hmo_requests').insertOne({ id: id('hrq'), number: 'MR' + String(n).padStart(6, '0'), payerOrgId: hmo.id, coverageId: amakaCov.id, memberNo: amakaCov.memberNo, patientId: amakaCov.patientId, memberName: 'Amaka Eze', type: 'question', subject: 'Is physiotherapy covered?', status: 'open',
      messages: [{ id: id('hm'), by: 'member', byName: 'Amaka', text: 'My doctor wants me to do 6 physiotherapy sessions after my knee injury. Is it covered on Harbor Gold?', at: now() - 5 * 3600e3 }], createdAt: now() - 5 * 3600e3, lastAt: now() - 5 * 3600e3, unreadPayer: true, unreadMember: false });
  }
  const prev = monthKey(now() - 32 * 86400e3);
  const hospEnrol = await db.col('coverages').count({ payerOrgId: hmo.id, primaryOrgId: ctx.orgs.hospital.id, status: 'active' });
  await db.col('capitation_payments').insertOne({ id: id('cap'), payerOrgId: hmo.id, orgId: ctx.orgs.hospital.id, month: prev, enrollees: hospEnrol, rateKobo: naira(1500), amountKobo: hospEnrol * naira(1500), reference: 'HHCAP-' + prev.replace('-', ''), paidAt: now() - 5 * 86400e3, paidBy: 'demo' });
}

module.exports = { name: 'hmoplus', router, seedDemoAfter: seedDemo, networkOrgIdsForPatient, hmosAccepted, activeCoversOf, inNetwork, cardView, planView, newCardCode, nextMemberNo, RELATIONS };
