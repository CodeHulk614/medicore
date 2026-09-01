'use strict';
// MediCore API as a single Netlify Function.
// Persistence: Postgres (Neon/Supabase, free) when DATABASE_URL is set, otherwise
// a local file store (so it still runs with `npm start` / netlify dev).
//
// The whole db is one JSONB document. Writes run inside a transaction that first
// takes a Postgres advisory lock, so concurrent requests are serialized and can
// never clobber each other (this is what makes clock-in and every other write
// stick under the apps' rapid polling). Reads use a consistent snapshot and do
// not persist, so polling never overwrites a write.
process.env.MC_SERVERLESS = '1';

const serverless = require('serverless-http');
const store = require('../../store.js');
const seed = require('../../seed.js');
const app = require('../../server.js');
const handler = serverless(app);

const LOCK_KEY = 915823;   // any constant; serializes all writers on the single doc
let pool = null, poolTried = false;
function getPool() {
  if (poolTried) return pool;
  poolTried = true;
  if (!process.env.DATABASE_URL) return null;
  try {
    const { Pool } = require('pg');
    const url = process.env.DATABASE_URL;
    const needSSL = /sslmode=require/.test(url) || /neon\.tech|supabase\.co|render\.com|amazonaws\.com/.test(url);
    pool = new Pool({ connectionString: url, max: 1, ssl: needSSL ? { rejectUnauthorized: false } : false, idleTimeoutMillis: 5000 });
  } catch (e) { pool = null; }
  return pool;
}

function catchUp() {
  const db = store.get(); const now = Date.now(); const last = db._lastTick || now;
  let secs = Math.floor((now - last) / 1000); if (secs < 0) secs = 0; if (secs > 180) secs = 180;
  const steps = [app.locals.dispatchTick, app.locals.deliveryTick].filter(f => typeof f === 'function');
  for (let i = 0; i < secs; i++) steps.forEach(f => { try { f(); } catch (e) {} });
  db._lastTick = now;
}

async function ensureRow(client) {
  await client.query('CREATE TABLE IF NOT EXISTS medicore_store (id int PRIMARY KEY, doc jsonb NOT NULL)');
}

exports.handler = async (event, context) => {
  if (event && event.rawUrl) { try { event.path = new URL(event.rawUrl).pathname; } catch (e) {} }
  const p = getPool();
  const method = (event.httpMethod || 'GET').toUpperCase();
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(method);

  // ---- fallback: no DATABASE_URL -> local file store (unchanged behaviour) ----
  if (!p) {
    if (!store.get().users || !store.get().users.length) seed(true);
    try { catchUp(); } catch (e) {}
    return handler(event, context);
  }

  // ---- Postgres-backed request ----
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await ensureRow(client);
    if (isWrite) await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);   // serialize writers
    const r = await client.query('SELECT doc FROM medicore_store WHERE id = 1');
    if (r.rows.length && r.rows[0].doc && r.rows[0].doc.users) {
      store.hydrate(r.rows[0].doc);
    } else {
      seed(true);
      await client.query('INSERT INTO medicore_store (id, doc) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc', [store.snapshot()]);
    }
    try { catchUp(); } catch (e) {}
    const res = await handler(event, context);
    if (isWrite) {
      await client.query('UPDATE medicore_store SET doc = $1 WHERE id = 1', [store.snapshot()]);
    }
    await client.query('COMMIT');
    return res;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return { statusCode: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'server error' }) };
  } finally {
    client.release();
  }
};
