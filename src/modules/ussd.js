'use strict';
/*
 * USSD channel (Africa's Talking style aggregator callback).
 *
 *   POST /api/ussd   form or JSON: sessionId, serviceCode, phoneNumber, text
 *   Auth: X-USSD-Key header or ?key= must equal USSD_SECRET (constant-time compare).
 *   Reply: text/plain starting "CON " (more input) or "END " (session over).
 *
 * Only patients with a MediCore account AND a USSD PIN (set in the patient app) are served.
 * Every menu except emergency needs the PIN; 3 wrong PINs lock USSD for that patient for 1 hour.
 * Replies never carry clinical details (no test names, results, diagnoses or drugs).
 */
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const { ah, normPhone } = require('../lib/http');
const { now, utcToLagos } = require('../lib/util');
const { audit } = require('../lib/audit');
const RL = require('../lib/ratelimit');

const router = express.Router();
const LOCK_FAILS = 3;
const LOCK_MS = 3600e3;
const MAX_LEN = 182; // a USSD screen

const MENU = 'CON MediCore\n1 My next appointment\n2 My HMO cover balance\n3 My latest lab result status\n4 Emergency: request ambulance\n0 Exit';

function sameSecret(given, secret) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(secret)).digest();
  return crypto.timingSafeEqual(a, b) && String(given || '').length === String(secret).length;
}
const reply = (res, s) => { res.set('Content-Type', 'text/plain; charset=utf-8'); res.status(200).send(s.length > MAX_LEN ? s.slice(0, MAX_LEN - 1) + '.' : s); };
const fmtN = k => 'NGN ' + Math.round(k / 100).toLocaleString('en-NG');
const fakeReq = (req, patient) => ({ headers: req.headers, ip: req.ip, ctx: { user: patient.userId ? { id: patient.userId, kind: 'patient', name: null } : null, app: 'ussd' } });

/* ---- PIN lockout (own collection, atomic) ---- */
async function lockState(patientId) { const r = await db.col('ussd_locks').findOne({ id: 'ul_' + patientId }); return r && r.lockedUntil && r.lockedUntil > now() ? r.lockedUntil : null; }
async function pinFailed(patientId) {
  const r = await db.col('ussd_locks').findOneAndUpdate({ id: 'ul_' + patientId }, { $inc: { fails: 1 }, $setOnInsert: { id: 'ul_' + patientId, patientId } }, { upsert: true });
  if (r.fails >= LOCK_FAILS) { await db.col('ussd_locks').updateOne({ id: r.id }, { $set: { fails: 0, lockedUntil: now() + LOCK_MS } }); return { locked: true, left: 0 }; }
  return { locked: false, left: LOCK_FAILS - r.fails };
}
async function pinOk(patientId) { await db.col('ussd_locks').updateOne({ id: 'ul_' + patientId }, { $set: { fails: 0 }, $unset: { lockedUntil: '' } }); }

/* ---- menu content ---- */
const apptTime = a => a.startUtc || a.startAt || a.start || a.at || a.slotStart || (a.date ? Date.parse(a.date + 'T' + (a.time || '00:00') + ':00+01:00') : null);
async function nextAppointment(patient) {
  const rows = await db.col('appointments').find({ patientId: patient.id, status: { $nin: ['cancelled', 'completed', 'no_show', 'missed', 'declined'] } }, { limit: 200 });
  const up = rows.map(a => ({ a, at: apptTime(a) })).filter(x => x.at && x.at >= now() - 3600e3).sort((x, y) => x.at - y.at)[0];
  if (!up) return 'END You have no upcoming appointment. Book one in the MediCore app.';
  const org = await db.col('orgs').findOne({ id: up.a.orgId }, { projection: { name: 1 } });
  const l = utcToLagos(up.at); const d = new Date(up.at + 3600e3);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][l.dow] + ' ' + d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return 'END Next appointment: ' + day + ' ' + l.time + (org ? ' at ' + org.name : '') + (up.a.mode === 'video' || up.a.kind === 'video' ? ' (video)' : '') + '.';
}
async function coverBalance(patient) {
  const today = utcToLagos(now()).date;
  const rows = (await db.col('coverages').find({ patientId: patient.id, status: 'active', patientConfirmed: true })).filter(c => !c.validTo || c.validTo >= today);
  if (!rows.length) return 'END You have no active HMO cover on MediCore.';
  const parts = [];
  for (const c of rows.slice(0, 2)) {
    const o = await db.col('orgs').findOne({ id: c.payerOrgId }, { projection: { name: 1 } });
    const rem = k => Math.max(0, ((c.limits || {})[k] || 0) - ((c.usedKobo || {})[k] || 0));
    parts.push((o ? o.name : 'HMO') + ' ' + c.memberNo + ' to ' + c.validTo + ': Consult ' + fmtN(rem('consultation')) + ', Drugs ' + fmtN(rem('drug')) + ', Lab ' + fmtN(rem('lab')));
  }
  return 'END ' + parts.join('\n');
}
const LAB_STATUS = { awaiting_lab: 'waiting for you to choose a lab', ordered: 'ordered', sent: 'sent to the lab', received: 'sample received', collected: 'sample collected', in_progress: 'being processed', processing: 'being processed', resulted: 'being checked', verified: 'being checked', released: 'result ready', cancelled: 'cancelled', rejected: 'sample rejected, contact the lab' };
async function labStatus(patient) {
  const o = await db.col('lab_orders').findOne({ patientId: patient.id }, { sort: { createdAt: -1 } });
  if (!o) return 'END You have no lab tests on MediCore.';
  const d = utcToLagos(o.createdAt || now()).date;
  const s = LAB_STATUS[o.status] || 'in progress';
  return 'END Your latest lab test (ordered ' + d + '): ' + s + '.' + (o.status === 'released' ? ' Open the MediCore app to view it.' : '');
}
async function emergency(req, patient, landmark) {
  let amb = null; try { amb = require('./ambulance'); } catch (e) { amb = null; }
  // contract (ambulance module): createIncidentFromUssd({ patient, phone, landmark, approxLocation }) -> incident doc.
  // approxLocation is the patient's saved home location (may be null); USSD has no GPS.
  const fn = amb && amb.createIncidentFromUssd;
  if (typeof fn !== 'function') return 'END Ambulance requests by USSD are not available yet. Call 112 now.';
  try {
    const inc = await fn({ patient, phone: patient.phone, landmark, approxLocation: patient.homeLoc || null });
    await audit(fakeReq(req, patient), 'ussd.emergency', { type: 'incident', id: inc && inc.id, patientId: patient.id, orgId: inc && inc.orgId !== undefined ? inc.orgId : null });
    return 'END Ambulance requested. Keep your phone on; the crew will call you. If it is life-threatening also call 112.';
  } catch (e) {
    return 'END We could not place the request: ' + String(e && e.message ? e.message : 'no ambulance available').slice(0, 80) + '. Call 112 now.';
  }
}

