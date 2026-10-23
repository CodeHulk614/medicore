'use strict';
/*
 * Health devices and wearables. MediCore is a set of web apps, and a browser cannot read Apple Health or Android
 * Health Connect, so readings arrive through four doors:
 *   1. the phone's health app, through the MediCore companion app (Android: Health Connect; iPhone: Apple Health).
 *      The companion app posts batches to POST /api/me/wearables/sync with the patient's session.
 *   2. cloud accounts of wearable brands (Fitbit, Garmin, Withings, Oura, Polar, Huawei and others) through an
 *      aggregator (Terra by default, keyed in HQ > Integrations). The patient connects once; data arrives by webhook.
 *   3. Bluetooth devices straight from the browser where Web Bluetooth works (Chrome on Android): heart-rate straps.
 *   4. readings typed in by the patient (blood pressure cuff, glucose meter, thermometer, scale).
 * A provider the patient is registered with can ask for a fresh reading (for example during a video visit). The
 * patient takes it on the device, syncs, and chooses to share with that provider. Readings are summarised in plain
 * words (the AI assistant when it is on, rules otherwise) for the patient, and in clinical terms for the provider.
 * Wearables are consumer devices, not medical devices: every summary says so.
 */
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param } = require('../lib/http');
const A = require('../lib/auth');
const S = require('../lib/settings');
const RL = require('../lib/ratelimit');
const { id, now } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const P = require('./patients');

db.index('wearable_readings', ['patientId', 'type', 'at']);
db.index('wearable_readings', ['patientId', 'at']);
db.index('wearable_links', ['patientId', 'source'], { unique: true });
db.index('wearable_links', ['externalUserId']);
db.index('reading_requests', ['patientId', 'status', 'createdAt']);
db.index('reading_requests', ['orgId', 'patientId', 'createdAt']);

const router = express.Router();
const on = (req, res, next) => (S.feature('wearables') ? next() : next(forbidden('Health devices are switched off on MediCore')));

/* what we read, with units and the plain range used for flags (adults, at rest). Not a diagnosis. */
const TYPES = {
  steps: { label: 'Steps', unit: 'steps', daily: 'sum' },
  heart_rate: { label: 'Heart rate', unit: 'bpm', low: 50, high: 100, urgentHigh: 130, urgentLow: 40 },
  resting_hr: { label: 'Resting heart rate', unit: 'bpm', low: 45, high: 100 },
  spo2: { label: 'Blood oxygen (SpO2)', unit: '%', low: 94, urgentLow: 90 },
  bp: { label: 'Blood pressure', unit: 'mmHg', high: 140, high2: 90, urgentHigh: 180, urgentHigh2: 120 },
  glucose: { label: 'Blood sugar', unit: 'mmol/L', low: 4, high: 7.8, urgentLow: 3, urgentHigh: 16.7 },
  temperature: { label: 'Temperature', unit: '°C', high: 37.8, urgentHigh: 39.5, low: 35 },
  weight: { label: 'Weight', unit: 'kg' },
  sleep: { label: 'Sleep', unit: 'min', low: 360, daily: 'sum' },
  hrv: { label: 'Heart rate variability', unit: 'ms' },
};
const SOURCES = {
  health_connect: { label: 'Android Health Connect (through the MediCore app)', via: 'companion' },
  apple_health: { label: 'Apple Health (through the MediCore app)', via: 'companion' },
  cloud: { label: 'Fitbit, Garmin, Withings, Oura, Polar, Huawei and others', via: 'aggregator' },
  bluetooth: { label: 'Bluetooth heart-rate strap or watch (Chrome on Android)', via: 'browser' },
  manual: { label: 'Typed in by the patient', via: 'manual' },
  demo: { label: 'Demo watch', via: 'demo' },
};
const readingRule = t.obj({ type: t.enum(Object.keys(TYPES), { required: true }), value: t.num({ required: true, min: 0, max: 200000 }), value2: t.num({ min: 0, max: 400 }), at: t.num({ min: 0, max: 1e13 }), device: t.str({ max: 80 }) });

