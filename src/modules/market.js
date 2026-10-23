'use strict';
/*
 * The collaborative marketplace, patient side.
 *
 * In provider mode a patient sees only the providers they belong to. The marketplace opens the rest:
 *   - Subscribers (monthly, quarterly or yearly fee set in HQ, paid to MediCore) see every listed hospital, clinic,
 *     pharmacy, lab and ambulance service on a map with filters, their services and prices, doctors and specialists,
 *     what is in stock, and can book, send prescriptions, request tests and join any of them. The first time they use
 *     a provider they are registered there (no waiting for approval, unless the provider wants to approve).
 *   - HMO members see their HMO's provider network free of charge (the HMO pays for the network).
 *   - Everyone, with or without an account, sees emergency-capable hospitals near them (public facilities included):
 *     /api/emergency/facilities in facilities.js.
 *
 * Providers choose whether they are listed (settings.marketplace), whether marketplace patients are registered at once
 * (settings.marketplaceAutoRegister), and whether patients see stock and prices (showInventoryToPatients,
 * showPricesToPatients). Ordering medicines from a pharmacy through the marketplace has its own switch
 * (features.marketplacePharmacy), tied to the PCN e-pharmacy aggregator registration in the compliance register.
 */
const express = require('express');
const db = require('../db');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param } = require('../lib/http');
const A = require('../lib/auth');
const S = require('../lib/settings');
const RL = require('../lib/ratelimit');
const { id, now, haversineKm } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const orgs = require('./orgs');
const billing = require('./billing');

db.index('market_subs', ['patientId', 'status']);
db.index('market_subs', ['status', 'endsAt']);

const router = express.Router();
const PLANS = { monthly: { months: 1, key: 'monthlyKobo' }, quarterly: { months: 3, key: 'quarterlyKobo' }, annual: { months: 12, key: 'annualKobo' } };
const TYPES = ['hospital', 'clinic', 'pharmacy', 'lab', 'ambulance', 'other'];
const featureOn = () => S.feature('marketplace');
const addMonths = (ts, n) => { const d = new Date(ts); d.setUTCMonth(d.getUTCMonth() + n); return d.getTime(); };

/* ---------------- access ---------------- */
async function activeSub(patientId) {
  const s = await db.col('market_subs').findOne({ patientId, status: 'active', endsAt: { $gt: now() } }, { sort: { endsAt: -1 } });
  return s || null;
}
/** what a patient may see on the marketplace: everything (subscriber), their HMO's network, or nothing */
async function accessOf(patientId) {
  if (!featureOn()) return { on: false, full: false, sub: null, networkOrgIds: [] };
  const sub = await activeSub(patientId);
  let networkOrgIds = [];
  if (S.get('process.marketplace.hmoMembersSeeNetwork', true) !== false) { try { networkOrgIds = await require('./hmoplus').networkOrgIdsForPatient(patientId); } catch (e) { networkOrgIds = []; } }
  return { on: true, full: !!sub, sub, networkOrgIds };
}
const listed = o => !!o && o.status === 'active' && o.type !== 'hmo' && (o.settings || {}).marketplace !== false;
/** used by patients.patientCanUse: may this patient book, order from or join this org through the marketplace? */
async function canUseViaMarket(patientId, org) {
  if (!listed(org)) return false;
  const a = await accessOf(patientId);
  if (!a.on) return false;
  return a.full || a.networkOrgIds.includes(org.id);
}
/** may a marketplace patient order medicines from this pharmacy? (PCN switch) */
const pharmacyOrdersAllowed = () => S.feature('marketplacePharmacy');
/** a provider registers marketplace patients at once unless it asked to approve them */
const autoRegister = org => (org.settings || {}).marketplaceAutoRegister !== false && S.get('process.marketplace.autoRegisterOnUse', true) !== false;

function subView(s) { return s ? { id: s.id, plan: s.plan, status: s.status, startsAt: s.startsAt || null, endsAt: s.endsAt || null, paidKobo: s.amountKobo, billId: s.status === 'pending' ? s.billId : null, createdAt: s.createdAt } : null; }
function prices() {
  const m = S.get('process.marketplace', {}) || {};
  return Object.fromEntries(Object.entries(PLANS).filter(([k, p]) => (m[p.key] || 0) > 0).map(([k, p]) => [k, { months: p.months, amountKobo: m[p.key] }]));
}

