'use strict';
/*
 * Platform settings: the no-code control plane behind MediCore HQ.
 *
 * Everything the MediCore team may want to change without touching code lives here:
 *   branding   product name, per-app colours and titles, logo, default theme
 *   content    texts shown in the apps (global and per app), legal links, emergency numbers
 *   features   switches for whole capabilities (self sign-up, video visits, USSD, AI, WhatsApp...)
 *   process    workflow parameters (cancellation window, pickup window, OTP expiry, lockouts...)
 *   roles      change any built-in role's permissions, or create new roles
 *   catalog    labels and default modules of provider types and modules
 *   integrations  keys and endpoints for payments, SMS, maps, video relay, AI, USSD
 * Layering:  code defaults  <  platform settings (HQ)  <  per-provider overrides (HQ, on the org)
 * Every save is a new version with who/when/what changed; any version can be restored.
 * Secrets are encrypted at rest (AES-256-GCM, key from SETTINGS_KEY) and never sent to browsers.
 */
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const roles = require('./roles');

const DEFAULTS = {
  branding: {
    productName: 'MediCore', supportEmail: 'support@medicore.ng', supportPhone: '', supportWhatsapp: '', salesPhone: '', salesWhatsapp: '', logoUrl: '', defaultTheme: 'system',
    apps: {
      patient: { title: 'MediCore', hue: '#0F6B6E' }, frontdesk: { title: 'MediCore Front Desk', hue: '#1F5FA8' }, doctor: { title: 'MediCore Doctor', hue: '#3D4FA6' },
      pharmacy: { title: 'MediCore Pharmacy', hue: '#1E7A4C' }, rider: { title: 'MediCore Rider', hue: '#9A5B00' }, dispatch: { title: 'MediCore Dispatch', hue: '#B42D27' },
      crew: { title: 'MediCore Crew', hue: '#A23A1C' }, lab: { title: 'MediCore Lab', hue: '#6B3FA0' }, chw: { title: 'MediCore Community', hue: '#4E6B1F' },
      payer: { title: 'MediCore HMO', hue: '#234A7A' }, admin: { title: 'MediCore Admin', hue: '#3C5457' }, group: { title: 'MediCore Group', hue: '#4A3F6B' }, hq: { title: 'MediCore HQ', hue: '#10282B' }, register: { title: 'Join MediCore', hue: '#0F6B6E' },
    },
  },
  content: {
    /* HQ-editable translations: { yo: { 'key': 'text' }, ... } override the bundled language files */
    i18n: {},
    /* review status per language, shown in HQ: 'machine' (needs native review) | 'reviewed' */
    i18nStatus: { pcm: 'machine', yo: 'machine', ha: 'machine', ig: 'machine' },
    global: { emergencyNumbers: '112 (national), 767 (Lagos State Ambulance)', privacyUrl: '', termsUrl: '', footer: '', aiDisclaimer: 'The MediCore assistant gives general health information, not a diagnosis. In an emergency press SOS or call 112.', crisisLines: '' },
    apps: {
      patient: { loginSubtitle: 'Your health, all your providers, one app', homeGreeting: '', helpText: '' },
      register: { providerIntro: 'Bring your hospital, clinic, pharmacy, ambulance service or lab onto MediCore.', patientIntro: 'Create your MediCore account to book doctors, get medicines delivered and see your results.' },
      frontdesk: { loginSubtitle: 'Registration, check-in and billing' }, doctor: { loginSubtitle: 'Your patients and consultations' }, pharmacy: { loginSubtitle: 'Prescriptions, sales and deliveries' },
      rider: { loginSubtitle: 'Your delivery runs' }, dispatch: { loginSubtitle: 'Emergency calls and fleet' }, crew: { loginSubtitle: 'Your unit and current case' }, lab: { loginSubtitle: 'Samples, results and reports' },
      chw: { loginSubtitle: 'Household visits, online or offline' }, payer: { loginSubtitle: 'Members, authorisations and claims' }, admin: { loginSubtitle: 'Run your provider on MediCore' }, group: { loginSubtitle: 'Every branch of your hospital group in one place' }, hq: { loginSubtitle: 'Platform control' },
    },
  },
  features: {
    patientSelfSignup: true, providerSelfSignup: true, publicEmergency: true, videoVisits: true, marketplace: true, homeDelivery: true, ussd: true, whatsapp: false,
    ai: false, aiPatientAssistant: false, aiClinicianAssistant: false, aiLabExplainer: false, chw: true, onlinePayments: true, cashPayments: true, hmoClaims: true,
    languages: ['en', 'pcm', 'yo', 'ha', 'ig'], lowDataMode: false, maintenanceMode: false, maintenanceMessage: '',
    groups: true, referralNetwork: true, providerMessaging: true, providerDirectory: true,
    /* collaborative marketplace */
    wearables: true, marketplacePharmacy: true, careSharing: true, documents: true, inventory: true, publicFacilities: true, transfers: true, hmoRetail: true, hmoNetwork: true,
  },
  process: {
    security: { passwordMinLength: 8, sessionHours: 12, lockoutAttempts: 5, lockoutMinutes: 15, otpMinutes: 10, loginPerIpPer5Min: 150 },
    appointments: { patientCancelHours: 2, defaultSlotMinutes: 20, videoJoinEarlyMinutes: 15, videoJoinLateMinutes: 60, payBeforeVideo: true },
    pharmacy: { pickupWindowDays: 2, deliveryCodeAttempts: 5, requirePharmacistVerify: true, allowSubstitution: true },
    lab: { twoStepVerifyDefault: false, collectBeforePaymentForUrgent: true },
    hmo: { preauthThresholdKobo: 5000000, duplicateWindowHours: 24, frequencyLimitPer30Days: 3, primaryChangeMinMonths: 6, maxDependants: 6, verifyCardAnyProvider: false,
      /* patients with no HMO cover browse and buy any HMO's plans free (to get the uninsured insured); patients who already
       * have cover need a marketplace subscription to compare and join other HMOs */
      uninsuredBuyFree: true, otherHmosNeedSubscription: true },
    /* SOS is open to every patient: no marketplace subscription and no registration with the ambulance service needed.
     * The trip is billed to the patient's account by the service that went; the fallback tariff applies when that service
     * has no ambulance prices set, and the booking fee is MediCore's own line on the bill (0 turns it off). */
    emergency: { publicPerIpPerHour: 5, sosRadiusKm: 40, locationFreshSeconds: 120, patientChoosesService: true, fallbackCallKobo: 3000000, fallbackAlsKobo: 5500000, fallbackPerKmKobo: 60000, bookingFeeKobo: 150000 },
    /* identity: patients are registered with a NIN before a provider onboards them (lib/identity.js). Staff may register
     * without one only with a reason (a child, an emergency, not yet enrolled with NIMC). */
    identity: { requireNin: true, allowNoNinWithReason: true, matchDob: true, showHmoBeforeConsent: true },
    wearables: { requestExpiryMinutes: 30 },
    delivery: { riderLocationFreshSeconds: 120 },
    ai: { patientDailyMessages: 40, conversationRetentionDays: 90 },
    billing: { platformFeeKobo: 0, bankChargeKobo: 220000, showBankChargeToPatient: false },
    /* how patients relate to providers.
     *  mode 'provider' (default): a patient belongs to the providers that registered or approved them; the patient app
     *    shows one provider at a time (with a switcher), no platform-wide search, no record sharing between providers
     *    except through a referral.  mode 'open': platform-wide directory, booking anywhere, patient-controlled sharing. */
    patients: { mode: 'provider', freeFirstProvider: true, allowMultipleProviders: true, applicationsNeedApproval: true, crossProviderSharing: false, applicationExpiryDays: 30 },
    /* hospital groups with several branches */
    branches: { requireApproval: false, shareRecordsAcrossBranches: true, branchAdminsManageModules: false },
    /* provider-to-provider referral network */
    referrals: { requireConnection: false, requirePatientConsent: true, expireDays: 30, notifyPatient: true },
    /* the patient marketplace: subscribers find, compare and use any listed provider; HMO members see their HMO's network free */
    marketplace: { monthlyKobo: 250000, quarterlyKobo: 675000, annualKobo: 2500000, freeTrialDays: 0, hmoMembersSeeNetwork: true, autoRegisterOnUse: true, defaultRadiusKm: 15, showTeaser: true },
    /* several providers caring for one patient at the same time */
    careShare: { requirePatientConsent: true, allowCodeConsent: true, defaultDays: 180, maxDays: 730 },
    /* scanned paper records, letters, certificates and signed forms */
    documents: { maxFileMb: 3, maxFilesPerDocument: 10, patientUploads: true, patientSeesProviderScans: true },
    /* emergency transfers to hospitals on or off MediCore */
    transfers: { packHours: 72, packMaxViews: 20 },
  },
  /* modular pricing: every provider builds its own package. Monthly NGN prices, editable in HQ. */
  pricing: {
    currency: 'NGN', period: 'monthly', annualMonthsCharged: 10, trialDays: 30, seatsIncluded: 5, extraSeatKobo: 150000,
    // defaults set against Lagos benchmarks (Oct 2026 research): clinic about NGN 35k, pharmacy 25k, lab 40k, ambulance 60k, HMO desk 250k
    baseKobo: 1500000, baseIncludes: ['frontdesk', 'hmo'],
    modulesKobo: { clinic: 2000000, pharmacy: 1000000, delivery: 500000, ambulance: 4500000, lab: 2500000, chw: 1000000, payer: 25000000 },
    bundleDiscounts: [{ minModules: 3, percent: 10 }, { minModules: 5, percent: 15 }],
    selfServeModules: true,
    /* discount on a group's total when it runs several branches */
    branchDiscounts: [{ minBranches: 3, percent: 10 }, { minBranches: 10, percent: 20 }],
  },
  roles: { overrides: {}, custom: {} },
  catalog: { orgTypes: {}, modules: {} },
  integrations: {
    paystack: { publicKey: '', secretKey: null }, termii: { apiKey: null, senderId: 'MediCore' }, turn: { url: '', username: '', credential: null },
    maps: { tileUrl: '', attribution: '' }, geocoder: { url: '' }, routing: { url: '' }, ussd: { secret: null },
    ai: { provider: 'anthropic', model: 'claude-sonnet-5-5', fastModel: 'claude-haiku-5-5', apiKey: null, baseUrl: '', maxTokens: 800, monthlyBudgetNgn: 200000, region: '' },
    /* WhatsApp Business Platform (Meta Cloud API). phoneNumberId = the platform's default sender; providers and departments
     * can have their own numbers (Admin > Contacts: WhatsApp phone number ID). Templates must be approved by Meta first. */
    whatsapp: { phoneNumberId: '', businessAccountId: '', accessToken: null, appSecret: null, verifyToken: null, apiVersion: 'v21.0',
      templates: { update: '', updateLanguage: 'en', code: '', codeLanguage: 'en' }, notifyPatients: true, sendCodes: false, inbox: true,
      autoReply: 'Thank you for your message. Our team will reply here during opening hours. In an emergency call 112.',
      unknownReply: 'Welcome. To chat with your hospital, clinic, pharmacy or lab here, register with them first or download the app. In an emergency call 112.' },
    /* email gateway: none | sendgrid | brevo | mailgun | resend */
    email: { provider: '', apiKey: null, from: '', fromName: 'MediCore', mailgunDomain: '', mailgunRegion: 'us' },
    /* which payment gateway takes online payments: paystack | flutterwave | monnify | custom (a bank or any HTTP API) | none */
    payments: { provider: 'paystack', label: '', settleToProviders: true },
    flutterwave: { publicKey: '', secretKey: null, webhookHash: null },
    monnify: { apiKey: '', secretKey: null, contractCode: '', baseUrl: 'https://api.monnify.com' },
    /* a no-code connector for a bank's (or any gateway's) collection API. Placeholders in templates:
     * {{reference}} {{amountKobo}} {{amountNaira}} {{email}} {{phone}} {{name}} {{callbackUrl}} {{orgName}} {{settlementAccount}} {{settlementBankCode}} {{settlementSubaccount}} */
    customPayment: {
      label: 'Bank', baseUrl: '',
      auth: { type: 'none', headerName: 'Authorization', token: null, username: '', password: null, tokenUrl: '', clientId: '', clientSecret: null, scope: '' },
      init: { method: 'POST', path: '', bodyTemplate: '', checkoutUrlPath: 'data.checkoutUrl', providerRefPath: '' },
      verify: { method: 'GET', path: '', statusPath: 'data.status', successValues: 'success,successful,paid,completed', amountPath: 'data.amount', amountUnit: 'kobo' },
      webhook: { signatureHeader: '', algorithm: 'sha512', secret: null, referencePath: 'data.reference', statusPath: 'data.status', amountPath: 'data.amount' },
    },
    /* which SMS gateway sends codes and alerts: termii | africastalking | custom | none */
    sms: { provider: 'termii' },
    africastalking: { username: '', apiKey: null, senderId: '' },
    customSms: { url: '', method: 'POST', contentType: 'json', headerName: 'Authorization', token: null, bodyTemplate: '', successStatus: 200 },
    /* NIN checks through a licensed NIMC verification partner (lib/identity.js): dojah | prembly | custom | '' (off) */
    identity: { provider: '', baseUrl: '', appId: '', apiKey: null, path: '', method: 'GET', headerName: 'Authorization', dataPath: 'data' },
    /* wearable brands' cloud accounts through an aggregator (modules/wearables.js): terra | '' (off) */
    wearables: { provider: '', baseUrl: 'https://api.tryterra.co/v2', devId: '', apiKey: null, webhookSecret: null },
  },
  /* compliance and partnership register (HQ > Compliance). An item with `enforce` on and status not 'done'
   * switches off the features it lists, so a capability cannot go live before its licence is in place. */
  compliance: {
    items: {
      ndpc: { label: 'NDPC registration (data controller of major importance)', status: 'not_started', reference: '', issuedOn: '', expiresOn: '', docUrl: '', owner: '', notes: '', enforce: false, blocksFeatures: [] },
      dpo: { label: 'Data Protection Officer appointed', status: 'not_started', reference: '', issuedOn: '', expiresOn: '', docUrl: '', owner: '', notes: '', enforce: false, blocksFeatures: [] },
      dpia: { label: 'Data protection impact assessment (DPIA)', status: 'not_started', reference: '', issuedOn: '', expiresOn: '', docUrl: '', owner: '', notes: '', enforce: false, blocksFeatures: [] },
      pcn: { label: 'PCN Electronic Pharmacy Aggregator registration', status: 'not_started', reference: '', issuedOn: '', expiresOn: '', docUrl: '', owner: '', notes: 'Needed before marketplace subscribers can order medicines from pharmacies they are not registered with.', enforce: false, blocksFeatures: ['marketplacePharmacy'] },
      nhia: { label: 'NHIA accreditation of each HMO on the platform (checked at HMO onboarding)', status: 'not_started', reference: '', issuedOn: '', expiresOn: '', docUrl: '', owner: '', notes: 'Ask every HMO for its NHIA accreditation before approving it in HQ.', enforce: false, blocksFeatures: [] },
      hefamaa: { label: 'HEFAMAA telemedicine registration (Lagos)', status: 'not_started', reference: '', issuedOn: '', expiresOn: '', docUrl: '', owner: '', notes: '', enforce: false, blocksFeatures: ['videoVisits'] },
      paystackKyc: { label: 'Payment gateway business verification (KYC)', status: 'not_started', reference: '', issuedOn: '', expiresOn: '', docUrl: '', owner: '', notes: '', enforce: false, blocksFeatures: [] },
      smsSender: { label: 'SMS sender ID approval', status: 'not_started', reference: '', issuedOn: '', expiresOn: '', docUrl: '', owner: '', notes: '', enforce: false, blocksFeatures: [] },
      nimc: { label: 'NIN verification partner licensed by NIMC (account, API keys, data processing agreement)', status: 'not_started', reference: '', issuedOn: '', expiresOn: '', docUrl: '', owner: '', notes: 'Until this is in place, NINs are saved as pending and staff confirm them by hand.', enforce: false, blocksFeatures: [] },
      ussdCode: { label: 'USSD short code from an aggregator', status: 'not_started', reference: '', issuedOn: '', expiresOn: '', docUrl: '', owner: '', notes: '', enforce: false, blocksFeatures: ['ussd'] },
    },
    /* agreements with HMOs and other partners: { key: { name, kind, status, contact, email, phone, startsOn, endsOn, terms, docUrl, notes } } */
    partners: {},
  },
};
/* fields holding secrets: encrypted at rest, masked in every API response */
const SECRET_PATHS = ['integrations.whatsapp.appSecret', 'integrations.paystack.secretKey', 'integrations.termii.apiKey', 'integrations.turn.credential', 'integrations.ussd.secret', 'integrations.ai.apiKey', 'integrations.whatsapp.accessToken', 'integrations.whatsapp.verifyToken', 'integrations.email.apiKey',
  'integrations.flutterwave.secretKey', 'integrations.flutterwave.webhookHash', 'integrations.monnify.secretKey',
  'integrations.customPayment.auth.token', 'integrations.customPayment.auth.password', 'integrations.customPayment.auth.clientSecret', 'integrations.customPayment.webhook.secret',
  'integrations.africastalking.apiKey', 'integrations.customSms.token', 'integrations.identity.apiKey', 'integrations.wearables.apiKey', 'integrations.wearables.webhookSecret'];
