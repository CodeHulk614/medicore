'use strict';
/*
 * Support tickets and complaints from providers to the MediCore team.
 * Provider admins (and any staff with admin.settings or admin.staff) raise tickets from the admin
 * console; HQ triages, replies, assigns and resolves. Patients' complaints about a provider go to
 * that provider's customer care (clinic module); a provider can escalate one to MediCore here.
 *
 *   ticket: { id, number, orgId, raisedBy, category, priority, subject, status, assigneeId,
 *             messages: [{ id, at, by, byName, side: 'provider'|'medicore', text, internal }],
 *             slaDueAt, firstResponseAt, resolvedAt, rating }
 *   status: open -> in_progress -> waiting_provider -> in_progress ... -> resolved -> closed
 *           (a provider reply reopens waiting_provider or resolved to in_progress)
 */
const express = require('express');
const db = require('../db');
const A = require('../lib/auth');
const { ah, body, query, t, bad, notFound, conflict, param } = require('../lib/http');
const { id, now } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const { nextNumber } = require('./orgs');

db.index('support_tickets', ['orgId', 'createdAt']);
db.index('support_tickets', ['status', 'priority']);

const router = express.Router();
const CATEGORIES = ['billing_subscription', 'technical_problem', 'feature_request', 'data_correction', 'account_access', 'complaint', 'integration', 'training', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const SLA_HOURS = { urgent: 4, high: 12, normal: 48, low: 120 };
const STATUSES = ['open', 'in_progress', 'waiting_provider', 'resolved', 'closed'];

const providerGuard = A.requireStaff({ anyPerm: ['admin.settings', 'admin.staff', 'admin.reports'] });
const msg = (req, side, text, internal) => ({ id: id('tm'), at: now(), by: req.ctx.user.id, byName: req.ctx.user.name, side, text, internal: !!internal });
const providerView = tk => Object.assign({}, tk, { messages: (tk.messages || []).filter(m => !m.internal) });

/* -------- provider admin side -------- */
router.get('/admin/support', providerGuard, ah(async (req, res) => {
  res.json((await db.col('support_tickets').find({ orgId: req.ctx.org.id }, { sort: { createdAt: -1 }, limit: 200 })).map(providerView));
}));
router.get('/admin/support/:id', providerGuard, ah(async (req, res) => {
  const tk = await db.col('support_tickets').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id }); if (!tk) throw notFound('Ticket not found');
  res.json(providerView(tk));
}));
router.post('/admin/support', providerGuard, ah(async (req, res) => {
  const b = body(req, { category: t.enum(CATEGORIES, { required: true }), priority: t.enum(PRIORITIES, { default: 'normal' }), subject: t.str({ required: true, min: 5, max: 140 }), text: t.text({ required: true, max: 4000, label: 'Description' }) });
  const n = await nextNumber('support');
  const tk = { id: id('tk'), number: 'MC-' + String(n).padStart(5, '0'), orgId: req.ctx.org.id, orgName: req.ctx.org.name, raisedBy: req.ctx.user.id, raisedByName: req.ctx.user.name, category: b.category, priority: b.priority || 'normal', subject: b.subject, status: 'open',
    assigneeId: null, messages: [msg(req, 'provider', b.text)], createdAt: now(), updatedAt: now(), slaDueAt: now() + SLA_HOURS[b.priority || 'normal'] * 3600e3, firstResponseAt: null, resolvedAt: null };
  await db.col('support_tickets').insertOne(tk);
  await audit(req, 'support.create', { type: 'ticket', id: tk.id }, { category: tk.category, priority: tk.priority });
  res.json(providerView(tk));
}));
router.post('/admin/support/:id/reply', providerGuard, ah(async (req, res) => {
  const b = body(req, { text: t.text({ required: true, max: 4000 }) });
  const tk = await db.col('support_tickets').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id, status: { $ne: 'closed' } }, { $push: { messages: msg(req, 'provider', b.text) }, $set: { updatedAt: now(), status: 'in_progress' } });
  if (!tk) throw conflict('This ticket is closed. Open a new one.');
  await audit(req, 'support.reply', { type: 'ticket', id: tk.id });
  res.json(providerView(tk));
}));
router.post('/admin/support/:id/close', providerGuard, ah(async (req, res) => {
  const b = body(req, { rating: t.int({ min: 1, max: 5 }), comment: t.str({ max: 500 }) });
  const tk = await db.col('support_tickets').findOneAndUpdate({ id: param(req, 'id'), orgId: req.ctx.org.id, status: { $in: ['resolved', 'open', 'in_progress', 'waiting_provider'] } }, { $set: { status: 'closed', closedAt: now(), rating: b.rating || null, ratingComment: b.comment || null, updatedAt: now() } });
  if (!tk) throw conflict('Ticket is already closed');
  await audit(req, 'support.close', { type: 'ticket', id: tk.id }, { rating: b.rating || null });
  res.json(providerView(tk));
}));

