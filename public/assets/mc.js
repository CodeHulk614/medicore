/*
 * MediCore front-end kit v2 (no build step, works under a strict Content-Security-Policy).
 *
 * SAFETY RULES FOR APP CODE
 *  - Build markup ONLY with the html`` tag. Every ${value} is escaped. Never concatenate
 *    user data into strings that become HTML, never assign user data to innerHTML directly.
 *  - No inline event handlers (onclick=) and no inline <script>: use data-action / data-form
 *    and register handlers with MC.on() / MC.form().
 *  - Sessions are HttpOnly cookies. Tokens never touch localStorage.
 *
 * Quick reference
 *   MC.boot({ title, nav: [{ href:'#/x', label, icon, perm?, module? }], routes: { '#/x': fn, '#/y/:id': fn }, home:'#/x', publicRoutes? })
 *   route handler: async ({ params, query, me, el }) => { MC.view(html`...`) }
 *   MC.api.get('/api/...'), MC.api.post(path, body), MC.api.patch(path, body)
 *   MC.on('action-name', async (el, ev) => {...})      <button data-action="action-name" data-id="...">
 *   MC.form('form-name', async (data, form) => {...})   <form data-form="form-name">
 *   MC.toast('Saved', 'ok'); await MC.confirm({ title, body, ok:'Delete', danger:true })
 *   MC.dialog({ title, body: html``, actions: [{ label, primary, value }] }) -> Promise<value>
 *   MC.money(kobo), MC.date(ts), MC.time(ts), MC.dateTime(ts), MC.ago(ts), MC.icon('pill')
 *   MC.wristband(patient)   MC.badge(text, kind)   MC.empty({ icon, title, body, action })
 *   MC.poll(fn, ms) -> stop()   MC.position() -> {lat,lng,accuracyM} | null
 */
