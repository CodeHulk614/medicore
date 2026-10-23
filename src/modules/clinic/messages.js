'use strict';
/*
 * Secure messages between a patient and a provider (optionally addressed to one doctor).
 * The sender's name and side always come from the session, never from the request body.
 * Text is stored as plain text (control characters and HTML-like tags removed); clients
 * must still render it as text, never as HTML. Unread counters live on the thread and are
 * reset by an explicit POST .../read (GET never changes state).
 */
const express = require('express');
const db = require('../../db');
const { ah, body, query, t, bad, notFound, param } = require('../../lib/http');
const A = require('../../lib/auth');
const { id, now } = require('../../lib/util');
const { audit } = require('../../lib/audit');
const { notify } = require('../../lib/notify');
const RL = require('../../lib/ratelimit');
const P = require('../patients');
const C = require('./common');

db.index('message_threads', ['orgId', 'lastAt']);
db.index('message_threads', ['patientId', 'lastAt']);
db.index('messages', ['threadId', 'at']);
db.index('messages', ['patientId', 'at']);

const router = express.Router();
const textRule = t.str({ required: true, max: 2000, label: 'Message' });

function threadView(th, side) {
  return { id: th.id, orgId: th.orgId, orgName: th.orgName, patientId: th.patientId, patientName: th.patientName, doctorMembershipId: th.doctorMembershipId || null, doctorName: th.doctorName || null,
    subject: th.subject, status: th.status, createdAt: th.createdAt, lastAt: th.lastAt, lastFrom: th.lastFrom, lastPreview: th.lastPreview,
    unread: side === 'patient' ? (th.unreadForPatient || 0) : (th.unreadForStaff || 0) };
}
const msgView = m => ({ id: m.id, threadId: m.threadId, seq: m.seq, from: m.from, senderName: m.senderName, senderRole: m.senderRole || null, text: m.text, at: m.at });

function cleanText(raw) { const s = C.plainText(raw); if (!s) throw bad('Write a message'); return s; }

async function addMessage(req, th, from, text) {
  const t0 = now();
  const senderName = from === 'patient' ? req.ctx.patient.firstName + ' ' + req.ctx.patient.lastName : req.ctx.user.name;
  const upd = await db.col('message_threads').findOneAndUpdate({ id: th.id, orgId: th.orgId, status: 'open' },
    { $inc: from === 'patient' ? { unreadForStaff: 1, seq: 1 } : { unreadForPatient: 1, seq: 1 }, $set: { lastAt: t0, lastFrom: from, lastPreview: text.slice(0, 80) } });
  if (!upd) throw C.stateConflict('conversation', 'closed', 'reply');
  const m = { id: id('msg'), threadId: th.id, orgId: th.orgId, patientId: th.patientId, seq: upd.seq, from, senderUserId: req.ctx.user.id, senderName, senderRole: from === 'staff' ? req.ctx.role : null, text, at: t0 };
  await db.col('messages').insertOne(m);
  if (from === 'patient') {
    if (th.doctorUserId) await notify({ userId: th.doctorUserId, title: 'New message from a patient', body: 'Open MediCore to read it.', kind: 'message', ref: { type: 'thread', id: th.id } });
    else await notify({ orgId: th.orgId, role: 'care', title: 'New patient message', body: 'Open MediCore to read it.', kind: 'message', ref: { type: 'thread', id: th.id } });
  } else {
    await notify({ patientId: th.patientId, title: 'New message from ' + th.orgName, body: 'Open the MediCore app to read it.', kind: 'message', ref: { type: 'thread', id: th.id } });
  }
  return { thread: upd, message: m };
}

