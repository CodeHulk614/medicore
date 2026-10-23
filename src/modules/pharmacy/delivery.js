'use strict';
/*
 * Delivery: dispatcher, riders, live location from the rider's phone, and a 6-digit delivery
 * code the patient shows at the door. Generic over `kind` ('medication' now; lab sample
 * collection can reuse it later).
 *
 *   pending -> assigned -> picked_up -> delivered
 *                       \-> pending (unassigned)    \-> failed (reason) -> returned -> pending (retry)
 *   pending | assigned -> cancelled (the order was cancelled before hand-over)
 *
 * The rx order moves with it: ready -> out_for_delivery (picked up) -> delivered, and back to
 * ready when a failed delivery is returned to the pharmacy.
 */
const express = require('express');
const db = require('../../db');
const { ah, body, query, t, bad, forbidden, notFound, conflict, locked, param } = require('../../lib/http');
const { id, now, haversineKm, etaMinutes } = require('../../lib/util');
const { audit } = require('../../lib/audit');
const { notify } = require('../../lib/notify');
const A = require('../../lib/auth');
const RL = require('../../lib/ratelimit');
const C = require('./common');

const router = express.Router();

const D_TRANSITIONS = {
  pending: ['assigned', 'cancelled'],
  assigned: ['assigned', 'pending', 'picked_up', 'cancelled'],
  picked_up: ['delivered', 'failed'],
  failed: ['returned'],
  returned: ['pending'],
  delivered: [], cancelled: [],
};
const LIVE = ['pending', 'assigned', 'picked_up', 'failed', 'returned'];

async function dTransition(deliveryId, orgId, from, to, set, by, note, extraFilter) {
  const ok = (Array.isArray(from) ? from : [from]).filter(s => D_TRANSITIONS[s] && D_TRANSITIONS[s].includes(to));
  if (!ok.length) return null;
  return db.col('deliveries').findOneAndUpdate(Object.assign({ id: deliveryId, orgId, status: { $in: ok } }, extraFilter || {}),
    { $set: Object.assign({}, set || {}, { status: to, updatedAt: now() }), $push: { timeline: { status: to, at: now(), by: by || null, note: note || null } } });
}
async function mustD(req, d, from, to, set, note, extraFilter) {
  const r = await dTransition(d.id, d.orgId, from, to, set, req.ctx.user.id, note, extraFilter);
  if (!r) { const cur = await db.col('deliveries').findOne({ id: d.id, orgId: d.orgId }); throw conflict('This delivery is ' + (cur ? cur.status : 'gone') + '. It cannot move to ' + to + '.', 'wrong_state'); }
  return r;
}

async function createDelivery({ orgId, kind, rxOrderId, patientId, address, location }) {
  const did = id('dlv');
  const code = C.newCode('delivery', did);
  const d = { id: did, orgId, kind: kind || 'medication', rxOrderId: rxOrderId || null, patientId, address: address || null, location: location || null, status: 'pending',
    riderMembershipId: null, riderUserId: null, codeHash: code.hash, codeNonce: code.nonce, codeAttempts: 0, locked: false, attempts: 1, failReason: null, failNote: null,
    lastLoc: null, timeline: [{ status: 'pending', at: now(), by: null, note: null }], createdAt: now(), updatedAt: now() };
  await db.col('deliveries').insertOne(d);
  await notify({ orgId, role: 'delivery_dispatcher', title: 'New delivery to assign', body: 'An order is packed and waiting for a rider.', kind: 'delivery', ref: { type: 'delivery', id: did } });
  return d;
}