(function () {
  'use strict';
  const APP = document.body.dataset.app;

  /* ---------------- escaping and templates ---------------- */
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;' };
  const esc = s => String(s).replace(/[&<>"'`=]/g, c => ESC[c]);
  class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
  const raw = s => new Raw(String(s));
  function renderVal(v) {
    if (v === null || v === undefined || v === false) return '';
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(renderVal).join('');
    return esc(v);
  }
  function html(strings, ...vals) { let out = ''; for (let i = 0; i < strings.length; i++) { out += strings[i]; if (i < vals.length) out += renderVal(vals[i]); } return new Raw(out); }


  /* ---------------- languages ----------------
   * MC.t('key', 'English text', { name: 'Ada' })  -> text in the user's language ({name} filled in).
   * English lives in the code; other languages in /assets/i18n/<lang>.json; HQ can override any
   * string from the control plane (content.i18n). Missing translations fall back to English.
   */
  const LANGS = { en: 'English', pcm: 'Naijá (Pidgin)', yo: 'Yorùbá', ha: 'Hausa', ig: 'Asụsụ Igbo' };
  let lang = 'en'; let dict = {}; let overrides = {}; let enabledLangs = Object.keys(LANGS); let langReady = false;
  function pickLang() { try { const l = localStorage.getItem('mc-lang'); if (l && LANGS[l]) return l; } catch (e) { } return 'en'; }
  async function loadLang(l) {
    lang = LANGS[l] ? l : 'en'; dict = {};
    if (lang !== 'en') { try { const r = await fetch('/assets/i18n/' + lang + '.json', { credentials: 'same-origin' }); if (r.ok) dict = await r.json(); } catch (e) { dict = {}; } }
    document.documentElement.lang = lang === 'pcm' ? 'pcm' : lang; langReady = true;
  }
  function t(key, fallback, vars) {
    let s = (overrides[lang] && overrides[lang][key]) || dict[key] || (lang === 'en' && overrides.en && overrides.en[key]) || fallback || key;
    if (vars) s = String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? vars[k] : m));
    // called before the language file loaded (e.g. nav labels at boot): remember the key so the shell can translate later
    if (!langReady) { const o = new String(s); o.mcKey = key; o.mcFallback = fallback; o.mcVars = vars; return o; }
    return s;
  }
  const late = v => (v && v.mcKey ? t(v.mcKey, v.mcFallback, v.mcVars) : v);
  async function setLang(l, opts = {}) {
    try { localStorage.setItem('mc-lang', l); } catch (e) { }
    await loadLang(l);
    if (opts.save && me && me.kind === 'patient') { try { await api.patch('/api/me/profile', { lang: l }); } catch (e) { } }
    emit('lang:changed', l);
    if (me) { shell(); render(); } else start();
  }
  const langOptions = () => enabledLangs.filter(k => LANGS[k]).map(k => ({ key: k, label: LANGS[k] }));

  /* ---------------- icons (stroke, 24px grid) ---------------- */
  const P = {
    home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    calendar: 'M4 5h16v16H4zM4 9h16M8 3v4M16 3v4', users: 'M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 20v-1a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
    user: 'M20 21v-1a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5v1M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8', pill: 'M10.5 20.5a5 5 0 0 1-7-7l10-10a5 5 0 0 1 7 7zM8.5 8.5l7 7',
    flask: 'M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7 15h10', truck: 'M2 6h11v10H2zM13 9h4l4 4v3h-8zM6.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M17.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3',
    ambulance: 'M2 7h12v9H2zM14 10h4l3 3v3h-7zM6 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M17 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M8 9.5v4M6 11.5h4',
    pin: 'M12 21s-7-6.1-7-11.5A7 7 0 0 1 19 9.5C19 14.9 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5', clipboard: 'M9 4h6v3H9zM9 5H6v16h12V5h-3M9 12h6M9 16h4',
    message: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z', bell: 'M18 16V11a6 6 0 1 0-12 0v5l-2 2h16zM10 21h4', settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 15H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.7 4.4V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.3-4.3', plus: 'M12 5v14M5 12h14', check: 'M20 6 9 17l-5-5', x: 'M18 6 6 18M6 6l12 12',
    alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01', stop: 'M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9zM12 8v4M12 16h.01',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5l3 2', card: 'M2 5h20v14H2zM2 10h20M6 15h4', file: 'M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6',
    pulse: 'M3 12h4l3-8 4 16 3-8h4', shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', left: 'M15 18l-6-6 6-6', right: 'M9 18l6-6-6-6', menu: 'M3 6h18M3 12h18M3 18h18',
    more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2', phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
    video: 'M23 7l-7 5 7 5zM1 5h15v14H1z', refresh: 'M21 12a9 9 0 0 1-15.5 6.3L3 16M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M3 21v-5h5', box: 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
    chart: 'M3 3v18h18M7 15v2M12 10v7M17 6v11', building: 'M4 21V3h11v18M15 9h5v12M8 7h3M8 11h3M8 15h3M2 21h20', steth: 'M5 3v6a5 5 0 0 0 10 0V3M10 14v2a5 5 0 0 0 10 0v-2M20 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
    heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z', download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
    eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6', edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z', trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
    nav: 'M3 11l19-9-9 19-2-8z', sos: 'M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
    lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4', key: 'M21 2l-9.6 9.6M15.5 7.5l3 3L22 7l-3-3M7.5 22a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11', moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
    swap: 'M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5', globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20', baby: 'M9 12h.01M15 12h.01M10 16c.5.3 1.2.5 2 .5s1.5-.2 2-.5M19 6.3A9 9 0 1 1 5 6.3M12 3a2 2 0 0 0 0 4',
  };
  function icon(name, cls) { const d = P[name] || P.more; return raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (cls ? ' class="' + esc(cls) + '"' : '') + '><path d="' + d + '"/></svg>'); }

  /* ---------------- events ---------------- */
  const listeners = {};
  const emit = (ev, data) => (listeners[ev] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });
  const onEvent = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); };

  /* ---------------- API ---------------- */
  class ApiError extends Error { constructor(status, body) { super((body && body.error) || ('Request failed (' + status + ')')); this.status = status; this.code = body && body.code; this.details = body && body.details; this.body = body; } }
  // extra headers an app sets for every call, e.g. the patient app's chosen provider: MC.api.header('X-MC-Provider', key)
  const extraHeaders = {};
  async function request(method, path, body) {
    const opts = { method, credentials: 'same-origin', headers: Object.assign({ 'X-MC-App': APP === 'register' ? (document.body.dataset.apiApp || 'patient') : APP, 'X-MC-Lang': lang }, extraHeaders) };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(path, opts); } catch (e) { throw new ApiError(0, { error: navigator.onLine ? t('kit.err.network', 'Could not reach MediCore. Check your connection and try again.') : t('kit.err.offline', 'You are offline. Connect to the internet and try again.'), code: 'network' }); }
    let data = null; const text = await r.text(); try { data = text ? JSON.parse(text) : null; } catch (e) { data = { error: 'Unexpected response from the server' }; }
    if (!r.ok) {
      const err = new ApiError(r.status, data);
      if (r.status === 401 && !/\/api\/auth\/login/.test(path)) emit('auth:required', err);
      if (r.status === 423 && err.code === 'password_change_required') emit('auth:password', err);
      if (r.status === 423 && err.code === 'clock_in_required') emit('shift:required', err);
      throw err;
    }
    return data;
  }
  const api = { get: p => request('GET', p), post: (p, b) => request('POST', p, b === undefined ? {} : b), patch: (p, b) => request('PATCH', p, b), put: (p, b) => request('PUT', p, b), del: p => request('DELETE', p),
    header: (name, value) => { if (value == null || value === '') delete extraHeaders[name]; else extraHeaders[name] = String(value); } };
  const qs = o => { const s = Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); return s ? '?' + s : ''; };

  /* ---------------- formatting (Africa/Lagos) ---------------- */
  const TZ = 'Africa/Lagos';
  const money = k => (k == null ? '' : '₦' + (Math.round(k) / 100).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 }));
  const fmt = (ts, o) => (ts == null ? '' : new Intl.DateTimeFormat('en-NG', Object.assign({ timeZone: TZ }, o)).format(new Date(ts)));
  const date = ts => fmt(ts, { day: 'numeric', month: 'short', year: 'numeric' });
  const time = ts => fmt(ts, { hour: '2-digit', minute: '2-digit' });
  const dateTime = ts => fmt(ts, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const day = ts => fmt(ts, { weekday: 'short', day: 'numeric', month: 'short' });
  function ago(ts) { if (!ts) return ''; const s = Math.round((Date.now() - ts) / 1000); if (s < 45) return t('kit.just_now', 'just now'); if (s < 3600) return t('kit.min_ago', '{n} min ago', { n: Math.round(s / 60) }); if (s < 86400) return t('kit.h_ago', '{n} h ago', { n: Math.round(s / 3600) }); if (s < 7 * 86400) return t('kit.d_ago', '{n} d ago', { n: Math.round(s / 86400) }); return date(ts); }
  function mins(ts) { if (!ts) return ''; const m = Math.max(0, Math.round((Date.now() - ts) / 60000)); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; }
  const todayISO = () => fmt(Date.now(), { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-');
  const age = dob => { if (!dob) return null; const d = new Date(dob + 'T00:00:00Z'); const n = new Date(); let a = n.getUTCFullYear() - d.getUTCFullYear(); if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) a--; return a; };
  const cap = s => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1).replace(/_/g, ' ') : '');
  const initials = n => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0].toUpperCase()).join('');

  /* ---------------- small components ---------------- */
  const badge = (text, kind) => html`<span class="badge ${kind || ''}">${text}</span>`;
  function statusBadge(status, map) { const m = map || {}; const kind = m[status] || (/(done|completed|paid|delivered|released|active|approved|closed|collected|verified|ok)/.test(status) ? 'ok' : /(cancel|denied|rejected|failed|void|suspended|expired|critical)/.test(status) ? 'bad' : /(pending|waiting|open|queried|new|awaiting)/.test(status) ? 'warn' : 'info'); return badge(t('status.' + status, cap(status)), kind); }
  function empty({ icon: ic, title, body, action } = {}) { return html`<div class="empty">${icon(ic || 'clipboard')}<b>${title || t('kit.empty', 'Nothing here yet')}</b>${body ? html`<p class="sm">${body}</p>` : ''}${action || ''}</div>`; }
  const skeleton = (n = 3) => raw('<div aria-busy="true" aria-label="Loading">' + '<div class="skeleton"></div>'.repeat(n) + '</div>');
  function wristband(p) {
    if (!p) return '';
    const a = p.allergies || [];
    const sev = a.length ? 'has-allergy' : '';
    const allergyLine = a.length
      ? html`<div class="allergy" role="note" aria-label="Allergies">${a.map(x => html`<span class="allergy-tag">${icon('alert')}${x.substance}${x.reaction ? ': ' + x.reaction : ''}</span>`)}</div>`
      : (p.noKnownAllergies ? html`<div class="allergy none">${t('kit.nka', 'No known allergies')}</div>` : html`<div class="allergy"><span class="allergy-unknown">${icon('alert')}${t('kit.allergy_unknown', 'Allergies not recorded. Ask the patient.')}</span></div>`);
    const yrs = p.age != null ? p.age : age(p.dob);
    let ageLabel = yrs != null ? html`<b>${yrs}</b> ${t('kit.yrs', 'yrs')}` : '';
    if (p.dob && (yrs == null || yrs < 2)) { const mo = Math.max(0, Math.floor((Date.now() - Date.parse(p.dob + 'T00:00:00Z')) / (30.44 * 86400e3))); ageLabel = mo < 1 ? html`<b>${Math.max(0, Math.floor((Date.now() - Date.parse(p.dob + 'T00:00:00Z')) / 86400e3))}</b> ${t('kit.days', 'days')}` : html`<b>${mo}</b> ${t('kit.months', 'months')}`; }
    return html`<section class="wristband ${sev}" aria-label="Patient">
      <span class="who">${p.name || ((p.firstName || '') + ' ' + (p.lastName || ''))}</span>
      <span class="meta">${ageLabel} ${p.sex && p.sex !== 'unknown' ? t('kit.sex.' + p.sex, cap(p.sex)) : ''}${p.mrn ? html` <span class="muted">|</span> ${t('kit.mrn', 'MRN')} <b>${p.mrn}</b>` : ''}${p.bloodGroup ? html` <span class="muted">|</span> ${t('kit.blood', 'Blood')} <b>${p.bloodGroup}</b>` : ''}${p.genotype ? html` <span class="muted">|</span> ${t('kit.genotype', 'Genotype')} <b>${p.genotype}</b>` : ''}${p.weightKg ? html` <span class="muted">|</span> <b>${p.weightKg}</b> kg` : ''}</span>
      ${allergyLine}</section>`;
  }
  function alerts(list) {
    if (!list || !list.length) return '';
    const ic = { contraindicated: 'stop', major: 'alert', moderate: 'alert', info: 'shield' };
    const lbl = { contraindicated: t('kit.alert.ci', 'Do not give'), major: t('kit.alert.major', 'Serious'), moderate: t('kit.alert.mod', 'Caution'), info: t('kit.alert.info', 'Note') };
    return html`<div class="alerts" role="alert">${list.map(a => html`<div class="alert ${a.level}">${icon(ic[a.level])}<div><b>${lbl[a.level]}${a.drug ? ': ' + a.drug : ''}</b>${a.message}</div></div>`)}</div>`;
  }
  function steps(all, current, labels) {
    const i = all.indexOf(current);
    return html`<ol class="steps">${all.map((s, k) => html`<li class="${k < i ? 'done' : k === i ? 'now' : ''}">${(labels && labels[s]) || cap(s)}</li>`)}</ol>`;
  }
  function figures(items) { return html`<div class="figures">${items.map(x => html`<div class="${x.tone || ''}"><b>${x.value}</b><span>${x.label}</span></div>`)}</div>`; }

  /* ---------------- toasts and dialogs ---------------- */
  let toastBox = null;
  function toast(msg, kind, ms) {
    if (!toastBox) { toastBox = document.createElement('div'); toastBox.className = 'toasts'; toastBox.setAttribute('role', 'status'); toastBox.setAttribute('aria-live', 'polite'); document.body.appendChild(toastBox); }
    const t = document.createElement('div'); t.className = 'toast ' + (kind || ''); t.textContent = msg; toastBox.appendChild(t);
    setTimeout(() => t.remove(), ms || (kind === 'bad' ? 6000 : 3500));
  }
  const showError = e => toast(e && e.message ? e.message : t('kit.err.generic', 'Something went wrong'), 'bad');

  /**
   * dialog({ title, body, actions:[{label, value, primary, danger}], wide, form:true })
   * Resolves with the clicked action's value (or form data object when form:true and the primary submits), or null on cancel.
   * onSubmit(data) may return false to keep it open, or throw to show the error inside the dialog.
   */
  function dialog({ title, body, actions, wide, form, onSubmit, onOpen }) {
    return new Promise(resolve => {
      const d = document.createElement('dialog'); d.className = 'dlg' + (wide ? ' wide' : '');
      d.setAttribute('aria-labelledby', 'dlg-t');
      const acts = actions || [{ label: t('kit.close', 'Close'), value: null }];
      d.innerHTML = String(html`<form method="dialog" class="dlg-form" novalidate>
        <div class="dlg-head"><h2 id="dlg-t">${title || ''}</h2><button type="button" class="icon-btn" data-dlg-close aria-label="${t('kit.close', 'Close')}">${icon('x')}</button></div>
        <div class="dlg-body">${body || ''}<div class="dlg-err notice bad" hidden></div></div>
        <div class="dlg-foot">${acts.map((a, i) => html`<button type="${a.primary && form ? 'submit' : 'button'}" class="btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}" data-dlg-i="${i}">${a.label}</button>`)}</div></form>`);
      document.body.appendChild(d);
      const f = d.querySelector('form'); const errBox = d.querySelector('.dlg-err');
      const done = v => { d.close(); d.remove(); resolve(v); };
      d.addEventListener('cancel', e => { e.preventDefault(); done(null); });
      d.querySelector('[data-dlg-close]').addEventListener('click', () => done(null));
      d.querySelectorAll('[data-dlg-i]').forEach(b => b.addEventListener('click', async e => {
        const a = acts[Number(b.dataset.dlgI)];
        if (a.primary && form) return; // handled by submit
        e.preventDefault(); done(a.value === undefined ? a.label : a.value);
      }));
      f.addEventListener('submit', async e => {
        e.preventDefault();
        if (!form) return;
        const data = formData(f); const btn = f.querySelector('button[type=submit]');
        errBox.hidden = true; clearFieldErrors(f);
        if (onSubmit) {
          btn.setAttribute('aria-busy', 'true'); btn.disabled = true;
          try { const r = await onSubmit(data, f); if (r === false) { btn.removeAttribute('aria-busy'); btn.disabled = false; return; } done(r === undefined ? data : r); }
          catch (err) { btn.removeAttribute('aria-busy'); btn.disabled = false; showFieldErrors(f, err); errBox.textContent = err.message || t('kit.err.generic', 'Something went wrong'); errBox.hidden = false; }
        } else done(data);
      });
      d.showModal();
      const first = d.querySelector('input,select,textarea'); if (first) first.focus();
      if (onOpen) onOpen(d);
    });
  }
  const confirm = ({ title, body, ok, danger, cancel }) => dialog({ title, body: html`<p>${body || ''}</p>`, actions: [{ label: cancel || t('kit.cancel', 'Cancel'), value: false }, { label: ok || t('kit.confirm', 'Confirm'), value: true, danger: !!danger, primary: !danger }] }).then(v => v === true);

  /* ---------------- forms ---------------- */
  function formData(f) {
    const o = {};
    for (const el of f.elements) {
      if (!el.name || el.disabled) continue;
      if (el.type === 'checkbox') { if ('list' in el.dataset) { (o[el.name] = o[el.name] || []); if (el.checked) o[el.name].push(el.value); } else o[el.name] = el.checked; continue; }
      if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; continue; }
      let v = el.value; if (el.type === 'number') v = v === '' ? undefined : Number(v);
      if (v === '') v = undefined;
      if (el.dataset.kobo !== undefined && v !== undefined) v = Math.round(Number(v) * 100);
      o[el.name] = v;
    }
    return o;
  }
  function clearFieldErrors(f) { f.querySelectorAll('.err[data-auto]').forEach(e => e.remove()); f.querySelectorAll('[aria-invalid]').forEach(e => e.removeAttribute('aria-invalid')); }
  function showFieldErrors(f, err) {
    if (!err || !err.details) return;
    for (const d of err.details) {
      const name = String(d.field || '').split(/[.[]/)[0]; const el = f.querySelector('[name="' + CSS.escape(name) + '"]');
      if (!el) continue; el.setAttribute('aria-invalid', 'true');
      const box = el.closest('.field') || el.parentElement; const m = document.createElement('div'); m.className = 'err'; m.dataset.auto = '1'; m.textContent = d.error; box.appendChild(m);
    }
  }
  const actions = {}; const forms = {};
  const on = (name, fn) => { actions[name] = fn; };
  const form = (name, fn) => { forms[name] = fn; };
  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-action]'); if (!el || el.closest('dialog') && !actions[el.dataset.action]) return;
    const fn = actions[el.dataset.action]; if (!fn) return;
    e.preventDefault();
    if (el.getAttribute('aria-busy') === 'true') return;
    const isBtn = el.tagName === 'BUTTON';
    if (isBtn) { el.setAttribute('aria-busy', 'true'); el.disabled = true; }
    try { await fn(el, e); } catch (err) { showError(err); } finally { if (isBtn && el.isConnected) { el.removeAttribute('aria-busy'); el.disabled = false; } }
  });
  document.addEventListener('submit', async e => {
    const f = e.target.closest('form[data-form]'); if (!f) return;
    e.preventDefault();
    const fn = forms[f.dataset.form]; if (!fn) return;
    const btn = f.querySelector('button[type=submit], button:not([type])');
    if (btn && btn.getAttribute('aria-busy') === 'true') return;
    clearFieldErrors(f); const errBox = f.querySelector('.form-err'); if (errBox) errBox.hidden = true;
    if (btn) { btn.setAttribute('aria-busy', 'true'); btn.disabled = true; }
    try { await fn(formData(f), f); }
    catch (err) { showFieldErrors(f, err); if (errBox) { errBox.textContent = err.message; errBox.hidden = false; } else showError(err); }
    finally { if (btn && btn.isConnected) { btn.removeAttribute('aria-busy'); btn.disabled = false; } }
  });

  /* ---------------- view + router ---------------- */
  let mainEl = null;
  function view(content, target) { const el = target || mainEl || document.getElementById('main'); el.innerHTML = String(content); const h = el.querySelector('h1'); if (h && !target) { h.setAttribute('tabindex', '-1'); } return el; }
  const routes = []; let current = null; let me = null; let routeToken = 0; const cleanups = [];
  function route(pattern, fn) { const keys = []; const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/?]+)'; }) + '$'); routes.push({ pattern, re, keys, fn }); }
  function parseHash() { const h = location.hash || ''; const [path, q] = h.split('?'); const query = {}; new URLSearchParams(q || '').forEach((v, k) => { query[k] = v; }); return { path: path || '', query }; }
  const go = p => { if (location.hash === p) render(); else location.hash = p; };
  const onLeave = fn => cleanups.push(fn);
  async function render() {
    while (cleanups.length) { try { cleanups.pop()(); } catch (e) { } }
    document.querySelectorAll('dialog.dlg').forEach(d => d.dispatchEvent(new Event('cancel')));  // leaving a page closes its dialogs
    const { path, query } = parseHash();
    const r = routes.find(x => x.re.test(path)) || routes.find(x => x.pattern === boot.home);
    if (!r) return;
    const m = path.match(r.re) || []; const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1] || ''); });
    current = r.pattern; const token = ++routeToken;
    document.querySelectorAll('[data-nav]').forEach(a => { const hit = path === a.getAttribute('href') || (a.getAttribute('href') !== boot.home && path.startsWith(a.getAttribute('href') + '/')); if (hit) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    view(skeleton(4));
    try { await r.fn({ params, query, me, el: mainEl, stale: () => token !== routeToken }); }
    catch (e) { if (token !== routeToken) return; if (e.status === 401) return; view(html`<div class="empty">${icon('alert')}<b>${t('kit.load_failed', 'Could not load this page')}</b><p class="sm">${e.message}</p><button class="btn" data-action="mc-reload">${icon('refresh')}${t('kit.try_again', 'Try again')}</button></div>`); }
    if (token === routeToken) { const h = mainEl.querySelector('h1'); if (h && document.activeElement === document.body) h.focus({ preventScroll: true }); window.scrollTo(0, 0); }
  }
  on('mc-reload', () => render());

  /* ---------------- polling ---------------- */
  function poll(fn, ms) {
    let stopped = false, t = null, fails = 0;
    const tick = async () => { if (stopped) return; if (document.hidden) { t = setTimeout(tick, ms); return; } try { await fn(); fails = 0; } catch (e) { fails++; } if (!stopped) t = setTimeout(tick, Math.min(ms * Math.pow(2, fails), 60000)); };
    t = setTimeout(tick, ms);
    const stop = () => { stopped = true; clearTimeout(t); }; onLeave(stop); return stop;
  }

  /* ---------------- geolocation ---------------- */
  function position(timeoutMs = 8000) {
    return new Promise(res => {
      if (!navigator.geolocation) return res(null);
      navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) }), () => res(null), { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 });
    });
  }
  /** watch GPS and call fn at most every minMs. Returns stop(). */
  function watchPosition(fn, minMs = 10000, onError) {
    if (!navigator.geolocation) { if (onError) onError({ code: 'unsupported' }); return () => { }; }
    let last = 0;
    const id = navigator.geolocation.watchPosition(p => { const now = Date.now(); if (now - last < minMs) return; last = now; fn({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy), speed: p.coords.speed, heading: p.coords.heading }); }, err => { if (onError) onError({ code: err && err.code === 1 ? 'denied' : err && err.code === 3 ? 'timeout' : 'unavailable' }); }, { enableHighAccuracy: true, maximumAge: 5000 });
    const stop = () => navigator.geolocation.clearWatch(id); return stop;
  }

  /* ---------------- maps (Leaflet, loaded on demand) ---------------- */
  let leafletP = null; let mapCfg = null;
  function loadLeaflet() {
    if (leafletP) return leafletP;
    leafletP = new Promise((res, rej) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/vendor/leaflet/leaflet.css'; document.head.appendChild(l); const s = document.createElement('script'); s.src = '/vendor/leaflet/leaflet.js'; s.onload = () => res(window.L); s.onerror = () => rej(new Error('Map could not load')); document.head.appendChild(s); });
    return leafletP;
  }
  /**
   * map(el, { center:{lat,lng}, zoom }) -> { setMarker(key, {lat,lng}, {label, kind}), remove(key), fit(), line(key, points) }
   * Falls back to a plain text panel when tiles cannot load (offline).
   */
  async function map(el, { center, zoom } = {}) {
    if (!mapCfg) { try { mapCfg = await api.get('/api/meta/map'); } catch (e) { mapCfg = { tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors' }; } }
    const L = await loadLeaflet();
    let gone = false; // the page may have moved on while the map library loaded
    const m = L.map(el, { zoomControl: true, attributionControl: true }).setView([center ? center.lat : 6.5244, center ? center.lng : 3.3792], zoom || 13);
    L.tileLayer(mapCfg.tileUrl, { maxZoom: 19, attribution: mapCfg.attribution }).addTo(m);
    const markers = {}; const lines = {};
    const colors = { unit: '#B42D27', patient: '#0F6B6E', rider: '#9A5B00', hospital: '#3D4FA6', me: '#1F5FA8' };
    const api2 = {
      leaflet: m,
      setMarker(key, pos, o = {}) {
        if (gone || !pos || pos.lat == null) return;
        const ll = [pos.lat, pos.lng];
        if (markers[key]) { markers[key].setLatLng(ll); if (o.label) markers[key].setTooltipContent(esc(o.label)); return; }
        markers[key] = L.circleMarker(ll, { radius: o.kind === 'unit' || o.kind === 'rider' ? 9 : 7, color: o.stale ? (o.color || colors[o.kind] || '#3C5457') : '#fff', weight: 2, fillColor: o.color || colors[o.kind] || '#3C5457', fillOpacity: o.stale ? 0.15 : 1 }).addTo(m);
        if (o.label) markers[key].bindTooltip(esc(o.label), { permanent: !!o.permanent, direction: 'top' });
      },
      remove(key) { if (markers[key]) { m.removeLayer(markers[key]); delete markers[key]; } },
      line(key, pts) { if (gone) return; if (lines[key]) m.removeLayer(lines[key]); if (pts && pts.length > 1) lines[key] = L.polyline(pts.map(p => [p.lat, p.lng]), { color: '#0F6B6E', weight: 4, opacity: .7 }).addTo(m); },
      fit() { if (gone || !el.isConnected) return; const all = Object.values(markers).map(x => x.getLatLng()); if (all.length > 1) m.fitBounds(L.latLngBounds(all).pad(0.25)); else if (all.length === 1) m.setView(all[0], 15); },
      destroy() { if (gone) return; gone = true; try { m.remove(); } catch (e) { /* already removed */ } },
    };
    onLeave(() => api2.destroy());
    setTimeout(() => { if (!gone && el.isConnected) m.invalidateSize(); }, 50);
    return api2;
  }

  /* ---------------- auth screens ---------------- */
  const APP_META = {
    patient: { name: 'MediCore', icon: 'patient' }, frontdesk: { name: 'MediCore Front Desk', icon: 'frontoffice' }, doctor: { name: 'MediCore Doctor', icon: 'doctor' },
    pharmacy: { name: 'MediCore Pharmacy', icon: 'pharmacy' }, rider: { name: 'MediCore Rider', icon: 'rider' }, dispatch: { name: 'MediCore Dispatch', icon: 'dispatch' }, crew: { name: 'MediCore Crew', icon: 'crew' },
    lab: { name: 'MediCore Lab', icon: 'lab' }, chw: { name: 'MediCore Community', icon: 'chw' }, payer: { name: 'MediCore HMO', icon: 'payer' }, admin: { name: 'MediCore Admin', icon: 'admin' }, group: { name: 'MediCore Group', icon: 'group' }, hq: { name: 'MediCore HQ', icon: 'hq' }, register: { name: 'MediCore', icon: 'patient' },
  };
  const meta = APP_META[APP] || APP_META.patient;
  function authScreen(content) { document.body.classList.add('no-nav'); document.getElementById('app').innerHTML = String(html`<div class="band"></div><main class="auth" id="main"><div class="box"><div class="head"><img src="/icons/${meta.icon}-192.png" alt=""><div><h1>${meta.name}</h1><p>${late(boot.subtitle) || ''}</p></div></div>${content}</div></main>`); }
  function langPicker() { const opts = langOptions(); if (opts.length < 2) return ''; return html`<div class="field"><label for="mc-lang">${t('kit.language', 'Language')}</label><select class="input" id="mc-lang" data-lang-select>${opts.map(o => html`<option value="${o.key}" ${o.key === lang ? 'selected' : ''}>${o.label}</option>`)}</select></div>`; }
  document.addEventListener('change', e => { if (e.target && e.target.matches('[data-lang-select]')) setLang(e.target.value, { save: true }); });
  function loginScreen(msg) {
    authScreen(html`<div class="panel"><form data-form="mc-login" novalidate>
      ${msg ? html`<div class="notice warn">${msg}</div>` : ''}
      <h2>${t('kit.signin', 'Sign in')}</h2>
      <div class="field"><label for="li-id">${t('kit.identifier', 'Email or phone number')}</label><input class="input" id="li-id" name="identifier" autocomplete="username" inputmode="email" required></div>
      <div class="field"><label for="li-pw">${t('kit.password', 'Password')}</label><input class="input" id="li-pw" name="password" type="password" autocomplete="current-password" required></div>
      <div class="form-err notice bad" hidden></div>
      <button class="btn primary block lg" type="submit">${t('kit.signin', 'Sign in')}</button>
      <div class="btn-row"><button type="button" class="btn ghost" data-action="mc-forgot">${t('kit.forgot', 'Forgot password?')}</button></div>
    </form>${langPicker()}</div>${boot.loginFooter ? (typeof boot.loginFooter === 'function' ? boot.loginFooter() : boot.loginFooter) : ''}`);
    setTimeout(() => { const i = document.getElementById('li-id'); if (i) i.focus(); }, 30);
  }
  form('mc-login', async (d) => {
    if (!d.identifier || !d.password) throw new ApiError(400, { error: t('kit.need_login', 'Enter your email or phone and your password') });
    const r = await api.post('/api/auth/login', { identifier: d.identifier, password: d.password, orgId: d.orgId });
    if (r.chooseOrg) {
      authScreen(html`<div class="panel"><h2>${t('kit.choose_org', 'Choose where you are working')}</h2><p class="muted">${t('kit.choose_org_sub', 'Your account is linked to more than one provider.')}</p><div class="choice">${r.chooseOrg.map(o => html`<button data-action="mc-pick-org" data-org="${o.orgId}"><span><b>${o.orgName}</b><br><span class="muted sm">${o.roleLabel}</span></span>${icon('right')}</button>`)}</div></div>`);
      on('mc-pick-org', async el => { await api.post('/api/auth/login', { identifier: d.identifier, password: d.password, orgId: el.dataset.org }); start(); });
      return;
    }
    start();
  });
  on('mc-forgot', async () => {
    const id1 = await dialog({ title: t('kit.reset_title', 'Reset your password'), form: true, body: html`<p class="muted">${t('kit.reset_sub', 'We will send a 6-digit code by SMS to the phone number on your account.')}</p><div class="field"><label for="fp-id">${t('kit.identifier', 'Email or phone number')}</label><input class="input" id="fp-id" name="identifier" required></div>`, actions: [{ label: t('kit.cancel', 'Cancel'), value: null }, { label: t('kit.send_code', 'Send code'), primary: true }],
      onSubmit: async d => { const r = await api.post('/api/auth/reset/start', { identifier: d.identifier }); return { identifier: d.identifier, devCode: r.devCode }; } });
    if (!id1) return;
    const ok = await dialog({ title: t('kit.enter_code', 'Enter the code'), form: true, body: html`${id1.devCode ? html`<div class="notice">${t('kit.demo_code', 'Demo mode: your code is')} <b>${id1.devCode}</b></div>` : ''}<div class="field"><label for="fp-c">${t('kit.code6', '6-digit code')}</label><input class="input" id="fp-c" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div><div class="field"><label for="fp-p">${t('kit.new_password', 'New password')}</label><input class="input" id="fp-p" name="password" type="password" autocomplete="new-password" required><div class="hint">${t('kit.pw_rule', 'At least 8 characters, with letters and numbers.')}</div></div>`,
      actions: [{ label: t('kit.cancel', 'Cancel'), value: null }, { label: t('kit.set_password', 'Set new password'), primary: true }], onSubmit: d => api.post('/api/auth/reset/finish', { identifier: id1.identifier, code: d.code, password: d.password }) });
    if (ok) toast(t('kit.pw_changed_signin', 'Password changed. Sign in with your new password.'), 'ok');
  });
  function changePasswordScreen() {
    authScreen(html`<div class="panel"><form data-form="mc-newpw" novalidate><h2>${t('kit.own_pw', 'Set your own password')}</h2><p class="muted">${t('kit.own_pw_sub', 'You signed in with a temporary password. Choose a new one to continue.')}</p>
      <div class="field"><label for="np-c">${t('kit.temp_pw', 'Temporary password')}</label><input class="input" id="np-c" name="current" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="np-n">${t('kit.new_password', 'New password')}</label><input class="input" id="np-n" name="next" type="password" autocomplete="new-password" required><div class="hint">${t('kit.pw_rule', 'At least 8 characters, with letters and numbers.')}</div></div>
      <div class="form-err notice bad" hidden></div><button class="btn primary block lg" type="submit">${t('kit.save_continue', 'Save and continue')}</button></form></div>`);
  }
  form('mc-newpw', async d => { await api.post('/api/auth/password', d); toast(t('kit.pw_saved', 'Password saved'), 'ok'); start(); });

  /* ---------------- shell ---------------- */
  function navAllowed(n) { if (n.show && !n.show(me)) return false; if (n.perm && !(me.perms || []).includes(n.perm)) return false; if (n.anyPerm && !n.anyPerm.some(p => (me.perms || []).includes(p))) return false; if (n.module && !(me.org && (me.org.modules || []).includes(n.module))) return false; return true; }
  function shell() {
    document.body.classList.remove('no-nav');
    const nav = (boot.nav || []).filter(navAllowed);
    // phones: up to five tabs; more items go behind a "More" tab so nothing becomes unreachable
    const tabbable = nav.filter(n => !n.sideOnly);
    const tab = tabbable.length > 5 ? tabbable.slice(0, 4).concat([{ href: '#', more: true, icon: 'more', label: t('kit.more', 'More') }]) : tabbable;
    moreItems = tabbable.length > 5 ? tabbable.slice(4) : [];
    const orgName = me.org ? me.org.name : (me.kind === 'platform' ? 'Platform' : '');
    document.getElementById('app').innerHTML = String(html`<div class="band"></div>
      <header class="topbar"><a class="brand" href="${boot.home}"><img src="/icons/${meta.icon}-192.png" alt=""><span>${late(boot.title) || meta.name}</span></a><span class="org">${orgName}</span><span class="spacer"></span>
        <span id="mc-shift"></span><button class="icon-btn" data-action="mc-notes" aria-label="${t('kit.notifications', 'Notifications')}">${icon('bell')}<span class="dot" id="mc-note-dot" hidden></span></button><button class="icon-btn" data-action="mc-menu" aria-label="${t('kit.account', 'Account menu')}">${icon('user')}</button></header>
      <div class="layout"><nav class="side" aria-label="Main">${nav.map(n => html`${n.group ? html`<div class="group">${n.group}</div>` : ''}<a href="${n.href}" data-nav>${icon(n.icon)}<span>${late(n.label)}</span><span class="count" data-count="${n.href}" hidden></span></a>`)}</nav>
      <main class="main" id="main" tabindex="-1"></main></div>
      <nav class="tabbar" aria-label="Main">${tab.map(n => n.more ? html`<a href="#" data-action="mc-more" role="button">${icon(n.icon)}<span>${n.label}</span></a>` : html`<a href="${n.href}" data-nav>${icon(n.icon)}<span>${late(n.short || n.label)}</span><span class="count" data-count="${n.href}" hidden></span></a>`)}</nav>`);
    mainEl = document.getElementById('main');
    renderShift();
    refreshNotes();
  }
  /** set a nav badge count: MC.navCount('#/queue', 3) */
  function navCount(href, n) { document.querySelectorAll('[data-count="' + CSS.escape(href) + '"]').forEach(el => { el.textContent = n > 99 ? '99+' : String(n || ''); el.hidden = !n; }); }

  let shiftState = null;
  async function renderShift() {
    const box = document.getElementById('mc-shift'); if (!box || !me || !me.clocks) return;
    try { shiftState = await api.get('/api/shift/me'); } catch (e) { return; }
    const on1 = !!shiftState.open;
    box.innerHTML = String(html`<button class="shift-chip ${on1 ? 'on' : ''}" data-action="mc-shift">${on1 ? t('kit.on_shift', 'On shift') + ' ' + mins(shiftState.open.in) : t('kit.clock_in', 'Clock in')}</button>`);
  }
  async function clockIn() {
    toast(t('kit.getting_location', 'Getting your location...'));
    const pos = await position();
    try { await api.post('/api/shift/clock-in', pos ? { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracyM } : {}); toast(pos ? t('kit.clocked_in', 'Clocked in') : t('kit.clocked_in_noloc', 'Clocked in without location'), 'ok'); }
    catch (e) { showError(e); }
    await renderShift(); emit('shift:changed', shiftState);
  }
  on('mc-shift', async () => {
    if (shiftState && shiftState.open) {
      if (!(await confirm({ title: t('kit.clock_out_q', 'Clock out?'), body: t('kit.clock_out_body', 'You will not be able to work on cases until you clock in again.'), ok: t('kit.clock_out', 'Clock out') }))) return;
      const pos = await position(4000); await api.post('/api/shift/clock-out', pos ? { lat: pos.lat, lng: pos.lng } : {}); toast(t('kit.clocked_out', 'Clocked out'), 'ok'); await renderShift(); emit('shift:changed', shiftState);
    } else await clockIn();
  });
  onEvent('shift:required', async () => { if (await confirm({ title: t('kit.clock_in_continue', 'Clock in to continue'), body: t('kit.clock_in_need', 'You need to be on shift to do this.'), ok: t('kit.clock_in_now', 'Clock in now') })) await clockIn(); });
  async function refreshNotes() {
    try { const path = me.kind === 'patient' ? '/api/me/notifications' : me.kind === 'staff' ? '/api/notifications' : null; if (!path) return; const n = await api.get(path); const unread = (n || []).filter(x => !x.read).length; const dot = document.getElementById('mc-note-dot'); if (dot) dot.hidden = !unread; return n; } catch (e) { return []; }
  }
  on('mc-notes', async () => {
    const n = (await refreshNotes()) || [];
    await dialog({ title: t('kit.notifications', 'Notifications'), body: n.length ? html`<ul class="list">${n.slice(0, 30).map(x => html`<li><div class="grow"><span class="title">${x.title}</span><span class="sub">${x.body}</span></div><span class="end xs muted">${ago(x.at)}</span></li>`)}</ul>` : empty({ icon: 'bell', title: t('kit.no_notifications', 'No notifications') }) });
    try { await api.post(me.kind === 'patient' ? '/api/me/notifications/read' : '/api/notifications/read'); } catch (e) { } refreshNotes();
  });
  let moreItems = [];
  on('mc-more', async (el, e) => {
    if (e && e.preventDefault) e.preventDefault();
    const v = await dialog({ title: t('kit.more', 'More'), body: '', actions: moreItems.map(n => ({ label: late(n.label), value: n.href })).concat([{ label: t('kit.close', 'Close'), value: '' }]) });
    if (v) location.hash = v;
  });
  on('mc-menu', async () => {
    const items = [];
    if (me.otherOrgs && me.otherOrgs.length) items.push({ label: t('kit.switch_org', 'Switch provider'), value: 'switch' });
    if (langOptions().length > 1) items.push({ label: t('kit.language', 'Language'), value: 'lang' });
    items.push({ label: t('kit.change_pw', 'Change password'), value: 'pw' }, { label: document.documentElement.dataset.theme === 'dark' ? t('kit.light', 'Light theme') : t('kit.dark', 'Dark theme'), value: 'theme' }, { label: t('kit.signout', 'Sign out'), value: 'out', primary: true });
    const who = me.user ? me.user.name : '';
    const v = await dialog({ title: who, body: html`<p class="muted">${me.roleLabel || (me.kind === 'patient' ? t('kit.patient', 'Patient') : me.platformRole || '')}${me.org ? ' | ' + me.org.name : ''}</p>`, actions: items });
    if (v === 'out') { if (boot.beforeSignOut && (await boot.beforeSignOut()) === false) return; try { await api.post('/api/auth/logout'); } catch (e) { } try { localStorage.removeItem('mc-me-' + APP); } catch (e) { } location.hash = ''; start(); }
    if (v === 'theme') { const th = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = th; try { localStorage.setItem('mc-theme', th); } catch (e) { } }
    if (v === 'lang') { const l = await dialog({ title: t('kit.language', 'Language'), body: html`<div class="choice">${langOptions().map(o => html`<button type="button" data-dlg-lang="${o.key}"><span>${o.label}</span>${o.key === lang ? icon('check') : ''}</button>`)}</div>`, actions: [{ label: t('kit.cancel', 'Cancel'), value: null }], onOpen: d => d.querySelectorAll('[data-dlg-lang]').forEach(b => b.addEventListener('click', () => { const k = b.dataset.dlgLang; d.close(); d.remove(); setLang(k, { save: true }); })) }); void l; }
    if (v === 'pw') { const ok = await dialog({ title: t('kit.change_pw', 'Change password'), form: true, body: html`<div class="field"><label for="cp-c">${t('kit.current_pw', 'Current password')}</label><input class="input" id="cp-c" name="current" type="password" autocomplete="current-password" required></div><div class="field"><label for="cp-n">${t('kit.new_password', 'New password')}</label><input class="input" id="cp-n" name="next" type="password" autocomplete="new-password" required><div class="hint">${t('kit.pw_rule', 'At least 8 characters, with letters and numbers.')}</div></div>`, actions: [{ label: t('kit.cancel', 'Cancel'), value: null }, { label: t('kit.change_pw', 'Change password'), primary: true }], onSubmit: d => api.post('/api/auth/password', d) }); if (ok) toast(t('kit.pw_changed', 'Password changed'), 'ok'); }
    if (v === 'switch') { await dialog({ title: t('kit.switch_org', 'Switch provider'), body: html`<div class="choice">${me.otherOrgs.map(x => html`<button type="button" data-dlg-org="${x.orgId}">${x.orgName}${icon('right')}</button>`)}</div>`, actions: [{ label: t('kit.cancel', 'Cancel'), value: null }], onOpen: d => d.querySelectorAll('[data-dlg-org]').forEach(b => b.addEventListener('click', async () => { await api.post('/api/auth/switch-org', { orgId: b.dataset.dlgOrg }); d.close(); d.remove(); start(); })) }); }
  });

  /* ---------------- boot ---------------- */
  function applyTheme() { try { const t = localStorage.getItem('mc-theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) { } }
  function offlineBar() { const sync = () => { let b = document.getElementById('mc-offline'); if (!navigator.onLine) { if (!b) { b = document.createElement('div'); b.id = 'mc-offline'; b.className = 'offline-bar'; b.textContent = boot.offlineText ? (typeof boot.offlineText === 'function' ? boot.offlineText() : boot.offlineText) : t('kit.offline_bar', 'You are offline. Changes will not be saved until you reconnect.'); document.body.appendChild(b); } } else if (b) b.remove(); }; window.addEventListener('online', () => { sync(); if (me) { renderShift(); refreshNotes(); } emit('online'); }); window.addEventListener('offline', sync); sync(); }
  async function start() {
    const { path } = parseHash();
    const pub = (boot.publicRoutes || []).find(p => new RegExp('^' + p.replace(/\/:(\w+)/g, '/([^/?]+)') + '$').test(path));
    try { me = await api.get('/api/auth/me'); try { localStorage.setItem('mc-me-' + APP, JSON.stringify(me)); } catch (e2) { } }
    catch (e) {
      // offline start: reuse the last profile seen on this device (no tokens are stored; the cookie still guards the API)
      if (e.status === 0) { let cached = null; try { cached = JSON.parse(localStorage.getItem('mc-me-' + APP) || 'null'); } catch (e3) { cached = null; } if (cached) { me = cached; MC.me = me; MC.offlineStart = true; shell(); if (boot.onReady) await boot.onReady(me); return render(); } }
      me = null;
      if (pub || boot.anonymous) { document.body.classList.add('no-nav'); document.getElementById('app').innerHTML = '<div class="band"></div><main class="main" id="main"></main>'; mainEl = document.getElementById('main'); return render(); }
      if (e.status === 423 && e.code === 'password_change_required') return changePasswordScreen();
      return loginScreen(e.status === 401 && e.code && e.code !== 'unauthorized' && e.code !== 'expired' ? e.message : null);
    }
    if (me.user && me.user.mustChangePassword) return changePasswordScreen();
    MC.me = me;
    // language: a choice made on this device wins and is saved to the patient's profile (SMS then follow it);
    // with no device choice, the profile language is used
    if (me.kind === 'patient' && me.patient) {
      let local = null; try { local = localStorage.getItem('mc-lang'); } catch (e) { }
      if (local && LANGS[local] && local !== me.patient.lang) { api.patch('/api/me/profile', { lang: local }).catch(() => { }); }
      else if (!local && me.patient.lang && me.patient.lang !== lang && LANGS[me.patient.lang]) { try { localStorage.setItem('mc-lang', me.patient.lang); } catch (e) { } await loadLang(me.patient.lang); }
    }
    shell();
    if (boot.onReady) await boot.onReady(me);
    render();
  }
  onEvent('auth:required', e => { if (me) { me = null; loginScreen(e.message); } });
  onEvent('auth:password', () => changePasswordScreen());
  window.addEventListener('hashchange', () => { if (me || boot.anonymous) render(); else { const { path } = parseHash(); if ((boot.publicRoutes || []).some(p => new RegExp('^' + p.replace(/\/:(\w+)/g, '/([^/?]+)') + '$').test(path))) render(); } });

  /* platform config from HQ: branding, texts, features. Cached for offline starts. */
  let cfg = null;
  async function loadConfig() {
    try { cfg = await api.get('/api/meta/config?app=' + encodeURIComponent(APP)); try { localStorage.setItem('mc-cfg-' + APP, JSON.stringify(cfg)); } catch (e) { } }
    catch (e) { try { cfg = JSON.parse(localStorage.getItem('mc-cfg-' + APP) || 'null'); } catch (e2) { cfg = null; } }
    cfg = cfg || { branding: { app: {} }, content: {}, features: {} };
    const a = cfg.branding.app || {};
    if (a.hue && /^#[0-9a-fA-F]{6}$/.test(a.hue)) { document.body.style.setProperty('--hue', a.hue); document.body.style.setProperty('--hue-soft', 'color-mix(in srgb, ' + a.hue + ' 12%, white)'); }
    if (a.title) { boot.title = a.title; document.title = a.title; }
    overrides = (cfg.content && cfg.content.i18n) || {};
    if (cfg.features && Array.isArray(cfg.features.languages)) enabledLangs = ['en'].concat(cfg.features.languages.filter(l => l !== 'en'));
    if (cfg.branding.defaultTheme && cfg.branding.defaultTheme !== 'system') { try { if (!localStorage.getItem('mc-theme')) document.documentElement.dataset.theme = cfg.branding.defaultTheme; } catch (e) { } }
    if (!boot.subtitle && cfg.content.loginSubtitle) boot.subtitle = cfg.content.loginSubtitle;
  }
  /** a text from HQ content (per app), in the user's language when translated */
  const content = (key, fallback) => { const k = 'content.' + APP + '.' + key; const base = (cfg && cfg.content && cfg.content[key]) || fallback || ''; const v = t(k, base); return v === k ? base : String(v); };
  const feature = name => !!(cfg && cfg.features && cfg.features[name]);
  const config = () => cfg;

  async function boot(opts) {
    Object.assign(boot, opts);
    Object.entries(opts.routes || {}).forEach(([p, fn]) => route(p, fn));
    applyTheme(); offlineBar();
    await loadLang(pickLang());
    await loadConfig();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => { });
    start();
  }

  window.MC = { APP, html, raw, esc, icon, api, qs, ApiError, money, date, time, dateTime, day, ago, mins, age, cap, initials, todayISO, badge, statusBadge, empty, skeleton, wristband, alerts, steps, figures,
    toast, showError, dialog, confirm, on, form, t, setLang, get lang() { return lang; }, LANGS, langOptions, content, feature, config, formData, view, go, route, render, onLeave, poll, position, watchPosition, map, navCount, boot, refreshShift: renderShift, onEvent, emit, me: null };
})();