function flag(type, v, v2) {
  const r = TYPES[type]; if (!r) return null;
  if (type === 'bp') { if (v >= r.urgentHigh || (v2 || 0) >= r.urgentHigh2) return 'urgent'; if (v >= r.high || (v2 || 0) >= r.high2) return 'high'; if (v < 90) return 'low'; return null; }
  if (r.urgentHigh != null && v >= r.urgentHigh) return 'urgent'; if (r.urgentLow != null && v <= r.urgentLow) return 'urgent';
  if (r.high != null && v > r.high) return 'high'; if (r.low != null && v < r.low) return 'low';
  return null;
}
async function store(patientId, source, list, extra) {
  const rows = [];
  const t0 = now();
  for (const x of list) {
    if (!TYPES[x.type]) continue;
    const at = Math.min(Number(x.at) || t0, t0 + 60e3);
    if (at < t0 - 400 * 86400e3) continue;
    if (x.type === 'bp' && (x.value2 == null || x.value < x.value2)) continue;
    rows.push(Object.assign({ id: id('wr'), patientId, type: x.type, value: Math.round(Number(x.value) * 10) / 10, value2: x.value2 != null ? Math.round(Number(x.value2)) : null, unit: TYPES[x.type].unit, at, source, device: x.device || null, flag: flag(x.type, Number(x.value), Number(x.value2)), createdAt: t0 }, extra || {}));
  }
  for (const r of rows) await db.col('wearable_readings').insertOne(r);
  if (rows.length) {
    await db.col('wearable_links').updateOne({ patientId, source }, { $set: { lastSyncAt: t0 } });
    await fulfilRequests(patientId);
    const urgent = rows.filter(r => r.flag === 'urgent');
    if (urgent.length) await notify({ patientId, title: 'Check this reading', body: TYPES[urgent[0].type].label + ' ' + fmt(urgent[0]) + ' is outside the safe range. If you feel unwell, press SOS or call 112. Your provider can see it if you share.', kind: 'wearable_flag' });
  }
  return rows;
}
const fmt = r => (r.type === 'bp' ? r.value + '/' + r.value2 : String(r.value)) + ' ' + (TYPES[r.type] || {}).unit;

/** open requests are fulfilled by readings of the asked types that arrive after the request */
async function fulfilRequests(patientId) {
  const open = await db.col('reading_requests').find({ patientId, status: 'open' });
  for (const q of open) {
    if (q.expiresAt < now()) { await db.col('reading_requests').updateOne({ id: q.id, status: 'open' }, { $set: { status: 'expired' } }); continue; }
    const got = await db.col('wearable_readings').find({ patientId, at: { $gte: q.createdAt - 120e3 }, type: { $in: q.types } });
    const types = [...new Set(got.map(g => g.type))];
    if (q.types.every(tp => types.includes(tp))) await db.col('reading_requests').updateOne({ id: q.id, status: 'open' }, { $set: { status: 'received', receivedAt: now() } });
  }
}

