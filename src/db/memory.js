'use strict';
/*
 * In-memory document store with a MongoDB-compatible subset API.
 * Used for local development (optionally persisted to a JSON file) and for tests.
 * Semantics deliberately match the Mongo adapter so code runs unchanged on either:
 *  - every document has a string `id` (mirrored to `_id` in Mongo)
 *  - updates are atomic per document, filters are evaluated against the current doc,
 *    so conditional updates ("only if status is X") give exactly-once transitions
 *  - unique indexes are enforced on insert and update (E11000-style error, code 11000)
 */
const fs = require('fs');
const path = require('path');

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function getPath(obj, p) {
  const parts = p.split('.');
  let cur = obj;
  for (const k of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && !/^\d+$/.test(k)) {
      // array of subdocs: collect values (Mongo semantics for a.b on arrays)
      return cur.map(x => (x == null ? undefined : x[k]));
    }
    cur = cur[k];
  }
  return cur;
}
function setPath(obj, p, val) {
  const parts = p.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}
function unsetPath(obj, p) {
  const parts = p.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (cur[parts[i]] == null) return; cur = cur[parts[i]]; }
  delete cur[parts[parts.length - 1]];
}
function eq(a, b) {
  if (a instanceof Date) a = a.toISOString();
  if (b instanceof Date) b = b.toISOString();
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a === 'object' && typeof b === 'object' && a && b) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}
function cmp(a, b) { if (a instanceof Date) a = a.getTime(); if (b instanceof Date) b = b.getTime(); return a < b ? -1 : a > b ? 1 : 0; }

