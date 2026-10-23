'use strict';
/*
 * Ambulance: fleet, crew, incidents (dispatch board, crew app, patient SOS, public emergency line),
 * destination pre-alerts for receiving front desks, response metrics.
 *
 * Works for a standalone ambulance service and for a hospital's own fleet: everything is scoped to
 * the provider (orgId) that owns the incident and the unit.
 *
 * Rules (v1 audit fixes):
 *  - No simulated movement. Unit position comes only from crew phone GPS posts
 *    (POST /api/crew/location). A demo-only stepper exists when DEMO_MODE is on, as a POST.
 *  - Every status change is a conditional update from an allowed FROM state (TRANSITIONS),
 *    so a double tap or two dispatchers cannot assign twice, close twice or bill twice.
 *  - A unit is claimed with a conditional update on its availability, so two dispatchers
 *    cannot assign the same unit.
 *  - Crew can only act on the incident assigned to their own unit at their own provider.
 */
const express = require('express');
const db = require('../db');
const config = require('../config');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param } = require('../lib/http');
const A = require('../lib/auth');
const { id, now, sha256, haversineKm, etaMinutes, todayLagos, daysBetween, addDays } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const RL = require('../lib/ratelimit');
const S = require('../lib/settings');
const P = require('./patients');
const orgs = require('./orgs');
const billing = require('./billing');

db.index('amb_units', ['orgId', 'availability']);
db.index('amb_crew', ['orgId', 'membershipId'], { unique: true });
db.index('incidents', ['orgId', 'status', 'createdAt']);
db.index('incidents', ['patientId', 'createdAt']);
db.index('incidents', ['destination.orgId', 'status']);
db.index('incidents', ['patientOpenKey'], { unique: true, sparse: true }); // one open emergency per patient
db.index('incident_track', ['incidentId', 'at']);

const router = express.Router();

/* ---------------- reference data ---------------- */
const CATEGORIES = {
  cardiac_arrest: { label: 'Cardiac arrest', priority: 'P1' },
  breathing_difficulty: { label: 'Breathing difficulty', priority: 'P1' },
  unconscious: { label: 'Unconscious', priority: 'P1' },
  stroke_symptoms: { label: 'Stroke symptoms', priority: 'P1' },
  obstetric_emergency: { label: 'Obstetric emergency', priority: 'P1' },
  road_traffic_accident: { label: 'Road traffic accident', priority: 'P2' },
  bleeding: { label: 'Bleeding', priority: 'P2' },
  burns: { label: 'Burns', priority: 'P2' },
  seizure: { label: 'Seizure', priority: 'P2' },
  trauma_fall: { label: 'Trauma / fall', priority: 'P2' },
  other: { label: 'Other', priority: 'P3' },
};
const CAT_KEYS = Object.keys(CATEGORIES);
const PRIORITIES = ['P1', 'P2', 'P3'];
const UNIT_TYPES = ['BLS', 'ALS', 'motorbike', 'transfer'];
const UNIT_STATUS = ['in_service', 'maintenance', 'retired'];
const AVAIL = ['available', 'assigned', 'enroute', 'onscene', 'transporting', 'athospital', 'returning', 'offline'];
const CERTS = ['EMT-B', 'EMT-I', 'Paramedic', 'Driver'];
const SOURCES = ['app', 'call', 'public', 'transfer', 'ussd'];

const OPEN = ['new', 'assigned', 'enroute', 'onscene', 'transporting', 'athospital'];
const TRANSITIONS = {
  new: ['assigned', 'cancelled'],
  assigned: ['assigned', 'enroute', 'cancelled'], // assigned -> assigned is a reassignment
  enroute: ['assigned', 'onscene', 'cancelled'],
  onscene: ['transporting', 'closed', 'cancelled'], // closed from onscene: treated on scene / no transport
  transporting: ['athospital'],
  athospital: ['closed'],
  closed: [],
  cancelled: [],
};
const fromStates = to => Object.keys(TRANSITIONS).filter(s => TRANSITIONS[s].includes(to));
const UNIT_AVAIL_FOR = { assigned: 'assigned', enroute: 'enroute', onscene: 'onscene', transporting: 'transporting', athospital: 'athospital' };
const STATUS_LABEL = { new: 'Received', assigned: 'Ambulance assigned', enroute: 'Ambulance on the way', onscene: 'Ambulance has arrived', transporting: 'On the way to hospital', athospital: 'Arrived at hospital', closed: 'Completed', cancelled: 'Cancelled' };
const PATIENT_CANCELLABLE = ['new', 'assigned', 'enroute'];
const freshMs = org => (Number(S.get('process.emergency.locationFreshSeconds', 120, org)) || 120) * 1000;
const sosRadiusKm = () => Number(S.get('process.emergency.sosRadiusKm', 40)) || 40;
const TRACK_MIN_MS = 10000;
const NG_BOX = { latMin: 4, latMax: 14, lngMin: 2.5, lngMax: 15 };
const inNigeria = (lat, lng) => lat >= NG_BOX.latMin && lat <= NG_BOX.latMax && lng >= NG_BOX.lngMin && lng <= NG_BOX.lngMax;

/* ---------------- helpers ---------------- */
const round1 = n => (n == null ? null : Math.round(n * 10) / 10);
const actorOf = req => (req.ctx && req.ctx.user ? { by: req.ctx.user.id, byName: req.ctx.user.name, byKind: req.ctx.kind } : { by: 'public', byName: 'Public caller', byKind: 'public' });

function complianceView(c) {
  const today = todayLagos();
  const out = {};
  for (const k of ['registration', 'insurance', 'inspection']) {
    const date = c && c[k + 'Expiry'] ? c[k + 'Expiry'] : null;
    if (!date) { out[k] = { expiry: null, daysLeft: null, expired: false, expiringSoon: false, missing: true }; continue; }
    const daysLeft = daysBetween(today, date);
    out[k] = { expiry: date, daysLeft, expired: daysLeft < 0, expiringSoon: daysLeft >= 0 && daysLeft <= 90, missing: false };
  }
  return out;
}
const licenceValid = cp => !!(cp && cp.licenceExpiry && cp.licenceExpiry >= todayLagos());

/** crew readiness for a unit: verified profile, valid licence, active membership, open shift */
async function crewStatus(unit) {
  const ids = unit.crewMembershipIds || [];
  if (!ids.length) return [];
  const [mems, profiles, shifts] = await Promise.all([
    db.col('memberships').find({ id: { $in: ids }, orgId: unit.orgId }),
    db.col('amb_crew').find({ orgId: unit.orgId, membershipId: { $in: ids } }),
    db.col('shifts').find({ membershipId: { $in: ids }, out: null }),
  ]);
  const users = mems.length ? await db.col('users').find({ id: { $in: mems.map(m => m.userId) } }, { projection: { name: 1, phone: 1 } }) : [];
  return ids.map(mid => {
    const m = mems.find(x => x.id === mid); const p = profiles.find(x => x.membershipId === mid); const u = m ? users.find(x => x.id === m.userId) : null;
    const onShift = shifts.some(s => s.membershipId === mid);
    return { membershipId: mid, userId: m ? m.userId : null, name: u ? u.name : 'Unknown', certification: p ? p.certification : null, verified: !!(p && p.verified), licenceValid: licenceValid(p),
      licenceExpiry: p ? p.licenceExpiry : null, active: !!(m && m.status === 'active' && m.role === 'crew'), onShift,
      ready: !!(m && m.status === 'active' && m.role === 'crew' && p && p.verified && licenceValid(p) && onShift) };
  });
}
/** can this unit take a job? (status, compliance, crew); availability is checked separately */
async function readiness(unit, crew) {
  crew = crew || await crewStatus(unit);
  const reasons = [];
  if (unit.status !== 'in_service') reasons.push('not_in_service');
  const comp = complianceView(unit.compliance);
  if (Object.values(comp).some(c => c.expired)) reasons.push('compliance_expired');
  if (!crew.length) reasons.push('no_crew');
  else if (!crew.some(c => c.ready)) reasons.push(crew.some(c => c.verified && c.licenceValid) ? 'no_crew_on_shift' : 'crew_not_verified');
  return { ready: reasons.length === 0, reasons, crew, compliance: comp };
}
async function unitView(u, opts = {}) {
  const r = await readiness(u);
  const fresh = !!(u.lastLoc && u.lastLoc.at && now() - u.lastLoc.at <= freshMs(opts.org));
  return { id: u.id, name: u.name, type: u.type, plate: u.plate, status: u.status, availability: u.availability, currentIncidentId: u.currentIncidentId || null,
    lastLoc: u.lastLoc || null, lastLocFresh: fresh, compliance: r.compliance, crew: r.crew, ready: r.ready, notReadyReasons: r.reasons,
    dispatchable: r.ready && u.availability === 'available' && !u.currentIncidentId, distanceKm: opts.distanceKm != null ? round1(opts.distanceKm) : undefined, etaMinutes: opts.etaMinutes };
}
async function dispatchableUnits(orgId) {
  const units = await db.col('amb_units').find({ orgId, status: 'in_service', availability: 'available', currentIncidentId: null });
  const out = [];
  for (const u of units) { const r = await readiness(u); if (r.ready) out.push(u); }
  return out;
}

