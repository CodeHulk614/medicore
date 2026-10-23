'use strict';
/*
 * Doctor schedules, the public doctor directory and computed slots.
 * A schedule belongs to one doctor membership at one provider (a doctor who works at two
 * providers has two schedules). Slots are computed on read from the weekly pattern in
 * Africa/Lagos time, minus booked appointments of the same person at any provider.
 */
const express = require('express');
const db = require('../../db');
const { ah, body, query, t, bad, notFound, param } = require('../../lib/http');
const A = require('../../lib/auth');
const { id, now, naira, todayLagos, addDays } = require('../../lib/util');
const { audit } = require('../../lib/audit');
const C = require('./common');

db.index('schedules', ['orgId', 'membershipId'], { unique: true });
db.index('schedules', ['acceptingBookings']);

const router = express.Router();
const MAX_DAYS_AHEAD = 60;
const TYPES = ['in_person', 'video'];

const scheduleRules = {
  weekly: t.arr(t.obj({ dow: t.int({ required: true, min: 0, max: 6, label: 'Day of week' }), start: t.time({ required: true, label: 'Start' }), end: t.time({ required: true, label: 'End' }) }), { max: 28 }),
  slotMin: t.enum([10, 15, 20, 30, 45, 60], { label: 'Slot length' }),
  feeKobo: t.money({ min: 0, max: naira(1000000), label: 'In-person fee' }),
  videoFeeKobo: t.money({ min: 0, max: naira(1000000), label: 'Video fee' }),
  types: t.arr(t.enum(TYPES), { min: 1, max: 2, label: 'Visit types' }),
  acceptingBookings: t.bool(),
  specialty: t.str({ max: 80 }), bio: t.str({ max: 1000 }), languages: t.arr(t.str({ max: 30 }), { max: 8 }),
};

function checkWeekly(weekly) {
  const byDay = {};
  for (const w of weekly) {
    if (C.minutes(w.start) >= C.minutes(w.end)) throw bad('Each working window must end after it starts');
    (byDay[w.dow] = byDay[w.dow] || []).push(w);
  }
  for (const list of Object.values(byDay)) {
    list.sort((a, b) => C.minutes(a.start) - C.minutes(b.start));
    for (let i = 1; i < list.length; i++) if (C.minutes(list[i].start) < C.minutes(list[i - 1].end)) throw bad('Working windows on the same day overlap');
  }
}

async function saveSchedule(req, m, b) {
  if (b.weekly) checkWeekly(b.weekly);
  if (b.types) b.types = [...new Set(b.types)];
  const existing = await db.col('schedules').findOne({ orgId: m.orgId, membershipId: m.id });
  const set = Object.assign({}, b, { updatedAt: now(), updatedBy: req.ctx.user.id });
  const onInsert = { id: id('sch'), orgId: m.orgId, membershipId: m.id, userId: m.userId, createdAt: now() };
  if (!existing) {
    const O = require('../orgs');
    const cons = await O.service(m.orgId, C.FEE_CODES.in_person), vid = await O.service(m.orgId, C.FEE_CODES.video);
    const org = await db.col('orgs').findOne({ id: m.orgId });
    const defaults = { weekly: [], slotMin: C.tun.slotMin(org), types: TYPES.slice(), acceptingBookings: !!(b.weekly && b.weekly.length), specialty: 'General practice', bio: null, languages: ['English'],
      feeKobo: cons ? cons.priceKobo : null, videoFeeKobo: vid ? vid.priceKobo : null };
    for (const [k, v] of Object.entries(defaults)) if (set[k] === undefined) onInsert[k] = v;
  }
  const s = await db.col('schedules').findOneAndUpdate({ orgId: m.orgId, membershipId: m.id }, { $set: set, $setOnInsert: onInsert }, { upsert: true });
  await audit(req, 'clinic.schedule_save', { type: 'schedule', id: s.id }, { membershipId: m.id, fields: Object.keys(b) });
  return s;
}

