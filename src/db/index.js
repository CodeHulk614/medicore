'use strict';
/*
 * Database entry point. Picks the backend from config:
 *   MONGODB_URI set  -> MongoDB (production / Netlify)
 *   otherwise        -> in-memory store, persisted to DB_FILE when set (local dev), pure memory in tests
 *
 * Usage in modules:
 *   const db = require('../db');
 *   db.index('appointments', ['slotKey'], { unique: true });   // declared once at load time
 *   const appts = db.col('appointments');                      // inside a request
 *   await appts.find({ orgId }) ...
 */
const config = require('../config');
const { MemoryStore } = require('./memory');
const { MongoStore } = require('./mongo');

let store = null;
let ready = null;
const indexes = [];

function index(colName, fields, opts) { indexes.push({ colName, fields, opts: opts || {} }); if (store && ready) ready = ready.then(() => store.collection(colName).createIndex(fields, opts || {})); }

async function init() {
  if (ready) return ready;
  ready = (async () => {
    if (config.MONGODB_URI) { store = await new MongoStore(config.MONGODB_URI, config.MONGODB_DB).connect(); }
    else { store = new MemoryStore(config.DB_FILE || null); }
    for (const ix of indexes) await store.collection(ix.colName).createIndex(ix.fields, ix.opts);
    return store;
  })();
  try { return await ready; } catch (e) { ready = null; store = null; throw e; }
}

function col(name) {
  if (!store) throw new Error('Database not initialised: call db.init() first');
  return store.collection(name);
}

// test helper: fresh in-memory store
async function resetForTests() {
  store = new MemoryStore(null);
  for (const ix of indexes) await store.collection(ix.colName).createIndex(ix.fields, ix.opts);
  ready = Promise.resolve(store);
  return store;
}

/** run fn against a fresh in-memory store (same indexes), then switch back. Used to build the demo data quickly. */
async function withMemoryStore(fn) {
  const prev = store; const prevReady = ready;
  const mem = new MemoryStore(null);
  for (const ix of indexes) await mem.collection(ix.colName).createIndex(ix.fields, ix.opts);
  store = mem; ready = Promise.resolve(mem);
  try { await fn(); return mem; } finally { store = prev; ready = prevReady; }
}

module.exports = { init, col, index, resetForTests, withMemoryStore, get kind() { return store ? store.kind : null; }, get store() { return store; } };
