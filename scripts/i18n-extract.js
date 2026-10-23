#!/usr/bin/env node
'use strict';
/*
 * Collects every translatable string from the apps into public/assets/i18n/en.json, and reports
 * which keys each language file is missing.
 *   node scripts/i18n-extract.js            write en.json and print coverage
 *   node scripts/i18n-extract.js --check    exit 1 if any language misses keys (for CI)
 * Patterns: MC.t('key', 'English'), t('key', 'English') in the kit, T('key', 'English') in hq-config (prefix hq.).
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'public');
const files = [path.join(root, 'assets', 'mc.js'), path.join(root, 'assets', 'referrals.js'), path.join(root, 'assets', 'whatsapp.js')].concat(fs.readdirSync(path.join(root, 'apps')).filter(f => f.endsWith('.js')).map(f => path.join(root, 'apps', f)));
const STR = "'((?:[^'\\\\]|\\\\.)*)'";
const out = {}; const dup = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  // each app may alias the translator: `const T = MC.t` (full keys) or `const T = (k, ...) => MC.t('app.' + k, ...)` (prefixed keys)
  const pref = src.match(/const\s+T\s*=\s*\([^)]*\)\s*=>\s*MC\.t\(\s*'([a-z_.]+)'\s*\+/);
  const alias = /const\s+T\s*=\s*MC\.t\b/.test(src);
  const tPrefix = pref ? pref[1] : (alias ? '' : null);
  const res = [new RegExp('MC\\.t\\(\\s*' + STR + '\\s*,\\s*' + STR, 'g'), new RegExp('(?<![\\w.])t\\(\\s*' + STR + '\\s*,\\s*' + STR, 'g')];
  if (tPrefix !== null) res.push(new RegExp('(?<![\\w.])T\\(\\s*' + STR + '\\s*,\\s*' + STR, 'g'));
  // helpers that take ('full.key', 'English') pairs, e.g. nav('#/x', 'icon', 'patient.nav.x', 'X')
  res.push(new RegExp("'((?:kit|status|patient|register|frontdesk|doctor|pharmacy|rider|dispatch|crew|lab|chw|payer|admin|hq)\\.[a-z0-9_.]+)'\\s*,\\s*" + STR, 'g'));
  // dynamic keys built from a label map in the same file: T('urg.' + u, URG_EN[u] || ...) with const URG_EN = { emergency: 'Emergency', ... }
  const maps = {};
  const mapRe = /const\s+([A-Z_][A-Z0-9_]*)\s*=\s*\{([^{}]*)\}/g; let mm;
  while ((mm = mapRe.exec(src))) { const ent = {}; const er = /(?:^|[,{\s])['"]?([a-zA-Z0-9_.]+)['"]?\s*:\s*'((?:[^'\\]|\\.)*)'/g; let e2; while ((e2 = er.exec(mm[2]))) ent[e2[1]] = e2[2].replace(/\\'/g, "'"); if (Object.keys(ent).length) maps[mm[1]] = ent; }
  const dynRe = /\b(MC\.t|T|t)\(\s*'([a-z_.]+\.)'\s*\+\s*[\w.]+(?:\s*\+\s*'([a-z_]*)')?\s*,\s*([A-Z_][A-Z0-9_]*)\[/g; let dm;
  while ((dm = dynRe.exec(src))) {
    const map = maps[dm[4]]; if (!map) continue;
    const pre = (dm[1] === 'T' && tPrefix !== null ? tPrefix : '') + dm[2];
    for (const [k, v] of Object.entries(map)) { const key = pre + k + (dm[3] || ''); if (!out[key]) out[key] = v; }
  }
  res.forEach((re, i) => {
    let m;
    while ((m = re.exec(src))) {
      let key = m[1]; const text = m[2].replace(/\\'/g, "'").replace(/\\n/g, '\n');
      if (i === 2 && tPrefix !== null && res.length === 4) key = tPrefix + key;
      if (key.includes("' +") || /\$\{/.test(key)) continue; // dynamic keys are handled by their prefix entries
      if (/^[a-z_]+\.[a-z0-9_.]+$/.test(text) || !/[A-Za-z]/.test(text)) continue; // a pair of keys (e.g. permission names), not English text
      if (out[key] && out[key] !== text) dup.push(key + ': "' + out[key] + '" vs "' + text + '"');
      if (!out[key]) out[key] = text;
    }
  });
}
// dynamic status labels used across apps
['active', 'pending', 'open', 'paid', 'void', 'cancelled', 'completed', 'booked', 'checked_in', 'in_consult', 'no_show', 'received', 'verified', 'priced', 'ready', 'collected', 'out_for_delivery', 'delivered', 'failed', 'returned', 'assigned', 'picked_up', 'new', 'enroute', 'onscene', 'transporting', 'athospital', 'closed', 'ordered', 'awaiting_lab', 'sample_collected', 'in_progress', 'resulted', 'released', 'submitted', 'under_review', 'approved', 'denied', 'queried', 'resubmitted', 'trial', 'past_due', 'suspended', 'rejected', 'waiting_provider', 'resolved', 'waiting', 'called', 'in_service', 'done', 'left']
  .forEach(s => { const k = 'status.' + s; if (!out[k]) out[k] = (s.charAt(0).toUpperCase() + s.slice(1)).replace(/_/g, ' '); });
const sorted = Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]]));
const dir = path.join(root, 'assets', 'i18n'); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'en.json'), JSON.stringify(sorted, null, 1) + '\n');
let missingAny = false;
console.log('en.json: ' + Object.keys(sorted).length + ' strings from ' + files.length + ' files');
if (dup.length) console.log('Same key, different English (' + dup.length + '):\n  ' + dup.slice(0, 20).join('\n  '));
for (const l of ['pcm', 'yo', 'ha', 'ig']) {
  const p = path.join(dir, l + '.json'); let d = {};
  try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { d = {}; }
  const miss = Object.keys(sorted).filter(k => !d[k]);
  const badPh = Object.keys(d).filter(k => sorted[k] && (String(sorted[k]).match(/\{\w+\}/g) || []).sort().join() !== (String(d[k]).match(/\{\w+\}/g) || []).sort().join());
  if (miss.length || badPh.length) missingAny = true;
  console.log(l + '.json: ' + (Object.keys(sorted).length - miss.length) + '/' + Object.keys(sorted).length + ' translated' + (badPh.length ? ', ' + badPh.length + ' with wrong placeholders' : ''));
}
if (process.argv.includes('--check') && missingAny) process.exit(1);
