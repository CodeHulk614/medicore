'use strict';
/*
 * Providers (orgs): signup, public directory, settings, modules, price list, plans.
 *
 * A provider is any business on MediCore: a full hospital, a clinic, a standalone pharmacy,
 * an ambulance service, a lab, or an HMO. Its enabled modules decide what works for it.
 * New providers start as `pending` until the MediCore team approves them.
 */
const express = require('express');
const db = require('../db');
const config = require('../config');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param } = require('../lib/http');
const A = require('../lib/auth');
const { ORG_TYPES, MODULES, defaultModules, allowedModules } = require('../lib/roles');
const { id, haversineKm, naira } = require('../lib/util');
const { audit } = require('../lib/audit');
const RL = require('../lib/ratelimit');

db.index('orgs', ['code'], { unique: true });
db.index('orgs', ['status', 'type']);
db.index('services', ['orgId', 'code'], { unique: true });
db.index('counters', ['id']);

const router = express.Router();

const DEFAULT_SETTINGS = { requireClockIn: true, strictGeofence: false, geofenceM: 300, twoStepLabVerify: false, deliveryFeeKobo: naira(1500), selfClaimDeliveries: false, marketplace: true, acceptsWalkIns: true, openingHours: 'Mon-Sat 08:00-18:00',
  acceptsPatientApplications: true, networkListed: true, acceptsReferrals: true, acceptsOnlineBooking: true, referralsFromPartnersOnly: false };

/** default monthly plans per provider type (NGN). The MediCore team can edit these in HQ. */
const DEFAULT_PLANS = [
  { key: 'clinic_basic', label: 'Clinic Basic', orgTypes: ['clinic'], priceKobo: naira(45000), modules: ['frontdesk', 'clinic', 'hmo'], seats: 10 },
  { key: 'clinic_plus', label: 'Clinic Plus', orgTypes: ['clinic'], priceKobo: naira(95000), modules: ['frontdesk', 'clinic', 'hmo', 'pharmacy', 'delivery', 'lab', 'chw'], seats: 30 },
  { key: 'hospital', label: 'Hospital', orgTypes: ['hospital'], priceKobo: naira(250000), modules: ['frontdesk', 'clinic', 'pharmacy', 'delivery', 'ambulance', 'lab', 'hmo', 'chw'], seats: 150 },
  { key: 'pharmacy', label: 'Pharmacy', orgTypes: ['pharmacy'], priceKobo: naira(35000), modules: ['frontdesk', 'pharmacy', 'delivery', 'hmo'], seats: 15 },
  { key: 'ambulance', label: 'Ambulance service', orgTypes: ['ambulance'], priceKobo: naira(60000), modules: ['frontdesk', 'ambulance', 'hmo'], seats: 40 },
  { key: 'lab', label: 'Laboratory', orgTypes: ['lab'], priceKobo: naira(40000), modules: ['frontdesk', 'lab', 'hmo', 'delivery'], seats: 20 },
  { key: 'hmo', label: 'HMO desk', orgTypes: ['hmo'], priceKobo: naira(150000), modules: ['payer'], seats: 50 },
];

async function nextNumber(key) {
  const r = await db.col('counters').findOneAndUpdate({ id: key }, { $inc: { n: 1 }, $setOnInsert: { id: key } }, { upsert: true });
  return r.n;
}
async function uniqueCode(name) {
  const base = (name || 'MC').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5) || 'MC';
  for (let i = 0; i < 20; i++) {
    const code = base + (i === 0 ? '' : String(Math.floor(100 + Math.random() * 900)));
    if (!(await db.col('orgs').findOne({ code }))) return code;
  }
  return base + Date.now().toString(36).toUpperCase();
}
async function planFor(type) {
  const plans = await db.col('plans').find({ active: { $ne: false } });
  return plans.find(p => (p.orgTypes || []).includes(type)) || null;
}
async function ensurePlans() {
  for (const p of DEFAULT_PLANS) {
    await db.col('plans').findOneAndUpdate({ id: p.key }, { $setOnInsert: Object.assign({ id: p.key, period: 'monthly', currency: 'NGN', active: true }, p) }, { upsert: true });
  }
}

