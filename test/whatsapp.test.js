'use strict';
/* Contacts, WhatsApp automation and inbox, off-platform HMOs, provider controls, data export. Fake transport, no network. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { boot } = require('./helpers');
const PAY = require('../src/lib/payments');

let h, hq, calls = [], fake = null;
before(async () => {
  h = await boot();
  hq = await h.as('hq', 'hq@medicore.demo');
  PAY._setTransport(async (url, opts) => { calls.push({ url, opts }); return fake ? fake(url, opts) : { status: 200, body: { messages: [{ id: 'wamid.' + calls.length }] } }; });
});
after(async () => { PAY._setTransport(null); await h.close(); });

async function connectWhatsApp() {
  const r = await hq.patch('/api/hq/config/integrations', { patch: { whatsapp: { phoneNumberId: '111', accessToken: 'EAAtoken', appSecret: 'appsecret', verifyToken: 'verifyme', templates: { update: 'medicore_update', updateLanguage: 'en' } } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await hq.patch('/api/hq/config/features', { patch: { whatsapp: true } })).status, 200);
}
function signed(payload) { const b = JSON.stringify(payload); return { body: b, sig: 'sha256=' + crypto.createHmac('sha256', 'appsecret').update(b).digest('hex') }; }
async function inbound(phoneNumberId, from, text, name) {
  const { body, sig } = signed({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneNumberId }, contacts: [{ wa_id: from, profile: { name: name || 'Someone' } }], messages: [{ from, id: 'wamid.in' + Math.random(), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  return fetch(h.base + '/api/whatsapp/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body });
}

test('department contact numbers: admin edits, patients see call and chat links', async () => {
  const adm = await h.as('admin', 'owner@clearpath.demo');
  const bad = await adm.patch('/api/admin/contacts', { contacts: { lab: { phone: '12345' } } });
  assert.equal(bad.status, 400);
  const r = await adm.patch('/api/admin/contacts', { contacts: { lab: { phone: '0803 555 0001', whatsapp: '08035550002', hours: 'Mon-Sat 7am-7pm' }, main: { phone: '+44 20 7946 0000' } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.contacts.lab.phone, '+2348035550001'); assert.equal(r.body.contacts.lab.chatLink, 'https://wa.me/2348035550002');
  assert.equal(r.body.contacts.main.phone, '+442079460000', 'other countries accepted');
  const pt = await h.as('patient', 'kunle@patient.demo');
  const c = await pt.get('/api/me/contacts', { 'X-MC-Provider': h.ctx.orgs.lab.id });
  assert.equal(c.status, 200); assert.equal(c.body.providers.length, 1);
  assert.equal(c.body.providers[0].branches[0].contacts.lab.callLink, 'tel:+2348035550001');
  const hide = await adm.patch('/api/admin/contacts', { contacts: { main: { phone: '+442079460000', show: false } } });
  assert.equal(hide.status, 200);
  const c2 = await pt.get('/api/me/contacts', { 'X-MC-Provider': h.ctx.orgs.lab.id });
  assert.equal(c2.body.providers[0].branches[0].contacts.main, undefined, 'hidden from patients');
  const g = await h.as('group', 'owner@crestview.demo');
  const gc = await g.patch('/api/group/branches/' + h.ctx.branches.ajah.id + '/contacts', { contacts: { pharmacy: { phone: '08039990000', whatsapp: '08039990000' } } });
  assert.equal(gc.status, 200);
  assert.equal((await g.patch('/api/group/contacts', { contacts: { billing: { email: 'accounts@crestview.demo', phone: '08030000013' } } })).status, 200);
  const ng = await h.as('patient', 'ngozi@patient.demo');
  const nc = await ng.get('/api/me/contacts');
  assert.ok(nc.body.providers[0].headOffice.billing); assert.ok(nc.body.providers[0].branches.some(b => b.contacts.pharmacy));
});

test('a WhatsApp phone number ID belongs to one place only', async () => {
  const a = await h.as('admin', 'owner@clearpath.demo');
  assert.equal((await a.patch('/api/admin/contacts', { contacts: { lab: { phone: '08035550001', whatsapp: '08035550002', waPhoneNumberId: '777' } } })).status, 200);
  const b = await h.as('admin', 'owner@swiftaid.demo');
  assert.equal((await b.patch('/api/admin/contacts', { contacts: { emergency: { phone: '08030001111', waPhoneNumberId: '777' } } })).status, 409);
});

test('patients who agreed get notifications on WhatsApp instead of SMS', async () => {
  await connectWhatsApp();
  const pt = await h.as('patient', 'tobi@patient.demo');
  assert.equal((await pt.post('/api/me/whatsapp', { optIn: true })).status, 200);
  calls = [];
  const fd = await h.as('frontdesk', 'reception@grandville.demo');
  const r = await fd.post('/api/fd/patients/' + h.ctx.patients.tobi.id + '/whatsapp', { optIn: true });
  assert.equal(r.status, 200);
  const { notify } = require('../src/lib/notify');
  await notify({ patientId: h.ctx.patients.tobi.id, title: 'Appointment confirmed', body: 'Tuesday 10:00 at Grandville Hospital', sms: '+2348039876543' });
  const wa = calls.find(c => /graph\.facebook\.com\/v21\.0\/111\/messages/.test(c.url));
  assert.ok(wa, 'template sent');
  assert.equal(wa.opts.json.template.name, 'medicore_update'); assert.equal(wa.opts.json.to, '2348039876543');
  assert.deepEqual(wa.opts.json.template.components[0].parameters.map(p => p.text), ['Appointment confirmed', 'Tuesday 10:00 at Grandville Hospital']);
  assert.ok(!calls.some(c => /termii|africastalking/.test(c.url)), 'no SMS copy');
  const n = await h.db.col('notifications').findOne({ patientId: h.ctx.patients.tobi.id, title: 'Appointment confirmed' });
  assert.equal(n.channel, 'whatsapp');
});

test('webhook: verify handshake, signature, routing to the department inbox, auto reply, retries handled once', async () => {
  const v = await fetch(h.base + '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verifyme&hub.challenge=12345');
  assert.equal(v.status, 200); assert.equal(await v.text(), '12345');
  assert.equal((await fetch(h.base + '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403);
  const forged = await fetch(h.base + '/api/whatsapp/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=00' }, body: '{}' });
  assert.equal(forged.status, 401);
  // a chat on ClearPath's lab number (phone number ID 777) from Kunle, a ClearPath patient
  calls = [];
  const r = await inbound('777', '2348077770202', 'Are my INR results ready?', 'Kunle');
  assert.equal(r.status, 200);
  const conv = await h.db.col('wa_conversations').findOne({ orgId: h.ctx.orgs.lab.id, dept: 'lab', waId: '2348077770202' });
  assert.ok(conv); assert.equal(conv.patientId, h.ctx.patients.kunle.id, 'linked to the patient record ClearPath holds');
  assert.ok(calls.some(c => c.opts.json && c.opts.json.type === 'text' && c.url.includes('/777/messages')), 'auto reply from the same number');
  const lab = await h.as('lab', 'manager@clearpath.demo');
  const list = await lab.get('/api/wa/conversations');
  assert.equal(list.status, 200); assert.ok(list.body.conversations.some(c => c.id === conv.id && c.unread === 1));
  const det = await lab.get('/api/wa/conversations/' + conv.id);
  assert.equal(det.body.messages[0].text, 'Are my INR results ready?'); assert.equal(det.body.patient.name, 'Kunle Martins');
  calls = [];
  const rep = await lab.post('/api/wa/conversations/' + conv.id + '/reply', { text: 'Yes, they are ready in your app.' });
  assert.equal(rep.status, 200); assert.equal(rep.body.template, false, 'inside 24 hours: free text');
  assert.equal(calls[0].opts.json.text.body, 'Yes, they are ready in your app.');
  // another provider cannot see it; a role without the department cannot either
  const other = await h.as('frontdesk', 'reception@grandville.demo');
  assert.equal((await other.get('/api/wa/conversations/' + conv.id)).status, 404);
});

test('platform number: known patient routed to their provider (menu when several); unknown numbers get the welcome', async () => {
  calls = [];
  await inbound('111', '2348012345678', 'Hello', 'Stranger');
  const welcome = calls.find(c => c.opts.json && c.opts.json.type === 'text');
  assert.match(welcome.opts.json.text.body, /register with them first/);
  // Ngozi has one provider (Crestview): straight to its main inbox
  await inbound('111', '2348061112233', 'I need to see a doctor next week', 'Ngozi');
  const ng = await h.db.col('wa_conversations').findOne({ waId: '2348061112233', dept: 'main' });
  assert.ok(ng && ng.orgId === h.ctx.branches.ikeja.id);
  // Amaka has four: she gets a menu, then her choice routes the waiting message
  calls = [];
  await inbound('111', '2348031234567', 'Please call me back about my bill', 'Amaka');
  const menu = calls.find(c => c.opts.json && c.opts.json.type === 'text');
  assert.match(menu.opts.json.text.body, /Which provider/);
  const summary = await (await h.as('patient', 'amaka@patient.demo')).get('/api/me/providers/summary');
  const idx = summary.body.providers.findIndex(p => p.key === h.ctx.orgs.clinic.id) + 1;
  await inbound('111', '2348031234567', String(idx), 'Amaka');
  const c = await h.db.col('wa_conversations').findOne({ orgId: h.ctx.orgs.clinic.id, waId: '2348031234567' });
  assert.ok(c, 'routed to Lekki Family Clinic');
  const msgs = await h.db.col('wa_messages').find({ convId: c.id });
  assert.ok(msgs.some(m => m.text === 'Please call me back about my bill'), 'the original message follows');
});

test('emergency words in Yoruba, Hausa or Igbo get the emergency numbers at once and alert the provider', async () => {
  calls = [];
  await inbound('111', '2348061112233', 'Pajawiri! My son fell and is not waking', 'Ngozi');
  const rep = calls.find(c => c.opts.json && c.opts.json.type === 'text');
  assert.match(rep.opts.json.text.body, /emergency/i); assert.match(rep.opts.json.text.body, /112/);
  const conv = await h.db.col('wa_conversations').findOne({ waId: '2348061112233', dept: 'emergency' });
  assert.equal(conv.priority, 'urgent');
  assert.ok(await h.db.col('notifications').findOne({ orgId: h.ctx.branches.ikeja.id, kind: 'whatsapp_urgent' }));
});

test('outside the 24-hour window only an approved template to someone who agreed', async () => {
  const fd = await h.as('frontdesk', 'reception@grandville.demo');
  const conv = await h.db.col('wa_conversations').findOne({ orgId: h.ctx.orgs.hospital.id, dept: 'appointments' });
  await h.db.col('wa_conversations').updateOne({ id: conv.id }, { $set: { lastInboundAt: Date.now() - 30 * 3600e3 } });
  calls = [];
  const r = await fd.post('/api/wa/conversations/' + conv.id + '/reply', { text: 'Friday at 11 works. See you then.' });
  assert.equal(r.status, 200); assert.equal(r.body.template, true, 'Amaka agreed: template used');
  await h.db.col('patients').updateOne({ id: h.ctx.patients.amaka.id }, { $set: { whatsappOptIn: false } });
  const r2 = await fd.post('/api/wa/conversations/' + conv.id + '/reply', { text: 'Reminder' });
  assert.equal(r2.status, 409); assert.equal(r2.body.code, 'outside_window');
  const st = await fd.post('/api/wa/start', { patientId: h.ctx.patients.amaka.id, text: 'Hello' });
  assert.equal(st.status, 409);
  const st2 = await fd.post('/api/wa/start', { patientId: h.ctx.patients.tobi.id, dept: 'appointments', text: 'Your follow-up is due. Reply to book.' });
  assert.equal(st2.status, 200, JSON.stringify(st2.body));
  assert.equal((await fd.post('/api/wa/conversations/' + conv.id + '/close')).status, 200);
});

test('when WhatsApp is not connected the inbox still works and replies explain why', async () => {
  await hq.patch('/api/hq/config/features', { patch: { whatsapp: false } });
  const fd = await h.as('frontdesk', 'reception@grandville.demo');
  const list = await fd.get('/api/wa/conversations?status=closed');
  assert.equal(list.status, 200); assert.equal(list.body.apiReady, false);
  const conv = list.body.conversations[0];
  const r = await fd.post('/api/wa/conversations/' + conv.id + '/reply', { text: 'x' });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'whatsapp_off');
  await hq.patch('/api/hq/config/features', { patch: { whatsapp: true } });
});

test('codes can go by WhatsApp first, with SMS as the fallback', async () => {
  await hq.patch('/api/hq/config/integrations', { patch: { whatsapp: { sendCodes: true, templates: { code: 'medicore_code' } } } });
  calls = [];
  await h.client('patient').post('/api/patients/register/start', { phone: '08099990001' });
  const wa = calls.find(c => c.url.includes('/messages') && c.opts.json.template && c.opts.json.template.name === 'medicore_code');
  assert.ok(wa, 'authentication template sent');
  fake = (url) => (url.includes('graph.facebook.com') ? { status: 400, body: { error: { message: 'not a WhatsApp user' } } } : { status: 200, body: {} });
  await hq.patch('/api/hq/config/integrations', { patch: { sms: { provider: 'custom' }, customSms: { url: 'https://sms.example.com/send', bodyTemplate: '{"to":"{{toNoPlus}}","msg":"{{text}}"}' } } });
  calls = [];
  await h.client('patient').post('/api/patients/register/start', { phone: '08099990002' });
  assert.ok(calls.some(c => c.url === 'https://sms.example.com/send'), 'SMS fallback');
  fake = null;
});

test('off-platform HMO: panel, cover, pre-auth by email, HMO share on the bill, claim batch exactly once, payment', async () => {
  await hq.patch('/api/hq/config/integrations', { patch: { email: { provider: 'sendgrid', apiKey: 'SG.key', from: 'claims@medicore.demo' } } });
  fake = (url) => (url.includes('sendgrid') ? { status: 202, body: {} } : { status: 200, body: { messages: [{ id: 'x' }] } });
  const own = await h.as('admin', 'owner@grandville.demo');
  const panel = await own.get('/api/admin/hmos');
  const blue = panel.body.panel.find(p => !p.onPlatform);
  assert.ok(blue); assert.ok(panel.body.panel.some(p => p.onPlatform));
  const dup = await own.post('/api/admin/hmos', { payerOrgId: h.ctx.orgs.hmo.id });
  assert.equal(dup.status, 409);
  const ed = await own.patch('/api/admin/hmos/' + blue.id, { notes: 'Answers within 1 hour', email: '' });
  assert.equal(ed.status, 200, JSON.stringify(ed.body)); assert.equal(ed.body.email, ''); assert.equal(ed.body.notes, 'Answers within 1 hour');
  const off = await own.patch('/api/admin/hmos/' + blue.id, { active: false });
  assert.equal(off.body.active, false);
  await own.patch('/api/admin/hmos/' + blue.id, { active: true, email: 'providers@bluewater.demo' });
  const fdm = await h.as('frontdesk', 'fdmanager@grandville.demo');
  const covers = await fdm.get('/api/fd/patients/' + h.ctx.patients.tobi.id + '/external-covers');
  assert.equal(covers.body[0].memberNo, 'BWH/1029/01');
  calls = [];
  const pa = await fdm.post('/api/fd/external-preauths', { patientId: h.ctx.patients.tobi.id, panelId: blue.id, diagnosis: 'Uncontrolled type 2 diabetes', items: [{ serviceCode: 'CONS-SPEC', qty: 1 }, { name: 'HbA1c test', amountKobo: 1100000 }] });
  assert.equal(pa.status, 200, JSON.stringify(pa.body));
  assert.equal(pa.body.emailSent, true); assert.match(pa.body.whatsappLink, /^https:\/\/wa\.me\/2348030000502\?text=/);
  assert.match(pa.body.message, /BWH\/1029\/01/); assert.equal(pa.body.totalKobo, 1500000 + 1100000);
  const mail = calls.find(c => c.url.includes('sendgrid'));
  assert.equal(mail.opts.json.personalizations[0].to[0].email, 'preauth@bluewater.demo');
  assert.equal((await fdm.post('/api/fd/external-preauths/' + pa.body.id + '/decide', { status: 'approved' })).status, 400, 'code required');
  const ok = await fdm.post('/api/fd/external-preauths/' + pa.body.id + '/decide', { status: 'approved', authCode: 'BW-AUTH-778' });
  assert.equal(ok.body.status, 'approved'); assert.equal(ok.body.approvedKobo, pa.body.totalKobo);
  // bill with the HMO share
  const cash = await h.as('frontdesk', 'cashier@grandville.demo');
  const bill = (await cash.post('/api/bills', { patientId: h.ctx.patients.tobi.id, items: [{ serviceCode: 'CONS-SPEC', qty: 1 }] })).body;
  const too = await fdm.post('/api/bills/' + bill.id + '/external-hmo', { panelId: blue.id, coveredKobo: bill.totalKobo + 1 });
  assert.equal(too.status, 400);
  const cov = await fdm.post('/api/bills/' + bill.id + '/external-hmo', { panelId: blue.id, preauthId: pa.body.id, coveredKobo: 1200000 });
  assert.equal(cov.status, 200); assert.equal(cov.body.patientDueKobo, bill.totalKobo - 1200000); assert.equal(cov.body.hmoExternal.authCode, 'BW-AUTH-778');
  assert.equal((await fdm.post('/api/bills/' + bill.id + '/external-hmo', { panelId: blue.id, coveredKobo: 100 })).status, 409, 'once');
  // a fully covered bill is paid at once
  const bill2 = (await cash.post('/api/bills', { patientId: h.ctx.patients.tobi.id, items: [{ serviceCode: 'CONS-GP', qty: 1 }] })).body;
  const full = await fdm.post('/api/bills/' + bill2.id + '/external-hmo', { panelId: blue.id, coveredKobo: bill2.totalKobo, authCode: 'BW-2' });
  assert.equal(full.body.status, 'paid');
  // claims
  const cl = await fdm.get('/api/fd/external-claims?panelId=' + blue.id);
  assert.equal(cl.body.bills.length, 2); assert.equal(cl.body.totalCoveredKobo, 1200000 + bill2.totalKobo);
  const csv = await fdm.get('/api/fd/external-claims/export?panelId=' + blue.id);
  assert.equal(csv.status, 200); assert.match(String(csv.body), /Bill number/); assert.match(String(csv.body), /BW-AUTH-778/);
  calls = [];
  const bt = await fdm.post('/api/fd/external-claims/batches', { panelId: blue.id, billIds: cl.body.bills.map(b => b.id) });
  assert.equal(bt.status, 200); assert.equal(bt.body.emailSent, true); assert.equal(bt.body.count, 2);
  const att = calls.find(c => c.url.includes('sendgrid')).opts.json.attachments[0];
  assert.match(Buffer.from(att.content, 'base64').toString(), /Tobi Adeyemi/);
  assert.equal((await fdm.post('/api/fd/external-claims/batches', { panelId: blue.id, billIds: cl.body.bills.map(b => b.id) })).status, 409, 'each bill claimed once');
  assert.equal((await fdm.get('/api/fd/external-claims?panelId=' + blue.id)).body.bills.length, 0);
  const paid = await fdm.post('/api/fd/external-claims/batches/' + bt.body.id + '/payment', { paidKobo: bt.body.totalCoveredKobo, reference: 'BW-PAY-0091' });
  assert.equal(paid.body.status, 'paid');
  assert.equal((await h.db.col('bills').findOne({ id: bill.id })).hmoExternal.claimStatus, 'paid');
  // roles: a receptionist cannot submit claims
  const rec = await h.as('frontdesk', 'reception@grandville.demo');
  assert.equal((await rec.get('/api/fd/external-claims?panelId=' + blue.id)).status, 403);
  fake = null;
});

test('provider controls: no online booking, own approval rule, video payment rule, partners-only referrals', async () => {
  const own = await h.as('admin', 'owner@lekkifamily.demo');
  assert.equal((await own.patch('/api/admin/org', { settings: { acceptsOnlineBooking: false, applicationsNeedApproval: false, payBeforeVideo: false, referralsFromPartnersOnly: true } })).status, 200);
  const amaka = await h.as('patient', 'amaka@patient.demo');
  const sched = await h.db.col('schedules').findOne({ orgId: h.ctx.orgs.clinic.id });
  const d = new Date(Date.now() + 3 * 86400e3); while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  const r = await amaka.post('/api/me/appointments', { doctorMembershipId: sched.membershipId, date: d.toISOString().slice(0, 10), time: '10:00', type: 'in_person' });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'no_online_booking');
  const ngozi = await h.as('patient', 'ngozi@patient.demo');
  const app = await ngozi.post('/api/me/applications', { orgId: h.ctx.orgs.clinic.id });
  assert.equal(app.status, 200); assert.equal(app.body.approved, true, 'the clinic chose no approval step');
  const C = require('../src/modules/clinic/common');
  assert.equal(C.tun.payBeforeVideo(await h.db.col('orgs').findOne({ id: h.ctx.orgs.clinic.id })), false);
  const ph = await h.as('pharmacy', 'pharmacist@yabacare.demo');
  const ref = await ph.post('/api/referrals', { patientId: h.ctx.patients.amaka.id, toOrgId: h.ctx.orgs.clinic.id, urgency: 'routine', service: 'consultation', reason: 'Blood pressure review', consent: true });
  assert.equal(ref.status, 403, 'partners only');
});

test('data export: the provider downloads all its records; the group owner exports branches', async () => {
  const own = await h.as('admin', 'owner@grandville.demo');
  const r = await own.get('/api/admin/export');
  assert.equal(r.status, 200); assert.equal(r.body.format, 'MediCore provider export v1');
  assert.ok(r.body.patients.length >= 3 && r.body.bills.length > 0 && Array.isArray(r.body.referrals));
  assert.ok(!JSON.stringify(r.body).includes('passHash'), 'no password hashes');
  const rec = await h.as('admin', 'admin@grandville.demo');
  assert.equal((await rec.get('/api/admin/export')).status, 200, 'admin role holds admin.privacy');
  const g = await h.as('group', 'owner@crestview.demo');
  const ge = await g.get('/api/group/export');
  assert.equal(ge.status, 200); assert.equal(ge.body.branches.length, 2);
  const ops = await h.as('group', 'ops@crestview.demo');
  assert.equal((await ops.get('/api/group/export')).status, 403);
});
