'use strict';
/*
 * Hospital groups: one company that runs several branches.
 *
 *   group   { id, name, code, status, ownerUserId, mrnPrefix, contact, logoUrl, settings, subscription }
 *   branch  an ordinary provider (org) with groupId and branchName. Every service module keeps working per
 *           branch, unchanged: staff, queues, stock, bills and reports belong to the branch.
 *
 * Two levels of administration:
 *   Group console (app 'group', /api/group/*)   the company's head office: every branch, staff in every branch,
 *                                                 consolidated subscription, reports across branches, shared price lists.
 *   Branch admin  (app 'admin', /api/admin/*)   one branch: its staff, settings and price list. Apps and subscription
 *                                                 are managed by the group (process.branches.branchAdminsManageModules).
 *
 * Patients: the group is one data controller, so a patient registered at one branch is a patient of every branch
 * (patients.js linkOf), with one group-wide record number.
 * A standalone provider becomes a group with POST /api/admin/org/convert-to-group (owner only).
 */
const express = require('express');
const db = require('../db');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param } = require('../lib/http');
const A = require('../lib/auth');
const S = require('../lib/settings');
const { ROLES, PERMS, GROUP_ROLES, MODULES, ORG_TYPES, allowedModules, rolesForModules, permsFor } = require('../lib/roles');
const { id, now, naira } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify, sms } = require('../lib/notify');
const orgs = require('./orgs');

db.index('groups', ['code'], { unique: true });
db.index('groups', ['status']);
db.index('orgs', ['groupId']);

const router = express.Router();
const G = perm => A.requireGroup(perm);

async function uniqueGroupCode(name) {
  const base = (name || 'GRP').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5) || 'GRP';
  for (let i = 0; i < 20; i++) { const code = base + (i === 0 ? 'G' : String(Math.floor(100 + Math.random() * 900))); if (!(await db.col('groups').findOne({ code })) && !(await db.col('orgs').findOne({ code }))) return code; }
  return base + Date.now().toString(36).toUpperCase();
}

/** create a group and make `userId` its owner */
async function createGroup({ name, ownerUserId, status, contact, createdBy, mrnPrefix }) {
  const code = await uniqueGroupCode(name);
  const g = { id: id('grp'), name, code, status: status || 'pending', ownerUserId, mrnPrefix: mrnPrefix || code.slice(0, 4), contact: contact || {}, logoUrl: '', settings: {}, createdAt: now(), createdBy: createdBy || ownerUserId };
  await db.col('groups').insertOne(g);
  await db.col('group_members').insertOne({ id: id('gm'), userId: ownerUserId, groupId: g.id, role: 'group_owner', isOwner: true, status: 'active', createdAt: now(), createdBy: createdBy || ownerUserId });
  return g;
}

/** a group's consolidated monthly price: every branch's own package, then the multi-branch discount */
function groupQuote(branches) {
  const live = branches.filter(b => !['rejected', 'removed'].includes(b.status));
  const lines = live.map(b => { const sub = b.subscription || {}; const q = orgs.quote(b.modules, { seats: sub.seats, period: sub.period, type: b.type }); return { orgId: b.id, name: b.branchName || b.name, status: b.status, modules: b.modules, seats: q.seats.requested, monthlyKobo: q.monthlyKobo }; });
  const subtotal = lines.filter(l => l.status === 'active' || l.status === 'pending').reduce((s, l) => s + l.monthlyKobo, 0);
  const counted = lines.filter(l => l.status === 'active' || l.status === 'pending').length;
  const disc = (S.get('pricing.branchDiscounts', S.DEFAULTS.pricing.branchDiscounts) || []).filter(d => counted >= d.minBranches).sort((a, b) => b.percent - a.percent)[0];
  const discountKobo = disc ? Math.round(subtotal * disc.percent / 100) : 0;
  return { currency: 'NGN', branches: lines, branchCount: counted, subtotalKobo: subtotal, discount: disc ? { percent: disc.percent, kobo: discountKobo, minBranches: disc.minBranches } : null, monthlyKobo: subtotal - discountKobo, bankChargePerPaymentKobo: S.get('process.billing.bankChargeKobo', 220000) };
}
async function branchesOf(groupId, extra) { return db.col('orgs').find(Object.assign({ groupId }, extra || {}), { sort: { createdAt: 1 } }); }
async function refreshGroupSubscription(groupId) {
  const q = groupQuote(await branchesOf(groupId));
  await db.col('groups').updateOne({ id: groupId }, { $set: { subscription: { monthlyKobo: q.monthlyKobo, subtotalKobo: q.subtotalKobo, discount: q.discount, branchCount: q.branchCount, quotedAt: now() } } });
  return q;
}
async function loadBranch(req, name = 'id') {
  const o = await db.col('orgs').findOne({ id: param(req, name), groupId: req.ctx.group.id });
  if (!o) throw notFound('Branch not found');
  return o;
}
function branchRow(o) {
  return { id: o.id, name: o.name, branchName: o.branchName || o.name, type: o.type, typeLabel: (ORG_TYPES[o.type] || {}).label || o.type, code: o.code, status: o.status, statusReason: o.statusReason || null, suspendedBy: o.suspendedBy || null,
    modules: o.modules, contact: o.contact || {}, location: o.location || null, settings: o.settings || {}, subscription: o.subscription || null, settlement: o.settlement ? Object.assign({}, o.settlement, { accountNumber: o.settlement.accountNumber ? '******' + String(o.settlement.accountNumber).slice(-4) : null }) : null, createdAt: o.createdAt };
}
function tempPassword() { return require('./staff').tempPassword(); }
async function findOrCreateUser({ name, email, phone }) {
  let user = email ? await db.col('users').findOne({ email }) : null;
  if (!user && phone) user = await db.col('users').findOne({ phone });
  let temp = null;
  if (!user) {
    temp = tempPassword();
    user = { id: id('usr'), name, passHash: await A.hashPassword(temp), status: 'active', mustChangePassword: true, createdAt: now() };
    if (email) user.email = email; if (phone) user.phone = phone;
    await db.col('users').insertOne(user);
  }
  return { user, temp };
}
async function memberRow(m, branchName) {
  const u = await db.col('users').findOne({ id: m.userId }, { projection: { name: 1, email: 1, phone: 1, lastLoginAt: 1, mustChangePassword: 1 } });
  return { id: m.id, userId: m.userId, orgId: m.orgId, branchName: branchName || null, name: u ? u.name : 'Unknown', email: u ? u.email || null : null, phone: u ? u.phone || null : null, role: m.role, roleLabel: (ROLES[m.role] || {}).label || m.role, title: m.title || null, status: m.status, isOwner: !!m.isOwner, lastLoginAt: u ? u.lastLoginAt || null : null, pendingPasswordChange: u ? !!u.mustChangePassword : false, createdAt: m.createdAt };
}