/* sections a per-provider override may change */
const ORG_OVERRIDABLE = ['features', 'process', 'content'];

const clone = o => JSON.parse(JSON.stringify(o));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, over) { const out = clone(base); if (!isObj(over)) return out; for (const [k, v] of Object.entries(over)) { if (v === undefined) continue; out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : clone(v); } return out; }
function getPath(o, p) { return p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o); }
function setPath(o, p, v) { const ks = p.split('.'); let c = o; for (let i = 0; i < ks.length - 1; i++) { if (!isObj(c[ks[i]])) c[ks[i]] = {}; c = c[ks[i]]; } c[ks[ks.length - 1]] = v; }

/* ---------- secret encryption ---------- */
function key() {
  const src = process.env.SETTINGS_KEY || config.JWT_SECRET;
  return crypto.createHash('sha256').update('medicore-settings:' + src).digest();
}
function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return { enc: 'v1:' + iv.toString('base64') + ':' + c.getAuthTag().toString('base64') + ':' + data.toString('base64'), last4: String(plain).slice(-4) };
}
function decrypt(v) {
  if (!v || !v.enc) return null;
  try { const [, iv, tag, data] = v.enc.split(':'); const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64')); d.setAuthTag(Buffer.from(tag, 'base64')); return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'); }
  catch (e) { console.warn('[settings] could not decrypt a secret (SETTINGS_KEY changed?)'); return null; }
}
function maskSecrets(data) {
  const out = clone(data);
  for (const p of SECRET_PATHS) { const v = getPath(out, p); setPath(out, p, v && v.enc ? { set: true, last4: v.last4 || '' } : { set: false }); }
  return out;
}

