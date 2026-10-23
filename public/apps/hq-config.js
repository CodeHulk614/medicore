/* MediCore HQ: no-code configuration screens, integrations, the go-live checklist, the compliance and
 * partnership register, outgoing connectors and the support queue.
 * Loaded by hq.html before hq.js. Exposes window.HQConfig = { routes, nav }.
 * Every settings screen edits one settings section through PATCH /api/hq/config/:section, which is
 * versioned, audited and can be rolled back from History. */
(function () {
  'use strict';
  const { html, api, money, date, dateTime, ago, cap, icon, badge, empty, view, on, form, dialog, confirm, toast } = MC;
  const T = (k, d, v) => MC.t('hq.' + k, d, v);
  let state = null;
  const load = async () => (state = await api.get('/api/hq/config'));
  const can = p => ((MC.me && MC.me.perms) || []).includes(p);
  /* save one section. okMsg(version) gives the toast text; the default says "Saved as version N". */
  async function save(section, patch, note, okMsg) {
    try {
      const r = await api.patch('/api/hq/config/' + section, { patch, expectVersion: state.version, note });
      toast(okMsg ? okMsg(r.version) : T('cfg.saved', 'Saved as version {v}', { v: r.version }), 'ok'); await load(); return r;
    } catch (e) {
      if (e.code === 'version_conflict') { toast(T('cfg.conflict', 'Someone else changed the settings. Reloaded the latest version.'), 'bad'); await load(); MC.render(); return null; }
      if (e.status === 403) throw new MC.ApiError(403, { error: T('cfg.forbidden', 'Your MediCore team role cannot change this. Ask a platform owner.') });
      throw e;
    }
  }
  const getP = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const setP = (o, p, v) => { const ks = p.split('.'); let c = o; for (let i = 0; i < ks.length - 1; i++) { if (!c[ks[i]] || typeof c[ks[i]] !== 'object') c[ks[i]] = {}; c = c[ks[i]]; } c[ks[ks.length - 1]] = v; };
  const opt = (value, label, sel) => html`<option value="${value}" ${sel ? 'selected' : ''}>${label}</option>`;
  const head = (title, sub) => html`<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div><div class="actions"><span class="badge outline plain">${T('cfg.version', 'Version {v}', { v: state.version })}</span></div></div>`;
  const plainHead = (title, sub, actions) => html`<div class="page-head"><div><h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ''}</div>${actions ? html`<div class="actions">${actions}</div>` : ''}</div>`;
  const tabs = cur => html`<nav class="tabs" aria-label="${T('cfg.sections', 'Settings sections')}">${[['branding', T('cfg.t.branding', 'Look and feel')], ['content', T('cfg.t.content', 'Texts')], ['languages', T('cfg.t.languages', 'Translations')], ['features', T('cfg.t.features', 'Features')], ['process', T('cfg.t.process', 'Processes')], ['pricing', T('cfg.t.pricing', 'Pricing')], ['roles', T('cfg.t.roles', 'Roles')], ['catalog', T('cfg.t.catalog', 'Packages')], ['integrations', T('cfg.t.integrations', 'Integrations')], ['history', T('cfg.t.history', 'History')]].map(([k, l]) => html`<a href="#/config/${k}" ${k === cur ? MC.raw('aria-current="page"') : ''}>${l}</a>`)}</nav>`;
  const APP_NAMES = { patient: 'Patient app', register: 'Sign-up page', frontdesk: 'Front desk', doctor: 'Doctor', pharmacy: 'Pharmacy', rider: 'Rider', dispatch: 'Ambulance dispatch', crew: 'Ambulance crew', lab: 'Lab', chw: 'Community health', payer: 'HMO desk', admin: 'Provider admin', group: 'Group console (hospital groups)', hq: 'HQ' };
  const appName = a => T('app.' + a, APP_NAMES[a] || cap(a));
  const PHONE_RE = /^(0\d{10}|\+?\d{8,15})$/; // local 0803..., or international digits with or without +
  const preStyle = 'white-space:pre-wrap;overflow-wrap:anywhere;background:var(--sunken);border:1px solid var(--line);padding:12px;border-radius:6px;font-size:.8125rem;margin:8px 0 0';

  /* show or hide parts of a form that depend on a select: <div data-when="fieldName=a|b"> */
  function applyWhen(f) {
    if (!f) return;
    f.querySelectorAll('[data-when]').forEach(el => { const i = el.dataset.when.indexOf('='); const name = el.dataset.when.slice(0, i); const vals = el.dataset.when.slice(i + 1).split('|'); const ctl = f.elements.namedItem(name); el.hidden = !(ctl && vals.includes(ctl.value)); });
  }
  document.addEventListener('change', e => { const f = e.target && e.target.form; if (f && f.querySelector('[data-when]')) applyWhen(f); });
  const applyAllWhen = () => document.querySelectorAll('form').forEach(f => { if (f.querySelector('[data-when]')) applyWhen(f); });

  /* compliance helpers shared by several screens */
  const featureBlockers = () => { const out = {}; Object.entries((state && state.settings.compliance && state.settings.compliance.items) || {}).forEach(([k, it]) => { if (it && it.enforce && it.status !== 'done') (it.blocksFeatures || []).forEach(f => { (out[f] = out[f] || []).push(it.label || k); }); }); return out; };
  const daysUntil = d => (d ? Math.ceil((Date.parse(d + 'T23:59:59+01:00') - Date.now()) / 86400e3) : null);
  function expiryFlag(d) {
    if (!d) return '';
    const n = daysUntil(d); if (n == null || Number.isNaN(n)) return html`<span>${d}</span>`;
    if (n < 0) return badge(T('cm.expired_on', 'Expired {d}', { d: date(Date.parse(d + 'T12:00:00+01:00')) }), 'bad');
    if (n <= 30) return badge(T('cm.expires_in', 'Expires in {n} days ({d})', { n, d: date(Date.parse(d + 'T12:00:00+01:00')) }), 'warn');
    return html`<span>${date(Date.parse(d + 'T12:00:00+01:00'))}</span>`;
  }

  /* ---------- branding ---------- */
  async function branding() {
    await load(); const b = state.settings.branding;
    view(html`${head(T('br.title', 'Look and feel'), T('br.sub', 'Names, colours and the default theme of every app.'))}${tabs('branding')}
      <form class="panel" data-form="br-save" novalidate>
        <div class="fields two"><div class="field"><label for="br-n">${T('br.name', 'Product name')}</label><input class="input" id="br-n" name="productName" value="${b.productName}" required></div>
        <div class="field"><label for="br-t">${T('br.theme', 'Default theme')}</label><select class="input" id="br-t" name="defaultTheme">${['system', 'light', 'dark'].map(x => html`<option value="${x}" ${b.defaultTheme === x ? 'selected' : ''}>${T('br.theme_' + x, cap(x))}</option>`)}</select></div></div>
        <div class="field"><label for="br-l">${T('br.logo', 'Logo URL (https)')}</label><input class="input" id="br-l" name="logoUrl" value="${b.logoUrl}"></div>
        <h2>${T('br.contacts', 'MediCore contact numbers')}</h2>
        <p class="muted sm">${T('br.contacts_sub', 'Shown to patients and providers in every app. Numbers can be written as 0803 123 4567 or +234 803 123 4567. WhatsApp numbers become a chat button.')}</p>
        <div class="fields three"><div class="field"><label for="br-e">${T('br.email', 'Support email')}</label><input class="input" id="br-e" name="supportEmail" type="email" value="${b.supportEmail}"></div><div class="field"><label for="br-p">${T('br.phone', 'Support phone')}</label><input class="input" id="br-p" name="supportPhone" type="tel" inputmode="tel" value="${b.supportPhone}"></div><div class="field"><label for="br-sw">${T('br.support_wa', 'Support WhatsApp')}</label><input class="input" id="br-sw" name="supportWhatsapp" type="tel" inputmode="tel" value="${b.supportWhatsapp || ''}"></div></div>
        <div class="fields three"><div class="field"><label for="br-sp">${T('br.sales_phone', 'Sales phone')}</label><input class="input" id="br-sp" name="salesPhone" type="tel" inputmode="tel" value="${b.salesPhone || ''}"><div class="hint">${T('br.sales_h', 'For providers who want to join MediCore.')}</div></div><div class="field"><label for="br-sw2">${T('br.sales_wa', 'Sales WhatsApp')}</label><input class="input" id="br-sw2" name="salesWhatsapp" type="tel" inputmode="tel" value="${b.salesWhatsapp || ''}"></div></div>
        <h2>${T('br.apps', 'Apps')}</h2>
        <div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('br.app', 'App')}</th><th>${T('br.app_title', 'Title shown to users')}</th><th>${T('br.colour', 'Colour')}</th></tr></thead><tbody>
        ${Object.keys(b.apps).map(a => html`<tr><td data-label="${T('br.app', 'App')}"><b>${appName(a)}</b></td><td data-label="${T('br.app_title', 'Title shown to users')}"><label class="sr-only" for="br-t-${a}">${T('br.app_title_for', 'Title for {app}', { app: appName(a) })}</label><input class="input" id="br-t-${a}" name="title_${a}" value="${b.apps[a].title}"></td><td data-label="${T('br.colour', 'Colour')}"><label class="sr-only" for="br-h-${a}">${T('br.colour_for', 'Colour for {app}', { app: appName(a) })}</label><input class="input" id="br-h-${a}" type="color" name="hue_${a}" value="${b.apps[a].hue}" style="width:72px;padding:4px"></td></tr>`)}</tbody></table></div>
        <div class="field" style="margin-top:16px"><label for="br-note">${T('cfg.note', 'Note for the change log (optional)')}</label><input class="input" id="br-note" name="note"></div>
        <div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${T('br.save', 'Save look and feel')}</button></form>`);
    form('br-save', async d => {
      const apps = {}; Object.keys(b.apps).forEach(a => { apps[a] = { title: d['title_' + a], hue: d['hue_' + a] }; });
      const nums = {}; [['supportPhone', T('br.phone', 'Support phone')], ['supportWhatsapp', T('br.support_wa', 'Support WhatsApp')], ['salesPhone', T('br.sales_phone', 'Sales phone')], ['salesWhatsapp', T('br.sales_wa', 'Sales WhatsApp')]].forEach(([k, l]) => {
        const v = String(d[k] || '').trim(); if (v && !PHONE_RE.test(v.replace(/[\s\-().]/g, ''))) throw new MC.ApiError(400, { error: T('br.bad_phone', '{field} is not a phone number. Write it as 0803 123 4567 or +234 803 123 4567.', { field: l }) }); nums[k] = v; });
      if (d.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.supportEmail)) throw new MC.ApiError(400, { error: T('br.bad_email', 'The support email is not a valid address.') });
      await save('branding', Object.assign({ productName: d.productName, defaultTheme: d.defaultTheme, supportEmail: d.supportEmail || '', logoUrl: d.logoUrl || '', apps }, nums), d.note, v => T('br.saved', 'Look and feel saved as version {v}', { v })); MC.render();
    });
  }

  /* ---------- texts ---------- */
  async function content({ query }) {
    await load(); const c = state.settings.content; const app = query.app || 'global';
    const fields = app === 'global' ? c.global : (c.apps[app] || {});
    view(html`${head(T('ct.title', 'Texts'), T('ct.sub', 'Words shown in the apps: welcome lines, help, legal links, emergency numbers.'))}${tabs('content')}
      <div class="row wrap" style="margin-bottom:16px"><label for="ct-app" class="sr-only">${T('br.app', 'App')}</label><select class="input" id="ct-app" style="max-width:280px" data-ct-app><option value="global" ${app === 'global' ? 'selected' : ''}>${T('ct.global', 'All apps')}</option>${Object.keys(c.apps).map(a => html`<option value="${a}" ${a === app ? 'selected' : ''}>${appName(a)}</option>`)}</select></div>
      <form class="panel" data-form="ct-save" novalidate>${Object.keys(fields).map(k => html`<div class="field"><label for="ct-${k}">${cap(k.replace(/([A-Z])/g, ' $1').toLowerCase())}</label><textarea class="input" id="ct-${k}" name="${k}" rows="2">${fields[k]}</textarea></div>`)}
        <details><summary class="btn ghost">${T('ct.add', 'Add a text')}</summary><div class="fields two" style="margin-top:12px"><div class="field"><label for="ct-nk">${T('ct.key', 'Key (letters only)')}</label><input class="input" id="ct-nk" name="__newKey" pattern="[A-Za-z]+"></div><div class="field"><label for="ct-nv">${T('ct.value', 'Text')}</label><input class="input" id="ct-nv" name="__newVal"></div></div></details>
        <div class="form-err notice bad" hidden></div><div class="btn-row"><button class="btn primary" type="submit">${T('ct.save', 'Save texts')}</button></div></form>`);
    document.querySelector('[data-ct-app]').addEventListener('change', e => MC.go('#/config/content?app=' + e.target.value));
    form('ct-save', async d => {
      const vals = {}; Object.keys(fields).forEach(k => { vals[k] = d[k] || ''; }); if (d.__newKey && /^[A-Za-z]+$/.test(d.__newKey)) vals[d.__newKey] = d.__newVal || '';
      await save('content', app === 'global' ? { global: vals } : { apps: { [app]: vals } }, null, v => T('ct.saved', 'Texts saved as version {v}', { v })); MC.render();
    });
  }

  /* ---------- translations ---------- */
  const LANGS = { pcm: 'Naija (Pidgin)', yo: 'Yoruba', ha: 'Hausa', ig: 'Igbo' };
  async function languages({ query }) {
    await load(); const lang = LANGS[query.lang] ? query.lang : 'yo'; const q = (query.q || '').toLowerCase();
    const [en, tr] = await Promise.all([fetch('/assets/i18n/en.json').then(r => r.ok ? r.json() : {}).catch(() => ({})), fetch('/assets/i18n/' + lang + '.json').then(r => r.ok ? r.json() : {}).catch(() => ({}))]);
    const ov = (state.settings.content.i18n || {})[lang] || {};
    const status = (state.settings.content.i18nStatus || {})[lang] || 'machine';
    let keys = Object.keys(en).sort(); if (q) keys = keys.filter(k => k.toLowerCase().includes(q) || String(en[k]).toLowerCase().includes(q) || String(ov[k] || tr[k] || '').toLowerCase().includes(q));
    const missing = Object.keys(en).filter(k => !tr[k] && !ov[k]).length;
    view(html`${head(T('tr.title', 'Translations'), T('tr.sub', 'Every word in every app, in Nigerian Pidgin, Yoruba, Hausa and Igbo. Edit any line; your edit wins over the bundled translation.'))}${tabs('languages')}
      <div class="row wrap between" style="margin-bottom:12px"><div class="seg" role="group">${Object.entries(LANGS).map(([k, l]) => html`<button type="button" data-action="tr-lang" data-l="${k}" aria-pressed="${k === lang}">${l}</button>`)}</div>
        <div class="row wrap">${status === 'reviewed' ? badge(T('tr.reviewed', 'Reviewed by a native speaker'), 'ok') : badge(T('tr.machine', 'Needs native-speaker review'), 'warn')}<button class="btn sm" data-action="tr-status" data-l="${lang}" data-s="${status === 'reviewed' ? 'machine' : 'reviewed'}">${status === 'reviewed' ? T('tr.mark_machine', 'Mark as needing review') : T('tr.mark_reviewed', 'Mark as reviewed')}</button></div></div>
      ${MC.figures([{ value: Object.keys(en).length, label: T('tr.keys', 'Texts in the apps') }, { value: Object.keys(ov).length, label: T('tr.edited', 'Edited in HQ') }, { value: missing, label: T('tr.missing', 'Not yet translated'), tone: missing ? 'warn' : '' }])}
      <form data-form="tr-search" class="search" style="margin-bottom:12px">${icon('search')}<label class="sr-only" for="tr-q">${T('tr.search', 'Search')}</label><input class="input" id="tr-q" name="q" value="${query.q || ''}" placeholder="${T('tr.search_ph', 'Search English or translated text')}"></form>
      ${keys.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('tr.english', 'English')}</th><th>${LANGS[lang]}</th><th></th></tr></thead><tbody>${keys.slice(0, 300).map(k => html`<tr><td data-label="${T('tr.english', 'English')}">${en[k]}<br><span class="xs muted">${k}</span></td><td data-label="${LANGS[lang]}">${ov[k] ? html`<b>${ov[k]}</b> ${badge(T('tr.hq', 'HQ edit'), 'hue')}` : (tr[k] || html`<span class="muted">${T('tr.none', 'Not translated, English shown')}</span>`)}</td><td class="num"><button class="btn sm" data-action="tr-edit" data-k="${k}">${T('tr.edit', 'Edit')}</button></td></tr>`)}</tbody></table></div>${keys.length > 300 ? html`<p class="muted sm">${T('tr.more', 'Showing 300 of {n}. Search to narrow down.', { n: keys.length })}</p>` : ''}` : empty({ icon: 'globe', title: T('tr.empty', 'No texts found') })}`);
    on('tr-lang', el => MC.go('#/config/languages?lang=' + el.dataset.l));
    form('tr-search', d => MC.go('#/config/languages?lang=' + lang + (d.q ? '&q=' + encodeURIComponent(d.q) : '')));
    on('tr-status', async el => { await save('content', { i18nStatus: { [el.dataset.l]: el.dataset.s } }, null, v => T('tr.status_saved', 'Review status saved as version {v}', { v })); MC.render(); });
    on('tr-edit', async el => {
      const k = el.dataset.k;
      const v = await dialog({ title: T('tr.edit_title', 'Edit translation'), form: true, body: html`<p class="muted sm">${k}</p><p><b>${en[k]}</b></p><div class="field"><label for="tr-v">${LANGS[lang]}</label><textarea class="input" id="tr-v" name="text" rows="3">${ov[k] || tr[k] || ''}</textarea><div class="hint">${T('tr.keep', 'Keep {placeholders} exactly as they are.')}</div></div>`, actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('tr.save', 'Save translation'), primary: true }],
        onSubmit: async d => { const ph = (String(en[k]).match(/\{\w+\}/g) || []).sort().join(); const ph2 = (String(d.text || '').match(/\{\w+\}/g) || []).sort().join(); if (ph !== ph2) throw new MC.ApiError(400, { error: T('tr.ph_err', 'The translation must keep these placeholders: {list}', { list: ph || 'none' }) }); return save('content', { i18n: { [lang]: { [k]: d.text || '' } } }, null, v2 => T('tr.saved', 'Translation saved as version {v}', { v: v2 })); } });
      if (v) MC.render();
    });
  }

  /* ---------- features ---------- */
  const FEATURE_INFO = {
    patientSelfSignup: 'Patients can create their own accounts', providerSelfSignup: 'Providers can sign up on the website', publicEmergency: 'Anyone can report an emergency without an account', videoVisits: 'Video consultations',
    marketplace: 'Patients can find and book any listed provider', homeDelivery: 'Medicine and sample delivery', ussd: 'USSD service for feature phones', whatsapp: 'WhatsApp channel (needs WhatsApp Business API)', ai: 'AI assistant (master switch)',
    aiPatientAssistant: 'AI health assistant for patients', aiClinicianAssistant: 'AI drafting help for doctors (doctor approves)', aiLabExplainer: 'AI plain-language lab result explanations', chw: 'Community health worker app', onlinePayments: 'Online card, transfer and USSD payments',
    cashPayments: 'Cash and POS at the counter', hmoClaims: 'HMO cover, pre-authorisation and claims', lowDataMode: 'Low-data mode (fewer images and maps)', maintenanceMode: 'Maintenance mode: providers can read but not change anything',
    groups: 'Hospital groups with several branches', referralNetwork: 'Referrals between providers', providerMessaging: 'Private messages between providers', providerDirectory: 'Provider directory for staff (find partners)',
    marketplacePharmacy: 'Marketplace patients can order medicines from pharmacies they are not registered with (needs PCN e-pharmacy registration)', careSharing: 'Shared care: providers look after a patient together on one record', wearables: 'Health devices: patients sync watches and home devices; providers ask for readings',
    documents: 'Documents: scanned records, letters with verification codes, signed consent forms', inventory: 'Stores and bed capacity for wards, lab and ambulances', publicFacilities: 'Public and government hospitals on the map (not on MediCore)',
    transfers: 'Emergency transfers with transfer packs and ambulance requests', hmoRetail: 'Patients buy HMO plans in the app', hmoNetwork: 'HMO provider networks, primary providers and capitation',
  };
  const featureLabel = k => T('ft.' + k, FEATURE_INFO[k] || cap(k.replace(/([A-Z])/g, ' $1').toLowerCase()));
  async function features() {
    await load(); const f = state.settings.features; const blocked = featureBlockers();
    const keys = Object.keys(FEATURE_INFO).concat(Object.keys(f).filter(k => typeof f[k] === 'boolean' && !FEATURE_INFO[k]));
    view(html`${head(T('ft.title', 'Features'), T('ft.sub', 'Switch whole capabilities on or off for every provider. A provider can be given its own setting from its page.'))}${tabs('features')}
      ${Object.keys(blocked).length ? html`<div class="notice warn">${T('ft.blocked_note', 'Some features are switched off by the compliance register until their licence is done, whatever is ticked here.')} <a href="#/compliance">${T('ft.open_compliance', 'Open the compliance register')}</a></div>` : ''}
      <form class="panel" data-form="ft-save" novalidate>
        <ul class="list">${keys.map(k => html`<li><label class="check" style="flex:1"><input type="checkbox" name="${k}" ${f[k] ? 'checked' : ''}><span><b>${featureLabel(k)}</b>${blocked[k] ? html`<br>${badge(T('ft.blocked', 'Off until done: {items}', { items: blocked[k].join(', ') }), 'bad')}` : ''}</span></label></li>`)}</ul>
        <div class="field" style="margin-top:16px"><label for="ft-mm">${T('ft.mm', 'Maintenance message')}</label><input class="input" id="ft-mm" name="maintenanceMessage" value="${f.maintenanceMessage || ''}"></div>
        <div class="field"><span class="label">${T('ft.langs', 'Languages offered')}</span>${[['pcm', 'Naija (Pidgin)'], ['yo', 'Yoruba'], ['ha', 'Hausa'], ['ig', 'Igbo']].map(([k, l]) => html`<label class="check"><input type="checkbox" name="languages" data-list value="${k}" ${(f.languages || []).includes(k) ? 'checked' : ''}><span>${l}</span></label>`)}</div>
        <div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${T('ft.save', 'Save features')}</button></form>`);
    form('ft-save', async d => {
      const patch = {}; keys.forEach(k => { patch[k] = !!d[k]; }); patch.maintenanceMessage = d.maintenanceMessage || ''; patch.languages = ['en'].concat(d.languages || []);
      if (patch.maintenanceMode && !f.maintenanceMode && !(await confirm({ title: T('ft.mm_q', 'Turn on maintenance mode?'), body: T('ft.mm_body', 'Every provider will be unable to save changes until you turn it off.'), ok: T('ft.mm_ok', 'Turn on maintenance mode'), danger: true }))) return;
      await save('features', patch, null, v => T('ft.saved', 'Features saved as version {v}', { v })); MC.render();
    });
  }

  /* ---------- processes ---------- */
  // [label, unit, help]; unit 'bool' for switches, 'select:a,b' for choices
  const PROC = {
    security: { _t: 'Security', passwordMinLength: ['Minimum password length', 'characters'], sessionHours: ['Sign-in lasts', 'hours'], lockoutAttempts: ['Wrong passwords before lock', 'tries'], lockoutMinutes: ['Lock lasts', 'minutes'], otpMinutes: ['SMS codes expire after', 'minutes'], loginPerIpPer5Min: ['Sign-ins allowed per network in 5 minutes', ''] },
    appointments: { _t: 'Appointments', patientCancelHours: ['Patients can cancel up to', 'hours before'], defaultSlotMinutes: ['Default slot length', 'minutes'], videoJoinEarlyMinutes: ['Video room opens early by', 'minutes'], videoJoinLateMinutes: ['Video room stays open for', 'minutes after start'], payBeforeVideo: ['Video visits must be paid first', 'bool'] },
    pharmacy: { _t: 'Pharmacy', pickupWindowDays: ['Days to collect before an order is missed', 'days'], deliveryCodeAttempts: ['Wrong delivery codes before lock', 'tries'], requirePharmacistVerify: ['A pharmacist must verify every prescription', 'bool'], allowSubstitution: ['Allow generic substitution with a reason', 'bool'] },
    lab: { _t: 'Laboratory', twoStepVerifyDefault: ['New labs need a second scientist to verify', 'bool'], collectBeforePaymentForUrgent: ['Urgent samples can be taken before payment', 'bool'] },
    hmo: { _t: 'HMO', preauthThresholdKobo: ['Pre-authorisation needed above', 'naira'], duplicateWindowHours: ['Duplicate claim window', 'hours'], frequencyLimitPer30Days: ['Same service per patient per 30 days before flag', 'times'],
      primaryChangeMinMonths: ['Members can change primary provider every', 'months'], maxDependants: ['Family members per cover when the plan does not say', ''],
      verifyCardAnyProvider: ['Any provider can check a member card (not only the HMO\'s network and panel)', 'bool'],
      uninsuredBuyFree: ['Patients with no HMO can browse and buy HMO plans free', 'bool', 'Gets the uninsured insured: no marketplace subscription needed for a first HMO.'],
      otherHmosNeedSubscription: ['Patients who already have an HMO need the marketplace to compare other HMOs', 'bool'] },
    wearables: { _t: 'Health devices', requestExpiryMinutes: ['A provider\'s request for a reading stays open for', 'minutes'] },
    identity: { _t: 'Identity (NIN)', requireNin: ['Patients need a NIN before a provider onboards them', 'bool'], allowNoNinWithReason: ['Staff may register without a NIN when they give a reason', 'bool'], matchDob: ['The date of birth must match the NIN record', 'bool'], showHmoBeforeConsent: ['Providers see a patient\'s HMO before the patient shares their record', 'bool'] },
    emergency: { _t: 'Emergency', publicPerIpPerHour: ['Public reports per network per hour', ''], sosRadiusKm: ['Search radius for the nearest ambulance', 'km'], locationFreshSeconds: ['Ambulance location counts as live for', 'seconds'], patientChoosesService: ['Patients can pick which ambulance service comes', 'bool'], fallbackCallKobo: ['Call-out price when a service set none', 'naira'], fallbackAlsKobo: ['Advanced life support call-out when a service set none', 'naira'], fallbackPerKmKobo: ['Price per km when a service set none', 'naira'], bookingFeeKobo: ['MediCore emergency booking fee (0 = off)', 'naira'] },
    delivery: { _t: 'Delivery', riderLocationFreshSeconds: ['Rider location counts as live for', 'seconds'] },
    ai: { _t: 'AI assistant', patientDailyMessages: ['Messages per patient per day', 'messages'], conversationRetentionDays: ['Keep conversations for', 'days'] },
    billing: { _t: 'Billing', platformFeeKobo: ['MediCore fee per bill', 'naira'], bankChargeKobo: ['Bank service charge per payment', 'naira'], showBankChargeToPatient: ['Show the bank charge to patients', 'bool'] },
    patients: { _t: 'Patients and providers',
      mode: ['How patients relate to providers', 'select:provider,open'],
      freeFirstProvider: ['A self-registered patient joins their first provider free', 'bool', 'Joining more providers then needs the marketplace subscription. Referrals and shared care between providers are always free.'],
      allowMultipleProviders: ['A patient can belong to more than one provider', 'bool', 'When off, a patient registered at one provider cannot apply to another.'],
      applicationsNeedApproval: ['Patient applications need the provider\'s approval', 'bool', 'When off, a patient who applies to a provider is accepted at once.'],
      crossProviderSharing: ['Patients can share their records with another provider themselves', 'bool', 'Only used in provider mode. Referrals always carry a record summary.'],
      applicationExpiryDays: ['Unanswered applications expire after', 'days'] },
    branches: { _t: 'Hospital groups and branches',
      requireApproval: ['New branches need HQ approval', 'bool', 'When off, a branch added by an active group goes live at once.'],
      shareRecordsAcrossBranches: ['Branches of a group see each other\'s patient records', 'bool', 'A patient registered at one branch is a patient of every branch.'],
      branchAdminsManageModules: ['Branch admins can change their branch\'s apps and subscription', 'bool', 'When off, only the group console changes apps.'] },
    marketplace: { _t: 'Patient marketplace',
      monthlyKobo: ['Monthly access', 'naira'], quarterlyKobo: ['3-month access', 'naira'], annualKobo: ['12-month access', 'naira'],
      freeTrialDays: ['Free trial', 'days'], defaultRadiusKm: ['Default search distance', 'km'],
      hmoMembersSeeNetwork: ['HMO members see their HMO\'s network free', 'bool', 'The HMO pays for its network; members do not need a subscription for it.'],
      autoRegisterOnUse: ['Register marketplace patients at a provider the first time they use it', 'bool', 'A provider can still choose to approve joiners itself.'],
      showTeaser: ['Show non-subscribers how many providers are near them', 'bool'] },
    careShare: { _t: 'Shared care',
      requirePatientConsent: ['The patient must agree before providers share their care', 'bool'],
      allowCodeConsent: ['Patients without the app can agree with an SMS code at the desk', 'bool'],
      defaultDays: ['A share lasts', 'days'], maxDays: ['Longest share allowed', 'days'] },
    documents: { _t: 'Documents',
      maxFileMb: ['Largest page or file', 'MB'], maxFilesPerDocument: ['Pages per document', ''],
      patientUploads: ['Patients can add their own old records', 'bool'], patientSeesProviderScans: ['Patients see the papers providers scanned for them', 'bool'] },
    transfers: { _t: 'Emergency transfers', packHours: ['A transfer pack link works for', 'hours'], packMaxViews: ['A transfer pack can be opened', 'times'] },
    referrals: { _t: 'Referrals between providers',
      requireConnection: ['Providers can only refer to their partners', 'bool', 'When off, any provider in the directory can receive a referral.'],
      requirePatientConsent: ['The patient\'s consent is needed to send a referral', 'bool', 'Emergencies never need it.'],
      expireDays: ['Unanswered referrals expire after', 'days'],
      notifyPatient: ['Tell the patient when a referral is sent or answered', 'bool'] },
  };
  const MODE_OPTS = { provider: 'Provider mode: each patient belongs to the providers that registered them', open: 'Open mode: patients can find and book any provider on MediCore' };
  async function processes() {
    await load(); const p = state.settings.process; const pcn = ((state.settings.compliance || {}).items || {}).pcn;
    view(html`${head(T('pr.title', 'Processes'), T('pr.sub', 'Rules and timings the apps follow. Changes apply within a minute, without a new release.'))}${tabs('process')}
      <form data-form="pr-save" novalidate>${Object.entries(PROC).map(([sec, fields]) => html`<section class="panel" id="pr-sec-${sec}"><h2>${T('pr.' + sec, fields._t)}</h2>
        ${sec === 'patients' ? html`<div class="notice"><p style="margin:0 0 6px"><b>${T('pr.mode_provider_t', 'Provider mode (recommended to start)')}</b>: ${T('pr.mode_provider_d', 'a patient belongs to the providers that registered them, approved their application or accepted a referral. The patient app shows one provider at a time with a switcher. No platform-wide search, and records are shared between providers only through a referral.')}</p><p style="margin:0"><b>${T('pr.mode_open_t', 'Open mode')}</b>: ${T('pr.mode_open_d', 'a platform-wide directory where patients book any provider and choose who sees their records. Opening pharmacies to every patient needs the PCN e-pharmacy aggregator registration.')}</p></div>` : ''}
        <div class="fields two">${Object.entries(fields).filter(([k]) => k !== '_t').map(([k, [label, unit, help]]) => {
        const v = (p[sec] || {})[k]; const name = sec + '.' + k; const hint = help ? html`<div class="hint">${T('pr.' + name + '_h', help)}</div>` : '';
        if (unit === 'bool') return html`<div class="field"><label class="check"><input type="checkbox" name="${name}" ${v ? 'checked' : ''}><span>${T('pr.' + name, label)}${help ? html`<br><span class="sm muted">${T('pr.' + name + '_h', help)}</span>` : ''}</span></label></div>`;
        if (/^select:/.test(unit)) return html`<div class="field" style="grid-column:1/-1"><label for="pr-${name}">${T('pr.' + name, label)}</label><select class="input" id="pr-${name}" name="${name}">${unit.slice(7).split(',').map(o => opt(o, name === 'patients.mode' ? T('pr.mode_' + o, MODE_OPTS[o]) : cap(o), v === o))}</select>${hint}</div>`;
        return html`<div class="field"><label for="pr-${name}">${T('pr.' + name, label)}${unit && unit !== 'naira' ? html` <span class="muted">(${T('unit.' + unit.replace(/\s+/g, '_'), unit)})</span>` : ''}${unit === 'naira' ? html` <span class="muted">(NGN)</span>` : ''}</label><input class="input" id="pr-${name}" name="${name}" type="number" min="0" step="any" value="${unit === 'naira' ? (v || 0) / 100 : v}" ${unit === 'naira' ? 'data-kobo' : ''}>${hint}</div>`;
      })}</div></section>`)}
      <div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${T('pr.save', 'Save processes')}</button></form>`);
    form('pr-save', async d => {
      const patch = {};
      Object.entries(PROC).forEach(([sec, fields]) => { patch[sec] = {}; Object.entries(fields).filter(([k]) => k !== '_t').forEach(([k, [, unit]]) => { const v = d[sec + '.' + k]; patch[sec][k] = unit === 'bool' ? !!v : /^select:/.test(unit) ? String(v || (p[sec] || {})[k]) : (v === undefined ? (p[sec] || {})[k] : Number(v)); }); });
      const oldMode = (p.patients || {}).mode; const newMode = patch.patients.mode;
      if (oldMode !== newMode) {
        const body = newMode === 'open'
          ? T('pr.to_open_body', 'Patients will be able to search and book any provider on MediCore, and the patient app stops showing one provider at a time. {pcn}', { pcn: pcn && pcn.status !== 'done' ? T('pr.pcn_missing', 'The PCN e-pharmacy aggregator registration is not marked done in the compliance register.') : '' })
          : T('pr.to_provider_body', 'Patients will only see and book the providers they belong to. Bookings already made are kept.');
        if (!(await confirm({ title: newMode === 'open' ? T('pr.to_open_q', 'Switch to open mode?') : T('pr.to_provider_q', 'Switch to provider mode?'), body, ok: T('pr.mode_ok', 'Change patient mode and save') }))) return;
      }
      await save('process', patch, null, v => T('pr.saved', 'Processes saved as version {v}', { v })); MC.render();
    });
  }

  /* ---------- pricing ---------- */
  async function pricing() {
    await load(); const pr = state.settings.pricing; const mods = Object.keys(pr.modulesKobo);
    const bd = (pr.branchDiscounts || []).slice(); const bdRows = Math.min(4, Math.max(2, bd.length + 1));
    view(html`${head(T('pc.title', 'Pricing'), T('pc.sub', 'Providers build their own package: the core package plus the apps they pick. Prices are per month.'))}${tabs('pricing')}
      <form class="panel" data-form="pc-save" novalidate>
        <div class="fields three"><div class="field"><label for="pc-b">${T('pc.base', 'Core package (NGN)')}</label><input class="input" id="pc-b" name="baseKobo" type="number" min="0" data-kobo value="${pr.baseKobo / 100}"><div class="hint">${T('pc.base_hint', 'Patient app, front desk, admin and HMO billing')}</div></div>
        <div class="field"><label for="pc-si">${T('pc.seats', 'Staff accounts included')}</label><input class="input" id="pc-si" name="seatsIncluded" type="number" min="1" value="${pr.seatsIncluded}"></div><div class="field"><label for="pc-es">${T('pc.extra', 'Each extra account (NGN)')}</label><input class="input" id="pc-es" name="extraSeatKobo" type="number" min="0" data-kobo value="${pr.extraSeatKobo / 100}"></div></div>
        <h2>${T('pc.apps', 'Apps')}</h2><div class="fields three">${mods.map(m => html`<div class="field"><label for="pc-${m}">${cap(m === 'payer' ? 'HMO desk' : m)} (NGN)</label><input class="input" id="pc-${m}" name="m_${m}" type="number" min="0" data-kobo value="${pr.modulesKobo[m] / 100}"></div>`)}</div>
        <h2>${T('pc.discounts', 'Bundle discounts')}</h2><div class="fields two">${[0, 1].map(i => html`<div class="row"><div class="field" style="flex:1"><label for="pc-dm${i}">${T('pc.min', 'From this many apps')}</label><input class="input" id="pc-dm${i}" name="dm${i}" type="number" min="0" value="${(pr.bundleDiscounts[i] || {}).minModules || ''}"></div><div class="field" style="flex:1"><label for="pc-dp${i}">${T('pc.pct', 'Discount %')}</label><input class="input" id="pc-dp${i}" name="dp${i}" type="number" min="0" max="60" value="${(pr.bundleDiscounts[i] || {}).percent || ''}"></div></div>`)}</div>
        <h2>${T('pc.branch_discounts', 'Hospital group discounts')}</h2><p class="muted sm">${T('pc.branch_hint', 'Taken off a group\'s monthly total when it runs at least this many branches. The biggest discount that applies is used. Leave a row empty to remove it.')}</p>
        <div class="fields two">${Array.from({ length: bdRows }, (_, i) => html`<div class="row"><div class="field" style="flex:1"><label for="pc-bm${i}">${T('pc.bmin', 'From this many branches')}</label><input class="input" id="pc-bm${i}" name="bm${i}" type="number" min="2" step="1" value="${(bd[i] || {}).minBranches || ''}"></div><div class="field" style="flex:1"><label for="pc-bp${i}">${T('pc.pct', 'Discount %')}</label><input class="input" id="pc-bp${i}" name="bp${i}" type="number" min="0" max="60" step="any" value="${bd[i] && bd[i].percent != null ? bd[i].percent : ''}"></div></div>`)}</div>
        <div class="fields three"><div class="field"><label for="pc-am">${T('pc.annual', 'Yearly plans charge this many months')}</label><input class="input" id="pc-am" name="annualMonthsCharged" type="number" min="1" max="12" value="${pr.annualMonthsCharged}"></div><div class="field"><label for="pc-td">${T('pc.trial', 'Free trial (days)')}</label><input class="input" id="pc-td" name="trialDays" type="number" min="0" max="365" value="${pr.trialDays}"></div></div>
        <label class="check"><input type="checkbox" name="selfServeModules" ${pr.selfServeModules ? 'checked' : ''}><span>${T('pc.self', 'Providers can add and remove apps themselves (otherwise each change becomes a request to HQ)')}</span></label>
        <div class="form-err notice bad" hidden></div><div class="btn-row"><button class="btn primary" type="submit">${T('pc.save', 'Save pricing')}</button></div></form>`);
    form('pc-save', async d => {
      const patch = { baseKobo: d.baseKobo, seatsIncluded: Number(d.seatsIncluded), extraSeatKobo: d.extraSeatKobo, annualMonthsCharged: Number(d.annualMonthsCharged), trialDays: Number(d.trialDays), selfServeModules: !!d.selfServeModules, modulesKobo: {}, bundleDiscounts: [], branchDiscounts: [] };
      mods.forEach(m => { patch.modulesKobo[m] = d['m_' + m]; });
      [0, 1].forEach(i => { if (d['dm' + i] && d['dp' + i] != null) patch.bundleDiscounts.push({ minModules: Number(d['dm' + i]), percent: Number(d['dp' + i]) }); });
      for (let i = 0; i < bdRows; i++) {
        const mb = d['bm' + i]; const pc = d['bp' + i];
        if (mb == null && pc == null) continue;
        if (!Number.isInteger(mb) || mb < 2) throw new MC.ApiError(400, { error: T('pc.bmin_err', 'A group discount needs a whole number of branches, 2 or more.') });
        if (pc == null || pc < 0 || pc > 60) throw new MC.ApiError(400, { error: T('pc.bpct_err', 'A group discount must be between 0 and 60 percent.') });
        patch.branchDiscounts.push({ minBranches: mb, percent: pc });
      }
      patch.branchDiscounts.sort((a, b) => a.minBranches - b.minBranches);
      await save('pricing', patch, null, v => T('pc.saved', 'Pricing saved as version {v}', { v })); MC.render();
    });
  }

  /* ---------- roles ---------- */
  async function rolesPage() {
    await load(); const cat = state.catalog; const rs = cat.roles; const perms = cat.perms;
    const ov = state.settings.roles.overrides || {};
    view(html`${head(T('rl.title', 'Roles'), T('rl.sub', 'What each role can do in every provider. Change built-in roles or create new ones; providers then assign them to staff.'))}${tabs('roles')}
      <div class="btn-row" style="margin-top:0;margin-bottom:16px"><button class="btn primary" data-action="rl-new">${icon('plus')}${T('rl.new', 'New role')}</button></div>
      <div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('rl.role', 'Role')}</th><th>${T('rl.app', 'App')}</th><th>${T('rl.perms', 'Permissions')}</th><th></th></tr></thead><tbody>
      ${Object.entries(rs).map(([k, r]) => html`<tr><td data-label="${T('rl.role', 'Role')}"><b>${r.label}</b>${r.custom ? html` ${badge(T('rl.custom', 'Custom'), 'hue')}` : ''}${ov[k] ? html` ${badge(T('rl.changed', 'Changed'), 'warn')}` : ''}<br><span class="xs muted">${k}</span></td><td data-label="${T('rl.app', 'App')}">${appName(r.app)}</td><td data-label="${T('rl.perms', 'Permissions')}" class="xs">${r.perms.map(p => perms[p] || p).join(', ')}</td><td class="num"><button class="btn sm" data-action="rl-edit" data-k="${k}">${T('rl.edit', 'Edit role')}</button></td></tr>`)}</tbody></table></div>`);
    const permBoxes = selected => html`${Object.entries(perms).map(([p, l]) => html`<label class="check"><input type="checkbox" name="perms" data-list value="${p}" ${selected.includes(p) ? 'checked' : ''}><span>${l} <span class="xs muted">${p}</span></span></label>`)}`;
    on('rl-edit', async el => {
      const k = el.dataset.k; const r = rs[k];
      const v = await dialog({ title: r.label, wide: true, form: true, body: html`<div class="field"><label for="rl-l">${T('rl.label', 'Name')}</label><input class="input" id="rl-l" name="label" value="${r.label}"></div><label class="check"><input type="checkbox" name="clock" ${r.clock ? 'checked' : ''}><span>${T('rl.clock', 'Must clock in to work')}</span></label><div class="field"><span class="label">${T('rl.perms', 'Permissions')}</span>${permBoxes(r.perms)}</div>`,
        actions: r.custom ? [{ label: T('rl.delete', 'Delete role'), value: 'delete' }, { label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('rl.save', 'Save role'), primary: true }] : [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('rl.save', 'Save role'), primary: true }],
        onSubmit: async d => {
          const sel = d.perms || []; const msg = v2 => T('rl.saved', 'Role saved as version {v}', { v: v2 });
          if (r.custom) return save('roles', { custom: { [k]: { label: d.label, app: r.app, module: r.module, clock: !!d.clock, perms: sel } } }, null, msg);
          const defaults = (await api.get('/api/meta/catalog')).roles[k]; // catalog reflects current; compute vs pristine via overrides
          const prev = ov[k] || {}; const pristine = new Set(defaults.perms.concat(prev.removePerms || []).filter(p => !(prev.addPerms || []).includes(p)));
          return save('roles', { overrides: { [k]: { label: d.label, clock: !!d.clock, addPerms: sel.filter(p => !pristine.has(p)), removePerms: [...pristine].filter(p => !sel.includes(p)) } } }, null, msg);
        } });
      if (v === 'delete') { if (await confirm({ title: T('rl.delete_q', 'Delete {r}?', { r: r.label }), body: T('rl.delete_body', 'Staff who have this role lose its access until they are given another role.'), ok: T('rl.delete', 'Delete role'), danger: true })) { await save('roles', { custom: { [k]: null } }, null, v2 => T('rl.deleted', 'Role deleted. Saved as version {v}.', { v: v2 })); } }
      if (v) MC.render();
    });
    on('rl-new', async () => {
      const v = await dialog({ title: T('rl.new', 'New role'), wide: true, form: true, body: html`<div class="fields two"><div class="field"><label for="rn-k">${T('rl.key', 'Key (lower case, e.g. triage_officer)')}</label><input class="input" id="rn-k" name="key" required pattern="[a-z][a-z0-9_]{2,30}"></div><div class="field"><label for="rn-l">${T('rl.label', 'Name')}</label><input class="input" id="rn-l" name="label" required></div></div>
        <div class="fields two"><div class="field"><label for="rn-a">${T('rl.app', 'App')}</label><select class="input" id="rn-a" name="app">${['frontdesk', 'doctor', 'pharmacy', 'rider', 'dispatch', 'crew', 'lab', 'chw', 'payer', 'admin'].map(a => html`<option value="${a}">${appName(a)}</option>`)}</select></div><div class="field"><label for="rn-m">${T('rl.module', 'Needs this app switched on')}</label><select class="input" id="rn-m" name="module"><option value="">${T('rl.none', 'None')}</option>${cat.modules.map(m => html`<option value="${m}">${cap(m)}</option>`)}</select></div></div>
        <label class="check"><input type="checkbox" name="clock" checked><span>${T('rl.clock', 'Must clock in to work')}</span></label><div class="field"><span class="label">${T('rl.perms', 'Permissions')}</span>${permBoxes([])}</div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('rl.create', 'Create role'), primary: true }], onSubmit: d => save('roles', { custom: { [d.key]: { label: d.label, app: d.app, module: d.module || null, clock: !!d.clock, perms: d.perms || [] } } }, null, v2 => T('rl.created', 'Role created. Saved as version {v}.', { v: v2 })) });
      if (v) MC.render();
    });
  }

  /* ---------- packages: provider types and app names ---------- */
  async function catalog() {
    await load(); const types = state.catalog.orgTypes; const mods = state.catalog.modules;
    view(html`${head(T('pk.title', 'Packages'), T('pk.sub', 'Which apps each kind of provider starts with, and which it can add. Providers can still pick any mix you allow.'))}${tabs('catalog')}
      <form data-form="pk-save" novalidate>${Object.entries(types).filter(([k]) => k !== 'hmo').map(([k, ty]) => html`<section class="panel"><h2>${ty.label}</h2><div class="field"><label for="pk-${k}">${T('pk.label', 'Name')}</label><input class="input" id="pk-${k}" name="label_${k}" value="${ty.label}"></div>
        <div class="grid two"><div><span class="label">${T('pk.default', 'Starts with')}</span>${mods.filter(m => m !== 'payer').map(m => html`<label class="check"><input type="checkbox" name="def_${k}" data-list value="${m}" ${ty.modules.includes(m) ? 'checked' : ''} ${m === 'frontdesk' ? 'disabled checked' : ''}><span>${cap(m)}</span></label>`)}</div>
        <div><span class="label">${T('pk.optional', 'Can add')}</span>${mods.filter(m => m !== 'payer' && m !== 'frontdesk' && m !== 'hmo').map(m => html`<label class="check"><input type="checkbox" name="opt_${k}" data-list value="${m}" ${ty.optional.includes(m) ? 'checked' : ''}><span>${cap(m)}</span></label>`)}</div></div></section>`)}
      <div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${T('pk.save', 'Save packages')}</button></form>`);
    form('pk-save', async d => {
      const orgTypes = {};
      Object.keys(types).filter(k => k !== 'hmo').forEach(k => { orgTypes[k] = { label: d['label_' + k], modules: ['frontdesk'].concat(d['def_' + k] || []).filter((x, i, a) => a.indexOf(x) === i), optional: d['opt_' + k] || [] }; });
      await save('catalog', { orgTypes }, null, v => T('pk.saved', 'Packages saved as version {v}', { v })); MC.render();
    });
  }

  /* ======================= integrations ======================= */
  /* field spec: { p: path inside settings.integrations, l: label, k: kind (text|url|secret|number|bool|select|textarea), o: options [[v,l]], h: hint, when: 'path=a|b', full: span both columns }
   * or { head: 'Sub heading' } / { note: html } */
  const YES = (k, d) => T('in.f.' + k, d);
  const PAY_PLACEHOLDERS = ['reference', 'amountKobo', 'amountNaira', 'email', 'phone', 'name', 'callbackUrl', 'orgName', 'settlementAccount', 'settlementBankCode', 'settlementSubaccount'];
  const SMS_PLACEHOLDERS = ['to', 'toNoPlus', 'text', 'sender'];
  const ph = list => html`<div class="row wrap" style="gap:6px;margin-top:6px">${list.map(x => html`<code class="badge outline plain">{{${x}}}</code>`)}</div>`;
  const PAY_EXAMPLE = '{\n  "amount": {{amountKobo}},\n  "currency": "NGN",\n  "reference": "{{reference}}",\n  "customer": { "email": "{{email}}", "phone": "{{phone}}", "name": "{{name}}" },\n  "redirectUrl": "{{callbackUrl}}",\n  "description": "Bill at {{orgName}}",\n  "settlement": { "accountNumber": "{{settlementAccount}}", "bankCode": "{{settlementBankCode}}" }\n}';
  const SMS_EXAMPLE = '{\n  "to": "{{toNoPlus}}",\n  "from": "{{sender}}",\n  "message": "{{text}}"\n}';
  let SPECS = {}; let PAY_GW = []; let SMS_GW = []; let OTHER = []; let ITABS = [];
  const buildSpecs = () => ({
    paystack: [{ p: 'paystack.publicKey', l: YES('ps_pub', 'Public key'), h: YES('ps_pub_h', 'Starts with pk_live_ (or pk_test_ for testing).') }, { p: 'paystack.secretKey', l: YES('ps_sec', 'Secret key'), k: 'secret', h: YES('ps_sec_h', 'Starts with sk_live_. Paystack also signs its webhooks with this key.') }],
    flutterwave: [{ p: 'flutterwave.publicKey', l: YES('fw_pub', 'Public key') }, { p: 'flutterwave.secretKey', l: YES('fw_sec', 'Secret key'), k: 'secret' }, { p: 'flutterwave.webhookHash', l: YES('fw_hash', 'Webhook secret hash'), k: 'secret', h: YES('fw_hash_h', 'The same "secret hash" you type in the Flutterwave dashboard under Settings, Webhooks.') }],
    monnify: [{ p: 'monnify.apiKey', l: YES('mn_key', 'API key') }, { p: 'monnify.secretKey', l: YES('mn_sec', 'Secret key'), k: 'secret' }, { p: 'monnify.contractCode', l: YES('mn_cc', 'Contract code') }, { p: 'monnify.baseUrl', l: YES('mn_url', 'API address'), k: 'url', h: YES('mn_url_h', 'https://api.monnify.com for live, https://sandbox.monnify.com for testing.') }],
    customPayment: [
      { head: YES('cp_h_conn', 'Connection') },
      { p: 'customPayment.label', l: YES('cp_label', 'Name of the bank or gateway') }, { p: 'customPayment.baseUrl', l: YES('cp_base', 'API base address'), k: 'url', h: YES('cp_base_h', 'For example https://api.yourbank.com/collections. Every path below is added to this.') },
      { head: YES('cp_h_auth', 'How MediCore signs in to the API') },
      { p: 'customPayment.auth.type', l: YES('cp_auth', 'Sign-in method'), k: 'select', o: [['none', YES('cp_auth_none', 'None')], ['bearer', YES('cp_auth_bearer', 'Bearer token')], ['header', YES('cp_auth_header', 'API key in a header')], ['basic', YES('cp_auth_basic', 'Username and password (basic)')], ['oauth2', YES('cp_auth_oauth2', 'OAuth2 client credentials')]] },
      { p: 'customPayment.auth.headerName', l: YES('cp_hname', 'Header name'), when: 'customPayment.auth.type=bearer|header', h: YES('cp_hname_h', 'Authorization for a bearer token, or the header the bank names, such as X-API-Key.') },
      { p: 'customPayment.auth.token', l: YES('cp_token', 'Token or API key'), k: 'secret', when: 'customPayment.auth.type=bearer|header' },
      { p: 'customPayment.auth.username', l: YES('cp_user', 'Username'), when: 'customPayment.auth.type=basic' },
      { p: 'customPayment.auth.password', l: YES('cp_pass', 'Password'), k: 'secret', when: 'customPayment.auth.type=basic' },
      { p: 'customPayment.auth.tokenUrl', l: YES('cp_turl', 'Token address'), k: 'url', when: 'customPayment.auth.type=oauth2', h: YES('cp_turl_h', 'Where MediCore asks for an access token, for example https://auth.yourbank.com/oauth/token.') },
      { p: 'customPayment.auth.clientId', l: YES('cp_cid', 'Client id'), when: 'customPayment.auth.type=oauth2' },
      { p: 'customPayment.auth.clientSecret', l: YES('cp_csec', 'Client secret'), k: 'secret', when: 'customPayment.auth.type=oauth2' },
      { p: 'customPayment.auth.scope', l: YES('cp_scope', 'Scope (optional)'), when: 'customPayment.auth.type=oauth2' },
      { head: YES('cp_h_init', 'Start a payment') },
      { p: 'customPayment.init.method', l: YES('cp_im', 'Method'), k: 'select', o: [['POST', 'POST'], ['PUT', 'PUT'], ['GET', 'GET']] },
      { p: 'customPayment.init.path', l: YES('cp_ip', 'Path'), h: YES('cp_ip_h', 'For example /v1/payments. Placeholders such as {{reference}} are allowed.') },
      { p: 'customPayment.init.bodyTemplate', l: YES('cp_ib', 'Request body (JSON template)'), k: 'textarea', full: true, ph: PAY_PLACEHOLDERS, example: PAY_EXAMPLE, h: YES('cp_ib_h', 'Write the JSON the bank expects. MediCore fills in the placeholders for each bill. Number placeholders such as {{amountKobo}} go without quotes.') },
      { p: 'customPayment.init.checkoutUrlPath', l: YES('cp_ic', 'Where the checkout link is in the reply'), h: YES('cp_ic_h', 'A dot path, for example data.checkoutUrl. The link must start with https://.') },
      { p: 'customPayment.init.providerRefPath', l: YES('cp_ir', 'Where the bank\'s own reference is in the reply (optional)'), h: YES('cp_ir_h', 'A dot path, for example data.transactionId.') },
      { head: YES('cp_h_verify', 'Confirm a payment') },
      { p: 'customPayment.verify.method', l: YES('cp_vm', 'Method'), k: 'select', o: [['GET', 'GET'], ['POST', 'POST']] },
      { p: 'customPayment.verify.path', l: YES('cp_vp', 'Path'), h: YES('cp_vp_h', 'For example /v1/payments/{{reference}}. With POST the body is {"reference": "..."}.') },
      { p: 'customPayment.verify.statusPath', l: YES('cp_vs', 'Where the status is in the reply'), h: YES('cp_vs_h', 'A dot path, for example data.status.') },
      { p: 'customPayment.verify.successValues', l: YES('cp_vv', 'Status values that mean paid'), h: YES('cp_vv_h', 'Separate with commas, for example success,paid,completed.') },
      { p: 'customPayment.verify.amountPath', l: YES('cp_va', 'Where the amount is in the reply') },
      { p: 'customPayment.verify.amountUnit', l: YES('cp_vu', 'The amount is in'), k: 'select', o: [['kobo', YES('cp_kobo', 'Kobo (1 naira = 100)')], ['naira', YES('cp_naira', 'Naira')]] },
      { head: YES('cp_h_hook', 'Webhook (the bank tells MediCore about a payment)') },
      { p: 'customPayment.webhook.algorithm', l: YES('cp_wa', 'Signature check'), k: 'select', o: [['sha512', 'HMAC SHA-512'], ['sha256', 'HMAC SHA-256'], ['none', YES('cp_wa_none', 'No signature: MediCore confirms each payment with the verify call')]] },
      { p: 'customPayment.webhook.signatureHeader', l: YES('cp_wh', 'Signature header'), when: 'customPayment.webhook.algorithm=sha512|sha256', h: YES('cp_wh_h', 'The header that carries the signature, for example X-Bank-Signature.') },
      { p: 'customPayment.webhook.secret', l: YES('cp_ws', 'Webhook signing secret'), k: 'secret', when: 'customPayment.webhook.algorithm=sha512|sha256' },
      { p: 'customPayment.webhook.referencePath', l: YES('cp_wr', 'Where the payment reference is in the webhook') },
      { p: 'customPayment.webhook.statusPath', l: YES('cp_ws2', 'Where the status is in the webhook') },
      { p: 'customPayment.webhook.amountPath', l: YES('cp_wam', 'Where the amount is in the webhook') },
    ],
    termii: [{ p: 'termii.apiKey', l: YES('tm_key', 'API key'), k: 'secret' }, { p: 'termii.senderId', l: YES('tm_sender', 'Sender ID'), h: YES('tm_sender_h', 'Must be approved by Termii before it can be used.') }],
    africastalking: [{ p: 'africastalking.username', l: YES('at_user', 'Username'), h: YES('at_user_h', 'Use sandbox for testing.') }, { p: 'africastalking.apiKey', l: YES('at_key', 'API key'), k: 'secret' }, { p: 'africastalking.senderId', l: YES('at_sender', 'Sender ID or short code (optional)') }],
    customSms: [
      { p: 'customSms.url', l: YES('cs_url', 'Send address'), k: 'url', full: true, h: YES('cs_url_h', 'The full https address that sends one SMS.') },
      { p: 'customSms.method', l: YES('cs_method', 'Method'), k: 'select', o: [['POST', 'POST'], ['GET', 'GET']] },
      { p: 'customSms.contentType', l: YES('cs_ct', 'Body format'), k: 'select', o: [['json', 'JSON'], ['form', YES('cs_form', 'Form fields')]] },
      { p: 'customSms.headerName', l: YES('cs_hname', 'Header for the token'), h: YES('cs_hname_h', 'Authorization, or the header your provider names.') },
      { p: 'customSms.token', l: YES('cs_token', 'Token or API key'), k: 'secret' },
      { p: 'customSms.bodyTemplate', l: YES('cs_body', 'Request body (template)'), k: 'textarea', full: true, ph: SMS_PLACEHOLDERS, example: SMS_EXAMPLE },
      { p: 'customSms.successStatus', l: YES('cs_ok', 'HTTP status that means sent'), k: 'number' },
    ],
    turn: [{ p: 'turn.url', l: YES('turn_url', 'TURN address (turn:...)') }, { p: 'turn.username', l: YES('turn_user', 'Username') }, { p: 'turn.credential', l: YES('turn_pass', 'Password'), k: 'secret' }],
    maps: [{ p: 'maps.tileUrl', l: YES('maps_url', 'Tile address (https, with {z}/{x}/{y})'), k: 'url' }, { p: 'maps.attribution', l: YES('maps_attr', 'Attribution text') }],
    geocoder: [{ p: 'geocoder.url', l: YES('geo_url', 'Photon-compatible address (https)'), k: 'url' }],
    routing: [{ p: 'routing.url', l: YES('rt_url', 'OSRM-compatible address (https)'), k: 'url' }],
    identity: [{ p: 'identity.provider', l: YES('id_prov', 'NIN verification partner'), k: 'select', o: [['', YES('id_off', 'Off: NINs are saved and confirmed by staff')], ['dojah', 'Dojah'], ['prembly', 'Prembly (IdentityPass)'], ['custom', YES('id_custom', 'Another licensed partner (custom API)')]] },
      { p: 'identity.baseUrl', l: YES('id_base', 'API address (https)'), k: 'url', h: YES('id_base_h', 'For example https://api.dojah.io or https://api.prembly.com. Check the paths against the partner\'s current docs.') },
      { p: 'identity.appId', l: YES('id_app', 'App ID') }, { p: 'identity.apiKey', l: YES('id_key', 'Secret key'), k: 'secret' },
      { p: 'identity.path', l: YES('id_path', 'Lookup path (optional)'), h: YES('id_path_h', 'Leave empty for the partner\'s default. For a custom API use {{nin}} where the number goes.') },
      { p: 'identity.method', l: YES('id_method', 'Method (custom API)'), k: 'select', o: [['GET', 'GET'], ['POST', 'POST']], when: 'identity.provider=custom' },
      { p: 'identity.headerName', l: YES('id_hname', 'Header for the key (custom API)'), when: 'identity.provider=custom' },
      { p: 'identity.dataPath', l: YES('id_data', 'Where the person sits in the reply (custom API)'), when: 'identity.provider=custom', h: YES('id_data_h', 'For example data or entity. MediCore reads first_name, last_name and date_of_birth from there.') }],
    wearables: [{ p: 'wearables.provider', l: YES('wr_prov', 'Wearables partner'), k: 'select', o: [['', YES('wr_off', 'Off: companion app, Bluetooth and typed readings only')], ['terra', 'Terra']] }, { p: 'wearables.baseUrl', l: YES('wr_base', 'API address (https)'), k: 'url' }, { p: 'wearables.devId', l: YES('wr_dev', 'Developer ID') }, { p: 'wearables.apiKey', l: YES('wr_key', 'API key'), k: 'secret' }, { p: 'wearables.webhookSecret', l: YES('wr_hook', 'Webhook signing secret'), k: 'secret' }],
    ussd: [{ p: 'ussd.secret', l: YES('ussd_sec', 'Shared secret'), k: 'secret', h: YES('ussd_sec_h', 'The aggregator sends this with every USSD request.') }],
    ai: [{ p: 'ai.provider', l: YES('ai_prov', 'Provider'), k: 'select', o: [['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['google', 'Google'], ['openai_compatible', YES('ai_compat', 'OpenAI-compatible endpoint')]] }, { p: 'ai.model', l: YES('ai_model', 'Main model') }, { p: 'ai.fastModel', l: YES('ai_fast', 'Fast model for simple questions') }, { p: 'ai.apiKey', l: YES('ai_key', 'API key'), k: 'secret' }, { p: 'ai.baseUrl', l: YES('ai_base', 'Custom endpoint (optional, https)'), k: 'url' }, { p: 'ai.maxTokens', l: YES('ai_tokens', 'Longest answer (tokens)'), k: 'number' }, { p: 'ai.monthlyBudgetNgn', l: YES('ai_budget', 'Monthly budget (NGN)'), k: 'number' }, { p: 'ai.region', l: YES('ai_region', 'Data region note') }],
    whatsapp: [
      { head: YES('wa_h_acct', 'Account') },
      { p: 'whatsapp.phoneNumberId', l: YES('wa_id', 'Phone number ID (platform number)'), h: YES('wa_id_h', 'From the Meta app, WhatsApp, API setup. Digits only. Chats to this number go to the patient\'s provider.') },
      { p: 'whatsapp.businessAccountId', l: YES('wa_waba', 'WhatsApp Business account ID'), h: YES('wa_waba_h', 'Digits only. Shown next to the phone number ID in the Meta app.') },
      { p: 'whatsapp.apiVersion', l: YES('wa_ver', 'API version'), h: YES('wa_ver_h', 'For example v21.0. Change it only when Meta retires the version.') },
      { head: YES('wa_h_keys', 'Keys') },
      { p: 'whatsapp.accessToken', l: YES('wa_token', 'Access token'), k: 'secret', h: YES('wa_token_h', 'A permanent system user token with the whatsapp_business_messaging and whatsapp_business_management permissions. Temporary tokens stop working after 24 hours.') },
      { p: 'whatsapp.appSecret', l: YES('wa_secret', 'App secret'), k: 'secret', h: YES('wa_secret_h', 'From the Meta app, App settings, Basic. MediCore uses it to check that webhook calls really come from Meta.') },
      { p: 'whatsapp.verifyToken', l: YES('wa_verify', 'Webhook verify token'), k: 'secret', h: YES('wa_verify_h', 'Any long random text you choose. Type the same text in the Meta webhook settings.') },
      { head: YES('wa_h_tpl', 'Message templates') },
      { note: html`<p class="muted sm" style="grid-column:1/-1;margin:0 0 8px">${YES('wa_tpl_note', 'Type the template names exactly as approved in WhatsApp Manager. Outside a 24 hour chat window, WhatsApp only delivers approved templates.')}</p>` },
      { p: 'whatsapp.templates.update', l: YES('wa_tpl_up', 'Update template name'), h: YES('wa_tpl_up_h', 'Utility template with two variables: {{1}} is the title and {{2}} the details.') },
      { p: 'whatsapp.templates.updateLanguage', l: YES('wa_tpl_up_l', 'Update template language'), h: YES('wa_lang_h', 'The language code of the approved template, for example en, en_GB or en_US.') },
      { p: 'whatsapp.templates.code', l: YES('wa_tpl_code', 'Sign-in code template name'), h: YES('wa_tpl_code_h', 'Authentication template. Its one variable is the code.') },
      { p: 'whatsapp.templates.codeLanguage', l: YES('wa_tpl_code_l', 'Sign-in code template language'), h: YES('wa_lang_h', 'The language code of the approved template, for example en, en_GB or en_US.') },
      { head: YES('wa_h_use', 'What WhatsApp is used for') },
      { p: 'whatsapp.notifyPatients', l: YES('wa_notify', 'Send patient notifications on WhatsApp'), k: 'bool', h: YES('wa_notify_h', 'Patients who agreed to WhatsApp get every notification there instead of by SMS.') },
      { p: 'whatsapp.sendCodes', l: YES('wa_codes', 'Send sign-in codes on WhatsApp'), k: 'bool', h: YES('wa_codes_h', 'Uses the sign-in code template. If WhatsApp fails, the code goes by SMS.') },
      { p: 'whatsapp.inbox', l: YES('wa_inbox', 'WhatsApp inbox for providers'), k: 'bool', h: YES('wa_inbox_h', 'Chats to provider and department numbers appear in the staff apps, so staff can reply from MediCore.') },
      { head: YES('wa_h_replies', 'Automatic replies') },
      { p: 'whatsapp.autoReply', l: YES('wa_auto', 'Automatic reply text'), k: 'longtext', h: YES('wa_auto_h', 'Sent once when a patient starts a chat. Leave empty to send nothing.') },
      { p: 'whatsapp.unknownReply', l: YES('wa_unknown', 'Reply to unknown numbers'), k: 'longtext', h: YES('wa_unknown_h', 'Sent when the number does not belong to a patient on MediCore.') },
    ],
    email: [
      { p: 'email.provider', l: YES('em_prov', 'Email gateway'), k: 'select', o: [['', YES('em_none', 'Off: no emails are sent')], ['sendgrid', 'SendGrid'], ['brevo', 'Brevo'], ['mailgun', 'Mailgun'], ['resend', 'Resend']] },
      { p: 'email.apiKey', l: YES('em_key', 'API key'), k: 'secret', h: YES('em_key_h', 'A key that can send email. Give it sending rights only.') },
      { p: 'email.from', l: YES('em_from', 'From address'), h: YES('em_from_h', 'Must be a sender or domain verified with the gateway, for example claims@medicore.ng.') },
      { p: 'email.fromName', l: YES('em_from_name', 'From name'), h: YES('em_from_name_h', 'The name HMOs see, for example MediCore.') },
      { p: 'email.mailgunDomain', l: YES('em_mg_domain', 'Mailgun sending domain'), when: 'email.provider=mailgun', h: YES('em_mg_domain_h', 'For example mg.medicore.ng.') },
      { p: 'email.mailgunRegion', l: YES('em_mg_region', 'Mailgun region'), k: 'select', when: 'email.provider=mailgun', o: [['us', YES('em_mg_us', 'United States (api.mailgun.net)')], ['eu', YES('em_mg_eu', 'Europe (api.eu.mailgun.net)')]] },
    ],
    payActive: [{ p: 'payments.provider', l: YES('pay_prov', 'Gateway for online payments'), k: 'select', o: [['paystack', 'Paystack'], ['flutterwave', 'Flutterwave'], ['monnify', 'Monnify'], ['custom', YES('pay_custom', 'Bank or custom API')], ['none', YES('pay_none', 'Off: no online payments')]] },
      { p: 'payments.label', l: YES('pay_label', 'Name shown to patients (optional)'), h: YES('pay_label_h', 'For example your bank\'s name. Leave empty to show the gateway\'s name.') },
      { p: 'payments.settleToProviders', l: YES('pay_settle', 'Send each provider\'s money to its own settlement account'), k: 'bool', full: true, h: YES('pay_settle_h', 'Uses the subaccount or bank account each provider saves in its admin app. When off, all money settles to the MediCore account.') }],
    smsActive: [{ p: 'sms.provider', l: YES('sms_prov', 'Gateway for SMS'), k: 'select', o: [['termii', 'Termii'], ['africastalking', 'Africa\'s Talking'], ['custom', YES('sms_custom', 'Custom HTTP API')], ['none', YES('sms_none', 'Off: no SMS are sent')]] }],
  });
  function buildLists() {
  SPECS = buildSpecs();
  PAY_GW = [['paystack', 'Paystack', 'paystack', 'paystack'], ['flutterwave', 'Flutterwave', 'flutterwave', 'flutterwave'], ['monnify', 'Monnify', 'monnify', 'monnify'], ['custom', T('in.custom_t', 'Bank or custom API'), 'customPayment', 'customPayment']];
  SMS_GW = [['termii', 'Termii', 'termii', 'termii'], ['africastalking', 'Africa\'s Talking', 'africastalking', 'africastalking'], ['custom', T('in.custom_sms_t', 'Custom HTTP API'), 'customSms', null]];
  OTHER = [['turn', T('in.turn', 'Video relay (TURN)'), null, T('in.turn_d', 'Needed so video visits connect on mobile networks that block direct calls.')], ['maps', T('in.maps', 'Map tiles'), null, T('in.maps_d', 'The background map in dispatch, rider and patient tracking screens.')], ['geocoder', T('in.geocoder', 'Address search'), null, ''], ['routing', T('in.routing', 'Road routing'), null, ''], ['ussd', T('in.ussd', 'USSD aggregator'), null, T('in.ussd_d', 'Give the aggregator this address: {url}', { url: location.origin + '/api/ussd' })], ['ai', T('in.ai', 'AI assistant'), 'ai', ''], ['wearables', T('in.wearables', 'Wearables partner'), null, T('in.wearables_d', 'Connects watch brands\' cloud accounts (Fitbit, Garmin, Withings, Oura, Polar, Huawei). Webhook address: {url}', { url: location.origin + '/api/wearables/webhook/terra' })], ['identity', T('in.identity', 'NIN verification'), null, T('in.identity_d', 'Confirms each patient\'s NIN with a licensed NIMC partner at registration. Needs an account with the partner and a data processing agreement.')]];
  ITABS = [['payments', T('in.t.payments', 'Payments')], ['sms', T('in.t.sms', 'SMS')], ['whatsapp', T('in.t.whatsapp', 'WhatsApp')], ['wanumbers', T('in.t.wanumbers', 'WhatsApp numbers')], ['email', T('in.t.email', 'Email')], ['other', T('in.t.other', 'Video, maps, USSD and AI')]];
  }
  const KEY_TAB = { payments: 'payments', sms: 'sms', turn: 'other', maps: 'other', geocoder: 'other', routing: 'other', ussd: 'other', ai: 'other', identity: 'other', wearables: 'other', whatsapp: 'whatsapp', wanumbers: 'wanumbers', email: 'email' };
  const settingsHref = key => (key === 'connectors' ? '#/connectors' : '#/config/integrations?tab=' + (KEY_TAB[key] || 'other') + '&panel=' + key);

  function renderField(f, src, owner) {
    if (f.head) return html`<h3 style="grid-column:1/-1;margin:12px 0 8px">${f.head}</h3>`;
    if (f.note) return f.note;
    const v = getP(src, f.p); const id1 = 'f-' + f.p.replace(/[^\w]/g, '-'); const D = owner ? '' : MC.raw('disabled');
    const wrapAttrs = html`${f.when ? html` data-when="${f.when}"` : ''}${f.full || f.k === 'textarea' || f.k === 'longtext' || f.k === 'bool' ? MC.raw(' style="grid-column:1/-1"') : ''}`;
    const hint = f.h ? html`<div class="hint">${f.h}</div>` : '';
    if (f.k === 'secret') {
      const set = v && v.set;
      return html`<div class="field"${wrapAttrs}><label for="${id1}">${f.l}</label>
        <div style="margin-bottom:6px">${set ? badge(T('in.saved_ends', 'Saved, ends in {l}', { l: v.last4 || '****' }), 'ok') : badge(T('in.not_set', 'Not set'), 'outline')}</div>
        <input class="input" id="${id1}" name="${f.p}" type="password" autocomplete="new-password" spellcheck="false" placeholder="${set ? T('in.replace_ph', 'Type a new value to replace it') : T('in.enter_ph', 'Type the value to save it')}" ${D}>
        ${set && owner ? html`<label class="check"><input type="checkbox" name="clear::${f.p}"><span>${T('in.clear_one', 'Clear the saved value when I save')}</span></label>` : ''}${hint}</div>`;
    }
    if (f.k === 'bool') return html`<div class="field"${wrapAttrs}><label class="check"><input type="checkbox" name="${f.p}" ${v ? 'checked' : ''} ${D}><span><b>${f.l}</b>${f.h ? html`<br><span class="sm muted">${f.h}</span>` : ''}</span></label></div>`;
    if (f.k === 'select') return html`<div class="field"${wrapAttrs}><label for="${id1}">${f.l}</label><select class="input" id="${id1}" name="${f.p}" ${D}>${f.o.map(([ov, ol]) => opt(ov, ol, v === ov))}</select>${hint}</div>`;
    if (f.k === 'longtext') return html`<div class="field"${wrapAttrs}><label for="${id1}">${f.l}</label><textarea class="input" id="${id1}" name="${f.p}" rows="3" maxlength="1000" ${D}>${v || ''}</textarea>${hint}</div>`;
    if (f.k === 'textarea') return html`<div class="field"${wrapAttrs}><label for="${id1}">${f.l}</label><textarea class="input" id="${id1}" name="${f.p}" rows="8" spellcheck="false" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.875rem" ${D}>${v || ''}</textarea>${hint}
      ${f.ph ? html`<div class="hint">${T('in.placeholders', 'Placeholders you can use:')}</div>${ph(f.ph)}` : ''}
      ${f.example ? html`<details style="margin-top:8px"><summary class="btn ghost sm">${T('in.example', 'Show an example')}</summary><pre style="${preStyle}">${f.example}</pre></details>` : ''}</div>`;
    return html`<div class="field"${wrapAttrs}><label for="${id1}">${f.l}</label><input class="input" id="${id1}" name="${f.p}" ${f.k === 'number' ? MC.raw('type="number" min="0" step="1"') : f.k === 'url' ? MC.raw('type="url" inputmode="url" spellcheck="false"') : ''} value="${v == null ? '' : v}" ${D}>${hint}</div>`;
  }
  function collect(d, specs) {
    const patch = {};
    specs.filter(f => f.p).forEach(f => {
      const v = d[f.p];
      if (f.k === 'secret') { if (d['clear::' + f.p]) setP(patch, f.p, ''); else if (v) setP(patch, f.p, String(v).trim()); return; }
      if (f.k === 'bool') return setP(patch, f.p, !!v);
      if (f.k === 'number') return setP(patch, f.p, v === undefined || v === '' ? 0 : Number(v));
      if (f.k === 'textarea' || f.k === 'longtext') return setP(patch, f.p, v == null ? '' : String(v));
      setP(patch, f.p, v == null ? '' : String(v).trim());
    });
    return patch;
  }
  function checkTemplates(patch) {
    const tpl = [getP(patch, 'customPayment.init.bodyTemplate'), getP(patch, 'customSms.bodyTemplate')];
    tpl.forEach(t2 => { if (t2 && /^\s*[{[]/.test(t2)) { try { JSON.parse(String(t2).replace(/\{\{\w+\}\}/g, '0')); } catch (e) { throw new MC.ApiError(400, { error: T('in.bad_json', 'The body template is not valid JSON. Check quotes, commas and brackets; placeholders like {{reference}} are allowed.') }); } } });
  }
  const urlBox = (id, label, url, aria) => html`<div class="field"><label for="${id}">${label}</label><div class="row" style="gap:8px;flex-wrap:nowrap"><input class="input" id="${id}" value="${url}" readonly style="flex:1;min-width:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.875rem"><button type="button" class="btn" data-action="in-copy" data-v="${url}" aria-label="${aria}">${T('in.copy', 'Copy')}</button></div></div>`;
  const webhookBox = name => urlBox('wh-' + name, T('in.webhook', 'Webhook address to give the gateway'), location.origin + '/api/pay/' + name + '/webhook', T('in.copy_aria', 'Copy the webhook address'));
  function gwPanel({ key, title, spec, test, hook, active, open, owner, src, extra, statusLine }) {
    return html`<details class="panel" id="in-p-${key}" ${open ? 'open' : ''}><summary style="cursor:pointer;min-height:44px;display:flex;align-items:center;gap:8px;flex-wrap:wrap"><b style="font-size:var(--t-lg)">${title}</b>${active ? badge(T('in.active', 'Active'), 'hue') : ''}${statusLine || ''}<span class="muted" style="margin-left:auto;display:inline-flex" aria-hidden="true">${icon('more')}</span></summary>
      <form data-form="in-save" data-k="${spec}" novalidate style="margin-top:12px">
        ${hook ? webhookBox(hook) : ''}${extra || ''}
        <div class="fields two">${SPECS[spec].map(f => renderField(f, src, owner))}</div>
        <div class="form-err notice bad" hidden></div>
        ${owner ? html`<div class="btn-row"><button class="btn primary" type="submit">${T('in.save_gw', 'Save {name} settings', { name: title })}</button>${test ? html`<button type="button" class="btn" data-action="in-test" data-k="${test}">${icon('refresh')}${T('in.test', 'Test connection')}</button>` : ''}</div>
          ${test ? html`<p class="muted sm" style="margin-top:8px">${T('in.test_hint', 'The test uses the saved settings, so save first.')}</p><div id="to-${test}" aria-live="polite"></div>` : ''}` : ''}
      </form></details>`;
  }
  const statusBadgeFor = st => (st ? (st.ready ? badge(T('gl.ready', 'Ready'), 'ok') : st.needs ? badge(T('gl.needs_setup', 'Needs setup'), 'warn') : badge(T('gl.optional', 'Optional'), 'outline')) : '');
  const SAVED_MSG = { payActive: 'Payment gateway choice saved as version {v}', smsActive: 'SMS gateway choice saved as version {v}', whatsapp: 'WhatsApp settings saved as version {v}', email: 'Email settings saved as version {v}' };
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const needsLine = x => (x && !x.ready && x.needs ? html`<p class="muted sm" style="margin:8px 0 0">${T('gl.needs', 'Needs: {what}', { what: x.needs })}</p>` : '');

  /* ---------- WhatsApp ---------- */
  function checkWhatsapp(patch) {
    const w = patch.whatsapp || {}; const tp = w.templates || {};
    const err = m => { throw new MC.ApiError(400, { error: m }); };
    if (w.phoneNumberId && !/^\d{5,25}$/.test(w.phoneNumberId)) err(T('in.wa_bad_id', 'The phone number ID is digits only. It is not the phone number itself.'));
    if (w.businessAccountId && !/^\d{5,25}$/.test(w.businessAccountId)) err(T('in.wa_bad_waba', 'The WhatsApp Business account ID is digits only.'));
    if (w.apiVersion && !/^v\d{1,3}\.\d{1,2}$/.test(w.apiVersion)) err(T('in.wa_bad_ver', 'Write the API version like v21.0.'));
    [tp.update, tp.code].forEach(n => { if (n && !/^[a-z0-9_]{1,512}$/.test(n)) err(T('in.wa_bad_tpl', 'Template names use lower case letters, numbers and _ only, exactly as in WhatsApp Manager.')); });
    [tp.updateLanguage, tp.codeLanguage].forEach(l => { if (l && !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(l)) err(T('in.wa_bad_lang', 'Write the template language as a code such as en, en_GB or en_US.')); });
    if (w.sendCodes && !tp.code) err(T('in.wa_need_code', 'Sending sign-in codes on WhatsApp needs the sign-in code template name.'));
  }
  const WA_UPDATE_BODY = 'Update from your health provider. {{1}}: {{2}}';
  const WA_CODE_BODY = '*{{1}}* is your verification code. For your security, do not share this code.';
  function whatsappBody(s, ws, owner) {
    const w = s.whatsapp || {}; const featOn = !!state.settings.features.whatsapp; const blockedBy = featureBlockers().whatsapp;
    const step = (title, text, extra) => html`<li style="margin-bottom:12px"><b>${title}</b><br><span class="sm">${text}</span>${extra || ''}</li>`;
    return html`<section class="panel" id="in-p-whatsapp"><div class="row between wrap"><h2 style="margin:0">${T('in.wa_title', 'WhatsApp Business')}</h2>${statusBadgeFor(ws)}</div>
        <p class="muted sm" style="margin:8px 0 0">${T('in.wa_sub', 'Patients who agree get their notifications and sign-in codes on WhatsApp, and staff answer chats from a shared inbox. Click-to-chat buttons on provider numbers work without any of this.')}</p>
        ${needsLine(ws)}
        ${!featOn ? html`<div class="notice warn" style="margin-top:12px">${T('in.wa_feature_off', 'The WhatsApp feature is switched off, so nothing is sent or received on WhatsApp even when the settings below are saved.')} <a href="#/config/features">${T('in.wa_feature_link', 'Switch on WhatsApp in Features')}</a></div>` : ''}
        ${blockedBy ? html`<div class="notice bad" style="margin-top:12px">${T('in.wa_blocked', 'WhatsApp is switched off by the compliance register until this is done: {items}.', { items: blockedBy.join(', ') })} <a href="#/compliance">${T('ft.open_compliance', 'Open the compliance register')}</a></div>` : ''}
        <div style="margin-top:12px">${urlBox('wh-whatsapp', T('in.wa_hook', 'Webhook address to give Meta'), location.origin + '/api/whatsapp/webhook', T('in.copy_aria', 'Copy the webhook address'))}</div>
        <details ${ws && ws.ready ? '' : 'open'}><summary class="btn ghost sm">${T('in.wa_checklist', 'Setup checklist')}</summary>
          <ol style="padding-left:20px;margin:12px 0 0">
            ${step(T('in.wa_s1', 'Create the Meta accounts'), T('in.wa_s1_d', 'Create a Meta Business account at business.facebook.com, then a WhatsApp Business account inside it. In developers.facebook.com create an app of type Business and add the WhatsApp product.'))}
            ${step(T('in.wa_s2', 'Verify the business'), T('in.wa_s2_d', 'In Meta Business settings, Security centre, verify MediCore with the CAC certificate and a utility bill. Until then WhatsApp limits how many people you can message and hides the business name.'))}
            ${step(T('in.wa_s3', 'Add the phone numbers'), T('in.wa_s3_d', 'Add the platform number and every provider department number that should have an inbox. A number used on WhatsApp Business on a phone must be deleted from that app first. Copy each number\'s phone number ID; the WhatsApp numbers tab lists the department numbers still to add.'))}
            ${step(T('in.wa_s4', 'Create the two message templates'), T('in.wa_s4_d', 'In WhatsApp Manager, Message templates, create these and wait for approval:'), html`
              <div class="sm" style="margin-top:8px"><b>${T('in.wa_s4_up', 'Update template: category Utility, two variables')}</b><pre style="${preStyle}">${WA_UPDATE_BODY}</pre></div>
              <div class="sm" style="margin-top:8px"><b>${T('in.wa_s4_code', 'Sign-in code template: category Authentication, with a copy code button')}</b><pre style="${preStyle}">${WA_CODE_BODY}</pre><span class="muted">${T('in.wa_s4_code_h', 'Meta writes the authentication text itself; you choose the name and language.')}</span></div>`)}
            ${step(T('in.wa_s5', 'Paste the token and IDs'), T('in.wa_s5_d', 'Create a system user in Business settings, give it the app and the WhatsApp account, and generate a permanent token. Paste it below with the app secret, the phone number ID, the WhatsApp Business account ID and the two template names. Make up a verify token.'))}
            ${step(T('in.wa_s6', 'Set the webhook'), T('in.wa_s6_d', 'In the Meta app, WhatsApp, Configuration, paste the webhook address above as the callback URL with the same verify token, then subscribe to the messages field.'))}
            ${step(T('in.wa_s7', 'Switch it on and test'), T('in.wa_s7_d', 'Switch on WhatsApp in Features, then test the connection below and send yourself a test message.'))}
          </ol></details></section>
      <form class="panel" data-form="in-save" data-k="whatsapp" novalidate><h2>${T('in.wa_settings', 'WhatsApp settings')}</h2>
        <div class="fields two">${SPECS.whatsapp.map(f => renderField(f, s, owner))}</div>
        <div class="form-err notice bad" hidden></div>${owner ? html`<div class="btn-row"><button class="btn primary" type="submit">${T('in.wa_save', 'Save WhatsApp settings')}</button></div>` : ''}</form>
      ${owner ? html`<form class="panel" data-form="in-wa-test" novalidate><h2>${T('in.wa_test', 'Test the WhatsApp connection')}</h2>
        <p class="muted sm">${T('in.wa_test_d', 'Checks the saved token and phone number ID with Meta. Add a number to also send the update template to it; the template must be approved and that phone must have WhatsApp.')}</p>
        <div class="row wrap" style="align-items:flex-end"><div class="field" style="flex:1;min-width:200px;margin:0"><label for="in-wa-to">${T('in.wa_to', 'Send a test message to (optional)')}</label><input class="input" id="in-wa-to" name="to" type="tel" inputmode="tel" autocomplete="off" maxlength="20" placeholder="0803 123 4567"></div><button class="btn" type="submit">${icon('refresh')}${T('in.wa_test_btn', 'Test WhatsApp connection')}</button></div>
        <p class="muted sm" style="margin-top:8px">${T('in.test_hint', 'The test uses the saved settings, so save first.')}</p>
        <div class="form-err notice bad" hidden style="margin-top:12px"></div><div id="to-whatsapp" aria-live="polite"></div></form>` : ''}`;
  }
  function numbersBody(nd, query) {
    const pf = nd.platform || {}; const all = nd.numbers || []; const deps = nd.departments || {};
    const q = String(query.q || '').toLowerCase().trim(); const kind = query.kind || ''; const need = query.need || '';
    const missing = all.filter(n => !n.waPhoneNumberId);
    const rows = all.filter(n => (!kind || n.kind === kind) && (!need || (need === 'missing' ? !n.waPhoneNumberId : !!n.waPhoneNumberId))
      && (!q || [n.name, n.deptLabel || deps[n.dept] || n.dept, n.whatsapp, n.waPhoneNumberId].some(x => String(x || '').toLowerCase().includes(q))))
      .sort((a, b) => (!!a.waPhoneNumberId - !!b.waPhoneNumberId) || String(a.name).localeCompare(String(b.name)));
    const copyText = missing.filter(n => n.whatsapp).map(n => n.whatsapp + ' | ' + n.name + ' | ' + (n.deptLabel || deps[n.dept] || n.dept)).join('\n');
    const kindLabel = k => (k === 'group' ? T('wn.k_group', 'Group head office') : T('wn.k_provider', 'Provider'));
    return html`<section class="panel"><div class="row between wrap"><h2 style="margin:0">${T('wn.platform', 'Platform number')}</h2>${pf.configured ? badge(T('wn.connected', 'Keys saved'), 'ok') : badge(T('wn.not_connected', 'Not connected'), 'warn')}</div>
        <dl class="kv sm" style="margin-top:12px"><dt>${T('wn.pf_id', 'Phone number ID')}</dt><dd>${pf.phoneNumberId || html`<span class="muted">${T('in.not_set', 'Not set')}</span>`}</dd><dt>${T('wn.pf_hook', 'Webhook address')}</dt><dd><code>${location.origin + (pf.webhookPath || '/api/whatsapp/webhook')}</code></dd></dl>
        <div class="btn-row"><a class="btn sm" href="#/config/integrations?tab=whatsapp">${T('wn.open_settings', 'Open WhatsApp settings')}</a></div></section>
      ${MC.figures([{ value: all.length, label: T('wn.f_total', 'Department WhatsApp numbers') }, { value: all.length - missing.length, label: T('wn.f_linked', 'With a phone number ID') }, { value: missing.length, label: T('wn.f_missing', 'To add to the business account'), tone: missing.length ? 'warn' : '' }])}
      <p class="muted sm">${T('wn.explain', 'Providers and hospital groups save their department numbers under Contacts in their admin app. A number with a phone number ID is on MediCore\'s WhatsApp Business account, so its chats land in that department\'s inbox. A number without one only gives patients a click-to-chat button: add it to the business account in Meta, then put its phone number ID on that department.')}</p>
      <form data-form="wn-filter" class="row wrap" style="margin-bottom:12px;align-items:flex-end" novalidate>
        <div class="search" style="flex:1;min-width:200px">${icon('search')}<label class="sr-only" for="wn-q">${T('wn.search', 'Search numbers')}</label><input class="input" id="wn-q" name="q" value="${query.q || ''}" placeholder="${T('wn.search_ph', 'Provider, department or number')}"></div>
        <label class="sr-only" for="wn-kind">${T('wn.kind', 'Owner')}</label><select class="input" id="wn-kind" name="kind" style="width:auto;max-width:100%">${opt('', T('wn.all_kinds', 'Providers and groups'), !kind)}${opt('provider', T('wn.k_providers', 'Providers only'), kind === 'provider')}${opt('group', T('wn.k_groups', 'Group head offices only'), kind === 'group')}</select>
        <label class="sr-only" for="wn-need">${T('wn.need', 'Status')}</label><select class="input" id="wn-need" name="need" style="width:auto;max-width:100%">${opt('', T('wn.all', 'All numbers'), !need)}${opt('missing', T('wn.only_missing', 'To add'), need === 'missing')}${opt('linked', T('wn.only_linked', 'With a phone number ID'), need === 'linked')}</select>
        <button class="btn" type="submit">${T('wn.filter', 'Show numbers')}</button></form>
      ${copyText ? html`<div class="btn-row" style="margin:0 0 12px"><button type="button" class="btn sm" data-action="wn-copy" data-v="${copyText}">${T('wn.copy', 'Copy the numbers to add')}</button></div>` : ''}
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('wn.c_owner', 'Provider')}</th><th>${T('wn.c_dept', 'Department')}</th><th>${T('wn.c_number', 'WhatsApp number')}</th><th>${T('wn.c_id', 'Phone number ID')}</th></tr></thead><tbody>
        ${rows.map(n => html`<tr><td data-label="${T('wn.c_owner', 'Provider')}"><a href="${n.kind === 'group' ? '#/groups/' : '#/providers/'}${n.id}"><b>${n.name}</b></a><br><span class="xs muted">${kindLabel(n.kind)}</span></td>
          <td data-label="${T('wn.c_dept', 'Department')}">${n.deptLabel || deps[n.dept] || n.dept}</td>
          <td data-label="${T('wn.c_number', 'WhatsApp number')}">${n.whatsapp ? html`<span style="white-space:nowrap">${n.whatsapp}</span>` : html`<span class="muted">-</span>`}</td>
          <td data-label="${T('wn.c_id', 'Phone number ID')}">${n.waPhoneNumberId ? html`<code style="overflow-wrap:anywhere">${n.waPhoneNumberId}</code><br>${badge(T('wn.in_inbox', 'Chats go to the inbox'), 'ok')}` : badge(T('wn.to_add', 'Add to the business account'), 'warn')}</td></tr>`)}
      </tbody></table></div>` : empty({ icon: 'phone', title: all.length ? T('wn.empty_f', 'No numbers match') : T('wn.empty', 'No department WhatsApp numbers yet'), body: all.length ? T('wn.empty_f_sub', 'Clear the search or choose all numbers.') : T('wn.empty_sub', 'Numbers appear here when providers or groups add a WhatsApp number to a department under Contacts.') })}`;
  }
  function emailBody(s, es, owner) {
    return html`<form class="panel" data-form="in-save" data-k="email" novalidate id="in-p-email"><div class="row between wrap"><h2 style="margin:0">${T('in.em_title', 'Email')}</h2>${statusBadgeFor(es)}</div>
        <p class="muted sm" style="margin:8px 0 0">${T('in.em_sub', 'Used to email HMOs that are not on MediCore: pre-authorisation requests and claim files go from the front desk to the HMO\'s pre-authorisation or claims address. Without email, staff can still send them by WhatsApp or download the claim file.')}</p>
        ${needsLine(es)}
        <div class="fields two" style="margin-top:12px">${SPECS.email.map(f => renderField(f, s, owner))}</div>
        <div class="form-err notice bad" hidden></div>${owner ? html`<div class="btn-row"><button class="btn primary" type="submit">${T('in.em_save', 'Save email settings')}</button></div>` : ''}</form>
      ${owner ? html`<form class="panel" data-form="in-email-test" novalidate><h2>${T('in.em_test', 'Send a test email')}</h2><p class="muted sm">${T('in.em_test_d', 'Sends one real email through the saved gateway.')}</p>
        <div class="row wrap" style="align-items:flex-end"><div class="field" style="flex:1;min-width:200px;margin:0"><label for="in-em-to">${T('in.em_to', 'Email address')}</label><input class="input" id="in-em-to" name="to" type="email" inputmode="email" autocomplete="off" maxlength="200" required></div><button class="btn" type="submit">${icon('message')}${T('in.em_send', 'Send test email')}</button></div>
        <p class="muted sm" style="margin-top:8px">${T('in.test_hint', 'The test uses the saved settings, so save first.')}</p>
        <div class="form-err notice bad" hidden style="margin-top:12px"></div><div id="to-email" aria-live="polite"></div></form>` : ''}`;
  }

  async function integrations({ query }) {
    buildLists();
    const [, status] = await Promise.all([load(), api.get('/api/hq/integrations/status').catch(() => null)]);
    const s = state.settings.integrations; const owner = can('platform.integrations');
    const tab = KEY_TAB[query.tab] ? KEY_TAB[query.tab] : (ITABS.some(x => x[0] === query.tab) ? query.tab : 'payments');
    const st = k => (status ? status.integrations.find(x => x.key === k) : null);
    const subTabs = html`<nav class="tabs" aria-label="${T('in.sections', 'Integration groups')}">${ITABS.map(([k, l]) => html`<a href="#/config/integrations?tab=${k}" ${k === tab ? MC.raw('aria-current="page"') : ''}>${l}</a>`)}</nav>`;
    let body;
    if (tab === 'payments') {
      const cur = s.payments.provider || 'paystack'; const ps = st('payments');
      body = html`<form class="panel" data-form="in-save" data-k="payActive" novalidate id="in-p-payments"><div class="row between wrap"><h2 style="margin:0">${T('in.pay_active', 'Online payments')}</h2>${statusBadgeFor(ps)}</div>
          ${ps && !ps.ready && ps.needs ? html`<p class="muted sm" style="margin:8px 0 0">${T('gl.needs', 'Needs: {what}', { what: ps.needs })}</p>` : ''}
          <div class="fields two" style="margin-top:12px">${SPECS.payActive.map(f => renderField(f, s, owner))}</div>
          <div class="form-err notice bad" hidden></div>${owner ? html`<div class="btn-row"><button class="btn primary" type="submit">${T('in.save_pay_active', 'Save payment gateway choice')}</button></div>` : ''}</form>
        <p class="muted sm">${T('in.pay_panels', 'Keys for each gateway. Only the active gateway takes payments; you can prepare another before switching.')}</p>
        ${PAY_GW.map(([k, title, spec, test]) => gwPanel({ key: k, title, spec, test, hook: k, active: cur === k, open: query.panel ? query.panel === k : cur === k, owner, src: s }))}`;
    } else if (tab === 'sms') {
      const cur = s.sms.provider || 'termii'; const ss = st('sms');
      body = html`<form class="panel" data-form="in-save" data-k="smsActive" novalidate id="in-p-sms"><div class="row between wrap"><h2 style="margin:0">${T('in.sms_active', 'SMS')}</h2>${statusBadgeFor(ss)}</div>
          ${ss && !ss.ready && ss.needs ? html`<p class="muted sm" style="margin:8px 0 0">${T('gl.needs', 'Needs: {what}', { what: ss.needs })}</p>` : ''}
          <div class="fields two" style="margin-top:12px">${SPECS.smsActive.map(f => renderField(f, s, owner))}</div>
          <div class="form-err notice bad" hidden></div>${owner ? html`<div class="btn-row"><button class="btn primary" type="submit">${T('in.save_sms_active', 'Save SMS gateway choice')}</button></div>` : ''}</form>
        ${owner ? html`<form class="panel" data-form="in-sms-test" novalidate><h2>${T('in.sms_test', 'Send a test SMS')}</h2><p class="muted sm">${T('in.sms_test_d', 'Sends one real message through the active gateway using the saved settings.')}</p>
          <div class="row wrap" style="align-items:flex-end"><div class="field" style="flex:1;min-width:200px;margin:0"><label for="in-sms-to">${T('in.sms_to', 'Phone number')}</label><input class="input" id="in-sms-to" name="to" type="tel" inputmode="tel" autocomplete="off" placeholder="0803 123 4567" required></div><button class="btn" type="submit">${icon('message')}${T('in.sms_send', 'Send test SMS')}</button></div>
          <div class="form-err notice bad" hidden style="margin-top:12px"></div><div id="to-sms" aria-live="polite" style="margin-top:12px"></div></form>` : ''}
        ${SMS_GW.map(([k, title, spec, test]) => gwPanel({ key: k, title, spec, test, hook: null, active: cur === k, open: query.panel ? query.panel === k : cur === k, owner, src: s }))}`;
    } else if (tab === 'whatsapp') {
      body = whatsappBody(s, st('whatsapp'), owner);
    } else if (tab === 'wanumbers') {
      const nd = await api.get('/api/hq/whatsapp/numbers');
      body = numbersBody(nd, query);
    } else if (tab === 'email') {
      body = emailBody(s, st('email'), owner);
    } else {
      body = html`${OTHER.map(([k, title, test, desc]) => gwPanel({ key: k, title, spec: k, test, hook: null, active: false, open: query.panel === k, owner, src: s, extra: desc ? html`<p class="muted sm">${desc}</p>` : '', statusLine: statusBadgeFor(st(k)) }))}`;
    }
    view(html`${head(T('in.title', 'Integrations'), T('in.sub', 'Accounts and keys for payments, SMS, WhatsApp, email, maps, video, USSD and AI. Nothing is hard coded: change a gateway here and it applies within a minute. Secrets are stored encrypted and never shown again.'))}${tabs('integrations')}
      ${!owner ? html`<div class="notice warn">${T('in.owner_only', 'Only a platform owner can change integration keys and run connection tests. You can see what is set up.')}</div>` : ''}${!state.environment.settingsKeySet ? html`<div class="notice warn">${T('in.key_warn', 'Set SETTINGS_KEY in Netlify environment variables so saved secrets stay readable if JWT_SECRET ever changes.')}</div>` : ''}
      ${subTabs}${body}`);
    applyAllWhen();
    if (query.panel) { const el = document.getElementById('in-p-' + query.panel); if (el) { if (el.tagName === 'DETAILS') el.open = true; setTimeout(() => el.scrollIntoView({ block: 'start' }), 30); } }
    form('in-save', async (d, f) => {
      const k = f.dataset.k; const patch = collect(d, SPECS[k]); checkTemplates(patch);
      if (k === 'payActive' && patch.payments.provider === 'none' && s.payments.provider !== 'none' && !(await confirm({ title: T('in.pay_off_q', 'Turn off online payments?'), body: T('in.pay_off_b', 'Patients will only be able to pay with cash or POS at the counter until you choose a gateway again.'), ok: T('in.pay_off_ok', 'Turn off online payments'), danger: true }))) return;
      if (k === 'smsActive' && patch.sms.provider === 'none' && s.sms.provider !== 'none' && !(await confirm({ title: T('in.sms_off_q', 'Turn off SMS?'), body: T('in.sms_off_b', 'Sign-in codes, password resets and alerts will not be sent by SMS.'), ok: T('in.sms_off_ok', 'Turn off SMS'), danger: true }))) return;
      if (k === 'whatsapp') checkWhatsapp(patch);
      if (k === 'email') {
        if (patch.email.from && !EMAIL_RE.test(patch.email.from)) throw new MC.ApiError(400, { error: T('in.em_bad_from', 'The from address is not a valid email address.') });
        if (patch.email.provider === 'mailgun' && !patch.email.mailgunDomain) throw new MC.ApiError(400, { error: T('in.em_need_domain', 'Mailgun needs the sending domain.') });
        if (!patch.email.provider && s.email.provider && !(await confirm({ title: T('in.em_off_q', 'Turn off email?'), body: T('in.em_off_b', 'Pre-authorisation requests and claim files will not be emailed to HMOs. Staff can still send them by WhatsApp or download them.'), ok: T('in.em_off_ok', 'Turn off email'), danger: true }))) return;
      }
      const name = (PAY_GW.concat(SMS_GW).find(x => x[2] === k) || [])[1] || ((OTHER.find(x => x[0] === k) || [])[1]);
      const r = await save('integrations', patch, null, v => (SAVED_MSG[k] ? T('in.saved_' + k, SAVED_MSG[k], { v }) : T('in.saved_gw', '{name} settings saved as version {v}', { name, v })));
      if (r) MC.render();
    });
    form('in-sms-test', async d => {
      const box = document.getElementById('to-sms');
      if (!/^(\+?234|0)[789][01]\d{8}$/.test(String(d.to || '').replace(/[\s\-().]/g, ''))) throw new MC.ApiError(400, { error: T('in.sms_bad_phone', 'Enter a Nigerian mobile number, for example 0803 123 4567.') });
      try { const r = await api.post('/api/hq/config/test/sms', { to: d.to }); showTest(box, r); toast(r.ok ? T('in.sms_sent', 'Test SMS sent') : T('in.sms_not_sent', 'Test SMS not sent'), r.ok ? 'ok' : 'bad'); }
      catch (e) { if (e.details) throw e; showTest(box, { ok: false, message: e.status === 403 ? T('in.test_403', 'Only a platform owner can run connection tests.') : e.message }); toast(T('in.sms_not_sent', 'Test SMS not sent'), 'bad'); }
    });
    form('in-wa-test', async d => {
      const box = document.getElementById('to-whatsapp'); const to = String(d.to || '').replace(/[\s\-().]/g, '');
      if (to && !PHONE_RE.test(to)) throw new MC.ApiError(400, { error: T('in.wa_bad_phone', 'Enter a WhatsApp number, for example 0803 123 4567 or +44 7700 900123.') });
      const missing = [['whatsapp.accessToken', T('in.f.wa_token', 'Access token')], ['whatsapp.phoneNumberId', T('in.f.wa_id', 'Phone number ID (platform number)')]].filter(([pth]) => !isSaved(getP(s, pth)));
      if (to && !(s.whatsapp.templates || {}).update) missing.push(['', T('in.f.wa_tpl_up', 'Update template name')]);
      if (missing.length) { showTest(box, { ok: false, message: T('in.test_missing', 'Save these first: {fields}.', { fields: missing.map(x => String(x[1])).join(', ') }) }); toast(to ? T('in.wa_not_sent', 'Test WhatsApp message not sent') : T('in.tested_bad', 'Connection tested: it failed'), 'bad'); return; }
      let r;
      try { r = await api.post('/api/hq/config/test/whatsapp', to ? { to } : {}); }
      catch (e) { if (e.details) throw e; r = { ok: false, message: e.status === 403 ? T('in.test_403', 'Only a platform owner can run connection tests.') : e.message }; }
      showTest(box, r);
      toast(to ? (r.ok ? T('in.wa_sent', 'Test WhatsApp message sent') : T('in.wa_not_sent', 'Test WhatsApp message not sent')) : (r.ok ? T('in.tested_ok', 'Connection tested: it works') : T('in.tested_bad', 'Connection tested: it failed')), r.ok ? 'ok' : 'bad');
    });
    form('in-email-test', async d => {
      const box = document.getElementById('to-email'); const to = String(d.to || '').trim();
      if (!EMAIL_RE.test(to)) throw new MC.ApiError(400, { error: T('in.em_bad_to', 'Enter the email address to send the test to.') });
      let r;
      try { r = await api.post('/api/hq/config/test/email', { to }); }
      catch (e) { if (e.details) throw e; r = { ok: false, message: e.status === 403 ? T('in.test_403', 'Only a platform owner can run connection tests.') : e.message }; }
      showTest(box, r); toast(r.ok ? T('in.em_sent', 'Test email sent') : T('in.em_not_sent', 'Test email not sent'), r.ok ? 'ok' : 'bad');
    });
    form('wn-filter', d => MC.go('#/config/integrations' + MC.qs({ tab: 'wanumbers', q: d.q, kind: d.kind, need: d.need })));
  }
  function showTest(box, r) {
    if (!box) return;
    MC.view(html`<div class="notice ${r.ok ? 'ok' : 'bad'}" role="status" style="margin:8px 0 0"><b>${r.ok ? T('in.test_ok', 'It works.') : T('in.test_failed', 'It did not work.')}</b> ${r.message || ''}${r.status ? html` <span class="muted">(HTTP ${r.status})</span>` : ''}${!r.ok ? html`<br><span class="sm">${T('in.test_fail_hint', 'Check the keys and addresses, save, and test again. If the service is down or blocked from this server, the test also fails.')}</span>` : ''}</div>`, box);
  }
  // what a test needs saved first (the server answers 400 otherwise)
  const TEST_NEEDS = { paystack: ['paystack.secretKey'], flutterwave: ['flutterwave.secretKey'], monnify: ['monnify.apiKey', 'monnify.secretKey'], customPayment: ['customPayment.baseUrl'], termii: ['termii.apiKey'], africastalking: ['africastalking.username', 'africastalking.apiKey'] };
  const isSaved = v => (v && typeof v === 'object' ? !!v.set : !!v);
  on('in-test', async el => {
    const k = el.dataset.k; const box = document.getElementById('to-' + k);
    const missing = (TEST_NEEDS[k] || []).filter(pth => !isSaved(getP(state.settings.integrations, pth)));
    if (missing.length) { showTest(box, { ok: false, message: T('in.test_missing', 'Save these first: {fields}.', { fields: missing.map(pth => { const f = (SPECS[k] || []).find(x => x.p === pth); return f ? String(f.l) : pth; }).join(', ') }) }); return; }
    let r;
    try { r = await api.post('/api/hq/config/test/' + k); }
    catch (e) { r = { ok: false, message: e.status === 403 ? T('in.test_403', 'Only a platform owner can run connection tests.') : e.message }; }
    showTest(box, r); toast(r.ok ? T('in.tested_ok', 'Connection tested: it works') : T('in.tested_bad', 'Connection tested: it failed'), r.ok ? 'ok' : 'bad');
  });
  on('in-copy', async el => {
    const v = el.dataset.v; let ok = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(v); ok = true; } } catch (e) { ok = false; }
    if (!ok) { const inp = el.parentElement && el.parentElement.querySelector('input'); if (inp) { inp.focus(); inp.select(); try { ok = document.execCommand('copy'); } catch (e) { ok = false; } } }
    toast(ok ? T('in.copied', 'Webhook address copied') : T('in.copy_manual', 'Select the address and copy it yourself'), ok ? 'ok' : '');
  });
  on('wn-copy', async el => {
    let ok = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(el.dataset.v); ok = true; } } catch (e) { ok = false; }
    if (!ok) { await dialog({ title: T('wn.copy_t', 'Numbers to add'), body: html`<p class="sm">${T('wn.copy_manual', 'Select the list and copy it yourself.')}</p><pre style="${preStyle}">${el.dataset.v}</pre>`, actions: [{ label: T('common.done', 'Done'), primary: true, value: null }] }); return; }
    toast(T('wn.copied', 'Numbers to add copied'), 'ok');
  });

  const PROVIDER_NAMES = { termii: 'Termii', africastalking: 'Africa\'s Talking', custom: 'Custom HTTP API', none: 'Off', anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', openai_compatible: 'OpenAI-compatible', sendgrid: 'SendGrid', brevo: 'Brevo', mailgun: 'Mailgun', resend: 'Resend' };
  /* ======================= go-live checklist ======================= */
  async function golive({ stale }) {
    const [s] = await Promise.all([api.get('/api/hq/integrations/status'), load()]);
    if (stale()) return;
    const integ = s.integrations || []; const comp = s.compliance || []; const partners = s.partners || [];
    const required = integ.filter(x => x.ready || x.needs);
    const ready = required.filter(x => x.ready).length;
    const compDone = comp.filter(x => x.status === 'done' || x.status === 'not_needed').length;
    const blocking = comp.filter(x => x.blocking);
    const expiring = comp.filter(x => x.expiresOn && daysUntil(x.expiresOn) <= 30);
    const live = partners.filter(p => p.status === 'live' || p.status === 'signed').length;
    const byStatus = {}; partners.forEach(p => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });
    view(html`${plainHead(T('gl.title', 'Go-live checklist'), T('gl.sub', 'What still needs an account, a partnership or a licence before MediCore runs live. Everything here is set in HQ; nothing is hard coded.'), html`<a class="btn" href="#/compliance">${icon('clipboard')}${T('gl.to_compliance', 'Compliance register')}</a>`)}
      ${MC.figures([
        { value: ready + ' / ' + required.length, label: T('gl.f.integ', 'Integrations ready'), tone: ready < required.length ? 'warn' : '' },
        { value: compDone + ' / ' + comp.length, label: T('gl.f.comp', 'Licences and registrations done'), tone: compDone < comp.length ? 'warn' : '' },
        { value: blocking.length, label: T('gl.f.blocking', 'Items switching features off'), tone: blocking.length ? 'bad' : '' },
        { value: live, label: T('gl.f.partners', 'Partners signed or live') },
      ])}
      ${blocking.length ? html`<div class="notice bad"><b>${T('gl.blocking_t', 'Features switched off by the compliance register:')}</b> ${blocking.map(b => T('gl.blocking_one', '{features} (until {item} is done)', { features: b.blocksFeatures.map(featureLabel).join(', '), item: b.label })).join('; ')}</div>` : ''}
      <section class="panel flush"><h2>${T('gl.integrations', 'Integrations')}</h2><ul class="list">${integ.map(x => html`<li><div class="grow"><span class="title">${x.label}${x.providerLabel || x.provider ? html` <span class="muted sm">(${x.providerLabel || PROVIDER_NAMES[x.provider] || cap(x.provider)})</span>` : ''}</span><span class="sub">${x.ready ? T('gl.ready_sub', 'Set up and ready.') : x.needs ? T('gl.needs', 'Needs: {what}', { what: x.needs }) : T('gl.optional_sub', 'Optional. Set up when a bank, ERP or HMO system needs MediCore events.')}</span></div><span class="end"><span class="row wrap" style="justify-content:flex-end;gap:8px">${statusBadgeFor(x)}<a class="btn sm" href="${settingsHref(x.key)}">${x.ready ? T('gl.open', 'Open settings') : T('gl.set_up', 'Set it up')}</a></span></span></li>`)}</ul></section>
      <section class="panel flush"><h2>${T('gl.compliance', 'Licences and registrations')}</h2><ul class="list">${comp.map(x => html`<li><div class="grow"><span class="title">${x.label}</span><span class="sub">${x.enforce ? (x.blocksFeatures.length ? T('gl.enforced', 'Enforced: switches off {f} until done', { f: x.blocksFeatures.map(featureLabel).join(', ') }) : T('gl.enforced_none', 'Enforced, but blocks no features')) : x.blocksFeatures.length ? T('gl.not_enforced', 'Not enforced. When enforced it switches off {f} until done.', { f: x.blocksFeatures.map(featureLabel).join(', ') }) : T('gl.no_block', 'Tracked only')}</span>${x.expiresOn ? html`<span class="sub" style="margin-top:4px">${expiryFlag(x.expiresOn)}</span>` : ''}</div><span class="end"><span class="row wrap" style="justify-content:flex-end;gap:8px">${x.blocking ? badge(T('gl.blocking', 'Blocking'), 'bad') : ''}${cmBadge(x.status)}<a class="btn sm" href="#/compliance?item=${x.key}">${T('gl.update', 'Update')}</a></span></span></li>`)}</ul></section>
      ${expiring.length ? html`<div class="notice warn">${T('gl.expiring', '{n} licences expire within 30 days or have expired. Renew them before they lapse.', { n: expiring.length })}</div>` : ''}
      <section class="panel"><div class="row between wrap"><h2 style="margin:0">${T('gl.partners', 'Partners and agreements')}</h2><a class="btn sm" href="#/compliance/partners">${T('gl.partners_open', 'Open partners')}</a></div>
        ${partners.length ? html`<div class="row wrap" style="margin:12px 0">${Object.entries(byStatus).map(([k, n]) => html`<span>${ptBadge(k)} <b>${n}</b></span>`)}</div>
          <ul class="list">${partners.map(p => html`<li><div class="grow"><span class="title">${p.name}</span><span class="sub">${p.kind ? T('pt.kind.' + p.kind, PT_KINDS[p.kind] || cap(p.kind)) : ''}${p.endsOn ? html` | ${T('gl.ends', 'Ends')} ${expiryFlag(p.endsOn)}` : ''}</span></div><span class="end">${ptBadge(p.status)}</span></li>`)}</ul>`
        : html`<p class="muted" style="margin:12px 0 0">${T('gl.no_partners', 'No partners recorded yet. Add HMOs, banks, payment and SMS providers, telecoms and regulators you work with.')}</p>`}</section>`);
  }

  /* ======================= compliance and partners ======================= */
  const CM_STATUSES = ['not_started', 'in_progress', 'submitted', 'done', 'expired', 'not_needed'];
  const CM_LABELS = { not_started: 'Not started', in_progress: 'In progress', submitted: 'Submitted', done: 'Done', expired: 'Expired', not_needed: 'Not needed' };
  const cmLabel = s => MC.t('status.' + s, CM_LABELS[s] || cap(s));
  const cmBadge = s => badge(cmLabel(s), { not_started: 'warn', in_progress: 'info', submitted: 'info', done: 'ok', expired: 'bad', not_needed: 'outline' }[s] || 'outline');
  const PT_STATUSES = ['prospect', 'negotiating', 'signed', 'live', 'paused', 'ended'];
  const PT_LABELS = { prospect: 'Prospect', negotiating: 'Negotiating', signed: 'Signed', live: 'Live', paused: 'Paused', ended: 'Ended' };
  const ptBadge = s => badge(MC.t('status.' + s, PT_LABELS[s] || cap(s)), { prospect: 'outline', negotiating: 'info', signed: 'ok', live: 'ok', paused: 'warn', ended: 'outline' }[s] || 'outline');
  const PT_KINDS = { hmo: 'HMO', bank: 'Bank', payment: 'Payment gateway', sms: 'SMS provider', telecom: 'Telecom or USSD aggregator', regulator: 'Regulator', insurer: 'Insurer', other: 'Other' };
  const cmTabs = cur => html`<nav class="tabs" aria-label="${T('cm.sections', 'Compliance sections')}">${[['#/compliance', T('cm.t.items', 'Licences and registrations')], ['#/compliance/partners', T('cm.t.partners', 'Partners and agreements')]].map(([h, l]) => html`<a href="${h}" ${h === cur ? MC.raw('aria-current="page"') : ''}>${l}</a>`)}</nav>`;
  const cmHead = () => plainHead(T('cm.title', 'Compliance and partnerships'), T('cm.sub', 'Licences, registrations and agreements MediCore needs, with who owns each one and when it expires.'), html`<a class="btn" href="#/golive">${icon('check')}${T('cm.to_golive', 'Go-live checklist')}</a>`);
  const slug = (s, max) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max);
  function uniqueKey(base, taken, re) { let k = base; let i = 2; while (taken[k] !== undefined && taken[k] !== null || !re.test(k)) { k = base.slice(0, 24) + '_' + i; i++; if (i > 999) break; } return k; }
  const cmMsg = v => T('cm.saved', 'Compliance register saved as version {v}', { v });

  function itemBody(it, isNew, boolFeatures) {
    const bl = it.blocksFeatures || [];
    return html`${field2('cm-l', T('cm.f.label', 'Name'), html`<input class="input" id="cm-l" name="label" required maxlength="200" value="${it.label || ''}">`)}
      <div class="fields two">${field2('cm-s', T('cm.f.status', 'Status'), html`<select class="input" id="cm-s" name="status">${CM_STATUSES.map(s => opt(s, cmLabel(s), (it.status || 'not_started') === s))}</select>`)}
      ${field2('cm-r', T('cm.f.ref', 'Reference or certificate number'), html`<input class="input" id="cm-r" name="reference" maxlength="200" value="${it.reference || ''}">`)}
      ${field2('cm-i', T('cm.f.issued', 'Issued on'), html`<input class="input" id="cm-i" name="issuedOn" type="date" value="${it.issuedOn || ''}">`)}
      ${field2('cm-e', T('cm.f.expires', 'Expires on'), html`<input class="input" id="cm-e" name="expiresOn" type="date" value="${it.expiresOn || ''}">`, T('cm.f.expires_h', 'Shown as expiring 30 days before.'))}
      ${field2('cm-d', T('cm.f.doc', 'Document link (https)'), html`<input class="input" id="cm-d" name="docUrl" type="url" inputmode="url" maxlength="1000" placeholder="https://" value="${it.docUrl || ''}">`)}
      ${field2('cm-o', T('cm.f.owner', 'Owner (who is responsible)'), html`<input class="input" id="cm-o" name="owner" maxlength="200" value="${it.owner || ''}">`)}</div>
      ${field2('cm-n', T('cm.f.notes', 'Notes'), html`<textarea class="input" id="cm-n" name="notes" rows="3" maxlength="1000">${it.notes || ''}</textarea>`)}
      <section class="panel" style="margin:0"><label class="check"><input type="checkbox" name="enforce" ${it.enforce ? 'checked' : ''}><span><b>${T('cm.f.enforce', 'Enforce: switch features off until this is done')}</b></span></label>
        <div class="notice warn" style="margin:8px 0">${T('cm.f.enforce_warn', 'When enforce is on and the status is anything other than Done, the features ticked below are switched off for every provider and patient, everywhere on MediCore, straight away.')}</div>
        <span class="label" style="font-weight:700">${T('cm.f.blocks', 'Features it switches off')}</span>
        <div class="fields two">${boolFeatures.map(k => html`<label class="check"><input type="checkbox" name="blocksFeatures" data-list value="${k}" ${bl.includes(k) ? 'checked' : ''}><span>${featureLabel(k)}</span></label>`)}</div></section>
`;
  }
  const field2 = (id, label, input, hint) => html`<div class="field"><label for="${id}">${label}</label>${input}${hint ? html`<div class="hint">${hint}</div>` : ''}</div>`;
  const itemFrom = d => ({ label: (d.label || '').trim(), status: d.status, reference: d.reference || '', issuedOn: d.issuedOn || '', expiresOn: d.expiresOn || '', docUrl: (d.docUrl || '').trim(), owner: d.owner || '', notes: d.notes || '', enforce: !!d.enforce, blocksFeatures: d.blocksFeatures || [] });
  function checkItem(it) {
    if (!it.label) throw new MC.ApiError(400, { error: T('cm.err_label', 'Give the item a name.') });
    if (it.docUrl && !/^https:\/\//.test(it.docUrl)) throw new MC.ApiError(400, { error: T('cm.err_url', 'Document links must start with https://') });
    if (it.issuedOn && it.expiresOn && it.expiresOn < it.issuedOn) throw new MC.ApiError(400, { error: T('cm.err_dates', 'The expiry date must be after the issue date.') });
  }
  async function confirmEnforce(it, before) {
    const will = it.enforce && it.status !== 'done' && it.blocksFeatures.length;
    const was = before && before.enforce && before.status !== 'done' && (before.blocksFeatures || []).length;
    const sameBlocks = was && JSON.stringify((before.blocksFeatures || []).slice().sort()) === JSON.stringify(it.blocksFeatures.slice().sort());
    if (will && !sameBlocks) return confirm({ title: T('cm.enforce_q', 'Switch these features off now?'), body: T('cm.enforce_body', '{features} will be switched off for every provider and patient until "{item}" is marked Done. Screens that use them disappear within a minute.', { features: it.blocksFeatures.map(featureLabel).join(', '), item: it.label }), ok: T('cm.enforce_ok', 'Save and switch off'), danger: true });
    if (was && !will) return confirm({ title: T('cm.unblock_q', 'Switch these features back on?'), body: T('cm.unblock_body', '{features} will follow the normal feature switches again.', { features: (before.blocksFeatures || []).map(featureLabel).join(', ') }), ok: T('cm.unblock_ok', 'Save and switch back on') });
    return true;
  }

  async function compliancePage({ query, stale }) {
    await load(); if (stale()) return;
    const items = (state.settings.compliance && state.settings.compliance.items) || {};
    const builtIn = Object.keys(((state.defaults || {}).compliance || {}).items || {});
    const edit = can('platform.config');
    const boolFeatures = Object.keys(state.settings.features).filter(k => typeof state.settings.features[k] === 'boolean');
    const rows = Object.entries(items).filter(([, v]) => v);
    const blocked = featureBlockers();
    view(html`${cmHead()}${cmTabs('#/compliance')}
      ${!edit ? html`<div class="notice warn">${T('cm.read_only', 'You can view the register but not change it.')}</div>` : ''}
      ${Object.keys(blocked).length ? html`<div class="notice bad"><b>${T('cm.blocked_now', 'Switched off right now:')}</b> ${Object.entries(blocked).map(([f, by]) => T('cm.blocked_one', '{feature} (by {items})', { feature: featureLabel(f), items: by.join(', ') })).join('; ')}</div>` : ''}
      <div class="row between wrap" style="margin-bottom:12px"><p class="muted sm" style="margin:0">${T('cm.items_sub', 'An enforced item that is not Done switches off the features it lists, so a capability cannot go live before its licence is in place.')}</p>${edit ? html`<button class="btn primary" data-action="cm-add">${icon('plus')}${T('cm.add', 'Add an item')}</button>` : ''}</div>
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('cm.c.item', 'Item')}</th><th>${T('cm.c.status', 'Status')}</th><th>${T('cm.c.ref', 'Reference')}</th><th>${T('cm.c.expiry', 'Expiry')}</th><th>${T('cm.c.enforce', 'Enforce')}</th><th></th></tr></thead><tbody>
        ${rows.map(([k, it]) => { const blocking = it.enforce && it.status !== 'done' && (it.blocksFeatures || []).length; return html`<tr id="cm-row-${k}" ${query.item === k ? MC.raw('style="background:var(--hue-soft)"') : ''}><td data-label="${T('cm.c.item', 'Item')}"><b>${it.label || k}</b>${builtIn.includes(k) ? '' : html` ${badge(T('cm.custom', 'Custom'), 'hue')}`}${it.owner ? html`<br><span class="xs muted">${T('cm.owner_is', 'Owner: {o}', { o: it.owner })}</span>` : ''}${it.notes ? html`<br><span class="xs muted">${it.notes}</span>` : ''}${it.docUrl && /^https:\/\//.test(it.docUrl) ? html`<br><a class="xs" href="${it.docUrl}" target="_blank" rel="noopener noreferrer">${T('cm.open_doc', 'Open document')}</a>` : ''}</td>
          <td data-label="${T('cm.c.status', 'Status')}">${cmBadge(it.status)}</td>
          <td data-label="${T('cm.c.ref', 'Reference')}">${it.reference || html`<span class="muted">-</span>`}${it.issuedOn ? html`<br><span class="xs muted">${T('cm.issued', 'Issued {d}', { d: date(Date.parse(it.issuedOn + 'T12:00:00+01:00')) })}</span>` : ''}</td>
          <td data-label="${T('cm.c.expiry', 'Expiry')}">${it.expiresOn ? expiryFlag(it.expiresOn) : html`<span class="muted">-</span>`}</td>
          <td data-label="${T('cm.c.enforce', 'Enforce')}">${it.enforce ? badge(T('cm.on', 'On'), blocking ? 'bad' : 'ok') : html`<span class="muted">${T('cm.off', 'Off')}</span>`}${(it.blocksFeatures || []).length ? html`<br><span class="xs ${blocking ? '' : 'muted'}">${blocking ? T('cm.blocking_now', 'Switching off: {f}', { f: it.blocksFeatures.map(featureLabel).join(', ') }) : T('cm.would_block', 'Blocks: {f}', { f: it.blocksFeatures.map(featureLabel).join(', ') })}</span>` : ''}</td>
          <td class="num">${edit ? html`<div class="row wrap" style="justify-content:flex-end"><button class="btn sm" data-action="cm-edit" data-k="${k}">${T('cm.edit', 'Edit')}</button>${builtIn.includes(k) ? '' : html`<button class="btn sm" data-action="cm-remove" data-k="${k}">${T('cm.remove', 'Remove')}</button>`}</div>` : ''}</td></tr>`; })}
      </tbody></table></div>` : empty({ icon: 'clipboard', title: T('cm.empty', 'No items in the register') })}`);
    if (query.item) { const r = document.getElementById('cm-row-' + query.item); if (r) setTimeout(() => r.scrollIntoView({ block: 'center' }), 30); }
    on('cm-edit', async el => {
      const k = el.dataset.k; const before = items[k]; if (!before) return;
      const v = await dialog({ title: T('cm.edit_t', 'Edit {name}', { name: before.label || k }), wide: true, form: true, body: itemBody(before, false, boolFeatures),
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('cm.save_item', 'Save item'), primary: true }],
        onSubmit: async d => { const it = itemFrom(d); checkItem(it); if (!(await confirmEnforce(it, before))) return false; return save('compliance', { items: { [k]: it } }, null, cmMsg); } });
      if (v) MC.render();
    });
    on('cm-add', async () => {
      const v = await dialog({ title: T('cm.add', 'Add an item'), wide: true, form: true, body: itemBody({ status: 'not_started', blocksFeatures: [] }, true, boolFeatures),
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('cm.add_ok', 'Add item'), primary: true }],
        onSubmit: async d => { const it = itemFrom(d); checkItem(it); let base = slug(it.label, 24).replace(/_([a-z0-9])/g, (m, c) => c.toUpperCase()); if (!/^[a-zA-Z]/.test(base)) base = 'item' + base; if (base.length < 2) base = 'item'; const key = uniqueKey(base, items, /^[a-zA-Z][a-zA-Z0-9_]{1,30}$/); if (!(await confirmEnforce(it, null))) return false; return save('compliance', { items: { [key]: it } }, null, v2 => T('cm.added', '{name} added. Saved as version {v}.', { name: it.label, v: v2 })); } });
      if (v) MC.render();
    });
    on('cm-remove', async el => {
      const k = el.dataset.k; const it = items[k]; if (!it) return;
      if (!(await confirm({ title: T('cm.remove_q', 'Remove {name}?', { name: it.label || k }), body: (it.enforce && it.status !== 'done' && (it.blocksFeatures || []).length) ? T('cm.remove_body_b', 'It is removed from the register and stops switching off {f}. Earlier versions stay in History.', { f: it.blocksFeatures.map(featureLabel).join(', ') }) : T('cm.remove_body', 'It is removed from the register. Earlier versions stay in History.'), ok: T('cm.remove_ok', 'Remove item'), danger: true }))) return;
      const r = await save('compliance', { items: { [k]: null } }, null, v => T('cm.removed', 'Item removed. Saved as version {v}.', { v })); if (r) MC.render();
    });
  }

  function partnerBody(p) {
    return html`<div class="fields two">${field2('pt-n', T('pt.f.name', 'Name'), html`<input class="input" id="pt-n" name="name" required maxlength="200" value="${p.name || ''}">`)}
      ${field2('pt-k', T('pt.f.kind', 'Kind'), html`<select class="input" id="pt-k" name="kind">${Object.keys(PT_KINDS).map(k => opt(k, T('pt.kind.' + k, PT_KINDS[k]), (p.kind || 'hmo') === k))}</select>`)}
      ${field2('pt-s', T('pt.f.status', 'Status'), html`<select class="input" id="pt-s" name="status">${PT_STATUSES.map(s => opt(s, MC.t('status.' + s, PT_LABELS[s]), (p.status || 'prospect') === s))}</select>`)}
      ${field2('pt-c', T('pt.f.contact', 'Contact person'), html`<input class="input" id="pt-c" name="contact" maxlength="200" value="${p.contact || ''}">`)}
      ${field2('pt-e', T('pt.f.email', 'Email'), html`<input class="input" id="pt-e" name="email" type="email" maxlength="200" value="${p.email || ''}">`)}
      ${field2('pt-p', T('pt.f.phone', 'Phone'), html`<input class="input" id="pt-p" name="phone" type="tel" maxlength="40" value="${p.phone || ''}">`)}
      ${field2('pt-st', T('pt.f.starts', 'Agreement starts'), html`<input class="input" id="pt-st" name="startsOn" type="date" value="${p.startsOn || ''}">`)}
      ${field2('pt-en', T('pt.f.ends', 'Agreement ends'), html`<input class="input" id="pt-en" name="endsOn" type="date" value="${p.endsOn || ''}">`, T('cm.f.expires_h', 'Shown as expiring 30 days before.'))}</div>
      ${field2('pt-t', T('pt.f.terms', 'Terms (fees, settlement, service levels)'), html`<textarea class="input" id="pt-t" name="terms" rows="3" maxlength="2000">${p.terms || ''}</textarea>`)}
      ${field2('pt-d', T('pt.f.doc', 'Agreement document link (https)'), html`<input class="input" id="pt-d" name="docUrl" type="url" inputmode="url" maxlength="1000" placeholder="https://" value="${p.docUrl || ''}">`)}
      ${field2('pt-no', T('pt.f.notes', 'Notes'), html`<textarea class="input" id="pt-no" name="notes" rows="2" maxlength="2000">${p.notes || ''}</textarea>`)}`;
  }
  const partnerFrom = d => ({ name: (d.name || '').trim(), kind: d.kind, status: d.status, contact: d.contact || '', email: d.email || '', phone: d.phone || '', startsOn: d.startsOn || '', endsOn: d.endsOn || '', terms: d.terms || '', docUrl: (d.docUrl || '').trim(), notes: d.notes || '' });
  function checkPartner(p) {
    if (!p.name) throw new MC.ApiError(400, { error: T('pt.err_name', 'Give the partner a name.') });
    if (p.docUrl && !/^https:\/\//.test(p.docUrl)) throw new MC.ApiError(400, { error: T('cm.err_url', 'Document links must start with https://') });
    if (p.startsOn && p.endsOn && p.endsOn < p.startsOn) throw new MC.ApiError(400, { error: T('pt.err_dates', 'The end date must be after the start date.') });
  }
  async function partnersPage({ query, stale }) {
    await load(); if (stale()) return;
    const all = (state.settings.compliance && state.settings.compliance.partners) || {};
    const edit = can('platform.config');
    const kind = query.kind || '';
    const rows = Object.entries(all).filter(([, p]) => p && (!kind || p.kind === kind)).sort((a, b) => String(a[1].name).localeCompare(String(b[1].name)));
    const expiring = Object.values(all).filter(p => p && p.endsOn && daysUntil(p.endsOn) <= 30 && p.status !== 'ended').length;
    view(html`${cmHead()}${cmTabs('#/compliance/partners')}
      ${!edit ? html`<div class="notice warn">${T('cm.read_only', 'You can view the register but not change it.')}</div>` : ''}
      ${expiring ? html`<div class="notice warn">${T('pt.expiring', '{n} agreements end within 30 days or have ended. Renew or mark them ended.', { n: expiring })}</div>` : ''}
      <div class="row between wrap" style="margin-bottom:12px"><div class="row wrap"><label class="sr-only" for="pt-kind">${T('pt.filter', 'Show kind')}</label><select class="input" id="pt-kind" data-pt-kind style="max-width:260px">${opt('', T('pt.all_kinds', 'All kinds'), !kind)}${Object.keys(PT_KINDS).map(k => opt(k, T('pt.kind.' + k, PT_KINDS[k]), kind === k))}</select></div>${edit ? html`<button class="btn primary" data-action="pt-add">${icon('plus')}${T('pt.add', 'Add a partner')}</button>` : ''}</div>
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('pt.c.name', 'Partner')}</th><th>${T('pt.c.status', 'Status')}</th><th>${T('pt.c.contact', 'Contact')}</th><th>${T('pt.c.dates', 'Agreement')}</th><th></th></tr></thead><tbody>
        ${rows.map(([k, p]) => html`<tr><td data-label="${T('pt.c.name', 'Partner')}"><b>${p.name}</b><br><span class="xs muted">${T('pt.kind.' + p.kind, PT_KINDS[p.kind] || cap(p.kind || 'other'))}</span>${p.terms ? html`<br><span class="xs">${p.terms}</span>` : ''}${p.docUrl && /^https:\/\//.test(p.docUrl) ? html`<br><a class="xs" href="${p.docUrl}" target="_blank" rel="noopener noreferrer">${T('pt.open_doc', 'Open agreement')}</a>` : ''}</td>
          <td data-label="${T('pt.c.status', 'Status')}">${ptBadge(p.status || 'prospect')}</td>
          <td data-label="${T('pt.c.contact', 'Contact')}">${p.contact || ''}${p.email ? html`<br><a class="xs" href="mailto:${p.email}">${p.email}</a>` : ''}${p.phone ? html`<br><span class="xs">${p.phone}</span>` : ''}${!p.contact && !p.email && !p.phone ? html`<span class="muted">-</span>` : ''}</td>
          <td data-label="${T('pt.c.dates', 'Agreement')}">${p.startsOn ? html`<span class="xs muted">${T('pt.from', 'From {d}', { d: date(Date.parse(p.startsOn + 'T12:00:00+01:00')) })}</span><br>` : ''}${p.endsOn ? (p.status === 'ended' ? html`<span class="xs muted">${T('pt.ended_on', 'Ended {d}', { d: date(Date.parse(p.endsOn + 'T12:00:00+01:00')) })}</span>` : expiryFlag(p.endsOn)) : html`<span class="muted xs">${T('pt.no_end', 'No end date')}</span>`}</td>
          <td class="num">${edit ? html`<div class="row wrap" style="justify-content:flex-end"><button class="btn sm" data-action="pt-edit" data-k="${k}">${T('pt.edit', 'Edit')}</button><button class="btn sm" data-action="pt-remove" data-k="${k}">${T('pt.remove', 'Remove')}</button></div>` : ''}</td></tr>`)}
      </tbody></table></div>` : empty({ icon: 'users', title: kind ? T('pt.empty_kind', 'No partners of this kind') : T('pt.empty', 'No partners yet'), body: T('pt.empty_sub', 'Record every HMO, bank, payment gateway, SMS provider, telecom and regulator you have an agreement with, so renewals are not missed.'), action: edit ? html`<button class="btn primary" data-action="pt-add">${icon('plus')}${T('pt.add', 'Add a partner')}</button>` : '' })}`);
    const sel = document.querySelector('[data-pt-kind]'); if (sel) sel.addEventListener('change', e => MC.go('#/compliance/partners' + MC.qs({ kind: e.target.value })));
    const msg = v => T('pt.saved', 'Partner saved as version {v}', { v });
    on('pt-add', async () => {
      const v = await dialog({ title: T('pt.add', 'Add a partner'), wide: true, form: true, body: partnerBody({}), actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pt.add_ok', 'Add partner'), primary: true }],
        onSubmit: d => { const p = partnerFrom(d); checkPartner(p); const key = uniqueKey(slug(p.name, 32).replace(/_/g, '-') || 'partner', all, /^[a-zA-Z0-9_-]{2,40}$/); return save('compliance', { partners: { [key]: p } }, null, v2 => T('pt.added', '{name} added. Saved as version {v}.', { name: p.name, v: v2 })); } });
      if (v) MC.render();
    });
    on('pt-edit', async el => {
      const k = el.dataset.k; const p0 = all[k]; if (!p0) return;
      const v = await dialog({ title: T('pt.edit_t', 'Edit {name}', { name: p0.name }), wide: true, form: true, body: partnerBody(p0), actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pt.save', 'Save partner'), primary: true }],
        onSubmit: d => { const p = partnerFrom(d); checkPartner(p); return save('compliance', { partners: { [k]: p } }, null, msg); } });
      if (v) MC.render();
    });
    on('pt-remove', async el => {
      const k = el.dataset.k; const p = all[k]; if (!p) return;
      if (!(await confirm({ title: T('pt.remove_q', 'Remove {name}?', { name: p.name }), body: T('pt.remove_body', 'The partner is removed from the register. To keep a record of a finished agreement, set its status to Ended instead. Earlier versions stay in History.'), ok: T('pt.remove_ok', 'Remove partner'), danger: true }))) return;
      const r = await save('compliance', { partners: { [k]: null } }, null, v => T('pt.removed', 'Partner removed. Saved as version {v}.', { v })); if (r) MC.render();
    });
  }

  /* ======================= outgoing connectors ======================= */
  const SIG_EXAMPLE = "const crypto = require('crypto');\n// rawBody: the request body exactly as received\nconst expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');\nconst ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-medicore-signature'] || ''));";
  async function connectorsPage({ stale }) {
    const [d, orgs] = await Promise.all([api.get('/api/hq/connectors'), api.get('/api/hq/providers?limit=500').catch(() => ({ rows: [] }))]);
    if (stale()) return;
    const owner = can('platform.integrations');
    const names = Object.fromEntries((orgs.rows || []).map(o => [o.id, o.name]));
    const evLabel = e => (e === '*' ? T('cn.all_events', 'All events') : (d.events[e] || e));
    view(html`${plainHead(T('cn.title', 'Connectors'), T('cn.sub', 'Send MediCore events to a bank, an ERP, an HMO system or any other outside system, as signed HTTPS calls.'), owner ? html`<button class="btn primary" data-action="cn-new">${icon('plus')}${T('cn.new', 'New connector')}</button>` : '')}
      ${!owner ? html`<div class="notice warn">${T('cn.owner_only', 'Only a platform owner can add, change, test or delete connectors. You can see them and their deliveries.')}</div>` : ''}
      ${d.connectors.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('cn.c.name', 'Connector')}</th><th>${T('cn.c.events', 'Events')}</th><th>${T('cn.c.providers', 'Providers')}</th><th>${T('cn.c.last', 'Last delivery')}</th><th></th></tr></thead><tbody>
        ${d.connectors.map(c => html`<tr><td data-label="${T('cn.c.name', 'Connector')}"><a href="#/connectors/${c.id}"><b>${c.label}</b></a> ${c.active ? badge(T('cn.active', 'Active'), 'ok') : badge(T('cn.paused', 'Paused'), 'warn')}<br><span class="xs muted" style="overflow-wrap:anywhere">${c.url}</span><br><span class="xs muted">${c.secretSet ? T('cn.signed', 'Signed with a secret') : T('cn.unsigned', 'No secret: signature uses an empty key')}</span></td>
          <td data-label="${T('cn.c.events', 'Events')}" class="xs">${c.events.includes('*') ? T('cn.all_events', 'All events') : c.events.map(evLabel).join(', ')}</td>
          <td data-label="${T('cn.c.providers', 'Providers')}" class="xs">${(c.orgIds || []).length ? c.orgIds.map(id => names[id] || id).join(', ') : T('cn.all_providers', 'All providers')}</td>
          <td data-label="${T('cn.c.last', 'Last delivery')}">${c.lastAt ? html`${c.lastOk ? badge(T('cn.ok', 'Accepted'), 'ok') : badge(T('cn.failed', 'Failed'), 'bad')}<br><span class="xs muted">${c.lastStatus ? 'HTTP ' + c.lastStatus + ' | ' : (c.lastOk ? '' : T('cn.no_reply', 'No reply') + ' | ')}${ago(c.lastAt)}</span>` : html`<span class="muted xs">${T('cn.never', 'Nothing sent yet')}</span>`}</td>
          <td class="num"><div class="row wrap" style="justify-content:flex-end">${owner ? html`<button class="btn sm" data-action="cn-test" data-id="${c.id}">${T('cn.test', 'Send test event')}</button><button class="btn sm" data-action="cn-edit" data-id="${c.id}">${T('cn.edit', 'Edit')}</button>` : ''}<a class="btn sm" href="#/connectors/${c.id}">${T('cn.deliveries', 'Deliveries')}</a>${owner ? html`<button class="btn sm" data-action="cn-delete" data-id="${c.id}">${T('cn.delete', 'Delete')}</button>` : ''}</div></td></tr>`)}
      </tbody></table></div>` : empty({ icon: 'swap', title: T('cn.empty', 'No connectors yet'), body: T('cn.empty_sub', 'Add one when a bank, ERP or HMO system needs to hear about payments, referrals, claims or new providers.'), action: owner ? html`<button class="btn primary" data-action="cn-new">${icon('plus')}${T('cn.new', 'New connector')}</button>` : '' })}
      <section class="panel" style="margin-top:16px"><h2>${T('cn.how', 'What the other system receives')}</h2>
        <p class="sm">${T('cn.how1', 'MediCore sends a POST with a JSON body: deliveryId, event, at and data. Data holds ids and amounts only, never names or clinical details.')}</p>
        <dl class="kv sm"><dt><code>X-MediCore-Event</code></dt><dd>${T('cn.h_event', 'The event name, for example payment.success')}</dd><dt><code>X-MediCore-Delivery</code></dt><dd>${T('cn.h_delivery', 'A unique id; use it to ignore repeats')}</dd><dt><code>X-MediCore-Signature</code></dt><dd>${T('cn.h_sig', 'sha256= followed by the HMAC-SHA256 of the raw body, keyed with the connector secret')}</dd></dl>
        <p class="sm" style="margin-top:12px">${T('cn.how2', 'The other system should check the signature before trusting the call, and reply with any 2xx status. Anything else counts as failed and can be retried from Deliveries.')}</p>
        <details><summary class="btn ghost sm">${T('cn.example', 'Show a signature check example')}</summary><pre style="${preStyle}">${SIG_EXAMPLE}</pre></details></section>`);
    const formBody = c => html`${field2('cn-l', T('cn.f.label', 'Name'), html`<input class="input" id="cn-l" name="label" required maxlength="80" value="${c ? c.label : ''}" placeholder="${T('cn.f.label_ph', 'For example: Bank settlement feed')}">`)}
      ${field2('cn-u', T('cn.f.url', 'Address (https)'), html`<input class="input" id="cn-u" name="url" type="url" inputmode="url" required maxlength="500" value="${c ? c.url : ''}" placeholder="https://">`)}
      <div class="field"><label for="cn-s">${T('cn.f.secret', 'Signing secret')}</label>${c ? html`<div style="margin-bottom:6px">${c.secretSet ? badge(T('cn.secret_set', 'Saved'), 'ok') : badge(T('in.not_set', 'Not set'), 'outline')}</div>` : ''}<input class="input" id="cn-s" name="secret" type="password" autocomplete="new-password" maxlength="200" placeholder="${c && c.secretSet ? T('in.replace_ph', 'Type a new value to replace it') : T('cn.f.secret_ph', 'A long random value shared with the other system')}">
        ${c && c.secretSet ? html`<label class="check"><input type="checkbox" name="clearSecret"><span>${T('in.clear_one', 'Clear the saved value when I save')}</span></label>` : ''}<div class="hint">${T('cn.f.secret_h', 'Used to sign every call. It cannot be shown again after saving.')}</div></div>
      <label class="check"><input type="checkbox" name="active" ${!c || c.active ? 'checked' : ''}><span>${T('cn.f.active', 'Active: send events now')}</span></label>
      <div class="field"><span class="label" style="font-weight:700">${T('cn.f.events', 'Events to send')}</span>
        <label class="check"><input type="checkbox" name="events" data-list value="*" ${c && c.events.includes('*') ? 'checked' : ''}><span><b>${T('cn.all_events', 'All events')}</b> <span class="xs muted">${T('cn.all_events_h', 'including events added later')}</span></span></label>
        <div class="fields two">${Object.entries(d.events).map(([k, l]) => html`<label class="check"><input type="checkbox" name="events" data-list value="${k}" ${c && c.events.includes(k) ? 'checked' : ''}><span>${l} <span class="xs muted">${k}</span></span></label>`)}</div></div>
      <details ${c && (c.orgIds || []).length ? 'open' : ''}><summary class="btn ghost sm">${T('cn.f.only', 'Only send events from some providers (optional)')}</summary>
        <p class="hint">${T('cn.f.only_h', 'Leave all unticked to send events from every provider.')}</p>
        <div style="max-height:240px;overflow-y:auto;border:1px solid var(--line);border-radius:6px;padding:0 12px">${(orgs.rows || []).map(o => html`<label class="check"><input type="checkbox" name="orgIds" data-list value="${o.id}" ${c && (c.orgIds || []).includes(o.id) ? 'checked' : ''}><span>${o.name}${o.branchName ? html` <span class="xs muted">${o.branchName}</span>` : ''}</span></label>`)}</div></details>`;
    const toBody = (f, c) => {
      let ev = f.events || []; if (ev.includes('*')) ev = ['*'];
      if (!ev.length) throw new MC.ApiError(400, { error: T('cn.err_events', 'Pick at least one event to send.') });
      if (!/^https:\/\//.test(f.url || '')) throw new MC.ApiError(400, { error: T('cn.err_url', 'The address must start with https://') });
      const b = { label: f.label, url: f.url, events: ev, active: !!f.active, orgIds: f.orgIds || [] };
      if (f.clearSecret) b.secret = ''; else if (f.secret) b.secret = f.secret; else if (!c) delete b.secret;
      return b;
    };
    on('cn-new', async () => {
      const v = await dialog({ title: T('cn.new', 'New connector'), wide: true, form: true, body: formBody(null), actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('cn.create', 'Create connector'), primary: true }], onSubmit: f => api.post('/api/hq/connectors', toBody(f, null)) });
      if (v) { toast(T('cn.created', 'Connector {name} created', { name: v.label }), 'ok'); MC.render(); }
    });
    on('cn-edit', async el => {
      const c = d.connectors.find(x => x.id === el.dataset.id); if (!c) return;
      const v = await dialog({ title: T('cn.edit_t', 'Edit {name}', { name: c.label }), wide: true, form: true, body: formBody(c), actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('cn.save', 'Save connector'), primary: true }], onSubmit: f => api.patch('/api/hq/connectors/' + c.id, toBody(f, c)) });
      if (v) { toast(T('cn.saved', 'Connector {name} saved', { name: v.label }), 'ok'); MC.render(); }
    });
    on('cn-delete', async el => {
      const c = d.connectors.find(x => x.id === el.dataset.id); if (!c) return;
      if (!(await confirm({ title: T('cn.delete_q', 'Delete {name}?', { name: c.label }), body: T('cn.delete_body', 'MediCore stops sending events to {url} at once. This cannot be undone.', { url: c.url }), ok: T('cn.delete_ok', 'Delete connector'), danger: true }))) return;
      await api.post('/api/hq/connectors/' + c.id + '/delete'); toast(T('cn.deleted', 'Connector {name} deleted', { name: c.label }), 'ok'); MC.render();
    });
    on('cn-test', el => testConnector(el.dataset.id, d.connectors.find(x => x.id === el.dataset.id)));
  }
  async function testConnector(id, c) {
    let r; let last = null;
    try { r = await api.post('/api/hq/connectors/' + id + '/test'); }
    catch (e) { r = { ok: false, message: e.status === 403 ? T('cn.test_403', 'Only a platform owner can test connectors.') : e.message }; }
    if (!r.ok) { try { const rows = await api.get('/api/hq/connectors/' + id + '/deliveries'); last = rows[0] || null; } catch (e) { last = null; } }
    toast(r.ok ? T('cn.tested_ok', 'Test event sent and accepted') : T('cn.tested_bad', 'Test event sent but not accepted'), r.ok ? 'ok' : 'bad');
    await dialog({ title: r.ok ? T('cn.test_ok_t', 'Test event accepted') : T('cn.test_bad_t', 'Test event failed'), body: html`<div class="notice ${r.ok ? 'ok' : 'bad'}"><b>${r.message || ''}</b></div>
      ${c ? html`<p class="sm">${T('cn.test_to', 'Sent to {url}', { url: c.url })}</p>` : ''}
      ${last ? html`<dl class="kv sm"><dt>${T('cn.d.status', 'HTTP status')}</dt><dd>${last.status || T('cn.no_reply', 'No reply')}</dd>${last.error ? html`<dt>${T('cn.d.error', 'Error')}</dt><dd>${last.error}</dd>` : ''}<dt>${T('cn.d.when', 'When')}</dt><dd>${dateTime(last.at)}</dd></dl>` : ''}
      ${!r.ok ? html`<p class="sm muted" style="margin-top:12px">${T('cn.test_bad_hint', 'Check the address is reachable from the internet, uses https, and replies with a 2xx status. The attempt is listed under Deliveries, where you can retry it.')}</p>` : ''}`,
      actions: [{ label: T('cn.see_deliveries', 'See deliveries'), value: 'go' }, { label: T('common.done', 'Done'), primary: true, value: null }] }).then(v => { if (v === 'go') MC.go('#/connectors/' + id); else MC.render(); });
  }
  async function connectorDetail({ params, stale }) {
    const [d, rows] = await Promise.all([api.get('/api/hq/connectors'), api.get('/api/hq/connectors/' + encodeURIComponent(params.id) + '/deliveries')]);
    if (stale()) return;
    const c = d.connectors.find(x => x.id === params.id);
    if (!c) return view(html`<a class="back" href="#/connectors">${icon('left')}${T('cn.title', 'Connectors')}</a>${empty({ icon: 'swap', title: T('cn.not_found', 'Connector not found'), body: T('cn.not_found_sub', 'It may have been deleted.'), action: html`<a class="btn" href="#/connectors">${T('cn.back', 'Back to connectors')}</a>` })}`);
    const owner = can('platform.integrations');
    view(html`<a class="back" href="#/connectors">${icon('left')}${T('cn.title', 'Connectors')}</a>
      ${plainHead(c.label, html`<span style="overflow-wrap:anywhere">${c.url}</span>`, owner ? html`<button class="btn" data-action="cn-test1" data-id="${c.id}">${icon('refresh')}${T('cn.test', 'Send test event')}</button>` : '')}
      ${MC.figures([{ value: rows.length, label: T('cn.f_total', 'Deliveries (latest 100)') }, { value: rows.filter(x => x.ok).length, label: T('cn.f_ok', 'Accepted') }, { value: rows.filter(x => !x.ok).length, label: T('cn.f_failed', 'Failed'), tone: rows.some(x => !x.ok) ? 'bad' : '' }])}
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('cn.d.when', 'When')}</th><th>${T('cn.d.event', 'Event')}</th><th>${T('cn.d.result', 'Result')}</th><th>${T('cn.d.detail', 'Details')}</th><th></th></tr></thead><tbody>
        ${rows.map(x => html`<tr><td data-label="${T('cn.d.when', 'When')}">${dateTime(x.at)}</td><td data-label="${T('cn.d.event', 'Event')}"><b>${x.event}</b>${x.payload && x.payload.retryOf ? html`<br><span class="xs muted">${T('cn.d.retry_of', 'Retry')}</span>` : ''}</td>
          <td data-label="${T('cn.d.result', 'Result')}">${x.ok ? badge(T('cn.ok', 'Accepted'), 'ok') : badge(T('cn.failed', 'Failed'), 'bad')}<br><span class="xs muted">${x.status ? 'HTTP ' + x.status : T('cn.no_reply', 'No reply')}</span></td>
          <td data-label="${T('cn.d.detail', 'Details')}" class="xs">${x.error ? html`<span>${x.error}</span>` : ''}<details><summary class="btn ghost sm">${T('cn.d.payload', 'Show what was sent')}</summary><pre style="${preStyle}">${JSON.stringify(x.payload, null, 2)}</pre></details></td>
          <td class="num">${owner && !x.ok ? html`<button class="btn sm" data-action="cn-retry" data-id="${x.id}">${T('cn.retry', 'Retry delivery')}</button>` : ''}</td></tr>`)}
      </tbody></table></div>` : empty({ icon: 'clock', title: T('cn.d.empty', 'Nothing sent yet'), body: T('cn.d.empty_sub', 'Every call to this connector is listed here, with the reply. Send a test event to check it.') })}`);
    on('cn-test1', () => testConnector(c.id, c));
    on('cn-retry', async el => {
      let r; try { r = await api.post('/api/hq/connectors/deliveries/' + el.dataset.id + '/retry'); } catch (e) { if (e.status === 403) throw new MC.ApiError(403, { error: T('cn.test_403', 'Only a platform owner can test connectors.') }); throw e; }
      toast(r.ok ? T('cn.retried_ok', 'Delivery retried and accepted') : T('cn.retried_bad', 'Delivery retried but failed again'), r.ok ? 'ok' : 'bad'); MC.render();
    });
  }

  /* ---------- history ---------- */
  async function history() {
    await load(); const rows = await api.get('/api/hq/config/history');
    view(html`${head(T('hi.title', 'History'), T('hi.sub', 'Every saved change. Restore any version; the restore itself becomes a new version.'))}${tabs('history')}
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('hi.v', 'Version')}</th><th>${T('hi.when', 'When')}</th><th>${T('hi.who', 'Who')}</th><th>${T('hi.what', 'What changed')}</th><th></th></tr></thead><tbody>${rows.map(r => html`<tr><td data-label="${T('hi.v', 'Version')}"><b>${r.version}</b></td><td data-label="${T('hi.when', 'When')}">${dateTime(r.at)}</td><td data-label="${T('hi.who', 'Who')}">${r.byName}</td><td data-label="${T('hi.what', 'What changed')}" class="xs" style="overflow-wrap:anywhere">${(r.changed || []).slice(0, 6).join(', ')}${(r.changed || []).length > 6 ? ' +' + (r.changed.length - 6) : ''}${r.note ? html`<br><i>${r.note}</i>` : ''}</td><td class="num">${r.version !== state.version && can('platform.config') ? html`<button class="btn sm" data-action="hi-restore" data-v="${r.version}">${T('hi.restore', 'Restore')}</button>` : r.version === state.version ? badge(T('hi.current', 'Current'), 'ok') : ''}</td></tr>`)}</tbody></table></div>` : empty({ icon: 'clock', title: T('hi.empty', 'No changes yet'), body: T('hi.empty_sub', 'Everything is on the built-in defaults.') })}`);
    on('hi-restore', async el => { if (!(await confirm({ title: T('hi.restore_q', 'Restore version {v}?', { v: el.dataset.v }), body: T('hi.restore_body', 'All settings go back to how they were in that version. Every app picks it up within a minute.'), ok: T('hi.restore_ok', 'Restore this version') }))) return; await api.post('/api/hq/config/restore', { version: Number(el.dataset.v) }); toast(T('hi.restored', 'Version {v} restored', { v: el.dataset.v }), 'ok'); MC.render(); });
  }

  /* ---------- support queue ---------- */
  const CATS = { billing_subscription: 'Billing and subscription', technical_problem: 'Something is not working', feature_request: 'Feature request', data_correction: 'Data correction', account_access: 'Account or sign-in', complaint: 'Complaint', integration: 'Integration', training: 'Training', other: 'Other' };
  const catLabel = c => T('sp.cat.' + c, CATS[c] || c);
  async function supportList({ query }) {
    const rows = await api.get('/api/hq/support' + MC.qs({ status: query.status, priority: query.priority, mine: query.mine }));
    view(html`<div class="page-head"><div><h1>${T('sp.title', 'Support')}</h1><p>${T('sp.sub', 'Requests and complaints from providers, most urgent first.')}</p></div></div>
      <nav class="tabs">${[['', T('sp.open', 'Open')], ['waiting_provider', T('sp.waiting', 'Waiting on provider')], ['resolved', T('sp.resolved', 'Resolved')], ['closed', T('sp.closed', 'Closed')]].map(([k, l]) => html`<a href="#/support${k ? '?status=' + k : ''}" ${(query.status || '') === k && !query.mine ? MC.raw('aria-current="page"') : ''}>${l}</a>`)}<a href="#/support?mine=true" ${query.mine ? MC.raw('aria-current="page"') : ''}>${T('sp.mine', 'Assigned to me')}</a></nav>
      ${rows.length ? html`<div class="list">${rows.map(r => html`<a href="#/support/${r.id}"><div class="grow"><span class="title">${r.subject}</span><span class="sub">${r.number} | ${r.orgName} | ${catLabel(r.category)} | ${ago(r.createdAt)}</span></div><span class="end">${badge(MC.t('status.' + r.priority, cap(r.priority)), r.priority === 'urgent' ? 'bad' : r.priority === 'high' ? 'warn' : 'outline')}${r.overdue ? html`<br>${badge(T('sp.overdue', 'Overdue'), 'bad')}` : ''}<br>${MC.statusBadge(r.status)}</span></a>`)}</div>` : empty({ icon: 'message', title: T('sp.empty', 'No requests here') })}`);
  }
  async function supportView({ params }) {
    const r = await api.get('/api/hq/support/' + params.id);
    view(html`<a class="back" href="#/support">${icon('left')}${T('sp.title', 'Support')}</a><div class="page-head"><div><h1>${r.subject}</h1><p>${r.number} | <a href="#/providers/${r.orgId}">${r.orgName}</a> | ${catLabel(r.category)} | ${MC.statusBadge(r.status)}</p></div>
      <div class="actions"><button class="btn" data-action="sp-assign">${T('sp.assign_me', 'Assign to me')}</button><label class="sr-only" for="sp-pri">${T('sp.priority', 'Priority')}</label><select class="input" id="sp-pri" data-sp-pri style="width:auto">${['low', 'normal', 'high', 'urgent'].map(p => html`<option value="${p}" ${r.priority === p ? 'selected' : ''}>${MC.t('status.' + p, cap(p))}</option>`)}</select></div></div>
      <ol class="timeline">${r.messages.map(m => html`<li><time>${dateTime(m.at)} | ${m.side === 'medicore' ? T('sp.team', 'MediCore') + ': ' + m.byName : m.byName + ' (' + r.orgName + ')'}${m.internal ? ' | ' + T('sp.internal', 'internal note') : ''}</time>${m.text}</li>`)}</ol>
      ${r.status !== 'closed' ? html`<form class="panel" data-form="sp-reply" novalidate style="margin-top:16px"><div class="field"><label for="sp-t">${T('sp.reply', 'Reply')}</label><textarea class="input" id="sp-t" name="text" required></textarea></div>
        <label class="check"><input type="checkbox" name="internal"><span>${T('sp.internal_only', 'Internal note (the provider does not see it)')}</span></label>
        <div class="field"><label for="sp-s">${T('sp.after', 'After sending')}</label><select class="input" id="sp-s" name="status"><option value="waiting_provider">${T('sp.ask', 'Wait for the provider')}</option><option value="in_progress">${T('sp.keep', 'Keep working on it')}</option><option value="resolved">${T('sp.resolve', 'Mark resolved')}</option></select></div>
        <div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${T('sp.send', 'Send reply')}</button></form>` : ''}`);
    form('sp-reply', async d => { await api.post('/api/hq/support/' + r.id + '/reply', { text: d.text, internal: !!d.internal, status: d.internal ? undefined : d.status }); toast(T('sp.sent', 'Reply sent'), 'ok'); MC.render(); });
    on('sp-assign', async () => { await api.patch('/api/hq/support/' + r.id, { assigneeId: MC.me.user.id }); toast(T('sp.assigned', 'Assigned to you'), 'ok'); });
    document.querySelector('[data-sp-pri]').addEventListener('change', async e => { try { await api.patch('/api/hq/support/' + r.id, { priority: e.target.value }); toast(T('sp.pri_changed', 'Priority changed'), 'ok'); } catch (err) { MC.showError(err); } });
  }


  /* ---------- public hospitals (not on MediCore) and the marketplace ---------- */
  const FK = { teaching: 'Teaching hospital', federal_medical_centre: 'Federal medical centre', specialist: 'Specialist hospital', general: 'General hospital', cottage: 'Cottage hospital', phc: 'Primary health centre', military: 'Military hospital', mission: 'Mission hospital', private: 'Private (not on MediCore)', other: 'Other' };
  const fkLabel = k => T('fac.kind.' + k, FK[k] || cap(k));
  async function facilitiesPage({ query }) {
    const r = await api.get('/api/hq/facilities' + (query.q ? '?q=' + encodeURIComponent(query.q) : query.unverified ? '?unverified=true' : ''));
    const M = r.meta; const w = can('platform.config');
    view(html`<div class="page-head"><div><h1>${T('fac.title', 'Public hospitals')}</h1><p>${T('fac.sub', 'Government, mission and other hospitals that are not on MediCore yet. Staff see them in the emergency transfer finder; everyone sees emergency ones on the map.')}</p></div>
      ${w ? html`<div class="actions"><button class="btn primary" data-action="fac-new">${icon('plus')}${T('fac.new', 'Add a hospital')}</button><button class="btn" data-action="fac-import">${icon('download')}${T('fac.import', 'Import a spreadsheet')}</button></div>` : ''}</div>
      ${r.suggestions ? html`<div class="notice warn">${T('fac.sugg', '{n} corrections from providers are waiting.', { n: r.suggestions })} <a href="#/facilities/suggestions">${T('fac.sugg_open', 'Review them')}</a></div>` : ''}
      <form class="row" data-form="fac-q" novalidate style="margin-bottom:12px"><input class="input" name="q" value="${query.q || ''}" placeholder="${T('fac.search', 'Search by name or LGA')}" aria-label="${T('fac.search', 'Search by name or LGA')}" style="flex:1"><button class="btn" type="submit">${icon('search')}</button><a class="btn" href="#/facilities?unverified=1">${T('fac.unverified', 'Numbers not checked')}</a></form>
      <section class="panel flush">${r.facilities.length ? html`<ul class="list">${r.facilities.map(f => html`<li><div class="grow"><span class="title">${f.name} ${f.verified ? badge(T('fac.verified', 'Numbers checked'), 'ok') : badge(T('fac.not_verified', 'Not checked'), 'warn')}</span><span class="sub">${[fkLabel(f.kind), cap(f.level), f.lga, f.state, f.location ? '' : T('fac.no_loc', 'no map location')].filter(Boolean).join(' | ')}</span><span class="sub">${(f.phones || []).map(p => cap(p.kind) + ': ' + p.number).join(' | ')}</span></div>${w ? html`<span class="end"><button class="btn sm" data-action="fac-edit" data-id="${f.id}">${T('fac.edit', 'Edit')}</button></span>` : ''}</li>`)}</ul>` : empty({ icon: 'building', title: T('fac.none', 'No hospitals yet'), body: T('fac.none_sub', 'Import the list of public hospitals in your states, then call each to check the numbers.') })}</section>`);
    const fields = f => html`<div class="field"><label for="fc-n">${T('fac.name', 'Name')}</label><input class="input" id="fc-n" name="name" required maxlength="160" value="${f ? f.name : ''}"></div>
      <div class="fields three"><div class="field"><label for="fc-k">${T('fac.kind', 'Kind')}</label><select class="input" id="fc-k" name="kind">${M.kinds.map(k => html`<option value="${k}" ${f && f.kind === k ? 'selected' : ''}>${fkLabel(k)}</option>`)}</select></div><div class="field"><label for="fc-o">${T('fac.owner', 'Owner')}</label><select class="input" id="fc-o" name="ownership">${M.ownership.map(k => html`<option value="${k}" ${f && f.ownership === k ? 'selected' : ''}>${cap(k)}</option>`)}</select></div><div class="field"><label for="fc-l">${T('fac.level', 'Level')}</label><select class="input" id="fc-l" name="level">${M.levels.map(k => html`<option value="${k}" ${f && f.level === k ? 'selected' : ''}>${cap(k)}</option>`)}</select></div></div>
      <div class="fields three"><div class="field"><label for="fc-s">${T('fac.state', 'State')}</label><input class="input" id="fc-s" name="state" maxlength="40" value="${f ? f.state || '' : 'Lagos'}"></div><div class="field"><label for="fc-g">LGA</label><input class="input" id="fc-g" name="lga" maxlength="60" value="${f ? f.lga || '' : ''}"></div><div class="field"><label for="fc-a">${T('fac.address', 'Address')}</label><input class="input" id="fc-a" name="address" maxlength="300" value="${f ? f.address || '' : ''}"></div></div>
      <div class="fields two"><div class="field"><label for="fc-la">${T('fac.lat', 'Latitude')}</label><input class="input" id="fc-la" name="lat" type="number" step="any" value="${f && f.location ? f.location.lat : ''}"></div><div class="field"><label for="fc-lo">${T('fac.lng', 'Longitude')}</label><input class="input" id="fc-lo" name="lng" type="number" step="any" value="${f && f.location ? f.location.lng : ''}"></div></div>
      <div class="fields three">${['main', 'emergency', 'transfer'].map(k => html`<div class="field"><label for="fc-p${k}">${T('fac.ph.' + k, cap(k) + ' number')}</label><input class="input" id="fc-p${k}" name="ph_${k}" inputmode="tel" value="${f ? ((f.phones || []).find(p => p.kind === k) || {}).number || '' : ''}"></div>`)}</div>
      <div class="field"><span class="label">${T('fac.services', 'Services')}</span><div class="fields three">${M.services.map(s => html`<label class="check"><input type="checkbox" name="services" data-list value="${s}" ${f && (f.services || []).includes(s) ? 'checked' : ''}><span>${cap(s)}</span></label>`)}</div></div>
      <label class="check"><input type="checkbox" name="open24h" ${f && f.open24h ? 'checked' : ''}><span>${T('fac.24h', 'Open 24 hours')}</span></label><label class="check"><input type="checkbox" name="verified" ${f && f.verified ? 'checked' : ''}><span>${T('fac.checked', 'We called and checked the numbers')}</span></label>
      ${f ? html`<label class="check"><input type="checkbox" name="hidden" ${f.status === 'hidden' ? 'checked' : ''}><span>${T('fac.hide', 'Hide from the map')}</span></label>` : ''}`;
    const toBody = d => { const b = { name: d.name, kind: d.kind, ownership: d.ownership, level: d.level, state: d.state || '', lga: d.lga || '', address: d.address || '', services: d.services || [], open24h: !!d.open24h, verified: !!d.verified, phones: ['main', 'emergency', 'transfer'].filter(k => d['ph_' + k]).map(k => ({ number: d['ph_' + k], kind: k })) }; if (d.lat != null && d.lng != null) b.location = { lat: d.lat, lng: d.lng }; if ('hidden' in d) b.status = d.hidden ? 'hidden' : 'active'; return b; };
    on('fac-new', async () => { if (await dialog({ title: T('fac.new', 'Add a hospital'), wide: true, form: true, body: fields(null), actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('fac.save', 'Save'), primary: true }], onSubmit: d => api.post('/api/hq/facilities', toBody(d)) })) MC.render(); });
    on('fac-edit', async el => { const f = r.facilities.find(x => x.id === el.dataset.id); if (await dialog({ title: f.name, wide: true, form: true, body: fields(f), actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('fac.save', 'Save'), primary: true }], onSubmit: d => api.patch('/api/hq/facilities/' + f.id, toBody(d)) })) MC.render(); });
    on('fac-import', async () => {
      let text = '';
      const v = await dialog({ title: T('fac.import', 'Import a spreadsheet'), wide: true, form: true, body: html`<p class="sm">${T('fac.import_help', 'Save your spreadsheet as CSV with a header row. Columns: name, kind, ownership, level, state, lga, address, lat, lng, main_phone, emergency_phone, transfer_phone, services (separated by |), open24h (yes or no), hfr_id. Rows with the same HFR id, or the same name and state, are updated.')}</p>
        <div class="field"><label for="fi-f">${T('fac.file', 'CSV file')}</label><input class="input" id="fi-f" type="file" accept=".csv,text/csv"></div><label class="check"><input type="checkbox" name="markVerified"><span>${T('fac.mark', 'The numbers in this file are already checked')}</span></label><div id="fi-out"></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('fac.check', 'Check, then import'), primary: true }],
        onOpen: d => d.querySelector('#fi-f').addEventListener('change', e => { const f = e.target.files[0]; if (!f) return; const fr = new FileReader(); fr.onload = () => { text = String(fr.result || ''); }; fr.readAsText(f); }),
        onSubmit: async d => {
          if (!text) throw new MC.ApiError(400, { error: T('fac.pick', 'Choose the CSV file first') });
          const dry = await api.post('/api/hq/facilities/import', { csv: text, dryRun: true });
          const ok = await confirm({ title: T('fac.import_q', 'Import {n} rows?', { n: dry.results.filter(x => x.ok).length }), body: T('fac.import_b', '{c} new, {u} updated, {f} with problems (skipped).', { c: dry.results.filter(x => x.ok && x.action === 'create').length, u: dry.results.filter(x => x.ok && x.action === 'update').length, f: dry.failed }), ok: T('fac.import', 'Import a spreadsheet') });
          if (!ok) return false;
          return api.post('/api/hq/facilities/import', { csv: text, markVerified: !!d.markVerified });
        } });
      if (v) { toast(T('fac.imported', '{c} added, {u} updated', { c: v.created, u: v.updated }), 'ok'); MC.render(); }
    });
  }
  form('fac-q', d => MC.go('#/facilities' + (d.q ? '?q=' + encodeURIComponent(d.q) : '')));
  async function facSuggestions() {
    const rows = await api.get('/api/hq/facility-suggestions');
    view(html`<a class="back" href="#/facilities">${icon('left')}${T('fac.title', 'Public hospitals')}</a><div class="page-head"><div><h1>${T('fac.sugg_title', 'Corrections from providers')}</h1></div></div>
      <section class="panel flush">${rows.length ? html`<ul class="list">${rows.map(s => html`<li><div class="grow"><span class="title">${s.facilityName}</span><span class="sub">${s.orgName} | ${s.byName} | ${dateTime(s.createdAt)}</span><span class="sub">${s.phone ? cap(s.phone.kind) + ': ' + s.phone.number + ' | ' : ''}${s.note}</span></div><span class="end">${s.phone ? html`<button class="btn sm primary" data-action="fs-do" data-a="apply" data-id="${s.id}">${T('fac.apply', 'Use this number')}</button>` : ''}<button class="btn sm" data-action="fs-do" data-a="dismiss" data-id="${s.id}">${T('fac.dismiss', 'Dismiss')}</button></span></li>`)}</ul>` : empty({ icon: 'check', title: T('fac.sugg_none', 'Nothing to review') })}</section>`);
  }
  on('fs-do', async el => { await api.post('/api/hq/facility-suggestions/' + el.dataset.id + '/' + el.dataset.a); MC.render(); });
  async function marketPage() {
    const m = await api.get('/api/hq/market');
    view(html`<div class="page-head"><div><h1>${T('mkt.title', 'Patient marketplace')}</h1><p>${T('mkt.sub', 'Patients who pay for marketplace access, and the providers they find there. Prices are in Processes > Patient marketplace.')}</p></div><div class="actions"><a class="btn" href="#/config/process">${T('mkt.prices', 'Change prices')}</a></div></div>
      <div class="figures"><div><b>${m.activeSubscribers}</b><span>${T('mkt.subs', 'Patients with access now')}</span></div><div><b>${money(m.revenue30dKobo)}</b><span>${T('mkt.rev', 'Paid in the last 30 days')}</span></div><div><b>${m.listedProviders}</b><span>${T('mkt.listed', 'Providers listed')}</span></div><div><b>${m.joins30d}</b><span>${T('mkt.joins', 'Registrations through the marketplace, 30 days')}</span></div></div>
      <section class="panel"><h2>${T('mkt.by_plan', 'Access by length')}</h2><dl class="kv">${Object.entries(m.prices).map(([k, p]) => html`<dt>${cap(k)} (${money(p.amountKobo)})</dt><dd>${m.byPlan[k] || 0}</dd>`)}</dl></section>`);
  }

  window.HQConfig = {
    routes: { '#/config': branding, '#/config/branding': branding, '#/config/content': content, '#/config/languages': languages, '#/config/features': features, '#/config/process': processes, '#/config/pricing': pricing, '#/config/roles': rolesPage, '#/config/catalog': catalog, '#/config/integrations': integrations, '#/config/history': history,
      '#/golive': golive, '#/compliance': compliancePage, '#/compliance/partners': partnersPage, '#/connectors': connectorsPage, '#/connectors/:id': connectorDetail,
      '#/support': supportList, '#/support/:id': supportView, '#/facilities': facilitiesPage, '#/facilities/suggestions': facSuggestions, '#/marketplace': marketPage },
    nav: [
      { href: '#/config', label: MC.t('hq.nav.config', 'Configuration'), short: MC.t('hq.nav.config_s', 'Config'), icon: 'settings', perm: 'platform.read' },
      { href: '#/golive', label: MC.t('hq.nav.golive', 'Go-live checklist'), short: MC.t('hq.nav.golive_s', 'Go-live'), icon: 'check', perm: 'platform.read' },
      { href: '#/compliance', label: MC.t('hq.nav.compliance', 'Compliance and partners'), short: MC.t('hq.nav.compliance_s', 'Compliance'), icon: 'clipboard', perm: 'platform.read' },
      { href: '#/connectors', label: MC.t('hq.nav.connectors', 'Connectors'), icon: 'swap', perm: 'platform.read' },
      { href: '#/marketplace', label: MC.t('hq.nav.marketplace', 'Patient marketplace'), short: MC.t('hq.nav.marketplace_s', 'Marketplace'), icon: 'globe', perm: 'platform.read' },
      { href: '#/facilities', label: MC.t('hq.nav.facilities', 'Public hospitals'), icon: 'building', perm: 'platform.read' },
      { href: '#/support', label: MC.t('hq.nav.support', 'Support'), icon: 'message', perm: 'platform.support' }],
    featureLabel,
    settingsHref,
  };
})();
