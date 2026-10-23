#!/usr/bin/env node
'use strict';
/* Collects user-facing server messages (errors and notification texts) into src/i18n/en.json. */
const fs = require('fs'); const path = require('path');
const src = path.join(__dirname, '..', 'src');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
const STR = "'((?:[^'\\\\]|\\\\.)*)'";
const res = [new RegExp('\\b(?:bad|forbidden|notFound|conflict|locked|tooMany|unauthorized)\\(\\s*' + STR, 'g'), new RegExp('\\b(?:title|body|error|message|label)\\s*:\\s*' + STR, 'g'), new RegExp("t\\.\\w+\\(\\{[^}]*label:\\s*" + STR, 'g')];
const out = {};
for (const f of walk(src)) {
  if (/seed|i18n/.test(f)) continue;
  const s = fs.readFileSync(f, 'utf8');
  for (const re of res) { let m; while ((m = re.exec(s))) { const v = m[1].replace(/\\'/g, "'"); if (v.length < 4 || v.length > 400 || /^[a-z_.]+$/.test(v) || /\$\{/.test(v)) continue; out[v] = v; } }
}
const sorted = Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]]));
fs.writeFileSync(path.join(src, 'i18n', 'en.json'), JSON.stringify(sorted, null, 1) + '\n');
console.log('server en.json: ' + Object.keys(sorted).length + ' messages');