/* -------- HQ side -------- */
const hq = A.requirePlatform('platform.support');
router.get('/hq/support', hq, ah(async (req, res) => {
  const q = query(req, { status: t.enum(STATUSES), priority: t.enum(PRIORITIES), orgId: t.id(), mine: t.bool() });
  const f = {}; if (q.status) f.status = q.status; else f.status = { $ne: 'closed' }; if (q.priority) f.priority = q.priority; if (q.orgId) f.orgId = q.orgId; if (q.mine) f.assigneeId = req.ctx.user.id;
  const rows = await db.col('support_tickets').find(f, { sort: { createdAt: -1 }, limit: 500, projection: { messages: 0 } });
  const P = { urgent: 0, high: 1, normal: 2, low: 3 };
  rows.sort((a, b) => (P[a.priority] - P[b.priority]) || (a.slaDueAt - b.slaDueAt));
  res.json(rows.map(r => Object.assign(r, { overdue: !r.firstResponseAt && r.slaDueAt < now() && !['resolved', 'closed'].includes(r.status) })));
}));
router.get('/hq/support/:id', hq, ah(async (req, res) => {
  const tk = await db.col('support_tickets').findOne({ id: param(req, 'id') }); if (!tk) throw notFound('Ticket not found'); res.json(tk);
}));
router.post('/hq/support/:id/reply', hq, ah(async (req, res) => {
  const b = body(req, { text: t.text({ required: true, max: 4000 }), internal: t.bool(), status: t.enum(['in_progress', 'waiting_provider', 'resolved']) });
  const cur = await db.col('support_tickets').findOne({ id: param(req, 'id') }); if (!cur) throw notFound('Ticket not found');
  if (cur.status === 'closed') throw conflict('Ticket is closed');
  const set = { updatedAt: now() }; if (!b.internal) { if (!cur.firstResponseAt) set.firstResponseAt = now(); set.status = b.status || 'waiting_provider'; if (set.status === 'resolved') set.resolvedAt = now(); }
  if (!cur.assigneeId) set.assigneeId = req.ctx.user.id;
  const tk = await db.col('support_tickets').findOneAndUpdate({ id: cur.id, status: { $ne: 'closed' } }, { $push: { messages: msg(req, 'medicore', b.text, b.internal) }, $set: set });
  if (!b.internal) await notify({ userId: cur.raisedBy, title: 'MediCore support replied', body: cur.number + ': ' + cur.subject, kind: 'support', ref: { type: 'ticket', id: cur.id } });
  await audit(req, 'support.hq_reply', { type: 'ticket', id: cur.id, orgId: cur.orgId }, { internal: !!b.internal, status: set.status || null });
  res.json(tk);
}));
router.patch('/hq/support/:id', hq, ah(async (req, res) => {
  const b = body(req, { assigneeId: t.id(), priority: t.enum(PRIORITIES), status: t.enum(STATUSES), category: t.enum(CATEGORIES) });
  if (!Object.keys(b).length) throw bad('Nothing to change');
  if (b.assigneeId) { const u = await db.col('users').findOne({ id: b.assigneeId, platformRole: { $exists: true } }); if (!u) throw bad('Assign to a MediCore team member'); }
  const set = Object.assign({ updatedAt: now() }, b); if (b.status === 'resolved') set.resolvedAt = now(); if (b.priority) { const cur = await db.col('support_tickets').findOne({ id: param(req, 'id') }); if (cur) set.slaDueAt = cur.createdAt + SLA_HOURS[b.priority] * 3600e3; }
  const tk = await db.col('support_tickets').findOneAndUpdate({ id: param(req, 'id') }, { $set: set }); if (!tk) throw notFound('Ticket not found');
  await audit(req, 'support.hq_update', { type: 'ticket', id: tk.id, orgId: tk.orgId }, b);
  res.json(tk);
}));

/** used by other modules (e.g. a module change request when self-serve is off) */
async function createTicket({ org, user, category, priority, subject, text }) {
  const n = await nextNumber('support');
  const tk = { id: id('tk'), number: 'MC-' + String(n).padStart(5, '0'), orgId: org.id, orgName: org.name, raisedBy: user.id, raisedByName: user.name, category, priority: priority || 'normal', subject, status: 'open', assigneeId: null,
    messages: [{ id: id('tm'), at: now(), by: user.id, byName: user.name, side: 'provider', text, internal: false }], createdAt: now(), updatedAt: now(), slaDueAt: now() + SLA_HOURS[priority || 'normal'] * 3600e3, firstResponseAt: null, resolvedAt: null };
  await db.col('support_tickets').insertOne(tk);
  return tk;
}
module.exports = { name: 'support', router, CATEGORIES, PRIORITIES, createTicket };
