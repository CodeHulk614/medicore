'use strict';
/*
 * Payment gateways, switchable in HQ > Configuration > Integrations > Payments, no code change:
 *   paystack     Paystack (cards, transfer, USSD). Settles to the provider's subaccount when set.
 *   flutterwave  Flutterwave Standard checkout. Settles to the provider's subaccount when set.
 *   monnify      Monnify checkout (cards, account transfer, USSD). Splits to the provider's subaccount when set.
 *   custom       a bank's (or any gateway's) collection API, described in HQ: endpoints, auth, a JSON body template
 *                and where to find the checkout link, status and amount in the replies. See DEFAULTS.integrations.customPayment.
 *   none         online payments off (counter payments only)
 *
 * Every gateway is used the same way by billing.js:
 *   init({ reference, amountKobo, email, phone, name, callbackUrl, org })  -> { ok, authorizationUrl, providerRef }
 *   verify(reference)                                                       -> { status: 'success'|'pending'|'failed', amountKobo }
 *   webhook(provider, req)                                                  -> { ok (signature valid), events: [{ reference, status, amountKobo }] }
 * Money is confirmed only by verify or a signed webhook, and always re-checked against the amount we asked for.
 */
const https = require('https');
const crypto = require('crypto');
const config = require('../config');

/* ---------- HTTP (replaceable in tests) ---------- */
function realRequest(url, { method = 'GET', headers = {}, json, form, timeout = 12000 } = {}) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ status: 0, error: 'bad_url' }); }
    if (u.protocol !== 'https:') return resolve({ status: 0, error: 'https_only' });
    let data = null; const h = Object.assign({}, headers);
    if (json !== undefined) { data = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
    else if (form !== undefined) { data = new URLSearchParams(form).toString(); h['Content-Type'] = 'application/x-www-form-urlencoded'; }
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    h.Accept = h.Accept || 'application/json';
    const r = https.request({ host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers: h, timeout }, res => {
      let b = ''; res.on('data', c => { b += c; if (b.length > 1e6) r.destroy(); }); res.on('end', () => { let body = b; try { body = JSON.parse(b); } catch (e) { /* text */ } resolve({ status: res.statusCode, body }); });
    });
    r.on('error', e => resolve({ status: 0, error: e.message })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
let transport = realRequest;
function _setTransport(fn) { transport = fn || realRequest; }
const request = (url, opts) => transport(url, opts || {});

/* ---------- helpers ---------- */
const getPath = (o, p) => (p ? String(p).split('.').reduce((a, k) => (a == null ? undefined : a[/^\d+$/.test(k) ? Number(k) : k]), o) : undefined);
function fill(tpl, vars, json) {
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, (m, k) => { const v = vars[k] == null ? '' : vars[k]; return json && typeof v === 'string' ? JSON.stringify(v).slice(1, -1) : String(v); });
}
function settlementOf(org) { const s = (org && org.settlement) || {}; return { account: s.accountNumber || '', bankCode: s.bankCode || '', subaccount: s.subaccount || (org && org.paystackSubaccount) || '' }; }
const settle = () => config.PAYMENTS ? config.PAYMENTS.settleToProviders !== false : true;
function safeEqual(a, b) { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); }

/* ---------- Paystack ---------- */
const paystack = {
  configured: () => !!config.PAYSTACK_SECRET,
  async init(p) {
    const payload = { email: p.email, amount: p.amountKobo, reference: p.reference, currency: 'NGN', callback_url: p.callbackUrl, metadata: { billId: p.billId, orgId: p.org && p.org.id } };
    const sa = settlementOf(p.org).subaccount; if (sa && settle()) payload.subaccount = sa;
    const r = await request('https://api.paystack.co/transaction/initialize', { method: 'POST', headers: { Authorization: 'Bearer ' + config.PAYSTACK_SECRET }, json: payload });
    if (r.status !== 200 || !r.body || !r.body.status) return { ok: false };
    return { ok: true, authorizationUrl: r.body.data.authorization_url, providerRef: r.body.data.access_code };
  },
  async verify(ref) {
    const r = await request('https://api.paystack.co/transaction/verify/' + encodeURIComponent(ref), { headers: { Authorization: 'Bearer ' + config.PAYSTACK_SECRET } });
    const d = r.body && r.body.data;
    if (r.status !== 200 || !d) return { status: 'pending' };
    return { status: d.status === 'success' ? 'success' : (['failed', 'abandoned', 'reversed'].includes(d.status) ? 'failed' : 'pending'), amountKobo: Number(d.amount) };
  },
  async webhook(req) {
    const sig = req.headers['x-paystack-signature'];
    const expected = crypto.createHmac('sha512', config.PAYSTACK_SECRET).update(req.rawBody || '').digest('hex');
    if (!safeEqual(sig, expected)) return { ok: false };
    const ev = req.body || {};
    return { ok: true, events: ev.event === 'charge.success' && ev.data && ev.data.reference ? [{ reference: String(ev.data.reference), status: 'success', amountKobo: Number(ev.data.amount) }] : [] };
  },
};

