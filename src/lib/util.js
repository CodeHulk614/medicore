'use strict';
const crypto = require('crypto');
const config = require('../config');

/** Unguessable ids: prefix + 16 url-safe random chars (96 bits). */
const id = prefix => prefix + '_' + crypto.randomBytes(12).toString('base64url');
/** Short human code, e.g. pickup / delivery codes. Digits only. */
const digits = n => { let s = ''; while (s.length < n) s += crypto.randomInt(0, 10); return s; };
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const now = () => Date.now();
const iso = (ts) => new Date(ts == null ? Date.now() : ts).toISOString();

/* ---------- time: Africa/Lagos is UTC+1 all year ---------- */
const OFF = config.TZ_OFFSET_MIN * 60000;
/** '2026-10-21','09:00' in Lagos -> UTC epoch ms */
function lagosToUtc(date, time) { const [y, m, d] = date.split('-').map(Number); const [hh, mm] = (time || '00:00').split(':').map(Number); return Date.UTC(y, m - 1, d, hh, mm) - OFF; }
/** epoch ms -> { date:'YYYY-MM-DD', time:'HH:MM', dow:0-6 } in Lagos */
function utcToLagos(ts) { const d = new Date(ts + OFF); return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16), dow: d.getUTCDay() }; }
const todayLagos = () => utcToLagos(Date.now()).date;
const addDays = (date, n) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

/* ---------- money: always integer kobo ---------- */
const naira = n => Math.round(Number(n) * 100);           // NGN -> kobo
const fmtNaira = kobo => 'NGN ' + (Math.round(kobo) / 100).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/* ---------- geo ---------- */
function haversineKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371, toR = x => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
/** rough road ETA when no routing service is configured: 1.4x straight line at 25 km/h city speed */
const etaMinutes = km => (km == null ? null : Math.max(2, Math.round(km * 1.4 / 25 * 60)));

/** mask a phone or email for logs and non-owner views */
const maskPhone = p => (p ? p.slice(0, 7) + '****' + p.slice(-2) : p);
const maskEmail = e => { if (!e) return e; const [u, d] = e.split('@'); return u.slice(0, 2) + '***@' + d; };

const pick = (o, keys) => { const r = {}; keys.forEach(k => { if (o && o[k] !== undefined) r[k] = o[k]; }); return r; };

module.exports = { id, digits, sha256, now, iso, lagosToUtc, utcToLagos, todayLagos, addDays, daysBetween, naira, fmtNaira, haversineKm, etaMinutes, maskPhone, maskEmail, pick };
