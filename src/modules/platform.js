'use strict';
/*
 * MediCore HQ: the product owner's and developers' console (app 'hq').
 * Guards: A.requirePlatform(perm) with the perms in lib/roles PLATFORM_PERMS.
 *
 *  - Providers: approve / reject / suspend / reactivate, modules, plan, settings, owner password reset, audit
 *  - Plans, platform team, metrics
 *  - Privacy and compliance: patient privacy requests (deletion = anonymisation), breach register (72 h NDPC clock),
 *    consent lookup, data location and DPO settings
 *  - Audit search; demo accounts and demo reset (DEMO_MODE only)
 * Every write is audited with orgId = the target provider (or null for platform-wide actions).
 * (Platform configuration /api/hq/config/* and support tickets /api/hq/support are owned by core.)
 */
const express = require('express');
const db = require('../db');
const config = require('../config');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param } = require('../lib/http');
const A = require('../lib/auth');
const { ORG_TYPES, MODULES, PLATFORM_ROLES, allowedModules } = require('../lib/roles');
const { id, now, naira, maskEmail } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');

db.index('breaches', ['status', 'discoveredAt']);

const router = express.Router();
const G = perm => A.requirePlatform(perm);
const ORG_STATUSES = ['pending', 'active', 'suspended', 'rejected'];
const ORG_TRANSITIONS = { pending: ['active', 'rejected'], active: ['suspended'], suspended: ['active'], rejected: [] };
const PRIVACY_TRANSITIONS = { open: ['in_progress', 'responded', 'closed'], in_progress: ['responded', 'closed'], responded: ['closed', 'in_progress'], closed: [] };
const S = () => require('../lib/settings');
const trialDays = () => Number(S().get('pricing.trialDays', 30)) || 30;
const epoch = o => t.int(Object.assign({ min: 946684800000, max: 9999999999999 }, o));

function tempPassword() { return require('./staff').tempPassword(); }
const hq = (req, action, target, meta) => audit(req, 'hq.' + action, target, meta);

/* ================= hospital groups ================= */
router.get('/hq/groups', G('platform.read'), ah(async (req, res) => {
  const q = query(req, { status: t.enum(ORG_STATUSES), q: t.str({ max: 80 }) });
  const f = {}; if (q.status) f.status = q.status;
  let rows = await db.col('groups').find(f, { sort: { createdAt: -1 } });
  if (q.q) { const s2 = q.q.toLowerCase(); rows = rows.filter(g => g.name.toLowerCase().includes(s2) || (g.code || '').toLowerCase().includes(s2)); }
  const out = [];
  for (const g of rows) { const br = await db.col('orgs').find({ groupId: g.id }, { projection: { id: 1, status: 1 } }); out.push({ id: g.id, name: g.name, code: g.code, status: g.status, createdAt: g.createdAt, branches: br.length, activeBranches: br.filter(b => b.status === 'active').length, monthlyKobo: (g.subscription || {}).monthlyKobo || 0 }); }
  res.json(out);
}));
router.get('/hq/groups/:id', G('platform.read'), ah(async (req, res) => {
  const g = await db.col('groups').findOne({ id: param(req, 'id') }); if (!g) throw notFound('Group not found');
  const branches = await db.col('orgs').find({ groupId: g.id }, { sort: { createdAt: 1 } });
  const admins = await db.col('group_members').find({ groupId: g.id, status: { $ne: 'removed' } });
  const am = []; for (const a of admins) { const u = await db.col('users').findOne({ id: a.userId }, { projection: { name: 1, email: 1, phone: 1 } }); am.push({ id: a.id, role: a.role, status: a.status, isOwner: !!a.isOwner, name: u ? u.name : null, email: u ? u.email || null : null }); }
  res.json({ id: g.id, name: g.name, code: g.code, status: g.status, contact: g.contact || {}, createdAt: g.createdAt, statusReason: g.statusReason || null, branches: branches.map(orgRow), admins: am, quote: require('./groups').groupQuote(branches) });
}));
router.post('/hq/groups/:id/suspend', G('platform.orgs'), ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 5, max: 500 }) });
  const g = await db.col('groups').findOneAndUpdate({ id: param(req, 'id'), status: 'active' }, { $set: { status: 'suspended', statusReason: b.reason, suspendedAt: now() } });
  if (!g) throw conflict('Only an active group can be suspended');
  const ids = (await db.col('orgs').find({ groupId: g.id }, { projection: { id: 1 } })).map(o => o.id);
  const r = await db.col('sessions').updateMany({ $or: [{ orgId: { $in: ids } }, { orgId: g.id }], revoked: false }, { $set: { revoked: true, revokedAt: now(), revokedBy: 'group_suspended' } });
  await hq(req, 'group.suspend', { type: 'group', id: g.id, orgId: null, groupId: g.id }, { reason: b.reason });
  res.json({ ok: true, sessionsRevoked: r.modified });
}));
router.post('/hq/groups/:id/reactivate', G('platform.orgs'), ah(async (req, res) => {
  const g = await db.col('groups').findOneAndUpdate({ id: param(req, 'id'), status: 'suspended' }, { $set: { status: 'active', statusReason: null } });
  if (!g) throw conflict('Only a suspended group can be reactivated');
  await hq(req, 'group.reactivate', { type: 'group', id: g.id, orgId: null, groupId: g.id });
  res.json({ ok: true });
}));

/* ================= providers ================= */
function orgRow(o) {
  return { id: o.id, name: o.name, type: o.type, typeLabel: (ORG_TYPES[o.type] || {}).label || o.type, code: o.code, status: o.status, modules: o.modules, subscription: o.subscription || null, city: o.location ? o.location.city || null : null, area: o.location ? o.location.area || null : null, createdAt: o.createdAt, demo: !!o.demo, statusReason: o.statusReason || null,
    groupId: o.groupId || null, branchName: o.branchName || null };
}
async function loadOrg(req) { const o = await db.col('orgs').findOne({ id: param(req, 'id') }); if (!o) throw notFound('Provider not found'); return o; }

