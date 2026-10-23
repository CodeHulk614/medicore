'use strict';
/*
 * Test harness: boots the real app on a random port with a fresh in-memory database
 * and the demo data, and gives you a client per app with its own cookie jar.
 *
 *   const h = await boot();
 *   const doc = await h.as('doctor', 'dr.tunde@grandville.demo');   // signed-in client
 *   const r = await doc.post('/api/...', {...});  r.status, r.body
 *   await h.close();
 */
process.env.MC_TEST = '1';
process.env.DEMO_MODE = '1';
process.env.NODE_ENV = 'test';

const db = require('../src/db');
const bootstrap = require('../src/bootstrap');
const { createApp } = require('../src/app');
const demo = require('../src/seed/demo');

class Client {
  constructor(base, app) { this.base = base; this.app = app; this.cookies = {}; }
  async req(method, path, body, extraHeaders = {}) {
    const headers = Object.assign({ 'X-MC-App': this.app }, extraHeaders);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const ck = Object.entries(this.cookies).map(([k, v]) => k + '=' + v).join('; ');
    if (ck) headers.Cookie = ck;
    const r = await fetch(this.base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for (const c of set) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v) this.cookies[k] = v; else delete this.cookies[k]; }
    let data = null; const text = await r.text(); try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    return { status: r.status, body: data, headers: r.headers };
  }
  get(p, h) { return this.req('GET', p, undefined, h); }
  post(p, b, h) { return this.req('POST', p, b === undefined ? {} : b, h); }
  patch(p, b, h) { return this.req('PATCH', p, b, h); }
  put(p, b, h) { return this.req('PUT', p, b, h); }
  del(p, h) { return this.req('DELETE', p, undefined, h); }
  async login(identifier, password = demo.DEMO_PASSWORD, orgId) {
    const r = await this.post('/api/auth/login', { identifier, password, orgId });
    if (r.status !== 200 || r.body.chooseOrg) throw new Error('login failed for ' + identifier + ' in ' + this.app + ': ' + r.status + ' ' + JSON.stringify(r.body));
    return this;
  }
  async clockIn(lat, lng) { return this.post('/api/shift/clock-in', lat != null ? { lat, lng } : {}); }
}

/** boot({ patientMode: 'open' }) runs a file against the open (marketplace) patient mode; default is provider mode */
async function boot(opts = {}) {
  await db.resetForTests();
  bootstrap.reset();
  await bootstrap.ensure();
  const ctx = await demo.load();
  if (opts.patientMode) await require('../src/lib/settings').saveSection('process', { patients: { mode: opts.patientMode } }, { by: 'test' });
  const app = createApp({ serveStatic: true });
  const server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    base, ctx, db,
    client: app2 => new Client(base, app2),
    /** signed-in client; clocks in by default for roles that need it */
    async as(app2, identifier, opts = {}) {
      const c = new Client(base, app2); await c.login(identifier, opts.password, opts.orgId);
      if (opts.clockIn !== false && !['patient', 'hq', 'admin', 'payer'].includes(app2)) await c.clockIn();
      return c;
    },
    close: () => new Promise(r => server.close(r)),
  };
}

module.exports = { boot, Client, demo };