/* ================= profile ================= */
router.get('/group/profile', G(), ah(async (req, res) => {
  const g = req.ctx.group;
  res.json({ id: g.id, name: g.name, code: g.code, status: g.status, contact: g.contact || {}, logoUrl: g.logoUrl || '', settings: g.settings || {}, mrnPrefix: g.mrnPrefix, createdAt: g.createdAt, ownerUserId: g.ownerUserId });
}));
router.patch('/group/profile', G('group.settings'), ah(async (req, res) => {
  const b = body(req, { name: t.str({ min: 3, max: 120, plain: true }), contact: t.obj({ phone: t.phone(), email: t.email(), address: t.str({ max: 300, plain: true }) }), logoUrl: t.str({ max: 300, pattern: /^(https:\/\/|$)/ }),
    settings: t.obj({ acceptsPatientApplications: t.bool(), defaultOpeningHours: t.str({ max: 120 }) }) });
  const set = {};
  if (b.name) set.name = b.name; if (b.logoUrl !== undefined) set.logoUrl = b.logoUrl;
  if (b.contact) Object.entries(b.contact).forEach(([k, v]) => { set['contact.' + k] = v; });
  if (b.settings) Object.entries(b.settings).forEach(([k, v]) => { set['settings.' + k] = v; });
  if (!Object.keys(set).length) throw bad('Nothing to change');
  await db.col('groups').updateOne({ id: req.ctx.group.id }, { $set: set });
  if (b.settings && b.settings.acceptsPatientApplications !== undefined) await db.col('orgs').updateMany({ groupId: req.ctx.group.id }, { $set: { 'settings.acceptsPatientApplications': b.settings.acceptsPatientApplications } });
  await audit(req, 'group.profile', { type: 'group', id: req.ctx.group.id, orgId: null }, { fields: Object.keys(set) });
  res.json({ ok: true });
}));

/* ================= overview and reports ================= */
async function branchStats(o, since) {
  const bills = await db.col('bills').find({ orgId: o.id, createdAt: { $gte: since } }, { projection: { status: 1, paidKobo: 1, patientDueKobo: 1, hmo: 1 } });
  return {
    patients: await db.col('patient_links').count({ orgId: o.id, status: { $ne: 'removed' } }), newPatients: await db.col('patient_links').count({ orgId: o.id, createdAt: { $gte: since }, via: { $ne: 'branch' } }),
    staffActive: await db.col('memberships').count({ orgId: o.id, status: 'active' }), onDuty: await db.col('shifts').count({ orgId: o.id, out: null }),
    revenueKobo: bills.filter(b => b.status === 'paid').reduce((s, b) => s + (b.paidKobo || 0), 0), hmoCoveredKobo: bills.filter(b => b.hmo).reduce((s, b) => s + ((b.hmo || {}).coveredKobo || 0), 0),
    openBills: bills.filter(b => b.status === 'open').length, outstandingKobo: bills.filter(b => b.status === 'open').reduce((s, b) => s + ((b.patientDueKobo || 0) - (b.paidKobo || 0)), 0),
    appointments: await db.col('appointments').count({ orgId: o.id, createdAt: { $gte: since } }), encounters: await db.col('encounters').count({ orgId: o.id, startedAt: { $gte: since } }),
    labOrders: await db.col('lab_orders').count({ labOrgId: o.id, createdAt: { $gte: since } }), rxOrders: await db.col('rx_orders').count({ pharmacyOrgId: o.id, createdAt: { $gte: since } }),
    incidents: await db.col('incidents').count({ orgId: o.id, createdAt: { $gte: since } }),
    referralsIn: await db.col('referrals').count({ toOrgId: o.id, createdAt: { $gte: since } }), referralsOut: await db.col('referrals').count({ fromOrgId: o.id, createdAt: { $gte: since } }),
    pendingApplications: await db.col('patient_applications').count({ orgId: o.id, status: 'pending' }),
  };
}
router.get('/group/overview', G(), ah(async (req, res) => {
  const q = query(req, { days: t.int({ min: 1, max: 366 }) });
  const days = q.days || 30; const since = now() - days * 86400e3;
  const branches = await branchesOf(req.ctx.group.id, { status: { $nin: ['rejected', 'removed'] } });
  const rows = []; const total = {};
  for (const o of branches) {
    const st = await branchStats(o, since);
    Object.entries(st).forEach(([k, v]) => { total[k] = (total[k] || 0) + v; });
    rows.push(Object.assign({ id: o.id, name: o.branchName || o.name, status: o.status, type: o.type, modules: o.modules, area: (o.location || {}).area || null }, st));
  }
  const canMoney = req.ctx.perms.includes('group.finance') || req.ctx.perms.includes('group.reports');
  if (!canMoney) [...rows, total].forEach(r => { delete r.revenueKobo; delete r.outstandingKobo; delete r.hmoCoveredKobo; });
  res.json({ group: { id: req.ctx.group.id, name: req.ctx.group.name, code: req.ctx.group.code }, days, branches: rows, totals: total, subscription: req.ctx.perms.includes('group.finance') ? groupQuote(branches) : null });
}));
router.get('/group/reports/revenue', G('group.reports'), ah(async (req, res) => {
  const q = query(req, { days: t.int({ min: 1, max: 366 }) });
  const since = now() - (q.days || 30) * 86400e3;
  const branches = await branchesOf(req.ctx.group.id);
  const byDay = {}; const byBranch = {}; const byCat = {};
  for (const o of branches) {
    const bills = await db.col('bills').find({ orgId: o.id, status: 'paid', paidAt: { $gte: since } }, { projection: { paidKobo: 1, paidAt: 1, lines: 1 } });
    for (const b of bills) { const d = new Date(b.paidAt + 3600e3).toISOString().slice(0, 10); byDay[d] = byDay[d] || {}; byDay[d][o.id] = (byDay[d][o.id] || 0) + b.paidKobo; byBranch[o.id] = (byBranch[o.id] || 0) + b.paidKobo; (b.lines || []).forEach(l => { byCat[l.category] = (byCat[l.category] || 0) + l.totalKobo; }); }
  }
  res.json({ branches: branches.map(o => ({ id: o.id, name: o.branchName || o.name })), byDay: Object.entries(byDay).sort().map(([date, v]) => ({ date, byBranch: v, totalKobo: Object.values(v).reduce((a, b) => a + b, 0) })), byBranch, byCategory: byCat });
}));

