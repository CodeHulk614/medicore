/* MediCore Group: the head office console for a hospital group with several branches.
 * Branches, staff in every branch, the consolidated subscription, shared price lists, referrals, audit and support. */
(function () {
  'use strict';
  const { html, api, qs, money, date, dateTime, ago, cap, icon, badge, statusBadge, empty, figures, view, on, form, dialog, confirm, toast } = MC;
  const has = p => !!(MC.me && (MC.me.perms || []).includes(p));
  const fail = (msg, field) => new MC.ApiError(400, { error: msg, details: field ? [{ field, error: msg }] : undefined });

  // the "More" tab is for phones only: on desktop every section is already in the sidebar
  (function () { const s = document.createElement('style'); s.textContent = '@media (min-width: 960px) { .side a[href="#/more"] { display: none; } } .kv.money { grid-template-columns: minmax(0, 1fr) auto; } .kv.money dd { text-align: right; white-space: nowrap; } .ct-adv { margin: 8px 0 4px; } .ct-adv summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; font-weight: 600; } .ct-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 8px; } .ct-head h2, .ct-head h3 { margin: 0; } .ct-prev .end { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; } .ct-prev .end .btn { white-space: nowrap; } .ct-prev li { flex-wrap: wrap; } .ct-prev li .end { width: 100%; max-width: none; justify-content: flex-start; } .ct-edit > summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 14px; border: 1px solid var(--line); border-radius: var(--r-sm); font-weight: 600; margin-top: 8px; } .ct-edit > summary::-webkit-details-marker { display: none; } .ct-edit[open] > summary { margin-bottom: 12px; } .ct-sum { margin-bottom: 4px; } .wrap-any { overflow-wrap: anywhere; } .tabs { overflow-x: auto; }'; document.head.appendChild(s); })();

  /* download a file from the API without leaving the page (same headers and cookie as MC.api) */
  async function downloadFile(path, fallbackName) {
    let r;
    try { r = await fetch(path, { credentials: 'same-origin', headers: { 'X-MC-App': MC.APP, 'X-MC-Lang': MC.lang } }); }
    catch (e) { throw new MC.ApiError(0, { error: MC.t('group.download.network', 'Could not reach MediCore. Check your connection and try again.'), code: 'network' }); }
    if (!r.ok) {
      let b = null; try { b = await r.json(); } catch (e) { b = null; }
      const err = new MC.ApiError(r.status, b || { error: MC.t('group.download.failed', 'The download did not work ({status}). Try again.', { status: r.status }) });
      if (r.status === 401) MC.emit('auth:required', err);
      throw err;
    }
    const blob = await r.blob();
    const cd = r.headers.get('Content-Disposition') || ''; const m = cd.match(/filename="?([^";]+)"?/);
    const name = (m && m[1]) || fallbackName;
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = name; a.hidden = true; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return { name, size: blob.size };
  }

  /* ---------------- contact numbers (head office and branches) ---------------- */
  const DEPT_ORDER = ['main', 'emergency', 'appointments', 'pharmacy', 'lab', 'billing', 'care', 'ambulance', 'records'];
  let ct = null; // state of the contacts editor on the current page
  const deptLabel = k => MC.t('group.contacts.dept.' + k, (ct && ct.departments && ct.departments[k]) || cap(k));
  function relevantDepts(modules, headOffice) {
    if (headOffice) return ['main', 'billing', 'care'];
    const m = modules || []; const want = ['main', 'billing'];
    if (m.includes('clinic')) want.push('appointments', 'records');
    if (m.includes('ambulance') || (m.includes('clinic') && m.includes('lab'))) want.push('emergency');
    if (m.includes('pharmacy')) want.push('pharmacy');
    if (m.includes('lab')) want.push('lab');
    if (m.includes('ambulance')) want.push('ambulance');
    return DEPT_ORDER.filter(k => want.includes(k));
  }
  function shownDepts() {
    const keys = new Set(relevantDepts(ct.modules, ct.headOffice).concat(Object.keys(ct.contacts || {}), ct.extra));
    return DEPT_ORDER.filter(k => keys.has(k) && ct.departments[k]);
  }
  function contactCard(k) {
    const e = (ct.contacts || {})[k] || null; const v = e || {}; const id = 'ct-' + k;
    const state = e ? (e.show === false ? badge(MC.t('group.contacts.hidden', 'Hidden from patients'), 'warn') : badge(MC.t('group.contacts.shown', 'Shown to patients'), 'ok')) : badge(MC.t('group.contacts.not_set', 'Not set up'), 'outline');
    const head = html`<div class="ct-head"><h3>${deptLabel(k)}</h3><span class="row wrap" style="gap:6px">${state}${e && e.automated ? badge(MC.t('group.contacts.automated', 'Chats come to the inbox'), 'hue') : ''}</span></div>`;
    const summary = () => html`<dl class="kv ct-sum"><dt>${MC.t('group.contacts.f.phone', 'Phone')}</dt><dd>${v.phone || '-'}</dd><dt>${MC.t('group.contacts.f.whatsapp', 'WhatsApp number')}</dt><dd>${v.whatsapp || '-'}</dd><dt>${MC.t('group.contacts.f.email', 'Email')}</dt><dd class="wrap-any">${v.email || '-'}</dd><dt>${MC.t('group.contacts.f.hours', 'Opening hours')}</dt><dd>${v.hours || '-'}</dd></dl>`;
    if (!ct.canEdit) {
      return html`<section class="panel" id="${id}">${head}${e ? summary() : html`<p class="muted sm">${MC.t('group.contacts.none_ro', 'No numbers for this department yet.')}</p>`}</section>`;
    }
    const frm = html`<form data-form="ct-save" data-dept="${k}" novalidate>
        <div class="fields two"><div class="field"><label for="${id}-p">${MC.t('group.contacts.f.phone', 'Phone')}</label><input class="input" id="${id}-p" name="phone" inputmode="tel" maxlength="20" autocomplete="off" placeholder="0803 123 4567" value="${v.phone || ''}"></div>
        <div class="field"><label for="${id}-w">${MC.t('group.contacts.f.whatsapp', 'WhatsApp number')}</label><input class="input" id="${id}-w" name="whatsapp" inputmode="tel" maxlength="20" autocomplete="off" placeholder="0803 123 4567" value="${v.whatsapp || ''}"><button type="button" class="btn sm ghost" data-action="ct-same" data-dept="${k}" style="margin-top:4px">${MC.t('group.contacts.same', 'Same as phone')}</button></div></div>
        <div class="fields two"><div class="field"><label for="${id}-e">${MC.t('group.contacts.f.email', 'Email')}</label><input class="input" id="${id}-e" name="email" type="email" maxlength="120" autocomplete="off" value="${v.email || ''}"></div>
        <div class="field"><label for="${id}-h">${MC.t('group.contacts.f.hours', 'Opening hours')}</label><input class="input" id="${id}-h" name="hours" maxlength="120" placeholder="${MC.t('group.contacts.f.hours_ph', 'e.g. Mon-Fri 8am-6pm, or 24 hours')}" value="${v.hours || ''}"></div></div>
        <label class="check"><input type="checkbox" name="show" ${v.show !== false ? 'checked' : ''}><span>${MC.t('group.contacts.f.show', 'Show to patients')}</span></label>
        <details class="ct-adv" ${v.waPhoneNumberId ? 'open' : ''}><summary>${MC.t('group.contacts.adv', 'Advanced: WhatsApp phone number ID')}</summary>
          <div class="field"><label for="${id}-id">${MC.t('group.contacts.f.wa_id', 'WhatsApp phone number ID')}</label><input class="input" id="${id}-id" name="waPhoneNumberId" inputmode="numeric" maxlength="30" autocomplete="off" value="${v.waPhoneNumberId || ''}"><div class="hint">${MC.t('group.contacts.f.wa_id_hint', 'From Meta, after this number is added to MediCore\'s WhatsApp Business account. With it, chats on this number arrive in your WhatsApp inbox.')}</div></div></details>
        <div class="form-err notice bad" hidden></div>
        <div class="btn-row"><button class="btn primary" type="submit">${MC.t('group.contacts.save', 'Save numbers')}</button>
          ${e ? html`<button type="button" class="btn" data-action="ct-remove" data-dept="${k}">${icon('trash')}${MC.t('group.contacts.remove', 'Remove department')}</button>` : ct.extra.includes(k) ? html`<button type="button" class="btn ghost" data-action="ct-drop" data-dept="${k}">${MC.t('group.contacts.drop', 'Do not add')}</button>` : ''}</div>
      </form>`;
    return html`<section class="panel" id="${id}">${head}
      ${e ? summary() : html`<p class="muted sm">${MC.t('group.contacts.not_set_sub', 'Patients do not see this department until you save a number for it.')}</p>`}
      ${e ? html`<details class="ct-edit"><summary>${icon('edit')}${MC.t('group.contacts.change', 'Change numbers')}</summary>${frm}</details>` : frm}</section>`;
  }
  function contactPreview() {
    const list = DEPT_ORDER.filter(k => ct.contacts[k] && ct.contacts[k].show !== false && (ct.contacts[k].callLink || ct.contacts[k].chatLink));
    return html`<section class="panel flush ct-prev"><h3 style="padding:16px 16px 0;margin:0">${MC.t('group.contacts.preview', 'How patients see it')}</h3>
      <p class="muted sm" style="padding:0 16px">${MC.t('group.contacts.preview_sub', 'This is the contact card in the patient app. Try the buttons to check each number.')}</p>
      ${list.length ? html`<ul class="list">${list.map(k => { const e = ct.contacts[k]; return html`<li><div class="grow"><span class="title">${deptLabel(k)}</span><span class="sub">${[e.phone, e.hours].filter(Boolean).join(' | ')}</span></div><span class="end">${e.callLink ? html`<a class="btn sm" href="${e.callLink}">${icon('phone')}${MC.t('group.contacts.call', 'Call')}</a>` : ''}${e.chatLink ? html`<a class="btn sm" href="${e.chatLink}" target="_blank" rel="noopener noreferrer">${icon('message')}${MC.t('group.contacts.chat', 'Chat on WhatsApp')}</a>` : ''}</span></li>`; })}</ul>`
        : html`<p class="muted sm" style="padding:0 16px 16px">${MC.t('group.contacts.preview_none', 'Patients see no numbers yet. Save a number and tick Show to patients.')}</p>`}</section>`;
  }
  function contactsBlock() {
    const rest = DEPT_ORDER.filter(k => ct.departments[k] && !shownDepts().includes(k));
    return html`${ct.whatsappApi ? html`<div class="notice ok">${MC.t('group.contacts.wa_on', 'Automated WhatsApp is connected. Numbers with a WhatsApp phone number ID send their chats to the WhatsApp inbox.')}</div>`
      : html`<div class="notice">${MC.t('group.contacts.wa_off', 'Automated WhatsApp is not connected yet. Patients can still tap Chat on WhatsApp to message your number on their phone.')}</div>`}
      ${ct.canEdit ? '' : html`<div class="notice">${MC.t('group.contacts.read_only', 'You can see these numbers. Your group role cannot change them.')}</div>`}
      <div class="grid side-r"><div>${shownDepts().map(contactCard)}
        ${ct.canEdit && rest.length ? html`<div class="btn-row" style="margin-bottom:16px"><button class="btn" data-action="ct-add">${icon('plus')}${MC.t('group.contacts.add', 'Add another department')}</button></div>` : ''}</div>
      <div>${contactPreview()}</div></div>`;
  }
  const paintContacts = () => { const box = document.getElementById('ct-box'); if (box) MC.view(contactsBlock(), box); };
  function wireContacts() {
    on('ct-same', el => { const f = el.closest('form'); if (!f) return; if (!f.elements.phone.value.trim()) { toast(MC.t('group.contacts.same_need', 'Enter the phone number first'), 'bad'); f.elements.phone.focus(); return; } f.elements.whatsapp.value = f.elements.phone.value; toast(MC.t('group.contacts.same_done', 'WhatsApp number set to the phone number')); });
    form('ct-save', async (f, el) => {
      const k = el.dataset.dept;
      if (!f.phone && !f.whatsapp) throw fail(MC.t('group.contacts.need_number', 'Enter a phone number or a WhatsApp number'), 'phone');
      if (f.waPhoneNumberId && !/^\d+$/.test(String(f.waPhoneNumberId).trim())) throw fail(MC.t('group.contacts.wa_id_bad', 'The WhatsApp phone number ID has digits only'), 'waPhoneNumberId');
      const entry = { show: !!f.show };
      ['phone', 'whatsapp', 'email', 'hours', 'waPhoneNumberId'].forEach(x => { if (f[x] != null && String(f[x]).trim()) entry[x] = String(f[x]).trim(); });
      const r = await api.patch(ct.url, { contacts: { [k]: entry } });
      ct.contacts = r[ct.resKey] || ct.contacts; ct.extra = ct.extra.filter(x => x !== k);
      paintContacts(); toast(MC.t('group.contacts.saved', '{dept} numbers saved for {place}', { dept: deptLabel(k), place: ct.place }), 'ok');
    });
    on('ct-remove', async el => {
      const k = el.dataset.dept;
      if (!(await confirm({ title: MC.t('group.contacts.remove_q', 'Remove {dept} at {place}?', { dept: deptLabel(k), place: ct.place }), body: MC.t('group.contacts.remove_body', 'Patients will no longer see these numbers in the app. You can add the department again later.'), ok: MC.t('group.contacts.remove', 'Remove department'), danger: true }))) return;
      const r = await api.patch(ct.url, { contacts: { [k]: null } });
      ct.contacts = r[ct.resKey] || {}; paintContacts(); toast(MC.t('group.contacts.removed', '{dept} removed at {place}', { dept: deptLabel(k), place: ct.place }), 'ok');
    });
    on('ct-drop', el => { ct.extra = ct.extra.filter(x => x !== el.dataset.dept); paintContacts(); });
    on('ct-add', async () => {
      const rest = DEPT_ORDER.filter(k => ct.departments[k] && !shownDepts().includes(k));
      const v = await dialog({ title: MC.t('group.contacts.add', 'Add another department'), form: true, body: html`<div class="field"><label for="ct-new">${MC.t('group.contacts.add_which', 'Department')}</label><select class="input" id="ct-new" name="dept">${rest.map(k => html`<option value="${k}">${deptLabel(k)}</option>`)}</select></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('group.contacts.add_submit', 'Add department'), primary: true }] });
      if (!v || !v.dept) return;
      ct.extra.push(v.dept); paintContacts();
      const card = document.getElementById('ct-' + v.dept); if (card) { card.scrollIntoView({ block: 'start' }); const i = card.querySelector('input'); if (i) i.focus({ preventScroll: true }); }
    });
  }
  /* sets up ct for the head office (branchId empty) or one branch */
  function contactsState(d, branchId) {
    const b = branchId ? d.branches.find(x => x.id === branchId) : null;
    if (branchId && !b) return null;
    return { departments: d.departments || {}, whatsappApi: !!d.whatsappApi, extra: [], headOffice: !b, modules: b ? b.modules : [], contacts: (b ? b.contacts : d.headOffice) || {},
      canEdit: b ? has('group.branches') : has('group.settings'), url: b ? '/api/group/branches/' + b.id + '/contacts' : '/api/group/contacts', resKey: b ? 'contacts' : 'headOffice',
      place: b ? b.name : MC.t('group.contacts.head_office', 'Head office') };
  }
  async function contactsPage({ query, stale }) {
    const d = await api.get('/api/group/contacts');
    if (stale()) return;
    const live = d.branches.filter(b => !['rejected', 'removed'].includes(b.status));
    const cur = query.branch && live.find(b => b.id === query.branch) ? query.branch : '';
    ct = contactsState(d, cur);
    view(html`<div class="page-head"><div><h1>${MC.t('group.contacts.title', 'Contact numbers')}</h1><p>${MC.t('group.contacts.sub', 'Phone and WhatsApp numbers patients see for the head office and each branch.')}</p></div></div>
      <nav class="tabs" aria-label="${MC.t('group.contacts.places', 'Head office and branches')}"><a href="#/contacts" ${!cur ? html`aria-current="page"` : ''}>${MC.t('group.contacts.head_office', 'Head office')}</a>${live.map(b => html`<a href="#/contacts?branch=${b.id}" ${b.id === cur ? html`aria-current="page"` : ''}>${b.name}</a>`)}</nav>
      <h2>${cur ? MC.t('group.contacts.of_branch', 'Numbers at {branch}', { branch: ct.place }) : MC.t('group.contacts.of_head', 'Head office numbers')}</h2>
      <p class="muted sm">${cur ? MC.t('group.contacts.branch_sub', 'Patients registered at this branch see these numbers first.') : MC.t('group.contacts.head_sub', 'Patients of every branch see these numbers for the group as a whole, for example for billing or complaints.')}</p>
      <div id="ct-box">${contactsBlock()}</div>`);
    wireContacts();
  }

  const TYPES = ['hospital', 'clinic', 'pharmacy', 'ambulance', 'lab', 'other'];
  const typeName = k => ({ hospital: MC.t('group.type.hospital', 'Hospital'), clinic: MC.t('group.type.clinic', 'Clinic or medical centre'), pharmacy: MC.t('group.type.pharmacy', 'Pharmacy'), ambulance: MC.t('group.type.ambulance', 'Ambulance service'), lab: MC.t('group.type.lab', 'Laboratory or diagnostics'), other: MC.t('group.type.other', 'Other health service') }[k] || cap(k));
  const modName = (meta, k) => MC.t('group.module.' + k, (meta && meta.modules && meta.modules[k] && meta.modules[k].label) || cap(k));
  let metaCache = null;
  const getMeta = async (fresh) => (metaCache && !fresh ? metaCache : (metaCache = await api.get('/api/group/branches')));
  const liveBranches = list => list.filter(b => !['rejected', 'removed'].includes(b.status));
  const optional = (o) => { const out = {}; Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') out[k] = v; }); return Object.keys(out).length ? out : undefined; };

  /* ---------------- overview ---------------- */
  async function overview({ query, stale }) {
    const days = [7, 30, 90].includes(Number(query.days)) ? Number(query.days) : 30;
    const canMoney = has('group.finance') || has('group.reports');
    const [ov, rev] = await Promise.all([api.get('/api/group/overview' + qs({ days })), has('group.reports') ? api.get('/api/group/reports/revenue' + qs({ days })).catch(() => null) : null]);
    if (stale()) return;
    const tt = ov.totals || {};
    const names = rev ? Object.fromEntries(rev.branches.map(b => [b.id, b.name])) : {};
    const byBranch = rev ? Object.entries(rev.byBranch || {}).sort((a, b) => b[1] - a[1]) : [];
    const maxB = Math.max(1, ...byBranch.map(x => x[1]));
    const byDay = rev ? (rev.byDay || []).slice(-14) : [];
    const maxD = Math.max(1, ...byDay.map(x => x.totalKobo));
    const n = ov.branches.length;
    const colB = MC.t('group.overview.col.branch', 'Branch'), colS = MC.t('group.overview.col.status', 'Status'), colP = MC.t('group.overview.col.patients', 'Patients'), colN = MC.t('group.overview.col.new', 'New'), colD = MC.t('group.overview.col.on_duty', 'Staff on duty'), colR = MC.t('group.overview.col.collected', 'Collected'), colO = MC.t('group.overview.col.outstanding', 'Outstanding'), colRef = MC.t('group.overview.col.referrals', 'Referrals in / out'), colA = MC.t('group.overview.col.applications', 'Applications');
    view(html`<div class="page-head"><div><h1>${ov.group.name}</h1><p>${n === 1 ? MC.t('group.overview.sub_one', 'Figures for your branch over the last {days} days', { days }) : MC.t('group.overview.sub', 'Figures across {n} branches over the last {days} days', { n, days })}</p></div>
      <div class="actions"><div class="seg" role="group" aria-label="${MC.t('group.overview.range', 'Date range')}">${[7, 30, 90].map(d => html`<button type="button" data-action="ov-days" data-d="${d}" aria-pressed="${d === days ? 'true' : 'false'}">${MC.t('group.overview.days', '{n} days', { n: d })}</button>`)}</div></div></div>
      ${figures([
        { value: tt.patients || 0, label: MC.t('group.overview.patients', 'Patients across branches') },
        { value: tt.newPatients || 0, label: MC.t('group.overview.new_patients', 'New in {days} days', { days }) },
        { value: (tt.onDuty || 0) + ' / ' + (tt.staffActive || 0), label: MC.t('group.overview.staff_on_duty', 'Staff on duty now') },
        canMoney ? { value: money(tt.revenueKobo || 0), label: MC.t('group.overview.collected', 'Collected, {days} days', { days }) } : null,
        canMoney ? { value: money(tt.outstandingKobo || 0), label: MC.t('group.overview.outstanding', 'Outstanding bills'), tone: tt.outstandingKobo ? 'warn' : '' } : null,
        { value: (tt.referralsIn || 0) + ' / ' + (tt.referralsOut || 0), label: MC.t('group.overview.referrals', 'Referrals in / out') },
        { value: tt.pendingApplications || 0, label: MC.t('group.overview.applications', 'Patient applications waiting'), tone: tt.pendingApplications ? 'warn' : '' },
      ].filter(Boolean))}
      <section class="panel flush"><h2>${MC.t('group.overview.per_branch', 'Each branch')}</h2>
      ${n ? html`<div class="table-wrap" style="border:0"><table class="t stack-sm"><thead><tr><th>${colB}</th><th>${colS}</th><th class="num">${colP}</th><th class="num">${colN}</th><th class="num">${colD}</th>${canMoney ? html`<th class="num">${colR}</th><th class="num">${colO}</th>` : ''}<th class="num">${colRef}</th><th class="num">${colA}</th></tr></thead><tbody>
        ${ov.branches.map(b => html`<tr><td data-label="${colB}"><a href="#/branches/${b.id}"><b>${b.name}</b></a>${b.area ? html`<br><span class="xs muted">${b.area}</span>` : ''}</td><td data-label="${colS}">${statusBadge(b.status)}</td><td class="num" data-label="${colP}">${b.patients}</td><td class="num" data-label="${colN}">${b.newPatients}</td><td class="num" data-label="${colD}">${b.onDuty} / ${b.staffActive}</td>${canMoney ? html`<td class="num" data-label="${colR}">${money(b.revenueKobo || 0)}</td><td class="num" data-label="${colO}">${money(b.outstandingKobo || 0)}</td>` : ''}<td class="num" data-label="${colRef}">${b.referralsIn} / ${b.referralsOut}</td><td class="num" data-label="${colA}">${b.pendingApplications ? badge(String(b.pendingApplications), 'warn') : '0'}</td></tr>`)}
      </tbody></table></div>` : empty({ icon: 'building', title: MC.t('group.overview.no_branches', 'No branches yet'), body: MC.t('group.overview.no_branches_sub', 'Add your first branch to see its figures here.'), action: has('group.branches') ? html`<a class="btn primary" href="#/branches">${MC.t('group.overview.go_branches', 'Go to branches')}</a>` : '' })}</section>
      ${rev ? html`<div class="grid two">
        <section class="panel"><h2>${MC.t('group.overview.by_branch', 'Collected per branch')}</h2>${byBranch.length ? html`<div class="bars">${byBranch.map(([id, k]) => html`<div class="bar"><span>${names[id] || ''}</span><div class="track"><div class="fill" style="width:${Math.round(k / maxB * 100)}%"></div></div><span class="v">${money(k)}</span></div>`)}</div>` : empty({ icon: 'chart', title: MC.t('group.overview.no_payments', 'No payments yet'), body: MC.t('group.overview.no_payments_sub', 'Paid bills from the last {days} days show here.', { days }) })}</section>
        <section class="panel"><h2>${MC.t('group.overview.by_day', 'Collected per day, all branches')}</h2>${byDay.length ? html`<div class="bars">${byDay.map(d => html`<div class="bar"><span>${date(Date.parse(d.date))}</span><div class="track"><div class="fill" style="width:${Math.round(d.totalKobo / maxD * 100)}%"></div></div><span class="v">${money(d.totalKobo)}</span></div>`)}</div>` : empty({ icon: 'chart', title: MC.t('group.overview.no_payments', 'No payments yet') })}</section>
      </div>` : ''}
      ${ov.subscription ? html`<section class="panel"><h2>${MC.t('group.overview.subscription', 'Subscription')}</h2><p>${MC.t('group.overview.sub_total', 'The group pays {total} a month for {n} branches.', { total: money(ov.subscription.monthlyKobo), n: ov.subscription.branchCount })}</p><a class="btn" href="#/subscription">${icon('card')}${MC.t('group.overview.see_sub', 'See the subscription')}</a></section>` : ''}`);
    on('ov-days', el => MC.go('#/?days=' + el.dataset.d));
  }

  /* ---------------- branches ---------------- */
  async function branches({ stale }) {
    const d = await getMeta(true);
    if (stale()) return;
    const list = d.branches;
    view(html`<div class="page-head"><div><h1>${MC.t('group.branches.title', 'Branches')}</h1><p>${list.length === 1 ? MC.t('group.branches.sub_one', '1 branch') : MC.t('group.branches.sub', '{n} branches', { n: list.length })}${d.quote ? ' | ' + MC.t('group.branches.sub_price', '{total} a month for the group', { total: money(d.quote.monthlyKobo) }) : ''}</p></div>
      ${has('group.branches') ? html`<div class="actions"><button class="btn primary" data-action="branch-add">${icon('plus')}${MC.t('group.branches.add', 'Add branch')}</button></div>` : ''}</div>
      ${list.length ? html`<div class="list">${list.map(b => html`<a href="#/branches/${b.id}"><div class="grow"><span class="title">${b.branchName}</span><span class="sub">${b.typeLabel}${b.location && (b.location.area || b.location.city) ? ' | ' + [b.location.area, b.location.city].filter(Boolean).join(', ') : ''} | ${MC.t('group.branches.apps_n', '{n} apps', { n: b.modules.length })} | ${MC.t('group.branches.code', 'Code {code}', { code: b.code })}</span></div><span class="end">${statusBadge(b.status)}</span>${icon('right')}</a>`)}</div>`
        : empty({ icon: 'building', title: MC.t('group.branches.empty', 'No branches yet'), body: MC.t('group.branches.empty_sub', 'Each branch is a full provider with its own staff, price list and apps.'), action: has('group.branches') ? html`<button class="btn primary" data-action="branch-add">${icon('plus')}${MC.t('group.branches.add', 'Add branch')}</button>` : '' })}`);
    on('branch-add', () => addBranch(d));
  }

  function appChecks(d, type, checked) {
    const mods = (d.allowedModules[type] || []);
    return html`${mods.map(m => { const meta = d.modules[m] || {}; return meta.always
      ? html`<label class="check"><input type="checkbox" checked disabled><span><b>${modName(d, m)}</b> <span class="muted sm">${MC.t('group.branches.always', '(always included)')}</span></span></label>`
      : html`<label class="check"><input type="checkbox" name="modules" data-list value="${m}" ${checked.includes(m) ? 'checked' : ''}><span><b>${modName(d, m)}</b><br><span class="muted sm">${meta.desc || ''}</span></span></label>`; })}`;
  }
  async function addBranch(d) {
    const first = d.branches[0];
    const type0 = first ? first.type : 'hospital';
    const defaults = t => (first && first.type === t ? first.modules : []);
    const r = await dialog({ title: MC.t('group.branches.add_title', 'Add a branch'), form: true, wide: true, body: html`
      <div class="fields two"><div class="field"><label for="nb-n">${MC.t('group.branches.f.name', 'Branch name')}</label><input class="input" id="nb-n" name="branchName" required maxlength="80" placeholder="${MC.t('group.branches.f.name_ph', 'e.g. Lekki')}"><div class="hint">${MC.t('group.branches.f.name_hint', 'Patients see {group} followed by this name.', { group: MC.me.group.name })}</div></div>
      <div class="field"><label for="nb-t">${MC.t('group.branches.f.type', 'Type of provider')}</label><select class="input" id="nb-t" name="type">${TYPES.filter(k => d.allowedModules[k]).map(k => html`<option value="${k}" ${k === type0 ? 'selected' : ''}>${typeName(k)}</option>`)}</select></div></div>
      <div class="field"><span class="label">${MC.t('group.branches.f.apps', 'Apps to switch on')}</span><div class="hint">${MC.t('group.branches.f.apps_hint', 'The branch pays only for the apps switched on. You can change them later.')}</div><div id="nb-apps">${appChecks(d, type0, defaults(type0))}</div></div>
      <div class="field"><label for="nb-s">${MC.t('group.branches.f.seats', 'Staff accounts (optional)')}</label><input class="input" id="nb-s" name="seats" type="number" min="1" max="2000" inputmode="numeric"><div class="hint">${MC.t('group.branches.f.seats_hint', 'Leave empty to use the number included in the package.')}</div></div>
      <h3>${MC.t('group.branches.f.contact', 'Contact and location')}</h3>
      <div class="fields two"><div class="field"><label for="nb-p">${MC.t('group.branches.f.phone', 'Phone')}</label><input class="input" id="nb-p" name="phone" required inputmode="tel" placeholder="0803 123 4567"></div><div class="field"><label for="nb-e">${MC.t('group.branches.f.email', 'Email (optional)')}</label><input class="input" id="nb-e" name="email" type="email" autocomplete="off"></div></div>
      <div class="field"><label for="nb-a">${MC.t('group.branches.f.address', 'Address')}</label><input class="input" id="nb-a" name="address" required maxlength="300"></div>
      <div class="fields three"><div class="field"><label for="nb-ar">${MC.t('group.branches.f.area', 'Area')}</label><input class="input" id="nb-ar" name="area" maxlength="80"></div><div class="field"><label for="nb-c">${MC.t('group.branches.f.city', 'City')}</label><input class="input" id="nb-c" name="city" maxlength="80"></div><div class="field"><label for="nb-st">${MC.t('group.branches.f.state', 'State')}</label><input class="input" id="nb-st" name="state" maxlength="80"></div></div>
      <h3>${MC.t('group.branches.f.admin', 'Branch administrator (optional)')}</h3>
      <p class="muted sm">${MC.t('group.branches.f.admin_hint', 'This person runs the branch in the admin app: its staff, settings and price list. Give an email or a phone number so they can sign in.')}</p>
      <div class="field"><label for="nb-an">${MC.t('group.branches.f.admin_name', 'Full name')}</label><input class="input" id="nb-an" name="adminName" maxlength="100" autocomplete="off"></div>
      <div class="fields two"><div class="field"><label for="nb-ae">${MC.t('group.branches.f.admin_email', 'Email')}</label><input class="input" id="nb-ae" name="adminEmail" type="email" autocomplete="off"></div><div class="field"><label for="nb-ap">${MC.t('group.branches.f.admin_phone', 'Phone')}</label><input class="input" id="nb-ap" name="adminPhone" inputmode="tel" autocomplete="off"></div></div>
      ${d.branches.length ? html`<div class="field"><label for="nb-cp">${MC.t('group.branches.f.copy', 'Start with the price list of')}</label><select class="input" id="nb-cp" name="copyFrom"><option value="">${MC.t('group.branches.f.copy_none', 'No price list, I will add prices later')}</option>${liveBranches(d.branches).map(b => html`<option value="${b.id}">${b.branchName}</option>`)}</select></div>` : ''}`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('group.branches.add_submit', 'Add branch'), primary: true }],
      onOpen: dlg => { const sel = dlg.querySelector('#nb-t'); sel.addEventListener('change', () => MC.view(appChecks(d, sel.value, defaults(sel.value)), dlg.querySelector('#nb-apps'))); },
      onSubmit: f => {
        if (!f.branchName) throw fail(MC.t('group.branches.need_name', 'Enter the branch name'), 'branchName');
        if (!f.phone) throw fail(MC.t('group.branches.need_phone', 'Enter the branch phone number'), 'phone');
        if (!f.address) throw fail(MC.t('group.branches.need_address', 'Enter the branch address'), 'address');
        const always = (d.allowedModules[f.type] || []).filter(m => (d.modules[m] || {}).always);
        const body = { branchName: f.branchName, type: f.type, modules: always.concat(f.modules || []), contact: optional({ phone: f.phone, email: f.email, address: f.address }) };
        if (f.seats) body.seats = f.seats;
        const loc = optional({ area: f.area, city: f.city, state: f.state }); if (loc) body.location = loc;
        if (f.adminName || f.adminEmail || f.adminPhone) {
          if (!f.adminName) throw fail(MC.t('group.branches.need_admin_name', 'Enter the administrator\'s name'), 'adminName');
          if (!f.adminEmail && !f.adminPhone) throw fail(MC.t('group.branches.need_admin_contact', 'Give the administrator an email or a phone number'), 'adminEmail');
          body.admin = optional({ name: f.adminName, email: f.adminEmail, phone: f.adminPhone });
        }
        if (f.copyFrom) body.copyServicesFrom = f.copyFrom;
        return api.post('/api/group/branches', body);
      } });
    if (!r) return;
    metaCache = null;
    const a = r.admin;
    await dialog({ title: MC.t('group.branches.added', '{name} branch added', { name: r.branch.branchName }), body: html`
      ${r.branch.status === 'pending' ? html`<div class="notice warn">${MC.t('group.branches.added_pending', 'The branch is waiting for MediCore approval. Patients cannot find it until then.')}</div>` : html`<p>${MC.t('group.branches.added_active', 'The branch is active. Staff you add can start using MediCore now.')}</p>`}
      ${a && a.tempPassword ? html`<p>${MC.t('group.branches.temp_give', 'Give this temporary password to {name} privately, in person or by phone. Do not send it by email or group chat. They will choose their own password when they first sign in.', { name: a.name })}</p><p class="notice"><b>${a.tempPassword}</b></p><p class="muted sm">${MC.t('group.branches.temp_once', 'It will not be shown again.')}</p>` : a ? html`<p>${MC.t('group.branches.admin_existing', '{name} already has a MediCore account and signs in with their existing password.', { name: a.name })}</p>` : ''}`,
      actions: [{ label: MC.t('group.done', 'Done'), primary: true, value: true }] });
    toast(MC.t('group.branches.added_toast', 'Branch added'), 'ok');
    MC.go('#/branches/' + r.branch.id);
  }

  async function branchView({ params, stale }) {
    const [b, d, cd] = await Promise.all([api.get('/api/group/branches/' + encodeURIComponent(params.id)), getMeta(), api.get('/api/group/contacts').catch(() => null)]);
    if (stale()) return;
    ct = cd ? contactsState(cd, b.id) : null;
    const canEdit = has('group.branches'); const canMoney = has('group.finance') || has('group.reports');
    const st = b.stats || {}; const s = b.settings || {}; const c = b.contact || {}; const l = b.location || {}; const set = b.settlement;
    const hasClinic = (b.modules || []).includes('clinic');
    // these two follow MediCore's setting (on) until the group chooses; only send them once chosen
    const hqDefault = k => (typeof s[k] === 'boolean' ? s[k] : true);
    const isOwner = MC.me.role === 'group_owner';
    view(html`<a class="back" href="#/branches">${icon('left')}${MC.t('group.branches.title', 'Branches')}</a>
      <div class="page-head"><div><h1>${b.branchName}</h1><p>${b.typeLabel} | ${MC.t('group.branches.code', 'Code {code}', { code: b.code })} | ${statusBadge(b.status)}</p></div>
        <div class="actions">${has('group.staff') ? html`<a class="btn" href="#/staff?branch=${b.id}">${icon('users')}${MC.t('group.branch.staff', 'Staff')}</a>` : ''}${has('group.settings') ? html`<a class="btn" href="#/prices?branch=${b.id}">${icon('card')}${MC.t('group.branch.prices', 'Price list')}</a>` : ''}
        ${canEdit && b.status === 'active' ? html`<button class="btn" data-action="br-suspend">${icon('lock')}${MC.t('group.branch.suspend', 'Suspend branch')}</button>` : ''}
        ${canEdit && b.status === 'suspended' && b.suspendedBy === 'group' ? html`<button class="btn primary" data-action="br-reactivate">${icon('refresh')}${MC.t('group.branch.reactivate', 'Reactivate branch')}</button>` : ''}</div></div>
      ${b.status === 'suspended' ? html`<div class="notice bad">${b.suspendedBy === 'group' ? MC.t('group.branch.suspended_group', 'Your group suspended this branch. Reason: {reason}', { reason: b.statusReason || '-' }) : MC.t('group.branch.suspended_hq', 'MediCore suspended this branch. Contact MediCore support. Reason: {reason}', { reason: b.statusReason || '-' })}</div>` : ''}
      ${b.status === 'pending' ? html`<div class="notice warn">${MC.t('group.branch.pending', 'This branch is waiting for MediCore approval. Patients cannot find it until then.')}</div>` : ''}
      ${figures([
        { value: st.patients || 0, label: MC.t('group.branch.patients', 'Patients') },
        { value: st.newPatients || 0, label: MC.t('group.branch.new_30', 'New in 30 days') },
        { value: (st.onDuty || 0) + ' / ' + (st.staffActive || 0), label: MC.t('group.branch.on_duty', 'Staff on duty now') },
        canMoney ? { value: money(st.revenueKobo || 0), label: MC.t('group.branch.collected', 'Collected, 30 days') } : null,
        canMoney ? { value: money(st.outstandingKobo || 0), label: MC.t('group.branch.outstanding', 'Outstanding bills'), tone: st.outstandingKobo ? 'warn' : '' } : null,
        { value: (st.referralsIn || 0) + ' / ' + (st.referralsOut || 0), label: MC.t('group.branch.referrals', 'Referrals in / out') },
        { value: st.pendingApplications || 0, label: MC.t('group.branch.applications', 'Patient applications waiting'), tone: st.pendingApplications ? 'warn' : '' },
      ].filter(Boolean))}
      <div class="grid two">
      ${canEdit ? html`<form class="panel" data-form="br-save" novalidate><h2>${MC.t('group.branch.details', 'Contact and settings')}</h2>
        <div class="field"><label for="bs-n">${MC.t('group.branches.f.name', 'Branch name')}</label><input class="input" id="bs-n" name="branchName" required maxlength="80" value="${b.branchName}"></div>
        <div class="fields two"><div class="field"><label for="bs-p">${MC.t('group.branches.f.phone', 'Phone')}</label><input class="input" id="bs-p" name="phone" inputmode="tel" value="${c.phone || ''}"></div><div class="field"><label for="bs-e">${MC.t('group.branch.f.email', 'Email')}</label><input class="input" id="bs-e" name="email" type="email" value="${c.email || ''}"></div></div>
        <div class="field"><label for="bs-a">${MC.t('group.branches.f.address', 'Address')}</label><input class="input" id="bs-a" name="address" maxlength="300" value="${c.address || ''}"></div>
        <div class="fields three"><div class="field"><label for="bs-ar">${MC.t('group.branches.f.area', 'Area')}</label><input class="input" id="bs-ar" name="area" value="${l.area || ''}"></div><div class="field"><label for="bs-c">${MC.t('group.branches.f.city', 'City')}</label><input class="input" id="bs-c" name="city" value="${l.city || ''}"></div><div class="field"><label for="bs-st">${MC.t('group.branches.f.state', 'State')}</label><input class="input" id="bs-st" name="state" value="${l.state || ''}"></div></div>
        <div class="field"><label for="bs-h">${MC.t('group.branch.f.hours', 'Opening hours')}</label><input class="input" id="bs-h" name="openingHours" maxlength="120" value="${s.openingHours || ''}" placeholder="${MC.t('group.branch.f.hours_ph', 'e.g. Mon-Sat 08:00-18:00')}"></div>
        <label class="check"><input type="checkbox" name="acceptsWalkIns" ${s.acceptsWalkIns !== false ? 'checked' : ''}><span>${MC.t('group.branch.f.walk_ins', 'This branch accepts walk-in patients')}</span></label>
        <label class="check"><input type="checkbox" name="acceptsPatientApplications" ${s.acceptsPatientApplications !== false ? 'checked' : ''}><span>${MC.t('group.branch.f.applications', 'Let patients apply to register in the app')}</span></label>
        <label class="check"><input type="checkbox" name="requireClockIn" ${s.requireClockIn !== false ? 'checked' : ''}><span>${MC.t('group.branch.f.clock_in', 'Staff must clock in before they can work on cases')}</span></label>
        <label class="check"><input type="checkbox" name="networkListed" ${s.networkListed !== false ? 'checked' : ''}><span>${MC.t('group.branch.f.network', 'List this branch in the provider network')}</span></label>
        <h3 style="margin-top:20px">${MC.t('group.branch.f.patients', 'Patients and referrals')}</h3>
        ${hasClinic ? html`<label class="check"><input type="checkbox" name="acceptsOnlineBooking" ${s.acceptsOnlineBooking !== false ? 'checked' : ''}><span>${MC.t('group.branch.f.online_booking', 'Patients can book appointments in the app')}<br><span class="muted sm">${MC.t('group.branch.f.online_booking_hint', 'When off, patients are asked to call or come to the front desk to book.')}</span></span></label>` : ''}
        <label class="check"><input type="checkbox" name="applicationsNeedApproval" ${hqDefault('applicationsNeedApproval') ? 'checked' : ''}><span>${MC.t('group.branch.f.applications_approval', 'Patient applications need our approval')}<br><span class="muted sm">${MC.t('group.branch.f.applications_approval_hint', 'When off, patients who apply are registered straight away.')}</span></span></label>
        ${hasClinic && MC.feature('videoVisits') ? html`<label class="check"><input type="checkbox" name="payBeforeVideo" ${hqDefault('payBeforeVideo') ? 'checked' : ''}><span>${MC.t('group.branch.f.pay_before_video', 'Patients pay before a video visit')}<br><span class="muted sm">${MC.t('group.branch.f.pay_before_video_hint', 'When on, the patient cannot join the video call until the bill is paid.')}</span></span></label>` : ''}
        <label class="check"><input type="checkbox" name="acceptsReferrals" ${s.acceptsReferrals !== false ? 'checked' : ''}><span>${MC.t('group.branch.f.accepts_referrals', 'This branch accepts referrals from other providers')}</span></label>
        <label class="check"><input type="checkbox" name="referralsFromPartnersOnly" ${s.referralsFromPartnersOnly ? 'checked' : ''}><span>${MC.t('group.branch.f.partners_only', 'Accept referrals only from our partners')}<br><span class="muted sm">${MC.t('group.branch.f.partners_only_hint', 'Other providers must partner with this branch in the provider network before they can refer patients. Your other branches can always refer.')}</span></span></label>
        <div class="form-err notice bad" hidden></div><div class="btn-row"><button class="btn primary" type="submit">${MC.t('group.branch.save', 'Save branch details')}</button></div></form>`
      : html`<section class="panel"><h2>${MC.t('group.branch.details', 'Contact and settings')}</h2><dl class="kv"><dt>${MC.t('group.branches.f.phone', 'Phone')}</dt><dd>${c.phone || '-'}</dd><dt>${MC.t('group.branch.f.email', 'Email')}</dt><dd>${c.email || '-'}</dd><dt>${MC.t('group.branches.f.address', 'Address')}</dt><dd>${c.address || '-'}</dd><dt>${MC.t('group.branches.f.area', 'Area')}</dt><dd>${[l.area, l.city, l.state].filter(Boolean).join(', ') || '-'}</dd><dt>${MC.t('group.branch.f.hours', 'Opening hours')}</dt><dd>${s.openingHours || '-'}</dd></dl></section>`}
      <div>
        <section class="panel flush"><h2>${MC.t('group.branch.apps', 'Apps')}</h2><p class="muted sm" style="padding:0 16px">${MC.t('group.branch.apps_sub', 'This branch pays {price} a month for the apps switched on.', { price: money(b.quote.monthlyKobo) })}</p>
          <ul class="list">${(b.allowedModules || []).map(m => { const meta = d.modules[m] || {}; const onNow = b.modules.includes(m); return html`<li><div class="grow"><span class="title">${modName(d, m)} ${onNow ? badge(MC.t('group.branch.on', 'On'), 'ok') : badge(MC.t('group.branch.off', 'Off'), 'outline')}</span><span class="sub">${meta.desc || ''}</span></div><span class="end">${meta.always ? html`<span class="xs muted">${MC.t('group.branch.always', 'Always included')}</span>` : canEdit && b.status !== 'suspended' ? html`<button class="btn sm ${onNow ? '' : 'primary'}" data-action="br-mod" data-m="${m}" data-on="${onNow ? '1' : ''}">${onNow ? MC.t('group.branch.mod_off', 'Switch off') : MC.t('group.branch.mod_on', 'Add app')}</button>` : ''}</span></li>`; })}</ul></section>
        <section class="panel"><h2>${MC.t('group.branch.seats', 'Staff accounts')}</h2>
          <p>${MC.t('group.branch.seats_now', '{active} active staff. The subscription covers {seats} staff accounts.', { active: st.staffActive || 0, seats: b.quote.seats ? b.quote.seats.requested : ((b.subscription || {}).seats || '-') })}</p>
          ${canEdit ? html`<form data-form="br-seats" class="row wrap" novalidate><div class="field" style="margin:0;flex:1;min-width:140px"><label for="bs-seats">${MC.t('group.branch.seats_new', 'New number of staff accounts')}</label><input class="input" id="bs-seats" name="seats" type="number" min="1" max="2000" inputmode="numeric" required value="${(b.subscription || {}).seats || ''}"></div><button class="btn" type="submit" style="align-self:flex-end">${MC.t('group.branch.seats_save', 'Change staff accounts')}</button></form>` : ''}</section>
        ${has('group.finance') ? html`<section class="panel"><h2>${MC.t('group.branch.settlement', 'Settlement account')}</h2>
          <p class="muted sm">${MC.t('group.branch.settlement_sub', 'Online payments made at this branch are paid into this account.')}</p>
          ${set && (set.accountNumber || set.subaccount) ? html`<dl class="kv" style="margin-bottom:16px"><dt>${MC.t('group.settle.bank', 'Bank')}</dt><dd>${set.bankName || '-'}</dd><dt>${MC.t('group.settle.number', 'Account number')}</dt><dd>${set.accountNumber || '-'}</dd><dt>${MC.t('group.settle.name', 'Account name')}</dt><dd>${set.accountName || '-'}</dd><dt>${MC.t('group.settle.subaccount', 'Gateway subaccount')}</dt><dd>${set.subaccount || '-'}</dd></dl>` : html`<div class="notice">${MC.t('group.branch.no_settlement', 'No settlement account yet.')}</div>`}
          ${settlementForm('br-settle', set)}</section>` : ''}
      </div></div>
      <section style="margin-top:8px"><h2>${MC.t('group.branch.contacts', 'Contact numbers')}</h2><p class="muted sm">${MC.t('group.branch.contacts_sub', 'Phone and WhatsApp numbers patients see for {branch}.', { branch: b.branchName })}</p>
        ${ct ? html`<div id="ct-box">${contactsBlock()}</div>` : html`<div class="notice warn">${MC.t('group.branch.contacts_failed', 'The contact numbers could not load. Open Contact numbers from the menu to try again.')}</div>`}</section>
      ${isOwner ? html`<section class="panel"><h2>${MC.t('group.branch.export', 'Records of this branch')}</h2><p class="muted sm">${MC.t('group.branch.export_sub', 'Download everything {branch} holds on MediCore as a JSON file. Up to 5 downloads a day for the whole group.', { branch: b.branchName })}</p><button class="btn" data-action="br-export">${icon('download')}${MC.t('group.branch.export_do', 'Download this branch\'s records')}</button></section>` : ''}`);
    if (ct) wireContacts();
    on('br-export', () => exportRecords(b.id, b.branchName));

    form('br-save', async f => {
      if (!f.branchName) throw fail(MC.t('group.branches.need_name', 'Enter the branch name'), 'branchName');
      const body = { branchName: f.branchName, settings: { acceptsWalkIns: f.acceptsWalkIns, acceptsPatientApplications: f.acceptsPatientApplications, requireClockIn: f.requireClockIn, networkListed: f.networkListed, acceptsReferrals: f.acceptsReferrals, referralsFromPartnersOnly: f.referralsFromPartnersOnly } };
      if (f.acceptsOnlineBooking !== undefined) body.settings.acceptsOnlineBooking = f.acceptsOnlineBooking;
      ['applicationsNeedApproval', 'payBeforeVideo'].forEach(k => { if (f[k] !== undefined && (typeof s[k] === 'boolean' || f[k] !== hqDefault(k))) body.settings[k] = f[k]; });
      if (f.openingHours) body.settings.openingHours = f.openingHours;
      const ct = optional({ phone: f.phone, email: f.email, address: f.address }); if (ct) body.contact = ct;
      const loc = optional({ area: f.area, city: f.city, state: f.state }); if (loc) body.location = loc;
      await api.patch('/api/group/branches/' + b.id, body); metaCache = null;
      toast(MC.t('group.branch.saved', 'Branch details saved'), 'ok'); MC.render();
    });
    form('br-seats', async f => {
      if (!f.seats || f.seats < 1) throw fail(MC.t('group.branch.seats_need', 'Enter a number from 1 to 2000'), 'seats');
      if (!(await confirm({ title: MC.t('group.branch.seats_q', 'Change to {n} staff accounts?', { n: f.seats }), body: MC.t('group.branch.seats_body', 'The monthly price of {branch} is worked out again from the new number, and the group total changes with it.', { branch: b.branchName }), ok: MC.t('group.branch.seats_save', 'Change staff accounts') }))) return;
      await api.patch('/api/group/branches/' + b.id, { seats: f.seats });
      toast(MC.t('group.branch.seats_done', 'Staff accounts changed to {n}', { n: f.seats }), 'ok'); MC.render();
    });
    form('br-settle', async f => {
      const body = settlementBody(f);
      if (!(await confirm({ title: MC.t('group.settle.q', 'Save this settlement account?'), body: MC.t('group.settle.q_body', 'Online payments at {name} will be paid into this account from now on.', { name: b.branchName }), ok: MC.t('group.settle.save', 'Save settlement account') }))) return;
      await api.patch('/api/group/branches/' + b.id + '/settlement', body);
      toast(MC.t('group.settle.saved', 'Settlement account saved'), 'ok'); MC.render();
    });
    on('br-mod', el => toggleModule(b, d, el.dataset.m, !el.dataset.on));
    on('br-suspend', async () => {
      const v = await dialog({ title: MC.t('group.branch.suspend_q', 'Suspend {name}?', { name: b.branchName }), form: true, body: html`<p>${MC.t('group.branch.suspend_body', 'Everyone working at this branch is signed out now and cannot sign in until you reactivate it. Patients cannot book there in the meantime.')}</p>
        <div class="field"><label for="sp-r">${MC.t('group.branch.reason', 'Reason')}</label><textarea class="input" id="sp-r" name="reason" required maxlength="300"></textarea><div class="hint">${MC.t('group.branch.reason_hint', 'At least 5 characters. Branch staff see this reason.')}</div></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('group.branch.suspend', 'Suspend branch'), primary: true }],
        onSubmit: f => { if (!f.reason || f.reason.trim().length < 5) throw fail(MC.t('group.branch.reason_need', 'Give a reason of at least 5 characters'), 'reason'); return api.post('/api/group/branches/' + b.id + '/suspend', { reason: f.reason }); } });
      if (v) { metaCache = null; toast(MC.t('group.branch.suspended', 'Branch suspended'), 'ok'); MC.render(); }
    });
    on('br-reactivate', async () => {
      if (!(await confirm({ title: MC.t('group.branch.reactivate_q', 'Reactivate {name}?', { name: b.branchName }), body: MC.t('group.branch.reactivate_body', 'Staff can sign in again and patients can book at this branch.'), ok: MC.t('group.branch.reactivate', 'Reactivate branch') }))) return;
      await api.post('/api/group/branches/' + b.id + '/reactivate'); metaCache = null;
      toast(MC.t('group.branch.reactivated', 'Branch reactivated'), 'ok'); MC.render();
    });
  }
  function settlementForm(name, set) {
    return html`<form data-form="${name}" novalidate>
      <div class="fields two"><div class="field"><label for="${name}-b">${MC.t('group.settle.bank', 'Bank')}</label><input class="input" id="${name}-b" name="bankName" maxlength="80" value="${(set && set.bankName) || ''}"></div><div class="field"><label for="${name}-c">${MC.t('group.settle.code', 'Bank code (optional)')}</label><input class="input" id="${name}-c" name="bankCode" maxlength="12" value="${(set && set.bankCode) || ''}"></div></div>
      <div class="fields two"><div class="field"><label for="${name}-n">${MC.t('group.settle.number', 'Account number')}</label><input class="input" id="${name}-n" name="accountNumber" inputmode="numeric" maxlength="10" autocomplete="off" placeholder="${set && set.accountNumber ? set.accountNumber : '0123456789'}"><div class="hint">${set && set.accountNumber ? MC.t('group.settle.number_keep', '10 digits. Leave empty to keep {masked}.', { masked: set.accountNumber }) : MC.t('group.settle.number_hint', '10 digits (NUBAN)')}</div></div><div class="field"><label for="${name}-an">${MC.t('group.settle.name', 'Account name')}</label><input class="input" id="${name}-an" name="accountName" maxlength="120" value="${(set && set.accountName) || ''}"></div></div>
      <div class="field"><label for="${name}-s">${MC.t('group.settle.subaccount_opt', 'Gateway subaccount code (optional)')}</label><input class="input" id="${name}-s" name="subaccount" maxlength="80" value="${(set && set.subaccount) || ''}"><div class="hint">${MC.t('group.settle.subaccount_hint', 'From your Paystack, Flutterwave or Monnify dashboard, if you have one.')}</div></div>
      <div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${MC.t('group.settle.save', 'Save settlement account')}</button></form>`;
  }
  function settlementBody(f) {
    if (f.accountNumber && !/^\d{10}$/.test(f.accountNumber)) throw fail(MC.t('group.settle.number_bad', 'The account number must be exactly 10 digits'), 'accountNumber');
    if (f.bankCode && !/^[0-9A-Za-z]*$/.test(f.bankCode)) throw fail(MC.t('group.settle.code_bad', 'The bank code can only have letters and numbers'), 'bankCode');
    const body = optional({ bankName: f.bankName, bankCode: f.bankCode, accountNumber: f.accountNumber, accountName: f.accountName, subaccount: f.subaccount });
    if (!body) throw fail(MC.t('group.settle.empty', 'Fill in the account details first'));
    return body;
  }
  async function toggleModule(b, d, m, enable) {
    const url = '/api/group/branches/' + b.id + '/modules';
    const first = await api.post(url, { module: m, enabled: enable });
    if (!first.needsConfirm) { MC.render(); return; }
    const q = first.quote; const diff = q.monthlyKobo - (first.currentMonthlyKobo || 0);
    const app = modName(d, m);
    const ok = await dialog({ title: enable ? MC.t('group.branch.mod_add_q', 'Add {app} at {branch}?', { app, branch: b.branchName }) : MC.t('group.branch.mod_off_q', 'Switch off {app} at {branch}?', { app, branch: b.branchName }),
      body: html`<dl class="kv money"><dt>${MC.t('group.branch.mod_new_price', 'New price for this branch')}</dt><dd><b>${money(q.monthlyKobo)}</b> ${MC.t('group.branch.per_month', 'a month')}</dd><dt>${MC.t('group.branch.mod_change', 'Change')}</dt><dd>${(diff >= 0 ? '+' : '-') + money(Math.abs(diff))} ${MC.t('group.branch.per_month', 'a month')}</dd><dt>${MC.t('group.branch.mod_group_total', 'New group monthly total')}</dt><dd><b>${money(first.groupMonthlyKobo)}</b></dd></dl>
        <p class="muted sm" style="margin-top:12px">${enable ? MC.t('group.branch.mod_add_note', 'Staff at this branch can use the app straight away.') : MC.t('group.branch.mod_off_note', 'Staff at this branch lose access to the app straight away.')}</p>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: false }, { label: enable ? MC.t('group.branch.mod_on', 'Add app') : MC.t('group.branch.mod_off', 'Switch off'), value: true, primary: enable, danger: !enable }] });
    if (ok !== true) return;
    const r = await api.post(url, { module: m, enabled: enable, confirmPriceKobo: q.monthlyKobo });
    if (r.requested) toast(MC.t('group.branch.mod_requested', 'Request {ticket} sent to MediCore', { ticket: r.ticket }), 'ok');
    else toast(enable ? MC.t('group.branch.mod_added', '{app} added at {branch}', { app, branch: b.branchName }) : MC.t('group.branch.mod_removed', '{app} switched off at {branch}', { app, branch: b.branchName }), 'ok');
    metaCache = null; MC.render();
  }

  /* ---------------- staff in every branch ---------------- */
  async function staffPage({ query, stale }) {
    const d = await api.get('/api/group/staff' + qs({ branchId: query.branch, q: query.q, role: query.role }));
    if (stale()) return;
    const bName = Object.fromEntries(d.branches.map(b => [b.id, b.name]));
    const roles = {}; Object.values(d.rolesByBranch).forEach(rs => rs.forEach(r => { roles[r.key] = r.label; }));
    const usable = d.branches.filter(b => b.status === 'active' || b.status === 'pending');
    const cN = MC.t('group.staff.col.name', 'Name'), cB = MC.t('group.staff.col.branch', 'Branch'), cR = MC.t('group.staff.col.role', 'Role'), cS = MC.t('group.staff.col.signin', 'Sign in with'), cSt = MC.t('group.staff.col.status', 'Status'), cL = MC.t('group.staff.col.last', 'Last sign in');
    const filtered = query.branch || query.q || query.role;
    view(html`<div class="page-head"><div><h1>${MC.t('group.staff.title', 'Staff')}</h1><p>${d.staff.length === 1 ? MC.t('group.staff.sub_one', '1 person across your branches') : MC.t('group.staff.sub', '{n} people across your branches', { n: d.staff.length })}</p></div>
      ${usable.length ? html`<div class="actions"><button class="btn primary" data-action="gs-add">${icon('plus')}${MC.t('group.staff.add', 'Add staff')}</button></div>` : ''}</div>
      <form data-form="gs-filter" class="panel" novalidate><div class="fields three">
        <div class="field"><label for="gf-b">${MC.t('group.staff.f.branch', 'Branch')}</label><select class="input" id="gf-b" name="branch"><option value="">${MC.t('group.staff.all_branches', 'All branches')}</option>${d.branches.map(b => html`<option value="${b.id}" ${query.branch === b.id ? 'selected' : ''}>${b.name}</option>`)}</select></div>
        <div class="field"><label for="gf-r">${MC.t('group.staff.f.role', 'Role')}</label><select class="input" id="gf-r" name="role"><option value="">${MC.t('group.staff.all_roles', 'All roles')}</option>${Object.entries(roles).map(([k, l]) => html`<option value="${k}" ${query.role === k ? 'selected' : ''}>${l}</option>`)}</select></div>
        <div class="field"><label for="gf-q">${MC.t('group.staff.f.search', 'Search')}</label><input class="input" id="gf-q" name="q" type="search" maxlength="60" value="${query.q || ''}" placeholder="${MC.t('group.staff.f.search_ph', 'Name, email or phone')}"></div></div>
        <div class="row wrap"><button class="btn" type="submit">${icon('search')}${MC.t('group.staff.filter', 'Show staff')}</button>${filtered ? html`<a class="btn ghost" href="#/staff">${MC.t('group.staff.clear', 'Clear filters')}</a>` : ''}</div></form>
      ${d.staff.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${cN}</th><th>${cB}</th><th>${cR}</th><th>${cS}</th><th>${cSt}</th><th>${cL}</th><th></th></tr></thead><tbody>
        ${d.staff.map(s => html`<tr><td data-label="${cN}"><b>${s.name}</b>${s.isOwner ? html` ${badge(MC.t('group.staff.owner', 'Owner'), 'hue')}` : ''}${s.pendingPasswordChange ? html`<br><span class="xs muted">${MC.t('group.staff.no_password', 'Has not set a password yet')}</span>` : ''}</td><td data-label="${cB}">${s.branchName || bName[s.orgId] || ''}</td><td data-label="${cR}">${s.roleLabel}${s.title ? html`<br><span class="xs muted">${s.title}</span>` : ''}</td><td data-label="${cS}">${s.email || s.phone || ''}</td><td data-label="${cSt}">${statusBadge(s.status)}</td><td data-label="${cL}">${s.lastLoginAt ? ago(s.lastLoginAt) : MC.t('group.staff.never', 'Never')}</td>
          <td class="num">${s.isOwner || s.userId === MC.me.user.id ? '' : html`<button class="btn sm" data-action="gs-manage" data-id="${s.id}">${MC.t('group.staff.manage', 'Manage')}</button>`}</td></tr>`)}</tbody></table></div>`
        : empty({ icon: 'users', title: filtered ? MC.t('group.staff.none_match', 'Nobody matches these filters') : MC.t('group.staff.empty', 'No staff yet'), body: filtered ? MC.t('group.staff.none_match_sub', 'Change the filters or clear them to see everyone.') : MC.t('group.staff.empty_sub', 'Add the people who will use MediCore at your branches.') })}`);

    form('gs-filter', f => MC.go('#/staff' + qs({ branch: f.branch, role: f.role, q: f.q })));
    const roleOpts = (bid, sel) => html`${(d.rolesByBranch[bid] || []).map(r => html`<option value="${r.key}" ${r.key === sel ? 'selected' : ''}>${r.label}</option>`)}`;
    const wireRoles = (dlg, bSel, rSel) => { const b = dlg.querySelector(bSel), r = dlg.querySelector(rSel); b.addEventListener('change', () => { const keep = r.value; MC.view(roleOpts(b.value, keep), r); }); };
    on('gs-add', async () => {
      const b0 = (query.branch && usable.find(b => b.id === query.branch)) ? query.branch : usable[0].id;
      const r = await dialog({ title: MC.t('group.staff.add_title', 'Add a staff member'), form: true, body: html`
        <div class="field"><label for="ga-b">${MC.t('group.staff.f.branch', 'Branch')}</label><select class="input" id="ga-b" name="branchId">${usable.map(b => html`<option value="${b.id}" ${b.id === b0 ? 'selected' : ''}>${b.name}</option>`)}</select></div>
        <div class="field"><label for="ga-n">${MC.t('group.staff.f.name', 'Full name')}</label><input class="input" id="ga-n" name="name" required maxlength="100"></div>
        <div class="fields two"><div class="field"><label for="ga-e">${MC.t('group.staff.f.email', 'Email')}</label><input class="input" id="ga-e" name="email" type="email" autocomplete="off"></div><div class="field"><label for="ga-p">${MC.t('group.staff.f.phone', 'Phone')}</label><input class="input" id="ga-p" name="phone" inputmode="tel" placeholder="0803 123 4567"></div></div>
        <div class="field"><label for="ga-r">${MC.t('group.staff.f.role', 'Role')}</label><select class="input" id="ga-r" name="role" required>${roleOpts(b0)}</select><div class="hint">${MC.t('group.staff.f.role_hint', 'The role decides which app they use and what they can do. Roles depend on the apps the branch has.')}</div></div>
        <div class="field"><label for="ga-t">${MC.t('group.staff.f.title_opt', 'Job title (optional)')}</label><input class="input" id="ga-t" name="title" maxlength="60" placeholder="${MC.t('group.staff.f.title_ph', 'e.g. Senior nurse')}"></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('group.staff.add_submit', 'Add staff member'), primary: true }],
        onOpen: dlg => wireRoles(dlg, '#ga-b', '#ga-r'),
        onSubmit: v => { if (!v.name) throw fail(MC.t('group.staff.need_name', 'Enter the person\'s name'), 'name'); if (!v.email && !v.phone) throw fail(MC.t('group.staff.need_contact', 'Give an email or a phone number so the person can sign in'), 'email'); return api.post('/api/group/staff', v); } });
      if (!r) return;
      await tempPasswordDialog(r.member.name, r.tempPassword, MC.t('group.staff.added', '{name} added to {branch}', { name: r.member.name, branch: r.member.branchName }));
      toast(MC.t('group.staff.added_toast', 'Staff member added'), 'ok'); MC.render();
    });
    on('gs-manage', async el => {
      const s = d.staff.find(x => x.id === el.dataset.id); if (!s) return;
      const v = await dialog({ title: s.name, form: true, body: html`<p class="muted">${MC.t('group.staff.works_at', 'Works at {branch}', { branch: s.branchName || bName[s.orgId] || '' })}</p>
        <div class="field"><label for="gm-r">${MC.t('group.staff.f.role', 'Role')}</label><select class="input" id="gm-r" name="role">${roleOpts(s.orgId, s.role)}</select></div>
        <div class="field"><label for="gm-t">${MC.t('group.staff.f.title', 'Job title')}</label><input class="input" id="gm-t" name="title" maxlength="60" value="${s.title || ''}"></div>
        <div class="field"><label for="gm-s">${MC.t('group.staff.f.access', 'Access')}</label><select class="input" id="gm-s" name="status"><option value="active" ${s.status === 'active' ? 'selected' : ''}>${MC.t('group.staff.access.active', 'Active')}</option><option value="suspended" ${s.status === 'suspended' ? 'selected' : ''}>${MC.t('group.staff.access.suspended', 'Suspended (can be restored)')}</option><option value="removed">${MC.t('group.staff.access.removed', 'Removed')}</option></select><div class="hint">${MC.t('group.staff.f.access_hint', 'Suspending or removing signs them out straight away.')}</div></div>`,
        actions: [{ label: MC.t('group.staff.move', 'Move to another branch'), value: 'move' }, { label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('group.staff.save', 'Save changes'), primary: true }],
        onSubmit: async f => {
          const body = { title: f.title || '' };
          if (f.role && f.role !== s.role) body.role = f.role;
          if (f.status !== s.status) {
            if (f.status !== 'active' && !(await confirm({ title: f.status === 'removed' ? MC.t('group.staff.remove_q', 'Remove {name}?', { name: s.name }) : MC.t('group.staff.suspend_q', 'Suspend {name}?', { name: s.name }), body: MC.t('group.staff.signout_body', 'They will be signed out of every MediCore app at this branch now.'), ok: f.status === 'removed' ? MC.t('group.staff.remove', 'Remove') : MC.t('group.staff.suspend', 'Suspend'), danger: true }))) return false;
            body.status = f.status;
          }
          await api.patch('/api/group/staff/' + s.id, body); return true;
        } });
      if (v === 'move') return moveStaff(s, d, roleOpts);
      if (v) { toast(MC.t('group.staff.saved', 'Changes saved'), 'ok'); MC.render(); }
    });
  }
  async function moveStaff(s, d, roleOpts) {
    const targets = d.branches.filter(b => b.id !== s.orgId && (b.status === 'active' || b.status === 'pending'));
    if (!targets.length) { toast(MC.t('group.staff.move_none', 'There is no other branch to move them to'), 'bad'); return; }
    const t0 = targets[0].id;
    const r = await dialog({ title: MC.t('group.staff.move_title', 'Move {name}', { name: s.name }), form: true, body: html`<p>${MC.t('group.staff.move_body', '{name} will be signed out and any open shift will be closed. They keep the same sign-in details.', { name: s.name })}</p>
      <div class="field"><label for="mv-b">${MC.t('group.staff.move_to', 'Move to')}</label><select class="input" id="mv-b" name="moveToBranchId">${targets.map(b => html`<option value="${b.id}">${b.name}</option>`)}</select></div>
      <div class="field"><label for="mv-r">${MC.t('group.staff.move_role', 'Role at the new branch')}</label><select class="input" id="mv-r" name="role">${roleOpts(t0, s.role)}</select></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('group.staff.move_submit', 'Move staff member'), primary: true }],
      onOpen: dlg => { const b = dlg.querySelector('#mv-b'), rs = dlg.querySelector('#mv-r'); b.addEventListener('change', () => MC.view(roleOpts(b.value, s.role), rs)); },
      onSubmit: f => api.patch('/api/group/staff/' + s.id, { moveToBranchId: f.moveToBranchId, role: f.role }) });
    if (!r) return;
    toast(MC.t('group.staff.moved', '{name} moved to {branch}', { name: s.name, branch: r.branchName || '' }), 'ok'); MC.render();
  }
  async function tempPasswordDialog(name, temp, title) {
    await dialog({ title, body: temp ? html`<p>${MC.t('group.temp_give', 'Give this temporary password to {name} privately, in person or by phone. They will choose their own password when they first sign in.', { name })}</p><p class="notice"><b>${temp}</b></p><p class="muted sm">${MC.t('group.temp_once', 'It will not be shown again.')}</p>`
      : html`<p>${MC.t('group.existing_account', '{name} already has a MediCore account. They sign in with their existing password.', { name })}</p>`, actions: [{ label: MC.t('group.done', 'Done'), primary: true, value: true }] });
  }

  /* ---------------- group administrators ---------------- */
  const roleHint = k => ({ group_admin: MC.t('group.admins.hint.admin', 'Runs branches, staff, price lists, referrals, audit and support. No money.'), group_finance: MC.t('group.admins.hint.finance', 'Subscription, settlement accounts and reports.'), group_viewer: MC.t('group.admins.hint.viewer', 'Sees reports only. Cannot change anything.') }[k] || '');
  async function admins({ stale }) {
    const d = await api.get('/api/group/admins');
    if (stale()) return;
    view(html`<div class="page-head"><div><h1>${MC.t('group.admins.title', 'Group administrators')}</h1><p>${MC.t('group.admins.sub', 'People who use this group console. Branch staff are managed under Staff.')}</p></div><div class="actions"><button class="btn primary" data-action="ga-add">${icon('plus')}${MC.t('group.admins.add', 'Add administrator')}</button></div></div>
      <ul class="list">${d.admins.map(a => html`<li><div class="grow"><span class="title">${a.name} ${a.isOwner ? badge(MC.t('group.admins.owner', 'Owner'), 'hue') : ''}</span><span class="sub">${a.roleLabel || cap(a.role)} | ${a.email || a.phone || ''} | ${a.lastLoginAt ? MC.t('group.admins.last', 'Last signed in {when}', { when: ago(a.lastLoginAt) }) : MC.t('group.admins.never', 'Never signed in')}</span></div><span class="end">${statusBadge(a.status)}${a.isOwner || a.userId === MC.me.user.id ? '' : html`<br><button class="btn sm" data-action="ga-manage" data-id="${a.id}" style="margin-top:6px">${MC.t('group.admins.manage', 'Manage')}</button>`}</span></li>`)}</ul>`);
    const roleSel = (id, sel) => html`<select class="input" id="${id}" name="role">${d.roles.map(r => html`<option value="${r.key}" ${r.key === sel ? 'selected' : ''}>${MC.t('group.role.' + r.key, r.label)}</option>`)}</select><div class="hint">${d.roles.map(r => html`<div><b>${MC.t('group.role.' + r.key, r.label)}:</b> ${roleHint(r.key)}</div>`)}</div>`;
    on('ga-add', async () => {
      const r = await dialog({ title: MC.t('group.admins.add_title', 'Add a group administrator'), form: true, body: html`
        <div class="field"><label for="gd-n">${MC.t('group.admins.f.name', 'Full name')}</label><input class="input" id="gd-n" name="name" required maxlength="100"></div>
        <div class="fields two"><div class="field"><label for="gd-e">${MC.t('group.admins.f.email', 'Email')}</label><input class="input" id="gd-e" name="email" type="email" autocomplete="off"></div><div class="field"><label for="gd-p">${MC.t('group.admins.f.phone', 'Phone')}</label><input class="input" id="gd-p" name="phone" inputmode="tel"></div></div>
        <div class="field"><label for="gd-r">${MC.t('group.admins.f.role', 'Role')}</label>${roleSel('gd-r', 'group_admin')}</div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('group.admins.add_submit', 'Add administrator'), primary: true }],
        onSubmit: v => { if (!v.name) throw fail(MC.t('group.staff.need_name', 'Enter the person\'s name'), 'name'); if (!v.email && !v.phone) throw fail(MC.t('group.staff.need_contact', 'Give an email or a phone number so the person can sign in'), 'email'); return api.post('/api/group/admins', v); } });
      if (!r) return;
      await tempPasswordDialog(r.admin.name, r.tempPassword, MC.t('group.admins.added', '{name} added', { name: r.admin.name }));
      toast(MC.t('group.admins.added_toast', 'Administrator added'), 'ok'); MC.render();
    });
    on('ga-manage', async el => {
      const a = d.admins.find(x => x.id === el.dataset.id); if (!a) return;
      const v = await dialog({ title: a.name, form: true, body: html`<div class="field"><label for="gm-role">${MC.t('group.admins.f.role', 'Role')}</label>${roleSel('gm-role', a.role)}</div>
        <div class="field"><label for="gm-st">${MC.t('group.admins.f.access', 'Access')}</label><select class="input" id="gm-st" name="status"><option value="active" ${a.status === 'active' ? 'selected' : ''}>${MC.t('group.staff.access.active', 'Active')}</option><option value="suspended" ${a.status === 'suspended' ? 'selected' : ''}>${MC.t('group.staff.access.suspended', 'Suspended (can be restored)')}</option><option value="removed">${MC.t('group.staff.access.removed', 'Removed')}</option></select></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('group.staff.save', 'Save changes'), primary: true }],
        onSubmit: async f => {
          const body = {}; if (f.role !== a.role) body.role = f.role;
          if (f.status !== a.status) {
            if (f.status !== 'active' && !(await confirm({ title: f.status === 'removed' ? MC.t('group.admins.remove_q', 'Remove {name} from the group console?', { name: a.name }) : MC.t('group.admins.suspend_q', 'Suspend {name}?', { name: a.name }), body: MC.t('group.admins.signout_body', 'They are signed out of the group console now. Their work at any branch is not affected.'), ok: f.status === 'removed' ? MC.t('group.staff.remove', 'Remove') : MC.t('group.staff.suspend', 'Suspend'), danger: true }))) return false;
            body.status = f.status;
          }
          if (!Object.keys(body).length) return true;
          await api.patch('/api/group/admins/' + a.id, body); return true;
        } });
      if (v) { toast(MC.t('group.staff.saved', 'Changes saved'), 'ok'); MC.render(); }
    });
  }

  /* ---------------- subscription ---------------- */
  async function subscription({ stale }) {
    const [s, d] = await Promise.all([api.get('/api/group/subscription'), getMeta()]);
    if (stale()) return;
    const subSt = Object.fromEntries((s.statuses || []).map(x => [x.orgId, x.status]));
    const cB = MC.t('group.sub.col.branch', 'Branch'), cS = MC.t('group.sub.col.status', 'Status'), cA = MC.t('group.sub.col.apps', 'Apps'), cSe = MC.t('group.sub.col.seats', 'Staff accounts'), cM = MC.t('group.sub.col.monthly', 'Per month');
    view(html`<div class="page-head"><div><h1>${MC.t('group.sub.title', 'Subscription')}</h1><p>${MC.t('group.sub.sub', 'Each branch keeps its own package. The group pays for all of them in one bill.')}</p></div></div>
      ${figures([{ value: money(s.monthlyKobo), label: MC.t('group.sub.monthly', 'Group total per month') }, { value: String(s.branchCount), label: MC.t('group.sub.branches', 'Branches billed') }, { value: s.trialEnds ? date(s.trialEnds) : '-', label: MC.t('group.sub.trial_ends', 'Trial ends') }, { value: money(s.bankChargePerPaymentKobo), label: MC.t('group.sub.bank', 'Bank charge per payment') }])}
      <section class="panel flush"><h2>${MC.t('group.sub.lines', 'Branches')}</h2>
      <div class="table-wrap" style="border:0"><table class="t stack-sm"><thead><tr><th>${cB}</th><th>${cS}</th><th>${cA}</th><th class="num">${cSe}</th><th class="num">${cM}</th></tr></thead><tbody>
        ${s.branches.map(l => html`<tr><td data-label="${cB}"><a href="#/branches/${l.orgId}"><b>${l.name}</b></a></td><td data-label="${cS}">${statusBadge(l.status)}${subSt[l.orgId] && subSt[l.orgId] !== l.status ? html` ${statusBadge(subSt[l.orgId])}` : ''}</td><td data-label="${cA}">${l.modules.map(m => modName(d, m)).join(', ')}</td><td class="num" data-label="${cSe}">${l.seats}</td><td class="num" data-label="${cM}">${l.status === 'active' || l.status === 'pending' ? money(l.monthlyKobo) : html`<span class="muted">${MC.t('group.sub.not_billed', 'Not billed')}</span>`}</td></tr>`)}
      </tbody></table></div></section>
      <section class="panel"><h2>${MC.t('group.sub.breakdown', 'Price breakdown')}</h2>
        <dl class="kv money"><dt>${MC.t('group.sub.subtotal', 'All branches')}</dt><dd>${money(s.subtotalKobo)}</dd>
        ${s.discount ? html`<dt>${MC.t('group.sub.discount', 'Branch discount ({p}% for {n} or more branches)', { p: s.discount.percent, n: s.discount.minBranches })}</dt><dd>-${money(s.discount.kobo)}</dd>` : ''}
        <dt><b>${MC.t('group.sub.total', 'Monthly total')}</b></dt><dd><b>${money(s.monthlyKobo)}</b></dd>
        <dt>${MC.t('group.sub.bank_long', 'Bank service charge per payment')}</dt><dd>${money(s.bankChargePerPaymentKobo)}</dd></dl>
        <p class="muted sm" style="margin-top:12px">${MC.t('group.sub.bank_note', 'The bank service charge is added to each payment you make, on top of the monthly total. Suspended branches are not billed.')}</p>
        ${s.discount ? '' : html`<p class="muted sm">${MC.t('group.sub.no_discount', 'Groups with more branches get a discount on the total. MediCore applies it automatically.')}</p>`}
        ${has('group.support') ? html`<div class="btn-row"><a class="btn" href="#/support/new?category=billing_subscription">${icon('message')}${MC.t('group.sub.ask', 'Ask MediCore about billing')}</a></div>` : ''}</section>`);
  }

  /* ---------------- price lists ---------------- */
  async function prices({ query, stale }) {
    const d = await getMeta();
    const live = liveBranches(d.branches);
    if (!live.length) { if (!stale()) view(html`<div class="page-head"><div><h1>${MC.t('group.prices.title', 'Price lists')}</h1></div></div>${empty({ icon: 'card', title: MC.t('group.branches.empty', 'No branches yet') })}`); return; }
    const cur = live.find(b => b.id === query.branch) || live[0];
    const list = await api.get('/api/group/services' + qs({ branchId: cur.id }));
    if (stale()) return;
    const cC = MC.t('group.prices.col.code', 'Code'), cN = MC.t('group.prices.col.name', 'Name'), cCat = MC.t('group.prices.col.category', 'Category'), cP = MC.t('group.prices.col.price', 'Price'), cS = MC.t('group.prices.col.status', 'Status');
    const others = live.filter(b => b.id !== cur.id);
    view(html`<div class="page-head"><div><h1>${MC.t('group.prices.title', 'Price lists')}</h1><p>${MC.t('group.prices.sub', 'Each branch has its own price list. Copy one branch\'s prices to the others to keep them the same.')}</p></div></div>
      <nav class="tabs" aria-label="${MC.t('group.prices.branches', 'Branches')}">${live.map(b => html`<a href="#/prices?branch=${b.id}" ${b.id === cur.id ? html`aria-current="page"` : ''}>${b.branchName}</a>`)}</nav>
      <section class="panel flush"><h2>${MC.t('group.prices.of', 'Price list at {branch}', { branch: cur.branchName })}</h2><p class="muted sm" style="padding:0 16px">${MC.t('group.prices.edit_hint', 'The branch administrator changes single prices in the admin app.')}</p>
      ${list.length ? html`<div class="table-wrap" style="border:0"><table class="t stack-sm"><thead><tr><th>${cC}</th><th>${cN}</th><th>${cCat}</th><th class="num">${cP}</th><th>${cS}</th></tr></thead><tbody>${list.map(s => html`<tr><td data-label="${cC}"><b>${s.code}</b></td><td data-label="${cN}">${s.name}</td><td data-label="${cCat}">${MC.t('group.prices.cat.' + s.category, cap(s.category))}</td><td class="num" data-label="${cP}">${money(s.priceKobo)}</td><td data-label="${cS}">${s.active === false ? badge(MC.t('group.prices.inactive', 'Inactive'), 'warn') : badge(MC.t('group.prices.active', 'Active'), 'ok')}</td></tr>`)}</tbody></table></div>`
        : empty({ icon: 'card', title: MC.t('group.prices.empty', 'No prices at this branch yet'), body: MC.t('group.prices.empty_sub', 'Copy the price list of another branch, or ask the branch administrator to add prices.') })}</section>
      ${others.length ? html`<form class="panel" data-form="pr-copy" novalidate><h2>${MC.t('group.prices.copy', 'Copy a price list to other branches')}</h2>
        <div class="field"><label for="pc-f">${MC.t('group.prices.copy_from', 'Copy from')}</label><select class="input" id="pc-f" name="fromBranchId">${live.map(b => html`<option value="${b.id}" ${b.id === cur.id ? 'selected' : ''}>${b.branchName}</option>`)}</select></div>
        <div class="field"><span class="label">${MC.t('group.prices.copy_to', 'Copy to')}</span>${live.map(b => html`<label class="check"><input type="checkbox" name="toBranchIds" data-list value="${b.id}"><span>${b.branchName}</span></label>`)}<div class="hint">${MC.t('group.prices.copy_to_hint', 'The branch you copy from is skipped if you tick it.')}</div></div>
        <label class="check"><input type="checkbox" name="overwrite"><span>${MC.t('group.prices.overwrite', 'Replace prices that already exist at those branches (same code)')}</span></label>
        <div class="form-err notice bad" hidden></div><div class="btn-row"><button class="btn primary" type="submit">${icon('swap')}${MC.t('group.prices.copy_submit', 'Copy price list')}</button></div></form>` : ''}`);
    form('pr-copy', async f => {
      const to = (f.toBranchIds || []).filter(x => x !== f.fromBranchId);
      if (!to.length) throw fail(MC.t('group.prices.need_to', 'Tick at least one other branch to copy to'));
      const from = live.find(b => b.id === f.fromBranchId);
      const toNames = live.filter(b => to.includes(b.id)).map(b => b.branchName).join(', ');
      if (!(await confirm({ title: MC.t('group.prices.copy_q', 'Copy the price list of {from}?', { from: from.branchName }), body: f.overwrite ? MC.t('group.prices.copy_q_over', 'Prices at {to} are added, and prices with the same code are replaced with the ones from {from}.', { to: toNames, from: from.branchName }) : MC.t('group.prices.copy_q_keep', 'Missing prices are added at {to}. Prices they already have stay as they are.', { to: toNames }), ok: MC.t('group.prices.copy_submit', 'Copy price list') }))) return;
      const r = await api.post('/api/group/services/copy', { fromBranchId: f.fromBranchId, toBranchIds: to, overwrite: !!f.overwrite });
      toast(MC.t('group.prices.copied', 'Price list copied'), 'ok');
      await dialog({ title: MC.t('group.prices.copied', 'Price list copied'), body: html`<dl class="kv money"><dt>${MC.t('group.prices.r.items', 'Items in {from}', { from: from.branchName })}</dt><dd>${r.items}</dd><dt>${MC.t('group.prices.r.created', 'Added')}</dt><dd>${r.created}</dd><dt>${MC.t('group.prices.r.updated', 'Replaced')}</dt><dd>${r.updated}</dd><dt>${MC.t('group.prices.r.skipped', 'Left as they were')}</dt><dd>${r.skipped}</dd></dl>`, actions: [{ label: MC.t('group.done', 'Done'), primary: true, value: true }] });
      MC.render();
    });
  }

  /* ---------------- referrals ---------------- */
  const REF_ST = ['sent', 'accepted', 'arrived', 'completed', 'declined', 'cancelled', 'expired'];
  const urgBadge = u => html`<span class="badge plain ${u === 'emergency' ? 'pri-P1' : u === 'urgent' ? 'pri-P2' : 'pri-P3'}">${MC.t('group.ref.urgency.' + u, cap(u))}</span>`;
  async function referrals({ query, stale }) {
    const rows = await api.get('/api/group/referrals' + qs({ status: query.status }));
    if (stale()) return;
    const dirLabel = x => ({ in: MC.t('group.ref.dir.in', 'Into the group'), out: MC.t('group.ref.dir.out', 'Out of the group'), internal: MC.t('group.ref.dir.internal', 'Between branches') }[x] || x);
    const cNo = MC.t('group.ref.col.number', 'Referral'), cF = MC.t('group.ref.col.from', 'From'), cT = MC.t('group.ref.col.to', 'To'), cD = MC.t('group.ref.col.direction', 'Direction'), cU = MC.t('group.ref.col.urgency', 'Urgency'), cS = MC.t('group.ref.col.service', 'Service'), cSt = MC.t('group.ref.col.status', 'Status'), cW = MC.t('group.ref.col.sent', 'Sent');
    view(html`<div class="page-head"><div><h1>${MC.t('group.ref.title', 'Referrals')}</h1><p>${MC.t('group.ref.sub', 'Patients referred into, out of and between your branches. Clinical details stay with the branches.')}</p></div></div>
      <nav class="tabs" aria-label="${MC.t('group.ref.filter', 'Filter by status')}"><a href="#/referrals" ${!query.status ? html`aria-current="page"` : ''}>${MC.t('group.ref.all', 'All')}</a>${REF_ST.map(s => html`<a href="#/referrals?status=${s}" ${query.status === s ? html`aria-current="page"` : ''}>${MC.t('status.' + s, cap(s))}</a>`)}</nav>
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${cNo}</th><th>${cF}</th><th>${cT}</th><th>${cD}</th><th>${cU}</th><th>${cS}</th><th>${cSt}</th><th>${cW}</th></tr></thead><tbody>
        ${rows.map(r => html`<tr><td data-label="${cNo}"><b>${r.number}</b></td><td data-label="${cF}">${r.fromOrgName}</td><td data-label="${cT}">${r.toOrgName}</td><td data-label="${cD}">${badge(dirLabel(r.direction), r.direction === 'internal' ? 'hue' : 'info')}</td><td data-label="${cU}">${urgBadge(r.urgency)}</td><td data-label="${cS}">${r.service ? MC.t('group.ref.service.' + r.service, cap(r.service)) : '-'}</td><td data-label="${cSt}">${statusBadge(r.status)}</td><td data-label="${cW}">${dateTime(r.createdAt)}</td></tr>`)}
      </tbody></table></div>` : empty({ icon: 'swap', title: MC.t('group.ref.empty', 'No referrals'), body: MC.t('group.ref.empty_sub', 'Referrals your branches send or receive show here.') })}`);
  }

  /* ---------------- audit ---------------- */
  async function audit({ query, stale }) {
    const [rows, d] = await Promise.all([api.get('/api/group/audit' + qs({ branchId: query.branch, action: query.action, before: query.before, limit: 100 })), getMeta()]);
    if (stale()) return;
    const cW = MC.t('group.audit.col.when', 'When'), cB = MC.t('group.audit.col.branch', 'Branch'), cWho = MC.t('group.audit.col.who', 'Who'), cA = MC.t('group.audit.col.action', 'Action'), cR = MC.t('group.audit.col.record', 'Record');
    view(html`<div class="page-head"><div><h1>${MC.t('group.audit.title', 'Audit log')}</h1><p>${MC.t('group.audit.sub', 'Every change in the group console and at every branch, newest first')}</p></div></div>
      <form data-form="au-filter" class="panel" novalidate><div class="fields two">
        <div class="field"><label for="au-b">${MC.t('group.audit.f.branch', 'Branch')}</label><select class="input" id="au-b" name="branch"><option value="">${MC.t('group.audit.all', 'All branches and the group console')}</option>${d.branches.map(b => html`<option value="${b.id}" ${query.branch === b.id ? 'selected' : ''}>${b.branchName}</option>`)}</select></div>
        <div class="field"><label for="au-a">${MC.t('group.audit.f.action', 'Action starts with')}</label><input class="input" id="au-a" name="action" maxlength="60" value="${query.action || ''}" placeholder="${MC.t('group.audit.f.action_ph', 'e.g. group.staff or patient.view')}"></div></div>
        <button class="btn" type="submit">${icon('search')}${MC.t('group.audit.filter', 'Show entries')}</button></form>
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${cW}</th><th>${cB}</th><th>${cWho}</th><th>${cA}</th><th>${cR}</th></tr></thead><tbody>${rows.map(a => html`<tr><td data-label="${cW}">${dateTime(a.at)}</td><td data-label="${cB}">${a.branchName || MC.t('group.audit.console', 'Group console')}</td><td data-label="${cWho}">${a.actorName || MC.t('group.audit.public', 'Public')}${a.role ? html`<br><span class="xs muted">${cap(a.role)}</span>` : ''}</td><td data-label="${cA}"><b>${a.action}</b></td><td data-label="${cR}" class="xs">${a.targetType || ''} ${a.targetId || ''}</td></tr>`)}</tbody></table></div>
        ${rows.length === 100 ? html`<div class="btn-row"><a class="btn" href="#/audit${qs({ branch: query.branch, action: query.action, before: rows[rows.length - 1].at })}">${MC.t('group.audit.older', 'Older entries')}</a></div>` : ''}`
        : empty({ icon: 'shield', title: MC.t('group.audit.empty', 'No entries'), body: query.before ? MC.t('group.audit.no_older', 'There are no older entries.') : '' })}`);
    form('au-filter', f => MC.go('#/audit' + qs({ branch: f.branch, action: f.action })));
  }

  /* ---------------- support ---------------- */
  const CATS = { billing_subscription: 'Billing and subscription', technical_problem: 'Something is not working', feature_request: 'Request a feature', data_correction: 'Correct some data', account_access: 'Account or sign-in', complaint: 'Complaint', integration: 'Payments, SMS or HMO connection', training: 'Training for my staff', other: 'Other' };
  const catLabel = c => MC.t('group.support.cat.' + c, CATS[c] || cap(c));
  async function support({ stale }) {
    const rows = await api.get('/api/group/support');
    if (stale()) return;
    view(html`<div class="page-head"><div><h1>${MC.t('group.support.title', 'Support')}</h1><p>${MC.t('group.support.sub', 'Report a problem, make a complaint or ask for a change for the whole group. The MediCore team replies here.')}</p></div><div class="actions"><a class="btn primary" href="#/support/new">${icon('plus')}${MC.t('group.support.new', 'New request')}</a></div></div>
      ${rows.length ? html`<div class="list">${rows.map(r => html`<a href="#/support/${r.id}"><div class="grow"><span class="title">${r.subject}</span><span class="sub">${r.number} | ${catLabel(r.category)} | ${ago(r.updatedAt || r.createdAt)}</span></div><span class="end">${statusBadge(r.status)}</span></a>`)}</div>` : empty({ icon: 'message', title: MC.t('group.support.empty', 'No requests yet'), body: MC.t('group.support.empty_sub', 'When you raise a request, you can follow it here.'), action: html`<a class="btn primary" href="#/support/new">${MC.t('group.support.new', 'New request')}</a>` })}`);
  }
  async function supportNew({ query }) {
    view(html`<a class="back" href="#/support">${icon('left')}${MC.t('group.support.title', 'Support')}</a><div class="page-head"><div><h1>${MC.t('group.support.new', 'New request')}</h1></div></div>
      <form class="panel" data-form="gt-new" novalidate>
        <div class="field"><label for="gt-c">${MC.t('group.support.about', 'What is it about?')}</label><select class="input" id="gt-c" name="category">${Object.keys(CATS).map(c => html`<option value="${c}" ${query.category === c ? 'selected' : ''}>${catLabel(c)}</option>`)}</select></div>
        <div class="field"><label for="gt-p">${MC.t('group.support.urgency', 'How urgent?')}</label><select class="input" id="gt-p" name="priority"><option value="normal">${MC.t('group.support.p.normal', 'Normal: reply within 2 days')}</option><option value="high">${MC.t('group.support.p.high', 'High: it is slowing us down')}</option><option value="urgent">${MC.t('group.support.p.urgent', 'Urgent: we cannot work')}</option><option value="low">${MC.t('group.support.p.low', 'Low: whenever you can')}</option></select></div>
        <div class="field"><label for="gt-s">${MC.t('group.support.subject', 'Subject')}</label><input class="input" id="gt-s" name="subject" required minlength="5" maxlength="140"></div>
        <div class="field"><label for="gt-t">${MC.t('group.support.details', 'Details')}</label><textarea class="input" id="gt-t" name="text" required maxlength="4000"></textarea><div class="hint">${MC.t('group.support.details_hint', 'Say which branch it is about. Do not include patient names or medical details.')}</div></div>
        <div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${MC.t('group.support.send', 'Send to MediCore')}</button></form>`);
    form('gt-new', async d => { const r = await api.post('/api/group/support', d); toast(MC.t('group.support.sent', 'Request {n} sent', { n: r.number }), 'ok'); MC.go('#/support/' + r.id); });
  }
  async function supportView({ params, stale }) {
    const rows = await api.get('/api/group/support');
    if (stale()) return;
    const r = rows.find(x => x.id === params.id);
    if (!r) { view(html`<a class="back" href="#/support">${icon('left')}${MC.t('group.support.title', 'Support')}</a>${empty({ icon: 'message', title: MC.t('group.support.not_found', 'Request not found'), body: MC.t('group.support.not_found_sub', 'Go back to the list of requests.') })}`); return; }
    view(html`<a class="back" href="#/support">${icon('left')}${MC.t('group.support.title', 'Support')}</a><div class="page-head"><div><h1>${r.subject}</h1><p>${r.number} | ${catLabel(r.category)} | ${statusBadge(r.status)}</p></div></div>
      <ol class="timeline">${(r.messages || []).map(m => html`<li><time>${dateTime(m.at)} | ${m.side === 'medicore' ? MC.t('group.support.team', 'MediCore team') : m.byName}</time>${m.text}</li>`)}</ol>
      ${r.status !== 'closed' ? html`<form class="panel" data-form="gt-reply" novalidate style="margin-top:16px"><div class="field"><label for="gr-t">${MC.t('group.support.reply', 'Reply')}</label><textarea class="input" id="gr-t" name="text" required maxlength="4000"></textarea></div><div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${MC.t('group.support.send_reply', 'Send reply')}</button></form>` : html`<p class="muted">${MC.t('group.support.closed', 'This request is closed. Open a new one if you need more help.')}</p>`}`);
    form('gt-reply', async d => { if (!d.text) throw fail(MC.t('group.support.need_text', 'Write your reply first'), 'text'); await api.post('/api/group/support/' + r.id + '/reply', d); toast(MC.t('group.support.replied', 'Reply sent'), 'ok'); MC.render(); });
  }

  /* ---------------- data export (group owner) ---------------- */
  async function exportRecords(branchId, branchName) {
    const what = branchId ? MC.t('group.export.one', 'all records of {branch}', { branch: branchName }) : MC.t('group.export.all', 'all records of every branch');
    if (!(await confirm({ title: MC.t('group.export.q', 'Download {what}?', { what }), body: MC.t('group.export.q_body', 'The file holds the personal and medical details of patients. Save it only on a secure device and do not share it by email or chat.'), ok: MC.t('group.export.do', 'Download records') }))) return;
    try {
      const r = await downloadFile('/api/group/export' + qs({ branchId }), (MC.me.group.code || 'group') + '-export.json');
      toast(MC.t('group.export.done', 'Records downloaded as {file}', { file: r.name }), 'ok');
    } catch (e) {
      if (e.status === 403) { toast(MC.t('group.export.owner_only', 'Only the group owner can download all records.'), 'bad'); return; }
      throw e;
    }
  }

  /* ---------------- group profile ---------------- */
  async function profile({ stale }) {
    const [p, meta] = await Promise.all([api.get('/api/group/profile'), MC.me.role === 'group_owner' ? getMeta().catch(() => null) : null]);
    if (stale()) return;
    const branchList = meta ? meta.branches.filter(b => !['rejected'].includes(b.status)) : [];
    const c = p.contact || {}; const s = p.settings || {};
    view(html`<div class="page-head"><div><h1>${MC.t('group.profile.title', 'Group profile')}</h1><p>${MC.t('group.profile.sub', 'Group code {code} | Record numbers start with {prefix}', { code: p.code, prefix: p.mrnPrefix || '-' })} | ${statusBadge(p.status)}</p></div></div>
      <form class="panel" data-form="gp-save" novalidate><h2>${MC.t('group.profile.details', 'Details')}</h2>
        <div class="field"><label for="gp-n">${MC.t('group.profile.f.name', 'Group name')}</label><input class="input" id="gp-n" name="name" required minlength="3" maxlength="120" value="${p.name}"><div class="hint">${MC.t('group.profile.f.name_hint', 'Branch names shown to patients start with this name.')}</div></div>
        <div class="fields two"><div class="field"><label for="gp-p">${MC.t('group.profile.f.phone', 'Head office phone')}</label><input class="input" id="gp-p" name="phone" inputmode="tel" value="${c.phone || ''}"></div><div class="field"><label for="gp-e">${MC.t('group.profile.f.email', 'Head office email')}</label><input class="input" id="gp-e" name="email" type="email" value="${c.email || ''}"></div></div>
        <div class="field"><label for="gp-a">${MC.t('group.profile.f.address', 'Head office address')}</label><input class="input" id="gp-a" name="address" maxlength="300" value="${c.address || ''}"></div>
        <div class="field"><label for="gp-l">${MC.t('group.profile.f.logo', 'Logo web address (optional)')}</label><input class="input" id="gp-l" name="logoUrl" type="url" inputmode="url" maxlength="300" value="${p.logoUrl || ''}" placeholder="https://"><div class="hint">${MC.t('group.profile.f.logo_hint', 'Must start with https://. Leave empty to remove the logo.')}</div></div>
        <div class="field"><label for="gp-h">${MC.t('group.profile.f.hours', 'Usual opening hours for new branches')}</label><input class="input" id="gp-h" name="defaultOpeningHours" maxlength="120" value="${s.defaultOpeningHours || ''}" placeholder="${MC.t('group.branch.f.hours_ph', 'e.g. Mon-Sat 08:00-18:00')}"></div>
        <h2 style="margin-top:24px">${MC.t('group.profile.patients', 'Patients')}</h2>
        <label class="check"><input type="checkbox" name="acceptsPatientApplications" ${s.acceptsPatientApplications !== false ? 'checked' : ''}><span>${MC.t('group.profile.f.applications', 'Let patients apply to register in the app at every branch')}<br><span class="muted sm">${MC.t('group.profile.f.applications_hint', 'Changing this sets it at every branch. You can still change a single branch afterwards.')}</span></span></label>
        <div class="form-err notice bad" hidden></div><div class="btn-row"><button class="btn primary" type="submit">${MC.t('group.profile.save', 'Save group profile')}</button></div></form>
      <section class="panel"><h2>${MC.t('group.profile.contacts', 'Contact numbers')}</h2><p class="muted sm">${MC.t('group.profile.contacts_sub', 'Phone and WhatsApp numbers for the head office and each branch, as patients see them.')}</p><a class="btn" href="#/contacts">${icon('phone')}${MC.t('group.profile.contacts_go', 'Edit contact numbers')}</a></section>
      ${MC.me.role === 'group_owner' ? html`<form class="panel" data-form="gp-export" id="privacy" novalidate><h2>${MC.t('group.export.title', 'Your data')}</h2>
        <p>${MC.t('group.export.body', 'Download a copy of everything your branches hold on MediCore: patients, staff, visits, prescriptions, lab orders, bills, payments, referrals and HMO records. The file is in JSON format, which other systems and spreadsheets can import.')}</p>
        <p class="muted sm">${MC.t('group.export.limits', 'Only the group owner can download it. The group can download up to 5 times a day, and every download is recorded in the audit log.')}</p>
        <div class="field"><label for="gx-b">${MC.t('group.export.which', 'Records of')}</label><select class="input" id="gx-b" name="branchId"><option value="">${MC.t('group.export.all_branches', 'All branches')}</option>${branchList.map(b => html`<option value="${b.id}">${b.branchName}</option>`)}</select></div>
        <div class="form-err notice bad" hidden></div><button class="btn" type="submit">${icon('download')}${MC.t('group.export.button', 'Download all our records')}</button></form>` : ''}`);
    form('gp-export', async f => { const b = branchList.find(x => x.id === f.branchId); await exportRecords(b ? b.id : undefined, b ? b.branchName : ''); });
    form('gp-save', async f => {
      if (f.logoUrl && !/^https:\/\//.test(f.logoUrl)) throw fail(MC.t('group.profile.logo_bad', 'The logo address must start with https://'), 'logoUrl');
      const body = { name: f.name, logoUrl: f.logoUrl || '', settings: { acceptsPatientApplications: f.acceptsPatientApplications } };
      if (f.defaultOpeningHours) body.settings.defaultOpeningHours = f.defaultOpeningHours;
      const ct = optional({ phone: f.phone, email: f.email, address: f.address }); if (ct) body.contact = ct;
      const was = s.acceptsPatientApplications !== false;
      if (f.acceptsPatientApplications !== was && !(await confirm({ title: f.acceptsPatientApplications ? MC.t('group.profile.apps_on_q', 'Let patients apply at every branch?') : MC.t('group.profile.apps_off_q', 'Stop patient applications at every branch?'), body: MC.t('group.profile.apps_body', 'This changes the setting at all your branches now, including branches that set it differently.'), ok: MC.t('group.profile.save', 'Save group profile') }))) return;
      await api.patch('/api/group/profile', body);
      toast(MC.t('group.profile.saved', 'Group profile saved'), 'ok'); MC.render();
    });
  }

  /* ---------------- more (phones) ---------------- */
  const NAV = [
    { href: '#/', label: MC.t('group.nav.overview', 'Overview'), icon: 'home' },
    { href: '#/branches', label: MC.t('group.nav.branches', 'Branches'), icon: 'building' },
    { href: '#/staff', label: MC.t('group.nav.staff', 'Staff'), icon: 'users', perm: 'group.staff' },
    { href: '#/subscription', label: MC.t('group.nav.subscription', 'Subscription'), short: MC.t('group.nav.subscription_short', 'Billing'), icon: 'card', perm: 'group.finance' },
    { href: '#/more', label: MC.t('group.nav.more', 'More'), icon: 'menu' },
    { href: '#/admins', label: MC.t('group.nav.admins', 'Group administrators'), icon: 'key', perm: 'group.admins', sideOnly: true },
    { href: '#/prices', label: MC.t('group.nav.prices', 'Price lists'), icon: 'clipboard', perm: 'group.settings', sideOnly: true },
    { href: '#/referrals', label: MC.t('group.nav.referrals', 'Referrals'), icon: 'swap', anyPerm: ['group.network', 'group.reports'], sideOnly: true },
    { href: '#/audit', label: MC.t('group.nav.audit', 'Audit log'), icon: 'shield', perm: 'group.audit', sideOnly: true },
    { href: '#/support', label: MC.t('group.nav.support', 'Support'), icon: 'message', perm: 'group.support', sideOnly: true },
    { href: '#/contacts', label: MC.t('group.nav.contacts', 'Contact numbers'), icon: 'phone', sideOnly: true },
    { href: '#/profile', label: MC.t('group.nav.profile', 'Group profile'), icon: 'settings', perm: 'group.settings', sideOnly: true },
  ];
  const allowed = n => (!n.perm || has(n.perm)) && (!n.anyPerm || n.anyPerm.some(has));
  async function more() {
    const items = NAV.filter(n => n.sideOnly && allowed(n));
    view(html`<div class="page-head"><div><h1>${MC.t('group.more.title', 'More')}</h1><p>${MC.me.group.name} | ${MC.me.roleLabel}</p></div></div>
      ${items.length ? html`<div class="list">${items.map(n => html`<a href="${n.href}">${icon(n.icon)}<div class="grow"><span class="title">${n.label && n.label.mcKey ? MC.t(n.label.mcKey, n.label.mcFallback) : String(n.label)}</span></div>${icon('right')}</a>`)}</div>` : empty({ icon: 'menu', title: MC.t('group.more.empty', 'Nothing else to show for your role') })}`);
  }

  /* a screen the signed-in person's role cannot use: say so instead of showing a server error */
  const guard = (n, fn) => async ctx => {
    if (allowed(n)) return fn(ctx);
    view(html`${empty({ icon: 'lock', title: MC.t('group.forbidden', 'Your role cannot open this page'), body: MC.t('group.forbidden_sub', 'Ask the group owner to change your role if you need it.'), action: html`<a class="btn" href="#/">${MC.t('group.forbidden_home', 'Go to the overview')}</a>` })}`);
  };
  const navFor = href => NAV.find(n => n.href === href) || {};
  MC.boot({
    title: 'MediCore Group', subtitle: MC.t('group.login.sub', 'Every branch of your hospital group in one place'), home: '#/',
    nav: NAV,
    routes: { '#/': overview, '#/branches': branches, '#/branches/:id': branchView, '#/staff': guard(navFor('#/staff'), staffPage), '#/admins': guard(navFor('#/admins'), admins), '#/subscription': guard(navFor('#/subscription'), subscription), '#/prices': guard(navFor('#/prices'), prices), '#/referrals': guard(navFor('#/referrals'), referrals), '#/audit': guard(navFor('#/audit'), audit), '#/support': guard(navFor('#/support'), support), '#/support/new': guard(navFor('#/support'), supportNew), '#/support/:id': guard(navFor('#/support'), supportView), '#/profile': guard(navFor('#/profile'), profile), '#/contacts': contactsPage, '#/more': more },
  });
})();