router.get('/hq/providers', G('platform.read'), ah(async (req, res) => {
  const q = query(req, { status: t.enum(ORG_STATUSES), type: t.enum(Object.keys(ORG_TYPES)), q: t.str({ max: 80 }), limit: t.int({ min: 1, max: 500 }), skip: t.int({ min: 0, max: 100000 }) });
  const f = {}; if (q.status) f.status = q.status; if (q.type) f.type = q.type;
  let rows = await db.col('orgs').find(f, { sort: { createdAt: -1 } });
  if (q.q) { const s = q.q.toLowerCase(); rows = rows.filter(o => o.name.toLowerCase().includes(s) || (o.code || '').toLowerCase().includes(s) || ((o.contact || {}).email || '').toLowerCase().includes(s)); }
  const total = rows.length; const skip = q.skip || 0;
  res.json({ total, rows: rows.slice(skip, skip + (q.limit || 100)).map(orgRow) });
}));
router.get('/hq/providers/:id', G('platform.read'), ah(async (req, res) => {
  const o = await loadOrg(req);
  const owner = o.ownerUserId ? await db.col('users').findOne({ id: o.ownerUserId }, { projection: { name: 1, email: 1, phone: 1, lastLoginAt: 1, mustChangePassword: 1, status: 1 } }) : null;
  const last = await db.col('audit').findOne({ orgId: o.id }, { sort: { at: -1 } });
  const sub = o.subscription || {};
  res.json(Object.assign(orgRow(o), {
    contact: o.contact || {}, location: o.location || null, kyc: o.kyc || {}, settings: o.settings || {}, overrides: o.overrides || null, allowedModules: allowedModules(o.type),
    quote: require('./orgs').quote(o.modules, { seats: sub.seats, period: sub.period, type: o.type }),
    owner: owner ? { userId: owner.id, name: owner.name, email: owner.email || null, phone: owner.phone || null, status: owner.status, lastLoginAt: owner.lastLoginAt || null, mustChangePassword: !!owner.mustChangePassword } : null,
    staffCount: await db.col('memberships').count({ orgId: o.id, status: 'active' }), patientsCount: await db.col('patient_links').count({ orgId: o.id, status: { $ne: 'removed' } }),
    lastActivityAt: last ? last.at : null, statusHistory: o.statusHistory || [],
  }));
}));
async function orgMove(req, from, to, set, action, meta) {
  const o0 = await loadOrg(req);
  const o = await db.col('orgs').findOneAndUpdate({ id: o0.id, status: from }, { $set: Object.assign({ status: to, statusChangedAt: now() }, set || {}), $push: { statusHistory: { at: now(), from, to, by: req.ctx.user.id, reason: (meta && meta.reason) || null } } });
  if (!o) throw conflict('This provider is ' + o0.status + '; that action is not possible now', 'wrong_state');
  await hq(req, 'org.' + action, { type: 'org', id: o.id, orgId: o.id }, meta);
  return o;
}
router.post('/hq/providers/:id/approve', G('platform.orgs'), ah(async (req, res) => {
  const o0 = await loadOrg(req);
  const days = trialDays();
  const sub = o0.subscription || require('./orgs').subscriptionFor(o0.modules, o0.type);
  const set = { approvedAt: now(), approvedBy: req.ctx.user.id, statusReason: null, subscription: Object.assign({}, sub, { status: 'trial', trialEnds: now() + days * 86400e3 }) };
  const o = await orgMove(req, 'pending', 'active', set, 'approve');
  // approving a group's first branch approves the group itself
  if (o.groupId) { const g = await db.col('groups').findOneAndUpdate({ id: o.groupId, status: 'pending' }, { $set: { status: 'active', approvedAt: now(), approvedBy: req.ctx.user.id } }); if (g) await hq(req, 'group.approve', { type: 'group', id: g.id, orgId: null, groupId: g.id }); await require('./groups').refreshGroupSubscription(o.groupId); }
  try { await require('../lib/events').emit('org.approved', { orgId: o.id, groupId: o.groupId || null }); } catch (e) { /* best effort */ }
  if (o.ownerUserId) await notify({ userId: o.ownerUserId, title: 'Your provider is live on MediCore', body: o.name + ' has been approved. Your ' + days + '-day trial has started.', kind: 'org_approved' });
  res.json(orgRow(o));
}));
router.post('/hq/providers/:id/reject', G('platform.orgs'), ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 5, max: 500 }) });
  const o = await orgMove(req, 'pending', 'rejected', { statusReason: b.reason }, 'reject', { reason: b.reason });
  if (o.ownerUserId) await notify({ userId: o.ownerUserId, title: 'Provider application not approved', body: b.reason, kind: 'org_rejected' });
  res.json(orgRow(o));
}));
router.post('/hq/providers/:id/suspend', G('platform.orgs'), ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 5, max: 500 }) });
  const o = await orgMove(req, 'active', 'suspended', { statusReason: b.reason, suspendedAt: now(), suspendedBy: 'hq' }, 'suspend', { reason: b.reason });
  const r = await db.col('sessions').updateMany({ orgId: o.id, revoked: false }, { $set: { revoked: true, revokedAt: now(), revokedBy: 'org_suspended' } });
  res.json(Object.assign(orgRow(o), { sessionsRevoked: r.modified }));
}));
router.post('/hq/providers/:id/reactivate', G('platform.orgs'), ah(async (req, res) => {
  res.json(orgRow(await orgMove(req, 'suspended', 'active', { statusReason: null, suspendedBy: null }, 'reactivate')));
}));
router.patch('/hq/providers/:id/modules', G('platform.orgs'), ah(async (req, res) => {
  const b = body(req, { modules: t.arr(t.enum(Object.keys(MODULES)), { required: true, max: 12 }) });
  const o = await loadOrg(req);
  const allowed = allowedModules(o.type);
  const notAllowed = b.modules.filter(m => !allowed.includes(m));
  if (notAllowed.length) throw bad('Not available for a ' + o.type + ': ' + notAllowed.join(', '));
  const mods = new Set(b.modules);
  allowed.filter(m => MODULES[m].always).forEach(m => mods.add(m));
  if (mods.has('delivery') && !mods.has('pharmacy') && !mods.has('lab')) throw bad('Delivery needs the pharmacy or lab module');
  const cur = o.subscription || {};
  const q = require('./orgs').quote([...mods], { seats: cur.seats, period: cur.period, type: o.type });
  const sub = Object.assign({}, cur, { modules: q.modules, monthlyKobo: cur.manualPrice ? cur.monthlyKobo : q.monthlyKobo, totalKobo: cur.manualPrice ? cur.totalKobo : q.totalKobo, quotedAt: now() });
  const upd = await db.col('orgs').findOneAndUpdate({ id: o.id }, { $set: { modules: [...mods], subscription: sub } });
  await hq(req, 'org.modules', { type: 'org', id: o.id, orgId: o.id }, { before: o.modules, after: upd.modules, monthlyKobo: sub.monthlyKobo });
  res.json(Object.assign(orgRow(upd), { quote: q }));
}));
/* subscription: status, seats, period; price follows the modular quote unless HQ sets a negotiated monthly price.
   applyPreset copies a plan preset's modules (within what the provider type allows) and seats. */
