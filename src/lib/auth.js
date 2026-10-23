'use strict';
/*
 * Sessions and access control.
 *
 * - A session is a server-side record; the browser holds a signed, HttpOnly cookie that
 *   points at it (one cookie per app, so a tester can be signed into several apps at once).
 * - EVERY request re-checks: session not revoked or expired, user active, membership active,
 *   provider active, role allowed in this app, module enabled. Suspending a person or a
 *   provider therefore takes effect on their very next request.
 * - Mutating requests need the X-MC-App header; browsers cannot add it cross-site without
 *   a CORS preflight that we refuse, which blocks CSRF.
 */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const { id } = require('./util');
const { unauthorized, forbidden, locked, bad } = require('./http');
const { ROLES, APPS, GROUP_ROLES, permsFor, platformPermsFor, rolesForApp } = require('./roles');

db.index('users', ['email'], { unique: true, sparse: true });
db.index('users', ['phone'], { unique: true, sparse: true });
db.index('sessions', ['userId']);
db.index('memberships', ['userId', 'orgId'], { unique: true });
db.index('memberships', ['orgId', 'role']);
db.index('group_members', ['userId', 'groupId'], { unique: true });
db.index('group_members', ['groupId']);

/** is the group this org belongs to (if any) usable? */
async function groupState(org) {
  if (!org || !org.groupId) return { ok: true, group: null };
  const g = await db.col('groups').findOne({ id: org.groupId });
  if (!g) return { ok: false, reason: 'org_inactive', group: null };
  if (g.status === 'suspended') return { ok: false, reason: 'org_suspended', group: g };
  if (g.status !== 'active') return { ok: false, reason: 'org_inactive', group: g };
  return { ok: true, group: g };
}

const COMMON = new Set(['password', 'password1', '12345678', '123456789', 'qwerty123', 'medicore', 'medicore1', 'demo1234', 'abc12345', 'iloveyou', 'admin123', 'letmein1', 'welcome1', 'passw0rd']);
function checkPassword(pw) {
  const min = Math.max(8, Number(require('./settings').get('process.security.passwordMinLength', 8)) || 8);
  if (typeof pw !== 'string' || pw.length < min) throw bad('Password must be at least ' + min + ' characters');
  if (pw.length > 128) throw bad('Password is too long');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw bad('Password must contain letters and numbers');
  if (COMMON.has(pw.toLowerCase())) throw bad('That password is too common. Choose another.');
}
const hashPassword = pw => bcrypt.hash(pw, 11);
let DUMMY = null; // compare against a real hash when the user does not exist, so timing does not reveal accounts
const verifyPassword = async (pw, hash) => {
  if (hash) return bcrypt.compare(String(pw || ''), hash);
  if (!DUMMY) DUMMY = await bcrypt.hash('no-such-user-' + Math.random(), 11);
  await bcrypt.compare(String(pw || ''), DUMMY); return false;
};

const cookieName = app => 'mc_' + app;
function cookieOpts(maxAgeMs) {
  return { httpOnly: true, sameSite: 'lax', secure: config.isProd || config.isNetlify, path: '/api', maxAge: maxAgeMs };
}

async function createSession(res, { user, app, membership, orgId, req }) {
  const sid = id('ss');
  const expiresAt = Date.now() + config.SESSION_HOURS * 3600e3;
  await db.col('sessions').insertOne({ id: sid, userId: user.id, app, orgId: orgId || null, membershipId: membership ? membership.id : null, at: Date.now(), expiresAt, revoked: false,
    ip: req ? (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0] : null, ua: req ? String(req.headers['user-agent'] || '').slice(0, 160) : null });
  const token = jwt.sign({ sid, uid: user.id, app }, config.JWT_SECRET, { expiresIn: config.SESSION_HOURS + 'h' });
  res.cookie(cookieName(app), token, cookieOpts(config.SESSION_HOURS * 3600e3));
  await db.col('users').updateOne({ id: user.id }, { $set: { lastLoginAt: Date.now() } });
  return sid;
}
async function revokeSession(sid) { if (sid) await db.col('sessions').updateOne({ id: sid }, { $set: { revoked: true, revokedAt: Date.now() } }); }
async function revokeAllForUser(userId, exceptSid) { await db.col('sessions').updateMany(exceptSid ? { userId, id: { $ne: exceptSid } } : { userId }, { $set: { revoked: true, revokedAt: Date.now() } }); }

