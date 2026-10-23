'use strict';
/*
 * Email gateways, chosen in HQ > Configuration > Integrations > Email: SendGrid, Brevo, Mailgun or Resend.
 * Used for off-platform HMO pre-authorisation requests and claim batches, and the HQ test message.
 * send({ to, subject, text, attachments: [{ filename, content (string), type }] }) -> { sent, provider, error? }
 */
const config = require('../config');
const { request } = require('./payments');

const E = () => config.EMAIL || {};
const configured = () => !!(E().provider && E().provider !== 'none' && E().apiKey && E().from);
const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');

async function send({ to, subject, text, attachments, replyTo }) {
  if (!configured()) return { sent: false, error: 'not_configured' };
  const e = E(); const list = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!list.length) return { sent: false, error: 'no_recipient' };
  const atts = attachments || [];
  let r;
  if (e.provider === 'sendgrid') {
    r = await request('https://api.sendgrid.com/v3/mail/send', { method: 'POST', headers: { Authorization: 'Bearer ' + e.apiKey }, json: { personalizations: [{ to: list.map(x => ({ email: x })) }], from: { email: e.from, name: e.fromName }, reply_to: replyTo ? { email: replyTo } : undefined, subject, content: [{ type: 'text/plain', value: text }], attachments: atts.length ? atts.map(a => ({ content: b64(a.content), filename: a.filename, type: a.type || 'text/plain', disposition: 'attachment' })) : undefined } });
    return { sent: r.status === 202, provider: 'sendgrid', error: r.status === 202 ? null : (r.error || 'HTTP ' + r.status) };
  }
  if (e.provider === 'brevo') {
    r = await request('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': e.apiKey }, json: { sender: { email: e.from, name: e.fromName }, to: list.map(x => ({ email: x })), replyTo: replyTo ? { email: replyTo } : undefined, subject, textContent: text, attachment: atts.length ? atts.map(a => ({ name: a.filename, content: b64(a.content) })) : undefined } });
    return { sent: r.status === 201 || r.status === 200, provider: 'brevo', error: r.status < 300 ? null : (r.error || 'HTTP ' + r.status) };
  }
  if (e.provider === 'resend') {
    r = await request('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + e.apiKey }, json: { from: e.fromName + ' <' + e.from + '>', to: list, reply_to: replyTo || undefined, subject, text, attachments: atts.length ? atts.map(a => ({ filename: a.filename, content: b64(a.content) })) : undefined } });
    return { sent: r.status === 200, provider: 'resend', error: r.status === 200 ? null : (r.error || 'HTTP ' + r.status) };
  }
  if (e.provider === 'mailgun') {
    // Mailgun's simple API takes a form; attachments need multipart, so claim files go as text in the body instead
    const host = e.mailgunRegion === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
    const extra = atts.map(a => '\n\n----- ' + a.filename + ' -----\n' + a.content).join('');
    r = await request(host + '/v3/' + encodeURIComponent(e.mailgunDomain) + '/messages', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from('api:' + e.apiKey).toString('base64') }, form: { from: e.fromName + ' <' + e.from + '>', to: list.join(','), subject, text: text + extra, 'h:Reply-To': replyTo || '' } });
    return { sent: r.status === 200, provider: 'mailgun', error: r.status === 200 ? null : (r.error || 'HTTP ' + r.status) };
  }
  return { sent: false, error: 'unknown_provider' };
}

module.exports = { send, configured };