/** ETA: optional OSRM-compatible ROUTING_URL, else straight line x1.4 at city speed */
async function eta(from, to) {
  if (!from || !to || from.lat == null || to.lat == null) return { km: null, etaMinutes: null, source: null };
  const km = haversineKm(from, to);
  if (config.ROUTING_URL && typeof fetch === 'function') {
    try {
      const url = config.ROUTING_URL.replace(/\/$/, '') + '/route/v1/driving/' + from.lng + ',' + from.lat + ';' + to.lng + ',' + to.lat + '?overview=false';
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok) { const j = await r.json(); const rt = j && j.routes && j.routes[0]; if (rt) return { km: round1(rt.distance / 1000), etaMinutes: Math.max(1, Math.round(rt.duration / 60)), source: 'routing' }; }
    } catch (e) { /* fall back */ }
  }
  return { km: round1(km), etaMinutes: etaMinutes(km), source: 'straight_line' };
}
const freshLoc = (u, org) => (u && u.lastLoc && now() - u.lastLoc.at <= freshMs(org) ? u.lastLoc : null);
/** where the unit is heading now */
function targetOf(inc) {
  if (['assigned', 'enroute'].includes(inc.status)) return { kind: 'scene', loc: inc.location };
  if (inc.status === 'transporting' && inc.destination && inc.destination.lat != null) return { kind: 'hospital', loc: inc.destination };
  return null;
}

function patientSnapshot(p) {
  return { firstName: p.firstName, age: P.age(p.dob), sex: p.sex || null, bloodGroup: p.bloodGroup || null,
    allergies: (p.allergies || []).map(a => ({ substance: a.substance, severity: a.severity || 'unknown', reaction: a.reaction || null })), noKnownAllergies: !!p.noKnownAllergies };
}

function staffIncidentView(inc, extra = {}) {
  const v = Object.assign({}, inc);
  delete v.publicTokenHash; delete v.patientOpenKey; delete v.lastTrackAt;
  v.statusLabel = STATUS_LABEL[inc.status];
  v.flags = { unverified: inc.verified === false, noUnitAvailableAtCreate: !!inc.noUnitAvailable, priorityOverridden: !!(inc.triage && inc.triage.overridden) };
  v.allowedNext = TRANSITIONS[inc.status];
  return Object.assign(v, extra);
}
async function patientIncidentView(inc) {
  const org = await orgs.getOrg(inc.orgId);
  const unit = inc.unitId ? await db.col('amb_units').findOne({ id: inc.unitId, orgId: inc.orgId }) : null;
  const loc = freshLoc(unit, org);
  const tgt = targetOf(inc);
  const e = loc && tgt ? await eta(loc, tgt.loc) : { etaMinutes: null };
  return { id: inc.id, number: inc.number, status: inc.status, statusLabel: STATUS_LABEL[inc.status], category: inc.triage.category, categoryLabel: CATEGORIES[inc.triage.category].label, priority: inc.triage.priority,
    createdAt: inc.createdAt, provider: org ? { id: org.id, name: org.name, phone: (org.contact || {}).phone || null } : null,
    unit: unit ? { name: unit.name, plate: unit.plate, type: unit.type } : null, unitLoc: loc ? { lat: loc.lat, lng: loc.lng, at: loc.at, heading: loc.heading == null ? null : loc.heading } : null,
    etaMinutes: e.etaMinutes, etaTarget: tgt && e.etaMinutes != null ? (tgt.kind === 'scene' ? 'you' : 'hospital') : null,
    destination: inc.destination ? { name: inc.destination.name } : null, location: inc.location,
    timeline: (inc.timeline || []).map(x => ({ status: x.status, label: STATUS_LABEL[x.status], at: x.at })),
    canCancel: PATIENT_CANCELLABLE.includes(inc.status), verified: inc.verified !== false, cancelReason: inc.cancelReason || null };
}

/** pick the provider: the one named (must run ambulance), else nearest with a dispatchable unit, else nearest at all */
async function routeProvider(loc, providerOrgId) {
  if (providerOrgId) {
    const o = await db.col('orgs').findOne({ id: providerOrgId, status: 'active' });
    if (!o || !(o.modules || []).includes('ambulance')) throw notFound('That provider does not run an ambulance service on MediCore');
    const units = await dispatchableUnits(o.id);
    return { org: o, noUnitAvailable: units.length === 0, distanceKm: null };
  }
  const candidates = await db.col('orgs').find({ status: 'active', modules: 'ambulance' });
  if (!candidates.length) throw conflict('No ambulance service is available on MediCore right now. Please call 112.', 'no_provider');
  // nearest provider with a ready, available unit inside the SOS radius; else the nearest provider (flagged)
  const radius = sosRadiusKm();
  let best = null; let fallback = null;
  for (const o of candidates) {
    const units = await dispatchableUnits(o.id);
    const orgKm = o.location && o.location.lat != null ? haversineKm(loc, o.location) : null;
    if (orgKm != null && (!fallback || orgKm < fallback.distanceKm)) fallback = { org: o, distanceKm: orgKm };
    for (const u of units) {
      const km = u.lastLoc && u.lastLoc.lat != null ? haversineKm(loc, u.lastLoc) : orgKm;
      if (km == null || km > radius) continue;
      if (!best || km < best.distanceKm) best = { org: o, distanceKm: km };
    }
  }
  if (best) return { org: best.org, noUnitAvailable: false, distanceKm: round1(best.distanceKm) };
  if (fallback) return { org: fallback.org, noUnitAvailable: true, distanceKm: round1(fallback.distanceKm) };
  return { org: candidates[0], noUnitAvailable: true, distanceKm: null };
}

async function createIncident({ org, source, caller, patient, location, category, priority, overrideBy, verified, note, createdBy, noUnitAvailable, publicToken }) {
  const n = await orgs.nextNumber('inc_' + org.id);
  const derived = CATEGORIES[category].priority;
  const t0 = now();
  const inc = {
    id: id('inc'), orgId: org.id, number: 'INC' + String(n).padStart(6, '0'), source, caller: caller || { name: null, phone: null },
    patientId: patient ? patient.id : null, patientInfo: patient ? patientSnapshot(patient) : null,
    location: { lat: location.lat, lng: location.lng, address: location.address || null, landmark: location.landmark || null },
    triage: { category, priority: priority || derived, derivedPriority: derived, overridden: !!(priority && priority !== derived), overriddenBy: priority && priority !== derived ? overrideBy || null : null },
    status: 'new', unitId: null, unitName: null, destination: null, timeline: [{ status: 'new', at: t0, by: createdBy.by, byName: createdBy.byName }], times: { new: t0 },
    verified: verified !== false, notes: note ? [{ text: note, at: t0, by: createdBy.by, byName: createdBy.byName, kind: source === 'call' ? 'dispatcher' : 'caller' }] : [], care: [],
    noUnitAvailable: !!noUnitAvailable, billId: null, billStatus: null, createdAt: t0, createdBy: createdBy.by,
  };
  if (patient) inc.patientOpenKey = patient.id;
  if (publicToken) inc.publicTokenHash = sha256(publicToken);
  await db.col('incidents').insertOne(inc);
  await notify({ orgId: org.id, role: 'ambulance_dispatcher', title: (inc.verified ? 'New emergency ' : 'New UNVERIFIED public emergency ') + inc.number, body: inc.triage.priority + ' ' + CATEGORIES[category].label + (noUnitAvailable ? ' (no unit available)' : ''), kind: 'ambulance_new', ref: { type: 'incident', id: inc.id } });
  return inc;
}

/** conditional status change; returns updated incident or null (already done / wrong state) */
async function transition(orgId, incId, to, actor, extra = {}, extraFilter = {}) {
  const t0 = now();
  const set = Object.assign({ status: to, ['times.' + to]: t0 }, extra.set || {});
  const upd = { $set: set, $push: { timeline: { status: to, at: t0, by: actor.by, byName: actor.byName, note: extra.note || null } } };
  if (extra.unset) upd.$unset = extra.unset;
  return db.col('incidents').findOneAndUpdate(Object.assign({ id: incId, orgId, status: { $in: fromStates(to) } }, extraFilter), upd);
}
async function freeUnit(orgId, unitId, incId, availability) {
  if (!unitId) return;
  await db.col('amb_units').updateOne({ id: unitId, orgId, currentIncidentId: incId }, { $set: { availability: availability || 'available', currentIncidentId: null } });
}
async function syncUnit(inc) {
  if (inc.unitId && UNIT_AVAIL_FOR[inc.status]) await db.col('amb_units').updateOne({ id: inc.unitId, orgId: inc.orgId, currentIncidentId: inc.id }, { $set: { availability: UNIT_AVAIL_FOR[inc.status] } });
}
async function crewUserIds(unit) {
  const ms = (unit.crewMembershipIds || []).length ? await db.col('memberships').find({ id: { $in: unit.crewMembershipIds }, orgId: unit.orgId, status: 'active' }) : [];
  return ms.map(m => m.userId);
}
async function tellPatient(inc, title, bodyText, withSms) {
  if (inc.patientId) await notify({ patientId: inc.patientId, title, body: bodyText, kind: 'emergency', ref: { type: 'incident', id: inc.id }, sms: withSms ? (inc.caller && inc.caller.phone) : null });
  else if (withSms && inc.caller && inc.caller.phone) await require('../lib/notify').sms(inc.caller.phone, title + (bodyText ? ': ' + bodyText : ''));
}