/* ================= branches ================= */
router.get('/group/branches', G(), ah(async (req, res) => {
  const rows = await branchesOf(req.ctx.group.id);
  res.json({ branches: rows.map(branchRow), quote: req.ctx.perms.includes('group.finance') || req.ctx.perms.includes('group.branches') ? groupQuote(rows) : null, allowedModules: Object.fromEntries(Object.keys(ORG_TYPES).filter(k => k !== 'hmo').map(k => [k, allowedModules(k)])), modules: Object.fromEntries(Object.entries(MODULES).filter(([k]) => k !== 'payer').map(([k, m]) => [k, { label: m.label, desc: m.desc, always: !!m.always }])) });
}));
router.get('/group/branches/:id', G(), ah(async (req, res) => {
  const o = await loadBranch(req);
  const st = await branchStats(o, now() - 30 * 86400e3);
  if (!req.ctx.perms.includes('group.finance') && !req.ctx.perms.includes('group.reports')) { delete st.revenueKobo; delete st.outstandingKobo; delete st.hmoCoveredKobo; }
  res.json(Object.assign(branchRow(o), { stats: st, allowedModules: allowedModules(o.type), quote: orgs.quote(o.modules, { seats: (o.subscription || {}).seats, period: (o.subscription || {}).period, type: o.type }) }));
}));
const branchRules = {
  branchName: t.str({ required: true, min: 2, max: 80, label: 'Branch name', plain: true }), type: t.enum(Object.keys(ORG_TYPES).filter(k => k !== 'hmo')),
  modules: t.arr(t.enum(Object.keys(MODULES).filter(k => k !== 'payer')), { max: 12 }), seats: t.int({ min: 1, max: 2000 }),
  contact: t.obj({ phone: t.phone({ required: true }), email: t.email(), address: t.str({ required: true, max: 300, plain: true }) }, { required: true }),
  location: t.obj({ lat: t.lat(), lng: t.lng(), area: t.str({ max: 80 }), city: t.str({ max: 80 }), state: t.str({ max: 80 }) }),
  admin: t.obj({ name: t.str({ required: true, max: 100, plain: true }), email: t.email(), phone: t.phone() }),
  copyServicesFrom: t.id(),
};
/** create one branch under a group (used by the group console and by signup) */
async function createBranch({ group, b, by }) {
  const owner = await db.col('users').findOne({ id: group.ownerUserId });
  if (!owner) throw conflict('The group owner account is missing. Contact MediCore support.');
  const first = await db.col('orgs').findOne({ groupId: group.id });
  const type = b.type || (first ? first.type : 'hospital');
  const requireApproval = !!S.get('process.branches.requireApproval', false);
  const status = group.status === 'active' && !requireApproval ? 'active' : 'pending';
  const name = group.name + ' - ' + b.branchName;
  const { org } = await orgs.createOrg({ type, name, modules: b.modules, contact: b.contact, location: b.location || null, owner: { name: owner.name, email: owner.email, phone: owner.phone }, status, createdBy: by, seats: b.seats, period: (first && first.subscription && first.subscription.period) || 'monthly' });
  const set = { groupId: group.id, branchName: b.branchName, mrnPrefix: group.mrnPrefix };
  if (status === 'active') { const days = Number(S.get('pricing.trialDays', 30)) || 30; set.approvedAt = now(); set.approvedBy = 'group'; set['subscription.status'] = (first && first.subscription && first.subscription.status) || 'trial'; set['subscription.trialEnds'] = (first && first.subscription && first.subscription.trialEnds) || now() + days * 86400e3; }
  if (group.settings && group.settings.acceptsPatientApplications === false) set['settings.acceptsPatientApplications'] = false;
  await db.col('orgs').updateOne({ id: org.id }, { $set: set });
  let admin = null;
  if (b.admin && (b.admin.email || b.admin.phone)) {
    const { user, temp } = await findOrCreateUser(b.admin);
    if (user.id !== owner.id) {
      const m = { id: id('mem'), userId: user.id, orgId: org.id, role: 'admin', title: 'Branch administrator', extraPerms: [], removedPerms: [], status: 'active', isOwner: false, createdAt: now(), createdBy: by };
      await db.col('memberships').insertOne(m);
      admin = { membershipId: m.id, userId: user.id, name: user.name, tempPassword: temp };
      if (user.phone) await sms(user.phone, 'You are the administrator of ' + name + ' on MediCore.' + (temp ? ' Your group administrator will give you a temporary password.' : ' Sign in with your existing password.'));
    }
  }
  if (b.copyServicesFrom) await copyServices(group.id, b.copyServicesFrom, [org.id], false);
  await refreshGroupSubscription(group.id);
  return { org: await db.col('orgs').findOne({ id: org.id }), admin };
}
router.post('/group/branches', G('group.branches'), ah(async (req, res) => {
  const b = body(req, branchRules);
  if (b.admin && !b.admin.email && !b.admin.phone) throw bad('Give the branch administrator an email or a phone number');
  const r = await createBranch({ group: req.ctx.group, b, by: req.ctx.user.id });
  await audit(req, 'group.branch_create', { type: 'org', id: r.org.id, orgId: r.org.id }, { modules: r.org.modules, status: r.org.status });
  try { await require('../lib/events').emit('group.branch_created', { orgId: r.org.id, groupId: req.ctx.group.id, modules: r.org.modules }); } catch (e) { /* best effort */ }
  res.json({ branch: branchRow(r.org), admin: r.admin, note: r.org.status === 'pending' ? 'The branch is waiting for MediCore approval.' : (r.admin && r.admin.tempPassword ? 'Give the temporary password to the branch administrator privately. It will not be shown again.' : null) });
}));
router.patch('/group/branches/:id', G('group.branches'), ah(async (req, res) => {
  const o = await loadBranch(req);
  const b = body(req, { branchName: t.str({ min: 2, max: 80, plain: true }), contact: t.obj({ phone: t.phone(), email: t.email(), address: t.str({ max: 300, plain: true }) }),
    location: t.obj({ lat: t.lat(), lng: t.lng(), area: t.str({ max: 80 }), city: t.str({ max: 80 }), state: t.str({ max: 80 }) }),
    settings: t.obj({ openingHours: t.str({ max: 120 }), acceptsWalkIns: t.bool(), acceptsPatientApplications: t.bool(), requireClockIn: t.bool(), networkListed: t.bool(), acceptsReferrals: t.bool(), acceptsOnlineBooking: t.bool(), applicationsNeedApproval: t.bool(), payBeforeVideo: t.bool(), referralsFromPartnersOnly: t.bool() }), seats: t.int({ min: 1, max: 2000 }) });
  const set = {};
  if (b.branchName) { set.branchName = b.branchName; set.name = req.ctx.group.name + ' - ' + b.branchName; }
  if (b.contact) Object.entries(b.contact).forEach(([k, v]) => { set['contact.' + k] = v; });
  if (b.location) set.location = Object.assign({}, o.location || {}, b.location);
  if (b.settings) Object.entries(b.settings).forEach(([k, v]) => { set['settings.' + k] = v; });
  if (b.seats) { const q = orgs.quote(o.modules, { seats: b.seats, period: (o.subscription || {}).period, type: o.type }); Object.assign(set, { 'subscription.seats': b.seats, 'subscription.monthlyKobo': q.monthlyKobo, 'subscription.totalKobo': q.totalKobo }); }
  if (!Object.keys(set).length) throw bad('Nothing to change');
  const upd = await db.col('orgs').findOneAndUpdate({ id: o.id }, { $set: set });
  if (b.seats) await refreshGroupSubscription(req.ctx.group.id);
  await audit(req, 'group.branch_update', { type: 'org', id: o.id, orgId: o.id }, { fields: Object.keys(set) });
  res.json(branchRow(upd));
}));
router.post('/group/branches/:id/modules', G('group.branches'), ah(async (req, res) => {
  const o = await loadBranch(req);
  const b = body(req, { module: t.enum(Object.keys(MODULES), { required: true }), enabled: t.bool({ required: true }), confirmPriceKobo: t.money({ max: 1e12 }) });
  if (!allowedModules(o.type).includes(b.module)) throw bad('That app is not available for this type of branch');
  if (!b.enabled && MODULES[b.module].always) throw bad('That app is part of every package');
  if (b.enabled && o.subscription && ['past_due', 'cancelled'].includes(o.subscription.status)) throw forbidden('This branch\'s subscription is overdue. Settle it before adding apps.');
  const mods = new Set(o.modules); if (b.enabled) mods.add(b.module); else mods.delete(b.module);
  if (!b.enabled && b.module === 'pharmacy' && !mods.has('lab')) mods.delete('delivery');
  if (mods.has('delivery') && !mods.has('pharmacy') && !mods.has('lab')) throw bad('Delivery needs the pharmacy or lab app');
  const q = orgs.quote([...mods], { seats: (o.subscription || {}).seats, period: (o.subscription || {}).period, type: o.type });
  const all = await branchesOf(req.ctx.group.id);
  const after = groupQuote(all.map(x => (x.id === o.id ? Object.assign({}, x, { modules: [...mods] }) : x)));
  if (b.confirmPriceKobo !== q.monthlyKobo) return res.json({ needsConfirm: true, quote: q, currentMonthlyKobo: (o.subscription || {}).monthlyKobo || 0, groupMonthlyKobo: after.monthlyKobo });
  if (!S.get('pricing.selfServeModules', true, o)) {
    const tk = await require('./support').createTicket({ org: { id: req.ctx.group.id, name: req.ctx.group.name + ' (group)' }, user: req.ctx.user, category: 'billing_subscription', priority: 'normal', subject: (b.enabled ? 'Add ' : 'Remove ') + MODULES[b.module].label + ' at ' + (o.branchName || o.name), text: 'Requested from the group console. New monthly price for this branch: NGN ' + (q.monthlyKobo / 100).toLocaleString() });
    await audit(req, 'group.module_request', { type: 'org', id: o.id, orgId: o.id }, b);
    return res.json({ requested: true, ticket: tk.number, message: 'Your request has been sent to MediCore. We will switch it on after confirming your subscription.' });
  }
  const sub = Object.assign({}, o.subscription || {}, { modules: q.modules, monthlyKobo: q.monthlyKobo, totalKobo: q.totalKobo, quotedAt: now() });
  await db.col('orgs').updateOne({ id: o.id }, { $set: { modules: [...mods], subscription: sub } });
  const gq = await refreshGroupSubscription(req.ctx.group.id);
  await audit(req, 'group.branch_module', { type: 'org', id: o.id, orgId: o.id }, { module: b.module, enabled: b.enabled, monthlyKobo: q.monthlyKobo });
  res.json({ ok: true, modules: [...mods], subscription: sub, groupMonthlyKobo: gq.monthlyKobo });
}));
router.post('/group/branches/:id/suspend', G('group.branches'), ah(async (req, res) => {
  const o = await loadBranch(req);
  const b = body(req, { reason: t.str({ required: true, min: 5, max: 300 }) });
  const upd = await db.col('orgs').findOneAndUpdate({ id: o.id, status: 'active' }, { $set: { status: 'suspended', statusReason: b.reason, suspendedBy: 'group', suspendedAt: now() }, $push: { statusHistory: { at: now(), from: 'active', to: 'suspended', by: req.ctx.user.id, reason: b.reason, side: 'group' } } });
  if (!upd) throw conflict('Only an active branch can be suspended');
  await db.col('sessions').updateMany({ orgId: o.id, revoked: false }, { $set: { revoked: true, revokedAt: now(), revokedBy: 'branch_suspended' } });
  await refreshGroupSubscription(req.ctx.group.id);
  await audit(req, 'group.branch_suspend', { type: 'org', id: o.id, orgId: o.id }, { reason: b.reason });
  res.json(branchRow(upd));
}));
router.post('/group/branches/:id/reactivate', G('group.branches'), ah(async (req, res) => {
  const o = await loadBranch(req);
  if (o.status === 'suspended' && o.suspendedBy !== 'group') throw forbidden('MediCore suspended this branch. Contact MediCore support.');
  const upd = await db.col('orgs').findOneAndUpdate({ id: o.id, status: 'suspended', suspendedBy: 'group' }, { $set: { status: 'active', statusReason: null, suspendedBy: null }, $push: { statusHistory: { at: now(), from: 'suspended', to: 'active', by: req.ctx.user.id, side: 'group' } } });
  if (!upd) throw conflict('Only a branch the group suspended can be reactivated here');
  await refreshGroupSubscription(req.ctx.group.id);
  await audit(req, 'group.branch_reactivate', { type: 'org', id: o.id, orgId: o.id });
  res.json(branchRow(upd));
}));
/* where a branch's online payments settle (the payment gateway's subaccount / the branch's bank account) */
router.patch('/group/branches/:id/settlement', G('group.finance'), ah(async (req, res) => {
  const o = await loadBranch(req);
  const b = body(req, settlementRules);
  const upd = await db.col('orgs').findOneAndUpdate({ id: o.id }, { $set: { settlement: Object.assign({}, o.settlement || {}, b, { updatedAt: now(), updatedBy: req.ctx.user.id }) } });
  await audit(req, 'group.settlement', { type: 'org', id: o.id, orgId: o.id }, { bankName: b.bankName || null, last4: b.accountNumber ? b.accountNumber.slice(-4) : null });
  res.json(branchRow(upd));
}));
const settlementRules = { bankName: t.str({ max: 80 }), bankCode: t.str({ max: 12, pattern: /^[0-9A-Za-z]*$/ }), accountNumber: t.str({ max: 20, pattern: /^\d{10}$/, label: 'Account number (10 digits)' }), accountName: t.str({ max: 120 }), subaccount: t.str({ max: 80, label: 'Gateway subaccount code' }) };

