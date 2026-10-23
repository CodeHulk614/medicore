'use strict';
/*
 * Provider staff management, audit log, summary reports, staff notifications.
 *
 * Escalation rules (the gap that let a front desk manager take over an admin before):
 *  - Nobody can change their own role, permissions or status.
 *  - The owner membership cannot be changed or removed by anyone at the provider.
 *  - Only the owner can create, change or remove administrators.
 *  - You can only grant permissions you hold yourself.
 *  - Roles offered depend on the provider's enabled modules.
 *  - Suspending or removing someone ends their sessions at this provider immediately.
 */
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param } = require('../lib/http');
const A = require('../lib/auth');
const { ROLES, PERMS, rolesForModules, permsFor } = require('../lib/roles');
const { id, now, maskEmail } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify, sms } = require('../lib/notify');

const router = express.Router();
const staffAdmin = A.requireStaff({ perm: 'admin.staff' });

function tempPassword() { const w = crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x'); return w.slice(0, 10) + '7'; }
const isOwner = req => !!req.ctx.membership.isOwner;

async function memberView(m) {
  const u = await db.col('users').findOne({ id: m.userId }, { projection: { name: 1, email: 1, phone: 1, lastLoginAt: 1, mustChangePassword: 1 } });
  return { id: m.id, userId: m.userId, name: u ? u.name : 'Unknown', email: u ? u.email || null : null, phone: u ? u.phone || null : null, role: m.role, roleLabel: (ROLES[m.role] || {}).label || m.role, title: m.title || null,
    status: m.status, isOwner: !!m.isOwner, perms: permsFor(m), extraPerms: m.extraPerms || [], removedPerms: m.removedPerms || [], lastLoginAt: u ? u.lastLoginAt || null : null, pendingPasswordChange: u ? !!u.mustChangePassword : false, createdAt: m.createdAt };
}

router.get('/admin/staff', staffAdmin, ah(async (req, res) => {
  const ms = await db.col('memberships').find({ orgId: req.ctx.org.id, status: { $ne: 'removed' } }, { sort: { createdAt: 1 } });
  const out = []; for (const m of ms) out.push(await memberView(m));
  const seats = req.ctx.org.subscription ? req.ctx.org.subscription.seats : null;
  res.json({ staff: out, roles: rolesForModules(req.ctx.org.modules).filter(r => r !== 'owner' && !(req.ctx.org.type === 'hmo' ? !r.startsWith('payer') && r !== 'admin' : r.startsWith('payer'))).map(r => ({ key: r, label: ROLES[r].label, perms: ROLES[r].perms, app: ROLES[r].app })),
    grantable: req.ctx.perms.map(p => ({ key: p, label: PERMS[p] })), seats: seats || null, used: out.filter(s => s.status === 'active').length });
}));

router.post('/admin/staff', staffAdmin, ah(async (req, res) => {
  const b = body(req, { name: t.str({ required: true, max: 100 }), email: t.email(), phone: t.phone(), role: t.str({ required: true, max: 40 }), title: t.str({ max: 60 }), extraPerms: t.arr(t.str({ max: 40 }), { max: 30 }) });
  if (!b.email && !b.phone) throw bad('Give an email or a phone number so the person can sign in');
  const org = req.ctx.org;
  const allowed = rolesForModules(org.modules).filter(r => r !== 'owner');
  if (!allowed.includes(b.role) || !ROLES[b.role]) throw bad('That role is not available for your provider');
  if (org.type === 'hmo' ? !(b.role.startsWith('payer') || b.role === 'admin') : b.role.startsWith('payer')) throw bad('That role is not available for your provider');
  if (b.role === 'admin' && !isOwner(req)) throw forbidden('Only the owner can add administrators');
  const extra = (b.extraPerms || []).filter(p => PERMS[p]);
  const notHeld = extra.filter(p => !req.ctx.perms.includes(p));
  if (notHeld.length) throw forbidden('You cannot grant permissions you do not have: ' + notHeld.join(', '));
  const rolePermsNotHeld = ROLES[b.role].perms.filter(p => !req.ctx.perms.includes(p) && p.startsWith('admin.'));
  if (rolePermsNotHeld.length && !isOwner(req)) throw forbidden('You cannot create a role with more admin access than you have');
  const seats = org.subscription && org.subscription.seats;
  if (seats) { const used = await db.col('memberships').count({ orgId: org.id, status: 'active' }); if (used >= seats) throw forbidden('Your subscription covers ' + seats + ' staff accounts. Add seats in Settings > Subscription, or contact MediCore.'); }

  let user = b.email ? await db.col('users').findOne({ email: b.email }) : null;
  if (!user && b.phone) user = await db.col('users').findOne({ phone: b.phone });
  let temp = null;
  if (user) {
    if (await db.col('memberships').findOne({ userId: user.id, orgId: org.id, status: { $ne: 'removed' } })) throw conflict('This person already works at your provider');
  } else {
    temp = tempPassword();
    user = { id: id('usr'), name: b.name, passHash: await A.hashPassword(temp), status: 'active', mustChangePassword: true, createdAt: now() };
    if (b.email) user.email = b.email; if (b.phone) user.phone = b.phone;
    await db.col('users').insertOne(user);
  }
  const old = await db.col('memberships').findOne({ userId: user.id, orgId: org.id, status: 'removed' });
  if (old) await db.col('memberships').deleteOne({ id: old.id });
  const m = { id: id('mem'), userId: user.id, orgId: org.id, role: b.role, title: b.title || null, extraPerms: extra, removedPerms: [], status: 'active', isOwner: false, createdAt: now(), createdBy: req.ctx.user.id };
  await db.col('memberships').insertOne(m);
  await audit(req, 'staff.add', { type: 'membership', id: m.id }, { role: m.role, newAccount: !!temp });
  if (user.phone) await sms(user.phone, 'You have been added to ' + org.name + ' on MediCore as ' + ROLES[b.role].label + '.' + (temp ? ' Your administrator will give you a temporary password.' : ' Sign in with your existing MediCore password.'));
  res.json({ member: await memberView(m), tempPassword: temp, note: temp ? 'Give this temporary password to the person privately. They must change it when they first sign in. It will not be shown again.' : 'This person already has a MediCore account and signs in with their own password.' });
}));

async function loadTarget(req) {
  const m = await db.col('memberships').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!m || m.status === 'removed') throw notFound('Staff member not found');
  if (m.userId === req.ctx.user.id) throw forbidden('You cannot change your own access. Ask another administrator.');
  if (m.isOwner) throw forbidden('The owner\'s access can only be changed by MediCore support.');
  if (ROLES[m.role] && ROLES[m.role].perms.includes('admin.staff') && !isOwner(req)) throw forbidden('Only the owner can change an administrator');
  return m;
}