router.patch('/hq/providers/:id/subscription', G('platform.orgs'), ah(async (req, res) => {
  const b = body(req, { status: t.enum(['trial', 'active', 'past_due', 'cancelled']), seats: t.int({ min: 1, max: 100000 }), period: t.enum(['monthly', 'annual']), trialDays: t.int({ min: 1, max: 365 }),
    monthlyKobo: t.money({ max: naira(100000000) }), clearManualPrice: t.bool(), applyPreset: t.str({ max: 60 }) });
  if (!Object.keys(b).length) throw bad('Nothing to change');
  const o = await loadOrg(req);
  const orgs = require('./orgs');
  let mods = o.modules.slice(); const cur = Object.assign({}, o.subscription || {});
  if (b.applyPreset) {
    const p = await db.col('plans').findOne({ id: b.applyPreset, active: { $ne: false } });
    if (!p) throw notFound('Preset not found');
    if (!(p.orgTypes || []).includes(o.type)) throw bad('That preset is not for a ' + o.type);
    const allowed = allowedModules(o.type);
    mods = [...new Set(p.modules.filter(m => allowed.includes(m)).concat(allowed.filter(m => MODULES[m].always)))];
    if (mods.includes('delivery') && !mods.includes('pharmacy') && !mods.includes('lab')) mods = mods.filter(m => m !== 'delivery');
    if (!b.seats && p.seats) cur.seats = p.seats;
    cur.preset = p.id;
  }
  if (b.seats) cur.seats = b.seats; if (b.period) cur.period = b.period;
  if (b.status) { cur.status = b.status; if (b.status === 'trial') cur.trialEnds = now() + (b.trialDays || trialDays()) * 86400e3; if (b.status === 'active') cur.activatedAt = now(); }
  else if (b.trialDays) cur.trialEnds = now() + b.trialDays * 86400e3;
  const q = orgs.quote(mods, { seats: cur.seats, period: cur.period, type: o.type });
  if (b.clearManualPrice) cur.manualPrice = false;
  if (b.monthlyKobo != null) { cur.manualPrice = true; cur.monthlyKobo = b.monthlyKobo; cur.totalKobo = q.period === 'annual' ? b.monthlyKobo * (Number(S().get('pricing.annualMonthsCharged', 10)) || 10) : b.monthlyKobo; }
  else if (!cur.manualPrice) { cur.monthlyKobo = q.monthlyKobo; cur.totalKobo = q.totalKobo; }
  Object.assign(cur, { modules: q.modules, seats: q.seats.requested, period: q.period, quotedAt: now(), updatedBy: req.ctx.user.id });
  const upd = await db.col('orgs').findOneAndUpdate({ id: o.id }, { $set: { subscription: cur, modules: mods } });
  await hq(req, 'org.subscription', { type: 'org', id: o.id, orgId: o.id }, { status: cur.status, seats: cur.seats, period: cur.period, monthlyKobo: cur.monthlyKobo, manualPrice: !!cur.manualPrice, preset: b.applyPreset || null });
  res.json(Object.assign(orgRow(upd), { quote: q }));
}));
const SETTINGS_RULES = { requireClockIn: t.bool(), strictGeofence: t.bool(), geofenceM: t.int({ min: 50, max: 5000 }), twoStepLabVerify: t.bool(), deliveryFeeKobo: t.money({ max: naira(50000) }), selfClaimDeliveries: t.bool(), marketplace: t.bool(), acceptsWalkIns: t.bool(), openingHours: t.str({ max: 120 }) };
router.patch('/hq/providers/:id/settings', G('platform.orgs'), ah(async (req, res) => {
  const b = body(req, { settings: t.obj(SETTINGS_RULES, { required: true }) });
  const o = await loadOrg(req);
  const set = {}; Object.entries(b.settings).forEach(([k, v]) => { set['settings.' + k] = v; });
  if (!Object.keys(set).length) throw bad('Nothing to change');
  const upd = await db.col('orgs').findOneAndUpdate({ id: o.id }, { $set: set });
  await hq(req, 'org.settings', { type: 'org', id: o.id, orgId: o.id }, b.settings);
  res.json(Object.assign(orgRow(upd), { settings: upd.settings }));
}));
router.post('/hq/providers/:id/reset-owner-password', G('platform.support'), ah(async (req, res) => {
  const o = await loadOrg(req);
  const u = o.ownerUserId ? await db.col('users').findOne({ id: o.ownerUserId }) : null;
  if (!u) throw notFound('This provider has no owner account');
  if (u.platformRole) throw forbidden('This account is part of the MediCore team; it resets its own password');
  if (u.patientId) throw forbidden('This person also uses MediCore as a patient. Ask them to use "Forgot password".');
  const others = await db.col('memberships').count({ userId: u.id, orgId: { $ne: o.id }, status: 'active' });
  if (others > 0) throw forbidden('This person works at other providers too. Ask them to use "Forgot password".');
  const temp = tempPassword();
  await db.col('users').updateOne({ id: u.id }, { $set: { passHash: await A.hashPassword(temp), mustChangePassword: true } });
  await A.revokeAllForUser(u.id);
  await hq(req, 'org.owner_password_reset', { type: 'user', id: u.id, orgId: o.id });
  res.json({ tempPassword: temp, owner: { name: u.name, email: u.email ? maskEmail(u.email) : null }, note: 'Give this to the owner after verifying their identity. They must change it at next sign in. It will not be shown again.' });
}));
router.get('/hq/providers/:id/audit', G('platform.audit'), ah(async (req, res) => {
  const o = await loadOrg(req);
  const q = query(req, { before: epoch(), action: t.str({ max: 60 }), limit: t.int({ min: 1, max: 500 }) });
  const f = { orgId: o.id }; if (q.before) f.at = { $lt: q.before }; if (q.action) f.action = { $regex: '^' + q.action.replace(/[^a-z._]/gi, '') };
  res.json(await db.col('audit').find(f, { sort: { at: -1 }, limit: q.limit || 100 }));
}));