/** statistics per type over a window */
async function stats(patientId, days) {
  const since = now() - days * 86400e3;
  const rows = await db.col('wearable_readings').find({ patientId, at: { $gte: since } }, { sort: { at: -1 }, limit: 5000 });
  const out = {};
  for (const [k, def] of Object.entries(TYPES)) {
    const r = rows.filter(x => x.type === k); if (!r.length) continue;
    const latest = r[0];
    let avg;
    if (def.daily === 'sum') { const byDay = {}; r.forEach(x => { const d = new Date(x.at + 3600e3).toISOString().slice(0, 10); byDay[d] = (byDay[d] || 0) + x.value; }); const v = Object.values(byDay); avg = v.reduce((a, b) => a + b, 0) / v.length; }
    else avg = r.reduce((a, x) => a + x.value, 0) / r.length;
    const avg2 = k === 'bp' ? r.reduce((a, x) => a + (x.value2 || 0), 0) / r.length : null;
    const days7 = []; for (let i = 6; i >= 0; i--) { const d = new Date(now() - i * 86400e3 + 3600e3).toISOString().slice(0, 10); const v = r.filter(x => new Date(x.at + 3600e3).toISOString().slice(0, 10) === d); days7.push(v.length ? (def.daily === 'sum' ? v.reduce((a, x) => a + x.value, 0) : Math.round(v.reduce((a, x) => a + x.value, 0) / v.length * 10) / 10) : null); }
    out[k] = { type: k, label: def.label, unit: def.unit, latest: { value: latest.value, value2: latest.value2, at: latest.at, source: latest.source, flag: latest.flag }, average: Math.round(avg * 10) / 10, average2: avg2 != null ? Math.round(avg2) : null, count: r.length, flagged: r.filter(x => x.flag).length, urgent: r.filter(x => x.flag === 'urgent').length, last7: days7 };
  }
  return out;
}
/* plain-words summary without AI */
function rulesSummary(st, forStaff) {
  const lines = [];
  const L = k => st[k];
  if (L('steps')) lines.push((forStaff ? 'Activity: ' : 'You walked about ') + Math.round(L('steps').average).toLocaleString('en-NG') + ' steps a day' + (L('steps').average < 5000 ? (forStaff ? ' (low).' : '. Try to add a short walk each day.') : '.'));
  if (L('resting_hr') || L('heart_rate')) { const h = L('resting_hr') || L('heart_rate'); lines.push((forStaff ? 'Heart rate: average ' : 'Your heart rate averaged ') + Math.round(h.average) + ' bpm' + (h.flagged ? (forStaff ? ', ' + h.flagged + ' readings out of range.' : '. Some readings were outside the usual range.') : (forStaff ? ', within range.' : ', in the usual range.'))); }
  if (L('spo2')) lines.push((forStaff ? 'SpO2: latest ' : 'Your blood oxygen was ') + L('spo2').latest.value + '%' + (L('spo2').latest.flag ? (forStaff ? ' (below 94%).' : ', which is low. Rest, and contact your provider if you are short of breath.') : '.'));
  if (L('bp')) lines.push((forStaff ? 'BP: latest ' : 'Your blood pressure was ') + L('bp').latest.value + '/' + L('bp').latest.value2 + ' mmHg' + (L('bp').latest.flag === 'high' || L('bp').latest.flag === 'urgent' ? (forStaff ? ' (raised).' : ', which is high. Recheck after 5 minutes sitting, and tell your provider.') : '.'));
  if (L('glucose')) lines.push((forStaff ? 'Glucose: latest ' : 'Your blood sugar was ') + L('glucose').latest.value + ' mmol/L' + (L('glucose').latest.flag ? (forStaff ? ' (out of range).' : ', outside the usual range.') : '.'));
  if (L('temperature')) lines.push((forStaff ? 'Temperature: ' : 'Your temperature was ') + L('temperature').latest.value + ' °C' + (L('temperature').latest.flag === 'high' || L('temperature').latest.flag === 'urgent' ? (forStaff ? ' (febrile).' : ': a fever.') : '.'));
  if (L('sleep')) lines.push((forStaff ? 'Sleep: ' : 'You slept about ') + (Math.round(L('sleep').average / 6) / 10) + ' hours a night' + (L('sleep').average < 360 ? (forStaff ? ' (short).' : ', less than the 7 hours most adults need.') : '.'));
  if (!lines.length) lines.push(forStaff ? 'No readings in this period.' : 'No readings yet. Connect a device or type in a reading.');
  const urgent = Object.values(st).some(x => x.urgent);
  if (urgent) lines.push(forStaff ? 'At least one reading is in the urgent range: review.' : 'One reading is in the danger range. If you feel unwell, press SOS or call 112.');
  lines.push(forStaff ? 'Consumer devices: readings are indicative, not diagnostic.' : 'Watches and home devices are not medical tests. This is general information, not a diagnosis.');
  return lines.join(' ');
}
async function summarise(patient, st, forStaff) {
  const base = rulesSummary(st, forStaff);
  if (!S.feature('ai')) return { text: base, by: 'rules' };
  try {
    const AI = require('./ai');
    const lang = { en: 'English', pcm: 'Nigerian Pidgin', yo: 'Yoruba', ha: 'Hausa', ig: 'Igbo' }[patient.lang || 'en'] || 'English';
    const data = Object.values(st).map(x => ({ type: x.label, unit: x.unit, latest: x.latest.value2 != null ? x.latest.value + '/' + x.latest.value2 : x.latest.value, average: x.average2 != null ? x.average + '/' + x.average2 : x.average, outOfRange: x.flagged, urgent: x.urgent, last7days: x.last7 }));
    const system = forStaff ? 'You summarise consumer wearable and home-device readings for a clinician in Nigeria. Be brief (under 90 words), factual, list notable trends and out-of-range values, never diagnose, and note that consumer devices are indicative.'
      : 'You explain a patient\'s own wearable and home-device readings in plain, kind words, in ' + lang + ', under 110 words. Never diagnose or change treatment. Say when to contact their provider, and to press SOS or call 112 for danger signs. End by saying watches are not medical tests.';
    const r = await AI.callModel({ system, messages: [{ role: 'user', content: JSON.stringify(data) }], model: (config.AI || {}).fastModel, maxTokens: 300 });
    if (r.ok && r.text) return { text: r.text.trim(), by: 'ai' };
  } catch (e) { /* fall back to rules */ }
  return { text: base, by: 'rules' };
}

