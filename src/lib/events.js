'use strict';
/*
 * Outgoing connectors (HQ > Configuration > Connectors): send platform events to any outside system
 * (a bank, an ERP, an HMO's claims system, a data warehouse) without code.
 *
 *   connector { id, label, url (https), events: ['referral.sent', ...] or ['*'], secret (encrypted), active, orgIds?: [] }
 *   POST <url>  { event, at, data }   header X-MediCore-Event, X-MediCore-Signature: sha256=<HMAC of the body with the secret>
 *
 * Payloads carry ids and amounts, never names, phone numbers or clinical text. Each delivery is logged;
 * a failed delivery can be retried from HQ.
 */
const crypto = require('crypto');
const db = require('../db');
const { id, now } = require('./util');

const EVENTS = {
  'patient.registered': 'A provider registered a patient', 'patient.application': 'A patient applied to join a provider', 'patient.application_approved': 'A provider approved a patient application',
  'referral.sent': 'A referral was sent', 'referral.accepted': 'A referral was accepted', 'referral.declined': 'A referral was declined', 'referral.completed': 'A referral outcome was reported',
  'payment.success': 'An online payment was confirmed', 'bill.paid': 'A bill was fully paid',
  'org.signup': 'A provider signed up', 'org.approved': 'A provider was approved', 'group.branch_created': 'A group added a branch',
  'claim.submitted': 'An HMO claim was submitted',
};
db.index('connector_deliveries', ['connectorId', 'at']);

async function deliver(c, event, payload) {
  const S = require('./settings');
  const P = require('./payments');
  const bodyStr = JSON.stringify(payload);
  const secret = S.decrypt(c.secret) || '';
  const sig = secret ? 'sha256=' + crypto.createHmac('sha256', secret).update(bodyStr).digest('hex') : 'unsigned';
  const r = await P.request(c.url, { method: 'POST', headers: { 'X-MediCore-Event': event, 'X-MediCore-Signature': sig, 'X-MediCore-Delivery': payload.deliveryId }, json: payload, timeout: 4000 });
  const ok = r.status >= 200 && r.status < 300;
  await db.col('connector_deliveries').insertOne({ id: payload.deliveryId, connectorId: c.id, event, at: now(), ok, status: r.status || 0, error: r.error || null, payload });
  await db.col('connectors').updateOne({ id: c.id }, { $set: { lastAt: now(), lastOk: ok, lastStatus: r.status || 0 } });
  return ok;
}
/** emit(event, data): data must hold ids and numbers only */
async function emit(event, data) {
  let list = [];
  try { list = await db.col('connectors').find({ active: true }); } catch (e) { return; }
  const hits = list.filter(c => (c.events || []).includes('*') || (c.events || []).includes(event)).filter(c => !c.orgIds || !c.orgIds.length || (data && (c.orgIds.includes(data.orgId) || c.orgIds.includes(data.toOrgId) || c.orgIds.includes(data.fromOrgId))));
  for (const c of hits) {
    const payload = { deliveryId: id('dlv'), event, at: new Date().toISOString(), data: data || {} };
    try { await deliver(c, event, payload); } catch (e) { /* logged by deliver when possible */ }
  }
}

module.exports = { emit, deliver, EVENTS };