/* ---------------- subscription ---------------- */
router.get('/market/status', A.requirePatient, ah(async (req, res) => {
  const a = await accessOf(req.ctx.patient.id);
  const pending = await db.col('market_subs').findOne({ patientId: req.ctx.patient.id, status: 'pending' }, { sort: { createdAt: -1 } });
  const history = await db.col('market_subs').find({ patientId: req.ctx.patient.id, status: { $in: ['active', 'expired'] } }, { sort: { createdAt: -1 }, limit: 12 });
  res.json({ on: a.on, full: a.full, subscription: subView(a.sub), pending: subView(pending), hmoNetworkProviders: a.networkOrgIds.length, prices: prices(), bankChargeKobo: S.get('process.billing.bankChargeKobo', 220000), showBankCharge: !!S.get('process.billing.showBankChargeToPatient', false),
    pharmacyOrders: pharmacyOrdersAllowed(), history: history.map(subView) });
}));
router.post('/market/subscribe', A.requirePatient, ah(async (req, res) => {
  if (!featureOn()) throw forbidden('The marketplace is switched off');
  const b = body(req, { plan: t.enum(Object.keys(PLANS), { required: true }), consent: t.bool({ required: true }) });
  if (!b.consent) throw bad('Please agree that providers you use through the marketplace will register you and see your details');
  const pr = prices()[b.plan]; if (!pr) throw bad('That plan is not offered');
  const pid = req.ctx.patient.id;
  const open = await db.col('market_subs').findOne({ patientId: pid, status: 'pending' });
  if (open) { const bill = await db.col('bills').findOne({ id: open.billId }); if (bill && bill.status === 'open' && open.plan === b.plan) return res.json({ subscription: subView(open), billId: bill.id, amountKobo: bill.patientDueKobo - bill.paidKobo, resumed: true }); await db.col('market_subs').updateOne({ id: open.id, status: 'pending' }, { $set: { status: 'cancelled', cancelledAt: now() } }); if (bill && bill.status === 'open') await billing.voidBill(bill.id, { orgId: 'platform', reason: 'Replaced by another plan', by: req.ctx.user.id }); }
  await RL.limit('msub_' + pid, 10, 86400);
  const s = { id: id('msb'), patientId: pid, plan: b.plan, months: pr.months, amountKobo: pr.amountKobo, status: 'pending', createdAt: now(), consentAt: now() };
  const bill = await billing.createBill({ orgId: 'platform', patientId: pid, lines: [{ code: 'MARKET-' + b.plan.toUpperCase(), name: 'Marketplace access (' + pr.months + (pr.months === 1 ? ' month' : ' months') + ')', category: 'other', qty: 1, unitPriceKobo: pr.amountKobo }], source: { type: 'market_sub', id: s.id }, createdBy: req.ctx.user.id });
  s.billId = bill.id;
  await db.col('market_subs').insertOne(s);
  await audit(req, 'market.subscribe', { type: 'market_sub', id: s.id, patientId: pid, orgId: null }, { plan: b.plan, amountKobo: pr.amountKobo });
  res.json({ subscription: subView(s), billId: bill.id, amountKobo: bill.totalKobo });
}));
/* the payment is confirmed: start (or extend) the subscription, exactly once */
billing.onSettled('market_sub', async (bill) => {
  const s = await db.col('market_subs').findOneAndUpdate({ id: bill.source.id, status: 'pending' }, { $set: { status: 'activating' } });
  if (!s) return;
  const cur = await activeSub(s.patientId);
  const start = cur ? cur.endsAt : now();
  await db.col('market_subs').updateOne({ id: s.id }, { $set: { status: 'active', startsAt: start, endsAt: addMonths(start, s.months), paidAt: now() } });
  await notify({ patientId: s.patientId, title: 'Marketplace access active', body: 'You can now find and use hospitals, clinics, pharmacies and labs on MediCore until ' + new Date(addMonths(start, s.months) + 3600e3).toISOString().slice(0, 10) + '.', kind: 'market' });
  try { await require('../lib/events').emit('market.subscribed', { subscriptionId: s.id, plan: s.plan, amountKobo: s.amountKobo }); } catch (e) { /* best effort */ }
});
router.post('/market/cancel-pending', A.requirePatient, ah(async (req, res) => {
  const s = await db.col('market_subs').findOneAndUpdate({ patientId: req.ctx.patient.id, status: 'pending' }, { $set: { status: 'cancelled', cancelledAt: now() } });
  if (s && s.billId) await billing.voidBill(s.billId, { orgId: 'platform', reason: 'Cancelled by patient', by: req.ctx.user.id });
  res.json({ ok: true });
}));