/**
 * Price a custom package. modules: the apps the provider picked; seats: staff accounts wanted.
 * Base (patient app, front desk, admin, HMO billing) + each service app, bundle discount, extra seats.
 * The NGN bank service charge per payment is shown separately (it is charged per transaction).
 */
function quote(modules, { seats, period, type } = {}) {
  const S = require('../lib/settings');
  const pr = S.get('pricing', S.DEFAULTS.pricing);
  const list = [...new Set(modules || [])];
  const isHmo = type === 'hmo' || list.includes('payer');
  const lines = [];
  if (!isHmo) lines.push({ key: 'base', label: 'Core package: patient app, front desk, admin, HMO billing', kobo: pr.baseKobo });
  const service = list.filter(m => !(pr.baseIncludes || []).includes(m));
  for (const m of service) { const k = (pr.modulesKobo || {})[m]; if (k == null) continue; lines.push({ key: m, label: (MODULES[m] || {}).label || m, kobo: k }); }
  const subtotal = lines.reduce((a, l) => a + l.kobo, 0);
  const disc = (pr.bundleDiscounts || []).filter(d => service.length >= d.minModules).sort((a, b) => b.percent - a.percent)[0];
  const discountKobo = disc ? Math.round(subtotal * disc.percent / 100) : 0;
  const extraSeats = Math.max(0, (seats || pr.seatsIncluded) - pr.seatsIncluded);
  const seatsKobo = extraSeats * pr.extraSeatKobo;
  const monthly = subtotal - discountKobo + seatsKobo;
  const per = period === 'annual' ? 'annual' : 'monthly';
  const totalKobo = per === 'annual' ? monthly * (pr.annualMonthsCharged || 12) : monthly;
  const bank = S.get('process.billing.bankChargeKobo', 220000);
  return { currency: 'NGN', period: per, modules: list, lines, subtotalKobo: subtotal, discount: disc ? { percent: disc.percent, kobo: discountKobo } : null,
    seats: { included: pr.seatsIncluded, requested: seats || pr.seatsIncluded, extra: extraSeats, kobo: seatsKobo }, monthlyKobo: monthly, totalKobo,
    bankChargePerPaymentKobo: bank, annualNote: per === 'annual' ? 'Pay for ' + pr.annualMonthsCharged + ' months, get 12' : null, trialDays: pr.trialDays };
}
function subscriptionFor(modules, type, seats, period) {
  const q = quote(modules, { seats, period, type });
  return { modules: q.modules, monthlyKobo: q.monthlyKobo, period: q.period, totalKobo: q.totalKobo, seats: q.seats.requested, status: 'trial', trialEnds: Date.now() + q.trialDays * 86400e3, quotedAt: Date.now() };
}