/* ---------- Flutterwave (v3) ---------- */
const FLW = 'https://api.flutterwave.com/v3';
const flw = () => config.PAYMENTS.flutterwave;
const flutterwave = {
  configured: () => !!(config.PAYMENTS && flw().secretKey),
  async init(p) {
    const payload = { tx_ref: p.reference, amount: (p.amountKobo / 100).toFixed(2), currency: 'NGN', redirect_url: p.callbackUrl, customer: { email: p.email, phonenumber: p.phone || undefined, name: p.name || undefined }, meta: { billId: p.billId, orgId: p.org && p.org.id }, customizations: { title: p.org ? p.org.name : 'Payment' } };
    const sa = settlementOf(p.org).subaccount; if (sa && settle()) payload.subaccounts = [{ id: sa }];
    const r = await request(FLW + '/payments', { method: 'POST', headers: { Authorization: 'Bearer ' + flw().secretKey }, json: payload });
    if (r.status !== 200 || !r.body || r.body.status !== 'success' || !r.body.data) return { ok: false };
    return { ok: true, authorizationUrl: r.body.data.link, providerRef: null };
  },
  async verify(ref) {
    const r = await request(FLW + '/transactions/verify_by_reference?tx_ref=' + encodeURIComponent(ref), { headers: { Authorization: 'Bearer ' + flw().secretKey } });
    const d = r.body && r.body.data;
    if (r.status !== 200 || !d) return { status: 'pending' };
    if (d.currency && d.currency !== 'NGN') return { status: 'failed' };
    return { status: d.status === 'successful' ? 'success' : (d.status === 'failed' ? 'failed' : 'pending'), amountKobo: Math.round(Number(d.amount) * 100) };
  },
  async webhook(req) {
    if (!flw().webhookHash || !safeEqual(req.headers['verif-hash'], flw().webhookHash)) return { ok: false };
    const d = (req.body || {}).data || {};
    if (!d.tx_ref) return { ok: true, events: [] };
    // the webhook only tells us to look: the amount and status come from Flutterwave's verify API
    const v = await flutterwave.verify(String(d.tx_ref));
    return { ok: true, events: [{ reference: String(d.tx_ref), status: v.status, amountKobo: v.amountKobo }] };
  },
};