/* ================= staff in every branch ================= */
router.get('/group/staff', G('group.staff'), ah(async (req, res) => {
  const q = query(req, { branchId: t.id(), q: t.str({ max: 60 }), role: t.str({ max: 40 }) });
  const branches = await branchesOf(req.ctx.group.id);
  const names = Object.fromEntries(branches.map(o => [o.id, o.branchName || o.name]));
  const ids = q.branchId ? (names[q.branchId] ? [q.branchId] : []) : branches.map(o => o.id);
  const f = { orgId: { $in: ids }, status: { $ne: 'removed' } }; if (q.role) f.role = q.role;
  const ms = ids.length ? await db.col('memberships').find(f, { sort: { createdAt: 1 }, limit: 3000 }) : [];
  let out = []; for (const m of ms) out.push(await memberRow(m, names[m.orgId]));
  if (q.q) { const s = q.q.toLowerCase(); out = out.filter(x => [x.name, x.email, x.phone, x.roleLabel].some(v => String(v || '').toLowerCase().includes(s))); }
  const rolesByBranch = Object.fromEntries(branches.map(o => [o.id, rolesForModules(o.modules).filter(r => r !== 'owner' && !r.startsWith('payer')).map(r => ({ key: r, label: ROLES[r].label, app: ROLES[r].app }))]));
  res.json({ staff: out, branches: branches.map(o => ({ id: o.id, name: o.branchName || o.name, status: o.status, seats: (o.subscription || {}).seats || null })), rolesByBranch });
}));
router.post('/group/staff', G('group.staff'), ah(async (req, res) => {
  const b = body(req, { branchId: t.id({ required: true }), name: t.str({ required: true, max: 100, plain: true }), email: t.email(), phone: t.phone(), role: t.str({ required: true, max: 40 }), title: t.str({ max: 60 }) });
  if (!b.email && !b.phone) throw bad('Give an email or a phone number so the person can sign in');
  const o = await db.col('orgs').findOne({ id: b.branchId, groupId: req.ctx.group.id });
  if (!o) throw notFound('Branch not found');
  if (!rolesForModules(o.modules).filter(r => r !== 'owner' && !r.startsWith('payer')).includes(b.role)) throw bad('That role is not available at this branch');
  const seats = o.subscription && o.subscription.seats;
  if (seats) { const used = await db.col('memberships').count({ orgId: o.id, status: 'active' }); if (used >= seats) throw forbidden('This branch\'s subscription covers ' + seats + ' staff accounts. Add seats to the branch first.'); }
  const { user, temp } = await findOrCreateUser(b);
  if (await db.col('memberships').findOne({ userId: user.id, orgId: o.id, status: { $ne: 'removed' } })) throw conflict('This person already works at that branch');
  const old = await db.col('memberships').findOne({ userId: user.id, orgId: o.id, status: 'removed' }); if (old) await db.col('memberships').deleteOne({ id: old.id });
  const m = { id: id('mem'), userId: user.id, orgId: o.id, role: b.role, title: b.title || null, extraPerms: [], removedPerms: [], status: 'active', isOwner: false, createdAt: now(), createdBy: req.ctx.user.id, addedBy: 'group' };
  await db.col('memberships').insertOne(m);
  await audit(req, 'group.staff_add', { type: 'membership', id: m.id, orgId: o.id }, { role: b.role, newAccount: !!temp });
  if (user.phone) await sms(user.phone, 'You have been added to ' + o.name + ' on MediCore as ' + ROLES[b.role].label + '.' + (temp ? ' Your administrator will give you a temporary password.' : ' Sign in with your existing MediCore password.'));
  res.json({ member: await memberRow(m, o.branchName || o.name), tempPassword: temp });
}));
router.patch('/group/staff/:id', G('group.staff'), ah(async (req, res) => {
  const b = body(req, { role: t.str({ max: 40 }), title: t.str({ max: 60 }), status: t.enum(['active', 'suspended', 'removed']), moveToBranchId: t.id() });
  const m = await db.col('memberships').findOne({ id: param(req, 'id') });
  const o = m && await db.col('orgs').findOne({ id: m.orgId, groupId: req.ctx.group.id });
  if (!m || !o || m.status === 'removed') throw notFound('Staff member not found');
  if (m.userId === req.ctx.user.id) throw forbidden('You cannot change your own access. Ask another group administrator.');
  if (m.isOwner) throw forbidden('The branch owner account belongs to the group owner and cannot be changed here.');
  const set = {};
  let target = o;
  if (b.moveToBranchId && b.moveToBranchId !== o.id) {
    target = await db.col('orgs').findOne({ id: b.moveToBranchId, groupId: req.ctx.group.id });
    if (!target) throw notFound('Branch not found');
    if (await db.col('memberships').findOne({ userId: m.userId, orgId: target.id, status: { $ne: 'removed' } })) throw conflict('This person already works at that branch');
    set.orgId = target.id;
  }
  const role = b.role || m.role;
  if (b.role || set.orgId) { if (!rolesForModules(target.modules).filter(r => r !== 'owner' && !r.startsWith('payer')).includes(role)) throw bad('That role is not available at ' + (target.branchName || target.name)); set.role = role; }
  if (b.title !== undefined) set.title = b.title; if (b.status) set.status = b.status;
  if (!Object.keys(set).length) throw bad('Nothing to change');
  const upd = await db.col('memberships').findOneAndUpdate({ id: m.id }, { $set: set });
  if ((b.status && b.status !== 'active') || set.orgId) await db.col('sessions').updateMany({ membershipId: m.id }, { $set: { revoked: true, revokedAt: now() } });
  if (b.status === 'removed' || set.orgId) await db.col('shifts').updateMany({ membershipId: m.id, out: null }, { $set: { out: now(), closedBy: set.orgId ? 'moved' : 'removed' } });
  await audit(req, 'group.staff_update', { type: 'membership', id: m.id, orgId: upd.orgId }, set);
  res.json(await memberRow(upd, target.branchName || target.name));
}));

