'use strict';
/*
 * Audit trail. Every write and every staff view of a patient record calls audit().
 * Entries are append-only (no route updates or deletes them), carry the acting user id,
 * their provider, role, IP and the target, and are never capped.
 * Personal data does not go into `meta`; reference records by id.
 */
const db = require('../db');
const { id } = require('./util');

db.index('audit', ['orgId', 'at']);
db.index('audit', ['patientId', 'at']);
db.index('audit', ['actorId', 'at']);
db.index('audit', ['groupId', 'at']);

async function audit(req, action, target = {}, meta) {
  const c = (req && req.ctx) || {};
  const entry = {
    id: id('au'), at: Date.now(), action,
    actorId: c.user ? c.user.id : null, actorKind: c.user ? c.user.kind : 'public',
    actorName: c.user ? c.user.name : null, role: c.role || null,
    orgId: target.orgId !== undefined ? target.orgId : (c.org ? c.org.id : null),
    patientId: target.patientId || null, targetType: target.type || null, targetId: target.id || null,
    ip: req ? String(req.headers['x-nf-client-connection-ip'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim() : null,
    app: c.app || null, groupId: target.groupId !== undefined ? target.groupId : (c.group ? c.group.id : null),
  };
  if (meta) { const s = JSON.stringify(meta); entry.meta = s.length > 1500 ? { truncated: true } : meta; }
  try { await db.col('audit').insertOne(entry); } catch (e) { console.error('[audit] failed', action, e.message); }
  return entry;
}

module.exports = { audit };
