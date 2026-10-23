'use strict';
/*
 * HQ control plane API (no-code configuration) and the public config the apps read at start.
 *   GET  /api/meta/config                    branding, content, features for the calling app (public)
 *   GET  /api/hq/config                      everything, secrets masked
 *   PATCH /api/hq/config/:section            change one section (versioned, audited)
 *   GET  /api/hq/config/history              versions
 *   POST /api/hq/config/restore              roll back to a version
 *   GET/PATCH /api/hq/config/orgs/:id/overrides   per-provider features/process/content
 *   POST /api/hq/config/test/:integration    check that keys work
 */
const express = require('express');
const https = require('https');
const db = require('../db');
const config = require('../config');
const S = require('../lib/settings');
const A = require('../lib/auth');
const { ah, body, t, bad, notFound, forbidden, param } = require('../lib/http');
const roles = require('../lib/roles');
const PAYLIB = require('../lib/payments');
const EV = require('../lib/events');
const { id: newId } = require('../lib/util');
const { audit } = require('../lib/audit');

const router = express.Router();
const SECTIONS = ['branding', 'content', 'features', 'process', 'pricing', 'roles', 'catalog', 'integrations', 'compliance'];
const HEX = /^#[0-9a-fA-F]{6}$/;

router.get('/meta/config', ah(async (req, res) => {
  const q = String(req.query.app || '');
  const app = q === 'register' ? 'register' : (req.ctx.app || q || 'patient');
  res.json(S.publicConfig(roles.APPS.includes(app) || app === 'register' ? app : 'patient', req.ctx.org || null));
}));

router.get('/hq/config', A.requirePlatform('platform.read'), ah(async (req, res) => {
  const c = await S.load();
  res.json({ version: c.version, updatedAt: c.updatedAt, settings: S.maskSecrets(c.data), defaults: S.maskSecrets(S.DEFAULTS),
    catalog: { perms: roles.PERMS, apps: roles.APPS, modules: Object.keys(roles.MODULES), roles: Object.fromEntries(Object.entries(roles.ROLES).map(([k, r]) => [k, { label: r.label, app: r.app, module: r.module, clock: r.clock, perms: r.perms, custom: !!r.custom }])), orgTypes: roles.ORG_TYPES },
    environment: { demoMode: config.DEMO_MODE, db: db.kind, dataLocation: config.DATA_LOCATION, dpoEmail: config.DPO_EMAIL, settingsKeySet: !!process.env.SETTINGS_KEY } });
}));