/* ================= group administrators ================= */
router.get('/group/admins', G('group.admins'), ah(async (req, res) => {
  const rows = await db.col('group_members').find({ groupId: req.ctx.group.id, status: { $ne: 'removed' } }, { sort: { createdAt: 1 } });
  const out = [];
  for (const gm of rows) { const u = await db.col('users').findOne({ id: gm.userId }, { projection: { name: 1, email: 1, phone: 1, lastLoginAt: 1 } }); out.push({ id: gm.id, userId: gm.userId, name: u ? u.name : 'Unknown', email: u ? u.email || null : null, phone: u ? u.phone || null : null, role: gm.role, roleLabel: (GROUP_ROLES[gm.role] || {}).label, status: gm.status, isOwner: !!gm.isOwner, lastLoginAt: u ? u.lastLoginAt || null : null }); }
  res.json({ admins: out, roles: Object.entries(GROUP_ROLES).filter(([k]) => k !== 'group_owner').map(([k, r]) => ({ key: k, label: r.label, perms: r.perms })) });
}));
router.post('/group/admins', G('group.admins'), ah(async (req, res) => {
  const b = body(req, { name: t.str({ required: true, max: 100, plain: true }), email: t.email(), phone: t.phone(), role: t.enum(Object.keys(GROUP_ROLES).filter(k => k !== 'group_owner'), { required: true }) });
  if (!b.email && !b.phone) throw bad('Give an email or a phone number so the person can sign in');
  const { user, temp } = await findOrCreateUser(b);
  const ex = await db.col('group_members').findOne({ userId: user.id, groupId: req.ctx.group.id });
  if (ex && ex.status !== 'removed') throw conflict('This person is already a group administrator');
  if (ex) await db.col('group_members').deleteOne({ id: ex.id });
  const gm = { id: id('gm'), userId: user.id, groupId: req.ctx.group.id, role: b.role, isOwner: false, status: 'active', createdAt: now(), createdBy: req.ctx.user.id };
  await db.col('group_members').insertOne(gm);
  await audit(req, 'group.admin_add', { type: 'group_member', id: gm.id, orgId: null }, { role: b.role });
  res.json({ ok: true, admin: { id: gm.id, name: user.name, role: gm.role }, tempPassword: temp });
}));
router.patch('/group/admins/:id', G('group.admins'), ah(async (req, res) => {
  const b = body(req, { role: t.enum(Object.keys(GROUP_ROLES).filter(k => k !== 'group_owner')), status: t.enum(['active', 'suspended', 'removed']) });
  const gm = await db.col('group_members').findOne({ id: param(req, 'id'), groupId: req.ctx.group.id });
  if (!gm || gm.status === 'removed') throw notFound('Administrator not found');
  if (gm.userId === req.ctx.user.id) throw forbidden('You cannot change your own access');
  if (gm.isOwner) throw forbidden('The group owner can only be changed by MediCore support');
  const set = {}; if (b.role) set.role = b.role; if (b.status) set.status = b.status;
  if (!Object.keys(set).length) throw bad('Nothing to change');
  const upd = await db.col('group_members').findOneAndUpdate({ id: gm.id }, { $set: set });
  if (b.status && b.status !== 'active') await db.col('sessions').updateMany({ membershipId: gm.id }, { $set: { revoked: true, revokedAt: now() } });
  await audit(req, 'group.admin_update', { type: 'group_member', id: gm.id, orgId: null }, set);
  res.json({ ok: true, role: upd.role, status: upd.status });
}));

