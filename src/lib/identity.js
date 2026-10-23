'use strict';
/*
 * NIN (National Identification Number) checks through a licensed NIMC verification partner.
 * The partner is chosen and keyed in HQ > Integrations > NIN verification, nothing is hard coded:
 *   dojah    GET  {baseUrl}/api/v1/kyc/nin?nin=...            headers AppId + Authorization (secret key)
 *   prembly  POST {baseUrl}/identitypass/verification/nin     headers app-id + x-api-key, body { number }
 *   custom   any HTTPS API: method, path ({{nin}} placeholder) and where the names sit in the reply
 *   mock     demo and tests only: any 11-digit NIN is found and matches (000... is not found, 999... does not match)
 * Check the exact paths against the partner's current docs when the account is opened; they are editable in HQ.
 *
 * Privacy (NDPA): the NIN itself is never stored. We keep an HMAC of it (to find the same person across
 * providers and stop duplicate records), its last 4 digits, and the result of the check.
 */
const crypto = require('crypto');
const config = require('../config');

const NIN_RE = /^\d{11}$/;
const clean = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
function ninKey() { return crypto.createHash('sha256').update('medicore-nin:' + (process.env.NIN_PEPPER || process.env.SETTINGS_KEY || config.JWT_SECRET || 'dev')).digest(); }
function ninHash(nin) { return crypto.createHmac('sha256', ninKey()).update(String(nin)).digest('hex'); }
function valid(nin) { return NIN_RE.test(String(nin || '')); }

function provider() {
  const c = config.IDENTITY || {};
  let p = c.provider || '';
  if (!p && (config.DEMO_MODE || process.env.NODE_ENV === 'test')) p = 'mock';
  if (p === 'mock' && !(config.DEMO_MODE || process.env.NODE_ENV === 'test')) p = '';   // never fake a check in production
  return Object.assign({}, c, { provider: p });
}
function configured() { const c = provider(); return c.provider === 'mock' || (!!c.provider && !!c.apiKey && !!c.baseUrl); }

const pick = (o, path) => String(path || '').split('.').filter(Boolean).reduce((a, k) => (a == null ? undefined : a[k]), o);

/** look a NIN up. Returns { status: 'found'|'not_found'|'unavailable', person?: { firstName, middleName, lastName, dob, phone, gender } } */
async function lookup(nin) {
  const c = provider();
  if (!valid(nin)) return { status: 'invalid' };
  if (c.provider === 'mock') {
    if (nin.startsWith('000')) return { status: 'not_found' };
    return { status: 'found', person: null, mock: true };
  }
  if (!configured()) return { status: 'unavailable', reason: 'not_configured' };
  const base = c.baseUrl.replace(/\/$/, '');
  try {
    let r;
    if (c.provider === 'dojah') r = await fetch(base + (c.path || '/api/v1/kyc/nin') + '?nin=' + encodeURIComponent(nin), { headers: { AppId: c.appId || '', Authorization: c.apiKey }, signal: AbortSignal.timeout(8000) });
    else if (c.provider === 'prembly') r = await fetch(base + (c.path || '/identitypass/verification/nin'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'app-id': c.appId || '', 'x-api-key': c.apiKey }, body: JSON.stringify({ number: nin }), signal: AbortSignal.timeout(8000) });
    else r = await fetch(base + String(c.path || '').replace('{{nin}}', encodeURIComponent(nin)), { method: c.method || 'GET', headers: { 'Content-Type': 'application/json', [c.headerName || 'Authorization']: c.apiKey }, body: (c.method || 'GET') === 'GET' ? undefined : JSON.stringify({ nin }), signal: AbortSignal.timeout(8000) });
    if (r.status === 404) return { status: 'not_found' };
    if (!r.ok) return { status: 'unavailable', reason: 'http_' + r.status };
    const j = await r.json();
    const d = c.provider === 'dojah' ? j.entity : c.provider === 'prembly' ? (j.nin_data || j.data) : pick(j, c.dataPath || 'data');
    if (!d) return { status: 'not_found' };
    return { status: 'found', person: {
      firstName: d.first_name || d.firstname || d.firstName || '', middleName: d.middle_name || d.middlename || d.middleName || '', lastName: d.last_name || d.surname || d.lastName || '',
      dob: d.date_of_birth || d.birthdate || d.dob || '', phone: d.phone_number || d.telephoneno || d.phone || '', gender: d.gender || '' } };
  } catch (e) { return { status: 'unavailable', reason: 'network' }; }
}

function sameDob(a, b) { if (!a || !b) return true; const n = s => { const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/) || String(s).match(/(\d{2})[-/](\d{2})[-/](\d{4})/); if (!m) return null; return m[1].length === 4 ? m.slice(1).join('-') : [m[3], m[2], m[1]].join('-'); }; const x = n(a), y = n(b); return !x || !y || x === y; }

/**
 * check a NIN against the person in front of us. Never throws for a partner outage: the record is saved as
 * 'pending' and staff see that the NIN still needs confirming.
 * Returns { ninHash, ninLast4, ninStatus: 'verified'|'pending'|'mismatch'|'not_found', ninCheckedAt, ninProvider }
 */
async function verify(nin, who, opts = {}) {
  nin = String(nin || '').replace(/\s+/g, '');
  const base = { ninHash: ninHash(nin), ninLast4: nin.slice(-4), ninCheckedAt: Date.now(), ninProvider: provider().provider || null };
  const r = await lookup(nin);
  if (r.status === 'invalid') return Object.assign(base, { ninStatus: 'invalid' });
  if (r.status === 'not_found') return Object.assign(base, { ninStatus: 'not_found' });
  if (r.status === 'unavailable') return Object.assign(base, { ninStatus: 'pending', ninReason: r.reason });
  if (r.mock) return Object.assign(base, { ninStatus: nin.startsWith('999') ? 'mismatch' : 'verified' });
  const names = [r.person.firstName, r.person.middleName, r.person.lastName].map(clean).filter(Boolean);
  const ok = names.includes(clean(who.firstName)) && names.includes(clean(who.lastName)) && (opts.matchDob === false || sameDob(who.dob, r.person.dob));
  return Object.assign(base, { ninStatus: ok ? 'verified' : 'mismatch' });
}

module.exports = { valid, ninHash, verify, lookup, configured, provider };