/* ---------- load, cache, apply ---------- */
let cache = null; let cachedAt = 0; const TTL = 20000;
const PRISTINE = { ROLES: clone(roles.ROLES), MODULES: clone(roles.MODULES), ORG_TYPES: clone(roles.ORG_TYPES) };

async function readStored() { const d = await db.col('platform_settings').findOne({ id: 'current' }); return d || { id: 'current', version: 0, data: {} }; }

function applyRoles(eff) {
  // rebuild the role, module and provider-type catalogues from the pristine code defaults + settings
  for (const k of Object.keys(roles.ROLES)) delete roles.ROLES[k];
  Object.assign(roles.ROLES, clone(PRISTINE.ROLES));
  for (const [k, o] of Object.entries((eff.roles && eff.roles.overrides) || {})) {
    const r = roles.ROLES[k]; if (!r) continue;
    if (o.label) r.label = o.label; if (typeof o.clock === 'boolean') r.clock = o.clock;
    r.perms = [...new Set(r.perms.concat((o.addPerms || []).filter(p => roles.PERMS[p])))].filter(p => !(o.removePerms || []).includes(p));
  }
  for (const [k, c] of Object.entries((eff.roles && eff.roles.custom) || {})) {
    if (PRISTINE.ROLES[k] || !/^[a-z][a-z0-9_]{2,30}$/.test(k) || !roles.APPS.includes(c.app) || c.app === 'hq' || c.app === 'patient') continue;
    roles.ROLES[k] = { label: c.label || k, app: c.app, module: c.module && roles.MODULES[c.module] ? c.module : null, clock: !!c.clock, perms: (c.perms || []).filter(p => roles.PERMS[p] && (c.app === 'payer' ? (p.startsWith('payer.') || p.startsWith('admin.')) : !p.startsWith('payer.'))), custom: true };
  }
  for (const k of Object.keys(roles.MODULES)) Object.assign(roles.MODULES[k], clone(PRISTINE.MODULES[k]), (eff.catalog.modules || {})[k] ? { label: eff.catalog.modules[k].label || PRISTINE.MODULES[k].label, desc: eff.catalog.modules[k].desc || PRISTINE.MODULES[k].desc } : {});
  for (const k of Object.keys(roles.ORG_TYPES)) {
    const o = (eff.catalog.orgTypes || {})[k] || {};
    const base = clone(PRISTINE.ORG_TYPES[k]);
    if (o.label) base.label = o.label;
    if (Array.isArray(o.modules)) base.modules = o.modules.filter(m => roles.MODULES[m]);
    if (Array.isArray(o.optional)) base.optional = o.optional.filter(m => roles.MODULES[m]);
    roles.ORG_TYPES[k] = base;
  }
}
function applyIntegrations(eff) {
  const i = eff.integrations; const env = process.env;
  const pick = (secretPath, envName) => decrypt(getPath(eff, secretPath)) || env[envName] || '';
  config.PAYSTACK_SECRET = pick('integrations.paystack.secretKey', 'PAYSTACK_SECRET');
  config.PAYSTACK_PUBLIC = i.paystack.publicKey || env.PAYSTACK_PUBLIC || '';
  config.TERMII_KEY = pick('integrations.termii.apiKey', 'TERMII_KEY');
  config.TERMII_SENDER = i.termii.senderId || env.TERMII_SENDER || 'MediCore';
  config.TURN_URL = i.turn.url || env.TURN_URL || ''; config.TURN_USER = i.turn.username || env.TURN_USER || ''; config.TURN_PASS = pick('integrations.turn.credential', 'TURN_PASS');
  config.MAP_TILE_URL = i.maps.tileUrl || env.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  config.MAP_TILE_ATTRIBUTION = i.maps.attribution || env.MAP_TILE_ATTRIBUTION || '&copy; OpenStreetMap contributors';
  config.GEOCODER_URL = i.geocoder.url || env.GEOCODER_URL || ''; config.ROUTING_URL = i.routing.url || env.ROUTING_URL || '';
  config.USSD_SECRET = pick('integrations.ussd.secret', 'USSD_SECRET');
  config.SESSION_HOURS = eff.process.security.sessionHours || config.SESSION_HOURS;
  config.AI = { provider: i.ai.provider, model: i.ai.model, fastModel: i.ai.fastModel, apiKey: pick('integrations.ai.apiKey', 'AI_API_KEY'), baseUrl: i.ai.baseUrl || env.AI_BASE_URL || '', maxTokens: i.ai.maxTokens, monthlyBudgetNgn: i.ai.monthlyBudgetNgn, region: i.ai.region };
  config.WHATSAPP = { phoneNumberId: i.whatsapp.phoneNumberId || env.WHATSAPP_PHONE_NUMBER_ID || '', businessAccountId: i.whatsapp.businessAccountId || '', accessToken: pick('integrations.whatsapp.accessToken', 'WHATSAPP_TOKEN'), verifyToken: pick('integrations.whatsapp.verifyToken', 'WHATSAPP_VERIFY_TOKEN'),
    appSecret: pick('integrations.whatsapp.appSecret', 'WHATSAPP_APP_SECRET'), apiVersion: i.whatsapp.apiVersion || 'v21.0', templates: clone(i.whatsapp.templates || {}), notifyPatients: i.whatsapp.notifyPatients !== false, sendCodes: !!i.whatsapp.sendCodes, inbox: i.whatsapp.inbox !== false,
    autoReply: i.whatsapp.autoReply || '', unknownReply: i.whatsapp.unknownReply || '' };
  config.EMAIL = { provider: i.email.provider || '', apiKey: pick('integrations.email.apiKey', 'EMAIL_API_KEY'), from: i.email.from || env.EMAIL_FROM || '', fromName: i.email.fromName || 'MediCore', mailgunDomain: i.email.mailgunDomain || '', mailgunRegion: i.email.mailgunRegion || 'us' };
  // payment gateways (lib/payments.js) and SMS gateways (lib/sms.js) read these
  const sec = p => decrypt(getPath(eff, p)) || '';
  config.PAYMENTS = {
    provider: i.payments.provider || 'paystack', label: i.payments.label || '', settleToProviders: i.payments.settleToProviders !== false,
    flutterwave: { publicKey: i.flutterwave.publicKey || env.FLW_PUBLIC || '', secretKey: sec('integrations.flutterwave.secretKey') || env.FLW_SECRET || '', webhookHash: sec('integrations.flutterwave.webhookHash') || env.FLW_HASH || '' },
    monnify: { apiKey: i.monnify.apiKey || env.MONNIFY_KEY || '', secretKey: sec('integrations.monnify.secretKey') || env.MONNIFY_SECRET || '', contractCode: i.monnify.contractCode || env.MONNIFY_CONTRACT || '', baseUrl: i.monnify.baseUrl || 'https://api.monnify.com' },
    custom: (() => { const c = clone(i.customPayment); c.auth.token = sec('integrations.customPayment.auth.token'); c.auth.password = sec('integrations.customPayment.auth.password'); c.auth.clientSecret = sec('integrations.customPayment.auth.clientSecret'); c.webhook.secret = sec('integrations.customPayment.webhook.secret'); return c; })(),
  };
  config.IDENTITY = { provider: i.identity.provider || env.NIN_PROVIDER || '', baseUrl: i.identity.baseUrl || env.NIN_BASE_URL || '', appId: i.identity.appId || env.NIN_APP_ID || '', apiKey: sec('integrations.identity.apiKey') || env.NIN_API_KEY || '',
    path: i.identity.path || '', method: i.identity.method || 'GET', headerName: i.identity.headerName || 'Authorization', dataPath: i.identity.dataPath || 'data' };
  config.SMS = {
    provider: i.sms.provider || 'termii',
    africastalking: { username: i.africastalking.username || env.AT_USERNAME || '', apiKey: sec('integrations.africastalking.apiKey') || env.AT_API_KEY || '', senderId: i.africastalking.senderId || '' },
    custom: Object.assign(clone(i.customSms), { token: sec('integrations.customSms.token') }),
  };
}