/* ================= subscription ================= */
router.get('/group/subscription', G('group.finance'), ah(async (req, res) => {
  const branches = await branchesOf(req.ctx.group.id);
  res.json(Object.assign(groupQuote(branches), { trialEnds: branches.reduce((m, b) => Math.max(m, (b.subscription || {}).trialEnds || 0), 0) || null, statuses: branches.map(b => ({ orgId: b.id, status: (b.subscription || {}).status || null })) }));
}));

/* ================= price lists shared across branches ================= */
async function copyServices(groupId, fromId, toIds, overwrite) {
  const from = await db.col('orgs').findOne({ id: fromId, groupId });
  if (!from) throw notFound('Source branch not found');
  const items = await db.col('services').find({ orgId: from.id, active: { $ne: false } });
  let created = 0, updated = 0, skipped = 0;
  for (const tid of toIds) {
    const to = await db.col('orgs').findOne({ id: tid, groupId });
    if (!to || to.id === from.id) continue;
    for (const s of items) {
      const ex = await db.col('services').findOne({ orgId: to.id, code: s.code });
      if (ex) { if (overwrite) { await db.col('services').updateOne({ id: ex.id }, { $set: { name: s.name, category: s.category, priceKobo: s.priceKobo, hmoCode: s.hmoCode || null, active: true } }); updated++; } else skipped++; continue; }
      await db.col('services').insertOne({ id: id('svc'), orgId: to.id, code: s.code, name: s.name, category: s.category, priceKobo: s.priceKobo, hmoCode: s.hmoCode || null, public: s.public !== false, active: true, createdAt: now(), copiedFrom: from.id });
      created++;
    }
  }
  return { created, updated, skipped, items: items.length };
}
router.get('/group/services', G('group.settings'), ah(async (req, res) => {
  const q = query(req, { branchId: t.id({ required: true }) });
  const o = await db.col('orgs').findOne({ id: q.branchId, groupId: req.ctx.group.id }); if (!o) throw notFound('Branch not found');
  res.json(await db.col('services').find({ orgId: o.id }, { sort: { category: 1, name: 1 } }));
}));
router.post('/group/services/copy', G('group.settings'), ah(async (req, res) => {
  const b = body(req, { fromBranchId: t.id({ required: true }), toBranchIds: t.arr(t.id(), { required: true, min: 1, max: 200 }), overwrite: t.bool() });
  const r = await copyServices(req.ctx.group.id, b.fromBranchId, b.toBranchIds, !!b.overwrite);
  await audit(req, 'group.services_copy', { type: 'group', id: req.ctx.group.id, orgId: null }, Object.assign({ from: b.fromBranchId, to: b.toBranchIds.length }, r));
  res.json(r);
}));

