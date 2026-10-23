/* MediCore Pharmacy: prescription queue, dispensing, counter sales, stock with batches and expiry,
 * suppliers and purchase orders, controlled-drug register, reports, and delivery dispatch.
 * Works for a standalone pharmacy and a hospital pharmacy. Roles: pharmacist (verify, dispense, stock),
 * pharmacy technician (dispense, stock), delivery dispatcher (deliveries only). */
(function () {
  'use strict';
  const { html, api, qs, money, date, dateTime, ago, cap, icon, badge, empty, figures, view, on, form, dialog, confirm, toast, wristband } = MC;
  const T = (k, en, v) => MC.t('pharmacy.' + k, en, v);
  const S = s => MC.t('status.' + s, cap(s));
  const kindOf = s => (/(done|completed|paid|delivered|released|active|approved|closed|collected|verified|ok|credited)/.test(s) ? 'ok' : /(cancel|denied|rejected|failed|void|suspended|expired|critical|quarantined|locked)/.test(s) ? 'bad' : /(pending|waiting|open|queried|new|awaiting|received|draft|no_profile)/.test(s) ? 'warn' : 'info');
  const sBadge = s => badge(S(s), kindOf(s));
  const has = p => !!(MC.me && (MC.me.perms || []).includes(p));
  const hasAny = ps => ps.some(has);
  const modOn = m => !!(MC.me && MC.me.org && (MC.me.org.modules || []).includes(m));
  const R = ['pharmacy.verify', 'pharmacy.dispense', 'pharmacy.stock'];
  const today = () => MC.todayISO();
  const back = (href, label) => html`<a class="back" href="${href}">${icon('left')}${label}</a>`;
  const opt = (v, label, sel) => html`<option value="${v}" ${sel ? 'selected' : ''}>${label}</option>`;

  /* app-specific layout helpers (kit tokens only) */
  (function css() {
    const s = document.createElement('style');
    s.textContent = `
      .ph-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:16px}
      .ph-toolbar .field{margin:0;flex:1;min-width:180px}
      .ph-acts{display:flex;gap:6px;flex-wrap:wrap}
      .ph-rx{border-top:1px solid var(--line-2);padding:12px 0}
      .ph-rx:first-of-type{border-top:0}
      .ph-rx .title,.ph-rx .sub{display:block}.ph-rx .sub{color:var(--ink-3);font-size:var(--t-sm)}
      .allergy-unknown svg{width:14px;height:14px}
      .ph-cart-total{display:flex;justify-content:space-between;font-size:var(--t-lg);font-weight:700;padding:12px 0}
      .ph-qty{width:84px;min-height:44px}
      .ph-pos{font-size:var(--t-sm);color:var(--ink-2)}
      .ph-code{font-size:1.5rem;letter-spacing:.3em;font-weight:700;max-width:220px}
      .ph-map-list{margin-top:8px}
      @media (max-width:719px){.ph-hide-sm{display:none}}
    `;
    document.head.appendChild(s);
  })();

  /** run an action; a 409 (already done / wrong state) shows the message and refreshes the screen */
  async function guard(fn) {
    try { return await fn(); }
    catch (e) { if (e && e.status === 409) { toast(e.message, 'bad'); MC.render(); return null; } throw e; }
  }
  const sure = (title, body, ok, danger) => confirm({ title, body, ok, danger });
  const canRefer = () => MC.feature('referralNetwork') && MC.referrals.canSend();
  const referBtn = pid => (pid && canRefer() ? html`<button class="btn" data-action="ph-refer" data-p="${pid}">${icon('swap')}${T('refer.btn', 'Refer to a doctor or hospital')}</button>` : '');
  let referPatient = null;
  on('ph-refer', async el => {
    const pid = el.dataset.p;
    const patient = referPatient && referPatient.id === pid ? referPatient : await api.get('/api/fd/patients/' + encodeURIComponent(pid)).catch(() => ({ id: pid }));
    await MC.referrals.sendDialog({ patient: Object.assign({}, patient, { id: pid }) });
  });

  /* ---------------- nav counts ---------------- */
  async function refreshCounts() {
    try {
      if (hasAny(R)) {
        const d = await api.get('/api/pharmacy/dashboard');
        const o = d.orders || {};
        MC.navCount('#/queue', (o.received || 0) + (o.queried || 0) + (o.verified || 0) + (o.paid || 0) + (o.allocating || 0));
        MC.navCount('#/stock', (d.lowStock || 0) + (d.expiredBatches || 0));
        MC.navCount('#/counter', (d.salesAwaitingApproval || 0) + (d.salesStockShort || 0));
      }
      if (has('delivery.dispatch') && modOn('delivery')) {
        const b = await api.get('/api/delivery/board');
        MC.navCount('#/deliveries', ((b.counts || {}).pending || 0) + ((b.counts || {}).failed || 0) + (b.lockedCount || 0));
      }
    } catch (e) { /* counts are best-effort */ }
  }

  /* ---------------- bills (shared by orders and counter sales) ---------------- */
  function billPanel(bill, { patientCanPay }) {
    if (!bill) return '';
    const due = Math.max(0, (bill.patientDueKobo || 0) - (bill.paidKobo || 0));
    return html`<section class="panel"><h2>${T('bill.title', 'Bill')}</h2>
      <dl class="kv"><dt>${T('bill.number', 'Bill number')}</dt><dd><b>${bill.number}</b></dd>
        <dt>${T('bill.status', 'Status')}</dt><dd>${sBadge(bill.status)}</dd>
        <dt>${T('bill.total', 'Total')}</dt><dd>${money(bill.totalKobo)}</dd>
        ${bill.hmo && bill.hmo.coveredKobo ? html`<dt>${T('bill.hmo', 'HMO covers')}</dt><dd>${money(bill.hmo.coveredKobo)}</dd>` : ''}
        <dt>${T('bill.due', 'Patient pays')}</dt><dd>${money(bill.patientDueKobo)}</dd>
        <dt>${T('bill.paid', 'Paid so far')}</dt><dd>${money(bill.paidKobo)}</dd></dl>
      ${bill.status === 'open' ? html`
        ${patientCanPay ? html`<div class="notice" style="margin-top:12px">${T('bill.online', 'The patient can pay online in the MediCore app now. This screen updates when the payment arrives.')}</div>` : ''}
        ${has('billing.cash') ? html`<div class="btn-row"><button class="btn primary" data-action="bill-cash" data-id="${bill.id}" data-due="${due}" data-number="${bill.number}">${icon('card')}${T('bill.take_cash', 'Take payment at the counter')}</button><button class="btn" data-action="mc-reload">${icon('refresh')}${T('bill.check', 'Check payment')}</button></div>`
        : html`<div class="notice warn" style="margin-top:12px">${T('bill.no_cash_perm', 'To pay at the counter, the cashier records the cash, POS or transfer payment against bill {number} in MediCore Front Desk.', { number: bill.number })}</div><div class="btn-row"><button class="btn" data-action="mc-reload">${icon('refresh')}${T('bill.check', 'Check payment')}</button></div>`}` : ''}
    </section>`;
  }
  on('bill-cash', async el => {
    const due = Number(el.dataset.due); const number = el.dataset.number;
    const r = await dialog({ title: T('bill.cash_title', 'Take payment for bill {number}', { number }), form: true,
      body: html`<p>${T('bill.cash_amount', 'Amount to collect: {amount}', { amount: money(due) })}</p>
        <div class="field"><label for="bc-m">${T('bill.method', 'Payment method')}</label><select class="input" id="bc-m" name="method">${opt('cash', T('bill.m_cash', 'Cash'), true)}${opt('pos', T('bill.m_pos', 'POS card'))}${opt('transfer', T('bill.m_transfer', 'Bank transfer'))}</select></div>
        <div class="field"><label for="bc-r">${T('bill.receipt', 'Receipt or POS reference')}</label><input class="input" id="bc-r" name="receiptNo" required maxlength="40" autocomplete="off"><div class="hint">${T('bill.receipt_hint', 'Write the number from your receipt book or the POS slip. Each number can be used once.')}</div></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('bill.record', 'Record payment'), primary: true }],
      onSubmit: async d => {
        if (!d.receiptNo) throw new MC.ApiError(400, { error: T('bill.need_receipt', 'Enter the receipt or POS reference'), details: [{ field: 'receiptNo', error: T('bill.need_receipt', 'Enter the receipt or POS reference') }] });
        if (!(await sure(T('bill.cash_q', 'Record {amount} paid by {method}?', { amount: money(due), method: d.method === 'pos' ? T('bill.m_pos', 'POS card') : d.method === 'transfer' ? T('bill.m_transfer', 'Bank transfer') : T('bill.m_cash', 'Cash') }), T('bill.cash_body', 'This marks bill {number} as paid. It cannot be undone here; a wrong payment needs a refund.', { number }), T('bill.record', 'Record payment')))) return false;
        try { return await api.post('/api/bills/' + el.dataset.id + '/cash', { method: d.method, amountKobo: due, receiptNo: d.receiptNo }); }
        catch (e) { if (e.status === 409 && /already/.test(e.message) && !/receipt/i.test(e.message)) { toast(e.message, 'bad'); return null; } throw e; }
      } });
    if (r) toast(T('bill.recorded', 'Payment recorded'), 'ok');
    MC.render();
  });

  /* ================= prescription queue ================= */
  const QTABS = ['received', 'verified', 'priced', 'paid', 'ready', 'out_for_delivery', 'done'];
  const tabOf = s => (s === 'queried' ? 'received' : s === 'allocating' ? 'paid' : QTABS.includes(s) ? s : 'done');
  const tabLabel = s => (s === 'done' ? T('queue.done', 'Finished') : S(s));
  async function queuePage({ query }) {
    const tab = QTABS.includes(query.s) ? query.s : 'received';
    view(html`<div class="page-head"><div><h1>${T('queue.title', 'Prescriptions')}</h1><p>${T('queue.sub', 'Orders sent by patients and prescribers. Updates every 15 seconds.')}</p></div>
      <div class="actions">${has('pharmacy.dispense') ? html`<a class="btn" href="#/counter">${icon('card')}${T('queue.counter', 'Counter sale')}</a>` : ''}</div></div>
      <div id="q-ref-note"></div><div id="q-body">${MC.skeleton(4)}</div>`);
    MC.referrals.homeNotice(document.getElementById('q-ref-note'));
    let lastSig = '';
    const load = async () => {
      const rows = await api.get('/api/pharmacy/orders?limit=300');
      const sig = JSON.stringify(rows.map(r => [r.id, r.status, r.updatedAt]));
      if (sig === lastSig) return; lastSig = sig;
      const by = {}; QTABS.forEach(k => { by[k] = []; }); rows.forEach(r => by[tabOf(r.status)].push(r));
      by.done = by.done.slice(0, 50);
      const list = by[tab];
      const box = document.getElementById('q-body'); if (!box) return;
      view(html`<div class="tabs" role="tablist">${QTABS.map(k => html`<a role="tab" href="#/queue?s=${k}" aria-selected="${k === tab ? 'true' : 'false'}">${tabLabel(k)}${k !== 'done' ? html` <span class="badge plain ${by[k].length ? 'hue' : ''}">${by[k].length}</span>` : ''}</a>`)}</div>
        ${list.length ? html`<div class="list">${list.map(o => html`<a href="#/order/${o.id}"><div class="grow"><span class="title">${o.patientName}</span>
          <span class="sub">${T('queue.from', '{doctor}, {org}', { doctor: o.prescriberName || T('queue.unknown_prescriber', 'Prescriber'), org: o.prescriberOrgName || '' })}</span>
          <span class="sub">${T('queue.items', '{n} items', { n: o.itemCount })} | ${o.fulfilment === 'delivery' ? T('queue.delivery', 'Home delivery') : T('queue.pickup', 'Pickup')} | ${ago(o.updatedAt || o.createdAt)}</span></div>
          <span class="end">${sBadge(o.status)}${o.totalKobo ? html`<br><span class="sm">${money(o.totalKobo)}</span>` : ''}</span></a>`)}</div>`
        : empty({ icon: 'pill', title: tab === 'received' ? T('queue.empty_received', 'No prescriptions waiting') : T('queue.empty_tab', 'Nothing in {status}', { status: tabLabel(tab) }), body: tab === 'received' ? T('queue.empty_received_sub', 'New prescriptions appear here as soon as a patient or doctor sends them to you.') : T('queue.empty_tab_sub', 'Orders move here as they progress.') })}`, box);
      const act = (by.received.length + by.verified.length + by.paid.length);
      MC.navCount('#/queue', act);
    };
    await load();
    MC.poll(load, 15000);
    refreshCounts();
  }

  /* ================= order page ================= */
  function orderSteps(o) {
    const all = o.fulfilment === 'delivery' ? ['received', 'verified', 'priced', 'paid', 'ready', 'out_for_delivery', 'delivered'] : ['received', 'verified', 'priced', 'paid', 'ready', 'collected'];
    const cur = o.status === 'queried' ? 'received' : o.status === 'allocating' ? 'paid' : o.status;
    const labels = {}; all.forEach(s => { labels[s] = S(s); });
    return MC.steps(all, cur, labels);
  }
  const FREQ = { stat: 'once (stat)', od: 'once daily', nocte: 'at night', mane: 'in the morning', bd: 'twice daily', tds: 'three times daily', qds: 'four times daily', q4h: 'every 4 hours', q6h: 'every 6 hours', q8h: 'every 8 hours', q12h: 'every 12 hours', weekly: 'once weekly', prn: 'when needed' };
  const freqText = f => (f ? MC.t('freq.' + f, FREQ[f] || f) : '');
  function rxItemLine(i) {
    return html`<span class="title">${i.drugName}${i.doseText ? ' ' + i.doseText : ''}</span>
      <span class="sub">${[freqText(i.frequency), i.durationDays ? T('order.days', '{n} days', { n: i.durationDays }) : '', i.route ? cap(i.route) : '', T('order.qty', 'Quantity {n}', { n: i.quantity })].filter(Boolean).join(' | ')}</span>
      ${i.instructions ? html`<span class="sub">${i.instructions}</span>` : ''}`;
  }

  async function orderPage({ params, query, stale }) {
    const o = await api.get('/api/pharmacy/orders/' + encodeURIComponent(params.id));
    if (stale()) return;
    const pregnant = query.pregnant === '1';
    const canVerify = has('pharmacy.verify') && ['received', 'queried'].includes(o.status);
    const billOpen = o.bill && o.bill.status === 'open' && !o.bill.paidKobo;
    const canPrice = has('pharmacy.dispense') && (o.status === 'verified' || (o.status === 'priced' && billOpen));
    const [safetyR, items, dlv] = await Promise.all([
      canVerify ? api.get('/api/pharmacy/orders/' + o.id + '/safety' + (pregnant ? '?pregnant=true' : '')) : null,
      canPrice ? api.get('/api/pharmacy/items') : null,
      o.deliveryId && hasAny(['delivery.dispatch', 'pharmacy.dispense']) && modOn('delivery') ? api.get('/api/delivery/deliveries/' + o.deliveryId).catch(() => null) : null,
    ]);
    if (stale()) return;
    const p = o.patient || {};
    referPatient = o.patientId ? Object.assign({}, p, { id: o.patientId }) : null;
    const active = !['collected', 'delivered', 'rejected', 'cancelled'].includes(o.status);
    const canCancel = hasAny(['pharmacy.verify', 'pharmacy.dispense']) && ['received', 'queried', 'verified', 'priced', 'paid', 'ready'].includes(o.status);
    const itemName = id => { const l = (o.lines || []).find(x => x.itemId === id); return l ? l.name : ''; };
    const ps = o.prescriberSafety || {};

    view(html`${back('#/queue?s=' + tabOf(o.status), T('queue.title', 'Prescriptions'))}
      <div class="page-head"><div><h1>${T('order.title', 'Prescription order')}</h1><p>${sBadge(o.status)} ${o.fulfilment === 'delivery' ? badge(T('queue.delivery', 'Home delivery'), 'info') : badge(T('queue.pickup', 'Pickup'), 'outline')} ${T('order.received_at', 'Received {when}', { when: dateTime(o.createdAt) })}</p></div>
        <div class="actions">${referBtn(o.patientId)}${canCancel ? html`<button class="btn" data-action="rx-cancel">${icon('x')}${T('order.cancel', 'Cancel order')}</button>` : ''}</div></div>
      ${wristband(p)}
      ${['rejected', 'cancelled'].includes(o.status) ? html`<div class="notice bad"><b>${S(o.status)}.</b> ${o.status === 'rejected' && o.verification ? o.verification.reason : o.cancelReason || ''}</div>` : orderSteps(o)}
      ${o.status === 'queried' ? html`<div class="notice warn"><b>${T('order.queried', 'Queried with the prescriber.')}</b> ${o.verification ? o.verification.reason : ''} ${T('order.queried_next', 'When the prescriber answers, record your decision below.')}</div>` : ''}
      ${o.refundDue ? html`<div class="notice warn"><b>${T('order.refund_due', 'Refund due: {amount}', { amount: money(o.refundDue.amountKobo) })}</b> ${o.refundDue.note || ''}</div>` : ''}
      <div class="grid side-r"><div>
        <section class="panel"><h2>${T('order.prescription', 'Prescription')}</h2>
          <dl class="kv"><dt>${T('order.prescriber', 'Prescriber')}</dt><dd>${o.prescriberName || '-'}</dd><dt>${T('order.source', 'From')}</dt><dd>${o.prescriberOrgName || '-'}</dd>${o.prescribedAt ? html`<dt>${T('order.written', 'Written')}</dt><dd>${dateTime(o.prescribedAt)}</dd>` : ''}
          ${o.fulfilment === 'delivery' ? html`<dt>${T('order.address', 'Deliver to')}</dt><dd>${o.address || '-'}</dd>` : ''}</dl>
          <ul class="list" style="margin-top:12px">${o.items.map(i => html`<li><div class="grow">${rxItemLine(i)}</div></li>`)}</ul>
          ${ps.overrideReason ? html`<div class="notice warn" style="margin-top:12px"><b>${T('order.prescriber_override', 'The prescriber overrode safety alerts:')}</b> ${ps.overrideReason}</div>` : ''}
        </section>
        ${safetySection(o, safetyR, pregnant)}
        ${canPrice ? pricingSection(o, items) : ''}
        ${(o.lines || []).length ? linesSection(o) : ''}
        ${o.status === 'paid' || o.status === 'allocating' ? readySection(o) : ''}
        ${(o.allocations || []).length ? html`<section class="panel"><h2>${T('order.picked', 'Batches picked (earliest expiry first)')}</h2><div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('stock.item', 'Item')}</th><th>${T('stock.batch', 'Batch')}</th><th>${T('stock.expiry', 'Expiry')}</th><th class="num">${T('stock.qty', 'Quantity')}</th></tr></thead><tbody>${o.allocations.map(a => html`<tr><td data-label="${T('stock.item', 'Item')}">${itemName(a.itemId)}</td><td data-label="${T('stock.batch', 'Batch')}"><b>${a.batchNo}</b></td><td data-label="${T('stock.expiry', 'Expiry')}">${date(a.expiry)}</td><td class="num" data-label="${T('stock.qty', 'Quantity')}">${a.qty}</td></tr>`)}</tbody></table></div></section>` : ''}
        ${o.status === 'ready' && o.fulfilment === 'pickup' ? collectSection(o) : ''}
        ${o.fulfilment === 'delivery' && o.delivery ? deliverySection(o, dlv) : ''}
      </div><div>
        ${billPanel(o.bill, { patientCanPay: true })}
        <section class="panel"><h2>${T('order.history', 'History')}</h2><ol class="timeline">${(o.timeline || []).map(x => html`<li><time>${dateTime(x.at)}</time><b>${S(x.status)}</b>${x.note ? html`<br><span class="muted">${x.note}</span>` : ''}</li>`)}</ol></section>
      </div></div>`);

    if (canPrice) { priceItems = items; updatePriceTotal(); }

    /* ----- actions on this order ----- */
    on('rx-pregnant', el => MC.go('#/order/' + o.id + (el.dataset.on ? '' : '?pregnant=1')));
    form('rx-verify', async d => {
      if (!d.decision) throw new MC.ApiError(400, { error: T('verify.choose', 'Choose a decision') });
      const reason = (d.reason || '').trim();
      if ((d.decision !== 'proceed' || (safetyR && safetyR.blocking)) && reason.length < 5) throw new MC.ApiError(400, { error: d.decision === 'proceed' ? T('verify.need_override', 'This order has serious safety alerts. Write your reason for going ahead (at least 5 characters), or query or reject it.') : T('verify.need_reason', 'Write a reason (at least 5 characters). The patient or prescriber sees it.'), details: [{ field: 'reason', error: T('verify.reason_short', 'At least 5 characters') }] });
      const q = { proceed: [T('verify.proceed_q', 'Verify this prescription?'), safetyR && safetyR.blocking ? T('verify.proceed_override_body', 'You are going ahead despite serious safety alerts. Your name and reason are recorded with the order.') : T('verify.proceed_body', 'The order moves on to pricing.'), T('verify.proceed', 'Verify and continue')],
        query: [T('verify.query_q', 'Query the prescriber?'), T('verify.query_body', 'The prescriber is notified to call the pharmacy. The order waits until you record a new decision.'), T('verify.query', 'Send query')],
        reject: [T('verify.reject_q', 'Reject this prescription?'), T('verify.reject_body', 'The patient is told why and gets the prescription back to send to another pharmacy.'), T('verify.reject', 'Reject prescription')] }[d.decision];
      if (!(await sure(q[0], q[1], q[2], d.decision === 'reject'))) return;
      await guard(async () => {
        try { await api.post('/api/pharmacy/orders/' + o.id + '/verify', { decision: d.decision, reason: reason || undefined, pregnant }); }
        catch (e) { if (e.code === 'safety_blocking') { await dialog({ title: T('verify.blocking', 'Serious safety alerts'), body: html`${MC.alerts(e.details || [])}<p>${e.message}</p>`, actions: [{ label: MC.t('kit.close', 'Close'), primary: true, value: null }] }); return; } throw e; }
        toast({ proceed: T('verify.done_proceed', 'Prescription verified'), query: T('verify.done_query', 'Query sent to the prescriber'), reject: T('verify.done_reject', 'Prescription rejected') }[d.decision], 'ok');
        MC.render();
      });
    });
    form('rx-price', async d => {
      const lines = []; let total = 0; const missing = [];
      o.items.forEach((it, i) => {
        const sel = d['item_' + i];
        if (!sel || sel === '__none') { const r1 = (d['nsr_' + i] || '').trim(); if (r1.length < 5) missing.push({ field: 'nsr_' + i, error: T('price.nsr_need', 'Say why this is not supplied (at least 5 characters)') }); lines.push({ rxIndex: i, supply: false, notSuppliedReason: r1 }); return; }
        const stockItem = items.find(x => x.id === sel); const sub = stockItem && stockItem.drugCode !== it.drugCode;
        const sr = (d['subr_' + i] || '').trim();
        if (sub && sr.length < 5) missing.push({ field: 'subr_' + i, error: T('price.subr_need', 'Different item from the prescription: give the substitution reason (at least 5 characters)') });
        lines.push(Object.assign({ rxIndex: i, itemId: sel }, sub ? { substitutionReason: sr } : {}));
        if (stockItem) total += stockItem.sellPriceKobo * it.quantity;
      });
      if (missing.length) throw new MC.ApiError(400, { error: T('price.fix', 'Fix the highlighted items'), details: missing });
      if (!lines.some(l => l.supply !== false)) throw new MC.ApiError(400, { error: T('price.none', 'At least one item must be supplied. Reject the order instead.') });
      const fee = o.fulfilment === 'delivery' ? ((MC.me.org.settings || {}).deliveryFeeKobo || 0) : 0;
      if (!(await sure(o.status === 'priced' ? T('price.reprice_q', 'Re-price this order?') : T('price.q', 'Price this order?'), T('price.body', 'A bill of {amount} is raised for {name}{fee}.', { amount: money(total + fee), name: p.name || '', fee: fee ? T('price.fee_note', ' (includes {fee} delivery)', { fee: money(fee) }) : '' }) + (o.status === 'priced' ? ' ' + T('price.reprice_body', 'The old unpaid bill is voided.') : ''), T('price.go', 'Price and raise bill')))) return;
      await guard(async () => { await api.post('/api/pharmacy/orders/' + o.id + '/price', { lines }); toast(T('price.done', 'Order priced. The patient can pay now.'), 'ok'); MC.render(); });
    });
    on('rx-ready', async () => {
      if (!(await sure(T('ready.q', 'Mark this order ready?'), o.fulfilment === 'pickup' ? T('ready.body_pickup', 'Stock is taken from the earliest-expiry batches and deducted now. The patient gets a pickup code by SMS and in the app.') : T('ready.body_delivery', 'Stock is taken from the earliest-expiry batches and deducted now. A delivery job is created for the dispatcher.'), T('ready.go', 'Mark ready')))) return;
      await guard(async () => { await api.post('/api/pharmacy/orders/' + o.id + '/ready'); toast(T('ready.done', 'Order marked ready'), 'ok'); MC.render(); });
    });
    form('rx-collect', async d => {
      const code = String(d.code || '').replace(/\D/g, '');
      if (code.length !== 6) throw new MC.ApiError(400, { error: T('collect.six', 'Enter the 6-digit pickup code from the patient'), details: [{ field: 'code', error: T('collect.six_short', '6 digits') }] });
      if (!(await sure(T('collect.q', 'Hand over to {name}?', { name: p.name || '' }), T('collect.body', 'The order is marked collected. Check you are giving the medicines to the right person.'), T('collect.go', 'Hand over medicines')))) return;
      await guard(async () => {
        try { await api.post('/api/pharmacy/orders/' + o.id + '/collect', { code }); }
        catch (e) { if (e.status === 423) { toast(e.message, 'bad'); MC.render(); return; } throw e; }
        toast(T('collect.done', 'Medicines handed over'), 'ok'); MC.render();
      });
    });
    on('rx-reissue', async () => {
      if (!(await sure(T('collect.reissue_q', 'Send a new pickup code?'), T('collect.reissue_body', 'The old code stops working. The patient gets the new code by SMS and in the app.'), T('collect.reissue', 'Send new code')))) return;
      await guard(async () => { await api.post('/api/pharmacy/orders/' + o.id + '/reissue-code'); toast(T('collect.reissued', 'New pickup code sent'), 'ok'); MC.render(); });
    });
    on('rx-handover', async () => {
      if (!(await sure(T('dlv.handover_q', 'Hand the package to the rider?'), T('dlv.handover_body', 'The order goes out for delivery and the patient gets an SMS with the delivery code.'), T('dlv.handover', 'Hand over to rider')))) return;
      await guard(async () => { await api.post('/api/delivery/deliveries/' + o.deliveryId + '/handover'); toast(T('dlv.handed', 'Handed over to the rider'), 'ok'); MC.render(); });
    });
    on('rx-returned', async () => {
      if (!(await sure(T('dlv.returned_q', 'Confirm the package is back?'), T('dlv.returned_body', 'The order goes back to ready so it can be delivered again or collected.'), T('dlv.returned', 'Confirm returned')))) return;
      await guard(async () => { await api.post('/api/delivery/deliveries/' + o.deliveryId + '/returned'); toast(T('dlv.returned_done', 'Package returned to the pharmacy'), 'ok'); MC.render(); });
    });
    on('rx-cancel', async () => {
      const paid = ['paid', 'ready'].includes(o.status);
      const r = await dialog({ title: T('order.cancel_q', 'Cancel this order?'), form: true,
        body: html`<p>${paid ? T('order.cancel_paid', 'The patient has paid. A refund will be due and must be paid from billing. Stock already picked goes back to the same batches.') : T('order.cancel_body', 'The patient is told and gets the prescription back to send to another pharmacy.')}</p>
          <div class="field"><label for="oc-r">${T('order.cancel_reason', 'Reason')}</label><textarea class="input" id="oc-r" name="reason" required maxlength="300"></textarea></div>`,
        actions: [{ label: T('order.keep', 'Keep order'), value: null }, { label: T('order.cancel', 'Cancel order'), primary: true }],
        onSubmit: async d => { if (!d.reason || d.reason.trim().length < 5) throw new MC.ApiError(400, { error: T('verify.need_reason', 'Write a reason (at least 5 characters). The patient or prescriber sees it.') }); return guard(() => api.post('/api/pharmacy/orders/' + o.id + '/cancel', { reason: d.reason.trim() })); } });
      if (r) { toast(T('order.cancelled', 'Order cancelled'), 'ok'); MC.render(); }
    });

    /* live: pick up payment, rider hand-over and status changes */
    if (active) MC.poll(async () => {
      const n = await api.get('/api/pharmacy/orders/' + o.id);
      const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest('#main form');
      if (!typing && (n.status !== o.status || n.updatedAt !== o.updatedAt || (n.bill && o.bill && n.bill.status !== o.bill.status) || (n.delivery && o.delivery && n.delivery.status !== o.delivery.status))) MC.render();
    }, 15000);
    refreshCounts();
  }

  function safetySection(o, s, pregnant) {
    const v = o.verification;
    if (s) {
      return html`<section class="panel"><h2>${T('verify.title', 'Pharmacist check')}</h2>
        <p class="muted sm">${T('verify.sub', 'The safety check has been re-run against this patient\'s allergies, conditions and other medicines from this pharmacy.')}</p>
        ${s.alerts.length ? MC.alerts(s.alerts) : html`<div class="notice ok">${T('verify.no_alerts', 'No safety alerts for this patient.')}</div>`}
        <label class="check"><input type="checkbox" data-action="rx-pregnant" data-on="${pregnant ? '1' : ''}" ${pregnant ? 'checked' : ''}><span>${T('verify.pregnant', 'Patient is pregnant or may be (re-checks the alerts)')}</span></label>
        <form data-form="rx-verify" novalidate>
          <fieldset style="border:0;padding:0;margin:0"><legend class="label" style="font-weight:700;margin-bottom:6px">${T('verify.decision', 'Your decision')}</legend>
            <label class="check"><input type="radio" name="decision" value="proceed"><span>${s.blocking ? T('verify.d_proceed_override', 'Go ahead despite the alerts (reason required)') : T('verify.d_proceed', 'Verified: go ahead')}</span></label>
            <label class="check"><input type="radio" name="decision" value="query"><span>${T('verify.d_query', 'Query the prescriber')}</span></label>
            <label class="check"><input type="radio" name="decision" value="reject"><span>${T('verify.d_reject', 'Reject the prescription')}</span></label></fieldset>
          <div class="field"><label for="vf-r">${T('verify.reason', 'Reason or note')}</label><textarea class="input" id="vf-r" name="reason" maxlength="500"></textarea><div class="hint">${T('verify.reason_hint', 'Needed for a query, a rejection, or going ahead despite serious alerts.')}</div></div>
          <div class="form-err notice bad" hidden></div>
          <button class="btn primary" type="submit">${icon('check')}${T('verify.record', 'Record decision')}</button></form></section>`;
    }
    if (['received', 'queried'].includes(o.status)) return html`<div class="notice warn">${T('verify.waiting', 'Waiting for a pharmacist to check this prescription.')}</div>`;
    if (!v) return '';
    return html`<section class="panel"><h2>${T('verify.title', 'Pharmacist check')}</h2>
      <dl class="kv"><dt>${T('verify.by', 'Checked by')}</dt><dd>${v.byName} | ${dateTime(v.at)}</dd><dt>${T('verify.decision_rec', 'Decision')}</dt><dd>${S(v.decision === 'proceed' ? 'verified' : v.decision === 'query' ? 'queried' : 'rejected')}</dd>${v.reason ? html`<dt>${T('verify.reason', 'Reason or note')}</dt><dd>${v.reason}</dd>` : ''}</dl>
      ${MC.alerts(v.alerts || [])}</section>`;
  }

  function pricingSection(o, items) {
    const prev = {}; (o.lines || []).forEach(l => { prev[l.rxIndex] = l; });
    const fee = o.fulfilment === 'delivery' ? ((MC.me.org.settings || {}).deliveryFeeKobo || 0) : 0;
    return html`<form class="panel" data-form="rx-price" novalidate id="rx-price"><h2>${o.status === 'priced' ? T('price.retitle', 'Change pricing') : T('price.title', 'Price from your stock')}</h2>
      <p class="muted sm">${T('price.sub', 'Quantities come from the prescription. Prices come from your stock list. Choosing a different item is a substitution and needs a reason.')}</p>
      ${o.items.map((it, i) => {
        const pl = prev[i];
        const matchId = pl ? (pl.supplied === false ? '__none' : pl.itemId) : ((items.find(x => x.drugCode && x.drugCode === it.drugCode) || {}).id || '__none');
        return html`<div class="ph-rx"><div>${rxItemLine(it)}</div>
          <div class="field" style="margin-top:8px"><label for="pr-i${i}">${T('price.supply_with', 'Supply with')}</label>
            <select class="input" id="pr-i${i}" name="item_${i}" data-price-sel="${i}" data-qty="${it.quantity}">
              ${items.map(x => opt(x.id, T('price.option', '{name} | {stock} in stock | {price} each', { name: x.name, stock: x.onHand, price: money(x.sellPriceKobo) }) + (x.drugCode && x.drugCode === it.drugCode ? '' : ' ' + T('price.substitute_tag', '(substitute)')), x.id === matchId))}
              ${opt('__none', T('price.not_supplied', 'Not supplied'), matchId === '__none')}</select></div>
          <div class="fields two"><div class="field"><label for="pr-s${i}">${T('price.subr', 'Substitution reason (if a different item)')}</label><input class="input" id="pr-s${i}" name="subr_${i}" maxlength="300" value="${pl && pl.substitutionReason ? pl.substitutionReason : ''}"></div>
            <div class="field"><label for="pr-n${i}">${T('price.nsr', 'Why not supplied (if not supplied)')}</label><input class="input" id="pr-n${i}" name="nsr_${i}" maxlength="300" value="${pl && pl.notSuppliedReason ? pl.notSuppliedReason : ''}"></div></div></div>`;
      })}
      ${fee ? html`<p class="sm">${T('price.fee', 'Delivery fee: {fee}', { fee: money(fee) })}</p>` : ''}
      <div class="ph-cart-total"><span>${T('price.total', 'Total')}</span><span id="rx-price-total" data-fee="${fee}"></span></div>
      <div class="form-err notice bad" hidden></div>
      <button class="btn primary" type="submit">${icon('card')}${o.status === 'priced' ? T('price.repricebtn', 'Re-price and raise new bill') : T('price.go', 'Price and raise bill')}</button></form>`;
  }
  let priceItems = [];
  function updatePriceTotal() {
    const f = document.getElementById('rx-price'); const out = document.getElementById('rx-price-total'); if (!f || !out) return;
    let total = Number(out.dataset.fee) || 0;
    f.querySelectorAll('[data-price-sel]').forEach(s => { const it = priceItems.find(x => x.id === s.value); if (it) total += it.sellPriceKobo * Number(s.dataset.qty); });
    out.textContent = money(total);
  }
  document.addEventListener('change', e => { if (e.target && e.target.matches && e.target.matches('[data-price-sel]')) updatePriceTotal(); });

  function linesSection(o) {
    return html`<section class="panel"><h2>${T('lines.title', 'What is supplied')}</h2><div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('stock.item', 'Item')}</th><th class="num">${T('stock.qty', 'Quantity')}</th><th class="num">${T('lines.unit', 'Each')}</th><th class="num">${T('price.total', 'Total')}</th></tr></thead><tbody>
      ${o.lines.map(l => html`<tr><td data-label="${T('stock.item', 'Item')}"><b>${l.name}</b>${l.supplied === false ? html`<br>${badge(T('price.not_supplied', 'Not supplied'), 'warn')} <span class="sm">${l.notSuppliedReason}</span>` : ''}${l.substitutedFor ? html`<br>${badge(T('lines.substituted', 'Substituted for {code}', { code: l.substitutedFor }), 'info')} <span class="sm">${l.substitutionReason}</span>` : ''}${l.controlled ? html` ${badge(T('stock.controlled', 'Controlled'), 'bad')}` : ''}</td>
        <td class="num" data-label="${T('stock.qty', 'Quantity')}">${l.qty}</td><td class="num" data-label="${T('lines.unit', 'Each')}">${money(l.unitPriceKobo)}</td><td class="num" data-label="${T('price.total', 'Total')}">${money(l.totalKobo)}</td></tr>`)}
      </tbody></table></div>${o.deliveryFeeKobo ? html`<p class="sm" style="margin-top:8px">${T('price.fee', 'Delivery fee: {fee}', { fee: money(o.deliveryFeeKobo) })}</p>` : ''}<div class="ph-cart-total"><span>${T('price.total', 'Total')}</span><span>${money(o.totalKobo)}</span></div></section>`;
  }
  function readySection(o) {
    if (!has('pharmacy.dispense')) return html`<div class="notice">${T('ready.wait', 'Paid. Waiting for the pharmacy team to prepare it.')}</div>`;
    return html`<section class="panel"><h2>${T('ready.title', 'Prepare the order')}</h2><p>${T('ready.sub', 'Payment received. Pick the items, then mark the order ready. Stock is deducted from the earliest-expiry batches.')}</p>
      <button class="btn primary lg" data-action="rx-ready">${icon('box')}${T('ready.go', 'Mark ready')}</button></section>`;
  }
  function collectSection(o) {
    return html`<section class="panel"><h2>${T('collect.title', 'Collection')}</h2>
      ${o.collectBy ? html`<p class="${o.pickupOverdue ? '' : 'muted'}">${o.pickupOverdue ? badge(T('collect.overdue', 'Overdue'), 'bad') : ''} ${T('collect.by', 'Collect by {when}', { when: dateTime(o.collectBy) })}</p>` : ''}
      ${o.pickupLocked ? html`<div class="notice bad">${T('collect.locked', 'Too many wrong codes were entered. A pharmacist must send the patient a new pickup code.')}</div>${has('pharmacy.verify') ? html`<button class="btn primary" data-action="rx-reissue">${icon('key')}${T('collect.reissue', 'Send new code')}</button>` : ''}`
      : has('pharmacy.dispense') ? html`<form data-form="rx-collect" novalidate><div class="field"><label for="cl-c">${T('collect.code', 'Pickup code from the patient')}</label><input class="input ph-code" id="cl-c" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" required><div class="hint">${T('collect.code_hint', 'The patient has it in the MediCore app or by SMS. {n} wrong tries so far.', { n: o.pickupAttempts || 0 })}</div></div>
        <div class="form-err notice bad" hidden></div><div class="btn-row"><button class="btn primary" type="submit">${icon('check')}${T('collect.go', 'Hand over medicines')}</button>${has('pharmacy.verify') ? html`<button class="btn" type="button" data-action="rx-reissue">${T('collect.reissue', 'Send new code')}</button>` : ''}</div></form>` : ''}</section>`;
  }
  function deliverySection(o, d) {
    const st = (d || o.delivery).status;
    return html`<section class="panel"><h2>${T('dlv.title', 'Delivery')}</h2>
      <dl class="kv"><dt>${T('bill.status', 'Status')}</dt><dd>${sBadge(st)} ${o.delivery.locked ? badge(T('dlv.locked', 'Code locked'), 'bad') : ''}</dd>
        ${d && d.rider ? html`<dt>${T('dlv.rider', 'Rider')}</dt><dd>${d.rider.name}${d.rider.phone ? html` | <a href="tel:${d.rider.phone}">${d.rider.phone}</a>` : ''}</dd>` : html`<dt>${T('dlv.rider', 'Rider')}</dt><dd>${T('dlv.no_rider', 'Not assigned yet')}</dd>`}
        ${d && d.failReason ? html`<dt>${T('dlv.fail_reason', 'Why it failed')}</dt><dd>${MC.t('rider.fail.' + d.failReason, cap(d.failReason))}${d.failNote ? ': ' + d.failNote : ''}</dd>` : ''}</dl>
      <div class="btn-row">
        ${st === 'assigned' && hasAny(['pharmacy.dispense', 'delivery.dispatch']) ? html`<button class="btn primary" data-action="rx-handover">${icon('truck')}${T('dlv.handover', 'Hand over to rider')}</button>` : ''}
        ${st === 'failed' && hasAny(['pharmacy.dispense', 'delivery.dispatch']) ? html`<button class="btn primary" data-action="rx-returned">${icon('box')}${T('dlv.returned', 'Confirm returned')}</button>` : ''}
        ${has('delivery.dispatch') ? html`<a class="btn" href="#/deliveries/${o.deliveryId}">${icon('pin')}${T('dlv.open', 'Open in deliveries')}</a>` : ''}</div></section>`;
  }

  /* ================= counter sale ================= */
  const cart = { lines: [], patient: null, results: [] };
  on('ph-refer-cart', async () => { if (cart.patient) await MC.referrals.sendDialog({ patient: cart.patient }); });
  const cartTotal = () => cart.lines.reduce((s, l) => s + l.item.sellPriceKobo * l.qty, 0);
  async function counterPage() {
    const [res, sales] = await Promise.all([api.get('/api/pharmacy/counter/items'), api.get('/api/pharmacy/sales?limit=30')]);
    cart.results = res;
    const waiting = sales.filter(s => s.status === 'awaiting_approval' || s.status === 'billed' || (s.status === 'paid' && s.stockShort));
    view(html`<div class="page-head"><div><h1>${T('counter.title', 'Counter sale')}</h1><p>${T('counter.sub', 'Walk-in sales. Prescription-only items need a registered patient and a pharmacist\'s approval.')}</p></div></div>
      <div class="grid two"><section class="panel"><h2>${T('counter.find', 'Find items')}</h2>
        <form data-form="ctr-search" class="search" role="search" novalidate>${icon('search')}<label class="sr-only" for="ctr-q">${T('counter.search', 'Search by name or code')}</label><input class="input" id="ctr-q" name="q" placeholder="${T('counter.search', 'Search by name or code')}" autocomplete="off"></form>
        <div id="ctr-results" style="margin-top:12px"></div></section>
        <section class="panel" id="ctr-cart"></section></div>
      <section><h2>${T('counter.recent', 'Sales needing action')}</h2>
        ${waiting.length ? saleList(waiting) : empty({ icon: 'card', title: T('counter.none_waiting', 'No sales waiting'), body: T('counter.none_waiting_sub', 'Sales awaiting approval or payment show here.') })}
        ${sales.length > waiting.length ? html`<h3 style="margin-top:24px">${T('counter.earlier', 'Earlier sales')}</h3>${saleList(sales.filter(s => !waiting.includes(s)).slice(0, 15))}` : ''}</section>`);
    renderResults(); renderCart();
    form('ctr-search', async d => { cart.results = await api.get('/api/pharmacy/counter/items' + qs({ q: d.q })); renderResults(); });
    refreshCounts();
  }
  function saleList(rows) {
    return html`<div class="list">${rows.map(s => html`<a href="#/sales/${s.id}"><div class="grow"><span class="title">${s.number} ${s.patientName ? '| ' + s.patientName : ''}</span><span class="sub">${s.lines.map(l => l.qty + ' x ' + l.name).join(', ')}</span><span class="sub">${s.createdByName} | ${ago(s.createdAt)}</span></div><span class="end">${sBadge(s.status)}${s.stockShort ? html`<br>${badge(T('sale.short', 'Stock short'), 'bad')}` : ''}<br><span class="sm">${money(s.totalKobo)}</span></span></a>`)}</div>`;
  }
  let searchT = null;
  document.addEventListener('input', e => {
    if (e.target && e.target.id === 'ctr-q') { clearTimeout(searchT); const v = e.target.value; searchT = setTimeout(async () => { try { cart.results = await api.get('/api/pharmacy/counter/items' + qs({ q: v })); renderResults(); } catch (err) { /* shown on submit */ } }, 300); }
  });
  document.addEventListener('change', e => {
    if (e.target && e.target.dataset && e.target.dataset.cartQty) { const l = cart.lines.find(x => x.item.id === e.target.dataset.cartQty); if (l) { l.qty = Math.max(1, Math.min(1000, Math.round(Number(e.target.value) || 1))); renderCart(); } }
  });
  function renderResults() {
    const box = document.getElementById('ctr-results'); if (!box) return;
    view(cart.results.length ? html`<ul class="list">${cart.results.map(it => html`<li><div class="grow"><span class="title">${it.name}</span><span class="sub">${money(it.sellPriceKobo)} | ${T('counter.available', '{n} available', { n: it.available })}</span>
      <span>${it.rxOnly ? badge(T('stock.rx_only', 'Prescription only'), 'warn') : badge(T('stock.otc', 'Over the counter'), 'ok')} ${it.controlled ? badge(T('stock.controlled', 'Controlled'), 'bad') : ''}</span></div>
      <button class="btn sm" data-action="ctr-add" data-id="${it.id}" ${it.available > 0 ? '' : 'disabled'} aria-label="${T('counter.add_named', 'Add {name}', { name: it.name })}">${icon('plus')}${it.available > 0 ? T('counter.add', 'Add') : T('counter.out', 'Out of stock')}</button></li>`)}</ul>`
      : empty({ icon: 'search', title: T('counter.no_match', 'No items match'), body: T('counter.no_match_sub', 'Try another name or code.') }), box);
  }
  function renderCart() {
    const box = document.getElementById('ctr-cart'); if (!box) return;
    const needsPatient = cart.lines.some(l => l.item.rxOnly);
    view(html`<h2>${T('counter.cart', 'This sale')}</h2>
      ${cart.patient ? html`${wristband(cart.patient)}<div class="btn-row" style="margin-top:0;margin-bottom:12px"><button class="btn sm" data-action="ctr-patient">${T('counter.change_patient', 'Change patient')}</button><button class="btn sm ghost" data-action="ctr-unpatient">${T('counter.remove_patient', 'Remove patient')}</button>${canRefer() ? html`<button class="btn sm" data-action="ph-refer-cart">${icon('swap')}${T('refer.btn', 'Refer to a doctor or hospital')}</button>` : ''}</div>`
        : html`<div class="${needsPatient ? 'notice warn' : 'notice'}">${needsPatient ? T('counter.need_patient', 'This sale has prescription-only items. Link the registered patient.') : T('counter.patient_optional', 'Linking a patient is optional for over-the-counter items.')}<div class="btn-row" style="margin-top:8px"><button class="btn sm ${needsPatient ? 'primary' : ''}" data-action="ctr-patient">${icon('user')}${T('counter.link_patient', 'Link patient')}</button></div></div>`}
      ${cart.lines.length ? html`<ul class="list">${cart.lines.map(l => html`<li><div class="grow"><span class="title">${l.item.name}</span><span class="sub">${money(l.item.sellPriceKobo)} ${T('counter.each', 'each')} | ${T('counter.available', '{n} available', { n: l.item.available })}</span>${l.item.rxOnly ? badge(T('stock.rx_only', 'Prescription only'), 'warn') : ''}</div>
        <label class="sr-only" for="cq-${l.item.id}">${T('stock.qty', 'Quantity')}</label><input class="input ph-qty" id="cq-${l.item.id}" type="number" min="1" max="1000" value="${l.qty}" data-cart-qty="${l.item.id}" inputmode="numeric">
        <button class="icon-btn" data-action="ctr-remove" data-id="${l.item.id}" aria-label="${T('counter.remove_named', 'Remove {name}', { name: l.item.name })}">${icon('trash')}</button></li>`)}</ul>
        <div class="ph-cart-total"><span>${T('price.total', 'Total')}</span><span>${money(cartTotal())}</span></div>
        <div class="field"><label for="ctr-note">${T('counter.note', 'Note (optional)')}</label><input class="input" id="ctr-note" maxlength="300"></div>
        <button class="btn primary block lg" data-action="ctr-create" ${needsPatient && !cart.patient ? 'disabled' : ''}>${icon('card')}${T('counter.create', 'Create sale and bill')}</button>`
      : empty({ icon: 'card', title: T('counter.empty', 'No items yet'), body: T('counter.empty_sub', 'Search on the left and add items to the sale.') })}`, box);
  }
  on('ctr-add', el => {
    const it = cart.results.find(x => x.id === el.dataset.id); if (!it) return;
    const l = cart.lines.find(x => x.item.id === it.id); if (l) l.qty = Math.min(1000, l.qty + 1); else cart.lines.push({ item: it, qty: 1 });
    renderCart();
  });
  on('ctr-remove', el => { cart.lines = cart.lines.filter(x => x.item.id !== el.dataset.id); renderCart(); });
  on('ctr-unpatient', () => { cart.patient = null; renderCart(); });
  on('ctr-patient', async () => { const p1 = await pickPatient(); if (p1) { cart.patient = p1; renderCart(); } });
  async function pickPatient() {
    let found = []; let chosen = null;
    await dialog({ title: T('patient.find', 'Find patient'), form: true,
      body: html`<p class="muted sm">${T('patient.find_sub', 'Patients registered with your provider. Search by name, phone or record number.')}</p><div class="field"><label for="pp-q">${T('patient.search', 'Name, phone or record number')}</label><input class="input" id="pp-q" name="q" autocomplete="off"></div><div id="pp-res"></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('patient.search_btn', 'Search'), primary: true }],
      onOpen: d => d.addEventListener('click', ev => { const b = ev.target.closest('[data-pick]'); if (!b) return; ev.preventDefault(); chosen = found.find(x => x.id === b.dataset.pick) || null; d.dispatchEvent(new Event('cancel')); }),
      onSubmit: async (d, f) => {
        if (!d.q || d.q.trim().length < 2) throw new MC.ApiError(400, { error: T('patient.two', 'Type at least 2 characters') });
        found = await api.get('/api/fd/patients' + qs({ q: d.q.trim(), limit: 20 }));
        view(found.length ? html`<div class="choice">${found.map(x => html`<button type="button" data-pick="${x.id}"><span><b>${x.name}</b><br><span class="muted sm">${x.mrn || ''} ${x.age != null ? '| ' + T('patient.age', '{n} yrs', { n: x.age }) : ''} ${x.phone ? '| ' + x.phone : ''}</span></span>${icon('right')}</button>`)}</div>`
          : html`<div class="notice">${T('patient.none', 'No registered patient matches. New patients are registered at the front desk.')}</div>`, f.querySelector('#pp-res'));
        return false;
      } });
    return chosen;
  }

  on('ctr-create', async () => {
    if (!cart.lines.length) return;
    const total = cartTotal();
    const note = (document.getElementById('ctr-note') || {}).value || undefined;
    const rxOnly = cart.lines.some(l => l.item.rxOnly);
    if (!(await sure(T('counter.create_q', 'Create this sale for {amount}?', { amount: money(total) }), rxOnly && !has('pharmacy.verify') ? T('counter.create_body_wait', 'A bill is raised after a pharmacist approves the prescription-only items.') : T('counter.create_body', 'A bill is raised now. Stock is deducted when the bill is paid.'), T('counter.create', 'Create sale and bill')))) return;
    const body = { patientId: cart.patient ? cart.patient.id : undefined, lines: cart.lines.map(l => ({ itemId: l.item.id, qty: l.qty })), note };
    let sale;
    try { sale = await api.post('/api/pharmacy/sales', body); }
    catch (e) {
      if (e.code !== 'safety_blocking') { if (e.status === 409) { toast(e.message, 'bad'); return; } throw e; }
      const r = await overrideDialog(e);
      if (!r) return;
      sale = await api.post('/api/pharmacy/sales', Object.assign(body, { overrideReason: r }));
    }
    cart.lines = []; cart.patient = null;
    toast(sale.status === 'awaiting_approval' ? T('counter.created_wait', 'Sale {n} created. Waiting for pharmacist approval.', { n: sale.number }) : T('counter.created', 'Sale {n} created', { n: sale.number }), 'ok');
    MC.go('#/sales/' + sale.id);
  });
  async function overrideDialog(e) {
    const r = await dialog({ title: T('verify.blocking', 'Serious safety alerts'), form: true,
      body: html`${MC.alerts(e.details || [])}<p>${e.message}</p><div class="field"><label for="ov-r">${T('sale.override', 'Your reason to go ahead')}</label><textarea class="input" id="ov-r" name="reason" required maxlength="300"></textarea></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('sale.override_go', 'Go ahead with reason'), primary: true, danger: true }],
      onSubmit: d => { if (!d.reason || d.reason.trim().length < 5) throw new MC.ApiError(400, { error: T('verify.reason_short', 'At least 5 characters') }); return d.reason.trim(); } });
    return r;
  }

  async function salePage({ params, stale }) {
    const s = await api.get('/api/pharmacy/sales/' + encodeURIComponent(params.id));
    const patient = s.patientId ? await api.get('/api/fd/patients/' + s.patientId).catch(() => null) : null;
    if (stale()) return;
    referPatient = patient;
    const all = s.timeline.some(x => x.status === 'awaiting_approval') || s.status === 'awaiting_approval' || (s.approval && s.lines.some(l => l.rxOnly)) ? ['awaiting_approval', 'billed', 'paid', 'completed'] : ['billed', 'paid', 'completed'];
    const labels = {}; all.forEach(k => { labels[k] = S(k); });
    view(html`${back('#/counter', T('counter.title', 'Counter sale'))}
      <div class="page-head"><div><h1>${T('sale.title', 'Sale {n}', { n: s.number })}</h1><p>${sBadge(s.status)} ${T('sale.by', 'By {name}, {when}', { name: s.createdByName, when: dateTime(s.createdAt) })}</p></div>
        <div class="actions">${patient ? referBtn(patient.id) : ''}${['awaiting_approval', 'billed'].includes(s.status) ? html`<button class="btn" data-action="sale-cancel">${icon('x')}${T('sale.cancel', 'Cancel sale')}</button>` : ''}</div></div>
      ${patient ? wristband(patient) : ''}
      ${s.status === 'cancelled' ? html`<div class="notice bad">${T('sale.cancelled', 'Cancelled.')} ${s.cancelReason || ''}</div>` : MC.steps(all, s.status === 'dispensing' ? 'paid' : s.status, labels)}
      ${s.stockShort ? html`<div class="notice bad">${T('sale.short_body', 'Paid, but stock ran out before it could be deducted. Restock or check the shelf, then complete the sale.')} ${s.stockError || ''}<div class="btn-row"><button class="btn primary" data-action="sale-complete">${T('sale.complete', 'Complete sale')}</button></div></div>` : ''}
      <div class="grid side-r"><div>
        <section class="panel"><h2>${T('sale.items', 'Items')}</h2><div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('stock.item', 'Item')}</th><th class="num">${T('stock.qty', 'Quantity')}</th><th class="num">${T('lines.unit', 'Each')}</th><th class="num">${T('price.total', 'Total')}</th></tr></thead><tbody>
          ${s.lines.map(l => html`<tr><td data-label="${T('stock.item', 'Item')}"><b>${l.name}</b> ${l.rxOnly ? badge(T('stock.rx_only', 'Prescription only'), 'warn') : ''} ${l.controlled ? badge(T('stock.controlled', 'Controlled'), 'bad') : ''}</td><td class="num" data-label="${T('stock.qty', 'Quantity')}">${l.qty}</td><td class="num" data-label="${T('lines.unit', 'Each')}">${money(l.unitPriceKobo)}</td><td class="num" data-label="${T('price.total', 'Total')}">${money(l.totalKobo)}</td></tr>`)}
          </tbody></table></div><div class="ph-cart-total"><span>${T('price.total', 'Total')}</span><span>${money(s.totalKobo)}</span></div>${s.note ? html`<p class="sm muted">${s.note}</p>` : ''}</section>
        ${s.status === 'awaiting_approval' ? (has('pharmacy.verify') ? html`<section class="panel"><h2>${T('sale.approve_title', 'Pharmacist approval')}</h2><p>${T('sale.approve_sub', 'Check the prescription-only items for this patient. The safety check runs when you approve.')}</p><button class="btn primary" data-action="sale-approve">${icon('check')}${T('sale.approve', 'Approve and raise bill')}</button></section>` : html`<div class="notice warn">${T('sale.wait_pharmacist', 'Waiting for a pharmacist to approve the prescription-only items.')}</div>`) : ''}
        ${s.approval ? html`<section class="panel"><h2>${T('sale.approve_title', 'Pharmacist approval')}</h2><p>${s.approval.byName} | ${dateTime(s.approval.at)}</p>${MC.alerts(s.approval.alerts || [])}${s.approval.overrideReason ? html`<p><b>${T('sale.override', 'Your reason to go ahead')}:</b> ${s.approval.overrideReason}</p>` : ''}</section>` : ''}
        ${(s.allocations || []).length ? html`<section class="panel"><h2>${T('order.picked', 'Batches picked (earliest expiry first)')}</h2><ul class="list">${s.allocations.map(a => html`<li><div class="grow"><span class="title">${(s.lines.find(l => l.itemId === a.itemId) || {}).name || ''}</span><span class="sub">${T('stock.batch', 'Batch')} ${a.batchNo} | ${T('stock.expiry', 'Expiry')} ${date(a.expiry)}</span></div><span class="end">${a.qty}</span></li>`)}</ul></section>` : ''}
      </div><div>${billPanel(s.bill, { patientCanPay: !!s.patientId })}</div></div>`);
    on('sale-approve', async () => {
      if (!(await sure(T('sale.approve_q', 'Approve this sale?'), T('sale.approve_body', 'A bill of {amount} is raised. Your name is recorded on the approval.', { amount: money(s.totalKobo) }), T('sale.approve', 'Approve and raise bill')))) return;
      await guard(async () => {
        try { await api.post('/api/pharmacy/sales/' + s.id + '/approve', {}); }
        catch (e) { if (e.code !== 'safety_blocking') throw e; const r = await overrideDialog(e); if (!r) return; await api.post('/api/pharmacy/sales/' + s.id + '/approve', { overrideReason: r }); }
        toast(T('sale.approved', 'Sale approved'), 'ok'); MC.render();
      });
    });
    on('sale-complete', async () => {
      if (!(await sure(T('sale.complete_q', 'Deduct stock now?'), T('sale.complete_body', 'Stock is taken from the earliest-expiry batches.'), T('sale.complete', 'Complete sale')))) return;
      await guard(async () => { await api.post('/api/pharmacy/sales/' + s.id + '/complete'); toast(T('sale.completed', 'Sale completed'), 'ok'); MC.render(); });
    });
    on('sale-cancel', async () => {
      const r = await dialog({ title: T('sale.cancel_q', 'Cancel sale {n}?', { n: s.number }), form: true, body: html`<p>${T('sale.cancel_body', 'The bill is voided. Nothing has left the shelf yet.')}</p><div class="field"><label for="sc-r">${T('order.cancel_reason', 'Reason')}</label><input class="input" id="sc-r" name="reason" required maxlength="300"></div>`,
        actions: [{ label: T('sale.keep', 'Keep sale'), value: null }, { label: T('sale.cancel', 'Cancel sale'), primary: true }],
        onSubmit: d => { if (!d.reason || d.reason.trim().length < 3) throw new MC.ApiError(400, { error: T('sale.reason3', 'Write a reason (at least 3 characters)') }); return guard(() => api.post('/api/pharmacy/sales/' + s.id + '/cancel', { reason: d.reason.trim() })); } });
      if (r) { toast(T('sale.cancelled_t', 'Sale cancelled'), 'ok'); MC.render(); }
    });
    if (['billed', 'awaiting_approval'].includes(s.status)) MC.poll(async () => { const n = await api.get('/api/pharmacy/sales/' + s.id); if (n.status !== s.status) MC.render(); }, 15000);
  }

  /* ================= inventory ================= */
  let suppliersCache = null;
  const getSuppliers = async () => suppliersCache || (suppliersCache = await api.get('/api/pharmacy/suppliers'));
  async function stockPage({ query }) {
    const [items, al] = await Promise.all([api.get('/api/pharmacy/items' + qs({ q: query.q, lowOnly: query.low ? 'true' : undefined, includeInactive: query.all ? 'true' : undefined })), api.get('/api/pharmacy/alerts')]);
    const canStock = has('pharmacy.stock');
    view(html`<div class="page-head"><div><h1>${T('stock.title', 'Stock')}</h1><p>${T('stock.sub', 'Usable stock only counts batches that are in date and not quarantined.')}</p></div>
      <div class="actions">${canStock ? html`<button class="btn primary" data-action="stk-receive">${icon('plus')}${T('stock.receive', 'Receive stock')}</button><button class="btn" data-action="stk-add">${T('stock.add_item', 'Add item')}</button>` : ''}</div></div>
      ${figures([{ value: items.length, label: T('stock.f_items', 'Items') }, { value: al.lowStock.length, label: T('stock.f_low', 'Low or out of stock'), tone: al.lowStock.length ? 'warn' : '' }, { value: al.expiring.length, label: T('stock.f_expiring', 'Batches expiring in 90 days'), tone: al.expiring.length ? 'warn' : '' }, { value: al.expired.length, label: T('stock.f_expired', 'Expired batches on shelf'), tone: al.expired.length ? 'bad' : '' }])}
      ${al.expired.length ? html`<div class="notice bad"><b>${T('stock.expired_title', 'Expired stock is still on the shelf.')}</b> ${al.expired.map(x => x.name + ' (' + x.batchNo + ', ' + x.qty + ')').join('; ')}${canStock ? html`<div class="btn-row"><button class="btn danger" data-action="stk-sweep">${T('stock.sweep', 'Write off expired stock')}</button></div>` : ''}</div>` : ''}
      <div class="grid two">
        <section class="panel flush"><h2>${T('stock.low_title', 'Low stock')}</h2>${al.lowStock.length ? html`<ul class="list">${al.lowStock.map(x => html`<li><div class="grow"><a class="title" href="#/stock/${x.itemId}">${x.name}</a><span class="sub">${T('stock.low_line', '{n} on hand, reorder at {r}', { n: x.onHand, r: x.reorderLevel })}</span></div>${x.outOfStock ? badge(T('stock.out', 'Out of stock'), 'bad') : badge(T('stock.low', 'Low'), 'warn')}</li>`)}</ul>` : empty({ icon: 'box', title: T('stock.low_none', 'Nothing is low') })}</section>
        <section class="panel flush"><h2>${T('stock.exp_title', 'Expiring soon')}</h2>${al.expiring.length ? html`<ul class="list">${al.expiring.map(x => html`<li><div class="grow"><a class="title" href="#/stock/${x.itemId}">${x.name}</a><span class="sub">${T('stock.batch', 'Batch')} ${x.batchNo} | ${x.qty} | ${date(x.expiry)}</span></div>${badge(T('stock.days', '{n} days', { n: x.daysToExpiry }), x.daysToExpiry < 30 ? 'bad' : 'warn')}</li>`)}</ul>` : empty({ icon: 'clock', title: T('stock.exp_none', 'Nothing expires in the next 90 days') })}</section></div>
      <form data-form="stk-filter" class="ph-toolbar" novalidate><div class="field"><label for="sf-q">${T('stock.search', 'Search items')}</label><input class="input" id="sf-q" name="q" value="${query.q || ''}"></div>
        <label class="check"><input type="checkbox" name="low" ${query.low ? 'checked' : ''}><span>${T('stock.low_only', 'Low stock only')}</span></label>
        <label class="check"><input type="checkbox" name="all" ${query.all ? 'checked' : ''}><span>${T('stock.inactive', 'Include inactive')}</span></label>
        <button class="btn" type="submit">${icon('search')}${T('stock.filter', 'Show')}</button></form>
      ${items.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('stock.item', 'Item')}</th><th class="num">${T('stock.on_hand', 'On hand')}</th><th class="num">${T('stock.reorder', 'Reorder at')}</th><th>${T('stock.earliest', 'Earliest expiry')}</th><th class="num">${T('stock.price', 'Price')}</th><th>${T('stock.flags', 'Notes')}</th></tr></thead><tbody>
        ${items.map(i => html`<tr><td data-label="${T('stock.item', 'Item')}"><a href="#/stock/${i.id}"><b>${i.name}</b></a>${i.drugCode ? html`<br><span class="xs muted">${i.drugCode}</span>` : ''}</td><td class="num" data-label="${T('stock.on_hand', 'On hand')}">${i.onHand}</td><td class="num" data-label="${T('stock.reorder', 'Reorder at')}">${i.reorderLevel}</td><td data-label="${T('stock.earliest', 'Earliest expiry')}">${i.earliestExpiry ? date(i.earliestExpiry) : '-'}</td><td class="num" data-label="${T('stock.price', 'Price')}">${money(i.sellPriceKobo)}</td>
          <td data-label="${T('stock.flags', 'Notes')}">${i.outOfStock ? badge(T('stock.out', 'Out of stock'), 'bad') : i.lowStock ? badge(T('stock.low', 'Low'), 'warn') : ''} ${i.nearExpiryQty ? badge(T('stock.near', '{n} near expiry', { n: i.nearExpiryQty }), 'warn') : ''} ${i.quarantinedQty ? badge(T('stock.quar', '{n} quarantined', { n: i.quarantinedQty }), 'bad') : ''} ${i.controlled ? badge(T('stock.controlled', 'Controlled'), 'bad') : ''} ${i.rxOnly ? badge(T('stock.rx', 'Rx'), 'outline') : ''} ${i.active === false ? badge(S('inactive'), 'outline') : ''}</td></tr>`)}
        </tbody></table></div>` : empty({ icon: 'box', title: T('stock.none', 'No items found'), body: T('stock.none_sub', 'Add the medicines you stock, then receive batches against them.'), action: canStock ? html`<button class="btn primary" data-action="stk-add">${T('stock.add_item', 'Add item')}</button>` : '' })}`);
    form('stk-filter', d => MC.go('#/stock' + qs({ q: d.q, low: d.low ? '1' : '', all: d.all ? '1' : '' })));
    refreshCounts();
  }
  on('stk-sweep', async () => {
    if (!(await sure(T('stock.sweep_q', 'Write off all expired stock?'), T('stock.sweep_body', 'Every expired batch is set to zero and recorded in the stock ledger as an expiry write-off.'), T('stock.sweep', 'Write off expired stock'), true))) return;
    const r = await api.post('/api/pharmacy/stock/expire-sweep');
    toast(T('stock.swept', '{n} expired batches written off', { n: r.expired.length }), 'ok'); MC.render();
  });
  on('stk-receive', async el => receiveDialog(el.dataset.item));
  async function receiveDialog(itemId) {
    const [items, sups] = await Promise.all([api.get('/api/pharmacy/items'), getSuppliers()]);
    const r = await dialog({ title: T('stock.receive', 'Receive stock'), form: true,
      body: html`<div class="field"><label for="rc-i">${T('stock.item', 'Item')}</label><select class="input" id="rc-i" name="itemId" required>${items.map(i => opt(i.id, i.name, i.id === itemId))}</select></div>
        <div class="fields two"><div class="field"><label for="rc-b">${T('stock.batch_no', 'Batch number')}</label><input class="input" id="rc-b" name="batchNo" required maxlength="40" autocomplete="off"><div class="hint">${T('stock.batch_hint', 'Letters, numbers, dots, dashes and slashes, as printed on the pack.')}</div></div>
          <div class="field"><label for="rc-e">${T('stock.expiry', 'Expiry')}</label><input class="input" id="rc-e" name="expiry" type="date" min="${today()}" required></div></div>
        <div class="fields two"><div class="field"><label for="rc-q">${T('stock.qty', 'Quantity')}</label><input class="input" id="rc-q" name="qty" type="number" min="1" step="1" required inputmode="numeric"></div>
          <div class="field"><label for="rc-c">${T('stock.unit_cost', 'Unit cost (NGN, optional)')}</label><input class="input" id="rc-c" name="costKobo" type="number" min="0" step="0.01" data-kobo></div></div>
        <div class="field"><label for="rc-s">${T('stock.supplier', 'Supplier (optional)')}</label><select class="input" id="rc-s" name="supplierId">${opt('', T('stock.no_supplier', 'Not recorded'))}${sups.filter(s => s.active !== false).map(s => opt(s.id, s.name))}</select></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('stock.receive_go', 'Receive batch'), primary: true }],
      onSubmit: async d => {
        const it = items.find(x => x.id === d.itemId);
        if (!(await sure(T('stock.receive_q', 'Add {qty} of {name}?', { qty: d.qty || 0, name: it ? it.name : '' }), T('stock.receive_body', 'Batch {batch}, expiry {expiry}. This goes into stock now and is recorded in the ledger.', { batch: d.batchNo || '', expiry: d.expiry ? date(d.expiry) : '' }), T('stock.receive_go', 'Receive batch')))) return false;
        return api.post('/api/pharmacy/stock/receive', d);
      } });
    if (r) { toast(T('stock.received', 'Stock received'), 'ok'); MC.render(); }
  }
  on('stk-add', async () => {
    const fm = await api.get('/api/pharmacy/formulary');
    const r = await dialog({ title: T('stock.add_item', 'Add item'), form: true,
      body: html`<div class="field"><label for="ai-c">${T('stock.formulary', 'Drug from the formulary')}</label><select class="input" id="ai-c" name="drugCode">${opt('', T('stock.not_formulary', 'Not in the formulary (type a name below)'))}${fm.map(f => opt(f.code, f.name + (f.controlled ? ' (' + T('stock.controlled', 'Controlled') + ')' : '')))}</select><div class="hint">${T('stock.formulary_hint', 'A formulary drug fills in its name. Controlled drugs are always prescription only.')}</div></div>
        <div class="field"><label for="ai-n">${T('stock.name', 'Name (for items not in the formulary)')}</label><input class="input" id="ai-n" name="name" maxlength="120"></div>
        <div class="fields three"><div class="field"><label for="ai-f">${T('stock.form', 'Form')}</label><input class="input" id="ai-f" name="form" maxlength="40" placeholder="Tablet"></div><div class="field"><label for="ai-s">${T('stock.strength', 'Strength')}</label><input class="input" id="ai-s" name="strength" maxlength="40"></div><div class="field"><label for="ai-u">${T('stock.unit', 'Unit')}</label><input class="input" id="ai-u" name="unit" maxlength="40" placeholder="tablet"></div></div>
        <div class="fields two"><div class="field"><label for="ai-p">${T('stock.sell', 'Selling price per unit (NGN)')}</label><input class="input" id="ai-p" name="sellPriceKobo" type="number" min="0" step="0.01" data-kobo required></div><div class="field"><label for="ai-r">${T('stock.reorder', 'Reorder at')}</label><input class="input" id="ai-r" name="reorderLevel" type="number" min="0" step="1" value="0"></div></div>
        <label class="check"><input type="checkbox" name="rxOnly" checked><span>${T('stock.rx_only', 'Prescription only')}</span></label>
        <label class="check"><input type="checkbox" name="controlled"><span>${T('stock.controlled_check', 'Controlled drug (kept in the controlled register)')}</span></label>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('stock.add_go', 'Add item'), primary: true }],
      onSubmit: d => { if (!d.drugCode && !d.name) throw new MC.ApiError(400, { error: T('stock.need_name', 'Choose a formulary drug or type a name') }); if (d.sellPriceKobo == null) throw new MC.ApiError(400, { error: T('stock.need_price', 'Enter the selling price'), details: [{ field: 'sellPriceKobo', error: T('stock.need_price', 'Enter the selling price') }] }); return api.post('/api/pharmacy/items', d); } });
    if (r) { toast(T('stock.added', '{name} added', { name: r.name }), 'ok'); MC.go('#/stock/' + r.id); }
  });

  const ADJ = ['damaged', 'breakage', 'theft_loss', 'found', 'data_correction', 'sample', 'other'];
  const MOVE = { receive: 'Received', dispense: 'Dispensed', sale: 'Counter sale', adjust: 'Adjustment', count: 'Stock count', return_in: 'Returned by patient', return_supplier: 'Returned to supplier', recall: 'Recall', expire: 'Expiry write-off' };
  async function itemPage({ params, stale }) {
    const d = await api.get('/api/pharmacy/items/' + encodeURIComponent(params.id));
    if (stale()) return;
    const it = d.item; const canStock = has('pharmacy.stock'); const canD = has('pharmacy.dispense');
    const bNo = {}; d.batches.forEach(b => { bNo[b.id] = b.batchNo; });
    view(html`${back('#/stock', T('stock.title', 'Stock'))}
      <div class="page-head"><div><h1>${it.name}</h1><p>${it.drugCode || T('stock.not_formulary_short', 'Not in formulary')} ${it.rxOnly ? badge(T('stock.rx_only', 'Prescription only'), 'warn') : badge(T('stock.otc', 'Over the counter'), 'ok')} ${it.controlled ? badge(T('stock.controlled', 'Controlled'), 'bad') : ''} ${it.active === false ? badge(S('inactive'), 'outline') : ''}</p></div>
        <div class="actions">${canStock ? html`<button class="btn primary" data-action="stk-receive" data-item="${it.id}">${icon('plus')}${T('stock.receive', 'Receive stock')}</button><button class="btn" data-action="itm-edit">${icon('edit')}${T('stock.edit', 'Edit item')}</button>` : ''}</div></div>
      ${figures([{ value: it.onHand, label: T('stock.on_hand', 'On hand'), tone: it.outOfStock ? 'bad' : it.lowStock ? 'warn' : '' }, { value: it.reorderLevel, label: T('stock.reorder', 'Reorder at') }, { value: money(it.sellPriceKobo), label: T('stock.price', 'Price') }, { value: it.earliestExpiry ? date(it.earliestExpiry) : '-', label: T('stock.earliest', 'Earliest expiry') }])}
      <section class="panel flush"><h2>${T('stock.batches', 'Batches')}</h2>${d.batches.length ? html`<div class="table-wrap" style="border:0"><table class="t stack-sm"><thead><tr><th>${T('stock.batch', 'Batch')}</th><th>${T('stock.expiry', 'Expiry')}</th><th class="num">${T('stock.qty', 'Quantity')}</th><th class="num">${T('stock.cost', 'Unit cost')}</th><th>${T('bill.status', 'Status')}</th><th></th></tr></thead><tbody>
        ${d.batches.map(b => html`<tr><td data-label="${T('stock.batch', 'Batch')}"><b>${b.batchNo}</b><br><span class="xs muted">${T('stock.received_on', 'Received {when}', { when: date(b.receivedAt) })}</span></td><td data-label="${T('stock.expiry', 'Expiry')}">${date(b.expiry)}${b.nearExpiry && !b.expired ? html` ${badge(T('stock.days', '{n} days', { n: b.daysToExpiry }), 'warn')}` : ''}</td>
          <td class="num" data-label="${T('stock.qty', 'Quantity')}">${b.qty} <span class="xs muted">/ ${b.qtyReceived}</span></td><td class="num" data-label="${T('stock.cost', 'Unit cost')}">${b.costKobo ? money(b.costKobo) : '-'}</td>
          <td data-label="${T('bill.status', 'Status')}">${sBadge(b.expired && b.status === 'active' ? 'expired' : b.status)}${b.recalledAt ? html` ${badge(T('stock.recalled', 'Recalled'), 'bad')}` : ''}</td>
          <td><div class="ph-acts">${canStock && b.status === 'active' ? html`<button class="btn sm" data-action="bt-adjust" data-id="${b.id}">${T('stock.adjust', 'Adjust')}</button>` : ''}${canStock && b.status !== 'depleted' ? html`<button class="btn sm" data-action="bt-count" data-id="${b.id}">${T('stock.count', 'Count')}</button>` : ''}${canD && b.status === 'active' && !b.expired ? html`<button class="btn sm" data-action="bt-return-in" data-id="${b.id}">${T('stock.return_in', 'Patient return')}</button>` : ''}${canStock && b.qty > 0 ? html`<button class="btn sm" data-action="bt-return-sup" data-id="${b.id}">${T('stock.return_sup', 'Return to supplier')}</button>` : ''}${canStock && !b.recalledAt ? html`<button class="btn sm danger" data-action="bt-recall" data-id="${b.id}">${T('stock.recall', 'Recall')}</button>` : ''}</div></td></tr>`)}
        </tbody></table></div>` : empty({ icon: 'box', title: T('stock.no_batches', 'No batches yet'), body: T('stock.no_batches_sub', 'Receive stock to add the first batch.') })}</section>
      <section class="panel flush"><h2>${T('stock.ledger', 'Stock ledger (latest 50)')}</h2>${d.moves.length ? html`<div class="table-wrap" style="border:0"><table class="t stack-sm"><thead><tr><th>${T('stock.when', 'When')}</th><th>${T('stock.move', 'Movement')}</th><th>${T('stock.batch', 'Batch')}</th><th class="num">${T('stock.change', 'Change')}</th><th class="num">${T('stock.balance', 'Batch balance')}</th><th>${T('stock.reason', 'Reason')}</th><th>${T('stock.who', 'By')}</th></tr></thead><tbody>
        ${d.moves.map(m => html`<tr><td data-label="${T('stock.when', 'When')}">${dateTime(m.at)}</td><td data-label="${T('stock.move', 'Movement')}">${T('move.' + m.type, MOVE[m.type] || cap(m.type))}</td><td data-label="${T('stock.batch', 'Batch')}">${bNo[m.batchId] || ''}</td><td class="num" data-label="${T('stock.change', 'Change')}"><b>${m.qty > 0 ? '+' + m.qty : m.qty}</b></td><td class="num" data-label="${T('stock.balance', 'Batch balance')}">${m.balanceAfter == null ? '' : m.balanceAfter}</td><td data-label="${T('stock.reason', 'Reason')}">${m.reason ? MC.t('pharmacy.adj.' + m.reason, cap(m.reason)) : ''}${m.meta && m.meta.note ? ': ' + m.meta.note : ''}</td><td data-label="${T('stock.who', 'By')}">${m.byName || ''}</td></tr>`)}
        </tbody></table></div>` : empty({ icon: 'file', title: T('stock.no_moves', 'No movements yet') })}</section>`);
    const batch = id => d.batches.find(b => b.id === id);
    on('itm-edit', async () => {
      const r = await dialog({ title: T('stock.edit', 'Edit item'), form: true,
        body: html`<div class="field"><label for="ie-n">${T('stock.name_plain', 'Name')}</label><input class="input" id="ie-n" name="name" value="${it.name}" maxlength="120"></div>
          <div class="fields two"><div class="field"><label for="ie-p">${T('stock.sell', 'Selling price per unit (NGN)')}</label><input class="input" id="ie-p" name="sellPriceKobo" type="number" min="0" step="0.01" data-kobo value="${it.sellPriceKobo / 100}"></div><div class="field"><label for="ie-r">${T('stock.reorder', 'Reorder at')}</label><input class="input" id="ie-r" name="reorderLevel" type="number" min="0" step="1" value="${it.reorderLevel}"></div></div>
          <label class="check"><input type="checkbox" name="rxOnly" ${it.rxOnly ? 'checked' : ''} ${it.controlled ? 'disabled' : ''}><span>${T('stock.rx_only', 'Prescription only')}</span></label>
          <label class="check"><input type="checkbox" name="active" ${it.active !== false ? 'checked' : ''}><span>${T('stock.active', 'Active (can be sold and dispensed)')}</span></label>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('stock.save', 'Save changes'), primary: true }],
        onSubmit: async v => { if (v.sellPriceKobo !== it.sellPriceKobo && !(await sure(T('stock.price_q', 'Change the price to {price}?', { price: money(v.sellPriceKobo) }), T('stock.price_body', 'New bills use the new price. Bills already raised keep the old price.'), T('stock.save', 'Save changes')))) return false; return api.patch('/api/pharmacy/items/' + it.id, v); } });
      if (r) { toast(T('stock.saved', 'Item saved'), 'ok'); MC.render(); }
    });
    on('bt-adjust', async el => {
      const b = batch(el.dataset.id);
      const r = await dialog({ title: T('stock.adjust_t', 'Adjust batch {b}', { b: b.batchNo }), form: true,
        body: html`<p class="muted sm">${T('stock.adjust_sub', 'Now {n}. Use a minus number to remove units (for example -2).', { n: b.qty })}</p>
          <div class="field"><label for="ad-d">${T('stock.change', 'Change')}</label><input class="input" id="ad-d" name="delta" type="number" step="1" required inputmode="numeric"></div>
          <div class="field"><label for="ad-r">${T('stock.reason', 'Reason')}</label><select class="input" id="ad-r" name="reason">${ADJ.map(a => opt(a, MC.t('pharmacy.adj.' + a, cap(a))))}</select></div>
          <div class="field"><label for="ad-n">${T('stock.note', 'Note')}</label><input class="input" id="ad-n" name="note" maxlength="300"><div class="hint">${T('stock.note_hint', 'Needed when the reason is Other.')}</div></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('stock.adjust_go', 'Adjust stock'), primary: true }],
        onSubmit: async v => {
          if (!v.delta) throw new MC.ApiError(400, { error: T('stock.nonzero', 'Enter a change that is not zero'), details: [{ field: 'delta', error: T('stock.nonzero', 'Enter a change that is not zero') }] });
          if (!(await sure(T('stock.adjust_q', 'Change batch {b} by {d}?', { b: b.batchNo, d: v.delta > 0 ? '+' + v.delta : v.delta }), T('stock.adjust_body', 'The batch becomes {n}. This is recorded in the stock ledger with your name.', { n: b.qty + v.delta }), T('stock.adjust_go', 'Adjust stock'), v.delta < 0))) return false;
          return guard(() => api.post('/api/pharmacy/batches/' + b.id + '/adjust', v));
        } });
      if (r) { toast(T('stock.adjusted', 'Stock adjusted'), 'ok'); MC.render(); }
    });
    on('bt-count', async el => {
      const b = batch(el.dataset.id);
      const r = await dialog({ title: T('stock.count_t', 'Count batch {b}', { b: b.batchNo }), form: true,
        body: html`<p class="muted sm">${T('stock.count_sub', 'Count what is physically on the shelf. The system says {n}.', { n: b.qty })}</p><div class="field"><label for="ct-c">${T('stock.counted', 'Counted')}</label><input class="input" id="ct-c" name="counted" type="number" min="0" step="1" required inputmode="numeric"></div><div class="field"><label for="ct-n">${T('stock.note', 'Note')}</label><input class="input" id="ct-n" name="note" maxlength="300"></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('stock.count_go', 'Save count'), primary: true }],
        onSubmit: async v => {
          if (v.counted == null || v.counted < 0) throw new MC.ApiError(400, { error: T('stock.count_need', 'Enter the counted quantity'), details: [{ field: 'counted', error: T('stock.count_need', 'Enter the counted quantity') }] });
          if (!(await sure(T('stock.count_q', 'Set batch {b} to {n}?', { b: b.batchNo, n: v.counted }), T('stock.count_body', 'Difference: {v}. It is recorded in the ledger as a stock count.', { v: (v.counted - b.qty > 0 ? '+' : '') + (v.counted - b.qty) }), T('stock.count_go', 'Save count')))) return false;
          return guard(() => api.post('/api/pharmacy/batches/' + b.id + '/count', v));
        } });
      if (r) { toast(T('stock.counted_t', 'Count saved. Difference {v}.', { v: r.variance }), 'ok'); MC.render(); }
    });
    const qtyReason = (title, hint, go, url, msg, danger) => async el => {
      const b = batch(el.dataset.id);
      const r = await dialog({ title: title(b), form: true,
        body: html`<p class="muted sm">${hint(b)}</p><div class="field"><label for="qr-q">${T('stock.qty', 'Quantity')}</label><input class="input" id="qr-q" name="qty" type="number" min="1" step="1" required inputmode="numeric"></div><div class="field"><label for="qr-r">${T('stock.reason', 'Reason')}</label><input class="input" id="qr-r" name="reason" required maxlength="300"></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: go, primary: true }],
        onSubmit: async v => {
          if (!v.qty || !v.reason || v.reason.length < 3) throw new MC.ApiError(400, { error: T('stock.qr_need', 'Enter a quantity and a reason (at least 3 characters)') });
          if (!(await sure(go + '?', T('stock.qr_body', '{n} units of batch {b}. This is recorded in the stock ledger.', { n: v.qty, b: b.batchNo }), go, danger))) return false;
          return guard(() => api.post('/api/pharmacy/batches/' + b.id + url, v));
        } });
      if (r) { toast(msg(r), 'ok'); MC.render(); }
    };
    on('bt-return-in', qtyReason(b => T('stock.ri_t', 'Patient return to batch {b}', { b: b.batchNo }), () => T('stock.ri_hint', 'Only unopened, in-date medicines that were dispensed from this batch can go back on the shelf.'), T('stock.ri_go', 'Put back in stock'), '/return-in', () => T('stock.ri_done', 'Return added to stock')));
    on('bt-return-sup', qtyReason(b => T('stock.rs_t', 'Return batch {b} to supplier', { b: b.batchNo }), b => T('stock.rs_hint', '{n} in this batch.', { n: b.qty }), T('stock.rs_go', 'Return to supplier'), '/return-supplier', r => T('stock.rs_done', 'Returned. Credit due {c}.', { c: money(r.creditKobo || 0) }), true));
    on('bt-recall', async el => {
      const b = batch(el.dataset.id);
      const r = await dialog({ title: T('stock.recall_t', 'Recall batch {b}', { b: b.batchNo }), form: true,
        body: html`<div class="notice bad">${T('stock.recall_warn', 'All {n} units are quarantined straight away and cannot be sold or dispensed. A recall can only be raised once per batch.', { n: b.qty })}</div>
          <div class="field"><label for="rl-r">${T('stock.reason', 'Reason')}</label><textarea class="input" id="rl-r" name="reason" required maxlength="300"></textarea></div>
          <div class="field"><label for="rl-f">${T('stock.recall_ref', 'NAFDAC or manufacturer reference (optional)')}</label><input class="input" id="rl-f" name="reference" maxlength="80"></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('stock.recall_go', 'Recall batch'), primary: true, danger: true }],
        onSubmit: async v => {
          if (!v.reason || v.reason.trim().length < 5) throw new MC.ApiError(400, { error: T('verify.reason_short', 'At least 5 characters'), details: [{ field: 'reason', error: T('verify.reason_short', 'At least 5 characters') }] });
          if (!(await sure(T('stock.recall_q', 'Recall batch {b} now?', { b: b.batchNo }), T('stock.recall_body', 'This cannot be undone. Patients and sales that received this batch are listed for follow-up.'), T('stock.recall_go', 'Recall batch'), true))) return false;
          return guard(() => api.post('/api/pharmacy/batches/' + b.id + '/recall', v));
        } });
      if (r && r.recall) {
        await dialog({ title: T('stock.recalled_t', 'Batch {b} recalled', { b: b.batchNo }), body: html`<p>${T('stock.recalled_body', '{n} units quarantined. {o} prescription orders and {s} counter sales received this batch.', { n: r.recall.quarantinedQty, o: r.recall.affectedOrderIds.length, s: r.recall.affectedSaleIds.length })}</p>${r.recall.affectedOrderIds.length ? html`<ul class="list">${r.recall.affectedOrderIds.map(x => html`<a href="#/order/${x}"><span class="grow">${T('stock.affected_order', 'Prescription order')}</span>${icon('right')}</a>`)}</ul>` : ''}`, actions: [{ label: MC.t('kit.close', 'Close'), primary: true, value: true }] });
        MC.render();
      }
    });
  }

  /* recalls and expiry write-offs */
  const CLAIM_NEXT = { open: 'sent', sent: 'credited', credited: 'closed' };
  async function recallsPage() {
    const [rows, al, items] = await Promise.all([api.get('/api/pharmacy/recalls'), api.get('/api/pharmacy/alerts'), api.get('/api/pharmacy/items?includeInactive=true')]);
    const nm = {}; items.forEach(i => { nm[i.id] = i.name; });
    view(html`<div class="page-head"><div><h1>${T('recalls.title', 'Recalls and write-offs')}</h1><p>${T('recalls.sub', 'Recalled batches are quarantined. Track the supplier claim until it is closed.')}</p></div></div>
      <section class="panel"><h2>${T('recalls.expired', 'Expired stock')}</h2>${al.expired.length ? html`<ul class="list">${al.expired.map(x => html`<li><div class="grow"><a class="title" href="#/stock/${x.itemId}">${x.name}</a><span class="sub">${T('stock.batch', 'Batch')} ${x.batchNo} | ${date(x.expiry)}</span></div><span class="end">${x.qty}</span></li>`)}</ul>${has('pharmacy.stock') ? html`<div class="btn-row"><button class="btn danger" data-action="stk-sweep">${T('stock.sweep', 'Write off expired stock')}</button></div>` : ''}` : html`<p class="muted">${T('recalls.no_expired', 'No expired stock on the shelf.')}</p>`}</section>
      <section class="panel flush"><h2>${T('recalls.list', 'Recalls')}</h2>${rows.length ? html`<ul class="list">${rows.map(r => html`<li><div class="grow"><span class="title">${nm[r.itemId] || ''} | ${T('stock.batch', 'Batch')} ${r.batchNo}</span><span class="sub">${r.reason}${r.reference ? ' | ' + r.reference : ''}</span><span class="sub">${T('recalls.line', '{n} quarantined | {o} orders, {s} sales affected | {when}', { n: r.quarantinedQty, o: (r.affectedOrderIds || []).length, s: (r.affectedSaleIds || []).length, when: dateTime(r.at) })}</span></div>
        <span class="end">${sBadge(r.claimStatus)}${CLAIM_NEXT[r.claimStatus] && has('pharmacy.stock') ? html`<br><button class="btn sm" data-action="rc-claim" data-id="${r.id}" data-next="${CLAIM_NEXT[r.claimStatus]}">${T('recalls.mark_' + CLAIM_NEXT[r.claimStatus], { sent: 'Mark claim sent', credited: 'Mark credited', closed: 'Close claim' }[CLAIM_NEXT[r.claimStatus]])}</button>` : ''}</span></li>`)}</ul>` : empty({ icon: 'shield', title: T('recalls.none', 'No recalls'), body: T('recalls.none_sub', 'Recall a batch from its item page when NAFDAC or the manufacturer asks.') })}</section>`);
    on('rc-claim', async el => {
      const next = el.dataset.next;
      const r = await dialog({ title: T('recalls.claim_t', 'Update the supplier claim'), form: true, body: html`<p>${T('recalls.claim_body', 'Move the claim to: {s}. This cannot be moved back.', { s: S(next) })}</p><div class="field"><label for="cl-n">${T('stock.note', 'Note')}</label><input class="input" id="cl-n" name="note" maxlength="300"></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('recalls.save', 'Update claim'), primary: true }], onSubmit: v => guard(() => api.post('/api/pharmacy/recalls/' + el.dataset.id + '/claim', { claimStatus: next, note: v.note })) });
      if (r) { toast(T('recalls.saved', 'Claim updated'), 'ok'); MC.render(); }
    });
  }

  /* suppliers */
  async function suppliersPage() {
    suppliersCache = null;
    const rows = await getSuppliers();
    view(html`<div class="page-head"><div><h1>${T('sup.title', 'Suppliers')}</h1><p>${T('sup.sub', 'Who you buy stock from. Used on purchase orders and when receiving stock.')}</p></div><div class="actions">${has('pharmacy.stock') ? html`<button class="btn primary" data-action="sup-edit">${icon('plus')}${T('sup.add', 'Add supplier')}</button>` : ''}</div></div>
      ${rows.length ? html`<ul class="list">${rows.map(s => html`<li><div class="grow"><span class="title">${s.name} ${s.active === false ? badge(S('inactive'), 'outline') : ''}</span><span class="sub">${[s.contactName, s.phone, s.email].filter(Boolean).join(' | ')}</span>${s.address ? html`<span class="sub">${s.address}</span>` : ''}</div>${has('pharmacy.stock') ? html`<button class="btn sm" data-action="sup-edit" data-id="${s.id}">${T('sup.edit', 'Edit')}</button>` : ''}</li>`)}</ul>` : empty({ icon: 'building', title: T('sup.none', 'No suppliers yet'), body: T('sup.none_sub', 'Add your wholesalers and manufacturers.') })}`);
    on('sup-edit', async el => {
      const s = rows.find(x => x.id === el.dataset.id);
      const r = await dialog({ title: s ? s.name : T('sup.add', 'Add supplier'), form: true,
        body: html`<div class="field"><label for="su-n">${T('stock.name_plain', 'Name')}</label><input class="input" id="su-n" name="name" required maxlength="120" value="${s ? s.name : ''}"></div>
          <div class="fields two"><div class="field"><label for="su-c">${T('sup.contact', 'Contact person')}</label><input class="input" id="su-c" name="contactName" maxlength="100" value="${s && s.contactName || ''}"></div><div class="field"><label for="su-p">${T('sup.phone', 'Phone')}</label><input class="input" id="su-p" name="phone" inputmode="tel" value="${s && s.phone || ''}"></div></div>
          <div class="field"><label for="su-e">${T('sup.email', 'Email')}</label><input class="input" id="su-e" name="email" type="email" value="${s && s.email || ''}"></div>
          <div class="field"><label for="su-a">${T('sup.address', 'Address')}</label><input class="input" id="su-a" name="address" maxlength="300" value="${s && s.address || ''}"></div>
          ${s ? html`<label class="check"><input type="checkbox" name="active" ${s.active !== false ? 'checked' : ''}><span>${T('sup.active', 'Active')}</span></label>` : ''}`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: s ? T('stock.save', 'Save changes') : T('sup.add', 'Add supplier'), primary: true }],
        onSubmit: v => (s ? api.patch('/api/pharmacy/suppliers/' + s.id, v) : api.post('/api/pharmacy/suppliers', v)) });
      if (r) { toast(T('sup.saved', 'Supplier saved'), 'ok'); MC.render(); }
    });
  }

  /* purchase orders */
  const PO_TABS = ['all', 'draft', 'sent', 'partially_received', 'received', 'cancelled'];
  async function poListPage({ query }) {
    const st = PO_TABS.includes(query.s) ? query.s : 'all';
    const rows = await api.get('/api/pharmacy/purchase-orders' + qs({ status: st === 'all' ? '' : st }));
    view(html`<div class="page-head"><div><h1>${T('po.title', 'Purchase orders')}</h1><p>${T('po.sub', 'Draft, send to the supplier, then receive the lines into batches.')}</p></div><div class="actions">${has('pharmacy.stock') ? html`<button class="btn primary" data-action="po-new">${icon('plus')}${T('po.new', 'New purchase order')}</button>` : ''}</div></div>
      <div class="tabs">${PO_TABS.map(k => html`<a href="#/po?s=${k}" aria-selected="${k === st ? 'true' : 'false'}">${k === 'all' ? T('po.all', 'All') : S(k)}</a>`)}</div>
      ${rows.length ? html`<div class="list">${rows.map(p => html`<a href="#/po/${p.id}"><div class="grow"><span class="title">${p.number} | ${p.supplierName}</span><span class="sub">${p.lines.map(l => l.name).join(', ')}</span><span class="sub">${dateTime(p.createdAt)}</span></div><span class="end">${sBadge(p.status)}<br><span class="sm">${money(p.totalKobo)}</span></span></a>`)}</div>` : empty({ icon: 'file', title: T('po.none', 'No purchase orders'), body: T('po.none_sub', 'Create one when stock runs low.') })}`);
  }
  on('po-new', () => poLinesDialog(null));
  async function poLinesDialog(po) {
    const [items, sups] = await Promise.all([api.get('/api/pharmacy/items'), getSuppliers()]);
    const rows = (po ? po.lines.map(l => ({ itemId: l.itemId, qty: l.qty, costKobo: l.costKobo })) : []).concat(Array(Math.max(1, 5 - (po ? po.lines.length : 0))).fill({}));
    const r = await dialog({ title: po ? T('po.edit_t', 'Edit {n}', { n: po.number }) : T('po.new', 'New purchase order'), form: true, wide: true,
      body: html`${po ? '' : html`<div class="field"><label for="po-s">${T('po.supplier', 'Supplier')}</label><select class="input" id="po-s" name="supplierId" required>${sups.filter(s => s.active !== false).map(s => opt(s.id, s.name))}</select></div>`}
        <p class="muted sm">${T('po.lines_hint', 'Leave a row empty to skip it. Each item once.')}</p>
        ${rows.map((l, i) => html`<div class="fields three"><div class="field"><label for="pl-i${i}">${T('stock.item', 'Item')} ${i + 1}</label><select class="input" id="pl-i${i}" name="item_${i}">${opt('', T('po.no_item', 'None'))}${items.map(x => opt(x.id, x.name + ' (' + x.onHand + ')', x.id === l.itemId))}</select></div><div class="field"><label for="pl-q${i}">${T('stock.qty', 'Quantity')}</label><input class="input" id="pl-q${i}" name="qty_${i}" type="number" min="1" step="1" value="${l.qty || ''}"></div><div class="field"><label for="pl-c${i}">${T('stock.unit_cost', 'Unit cost (NGN, optional)')}</label><input class="input" id="pl-c${i}" name="cost_${i}" type="number" min="0" step="0.01" data-kobo value="${l.costKobo ? l.costKobo / 100 : ''}"></div></div>`)}
        <div class="field"><label for="po-n">${T('stock.note', 'Note')}</label><input class="input" id="po-n" name="note" maxlength="300" value="${po && po.note || ''}"></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: po ? T('stock.save', 'Save changes') : T('po.create', 'Save draft'), primary: true }],
      onSubmit: v => {
        const lines = rows.map((_, i) => ({ itemId: v['item_' + i], qty: v['qty_' + i], costKobo: v['cost_' + i] })).filter(l => l.itemId).map(l => Object.assign({ itemId: l.itemId, qty: l.qty }, l.costKobo != null ? { costKobo: l.costKobo } : {}));
        if (!lines.length) throw new MC.ApiError(400, { error: T('po.need_line', 'Add at least one item') });
        if (lines.some(l => !l.qty)) throw new MC.ApiError(400, { error: T('po.need_qty', 'Every chosen item needs a quantity') });
        return po ? guard(() => api.patch('/api/pharmacy/purchase-orders/' + po.id, { lines, note: v.note })) : api.post('/api/pharmacy/purchase-orders', { supplierId: v.supplierId, lines, note: v.note });
      } });
    if (r) { toast(T('po.saved', 'Purchase order saved'), 'ok'); if (po) MC.render(); else MC.go('#/po/' + r.id); }
  }
  async function poPage({ params, stale }) {
    const po = await api.get('/api/pharmacy/purchase-orders/' + encodeURIComponent(params.id));
    const sups = await getSuppliers(); if (stale()) return;
    const sup = sups.find(s => s.id === po.supplierId) || {};
    const canStock = has('pharmacy.stock');
    const outstanding = po.lines.filter(l => l.qty - (l.receivedQty || 0) > 0);
    view(html`${back('#/po', T('po.title', 'Purchase orders'))}
      <div class="page-head"><div><h1>${po.number}</h1><p>${sBadge(po.status)} ${sup.name || ''} | ${money(po.totalKobo)}</p></div>
        <div class="actions">${canStock && po.status === 'draft' ? html`<button class="btn" data-action="po-edit">${icon('edit')}${T('po.edit', 'Edit lines')}</button><button class="btn primary" data-action="po-send">${T('po.send', 'Mark sent to supplier')}</button>` : ''}
          ${canStock && ['sent', 'partially_received'].includes(po.status) && outstanding.length ? html`<button class="btn primary" data-action="po-receive">${icon('box')}${T('po.receive', 'Receive delivery')}</button>` : ''}
          ${canStock && ['draft', 'sent'].includes(po.status) ? html`<button class="btn" data-action="po-cancel">${icon('x')}${T('po.cancel', 'Cancel order')}</button>` : ''}</div></div>
      ${MC.steps(['draft', 'sent', 'partially_received', 'received'], po.status === 'cancelled' ? 'draft' : po.status, { draft: S('draft'), sent: S('sent'), partially_received: S('partially_received'), received: S('received') })}
      ${po.note ? html`<div class="notice">${po.note}</div>` : ''}
      <div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('stock.item', 'Item')}</th><th class="num">${T('po.ordered', 'Ordered')}</th><th class="num">${T('po.received_q', 'Received')}</th><th class="num">${T('stock.cost', 'Unit cost')}</th></tr></thead><tbody>
        ${po.lines.map(l => html`<tr><td data-label="${T('stock.item', 'Item')}"><a href="#/stock/${l.itemId}"><b>${l.name}</b></a></td><td class="num" data-label="${T('po.ordered', 'Ordered')}">${l.qty}</td><td class="num" data-label="${T('po.received_q', 'Received')}">${l.receivedQty || 0}</td><td class="num" data-label="${T('stock.cost', 'Unit cost')}">${l.costKobo ? money(l.costKobo) : '-'}</td></tr>`)}</tbody></table></div>
      ${(po.batches || []).length ? html`<section class="panel" style="margin-top:16px"><h2>${T('po.batches', 'Batches received')}</h2><ul class="list">${po.batches.map(b => html`<li><div class="grow"><span class="title">${(po.lines.find(l => l.itemId === b.itemId) || {}).name || ''}</span><span class="sub">${T('stock.batch', 'Batch')} ${b.batchNo} | ${T('stock.expiry', 'Expiry')} ${date(b.expiry)}</span></div><span class="end">${b.qtyReceived}</span></li>`)}</ul></section>` : ''}
      <section class="panel" style="margin-top:16px"><h2>${T('order.history', 'History')}</h2><ol class="timeline">${(po.timeline || []).map(x => html`<li><time>${dateTime(x.at)}</time><b>${S(x.status)}</b>${x.note ? html` <span class="muted">${x.note}</span>` : ''}</li>`)}</ol></section>`);
    on('po-edit', () => poLinesDialog(po));
    on('po-send', async () => { if (!(await sure(T('po.send_q', 'Mark {n} as sent?', { n: po.number }), T('po.send_body', 'After this the lines cannot be changed. Send the order to {s} by phone or email.', { s: sup.name || '' }), T('po.send', 'Mark sent to supplier')))) return; await guard(async () => { await api.post('/api/pharmacy/purchase-orders/' + po.id + '/send'); toast(T('po.sent', 'Purchase order sent'), 'ok'); MC.render(); }); });
    on('po-cancel', async () => {
      const r = await dialog({ title: T('po.cancel_q', 'Cancel {n}?', { n: po.number }), form: true, body: html`<div class="field"><label for="pc-r">${T('order.cancel_reason', 'Reason')}</label><input class="input" id="pc-r" name="reason" required maxlength="300"></div>`,
        actions: [{ label: T('po.keep', 'Keep order'), value: null }, { label: T('po.cancel', 'Cancel order'), primary: true }], onSubmit: v => { if (!v.reason || v.reason.length < 3) throw new MC.ApiError(400, { error: T('sale.reason3', 'Write a reason (at least 3 characters)') }); return guard(() => api.post('/api/pharmacy/purchase-orders/' + po.id + '/cancel', v)); } });
      if (r) { toast(T('po.cancelled', 'Purchase order cancelled'), 'ok'); MC.render(); }
    });
    on('po-receive', async () => {
      const r = await dialog({ title: T('po.receive_t', 'Receive delivery for {n}', { n: po.number }), form: true, wide: true,
        body: html`<p class="muted sm">${T('po.receive_hint', 'Enter the batch number and expiry printed on each pack. Leave the quantity empty for lines that did not arrive.')}</p>
          ${outstanding.map((l, i) => html`<fieldset class="panel" style="padding:12px"><legend><b>${l.name}</b> <span class="muted sm">${T('po.outstanding', '{n} outstanding', { n: l.qty - (l.receivedQty || 0) })}</span></legend><div class="fields three">
            <div class="field"><label for="pr-b${i}">${T('stock.batch_no', 'Batch number')}</label><input class="input" id="pr-b${i}" name="batch_${i}" maxlength="40" autocomplete="off"></div>
            <div class="field"><label for="pr-e${i}">${T('stock.expiry', 'Expiry')}</label><input class="input" id="pr-e${i}" name="exp_${i}" type="date" min="${today()}"></div>
            <div class="field"><label for="pr-q${i}">${T('stock.qty', 'Quantity')}</label><input class="input" id="pr-q${i}" name="qty_${i}" type="number" min="1" max="${l.qty - (l.receivedQty || 0)}" step="1" value="${l.qty - (l.receivedQty || 0)}"></div></div></fieldset>`)}`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('po.receive_go', 'Receive into stock'), primary: true }],
        onSubmit: async v => {
          const lines = outstanding.map((l, i) => ({ itemId: l.itemId, batchNo: v['batch_' + i], expiry: v['exp_' + i], qty: v['qty_' + i], costKobo: l.costKobo || undefined })).filter(x => x.qty);
          if (!lines.length) throw new MC.ApiError(400, { error: T('po.need_recv', 'Enter at least one line that arrived') });
          if (lines.some(x => !x.batchNo || !x.expiry)) throw new MC.ApiError(400, { error: T('po.need_batch', 'Each line that arrived needs a batch number and expiry') });
          if (!(await sure(T('po.receive_q', 'Receive {n} lines into stock?', { n: lines.length }), T('po.receive_body', '{u} units go into stock now as new batches and are recorded in the ledger.', { u: lines.reduce((s, x) => s + x.qty, 0) }), T('po.receive_go', 'Receive into stock')))) return false;
          return guard(() => api.post('/api/pharmacy/purchase-orders/' + po.id + '/receive', { lines }));
        } });
      if (r) { toast(T('po.received', 'Delivery received into stock'), 'ok'); MC.render(); }
    });
  }

  /* controlled-drug register */
  async function controlledPage({ query }) {
    const [rows, items] = await Promise.all([api.get('/api/pharmacy/controlled-register' + qs({ itemId: query.item, from: query.from, to: query.to, limit: 300 })), api.get('/api/pharmacy/items?includeInactive=true')]);
    const ctl = items.filter(i => i.controlled);
    view(html`<div class="page-head"><div><h1>${T('cd.title', 'Controlled drugs register')}</h1><p>${T('cd.sub', 'Every unit of a controlled drug that leaves the shelf, with the patient and the person who dispensed it.')}</p></div></div>
      <form data-form="cd-filter" class="ph-toolbar" novalidate><div class="field"><label for="cd-i">${T('stock.item', 'Item')}</label><select class="input" id="cd-i" name="item">${opt('', T('cd.all', 'All controlled drugs'))}${ctl.map(i => opt(i.id, i.name, i.id === query.item))}</select></div>
        <div class="field"><label for="cd-f">${T('cd.from', 'From')}</label><input class="input" id="cd-f" name="from" type="date" value="${query.from || ''}"></div><div class="field"><label for="cd-t">${T('cd.to', 'To')}</label><input class="input" id="cd-t" name="to" type="date" value="${query.to || ''}"></div><button class="btn" type="submit">${T('stock.filter', 'Show')}</button></form>
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('stock.when', 'When')}</th><th>${T('stock.item', 'Item')}</th><th>${T('stock.batch', 'Batch')}</th><th class="num">${T('stock.change', 'Change')}</th><th class="num">${T('stock.balance', 'Batch balance')}</th><th>${T('cd.patient', 'Patient')}</th><th>${T('stock.who', 'By')}</th></tr></thead><tbody>
        ${rows.map(r => html`<tr><td data-label="${T('stock.when', 'When')}">${dateTime(r.at)}</td><td data-label="${T('stock.item', 'Item')}"><b>${r.itemName}</b></td><td data-label="${T('stock.batch', 'Batch')}">${r.batchNo}</td><td class="num" data-label="${T('stock.change', 'Change')}">${r.qty}</td><td class="num" data-label="${T('stock.balance', 'Batch balance')}">${r.balanceAfter}</td><td data-label="${T('cd.patient', 'Patient')}">${r.patientName || '-'}${r.ref && r.ref.type === 'rx_order' ? html` <a href="#/order/${r.ref.id}">${T('cd.order', 'order')}</a>` : r.ref && r.ref.type === 'pharmacy_sale' ? html` <a href="#/sales/${r.ref.id}">${T('cd.sale', 'sale')}</a>` : ''}</td><td data-label="${T('stock.who', 'By')}">${r.byName}</td></tr>`)}
        </tbody></table></div>` : empty({ icon: 'shield', title: T('cd.none', 'No entries'), body: T('cd.none_sub', 'Entries appear when controlled drugs are dispensed or sold.') })}`);
    form('cd-filter', d => MC.go('#/controlled' + qs({ item: d.item, from: d.from, to: d.to })));
  }

  /* reports */
  async function reportsPage({ query }) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(query.date || '') ? query.date : today();
    const [val, ds] = await Promise.all([api.get('/api/pharmacy/reports/valuation'), api.get('/api/pharmacy/reports/daily-sales?date=' + day)]);
    const tt = val.totals;
    const methods = Object.entries(ds.byMethod || {});
    view(html`<div class="page-head"><div><h1>${T('rep.title', 'Reports')}</h1><p>${T('rep.sub', 'Stock value and daily sales.')}</p></div><div class="actions"><button class="btn" data-action="rep-print">${icon('download')}${T('rep.print', 'Print')}</button></div></div>
      <section><h2>${T('rep.daily', 'Daily sales')}</h2>
        <form data-form="rep-day" class="ph-toolbar" novalidate><div class="field" style="max-width:240px"><label for="rd-d">${T('rep.date', 'Date')}</label><input class="input" id="rd-d" name="date" type="date" value="${day}" max="${today()}"></div><button class="btn" type="submit">${T('stock.filter', 'Show')}</button></form>
        ${figures([{ value: money(ds.totalKobo), label: T('rep.total', 'Collected') }, { value: ds.bills, label: T('rep.bills', 'Bills paid') }, { value: money(ds.hmoCoveredKobo), label: T('rep.hmo', 'HMO covered') }, { value: money(ds.deliveryFeesKobo), label: T('rep.fees', 'Delivery fees') }, { value: ds.unitsOut, label: T('rep.units', 'Units out') }])}
        <div class="grid two"><section class="panel"><h3>${T('rep.by_source', 'By source')}</h3><dl class="kv"><dt>${T('rep.rx', 'Prescriptions')}</dt><dd>${money(((ds.bySource || {}).rx_order || {}).totalKobo || 0)} (${((ds.bySource || {}).rx_order || {}).count || 0})</dd><dt>${T('rep.counter', 'Counter sales')}</dt><dd>${money(((ds.bySource || {}).pharmacy_sale || {}).totalKobo || 0)} (${((ds.bySource || {}).pharmacy_sale || {}).count || 0})</dd></dl>
          <h3 style="margin-top:16px">${T('rep.by_method', 'By payment method')}</h3>${methods.length ? html`<dl class="kv">${methods.map(([k, v]) => html`<dt>${MC.t('pharmacy.bill.m_' + k, cap(k))}</dt><dd>${money(v)}</dd>`)}</dl>` : html`<p class="muted">${T('rep.no_pay', 'No payments on this day.')}</p>`}</section>
          <section class="panel"><h3>${T('rep.top', 'Top items')}</h3>${(ds.topItems || []).length ? html`<ul class="list">${ds.topItems.map(x => html`<li><div class="grow"><span class="title">${x.name}</span><span class="sub">${x.qty}</span></div><span class="end">${money(x.totalKobo)}</span></li>`)}</ul>` : html`<p class="muted">${T('rep.no_items', 'Nothing sold on this day.')}</p>`}</section></div></section>
      <section style="margin-top:24px"><h2>${T('rep.valuation', 'Stock valuation')}</h2><p class="muted sm">${T('rep.as_of', 'As of {when}', { when: dateTime(val.asOf) })}</p>
        ${figures([{ value: tt.units, label: T('rep.units_on', 'Units in stock') }, { value: money(tt.costKobo), label: T('rep.cost', 'At cost') }, { value: money(tt.sellKobo), label: T('rep.sell', 'At selling price') }, { value: money(tt.marginKobo), label: T('rep.margin', 'Expected margin') }, { value: money(tt.quarantinedCostKobo), label: T('rep.quar', 'Quarantined, at cost'), tone: tt.quarantinedCostKobo ? 'warn' : '' }, { value: money(tt.expiredCostKobo), label: T('rep.expired', 'Expired, at cost'), tone: tt.expiredCostKobo ? 'bad' : '' }])}
        <div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('stock.item', 'Item')}</th><th class="num">${T('rep.units_on', 'Units in stock')}</th><th class="num">${T('rep.cost', 'At cost')}</th><th class="num">${T('rep.sell', 'At selling price')}</th><th class="num">${T('rep.quar', 'Quarantined, at cost')}</th></tr></thead><tbody>
          ${val.items.map(i => html`<tr><td data-label="${T('stock.item', 'Item')}"><a href="#/stock/${i.itemId}">${i.name}</a></td><td class="num" data-label="${T('rep.units_on', 'Units in stock')}">${i.units}</td><td class="num" data-label="${T('rep.cost', 'At cost')}">${money(i.costKobo)}</td><td class="num" data-label="${T('rep.sell', 'At selling price')}">${money(i.sellKobo)}</td><td class="num" data-label="${T('rep.quar', 'Quarantined, at cost')}">${i.quarantinedCostKobo ? money(i.quarantinedCostKobo) : '-'}</td></tr>`)}</tbody></table></div></section>`);
    form('rep-day', d => MC.go('#/reports' + qs({ date: d.date })));
  }
  on('rep-print', () => window.print());

  /* ================= deliveries (dispatcher) ================= */
  const DLV = ['pending', 'assigned', 'picked_up', 'failed', 'returned'];
  async function drawMap(el, points, center) {
    if (!el) return;
    try {
      const m = await MC.map(el, { center: center || (MC.me.org.location || undefined) });
      points.forEach(p => m.setMarker(p.key, p.pos, { label: p.label, kind: p.kind }));
      m.fit();
      return m;
    } catch (e) { el.hidden = true; return null; }
  }
  const locText = l => (l ? T('dlv.loc', '{lat}, {lng} | {when}', { lat: l.lat.toFixed(5), lng: l.lng.toFixed(5), when: ago(l.at) }) : T('dlv.no_loc', 'No location yet'));
  async function deliveriesPage() {
    view(html`<div class="page-head"><div><h1>${T('dlv.board', 'Deliveries')}</h1><p>${T('dlv.board_sub', 'Assign packed orders to riders on duty. Updates every 15 seconds.')}</p></div><div class="actions"><a class="btn" href="#/riders">${icon('users')}${T('dlv.riders', 'Riders')}</a></div></div><div id="dlv-body">${MC.skeleton(4)}</div>`);
    let sig = ''; let mapObj = null;
    const load = async () => {
      const [b, rows] = await Promise.all([api.get('/api/delivery/board'), api.get('/api/delivery/deliveries?active=true&limit=200')]);
      const s1 = JSON.stringify([b, rows.map(r => [r.id, r.status, r.updatedAt, r.locked, r.lastLoc && r.lastLoc.at])]);
      if (s1 === sig) return; sig = s1;
      const box = document.getElementById('dlv-body'); if (!box) return;
      if (mapObj) { try { mapObj.destroy(); } catch (e) { /* gone */ } mapObj = null; }
      const by = {}; DLV.forEach(k => { by[k] = rows.filter(r => r.status === k); });
      const ready = b.riders.filter(r => r.status === 'verified' && r.onDuty);
      const live = b.riders.filter(r => r.lastLoc);
      view(html`${figures([{ value: (b.counts || {}).pending || 0, label: T('dlv.f_pending', 'Waiting for a rider'), tone: (b.counts || {}).pending ? 'warn' : '' }, { value: (b.counts || {}).assigned || 0, label: T('dlv.f_assigned', 'Assigned') }, { value: (b.counts || {}).picked_up || 0, label: T('dlv.f_out', 'On the road') }, { value: ((b.counts || {}).failed || 0) + ((b.counts || {}).returned || 0), label: T('dlv.f_failed', 'Failed or returned'), tone: (b.counts || {}).failed ? 'bad' : '' }, { value: b.ridersOnDuty, label: T('dlv.f_riders', 'Riders ready') }, { value: b.lockedCount, label: T('dlv.f_locked', 'Code lockouts'), tone: b.lockedCount ? 'bad' : '' }])}
        ${b.selfClaim ? html`<div class="notice">${T('dlv.selfclaim', 'Riders can also claim waiting jobs themselves.')}</div>` : ''}
        ${!ready.length && by.pending.length ? html`<div class="notice warn">${T('dlv.no_ready', 'No verified rider is clocked in. Ask a rider to clock in, or verify a rider on the Riders page.')}</div>` : ''}
        <div class="grid side-r"><div>${DLV.map(k => html`<section class="panel flush"><h2>${S(k)} <span class="badge plain">${by[k].length}</span></h2>${by[k].length ? html`<ul class="list">${by[k].map(dRow)}</ul>` : html`<p class="muted" style="padding:0 16px 16px">${T('dlv.none_' + k, 'None')}</p>`}</section>`)}</div>
          <div><section class="panel"><h2>${T('dlv.map', 'Riders on the map')}</h2><div class="map" id="dlv-map" role="img" aria-label="${T('dlv.map_aria', 'Map of rider locations')}"></div>
            <ul class="list ph-map-list">${b.riders.filter(r => r.status === 'verified').map(r => html`<li><div class="grow"><span class="title">${r.name}</span><span class="sub">${r.onDuty ? T('dlv.on_duty', 'On duty') : T('dlv.off_duty', 'Off duty')} | ${T('dlv.jobs', '{n} active jobs', { n: r.activeJobs })}</span><span class="sub ph-pos">${locText(r.lastLoc)}</span></div>${r.lastLoc ? badge(r.lastLoc.fresh ? T('dlv.live', 'Live') : T('dlv.stale', 'Old'), r.lastLoc.fresh ? 'ok' : 'warn') : ''}</li>`)}</ul></section></div></div>`, box);
      mapObj = await drawMap(document.getElementById('dlv-map'), live.map(r => ({ key: 'r' + r.membershipId, pos: r.lastLoc, label: r.name, kind: 'rider' })).concat(rows.filter(d => d.location && ['assigned', 'picked_up'].includes(d.status)).map(d => ({ key: 'd' + d.id, pos: d.location, label: d.patient ? d.patient.firstName + ' ' + d.patient.lastInitial + '.' : '', kind: 'patient' }))).concat(MC.me.org.location ? [{ key: 'org', pos: MC.me.org.location, label: MC.me.org.name, kind: 'hospital' }] : []));
      MC.navCount('#/deliveries', by.pending.length + by.failed.length + b.lockedCount);
      board = b;
    };
    await load();
    MC.poll(load, 15000);
  }
  let board = null;
  function dRow(d) {
    return html`<li><div class="grow"><a class="title" href="#/deliveries/${d.id}">${d.patient ? d.patient.firstName + ' ' + d.patient.lastInitial + '.' : T('dlv.patient', 'Patient')}</a><span class="sub">${d.address || ''}</span>
      <span class="sub">${d.rider ? T('dlv.with', 'Rider: {name}', { name: d.rider.name }) + ' | ' : ''}${ago(d.updatedAt)}${d.attempts > 1 ? ' | ' + T('dlv.attempt', 'Attempt {n}', { n: d.attempts }) : ''}</span>
      ${d.locked ? badge(T('dlv.locked', 'Code locked'), 'bad') : ''}${d.status === 'picked_up' && d.lastLoc ? badge(d.lastLoc.fresh ? T('dlv.live', 'Live') : T('dlv.stale', 'Old'), d.lastLoc.fresh ? 'ok' : 'warn') : ''}</div>
      <span class="end ph-acts">${dActions(d)}</span></li>`;
  }
  function dActions(d) {
    return html`${d.status === 'pending' ? html`<button class="btn sm primary" data-action="dl-assign" data-id="${d.id}">${T('dlv.assign', 'Assign rider')}</button>` : ''}
      ${d.status === 'assigned' ? html`<button class="btn sm" data-action="dl-assign" data-id="${d.id}">${T('dlv.reassign', 'Reassign')}</button><button class="btn sm" data-action="dl-unassign" data-id="${d.id}">${T('dlv.unassign', 'Unassign')}</button><button class="btn sm primary" data-action="dl-handover" data-id="${d.id}">${T('dlv.handover', 'Hand over to rider')}</button>` : ''}
      ${d.status === 'picked_up' && d.locked ? html`<button class="btn sm primary" data-action="dl-unlock" data-id="${d.id}">${icon('key')}${T('dlv.unlock', 'Reset delivery code')}</button>` : ''}
      ${d.status === 'failed' ? html`<button class="btn sm primary" data-action="dl-returned" data-id="${d.id}">${T('dlv.returned', 'Confirm returned')}</button>` : ''}
      ${d.status === 'returned' ? html`<button class="btn sm primary" data-action="dl-retry" data-id="${d.id}">${T('dlv.retry', 'Try again')}</button>` : ''}`;
  }
  on('dl-assign', async el => {
    const b = board || await api.get('/api/delivery/board');
    const riders = b.riders.filter(r => r.status !== 'no_profile');
    let pickedRider = null;
    await dialog({ title: T('dlv.assign', 'Assign rider'), body: riders.length ? html`<p class="muted sm">${T('dlv.assign_sub', 'Only verified riders who are clocked in can take a job.')}</p><div class="choice">${riders.map(r => { const ok = r.status === 'verified' && r.onDuty; return html`<button type="button" data-rider="${r.membershipId}" ${ok ? '' : 'disabled'}><span><b>${r.name}</b><br><span class="muted sm">${ok ? T('dlv.jobs', '{n} active jobs', { n: r.activeJobs }) + (r.vehicle ? ' | ' + MC.t('rider.vehicle.' + r.vehicle, cap(r.vehicle)) : '') : r.status !== 'verified' ? T('dlv.not_verified', 'Not verified') : T('dlv.off_duty', 'Off duty')}</span></span>${ok ? icon('right') : ''}</button>`; })}</div>` : empty({ icon: 'users', title: T('dlv.no_riders', 'No riders yet'), body: T('dlv.no_riders_sub', 'Your administrator adds riders as staff. Then set up their profiles on the Riders page.') }),
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }],
      onOpen: d => d.querySelectorAll('[data-rider]').forEach(x => x.addEventListener('click', () => { pickedRider = x.dataset.rider; d.dispatchEvent(new Event('cancel')); })) });
    if (!pickedRider) return;
    const r = b.riders.find(x => x.membershipId === pickedRider);
    await guard(async () => { await api.post('/api/delivery/deliveries/' + el.dataset.id + '/assign', { riderMembershipId: pickedRider }); toast(T('dlv.assigned', 'Assigned to {name}', { name: r ? r.name : '' }), 'ok'); MC.render(); });
  });
  const dSimple = (name, path, q, body, ok, done, danger) => on(name, async el => {
    if (!(await sure(q, body, ok, danger))) return;
    await guard(async () => { await api.post('/api/delivery/deliveries/' + el.dataset.id + path); toast(done, 'ok'); MC.render(); });
  });
  dSimple('dl-unassign', '/unassign', T('dlv.unassign_q', 'Take this job off the rider?'), T('dlv.unassign_body', 'The job goes back to waiting for a rider.'), T('dlv.unassign', 'Unassign'), T('dlv.unassigned', 'Job unassigned'));
  dSimple('dl-handover', '/handover', T('dlv.handover_q', 'Hand the package to the rider?'), T('dlv.handover_body', 'The order goes out for delivery and the patient gets an SMS with the delivery code.'), T('dlv.handover', 'Hand over to rider'), T('dlv.handed', 'Handed over to the rider'));
  dSimple('dl-unlock', '/unlock', T('dlv.unlock_q', 'Reset the delivery code?'), T('dlv.unlock_body', 'Call the patient first. A new code is sent to the patient by SMS and in the app; the old code stops working.'), T('dlv.unlock', 'Reset delivery code'), T('dlv.unlocked', 'New delivery code sent to the patient'));
  dSimple('dl-returned', '/returned', T('dlv.returned_q', 'Confirm the package is back?'), T('dlv.returned_body', 'The order goes back to ready so it can be delivered again or collected.'), T('dlv.returned', 'Confirm returned'), T('dlv.returned_done', 'Package returned to the pharmacy'));
  dSimple('dl-retry', '/retry', T('dlv.retry_q', 'Send this delivery again?'), T('dlv.retry_body', 'The job goes back to waiting for a rider as a new attempt.'), T('dlv.retry', 'Try again'), T('dlv.retried', 'Delivery is waiting for a rider again'));

  async function deliveryPage({ params, stale }) {
    const d = await api.get('/api/delivery/deliveries/' + encodeURIComponent(params.id));
    if (stale()) return;
    const steps = ['pending', 'assigned', 'picked_up', 'delivered'];
    const labels = {}; steps.forEach(k => { labels[k] = S(k); });
    view(html`${back('#/deliveries', T('dlv.board', 'Deliveries'))}
      <div class="page-head"><div><h1>${T('dlv.title_one', 'Delivery to {name}', { name: d.patient ? d.patient.firstName + ' ' + d.patient.lastInitial + '.' : '' })}</h1><p>${sBadge(d.status)} ${d.locked ? badge(T('dlv.locked', 'Code locked'), 'bad') : ''} ${T('dlv.created', 'Created {when}', { when: dateTime(d.createdAt) })}</p></div><div class="actions">${dActions(d)}</div></div>
      ${['failed', 'returned', 'cancelled'].includes(d.status) ? html`<div class="notice ${d.status === 'cancelled' ? '' : 'bad'}"><b>${S(d.status)}.</b> ${d.failReason ? MC.t('rider.fail.' + d.failReason, cap(d.failReason)) : ''}${d.failNote ? ': ' + d.failNote : ''}</div>` : MC.steps(steps, d.status, labels)}
      ${d.locked ? html`<div class="notice bad">${T('dlv.locked_body', 'The rider entered too many wrong codes. Call the patient to confirm they are there, then reset the code.')}</div>` : ''}
      <div class="grid two"><section class="panel"><h2>${T('dlv.details', 'Details')}</h2><dl class="kv">
          <dt>${T('dlv.patient', 'Patient')}</dt><dd>${d.patient ? d.patient.firstName + ' ' + d.patient.lastInitial + '.' : '-'}${d.patient && d.patient.phone ? html` | <a href="tel:${d.patient.phone}">${d.patient.phone}</a>` : ''}</dd>
          <dt>${T('order.address', 'Deliver to')}</dt><dd>${d.address || '-'}</dd>
          <dt>${T('dlv.rider', 'Rider')}</dt><dd>${d.rider ? html`${d.rider.name}${d.rider.phone ? html` | <a href="tel:${d.rider.phone}">${d.rider.phone}</a>` : ''}` : T('dlv.no_rider', 'Not assigned yet')}</dd>
          <dt>${T('dlv.code_tries', 'Wrong codes')}</dt><dd>${d.codeAttempts || 0}</dd>
          <dt>${T('dlv.attempts', 'Attempt')}</dt><dd>${d.attempts}</dd>
          <dt>${T('dlv.last_loc', 'Rider last seen')}</dt><dd class="ph-pos">${locText(d.lastLoc)} ${d.lastLoc ? badge(d.lastLoc.fresh ? T('dlv.live', 'Live') : T('dlv.stale', 'Old'), d.lastLoc.fresh ? 'ok' : 'warn') : ''}</dd></dl>
          ${d.rxOrderId && hasAny(R) ? html`<div class="btn-row"><a class="btn" href="#/order/${d.rxOrderId}">${icon('pill')}${T('dlv.open_order', 'Open order')}</a></div>` : ''}</section>
        <section class="panel"><h2>${T('dlv.map_one', 'Map')}</h2><div class="map" id="d-map" role="img" aria-label="${T('dlv.map_aria', 'Map of rider locations')}"></div><p class="sm muted" style="margin-top:8px">${T('dlv.map_legend', 'Amber: rider. Teal: patient. Blue: pharmacy.')}</p></section></div>
      <section class="panel"><h2>${T('order.history', 'History')}</h2><ol class="timeline">${(d.timeline || []).map(x => html`<li><time>${dateTime(x.at)}</time><b>${S(x.status)}</b>${x.note ? html` <span class="muted">${x.note}</span>` : ''}</li>`)}</ol></section>`);
    const m = await drawMap(document.getElementById('d-map'), [d.lastLoc ? { key: 'rider', pos: d.lastLoc, label: d.rider ? d.rider.name : T('dlv.rider', 'Rider'), kind: 'rider' } : null, d.location ? { key: 'dest', pos: d.location, label: T('order.address', 'Deliver to'), kind: 'patient' } : null, MC.me.org.location ? { key: 'org', pos: MC.me.org.location, label: MC.me.org.name, kind: 'hospital' } : null].filter(Boolean));
    if (['assigned', 'picked_up', 'pending', 'failed'].includes(d.status)) MC.poll(async () => {
      const n = await api.get('/api/delivery/deliveries/' + d.id);
      if (n.status !== d.status || n.locked !== d.locked) return MC.render();
      if (m && n.lastLoc) { m.setMarker('rider', n.lastLoc, { label: n.rider ? n.rider.name : '', kind: 'rider' }); }
      const el = document.querySelector('.kv .ph-pos'); if (el && n.lastLoc) el.textContent = locText(n.lastLoc);
    }, d.status === 'picked_up' ? 5000 : 15000);
  }

  const VEH = ['motorcycle', 'bicycle', 'car', 'van', 'tricycle', 'on_foot'];
  async function ridersPage() {
    const rows = await api.get('/api/delivery/riders');
    view(html`${back('#/deliveries', T('dlv.board', 'Deliveries'))}<div class="page-head"><div><h1>${T('rd.title', 'Riders')}</h1><p>${T('rd.sub', 'Only verified riders can be given jobs. Check the licence and vehicle before verifying.')}</p></div></div>
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('stock.name_plain', 'Name')}</th><th>${T('bill.status', 'Status')}</th><th>${T('rd.vehicle', 'Vehicle')}</th><th>${T('rd.plate', 'Plate')}</th><th>${T('rd.licence', 'Licence')}</th><th>${T('rd.duty', 'Duty')}</th><th>${T('dlv.last_loc', 'Rider last seen')}</th><th></th></tr></thead><tbody>
        ${rows.map(r => html`<tr><td data-label="${T('stock.name_plain', 'Name')}"><b>${r.name}</b>${r.phone ? html`<br><a class="sm" href="tel:${r.phone}">${r.phone}</a>` : ''}</td><td data-label="${T('bill.status', 'Status')}">${sBadge(r.status)}</td><td data-label="${T('rd.vehicle', 'Vehicle')}">${r.vehicle ? MC.t('rider.vehicle.' + r.vehicle, cap(r.vehicle)) : '-'}</td><td data-label="${T('rd.plate', 'Plate')}">${r.plate || '-'}</td><td data-label="${T('rd.licence', 'Licence')}">${r.licence || '-'}</td>
          <td data-label="${T('rd.duty', 'Duty')}">${r.onDuty ? badge(T('dlv.on_duty', 'On duty'), 'ok') : badge(T('dlv.off_duty', 'Off duty'), 'outline')} ${T('dlv.jobs', '{n} active jobs', { n: r.activeJobs })}</td><td data-label="${T('dlv.last_loc', 'Rider last seen')}" class="ph-pos">${locText(r.lastLoc)}</td>
          <td class="num"><button class="btn sm" data-action="rd-edit" data-id="${r.membershipId}">${r.profileId ? T('rd.manage', 'Manage') : T('rd.setup', 'Set up profile')}</button></td></tr>`)}</tbody></table></div>` : empty({ icon: 'users', title: T('dlv.no_riders', 'No riders yet'), body: T('dlv.no_riders_sub', 'Your administrator adds riders as staff. Then set up their profiles on the Riders page.') })}`);
    on('rd-edit', async el => {
      const r = rows.find(x => x.membershipId === el.dataset.id);
      const v = await dialog({ title: r.name, form: true,
        body: html`<div class="field"><label for="rd-v">${T('rd.vehicle', 'Vehicle')}</label><select class="input" id="rd-v" name="vehicle">${opt('', T('rd.choose', 'Choose'))}${VEH.map(x => opt(x, MC.t('rider.vehicle.' + x, cap(x)), x === r.vehicle))}</select></div>
          <div class="fields two"><div class="field"><label for="rd-p">${T('rd.plate', 'Plate')}</label><input class="input" id="rd-p" name="plate" maxlength="20" value="${r.plate || ''}"></div><div class="field"><label for="rd-l">${T('rd.licence', 'Licence')}</label><input class="input" id="rd-l" name="licence" maxlength="40" value="${r.licence || ''}"></div></div>
          <div class="field"><label for="rd-s">${T('bill.status', 'Status')}</label><select class="input" id="rd-s" name="status">${['pending', 'verified', 'suspended'].map(x => opt(x, S(x), x === (r.status === 'no_profile' ? 'pending' : r.status)))}</select><div class="hint">${T('rd.status_hint', 'Verifying needs a vehicle and a licence number. Suspended riders cannot take or finish jobs.')}</div></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('stock.save', 'Save changes'), primary: true }],
        onSubmit: async f => {
          const body = {}; ['vehicle', 'plate', 'licence', 'status'].forEach(k => { if (f[k] !== undefined && f[k] !== (r[k] || undefined)) body[k] = f[k]; });
          if (f.status !== r.status && f.status !== 'pending') { if (!(await sure(f.status === 'verified' ? T('rd.verify_q', 'Verify {name}?', { name: r.name }) : T('rd.suspend_q', 'Suspend {name}?', { name: r.name }), f.status === 'verified' ? T('rd.verify_body', 'Confirm you have checked the licence and the vehicle. They can then be given delivery jobs.') : T('rd.suspend_body', 'They cannot take or finish jobs until verified again.'), f.status === 'verified' ? T('rd.verify', 'Verify rider') : T('rd.suspend', 'Suspend rider'), f.status === 'suspended'))) return false; }
          if (!r.profileId) return api.post('/api/delivery/riders', Object.assign({ membershipId: r.membershipId }, body));
          if (!Object.keys(body).length) return true;
          return api.patch('/api/delivery/riders/' + r.profileId, body);
        } });
      if (v) { toast(T('rd.saved', 'Rider saved'), 'ok'); MC.render(); }
    });
  }

  /* ================= boot ================= */
  MC.boot({
    title: 'MediCore Pharmacy', subtitle: MC.t('pharmacy.login.sub', 'Prescriptions, stock and deliveries'), home: '#/queue',
    nav: [
      { href: '#/queue', label: MC.t('pharmacy.nav.queue', 'Prescriptions'), icon: 'pill', anyPerm: R },
      { href: '#/counter', label: MC.t('pharmacy.nav.counter', 'Counter sale'), short: MC.t('pharmacy.nav.counter_short', 'Counter'), icon: 'card', perm: 'pharmacy.dispense' },
      { href: '#/stock', label: MC.t('pharmacy.nav.stock', 'Stock'), icon: 'box', anyPerm: R },
      MC.referrals.navItem(),
      MC.whatsapp.navItem(),
      MC.caretools.nav.shares({ sideOnly: true }),
      { href: '#/deliveries', label: MC.t('pharmacy.nav.deliveries', 'Deliveries'), icon: 'truck', perm: 'delivery.dispatch', module: 'delivery', show: () => MC.feature('homeDelivery') },
      { href: '#/riders', label: MC.t('pharmacy.nav.riders', 'Riders'), icon: 'users', perm: 'delivery.dispatch', module: 'delivery' },
      { href: '#/po', label: MC.t('pharmacy.nav.po', 'Purchase orders'), short: MC.t('pharmacy.nav.po_short', 'Orders'), icon: 'file', anyPerm: R, sideOnly: true },
      { href: '#/suppliers', label: MC.t('pharmacy.nav.suppliers', 'Suppliers'), icon: 'building', anyPerm: R, sideOnly: true },
      { href: '#/recalls', label: MC.t('pharmacy.nav.recalls', 'Recalls and write-offs'), icon: 'shield', anyPerm: R, sideOnly: true },
      { href: '#/controlled', label: MC.t('pharmacy.nav.controlled', 'Controlled drugs'), icon: 'lock', anyPerm: ['pharmacy.verify', 'admin.reports'], sideOnly: true },
      { href: '#/reports', label: MC.t('pharmacy.nav.reports', 'Reports'), icon: 'chart', anyPerm: ['admin.reports', 'pharmacy.verify', 'pharmacy.stock'], sideOnly: true },
    ],
    routes: {
      '#/queue': queuePage, '#/order/:id': orderPage, '#/counter': counterPage, '#/sales/:id': salePage,
      '#/stock': stockPage, '#/stock/:id': itemPage, '#/recalls': recallsPage, '#/suppliers': suppliersPage, '#/po': poListPage, '#/po/:id': poPage,
      '#/controlled': controlledPage, '#/reports': reportsPage, '#/deliveries': deliveriesPage, '#/deliveries/:id': deliveryPage, '#/riders': ridersPage,
      ...MC.referrals.routes('#/referrals'),
      ...MC.whatsapp.routes('#/whatsapp'),
      ...MC.caretools.routes({ patientHref: () => '#/shared-care' }),
    },
    onReady: async me => {
      MC.referrals.refreshCount();
      MC.whatsapp.refreshCount();
      const pharm = (me.perms || []).some(p => R.includes(p));
      if (!pharm && (me.perms || []).includes('delivery.dispatch')) { const h = (location.hash || '').split('?')[0]; if (!h || h === '#/' || h === '#/queue' || !/^#\/(deliveries|riders)/.test(h)) history.replaceState(null, '', '#/deliveries'); }
    },
  });

})();
