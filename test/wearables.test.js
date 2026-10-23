'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');
const W = require('../src/modules/wearables');

let h, amaka, doc, fdL;
before(async () => {
  h = await boot();
  amaka = await h.as('patient', 'amaka@patient.demo');
  doc = await h.as('doctor', 'dr.tunde@grandville.demo');
  fdL = await h.as('frontdesk', 'reception@lekkifamily.demo');
});
after(async () => { await h.close(); });

test('flags follow plain adult ranges', () => {
  assert.equal(W.flag('spo2', 89), 'urgent'); assert.equal(W.flag('spo2', 93), 'low'); assert.equal(W.flag('spo2', 97), null);
  assert.equal(W.flag('bp', 182, 100), 'urgent'); assert.equal(W.flag('bp', 142, 85), 'high'); assert.equal(W.flag('bp', 118, 76), null);
  assert.equal(W.flag('temperature', 38.2), 'high'); assert.equal(W.flag('glucose', 2.8), 'urgent');
});

test('a patient syncs from the phone, types a reading, and sees a plain summary', async () => {
  const me = (await amaka.get('/api/me/wearables')).body;
  assert.ok(me.sources.some(s => s.key === 'health_connect' && s.connected), 'demo: Health Connect connected');
  assert.ok(me.stats.steps && me.stats.resting_hr, 'a week of demo readings');
  const s = await amaka.post('/api/me/wearables/sync', { source: 'health_connect', readings: [{ type: 'heart_rate', value: 78, at: Date.now() - 60e3, device: 'Smart watch' }, { type: 'spo2', value: 88, at: Date.now() - 60e3 }] });
  assert.equal(s.status, 200); assert.equal(s.body.saved, 2); assert.equal(s.body.flagged, 1);
  assert.ok((await h.db.col('notifications').find({ patientId: h.ctx.patients.amaka.id, kind: 'wearable_flag' })).length >= 1, 'urgent reading warns the patient');
  const bad = await amaka.post('/api/me/wearables/sync', { source: 'manual', readings: [{ type: 'bp', value: 80, value2: 120 }] });
  assert.equal(bad.body.saved, 0, 'diastolic above systolic is dropped');
  assert.equal((await amaka.post('/api/me/wearables/sync', { source: 'manual', readings: [{ type: 'pulse_magic', value: 1 }] })).status, 400);
  const sum = (await amaka.get('/api/me/wearables/summary')).body;
  assert.equal(sum.by, 'rules'); assert.match(sum.text, /not medical tests/); assert.match(sum.text, /112/);
});

test('providers see readings only when shared; a reading request is answered by the next sync', async () => {
  const pid = h.ctx.patients.amaka.id;
  const w = (await doc.get('/api/fd/patients/' + pid + '/wearables')).body;
  assert.equal(w.shared, true, 'demo: Amaka shares with Grandville'); assert.ok(w.stats.spo2);
  const lk = await h.db.col('patient_links').findOne({ patientId: pid, orgId: h.ctx.orgs.clinic.id });
  if (lk) {
    const other = (await fdL.get('/api/fd/patients/' + pid + '/wearables')).body;
    assert.equal(other.shared, false, 'not shared with Lekki'); assert.ok(!other.stats);
    assert.equal((await fdL.get('/api/fd/patients/' + pid + '/wearables/summary')).status, 403);
  }
  const q = await doc.post('/api/fd/patients/' + pid + '/reading-requests', { types: ['heart_rate', 'bp'], note: 'Sit for 5 minutes first' });
  assert.equal(q.status, 200); assert.equal(q.body.status, 'open');
  const mine = (await amaka.get('/api/me/wearables')).body;
  assert.ok(mine.requests.some(r => r.id === q.body.id && r.orgName === 'Grandville Hospital'));
  await amaka.post('/api/me/wearables/sync', { source: 'health_connect', readings: [{ type: 'heart_rate', value: 80 }] });
  assert.equal((await h.db.col('reading_requests').findOne({ id: q.body.id })).status, 'open', 'blood pressure still missing');
  await amaka.post('/api/me/wearables/sync', { source: 'manual', readings: [{ type: 'bp', value: 134, value2: 86 }] });
  assert.equal((await h.db.col('reading_requests').findOne({ id: q.body.id })).status, 'received');
  const sum = (await doc.get('/api/fd/patients/' + pid + '/wearables/summary')).body;
  assert.match(sum.text, /indicative/);
  // a patient who stops sharing
  await amaka.post('/api/me/wearables/share', { orgId: h.ctx.orgs.hospital.id, share: false });
  assert.equal((await doc.get('/api/fd/patients/' + pid + '/wearables')).body.shared, false);
  await amaka.post('/api/me/wearables/share', { orgId: h.ctx.orgs.hospital.id, share: true });
});

test('demo watch: connect and take a fresh reading; the cloud partner needs keys', async () => {
  const ngozi = await h.as('patient', 'ngozi@patient.demo');
  assert.equal((await ngozi.post('/api/me/wearables/connect', { source: 'cloud' })).status, 409, 'no partner keys');
  assert.equal((await ngozi.post('/api/me/wearables/connect', { source: 'demo' })).status, 200);
  const r = await ngozi.post('/api/me/wearables/refresh');
  assert.equal(r.status, 200); assert.ok(r.body.saved >= 3);
});

test('the partner webhook needs a valid signature; payloads map to readings', async () => {
  const raw = await fetch(h.base + '/api/wearables/webhook/terra', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(raw.status, 401);
  const rows = W.mapTerra({ data: [{ metadata: { end_time: '2026-10-20T08:00:00Z' }, distance_data: { steps: 6400 }, heart_rate_data: { summary: { avg_hr_bpm: 72, resting_hr_bpm: 61 } }, oxygen_data: { avg_saturation_percentage: 97 }, blood_pressure_data: { blood_pressure_samples: [{ systolic_bp: 126, diastolic_bp: 82, timestamp: '2026-10-20T07:00:00Z' }] }, glucose_data: { blood_glucose_samples: [{ blood_glucose_mg_per_dL: 99, timestamp: '2026-10-20T07:00:00Z' }] } }] });
  assert.deepEqual(rows.map(r => r.type).sort(), ['bp', 'glucose', 'heart_rate', 'resting_hr', 'spo2', 'steps']);
  assert.equal(rows.find(r => r.type === 'glucose').value, 5.5);
});