/** claim a unit and assign it; exactly-once on both the unit and the incident */
async function assignUnit(req, incId, unitId, { reassign, reason } = {}) {
  const orgId = req.ctx.org.id;
  const inc = await db.col('incidents').findOne({ id: incId, orgId });
  if (!inc) throw notFound('Incident not found');
  const unit = await db.col('amb_units').findOne({ id: unitId, orgId });
  if (!unit) throw notFound('Unit not found');
  if (reassign) { if (!['assigned', 'enroute'].includes(inc.status)) throw conflict('Only an assigned or en-route incident can be reassigned'); if (inc.unitId === unitId) throw conflict('That unit is already on this incident'); }
  else if (inc.status !== 'new') throw conflict('This incident is already ' + inc.status, 'wrong_state');
  const r = await readiness(unit);
  if (!r.ready) throw conflict('That unit cannot be dispatched: ' + r.reasons.join(', ').replace(/_/g, ' '), 'not_dispatchable');
  const claimed = await db.col('amb_units').findOneAndUpdate({ id: unitId, orgId, status: 'in_service', availability: 'available', currentIncidentId: null }, { $set: { availability: 'assigned', currentIncidentId: incId } });
  if (!claimed) throw conflict('That unit is no longer available', 'unit_taken');
  const actor = actorOf(req);
  const t0 = now();
  let updated;
  if (reassign) {
    updated = await db.col('incidents').findOneAndUpdate({ id: incId, orgId, status: { $in: ['assigned', 'enroute'] }, unitId: inc.unitId },
      { $set: { status: 'assigned', unitId, unitName: unit.name, 'times.reassigned': t0 }, $push: { timeline: { status: 'assigned', at: t0, by: actor.by, byName: actor.byName, note: 'Reassigned: ' + reason } } });
  } else {
    updated = await transition(orgId, incId, 'assigned', actor, { set: { unitId, unitName: unit.name } }, { status: 'new' });
  }
  if (!updated) { await freeUnit(orgId, unitId, incId); throw conflict('This incident changed. Refresh the board.', 'wrong_state'); }
  if (reassign) await freeUnit(orgId, inc.unitId, incId);
  for (const uid of await crewUserIds(unit)) await notify({ userId: uid, title: 'New job ' + updated.number, body: updated.triage.priority + ' ' + CATEGORIES[updated.triage.category].label + (updated.location.address ? ' at ' + updated.location.address : ''), kind: 'ambulance_job', ref: { type: 'incident', id: incId } });
  await tellPatient(updated, 'Ambulance assigned', req.ctx.org.name + ' has assigned ' + unit.name + ' (' + unit.plate + ') to you.', !reassign);
  await audit(req, reassign ? 'ambulance.reassign' : 'ambulance.assign', { type: 'incident', id: incId, patientId: updated.patientId }, { unitId, fromUnitId: reassign ? inc.unitId : undefined });
  return updated;
}

/** bill once, by the request that won the close transition */
async function billIncident(inc) {
  if (!inc.patientId) { await db.col('incidents').updateOne({ id: inc.id }, { $set: { billStatus: 'no_patient' } }); return null; }
  const unit = inc.unitId ? await db.col('amb_units').findOne({ id: inc.unitId, orgId: inc.orgId }) : null;
  const lines = [];
  let callSvc = null;
  if (unit && unit.type === 'ALS') callSvc = await orgs.service(inc.orgId, 'AMB-ALS');
  if (!callSvc) callSvc = await orgs.service(inc.orgId, 'AMB-CALL');
  if (callSvc) lines.push(billing.lineFromService(callSvc, 1));
  const km = await transportKm(inc);
  const kmSvc = await orgs.service(inc.orgId, 'AMB-KM');
  if (kmSvc && km > 0) lines.push(billing.lineFromService(kmSvc, Math.max(1, Math.ceil(km))));
  if (!lines.length) { await db.col('incidents').updateOne({ id: inc.id }, { $set: { billStatus: 'no_price_list', transportKm: km } }); return null; }
  const bill = await billing.createBill({ orgId: inc.orgId, patientId: inc.patientId, lines, source: { type: 'incident', id: inc.id }, createdBy: 'system', note: 'Ambulance ' + inc.number });
  await db.col('incidents').updateOne({ id: inc.id }, { $set: { billId: bill.id, billStatus: bill.status, transportKm: km } });
  if (bill.status === 'open') await tellPatient(inc, 'Ambulance bill ready', 'Your bill from ' + ((await orgs.getOrg(inc.orgId)) || {}).name + ' is ready in the MediCore app.', false);
  return bill;
}
/** km transported: from recorded GPS points while transporting, else straight line scene -> destination */
async function transportKm(inc) {
  if (!inc.times || !inc.times.transporting) return 0;
  const pts = await db.col('incident_track').find({ incidentId: inc.id, at: { $gte: inc.times.transporting } }, { sort: { at: 1 } });
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += haversineKm(pts[i - 1], pts[i]) || 0;
  if (pts.length >= 2 && km > 0) return Math.round(km * 10) / 10;
  if (inc.destination && inc.destination.lat != null) return Math.round((haversineKm(inc.location, inc.destination) || 0) * 10) / 10;
  return 0;
}
billing.onSettled('incident', async (bill, how) => {
  await db.col('incidents').updateOne({ id: bill.source.id, orgId: bill.orgId, billId: bill.id }, { $set: { billStatus: 'paid', paidVia: how } });
});

async function closeIncident(req, inc, actor, { note, unitAvailability } = {}) {
  const closed = await transition(inc.orgId, inc.id, 'closed', actor, { note, unset: { patientOpenKey: '' } }, { status: { $in: fromStates('closed') } });
  if (!closed) throw conflict('This incident is already closed or cannot be closed yet', 'wrong_state');
  await freeUnit(closed.orgId, closed.unitId, closed.id, unitAvailability);
  const bill = await billIncident(closed);
  await tellPatient(closed, 'Emergency case closed', 'Thank you for using ' + req.ctx.org.name + '.', false);
  await audit(req, 'ambulance.close', { type: 'incident', id: closed.id, patientId: closed.patientId }, { billId: bill ? bill.id : null });
  return Object.assign(closed, { billId: bill ? bill.id : null, billStatus: bill ? bill.status : (closed.patientId ? 'no_price_list' : 'no_patient') });
}

async function cancelIncident(req, inc, reason, actor, allowed) {
  const t0 = now();
  const c = await db.col('incidents').findOneAndUpdate({ id: inc.id, orgId: inc.orgId, status: { $in: allowed } },
    { $set: { status: 'cancelled', 'times.cancelled': t0, cancelReason: reason, cancelledBy: actor.byKind }, $unset: { patientOpenKey: '' }, $push: { timeline: { status: 'cancelled', at: t0, by: actor.by, byName: actor.byName, note: reason } } });
  if (!c) throw conflict('This incident can no longer be cancelled', 'wrong_state');
  await freeUnit(c.orgId, c.unitId, c.id);
  if (c.unitId) { const u = await db.col('amb_units').findOne({ id: c.unitId, orgId: c.orgId }); if (u) for (const uid of await crewUserIds(u)) await notify({ userId: uid, title: 'Job cancelled ' + c.number, body: 'Stand down.', kind: 'ambulance_job', ref: { type: 'incident', id: c.id } }); }
  if (actor.byKind !== 'patient') await tellPatient(c, 'Emergency request cancelled', 'Call ' + (((await orgs.getOrg(c.orgId)) || {}).contact || {}).phone + ' if you still need help.', false);
  else await notify({ orgId: c.orgId, role: 'ambulance_dispatcher', title: 'Cancelled by patient ' + c.number, body: '', kind: 'ambulance_cancel', ref: { type: 'incident', id: c.id } });
  await audit(req, 'ambulance.cancel', { type: 'incident', id: c.id, patientId: c.patientId, orgId: c.orgId }, { by: actor.byKind });
  return c;
}