async function newThread(req, { orgId, patientId, doctorMembershipId, subject, startedBy }) {
  const org = await db.col('orgs').findOne({ id: orgId, status: 'active' });
  if (!org) throw notFound('Provider not found');
  let doctor = null;
  if (doctorMembershipId) { doctor = await C.doctorAt(orgId, doctorMembershipId); }
  const p = await db.col('patients').findOne({ id: patientId });
  const th = { id: id('th'), orgId, orgName: org.name, patientId, patientName: p ? p.firstName + ' ' + p.lastName : 'Patient', doctorMembershipId: doctor ? doctor.id : null, doctorUserId: doctor ? doctor.userId : null,
    doctorName: doctor ? await C.userName(doctor.userId) : null, subject: C.plainText(subject) || 'Message', status: 'open', startedBy, createdAt: now(), lastAt: now(), lastFrom: null, lastPreview: null, unreadForPatient: 0, unreadForStaff: 0, seq: 0 };
  await db.col('message_threads').insertOne(th);
  return th;
}

/* ---------------- patient ---------------- */
router.post('/me/threads', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { orgId: t.id({ required: true }), doctorMembershipId: t.id(), subject: t.str({ required: true, min: 2, max: 120 }), text: textRule });
  await RL.limit('msg_' + req.ctx.user.id, 60, 3600);
  if (!(await P.linkOf(b.orgId, req.ctx.patient.id))) throw notFound('You can message providers you are registered with');
  const text = cleanText(b.text);
  const th = await newThread(req, { orgId: b.orgId, patientId: req.ctx.patient.id, doctorMembershipId: b.doctorMembershipId, subject: b.subject, startedBy: 'patient' });
  const r = await addMessage(req, th, 'patient', text);
  await audit(req, 'clinic.thread_start', { type: 'thread', id: th.id, patientId: th.patientId, orgId: th.orgId });
  res.json({ thread: threadView(r.thread, 'patient'), message: msgView(r.message) });
}));
router.get('/me/threads', A.requirePatient, ah(async (req, res) => {
  const rows = await db.col('message_threads').find(Object.assign({ patientId: req.ctx.patient.id }, await P.scopeFilter(req)), { sort: { lastAt: -1 }, limit: 200 });
  const threads = rows.map(th => threadView(th, 'patient'));
  res.json({ threads, unreadTotal: threads.reduce((s, x) => s + x.unread, 0) });
}));
async function patientThread(req) {
  const th = await db.col('message_threads').findOne({ id: param(req, 'id'), patientId: req.ctx.patient.id });
  if (!th) throw notFound('Conversation not found');
  return th;
}
router.get('/me/threads/:id/messages', A.requirePatient, ah(async (req, res) => {
  const q = query(req, { after: t.int({ min: 0 }) });
  const th = await patientThread(req);
  const rows = await db.col('messages').find({ threadId: th.id, seq: { $gt: q.after || 0 } }, { sort: { seq: 1 }, limit: 500 });
  res.json({ thread: threadView(th, 'patient'), messages: rows.map(msgView) });
}));
router.post('/me/threads/:id/messages', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { text: textRule });
  await RL.limit('msg_' + req.ctx.user.id, 60, 3600);
  const th = await patientThread(req);
  const r = await addMessage(req, th, 'patient', cleanText(b.text));
  await audit(req, 'clinic.message_send', { type: 'thread', id: th.id, patientId: th.patientId, orgId: th.orgId });
  res.json({ thread: threadView(r.thread, 'patient'), message: msgView(r.message) });
}));
router.post('/me/threads/:id/read', A.requirePatient, ah(async (req, res) => {
  const th = await patientThread(req);
  const upd = await db.col('message_threads').findOneAndUpdate({ id: th.id, patientId: th.patientId }, { $set: { unreadForPatient: 0 } });
  res.json(threadView(upd, 'patient'));
}));