function matchValue(val, cond) {
  const isOps = cond && typeof cond === 'object' && !Array.isArray(cond) && Object.keys(cond).some(k => k[0] === '$');
  if (!isOps) {
    if (Array.isArray(val) && !Array.isArray(cond)) return val.some(v => eq(v, cond));
    return eq(val, cond);
  }
  for (const [op, arg] of Object.entries(cond)) {
    const vals = Array.isArray(val) ? val : [val];
    switch (op) {
      case '$eq': if (!matchValue(val, arg)) return false; break;
      case '$ne': if (vals.some(v => eq(v, arg)) || (val === undefined && arg == null)) return false; break;
      case '$in': if (!vals.some(v => arg.some(a => eq(v, a)))) return false; break;
      case '$nin': if (vals.some(v => arg.some(a => eq(v, a)))) return false; break;
      case '$gt': if (!vals.some(v => v != null && cmp(v, arg) > 0)) return false; break;
      case '$gte': if (!vals.some(v => v != null && cmp(v, arg) >= 0)) return false; break;
      case '$lt': if (!vals.some(v => v != null && cmp(v, arg) < 0)) return false; break;
      case '$lte': if (!vals.some(v => v != null && cmp(v, arg) <= 0)) return false; break;
      case '$exists': if ((val !== undefined) !== !!arg) return false; break;
      case '$regex': {
        const re = arg instanceof RegExp ? arg : new RegExp(arg, cond.$options || '');
        if (!vals.some(v => typeof v === 'string' && re.test(v))) return false; break;
      }
      case '$options': break;
      case '$size': if (!Array.isArray(val) || val.length !== arg) return false; break;
      case '$elemMatch': if (!Array.isArray(val) || !val.some(item => matches(item, arg))) return false; break;
      default: throw new Error('Unsupported query operator ' + op);
    }
  }
  return true;
}
function matches(doc, filter) {
  if (!filter) return true;
  for (const [k, cond] of Object.entries(filter)) {
    if (k === '$or') { if (!cond.some(f => matches(doc, f))) return false; continue; }
    if (k === '$and') { if (!cond.every(f => matches(doc, f))) return false; continue; }
    if (k === '$nor') { if (cond.some(f => matches(doc, f))) return false; continue; }
    if (!matchValue(getPath(doc, k), cond)) return false;
  }
  return true;
}
function applyUpdate(doc, update, isInsert) {
  const hasOps = Object.keys(update).some(k => k[0] === '$');
  if (!hasOps) { const id = doc.id; const out = clone(update); out.id = id; return out; }
  for (const [op, fields] of Object.entries(update)) {
    for (const [p, v] of Object.entries(fields || {})) {
      switch (op) {
        case '$set': setPath(doc, p, clone(v)); break;
        case '$setOnInsert': if (isInsert) setPath(doc, p, clone(v)); break;
        case '$unset': unsetPath(doc, p); break;
        case '$inc': setPath(doc, p, (Number(getPath(doc, p)) || 0) + v); break;
        case '$push': {
          const arr = getPath(doc, p) || [];
          if (v && typeof v === 'object' && v.$each) { arr.push(...clone(v.$each)); if (v.$slice != null) { const s = v.$slice; const res = s < 0 ? arr.slice(s) : arr.slice(0, s); arr.length = 0; arr.push(...res); } }
          else arr.push(clone(v));
          setPath(doc, p, arr); break;
        }
        case '$addToSet': { const arr = getPath(doc, p) || []; if (!arr.some(x => eq(x, v))) arr.push(clone(v)); setPath(doc, p, arr); break; }
        case '$pull': {
          const arr = getPath(doc, p) || [];
          const keep = arr.filter(x => (v && typeof v === 'object' && !Array.isArray(v)) ? !matches(x, v) : !eq(x, v));
          setPath(doc, p, keep); break;
        }
        case '$min': { const cur = getPath(doc, p); if (cur === undefined || cmp(v, cur) < 0) setPath(doc, p, v); break; }
        case '$max': { const cur = getPath(doc, p); if (cur === undefined || cmp(v, cur) > 0) setPath(doc, p, v); break; }
        default: throw new Error('Unsupported update operator ' + op);
      }
    }
  }
  return doc;
}
function project(doc, projection) {
  if (!projection) return doc;
  const keys = Object.keys(projection);
  const include = keys.some(k => projection[k]);
  if (include) { const out = { id: doc.id }; keys.forEach(k => { if (projection[k]) { const v = getPath(doc, k); if (v !== undefined) setPath(out, k, v); } }); return out; }
  const out = clone(doc); keys.forEach(k => unsetPath(out, k)); return out;
}
function sortDocs(docs, sort) {
  if (!sort) return docs;
  const keys = Object.entries(sort);
  return docs.sort((a, b) => { for (const [k, dir] of keys) { const c = cmp(getPath(a, k), getPath(b, k)); if (c) return c * dir; } return 0; });
}
function dupError(index) { const e = new Error('Duplicate key for unique index ' + index); e.code = 11000; return e; }