router.post('/ussd', ah(async (req, res) => {
  if (!require('../lib/settings').feature('ussd')) return res.status(503).json({ error: 'USSD is switched off', code: 'feature_off' });
  if (!config.USSD_SECRET) return res.status(503).json({ error: 'USSD not configured', code: 'not_configured' });
  const key = req.headers['x-ussd-key'] || (req.query && req.query.key);
  if (!sameSecret(Array.isArray(key) ? key[0] : key, config.USSD_SECRET)) return res.status(401).json({ error: 'Unauthorised', code: 'unauthorized' });
  const b = req.body || {};
  const phone = normPhone(typeof b.phoneNumber === 'string' ? b.phoneNumber : '');
  if (!phone) return reply(res, 'END Sorry, we could not read your phone number.');
  try { await RL.limit('ussd_' + phone, 40, 600); } catch (e) { return reply(res, 'END Too many requests. Please try again in a few minutes.'); }
  const patient = await db.col('patients').findOne({ phone, status: { $ne: 'removed' } });
  const user = patient && patient.userId ? await db.col('users').findOne({ id: patient.userId, status: 'active' }, { projection: { id: 1 } }) : null;
  if (!patient || !user || !patient.ussdPinHash) return reply(res, 'END This number is not set up for MediCore USSD. In the MediCore app open Settings and set a USSD PIN.');
  const text = typeof b.text === 'string' ? b.text.slice(0, 200) : '';
  const parts = text === '' ? [] : text.split('*').map(s => s.trim());
  if (!parts.length) return reply(res, MENU);
  const choice = parts[0];
  if (choice === '0') return reply(res, 'END Thank you for using MediCore.');
  if (choice === '4') {
    if (parts.length === 1) return reply(res, 'CON Emergency. Type your location or a nearby landmark:');
    const landmark = parts[1].replace(/[^\w\s,.'/-]/g, '').slice(0, 120);
    if (landmark.length < 3) return reply(res, 'CON Please type your location or a nearby landmark:');
    if (parts.length === 2) return reply(res, 'CON Send an ambulance to: ' + landmark.slice(0, 80) + '?\n1 Yes\n2 No');
    if (parts[2] !== '1') return reply(res, 'END Request cancelled. If it is an emergency call 112.');
    return reply(res, await emergency(req, patient, landmark));
  }
  if (!['1', '2', '3'].includes(choice)) return reply(res, 'END Invalid choice.');
  const lockedUntil = await lockState(patient.id);
  if (lockedUntil) return reply(res, 'END USSD is locked after 3 wrong PINs. Try again after ' + utcToLagos(lockedUntil).time + ' or use the MediCore app.');
  if (parts.length === 1) return reply(res, 'CON Enter your 4-digit MediCore PIN:');
  const pin = parts[1];
  const ok = /^\d{4}$/.test(pin) && await bcrypt.compare('ussd:' + pin, patient.ussdPinHash);
  if (!ok) {
    const f = await pinFailed(patient.id);
    await audit(fakeReq(req, patient), 'ussd.pin_failed', { type: 'patient', id: patient.id, patientId: patient.id, orgId: null }, { locked: f.locked });
    return reply(res, f.locked ? 'END Wrong PIN. USSD is now locked for 1 hour.' : 'END Wrong PIN. ' + f.left + ' attempt' + (f.left === 1 ? '' : 's') + ' left.');
  }
  await pinOk(patient.id);
  const out = choice === '1' ? await nextAppointment(patient) : choice === '2' ? await coverBalance(patient) : await labStatus(patient);
  await audit(fakeReq(req, patient), 'ussd.menu', { type: 'patient', id: patient.id, patientId: patient.id, orgId: null }, { menu: choice, session: String(b.sessionId || '').slice(0, 40) });
  return reply(res, out);
}));

module.exports = { name: 'ussd', router, LOCK_FAILS, LOCK_MS };
