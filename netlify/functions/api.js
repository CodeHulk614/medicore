'use strict';
// MediCore API as a single Netlify Function.
// Wraps the existing Express app with serverless-http, persists the whole db to
// Netlify Blobs (free), and advances ambulance/rider movement lazily on each
// request (serverless has no background timers). Falls back to the file store
// when Blobs is unavailable (e.g. plain local invocation) so it stays testable.
process.env.MC_SERVERLESS = '1';

const serverless = require('serverless-http');
const store = require('../../store.js');
const seed = require('../../seed.js');
const app = require('../../server.js');          // exports the Express app (does not listen)

const BLOB_KEY = 'db';
let blob = null, blobReady = false;
function getBlob() {
  if (blobReady) return blob;
  blobReady = true;
  try { const { getStore } = require('@netlify/blobs'); blob = getStore('medicore-db'); }
  catch (e) { blob = null; }
  return blob;
}

// advance movement by the real time elapsed since the last request
function catchUp() {
  const db = store.get();
  const now = Date.now();
  const last = db._lastTick || now;
  let secs = Math.floor((now - last) / 1000);
  if (secs < 0) secs = 0; if (secs > 180) secs = 180;      // cap after long idle
  const steps = [app.locals.dispatchTick, app.locals.deliveryTick].filter(f => typeof f === 'function');
  for (let i = 0; i < secs; i++) steps.forEach(f => { try { f(); } catch (e) {} });
  db._lastTick = now;
}

const handler = serverless(app);

exports.handler = async (event, context) => {
  if (event && event.rawUrl) { try { event.path = new URL(event.rawUrl).pathname; } catch (e) {} }
  const b = getBlob();
  // 1) hydrate the db for this request
  if (b) {
    let data = null;
    try { data = await b.get(BLOB_KEY, { type: 'json' }); } catch (e) { data = null; }
    if (data && data.users) store.hydrate(data);
    else { seed(true); }
  } else {
    // no Blobs (local/dev): use the file store; seed if empty
    if (!store.get().users || !store.get().users.length) seed(true);
  }
  if (!store.get().users || !store.get().users.length) seed(true);

  // 2) advance movement lazily
  try { catchUp(); } catch (e) {}

  // 3) handle the request
  const res = await handler(event, context);

  // 4) persist
  if (b) { try { await b.setJSON(BLOB_KEY, store.snapshot()); } catch (e) {} }
  return res;
};
