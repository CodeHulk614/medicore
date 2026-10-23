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

let done = null;
async function ensure() {
  if (done) return done;
  done = (async () => {
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
    if (config.DEMO_MODE && !config.isTest) {
      const seeded = await db.col('meta').findOne({ id: 'demo' });
      if (!seeded) { const demo = require('./seed/demo'); await demo.load(); }
    }
  })();
  try { await done; } catch (e) { done = null; throw e; }
  return done;
}
function reset() { done = null; }
module.exports = { ensure, reset };
