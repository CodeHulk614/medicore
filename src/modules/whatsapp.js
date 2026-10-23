'use strict';
/*
 * Contact numbers and WhatsApp.
 *
 * 1) Contacts. Every provider (and every branch of a group, and the group's head office) keeps a phone and WhatsApp
 *    number per department: main line, emergency, appointments, pharmacy, lab, billing and HMO, customer care,
 *    ambulance, records. Patients see their provider's numbers with Call and "Chat on WhatsApp" buttons (wa.me links,
 *    which need no setup). HQ keeps the platform's own support and sales numbers (branding).
 *
 * 2) Automated WhatsApp (Meta Cloud API, set up once in HQ):
 *    - Patients who agreed to WhatsApp get their notifications there (appointment, payment, results, delivery,
 *      referral...) through the approved "update" template; when that works the SMS copy is skipped. Codes can go
 *      by WhatsApp too (authentication template), with SMS as the fallback.
 *    - Incoming chats: POST /api/whatsapp/webhook (signature checked). A chat on a department's own number goes to that
 *      department's inbox. A chat on the platform number from a known patient goes to their provider (a menu asks which
 *      one when they have several); unknown numbers get the welcome reply. Emergency words in English, Pidgin, Yoruba,
 *      Hausa or Igbo get the emergency numbers at once and alert the provider.
 *    - Staff reply from the WhatsApp inbox in their app (free text within Meta's 24-hour window; after that the
 *      approved template is used).
 */
const express = require('express');
const db = require('../db');
const config = require('../config');
const { ah, body, query, t, bad, forbidden, notFound, conflict, param } = require('../lib/http');
const A = require('../lib/auth');
const S = require('../lib/settings');
const WA = require('../lib/whatsapp');
const { id, now } = require('../lib/util');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');

db.index('wa_conversations', ['orgId', 'status', 'lastAt']);
db.index('wa_conversations', ['waId', 'status']);
db.index('wa_messages', ['convId', 'at']);
db.index('wa_messages', ['waMessageId']);

const router = express.Router();
const DEPARTMENTS = {
  main: 'Main line and reception', emergency: 'Emergency', appointments: 'Appointments', pharmacy: 'Pharmacy', lab: 'Laboratory',
  billing: 'Billing and HMO', care: 'Customer care and complaints', ambulance: 'Ambulance', records: 'Medical records',
};
/* which departments' chats each role handles (owner and admin see all) */
const ROLE_DEPTS = {
  receptionist: ['main', 'appointments', 'records'], records: ['records', 'main'], frontdesk_manager: ['main', 'appointments', 'records', 'billing', 'care', 'emergency'],
  cashier: ['billing'], nurse: ['main', 'emergency'], care: ['care', 'main'], pharmacist: ['pharmacy'], pharmacy_tech: ['pharmacy'], delivery_dispatcher: ['pharmacy'],
  lab_reception: ['lab'], lab_manager: ['lab'], lab_scientist: ['lab'], ambulance_dispatcher: ['emergency', 'ambulance'], doctor: [],
};
const EMERGENCY_WORDS = /\b(sos|emergency|ambulance|help me|dying|bleeding|unconscious|accident|pajawiri|gaggawa|mberede|ihe mberede|wahala don happen|e don happen)\b/i;