router.patch('/admin/staff/:id', staffAdmin, ah(async (req, res) => {
  const b = body(req, { role: t.str({ max: 40 }), title: t.str({ max: 60 }), extraPerms: t.arr(t.str({ max: 40 }), { max: 30 }), removedPerms: t.arr(t.str({ max: 40 }), { max: 30 }), status: t.enum(['active', 'suspended', 'removed']) });
  const m = await loadTarget(req);
  const set = {};
  if (b.role && b.role !== m.role) {
    const allowed = rolesForModules(req.ctx.org.modules).filter(r => r !== 'owner');
    if (!allowed.includes(b.role)) throw bad('That role is not available for your provider');
    if (b.role === 'admin' && !isOwner(req)) throw forbidden('Only the owner can make someone an administrator');
    if (!isOwner(req) && ROLES[b.role].perms.some(p => p.startsWith('admin.') && !req.ctx.perms.includes(p))) throw forbidden('You cannot assign a role with more admin access than you have');
    set.role = b.role;
  }
  if (b.extraPerms) { const bad1 = b.extraPerms.filter(p => !PERMS[p] || !req.ctx.perms.includes(p)); if (bad1.length) throw forbidden('You cannot grant: ' + bad1.join(', ')); set.extraPerms = b.extraPerms; }
  if (b.removedPerms) set.removedPerms = b.removedPerms.filter(p => PERMS[p]);
  if (b.title !== undefined) set.title = b.title;
  if (b.status) set.status = b.status;
  if (!Object.keys(set).length) throw bad('Nothing to change');
  const upd = await db.col('memberships').findOneAndUpdate({ id: m.id }, { $set: set });
  if (b.status && b.status !== 'active') await db.col('sessions').updateMany({ membershipId: m.id }, { $set: { revoked: true, revokedAt: now() } });
  if (b.status === 'removed') await db.col('shifts').updateMany({ membershipId: m.id, out: null }, { $set: { out: now(), closedBy: 'removed' } });
  await audit(req, 'staff.update', { type: 'membership', id: m.id }, set);
  res.json(await memberView(upd));
}));

