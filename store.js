'use strict';
/*
 * Datastore with two backends behind one tiny sync API (get/save):
 *  - Local / server mode (default): reads a JSON file on boot, writes on change.
 *  - Serverless mode (MC_SERVERLESS=1): the whole db lives in memory for the
 *    duration of a request; the Netlify function hydrates it from Netlify Blobs
 *    at the start and persists it back at the end, so the sync handlers below
 *    never change. File writes are disabled in this mode.
 * The access layer is deliberately small so it can be swapped for Postgres later.
 */
const fs = require('fs');
const path = require('path');
const SERVERLESS = process.env.MC_SERVERLESS === '1';
const FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');

function ensureDir() { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch (e) {} }

let db = null;
const EMPTY = () => ({ users: [], patients: [], appointments: [], prescriptions: [], deliveries: [],
  benefits: [], authorizations: [], claims: [], bills: [], results: [], visits: [],
  messages: [], providers: [], payments: [], events: [], orders: [], notifications: [] });

function load() {
  if (SERVERLESS) { if (!db) db = EMPTY(); return db; }   // serverless: memory only, hydrated by the function
  ensureDir();
  if (fs.existsSync(FILE)) { try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { db = null; } }
  if (!db) { db = EMPTY(); save(); }
  return db;
}

let writeTimer = null;
function save() {
  if (SERVERLESS) return;                                  // serverless: the function persists via Blobs
  ensureDir();
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => { try { fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); } catch (e) {} }, 30);
  try { fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); } catch (e) {}
}

function get() { return db || load(); }
function hydrate(obj) { db = obj || EMPTY(); return db; }    // serverless: load a db object from Blobs
function snapshot() { return db; }                          // serverless: get the db object to persist

module.exports = { load, save, get, hydrate, snapshot, FILE, SERVERLESS };
