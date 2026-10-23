/* Join MediCore: patient sign-up (phone + SMS code) and provider sign-up ("build your own package").
 * Runs signed out (MC.boot anonymous). Patient sign-up signs straight into the patient app. */
(function () {
  'use strict';
  const { html, api, money, date, icon, badge, view, on, form, toast } = MC;
  // the register page talks to the patient API (data-api-app defaults to 'patient' in the kit), so the session made at sign-up works here
  const T = MC.t;

  (function styles() {
    const s = document.createElement('style');
    s.textContent = [
      'body.no-nav .main{padding-top:var(--s5)}',
      '.rg-head{display:flex;gap:var(--s3);align-items:center;margin-bottom:var(--s4)}.rg-head img{width:44px;height:44px;border-radius:12px}.rg-head b{display:block;font-size:var(--t-lg)}.rg-head span{color:var(--ink-3);font-size:var(--t-sm)}',
      '.big-choice{display:grid;gap:var(--s3);margin:var(--s4) 0}',
      '.big-choice a,.big-choice button{display:flex;gap:var(--s3);align-items:center;text-align:left;padding:var(--s4);min-height:88px;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);color:var(--ink);text-decoration:none;font:inherit;cursor:pointer;width:100%}',
      '.big-choice a:hover,.big-choice button:hover{border-color:var(--hue)}',
      '.big-choice svg{width:32px;height:32px;color:var(--hue);flex:none}.big-choice .grow{flex:1}.big-choice b{display:block;font-size:var(--t-lg)}.big-choice span span{color:var(--ink-3);font-size:var(--t-sm)}',
      '.types{display:grid;grid-template-columns:1fr 1fr;gap:var(--s2);margin-bottom:var(--s4)}',
      '.types button{display:flex;flex-direction:column;gap:6px;align-items:flex-start;padding:var(--s3);min-height:92px;border:1px solid var(--line);border-radius:var(--r);background:var(--surface);color:var(--ink);font:inherit;font-weight:700;cursor:pointer;text-align:left}',
      '.types button svg{width:26px;height:26px;color:var(--hue)}.types button small{font-weight:400;color:var(--ink-3)}',
      '.types button[aria-pressed="true"]{border-color:var(--hue);box-shadow:0 0 0 2px var(--hue);background:var(--hue-soft)}',
      '.mod{display:flex;gap:var(--s3);align-items:flex-start;padding:var(--s3) var(--s4);border-top:1px solid var(--line-2);cursor:pointer;min-height:56px}.mod:first-child{border-top:0}',
      '.mod input{width:22px;height:22px;accent-color:var(--hue);margin-top:2px;flex:none}.mod .grow{flex:1;min-width:0}.mod b{display:block}.mod .sub{color:var(--ink-3);font-size:var(--t-sm);display:block}.mod .end{flex:none;text-align:right;font-weight:700}',
      '.mod:has(input:disabled){opacity:.6;cursor:not-allowed}',
      '.price{position:sticky;bottom:0;z-index:5}',
      '.price dl{margin:0}.price .total dt,.price .total dd{font-size:var(--t-lg);font-weight:700}',
      '.field>label.opt{display:flex}',
      '.opt{display:flex;gap:var(--s3);align-items:flex-start;padding:var(--s3) var(--s4);border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);cursor:pointer;min-height:56px;margin-bottom:var(--s2)}',
      '.opt input{width:22px;height:22px;accent-color:var(--hue);margin-top:2px;flex:none}.opt:has(input:checked){border-color:var(--hue);box-shadow:0 0 0 1px var(--hue)}.opt .grow{flex:1}.opt b{display:block}.opt .sub{display:block;color:var(--ink-3);font-size:var(--t-sm)}',
      '.seg-r{display:flex;gap:var(--s2);flex-wrap:wrap}.seg-r .opt{flex:1;min-width:150px;margin:0}',
      '.al-list{display:flex;flex-wrap:wrap;gap:var(--s2);margin:var(--s2) 0}',
      '.al-chip{display:inline-flex;align-items:center;gap:6px;background:var(--red);color:#fff;font-weight:700;border-radius:4px;padding:4px 4px 4px 10px;font-size:var(--t-sm)}',
      '.al-chip button{border:0;background:rgba(255,255,255,.2);color:#fff;border-radius:4px;min-width:32px;min-height:32px;cursor:pointer;display:grid;place-items:center}.al-chip svg{width:16px;height:16px}',
      '.opt .sub{font-weight:400}',
      '.devcode{font-size:1.5rem;letter-spacing:.15em}',
      '.links{display:grid;gap:6px;margin:0;padding:0;list-style:none}.links li{display:flex;justify-content:space-between;gap:var(--s3);flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--line-2)}.links li:first-child{border-top:0}.links code{overflow-wrap:anywhere}',
    ].join('\n');
    document.head.appendChild(s);
  })();

  const $ = id => document.getElementById(id);
  const content = (k, fb) => { const v = MC.content(k, fb); return v === 'content.' + MC.APP + '.' + k ? (fb || '') : v; };
  const fail = (msg, field) => new MC.ApiError(400, { error: msg, details: field ? [{ field, error: msg }] : undefined });
  const changeH = {}; const inputH = {};
  document.addEventListener('change', e => { const el = e.target && e.target.closest && e.target.closest('[data-change]'); if (el && changeH[el.dataset.change]) changeH[el.dataset.change](el, e); });
  document.addEventListener('input', e => { const el = e.target && e.target.closest && e.target.closest('[data-input]'); if (el && inputH[el.dataset.input]) inputH[el.dataset.input](el, e); });

  const head = sub => html`<div class="rg-head"><img src="/icons/patient-192.png" alt=""><div><b>${T('register.brand', 'Join MediCore')}</b>${sub ? html`<span>${sub}</span>` : ''}</div></div>`;
  const langPick = () => { const o = MC.langOptions(); if (o.length < 2) return ''; return html`<div class="field"><label for="rg-lang">${T('kit.language', 'Language')}</label><select class="input" id="rg-lang" data-lang-select>${o.map(x => html`<option value="${x.key}" ${x.key === MC.lang ? 'selected' : ''}>${x.label}</option>`)}</select></div>`; };
  const legalLinks = () => {
    const p = content('privacyUrl', ''); const tm = content('termsUrl', '');
    return p || tm ? html`<p class="sm">${p ? html`<a href="${p}" target="_blank" rel="noopener">${T('register.privacy_link', 'Privacy notice')}</a>` : ''}${p && tm ? ' | ' : ''}${tm ? html`<a href="${tm}" target="_blank" rel="noopener">${T('register.terms_link', 'Terms of use')}</a>` : ''}</p>` : '';
  };
  const pwRule = () => T('register.pw_rule', 'At least 8 characters, with letters and numbers. Do not use your phone number.');

  /* ---------------- choose ---------------- */
  function choose() {
    view(html`${head(T('register.sub', 'One account for all your health care'))}
      ${MC.me ? html`<div class="notice">${T('register.signed_in', 'You are already signed in.')} <a href="/index.html">${T('register.open_app', 'Open the MediCore app')}</a></div>` : ''}
      <h1>${T('register.choose_title', 'How will you use MediCore?')}</h1>
      <div class="big-choice">
        <a href="#/patient">${icon('user')}<span class="grow"><b>${T('register.patient', 'For me and my family')}</b><span>${T('register.patient_sub', 'Book doctors, get medicines delivered, see results, call an ambulance.')}</span></span>${icon('right')}</a>
        <a href="#/provider">${icon('building')}<span class="grow"><b>${T('register.provider', 'For my health business')}</b><span>${content('providerIntro', 'Bring your hospital, clinic, pharmacy, ambulance service or lab onto MediCore.')}</span></span>${icon('right')}</a></div>
      ${langPick()}
      <p class="sm">${T('register.have_account', 'Already have an account?')} <a href="/index.html"><b>${T('register.signin', 'Sign in')}</b></a></p>`);
  }

  /* ---------------- patient sign-up ---------------- */
  const ps = { step: 1, phone: '', devCode: null, code: '', firstName: '', lastName: '', dob: '', sex: '', allergyMode: '', allergies: [], err: null, jq: '', jt: '', here: null, rows: [], applied: null, locTried: false };
  // provider mode (the default): a new patient applies to their hospital, clinic, pharmacy or lab right after sign-up
  const provMode = () => (((MC.config() || {}).patients || {}).mode || 'provider') !== 'open';
  const pSteps = () => provMode()
    ? MC.steps(['1', '2', '3', '4'], String(ps.step), { 1: T('register.p.step1', 'Phone'), 2: T('register.p.step2', 'About you'), 3: T('register.p.step3', 'Safety and password'), 4: T('register.p.step4', 'Your provider') })
    : MC.steps(['1', '2', '3'], String(ps.step), { 1: T('register.p.step1', 'Phone'), 2: T('register.p.step2', 'About you'), 3: T('register.p.step3', 'Safety and password') });
  const JTYPES = () => [['', T('register.j.any', 'Any kind')], ['hospital', T('register.v.t.hospital', 'Hospital')], ['clinic', T('register.v.t.clinic', 'Clinic or medical centre')], ['pharmacy', T('register.v.t.pharmacy', 'Pharmacy')], ['lab', T('register.v.t.lab', 'Laboratory')]];
  const typeLabel = k => (JTYPES().find(x => x[0] === k) || [k, MC.cap(k)])[1];
  async function pJoin() {
    const openApp = html`<a class="btn primary lg block" href="/index.html">${T('register.j.open_app', 'Open the MediCore app')}</a>`;
    if (ps.applied) {
      const a = ps.applied;
      view(html`${head()}${pSteps()}<h1>${a.approved ? T('register.j.done_now', 'You are registered with {provider}', { provider: a.name }) : T('register.j.done_title', 'Application sent')}</h1>
        <div class="notice ok">${a.approved ? T('register.j.done_now_body', 'Your record number is {mrn}. You can book, get your medicines and see your results in the app.', { mrn: a.mrn || '' }) : T('register.j.done_body', 'Application sent to {provider}. You will be notified when they approve it.', { provider: a.name })}</div>
        ${a.approved ? '' : html`<p class="sm">${T('register.j.meanwhile', 'Meanwhile you can use SOS in an emergency, and the health assistant if it is available.')}</p>`}${openApp}`);
      return;
    }
    let sum = null; try { sum = await api.get('/api/me/providers/summary'); } catch (e) { sum = null; }
    if (sum && sum.providers && sum.providers.length) {
      view(html`${head()}${pSteps()}<h1>${T('register.j.already', 'You are already registered with {provider}', { provider: sum.providers.map(p => p.name).join(', ') })}</h1>
        <div class="notice ok">${T('register.j.already_body', 'A provider registered you before with this phone number, so your records are ready in the app.')}</div>${openApp}`);
      return;
    }
    if (!ps.locTried) {
      ps.locTried = true;
      try { if (navigator.permissions) { const st = await navigator.permissions.query({ name: 'geolocation' }); if (st.state === 'granted') ps.here = await MC.position(5000); } } catch (e) { /* location is optional */ }
    }
    ps.rows = await api.get('/api/join/providers' + MC.qs({ q: ps.jq, type: ps.jt, lat: ps.here && ps.here.lat, lng: ps.here && ps.here.lng, limit: 50 }));
    view(html`${head()}${pSteps()}
      <h1>${T('register.j.title', 'Choose your hospital, clinic, pharmacy or lab')}</h1>
      <p class="muted">${T('register.j.sub', 'Apply to be registered there. They check your details and approve you, usually within a working day. Then you can book, get medicines and see results.')}</p>
      <form class="panel" data-form="j-search" novalidate><div class="field"><label for="j-q">${T('register.j.search', 'Name or area')}</label><input class="input" id="j-q" name="q" value="${ps.jq}" maxlength="60" enterkeyhint="search"></div>
        <div class="field"><label for="j-t">${T('register.j.kind', 'Kind of provider')}</label><select class="input" id="j-t" name="type">${JTYPES().map(([k, l]) => html`<option value="${k}" ${k === ps.jt ? 'selected' : ''}>${l}</option>`)}</select></div>
        <div class="btn-row" style="margin-top:0"><button class="btn primary" type="submit">${icon('search')}${T('register.j.find', 'Search')}</button><button type="button" class="btn ${ps.here ? 'primary' : ''}" data-action="j-near">${icon('pin')}${ps.here ? T('register.j.nearest_on', 'Nearest first') : T('register.j.nearest', 'Show nearest first')}</button></div></form>
      ${ps.rows.length ? html`<ul class="list">${ps.rows.map((o, i) => html`<li><div class="grow"><span class="title">${o.name}</span><span class="sub">${typeLabel(o.type)}${o.kind === 'group' ? ' | ' + T('register.j.branches_n', '{n} branches', { n: o.branches.length }) : ''}${o.distanceKm != null ? ' | ' + T('register.j.km', '{n} km', { n: o.distanceKm }) : ''}</span>
          <span class="sub">${o.kind === 'group' ? o.branches.map(b => b.branchName).join(', ') : [o.area, o.city].filter(Boolean).join(', ')}</span></div><span class="end"><button class="btn sm primary" data-action="j-apply" data-i="${i}">${T('register.j.choose', 'Choose')}</button></span></li>`)}</ul>`
        : html`<div class="empty"><b>${T('register.j.none', 'No providers found')}</b><p class="sm">${T('register.j.none_sub', 'Try another name or area, or choose any kind.')}</p></div>`}
      <div class="btn-row"><a class="btn ghost" href="/index.html">${T('register.j.skip', 'Skip for now')}</a></div>
      <p class="sm muted">${T('register.j.skip_hint', 'You can apply later in the app under More, My providers.')}</p>`);
  }
  form('j-search', d => { ps.jq = d.q || ''; ps.jt = d.type || ''; return pJoin(); });
  on('j-near', async () => {
    if (ps.here) { ps.here = null; return pJoin(); }
    toast(T('register.j.locating', 'Finding your location...'));
    const p = await MC.position();
    if (!p) { toast(T('register.j.noloc', 'Location is not available. Search by name or area instead.'), 'bad'); return; }
    ps.here = p; return pJoin();
  });
  on('j-apply', async el => {
    const o = ps.rows[Number(el.dataset.i)]; if (!o) return;
    const group = o.kind === 'group' && o.branches.length > 1;
    const brs = o.branches.slice().sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    const r = await MC.dialog({ title: T('register.j.apply_to', 'Apply to {provider}', { provider: o.name }), form: true,
      body: html`${group ? html`<div class="field"><span class="label">${T('register.j.branch', 'Which branch will you go to?')}</span>${brs.map((b, k) => html`<label class="opt"><input type="radio" name="orgId" value="${b.id}" ${k === 0 ? 'checked' : ''}><span class="grow"><b>${b.branchName}</b><span class="sub">${[b.area, b.city].filter(Boolean).join(', ')}${b.distanceKm != null ? ' | ' + T('register.j.km', '{n} km', { n: b.distanceKm }) : ''}</span></span></label>`)}<div class="hint">${T('register.j.branch_hint', 'Once approved you are a patient of every branch, with one record number.')}</div></div>`
        : html`<input type="hidden" name="orgId" value="${o.branches[0] ? o.branches[0].id : o.id}">`}
        <div class="field"><label for="ja-n">${T('register.j.note', 'Note to the provider (optional)')}</label><textarea class="input" id="ja-n" name="note" maxlength="300" placeholder="${T('register.j.note_ph', 'e.g. I moved nearby and need a family doctor')}"></textarea></div>
        <p class="muted sm">${T('register.j.shares', 'They will see your name, date of birth, sex, phone number and address to decide.')}</p>`,
      actions: [{ label: T('kit.cancel', 'Cancel'), value: null }, { label: T('register.j.send', 'Send application'), primary: true }],
      onSubmit: d => api.post('/api/me/applications', { orgId: d.orgId, note: d.note }) });
    if (!r) return;
    const bn = group ? (o.branches.find(b => b.id === r.application.orgId) || {}).branchName : null;
    ps.applied = { name: bn ? T('register.j.prov_branch', '{provider}, {branch} branch', { provider: o.name, branch: bn }) : o.name, approved: !!r.approved, mrn: r.mrn || null };
    toast(r.approved ? T('register.j.registered_toast', 'Registered with {provider}', { provider: o.name }) : T('register.j.sent_toast', 'Application sent to {provider}', { provider: o.name }), 'ok');
    pJoin(); window.scrollTo(0, 0);
  });
  function patient() {
    if (ps.step === 4) return pJoin();
    if (!MC.feature('patientSelfSignup')) { view(html`${head()}<div class="notice warn">${T('register.p.closed', 'New sign-ups are paused at the moment. Visit any MediCore provider to be registered there, or try again later.')}</div><a class="btn" href="#/">${T('register.back', 'Back')}</a>`); return; }
    if (ps.step === 1) {
      view(html`<a class="back" href="#/">${icon('left')}${T('register.back', 'Back')}</a>${head(T('register.p.title', 'Create your MediCore account'))}${pSteps()}
        <p>${content('patientIntro', 'Create your MediCore account to book doctors, get medicines delivered and see your results.')}</p>
        <form class="panel" data-form="p-phone" novalidate>${langPick()}
          <div class="field"><label for="p-ph">${T('register.p.phone', 'Your phone number')}</label><input class="input" id="p-ph" name="phone" inputmode="tel" autocomplete="tel" value="${ps.phone}" placeholder="0803 123 4567" required><div class="hint">${T('register.p.phone_hint', 'We send a 6-digit code by SMS to check it is your number.')}</div></div>
          <div class="form-err notice bad" hidden></div><button class="btn primary lg block" type="submit">${T('register.p.send_code', 'Send me a code')}</button></form>
        <p class="sm">${T('register.have_account', 'Already have an account?')} <a href="/index.html">${T('register.signin', 'Sign in')}</a></p>`);
      return;
    }
    if (ps.step === 2) {
      view(html`<a class="back" href="#/patient" data-action="p-back">${icon('left')}${T('register.back', 'Back')}</a>${head(T('register.p.title', 'Create your MediCore account'))}${pSteps()}
        <form class="panel" data-form="p-about" novalidate>
          ${ps.devCode ? html`<div class="notice">${T('kit.demo_code', 'Demo mode: your code is')} <b class="devcode">${ps.devCode}</b></div>` : ''}
          ${ps.err ? html`<div class="notice bad">${ps.err}</div>` : ''}
          <div class="field"><label for="p-c">${T('register.p.code', 'Code we sent to {phone}', { phone: ps.phone })}</label><input class="input" id="p-c" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" value="${ps.code}" required><div class="hint"><button type="button" class="btn ghost sm" data-action="p-resend">${T('register.p.resend', 'Send the code again')}</button></div></div>
          <div class="fields two"><div class="field"><label for="p-fn">${T('register.p.first', 'First name')}</label><input class="input" id="p-fn" name="firstName" autocomplete="given-name" maxlength="60" value="${ps.firstName}" required></div>
            <div class="field"><label for="p-ln">${T('register.p.last', 'Last name (surname)')}</label><input class="input" id="p-ln" name="lastName" autocomplete="family-name" maxlength="60" value="${ps.lastName}" required></div></div>
          <div class="field"><label for="p-dob">${T('register.p.dob', 'Date of birth')}</label><input class="input" id="p-dob" name="dob" type="date" max="${MC.todayISO()}" min="1900-01-01" value="${ps.dob}" required><div class="hint">${T('register.p.dob_hint', 'Doctors need your age to choose safe medicine doses.')}</div></div>
          <div class="field"><span class="label">${T('register.p.sex', 'Sex')}</span><div class="seg-r">${[['female', T('register.p.female', 'Female')], ['male', T('register.p.male', 'Male')], ['other', T('register.p.other', 'Other')]].map(([v, l]) => html`<label class="opt"><input type="radio" name="sex" value="${v}" ${ps.sex === v ? 'checked' : ''}><span class="grow"><b>${l}</b></span></label>`)}</div></div>
          <div class="form-err notice bad" hidden></div><button class="btn primary lg block" type="submit">${T('register.next', 'Next')}</button></form>`);
      return;
    }
    view(html`<a class="back" href="#/patient" data-action="p-back">${icon('left')}${T('register.back', 'Back')}</a>${head(T('register.p.title', 'Create your MediCore account'))}${pSteps()}
      <form data-form="p-finish" novalidate>
        <section class="panel"><h2>${T('register.p.allergy_h', 'Do you have any allergies?')}</h2><p class="sm muted">${T('register.p.allergy_sub', 'For example to medicines like penicillin, or to foods. This keeps you safe when doctors and pharmacists give you medicine.')}</p>
          <div class="field" style="margin:0"><label class="opt"><input type="radio" name="allergyMode" value="none" data-change="p-almode" ${ps.allergyMode === 'none' ? 'checked' : ''}><span class="grow"><b>${T('register.p.nka', 'No known allergies')}</b><span class="sub">${T('register.p.nka_sub', 'I am not allergic to any medicine or food that I know of.')}</span></span></label>
          <label class="opt"><input type="radio" name="allergyMode" value="some" data-change="p-almode" ${ps.allergyMode === 'some' ? 'checked' : ''}><span class="grow"><b>${T('register.p.has_allergy', 'Yes, I have allergies')}</b><span class="sub">${T('register.p.has_allergy_sub', 'Add each one below.')}</span></span></label></div>
          <div id="al-box" ${ps.allergyMode === 'some' ? '' : 'hidden'}><div id="al-list"></div>
            <div class="fields two"><div class="field"><label for="al-s">${T('register.p.al_what', 'Allergic to')}</label><input class="input" id="al-s" maxlength="80" placeholder="${T('register.p.al_ph', 'e.g. Penicillin')}"></div>
              <div class="field"><label for="al-r">${T('register.p.al_react', 'What happens (optional)')}</label><input class="input" id="al-r" maxlength="120" placeholder="${T('register.p.al_react_ph', 'e.g. rash, swelling')}"></div></div>
            <div class="field"><label for="al-v">${T('register.p.al_sev', 'How bad')}</label><select class="input" id="al-v"><option value="unknown">${T('register.sev.unknown', 'Not sure')}</option><option value="mild">${T('register.sev.mild', 'Mild')}</option><option value="moderate">${T('register.sev.moderate', 'Moderate')}</option><option value="severe">${T('register.sev.severe', 'Severe')}</option></select></div>
            <button type="button" class="btn" data-action="p-al-add">${icon('plus')}${T('register.p.al_add', 'Add this allergy')}</button></div></section>
        <section class="panel"><h2>${T('register.p.pw_h', 'Choose a password')}</h2>
          <div class="field"><label for="p-pw">${T('kit.password', 'Password')}</label><input class="input" id="p-pw" name="password" type="password" autocomplete="new-password" maxlength="128" required><div class="hint">${pwRule()}</div></div>
          <label class="check"><input type="checkbox" data-change="p-showpw"><span>${T('register.show_pw', 'Show password')}</span></label></section>
        <section class="panel"><h2>${T('register.p.privacy_h', 'Your privacy')}</h2>
          <p class="sm">${provMode() ? T('register.p.privacy_body_prov', 'MediCore keeps your health records safe. Each provider sees only the records it made for you; they move to another provider only when one refers you. You can download or delete your data at any time.') : T('register.p.privacy_body', 'MediCore keeps your health records safe and shares them only with providers you visit. You decide which providers can see records from your other providers. You can download or delete your data at any time.')}</p>${legalLinks()}
          <label class="check"><input type="checkbox" name="consent" required><span>${T('register.p.consent', 'I have read and agree to the MediCore privacy notice and terms.')}</span></label></section>
        <div class="form-err notice bad" hidden></div><button class="btn primary lg block" type="submit">${T('register.p.create', 'Create my account')}</button></form>`);
    drawAllergies();
  }
  function drawAllergies() {
    const box = $('al-list'); if (!box) return;
    MC.view(ps.allergies.length ? html`<div class="al-list">${ps.allergies.map((a, i) => html`<span class="al-chip">${icon('alert')}${a.substance}${a.reaction ? ': ' + a.reaction : ''}<button type="button" data-action="p-al-rm" data-i="${i}" aria-label="${T('register.p.al_rm', 'Remove {name}', { name: a.substance })}">${icon('x')}</button></span>`)}</div>` : html`<p class="muted sm">${T('register.p.al_none_yet', 'No allergies added yet.')}</p>`, box);
  }
  changeH['p-almode'] = el => { ps.allergyMode = el.value; const b = $('al-box'); if (b) b.hidden = el.value !== 'some'; if (el.value === 'some') setTimeout(() => { const i = $('al-s'); if (i) i.focus(); }, 0); };
  changeH['p-showpw'] = el => { const p = $('p-pw'); if (p) p.type = el.checked ? 'text' : 'password'; };
  on('p-al-add', () => {
    const s = $('al-s').value.trim(); if (!s) { toast(T('register.p.al_need', 'Type what you are allergic to'), 'bad'); $('al-s').focus(); return; }
    if (ps.allergies.length >= 20) return;
    ps.allergies.push({ substance: s, reaction: $('al-r').value.trim() || undefined, severity: $('al-v').value || 'unknown' });
    $('al-s').value = ''; $('al-r').value = ''; $('al-v').value = 'unknown'; drawAllergies(); $('al-s').focus();
  });
  on('p-al-rm', el => { ps.allergies.splice(Number(el.dataset.i), 1); drawAllergies(); });
  on('p-back', () => { const f = document.querySelector('form[data-form="p-about"]'); if (f) Object.assign(ps, pick(MC.formData(f), ['code', 'firstName', 'lastName', 'dob', 'sex'])); ps.step = Math.max(1, ps.step - 1); ps.err = null; patient(); });
  const pick = (o, keys) => { const r = {}; keys.forEach(k => { if (o[k] !== undefined) r[k] = o[k]; }); return r; };
  form('p-phone', async d => {
    if (!d.phone) throw fail(T('register.p.need_phone', 'Type your phone number'), 'phone');
    try {
      const r = await api.post('/api/patients/register/start', { phone: d.phone });
      ps.phone = d.phone; ps.devCode = r.devCode || null; ps.step = 2; ps.err = null; patient();
    } catch (e) {
      if (e.code === 'account_exists') throw new MC.ApiError(409, { error: T('register.p.exists', 'This phone number already has a MediCore account. Sign in, or use "Forgot password" on the sign-in page.') });
      throw e;
    }
  });
  on('p-resend', async () => { const r = await api.post('/api/patients/register/start', { phone: ps.phone }); ps.devCode = r.devCode || ps.devCode; toast(T('register.p.resent', 'A new code was sent'), 'ok'); const f = document.querySelector('form[data-form="p-about"]'); if (f) Object.assign(ps, pick(MC.formData(f), ['code', 'firstName', 'lastName', 'dob', 'sex'])); patient(); });
  form('p-about', async d => {
    if (!/^\d{6}$/.test(d.code || '')) throw fail(T('register.p.need_code', 'Type the 6-digit code from the SMS'), 'code');
    if (!d.firstName) throw fail(T('register.p.need_first', 'Type your first name'), 'firstName');
    if (!d.lastName) throw fail(T('register.p.need_last', 'Type your last name'), 'lastName');
    if (!d.dob) throw fail(T('register.p.need_dob', 'Choose your date of birth'), 'dob');
    if (!d.sex) throw fail(T('register.p.need_sex', 'Choose one'), 'sex');
    Object.assign(ps, pick(d, ['code', 'firstName', 'lastName', 'dob', 'sex'])); ps.step = 3; ps.err = null; patient();
  });
  form('p-finish', async d => {
    if (ps.allergyMode !== 'none' && ps.allergyMode !== 'some') throw fail(T('register.p.need_allergy', 'Choose "No known allergies" or add your allergies'), 'allergyMode');
    if (ps.allergyMode === 'some' && !ps.allergies.length) {
      const typed = $('al-s') && $('al-s').value.trim();
      if (typed) ps.allergies.push({ substance: typed, reaction: $('al-r').value.trim() || undefined, severity: $('al-v').value || 'unknown' });
      else throw fail(T('register.p.need_allergy_item', 'Add at least one allergy, or choose "No known allergies"'), 'allergyMode');
    }
    const pw = d.password || '';
    if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw fail(pwRule(), 'password');
    if (!d.consent) throw fail(T('register.p.need_consent', 'Tick the box to agree to the privacy notice'), 'consent');
    const body = { phone: ps.phone, code: ps.code, firstName: ps.firstName, lastName: ps.lastName, dob: ps.dob, sex: ps.sex, password: pw, consent: true, lang: MC.lang,
      noKnownAllergies: ps.allergyMode === 'none', allergies: ps.allergyMode === 'some' ? ps.allergies : [] };
    try { await api.post('/api/patients/register', body); }
    catch (e) {
      const codeErr = /code/i.test(e.message) && !(e.details || []).some(x => x.field && x.field !== 'code');
      if (codeErr) { ps.step = 2; ps.err = e.message; patient(); return; }
      throw e;
    }
    // the sign-up call does not store the language yet, so save it on the new profile
    if (MC.lang !== 'en') { try { await api.patch('/api/me/profile', { lang: MC.lang }); } catch (e) { } }
    toast(T('register.p.done', 'Welcome to MediCore'), 'ok');
    if (provMode()) { ps.step = 4; ps.err = null; await pJoin(); window.scrollTo(0, 0); return; }
    location.href = '/index.html';
  });

  /* ---------------- provider sign-up ---------------- */
  const pv = { step: 1, type: null, modules: new Set(), seats: null, period: 'monthly', details: {}, result: null, quote: null };
  let pricing = null; const getPricing = async () => pricing || (pricing = await api.get('/api/pricing'));
  const TYPE_META = () => ({ hospital: ['building', T('register.v.t.hospital', 'Hospital'), T('register.v.t.hospital_sub', 'Doctors, wards, pharmacy, lab, ambulance')], clinic: ['steth', T('register.v.t.clinic', 'Clinic or medical centre'), T('register.v.t.clinic_sub', 'Doctors and consultations')],
    pharmacy: ['pill', T('register.v.t.pharmacy', 'Pharmacy'), T('register.v.t.pharmacy_sub', 'Prescriptions, sales, delivery')], ambulance: ['ambulance', T('register.v.t.ambulance', 'Ambulance service'), T('register.v.t.ambulance_sub', 'Emergency calls, fleet, crew')],
    lab: ['flask', T('register.v.t.lab', 'Laboratory'), T('register.v.t.lab_sub', 'Tests, samples, results')], other: ['heart', T('register.v.t.other', 'Other health service'), T('register.v.t.other_sub', 'Pick the apps you need')],
    hmo: ['shield', T('register.v.t.hmo', 'HMO or health insurer'), T('register.v.t.hmo_sub', 'Members, authorisations, claims')] });
  const modLabel = (k, m) => T('register.mod.' + k, (m && m.label) || k);
  const modDesc = (k, m) => T('register.mod.' + k + '_desc', (m && m.desc) || '');
  const vSteps = () => MC.steps(['1', '2', '3'], String(pv.step), { 1: T('register.v.step1', 'Type'), 2: T('register.v.step2', 'Apps and price'), 3: T('register.v.step3', 'Details') });
  const STATES = ['Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT Abuja', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara'];
  const LICENCES = () => [['moh', T('register.v.lic.moh', 'State Ministry of Health facility registration')], ['hefamaa', T('register.v.lic.hefamaa', 'HEFAMAA accreditation (Lagos)')], ['pcn', T('register.v.lic.pcn', 'PCN premises licence (pharmacy)')], ['mlscn', T('register.v.lic.mlscn', 'MLSCN laboratory licence')], ['nhia', T('register.v.lic.nhia', 'NHIA accreditation (HMO)')], ['other', T('register.v.lic.other', 'Other')]];
  const defLicence = t => ({ pharmacy: 'pcn', lab: 'mlscn', hmo: 'nhia' }[t] || 'moh');

  async function provider({ stale }) {
    if (!MC.feature('providerSelfSignup')) { view(html`${head()}<div class="notice warn">${T('register.v.closed', 'Provider sign-up is paused. Email the MediCore team and we will set you up.')}</div><a class="btn" href="#/">${T('register.back', 'Back')}</a>`); return; }
    const pr = await getPricing();
    if (stale && stale()) return;
    if (pv.result) return providerDone();
    if (pv.step === 1) {
      const tm = TYPE_META();
      view(html`<a class="back" href="#/">${icon('left')}${T('register.back', 'Back')}</a>${head(T('register.v.title', 'Bring your provider onto MediCore'))}${vSteps()}
        <h1>${T('register.v.type_q', 'What kind of provider are you?')}</h1><p class="muted">${T('register.v.type_sub', 'This only picks sensible apps to start with. You choose exactly what you pay for next.')}</p>
        <div class="types">${Object.keys(pr.orgTypes).filter(k => tm[k]).map(k => html`<button type="button" data-action="pv-type" data-type="${k}" aria-pressed="${pv.type === k ? 'true' : 'false'}">${icon(tm[k][0])}${tm[k][1]}<small>${tm[k][2]}</small></button>`)}</div>`);
      return;
    }
    if (pv.step === 2) {
      const allowed = pv.type === 'hmo' ? [] : [...new Set((pr.orgTypes[pv.type].modules || []).concat(pr.orgTypes[pv.type].optional || []))].filter(m => !['frontdesk', 'hmo', 'payer'].includes(m) && pr.modulesKobo[m] != null);
      const order = ['clinic', 'pharmacy', 'lab', 'delivery', 'ambulance', 'chw'];
      allowed.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const tm = TYPE_META();
      view(html`<a class="back" href="#/provider" data-action="pv-back">${icon('left')}${T('register.back', 'Back')}</a>${head(T('register.v.title', 'Bring your provider onto MediCore'))}${vSteps()}
        <h1>${T('register.v.apps_title', 'Build your package')}</h1><p class="muted">${T('register.v.apps_sub', 'Tick the apps your {type} needs. You pay only for what you switch on, and you can change it later.', { type: tm[pv.type][1] })}</p>
        <form data-form="pv-apps" novalidate>
        ${pv.type === 'hmo' ? html`<section class="panel"><h2>${modLabel('payer', pr.modules.payer)}</h2><p class="sm">${modDesc('payer', pr.modules.payer)}</p><p><b>${T('register.v.per_month', '{price} a month', { price: money(pr.modulesKobo.payer) })}</b></p></section>`
          : html`<section class="panel"><div class="row between top"><div><h2 style="margin:0 0 4px">${T('register.v.core', 'Core package (always included)')}</h2>
            <ul class="sm" style="margin:0;padding-left:20px"><li>${T('register.v.core_patient', 'Patient app: your patients book, pay and see results on their phones')}</li><li>${T('register.v.core_fd', 'Front desk: registration, check-in, queue, billing and customer care')}</li><li>${T('register.v.core_admin', 'Admin console: staff, price list, reports and audit log')}</li><li>${T('register.v.core_hmo', 'HMO billing: check cover, request pre-authorisation, submit claims')}</li></ul></div>
            <b style="white-space:nowrap">${money(pr.baseKobo)}</b></div></section>
            <section class="panel flush"><h2>${T('register.v.service_apps', 'Service apps')}</h2><div>${allowed.map(k => { const m = pr.modules[k] || {}; return html`<label class="mod"><input type="checkbox" name="modules" data-list value="${k}" data-change="pv-mod" ${pv.modules.has(k) ? 'checked' : ''}><span class="grow"><b>${modLabel(k, m)}</b><span class="sub">${modDesc(k, m)}</span>${(m.requires || []).length ? html`<span class="sub" id="req-${k}">${T('register.v.needs', 'Needs {apps}', { apps: m.requires.map(r => modLabel(r, pr.modules[r])).join(T('register.v.or', ' or ')) })}</span>` : ''}</span><span class="end">${money(pr.modulesKobo[k])}</span></label>`; })}</div></section>
            ${(pr.bundleDiscounts || []).length ? html`<p class="sm muted">${pr.bundleDiscounts.map(dd => T('register.v.bundle', '{n} or more service apps: {p}% off', { n: dd.minModules, p: dd.percent })).join(' | ')}</p>` : ''}`}
        <section class="panel"><div class="fields two"><div class="field"><label for="pv-seats">${T('register.v.seats', 'Staff accounts')}</label><input class="input" id="pv-seats" name="seats" type="number" min="1" max="2000" step="1" value="${pv.seats || pr.seatsIncluded}" data-input="pv-seats"><div class="hint">${T('register.v.seats_hint', '{n} included. Each extra account is {price} a month.', { n: pr.seatsIncluded, price: money(pr.extraSeatKobo) })}</div></div>
          <div class="field"><span class="label">${T('register.v.period', 'How do you want to pay?')}</span><label class="opt"><input type="radio" name="period" value="monthly" data-change="pv-period" ${pv.period === 'monthly' ? 'checked' : ''}><span class="grow"><b>${T('register.v.monthly', 'Monthly')}</b></span></label>
            <label class="opt"><input type="radio" name="period" value="annual" data-change="pv-period" ${pv.period === 'annual' ? 'checked' : ''}><span class="grow"><b>${T('register.v.annual', 'Yearly')}</b><span class="sub">${T('register.v.annual_sub', 'Pay for {n} months, get 12', { n: pr.annualMonthsCharged })}</span></span></label></div></div></section>
        <section class="panel price" id="pv-price" aria-live="polite">${MC.skeleton(2)}</section>
        <div class="form-err notice bad" hidden></div><button class="btn primary lg block" type="submit">${T('register.next', 'Next')}</button></form>`);
      syncDelivery(); requote();
      return;
    }
    const d = pv.details; const tm = TYPE_META();
    const v = k => d[k] || '';
    view(html`<a class="back" href="#/provider" data-action="pv-back">${icon('left')}${T('register.back', 'Back')}</a>${head(T('register.v.title', 'Bring your provider onto MediCore'))}${vSteps()}
      <h1>${T('register.v.details_title', 'Your {type}', { type: tm[pv.type][1].toLowerCase() })}</h1>
      ${pv.quote ? html`<div class="notice">${T('register.v.chosen', 'Your package: {price} a month', { price: money(pv.quote.monthlyKobo) })}${pv.quote.period === 'annual' ? ' | ' + T('register.v.billed_yearly', 'billed yearly at {total}', { total: money(pv.quote.totalKobo) }) : ''}. ${T('register.v.trial', 'The first {n} days are free.', { n: pv.quote.trialDays })}</div>` : ''}
      <form data-form="pv-details" novalidate>
        <section class="panel"><h2>${T('register.v.biz', 'Business details')}</h2>
          ${groupsOk() ? html`<label class="check"><input type="checkbox" name="multi" data-change="pv-multi" ${d.multi ? 'checked' : ''}><span><b>${T('register.v.multi', 'We have more than one branch')}</b><br><span class="sm muted">${T('register.v.multi_sub', 'Sign up as a group. You add this first branch now, and the others after approval.')}</span></span></label>` : ''}
          <div id="v-grp" ${d.multi && groupsOk() ? '' : 'hidden'}><div class="fields two"><div class="field"><label for="v-gn">${T('register.v.group_name', 'Group name')}</label><input class="input" id="v-gn" name="groupName" maxlength="120" value="${v('groupName')}" placeholder="${T('register.v.group_name_ph', 'e.g. Crestview Hospitals')}" ${d.multi && groupsOk() ? '' : 'disabled'}></div>
            <div class="field"><label for="v-bn">${T('register.v.branch_name', 'Name of this first branch')}</label><input class="input" id="v-bn" name="branchName" maxlength="80" value="${v('branchName')}" placeholder="${T('register.v.branch_name_ph', 'e.g. Ikeja')}" ${d.multi && groupsOk() ? '' : 'disabled'}></div></div>
            <div class="notice">${T('register.v.group_hint', 'The address and details below are for this first branch. After approval, sign in to the group console to add your other branches, their staff and price lists.')}</div></div>
          <div class="field" id="v-n-box" ${d.multi && groupsOk() ? 'hidden' : ''}><label for="v-n">${T('register.v.name', 'Provider name')}</label><input class="input" id="v-n" name="name" maxlength="120" value="${v('name')}" required placeholder="${T('register.v.name_ph', 'As registered with CAC')}" ${d.multi && groupsOk() ? 'disabled' : ''}></div>
          <div class="fields two"><div class="field"><label for="v-ph">${T('register.v.phone', 'Business phone')}</label><input class="input" id="v-ph" name="phone" inputmode="tel" value="${v('phone')}" required></div><div class="field"><label for="v-em">${T('register.v.email', 'Business email')}</label><input class="input" id="v-em" name="email" type="email" value="${v('email')}" required></div></div>
          <div class="field"><label for="v-ad">${T('register.v.address', 'Address')}</label><input class="input" id="v-ad" name="address" maxlength="300" value="${v('address')}" required></div>
          <div class="fields three"><div class="field"><label for="v-ar">${T('register.v.area', 'Area')}</label><input class="input" id="v-ar" name="area" maxlength="80" value="${v('area')}" placeholder="${T('register.v.area_ph', 'e.g. Surulere')}"></div><div class="field"><label for="v-ci">${T('register.v.city', 'City or town')}</label><input class="input" id="v-ci" name="city" maxlength="80" value="${v('city')}"></div>
            <div class="field"><label for="v-st">${T('register.v.state', 'State')}</label><select class="input" id="v-st" name="state"><option value="">${T('register.v.choose', 'Choose')}</option>${STATES.map(s => html`<option value="${s}" ${v('state') === s ? 'selected' : ''}>${s}</option>`)}</select></div></div>
          <div class="fields two"><div class="field"><label for="v-cac">${T('register.v.cac', 'CAC registration number')}</label><input class="input" id="v-cac" name="cacNumber" maxlength="40" value="${v('cacNumber')}" placeholder="RC 123456"></div>
            <div class="field"><label for="v-lk">${T('register.v.lic_kind', 'Licence type')}</label><select class="input" id="v-lk" name="licenceKind">${LICENCES().map(([k, l]) => html`<option value="${k}" ${(v('licenceKind') || defLicence(pv.type)) === k ? 'selected' : ''}>${l}</option>`)}</select></div></div>
          <div class="field"><label for="v-ln">${T('register.v.lic_no', 'Licence number')}</label><input class="input" id="v-ln" name="licenceNumber" maxlength="60" value="${v('licenceNumber')}"><div class="hint">${T('register.v.kyc_hint', 'The MediCore team checks these before approving you.')}</div></div></section>
        <section class="panel"><h2>${T('register.v.owner', 'Your owner account')}</h2><p class="sm muted">${T('register.v.owner_sub', 'You will sign in to the admin console with this, and add your staff there.')}</p>
          <div class="field"><label for="o-n">${T('register.v.o_name', 'Your full name')}</label><input class="input" id="o-n" name="ownerName" autocomplete="name" maxlength="100" value="${v('ownerName')}" required></div>
          <div class="fields two"><div class="field"><label for="o-e">${T('register.v.o_email', 'Your email')}</label><input class="input" id="o-e" name="ownerEmail" type="email" autocomplete="email" value="${v('ownerEmail')}" required></div><div class="field"><label for="o-p">${T('register.v.o_phone', 'Your phone')}</label><input class="input" id="o-p" name="ownerPhone" inputmode="tel" autocomplete="tel" value="${v('ownerPhone')}" required></div></div>
          <div class="field"><label for="o-pw">${T('kit.password', 'Password')}</label><input class="input" id="o-pw" name="ownerPassword" type="password" autocomplete="new-password" maxlength="128" required><div class="hint">${pwRule()}</div></div></section>
        <section class="panel"><label class="check"><input type="checkbox" name="acceptTerms"><span>${T('register.v.terms', 'I accept the MediCore terms of service and the data processing agreement. I confirm I am allowed to sign up this provider.')}</span></label>${legalLinks()}</section>
        <div class="form-err notice bad" hidden></div><button class="btn primary lg block" type="submit">${T('register.v.submit', 'Send for approval')}</button></form>`);
  }
  const groupsOk = () => pv.type !== 'hmo' && MC.feature('groups');
  changeH['pv-multi'] = el => {
    const on1 = el.checked; pv.details.multi = on1;
    $('v-grp').hidden = !on1; $('v-n-box').hidden = on1;
    $('v-gn').disabled = !on1; $('v-bn').disabled = !on1; $('v-n').disabled = on1;
    if (on1) setTimeout(() => $('v-gn').focus(), 0);
  };
  on('pv-type', el => { const t = el.dataset.type; if (pv.type !== t) { pv.type = t; pv.modules = new Set((pricing.orgTypes[t].modules || []).filter(m => !['frontdesk', 'hmo', 'payer'].includes(m))); } pv.step = 2; provider({}); window.scrollTo(0, 0); });
  on('pv-back', () => { const f = document.querySelector('form[data-form="pv-details"]'); if (f) { const d = MC.formData(f); delete d.ownerPassword; Object.assign(pv.details, d); } pv.step = Math.max(1, pv.step - 1); provider({}); window.scrollTo(0, 0); });
  function syncDelivery() {
    const del = document.querySelector('input[name=modules][value=delivery]'); if (!del) return;
    const ok = pv.modules.has('pharmacy') || pv.modules.has('lab');
    del.disabled = !ok; if (!ok && del.checked) { del.checked = false; pv.modules.delete('delivery'); }
  }
  changeH['pv-mod'] = el => { if (el.checked) pv.modules.add(el.value); else pv.modules.delete(el.value); syncDelivery(); requote(); };
  changeH['pv-period'] = el => { pv.period = el.value; requote(); };
  inputH['pv-seats'] = el => { const n = Math.round(Number(el.value)); pv.seats = n >= 1 && n <= 2000 ? n : null; requote(); };
  let qTimer = null; let qSeq = 0;
  function requote() {
    clearTimeout(qTimer);
    qTimer = setTimeout(async () => {
      const seq = ++qSeq; const box = $('pv-price'); if (!box) return;
      let q;
      try { q = await api.post('/api/pricing/quote', { type: pv.type, modules: [...pv.modules], seats: pv.seats || undefined, period: pv.period }); }
      catch (e) { if (seq === qSeq && $('pv-price')) MC.view(html`<div class="notice bad" style="margin:0">${e.message}</div>`, $('pv-price')); return; }
      if (seq !== qSeq || !$('pv-price')) return;
      pv.quote = q;
      const yearAtMonthly = q.monthlyKobo * 12; const yearly = q.monthlyKobo * (pricing.annualMonthsCharged || 12);
      MC.view(html`<h2>${T('register.v.your_price', 'Your price')}</h2><dl class="kv">${q.lines.map(l => html`<dt>${l.key === 'base' ? T('register.v.core_short', 'Core package') : modLabel(l.key, pricing.modules[l.key])}</dt><dd>${money(l.kobo)}</dd>`)}
          ${q.discount ? html`<dt>${T('register.v.discount', 'Bundle discount ({p}%)', { p: q.discount.percent })}</dt><dd>-${money(q.discount.kobo)}</dd>` : ''}
          ${q.seats.extra ? html`<dt>${T('register.v.extra_seats', '{n} extra staff accounts', { n: q.seats.extra })}</dt><dd>${money(q.seats.kobo)}</dd>` : ''}</dl>
        <dl class="kv total" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line)"><dt>${T('register.v.monthly_total', 'Monthly total')}</dt><dd>${money(q.monthlyKobo)}</dd></dl>
        ${q.period === 'annual' ? html`<p class="sm" style="margin:6px 0 0">${T('register.v.yearly_total', 'Billed yearly: {total}. You save {saving}.', { total: money(q.totalKobo), saving: money(yearAtMonthly - q.totalKobo) })}</p>`
          : yearAtMonthly > yearly ? html`<p class="sm muted" style="margin:6px 0 0">${T('register.v.yearly_hint', 'Pay yearly and save {saving}.', { saving: money(yearAtMonthly - yearly) })}</p>` : ''}
        <dl class="kv" style="margin-top:8px"><dt>${T('register.v.bank', 'Bank service charge')}</dt><dd>${T('register.v.bank_each', '{amount} per payment', { amount: money(q.bankChargePerPaymentKobo) })}</dd></dl>
        <p class="xs muted" style="margin:6px 0 0">${T('register.v.bank_note', 'The bank charge is added to each subscription payment you make, not to your patients.')} ${T('register.v.trial', 'The first {n} days are free.', { n: q.trialDays })}</p>`, $('pv-price'));
    }, 200);
  }
  form('pv-apps', async d => {
    if (pv.type !== 'hmo' && !pv.modules.size && pv.type !== 'other') throw fail(T('register.v.need_app', 'Choose at least one service app'));
    if (d.seats != null && (d.seats < 1 || d.seats > 2000)) throw fail(T('register.v.seats_range', 'Staff accounts must be between 1 and 2000'), 'seats');
    pv.seats = d.seats || null; pv.step = 3; provider({}); window.scrollTo(0, 0);
  });
  form('pv-details', async d => {
    Object.assign(pv.details, d); delete pv.details.ownerPassword;
    const multi = !!d.multi && groupsOk();
    if (multi) {
      if (!d.groupName || d.groupName.length < 3) throw fail(T('register.v.need_group', 'Type the group name (at least 3 letters)'), 'groupName');
      if (!d.branchName || d.branchName.length < 2) throw fail(T('register.v.need_branch', 'Type the name of this branch'), 'branchName');
      d.name = d.groupName;
    }
    const need = [['name', T('register.v.need_name', 'Type the provider name')], ['phone', T('register.v.need_phone', 'Type the business phone')], ['email', T('register.v.need_email', 'Type the business email')], ['address', T('register.v.need_address', 'Type the address')], ['ownerName', T('register.v.need_oname', 'Type your name')], ['ownerEmail', T('register.v.need_oemail', 'Type your email')], ['ownerPhone', T('register.v.need_ophone', 'Type your phone')]];
    for (const [k, m] of need) if (!d[k]) throw fail(m, k);
    const pw = d.ownerPassword || ''; if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw fail(pwRule(), 'ownerPassword');
    if (!d.acceptTerms) throw fail(T('register.v.need_terms', 'Tick the box to accept the terms and the data processing agreement'), 'acceptTerms');
    const lic = LICENCES().find(x => x[0] === d.licenceKind);
    const body = { type: pv.type, name: d.name, modules: pv.type === 'hmo' ? ['payer'] : ['frontdesk', 'hmo'].concat([...pv.modules]), seats: pv.seats || undefined, period: pv.period,
      contact: { phone: d.phone, email: d.email, address: d.address }, location: { area: d.area, city: d.city, state: d.state },
      kyc: { cacNumber: d.cacNumber, licenceKind: lic ? lic[1] : d.licenceKind, licenceNumber: d.licenceNumber },
      owner: { name: d.ownerName, email: d.ownerEmail, phone: d.ownerPhone, password: pw }, acceptTerms: true };
    if (multi) body.group = { name: d.groupName, branchName: d.branchName };
    try { pv.result = await api.post('/api/orgs/signup', body); }
    catch (e) {
      // the API reports nested fields (contact.phone, owner.email ...): show them on our flat inputs
      if (e.details) e.details = e.details.map(x => { const f = String(x.field || ''); const map = { 'contact.phone': 'phone', 'contact.email': 'email', 'contact.address': 'address', 'owner.name': 'ownerName', 'owner.email': 'ownerEmail', 'owner.phone': 'ownerPhone', 'owner.password': 'ownerPassword', 'kyc.cacNumber': 'cacNumber', 'kyc.licenceNumber': 'licenceNumber', 'group.name': 'groupName', 'group.branchName': 'branchName', name: multi ? 'groupName' : 'name' }; return Object.assign({}, x, { field: map[f] || f.split('.').pop() }); });
      throw e;
    }
    providerDone(); window.scrollTo(0, 0);
  });
  function providerDone() {
    const r = pv.result; const o = r.org; const mods = o.modules || []; const base = location.origin; const g = r.group;
    const apps = [['admin', T('register.v.app.admin', 'Admin console (owner and managers)'), true], ['frontdesk', T('register.v.app.frontdesk', 'Front desk, cashier'), mods.includes('frontdesk')], ['doctor', T('register.v.app.doctor', 'Doctors'), mods.includes('clinic')],
      ['pharmacy', T('register.v.app.pharmacy', 'Pharmacists, dispatchers'), mods.includes('pharmacy')], ['rider', T('register.v.app.rider', 'Delivery riders'), mods.includes('delivery')], ['lab', T('register.v.app.lab', 'Lab staff'), mods.includes('lab')],
      ['dispatch', T('register.v.app.dispatch', 'Ambulance dispatchers'), mods.includes('ambulance')], ['crew', T('register.v.app.crew', 'Ambulance crew'), mods.includes('ambulance')], ['chw', T('register.v.app.chw', 'Community health workers'), mods.includes('chw')], ['payer', T('register.v.app.payer', 'HMO officers'), mods.includes('payer')]].filter(a => a[2]);
    view(html`${head()}<h1>${T('register.v.done_title', 'Thank you, {name} is signed up', { name: g ? g.name : o.name })}</h1>
      <div class="notice ok"><b>${T('register.v.done_review', 'The MediCore team will review and approve your provider, usually within one working day.')}</b><br>${T('register.v.done_notify', 'We will contact you by phone or email. Until then, patients cannot find you and staff cannot sign in.')}</div>
      ${g ? html`<section class="panel"><h2>${T('register.v.group_h', 'Your group: {name}', { name: g.name })}</h2><p class="sm">${T('register.v.group_done', 'This sign-up is the first branch of the group. After approval, sign in to the group console with your owner email and password to add your other branches, staff in every branch, shared price lists and reports.')}</p>
        <dl class="kv"><dt>${T('register.v.group_code', 'Group code')}</dt><dd><b>${g.code}</b></dd><dt>${T('register.v.group_console', 'Group console')}</dt><dd><a href="/group.html"><code>${base}/group.html</code></a></dd></dl></section>` : ''}
      <section class="panel"><dl class="kv"><dt>${g ? T('register.v.branch_code', 'First branch code') : T('register.v.code', 'Your provider code')}</dt><dd><b>${o.code}</b></dd><dt>${T('register.v.status', 'Status')}</dt><dd>${badge(T('register.v.pending', 'Awaiting approval'), 'warn')}</dd>
        ${o.subscription ? html`<dt>${T('register.v.monthly_total', 'Monthly total')}</dt><dd>${money(o.subscription.monthlyKobo)}</dd><dt>${T('register.v.trial_ends', 'Free trial')}</dt><dd>${T('register.v.trial_until', '30 days, until {date}', { date: date(o.subscription.trialEnds) })}</dd>` : ''}</dl></section>
      <section class="panel"><h2>${T('register.v.next_h', 'What happens next')}</h2><ol class="sm" style="padding-left:20px;margin:0"><li>${g ? T('register.v.next1_group', 'After approval, sign in to the group console with your owner email and password, and add your other branches.') : T('register.v.next1', 'After approval, sign in to the admin console with your owner email and password.')}</li><li>${T('register.v.next2', 'Add your staff and their roles, and set your price list.')}</li><li>${T('register.v.next3', 'Give each staff member the link to their app below. They can add it to their phone home screen.')}</li></ol></section>
      <section class="panel"><h2>${T('register.v.links', 'App links for your team')}</h2><ul class="links">${apps.map(([k, l]) => html`<li><span>${l}</span><a href="/${k}.html"><code>${base}/${k}.html</code></a></li>`)}</ul></section>
      <div class="btn-row">${g ? html`<a class="btn primary" href="/group.html">${T('register.v.open_group', 'Open the group console')}</a><a class="btn" href="/admin.html">${T('register.v.open_admin', 'Open the admin console')}</a>` : html`<a class="btn primary" href="/admin.html">${T('register.v.open_admin', 'Open the admin console')}</a>`}<a class="btn" href="#/" data-action="pv-reset">${T('register.v.another', 'Back to start')}</a></div>`);
  }
  on('pv-reset', () => { Object.assign(pv, { step: 1, type: null, modules: new Set(), seats: null, period: 'monthly', details: {}, result: null, quote: null }); MC.go('#/'); });

  MC.boot({ title: 'Join MediCore', anonymous: true, home: '#/', routes: { '#/': choose, '#/patient': patient, '#/provider': provider } });
})();
