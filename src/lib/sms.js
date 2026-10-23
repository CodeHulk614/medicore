'use strict';
/*
 * SMS gateways, switchable in HQ > Configuration > Integrations > SMS:
 *   termii          Termii (Nigerian DND route)
 *   africastalking  Africa's Talking
 *   custom          any HTTP SMS API, described in HQ: URL, method, JSON or form body template with {{to}} {{text}} {{sender}},
 *                   an auth header and the HTTP status that means "accepted"
 *   none            no SMS (codes then only work in demo mode)
 * send(to, text) -> { sent, mode }. Logs never contain the message text.
 */
const config = require('../config');
const { request, fill } = require('./payments');
const { maskPhone } = require('./util');

const termii = {
  configured: () => !!config.TERMII_KEY,
  async send(to, text) { const r = await request('https://api.ng.termii.com/api/sms/send', { method: 'POST', json: { to: to.replace('+', ''), from: config.TERMII_SENDER, sms: text, type: 'plain', channel: 'dnd', api_key: config.TERMII_KEY } }); return r.status === 200; },
};
const at = () => (config.SMS || {}).africastalking || {};
const africastalking = {
  configured: () => !!(at().username && at().apiKey),
  async send(to, text) {
    const form = { username: at().username, to, message: text }; if (at().senderId) form.from = at().senderId;
    const host = at().username === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
    const r = await request(host + '/version1/messaging', { method: 'POST', headers: { apiKey: at().apiKey }, form });
    return r.status === 201 || r.status === 200;
  },
};
const cs = () => (config.SMS || {}).custom || {};
const custom = {
  configured: () => !!(cs().url && cs().bodyTemplate),
  async send(to, text) {
    const c = cs(); const vars = { to, toNoPlus: to.replace('+', ''), text, sender: config.TERMII_SENDER || 'MediCore' };
    const h = {}; if (c.token) h[c.headerName || 'Authorization'] = c.headerName && c.headerName !== 'Authorization' ? c.token : 'Bearer ' + c.token;
    let r;
    if (c.contentType === 'form') { const form = {}; new URLSearchParams(fill(c.bodyTemplate, vars, false)).forEach((v, k) => { form[k] = v; }); r = await request(c.url, { method: c.method || 'POST', headers: h, form }); }
    else { let json; try { json = JSON.parse(fill(c.bodyTemplate, vars, true)); } catch (e) { return false; } r = await request(c.url, { method: c.method || 'POST', headers: h, json }); }
    return r.status === (Number(c.successStatus) || 200);
  },
};
const GATEWAYS = { termii, africastalking, custom };
function active() { const n = (config.SMS && config.SMS.provider) || 'termii'; const g = GATEWAYS[n]; return { name: n, configured: !!(g && g.configured()), gateway: g || null }; }

async function send(to, text) {
  if (!to) return { sent: false };
  const g = active();
  if (!g.configured) { if (!config.isTest) console.log('[sms:dev] to', maskPhone(to), '(' + text.length + ' chars, not sent)'); return { sent: false, mode: 'dev' }; }
  let ok = false; try { ok = await g.gateway.send(to, text); } catch (e) { ok = false; }
  if (!ok) console.warn('[sms] failed for', maskPhone(to), 'via', g.name);
  return { sent: ok, mode: 'live', provider: g.name };
}

module.exports = { send, active, GATEWAYS };
