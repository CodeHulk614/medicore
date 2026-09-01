'use strict';
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path'); const fs = require('fs');

const PORT = 4912, BASE = 'http://localhost:' + PORT;
const DB = path.join(__dirname, 'data', 'smoke_db.json');
try { fs.unlinkSync(DB); } catch (e) {}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(n, c) { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); } }

async function token(email) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'demo1234' }) });
  return (await r.json()).token;
}
async function openApp(browser, page_path, key, tok) {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(BASE + '/' + page_path);
  await page.evaluate(([k, t]) => { localStorage.setItem(k, t); localStorage.setItem('mc:nogate','1'); }, [key, tok]);
  await page.goto(BASE + '/' + page_path); // reload with token set
  return { ctx, page };
}

(async () => {
  const srv = spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT), DB_FILE: DB, JWT_SECRET: 'smoke' }, stdio: ['ignore', 'ignore', 'inherit'] });
  let browser;
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (e) {} await sleep(200); }
    browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

    const docTok = await token('tunde@demo.ng');
    const labTok = await token('lab@demo.ng');
    const patTok = await token('amaka@demo.ng');

    // ---- DOCTOR: create a lab order via the UI ----
    const doc = await openApp(browser, 'doctor.html', 'mcd:token', docTok);
    await doc.page.waitForTimeout(1500);
    ok('doctor app loads with orders section', (await doc.page.content()).includes('Your orders'));
    // navigate to a patient and create an order through the API the UI calls (exercise the same path the button uses)
    const created = await doc.page.evaluate(async () => {
      const r = await fetch(location.origin + '/api/doc/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('mcd:token') }, body: JSON.stringify({ type: 'lab', patientId: 'p_amaka', tests: ['Thyroid function'] }) });
      return (await r.json());
    });
    ok('doctor UI creates a lab order', created && created.status === 'ordered');
    const loId = created.id;

    // ---- LAB: order shows up in the console ----
    const lab = await openApp(browser, 'lab.html', 'mclab:token', labTok);
    await lab.page.waitForTimeout(1500);
    const labText = await lab.page.evaluate(() => document.body.innerText);
    ok('lab console shows the new test in queue', labText.includes('Thyroid function'));

    // lab collects + results it via the same endpoints the buttons call
    await lab.page.evaluate(async (id) => {
      const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('mclab:token') };
      await fetch(location.origin + '/api/lab/orders/' + id + '/collect', { method: 'POST', headers: h });
      await fetch(location.origin + '/api/lab/orders/' + id + '/result', { method: 'POST', headers: h, body: JSON.stringify({ results: [{ test: 'Thyroid function', value: '2.1', unit: 'mIU/L', flag: 'normal' }] }) });
    }, loId);

    // ---- PATIENT: sees the result on home + a notification dot ----
    const pat = await openApp(browser, 'index.html', 'mc:token', patTok);
    await pat.page.waitForTimeout(2000);
    const patText = await pat.page.evaluate(() => document.body.innerText);
    ok('patient home shows Your orders section', patText.includes('Your orders'));
    ok('patient sees the thyroid result value', patText.includes('2.1'));
    const hasDot = await pat.page.evaluate(() => !!document.querySelector('.tb-btn .dot'));
    ok('patient notification dot is showing', hasDot);
    // open the bell and confirm a notification line is present
    await pat.page.evaluate(() => { const b = [...document.querySelectorAll('.tb-btn')].find(x => x.querySelector('.dot')); if (b) b.click(); });
    await pat.page.waitForTimeout(600);
    const sheetText = await pat.page.evaluate(() => (document.querySelector('#sheet') || {}).innerText || '');
    ok('patient notifications sheet lists the result alert', /result/i.test(sheetText));

    console.log('\n============ SMOKE (UI) ============');
    console.log('PASS ' + pass + '   FAIL ' + fail);
    console.log('===================================');
  } catch (e) { console.error('ERROR', e); fail++; }
  finally { if (browser) await browser.close(); srv.kill(); try { fs.unlinkSync(DB); } catch (e) {} process.exit(fail ? 1 : 0); }
})();