/** create a provider (used by public signup and by HQ). Returns { org, owner } */
async function createOrg({ type, name, modules, contact, location, kyc, owner, status, createdBy, settings, seats, period }) {
  if (!ORG_TYPES[type]) throw bad('Unknown provider type');
  await ensurePlans();
  const allowed = allowedModules(type);
  let mods = Array.isArray(modules) && modules.length ? modules.filter(m => allowed.includes(m)) : defaultModules(type);
  defaultModules(type).filter(m => MODULES[m] && MODULES[m].always).forEach(m => { if (!mods.includes(m)) mods.push(m); });
  // a module that requires another (delivery needs pharmacy or lab)
  if (mods.includes('delivery') && !mods.includes('pharmacy') && !mods.includes('lab')) mods = mods.filter(m => m !== 'delivery');
  const plan = await planFor(type);
  const org = {
    id: id('org'), name, type, code: await uniqueCode(name), status: status || 'pending', modules: [...new Set(mods)],
    settings: Object.assign({}, DEFAULT_SETTINGS, settings || {}), contact: contact || {}, location: location || null, kyc: kyc || {},
    plan: plan ? { key: plan.id, label: plan.label, priceKobo: plan.priceKobo, period: plan.period, status: 'trial', trialEnds: Date.now() + 30 * 86400e3 } : null,
    createdAt: Date.now(), createdBy: createdBy || null, mrnPrefix: null,
  };
  org.subscription = subscriptionFor(org.modules, type, seats, period);
  org.mrnPrefix = org.code.slice(0, 4);
  // owner account: reuse an existing person by email (they may already be a patient elsewhere)
  let user = owner.email ? await db.col('users').findOne({ email: owner.email }) : null;
  if (!user && owner.phone) user = await db.col('users').findOne({ phone: owner.phone });
  if (user) {
    if (owner.password && !(await A.verifyPassword(owner.password, user.passHash))) throw conflict('An account with that email or phone already exists. Sign in with its password, or use another email.');
  } else {
    if (owner.password) A.checkPassword(owner.password);
    user = { id: id('usr'), name: owner.name, email: owner.email || undefined, phone: owner.phone || undefined, passHash: owner.password ? await A.hashPassword(owner.password) : null, status: 'active', mustChangePassword: !owner.password, createdAt: Date.now() };
    if (!user.email) delete user.email; if (!user.phone) delete user.phone;
    await db.col('users').insertOne(user);
  }
  await db.col('orgs').insertOne(org);
  const m = { id: id('mem'), userId: user.id, orgId: org.id, role: type === 'hmo' ? 'payer_manager' : 'owner', isOwner: true, status: 'active', createdAt: Date.now(), createdBy: createdBy || user.id };
  await db.col('memberships').insertOne(m);
  await db.col('orgs').updateOne({ id: org.id }, { $set: { ownerUserId: user.id } });
  return { org: Object.assign(org, { ownerUserId: user.id }), owner: user, membership: m };
}

function publicOrg(o, from) {
  const d = from && o.location ? haversineKm(from, o.location) : null;
  return { id: o.id, name: o.name, type: o.type, typeLabel: (ORG_TYPES[o.type] || {}).label, code: o.code, modules: o.modules, area: o.location ? o.location.area || null : null, city: o.location ? o.location.city || null : null,
    location: o.location ? { lat: o.location.lat, lng: o.location.lng } : null, distanceKm: d == null ? null : Math.round(d * 10) / 10, phone: (o.contact || {}).phone || null, openingHours: (o.settings || {}).openingHours || null };
}

