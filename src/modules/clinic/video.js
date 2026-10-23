'use strict';
/*
 * Video visits: WebRTC signalling through the database (serverless instances share nothing in
 * memory). Only the appointment's patient and its assigned doctor can join, only for a paid
 * video appointment, and only from 15 minutes before to 60 minutes after the start.
 * The doctor is the caller (sends the offer); the patient is the callee (answers).
 * Media flows peer to peer (or through TURN); MediCore never sees or records it.
 */
const express = require('express');
const db = require('../../db');
const config = require('../../config');
const { HttpError, ah, body, query, t, forbidden, notFound, conflict, param } = require('../../lib/http');
const A = require('../../lib/auth');
const { id, now } = require('../../lib/util');
const { audit } = require('../../lib/audit');
const RL = require('../../lib/ratelimit');
const { nextNumber } = require('../orgs');
const C = require('./common');
const SET = require('../../lib/settings');

db.index('video_signals', ['appointmentId', 'seq'], { unique: true });

const router = express.Router();

/** STUN always; TURN from HQ settings (integrations.turn) or, failing that, TURN_URL/TURN_USER/TURN_PASS */
function iceServers() {
  const list = [{ urls: 'stun:stun.l.google.com:19302' }];
  const url = SET.get('integrations.turn.url', '') || config.TURN_URL;
  if (url) {
    const user = SET.get('integrations.turn.username', '') || config.TURN_USER;
    const cred = SET.decrypt(SET.get('integrations.turn.credential', null)) || config.TURN_PASS;
    list.push({ urls: url.split(',').map(s => s.trim()).filter(Boolean), username: user || undefined, credential: cred || undefined });
  }
  return list;
}

/** who is asking, and may they use this room right now? Never writes. */
async function access(req, apptId) {
  A.needUser(req);
  const c = req.ctx; let appt = null, side = null;
  if (c.kind === 'patient') { appt = await db.col('appointments').findOne({ id: apptId, patientId: c.patient.id }); side = 'patient'; }
  else if (c.kind === 'staff') {
    if (!A.has(req, 'clinic.consult') || !(c.org.modules || []).includes('clinic')) throw forbidden('Only the assigned doctor can join this video visit');
    appt = await db.col('appointments').findOne({ id: apptId, orgId: c.org.id, doctorMembershipId: c.membership.id }); side = 'doctor';
  } else throw forbidden();
  if (!appt) throw notFound('Appointment not found');
  if (appt.type !== 'video') throw conflict('This is an in-person appointment, not a video visit.', 'not_video');
  const org = await db.col('orgs').findOne({ id: appt.orgId });
  if (!C.tun.video(org)) throw new HttpError(403, 'Video visits are switched off at the moment.', 'feature_off');
  if (!C.ACTIVE_APPT.includes(appt.status)) throw conflict('This visit is ' + appt.status.replace('_', ' ') + '.', 'visit_closed');
  const bill = appt.billId ? await db.col('bills').findOne({ id: appt.billId, orgId: appt.orgId }) : null;
  if (C.tun.payBeforeVideo(org) && (!bill || bill.status !== 'paid')) throw new HttpError(402, side === 'patient' ? 'Please pay for this video visit to join.' : 'The patient has not paid for this video visit yet.', 'payment_required', { billId: appt.billId });
  const t0 = now(), { opensAt, closesAt } = C.videoWindow(appt, org);
  if (t0 < opensAt) throw new HttpError(409, 'The video room opens ' + Math.round(C.tun.earlyMs(org) / 60000) + ' minutes before the appointment.', 'too_early', { opensAt, closesAt });
  if (t0 > closesAt) throw new HttpError(409, 'The video room for this appointment has closed.', 'window_closed', { opensAt, closesAt });
  return { appt, side, opensAt, closesAt };
}

router.post('/video/:appointmentId/join', A.requireOnShift, ah(async (req, res) => {
  const { appt, side, opensAt, closesAt } = await access(req, param(req, 'appointmentId'));
  await db.col('appointments').updateOne({ id: appt.id }, { $set: { ['video.' + side + 'JoinedAt']: now() } });
  const last = await db.col('video_signals').findOne({ appointmentId: appt.id }, { sort: { seq: -1 } });
  const peer = side === 'doctor' ? (await C.patientBrief(appt.patientId, appt.orgId)).name : appt.doctorName;
  await audit(req, 'clinic.video_join', { type: 'appointment', id: appt.id, patientId: appt.patientId, orgId: appt.orgId }, { side });
  res.json({ appointmentId: appt.id, role: side === 'doctor' ? 'caller' : 'callee', side, peerName: peer, iceServers: iceServers(), opensAt, closesAt, lastSeq: last ? last.seq : 0, pollMs: 1500 });
}));

router.post('/video/:appointmentId/signal', A.requireOnShift, ah(async (req, res) => {
  const b = body(req, { type: t.enum(['offer', 'answer', 'ice', 'bye'], { required: true }), data: t.any({ maxBytes: 16384, label: 'Signal data' }) });
  const { appt, side } = await access(req, param(req, 'appointmentId'));
  await RL.limit('vsig_' + req.ctx.user.id + '_' + appt.id, 900, 600);
  const seq = await nextNumber('vsig_' + appt.id);
  const s = { id: id('vs'), appointmentId: appt.id, orgId: appt.orgId, seq, from: side, type: b.type, data: b.data === undefined ? null : b.data, at: now() };
  await db.col('video_signals').insertOne(s);
  res.json({ ok: true, seq });
}));

router.get('/video/:appointmentId/signals', ah(async (req, res) => {
  const q = query(req, { after: t.int({ min: 0 }) });
  const { appt, side } = await access(req, param(req, 'appointmentId'));
  const rows = await db.col('video_signals').find({ appointmentId: appt.id, seq: { $gt: q.after || 0 }, from: side === 'doctor' ? 'patient' : 'doctor' }, { sort: { seq: 1 }, limit: 200 });
  const last = await db.col('video_signals').findOne({ appointmentId: appt.id }, { sort: { seq: -1 } });
  res.json({ signals: rows.map(s => ({ seq: s.seq, from: s.from, type: s.type, data: s.data, at: s.at })), lastSeq: last ? last.seq : 0 });
}));

module.exports = { router, iceServers };
