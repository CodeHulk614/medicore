'use strict';
/* Plug-and-play gateways (payments, SMS), outgoing connectors and the compliance register. No real network:
 * lib/payments' transport is replaced with a fake gateway. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { boot } = require('./helpers');
const PAY = require('../src/lib/payments');

let h, hq, calls = [], fake = null;
before(async () => {
  h = await boot();
  hq = await h.as('hq', 'hq@medicore.demo');
  PAY._setTransport(async (url, opts) => { calls.push({ url, opts }); return fake ? fake(url, opts) : { status: 0, error: 'offline' }; });
});
after(async () => { PAY._setTransport(null); await h.close(); });

async function openBill() {
  const fd = await h.as('frontdesk', 'cashier@grandville.demo');
  const r = await fd.post('/api/bills', { patientId: h.ctx.patients.amaka.id, items: [{ serviceCode: 'CONS-GP', qty: 1 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

test('a custom bank gateway configured in HQ takes a payment end to end (OAuth, template, verify, signed webhook)', async () => {
  const patch = { payments: { provider: 'custom', label: 'Sterling Pay' }, customPayment: {
    baseUrl: 'https://bank.example.com/api', auth: { type: 'oauth2', tokenUrl: 'https://bank.example.com/oauth/token', clientId: 'mc', clientSecret: 'shh' },
    init: { method: 'POST', path: '/collections', bodyTemplate: '{"ref":"{{reference}}","amount":{{amountNaira}},"payer":{"email":"{{email}}"},"settle":"{{settlementAccount}}","back":"{{callbackUrl}}"}', checkoutUrlPath: 'data.link' },
    verify: { method: 'GET', path: '/collections/{{reference}}', statusPath: 'data.state', successValues: 'PAID,SUCCESS', amountPath: 'data.amount', amountUnit: 'naira' },
    webhook: { signatureHeader: 'X-Bank-Sig', algorithm: 'sha256', secret: 'hooksecret', referencePath: 'ref', statusPath: 'state', amountPath: 'amount' } } };
  const s = await hq.patch('/api/hq/config/integrations', { patch });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const cfg = await hq.get('/api/hq/config');
  assert.deepEqual(cfg.body.settings.integrations.customPayment.auth.clientSecret, { set: true, last4: 'shh' }, 'secret masked');
  const ownAdmin = await h.as('admin', 'owner@grandville.demo');
  assert.equal((await ownAdmin.patch('/api/admin/org/settlement', { bankName: 'Sterling Bank', accountNumber: '0011223344', accountName: 'Grandville Hospital' })).status, 200);
  const bill = await openBill();
  const pt = await h.as('patient', 'amaka@patient.demo');
  let sent;
  fake = (url, o) => {
    if (url.endsWith('/oauth/token')) return { status: 200, body: { access_token: 'tok1', expires_in: 3600 } };
    if (url.endsWith('/collections') && o.method === 'POST') { sent = o; return { status: 201, body: { data: { link: 'https://bank.example.com/pay/xyz' } } }; }
    return { status: 404, body: {} };
  };
  const r = await pt.post('/api/me/bills/' + bill.id + '/pay');
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.mode, 'custom'); assert.equal(r.body.authorizationUrl, 'https://bank.example.com/pay/xyz'); assert.equal(r.body.gatewayLabel, 'Sterling Pay');
  assert.equal(sent.headers.Authorization, 'Bearer tok1');
  assert.equal(sent.json.amount, bill.patientDueKobo / 100); assert.equal(sent.json.settle, '0011223344'); assert.equal(sent.json.ref, r.body.reference);
  // a webhook with a bad signature is refused; a good one pays exactly once
  const body = JSON.stringify({ ref: r.body.reference, state: 'PAID', amount: bill.patientDueKobo / 100 });
  const bad = await fetch(h.base + '/api/pay/custom/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bank-Sig': 'nope' }, body });
  assert.equal(bad.status, 401);
  const sig = crypto.createHmac('sha256', 'hooksecret').update(body).digest('hex');
  for (let i = 0; i < 2; i++) { const ok = await fetch(h.base + '/api/pay/custom/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bank-Sig': sig }, body }); assert.equal(ok.status, 200); }
  const paid = await h.db.col('bills').findOne({ id: bill.id });
  assert.equal(paid.status, 'paid'); assert.equal(paid.paidKobo, bill.patientDueKobo);
  assert.equal(await h.db.col('payments').count({ billId: bill.id, status: 'success' }), 1);
});

test('a wrong amount from the gateway never marks the bill paid', async () => {
  const bill = await openBill();
  const pt = await h.as('patient', 'amaka@patient.demo');
  fake = (url, o) => (url.endsWith('/collections') ? { status: 200, body: { data: { link: 'https://bank.example.com/pay/2' } } } : url.includes('/collections/') ? { status: 200, body: { data: { state: 'PAID', amount: 1 } } } : { status: 200, body: { access_token: 't', expires_in: 3600 } });
  const r = await pt.post('/api/me/bills/' + bill.id + '/pay');
  const v = await pt.get('/api/pay/verify/' + r.body.reference);
  assert.equal(v.status, 200); assert.notEqual(v.body.status, 'success');
  assert.equal((await h.db.col('bills').findOne({ id: bill.id })).status, 'open');
});

test('Flutterwave and Monnify adapters: init, verify and webhook signatures', async () => {
  await hq.patch('/api/hq/config/integrations', { patch: { payments: { provider: 'flutterwave' }, flutterwave: { secretKey: 'FLWSECK-x', webhookHash: 'flwhash' } } });
  let bill = await openBill();
  const pt = await h.as('patient', 'amaka@patient.demo');
  fake = (url) => (url.endsWith('/v3/payments') ? { status: 200, body: { status: 'success', data: { link: 'https://checkout.flutterwave.com/x' } } } : url.includes('verify_by_reference') ? { status: 200, body: { data: { status: 'successful', amount: bill.patientDueKobo / 100, currency: 'NGN' } } } : { status: 404 });
  let r = await pt.post('/api/me/bills/' + bill.id + '/pay');
  assert.equal(r.body.mode, 'flutterwave');
  const nohash = await fetch(h.base + '/api/pay/flutterwave/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: { tx_ref: r.body.reference } }) });
  assert.equal(nohash.status, 401);
  const ok = await fetch(h.base + '/api/pay/flutterwave/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'verif-hash': 'flwhash' }, body: JSON.stringify({ event: 'charge.completed', data: { tx_ref: r.body.reference, status: 'successful' } }) });
  assert.equal(ok.status, 200);
  assert.equal((await h.db.col('bills').findOne({ id: bill.id })).status, 'paid');

  await hq.patch('/api/hq/config/integrations', { patch: { payments: { provider: 'monnify' }, monnify: { apiKey: 'MK_TEST', secretKey: 'monsecret', contractCode: '123' } } });
  bill = await openBill();
  fake = (url) => (url.endsWith('/auth/login') ? { status: 200, body: { responseBody: { accessToken: 'mt', expiresIn: 3600 } } } : url.endsWith('/init-transaction') ? { status: 200, body: { responseBody: { checkoutUrl: 'https://sandbox.sdk.monnify.com/c', transactionReference: 'MNFY|1' } } } : { status: 404 });
  r = await pt.post('/api/me/bills/' + bill.id + '/pay');
  assert.equal(r.body.mode, 'monnify'); assert.match(r.body.authorizationUrl, /monnify/);
  const payload = JSON.stringify({ eventType: 'SUCCESSFUL_TRANSACTION', eventData: { paymentReference: r.body.reference, amountPaid: bill.patientDueKobo / 100, paymentStatus: 'PAID' } });
  const sig = crypto.createHmac('sha512', 'monsecret').update(payload).digest('hex');
  const w = await fetch(h.base + '/api/pay/monnify/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'monnify-signature': sig }, body: payload });
  assert.equal(w.status, 200);
  assert.equal((await h.db.col('bills').findOne({ id: bill.id })).status, 'paid');
  // switching back off: demo payments return
  await hq.patch('/api/hq/config/integrations', { patch: { payments: { provider: 'none' } } });
  bill = await openBill();
  r = await pt.post('/api/me/bills/' + bill.id + '/pay');
  assert.equal(r.body.mode, 'demo');
});

test('SMS gateway switch: Africa\'s Talking and a custom HTTP SMS API', async () => {
  await hq.patch('/api/hq/config/integrations', { patch: { sms: { provider: 'africastalking' }, africastalking: { username: 'medicore', apiKey: 'atkey', senderId: 'MediCore' } } });
  calls = [];
  fake = () => ({ status: 201, body: {} });
  const t1 = await hq.post('/api/hq/config/test/sms', { to: '08031234567' });
  assert.equal(t1.status, 200); assert.equal(t1.body.ok, true);
  const c = calls.find(x => /africastalking/.test(x.url));
  assert.equal(c.opts.headers.apiKey, 'atkey'); assert.equal(c.opts.form.to, '+2348031234567');
  await hq.patch('/api/hq/config/integrations', { patch: { sms: { provider: 'custom' }, customSms: { url: 'https://sms.example.com/send', token: 'smstok', bodyTemplate: '{"to":"{{toNoPlus}}","msg":"{{text}}"}', successStatus: 200 } } });
  calls = []; fake = () => ({ status: 200, body: {} });
  const t2 = await hq.post('/api/hq/config/test/sms', { to: '08031234567' });
  assert.equal(t2.body.ok, true);
  assert.equal(calls[0].opts.json.to, '2348031234567'); assert.equal(calls[0].opts.headers.Authorization, 'Bearer smstok');
  const badTpl = await hq.patch('/api/hq/config/integrations', { patch: { customSms: { bodyTemplate: '{"to": ' } } });
  assert.equal(badTpl.status, 400);
  const badEnum = await hq.patch('/api/hq/config/integrations', { patch: { payments: { provider: 'bitcoin' } } });
  assert.equal(badEnum.status, 400);
  const dev = await h.as('hq', 'dev@medicore.demo');
  assert.equal((await dev.patch('/api/hq/config/integrations', { patch: { sms: { provider: 'none' } } })).status, 403, 'only the platform owner changes keys');
});

test('compliance register: an enforced item that is not done switches features off everywhere', async () => {
  let cfg = await h.client('patient').get('/api/meta/config');
  assert.equal(cfg.body.features.videoVisits, true);
  const r = await hq.patch('/api/hq/config/compliance', { patch: { items: { hefamaa: { status: 'in_progress', enforce: true } } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  cfg = await h.client('patient').get('/api/meta/config');
  assert.equal(cfg.body.features.videoVisits, false);
  const st = await hq.get('/api/hq/integrations/status');
  assert.ok(st.body.compliance.find(c => c.key === 'hefamaa').blocking);
  await hq.patch('/api/hq/config/compliance', { patch: { items: { hefamaa: { status: 'done', reference: 'HEF/2026/123', docUrl: 'https://example.com/cert.pdf' } } } });
  cfg = await h.client('patient').get('/api/meta/config');
  assert.equal(cfg.body.features.videoVisits, true);
  const custom = await hq.patch('/api/hq/config/compliance', { patch: { items: { nafdac: { label: 'NAFDAC listing', status: 'not_started', enforce: false, blocksFeatures: [] } }, partners: { harbor: { name: 'Harbor Health HMO', kind: 'hmo', status: 'signed', startsOn: '2026-11-01' } } } });
  assert.equal(custom.status, 200);
  assert.equal((await hq.patch('/api/hq/config/compliance', { patch: { items: { x1: { blocksFeatures: ['notAFeature'] } } } })).status, 400);
  assert.equal((await hq.patch('/api/hq/config/compliance', { patch: { partners: { p1: { status: 'married' } } } })).status, 400);
  const st2 = await hq.get('/api/hq/integrations/status');
  assert.ok(st2.body.partners.some(p => p.name === 'Harbor Health HMO'));
});

test('outgoing connectors: signed events with ids only, test, delivery log and retry', async () => {
  const c = await hq.post('/api/hq/connectors', { label: 'Bank ERP', url: 'https://erp.example.com/hook', events: ['referral.sent', 'bill.paid'], secret: 'conn-secret' });
  assert.equal(c.status, 200, JSON.stringify(c.body)); assert.equal(c.body.secretSet, true);
  assert.equal((await hq.post('/api/hq/connectors', { label: 'x', url: 'http://insecure', events: ['*'] })).status, 400);
  assert.equal((await hq.post('/api/hq/connectors', { label: 'x', url: 'https://ok.example.com', events: ['nope.event'] })).status, 400);
  calls = []; fake = () => ({ status: 200, body: {} });
  const ph = await h.as('pharmacy', 'pharmacist@yabacare.demo');
  const ref = await ph.post('/api/referrals', { patientId: h.ctx.patients.tobi.id, toOrgId: h.ctx.orgs.hospital.id, urgency: 'routine', service: 'consultation', reason: 'Medicine review needed', consent: true });
  assert.equal(ref.status, 200);
  const hit = calls.find(x => x.url === 'https://erp.example.com/hook');
  assert.ok(hit, 'event delivered');
  assert.equal(hit.opts.json.event, 'referral.sent'); assert.equal(hit.opts.json.data.referralId, ref.body.id);
  assert.ok(!JSON.stringify(hit.opts.json).includes('Tobi'), 'no patient names in events');
  const expected = 'sha256=' + crypto.createHmac('sha256', 'conn-secret').update(JSON.stringify(hit.opts.json)).digest('hex');
  assert.equal(hit.opts.headers['X-MediCore-Signature'], expected);
  fake = () => ({ status: 500, body: {} });
  const t = await hq.post('/api/hq/connectors/' + c.body.id + '/test');
  assert.equal(t.body.ok, false);
  const d = await hq.get('/api/hq/connectors/' + c.body.id + '/deliveries');
  assert.ok(d.body.length >= 2);
  fake = () => ({ status: 204, body: {} });
  const retry = await hq.post('/api/hq/connectors/deliveries/' + d.body[0].id + '/retry');
  assert.equal(retry.body.ok, true);
  assert.equal((await hq.post('/api/hq/connectors/' + c.body.id + '/delete')).status, 200);
});