const destRule = { orgId: t.id(), name: t.str({ max: 120 }), lat: t.lat(), lng: t.lng() };
async function setDestination(req, inc, b) {
  if (!OPEN.includes(inc.status)) throw conflict('This incident is closed');
  let dest;
  if (b.orgId) {
    const o = await db.col('orgs').findOne({ id: b.orgId, status: 'active' });
    if (!o || !(o.modules || []).includes('clinic')) throw notFound('Receiving provider not found');
    dest = { orgId: o.id, name: o.name, lat: o.location ? o.location.lat : null, lng: o.location ? o.location.lng : null, address: (o.contact || {}).address || null };
  } else {
    if (!b.name) throw bad('Choose a MediCore hospital or type the hospital name');
    dest = { orgId: null, name: b.name, lat: b.lat == null ? null : b.lat, lng: b.lng == null ? null : b.lng, address: null };
  }
  const u = await db.col('incidents').findOneAndUpdate({ id: inc.id, orgId: inc.orgId, status: { $in: OPEN } }, { $set: { destination: dest, 'times.destinationSet': now() } });
  if (!u) throw conflict('This incident is closed');
  if (dest.orgId && (!inc.destination || inc.destination.orgId !== dest.orgId)) {
    await notify({ orgId: dest.orgId, role: 'receptionist', title: 'Incoming ambulance patient (' + u.triage.priority + ')', body: CATEGORIES[u.triage.category].label + ' from ' + req.ctx.org.name + '. See Incoming on the front desk.', kind: 'ambulance_incoming', ref: { type: 'incident', id: u.id } });
  }
  await audit(req, 'ambulance.destination', { type: 'incident', id: u.id, patientId: u.patientId }, { destOrgId: dest.orgId });
  return u;
}

/* ===================== fleet (ambulance.fleet) ===================== */
const fleetG = A.requireStaff({ perm: 'ambulance.fleet', module: 'ambulance' });
const dispatchG = A.requireStaff({ perm: 'ambulance.dispatch', module: 'ambulance' });
const crewG = A.requireStaff({ perm: 'ambulance.crew', module: 'ambulance' });
const compRule = { registrationExpiry: t.date(), insuranceExpiry: t.date(), inspectionExpiry: t.date() };

router.get('/ambulance/units', A.requireStaff({ anyPerm: ['ambulance.fleet', 'ambulance.dispatch'], module: 'ambulance' }), ah(async (req, res) => {
  const units = await db.col('amb_units').find({ orgId: req.ctx.org.id, status: { $ne: 'retired' } }, { sort: { name: 1 } });
  const out = []; for (const u of units) out.push(await unitView(u));
  res.json(out);
}));
router.post('/ambulance/units', fleetG, ah(async (req, res) => {
  const b = body(req, Object.assign({ name: t.str({ required: true, max: 60 }), type: t.enum(UNIT_TYPES, { required: true }), plate: t.str({ required: true, max: 20, upper: true }) }, compRule));
  const u = { id: id('unit'), orgId: req.ctx.org.id, name: b.name, type: b.type, plate: b.plate, status: 'in_service', availability: 'offline', currentIncidentId: null,
    compliance: { registrationExpiry: b.registrationExpiry || null, insuranceExpiry: b.insuranceExpiry || null, inspectionExpiry: b.inspectionExpiry || null }, crewMembershipIds: [], lastLoc: null, createdAt: now() };
  await db.col('amb_units').insertOne(u);
  await audit(req, 'ambulance.unit_create', { type: 'unit', id: u.id }, { type: u.type });
  res.json(await unitView(u));
}));
router.patch('/ambulance/units/:id', fleetG, ah(async (req, res) => {
  const b = body(req, Object.assign({ name: t.str({ max: 60 }), type: t.enum(UNIT_TYPES), plate: t.str({ max: 20, upper: true }), status: t.enum(UNIT_STATUS), availability: t.enum(['available', 'offline']), crewMembershipIds: t.arr(t.id(), { max: 6 }) }, compRule));
  const orgId = req.ctx.org.id;
  const unit = await db.col('amb_units').findOne({ id: param(req, 'id'), orgId });
  if (!unit) throw notFound('Unit not found');
  const set = {};
  ['name', 'type', 'plate'].forEach(k => { if (b[k] !== undefined) set[k] = b[k]; });
  Object.keys(compRule).forEach(k => { if (b[k] !== undefined) set['compliance.' + k] = b[k]; });
  if (b.crewMembershipIds) {
    const ids = [...new Set(b.crewMembershipIds)];
    const ms = ids.length ? await db.col('memberships').find({ id: { $in: ids }, orgId, role: 'crew', status: 'active' }) : [];
    if (ms.length !== ids.length) throw bad('Every crew member must be active ambulance crew at your provider');
    set.crewMembershipIds = ids;
  }
  const filter = { id: unit.id, orgId };
  if (b.status !== undefined || b.availability !== undefined) {
    // taking a unit off the road or on/off line is only allowed between jobs
    filter.currentIncidentId = null;
    if (b.status) { set.status = b.status; if (b.status !== 'in_service') set.availability = 'offline'; }
    if (b.availability) { if ((b.status || unit.status) !== 'in_service' && b.availability === 'available') throw bad('Only an in-service unit can be available'); set.availability = b.availability; }
  }
  if (!Object.keys(set).length) throw bad('Nothing to change');
  const u = await db.col('amb_units').findOneAndUpdate(filter, { $set: set });
  if (!u) throw conflict('This unit is on a job. Change its status after the job is closed.');
  // a crew member belongs to one unit at a time
  if (set.crewMembershipIds) for (const mid of set.crewMembershipIds) await db.col('amb_units').updateMany({ orgId, id: { $ne: u.id }, crewMembershipIds: mid }, { $pull: { crewMembershipIds: mid } });
  await audit(req, 'ambulance.unit_update', { type: 'unit', id: u.id }, { fields: Object.keys(set) });
  res.json(await unitView(u));
}));

router.get('/ambulance/crew', fleetG, ah(async (req, res) => {
  const orgId = req.ctx.org.id;
  const ms = await db.col('memberships').find({ orgId, role: 'crew', status: { $ne: 'removed' } });
  const profiles = await db.col('amb_crew').find({ orgId });
  const units = await db.col('amb_units').find({ orgId });
  const shifts = ms.length ? await db.col('shifts').find({ membershipId: { $in: ms.map(m => m.id) }, out: null }) : [];
  const out = [];
  for (const m of ms) {
    const u = await db.col('users').findOne({ id: m.userId }, { projection: { name: 1, phone: 1 } });
    const p = profiles.find(x => x.membershipId === m.id) || null;
    const unit = units.find(x => (x.crewMembershipIds || []).includes(m.id));
    out.push({ membershipId: m.id, name: u ? u.name : 'Unknown', phone: u ? u.phone || null : null, status: m.status, onShift: shifts.some(s => s.membershipId === m.id),
      profile: p ? { certification: p.certification, licenceNo: p.licenceNo, licenceExpiry: p.licenceExpiry, licenceValid: licenceValid(p), licenceExpiringSoon: !!(p.licenceExpiry && daysBetween(todayLagos(), p.licenceExpiry) <= 90), verified: !!p.verified, verifiedAt: p.verifiedAt || null } : null,
      unit: unit ? { id: unit.id, name: unit.name } : null });
  }
  res.json(out);
}));
router.put('/ambulance/crew/:membershipId', fleetG, ah(async (req, res) => {
  const b = body(req, { certification: t.enum(CERTS, { required: true }), licenceNo: t.str({ required: true, max: 40 }), licenceExpiry: t.date({ required: true }) });
  const orgId = req.ctx.org.id;
  const m = await db.col('memberships').findOne({ id: param(req, 'membershipId'), orgId, role: 'crew' });
  if (!m) throw notFound('Crew member not found');
  const cur = await db.col('amb_crew').findOne({ orgId, membershipId: m.id });
  const changed = !cur || cur.licenceNo !== b.licenceNo || cur.licenceExpiry !== b.licenceExpiry || cur.certification !== b.certification;
  const set = Object.assign({}, b, { userId: m.userId, updatedAt: now() });
  if (changed) Object.assign(set, { verified: false, verifiedBy: null, verifiedAt: null }); // new licence details must be re-checked
  const p = await db.col('amb_crew').findOneAndUpdate({ orgId, membershipId: m.id }, { $set: set, $setOnInsert: { id: id('crw'), orgId, membershipId: m.id, createdAt: now() } }, { upsert: true });
  await audit(req, 'ambulance.crew_profile', { type: 'crew', id: p.id }, { certification: b.certification, reverify: changed });
  res.json(p);
}));
router.post('/ambulance/crew/:membershipId/verify', fleetG, ah(async (req, res) => {
  const b = body(req, { verified: t.bool({ required: true }) });
  const orgId = req.ctx.org.id;
  const mid = param(req, 'membershipId');
  if (mid === req.ctx.membership.id) throw forbidden('You cannot verify your own licence');
  const cur = await db.col('amb_crew').findOne({ orgId, membershipId: mid });
  if (!cur) throw notFound('Add the crew member\'s licence details first');
  if (b.verified && !licenceValid(cur)) throw bad('This licence has expired');
  const p = await db.col('amb_crew').findOneAndUpdate({ orgId, membershipId: mid }, { $set: { verified: b.verified, verifiedBy: req.ctx.user.id, verifiedAt: now() } });
  await audit(req, 'ambulance.crew_verify', { type: 'crew', id: p.id }, { verified: b.verified });
  res.json(p);
}));