/* ---------------- aggregator (Terra by default; keys in HQ) ---------------- */
function agg() { const i = S.get('integrations.wearables', {}) || {}; return { provider: i.provider || '', baseUrl: (i.baseUrl || 'https://api.tryterra.co/v2').replace(/\/$/, ''), devId: i.devId || '', apiKey: S.decrypt(i.apiKey) || process.env.TERRA_API_KEY || '', webhookSecret: S.decrypt(i.webhookSecret) || process.env.TERRA_WEBHOOK_SECRET || '' }; }
const aggReady = () => { const a = agg(); return a.provider === 'terra' && !!a.devId && !!a.apiKey; };

/* ================= patient ================= */
router.get('/me/wearables', A.requirePatient, on, ah(async (req, res) => {
  const pid = req.ctx.patient.id;
  const [links, st, reqs, lks] = await Promise.all([db.col('wearable_links').find({ patientId: pid }), stats(pid, 7), db.col('reading_requests').find({ patientId: pid, status: 'open', expiresAt: { $gt: now() } }, { sort: { createdAt: -1 } }), db.col('patient_links').find({ patientId: pid, status: { $ne: 'removed' } })]);
  const orgs = lks.length ? await db.col('orgs').find({ id: { $in: lks.map(l => l.orgId) } }, { projection: { name: 1 } }) : [];
  const nm = Object.fromEntries(orgs.map(o => [o.id, o.name]));
  res.json({ sources: Object.entries(SOURCES).filter(([k]) => k !== 'demo' || config.DEMO_MODE).map(([k, v]) => Object.assign({ key: k, connected: links.some(l => l.source === k && l.status === 'active'), lastSyncAt: (links.find(l => l.source === k) || {}).lastSyncAt || null, available: k === 'cloud' ? aggReady() : true }, v)),
    stats: st, requests: reqs.map(q => ({ id: q.id, orgName: nm[q.orgId] || 'Your provider', byName: q.byName, types: q.types, note: q.note || null, createdAt: q.createdAt, expiresAt: q.expiresAt })),
    sharing: lks.map(l => ({ orgId: l.orgId, name: nm[l.orgId] || '', share: !!l.shareWearables })), types: Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, { label: v.label, unit: v.unit }])) });
}));
router.post('/me/wearables/connect', A.requirePatient, on, ah(async (req, res) => {
  const b = body(req, { source: t.enum(Object.keys(SOURCES), { required: true }) });
  if (b.source === 'demo' && !config.DEMO_MODE) throw notFound('Not available');
  const pid = req.ctx.patient.id;
  let authUrl = null;
  if (b.source === 'cloud') {
    if (!aggReady()) throw conflict('Connecting watch brands needs MediCore\'s wearables partner account, which is not set up yet. Use the MediCore app or type in a reading for now.', 'not_configured');
    const a = agg();
    const r = await fetch(a.baseUrl + '/auth/generateWidgetSession', { method: 'POST', headers: { 'Content-Type': 'application/json', 'dev-id': a.devId, 'x-api-key': a.apiKey }, body: JSON.stringify({ reference_id: pid, language: req.ctx.patient.lang || 'en', auth_success_redirect_url: (process.env.APP_URL || '') + '/index.html#/more/health-devices?ok=1', auth_failure_redirect_url: (process.env.APP_URL || '') + '/index.html#/more/health-devices?failed=1' }), signal: AbortSignal.timeout(8000) }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (!j || !j.url) throw conflict('The wearables partner did not answer. Try again in a few minutes.', 'partner_error');
    authUrl = j.url;
  }
  await db.col('wearable_links').findOneAndUpdate({ patientId: pid, source: b.source }, { $set: { status: b.source === 'cloud' ? 'pending' : 'active', updatedAt: now() }, $setOnInsert: { id: id('wl'), patientId: pid, source: b.source, connectedAt: now() } }, { upsert: true });
  if (b.source === 'demo') await store(pid, 'demo', demoWeek(), { device: 'Demo watch' });
  await audit(req, 'wearables.connect', { type: 'patient', id: pid, patientId: pid, orgId: null }, { source: b.source });
  res.json({ ok: true, authUrl });
}));
router.post('/me/wearables/disconnect', A.requirePatient, on, ah(async (req, res) => {
  const b = body(req, { source: t.enum(Object.keys(SOURCES), { required: true }), deleteReadings: t.bool() });
  await db.col('wearable_links').updateOne({ patientId: req.ctx.patient.id, source: b.source }, { $set: { status: 'disconnected', updatedAt: now() } });
  if (b.deleteReadings) await db.col('wearable_readings').deleteMany({ patientId: req.ctx.patient.id, source: b.source });
  await audit(req, 'wearables.disconnect', { type: 'patient', id: req.ctx.patient.id, patientId: req.ctx.patient.id, orgId: null }, { source: b.source, deleted: !!b.deleteReadings });
  res.json({ ok: true });
}));
/* the companion app (Health Connect / Apple Health), Bluetooth in the browser, or typed readings */
router.post('/me/wearables/sync', A.requirePatient, on, ah(async (req, res) => {
  const b = body(req, { source: t.enum(['health_connect', 'apple_health', 'bluetooth', 'manual', 'demo'], { required: true }), readings: t.arr(readingRule, { required: true, min: 1, max: 2000 }) });
  await RL.limit('wsync_' + req.ctx.patient.id, 120, 3600);
  if (b.source === 'demo' && !config.DEMO_MODE) throw notFound('Not available');
  await db.col('wearable_links').findOneAndUpdate({ patientId: req.ctx.patient.id, source: b.source }, { $set: { status: 'active', updatedAt: now() }, $setOnInsert: { id: id('wl'), patientId: req.ctx.patient.id, source: b.source, connectedAt: now() } }, { upsert: true });
  const rows = await store(req.ctx.patient.id, b.source, b.readings);
  res.json({ ok: true, saved: rows.length, flagged: rows.filter(r => r.flag).length });
}));
/* "sync now": pull fresh data from the cloud partner, or (demo) take a reading on the demo watch */
router.post('/me/wearables/refresh', A.requirePatient, on, ah(async (req, res) => {
  const pid = req.ctx.patient.id;
  await RL.limit('wref_' + pid, 30, 3600);
  const links = await db.col('wearable_links').find({ patientId: pid, status: 'active' });
  let saved = 0;
  if (config.DEMO_MODE && links.some(l => l.source === 'demo')) saved += (await store(pid, 'demo', demoNow(), { device: 'Demo watch' })).length;
  const cloud = links.find(l => l.source === 'cloud' && l.externalUserId);
  if (cloud && aggReady()) saved += await pullCloud(pid, cloud.externalUserId);
  res.json({ ok: true, saved, companion: links.some(l => ['health_connect', 'apple_health'].includes(l.source)) });
}));
router.get('/me/wearables/summary', A.requirePatient, on, ah(async (req, res) => {
  const q = query(req, { days: t.int({ min: 1, max: 90 }) });
  await RL.limit('wsum_' + req.ctx.patient.id, 30, 3600);
  const st = await stats(req.ctx.patient.id, q.days || 7);
  res.json(Object.assign({ days: q.days || 7 }, await summarise(req.ctx.patient, st, false)));
}));
router.post('/me/wearables/share', A.requirePatient, on, ah(async (req, res) => {
  const b = body(req, { orgId: t.id({ required: true }), share: t.bool({ required: true }) });
  const l = await db.col('patient_links').findOneAndUpdate({ patientId: req.ctx.patient.id, orgId: b.orgId, status: { $ne: 'removed' } }, { $set: { shareWearables: b.share, shareWearablesAt: now() } });
  if (!l) throw notFound('You are not registered with that provider');
  await audit(req, b.share ? 'wearables.share_on' : 'wearables.share_off', { type: 'link', id: l.id, patientId: l.patientId, orgId: l.orgId });
  res.json({ ok: true, share: b.share });
}));
router.post('/me/reading-requests/:id/answer', A.requirePatient, on, ah(async (req, res) => {
  const b = body(req, { share: t.bool({ required: true }) });
  const q = await db.col('reading_requests').findOne({ id: param(req, 'id'), patientId: req.ctx.patient.id });
  if (!q) throw notFound('Request not found');
  if (b.share) await db.col('patient_links').updateOne({ patientId: q.patientId, orgId: q.orgId }, { $set: { shareWearables: true, shareWearablesAt: now() } });
  else await db.col('reading_requests').updateOne({ id: q.id, status: 'open' }, { $set: { status: 'declined' } });
  await fulfilRequests(q.patientId);
  res.json({ ok: true });
}));

/* ================= providers ================= */
const staffG = A.requireStaff({ anyPerm: ['patient.read', 'clinic.consult', 'vitals.record'] });
async function sharedLink(req) {
  const l = await P.linkOf(req.ctx.org.id, param(req, 'id'));
  if (!l) throw notFound('Patient not found');
  return l;
}
router.get('/fd/patients/:id/wearables', staffG, on, ah(async (req, res) => {
  const l = await sharedLink(req);
  const reqs = await db.col('reading_requests').find({ orgId: req.ctx.org.id, patientId: l.patientId }, { sort: { createdAt: -1 }, limit: 5 });
  if (!l.shareWearables) return res.json({ shared: false, requests: reqs });
  const q = query(req, { days: t.int({ min: 1, max: 90 }) });
  const st = await stats(l.patientId, q.days || 7);
  const recent = await db.col('wearable_readings').find({ patientId: l.patientId }, { sort: { at: -1 }, limit: 20 });
  await audit(req, 'wearables.view', { type: 'patient', id: l.patientId, patientId: l.patientId });
  res.json({ shared: true, stats: st, recent: recent.map(r => ({ type: r.type, label: TYPES[r.type].label, value: r.value, value2: r.value2, unit: r.unit, at: r.at, source: r.source, flag: r.flag })), requests: reqs });
}));
router.get('/fd/patients/:id/wearables/summary', staffG, on, ah(async (req, res) => {
  const l = await sharedLink(req);
  if (!l.shareWearables) throw forbidden('The patient has not shared their device readings with you');
  await RL.limit('wsums_' + req.ctx.org.id, 300, 3600);
  const pat = await db.col('patients').findOne({ id: l.patientId });
  res.json(await summarise(pat, await stats(l.patientId, 7), true));
}));
/* ask for a fresh reading (e.g. during a video visit): the patient measures on the device, syncs and shares */
router.post('/fd/patients/:id/reading-requests', A.requireStaff({ anyPerm: ['clinic.consult', 'vitals.record'] }), on, ah(async (req, res) => {
  const b = body(req, { types: t.arr(t.enum(Object.keys(TYPES)), { required: true, min: 1, max: 6 }), note: t.str({ max: 200, plain: true }) });
  const l = await sharedLink(req);
  await RL.limit('wreq_' + req.ctx.user.id, 60, 3600);
  const mins = Number(S.get('process.wearables.requestExpiryMinutes', 30)) || 30;
  const q = { id: id('rq'), patientId: l.patientId, orgId: req.ctx.org.id, byUserId: req.ctx.user.id, byName: req.ctx.user.name, types: [...new Set(b.types)], note: b.note || null, status: 'open', createdAt: now(), expiresAt: now() + mins * 60e3 };
  await db.col('reading_requests').insertOne(q);
  await notify({ patientId: l.patientId, title: req.ctx.org.name + ' asked for a reading', body: q.types.map(x => TYPES[x].label).join(', ') + ': open your watch or device app, take the reading, then tap Sync in MediCore > Health devices.', kind: 'reading_request', ref: { type: 'reading_request', id: q.id } });
  await audit(req, 'wearables.request', { type: 'reading_request', id: q.id, patientId: l.patientId }, { types: q.types });
  res.json(q);
}));

/* ================= aggregator webhook ================= */
router.post('/wearables/webhook/terra', ah(async (req, res) => {
  const a = agg();
  const sig = String(req.headers['terra-signature'] || '');
  const raw = req.rawBody || JSON.stringify(req.body || {});
  // header "t=timestamp,v1=hmac": HMAC-SHA256 of "timestamp.body" with the webhook secret
  const parts = Object.fromEntries(sig.split(',').map(x => x.split('=')));
  const ok = !!a.webhookSecret && parts.t && parts.v1 && crypto.timingSafeEqual(Buffer.from(crypto.createHmac('sha256', a.webhookSecret).update(parts.t + '.' + raw).digest('hex')), Buffer.from(String(parts.v1).padEnd(64, '0').slice(0, 64)));
  if (!ok) return res.status(401).json({ error: 'Bad signature' });
  const ev = req.body || {};
  const ref = ev.user && ev.user.reference_id; const uid = ev.user && ev.user.user_id;
  if (ev.type === 'auth' && ref && uid) { await db.col('wearable_links').updateOne({ patientId: ref, source: 'cloud' }, { $set: { status: 'active', externalUserId: uid, provider: ev.user.provider || null } }); return res.json({ ok: true }); }
  const link = uid ? await db.col('wearable_links').findOne({ externalUserId: uid, source: 'cloud' }) : null;
  if (!link) return res.json({ ok: true, ignored: true });
  await store(link.patientId, 'cloud', mapTerra(ev), { device: (ev.user && ev.user.provider) || null });
  res.json({ ok: true });
}));
/** map the partner's daily/body/activity payloads to our readings. Check field names against the partner's docs at set-up. */
function mapTerra(ev) {
  const out = []; const ts = s => Date.parse(s) || now();
  for (const d of ev.data || []) {
    const at = ts((d.metadata || {}).end_time || (d.metadata || {}).start_time);
    const dist = d.distance_data || {}; if (dist.steps != null) out.push({ type: 'steps', value: dist.steps, at });
    const hr = (d.heart_rate_data || {}).summary || {}; if (hr.avg_hr_bpm != null) out.push({ type: 'heart_rate', value: hr.avg_hr_bpm, at }); if (hr.resting_hr_bpm != null) out.push({ type: 'resting_hr', value: hr.resting_hr_bpm, at }); if (hr.avg_hrv_rmssd != null) out.push({ type: 'hrv', value: hr.avg_hrv_rmssd, at });
    const ox = (d.oxygen_data || {}); if (ox.avg_saturation_percentage != null) out.push({ type: 'spo2', value: ox.avg_saturation_percentage, at });
    for (const bp of ((d.blood_pressure_data || {}).blood_pressure_samples || [])) if (bp.systolic_bp != null) out.push({ type: 'bp', value: bp.systolic_bp, value2: bp.diastolic_bp, at: ts(bp.timestamp) });
    for (const g of ((d.glucose_data || {}).blood_glucose_samples || [])) if (g.blood_glucose_mg_per_dL != null) out.push({ type: 'glucose', value: Math.round(g.blood_glucose_mg_per_dL / 18 * 10) / 10, at: ts(g.timestamp) });
    for (const tp of ((d.temperature_data || {}).body_temperature_samples || [])) if (tp.temperature_celsius != null) out.push({ type: 'temperature', value: tp.temperature_celsius, at: ts(tp.timestamp) });
    for (const w of ((d.measurements_data || {}).measurements || [])) if (w.weight_kg != null) out.push({ type: 'weight', value: w.weight_kg, at: ts(w.measurement_time) });
    const sl = (d.sleep_durations_data || {}).asleep; if (sl && sl.duration_asleep_state_seconds != null) out.push({ type: 'sleep', value: Math.round(sl.duration_asleep_state_seconds / 60), at });
  }
  return out;
}
async function pullCloud(patientId, userId) {
  const a = agg(); let saved = 0;
  const start = new Date(now() - 2 * 86400e3).toISOString().slice(0, 10);
  for (const kind of ['daily', 'body']) {
    try {
      const r = await fetch(a.baseUrl + '/' + kind + '?user_id=' + encodeURIComponent(userId) + '&start_date=' + start + '&to_webhook=false', { headers: { 'dev-id': a.devId, 'x-api-key': a.apiKey }, signal: AbortSignal.timeout(8000) });
      if (r.ok) saved += (await store(patientId, 'cloud', mapTerra(await r.json()))).length;
    } catch (e) { /* the webhook will bring it */ }
  }
  return saved;
}

/* ================= demo ================= */
function demoWeek() {
  const out = []; const t0 = now();
  for (let d = 6; d >= 0; d--) {
    const day = t0 - d * 86400e3;
    out.push({ type: 'steps', value: 4200 + Math.round(Math.random() * 4500), at: day - 3600e3 });
    out.push({ type: 'resting_hr', value: 66 + Math.round(Math.random() * 8), at: day - 7200e3 });
    out.push({ type: 'sleep', value: 330 + Math.round(Math.random() * 120), at: day - 10 * 3600e3 });
    out.push({ type: 'spo2', value: 96 + Math.round(Math.random() * 2), at: day - 5 * 3600e3 });
  }
  out.push({ type: 'bp', value: 138, value2: 88, at: t0 - 86400e3 });
  return out;
}
function demoNow() { const t0 = now(); return [{ type: 'heart_rate', value: 74 + Math.round(Math.random() * 10), at: t0 }, { type: 'spo2', value: 96 + Math.round(Math.random() * 3), at: t0 }, { type: 'bp', value: 128 + Math.round(Math.random() * 14), value2: 80 + Math.round(Math.random() * 8), at: t0 }, { type: 'temperature', value: 36.6 + Math.round(Math.random() * 5) / 10, at: t0 }]; }
async function seedDemoAfter(ctx) {
  const amaka = ctx.patients && ctx.patients.amaka; if (!amaka) return;
  await db.col('wearable_links').insertOne({ id: id('wl'), patientId: amaka.id, source: 'health_connect', status: 'active', connectedAt: now() - 20 * 86400e3, lastSyncAt: now() - 3600e3 });
  await store(amaka.id, 'health_connect', demoWeek(), { device: 'Smart watch (demo)' });
  await db.col('patient_links').updateMany({ patientId: amaka.id, orgId: ctx.orgs.hospital.id }, { $set: { shareWearables: true, shareWearablesAt: now() } });
}

module.exports = { name: 'wearables', router, seedDemoAfter, TYPES, flag, stats, rulesSummary, mapTerra };