/* ---------- riders ---------- */
async function riderMemberships(orgId) { return db.col('memberships').find({ orgId, role: 'rider', status: 'active' }); }
async function onDuty(org, membershipId) {
  if (org.settings && org.settings.requireClockIn === false) return true;
  return !!(await db.col('shifts').findOne({ membershipId, out: null }));
}
const firstName = n => String(n || '').replace(/^(mr|mrs|ms|dr|pharm)\.?\s+/i, '').split(/\s+/)[0] || null;
async function riderRow(org, m) {
  const u = await db.col('users').findOne({ id: m.userId }, { projection: { name: 1, phone: 1 } });
  const p = await db.col('rider_profiles').findOne({ membershipId: m.id, orgId: org.id });
  const active = await db.col('deliveries').count({ orgId: org.id, riderMembershipId: m.id, status: { $in: ['assigned', 'picked_up'] } });
  return { membershipId: m.id, name: u ? u.name : 'Rider', phone: u ? u.phone || null : null, profileId: p ? p.id : null, status: p ? p.status : 'no_profile', vehicle: p ? p.vehicle : null, plate: p ? p.plate : null, licence: p ? p.licence : null,
    onDuty: await onDuty(org, m.id), activeJobs: active, lastLoc: p && p.lastLoc ? Object.assign({ fresh: now() - p.lastLoc.at < C.freshMs(org) }, p.lastLoc) : null };
}
const profileRules = { vehicle: t.enum(['motorcycle', 'bicycle', 'car', 'van', 'tricycle', 'on_foot']), plate: t.str({ max: 20, upper: true }), licence: t.str({ max: 40, label: 'Licence number' }) };

router.get('/delivery/riders', C.G.riderAdmin, ah(async (req, res) => {
  const out = []; for (const m of await riderMemberships(req.ctx.org.id)) out.push(await riderRow(req.ctx.org, m));
  res.json(out);
}));
router.post('/delivery/riders', C.G.riderAdmin, ah(async (req, res) => {
  const b = body(req, Object.assign({ membershipId: t.id({ required: true }), status: t.enum(['pending', 'verified', 'suspended']) }, profileRules));
  const m = await db.col('memberships').findOne({ id: b.membershipId, orgId: req.ctx.org.id, role: 'rider' });
  if (!m) throw notFound('Rider not found');
  const ex = await db.col('rider_profiles').findOne({ membershipId: m.id, orgId: req.ctx.org.id });
  if (ex) throw conflict('This rider already has a profile. Update it instead.');
  const p = { id: id('rdp'), orgId: req.ctx.org.id, membershipId: m.id, userId: m.userId, vehicle: b.vehicle || null, plate: b.plate || null, licence: b.licence || null, status: b.status || 'pending', lastLoc: null, createdAt: now(), updatedAt: now() };
  if (p.status === 'verified') { if (!p.vehicle || !p.licence) throw bad('Record the vehicle and licence before verifying a rider'); p.verifiedBy = req.ctx.user.id; p.verifiedAt = now(); }
  await db.col('rider_profiles').insertOne(p);
  await audit(req, 'delivery.rider_profile_create', { type: 'rider_profile', id: p.id }, { status: p.status });
  res.json(await riderRow(req.ctx.org, m));
}));
router.patch('/delivery/riders/:id', C.G.riderAdmin, ah(async (req, res) => {
  const b = body(req, Object.assign({ status: t.enum(['pending', 'verified', 'suspended']) }, profileRules));
  if (!Object.keys(b).length) throw bad('Nothing to change');
  const cur = await db.col('rider_profiles').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!cur) throw notFound('Rider profile not found');
  const next = Object.assign({}, cur, b);
  const set = Object.assign({ updatedAt: now() }, b);
  if (b.status === 'verified' && cur.status !== 'verified') { if (!next.vehicle || !next.licence) throw bad('Record the vehicle and licence before verifying a rider'); set.verifiedBy = req.ctx.user.id; set.verifiedAt = now(); }
  const p = await db.col('rider_profiles').findOneAndUpdate({ id: cur.id, orgId: req.ctx.org.id }, { $set: set });
  await audit(req, 'delivery.rider_profile_update', { type: 'rider_profile', id: p.id }, { fields: Object.keys(b), status: p.status });
  const m = await db.col('memberships').findOne({ id: p.membershipId, orgId: req.ctx.org.id });
  res.json(await riderRow(req.ctx.org, m));
}));