/* ---------------- search and map ---------------- */
async function doctorSummary(orgId) {
  const scheds = await db.col('schedules').find({ orgId, acceptingBookings: true }, { limit: 200 });
  const specs = {}; for (const s of scheds) { const k = s.specialty || 'General practice'; specs[k] = (specs[k] || 0) + 1; }
  return { doctors: scheds.length, specialties: Object.keys(specs).sort(), video: scheds.some(s => (s.types || []).includes('video')) };
}
async function marketCard(o, from, access, extra) {
  const inv = require('./inventory');
  const cap = (o.modules || []).includes('clinic') || ['hospital', 'clinic'].includes(o.type) ? await inv.capacityOf(o.id) : null;
  const ds = (o.modules || []).includes('clinic') ? await doctorSummary(o.id) : { doctors: 0, specialties: [], video: false };
  const v = Object.assign(orgs.publicOrg(o, from), {
    verified: !!(o.kyc && (o.kyc.verifiedAt || o.kyc.licenceNumber)), about: ((o.settings || {}).marketProfile || {}).about || null,
    services: (o.modules || []).filter(m => ['clinic', 'pharmacy', 'lab', 'ambulance', 'delivery', 'chw'].includes(m)),
    doctors: ds.doctors, specialties: ds.specialties, video: ds.video,
    takingEmergencies: cap && cap.acceptingEmergencies != null && !cap.stale ? cap.acceptingEmergencies : null, freeBeds: cap && !cap.stale ? cap.freeBeds : null,
    viaHmo: !access.full && access.networkOrgIds.includes(o.id),
  });
  return Object.assign(v, extra || {});
}
async function linkedOrgIds(patientId) { return (await db.col('patient_links').find({ patientId, status: { $ne: 'removed' } }, { projection: { orgId: 1 } })).map(l => l.orgId); }

router.get('/market/providers', A.requirePatient, ah(async (req, res) => {
  const q = query(req, { lat: t.lat(), lng: t.lng(), radiusKm: t.num({ min: 1, max: 500 }), type: t.enum(TYPES), q: t.str({ max: 60 }), specialty: t.str({ max: 80 }), drug: t.str({ max: 60 }), test: t.str({ max: 60 }),
    service: t.enum(['clinic', 'pharmacy', 'lab', 'ambulance', 'delivery', 'video']), emergency: t.bool(), hmo: t.bool(), limit: t.int({ min: 1, max: 200 }) });
  const a = await accessOf(req.ctx.patient.id);
  if (!a.on) throw forbidden('The marketplace is switched off');
  const from = q.lat != null && q.lng != null ? { lat: q.lat, lng: q.lng } : (req.ctx.patient.homeLoc || null);
  const f = { status: 'active', type: q.type ? q.type : { $ne: 'hmo' }, 'settings.marketplace': { $ne: false } };
  let rows = await db.col('orgs').find(f, { limit: 3000 });
  // without a subscription: only the HMO network (or a teaser count)
  if (!a.full) {
    if (!a.networkOrgIds.length) {
      const near = from ? rows.filter(o => o.location && haversineKm(from, o.location) <= (q.radiusKm || 15)).length : rows.length;
      return res.json({ access: 'none', teaser: S.get('process.marketplace.showTeaser', true) !== false ? { nearby: near, types: TYPES.map(tp => ({ type: tp, count: rows.filter(o => o.type === tp).length })).filter(x => x.count) } : null, providers: [] });
    }
    rows = rows.filter(o => a.networkOrgIds.includes(o.id));
  }
  if (q.hmo && a.networkOrgIds.length) rows = rows.filter(o => a.networkOrgIds.includes(o.id));
  if (q.service) rows = rows.filter(o => (q.service === 'video' ? (o.modules || []).includes('clinic') : (o.modules || []).includes(q.service)));
  if (q.q) { const s = q.q.toLowerCase(); rows = rows.filter(o => o.name.toLowerCase().includes(s) || ((o.location || {}).area || '').toLowerCase().includes(s) || ((o.location || {}).city || '').toLowerCase().includes(s)); }
  if (from && q.radiusKm) rows = rows.filter(o => o.location && haversineKm(from, o.location) <= q.radiusKm);
  const linked = await linkedOrgIds(req.ctx.patient.id);
  const inv = require('./inventory');
  let out = [];
  for (const o of rows) {
    const extra = { yours: linked.includes(o.id) };
    if (q.drug) {
      if (!(o.modules || []).includes('pharmacy')) continue;
      const hits = await inv.publicPharmacyStock(o, q.drug, 5);
      if (!hits.length) continue;
      extra.drugMatches = hits;
    }
    if (q.test) {
      if (!(o.modules || []).includes('lab')) continue;
      const tests = await require('./lab').publicTests(o.id);
      const s = q.test.toLowerCase();
      const hit = tests.filter(x => String(x.name || '').toLowerCase().includes(s) || String(x.code || '').toLowerCase() === s).slice(0, 5);
      if (!hit.length) continue;
      extra.testMatches = hit.map(x => ({ code: x.code, name: x.name, priceKobo: (o.settings || {}).showPricesToPatients !== false ? x.priceKobo : null, tatHours: x.tatHours || null }));
    }
    const card = await marketCard(o, from, a, extra);
    if (q.specialty && !card.specialties.some(s => s.toLowerCase().includes(q.specialty.toLowerCase()))) continue;
    if (q.service === 'video' && !card.video) continue;
    if (q.emergency && card.takingEmergencies !== true) continue;
    out.push(card);
  }
  out.sort((x, y) => (from ? (x.distanceKm ?? 1e9) - (y.distanceKm ?? 1e9) : x.name.localeCompare(y.name)));
  res.json({ access: a.full ? 'full' : 'hmo', providers: out.slice(0, q.limit || 100) });
}));