/** load (cached for 20 s per server instance) and apply. Call once per request; cheap when cached. */
async function load(force) {
  if (!force && cache && Date.now() - cachedAt < TTL) return cache;
  const stored = await readStored();
  const eff = merge(DEFAULTS, stored.data || {});
  cache = { version: stored.version || 0, data: eff, updatedAt: stored.updatedAt || null };
  cachedAt = Date.now();
  applyRoles(eff); applyIntegrations(eff);
  return cache;
}
function invalidate() { cache = null; cachedAt = 0; }
/** effective setting, optionally for one provider (applies org.overrides) */
function get(path, fallback, org) {
  const base = cache ? cache.data : DEFAULTS;
  let v = getPath(base, path);
  if (org && org.overrides && ORG_OVERRIDABLE.includes(path.split('.')[0])) { const ov = getPath(org.overrides, path); if (ov !== undefined) v = ov; }
  return v === undefined ? fallback : v;
}
/** a compliance item with enforce on and not done switches off the features it lists */
function blockedByCompliance(name) {
  const items = get('compliance.items', {}) || {};
  for (const it of Object.values(items)) if (it && it.enforce && it.status !== 'done' && Array.isArray(it.blocksFeatures) && it.blocksFeatures.includes(name)) return true;
  return false;
}
const feature = (name, org) => !!get('features.' + name, false, org) && !blockedByCompliance(name);
const effective = org => { const base = cache ? cache.data : DEFAULTS; if (!org || !org.overrides) return base; const out = clone(base); for (const s of ORG_OVERRIDABLE) if (org.overrides[s]) out[s] = merge(out[s], org.overrides[s]); return out; };

