/* MediCore patient app: one identity across every provider a person uses.
 * Home (SOS, next visit, orders, bills), find care and book, appointments and video visits,
 * medicines (send to a pharmacy, pickup or tracked delivery), lab results, emergency tracking,
 * health assistant, bills, messages, HMO cover, profile and privacy.
 * Built for low-end Android phones on costly data: small JSON calls, no images, maps only for tracking. */
(function () {
  'use strict';
  const { html, api, qs, money, date, dateTime, day, time, ago, cap, icon, badge, empty, view, on, form, dialog, confirm, toast } = MC;
  const T = MC.t;

  /* ---------------- a few patient-only styles (kit tokens only) ---------------- */
  (function styles() {
    const s = document.createElement('style');
    s.textContent = [
      '.side a[href="#/more"]{display:none}',
      '#main .wristband .allergy:has(.allergy-unknown){display:none}',
      '.pt-hello{font-size:var(--t-xl);margin:0}',
      '.sos{display:flex;align-items:center;justify-content:center;gap:14px;width:100%;min-height:96px;border:0;border-radius:var(--r-lg);background:var(--red);color:#fff;font:inherit;font-size:1.75rem;font-weight:700;cursor:pointer;margin:var(--s4) 0 var(--s2);text-decoration:none;text-align:left;padding:var(--s3) var(--s4)}',
      '.sos svg{width:40px;height:40px;flex:none}',
      '.sos small{display:block;font-size:var(--t-sm);font-weight:400;color:#fff}',
      '.sos.busy{background:var(--amber)}',
      '.sos[aria-busy="true"]{opacity:.7}',
      '.calls{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;margin-bottom:var(--s4)}',
      '.tiles{display:grid;grid-template-columns:1fr 1fr;gap:var(--s2);margin-bottom:var(--s4)}',
      '@media(min-width:720px){.tiles{grid-template-columns:repeat(4,1fr)}}',
      '.tile{display:flex;flex-direction:column;gap:6px;padding:var(--s3) var(--s4);min-height:80px;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);color:var(--ink);text-decoration:none;font-weight:700}',
      '.tile svg{width:24px;height:24px;color:var(--hue)}',
      '.tile:hover{border-color:var(--hue)}',
      '.sec{font-size:var(--t-lg);margin:var(--s5) 0 var(--s2)}',
      '.bigcode{font-size:2.5rem;font-weight:700;letter-spacing:.2em;text-align:center;padding:var(--s3) var(--s2);border:2px dashed var(--hue);border-radius:var(--r);background:var(--hue-soft);color:var(--ink);margin:var(--s2) 0 var(--s3);font-variant-numeric:tabular-nums}',
      '.days{display:flex;gap:var(--s2);overflow-x:auto;padding:2px 2px 6px;margin-bottom:var(--s3)}',
      '.pick{position:relative;flex:none;margin:0}',
      '.pick input{position:absolute;opacity:0;width:1px;height:1px}',
      '.pick span{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:70px;min-height:52px;padding:6px 10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);cursor:pointer;font-weight:700;text-align:center;line-height:1.2}',
      '.pick small{font-weight:400;color:var(--ink-3)}',
      '.pick input:checked+span{background:var(--hue);border-color:var(--hue);color:#fff}',
      '.pick input:checked+span small{color:#fff}',
      '.pick input:focus-visible+span{outline:3px solid color-mix(in srgb,var(--hue) 70%,white);outline-offset:2px}',
      '.pick input:disabled+span{opacity:.4;cursor:not-allowed}',
      '.slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:var(--s2);margin-bottom:var(--s4)}',
      '.slots .pick span{min-width:0}',
      '.field>label.opt{display:flex}',
      '.opt{display:flex;gap:var(--s3);align-items:flex-start;padding:var(--s3) var(--s4);border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);cursor:pointer;min-height:56px;margin-bottom:var(--s2)}',
      '.opt input{width:22px;height:22px;accent-color:var(--hue);margin-top:2px;flex:none}',
      '.opt:has(input:checked){border-color:var(--hue);box-shadow:0 0 0 1px var(--hue)}',
      '.opt:has(input:disabled){opacity:.55;cursor:not-allowed}',
      '.opt .grow{flex:1;min-width:0}.opt .title{font-weight:700;display:block}.opt .sub{display:block;color:var(--ink-3);font-size:var(--t-sm)}',
      '.chat{display:flex;flex-direction:column;gap:var(--s2);margin-bottom:var(--s3)}','.chat>*{scroll-margin-bottom:150px}',
      '.bub{max-width:88%;padding:10px 14px;border-radius:14px;overflow-wrap:anywhere;white-space:pre-wrap}',
      '.bub.me{align-self:flex-end;background:var(--hue-soft);border:1px solid color-mix(in srgb,var(--hue) 30%,transparent);border-bottom-right-radius:4px}',
      '.bub.them{align-self:flex-start;background:var(--surface);border:1px solid var(--line);border-bottom-left-radius:4px}',
      '.bub.urgent{border:2px solid var(--red);background:var(--red-soft)}',
      '.bub .who{display:block;font-size:var(--t-xs);color:var(--ink-3);margin-bottom:2px;white-space:normal}',
      '.bub .acts{display:flex;flex-wrap:wrap;gap:var(--s2);margin-top:var(--s2);white-space:normal}',
      '.bub .urgent-h{display:flex;gap:8px;align-items:center;color:var(--red);font-weight:700;margin-bottom:4px}.bub .urgent-h svg{width:20px;height:20px}',
      '.composer{position:sticky;bottom:calc(60px + env(safe-area-inset-bottom));background:var(--paper);padding:var(--s2) 0;display:flex;gap:var(--s2);align-items:flex-end;z-index:5}',
      '@media(min-width:960px){.composer{bottom:0}}',
      '.composer textarea.input{min-height:52px;height:52px;flex:1;resize:none}',
      '.chips{display:flex;flex-wrap:wrap;gap:var(--s2);margin-bottom:var(--s3)}',
      '.chip{border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:8px 14px;min-height:44px;font:inherit;color:var(--ink);cursor:pointer}',
      '.chip:hover{border-color:var(--hue)}',
      '.vstage{position:relative;background:#0b1416;border-radius:var(--r);overflow:hidden;aspect-ratio:3/4;max-height:68vh;margin-bottom:var(--s3);width:100%}',
      '@media(min-width:720px){.vstage{aspect-ratio:16/9}}',
      '.vstage video{display:block}',
      '.vstage #v-remote{width:100%;height:100%;object-fit:cover}',
      '.vstage #v-local{position:absolute;right:12px;bottom:12px;width:30%;max-width:180px;border-radius:8px;border:2px solid #fff;background:#1d2b2e}',
      '.vstage .vs{position:absolute;left:12px;top:12px;right:12px;color:#fff;font-size:var(--t-sm)}',
      '.vstage .vs span{background:rgba(0,0,0,.6);padding:4px 10px;border-radius:999px}',
      '.meter{height:8px;background:var(--sunken);border-radius:4px;overflow:hidden;margin:4px 0 2px}.meter i{display:block;height:100%;background:var(--hue)}',
      '.eta{font-size:var(--t-2xl);font-weight:700;line-height:1.2}',
      'tr.crit td{background:var(--red-soft)}',
      '.suggest{list-style:none;margin:4px 0 0;padding:0;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface)}',
      '.suggest button{display:block;width:100%;text-align:left;border:0;border-top:1px solid var(--line-2);background:none;padding:10px 12px;min-height:44px;font:inherit;color:var(--ink);cursor:pointer}',
      '.suggest li:first-child button{border-top:0}.suggest button:hover{background:var(--sunken)}',
      '.drug{font-weight:700}.drug-how{color:var(--ink-2);font-size:var(--t-sm)}',
      '.card-line{display:flex;justify-content:space-between;gap:var(--s3);padding:6px 0;border-top:1px solid var(--line-2)}.card-line:first-child{border-top:0}',
      /* the current provider: a chip in the top bar and a card on home */
      '.pt-prov{display:inline-flex;align-items:center;gap:6px;min-height:40px;max-width:46vw;padding:0 10px 0 12px;border:1px solid var(--line);border-radius:999px;background:var(--hue-soft);color:var(--ink);font:inherit;font-size:var(--t-sm);font-weight:700;cursor:pointer;min-width:0}',
      '.pt-prov span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.pt-prov svg{width:18px;height:18px;flex:none;color:var(--hue)}',
      'span.pt-prov{cursor:default}',
      '@media(max-width:480px){.topbar:has(.pt-prov) .brand span{display:none}.pt-prov{max-width:none;flex:1 1 auto}}',
      '.pcard{display:flex;gap:var(--s3);align-items:flex-start;border-left:6px solid var(--hue)}',
      '.pcard>svg{width:28px;height:28px;color:var(--hue);flex:none;margin-top:2px}',
      '.pcard h2{font-size:var(--t-lg);margin:0}',
      '.pcard .meta{color:var(--ink-2);font-size:var(--t-sm);margin:2px 0 0}',
      '.pcard .btn-row{margin-top:var(--s3)}',
      '.opt .sub{font-weight:400}',
      '.choice button[aria-current="true"]{border-color:var(--hue);background:var(--hue-soft)}',
      '.grp{font-size:var(--t-sm);color:var(--ink-3);margin:var(--s4) 0 var(--s2);font-weight:700}',
      /* contact numbers: rows wrap so the Call and WhatsApp buttons drop under the label on phones */
      '.list>li.ct{flex-wrap:wrap;align-items:center}',
      '.ct .acts{display:flex;flex-wrap:wrap;gap:var(--s2)}',
      '@media(max-width:599px){.ct .acts{flex-basis:100%}}',
      '.ct .title svg{width:18px;height:18px;margin-right:6px;vertical-align:-3px}',
      '.ct .sub svg{width:14px;height:14px;vertical-align:-2px}',
      '.ct-em .title{color:var(--red)}',
      '.ct-card h2,.ct-sos h2{font-size:var(--t-lg);margin:0}',
      '.ct-card{overflow:hidden;margin-top:var(--s4)}.ct-card .ct-head{padding:var(--s3) var(--s4) var(--s2)}.ct-card .list{border-top:1px solid var(--line-2)}',
      '.ct-sos .btn+.btn{margin-top:var(--s2)}.ct-sos h2{margin-bottom:var(--s3)}',
      '.ct-sos .btn span{white-space:normal;text-align:center}',
      '.ct-wa .num{margin:var(--s2) 0 0 34px}',
    ].join('\n');
    document.head.appendChild(s);
  })();

  /* ---------------- small helpers ---------------- */
  const changeH = {}; const inputH = {};
  const onChange = (n, fn) => { changeH[n] = fn; };
  const onInput = (n, fn) => { inputH[n] = fn; };
  document.addEventListener('change', e => { const el = e.target && e.target.closest && e.target.closest('[data-change]'); if (el && changeH[el.dataset.change]) Promise.resolve(changeH[el.dataset.change](el, e)).catch(MC.showError); });
  document.addEventListener('input', e => { const el = e.target && e.target.closest && e.target.closest('[data-input]'); if (el && inputH[el.dataset.input]) inputH[el.dataset.input](el, e); });
  const $ = id => document.getElementById(id);
  new MutationObserver(() => { if (prov.summary && document.querySelector('.topbar') && !document.getElementById('pt-prov-box')) paintChip(); document.querySelectorAll('.steps').forEach(ol => { const now = ol.querySelector('li.now'); if (now && ol.scrollWidth > ol.clientWidth && !ol.dataset.sc) { ol.dataset.sc = '1'; ol.scrollLeft = Math.max(0, now.offsetLeft - ol.clientWidth / 2 + now.clientWidth / 2); } }); }).observe(document.getElementById('app'), { childList: true, subtree: true });
  const content = (k, fb) => { const v = MC.content(k, fb); return v === 'content.' + MC.APP + '.' + k ? (fb || '') : v; };
  const fail = (msg, field) => new MC.ApiError(400, { error: msg, details: field ? [{ field, error: msg }] : undefined });
  const kindOf = s => (/(completed|paid|delivered|released|active|collected|ready|closed|success|approved)/.test(s) ? 'ok' : /(cancel|denied|rejected|failed|void|suspended|expired|declined|ended|no_show|returned)/.test(s) ? 'bad' : /(pending|queried|awaiting|priced|ordered|new)/.test(s) ? 'warn' : 'info');
  const sb = (s, label) => badge(label || T('status.' + s, cap(s)), kindOf(s));
  const lagosHour = () => Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Africa/Lagos' }).format(Date.now()));
  const isoAdd = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dowOf = iso => new Date(iso + 'T12:00:00Z').getUTCDay();
  const isoTs = iso => Date.parse(iso + 'T11:00:00Z');
  const when = ts => day(ts) + ', ' + time(ts);
  const back = (href, label) => html`<a class="back" href="${href}">${icon('left')}${label}</a>`;
  const head = (title, sub, actions) => html`<div class="page-head"><div><h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ''}</div>${actions ? html`<div class="actions">${actions}</div>` : ''}</div>`;
  const aiOn = () => MC.feature('ai') && MC.feature('aiPatientAssistant');
  let here = null; // last known position, only when the patient asked for "nearest first"
  const store = { get(k) { try { return JSON.parse(sessionStorage.getItem('mcp-' + k) || 'null'); } catch (e) { return null; } }, set(k, v) { try { sessionStorage.setItem('mcp-' + k, JSON.stringify(v)); } catch (e) { } } };
  const local = { get(k) { try { return JSON.parse(localStorage.getItem('mcp-' + k) || 'null'); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem('mcp-' + k, JSON.stringify(v)); } catch (e) { } } };

  /* ---------------- the patient's providers (provider mode) ----------------
   * In provider mode the app shows ONE provider at a time (a hospital group is one provider with branches).
   * Every patient API call carries X-MC-Provider so lists show only that provider. Open mode keeps the marketplace. */
  const prov = { summary: null, current: null };
  const pmode = () => (prov.summary && prov.summary.mode) || ((MC.config() || {}).patients || {}).mode || 'provider';
  const isProv = () => pmode() !== 'open';
  const providers = () => (prov.summary && prov.summary.providers) || [];
  const cur = () => prov.current;
  /** does the current provider offer this service? (always yes in open mode) */
  const has = mod => !isProv() || !!(cur() && (cur().modules || []).includes(mod));
  const curName = () => (cur() ? cur().name : '');
  const branchCount = p => (p && p.kind === 'group' ? (p.branches || []).length : 0);
  const pendingApps = () => (prov.summary && prov.summary.pendingApplications) || [];
  const canJoinMore = () => !prov.summary || prov.summary.allowMultipleProviders !== false || !providers().length;
  function choose(key) {
    const list = providers();
    const p = isProv() ? (list.find(x => x.key === key) || list[0] || null) : null;
    prov.current = p;
    MC.api.header('X-MC-Provider', p ? p.key : null);
    if (p) local.set('provider', p.key);
    paintChip();
  }
  /** load (or refresh) the provider list; falls back to the copy on this device when offline */
  async function loadProviders() {
    const before = prov.current ? prov.current.key : local.get('provider');
    try { prov.summary = await api.get('/api/me/providers/summary'); local.set('summary', prov.summary); }
    catch (e) { if (e.status === 401) throw e; prov.summary = prov.summary || local.get('summary') || { mode: pmode(), providers: [], pendingApplications: [], allowMultipleProviders: true }; }
    choose(before);
  }
  function paintChip() {
    const bar = document.querySelector('.topbar'); if (!bar) return;
    let el = document.getElementById('pt-prov-box');
    if (!el) { el = document.createElement('span'); el.id = 'pt-prov-box'; el.style.minWidth = '0'; el.style.display = 'flex'; const org = bar.querySelector('.org'); bar.insertBefore(el, org || bar.querySelector('.spacer')); }
    const p = cur();
    if (!isProv() || !p) { if (el.innerHTML) MC.view('', el); el.dataset.key = ''; return; }
    if (el.dataset.key === p.key + '|' + providers().length + '|' + MC.lang) return;
    el.dataset.key = p.key + '|' + providers().length + '|' + MC.lang;
    const label = T('patient.prov.current', 'Current provider: {name}', { name: p.name });
    MC.view(providers().length > 1
      ? html`<button type="button" class="pt-prov" data-action="prov-switch" aria-label="${label}. ${T('patient.prov.switch', 'Switch provider')}">${icon('building')}<span>${p.name}</span>${icon('swap')}</button>`
      : html`<span class="pt-prov" aria-label="${label}">${icon('building')}<span>${p.name}</span></span>`, el);
  }
  on('prov-switch', async () => {
    const list = providers();
    await dialog({ title: T('patient.prov.switch', 'Switch provider'), body: html`<p class="muted sm">${T('patient.prov.switch_sub', 'The app shows one provider at a time: its doctors, your visits, medicines, results and bills there.')}</p>
      <div class="choice">${list.map(p => html`<button type="button" data-action="prov-pick" data-key="${p.key}" aria-current="${cur() && cur().key === p.key ? 'true' : 'false'}"><span><b>${p.name}</b><br><span class="muted sm">${p.kind === 'group' ? T('patient.prov.branches_n', '{n} branches', { n: branchCount(p) }) + ' | ' : ''}${T('patient.prov.mrn_short', 'Record number {mrn}', { mrn: p.mrn })}</span></span>${cur() && cur().key === p.key ? icon('check') : icon('right')}</button>`)}</div>`,
      actions: [{ label: T('kit.close', 'Close'), value: null }] });
  });
  on('prov-pick', el => switchTo(el.dataset.key));
  function switchTo(key) {
    const was = cur() ? cur().key : null;
    choose(key);
    if (cur() && cur().key !== was) toast(T('patient.prov.switched', 'Switched to {name}', { name: curName() }), 'ok');
    refreshCounts();
    MC.render();
  }
  /** the state for a provider-mode patient with no provider yet */
  function noProvider(title, quiet) {
    return html`${title ? head(title) : ''}<section class="panel"><div class="row top">${icon('building')}<div class="grow"><h2 style="margin:0 0 4px;font-size:var(--t-lg)">${T('patient.none.title', 'You are not registered with a provider yet')}</h2>
      <p class="sm" style="margin:0">${T('patient.none.body', 'Choose your hospital, clinic, pharmacy or lab and apply to join. When they approve you, you can book, get your medicines and see your results here.')}</p></div></div>
      ${pendingApps().length && !quiet ? html`<p class="sm" style="margin:12px 0 0"><b>${T('patient.none.waiting', 'Your application is waiting for approval.')}</b></p>` : ''}
      <div class="btn-row"><a class="btn primary" href="#/more/join">${icon('search')}${T('patient.none.join', 'Find a provider to join')}</a>${pendingApps().length ? html`<a class="btn" href="#/more/providers">${T('patient.none.see_apps', 'See my applications')}</a>` : ''}</div></section>`;
  }
  const needProvider = () => isProv() && !cur();

  function emergencyNumbers() {
    const txt = content('emergencyNumbers', '112 (national), 767 (Lagos State Ambulance)');
    const nums = [...new Set((String(txt).match(/\b\d{3,11}\b/g) || []))].slice(0, 3);
    return html`<div class="calls"><span class="muted sm">${T('patient.sos.or_call', 'Or call:')}</span>${nums.map(n => html`<a class="btn sm" href="tel:${n}">${icon('phone')}${n}</a>`)}<span class="xs muted">${txt}</span></div>`;
  }

  /* ---------------- contact numbers (phone and WhatsApp per department) ----------------
   * GET /api/me/contacts is scoped to the current provider by X-MC-Provider (all providers in open mode). */
  const DEPT_ORDER = ['main', 'emergency', 'appointments', 'pharmacy', 'lab', 'billing', 'care', 'ambulance', 'records'];
  const DEPT = () => ({ main: T('patient.contact.dept.main', 'Main line and reception'), emergency: T('patient.contact.dept.emergency', 'Emergency'), appointments: T('patient.contact.dept.appointments', 'Appointments'),
    pharmacy: T('patient.contact.dept.pharmacy', 'Pharmacy'), lab: T('patient.contact.dept.lab', 'Laboratory'), billing: T('patient.contact.dept.billing', 'Billing and HMO'), care: T('patient.contact.dept.care', 'Customer care and complaints'),
    ambulance: T('patient.contact.dept.ambulance', 'Ambulance'), records: T('patient.contact.dept.records', 'Medical records') });
  const deptLabel = (k, e) => DEPT()[k] || (e && e.label) || cap(k);
  let ctCache = { key: null, at: 0, data: null };
  async function loadContacts(force) {
    const key = cur() ? cur().key : '*';
    if (!force && ctCache.data && ctCache.key === key && Date.now() - ctCache.at < 60000) return ctCache.data;
    const data = await api.get('/api/me/contacts');
    ctCache = { key, at: Date.now(), data };
    return data;
  }
  /** +2348031234567 -> 0803 123 4567; other numbers stay as they are */
  const showNum = n => { const s = String(n || ''); const m = s.match(/^\+234(\d{3})(\d{3})(\d{4})$/); return m ? '0' + m[1] + ' ' + m[2] + ' ' + m[3] : s; };
  /** Call and Chat on WhatsApp buttons for one contact entry; wa.me opens in a new tab */
  function ctButtons(e, what, opts = {}) {
    if (!e) return '';
    const sz = opts.size === 'lg' ? 'lg' : opts.size === 'md' ? '' : 'sm';
    return html`${e.callLink ? html`<a class="btn ${sz} ${opts.danger ? 'danger' : ''}" href="${e.callLink}" aria-label="${T('patient.contact.call_aria', 'Call {what} on {number}', { what, number: showNum(e.phone) })}">${icon('phone')}${T('patient.contact.call', 'Call')}</a>` : ''}
      ${e.chatLink ? html`<a class="btn ${sz}" href="${e.chatLink}" target="_blank" rel="noopener" aria-label="${T('patient.contact.chat_aria', 'Chat with {what} on WhatsApp (opens WhatsApp)', { what })}">${icon('message')}${T('patient.contact.chat', 'Chat on WhatsApp')}</a>` : ''}`;
  }
  /** one department row: label, number, hours, email, buttons */
  function ctRow(k, e, who) {
    const label = deptLabel(k, e);
    const what = who ? T('patient.contact.what', '{dept} at {place}', { dept: label, place: who }) : label;
    return html`<li class="ct ${k === 'emergency' ? 'ct-em' : ''}"><div class="grow"><span class="title">${k === 'emergency' ? icon('alert') : ''}${label}</span>
        <span class="sub">${[e.phone ? showNum(e.phone) : null, e.whatsapp && e.whatsapp !== e.phone ? T('patient.contact.wa_num', 'WhatsApp {number}', { number: showNum(e.whatsapp) }) : null].filter(Boolean).join(' | ')}</span>
        ${e.hours ? html`<span class="sub">${icon('clock')} ${e.hours}</span>` : ''}
        ${e.email ? html`<span class="sub"><a href="mailto:${e.email}">${e.email}</a></span>` : ''}</div>
      <div class="acts">${ctButtons(e, what, { danger: k === 'emergency' })}</div></li>`;
  }
  const sortedDepts = c => DEPT_ORDER.filter(k => c && c[k] && (c[k].callLink || c[k].chatLink || c[k].email)).concat(Object.keys(c || {}).filter(k => !DEPT_ORDER.includes(k) && (c[k].callLink || c[k].chatLink)));
  /** main line and emergency line of a provider entry from /api/me/contacts */
  function keyLines(pc) {
    if (!pc) return { main: null, emergency: [] };
    const brs = pc.branches || []; const multi = pc.kind === 'group' && brs.length > 1;
    const main = (pc.headOffice && pc.headOffice.main) || (brs.find(b => b.contacts && b.contacts.main) || { contacts: {} }).contacts.main || null;
    const emergency = brs.filter(b => b.contacts && (b.contacts.emergency || b.contacts.ambulance)).map(b => ({ entry: b.contacts.emergency || b.contacts.ambulance, place: multi ? b.name : null }));
    if (!emergency.length && pc.headOffice && pc.headOffice.emergency) emergency.push({ entry: pc.headOffice.emergency, place: null });
    return { main, emergency };
  }
  /** home: a compact "Contact {provider}" card */
  function contactCard(pc) {
    const { main, emergency } = keyLines(pc);
    if (!main && !emergency.length) return '';
    const name = pc.name;
    return html`<section class="panel flush ct-card"><div class="row between wrap ct-head"><h2>${T('patient.contact.card_title', 'Contact {provider}', { provider: name })}</h2><a class="btn ghost sm" href="#/more/contact">${T('patient.contact.all', 'All numbers')}${icon('right')}</a></div>
      <ul class="list">${main ? ctRow('main', main, name) : ''}${emergency.slice(0, 2).map(x => html`<li class="ct ct-em"><div class="grow"><span class="title">${icon('alert')}${x.place ? T('patient.contact.em_branch', 'Emergency, {branch}', { branch: x.place }) : deptLabel('emergency')}</span><span class="sub">${showNum(x.entry.phone || x.entry.whatsapp)}${x.entry.hours ? ' | ' + x.entry.hours : ''}</span></div>
        <div class="acts">${ctButtons(x.entry, T('patient.contact.em_of', 'the emergency line of {provider}', { provider: x.place || name }), { danger: true })}</div></li>`)}</ul></section>`;
  }
  /** the current provider's entry from /api/me/contacts (null in open mode or when it cannot load) */
  const curContacts = async () => { if (!isProv() || !cur()) return null; const d = await loadContacts().catch(() => null); return d ? (d.providers || []).find(x => x.key === cur().key) || null : null; };
  /** SOS screens: the current provider's emergency number with a big Call button */
  function provEmergency(pc) {
    const emergency = keyLines(pc).emergency.filter(x => x.entry.callLink);
    if (!emergency.length) return '';
    return html`<section class="panel ct-sos"><h2>${T('patient.sos.prov_title', 'Call {provider} emergency', { provider: pc.name })}</h2>
      ${emergency.slice(0, 3).map(x => html`<a class="btn danger lg block" href="${x.entry.callLink}">${icon('phone')}<span>${x.place ? T('patient.sos.prov_call_b', 'Call {branch}: {number}', { branch: x.place, number: showNum(x.entry.phone) }) : T('patient.sos.prov_call', 'Call {number}', { number: showNum(x.entry.phone) })}</span></a>`)}
      <p class="muted sm" style="margin:8px 0 0">${emergency.length > 1 ? T('patient.sos.prov_note_n', 'These are your provider\'s own emergency lines. If you need an ambulance now, press SOS.') : T('patient.sos.prov_note', 'This is your provider\'s own emergency line. If you need an ambulance now, press SOS.')}</p></section>`;
  }

  async function refreshCounts() {
    try {
      const [th, bills] = await Promise.all([api.get('/api/me/threads'), api.get('/api/me/bills')]);
      const due = bills.filter(b => b.status === 'open' && b.patientDueKobo - b.paidKobo > 0).length;
      MC.navCount('#/more/messages', th.unreadTotal || 0); MC.navCount('#/more/bills', due); MC.navCount('#/more', (th.unreadTotal || 0) + due);
    } catch (e) { /* counts are a convenience */ }
  }

  /* ---------------- status words ---------------- */
  const RX = () => ({ received: T('patient.rx.st.received', 'Sent to pharmacy'), queried: T('patient.rx.st.queried', 'Pharmacist has a question'), verified: T('patient.rx.st.verified', 'Checked by pharmacist'), priced: T('patient.rx.st.priced', 'Ready to pay'), paid: T('patient.rx.st.paid', 'Paid, being prepared'), allocating: T('patient.rx.st.paid', 'Paid, being prepared'), ready: T('patient.rx.st.ready', 'Ready'), collected: T('patient.rx.st.collected', 'Collected'), out_for_delivery: T('patient.rx.st.out_for_delivery', 'On the way to you'), delivered: T('patient.rx.st.delivered', 'Delivered'), rejected: T('patient.rx.st.rejected', 'Not accepted'), cancelled: T('patient.rx.st.cancelled', 'Cancelled') });
  const RX_STEP = () => ({ received: T('patient.rx.step.received', 'Sent'), verified: T('patient.rx.step.verified', 'Checked'), priced: T('patient.rx.step.priced', 'Priced'), paid: T('patient.rx.step.paid', 'Paid'), ready: T('patient.rx.step.ready', 'Ready'), collected: T('patient.rx.step.collected', 'Collected'), out_for_delivery: T('patient.rx.step.out', 'On the way'), delivered: T('patient.rx.step.delivered', 'Delivered') });
  const RX_DONE = ['collected', 'delivered', 'rejected', 'cancelled'];
  const APPT = () => ({ booked: T('patient.appt.st.booked', 'Booked'), checked_in: T('patient.appt.st.checked_in', 'Checked in'), in_consult: T('patient.appt.st.in_consult', 'With the doctor'), completed: T('patient.appt.st.completed', 'Completed'), cancelled: T('patient.appt.st.cancelled', 'Cancelled'), no_show: T('patient.appt.st.no_show', 'Missed') });
  const DLV = () => ({ pending: T('patient.dlv.st.pending', 'Waiting for a rider'), assigned: T('patient.dlv.st.assigned', 'Rider assigned'), picked_up: T('patient.dlv.st.picked_up', 'Rider is on the way'), delivered: T('patient.dlv.st.delivered', 'Delivered'), failed: T('patient.dlv.st.failed', 'Delivery did not succeed'), returned: T('patient.dlv.st.returned', 'Returned to the pharmacy'), cancelled: T('patient.dlv.st.cancelled', 'Cancelled') });
  const LAB_STEPS = ['ordered', 'paid', 'sample_collected', 'in_progress', 'released'];
  const LAB_STEP = () => ({ ordered: T('patient.lab.step.ordered', 'Sent to lab'), paid: T('patient.lab.step.paid', 'Paid'), sample_collected: T('patient.lab.step.sample', 'Sample taken'), in_progress: T('patient.lab.step.testing', 'Testing'), released: T('patient.lab.step.released', 'Results ready') });
  const labLabel = o => T('patient.lab.st.' + o.status, o.statusLabel || cap(o.status));
  const COVER = () => ({ pending: T('patient.hmo.st.pending', 'Waiting for confirmation'), active: T('patient.hmo.st.active', 'Active'), suspended: T('patient.hmo.st.suspended', 'Suspended'), ended: T('patient.hmo.st.ended', 'Ended'), rejected: T('patient.hmo.st.rejected', 'Not accepted by the HMO'), declined: T('patient.hmo.st.declined', 'You declined') });
  const FREQ = () => ({ stat: T('patient.freq.stat', 'once, straight away'), od: T('patient.freq.od', 'once a day'), nocte: T('patient.freq.nocte', 'at night'), mane: T('patient.freq.mane', 'in the morning'), bd: T('patient.freq.bd', 'twice a day'), tds: T('patient.freq.tds', 'three times a day'), qds: T('patient.freq.qds', 'four times a day'), q4h: T('patient.freq.q4h', 'every 4 hours'), q6h: T('patient.freq.q6h', 'every 6 hours'), q8h: T('patient.freq.q8h', 'every 8 hours'), q12h: T('patient.freq.q12h', 'every 12 hours'), weekly: T('patient.freq.weekly', 'once a week'), prn: T('patient.freq.prn', 'when needed') });
  const CATS = () => ({ consultation: T('patient.cat.consultation', 'Consultations'), drug: T('patient.cat.drug', 'Medicines'), lab: T('patient.cat.lab', 'Lab tests'), ambulance: T('patient.cat.ambulance', 'Ambulance'), delivery: T('patient.cat.delivery', 'Delivery'), procedure: T('patient.cat.procedure', 'Procedures'), video: T('patient.cat.video', 'Video visits'), registration: T('patient.cat.registration', 'Registration'), other: T('patient.cat.other', 'Other') });
  const TYPES = () => ({ hospital: T('patient.type.hospital', 'Hospital'), clinic: T('patient.type.clinic', 'Clinic'), pharmacy: T('patient.type.pharmacy', 'Pharmacy'), lab: T('patient.type.lab', 'Laboratory'), ambulance: T('patient.type.ambulance', 'Ambulance service'), other: T('patient.type.other', 'Health service') });
  const REF_ST = () => ({ sent: T('patient.ref.st.sent', 'Waiting'), accepted: T('patient.ref.st.accepted', 'Accepted'), arrived: T('patient.ref.st.arrived', 'You arrived'), completed: T('patient.ref.st.completed', 'Completed'), declined: T('patient.ref.st.declined', 'Not accepted'), cancelled: T('patient.ref.st.cancelled', 'Cancelled'), expired: T('patient.ref.st.expired', 'Expired') });
  function refWords(r) {
    const to = r.toOrgName || '';
    return ({ sent: T('patient.ref.w.sent', 'Waiting for {to} to accept it.', { to }), accepted: T('patient.ref.w.accepted', '{to} accepted it and registered you. They will contact you about your visit.', { to }), arrived: T('patient.ref.w.arrived', 'You are being seen at {to}.', { to }),
      completed: T('patient.ref.w.completed', '{to} finished this referral.', { to }), declined: T('patient.ref.w.declined', '{to} could not take this referral. Ask the provider that referred you what to do next.', { to }), cancelled: T('patient.ref.w.cancelled', 'This referral was cancelled.'), expired: T('patient.ref.w.expired', 'This referral expired before it was accepted.') })[r.status] || cap(r.status);
  }
  const URG = () => ({ emergency: T('patient.ref.u.emergency', 'Emergency'), urgent: T('patient.ref.u.urgent', 'Urgent'), routine: T('patient.ref.u.routine', 'Routine'), elective: T('patient.ref.u.elective', 'Planned') });
  const APP_ST = () => ({ pending: T('patient.app.st.pending', 'Waiting'), approved: T('patient.app.st.approved', 'Approved'), declined: T('patient.app.st.declined', 'Not approved'), cancelled: T('patient.app.st.cancelled', 'Cancelled'), expired: T('patient.app.st.expired', 'Expired') });
  function itemLine(i) {
    const how = [i.doseText, i.frequency ? (FREQ()[i.frequency] || i.frequency) : null, i.durationDays ? T('patient.rx.for_days', 'for {n} days', { n: i.durationDays }) : null].filter(Boolean).join(', ');
    return html`<div><span class="drug">${i.drugName}</span>${how ? html`<br><span class="drug-how">${how}</span>` : ''}${i.instructions ? html`<br><span class="drug-how">${i.instructions}</span>` : ''}</div>`;
  }

  /* ---------------- paying a bill (demo or Paystack) ---------------- */
  async function payBill(billId, { amountKobo, orgName, returnTo } = {}) {
    const amount = money(amountKobo);
    const ok = await confirm({ title: T('patient.pay.q', 'Pay {amount}?', { amount }), body: orgName ? T('patient.pay.q_body', 'You are paying {amount} to {org}. You will get a receipt in the app.', { amount, org: orgName }) : T('patient.pay.q_body2', 'You are paying {amount}. You will get a receipt in the app.', { amount }), ok: T('patient.pay.ok', 'Pay {amount}', { amount }) });
    if (!ok) return false;
    const r = await api.post('/api/me/bills/' + encodeURIComponent(billId) + '/pay');
    if (r.authorizationUrl) { store.set('payReturn', returnTo || location.hash); location.href = r.authorizationUrl; return 'redirect'; }
    if (r.mode === 'demo') {
      const go = await dialog({ title: T('patient.pay.demo_title', 'Demo payment'), body: html`<div class="notice warn">${T('patient.pay.demo_note', 'Demo mode: no card is charged. In the live app this is where you pay by card, bank transfer or USSD.')}</div><p>${T('patient.pay.demo_amount', 'Amount')}: <b>${money(r.amountKobo)}</b></p>`,
        actions: [{ label: T('kit.cancel', 'Cancel'), value: false }, { label: T('patient.pay.demo_ok', 'Complete payment'), value: true, primary: true }] });
      if (!go) return false;
      await api.post('/api/pay/demo/' + encodeURIComponent(r.paymentId) + '/complete');
      toast(T('patient.pay.done', 'Payment received. Thank you.'), 'ok');
      refreshCounts();
      return true;
    }
    return false;
  }
  on('pay', async el => { const r = await payBill(el.dataset.bill, { amountKobo: Number(el.dataset.amount), orgName: el.dataset.org }); if (r === true) MC.render(); });

  async function payReturn({ params }) {
    const ref = params.reference; const backTo = store.get('payReturn') || '#/';
    const show = s => view(html`${head(T('patient.pay.title', 'Payment'))}
      ${s === 'success' ? html`<div class="notice ok"><b>${T('patient.pay.ok_title', 'Payment successful')}</b><br>${T('patient.pay.ok_body', 'Thank you. Your receipt is in Bills and payments.')}</div>`
        : s === 'pending' || s === 'confirming' ? html`<div class="notice warn">${T('patient.pay.pending', 'We are still confirming your payment with the bank. This page updates by itself.')}</div>`
          : html`<div class="notice bad">${T('patient.pay.failed', 'The payment did not go through. No money was taken, or it will be returned by your bank. You can try again.')}</div>`}
      <div class="btn-row"><a class="btn primary" href="${backTo}">${T('patient.pay.continue', 'Continue')}</a><a class="btn" href="#/more/bills">${T('patient.nav.bills', 'Bills and payments')}</a></div>`);
    let r = await api.get('/api/pay/verify/' + encodeURIComponent(ref)); show(r.status);
    if (r.status === 'success') { refreshCounts(); return; }
    let n = 0; MC.poll(async () => { if (++n > 20) return; r = await api.get('/api/pay/verify/' + encodeURIComponent(ref)); show(r.status); }, 3000);
  }

  /* ---------------- SOS ---------------- */
  const SOS_CATS = () => [['other', T('patient.sos.cat.other', 'Not sure / something else')], ['breathing_difficulty', T('patient.sos.cat.breathing', 'Cannot breathe well')], ['cardiac_arrest', T('patient.sos.cat.heart', 'Chest pain or heart problem')],
    ['unconscious', T('patient.sos.cat.unconscious', 'Fainted or not waking up')], ['bleeding', T('patient.sos.cat.bleeding', 'Heavy bleeding')], ['road_traffic_accident', T('patient.sos.cat.rta', 'Road accident')],
    ['stroke_symptoms', T('patient.sos.cat.stroke', 'Face or arm weak, speech slurred')], ['obstetric_emergency', T('patient.sos.cat.pregnancy', 'Pregnancy or labour problem')], ['seizure', T('patient.sos.cat.seizure', 'Seizure or fitting')],
    ['burns', T('patient.sos.cat.burns', 'Burns')], ['trauma_fall', T('patient.sos.cat.fall', 'Fall or injury')]];
  async function startSOS() {
    const act = await api.get('/api/me/emergency/active').catch(() => ({ incident: null }));
    if (act.incident) { MC.go('#/sos/' + act.incident.id); return; }
    // location and the list of ambulance services are fetched while the dialog is open, so sending is never delayed
    let posP = MC.position(10000);
    const d = await dialog({ title: T('patient.sos.q', 'Send an ambulance now?'), form: true,
      body: html`<p>${T('patient.sos.q_body', 'We will send your location to the nearest ambulance service. Press the red button to send.')}</p>
        <div class="field"><label for="sos-cat">${T('patient.sos.what', 'What is happening? (optional)')}</label><select class="input" id="sos-cat" name="category">${SOS_CATS().map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select></div>
        <div class="field"><label for="sos-prov">${T('patient.sos.which', 'Which ambulance?')}</label><select class="input" id="sos-prov" name="providerOrgId"><option value="">${T('patient.sos.nearest', 'Nearest free ambulance (fastest)')}</option></select>
        <p class="xs muted" id="sos-prov-note" style="margin:6px 0 0">${T('patient.sos.loading_opts', 'Looking for ambulances near you...')}</p></div>
        <p class="xs muted">${T('patient.sos.charge_note', 'Any ambulance service on MediCore can come, even one you are not registered with. No subscription is needed. The service bills your MediCore account for the trip after it ends.')}</p>`,
      actions: [{ label: T('kit.cancel', 'Cancel'), value: null }, { label: T('patient.sos.send', 'Send ambulance now'), primary: true }],
      onOpen: dl => {
        const b = dl.querySelector('button[type=submit]'); if (b) { b.classList.remove('primary'); b.classList.add('danger'); } dl.querySelector('.dlg-foot button[type=submit]').focus();
        posP.then(async p => {
          const note = dl.querySelector('#sos-prov-note'); const sel = dl.querySelector('#sos-prov'); if (!note || !sel) return;
          if (!p) { note.textContent = T('patient.sos.opts_noloc', 'Location is off, so we will send the nearest service we can find.'); return; }
          const r = await api.get('/api/me/emergency/options' + qs({ lat: p.lat.toFixed(5), lng: p.lng.toFixed(5) })).catch(() => null);
          if (!r || !r.options.length) { note.textContent = T('patient.sos.opts_none', 'No ambulance service found near you on MediCore. Send anyway, and also call 112.'); return; }
          if (r.choose) for (const o of r.options) { const op = document.createElement('option'); op.value = o.id; op.disabled = !o.availableUnits;
            op.textContent = o.name + ' | ' + o.distanceKm + ' km | ' + (o.availableUnits ? T('patient.sos.opt_free', '{n} free', { n: o.availableUnits }) + (o.etaMinutes ? ', ' + T('patient.sos.opt_eta', 'about {n} min', { n: o.etaMinutes }) : '') : T('patient.sos.opt_busy', 'all busy')); sel.appendChild(op); }
          const free = r.options.filter(o => o.availableUnits).length;
          note.textContent = free ? T('patient.sos.opts_found', '{n} services with a free ambulance near you.', { n: free }) : T('patient.sos.opts_busy', 'Every service near you is busy. Send anyway: the first free ambulance will come. Also call 112.');
        });
      } });
    if (!d) return;
    await sendSOS(d.category || 'other', d.providerOrgId || null, await posP);
  }
  async function sendSOS(category, providerOrgId, known) {
    if (!known) toast(T('patient.sos.locating', 'Finding your location...'));
    let pos = known || await MC.position(10000); const extra = {}; if (providerOrgId) extra.providerOrgId = providerOrgId;
    if (!pos) {
      const r = await dialog({ title: T('patient.sos.noloc', 'We could not find your location'), form: true,
        body: html`<p>${T('patient.sos.noloc_body', 'Location is off or not allowed. Tell us where you are so the ambulance can find you.')}</p>
          <div class="field"><label for="sos-lm">${T('patient.sos.landmark', 'Nearest landmark')}</label><input class="input" id="sos-lm" name="landmark" maxlength="200" placeholder="${T('patient.sos.landmark_ph', 'e.g. opposite Total filling station, Ojuelegba')}"></div>
          <div class="field"><label for="sos-ad">${T('patient.sos.address', 'Address (if you know it)')}</label><input class="input" id="sos-ad" name="address" maxlength="300"></div>
          <p class="muted sm">${T('patient.sos.noloc_tip', 'If you can, switch on location and try again: it is faster.')}</p>`,
        actions: [{ label: T('kit.cancel', 'Cancel'), value: null }, { label: T('patient.sos.send', 'Send ambulance now'), primary: true }],
        onOpen: dl => { const b = dl.querySelector('button[type=submit]'); if (b) { b.classList.remove('primary'); b.classList.add('danger'); } },
        onSubmit: v => { if (!v.landmark && !v.address) throw fail(T('patient.sos.need_place', 'Type a landmark or an address'), 'landmark'); return v; } });
      if (!r) return;
      if (r.landmark) extra.landmark = r.landmark; if (r.address) extra.address = r.address;
      pos = await geocode(r.address || r.landmark);
      if (!pos) { const p = await api.get('/api/me/profile').catch(() => null); pos = p && p.homeLoc ? p.homeLoc : { lat: 6.5244, lng: 3.3792 }; }
      extra.note = T('patient.sos.approx_note', 'GPS not available: the location is approximate. Use the landmark and address.');
    }
    const inc = await api.post('/api/me/emergency', Object.assign({ lat: pos.lat, lng: pos.lng, category }, extra));
    if (inc.existing) toast(T('patient.sos.existing', 'You already have an ambulance request open. Showing it now.'));
    else toast(T('patient.sos.sent', 'Ambulance request sent'), 'ok');
    MC.go('#/sos/' + inc.id);
  }
  on('sos', () => startSOS());
  async function geocode(text) {
    if (!text || text.length < 3) return null;
    try { const r = await api.get('/api/geo/search' + qs({ q: text })); return r.results && r.results[0] ? { lat: r.results[0].lat, lng: r.results[0].lng } : null; } catch (e) { return null; }
  }

  async function sosPage({ stale }) {
    const [act, hist, cts] = await Promise.all([api.get('/api/me/emergency/active'), api.get('/api/me/emergency').catch(() => []), curContacts()]);
    if (stale()) return;
    if (act.incident) { location.replace('#/sos/' + act.incident.id); return; }
    view(html`${head(T('patient.sos.title', 'Emergency'), T('patient.sos.sub', 'Get an ambulance to where you are.'))}${MC.feature('publicFacilities') ? html`<div class="btn-row" style="margin-top:0"><a class="btn" href="#/hospitals">${icon('building')}${T('patient.sos.hospitals', 'Hospitals near me')}</a></div>` : ''}
      <button class="sos" data-action="sos">${icon('sos')}<span>${T('patient.sos.btn', 'SOS')}<small>${T('patient.sos.btn_sub', 'Send an ambulance to me')}</small></span></button>
      ${emergencyNumbers()}
      ${cts ? provEmergency(cts) : ''}
      <div class="notice">${T('patient.sos.tips', 'While you wait: stay with the person, keep them safe and warm, and do not give food or drink to someone who is drowsy.')}</div>
      ${hist.length ? html`<h2 class="sec">${T('patient.sos.history', 'Past requests')}</h2><div class="list">${hist.slice(0, 10).map(i => html`<a href="#/sos/${i.id}"><div class="grow"><span class="title">${T('patient.sos.cat_label.' + i.category, i.categoryLabel || cap(i.category))}</span><span class="sub">${i.number} | ${dateTime(i.createdAt)} | ${i.provider ? i.provider.name : ''}</span></div>${sb(i.status, T('patient.sos.st.' + i.status, i.statusLabel))}</a>`)}</div>` : ''}`);
  }

  async function sosTrack({ params, stale }) {
    let [inc, cts] = await Promise.all([api.get('/api/me/emergency/' + encodeURIComponent(params.id)), curContacts()]);
    if (stale()) return;
    const STEPS = ['new', 'assigned', 'enroute', 'onscene', 'transporting', 'athospital', 'closed'];
    const SL = { new: T('patient.sos.step.new', 'Received'), assigned: T('patient.sos.step.assigned', 'Ambulance assigned'), enroute: T('patient.sos.step.enroute', 'On the way'), onscene: T('patient.sos.step.onscene', 'Arrived'), transporting: T('patient.sos.step.transporting', 'To hospital'), athospital: T('patient.sos.step.athospital', 'At hospital'), closed: T('patient.sos.step.closed', 'Finished') };
    const open = s => !['closed', 'cancelled'].includes(s);
    view(html`${back('#/', T('patient.nav.home', 'Home'))}<div id="sos-info"></div>
      <div class="map" id="sos-map" aria-label="${T('patient.sos.map', 'Map of the ambulance and your location')}"></div><p class="xs muted" id="sos-map-note"></p>
      ${emergencyNumbers()}${cts ? provEmergency(cts) : ''}<div id="sos-foot"></div>`);
    const draw = () => {
      const st = T('patient.sos.st.' + inc.status, inc.statusLabel || cap(inc.status));
      MC.view(html`<div class="page-head"><div><h1>${open(inc.status) ? T('patient.sos.track_title', 'Help is coming') : T('patient.sos.track_done', 'Emergency request')}</h1><p>${inc.number} | ${T('patient.sos.cat_label.' + inc.category, inc.categoryLabel || cap(inc.category))}</p></div>${sb(inc.status, st)}</div>
        ${inc.noUnitAvailable && open(inc.status) && inc.status === 'new' ? html`<div class="notice warn">${T('patient.sos.no_unit', 'All nearby ambulances are busy. The dispatcher has your request and will send the first free unit. If you can, also call the numbers below.')}</div>` : ''}
        ${inc.status === 'cancelled' ? html`<div class="notice">${T('patient.sos.cancelled', 'This request was cancelled.')}${inc.cancelReason ? ' ' + inc.cancelReason : ''}</div>` : MC.steps(STEPS, inc.status, SL)}
        <section class="panel"><div class="row between wrap top"><div>
          ${inc.etaMinutes != null && open(inc.status) ? html`<div class="eta">${T('patient.sos.eta', 'About {n} min', { n: inc.etaMinutes })}</div><div class="muted sm">${inc.etaTarget === 'hospital' ? T('patient.sos.eta_hosp', 'to the hospital') : T('patient.sos.eta_you', 'until the ambulance reaches you')}</div>` : html`<div><b>${st}</b></div>`}
          ${inc.unit ? html`<div class="sm" style="margin-top:8px">${T('patient.sos.unit', 'Ambulance')}: <b>${inc.unit.name}</b> | ${inc.unit.plate} | ${inc.unit.type}</div>` : open(inc.status) ? html`<div class="sm muted" style="margin-top:8px">${T('patient.sos.finding', 'Finding the nearest free ambulance...')}</div>` : ''}
          ${inc.destination ? html`<div class="sm">${T('patient.sos.dest', 'Going to')}: <b>${inc.destination.name}</b></div>` : ''}</div>
          ${inc.provider ? html`<div class="end"><div class="sm muted">${inc.provider.name}</div>${inc.provider.phone ? html`<a class="btn" href="tel:${inc.provider.phone}">${icon('phone')}${T('patient.sos.call_provider', 'Call them')}</a>` : ''}</div>` : ''}</div>
          ${inc.location && (inc.location.landmark || inc.location.address) ? html`<p class="sm" style="margin:8px 0 0">${T('patient.sos.your_place', 'Your location')}: ${[inc.location.address, inc.location.landmark].filter(Boolean).join(' | ')}</p>` : ''}</section>`, $('sos-info'));
      MC.view(html`${inc.canCancel ? html`<div class="btn-row"><button class="btn" data-action="sos-cancel" data-id="${inc.id}">${T('patient.sos.cancel', 'Cancel this request')}</button></div>` : ''}
        ${(inc.timeline || []).length ? html`<h2 class="sec">${T('patient.sos.timeline', 'What has happened')}</h2><ol class="timeline">${inc.timeline.slice().reverse().map(x => html`<li><time>${time(x.at)}</time>${T('patient.sos.st.' + x.status, x.label || cap(x.status))}</li>`)}</ol>` : ''}`, $('sos-foot'));
    };
    draw();
    const m = await safeMap($('sos-map'), inc.location, $('sos-map-note'));
    const pin = () => { if (!m) return; if (inc.location) m.setMarker('me', inc.location, { label: T('patient.map.you', 'You'), kind: 'patient' }); if (inc.unitLoc) m.setMarker('unit', inc.unitLoc, { label: inc.unit ? inc.unit.name : T('patient.sos.unit', 'Ambulance'), kind: 'unit' }); m.fit(); };
    pin();
    if (!open(inc.status)) return;
    const stop = MC.poll(async () => { inc = await api.get('/api/me/emergency/' + encodeURIComponent(params.id)); draw(); pin(); if (!open(inc.status)) stop(); }, 5000);
  }
  on('sos-cancel', async el => {
    if (!(await confirm({ title: T('patient.sos.cancel_q', 'Cancel the ambulance?'), body: T('patient.sos.cancel_body', 'The ambulance will stop coming to you. Only cancel if you no longer need it.'), ok: T('patient.sos.cancel_ok', 'Yes, cancel it'), cancel: T('patient.sos.keep', 'Keep it coming'), danger: true }))) return;
    await api.post('/api/me/emergency/' + encodeURIComponent(el.dataset.id) + '/cancel', { reason: 'Cancelled by patient in the app' });
    toast(T('patient.sos.cancelled_toast', 'Ambulance request cancelled'), 'ok'); MC.render();
  });

  /* maps: only where tracking needs them; text above always carries the facts */
  async function safeMap(el, center, noteEl) {
    if (!el) return null;
    try {
      const m = await MC.map(el, { center: center && center.lat != null ? center : null, zoom: 14 });
      let warned = false;
      m.leaflet.eachLayer(l => { if (l.getTileUrl) l.on('tileerror', () => { if (!warned && noteEl) { warned = true; noteEl.textContent = T('patient.map.tiles', 'The map pictures could not load on this connection. The status and time above are still live.'); } }); });
      return m;
    } catch (e) { el.classList.remove('map'); MC.view(html`<div class="notice">${T('patient.map.unavailable', 'The map could not load. The status and time above are still live.')}</div>`, el); return null; }
  }

  /* ---------------- home ---------------- */
  async function home({ me, stale }) {
    const none = () => [];
    if (isProv()) await loadProviders();
    if (stale()) return;
    const ctP = curContacts();
    const refs = isProv() ? await api.get('/api/me/referrals').catch(none) : [];
    const [appts, rxo, labs, bills, act, dels] = needProvider() ? [[], [], [], [], await api.get('/api/me/emergency/active').catch(() => ({ incident: null })), []] : await Promise.all([
      api.get('/api/me/appointments?scope=upcoming&limit=5').catch(none), api.get('/api/me/rx-orders').catch(none), api.get('/api/me/lab-orders').catch(none),
      api.get('/api/me/bills').catch(none), api.get('/api/me/emergency/active').catch(() => ({ incident: null })), api.get('/api/me/deliveries').catch(none)]);
    const pcts = await ctP;
    if (stale()) return;
    const ccard = pcts ? contactCard(pcts) : '';
    const name = (me.patient && me.patient.firstName) || (me.user && me.user.name) || '';
    const h = lagosHour();
    const hello = h < 12 ? T('patient.home.hello_morning', 'Good morning, {name}', { name }) : h < 17 ? T('patient.home.hello_afternoon', 'Good afternoon, {name}', { name }) : T('patient.home.hello_evening', 'Good evening, {name}', { name });
    const next = appts.find(a => ['booked', 'checked_in', 'in_consult'].includes(a.status));
    const orders = rxo.filter(o => !RX_DONE.includes(o.status));
    const delBy = {}; dels.forEach(d => { delBy[d.id] = d; });
    const labOpen = labs.filter(o => !['released', 'cancelled'].includes(o.status));
    const labNew = labs.filter(o => o.status === 'released' && o.releasedAt && Date.now() - o.releasedAt < 14 * 86400e3);
    const due = bills.filter(b => b.status === 'open' && b.patientDueKobo - b.paidKobo > 0);
    const dueKobo = due.reduce((s, b) => s + b.patientDueKobo - b.paidKobo, 0);
    const inc = act.incident;
    const greetLine = content('homeGreeting', '');
    const p = cur();
    // home shows referrals that involve the current provider (to it, or from it; /me/referrals has no fromOrgId, so match the sender by name)
    const mineRef = r => !p || (p.orgIds || []).includes(r.toOrgId) || (p.branches || []).some(b => b.name === r.fromOrgName);
    const openRefs = refs.filter(r => ['sent', 'accepted', 'arrived'].includes(r.status) && mineRef(r));
    const sub = isProv() && p ? T('patient.home.welcome', 'Welcome to {provider}. What do you need today?', { provider: p.name }) : (greetLine || T('patient.home.sub', 'What do you need today?'));
    const phones = p ? (p.branches || []).filter(b => b.phone) : [];
    const pcard = isProv() && p ? html`<section class="panel pcard">${icon('building')}<div class="grow"><h2>${p.name}</h2>
        <p class="meta">${p.kind === 'group' ? html`${T('patient.prov.branches_n', '{n} branches', { n: branchCount(p) })} | ` : ''}${T('patient.home.mrn', 'Your record number')}: <b>${p.mrn}</b></p>
        <div class="btn-row">${providers().length > 1 ? html`<button class="btn sm" data-action="prov-switch">${icon('swap')}${T('patient.prov.switch', 'Switch provider')}</button>` : ''}
          ${p.kind === 'group' ? html`<a class="btn sm" href="#/care?type=places">${icon('pin')}${T('patient.home.branches', 'Branches and phone numbers')}</a>` : phones.length && !ccard ? html`<a class="btn sm" href="tel:${phones[0].phone}">${icon('phone')}${T('patient.prov.call_name', 'Call {name}', { name: p.name })}</a>` : ''}</div></div></section>` : '';
    const tiles = isProv() ? [has('clinic') ? ['#/care', 'steth', T('patient.home.t_book', 'Book a doctor')] : null, has('clinic') || has('pharmacy') ? ['#/medicines', 'pill', T('patient.home.t_meds', 'My medicines')] : null,
      has('lab') || has('clinic') ? ['#/results', 'flask', T('patient.home.t_results', 'My results')] : null, ['#/more/bills', 'card', T('patient.nav.bills', 'Bills and payments')], ['#/more/messages', 'message', T('patient.nav.messages', 'Messages')], MC.feature('marketplace') ? ['#/market', 'globe', T('patient.home.t_market', 'Find any provider')] : null].filter(Boolean)
      : [['#/care', 'steth', T('patient.home.t_book', 'Book a doctor')], ['#/medicines', 'pill', T('patient.home.t_meds', 'My medicines')], ['#/care?type=lab', 'flask', T('patient.home.t_lab', 'Find a lab')], ['#/care?type=pharmacy', 'box', T('patient.home.t_pharm', 'Find a pharmacy')]];
    const status = isProv() && (pendingApps().length || openRefs.length) ? html`<h2 class="sec">${T('patient.home.status', 'Applications and referrals')}</h2><div class="list">
        ${pendingApps().map(a => html`<a href="#/more/providers">${icon('clock')}<div class="grow"><span class="title">${T('patient.app.to', 'Application to {provider}', { provider: a.orgName || a.groupName || '' })}</span><span class="sub">${T('patient.app.waiting', 'Waiting for them to approve it')} | ${date(a.createdAt)}</span></div>${sb('pending', T('patient.app.st.pending', 'Waiting'))}</a>`)}
        ${openRefs.map(r => html`<a href="#/more/referrals">${icon('swap')}<div class="grow"><span class="title">${T('patient.ref.to', 'Referral to {to}', { to: r.toOrgName })}</span><span class="sub">${refWords(r)}</span></div>${sb(r.status, REF_ST()[r.status])}</a>`)}</div>` : '';
    view(html`<div class="page-head"><div><h1 class="pt-hello">${hello}</h1><p>${needProvider() ? T('patient.home.sub', 'What do you need today?') : sub}</p></div></div>
      ${needProvider() ? noProvider(null, true) : pcard}
      ${inc ? html`<a class="sos busy" href="#/sos/${inc.id}">${icon('ambulance')}<span>${T('patient.home.sos_open', 'Ambulance request open')}<small>${T('patient.sos.st.' + inc.status, inc.statusLabel)}${inc.etaMinutes != null ? ' | ' + T('patient.sos.eta', 'About {n} min', { n: inc.etaMinutes }) : ''}</small></span></a>`
        : html`<button class="sos" data-action="sos">${icon('sos')}<span>${T('patient.sos.btn', 'SOS')}<small>${T('patient.sos.btn_sub', 'Send an ambulance to me')}</small></span></button>`}
      ${emergencyNumbers()}
      ${next ? html`<h2 class="sec">${T('patient.home.next', 'Your next appointment')}</h2><section class="panel"><div class="row between wrap top"><div><b>${next.doctorName}</b><div class="muted sm">${next.orgName}${next.specialty ? ' | ' + next.specialty : ''}</div>
          <div style="margin-top:6px">${icon('calendar')} <b>${when(next.startUtc)}</b> ${next.type === 'video' ? badge(T('patient.appt.video', 'Video visit'), 'info') : badge(T('patient.appt.in_person', 'In person'), 'plain')}</div></div>
          <div class="btn-row" style="margin-top:0">${next.canJoinVideo ? html`<a class="btn primary" href="#/more/appointments/${next.id}/video">${icon('video')}${T('patient.appt.join', 'Join video visit')}</a>` : ''}
          ${!next.paid && next.billId && next.feeKobo ? html`<button class="btn ${next.type === 'video' ? 'primary' : ''}" data-action="pay" data-bill="${next.billId}" data-amount="${next.feeKobo}" data-org="${next.orgName}">${T('patient.pay.btn', 'Pay {amount}', { amount: money(next.feeKobo) })}</button>` : ''}
          <a class="btn" href="#/more/appointments/${next.id}">${T('patient.home.details', 'Details')}</a></div></div></section>` : ''}
      ${orders.length || labOpen.length || labNew.length ? html`<h2 class="sec">${T('patient.home.active', 'In progress')}</h2><div class="list">
        ${orders.map(o => { const d = o.deliveryId && delBy[o.deliveryId]; return html`<a href="#/medicines/order/${o.id}">${icon(d && d.status === 'picked_up' ? 'truck' : 'pill')}<div class="grow"><span class="title">${T('patient.home.rx_from', 'Medicines from {pharmacy}', { pharmacy: o.pharmacyName || '' })}</span><span class="sub">${o.fulfilment === 'delivery' ? T('patient.rx.delivery', 'Home delivery') : T('patient.rx.pickup', 'Pickup')}${d && d.etaMinutes != null ? ' | ' + T('patient.dlv.eta', 'Arrives in about {n} min', { n: d.etaMinutes }) : ''}</span></div>${sb(o.status, RX()[o.status])}</a>`; })}
        ${labOpen.map(o => html`<a href="${o.status === 'awaiting_lab' ? '#/results/lab/' + o.id + '/choose' : '#/results/lab/' + o.id}">${icon('flask')}<div class="grow"><span class="title">${o.tests.map(x => x.name).join(', ')}</span><span class="sub">${o.lab ? o.lab.name : T('patient.lab.no_lab', 'Choose a lab to do this test')}</span></div>${sb(o.status, labLabel(o))}</a>`)}
        ${labNew.map(o => html`<a href="#/results/lab/${o.id}">${icon('flask')}<div class="grow"><span class="title">${T('patient.home.result_ready', 'New result: {tests}', { tests: o.tests.map(x => x.name).join(', ') })}</span><span class="sub">${o.lab ? o.lab.name : ''} | ${ago(o.releasedAt)}</span></div>${sb('released', T('patient.lab.view', 'View'))}</a>`)}</div>` : ''}
      ${due.length ? html`<h2 class="sec">${T('patient.home.bills', 'Bills to pay')}</h2><a class="list" href="#/more/bills" style="display:block;text-decoration:none"><div class="row" style="padding:12px 16px;min-height:56px">${icon('card')}<div class="grow"><b>${T('patient.home.bills_n', '{n} unpaid bills: {amount}', { n: due.length, amount: money(dueKobo) })}</b><br><span class="sub muted sm">${[...new Set(due.map(b => b.orgName))].join(', ')}</span></div>${icon('right')}</div></a>` : ''}
      ${status}
      ${needProvider() ? '' : ccard}
      ${needProvider() ? '' : html`<h2 class="sec">${T('patient.home.do', 'What would you like to do?')}</h2>
      <div class="tiles">${tiles.map(([h, i, l]) => html`<a class="tile" href="${h}">${icon(i)}${l}</a>`)}</div>`}
      ${aiOn() ? html`<section class="panel"><div class="row top">${icon('heart')}<div class="grow"><h2 style="font-size:var(--t-lg);margin:0 0 4px">${T('patient.home.ai', 'Health assistant')}</h2><p class="muted sm" style="margin:0">${T('patient.home.ai_sub', 'Ask about symptoms or medicines in your language. It gives general information and points you to the right care.')}</p></div></div><div class="btn-row"><a class="btn" href="#/more/assistant">${icon('message')}${T('patient.home.ai_open', 'Ask the assistant')}</a></div></section>` : ''}`);
    refreshCounts();
  }

  /* ---------------- find care ---------------- */
  const CARE_TABS = () => [['doctors', T('patient.care.tab.doctors', 'Doctors')], ['hospital', T('patient.care.tab.hospitals', 'Hospitals')], ['clinic', T('patient.care.tab.clinics', 'Clinics')], ['pharmacy', T('patient.care.tab.pharmacies', 'Pharmacies')], ['lab', T('patient.care.tab.labs', 'Labs')], ['ambulance', T('patient.care.tab.ambulance', 'Ambulance')]];
  /* provider mode: the current provider's own care only (its doctors, branches, pharmacy, lab). No platform directory. */
  async function provCare({ query, stale }) {
    if (needProvider()) { view(noProvider(T('patient.care.mine_title', 'Care'))); return; }
    const p = cur();
    const tabsAll = [has('clinic') ? ['doctors', T('patient.care.tab.doctors', 'Doctors')] : null, ['places', p.kind === 'group' ? T('patient.care.tab.branches', 'Branches') : T('patient.care.tab.location', 'Location and contact')],
      has('pharmacy') ? ['pharmacy', T('patient.care.tab.pharmacy', 'Pharmacy')] : null, has('lab') ? ['lab', T('patient.care.tab.lab', 'Lab tests')] : null, has('ambulance') ? ['ambulance', T('patient.care.tab.ambulance', 'Ambulance')] : null].filter(Boolean);
    const tab = tabsAll.some(x => x[0] === query.type) ? query.type : (query.type ? 'places' : tabsAll[0][0]);
    const first = tabsAll[0][0];
    const tabs = html`<div class="tabs" role="tablist">${tabsAll.map(([k, l]) => html`<a href="#/care${k === first ? '' : '?type=' + k}" role="tab" aria-selected="${k === tab ? 'true' : 'false'}">${l}</a>`)}</div>`;
    const top = head(T('patient.care.mine_h', 'Care at {provider}', { provider: p.name }), p.kind === 'group' ? T('patient.care.mine_sub_g', 'Doctors and services across its {n} branches.', { n: branchCount(p) }) : has('clinic') ? T('patient.care.mine_sub', 'Its doctors and services, and how to reach it.') : T('patient.care.mine_sub_nd', 'Its services and how to reach it.'));
    if (tab === 'doctors') {
      const branch = p.kind === 'group' && (p.branches || []).some(b => b.orgId === query.branch) ? query.branch : '';
      const rows = await api.get('/api/doctors' + qs({ q: query.q, specialty: query.specialty, type: query.vtype, orgId: branch, limit: 100 }));
      let list = rows; let note = '';
      if (!rows.length && query.specialty) { list = await api.get('/api/doctors' + qs({ q: query.q, type: query.vtype, orgId: branch, limit: 100 })); note = T('patient.care.no_specialty_mine', 'No {specialty} is listed at {provider} yet. Here are its other doctors.', { specialty: query.specialty, provider: p.name }); }
      if (stale()) return;
      const specs = [...new Set(list.map(d => d.specialty).filter(Boolean))].sort();
      const bName = id1 => { const b = (p.branches || []).find(x => x.orgId === id1); return b ? b.branchName : ''; };
      view(html`${top}${tabs}
        <form data-form="doc-search" class="panel" novalidate><div class="fields two"><div class="field"><label for="ds-q">${T('patient.care.search_mine', 'Doctor name or specialty')}</label><div class="search">${icon('search')}<input class="input" id="ds-q" name="q" value="${query.q || ''}" maxlength="60" enterkeyhint="search"></div></div>
          <div class="field"><label for="ds-s">${T('patient.care.specialty', 'Specialty')}</label><select class="input" id="ds-s" name="specialty"><option value="">${T('patient.care.any', 'Any')}</option>${specs.map(s => html`<option value="${s}" ${s === query.specialty ? 'selected' : ''}>${s}</option>`)}${query.specialty && !specs.includes(query.specialty) ? html`<option value="${query.specialty}" selected>${query.specialty}</option>` : ''}</select></div>
          ${p.kind === 'group' ? html`<div class="field"><label for="ds-b">${T('patient.care.branch', 'Branch')}</label><select class="input" id="ds-b" name="branch"><option value="">${T('patient.care.all_branches', 'All branches')}</option>${p.branches.filter(b => (b.modules || []).includes('clinic')).map(b => html`<option value="${b.orgId}" ${b.orgId === branch ? 'selected' : ''}>${b.branchName}${b.area && b.area !== b.branchName ? ', ' + b.area : ''}</option>`)}</select></div>` : ''}</div>
          ${MC.feature('videoVisits') ? html`<label class="check"><input type="checkbox" name="video" ${query.vtype === 'video' ? 'checked' : ''}><span>${T('patient.care.video_only', 'Only doctors who do video visits')}</span></label>` : ''}
          <button class="btn primary" type="submit">${icon('search')}${T('patient.care.find', 'Find doctors')}</button></form>
        ${note ? html`<div class="notice">${note}</div>` : ''}
        ${list.length ? html`<div class="list">${list.map(d => html`<a href="#/care/doctor/${d.membershipId}${query.specialty ? '?specialty=' + encodeURIComponent(query.specialty) : ''}"><div class="grow"><span class="title">${d.name}</span><span class="sub">${d.specialty || ''}${d.specialty && p.kind === 'group' ? ' | ' : ''}${p.kind === 'group' ? T('patient.care.at_branch', '{branch} branch', { branch: bName(d.orgId) || d.orgName }) : ''}</span>
          <span class="sub">${d.feeKobo != null ? T('patient.care.fee', 'In person {fee}', { fee: money(d.feeKobo) }) : ''}${d.feeKobo != null && d.videoFeeKobo != null && MC.feature('videoVisits') ? ' | ' : ''}${d.videoFeeKobo != null && MC.feature('videoVisits') ? T('patient.care.vfee', 'Video {fee}', { fee: money(d.videoFeeKobo) }) : ''}</span></div>
          ${(d.types || []).includes('video') && MC.feature('videoVisits') ? badge(T('patient.appt.video', 'Video visit'), 'info') : ''}${icon('right')}</a>`)}</div>`
          : empty({ icon: 'steth', title: T('patient.care.no_doctors_mine', 'No doctors are taking bookings here right now'), body: T('patient.care.no_doctors_mine_sub', 'Clear the search, or call the provider to book.'), action: html`<a class="btn" href="#/care">${T('patient.care.clear', 'Clear search')}</a>` })}`);
      form('doc-search', d => MC.go('#/care' + qs({ q: d.q, specialty: d.specialty, branch: d.branch, vtype: d.video ? 'video' : '' })));
      return;
    }
    if (tab === 'ambulance') {
      view(html`${top}${tabs}<div class="notice warn">${T('patient.care.amb_note', 'In an emergency, do not search: press SOS on the home screen or call 112.')}</div>
        <button class="sos" data-action="sos">${icon('sos')}<span>${T('patient.sos.btn', 'SOS')}<small>${T('patient.sos.btn_sub', 'Send an ambulance to me')}</small></span></button>${emergencyNumbers()}`);
      return;
    }
    // places, pharmacy, lab: the provider's own branches (the directory is scoped to the current provider by the header)
    const mod = tab === 'pharmacy' ? 'pharmacy' : tab === 'lab' ? 'lab' : null;
    const rows = await api.get('/api/directory' + qs({ module: mod, lat: here && here.lat, lng: here && here.lng, limit: 100 }));
    if (stale()) return;
    const branchOf = o => (p.branches || []).find(b => b.orgId === o.id) || {};
    const hint = tab === 'pharmacy' ? T('patient.care.ph_hint', 'Your prescriptions from {provider} can be sent to its pharmacy from My medicines, for pickup or delivery.', { provider: p.name })
      : tab === 'lab' ? T('patient.care.lab_hint', 'Open a location to see its lab tests and prices, and request tests yourself.') : '';
    view(html`${top}${tabs}${hint ? html`<p class="muted sm">${hint}</p>` : ''}
      ${rows.length > 1 ? html`<div class="btn-row" style="margin:0 0 12px"><button class="btn sm ${here ? 'primary' : ''}" type="button" data-action="near">${icon('pin')}${here ? T('patient.care.nearest_on', 'Nearest first') : T('patient.care.nearest', 'Show nearest first')}</button></div>` : ''}
      ${rows.length ? html`<ul class="list">${rows.map(o => { const b = branchOf(o); return html`<li><div class="grow"><a class="title" href="#/care/provider/${o.id}">${p.kind === 'group' ? (b.branchName || o.name) : o.name}</a><span class="sub">${[o.area, o.city].filter(Boolean).join(', ')}${o.distanceKm != null ? ' | ' + T('patient.care.km', '{n} km', { n: o.distanceKm }) : ''}</span>${o.openingHours ? html`<span class="sub">${o.openingHours}</span>` : ''}
          <span class="sub">${(o.modules || []).filter(m => ['clinic', 'pharmacy', 'delivery', 'lab', 'ambulance'].includes(m)).map(m => T('patient.prov.mod.' + m, cap(m))).join(', ')}</span></div>
          <span class="end">${o.phone ? html`<a class="btn sm" href="tel:${o.phone}" aria-label="${T('patient.prov.call_name', 'Call {name}', { name: b.branchName || o.name })}">${icon('phone')}${T('patient.prov.call', 'Call')}</a>` : ''}</span></li>`; })}</ul>`
        : empty({ icon: 'building', title: T('patient.care.none_mine', 'Nothing to show here yet'), body: T('patient.care.none_mine_sub', 'Message the provider if you need this service.') })}`);
  }
  async function care(ctx) {
    if (isProv()) return provCare(ctx);
    const { query, stale } = ctx;
    const tab = query.type || 'doctors';
    const tabs = html`<div class="tabs" role="tablist">${CARE_TABS().map(([k, l]) => html`<a href="#/care${k === 'doctors' ? '' : '?type=' + k}" role="tab" aria-selected="${k === tab ? 'true' : 'false'}">${l}</a>`)}</div>`;
    if (tab === 'doctors') {
      const rows = await api.get('/api/doctors' + qs({ q: query.q, specialty: query.specialty, type: query.vtype, limit: 100 }));
      let list = rows; let note = '';
      if (!rows.length && query.specialty) { list = await api.get('/api/doctors' + qs({ q: query.q, type: query.vtype, limit: 100 })); note = T('patient.care.no_specialty', 'No {specialty} is listed yet. Here are all doctors you can book.', { specialty: query.specialty }); }
      if (stale()) return;
      const specs = [...new Set(list.map(d => d.specialty).filter(Boolean))].sort();
      view(html`${head(T('patient.care.title', 'Find care'), T('patient.care.sub', 'Book a doctor or find a hospital, pharmacy, lab or ambulance service.'))}${tabs}
        <form data-form="doc-search" class="panel" novalidate><div class="fields two"><div class="field"><label for="ds-q">${T('patient.care.search', 'Name, specialty or hospital')}</label><div class="search">${icon('search')}<input class="input" id="ds-q" name="q" value="${query.q || ''}" maxlength="60" enterkeyhint="search"></div></div>
          <div class="field"><label for="ds-s">${T('patient.care.specialty', 'Specialty')}</label><select class="input" id="ds-s" name="specialty"><option value="">${T('patient.care.any', 'Any')}</option>${specs.map(s => html`<option value="${s}" ${s === query.specialty ? 'selected' : ''}>${s}</option>`)}${query.specialty && !specs.includes(query.specialty) ? html`<option value="${query.specialty}" selected>${query.specialty}</option>` : ''}</select></div></div>
          ${MC.feature('videoVisits') ? html`<label class="check"><input type="checkbox" name="video" ${query.vtype === 'video' ? 'checked' : ''}><span>${T('patient.care.video_only', 'Only doctors who do video visits')}</span></label>` : ''}
          <button class="btn primary" type="submit">${icon('search')}${T('patient.care.find', 'Find doctors')}</button></form>
        ${note ? html`<div class="notice">${note}</div>` : ''}
        ${list.length ? html`<div class="list">${list.map(d => html`<a href="#/care/doctor/${d.membershipId}${query.specialty ? '?specialty=' + encodeURIComponent(query.specialty) : ''}"><div class="grow"><span class="title">${d.name}</span><span class="sub">${d.specialty || ''}${d.specialty ? ' | ' : ''}${d.orgName}${d.orgArea ? ', ' + d.orgArea : ''}</span>
          <span class="sub">${d.feeKobo != null ? T('patient.care.fee', 'In person {fee}', { fee: money(d.feeKobo) }) : ''}${d.feeKobo != null && d.videoFeeKobo != null && MC.feature('videoVisits') ? ' | ' : ''}${d.videoFeeKobo != null && MC.feature('videoVisits') ? T('patient.care.vfee', 'Video {fee}', { fee: money(d.videoFeeKobo) }) : ''}</span></div>
          ${d.types.includes('video') && MC.feature('videoVisits') ? badge(T('patient.appt.video', 'Video visit'), 'info') : ''}${icon('right')}</a>`)}</div>`
          : empty({ icon: 'steth', title: T('patient.care.no_doctors', 'No doctors found'), body: T('patient.care.no_doctors_sub', 'Try another name or clear the specialty.'), action: html`<a class="btn" href="#/care">${T('patient.care.clear', 'Clear search')}</a>` })}`);
      form('doc-search', d => MC.go('#/care' + qs({ q: d.q, specialty: d.specialty, vtype: d.video ? 'video' : '' })));
      return;
    }
    const byModule = { pharmacy: 'pharmacy', lab: 'lab', ambulance: 'ambulance' };
    const rows = await api.get('/api/directory' + qs(Object.assign(byModule[tab] ? { module: byModule[tab] } : { type: tab }, { q: query.q, lat: here && here.lat, lng: here && here.lng, limit: 100 })));
    if (stale()) return;
    view(html`${head(T('patient.care.title', 'Find care'), T('patient.care.sub', 'Book a doctor or find a hospital, pharmacy, lab or ambulance service.'))}${tabs}
      <form data-form="dir-search" class="row wrap" style="margin-bottom:16px" novalidate><input type="hidden" name="type" value="${tab}"><div class="search" style="flex:1;min-width:200px">${icon('search')}<input class="input" name="q" value="${query.q || ''}" maxlength="60" aria-label="${T('patient.care.search_dir', 'Name or area')}" placeholder="${T('patient.care.search_dir', 'Name or area')}"></div><button class="btn" type="submit">${T('patient.care.search_btn', 'Search')}</button>
        <button class="btn ${here ? 'primary' : ''}" type="button" data-action="near">${icon('pin')}${here ? T('patient.care.nearest_on', 'Nearest first') : T('patient.care.nearest', 'Show nearest first')}</button></form>
      ${tab === 'ambulance' ? html`<div class="notice warn">${T('patient.care.amb_note', 'In an emergency, do not search: press SOS on the home screen or call 112.')}</div>` : ''}
      ${rows.length ? html`<div class="list">${rows.map(o => html`<a href="#/care/provider/${o.id}"><div class="grow"><span class="title">${o.name}</span><span class="sub">${TYPES()[o.type] || o.typeLabel}${o.area ? ' | ' + o.area : ''}${o.city ? ', ' + o.city : ''}</span>${o.openingHours ? html`<span class="sub">${o.openingHours}</span>` : ''}</div>
        <span class="end">${o.distanceKm != null ? html`<b>${T('patient.care.km', '{n} km', { n: o.distanceKm })}</b><br>` : ''}${tab === 'pharmacy' && o.modules.includes('delivery') && MC.feature('homeDelivery') ? badge(T('patient.care.delivers', 'Delivers'), 'ok') : ''}</span></a>`)}</div>`
        : empty({ icon: 'building', title: T('patient.care.none', 'Nothing found'), body: T('patient.care.none_sub', 'Try another name or area.') })}`);
    form('dir-search', d => MC.go('#/care' + qs({ type: d.type, q: d.q })));
  }
  on('near', async () => {
    if (here) { here = null; MC.render(); return; }
    toast(T('patient.care.locating', 'Finding your location...'));
    const p = await MC.position();
    if (!p) { toast(T('patient.care.noloc', 'Location is not available. Allow location for MediCore and try again, or search by area.'), 'bad'); return; }
    here = p; MC.render();
  });

  const careLabel = () => (isProv() ? T('patient.nav.care_mine', 'Care') : T('patient.care.title', 'Find care'));
  async function providerPage({ params, stale }) {
    if (isProv() && !(cur() && (cur().orgIds || []).includes(params.id))) {
      view(html`${back('#/care', careLabel())}${empty({ icon: 'building', title: T('patient.prov.not_yours', 'This is not one of your provider\'s locations'), body: T('patient.prov.not_yours_sub', 'Switch to the provider you want, or apply to join it in My providers.'), action: html`<a class="btn" href="#/more/providers">${T('patient.nav.providers', 'My providers')}</a>` })}`);
      return;
    }
    const o = await api.get('/api/directory/' + encodeURIComponent(params.id));
    const [docs, labT] = await Promise.all([o.modules.includes('clinic') ? api.get('/api/doctors' + qs({ orgId: o.id })).catch(() => []) : [], o.modules.includes('lab') ? api.get('/api/labs/' + encodeURIComponent(o.id) + '/tests').catch(() => null) : null]);
    if (stale()) return;
    const byCat = {}; (o.services || []).forEach(s => { (byCat[s.category] = byCat[s.category] || []).push(s); });
    view(html`${back(isProv() ? '#/care?type=places' : '#/care' + (o.type === 'pharmacy' || o.type === 'lab' || o.type === 'ambulance' ? '?type=' + o.type : o.type === 'hospital' || o.type === 'clinic' ? '?type=' + o.type : ''), careLabel())}
      ${head(o.name, [TYPES()[o.type] || o.typeLabel, o.area, o.city].filter(Boolean).join(' | '), o.phone ? html`<a class="btn" href="tel:${o.phone}">${icon('phone')}${T('patient.prov.call', 'Call')}</a>` : '')}
      <section class="panel"><dl class="kv">${o.openingHours ? html`<dt>${T('patient.prov.hours', 'Opening hours')}</dt><dd>${o.openingHours}</dd>` : ''}${o.phone ? html`<dt>${T('patient.prov.phone', 'Phone')}</dt><dd>${o.phone}</dd>` : ''}
        <dt>${T('patient.prov.offers', 'Services')}</dt><dd>${o.modules.filter(m => ['clinic', 'pharmacy', 'delivery', 'lab', 'ambulance'].includes(m)).map(m => T('patient.prov.mod.' + m, cap(m))).join(', ')}</dd></dl>
        ${o.modules.includes('pharmacy') ? html`<p class="sm muted" style="margin:12px 0 0">${T('patient.prov.rx_hint', 'To get medicines here, open My medicines and send your prescription to this pharmacy.')}</p>` : ''}
        ${o.modules.includes('ambulance') ? html`<p class="sm muted" style="margin:12px 0 0">${T('patient.prov.amb_hint', 'In an emergency press SOS. We send the nearest free ambulance.')}</p>` : ''}</section>
      ${docs.length ? html`<h2 class="sec">${T('patient.prov.doctors', 'Doctors you can book')}</h2><div class="list">${docs.map(d => html`<a href="#/care/doctor/${d.membershipId}"><div class="grow"><span class="title">${d.name}</span><span class="sub">${d.specialty || ''}</span></div><span class="end sm">${d.feeKobo != null ? money(d.feeKobo) : ''}</span>${icon('right')}</a>`)}</div>` : ''}
      ${labT && labT.tests.length ? html`<h2 class="sec">${T('patient.prov.tests', 'Lab tests and prices')}</h2>
        ${labT.lab.acceptsWalkIns !== false ? html`<form data-form="lab-request" novalidate><input type="hidden" name="labOrgId" value="${o.id}"><p class="muted sm">${T('patient.prov.tests_hint', 'Tick the tests you want and request them. Results come only to you. If a doctor gave you a lab request, use Results instead.')}</p>
          <div class="list">${labT.tests.map(x => html`<label class="check" style="padding:10px 16px;border-top:1px solid var(--line-2)"><input type="checkbox" name="tests" data-list value="${x.code}"><span class="grow">${x.name}<br><span class="xs muted">${T('patient.prov.tat', 'Results in about {n} hours', { n: x.tatHours })}</span></span><b>${money(x.priceKobo)}</b></label>`)}</div>
          <div class="form-err notice bad" hidden style="margin-top:12px"></div><div class="btn-row"><button class="btn primary" type="submit">${icon('flask')}${T('patient.prov.request', 'Request selected tests')}</button></div></form>`
          : html`<div class="list">${labT.tests.map(x => html`<li><div class="grow"><span class="title">${x.name}</span></div><b>${money(x.priceKobo)}</b></li>`)}</div>`}` : ''}
      ${Object.keys(byCat).length ? html`<h2 class="sec">${T('patient.prov.prices', 'Prices')}</h2>${Object.keys(byCat).sort().map(c => html`<section class="panel flush"><h3>${CATS()[c] || cap(c)}</h3><ul class="list">${byCat[c].map(s => html`<li><div class="grow">${s.name}</div><b>${money(s.priceKobo)}</b></li>`)}</ul></section>`)}` : ''}`);
    form('lab-request', async d => {
      if (!d.tests || !d.tests.length) throw fail(T('patient.prov.pick_test', 'Tick at least one test'));
      const ord = await api.post('/api/me/lab-requests', { labOrgId: d.labOrgId, tests: d.tests });
      toast(T('patient.prov.requested', 'Tests requested'), 'ok');
      if (ord.billId && ord.bill && ord.bill.status === 'open') await payBill(ord.billId, { amountKobo: ord.bill.patientDueKobo - ord.bill.paidKobo, orgName: o.name, returnTo: '#/results/lab/' + ord.id });
      MC.go('#/results/lab/' + ord.id);
    });
  }

  /* ---------------- doctor page and booking ---------------- */
  /** the provider takes bookings by phone only: show its appointments (or main) line instead of a bare error */
  async function noOnlineBooking(doc, f) {
    const box = $('bk-alt'); if (!box) return;
    let key = null; let entry = null;
    const data = await loadContacts().catch(() => null);
    for (const pc of (data && data.providers) || []) {
      const b = (pc.branches || []).find(x => x.orgId === doc.orgId); if (!b) continue;
      const c = b.contacts || {};
      key = ['appointments', 'main'].find(k => c[k] && (c[k].callLink || c[k].chatLink)) || null; entry = key ? c[key] : null;
      if (!entry && pc.headOffice && pc.headOffice.main) { key = 'main'; entry = pc.headOffice.main; }
      break;
    }
    if (!entry) { const o = await api.get('/api/directory/' + encodeURIComponent(doc.orgId)).catch(() => null); if (o && o.phone) { key = 'main'; entry = { phone: o.phone, callLink: 'tel:' + String(o.phone).replace(/[^\d+]/g, '') }; } }
    MC.view(html`<div class="notice warn" role="alert"><b>${T('patient.book.no_online_title', '{org} does not take bookings in the app', { org: doc.orgName })}</b><br>${entry ? T('patient.book.no_online', 'Book at the front desk or by phone. Call them or chat on WhatsApp to choose a time.') : T('patient.book.no_online_nonum', 'Book at the front desk or by phone. You can also write to them in Messages.')}</div>
      ${entry ? html`<p class="sm" style="margin:0 0 4px">${deptLabel(key, entry)}: <b>${showNum(entry.phone || entry.whatsapp)}</b>${entry.hours ? ' | ' + entry.hours : ''}</p><div class="btn-row" style="margin:0 0 12px">${ctButtons(entry, T('patient.contact.what', '{dept} at {place}', { dept: deptLabel(key, entry), place: doc.orgName }), { size: 'md' })}</div>`
        : html`<div class="btn-row" style="margin:0 0 12px"><a class="btn" href="#/more/messages">${icon('message')}${T('patient.contact.write', 'Write a message')}</a></div>`}`, box);
    box.hidden = false;
    const sub = f && f.querySelector('button[type=submit]'); if (sub) sub.hidden = true;
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  async function doctorPage({ params, query, stale }) {
    const d = await api.get('/api/doctors/' + encodeURIComponent(params.id));
    const today = MC.todayISO(); const works = new Set((d.weekly || []).map(w => w.dow));
    const days = []; for (let i = 0; i < 21; i++) days.push(isoAdd(today, i));
    const sel = query.date && days.includes(query.date) ? query.date : (days.find(x => works.has(dowOf(x))) || today);
    const video = MC.feature('videoVisits') && d.types.includes('video') && d.videoFeeKobo != null;
    const inPerson = d.types.includes('in_person') && d.feeKobo != null;
    const defType = query.vtype === 'video' && video ? 'video' : inPerson ? 'in_person' : 'video';
    if (stale()) return;
    if (isProv() && !(cur() && (cur().orgIds || []).includes(d.orgId))) {
      view(html`${back('#/care', careLabel())}${empty({ icon: 'steth', title: T('patient.doc.not_yours', 'This doctor is not at your current provider'), body: T('patient.doc.not_yours_sub', 'Switch to the provider this doctor works for, or book a doctor at {provider}.', { provider: curName() }), action: html`<a class="btn" href="#/care">${T('patient.appt.book', 'Book a doctor')}</a>` })}`);
      return;
    }
    view(html`${back(query.specialty ? '#/care?specialty=' + encodeURIComponent(query.specialty) : '#/care', careLabel())}
      ${head(d.name, [d.specialty, d.orgName + (d.orgArea ? ', ' + d.orgArea : '')].filter(Boolean).join(' | '))}
      ${d.bio || (d.languages || []).length ? html`<section class="panel">${d.bio ? html`<p style="margin:0 0 8px">${d.bio}</p>` : ''}${(d.languages || []).length ? html`<p class="sm muted" style="margin:0">${T('patient.doc.speaks', 'Speaks: {langs}', { langs: d.languages.join(', ') })}</p>` : ''}</section>` : ''}
      ${!d.acceptingBookings ? html`<div class="notice warn">${T('patient.doc.paused', 'This doctor is not taking bookings right now.')}</div>` : html`
      <form data-form="book" class="panel" novalidate><input type="hidden" name="doctor" value="${d.membershipId}">
        <h2>${T('patient.book.title', 'Book an appointment')}</h2>
        ${inPerson && video ? html`<div class="field"><span class="label">${T('patient.book.how', 'How do you want to see the doctor?')}</span>
          <label class="opt"><input type="radio" name="type" value="in_person" ${defType === 'in_person' ? 'checked' : ''}><span class="grow"><span class="title">${T('patient.appt.in_person', 'In person')}: ${money(d.feeKobo)}</span><span class="sub">${T('patient.book.in_person_sub', 'Visit {org}. You can pay now or at the front desk.', { org: d.orgName })}</span></span></label>
          <label class="opt"><input type="radio" name="type" value="video" ${defType === 'video' ? 'checked' : ''}><span class="grow"><span class="title">${T('patient.appt.video', 'Video visit')}: ${money(d.videoFeeKobo)}</span><span class="sub">${T('patient.book.video_sub', 'Talk to the doctor on your phone. Pay before the visit. Uses mobile data (about 5 MB a minute).')}</span></span></label></div>`
          : html`<input type="hidden" name="type" value="${inPerson ? 'in_person' : 'video'}"><p><b>${inPerson ? T('patient.appt.in_person', 'In person') + ': ' + money(d.feeKobo) : T('patient.appt.video', 'Video visit') + ': ' + money(d.videoFeeKobo)}</b></p>`}
        <div class="field"><span class="label" id="bk-day-l">${T('patient.book.day', 'Choose a day')}</span><div class="days" role="radiogroup" aria-labelledby="bk-day-l">${days.map(x => html`<label class="pick"><input type="radio" name="date" value="${x}" data-change="book-day" ${x === sel ? 'checked' : ''} ${works.has(dowOf(x)) ? '' : 'disabled'}><span>${day(isoTs(x)).split(',')[0]}<small>${day(isoTs(x)).split(',').slice(1).join(',').trim()}</small></span></label>`)}</div></div>
        <div class="field"><span class="label" id="bk-time-l">${T('patient.book.time', 'Choose a time')}</span><div id="bk-slots" role="radiogroup" aria-labelledby="bk-time-l">${MC.skeleton(1)}</div></div>
        <div class="field"><label for="bk-r">${T('patient.book.reason', 'Reason for the visit (optional)')}</label><textarea class="input" id="bk-r" name="reason" maxlength="300" placeholder="${T('patient.book.reason_ph', 'e.g. fever for 3 days')}"></textarea></div>
        <div class="form-err notice bad" hidden></div><div id="bk-alt" hidden></div><button class="btn primary lg block" type="submit">${T('patient.book.submit', 'Book appointment')}</button></form>`}`);
    if (!d.acceptingBookings) return;
    const loadSlots = async iso => {
      const box = $('bk-slots'); if (!box) return;
      MC.view(MC.skeleton(1), box);
      const r = await api.get('/api/doctors/' + encodeURIComponent(d.membershipId) + '/slots' + qs({ date: iso }));
      const free = (r.slots || []).filter(s => s.available);
      const part = s => { const h = Number(s.time.slice(0, 2)); return h < 12 ? 0 : h < 17 ? 1 : 2; };
      const parts = [T('patient.book.morning', 'Morning'), T('patient.book.afternoon', 'Afternoon'), T('patient.book.evening', 'Evening')];
      MC.view(free.length ? html`${[0, 1, 2].map(i => { const g = free.filter(s => part(s) === i); return g.length ? html`<div class="sm muted" style="margin:4px 0 6px">${parts[i]}</div><div class="slots">${g.map(s => html`<label class="pick"><input type="radio" name="time" value="${s.time}"><span>${time(s.startUtc)}</span></label>`)}</div>` : ''; })}`
        : html`<p class="muted">${T('patient.book.no_slots', 'No free times on this day. Choose another day.')}</p>`, box);
    };
    onChange('book-day', el => loadSlots(el.value));
    await loadSlots(sel);
    form('book', async (v, f) => {
      if (!v.date) throw fail(T('patient.book.need_day', 'Choose a day'));
      if (!v.time) throw fail(T('patient.book.need_time', 'Choose a time'));
      let a;
      try { a = await api.post('/api/me/appointments', { doctorMembershipId: v.doctor, date: v.date, time: v.time, type: v.type, reason: v.reason }); }
      catch (e) { if (e.code === 'no_online_booking') { await noOnlineBooking(d, f); return; } throw e; }
      toast(T('patient.book.done', 'Appointment booked for {when}', { when: when(a.startUtc) }), 'ok');
      if (a.billId && !a.paid && a.feeKobo) {
        const pay = await dialog({ title: T('patient.book.pay_q', 'Pay for your visit now?'), body: html`<p>${a.type === 'video' ? T('patient.book.pay_video', 'Video visits must be paid before the doctor can start the call.') : T('patient.book.pay_inperson', 'You can pay now, or at the front desk when you arrive.')}</p><p><b>${money(a.feeKobo)}</b> | ${a.orgName}</p>`,
          actions: [{ label: T('patient.book.pay_later', 'Pay later'), value: false }, { label: T('patient.pay.btn', 'Pay {amount}', { amount: money(a.feeKobo) }), value: true, primary: true }] });
        if (pay) await payBill(a.billId, { amountKobo: a.feeKobo, orgName: a.orgName, returnTo: '#/more/appointments/' + a.id });
      }
      MC.go('#/more/appointments/' + a.id);
    });
  }

  /* ---------------- appointments ---------------- */
  async function appointments({ query, stale }) {
    const scope = query.scope === 'past' ? 'past' : 'upcoming';
    const rows = await api.get('/api/me/appointments' + qs({ scope, limit: 50 }));
    if (stale()) return;
    const bookBtn = has('clinic') && !needProvider() ? html`<a class="btn primary" href="#/care">${icon('plus')}${T('patient.appt.book', 'Book a doctor')}</a>` : '';
    view(html`${head(T('patient.appt.title', 'Appointments'), isProv() ? (cur() ? T('patient.appt.sub_mine', 'Your visits at {provider}', { provider: curName() }) : '') : T('patient.appt.sub', 'Your visits with every provider'), bookBtn)}
      <div class="tabs" role="tablist"><a href="#/more/appointments" role="tab" aria-selected="${scope === 'upcoming'}">${T('patient.appt.upcoming', 'Upcoming')}</a><a href="#/more/appointments?scope=past" role="tab" aria-selected="${scope === 'past'}">${T('patient.appt.past', 'Past')}</a></div>
      ${rows.length ? html`<div class="list">${rows.map(a => html`<a href="#/more/appointments/${a.id}">${icon(a.type === 'video' ? 'video' : 'calendar')}<div class="grow"><span class="title">${when(a.startUtc)}</span><span class="sub">${a.doctorName} | ${a.orgName}</span>
        <span class="sub">${a.type === 'video' ? T('patient.appt.video', 'Video visit') : T('patient.appt.in_person', 'In person')}${a.feeKobo ? ' | ' + (a.paid ? T('patient.appt.paid', 'Paid') : T('patient.appt.unpaid', 'Not paid yet')) : ''}</span></div>${sb(a.status, APPT()[a.status])}</a>`)}</div>`
        : needProvider() ? noProvider() : empty({ icon: 'calendar', title: scope === 'past' ? T('patient.appt.none_past', 'No past visits') : T('patient.appt.none', 'No upcoming appointments'), body: T('patient.appt.none_sub', 'When you book a doctor, the visit shows here.'), action: bookBtn })}`);
  }

  async function appointmentPage({ params, stale }) {
    const a = await api.get('/api/me/appointments/' + encodeURIComponent(params.id));
    const enc = a.encounterId ? (await api.get('/api/me/encounters').catch(() => [])).find(e => e.id === a.encounterId) : null;
    if (stale()) return;
    const active = ['booked', 'checked_in', 'in_consult'].includes(a.status);
    view(html`${back('#/more/appointments' + (active ? '' : '?scope=past'), T('patient.appt.title', 'Appointments'))}
      <div class="page-head"><div><h1>${a.doctorName}</h1><p>${a.orgName}${a.specialty ? ' | ' + a.specialty : ''}</p></div>${sb(a.status, APPT()[a.status])}</div>
      ${a.type === 'video' && active ? (a.canJoinVideo ? html`<a class="btn primary lg block" href="#/more/appointments/${a.id}/video" style="margin-bottom:16px">${icon('video')}${T('patient.appt.join', 'Join video visit')}</a>`
        : html`<div class="notice">${!a.paid ? T('patient.appt.video_pay', 'Pay for this visit first. The video room opens {opens}.', { opens: a.videoWindow ? when(a.videoWindow.opensAt) : '' }) : T('patient.appt.video_opens', 'The video room opens {opens}. Come back to this page then.', { opens: a.videoWindow ? when(a.videoWindow.opensAt) : '' })}</div>`) : ''}
      ${a.refundDue ? html`<div class="notice warn">${T('patient.appt.refund', 'This paid visit was cancelled. A refund is due to you: the provider will contact you.')}</div>` : ''}
      <section class="panel"><dl class="kv"><dt>${T('patient.appt.when', 'When')}</dt><dd><b>${when(a.startUtc)}</b> (${T('patient.appt.mins', '{n} minutes', { n: a.durationMin })})</dd>
        <dt>${T('patient.appt.how', 'How')}</dt><dd>${a.type === 'video' ? T('patient.appt.video', 'Video visit') : T('patient.appt.in_person', 'In person')}</dd>
        ${a.reason ? html`<dt>${T('patient.appt.reason', 'Reason')}</dt><dd>${a.reason}</dd>` : ''}
        <dt>${T('patient.appt.fee', 'Fee')}</dt><dd>${money(a.feeKobo)} ${a.paid ? badge(T('patient.appt.paid', 'Paid'), 'ok') : badge(T('patient.appt.unpaid', 'Not paid yet'), 'warn')}</dd>
        ${a.cancelReason ? html`<dt>${T('patient.appt.cancel_reason', 'Cancelled because')}</dt><dd>${a.cancelReason}</dd>` : ''}</dl>
        <div class="btn-row">${active && !a.paid && a.billId && a.feeKobo ? html`<button class="btn primary" data-action="pay" data-bill="${a.billId}" data-amount="${a.feeKobo}" data-org="${a.orgName}">${T('patient.pay.btn', 'Pay {amount}', { amount: money(a.feeKobo) })}</button>` : ''}
          ${a.canCancel ? html`<button class="btn" data-action="appt-cancel" data-id="${a.id}">${T('patient.appt.cancel', 'Cancel appointment')}</button>` : ''}</div>
        ${active && !a.canCancel ? html`<p class="muted sm" style="margin:12px 0 0">${T('patient.appt.cant_cancel', 'It is too late to cancel this visit in the app. Call {org} if you cannot come.', { org: a.orgName })}</p>` : ''}</section>
      ${enc ? html`<h2 class="sec">${T('patient.appt.summary', 'Visit summary')}</h2><section class="panel"><dl class="kv">
        ${enc.complaint ? html`<dt>${T('patient.appt.complaint', 'You came because')}</dt><dd>${enc.complaint}</dd>` : ''}
        ${(enc.diagnoses || []).length ? html`<dt>${T('patient.appt.diagnosis', 'Diagnosis')}</dt><dd>${enc.diagnoses.map(x => x.text).join('; ')}</dd>` : ''}
        ${enc.plan ? html`<dt>${T('patient.appt.plan', 'Plan')}</dt><dd>${enc.plan}</dd>` : ''}
        ${enc.followUp && (enc.followUp.date || enc.followUp.note) ? html`<dt>${T('patient.appt.followup', 'Come back')}</dt><dd>${enc.followUp.date ? date(isoTs(enc.followUp.date)) : ''} ${enc.followUp.note || ''}</dd>` : ''}</dl>
        <div class="btn-row">${enc.prescriptionCount ? html`<a class="btn" href="#/medicines">${icon('pill')}${T('patient.appt.see_rx', 'See prescriptions')}</a>` : ''}${enc.labOrderCount ? html`<a class="btn" href="#/results">${icon('flask')}${T('patient.appt.see_lab', 'See lab tests')}</a>` : ''}</div></section>` : ''}`);
    // a video visit that opens soon: refresh by itself so the Join button appears without reloading
    if (a.type === 'video' && active && !a.canJoinVideo && a.paid && a.videoWindow && a.videoWindow.opensAt - Date.now() < 3 * 3600e3) {
      MC.poll(async () => { const x = await api.get('/api/me/appointments/' + encodeURIComponent(a.id)); if (x.canJoinVideo || x.status !== a.status) MC.render(); }, 20000);
    }
  }
  on('appt-cancel', async el => {
    const v = await dialog({ title: T('patient.appt.cancel_q', 'Cancel this appointment?'), form: true, body: html`<p>${T('patient.appt.cancel_body', 'The time will be given to someone else. If you already paid, the provider will arrange your refund.')}</p><div class="field"><label for="ac-r">${T('patient.appt.cancel_why', 'Reason (optional)')}</label><input class="input" id="ac-r" name="reason" maxlength="300"></div>`,
      actions: [{ label: T('patient.appt.keep', 'Keep appointment'), value: null }, { label: T('patient.appt.cancel', 'Cancel appointment'), primary: true }], onOpen: d => { const b = d.querySelector('button[type=submit]'); b.classList.remove('primary'); b.classList.add('danger'); },
      onSubmit: d => api.post('/api/me/appointments/' + encodeURIComponent(el.dataset.id) + '/cancel', { reason: d.reason }) });
    if (v) { toast(T('patient.appt.cancelled', 'Appointment cancelled'), 'ok'); MC.render(); }
  });

  /* ---------------- video visit (WebRTC over the stored-signal endpoints) ---------------- */
  async function videoPage({ params, stale }) {
    const id = params.id; const base = '/api/video/' + encodeURIComponent(id);
    const a = await api.get('/api/me/appointments/' + encodeURIComponent(id));
    if (stale()) return;
    const top = html`${back('#/more/appointments/' + id, T('patient.video.back', 'Appointment'))}${head(T('patient.video.title', 'Video visit with {doctor}', { doctor: a.doctorName }), a.orgName)}`;
    let join;
    try { join = await api.post(base + '/join'); }
    catch (e) {
      const d = e.details || {};
      const msg = e.code === 'payment_required' ? T('patient.video.e_pay', 'Pay for this visit first. Then come back to join.') : e.code === 'too_early' ? T('patient.video.e_early', 'The video room opens {at}. Come back then.', { at: d.opensAt ? when(d.opensAt) : '' }) : e.code === 'window_closed' ? T('patient.video.e_closed', 'The time for this video visit has passed. Message the provider or book again.') : e.code === 'feature_off' ? T('patient.video.e_off', 'Video visits are switched off at the moment.') : e.message;
      view(html`${top}<div class="notice warn">${msg}</div>${e.code === 'payment_required' && a.billId ? html`<button class="btn primary" data-action="pay" data-bill="${a.billId}" data-amount="${a.feeKobo}" data-org="${a.orgName}">${T('patient.pay.btn', 'Pay {amount}', { amount: money(a.feeKobo) })}</button>` : ''}`);
      return;
    }
    view(html`${top}<div class="vstage"><video id="v-remote" autoplay playsinline></video><video id="v-local" autoplay playsinline muted></video><div class="vs"><span id="v-status">${T('patient.video.starting', 'Starting your camera...')}</span></div></div>
      <div class="btn-row" style="justify-content:center"><button class="btn" data-action="v-mic" id="v-mic">${T('patient.video.mute', 'Mute')}</button><button class="btn" data-action="v-cam" id="v-cam">${T('patient.video.cam_off', 'Camera off')}</button><button class="btn danger" data-action="v-hang">${icon('x')}${T('patient.video.hang', 'End call')}</button></div>
      <p class="muted sm" style="text-align:center">${T('patient.video.tip', 'Use Wi-Fi if you can. Stay in a quiet, well-lit place.')}</p>`);
    const status = s => { const el = $('v-status'); if (el) el.textContent = s; };
    let stream = null;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { max: 20 } } }); }
    catch (e1) { try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); toast(T('patient.video.audio_only', 'Camera not available: joining with sound only.')); } catch (e2) { stream = null; } }
    if (stale()) { if (stream) stream.getTracks().forEach(t => t.stop()); return; }
    if (!stream) {
      view(html`${top}<div class="notice bad"><b>${T('patient.video.perm_title', 'MediCore cannot use your camera or microphone')}</b><br>${T('patient.video.perm_body', 'Allow camera and microphone for this site in your browser settings (tap the lock icon next to the address), then try again.')}</div><button class="btn primary" data-action="mc-reload">${icon('refresh')}${T('patient.video.retry', 'Try again')}</button>`);
      return;
    }
    $('v-local').srcObject = stream;
    let pc = null; let remoteSet = false; let pendingIce = []; let after = join.role === 'caller' ? join.lastSeq : 0; let ended = false;
    const signal = (type, data) => api.post(base + '/signal', { type, data }).catch(() => { });
    const makePc = () => {
      if (pc) { try { pc.close(); } catch (e) { } }
      pc = new RTCPeerConnection({ iceServers: join.iceServers || [] }); remoteSet = false; pendingIce = [];
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      pc.ontrack = ev => { const r = $('v-remote'); if (r && r.srcObject !== ev.streams[0]) r.srcObject = ev.streams[0]; };
      pc.onicecandidate = ev => { if (ev.candidate) signal('ice', ev.candidate.toJSON()); };
      pc.onconnectionstatechange = () => { const s = pc.connectionState; status(s === 'connected' ? T('patient.video.connected', 'Connected with {name}', { name: join.peerName || a.doctorName }) : s === 'failed' ? T('patient.video.failed', 'The connection failed. Check your internet and try again.') : s === 'disconnected' ? T('patient.video.reconnecting', 'Connection lost, trying again...') : T('patient.video.connecting', 'Connecting...')); };
    };
    const flushIce = async () => { const q = pendingIce; pendingIce = []; for (const c of q) { try { await pc.addIceCandidate(c); } catch (e) { } } };
    makePc();
    if (join.role === 'caller') { await pc.setLocalDescription(await pc.createOffer()); await signal('offer', pc.localDescription); status(T('patient.video.calling', 'Calling {name}...', { name: join.peerName || a.doctorName })); }
    else status(T('patient.video.waiting', 'Waiting for {name} to start the call...', { name: join.peerName || a.doctorName }));
    let first = true;
    const handle = async s => {
      if (s.type === 'offer') {
        if (remoteSet) makePc();
        await pc.setRemoteDescription(s.data); remoteSet = true; await flushIce();
        await pc.setLocalDescription(await pc.createAnswer()); await signal('answer', pc.localDescription);
        status(T('patient.video.connecting', 'Connecting...'));
      } else if (s.type === 'answer' && join.role === 'caller' && !remoteSet) { await pc.setRemoteDescription(s.data); remoteSet = true; await flushIce(); }
      else if (s.type === 'ice' && s.data) { if (remoteSet) { try { await pc.addIceCandidate(s.data); } catch (e) { } } else pendingIce.push(s.data); }
      else if (s.type === 'bye') { status(T('patient.video.peer_left', '{name} ended the call.', { name: join.peerName || a.doctorName })); if (pc) { try { pc.close(); } catch (e) { } } remoteSet = false; }
    };
    const cleanup = () => { if (ended) return; ended = true; try { if (pc) pc.close(); } catch (e) { } stream.getTracks().forEach(t => t.stop()); };
    MC.onLeave(() => { if (!ended) signal('bye', {}); cleanup(); });
    const tick = async () => {
      if (ended) return;
      const r = await api.get(base + '/signals' + qs({ after }));
      let list = r.signals || [];
      if (first && join.role !== 'caller') { const lastOffer = list.map(x => x.type).lastIndexOf('offer'); list = lastOffer >= 0 ? list.slice(lastOffer) : list.filter(x => x.type !== 'bye'); }
      first = false;
      for (const s of list) await handle(s);
      after = r.lastSeq != null ? r.lastSeq : after;
    };
    await tick().catch(() => { });
    MC.poll(tick, join.pollMs || 1500);
    on('v-mic', el => { const t = stream.getAudioTracks()[0]; if (!t) return; t.enabled = !t.enabled; el.textContent = t.enabled ? T('patient.video.mute', 'Mute') : T('patient.video.unmute', 'Unmute'); });
    on('v-cam', el => { const t = stream.getVideoTracks()[0]; if (!t) return; t.enabled = !t.enabled; el.textContent = t.enabled ? T('patient.video.cam_off', 'Camera off') : T('patient.video.cam_on', 'Camera on'); });
    on('v-hang', async () => { await signal('bye', {}); cleanup(); toast(T('patient.video.ended', 'Call ended')); MC.go('#/more/appointments/' + id); });
  }

  /* ---------------- medicines ---------------- */
  async function medicines({ stale }) {
    if (needProvider()) { view(noProvider(T('patient.rx.title', 'My medicines'))); return; }
    const rx = await api.get('/api/me/prescriptions');
    if (stale()) return;
    const toSend = rx.filter(r => r.canSend);
    const inProg = rx.filter(r => r.order && !RX_DONE.includes(r.order.status));
    const past = rx.filter(r => !toSend.includes(r) && !inProg.includes(r));
    const card = r => html`<section class="panel"><div class="row between top wrap"><div class="grow">${r.items.map(itemLine)}<p class="muted sm" style="margin:8px 0 0">${[r.prescriberName, r.prescriberOrgName, date(r.createdAt)].filter(Boolean).join(' | ')}</p></div>
      <div class="end">${r.order ? sb(r.order.status, RX()[r.order.status]) : r.status === 'cancelled' ? sb('cancelled', T('patient.rx.cancelled_by_doc', 'Cancelled by the doctor')) : ''}</div></div>
      ${(r.previousOrders || []).length && r.canSend ? html`<p class="sm notice warn" style="margin:12px 0 0">${T('patient.rx.resend', 'The last pharmacy could not fill this. Send it to another pharmacy.')}</p>` : ''}
      <div class="btn-row">${r.canSend ? html`<a class="btn primary" href="#/medicines/send/${r.id}">${icon('box')}${T('patient.rx.send', 'Send to a pharmacy')}</a>` : ''}${r.order ? html`<a class="btn ${RX_DONE.includes(r.order.status) ? '' : 'primary'}" href="#/medicines/order/${r.order.id}">${T('patient.rx.track', 'Order status')}${r.order.pharmacyName ? ': ' + r.order.pharmacyName : ''}</a>` : ''}</div></section>`;
    view(html`${head(T('patient.rx.title', 'My medicines'), isProv() ? T('patient.rx.sub_mine', 'Prescriptions from {provider}. Send them to its pharmacy, or a pharmacy it works with, for pickup or delivery.', { provider: curName() }) : T('patient.rx.sub', 'Prescriptions from all your doctors. Send them to any pharmacy for pickup or delivery.'))}
      ${toSend.length ? html`<h2 class="sec">${T('patient.rx.to_send', 'Ready to send to a pharmacy')}</h2>${toSend.map(card)}` : ''}
      ${inProg.length ? html`<h2 class="sec">${T('patient.rx.in_progress', 'In progress')}</h2>${inProg.map(card)}` : ''}
      ${past.length ? html`<h2 class="sec">${T('patient.rx.past', 'Past prescriptions')}</h2>${past.map(card)}` : ''}
      ${!rx.length ? empty({ icon: 'pill', title: T('patient.rx.none', 'No prescriptions yet'), body: T('patient.rx.none_sub', 'When a doctor prescribes medicine for you on MediCore, it shows here and you can send it to a pharmacy.'), action: has('clinic') ? html`<a class="btn primary" href="#/care">${T('patient.appt.book', 'Book a doctor')}</a>` : '' }) : ''}`);
  }

  async function sendRx({ params, stale }) {
    const [rx, prof] = await Promise.all([api.get('/api/me/prescriptions'), api.get('/api/me/profile')]);
    const r = rx.find(x => x.id === params.id);
    if (!r) { view(empty({ icon: 'pill', title: T('patient.rx.not_found', 'Prescription not found'), action: html`<a class="btn" href="#/medicines">${T('patient.rx.title', 'My medicines')}</a>` })); return; }
    if (!r.canSend) { location.replace(r.order ? '#/medicines/order/' + r.order.id : '#/medicines'); return; }
    // provider mode: only the provider's own pharmacies, then pharmacies it works with (never the whole directory)
    const ph = isProv() ? await api.get('/api/me/partners' + qs({ module: 'pharmacy', lat: here && here.lat, lng: here && here.lng }))
      : await api.get('/api/directory' + qs({ module: 'pharmacy', lat: here && here.lat, lng: here && here.lng, limit: 50 }));
    if (stale()) return;
    const delOk = o => MC.feature('homeDelivery') && (o.modules || []).includes('delivery');
    const phOpt = (o, only) => html`<label class="opt"><input type="radio" name="pharmacyOrgId" value="${o.id}" data-change="rx-ph" data-delivery="${delOk(o) ? '1' : ''}" ${only ? 'checked' : ''}><span class="grow"><span class="title">${o.name}</span><span class="sub">${[o.area, o.city].filter(Boolean).join(', ')}${o.distanceKm != null ? ' | ' + T('patient.care.km', '{n} km', { n: o.distanceKm }) : ''}</span>${o.openingHours ? html`<span class="sub">${o.openingHours}</span>` : ''}</span>${delOk(o) ? badge(T('patient.care.delivers', 'Delivers'), 'ok') : badge(T('patient.send.pickup_only', 'Pickup only'), 'plain')}</label>`;
    const own = ph.filter(o => o.yours); const partners = ph.filter(o => !o.yours);
    const phList = !ph.length ? html`<p class="muted">${isProv() ? T('patient.send.no_pharm_mine', '{provider} has no pharmacy on MediCore and does not work with one yet. Ask the provider where to get your medicines.', { provider: curName() }) : T('patient.send.no_pharm', 'No pharmacies are on MediCore near you yet.')}</p>`
      : isProv() ? html`${own.length ? html`<p class="grp">${T('patient.send.yours', 'Your provider\'s pharmacy')}</p>${own.map(o => phOpt(o, ph.length === 1))}` : ''}${partners.length ? html`<p class="grp">${T('patient.send.partners', 'Works with {provider}', { provider: curName() })}</p>${partners.map(o => phOpt(o, ph.length === 1))}` : ''}`
        : ph.map(o => phOpt(o, ph.length === 1));
    const loc = { lat: prof.homeLoc ? prof.homeLoc.lat : null, lng: prof.homeLoc ? prof.homeLoc.lng : null, label: prof.address || '' };
    view(html`${back('#/medicines', T('patient.rx.title', 'My medicines'))}${head(T('patient.send.title', 'Send your prescription'), r.items.map(i => i.drugName).join(', '))}
      <form data-form="rx-send" novalidate>
        <section class="panel"><div class="row between wrap"><h2 style="margin:0">${T('patient.send.choose', '1. Choose a pharmacy')}</h2><button type="button" class="btn sm ${here ? 'primary' : ''}" data-action="near">${icon('pin')}${here ? T('patient.care.nearest_on', 'Nearest first') : T('patient.care.nearest', 'Show nearest first')}</button></div>
          <div style="margin-top:12px">${phList}</div></section>
        <section class="panel"><h2>${T('patient.send.how', '2. How do you want to get it?')}</h2>
          <label class="opt"><input type="radio" name="fulfilment" value="pickup" data-change="rx-ful" checked><span class="grow"><span class="title">${T('patient.rx.pickup', 'Pickup')}</span><span class="sub">${T('patient.send.pickup_sub', 'Collect at the pharmacy with a code we send you.')}</span></span></label>
          ${MC.feature('homeDelivery') ? html`<label class="opt"><input type="radio" name="fulfilment" value="delivery" id="ful-del" data-change="rx-ful" disabled><span class="grow"><span class="title">${T('patient.rx.delivery', 'Home delivery')}</span><span class="sub" id="ful-del-sub">${T('patient.send.delivery_sub', 'A rider brings it to you. A delivery fee is added when the pharmacy prices your order.')}</span></span></label>` : ''}
          <div id="addr-box" hidden><div class="field"><label for="rx-addr">${T('patient.send.address', 'Delivery address')}</label><input class="input" id="rx-addr" name="address" maxlength="300" value="${loc.label}" data-input="addr" autocomplete="street-address" placeholder="${T('patient.send.address_ph', 'House number, street, area, and a landmark')}"><ul class="suggest" id="addr-sug" hidden></ul>
            <div class="hint" id="addr-hint">${loc.lat != null ? T('patient.send.addr_saved', 'Using the address saved in your profile.') : T('patient.send.addr_hint', 'Add a landmark so the rider finds you quickly.')}</div></div>
            <input type="hidden" name="lat" id="rx-lat" value="${loc.lat != null ? loc.lat : ''}"><input type="hidden" name="lng" id="rx-lng" value="${loc.lng != null ? loc.lng : ''}">
            <button type="button" class="btn sm" data-action="addr-here">${icon('pin')}${T('patient.send.use_here', 'Use my current location')}</button></div></section>
        <div class="form-err notice bad" hidden></div><button class="btn primary lg block" type="submit">${T('patient.send.submit', 'Send prescription')}</button></form>`);
    let picked = loc.label; let sugs = []; let timer = null;
    onChange('rx-ph', el => { const del = $('ful-del'); if (!del) return; del.disabled = !el.dataset.delivery; $('ful-del-sub').textContent = el.dataset.delivery ? T('patient.send.delivery_sub', 'A rider brings it to you. A delivery fee is added when the pharmacy prices your order.') : T('patient.send.no_delivery', 'This pharmacy does not deliver. Choose pickup or another pharmacy.'); if (del.disabled && del.checked) { del.checked = false; document.querySelector('input[name=fulfilment][value=pickup]').checked = true; $('addr-box').hidden = true; } });
    onChange('rx-ful', el => { $('addr-box').hidden = el.value !== 'delivery'; });
    { const pre = document.querySelector('input[name=pharmacyOrgId]:checked'); if (pre) changeH['rx-ph'](pre); }
    onInput('addr', el => {
      if (el.value !== picked) { $('rx-lat').value = ''; $('rx-lng').value = ''; $('addr-hint').textContent = T('patient.send.addr_hint', 'Add a landmark so the rider finds you quickly.'); }
      clearTimeout(timer); const q = el.value.trim();
      if (q.length < 4) { $('addr-sug').hidden = true; return; }
      timer = setTimeout(async () => {
        try { const res = await api.get('/api/geo/search' + qs({ q, lat: here && here.lat, lng: here && here.lng })); sugs = (res.results || []).slice(0, 5); } catch (e) { sugs = []; }
        const box = $('addr-sug'); if (!box) return;
        MC.view(html`${sugs.map((s, i) => html`<li><button type="button" data-action="addr-pick" data-i="${i}">${s.label}</button></li>`)}`, box); box.hidden = !sugs.length;
      }, 450);
    });
    on('addr-pick', el => { const s = sugs[Number(el.dataset.i)]; if (!s) return; picked = s.label; $('rx-addr').value = s.label; $('rx-lat').value = s.lat; $('rx-lng').value = s.lng; $('addr-sug').hidden = true; $('addr-hint').textContent = T('patient.send.addr_found', 'Address found on the map. Add a landmark if you can.'); });
    on('addr-here', async () => {
      toast(T('patient.care.locating', 'Finding your location...'));
      const p = await MC.position();
      if (!p) { toast(T('patient.send.noloc', 'Location is not available. Type your address instead.'), 'bad'); return; }
      $('rx-lat').value = p.lat; $('rx-lng').value = p.lng;
      let label = null; try { label = (await api.get('/api/geo/reverse' + qs({ lat: p.lat, lng: p.lng }))).label; } catch (e) { label = null; }
      const inp = $('rx-addr'); if (label && !inp.value) inp.value = label; picked = inp.value;
      $('addr-hint').textContent = T('patient.send.addr_gps', 'Your location is saved for the rider. Add house number and landmark in the box.');
    });
    form('rx-send', async v => {
      if (!v.pharmacyOrgId) throw fail(T('patient.send.need_ph', 'Choose a pharmacy'));
      const body = { pharmacyOrgId: v.pharmacyOrgId, fulfilment: v.fulfilment || 'pickup' };
      if (body.fulfilment === 'delivery') {
        if (!v.address || v.address.length < 5) throw fail(T('patient.send.need_addr', 'Type your delivery address'), 'address');
        body.address = v.address; if (v.lat && v.lng) body.location = { lat: Number(v.lat), lng: Number(v.lng) };
      }
      const o = await api.post('/api/me/prescriptions/' + encodeURIComponent(r.id) + '/send', body);
      toast(T('patient.send.done', 'Prescription sent to {pharmacy}', { pharmacy: o.pharmacy ? o.pharmacy.name : '' }), 'ok');
      MC.go('#/medicines/order/' + o.id);
    });
  }

  async function orderPage({ params, stale }) {
    let o = await api.get('/api/me/rx-orders/' + encodeURIComponent(params.id));
    if (stale()) return;
    const dlvSteps = ['received', 'verified', 'priced', 'paid', 'ready', 'out_for_delivery', 'delivered'];
    const pickSteps = ['received', 'verified', 'priced', 'paid', 'ready', 'collected'];
    let d = null; let m = null;
    const getD = async () => { d = o.delivery && o.delivery.id ? await api.get('/api/me/deliveries/' + encodeURIComponent(o.delivery.id)).catch(() => null) : null; };
    await getD();
    if (stale()) return;
    view(html`${back('#/medicines', T('patient.rx.title', 'My medicines'))}<div id="ord-main"></div><div id="ord-track"></div>`);
    const draw = () => {
      const steps = o.fulfilment === 'delivery' ? dlvSteps : pickSteps;
      const st = o.status === 'allocating' ? 'paid' : o.status === 'queried' ? 'received' : o.status;
      const billOpen = o.bill && o.bill.status === 'open' && o.bill.patientDueKobo - o.bill.paidKobo > 0;
      const ph = o.pharmacy || {};
      MC.view(html`<div class="page-head"><div><h1>${ph.name || T('patient.order.title', 'Your order')}</h1><p>${o.fulfilment === 'delivery' ? T('patient.rx.delivery', 'Home delivery') : T('patient.rx.pickup', 'Pickup')} | ${date(o.createdAt)}</p></div>${sb(o.status, RX()[o.status])}</div>
        ${['rejected', 'cancelled'].includes(o.status) ? html`<div class="notice bad"><b>${RX()[o.status]}</b>${o.message ? html`<br>${o.message}` : ''}${o.refundDue ? html`<br>${T('patient.order.refund', 'A refund of {amount} is due to you. The pharmacy will arrange it.', { amount: money(o.refundDue.amountKobo) })}` : ''}</div><div class="btn-row" style="margin-bottom:16px"><a class="btn primary" href="#/medicines/send/${o.prescriptionId}">${T('patient.order.other', 'Send to another pharmacy')}</a></div>` : MC.steps(steps, st, RX_STEP())}
        ${o.status === 'queried' ? html`<div class="notice warn"><b>${T('patient.order.query', 'The pharmacist has a question for your doctor')}</b>${o.message ? html`<br>${o.message}` : ''}<br>${T('patient.order.query_sub', 'You do not need to do anything now. We will tell you when it moves on.')}</div>` : ''}
        ${o.status === 'received' ? html`<div class="notice">${T('patient.order.received', 'The pharmacist is checking your prescription. You will be told the price soon.')}</div>` : ''}
        ${o.status === 'verified' ? html`<div class="notice">${T('patient.order.verified', 'Checked. The pharmacy is preparing the price.')}</div>` : ''}
        ${o.status === 'ready' && o.fulfilment === 'pickup' ? html`<section class="panel"><h2>${T('patient.order.pickup_title', 'Ready for pickup')}</h2>
          ${o.pickupCode ? html`<p>${T('patient.order.pickup_show', 'Show this code at the pharmacy counter:')}</p><div class="bigcode" aria-label="${T('patient.order.code', 'Pickup code')}">${o.pickupCode}</div>` : html`<div class="notice warn">${o.message || T('patient.order.code_locked', 'The pickup code is locked. Ask the pharmacist to send you a new one.')}</div>`}
          ${o.collectBy ? html`<p class="sm">${T('patient.order.collect_by', 'Please collect by {date}.', { date: day(o.collectBy) })}</p>` : ''}
          <p class="sm muted" style="margin:0">${[ph.address, ph.phone].filter(Boolean).join(' | ')}</p>${ph.phone ? html`<div class="btn-row"><a class="btn" href="tel:${ph.phone}">${icon('phone')}${T('patient.prov.call', 'Call')}</a></div>` : ''}</section>` : ''}
        ${o.lines && o.lines.length ? html`<section class="panel"><h2>${T('patient.order.items', 'Your medicines')}</h2>${o.lines.map(l => html`<div class="card-line"><span>${l.name}${l.supplied === false ? html` <span class="badge warn">${T('patient.order.not_supplied', 'Not available here')}</span>` : html` x ${l.qty}`}${l.substituted ? html`<br><span class="xs muted">${T('patient.order.subst', 'Same medicine, different brand')}${l.substitutionReason ? ': ' + l.substitutionReason : ''}</span>` : ''}</span><b>${money(l.totalKobo)}</b></div>`)}
          ${o.deliveryFeeKobo ? html`<div class="card-line"><span>${T('patient.order.delivery_fee', 'Delivery fee')}</span><b>${money(o.deliveryFeeKobo)}</b></div>` : ''}
          ${o.bill && o.bill.hmo && o.bill.hmo.coveredKobo ? html`<div class="card-line"><span>${T('patient.bill.hmo', 'Paid by your HMO')}</span><b>-${money(o.bill.hmo.coveredKobo)}</b></div>` : ''}
          <div class="card-line"><b>${billOpen ? T('patient.order.to_pay', 'To pay') : T('patient.order.total', 'Total')}</b><b>${money(o.bill ? o.bill.patientDueKobo - (billOpen ? o.bill.paidKobo : 0) : o.totalKobo)}</b></div>
          ${billOpen ? html`<div class="btn-row"><button class="btn primary lg" data-action="pay" data-bill="${o.bill.id}" data-amount="${o.bill.patientDueKobo - o.bill.paidKobo}" data-org="${ph.name || ''}">${T('patient.pay.btn', 'Pay {amount}', { amount: money(o.bill.patientDueKobo - o.bill.paidKobo) })}</button></div>` : ''}</section>`
          : html`<section class="panel"><h2>${T('patient.order.prescribed', 'Prescribed')}</h2>${(o.items || []).map(itemLine)}</section>`}
        ${o.address ? html`<p class="sm"><b>${T('patient.send.address', 'Delivery address')}:</b> ${o.address}</p>` : ''}
        ${['received', 'queried', 'verified', 'priced'].includes(o.status) ? html`<div class="btn-row"><button class="btn" data-action="rx-cancel" data-id="${o.id}">${T('patient.order.cancel', 'Cancel order')}</button></div>` : ''}`, $('ord-main'));
    };
    const drawTrack = async () => {
      const box = $('ord-track'); if (!box) return;
      if (!d || !['pending', 'assigned', 'picked_up', 'delivered', 'failed', 'returned'].includes(d.status)) { MC.view('', box); return; }
      const live = ['assigned', 'picked_up'].includes(d.status);
      if (!$('trk-info')) MC.view(html`<h2 class="sec">${T('patient.dlv.title', 'Delivery')}</h2><div id="trk-info"></div>${live ? html`<div class="map" id="trk-map" aria-label="${T('patient.dlv.map', 'Map of the rider and your address')}"></div><p class="xs muted" id="trk-note"></p>` : ''}`, box);
      MC.view(html`<section class="panel"><div class="row between wrap top"><div><b>${DLV()[d.status] || cap(d.status)}</b>
          ${d.etaMinutes != null && d.status === 'picked_up' ? html`<div class="eta">${T('patient.dlv.eta_short', 'About {n} min', { n: d.etaMinutes })}</div>` : ''}
          ${d.rider ? html`<div class="sm">${T('patient.dlv.rider', 'Rider')}: <b>${d.rider.firstName}</b>${d.rider.vehicle ? ' | ' + T('patient.dlv.vehicle.' + d.rider.vehicle, cap(d.rider.vehicle)) : ''}</div>` : ''}
          ${d.status === 'picked_up' && !d.riderLocation ? html`<div class="sm muted">${T('patient.dlv.no_gps', 'Waiting for the rider\'s location...')}</div>` : ''}</div>
          ${d.pharmacy && d.pharmacy.phone ? html`<a class="btn" href="tel:${d.pharmacy.phone}">${icon('phone')}${T('patient.dlv.call', 'Call pharmacy')}</a>` : ''}</div>
        ${d.status !== 'delivered' && d.deliveryCode ? html`<p style="margin:12px 0 0">${T('patient.dlv.code_hint', 'Give this code to the rider only when you have your medicines in hand:')}</p><div class="bigcode" aria-label="${T('patient.dlv.code', 'Delivery code')}">${d.deliveryCode}</div>` : ''}
        ${d.codeLocked ? html`<div class="notice warn">${T('patient.dlv.locked', 'The delivery code is locked after wrong tries. The pharmacy will send you a new one.')}</div>` : ''}
        ${d.status === 'failed' ? html`<div class="notice warn">${T('patient.dlv.failed_sub', 'The rider could not deliver. The pharmacy will contact you to try again.')}</div>` : ''}</section>`, $('trk-info'));
      if (live && !m && $('trk-map')) { m = await safeMap($('trk-map'), d.destination || d.riderLocation, $('trk-note')); }
      if (m) { if (d.destination) m.setMarker('home', d.destination, { label: T('patient.map.you', 'You'), kind: 'patient' }); if (d.riderLocation) m.setMarker('rider', d.riderLocation, { label: d.rider ? d.rider.firstName : T('patient.dlv.rider', 'Rider'), kind: 'rider' }); m.fit(); }
    };
    draw(); await drawTrack();
    if (RX_DONE.includes(o.status)) return;
    let n = 0;
    MC.poll(async () => {
      n++;
      if (d && ['assigned', 'picked_up'].includes(d.status)) { d = await api.get('/api/me/deliveries/' + encodeURIComponent(d.id)); await drawTrack(); }
      if (n % 3 === 0) { const prev = o.status; o = await api.get('/api/me/rx-orders/' + encodeURIComponent(params.id)); if (o.status !== prev || (o.delivery && (!d || o.delivery.status !== d.status))) { await getD(); draw(); await drawTrack(); } }
    }, 5000);
  }
  on('rx-cancel', async el => {
    if (!(await confirm({ title: T('patient.order.cancel_q', 'Cancel this order?'), body: T('patient.order.cancel_body', 'The pharmacy will stop preparing it. Your prescription comes back to you so you can send it elsewhere.'), ok: T('patient.order.cancel', 'Cancel order'), cancel: T('patient.order.keep', 'Keep order'), danger: true }))) return;
    await api.post('/api/me/rx-orders/' + encodeURIComponent(el.dataset.id) + '/cancel', {});
    toast(T('patient.order.cancelled', 'Order cancelled'), 'ok'); MC.render();
  });

  /* ---------------- results ---------------- */
  async function results({ stale }) {
    if (needProvider()) { view(noProvider(T('patient.lab.title', 'Results'))); return; }
    const rows = await api.get('/api/me/lab-orders');
    if (stale()) return;
    const choose = rows.filter(o => o.status === 'awaiting_lab'); const prog = rows.filter(o => !['awaiting_lab', 'released', 'cancelled'].includes(o.status)); const done = rows.filter(o => o.status === 'released'); const canc = rows.filter(o => o.status === 'cancelled');
    const row = o => html`<a href="${o.status === 'awaiting_lab' ? '#/results/lab/' + o.id + '/choose' : '#/results/lab/' + o.id}">${icon('flask')}<div class="grow"><span class="title">${o.tests.map(x => x.name).join(', ')}</span><span class="sub">${[o.lab ? o.lab.name : null, o.orderedByName || (o.selfRequested ? T('patient.lab.self', 'Requested by you') : null), date(o.releasedAt || o.createdAt)].filter(Boolean).join(' | ')}</span></div>${o.status === 'ordered' && !o.paid && o.bill && o.bill.status === 'open' ? badge(T('patient.lab.to_pay', 'To pay'), 'warn') : sb(o.status, labLabel(o))}</a>`;
    const labBtn = isProv() ? (has('lab') ? html`<a class="btn" href="#/care?type=lab">${icon('flask')}${T('patient.lab.request_mine', 'Request lab tests')}</a>` : '') : html`<a class="btn" href="#/care?type=lab">${icon('flask')}${T('patient.home.t_lab', 'Find a lab')}</a>`;
    view(html`${head(T('patient.lab.title', 'Results'), isProv() ? T('patient.lab.sub_mine', 'Lab tests and reports from {provider}.', { provider: curName() }) : T('patient.lab.sub', 'Lab tests from all your doctors, and your reports.'), labBtn)}
      ${choose.length ? html`<h2 class="sec">${T('patient.lab.choose_h', 'Choose a lab for these tests')}</h2><div class="list">${choose.map(row)}</div>` : ''}
      ${prog.length ? html`<h2 class="sec">${T('patient.lab.prog_h', 'In progress')}</h2><div class="list">${prog.map(row)}</div>` : ''}
      ${done.length ? html`<h2 class="sec">${T('patient.lab.done_h', 'Your results')}</h2><div class="list">${done.map(row)}</div>` : ''}
      ${canc.length ? html`<h2 class="sec">${T('patient.lab.canc_h', 'Cancelled')}</h2><div class="list">${canc.map(row)}</div>` : ''}
      ${!rows.length ? empty({ icon: 'flask', title: T('patient.lab.none', 'No lab tests yet'), body: T('patient.lab.none_sub', 'Tests your doctor orders, and their results, show here.') }) : ''}`);
  }

  async function chooseLab({ params, stale }) {
    const o = (await api.get('/api/me/lab-orders')).find(x => x.id === params.id);
    if (!o) { view(empty({ icon: 'flask', title: T('patient.lab.not_found', 'Lab order not found'), action: html`<a class="btn" href="#/results">${T('patient.lab.title', 'Results')}</a>` })); return; }
    if (o.status !== 'awaiting_lab') { location.replace('#/results/lab/' + o.id); return; }
    let labs = await api.get('/api/labs' + qs({ codes: o.tests.map(x => x.code).join(','), lat: here && here.lat, lng: here && here.lng }));
    // provider mode: only the provider's own labs, then labs it works with (the public lab list is not scoped, so filter it)
    let mine = null;
    if (isProv()) { const part = await api.get('/api/me/partners' + qs({ module: 'lab', lat: here && here.lat, lng: here && here.lng })); mine = {}; part.forEach(x => { mine[x.id] = x; }); labs = labs.filter(l => mine[l.id]); }
    if (stale()) return;
    const labOpt = l => html`<label class="opt"><input type="radio" name="labOrgId" value="${l.id}" ${labs.length === 1 ? 'checked' : ''}><span class="grow"><span class="title">${l.name}</span><span class="sub">${[l.area, l.city].filter(Boolean).join(', ')}${l.distanceKm != null ? ' | ' + T('patient.care.km', '{n} km', { n: l.distanceKm }) : ''}</span><span class="sub">${T('patient.prov.tat', 'Results in about {n} hours', { n: l.tatHours })}${l.openingHours ? ' | ' + l.openingHours : ''}</span></span><b>${money(l.totalKobo)}</b></label>`;
    const ownL = mine ? labs.filter(l => mine[l.id].yours) : labs; const partL = mine ? labs.filter(l => !mine[l.id].yours) : [];
    const provName = o.referringOrgName || curName();
    view(html`${back('#/results', T('patient.lab.title', 'Results'))}${head(T('patient.lab.choose_title', 'Choose a lab'), o.tests.map(x => x.name).join(', '))}
      ${o.orderedByName ? html`<p class="muted sm">${T('patient.lab.ordered_by', 'Ordered by {doctor}, {org}', { doctor: o.orderedByName, org: o.referringOrgName || '' })}</p>` : ''}
      <form data-form="lab-send" novalidate><div class="row between wrap" style="margin-bottom:12px"><span class="muted sm">${T('patient.lab.all_tests', 'These labs can do all your tests.')}</span><button type="button" class="btn sm ${here ? 'primary' : ''}" data-action="near">${icon('pin')}${here ? T('patient.care.nearest_on', 'Nearest first') : T('patient.care.nearest', 'Show nearest first')}</button></div>
        ${labs.length ? (mine ? html`${ownL.length ? html`<p class="grp">${T('patient.lab.yours', 'Your provider\'s lab')}</p>${ownL.map(labOpt)}` : ''}${partL.length ? html`<p class="grp">${T('patient.lab.partners', 'Works with {provider}', { provider: curName() })}</p>${partL.map(labOpt)}` : ''}` : labs.map(labOpt))
          : empty({ icon: 'flask', title: mine ? T('patient.lab.no_labs_mine', 'No lab of {provider}, or one it works with, does all these tests yet', { provider: provName }) : T('patient.lab.no_labs', 'No lab on MediCore does all these tests yet'), body: T('patient.lab.no_labs_sub', 'Ask your doctor, or message the provider.') })}
        <div class="form-err notice bad" hidden></div>${labs.length ? html`<button class="btn primary lg block" type="submit">${T('patient.lab.send', 'Send to this lab')}</button>` : ''}</form>`);
    form('lab-send', async v => {
      if (!v.labOrgId) throw fail(T('patient.lab.need_lab', 'Choose a lab'));
      const u = await api.post('/api/me/lab-orders/' + encodeURIComponent(o.id) + '/send', { labOrgId: v.labOrgId });
      toast(T('patient.lab.sent', 'Sent to {lab}', { lab: u.lab ? u.lab.name : '' }), 'ok');
      if (u.billId && u.bill && u.bill.status === 'open' && u.bill.patientDueKobo - u.bill.paidKobo > 0) await payBill(u.billId, { amountKobo: u.bill.patientDueKobo - u.bill.paidKobo, orgName: u.lab ? u.lab.name : '', returnTo: '#/results/lab/' + u.id });
      MC.go('#/results/lab/' + u.id);
    });
  }

  const FLAG = () => ({ normal: T('patient.lab.f.normal', 'Normal'), low: T('patient.lab.f.low', 'Low'), high: T('patient.lab.f.high', 'High'), abnormal: T('patient.lab.f.abnormal', 'Not normal'), unverified: T('patient.lab.f.unverified', 'Ask the lab') });
  async function labPage({ params, stale }) {
    const o = (await api.get('/api/me/lab-orders')).find(x => x.id === params.id);
    if (!o) { view(empty({ icon: 'flask', title: T('patient.lab.not_found', 'Lab order not found'), action: html`<a class="btn" href="#/results">${T('patient.lab.title', 'Results')}</a>` })); return; }
    if (o.status === 'awaiting_lab') { location.replace('#/results/lab/' + o.id + '/choose'); return; }
    const rep = o.status === 'released' ? await api.get('/api/me/lab-orders/' + encodeURIComponent(o.id) + '/report') : null;
    if (stale()) return;
    const st = ['resulted', 'verified'].includes(o.status) ? 'in_progress' : o.status;
    const billOpen = o.bill && o.bill.status === 'open' && o.bill.patientDueKobo - o.bill.paidKobo > 0;
    const crit = rep && rep.results.some(r => r.critical);
    const range = r => r.range ? (r.range.normalText || (r.range.low != null || r.range.high != null ? (r.range.low != null ? r.range.low : '') + ' - ' + (r.range.high != null ? r.range.high : '') + (r.unit ? ' ' + r.unit : '') : '')) : '';
    view(html`${back('#/results', T('patient.lab.title', 'Results'))}
      <div class="page-head"><div><h1>${o.tests.map(x => x.name).join(', ')}</h1><p>${[o.lab ? o.lab.name : null, o.number].filter(Boolean).join(' | ')}</p></div>${sb(o.status, labLabel(o))}</div>
      ${o.status === 'cancelled' ? html`<div class="notice">${T('patient.lab.cancelled', 'This test was cancelled.')}</div>` : MC.steps(LAB_STEPS, st, LAB_STEP())}
      ${billOpen ? html`<section class="panel"><div class="row between wrap"><div><b>${T('patient.lab.pay_first', 'Pay so the lab can take your sample')}</b><div class="muted sm">${o.lab ? o.lab.name : ''}</div></div><button class="btn primary lg" data-action="pay" data-bill="${o.billId}" data-amount="${o.bill.patientDueKobo - o.bill.paidKobo}" data-org="${o.lab ? o.lab.name : ''}">${T('patient.pay.btn', 'Pay {amount}', { amount: money(o.bill.patientDueKobo - o.bill.paidKobo) })}</button></div></section>` : ''}
      ${o.status === 'paid' ? html`<div class="notice">${T('patient.lab.go', 'Paid. Go to {lab} to give your sample. Show your name and this number: {n}.', { lab: o.lab ? o.lab.name : '', n: o.number })}${o.lab && o.lab.phone ? html` <a href="tel:${o.lab.phone}">${o.lab.phone}</a>` : ''}</div>` : ''}
      ${['sample_collected', 'in_progress', 'resulted', 'verified'].includes(o.status) ? html`<div class="notice">${T('patient.lab.wait', 'The lab is working on your test. We will tell you when the results are ready.')}</div>` : ''}
      ${rep ? html`${crit ? html`<div class="alert major" role="alert">${icon('alert')}<div><b>${T('patient.lab.crit_title', 'A result needs urgent attention')}</b>${T('patient.lab.crit_body', 'Contact your doctor or the lab today. If you feel very unwell, press SOS or call 112.')}</div></div>` : ''}
        <div class="table-wrap" style="margin-top:12px"><table class="t stack-sm"><thead><tr><th>${T('patient.lab.test', 'Test')}</th><th>${T('patient.lab.result', 'Result')}</th><th>${T('patient.lab.range', 'Usual range')}</th><th>${T('patient.lab.flag', 'Flag')}</th></tr></thead><tbody>
          ${rep.results.map(r => html`<tr class="${r.critical ? 'crit' : ''}"><td data-label="${T('patient.lab.test', 'Test')}"><b>${r.name}</b></td><td data-label="${T('patient.lab.result', 'Result')}"><b>${r.value}</b> ${r.unit || ''}</td><td data-label="${T('patient.lab.range', 'Usual range')}">${range(r)}</td>
            <td data-label="${T('patient.lab.flag', 'Flag')}">${r.critical ? html`<span class="flag-critical">${T('patient.lab.f.critical', 'Critical')}</span>` : html`<span class="flag-${r.flag}">${FLAG()[r.flag] || cap(r.flag)}</span>`}${r.comment ? html`<br><span class="xs muted">${r.comment}</span>` : ''}</td></tr>`)}</tbody></table></div>
        <p class="muted sm" style="margin-top:8px">${[rep.verifiedBy ? T('patient.lab.verified_by', 'Checked by {name}', { name: rep.verifiedBy.name }) : null, rep.releasedAt ? dateTime(rep.releasedAt) : null, rep.amended ? T('patient.lab.amended', 'Updated by the lab (version {v})', { v: rep.version }) : null].filter(Boolean).join(' | ')}</p>
        ${MC.feature('ai') && MC.feature('aiLabExplainer') ? html`<div class="btn-row"><button class="btn" data-action="lab-explain" data-id="${o.id}">${icon('message')}${T('patient.lab.explain', 'Explain my result')}</button></div><div id="lab-exp"></div>` : ''}
        <div class="btn-row no-print"><button class="btn ghost" data-action="print">${icon('download')}${T('patient.lab.print', 'Print or save as PDF')}</button></div>
        <p class="muted sm">${T('patient.lab.doctor_note', 'Your doctor will explain what these results mean for you.')}</p>` : ''}`);
  }
  on('print', () => window.print());
  on('lab-explain', async el => {
    const r = await api.post('/api/me/ai/explain-lab/' + encodeURIComponent(el.dataset.id), { lang: MC.lang });
    MC.view(html`<section class="panel" style="margin-top:12px"><h3>${T('patient.lab.explain_h', 'What these tests mean')}</h3>${r.critical ? html`<div class="notice bad">${r.reply}</div>` : html`<p style="white-space:pre-wrap">${r.reply}</p>`}<p class="xs muted" style="margin:0">${r.disclaimer || content('aiDisclaimer', '')}</p></section>`, $('lab-exp'));
  });

  /* ---------------- health assistant ---------------- */
  const TRIAGE = () => ({ info: T('patient.ai.tri.info', 'General information'), self_care: T('patient.ai.tri.self_care', 'Care for yourself at home'), see_pharmacist: T('patient.ai.tri.see_pharmacist', 'Talk to a pharmacist'), see_doctor_routine: T('patient.ai.tri.see_doctor_routine', 'See a doctor when you can'), see_doctor_soon: T('patient.ai.tri.see_doctor_soon', 'See a doctor soon'), lab_test: T('patient.ai.tri.lab_test', 'A lab test can help'), emergency: T('patient.ai.tri.emergency', 'Emergency') });
  const AI_ACTIONS = { emergency: ['sos'], see_doctor_soon: ['book'], see_doctor_routine: ['book'], lab_test: ['lab', 'book'], see_pharmacist: ['pharmacy'], self_care: ['book'], info: [] };
  let chat = { id: null, msgs: [], specialty: null };
  function bubble(m) {
    if (m.role === 'user') return html`<div class="bub me"><span class="who">${T('patient.ai.you', 'You')}</span>${m.content}</div>`;
    if (m.pending) return html`<div class="bub them" aria-busy="true"><span class="who">${T('patient.ai.name', 'Health assistant')}</span>${T('patient.ai.thinking', 'Thinking...')}</div>`;
    const acts = (m.actions || (AI_ACTIONS[m.triage] || []).map(type => ({ type }))).map(a => a.type);
    const urgent = m.triage === 'emergency';
    const spec = m.specialty || chat.specialty;
    return html`<div class="bub them ${urgent ? 'urgent' : ''}" ${urgent ? MC.raw('role="alert"') : ''}>${urgent ? html`<span class="urgent-h">${icon('alert')}${T('patient.ai.urgent', 'This may be an emergency')}</span>` : html`<span class="who">${T('patient.ai.name', 'Health assistant')}</span>`}${m.reply}
      ${m.followUpQuestion ? html`<br><i>${m.followUpQuestion}</i>` : ''}
      <div class="acts">${m.triage && m.triage !== 'info' && !urgent ? badge(TRIAGE()[m.triage] || cap(m.triage), 'info') : ''}
      ${acts.map(t => t === 'sos' ? html`<button class="btn danger lg" data-action="sos">${icon('sos')}${T('patient.ai.act.sos', 'Press SOS: send an ambulance')}</button>`
        : needProvider() ? (t === 'book' || t === 'lab' || t === 'pharmacy' ? html`<a class="btn sm" href="#/more/join">${icon('building')}${T('patient.ai.act.join', 'Join a provider to get care')}</a>` : '')
        : t === 'book' && has('clinic') ? html`<a class="btn sm" href="#/care${spec ? '?specialty=' + encodeURIComponent(spec) : ''}">${icon('steth')}${T('patient.ai.act.book', 'Book a doctor')}</a>`
          : t === 'lab' && has('lab') ? html`<a class="btn sm" href="#/care?type=lab">${icon('flask')}${T('patient.ai.act.lab', 'Book a lab test')}</a>`
            : t === 'pharmacy' && has('pharmacy') ? html`<a class="btn sm" href="#/care?type=pharmacy">${icon('pill')}${isProv() ? T('patient.ai.act.pharmacy_mine', 'Pharmacy at {provider}', { provider: curName() }) : T('patient.ai.act.pharmacy', 'Find a pharmacy')}</a>` : '')}</div></div>`;
  }
  function drawChat() {
    const box = $('ai-chat'); if (!box) return;
    MC.view(chat.msgs.length ? html`${chat.msgs.map(bubble)}` : html`<div class="bub them"><span class="who">${T('patient.ai.name', 'Health assistant')}</span>${T('patient.ai.hello', 'Hello. Tell me what is going on, in a few words. For example: "I have had a fever since yesterday".')}</div>
      <div class="chips">${[T('patient.ai.s1', 'I have a fever'), T('patient.ai.s2', 'My child has diarrhoea'), T('patient.ai.s3', 'Where can I test for malaria?'), T('patient.ai.s4', 'I have a headache')].map(s => html`<button type="button" class="chip" data-action="ai-suggest" data-text="${s}">${s}</button>`)}</div>`, box);
    const last = box.lastElementChild; if (last && chat.msgs.length) last.scrollIntoView({ block: 'nearest' });
  }
  async function assistant({ query, stale }) {
    if (!aiOn()) { view(html`${head(T('patient.ai.title', 'Health assistant'))}${empty({ icon: 'message', title: T('patient.ai.off', 'The health assistant is not available yet'), body: T('patient.ai.off_sub', 'You can still book a doctor, message your provider, or press SOS in an emergency.'), action: html`<a class="btn" href="#/care">${T('patient.appt.book', 'Book a doctor')}</a>` })}`); return; }
    const s = await api.get('/api/me/ai/status');
    if (stale()) return;
    if (!s.enabled) { view(html`${head(T('patient.ai.title', 'Health assistant'))}${empty({ icon: 'message', title: T('patient.ai.off', 'The health assistant is not available yet'), body: T('patient.ai.off_sub', 'You can still book a doctor, message your provider, or press SOS in an emergency.') })}`); return; }
    if (!s.consented) {
      view(html`${head(T('patient.ai.title', 'Health assistant'), T('patient.ai.consent_sub', 'Before you start, please read how it works.'))}
        <form class="panel" data-form="ai-consent" novalidate><ul class="stack" style="padding-left:20px;margin:0 0 16px">
          <li>${T('patient.ai.c1', 'The assistant gives general health information and helps you use MediCore. It is not a doctor: it cannot diagnose you or prescribe medicine.')}</li>
          <li><b>${T('patient.ai.c2', 'In an emergency, do not wait for it: press SOS or call 112.')}</b></li>
          <li>${T('patient.ai.c3', 'What you type is sent to our AI service so it can answer. We do not send your name, phone number or address.')}</li>
          <li>${T('patient.ai.c4', 'Conversations are kept for 90 days so you can read them again. You can delete them at any time.')}</li></ul>
          <label class="check"><input type="checkbox" name="shareProfile"><span><b>${T('patient.ai.share', 'Also use my health details (optional)')}</b><br><span class="sm muted">${T('patient.ai.share_sub', 'Your age group, sex, allergies and known conditions help it give safer answers. You can change this later.')}</span></span></label>
          <div class="form-err notice bad" hidden></div><div class="btn-row"><button class="btn primary lg" type="submit">${T('patient.ai.accept', 'I understand, start')}</button><a class="btn" href="#/">${T('patient.ai.not_now', 'Not now')}</a></div></form>`);
      form('ai-consent', async d => { await api.post('/api/me/ai/consent', { accept: true, shareProfile: !!d.shareProfile }); toast(T('patient.ai.ready', 'The assistant is ready'), 'ok'); MC.render(); });
      return;
    }
    const convs = await api.get('/api/me/ai/conversations');
    if (stale()) return;
    const c = query.c ? convs.find(x => x.id === query.c) : null;
    chat = { id: c ? c.id : null, msgs: c ? c.messages.map(m => Object.assign({}, m)) : [], specialty: null, share: s.shareProfile, convs };
    view(html`${head(T('patient.ai.title', 'Health assistant'), null, html`<a class="btn sm" href="#/more/assistant">${icon('plus')}${T('patient.ai.new', 'New conversation')}</a>${convs.length ? html`<button class="btn sm" data-action="ai-history">${icon('clock')}${T('patient.ai.history', 'Past conversations')}</button>` : ''}<button class="btn sm ghost" data-action="ai-settings" aria-label="${T('patient.ai.settings', 'Assistant settings')}">${icon('settings')}</button>`)}
      <div class="notice">${s.disclaimer || content('aiDisclaimer', 'The MediCore assistant gives general health information, not a diagnosis. In an emergency press SOS or call 112.')}${s.mode === 'rules' ? html`<br><span class="xs muted">${T('patient.ai.basic', 'Basic mode: short standard answers for common questions.')}</span>` : ''}</div>
      <div class="chat" id="ai-chat" aria-live="polite"></div>
      <form class="composer" data-form="ai-send" novalidate><label for="ai-msg" class="sr-only">${T('patient.ai.msg', 'Your message')}</label><textarea class="input" id="ai-msg" name="message" maxlength="1500" placeholder="${T('patient.ai.ph', 'Type your question...')}" enterkeyhint="send"></textarea><button class="btn primary" type="submit" aria-label="${T('patient.ai.send', 'Send')}">${icon('nav')}${T('patient.ai.send', 'Send')}</button></form>
      ${chat.id ? html`<div class="btn-row"><button class="btn ghost sm" data-action="ai-del" data-id="${chat.id}">${icon('trash')}${T('patient.ai.delete', 'Delete this conversation')}</button></div>` : ''}`);
    drawChat();
    form('ai-send', async (d, f) => {
      const text = (d.message || '').trim(); if (!text) return;
      f.querySelector('textarea').value = '';
      await sendAi(text);
    });
  }
  async function sendAi(text) {
    chat.msgs.push({ role: 'user', content: text }); chat.msgs.push({ pending: true }); drawChat();
    try {
      const r = await api.post('/api/me/ai/chat', { conversationId: chat.id || undefined, message: text, lang: MC.lang });
      chat.msgs.pop();
      const fresh = !chat.id; chat.id = r.conversationId; if (r.specialty) chat.specialty = r.specialty;
      chat.msgs.push({ role: 'assistant', reply: r.reply, triage: r.triage, actions: r.actions, specialty: r.specialty, followUpQuestion: r.followUpQuestion });
      drawChat();
      if (fresh) history.replaceState(null, '', '#/more/assistant?c=' + encodeURIComponent(r.conversationId));
    } catch (e) { chat.msgs.pop(); chat.msgs.pop(); drawChat(); const i = $('ai-msg'); if (i) i.value = text; throw e; }
  }
  on('ai-suggest', el => sendAi(el.dataset.text));
  on('ai-history', async () => {
    await dialog({ title: T('patient.ai.history', 'Past conversations'), body: html`<div class="list">${(chat.convs || []).map(c => html`<a href="#/more/assistant?c=${c.id}"><div class="grow"><span class="title">${c.preview || T('patient.ai.untitled', 'Conversation')}</span><span class="sub">${dateTime(c.updatedAt)}${c.lastTriage === 'emergency' ? ' | ' + TRIAGE().emergency : ''}</span></div>${icon('right')}</a>`)}</div>`, actions: [{ label: T('kit.close', 'Close'), value: null }] });
  });
  on('ai-del', async el => {
    if (!(await confirm({ title: T('patient.ai.delete_q', 'Delete this conversation?'), body: T('patient.ai.delete_body', 'It will be removed from MediCore for good. This cannot be undone.'), ok: T('patient.ai.delete_ok', 'Delete'), danger: true }))) return;
    await api.post('/api/me/ai/conversations/' + encodeURIComponent(el.dataset.id) + '/delete');
    toast(T('patient.ai.deleted', 'Conversation deleted'), 'ok'); MC.go('#/more/assistant');
  });
  on('ai-settings', async () => {
    const v = await dialog({ title: T('patient.ai.settings', 'Assistant settings'), form: true, body: html`<label class="check"><input type="checkbox" name="shareProfile" ${chat.share ? 'checked' : ''}><span><b>${T('patient.ai.share', 'Also use my health details (optional)')}</b><br><span class="sm muted">${T('patient.ai.share_sub', 'Your age group, sex, allergies and known conditions help it give safer answers. You can change this later.')}</span></span></label>`,
      actions: [{ label: T('patient.ai.withdraw', 'Stop using the assistant'), value: 'withdraw' }, { label: T('kit.cancel', 'Cancel'), value: null }, { label: T('patient.ai.save', 'Save'), primary: true }],
      onSubmit: d => api.post('/api/me/ai/consent', { accept: true, shareProfile: !!d.shareProfile }) });
    if (v === 'withdraw') { await api.post('/api/me/ai/consent', { accept: false, shareProfile: false }); toast(T('patient.ai.withdrawn', 'You stopped using the assistant. Your past conversations are kept until you delete them or for 90 days.')); MC.go('#/'); return; }
    if (v) { toast(T('patient.ai.saved', 'Settings saved'), 'ok'); MC.render(); }
  });

  /* ---------------- bills ---------------- */
  async function bills({ stale }) {
    const rows = await api.get('/api/me/bills');
    if (stale()) return;
    const due = rows.filter(b => b.status === 'open' && b.patientDueKobo - b.paidKobo > 0);
    const paid = rows.filter(b => !due.includes(b));
    const total = due.reduce((s, b) => s + b.patientDueKobo - b.paidKobo, 0);
    const lines = b => b.lines.map(l => l.name + (l.qty > 1 ? ' x' + l.qty : '')).join(', ');
    view(html`${head(T('patient.bill.title', 'Bills and payments'), isProv() ? (cur() ? T('patient.bill.sub_mine', 'Bills from {provider}.', { provider: curName() }) : '') : T('patient.bill.sub', 'Every bill from every provider, in one place.'))}
      ${MC.figures([{ value: money(total), label: T('patient.bill.due_total', 'To pay'), tone: total ? 'warn' : '' }, { value: String(due.length), label: T('patient.bill.open', 'Unpaid bills') }])}
      ${due.length ? html`<h2 class="sec">${T('patient.bill.to_pay', 'To pay')}</h2><ul class="list">${due.map(b => html`<li><div class="grow"><span class="title">${b.orgName}</span><span class="sub">${lines(b)}</span><span class="sub">${b.number} | ${date(b.createdAt)}${b.hmo && b.hmo.coveredKobo ? ' | ' + T('patient.bill.hmo_part', 'HMO pays {amount}', { amount: money(b.hmo.coveredKobo) }) : ''}</span></div>
        <span class="end"><b>${money(b.patientDueKobo - b.paidKobo)}</b><br><button class="btn sm primary" data-action="pay" data-bill="${b.id}" data-amount="${b.patientDueKobo - b.paidKobo}" data-org="${b.orgName}">${T('patient.bill.pay', 'Pay')}</button></span></li>`)}</ul>` : html`<div class="notice ok">${T('patient.bill.all_paid', 'You have nothing to pay right now.')}</div>`}
      ${paid.length ? html`<h2 class="sec">${T('patient.bill.history', 'Paid')}</h2><ul class="list">${paid.slice(0, 50).map(b => html`<li><div class="grow"><span class="title">${b.orgName}</span><span class="sub">${lines(b)}</span><span class="sub">${b.number} | ${date(b.paidAt || b.createdAt)}${b.settledBy === 'hmo' ? ' | ' + T('patient.bill.by_hmo', 'Paid by your HMO') : ''}</span></div><span class="end"><b>${money(b.totalKobo)}</b><br>${sb(b.status, b.status === 'paid' ? T('patient.bill.paid', 'Paid') : null)}</span></li>`)}</ul>` : ''}`);
    refreshCounts();
  }

  /* ---------------- messages ---------------- */
  async function messages({ stale }) {
    const r = await api.get('/api/me/threads');
    if (stale()) return;
    view(html`${head(T('patient.msg.title', 'Messages'), isProv() && cur() ? T('patient.msg.sub_mine', 'Write to {provider}. For emergencies press SOS.', { provider: curName() }) : needProvider() ? '' : T('patient.msg.sub', 'Write to your doctors and providers. For emergencies press SOS.'), needProvider() ? '' : html`<button class="btn primary" data-action="msg-new">${icon('plus')}${T('patient.msg.new', 'New message')}</button>`)}
      ${r.threads.length ? html`<div class="list">${r.threads.map(t => html`<a href="#/more/messages/${t.id}">${icon('message')}<div class="grow"><span class="title">${t.subject}</span><span class="sub">${t.orgName}${t.doctorName ? ' | ' + t.doctorName : ''} | ${ago(t.lastAt)}</span>${t.lastPreview ? html`<span class="sub">${t.lastFrom === 'patient' ? T('patient.msg.you', 'You') + ': ' : ''}${t.lastPreview}</span>` : ''}</div>
        ${t.unread ? html`<span class="badge bad">${T('patient.msg.unread', '{n} new', { n: t.unread })}</span>` : t.status === 'closed' ? badge(T('patient.msg.closed', 'Closed'), 'plain') : ''}</a>`)}</div>`
        : needProvider() ? noProvider() : empty({ icon: 'message', title: T('patient.msg.none', 'No messages yet'), body: isProv() ? T('patient.msg.none_sub_mine', 'You can write to {provider} here.', { provider: curName() }) : T('patient.msg.none_sub', 'You can message any provider you have visited.'), action: html`<button class="btn primary" data-action="msg-new">${T('patient.msg.new', 'New message')}</button>` })}`);
    refreshCounts();
  }
  on('msg-new', async () => {
    // provider mode: write to the current provider (a group: choose the branch)
    const provs = isProv() ? (cur() ? cur().branches.map(b => ({ orgId: b.orgId, name: cur().kind === 'group' ? cur().name + ': ' + b.branchName : b.name })) : [])
      : (await api.get('/api/me/providers')).filter(p => p.type !== 'hmo');
    if (!provs.length) { toast(T('patient.msg.no_prov', 'You can message a provider after you visit or book them.')); return; }
    const r = await dialog({ title: T('patient.msg.new', 'New message'), form: true, body: html`
      <div class="field"><label for="mn-o">${T('patient.msg.to', 'To')}</label><select class="input" id="mn-o" name="orgId">${provs.map(p => html`<option value="${p.orgId}">${p.name}</option>`)}</select></div>
      <div class="field"><label for="mn-s">${T('patient.msg.subject', 'Subject')}</label><input class="input" id="mn-s" name="subject" maxlength="120" required placeholder="${T('patient.msg.subject_ph', 'e.g. Question about my medicine')}"></div>
      <div class="field"><label for="mn-t">${T('patient.msg.text', 'Message')}</label><textarea class="input" id="mn-t" name="text" maxlength="2000" required></textarea><div class="hint">${T('patient.msg.hint', 'Staff usually reply within one working day.')}</div></div>`,
      actions: [{ label: T('kit.cancel', 'Cancel'), value: null }, { label: T('patient.msg.send', 'Send message'), primary: true }],
      onSubmit: d => { if (!d.subject || d.subject.length < 2) throw fail(T('patient.msg.need_subject', 'Write a short subject'), 'subject'); if (!d.text) throw fail(T('patient.msg.need_text', 'Write your message'), 'text'); return api.post('/api/me/threads', { orgId: d.orgId, subject: d.subject, text: d.text }); } });
    if (r && r.thread) { toast(T('patient.msg.sent', 'Message sent'), 'ok'); MC.go('#/more/messages/' + r.thread.id); }
  });
  async function thread({ params, stale }) {
    const id = encodeURIComponent(params.id);
    let r = await api.get('/api/me/threads/' + id + '/messages');
    if (stale()) return;
    let msgs = r.messages; let th = r.thread;
    if (th.unread) api.post('/api/me/threads/' + id + '/read').then(refreshCounts).catch(() => { });
    view(html`${back('#/more/messages', T('patient.msg.title', 'Messages'))}${head(th.subject, th.orgName + (th.doctorName ? ' | ' + th.doctorName : ''))}<div class="chat" id="th-chat" aria-live="polite"></div>
      ${th.status === 'open' ? html`<form class="composer" data-form="th-reply" novalidate><label for="th-t" class="sr-only">${T('patient.msg.reply', 'Reply')}</label><textarea class="input" id="th-t" name="text" maxlength="2000" placeholder="${T('patient.msg.reply_ph', 'Write a reply...')}"></textarea><button class="btn primary" type="submit">${icon('nav')}${T('patient.msg.send_short', 'Send')}</button></form>` : html`<div class="notice">${T('patient.msg.closed_note', 'This conversation was closed by the provider. Start a new message if you need more help.')}</div>`}`);
    const draw = () => MC.view(html`${msgs.map(m => html`<div class="bub ${m.from === 'patient' ? 'me' : 'them'}"><span class="who">${m.from === 'patient' ? T('patient.msg.you', 'You') : m.senderName}${' | ' + dateTime(m.at)}</span>${m.text}</div>`)}`, $('th-chat'));
    draw();
    form('th-reply', async (d, f) => { const text = (d.text || '').trim(); if (!text) throw fail(T('patient.msg.need_text', 'Write your message'), 'text'); const x = await api.post('/api/me/threads/' + id + '/messages', { text }); msgs.push(x.message); f.querySelector('textarea').value = ''; draw(); });
    MC.poll(async () => { const last = msgs.length ? msgs[msgs.length - 1].seq : 0; const n = await api.get('/api/me/threads/' + id + '/messages' + qs({ after: last })); if (n.messages.length) { msgs = msgs.concat(n.messages.filter(m => !msgs.some(x => x.seq === m.seq))); draw(); api.post('/api/me/threads/' + id + '/read').catch(() => { }); } th = n.thread; }, 20000);
  }

  /* ---------------- HMO cover ---------------- */
  async function hmo({ stale }) {
    const covs = await api.get('/api/me/coverages');
    if (stale()) return;
    const cats = CATS();
    const card = c => {
      const waiting = c.status === 'pending' && !c.patientConfirmed;
      return html`<section class="panel"><div class="row between top wrap"><div><h2 style="margin:0">${c.payerName}</h2><p class="muted sm" style="margin:4px 0 0">${T('patient.hmo.member', 'Member number')}: <b>${c.memberNo}</b>${c.planName ? ' | ' + c.planName : ''}${c.validTo ? ' | ' + T('patient.hmo.valid', 'Valid to {date}', { date: date(isoTs(c.validTo)) }) : ''}</p></div>${sb(c.status, COVER()[c.status])}</div>
        ${waiting ? html`<div class="notice warn" style="margin-top:12px">${T('patient.hmo.confirm_q', '{hmo} says you are their member. Confirm only if this is your HMO cover. They will then pay for covered care at MediCore providers.', { hmo: c.payerName })}</div><div class="btn-row"><button class="btn primary" data-action="hmo-confirm" data-id="${c.id}">${T('patient.hmo.confirm', 'Yes, this is my cover')}</button><button class="btn" data-action="hmo-decline" data-id="${c.id}">${T('patient.hmo.decline', 'No, decline')}</button></div>` : ''}
        ${c.status === 'pending' && c.patientConfirmed ? html`<p class="sm" style="margin:12px 0 0">${T('patient.hmo.wait', 'The HMO is checking your membership. This usually takes a working day.')}</p>` : ''}
        ${c.statusReason && ['rejected', 'suspended', 'ended'].includes(c.status) ? html`<p class="sm" style="margin:12px 0 0">${c.statusReason}</p>` : ''}
        ${c.status === 'active' && c.limits ? html`<h3 style="margin-top:16px">${T('patient.hmo.left', 'Cover left this year')}</h3>${Object.keys(c.limits).filter(k => c.limits[k] > 0).map(k => { const left = c.remainingKobo ? c.remainingKobo[k] : c.limits[k]; const pct = Math.max(0, Math.min(100, Math.round(left / c.limits[k] * 100))); return html`<div style="margin-bottom:10px"><div class="row between sm"><span>${cats[k] || cap(k)}</span><span><b>${money(left)}</b> ${T('patient.hmo.of', 'of {amount}', { amount: money(c.limits[k]) })}</span></div><div class="meter" role="img" aria-label="${pct}%"><i style="width:${pct}%"></i></div></div>`; })}` : ''}</section>`;
    };
    view(html`${head(T('patient.hmo.title', 'HMO cover'), T('patient.hmo.sub', 'Add your health insurance so providers can bill your HMO directly.'))}
      <div class="btn-row" style="margin-top:0">${MC.feature('hmoRetail') ? html`<a class="btn primary" href="#/hmo/plans">${icon('plus')}${T('patient.hmo.buy', 'Buy a health plan')}</a>` : ''}<a class="btn" href="#/hmo/cards">${icon('card')}${T('patient.hmo.cards', 'Member cards')}</a><a class="btn" href="#/hmo/requests">${icon('message')}${T('patient.hmo.talk', 'Talk to my HMO')}</a></div>
      ${covs.length ? covs.map(card) : empty({ icon: 'shield', title: T('patient.hmo.none', 'No HMO cover added'), body: T('patient.hmo.none_sub', 'If you have an HMO card from work or a private plan, add it below.') })}
      <form class="panel" data-form="hmo-add" novalidate><h2>${T('patient.hmo.add', 'Add my HMO')}</h2><div id="hmo-list">${MC.skeleton(1)}</div>
        <div class="fields two"><div class="field"><label for="hm-n">${T('patient.hmo.member', 'Member number')}</label><input class="input" id="hm-n" name="memberNo" maxlength="40" required autocapitalize="characters" placeholder="HH-100234"><div class="hint">${T('patient.hmo.member_hint', 'It is on your HMO card.')}</div></div>
        <div class="field"><label for="hm-p">${T('patient.hmo.plan', 'Plan name (optional)')}</label><input class="input" id="hm-p" name="planName" maxlength="60"></div></div>
        <div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${T('patient.hmo.add_btn', 'Add HMO cover')}</button></form>`);
    const list = await api.get('/api/directory/hmos').catch(() => []);
    if (stale()) return;
    MC.view(html`<div class="field"><label for="hm-o">${T('patient.hmo.which', 'Your HMO')}</label><select class="input" id="hm-o" name="payerOrgId" required><option value="">${T('patient.hmo.pick', 'Choose your HMO')}</option>${list.map(h => html`<option value="${h.id}">${h.name}</option>`)}</select>${list.length ? '' : html`<div class="hint">${T('patient.hmo.no_hmos', 'No HMOs are on MediCore yet.')}</div>`}</div>`, $('hmo-list'));
    form('hmo-add', async d => {
      if (!d.payerOrgId) throw fail(T('patient.hmo.need_hmo', 'Choose your HMO'), 'payerOrgId');
      if (!d.memberNo) throw fail(T('patient.hmo.need_no', 'Type your member number'), 'memberNo');
      await api.post('/api/me/coverages', { payerOrgId: d.payerOrgId, memberNo: d.memberNo, planName: d.planName });
      toast(T('patient.hmo.added', 'HMO cover added. The HMO will confirm it.'), 'ok'); MC.render();
    });
  }
  on('hmo-confirm', async el => { if (!(await confirm({ title: T('patient.hmo.confirm_t', 'Confirm your HMO cover?'), body: T('patient.hmo.confirm_b', 'Your HMO will be able to see the bills it pays for at MediCore providers.'), ok: T('patient.hmo.confirm', 'Yes, this is my cover') }))) return; await api.post('/api/me/coverages/' + encodeURIComponent(el.dataset.id) + '/confirm'); toast(T('patient.hmo.confirmed', 'HMO cover confirmed'), 'ok'); MC.render(); });
  on('hmo-decline', async el => { if (!(await confirm({ title: T('patient.hmo.decline_t', 'Decline this HMO cover?'), body: T('patient.hmo.decline_b', 'The HMO will be told you do not recognise this membership. This cannot be undone here.'), ok: T('patient.hmo.decline', 'No, decline'), danger: true }))) return; await api.post('/api/me/coverages/' + encodeURIComponent(el.dataset.id) + '/decline'); toast(T('patient.hmo.declined', 'HMO cover declined'), 'ok'); MC.render(); });

  /* ---------------- profile, privacy, settings ---------------- */
  async function profile({ stale }) {
    const [p, provs, reqs, cts] = await Promise.all([api.get('/api/me/profile'), isProv() ? [] : api.get('/api/me/providers'), api.get('/api/me/privacy-requests').catch(() => []), loadContacts(true).catch(() => null)]);
    if (stale()) return;
    const sel = (name, opts, cur, id) => html`<select class="input" id="${id}" name="${name}"><option value="">${T('patient.prof.not_set', 'Not set')}</option>${opts.map(([v, l]) => html`<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`)}</select>`;
    const SEX = [['female', T('patient.sex.female', 'Female')], ['male', T('patient.sex.male', 'Male')], ['other', T('patient.sex.other', 'Other')], ['unknown', T('patient.sex.unknown', 'Prefer not to say')]];
    const PRQ = { delete: T('patient.priv.t.delete', 'Delete my data'), correct: T('patient.priv.t.correct', 'Correct my data'), restrict: T('patient.priv.t.restrict', 'Limit use of my data'), object: T('patient.priv.t.object', 'Object to use of my data') };
    view(html`${head(T('patient.prof.title', 'Profile and settings'))}${MC.wristband(p)}
      <section class="panel"><h2>${T('patient.prof.nin', 'NIN')}</h2>
        ${p.ninStatus === 'verified' ? html`<p>${badge(T('patient.prof.nin_ok', 'Confirmed with NIMC'), 'ok')} <span class="muted sm">${T('patient.prof.nin_ends', 'Ends in {d}', { d: p.ninLast4 })}</span></p>`
          : p.ninStatus === 'pending' ? html`<p>${badge(T('patient.prof.nin_pending', 'Saved, waiting to be confirmed'), 'warn')} <span class="muted sm">${T('patient.prof.nin_ends', 'Ends in {d}', { d: p.ninLast4 })}</span></p>`
          : html`<div class="notice warn">${T('patient.prof.nin_missing', 'Add your NIN to join providers and HMOs. Your first provider is free.')}</div>
            <form data-form="nin-add" class="row wrap" style="align-items:flex-end" novalidate><div class="field" style="flex:1;min-width:200px;margin:0"><label for="pf-nin">${T('patient.prof.nin_label', 'NIN (11 digits)')}</label><input class="input" id="pf-nin" name="nin" inputmode="numeric" maxlength="11" autocomplete="off" required></div><button class="btn primary" type="submit">${T('patient.prof.nin_save', 'Confirm my NIN')}</button><div class="form-err notice bad" hidden style="flex-basis:100%"></div></form>`}
        ${p.uid ? html`<p class="sm" style="margin:8px 0 0">${T('patient.prof.uid', 'Your MediCore patient ID')}: <b><code>${p.uid}</code></b>. ${T('patient.prof.uid_hint', 'One record for life: every hospital, pharmacy, lab and HMO you use finds you with it.')}</p>` : ''}
        <p class="muted sm" style="margin:8px 0 0">${T('patient.prof.nin_privacy', 'MediCore checks your NIN with a licensed NIMC partner and keeps only a secure fingerprint of it and the last 4 digits.')}</p></section>
      <section class="panel"><h2>${T('patient.prof.allergies', 'Allergies')}</h2>
        ${(p.allergies || []).length ? html`<ul class="list">${p.allergies.map(a => html`<li><div class="grow"><span class="title">${a.substance}</span><span class="sub">${[a.reaction, a.severity && a.severity !== 'unknown' ? T('patient.sev.' + a.severity, cap(a.severity)) : null].filter(Boolean).join(' | ')}</span></div></li>`)}</ul>`
          : p.noKnownAllergies ? html`<p>${T('patient.prof.nka', 'You told us you have no known allergies.')}</p>` : html`<div class="notice warn">${T('patient.prof.allergy_unknown', 'Your allergies are not recorded. Doctors and pharmacists need this to keep you safe.')}</div><button class="btn" data-action="nka">${T('patient.prof.set_nka', 'I have no known allergies')}</button>`}
        <div class="btn-row"><button class="btn" data-action="allergy-add">${icon('plus')}${T('patient.prof.add_allergy', 'Add an allergy')}</button></div>
        <p class="muted sm" style="margin:12px 0 0">${T('patient.prof.allergy_note', 'Only a provider can remove an allergy, after checking it with you.')}</p></section>
      <form class="panel" data-form="prof-save" novalidate><h2>${T('patient.prof.details', 'My details')}</h2>
        <div class="fields two"><div class="field"><label for="pf-f">${T('patient.prof.first', 'First name')}</label><input class="input" id="pf-f" name="firstName" value="${p.firstName}" maxlength="60" required></div><div class="field"><label for="pf-l">${T('patient.prof.last', 'Last name')}</label><input class="input" id="pf-l" name="lastName" value="${p.lastName}" maxlength="60" required></div>
        <div class="field"><label for="pf-d">${T('patient.prof.dob', 'Date of birth')}</label><input class="input" id="pf-d" name="dob" type="date" value="${p.dob || ''}" max="${MC.todayISO()}"></div><div class="field"><label for="pf-s">${T('patient.prof.sex', 'Sex')}</label>${sel('sex', SEX, p.sex, 'pf-s')}</div>
        <div class="field"><label for="pf-ph">${T('patient.prof.phone', 'Phone')}</label><input class="input" id="pf-ph" value="${p.phone || ''}" disabled><div class="hint">${T('patient.prof.phone_hint', 'To change your phone number, contact MediCore support.')}</div></div><div class="field"><label for="pf-e">${T('patient.prof.email', 'Email (optional)')}</label><input class="input" id="pf-e" name="email" type="email" value="${p.email || ''}" maxlength="160"></div></div>
        <div class="field"><label for="pf-a">${T('patient.prof.address', 'Home address')}</label><input class="input" id="pf-a" name="address" value="${p.address || ''}" maxlength="300"><div class="hint">${T('patient.prof.address_hint', 'Used for deliveries if you do not type another address.')}</div></div>
        <div class="fields two"><div class="field"><label for="pf-b">${T('patient.prof.blood', 'Blood group')}</label>${sel('bloodGroup', ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map(x => [x, x]).concat([['unknown', T('patient.prof.dont_know', 'I do not know')]]), p.bloodGroup, 'pf-b')}</div><div class="field"><label for="pf-g">${T('patient.prof.genotype', 'Genotype')}</label>${sel('genotype', ['AA', 'AS', 'SS', 'AC', 'SC'].map(x => [x, x]).concat([['unknown', T('patient.prof.dont_know', 'I do not know')]]), p.genotype, 'pf-g')}</div>
        <div class="field"><label for="pf-kn">${T('patient.prof.nok', 'Next of kin name')}</label><input class="input" id="pf-kn" name="nokName" value="${p.nokName || ''}" maxlength="100"></div><div class="field"><label for="pf-kp">${T('patient.prof.nok_phone', 'Next of kin phone')}</label><input class="input" id="pf-kp" name="nokPhone" value="${p.nokPhone || ''}" inputmode="tel"></div></div>
        <div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${T('patient.prof.save', 'Save my details')}</button></form>
      <section class="panel"><h2>${T('kit.language', 'Language')}</h2><div class="field" style="margin:0"><label for="pf-lang" class="sr-only">${T('kit.language', 'Language')}</label><select class="input" id="pf-lang" data-change="lang">${MC.langOptions().map(o => html`<option value="${o.key}" ${o.key === MC.lang ? 'selected' : ''}>${o.label}</option>`)}</select><div class="hint">${T('patient.prof.lang_hint', 'The app and SMS messages use this language. The health assistant answers in it too.')}</div></div></section>
      ${isProv() ? html`<section class="panel"><h2>${T('patient.prof.providers', 'My providers')}</h2><p class="sm">${providers().length ? T('patient.prof.providers_n', 'You are registered with {n} providers: {names}.', { n: providers().length, names: providers().map(x => x.name).join(', ') }) : T('patient.none.title', 'You are not registered with a provider yet')}</p>
        <p class="muted sm">${T('patient.prof.records_move', 'Each provider sees only its own records. Your records move to another provider only when a provider refers you.')}</p>
        <div class="btn-row"><a class="btn" href="#/more/providers">${icon('building')}${T('patient.prof.manage_providers', 'See my providers and applications')}</a><a class="btn" href="#/more/referrals">${icon('swap')}${T('patient.nav.referrals', 'Referrals')}</a></div></section>` : html`<section class="panel flush"><h2>${T('patient.prof.providers', 'My providers')}</h2><p class="muted sm" style="padding:0 16px">${T('patient.prof.share_explain', 'Each provider always sees what it recorded for you. "Share my history" lets a provider also see your visits, prescriptions and results from your other MediCore providers, so they can treat you safely. Switch it off at any time; it takes effect at once.')}</p>
        ${provs.length ? html`<ul class="list">${provs.map(x => html`<li><div class="grow"><span class="title">${x.name}</span><span class="sub">${TYPES()[x.type] || cap(x.type)} | ${T('patient.prof.mrn', 'Your number there')}: ${x.mrn}</span></div><label class="check" style="flex:none"><input type="checkbox" data-change="share" data-org="${x.orgId}" data-name="${x.name}" ${x.shareHistory ? 'checked' : ''}><span class="sm">${T('patient.prof.share', 'Share my history')}</span></label></li>`)}</ul>` : html`<p class="muted" style="padding:0 16px 16px">${T('patient.prof.no_providers', 'You are not linked to any provider yet.')}</p>`}</section>`}
      ${MC.feature('ussd') ? html`<section class="panel"><h2>${T('patient.prof.ussd', 'USSD PIN')}</h2><p class="sm">${T('patient.prof.ussd_sub', 'Use MediCore from any phone, without data, by dialling our USSD code. You need a 4-digit PIN.')}</p><p>${p.ussdPinSet ? badge(T('patient.prof.ussd_set', 'PIN is set'), 'ok') : badge(T('patient.prof.ussd_none', 'No PIN yet'), 'warn')}</p><button class="btn" data-action="ussd-pin">${icon('key')}${p.ussdPinSet ? T('patient.prof.ussd_change', 'Change PIN') : T('patient.prof.ussd_btn', 'Set up PIN')}</button></section>` : ''}
      <section class="panel"><h2>${T('patient.prof.notifs', 'Notifications')}</h2><p class="sm muted">${T('patient.prof.notifs_sub', 'Messages about your visits, orders, results and payments.')}</p><a class="btn" href="#/more/notifications">${icon('bell')}${T('patient.prof.notifs_open', 'See notifications')}</a></section>
      ${cts ? waPanel(cts, p) : ''}
      <section class="panel"><h2>${T('patient.priv.title', 'My data and privacy')}</h2><p class="sm">${T('patient.priv.sub', 'Under the Nigeria Data Protection Act you can get a copy of your data, and ask us to correct or delete it.')}</p>
        <div class="btn-row"><button class="btn" data-action="export">${icon('download')}${T('patient.priv.export', 'Download my data')}</button><button class="btn" data-action="priv" data-type="correct">${icon('edit')}${PRQ.correct}</button><button class="btn" data-action="priv" data-type="delete">${icon('trash')}${PRQ.delete}</button></div>
        ${reqs.length ? html`<h3 style="margin-top:16px">${T('patient.priv.requests', 'Your requests')}</h3><ul class="list">${reqs.map(q => html`<li><div class="grow"><span class="title">${PRQ[q.type] || cap(q.type)}</span><span class="sub">${date(q.at)} | ${T('patient.priv.due', 'Answer due by {date}', { date: date(q.dueAt) })}</span></div>${sb(q.status, T('patient.priv.st.' + q.status, cap(q.status)))}</li>`)}</ul>` : ''}
        ${content('privacyUrl', '') ? html`<p class="sm" style="margin-top:12px"><a href="${content('privacyUrl', '')}" target="_blank" rel="noopener">${T('patient.priv.notice', 'Read the privacy notice')}</a></p>` : ''}</section>
      ${appTeam(cts && cts.platform)}
      <div class="btn-row"><button class="btn lg" data-action="signout">${icon('logout')}${T('kit.signout', 'Sign out')}</button></div>`);
    form('prof-save', async d => {
      const body = {}; ['firstName', 'lastName', 'dob', 'sex', 'email', 'address', 'bloodGroup', 'genotype', 'nokName', 'nokPhone'].forEach(k => { if (d[k] !== undefined && d[k] !== (p[k] || undefined)) body[k] = d[k]; });
      if (!Object.keys(body).length) { toast(T('patient.prof.no_change', 'Nothing changed')); return; }
      await api.patch('/api/me/profile', body); toast(T('patient.prof.saved', 'Details saved'), 'ok'); MC.render();
    });
  }
  onChange('lang', el => MC.setLang(el.value, { save: true }));
  onChange('share', async el => {
    const on1 = el.checked; el.disabled = true;
    try { await api.post('/api/me/providers/' + encodeURIComponent(el.dataset.org) + '/share', { share: on1 }); toast(on1 ? T('patient.prof.share_on', '{org} can now see your history from other providers', { org: el.dataset.name }) : T('patient.prof.share_off', '{org} now sees only its own records', { org: el.dataset.name }), 'ok'); }
    catch (e) { el.checked = !on1; throw e; } finally { el.disabled = false; }
  });
  form('nin-add', async d => { const n = String(d.nin || '').replace(/\s+/g, ''); if (!/^\d{11}$/.test(n)) throw fail(T('patient.prof.nin_need', 'Type the 11 digits of your NIN'), 'nin'); await api.post('/api/me/nin', { nin: n }); toast(T('patient.prof.nin_saved', 'NIN saved'), 'ok'); MC.render(); });
  on('nka', async () => { await api.patch('/api/me/profile', { noKnownAllergies: true }); toast(T('patient.prof.nka_saved', 'Saved: no known allergies'), 'ok'); MC.render(); });
  on('allergy-add', async () => {
    const v = await dialog({ title: T('patient.prof.add_allergy', 'Add an allergy'), form: true, body: allergyFields('al'),
      actions: [{ label: T('kit.cancel', 'Cancel'), value: null }, { label: T('patient.prof.add_allergy_btn', 'Add allergy'), primary: true }],
      onSubmit: d => { if (!d.substance) throw fail(T('patient.al.need', 'Type what you are allergic to'), 'substance'); return api.patch('/api/me/profile', { addAllergies: [{ substance: d.substance, reaction: d.reaction, severity: d.severity || 'unknown' }], noKnownAllergies: false }); } });
    if (v) { toast(T('patient.prof.allergy_added', 'Allergy added'), 'ok'); MC.render(); }
  });
  function allergyFields(p) {
    return html`<div class="field"><label for="${p}-s">${T('patient.al.substance', 'Allergic to')}</label><input class="input" id="${p}-s" name="substance" maxlength="80" placeholder="${T('patient.al.substance_ph', 'e.g. Penicillin, sulfa drugs, groundnut')}"></div>
      <div class="field"><label for="${p}-r">${T('patient.al.reaction', 'What happens (optional)')}</label><input class="input" id="${p}-r" name="reaction" maxlength="120" placeholder="${T('patient.al.reaction_ph', 'e.g. rash, swelling, trouble breathing')}"></div>
      <div class="field"><label for="${p}-v">${T('patient.al.severity', 'How bad')}</label><select class="input" id="${p}-v" name="severity"><option value="unknown">${T('patient.sev.unknown', 'Not sure')}</option><option value="mild">${T('patient.sev.mild', 'Mild')}</option><option value="moderate">${T('patient.sev.moderate', 'Moderate')}</option><option value="severe">${T('patient.sev.severe', 'Severe')}</option></select></div>`;
  }
  on('ussd-pin', async () => {
    const v = await dialog({ title: T('patient.prof.ussd', 'USSD PIN'), form: true, body: html`<div class="field"><label for="up-p">${T('patient.prof.ussd_new', 'New 4-digit PIN')}</label><input class="input" id="up-p" name="pin" type="password" inputmode="numeric" maxlength="4" autocomplete="off" pattern="[0-9]{4}"><div class="hint">${T('patient.prof.ussd_rule', 'Avoid 1234, 0000 and your birth year. Never tell anyone your PIN.')}</div></div>
      <div class="field"><label for="up-w">${T('patient.prof.ussd_pw', 'Your MediCore password')}</label><input class="input" id="up-w" name="password" type="password" autocomplete="current-password"></div>`,
      actions: [{ label: T('kit.cancel', 'Cancel'), value: null }, { label: T('patient.prof.ussd_save', 'Save PIN'), primary: true }],
      onSubmit: d => { if (!/^\d{4}$/.test(d.pin || '')) throw fail(T('patient.prof.ussd_4', 'The PIN must be 4 digits'), 'pin'); return api.post('/api/me/ussd-pin', { pin: d.pin, password: d.password || '' }); } });
    if (v) { toast(T('patient.prof.ussd_saved', 'USSD PIN saved'), 'ok'); MC.render(); }
  });
  on('export', async () => {
    const data = await api.get('/api/me/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'medicore-my-data.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(T('patient.priv.exported', 'Your data was downloaded'), 'ok');
  });
  on('priv', async el => {
    const type = el.dataset.type; const del = type === 'delete';
    const v = await dialog({ title: del ? T('patient.priv.t.delete', 'Delete my data') : T('patient.priv.t.correct', 'Correct my data'), form: true,
      body: html`<p>${del ? T('patient.priv.delete_body', 'We will delete your MediCore account and data, except records the law requires providers to keep (for example medical records and payments). We will answer within 30 days.') : T('patient.priv.correct_body', 'Tell us what is wrong and what it should be. We will answer within 30 days.')}</p><div class="field"><label for="pr-n">${del ? T('patient.priv.note_opt', 'Anything we should know (optional)') : T('patient.priv.what', 'What should we correct?')}</label><textarea class="input" id="pr-n" name="note" maxlength="1000"></textarea></div>`,
      actions: [{ label: T('kit.cancel', 'Cancel'), value: null }, { label: del ? T('patient.priv.send_delete', 'Send delete request') : T('patient.priv.send_correct', 'Send request'), primary: true }],
      onOpen: d => { if (del) { const b = d.querySelector('button[type=submit]'); b.classList.remove('primary'); b.classList.add('danger'); } },
      onSubmit: d => { if (!del && !d.note) throw fail(T('patient.priv.need_note', 'Tell us what to correct'), 'note'); return api.post('/api/me/privacy-request', { type, note: d.note }); } });
    if (v) { toast(T('patient.priv.sent', 'Request received. We will reply within 30 days.'), 'ok'); MC.render(); }
  });
  on('signout', async () => { try { await api.post('/api/auth/logout'); } catch (e) { } location.hash = ''; location.reload(); });

  async function notifications({ stale }) {
    const n = await api.get('/api/me/notifications');
    if (stale()) return;
    view(html`${back('#/more/profile', T('patient.prof.title', 'Profile and settings'))}${head(T('kit.notifications', 'Notifications'))}
      ${n.length ? html`<ul class="list">${n.map(x => html`<li>${icon('bell')}<div class="grow"><span class="title">${x.title}${x.read ? '' : html` <span class="badge info">${T('patient.notif.new', 'New')}</span>`}</span><span class="sub">${x.body}</span></div><span class="end xs muted">${ago(x.at)}</span></li>`)}</ul>` : empty({ icon: 'bell', title: T('kit.no_notifications', 'No notifications') })}`);
    if (n.some(x => !x.read)) api.post('/api/me/notifications/read').catch(() => { });
  }

  /* ---------------- contact numbers page ---------------- */
  async function contactPage({ stale }) {
    if (needProvider()) { view(noProvider(T('patient.contact.title', 'Contact numbers'))); return; }
    const d = await loadContacts(true);
    if (stale()) return;
    const list = d.providers || [];
    const title = isProv() && cur() ? T('patient.contact.card_title', 'Contact {provider}', { provider: curName() }) : T('patient.contact.title', 'Contact numbers');
    const block = (pc, named) => {
      const multi = pc.kind === 'group';
      const ho = pc.headOffice ? sortedDepts(pc.headOffice) : [];
      const rows = (c, who) => { const ks = sortedDepts(c); return ks.length ? html`<ul class="list">${ks.map(k => ctRow(k, c[k], who))}</ul>` : html`<p class="muted sm" style="padding:0 16px 16px;margin:0">${T('patient.contact.none_here', 'No numbers listed here yet.')}</p>`; };
      return html`${named ? html`<h2 class="sec">${pc.name}</h2>` : ''}
        ${multi ? html`${(pc.branches || []).map(b => html`<section class="panel flush"><h3>${T('patient.contact.branch', '{branch} branch', { branch: b.name })}${b.area && b.area !== b.name ? html` <span class="muted sm" style="font-weight:400">${b.area}</span>` : ''}</h3>${rows(b.contacts, b.name)}</section>`)}
            ${ho.length ? html`<section class="panel flush"><h3>${T('patient.contact.head_office', 'Head office')}</h3><p class="muted sm" style="padding:0 16px;margin:4px 0 8px">${T('patient.contact.head_office_sub', 'For questions about {provider} as a whole, not one branch.', { provider: pc.name })}</p>${rows(pc.headOffice, T('patient.contact.ho_of', '{provider} head office', { provider: pc.name }))}</section>` : ''}`
          : (pc.branches || []).map(b => rows(b.contacts, pc.name))}`;
    };
    view(html`${head(title, T('patient.contact.sub', 'Call or chat on WhatsApp with the right department.'))}
      <div class="notice warn">${T('patient.contact.em_note', 'In an emergency, press SOS or call 112. Do not wait for a WhatsApp reply.')} <a href="#/sos">${T('patient.contact.go_sos', 'Go to Emergency')}</a></div>
      ${list.length ? list.map(pc => block(pc, list.length > 1 || !isProv())) : empty({ icon: 'phone', title: T('patient.contact.none', 'No contact numbers yet'), body: T('patient.contact.none_sub', 'Your provider has not listed its numbers in the app yet. Send them a message instead.'), action: html`<a class="btn" href="#/more/messages">${icon('message')}${T('patient.contact.write', 'Write a message')}</a>` })}
      <p class="muted xs" style="margin-top:12px">${T('patient.contact.wa_tip', 'Chat on WhatsApp opens WhatsApp with that number. Normal WhatsApp data charges apply.')}</p>
      ${appTeam(d.platform)}`);
  }
  /** the platform's own support line: for app problems, not care */
  function appTeam(pl) {
    const B = (MC.config() || {}).branding || {};
    const phone = (pl && pl.supportPhone) || B.supportPhone || ''; const chat = (pl && pl.supportChatLink) || null; const email = B.supportEmail || '';
    if (!phone && !chat && !email) return '';
    const entry = { phone, callLink: phone ? 'tel:' + String(phone).replace(/[^\d+]/g, '') : null, chatLink: chat };
    return html`<section class="panel"><h2>${T('patient.contact.app_team', 'Contact the app team')}</h2>
      <p class="sm muted">${T('patient.contact.app_team_sub', 'For help with the app itself: signing in, your account, or something that does not work. For your care, appointments or bills, contact your provider.')}</p>
      ${phone ? html`<p class="sm" style="margin:0">${T('patient.contact.app_phone', 'Phone')}: <b>${showNum(phone)}</b></p>` : ''}
      <div class="btn-row">${ctButtons(entry, T('patient.contact.app_team_what', 'the app team'), { size: 'md' })}${email ? html`<a class="btn" style="max-width:100%;white-space:normal;overflow-wrap:anywhere;text-align:left" href="mailto:${email}">${icon('message')}${T('patient.contact.email_team', 'Email {email}', { email })}</a>` : ''}</div></section>`;
  }

  /* ---------------- WhatsApp updates (settings) ---------------- */
  let waNumber = null; // the number the server confirmed on the last save in this session
  function waPanel(d, p) {
    const on1 = !!d.whatsappOptIn; const phone = p.phone || '';
    if (!waNumber && (p.whatsapp || d.whatsappNumber)) waNumber = p.whatsapp || d.whatsappNumber; // the number on record (also when the front desk saved it)
    waState.acct = phone; waState.automated = !!d.whatsappAutomated;
    const other = !phone || !!(waNumber && waNumber !== phone);
    return html`<form class="panel ct-wa" data-form="wa-save" novalidate><h2>${T('patient.wa.title', 'WhatsApp updates')}</h2>
      <label class="check"><input type="checkbox" name="optIn" data-change="wa-toggle" ${on1 ? 'checked' : ''}><span><b>${T('patient.wa.toggle', 'Get updates on WhatsApp')}</b><br><span class="sm muted">${on1 ? T('patient.wa.is_on', 'On. Updates come to you on WhatsApp.') : T('patient.wa.is_off', 'Off. Updates come in the app and by SMS.')}</span></span></label>
      <div id="wa-num" ${on1 ? '' : 'hidden'}><div class="field"><span class="label">${T('patient.wa.which', 'Which WhatsApp number?')}</span>
        <label class="opt"><input type="radio" name="which" value="account" data-change="wa-which" ${other ? '' : 'checked'} ${phone ? '' : 'disabled'}><span class="grow"><span class="title">${T('patient.wa.account', 'My account phone')}</span><span class="sub">${phone ? showNum(phone) : T('patient.wa.no_phone', 'No phone number on your account')}</span></span></label>
        <label class="opt"><input type="radio" name="which" value="other" data-change="wa-which" ${other ? 'checked' : ''}><span class="grow"><span class="title">${T('patient.wa.other', 'A different WhatsApp number')}</span></span></label></div>
        <div class="field" id="wa-other" ${other ? '' : 'hidden'}><label for="wa-n">${T('patient.wa.number', 'WhatsApp number')}</label><input class="input" id="wa-n" name="number" inputmode="tel" autocomplete="tel" maxlength="20" value="${other && waNumber ? showNum(waNumber) : ''}" placeholder="${T('patient.wa.number_ph', 'e.g. 0803 123 4567')}"><div class="hint">${T('patient.wa.number_hint', 'A Nigerian number like 0803 123 4567, or a number abroad starting with + and the country code.')}</div></div></div>
      <p class="sm">${T('patient.wa.what', 'We send appointment reminders and changes, payment receipts, a note when results are ready, and delivery and referral updates. Messages carry no medical details beyond what the app shows.')}</p>
      <p class="sm muted">${T('patient.wa.off_any', 'You can turn this off at any time here.')}</p>
      ${d.whatsappAutomated ? '' : html`<div class="notice">${T('patient.wa.not_yet', 'WhatsApp messages are not connected yet. Your choice is saved, and messages start once your provider\'s WhatsApp is connected. Until then, updates come in the app and by SMS.')}</div>`}
      <div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${icon('message')}${T('patient.wa.save', 'Save WhatsApp choice')}</button></form>`;
  }
  onChange('wa-toggle', el => { const box = $('wa-num'); if (box) box.hidden = !el.checked; });
  onChange('wa-which', el => { const box = $('wa-other'); if (box) box.hidden = el.value !== 'other'; if (el.value === 'other' && $('wa-n')) $('wa-n').focus(); });
  const waState = { acct: '', automated: false }; // set when the settings page renders
  form('wa-save', async v => {
    let body;
    if (!v.optIn) body = { optIn: false };
    else if (v.which === 'other' || !waState.acct) {
      if (!v.number) throw fail(T('patient.wa.need_number', 'Type the WhatsApp number to use'), 'number');
      body = { optIn: true, number: v.number };
    } else body = { optIn: true, number: waState.acct };
    const r = await api.post('/api/me/whatsapp', body);
    waNumber = r.whatsapp || null; ctCache.data = null;
    toast(!r.whatsappOptIn ? T('patient.wa.off_done', 'WhatsApp updates turned off') : waState.automated ? T('patient.wa.on_done', 'WhatsApp updates turned on for {number}', { number: showNum(r.whatsapp) }) : T('patient.wa.on_saved', 'Saved. WhatsApp updates to {number} start once your provider\'s WhatsApp is connected.', { number: showNum(r.whatsapp) }), 'ok', 6000);
    MC.render();
  });

  /* ---------------- my providers, joining, referrals (provider mode) ---------------- */
  async function providersPage({ stale }) {
    if (!isProv()) { location.replace('#/more/profile'); return; }
    await loadProviders();
    const apps = await api.get('/api/me/applications').catch(() => []);
    if (stale()) return;
    const list = providers();
    const recent = apps.filter(a => a.status !== 'pending' && a.decidedAt && Date.now() - a.decidedAt < 30 * 86400e3);
    const appRow = a => html`<li><div class="grow"><span class="title">${a.orgName || a.groupName}</span><span class="sub">${a.number} | ${T('patient.app.sent_on', 'Sent {date}', { date: date(a.createdAt) })}${a.status === 'pending' && a.expiresAt ? ' | ' + T('patient.app.expires', 'Expires {date}', { date: date(a.expiresAt) }) : ''}</span>
        ${a.note ? html`<span class="sub">${T('patient.app.your_note', 'Your note')}: ${a.note}</span>` : ''}${a.status === 'declined' && a.reason ? html`<span class="sub">${T('patient.app.reason', 'Reason')}: ${a.reason}</span>` : ''}</div>
        <span class="end">${sb(a.status, APP_ST()[a.status])}${a.status === 'pending' ? html`<br><button class="btn sm" style="margin-top:6px" data-action="app-cancel" data-id="${a.id}" data-name="${a.orgName || a.groupName || ''}">${T('patient.app.cancel', 'Cancel application')}</button>` : ''}</span></li>`;
    view(html`${head(T('patient.nav.providers', 'My providers'), T('patient.provs.sub', 'The hospitals, clinics, pharmacies and labs you are registered with.'), canJoinMore() && list.length ? html`<a class="btn primary" href="#/more/join">${icon('plus')}${T('patient.provs.join', 'Join another provider')}</a>` : '')}
      <p class="notice">${T('patient.prof.records_move', 'Each provider sees only its own records. Your records move to another provider only when a provider refers you.')}</p>
      ${list.length ? html`<ul class="list">${list.map(p => html`<li><div class="grow"><span class="title">${p.name}${cur() && cur().key === p.key ? html` ${badge(T('patient.provs.showing', 'Showing now'), 'hue')}` : ''}</span>
          <span class="sub">${p.kind === 'group' ? T('patient.provs.group', 'Hospital group with {n} branches: {names}', { n: branchCount(p), names: p.branches.map(b => b.branchName).join(', ') }) : (TYPES()[p.type] || cap(p.type || ''))}</span>
          <span class="sub">${T('patient.prov.mrn_short', 'Record number {mrn}', { mrn: p.mrn })}</span></div>
          ${cur() && cur().key === p.key ? '' : html`<span class="end"><button class="btn sm" data-action="prov-pick" data-key="${p.key}">${T('patient.provs.show', 'Show this provider')}</button></span>`}</li>`)}</ul>`
        : noProvider()}
      ${pendingApps().length ? html`<h2 class="sec">${T('patient.provs.pending', 'Waiting for approval')}</h2><ul class="list">${pendingApps().map(appRow)}</ul>` : ''}
      ${recent.length ? html`<h2 class="sec">${T('patient.provs.recent', 'Recent applications')}</h2><ul class="list">${recent.map(appRow)}</ul>` : ''}
      <div class="btn-row"><a class="btn" href="#/more/referrals">${icon('swap')}${T('patient.nav.referrals', 'Referrals')}</a></div>`);
  }
  on('app-cancel', async el => {
    if (!(await confirm({ title: T('patient.app.cancel_q', 'Cancel your application?'), body: T('patient.app.cancel_body', '{provider} will not review it. You can apply again later.', { provider: el.dataset.name }), ok: T('patient.app.cancel', 'Cancel application'), cancel: T('patient.app.keep', 'Keep it'), danger: true }))) return;
    await api.post('/api/me/applications/' + encodeURIComponent(el.dataset.id) + '/cancel', {});
    toast(T('patient.app.cancelled', 'Application cancelled'), 'ok'); await loadProviders(); MC.render();
  });

  const JOIN_TYPES = () => [['', T('patient.join.any', 'Any kind')], ['hospital', TYPES().hospital], ['clinic', TYPES().clinic], ['pharmacy', TYPES().pharmacy], ['lab', TYPES().lab]];
  let joinRows = [];
  async function joinPage({ query, stale }) {
    if (!isProv()) { location.replace('#/care'); return; }
    await loadProviders();
    if (!canJoinMore()) { view(html`${back('#/more/providers', T('patient.nav.providers', 'My providers'))}${empty({ icon: 'building', title: T('patient.join.one_only', 'You can be registered with one provider at a time'), body: T('patient.join.one_only_sub', 'Ask your provider to refer you if you need care somewhere else.') })}`); return; }
    joinRows = await api.get('/api/join/providers' + qs({ q: query.q, type: query.type, lat: here && here.lat, lng: here && here.lng, limit: 50 }));
    if (stale()) return;
    const mine = new Set(providers().flatMap(p => p.orgIds || []).concat(providers().map(p => p.key)));
    const waiting = new Set(pendingApps().flatMap(a => [a.orgId, a.groupId].filter(Boolean)));
    view(html`${back(providers().length ? '#/more/providers' : '#/', providers().length ? T('patient.nav.providers', 'My providers') : T('patient.nav.home', 'Home'))}
      ${head(providers().length ? T('patient.join.title_more', 'Join another provider') : T('patient.join.title', 'Choose your hospital, clinic, pharmacy or lab'), T('patient.join.sub', 'Apply to be registered. The provider checks your details and approves you, usually within a working day.'))}
      <form data-form="join-search" class="panel" novalidate><div class="fields two"><div class="field"><label for="js-q">${T('patient.join.search', 'Name or area')}</label><div class="search">${icon('search')}<input class="input" id="js-q" name="q" value="${query.q || ''}" maxlength="60" enterkeyhint="search"></div></div>
        <div class="field"><label for="js-t">${T('patient.join.kind', 'Kind of provider')}</label><select class="input" id="js-t" name="type">${JOIN_TYPES().map(([k, l]) => html`<option value="${k}" ${k === (query.type || '') ? 'selected' : ''}>${l}</option>`)}</select></div></div>
        <div class="btn-row" style="margin-top:0"><button class="btn primary" type="submit">${icon('search')}${T('patient.join.find', 'Search')}</button><button class="btn ${here ? 'primary' : ''}" type="button" data-action="near">${icon('pin')}${here ? T('patient.care.nearest_on', 'Nearest first') : T('patient.care.nearest', 'Show nearest first')}</button></div></form>
      ${joinRows.length ? html`<ul class="list">${joinRows.map((o, i) => { const isMine = mine.has(o.id) || o.branches.some(b => mine.has(b.id)); const isWait = waiting.has(o.id) || o.branches.some(b => waiting.has(b.id));
        return html`<li><div class="grow"><span class="title">${o.name}</span><span class="sub">${TYPES()[o.type] || cap(o.type)}${o.kind === 'group' ? ' | ' + T('patient.prov.branches_n', '{n} branches', { n: o.branches.length }) : ''}${o.distanceKm != null ? ' | ' + T('patient.care.km', '{n} km', { n: o.distanceKm }) : ''}</span>
          <span class="sub">${o.kind === 'group' ? o.branches.map(b => b.branchName).join(', ') : [o.area, o.city].filter(Boolean).join(', ')}</span></div>
          <span class="end">${isMine ? badge(T('patient.join.registered', 'You are registered here'), 'ok') : isWait ? badge(T('patient.join.waiting', 'Application waiting'), 'warn') : html`<button class="btn sm primary" data-action="join-apply" data-i="${i}">${T('patient.join.apply', 'Apply to join')}</button>`}</span></li>`; })}</ul>`
        : empty({ icon: 'building', title: T('patient.join.none', 'No providers found'), body: T('patient.join.none_sub', 'Try another name or area, or choose any kind.') })}`);
    form('join-search', d => MC.go('#/more/join' + qs({ q: d.q, type: d.type })));
  }
  on('join-apply', async el => {
    const o = joinRows[Number(el.dataset.i)]; if (!o) return;
    const group = o.kind === 'group' && o.branches.length > 1;
    const brs = o.branches.slice().sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    const r = await dialog({ title: T('patient.join.apply_to', 'Apply to {provider}', { provider: o.name }), form: true,
      body: html`${group ? html`<div class="field"><span class="label">${T('patient.join.branch', 'Which branch will you go to?')}</span>${brs.map((b, k) => html`<label class="opt"><input type="radio" name="orgId" value="${b.id}" ${k === 0 ? 'checked' : ''}><span class="grow"><span class="title">${b.branchName}</span><span class="sub">${[b.area, b.city].filter(Boolean).join(', ')}${b.distanceKm != null ? ' | ' + T('patient.care.km', '{n} km', { n: b.distanceKm }) : ''}</span></span></label>`)}<div class="hint">${T('patient.join.branch_hint', 'Once approved you are a patient of every branch, with one record number.')}</div></div>`
        : html`<input type="hidden" name="orgId" value="${o.branches[0] ? o.branches[0].id : o.id}">`}
        <div class="field"><label for="ja-n">${T('patient.join.note', 'Note to the provider (optional)')}</label><textarea class="input" id="ja-n" name="note" maxlength="300" placeholder="${T('patient.join.note_ph', 'e.g. I moved nearby and need a family doctor')}"></textarea></div>
        <p class="muted sm">${T('patient.join.shares', 'They will see your name, date of birth, sex, phone number and address to decide.')}</p>`,
      actions: [{ label: T('kit.cancel', 'Cancel'), value: null }, { label: T('patient.join.send', 'Send application'), primary: true }],
      onSubmit: d => api.post('/api/me/applications', { orgId: d.orgId, note: d.note }) });
    if (!r) return;
    await loadProviders();
    if (r.approved) { toast(T('patient.join.approved', 'You are registered with {provider}. Your record number is {mrn}.', { provider: o.name, mrn: r.mrn || '' }), 'ok', 6000); const p = providers().find(x => (x.orgIds || []).includes(r.application.orgId)); if (p) choose(p.key); refreshCounts(); MC.go('#/'); return; }
    const bn = group ? (o.branches.find(b => b.id === r.application.orgId) || {}).branchName : null;
    toast(T('patient.join.sent', 'Application sent to {provider}. You will be notified when they approve it.', { provider: bn ? T('patient.join.prov_branch', '{provider}, {branch} branch', { provider: o.name, branch: bn }) : o.name }), 'ok', 6000);
    MC.go('#/more/providers');
  });

  async function referralsPage({ stale }) {
    const rows = await api.get('/api/me/referrals');
    if (stale()) return;
    view(html`${head(T('patient.nav.referrals', 'Referrals'), T('patient.ref.sub', 'When one provider sends you to another for care, it shows here.'))}
      ${rows.length ? html`<ul class="list">${rows.map(r => html`<li class="top" style="align-items:flex-start">${icon('swap')}<div class="grow"><span class="title">${T('patient.ref.from_to', 'From {from} to {to}', { from: r.fromOrgName, to: r.toOrgName })}</span>
          <span class="sub">${r.number} | ${date(r.createdAt)}${r.urgency ? ' | ' + (URG()[r.urgency] || cap(r.urgency)) : ''}</span>
          <span class="sub">${T('patient.ref.reason', 'Reason')}: ${r.reason}</span>
          <span class="sub"><b>${refWords(r)}</b>${r.status === 'declined' && r.declineReason ? ' ' + r.declineReason : ''}</span></div><span class="end">${sb(r.status, REF_ST()[r.status])}</span></li>`)}</ul>`
        : empty({ icon: 'swap', title: T('patient.ref.none', 'No referrals'), body: T('patient.ref.none_sub', 'If your provider refers you to a specialist, hospital, lab or pharmacy, you can follow it here.') })}`);
  }

  /* ---------------- more ---------------- */
  async function more() {
    const items = [isProv() ? ['#/more/providers', 'building', T('patient.nav.providers', 'My providers'), providers().length > 1 ? T('patient.more.providers_n', 'Now showing {provider}. Switch or join another.', { provider: curName() }) : T('patient.more.providers', 'Your record numbers and applications')] : null,
      isProv() ? ['#/more/referrals', 'swap', T('patient.nav.referrals', 'Referrals'), T('patient.more.referrals', 'When a provider sends you to another')] : null,
      ['#/more/appointments', 'calendar', T('patient.nav.appointments', 'Appointments'), T('patient.more.appt', 'Upcoming and past visits, video visits')],
      ['#/more/bills', 'card', T('patient.nav.bills', 'Bills and payments'), isProv() ? T('patient.more.bills_mine', 'Pay your bills') : T('patient.more.bills', 'Pay bills from all your providers')],
      ['#/more/messages', 'message', T('patient.nav.messages', 'Messages'), isProv() ? T('patient.more.msg_mine', 'Write to your doctors and the front desk') : T('patient.more.msg', 'Write to your doctors and providers')],
      MC.feature('marketplace') ? ['#/market', 'globe', T('patient.nav.market', 'Marketplace'), T('patient.more.market', 'Find any hospital, clinic, pharmacy or lab near you')] : null,
      MC.feature('careSharing') ? ['#/more/care-team', 'users', T('patient.nav.care_team', 'My care team'), T('patient.more.care_team', 'Providers who look after you together')] : null,
      MC.feature('documents') ? ['#/more/documents', 'file', T('patient.nav.documents', 'My documents'), T('patient.more.documents', 'Letters, sick notes, forms and old records')] : null,
      MC.feature('wearables') ? ['#/more/health-devices', 'heart', T('patient.nav.health_devices', 'Health devices'), T('patient.more.health_devices', 'Sync your watch and home devices; share readings with your providers')] : null,
      ['#/more/hmo', 'shield', T('patient.nav.hmo', 'HMO cover'), T('patient.more.hmo', 'Your health insurance and what is left')],
      aiOn() ? ['#/more/assistant', 'heart', T('patient.nav.assistant', 'Health assistant'), T('patient.more.ai', 'Ask about symptoms and medicines')] : null,
      needProvider() ? null : ['#/more/contact', 'phone', isProv() && cur() ? T('patient.contact.card_title', 'Contact {provider}', { provider: curName() }) : T('patient.nav.contact', 'Contact numbers'), T('patient.more.contact', 'Phone and WhatsApp numbers for each department')],
      ['#/sos', 'ambulance', T('patient.nav.emergency', 'Emergency'), T('patient.more.sos', 'SOS and past ambulance requests')],
      ['#/more/profile', 'user', T('patient.nav.profile', 'Profile and settings'), isProv() ? T('patient.more.profile_mine', 'Allergies, language, privacy') : T('patient.more.profile', 'Allergies, language, sharing, privacy')],
      ['#/more/notifications', 'bell', T('kit.notifications', 'Notifications'), T('patient.more.notifs', 'Updates about your care')]].filter(Boolean);
    view(html`${head(T('patient.nav.more', 'More'))}<div class="list">${items.map(([h, i, l, s]) => html`<a href="${h}">${icon(i)}<div class="grow"><span class="title">${l}</span><span class="sub">${s}</span></div><span class="count badge bad" data-count="${h}" hidden></span>${icon('right')}</a>`)}</div>
      <div class="btn-row"><button class="btn" data-action="signout">${icon('logout')}${T('kit.signout', 'Sign out')}</button></div>`);
    refreshCounts();
  }

  // the marketplace part (assets/patient-market.js) pays, refreshes and switches providers through these
  MC.patientApp = { payBill, loadProviders, choose, providers: () => providers(), refreshCounts };

  /* ---------------- boot ---------------- */
  const nav = (href, icon1, key, en, extra) => Object.assign({ href, icon: icon1, get label() { return T(key, en); } }, extra || {});
  MC.boot({
    title: 'MediCore', home: '#/',
    nav: [
      nav('#/', 'home', 'patient.nav.home', 'Home'),
      { href: '#/care', icon: 'steth', get label() { return isProv() ? T('patient.nav.care_mine', 'Care') : T('patient.nav.care', 'Find care'); }, get short() { return T('patient.nav.care_short', 'Care'); } },
      nav('#/medicines', 'pill', 'patient.nav.medicines', 'Medicines'),
      nav('#/results', 'flask', 'patient.nav.results', 'Results'),
      nav('#/more', 'more', 'patient.nav.more', 'More'),
      nav('#/more/providers', 'building', 'patient.nav.providers', 'My providers', { sideOnly: true, show: () => isProv() }),
      nav('#/more/appointments', 'calendar', 'patient.nav.appointments', 'Appointments', { sideOnly: true }),
      nav('#/more/bills', 'card', 'patient.nav.bills', 'Bills and payments', { sideOnly: true }),
      nav('#/more/messages', 'message', 'patient.nav.messages', 'Messages', { sideOnly: true }),
      nav('#/market', 'globe', 'patient.nav.market', 'Marketplace', { sideOnly: true, show: () => MC.feature('marketplace') }),
      nav('#/more/care-team', 'users', 'patient.nav.care_team', 'My care team', { sideOnly: true, show: () => MC.feature('careSharing') }),
      nav('#/more/documents', 'file', 'patient.nav.documents', 'My documents', { sideOnly: true, show: () => MC.feature('documents') }),
      nav('#/more/health-devices', 'heart', 'patient.nav.health_devices', 'Health devices', { sideOnly: true, show: () => MC.feature('wearables') }),
      nav('#/more/hmo', 'shield', 'patient.nav.hmo', 'HMO cover', { sideOnly: true }),
      nav('#/more/assistant', 'heart', 'patient.nav.assistant', 'Health assistant', { sideOnly: true, show: () => aiOn() }),
      nav('#/more/contact', 'phone', 'patient.nav.contact', 'Contact numbers', { sideOnly: true }),
      nav('#/sos', 'ambulance', 'patient.nav.emergency', 'Emergency', { sideOnly: true }),
      nav('#/more/profile', 'user', 'patient.nav.profile', 'Profile and settings', { sideOnly: true }),
    ],
    routes: {
      '#/': home, '#/care': care, '#/care/doctor/:id': doctorPage, '#/care/provider/:id': providerPage,
      '#/medicines': medicines, '#/medicines/send/:id': sendRx, '#/medicines/order/:id': orderPage,
      '#/results': results, '#/results/lab/:id': labPage, '#/results/lab/:id/choose': chooseLab,
      '#/sos': sosPage, '#/sos/:id': sosTrack, '#/pay/:reference': payReturn,
      '#/more': more, '#/more/appointments': appointments, '#/more/appointments/:id': appointmentPage, '#/more/appointments/:id/video': videoPage,
      '#/more/bills': bills, '#/more/messages': messages, '#/more/messages/:id': thread, '#/more/hmo': hmo, '#/more/assistant': assistant,
      '#/more/profile': profile, '#/more/notifications': notifications, '#/more/contact': contactPage,
      '#/more/providers': providersPage, '#/more/join': joinPage, '#/more/referrals': referralsPage,
      ...MC.pmarket.routes(),
    },
    beforeSignOut: () => { MC.api.header('X-MC-Provider', null); prov.summary = null; prov.current = null; try { localStorage.removeItem('mcp-summary'); } catch (e) { } return true; },
    loginFooter: () => html`<p class="foot">${T('patient.login.new', 'New to MediCore?')} <a href="/register.html#/patient"><b>${T('patient.login.create', 'Create your account')}</b></a></p><p class="foot">${T('patient.login.emergency', 'Emergency? Call 112 or 767 (Lagos).')}</p>`,
    // choose the provider BEFORE the first route loads any data, so every list is scoped to it
    onReady: async () => { if (isProv()) await loadProviders(); else { prov.summary = null; MC.api.header('X-MC-Provider', null); } refreshCounts(); },
  });
})();
