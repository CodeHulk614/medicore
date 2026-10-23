'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');
const ai = require('../src/modules/ai');

let h, hq, pat;
before(async () => {
  h = await boot(); hq = await h.as('hq', 'hq@medicore.demo'); pat = await h.as('patient', 'amaka@patient.demo');
});
after(async () => { ai._setTransport(null); await h.close(); });

test('assistant is off until HQ switches it on', async () => {
  assert.equal((await pat.post('/api/me/ai/chat', { message: 'hello' })).status, 403);
  await hq.patch('/api/hq/config/features', { patch: { ai: true, aiPatientAssistant: true, aiLabExplainer: true, aiClinicianAssistant: true } });
});

test('consent is required before first use', async () => {
  const r = await pat.post('/api/me/ai/chat', { message: 'I have a headache' });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'ai_consent_required');
  assert.equal((await pat.post('/api/me/ai/consent', { accept: true, shareProfile: false })).status, 200);
});

test('without an AI key the rule-based assistant answers', async () => {
  const r = await pat.post('/api/me/ai/chat', { message: 'I have fever since yesterday' });
  assert.equal(r.status, 200); assert.equal(r.body.source, 'rules'); assert.equal(r.body.triage, 'lab_test');
  assert.ok(r.body.actions.some(a => a.type === 'lab'));
});

test('emergency red flags answer at once with SOS, in the patient language, without calling the model', async () => {
  let called = 0; ai._setTransport(async () => { called++; return { status: 200, body: { content: [{ type: 'text', text: '{"reply":"x","triage":"info"}' }], usage: {} } }; });
  for (const [msg, lang] of [['my father collapsed and is not breathing', 'en'], ['my chest dey pain me well well', 'pcm'], ['ọmọ mi ń gìrì', 'yo'], ['wife na pregnant and she dey bleed', 'pcm']]) {
    const r = await pat.post('/api/me/ai/chat', { message: msg, lang });
    assert.equal(r.body.triage, 'emergency', msg); assert.ok(r.body.actions.some(a => a.type === 'sos'));
  }
  assert.equal(called, 0);
  ai._setTransport(null);
});

test('with a model connected, replies are structured, private data is not sent, and usage is counted', async () => {
  await hq.patch('/api/hq/config/integrations', { patch: { ai: { provider: 'anthropic', model: 'claude-sonnet-5-5', fastModel: 'claude-haiku-5-5', apiKey: 'test-key-123456' } } });
  let sent = null;
  ai._setTransport(async (prov, req) => { sent = req; return { status: 200, body: { content: [{ type: 'text', text: '{"reply":"A cough for two days is often a cold. Rest and drink fluids. See a doctor if it lasts more than 2 weeks.","triage":"self_care","specialty":null}' }], usage: { input_tokens: 900, output_tokens: 120 } } }; });
  const r = await pat.post('/api/me/ai/chat', { message: 'I have a cough for two days' });
  assert.equal(r.status, 200); assert.equal(r.body.source, 'ai'); assert.equal(r.body.triage, 'self_care');
  const payload = JSON.stringify(sent.payload);
  assert.ok(!payload.includes('Amaka') && !payload.includes('+234') && !payload.includes('Penicillin'), 'no name, phone or (unshared) allergies sent');
  const u = await hq.get('/api/hq/ai/usage'); assert.ok(u.body.rows.some(x => x.useCase === 'patient' && x.inTok >= 900));
  // malformed model output falls back safely
  ai._setTransport(async () => ({ status: 200, body: { content: [{ type: 'text', text: 'not json' }], usage: {} } }));
  const r2 = await pat.post('/api/me/ai/chat', { message: 'what is good for back ache' });
  assert.equal(r2.status, 200); assert.equal(r2.body.source, 'rules');
  // provider down
  ai._setTransport(async () => ({ status: 503, body: null }));
  const r3 = await pat.post('/api/me/ai/chat', { message: 'is it ok to drink garri every day' });
  assert.equal(r3.status, 200); assert.equal(r3.body.source, 'rules');
  ai._setTransport(null);
});

test('budget exhausted: falls back to rules instead of spending more', async () => {
  await hq.patch('/api/hq/config/integrations', { patch: { ai: { monthlyBudgetNgn: 1 } } });
  let called = 0; ai._setTransport(async () => { called++; return { status: 200, body: { content: [{ type: 'text', text: '{"reply":"ok","triage":"info"}' }], usage: { input_tokens: 2000000, output_tokens: 1000000 } } }; });
  await pat.post('/api/me/ai/chat', { message: 'tell me about typhoid' });
  const before2 = called;
  const r = await pat.post('/api/me/ai/chat', { message: 'tell me about typhoid again' });
  assert.equal(called, before2, 'no further model calls once over budget'); assert.equal(r.body.source, 'rules');
  ai._setTransport(null);
  await hq.patch('/api/hq/config/integrations', { patch: { ai: { monthlyBudgetNgn: 0, apiKey: '' } } });
});

test('patients can delete conversations; others cannot see them', async () => {
  const list = await pat.get('/api/me/ai/conversations'); assert.ok(list.body.length >= 1);
  const tobi = await h.as('patient', 'tobi@patient.demo');
  assert.equal((await tobi.post('/api/me/ai/conversations/' + list.body[0].id + '/delete')).status, 404);
  assert.equal((await pat.post('/api/me/ai/conversations/' + list.body[0].id + '/delete')).status, 200);
});

test('red flag detector covers common phrasings', () => {
  assert.ok(ai.redFlags('I want to kill myself').includes('self_harm'));
  assert.ok(ai.redFlags('face drooping and slurred speech').includes('stroke'));
  assert.ok(ai.redFlags('my baby is not feeding and very weak').includes('child_danger'));
  assert.equal(ai.redFlags('I have a mild headache').length, 0);
});