/* ---------------- contacts ---------------- */
const contactRule = t.obj({ phone: t.str({ max: 20 }), whatsapp: t.str({ max: 20 }), waPhoneNumberId: t.str({ max: 30, pattern: /^\d*$/, label: 'WhatsApp phone number ID' }), email: t.email(), hours: t.str({ max: 120, plain: true }), show: t.bool() });
function cleanContacts(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (!DEPARTMENTS[k]) throw bad('Unknown department ' + k);
    if (v === null) { out[k] = null; continue; }
    const e = { show: v.show !== false };
    if (v.phone) { const p = WA.normIntl(v.phone); if (!p) throw bad(DEPARTMENTS[k] + ': enter a valid phone number, for example 0803 123 4567 or +44 20 7946 0000'); e.phone = p; }
    if (v.whatsapp) { const p = WA.normIntl(v.whatsapp); if (!p) throw bad(DEPARTMENTS[k] + ': enter a valid WhatsApp number'); e.whatsapp = p; }
    if (v.waPhoneNumberId) e.waPhoneNumberId = v.waPhoneNumberId;
    if (v.email) e.email = v.email; if (v.hours) e.hours = v.hours;
    out[k] = e;
  }
  return out;
}
const contactsBody = req => { const raw = req.body && req.body.contacts; if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('Send contacts: { department: { phone, whatsapp, ... } }'); const shaped = {}; for (const [k, v] of Object.entries(raw)) shaped[k] = v === null ? null : require('../lib/http').validate(v, contactRule.shape); return cleanContacts(shaped); };
async function saveContacts(col, idv, current, next) {
  const merged = Object.assign({}, current || {});
  for (const [k, v] of Object.entries(next)) { if (v === null) delete merged[k]; else merged[k] = v; }
  // one WhatsApp phone number ID belongs to one place only
  for (const v of Object.values(merged)) if (v.waPhoneNumberId) {
    const clashO = await db.col('orgs').findOne({ id: { $ne: col === 'orgs' ? idv : '__' }, $or: Object.keys(DEPARTMENTS).map(d => ({ ['contacts.' + d + '.waPhoneNumberId']: v.waPhoneNumberId })) }, { projection: { name: 1 } });
    const clashG = await db.col('groups').findOne({ id: { $ne: col === 'groups' ? idv : '__' }, $or: Object.keys(DEPARTMENTS).map(d => ({ ['contacts.' + d + '.waPhoneNumberId']: v.waPhoneNumberId })) }, { projection: { name: 1 } });
    if (clashO || clashG) throw conflict('That WhatsApp phone number ID is already used by ' + (clashO || clashG).name);
    if (v.waPhoneNumberId === (config.WHATSAPP || {}).phoneNumberId) throw conflict('That is the platform\'s own WhatsApp number');
  }
  await db.col(col).updateOne({ id: idv }, { $set: { contacts: merged } });
  return merged;
}
function contactView(c) {
  const out = {};
  for (const [k, v] of Object.entries(c || {})) out[k] = Object.assign({ label: DEPARTMENTS[k] || k }, v, { callLink: v.phone ? 'tel:' + v.phone : null, chatLink: v.whatsapp ? WA.chatLink(v.whatsapp) : null, automated: !!v.waPhoneNumberId && WA.configured() });
  return out;
}