/* response metrics (admins, fleet managers) */
function stats(arr) {
  if (!arr.length) return { n: 0, avgMin: null, p90Min: null };
  const s = arr.slice().sort((a, b) => a - b);
  const avg = s.reduce((x, y) => x + y, 0) / s.length;
  const p90 = s[Math.max(0, Math.ceil(0.9 * s.length) - 1)];
  return { n: s.length, avgMin: Math.round(avg / 6000) / 10, p90Min: Math.round(p90 / 6000) / 10 };
}
router.get('/ambulance/metrics', A.requireStaff({ anyPerm: ['ambulance.fleet', 'admin.reports'], module: 'ambulance' }), ah(async (req, res) => {
  const q = query(req, { days: t.int({ min: 1, max: 365, default: 30 }) });
  const since = now() - q.days * 86400e3;
  const rows = await db.col('incidents').find({ orgId: req.ctx.org.id, createdAt: { $gte: since } }, { projection: { triage: 1, times: 1, status: 1 } });
  const groups = { all: rows };
  PRIORITIES.forEach(p => { groups[p] = rows.filter(r => r.triage.priority === p); });
  const out = {};
  for (const [k, list] of Object.entries(groups)) {
    out[k] = {
      incidents: list.length, closed: list.filter(r => r.status === 'closed').length, cancelled: list.filter(r => r.status === 'cancelled').length,
      newToAssigned: stats(list.filter(r => r.times.assigned && r.times.new).map(r => r.times.assigned - r.times.new)),
      assignedToOnscene: stats(list.filter(r => r.times.onscene && r.times.assigned).map(r => r.times.onscene - r.times.assigned)),
    };
  }
  res.json({ days: q.days, since, byPriority: out });
}));

/* ===================== dispatcher ===================== */
router.get('/dispatch/board', dispatchG, ah(async (req, res) => {
  const orgId = req.ctx.org.id;
  const incs = await db.col('incidents').find({ orgId, status: { $in: OPEN } }, { sort: { createdAt: 1 } });
  incs.sort((a, b) => a.triage.priority.localeCompare(b.triage.priority) || a.createdAt - b.createdAt);
  const units = await db.col('amb_units').find({ orgId, status: { $ne: 'retired' } }, { sort: { name: 1 } });
  const uv = []; for (const u of units) uv.push(await unitView(u));
  res.json({ incidents: incs.map(i => staffIncidentView(i, { ageMin: Math.round((now() - i.createdAt) / 60000) })), units: uv, categories: CATEGORIES });
}));
router.get('/dispatch/incidents', dispatchG, ah(async (req, res) => {
  const q = query(req, { status: t.enum(Object.keys(TRANSITIONS)), limit: t.int({ min: 1, max: 500 }) });
  const f = { orgId: req.ctx.org.id }; if (q.status) f.status = q.status;
  const rows = await db.col('incidents').find(f, { sort: { createdAt: -1 }, limit: q.limit || 100 });
  res.json(rows.map(i => staffIncidentView(i)));
}));
router.get('/dispatch/incidents/:id', dispatchG, ah(async (req, res) => {
  const inc = await db.col('incidents').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!inc) throw notFound('Incident not found');
  const track = await db.col('incident_track').find({ incidentId: inc.id }, { sort: { at: 1 }, limit: 2000 });
  if (inc.patientId) await audit(req, 'ambulance.view', { type: 'incident', id: inc.id, patientId: inc.patientId });
  res.json(staffIncidentView(inc, { track: track.map(p => ({ lat: p.lat, lng: p.lng, at: p.at, status: p.status })) }));
}));
const locRule = t.obj({ lat: t.lat({ required: true }), lng: t.lng({ required: true }), address: t.str({ max: 300 }), landmark: t.str({ max: 200 }) }, { required: true });
router.post('/dispatch/incidents', dispatchG, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { source: t.enum(['call', 'transfer'], { default: 'call' }), caller: t.obj({ name: t.str({ max: 100 }), phone: t.phone() }), patientId: t.id(), location: locRule,
    category: t.enum(CAT_KEYS, { required: true }), priority: t.enum(PRIORITIES), note: t.text({ max: 1000 }) });
  if (!inNigeria(b.location.lat, b.location.lng)) throw bad('The location is outside Nigeria');
  let patient = null;
  if (b.patientId) patient = (await P.requireLinked(req, b.patientId)).patient;
  const inc = await createIncident({ org: req.ctx.org, source: b.source, caller: { name: (b.caller || {}).name || null, phone: (b.caller || {}).phone || null }, patient, location: b.location, category: b.category, priority: b.priority, overrideBy: req.ctx.user.id,
    verified: true, note: b.note, createdBy: actorOf(req) }).catch(e => { if (e.code === 11000) throw conflict('This patient already has an open emergency', 'active_emergency'); throw e; });
  await audit(req, 'ambulance.create', { type: 'incident', id: inc.id, patientId: inc.patientId }, { source: inc.source, priority: inc.triage.priority });
  res.json(staffIncidentView(inc));
}));
router.patch('/dispatch/incidents/:id/triage', dispatchG, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { category: t.enum(CAT_KEYS), priority: t.enum(PRIORITIES) });
  const inc = await db.col('incidents').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id, status: { $in: OPEN } });
  if (!inc) throw notFound('Open incident not found');
  const category = b.category || inc.triage.category; const derived = CATEGORIES[category].priority;
  const priority = b.priority || (b.category ? derived : inc.triage.priority);
  const triage = { category, priority, derivedPriority: derived, overridden: priority !== derived, overriddenBy: priority !== derived ? req.ctx.user.id : null };
  const u = await db.col('incidents').findOneAndUpdate({ id: inc.id, orgId: inc.orgId, status: { $in: OPEN } }, { $set: { triage } });
  if (!u) throw conflict('This incident is closed');
  await audit(req, 'ambulance.triage', { type: 'incident', id: u.id, patientId: u.patientId }, { category, priority });
  res.json(staffIncidentView(u));
}));
router.get('/dispatch/incidents/:id/suggest', dispatchG, ah(async (req, res) => {
  const inc = await db.col('incidents').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!inc) throw notFound('Incident not found');
  const org = req.ctx.org;
  const units = await db.col('amb_units').find({ orgId: org.id, status: 'in_service' });
  const out = [];
  for (const u of units) {
    const from = u.lastLoc && u.lastLoc.lat != null ? u.lastLoc : org.location;
    const e = await eta(from, inc.location);
    out.push(await unitView(u, { distanceKm: e.km, etaMinutes: e.etaMinutes }));
  }
  out.sort((a, b) => (b.dispatchable - a.dispatchable) || ((a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)));
  res.json(out);
}));
router.post('/dispatch/incidents/:id/assign', dispatchG, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { unitId: t.id({ required: true }) });
  res.json(staffIncidentView(await assignUnit(req, param(req, 'id'), b.unitId)));
}));
router.post('/dispatch/incidents/:id/reassign', dispatchG, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { unitId: t.id({ required: true }), reason: t.str({ required: true, min: 3, max: 300 }) });
  res.json(staffIncidentView(await assignUnit(req, param(req, 'id'), b.unitId, { reassign: true, reason: b.reason })));
}));
router.post('/dispatch/incidents/:id/cancel', dispatchG, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ required: true, min: 3, max: 300 }) });
  const inc = await db.col('incidents').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!inc) throw notFound('Incident not found');
  res.json(staffIncidentView(await cancelIncident(req, inc, b.reason, actorOf(req), fromStates('cancelled'))));
}));
router.post('/dispatch/incidents/:id/close', dispatchG, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { note: t.str({ max: 300 }) });
  const inc = await db.col('incidents').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!inc) throw notFound('Incident not found');
  res.json(staffIncidentView(await closeIncident(req, inc, actorOf(req), { note: b.note })));
}));
router.post('/dispatch/incidents/:id/destination', dispatchG, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, destRule);
  const inc = await db.col('incidents').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id });
  if (!inc) throw notFound('Incident not found');
  res.json(staffIncidentView(await setDestination(req, inc, b)));
}));
router.post('/dispatch/incidents/:id/notes', dispatchG, ah(async (req, res) => {
  const b = body(req, { text: t.text({ required: true, max: 1000 }) });
  const note = { text: b.text, at: now(), by: req.ctx.user.id, byName: req.ctx.user.name, kind: 'dispatcher' };
  const u = await db.col('incidents').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id }, { $push: { notes: note } });
  if (!u) throw notFound('Incident not found');
  await audit(req, 'ambulance.note', { type: 'incident', id: u.id, patientId: u.patientId });
  res.json(staffIncidentView(u));
}));
/* a public call has been confirmed by calling the caller back */
router.post('/dispatch/incidents/:id/verify', dispatchG, A.requireOnShift, ah(async (req, res) => {
  const u = await db.col('incidents').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id, verified: false }, { $set: { verified: true, verifiedBy: req.ctx.user.id, verifiedAt: now() } });
  if (!u) throw conflict('Incident not found or already verified');
  await audit(req, 'ambulance.verify', { type: 'incident', id: u.id, patientId: u.patientId });
  res.json(staffIncidentView(u));
}));
/* attach a registered patient (e.g. a public caller registered at the desk) so the case can be billed */
router.post('/dispatch/incidents/:id/patient', dispatchG, ah(async (req, res) => {
  const b = body(req, { patientId: t.id({ required: true }) });
  const { patient } = await P.requireLinked(req, b.patientId);
  const u = await db.col('incidents').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id, patientId: null, status: { $in: OPEN } }, { $set: { patientId: patient.id, patientInfo: patientSnapshot(patient) } });
  if (!u) throw conflict('Open incident without a patient not found');
  await audit(req, 'ambulance.patient_attach', { type: 'incident', id: u.id, patientId: patient.id });
  res.json(staffIncidentView(u));
}));
/* receiving providers to choose from (MediCore providers with doctors) */
router.get('/dispatch/destinations', A.requireStaff({ anyPerm: ['ambulance.dispatch', 'ambulance.crew'], module: 'ambulance' }), ah(async (req, res) => {
  const q = query(req, { lat: t.lat(), lng: t.lng() });
  const rows = await db.col('orgs').find({ status: 'active', modules: 'clinic' });
  const from = q.lat != null && q.lng != null ? { lat: q.lat, lng: q.lng } : null;
  const out = rows.map(o => ({ orgId: o.id, name: o.name, type: o.type, lat: o.location ? o.location.lat : null, lng: o.location ? o.location.lng : null, area: o.location ? o.location.area || null : null,
    distanceKm: from && o.location ? round1(haversineKm(from, o.location)) : null }));
  out.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) || a.name.localeCompare(b.name));
  res.json(out);
}));