/* -------- public: provider signup -------- */
router.post('/orgs/signup', ah(async (req, res) => {
  await RL.limitIp(req, 'orgsignup', 10, 3600);
  const b = body(req, {
    type: t.enum(Object.keys(ORG_TYPES), { required: true }), name: t.str({ required: true, min: 3, max: 120, label: 'Provider name', plain: true }),
    modules: t.arr(t.enum(Object.keys(MODULES)), { max: 12 }),
    contact: t.obj({ phone: t.phone({ required: true }), email: t.email({ required: true }), address: t.str({ required: true, max: 300 }) }, { required: true }),
    location: t.obj({ lat: t.lat(), lng: t.lng(), area: t.str({ max: 80 }), city: t.str({ max: 80 }), state: t.str({ max: 80 }) }),
    kyc: t.obj({ cacNumber: t.str({ max: 40, label: 'CAC number' }), licenceKind: t.str({ max: 60 }), licenceNumber: t.str({ max: 60, label: 'Licence number' }) }),
    owner: t.obj({ name: t.str({ required: true, max: 100 }), email: t.email({ required: true }), phone: t.phone({ required: true }), password: t.str({ required: true, trim: false, max: 128 }) }, { required: true }),
    seats: t.int({ min: 1, max: 2000 }), period: t.enum(['monthly', 'annual']),
    acceptTerms: t.bool({ required: true }),
    // a hospital group: the first branch is this signup; more branches are added in the group console
    group: t.obj({ name: t.str({ required: true, min: 3, max: 120, label: 'Group name', plain: true }), branchName: t.str({ required: true, min: 2, max: 80, label: 'First branch name', plain: true }) }),
  });
  if (!b.acceptTerms) throw bad('Please accept the terms and the data processing agreement');
  if (b.group && (b.type === 'hmo' || !require('../lib/settings').feature('groups'))) throw bad('Groups with branches are not available for this provider type');
  const { org, owner } = await createOrg(Object.assign({}, b, { status: 'pending', name: b.group ? b.group.name + ' - ' + b.group.branchName : b.name }));
  let group = null;
  if (b.group) {
    group = await require('./groups').createGroup({ name: b.group.name, ownerUserId: owner.id, status: 'pending', contact: b.contact, createdBy: owner.id, mrnPrefix: org.mrnPrefix });
    await db.col('orgs').updateOne({ id: org.id }, { $set: { groupId: group.id, branchName: b.group.branchName } });
  }
  await audit(req, 'org.signup', { type: 'org', id: org.id, orgId: org.id, groupId: group ? group.id : null }, { orgType: org.type, group: !!group });
  try { await require('../lib/events').emit('org.signup', { orgId: org.id, groupId: group ? group.id : null, type: org.type, modules: org.modules }); } catch (e) { /* best effort */ }
  res.json({ ok: true, org: { id: org.id, name: org.name, code: org.code, status: org.status, modules: org.modules, subscription: org.subscription, groupId: group ? group.id : null }, group: group ? { id: group.id, name: group.name, code: group.code } : null,
    message: 'Thank you. The MediCore team will review and approve your provider, usually within one working day.' + (group ? ' After approval, sign in to the group console to add your other branches.' : '') });
}));

/* -------- public: build-your-own package pricing -------- */
router.get('/pricing', ah(async (req, res) => {
  const S = require('../lib/settings'); const pr = S.get('pricing', S.DEFAULTS.pricing);
  res.json({ currency: 'NGN', period: pr.period, baseKobo: pr.baseKobo, baseIncludes: pr.baseIncludes, modulesKobo: pr.modulesKobo, bundleDiscounts: pr.bundleDiscounts, seatsIncluded: pr.seatsIncluded, extraSeatKobo: pr.extraSeatKobo, annualMonthsCharged: pr.annualMonthsCharged, trialDays: pr.trialDays,
    bankChargePerPaymentKobo: S.get('process.billing.bankChargeKobo', 220000), modules: Object.fromEntries(Object.entries(MODULES).map(([k, m]) => [k, { label: m.label, desc: m.desc, requires: m.requires || [] }])), orgTypes: ORG_TYPES });
}));
router.post('/pricing/quote', ah(async (req, res) => {
  const b = body(req, { type: t.enum(Object.keys(ORG_TYPES)), modules: t.arr(t.enum(Object.keys(MODULES)), { max: 12 }), seats: t.int({ min: 1, max: 2000 }), period: t.enum(['monthly', 'annual']) });
  const mods = b.type === 'hmo' ? ['payer'] : [...new Set(['frontdesk', 'hmo'].concat((b.modules || []).filter(m => m !== 'payer')))];
  if (mods.includes('delivery') && !mods.includes('pharmacy') && !mods.includes('lab')) throw bad('Delivery needs the pharmacy or lab app');
  res.json(quote(mods, { seats: b.seats, period: b.period, type: b.type }));
}));

/* -------- public: plans (bundles, kept for HQ presets) -------- */
router.get('/plans', ah(async (req, res) => {
  await ensurePlans();
  const plans = await db.col('plans').find({ active: { $ne: false } }, { sort: { priceKobo: 1 } });
  res.json(plans.map(p => ({ key: p.id, label: p.label, orgTypes: p.orgTypes, priceKobo: p.priceKobo, period: p.period, currency: p.currency, modules: p.modules, seats: p.seats })));
}));