/* ================= plans ================= */
const planRules = req => ({ label: t.str({ required: req, max: 80 }), orgTypes: t.arr(t.enum(Object.keys(ORG_TYPES)), { required: req, min: 1, max: 6 }), priceKobo: t.money({ required: req, max: naira(100000000) }),
  period: t.enum(['monthly', 'yearly'], req ? { default: 'monthly' } : {}), modules: t.arr(t.enum(Object.keys(MODULES)), { required: req, min: 1, max: 12 }), seats: t.int({ required: req, min: 1, max: 100000 }) });
function checkPlanModules(p) { const bad1 = p.modules.filter(m => !p.orgTypes.some(tp => allowedModules(tp).includes(m))); if (bad1.length) throw bad('Modules not available for these provider types: ' + bad1.join(', ')); }
router.get('/hq/plans', G('platform.read'), ah(async (req, res) => {
  const plans = await db.col('plans').find({}, { sort: { priceKobo: 1 } });
  const out = []; for (const p of plans) out.push(Object.assign({ key: p.id, orgsUsingPreset: await db.col('orgs').count({ 'subscription.preset': p.id }) }, p));
  res.json(out);
}));
router.post('/hq/plans', G('platform.plans'), ah(async (req, res) => {
  const b = body(req, Object.assign({ key: t.str({ max: 40, lower: true, pattern: /^[a-z0-9_-]{3,40}$/ }) }, planRules(true)));
  checkPlanModules(b);
  const p = Object.assign({ id: b.key || ('plan_' + b.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24) + '_' + id('x').slice(2, 6).toLowerCase()), currency: 'NGN', active: true, createdAt: now(), createdBy: req.ctx.user.id }, b);
  delete p.key;
  try { await db.col('plans').insertOne(p); } catch (e) { if (e.code === 11000) throw conflict('A plan with that key exists'); throw e; }
  await hq(req, 'plan.create', { type: 'plan', id: p.id, orgId: null }, { priceKobo: p.priceKobo });
  res.json(Object.assign({ key: p.id }, p));
}));
router.patch('/hq/plans/:id', G('platform.plans'), ah(async (req, res) => {
  const b = body(req, planRules(false));
  if (!Object.keys(b).length) throw bad('Nothing to change');
  const cur = await db.col('plans').findOne({ id: param(req, 'id') });
  if (!cur) throw notFound('Plan not found');
  checkPlanModules(Object.assign({}, cur, b));
  const p = await db.col('plans').findOneAndUpdate({ id: cur.id }, { $set: Object.assign({ updatedAt: now() }, b) });
  await hq(req, 'plan.update', { type: 'plan', id: p.id, orgId: null }, b);
  res.json(Object.assign({ key: p.id, note: 'Presets only shape new assignments; providers keep their current subscription and price until a preset is applied to them again.' }, p));
}));
router.post('/hq/plans/:id/deactivate', G('platform.plans'), ah(async (req, res) => {
  const p = await db.col('plans').findOneAndUpdate({ id: param(req, 'id'), active: { $ne: false } }, { $set: { active: false, deactivatedAt: now() } });
  if (!p) throw conflict('Plan not found or already inactive');
  await hq(req, 'plan.deactivate', { type: 'plan', id: p.id, orgId: null });
  res.json(Object.assign({ key: p.id }, p));
}));
router.post('/hq/plans/:id/activate', G('platform.plans'), ah(async (req, res) => {
  const p = await db.col('plans').findOneAndUpdate({ id: param(req, 'id'), active: false }, { $set: { active: true } });
  if (!p) throw conflict('Plan not found or already active');
  await hq(req, 'plan.activate', { type: 'plan', id: p.id, orgId: null });
  res.json(Object.assign({ key: p.id }, p));
}));

