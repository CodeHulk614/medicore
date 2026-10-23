/* MediCore Lab: sample reception, results, verification and release for a standalone lab or a hospital lab.
 * Roles: lab_reception (receive), lab_scientist (receive, result, verify), lab_manager (+ catalogue).
 * Flags are computed by the server from the lab's ranges; the app never lets anyone set a flag. */
(function () {
  'use strict';
  const { html, api, qs, icon, badge, empty, figures, view, on, form, dialog, confirm, toast } = MC;
  const T = MC.t;

  const css = document.createElement('style');
  css.textContent = `
    #main :is(dd, p, a:not(.btn), span:not(.btn), h1, h2, li, time, .lm) > svg { width: 1.1em; height: 1.1em; vertical-align: -0.18em; flex: none; }
    .l-acc { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 700; letter-spacing: .02em; }
    .l-bar { display: block; width: 100%; max-width: 320px; height: 56px; background: #fff; }
    .l-flag { white-space: nowrap; }
    tr.l-unv td { background: var(--amber-soft); }
    tr.l-crit td { background: var(--red-soft); }
    .l-res .input { min-height: 44px; }
    .l-res td { vertical-align: middle; }
    .l-tests { display: grid; gap: 2px; max-height: 420px; overflow-y: auto; border: 1px solid var(--line); border-radius: var(--r); background: var(--surface); }
    .l-test { display: flex; gap: var(--s3); align-items: center; padding: var(--s2) var(--s3); min-height: 52px; cursor: pointer; border-bottom: 1px solid var(--line-2); }
    .l-test:last-child { border-bottom: 0; }
    .l-test input { width: 22px; height: 22px; accent-color: var(--hue); flex: none; }
    .l-test:has(input:checked) { background: var(--hue-soft); }
    .l-test .grow { flex: 1; min-width: 0; }
    .l-total { position: sticky; bottom: 0; background: var(--surface); border-top: 1px solid var(--line); padding: var(--s3) 0; }
    .l-scan .input { font-size: 1.25rem; min-height: 56px; }
    .l-report { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: var(--s5); }
    .l-report header { display: flex; justify-content: space-between; gap: var(--s4); flex-wrap: wrap; border-bottom: 2px solid var(--ink); padding-bottom: var(--s3); margin-bottom: var(--s4); }
    .l-report h2 { font-size: var(--t-lg); margin: var(--s4) 0 var(--s2); }
    .l-report .kv { font-size: var(--t-sm); }
    .l-report .grid2 { display: grid; gap: var(--s4); } @media (min-width: 720px) { .l-report .grid2 { grid-template-columns: 1fr 1fr; } }
    .l-draft { border: 2px dashed var(--red); color: var(--red); font-weight: 700; padding: var(--s2) var(--s3); text-align: center; margin-bottom: var(--s3); }
    @media print {
      body[data-app="lab"] { font-size: 11pt; }
      .l-report { border: 0; padding: 0; }
      .l-report table.t th { background: #eee !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .l-report .flag-critical { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .l-report table.t { font-size: 10pt; }
      .back { display: none !important; }
      .layout { display: block !important; } .page-head { display: none !important; }
      @page { margin: 14mm; }
    }
  `;
  document.head.appendChild(css);

  /* ---------------- labels ---------------- */
  const FLOW = ['ordered', 'paid', 'sample_collected', 'in_progress', 'resulted', 'verified', 'released'];
  const ST_EN = { awaiting_lab: 'Choosing a lab', ordered: 'Awaiting payment', paid: 'Paid, awaiting sample', sample_collected: 'Sample collected', in_progress: 'In progress', resulted: 'Resulted, to verify', verified: 'Verified, to release', released: 'Released', cancelled: 'Cancelled' };
  const stLabel = s => T('lab.status.' + s, ST_EN[s] || MC.cap(s));
  const ST_KIND = { ordered: 'warn', paid: 'info', sample_collected: 'info', in_progress: 'info', resulted: 'warn', verified: 'hue', released: 'ok', cancelled: 'outline', awaiting_lab: 'outline' };
  const stBadge = s => badge(stLabel(s), ST_KIND[s] || 'info');
  const stepLabels = () => Object.fromEntries(FLOW.map(s => [s, T('lab.step.' + s, { ordered: 'Ordered', paid: 'Paid', sample_collected: 'Sample', in_progress: 'Testing', resulted: 'Resulted', verified: 'Verified', released: 'Released' }[s])]));
  const FLAG_EN = { normal: 'Normal', low: 'Low', high: 'High', abnormal: 'Abnormal', unverified: 'Not a valid value' };
  function flagCell(r) {
    const f = r.flag || 'normal';
    return html`<span class="l-flag">${r.critical ? html`<span class="flag-critical">${T('lab.flag.critical', 'Critical')}</span> ` : ''}<span class="${f === 'normal' ? 'muted' : 'flag-' + f}">${T('lab.flag.' + f, FLAG_EN[f] || MC.cap(f))}</span></span>`;
  }
  function rangeText(rg, unit) {
    if (!rg) return '';
    if (rg.qualitative || (rg.low == null && rg.high == null)) return rg.normalText ? T('lab.range.normal_is', 'Normal: {v}', { v: rg.normalText }) : '';
    const u = unit ? ' ' + unit : '';
    if (rg.low != null && rg.high != null) return T('lab.range.between', '{lo} to {hi}', { lo: rg.low, hi: rg.high }) + u;
    if (rg.high != null) return T('lab.range.below', 'Below {hi}', { hi: rg.high }) + u;
    return T('lab.range.above', 'Above {lo}', { lo: rg.low }) + u;
  }
  function critText(rg) {
    if (!rg) return '';
    const p = []; if (rg.critLow != null) p.push(T('lab.range.crit_low', 'below {v}', { v: rg.critLow })); if (rg.critHigh != null) p.push(T('lab.range.crit_high', 'above {v}', { v: rg.critHigh }));
    return p.length ? T('lab.range.critical', 'Critical {limits}', { limits: p.join(T('lab.range.or', ' or ')) }) : '';
  }
  function tatCell(o) {
    if (['released', 'cancelled'].includes(o.status)) return o.releasedAt && o.collectedAt ? html`<span class="sm muted">${T('lab.tat.took', 'Took {t}', { t: dur(o.releasedAt - o.collectedAt) })}</span>` : '';
    if (!o.collectedAt) return html`<span class="sm muted">${T('lab.tat.target', '{h} h turnaround', { h: o.tatHours || '?' })}</span>`;
    if (o.overdue) return badge(T('lab.tat.overdue', 'Overdue by {t}', { t: dur(-(o.minutesLeft || 0) * 60000) }), 'bad');
    const tone = o.minutesLeft != null && o.minutesLeft < 60 ? 'warn' : 'outline';
    return badge(T('lab.tat.due', 'Due in {t}', { t: dur((o.minutesLeft || 0) * 60000) }), tone);
  }
  function dur(ms) { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? T('lab.dur.min', '{m} min', { m }) : T('lab.dur.h', '{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 }); }
  const perm = p => !!(MC.me && (MC.me.perms || []).includes(p));
  const ptName = o => (o.patient ? o.patient.name : T('lab.patient', 'Patient'));
  const ptMeta = p => (p ? [p.mrn ? 'MRN ' + p.mrn : '', p.age != null ? T('lab.yrs', '{n} yrs', { n: p.age }) : '', p.sex && p.sex !== 'unknown' ? MC.cap(p.sex) : ''].filter(Boolean).join(' | ') : '');
  const SOURCE_EN = { referral: 'Referral', self: 'Patient request', walk_in: 'Walk-in' };
  const srcLabel = s => T('lab.source.' + s, SOURCE_EN[s] || MC.cap(s));
  const pr = p => (p === 'urgent' ? badge(T('lab.urgent', 'Urgent'), 'bad') : '');

  /* delegated change/input handlers (no inline JS) */
  const changes = {};
  ['change', 'input'].forEach(ev => document.addEventListener(ev, e => { const el = e.target.closest('[data-change]'); if (el && changes[el.dataset.change]) changes[el.dataset.change](el, e); }));

  /* ---------------- Code128 (set B) barcode for accession labels ---------------- */
  const C128 = '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'.split(' ');
  function barcode(text) {
    const s = String(text || '').replace(/[^\x20-\x7E]/g, '');
    if (!s) return '';
    const codes = [104]; for (let i = 0; i < s.length; i++) codes.push(s.charCodeAt(i) - 32);
    let sum = 104; for (let i = 1; i < codes.length; i++) sum += codes[i] * i; codes.push(sum % 103); codes.push(106);
    const bars = []; let x = 10;
    codes.forEach(c => { const p = C128[c]; for (let i = 0; i < p.length; i++) { const w = Number(p[i]); if (i % 2 === 0) bars.push([x, w]); x += w; } });
    const W = x + 10;
    return html`<svg class="l-bar" viewBox="0 0 ${W} 50" preserveAspectRatio="none" role="img" aria-label="${T('lab.barcode', 'Barcode {acc}', { acc: s })}"><rect x="0" y="0" width="${W}" height="50" fill="#fff"/>${bars.map(b => html`<rect x="${b[0]}" y="2" width="${b[1]}" height="46" fill="#000"/>`)}</svg>`;
  }

  /* ---------------- worklist ---------------- */
  const TABS = [['', 'All open'], ['ordered', 'Awaiting payment'], ['paid', 'Paid'], ['sample_collected', 'Sample collected'], ['in_progress', 'In progress'], ['resulted', 'Resulted'], ['verified', 'Verified'], ['released', 'Released'], ['overdue', 'Overdue']];
  function scanForm(id, big) {
    return html`<form data-form="acc-find" class="${big ? 'l-scan' : 'row'}" novalidate role="search">
      <div class="field" style="${big ? '' : 'margin:0;flex:1;min-width:180px'}"><label for="${id}" class="${big ? '' : 'sr-only'}">${T('lab.scan.label', 'Accession number (type or scan)')}</label>
      <div class="search">${icon('search')}<input class="input l-acc" id="${id}" name="acc" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${T('lab.scan.ph', 'Scan or type accession')}" ${big ? 'autofocus' : ''}></div></div>
      <button class="btn ${big ? 'primary lg block' : ''}" type="submit">${T('lab.scan.find', 'Find sample')}</button></form>`;
  }
  form('acc-find', async d => {
    const acc = String(d.acc || '').trim().toUpperCase();
    if (!acc) throw new MC.ApiError(400, { error: T('lab.scan.empty', 'Scan the barcode or type the accession number') });
    let o;
    try { o = await api.get('/api/lab/accession/' + encodeURIComponent(acc)); }
    catch (e) { if (e.status === 404) throw new MC.ApiError(404, { error: T('lab.scan.none', 'No sample with accession {acc} at this lab. Check the label and try again.', { acc }) }); throw e; }
    MC.go('#/order/' + o.id);
  });
  function setCounts(all) { MC.navCount('#/worklist', all.filter(o => o.status !== 'released').length); }
  function orderRows(rows) {
    return html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('lab.wl.order', 'Order')}</th><th>${T('lab.wl.patient', 'Patient')}</th><th>${T('lab.wl.tests', 'Tests')}</th><th>${T('lab.wl.status', 'Status')}</th><th>${T('lab.wl.tat', 'Turnaround')}</th><th>${T('lab.wl.from', 'From')}</th></tr></thead><tbody>
      ${rows.map(o => html`<tr class="click ${o.criticalPending ? 'l-crit' : ''}"><td data-label="${T('lab.wl.order', 'Order')}"><a href="#/order/${o.id}"><b>${o.number}</b></a>${o.accession ? html`<br><span class="xs l-acc">${o.accession}</span>` : ''}</td>
        <td data-label="${T('lab.wl.patient', 'Patient')}"><b>${ptName(o)}</b><br><span class="xs muted">${ptMeta(o.patient)}</span></td>
        <td data-label="${T('lab.wl.tests', 'Tests')}">${o.tests.map(x => x.name).join(', ')}</td>
        <td data-label="${T('lab.wl.status', 'Status')}">${stBadge(o.status)} ${pr(o.priority)}${o.criticalPending ? html` ${badge(T('lab.wl.callback', 'Critical: call back'), 'bad')}` : ''}${o.hasUnverified ? html` ${badge(T('lab.wl.unverified', 'Invalid value'), 'warn')}` : ''}${o.urgentOverride && !o.paid ? html` ${badge(T('lab.wl.unpaid', 'Collected before payment'), 'warn')}` : ''}${o.version > 1 ? html` ${badge(T('lab.wl.amended', 'Amended'), 'outline')}` : ''}</td>
        <td data-label="${T('lab.wl.tat', 'Turnaround')}">${tatCell(o)}</td>
        <td data-label="${T('lab.wl.from', 'From')}">${o.referringOrgName || o.referrerName || srcLabel(o.source)}${o.orderedByName && o.source !== 'walk_in' ? html`<br><span class="xs muted">${o.orderedByName}</span>` : ''}</td></tr>`)}</tbody></table></div>`;
  }
  async function worklist({ query, stale }) {
    const tab = TABS.some(x => x[0] === query.status) ? (query.status || '') : '';
    const path = tab === 'overdue' ? '/api/lab/worklist?overdue=true' : '/api/lab/worklist' + qs({ status: tab });
    const load = () => Promise.all([api.get('/api/lab/worklist'), tab ? api.get(path) : null]);
    let [all, rows] = await load();
    if (stale()) return;
    const paint = () => {
      const list = tab ? rows : all;
      const c = s => all.filter(o => o.status === s).length;
      view(html`<div class="page-head"><div><h1>${T('lab.wl.title', 'Worklist')}</h1><p>${T('lab.wl.sub', 'Critical callbacks first, then urgent, overdue and oldest')}</p></div>
        <div class="actions">${perm('lab.receive') ? html`<a class="btn primary" href="#/walkin">${icon('plus')}${T('lab.wl.walkin', 'Walk-in order')}</a>` : ''}</div></div>
        <div id="wl-ref-note"></div><div style="margin-bottom:16px">${scanForm('wl-acc', false)}</div>
        ${figures([{ value: c('ordered'), label: T('lab.fig.unpaid', 'Awaiting payment') }, { value: c('paid'), label: T('lab.fig.collect', 'To collect') }, { value: c('sample_collected') + c('in_progress'), label: T('lab.fig.testing', 'In the lab') }, { value: c('resulted'), label: T('lab.fig.verify', 'To verify'), tone: c('resulted') ? 'warn' : '' }, { value: c('verified'), label: T('lab.fig.release', 'To release') }, { value: all.filter(o => o.overdue).length, label: T('lab.fig.overdue', 'Overdue'), tone: all.some(o => o.overdue) ? 'bad' : '' }, { value: all.filter(o => o.criticalPending).length, label: T('lab.fig.critical', 'Critical callbacks'), tone: all.some(o => o.criticalPending) ? 'bad' : '' }])}
        <div class="tabs" role="tablist">${TABS.map(([k, en]) => html`<a href="#/worklist${k ? '?status=' + k : ''}" role="tab" aria-selected="${tab === k ? 'true' : 'false'}">${T('lab.tab.' + (k || 'all'), en)}</a>`)}</div>
        ${list.length ? orderRows(list) : empty({ icon: 'flask', title: T('lab.wl.empty', 'Nothing here'), body: tab ? T('lab.wl.empty_tab', 'No orders with this status right now.') : T('lab.wl.empty_all', 'Referred orders, patient requests and walk-ins appear here when they are sent to your lab.'), action: perm('lab.receive') ? html`<a class="btn" href="#/walkin">${T('lab.wl.walkin', 'Walk-in order')}</a>` : '' })}`);
      setCounts(all);
      MC.referrals.homeNotice(document.getElementById('wl-ref-note'));
    };
    paint();
    MC.poll(async () => { const r = await load(); if (stale()) return; [all, rows] = r; const a = document.activeElement; if (a && a.id === 'wl-acc' && a.value) return; paint(); }, 30000);
  }

  async function lookup() {
    view(html`<div class="page-head"><div><h1>${T('lab.scan.title', 'Find a sample')}</h1><p>${T('lab.scan.sub', 'Scan the tube barcode or type the accession number, then press Enter.')}</p></div></div><section class="panel">${scanForm('lk-acc', true)}</section>`);
    setTimeout(() => { const i = document.getElementById('lk-acc'); if (i) i.focus(); }, 50);
  }

  /* ---------------- order page ---------------- */
  let catCache = null;
  const getCatalog = async () => catCache || (catCache = await api.get('/api/lab/catalog'));
  function resultsTable(results, opts = {}) {
    return html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('lab.res.test', 'Test')}</th><th>${T('lab.res.result', 'Result')}</th><th>${T('lab.res.flag', 'Flag')}</th><th>${T('lab.res.range', 'Reference range')}</th>${opts.comments !== false ? html`<th>${T('lab.res.comment', 'Comment')}</th>` : ''}</tr></thead><tbody>
      ${results.map(r => html`<tr class="${r.flag === 'unverified' ? 'l-unv' : r.critical ? 'l-crit' : ''}"><td data-label="${T('lab.res.test', 'Test')}"><b>${r.name}</b> <span class="xs muted">${r.code}</span></td><td data-label="${T('lab.res.result', 'Result')}"><b>${r.value}</b> ${r.unit || ''}</td><td data-label="${T('lab.res.flag', 'Flag')}">${flagCell(r)}</td><td data-label="${T('lab.res.range', 'Reference range')}">${rangeText(r.range, r.unit)}</td>${opts.comments !== false ? html`<td data-label="${T('lab.res.comment', 'Comment')}">${r.comment || ''}</td>` : ''}</tr>`)}</tbody></table></div>`;
  }
  let referPt = null;
  on('lab-refer', async el => { const pid = el.dataset.p; await MC.referrals.sendDialog({ patient: referPt && referPt.id === pid ? referPt : { id: pid } }); });
  async function orderPage({ params, stale }) {
    const o = await api.get('/api/lab/orders/' + params.id);
    const [pt, bill, cat, fresh] = await Promise.all([
      o.patient ? api.get('/api/fd/patients/' + o.patient.id).catch(() => null) : null,
      o.billId ? api.get('/api/bills/' + o.billId).catch(() => null) : null,
      ['in_progress', 'released'].includes(o.status) ? getCatalog().catch(() => []) : null,
      ['resulted', 'verified', 'in_progress'].includes(o.status) ? api.get('/api/auth/me').catch(() => MC.me) : MC.me,
    ]);
    if (stale()) return;
    const twoStep = !!(fresh && fresh.org && fresh.org.settings && fresh.org.settings.twoStepLabVerify);
    const iEntered = !!(o.enteredBy && o.enteredBy.userId === MC.me.user.id);
    const blockedTwoStep = twoStep && iEntered;
    const catBy = Object.fromEntries((cat || []).map(c => [c.code, c]));
    const comps = (o.components || []).flatMap(t => t.components.map(c => Object.assign({ test: t.code }, c)));
    const crit = o.critical || {};
    referPt = pt || (o.patient ? { id: o.patient.id, name: ptName(o), age: o.patient.age, sex: o.patient.sex, mrn: o.patient.mrn } : null);
    const wb = pt ? MC.wristband(pt) : MC.wristband({ name: ptName(o), age: o.patient && o.patient.age, sex: o.patient && o.patient.sex, mrn: o.patient && o.patient.mrn, allergies: [] });
    const unpaidKobo = bill ? Math.max(0, (bill.patientDueKobo || 0) - (bill.paidKobo || 0)) : null;

    let actionsBlock = '';
    if (o.status === 'ordered') actionsBlock = html`<div class="notice warn"><b>${T('lab.ord.unpaid', 'Awaiting payment.')}</b> ${bill ? T('lab.ord.unpaid_amt', '{amt} to pay. The patient pays online in the MediCore app or at the cashier; the order moves to Paid by itself.', { amt: MC.money(unpaidKobo) }) : ''}</div>
      ${perm('lab.receive') && o.priority === 'urgent' ? html`<button class="btn danger" data-action="ord-receive-urgent">${icon('alert')}${T('lab.ord.urgent_collect', 'Collect before payment (urgent)')}</button>` : html`<p class="muted sm">${T('lab.ord.routine_wait', 'Routine orders are collected after payment.')}</p>`}`;
    else if (o.status === 'paid' && perm('lab.receive')) actionsBlock = html`<button class="btn primary lg" data-action="ord-receive">${icon('check')}${T('lab.ord.receive', 'Receive sample')}</button>`;
    else if (o.status === 'sample_collected' && perm('lab.result')) actionsBlock = html`<button class="btn primary lg" data-action="ord-start">${icon('flask')}${T('lab.ord.start', 'Start testing')}</button>`;
    else if (o.status === 'resulted' && perm('lab.verify')) actionsBlock = html`
      ${o.hasUnverified ? html`<div class="notice warn">${T('lab.ord.has_unv', 'Some values are not valid numbers (highlighted). Reopen the order and correct them before verifying.')}</div>` : ''}
      ${blockedTwoStep ? html`<div class="notice warn" role="note"><b>${T('lab.ord.two_step', 'Second scientist required.')}</b> ${T('lab.ord.two_step_body', 'Two-step verification is on and you entered these results. Another scientist must verify them.')}</div>` : twoStep ? html`<p class="muted sm">${T('lab.ord.two_step_info', 'Two-step verification is on: you are verifying results entered by {name}.', { name: o.enteredBy ? o.enteredBy.name : '' })}</p>` : ''}
      <div class="btn-row" style="margin-top:0">${o.hasUnverified || blockedTwoStep ? html`<button class="btn primary" disabled aria-disabled="true">${icon('check')}${T('lab.ord.verify', 'Verify results')}</button>` : html`<button class="btn primary" data-action="ord-verify">${icon('check')}${T('lab.ord.verify', 'Verify results')}</button>`}<button class="btn" data-action="ord-reopen">${T('lab.ord.reopen', 'Reopen to correct')}</button></div>`;
    else if (o.status === 'resulted' && perm('lab.result')) actionsBlock = html`<p class="muted">${T('lab.ord.wait_verify', 'Waiting for a scientist with verify rights.')}</p><button class="btn" data-action="ord-reopen">${T('lab.ord.reopen', 'Reopen to correct')}</button>`;
    else if (o.status === 'verified' && perm('lab.verify')) actionsBlock = html`<div class="btn-row" style="margin-top:0"><button class="btn primary lg" data-action="ord-release">${icon('download')}${T('lab.ord.release', 'Release results')}</button><button class="btn" data-action="ord-reopen">${T('lab.ord.reopen', 'Reopen to correct')}</button></div>`;

    const entry = o.status === 'in_progress' && perm('lab.result') ? html`<form class="panel" data-form="ord-results" novalidate><h2>${T('lab.res.enter', 'Enter results')}</h2>
      <p class="muted sm">${T('lab.res.enter_sub', 'Type the measured value for every component. The flag (low, high, critical) is worked out by the system from this lab\'s ranges when you save.')}</p>
      <div class="table-wrap l-res"><table class="t stack-sm"><thead><tr><th>${T('lab.res.test', 'Test')}</th><th>${T('lab.res.value', 'Value')}</th><th>${T('lab.res.range', 'Reference range')}</th><th>${T('lab.res.comment', 'Comment')}</th></tr></thead><tbody>
      ${comps.map(c => { const ce = catBy[c.code] || {}; const rg = ce.range || {}; const prev = (o.results || []).find(r => r.code === c.code); return html`<tr><td data-label="${T('lab.res.test', 'Test')}"><label for="r-${c.code}"><b>${c.name}</b></label> <span class="xs muted">${c.code}</span></td>
        <td data-label="${T('lab.res.value', 'Value')}"><div class="row" style="gap:6px"><input class="input" id="r-${c.code}" name="r_${c.code}" required maxlength="200" autocomplete="off" inputmode="${rg.qualitative ? 'text' : 'decimal'}" value="${prev ? prev.value : ''}" style="max-width:160px"><span class="sm">${rg.unit || ''}</span></div></td>
        <td data-label="${T('lab.res.range', 'Reference range')}"><span class="sm">${rangeText(rg, rg.unit)}</span>${critText(rg) ? html`<br><span class="xs muted">${critText(rg)}</span>` : ''}</td>
        <td data-label="${T('lab.res.comment', 'Comment')}"><label for="rc-${c.code}" class="sr-only">${T('lab.res.comment_for', 'Comment for {t}', { t: c.name })}</label><input class="input" id="rc-${c.code}" name="c_${c.code}" maxlength="300" value="${prev && prev.comment ? prev.comment : ''}"></td></tr>`; })}</tbody></table></div>
      <div class="form-err notice bad" hidden></div><div class="btn-row"><button class="btn primary" type="submit">${T('lab.res.save', 'Save results')}</button></div></form>` : '';

    const released = o.status === 'released';
    view(html`<a class="back" href="#/worklist">${icon('left')}${T('lab.nav.worklist', 'Worklist')}</a>
      <div class="page-head"><div><h1>${o.number} ${stBadge(o.status)} ${pr(o.priority)}</h1><p>${o.tests.map(x => x.name).join(', ')}</p></div>
        <div class="actions">${['resulted', 'verified', 'released'].includes(o.status) ? html`<a class="btn" href="#/report/${o.id}">${icon('file')}${released ? T('lab.ord.print', 'Printable report') : T('lab.ord.preview', 'Preview report')}</a>` : ''}
          ${released && crit.has && perm('lab.result') || released && crit.has && perm('lab.verify') ? html`<button class="btn ${crit.acknowledged ? '' : 'danger'}" data-action="ord-callback">${icon('phone')}${T('lab.ord.callback', 'Record critical callback')}</button>` : ''}
          ${released && perm('lab.verify') ? html`<button class="btn" data-action="ord-amend">${icon('edit')}${T('lab.ord.amend', 'Amend report')}</button>` : ''}
          ${o.patient && o.patient.id && MC.feature('referralNetwork') && MC.referrals.canSend() ? html`<button class="btn ${released && crit.has ? 'primary' : ''}" data-action="lab-refer" data-p="${o.patient.id}">${icon('swap')}${T('lab.ord.refer', 'Refer patient')}</button>` : ''}
          ${['ordered', 'paid'].includes(o.status) && perm('lab.receive') ? html`<button class="btn danger" data-action="ord-cancel">${T('lab.ord.cancel', 'Cancel order')}</button>` : ''}</div></div>
      ${wb}
      ${released && crit.has && !crit.acknowledged ? html`<div class="notice bad" role="alert"><b>${T('lab.ord.crit_pending', 'Critical value released.')}</b> ${T('lab.ord.crit_pending_body', 'Phone the requesting doctor (or the patient for a self-request) now and record who you told.')}</div>` : ''}
      ${o.status !== 'cancelled' ? MC.steps(FLOW, o.status, stepLabels()) : html`<div class="notice">${T('lab.ord.cancelled', 'This order was cancelled.')}</div>`}
      <div class="grid side-r"><div>
        ${actionsBlock ? html`<section class="panel">${actionsBlock}</section>` : ''}
        ${entry}
        ${(o.results || []).length && o.status !== 'in_progress' ? html`<section class="panel flush"><h2>${released && o.version > 1 ? T('lab.res.title_v', 'Results (version {v})', { v: o.version }) : T('lab.res.title', 'Results')}</h2>${resultsTable(o.results)}
          <p class="xs muted" style="padding:8px 16px">${o.enteredBy ? T('lab.res.entered', 'Entered by {name}, {at}', { name: o.enteredBy.name, at: MC.dateTime(o.enteredBy.at) }) : ''}${o.verifiedBy ? ' | ' + T('lab.res.verified', 'Verified by {name}, {at}', { name: o.verifiedBy.name, at: MC.dateTime(o.verifiedBy.at) }) : ''}</p></section>` : ''}
        ${crit.has || (crit.callbacks || []).length ? html`<section class="panel"><h2>${T('lab.cb.title', 'Critical value callbacks')}</h2>${(crit.callbacks || []).length ? html`<ol class="timeline">${crit.callbacks.map(c => html`<li><time>${MC.dateTime(c.at)} | ${c.byName || ''}</time>${T('lab.cb.told', 'Told {to}', { to: c.to })} (${T('lab.cb.m.' + c.method, { phone: 'by phone', in_person: 'in person', other: 'other', app_ack: 'acknowledged in the app' }[c.method] || c.method)})${c.note ? html`: ${c.note}` : ''}</li>`)}</ol>` : html`<p class="muted sm">${T('lab.cb.none', 'No callback recorded yet.')}</p>`}</section>` : ''}
        ${(o.amendments || []).length ? html`<section class="panel"><h2>${T('lab.am.title', 'Amendments')}</h2><ol class="timeline">${o.amendments.map(a => html`<li><time>${MC.dateTime(a.at)} | ${a.byName}</time>${T('lab.am.version', 'Version {v}', { v: a.version })}: ${a.reason}${a.codes ? html` <span class="muted">(${a.codes.join(', ')})</span>` : ''}</li>`)}</ol>
          ${(o.versions || []).length ? html`<h3>${T('lab.am.history', 'Earlier versions')}</h3>${o.versions.slice().reverse().map(v => html`<details style="margin-bottom:8px"><summary>${T('lab.am.v_line', 'Version {v}, replaced {at}', { v: v.version, at: MC.dateTime(v.supersededAt) })}</summary>${resultsTable(v.results || [], { comments: false })}</details>`)}` : ''}</section>` : ''}
      </div><div>
        <section class="panel"><h2>${T('lab.ord.details', 'Order details')}</h2><dl class="kv">
          <dt>${T('lab.ord.source', 'Source')}</dt><dd>${srcLabel(o.source)}</dd>
          <dt>${T('lab.ord.referring', 'Referring provider')}</dt><dd>${o.referringOrgName || T('lab.ord.none', 'None')}</dd>
          <dt>${T('lab.ord.doctor', 'Requesting doctor')}</dt><dd>${o.source === 'walk_in' ? (o.referrerName || T('lab.ord.none', 'None')) : (o.orderedByName || o.referrerName || (o.selfRequested ? T('lab.ord.self', 'Patient\'s own request') : T('lab.ord.none', 'None')))}</dd>
          <dt>${T('lab.ord.tests', 'Tests')}</dt><dd>${o.tests.map(x => html`<div>${x.name} <span class="xs muted">${x.code}</span></div>`)}</dd>
          ${o.clinicalNote ? html`<dt>${T('lab.ord.note', 'Clinical note')}</dt><dd>${o.clinicalNote}</dd>` : ''}
          <dt>${T('lab.ord.ordered', 'Ordered')}</dt><dd>${MC.dateTime(o.createdAt)}</dd>
          <dt>${T('lab.ord.tat', 'Turnaround')}</dt><dd>${T('lab.tat.hours', '{h} hours', { h: o.tatHours || '?' })} ${tatCell(o)}</dd>
          <dt>${T('lab.ord.bill', 'Bill')}</dt><dd>${bill ? html`${MC.money(bill.totalKobo)} ${bill.status === 'paid' || o.paid ? badge(T('lab.ord.paid', 'Paid') + (o.paidVia ? ' (' + MC.cap(o.paidVia) + ')' : ''), 'ok') : bill.status === 'void' ? badge(T('lab.ord.void', 'Void'), 'outline') : badge(T('lab.ord.unpaid_b', '{amt} unpaid', { amt: MC.money(unpaidKobo) }), 'warn')}${bill.hmoCoveredKobo ? html`<br><span class="xs muted">${T('lab.ord.hmo', 'HMO covers {amt}', { amt: MC.money(bill.hmoCoveredKobo) })}</span>` : ''}` : (o.paid ? badge(T('lab.ord.paid', 'Paid'), 'ok') : T('lab.ord.no_bill', 'No bill'))}</dd>
        </dl></section>
        ${o.accession ? html`<section class="panel"><h2>${T('lab.ord.sample', 'Sample')}</h2><p class="l-acc" style="font-size:1.25rem;margin-bottom:4px">${o.accession}</p>${barcode(o.accession)}
          <dl class="kv" style="margin-top:12px"><dt>${T('lab.ord.collected', 'Collected')}</dt><dd>${o.specimen ? MC.dateTime(o.specimen.collectedAt) + ' | ' + (o.specimen.collectorName || '') : ''}</dd>${o.specimen && o.specimen.types ? html`<dt>${T('lab.ord.specimen', 'Specimen')}</dt><dd>${o.specimen.types.join(', ')}</dd>` : ''}${o.specimen && o.specimen.note ? html`<dt>${T('lab.ord.sp_note', 'Note')}</dt><dd>${o.specimen.note}</dd>` : ''}
          ${o.specimen && o.specimen.urgentOverride ? html`<dt>${T('lab.ord.override', 'Collected before payment')}</dt><dd>${o.specimen.urgentOverride.reason}</dd>` : ''}</dl>
          <div class="btn-row no-print"><button class="btn sm" data-action="ord-label">${icon('download')}${T('lab.ord.label', 'Print tube label')}</button></div></section>` : ''}
        <section class="panel"><h2>${T('lab.ord.timeline', 'History')}</h2><ol class="timeline">${(o.timeline || []).map(x => html`<li><time>${MC.dateTime(x.at)}${x.byName ? ' | ' + x.byName : ''}</time>${stLabel(x.status)}${x.note ? html`: ${x.note}` : ''}</li>`)}</ol></section>
      </div></div>`);

    const done = msg => { toast(msg, 'ok'); MC.render(); };
    const showAcc = async u => {
      await dialog({ title: T('lab.ord.acc_t', 'Label the sample'), body: html`<p>${T('lab.ord.acc_body', 'Write or print this accession number on the tube for {name}.', { name: ptName(o) })}</p><p class="l-acc" style="font-size:1.75rem;text-align:center">${u.accession}</p>${barcode(u.accession)}`, actions: [{ label: T('lab.done', 'Done'), primary: true, value: true }] });
    };
    on('ord-receive', async () => {
      const r = await dialog({ title: T('lab.ord.receive', 'Receive sample'), form: true, body: html`<p>${T('lab.ord.receive_body', 'Confirm the sample is labelled for {name} and matches the request: {tests}.', { name: ptName(o), tests: o.tests.map(x => x.name).join(', ') })}</p><div class="field"><label for="rv-n">${T('lab.ord.sp_note_l', 'Specimen note (optional)')}</label><input class="input" id="rv-n" name="specimenNote" maxlength="200" placeholder="${T('lab.ord.sp_note_ph', 'e.g. Slightly haemolysed')}"></div>`,
        actions: [{ label: T('lab.cancel', 'Cancel'), value: null }, { label: T('lab.ord.mark_collected', 'Mark sample collected'), primary: true }], onSubmit: d => api.post('/api/lab/orders/' + o.id + '/receive', d.specimenNote ? { specimenNote: d.specimenNote } : {}) });
      if (!r) return; toast(T('lab.ord.collected_t', 'Sample marked collected: {acc}', { acc: r.accession }), 'ok'); await showAcc(r); MC.render();
    });
    on('ord-receive-urgent', async () => {
      const r = await dialog({ title: T('lab.ord.urgent_collect', 'Collect before payment (urgent)'), form: true, body: html`<div class="notice warn">${T('lab.ord.urgent_warn', 'This sample is taken before the bill is paid. Your name and reason are recorded in the audit log. The bill stays open for the patient to pay.')}</div>
        <div class="field"><label for="ru-r">${T('lab.ord.urgent_reason', 'Reason')}</label><textarea class="input" id="ru-r" name="reason" required minlength="5" maxlength="300" placeholder="${T('lab.ord.urgent_ph', 'e.g. Suspected bleed, doctor needs INR now')}"></textarea></div>
        <div class="field"><label for="ru-n">${T('lab.ord.sp_note_l', 'Specimen note (optional)')}</label><input class="input" id="ru-n" name="specimenNote" maxlength="200"></div>`,
        actions: [{ label: T('lab.cancel', 'Cancel'), value: null }, { label: T('lab.ord.urgent_ok', 'Collect now, bill later'), primary: true }],
        onSubmit: d => { if (!d.reason || d.reason.length < 5) throw new MC.ApiError(400, { error: T('lab.need_reason', 'Give a reason (at least 5 characters)') }); const b = { urgentOverride: { reason: d.reason } }; if (d.specimenNote) b.specimenNote = d.specimenNote; return api.post('/api/lab/orders/' + o.id + '/receive', b); } });
      if (!r) return; toast(T('lab.ord.collected_t', 'Sample marked collected: {acc}', { acc: r.accession }), 'ok'); await showAcc(r); MC.render();
    });
    on('ord-start', async () => { await api.post('/api/lab/orders/' + o.id + '/start'); done(T('lab.ord.started', 'Testing started')); });
    form('ord-results', async d => {
      const results = comps.map(c => { const r = { code: c.code, value: String(d['r_' + c.code] == null ? '' : d['r_' + c.code]).trim() }; if (d['c_' + c.code]) r.comment = d['c_' + c.code]; return r; });
      const missing = results.filter(r => !r.value);
      if (missing.length) throw new MC.ApiError(400, { error: T('lab.res.missing', 'Enter a value for every test: {list}', { list: missing.map(r => r.code).join(', ') }), details: missing.map(r => ({ field: 'r_' + r.code, error: T('lab.res.required', 'Required') })) });
      const u = await api.post('/api/lab/orders/' + o.id + '/results', { results });
      const nCrit = (u.results || []).filter(r => r.critical).length; const nUnv = (u.results || []).filter(r => r.flag === 'unverified').length;
      toast(nCrit ? T('lab.res.saved_crit', 'Results saved. {n} critical value(s): release promptly and call back.', { n: nCrit }) : nUnv ? T('lab.res.saved_unv', 'Results saved. {n} value(s) are not valid numbers and must be corrected.', { n: nUnv }) : T('lab.res.saved', 'Results saved'), nCrit || nUnv ? 'bad' : 'ok', 7000);
      MC.render();
    });
    on('ord-verify', async () => {
      if (!(await confirm({ title: T('lab.ord.verify_q', 'Verify these results?'), body: T('lab.ord.verify_body', 'You confirm the values for {name} are correct and checked. They can then be released.', { name: ptName(o) }), ok: T('lab.ord.verify', 'Verify results') }))) return;
      try { await api.post('/api/lab/orders/' + o.id + '/verify'); }
      catch (e) { if (e.status === 403) { toast(T('lab.ord.two_step_err', 'A second scientist must verify results you entered (two-step verification is on).'), 'bad', 7000); MC.render(); return; } throw e; }
      done(T('lab.ord.verified_t', 'Results verified'));
    });
    on('ord-release', async () => {
      const hasCrit = (o.results || []).some(r => r.critical);
      const who = o.selfRequested || !o.referringOrgName ? T('lab.ord.who_patient', 'the patient') : T('lab.ord.who_both', 'the patient and {org}', { org: o.referringOrgName });
      if (!(await confirm({ title: T('lab.ord.release_q', 'Release results for {name}?', { name: ptName(o) }), body: (hasCrit ? T('lab.ord.release_crit', 'This report has a critical value. ') : '') + T('lab.ord.release_body', 'The report is sent to {who} straight away. After release it can only be changed by an amendment.', { who }), ok: T('lab.ord.release', 'Release results') }))) return;
      await api.post('/api/lab/orders/' + o.id + '/release');
      done(hasCrit ? T('lab.ord.released_crit', 'Results released. Record the critical callback now.') : T('lab.ord.released_t', 'Results released'));
    });
    on('ord-reopen', async () => {
      const r = await dialog({ title: T('lab.ord.reopen', 'Reopen to correct'), form: true, body: html`<p>${T('lab.ord.reopen_body', 'The order goes back to In progress so results can be re-entered. Any verification is removed.')}</p><div class="field"><label for="ro-r">${T('lab.reason', 'Reason')}</label><input class="input" id="ro-r" name="reason" required minlength="5" maxlength="300"></div>`,
        actions: [{ label: T('lab.cancel', 'Cancel'), value: null }, { label: T('lab.ord.reopen_btn', 'Reopen order'), primary: true }], onSubmit: d => { if (!d.reason || d.reason.length < 5) throw new MC.ApiError(400, { error: T('lab.need_reason', 'Give a reason (at least 5 characters)') }); return api.post('/api/lab/orders/' + o.id + '/reopen', { reason: d.reason }); } });
      if (r) done(T('lab.ord.reopened', 'Order reopened'));
    });
    on('ord-cancel', async () => {
      const r = await dialog({ title: T('lab.ord.cancel_q', 'Cancel {n}?', { n: o.number }), form: true, body: html`<p>${o.paid ? T('lab.ord.cancel_paid', 'This order is paid. After cancelling, refund the patient from the bill at the cashier.') : T('lab.ord.cancel_unpaid', 'The order is cancelled. Void the open bill at the cashier.')} ${T('lab.ord.cancel_final', 'This cannot be undone.')}</p><div class="field"><label for="co-r">${T('lab.reason', 'Reason')}</label><input class="input" id="co-r" name="reason" required minlength="5" maxlength="300"></div>`,
        actions: [{ label: T('lab.ord.keep', 'Keep order'), value: null }, { label: T('lab.ord.cancel', 'Cancel order'), primary: true }], onSubmit: d => { if (!d.reason || d.reason.length < 5) throw new MC.ApiError(400, { error: T('lab.need_reason', 'Give a reason (at least 5 characters)') }); return api.post('/api/lab/orders/' + o.id + '/cancel', { reason: d.reason }); } });
      if (r) { toast(r.billNote || T('lab.ord.cancelled_t', 'Order cancelled'), 'ok', 7000); MC.render(); }
    });
    on('ord-callback', async () => {
      const r = await dialog({ title: T('lab.cb.record', 'Record critical value callback'), form: true, body: html`<p>${(o.results || []).filter(x => x.critical).map(x => x.name + ' ' + x.value + ' ' + (x.unit || '')).join('; ')}</p>
        <div class="field"><label for="cb-to">${T('lab.cb.to', 'Person informed')}</label><input class="input" id="cb-to" name="to" required maxlength="120" value="${o.orderedByName || ''}" placeholder="${T('lab.cb.to_ph', 'Name and role, e.g. Dr Ada Nwosu')}"></div>
        <div class="field"><label for="cb-m">${T('lab.cb.method', 'How')}</label><select class="input" id="cb-m" name="method"><option value="phone">${T('lab.cb.m.phone', 'by phone')}</option><option value="in_person">${T('lab.cb.m.in_person', 'in person')}</option><option value="other">${T('lab.cb.m.other', 'other')}</option></select></div>
        <div class="field"><label for="cb-n">${T('lab.cb.note', 'Note (optional)')}</label><input class="input" id="cb-n" name="note" maxlength="300" placeholder="${T('lab.cb.note_ph', 'e.g. Read back confirmed')}"></div>`,
        actions: [{ label: T('lab.cancel', 'Cancel'), value: null }, { label: T('lab.cb.save', 'Save callback'), primary: true }], onSubmit: d => { if (!d.to) throw new MC.ApiError(400, { error: T('lab.cb.need_to', 'Enter who you informed') }); return api.post('/api/lab/orders/' + o.id + '/critical-callback', d); } });
      if (r) done(T('lab.cb.saved', 'Callback recorded'));
    });
    on('ord-amend', async () => {
      const cur = o.results || [];
      const r = await dialog({ title: T('lab.am.title_q', 'Amend released report'), form: true, wide: true, body: html`<div class="notice warn">${T('lab.am.warn', 'An amendment creates a new version. The patient and requesting doctor are told the report was updated; the earlier version is kept.')}</div>
        <div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('lab.res.test', 'Test')}</th><th>${T('lab.am.current', 'Current')}</th><th>${T('lab.am.new', 'New value')}</th></tr></thead><tbody>${cur.map(x => html`<tr><td data-label="${T('lab.res.test', 'Test')}"><label for="am-${x.code}"><b>${x.name}</b></label></td><td data-label="${T('lab.am.current', 'Current')}">${x.value} ${x.unit || ''}</td><td data-label="${T('lab.am.new', 'New value')}"><input class="input" id="am-${x.code}" name="a_${x.code}" maxlength="200" value="${x.value}" autocomplete="off"></td></tr>`)}</tbody></table></div>
        <div class="field" style="margin-top:12px"><label for="am-r">${T('lab.am.reason', 'Reason for the amendment')}</label><input class="input" id="am-r" name="reason" required minlength="5" maxlength="300" placeholder="${T('lab.am.reason_ph', 'e.g. Transcription error')}"></div>`,
        actions: [{ label: T('lab.cancel', 'Cancel'), value: null }, { label: T('lab.am.save', 'Save amendment'), primary: true }],
        onSubmit: d => {
          const changed = cur.filter(x => d['a_' + x.code] !== undefined && String(d['a_' + x.code]).trim() !== String(x.value)).map(x => ({ code: x.code, value: String(d['a_' + x.code]).trim() }));
          if (!changed.length) throw new MC.ApiError(400, { error: T('lab.am.none', 'Change at least one value') });
          if (!d.reason || d.reason.length < 5) throw new MC.ApiError(400, { error: T('lab.need_reason', 'Give a reason (at least 5 characters)') });
          return api.post('/api/lab/orders/' + o.id + '/amend', { reason: d.reason, results: changed });
        } });
      if (r) done(T('lab.am.saved', 'Report amended (version {v})', { v: r.version }));
    });
    on('ord-label', () => { MC.go('#/report/' + o.id + '?label=1'); });
  }

  /* ---------------- printable report (and tube label) ---------------- */
  async function reportPage({ params, query, stale }) {
    const o = await api.get('/api/lab/orders/' + params.id);
    const [pt, lab] = await Promise.all([o.patient ? api.get('/api/fd/patients/' + o.patient.id).catch(() => null) : null, api.get('/api/directory/' + MC.me.org.id).catch(() => null)]);
    if (stale()) return;
    const p = pt || o.patient || {};
    if (query.label) {
      view(html`<a class="back" href="#/order/${o.id}">${icon('left')}${o.number}</a><div class="page-head"><div><h1>${T('lab.lbl.title', 'Tube label')}</h1></div><div class="actions"><button class="btn primary" data-action="print">${icon('download')}${T('lab.rep.print', 'Print')}</button></div></div>
        <div class="l-report" style="max-width:360px"><b>${p.name || ptName(o)}</b><br><span class="sm">${ptMeta(o.patient)}</span><p class="l-acc" style="margin:8px 0 4px">${o.accession || ''}</p>${barcode(o.accession)}<p class="xs" style="margin:4px 0 0">${o.tests.map(x => x.code).join(', ')} | ${o.specimen ? MC.dateTime(o.specimen.collectedAt) : ''}</p></div>`);
      return;
    }
    const released = o.status === 'released';
    view(html`<a class="back" href="#/order/${o.id}">${icon('left')}${o.number}</a>
      <div class="page-head"><div><h1>${T('lab.rep.title', 'Lab report')}</h1><p>${o.number}</p></div><div class="actions"><button class="btn primary" data-action="print">${icon('download')}${T('lab.rep.print', 'Print')}</button></div></div>
      <article class="l-report">
        ${released ? '' : html`<div class="l-draft">${T('lab.rep.draft', 'Draft: not released. Not for clinical use.')}</div>`}
        <header><div><h2 style="margin:0">${(lab && lab.name) || MC.me.org.name}</h2><span class="sm">${lab ? [lab.area, lab.city].filter(Boolean).join(', ') : ''}${lab && lab.phone ? ' | ' + lab.phone : ''}</span></div>
          <div style="text-align:right"><b>${T('lab.rep.heading', 'Laboratory report')}</b><br><span class="sm">${o.number}${o.version > 1 ? ' | ' + T('lab.rep.version', 'Version {v} (amended)', { v: o.version }) : ''}</span></div></header>
        <div class="grid2"><dl class="kv"><dt>${T('lab.rep.patient', 'Patient')}</dt><dd><b>${p.name || ptName(o)}</b></dd><dt>MRN</dt><dd>${(o.patient && o.patient.mrn) || p.mrn || ''}</dd><dt>${T('lab.rep.age_sex', 'Age / sex')}</dt><dd>${[p.age != null ? T('lab.yrs', '{n} yrs', { n: p.age }) : '', p.sex ? MC.cap(p.sex) : ''].filter(Boolean).join(', ')}</dd></dl>
          <dl class="kv"><dt>${T('lab.rep.referrer', 'Requested by')}</dt><dd>${[o.orderedByName && o.source !== 'walk_in' ? o.orderedByName : o.referrerName, o.referringOrgName].filter(Boolean).join(', ') || (o.selfRequested ? T('lab.ord.self', 'Patient\'s own request') : '')}</dd><dt>${T('lab.rep.accession', 'Accession')}</dt><dd class="l-acc">${o.accession || ''}</dd><dt>${T('lab.rep.collected', 'Collected')}</dt><dd>${o.specimen ? MC.dateTime(o.specimen.collectedAt) : ''}</dd><dt>${T('lab.rep.released', 'Released')}</dt><dd>${o.releasedAt ? MC.dateTime(o.releasedAt) : ''}</dd></dl></div>
        ${o.tests.map(tst => { const codes = ((o.components || []).find(c => c.code === tst.code) || { components: [{ code: tst.code }] }).components.map(c => c.code); const rs = (o.results || []).filter(r => codes.includes(r.code)); return html`<h2>${tst.name}</h2>${rs.length ? resultsTable(rs) : html`<p class="muted">${T('lab.rep.pending', 'Result pending')}</p>`}`; })}
        <p class="sm" style="margin-top:16px">${o.verifiedBy ? T('lab.rep.verified_by', 'Verified by {name} on {at}.', { name: o.verifiedBy.name, at: MC.dateTime(o.verifiedBy.at) }) : ''}</p>
        ${(o.amendments || []).length ? html`<p class="sm">${o.amendments.map(a => T('lab.rep.amended', 'Amended to version {v} on {at}: {reason}.', { v: a.version, at: MC.dateTime(a.at), reason: a.reason })).join(' ')}</p>` : ''}
        ${o.critical && (o.critical.callbacks || []).length ? html`<p class="sm">${o.critical.callbacks.map(c => T('lab.rep.cb', 'Critical value communicated to {to} on {at}.', { to: c.to, at: MC.dateTime(c.at) })).join(' ')}</p>` : ''}
        <p class="xs muted">${T('lab.rep.flags', 'Flags are computed from this laboratory\'s reference ranges.')}</p>
      </article>`);
  }
  on('print', () => window.print());

  /* ---------------- walk-in order ---------------- */
  async function walkin({ stale, query }) {
    const cat = (await getCatalog()).filter(c => c.active && Number.isInteger(c.priceKobo));
    if (stale()) return;
    let patient = null;
    if (query.patient) { try { patient = await api.get('/api/fd/patients/' + query.patient); } catch (e) { patient = null; } }
    const canReg = perm('patient.register');
    view(html`<a class="back" href="#/worklist">${icon('left')}${T('lab.nav.worklist', 'Worklist')}</a>
      <div class="page-head"><div><h1>${T('lab.wi.title', 'Walk-in order')}</h1><p>${T('lab.wi.sub', 'Find or register the patient, choose tests and raise the bill.')}</p></div></div>
      <div class="grid two"><section class="panel"><h2>${T('lab.wi.patient', '1. Patient')}</h2><div id="wi-pt"></div></section>
      <form class="panel" data-form="wi-order" novalidate><h2>${T('lab.wi.tests', '2. Tests')}</h2>
        ${cat.length ? html`<div class="field"><label for="wi-f">${T('lab.wi.filter', 'Filter tests')}</label><input class="input" id="wi-f" data-change="wi-filter" autocomplete="off" placeholder="${T('lab.wi.filter_ph', 'Name or code')}"></div>
        <div class="l-tests" role="group" aria-label="${T('lab.wi.tests_l', 'Tests')}">${cat.map(c => html`<label class="l-test" data-name="${(c.code + ' ' + c.name).toLowerCase()}"><input type="checkbox" name="tests" data-list value="${c.code}" data-change="wi-total" data-price="${c.priceKobo}"><span class="grow"><b>${c.name}</b> <span class="xs muted">${c.code}</span><br><span class="xs muted">${c.specimen || ''} | ${T('lab.tat.hours', '{h} hours', { h: c.tatHours })}</span></span><b>${MC.money(c.priceKobo)}</b></label>`)}</div>` : empty({ icon: 'flask', title: T('lab.wi.no_cat', 'No tests offered yet'), body: T('lab.wi.no_cat_sub', 'A lab manager sets prices in the catalogue first.') })}
        <div class="fields two" style="margin-top:16px"><div class="field"><label for="wi-p">${T('lab.wi.priority', 'Priority')}</label><select class="input" id="wi-p" name="priority"><option value="routine">${T('lab.wi.routine', 'Routine')}</option><option value="urgent">${T('lab.urgent', 'Urgent')}</option></select></div>
        <div class="field"><label for="wi-r">${T('lab.wi.referrer', 'Referring doctor (optional)')}</label><input class="input" id="wi-r" name="referrerName" maxlength="120" placeholder="${T('lab.wi.referrer_ph', 'Name and hospital, if any')}"></div></div>
        <div class="field"><label for="wi-n">${T('lab.wi.note', 'Clinical note (optional)')}</label><textarea class="input" id="wi-n" name="clinicalNote" maxlength="1000"></textarea></div>
        <div class="l-total row between"><b id="wi-total" role="status">${T('lab.wi.total', 'Total: {amt}', { amt: MC.money(0) })}</b><button class="btn primary" type="submit">${T('lab.wi.create', 'Create order and bill')}</button></div>
        <div class="form-err notice bad" hidden></div></form></div>`);
    const paintPt = () => {
      const box = document.getElementById('wi-pt'); if (!box) return;
      view(patient ? html`${MC.wristband(patient)}<button class="btn sm" data-action="wi-pt-clear">${T('lab.wi.change_pt', 'Choose another patient')}</button>` : html`
        <form data-form="wi-search" class="row wrap" novalidate role="search"><div style="flex:1;min-width:200px"><label for="wi-q" class="sr-only">${T('lab.wi.search_l', 'Name, phone or MRN')}</label><div class="search">${icon('search')}<input class="input" id="wi-q" name="q" placeholder="${T('lab.wi.search_l', 'Name, phone or MRN')}" autocomplete="off"></div></div><button class="btn" type="submit">${T('lab.wi.search', 'Find patient')}</button></form>
        <div id="wi-res" style="margin-top:12px"></div>
        ${canReg ? html`<details style="margin-top:12px"><summary><b>${T('lab.wi.register', 'Register a new patient')}</b></summary>
          <form data-form="wi-reg" novalidate style="margin-top:12px"><div class="fields two"><div class="field"><label for="rg-f">${T('lab.wi.first', 'First name')}</label><input class="input" id="rg-f" name="firstName" required maxlength="60"></div><div class="field"><label for="rg-l">${T('lab.wi.last', 'Last name')}</label><input class="input" id="rg-l" name="lastName" required maxlength="60"></div></div>
          <div class="fields two"><div class="field"><label for="rg-p">${T('lab.wi.phone', 'Phone')}</label><input class="input" id="rg-p" name="phone" inputmode="tel" placeholder="0803 123 4567"></div><div class="field"><label for="rg-d">${T('lab.wi.dob', 'Date of birth')}</label><input class="input" id="rg-d" name="dob" type="date"></div></div>
          <div class="field"><label for="rg-s">${T('lab.wi.sex', 'Sex')}</label><select class="input" id="rg-s" name="sex"><option value="unknown">${T('lab.wi.sex_u', 'Not recorded')}</option><option value="female">${T('lab.wi.sex_f', 'Female')}</option><option value="male">${T('lab.wi.sex_m', 'Male')}</option></select></div>
          <div class="field"><label for="rg-a">${T('lab.wi.allergies', 'Allergies (comma separated)')}</label><input class="input" id="rg-a" name="allergies" maxlength="300"></div>
          <label class="check"><input type="checkbox" name="noKnownAllergies"><span>${T('lab.wi.nka', 'No known allergies')}</span></label>
          <div class="fields two"><div class="field"><label for="wi-nin">${T('lab.wi.nin', 'NIN (11 digits)')}</label><input class="input" id="wi-nin" name="nin" inputmode="numeric" maxlength="11" autocomplete="off"></div>
          <div class="field"><label for="wi-nonin">${T('lab.wi.no_nin', 'No NIN? Say why')}</label><select class="input" id="wi-nonin" name="noNinReason"><option value="">${T('lab.wi.has_nin', 'The patient has a NIN')}</option><option value="child">${T('lab.wi.nonin_child', 'A child without a NIN yet')}</option><option value="not_enrolled">${T('lab.wi.nonin_ne', 'Not yet enrolled with NIMC')}</option><option value="foreign_national">${T('lab.wi.nonin_f', 'Foreign national')}</option></select></div></div>
          <label class="check"><input type="checkbox" name="consent" required><span>${MC.content('labPrivacyConsent', T('lab.wi.consent', 'The patient has read the privacy notice and agrees to registration.'))}</span></label>
          <div class="form-err notice bad" hidden></div><button class="btn" type="submit">${T('lab.wi.register_btn', 'Register patient')}</button></form></details>` : html`<p class="notice" style="margin-top:12px">${T('lab.wi.no_reg', 'New to this lab? Your role cannot register patients. Ask the front desk to register them, then search again.')}</p>`}`, box);
    };
    paintPt();
    let res = [];
    form('wi-search', async d => {
      if (!d.q || d.q.trim().length < 2) throw new MC.ApiError(400, { error: T('lab.wi.need_q', 'Type at least 2 letters of the name, a phone number or an MRN') });
      res = await api.get('/api/fd/patients' + qs({ q: d.q.trim(), limit: 10 }));
      let extra = '';
      if (!res.length && canReg && /^[+\d\s-]{10,}$/.test(d.q.trim())) {
        const lk = await api.post('/api/fd/patients/lookup', { phone: d.q.trim() });
        if (lk.status === 'exists_elsewhere') extra = html`<div class="notice">${lk.message}${lk.devCode ? html`<br>${T('lab.wi.demo_code', 'Demo code')}: <b>${lk.devCode}</b>` : ''}</div><form data-form="wi-link" class="row" novalidate><input type="hidden" name="phone" value="${d.q.trim()}"><div style="flex:1"><label for="lk-c" class="sr-only">${T('lab.wi.code', 'Code from the patient')}</label><input class="input" id="lk-c" name="code" inputmode="numeric" maxlength="6" placeholder="${T('lab.wi.code', 'Code from the patient')}"></div><button class="btn" type="submit">${T('lab.wi.link', 'Link record')}</button></form>`;
        if (lk.status === 'linked') res = [lk.patient];
      }
      view(html`${res.length ? html`<ul class="list">${res.map((p, i) => html`<li><div class="grow"><span class="title">${p.name}</span><span class="sub">${ptMeta(p)}${p.phone ? ' | ' + p.phone : ''}</span></div><button type="button" class="btn sm" data-action="wi-pick" data-i="${i}">${T('lab.wi.choose', 'Choose')}</button></li>`)}</ul>` : html`<p class="muted sm">${T('lab.wi.none', 'No patient found at this lab.')}</p>`}${extra}`, document.getElementById('wi-res'));
    });
    form('wi-link', async d => { const r = await api.post('/api/fd/patients/link', d); patient = r.patient; toast(T('lab.wi.linked', 'Record linked'), 'ok'); paintPt(); });
    form('wi-reg', async d => {
      if (!d.consent) throw new MC.ApiError(400, { error: T('lab.wi.need_consent', 'The patient must agree to the privacy notice first') });
      const body = { firstName: d.firstName, lastName: d.lastName, consent: true, sex: d.sex || 'unknown' };
      if (d.phone) body.phone = d.phone; if (d.dob) body.dob = d.dob;
      const nin = String(d.nin || '').replace(/\s+/g, ''); if (nin) body.nin = nin; else if (d.noNinReason) body.noNinReason = d.noNinReason;
      else throw new MC.ApiError(400, { error: T('lab.wi.need_nin', 'Type the patient\'s NIN, or choose why they have none') });
      if (d.allergies) body.allergies = d.allergies.split(',').map(x => x.trim()).filter(Boolean).slice(0, 20).map(x => ({ substance: x })); else if (d.noKnownAllergies) body.noKnownAllergies = true;
      const r = await api.post('/api/fd/patients', body); patient = r.patient; toast(T('lab.wi.registered', '{name} registered', { name: patient.name }), 'ok'); paintPt();
    });
    on('wi-pick', el => { patient = res[Number(el.dataset.i)]; paintPt(); });
    on('wi-pt-clear', () => { patient = null; paintPt(); });
    changes['wi-filter'] = el => { const q = el.value.trim().toLowerCase(); document.querySelectorAll('.l-test').forEach(r => { r.hidden = !!q && !r.dataset.name.includes(q); }); };
    changes['wi-total'] = () => { let k = 0; document.querySelectorAll('.l-test input:checked').forEach(i => { k += Number(i.dataset.price) || 0; }); const t = document.getElementById('wi-total'); if (t) t.textContent = T('lab.wi.total', 'Total: {amt}', { amt: MC.money(k) }); };
    form('wi-order', async d => {
      if (!patient) throw new MC.ApiError(400, { error: T('lab.wi.need_pt', 'Find or register the patient first') });
      const tests = d.tests || []; if (!tests.length) throw new MC.ApiError(400, { error: T('lab.wi.need_tests', 'Choose at least one test') });
      const total = tests.reduce((s, c) => s + ((cat.find(x => x.code === c) || {}).priceKobo || 0), 0);
      if (!(await confirm({ title: T('lab.wi.confirm_q', 'Raise a bill of {amt}?', { amt: MC.money(total) }), body: T('lab.wi.confirm_body', '{n} test(s) for {name}. The patient pays at the cashier or in the MediCore app; the sample is collected once paid.', { n: tests.length, name: patient.name }), ok: T('lab.wi.create', 'Create order and bill') }))) return;
      const body = { patientId: patient.id, tests, priority: d.priority || 'routine' };
      if (d.referrerName) body.referrerName = d.referrerName; if (d.clinicalNote) body.clinicalNote = d.clinicalNote;
      const o = await api.post('/api/lab/orders', body);
      toast(T('lab.wi.created', 'Order {n} created and billed', { n: o.number }), 'ok');
      MC.go('#/order/' + o.id);
    });
  }

  /* ---------------- catalogue ---------------- */
  async function catalog({ query }) {
    catCache = null;
    const all = await getCatalog();
    const show = query.show === 'all' ? 'all' : 'offered';
    const q = (query.q || '').toLowerCase();
    const rows = all.filter(c => (show === 'all' || c.active) && (!q || (c.code + ' ' + c.name).toLowerCase().includes(q)));
    const canEdit = perm('lab.catalog');
    const own = c => c.inCatalogue && c.range && c.reference && ['low', 'high', 'critLow', 'critHigh', 'unit', 'normalText'].some(k => c.range[k] !== c.reference[k]);
    view(html`<div class="page-head"><div><h1>${T('lab.cat.title', 'Test catalogue')}</h1><p>${T('lab.cat.sub', '{n} tests offered. Prices are what patients are billed; ranges decide the flags.', { n: all.filter(c => c.active).length })}</p></div></div>
      <div class="row wrap between" style="margin-bottom:16px"><div class="tabs" role="tablist" style="margin:0;border:0"><a href="#/catalog${qs({ q: query.q })}" role="tab" aria-selected="${show === 'offered' ? 'true' : 'false'}">${T('lab.cat.offered', 'Offered')}</a><a href="#/catalog${qs({ show: 'all', q: query.q })}" role="tab" aria-selected="${show === 'all' ? 'true' : 'false'}">${T('lab.cat.all', 'All tests')}</a></div>
        <form data-form="cat-filter" class="row" novalidate role="search"><label for="cat-q" class="sr-only">${T('lab.cat.search', 'Search tests')}</label><input class="input" id="cat-q" name="q" value="${query.q || ''}" placeholder="${T('lab.cat.search', 'Search tests')}" style="max-width:240px"><button class="btn" type="submit">${T('lab.cat.filter', 'Filter')}</button></form></div>
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('lab.cat.test', 'Test')}</th><th class="num">${T('lab.cat.price', 'Price')}</th><th>${T('lab.cat.tat', 'Turnaround')}</th><th>${T('lab.cat.range', 'Range used')}</th><th>${T('lab.cat.status', 'Status')}</th><th></th></tr></thead><tbody>
        ${rows.map(c => html`<tr><td data-label="${T('lab.cat.test', 'Test')}"><b>${c.name}</b> <span class="xs muted">${c.code}</span><br><span class="xs muted">${c.specimen || ''}${c.panel ? ' | ' + T('lab.cat.panel', 'Panel: {list}', { list: c.panel.map(x => x.code).join(', ') }) : ''}</span></td>
          <td class="num" data-label="${T('lab.cat.price', 'Price')}">${c.priceKobo != null ? MC.money(c.priceKobo) : html`<span class="muted">${T('lab.cat.no_price', 'Not set')}</span>`}</td>
          <td data-label="${T('lab.cat.tat', 'Turnaround')}">${T('lab.tat.hours', '{h} hours', { h: c.tatHours })}</td>
          <td data-label="${T('lab.cat.range', 'Range used')}">${c.panel ? html`<span class="muted sm">${T('lab.cat.per_comp', 'Per component')}</span>` : html`${rangeText(c.range, c.range && c.range.unit)}${own(c) ? html` ${badge(T('lab.cat.own', 'Own range'), 'hue')}` : ''}`}</td>
          <td data-label="${T('lab.cat.status', 'Status')}">${c.active ? badge(T('lab.cat.on', 'Offered'), 'ok') : badge(T('lab.cat.off', 'Not offered'), 'outline')}</td>
          <td class="num">${canEdit ? html`<button class="btn sm" data-action="cat-edit" data-code="${c.code}">${T('lab.cat.edit', 'Edit')}</button>` : ''}</td></tr>`)}</tbody></table></div>` : empty({ icon: 'flask', title: T('lab.cat.empty', 'No tests match'), body: show === 'offered' ? T('lab.cat.empty_sub', 'Switch to All tests to start offering one.') : '' })}`);
    form('cat-filter', d => MC.go('#/catalog' + qs({ show: show === 'all' ? 'all' : undefined, q: d.q })));
    on('cat-edit', async el => {
      const c = all.find(x => x.code === el.dataset.code); if (!c) return;
      const rg = c.range || {}; const ref = c.reference || {};
      const ownRange = own(c);
      const val = k => (ownRange && rg[k] != null ? rg[k] : '');
      const r = await dialog({ title: T('lab.cat.edit_t', 'Edit {name}', { name: c.name }), form: true, wide: true, body: html`
        <div class="fields two"><div class="field"><label for="ce-p">${T('lab.cat.price_ngn', 'Price (NGN)')}</label><input class="input" id="ce-p" name="priceKobo" data-kobo type="number" min="0" step="50" value="${c.priceKobo != null ? c.priceKobo / 100 : ''}"></div>
        <div class="field"><label for="ce-t">${T('lab.cat.tat_h', 'Turnaround (hours)')}</label><input class="input" id="ce-t" name="tatHours" type="number" min="1" max="1440" step="1" value="${c.tatHours || ''}"></div></div>
        <label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}><span>${T('lab.cat.active', 'Offer this test (patients and doctors can order it here)')}</span></label>
        ${c.panel ? html`<p class="muted sm">${T('lab.cat.panel_note', 'Ranges for a panel are set on each component test.')}</p>` : html`<h3 style="margin-top:16px">${T('lab.cat.own_h', 'Own reference range (optional)')}</h3><p class="muted sm">${T('lab.cat.ref_is', 'Leave blank to use the reference: {r}.', { r: rangeText(ref, ref.unit) || T('lab.cat.ref_none', 'none') })} ${critText(ref)}</p>
          <div class="fields three"><div class="field"><label for="ce-u">${T('lab.cat.unit', 'Unit')}</label><input class="input" id="ce-u" name="unit" maxlength="20" value="${val('unit')}" placeholder="${ref.unit || ''}"></div>
          <div class="field"><label for="ce-lo">${T('lab.cat.low', 'Low limit')}</label><input class="input" id="ce-lo" name="low" type="number" step="any" value="${val('low')}" placeholder="${ref.low != null ? ref.low : ''}"></div>
          <div class="field"><label for="ce-hi">${T('lab.cat.high', 'High limit')}</label><input class="input" id="ce-hi" name="high" type="number" step="any" value="${val('high')}" placeholder="${ref.high != null ? ref.high : ''}"></div>
          <div class="field"><label for="ce-cl">${T('lab.cat.crit_low', 'Critical below')}</label><input class="input" id="ce-cl" name="critLow" type="number" step="any" value="${val('critLow')}" placeholder="${ref.critLow != null ? ref.critLow : ''}"></div>
          <div class="field"><label for="ce-ch">${T('lab.cat.crit_high', 'Critical above')}</label><input class="input" id="ce-ch" name="critHigh" type="number" step="any" value="${val('critHigh')}" placeholder="${ref.critHigh != null ? ref.critHigh : ''}"></div>
          <div class="field"><label for="ce-nt">${T('lab.cat.normal_text', 'Normal result text')}</label><input class="input" id="ce-nt" name="normalText" maxlength="80" value="${val('normalText')}" placeholder="${ref.normalText || ''}"></div></div>
          ${ownRange ? html`<label class="check"><input type="checkbox" name="resetRange"><span>${T('lab.cat.reset', 'Go back to the reference range')}</span></label>` : ''}`}`,
        actions: [{ label: T('lab.cancel', 'Cancel'), value: null }, { label: T('lab.cat.save', 'Save test'), primary: true }],
        onSubmit: d => {
          const body = { active: !!d.active };
          if (d.priceKobo !== undefined) body.priceKobo = d.priceKobo;
          if (d.tatHours !== undefined) body.tatHours = d.tatHours;
          if (body.active && body.priceKobo === undefined) throw new MC.ApiError(400, { error: T('lab.cat.need_price', 'Set a price before offering this test'), details: [{ field: 'priceKobo', error: T('lab.cat.need_price', 'Set a price before offering this test') }] });
          if (!c.panel) {
            const range = {}; ['unit', 'normalText'].forEach(k => { if (d[k]) range[k] = d[k]; }); ['low', 'high', 'critLow', 'critHigh'].forEach(k => { if (d[k] !== undefined && !Number.isNaN(d[k])) range[k] = d[k]; });
            if (d.resetRange) body.range = {}; else if (Object.keys(range).length) body.range = range;
          }
          return api.put('/api/lab/catalog/' + c.code, body);
        } });
      if (r) { catCache = null; toast(T('lab.cat.saved', '{name} saved', { name: c.name }), 'ok'); MC.render(); }
    });
  }

  MC.boot({
    title: 'MediCore Lab', subtitle: T('lab.login.sub', 'Samples, results and reports'), home: '#/worklist',
    nav: [
      { href: '#/worklist', label: T('lab.nav.worklist', 'Worklist'), icon: 'flask', anyPerm: ['lab.receive', 'lab.result', 'lab.verify'] },
      { href: '#/lookup', label: T('lab.nav.lookup', 'Find sample'), short: T('lab.nav.lookup_short', 'Scan'), icon: 'search', anyPerm: ['lab.receive', 'lab.result', 'lab.verify'] },
      { href: '#/walkin', label: T('lab.nav.walkin', 'Walk-in order'), short: T('lab.nav.walkin_short', 'Walk-in'), icon: 'plus', perm: 'lab.receive' },
      { href: '#/catalog', label: T('lab.nav.catalog', 'Test catalogue'), short: T('lab.nav.catalog_short', 'Catalogue'), icon: 'clipboard', anyPerm: ['lab.catalog', 'lab.verify'] },
      MC.referrals.navItem(),
      MC.whatsapp.navItem(),
      MC.caretools.nav.shares({ sideOnly: true }),
      MC.caretools.nav.store({ sideOnly: true }),
    ],
    routes: { '#/worklist': worklist, '#/lookup': lookup, '#/order/:id': orderPage, '#/report/:id': reportPage, '#/walkin': walkin, '#/catalog': catalog, ...MC.referrals.routes('#/referrals'), ...MC.whatsapp.routes('#/whatsapp'), ...MC.caretools.routes({ patientHref: () => '#/shared-care' }) },
    onReady: async () => { MC.referrals.refreshCount(); MC.whatsapp.refreshCount(); MC.caretools.refreshCount(); },
  });
})();