/* -------- public: provider directory (what patients choose from) -------- */
router.get('/directory', ah(async (req, res) => {
  const q = query(req, { type: t.enum(Object.keys(ORG_TYPES)), module: t.enum(Object.keys(MODULES)), q: t.str({ max: 60 }), lat: t.lat(), lng: t.lng(), limit: t.int({ min: 1, max: 100 }) });
  const filter = { status: 'active', type: { $ne: 'hmo' }, 'settings.marketplace': { $ne: false } };
  if (q.type) filter.type = q.type;
  // provider mode: inside the patient app, "find care" lists the patient's own provider (all its branches)
  if (req.ctx && req.ctx.kind === 'patient') { const sc = await require('./patients').patientScope(req); if (sc) { filter.id = { $in: sc }; delete filter['settings.marketplace']; } }
  if (q.module) filter.modules = q.module;
  let rows = await db.col('orgs').find(filter, { limit: 500 });
  if (q.q) { const s = q.q.toLowerCase(); rows = rows.filter(o => o.name.toLowerCase().includes(s) || ((o.location || {}).area || '').toLowerCase().includes(s)); }
  const from = q.lat != null && q.lng != null ? { lat: q.lat, lng: q.lng } : null;
  let out = rows.map(o => publicOrg(o, from));
  if (from) out.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)); else out.sort((a, b) => a.name.localeCompare(b.name));
  res.json(out.slice(0, q.limit || 50));
}));
router.get('/directory/hmos', ah(async (req, res) => {
  const rows = await db.col('orgs').find({ status: 'active', type: 'hmo' });
  res.json(rows.map(o => ({ id: o.id, name: o.name, code: o.code })));
}));
router.get('/directory/:id', ah(async (req, res) => {
  const o = await db.col('orgs').findOne({ id: param(req, 'id'), status: 'active' });
  if (!o || o.type === 'hmo') throw notFound('Provider not found');
  if (req.ctx && req.ctx.kind === 'patient' && !(await require('./patients').patientCanUse(req, o.id))) throw notFound('Provider not found');
  const services = await db.col('services').find({ orgId: o.id, active: { $ne: false }, public: { $ne: false } }, { sort: { category: 1, name: 1 } });
  res.json(Object.assign(publicOrg(o), { services: services.map(s => ({ code: s.code, name: s.name, category: s.category, priceKobo: s.priceKobo })) }));
}));