/* ================= audit, referrals, support ================= */
router.get('/group/audit', G('group.audit'), ah(async (req, res) => {
  const q = query(req, { branchId: t.id(), action: t.str({ max: 60 }), before: t.int({ min: 0 }), limit: t.int({ min: 1, max: 200 }) });
  const branches = await branchesOf(req.ctx.group.id);
  const ids = q.branchId ? branches.filter(o => o.id === q.branchId).map(o => o.id) : branches.map(o => o.id);
  const f = q.branchId ? { orgId: { $in: ids } } : { $or: [{ orgId: { $in: ids } }, { groupId: req.ctx.group.id }] };
  if (q.action) f.action = { $regex: '^' + q.action.replace(/[^a-z._]/gi, '') };
  if (q.before) f.at = { $lt: q.before };
  const names = Object.fromEntries(branches.map(o => [o.id, o.branchName || o.name]));
  const rows = await db.col('audit').find(f, { sort: { at: -1 }, limit: q.limit || 100 });
  res.json(rows.map(r => Object.assign({ branchName: names[r.orgId] || null }, r)));
}));
router.get('/group/referrals', G(), ah(async (req, res) => {
  if (!req.ctx.perms.includes('group.network') && !req.ctx.perms.includes('group.reports')) throw forbidden();
  const q = query(req, { status: t.str({ max: 20 }), limit: t.int({ min: 1, max: 300 }) });
  const ids = (await branchesOf(req.ctx.group.id)).map(o => o.id);
  const f = { $or: [{ fromOrgId: { $in: ids } }, { toOrgId: { $in: ids } }] }; if (q.status) f.status = q.status;
  const rows = await db.col('referrals').find(f, { sort: { createdAt: -1 }, limit: q.limit || 100 });
  // the group sees the flow between branches and partners, not clinical content
  res.json(rows.map(r => ({ id: r.id, number: r.number, fromOrgId: r.fromOrgId, fromOrgName: r.fromOrgName, toOrgId: r.toOrgId, toOrgName: r.toOrgName, urgency: r.urgency, service: r.service || null, status: r.status, createdAt: r.createdAt, decidedAt: r.decidedAt || null, direction: ids.includes(r.toOrgId) ? (ids.includes(r.fromOrgId) ? 'internal' : 'in') : 'out' })));
}));
router.get('/group/support', G('group.support'), ah(async (req, res) => {
  const rows = await db.col('support_tickets').find({ orgId: req.ctx.group.id }, { sort: { createdAt: -1 }, limit: 200 });
  res.json(rows.map(tk => Object.assign({}, tk, { messages: (tk.messages || []).filter(m => !m.internal) })));
}));
router.post('/group/support', G('group.support'), ah(async (req, res) => {
  const support = require('./support');
  const b = body(req, { category: t.enum(support.CATEGORIES, { required: true }), priority: t.enum(support.PRIORITIES, { default: 'normal' }), subject: t.str({ required: true, min: 5, max: 140 }), text: t.text({ required: true, max: 4000 }) });
  const tk = await support.createTicket({ org: { id: req.ctx.group.id, name: req.ctx.group.name + ' (group)' }, user: req.ctx.user, category: b.category, priority: b.priority, subject: b.subject, text: b.text });
  await db.col('support_tickets').updateOne({ id: tk.id }, { $set: { groupId: req.ctx.group.id } });
  await audit(req, 'group.support_create', { type: 'ticket', id: tk.id, orgId: null }, { category: b.category });
  res.json(tk);
}));
router.get('/group/support/:id', G('group.support'), ah(async (req, res) => {
  const tk = await db.col('support_tickets').findOne({ id: param(req, 'id'), orgId: req.ctx.group.id });
  if (!tk) throw notFound('Ticket not found');
  res.json(Object.assign({}, tk, { messages: (tk.messages || []).filter(m => !m.internal) }));
}));
router.post('/group/support/:id/close', G('group.support'), ah(async (req, res) => {
  const b = body(req, { rating: t.int({ min: 1, max: 5 }), comment: t.str({ max: 500 }) });
  const tk = await db.col('support_tickets').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.group.id, status: { $ne: 'closed' } }, { $set: { status: 'closed', closedAt: now(), rating: b.rating || null, ratingComment: b.comment || null, updatedAt: now() } });
  if (!tk) throw conflict('Ticket is already closed');
  await audit(req, 'group.support_close', { type: 'ticket', id: tk.id, orgId: null }, { rating: b.rating || null });
  res.json(Object.assign({}, tk, { messages: (tk.messages || []).filter(m => !m.internal) }));
}));
router.post('/group/support/:id/reply', G('group.support'), ah(async (req, res) => {
  const b = body(req, { text: t.text({ required: true, max: 4000 }) });
  const m = { id: id('tm'), at: now(), by: req.ctx.user.id, byName: req.ctx.user.name, side: 'provider', text: b.text, internal: false };
  const tk = await db.col('support_tickets').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.group.id, status: { $ne: 'closed' } }, { $push: { messages: m }, $set: { updatedAt: now(), status: 'in_progress' } });
  if (!tk) throw conflict('This ticket is closed. Open a new one.');
  res.json(tk);
}));

