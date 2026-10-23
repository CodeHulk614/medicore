'use strict';
/*
 * HTTP helpers: async route wrapper, typed errors, and a strict input validator.
 *
 * Every route handler is written as  router.post('/x', ah(async (req, res) => { ... }))
 * so a thrown error becomes a JSON response instead of crashing the process.
 *
 * Input is never trusted: body(req, schema) returns ONLY the fields in the schema,
 * coerced and checked, and throws a 400 listing every bad field. Unknown fields are dropped,
 * which blocks mass-assignment (a client cannot set role, status, orgId, price...).
 */
class HttpError extends Error {
  constructor(status, message, code, details) { super(message); this.status = status; this.code = code || undefined; this.details = details || undefined; }
}
const bad = (msg, details) => new HttpError(400, msg, 'bad_request', details);
const unauthorized = msg => new HttpError(401, msg || 'Please sign in', 'unauthorized');
const forbidden = msg => new HttpError(403, msg || 'You do not have access to this', 'forbidden');
const notFound = msg => new HttpError(404, msg || 'Not found', 'not_found');
const conflict = (msg, code) => new HttpError(409, msg, code || 'conflict');
const locked = (msg, code) => new HttpError(423, msg, code || 'locked');
const tooMany = msg => new HttpError(429, msg || 'Too many attempts. Please wait and try again.', 'rate_limited');

const ah = fn => (req, res, next) => { Promise.resolve().then(() => fn(req, res, next)).catch(next); };

/* ---------------- validation ---------------- */
const PHONE_RE = /^\+234[789][01]\d{8}$/;
function normPhone(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^0[789][01]\d{8}$/.test(s)) s = '+234' + s.slice(1);
  else if (/^234[789][01]\d{8}$/.test(s)) s = '+' + s;
  return PHONE_RE.test(s) ? s : null;
}
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

function rule(type, opts = {}) { return Object.assign({ type }, opts); }
const t = {
  str: (o) => rule('str', o), text: (o) => rule('str', Object.assign({ max: 2000 }, o)),
  int: (o) => rule('int', o), num: (o) => rule('num', o), bool: (o) => rule('bool', o),
  enum: (values, o) => rule('enum', Object.assign({ values }, o)),
  email: (o) => rule('email', o), phone: (o) => rule('phone', o),
  date: (o) => rule('date', o), time: (o) => rule('time', o),
  id: (o) => rule('id', o), money: (o) => rule('money', o),
  lat: (o) => rule('num', Object.assign({ min: -90, max: 90 }, o)), lng: (o) => rule('num', Object.assign({ min: -180, max: 180 }, o)),
  arr: (of, o) => rule('arr', Object.assign({ of }, o)), obj: (shape, o) => rule('obj', Object.assign({ shape }, o)),
  any: (o) => rule('any', o),
};

