'use strict';
/*
 * MongoDB adapter exposing the same small API as the memory store.
 * Documents use our own string `id`; it is mirrored to `_id` so lookups by id are indexed
 * and unique. `_id` is stripped from everything returned to the app.
 * The client is cached on the module so warm serverless invocations reuse the connection.
 */
let MongoClient;
const strip = d => { if (!d) return d; const { _id, ...rest } = d; return rest; };
const stripProj = p => p;

function idFilter(f) { return f; }

class MongoCollection {
  constructor(col) { this.col = col; }
  async createIndex(fields, opts = {}) {
    const spec = Array.isArray(fields) ? Object.fromEntries(fields.map(f => [f, 1])) : fields;
    try { await this.col.createIndex(spec, opts); } catch (e) { if (!/already exists|IndexOptionsConflict|same name/i.test(e.message)) throw e; }
  }
  async insertOne(doc) { if (!doc.id) throw new Error('insertOne: document needs an id'); const d = Object.assign({ _id: doc.id }, doc); await this.col.insertOne(d); return strip(d); }
  async insertMany(docs) { const out = []; for (const d of docs) out.push(await this.insertOne(d)); return out; }
  /** one round trip for many documents (demo loading) */
  async bulkInsert(docs) { for (let i = 0; i < docs.length; i += 1000) await this.col.insertMany(docs.slice(i, i + 1000).map(d => Object.assign({ _id: d.id }, d)), { ordered: false }); }
  async find(filter = {}, opts = {}) {
    let c = this.col.find(idFilter(filter), { projection: stripProj(opts.projection) });
    if (opts.sort) c = c.sort(opts.sort);
    if (opts.skip) c = c.skip(opts.skip);
    if (opts.limit) c = c.limit(opts.limit);
    return (await c.toArray()).map(strip);
  }
  async findOne(filter = {}, opts = {}) { return strip(await this.col.findOne(idFilter(filter), { projection: opts.projection, sort: opts.sort })); }
  async count(filter = {}) { return this.col.countDocuments(idFilter(filter)); }
  async findOneAndUpdate(filter, update, opts = {}) {
    const upd = Object.assign({}, update);
    if (opts.upsert) {
      // make sure an upserted doc gets _id == id
      const soi = Object.assign({}, upd.$setOnInsert || {});
      const id = (upd.$setOnInsert && upd.$setOnInsert.id) || filter.id;
      if (id) { soi._id = id; if (!filter.id) soi.id = id; }
      upd.$setOnInsert = soi;
    }
    const r = await this.col.findOneAndUpdate(idFilter(filter), upd, { upsert: !!opts.upsert, sort: opts.sort, returnDocument: opts.returnBefore ? 'before' : 'after', includeResultMetadata: false });
    const doc = r && r.value !== undefined && r.ok !== undefined ? r.value : r;
    return strip(doc || null);
  }
  async updateOne(filter, update, opts = {}) { const doc = await this.findOneAndUpdate(filter, update, opts); return { matched: doc ? 1 : 0, modified: doc ? 1 : 0, doc }; }
  async updateMany(filter, update) { const r = await this.col.updateMany(idFilter(filter), update); return { matched: r.matchedCount, modified: r.modifiedCount }; }
  async deleteOne(filter) { const r = await this.col.deleteOne(idFilter(filter)); return { deleted: r.deletedCount }; }
  async deleteMany(filter) { const r = await this.col.deleteMany(idFilter(filter)); return { deleted: r.deletedCount }; }
  async aggregateCount(filter, field) {
    const rows = await this.col.aggregate([{ $match: filter }, { $group: { _id: '$' + field, n: { $sum: 1 } } }]).toArray();
    const out = {}; rows.forEach(r => { out[String(r._id)] = r.n; }); return out;
  }
}

let cached = null;
class MongoStore {
  constructor(uri, dbName) { this.kind = 'mongo'; this.uri = uri; this.dbName = dbName || 'medicore'; this.cols = new Map(); }
  async connect() {
    if (!MongoClient) ({ MongoClient } = require('mongodb'));
    if (!cached) { cached = new MongoClient(this.uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 5000 }); await cached.connect(); }
    this.client = cached; this.db = cached.db(this.dbName); return this;
  }
  collection(name) { if (!this.cols.has(name)) this.cols.set(name, new MongoCollection(this.db.collection(name))); return this.cols.get(name); }
  async ping() { await this.db.command({ ping: 1 }); return true; }
  async dropAll() { const cols = await this.db.listCollections().toArray(); for (const c of cols) await this.db.collection(c.name).deleteMany({}); }
  /** empty every collection except the given documents of `meta` (keeps a load lock in place) */
  async dropAllExcept(keepMetaIds) { const cols = await this.db.listCollections().toArray(); await Promise.all(cols.map(c => this.db.collection(c.name).deleteMany(c.name === 'meta' ? { _id: { $nin: keepMetaIds } } : {}))); }
}

module.exports = { MongoStore };