/* ================= platform team ================= */
const teamView = u => ({ userId: u.id, name: u.name, email: u.email || null, role: u.platformRole || u.platformRoleSuspended || null, roleLabel: (PLATFORM_ROLES[u.platformRole || u.platformRoleSuspended] || {}).label || null, status: u.platformRole ? 'active' : 'suspended', lastLoginAt: u.lastLoginAt || null, pendingPasswordChange: !!u.mustChangePassword });
const owners = () => db.col('users').count({ platformRole: 'platform_owner', status: 'active' });
router.get('/hq/team', G('platform.users'), ah(async (req, res) => {
  const rows = await db.col('users').find({ $or: [{ platformRole: { $exists: true } }, { platformRoleSuspended: { $exists: true } }] }, { sort: { createdAt: 1 } });
  res.json({ team: rows.map(teamView), roles: Object.entries(PLATFORM_ROLES).map(([k, r]) => ({ key: k, label: r.label })) });
}));
router.post('/hq/team', G('platform.users'), ah(async (req, res) => {
  const b = body(req, { name: t.str({ required: true, max: 100 }), email: t.email({ required: true }), role: t.enum(Object.keys(PLATFORM_ROLES), { required: true }) });
  let u = await db.col('users').findOne({ email: b.email }); let temp = null;
  if (u) {
    if (u.platformRole || u.platformRoleSuspended) throw conflict('This person is already on the MediCore team');
    await db.col('users').updateOne({ id: u.id }, { $set: { platformRole: b.role } });
  } else {
    temp = tempPassword();
    u = { id: id('usr'), name: b.name, email: b.email, passHash: await A.hashPassword(temp), status: 'active', mustChangePassword: true, platformRole: b.role, createdAt: now(), createdBy: req.ctx.user.id };
    await db.col('users').insertOne(u);
  }
  await hq(req, 'team.invite', { type: 'user', id: u.id, orgId: null }, { role: b.role, newAccount: !!temp });
  res.json({ member: teamView(Object.assign(u, { platformRole: b.role })), tempPassword: temp, note: temp ? 'Give this temporary password privately. It must be changed at first sign-in and will not be shown again.' : 'This person already has a MediCore account and signs in with their own password.' });
}));
async function teamTarget(req) {
  const u = await db.col('users').findOne({ id: param(req, 'userId') });
  if (!u || !(u.platformRole || u.platformRoleSuspended)) throw notFound('Team member not found');
  if (u.id === req.ctx.user.id) throw forbidden('You cannot change your own role or access');
  return u;
}
async function guardLastOwner(u, losing) {
  if (losing && u.platformRole === 'platform_owner' && (await owners()) <= 1) throw conflict('This is the last platform owner. Make someone else an owner first.', 'last_owner');
}
async function afterOwnerChange(u, restore) {
  // two owners demoting each other at the same moment: never leave zero owners
  if ((await owners()) === 0) { await db.col('users').updateOne({ id: u.id }, restore); throw conflict('This is the last platform owner. Make someone else an owner first.', 'last_owner'); }
}
router.patch('/hq/team/:userId', G('platform.users'), ah(async (req, res) => {
  const b = body(req, { role: t.enum(Object.keys(PLATFORM_ROLES), { required: true }) });
  const u = await teamTarget(req);
  if (!u.platformRole) throw conflict('Reactivate this member before changing their role');
  await guardLastOwner(u, b.role !== 'platform_owner');
  await db.col('users').updateOne({ id: u.id, platformRole: u.platformRole }, { $set: { platformRole: b.role } });
  if (u.platformRole === 'platform_owner' && b.role !== 'platform_owner') await afterOwnerChange(u, { $set: { platformRole: 'platform_owner' } });
  await db.col('sessions').updateMany({ userId: u.id, app: 'hq' }, { $set: { revoked: true, revokedAt: now() } });
  await hq(req, 'team.role', { type: 'user', id: u.id, orgId: null }, { from: u.platformRole, to: b.role });
  res.json(teamView(Object.assign(u, { platformRole: b.role })));
}));
router.post('/hq/team/:userId/suspend', G('platform.users'), ah(async (req, res) => {
  const u = await teamTarget(req);
  if (!u.platformRole) throw conflict('Already suspended');
  await guardLastOwner(u, true);
  const r = await db.col('users').findOneAndUpdate({ id: u.id, platformRole: u.platformRole }, { $set: { platformRoleSuspended: u.platformRole, platformSuspendedAt: now() }, $unset: { platformRole: '' } });
  if (!r) throw conflict('This member changed; refresh and try again');
  if (u.platformRole === 'platform_owner') await afterOwnerChange(u, { $set: { platformRole: 'platform_owner' }, $unset: { platformRoleSuspended: '' } });
  await db.col('sessions').updateMany({ userId: u.id, app: 'hq' }, { $set: { revoked: true, revokedAt: now() } });
  await hq(req, 'team.suspend', { type: 'user', id: u.id, orgId: null });
  res.json(teamView(r));
}));
router.post('/hq/team/:userId/reactivate', G('platform.users'), ah(async (req, res) => {
  const u = await teamTarget(req);
  const r = await db.col('users').findOneAndUpdate({ id: u.id, platformRoleSuspended: { $exists: true } }, { $set: { platformRole: u.platformRoleSuspended }, $unset: { platformRoleSuspended: '', platformSuspendedAt: '' } });
  if (!r) throw conflict('This member is not suspended');
  await hq(req, 'team.reactivate', { type: 'user', id: u.id, orgId: null });
  res.json(teamView(r));
}));