/** one provider's marketplace page: services and prices, doctors, tests, stock, capacity, HMOs, partners */
router.get('/market/providers/:id', A.requirePatient, ah(async (req, res) => {
  const o = await db.col('orgs').findOne({ id: param(req, 'id') });
  const linked = o ? await require('./patients').linkOf(o.id, req.ctx.patient.id) : null;
  const a = await accessOf(req.ctx.patient.id);
  if (!o || !listed(o) || (!linked && !a.full && !a.networkOrgIds.includes(o.id))) throw notFound('Provider not found');
  const q = query(req, { lat: t.lat(), lng: t.lng() });
  const from = q.lat != null ? { lat: q.lat, lng: q.lng } : (req.ctx.patient.homeLoc || null);
  const showPrices = (o.settings || {}).showPricesToPatients !== false;
  const inv = require('./inventory');
  const services = (await db.col('services').find({ orgId: o.id, active: { $ne: false }, public: { $ne: false } }, { sort: { category: 1, name: 1 }, limit: 300 })).map(s => ({ code: s.code, name: s.name, category: s.category, priceKobo: showPrices ? s.priceKobo : null }));
  const doctors = [];
  if ((o.modules || []).includes('clinic')) {
    for (const s of await db.col('schedules').find({ orgId: o.id, acceptingBookings: true }, { limit: 100 })) {
      const m = await db.col('memberships').findOne({ id: s.membershipId, orgId: o.id, status: 'active' }); if (!m) continue;
      const u = await db.col('users').findOne({ id: m.userId }, { projection: { name: 1 } });
      doctors.push({ membershipId: m.id, name: u ? u.name : 'Doctor', specialty: s.specialty || null, languages: s.languages || [], video: (s.types || []).includes('video') });
    }
  }
  const tests = (o.modules || []).includes('lab') ? (await require('./lab').publicTests(o.id)).map(x => Object.assign(x, { priceKobo: showPrices ? x.priceKobo : null })) : [];
  const prof = (o.settings || {}).marketProfile || {};
  const conns = await db.col('network_connections').find({ status: 'accepted', $or: [{ fromOrgId: o.id }, { toOrgId: o.id }] }, { limit: 50 });
  const partnerIds = conns.map(c => (c.fromOrgId === o.id ? c.toOrgId : c.fromOrgId));
  const partners = partnerIds.length ? (await db.col('orgs').find({ id: { $in: partnerIds }, status: 'active' }, { projection: { name: 1, type: 1 } })).map(p => ({ id: p.id, name: p.name, type: p.type })) : [];
  const card = await marketCard(o, from, a, { yours: !!linked, mrn: linked ? linked.mrn : null });
  await audit(req, 'market.view', { type: 'org', id: o.id, patientId: req.ctx.patient.id, orgId: o.id });
  res.json(Object.assign(card, {
    address: (o.contact || {}).address || null, email: (o.contact || {}).email || null, whatsapp: (o.contact || {}).whatsapp || null,
    facilities: prof.facilities || [], languages: prof.languages || [], hours: (o.settings || {}).openingHours || null, acceptsOnlineBooking: (o.settings || {}).acceptsOnlineBooking !== false,
    services, doctors, tests, storeItems: await inv.publicStoreItems(o), capacity: (await inv.capacityOf(o.id)), hmos: await require('./hmoplus').hmosAccepted(o.id), partners,
    canUse: !!linked || a.full || a.networkOrgIds.includes(o.id), autoRegister: autoRegister(o), pharmacyOrders: pharmacyOrdersAllowed(), showPrices,
  }));
}));
router.get('/market/providers/:id/stock', A.requirePatient, ah(async (req, res) => {
  const q = query(req, { q: t.str({ max: 60 }) });
  const o = await db.col('orgs').findOne({ id: param(req, 'id') });
  const linked = o ? await require('./patients').linkOf(o.id, req.ctx.patient.id) : null;
  const a = await accessOf(req.ctx.patient.id);
  if (!o || !listed(o) || (!linked && !a.full && !a.networkOrgIds.includes(o.id))) throw notFound('Provider not found');
  await RL.limit('mstock_' + req.ctx.patient.id, 300, 3600);
  res.json(await require('./inventory').publicPharmacyStock(o, q.q, 80));
}));
/** register with a provider found on the marketplace (registered at once unless the provider approves joiners) */
router.post('/market/providers/:id/join', A.requirePatient, ah(async (req, res) => {
  const o = await db.col('orgs').findOne({ id: param(req, 'id') });
  if (!o || !(await canUseViaMarket(req.ctx.patient.id, o))) throw notFound('Provider not found');
  const P = require('./patients');
  if (await P.linkOf(o.id, req.ctx.patient.id)) throw conflict('You are already registered with ' + o.name, 'already_linked');
  if (autoRegister(o)) {
    const l = await P.ensureLink(o.id, req.ctx.patient.id, req.ctx.user.id, 'marketplace');
    await audit(req, 'market.join', { type: 'link', id: l.id, patientId: req.ctx.patient.id, orgId: o.id });
    for (const role of ['receptionist', 'records', 'frontdesk_manager']) await notify({ orgId: o.id, role, title: 'New patient from the marketplace', body: 'A patient registered with you through the MediCore marketplace.', kind: 'market_join', ref: { type: 'patient', id: req.ctx.patient.id } });
    return res.json({ ok: true, approved: true, mrn: l.mrn, orgId: o.id });
  }
  const r = await P.applyToOrg(req, o, 'Joined from the marketplace');
  res.json(r);
}));

