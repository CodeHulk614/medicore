'use strict';
/*
 * Rate limiting stored in the database, so it holds across serverless instances.
 * Fixed windows: key + window start -> counter (atomic $inc with upsert).
 */
const db = require('../db');
const { tooMany } = require('./http');

db.index('ratelimits', ['exp']);

async function hit(key, limit, windowSec) {
  const win = Math.floor(Date.now() / (windowSec * 1000));
  const rid = 'rl_' + key.replace(/[^A-Za-z0-9:._@+-]/g, '_').slice(0, 120) + '_' + win;
  const r = await db.col('ratelimits').findOneAndUpdate({ id: rid }, { $inc: { n: 1 }, $setOnInsert: { id: rid, exp: (win + 1) * windowSec * 1000 } }, { upsert: true });
  return { count: r ? r.n : 1, limit, remaining: Math.max(0, limit - (r ? r.n : 1)) };
}
/** throw 429 when the key has gone over limit in the window */
async function limit(key, max, windowSec, message) {
  const r = await hit(key, max, windowSec);
  if (r.count > max) throw tooMany(message);
  return r;
}
/** per-IP limit. Tests run everything from 127.0.0.1, so the cap is lifted under test. */
async function limitIp(req, name, max, windowSec, message) { const cfg = require('../config'); return limit(name + '_ip_' + ipOf(req), cfg.isTest ? max * 1000 : max, windowSec, message); }
/* client IP: on Netlify the platform sets x-nf-client-connection-ip (clients cannot forge it);
   anywhere else use the socket address. X-Forwarded-For is never trusted, so limits cannot be dodged. */
const ipOf = req => String(req.headers['x-nf-client-connection-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();

/* login lockout: 5 failures per identifier in 15 minutes locks that identifier for 15 minutes */
const sec = () => { const S = require('./settings'); return { n: Number(S.get('process.security.lockoutAttempts', 5)) || 5, ms: (Number(S.get('process.security.lockoutMinutes', 15)) || 15) * 60000 }; };
async function loginFailed(identifier) {
  const k = 'lf_' + identifier; const { n: maxTries, ms: lockMs } = sec();
  const rec = await db.col('login_failures').findOneAndUpdate({ id: k }, { $inc: { n: 1 }, $setOnInsert: { id: k, first: Date.now() } }, { upsert: true });
  if (rec.first < Date.now() - lockMs) { await db.col('login_failures').updateOne({ id: k }, { $set: { n: 1, first: Date.now() }, $unset: { lockedUntil: '' } }); return; }
  if (rec.n >= maxTries) await db.col('login_failures').updateOne({ id: k }, { $set: { lockedUntil: Date.now() + lockMs } });
}
async function loginLocked(identifier) {
  const rec = await db.col('login_failures').findOne({ id: 'lf_' + identifier });
  return !!(rec && rec.lockedUntil && rec.lockedUntil > Date.now());
}
async function loginSucceeded(identifier) { await db.col('login_failures').deleteOne({ id: 'lf_' + identifier }); }

module.exports = { hit, limit, limitIp, ipOf, loginFailed, loginLocked, loginSucceeded };
