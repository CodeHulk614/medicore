'use strict';
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path'); const fs = require('fs');
const PORT = 4922, BASE = 'http://localhost:' + PORT;
const DB = path.join(__dirname, 'data', 'smoke_disp_db.json');
try { fs.unlinkSync(DB); } catch (e) {}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); } };
async function token(email) { const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'demo1234' }) }); return (await r.json()).token; }
async function apphdr(tok, method, url, body) { const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => ({})); }
async function open(browser, p, key, tok) { const ctx = await browser.newContext({ viewport: { width: 390, height: 640 } }); const page = await ctx.newPage(); await page.goto(BASE + '/' + p); await page.evaluate(([k, t]) => { localStorage.setItem(k, t); localStorage.setItem('mc:nogate','1'); }, [key, tok]); await page.goto(BASE + '/' + p); return { ctx, page }; }

(async () => {
  const srv = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT), DB_FILE: DB, JWT_SECRET: 'smoke', DISPATCH_SPEED_KMH: '2500', DISABLE_OSRM: '1' }, stdio: ['ignore', 'ignore', 'inherit'] });
  let browser;
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await sleep(200); }
    browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
    const dispTok = await token('dispatch@demo.ng'), crewTok = await token('crew@demo.ng'), patTok = await token('amaka@demo.ng');

    // ---- DISPATCH: map (offline fallback SVG) + only-own-hospital ----
    const disp = await open(browser, 'dispatch.html', 'mcdispatch:token', dispTok);
    await disp.page.waitForTimeout(1600);
    ok('dispatch renders a map in #dispMap', await disp.page.evaluate(() => !!document.querySelector('#dispMap svg')));
    // markers may be Leaflet circleMarkers (SVG <path> in the overlay pane) or, when tiles are
    // unreachable and it falls back, schematic <circle>s. Accept either, allowing time for the fallback.
    let hasMarkers = false;
    try { await disp.page.waitForFunction(() => {
      const c = document.querySelectorAll('#dispMap svg circle').length;
      const p = document.querySelectorAll('#dispMap .leaflet-overlay-pane svg path, #dispMap .leaflet-marker-pane *').length;
      return c >= 3 || p >= 1;
    }, { timeout: 7000 }); hasMarkers = true; } catch (e) {}
    ok('map draws unit markers (Leaflet or schematic)', hasMarkers);
    ok('board is titled with the hospital name', /Grandville/.test(await disp.page.evaluate(() => document.body.innerText)));

    // ---- BACKGROUND REFRESH: scrolling is preserved across a poll ----
    const scrollable = await disp.page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 40);
    await disp.page.evaluate(() => window.scrollTo(0, Math.min(180, document.documentElement.scrollHeight)));
    const y0 = await disp.page.evaluate(() => window.scrollY);
    await disp.page.waitForTimeout(2600); // a poll cycle happens here
    const y1 = await disp.page.evaluate(() => window.scrollY);
    ok('page does NOT jump to top on background refresh', scrollable ? (Math.abs(y1 - y0) < 20 && y0 > 60) : true);
    ok('map still present after background refresh', await disp.page.evaluate(() => !!document.querySelector('#dispMap svg')));

    // set up an active run for amaka: SOS -> dispatch assign
    const sos = await apphdr(patTok, 'POST', '/api/patient/sos', { kind: 'Chest pain', hospitalId: 'h_grand' });
    const caseId = sos.case.id;
    await apphdr(dispTok, 'POST', '/api/dispatch/cases/' + caseId + '/assign', {});

    // ---- PATIENT: live tracking screen ----
    const pat = await open(browser, 'index.html', 'mc:token', patTok);
    await pat.page.waitForTimeout(1200);
    ok('patient home shows the live-tracking banner', /track/i.test(await pat.page.evaluate(() => document.getElementById('trackBanner') ? document.getElementById('trackBanner').innerText : '')));
    await pat.page.evaluate(() => go('track'));
    await pat.page.waitForTimeout(1200);
    ok('patient tracking screen renders a map', await pat.page.evaluate(() => !!document.querySelector('#trackMap svg')));
    ok('patient tracking shows ambulance status', /on the way|taking you|arrived|assigned/i.test(await pat.page.evaluate(() => document.body.innerText)));

    // ---- CREW: pick the assigned unit, see the map ----
    const crew = await open(browser, 'crew.html', 'mccrew:token', crewTok);
    await crew.page.waitForTimeout(1000);
    await crew.page.evaluate(async () => { const m = await (await fetch(location.origin + '/api/crew/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('mccrew:token') } })).json(); const a = (m.fleet || []).find(u => u.status !== 'available') || (m.fleet || [])[0]; await fetch(location.origin + '/api/crew/pick', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('mccrew:token') }, body: JSON.stringify({ responderId: a.id }) }); });
    await crew.page.reload(); await crew.page.waitForTimeout(1200);
    ok('crew terminal shows the run and a map', await crew.page.evaluate(() => !!document.querySelector('#crewMap svg')));
    ok('crew reflects the auto lifecycle note', /automatically/i.test(await crew.page.evaluate(() => document.body.innerText)));

    console.log('\n========= SMOKE DISPATCH (UI) =========');
    console.log('PASS ' + pass + '   FAIL ' + fail);
    console.log('=======================================');
  } catch (e) { console.error('ERROR', e); fail++; }
  finally { if (browser) await browser.close(); srv.kill(); try { fs.unlinkSync(DB); } catch (e) {} process.exit(fail ? 1 : 0); }
})();