async function scheduleView(s, m, orgCache) {
  const org = await C.orgDoc(s.orgId, orgCache);
  const types = (s.types || []).filter(x => x !== 'video' || C.tun.video(org));
  return {
    membershipId: s.membershipId, name: await C.userName(m.userId), orgId: s.orgId, orgName: await C.orgName(s.orgId, orgCache),
    specialty: s.specialty || null, bio: s.bio || null, languages: s.languages || [], types, slotMin: s.slotMin, weekly: s.weekly || [],
    feeKobo: types.includes('in_person') ? await C.feeFor(s, s.orgId, 'in_person') : null,
    videoFeeKobo: types.includes('video') ? await C.feeFor(s, s.orgId, 'video') : null,
    acceptingBookings: !!s.acceptingBookings,
  };
}

/** booked intervals for a doctor PERSON across every provider they work at, on one Lagos date */
async function bookedIntervals(userId, date) {
  const r = C.dayRangeUtc(date);
  return db.col('appointments').find({ doctorUserId: userId, status: { $in: C.ACTIVE_APPT.concat(['completed', 'no_show']) }, startUtc: { $gte: r.start - 4 * 3600e3, $lt: r.end } });
}

/** may this caller see / book a doctor at this org? marketplace providers are public; others only for linked patients and own staff */
async function canSeeOrg(req, org) {
  if (!org || org.status !== 'active' || !(org.modules || []).includes('clinic')) return false;
  const P = require('../patients');
  const c = req.ctx || {};
  // provider mode: patients only see doctors of their own providers (any branch of their hospital group)
  if (c.kind === 'patient' && P.patientMode(org) === 'provider') return P.patientCanUse(req, org.id);
  if ((org.settings || {}).marketplace !== false && C.tun.marketplace(org) && P.patientMode(org) === 'open') return true;
  if (c.kind === 'staff' && c.org && c.org.id === org.id) return true;
  if (c.kind === 'patient') return !!(await P.linkOf(org.id, c.patient.id));
  return false;
}

/** listing used by the directory and the profile endpoint */
async function listedDoctor(req, membershipId) {
  const m = await db.col('memberships').findOne({ id: membershipId });
  if (!C.isDoctor(m)) return null;
  const org = await db.col('orgs').findOne({ id: m.orgId });
  if (!(await canSeeOrg(req, org))) return null;
  const s = await db.col('schedules').findOne({ orgId: m.orgId, membershipId: m.id });
  if (!s) return null;
  return { m, org, s };
}

async function slotsFor(s, m, date) {
  const all = C.scheduleSlots(s, date);
  const booked = await bookedIntervals(m.userId, date);
  const t0 = now() + 5 * 60000;
  return all.map(x => ({ time: x.time, startUtc: x.startUtc, endUtc: x.endUtc, available: !!s.acceptingBookings && x.startUtc > t0 && !booked.some(b => C.overlaps(b, x)) }));
}