/* ---------- writes (HQ) ---------- */
function diffPaths(a, b, prefix = '', out = []) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) { const p = prefix ? prefix + '.' + k : k; const av = a ? a[k] : undefined, bv = b ? b[k] : undefined; if ((isObj(av) || av === undefined) && (isObj(bv) || bv === undefined) && (isObj(av) || isObj(bv))) diffPaths(av || {}, bv || {}, p, out); else if (JSON.stringify(a ? a[k] : undefined) !== JSON.stringify(b ? b[k] : undefined)) out.push(p); }
  return out;
}
/**
 * save a section patch. `patch` is a partial object for `section`; secrets arrive as plain strings
 * (empty string clears) and are encrypted here. Uses optimistic locking on version.
 */
async function saveSection(section, patch, { by, expectVersion, note }) {
  const stored = await readStored();
  if (expectVersion != null && stored.version !== expectVersion) { const e = new Error('Settings were changed by someone else. Reload and try again.'); e.status = 409; throw e; }
  const data = clone(stored.data || {});
  const next = merge(data[section] || {}, patch);
  for (const sp of SECRET_PATHS) {
    if (!sp.startsWith(section + '.')) continue;
    const rel = sp.slice(section.length + 1);
    const incoming = getPath(patch, rel);
    if (incoming === undefined || (isObj(incoming) && 'set' in incoming)) { setPath(next, rel, getPath(data[section] || {}, rel) || null); continue; }
    setPath(next, rel, typeof incoming === 'string' && incoming.trim() ? encrypt(incoming.trim()) : null);
  }
  const before = clone(data[section] || {});
  data[section] = next;
  const version = (stored.version || 0) + 1;
  const changed = diffPaths(before, next).map(p => section + '.' + p);
  const r = await db.col('platform_settings').findOneAndUpdate({ id: 'current', version: stored.version || 0 }, { $set: { data, version, updatedAt: Date.now(), updatedBy: by }, $setOnInsert: { id: 'current' } }, { upsert: !stored.version });
  if (!r) { const e = new Error('Settings were changed by someone else. Reload and try again.'); e.status = 409; throw e; }
  await db.col('platform_settings_history').insertOne({ id: 'psv_' + version + '_' + crypto.randomBytes(4).toString('hex'), version, at: Date.now(), by, section, changed, note: note || null, data });
  invalidate(); await load(true);
  return { version, changed };
}
async function restore(version, by) {
  const h = await db.col('platform_settings_history').findOne({ version });
  if (!h) { const e = new Error('Version not found'); e.status = 404; throw e; }
  const stored = await readStored();
  const nv = (stored.version || 0) + 1;
  await db.col('platform_settings').findOneAndUpdate({ id: 'current' }, { $set: { data: h.data, version: nv, updatedAt: Date.now(), updatedBy: by }, $setOnInsert: { id: 'current' } }, { upsert: true });
  await db.col('platform_settings_history').insertOne({ id: 'psv_' + nv + '_' + crypto.randomBytes(4).toString('hex'), version: nv, at: Date.now(), by, section: '*', changed: ['restored version ' + version], data: h.data });
  invalidate(); await load(true);
  return { version: nv };
}