/* ---------------- provider side: marketplace profile ---------------- */
router.get('/admin/market-profile', A.requireStaff({ anyPerm: ['admin.settings', 'network.manage'] }), ah(async (req, res) => {
  const o = req.ctx.org; const s = o.settings || {};
  const visitors = await db.col('audit').count({ orgId: o.id, action: 'market.view', at: { $gt: now() - 30 * 86400e3 } });
  const joins = await db.col('patient_links').count({ orgId: o.id, via: 'marketplace', createdAt: { $gt: now() - 30 * 86400e3 } });
  res.json({ listed: s.marketplace !== false, autoRegister: s.marketplaceAutoRegister !== false, showInventory: s.showInventoryToPatients !== false, showPrices: s.showPricesToPatients !== false, profile: s.marketProfile || { about: '', facilities: [], languages: [] },
    stats: { views30d: visitors, joins30d: joins }, marketplaceOn: featureOn(), hasLocation: !!(o.location && o.location.lat != null) });
}));
router.patch('/admin/market-profile', A.requireStaff({ perm: 'admin.settings' }), ah(async (req, res) => {
  const b = body(req, { listed: t.bool(), autoRegister: t.bool(), showInventory: t.bool(), showPrices: t.bool(), about: t.text({ max: 800 }), facilities: t.arr(t.str({ max: 60, plain: true }), { max: 20 }), languages: t.arr(t.str({ max: 30, plain: true }), { max: 10 }), location: t.obj({ lat: t.lat({ required: true }), lng: t.lng({ required: true }), area: t.str({ max: 80, plain: true }), city: t.str({ max: 80, plain: true }), state: t.str({ max: 80, plain: true }) }) });
  const set = {};
  if (b.listed !== undefined) set['settings.marketplace'] = b.listed;
  if (b.autoRegister !== undefined) set['settings.marketplaceAutoRegister'] = b.autoRegister;
  if (b.showInventory !== undefined) set['settings.showInventoryToPatients'] = b.showInventory;
  if (b.showPrices !== undefined) set['settings.showPricesToPatients'] = b.showPrices;
  if (b.about !== undefined) set['settings.marketProfile.about'] = b.about;
  if (b.facilities !== undefined) set['settings.marketProfile.facilities'] = b.facilities;
  if (b.languages !== undefined) set['settings.marketProfile.languages'] = b.languages;
  if (b.location) set.location = Object.assign({}, req.ctx.org.location || {}, b.location);
  if (!Object.keys(set).length) throw bad('Nothing to change');
  await db.col('orgs').updateOne({ id: req.ctx.org.id }, { $set: set });
  await audit(req, 'market.profile_update', { type: 'org', id: req.ctx.org.id }, { fields: Object.keys(b) });
  req.ctx.org = await db.col('orgs').findOne({ id: req.ctx.org.id });
  const o = req.ctx.org; const s = o.settings || {};
  res.json({ listed: s.marketplace !== false, autoRegister: s.marketplaceAutoRegister !== false, showInventory: s.showInventoryToPatients !== false, showPrices: s.showPricesToPatients !== false, profile: s.marketProfile || {}, hasLocation: !!(o.location && o.location.lat != null) });
}));