/* ---------- Monnify ---------- */
const mon = () => config.PAYMENTS.monnify;
let monToken = null; let monTokenExp = 0;
async function monnifyToken() {
  if (monToken && Date.now() < monTokenExp) return monToken;
  const basic = Buffer.from(mon().apiKey + ':' + mon().secretKey).toString('base64');
  const r = await request(mon().baseUrl.replace(/\/$/, '') + '/api/v1/auth/login', { method: 'POST', headers: { Authorization: 'Basic ' + basic }, json: {} });
  const t = r.body && r.body.responseBody;
  if (r.status !== 200 || !t || !t.accessToken) return null;
  monToken = t.accessToken; monTokenExp = Date.now() + Math.max(60, (Number(t.expiresIn) || 3000) - 120) * 1000;
  return monToken;
}
const monnify = {
  configured: () => !!(config.PAYMENTS && mon().apiKey && mon().secretKey && mon().contractCode),
  async init(p) {
    const tok = await monnifyToken(); if (!tok) return { ok: false };
    const payload = { amount: Number((p.amountKobo / 100).toFixed(2)), customerName: p.name || 'Patient', customerEmail: p.email, paymentReference: p.reference, paymentDescription: (p.org ? p.org.name + ' ' : '') + 'bill', currencyCode: 'NGN', contractCode: mon().contractCode, redirectUrl: p.callbackUrl, paymentMethods: ['CARD', 'ACCOUNT_TRANSFER', 'USSD'] };
    const sa = settlementOf(p.org).subaccount; if (sa && settle()) payload.incomeSplitConfig = [{ subAccountCode: sa, splitPercentage: 100, feeBearer: true }];
    const r = await request(mon().baseUrl.replace(/\/$/, '') + '/api/v1/merchant/transactions/init-transaction', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, json: payload });
    const b = r.body && r.body.responseBody;
    if (r.status !== 200 || !b || !b.checkoutUrl) return { ok: false };
    return { ok: true, authorizationUrl: b.checkoutUrl, providerRef: b.transactionReference || null };
  },
  async verify(ref) {
    const tok = await monnifyToken(); if (!tok) return { status: 'pending' };
    const r = await request(mon().baseUrl.replace(/\/$/, '') + '/api/v2/merchant/transactions/query?paymentReference=' + encodeURIComponent(ref), { headers: { Authorization: 'Bearer ' + tok } });
    const b = r.body && r.body.responseBody;
    if (r.status !== 200 || !b) return { status: 'pending' };
    return { status: b.paymentStatus === 'PAID' ? 'success' : (['FAILED', 'EXPIRED', 'CANCELLED', 'REVERSED'].includes(b.paymentStatus) ? 'failed' : 'pending'), amountKobo: Math.round(Number(b.amountPaid) * 100) };
  },
  async webhook(req) {
    const expected = crypto.createHmac('sha512', mon().secretKey).update(req.rawBody || '').digest('hex');
    if (!safeEqual(req.headers['monnify-signature'], expected)) return { ok: false };
    const ev = req.body || {}; const d = ev.eventData || {};
    if (ev.eventType !== 'SUCCESSFUL_TRANSACTION' || !d.paymentReference) return { ok: true, events: [] };
    return { ok: true, events: [{ reference: String(d.paymentReference), status: d.paymentStatus === 'PAID' ? 'success' : 'pending', amountKobo: Math.round(Number(d.amountPaid) * 100) }] };
  },
};