router.post('/admin/staff/:id/reset-password', staffAdmin, ah(async (req, res) => {
  const m = await loadTarget(req);
  const others = await db.col('memberships').count({ userId: m.userId, orgId: { $ne: req.ctx.org.id }, status: 'active' });
  const u = await db.col('users').findOne({ id: m.userId });
  if (others > 0 || (u && u.patientId)) throw forbidden('This person uses MediCore elsewhere too. Ask them to reset their own password with "Forgot password".');
  const temp = tempPassword();
  await db.col('users').updateOne({ id: m.userId }, { $set: { passHash: await A.hashPassword(temp), mustChangePassword: true } });
  await A.revokeAllForUser(m.userId);
  await audit(req, 'staff.reset_password', { type: 'membership', id: m.id });
  res.json({ tempPassword: temp, note: 'Give this to the person privately. They must change it at next sign in.' });
}));

/* -------- audit log -------- */
router.get('/admin/audit', A.requireStaff({ perm: 'admin.audit' }), ah(async (req, res) => {
  const q = query(req, { before: t.int({ min: 0 }), action: t.str({ max: 60 }), actorId: t.id(), patientId: t.id(), limit: t.int({ min: 1, max: 200 }) });
  const f = { orgId: req.ctx.org.id }; if (q.before) f.at = { $lt: q.before }; if (q.action) f.action = { $regex: '^' + q.action.replace(/[^a-z._]/gi, '') }; if (q.actorId) f.actorId = q.actorId; if (q.patientId) f.patientId = q.patientId;
  res.json(await db.col('audit').find(f, { sort: { at: -1 }, limit: q.limit || 100 }));
}));

/* -------- summary report -------- */
router.get('/admin/reports/summary', A.requireStaff({ perm: 'admin.reports' }), ah(async (req, res) => {
  const org = req.ctx.org.id; const since = Date.now() - 30 * 86400e3;
  const bills = await db.col('bills').find({ orgId: org, createdAt: { $gte: since } }, { projection: { totalKobo: 1, paidKobo: 1, status: 1, hmo: 1, createdAt: 1, lines: 1 } });
  const byDay = {}; const byCat = {};
  bills.filter(b => b.status === 'paid').forEach(b => { const d = new Date(b.createdAt + 3600e3).toISOString().slice(0, 10); byDay[d] = (byDay[d] || 0) + b.totalKobo; (b.lines || []).forEach(l => { byCat[l.category] = (byCat[l.category] || 0) + l.totalKobo; }); });
  res.json({
    patients: await db.col('patient_links').count({ orgId: org }), newPatients30d: await db.col('patient_links').count({ orgId: org, createdAt: { $gte: since } }),
    staffActive: await db.col('memberships').count({ orgId: org, status: 'active' }), onDuty: await db.col('shifts').count({ orgId: org, out: null }),
    revenue30dKobo: bills.filter(b => b.status === 'paid').reduce((s, b) => s + b.paidKobo, 0), hmoCovered30dKobo: bills.filter(b => b.hmo).reduce((s, b) => s + (b.hmo.coveredKobo || 0), 0),
    openBills: bills.filter(b => b.status === 'open').length, outstandingKobo: bills.filter(b => b.status === 'open').reduce((s, b) => s + (b.patientDueKobo - b.paidKobo), 0),
    revenueByDay: Object.entries(byDay).sort().map(([date, kobo]) => ({ date, kobo })), revenueByCategory: byCat,
  });
}));

/* -------- staff notifications -------- */
router.get('/notifications', A.requireStaff({}), ah(async (req, res) => {
  const f = { $or: [{ userId: req.ctx.user.id }, { orgId: req.ctx.org.id, role: req.ctx.role }, { orgId: req.ctx.org.id, role: '*' }] };
  res.json(await db.col('notifications').find(f, { sort: { at: -1 }, limit: 50 }));
}));
router.post('/notifications/read', A.requireStaff({}), ah(async (req, res) => {
  await db.col('notifications').updateMany({ userId: req.ctx.user.id, read: false }, { $set: { read: true } });
  res.json({ ok: true });
}));

module.exports = { name: 'staff', router, tempPassword };