/* ---------- dispatcher ---------- */
async function loadOrgDelivery(req) { const d = await db.col('deliveries').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id }); if (!d) throw notFound('Delivery not found'); return d; }
async function dispatchView(d) {
  const org = await db.col('orgs').findOne({ id: d.orgId });
  const p = await db.col('patients').findOne({ id: d.patientId }, { projection: { firstName: 1, lastName: 1, phone: 1 } });
  let rider = null;
  if (d.riderMembershipId) { const m = await db.col('memberships').findOne({ id: d.riderMembershipId }); const u = m ? await db.col('users').findOne({ id: m.userId }, { projection: { name: 1, phone: 1 } }) : null; rider = { membershipId: d.riderMembershipId, name: u ? u.name : null, phone: u ? u.phone || null : null }; }
  const v = Object.assign({}, d); delete v.codeHash; delete v.codeNonce;
  v.patient = p ? { firstName: p.firstName, lastInitial: (p.lastName || '').slice(0, 1), phone: p.phone || null } : null;
  v.rider = rider;
  v.lastLoc = d.lastLoc ? Object.assign({ fresh: now() - d.lastLoc.at < C.freshMs(org) }, d.lastLoc) : null;
  return v;
}
router.get('/delivery/board', C.G.dispatch, ah(async (req, res) => {
  const counts = await db.col('deliveries').aggregateCount({ orgId: req.ctx.org.id, status: { $in: LIVE } }, 'status');
  const riders = []; for (const m of await riderMemberships(req.ctx.org.id)) riders.push(await riderRow(req.ctx.org, m));
  res.json({ counts, ridersOnDuty: riders.filter(r => r.onDuty && r.status === 'verified').length, riders, selfClaim: !!(req.ctx.org.settings || {}).selfClaimDeliveries, lockedCount: await db.col('deliveries').count({ orgId: req.ctx.org.id, locked: true, status: 'picked_up' }) });
}));
router.get('/delivery/deliveries', C.G.dispatchOrPharmacy, ah(async (req, res) => {
  const q = query(req, { status: t.enum(Object.keys(D_TRANSITIONS)), active: t.bool(), riderMembershipId: t.id(), limit: t.int({ min: 1, max: 500 }) });
  const f = { orgId: req.ctx.org.id }; if (q.status) f.status = q.status; else if (q.active) f.status = { $in: LIVE }; if (q.riderMembershipId) f.riderMembershipId = q.riderMembershipId;
  const rows = await db.col('deliveries').find(f, { sort: { createdAt: -1 }, limit: q.limit || 100 });
  const out = []; for (const d of rows) out.push(await dispatchView(d));
  res.json(out);
}));
router.get('/delivery/deliveries/:id', C.G.dispatchOrPharmacy, ah(async (req, res) => { res.json(await dispatchView(await loadOrgDelivery(req))); }));

async function checkRiderAssignable(org, membershipId) {
  const m = await db.col('memberships').findOne({ id: membershipId, orgId: org.id, role: 'rider', status: 'active' });
  if (!m) throw notFound('Rider not found');
  const p = await db.col('rider_profiles').findOne({ membershipId: m.id, orgId: org.id });
  if (!p || p.status !== 'verified') throw conflict('This rider is not verified yet', 'rider_not_verified');
  if (!(await onDuty(org, m.id))) throw conflict('This rider is not on duty (not clocked in)', 'rider_off_duty');
  return m;
}
router.post('/delivery/deliveries/:id/assign', C.G.dispatch, C.G.onShift, ah(async (req, res) => {
  const b = body(req, { riderMembershipId: t.id({ required: true }) });
  const d = await loadOrgDelivery(req);
  const m = await checkRiderAssignable(req.ctx.org, b.riderMembershipId);
  const upd = await mustD(req, d, ['pending', 'assigned'], 'assigned', { riderMembershipId: m.id, riderUserId: m.userId, assignedAt: now(), assignedBy: req.ctx.user.id }, d.status === 'assigned' ? 'reassigned' : null);
  await notify({ userId: m.userId, title: 'New delivery job', body: 'You have a delivery to pick up at ' + req.ctx.org.name + '.', kind: 'delivery', ref: { type: 'delivery', id: d.id } });
  await audit(req, 'delivery.assign', { type: 'delivery', id: d.id, patientId: d.patientId }, { riderMembershipId: m.id });
  res.json(await dispatchView(upd));
}));
router.post('/delivery/deliveries/:id/unassign', C.G.dispatch, C.G.onShift, ah(async (req, res) => {
  const d = await loadOrgDelivery(req);
  const upd = await mustD(req, d, ['assigned'], 'pending', { riderMembershipId: null, riderUserId: null });
  await audit(req, 'delivery.unassign', { type: 'delivery', id: d.id, patientId: d.patientId });
  res.json(await dispatchView(upd));
}));

