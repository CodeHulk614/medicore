'use strict';
/*
 * Clock-in / clock-out for every staff app. Location is captured and checked against the
 * provider's geofence. With strictGeofence on, clocking in off-site is refused.
 * Operational writes in the service modules use requireOnShift (lib/auth) to enforce it.
 */
const express = require('express');
const db = require('../db');
const { ah, body, t, bad, conflict, forbidden } = require('../lib/http');
const A = require('../lib/auth');
const { ROLES } = require('../lib/roles');
const { id, haversineKm, now } = require('../lib/util');
const { audit } = require('../lib/audit');

db.index('shifts', ['membershipId', 'out']);
db.index('shifts', ['orgId', 'in']);

const router = express.Router();

router.get('/shift/me', A.requireStaff({}), ah(async (req, res) => {
  const open = await db.col('shifts').findOne({ membershipId: req.ctx.membership.id, out: null });
  const recent = await db.col('shifts').find({ membershipId: req.ctx.membership.id }, { sort: { in: -1 }, limit: 10 });
  res.json({ required: !!ROLES[req.ctx.role].clock && !(req.ctx.org.settings && req.ctx.org.settings.requireClockIn === false), open, recent });
}));

router.post('/shift/clock-in', A.requireStaff({}), ah(async (req, res) => {
  const b = body(req, { lat: t.lat(), lng: t.lng(), accuracyM: t.num({ min: 0, max: 100000 }) });
  const o = req.ctx.org; const s = o.settings || {};
  let distanceM = null, onSite = null;
  if (b.lat != null && b.lng != null && o.location && o.location.lat != null) {
    distanceM = Math.round(haversineKm({ lat: b.lat, lng: b.lng }, o.location) * 1000);
    onSite = distanceM <= (s.geofenceM || 300) + Math.min(b.accuracyM || 0, 200);
  }
  if (s.strictGeofence) {
    if (onSite === null) throw bad('Turn on location to clock in. Your provider requires on-site clock-in.');
    if (!onSite) throw forbidden('You are ' + distanceM + 'm from ' + o.name + '. Clock in when you are on site.');
  }
  const shift = { id: id('sh'), membershipId: req.ctx.membership.id, userId: req.ctx.user.id, orgId: o.id, role: req.ctx.role, in: now(), out: null, inLoc: b.lat != null ? { lat: b.lat, lng: b.lng, accuracyM: b.accuracyM || null } : null, distanceM, onSite };
  const existing = await db.col('shifts').findOne({ membershipId: req.ctx.membership.id, out: null });
  if (existing) throw conflict('You are already clocked in');
  await db.col('shifts').insertOne(shift);
  await audit(req, 'shift.clock_in', { type: 'shift', id: shift.id }, { onSite, distanceM });
  res.json(shift);
}));

router.post('/shift/clock-out', A.requireStaff({}), ah(async (req, res) => {
  const b = body(req, { lat: t.lat(), lng: t.lng() });
  const s = await db.col('shifts').findOneAndUpdate({ membershipId: req.ctx.membership.id, out: null }, { $set: { out: now(), outLoc: b.lat != null ? { lat: b.lat, lng: b.lng } : null } });
  if (!s) throw conflict('You are not clocked in');
  await db.col('shifts').updateOne({ id: s.id }, { $set: { minutes: Math.round((s.out - s.in) / 60000) } });
  await audit(req, 'shift.clock_out', { type: 'shift', id: s.id });
  res.json(Object.assign(s, { minutes: Math.round((s.out - s.in) / 60000) }));
}));

/* who is on duty now, and attendance (admins, managers) */
router.get('/shift/on-duty', A.requireStaff({ anyPerm: ['admin.staff', 'admin.reports', 'queue.manage', 'delivery.dispatch', 'ambulance.dispatch'] }), ah(async (req, res) => {
  const open = await db.col('shifts').find({ orgId: req.ctx.org.id, out: null }, { sort: { in: -1 } });
  const users = open.length ? await db.col('users').find({ id: { $in: open.map(s => s.userId) } }, { projection: { name: 1 } }) : [];
  const nm = Object.fromEntries(users.map(u => [u.id, u.name]));
  res.json(open.map(s => ({ id: s.id, userId: s.userId, name: nm[s.userId] || 'Staff', role: s.role, roleLabel: (ROLES[s.role] || {}).label, in: s.in, onSite: s.onSite, distanceM: s.distanceM })));
}));
router.get('/shift/attendance', A.requireStaff({ anyPerm: ['admin.staff', 'admin.reports'] }), ah(async (req, res) => {
  const since = Number(req.query.since) || (Date.now() - 14 * 86400e3);
  const rows = await db.col('shifts').find({ orgId: req.ctx.org.id, in: { $gte: since } }, { sort: { in: -1 }, limit: 1000 });
  const users = rows.length ? await db.col('users').find({ id: { $in: [...new Set(rows.map(s => s.userId))] } }, { projection: { name: 1 } }) : [];
  const nm = Object.fromEntries(users.map(u => [u.id, u.name]));
  res.json(rows.map(s => Object.assign({ name: nm[s.userId] || 'Staff' }, s)));
}));

module.exports = { name: 'shifts', router };