/* ---------------- public directory ---------------- */
router.get('/doctors', ah(async (req, res) => {
  const q = query(req, { orgId: t.id(), specialty: t.str({ max: 80 }), q: t.str({ max: 60 }), type: t.enum(TYPES), limit: t.int({ min: 1, max: 200 }) });
  const f = { acceptingBookings: true }; if (q.orgId) f.orgId = q.orgId;
  // a patient in provider mode lists the chosen provider's doctors only
  if (req.ctx && req.ctx.kind === 'patient') { const sc = await require('../patients').patientScope(req); if (sc) f.orgId = q.orgId ? (sc.includes(q.orgId) ? q.orgId : '__none__') : { $in: sc }; }
  const scheds = await db.col('schedules').find(f, { limit: 2000 });
  const orgCache = {}, orgOk = {}, out = [];
  for (const s of scheds) {
    if (orgOk[s.orgId] === undefined) orgOk[s.orgId] = await canSeeOrg(req, await db.col('orgs').findOne({ id: s.orgId }));
    if (!orgOk[s.orgId]) continue;
    const m = await db.col('memberships').findOne({ id: s.membershipId, orgId: s.orgId });
    if (!C.isDoctor(m)) continue;
    const v = await scheduleView(s, m, orgCache);
    if (q.type && !v.types.includes(q.type)) continue;
    if (q.specialty && !String(v.specialty || '').toLowerCase().includes(q.specialty.toLowerCase())) continue;
    if (q.q) { const n = q.q.toLowerCase(); if (![v.name, v.specialty, v.orgName].some(x => String(x || '').toLowerCase().includes(n))) continue; }
    const org = await db.col('orgs').findOne({ id: s.orgId });
    v.orgArea = org && org.location ? org.location.area || null : null;
    out.push(v);
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  res.json(out.slice(0, q.limit || 100));
}));

router.get('/doctors/:membershipId', ah(async (req, res) => {
  const d = await listedDoctor(req, param(req, 'membershipId'));
  if (!d) throw notFound('Doctor not found');
  const v = await scheduleView(d.s, d.m);
  v.orgArea = d.org.location ? d.org.location.area || null : null;
  res.json(v);
}));

router.get('/doctors/:membershipId/slots', ah(async (req, res) => {
  const q = query(req, { date: t.date({ required: true }) });
  const d = await listedDoctor(req, param(req, 'membershipId'));
  if (!d) throw notFound('Doctor not found');
  const today = todayLagos();
  if (q.date < today || q.date > addDays(today, MAX_DAYS_AHEAD)) return res.json({ membershipId: d.m.id, date: q.date, slotMin: d.s.slotMin, types: d.s.types, slots: [] });
  res.json({ membershipId: d.m.id, date: q.date, slotMin: d.s.slotMin, types: d.s.types, acceptingBookings: !!d.s.acceptingBookings, slots: await slotsFor(d.s, d.m, q.date) });
}));

/* ---------------- doctor: own schedule ---------------- */
const docGuard = A.requireStaff({ perm: 'clinic.consult', module: 'clinic' });
router.get('/doc/schedule', docGuard, ah(async (req, res) => {
  const m = req.ctx.membership;
  const s = await db.col('schedules').findOne({ orgId: req.ctx.org.id, membershipId: m.id });
  res.json(s ? Object.assign(await scheduleView(s, m), { configured: true }) : { configured: false, membershipId: m.id, name: req.ctx.user.name, orgId: req.ctx.org.id, weekly: [], types: [], acceptingBookings: false });
}));
router.put('/doc/schedule', docGuard, ah(async (req, res) => {
  const b = body(req, scheduleRules);
  const s = await saveSchedule(req, req.ctx.membership, b);
  res.json(Object.assign(await scheduleView(s, req.ctx.membership), { configured: true }));
}));

/* ---------------- admin: every doctor at the provider ---------------- */
router.get('/admin/doctors', A.requireStaff({ anyPerm: ['admin.settings', 'admin.staff', 'admin.finance'] }), ah(async (req, res) => {
  const ms = (await db.col('memberships').find({ orgId: req.ctx.org.id, status: 'active' })).filter(C.isDoctor);
  const out = [];
  for (const m of ms) {
    const s = await db.col('schedules').findOne({ orgId: req.ctx.org.id, membershipId: m.id });
    out.push(s ? Object.assign(await scheduleView(s, m), { configured: true }) : { configured: false, membershipId: m.id, name: await C.userName(m.userId), orgId: m.orgId, weekly: [], types: [], acceptingBookings: false });
  }
  res.json(out);
}));
router.put('/admin/doctors/:membershipId/schedule', A.requireStaff({ perm: 'admin.settings' }), ah(async (req, res) => {
  const m = await C.doctorAt(req.ctx.org.id, param(req, 'membershipId'));
  const b = body(req, scheduleRules);
  const s = await saveSchedule(req, m, b);
  res.json(Object.assign(await scheduleView(s, m), { configured: true }));
}));

module.exports = { router, saveSchedule, scheduleView, slotsFor, bookedIntervals, canSeeOrg, MAX_DAYS_AHEAD, TYPES };