class MemoryCollection {
  constructor(store, name) { this.store = store; this.name = name; this.docs = new Map(); this.uniques = []; }
  _checkUnique(doc, ignoreId) {
    for (const u of this.uniques) {
      const keyOf = d => u.fields.map(f => JSON.stringify(getPath(d, f) ?? null)).join('|');
      if (u.partial && !matches(doc, u.partial)) continue;
      if (u.sparse && u.fields.some(f => getPath(doc, f) == null)) continue;
      const k = keyOf(doc);
      for (const other of this.docs.values()) {
        if (other.id === ignoreId) continue;
        if (u.partial && !matches(other, u.partial)) continue;
        if (u.sparse && u.fields.some(f => getPath(other, f) == null)) continue;
        if (keyOf(other) === k) throw dupError(u.name);
      }
    }
  }
  async createIndex(fields, opts = {}) {
    const f = Array.isArray(fields) ? fields : Object.keys(fields);
    if (opts.unique && !this.uniques.some(u => u.name === (opts.name || f.join('_')))) this.uniques.push({ fields: f, name: opts.name || f.join('_'), sparse: !!opts.sparse, partial: opts.partialFilterExpression });
  }
  async insertOne(doc) {
    const d = clone(doc);
    if (!d.id) throw new Error('insertOne: document needs an id');
    if (this.docs.has(d.id)) throw dupError('id');
    this._checkUnique(d);
    this.docs.set(d.id, d); this.store._dirty();
    return clone(d);
  }
  async insertMany(docs) { const out = []; for (const d of docs) out.push(await this.insertOne(d)); return out; }
  async find(filter = {}, opts = {}) {
    let res = [];
    for (const d of this.docs.values()) if (matches(d, filter)) res.push(d);
    res = sortDocs(res, opts.sort);
    if (opts.skip) res = res.slice(opts.skip);
    if (opts.limit) res = res.slice(0, opts.limit);
    return res.map(d => project(clone(d), opts.projection));
  }
  async findOne(filter = {}, opts = {}) { const r = await this.find(filter, Object.assign({}, opts, { limit: 1 })); return r[0] || null; }
  async count(filter = {}) { let n = 0; for (const d of this.docs.values()) if (matches(d, filter)) n++; return n; }
  async findOneAndUpdate(filter, update, opts = {}) {
    let target = null;
    const candidates = sortDocs([...this.docs.values()].filter(d => matches(d, filter)), opts.sort);
    target = candidates[0] || null;
    if (!target) {
      if (!opts.upsert) return null;
      const base = {};
      for (const [k, v] of Object.entries(filter)) if (k[0] !== '$' && (typeof v !== 'object' || v === null)) setPath(base, k, v);
      const doc = applyUpdate(base, update, true);
      if (!doc.id) throw new Error('upsert needs id in filter or $setOnInsert');
      this._checkUnique(doc);
      this.docs.set(doc.id, doc); this.store._dirty();
      return opts.returnBefore ? null : clone(doc);
    }
    const before = clone(target);
    const next = applyUpdate(clone(target), update, false);
    next.id = target.id;
    this._checkUnique(next, target.id);
    this.docs.set(target.id, next); this.store._dirty();
    return clone(opts.returnBefore ? before : next);
  }
  async updateOne(filter, update, opts = {}) {
    const r = await this.findOneAndUpdate(filter, update, opts);
    return { matched: r ? 1 : 0, modified: r ? 1 : 0, doc: r };
  }
  async updateMany(filter, update) {
    let n = 0;
    for (const d of [...this.docs.values()]) {
      if (!matches(d, filter)) continue;
      const next = applyUpdate(clone(d), update, false); next.id = d.id; this._checkUnique(next, d.id); this.docs.set(d.id, next); n++;
    }
    if (n) this.store._dirty();
    return { matched: n, modified: n };
  }
  async deleteOne(filter) { for (const d of this.docs.values()) if (matches(d, filter)) { this.docs.delete(d.id); this.store._dirty(); return { deleted: 1 }; } return { deleted: 0 }; }
  async deleteMany(filter) { let n = 0; for (const d of [...this.docs.values()]) if (matches(d, filter)) { this.docs.delete(d.id); n++; } if (n) this.store._dirty(); return { deleted: n }; }
  async aggregateCount(filter, field) {
    const out = {};
    for (const d of this.docs.values()) if (matches(d, filter)) { const k = String(getPath(d, field)); out[k] = (out[k] || 0) + 1; }
    return out;
  }
}

class MemoryStore {
  constructor(file) {
    this.kind = 'memory'; this.file = file || null; this.cols = new Map(); this.timer = null;
    if (this.file && fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const [name, docs] of Object.entries(raw)) { const c = this.collection(name); docs.forEach(d => c.docs.set(d.id, d)); }
      } catch (e) { console.warn('[db] could not read', this.file, e.message); }
    }
  }
  collection(name) { if (!this.cols.has(name)) this.cols.set(name, new MemoryCollection(this, name)); return this.cols.get(name); }
  _dirty() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 50);
  }
  flush() {
    if (!this.file) return;
    const out = {};
    for (const [name, c] of this.cols) out[name] = [...c.docs.values()];
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file + '.tmp', JSON.stringify(out)); fs.renameSync(this.file + '.tmp', this.file); } catch (e) { console.warn('[db] write failed', e.message); }
  }
  async ping() { return true; }
  async dropAll() { for (const c of this.cols.values()) c.docs.clear(); this._dirty(); }
}

module.exports = { MemoryStore, matches, applyUpdate };
