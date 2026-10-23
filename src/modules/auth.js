'use strict';
/*
 * Sign in / out, choose provider, change and reset password, who-am-I.
 * One login per person; the app you sign into decides which of your roles is used.
 */
const express = require('express');
const db = require('../db');
const { ah, body, t, bad, unauthorized, forbidden, normPhone } = require('../lib/http');
const A = require('../lib/auth');
const { ROLES, MODULES, GROUP_ROLES, rolesForApp, permsFor } = require('../lib/roles');
const RL = require('../lib/ratelimit');
const otp = require('../lib/otp');
const { audit } = require('../lib/audit');

const router = express.Router();
const GENERIC = 'Wrong email/phone or password';

async function findUserByIdentifier(identifier) {
  const s = String(identifier || '').trim();
  if (!s) return null;
  if (s.includes('@')) return db.col('users').findOne({ email: s.toLowerCase() });
  const p = normPhone(s); return p ? db.col('users').findOne({ phone: p }) : null;
}

async function staffOptions(user, app) {
  const roles = rolesForApp(app);
  const ms = await db.col('memberships').find({ userId: user.id, status: 'active', role: { $in: roles } });
  const out = [];
  for (const m of ms) {
    const org = await db.col('orgs').findOne({ id: m.orgId });
    if (!org) continue;
    const need = ROLES[m.role].module;
    const gs = await A.groupState(org);
    out.push({ membership: m, org, group: gs.group, usable: org.status === 'active' && gs.ok && (!need || app === 'admin' || (org.modules || []).includes(need)) });
  }
  return out;
}

router.post('/auth/login', ah(async (req, res) => {
  const b = body(req, { identifier: t.str({ required: true, max: 160, label: 'Email or phone' }), password: t.str({ required: true, max: 128, trim: false, label: 'Password' }), orgId: t.id() });
  const app = req.ctx.app;
  if (!app) throw bad('Unknown app');
  const ident = b.identifier.toLowerCase();
  // generous per-IP limit: a whole hospital often shares one public IP at shift change
  await RL.limit('login_ip_' + RL.ipOf(req), require('../config').isTest ? 100000 : (Number(require('../lib/settings').get('process.security.loginPerIpPer5Min', 150)) || 150), 300);
  if (await RL.loginLocked(ident)) throw unauthorized('Too many failed attempts. Try again in 15 minutes or reset your password.');
  const user = await findUserByIdentifier(b.identifier);
  const ok = await A.verifyPassword(b.password, user && user.passHash);
  if (!user || !ok) { await RL.loginFailed(ident); await audit(req, 'auth.login_failed', { type: 'user', id: user ? user.id : null }); throw unauthorized(GENERIC); }
  if (user.status !== 'active') throw forbidden('This account is not active. Contact your administrator.');

  let membership = null, orgId = null;
  if (app === 'patient') {
    if (!user.patientId) throw forbidden('This account has no patient profile. Use the staff app for your role.');
  } else if (app === 'hq') {
    if (!user.platformRole) throw forbidden('This account is not part of the MediCore team.');
  } else if (app === 'group') {
    const gms = await db.col('group_members').find({ userId: user.id, status: 'active' });
    if (!gms.length) throw forbidden('You are not an administrator of a hospital group. Branch staff use the admin console of their branch.');
    const opts = []; for (const gm of gms) { const g = await db.col('groups').findOne({ id: gm.groupId }); if (g) opts.push({ gm, g }); }
    const usable = opts.filter(o => o.g.status === 'active');
    if (!usable.length) { const g = opts[0] && opts[0].g; if (g && g.status === 'pending') throw forbidden('Your group is awaiting MediCore approval. We will notify you when it is live.'); throw forbidden('This group\'s MediCore account is suspended. Contact MediCore support.'); }
    const pick = b.orgId ? usable.find(o => o.g.id === b.orgId) : (usable.length === 1 ? usable[0] : null);
    if (!pick) return res.json({ chooseOrg: usable.map(o => ({ orgId: o.g.id, orgName: o.g.name, orgType: 'group', role: o.gm.role, roleLabel: (GROUP_ROLES[o.gm.role] || {}).label || o.gm.role })) });
    membership = pick.gm; orgId = pick.g.id;
  } else {
    const opts = await staffOptions(user, app);
    if (!opts.length) throw forbidden('You do not have a role that uses this app.');
    const usable = opts.filter(o => o.usable);
    if (!usable.length) {
      const o = opts[0].org;
      if (o.status === 'active' && opts[0].group && opts[0].group.status === 'pending') throw forbidden('Your group is awaiting MediCore approval. We will notify you when it is live.');
      if (o.status === 'active' && opts[0].group && opts[0].group.status === 'suspended') throw forbidden('This group\'s MediCore account is suspended. Contact MediCore support.');
      if (o.status === 'pending') throw forbidden('Your provider is awaiting MediCore approval. We will notify you when it is live.');
      if (o.status === 'suspended') throw forbidden('This provider\'s MediCore account is suspended. Contact MediCore support.');
      throw forbidden('This service is not switched on for your provider.');
    }
    let pick = b.orgId ? usable.find(o => o.org.id === b.orgId) : (usable.length === 1 ? usable[0] : null);
    if (!pick) return res.json({ chooseOrg: usable.map(o => ({ orgId: o.org.id, orgName: o.org.name, orgType: o.org.type, role: o.membership.role, roleLabel: ROLES[o.membership.role].label })) });
    membership = pick.membership; orgId = pick.org.id;
  }
  await RL.loginSucceeded(ident);
  await A.createSession(res, { user, app, membership, orgId, req });
  req.ctx.user = user; req.ctx.app = app;
  await audit(req, 'auth.login', { type: 'user', id: user.id, orgId });
  res.json({ ok: true, mustChangePassword: !!user.mustChangePassword });
}));