/* validation per section: strict enough to stop a typo breaking every app */
function validateSection(section, patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw bad('Send an object of changes');
  const size = JSON.stringify(patch).length; if (size > 60000) throw bad('That change is too large');
  const walk = (o, fn, p = '') => { for (const [k, v] of Object.entries(o)) { const path = p ? p + '.' + k : k; if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, fn, path); else fn(path, v); } };
  const known = S.DEFAULTS[section];
  if (section === 'branding') walk(patch, (p, v) => { if (/\.hue$/.test(p) && !HEX.test(v)) throw bad('Colours must be hex like #0F6B6E (' + p + ')'); if (typeof v === 'string' && v.length > 300) throw bad(p + ' is too long'); if (p === 'logoUrl' && v && !/^https:\/\//.test(v) && !v.startsWith('/')) throw bad('Logo must be an https URL'); });
  if (section === 'content') walk(patch, (p, v) => { if (typeof v !== 'string') throw bad(p + ' must be text'); if (v.length > 4000) throw bad(p + ' is too long'); if (p.startsWith('i18n.') && !['en', 'pcm', 'yo', 'ha', 'ig'].includes(p.split('.')[1])) throw bad('Unsupported language in ' + p); if (p.startsWith('i18nStatus.') && !['machine', 'reviewed'].includes(v)) throw bad('Status must be machine or reviewed'); });
  if (section === 'features') walk(patch, (p, v) => { if (p === 'languages') return; if (p === 'maintenanceMessage') { if (typeof v !== 'string' || v.length > 300) throw bad('Maintenance message must be short text'); return; } if (typeof v !== 'boolean') throw bad(p + ' must be on or off'); if (!(p in known)) throw bad('Unknown feature ' + p); });
  if (section === 'features' && patch.languages) { if (!Array.isArray(patch.languages) || !patch.languages.every(l => ['en', 'pcm', 'yo', 'ha', 'ig', 'fr'].includes(l))) throw bad('Unsupported language'); }
  if (section === 'process') walk(patch, (p, v) => { const d = p.split('.').reduce((a, k) => (a ? a[k] : undefined), known); if (d === undefined) throw bad('Unknown setting ' + p); if (typeof d === 'number' && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e12)) throw bad(p + ' must be a number'); if (typeof d === 'boolean' && typeof v !== 'boolean') throw bad(p + ' must be on or off'); });
  if (section === 'process' && patch.patients && patch.patients.mode !== undefined && !['provider', 'open'].includes(patch.patients.mode)) throw bad('Patient mode must be provider or open');
  if (section === 'process' && patch.security) { if (patch.security.passwordMinLength != null && patch.security.passwordMinLength < 8) throw bad('Passwords cannot be shorter than 8 characters'); if (patch.security.sessionHours != null && (patch.security.sessionHours < 1 || patch.security.sessionHours > 72)) throw bad('Session length must be 1 to 72 hours'); if (patch.security.lockoutAttempts != null && (patch.security.lockoutAttempts < 3 || patch.security.lockoutAttempts > 20)) throw bad('Lockout attempts must be 3 to 20'); }
  if (section === 'pricing') walk(patch, (p, v) => { if (p === 'bundleDiscounts' || p.startsWith('bundleDiscounts') || p.startsWith('branchDiscounts')) return; if (p === 'baseIncludes') return; if (p === 'currency' || p === 'period') { if (typeof v !== 'string') throw bad(p + ' must be text'); return; } if (p === 'selfServeModules') { if (typeof v !== 'boolean') throw bad('selfServeModules must be on or off'); return; } if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1e12) throw bad(p + ' must be a whole number (kobo for prices)'); if (p.startsWith('modulesKobo.') && !roles.MODULES[p.split('.')[1]]) throw bad('Unknown module ' + p); });
  if (section === 'pricing' && patch.branchDiscounts) { if (!Array.isArray(patch.branchDiscounts) || !patch.branchDiscounts.every(d => Number.isInteger(d.minBranches) && d.minBranches > 1 && typeof d.percent === 'number' && d.percent >= 0 && d.percent <= 60)) throw bad('Branch discounts need minBranches (2 or more) and a percent between 0 and 60'); }
  if (section === 'pricing' && patch.bundleDiscounts) { if (!Array.isArray(patch.bundleDiscounts) || !patch.bundleDiscounts.every(d => Number.isInteger(d.minModules) && d.minModules > 0 && typeof d.percent === 'number' && d.percent >= 0 && d.percent <= 60)) throw bad('Bundle discounts need minModules and a percent between 0 and 60'); }
  if (section === 'roles') {
    for (const [k, o] of Object.entries(patch.overrides || {})) { if (!roles.ROLES[k] || roles.ROLES[k].custom) throw bad('Unknown built-in role ' + k); for (const p of (o.addPerms || []).concat(o.removePerms || [])) if (!roles.PERMS[p]) throw bad('Unknown permission ' + p); if (k === 'owner' && (o.removePerms || []).includes('admin.staff')) throw bad('The owner must keep staff management'); }
    for (const [k, c] of Object.entries(patch.custom || {})) { if (c === null) continue; if (!/^[a-z][a-z0-9_]{2,30}$/.test(k)) throw bad('Role keys use lower case letters, numbers and _'); if (roles.ROLES[k] && !roles.ROLES[k].custom) throw bad(k + ' is a built-in role'); if (!roles.APPS.includes(c.app) || ['hq', 'patient'].includes(c.app)) throw bad('Pick the staff app this role uses'); if (c.module && !roles.MODULES[c.module]) throw bad('Unknown module'); for (const p of c.perms || []) if (!roles.PERMS[p]) throw bad('Unknown permission ' + p); if (!c.label) throw bad('Give the role a name'); }
  }
  if (section === 'catalog') {
    for (const [k, o] of Object.entries(patch.orgTypes || {})) { if (!roles.ORG_TYPES[k]) throw bad('Unknown provider type ' + k); for (const m of (o.modules || []).concat(o.optional || [])) if (!roles.MODULES[m]) throw bad('Unknown module ' + m); if (k !== 'hmo' && o.modules && !o.modules.includes('frontdesk')) throw bad('Every provider package keeps the front desk'); }
    for (const k of Object.keys(patch.modules || {})) if (!roles.MODULES[k]) throw bad('Unknown module ' + k);
  }
  if (section === 'integrations') {
    const ENUMS = { 'payments.provider': ['paystack', 'flutterwave', 'monnify', 'custom', 'none'], 'sms.provider': ['termii', 'africastalking', 'custom', 'none'], 'customPayment.auth.type': ['none', 'bearer', 'basic', 'header', 'oauth2'],
      'customPayment.init.method': ['POST', 'PUT', 'GET'], 'customPayment.verify.method': ['GET', 'POST'], 'customPayment.verify.amountUnit': ['kobo', 'naira'], 'customPayment.webhook.algorithm': ['sha512', 'sha256', 'none'], 'customSms.method': ['POST', 'GET'], 'customSms.contentType': ['json', 'form'], 'email.provider': ['', 'none', 'sendgrid', 'brevo', 'mailgun', 'resend'], 'email.mailgunRegion': ['us', 'eu'] };
    walk(patch, (p, v) => { if (ENUMS[p] && !ENUMS[p].includes(v)) throw bad(p + ' must be one of: ' + ENUMS[p].join(', ')); if (/bodyTemplate$/.test(p) && v && /^\s*[{[]/.test(v)) { try { JSON.parse(String(v).replace(/\{\{\w+\}\}/g, '0')); } catch (e) { throw bad(p + ' is not valid JSON (placeholders like {{reference}} are allowed)'); } } if (/path$/i.test(p) && typeof v === 'string' && v && !/^[\w./{}-]*$/.test(v)) throw bad(p + ' has characters that are not allowed'); });
  }
  if (section === 'compliance') {
    const ST = ['not_started', 'in_progress', 'submitted', 'done', 'expired', 'not_needed'];
    for (const [k, it] of Object.entries(patch.items || {})) {
      if (it === null) continue;
      if (!/^[a-zA-Z][a-zA-Z0-9_]{1,30}$/.test(k)) throw bad('Item keys use letters, numbers and _');
      if (it.status !== undefined && !ST.includes(it.status)) throw bad('Status must be one of: ' + ST.join(', '));
      if (it.blocksFeatures !== undefined && (!Array.isArray(it.blocksFeatures) || !it.blocksFeatures.every(f => typeof S.DEFAULTS.features[f] === 'boolean'))) throw bad('blocksFeatures must list feature switches');
      if (it.enforce !== undefined && typeof it.enforce !== 'boolean') throw bad('enforce must be on or off');
      for (const [f, v] of Object.entries(it)) if (!['blocksFeatures', 'enforce'].includes(f) && v != null && (typeof v !== 'string' || v.length > 1000)) throw bad(k + '.' + f + ' must be short text');
      if (it.docUrl && !/^https:\/\//.test(it.docUrl)) throw bad('Document links must start with https://');
    }
    for (const [k, pt] of Object.entries(patch.partners || {})) {
      if (pt === null) continue;
      if (!/^[a-zA-Z0-9_-]{2,40}$/.test(k)) throw bad('Partner keys use letters, numbers, - and _');
      for (const [f, v] of Object.entries(pt)) if (v != null && (typeof v !== 'string' || v.length > 2000)) throw bad(k + '.' + f + ' must be text');
      if (pt.status !== undefined && !['prospect', 'negotiating', 'signed', 'live', 'paused', 'ended'].includes(pt.status)) throw bad('Partner status must be prospect, negotiating, signed, live, paused or ended');
    }
  }
  if (section === 'integrations') walk(patch, (p, v) => { if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw bad(p + ' has the wrong type'); if (typeof v === 'string' && v.length > 2000) throw bad(p + ' is too long'); if (/url$/i.test(p) && v && !/^https:\/\//.test(v) && !(p === 'turn.url' && /^turns?:/.test(v))) throw bad(p + ' must start with https://'); });
}

router.patch('/hq/config/:section', A.requirePlatform('platform.config'), ah(async (req, res) => {
  const section = req.params.section;
  if (!SECTIONS.includes(section)) throw notFound('Unknown settings section');
  if (section === 'integrations' && !req.ctx.perms.includes('platform.integrations')) throw forbidden('Only the platform owner can change integration keys');
  const b = req.body || {};
  validateSection(section, b.patch);
  try {
    const r = await S.saveSection(section, b.patch, { by: req.ctx.user.id, expectVersion: typeof b.expectVersion === 'number' ? b.expectVersion : undefined, note: typeof b.note === 'string' ? b.note.slice(0, 200) : null });
    await audit(req, 'platform.config', { type: 'settings', id: section, orgId: null }, { version: r.version, changed: r.changed.slice(0, 40) });
    res.json(r);
  } catch (e) { if (e.status === 409) return res.status(409).json({ error: e.message, code: 'version_conflict' }); throw e; }
}));

router.get('/hq/config/history', A.requirePlatform('platform.read'), ah(async (req, res) => {
  const rows = await db.col('platform_settings_history').find({}, { sort: { version: -1 }, limit: 100, projection: { data: 0 } });
  const users = rows.length ? await db.col('users').find({ id: { $in: [...new Set(rows.map(r => r.by))] } }, { projection: { name: 1 } }) : [];
  const nm = Object.fromEntries(users.map(u => [u.id, u.name]));
  res.json(rows.map(r => Object.assign({ byName: nm[r.by] || 'Unknown' }, r)));
}));
router.post('/hq/config/restore', A.requirePlatform('platform.config'), ah(async (req, res) => {
  const b = body(req, { version: t.int({ required: true, min: 1 }) });
  const r = await S.restore(b.version, req.ctx.user.id);
  await audit(req, 'platform.config_restore', { type: 'settings', id: String(b.version), orgId: null }, { newVersion: r.version });
  res.json(r);
}));

/* per-provider overrides of features, process and content */
router.get('/hq/config/orgs/:id/overrides', A.requirePlatform('platform.read'), ah(async (req, res) => {
  const o = await db.col('orgs').findOne({ id: param(req, 'id') }); if (!o) throw notFound('Provider not found');
  res.json({ orgId: o.id, name: o.name, overrides: o.overrides || {}, effective: (({ features, process, content }) => ({ features, process, content }))(S.effective(o)) });
}));
router.patch('/hq/config/orgs/:id/overrides', A.requirePlatform('platform.orgs'), ah(async (req, res) => {
  const o = await db.col('orgs').findOne({ id: param(req, 'id') }); if (!o) throw notFound('Provider not found');
  const b = req.body || {};
  const next = Object.assign({}, o.overrides || {});
  for (const s of S.ORG_OVERRIDABLE) {
    if (b[s] === undefined) continue;
    if (b[s] === null) { delete next[s]; continue; }
    validateSection(s, b[s]);
    next[s] = S.merge(next[s] || {}, b[s]);
  }
  await db.col('orgs').updateOne({ id: o.id }, { $set: { overrides: next } });
  await audit(req, 'platform.org_overrides', { type: 'org', id: o.id, orgId: o.id }, { sections: Object.keys(b) });
  res.json({ ok: true, overrides: next });
}));

/* connection tests (each makes one harmless call) */
function get(host, path, headers) {
  return new Promise(resolve => { const r = https.request({ host, path, method: 'GET', headers, timeout: 8000 }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 400) })); }); r.on('error', e => resolve({ status: 0, error: e.message })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); }); r.end(); });
}
router.post('/hq/config/test/:integration', A.requirePlatform('platform.integrations'), ah(async (req, res) => {
  await S.load(true);
  const which = req.params.integration;
  let r;
  if (which === 'paystack') { if (!config.PAYSTACK_SECRET) throw bad('No Paystack secret key saved'); r = await get('api.paystack.co', '/balance', { Authorization: 'Bearer ' + config.PAYSTACK_SECRET }); }
  else if (which === 'termii') { if (!config.TERMII_KEY) throw bad('No Termii key saved'); r = await get('api.ng.termii.com', '/api/get-balance?api_key=' + encodeURIComponent(config.TERMII_KEY), {}); }
  else if (which === 'ai') { const ai = require('./ai'); r = await ai.testConnection(); }
  else if (which === 'flutterwave') { const P = config.PAYMENTS.flutterwave; if (!P.secretKey) throw bad('No Flutterwave secret key saved'); r = await PAYLIB.request('https://api.flutterwave.com/v3/balances/NGN', { headers: { Authorization: 'Bearer ' + P.secretKey } }); }
  else if (which === 'monnify') { const M = config.PAYMENTS.monnify; if (!M.apiKey || !M.secretKey) throw bad('Save the Monnify API key and secret key first'); r = await PAYLIB.request(M.baseUrl.replace(/\/$/, '') + '/api/v1/auth/login', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(M.apiKey + ':' + M.secretKey).toString('base64') }, json: {} }); }
  else if (which === 'customPayment') { const C = config.PAYMENTS.custom; if (!C.baseUrl) throw bad('Save the gateway base URL first'); if (C.auth.type === 'oauth2') { r = await PAYLIB.request(C.auth.tokenUrl, { method: 'POST', form: { grant_type: 'client_credentials', client_id: C.auth.clientId || '', client_secret: C.auth.clientSecret || '', scope: C.auth.scope || '' } }); } else { r = await PAYLIB.request(C.baseUrl, {}); if (r.status && r.status < 500) r = { ok: true, message: 'Reached the gateway (HTTP ' + r.status + '). Make a small live payment to confirm the templates.' }; } }
  else if (which === 'africastalking') { const T = config.SMS.africastalking; if (!T.username || !T.apiKey) throw bad('Save the Africa\'s Talking username and API key first'); r = await PAYLIB.request((T.username === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com') + '/version1/user?username=' + encodeURIComponent(T.username), { headers: { apiKey: T.apiKey } }); }
  else if (which === 'whatsapp') {
    const WAL = require('../lib/whatsapp');
    const b = body(req, { to: t.str({ max: 20 }) });
    const info = await WAL.phoneInfo();
    if (!info.ok) r = { ok: false, message: info.error || 'WhatsApp did not accept the token or phone number ID' };
    else if (b.to) { const n = WAL.normIntl(b.to); if (!n) throw bad('Enter a valid WhatsApp number'); const s2 = await WAL.sendUpdate(n, 'Test', 'Your WhatsApp connection works.'); r = s2.ok ? { ok: true, message: 'Connected as ' + (info.info.verified_name || '') + ' (' + (info.info.display_phone_number || '') + '). Test message sent.' } : { ok: false, message: 'Connected, but the test template was not accepted: ' + (s2.error || 'check the template name') }; }
    else r = { ok: true, message: 'Connected as ' + (info.info.verified_name || '') + ' (' + (info.info.display_phone_number || '') + ')' };
  }
  else if (which === 'email') {
    const b = body(req, { to: t.email({ required: true }) });
    const er = await require('../lib/email').send({ to: b.to, subject: S.get('branding.productName', 'MediCore') + ' test email', text: 'Your email gateway works.' });
    r = er.sent ? { ok: true, message: 'Sent through ' + er.provider } : { ok: false, message: er.error === 'not_configured' ? 'Choose an email gateway and save its key and sender address first' : 'The gateway did not accept the email: ' + er.error };
  }
  else if (which === 'sms') {
    const b = body(req, { to: t.phone({ required: true }) });
    const sr = await require('../lib/sms').send(b.to, (S.get('branding.productName', 'MediCore')) + ' test message. Your SMS gateway works.');
    r = sr.sent ? { ok: true, message: 'Sent through ' + sr.provider } : { ok: false, message: sr.mode === 'dev' ? 'No SMS gateway is set up' : 'The gateway did not accept the message' };
  }
  else throw notFound('Nothing to test for that integration');
  await audit(req, 'platform.integration_test', { type: 'integration', id: which, orgId: null }, { ok: r.status === 200 || r.ok === true });
  res.json({ ok: r.status === 200 || r.ok === true, status: r.status || null, message: r.error || r.message || (r.status === 200 ? 'Connected' : 'The service did not accept the key') });
}));

/* ---------- go-live checklist: integrations and compliance at a glance ---------- */
router.get('/hq/integrations/status', A.requirePlatform('platform.read'), ah(async (req, res) => {
  await S.load();
  const pay = PAYLIB.active(); const sms = require('../lib/sms').active();
  const items = S.get('compliance.items', {}) || {};
  res.json({
    integrations: [
      { key: 'payments', label: 'Online payments', provider: pay.name, providerLabel: pay.label, ready: pay.configured, needs: pay.configured ? null : 'A live gateway account (Paystack, Flutterwave, Monnify or your bank) and its keys' },
      { key: 'sms', label: 'SMS', provider: sms.name, ready: sms.configured, needs: sms.configured ? null : 'An SMS account and an approved sender ID' },
      { key: 'turn', label: 'Video relay (TURN)', ready: !!config.TURN_URL, needs: config.TURN_URL ? null : 'A TURN relay account (Metered, Twilio or self-hosted)' },
      { key: 'maps', label: 'Map tiles', ready: !/openstreetmap\.org/.test(config.MAP_TILE_URL), needs: /openstreetmap\.org/.test(config.MAP_TILE_URL) ? 'A map tile plan for production volume (public OpenStreetMap tiles are for light use)' : null },
      { key: 'geocoder', label: 'Address search', ready: !!config.GEOCODER_URL, needs: config.GEOCODER_URL ? null : 'A geocoding plan (the public Photon instance is for light use)' },
      { key: 'ussd', label: 'USSD', ready: !!config.USSD_SECRET, needs: config.USSD_SECRET ? null : 'A USSD short code from an aggregator and a shared secret' },
      { key: 'ai', label: 'AI assistant', provider: (config.AI || {}).provider, ready: !!(config.AI && config.AI.apiKey), needs: config.AI && config.AI.apiKey ? null : 'An AI provider account and API key' },
      { key: 'whatsapp', label: 'WhatsApp Business', ready: require('../lib/whatsapp').configured() && S.feature('whatsapp') && !!(config.WHATSAPP.templates || {}).update, needs: require('../lib/whatsapp').configured() ? (S.feature('whatsapp') ? (!(config.WHATSAPP.templates || {}).update ? 'An approved "update" message template name' : (config.WHATSAPP.sendCodes && !(config.WHATSAPP.templates || {}).code ? 'An approved authentication template name for codes' : null)) : 'Switch on WhatsApp in Features') : 'A Meta WhatsApp Business account: access token, app secret, verify token, phone number ID and an approved template. Click-to-chat numbers work without it.' },
      { key: 'email', label: 'Email', provider: (config.EMAIL || {}).provider || null, ready: require('../lib/email').configured(), needs: require('../lib/email').configured() ? null : 'An email gateway account (SendGrid, Brevo, Mailgun or Resend) and a verified sender address' },
      { key: 'connectors', label: 'Outgoing connectors', ready: (await db.col('connectors').count({ active: true })) > 0, needs: null },
    ],
    compliance: Object.entries(items).filter(([, v]) => v).map(([k, v]) => ({ key: k, label: v.label, status: v.status, enforce: !!v.enforce, blocksFeatures: v.blocksFeatures || [], expiresOn: v.expiresOn || null, blocking: !!v.enforce && v.status !== 'done' && (v.blocksFeatures || []).length > 0 })),
    partners: Object.entries(S.get('compliance.partners', {}) || {}).filter(([, v]) => v).map(([k, v]) => ({ key: k, name: v.name, kind: v.kind || null, status: v.status || 'prospect', endsOn: v.endsOn || null })),
  });
}));

/* ---------- outgoing connectors (send events to a bank, ERP, HMO system...) ---------- */
const connRules = { label: t.str({ required: true, max: 80 }), url: t.str({ required: true, max: 500, pattern: /^https:\/\//, label: 'URL (https)' }), events: t.arr(t.str({ max: 60 }), { required: true, min: 1, max: 30 }), secret: t.str({ max: 200, trim: false }), active: t.bool({ default: true }), orgIds: t.arr(t.id(), { max: 200 }) };
const connView = c => ({ id: c.id, label: c.label, url: c.url, events: c.events, active: !!c.active, orgIds: c.orgIds || [], secretSet: !!(c.secret && c.secret.enc), lastAt: c.lastAt || null, lastOk: c.lastOk == null ? null : c.lastOk, lastStatus: c.lastStatus || null, createdAt: c.createdAt });
function checkEvents(list) { for (const e of list) if (e !== '*' && !EV.EVENTS[e]) throw bad('Unknown event ' + e); }
router.get('/hq/connectors', A.requirePlatform('platform.read'), ah(async (req, res) => {
  res.json({ connectors: (await db.col('connectors').find({}, { sort: { createdAt: -1 } })).map(connView), events: EV.EVENTS });
}));
router.post('/hq/connectors', A.requirePlatform('platform.integrations'), ah(async (req, res) => {
  const b = body(req, connRules); checkEvents(b.events);
  const c = { id: newId('cn'), label: b.label, url: b.url, events: b.events, active: b.active !== false, orgIds: b.orgIds || [], secret: b.secret ? S.encrypt(b.secret) : null, createdAt: Date.now(), createdBy: req.ctx.user.id };
  await db.col('connectors').insertOne(c);
  await audit(req, 'platform.connector_create', { type: 'connector', id: c.id, orgId: null }, { events: c.events });
  res.json(connView(c));
}));
router.patch('/hq/connectors/:id', A.requirePlatform('platform.integrations'), ah(async (req, res) => {
  const rules = Object.assign({}, connRules, { label: t.str({ max: 80 }), url: t.str({ max: 500, pattern: /^https:\/\// }), events: t.arr(t.str({ max: 60 }), { max: 30 }), active: t.bool() });
  const b = body(req, rules); if (b.events) checkEvents(b.events);
  const set = {}; ['label', 'url', 'events', 'active', 'orgIds'].forEach(k => { if (b[k] !== undefined) set[k] = b[k]; });
  if (b.secret !== undefined) set.secret = b.secret ? S.encrypt(b.secret) : null;
  const c = await db.col('connectors').findOneAndUpdate({ id: param(req, 'id') }, { $set: set });
  if (!c) throw notFound('Connector not found');
  await audit(req, 'platform.connector_update', { type: 'connector', id: c.id, orgId: null }, { fields: Object.keys(set) });
  res.json(connView(c));
}));
router.post('/hq/connectors/:id/delete', A.requirePlatform('platform.integrations'), ah(async (req, res) => {
  const c = await db.col('connectors').findOne({ id: param(req, 'id') }); if (!c) throw notFound('Connector not found');
  await db.col('connectors').deleteOne({ id: c.id });
  await audit(req, 'platform.connector_delete', { type: 'connector', id: c.id, orgId: null });
  res.json({ ok: true });
}));
router.post('/hq/connectors/:id/test', A.requirePlatform('platform.integrations'), ah(async (req, res) => {
  const c = await db.col('connectors').findOne({ id: param(req, 'id') }); if (!c) throw notFound('Connector not found');
  const ok = await EV.deliver(c, 'connector.test', { deliveryId: newId('dlv'), event: 'connector.test', at: new Date().toISOString(), data: { message: 'Test from HQ' } });
  res.json({ ok, message: ok ? 'The endpoint accepted the test event' : 'The endpoint did not accept the test event. See Deliveries.' });
}));
router.get('/hq/connectors/:id/deliveries', A.requirePlatform('platform.read'), ah(async (req, res) => {
  res.json(await db.col('connector_deliveries').find({ connectorId: param(req, 'id') }, { sort: { at: -1 }, limit: 100 }));
}));
router.post('/hq/connectors/deliveries/:id/retry', A.requirePlatform('platform.integrations'), ah(async (req, res) => {
  const d = await db.col('connector_deliveries').findOne({ id: param(req, 'id') }); if (!d) throw notFound('Delivery not found');
  const c = await db.col('connectors').findOne({ id: d.connectorId }); if (!c) throw notFound('Connector not found');
  const ok = await EV.deliver(c, d.event, Object.assign({}, d.payload, { deliveryId: newId('dlv'), retryOf: d.id }));
  res.json({ ok });
}));

module.exports = { name: 'controlplane', router, SECTIONS };