/* ================= metrics ================= */
const dayOf = ts => new Date(ts + 3600e3).toISOString().slice(0, 10);
router.get('/hq/metrics', G('platform.read'), ah(async (req, res) => {
  const since = now() - 30 * 86400e3;
  const orgsAll = await db.col('orgs').find({}, { projection: { type: 1, status: 1, createdAt: 1 } });
  const byType = {}; const byStatus = {};
  orgsAll.forEach(o => { byType[o.type] = (byType[o.type] || 0) + 1; byStatus[o.status] = (byStatus[o.status] || 0) + 1; });
  const bills = await db.col('bills').find({ createdAt: { $gte: since } }, { projection: { status: 1, paidKobo: 1, totalKobo: 1, paidAt: 1, createdAt: 1, hmo: 1 } });
  const paid = bills.filter(b => b.status === 'paid');
  const pats = await db.col('patients').find({ createdAt: { $gte: since } }, { projection: { createdAt: 1 } });
  const incs = await db.col('incidents').find({ createdAt: { $gte: since } }, { projection: { createdAt: 1 } });
  const series = {};
  for (let i = 29; i >= 0; i--) series[dayOf(now() - i * 86400e3)] = { date: dayOf(now() - i * 86400e3), newPatients: 0, bills: 0, paidKobo: 0, incidents: 0, newProviders: 0 };
  const bump = (ts, k, v) => { const d = series[dayOf(ts)]; if (d) d[k] += v; };
  pats.forEach(p => bump(p.createdAt, 'newPatients', 1)); bills.forEach(b => bump(b.createdAt, 'bills', 1)); paid.forEach(b => bump(b.paidAt || b.createdAt, 'paidKobo', b.totalKobo));
  incs.forEach(x => bump(x.createdAt, 'incidents', 1)); orgsAll.filter(o => o.createdAt >= since).forEach(o => bump(o.createdAt, 'newProviders', 1));
  res.json({
    providers: { total: orgsAll.length, byType, byStatus, pending: byStatus.pending || 0 },
    patients: { total: await db.col('patients').count({ status: { $ne: 'removed' } }), new30d: pats.length, withAccount: await db.col('users').count({ patientId: { $exists: true }, status: 'active' }) },
    staff: { active: await db.col('memberships').count({ status: 'active' }), onDuty: await db.col('shifts').count({ out: null }) },
    bills30d: { count: bills.length, paidCount: paid.length, paidVolumeKobo: paid.reduce((s, b) => s + b.totalKobo, 0), hmoCoveredKobo: bills.filter(b => b.hmo).reduce((s, b) => s + (b.hmo.coveredKobo || 0), 0) },
    incidents: { total: await db.col('incidents').count({}), last30d: incs.length },
    prescriptions: { total: await db.col('prescriptions').count({}), last30d: await db.col('prescriptions').count({ createdAt: { $gte: since } }) },
    claims: { total: await db.col('claims').count({}), open: await db.col('claims').count({ status: { $in: ['submitted', 'under_review', 'queried', 'resubmitted'] } }), last30d: await db.col('claims').count({ submittedAt: { $gte: since } }) },
    labOrders: { total: await db.col('lab_orders').count({}) },
    support: await (async () => { const rows = await db.col('support_tickets').find({}, { projection: { status: 1, priority: 1 } }); const byStatus = {}; rows.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; }); return { total: rows.length, open: rows.filter(r => !['resolved', 'closed'].includes(r.status)).length, urgentOpen: rows.filter(r => !['resolved', 'closed'].includes(r.status) && r.priority === 'urgent').length, byStatus }; })(),
    subscriptions: await (async () => { const rows = await db.col('orgs').find({ status: 'active' }, { projection: { subscription: 1 } }); const by = {}; let mrr = 0; rows.forEach(o => { const st = (o.subscription || {}).status || 'none'; by[st] = (by[st] || 0) + 1; if (st === 'active') mrr += (o.subscription.monthlyKobo || 0); }); return { byStatus: by, activeMonthlyKobo: mrr }; })(),
    privacy: { openRequests: await db.col('privacy_requests').count({ status: { $ne: 'closed' } }), openBreaches: await db.col('breaches').count({ status: { $ne: 'closed' } }) },
    perDay: Object.values(series),
  });
}));

/* ================= audit ================= */
router.get('/hq/audit', G('platform.audit'), ah(async (req, res) => {
  const q = query(req, { orgId: t.id(), actorId: t.id(), patientId: t.id(), targetId: t.id(), action: t.str({ max: 60 }), before: epoch(), after: epoch(), limit: t.int({ min: 1, max: 500 }) });
  const f = {};
  ['orgId', 'actorId', 'patientId', 'targetId'].forEach(k => { if (q[k]) f[k] = q[k]; });
  if (q.action) f.action = { $regex: '^' + q.action.replace(/[^a-z._]/gi, '') };
  if (q.before || q.after) { f.at = {}; if (q.before) f.at.$lt = q.before; if (q.after) f.at.$gt = q.after; }
  res.json(await db.col('audit').find(f, { sort: { at: -1 }, limit: q.limit || 100 }));
}));

