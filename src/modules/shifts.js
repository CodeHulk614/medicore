'use strict';
/*
 * Clock-in / clock-out for every staff app. Location is captured and checked against the
 * provider's geofence. With strictGeofence on, clocking in off-site is refused.
 * Operational writes in the service modules use requireOnShift (lib/auth) to enforce it.
 *
 * Trust: every staff member has a unique staff ID derived with a keyed hash (HMAC-SHA256) from their membership, so it
 * cannot be guessed or forged, and anyone can check it (a patient checking an ambulance crew member, for example).
 * Every clock-in and clock-out record carries a sequence number per provider and a keyed signature over its time,
 * place and staff ID. Admins run a check that flags any record edited after the fact, or missing from the sequence.
 */
const express = require('express');
const db = require('../db');
const { ah, body, t, bad, conflict, forbidden } = require('../lib/http');
const A = require('../lib/auth');
const { ROLES } = require('../lib/roles');
const { id, haversineKm, now } = require('../lib/util');
const { audit } = require('../lib/audit');
const crypto = require('crypto');
const config = require('../config');
const { nextNumber } = require('./orgs');
const RL = require('../lib/ratelimit');

const KEY = () => crypto.createHash('sha256').update('medicore-staff:' + (process.env.STAFF_ID_KEY || process.env.SETTINGS_KEY || config.JWT_SECRET || 'dev')).digest();
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const b32 = buf => Array.from(buf).map(x => B32[x % 32]).join('');
/** MC-XXXXX-XXXXX: 8 characters from the HMAC of the membership id, plus 2 check characters */
function staffUid(membershipId) {
  const body = b32(crypto.createHmac('sha256', KEY()).update('uid:' + membershipId).digest().subarray(0, 8));
  const chk = b32(crypto.createHmac('sha256', KEY()).update('chk:' + body).digest().subarray(0, 2));
  return 'MC-' + body.slice(0, 5) + '-' + body.slice(5) + chk;
}
const uidValid = uid => { const m = /^MC-([A-Z2-9]{5})-([A-Z2-9]{3})([A-Z2-9]{2})$/.exec(String(uid || '').toUpperCase()); if (!m) return false; const body = m[1] + m[2]; return b32(crypto.createHmac('sha256', KEY()).update('chk:' + body).digest().subarray(0, 2)) === m[3]; };
const canon = s => JSON.stringify([s.orgId, s.membershipId, s.staffUid, s.seq, s.in, s.inLoc ? [s.inLoc.lat, s.inLoc.lng] : null, s.distanceM, s.onSite, s.out || null, s.outLoc ? [s.outLoc.lat, s.outLoc.lng] : null]);
const sign = s => crypto.createHmac('sha256', KEY()).update(canon(s)).digest('hex');
async function ensureUid(membership) {
  if (membership.staffUid) return membership.staffUid;
  const uid = staffUid(membership.id);
  await db.col('memberships').updateOne({ id: membership.id }, { $set: { staffUid: uid } });
  membership.staffUid = uid; return uid;
}

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
  const existing = await db.col('shifts').findOne({ membershipId: req.ctx.membership.id, out: null });
  if (existing) throw conflict('You are already clocked in');
  const shift = { id: id('sh'), membershipId: req.ctx.membership.id, userId: req.ctx.user.id, orgId: o.id, role: req.ctx.role, staffUid: await ensureUid(req.ctx.membership), seq: await nextNumber('shiftseq_' + o.id),
    in: now(), out: null, inLoc: b.lat != null ? { lat: b.lat, lng: b.lng, accuracyM: b.accuracyM || null } : null, distanceM, onSite };
  shift.sig = sign(shift);
  await db.col('shifts').insertOne(shift);
  await audit(req, 'shift.clock_in', { type: 'shift', id: shift.id }, { onSite, distanceM });
  res.json(shift);
}));

router.post('/shift/clock-out', A.requireStaff({}), ah(async (req, res) => {
  const b = body(req, { lat: t.lat(), lng: t.lng() });
  const s = await db.col('shifts').findOneAndUpdate({ membershipId: req.ctx.membership.id, out: null }, { $set: { out: now(), outLoc: b.lat != null ? { lat: b.lat, lng: b.lng } : null } });
  if (!s) throw conflict('You are not clocked in');
  await db.col('shifts').updateOne({ id: s.id }, { $set: { minutes: Math.round((s.out - s.in) / 60000), sig: s.seq ? sign(s) : undefined } });
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
  res.json(rows.map(s => Object.assign({ name: nm[s.userId] || 'Staff' }, s, { sig: undefined, signed: !!s.sig, intact: s.sig ? s.sig === sign(s) : null })));
}));
/* the integrity check: every signed record must match its signature, and the sequence must have no gaps */
router.get('/shift/attendance/verify', A.requireStaff({ anyPerm: ['admin.staff', 'admin.reports'] }), ah(async (req, res) => {
  const rows = (await db.col('shifts').find({ orgId: req.ctx.org.id, seq: { $gt: 0 } }, { sort: { seq: 1 }, limit: 20000 }));
  const tampered = rows.filter(s => s.sig !== sign(s)).map(s => ({ id: s.id, seq: s.seq, in: s.in }));
  const missing = []; for (let i = 1; i < rows.length; i++) for (let n = rows[i - 1].seq + 1; n < rows[i].seq && missing.length < 200; n++) missing.push(n);
  const unsigned = await db.col('shifts').count({ orgId: req.ctx.org.id, seq: { $exists: false } });
  await audit(req, 'shift.verify', { type: 'org', id: req.ctx.org.id }, { checked: rows.length, tampered: tampered.length, missing: missing.length });
  res.json({ checked: rows.length, intact: !tampered.length && !missing.length, tampered, missingSeq: missing, unsignedOlder: unsigned, checkedAt: now() });
}));
/* my staff ID, for the staff card in every staff app */
router.get('/shift/my-id', A.requireStaff({}), ah(async (req, res) => {
  res.json({ staffUid: await ensureUid(req.ctx.membership), name: req.ctx.user.name, role: req.ctx.role, roleLabel: (ROLES[req.ctx.role] || {}).label, org: req.ctx.org.name });
}));
/* public: check a staff ID (a patient checking the crew at the door). Name, role, provider and whether on duty now. */
router.get('/verify/staff/:uid', ah(async (req, res) => {
  await RL.limitIp(req, 'staffchk', 60, 3600);
  const uid = String(req.params.uid || '').toUpperCase();
  if (!uidValid(uid)) return res.json({ valid: false, reason: 'not_a_staff_id' });
  const m = await db.col('memberships').findOne({ staffUid: uid });
  if (!m || m.status !== 'active') return res.json({ valid: false, reason: m ? 'not_active' : 'not_found' });
  const [u, o, open] = await Promise.all([db.col('users').findOne({ id: m.userId }, { projection: { name: 1 } }), db.col('orgs').findOne({ id: m.orgId }, { projection: { name: 1 } }), db.col('shifts').findOne({ membershipId: m.id, out: null })]);
  res.json({ valid: true, staffUid: uid, name: u ? u.name : 'Staff', role: (ROLES[m.role] || {}).label || m.role, provider: o ? o.name : null, onDutyNow: !!open });
}));

module.exports = { name: 'shifts', router, staffUid, uidValid };