/* ---------------- HQ: marketplace figures ---------------- */
router.get('/hq/market', A.requirePlatform('platform.read'), ah(async (req, res) => {
  const active = await db.col('market_subs').find({ status: 'active', endsAt: { $gt: now() } }, { limit: 100000 });
  const paid = await db.col('market_subs').find({ status: { $in: ['active', 'expired'] }, paidAt: { $gt: now() - 30 * 86400e3 } }, { limit: 100000 });
  const byPlan = {}; active.forEach(s => { byPlan[s.plan] = (byPlan[s.plan] || 0) + 1; });
  res.json({ activeSubscribers: new Set(active.map(s => s.patientId)).size, byPlan, revenue30dKobo: paid.reduce((s2, x) => s2 + (x.amountKobo || 0), 0), listedProviders: await db.col('orgs').count({ status: 'active', type: { $ne: 'hmo' }, 'settings.marketplace': { $ne: false } }),
    joins30d: await db.col('patient_links').count({ via: 'marketplace', createdAt: { $gt: now() - 30 * 86400e3 } }), prices: prices() });
}));

/* ================= demo ================= */
async function seedDemo(ctx) {
  // Ngozi subscribes for a quarter so the demo marketplace is open for her
  const ngozi = ctx.patients && ctx.patients.ngozi; if (!ngozi) return;
  await db.col('market_subs').insertOne({ id: id('msb'), patientId: ngozi.id, plan: 'quarterly', months: 3, amountKobo: S.get('process.marketplace.quarterlyKobo', 400000), status: 'active', startsAt: now() - 10 * 86400e3, endsAt: addMonths(now() - 10 * 86400e3, 3), paidAt: now() - 10 * 86400e3, createdAt: now() - 10 * 86400e3, consentAt: now() - 10 * 86400e3, demo: true });
  const profiles = {
    hospital: { about: 'A 120-bed general hospital with a 24-hour emergency unit, maternity, theatre and an ICU.', facilities: ['24-hour emergency', 'ICU', 'Theatre', 'Maternity', 'Parking', 'Wheelchair access', 'Blood bank'], languages: ['English', 'Yoruba', 'Igbo', 'Pidgin'] },
    clinic: { about: 'Family clinic for children and adults, open six days a week.', facilities: ['Children\'s corner', 'Wheelchair access'], languages: ['English', 'Yoruba'] },
    pharmacy: { about: 'Community pharmacy with home delivery across Yaba and Surulere.', facilities: ['Home delivery', 'Blood pressure checks'], languages: ['English', 'Pidgin', 'Yoruba'] },
    lab: { about: 'Diagnostic lab with home sample collection and results in the app.', facilities: ['Home sample collection', 'Weekend opening'], languages: ['English', 'Hausa'] },
  };
  for (const [k, p] of Object.entries(profiles)) if (ctx.orgs[k]) await db.col('orgs').updateOne({ id: ctx.orgs[k].id }, { $set: { 'settings.marketProfile': p, 'settings.showInventoryToPatients': true, 'settings.showPricesToPatients': true } });
}

module.exports = { name: 'market', router, seedDemoAfter: seedDemo, accessOf, canUseViaMarket, pharmacyOrdersAllowed, autoRegister, listed, activeSub };