/* -------- request context -------- */
async function loadSession(req, res, next) {
  const app = String(req.headers['x-mc-app'] || '');
  req.ctx = { app: APPS.includes(app) ? app : null, user: null };
  try {
    if (!req.ctx.app) return next();
    const raw = req.cookies && req.cookies[cookieName(app)];
    if (!raw) return next();
    let claims; try { claims = jwt.verify(raw, config.JWT_SECRET); } catch (e) { req.ctx.authError = 'expired'; return next(); }
    if (claims.app !== app) return next();
    const s = await db.col('sessions').findOne({ id: claims.sid });
    if (!s || s.revoked || s.expiresAt < Date.now() || s.userId !== claims.uid) { req.ctx.authError = 'expired'; return next(); }
    const user = await db.col('users').findOne({ id: s.userId });
    if (!user || user.status !== 'active') { req.ctx.authError = 'account_inactive'; return next(); }
    const ctx = req.ctx; ctx.session = s; ctx.user = user;
    if (app === 'patient') {
      if (!user.patientId) { ctx.authError = 'not_patient'; ctx.user = null; return next(); }
      ctx.patient = await db.col('patients').findOne({ id: user.patientId });
      if (!ctx.patient || ctx.patient.status === 'removed') { ctx.user = null; ctx.authError = 'account_inactive'; return next(); }
      ctx.kind = 'patient';
    } else if (app === 'hq') {
      if (!user.platformRole) { ctx.user = null; ctx.authError = 'not_platform'; return next(); }
      ctx.kind = 'platform'; ctx.platformRole = user.platformRole; ctx.perms = platformPermsFor(user.platformRole);
    } else if (app === 'group') {
      const gm = await db.col('group_members').findOne({ id: s.membershipId });
      if (!gm || gm.status !== 'active' || gm.userId !== user.id) { ctx.user = null; ctx.authError = 'access_removed'; return next(); }
      const g = await db.col('groups').findOne({ id: gm.groupId });
      if (!g || g.status !== 'active') { ctx.user = null; ctx.authError = g && g.status === 'suspended' ? 'org_suspended' : 'org_inactive'; return next(); }
      ctx.kind = 'group'; ctx.group = g; ctx.groupMember = gm; ctx.role = gm.role; ctx.perms = (GROUP_ROLES[gm.role] || { perms: [] }).perms.slice();
    } else {
      const m = await db.col('memberships').findOne({ id: s.membershipId });
      if (!m || m.status !== 'active' || m.userId !== user.id) { ctx.user = null; ctx.authError = 'access_removed'; return next(); }
      const org = await db.col('orgs').findOne({ id: m.orgId });
      if (!org || org.status !== 'active') { ctx.user = null; ctx.authError = org && org.status === 'suspended' ? 'org_suspended' : 'org_inactive'; return next(); }
      const gs = await groupState(org);
      if (!gs.ok) { ctx.user = null; ctx.authError = gs.reason; return next(); }
      ctx.group = gs.group;
      if (!rolesForApp(app).includes(m.role)) { ctx.user = null; ctx.authError = 'wrong_app'; return next(); }
      const need = ROLES[m.role].module;
      if (need && app !== 'admin' && !(org.modules || []).includes(need)) { ctx.user = null; ctx.authError = 'module_off'; return next(); }
      ctx.kind = 'staff'; ctx.membership = m; ctx.org = org; ctx.role = m.role; ctx.perms = permsFor(m);
    }
    return next();
  } catch (e) { return next(e); }
}