/** what a browser may see for one app (no secrets, no other apps' private bits) */
function publicConfig(app, org) {
  const eff = effective(org);
  return {
    version: cache ? cache.version : 0,
    branding: { productName: eff.branding.productName, supportEmail: eff.branding.supportEmail, supportPhone: eff.branding.supportPhone, supportWhatsapp: eff.branding.supportWhatsapp || '', salesPhone: eff.branding.salesPhone || '', salesWhatsapp: eff.branding.salesWhatsapp || '', logoUrl: eff.branding.logoUrl, defaultTheme: eff.branding.defaultTheme, app: eff.branding.apps[app] || {} },
    content: Object.assign({}, eff.content.global, eff.content.apps[app] || {}, { i18n: eff.content.i18n || {} }),
    features: Object.fromEntries(Object.entries(eff.features).map(([k, v]) => [k, typeof v === 'boolean' ? v && !blockedByCompliance(k) : v])),
    process: { appointments: eff.process.appointments, pharmacy: eff.process.pharmacy, lab: eff.process.lab, delivery: eff.process.delivery, emergency: { locationFreshSeconds: eff.process.emergency.locationFreshSeconds }, billing: { showBankChargeToPatient: eff.process.billing.showBankChargeToPatient, bankChargeKobo: eff.process.billing.bankChargeKobo } },
    payments: { provider: eff.integrations.payments.provider, label: eff.integrations.payments.label || '', paystackPublicKey: eff.integrations.paystack.publicKey || process.env.PAYSTACK_PUBLIC || '' },
    referrals: { requirePatientConsent: (eff.process.referrals || {}).requirePatientConsent !== false, requireConnection: !!(eff.process.referrals || {}).requireConnection },
    patients: { mode: (eff.process.patients || {}).mode || 'provider', allowMultipleProviders: (eff.process.patients || {}).allowMultipleProviders !== false, crossProviderSharing: !!(eff.process.patients || {}).crossProviderSharing },
    marketplace: (() => { const m = eff.process.marketplace || {}; return { monthlyKobo: m.monthlyKobo, quarterlyKobo: m.quarterlyKobo, annualKobo: m.annualKobo, freeTrialDays: m.freeTrialDays || 0, hmoMembersSeeNetwork: m.hmoMembersSeeNetwork !== false, defaultRadiusKm: m.defaultRadiusKm || 15, showTeaser: m.showTeaser !== false }; })(),
    careShare: { requirePatientConsent: (eff.process.careShare || {}).requirePatientConsent !== false, allowCodeConsent: (eff.process.careShare || {}).allowCodeConsent !== false, defaultDays: (eff.process.careShare || {}).defaultDays || 180 },
    documents: { maxFileMb: (eff.process.documents || {}).maxFileMb || 3, maxFilesPerDocument: (eff.process.documents || {}).maxFilesPerDocument || 10, patientUploads: (eff.process.documents || {}).patientUploads !== false },
  };
}

module.exports = { DEFAULTS, SECRET_PATHS, ORG_OVERRIDABLE, load, invalidate, get, feature, blockedByCompliance, effective, saveSection, restore, publicConfig, maskSecrets, merge, encrypt, decrypt, diffPaths };