/* -------- admin: provider settings -------- */
const adminOnly = A.requireStaff({ perm: 'admin.settings' });
router.get('/admin/org', A.requireStaff({ anyPerm: ['admin.settings', 'admin.staff', 'admin.reports'] }), ah(async (req, res) => {
  const o = req.ctx.org;
  const g = o.groupId ? await db.col('groups').findOne({ id: o.groupId }) : null;
  res.json({ id: o.id, name: o.name, type: o.type, code: o.code, status: o.status, modules: o.modules, allowedModules: allowedModules(o.type), planModules: o.plan ? ((await db.col('plans').findOne({ id: o.plan.key })) || {}).modules || [] : [],
    settings: o.settings, contact: o.contact, location: o.location, kyc: o.kyc, plan: o.plan, subscription: o.subscription || null, quote: quote(o.modules, { seats: (o.subscription || {}).seats, period: (o.subscription || {}).period, type: o.type }),
    group: g ? { id: g.id, name: g.name, code: g.code } : null, branchName: o.branchName || null, isOwner: !!(req.ctx.membership && req.ctx.membership.isOwner),
    modulesManagedByGroup: !!g && !require('../lib/settings').get('process.branches.branchAdminsManageModules', false),
    settlement: o.settlement ? Object.assign({}, o.settlement, { accountNumber: o.settlement.accountNumber ? '******' + String(o.settlement.accountNumber).slice(-4) : null }) : null,
    canConvertToGroup: !g && o.type !== 'hmo' && !!(req.ctx.membership && req.ctx.membership.isOwner) && require('../lib/settings').feature('groups') });
}));
router.patch('/admin/org', adminOnly, ah(async (req, res) => {
  const b = body(req, {
    name: t.str({ min: 3, max: 120 }),
    contact: t.obj({ phone: t.phone(), email: t.email(), address: t.str({ max: 300 }) }),
    location: t.obj({ lat: t.lat(), lng: t.lng(), area: t.str({ max: 80 }), city: t.str({ max: 80 }), state: t.str({ max: 80 }) }),
    settings: t.obj({ requireClockIn: t.bool(), strictGeofence: t.bool(), geofenceM: t.int({ min: 50, max: 5000 }), twoStepLabVerify: t.bool(), deliveryFeeKobo: t.money({ max: naira(50000) }), selfClaimDeliveries: t.bool(), marketplace: t.bool(), acceptsWalkIns: t.bool(), openingHours: t.str({ max: 120 }),
      acceptsPatientApplications: t.bool(), networkListed: t.bool(), acceptsReferrals: t.bool(), acceptsOnlineBooking: t.bool(), applicationsNeedApproval: t.bool(), payBeforeVideo: t.bool(), referralsFromPartnersOnly: t.bool() }),
  });
  const set = {};
  if (b.name && req.ctx.org.groupId) throw forbidden('Your group administrator names the branches');
  if (b.name) set.name = b.name;
  if (b.contact) Object.entries(b.contact).forEach(([k, v]) => { set['contact.' + k] = v; });
  if (b.location) set.location = Object.assign({}, req.ctx.org.location || {}, b.location);
  if (b.settings) Object.entries(b.settings).forEach(([k, v]) => { set['settings.' + k] = v; });
  if (!Object.keys(set).length) throw bad('Nothing to change');
  const org = await db.col('orgs').findOneAndUpdate({ id: req.ctx.org.id }, { $set: set });
  await audit(req, 'org.settings', { type: 'org', id: org.id }, { fields: Object.keys(set) });
  res.json({ ok: true });
}));
/* switch optional modules on or off, within what the plan includes */
router.post('/admin/org/modules', adminOnly, ah(async (req, res) => {
  const b = body(req, { module: t.enum(Object.keys(MODULES), { required: true }), enabled: t.bool({ required: true }), confirmPriceKobo: t.money({ max: 1e12 }) });
  const o = req.ctx.org; const S = require('../lib/settings');
  if (o.groupId && !S.get('process.branches.branchAdminsManageModules', false)) throw forbidden('Your group manages the apps and subscription of every branch. Ask your group administrator.');
  if (!allowedModules(o.type).includes(b.module)) throw bad('That app is not available for this type of provider');
  if (b.enabled && o.subscription && ['past_due', 'cancelled'].includes(o.subscription.status)) throw forbidden('Your subscription payment is overdue. Settle it before adding apps.');
  if (!b.enabled && MODULES[b.module].always) throw bad('That app is part of every package');
  const mods = new Set(o.modules); if (b.enabled) mods.add(b.module); else mods.delete(b.module);
  if (!b.enabled && b.module === 'pharmacy' && !mods.has('lab')) mods.delete('delivery');
  if (mods.has('delivery') && !mods.has('pharmacy') && !mods.has('lab')) throw bad('Delivery needs the pharmacy or lab app');
  const q = quote([...mods], { seats: (o.subscription || {}).seats, period: (o.subscription || {}).period, type: o.type });
  // first call returns the new price; the admin confirms it by sending it back
  if (b.confirmPriceKobo !== q.monthlyKobo) return res.json({ needsConfirm: true, quote: q, currentMonthlyKobo: (o.subscription || {}).monthlyKobo || 0 });
  if (!S.get('pricing.selfServeModules', true, o)) {
    const support = require('./support');
    const tk = await support.createTicket({ org: o, user: req.ctx.user, category: 'billing_subscription', priority: 'normal', subject: (b.enabled ? 'Add ' : 'Remove ') + MODULES[b.module].label, text: 'Requested from the admin console. New monthly price: NGN ' + (q.monthlyKobo / 100).toLocaleString() });
    await audit(req, 'org.module_request', { type: 'org', id: o.id }, b);
    return res.json({ requested: true, ticket: tk.number, message: 'Your request has been sent to MediCore. We will switch it on after confirming your subscription.' });
  }
  const sub = Object.assign({}, o.subscription || {}, { modules: q.modules, monthlyKobo: q.monthlyKobo, totalKobo: q.totalKobo, quotedAt: Date.now() });
  await db.col('orgs').updateOne({ id: o.id }, { $set: { modules: [...mods], subscription: sub } });
  await audit(req, 'org.module', { type: 'org', id: o.id }, { module: b.module, enabled: b.enabled, monthlyKobo: q.monthlyKobo });
  res.json({ ok: true, modules: [...mods], subscription: sub });
}));