/* ================= privacy and compliance ================= */
router.get('/hq/privacy/settings', G('platform.privacy'), (req, res) => {
  res.json({ dataLocation: config.DATA_LOCATION, dpoEmail: config.DPO_EMAIL || null, privacyNoticeVersion: config.PRIVACY_NOTICE_VERSION, ndpcBreachHours: 72, requestResponseDays: 30, configuredBy: 'environment (DATA_LOCATION, DPO_EMAIL, PRIVACY_NOTICE_VERSION)' });
});
async function requestView(r) {
  const p = await db.col('patients').findOne({ id: r.patientId }, { projection: { firstName: 1, lastName: 1, status: 1 } });
  return Object.assign({}, r, { patientName: p ? p.firstName + ' ' + p.lastName : null, patientStatus: p ? p.status : null, overdue: r.status !== 'closed' && r.dueAt < now(), daysLeft: Math.ceil((r.dueAt - now()) / 86400e3) });
}
router.get('/hq/privacy/requests', G('platform.privacy'), ah(async (req, res) => {
  const q = query(req, { status: t.enum(Object.keys(PRIVACY_TRANSITIONS)), type: t.enum(['delete', 'correct', 'restrict', 'object']), limit: t.int({ min: 1, max: 500 }) });
  const f = {}; if (q.status) f.status = q.status; if (q.type) f.type = q.type;
  const rows = await db.col('privacy_requests').find(f, { sort: { at: 1 }, limit: q.limit || 200 });
  const out = []; for (const r of rows) out.push(await requestView(r));
  res.json(out);
}));
router.get('/hq/privacy/requests/:id', G('platform.privacy'), ah(async (req, res) => {
  const r = await db.col('privacy_requests').findOne({ id: param(req, 'id') });
  if (!r) throw notFound('Request not found');
  await hq(req, 'privacy.view', { type: 'privacy_request', id: r.id, patientId: r.patientId, orgId: null });
  res.json(await requestView(r));
}));
async function prMove(req, from, to, set, action, meta) {
  const rid = param(req, 'id');
  const r = await db.col('privacy_requests').findOneAndUpdate({ id: rid, status: { $in: from } }, { $set: Object.assign({ status: to, updatedAt: now() }, set || {}), $push: { history: { at: now(), to, by: req.ctx.user.id } } });
  if (!r) { const ex = await db.col('privacy_requests').findOne({ id: rid }); if (!ex) throw notFound('Request not found'); throw conflict('This request is ' + ex.status, 'wrong_state'); }
  await hq(req, 'privacy.' + action, { type: 'privacy_request', id: r.id, patientId: r.patientId, orgId: null }, meta);
  return requestView(r);
}
router.post('/hq/privacy/requests/:id/assign', G('platform.privacy'), ah(async (req, res) => {
  const b = body(req, { userId: t.id() });
  const uid = b.userId || req.ctx.user.id;
  const u = await db.col('users').findOne({ id: uid }, { projection: { platformRole: 1, name: 1 } });
  if (!u || !u.platformRole) throw bad('Assign to a member of the MediCore team');
  res.json(await prMove(req, ['open', 'in_progress', 'responded'], 'in_progress', { assignedTo: uid, assignedName: u.name }, 'assign', { assignedTo: uid }));
}));
router.post('/hq/privacy/requests/:id/respond', G('platform.privacy'), ah(async (req, res) => {
  const b = body(req, { response: t.text({ required: true, max: 2000 }) });
  const r = await prMove(req, ['open', 'in_progress'], 'responded', { response: b.response, respondedAt: now(), respondedBy: req.ctx.user.id }, 'respond');
  await notify({ patientId: r.patientId, title: 'Update on your privacy request', body: 'MediCore has responded to your request. Open Settings > Privacy to read it.', kind: 'privacy' });
  res.json(r);
}));
router.post('/hq/privacy/requests/:id/close', G('platform.privacy'), ah(async (req, res) => {
  const b = body(req, { outcome: t.enum(['completed', 'declined', 'withdrawn'], { required: true }), note: t.str({ max: 500 }) });
  res.json(await prMove(req, ['open', 'in_progress', 'responded'], 'closed', { outcome: b.outcome, closeNote: b.note || null, closedAt: now(), closedBy: req.ctx.user.id }, 'close', { outcome: b.outcome }));
}));
/** deletion = anonymisation; clinical records stay (legal retention) under the same patientId */
async function anonymisePatient(patientId, reason, requestId) {
  const p = await db.col('patients').findOne({ id: patientId });
  if (!p) throw notFound('Patient not found');
  await db.col('patients').updateOne({ id: p.id }, {
    $set: { firstName: 'Removed', lastName: 'Patient', email: null, address: null, homeLoc: null, nokName: null, nokPhone: null, status: 'removed', anonymisedAt: now(), retention: { reason, requestId, at: now(), note: 'Identity removed on request. Clinical, billing and audit records are retained under this id for legal and medical record retention.' } },
    $unset: { phone: '', ussdPinHash: '' } });
  let userAction = null;
  if (p.userId) {
    const u = await db.col('users').findOne({ id: p.userId });
    if (u) {
      const staff = await db.col('memberships').count({ userId: u.id, status: 'active' });
      if (staff || u.platformRole) { await db.col('users').updateOne({ id: u.id }, { $unset: { patientId: '' } }); userAction = 'unlinked_staff_account'; }
      else { await db.col('users').updateOne({ id: u.id }, { $set: { status: 'disabled', name: 'Removed patient', disabledAt: now(), disabledReason: 'privacy_deletion' }, $unset: { phone: '', email: '', patientId: '' } }); userAction = 'disabled'; }
      await A.revokeAllForUser(u.id);
    }
  }
  const links = await db.col('patient_links').updateMany({ patientId: p.id, status: { $ne: 'removed' } }, { $set: { status: 'removed', removedAt: now(), removedReason: 'privacy_deletion' } });
  await db.col('coverages').updateMany({ patientId: p.id }, { $set: { phone: null } });
  return { userAction, linksRemoved: links.modified };
}
router.post('/hq/privacy/requests/:id/execute-deletion', G('platform.privacy'), ah(async (req, res) => {
  const b = body(req, { retentionReason: t.str({ required: true, min: 5, max: 300, label: 'Retention reason' }) });
  const rid = param(req, 'id');
  const r = await db.col('privacy_requests').findOneAndUpdate({ id: rid, type: 'delete', status: { $in: ['open', 'in_progress', 'responded'] }, executedAt: { $exists: false } }, { $set: { executedAt: now(), executedBy: req.ctx.user.id, retentionReason: b.retentionReason } });
  if (!r) { const ex = await db.col('privacy_requests').findOne({ id: rid }); if (!ex) throw notFound('Request not found'); throw conflict(ex.type !== 'delete' ? 'Only deletion requests can be executed' : 'This deletion has already been executed or the request is closed', 'wrong_state'); }
  const out = await anonymisePatient(r.patientId, b.retentionReason, r.id);
  await db.col('privacy_requests').updateOne({ id: r.id }, { $set: { status: 'closed', outcome: 'completed', closedAt: now(), closedBy: req.ctx.user.id, deletionResult: out }, $push: { history: { at: now(), to: 'closed', by: req.ctx.user.id, action: 'anonymised' } } });
  await hq(req, 'privacy.anonymise', { type: 'patient', id: r.patientId, patientId: r.patientId, orgId: null }, Object.assign({ requestId: r.id }, out));
  res.json({ ok: true, requestId: r.id, patientId: r.patientId, result: out, retained: 'Clinical, billing and audit records are kept under the patient id for legal retention.' });
}));
router.get('/hq/privacy/consents/:patientId', G('platform.privacy'), ah(async (req, res) => {
  const pid = param(req, 'patientId');
  const p = await db.col('patients').findOne({ id: pid }, { projection: { consent: 1, status: 1 } });
  if (!p) throw notFound('Patient not found');
  const rows = await db.col('consents').find({ patientId: pid }, { sort: { at: -1 } });
  await hq(req, 'privacy.consents_view', { type: 'patient', id: pid, patientId: pid, orgId: null });
  res.json({ patientId: pid, status: p.status, current: p.consent || null, records: rows });
}));

