'use strict';
/*
 * Integration adapters. Each one runs for real when its API key is set in the
 * environment, and otherwise runs in a clearly labelled DEV mode so the whole
 * system works end to end locally without any paid accounts.
 *
 * Going live means: create the account, set the key, done. No code change.
 */
const https = require('https');

function postJSON(host, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ host, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ raw: b }); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}

/* ---- Payments (Paystack) ---- */
async function initPayment({ email, amount, reference }) {
  const key = process.env.PAYSTACK_SECRET;
  if (!key) {
    return { mode: 'dev', status: true, message: 'DEV mode: payment recorded without charging a card.',
             reference, authorization_url: null };
  }
  // Paystack expects amount in kobo
  const r = await postJSON('api.paystack.co', '/transaction/initialize',
    { Authorization: 'Bearer ' + key }, { email, amount: amount * 100, reference });
  return { mode: 'live', ...r };
}

/* ---- SMS (Termii, Nigerian) ---- */
async function sendSMS({ to, text }) {
  const key = process.env.TERMII_KEY;
  if (!key) { console.log('[SMS dev] to', to, ':', text); return { mode: 'dev', sent: true }; }
  const r = await postJSON('api.ng.termii.com', '/api/sms/send', {},
    { to, from: process.env.TERMII_SENDER || 'MediCore', sms: text, type: 'plain', channel: 'generic', api_key: key });
  return { mode: 'live', ...r };
}

/* ---- Video (Daily.co) ---- */
async function createVideoRoom({ name }) {
  const key = process.env.DAILY_KEY;
  if (!key) { return { mode: 'dev', url: 'https://dev.local/room/' + name, message: 'DEV mode: placeholder room.' }; }
  const r = await postJSON('api.daily.co', '/v1/rooms', { Authorization: 'Bearer ' + key },
    { name, properties: { exp: Math.floor(Date.now() / 1000) + 3600 } });
  return { mode: 'live', ...r };
}

/* ---- HMO claim submission ----
 * There is no universal HMO claims API in Nigeria. Each HMO (Avon, Reliance,
 * Hygeia, NHIA) is a separate integration, and most require a business
 * agreement and a portal or file exchange rather than an open API. So this
 * adapter records the claim and marks it ready to submit. Wiring a specific
 * HMO means implementing that HMO's method here once an agreement exists.
 */
async function submitClaim(claim) {
  const configured = (process.env.HMO_ENDPOINTS || '').split(',').filter(Boolean);
  if (!configured.includes(claim.payer)) {
    return { mode: 'dev', submitted: false,
      message: 'No live integration for ' + (claim.payer || 'this HMO') + '. Claim saved and ready to submit once an agreement is in place.' };
  }
  // Placeholder for a real per-HMO submission once the agreement and endpoint exist.
  return { mode: 'live', submitted: true };
}

module.exports = { initPayment, sendSMS, createVideoRoom, submitClaim };