const adminContacts = A.requireStaff({ anyPerm: ['admin.settings', 'admin.staff', 'admin.reports'] });
router.get('/admin/contacts', adminContacts, ah(async (req, res) => {
  const o = req.ctx.org;
  res.json({ departments: DEPARTMENTS, contacts: contactView(o.contacts), modules: o.modules, whatsappApi: WA.configured(), groupManaged: false });
}));
router.patch('/admin/contacts', A.requireStaff({ perm: 'admin.settings' }), ah(async (req, res) => {
  const next = contactsBody(req);
  const merged = await saveContacts('orgs', req.ctx.org.id, req.ctx.org.contacts, next);
  await audit(req, 'org.contacts', { type: 'org', id: req.ctx.org.id }, { departments: Object.keys(next) });
  res.json({ contacts: contactView(merged) });
}));
router.get('/group/contacts', A.requireGroup(), ah(async (req, res) => {
  const branches = await db.col('orgs').find({ groupId: req.ctx.group.id }, { sort: { createdAt: 1 } });
  res.json({ departments: DEPARTMENTS, headOffice: contactView(req.ctx.group.contacts), branches: branches.map(o => ({ id: o.id, name: o.branchName || o.name, status: o.status, modules: o.modules, contacts: contactView(o.contacts) })), whatsappApi: WA.configured() });
}));
router.patch('/group/contacts', A.requireGroup('group.settings'), ah(async (req, res) => {
  const next = contactsBody(req);
  const merged = await saveContacts('groups', req.ctx.group.id, req.ctx.group.contacts, next);
  await audit(req, 'group.contacts', { type: 'group', id: req.ctx.group.id, orgId: null }, { departments: Object.keys(next) });
  res.json({ headOffice: contactView(merged) });
}));
router.patch('/group/branches/:id/contacts', A.requireGroup('group.branches'), ah(async (req, res) => {
  const o = await db.col('orgs').findOne({ id: param(req, 'id'), groupId: req.ctx.group.id }); if (!o) throw notFound('Branch not found');
  const next = contactsBody(req);
  const merged = await saveContacts('orgs', o.id, o.contacts, next);
  await audit(req, 'group.branch_contacts', { type: 'org', id: o.id, orgId: o.id }, { departments: Object.keys(next) });
  res.json({ contacts: contactView(merged) });
}));
/* patients: the numbers of their providers (current provider when the app sends X-MC-Provider) */
router.get('/me/contacts', A.requirePatient, ah(async (req, res) => {
  const P = require('./patients');
  const provs = await P.patientProviders(req.ctx.patient.id);
  const want = String(req.headers['x-mc-provider'] || '');
  const list = want ? provs.filter(p => p.key === want) : provs;
  const out = [];
  for (const p of list) {
    const g = p.kind === 'group' ? await db.col('groups').findOne({ id: p.key }) : null;
    const branches = [];
    for (const b of p.branches) { const o = await db.col('orgs').findOne({ id: b.orgId }); const c = Object.fromEntries(Object.entries(contactView(o && o.contacts)).filter(([, v]) => v.show !== false)); if (!(o && o.contacts && o.contacts.main) && o && o.contact && o.contact.phone) c.main = { label: DEPARTMENTS.main, phone: o.contact.phone, callLink: 'tel:' + o.contact.phone, chatLink: null }; branches.push({ orgId: b.orgId, name: b.branchName || b.name, area: b.area, contacts: c }); }
    out.push({ key: p.key, kind: p.kind, name: p.name, headOffice: g ? Object.fromEntries(Object.entries(contactView(g.contacts)).filter(([, v]) => v.show !== false)) : null, branches });
  }
  const B = S.get('branding', {});
  res.json({ providers: out, platform: { supportPhone: B.supportPhone || null, supportWhatsapp: B.supportWhatsapp || null, supportChatLink: B.supportWhatsapp ? WA.chatLink(B.supportWhatsapp) : null }, whatsappOptIn: !!req.ctx.patient.whatsappOptIn, whatsappNumber: req.ctx.patient.whatsapp || req.ctx.patient.phone || null, whatsappAutomated: WA.configured() && S.feature('whatsapp') });
}));
/* patient's own choice to get updates on WhatsApp */
router.post('/me/whatsapp', A.requirePatient, ah(async (req, res) => {
  const b = body(req, { optIn: t.bool({ required: true }), number: t.str({ max: 20 }) });
  const set = { whatsappOptIn: b.optIn, whatsappOptInAt: now(), whatsappOptInVia: 'app' };
  if (b.number) { const n = WA.normIntl(b.number); if (!n) throw bad('Enter a valid WhatsApp number'); set.whatsapp = n; }
  await db.col('patients').updateOne({ id: req.ctx.patient.id }, { $set: set });
  await audit(req, b.optIn ? 'patient.whatsapp_on' : 'patient.whatsapp_off', { type: 'patient', id: req.ctx.patient.id, patientId: req.ctx.patient.id, orgId: null });
  res.json({ ok: true, whatsappOptIn: b.optIn, whatsapp: set.whatsapp || req.ctx.patient.whatsapp || req.ctx.patient.phone || null });
}));
/* front desk records a patient's agreement (or refusal) to WhatsApp messages */
router.post('/fd/patients/:id/whatsapp', A.requireStaff({ anyPerm: ['patient.register', 'whatsapp.inbox'] }), ah(async (req, res) => {
  const { patient } = await require('./patients').requireLinked(req, param(req, 'id'));
  const b = body(req, { optIn: t.bool({ required: true }), number: t.str({ max: 20 }) });
  const set = { whatsappOptIn: b.optIn, whatsappOptInAt: now(), whatsappOptInVia: 'staff:' + req.ctx.org.id };
  if (b.number) { const n = WA.normIntl(b.number); if (!n) throw bad('Enter a valid WhatsApp number'); set.whatsapp = n; }
  await db.col('patients').updateOne({ id: patient.id }, { $set: set });
  await audit(req, b.optIn ? 'patient.whatsapp_on' : 'patient.whatsapp_off', { type: 'patient', id: patient.id, patientId: patient.id });
  res.json({ ok: true, whatsappOptIn: b.optIn, whatsapp: set.whatsapp || patient.whatsapp || patient.phone || null });
}));