/* ---------- custom (a bank or any HTTP API, described in HQ) ---------- */
const cp = () => config.PAYMENTS.custom;
let customToken = null; let customTokenExp = 0;
async function customHeaders() {
  const a = cp().auth || {}; const h = {};
  if (a.type === 'bearer' && a.token) h[a.headerName || 'Authorization'] = (a.headerName && a.headerName !== 'Authorization' ? '' : 'Bearer ') + a.token;
  if (a.type === 'header' && a.token) h[a.headerName || 'X-API-Key'] = a.token;
  if (a.type === 'basic') h.Authorization = 'Basic ' + Buffer.from((a.username || '') + ':' + (a.password || '')).toString('base64');
  if (a.type === 'oauth2') {
    if (!customToken || Date.now() > customTokenExp) {
      const r = await request(a.tokenUrl, { method: 'POST', form: { grant_type: 'client_credentials', client_id: a.clientId || '', client_secret: a.clientSecret || '', scope: a.scope || '' } });
      if (r.status !== 200 || !r.body || !r.body.access_token) return null;
      customToken = r.body.access_token; customTokenExp = Date.now() + Math.max(60, (Number(r.body.expires_in) || 3600) - 120) * 1000;
    }
    h.Authorization = 'Bearer ' + customToken;
  }
  return h;
}
const amountFrom = (v, unit) => { const n = Number(v); if (!Number.isFinite(n)) return null; return unit === 'naira' ? Math.round(n * 100) : Math.round(n); };
const isSuccess = (v, list) => String(list || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean).includes(String(v == null ? '' : v).toLowerCase());
const custom = {
  configured: () => !!(config.PAYMENTS && cp().baseUrl && cp().init && cp().init.path && cp().init.checkoutUrlPath),
  async init(p) {
    const c = cp(); const st = settlementOf(p.org);
    const vars = { reference: p.reference, amountKobo: p.amountKobo, amountNaira: (p.amountKobo / 100).toFixed(2), email: p.email, phone: p.phone || '', name: p.name || '', callbackUrl: p.callbackUrl, orgName: p.org ? p.org.name : '', settlementAccount: settle() ? st.account : '', settlementBankCode: settle() ? st.bankCode : '', settlementSubaccount: settle() ? st.subaccount : '' };
    const h = await customHeaders(); if (!h) return { ok: false };
    let json; if (c.init.bodyTemplate) { try { json = JSON.parse(fill(c.init.bodyTemplate, vars, true)); } catch (e) { return { ok: false, error: 'bad_template' }; } }
    const url = c.baseUrl.replace(/\/$/, '') + fill(c.init.path, vars, false);
    const r = await request(url, { method: c.init.method || 'POST', headers: h, json: c.init.method === 'GET' ? undefined : (json || {}) });
    const link = getPath(r.body, c.init.checkoutUrlPath);
    if (r.status < 200 || r.status >= 300 || !link || !/^https:\/\//.test(String(link))) return { ok: false };
    return { ok: true, authorizationUrl: String(link), providerRef: c.init.providerRefPath ? String(getPath(r.body, c.init.providerRefPath) || '') || null : null };
  },
  async verify(ref) {
    const c = cp(); if (!c.verify || !c.verify.path) return { status: 'pending' };
    const h = await customHeaders(); if (!h) return { status: 'pending' };
    const r = await request(c.baseUrl.replace(/\/$/, '') + fill(c.verify.path, { reference: encodeURIComponent(ref) }, false), { method: c.verify.method || 'GET', headers: h, json: c.verify.method === 'POST' ? { reference: ref } : undefined });
    if (r.status < 200 || r.status >= 300) return { status: 'pending' };
    const st = getPath(r.body, c.verify.statusPath);
    return { status: isSuccess(st, c.verify.successValues) ? 'success' : 'pending', amountKobo: amountFrom(getPath(r.body, c.verify.amountPath), c.verify.amountUnit) };
  },
  async webhook(req) {
    const w = cp().webhook || {};
    if (w.algorithm !== 'none') {
      if (!w.secret || !w.signatureHeader) return { ok: false };
      const expected = crypto.createHmac(w.algorithm === 'sha256' ? 'sha256' : 'sha512', w.secret).update(req.rawBody || '').digest('hex');
      if (!safeEqual(String(req.headers[String(w.signatureHeader).toLowerCase()] || '').toLowerCase(), expected)) return { ok: false };
    }
    const ref = getPath(req.body, w.referencePath);
    if (!ref) return { ok: true, events: [] };
    // unsigned webhooks are only a hint: confirm with the verify call
    if (w.algorithm === 'none') { const v = await custom.verify(String(ref)); return { ok: true, events: [{ reference: String(ref), status: v.status, amountKobo: v.amountKobo }] }; }
    const st = getPath(req.body, w.statusPath);
    return { ok: true, events: [{ reference: String(ref), status: isSuccess(st, (cp().verify || {}).successValues) ? 'success' : 'pending', amountKobo: amountFrom(getPath(req.body, w.amountPath), (cp().verify || {}).amountUnit) }] };
  },
};

const GATEWAYS = { paystack, flutterwave, monnify, custom };
const LABELS = { paystack: 'Paystack', flutterwave: 'Flutterwave', monnify: 'Monnify', custom: 'Bank / custom gateway', none: 'Off' };
function activeName() { const p = (config.PAYMENTS && config.PAYMENTS.provider) || 'paystack'; return GATEWAYS[p] || p === 'none' ? p : 'paystack'; }
function active() { const n = activeName(); const g = GATEWAYS[n]; return { name: n, label: (n === 'custom' && config.PAYMENTS && config.PAYMENTS.label) || (config.PAYMENTS && config.PAYMENTS.label && n !== 'none' ? config.PAYMENTS.label : LABELS[n]), configured: !!(g && g.configured()), gateway: g || null }; }
const gateway = name => GATEWAYS[name] || null;

module.exports = { active, gateway, GATEWAYS, LABELS, request, _setTransport, fill, getPath };
