'use strict';
/*
 * Notifications: in-app (stored) plus SMS through the gateway chosen in HQ (lib/sms.js).
 * In dev mode SMS is not sent; the log shows a masked number and no message body,
 * so no personal or clinical text lands in server logs.
 */
const https = require('https');
const db = require('../db');
const config = require('../config');
const { id, maskPhone } = require('./util');

db.index('notifications', ['userId', 'at']);
db.index('notifications', ['patientId', 'at']);
db.index('notifications', ['orgId', 'role', 'at']);

function postJSON(host, path, body, headers = {}) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = https.request({ host, path, method: 'POST', timeout: 8000, headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers) }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { resolve({ status: res.statusCode, body: b }); } });
    });
    req.on('error', e => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.write(data); req.end();
  });
}

/* SMS goes through the gateway chosen in HQ (lib/sms.js: Termii, Africa's Talking or a custom HTTP API) */
async function sms(to, text) { return require('./sms').send(to, text); }

/**
 * notify({ patientId | userId | (orgId + role), title, body, kind, ref, sms: phone })
 * role-addressed notifications show to everyone with that role at the org.
 */
async function notify(n) {
  // patients get notifications and SMS in their own language when a translation exists
  if (n.patientId && !n.lang) { try { const p = await db.col('patients').findOne({ id: n.patientId }, { projection: { lang: 1 } }); n.lang = p && p.lang; } catch (e) { n.lang = null; } }
  if (n.lang && n.lang !== 'en') { const { tr } = require('./i18n'); n.title = tr(n.lang, n.title); n.body = tr(n.lang, n.body); }
  const doc = { id: id('nt'), at: Date.now(), read: false, kind: n.kind || 'info', title: String(n.title || '').slice(0, 120), body: String(n.body || '').slice(0, 500),
    userId: n.userId || null, patientId: n.patientId || null, orgId: n.orgId || null, role: n.role || null, ref: n.ref || null };
  await db.col('notifications').insertOne(doc);
  // patients who agreed to WhatsApp get it there (approved template); then the SMS copy is not needed
  let waSent = false;
  if (n.patientId && n.whatsapp !== false) { try { waSent = (await require('../modules/whatsapp').notifyPatient(n.patientId, doc.title, doc.body)).sent; } catch (e) { waSent = false; } }
  if (waSent) await db.col('notifications').updateOne({ id: doc.id }, { $set: { channel: 'whatsapp' } });
  if (n.sms && !waSent) await sms(n.sms, (doc.title + (doc.body ? ': ' + doc.body : '')).slice(0, 300));
  return doc;
}

module.exports = { notify, sms, postJSON };