const AUTH_MESSAGES = {
  expired: 'Your session has ended. Please sign in again.',
  account_inactive: 'This account is not active. Contact your administrator.',
  access_removed: 'Your access to this provider has been removed or suspended.',
  org_suspended: 'This provider\'s MediCore account is suspended. Contact MediCore support.',
  org_inactive: 'This provider is not active yet.',
  module_off: 'This service is not switched on for your provider.',
  wrong_app: 'Your role does not use this app.',
  not_patient: 'This account has no patient profile.',
  not_platform: 'This account is not part of the MediCore team.',
};
function needUser(req) {
  if (!req.ctx || !req.ctx.user) { const e = unauthorized(AUTH_MESSAGES[req.ctx && req.ctx.authError] || 'Please sign in'); e.code = req.ctx && req.ctx.authError ? req.ctx.authError : 'unauthorized'; throw e; }
  if (req.ctx.user.mustChangePassword && !/^\/api\/auth\//.test(req.originalUrl)) throw locked('Please set a new password to continue', 'password_change_required');
}

/* -------- guards (use as middleware) -------- */
const wrap = fn => (req, res, next) => { try { fn(req); next(); } catch (e) { next(e); } };
const requirePatient = wrap(req => { needUser(req); if (req.ctx.kind !== 'patient') throw forbidden(); });
const requireGroup = perm => wrap(req => { needUser(req); if (req.ctx.kind !== 'group') throw forbidden(); if (perm && !req.ctx.perms.includes(perm)) throw forbidden('Your group role cannot do this'); });
const requirePlatform = perm => wrap(req => { needUser(req); if (req.ctx.kind !== 'platform') throw forbidden(); if (perm && !req.ctx.perms.includes(perm)) throw forbidden('Your platform role cannot do this'); });
/**
 * requireStaff({ perm, anyPerm: [...], module, app })
 * perm: one permission needed; anyPerm: at least one of them; module: provider must have it on.
 */
function requireStaff(opts = {}) {
  return wrap(req => {
    needUser(req);
    const c = req.ctx;
    if (c.kind !== 'staff') throw forbidden();
    if (opts.module && !(c.org.modules || []).includes(opts.module)) throw forbidden('This service is not switched on for your provider');
    if (opts.perm && !c.perms.includes(opts.perm)) throw forbidden('Your role does not allow this');
    if (opts.anyPerm && !opts.anyPerm.some(p => c.perms.includes(p))) throw forbidden('Your role does not allow this');
  });
}
const has = (req, perm) => !!(req.ctx && req.ctx.perms && req.ctx.perms.includes(perm));

/** staff must be on shift for operational writes when their role clocks in and the provider requires it */
const requireOnShift = (req, res, next) => {
  (async () => {
    const c = req.ctx;
    if (!c || c.kind !== 'staff') return;
    const role = ROLES[c.role];
    if (!role || !role.clock) return;
    if (c.org.settings && c.org.settings.requireClockIn === false) return;
    const open = await db.col('shifts').findOne({ membershipId: c.membership.id, out: null });
    if (!open) throw locked('Clock in to start your shift before doing this.', 'clock_in_required');
    c.shift = open;
  })().then(() => next(), next);
};

/** CSRF + origin guard for /api */
function apiGuard(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    let ok = false; try { ok = new URL(origin).host === host; } catch (e) { ok = false; }
    if (!ok && !config.ALLOWED_ORIGINS.includes(origin)) return res.status(403).json({ error: 'Origin not allowed', code: 'bad_origin' });
    res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Allow-Credentials', 'true'); res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MC-App, X-MC-Lang, X-MC-Provider'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE'); return res.status(204).end(); }
  }
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const exempt = /^\/api\/(pay\/[a-z]+\/webhook|ussd|health|whatsapp\/webhook)(\/|\?|$)/.test(req.originalUrl);
  if (!safe && !exempt && !req.headers['x-mc-app']) return res.status(403).json({ error: 'Missing app header', code: 'csrf' });
  next();
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email || null, phone: u.phone || null, phoneVerified: !!u.phoneVerified, mustChangePassword: !!u.mustChangePassword, platformRole: u.platformRole || null, patientId: u.patientId || null };
}

module.exports = { checkPassword, hashPassword, verifyPassword, createSession, revokeSession, revokeAllForUser, cookieName, cookieOpts, loadSession, needUser, groupState, requirePatient, requirePlatform, requireGroup, requireStaff, requireOnShift, has, apiGuard, publicUser, AUTH_MESSAGES };