/* ---------------- staff (doctors and customer care) ---------------- */
const staff = A.requireStaff({ anyPerm: ['clinic.consult', 'care.manage'] });
/** doctors without care.manage see threads addressed to them or to nobody in particular */
function staffScope(req) {
  const f = { orgId: req.ctx.org.id };
  if (!A.has(req, 'care.manage')) f.doctorMembershipId = { $in: [req.ctx.membership.id, null] };
  return f;
}
async function staffThread(req) {
  const th = await db.col('message_threads').findOne(Object.assign(staffScope(req), { id: param(req, 'id') }));
  if (!th) throw notFound('Conversation not found');
  return th;
}
router.get('/msg/threads', staff, ah(async (req, res) => {
  const q = query(req, { status: t.enum(['open', 'closed']), patientId: t.id(), mine: t.bool(), limit: t.int({ min: 1, max: 500 }) });
  const f = staffScope(req);
  if (q.status) f.status = q.status;
  if (q.patientId) f.patientId = q.patientId;
  if (q.mine) f.doctorMembershipId = req.ctx.membership.id;
  const rows = await db.col('message_threads').find(f, { sort: { lastAt: -1 }, limit: q.limit || 100 });
  const threads = rows.map(th => threadView(th, 'staff'));
  res.json({ threads, unreadTotal: threads.reduce((s, x) => s + x.unread, 0) });
}));
router.post('/msg/threads', staff, ah(async (req, res) => {
  const b = body(req, { patientId: t.id({ required: true }), subject: t.str({ required: true, min: 2, max: 120 }), text: textRule, doctorMembershipId: t.id() });
  await P.requireLinked(req, b.patientId);
  await RL.limit('msg_' + req.ctx.user.id, 200, 3600);
  const text = cleanText(b.text);
  let docId = b.doctorMembershipId || null;
  if (!docId && A.has(req, 'clinic.consult') && C.isDoctor(req.ctx.membership)) docId = req.ctx.membership.id;
  const th = await newThread(req, { orgId: req.ctx.org.id, patientId: b.patientId, doctorMembershipId: docId, subject: b.subject, startedBy: 'staff' });
  const r = await addMessage(req, th, 'staff', text);
  await audit(req, 'clinic.thread_start', { type: 'thread', id: th.id, patientId: th.patientId });
  res.json({ thread: threadView(r.thread, 'staff'), message: msgView(r.message) });
}));
router.get('/msg/threads/:id/messages', staff, ah(async (req, res) => {
  const q = query(req, { after: t.int({ min: 0 }) });
  const th = await staffThread(req);
  await P.requireLinked(req, th.patientId);
  const rows = await db.col('messages').find({ threadId: th.id, seq: { $gt: q.after || 0 } }, { sort: { seq: 1 }, limit: 500 });
  await audit(req, 'clinic.thread_view', { type: 'thread', id: th.id, patientId: th.patientId });
  res.json({ thread: threadView(th, 'staff'), messages: rows.map(msgView) });
}));
router.post('/msg/threads/:id/messages', staff, ah(async (req, res) => {
  const b = body(req, { text: textRule });
  await RL.limit('msg_' + req.ctx.user.id, 200, 3600);
  const th = await staffThread(req);
  await P.requireLinked(req, th.patientId);
  const r = await addMessage(req, th, 'staff', cleanText(b.text));
  await audit(req, 'clinic.message_send', { type: 'thread', id: th.id, patientId: th.patientId });
  res.json({ thread: threadView(r.thread, 'staff'), message: msgView(r.message) });
}));
router.post('/msg/threads/:id/read', staff, ah(async (req, res) => {
  const th = await staffThread(req);
  const upd = await db.col('message_threads').findOneAndUpdate({ id: th.id, orgId: th.orgId }, { $set: { unreadForStaff: 0 } });
  res.json(threadView(upd, 'staff'));
}));
router.post('/msg/threads/:id/:action(close|reopen)', staff, ah(async (req, res) => {
  const th = await staffThread(req);
  const to = req.params.action === 'close' ? 'closed' : 'open';
  const upd = await C.move('message_threads', C.THREAD_TRANSITIONS, { id: th.id, orgId: th.orgId }, to, { [to === 'closed' ? 'closedAt' : 'reopenedAt']: now(), updatedBy: req.ctx.user.id });
  if (!upd) throw C.stateConflict('conversation', th.status, to);
  await audit(req, 'clinic.thread_' + req.params.action, { type: 'thread', id: th.id, patientId: th.patientId });
  res.json(threadView(upd, 'staff'));
}));

module.exports = { router };
