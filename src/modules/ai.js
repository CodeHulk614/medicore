'use strict';
/*
 * MediCore AI assistant. Vendor-neutral: Anthropic, OpenAI, Google Gemini or any
 * OpenAI-compatible endpoint (e.g. a self-hosted open model), chosen in HQ > Integrations.
 *
 * Three uses, each behind its own feature switch (HQ > Features, and per provider):
 *   1. Patient health assistant   POST /api/me/ai/chat          (aiPatientAssistant)
 *   2. Lab result explainer        POST /api/me/ai/explain-lab/:id (aiLabExplainer)
 *   3. Clinician drafting help     POST /api/doc/ai/draft         (aiClinicianAssistant; doctor must review)
 *
 * Safety design (information and navigation, never diagnosis or prescribing):
 *  - Emergency red flags are detected BEFORE any model call, by rules in five languages.
 *    A red flag returns an emergency answer at once with the SOS action and 112 / 767.
 *  - The model must reply as JSON {reply, triage, specialty, flags}; triage drives the buttons
 *    (book a doctor, find a pharmacy, SOS). If the model says "emergency", the app shows SOS.
 *  - Minimum data leaves MediCore: no name, phone, address or ids. Age band, sex and allergies
 *    are shared only if the patient switches on "use my health details".
 *  - Patients consent before first use; conversations are kept 90 days and can be deleted.
 *  - Per-patient daily limits and a platform monthly budget; over budget it falls back to the
 *    fast model, then to the rule-based assistant, never silently failing.
 *  - Every call is logged with model, tokens and estimated cost (no message text in logs).
 */
const express = require('express');
const https = require('https');
const db = require('../db');
const config = require('../config');
const S = require('../lib/settings');
const A = require('../lib/auth');
const { ah, body, t, bad, forbidden, notFound, conflict, param } = require('../lib/http');
const { id, now } = require('../lib/util');
const { audit } = require('../lib/audit');
const RL = require('../lib/ratelimit');

db.index('ai_conversations', ['patientId', 'updatedAt']);
db.index('ai_usage', ['month', 'useCase']);

const router = express.Router();
const LANG_NAMES = { en: 'English', pcm: 'Nigerian Pidgin', yo: 'Yoruba', ha: 'Hausa', ig: 'Igbo' };

