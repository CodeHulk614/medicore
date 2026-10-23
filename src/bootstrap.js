'use strict';
/*
 * First-run setup. On an empty database:
 *  - creates the default plans
 *  - creates the first MediCore platform owner from PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD
 *    (they must change the password at first sign-in)
 *  - in DEMO_MODE only, loads the demo providers and accounts (see src/seed/demo.js)
 * Nothing is seeded automatically in production.
 */
const db = require('./db');
const config = require('./config');
const { id } = require('./lib/util');
const { HttpError } = require('./lib/http');

let done = null;
async function ensure() {
  if (done) return done;
  done = (async () => {
    // demo first: loading the demo replaces whatever a half-finished earlier load left behind
    if (config.DEMO_MODE && !config.isTest) {
      const seeded = await db.col('meta').findOne({ id: 'demo' });
      if (!seeded) await loadDemo();
    }
    const orgs = require('./modules/orgs');
    await orgs.ensurePlans();
    const anyPlatform = await db.col('users').findOne({ platformRole: { $exists: true } });
    if (!anyPlatform && config.PLATFORM_ADMIN_EMAIL && config.PLATFORM_ADMIN_PASSWORD) {
      const A = require('./lib/auth');
      const existing = await db.col('users').findOne({ email: config.PLATFORM_ADMIN_EMAIL });
      if (existing) await db.col('users').updateOne({ id: existing.id }, { $set: { platformRole: 'platform_owner' } });
      else await db.col('users').insertOne({ id: id('usr'), name: 'MediCore owner', email: config.PLATFORM_ADMIN_EMAIL, passHash: await A.hashPassword(config.PLATFORM_ADMIN_PASSWORD), status: 'active', platformRole: 'platform_owner', mustChangePassword: true, createdAt: Date.now() });
      console.log('[bootstrap] platform owner created for', config.PLATFORM_ADMIN_EMAIL);
    }
  })();
  try { await done; } catch (e) { done = null; throw e; }
  return done;
}

/*
 * Demo loading. On MongoDB the demo is built in memory first (a few seconds), then copied across in one
 * bulk write per collection. Writing it record by record took longer than Netlify lets a request run,
 * which left half a demo behind and made every later request fail with "That already exists".
 * A lock stops two cold starts loading at once. A database holding anything that is not demo data is
 * never wiped: the load stops with a clear message instead.
 */
const LOCK = 'demo_lock';
async function loadDemo() {
  const demo = require('./seed/demo');
  if (db.kind !== 'mongo') { await demo.load(); return; }
  const meta = db.col('meta');
  try { await meta.insertOne({ id: LOCK, at: Date.now() }); }
  catch (e) {
    if (e.code !== 11000) throw e;
    const l = await meta.findOne({ id: LOCK });
    if (l && Date.now() - l.at < 60e3) throw new HttpError(503, 'The demo data is loading. Wait a minute and try again.', 'demo_loading');
    await meta.updateOne({ id: LOCK }, { $set: { at: Date.now() } });
  }
  try {
    const users = await db.col('users').find({ demo: { $ne: true } }, { limit: 20 });
    const real = users.filter(u => !(u.email && /\.demo$/.test(u.email)) && u.email !== config.PLATFORM_ADMIN_EMAIL);
    if (real.length) throw new HttpError(503, 'DEMO_MODE is on, but this database already holds accounts that are not demo accounts, so the demo was not loaded. Use an empty database for the demo, or turn DEMO_MODE off.', 'demo_blocked');
    const mem = await db.withMemoryStore(() => demo.load());
    const target = db.store;
    await target.dropAllExcept([LOCK]);
    const names = [...mem.cols.keys()].filter(n => n !== 'meta');
    await Promise.all(names.map(n => { const docs = [...mem.collection(n).docs.values()]; return docs.length ? target.collection(n).bulkInsert(docs) : null; }));
    const metaDocs = [...mem.collection('meta').docs.values()].filter(d => d.id !== LOCK && d.id !== 'demo');
    if (metaDocs.length) await target.collection('meta').bulkInsert(metaDocs);
    await meta.findOneAndUpdate({ id: 'demo' }, { $set: { id: 'demo', at: Date.now() } }, { upsert: true });   // written last: marks the load complete
    console.log('[bootstrap] demo data loaded');
  } finally { await meta.deleteOne({ id: LOCK }).catch(() => {}); }
}
function reset() { done = null; }
module.exports = { ensure, reset };