/* ---------------- inbound webhook ---------------- */
router.get('/whatsapp/webhook', (req, res) => {
  const vt = (config.WHATSAPP || {}).verifyToken;
  if (req.query['hub.mode'] === 'subscribe' && vt && req.query['hub.verify_token'] === vt) return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
  res.status(403).end();
});
async function placeForNumber(phoneNumberId) {
  if (!phoneNumberId || phoneNumberId === (config.WHATSAPP || {}).phoneNumberId) return { platform: true };
  const or = Object.keys(DEPARTMENTS).map(d => ({ ['contacts.' + d + '.waPhoneNumberId']: phoneNumberId }));
  const o = await db.col('orgs').findOne({ $or: or });
  if (o) return { orgId: o.id, org: o, dept: Object.keys(DEPARTMENTS).find(d => o.contacts && o.contacts[d] && o.contacts[d].waPhoneNumberId === phoneNumberId) };
  const g = await db.col('groups').findOne({ $or: or });
  if (g) { const first = await db.col('orgs').findOne({ groupId: g.id, status: 'active' }, { sort: { createdAt: 1 } }); if (first) return { orgId: first.id, org: first, dept: Object.keys(DEPARTMENTS).find(d => g.contacts && g.contacts[d] && g.contacts[d].waPhoneNumberId === phoneNumberId) || 'main', viaGroup: g.id }; }
  return { platform: true };
}
async function openConversation({ orgId, dept, wa, patient, name, fromId }) {
  let c = await db.col('wa_conversations').findOne({ orgId, dept, waId: wa, status: 'open' });
  if (!c) {
    c = { id: id('wac'), orgId, dept, waId: wa, phone: '+' + wa, patientId: patient ? patient.id : null, name: name || (patient ? patient.firstName + ' ' + patient.lastName : null), status: 'open', priority: 'normal', createdAt: now(), lastAt: now(), lastInboundAt: null, unread: 0, assignedTo: null, fromPhoneNumberId: fromId || null };
    await db.col('wa_conversations').insertOne(c);
  }
  return c;
}
async function recordIn(c, m, text) {
  await db.col('wa_messages').insertOne({ id: id('wam'), convId: c.id, dir: 'in', type: m.type, text: text || null, waMessageId: m.id || null, at: m.timestamp ? Number(m.timestamp) * 1000 : now() });
  await db.col('wa_conversations').updateOne({ id: c.id }, { $set: { lastAt: now(), lastInboundAt: now(), lastText: (text || '[' + m.type + ']').slice(0, 140), status: 'open' }, $inc: { unread: 1 } });
}
async function reply(c, text, fromId) {
  const r = await WA.sendText('+' + c.waId, text, fromId || c.fromPhoneNumberId);
  await db.col('wa_messages').insertOne({ id: id('wam'), convId: c.id, dir: 'out', type: 'text', text, waMessageId: r.id, status: r.ok ? 'sent' : 'failed', error: r.error || null, auto: true, at: now() });
  return r;
}
function textOf(m) {
  if (m.type === 'text') return (m.text || {}).body || '';
  if (m.type === 'button') return (m.button || {}).text || '';
  if (m.type === 'interactive') return ((m.interactive || {}).button_reply || (m.interactive || {}).list_reply || {}).title || '';
  if (m.type === 'location') return 'Location: ' + (m.location || {}).latitude + ', ' + (m.location || {}).longitude;
  return '[' + m.type + ' message: open WhatsApp on the phone to view it]';
}
async function handleMessage(value, m) {
  const wa = String(m.from || ''); if (!/^\d{8,15}$/.test(wa)) return;
  if (m.id && await db.col('wa_messages').findOne({ waMessageId: m.id })) return; // Meta retries: handle each message once
  const text = textOf(m);
  const contactName = ((value.contacts || [])[0] || {}).profile ? value.contacts[0].profile.name : null;
  const patient = await db.col('patients').findOne({ $or: [{ phone: '+' + wa }, { whatsapp: '+' + wa }], status: { $ne: 'removed' } });
  const place = await placeForNumber((value.metadata || {}).phone_number_id);
  const emergency = EMERGENCY_WORDS.test(text);
  const emergencyNumbers = S.get('content.global.emergencyNumbers', '112');
  let target = place;
  if (place.platform) {
    // the platform number: route a known patient to their provider
    const provs = patient ? await require('./patients').patientProviders(patient.id) : [];
    const routerConv = await db.col('wa_conversations').findOne({ orgId: null, waId: wa, status: 'open' });
    if (!provs.length) {
      const c = routerConv || await openConversation({ orgId: null, dept: 'router', wa, patient, name: contactName });
      await recordIn(c, m, text);
      await reply(c, emergency ? 'If this is an emergency, call ' + emergencyNumbers + ' now. ' + (config.WHATSAPP.unknownReply || '') : (config.WHATSAPP.unknownReply || 'Welcome.'));
      return;
    }
    if (provs.length === 1) target = { orgId: provs[0].homeOrgId || provs[0].orgIds[0], dept: emergency ? 'emergency' : 'main' };
    else {
      const pick = routerConv && routerConv.awaiting === 'provider' && /^\s*\d{1,2}\s*$/.test(text) ? provs[Number(text.trim()) - 1] : null;
      if (pick) { target = { orgId: pick.homeOrgId || pick.orgIds[0], dept: 'main' }; await db.col('wa_conversations').updateOne({ id: routerConv.id }, { $set: { status: 'closed', awaiting: null } }); }
      else if (!emergency) {
        const c = routerConv || await openConversation({ orgId: null, dept: 'router', wa, patient, name: contactName });
        await recordIn(c, m, text);
        await db.col('wa_conversations').updateOne({ id: c.id }, { $set: { awaiting: 'provider', pendingText: text } });
        await reply(c, 'Which provider is this message for? Reply with the number:\n' + provs.map((p, i) => (i + 1) + ' ' + p.name).join('\n'));
        return;
      } else target = { orgId: provs[0].homeOrgId || provs[0].orgIds[0], dept: 'emergency' };
      if (pick && routerConv && routerConv.pendingText) { const c0 = await openConversation({ orgId: target.orgId, dept: target.dept, wa, patient, name: contactName }); await recordIn(c0, { type: 'text', id: null }, routerConv.pendingText); }
    }
  }
  const dept = emergency ? (target.dept === 'main' || !target.dept ? 'emergency' : target.dept) : (target.dept || 'main');
  // only link the chat to a patient record this provider already holds
  const linked = patient ? await require('./patients').linkOf(target.orgId, patient.id) : null;
  const c = await openConversation({ orgId: target.orgId, dept, wa, patient: linked ? patient : null, name: contactName, fromId: place.platform ? null : (value.metadata || {}).phone_number_id });
  await recordIn(c, m, text);
  if (emergency) {
    await db.col('wa_conversations').updateOne({ id: c.id }, { $set: { priority: 'urgent' } });
    const org = await db.col('orgs').findOne({ id: target.orgId });
    const em = org && org.contacts && org.contacts.emergency && org.contacts.emergency.phone;
    await reply(c, 'If this is an emergency, call ' + (em ? em + ' or ' : '') + emergencyNumbers + ' now. Our team has been alerted and will reply here.');
    for (const role of ['ambulance_dispatcher', 'frontdesk_manager', 'receptionist', 'nurse']) await notify({ orgId: target.orgId, role, title: 'Urgent WhatsApp message', body: 'Someone used an emergency word in a WhatsApp chat. Open the WhatsApp inbox now.', kind: 'whatsapp_urgent', ref: { type: 'wa_conversation', id: c.id } });
  } else {
    const fresh = await db.col('wa_messages').count({ convId: c.id, dir: 'in' });
    if (fresh === 1 && config.WHATSAPP.autoReply) await reply(c, config.WHATSAPP.autoReply);
    await notify({ orgId: target.orgId, role: '*', title: 'New WhatsApp message', body: (c.name || '+' + wa) + ' wrote to ' + (DEPARTMENTS[dept] || dept) + '.', kind: 'whatsapp', ref: { type: 'wa_conversation', id: c.id } });
  }
}
router.post('/whatsapp/webhook', ah(async (req, res) => {
  if (!WA.validSignature(req)) return res.status(401).end();
  const entries = (req.body && req.body.entry) || [];
  for (const e of entries) for (const ch of e.changes || []) {
    const v = ch.value || {};
    for (const st of v.statuses || []) await db.col('wa_messages').updateOne({ waMessageId: st.id }, { $set: { status: st.status, statusAt: now() } });
    for (const m of v.messages || []) { try { await handleMessage(v, m); } catch (err) { console.error('[whatsapp] inbound failed', err.message); } }
  }
  res.json({ ok: true });
}));