/* ================= a standalone provider becomes a group (branch admin side) ================= */
router.post('/admin/org/convert-to-group', A.requireStaff({ perm: 'admin.settings' }), ah(async (req, res) => {
  const o = req.ctx.org;
  if (!req.ctx.membership.isOwner) throw forbidden('Only the owner can turn this provider into a group with branches');
  if (o.groupId) throw conflict('This provider is already part of a group');
  if (o.type === 'hmo') throw bad('HMOs do not have branches here');
  if (!S.feature('groups')) throw forbidden('Groups with branches are not available yet');
  const b = body(req, { groupName: t.str({ min: 3, max: 120, plain: true }), branchName: t.str({ min: 2, max: 80, plain: true }) });
  const g = await createGroup({ name: b.groupName || o.name, ownerUserId: req.ctx.user.id, status: o.status, contact: o.contact, createdBy: req.ctx.user.id, mrnPrefix: o.mrnPrefix });
  await db.col('orgs').updateOne({ id: o.id }, { $set: { groupId: g.id, branchName: b.branchName || 'Main branch', name: g.name + ' - ' + (b.branchName || 'Main branch') } });
  await db.col('patient_links').updateMany({ orgId: o.id }, { $set: { groupId: g.id } });
  // record numbers continue from where the provider was
  const c = await db.col('counters').findOne({ id: 'mrn_' + o.id });
  if (c) await db.col('counters').findOneAndUpdate({ id: 'mrn_' + g.id }, { $set: { n: c.n }, $setOnInsert: { id: 'mrn_' + g.id } }, { upsert: true });
  await refreshGroupSubscription(g.id);
  await audit(req, 'org.convert_to_group', { type: 'org', id: o.id }, { groupId: g.id });
  res.json({ ok: true, group: { id: g.id, name: g.name, code: g.code }, message: 'Done. Sign in to the group console to add branches.' });
}));

module.exports = { name: 'groups', router, createGroup, createBranch, groupQuote, refreshGroupSubscription, branchesOf, settlementRules };
