/* MediCore Front Desk: queue, registration, patient page, appointments, billing, HMO check,
 * customer care and incoming ambulance patients. Used at every provider type: each screen and
 * action shows only when the signed-in role has the permission and the provider has the module. */
(function () {
  'use strict';
  const { html, api, qs, money, date, dateTime, time, ago, cap, icon, badge, empty, figures, view, on, form, dialog, confirm, toast } = MC;
  const T = (k, en, v) => MC.t('frontdesk.' + k, en, v);
  const can = p => !!(MC.me && (MC.me.perms || []).includes(p));
  const canAny = (...ps) => ps.some(can);
  const hasMod = m => !!(MC.me && MC.me.org && (MC.me.org.modules || []).includes(m));
  const err400 = (msg, details) => new MC.ApiError(400, { error: msg, details });

  /* ---------------- shared bits ---------------- */
  function kindOf(s) { return /(done|completed|paid|resolved|active|verified|released|arrived)/.test(s) ? 'ok' : /(cancel|void|left|no_show|failed|rejected|expired)/.test(s) ? 'bad' : /(waiting|pending|open|booked|awaiting|new)/.test(s) ? 'warn' : 'info'; }
  const sb = s => badge(MC.t('status.' + s, cap(s)), kindOf(s));
  const PRI_CLS = { emergency: 'pri-P1', urgent: 'pri-P2', routine: 'pri-P3' };
  const priLabel = p => T('pri.' + p, cap(p));
  const pri = p => html`<span class="badge plain ${PRI_CLS[p] || ''}">${priLabel(p)}</span>`;
  const SP_ALL = ['doctor', 'triage', 'cashier', 'pharmacy', 'lab'];
  const spLabel = s => T('sp.' + s, { doctor: 'Doctor', triage: 'Triage', cashier: 'Cashier', pharmacy: 'Pharmacy', lab: 'Laboratory' }[s] || cap(s));
  const servicePoints = () => SP_ALL.filter(s => (s === 'doctor' ? hasMod('clinic') : s === 'pharmacy' ? hasMod('pharmacy') : s === 'lab' ? hasMod('lab') : true));
  const sexLabel = s => (s && s !== 'unknown' ? T('sex.' + s, cap(s)) : '');
  const ageSex = p => [p.age != null ? T('common.age', '{n} yrs', { n: p.age }) : '', sexLabel(p.sex)].filter(Boolean).join(', ');
  const back = (href, label) => html`<a class="back" href="${href}">${icon('left')}${label}</a>`;
  const typeLabel = t => (t === 'video' ? T('appt.video', 'Video') : t === 'walk_in' ? T('appt.walk_in', 'Walk-in') : T('appt.in_person', 'In person'));
  const vitalsLine = v => {
    if (!v) return '';
    const parts = [];
    if (v.bpSys != null) parts.push('BP ' + v.bpSys + '/' + v.bpDia);
    if (v.pulse != null) parts.push(T('vitals.pulse_short', 'Pulse {n}', { n: v.pulse }));
    if (v.tempC != null) parts.push(v.tempC + ' °C');
    if (v.spo2 != null) parts.push('SpO2 ' + v.spo2 + '%');
    return parts.join(' | ');
  };
  const flagBadges = flags => (flags || []).map(f => badge(f.message, f.level === 'critical' ? 'bad' : 'warn'));
  let doctorsCache = null;
  async function doctors() { if (doctorsCache) return doctorsCache; try { doctorsCache = hasMod('clinic') ? await api.get('/api/doctors' + qs({ orgId: MC.me.org.id, limit: 200 })) : []; } catch (e) { doctorsCache = []; } return doctorsCache; }
  async function maybe(p) { try { return await p; } catch (e) { if (e.status === 401) throw e; return null; } }

  /* ---------------- vitals form (shared by patient page) ---------------- */
  const VF = [
    ['bpSys', 'Systolic BP (mmHg)', 50, 260, 1], ['bpDia', 'Diastolic BP (mmHg)', 30, 160, 1], ['pulse', 'Pulse (beats/min)', 20, 250, 1],
    ['tempC', 'Temperature (°C)', 30, 45, 0.1], ['spo2', 'Oxygen saturation (%)', 50, 100, 1], ['rr', 'Breathing rate (per min)', 4, 80, 1],
    ['weightKg', 'Weight (kg)', 0.3, 400, 0.1], ['heightCm', 'Height (cm)', 20, 250, 0.1], ['glucose', 'Blood glucose (mmol/L)', 0.5, 40, 0.1],
  ];
  const vfLabel = f => T('vitals.f.' + f[0], f[1]);
  function vitalsFields(prefix) {
    return html`<div class="fields three">${VF.map(f => html`<div class="field"><label for="${prefix}-${f[0]}">${vfLabel(f)}</label><input class="input" id="${prefix}-${f[0]}" name="${f[0]}" type="number" inputmode="decimal" min="${f[2]}" max="${f[3]}" step="${f[4]}"></div>`)}</div>`;
  }
  function checkVitals(d) {
    const details = []; let any = false;
    for (const f of VF) {
      const v = d[f[0]]; if (v === undefined) continue; any = true;
      if (Number.isNaN(v) || v < f[2] || v > f[3]) details.push({ field: f[0], error: T('vitals.range', 'Must be between {min} and {max}', { min: f[2], max: f[3] }) });
      else if (f[4] === 1 && !Number.isInteger(v)) details.push({ field: f[0], error: T('vitals.whole', 'Enter a whole number') });
    }
    if (!any) throw err400(T('vitals.none', 'Enter at least one measurement'));
    if ((d.bpSys === undefined) !== (d.bpDia === undefined)) details.push({ field: d.bpSys === undefined ? 'bpSys' : 'bpDia', error: T('vitals.bp_both', 'Enter both systolic and diastolic pressure') });
    else if (d.bpSys !== undefined && d.bpDia >= d.bpSys) details.push({ field: 'bpDia', error: T('vitals.bp_order', 'Diastolic must be lower than systolic') });
    if (details.length) throw err400(T('vitals.fix', 'Check the highlighted measurements'), details);
  }
  function vitalsTable(rows) {
    if (!rows.length) return empty({ icon: 'pulse', title: T('vitals.empty', 'No vitals recorded yet'), body: T('vitals.empty_sub', 'Measurements taken at this provider appear here.') });
    return html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('vitals.when', 'When')}</th><th>BP</th><th>${T('vitals.pulse', 'Pulse')}</th><th>${T('vitals.temp', 'Temp')}</th><th>SpO2</th><th>${T('vitals.rr', 'RR')}</th><th>${T('vitals.weight', 'Weight')}</th><th>${T('vitals.glucose', 'Glucose')}</th><th>${T('vitals.flags', 'Flags')}</th></tr></thead><tbody>
      ${rows.map(v => html`<tr><td data-label="${T('vitals.when', 'When')}">${dateTime(v.at)}<br><span class="xs muted">${v.byName || ''}</span></td><td data-label="BP">${v.bpSys != null ? v.bpSys + '/' + v.bpDia : '-'}</td><td data-label="${T('vitals.pulse', 'Pulse')}">${v.pulse ?? '-'}</td><td data-label="${T('vitals.temp', 'Temp')}">${v.tempC ?? '-'}</td><td data-label="SpO2">${v.spo2 ?? '-'}</td><td data-label="${T('vitals.rr', 'RR')}">${v.rr ?? '-'}</td><td data-label="${T('vitals.weight', 'Weight')}">${v.weightKg ?? '-'}</td><td data-label="${T('vitals.glucose', 'Glucose')}">${v.glucose ?? '-'}</td><td data-label="${T('vitals.flags', 'Flags')}">${v.flags && v.flags.length ? flagBadges(v.flags) : html`<span class="muted">${T('vitals.normal', 'None')}</span>`}</td></tr>`)}
    </tbody></table></div>`;
  }

  /* ================= Today: live queue ================= */
  async function today({ query }) {
    const sp = servicePoints().includes(query.sp) ? query.sp : '';
    view(html`<div class="page-head"><div><h1>${T('today.title', 'Today')}</h1><p id="q-sub">${T('today.sub', 'Patients waiting and being seen now')}</p></div>
      <div class="actions">${canAny('queue.manage', 'patient.register') ? html`<a class="btn primary" href="#/patients">${icon('plus')}${T('today.checkin', 'Check in a patient')}</a>` : ''}${incomingOK && can('queue.manage') ? html`<a class="btn" href="#/incoming">${icon('ambulance')}${T('nav.incoming', 'Incoming')}</a>` : ''}</div></div>
      <div class="tabs" role="tablist" aria-label="${T('today.points', 'Service points')}">
        <a href="#/today" role="tab" aria-selected="${sp ? 'false' : 'true'}">${T('today.all', 'All')}</a>
        ${servicePoints().map(s => html`<a href="#/today?sp=${s}" role="tab" aria-selected="${sp === s ? 'true' : 'false'}">${spLabel(s)}</a>`)}
      </div>
      <div id="fd-ref-note"></div><div id="fd-app-note"></div>
      <div id="fd-q">${MC.skeleton(3)}</div>`);
    const box = document.getElementById('fd-q');
    MC.referrals.homeNotice(document.getElementById('fd-ref-note'));
    appsNotice(document.getElementById('fd-app-note'));
    const load = async () => {
      const [rows, done] = await Promise.all([api.get('/api/fd/queue' + qs({ servicePoint: sp })), api.get('/api/fd/queue' + qs({ servicePoint: sp, status: 'done' })).catch(() => [])]);
      if (!box.isConnected) return;
      lastQueue = rows;
      const by = s => rows.filter(r => r.status === s);
      const waiting = by('waiting'), called = by('called'), inSvc = by('in_service');
      MC.navCount('#/today', waiting.length);
      const sub = document.getElementById('q-sub'); if (sub) sub.textContent = T('today.updated', 'Updated {t}. Refreshes every 15 seconds.', { t: time(Date.now()) });
      const longest = waiting.length ? Math.max(...waiting.map(r => r.waitMin)) : 0;
      MC.view(html`${figures([{ value: waiting.length, label: T('today.waiting', 'Waiting'), tone: waiting.length > 10 ? 'warn' : '' }, { value: called.length, label: T('today.called', 'Called') }, { value: inSvc.length, label: T('today.in_service', 'In service') }, { value: (done || []).length, label: T('today.done', 'Seen today') }, { value: T('common.min', '{n} min', { n: longest }), label: T('today.longest', 'Longest wait'), tone: longest > 60 ? 'bad' : longest > 30 ? 'warn' : '' }])}
        ${rows.length ? html`${section(T('today.waiting', 'Waiting'), waiting)}${section(T('today.called', 'Called'), called)}${section(T('today.in_service', 'In service'), inSvc)}`
          : empty({ icon: 'users', title: T('today.empty', 'Nobody is waiting'), body: T('today.empty_sub', 'Checked-in patients appear here with their wait time.'), action: canAny('queue.manage') ? html`<a class="btn primary" href="#/patients">${T('today.checkin', 'Check in a patient')}</a>` : '' })}`, box);
    };
    const section = (title, list) => list.length ? html`<section class="panel flush"><h2>${title} <span class="muted sm">(${list.length})</span></h2><ul class="list">${list.map(queueRow)}</ul></section>` : '';
    await load();
    MC.poll(load, 15000);
  }
  let lastQueue = [];
  const canQueueAct = () => canAny('queue.manage', 'vitals.record', 'billing.cash', 'clinic.consult', 'pharmacy.dispense', 'lab.receive');
  function queueRow(r) {
    const act = canQueueAct();
    return html`<li style="flex-wrap:wrap">
      <span class="badge outline plain" aria-label="${T('today.ticket', 'Ticket')}"><b>${r.number}</b></span>
      <div class="grow" style="flex:1 1 220px"><a class="title" href="#/patient/${r.patientId}">${r.patient.name}</a>
        <span class="sub">${[r.patient.mrn, ageSex(r.patient), spLabel(r.servicePoint) + (r.doctorName ? ': ' + r.doctorName : '')].filter(Boolean).join(' | ')}</span>
        ${r.complaint ? html`<span class="sub">${T('today.complaint', 'Complaint')}: ${r.complaint}</span>` : ''}
        <span class="sub">${pri(r.priority)} ${r.status === 'waiting' ? T('today.waited', 'Waiting {n} min', { n: r.waitMin }) : T('today.waited_until', 'Waited {n} min', { n: r.waitMin })}${r.latestVitals ? html` | ${vitalsLine(r.latestVitals)} ${flagBadges(r.latestVitals.flags)}` : ''}</span></div>
      ${act ? html`<span class="end row wrap">
        ${r.status === 'waiting' ? html`<button class="btn sm primary" data-action="q-act" data-act="call" data-id="${r.id}">${T('today.call', 'Call')}</button>` : ''}
        ${r.status !== 'in_service' && r.servicePoint !== 'doctor' ? html`<button class="btn sm" data-action="q-act" data-act="start" data-id="${r.id}">${T('today.start', 'Start')}</button>` : ''}
        ${r.status === 'in_service' && r.servicePoint !== 'doctor' ? html`<button class="btn sm primary" data-action="q-act" data-act="done" data-id="${r.id}">${T('today.mark_done', 'Done')}</button>` : ''}
        ${canAny('queue.manage', 'vitals.record') ? html`<button class="btn sm" data-action="q-triage" data-id="${r.id}">${T('today.triage', 'Priority')}</button>` : ''}
        ${r.status !== 'in_service' ? html`<button class="btn sm ghost" data-action="q-left" data-id="${r.id}">${T('today.left', 'Left')}</button>` : ''}
      </span>` : ''}</li>`;
  }
  on('q-act', async el => {
    const r = await api.post('/api/fd/queue/' + el.dataset.id + '/' + el.dataset.act);
    toast({ call: T('today.toast_called', '{n} called', { n: r.number }), start: T('today.toast_started', '{n} started', { n: r.number }), done: T('today.toast_done', '{n} marked done', { n: r.number }) }[el.dataset.act], 'ok');
    MC.render();
  });
  on('q-left', async el => {
    const r = lastQueue.find(x => x.id === el.dataset.id);
    if (!(await confirm({ title: T('today.left_q', 'Mark as left?'), body: T('today.left_body', '{name} ({n}) will be taken off the queue as having left without being seen.', { name: r ? r.patient.name : '', n: r ? r.number : '' }), ok: T('today.left_ok', 'Mark as left'), danger: true }))) return;
    await api.post('/api/fd/queue/' + el.dataset.id + '/left'); toast(T('today.toast_left', 'Marked as left'), 'ok'); MC.render();
  });
  on('q-triage', async el => {
    const r = lastQueue.find(x => x.id === el.dataset.id); if (!r) return;
    const v = await dialog({ title: T('today.triage_t', 'Set priority for {name}', { name: r.patient.name }), form: true,
      body: html`<div class="field"><label for="tr-p">${T('today.priority', 'Priority')}</label><select class="input" id="tr-p" name="priority">${['emergency', 'urgent', 'routine'].map(p => html`<option value="${p}" ${p === r.priority ? 'selected' : ''}>${priLabel(p)}</option>`)}</select></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('today.set_priority', 'Set priority'), primary: true }], onSubmit: d => api.post('/api/fd/queue/' + r.id + '/triage', { priority: d.priority }) });
    if (v) { toast(T('today.toast_priority', 'Priority updated'), 'ok'); MC.render(); }
  });

  /* ================= find or register ================= */
  async function patients({ query }) {
    const rows = can('patient.read') ? await api.get('/api/fd/patients' + qs({ q: query.q, limit: query.q ? 50 : 15 })) : [];
    view(html`<div class="page-head"><div><h1>${T('find.title', 'Find or register a patient')}</h1><p>${T('find.sub', 'Always look up the phone number first so nobody gets two records.')}</p></div></div>
      <div class="grid two">
        ${can('patient.register') ? html`<form class="panel" data-form="fd-lookup" novalidate><h2>${T('find.by_phone', 'Look up by phone')}</h2>
          <div class="field"><label for="lk-ph">${T('find.phone', 'Patient phone number')}</label><input class="input" id="lk-ph" name="phone" inputmode="tel" autocomplete="off" placeholder="0803 123 4567" required></div>
          <div class="form-err notice bad" hidden></div>
          <div class="btn-row"><button class="btn primary" type="submit">${icon('search')}${T('find.lookup', 'Look up phone number')}</button><a class="btn ghost" href="#/register">${T('find.no_phone', 'Register without a phone')}</a></div></form>` : ''}
        ${can('patient.read') ? html`<form class="panel" data-form="fd-search" novalidate><h2>${T('find.search', 'Search our patients')}</h2>
          <div class="field search"><label class="sr-only" for="ps-q">${T('find.search_label', 'Name, phone or MRN')}</label>${icon('search')}<input class="input" id="ps-q" name="q" value="${query.q || ''}" placeholder="${T('find.search_label', 'Name, phone or MRN')}" autocomplete="off"></div>
          <button class="btn" type="submit">${T('find.search_btn', 'Search')}</button></form>` : ''}
      </div>
      ${can('patient.read') ? html`<section class="panel flush"><h2>${query.q ? T('find.results', 'Results for "{q}"', { q: query.q }) : T('find.recent', 'Recently registered')}</h2>
        ${rows.length ? html`<div class="list">${rows.map(p => html`<a href="#/patient/${p.id}"><div class="grow"><span class="title">${p.name}</span><span class="sub">${[p.mrn, ageSex(p), p.phone].filter(Boolean).join(' | ')}</span></div>${p.allergies && p.allergies.length ? html`<span class="allergy-tag">${icon('alert')}${T('find.allergy', 'Allergy')}</span>` : ''}<span style="width:20px;height:20px;flex:none;display:inline-flex" aria-hidden="true">${icon('right')}</span></a>`)}</div>`
          : empty({ icon: 'users', title: query.q ? T('find.none', 'No patient matches') : T('find.none_yet', 'No patients yet'), body: T('find.none_sub', 'Look up their phone number to link an existing MediCore record or register them.') })}</section>` : ''}`);
  }
  form('fd-search', d => MC.go('#/patients' + qs({ q: d.q })));
  form('fd-lookup', async d => {
    if (!d.phone) throw err400(T('find.need_phone', 'Enter the phone number'), [{ field: 'phone', error: T('find.need_phone', 'Enter the phone number') }]);
    const r = await api.post('/api/fd/patients/lookup', { phone: d.phone });
    if (r.status === 'linked') { toast(T('find.found', 'Patient found'), 'ok'); return MC.go('#/patient/' + r.patient.id); }
    if (r.status === 'new') return MC.go('#/register' + qs({ phone: d.phone }));
    const res = await dialog({ title: T('find.link_t', 'Ask the patient for their code'), form: true,
      body: html`<p>${r.message || T('find.link_body', 'This person already has a MediCore record. We have sent them a code by SMS.')}</p>
        ${r.devCode ? html`<div class="notice">${MC.t('kit.demo_code', 'Demo mode: your code is')} <b>${r.devCode}</b></div>` : ''}
        <div class="field"><label for="lk-c">${T('find.code', 'Code from the SMS')}</label><input class="input" id="lk-c" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('find.link_btn', 'Link record'), primary: true }],
      onSubmit: async f => { if (!f.code) throw err400(T('find.need_code', 'Enter the code the patient received')); return api.post('/api/fd/patients/link', { phone: d.phone, code: f.code }); } });
    if (res && res.patient) { toast(T('find.linked', 'Record linked to your provider'), 'ok'); MC.go('#/patient/' + res.patient.id); }
  });

  const BLOOD = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
  const GENO = ['AA', 'AS', 'SS', 'AC', 'SC'];
  const SEVS = ['mild', 'moderate', 'severe', 'unknown'];
  const sevLabel = s => T('sev.' + s, cap(s));
  const ALLERGY_ROWS = 6;
  const privacyText = () => MC.content('privacyNotice', 'MediCore keeps your health record safe and private, in line with the Nigeria Data Protection Act 2023. Your record is shared only with providers you are linked to, and records from other providers only when you switch sharing on. You can see, download or ask us to correct or delete your data at any time in the MediCore app.');
  async function register({ query }) {
    if (!can('patient.register')) return view(empty({ icon: 'lock', title: T('common.no_access', 'Your role cannot do this'), body: T('reg.no_access', 'Ask a receptionist or records officer to register the patient.') }));
    view(html`${back('#/patients', T('find.title', 'Find or register a patient'))}<div class="page-head"><div><h1>${T('reg.title', 'Register a new patient')}</h1><p>${T('reg.sub', 'Fields marked required must be filled. Check the spelling of the name with the patient.')}</p></div></div>
      <form data-form="fd-register" novalidate>
        <section class="panel"><h2>${T('reg.about', 'About the patient')}</h2>
          <div class="fields two"><div class="field"><label for="rg-fn">${T('reg.first', 'First name (required)')}</label><input class="input" id="rg-fn" name="firstName" required maxlength="60" autocomplete="off"></div>
          <div class="field"><label for="rg-ln">${T('reg.last', 'Last name (required)')}</label><input class="input" id="rg-ln" name="lastName" required maxlength="60" autocomplete="off"></div></div>
          <div class="fields three"><div class="field"><label for="rg-dob">${T('reg.dob', 'Date of birth')}</label><input class="input" id="rg-dob" name="dob" type="date" max="${MC.todayISO()}"></div>
          <div class="field"><label for="rg-sex">${T('reg.sex', 'Sex')}</label><select class="input" id="rg-sex" name="sex"><option value="unknown">${T('reg.choose', 'Choose')}</option><option value="female">${sexLabel('female')}</option><option value="male">${sexLabel('male')}</option><option value="other">${sexLabel('other')}</option></select></div>
          <div class="field"><label for="rg-w">${T('reg.weight', 'Weight (kg)')}</label><input class="input" id="rg-w" name="weightKg" type="number" min="0.3" max="400" step="0.1" inputmode="decimal"></div></div>
          <div class="fields two"><div class="field"><label for="rg-ph">${T('reg.phone', 'Phone')}</label><input class="input" id="rg-ph" name="phone" inputmode="tel" value="${query.phone || ''}" autocomplete="off"><div class="hint">${T('reg.phone_hint', 'The patient can later sign up in the MediCore app with this number to see their records.')}</div></div>
          <div class="field"><label for="rg-em">${T('reg.email', 'Email')}</label><input class="input" id="rg-em" name="email" type="email" autocomplete="off"></div></div>
          <div class="field"><label for="rg-ad">${T('reg.address', 'Home address')}</label><input class="input" id="rg-ad" name="address" maxlength="300" autocomplete="off"></div>
          <div class="fields two"><div class="field"><label for="rg-bg">${T('reg.blood', 'Blood group')}</label><select class="input" id="rg-bg" name="bloodGroup"><option value="">${T('reg.not_known', 'Not known')}</option>${BLOOD.map(b => html`<option>${b}</option>`)}</select></div>
          <div class="field"><label for="rg-gt">${T('reg.genotype', 'Genotype')}</label><select class="input" id="rg-gt" name="genotype"><option value="">${T('reg.not_known', 'Not known')}</option>${GENO.map(b => html`<option>${b}</option>`)}</select></div></div>
        </section>
        <section class="panel"><h2>${T('reg.allergies', 'Allergies (required)')}</h2>
          <p class="muted sm">${T('reg.allergies_sub', 'Ask: "Are you allergic to any medicine, food or anything else?" Record the answer. Do not leave it unknown.')}</p>
          <div class="field" id="rg-as-field"><span class="label" id="rg-as-l">${T('reg.allergy_status', 'Allergy status')}</span>
            <label class="check"><input type="radio" name="allergyStatus" value="has"><span>${T('reg.has_allergies', 'The patient has allergies')}</span></label>
            <label class="check"><input type="radio" name="allergyStatus" value="none"><span>${T('reg.nka', 'No known allergies (the patient confirmed)')}</span></label></div>
          <div id="rg-allergies" hidden>${Array.from({ length: ALLERGY_ROWS }, (_, i) => html`<div class="fields three" data-allergy-row="${i}" ${i > 0 ? 'hidden' : ''}>
            <div class="field"><label for="al-s-${i}">${T('reg.substance', 'Allergic to')}</label><input class="input" id="al-s-${i}" name="al_s_${i}" maxlength="80" placeholder="${T('reg.substance_ph', 'e.g. Penicillin')}" autocomplete="off"></div>
            <div class="field"><label for="al-r-${i}">${T('reg.reaction', 'Reaction')}</label><input class="input" id="al-r-${i}" name="al_r_${i}" maxlength="120" placeholder="${T('reg.reaction_ph', 'e.g. Rash')}" autocomplete="off"></div>
            <div class="field"><label for="al-v-${i}">${T('reg.severity', 'Severity')}</label><select class="input" id="al-v-${i}" name="al_v_${i}">${SEVS.map(s => html`<option value="${s}" ${s === 'unknown' ? 'selected' : ''}>${sevLabel(s)}</option>`)}</select></div></div>`)}
            <button type="button" class="btn sm" data-action="rg-more">${icon('plus')}${T('reg.more', 'Add another allergy')}</button></div>
        </section>
        <section class="panel"><h2>${T('reg.nok', 'Next of kin')}</h2>
          <div class="fields two"><div class="field"><label for="rg-nn">${T('reg.nok_name', 'Name')}</label><input class="input" id="rg-nn" name="nokName" maxlength="100" autocomplete="off"></div>
          <div class="field"><label for="rg-np">${T('reg.nok_phone', 'Phone')}</label><input class="input" id="rg-np" name="nokPhone" inputmode="tel" autocomplete="off"></div></div></section>
        <section class="panel"><h2>${T('reg.privacy', 'Privacy notice')}</h2>
          <p class="sm">${privacyText()}</p>
          <label class="check"><input type="checkbox" name="consent"><span>${T('reg.consent', 'I have read the privacy notice to the patient (or their guardian) and they agree to it.')}</span></label></section>
        <div class="form-err notice bad" hidden></div>
        <div class="btn-row"><button class="btn primary lg" type="submit">${T('reg.submit', 'Register patient')}</button><a class="btn lg" href="#/patients">${MC.t('kit.cancel', 'Cancel')}</a></div>
      </form>`);
  }
  document.addEventListener('change', e => {
    if (e.target && e.target.name === 'allergyStatus') { const box = document.getElementById('rg-allergies'); if (box) box.hidden = e.target.value !== 'has'; }
  });
  on('rg-more', el => { const next = document.querySelector('[data-allergy-row][hidden]'); if (next) { next.hidden = false; const i = next.querySelector('input'); if (i) i.focus(); } if (!document.querySelector('[data-allergy-row][hidden]')) el.hidden = true; });
  form('fd-register', async d => {
    const details = [];
    if (!d.firstName) details.push({ field: 'firstName', error: T('reg.need', 'Required') });
    if (!d.lastName) details.push({ field: 'lastName', error: T('reg.need', 'Required') });
    const allergies = [];
    for (let i = 0; i < ALLERGY_ROWS; i++) if (d['al_s_' + i]) allergies.push({ substance: d['al_s_' + i], reaction: d['al_r_' + i] || undefined, severity: d['al_v_' + i] || 'unknown' });
    if (!d.allergyStatus) details.push({ field: 'allergyStatus', error: T('reg.need_allergy', 'Choose whether the patient has allergies') });
    if (d.allergyStatus === 'has' && !allergies.length) details.push({ field: 'al_s_0', error: T('reg.need_substance', 'Write what the patient is allergic to') });
    if (!d.consent) details.push({ field: 'consent', error: T('reg.need_consent', 'The patient must agree to the privacy notice') });
    if (details.length) throw err400(T('reg.fix', 'Some details are missing. Check the highlighted fields.'), details);
    const body = { firstName: d.firstName, lastName: d.lastName, dob: d.dob, sex: d.sex, phone: d.phone, email: d.email, address: d.address, bloodGroup: d.bloodGroup, genotype: d.genotype, weightKg: d.weightKg, nokName: d.nokName, nokPhone: d.nokPhone, consent: true,
      allergies: d.allergyStatus === 'has' ? allergies : [], noKnownAllergies: d.allergyStatus === 'none' };
    const r = await api.post('/api/fd/patients', body);
    toast(T('reg.done', '{name} registered. MRN {mrn}', { name: r.patient.name, mrn: r.patient.mrn }), 'ok');
    MC.go('#/patient/' + r.patient.id);
  });

  /* ================= patient page ================= */
  const apptRead = () => hasMod('clinic') && canAny('queue.manage', 'patient.register', 'billing.create', 'billing.cash');
  async function patientPage({ params, stale }) {
    const pid = params.id;
    let p;
    try { p = await api.get('/api/fd/patients/' + pid); } catch (e) { if (e.status === 404) return view(empty({ icon: 'user', title: T('pt.not_found', 'Patient not found'), body: T('pt.not_found_sub', 'This patient is not linked to your provider. Look up their phone number to link them.'), action: html`<a class="btn primary" href="#/patients">${T('find.title', 'Find or register a patient')}</a>` })); throw e; }
    const [vitals, appts, bills, queue] = await Promise.all([
      maybe(api.get('/api/fd/patients/' + pid + '/vitals?limit=20')),
      apptRead() ? maybe(api.get('/api/fd/appointments' + qs({ patientId: pid }))) : null,
      canAny('billing.create', 'billing.cash') ? maybe(api.get('/api/bills' + qs({ patientId: pid, limit: 20 }))) : null,
      maybe(api.get('/api/fd/queue')),
    ]);
    if (stale()) return;
    const active = (queue || []).filter(q => q.patientId === pid);
    current = { p, appts: appts || [], active };
    view(html`${back('#/patients', T('nav.patients', 'Patients'))}${MC.wristband(p)}
      <div class="page-head"><div><h1>${p.name}</h1><p>${[p.mrn ? 'MRN ' + p.mrn : '', p.phone, p.linkedAt ? T('pt.linked', 'With us since {d}', { d: date(p.linkedAt) }) : ''].filter(Boolean).join(' | ')}</p></div>
        <div class="actions">
          ${can('queue.manage') ? html`<button class="btn primary" data-action="pt-checkin">${icon('check')}${T('pt.checkin', 'Check in')}</button>` : ''}
          ${hasMod('clinic') && canAny('queue.manage', 'patient.register') ? html`<a class="btn" href="#/book/${p.id}">${icon('calendar')}${T('pt.book', 'Book appointment')}</a>` : ''}
          ${can('billing.create') ? html`<a class="btn" href="#/bill/new?patientId=${p.id}">${icon('card')}${T('pt.bill', 'Create bill')}</a>` : ''}
          ${can('care.manage') ? html`<button class="btn" data-action="care-new" data-patient="${p.id}" data-name="${p.name}">${icon('message')}${T('pt.case', 'New care case')}</button>` : ''}
          ${MC.referrals.canSend() && MC.feature('referralNetwork') ? html`<button class="btn" data-action="pt-refer">${icon('swap')}${T('pt.refer', 'Refer to another provider')}</button>` : ''}
          ${canAny('patient.register', 'vitals.record') ? html`<button class="btn" data-action="pt-edit">${icon('edit')}${T('pt.edit', 'Edit details')}</button>` : ''}
        </div></div>
      ${active.length ? html`<div class="notice ok">${active.map(q => html`<div>${T('pt.in_queue', 'In the queue: ticket {n} at {sp}', { n: q.number, sp: spLabel(q.servicePoint) })} ${sb(q.status)}</div>`)}</div>` : ''}
      <div class="grid two">
        <div>
          <section class="panel"><h2>${T('pt.details', 'Details')}</h2><dl class="kv">
            <dt>${T('reg.dob', 'Date of birth')}</dt><dd>${p.dob ? date(Date.parse(p.dob + 'T12:00:00Z')) + ' (' + ageSex(p) + ')' : '-'}</dd>
            <dt>${T('reg.phone', 'Phone')}</dt><dd>${p.phone || '-'}${p.claimed ? html` ${badge(T('pt.app_user', 'Uses the app'), 'info')}` : ''}</dd>
            <dt>${T('reg.email', 'Email')}</dt><dd>${p.email || '-'}</dd>
            <dt>${T('reg.address', 'Home address')}</dt><dd>${p.address || '-'}</dd>
            <dt>${T('reg.blood', 'Blood group')}</dt><dd>${p.bloodGroup || '-'}</dd><dt>${T('reg.genotype', 'Genotype')}</dt><dd>${p.genotype || '-'}</dd>
            <dt>${T('reg.weight', 'Weight (kg)')}</dt><dd>${p.weightKg || '-'}</dd>
            <dt>${T('reg.nok', 'Next of kin')}</dt><dd>${p.nokName ? p.nokName + (p.nokPhone ? ', ' + p.nokPhone : '') : '-'}</dd>
            <dt>${T('reg.allergies_short', 'Allergies')}</dt><dd>${p.allergies.length ? p.allergies.map(a => html`<div><b>${a.substance}</b>${a.reaction ? ': ' + a.reaction : ''} <span class="muted">(${sevLabel(a.severity || 'unknown')})</span></div>`) : T('pt.no_allergies_listed', 'None recorded')}</dd>
            <dt>${T('pt.conditions', 'Conditions')}</dt><dd>${p.conditions.length ? p.conditions.map(c => c.name + (c.code ? ' (' + c.code + ')' : '')).join(', ') : '-'}</dd>
          </dl></section>
          ${canAny('patient.register', 'whatsapp.inbox') ? html`<section class="panel"><h2>${T('wa.title', 'WhatsApp')}</h2><div id="pt-wa">${waBoxBody(p)}</div></section>` : ''}
          ${canAny('hmo.check', 'hmo.claim') ? html`<section class="panel"><h2>${T('xh.title', 'Off-platform HMO cover')}</h2><div id="pt-xhmo">${MC.skeleton(1)}</div></section>` : ''}
          ${can('hmo.check') ? html`<section class="panel"><h2>${T('hmo.title', 'HMO cover')}</h2><div id="hmo-box"><p class="muted sm">${T('hmo.sub', 'Check whether an HMO covers this patient before billing.')}</p><button class="btn" data-action="hmo-check" data-id="${p.id}">${icon('shield')}${T('hmo.check', 'Check HMO cover')}</button></div></section>` : ''}
          ${appts ? html`<section class="panel flush"><h2>${T('pt.appts', 'Appointments')}</h2>${appts.length ? html`<ul class="list">${appts.slice(0, 10).map(a => html`<li><div class="grow"><span class="title">${date(a.startUtc)} ${a.time}, ${a.doctorName}</span><span class="sub">${typeLabel(a.type)}${a.reason ? ' | ' + a.reason : ''} | ${money(a.feeKobo)} ${a.paid ? T('pt.paid', 'paid') : T('pt.unpaid', 'not paid')}</span></div><span class="end">${sb(a.status)}</span></li>`)}</ul>` : empty({ icon: 'calendar', title: T('pt.no_appts', 'No appointments') })}</section>` : ''}
          ${bills ? html`<section class="panel flush"><h2>${T('pt.bills', 'Bills')}</h2>${bills.length ? html`<div class="list">${bills.map(b => html`<a href="#/bill/${b.id}"><div class="grow"><span class="title">${b.number} | ${money(b.totalKobo)}</span><span class="sub">${b.lines.map(l => l.name).join(', ')} | ${dateTime(b.createdAt)}</span></div>${sb(b.status)}</a>`)}</div>` : empty({ icon: 'card', title: T('pt.no_bills', 'No bills yet') })}</section>` : ''}
        </div>
        <div>
          ${can('vitals.record') ? html`<form class="panel" data-form="fd-vitals" novalidate><h2>${T('vitals.record', 'Record vitals')}</h2>${vitalsFields('vt')}<div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${T('vitals.save', 'Save vitals')}</button></form>` : ''}
          <section class="panel"><h2>${T('vitals.history', 'Vitals history')}</h2>${vitalsTable(vitals || [])}</section>
        </div>
      </div>`);
    if (canAny('hmo.check', 'hmo.claim')) await loadExtHmoBox(p, stale);
  }
  let current = null;
  form('fd-vitals', async d => {
    checkVitals(d);
    const q = current.active.find(x => x.status !== 'done') || null;
    const v = await api.post('/api/fd/vitals', Object.assign({ patientId: current.p.id, queueId: q ? q.id : undefined }, d));
    const flags = (v.flags || []).map(f => f.message).join('. ');
    toast(flags ? T('vitals.saved_flags', 'Vitals saved. Check: {flags}', { flags }) : T('vitals.saved', 'Vitals saved'), flags ? undefined : 'ok', flags ? 8000 : undefined);
    MC.render();
  });
  on('hmo-check', async el => {
    const box = document.getElementById('hmo-box');
    let rows;
    try { rows = await api.get('/api/hmo/patients/' + el.dataset.id + '/cover'); }
    catch (e) { if (e.status === 404 || e.status === 503) { MC.view(html`<div class="notice">${T('hmo.not_ready', 'HMO check is not available yet. Ask the patient for their HMO card and call the HMO.')}</div>`, box); return; } throw e; }
    MC.view(rows.length ? html`<ul class="list">${rows.map(c => html`<li><div class="grow"><span class="title">${c.payerName} | ${c.planName || ''}</span><span class="sub">${T('hmo.member', 'Member {n}', { n: c.memberNo })} | ${T('hmo.valid', 'Valid to {d}', { d: c.validTo ? date(Date.parse(c.validTo)) : '-' })}</span><span class="sub">${T('hmo.remaining', '{amt} left this year', { amt: money(c.remainingKobo) })}${c.preauthThresholdKobo ? ' | ' + T('hmo.preauth', 'Pre-authorisation needed above {amt}', { amt: money(c.preauthThresholdKobo) }) : ''}</span></div>${badge(T('hmo.active', 'Active'), 'ok')}</li>`)}</ul>`
      : html`<div class="notice">${T('hmo.none', 'No active HMO cover found. The patient pays themselves.')}</div>`, box);
  });
  on('pt-edit', async () => {
    const p = current.p; const full = can('patient.register');
    const ok = await dialog({ title: T('pt.edit_t', 'Edit {name}', { name: p.name }), form: true, wide: true, body: html`
      ${full ? html`<div class="fields two"><div class="field"><label for="pe-fn">${T('reg.first_s', 'First name')}</label><input class="input" id="pe-fn" name="firstName" value="${p.firstName}" required maxlength="60"></div><div class="field"><label for="pe-ln">${T('reg.last_s', 'Last name')}</label><input class="input" id="pe-ln" name="lastName" value="${p.lastName}" required maxlength="60"></div></div>
      <div class="fields two"><div class="field"><label for="pe-dob">${T('reg.dob', 'Date of birth')}</label><input class="input" id="pe-dob" name="dob" type="date" value="${p.dob || ''}" max="${MC.todayISO()}"></div><div class="field"><label for="pe-sex">${T('reg.sex', 'Sex')}</label><select class="input" id="pe-sex" name="sex">${['unknown', 'female', 'male', 'other'].map(s => html`<option value="${s}" ${p.sex === s ? 'selected' : ''}>${s === 'unknown' ? T('reg.not_known', 'Not known') : sexLabel(s)}</option>`)}</select></div></div>
      <div class="fields two"><div class="field"><label for="pe-ph">${T('reg.phone', 'Phone')}</label><input class="input" id="pe-ph" name="phone" inputmode="tel" value="${p.phone || ''}" ${p.claimed ? 'disabled' : ''}>${p.claimed ? html`<div class="hint">${T('pt.phone_app', 'The patient changes this in the MediCore app.')}</div>` : ''}</div><div class="field"><label for="pe-em">${T('reg.email', 'Email')}</label><input class="input" id="pe-em" name="email" type="email" value="${p.email || ''}"></div></div>
      <div class="field"><label for="pe-ad">${T('reg.address', 'Home address')}</label><input class="input" id="pe-ad" name="address" value="${p.address || ''}" maxlength="300"></div>
      <div class="fields two"><div class="field"><label for="pe-nn">${T('reg.nok_name_l', 'Next of kin name')}</label><input class="input" id="pe-nn" name="nokName" value="${p.nokName || ''}"></div><div class="field"><label for="pe-np">${T('reg.nok_phone_l', 'Next of kin phone')}</label><input class="input" id="pe-np" name="nokPhone" inputmode="tel" value="${p.nokPhone || ''}"></div></div>` : ''}
      <div class="fields three"><div class="field"><label for="pe-bg">${T('reg.blood', 'Blood group')}</label><select class="input" id="pe-bg" name="bloodGroup"><option value="">${T('reg.not_known', 'Not known')}</option>${BLOOD.map(b => html`<option ${p.bloodGroup === b ? 'selected' : ''}>${b}</option>`)}</select></div>
      <div class="field"><label for="pe-gt">${T('reg.genotype', 'Genotype')}</label><select class="input" id="pe-gt" name="genotype"><option value="">${T('reg.not_known', 'Not known')}</option>${GENO.map(b => html`<option ${p.genotype === b ? 'selected' : ''}>${b}</option>`)}</select></div>
      <div class="field"><label for="pe-w">${T('reg.weight', 'Weight (kg)')}</label><input class="input" id="pe-w" name="weightKg" type="number" min="0.3" max="400" step="0.1" value="${p.weightKg || ''}"></div></div>
      <h3>${T('pt.add_allergy', 'Add an allergy')}</h3>
      <div class="fields three"><div class="field"><label for="pe-as">${T('reg.substance', 'Allergic to')}</label><input class="input" id="pe-as" name="alSubstance" maxlength="80"></div><div class="field"><label for="pe-ar">${T('reg.reaction', 'Reaction')}</label><input class="input" id="pe-ar" name="alReaction" maxlength="120"></div><div class="field"><label for="pe-av">${T('reg.severity', 'Severity')}</label><select class="input" id="pe-av" name="alSeverity">${SEVS.map(s => html`<option value="${s}" ${s === 'unknown' ? 'selected' : ''}>${sevLabel(s)}</option>`)}</select></div></div>
      ${!p.allergies.length ? html`<label class="check"><input type="checkbox" name="nka"><span>${T('pt.set_nka', 'The patient confirmed they have no known allergies')}</span></label>` : ''}`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pt.save', 'Save changes'), primary: true }],
      onSubmit: async d => {
        const body = {};
        if (full) { ['firstName', 'lastName', 'dob', 'sex', 'email', 'address', 'nokName', 'nokPhone'].forEach(k => { if (d[k] !== undefined && d[k] !== (p[k] || undefined)) body[k] = d[k]; }); if (!p.claimed && d.phone && d.phone !== p.phone) body.phone = d.phone; }
        ['bloodGroup', 'genotype'].forEach(k => { if (d[k] && d[k] !== p[k]) body[k] = d[k]; });
        if (d.weightKg !== undefined && d.weightKg !== p.weightKg) body.weightKg = d.weightKg;
        if (d.alSubstance) body.addAllergies = [{ substance: d.alSubstance, reaction: d.alReaction, severity: d.alSeverity }];
        if (d.nka && !d.alSubstance) body.noKnownAllergies = true;
        if (d.alSubstance) body.noKnownAllergies = false;
        if (!Object.keys(body).length) throw err400(T('pt.nothing', 'Nothing has changed'));
        return api.patch('/api/fd/patients/' + p.id, body);
      } });
    if (ok) { toast(T('pt.saved', 'Patient details saved'), 'ok'); MC.render(); }
  });
  on('pt-refer', async () => { if (current && current.p) await MC.referrals.sendDialog({ patient: current.p }); });
  on('pt-checkin', async () => {
    const p = current.p; const docs = await doctors(); const sps = servicePoints();
    const todayAppts = current.appts.filter(a => a.status === 'booked' && a.date === MC.todayISO());
    const v = await dialog({ title: T('ci.title', 'Check in {name}', { name: p.name }), form: true, body: html`
      ${todayAppts.length ? html`<div class="field"><label for="ci-a">${T('ci.appt', 'Appointment')}</label><select class="input" id="ci-a" name="appointmentId"><option value="">${T('ci.walkin', 'Walk-in (no appointment)')}</option>${todayAppts.map(a => html`<option value="${a.id}" selected>${a.time}, ${a.doctorName}</option>`)}</select></div>` : ''}
      <div class="field" data-ci="sp"><label for="ci-sp">${T('ci.sp', 'Send to')}</label><select class="input" id="ci-sp" name="servicePoint">${sps.map(s => html`<option value="${s}">${spLabel(s)}</option>`)}</select></div>
      ${sps.includes('doctor') ? html`<div class="field" data-ci="doc"><label for="ci-d">${T('ci.doctor', 'Doctor')}</label><select class="input" id="ci-d" name="doctorMembershipId"><option value="">${T('ci.any_doctor', 'Next available doctor')}</option>${docs.map(x => html`<option value="${x.membershipId}">${x.name}${x.specialty ? ' (' + x.specialty + ')' : ''}</option>`)}</select></div>` : ''}
      <div class="field"><label for="ci-p">${T('today.priority', 'Priority')}</label><select class="input" id="ci-p" name="priority">${['routine', 'urgent', 'emergency'].map(x => html`<option value="${x}">${priLabel(x)}</option>`)}</select></div>
      <div class="field"><label for="ci-c">${T('ci.complaint', 'Main complaint (optional)')}</label><input class="input" id="ci-c" name="complaint" maxlength="300" placeholder="${T('ci.complaint_ph', 'e.g. Headache for 3 days')}"></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('ci.btn', 'Check in'), primary: true }],
      onOpen: d => {
        const sp = d.querySelector('#ci-sp'), ap = d.querySelector('#ci-a'), docF = d.querySelector('[data-ci="doc"]'), spF = d.querySelector('[data-ci="sp"]');
        const sync = () => { const withAppt = ap && ap.value; if (spF) spF.hidden = !!withAppt; if (docF) docF.hidden = !!withAppt || sp.value !== 'doctor'; };
        sp.addEventListener('change', sync); if (ap) ap.addEventListener('change', sync); sync();
      },
      onSubmit: d => {
        const body = { patientId: p.id, priority: d.priority, complaint: d.complaint };
        if (d.appointmentId) Object.assign(body, { appointmentId: d.appointmentId, servicePoint: 'doctor' });
        else { body.servicePoint = d.servicePoint; if (d.servicePoint === 'doctor' && d.doctorMembershipId) body.doctorMembershipId = d.doctorMembershipId; }
        return api.post('/api/fd/queue', body);
      } });
    if (v) { toast(T('ci.done', 'Checked in. Ticket {n}', { n: v.number }), 'ok'); MC.render(); }
  });

  /* ================= WhatsApp agreement (patient page) ================= */
  const waKnown = {}; // answers recorded in this session: { [patientId]: { optIn, whatsapp } }
  function waState(p) {
    const k = waKnown[p.id];
    if (k) return k;
    return { optIn: typeof p.whatsappOptIn === 'boolean' ? p.whatsappOptIn : null, whatsapp: p.whatsapp || null };
  }
  function waBoxBody(p) {
    const st = waState(p); const number = st.whatsapp || p.whatsapp || p.phone;
    const rec = can('patient.register') || can('whatsapp.inbox');
    return html`<dl class="kv"><dt>${T('wa.agreed', 'Agreed to messages')}</dt><dd>${st.optIn === true ? badge(T('wa.yes', 'Yes, agreed'), 'ok') : st.optIn === false ? badge(T('wa.no', 'Said no'), 'warn') : html`<span class="muted">${T('wa.unknown', 'Not recorded. Ask the patient.')}</span>`}</dd>
        <dt>${T('wa.number', 'WhatsApp number')}</dt><dd>${number || html`<span class="muted">${T('wa.no_number', 'No number on record')}</span>`}</dd></dl>
      <p class="muted sm">${T('wa.why', 'Patients who agree get appointment, payment and result-ready updates on WhatsApp instead of SMS, and staff can message them from the WhatsApp inbox.')}</p>
      <div class="btn-row">
        ${rec && st.optIn !== true ? html`<button class="btn" data-action="pt-wa" data-v="yes">${icon('check')}${T('wa.rec_yes', 'Record agreement')}</button>` : ''}
        ${rec && st.optIn === true ? html`<button class="btn" data-action="pt-wa" data-v="yes">${icon('edit')}${T('wa.change_number', 'Change WhatsApp number')}</button>` : ''}
        ${rec && st.optIn !== false ? html`<button class="btn ghost" data-action="pt-wa" data-v="no">${icon('x')}${T('wa.rec_no', 'Record that they said no')}</button>` : ''}
        ${st.optIn === true && can('whatsapp.inbox') ? html`<button class="btn primary" data-action="pt-wa-msg">${icon('message')}${T('wa.message', 'Message on WhatsApp')}</button>` : ''}
      </div>`;
  }
  on('pt-wa', async el => {
    const p = current && current.p; if (!p) return;
    const yes = el.dataset.v === 'yes';
    const st = waState(p); const number = st.whatsapp || p.whatsapp || p.phone || '';
    const v = await dialog({ title: yes ? T('wa.yes_t', 'Record that {name} agreed to WhatsApp messages', { name: p.name }) : T('wa.no_t', 'Record that {name} said no to WhatsApp messages', { name: p.name }), form: true,
      body: yes ? html`<p>${T('wa.yes_body', 'Only record this if you asked the patient and they said yes. {org} and MediCore will then send their updates on WhatsApp, and staff can message them from the WhatsApp inbox.', { org: MC.me.org.name })}</p>
          <div class="field"><label for="wa-n">${T('wa.other_number', 'WhatsApp number, if different from their phone (optional)')}</label><input class="input" id="wa-n" name="number" inputmode="tel" maxlength="20" autocomplete="off" placeholder="${number || '0803 123 4567'}"><div class="hint">${T('wa.number_hint', 'Leave empty to use {n}.', { n: number || T('wa.their_phone', 'their phone number') })}</div></div>
          <label class="check"><input type="checkbox" name="asked"><span>${T('wa.asked', 'I asked the patient and they agreed')}</span></label>`
        : html`<p>${T('wa.no_body', 'Only record this if you asked the patient and they said no. They will get SMS instead, and nobody at {org} can start a WhatsApp chat with them.', { org: MC.me.org.name })}</p>
          <label class="check"><input type="checkbox" name="asked"><span>${T('wa.asked_no', 'I asked the patient and they said no')}</span></label>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: yes ? T('wa.rec_yes', 'Record agreement') : T('wa.rec_no', 'Record that they said no'), primary: true, danger: !yes }],
      onSubmit: d => {
        if (!d.asked) throw err400(T('wa.need_asked', 'Ask the patient first, then tick the box'), [{ field: 'asked', error: T('wa.need_asked', 'Ask the patient first, then tick the box') }]);
        return api.post('/api/fd/patients/' + p.id + '/whatsapp', { optIn: yes, number: yes && d.number ? d.number.trim() : undefined });
      } });
    if (!v) return;
    waKnown[p.id] = { optIn: !!v.whatsappOptIn, whatsapp: v.whatsapp || null };
    toast(yes ? T('wa.yes_done', 'Agreement recorded') : T('wa.no_done', 'Recorded that they said no'), 'ok');
    const box = document.getElementById('pt-wa'); if (box) MC.view(waBoxBody(p), box);
  });
  on('pt-wa-msg', async () => {
    const p = current && current.p; if (!p) return;
    const st = waState(p);
    await MC.whatsapp.startDialog({ patient: Object.assign({}, p, { whatsapp: st.whatsapp || p.whatsapp }) });
  });

  /* ================= off-platform HMOs ================= */
  let hmosCache = null;
  async function extHmos() { if (hmosCache) return hmosCache; try { hmosCache = await api.get('/api/fd/hmos'); } catch (e) { if (e.status === 401) throw e; hmosCache = []; } return hmosCache; }
  const offPlatform = async () => (await extHmos()).filter(h => !h.onPlatform);
  const safeUrl = u => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null);
  const PA_ST = ['requested', 'approved', 'denied', 'cancelled'];
  const paLabel = s => T('pa.st.' + s, { requested: 'Waiting for HMO', approved: 'Approved', denied: 'Denied', cancelled: 'Cancelled' }[s] || cap(s));
  const paBadge = s => badge(paLabel(s), s === 'approved' ? 'ok' : s === 'requested' ? 'warn' : 'bad');
  const CLAIM_EN = { not_submitted: 'Not claimed yet', submitted: 'Claimed, awaiting payment', paid: 'Claim paid', rejected: 'Claim rejected' };
  const claimBadge = s => badge(T('claim.st.' + s, CLAIM_EN[s] || cap(s)), s === 'paid' ? 'ok' : s === 'rejected' ? 'bad' : s === 'submitted' ? 'info' : 'warn');
  const BATCH_EN = { submitted: 'Submitted', part_paid: 'Part paid', paid: 'Paid' };
  const batchBadge = s => badge(T('claim.bst.' + s, BATCH_EN[s] || cap(s)), s === 'paid' ? 'ok' : s === 'part_paid' ? 'info' : 'warn');
  const isoDate = s => (s ? date(Date.parse(s + 'T12:00:00Z')) : '');
  const expired = c => c.validTo && c.validTo < MC.todayISO();
  const naira = k => (k == null ? '' : String(Math.round(k) / 100));
  /** 409 = someone else already acted: say so and refresh */
  async function guard409(fn) { try { return await fn(); } catch (e) { if (e && e.status === 409) { toast(e.message, 'bad'); MC.render(); return null; } throw e; } }

  async function loadExtHmoBox(p, stale) {
    const box = () => document.getElementById('pt-xhmo');
    let hmos, covers, pas;
    try { [hmos, covers, pas] = await Promise.all([offPlatform(), api.get('/api/fd/patients/' + p.id + '/external-covers'), api.get('/api/fd/external-preauths' + qs({ patientId: p.id, limit: 20 }))]); }
    catch (e) { if (e.status === 401) throw e; if (box()) MC.view(html`<div class="notice bad">${T('xh.load_failed', 'Could not load off-platform HMO cover: {m}', { m: e.message })}</div>`, box()); return; }
    if ((stale && stale()) || !box()) return;
    current.covers = covers; current.hmos = hmos;
    if (!hmos.length && !covers.length) { MC.view(html`<p class="muted sm">${T('xh.no_panel', 'Your provider has no off-platform HMOs on its panel. An administrator adds them in the Admin app under HMOs.')}</p>`, box()); return; }
    const check = can('hmo.check');
    MC.view(html`<p class="muted sm">${T('xh.sub', 'HMOs that are not on MediCore. Ask for the HMO card, record the cover, then request pre-authorisation by email or WhatsApp.')}</p>
      ${covers.length ? html`<ul class="list">${covers.map(c => html`<li><div class="grow"><span class="title">${c.hmoName || T('xh.hmo', 'HMO')}${c.planName ? ' | ' + c.planName : ''}</span>
          <span class="sub">${T('xh.member', 'Member {n}', { n: c.memberNo })}${c.employer ? ' | ' + c.employer : ''}${c.validTo ? ' | ' + T('xh.valid', 'Valid to {d}', { d: isoDate(c.validTo) }) : ''}</span></div>
          <span class="end">${c.status === 'active' ? (expired(c) ? badge(T('xh.expired', 'Expired'), 'bad') : badge(T('xh.active', 'Active'), 'ok')) : badge(T('xh.ended', 'Ended'), 'outline')}
          ${check && c.status === 'active' ? html`<br><button class="btn sm ghost" data-action="xh-end" data-id="${c.id}">${T('xh.end', 'End cover')}</button>` : ''}</span></li>`)}</ul>`
        : html`<div class="notice">${T('xh.none', 'No off-platform HMO cover recorded for this patient.')}</div>`}
      ${check ? html`<div class="btn-row">${hmos.length ? html`<button class="btn" data-action="xh-add">${icon('plus')}${T('xh.add', 'Add HMO cover')}</button>
        <button class="btn primary" data-action="xh-preauth">${icon('file')}${T('xh.preauth', 'Request pre-authorisation')}</button>` : ''}</div>` : ''}
      ${pas.length ? html`<h3 style="margin-top:16px">${T('xh.preauths', 'Pre-authorisations')}</h3><ul class="list">${pas.slice(0, 5).map(a => html`<li><div class="grow"><span class="title">${a.number} | ${a.hmoName} | ${money(a.totalKobo)}</span>
          <span class="sub">${a.diagnosis} | ${dateTime(a.createdAt)}${a.authCode ? ' | ' + T('xh.code', 'Code {c}', { c: a.authCode }) : ''}${a.status === 'approved' && a.approvedKobo != null ? ' | ' + T('xh.approved_amt', 'Approved {amt}', { amt: money(a.approvedKobo) }) : ''}</span></div><span class="end">${paBadge(a.status)}</span></li>`)}</ul>
        <div class="btn-row"><a class="btn sm ghost" href="#/preauths">${T('xh.all_preauths', 'All pre-authorisations')}</a></div>` : ''}`, box());
  }
  on('xh-add', async () => {
    const p = current.p; const hmos = current.hmos || await offPlatform();
    const v = await dialog({ title: T('xh.add_t', 'Add HMO cover for {name}', { name: p.name }), form: true,
      body: html`<p class="muted sm">${T('xh.add_sub', 'Copy the details from the patient\'s HMO card.')}</p>
        <div class="field"><label for="xc-h">${T('xh.hmo', 'HMO')}</label><select class="input" id="xc-h" name="panelId" required>${hmos.map(h => html`<option value="${h.id}">${h.name}</option>`)}</select></div>
        <div class="fields two"><div class="field"><label for="xc-m">${T('xh.member_no', 'Member number')}</label><input class="input" id="xc-m" name="memberNo" maxlength="40" required autocomplete="off" placeholder="BWH/1029/01"><div class="hint">${T('xh.member_hint', 'Letters, numbers, slashes, dots and dashes.')}</div></div>
          <div class="field"><label for="xc-p">${T('xh.plan', 'Plan (optional)')}</label><input class="input" id="xc-p" name="planName" maxlength="80" autocomplete="off"></div></div>
        <div class="fields two"><div class="field"><label for="xc-e">${T('xh.employer', 'Employer (optional)')}</label><input class="input" id="xc-e" name="employer" maxlength="120" autocomplete="off"></div>
          <div class="field"><label for="xc-v">${T('xh.valid_to', 'Valid to (optional)')}</label><input class="input" id="xc-v" name="validTo" type="date" min="${MC.todayISO()}"></div></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('xh.add', 'Add HMO cover'), primary: true }],
      onSubmit: d => {
        const m = (d.memberNo || '').trim();
        if (!m) throw err400(T('xh.need_member', 'Enter the member number from the HMO card'), [{ field: 'memberNo', error: T('xh.need_member', 'Enter the member number from the HMO card') }]);
        if (!/^[A-Za-z0-9\-/. ]+$/.test(m)) throw err400(T('xh.bad_member', 'Use only letters, numbers, slashes, dots and dashes'), [{ field: 'memberNo', error: T('xh.bad_member', 'Use only letters, numbers, slashes, dots and dashes') }]);
        return api.post('/api/fd/patients/' + p.id + '/external-covers', { panelId: d.panelId, memberNo: m, planName: d.planName, employer: d.employer, validTo: d.validTo });
      } });
    if (v) { toast(T('xh.added', 'HMO cover added: {hmo} member {n}', { hmo: v.hmoName, n: v.memberNo }), 'ok'); MC.render(); }
  });
  on('xh-end', async el => {
    const c = (current.covers || []).find(x => x.id === el.dataset.id); if (!c) return;
    if (!(await confirm({ title: T('xh.end_q', 'End this HMO cover?'), body: T('xh.end_body', '{hmo} cover {n} for {name} will be marked ended. New pre-authorisations and bills will not use it.', { hmo: c.hmoName || '', n: c.memberNo, name: current.p.name }), ok: T('xh.end', 'End cover'), danger: true }))) return;
    await api.patch('/api/fd/external-covers/' + c.id, { status: 'ended' });
    toast(T('xh.ended_toast', 'HMO cover ended'), 'ok'); MC.render();
  });

  /* ---- pre-authorisation request ---- */
  on('xh-preauth', async () => {
    const p = current.p; const hmos = current.hmos || await offPlatform(); const covers = (current.covers || []).filter(c => c.status === 'active');
    let svcs = []; try { svcs = (await api.get('/api/services')).filter(s => s.active !== false); } catch (e) { if (e.status === 401) throw e; }
    const items = []; let dlg = null;
    const total = () => items.reduce((s, i) => s + i.unit * i.qty, 0);
    const paintItems = () => {
      const box = dlg && dlg.querySelector('#pa-items'); if (!box) return;
      MC.view(items.length ? html`<ul class="list">${items.map((it, i) => html`<li><div class="grow"><span class="title">${it.name}${it.code ? '' : html` ${badge(T('pa.custom_b', 'Custom'), 'outline')}`}</span><span class="sub">${money(it.unit)} x ${it.qty} = ${money(it.unit * it.qty)}</span></div>
          <span class="end"><button type="button" class="icon-btn" data-action="pa-rm" data-i="${i}" aria-label="${T('pa.remove', 'Remove {name}', { name: it.name })}">${icon('trash')}</button></span></li>`)}
        <li><div class="grow"><span class="title">${T('pa.total', 'Total requested')}</span></div><span class="end"><b>${money(total())}</b></span></li></ul>`
        : html`<p class="muted sm">${T('pa.no_items', 'No services added yet. Add at least one from the price list or as a custom item.')}</p>`, box);
    };
    const panelOf = id => hmos.find(h => h.id === id);
    const syncPanel = () => {
      if (!dlg) return;
      const pid = dlg.querySelector('#pa-h').value; const h = panelOf(pid) || {};
      const opts = covers.filter(c => c.panelId === pid);
      MC.view(html`${opts.map(c => html`<option value="${c.id}">${c.memberNo}${c.planName ? ' (' + c.planName + ')' : ''}</option>`)}<option value="">${T('pa.no_cover', 'No cover recorded')}</option>`, dlg.querySelector('#pa-c'));
      const to = h.preauthEmail || h.email;
      MC.view(to ? T('pa.email_to', 'Sends to {email}. Needs MediCore\'s email service to be connected.', { email: to }) : T('pa.email_none', '{hmo} has no email address on your panel, so it cannot be emailed. Use WhatsApp or copy the text.', { hmo: h.name || '' }), dlg.querySelector('#pa-email-hint'));
    };
    on('pa-add-svc', () => {
      const sel = dlg.querySelector('#pa-svc'); const q = Math.max(1, Math.min(100, Math.round(Number(dlg.querySelector('#pa-sq').value) || 1)));
      const s = svcs.find(x => x.code === sel.value); if (!s) return;
      const ex = items.find(i => i.code === s.code); if (ex) ex.qty = Math.min(100, ex.qty + q); else items.push({ code: s.code, name: s.name, unit: s.priceKobo, qty: q });
      dlg.querySelector('#pa-sq').value = '1'; paintItems();
    });
    on('pa-add-custom', () => {
      const n = dlg.querySelector('#pa-cn'), a = dlg.querySelector('#pa-ca'), q = dlg.querySelector('#pa-cq');
      const unit = Math.round(Number(a.value) * 100); const qty = Math.max(1, Math.min(100, Math.round(Number(q.value) || 1)));
      if (!n.value.trim() || !(unit >= 1)) { toast(T('pa.custom_need', 'Give the item a description and an amount'), 'bad'); return; }
      items.push({ code: null, name: n.value.trim().slice(0, 120), unit, qty }); n.value = ''; a.value = ''; q.value = '1'; paintItems();
    });
    on('pa-rm', el => { items.splice(Number(el.dataset.i), 1); paintItems(); });
    const r = await dialog({ title: T('pa.title', 'Request pre-authorisation for {name}', { name: p.name }), form: true, wide: true,
      body: html`<div class="fields two"><div class="field"><label for="pa-h">${T('xh.hmo', 'HMO')}</label><select class="input" id="pa-h" name="panelId" required>${hmos.map(h => html`<option value="${h.id}" ${covers.some(c => c.panelId === h.id) && covers[0].panelId === h.id ? 'selected' : ''}>${h.name}</option>`)}</select></div>
          <div class="field"><label for="pa-c">${T('pa.cover', 'Cover')}</label><select class="input" id="pa-c" name="coverId"></select></div></div>
        <div class="field"><label for="pa-dx">${T('pa.dx', 'Diagnosis or reason')}</label><input class="input" id="pa-dx" name="diagnosis" minlength="3" maxlength="300" required autocomplete="off" placeholder="${T('pa.dx_ph', 'e.g. Malaria, needs admission and IV artesunate')}"></div>
        <h3>${T('pa.services', 'Services requested')}</h3>
        ${svcs.length ? html`<div class="fields three"><div class="field" style="grid-column:span 2"><label for="pa-svc">${T('pa.from_list', 'From the price list')}</label><select class="input" id="pa-svc">${svcs.map(s => html`<option value="${s.code}">${s.name} (${money(s.priceKobo)})</option>`)}</select></div>
          <div class="field"><label for="pa-sq">${T('pa.qty', 'Quantity')}</label><input class="input" id="pa-sq" type="number" min="1" max="100" value="1" inputmode="numeric"></div></div>
          <button type="button" class="btn sm" data-action="pa-add-svc">${icon('plus')}${T('pa.add_svc', 'Add service')}</button>` : html`<p class="muted sm">${T('pa.no_list', 'Your price list is empty. Add custom items below.')}</p>`}
        <div class="fields three" style="margin-top:12px"><div class="field"><label for="pa-cn">${T('pa.custom_name', 'Custom item')}</label><input class="input" id="pa-cn" maxlength="120" autocomplete="off" placeholder="${T('pa.custom_ph', 'e.g. Ward bed, per night')}"></div>
          <div class="field"><label for="pa-ca">${T('pa.custom_amt', 'Amount (NGN)')}</label><input class="input" id="pa-ca" type="number" min="1" step="any" inputmode="decimal"></div>
          <div class="field"><label for="pa-cq">${T('pa.qty', 'Quantity')}</label><input class="input" id="pa-cq" type="number" min="1" max="100" value="1" inputmode="numeric"></div></div>
        <button type="button" class="btn sm" data-action="pa-add-custom">${icon('plus')}${T('pa.add_custom', 'Add custom item')}</button>
        <div id="pa-items" style="margin-top:12px"></div>
        <div class="field" style="margin-top:12px"><label for="pa-n">${T('pa.note', 'Note for the HMO (optional)')}</label><textarea class="input" id="pa-n" name="note" maxlength="1000"></textarea></div>
        <label class="check"><input type="checkbox" name="sendEmail" checked><span>${T('pa.send_email', 'Send by email to the HMO')}<br><span class="sm muted" id="pa-email-hint"></span></span></label>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pa.send', 'Send pre-authorisation request'), primary: true }],
      onOpen: d => {
        dlg = d; syncPanel(); paintItems();
        d.querySelector('#pa-h').addEventListener('change', syncPanel);
        d.querySelectorAll('#pa-sq,#pa-cn,#pa-ca,#pa-cq').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); d.querySelector(i.id === 'pa-sq' ? '[data-action="pa-add-svc"]' : '[data-action="pa-add-custom"]').click(); } }));
      },
      onSubmit: d => {
        const details = [];
        if (!d.diagnosis || d.diagnosis.trim().length < 3) details.push({ field: 'diagnosis', error: T('pa.need_dx', 'Enter the diagnosis or reason (at least 3 characters)') });
        if (!items.length) details.push({ field: 'items', error: T('pa.need_items', 'Add at least one service') });
        if (details.length) throw err400(details[0].error, details);
        return api.post('/api/fd/external-preauths', { patientId: p.id, panelId: d.panelId, coverId: d.coverId || undefined, diagnosis: d.diagnosis.trim(), note: d.note ? d.note.trim() : undefined, sendEmail: !!d.sendEmail,
          items: items.map(i => (i.code ? { serviceCode: i.code, qty: i.qty } : { name: i.name, amountKobo: i.unit, qty: i.qty })) }).then(x => Object.assign(x, { wantedEmail: !!d.sendEmail }));
      } });
    dlg = null;
    if (!r) return;
    toast(T('pa.sent', 'Pre-authorisation {n} created', { n: r.number }), 'ok');
    const go = await sentDialog({ title: T('pa.sent_t', 'Pre-authorisation {n} created', { n: r.number }), panel: panelOf(r.panelId), emailSent: r.emailSent, wantedEmail: r.wantedEmail, kind: 'preauth',
      message: r.message, whatsappLink: r.whatsappLink, portalUrl: r.portalUrl, next: T('pa.next', 'When the HMO answers, open Pre-authorisations and record their decision and authorisation code.'), goLabel: T('pa.go', 'Go to pre-authorisations'), goHref: '#/preauths' });
    if (go) MC.go(go); else MC.render();
  });
  /** after sending to an off-platform HMO: what happened to the email, the text, WhatsApp and portal links */
  async function sentDialog({ title, panel, emailSent, wantedEmail, kind, message, whatsappLink, portalUrl, next, goLabel, goHref, emailReady, showEmail = true }) {
    const h = panel || {}; const to = kind === 'claim' ? (h.claimsEmail || h.email) : (h.preauthEmail || h.email);
    const emailNote = emailSent ? html`<div class="notice ok">${T('sent.email_ok', 'Emailed to {email}.', { email: to || h.name || '' })}</div>`
      : !wantedEmail ? html`<div class="notice">${T('sent.email_off', 'Not emailed: you chose not to send it by email.')}</div>`
        : !to ? html`<div class="notice warn">${T('sent.email_no_addr', 'Not emailed: {hmo} has no email address on your panel. Ask your administrator to add it in the Admin app under HMOs.', { hmo: h.name || T('xh.hmo', 'HMO') })}</div>`
          : emailReady === false ? html`<div class="notice warn">${T('sent.email_no_gw', 'Not emailed: MediCore\'s email service is not connected yet. Send it by WhatsApp, or copy the text into your own email to {email}.', { email: to })}</div>`
            : html`<div class="notice warn">${T('sent.email_failed', 'Not emailed: MediCore\'s email service is not connected yet, or the email could not be sent. Send it by WhatsApp, or copy the text into your own email to {email}.', { email: to })}</div>`;
    const wa = safeUrl(whatsappLink); const portal = safeUrl(portalUrl);
    return dialog({ title, wide: true,
      body: html`${showEmail ? emailNote : (emailSent ? html`<div class="notice ok">${T('sent.was_emailed', 'This request was emailed to the HMO.')}</div>` : '')}
        ${message ? html`<div class="field"><label for="sent-msg">${kind === 'claim' ? T('sent.msg_claim', 'Message for the HMO') : T('sent.msg', 'Full request text')}</label><textarea class="input" id="sent-msg" rows="${kind === 'claim' ? 3 : 10}" readonly style="font-family:inherit;min-height:${kind === 'claim' ? 96 : 200}px">${message}</textarea></div>` : ''}
        <div class="btn-row">${message ? html`<button type="button" class="btn" data-action="sent-copy">${icon('clipboard')}${T('sent.copy', 'Copy text')}</button>` : ''}
          ${wa ? html`<a class="btn" href="${wa}" target="_blank" rel="noopener">${icon('message')}${T('sent.wa', 'Open WhatsApp with this message')}</a>` : html`<span class="muted sm">${T('sent.no_wa', '{hmo} has no WhatsApp number on your panel.', { hmo: h.name || T('xh.hmo', 'HMO') })}</span>`}
          ${portal ? html`<a class="btn" href="${portal}" target="_blank" rel="noopener">${icon('globe')}${T('sent.portal', 'Open the HMO portal')}</a>` : ''}</div>
        ${next ? html`<p class="muted sm" style="margin-top:12px">${next}</p>` : ''}`,
      actions: [{ label: MC.t('kit.close', 'Close'), value: null }].concat(goHref ? [{ label: goLabel, value: goHref, primary: true }] : []) });
  }
  on('sent-copy', async () => {
    const ta = document.getElementById('sent-msg'); if (!ta) return;
    try { await navigator.clipboard.writeText(ta.value); } catch (e) { ta.focus(); ta.select(); try { document.execCommand('copy'); } catch (e2) { toast(T('sent.copy_failed', 'Could not copy. Select the text and copy it yourself.'), 'bad'); return; } }
    toast(T('sent.copied', 'Text copied'), 'ok');
  });

  /* ---- pre-authorisations page ---- */
  let lastPas = [];
  async function preauthsPage({ query }) {
    if (!canAny('hmo.check', 'hmo.claim')) return view(empty({ icon: 'lock', title: T('common.no_access', 'Your role cannot do this') }));
    const status = PA_ST.includes(query.status) ? query.status : query.status === 'all' ? '' : 'requested';
    const [rows, hmos] = await Promise.all([api.get('/api/fd/external-preauths' + qs({ status, limit: 300 })), offPlatform()]);
    lastPas = rows;
    const check = can('hmo.check');
    view(html`<div class="page-head"><div><h1>${T('pas.title', 'Pre-authorisations')}</h1><p>${T('pas.sub', 'Requests to HMOs that are not on MediCore. Record the HMO\'s answer and authorisation code here. Request a new one from the patient\'s page.')}</p></div></div>
      ${!hmos.length ? html`<div class="notice">${T('xh.no_panel', 'Your provider has no off-platform HMOs on its panel. An administrator adds them in the Admin app under HMOs.')}</div>` : ''}
      <div class="tabs" role="tablist">${PA_ST.concat(['all']).map(s => html`<a role="tab" href="#/preauths${s === 'requested' ? '' : '?status=' + s}" aria-selected="${(s === 'all' ? '' : s) === status ? 'true' : 'false'}">${s === 'all' ? T('today.all', 'All') : paLabel(s)}</a>`)}</div>
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('pas.request', 'Request')}</th><th>${T('appt.patient', 'Patient')}</th><th>${T('xh.hmo', 'HMO')}</th><th>${T('pa.dx', 'Diagnosis or reason')}</th><th class="num">${T('pas.amount', 'Amount')}</th><th>${T('appt.status', 'Status')}</th><th></th></tr></thead><tbody>
        ${rows.map(a => html`<tr><td data-label="${T('pas.request', 'Request')}"><b>${a.number}</b><br><span class="xs muted">${dateTime(a.createdAt)}${a.byName ? ' | ' + a.byName : ''}</span></td>
          <td data-label="${T('appt.patient', 'Patient')}"><a href="#/patient/${a.patientId}">${a.patientName}</a>${a.memberNo ? html`<br><span class="xs muted">${a.memberNo}</span>` : ''}</td>
          <td data-label="${T('xh.hmo', 'HMO')}">${a.hmoName}</td><td data-label="${T('pa.dx', 'Diagnosis or reason')}">${a.diagnosis}<br><span class="xs muted">${(a.items || []).map(i => i.name + (i.qty > 1 ? ' x' + i.qty : '')).join(', ')}</span></td>
          <td class="num" data-label="${T('pas.amount', 'Amount')}">${money(a.totalKobo)}${a.status === 'approved' && a.approvedKobo != null && a.approvedKobo !== a.totalKobo ? html`<br><span class="xs muted">${T('xh.approved_amt', 'Approved {amt}', { amt: money(a.approvedKobo) })}</span>` : ''}</td>
          <td data-label="${T('appt.status', 'Status')}">${paBadge(a.status)}${a.authCode ? html`<br><span class="xs">${T('xh.code', 'Code {c}', { c: a.authCode })}</span>` : ''}${a.reason ? html`<br><span class="xs muted">${a.reason}</span>` : ''}</td>
          <td data-label=""><span class="row wrap">${check && a.status === 'requested' ? html`<button class="btn sm primary" data-action="pas-approve" data-id="${a.id}">${T('pas.approve', 'Approve')}</button><button class="btn sm" data-action="pas-deny" data-id="${a.id}">${T('pas.deny', 'Deny')}</button><button class="btn sm ghost" data-action="pas-cancel" data-id="${a.id}">${T('pas.cancel', 'Cancel')}</button>` : ''}
            <button class="btn sm ghost" data-action="pas-show" data-id="${a.id}">${T('pas.show', 'Show request')}</button></span></td></tr>`)}
      </tbody></table></div>` : empty({ icon: 'shield', title: status === 'requested' ? T('pas.empty_wait', 'No requests waiting for an HMO') : T('pas.empty', 'No pre-authorisations here'), body: T('pas.empty_sub', 'Open a patient with off-platform HMO cover and choose Request pre-authorisation.') })}`);
  }
  const findPa = id => lastPas.find(x => x.id === id);
  on('pas-show', async el => {
    const a = findPa(el.dataset.id); if (!a) return;
    const h = (await extHmos()).find(x => x.id === a.panelId) || {};
    const wa = h.whatsapp ? MC.whatsapp.chatLink(h.whatsapp, a.message) : null;
    await sentDialog({ title: T('pas.show_t', 'Pre-authorisation {n}', { n: a.number }), panel: h, emailSent: (a.sentVia || []).includes('email'), wantedEmail: true, kind: 'preauth', message: a.message, whatsappLink: wa, portalUrl: h.portalUrl, showEmail: false });
  });
  on('pas-approve', async el => {
    const a = findPa(el.dataset.id); if (!a) return;
    const v = await dialog({ title: T('pas.approve_t', 'Record approval of {n}', { n: a.number }), form: true,
      body: html`<p>${T('pas.approve_body', '{hmo} approved the request for {name}. Enter the authorisation code exactly as the HMO gave it.', { hmo: a.hmoName, name: a.patientName })}</p>
        <div class="field"><label for="pap-c">${T('pas.code', 'Authorisation code')}</label><input class="input" id="pap-c" name="authCode" maxlength="60" required autocomplete="off"></div>
        <div class="field"><label for="pap-a">${T('pas.approved_amt', 'Approved amount (NGN)')}</label><input class="input" id="pap-a" name="approvedKobo" type="number" min="0" step="any" inputmode="decimal" data-kobo value="${naira(a.totalKobo)}"><div class="hint">${T('pas.amt_hint', 'Requested {amt}. Change it if the HMO approved less.', { amt: money(a.totalKobo) })}</div></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pas.approve_ok', 'Record approval'), primary: true }],
      onSubmit: d => {
        if (!d.authCode || !d.authCode.trim()) throw err400(T('pas.need_code', 'Enter the authorisation code the HMO gave you'), [{ field: 'authCode', error: T('pas.need_code', 'Enter the authorisation code the HMO gave you') }]);
        if (d.approvedKobo != null && (Number.isNaN(d.approvedKobo) || d.approvedKobo < 0)) throw err400(T('pas.bad_amt', 'Enter the approved amount'), [{ field: 'approvedKobo', error: T('pas.bad_amt', 'Enter the approved amount') }]);
        return guard409(() => api.post('/api/fd/external-preauths/' + a.id + '/decide', { status: 'approved', authCode: d.authCode.trim(), approvedKobo: d.approvedKobo != null ? d.approvedKobo : undefined }));
      } });
    if (v) { toast(T('pas.approved', 'Pre-authorisation {n} approved, code {c}', { n: a.number, c: v.authCode }), 'ok'); MC.render(); }
  });
  on('pas-deny', async el => {
    const a = findPa(el.dataset.id); if (!a) return;
    const v = await dialog({ title: T('pas.deny_t', 'Record that {hmo} denied {n}', { hmo: a.hmoName, n: a.number }), form: true,
      body: html`<p>${T('pas.deny_body', 'Tell {name} the HMO will not pay, so they can decide to pay themselves.', { name: a.patientName })}</p>
        <div class="field"><label for="pad-r">${T('pas.reason', 'Reason the HMO gave')}</label><textarea class="input" id="pad-r" name="reason" maxlength="300" required></textarea></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pas.deny_ok', 'Record denial'), primary: true, danger: true }],
      onSubmit: d => {
        if (!d.reason || !d.reason.trim()) throw err400(T('pas.need_reason', 'Enter the reason the HMO gave'), [{ field: 'reason', error: T('pas.need_reason', 'Enter the reason the HMO gave') }]);
        return guard409(() => api.post('/api/fd/external-preauths/' + a.id + '/decide', { status: 'denied', reason: d.reason.trim() }));
      } });
    if (v) { toast(T('pas.denied', 'Pre-authorisation {n} marked denied', { n: a.number }), 'ok'); MC.render(); }
  });
  on('pas-cancel', async el => {
    const a = findPa(el.dataset.id); if (!a) return;
    if (!(await confirm({ title: T('pas.cancel_q', 'Cancel pre-authorisation {n}?', { n: a.number }), body: T('pas.cancel_body', 'The request for {name} is marked cancelled and cannot be approved later. Tell {hmo} if you already sent it.', { name: a.patientName, hmo: a.hmoName }), ok: T('pas.cancel_ok', 'Cancel request'), cancel: T('pas.keep', 'Keep request'), danger: true }))) return;
    const r = await guard409(() => api.post('/api/fd/external-preauths/' + a.id + '/decide', { status: 'cancelled' }));
    if (r) { toast(T('pas.cancelled', 'Pre-authorisation {n} cancelled', { n: a.number }), 'ok'); MC.render(); }
  });

  /* ---- bill: the HMO's share ---- */
  on('bill-ext', async () => {
    const b = curBill; if (!b) return;
    const hmos = await offPlatform();
    let pas = []; try { pas = await api.get('/api/fd/external-preauths' + qs({ patientId: b.patientId, status: 'approved', limit: 50 })); } catch (e) { if (e.status === 401) throw e; }
    let dlg = null;
    const fill = () => {
      const pid = dlg.querySelector('#xb-h').value;
      const list = pas.filter(a => a.panelId === pid);
      MC.view(html`<option value="">${T('xb.no_pa', 'No pre-authorisation')}</option>${list.map(a => html`<option value="${a.id}">${a.number} | ${T('xh.code', 'Code {c}', { c: a.authCode || '-' })} | ${money(a.approvedKobo != null ? a.approvedKobo : a.totalKobo)}</option>`)}`, dlg.querySelector('#xb-pa'));
      dlg.querySelector('#xb-pa-hint').textContent = list.length ? T('xb.pa_hint', 'Choosing one fills in its approved amount and code.') : T('xb.pa_none', 'No approved pre-authorisation for this patient with this HMO.');
    };
    const pick = () => {
      const a = pas.find(x => x.id === dlg.querySelector('#xb-pa').value); if (!a) return;
      const amt = Math.min(a.approvedKobo != null ? a.approvedKobo : a.totalKobo, b.totalKobo);
      dlg.querySelector('#xb-a').value = naira(amt); dlg.querySelector('#xb-c').value = a.authCode || '';
    };
    const v = await dialog({ title: T('xb.title', 'Off-platform HMO pays part of bill {n}', { n: b.number }), form: true,
      body: html`<p class="muted sm">${T('xb.sub', 'Bill total {amt}. The HMO\'s share comes off what {name} pays. This can be done once, before any payment.', { amt: money(b.totalKobo), name: b.patientName })}</p>
        <div class="field"><label for="xb-h">${T('xh.hmo', 'HMO')}</label><select class="input" id="xb-h" name="panelId" required>${hmos.map(h => html`<option value="${h.id}">${h.name}</option>`)}</select></div>
        <div class="field"><label for="xb-pa">${T('xb.pa', 'Approved pre-authorisation (optional)')}</label><select class="input" id="xb-pa" name="preauthId"></select><div class="hint" id="xb-pa-hint"></div></div>
        <div class="fields two"><div class="field"><label for="xb-a">${T('xb.amount', 'Amount the HMO covers (NGN)')}</label><input class="input" id="xb-a" name="coveredKobo" type="number" min="0" max="${naira(b.totalKobo)}" step="any" inputmode="decimal" data-kobo required></div>
          <div class="field"><label for="xb-c">${T('pas.code', 'Authorisation code')}</label><input class="input" id="xb-c" name="authCode" maxlength="60" autocomplete="off"></div></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('xb.ok', 'Add HMO share'), primary: true }],
      onOpen: d => { dlg = d; fill(); d.querySelector('#xb-h').addEventListener('change', fill); d.querySelector('#xb-pa').addEventListener('change', pick); },
      onSubmit: async d => {
        if (d.coveredKobo == null || Number.isNaN(d.coveredKobo) || d.coveredKobo <= 0) throw err400(T('xb.need_amt', 'Enter the amount the HMO covers'), [{ field: 'coveredKobo', error: T('xb.need_amt', 'Enter the amount the HMO covers') }]);
        if (d.coveredKobo > b.totalKobo) throw err400(T('xb.too_much', 'The HMO\'s share cannot be more than the bill ({amt})', { amt: money(b.totalKobo) }), [{ field: 'coveredKobo', error: T('xb.too_much', 'The HMO\'s share cannot be more than the bill ({amt})', { amt: money(b.totalKobo) }) }]);
        const h = hmos.find(x => x.id === d.panelId) || {};
        if (!(await confirm({ title: T('xb.confirm_t', 'Add the HMO share?'), body: T('xb.confirm_body', '{hmo} pays {amt} of bill {n}. {name} then pays {rest}. This cannot be changed afterwards.', { hmo: h.name || '', amt: money(d.coveredKobo), n: b.number, name: b.patientName, rest: money(b.totalKobo - d.coveredKobo) }), ok: T('xb.ok', 'Add HMO share') }))) return false;
        return guard409(() => api.post('/api/bills/' + b.id + '/external-hmo', { panelId: d.panelId, preauthId: d.preauthId || undefined, coveredKobo: d.coveredKobo, authCode: d.authCode ? d.authCode.trim() : undefined }));
      } });
    if (v) { toast(T('xb.done', 'HMO share of {amt} added. The patient pays {rest}', { amt: money(v.hmoExternal.coveredKobo), rest: money(v.patientDueKobo) }), 'ok'); MC.render(); }
  });

  /* ---- claims to off-platform HMOs ---- */
  async function downloadCsv(path, fallbackName) {
    let r;
    try { r = await fetch(path, { credentials: 'same-origin', headers: { 'X-MC-App': MC.APP, 'X-MC-Lang': MC.lang } }); }
    catch (e) { throw new MC.ApiError(0, { error: MC.t('kit.err.network', 'Could not reach MediCore. Check your connection and try again.') }); }
    if (!r.ok) { let body = null; try { body = await r.json(); } catch (e) { body = null; } throw new MC.ApiError(r.status, body || { error: T('claims.csv_failed', 'The CSV could not be downloaded') }); }
    const blob = await r.blob();
    const m = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '');
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = m ? m[1] : fallbackName; a.hidden = true;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  let claimCtx = null;
  async function claimsPage({ query, stale }) {
    if (!can('hmo.claim')) return view(empty({ icon: 'lock', title: T('common.no_access', 'Your role cannot do this'), body: T('claims.no_access', 'Ask the front desk manager or a cashier to send HMO claims.') }));
    const hmos = await offPlatform();
    const panelId = hmos.some(h => h.id === query.panelId) ? query.panelId : (hmos[0] ? hmos[0].id : '');
    const dOk = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
    const from = dOk(query.from) ? query.from : ''; const to = dOk(query.to) ? query.to : '';
    const [data, batches] = await Promise.all([panelId ? api.get('/api/fd/external-claims' + qs({ panelId, from, to })) : null, api.get('/api/fd/external-claims/batches' + qs({ panelId }))]);
    if (stale()) return;
    claimCtx = { panelId, from, to, data, batches, hmo: data ? data.hmo : hmos.find(h => h.id === panelId) };
    const bills = data ? data.bills : [];
    view(html`<div class="page-head"><div><h1>${T('claims.title', 'HMO claims')}</h1><p>${T('claims.sub', 'Claim the HMO\'s share of bills from HMOs that are not on MediCore. Each bill can be claimed once.')}</p></div></div>
      ${!hmos.length ? empty({ icon: 'file', title: T('claims.no_hmos', 'No off-platform HMOs on your panel'), body: T('xh.no_panel', 'Your provider has no off-platform HMOs on its panel. An administrator adds them in the Admin app under HMOs.') }) : html`
      <form class="panel" data-form="claims-filter" novalidate><div class="fields three">
        <div class="field"><label for="cf-h">${T('xh.hmo', 'HMO')}</label><select class="input" id="cf-h" name="panelId">${hmos.map(h => html`<option value="${h.id}" ${h.id === panelId ? 'selected' : ''}>${h.name}</option>`)}</select></div>
        <div class="field"><label for="cf-f">${T('claims.from', 'Bills from')}</label><input class="input" id="cf-f" name="from" type="date" value="${from}" max="${MC.todayISO()}"></div>
        <div class="field"><label for="cf-t">${T('claims.to', 'Bills to')}</label><input class="input" id="cf-t" name="to" type="date" value="${to}" max="${MC.todayISO()}"></div></div>
        <button class="btn" type="submit">${icon('search')}${T('claims.show', 'Show unclaimed bills')}</button></form>
      <section class="panel flush"><h2>${T('claims.unclaimed', 'Unclaimed bills for {hmo}', { hmo: claimCtx.hmo ? claimCtx.hmo.name : '' })}</h2>
        <div style="padding:0 16px">${figures([{ value: bills.length, label: T('claims.n_bills', 'Bills not claimed') }, { value: money(data ? data.totalCoveredKobo : 0), label: T('claims.total', 'HMO share to claim') }, { value: html`<span id="cl-sel">${money(0)}</span>`, label: T('claims.selected', 'Selected') }])}</div>
        ${bills.length ? html`<div class="table-wrap" style="border:0"><table class="t stack-sm"><thead><tr><th><label class="check" style="padding:0;min-height:0"><input type="checkbox" id="cl-all" aria-label="${T('claims.all', 'Select all bills')}"><span class="sr-only">${T('claims.all', 'Select all bills')}</span></label></th><th>${T('bill.number', 'Bill')}</th><th>${T('appt.patient', 'Patient')}</th><th>${T('claims.member_code', 'Member and code')}</th><th class="num">${T('bill.total', 'Total')}</th><th class="num">${T('xb.share', 'HMO share')}</th></tr></thead><tbody>
          ${bills.map(b => html`<tr><td data-label="${T('claims.pick', 'Claim')}"><input type="checkbox" data-claim-bill value="${b.id}" data-kobo-share="${b.coveredKobo}" aria-label="${T('claims.pick_l', 'Claim bill {n}', { n: b.number })}" style="width:22px;height:22px;accent-color:var(--hue)"></td>
            <td data-label="${T('bill.number', 'Bill')}"><a href="#/bill/${b.id}"><b>${b.number}</b></a><br><span class="xs muted">${dateTime(b.createdAt)}</span></td><td data-label="${T('appt.patient', 'Patient')}">${b.patientName}</td>
            <td data-label="${T('claims.member_code', 'Member and code')}">${b.memberNo || '-'}<br><span class="xs muted">${b.authCode ? T('xh.code', 'Code {c}', { c: b.authCode }) : T('xb.no_code', 'No authorisation code')}</span></td>
            <td class="num" data-label="${T('bill.total', 'Total')}">${money(b.totalKobo)}</td><td class="num" data-label="${T('xb.share', 'HMO share')}"><b>${money(b.coveredKobo)}</b></td></tr>`)}
        </tbody></table></div>
        <div class="btn-row" style="padding:0 16px 16px"><button class="btn primary" data-action="cl-send">${icon('file')}${T('claims.send', 'Send claim batch')}</button><button class="btn" data-action="cl-csv">${icon('download')}${T('claims.csv', 'Download CSV')}</button></div>`
          : empty({ icon: 'file', title: T('claims.none', 'No unclaimed bills'), body: T('claims.none_sub', 'Bills where an off-platform HMO pays part appear here until you claim them. Change the dates to look further back.') })}</section>`}
      <section class="panel flush"><h2>${T('claims.batches', 'Claim batches')}</h2>
        ${batches.length ? html`<div class="table-wrap" style="border:0"><table class="t stack-sm"><thead><tr><th>${T('claims.batch', 'Batch')}</th><th>${T('xh.hmo', 'HMO')}</th><th class="num">${T('claims.bills', 'Bills')}</th><th class="num">${T('claims.claimed', 'Claimed')}</th><th class="num">${T('claims.paid', 'Paid')}</th><th>${T('appt.status', 'Status')}</th><th></th></tr></thead><tbody>
          ${batches.map(x => html`<tr><td data-label="${T('claims.batch', 'Batch')}"><b>${x.number}</b><br><span class="xs muted">${dateTime(x.createdAt)}${x.byName ? ' | ' + x.byName : ''}</span></td><td data-label="${T('xh.hmo', 'HMO')}">${x.hmoName}</td>
            <td class="num" data-label="${T('claims.bills', 'Bills')}">${x.count}</td><td class="num" data-label="${T('claims.claimed', 'Claimed')}">${money(x.totalCoveredKobo)}</td><td class="num" data-label="${T('claims.paid', 'Paid')}">${money(x.paidKobo || 0)}${x.lastPaymentRef ? html`<br><span class="xs muted">${T('claims.ref', 'Ref {r}', { r: x.lastPaymentRef })}</span>` : ''}</td>
            <td data-label="${T('appt.status', 'Status')}">${batchBadge(x.status)}</td>
            <td data-label=""><span class="row wrap">${x.status !== 'paid' ? html`<button class="btn sm primary" data-action="cl-pay" data-id="${x.id}">${T('claims.record', 'Record payment')}</button>` : ''}<button class="btn sm ghost" data-action="cl-csv-batch" data-id="${x.id}" data-panel="${x.panelId}">${icon('download')}${T('claims.csv_short', 'CSV')}</button></span></td></tr>`)}
        </tbody></table></div>` : empty({ icon: 'file', title: T('claims.no_batches', 'No claim batches yet'), body: T('claims.no_batches_sub', 'Select unclaimed bills above and send them as a batch.') })}</section>`);
  }
  form('claims-filter', d => {
    if (d.from && d.to && d.from > d.to) throw err400(T('claims.bad_range', 'The start date must be before the end date'), [{ field: 'to', error: T('claims.bad_range', 'The start date must be before the end date') }]);
    MC.go('#/claims' + qs({ panelId: d.panelId, from: d.from, to: d.to }));
  });
  const pickedBills = () => Array.from(document.querySelectorAll('input[data-claim-bill]:checked'));
  function syncPicked() {
    const all = document.querySelectorAll('input[data-claim-bill]'); const on1 = pickedBills();
    const sel = document.getElementById('cl-sel'); if (sel) sel.textContent = money(on1.reduce((s, x) => s + Number(x.dataset.koboShare || 0), 0)) + ' (' + (on1.length === 1 ? T('claims.n_sel_one', '1 bill') : T('claims.n_sel', '{n} bills', { n: on1.length })) + ')';
    const ca = document.getElementById('cl-all'); if (ca) { ca.checked = all.length > 0 && on1.length === all.length; ca.indeterminate = on1.length > 0 && on1.length < all.length; }
  }
  document.addEventListener('change', e => {
    if (!e.target) return;
    if (e.target.id === 'cl-all') { document.querySelectorAll('input[data-claim-bill]').forEach(x => { x.checked = e.target.checked; }); syncPicked(); }
    else if (e.target.matches && e.target.matches('input[data-claim-bill]')) syncPicked();
  });
  on('cl-csv', async () => {
    const c = claimCtx; if (!c) return;
    await downloadCsv('/api/fd/external-claims/export' + qs({ panelId: c.panelId, from: c.from, to: c.to }), 'claims.csv');
    toast(T('claims.csv_done', 'CSV downloaded'), 'ok');
  });
  on('cl-csv-batch', async el => {
    await downloadCsv('/api/fd/external-claims/export' + qs({ panelId: el.dataset.panel, batchId: el.dataset.id }), 'claims-batch.csv');
    toast(T('claims.csv_done', 'CSV downloaded'), 'ok');
  });
  on('cl-send', async () => {
    const c = claimCtx; if (!c || !c.data) return;
    const picked = pickedBills();
    if (!picked.length) { toast(T('claims.need_pick', 'Select the bills to claim first'), 'bad'); return; }
    const ids = picked.map(x => x.value); const sum = picked.reduce((s, x) => s + Number(x.dataset.koboShare || 0), 0);
    const h = c.hmo || {}; const to = h.claimsEmail || h.email;
    const v = await dialog({ title: T('claims.send_t', 'Send a claim batch to {hmo}?', { hmo: h.name || '' }), form: true,
      body: html`<p>${ids.length === 1 ? T('claims.send_body_one', '1 bill, HMO share {amt}. The bill is marked claimed and cannot be claimed again.', { amt: money(sum) }) : T('claims.send_body', '{n} bills, total HMO share {amt}. Each bill is marked claimed and cannot be claimed again.', { n: ids.length, amt: money(sum) })}</p>
        <label class="check"><input type="checkbox" name="sendEmail" ${to ? 'checked' : ''}><span>${T('claims.email', 'Email the claim CSV to the HMO')}<br><span class="sm muted">${to ? (c.data.emailReady ? T('claims.email_to', 'Sends to {email}.', { email: to }) : T('claims.email_not_ready', 'Sends to {email} once MediCore\'s email service is connected. It is not connected yet, so download the CSV and send it yourself.', { email: to })) : T('claims.email_none', '{hmo} has no claims email on your panel. Download the CSV and send it yourself.', { hmo: h.name || '' })}</span></span></label>
        <div class="field"><label for="cs-n">${T('claims.note', 'Note for the HMO (optional)')}</label><input class="input" id="cs-n" name="note" maxlength="300" autocomplete="off"></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('claims.send_ok', 'Send claim batch'), primary: true }],
      onSubmit: d => guard409(() => api.post('/api/fd/external-claims/batches', { panelId: c.panelId, billIds: ids, sendEmail: !!d.sendEmail, note: d.note ? d.note.trim() : undefined })).then(r => r && Object.assign(r, { wantedEmail: !!d.sendEmail })) });
    if (!v) return;
    toast(v.count === 1 ? T('claims.sent_one', 'Claim batch {n} created with 1 bill', { n: v.number }) : T('claims.sent', 'Claim batch {n} created with {c} bills', { n: v.number, c: v.count }), 'ok');
    await sentDialog({ title: T('claims.sent_t', 'Claim batch {n} created', { n: v.number }), panel: h, emailSent: v.emailSent, wantedEmail: v.wantedEmail, emailReady: c.data.emailReady, kind: 'claim',
      message: v.count === 1 ? T('claims.wa_text_one', 'Claim batch {n} from {org}: 1 bill, total {amt}. The CSV with the bill details is attached or follows.', { n: v.number, org: MC.me.org.name, amt: money(v.totalCoveredKobo) }) : T('claims.wa_text', 'Claim batch {n} from {org}: {c} bills, total {amt}. The CSV with the bill details is attached or follows.', { n: v.number, org: MC.me.org.name, c: v.count, amt: money(v.totalCoveredKobo) }), whatsappLink: v.whatsappLink, portalUrl: v.portalUrl,
      next: T('claims.next', 'Download the CSV from the batch list if you need to upload it to the HMO portal. When the HMO pays, choose Record payment.') });
    MC.render();
  });
  on('cl-pay', async el => {
    const c = claimCtx; const x = c && c.batches.find(b => b.id === el.dataset.id); if (!x) return;
    const left = Math.max(0, x.totalCoveredKobo - (x.paidKobo || 0));
    const bills = (await Promise.all((x.billIds || []).slice(0, 100).map(id => api.get('/api/bills/' + id).catch(e => { if (e.status === 401) throw e; return null; })))).filter(Boolean);
    const v = await dialog({ title: T('claims.pay_t', 'Record payment for batch {n}', { n: x.number }), form: true,
      body: html`<p>${T('claims.pay_body', '{hmo} owes {left} on this batch (claimed {amt}, paid so far {paid}).', { hmo: x.hmoName, left: money(left), amt: money(x.totalCoveredKobo), paid: money(x.paidKobo || 0) })}</p>
        <div class="fields two"><div class="field"><label for="cp-a">${T('claims.pay_amt', 'Amount received (NGN)')}</label><input class="input" id="cp-a" name="paidKobo" type="number" min="0.01" step="any" inputmode="decimal" data-kobo value="${naira(left)}" required></div>
          <div class="field"><label for="cp-r">${T('claims.pay_ref', 'Payment reference')}</label><input class="input" id="cp-r" name="reference" maxlength="80" required autocomplete="off" placeholder="${T('claims.pay_ref_ph', 'e.g. bank transfer reference')}"></div></div>
        ${bills.length ? html`<div class="field"><span class="label">${T('claims.rejected', 'Bills the HMO rejected (optional)')}</span>${bills.map(b => html`<label class="check"><input type="checkbox" name="rejectedBillIds" value="${b.id}" data-list><span>${b.number} | ${b.patientName} | ${money(b.hmoExternal ? b.hmoExternal.coveredKobo : 0)}</span></label>`)}</div>` : ''}`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('claims.record', 'Record payment'), primary: true }],
      onSubmit: async d => {
        const details = [];
        if (d.paidKobo == null || Number.isNaN(d.paidKobo) || d.paidKobo < 1) details.push({ field: 'paidKobo', error: T('claims.need_amt', 'Enter the amount the HMO paid') });
        if (!d.reference || !d.reference.trim()) details.push({ field: 'reference', error: T('claims.need_ref', 'Enter the payment reference') });
        if (details.length) throw err400(details[0].error, details);
        const rej = d.rejectedBillIds || [];
        if (!(await confirm({ title: T('claims.pay_q', 'Record this payment?'), body: rej.length ? T('claims.pay_q_rej', '{amt} received from {hmo} with reference {r}. {k} bills are marked rejected. This cannot be undone.', { amt: money(d.paidKobo), hmo: x.hmoName, r: d.reference.trim(), k: rej.length }) : T('claims.pay_q_body', '{amt} received from {hmo} with reference {r}. This cannot be undone.', { amt: money(d.paidKobo), hmo: x.hmoName, r: d.reference.trim() }), ok: T('claims.record', 'Record payment') }))) return false;
        return guard409(() => api.post('/api/fd/external-claims/batches/' + x.id + '/payment', { paidKobo: d.paidKobo, reference: d.reference.trim(), rejectedBillIds: rej.length ? rej : undefined }));
      } });
    if (v) { toast(T('claims.paid_toast', 'Payment recorded on batch {n}', { n: x.number }), 'ok'); MC.render(); }
  });

  /* ================= appointments ================= */
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  async function appointments({ query }) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(query.date || '') ? query.date : MC.todayISO();
    const [docs, rows] = await Promise.all([doctors(), api.get('/api/fd/appointments' + qs({ date: day, doctorMembershipId: query.doctor }))]);
    lastAppts = rows;
    const byDoc = {}; rows.forEach(a => { (byDoc[a.doctorName] = byDoc[a.doctorName] || []).push(a); });
    const isToday = day === MC.todayISO();
    view(html`<div class="page-head"><div><h1>${T('appt.title', 'Appointments')}</h1><p>${MC.day(Date.parse(day + 'T12:00:00Z'))}${isToday ? ' (' + T('appt.today', 'today') + ')' : ''} | ${T('appt.count', '{n} booked', { n: rows.filter(a => a.status !== 'cancelled').length })}</p></div>
      <div class="actions"><a class="btn" href="#/appointments${qs({ date: addDays(day, -1), doctor: query.doctor })}" aria-label="${T('appt.prev', 'Previous day')}">${icon('left')}</a><a class="btn" href="#/appointments${qs({ doctor: query.doctor })}">${T('appt.today_btn', 'Today')}</a><a class="btn" href="#/appointments${qs({ date: addDays(day, 1), doctor: query.doctor })}" aria-label="${T('appt.next', 'Next day')}"><span style="width:20px;height:20px;flex:none;display:inline-flex" aria-hidden="true">${icon('right')}</span></a>
      ${canAny('queue.manage', 'patient.register') ? html`<a class="btn primary" href="#/patients">${icon('plus')}${T('appt.book', 'Book for a patient')}</a>` : ''}</div></div>
      <form class="row wrap panel" data-form="appt-filter" novalidate>
        <div class="field"><label for="af-d">${T('appt.date', 'Date')}</label><input class="input" id="af-d" name="date" type="date" value="${day}"></div>
        <div class="field"><label for="af-doc">${T('ci.doctor', 'Doctor')}</label><select class="input" id="af-doc" name="doctor"><option value="">${T('appt.all_docs', 'All doctors')}</option>${docs.map(x => html`<option value="${x.membershipId}" ${query.doctor === x.membershipId ? 'selected' : ''}>${x.name}</option>`)}</select></div>
        <button class="btn" type="submit">${T('appt.show', 'Show')}</button></form>
      ${rows.length ? Object.keys(byDoc).sort().map(n => html`<section class="panel flush"><h2>${n}</h2><div class="table-wrap" style="border:0"><table class="t stack-sm"><thead><tr><th>${T('appt.time', 'Time')}</th><th>${T('appt.patient', 'Patient')}</th><th>${T('appt.type', 'Type')}</th><th>${T('appt.status', 'Status')}</th><th></th></tr></thead><tbody>
        ${byDoc[n].map(a => html`<tr><td data-label="${T('appt.time', 'Time')}"><b>${a.time}</b></td><td data-label="${T('appt.patient', 'Patient')}"><a href="#/patient/${a.patientId}">${a.patient.name}</a><br><span class="xs muted">${[a.patient.mrn, a.reason].filter(Boolean).join(' | ')}</span></td>
          <td data-label="${T('appt.type', 'Type')}">${typeLabel(a.type)}<br><span class="xs muted">${money(a.feeKobo)} ${a.paid ? T('pt.paid', 'paid') : T('pt.unpaid', 'not paid')}</span></td><td data-label="${T('appt.status', 'Status')}">${sb(a.status)}${a.refundDue ? html` ${badge(T('appt.refund', 'Refund due'), 'warn')}` : ''}</td>
          <td class="num"><span class="row wrap">${a.status === 'booked' && isToday && a.type === 'in_person' && can('queue.manage') ? html`<button class="btn sm primary" data-action="appt-checkin" data-id="${a.id}">${T('ci.btn', 'Check in')}</button>` : ''}
            ${a.status === 'booked' && Date.now() >= a.startUtc && canAny('queue.manage', 'patient.register') ? html`<button class="btn sm" data-action="appt-noshow" data-id="${a.id}">${T('appt.noshow', 'No-show')}</button>` : ''}
            ${['booked', 'checked_in'].includes(a.status) && canAny('queue.manage', 'patient.register') ? html`<button class="btn sm ghost" data-action="appt-cancel" data-id="${a.id}">${T('appt.cancel', 'Cancel')}</button>` : ''}</span></td></tr>`)}
      </tbody></table></div></section>`) : empty({ icon: 'calendar', title: T('appt.empty', 'No appointments on this day'), body: T('appt.empty_sub', 'Find the patient first, then book from their page.') })}`);
  }
  let lastAppts = [];
  form('appt-filter', d => MC.go('#/appointments' + qs({ date: d.date, doctor: d.doctor })));
  on('appt-checkin', async el => {
    const a = lastAppts.find(x => x.id === el.dataset.id); if (!a) return;
    const r = await api.post('/api/fd/queue', { patientId: a.patientId, appointmentId: a.id, servicePoint: 'doctor' });
    toast(T('ci.done', 'Checked in. Ticket {n}', { n: r.number }), 'ok'); MC.render();
  });
  on('appt-noshow', async el => {
    const a = lastAppts.find(x => x.id === el.dataset.id); if (!a) return;
    if (!(await confirm({ title: T('appt.noshow_q', 'Mark as no-show?'), body: T('appt.noshow_body', '{name} did not come for {time} with {doc}. The slot is recorded as a no-show.', { name: a.patient.name, time: a.time, doc: a.doctorName }), ok: T('appt.noshow_ok', 'Mark no-show'), danger: true }))) return;
    await api.post('/api/fd/appointments/' + a.id + '/no-show'); toast(T('appt.noshow_done', 'Marked as no-show'), 'ok'); MC.render();
  });
  on('appt-cancel', async el => {
    const a = lastAppts.find(x => x.id === el.dataset.id); if (!a) return;
    const v = await dialog({ title: T('appt.cancel_t', 'Cancel this appointment?'), form: true, body: html`<p>${T('appt.cancel_body', '{name} with {doc} at {time}. The slot is freed. An unpaid bill is voided; a paid one is marked for refund.', { name: a.patient.name, doc: a.doctorName, time: a.time })}</p>
      <div class="field"><label for="ac-r">${T('appt.reason', 'Reason')}</label><input class="input" id="ac-r" name="reason" minlength="3" maxlength="300" required></div>`,
      actions: [{ label: T('appt.keep', 'Keep appointment'), value: null }, { label: T('appt.cancel_ok', 'Cancel appointment'), primary: true, danger: true }],
      onSubmit: d => { if (!d.reason || d.reason.length < 3) throw err400(T('appt.need_reason', 'Give a reason (at least 3 characters)'), [{ field: 'reason', error: T('appt.need_reason', 'Give a reason (at least 3 characters)') }]); return api.post('/api/fd/appointments/' + a.id + '/cancel', { reason: d.reason }); } });
    if (v) { toast(T('appt.cancelled', 'Appointment cancelled'), 'ok'); MC.render(); }
  });

  async function book({ params, query, stale }) {
    const [p, docs] = await Promise.all([api.get('/api/fd/patients/' + params.pid), doctors()]);
    if (stale()) return;
    const doc = docs.find(x => x.membershipId === query.doctor) || null;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(query.date || '') ? query.date : MC.todayISO();
    const types = doc ? doc.types.filter(t => t !== 'video' || MC.feature('videoVisits')) : [];
    const type = types.includes(query.type) ? query.type : types[0];
    const slots = doc ? await api.get('/api/doctors/' + doc.membershipId + '/slots' + qs({ date: day })) : null;
    const fee = doc ? (type === 'video' ? doc.videoFeeKobo : doc.feeKobo) : null;
    bookCtx = { p, doc, day, type, fee };
    view(html`${back('#/patient/' + p.id, p.name)}${MC.wristband(p)}<div class="page-head"><div><h1>${T('book.title', 'Book an appointment')}</h1><p>${T('book.sub', 'Choose the doctor and day, then a free time.')}</p></div></div>
      ${docs.length ? html`<form class="panel" data-form="book-filter" novalidate><div class="fields three">
        <div class="field"><label for="bk-d">${T('ci.doctor', 'Doctor')}</label><select class="input" id="bk-d" name="doctor"><option value="">${T('reg.choose', 'Choose')}</option>${docs.map(x => html`<option value="${x.membershipId}" ${doc && doc.membershipId === x.membershipId ? 'selected' : ''}>${x.name}${x.specialty ? ' (' + x.specialty + ')' : ''}</option>`)}</select></div>
        <div class="field"><label for="bk-dt">${T('appt.date', 'Date')}</label><input class="input" id="bk-dt" name="date" type="date" min="${MC.todayISO()}" value="${day}"></div>
        <div class="field"><label for="bk-t">${T('appt.type', 'Type')}</label><select class="input" id="bk-t" name="type">${(types.length ? types : ['in_person']).map(t => html`<option value="${t}" ${t === type ? 'selected' : ''}>${typeLabel(t)}</option>`)}</select></div></div>
        <button class="btn" type="submit">${T('book.show', 'Show free times')}</button></form>` : empty({ icon: 'steth', title: T('book.no_docs', 'No doctors are taking bookings'), body: T('book.no_docs_sub', 'A doctor must set up their schedule in the Doctor app first.') })}
      ${doc ? html`<section class="panel"><h2>${T('book.free', 'Free times with {doc} on {d}', { doc: doc.name, d: MC.day(Date.parse(day + 'T12:00:00Z')) })}</h2>
        ${fee != null ? html`<p class="muted sm">${T('book.fee', 'Fee {fee}. A bill is raised when you book.', { fee: money(fee) })}</p>` : ''}
        ${slots && slots.slots.some(s => s.available) ? html`<div class="field"><label for="bk-r">${T('book.reason', 'Reason for the visit (optional)')}</label><input class="input" id="bk-r" maxlength="300"></div>
          <div class="row wrap">${slots.slots.map(s => html`<button class="btn ${s.available ? '' : 'ghost'}" data-action="book-slot" data-time="${s.time}" ${s.available ? '' : 'disabled'} aria-label="${s.available ? T('book.slot', 'Book {t}', { t: s.time }) : T('book.taken', '{t} not available', { t: s.time })}">${s.time}</button>`)}</div>`
          : empty({ icon: 'clock', title: T('book.none', 'No free times on this day'), body: T('book.none_sub', 'Try another day. The doctor may not work this day or is fully booked.') })}</section>` : ''}`);
  }
  let bookCtx = null;
  form('book-filter', d => MC.go('#/book/' + bookCtx.p.id + qs({ doctor: d.doctor, date: d.date, type: d.type })));
  on('book-slot', async el => {
    const c = bookCtx; const reasonEl = document.getElementById('bk-r'); const reason = reasonEl && reasonEl.value.trim() ? reasonEl.value.trim() : undefined;
    if (!(await confirm({ title: T('book.confirm_t', 'Book this appointment?'), body: T('book.confirm_body', '{name} with {doc} on {d} at {t} ({type}). A bill of {fee} will be raised for the patient.', { name: c.p.name, doc: c.doc.name, d: c.day, t: el.dataset.time, type: typeLabel(c.type), fee: money(c.fee || 0) }), ok: T('book.ok', 'Book appointment') }))) return;
    await api.post('/api/fd/appointments', { patientId: c.p.id, doctorMembershipId: c.doc.membershipId, date: c.day, time: el.dataset.time, type: c.type, reason });
    toast(T('book.done', 'Appointment booked for {t}', { t: el.dataset.time }), 'ok'); MC.go('#/patient/' + c.p.id);
  });

  /* ================= billing ================= */
  async function billing({ query }) {
    const status = ['open', 'paid', 'void'].includes(query.status) ? query.status : 'open';
    const rows = await api.get('/api/bills' + qs({ status, limit: 200 }));
    const due = rows.reduce((s, b) => s + (b.patientDueKobo - b.paidKobo), 0);
    view(html`<div class="page-head"><div><h1>${T('bill.title', 'Billing')}</h1><p>${T('bill.sub', 'Bills are built from the price list. Amounts cannot be typed.')}</p></div>
      <div class="actions">${can('billing.create') ? html`<a class="btn primary" href="#/bill/new">${icon('plus')}${T('bill.new', 'New bill')}</a>` : ''}</div></div>
      <div class="tabs" role="tablist">${['open', 'paid', 'void'].map(s => html`<a role="tab" href="#/billing?status=${s}" aria-selected="${s === status ? 'true' : 'false'}">${T('bill.tab.' + s, { open: 'Open', paid: 'Paid', void: 'Voided' }[s])}</a>`)}</div>
      ${status === 'open' && rows.length ? figures([{ value: rows.length, label: T('bill.open_n', 'Open bills') }, { value: money(due), label: T('bill.outstanding', 'Outstanding'), tone: due ? 'warn' : '' }]) : ''}
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('bill.number', 'Bill')}</th><th>${T('appt.patient', 'Patient')}</th><th>${T('bill.items', 'Items')}</th><th class="num">${T('bill.total', 'Total')}</th><th class="num">${T('bill.due', 'To pay')}</th><th>${T('appt.status', 'Status')}</th></tr></thead><tbody>
        ${rows.map(b => html`<tr class="click"><td data-label="${T('bill.number', 'Bill')}"><a href="#/bill/${b.id}"><b>${b.number}</b></a><br><span class="xs muted">${dateTime(b.createdAt)}</span></td><td data-label="${T('appt.patient', 'Patient')}">${b.patientName}</td><td data-label="${T('bill.items', 'Items')}">${b.lines.map(l => l.name).join(', ')}</td><td class="num" data-label="${T('bill.total', 'Total')}">${money(b.totalKobo)}</td><td class="num" data-label="${T('bill.due', 'To pay')}">${money(b.patientDueKobo - b.paidKobo)}</td><td data-label="${T('appt.status', 'Status')}">${sb(b.status)}</td></tr>`)}
      </tbody></table></div>` : empty({ icon: 'card', title: T('bill.empty.' + status, { open: 'No open bills', paid: 'No paid bills yet', void: 'No voided bills' }[status]), body: T('bill.empty_sub', 'Bills raised at your provider appear here.') })}`);
  }

  let cart = null;
  async function billNew({ query, stale }) {
    if (!can('billing.create')) return view(empty({ icon: 'lock', title: T('common.no_access', 'Your role cannot do this') }));
    if (!query.patientId) {
      const rows = query.q ? await api.get('/api/fd/patients' + qs({ q: query.q, limit: 30 })) : [];
      return view(html`${back('#/billing', T('bill.title', 'Billing'))}<div class="page-head"><div><h1>${T('bill.new', 'New bill')}</h1><p>${T('bill.who', 'First find the patient you are billing.')}</p></div></div>
        <form class="panel" data-form="bill-who" novalidate><div class="field search"><label class="sr-only" for="bw-q">${T('find.search_label', 'Name, phone or MRN')}</label>${icon('search')}<input class="input" id="bw-q" name="q" value="${query.q || ''}" placeholder="${T('find.search_label', 'Name, phone or MRN')}"></div><button class="btn primary" type="submit">${T('find.search_btn', 'Search')}</button></form>
        ${query.q ? (rows.length ? html`<div class="list">${rows.map(p => html`<a href="#/bill/new?patientId=${p.id}"><div class="grow"><span class="title">${p.name}</span><span class="sub">${[p.mrn, ageSex(p), p.phone].filter(Boolean).join(' | ')}</span></div><span style="width:20px;height:20px;flex:none;display:inline-flex" aria-hidden="true">${icon('right')}</span></a>`)}</div>` : empty({ icon: 'users', title: T('find.none', 'No patient matches'), body: T('bill.reg_first', 'The patient must be registered at the front desk first.') })) : ''}`);
    }
    const [p, svcs] = await Promise.all([api.get('/api/fd/patients/' + query.patientId), api.get('/api/services')]);
    if (stale()) return;
    cart = { p, svcs: svcs.filter(s => s.active !== false), lines: [], custom: [] };
    view(html`${back('#/patient/' + p.id, p.name)}${MC.wristband(p)}<div class="page-head"><div><h1>${T('bill.new_for', 'New bill for {name}', { name: p.name })}</h1><p>${T('bill.new_sub', 'Add items from the price list. Prices come from the price list your administrator set.')}</p></div></div>
      <div class="grid two">
        <section class="panel"><h2>${T('bill.price_list', 'Price list')}</h2>
          <div class="field search"><label class="sr-only" for="bill-q">${T('bill.search', 'Search services')}</label>${icon('search')}<input class="input" id="bill-q" placeholder="${T('bill.search', 'Search services')}" autocomplete="off"></div>
          <div id="bill-svcs"></div>
          ${can('billing.custom') ? html`<h3>${T('bill.custom', 'Custom item')}</h3><div class="fields three"><div class="field"><label for="cu-n">${T('bill.custom_name', 'Description')}</label><input class="input" id="cu-n" maxlength="120"></div><div class="field"><label for="cu-p">${T('bill.custom_price', 'Price (NGN)')}</label><input class="input" id="cu-p" type="number" min="1" step="50" inputmode="decimal"></div><div class="field"><label for="cu-q">${T('bill.qty', 'Qty')}</label><input class="input" id="cu-q" type="number" min="1" max="100" value="1"></div></div><button class="btn sm" data-action="bill-custom">${icon('plus')}${T('bill.custom_add', 'Add custom item')}</button>` : ''}
        </section>
        <section class="panel"><h2>${T('bill.this_bill', 'This bill')}</h2><div id="bill-cart"></div>
          <div class="field"><label for="bill-note">${T('bill.note', 'Note (optional)')}</label><input class="input" id="bill-note" maxlength="300"></div>
          <button class="btn primary lg block" data-action="bill-create">${T('bill.create', 'Create bill')}</button></section>
      </div>`);
    renderSvcs(''); renderCart();
  }
  form('bill-who', d => MC.go('#/bill/new' + qs({ q: d.q })));
  function renderSvcs(q) {
    const box = document.getElementById('bill-svcs'); if (!box || !cart) return;
    const s = q.toLowerCase(); const rows = cart.svcs.filter(x => !s || x.name.toLowerCase().includes(s) || x.code.toLowerCase().includes(s) || x.category.includes(s));
    MC.view(rows.length ? html`<ul class="list">${rows.slice(0, 30).map(x => html`<li><div class="grow"><span class="title">${x.name}</span><span class="sub">${x.code} | ${cap(x.category)}</span></div><span class="end"><b>${money(x.priceKobo)}</b><br><button class="btn sm" data-action="bill-add" data-code="${x.code}" aria-label="${T('bill.add_l', 'Add {name}', { name: x.name })}">${icon('plus')}${T('bill.add', 'Add')}</button></span></li>`)}</ul>` : empty({ icon: 'search', title: T('bill.no_svc', 'No service matches'), body: T('bill.no_svc_sub', 'Ask your administrator to add it to the price list.') }), box);
  }
  document.addEventListener('input', e => { if (e.target && e.target.id === 'bill-q') renderSvcs(e.target.value); });
  const cartTotal = () => cart.lines.reduce((s, l) => s + l.svc.priceKobo * l.qty, 0) + cart.custom.reduce((s, c) => s + c.unitPriceKobo * c.qty, 0);
  function renderCart() {
    const box = document.getElementById('bill-cart'); if (!box) return;
    const all = cart.lines.length + cart.custom.length;
    MC.view(all ? html`<ul class="list">${cart.lines.map((l, i) => html`<li><div class="grow"><span class="title">${l.svc.name}</span><span class="sub">${money(l.svc.priceKobo)} x ${l.qty}</span></div>
        <span class="end row"><button class="btn sm" data-action="bill-qty" data-i="${i}" data-d="-1" aria-label="${T('bill.less', 'One fewer')}">-</button><b aria-live="polite">${l.qty}</b><button class="btn sm" data-action="bill-qty" data-i="${i}" data-d="1" aria-label="${T('bill.more', 'One more')}">+</button><button class="icon-btn" data-action="bill-rm" data-i="${i}" aria-label="${T('bill.remove', 'Remove {name}', { name: l.svc.name })}">${icon('trash')}</button></span></li>`)}
        ${cart.custom.map((c, i) => html`<li><div class="grow"><span class="title">${c.name} ${badge(T('bill.custom_b', 'Custom'), 'outline')}</span><span class="sub">${money(c.unitPriceKobo)} x ${c.qty}</span></div><span class="end"><button class="icon-btn" data-action="bill-rm-c" data-i="${i}" aria-label="${T('bill.remove', 'Remove {name}', { name: c.name })}">${icon('trash')}</button></span></li>`)}
        <li><div class="grow"><span class="title">${T('bill.total', 'Total')}</span></div><span class="end"><b>${money(cartTotal())}</b></span></li></ul>`
      : empty({ icon: 'card', title: T('bill.empty_cart', 'No items yet'), body: T('bill.empty_cart_sub', 'Search the price list and add items.') }), box);
  }
  on('bill-add', el => { const svc = cart.svcs.find(x => x.code === el.dataset.code); const ex = cart.lines.find(l => l.svc.code === svc.code); if (ex) ex.qty = Math.min(100, ex.qty + 1); else cart.lines.push({ svc, qty: 1 }); renderCart(); toast(T('bill.added', '{name} added', { name: svc.name })); });
  on('bill-qty', el => { const l = cart.lines[Number(el.dataset.i)]; if (!l) return; l.qty = Math.max(1, Math.min(100, l.qty + Number(el.dataset.d))); renderCart(); });
  on('bill-rm', el => { cart.lines.splice(Number(el.dataset.i), 1); renderCart(); });
  on('bill-rm-c', el => { cart.custom.splice(Number(el.dataset.i), 1); renderCart(); });
  on('bill-custom', () => {
    const n = document.getElementById('cu-n'), pr = document.getElementById('cu-p'), q = document.getElementById('cu-q');
    const price = Math.round(Number(pr.value) * 100), qty = Math.max(1, Math.min(100, Math.round(Number(q.value) || 1)));
    if (!n.value.trim() || !(price >= 100)) { toast(T('bill.custom_need', 'Give a description and a price of at least NGN 1'), 'bad'); return; }
    cart.custom.push({ name: n.value.trim(), unitPriceKobo: price, qty }); n.value = ''; pr.value = ''; q.value = '1'; renderCart();
  });
  on('bill-create', async () => {
    if (!cart.lines.length && !cart.custom.length) { toast(T('bill.need_items', 'Add at least one item'), 'bad'); return; }
    const total = cartTotal();
    if (!(await confirm({ title: T('bill.create_q', 'Create this bill?'), body: T('bill.create_body', 'A bill of {amt} will be raised for {name}. It can be voided only while unpaid.', { amt: money(total), name: cart.p.name }), ok: T('bill.create', 'Create bill') }))) return;
    const note = document.getElementById('bill-note').value.trim();
    const b = await api.post('/api/bills', { patientId: cart.p.id, items: cart.lines.map(l => ({ serviceCode: l.svc.code, qty: l.qty })), customItems: cart.custom.length ? cart.custom : undefined, note: note || undefined });
    toast(T('bill.created', 'Bill {n} created', { n: b.number }), 'ok'); MC.go('#/bill/' + b.id);
  });

  const METHODS = { cash: 'Cash', pos: 'POS (card)', transfer: 'Bank transfer' };
  async function billPage({ params, stale }) {
    let b;
    try { b = await api.get('/api/bills/' + params.id); } catch (e) { if (e.status === 404) return view(empty({ icon: 'card', title: T('bill.not_found', 'Bill not found'), action: html`<a class="btn" href="#/billing">${T('bill.title', 'Billing')}</a>` })); throw e; }
    const canExt = b.status === 'open' && b.paidKobo === 0 && !b.hmo && !b.hmoExternal && canAny('hmo.check', 'billing.create') && canAny('hmo.check', 'hmo.claim');
    const offHmos = canExt ? (await extHmos()).filter(h => !h.onPlatform) : [];
    if (stale && stale()) return;
    curBill = b;
    const xh = b.hmoExternal;
    const balance = b.patientDueKobo - b.paidKobo;
    view(html`${back('#/billing', T('bill.title', 'Billing'))}<div class="page-head"><div><h1>${T('bill.bill_n', 'Bill {n}', { n: b.number })}</h1><p>${b.patientName} | ${dateTime(b.createdAt)} | ${sb(b.status)}</p></div>
      <div class="actions">
        ${b.status === 'open' && balance > 0 && can('billing.cash') ? html`<button class="btn primary" data-action="bill-pay">${icon('card')}${T('bill.record', 'Record payment')}</button>` : ''}
        ${offHmos.length ? html`<button class="btn" data-action="bill-ext">${icon('shield')}${T('xb.btn', 'Off-platform HMO pays part')}</button>` : ''}
        ${b.status === 'open' && b.paidKobo === 0 && can('billing.void') ? html`<button class="btn" data-action="bill-void">${icon('x')}${T('bill.void', 'Void bill')}</button>` : ''}
        <button class="btn" data-action="bill-print">${icon('file')}${b.status === 'paid' ? T('bill.print_receipt', 'Print receipt') : T('bill.print', 'Print bill')}</button>
        <a class="btn ghost" href="#/patient/${b.patientId}">${T('bill.patient', 'Patient page')}</a></div></div>
      <section class="panel receipt">
        <div class="row between wrap"><div><h2>${MC.me.org.name}</h2><p class="muted sm">${b.status === 'paid' ? T('bill.receipt', 'Receipt') : T('bill.invoice', 'Bill')} ${b.number}</p></div><div class="sm"><b>${b.patientName}</b><br>${dateTime(b.createdAt)}</div></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>${T('bill.item', 'Item')}</th><th class="num">${T('bill.qty', 'Qty')}</th><th class="num">${T('bill.unit', 'Price')}</th><th class="num">${T('bill.amount', 'Amount')}</th></tr></thead><tbody>
          ${b.lines.map(l => html`<tr><td>${l.name}<br><span class="xs muted">${l.code}</span></td><td class="num">${l.qty}</td><td class="num">${money(l.unitPriceKobo)}</td><td class="num">${money(l.totalKobo)}</td></tr>`)}
        </tbody></table></div>
        <dl class="kv" style="margin-top:16px"><dt>${T('bill.total', 'Total')}</dt><dd><b>${money(b.totalKobo)}</b></dd>
          ${b.hmo ? html`<dt>${T('bill.hmo', 'HMO covers')}</dt><dd>${money(b.hmo.coveredKobo)}</dd>` : ''}
          ${xh ? html`<dt>${T('xb.share', 'HMO share')}</dt><dd><b>${money(xh.coveredKobo)}</b> ${T('xb.paid_by', 'paid by {hmo}', { hmo: xh.hmoName })}<br><span class="xs muted">${[xh.memberNo ? T('xb.member', 'Member {n}', { n: xh.memberNo }) : '', xh.authCode ? T('xb.code', 'Authorisation code {c}', { c: xh.authCode }) : T('xb.no_code', 'No authorisation code')].filter(Boolean).join(' | ')}</span><br>${claimBadge(xh.claimStatus)}</dd>` : ''}
          <dt>${T('bill.patient_pays', 'Patient pays')}</dt><dd>${money(b.patientDueKobo)}</dd><dt>${T('bill.paid', 'Paid')}</dt><dd>${money(b.paidKobo)}</dd>
          <dt>${T('bill.balance', 'Balance')}</dt><dd><b>${money(balance)}</b></dd>
          ${b.note ? html`<dt>${T('bill.note_s', 'Note')}</dt><dd>${b.note}</dd>` : ''}${b.voidReason ? html`<dt>${T('bill.void_reason', 'Void reason')}</dt><dd>${b.voidReason}</dd>` : ''}</dl>
        ${xh ? html`<div class="notice ok" style="margin-top:16px">${b.patientDueKobo > 0 ? T('xb.split', '{hmo} pays {hmo_amt}. The patient pays the remaining {rest}.', { hmo: xh.hmoName, hmo_amt: money(xh.coveredKobo), rest: money(b.patientDueKobo) }) : T('xb.full', '{hmo} pays the whole bill. The patient pays nothing.', { hmo: xh.hmoName })}</div>` : ''}
        ${(b.payments || []).length ? html`<h3 style="margin-top:16px">${T('bill.payments', 'Payments')}</h3><ul class="list">${b.payments.map(x => html`<li><div class="grow"><span class="title">${money(x.amountKobo)} | ${T('bill.m.' + x.method, METHODS[x.method] || cap(x.method))}</span><span class="sub">${T('bill.ref', 'Reference {r}', { r: x.reference })} | ${dateTime(x.confirmedAt || x.at)}</span></div></li>`)}</ul>` : ''}
      </section>`);
  }
  let curBill = null;
  on('bill-print', () => window.print());
  on('bill-pay', async () => {
    const b = curBill; const balance = b.patientDueKobo - b.paidKobo;
    const v = await dialog({ title: T('bill.record_t', 'Record payment for {n}', { n: b.number }), form: true, body: html`
      <p>${T('bill.amount_due', 'Amount due')}: <b>${money(balance)}</b></p>
      <div class="field"><span class="label">${T('bill.method', 'How did they pay?')}</span>${Object.keys(METHODS).map((m, i) => html`<label class="check"><input type="radio" name="method" value="${m}" ${i === 0 ? 'checked' : ''}><span>${T('bill.m.' + m, METHODS[m])}</span></label>`)}</div>
      <div class="field"><label for="bp-r">${T('bill.receipt_no', 'Receipt number or POS reference')}</label><input class="input" id="bp-r" name="receiptNo" maxlength="40" required autocomplete="off"><div class="hint">${T('bill.receipt_hint', 'Each number can be used once.')}</div></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('bill.record_ok', 'Record {amt}', { amt: money(balance) }), primary: true }],
      onSubmit: async d => {
        if (!d.receiptNo) throw err400(T('bill.need_receipt', 'Enter the receipt number'), [{ field: 'receiptNo', error: T('bill.need_receipt', 'Enter the receipt number') }]);
        if (!(await confirm({ title: T('bill.confirm_pay', 'Confirm payment'), body: T('bill.confirm_pay_body', 'Record {amt} paid by {m} with reference {r} on bill {n}? This cannot be undone.', { amt: money(balance), m: T('bill.m.' + d.method, METHODS[d.method]), r: d.receiptNo, n: b.number }), ok: T('bill.record', 'Record payment') }))) return false;
        return api.post('/api/bills/' + b.id + '/cash', { method: d.method, amountKobo: balance, receiptNo: d.receiptNo });
      } });
    if (v) { toast(T('bill.paid_toast', 'Payment of {amt} recorded', { amt: money(balance) }), 'ok'); MC.render(); }
  });
  on('bill-void', async () => {
    const b = curBill;
    const v = await dialog({ title: T('bill.void_t', 'Void bill {n}?', { n: b.number }), form: true, body: html`<p>${T('bill.void_body', 'The bill of {amt} for {name} will be cancelled. This cannot be undone.', { amt: money(b.totalKobo), name: b.patientName })}</p>
      <div class="field"><label for="bv-r">${T('bill.void_reason', 'Void reason')}</label><textarea class="input" id="bv-r" name="reason" minlength="5" maxlength="300" required></textarea></div>`,
      actions: [{ label: T('bill.keep', 'Keep bill'), value: null }, { label: T('bill.void', 'Void bill'), primary: true, danger: true }],
      onSubmit: d => { if (!d.reason || d.reason.length < 5) throw err400(T('bill.need_void', 'Give a reason of at least 5 characters'), [{ field: 'reason', error: T('bill.need_void', 'Give a reason of at least 5 characters') }]); return api.post('/api/bills/' + b.id + '/void', { reason: d.reason }); } });
    if (v) { toast(T('bill.voided', 'Bill voided'), 'ok'); MC.render(); }
  });

  /* ================= customer care ================= */
  const CHANNELS = ['phone', 'walk_in', 'whatsapp', 'email', 'app', 'sms', 'social', 'other'];
  const CATS = ['enquiry', 'complaint', 'billing', 'appointment', 'results', 'prescription', 'feedback', 'other'];
  const chLabel = c => T('care.ch.' + c, { walk_in: 'Walk-in', whatsapp: 'WhatsApp', sms: 'SMS' }[c] || cap(c));
  const catLabel = c => T('care.cat.' + c, cap(c));
  const cpri = p => badge(T('care.pri.' + p, cap(p)), p === 'high' ? 'bad' : p === 'low' ? 'outline' : 'info');
  async function care({ query }) {
    const status = ['open', 'pending', 'resolved'].includes(query.status) ? query.status : '';
    const rows = await api.get('/api/fd/care-cases' + qs({ status, limit: 200 }));
    view(html`<div class="page-head"><div><h1>${T('care.title', 'Customer care')}</h1><p>${T('care.sub', 'Enquiries, complaints and feedback from patients')}</p></div>
      <div class="actions"><button class="btn primary" data-action="care-new">${icon('plus')}${T('care.new', 'New case')}</button></div></div>
      <div class="tabs" role="tablist">${['', 'open', 'pending', 'resolved'].map(s => html`<a role="tab" href="#/care${s ? '?status=' + s : ''}" aria-selected="${s === status ? 'true' : 'false'}">${s ? MC.t('status.' + s, cap(s)) : T('today.all', 'All')}</a>`)}</div>
      ${rows.length ? html`<div class="list">${rows.map(c => html`<a href="#/care/${c.id}"><div class="grow"><span class="title">${c.subject}</span><span class="sub">${c.number} | ${chLabel(c.channel)} | ${catLabel(c.category)}${c.patientName ? ' | ' + c.patientName : ''} | ${ago(c.updatedAt)}</span></div><span class="end">${cpri(c.priority)} ${sb(c.status)}</span></a>`)}</div>`
        : empty({ icon: 'message', title: T('care.empty', 'No cases here'), body: T('care.empty_sub', 'Log each call, visit or message from a patient as a case so it is followed up.') })}`);
  }
  on('care-new', async el => {
    const pid = el.dataset.patient || null, pname = el.dataset.name || null;
    const c = await dialog({ title: T('care.new', 'New case'), form: true, body: html`
      ${pid ? html`<p class="muted">${T('care.for', 'For {name}', { name: pname })}</p>` : ''}
      <div class="field"><label for="cn-s">${T('care.subject', 'Subject')}</label><input class="input" id="cn-s" name="subject" minlength="3" maxlength="160" required></div>
      <div class="fields three"><div class="field"><label for="cn-ch">${T('care.channel', 'Channel')}</label><select class="input" id="cn-ch" name="channel">${CHANNELS.map(x => html`<option value="${x}">${chLabel(x)}</option>`)}</select></div>
      <div class="field"><label for="cn-c">${T('care.category', 'Category')}</label><select class="input" id="cn-c" name="category">${CATS.map(x => html`<option value="${x}">${catLabel(x)}</option>`)}</select></div>
      <div class="field"><label for="cn-p">${T('today.priority', 'Priority')}</label><select class="input" id="cn-p" name="priority">${['normal', 'high', 'low'].map(x => html`<option value="${x}">${T('care.pri.' + x, cap(x))}</option>`)}</select></div></div>
      <div class="field"><label for="cn-n">${T('care.note', 'What happened')}</label><textarea class="input" id="cn-n" name="note" maxlength="2000"></textarea></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('care.create', 'Create case'), primary: true }],
      onSubmit: d => { if (!d.subject || d.subject.length < 3) throw err400(T('care.need_subject', 'Give a subject of at least 3 characters'), [{ field: 'subject', error: T('care.need_subject', 'Give a subject of at least 3 characters') }]); return api.post('/api/fd/care-cases', Object.assign({}, d, { patientId: pid || undefined })); } });
    if (c) { toast(T('care.created', 'Case {n} created', { n: c.number }), 'ok'); MC.go('#/care/' + c.id); }
  });
  async function careCase({ params }) {
    let c; try { c = await api.get('/api/fd/care-cases/' + params.id); } catch (e) { if (e.status === 404) return view(empty({ icon: 'message', title: T('care.not_found', 'Case not found') })); throw e; }
    const next = { open: ['pending', 'resolved'], pending: ['open', 'resolved'], resolved: ['open'] }[c.status] || [];
    const lbl = { pending: T('care.to_pending', 'Mark pending'), resolved: T('care.to_resolved', 'Mark resolved'), open: c.status === 'resolved' ? T('care.reopen', 'Reopen') : T('care.to_open', 'Back to open') };
    view(html`${back('#/care', T('care.title', 'Customer care'))}<div class="page-head"><div><h1>${c.subject}</h1><p>${c.number} | ${sb(c.status)} ${cpri(c.priority)}</p></div>
      <div class="actions">${next.map(s => html`<button class="btn ${s === 'resolved' ? 'primary' : ''}" data-action="care-status" data-id="${c.id}" data-s="${s}">${lbl[s]}</button>`)}</div></div>
      <div class="grid side-r"><div>
        <section class="panel"><h2>${T('care.notes', 'Notes')}</h2>${c.notes.length ? html`<ol class="timeline">${c.notes.map(n => html`<li><time>${dateTime(n.at)} | ${n.byName}</time>${n.text}</li>`)}</ol>` : html`<p class="muted">${T('care.no_notes', 'No notes yet.')}</p>`}</section>
        <form class="panel" data-form="care-note" novalidate><div class="field"><label for="cnn">${T('care.add_note', 'Add a note')}</label><textarea class="input" id="cnn" name="text" required maxlength="2000"></textarea></div><div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${T('care.save_note', 'Save note')}</button></form>
      </div><section class="panel"><h2>${T('pt.details', 'Details')}</h2><dl class="kv"><dt>${T('appt.patient', 'Patient')}</dt><dd>${c.patientId ? html`<a href="#/patient/${c.patientId}">${c.patientName}</a>` : '-'}</dd><dt>${T('care.channel', 'Channel')}</dt><dd>${chLabel(c.channel)}</dd><dt>${T('care.category', 'Category')}</dt><dd>${catLabel(c.category)}</dd><dt>${T('care.opened', 'Opened')}</dt><dd>${dateTime(c.createdAt)} | ${c.createdByName}</dd>${c.resolvedAt ? html`<dt>${T('care.resolved_at', 'Resolved')}</dt><dd>${dateTime(c.resolvedAt)}</dd>` : ''}</dl></section></div>`);
    form('care-note', async d => { if (!d.text) throw err400(T('care.need_note', 'Write the note first')); await api.post('/api/fd/care-cases/' + c.id + '/notes', { text: d.text }); toast(T('care.noted', 'Note saved'), 'ok'); MC.render(); });
  }
  on('care-status', async el => { await api.post('/api/fd/care-cases/' + el.dataset.id + '/status', { status: el.dataset.s }); toast(T('care.status_saved', 'Case marked {s}', { s: MC.t('status.' + el.dataset.s, cap(el.dataset.s)) }), 'ok'); MC.render(); });

  /* ================= incoming ambulance patients ================= */
  let incomingOK = true;
  async function incoming() {
    view(html`<div class="page-head"><div><h1>${T('inc.title', 'Incoming ambulance patients')}</h1><p>${T('inc.sub', 'Patients an ambulance is bringing to you. Refreshes every 15 seconds.')}</p></div><div class="actions"><a class="btn" href="#/patients">${icon('plus')}${T('inc.register', 'Register on arrival')}</a></div></div><div id="inc-box">${MC.skeleton(2)}</div>`);
    const box = document.getElementById('inc-box');
    const load = async () => {
      let rows;
      try { rows = await api.get('/api/fd/incoming'); } catch (e) { if (e.status === 404) { MC.view(empty({ icon: 'ambulance', title: T('inc.not_ready', 'Incoming patients are not available yet') }), box); return; } throw e; }
      if (!box.isConnected) return;
      MC.navCount('#/incoming', rows.length);
      MC.view(rows.length ? html`<ul class="list">${rows.map(r => html`<li><div class="grow"><span class="title">${r.number} | ${r.categoryLabel} <span class="badge plain pri-${r.priority}">${r.priority}</span></span>
        <span class="sub">${r.fromProvider ? r.fromProvider.name + (r.fromProvider.phone ? ', ' + r.fromProvider.phone : '') : ''}${r.unit ? ' | ' + r.unit.name + ' (' + r.unit.plate + ')' : ''}</span>
        ${r.patient ? html`<span class="sub">${[r.patient.firstName, r.patient.age != null ? T('common.age', '{n} yrs', { n: r.patient.age }) : '', sexLabel(r.patient.sex), r.patient.bloodGroup].filter(Boolean).join(', ')}</span>${r.patient.allergies && r.patient.allergies.length ? html`<span class="row wrap">${r.patient.allergies.map(a => html`<span class="allergy-tag">${icon('alert')}${a.substance}</span>`)}</span>` : ''}` : ''}</div>
        <span class="end">${badge(r.statusLabel || cap(r.status), r.arrivedAt ? 'ok' : 'info')}<br><span class="sm">${r.arrivedAt ? T('inc.arrived', 'Arrived {t}', { t: time(r.arrivedAt) }) : r.etaMinutes != null ? T('inc.eta', 'About {n} min away', { n: r.etaMinutes }) : ''}</span></span></li>`)}</ul>`
        : empty({ icon: 'ambulance', title: T('inc.empty', 'No ambulance is on the way'), body: T('inc.empty_sub', 'When a crew picks your provider as the destination, the patient appears here.') }), box);
    };
    await load(); MC.poll(load, 15000);
  }

  /* ================= patient applications ================= */
  const APP_TABS = ['pending', 'approved', 'declined'];
  let lastApps = [];
  async function appsNotice(el) {
    if (!el || !can('patient.applications')) return;
    let rows; try { rows = await api.get('/api/fd/applications' + qs({ status: 'pending', limit: 200 })); } catch (e) { if (e.status === 401) throw e; return; }
    if (!el.isConnected) return;
    MC.navCount('#/applications', rows.length);
    MC.view(rows.length ? html`<div class="notice warn" role="status"><div class="row wrap between"><span>${rows.length === 1 ? T('apps.note_one', '1 patient asked to register with you in the MediCore app.') : T('apps.note_many', '{n} patients asked to register with you in the MediCore app.', { n: rows.length })}</span><a class="btn sm" href="#/applications">${icon('users')}${T('apps.review', 'Review applications')}</a></div></div>` : '', el);
  }
  function appRow(a, status) {
    const p = a.patient || {};
    const who = [p.age != null ? T('common.age', '{n} yrs', { n: p.age }) : '', sexLabel(p.sex)].filter(Boolean).join(', ');
    return html`<li style="flex-wrap:wrap"><div class="grow" style="flex:1 1 240px"><span class="title">${p.name || T('apps.unknown', 'Patient')}</span>
      <span class="sub">${[who, p.phone].filter(Boolean).join(' | ')} ${p.phone ? (p.phoneVerified ? badge(T('apps.verified', 'Phone verified'), 'ok') : badge(T('apps.unverified', 'Phone not verified'), 'warn')) : ''}</span>
      ${p.dob ? html`<span class="sub">${T('apps.dob', 'Born {d}', { d: date(Date.parse(p.dob + 'T12:00:00Z')) })}${p.address ? ' | ' + p.address : ''}</span>` : p.address ? html`<span class="sub">${p.address}</span>` : ''}
      ${a.note ? html`<span class="sub">${T('apps.note', 'Note from the patient')}: ${a.note}</span>` : ''}
      <span class="sub">${a.number} | ${T('apps.applied', 'Applied {d}', { d: dateTime(a.createdAt) })}${a.groupName && a.orgName ? ' | ' + a.orgName : ''}</span>
      ${status === 'approved' ? html`<span class="sub">${T('apps.approved_by', 'Approved {d}{by}', { d: dateTime(a.decidedAt), by: a.decidedByName ? ' ' + T('apps.by', 'by {name}', { name: a.decidedByName }) : '' })}</span>` : ''}
      ${status === 'declined' ? html`<span class="sub">${T('apps.declined_by', 'Declined {d}{by}', { d: dateTime(a.decidedAt), by: a.decidedByName ? ' ' + T('apps.by', 'by {name}', { name: a.decidedByName }) : '' })}: ${a.reason || ''}</span>` : ''}</div>
      <span class="btn-row" style="margin-top:0">${status === 'pending' ? html`<button class="btn sm primary" data-action="app-approve" data-id="${a.id}">${icon('check')}${T('apps.approve', 'Approve')}</button><button class="btn sm" data-action="app-decline" data-id="${a.id}">${T('apps.decline', 'Decline')}</button>`
        : status === 'approved' && p.id && can('patient.read') ? html`<a class="btn sm" href="#/patient/${p.id}">${T('apps.open', 'Open patient')}</a>` : ''}</span></li>`;
  }
  const appsCount = () => api.get('/api/fd/applications' + qs({ status: 'pending', limit: 200 })).then(r => MC.navCount('#/applications', r.length)).catch(() => {});
  async function applications({ query }) {
    if (!can('patient.applications')) return view(empty({ icon: 'lock', title: T('common.no_access', 'Your role cannot do this'), body: T('apps.no_access', 'Ask a receptionist or the front desk manager to review applications.') }));
    const status = APP_TABS.includes(query.status) ? query.status : 'pending';
    view(html`<div class="page-head"><div><h1>${T('apps.title', 'Patient applications')}</h1><p>${T('apps.sub', 'Patients who asked in the MediCore app to register with you. Check their details with them before you approve.')}</p></div></div>
      <div class="tabs" role="tablist">${APP_TABS.map(s => html`<a role="tab" href="#/applications${s === 'pending' ? '' : '?status=' + s}" aria-selected="${s === status ? 'true' : 'false'}">${T('apps.tab.' + s, { pending: 'Waiting', approved: 'Approved', declined: 'Declined' }[s])}</a>`)}</div>
      <div id="apps-box">${MC.skeleton(3)}</div>`);
    const box = document.getElementById('apps-box');
    let sig = '';
    const load = async () => {
      const rows = await api.get('/api/fd/applications' + qs({ status, limit: 200 }));
      if (!box.isConnected) return;
      if (status === 'pending') MC.navCount('#/applications', rows.length);
      const s = JSON.stringify(rows.map(a => [a.id, a.status])); if (s === sig) return; sig = s;
      lastApps = rows;
      MC.view(rows.length ? html`<ul class="list">${rows.map(a => appRow(a, status))}</ul>`
        : empty({ icon: 'users', title: status === 'pending' ? T('apps.empty', 'No applications waiting') : status === 'approved' ? T('apps.empty_approved', 'No approved applications yet') : T('apps.empty_declined', 'No declined applications'), body: status === 'pending' ? T('apps.empty_sub', 'When a patient asks to register with you in the MediCore app, the request appears here for you to approve.') : '' }), box);
    };
    await load();
    if (status === 'pending') MC.poll(load, 30000);
  }
  on('app-approve', async el => {
    const a = lastApps.find(x => x.id === el.dataset.id); if (!a) return;
    const name = (a.patient && a.patient.name) || T('apps.unknown', 'Patient');
    if (!(await confirm({ title: T('apps.approve_q', 'Approve {name}?', { name }), body: T('apps.approve_body', '{name} will be registered with {org} and given a record number. They are told in the MediCore app.', { name, org: MC.me.org.name }), ok: T('apps.approve_ok', 'Approve and register') }))) return;
    let r;
    try { r = await api.post('/api/fd/applications/' + a.id + '/approve'); } catch (e) { if (e.status === 409) { toast(e.message, 'bad'); MC.render(); return; } throw e; }
    const mrn = r.patient && r.patient.mrn;
    appsCount();
    toast(T('apps.approved', 'Application approved. Record number {mrn}', { mrn: mrn || '-' }), 'ok');
    const go = await dialog({ title: T('apps.registered', '{name} is registered', { name }), body: html`<p>${T('apps.mrn_is', 'Their record number is')}</p><p class="notice ok"><b>${mrn || '-'}</b></p><p class="muted sm">${T('apps.next', 'Check their allergies and details when they first visit.')}</p>`,
      actions: [{ label: T('apps.done', 'Done'), value: null }].concat(can('patient.read') && r.patient ? [{ label: T('apps.open', 'Open patient'), value: 'open', primary: true }] : []) });
    if (go === 'open' && r.patient) MC.go('#/patient/' + r.patient.id); else MC.render();
  });
  on('app-decline', async el => {
    const a = lastApps.find(x => x.id === el.dataset.id); if (!a) return;
    const name = (a.patient && a.patient.name) || T('apps.unknown', 'Patient');
    const v = await dialog({ title: T('apps.decline_q', 'Decline {name}?', { name }), form: true, body: html`<p>${T('apps.decline_body', '{name} is told your reason in the MediCore app.', { name })}</p>
      <div class="field"><label for="ad-r">${T('apps.reason', 'Reason')}</label><textarea class="input" id="ad-r" name="reason" minlength="5" maxlength="300" required></textarea><div class="hint">${T('apps.reason_hint', 'For example: we are not taking new patients this month. Please visit our Ikeja branch.')}</div></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('apps.decline_ok', 'Decline application'), primary: true, danger: true }],
      onSubmit: d => { const reason = (d.reason || '').trim(); if (reason.length < 5) throw err400(T('apps.need_reason', 'Give a reason of at least 5 characters'), [{ field: 'reason', error: T('apps.need_reason', 'Give a reason of at least 5 characters') }]); return api.post('/api/fd/applications/' + a.id + '/decline', { reason }); } });
    if (v) { toast(T('apps.declined', 'Application declined'), 'ok'); appsCount(); MC.render(); }
  });

  /* ================= boot ================= */
  MC.boot({
    title: 'MediCore Front Desk', home: '#/today',
    nav: [
      { href: '#/today', label: T('nav.today', 'Today'), icon: 'home' },
      { href: '#/patients', label: T('nav.patients', 'Patients'), icon: 'users', anyPerm: ['patient.read', 'patient.register'] },
      MC.referrals.navItem(),
      { href: '#/appointments', label: T('nav.appointments', 'Appointments'), short: T('nav.appts_short', 'Bookings'), icon: 'calendar', module: 'clinic', anyPerm: ['queue.manage', 'patient.register', 'billing.create', 'billing.cash'] },
      { href: '#/billing', label: T('nav.billing', 'Billing'), icon: 'card', anyPerm: ['billing.create', 'billing.cash'] },
      { href: '#/care', label: T('nav.care', 'Customer care'), short: T('nav.care_short', 'Care'), icon: 'message', perm: 'care.manage' },
      { href: '#/applications', label: T('nav.applications', 'Applications'), short: T('nav.applications_short', 'Joining'), icon: 'clipboard', perm: 'patient.applications' },
      MC.whatsapp.navItem(),
      { href: '#/preauths', label: T('nav.preauths', 'Pre-authorisations'), short: T('nav.preauths_short', 'Pre-auths'), icon: 'shield', anyPerm: ['hmo.check', 'hmo.claim'] },
      { href: '#/claims', label: T('nav.claims', 'HMO claims'), short: T('nav.claims_short', 'Claims'), icon: 'file', perm: 'hmo.claim' },
      { href: '#/incoming', label: T('nav.incoming', 'Incoming'), icon: 'ambulance', anyPerm: ['queue.manage', 'patient.register', 'patient.read'], show: () => incomingOK, sideOnly: true },
    ],
    routes: { '#/today': today, '#/patients': patients, '#/register': register, '#/patient/:id': patientPage, '#/appointments': appointments, '#/book/:pid': book,
      '#/billing': billing, '#/bill/new': billNew, '#/bill/:id': billPage, '#/care': care, '#/care/:id': careCase, '#/incoming': incoming, '#/applications': applications,
      '#/preauths': preauthsPage, '#/claims': claimsPage,
      ...MC.referrals.routes('#/referrals', { patientHref: pid => '#/patient/' + pid }),
      ...MC.whatsapp.routes('#/whatsapp', { patientHref: pid => '#/patient/' + pid }) },
    onReady: async () => {
      doctorsCache = null; hmosCache = null;
      MC.referrals.refreshCount();
      MC.whatsapp.refreshCount();
      if (can('patient.applications')) api.get('/api/fd/applications' + qs({ status: 'pending', limit: 200 })).then(r => MC.navCount('#/applications', r.length)).catch(() => {});
      try { await api.get('/api/fd/incoming'); incomingOK = true; }
      catch (e) { if (e.status === 404) { incomingOK = false; document.querySelectorAll('[data-nav][href="#/incoming"]').forEach(a => a.remove()); } }
    },
  });
})();