/* ---------------- staff inbox ---------------- */
const inbox = A.requireStaff({ perm: 'whatsapp.inbox' });
function deptsFor(req) { return ['owner', 'admin'].includes(req.ctx.role) || !ROLE_DEPTS[req.ctx.role] ? Object.keys(DEPARTMENTS) : ROLE_DEPTS[req.ctx.role]; }
function convView(c) { return { id: c.id, dept: c.dept, deptLabel: DEPARTMENTS[c.dept] || c.dept, phone: c.phone, name: c.name, patientId: c.patientId, status: c.status, priority: c.priority, unread: c.unread || 0, lastAt: c.lastAt, lastText: c.lastText || null, lastInboundAt: c.lastInboundAt, canReplyFreely: !!c.lastInboundAt && now() - c.lastInboundAt < 24 * 3600e3, assignedTo: c.assignedTo || null, assignedName: c.assignedName || null }; }
async function loadConv(req) { const c = await db.col('wa_conversations').findOne({ id: param(req, 'id'), orgId: req.ctx.org.id }); if (!c || !deptsFor(req).includes(c.dept)) throw notFound('Conversation not found'); return c; }
router.get('/wa/conversations', inbox, ah(async (req, res) => {
  const q = query(req, { status: t.enum(['open', 'closed']), dept: t.enum(Object.keys(DEPARTMENTS)), limit: t.int({ min: 1, max: 200 }) });
  const depts = q.dept ? deptsFor(req).filter(d => d === q.dept) : deptsFor(req);
  const rows = await db.col('wa_conversations').find({ orgId: req.ctx.org.id, status: q.status || 'open', dept: { $in: depts } }, { sort: { lastAt: -1 }, limit: q.limit || 100 });
  rows.sort((a, b) => ((b.priority === 'urgent') - (a.priority === 'urgent')) || (b.lastAt - a.lastAt));
  res.json({ conversations: rows.map(convView), departments: Object.fromEntries(deptsFor(req).map(d => [d, DEPARTMENTS[d]])), apiReady: WA.configured() && S.feature('whatsapp'), unreadTotal: rows.reduce((s, c) => s + (c.unread || 0), 0) });
}));
router.get('/wa/conversations/:id', inbox, ah(async (req, res) => {
  const c = await loadConv(req);
  const msgs = await db.col('wa_messages').find({ convId: c.id }, { sort: { at: 1 }, limit: 500 });
  if (c.unread) await db.col('wa_conversations').updateOne({ id: c.id }, { $set: { unread: 0 } });
  let patient = null;
  if (c.patientId) { const P = require('./patients'); const l = await P.linkOf(req.ctx.org.id, c.patientId); const p = l && await db.col('patients').findOne({ id: c.patientId }); if (p) patient = { id: p.id, name: p.firstName + ' ' + p.lastName, mrn: l.mrn }; }
  await audit(req, 'whatsapp.view', { type: 'wa_conversation', id: c.id, patientId: c.patientId || null });
  res.json({ conversation: convView(c), patient, messages: msgs.map(m => ({ id: m.id, dir: m.dir, text: m.text, type: m.type, status: m.status || null, auto: !!m.auto, template: !!m.template, byName: m.byName || null, at: m.at, error: m.error || null })) });
}));
async function staffSend(req, c, text, forceTemplate) {
  if (!WA.configured() || !S.feature('whatsapp')) throw conflict('WhatsApp messaging is not set up yet. Ask MediCore to connect the WhatsApp Business account.', 'whatsapp_off');
  const inWindow = !!c.lastInboundAt && now() - c.lastInboundAt < 24 * 3600e3;
  let r; let template = false;
  if (inWindow && !forceTemplate) r = await WA.sendText(c.phone, text, c.fromPhoneNumberId);
  else {
    // outside the 24-hour window only an approved template may be sent, and only to someone who agreed to WhatsApp
    const p = c.patientId ? await db.col('patients').findOne({ id: c.patientId }) : null;
    if (!p || !p.whatsappOptIn) throw conflict('More than 24 hours have passed since this person last wrote. You can only message them again if they agreed to WhatsApp messages, or when they write again.', 'outside_window');
    r = await WA.sendUpdate(c.phone, req.ctx.org.name, text, c.fromPhoneNumberId); template = true;
  }
  await db.col('wa_messages').insertOne({ id: id('wam'), convId: c.id, dir: 'out', type: 'text', text, template, waMessageId: r.id, status: r.ok ? 'sent' : 'failed', error: r.ok ? null : r.error, byUserId: req.ctx.user.id, byName: req.ctx.user.name, at: now() });
  await db.col('wa_conversations').updateOne({ id: c.id }, { $set: { lastAt: now(), lastText: text.slice(0, 140) } });
  await audit(req, 'whatsapp.reply', { type: 'wa_conversation', id: c.id, patientId: c.patientId || null }, { template, ok: r.ok });
  if (!r.ok) throw conflict('WhatsApp did not accept the message' + (r.error ? ': ' + r.error : '') + '. Try again or call the person.', 'whatsapp_failed');
  return { ok: true, template };
}
router.post('/wa/conversations/:id/reply', inbox, ah(async (req, res) => {
  const b = body(req, { text: t.text({ required: true, max: 2000 }) });
  res.json(await staffSend(req, await loadConv(req), b.text, false));
}));
router.post('/wa/conversations/:id/close', inbox, ah(async (req, res) => {
  const c = await loadConv(req);
  await db.col('wa_conversations').updateOne({ id: c.id }, { $set: { status: 'closed', closedAt: now(), closedBy: req.ctx.user.id, unread: 0 } });
  await audit(req, 'whatsapp.close', { type: 'wa_conversation', id: c.id });
  res.json({ ok: true });
}));
router.post('/wa/conversations/:id/assign', inbox, ah(async (req, res) => {
  const c = await loadConv(req);
  await db.col('wa_conversations').updateOne({ id: c.id }, { $set: { assignedTo: req.ctx.user.id, assignedName: req.ctx.user.name } });
  res.json({ ok: true });
}));
router.post('/wa/conversations/:id/move', inbox, ah(async (req, res) => {
  const b = body(req, { dept: t.enum(Object.keys(DEPARTMENTS), { required: true }) });
  const c = await loadConv(req);
  await db.col('wa_conversations').updateOne({ id: c.id }, { $set: { dept: b.dept } });
  await audit(req, 'whatsapp.move', { type: 'wa_conversation', id: c.id }, { to: b.dept });
  res.json({ ok: true });
}));
router.post('/wa/conversations/:id/link-patient', inbox, ah(async (req, res) => {
  const b = body(req, { patientId: t.id({ required: true }) });
  const c = await loadConv(req);
  const { patient } = await require('./patients').requireLinked(req, b.patientId);
  await db.col('wa_conversations').updateOne({ id: c.id }, { $set: { patientId: patient.id, name: patient.firstName + ' ' + patient.lastName } });
  await audit(req, 'whatsapp.link_patient', { type: 'wa_conversation', id: c.id, patientId: patient.id });
  res.json({ ok: true });
}));
/* start a chat with a registered patient who agreed to WhatsApp (template message) */
router.post('/wa/start', inbox, ah(async (req, res) => {
  const b = body(req, { patientId: t.id({ required: true }), dept: t.enum(Object.keys(DEPARTMENTS)), text: t.text({ required: true, max: 900 }) });
  const { patient } = await require('./patients').requireLinked(req, b.patientId);
  if (!WA.configured() || !S.feature('whatsapp')) throw conflict('WhatsApp messaging is not set up yet. Ask MediCore to connect the WhatsApp Business account.', 'whatsapp_off');
  if (!patient.whatsappOptIn) throw conflict('This patient has not agreed to WhatsApp messages. Ask them first and record it on their record.', 'no_opt_in');
  const to = patient.whatsapp || patient.phone; if (!to) throw bad('This patient has no phone number');
  const dept = b.dept && deptsFor(req).includes(b.dept) ? b.dept : deptsFor(req)[0];
  const fromId = ((req.ctx.org.contacts || {})[dept] || {}).waPhoneNumberId || ((req.ctx.org.contacts || {}).main || {}).waPhoneNumberId || null;
  const c = await openConversation({ orgId: req.ctx.org.id, dept, wa: WA.waId(to), patient, name: null, fromId });
  const r = await staffSend(req, c, b.text, true);
  res.json(Object.assign({ conversationId: c.id }, r));
}));