/** hand-over from the pharmacy to the rider: delivery assigned -> picked_up AND order ready -> out_for_delivery */
async function pickUp(req, d) {
  const extra = { riderMembershipId: d.riderMembershipId };
  if (d.rxOrderId) {
    const o = await db.col('rx_orders').findOne({ id: d.rxOrderId, pharmacyOrgId: d.orgId });
    if (!o || o.status !== 'ready') throw conflict('The order is not ready for hand-over' + (o ? ' (it is ' + o.status + ')' : ''), 'order_not_ready');
  }
  const upd = await mustD(req, d, ['assigned'], 'picked_up', { pickedUpAt: now(), handedOverBy: req.ctx.user.id }, null, extra);
  if (d.rxOrderId) {
    const O = require('./orders');
    const o = await O.transition(d.rxOrderId, d.orgId, ['ready'], 'out_for_delivery', { outForDeliveryAt: now() }, req.ctx.user.id, null, { deliveryId: d.id });
    if (!o) {
      await db.col('deliveries').updateOne({ id: d.id, orgId: d.orgId, status: 'picked_up' }, { $set: { status: 'assigned', pickedUpAt: null }, $push: { timeline: { status: 'assigned', at: now(), by: req.ctx.user.id, note: 'hand-over reverted: order not ready' } } });
      throw conflict('The order is not ready for hand-over', 'order_not_ready');
    }
  }
  const p = await db.col('patients').findOne({ id: d.patientId }, { projection: { phone: 1 } });
  const m = await db.col('memberships').findOne({ id: d.riderMembershipId }); const u = m ? await db.col('users').findOne({ id: m.userId }, { projection: { name: 1 } }) : null;
  await notify({ patientId: d.patientId, title: 'Your delivery is on the way', body: (firstName(u && u.name) || 'Your rider') + ' is coming. Show the rider this code: ' + C.codeFor('delivery', d.id, d.codeNonce), kind: 'delivery', ref: { type: 'delivery', id: d.id }, sms: p && p.phone });
  await audit(req, 'delivery.pickup', { type: 'delivery', id: d.id, patientId: d.patientId });
  return upd;
}
router.post('/delivery/deliveries/:id/handover', C.G.dispatchOrPharmacy, C.G.onShift, ah(async (req, res) => {
  const d = await loadOrgDelivery(req);
  if (d.status !== 'assigned') throw conflict('Assign a rider before hand-over', 'wrong_state');
  res.json(await dispatchView(await pickUp(req, d)));
}));
router.post('/delivery/deliveries/:id/returned', C.G.dispatchOrPharmacy, C.G.onShift, ah(async (req, res) => {
  const d = await loadOrgDelivery(req);
  const upd = await mustD(req, d, ['failed'], 'returned', { returnedAt: now(), returnedTo: req.ctx.user.id });
  if (d.rxOrderId) { const O = require('./orders'); await O.transition(d.rxOrderId, d.orgId, ['out_for_delivery'], 'ready', {}, req.ctx.user.id, 'returned to pharmacy after failed delivery', { deliveryId: d.id }); }
  await audit(req, 'delivery.returned', { type: 'delivery', id: d.id, patientId: d.patientId });
  res.json(await dispatchView(upd));
}));
router.post('/delivery/deliveries/:id/retry', C.G.dispatch, C.G.onShift, ah(async (req, res) => {
  const d = await loadOrgDelivery(req);
  const upd = await mustD(req, d, ['returned'], 'pending', { riderMembershipId: null, riderUserId: null, attempts: (d.attempts || 1) + 1, failReason: null, failNote: null }, null, { attempts: d.attempts });
  await audit(req, 'delivery.retry', { type: 'delivery', id: d.id, patientId: d.patientId }, { attempt: upd.attempts });
  res.json(await dispatchView(upd));
}));
router.post('/delivery/deliveries/:id/unlock', C.G.dispatch, C.G.onShift, ah(async (req, res) => {
  const d = await loadOrgDelivery(req);
  const code = C.newCode('delivery', d.id);
  const upd = await db.col('deliveries').findOneAndUpdate({ id: d.id, orgId: req.ctx.org.id, locked: true, status: 'picked_up' }, { $set: { locked: false, codeAttempts: 0, codeHash: code.hash, codeNonce: code.nonce, updatedAt: now() }, $push: { timeline: { status: 'picked_up', at: now(), by: req.ctx.user.id, note: 'delivery code reset' } } });
  if (!upd) throw conflict('This delivery is not locked', 'wrong_state');
  const p = await db.col('patients').findOne({ id: d.patientId }, { projection: { phone: 1 } });
  await notify({ patientId: d.patientId, title: 'New delivery code', body: 'Your new delivery code is ' + code.code, kind: 'delivery', ref: { type: 'delivery', id: d.id }, sms: p && p.phone });
  await audit(req, 'delivery.unlock', { type: 'delivery', id: d.id, patientId: d.patientId });
  res.json(await dispatchView(upd));
}));

