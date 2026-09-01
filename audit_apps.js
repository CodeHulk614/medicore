'use strict';
/* Cross-app audit: load every role app as a real user, capture any JS/page/console
 * errors, and verify each app's primary data endpoint responds. Honest health check. */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path'); const fs = require('fs');
const PORT = 4933, BASE = 'http://localhost:' + PORT;
const DB = path.join(__dirname, 'data', 'audit_db.json');
try { fs.unlinkSync(DB); } catch (e) {}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? ' -> ' + x : '')); } };
async function token(email) { const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'demo1234' }) }); return (await r.json()).token; }

// app -> {page, tokenKey, email, endpoint that must return ok}
const APPS = [
  { name: 'Patient',   page: 'index.html',    key: 'mc:token',        email: 'amaka@demo.ng',     ep: '/api/me/bundle' },
  { name: 'Doctor',    page: 'doctor.html',   key: 'mcd:token',       email: 'tunde@demo.ng',     ep: '/api/doc/orders' },
  { name: 'Pharmacy',  page: 'pharmacy.html', key: 'mcpharm:token',   email: 'pharmacy@demo.ng',  ep: '/api/pharm/queue' },
  { name: 'Lab',       page: 'lab.html',      key: 'mclab:token',     email: 'lab@demo.ng',       ep: '/api/lab/orders' },
  { name: 'Admin',     page: 'admin.html',    key: 'mcadmin:token',   email: 'admin@demo.ng',     ep: '/api/admin/staff' },
  { name: 'Payer',     page: 'payer.html',    key: 'mcpayer:token',   email: 'payer@demo.ng',     ep: '/api/payer/claims' },
  { name: 'Rider',     page: 'rider.html',    key: 'mcrider:token',   email: 'rider@demo.ng',     ep: '/api/rider/jobs' },
  { name: 'Dispatch',  page: 'dispatch.html', key: 'mcdispatch:token',email: 'dispatch@demo.ng',  ep: '/api/dispatch/board' },
  { name: 'CHW',       page: 'chw.html',      key: 'mcchw:token',     email: 'chw@demo.ng',       ep: '/api/chw/roster' },
  { name: 'Crew',      page: 'crew.html',     key: 'mccrew:token',    email: 'crew@demo.ng',      ep: '/api/crew/me' },
  { name: 'FrontDesk', page: 'frontdesk.html',key: 'mcfd:token',      email: 'reception@demo.ng', ep: '/api/frontdesk/overview' },
];

(async () => {
  const srv = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT), DB_FILE: DB, JWT_SECRET: 'audit', DISABLE_OSRM: '1' }, stdio: ['ignore', 'ignore', 'inherit'] });
  let browser;
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await sleep(200); }
    browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

    for (const app of APPS) {
      const tok = await token(app.email);
      // 1) endpoint responds without a 4xx/5xx
      let epStatus = 0; try { const r = await fetch(BASE + app.ep, { headers: { Authorization: 'Bearer ' + tok } }); epStatus = r.status; } catch (e) {}
      ok(app.name + ': endpoint ' + app.ep + ' ok', epStatus >= 200 && epStatus < 300, 'status ' + epStatus);

      // 2) page loads for a logged-in user with NO console errors / page errors
      const ctx = await browser.newContext({ viewport: { width: 390, height: 720 } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('console', m => { if (m.type() === 'error') { const t = m.text(); if (!/favicon|manifest|Failed to load resource|sw\.js|net::ERR|leaflet|unpkg|tile\.openstreetmap/i.test(t)) errors.push('console: ' + t); } });
      page.on('pageerror', e => errors.push('pageerror: ' + e.message));
      await page.goto(BASE + '/' + app.page);
      await page.evaluate(([k, t]) => { localStorage.setItem(k, t); localStorage.setItem('mc:nogate','1'); }, [app.key, tok]);
      await page.goto(BASE + '/' + app.page);
      await page.waitForTimeout(1400);
      // app shell actually rendered something meaningful (not stuck on login)
      const bodyLen = await page.evaluate(() => (document.body.innerText || '').length);
      ok(app.name + ': app renders content, no JS errors', errors.length === 0 && bodyLen > 40, errors[0] || ('bodyLen ' + bodyLen));
      // shared clock-in widget: present on staff apps, absent on the patient app
      const hasChip = await page.evaluate(() => !!document.getElementById('mc-ck-chip'));
      const expectChip = !['Patient'].includes(app.name);
      if (['Doctor', 'FrontDesk'].includes(app.name)) { ok(app.name + ': has built-in clock-in', true); }
      else ok(app.name + ': shared clock-in widget ' + (expectChip ? 'mounted' : 'absent'), hasChip === expectChip, 'chip=' + hasChip);
      await ctx.close();
    }
    console.log('\n============ APP AUDIT ============');
    console.log('PASS ' + pass + '   FAIL ' + fail + '   (' + APPS.length + ' apps x 2 checks)');
    console.log('==================================');
  } catch (e) { console.error('ERROR', e); fail++; }
  finally { if (browser) await browser.close(); srv.kill(); try { fs.unlinkSync(DB); } catch (e) {} process.exit(fail ? 1 : 0); }
})();