function check(val, r, path, errs) {
  const label = r.label || path;
  if (val === undefined || val === null || (val === '' && r.type !== 'str')) {
    if (r.required) errs.push({ field: path, error: label + ' is required' });
    return r.default !== undefined ? r.default : undefined;
  }
  switch (r.type) {
    case 'str': {
      if (typeof val !== 'string' && typeof val !== 'number') { errs.push({ field: path, error: label + ' must be text' }); return; }
      let s = String(val); if (r.trim !== false) s = s.trim();
      if (r.required && !s) { errs.push({ field: path, error: label + ' is required' }); return; }
      const max = r.max != null ? r.max : 200;
      if (s.length > max) { errs.push({ field: path, error: label + ' is too long (max ' + max + ')' }); return; }
      if (r.min && s.length < r.min) { errs.push({ field: path, error: label + ' must be at least ' + r.min + ' characters' }); return; }
      if (r.pattern && !r.pattern.test(s)) { errs.push({ field: path, error: label + ' is not valid' }); return; }
      if (r.plain) s = s.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim(); // names, addresses: plain text only (defence in depth; the apps escape too)
      if (r.lower) s = s.toLowerCase(); if (r.upper) s = s.toUpperCase();
      return s;
    }
    case 'int': case 'money': {
      const n = typeof val === 'string' && val.trim() !== '' ? Number(val) : val;
      if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) { errs.push({ field: path, error: label + ' must be a whole number' }); return; }
      const min = r.min != null ? r.min : (r.type === 'money' ? 0 : -1e12); const max = r.max != null ? r.max : (r.type === 'money' ? 100000000000 : 1e12);
      if (n < min || n > max) { errs.push({ field: path, error: label + ' must be between ' + min + ' and ' + max }); return; }
      return n;
    }
    case 'num': {
      const n = typeof val === 'string' && val.trim() !== '' ? Number(val) : val;
      if (typeof n !== 'number' || !Number.isFinite(n)) { errs.push({ field: path, error: label + ' must be a number' }); return; }
      if ((r.min != null && n < r.min) || (r.max != null && n > r.max)) { errs.push({ field: path, error: label + ' is out of range' }); return; }
      return n;
    }
    case 'bool': if (typeof val === 'boolean') return val; if (val === 'true' || val === 1) return true; if (val === 'false' || val === 0) return false; errs.push({ field: path, error: label + ' must be true or false' }); return;
    case 'enum': if (!r.values.includes(val)) { errs.push({ field: path, error: label + ' must be one of: ' + r.values.join(', ') }); return; } return val;
    case 'email': { const s = String(val).trim().toLowerCase(); if (s.length > 160 || !EMAIL_RE.test(s)) { errs.push({ field: path, error: 'Enter a valid email address' }); return; } return s; }
    case 'phone': { const p = normPhone(val); if (!p) { errs.push({ field: path, error: 'Enter a valid Nigerian phone number, for example 0803 123 4567' }); return; } return p; }
    case 'date': { const s = String(val).trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s + 'T00:00:00Z'))) { errs.push({ field: path, error: label + ' must be a date (YYYY-MM-DD)' }); return; } return s; }
    case 'time': { const s = String(val).trim(); const m = s.match(/^([01]\d|2[0-3]):([0-5]\d)$/); if (!m) { errs.push({ field: path, error: label + ' must be a time (HH:MM)' }); return; } return s; }
    case 'id': { const s = String(val).trim(); if (!/^[A-Za-z0-9_-]{3,64}$/.test(s)) { errs.push({ field: path, error: label + ' is not a valid id' }); return; } return s; }
    case 'arr': {
      if (!Array.isArray(val)) { errs.push({ field: path, error: label + ' must be a list' }); return; }
      const max = r.max != null ? r.max : 100; if (val.length > max) { errs.push({ field: path, error: label + ' has too many items (max ' + max + ')' }); return; }
      if (r.min && val.length < r.min) { errs.push({ field: path, error: label + ' needs at least ' + r.min + ' item(s)' }); return; }
      return val.map((x, i) => check(x, r.of, path + '[' + i + ']', errs));
    }
    case 'obj': {
      if (typeof val !== 'object' || Array.isArray(val)) { errs.push({ field: path, error: label + ' must be an object' }); return; }
      return clean(val, r.shape, path + '.', errs);
    }
    case 'any': { const s = JSON.stringify(val); if (s.length > (r.maxBytes || 4000)) { errs.push({ field: path, error: label + ' is too large' }); return; } return val; }
    default: throw new Error('unknown rule ' + r.type);
  }
}
function clean(src, schema, prefix, errs) {
  const out = {};
  for (const [k, r] of Object.entries(schema)) {
    const v = check(src ? src[k] : undefined, r, (prefix || '') + k, errs);
    if (v !== undefined) out[k] = v;
  }
  return out;
}
function validate(src, schema) {
  const errs = [];
  const out = clean(src || {}, schema, '', errs);
  if (errs.length) throw bad(errs[0].error, errs);
  return out;
}
const body = (req, schema) => validate(req.body, schema);
const query = (req, schema) => validate(req.query, schema);
const param = (req, name) => { const v = req.params[name]; if (!/^[A-Za-z0-9_-]{3,64}$/.test(v || '')) throw notFound(); return v; };

/* ---------------- error middleware ---------------- */
function errorHandler(err, req, res, _next) {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large', code: 'too_large' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON', code: 'bad_json' });
  if (err instanceof HttpError) {
    const lang = String(req.headers['x-mc-lang'] || 'en');
    const tr = lang !== 'en' ? require('./i18n').tr : null;
    return res.status(err.status).json({ error: tr ? tr(lang, err.message) : err.message, code: err.code, details: tr && err.details ? err.details.map(d => Object.assign({}, d, { error: tr(lang, d.error) })) : err.details });
  }
  if (err && err.code === 11000) return res.status(409).json({ error: 'That already exists', code: 'duplicate' });
  console.error('[error]', req.method, req.path, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.', code: 'server_error' });
}

module.exports = { HttpError, bad, unauthorized, forbidden, notFound, conflict, locked, tooMany, ah, t, validate, body, query, param, normPhone, errorHandler };
