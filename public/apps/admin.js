/* MediCore Admin: one provider's settings, staff, price list, attendance, reports and audit.
 * Used by owners and administrators of every provider type (and HMO managers). */
(function () {
  'use strict';
  const { html, api, qs, money, date, dateTime, ago, cap, icon, badge, statusBadge, empty, figures, view, on, form, dialog, confirm, toast } = MC;
  const naira = k => money(k);

  let catalog = null;
  const getCatalog = async () => catalog || (catalog = await api.get('/api/meta/catalog'));
  const has = p => !!(MC.me && (MC.me.perms || []).includes(p));
  const fail = (msg, field) => new MC.ApiError(400, { error: msg, details: field ? [{ field, error: msg }] : undefined });

  // the "More" tab is for phones only: on desktop every section is already in the sidebar
  (function () { const s = document.createElement('style'); s.textContent = '@media (min-width: 960px) { .side a[href="#/more"] { display: none; } } .msg-mine { background: var(--hue-soft); } .msg-system { color: var(--ink-3); font-style: italic; } .kv.money { grid-template-columns: minmax(0, 1fr) auto; } .kv.money dd { text-align: right; white-space: nowrap; } .ct-adv { margin: 8px 0 4px; } .ct-adv summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; font-weight: 600; } .ct-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 8px; } .ct-head h2 { margin: 0; } .ct-prev .end { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; } .ct-prev .end .btn { white-space: nowrap; } .ct-prev li { flex-wrap: wrap; } .ct-prev li .end { width: 100%; max-width: none; justify-content: flex-start; } .ct-edit > summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 14px; border: 1px solid var(--line); border-radius: var(--r-sm); font-weight: 600; margin-top: 8px; } .ct-edit > summary::-webkit-details-marker { display: none; } .ct-edit[open] > summary { margin-bottom: 12px; } .ct-sum { margin-bottom: 4px; } .hp-acts { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; } .wrap-any { overflow-wrap: anywhere; }'; document.head.appendChild(s); })();

  /* download a file from the API without leaving the page (same headers and cookie as MC.api) */
  async function downloadFile(path, fallbackName) {
    let r;
    try { r = await fetch(path, { credentials: 'same-origin', headers: { 'X-MC-App': MC.APP, 'X-MC-Lang': MC.lang } }); }
    catch (e) { throw new MC.ApiError(0, { error: MC.t('admin.download.network', 'Could not reach MediCore. Check your connection and try again.'), code: 'network' }); }
    if (!r.ok) {
      let b = null; try { b = await r.json(); } catch (e) { b = null; }
      const err = new MC.ApiError(r.status, b || { error: MC.t('admin.download.failed', 'The download did not work ({status}). Try again.', { status: r.status }) });
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

  /* ---------------- contact numbers (per department) ---------------- */
  const DEPT_ORDER = ['main', 'emergency', 'appointments', 'pharmacy', 'lab', 'billing', 'care', 'ambulance', 'records'];
  let ct = null; // state of the contacts editor on the current page
  const deptLabel = k => MC.t('admin.contacts.dept.' + k, (ct && ct.departments && ct.departments[k]) || cap(k));
  function relevantDepts(modules, type) {
    const m = modules || []; const want = ['main', 'billing'];
    if (m.includes('clinic')) want.push('appointments', 'records');
    if (m.includes('ambulance') || type === 'hospital') want.push('emergency');
    if (m.includes('pharmacy')) want.push('pharmacy');
    if (m.includes('lab')) want.push('lab');
    if (m.includes('ambulance')) want.push('ambulance');
    return DEPT_ORDER.filter(k => want.includes(k));
  }
  function shownDepts() {
    const keys = new Set(relevantDepts(ct.modules, ct.type).concat(Object.keys(ct.contacts || {}), ct.extra));
    return DEPT_ORDER.filter(k => keys.has(k) && ct.departments[k]);
  }
  function contactCard(k) {
    const e = (ct.contacts || {})[k] || null; const v = e || {}; const id = 'ct-' + k;
    const state = e ? (e.show === false ? badge(MC.t('admin.contacts.hidden', 'Hidden from patients'), 'warn') : badge(MC.t('admin.contacts.shown', 'Shown to patients'), 'ok')) : badge(MC.t('admin.contacts.not_set', 'Not set up'), 'outline');
    const head = html`<div class="ct-head"><h2>${deptLabel(k)}</h2><span class="row wrap" style="gap:6px">${state}${e && e.automated ? badge(MC.t('admin.contacts.automated', 'Chats come to your inbox'), 'hue') : ''}</span></div>`;
    const summary = () => html`<dl class="kv ct-sum"><dt>${MC.t('admin.contacts.f.phone', 'Phone')}</dt><dd>${v.phone || '-'}</dd><dt>${MC.t('admin.contacts.f.whatsapp', 'WhatsApp number')}</dt><dd>${v.whatsapp || '-'}</dd><dt>${MC.t('admin.contacts.f.email', 'Email')}</dt><dd class="wrap-any">${v.email || '-'}</dd><dt>${MC.t('admin.contacts.f.hours', 'Opening hours')}</dt><dd>${v.hours || '-'}</dd></dl>`;
    if (!ct.canEdit) {
      return html`<section class="panel" id="${id}">${head}${e ? summary() : html`<p class="muted sm">${MC.t('admin.contacts.none_ro', 'No numbers for this department yet.')}</p>`}</section>`;
    }
    const frm = html`<form data-form="ct-save" data-dept="${k}" novalidate>
        <div class="fields two"><div class="field"><label for="${id}-p">${MC.t('admin.contacts.f.phone', 'Phone')}</label><input class="input" id="${id}-p" name="phone" inputmode="tel" maxlength="20" autocomplete="off" placeholder="0803 123 4567" value="${v.phone || ''}"></div>
        <div class="field"><label for="${id}-w">${MC.t('admin.contacts.f.whatsapp', 'WhatsApp number')}</label><input class="input" id="${id}-w" name="whatsapp" inputmode="tel" maxlength="20" autocomplete="off" placeholder="0803 123 4567" value="${v.whatsapp || ''}"><button type="button" class="btn sm ghost" data-action="ct-same" data-dept="${k}" style="margin-top:4px">${MC.t('admin.contacts.same', 'Same as phone')}</button></div></div>
        <div class="fields two"><div class="field"><label for="${id}-e">${MC.t('admin.contacts.f.email', 'Email')}</label><input class="input" id="${id}-e" name="email" type="email" maxlength="120" autocomplete="off" value="${v.email || ''}"></div>
        <div class="field"><label for="${id}-h">${MC.t('admin.contacts.f.hours', 'Opening hours')}</label><input class="input" id="${id}-h" name="hours" maxlength="120" placeholder="${MC.t('admin.contacts.f.hours_ph', 'e.g. Mon-Fri 8am-6pm, or 24 hours')}" value="${v.hours || ''}"></div></div>
        <label class="check"><input type="checkbox" name="show" ${v.show !== false ? 'checked' : ''}><span>${MC.t('admin.contacts.f.show', 'Show to patients')}</span></label>
        <details class="ct-adv" ${v.waPhoneNumberId ? 'open' : ''}><summary>${MC.t('admin.contacts.adv', 'Advanced: WhatsApp phone number ID')}</summary>
          <div class="field"><label for="${id}-id">${MC.t('admin.contacts.f.wa_id', 'WhatsApp phone number ID')}</label><input class="input" id="${id}-id" name="waPhoneNumberId" inputmode="numeric" maxlength="30" autocomplete="off" value="${v.waPhoneNumberId || ''}"><div class="hint">${MC.t('admin.contacts.f.wa_id_hint', 'From Meta, after this number is added to MediCore\'s WhatsApp Business account. With it, chats on this number arrive in your WhatsApp inbox.')}</div></div></details>
        <div class="form-err notice bad" hidden></div>
        <div class="btn-row"><button class="btn primary" type="submit">${MC.t('admin.contacts.save', 'Save numbers')}</button>
          ${e ? html`<button type="button" class="btn" data-action="ct-remove" data-dept="${k}">${icon('trash')}${MC.t('admin.contacts.remove', 'Remove department')}</button>` : ct.extra.includes(k) ? html`<button type="button" class="btn ghost" data-action="ct-drop" data-dept="${k}">${MC.t('admin.contacts.drop', 'Do not add')}</button>` : ''}</div>
      </form>`;
    return html`<section class="panel" id="${id}">${head}
      ${e ? summary() : html`<p class="muted sm">${MC.t('admin.contacts.not_set_sub', 'Patients do not see this department until you save a number for it.')}</p>`}
      ${e ? html`<details class="ct-edit"><summary>${icon('edit')}${MC.t('admin.contacts.change', 'Change numbers')}</summary>${frm}</details>` : frm}</section>`;
  }
  function contactPreview() {
    const list = DEPT_ORDER.filter(k => ct.contacts[k] && ct.contacts[k].show !== false && (ct.contacts[k].callLink || ct.contacts[k].chatLink));
    return html`<section class="panel flush ct-prev"><h2>${MC.t('admin.contacts.preview', 'How patients see it')}</h2>
      <p class="muted sm" style="padding:0 16px">${MC.t('admin.contacts.preview_sub', 'This is the contact card in the patient app. Try the buttons to check each number.')}</p>
      ${list.length ? html`<ul class="list">${list.map(k => { const e = ct.contacts[k]; return html`<li><div class="grow"><span class="title">${deptLabel(k)}</span><span class="sub">${[e.phone, e.hours].filter(Boolean).join(' | ')}</span></div><span class="end">${e.callLink ? html`<a class="btn sm" href="${e.callLink}">${icon('phone')}${MC.t('admin.contacts.call', 'Call')}</a>` : ''}${e.chatLink ? html`<a class="btn sm" href="${e.chatLink}" target="_blank" rel="noopener noreferrer">${icon('message')}${MC.t('admin.contacts.chat', 'Chat on WhatsApp')}</a>` : ''}</span></li>`; })}</ul>`
        : html`<p class="muted sm" style="padding:0 16px 16px">${MC.t('admin.contacts.preview_none', 'Patients see no numbers yet. Save a number and tick Show to patients.')}</p>`}</section>`;
  }
  function contactsBlock() {
    const rest = DEPT_ORDER.filter(k => ct.departments[k] && !shownDepts().includes(k));
    return html`${ct.whatsappApi ? html`<div class="notice ok">${MC.t('admin.contacts.wa_on', 'Automated WhatsApp is connected. Numbers with a WhatsApp phone number ID send their chats to your WhatsApp inbox.')}</div>`
      : html`<div class="notice">${MC.t('admin.contacts.wa_off', 'Automated WhatsApp is not connected yet. Patients can still tap Chat on WhatsApp to message your number on their phone.')}</div>`}
      <div class="grid side-r"><div>${shownDepts().map(contactCard)}
        ${ct.canEdit && rest.length ? html`<div class="btn-row" style="margin-bottom:16px"><button class="btn" data-action="ct-add">${icon('plus')}${MC.t('admin.contacts.add', 'Add another department')}</button></div>` : ''}</div>
      <div>${contactPreview()}</div></div>`;
  }
  const paintContacts = () => { const box = document.getElementById('ct-box'); if (box) MC.view(contactsBlock(), box); };
  function wireContacts() {
    on('ct-same', el => { const f = el.closest('form'); if (!f) return; if (!f.elements.phone.value.trim()) { toast(MC.t('admin.contacts.same_need', 'Enter the phone number first'), 'bad'); f.elements.phone.focus(); return; } f.elements.whatsapp.value = f.elements.phone.value; toast(MC.t('admin.contacts.same_done', 'WhatsApp number set to the phone number')); });
    form('ct-save', async (f, el) => {
      const k = el.dataset.dept;
      if (!f.phone && !f.whatsapp) throw fail(MC.t('admin.contacts.need_number', 'Enter a phone number or a WhatsApp number'), 'phone');
      if (f.waPhoneNumberId && !/^\d+$/.test(String(f.waPhoneNumberId).trim())) throw fail(MC.t('admin.contacts.wa_id_bad', 'The WhatsApp phone number ID has digits only'), 'waPhoneNumberId');
      const entry = { show: !!f.show };
      ['phone', 'whatsapp', 'email', 'hours', 'waPhoneNumberId'].forEach(x => { if (f[x] != null && String(f[x]).trim()) entry[x] = String(f[x]).trim(); });
      const r = await api.patch(ct.url, { contacts: { [k]: entry } });
      ct.contacts = r[ct.resKey] || ct.contacts; ct.extra = ct.extra.filter(x => x !== k);
      paintContacts(); toast(MC.t('admin.contacts.saved', '{dept} numbers saved', { dept: deptLabel(k) }), 'ok');
    });
    on('ct-remove', async el => {
      const k = el.dataset.dept;
      if (!(await confirm({ title: MC.t('admin.contacts.remove_q', 'Remove {dept}?', { dept: deptLabel(k) }), body: MC.t('admin.contacts.remove_body', 'Patients will no longer see these numbers in the app. You can add the department again later.'), ok: MC.t('admin.contacts.remove', 'Remove department'), danger: true }))) return;
      const r = await api.patch(ct.url, { contacts: { [k]: null } });
      ct.contacts = r[ct.resKey] || {}; paintContacts(); toast(MC.t('admin.contacts.removed', '{dept} removed', { dept: deptLabel(k) }), 'ok');
    });
    on('ct-drop', el => { ct.extra = ct.extra.filter(x => x !== el.dataset.dept); paintContacts(); });
    on('ct-add', async () => {
      const rest = DEPT_ORDER.filter(k => ct.departments[k] && !shownDepts().includes(k));
      const v = await dialog({ title: MC.t('admin.contacts.add', 'Add another department'), form: true, body: html`<div class="field"><label for="ct-new">${MC.t('admin.contacts.add_which', 'Department')}</label><select class="input" id="ct-new" name="dept">${rest.map(k => html`<option value="${k}">${deptLabel(k)}</option>`)}</select></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('admin.contacts.add_submit', 'Add department'), primary: true }] });
      if (!v || !v.dept) return;
      ct.extra.push(v.dept); paintContacts();
      const card = document.getElementById('ct-' + v.dept); if (card) { card.scrollIntoView({ block: 'start' }); const i = card.querySelector('input'); if (i) i.focus({ preventScroll: true }); }
    });
  }
  async function contactsPage({ stale }) {
    const d = await api.get('/api/admin/contacts');
    if (stale()) return;
    ct = { departments: d.departments || {}, contacts: d.contacts || {}, modules: d.modules || [], type: MC.me.org && MC.me.org.type, whatsappApi: !!d.whatsappApi, canEdit: has('admin.settings'), url: '/api/admin/contacts', resKey: 'contacts', extra: [] };
    view(html`<div class="page-head"><div><h1>${MC.t('admin.contacts.title', 'Contact numbers')}</h1><p>${MC.t('admin.contacts.sub', 'The phone and WhatsApp numbers patients see for each department.')}</p></div></div>
      ${ct.canEdit ? '' : html`<div class="notice">${MC.t('admin.contacts.read_only', 'You can see these numbers. Ask an administrator to change them.')}</div>`}
      <div id="ct-box">${contactsBlock()}</div>`);
    wireContacts();
  }

  /* ---------------- HMOs we accept (panel) ---------------- */
  async function hmoPage({ stale }) {
    const d = await api.get('/api/admin/hmos');
    if (stale()) return;
    const act = d.panel.filter(p => p.active !== false), old = d.panel.filter(p => p.active === false);
    const row = p => html`<li><div class="grow"><span class="title">${p.name} ${p.onPlatform ? badge(MC.t('admin.hmos.on', 'On MediCore'), 'ok') : badge(MC.t('admin.hmos.off', 'Not on MediCore'), 'outline')}${p.active === false ? html` ${badge(MC.t('admin.hmos.inactive', 'Not accepted now'), 'warn')}` : ''}</span>
      <span class="sub">${[p.code, p.contactName, p.phone].filter(Boolean).join(' | ') || (p.onPlatform ? MC.t('admin.hmos.on_sub', 'Pre-authorisations and claims go through MediCore') : MC.t('admin.hmos.no_contact', 'No contact details yet'))}</span>
      ${p.preauthEmail ? html`<span class="sub wrap-any">${MC.t('admin.hmos.preauth_to', 'Pre-authorisation: {email}', { email: p.preauthEmail })}</span>` : ''}${p.claimsEmail ? html`<span class="sub wrap-any">${MC.t('admin.hmos.claims_to', 'Claims: {email}', { email: p.claimsEmail })}</span>` : ''}${!p.preauthEmail && !p.claimsEmail && p.email ? html`<span class="sub wrap-any">${p.email}</span>` : ''}</div>
      <span class="end hp-acts"><button class="btn sm" data-action="hp-edit" data-id="${p.id}">${MC.t('admin.hmos.edit', 'Edit')}</button>${p.active === false ? html`<button class="btn sm" data-action="hp-active" data-id="${p.id}" data-on="1">${MC.t('admin.hmos.reactivate', 'Accept again')}</button>` : html`<button class="btn sm" data-action="hp-active" data-id="${p.id}">${MC.t('admin.hmos.deactivate', 'Stop accepting')}</button>`}</span></li>`;
    view(html`<div class="page-head"><div><h1>${MC.t('admin.hmos.title', 'HMOs we accept')}</h1><p>${act.length === 1 ? MC.t('admin.hmos.sub_one', '1 HMO your front desk can bill') : MC.t('admin.hmos.sub', '{n} HMOs your front desk can bill', { n: act.length })}</p></div>
      <div class="actions"><button class="btn primary" data-action="hp-add-on">${icon('plus')}${MC.t('admin.hmos.add_on', 'Add an HMO on MediCore')}</button><button class="btn" data-action="hp-add-off">${icon('plus')}${MC.t('admin.hmos.add_off', 'Add another HMO')}</button></div></div>
      <p class="notice">${MC.t('admin.hmos.explain', 'Claims to HMOs on MediCore flow automatically. Other HMOs get pre-authorisation requests from your staff by email or WhatsApp, and claim files by email.')}</p>
      ${d.emailReady ? html`<div class="notice ok">${MC.t('admin.hmos.email_ready', 'Email sending is set up. MediCore can email pre-authorisation requests and claim files to HMOs.')}</div>`
        : html`<div class="notice warn">${MC.t('admin.hmos.email_off', 'Email sending is not set up yet, so MediCore cannot email HMOs for you. Staff can still send requests by WhatsApp and download claim files. Ask MediCore support to set up email.')}</div>`}
      <section class="panel flush"><h2>${MC.t('admin.hmos.accepted', 'Accepted now')}</h2>${act.length ? html`<ul class="list">${act.map(row)}</ul>` : empty({ icon: 'shield', title: MC.t('admin.hmos.empty', 'No HMOs yet'), body: MC.t('admin.hmos.empty_sub', 'Add the HMOs you are accredited with so your front desk can check cover and bill them.') })}</section>
      ${old.length ? html`<section class="panel flush"><h2>${MC.t('admin.hmos.stopped', 'No longer accepted')}</h2><ul class="list">${old.map(row)}</ul></section>` : ''}`);

    const fields = p => { const v = p || {}; const on1 = !!v.payerOrgId; return html`
      ${on1 ? html`<div class="field"><span class="label">${MC.t('admin.hmos.f.name', 'HMO name')}</span><div>${v.name}</div><div class="hint">${MC.t('admin.hmos.f.name_on', 'This HMO is on MediCore, so its name comes from its account.')}</div></div>`
        : html`<div class="field"><label for="hp-n">${MC.t('admin.hmos.f.name', 'HMO name')}</label><input class="input" id="hp-n" name="name" required maxlength="120" value="${v.name || ''}"></div>`}
      <div class="fields two"><div class="field"><label for="hp-c">${MC.t('admin.hmos.f.code', 'HMO code (optional)')}</label><input class="input" id="hp-c" name="code" maxlength="20" value="${v.code || ''}"></div><div class="field"><label for="hp-cn">${MC.t('admin.hmos.f.contact', 'Contact person')}</label><input class="input" id="hp-cn" name="contactName" maxlength="100" value="${v.contactName || ''}"></div></div>
      <div class="fields two"><div class="field"><label for="hp-p">${MC.t('admin.hmos.f.phone', 'Phone')}</label><input class="input" id="hp-p" name="phone" inputmode="tel" maxlength="20" placeholder="0803 123 4567" value="${v.phone || ''}"></div><div class="field"><label for="hp-w">${MC.t('admin.hmos.f.whatsapp', 'WhatsApp number')}</label><input class="input" id="hp-w" name="whatsapp" inputmode="tel" maxlength="20" value="${v.whatsapp || ''}"></div></div>
      <div class="field"><label for="hp-e">${MC.t('admin.hmos.f.email', 'General email')}</label><input class="input" id="hp-e" name="email" type="email" maxlength="120" value="${v.email || ''}"></div>
      <div class="fields two"><div class="field"><label for="hp-pe">${MC.t('admin.hmos.f.preauth', 'Pre-authorisation email')}</label><input class="input" id="hp-pe" name="preauthEmail" type="email" maxlength="120" value="${v.preauthEmail || ''}"></div><div class="field"><label for="hp-ce">${MC.t('admin.hmos.f.claims', 'Claims email')}</label><input class="input" id="hp-ce" name="claimsEmail" type="email" maxlength="120" value="${v.claimsEmail || ''}"></div></div>
      <div class="field"><label for="hp-u">${MC.t('admin.hmos.f.portal', 'Portal link (optional)')}</label><input class="input" id="hp-u" name="portalUrl" type="url" inputmode="url" maxlength="300" placeholder="https://" value="${v.portalUrl || ''}"><div class="hint">${MC.t('admin.hmos.f.portal_hint', 'The HMO\'s provider portal, if it has one. Must start with https://.')}</div></div>
      <div class="field"><label for="hp-no">${MC.t('admin.hmos.f.notes', 'Notes for your staff (optional)')}</label><textarea class="input" id="hp-no" name="notes" maxlength="1000" placeholder="${MC.t('admin.hmos.f.notes_ph', 'e.g. Call before sending claims over 500,000 naira')}">${v.notes || ''}</textarea></div>`; };
    const STR = ['code', 'contactName', 'phone', 'whatsapp', 'portalUrl', 'notes'], EMAILS = ['email', 'preauthEmail', 'claimsEmail'];
    const check1 = f => { if (f.portalUrl && !/^https:\/\//.test(f.portalUrl)) throw fail(MC.t('admin.hmos.portal_bad', 'The portal link must start with https://'), 'portalUrl'); };
    on('hp-add-on', async () => {
      const taken = new Set(d.panel.map(p => p.payerOrgId).filter(Boolean));
      const free = (d.platformHmos || []).filter(h => !taken.has(h.id));
      if (!free.length) { toast(MC.t('admin.hmos.none_free', 'Every HMO on MediCore is already on your list. Use Add another HMO for the rest.'), 'bad'); return; }
      const r = await dialog({ title: MC.t('admin.hmos.add_on', 'Add an HMO on MediCore'), form: true, body: html`<p class="muted sm">${MC.t('admin.hmos.add_on_sub', 'Claims and pre-authorisations to this HMO go through MediCore automatically.')}</p><div class="field"><label for="hp-h">${MC.t('admin.hmos.f.which', 'HMO')}</label><select class="input" id="hp-h" name="payerOrgId">${free.map(h => html`<option value="${h.id}">${h.name}${h.code ? ' (' + h.code + ')' : ''}</option>`)}</select></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('admin.hmos.add_submit', 'Add HMO'), primary: true }], onSubmit: f => api.post('/api/admin/hmos', { payerOrgId: f.payerOrgId }) });
      if (r) { toast(MC.t('admin.hmos.added', '{name} added', { name: r.name }), 'ok'); MC.render(); }
    });
    on('hp-add-off', async () => {
      const r = await dialog({ title: MC.t('admin.hmos.add_off_title', 'Add an HMO that is not on MediCore'), form: true, wide: true, body: fields(null),
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('admin.hmos.add_submit', 'Add HMO'), primary: true }],
        onSubmit: f => { if (!f.name || !String(f.name).trim()) throw fail(MC.t('admin.hmos.need_name', 'Enter the HMO\'s name'), 'name'); check1(f); const b = { name: f.name }; STR.concat(EMAILS).forEach(k => { if (f[k]) b[k] = f[k]; }); return api.post('/api/admin/hmos', b); } });
      if (r) { toast(MC.t('admin.hmos.added', '{name} added', { name: r.name }), 'ok'); MC.render(); }
    });
    on('hp-edit', async el => {
      const p = d.panel.find(x => x.id === el.dataset.id); if (!p) return;
      const r = await dialog({ title: MC.t('admin.hmos.edit_title', 'Edit {name}', { name: p.name }), form: true, wide: true, body: fields(p),
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('admin.hmos.save', 'Save HMO'), primary: true }],
        onSubmit: f => {
          if (!p.payerOrgId && (!f.name || !String(f.name).trim())) throw fail(MC.t('admin.hmos.need_name', 'Enter the HMO\'s name'), 'name'); check1(f);
          const b = {}; if (!p.payerOrgId) b.name = f.name;
          STR.forEach(k => { b[k] = f[k] || ''; }); EMAILS.forEach(k => { if (f[k]) b[k] = f[k]; });
          return api.patch('/api/admin/hmos/' + p.id, b);
        } });
      if (r) { toast(MC.t('admin.hmos.saved', '{name} saved', { name: p.name }), 'ok'); MC.render(); }
    });
    on('hp-active', async el => {
      const p = d.panel.find(x => x.id === el.dataset.id); if (!p) return; const on1 = !!el.dataset.on;
      if (!(await confirm({ title: on1 ? MC.t('admin.hmos.reactivate_q', 'Accept {name} again?', { name: p.name }) : MC.t('admin.hmos.deactivate_q', 'Stop accepting {name}?', { name: p.name }),
        body: on1 ? MC.t('admin.hmos.reactivate_body', 'Your front desk can check cover and bill {name} again.', { name: p.name }) : MC.t('admin.hmos.deactivate_body', 'Your front desk will no longer see {name} when checking cover or billing. Covers, requests and claims already recorded are kept.', { name: p.name }),
        ok: on1 ? MC.t('admin.hmos.reactivate', 'Accept again') : MC.t('admin.hmos.deactivate', 'Stop accepting'), danger: !on1 }))) return;
      await api.patch('/api/admin/hmos/' + p.id, { active: on1 });
      toast(on1 ? MC.t('admin.hmos.reactivated', '{name} accepted again', { name: p.name }) : MC.t('admin.hmos.deactivated', 'Stopped accepting {name}', { name: p.name }), 'ok'); MC.render();
    });
  }

  /* a branch of a group: say so, and link to the group console for people who run the group */
  function branchBanner(o) {
    if (!o || !o.group) return '';
    return html`<div class="notice row wrap between" role="note">${icon('building')}<span class="grow" style="flex:1;min-width:200px">${MC.t('admin.branch.banner', 'Branch of {group}', { group: o.group.name })}${o.branchName ? html`: <b>${o.branchName}</b>` : ''}. ${o.modulesManagedByGroup ? MC.t('admin.branch.banner_sub', 'Your group manages the apps and subscription of every branch.') : ''}</span>${MC.me && MC.me.isGroupAdmin ? html`<a class="btn sm" href="/group.html">${MC.t('admin.branch.open_group', 'Open the group console')}</a>` : ''}</div>`;
  }

  /* ---------------- overview ---------------- */
  async function overview({ me }) {
    const [s, duty, org] = await Promise.all([api.get('/api/admin/reports/summary').catch(() => null), api.get('/api/shift/on-duty').catch(() => []), api.get('/api/admin/org')]);
    const max = s ? Math.max(1, ...s.revenueByDay.map(x => x.kobo)) : 1;
    view(html`<div class="page-head"><div><h1>${org.name}</h1><p>${cap(org.type)} | ${MC.t('admin.overview.code', 'Code')} <b>${org.code}</b> | ${org.plan ? MC.t('admin.overview.plan', '{plan} plan ({status})', { plan: org.plan.label, status: MC.t('status.' + org.plan.status, cap(org.plan.status)) }) : MC.t('admin.overview.no_plan', 'No plan')}</p></div>
      <div class="actions"><a class="btn" href="#/staff">${icon('users')}${MC.t('admin.overview.staff', 'Staff')}</a><a class="btn" href="#/services">${icon('card')}${MC.t('admin.overview.price_list', 'Price list')}</a></div></div>
      ${branchBanner(org)}
      ${org.status !== 'active' ? html`<div class="notice warn">${MC.t('admin.overview.not_active', 'This provider is {status}. Patients cannot find you until MediCore approves it.', { status: MC.t('status.' + org.status, org.status) })}</div>` : ''}
      ${s ? figures([{ value: s.patients, label: MC.t('admin.overview.patients', 'Patients linked') }, { value: s.newPatients30d, label: MC.t('admin.overview.new_patients', 'New in 30 days') }, { value: naira(s.revenue30dKobo), label: MC.t('admin.overview.collected_30d', 'Collected, 30 days') }, { value: naira(s.outstandingKobo), label: MC.t('admin.overview.outstanding', 'Outstanding bills'), tone: s.outstandingKobo ? 'warn' : '' }, { value: naira(s.hmoCovered30dKobo), label: MC.t('admin.overview.hmo_30d', 'HMO covered, 30 days') }, { value: s.onDuty + ' / ' + s.staffActive, label: MC.t('admin.overview.staff_on_duty', 'Staff on duty') }]) : ''}
      <div class="grid side-r">
        <section class="panel"><h2>${MC.t('admin.overview.per_day', 'Collected per day')}</h2>${s && s.revenueByDay.length ? html`<div class="bars">${s.revenueByDay.slice(-14).map(d => html`<div class="bar"><span>${date(Date.parse(d.date))}</span><div class="track"><div class="fill" style="width:${Math.round(d.kobo / max * 100)}%"></div></div><span class="v">${naira(d.kobo)}</span></div>`)}</div>` : empty({ icon: 'chart', title: MC.t('admin.overview.no_payments', 'No payments yet'), body: MC.t('admin.overview.no_payments_sub', 'Paid bills from the last 30 days show here.') })}</section>
        <section class="panel"><h2>${MC.t('admin.overview.on_duty', 'On duty now')}</h2>${duty.length ? html`<ul class="list">${duty.map(d => html`<li><div class="grow"><span class="title">${d.name}</span><span class="sub">${d.roleLabel} | ${MC.t('admin.overview.since', 'since {time}', { time: ago(d.in) })}</span></div>${d.onSite === false ? badge(MC.t('admin.overview.off_site', 'Off site'), 'warn') : d.onSite ? badge(MC.t('admin.overview.on_site', 'On site'), 'ok') : ''}</li>`)}</ul>` : empty({ icon: 'clock', title: MC.t('admin.overview.nobody', 'Nobody is clocked in') })}</section>
      </div>
      <section class="panel"><h2>${MC.t('admin.overview.services_on', 'Services switched on')}</h2><p class="muted sm">${MC.t('admin.overview.services_on_sub', 'These decide which apps your staff can use. Change them in Settings.')}</p><div class="row wrap">${org.modules.map(m => badge(cap(m), 'hue'))}</div></section>`);
  }

  /* ---------------- staff ---------------- */
  async function staff() {
    const d = await api.get('/api/admin/staff');
    view(html`<div class="page-head"><div><h1>${MC.t('admin.staff.title', 'Staff')}</h1><p>${d.seats ? MC.t('admin.staff.count_seats', '{used} active of {seats} allowed by your plan', { used: d.used, seats: d.seats }) : MC.t('admin.staff.count', '{used} active', { used: d.used })}</p></div><div class="actions"><button class="btn primary" data-action="staff-add">${icon('plus')}${MC.t('admin.staff.add', 'Add staff')}</button></div></div>
      ${d.staff.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${MC.t('admin.staff.col.name', 'Name')}</th><th>${MC.t('admin.staff.col.role', 'Role')}</th><th>${MC.t('admin.staff.col.signin', 'Sign in with')}</th><th>${MC.t('admin.staff.col.status', 'Status')}</th><th>${MC.t('admin.staff.col.last', 'Last sign in')}</th><th></th></tr></thead><tbody>
      ${d.staff.map(s => html`<tr><td data-label="${MC.t('admin.staff.col.name', 'Name')}"><b>${s.name}</b>${s.isOwner ? html` ${badge(MC.t('admin.staff.owner', 'Owner'), 'hue')}` : ''}${s.pendingPasswordChange ? html`<br><span class="xs muted">${MC.t('admin.staff.no_password', 'Has not set a password yet')}</span>` : ''}</td><td data-label="${MC.t('admin.staff.col.role', 'Role')}">${s.roleLabel}${s.title ? html`<br><span class="xs muted">${s.title}</span>` : ''}</td><td data-label="${MC.t('admin.staff.col.signin', 'Sign in with')}">${s.email || s.phone || ''}</td><td data-label="${MC.t('admin.staff.col.status', 'Status')}">${statusBadge(s.status)}</td><td data-label="${MC.t('admin.staff.col.last', 'Last sign in')}">${s.lastLoginAt ? ago(s.lastLoginAt) : MC.t('admin.staff.never', 'Never')}</td>
        <td class="num">${s.isOwner || s.userId === MC.me.user.id ? '' : html`<button class="btn sm" data-action="staff-edit" data-id="${s.id}">${MC.t('admin.staff.manage', 'Manage')}</button>`}</td></tr>`)}</tbody></table></div>` : empty({ icon: 'users', title: MC.t('admin.staff.empty', 'No staff yet'), body: MC.t('admin.staff.empty_sub', 'Add the people who will use the MediCore apps at your provider.') })}`);
    on('staff-add', async () => {
      const r = await dialog({ title: MC.t('admin.staff.add_title', 'Add a staff member'), form: true, body: html`
        <div class="field"><label for="sa-n">${MC.t('admin.staff.f.name', 'Full name')}</label><input class="input" id="sa-n" name="name" required></div>
        <div class="fields two"><div class="field"><label for="sa-e">${MC.t('admin.staff.f.email', 'Email')}</label><input class="input" id="sa-e" name="email" type="email" autocomplete="off"></div><div class="field"><label for="sa-p">${MC.t('admin.staff.f.phone', 'Phone')}</label><input class="input" id="sa-p" name="phone" inputmode="tel" placeholder="0803 123 4567"></div></div>
        <div class="field"><label for="sa-r">${MC.t('admin.staff.f.role', 'Role')}</label><select class="input" id="sa-r" name="role" required>${d.roles.map(r1 => html`<option value="${r1.key}">${r1.label}</option>`)}</select><div class="hint">${MC.t('admin.staff.f.role_hint', 'The role decides which app they use and what they can do.')}</div></div>
        <div class="field"><label for="sa-t">${MC.t('admin.staff.f.title_opt', 'Job title (optional)')}</label><input class="input" id="sa-t" name="title" placeholder="${MC.t('admin.staff.f.title_ph', 'e.g. Senior pharmacist')}"></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('admin.staff.add_submit', 'Add staff member'), primary: true }], onSubmit: v => api.post('/api/admin/staff', v) });
      if (!r) return;
      await dialog({ title: MC.t('admin.staff.added', '{name} added', { name: r.member.name }), body: r.tempPassword ? html`<p>${MC.t('admin.staff.temp_give', 'Give this temporary password to {name} privately. They will choose their own password when they first sign in.', { name: r.member.name })}</p><p class="notice"><b>${r.tempPassword}</b></p><p class="muted sm">${MC.t('admin.staff.temp_once', 'It will not be shown again.')}</p>` : html`<p>${r.note}</p>`, actions: [{ label: MC.t('admin.staff.done', 'Done'), primary: true, value: true }] });
      MC.render();
    });
    on('staff-edit', async el => {
      const s = d.staff.find(x => x.id === el.dataset.id); if (!s) return;
      const v = await dialog({ title: s.name, form: true, body: html`
        <div class="field"><label for="se-r">${MC.t('admin.staff.f.role', 'Role')}</label><select class="input" id="se-r" name="role">${d.roles.map(r1 => html`<option value="${r1.key}" ${r1.key === s.role ? 'selected' : ''}>${r1.label}</option>`)}</select></div>
        <div class="field"><label for="se-t">${MC.t('admin.staff.f.title', 'Job title')}</label><input class="input" id="se-t" name="title" value="${s.title || ''}"></div>
        <div class="field"><span class="label">${MC.t('admin.staff.f.extra', 'Extra permissions')}</span><div class="hint">${MC.t('admin.staff.f.extra_hint', 'You can only give permissions you hold yourself.')}</div>${d.grantable.filter(g => !s.perms.includes(g.key) || s.extraPerms.includes(g.key)).map(g => html`<label class="check"><input type="checkbox" name="extraPerms" data-list value="${g.key}" ${s.extraPerms.includes(g.key) ? 'checked' : ''}><span>${g.label}</span></label>`)}</div>
        <div class="field"><label for="se-s">${MC.t('admin.staff.f.access', 'Access')}</label><select class="input" id="se-s" name="status"><option value="active" ${s.status === 'active' ? 'selected' : ''}>${MC.t('admin.staff.access.active', 'Active')}</option><option value="suspended" ${s.status === 'suspended' ? 'selected' : ''}>${MC.t('admin.staff.access.suspended', 'Suspended (can be restored)')}</option><option value="removed">${MC.t('admin.staff.access.removed', 'Removed')}</option></select><div class="hint">${MC.t('admin.staff.f.access_hint', 'Suspending or removing signs them out straight away.')}</div></div>`,
        actions: [{ label: MC.t('admin.staff.reset_pw', 'Reset password'), value: 'reset' }, { label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('admin.staff.save', 'Save changes'), primary: true }],
        onSubmit: async f => { const body = { role: f.role, title: f.title || '', extraPerms: f.extraPerms || [] }; if (f.status !== s.status) { if (f.status !== 'active' && !(await confirm({ title: f.status === 'removed' ? MC.t('admin.staff.remove_q', 'Remove {name}?', { name: s.name }) : MC.t('admin.staff.suspend_q', 'Suspend {name}?', { name: s.name }), body: MC.t('admin.staff.signout_body', 'They will be signed out of every MediCore app at your provider now.'), ok: f.status === 'removed' ? MC.t('admin.staff.remove', 'Remove') : MC.t('admin.staff.suspend', 'Suspend'), danger: true }))) return false; body.status = f.status; } await api.patch('/api/admin/staff/' + s.id, body); return true; } });
      if (v === 'reset') {
        if (!(await confirm({ title: MC.t('admin.staff.reset_q', 'Reset {name}\'s password?', { name: s.name }), body: MC.t('admin.staff.reset_body', 'They will be signed out and must use a temporary password you give them.'), ok: MC.t('admin.staff.reset_pw', 'Reset password'), danger: true }))) return;
        const r = await api.post('/api/admin/staff/' + s.id + '/reset-password');
        await dialog({ title: MC.t('admin.staff.temp_title', 'Temporary password'), body: html`<p class="notice"><b>${r.tempPassword}</b></p><p class="muted sm">${r.note}</p>`, actions: [{ label: MC.t('admin.staff.done', 'Done'), primary: true }] });
      }
      if (v) { toast(MC.t('admin.staff.saved', 'Saved'), 'ok'); MC.render(); }
    });
  }

  /* ---------------- price list ---------------- */
  const CAT = ['consultation', 'video', 'procedure', 'lab', 'drug', 'delivery', 'ambulance', 'registration', 'other'];
  const catName = c => MC.t('admin.services.cat.' + c, cap(c));
  async function services() {
    const list = await api.get('/api/services');
    const byCat = {}; list.forEach(s => { (byCat[s.category] = byCat[s.category] || []).push(s); });
    view(html`<div class="page-head"><div><h1>${MC.t('admin.services.title', 'Price list')}</h1><p>${MC.t('admin.services.sub', 'Every bill is built from these prices. Staff cannot type their own amounts.')}</p></div><div class="actions"><button class="btn primary" data-action="svc-add">${icon('plus')}${MC.t('admin.services.add', 'Add item')}</button></div></div>
      ${list.length ? Object.keys(byCat).sort().map(c => html`<section class="panel flush"><h2>${catName(c)}</h2><div class="table-wrap" style="border:0"><table class="t stack-sm"><thead><tr><th>${MC.t('admin.services.col.code', 'Code')}</th><th>${MC.t('admin.services.col.name', 'Name')}</th><th class="num">${MC.t('admin.services.col.price', 'Price')}</th><th>${MC.t('admin.services.col.public', 'Shown to patients')}</th><th>${MC.t('admin.services.col.status', 'Status')}</th><th></th></tr></thead><tbody>${byCat[c].map(s => html`<tr><td data-label="${MC.t('admin.services.col.code', 'Code')}"><b>${s.code}</b></td><td data-label="${MC.t('admin.services.col.name', 'Name')}">${s.name}</td><td class="num" data-label="${MC.t('admin.services.col.price', 'Price')}">${naira(s.priceKobo)}</td><td data-label="${MC.t('admin.services.col.public', 'Shown to patients')}">${s.public === false ? MC.t('admin.services.no', 'No') : MC.t('admin.services.yes', 'Yes')}</td><td data-label="${MC.t('admin.services.col.status', 'Status')}">${s.active === false ? badge(MC.t('admin.services.inactive', 'Inactive'), 'warn') : badge(MC.t('admin.services.active', 'Active'), 'ok')}</td><td class="num"><button class="btn sm" data-action="svc-edit" data-id="${s.id}">${MC.t('admin.services.edit', 'Edit')}</button></td></tr>`)}</tbody></table></div></section>`) : empty({ icon: 'card', title: MC.t('admin.services.empty', 'No prices yet'), body: MC.t('admin.services.empty_sub', 'Add your consultation, registration and service prices.') })}`);
    const fields = s => html`<div class="fields two">${s ? '' : html`<div class="field"><label for="sv-c">${MC.t('admin.services.f.code', 'Code')}</label><input class="input" id="sv-c" name="code" required maxlength="24" placeholder="CONS-GP"></div>`}<div class="field"><label for="sv-cat">${MC.t('admin.services.f.category', 'Category')}</label><select class="input" id="sv-cat" name="category">${CAT.map(c => html`<option value="${c}" ${s && s.category === c ? 'selected' : ''}>${catName(c)}</option>`)}</select></div></div>
      <div class="field"><label for="sv-n">${MC.t('admin.services.f.name', 'Name')}</label><input class="input" id="sv-n" name="name" required value="${s ? s.name : ''}"></div>
      <div class="field"><label for="sv-p">${MC.t('admin.services.f.price', 'Price (NGN)')}</label><input class="input" id="sv-p" name="priceKobo" data-kobo type="number" min="0" step="50" required value="${s ? s.priceKobo / 100 : ''}"></div>
      <div class="field"><label for="sv-h">${MC.t('admin.services.f.hmo', 'HMO tariff code (optional)')}</label><input class="input" id="sv-h" name="hmoCode" value="${s && s.hmoCode ? s.hmoCode : ''}"></div>
      <label class="check"><input type="checkbox" name="public" ${!s || s.public !== false ? 'checked' : ''}><span>${MC.t('admin.services.f.public', 'Show this price to patients in the MediCore app')}</span></label>
      ${s ? html`<label class="check"><input type="checkbox" name="active" ${s.active !== false ? 'checked' : ''}><span>${MC.t('admin.services.f.active', 'Active')}</span></label>` : ''}`;
    on('svc-add', async () => { if (await dialog({ title: MC.t('admin.services.add_title', 'Add a price list item'), form: true, body: fields(null), actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('admin.services.add', 'Add item'), primary: true }], onSubmit: v => api.post('/api/services', v) })) { toast(MC.t('admin.services.added', 'Added'), 'ok'); MC.render(); } });
    on('svc-edit', async el => { const s = list.find(x => x.id === el.dataset.id); if (await dialog({ title: MC.t('admin.services.edit_title', 'Edit {code}', { code: s.code }), form: true, body: fields(s), actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('admin.services.save', 'Save changes'), primary: true }], onSubmit: v => api.patch('/api/services/' + s.id, v) })) { toast(MC.t('admin.services.saved', 'Saved'), 'ok'); MC.render(); } });
  }

  /* ---------------- settings ---------------- */
  async function settings() {
    const [o, cat] = await Promise.all([api.get('/api/admin/org'), getCatalog()]);
    void cat;
    const st = o.settings || {}; const isBranch = !!o.group; const set = o.settlement;
    const hasClinic = (o.modules || []).includes('clinic');
    // these two follow MediCore's setting (on) until the provider chooses; only send them once chosen
    const hqDefault = k => (typeof st[k] === 'boolean' ? st[k] : true);
    view(html`<div class="page-head"><div><h1>${MC.t('admin.settings.title', 'Provider settings')}</h1><p>${o.name} | ${cap(o.type)}</p></div></div>
      ${branchBanner(o)}
      <form data-form="org-save" class="panel" novalidate><h2>${MC.t('admin.settings.details', 'Details')}</h2>
        ${isBranch ? html`<div class="field"><span class="label">${MC.t('admin.settings.f.name', 'Name')}</span><div>${o.name}</div><div class="hint">${MC.t('admin.settings.name_by_group', 'Your group administrator names the branches.')}</div></div>`
          : html`<div class="field"><label for="o-n">${MC.t('admin.settings.f.name', 'Name')}</label><input class="input" id="o-n" name="name" value="${o.name}" required></div>`}
        <div class="fields two"><div class="field"><label for="o-p">${MC.t('admin.settings.f.phone', 'Phone')}</label><input class="input" id="o-p" name="phone" value="${(o.contact || {}).phone || ''}"></div><div class="field"><label for="o-e">${MC.t('admin.settings.f.email', 'Email')}</label><input class="input" id="o-e" name="email" type="email" value="${(o.contact || {}).email || ''}"></div></div>
        <div class="field"><label for="o-a">${MC.t('admin.settings.f.address', 'Address')}</label><input class="input" id="o-a" name="address" value="${(o.contact || {}).address || ''}"></div>
        <div class="fields three"><div class="field"><label for="o-ar">${MC.t('admin.settings.f.area', 'Area')}</label><input class="input" id="o-ar" name="area" value="${(o.location || {}).area || ''}"></div><div class="field"><label for="o-lat">${MC.t('admin.settings.f.lat', 'Latitude')}</label><input class="input" id="o-lat" name="lat" type="number" step="any" value="${(o.location || {}).lat ?? ''}"></div><div class="field"><label for="o-lng">${MC.t('admin.settings.f.lng', 'Longitude')}</label><input class="input" id="o-lng" name="lng" type="number" step="any" value="${(o.location || {}).lng ?? ''}"></div></div>
        <button type="button" class="btn sm" data-action="org-here">${icon('pin')}${MC.t('admin.settings.use_location', 'Use my current location')}</button>
        <div class="field" style="margin-top:16px"><label for="o-h">${MC.t('admin.settings.f.hours', 'Opening hours')}</label><input class="input" id="o-h" name="openingHours" value="${st.openingHours || ''}"></div>
        <h2 style="margin-top:24px">${MC.t('admin.settings.team', 'How your team works')}</h2>
        <label class="check"><input type="checkbox" name="requireClockIn" ${st.requireClockIn !== false ? 'checked' : ''}><span>${MC.t('admin.settings.require_clock_in', 'Staff must clock in before they can work on cases')}</span></label>
        <label class="check"><input type="checkbox" name="strictGeofence" ${st.strictGeofence ? 'checked' : ''}><span>${MC.t('admin.settings.strict_geofence', 'Only allow clock-in on site')}</span></label>
        <div class="field"><label for="o-g">${MC.t('admin.settings.geofence_m', 'On-site distance (metres)')}</label><input class="input" id="o-g" name="geofenceM" type="number" min="50" max="5000" value="${st.geofenceM || 300}"></div>
        ${o.modules.includes('lab') ? html`<label class="check"><input type="checkbox" name="twoStepLabVerify" ${st.twoStepLabVerify ? 'checked' : ''}><span>${MC.t('admin.settings.two_step_lab', 'Lab results need a second scientist to verify')}</span></label>` : ''}
        ${o.modules.includes('delivery') ? html`<label class="check"><input type="checkbox" name="selfClaimDeliveries" ${st.selfClaimDeliveries ? 'checked' : ''}><span>${MC.t('admin.settings.self_claim', 'Riders can pick up delivery jobs themselves')}</span></label><div class="field"><label for="o-df">${MC.t('admin.settings.delivery_fee', 'Delivery fee (NGN)')}</label><input class="input" id="o-df" name="deliveryFeeKobo" data-kobo type="number" min="0" value="${(st.deliveryFeeKobo || 0) / 100}"></div>` : ''}
        <h2 style="margin-top:24px">${MC.t('admin.settings.patients_network', 'Patients and other providers')}</h2>
        <label class="check"><input type="checkbox" name="marketplace" ${st.marketplace !== false ? 'checked' : ''}><span>${MC.t('admin.settings.marketplace', 'Patients can find us in the MediCore app')}</span></label>
        <label class="check"><input type="checkbox" name="acceptsWalkIns" ${st.acceptsWalkIns !== false ? 'checked' : ''}><span>${MC.t('admin.settings.walk_ins', 'We accept walk-in patients')}</span></label>
        ${hasClinic ? html`<label class="check"><input type="checkbox" name="acceptsOnlineBooking" ${st.acceptsOnlineBooking !== false ? 'checked' : ''}><span>${MC.t('admin.settings.online_booking', 'Patients can book appointments in the app')}<br><span class="muted sm">${MC.t('admin.settings.online_booking_hint', 'When off, patients are asked to call or come to the front desk to book.')}</span></span></label>` : ''}
        <label class="check"><input type="checkbox" name="acceptsPatientApplications" ${st.acceptsPatientApplications !== false ? 'checked' : ''}><span>${MC.t('admin.settings.applications', 'Let patients apply to register in the app')}</span></label>
        <label class="check"><input type="checkbox" name="applicationsNeedApproval" ${hqDefault('applicationsNeedApproval') ? 'checked' : ''}><span>${MC.t('admin.settings.applications_approval', 'Patient applications need our approval')}<br><span class="muted sm">${MC.t('admin.settings.applications_approval_hint', 'When off, patients who apply are registered straight away.')}</span></span></label>
        ${hasClinic && MC.feature('videoVisits') ? html`<label class="check"><input type="checkbox" name="payBeforeVideo" ${hqDefault('payBeforeVideo') ? 'checked' : ''}><span>${MC.t('admin.settings.pay_before_video', 'Patients pay before a video visit')}<br><span class="muted sm">${MC.t('admin.settings.pay_before_video_hint', 'When on, the patient cannot join the video call until the bill is paid.')}</span></span></label>` : ''}
        <label class="check"><input type="checkbox" name="networkListed" ${st.networkListed !== false ? 'checked' : ''}><span>${MC.t('admin.settings.network_listed', 'List us in the provider network')}<br><span class="muted sm">${MC.t('admin.settings.network_listed_hint', 'Other providers on MediCore can find you, ask to partner and refer patients. Patients never see this list.')}</span></span></label>
        <label class="check"><input type="checkbox" name="acceptsReferrals" ${st.acceptsReferrals !== false ? 'checked' : ''}><span>${MC.t('admin.settings.accepts_referrals', 'Accept referrals from other providers')}</span></label>
        <label class="check"><input type="checkbox" name="referralsFromPartnersOnly" ${st.referralsFromPartnersOnly ? 'checked' : ''}><span>${MC.t('admin.settings.partners_only', 'Accept referrals only from our partners')}<br><span class="muted sm">${MC.t('admin.settings.partners_only_hint', 'Other providers must partner with you in the provider network before they can refer patients.')}</span></span></label>
        <div class="form-err notice bad" hidden></div><div class="btn-row"><button class="btn primary" type="submit">${MC.t('admin.settings.save', 'Save settings')}</button></div></form>
      <section class="panel"><h2>${MC.t('admin.settings.apps', 'Apps')}</h2>${o.modulesManagedByGroup
        ? html`<p class="muted sm">${MC.t('admin.settings.apps_group', 'Your group manages the apps and subscription of every branch. Ask your group administrator to add or remove apps.')}</p><a class="btn" href="#/subscription">${icon('box')}${MC.t('admin.settings.see_apps', 'See apps and subscription')}</a>`
        : html`<p class="muted sm">${MC.t('admin.settings.apps_sub', 'Add or remove apps (pharmacy, lab, ambulance and more) on the subscription page. The price updates as you choose.')}</p><a class="btn" href="#/subscription">${icon('box')}${MC.t('admin.settings.manage_apps', 'Manage apps and subscription')}</a>`}</section>
      ${isBranch ? html`<section class="panel"><h2>${MC.t('admin.settle.title', 'Settlement account')}</h2><p class="muted sm">${MC.t('admin.settle.by_group', 'Your group finance team sets the settlement account for this branch.')}</p>${set && set.accountNumber ? html`<dl class="kv"><dt>${MC.t('admin.settle.bank', 'Bank')}</dt><dd>${set.bankName || '-'}</dd><dt>${MC.t('admin.settle.number', 'Account number')}</dt><dd>${set.accountNumber}</dd><dt>${MC.t('admin.settle.name', 'Account name')}</dt><dd>${set.accountName || '-'}</dd></dl>` : ''}</section>`
        : has('admin.finance') ? html`<section class="panel"><h2>${MC.t('admin.settle.title', 'Settlement account')}</h2><p class="muted sm">${MC.t('admin.settle.sub', 'Online payments from your patients are paid into this account.')}</p>
          ${set && (set.accountNumber || set.subaccount) ? html`<dl class="kv" style="margin-bottom:16px"><dt>${MC.t('admin.settle.bank', 'Bank')}</dt><dd>${set.bankName || '-'}</dd><dt>${MC.t('admin.settle.number', 'Account number')}</dt><dd>${set.accountNumber || '-'}</dd><dt>${MC.t('admin.settle.name', 'Account name')}</dt><dd>${set.accountName || '-'}</dd><dt>${MC.t('admin.settle.subaccount', 'Gateway subaccount')}</dt><dd>${set.subaccount || '-'}</dd></dl>` : html`<div class="notice">${MC.t('admin.settle.none', 'No settlement account yet.')}</div>`}
          <form data-form="org-settle" novalidate>
            <div class="fields two"><div class="field"><label for="st-b">${MC.t('admin.settle.bank', 'Bank')}</label><input class="input" id="st-b" name="bankName" maxlength="80" value="${(set && set.bankName) || ''}"></div><div class="field"><label for="st-c">${MC.t('admin.settle.code', 'Bank code (optional)')}</label><input class="input" id="st-c" name="bankCode" maxlength="12" value="${(set && set.bankCode) || ''}"></div></div>
            <div class="fields two"><div class="field"><label for="st-n">${MC.t('admin.settle.number', 'Account number')}</label><input class="input" id="st-n" name="accountNumber" inputmode="numeric" maxlength="10" autocomplete="off" placeholder="${set && set.accountNumber ? set.accountNumber : '0123456789'}"><div class="hint">${set && set.accountNumber ? MC.t('admin.settle.number_keep', '10 digits. Leave empty to keep {masked}.', { masked: set.accountNumber }) : MC.t('admin.settle.number_hint', '10 digits (NUBAN)')}</div></div><div class="field"><label for="st-an">${MC.t('admin.settle.name', 'Account name')}</label><input class="input" id="st-an" name="accountName" maxlength="120" value="${(set && set.accountName) || ''}"></div></div>
            <div class="field"><label for="st-s">${MC.t('admin.settle.subaccount_opt', 'Gateway subaccount code (optional)')}</label><input class="input" id="st-s" name="subaccount" maxlength="80" value="${(set && set.subaccount) || ''}"><div class="hint">${MC.t('admin.settle.subaccount_hint', 'From your Paystack, Flutterwave or Monnify dashboard, if you have one.')}</div></div>
            <div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${MC.t('admin.settle.save', 'Save settlement account')}</button></form></section>` : ''}
      ${o.canConvertToGroup ? html`<section class="panel"><h2>${MC.t('admin.convert.title', 'Add branches')}</h2>
        <p>${MC.t('admin.convert.body', 'Opening another location? Turn this provider into a group with branches. This location becomes your first branch and keeps its staff, patients, prices and apps. You then add and run branches from the group console.')}</p>
        <p class="muted sm">${MC.t('admin.convert.patients', 'A patient registered at one branch can be seen at every branch of the group, with one record number.')}</p>
        <button class="btn" data-action="org-convert">${icon('building')}${MC.t('admin.convert.start', 'Set up branches')}</button></section>` : ''}
      <section class="panel"><h2>${MC.t('admin.settings.contacts', 'Contact numbers')}</h2><p class="muted sm">${MC.t('admin.settings.contacts_sub', 'Phone and WhatsApp numbers for each department, as patients see them in the app.')}</p><a class="btn" href="#/contacts">${icon('phone')}${MC.t('admin.settings.contacts_go', 'Edit contact numbers')}</a></section>
      ${has('admin.privacy') ? html`<section class="panel" id="privacy"><h2>${MC.t('admin.export.title', 'Your data')}</h2>
        <p>${MC.t('admin.export.body', 'Download a copy of everything {name} holds on MediCore: patients, staff, visits, prescriptions, lab orders, bills, payments, referrals and HMO records. The file is in JSON format, which other systems and spreadsheets can import.', { name: o.name })}</p>
        <p class="muted sm">${MC.t('admin.export.limits', 'Only the owner or the data protection lead can download it. You can download it up to 5 times a day, and every download is recorded in the audit log.')}</p>
        <button class="btn" data-action="org-export">${icon('download')}${MC.t('admin.export.button', 'Download all our records')}</button></section>` : ''}`);
    form('org-save', async d => {
      const body = { contact: {}, location: {}, settings: {} };
      if (!isBranch && d.name) body.name = d.name;
      ['phone', 'email', 'address'].forEach(k => { if (d[k]) body.contact[k] = d[k]; });
      if (d.area) body.location.area = d.area; if (d.lat != null) body.location.lat = d.lat; if (d.lng != null) body.location.lng = d.lng;
      ['requireClockIn', 'strictGeofence', 'twoStepLabVerify', 'selfClaimDeliveries', 'marketplace', 'acceptsWalkIns', 'acceptsPatientApplications', 'networkListed', 'acceptsReferrals', 'acceptsOnlineBooking', 'referralsFromPartnersOnly'].forEach(k => { if (d[k] !== undefined) body.settings[k] = d[k]; });
      ['applicationsNeedApproval', 'payBeforeVideo'].forEach(k => { if (d[k] !== undefined && (typeof st[k] === 'boolean' || d[k] !== hqDefault(k))) body.settings[k] = d[k]; });
      if (d.geofenceM) body.settings.geofenceM = d.geofenceM; if (d.deliveryFeeKobo !== undefined) body.settings.deliveryFeeKobo = d.deliveryFeeKobo; if (d.openingHours) body.settings.openingHours = d.openingHours;
      if (!Object.keys(body.location).length) delete body.location;
      if (!Object.keys(body.contact).length) delete body.contact;
      await api.patch('/api/admin/org', body); Object.assign(st, body.settings); toast(MC.t('admin.settings.saved', 'Settings saved'), 'ok');
    });
    on('org-export', async () => {
      if (!(await confirm({ title: MC.t('admin.export.q', 'Download all your records?'), body: MC.t('admin.export.q_body', 'The file holds the personal and medical details of every patient at {name}. Save it only on a secure device and do not share it by email or chat.', { name: o.name }), ok: MC.t('admin.export.do', 'Download records') }))) return;
      const r = await downloadFile('/api/admin/export', (o.code || 'provider') + '-export.json');
      toast(MC.t('admin.export.done', 'Records downloaded as {file}', { file: r.name }), 'ok');
    });
    form('org-settle', async f => {
      if (f.accountNumber && !/^\d{10}$/.test(f.accountNumber)) throw fail(MC.t('admin.settle.number_bad', 'The account number must be exactly 10 digits'), 'accountNumber');
      if (f.bankCode && !/^[0-9A-Za-z]*$/.test(f.bankCode)) throw fail(MC.t('admin.settle.code_bad', 'The bank code can only have letters and numbers'), 'bankCode');
      const body = {}; ['bankName', 'bankCode', 'accountNumber', 'accountName', 'subaccount'].forEach(k => { if (f[k]) body[k] = f[k]; });
      if (!Object.keys(body).length) throw fail(MC.t('admin.settle.empty', 'Fill in the account details first'));
      if (!(await confirm({ title: MC.t('admin.settle.q', 'Save this settlement account?'), body: MC.t('admin.settle.q_body', 'Online payments from your patients will be paid into this account from now on.'), ok: MC.t('admin.settle.save', 'Save settlement account') }))) return;
      await api.patch('/api/admin/org/settlement', body);
      toast(MC.t('admin.settle.saved', 'Settlement account saved'), 'ok'); MC.render();
    });
    on('org-convert', async () => {
      const v = await dialog({ title: MC.t('admin.convert.title', 'Add branches'), form: true, body: html`
        <p>${MC.t('admin.convert.dlg_body', 'Give your group a name, and a branch name for this location. Patients will see this location as group name - branch name.')}</p>
        <div class="field"><label for="cv-g">${MC.t('admin.convert.group_name', 'Group name')}</label><input class="input" id="cv-g" name="groupName" required minlength="3" maxlength="120" value="${o.name}"></div>
        <div class="field"><label for="cv-b">${MC.t('admin.convert.branch_name', 'Branch name for this location')}</label><input class="input" id="cv-b" name="branchName" required minlength="2" maxlength="80" placeholder="${MC.t('admin.convert.branch_ph', 'e.g. Lekki or Main branch')}"></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('admin.convert.next', 'Continue'), primary: true }],
        onSubmit: f => { if (!f.groupName || f.groupName.trim().length < 3) throw fail(MC.t('admin.convert.need_group', 'Enter a group name of at least 3 characters'), 'groupName'); if (!f.branchName || f.branchName.trim().length < 2) throw fail(MC.t('admin.convert.need_branch', 'Enter a branch name of at least 2 characters'), 'branchName'); return f; } });
      if (!v) return;
      if (!(await confirm({ title: MC.t('admin.convert.q', 'Turn {name} into a group?', { name: o.name }), body: MC.t('admin.convert.q_body', 'This location becomes the {branch} branch of {group}. This cannot be undone here. You will run apps, subscription and new branches from the group console.', { branch: v.branchName, group: v.groupName }), ok: MC.t('admin.convert.do', 'Create group') }))) return;
      const r = await api.post('/api/admin/org/convert-to-group', { groupName: v.groupName, branchName: v.branchName });
      if (MC.me) MC.me.isGroupAdmin = true;
      toast(MC.t('admin.convert.done_toast', 'Group created'), 'ok');
      await dialog({ title: MC.t('admin.convert.done', '{group} is ready', { group: r.group.name }), body: html`<p>${MC.t('admin.convert.done_body', 'Open the group console to add your next branch. Sign in there with the same email and password you use here.')}</p><p><a class="btn primary" href="/group.html">${icon('building')}${MC.t('admin.branch.open_group', 'Open the group console')}</a></p>`, actions: [{ label: MC.t('admin.convert.stay', 'Stay in this admin app'), value: true }] });
      MC.render();
    });
    on('org-here', async () => { const p = await MC.position(); if (!p) return toast(MC.t('admin.settings.no_location', 'Location is not available. Allow location access and try again.'), 'bad'); document.getElementById('o-lat').value = p.lat.toFixed(6); document.getElementById('o-lng').value = p.lng.toFixed(6); toast(MC.t('admin.settings.location_filled', 'Location filled in. Save to keep it.')); });
  }

  /* ---------------- subscription: pick your own apps ---------------- */
  async function toggleModule(m, enable) {
    const first = await api.post('/api/admin/org/modules', { module: m, enabled: enable });
    if (!first.needsConfirm) { MC.render(); return; }
    const q = first.quote; const diff = q.monthlyKobo - (first.currentMonthlyKobo || 0);
    const ok = await confirm({ title: enable ? MC.t('admin.sub.add_q', 'Add {app}?', { app: q.lines.find(l => l.key === m) ? q.lines.find(l => l.key === m).label : cap(m) }) : MC.t('admin.sub.remove_q', 'Switch off {app}?', { app: cap(m) }),
      body: MC.t('admin.sub.price_change', 'Your monthly subscription becomes {price} ({diff} a month). Staff using this app get or lose access straight away.', { price: money(q.monthlyKobo), diff: (diff >= 0 ? '+' : '-') + money(Math.abs(diff)) }), ok: enable ? MC.t('admin.sub.add', 'Add app') : MC.t('admin.sub.remove', 'Switch off'), danger: !enable });
    if (!ok) return;
    const r = await api.post('/api/admin/org/modules', { module: m, enabled: enable, confirmPriceKobo: q.monthlyKobo });
    if (r.requested) toast(MC.t('admin.sub.requested', 'Request {ticket} sent to MediCore', { ticket: r.ticket }), 'ok'); else toast(enable ? MC.t('admin.sub.added', 'App added') : MC.t('admin.sub.removed', 'App switched off'), 'ok');
    MC.render();
  }
  async function subscription() {
    const [o, pricing] = await Promise.all([api.get('/api/admin/org'), api.get('/api/pricing')]);
    const sub = o.subscription || {}; const q = o.quote;
    const service = Object.keys(pricing.modulesKobo).filter(m => m !== 'payer' && o.allowedModules.includes(m));
    const ro = !!o.modulesManagedByGroup;
    view(html`<div class="page-head"><div><h1>${MC.t('admin.sub.title', 'Subscription')}</h1><p>${ro ? MC.t('admin.sub.sub_group', 'The apps this branch uses and what they cost.') : MC.t('admin.sub.sub', 'Choose exactly the apps your provider uses. You pay only for what is switched on.')}</p></div></div>
      ${branchBanner(o)}
      ${figures([{ value: money(q.monthlyKobo), label: MC.t('admin.sub.monthly', 'Per month') }, { value: MC.t('status.' + (sub.status || 'trial'), cap(sub.status || 'trial')), label: MC.t('admin.sub.status', 'Status'), tone: sub.status === 'past_due' ? 'bad' : '' }, { value: sub.trialEnds && sub.status === 'trial' ? date(sub.trialEnds) : '-', label: MC.t('admin.sub.trial_ends', 'Trial ends') }, { value: String(sub.seats || q.seats.included), label: MC.t('admin.sub.seats', 'Staff accounts') }])}
      <section class="panel flush"><h2>${MC.t('admin.sub.apps', 'Your apps')}</h2>
        <ul class="list"><li><div class="grow"><span class="title">${MC.t('admin.sub.core', 'Core package')}</span><span class="sub">${MC.t('admin.sub.core_desc', 'Patient app, front desk, admin console and HMO billing. Always included.')}</span></div><span class="end"><b>${money(pricing.baseKobo)}</b></span></li>
        ${service.map(m => { const onNow = o.modules.includes(m); const meta = pricing.modules[m] || {}; return html`<li><div class="grow"><span class="title">${meta.label || cap(m)} ${onNow ? badge(MC.t('admin.sub.on', 'On'), 'ok') : ''}</span><span class="sub">${meta.desc || ''}${meta.desc && !/[.]$/.test(meta.desc) ? '.' : ''}${(meta.requires || []).length ? ' ' + MC.t('admin.sub.needs', 'Needs {apps}.', { apps: meta.requires.map(cap).join(' or ') }) : ''}</span></div><span class="end"><b>${money(pricing.modulesKobo[m])}</b>${ro ? '' : html`<br><button class="btn sm ${onNow ? '' : 'primary'}" data-action="sub-toggle" data-m="${m}" data-on="${onNow ? '1' : ''}">${onNow ? MC.t('admin.sub.remove', 'Switch off') : MC.t('admin.sub.add', 'Add app')}</button>`}</span></li>`; })}</ul></section>
      <section class="panel"><h2>${MC.t('admin.sub.breakdown', 'Price breakdown')}</h2>
        <dl class="kv money">${q.lines.map(l => html`<dt>${l.label}</dt><dd>${money(l.kobo)}</dd>`)}${q.discount ? html`<dt>${MC.t('admin.sub.discount', 'Bundle discount ({p}%)', { p: q.discount.percent })}</dt><dd>-${money(q.discount.kobo)}</dd>` : ''}${q.seats.extra ? html`<dt>${MC.t('admin.sub.extra_seats', '{n} extra staff accounts', { n: q.seats.extra })}</dt><dd>${money(q.seats.kobo)}</dd>` : ''}<dt><b>${MC.t('admin.sub.total', 'Monthly total')}</b></dt><dd><b>${money(q.monthlyKobo)}</b></dd><dt>${MC.t('admin.sub.bank', 'Bank service charge per payment')}</dt><dd>${money(q.bankChargePerPaymentKobo)}</dd></dl>
        <p class="muted sm">${MC.t('admin.sub.annual', 'Paying yearly? You pay for {n} months and get 12.', { n: pricing.annualMonthsCharged })}</p>
        ${ro ? '' : html`<div class="btn-row"><a class="btn" href="#/support/new?category=billing_subscription">${icon('message')}${MC.t('admin.sub.ask', 'Ask MediCore about billing')}</a></div>`}</section>`);
    on('sub-toggle', async el => toggleModule(el.dataset.m, !el.dataset.on));
  }

  /* ---------------- support: complaints and requests to MediCore ---------------- */
  const CATS = { billing_subscription: 'Billing and subscription', technical_problem: 'Something is not working', feature_request: 'Request a feature', data_correction: 'Correct some data', account_access: 'Account or sign-in', complaint: 'Complaint', integration: 'Payments, SMS or HMO connection', training: 'Training for my staff', other: 'Other' };
  const catLabel = c => MC.t('admin.support.cat.' + c, CATS[c] || cap(c));
  async function support() {
    const rows = await api.get('/api/admin/support');
    view(html`<div class="page-head"><div><h1>${MC.t('admin.support.title', 'Support')}</h1><p>${MC.t('admin.support.sub', 'Report a problem, make a complaint or ask for a change. The MediCore team replies here.')}</p></div><div class="actions"><a class="btn primary" href="#/support/new">${icon('plus')}${MC.t('admin.support.new', 'New request')}</a></div></div>
      ${rows.length ? html`<div class="list">${rows.map(r => html`<a href="#/support/${r.id}"><div class="grow"><span class="title">${r.subject}</span><span class="sub">${r.number} | ${catLabel(r.category)} | ${ago(r.updatedAt)}</span></div>${MC.statusBadge(r.status)}</a>`)}</div>` : empty({ icon: 'message', title: MC.t('admin.support.empty', 'No requests yet'), body: MC.t('admin.support.empty_sub', 'When you raise a request, you can follow it here.') })}`);
  }
  async function supportNew({ query }) {
    view(html`<a class="back" href="#/support">${icon('left')}${MC.t('admin.support.title', 'Support')}</a><div class="page-head"><div><h1>${MC.t('admin.support.new', 'New request')}</h1></div></div>
      <form class="panel" data-form="ticket-new" novalidate>
        <div class="field"><label for="tk-c">${MC.t('admin.support.about', 'What is it about?')}</label><select class="input" id="tk-c" name="category">${Object.keys(CATS).map(c => html`<option value="${c}" ${query.category === c ? 'selected' : ''}>${catLabel(c)}</option>`)}</select></div>
        <div class="field"><label for="tk-p">${MC.t('admin.support.urgency', 'How urgent?')}</label><select class="input" id="tk-p" name="priority"><option value="normal">${MC.t('admin.support.p.normal', 'Normal: reply within 2 days')}</option><option value="high">${MC.t('admin.support.p.high', 'High: it is slowing us down')}</option><option value="urgent">${MC.t('admin.support.p.urgent', 'Urgent: we cannot work')}</option><option value="low">${MC.t('admin.support.p.low', 'Low: whenever you can')}</option></select></div>
        <div class="field"><label for="tk-s">${MC.t('admin.support.subject', 'Subject')}</label><input class="input" id="tk-s" name="subject" required maxlength="140"></div>
        <div class="field"><label for="tk-t">${MC.t('admin.support.details', 'Details')}</label><textarea class="input" id="tk-t" name="text" required maxlength="4000"></textarea><div class="hint">${MC.t('admin.support.details_hint', 'Do not include patient names or medical details.')}</div></div>
        <div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${MC.t('admin.support.send', 'Send to MediCore')}</button></form>`);
    form('ticket-new', async d => { const r = await api.post('/api/admin/support', d); toast(MC.t('admin.support.sent', 'Request {n} sent', { n: r.number }), 'ok'); MC.go('#/support/' + r.id); });
  }
  async function supportView({ params }) {
    const r = await api.get('/api/admin/support/' + params.id);
    view(html`<a class="back" href="#/support">${icon('left')}${MC.t('admin.support.title', 'Support')}</a><div class="page-head"><div><h1>${r.subject}</h1><p>${r.number} | ${catLabel(r.category)} | ${MC.statusBadge(r.status)}</p></div>
      ${r.status !== 'closed' ? html`<div class="actions"><button class="btn" data-action="ticket-close">${MC.t('admin.support.close', 'Close request')}</button></div>` : ''}</div>
      <ol class="timeline">${r.messages.map(m => html`<li><time>${dateTime(m.at)} | ${m.side === 'medicore' ? MC.t('admin.support.team', 'MediCore team') : m.byName}</time>${m.text}</li>`)}</ol>
      ${r.status !== 'closed' ? html`<form class="panel" data-form="ticket-reply" novalidate style="margin-top:16px"><div class="field"><label for="tr-t">${MC.t('admin.support.reply', 'Reply')}</label><textarea class="input" id="tr-t" name="text" required></textarea></div><button class="btn primary" type="submit">${MC.t('admin.support.send_reply', 'Send reply')}</button></form>` : ''}`);
    form('ticket-reply', async d => { await api.post('/api/admin/support/' + r.id + '/reply', d); toast(MC.t('admin.support.replied', 'Reply sent'), 'ok'); MC.render(); });
    on('ticket-close', async () => {
      const v = await dialog({ title: MC.t('admin.support.close', 'Close request'), form: true, body: html`<div class="field"><label for="rt">${MC.t('admin.support.rate', 'How did we do? (1 to 5)')}</label><select class="input" id="rt" name="rating"><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select></div>`, actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('admin.support.close', 'Close request'), primary: true }], onSubmit: d => api.post('/api/admin/support/' + r.id + '/close', { rating: Number(d.rating) }) });
      if (v) { toast(MC.t('admin.support.closed', 'Request closed'), 'ok'); MC.render(); }
    });
  }

  /* ---------------- attendance ---------------- */
  async function attendance() {
    const rows = await api.get('/api/shift/attendance');
    view(html`<div class="page-head"><div><h1>${MC.t('admin.attendance.title', 'Attendance')}</h1><p>${MC.t('admin.attendance.sub', 'Clock-ins for the last 14 days')}</p></div></div>
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${MC.t('admin.attendance.col.name', 'Name')}</th><th>${MC.t('admin.attendance.col.role', 'Role')}</th><th>${MC.t('admin.attendance.col.in', 'Clocked in')}</th><th>${MC.t('admin.attendance.col.out', 'Clocked out')}</th><th class="num">${MC.t('admin.attendance.col.hours', 'Hours')}</th><th>${MC.t('admin.attendance.col.location', 'Location')}</th></tr></thead><tbody>${rows.map(s => html`<tr><td data-label="${MC.t('admin.attendance.col.name', 'Name')}"><b>${s.name}</b></td><td data-label="${MC.t('admin.attendance.col.role', 'Role')}">${cap(s.role)}</td><td data-label="${MC.t('admin.attendance.label.in', 'In')}">${dateTime(s.in)}</td><td data-label="${MC.t('admin.attendance.label.out', 'Out')}">${s.out ? dateTime(s.out) : badge(MC.t('admin.attendance.on_shift', 'On shift'), 'ok')}</td><td class="num" data-label="${MC.t('admin.attendance.col.hours', 'Hours')}">${s.minutes != null ? (s.minutes / 60).toFixed(1) : ''}</td><td data-label="${MC.t('admin.attendance.col.location', 'Location')}">${s.onSite === true ? badge(MC.t('admin.attendance.on_site', 'On site'), 'ok') : s.onSite === false ? badge(MC.t('admin.attendance.away', '{m} m away', { m: s.distanceM }), 'warn') : badge(MC.t('admin.attendance.no_location', 'No location'), 'outline')}</td></tr>`)}</tbody></table></div>` : empty({ icon: 'clock', title: MC.t('admin.attendance.empty', 'No clock-ins yet') })}`);
  }

  /* ---------------- audit ---------------- */
  async function audit({ query }) {
    const rows = await api.get('/api/admin/audit' + qs({ action: query.action, before: query.before, limit: 100 }));
    view(html`<div class="page-head"><div><h1>${MC.t('admin.audit.title', 'Audit log')}</h1><p>${MC.t('admin.audit.sub', 'Every change and every view of a patient record at your provider')}</p></div></div>
      <form data-form="audit-filter" class="row wrap" style="margin-bottom:16px"><input class="input" name="action" placeholder="${MC.t('admin.audit.filter_ph', 'Filter by action, e.g. patient.view')}" value="${query.action || ''}" style="max-width:320px"><button class="btn" type="submit">${MC.t('admin.audit.filter', 'Filter')}</button></form>
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${MC.t('admin.audit.col.when', 'When')}</th><th>${MC.t('admin.audit.col.who', 'Who')}</th><th>${MC.t('admin.audit.col.action', 'Action')}</th><th>${MC.t('admin.audit.col.record', 'Record')}</th></tr></thead><tbody>${rows.map(a => html`<tr><td data-label="${MC.t('admin.audit.col.when', 'When')}">${dateTime(a.at)}</td><td data-label="${MC.t('admin.audit.col.who', 'Who')}">${a.actorName || MC.t('admin.audit.public', 'Public')}${a.role ? html`<br><span class="xs muted">${cap(a.role)}</span>` : ''}</td><td data-label="${MC.t('admin.audit.col.action', 'Action')}"><b>${a.action}</b></td><td data-label="${MC.t('admin.audit.col.record', 'Record')}" class="xs">${a.targetType || ''} ${a.targetId || ''}</td></tr>`)}</tbody></table></div>
      ${rows.length === 100 ? html`<div class="btn-row"><a class="btn" href="#/audit?${'before=' + rows[rows.length - 1].at}${query.action ? '&action=' + encodeURIComponent(query.action) : ''}">${MC.t('admin.audit.older', 'Older entries')}</a></div>` : ''}` : empty({ icon: 'shield', title: MC.t('admin.audit.empty', 'No entries') })}`);
    form('audit-filter', d => MC.go('#/audit' + qs({ action: d.action })));
  }

  /* ---------------- provider network: directory, partnerships, messages ---------------- */
  const NTYPES = ['hospital', 'clinic', 'pharmacy', 'ambulance', 'lab', 'other'];
  const ntype = k => ({ hospital: MC.t('admin.net.type.hospital', 'Hospitals'), clinic: MC.t('admin.net.type.clinic', 'Clinics'), pharmacy: MC.t('admin.net.type.pharmacy', 'Pharmacies'), ambulance: MC.t('admin.net.type.ambulance', 'Ambulance services'), lab: MC.t('admin.net.type.lab', 'Laboratories'), other: MC.t('admin.net.type.other', 'Other services') }[k] || cap(k));
  function connBadge(p) {
    if (p.sameGroup) return badge(MC.t('admin.net.same_group', 'Your group'), 'hue');
    const c = p.connection; if (!c) return '';
    if (c.status === 'accepted') return badge(MC.t('admin.net.partner', 'Partner'), 'ok');
    return c.direction === 'in' ? badge(MC.t('admin.net.asked_you', 'Asked to partner with you'), 'warn') : badge(MC.t('admin.net.request_sent', 'Request sent'), 'info');
  }
  async function netCounts() {
    if (!has('network.manage')) return { requests: 0, unread: 0 };
    const [conns, th] = await Promise.all([api.get('/api/network/connections').catch(() => []), api.get('/api/network/threads').catch(() => ({ unreadTotal: 0 }))]);
    const requests = conns.filter(c => c.status === 'pending' && c.direction === 'in').length;
    MC.navCount('#/network', requests + (th.unreadTotal || 0));
    return { requests, unread: th.unreadTotal || 0, conns, threads: th.threads };
  }
  const netTabs = (cur, n) => html`<nav class="tabs" aria-label="${MC.t('admin.net.title', 'Provider network')}"><a href="#/network" ${cur === 'dir' ? html`aria-current="page"` : ''}>${MC.t('admin.net.tab.directory', 'Directory')}</a><a href="#/network/partners" ${cur === 'partners' ? html`aria-current="page"` : ''}>${MC.t('admin.net.tab.partners', 'Partnerships')}${n && n.requests ? ' (' + n.requests + ')' : ''}</a><a href="#/network/messages" ${cur === 'messages' ? html`aria-current="page"` : ''}>${MC.t('admin.net.tab.messages', 'Messages')}${n && n.unread ? ' (' + n.unread + ')' : ''}</a></nav>`;
  const netHead = () => html`<div class="page-head"><div><h1>${MC.t('admin.net.title', 'Provider network')}</h1><p>${MC.t('admin.net.sub', 'Find other providers on MediCore, partner with them and message them. Patients never see this.')}</p></div></div>`;

  async function netDirectory({ query, stale }) {
    const [rows, n] = await Promise.all([api.get('/api/network/providers' + qs({ q: query.q, type: query.type, partners: query.partners === '1' ? 'true' : undefined, limit: 100 })), netCounts()]);
    if (stale()) return;
    const filtered = query.q || query.type || query.partners;
    view(html`${netHead()}${netTabs('dir', n)}
      <form data-form="net-filter" class="panel" novalidate><div class="fields two">
        <div class="field"><label for="nf-q">${MC.t('admin.net.f.search', 'Search')}</label><div class="search">${icon('search')}<input class="input" id="nf-q" name="q" type="search" maxlength="60" value="${query.q || ''}" placeholder="${MC.t('admin.net.f.search_ph', 'Name, area or city')}"></div></div>
        <div class="field"><label for="nf-t">${MC.t('admin.net.f.type', 'Type')}</label><select class="input" id="nf-t" name="type"><option value="">${MC.t('admin.net.f.all_types', 'All types')}</option>${NTYPES.map(k => html`<option value="${k}" ${query.type === k ? 'selected' : ''}>${ntype(k)}</option>`)}</select></div></div>
        <label class="check"><input type="checkbox" name="partners" ${query.partners === '1' ? 'checked' : ''}><span>${MC.t('admin.net.f.partners', 'Only our partners and our group\'s branches')}</span></label>
        <div class="row wrap"><button class="btn" type="submit">${icon('search')}${MC.t('admin.net.f.find', 'Find providers')}</button>${filtered ? html`<a class="btn ghost" href="#/network">${MC.t('admin.net.f.clear', 'Clear filters')}</a>` : ''}</div></form>
      ${rows.length ? html`<div class="list">${rows.map(p => html`<a href="#/network/p/${p.id}"><div class="grow"><span class="title">${p.name} ${connBadge(p)}</span><span class="sub">${p.typeLabel || cap(p.type)}${p.area || p.city ? ' | ' + [p.area, p.city].filter(Boolean).join(', ') : ''}${p.groupName && !p.sameGroup ? ' | ' + MC.t('admin.net.part_of', 'Part of {group}', { group: p.groupName }) : ''}${p.acceptsReferrals === false ? ' | ' + MC.t('admin.net.no_referrals', 'Not taking referrals') : ''}</span></div><span class="end sm">${p.distanceKm != null ? MC.t('admin.net.km', '{n} km', { n: p.distanceKm }) : ''}</span>${icon('right')}</a>`)}</div>`
        : empty({ icon: 'globe', title: filtered ? MC.t('admin.net.none_match', 'No providers match') : MC.t('admin.net.none', 'No other providers listed yet'), body: filtered ? MC.t('admin.net.none_match_sub', 'Try another name or area, or clear the filters.') : '' })}`);
    form('net-filter', f => MC.go('#/network' + qs({ q: f.q, type: f.type, partners: f.partners ? '1' : undefined })));
  }

  async function askPartner(p) {
    const v = await dialog({ title: MC.t('admin.net.ask_title', 'Ask {name} to partner', { name: p.name }), form: true, body: html`<p>${MC.t('admin.net.ask_body', 'When they accept, you can message each other and both of you are shown as partners on your profiles. What you discuss stays private.')}</p>
      <div class="field"><label for="na-n">${MC.t('admin.net.ask_note', 'Note to them (optional)')}</label><textarea class="input" id="na-n" name="note" maxlength="300" placeholder="${MC.t('admin.net.ask_note_ph', 'e.g. We refer lab work and would like to send it to you')}"></textarea></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('admin.net.ask', 'Send partnership request'), primary: true }],
      onSubmit: f => api.post('/api/network/connections', { toOrgId: p.id, note: f.note || undefined }) });
    if (!v) return;
    toast(v.status === 'accepted' ? MC.t('admin.net.now_partners', 'You are now partners with {name}', { name: p.name }) : MC.t('admin.net.ask_sent', 'Partnership request sent to {name}', { name: p.name }), 'ok');
    MC.render();
  }
  async function decideConn(c, action, name) {
    const msgs = {
      accept: [MC.t('admin.net.accept_q', 'Accept the partnership with {name}?', { name }), MC.t('admin.net.accept_body', 'You will be able to message each other, and both of you are shown as partners.'), MC.t('admin.net.accept', 'Accept partnership'), MC.t('admin.net.accepted', 'Partnership with {name} accepted', { name })],
      decline: c.direction === 'in' ? [MC.t('admin.net.decline_q', 'Decline the request from {name}?', { name }), MC.t('admin.net.decline_body', 'They will not be told why. They can ask again later.'), MC.t('admin.net.decline', 'Decline request'), MC.t('admin.net.declined', 'Request from {name} declined', { name })]
        : [MC.t('admin.net.withdraw_q', 'Withdraw your request to {name}?', { name }), MC.t('admin.net.withdraw_body', 'Your request is cancelled. You can ask again later.'), MC.t('admin.net.withdraw', 'Withdraw request'), MC.t('admin.net.withdrawn', 'Request to {name} withdrawn', { name })],
      end: [MC.t('admin.net.end_q', 'End the partnership with {name}?', { name }), MC.t('admin.net.end_body', 'You stop being shown as partners and cannot start new conversations with them. Past messages stay.'), MC.t('admin.net.end', 'End partnership'), MC.t('admin.net.ended', 'Partnership with {name} ended', { name })],
    }[action];
    if (!(await confirm({ title: msgs[0], body: msgs[1], ok: msgs[2], danger: action !== 'accept' }))) return;
    await api.post('/api/network/connections/' + c.id + '/' + action);
    toast(msgs[3], 'ok'); MC.render();
  }
  async function startThread(org) {
    const v = await dialog({ title: MC.t('admin.net.msg_title', 'Message {name}', { name: org.name }), form: true, body: html`<div class="field"><label for="nm-t">${MC.t('admin.net.msg', 'Message')}</label><textarea class="input" id="nm-t" name="text" required maxlength="2000"></textarea><div class="hint">${MC.t('admin.net.msg_hint', 'Only staff at your two providers can read it. Do not put patient details here; use a referral for a patient.')}</div></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('admin.net.send', 'Send message'), primary: true }],
      onSubmit: f => { if (!f.text) throw fail(MC.t('admin.net.need_text', 'Write your message first'), 'text'); return api.post('/api/network/threads', { toOrgId: org.id, text: f.text }); } });
    if (!v) return;
    toast(MC.t('admin.net.sent', 'Message sent'), 'ok'); MC.go('#/network/messages/' + v.id);
  }

  async function netProvider({ params, stale }) {
    const p = await api.get('/api/network/providers/' + encodeURIComponent(params.id));
    if (stale()) return;
    const c = p.connection; const partner = p.sameGroup || (c && c.status === 'accepted');
    const cC = MC.t('admin.net.col.service', 'Service'), cCat = MC.t('admin.net.col.category', 'Category'), cP = MC.t('admin.net.col.price', 'Price');
    view(html`<a class="back" href="#/network">${icon('left')}${MC.t('admin.net.tab.directory', 'Directory')}</a>
      <div class="page-head"><div><h1>${p.name}</h1><p>${p.typeLabel || cap(p.type)}${p.groupName ? ' | ' + MC.t('admin.net.part_of', 'Part of {group}', { group: p.groupName }) : ''} ${connBadge(p)}</p></div>
        <div class="actions">${partner ? html`<button class="btn primary" data-action="np-msg">${icon('message')}${MC.t('admin.net.send_msg', 'Send a message')}</button>` : ''}
        ${!p.sameGroup && !c ? html`<button class="btn primary" data-action="np-ask">${icon('plus')}${MC.t('admin.net.ask_short', 'Ask to partner')}</button>` : ''}
        ${c && c.status === 'pending' && c.direction === 'in' ? html`<button class="btn primary" data-action="np-decide" data-a="accept">${icon('check')}${MC.t('admin.net.accept', 'Accept partnership')}</button><button class="btn" data-action="np-decide" data-a="decline">${MC.t('admin.net.decline', 'Decline request')}</button>` : ''}
        ${c && c.status === 'pending' && c.direction === 'out' ? html`<button class="btn" data-action="np-decide" data-a="decline">${MC.t('admin.net.withdraw', 'Withdraw request')}</button>` : ''}
        ${c && c.status === 'accepted' ? html`<button class="btn" data-action="np-decide" data-a="end">${MC.t('admin.net.end', 'End partnership')}</button>` : ''}</div></div>
      ${p.acceptsReferrals === false ? html`<div class="notice warn">${MC.t('admin.net.no_referrals_long', '{name} is not taking referrals on MediCore at the moment.', { name: p.name })}</div>` : ''}
      <div class="grid side-r">
        <section class="panel flush"><h2>${MC.t('admin.net.services', 'Services and prices')}</h2>${p.services.length ? html`<div class="table-wrap" style="border:0"><table class="t stack-sm"><thead><tr><th>${cC}</th><th>${cCat}</th><th class="num">${cP}</th></tr></thead><tbody>${p.services.map(s => html`<tr><td data-label="${cC}"><b>${s.name}</b><br><span class="xs muted">${s.code}</span></td><td data-label="${cCat}">${catName(s.category)}</td><td class="num" data-label="${cP}">${money(s.priceKobo)}</td></tr>`)}</tbody></table></div>` : empty({ icon: 'card', title: MC.t('admin.net.no_services', 'No public prices listed') })}</section>
        <div><section class="panel"><h2>${MC.t('admin.net.contact', 'Contact')}</h2><dl class="kv">
          <dt>${MC.t('admin.net.phone', 'Phone')}</dt><dd>${p.phone ? html`<a href="tel:${p.phone}">${p.phone}</a>` : '-'}</dd>
          <dt>${MC.t('admin.net.email', 'Email')}</dt><dd>${p.email || '-'}</dd>
          <dt>${MC.t('admin.net.address', 'Address')}</dt><dd>${p.address || '-'}${p.area || p.city ? html`<br><span class="muted sm">${[p.area, p.city].filter(Boolean).join(', ')}</span>` : ''}</dd>
          <dt>${MC.t('admin.net.hours', 'Opening hours')}</dt><dd>${p.openingHours || '-'}</dd>
          <dt>${MC.t('admin.net.referrals', 'Referrals')}</dt><dd>${p.acceptsReferrals === false ? MC.t('admin.net.ref_no', 'Not taking referrals') : MC.t('admin.net.ref_yes', 'Accepts referrals')}</dd></dl></section>
          <section class="panel"><h2>${MC.t('admin.net.partners', 'Partners')}</h2>${p.partners.length ? html`<ul class="list">${p.partners.map(x => html`<li><span class="grow">${x.name}</span></li>`)}</ul>` : html`<p class="muted sm">${MC.t('admin.net.no_partners', 'No partners on MediCore yet.')}</p>`}</section></div></div>`);
    on('np-ask', () => askPartner(p));
    on('np-msg', () => startThread(p));
    on('np-decide', el => decideConn(c, el.dataset.a, p.name));
  }

  async function netPartners({ stale }) {
    const [conns, own, n] = await Promise.all([api.get('/api/network/connections'), MC.me.group ? api.get('/api/network/providers?partners=true&limit=200').then(r => r.filter(x => x.sameGroup)).catch(() => []) : [], netCounts()]);
    if (stale()) return;
    const incoming = conns.filter(c => c.status === 'pending' && c.direction === 'in');
    const outgoing = conns.filter(c => c.status === 'pending' && c.direction === 'out');
    const partners = conns.filter(c => c.status === 'accepted');
    const row = (c, acts) => html`<li><div class="grow"><a class="title" href="#/network/p/${c.orgId}">${c.orgName}</a><span class="sub">${c.direction === 'in' ? MC.t('admin.net.asked_by', 'Asked by {name}, {when}', { name: c.byName || '-', when: ago(c.createdAt) }) : MC.t('admin.net.asked_on', 'Asked {when}', { when: ago(c.createdAt) })}${c.status === 'accepted' && c.decidedAt ? ' | ' + MC.t('admin.net.since', 'Partners since {date}', { date: date(c.decidedAt) }) : ''}</span>${c.note ? html`<span class="sub">"${c.note}"</span>` : ''}</div><span class="end"><span class="row wrap" style="justify-content:flex-end;gap:8px">${acts}</span></span></li>`;
    view(html`${netHead()}${netTabs('partners', n)}
      <section class="panel flush"><h2>${MC.t('admin.net.incoming', 'Requests to you')}</h2>${incoming.length ? html`<ul class="list">${incoming.map(c => row(c, html`<button class="btn sm primary" data-action="nc-do" data-id="${c.id}" data-a="accept">${MC.t('admin.net.accept_btn', 'Accept')}</button><button class="btn sm" data-action="nc-do" data-id="${c.id}" data-a="decline">${MC.t('admin.net.decline_btn', 'Decline')}</button>`))}</ul>` : html`<p class="muted sm" style="padding:0 16px 16px">${MC.t('admin.net.no_incoming', 'No requests waiting.')}</p>`}</section>
      <section class="panel flush"><h2>${MC.t('admin.net.outgoing', 'Your requests waiting for an answer')}</h2>${outgoing.length ? html`<ul class="list">${outgoing.map(c => row(c, html`<button class="btn sm" data-action="nc-do" data-id="${c.id}" data-a="decline">${MC.t('admin.net.withdraw', 'Withdraw request')}</button>`))}</ul>` : html`<p class="muted sm" style="padding:0 16px 16px">${MC.t('admin.net.no_outgoing', 'None. Find a provider in the directory and ask to partner.')}</p>`}</section>
      <section class="panel flush"><h2>${MC.t('admin.net.current', 'Partners')}</h2>${partners.length ? html`<ul class="list">${partners.map(c => row(c, html`<button class="btn sm" data-action="nc-msg" data-org="${c.orgId}" data-name="${c.orgName}">${MC.t('admin.net.message_btn', 'Message')}</button><button class="btn sm" data-action="nc-do" data-id="${c.id}" data-a="end">${MC.t('admin.net.end', 'End partnership')}</button>`))}</ul>` : html`<p class="muted sm" style="padding:0 16px 16px">${MC.t('admin.net.no_partners_yet', 'You have no partners yet.')}</p>`}</section>
      ${own.length ? html`<section class="panel flush"><h2>${MC.t('admin.net.own_branches', 'Other branches of {group}', { group: MC.me.group.name })}</h2><p class="muted sm" style="padding:0 16px">${MC.t('admin.net.own_branches_sub', 'Branches of your group work together already. No request is needed.')}</p><ul class="list">${own.map(b => html`<li><div class="grow"><a class="title" href="#/network/p/${b.id}">${b.name}</a><span class="sub">${[b.area, b.city].filter(Boolean).join(', ')}</span></div><span class="end"><button class="btn sm" data-action="nc-msg" data-org="${b.id}" data-name="${b.name}">${MC.t('admin.net.message_btn', 'Message')}</button></span></li>`)}</ul></section>` : ''}`);
    on('nc-do', el => { const c = conns.find(x => x.id === el.dataset.id); if (c) return decideConn(c, el.dataset.a, c.orgName); });
    on('nc-msg', el => startThread({ id: el.dataset.org, name: el.dataset.name }));
  }

  async function netMessages({ stale }) {
    const [n] = await Promise.all([netCounts()]);
    if (stale()) return;
    const threads = n.threads || [];
    view(html`${netHead()}${netTabs('messages', n)}
      <div class="row between wrap" style="margin-bottom:16px"><p class="muted sm" style="margin:0">${MC.t('admin.net.msgs_sub', 'Private conversations with your partners and your group\'s branches.')}</p><button class="btn primary" data-action="nt-new">${icon('plus')}${MC.t('admin.net.new_msg', 'New message')}</button></div>
      ${threads.length ? html`<div class="list">${threads.map(t => html`<a href="#/network/messages/${t.id}"><div class="grow"><span class="title">${t.orgName}${t.subject ? html` <span class="muted sm">| ${t.subject}</span>` : ''}</span><span class="sub">${t.lastText || ''}</span></div><span class="end xs">${ago(t.lastAt)}${t.unread ? html`<br>${badge(MC.t('admin.net.unread', '{n} new', { n: t.unread }), 'bad')}` : ''}</span></a>`)}</div>`
        : empty({ icon: 'message', title: MC.t('admin.net.no_threads', 'No conversations yet'), body: MC.t('admin.net.no_threads_sub', 'Start one with a partner, or with another branch of your group.') })}`);
    on('nt-new', async () => {
      const list = await api.get('/api/network/providers?partners=true&limit=200');
      if (!list.length) { toast(MC.t('admin.net.no_partner_to_msg', 'You have no partners to message yet. Ask a provider to partner first.'), 'bad'); return; }
      const v = await dialog({ title: MC.t('admin.net.new_msg', 'New message'), form: true, body: html`<div class="field"><label for="nn-o">${MC.t('admin.net.to', 'To')}</label><select class="input" id="nn-o" name="toOrgId">${list.map(p => html`<option value="${p.id}">${p.name}</option>`)}</select></div>
        <div class="field"><label for="nn-t">${MC.t('admin.net.msg', 'Message')}</label><textarea class="input" id="nn-t" name="text" required maxlength="2000"></textarea><div class="hint">${MC.t('admin.net.msg_hint', 'Only staff at your two providers can read it. Do not put patient details here; use a referral for a patient.')}</div></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('admin.net.send', 'Send message'), primary: true }],
        onSubmit: f => { if (!f.text) throw fail(MC.t('admin.net.need_text', 'Write your message first'), 'text'); return api.post('/api/network/threads', { toOrgId: f.toOrgId, text: f.text }); } });
      if (!v) return;
      toast(MC.t('admin.net.sent', 'Message sent'), 'ok'); MC.go('#/network/messages/' + v.id);
    });
  }

  async function netThread({ params, stale }) {
    const d = await api.get('/api/network/threads/' + encodeURIComponent(params.id) + '/messages');
    if (stale()) return;
    const msgList = ms => ms.length ? html`<ul class="list">${ms.map(m => html`<li class="${m.system ? 'msg-system' : m.mine ? 'msg-mine' : ''}"><div class="grow"><span class="sub">${m.system ? MC.t('admin.net.system', 'MediCore') : (m.mine ? MC.t('admin.net.you', 'You ({name})', { name: m.fromName || '' }) : html`${m.fromName || ''} | ${m.fromOrgName || ''}`)} | ${dateTime(m.at)}</span><span style="white-space:pre-wrap;overflow-wrap:anywhere;display:block">${m.text}</span></div></li>`)}</ul>` : empty({ icon: 'message', title: MC.t('admin.net.no_msgs', 'No messages yet') });
    view(html`<a class="back" href="#/network/messages">${icon('left')}${MC.t('admin.net.tab.messages', 'Messages')}</a>
      <div class="page-head"><div><h1>${d.thread.orgName}</h1><p>${d.thread.subject || MC.t('admin.net.private', 'Private conversation between your two providers')}</p></div></div>
      <div id="nt-msgs" aria-live="polite">${msgList(d.messages)}</div>
      <form class="panel" data-form="nt-send" novalidate style="margin-top:16px"><div class="field"><label for="nt-t">${MC.t('admin.net.reply', 'Your message')}</label><textarea class="input" id="nt-t" name="text" required maxlength="2000"></textarea><div class="hint">${MC.t('admin.net.msg_hint', 'Only staff at your two providers can read it. Do not put patient details here; use a referral for a patient.')}</div></div><div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${icon('message')}${MC.t('admin.net.send', 'Send message')}</button></form>`);
    let count = d.messages.length;
    const refresh = async () => { const r = await api.get('/api/network/threads/' + encodeURIComponent(params.id) + '/messages'); const box = document.getElementById('nt-msgs'); if (box && r.messages.length !== count) { count = r.messages.length; MC.view(msgList(r.messages), box); } };
    form('nt-send', async (f, el) => {
      if (!f.text) throw fail(MC.t('admin.net.need_text', 'Write your message first'), 'text');
      await api.post('/api/network/threads/' + encodeURIComponent(params.id) + '/messages', { text: f.text });
      el.reset(); toast(MC.t('admin.net.sent', 'Message sent'), 'ok'); await refresh();
    });
    MC.poll(refresh, 15000);
    netCounts().catch(() => { });
  }

  /* ---------------- more (phones) ---------------- */
  const navAllowed = n => (!n.show || n.show(MC.me)) && (!n.perm || has(n.perm)) && (!n.anyPerm || n.anyPerm.some(has));
  const navLabel = l => (l && l.mcKey ? MC.t(l.mcKey, l.mcFallback) : String(l));
  async function more() {
    const items = NAV.filter(n => n.sideOnly && navAllowed(n));
    view(html`<div class="page-head"><div><h1>${MC.t('admin.more.title', 'More')}</h1><p>${MC.me.org ? MC.me.org.name : ''} | ${MC.me.roleLabel || ''}</p></div></div>
      ${MC.me.isGroupAdmin ? html`<div class="list" style="margin-bottom:16px"><a href="/group.html">${icon('building')}<div class="grow"><span class="title">${MC.t('admin.branch.open_group', 'Open the group console')}</span></div>${icon('right')}</a></div>` : ''}
      ${items.length ? html`<div class="list">${items.map(n => html`<a href="${n.href}">${icon(n.icon)}<div class="grow"><span class="title">${navLabel(n.label)}</span></div>${icon('right')}</a>`)}</div>` : empty({ icon: 'menu', title: MC.t('admin.more.empty', 'Nothing else to show for your role') })}`);
  }

  const NAV = [
    { href: '#/', label: MC.t('admin.nav.overview', 'Overview'), icon: 'home', anyPerm: ['admin.reports', 'admin.settings'] },
    { href: '#/staff', label: MC.t('admin.nav.staff', 'Staff'), icon: 'users', perm: 'admin.staff' },
    { href: '#/services', label: MC.t('admin.nav.services', 'Price list'), icon: 'card', perm: 'admin.settings' },
    { href: '#/network', label: MC.t('admin.nav.network', 'Network'), icon: 'globe', perm: 'network.manage' },
    { href: '#/more', label: MC.t('admin.nav.more', 'More'), icon: 'menu' },
    { href: '#/attendance', label: MC.t('admin.nav.attendance', 'Attendance'), icon: 'clock', anyPerm: ['admin.staff', 'admin.reports'], sideOnly: true },
    { href: '#/subscription', label: MC.t('admin.nav.subscription', 'Apps and subscription'), short: MC.t('admin.nav.apps', 'Apps'), icon: 'box', perm: 'admin.settings', sideOnly: true },
    { href: '#/settings', label: MC.t('admin.nav.settings', 'Settings'), icon: 'settings', perm: 'admin.settings', sideOnly: true },
    { href: '#/contacts', label: MC.t('admin.nav.contacts', 'Contact numbers'), icon: 'phone', anyPerm: ['admin.settings', 'admin.staff', 'admin.reports'], sideOnly: true },
    { href: '#/hmos', label: MC.t('admin.nav.hmos', 'HMOs we accept'), icon: 'heart', anyPerm: ['admin.settings', 'admin.finance'], show: me => !(me.org && me.org.type === 'hmo'), sideOnly: true },
    Object.assign({}, MC.whatsapp.navItem(), { sideOnly: true }),
    { href: '#/support', label: MC.t('admin.nav.support', 'Support'), icon: 'message', anyPerm: ['admin.settings', 'admin.staff', 'admin.reports'], sideOnly: true },
    { href: '#/audit', label: MC.t('admin.nav.audit', 'Audit log'), short: MC.t('admin.nav.audit_short', 'Audit'), icon: 'shield', perm: 'admin.audit', sideOnly: true },
  ];

  MC.boot({
    title: 'MediCore Admin', subtitle: MC.t('admin.login.sub', 'Run your provider on MediCore'), home: '#/',
    nav: NAV,
    routes: { '#/': overview, '#/staff': staff, '#/services': services, '#/settings': settings, '#/subscription': subscription, '#/support': support, '#/support/new': supportNew, '#/support/:id': supportView, '#/attendance': attendance, '#/audit': audit, '#/contacts': contactsPage, '#/hmos': hmoPage,
      '#/network': netDirectory, '#/network/p/:id': netProvider, '#/network/partners': netPartners, '#/network/messages': netMessages, '#/network/messages/:id': netThread, '#/more': more,
      ...MC.whatsapp.routes('#/whatsapp', {}) },
    onReady: () => { netCounts().catch(() => { }); MC.whatsapp.refreshCount(); },
  });
})();