/* ===================== receiving front desk ===================== */
router.get('/fd/incoming', A.requireStaff({ anyPerm: ['queue.manage', 'patient.register', 'patient.read'] }), ah(async (req, res) => {
  const rows = await db.col('incidents').find({ 'destination.orgId': req.ctx.org.id, status: { $in: OPEN } }, { sort: { createdAt: 1 } });
  const out = [];
  for (const inc of rows) {
    const from = await orgs.getOrg(inc.orgId);
    const unit = inc.unitId ? await db.col('amb_units').findOne({ id: inc.unitId, orgId: inc.orgId }) : null;
    const loc = freshLoc(unit, from);
    const e = loc && inc.status === 'transporting' ? await eta(loc, inc.destination) : { etaMinutes: null };
    const pi = inc.patientInfo;
    out.push({ incidentId: inc.id, number: inc.number, fromProvider: from ? { name: from.name, phone: (from.contact || {}).phone || null } : null, status: inc.status, statusLabel: STATUS_LABEL[inc.status],
      category: inc.triage.category, categoryLabel: CATEGORIES[inc.triage.category].label, priority: inc.triage.priority, etaMinutes: e.etaMinutes,
      unit: unit ? { name: unit.name, plate: unit.plate, type: unit.type } : null, arrivedAt: inc.times.athospital || null,
      patient: pi ? { firstName: pi.firstName, age: pi.age, sex: pi.sex, bloodGroup: pi.bloodGroup, allergies: pi.allergies.map(a => ({ substance: a.substance, severity: a.severity })) } : null });
  }
  res.json(out);
}));

/* ===================== crew app ===================== */
async function myUnit(req) {
  return db.col('amb_units').findOne({ orgId: req.ctx.org.id, crewMembershipIds: req.ctx.membership.id });
}
/** the incident assigned to MY unit at MY provider; anything else is 404 */
async function myIncident(req, incId) {
  const unit = await myUnit(req);
  if (!unit) throw notFound('Incident not found');
  const inc = await db.col('incidents').findOne({ id: incId, orgId: req.ctx.org.id, unitId: unit.id });
  if (!inc) throw notFound('Incident not found');
  return { unit, inc };
}
router.get('/crew/me', crewG, ah(async (req, res) => {
  const unit = await myUnit(req);
  const profile = await db.col('amb_crew').findOne({ orgId: req.ctx.org.id, membershipId: req.ctx.membership.id });
  const shift = await db.col('shifts').findOne({ membershipId: req.ctx.membership.id, out: null });
  let incident = null; let e = { etaMinutes: null };
  if (unit && unit.currentIncidentId) {
    const inc = await db.col('incidents').findOne({ id: unit.currentIncidentId, orgId: req.ctx.org.id, unitId: unit.id });
    if (inc) {
      const tgt = targetOf(inc);
      if (tgt && unit.lastLoc) e = await eta(unit.lastLoc, tgt.loc);
      incident = staffIncidentView(inc, { etaMinutes: e.etaMinutes, etaTarget: tgt ? tgt.kind : null, categoryLabel: CATEGORIES[inc.triage.category].label });
      if (inc.patientId) await audit(req, 'ambulance.view', { type: 'incident', id: inc.id, patientId: inc.patientId });
    }
  }
  res.json({ onShift: !!shift, profile: profile ? { certification: profile.certification, licenceExpiry: profile.licenceExpiry, verified: !!profile.verified, licenceValid: licenceValid(profile) } : null,
    unit: unit ? await unitView(unit) : null, incident, demoDrive: !!config.DEMO_MODE });
}));
router.post('/crew/location', crewG, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { lat: t.lat({ required: true }), lng: t.lng({ required: true }), accuracy: t.num({ min: 0, max: 100000 }), speed: t.num({ min: 0, max: 100 }), heading: t.num({ min: 0, max: 360 }) });
  await RL.limit('crewloc_' + req.ctx.membership.id, 30, 60);
  const unit = await myUnit(req);
  if (!unit) throw conflict('You are not assigned to a unit. Ask your fleet manager.', 'no_unit');
  const r = await recordPosition(unit, b);
  res.json({ ok: true, tracked: r.tracked, incidentId: unit.currentIncidentId || null });
}));
async function recordPosition(unit, b) {
  const t0 = now();
  const loc = { lat: b.lat, lng: b.lng, accuracy: b.accuracy == null ? null : b.accuracy, speed: b.speed == null ? null : b.speed, heading: b.heading == null ? null : b.heading, at: t0 };
  await db.col('amb_units').updateOne({ id: unit.id, orgId: unit.orgId }, { $set: { lastLoc: loc } });
  let tracked = false;
  if (unit.currentIncidentId) {
    // at most one track point per 10 s per incident (conditional, so parallel posts cannot both write)
    const inc = await db.col('incidents').findOneAndUpdate({ id: unit.currentIncidentId, orgId: unit.orgId, unitId: unit.id, status: { $in: OPEN }, $or: [{ lastTrackAt: null }, { lastTrackAt: { $exists: false } }, { lastTrackAt: { $lte: t0 - TRACK_MIN_MS } }] }, { $set: { lastTrackAt: t0 } });
    if (inc) { await db.col('incident_track').insertOne({ id: id('trk'), incidentId: inc.id, orgId: inc.orgId, unitId: unit.id, lat: b.lat, lng: b.lng, accuracy: loc.accuracy, at: t0, status: inc.status }); tracked = true; }
  }
  return { tracked, loc };
}
const CREW_STEPS = { enroute: 'enroute', onscene: 'onscene', transporting: 'transporting', athospital: 'athospital', clear: 'closed' };
router.post('/crew/incidents/:id/status', crewG, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { status: t.enum(Object.keys(CREW_STEPS), { required: true }), note: t.str({ max: 300 }), returning: t.bool() });
  const { inc } = await myIncident(req, param(req, 'id'));
  const to = CREW_STEPS[b.status];
  const actor = actorOf(req);
  if (to === 'closed') return res.json(staffIncidentView(await closeIncident(req, inc, actor, { note: b.note, unitAvailability: b.returning ? 'returning' : 'available' })));
  if (to === 'transporting' && !inc.destination) throw bad('Set the destination hospital before transporting');
  const allowed = fromStates(to).filter(s => s !== to);
  const u = await transition(inc.orgId, inc.id, to, actor, { note: b.note }, { unitId: inc.unitId, status: { $in: allowed } });
  if (!u) throw conflict('This incident is already ' + (await db.col('incidents').findOne({ id: inc.id })).status, 'wrong_state');
  await syncUnit(u);
  if (to === 'onscene') await tellPatient(u, 'The ambulance has arrived', '', false);
  if (to === 'transporting' && u.destination && u.destination.orgId) await notify({ orgId: u.destination.orgId, role: 'receptionist', title: 'Ambulance patient on the way (' + u.triage.priority + ')', body: CATEGORIES[u.triage.category].label + ' from ' + req.ctx.org.name, kind: 'ambulance_incoming', ref: { type: 'incident', id: u.id } });
  await audit(req, 'ambulance.status', { type: 'incident', id: u.id, patientId: u.patientId }, { to });
  res.json(staffIncidentView(u));
}));
router.post('/crew/incidents/:id/destination', crewG, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, destRule);
  const { inc } = await myIncident(req, param(req, 'id'));
  res.json(staffIncidentView(await setDestination(req, inc, b)));
}));
router.post('/crew/incidents/:id/care', crewG, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, {
    vitals: t.obj({ bpSys: t.int({ min: 30, max: 300 }), bpDia: t.int({ min: 10, max: 200 }), pulse: t.int({ min: 0, max: 300 }), rr: t.int({ min: 0, max: 80 }), spo2: t.int({ min: 0, max: 100 }), tempC: t.num({ min: 25, max: 45 }), gcs: t.int({ min: 3, max: 15 }), glucose: t.num({ min: 0, max: 60 }), painScore: t.int({ min: 0, max: 10 }) }),
    interventions: t.arr(t.str({ max: 120 }), { max: 20 }), medications: t.arr(t.obj({ name: t.str({ required: true, max: 80 }), dose: t.str({ max: 40 }), route: t.str({ max: 30 }) }), { max: 20 }),
    handoverNote: t.text({ max: 2000 }), note: t.text({ max: 1000 }),
  });
  if (!b.vitals && !b.interventions && !b.medications && !b.handoverNote && !b.note) throw bad('Nothing to record');
  const { inc } = await myIncident(req, param(req, 'id'));
  const entry = Object.assign({ id: id('pcr'), at: now(), by: req.ctx.user.id, byName: req.ctx.user.name }, b);
  const u = await db.col('incidents').findOneAndUpdate({ id: inc.id, orgId: inc.orgId, status: { $in: ['enroute', 'onscene', 'transporting', 'athospital'] } }, { $push: { care: entry } });
  if (!u) throw conflict('Care notes can be added from en route until the case is closed');
  await audit(req, 'ambulance.care_note', { type: 'incident', id: u.id, patientId: u.patientId }, { fields: Object.keys(b) });
  res.json({ ok: true, entry });
}));
router.post('/crew/availability', crewG, A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { availability: t.enum(['available', 'returning', 'offline'], { required: true }) });
  const unit = await myUnit(req);
  if (!unit) throw conflict('You are not assigned to a unit', 'no_unit');
  const u = await db.col('amb_units').findOneAndUpdate({ id: unit.id, orgId: unit.orgId, currentIncidentId: null, status: 'in_service' }, { $set: { availability: b.availability } });
  if (!u) throw conflict('Your unit is on a job or out of service');
  await audit(req, 'ambulance.availability', { type: 'unit', id: u.id }, { availability: b.availability });
  res.json(await unitView(u));
}));
if (config.DEMO_MODE) {
  /* DEMO ONLY (route does not exist unless DEMO_MODE=1): move the unit one step (about 400 m) toward its target */
  router.post('/crew/demo-drive', crewG, A.requireOnShift, ah(async (req, res) => {
    const b = body(req, { incidentId: t.id({ required: true }) });
    const { unit, inc } = await myIncident(req, b.incidentId);
    const tgt = targetOf(inc);
    if (!tgt || tgt.loc.lat == null) throw conflict('Nothing to drive to in this state');
    const from = unit.lastLoc && unit.lastLoc.lat != null ? unit.lastLoc : (req.ctx.org.location || tgt.loc);
    const km = haversineKm(from, tgt.loc) || 0;
    const f = km <= 0.4 ? 1 : 0.4 / km;
    const next = { lat: from.lat + (tgt.loc.lat - from.lat) * f, lng: from.lng + (tgt.loc.lng - from.lng) * f, accuracy: 10, speed: 11, heading: null };
    const r = await recordPosition(unit, next);
    res.json({ ok: true, demo: true, loc: r.loc, remainingKm: round1(Math.max(0, km - 0.4)), arrived: f === 1 });
  }));
}