router.post('/auth/logout', ah(async (req, res) => {
  if (req.ctx.session) { await A.revokeSession(req.ctx.session.id); await audit(req, 'auth.logout', { type: 'user', id: req.ctx.user && req.ctx.user.id }); }
  if (req.ctx.app) res.clearCookie(A.cookieName(req.ctx.app), A.cookieOpts(0));
  res.json({ ok: true });
}));

router.get('/auth/me', ah(async (req, res) => {
  A.needUser(Object.assign({}, req, { originalUrl: '/api/auth/me' }));
  const c = req.ctx;
  const out = { app: c.app, user: A.publicUser(c.user), kind: c.kind };
  if (c.kind === 'staff') {
    out.org = { id: c.org.id, name: c.org.name, type: c.org.type, code: c.org.code, modules: c.org.modules, settings: c.org.settings || {}, location: c.org.location || null, plan: c.org.plan ? { key: c.org.plan.key, status: c.org.plan.status } : null };
    out.role = c.role; out.roleLabel = ROLES[c.role].label; out.perms = c.perms; out.clocks = !!ROLES[c.role].clock && !(c.org.settings && c.org.settings.requireClockIn === false);
    const others = await staffOptions(c.user, c.app); out.otherOrgs = others.filter(o => o.usable && o.org.id !== c.org.id).map(o => ({ orgId: o.org.id, orgName: o.org.name + (o.group ? ' (' + o.group.name + ')' : '') }));
    out.group = c.group ? { id: c.group.id, name: c.group.name, code: c.group.code } : null;
    out.isOwner = !!c.membership.isOwner;
    out.org.groupId = c.org.groupId || null; out.org.branchName = c.org.branchName || null;
    if (c.app === 'admin' && c.org.groupId) { const gm = await db.col('group_members').findOne({ userId: c.user.id, groupId: c.org.groupId, status: 'active' }); out.isGroupAdmin = !!gm; }
  }
  if (c.kind === 'group') {
    out.group = { id: c.group.id, name: c.group.name, code: c.group.code, status: c.group.status };
    out.role = c.role; out.roleLabel = (GROUP_ROLES[c.role] || {}).label || c.role; out.perms = c.perms; out.isOwner = !!c.groupMember.isOwner;
    const gms = await db.col('group_members').find({ userId: c.user.id, status: 'active', groupId: { $ne: c.group.id } });
    out.otherOrgs = []; for (const gm of gms) { const g = await db.col('groups').findOne({ id: gm.groupId, status: 'active' }); if (g) out.otherOrgs.push({ orgId: g.id, orgName: g.name }); }
  }
  if (c.kind === 'patient') out.patient = { id: c.patient.id, firstName: c.patient.firstName, lastName: c.patient.lastName, lang: c.patient.lang || 'en' };
  if (c.kind === 'platform') { out.platformRole = c.platformRole; out.perms = c.perms; }
  res.json(out);
}));