/* ---------- rider app ---------- */
async function myProfile(req) { return db.col('rider_profiles').findOne({ membershipId: req.ctx.membership.id, orgId: req.ctx.org.id }); }
async function requireActiveRider(req) { const p = await myProfile(req); if (!p || p.status !== 'verified') throw forbidden('Your rider profile is not verified yet. Ask your dispatcher.'); return p; }
async function loadMyJob(req) {
  const d = await db.col('deliveries').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id, riderMembershipId: req.ctx.membership.id });
  if (!d) throw notFound('Job not found');
  return d;
}
async function riderJobView(req, d) {
  const live = ['assigned', 'picked_up'].includes(d.status);
  const p = await db.col('patients').findOne({ id: d.patientId }, { projection: { firstName: 1, phone: 1 } });
  const org = req.ctx.org;
  return { id: d.id, kind: d.kind, status: d.status, attempts: d.attempts, locked: !!d.locked, codeTriesLeft: Math.max(0, C.codeTries(req.ctx.org) - (d.codeAttempts || 0)),
    patient: p ? { firstName: p.firstName, phone: live ? p.phone || null : null } : null, address: live ? d.address : null, location: live ? d.location : null,
    pickup: { name: org.name, address: (org.contact || {}).address || null, location: org.location ? { lat: org.location.lat, lng: org.location.lng } : null },
    distanceKm: live && d.location && d.lastLoc ? Math.round(haversineKm(d.lastLoc, d.location) * 10) / 10 : null, assignedAt: d.assignedAt || null, pickedUpAt: d.pickedUpAt || null, deliveredAt: d.deliveredAt || null, failReason: d.failReason || null };
}
router.get('/rider/profile', C.G.ride, ah(async (req, res) => {
  const p = await myProfile(req);
  res.json(p ? { id: p.id, status: p.status, vehicle: p.vehicle, plate: p.plate, licence: p.licence, verifiedAt: p.verifiedAt || null } : { status: 'no_profile' });
}));
router.put('/rider/profile', C.G.ride, ah(async (req, res) => {
  const b = body(req, { vehicle: t.enum(['motorcycle', 'bicycle', 'car', 'van', 'tricycle', 'on_foot'], { required: true }), plate: t.str({ max: 20, upper: true }), licence: t.str({ required: true, max: 40, label: 'Licence number' }) });
  const cur = await myProfile(req);
  if (cur && cur.status === 'suspended') throw forbidden('Your rider profile is suspended');
  const changed = !cur || cur.vehicle !== b.vehicle || (cur.plate || null) !== (b.plate || null) || cur.licence !== b.licence;
  const p = await db.col('rider_profiles').findOneAndUpdate({ membershipId: req.ctx.membership.id, orgId: req.ctx.org.id },
    { $set: Object.assign({ vehicle: b.vehicle, plate: b.plate || null, licence: b.licence, updatedAt: now() }, changed ? { status: 'pending' } : {}), $setOnInsert: { id: id('rdp'), orgId: req.ctx.org.id, membershipId: req.ctx.membership.id, userId: req.ctx.user.id, createdAt: now(), lastLoc: null } }, { upsert: true });
  if (changed) await notify({ orgId: req.ctx.org.id, role: 'delivery_dispatcher', title: 'Rider details to verify', body: 'A rider updated their vehicle or licence details.', kind: 'rider', ref: { type: 'rider_profile', id: p.id } });
  await audit(req, 'rider.profile_update', { type: 'rider_profile', id: p.id }, { reverify: changed });
  res.json({ id: p.id, status: p.status, vehicle: p.vehicle, plate: p.plate, licence: p.licence });
}));
router.get('/rider/jobs', C.G.ride, ah(async (req, res) => {
  const active = await db.col('deliveries').find({ orgId: req.ctx.org.id, riderMembershipId: req.ctx.membership.id, status: { $in: ['assigned', 'picked_up', 'failed'] } }, { sort: { assignedAt: 1 } });
  const recent = await db.col('deliveries').find({ orgId: req.ctx.org.id, riderMembershipId: req.ctx.membership.id, status: { $in: ['delivered', 'returned', 'cancelled'] } }, { sort: { updatedAt: -1 }, limit: 20 });
  const out = { active: [], recent: [] };
  for (const d of active) out.active.push(await riderJobView(req, d));
  for (const d of recent) out.recent.push(await riderJobView(req, d));
  res.json(out);
}));
router.get('/rider/available', C.G.ride, ah(async (req, res) => {
  if (!(req.ctx.org.settings || {}).selfClaimDeliveries) return res.json([]);
  const rows = await db.col('deliveries').find({ orgId: req.ctx.org.id, status: 'pending' }, { sort: { createdAt: 1 }, limit: 50 });
  res.json(rows.map(d => ({ id: d.id, kind: d.kind, createdAt: d.createdAt, area: d.address ? String(d.address).split(',').slice(-1)[0].trim() : null, distanceKm: d.location && req.ctx.org.location ? Math.round(haversineKm(req.ctx.org.location, d.location) * 10) / 10 : null })));
}));
router.get('/rider/jobs/:id', C.G.ride, ah(async (req, res) => { res.json(await riderJobView(req, await loadMyJob(req))); }));
router.post('/rider/jobs/:id/claim', C.G.ride, C.G.onShift, ah(async (req, res) => {
  if (!(req.ctx.org.settings || {}).selfClaimDeliveries) throw forbidden('Your dispatcher assigns deliveries. Self-claim is switched off.');
  await requireActiveRider(req);
  const d = await db.col('deliveries').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!d) throw notFound('Job not found');
  const upd = await mustD(req, d, ['pending'], 'assigned', { riderMembershipId: req.ctx.membership.id, riderUserId: req.ctx.user.id, assignedAt: now(), assignedBy: req.ctx.user.id }, 'claimed by rider');
  await audit(req, 'rider.claim', { type: 'delivery', id: d.id, patientId: d.patientId });
  res.json(await riderJobView(req, upd));
}));
router.post('/rider/jobs/:id/pickup', C.G.ride, C.G.onShift, ah(async (req, res) => {
  await requireActiveRider(req);
  const d = await loadMyJob(req);
  if (d.status !== 'assigned') throw conflict('This job is ' + d.status, 'wrong_state');
  res.json(await riderJobView(req, await pickUp(req, d)));
}));
router.post('/rider/location', C.G.ride, C.G.onShift, ah(async (req, res) => {
  const b = body(req, { lat: t.lat({ required: true }), lng: t.lng({ required: true }), accuracy: t.num({ min: 0, max: 100000 }), heading: t.num({ min: 0, max: 360 }), speed: t.num({ min: 0, max: 100 }) });
  await RL.limit('riderloc_' + req.ctx.membership.id, 30, 60, 'Location updates are too frequent');
  const loc = { lat: b.lat, lng: b.lng, accuracy: b.accuracy == null ? null : b.accuracy, heading: b.heading == null ? null : b.heading, speed: b.speed == null ? null : b.speed, at: now() };
  const p = await db.col('rider_profiles').findOneAndUpdate({ membershipId: req.ctx.membership.id, orgId: req.ctx.org.id }, { $set: { lastLoc: loc } });
  if (!p) throw forbidden('Set up your rider profile first');
  const r = await db.col('deliveries').updateMany({ orgId: req.ctx.org.id, riderMembershipId: req.ctx.membership.id, status: { $in: ['assigned', 'picked_up'] } }, { $set: { lastLoc: loc } });
  res.json({ ok: true, at: loc.at, jobsUpdated: r.modified });
}));
router.post('/rider/jobs/:id/deliver', C.G.ride, C.G.onShift, ah(async (req, res) => {
  const b = body(req, { code: t.str({ required: true, max: 6, pattern: /^\d{6}$/, label: 'Delivery code' }), lat: t.lat(), lng: t.lng() });
  await requireActiveRider(req);
  const d = await loadMyJob(req);
  if (d.status !== 'picked_up') throw conflict('This job is ' + d.status, 'wrong_state');
  if (d.locked) throw locked('Too many wrong codes. Your dispatcher must reset the delivery code.', 'code_locked');
  const tries = C.codeTries(req.ctx.org);
  if (!C.codeMatches('delivery', d.id, b.code, d.codeHash)) {
    const after = await db.col('deliveries').findOneAndUpdate({ id: d.id, orgId: d.orgId, status: 'picked_up', locked: false, codeAttempts: { $lt: tries } }, { $inc: { codeAttempts: 1 } });
    if (after && after.codeAttempts >= tries) {
      const lockedNow = await db.col('deliveries').findOneAndUpdate({ id: d.id, orgId: d.orgId, locked: false }, { $set: { locked: true, lockedAt: now() } });
      if (lockedNow) await notify({ orgId: d.orgId, role: 'delivery_dispatcher', title: 'Delivery code locked', body: 'A rider entered too many wrong delivery codes. Call the patient and reset the code.', kind: 'delivery_alert', ref: { type: 'delivery', id: d.id } });
    }
    await audit(req, 'rider.code_wrong', { type: 'delivery', id: d.id, patientId: d.patientId }, { attempts: after ? after.codeAttempts : null });
    if (!after || after.codeAttempts >= tries) throw locked('Too many wrong codes. Your dispatcher must reset the delivery code.', 'code_locked');
    throw bad('That delivery code is not correct. ' + (tries - after.codeAttempts) + ' tries left.');
  }
  const upd = await mustD(req, d, ['picked_up'], 'delivered', { deliveredAt: now(), deliveredLoc: b.lat != null && b.lng != null ? { lat: b.lat, lng: b.lng } : null }, null, { locked: false, codeHash: d.codeHash, riderMembershipId: req.ctx.membership.id });
  if (d.rxOrderId) { const O = require('./orders'); await O.transition(d.rxOrderId, d.orgId, ['out_for_delivery'], 'delivered', { deliveredAt: now() }, req.ctx.user.id, null, { deliveryId: d.id }); }
  await notify({ patientId: d.patientId, title: 'Delivered', body: 'Your order from ' + req.ctx.org.name + ' has been delivered.', kind: 'delivery', ref: { type: 'delivery', id: d.id } });
  await audit(req, 'rider.deliver', { type: 'delivery', id: d.id, patientId: d.patientId });
  res.json(await riderJobView(req, upd));
}));
router.post('/rider/jobs/:id/fail', C.G.ride, C.G.onShift, ah(async (req, res) => {
  const b = body(req, { reason: t.enum(['patient_unreachable', 'patient_absent', 'wrong_address', 'patient_refused', 'unsafe_area', 'vehicle_problem', 'other'], { required: true }), note: t.str({ max: 300 }) });
  if (b.reason === 'other' && !b.note) throw bad('Add a short note');
  const d = await loadMyJob(req);
  const upd = await mustD(req, d, ['picked_up'], 'failed', { failedAt: now(), failReason: b.reason, failNote: b.note || null }, b.reason, { riderMembershipId: req.ctx.membership.id });
  await notify({ orgId: d.orgId, role: 'delivery_dispatcher', title: 'Delivery failed', body: 'A rider could not complete a delivery. Bring the order back to the pharmacy.', kind: 'delivery_alert', ref: { type: 'delivery', id: d.id } });
  await notify({ patientId: d.patientId, title: 'We could not deliver your order', body: 'The pharmacy will contact you to arrange another attempt.', kind: 'delivery', ref: { type: 'delivery', id: d.id } });
  await audit(req, 'rider.fail', { type: 'delivery', id: d.id, patientId: d.patientId }, { reason: b.reason });
  res.json(await riderJobView(req, upd));
}));