/* ===================== patient SOS ===================== */
router.post('/me/emergency', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { lat: t.lat(), lng: t.lng(), category: t.enum(CAT_KEYS, { required: true }), note: t.str({ max: 300 }), address: t.str({ max: 300 }), landmark: t.str({ max: 200 }), providerOrgId: t.id() });
  const patient = req.ctx.patient;
  // location denied on the phone: accept a landmark/address and use the saved home location as an approximate point
  if (b.lat == null || b.lng == null) {
    if (!b.landmark && !b.address) throw bad('Share your location, or type a landmark or address so the ambulance can find you.');
    if (patient.homeLoc && patient.homeLoc.lat != null) { b.lat = patient.homeLoc.lat; b.lng = patient.homeLoc.lng; }
    else if (b.providerOrgId) { const po = await db.col('orgs').findOne({ id: b.providerOrgId, status: 'active' }); if (po && po.location) { b.lat = po.location.lat; b.lng = po.location.lng; } }
    if (b.lat == null) { const links = await db.col('patient_links').find({ patientId: patient.id, status: { $ne: 'removed' } }); const amb = links.length ? await db.col('orgs').findOne({ id: { $in: links.map(l => l.orgId) }, status: 'active', modules: 'ambulance' }) : null; if (amb && amb.location) { b.lat = amb.location.lat; b.lng = amb.location.lng; b.providerOrgId = b.providerOrgId || amb.id; } }
    if (b.lat == null) throw bad('We could not work out where you are. Call 112 now, or turn on location.');
    b.approximate = true;
    b.note = ('Location approximate (phone location off). Call the patient to confirm. ' + (b.note || '')).slice(0, 300);
  }
  if (!inNigeria(b.lat, b.lng)) throw bad('Your location looks outside Nigeria. Call 112.');
  const open = await db.col('incidents').findOne({ patientOpenKey: patient.id });
  if (open) return res.json(Object.assign(await patientIncidentView(open), { existing: true }));
  await RL.limit('sos_' + patient.id, 5, 3600, 'You have sent several emergency requests. Call 112 or the provider directly.');
  const route = await routeProvider({ lat: b.lat, lng: b.lng }, b.providerOrgId);
  await P.ensureLink(route.org.id, patient.id, req.ctx.user.id, 'emergency');
  let inc;
  try {
    inc = await createIncident({ org: route.org, source: 'app', caller: { name: patient.firstName + ' ' + patient.lastName, phone: patient.phone || null }, patient, location: b, category: b.category,
      verified: true, note: b.note, createdBy: actorOf(req), noUnitAvailable: route.noUnitAvailable });
  } catch (e) {
    if (e.code !== 11000) throw e;
    inc = await db.col('incidents').findOne({ patientOpenKey: patient.id });
    return res.json(Object.assign(await patientIncidentView(inc), { existing: true }));
  }
  await audit(req, 'ambulance.sos', { type: 'incident', id: inc.id, patientId: patient.id, orgId: route.org.id }, { category: b.category, chosen: !!b.providerOrgId, noUnit: route.noUnitAvailable });
  res.json(Object.assign(await patientIncidentView(inc), { existing: false, noUnitAvailable: route.noUnitAvailable }));
}));
router.get('/me/emergency/active', A.requirePatient, ah(async (req, res) => {
  const inc = await db.col('incidents').findOne({ patientId: req.ctx.patient.id, status: { $in: OPEN } }, { sort: { createdAt: -1 } });
  res.json({ incident: inc ? await patientIncidentView(inc) : null });
}));
router.get('/me/emergency', A.requirePatient, ah(async (req, res) => {
  const rows = await db.col('incidents').find({ patientId: req.ctx.patient.id }, { sort: { createdAt: -1 }, limit: 50 });
  const out = []; for (const r of rows) out.push(await patientIncidentView(r));
  res.json(out);
}));
router.get('/me/emergency/:id', A.requirePatient, ah(async (req, res) => {
  const inc = await db.col('incidents').findOne({ id: param(req, 'id'), patientId: req.ctx.patient.id });
  if (!inc) throw notFound('Emergency not found');
  res.json(await patientIncidentView(inc));
}));
router.post('/me/emergency/:id/cancel', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { reason: t.str({ max: 200 }) });
  const inc = await db.col('incidents').findOne({ id: param(req, 'id'), patientId: req.ctx.patient.id });
  if (!inc) throw notFound('Emergency not found');
  const c = await cancelIncident(req, inc, b.reason || 'Cancelled by patient', { by: req.ctx.user.id, byName: 'Patient', byKind: 'patient' }, PATIENT_CANCELLABLE);
  res.json(await patientIncidentView(c));
}));