router.post('/auth/switch-org', ah(async (req, res) => {
  A.needUser(req); if (req.ctx.kind !== 'staff' && req.ctx.kind !== 'group') throw forbidden();
  const b = body(req, { orgId: t.id({ required: true }) });
  if (req.ctx.kind === 'group') {
    const gm = await db.col('group_members').findOne({ userId: req.ctx.user.id, groupId: b.orgId, status: 'active' });
    const g = gm && await db.col('groups').findOne({ id: b.orgId, status: 'active' });
    if (!g) throw forbidden('You do not have access to that group');
    await A.revokeSession(req.ctx.session.id);
    await A.createSession(res, { user: req.ctx.user, app: 'group', membership: gm, orgId: g.id, req });
    return res.json({ ok: true });
  }
  const opts = await staffOptions(req.ctx.user, req.ctx.app);
  const pick = opts.find(o => o.usable && o.org.id === b.orgId);
  if (!pick) throw forbidden('You do not have access to that provider');
  await A.revokeSession(req.ctx.session.id);
  await A.createSession(res, { user: req.ctx.user, app: req.ctx.app, membership: pick.membership, orgId: pick.org.id, req });
  res.json({ ok: true });
}));

router.post('/auth/password', ah(async (req, res) => {
  A.needUser(req);
  const b = body(req, { current: t.str({ required: true, trim: false, max: 128, label: 'Current password' }), next: t.str({ required: true, trim: false, max: 128, label: 'New password' }) });
  const user = req.ctx.user;
  if (!(await A.verifyPassword(b.current, user.passHash))) throw bad('Your current password is not correct');
  A.checkPassword(b.next);
  if (b.next === b.current) throw bad('Choose a password different from the current one');
  await db.col('users').updateOne({ id: user.id }, { $set: { passHash: await A.hashPassword(b.next), mustChangePassword: false, passwordChangedAt: Date.now() } });
  await A.revokeAllForUser(user.id, req.ctx.session.id);
  await audit(req, 'auth.password_changed', { type: 'user', id: user.id });
  res.json({ ok: true });
}));

/* password reset by SMS code. Always answers the same way so it cannot be used to find accounts. */
router.post('/auth/reset/start', ah(async (req, res) => {
  const b = body(req, { identifier: t.str({ required: true, max: 160 }) });
  await RL.limitIp(req, 'reset', 30, 3600);
  await RL.limit('reset_id_' + b.identifier.toLowerCase(), 3, 3600);
  const user = await findUserByIdentifier(b.identifier);
  let extra = {};
  if (user && user.phone && user.status === 'active') extra = await otp.issue('reset', user.phone, 'Your MediCore password reset code is {code}');
  res.json(Object.assign({ ok: true, message: 'If that account exists and has a phone number, we have sent a reset code by SMS.' }, extra));
}));
router.post('/auth/reset/finish', ah(async (req, res) => {
  const b = body(req, { identifier: t.str({ required: true, max: 160 }), code: t.str({ required: true, max: 6 }), password: t.str({ required: true, trim: false, max: 128 }) });
  await RL.limitIp(req, 'resetf', 60, 3600);
  const user = await findUserByIdentifier(b.identifier);
  if (!user || !user.phone) throw bad('That code is not correct.');
  await otp.verify('reset', user.phone, b.code);
  A.checkPassword(b.password);
  await db.col('users').updateOne({ id: user.id }, { $set: { passHash: await A.hashPassword(b.password), mustChangePassword: false, passwordChangedAt: Date.now() } });
  await A.revokeAllForUser(user.id);
  await RL.loginSucceeded(b.identifier.toLowerCase());
  await audit(req, 'auth.password_reset', { type: 'user', id: user.id });
  res.json({ ok: true });
}));

/* map tile settings for the apps (tile provider is configurable; OSM's public tiles are for light use only) */
router.get('/meta/map', (req, res) => {
  const config = require('../config');
  res.json({ tileUrl: config.MAP_TILE_URL, attribution: config.MAP_TILE_ATTRIBUTION, routing: !!config.ROUTING_URL });
});

/* catalogue of roles and modules, for admin and signup screens */
router.get('/meta/catalog', (req, res) => {
  const { ORG_TYPES, PERMS } = require('../lib/roles');
  res.json({ modules: MODULES, orgTypes: ORG_TYPES, roles: Object.fromEntries(Object.entries(ROLES).map(([k, r]) => [k, { label: r.label, app: r.app, module: r.module, perms: r.perms }])), perms: PERMS });
});

module.exports = { name: 'auth', router, findUserByIdentifier, permsFor };