/* ---------- patient tracking ---------- */
async function patientDeliveryView(d) {
  const org = await db.col('orgs').findOne({ id: d.orgId });
  let rider = null; let riderLocation = null; let eta = null;
  if (d.riderMembershipId && ['assigned', 'picked_up'].includes(d.status)) {
    const m = await db.col('memberships').findOne({ id: d.riderMembershipId }); const u = m ? await db.col('users').findOne({ id: m.userId }, { projection: { name: 1 } }) : null;
    const p = await db.col('rider_profiles').findOne({ membershipId: d.riderMembershipId });
    rider = { firstName: firstName(u && u.name), vehicle: p ? p.vehicle : null };
    if (d.status === 'picked_up' && d.lastLoc && now() - d.lastLoc.at < C.freshMs(org)) {
      riderLocation = { lat: d.lastLoc.lat, lng: d.lastLoc.lng, heading: d.lastLoc.heading, at: d.lastLoc.at };
      if (d.location) eta = etaMinutes(haversineKm(d.lastLoc, d.location));
    }
  }
  return { id: d.id, kind: d.kind, status: d.status, rxOrderId: d.rxOrderId, pharmacy: org ? { name: org.name, phone: (org.contact || {}).phone || null } : null, address: d.address, destination: d.location,
    rider, riderLocation, etaMinutes: eta, deliveryCode: ['pending', 'assigned', 'picked_up'].includes(d.status) && !d.locked ? C.codeFor('delivery', d.id, d.codeNonce) : null, codeLocked: !!d.locked,
    timeline: (d.timeline || []).map(x => ({ status: x.status, at: x.at })), createdAt: d.createdAt, deliveredAt: d.deliveredAt || null };
}
router.get('/me/deliveries', A.requirePatient, ah(async (req, res) => {
  const rows = await db.col('deliveries').find(Object.assign({ patientId: req.ctx.patient.id }, await require('../patients').scopeFilter(req)), { sort: { createdAt: -1 }, limit: 50 });
  const out = []; for (const d of rows) out.push(await patientDeliveryView(d));
  res.json(out);
}));
router.get('/me/deliveries/:id', A.requirePatient, ah(async (req, res) => {
  const d = await db.col('deliveries').findOne({ id: param(req, 'id'), patientId: req.ctx.patient.id });
  if (!d) throw notFound('Delivery not found');
  res.json(await patientDeliveryView(d));
}));

module.exports = { router, D_TRANSITIONS, createDelivery, dTransition };