/* ===================== public emergency line (no login) ===================== */
router.post('/emergency', ah(async (req, res) => {
  if (!S.feature('publicEmergency')) throw notFound('The public emergency line is not available. Call 112.');
  await RL.limitIp(req, 'pubsos', Number(S.get('process.emergency.publicPerIpPerHour', 5)) || 5, 3600, 'Too many emergency requests from this network. Call 112.');
  const b = body(req, { name: t.str({ required: true, max: 100, label: 'Name' }), phone: t.phone({ required: true }), lat: t.lat({ required: true }), lng: t.lng({ required: true }),
    address: t.str({ max: 300 }), landmark: t.str({ max: 200 }), category: t.enum(CAT_KEYS, { required: true }), note: t.str({ max: 300 }) });
  if (!inNigeria(b.lat, b.lng)) throw bad('The location must be in Nigeria');
  await RL.limit('pubsos_ph_' + b.phone, 3, 3600, 'Several requests were already sent from this phone. Call 112.');
  const existing = await db.col('incidents').findOne({ 'caller.phone': b.phone, source: 'public', status: { $in: OPEN } });
  if (existing) { const o = await orgs.getOrg(existing.orgId); return res.json({ ok: true, existing: true, incidentId: existing.id, number: existing.number, provider: { name: o.name, phone: (o.contact || {}).phone || null }, message: 'Your request is already with ' + o.name + '.' }); }
  const route = await routeProvider({ lat: b.lat, lng: b.lng });
  const token = id('tk').slice(3);
  const inc = await createIncident({ org: route.org, source: 'public', caller: { name: b.name, phone: b.phone }, patient: null, location: b, category: b.category, verified: false, note: b.note,
    createdBy: actorOf(req), noUnitAvailable: route.noUnitAvailable, publicToken: token });
  await audit(req, 'ambulance.public_sos', { type: 'incident', id: inc.id, orgId: route.org.id }, { category: b.category });
  res.json({ ok: true, existing: false, incidentId: inc.id, number: inc.number, trackToken: token, provider: { name: route.org.name, phone: (route.org.contact || {}).phone || null },
    message: route.org.name + ' has your request and will call you on ' + b.phone + '. Keep your phone free.' });
}));
router.get('/emergency/:id/status', ah(async (req, res) => {
  const q = query(req, { token: t.str({ required: true, max: 64 }) });
  const inc = await db.col('incidents').findOne({ id: param(req, 'id'), source: 'public' });
  if (!inc || !inc.publicTokenHash || inc.publicTokenHash !== sha256(q.token)) throw notFound('Not found');
  const v = await patientIncidentView(inc);
  delete v.location; delete v.destination;
  res.json(v);
}));

/* ===================== demo data ===================== */
async function seedDemo(ctx) {
  const t0 = now(); const today = todayLagos();
  const comp = (ins) => ({ registrationExpiry: addDays(today, 300), insuranceExpiry: addDays(today, ins || 200), inspectionExpiry: addDays(today, 150) });
  const swift = ctx.orgs.ambulance; const hosp = ctx.orgs.hospital;
  const S = ctx.staff.ambulance; const H = ctx.staff.hospital;
  const mkUnit = async (org, name, type, plate, loc, crew, ins) => {
    const u = { id: id('unit'), orgId: org.id, name, type, plate, status: 'in_service', availability: 'available', currentIncidentId: null, compliance: comp(ins), crewMembershipIds: crew.map(c => c.membership.id),
      lastLoc: loc ? { lat: loc.lat, lng: loc.lng, accuracy: 15, speed: 0, heading: null, at: t0 } : null, createdAt: t0, demo: true };
    await db.col('amb_units').insertOne(u); return u;
  };
  const mkCrew = async (org, s, cert, lic) => db.col('amb_crew').insertOne({ id: id('crw'), orgId: org.id, membershipId: s.membership.id, userId: s.user.id, certification: cert, licenceNo: lic, licenceExpiry: addDays(today, 400), verified: true, verifiedBy: 'demo', verifiedAt: t0, createdAt: t0 });
  const als = await mkUnit(swift, 'SwiftAid 1 (ALS)', 'ALS', 'LND-482-KJ', { lat: 6.6030, lng: 3.3490 }, [S.crew], 60);
  await mkUnit(swift, 'SwiftAid 2 (BLS)', 'BLS', 'KJA-219-AB', { lat: 6.5960, lng: 3.3420 }, [S.crew2]);
  await mkUnit(swift, 'SwiftAid Moto 1', 'motorbike', 'IKJ-77-QA', { lat: 6.6100, lng: 3.3560 }, []);
  await mkCrew(swift, S.crew, 'Paramedic', 'NEMSAS-PM-10422'); await mkCrew(swift, S.crew2, 'EMT-B', 'NEMSAS-EB-20981');
  await mkUnit(hosp, 'Grandville A1', 'ALS', 'SRL-301-GV', { lat: 6.4995, lng: 3.3545 }, [H.crew]);
  await mkUnit(hosp, 'Grandville B2', 'BLS', 'SRL-302-GV', null, []);
  await mkCrew(hosp, H.crew, 'EMT-I', 'NEMSAS-EI-33310');
  const sys = { by: 'demo', byName: 'Demo' };
  // open unverified public call at SwiftAid
  await createIncident({ org: swift, source: 'public', caller: { name: 'Musa Danjuma', phone: '+2348091112233' }, patient: null, location: { lat: 6.6006, lng: 3.3536, address: 'Allen Avenue roundabout, Ikeja', landmark: 'Opposite the filling station' },
    category: 'road_traffic_accident', verified: false, note: 'Motorcycle and car, one person on the ground', createdBy: sys, publicToken: id('tk').slice(3) });
  // closed incident (Zainab, transported to Grandville) with a bill
  const z = ctx.patients.zainab;
  const inc = await createIncident({ org: swift, source: 'call', caller: { name: 'Hauwa Bello', phone: '+2348025550101' }, patient: z, location: { lat: 6.6010, lng: 3.3550, address: '4 Allen Avenue, Ikeja' }, category: 'seizure', createdBy: sys });
  const T = t0 - 3 * 86400e3; const m = 60000;
  const times = { new: T, assigned: T + 2 * m, enroute: T + 3 * m, onscene: T + 11 * m, transporting: T + 25 * m, athospital: T + 52 * m, closed: T + 70 * m };
  const pts = [[6.6010, 3.3550], [6.5800, 3.3500], [6.5500, 3.3480], [6.5200, 3.3500], [6.4990, 3.3540]];
  for (let i = 0; i < pts.length; i++) await db.col('incident_track').insertOne({ id: id('trk'), incidentId: inc.id, orgId: swift.id, unitId: als.id, lat: pts[i][0], lng: pts[i][1], at: times.transporting + i * 6 * m, status: 'transporting' });
  const closed = await db.col('incidents').findOneAndUpdate({ id: inc.id }, { $set: { status: 'closed', createdAt: T, times, unitId: als.id, unitName: als.name, destination: { orgId: hosp.id, name: hosp.name, lat: hosp.location.lat, lng: hosp.location.lng, address: null },
    timeline: Object.entries(times).map(([status, at]) => ({ status, at, by: 'demo', byName: status === 'new' ? 'Lanre Shittu' : 'Paul Okeke', note: null })),
    care: [{ id: id('pcr'), at: T + 15 * m, by: S.crew.user.id, byName: S.crew.user.name, vitals: { pulse: 128, rr: 26, spo2: 95, tempC: 39.2 }, interventions: ['Recovery position', 'Oxygen via mask'], handoverNote: 'Febrile seizure, 3 minutes, now post-ictal.' }] }, $unset: { patientOpenKey: '' } });
  await billIncident(closed);
}

/**
 * USSD emergency (no GPS on feature phones): route by the patient's saved home location, else to an
 * ambulance provider the patient is already linked to. Unverified location: the dispatcher calls back.
 */
async function createIncidentFromUssd({ patient, phone, landmark, approxLocation }) {
  const open = await db.col('incidents').findOne({ patientOpenKey: patient.id });
  if (open) return open;
  let route;
  if (approxLocation && approxLocation.lat != null) route = await routeProvider({ lat: approxLocation.lat, lng: approxLocation.lng });
  else {
    const links = await db.col('patient_links').find({ patientId: patient.id, status: { $ne: 'removed' } });
    const orgs = links.length ? await db.col('orgs').find({ id: { $in: links.map(l => l.orgId) }, status: 'active', modules: 'ambulance' }) : [];
    if (!orgs.length) throw conflict('No ambulance service knows your location. Call 112.', 'no_location');
    route = await routeProvider(null, orgs[0].id);
  }
  await P.ensureLink(route.org.id, patient.id, null, 'emergency');
  const loc = Object.assign({ address: null }, approxLocation || {}, { landmark: String(landmark || '').slice(0, 200), approximate: true });
  if (loc.lat == null && route.org.location) { loc.lat = route.org.location.lat; loc.lng = route.org.location.lng; loc.locationUnknown = true; }
  return createIncident({ org: route.org, source: 'ussd', caller: { name: patient.firstName + ' ' + patient.lastName, phone: phone || patient.phone || null }, patient, location: loc, category: 'other',
    verified: false, note: 'USSD request. Location is approximate: call the patient back to confirm. Landmark: ' + String(landmark || '').slice(0, 150), createdBy: 'ussd', noUnitAvailable: route.noUnitAvailable });
}
module.exports = { name: 'ambulance', router, seedDemo, CATEGORIES, TRANSITIONS, routeProvider, readiness, createIncidentFromUssd };