/* ---------------- automated notifications (called by lib/notify) ---------------- */
async function notifyPatient(patientId, title, bodyText) {
  if (!WA.configured() || !S.feature('whatsapp') || !(config.WHATSAPP || {}).notifyPatients) return { sent: false };
  const p = await db.col('patients').findOne({ id: patientId }, { projection: { whatsappOptIn: 1, whatsapp: 1, phone: 1 } });
  if (!p || !p.whatsappOptIn || !(p.whatsapp || p.phone)) return { sent: false };
  const r = await WA.sendUpdate(p.whatsapp || p.phone, title, bodyText);
  return { sent: r.ok };
}

/* ---------------- HQ ---------------- */
router.get('/hq/whatsapp/numbers', A.requirePlatform('platform.read'), ah(async (req, res) => {
  const out = [];
  const scan = (rows, kind) => rows.forEach(o => Object.entries(o.contacts || {}).forEach(([d, v]) => { if (v && (v.whatsapp || v.waPhoneNumberId)) out.push({ kind, id: o.id, name: o.name, dept: d, deptLabel: DEPARTMENTS[d], whatsapp: v.whatsapp || null, waPhoneNumberId: v.waPhoneNumberId || null }); }));
  scan(await db.col('orgs').find({ status: { $ne: 'rejected' } }), 'provider'); scan(await db.col('groups').find({}), 'group');
  res.json({ platform: { phoneNumberId: (config.WHATSAPP || {}).phoneNumberId || null, configured: WA.configured(), webhookPath: '/api/whatsapp/webhook' }, numbers: out, departments: DEPARTMENTS });
}));

module.exports = { name: 'whatsapp', router, DEPARTMENTS, ROLE_DEPTS, notifyPatient, contactView, handleMessage };