/* where this provider's online payments settle (gateway subaccount and bank account) */
router.patch('/admin/org/settlement', A.requireStaff({ perm: 'admin.finance' }), ah(async (req, res) => {
  const o = req.ctx.org;
  if (o.groupId) throw forbidden('Your group finance team sets the settlement account for each branch');
  const b = body(req, require('./groups').settlementRules);
  await db.col('orgs').updateOne({ id: o.id }, { $set: { settlement: Object.assign({}, o.settlement || {}, b, { updatedAt: Date.now(), updatedBy: req.ctx.user.id }) } });
  await audit(req, 'org.settlement', { type: 'org', id: o.id }, { bankName: b.bankName || null, last4: b.accountNumber ? b.accountNumber.slice(-4) : null });
  res.json({ ok: true });
}));

/* -------- price list (services) -------- */
const CATS = ['consultation', 'video', 'procedure', 'lab', 'drug', 'delivery', 'ambulance', 'registration', 'other'];
router.get('/services', A.requireStaff({}), ah(async (req, res) => {
  res.json(await db.col('services').find({ orgId: req.ctx.org.id }, { sort: { category: 1, name: 1 } }));
}));
router.post('/services', adminOnly, ah(async (req, res) => {
  const b = body(req, { code: t.str({ required: true, max: 24, upper: true, pattern: /^[A-Za-z0-9-_.]+$/ }), name: t.str({ required: true, max: 120 }), category: t.enum(CATS, { required: true }), priceKobo: t.money({ required: true, min: 0, max: naira(50000000) }), hmoCode: t.str({ max: 30 }), public: t.bool() });
  const s = Object.assign({ id: id('svc'), orgId: req.ctx.org.id, active: true, createdAt: Date.now() }, b);
  try { await db.col('services').insertOne(s); } catch (e) { if (e.code === 11000) throw conflict('A service with that code already exists'); throw e; }
  await audit(req, 'service.create', { type: 'service', id: s.id }, { code: s.code, priceKobo: s.priceKobo });
  res.json(s);
}));
router.patch('/services/:id', adminOnly, ah(async (req, res) => {
  const b = body(req, { name: t.str({ max: 120 }), category: t.enum(CATS), priceKobo: t.money({ min: 0, max: naira(50000000) }), hmoCode: t.str({ max: 30 }), active: t.bool(), public: t.bool() });
  const s = await db.col('services').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id }, { $set: b });
  if (!s) throw notFound('Service not found');
  await audit(req, 'service.update', { type: 'service', id: s.id }, b);
  res.json(s);
}));

/** look up a price-list item for this org, used by billing in every module */
async function service(orgId, code) { return db.col('services').findOne({ orgId, code, active: { $ne: false } }); }
async function getOrg(orgId) { return db.col('orgs').findOne({ id: orgId }); }

module.exports = { name: 'orgs', router, quote, subscriptionFor, createOrg, publicOrg, nextNumber, service, getOrg, ensurePlans, DEFAULT_PLANS, DEFAULT_SETTINGS, CATS };