/* ---------------- emergency red flags (checked before any AI call) ---------------- */
const RED_FLAGS = [
  { key: 'breathing', re: /(can'?t|cannot|unable to|no fit|hard to|struggl\w* to|difficult\w*) (breathe|breath)|not breathing|choking|gasping|breathless at rest|ko le mi|bá mi mí|ba mi mi|wahala to breathe|ba ya numfashi|wahalar numfashi|enweghi ike iku ume|ọ naghị eku ume/i },
  { key: 'chest_pain', re: /chest (pain|tight|pressure)|heart attack|pain for my chest|chest dey pain|ìrora àyà|irora aya|ciwon kirji|ciwon ƙirji|mgbu obi|obi na-egbu/i },
  { key: 'unconscious', re: /unconscious|passed out|not waking|won'?t wake|unresponsive|collapsed|faint\w* and not|no dey wake|daku|suma|ya suma|o daku|ọ dara n'ala|ọ naghị ama onwe/i },
  { key: 'seizure', re: /seizure|convuls|fitting|jerking|giri|gìrì|farfadiya|ihe na-adọ|anwụ anwụ/i },
  { key: 'bleeding', re: /(heavy|lot of|plenty|won'?t stop|wont stop|non.?stop|serious) (bleeding|blood)|bleeding (heavily|a lot|won'?t stop)|blood dey comot plenty|ẹ̀jẹ̀ púpọ̀|eje pupo|zubar jini da yawa|ọbara na-agba nke ukwuu/i },
  { key: 'stroke', re: /face (droop|drooping|twisted)|one side (weak|numb|paralys)|slurred speech|sudden (weakness|numbness)|stroke|àrùn ọpọlọ|shanyewar jiki|ọrịa strok/i },
  { key: 'pregnancy', re: /pregnan\w*.{0,40}(bleed|blood|pain|convuls|fit|severe headache|baby not moving|water broke)|(bleed|blood).{0,30}pregnan|labour|labor pain|baby not moving|belle.{0,20}(blood|pain)|oyún.{0,30}ẹ̀jẹ̀|ciki.{0,30}jini|ime.{0,30}ọbara/i },
  { key: 'self_harm', re: /suicid|kill (myself|my self)|end my life|want to die|self.?harm|hurt myself|take my (own )?life|wan kill myself|pa ara mi|kashe kaina|igbu onwe m/i },
  { key: 'poison', re: /poison|overdos|swallowed (bleach|kerosene|petrol|insecticide|sniper|tablets)|drank (bleach|kerosene|sniper|poison)|sniper|ota pa|guba|nsi/i },
  { key: 'child_danger', re: /(baby|child|pikin|ọmọ|yaro|nwa).{0,40}(not drinking|can'?t drink|not feeding|very weak|floppy|blue lips|not breathing|convuls|very hot and stiff)/i },
  { key: 'severe_injury', re: /(accident|crash|fell from|gunshot|stab|knife wound|burn\w* (badly|large|face))|ìjàmbá|hatsari|ihe mberede/i },
];
function redFlags(text) { const s = String(text || ''); return RED_FLAGS.filter(f => f.re.test(s)).map(f => f.key); }

function emergencyReply(lang, flags) {
  const nums = S.get('content.global.emergencyNumbers', '112 (national), 767 (Lagos State Ambulance)');
  const msg = {
    en: 'This sounds like an emergency. Press SOS now to send an ambulance, or call ' + nums + '. Stay with the person, keep them safe, and do not give food or drink if they are drowsy.',
    pcm: 'E be like emergency. Press SOS now make ambulance come, or call ' + nums + '. Stay with the person, keep am safe, no give am food or water if e dey sleep-sleep.',
    yo: 'Ó dà bí pàjáwìrì. Tẹ SOS báyìí kí ọkọ̀ aláìsàn wá, tàbí pe ' + nums + '. Dúró ti ẹni náà, má fún un ní oúnjẹ tàbí omi bí ó bá ń sùn lọ.',
    ha: 'Wannan yana kama da gaggawa. Danna SOS yanzu domin motar asibiti ta zo, ko ka kira ' + nums + '. Ka zauna tare da mutumin, kada ka ba shi abinci ko ruwa idan yana barci-barci.',
    ig: 'Nke a dị ka ihe mberede. Pịa SOS ugbu a ka ụgbọ ndị ọrịa bịa, ma ọ bụ kpọọ ' + nums + '. Nọrọ na onye ahụ, echekwala ya, enyela ya nri ma ọ bụ mmiri ma ọ bụrụ na ụra na-atụ ya.',
  };
  // crisis lines are HQ content (Texts > All apps > crisisLines), so only verified numbers are shown
  const crisis = S.get('content.global.crisisLines', '');
  const selfHarm = flags.includes('self_harm') ? {
    en: ' You are not alone. If you are thinking of ending your life, please call 112 now or talk to someone you trust.' + (crisis ? ' Support lines: ' + crisis + '.' : ''),
    pcm: ' You no dey alone. If you dey think to end your life, abeg call 112 now or talk to person wey you trust.' + (crisis ? ' Support lines: ' + crisis + '.' : ''),
    yo: ' Ìwọ kò dá wà. Bí o bá ń ronú láti pa ara rẹ, jọ̀wọ́ pe 112 báyìí tàbí bá ẹni tí o fọkàn tán sọ̀rọ̀.' + (crisis ? ' Àwọn nọ́mbà ìrànlọ́wọ́: ' + crisis + '.' : ''),
    ha: ' Ba kai kaɗai ba ne. Idan kana tunanin kashe kanka, don Allah ka kira 112 yanzu ko ka yi magana da wanda ka amince da shi.' + (crisis ? ' Lambobin taimako: ' + crisis + '.' : ''),
    ig: ' Ị nọghị naanị gị. Ọ bụrụ na ị na-eche igbu onwe gị, biko kpọọ 112 ugbu a ma ọ bụ gwa onye ị tụkwasịrị obi.' + (crisis ? ' Nọmba enyemaka: ' + crisis + '.' : ''),
  } : null;
  return (msg[lang] || msg.en) + (selfHarm ? (selfHarm[lang] || selfHarm.en) : '');
}

/* ---------------- model transport ---------------- */
function postJSON(url, headers, payload, timeoutMs = 30000) {
  return new Promise(resolve => {
    const u = new URL(url); const data = JSON.stringify(payload);
    const r = https.request({ host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', timeout: timeoutMs, headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers) }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { j = null; } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', e => resolve({ status: 0, error: e.message })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    r.write(data); r.end();
  });
}
let transport = null; // tests can replace the network call
function _setTransport(fn) { transport = fn; }

/** call the configured model. messages: [{role:'user'|'assistant', content}] */
async function callModel({ system, messages, model, maxTokens, json }) {
  const ai = config.AI || {};
  const prov = ai.provider || 'anthropic';
  if (!ai.apiKey && !transport) return { ok: false, reason: 'no_key' };
  const mt = Math.min(Number(maxTokens || ai.maxTokens || 800), 2000);
  let req;
  if (prov === 'anthropic') req = { url: (ai.baseUrl || 'https://api.anthropic.com') + '/v1/messages', headers: { 'x-api-key': ai.apiKey, 'anthropic-version': '2023-06-01' }, payload: { model, max_tokens: mt, system, messages } };
  else if (prov === 'google') req = { url: (ai.baseUrl || 'https://generativelanguage.googleapis.com') + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent', headers: { 'x-goog-api-key': ai.apiKey }, payload: { systemInstruction: { parts: [{ text: system }] }, contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), generationConfig: Object.assign({ maxOutputTokens: mt }, json ? { responseMimeType: 'application/json' } : {}) } };
  else req = { url: (ai.baseUrl || 'https://api.openai.com') + '/v1/chat/completions', headers: { Authorization: 'Bearer ' + ai.apiKey }, payload: Object.assign({ model, max_tokens: mt, messages: [{ role: 'system', content: system }].concat(messages) }, json && prov === 'openai' ? { response_format: { type: 'json_object' } } : {}) };
  const t0 = Date.now();
  const r = transport ? await transport(prov, req) : await postJSON(req.url, req.headers, req.payload);
  if (r.status !== 200 || !r.body) return { ok: false, reason: 'provider_error', status: r.status, ms: Date.now() - t0 };
  let text = '', inTok = 0, outTok = 0;
  if (prov === 'anthropic') { text = (r.body.content || []).filter(c => c.type === 'text').map(c => c.text).join(''); inTok = (r.body.usage || {}).input_tokens || 0; outTok = (r.body.usage || {}).output_tokens || 0; }
  else if (prov === 'google') { const c = (r.body.candidates || [])[0]; text = c && c.content ? (c.content.parts || []).map(p => p.text || '').join('') : ''; inTok = (r.body.usageMetadata || {}).promptTokenCount || 0; outTok = (r.body.usageMetadata || {}).candidatesTokenCount || 0; }
  else { text = ((r.body.choices || [])[0] || {}).message ? r.body.choices[0].message.content || '' : ''; inTok = (r.body.usage || {}).prompt_tokens || 0; outTok = (r.body.usage || {}).completion_tokens || 0; }
  return { ok: true, text, inTok, outTok, ms: Date.now() - t0, model };
}

/* rough cost in naira per 1M tokens, editable later via HQ (integrations.ai.prices) */
function costNgn(model, inTok, outTok) {
  // NGN per 1M tokens (USD list price x NGN 1,600). Defaults: Claude Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 (Oct 2026). Editable in HQ.
  const prices = S.get('integrations.ai.prices', null) || { default: { in: 2 * 1600, out: 10 * 1600 }, fast: { in: 0.10 * 1600, out: 0.50 * 1600 } };
  const fast = model && model === (config.AI || {}).fastModel;
  const p = (fast ? prices.fast : prices.default) || prices.default;
  return Math.round(((inTok / 1e6) * p.in + (outTok / 1e6) * p.out) * 100) / 100;
}
async function monthSpend() { const m = new Date().toISOString().slice(0, 7); const rows = await db.col('ai_usage').find({ month: m }); return rows.reduce((s, r) => s + (r.costNgn || 0), 0); }
async function recordUsage(useCase, r, orgId) {
  const m = new Date().toISOString().slice(0, 7); const k = 'aiu_' + m + '_' + useCase + '_' + (r.model || 'rules').replace(/[^a-z0-9.-]/gi, '');
  await db.col('ai_usage').findOneAndUpdate({ id: k }, { $inc: { calls: 1, inTok: r.inTok || 0, outTok: r.outTok || 0, costNgn: r.cost || 0, ms: r.ms || 0 }, $setOnInsert: { id: k, month: m, useCase, model: r.model || 'rules' } }, { upsert: true });
  void orgId;
}
/** choose model under the budget: main, else fast, else rules */
async function pickModel(wantStrong) {
  const ai = config.AI || {};
  if (!ai.apiKey && !transport) return null;
  const budget = Number(ai.monthlyBudgetNgn || 0);
  const spent = budget ? await monthSpend() : 0;
  if (budget && spent >= budget) return null;
  if (budget && spent >= budget * 0.8) return ai.fastModel || ai.model;
  return wantStrong ? (ai.model || ai.fastModel) : (ai.fastModel || ai.model);
}

function parseJSONReply(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/); if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

/* ---------------- patient assistant ---------------- */
function patientSystemPrompt({ lang, profile, providers }) {
  return [
    'You are the MediCore health assistant for patients in Nigeria. You give general health information and help people use MediCore (book a doctor, find a pharmacy or lab, request an ambulance). You are not a doctor.',
    'Rules you must always follow:',
    '- Never diagnose. Talk about what symptoms can mean in general and what to do next.',
    '- Never prescribe, never give doses of prescription medicines, never tell someone to stop a medicine their doctor gave them. For over-the-counter medicines, say to follow the pack label or ask a pharmacist.',
    '- If anything could be an emergency (breathing problems, chest pain, unconsciousness, seizures, heavy bleeding, stroke signs, pregnancy bleeding or severe pain, poisoning, a very sick baby, thoughts of self-harm), set triage to "emergency" and tell them to press SOS or call 112 / 767 (Lagos) at once.',
    '- Use Nigerian context: malaria, typhoid and hypertension are common; people often self-medicate; recommend testing for malaria before treating; mention that MediCore can book a lab test.',
    '- Be warm, short and practical: at most 120 words, plain words, no medical jargon unless explained.',
    '- Reply in ' + (LANG_NAMES[lang] || 'English') + '. If the person writes in another Nigerian language, reply in that language.',
    '- Do not invent facts about the patient. Do not ask for their name, phone number or address.',
    profile ? '- About the patient (they allowed you to use this): ' + profile : '- You know nothing about the patient beyond what they say.',
    providers ? '- MediCore services near them: ' + providers : '',
    'Answer ONLY with a JSON object: {"reply": string, "triage": "info" | "self_care" | "see_pharmacist" | "see_doctor_routine" | "see_doctor_soon" | "lab_test" | "emergency", "specialty": string or null, "followUpQuestion": string or null}.',
  ].filter(Boolean).join('\n');
}
function profileSummary(p) {
  const parts = [];
  if (p.dob) { const a = Math.floor((Date.now() - Date.parse(p.dob + 'T00:00:00Z')) / (365.25 * 86400e3)); parts.push('age band ' + (a < 1 ? 'under 1' : a < 5 ? '1-4' : a < 12 ? '5-11' : a < 18 ? '12-17' : a < 40 ? '18-39' : a < 65 ? '40-64' : '65+')); }
  if (p.sex && p.sex !== 'unknown') parts.push(p.sex);
  if ((p.allergies || []).length) parts.push('allergies: ' + p.allergies.map(a => a.substance).join(', '));
  if ((p.conditions || []).length) parts.push('known conditions: ' + p.conditions.map(c => c.name).join(', '));
  return parts.join('; ');
}

/** rule-based assistant used when no AI key is set, the budget is used up, or the provider fails */
function rulesReply(text, lang) {
  const s = String(text || '').toLowerCase();
  const say = (en, pcm) => (lang === 'pcm' ? pcm : en);
  if (/malaria|fever|hot body|feverish|iba|zazzabi|ahụ ọkụ/.test(s)) return { reply: say('Fever in Nigeria is often malaria, but other illnesses look the same. Get a malaria test before taking malaria drugs: you can book one with a lab in MediCore. Drink plenty of water. See a doctor today if the fever is very high, lasts more than 2 days, or comes with vomiting, confusion or a stiff neck.', 'Fever for Naija fit be malaria, but other sickness fit resemble am. Do malaria test first before you take malaria drug: you fit book test for lab inside MediCore. Drink plenty water. See doctor today if the fever too high, pass 2 days, or e come with vomiting, confusion or stiff neck.'), triage: 'lab_test', specialty: 'General Physician' };
  if (/headache|blood pressure|hypertension|bp|orí fífọ́|ciwon kai/.test(s)) return { reply: say('Headaches are common and usually not serious. If you have high blood pressure, check it if you can and take your medicines as prescribed. See a doctor soon if headaches keep coming back, and get help at once for the worst headache of your life or weakness on one side.', 'Headache common and e no dey serious most times. If you get high BP, check am if you fit and take your drugs as doctor talk. See doctor soon if the headache dey come back, and find help quick if na the worst headache wey you don ever get or one side of body weak.'), triage: 'see_doctor_routine', specialty: 'General Physician' };
  if (/pharmac|drug|medicine|tablet|refill|oògùn|magani|ọgwụ/.test(s)) return { reply: say('For medicines, a pharmacist can help. In MediCore you can send your prescription to a pharmacy and choose pickup or delivery. Do not share prescription medicines with others.', 'For drug matter, pharmacist fit help you. Inside MediCore you fit send your prescription go pharmacy and choose pickup or delivery. No share prescription drug with another person.'), triage: 'see_pharmacist', specialty: null };
  return { reply: say('I can give general health information and help you book a doctor, find a pharmacy or lab, or call an ambulance. Tell me what is going on, in a few words.', 'I fit give you general health info and help you book doctor, find pharmacy or lab, or call ambulance. Tell me wetin dey happen, small small.'), triage: 'info', specialty: null };
}
const ACTIONS = { emergency: [{ type: 'sos' }], see_doctor_soon: [{ type: 'book' }], see_doctor_routine: [{ type: 'book' }], lab_test: [{ type: 'lab' }, { type: 'book' }], see_pharmacist: [{ type: 'pharmacy' }], self_care: [{ type: 'book' }], info: [] };

function aiOn(req, name) { const org = req.ctx && req.ctx.org; return S.feature('ai', org) && S.feature(name, org); }

router.get('/me/ai/status', A.requirePatient, ah(async (req, res) => {
  const p = req.ctx.patient;
  res.json({ enabled: aiOn(req, 'aiPatientAssistant'), consented: !!(p.aiConsent && p.aiConsent.accepted), shareProfile: !!(p.aiConsent && p.aiConsent.shareProfile), mode: (config.AI || {}).apiKey ? 'ai' : 'rules', disclaimer: S.get('content.global.aiDisclaimer', '') });
}));
router.post('/me/ai/consent', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { accept: t.bool({ required: true }), shareProfile: t.bool() });
  await db.col('patients').updateOne({ id: req.ctx.patient.id }, { $set: { aiConsent: { accepted: b.accept, shareProfile: !!b.shareProfile, at: now() } } });
  await db.col('consents').insertOne({ id: id('cs'), patientId: req.ctx.patient.id, kind: 'ai_assistant', version: config.PRIVACY_NOTICE_VERSION, accepted: b.accept, shareProfile: !!b.shareProfile, channel: 'patient_app', at: now() });
  await audit(req, 'ai.consent', { type: 'patient', id: req.ctx.patient.id, patientId: req.ctx.patient.id, orgId: null }, { accept: b.accept, shareProfile: !!b.shareProfile });
  res.json({ ok: true });
}));

router.post('/me/ai/chat', A.requirePatient, ah(async (req, res) => {
  if (!aiOn(req, 'aiPatientAssistant')) throw forbidden('The health assistant is not switched on');
  const p = req.ctx.patient;
  if (!(p.aiConsent && p.aiConsent.accepted)) throw conflict('Please read and accept how the assistant works first', 'ai_consent_required');
  const b = body(req, { conversationId: t.id(), message: t.text({ required: true, max: 1500 }), lang: t.enum(Object.keys(LANG_NAMES)) });
  await RL.limit('ai_day_' + p.id, Number(S.get('process.ai.patientDailyMessages', 40)) || 40, 86400, 'You have reached today\'s limit for the assistant. You can still book a doctor or press SOS.');
  const lang = b.lang || p.lang || 'en';
  let conv = b.conversationId ? await db.col('ai_conversations').findOne({ id: b.conversationId, patientId: p.id }) : null;
  if (b.conversationId && !conv) throw notFound('Conversation not found');
  if (!conv) { conv = { id: id('aic'), patientId: p.id, useCase: 'patient', lang, messages: [], createdAt: now(), updatedAt: now(), expiresAt: now() + 90 * 86400e3 }; await db.col('ai_conversations').insertOne(conv); }

  const flags = redFlags(b.message);
  let out;
  if (flags.length) {
    out = { reply: emergencyReply(lang, flags), triage: 'emergency', specialty: null, source: 'rules', flags };
    await recordUsage('patient_redflag', { model: 'rules' });
  } else {
    const model = await pickModel(true);
    let r = null;
    if (model) {
      let providers = '';
      try { const near = await db.col('orgs').find({ status: 'active', type: { $ne: 'hmo' } }, { limit: 30, projection: { name: 1, type: 1, modules: 1 } }); providers = [...new Set(near.map(o => o.type))].join(', ') + ' providers are on MediCore'; } catch (e) { providers = ''; }
      const system = patientSystemPrompt({ lang, profile: p.aiConsent.shareProfile ? profileSummary(p) : null, providers });
      const history = conv.messages.slice(-10).map(m => ({ role: m.role, content: m.role === 'assistant' ? (m.reply || m.content || '') : m.content }));
      r = await callModel({ system, messages: history.concat([{ role: 'user', content: b.message }]), model, json: true });
      if (r.ok) { r.cost = costNgn(model, r.inTok, r.outTok); await recordUsage('patient', r); }
    }
    const parsed = r && r.ok ? parseJSONReply(r.text) : null;
    if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) {
      const triage = ACTIONS[parsed.triage] ? parsed.triage : 'info';
      out = { reply: parsed.reply.slice(0, 2000), triage, specialty: typeof parsed.specialty === 'string' ? parsed.specialty.slice(0, 60) : null, followUpQuestion: typeof parsed.followUpQuestion === 'string' ? parsed.followUpQuestion.slice(0, 300) : null, source: 'ai', model };
      // second safety net: if the model's own words describe an emergency, show SOS
      if (redFlags(parsed.reply).length && triage !== 'emergency') out.triage = 'see_doctor_soon';
    } else {
      out = Object.assign(rulesReply(b.message, lang), { source: 'rules', degraded: !!model });
      await recordUsage('patient_rules', { model: 'rules' });
    }
  }
  out.actions = ACTIONS[out.triage] || [];
  out.disclaimer = S.get('content.global.aiDisclaimer', '');
  await db.col('ai_conversations').updateOne({ id: conv.id }, { $push: { messages: { $each: [{ role: 'user', content: b.message, at: now() }, { role: 'assistant', reply: out.reply, triage: out.triage, source: out.source, at: now() }] } }, $set: { updatedAt: now(), lastTriage: out.triage } });
  await audit(req, 'ai.patient_chat', { type: 'ai_conversation', id: conv.id, patientId: p.id, orgId: null }, { triage: out.triage, source: out.source, redFlags: flags });
  res.json(Object.assign({ conversationId: conv.id }, out));
}));
router.get('/me/ai/conversations', A.requirePatient, ah(async (req, res) => {
  const rows = await db.col('ai_conversations').find({ patientId: req.ctx.patient.id, expiresAt: { $gt: now() } }, { sort: { updatedAt: -1 }, limit: 30 });
  res.json(rows.map(c => ({ id: c.id, updatedAt: c.updatedAt, lastTriage: c.lastTriage, preview: ((c.messages || [])[0] || {}).content ? c.messages[0].content.slice(0, 80) : '', messages: c.messages })));
}));
router.post('/me/ai/conversations/:id/delete', A.requirePatient, ah(async (req, res) => {
  const r = await db.col('ai_conversations').deleteOne({ id: param(req, 'id'), patientId: req.ctx.patient.id });
  if (!r.deleted) throw notFound('Conversation not found');
  await audit(req, 'ai.conversation_deleted', { type: 'ai_conversation', id: req.params.id, patientId: req.ctx.patient.id, orgId: null });
  res.json({ ok: true });
}));

/* ---------------- lab result explainer (patient) ---------------- */
router.post('/me/ai/explain-lab/:id', A.requirePatient, ah(async (req, res) => {
  if (!aiOn(req, 'aiLabExplainer')) throw forbidden('Result explanations are not switched on');
  const p = req.ctx.patient;
  const lo = await db.col('lab_orders').findOne({ id: param(req, 'id'), patientId: p.id });
  if (!lo || lo.status !== 'released') throw notFound('No released result found');
  await RL.limit('ai_lab_' + p.id, 20, 86400);
  const lang = (body(req, { lang: t.enum(Object.keys(LANG_NAMES)) }).lang) || p.lang || 'en';
  const results = (lo.results || []).map(r => ({ test: r.name || r.code, value: r.value, unit: r.unit || '', range: r.refText || (r.low != null || r.high != null ? (r.low ?? '') + '-' + (r.high ?? '') : ''), flag: r.flag, critical: !!r.critical }));
  const anyCritical = results.some(r => r.critical);
  const model = await pickModel(false);
  let reply = null, source = 'rules';
  if (model && !anyCritical) {
    const r = await callModel({ model, json: true, system: 'You explain lab results to patients in Nigeria in plain ' + (LANG_NAMES[lang] || 'English') + '. Explain what each test measures and what "high", "low" or "normal" generally means, in at most 150 words. Never diagnose, never suggest treatment or doses. Always end by saying their doctor will explain what the results mean for them. Reply as JSON {"reply": string}.', messages: [{ role: 'user', content: JSON.stringify(results) }] });
    if (r.ok) { r.cost = costNgn(model, r.inTok, r.outTok); await recordUsage('lab_explain', r); const j = parseJSONReply(r.text); if (j && j.reply) { reply = String(j.reply).slice(0, 2000); source = 'ai'; } }
  }
  if (!reply) {
    reply = anyCritical ? 'One or more results need urgent attention. Your doctor or the lab has been alerted. If you feel unwell, press SOS or call 112.'
      : results.map(r => r.test + ': ' + (r.flag === 'normal' ? 'within the usual range' : r.flag === 'high' ? 'above the usual range' : r.flag === 'low' ? 'below the usual range' : 'needs your doctor to explain')).join('. ') + '. Your doctor will explain what these results mean for you.';
  }
  await audit(req, 'ai.lab_explain', { type: 'lab_order', id: lo.id, patientId: p.id, orgId: null }, { source, critical: anyCritical });
  res.json({ reply, source, critical: anyCritical, disclaimer: S.get('content.global.aiDisclaimer', '') });
}));

/* ---------------- clinician drafting help (doctor reviews before anything is saved) ---------------- */
router.post('/doc/ai/draft', A.requireStaff({ perm: 'clinic.consult', module: 'clinic' }), ah(async (req, res) => {
  if (!aiOn(req, 'aiClinicianAssistant')) throw forbidden('The clinician assistant is not switched on for your provider');
  const b = body(req, { encounterId: t.id({ required: true }), kind: t.enum(['soap_from_notes', 'patient_summary', 'referral_letter'], { required: true }), notes: t.text({ max: 6000 }) });
  const enc = await db.col('encounters').findOne({ id: b.encounterId, orgId: req.ctx.org.id });
  if (!enc) throw notFound('Consultation not found');
  await RL.limit('ai_doc_' + req.ctx.user.id, 200, 86400);
  const p = await db.col('patients').findOne({ id: enc.patientId });
  const model = await pickModel(true);
  if (!model) return res.json({ draft: null, source: 'unavailable', message: (config.AI || {}).apiKey ? 'The AI budget for this month is used up.' : 'No AI service is connected yet (HQ > Integrations).' });
  const facts = { ageBand: profileSummary(Object.assign({}, p, { allergies: [], conditions: [] })), allergies: (p.allergies || []).map(a => a.substance), conditions: (p.conditions || []).map(c => c.name), note: enc.notes || {}, diagnoses: enc.diagnoses || [], extraNotes: b.notes || '' };
  const task = { soap_from_notes: 'Turn the clinician\'s notes into a tidy SOAP note (Subjective, Objective, Assessment, Plan). Do not add findings that are not in the notes; mark anything missing as [to complete].', patient_summary: 'Write a plain-language visit summary for the patient (under 150 words): what was found, what to do, when to come back. No new advice beyond the notes.', referral_letter: 'Draft a short, professional referral letter to a specialist from these notes. Use [Doctor name] and [Specialist] placeholders.' }[b.kind];
  const r = await callModel({ model, json: true, maxTokens: 1200, system: 'You help a licensed doctor in Nigeria with documentation. ' + task + ' Never invent clinical facts, doses or results. The doctor will review and edit everything. Reply as JSON {"draft": string, "missing": [string]}.', messages: [{ role: 'user', content: JSON.stringify(facts) }] });
  if (!r.ok) return res.json({ draft: null, source: 'error', message: 'The AI service did not respond. Try again shortly.' });
  r.cost = costNgn(model, r.inTok, r.outTok); await recordUsage('clinician', r, req.ctx.org.id);
  const j = parseJSONReply(r.text) || { draft: r.text };
  await audit(req, 'ai.clinician_draft', { type: 'encounter', id: enc.id, patientId: enc.patientId }, { kind: b.kind, model });
  res.json({ draft: String(j.draft || '').slice(0, 8000), missing: Array.isArray(j.missing) ? j.missing.slice(0, 20) : [], source: 'ai', model, reviewRequired: true });
}));

/* ---------------- HQ usage ---------------- */
router.get('/hq/ai/usage', A.requirePlatform('platform.read'), ah(async (req, res) => {
  const rows = await db.col('ai_usage').find({}, { sort: { month: -1 }, limit: 300 });
  res.json({ rows, budgetNgn: Number((config.AI || {}).monthlyBudgetNgn || 0), spentThisMonthNgn: await monthSpend(), provider: (config.AI || {}).provider, model: (config.AI || {}).model, fastModel: (config.AI || {}).fastModel, connected: !!(config.AI || {}).apiKey });
}));

async function testConnection() {
  const ai = config.AI || {};
  if (!ai.apiKey) return { ok: false, message: 'No AI key saved' };
  const r = await callModel({ system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'Test' }], model: ai.fastModel || ai.model, maxTokens: 10 });
  return r.ok ? { ok: true, message: 'Connected to ' + ai.provider + ' (' + (ai.fastModel || ai.model) + ')' } : { ok: false, status: r.status, message: 'The AI service rejected the request (' + (r.status || r.reason) + ')' };
}

module.exports = { name: 'ai', router, testConnection, redFlags, _setTransport, callModel, rulesReply };
