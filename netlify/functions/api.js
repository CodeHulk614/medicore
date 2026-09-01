'use strict';
// MediCore API as a single Netlify Function.
// Persistence, chosen by env var, in this order:
//   MONGODB_URI  -> MongoDB (Atlas free tier)   [single document + write lock]
//   DATABASE_URL -> Postgres (Neon/Supabase)    [single JSONB doc + advisory lock]
//   neither      -> local file store            [npm start / netlify dev]
// The whole db is one document. Writes are serialized (a lock) so the apps'
// rapid polling can never clobber a write (this is what makes clock-in stick).
// Reads take a consistent snapshot and never persist.
process.env.MC_SERVERLESS = '1';
if (process.env.ENFORCE_CLOCKIN === undefined) process.env.ENFORCE_CLOCKIN = '1';  // deployed apps require clock-in by default

const serverless = require('serverless-http');
const store = require('../../store.js');
const seed = require('../../seed.js');
const app = require('../../server.js');
const handler = serverless(app);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function catchUp() {
  const db = store.get(); const now = Date.now(); const last = db._lastTick || now;
  let secs = Math.floor((now - last) / 1000); if (secs < 0) secs = 0; if (secs > 180) secs = 180;
  const steps = [app.locals.dispatchTick, app.locals.deliveryTick].filter(f => typeof f === 'function');
  for (let i = 0; i < secs; i++) steps.forEach(f => { try { f(); } catch (e) {} });
  db._lastTick = now;
}
function seedIfEmpty() { if (!store.get().users || !store.get().users.length) seed(true); }

/* ------------------------- MongoDB backend ------------------------- */
const DOC_ID = 1, LOCK_ID = '__lock__', LOCK_STALE_MS = 15000;
let mongoClient = null, mongoTried = false;
async function getMongoColl() {
  if (!process.env.MONGODB_URI) return null;
  if (!mongoClient) {
    try {
      const { MongoClient } = require('mongodb');
      mongoClient = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 3 });
      await mongoClient.connect();
    } catch (e) { mongoClient = null; return null; }
  }
  const dbName = (process.env.MONGODB_DB || 'medicore');
  return mongoClient.db(dbName).collection('store');
}
// exported for tests: run one request against a given Mongo-like collection
async function runWithMongo(coll, event, context, isWrite) {
  // ensure the lock doc exists
  await coll.updateOne({ _id: LOCK_ID }, { $setOnInsert: { held: false, at: 0 } }, { upsert: true });
  let locked = false;
  if (isWrite) {
    for (let i = 0; i < 100 && !locked; i++) {
      const r = await coll.findOneAndUpdate(
        { _id: LOCK_ID, $or: [{ held: false }, { at: { $lt: Date.now() - LOCK_STALE_MS } }] },
        { $set: { held: true, at: Date.now() } },
        { returnDocument: 'before' });
      const got = r && (r.value !== undefined ? r.value : r);   // driver v5 vs v6
      if (got) locked = true; else await sleep(80);
    }
  }
  try {
    const doc = await coll.findOne({ _id: DOC_ID });
    if (doc && doc.data && doc.data.users) store.hydrate(doc.data);
    else { seed(true); await coll.updateOne({ _id: DOC_ID }, { $set: { data: store.snapshot() } }, { upsert: true }); }
    try { catchUp(); } catch (e) {}
    const res = await handler(event, context);
    if (isWrite) await coll.updateOne({ _id: DOC_ID }, { $set: { data: store.snapshot() } }, { upsert: true });
    return res;
  } finally {
    if (locked) { try { await coll.updateOne({ _id: LOCK_ID }, { $set: { held: false } }); } catch (e) {} }
  }
}

/* ------------------------- Postgres backend ------------------------ */
const PG_LOCK = 915823;
let pgPool = null, pgTried = false;
function getPgPool() {
  if (pgTried) return pgPool; pgTried = true;
  if (!process.env.DATABASE_URL) return null;
  try {
    const { Pool } = require('pg');
    const url = process.env.DATABASE_URL;
    const needSSL = /sslmode=require/.test(url) || /neon\.tech|supabase\.co|render\.com|amazonaws\.com/.test(url);
    pgPool = new Pool({ connectionString: url, max: 1, ssl: needSSL ? { rejectUnauthorized: false } : false, idleTimeoutMillis: 5000 });
  } catch (e) { pgPool = null; }
  return pgPool;
}
async function runWithPg(pool, event, context, isWrite) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TABLE IF NOT EXISTS medicore_store (id int PRIMARY KEY, doc jsonb NOT NULL)');
    if (isWrite) await client.query('SELECT pg_advisory_xact_lock($1)', [PG_LOCK]);
    const r = await client.query('SELECT doc FROM medicore_store WHERE id = 1');
    if (r.rows.length && r.rows[0].doc && r.rows[0].doc.users) store.hydrate(r.rows[0].doc);
    else { seed(true); await client.query('INSERT INTO medicore_store (id, doc) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc', [store.snapshot()]); }
    try { catchUp(); } catch (e) {}
    const res = await handler(event, context);
    if (isWrite) await client.query('UPDATE medicore_store SET doc = $1 WHERE id = 1', [store.snapshot()]);
    await client.query('COMMIT');
    return res;
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { client.release(); }
}

/* ------------------------- handler ------------------------- */
exports.handler = async (event, context) => {
  if (event && event.rawUrl) { try { event.path = new URL(event.rawUrl).pathname; } catch (e) {} }
  const method = (event.httpMethod || 'GET').toUpperCase();
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  try {
    const coll = await getMongoColl();
    if (coll) return await runWithMongo(coll, event, context, isWrite);
    const pool = getPgPool();
    if (pool) return await runWithPg(pool, event, context, isWrite);
    // file fallback (local)
    seedIfEmpty(); try { catchUp(); } catch (e) {}
    return handler(event, context);
  } catch (e) {
    return { statusCode: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'server error' }) };
  }
};
exports._runWithMongo = runWithMongo;   // test hook
