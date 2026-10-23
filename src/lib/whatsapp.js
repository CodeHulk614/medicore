'use strict';
/*
 * WhatsApp Business Platform (Meta Cloud API).
 *
 * Set up once in HQ > Configuration > Integrations > WhatsApp: access token, app secret, verify token, the platform's
 * default phone number ID, and the names of two approved message templates:
 *   update  body with two variables: {{1}} = title (e.g. "Appointment confirmed"), {{2}} = details
 *   code    an authentication template for sign-in and verification codes (optional)
 * Providers and their departments can each have their own WhatsApp number (Admin > Contacts): the plain number gives
 * patients a click-to-chat button with no setup at all; adding the number's "phone number ID" (after the number is added
 * to the platform's WhatsApp Business Account in Meta) also routes incoming chats on that number to that department's inbox.
 *
 * Business-initiated messages must use an approved template and the person must have agreed to WhatsApp messages.
 * Free text replies are allowed only within 24 hours of the person's last message (Meta's customer service window).
 */
const crypto = require('crypto');
const config = require('../config');
const { request } = require('./payments');

const W = () => config.WHATSAPP || {};
const configured = () => !!(W().accessToken && W().phoneNumberId);
const base = () => 'https://graph.facebook.com/' + (W().apiVersion || 'v21.0');
/** +2348031234567 -> 2348031234567 (WhatsApp ids are digits with country code) */
const waId = phone => String(phone || '').replace(/[^\d]/g, '');
/** normalise any phone (Nigerian 0803..., +234..., or another country +44...) to +digits, or null */
function normIntl(raw) {
  if (raw == null || raw === '') return null;
  let s = String(raw).replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^0[789][01]\d{8}$/.test(s)) s = '+234' + s.slice(1);
  else if (/^234[789][01]\d{8}$/.test(s)) s = '+' + s;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}
/** a wa.me click-to-chat link (works without any API setup) */
const chatLink = (phone, text) => { const d = waId(phone); return d ? 'https://wa.me/' + d + (text ? '?text=' + encodeURIComponent(text) : '') : null; };

async function post(fromId, payload) {
  const r = await request(base() + '/' + encodeURIComponent(fromId || W().phoneNumberId) + '/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + W().accessToken }, json: Object.assign({ messaging_product: 'whatsapp' }, payload) });
  const id = r.body && r.body.messages && r.body.messages[0] && r.body.messages[0].id;
  return { ok: r.status === 200 && !!id, id: id || null, status: r.status, error: r.error || (r.body && r.body.error && r.body.error.message) || null };
}
/** free text (only inside the 24-hour window) */
const sendText = (to, text, fromId) => (configured() ? post(fromId, { recipient_type: 'individual', to: waId(to), type: 'text', text: { preview_url: false, body: String(text).slice(0, 4000) } }) : Promise.resolve({ ok: false, error: 'not_configured' }));
/** an approved template with body variables */
function sendTemplate(to, name, lang, params, fromId) {
  if (!configured() || !name) return Promise.resolve({ ok: false, error: !name ? 'no_template' : 'not_configured' });
  const components = params && params.length ? [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p == null ? '' : p).slice(0, 1000).replace(/\s*\n\s*/g, ' ') })) }] : [];
  return post(fromId, { to: waId(to), type: 'template', template: { name, language: { code: lang || 'en' }, components } });
}
/** the standard "update" template: {{1}} title, {{2}} details */
const sendUpdate = (to, title, body, fromId) => sendTemplate(to, (W().templates || {}).update, (W().templates || {}).updateLanguage || 'en', [title, body || ' '], fromId);
/** authentication template for codes (Meta requires the code as the body variable and a copy-code button) */
function sendCode(to, code) {
  const t = W().templates || {};
  if (!configured() || !t.code) return Promise.resolve({ ok: false, error: 'no_template' });
  return post(null, { to: waId(to), type: 'template', template: { name: t.code, language: { code: t.codeLanguage || 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: String(code) }] }, { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(code) }] }] } });
}
/** webhook signature: X-Hub-Signature-256: sha256=<HMAC-SHA256(appSecret, raw body)> */
function validSignature(req) {
  if (!W().appSecret) return false;
  const sig = String(req.headers['x-hub-signature-256'] || '');
  const exp = 'sha256=' + crypto.createHmac('sha256', W().appSecret).update(req.rawBody || '').digest('hex');
  return sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp));
}
async function phoneInfo(fromId) {
  if (!W().accessToken) return { ok: false, error: 'No access token saved' };
  const r = await request(base() + '/' + encodeURIComponent(fromId || W().phoneNumberId) + '?fields=display_phone_number,verified_name,quality_rating', { headers: { Authorization: 'Bearer ' + W().accessToken } });
  return r.status === 200 ? { ok: true, info: r.body } : { ok: false, status: r.status, error: r.error || (r.body && r.body.error && r.body.error.message) || 'Rejected' };
}

module.exports = { configured, sendText, sendTemplate, sendUpdate, sendCode, validSignature, phoneInfo, chatLink, waId, normIntl };