/* breach register */
const BREACH_STATUS = ['open', 'contained', 'closed'];
function breachView(b) {
  const deadline = b.discoveredAt + 72 * 3600e3;
  return Object.assign({}, b, { ndpcDeadline: deadline, ndpcHoursLeft: b.ndpcNotifiedAt ? null : Math.round((deadline - now()) / 360000) / 10, ndpcOverdue: !b.ndpcNotifiedAt && now() > deadline, ndpcLate: !!b.ndpcNotifiedAt && b.ndpcNotifiedAt > deadline });
}
const breachRules = req => ({ title: t.str({ required: req, max: 160 }), discoveredAt: epoch({ required: req }), description: t.text({ required: req, max: 4000 }), affectedCount: t.int({ min: 0, max: 100000000 }), ndpcNotifiedAt: epoch(), subjectsNotifiedAt: epoch(), status: t.enum(BREACH_STATUS), actions: t.text({ max: 4000 }) });
router.get('/hq/privacy/breaches', G('platform.privacy'), ah(async (req, res) => {
  const rows = await db.col('breaches').find({}, { sort: { discoveredAt: -1 } });
  res.json(rows.map(breachView));
}));
router.post('/hq/privacy/breaches', G('platform.privacy'), ah(async (req, res) => {
  const b = body(req, breachRules(true));
  if (b.discoveredAt > now() + 60000) throw bad('Discovery time is in the future');
  const doc = Object.assign({ id: id('br'), status: 'open', affectedCount: null, ndpcNotifiedAt: null, subjectsNotifiedAt: null, createdAt: now(), createdBy: req.ctx.user.id }, b);
  await db.col('breaches').insertOne(doc);
  await hq(req, 'breach.create', { type: 'breach', id: doc.id, orgId: null }, { affectedCount: doc.affectedCount });
  res.json(breachView(doc));
}));
router.patch('/hq/privacy/breaches/:id', G('platform.privacy'), ah(async (req, res) => {
  const b = body(req, breachRules(false));
  if (!Object.keys(b).length) throw bad('Nothing to change');
  const cur = await db.col('breaches').findOne({ id: param(req, 'id') });
  if (!cur) throw notFound('Breach not found');
  if (cur.status === 'closed' && b.status !== 'open') throw conflict('This breach is closed. Reopen it (status open) to change it.');
  const doc = await db.col('breaches').findOneAndUpdate({ id: cur.id }, { $set: Object.assign({ updatedAt: now(), updatedBy: req.ctx.user.id }, b) });
  await hq(req, 'breach.update', { type: 'breach', id: doc.id, orgId: null }, { fields: Object.keys(b) });
  res.json(breachView(doc));
}));

/* ================= demo ================= */
router.get('/hq/demo/accounts', G('platform.demo'), ah(async (req, res) => {
  if (!config.DEMO_MODE) throw forbidden('Demo mode is off');
  res.json(require('../seed/demo').accounts());
}));
router.post('/hq/demo/reset', G('platform.demo'), ah(async (req, res) => {
  if (!config.DEMO_MODE) throw forbidden('Demo mode is off. Demo data can never be loaded on a live system.');
  const b = body(req, { confirm: t.str({ required: true, max: 20 }) });
  if (b.confirm !== 'RESET') throw bad('Send confirm: "RESET" to wipe and reload the demo data');
  await hq(req, 'demo.reset', { type: 'platform', id: null, orgId: null });
  const bootstrap = require('../bootstrap'); const demo = require('../seed/demo');
  await db.store.dropAll();
  bootstrap.reset();
  await bootstrap.ensure();
  if (!(await db.col('meta').findOne({ id: 'demo' }))) await demo.load();
  res.json({ ok: true, message: 'Demo data reloaded. Everyone, including you, must sign in again.', accounts: demo.accounts() });
}));

module.exports = { name: 'platform', router, anonymisePatient, breachView };
