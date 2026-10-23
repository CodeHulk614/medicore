/* MediCore Doctor: today's queue and appointments, consultations (SOAP, ICD-10, prescribing with
 * live safety checks, lab orders), patient chart, messages, video visits (WebRTC through the
 * stored-signal endpoints), weekly schedule and earnings. */
(function () {
  'use strict';
  const { html, api, qs, money, date, dateTime, time, ago, cap, icon, badge, empty, figures, view, on, form, dialog, confirm, toast } = MC;
  const T = (k, en, v) => MC.t('doctor.' + k, en, v);
  const hasMod = m => !!(MC.me && MC.me.org && (MC.me.org.modules || []).includes(m));
  const err400 = (msg, details) => new MC.ApiError(400, { error: msg, details });
  function kindOf(s) { return /(done|completed|paid|resolved|active|sent|released|connected)/.test(s) ? 'ok' : /(cancel|void|left|no_show|failed|closed)/.test(s) ? 'bad' : /(waiting|pending|open|booked|awaiting|checked_in)/.test(s) ? 'warn' : 'info'; }
  const sb = s => badge(MC.t('status.' + s, cap(s)), kindOf(s));
  const PRI_CLS = { emergency: 'pri-P1', urgent: 'pri-P2', routine: 'pri-P3' };
  const pri = p => html`<span class="badge plain ${PRI_CLS[p] || ''}">${T('pri.' + p, cap(p))}</span>`;
  const sexLabel = s => (s && s !== 'unknown' ? T('sex.' + s, cap(s)) : '');
  const ageSex = p => [p.age != null ? T('common.age', '{n} yrs', { n: p.age }) : '', sexLabel(p.sex)].filter(Boolean).join(', ');
  const typeLabel = t => (t === 'video' ? T('appt.video', 'Video') : t === 'walk_in' ? T('appt.walk_in', 'Walk-in') : T('appt.in_person', 'In person'));
  const back = (href, label) => html`<a class="back" href="${href}">${icon('left')}${label}</a>`;
  const debounce = (fn, ms) => { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  async function maybe(p) { try { return await p; } catch (e) { if (e.status === 401) throw e; return null; } }

  /* allergy line per patient (queue items carry no allergies): small per-session cache */
  const allergyCache = {};
  async function allergiesOf(pid) {
    if (allergyCache[pid]) return allergyCache[pid];
    try { const p = await api.get('/api/fd/patients/' + pid); allergyCache[pid] = { list: p.allergies || [] }; } catch (e) { allergyCache[pid] = { list: null }; }
    return allergyCache[pid];
  }
  function bandLine(p, al) {
    const list = al && al.list;
    return html`<span class="sub"><b>${p.name}</b> | ${ageSex(p)}${p.mrn ? ' | MRN ' + p.mrn : ''}</span>
      <span class="row wrap" style="gap:6px;margin-top:4px">${list && list.length ? list.map(a => html`<span class="allergy-tag">${icon('alert')}${a.substance}</span>`) : list ? html`<span class="xs muted">${T('band.no_allergy', 'No allergies on record')}</span>` : ''}</span>`;
  }

  /* ================= Today ================= */
  async function today() {
    view(html`<div class="page-head"><div><h1>${T('today.title', 'Today')}</h1><p id="dt-sub">${T('today.sub', 'Your queue and appointments')}</p></div><div class="actions"><a class="btn" href="#/patients">${icon('search')}${T('today.find', 'Find a patient')}</a>${refOK() ? html`<a class="btn" href="#/referrals">${icon('swap')}${T('today.referrals', 'Referrals')}</a>` : ''}</div></div><div id="dt-ref-note"></div><div id="dt-box">${MC.skeleton(4)}</div>`);
    const box = document.getElementById('dt-box');
    MC.referrals.homeNotice(document.getElementById('dt-ref-note'));
    const load = async () => {
      const [queue, appts, open] = await Promise.all([api.get('/api/fd/queue' + qs({ servicePoint: 'doctor', mine: true })), api.get('/api/doc/appointments' + qs({ date: MC.todayISO() })), api.get('/api/doc/encounters?status=open&limit=20')]);
      const pids = [...new Set(queue.map(q => q.patientId).concat(appts.map(a => a.patientId)))];
      await Promise.all(pids.map(allergiesOf));
      if (!box.isConnected) return;
      dq = { queue, appts };
      const waiting = queue.filter(q => q.status !== 'in_service' || !q.encounterId);
      const activeAppts = appts.filter(a => ['booked', 'checked_in', 'in_consult'].includes(a.status));
      MC.navCount('#/today', waiting.length);
      const sub = document.getElementById('dt-sub'); if (sub) sub.textContent = T('today.updated', 'Updated {t}. Refreshes every 15 seconds.', { t: time(Date.now()) });
      MC.view(html`${figures([{ value: waiting.length, label: T('today.waiting', 'Waiting for you') }, { value: activeAppts.length, label: T('today.appts', 'Appointments left today') }, { value: open.length, label: T('today.open', 'Open consultations'), tone: open.length > 3 ? 'warn' : '' }, { value: appts.filter(a => a.status === 'completed').length, label: T('today.done', 'Completed today') }])}
        ${open.length ? html`<section class="panel flush"><h2>${T('today.open', 'Open consultations')}</h2><div class="list">${open.map(e => html`<a href="#/consult/${e.id}" style="flex-wrap:wrap"><div class="grow" style="flex:1 1 220px"><span class="title">${e.patient.name}</span><span class="sub">${typeLabel(e.type)} | ${T('today.started', 'Started {t}', { t: dateTime(e.startedAt) })}</span></div>${badge(T('today.resume', 'Resume'), 'hue')}<span style="width:20px;height:20px;flex:none;display:inline-flex" aria-hidden="true">${icon('right')}</span></a>`)}</div></section>` : ''}
        <section class="panel flush"><h2>${T('today.queue', 'My queue')} <span class="muted sm">(${queue.length})</span></h2>
          ${queue.length ? html`<ul class="list">${queue.map(q => html`<li style="flex-wrap:wrap"><span class="badge outline plain"><b>${q.number}</b></span><div class="grow" style="flex:1 1 220px">${bandLine(q.patient, allergyCache[q.patientId])}
            <span class="sub">${pri(q.priority)} ${sb(q.status)} ${T('today.wait', 'Waiting {n} min', { n: q.waitMin })}${q.complaint ? ' | ' + q.complaint : ''}${q.doctorName ? '' : ' | ' + T('today.any', 'Any doctor')}</span>
            ${q.latestVitals ? html`<span class="sub">${vitalsLine(q.latestVitals)} ${(q.latestVitals.flags || []).map(f => badge(f.message, f.level === 'critical' ? 'bad' : 'warn'))}</span>` : ''}</div>
            <span class="end row wrap">${q.encounterId ? html`<a class="btn sm primary" href="#/consult/${q.encounterId}">${T('today.open_consult', 'Open consult')}</a>` : html`${q.status === 'waiting' ? html`<button class="btn sm" data-action="dq-call" data-id="${q.id}">${T('today.call', 'Call')}</button>` : ''}<button class="btn sm primary" data-action="dq-start" data-q="${q.id}">${T('today.start', 'Start consult')}</button>`}
              <a class="btn sm ghost" href="#/chart/${q.patientId}">${T('today.chart', 'Chart')}</a></span></li>`)}</ul>`
            : empty({ icon: 'users', title: T('today.no_queue', 'Nobody is waiting for you'), body: T('today.no_queue_sub', 'Patients checked in for you or for any doctor appear here.') })}</section>
        <section class="panel flush"><h2>${T('today.appts_t', 'Appointments today')} <span class="muted sm">(${appts.length})</span></h2>
          ${appts.length ? html`<ul class="list">${appts.map(a => html`<li style="flex-wrap:wrap"><span class="badge outline plain"><b>${a.time}</b></span><div class="grow" style="flex:1 1 220px">${bandLine(a.patient, allergyCache[a.patientId])}
            <span class="sub">${a.type === 'video' ? badge(T('appt.video', 'Video'), 'info') : badge(T('appt.in_person', 'In person'), 'outline')} ${sb(a.status)} ${a.paid ? badge(T('appt.paid', 'Paid'), 'ok') : badge(T('appt.unpaid', 'Not paid'), 'warn')}${a.reason ? ' | ' + a.reason : ''}</span></div>
            <span class="end row wrap">${apptActions(a)}</span></li>`)}</ul>`
            : empty({ icon: 'calendar', title: T('today.no_appts', 'No appointments today'), body: T('today.no_appts_sub', 'Bookings from patients and the front desk appear here.'), action: html`<a class="btn" href="#/schedule">${T('today.set_schedule', 'Set your schedule')}</a>` })}</section>`, box);
    };
    await load(); MC.poll(load, 15000);
  }
  let dq = { queue: [], appts: [] };
  function vitalsLine(v) { const p = []; if (v.bpSys != null) p.push('BP ' + v.bpSys + '/' + v.bpDia); if (v.pulse != null) p.push(T('vitals.pulse_s', 'Pulse {n}', { n: v.pulse })); if (v.tempC != null) p.push(v.tempC + ' °C'); if (v.spo2 != null) p.push('SpO2 ' + v.spo2 + '%'); if (v.weightKg != null) p.push(v.weightKg + ' kg'); return p.join(' | '); }
  function apptActions(a) {
    if (a.encounterId && a.status === 'in_consult') return html`${a.type === 'video' && MC.feature('videoVisits') ? html`<a class="btn sm" href="#/video/${a.id}">${icon('video')}${T('appt.join', 'Join video')}</a>` : ''}<a class="btn sm primary" href="#/consult/${a.encounterId}">${T('today.open_consult', 'Open consult')}</a>`;
    if (!['booked', 'checked_in'].includes(a.status)) return a.encounterId ? html`<a class="btn sm ghost" href="#/consult/${a.encounterId}">${T('today.view', 'View')}</a>` : '';
    if (a.type === 'video') {
      if (!MC.feature('videoVisits')) return html`<span class="xs muted">${T('appt.video_off', 'Video visits are switched off')}</span>`;
      const w = a.videoWindow || {};
      return w.open ? html`<a class="btn sm primary" href="#/video/${a.id}">${icon('video')}${T('appt.join', 'Join video')}</a>` : html`<span class="xs muted">${Date.now() < (w.opensAt || 0) ? T('appt.opens', 'Room opens {t}', { t: time(w.opensAt) }) : T('appt.closed', 'Room closed')}</span>`;
    }
    return html`<button class="btn sm primary" data-action="dq-start" data-a="${a.id}">${T('today.start', 'Start consult')}</button>`;
  }
  on('dq-call', async el => { const r = await api.post('/api/fd/queue/' + el.dataset.id + '/call'); toast(T('today.called', '{n} called', { n: r.number }), 'ok'); MC.render(); });
  on('dq-start', async el => {
    const body = el.dataset.q ? { queueId: el.dataset.q } : { appointmentId: el.dataset.a };
    const e = await api.post('/api/doc/encounters', body);
    toast(T('today.started_t', 'Consultation started with {name}', { name: e.patient.name }), 'ok'); MC.go('#/consult/' + e.id);
  });

  /* ================= consultation ================= */
  let cx = null;
  let freqs = null;
  const getFreqs = async () => freqs || (freqs = await api.get('/api/clinical/frequencies'));
  const ROUTES = ['oral', 'iv', 'im', 'sc', 'topical', 'inhaled', 'rectal', 'vaginal', 'sublingual', 'ophthalmic', 'otic', 'nasal', 'other'];
  const routeLabel = r => T('route.' + r, { iv: 'IV', im: 'IM', sc: 'Subcutaneous' }[r] || cap(r));
  const NOTE = [['complaint', 'Presenting complaint'], ['history', 'History'], ['examination', 'Examination'], ['assessment', 'Assessment'], ['plan', 'Plan']];
  const VF = [['bpSys', 'Systolic BP', 50, 260, 1], ['bpDia', 'Diastolic BP', 30, 160, 1], ['pulse', 'Pulse', 20, 250, 1], ['tempC', 'Temp (°C)', 30, 45, 0.1], ['spo2', 'SpO2 (%)', 50, 100, 1], ['rr', 'Breathing rate', 4, 80, 1], ['weightKg', 'Weight (kg)', 0.3, 400, 0.1], ['heightCm', 'Height (cm)', 20, 250, 0.1], ['glucose', 'Glucose (mmol/L)', 0.5, 40, 0.1]];
  function checkVitals(d) {
    const details = []; let any = false;
    for (const f of VF) { const v = d[f[0]]; if (v === undefined) continue; any = true; if (Number.isNaN(v) || v < f[2] || v > f[3]) details.push({ field: f[0], error: T('vitals.range', 'Must be between {min} and {max}', { min: f[2], max: f[3] }) }); else if (f[4] === 1 && !Number.isInteger(v)) details.push({ field: f[0], error: T('vitals.whole', 'Enter a whole number') }); }
    if (!any) throw err400(T('vitals.none', 'Enter at least one measurement'));
    if ((d.bpSys === undefined) !== (d.bpDia === undefined)) details.push({ field: d.bpSys === undefined ? 'bpSys' : 'bpDia', error: T('vitals.bp_both', 'Enter both systolic and diastolic pressure') });
    else if (d.bpSys !== undefined && d.bpDia >= d.bpSys) details.push({ field: 'bpDia', error: T('vitals.bp_order', 'Diastolic must be lower than systolic') });
    if (details.length) throw err400(T('vitals.fix', 'Check the highlighted measurements'), details);
  }
  const bandPatient = chart => Object.assign({}, chart.patient, { noKnownAllergies: chart.noKnownAllergies, allergies: chart.allergies });

  async function consult({ params, stale }) {
    let enc;
    try { enc = await api.get('/api/doc/encounters/' + params.id); } catch (e) { if (e.status === 404) return view(empty({ icon: 'steth', title: T('cx.not_found', 'Consultation not found'), action: html`<a class="btn" href="#/today">${T('nav.today', 'Today')}</a>` })); throw e; }
    const [chart, fq] = await Promise.all([api.get('/api/doc/patients/' + enc.patientId + '/chart'), getFreqs()]);
    if (stale()) return;
    const editable = enc.own && enc.status === 'open';
    cx = { enc, chart, editable, items: [], tests: [], dx: (enc.diagnoses || []).slice(), pick: null, alerts: [], orders: [] };
    const p = bandPatient(chart);
    const pharm = hasMod('pharmacy'), lab = hasMod('lab');
    const isF = p.sex === 'female';
    view(html`${back('#/today', T('nav.today', 'Today'))}${MC.wristband(p)}
      <div class="page-head"><div><h1>${T('cx.title', 'Consultation')}</h1><p>${typeLabel(enc.type)} | ${T('today.started', 'Started {t}', { t: dateTime(enc.startedAt) })} | ${sb(enc.status)}${!enc.own ? ' | ' + enc.doctorName : ''}</p></div>
        <div class="actions"><a class="btn" href="#/chart/${enc.patientId}">${icon('file')}${T('cx.chart', 'Full chart')}</a>${refOK() && MC.referrals.canSend() ? html`<button class="btn" data-action="doc-refer" data-p="${enc.patientId}">${icon('swap')}${T('cx.refer', 'Refer')}</button>` : ''}${editable ? html`<button class="btn primary" data-action="cx-complete">${icon('check')}${T('cx.complete', 'Complete consultation')}</button>` : ''}</div></div>
      ${!editable ? html`<div class="notice">${enc.status === 'completed' ? T('cx.completed', 'This consultation was completed {t}. It can no longer be changed.', { t: dateTime(enc.completedAt) }) : T('cx.not_own', 'This consultation belongs to {doc}. You can read it but not change it.', { doc: enc.doctorName })}</div>` : ''}
      ${chart.sharing && !chart.sharing.shareHistory ? html`<p class="muted sm">${chart.sharing.note}</p>` : ''}
      <div class="grid side-r"><div>
        <form class="panel" data-form="cx-notes" novalidate><h2>${T('cx.notes', 'Notes (SOAP)')}</h2>
          ${NOTE.map(([k, l]) => html`<div class="field"><label for="cn-${k}">${T('cx.n.' + k, l)}</label><textarea class="input" id="cn-${k}" name="${k}" maxlength="5000" ${editable ? '' : 'readonly'}>${(enc.notes || {})[k] || ''}</textarea></div>`)}
          <div class="fields two"><div class="field"><label for="cn-fd">${T('cx.follow_date', 'Follow-up date')}</label><input class="input" id="cn-fd" name="fuDate" type="date" min="${MC.todayISO()}" value="${(enc.followUp && enc.followUp.date) || ''}" ${editable ? '' : 'readonly'}></div>
          <div class="field"><label for="cn-fn">${T('cx.follow_note', 'Follow-up note')}</label><input class="input" id="cn-fn" name="fuNote" maxlength="300" value="${(enc.followUp && enc.followUp.note) || ''}" ${editable ? '' : 'readonly'}></div></div>
          <div class="form-err notice bad" hidden></div>${editable ? html`<button class="btn primary" type="submit">${T('cx.save_notes', 'Save notes')}</button>` : ''}</form>

        <section class="panel"><h2>${T('cx.dx', 'Diagnoses')}</h2><div id="cx-dx"></div>
          ${editable ? html`<div class="field" style="margin-top:12px"><label for="icd-q">${T('cx.dx_search', 'Search ICD-10 by code or words')}</label><div class="search">${icon('search')}<input class="input" id="icd-q" autocomplete="off" placeholder="${T('cx.dx_ph', 'e.g. I10, malaria, high bp')}"></div></div><div id="icd-res" aria-live="polite"></div>` : ''}</section>

        <section class="panel"><h2>${T('cx.rx', 'Prescription')}</h2>
          <div id="cx-rx-items"></div><div id="cx-alerts" aria-live="polite"></div>
          ${editable ? html`<form data-form="cx-item" novalidate class="stack"><h3>${T('cx.add_drug', 'Add a medicine')}</h3>
            <div class="field"><label for="drug-q">${T('cx.drug', 'Medicine')}</label><input class="input" id="drug-q" name="drugText" autocomplete="off" maxlength="120" placeholder="${T('cx.drug_ph', 'Search the formulary or type a name')}"><div class="hint" id="drug-pick">${T('cx.drug_hint', 'Pick from the list for full safety checks. Free text is allowed.')}</div><div id="drug-res"></div></div>
            <div class="fields three"><div class="field"><label for="it-mg">${T('cx.dose_mg', 'Dose (mg)')}</label><input class="input" id="it-mg" name="doseMg" type="number" min="0.001" step="any" inputmode="decimal"></div>
              <div class="field"><label for="it-dt">${T('cx.dose_text', 'Dose as given')}</label><input class="input" id="it-dt" name="doseText" maxlength="80" placeholder="${T('cx.dose_text_ph', 'e.g. 1 tablet')}"></div>
              <div class="field"><label for="it-f">${T('cx.freq', 'How often')}</label><select class="input" id="it-f" name="frequency">${fq.map(f => html`<option value="${f.key}" ${f.key === 'bd' ? 'selected' : ''}>${f.key.toUpperCase()}: ${f.label}</option>`)}</select></div></div>
            <div class="fields three"><div class="field"><label for="it-d">${T('cx.days', 'For how many days')}</label><input class="input" id="it-d" name="durationDays" type="number" min="1" max="365" inputmode="numeric"></div>
              <div class="field"><label for="it-q">${T('cx.qty', 'Quantity to dispense')}</label><input class="input" id="it-q" name="quantity" type="number" min="1" max="10000" inputmode="numeric"><div class="hint">${T('cx.qty_hint', 'Left empty, it is worked out from how often and how many days.')}</div></div>
              <div class="field"><label for="it-r">${T('cx.route', 'Route')}</label><select class="input" id="it-r" name="route">${ROUTES.map(r => html`<option value="${r}">${routeLabel(r)}</option>`)}</select></div></div>
            <div class="field"><label for="it-i">${T('cx.instr', 'Instructions for the patient')}</label><input class="input" id="it-i" name="instructions" maxlength="300" placeholder="${T('cx.instr_ph', 'e.g. After food')}"></div>
            <div class="form-err notice bad" hidden></div><button class="btn" type="submit">${icon('plus')}${T('cx.add_item', 'Add to prescription')}</button></form>
          <hr><div class="field"><span class="label">${T('cx.send_to', 'Where should it go?')}</span>
            ${pharm ? html`<label class="check"><input type="radio" name="rxSendTo" value="internal" checked><span>${T('cx.our_pharmacy', 'Send to our pharmacy')}</span></label>` : ''}
            <label class="check"><input type="radio" name="rxSendTo" value="patient_choice" ${pharm ? '' : 'checked'}><span>${T('cx.patient_choice', 'The patient chooses a pharmacy in the MediCore app')}</span></label></div>
          ${isF ? html`<label class="check"><input type="checkbox" id="rx-preg"><span>${T('cx.pregnant', 'The patient is pregnant')}</span></label>` : ''}
          <button class="btn primary" data-action="cx-send">${icon('pill')}${T('cx.send', 'Send prescription')}</button>` : ''}
          <div id="cx-rxs"></div></section>

        <section class="panel"><h2>${T('cx.lab', 'Lab tests')}</h2><div id="lab-sel"></div>
          ${editable ? html`<div class="field"><label for="lab-q">${T('cx.lab_search', 'Search tests')}</label><div class="search">${icon('search')}<input class="input" id="lab-q" autocomplete="off" placeholder="${T('cx.lab_ph', 'e.g. FBC, malaria, glucose')}"></div></div><div id="lab-res"></div>
            <div class="fields two"><div class="field"><label for="lab-p">${T('cx.lab_pri', 'Priority')}</label><select class="input" id="lab-p"><option value="routine">${T('pri.routine', 'Routine')}</option><option value="urgent">${T('pri.urgent', 'Urgent')}</option></select></div>
            <div class="field"><label for="lab-n">${T('cx.lab_note', 'Clinical note for the lab')}</label><input class="input" id="lab-n" maxlength="500"></div></div>
            <div class="field"><span class="label">${T('cx.lab_to', 'Which lab?')}</span>
              ${lab ? html`<label class="check"><input type="radio" name="labSendTo" value="internal" checked><span>${T('cx.our_lab', 'Our lab')}</span></label>` : ''}
              <label class="check"><input type="radio" name="labSendTo" value="patient_choice" ${lab ? '' : 'checked'}><span>${T('cx.lab_choice', 'The patient chooses a lab in the MediCore app')}</span></label></div>
            <button class="btn primary" data-action="cx-lab">${icon('flask')}${T('cx.lab_order', 'Order tests')}</button>` : ''}
          <div id="lab-orders">${(enc.labOrderIds || []).length ? html`<p class="muted sm">${T('cx.lab_count', '{n} lab order(s) made in this consultation', { n: enc.labOrderIds.length })}</p>` : ''}</div></section>
      </div>
      <aside>
        <section class="panel"><h2>${T('cx.vitals', 'Vitals')}</h2><div id="cx-vit"></div>
          ${editable ? html`<details><summary class="btn sm">${T('cx.record_vitals', 'Record vitals')}</summary><form data-form="cx-vitals" novalidate style="margin-top:12px">
            <div class="fields two">${VF.map(f => html`<div class="field"><label for="cv-${f[0]}">${T('vitals.f.' + f[0], f[1])}</label><input class="input" id="cv-${f[0]}" name="${f[0]}" type="number" inputmode="decimal" min="${f[2]}" max="${f[3]}" step="${f[4]}"></div>`)}</div>
            <div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${T('cx.save_vitals', 'Save vitals')}</button></form></details>` : ''}</section>
        <section class="panel"><h2>${T('cx.meds', 'Current medicines')}</h2>${chart.currentMedicines.length ? html`<ul class="list">${chart.currentMedicines.map(m => html`<li><div class="grow"><span class="title">${m.drugName}</span><span class="sub">${date(m.at)}</span></div></li>`)}</ul>` : html`<p class="muted sm">${T('cx.no_meds', 'No current medicines on record.')}</p>`}</section>
        <section class="panel"><h2>${T('chart.conditions', 'Conditions')}</h2>${chart.conditions.length ? html`<ul class="list">${chart.conditions.map(c => html`<li><div class="grow"><span class="title">${c.name}</span><span class="sub">${c.code || ''}</span></div></li>`)}</ul>` : html`<p class="muted sm">${T('chart.no_conditions', 'None recorded.')}</p>`}</section>
        <section class="panel"><h2>${T('cx.recent', 'Recent visits')}</h2>${chart.encounters.filter(e => e.id !== enc.id).length ? html`<ul class="list">${chart.encounters.filter(e => e.id !== enc.id).slice(0, 5).map(e => html`<li><div class="grow"><span class="title">${date(e.startedAt)} | ${e.doctorName}</span><span class="sub">${(e.diagnoses || []).map(d => d.code + ' ' + d.text).join('; ') || (e.notes || {}).complaint || ''}</span>${!e.own ? html`<span class="sub">${badge(T('chart.other', 'From {org}', { org: e.orgName }), 'info')}</span>` : ''}</div></li>`)}</ul>` : html`<p class="muted sm">${T('cx.first_visit', 'No earlier visits on record.')}</p>`}</section>
      </aside></div>`);
    renderDx(); renderItems(); renderRxs(enc.prescriptions || []); renderVit(enc.vitals || chart.vitals || []); renderTests();
  }
  function renderVit(list) {
    const box = document.getElementById('cx-vit'); if (!box) return;
    const v = list[0];
    MC.view(v ? html`<dl class="kv"><dt>${T('cx.when', 'Taken')}</dt><dd>${dateTime(v.at)}</dd>${v.bpSys != null ? html`<dt>BP</dt><dd>${v.bpSys}/${v.bpDia}</dd>` : ''}${v.pulse != null ? html`<dt>${T('vitals.pulse', 'Pulse')}</dt><dd>${v.pulse}</dd>` : ''}${v.tempC != null ? html`<dt>${T('vitals.temp', 'Temp')}</dt><dd>${v.tempC} °C</dd>` : ''}${v.spo2 != null ? html`<dt>SpO2</dt><dd>${v.spo2}%</dd>` : ''}${v.rr != null ? html`<dt>${T('vitals.rr', 'RR')}</dt><dd>${v.rr}</dd>` : ''}${v.weightKg != null ? html`<dt>${T('vitals.weight', 'Weight')}</dt><dd>${v.weightKg} kg</dd>` : ''}${v.glucose != null ? html`<dt>${T('vitals.glucose', 'Glucose')}</dt><dd>${v.glucose}</dd>` : ''}${v.bmi ? html`<dt>BMI</dt><dd>${v.bmi}</dd>` : ''}</dl>
      ${(v.flags || []).length ? html`<div class="row wrap" style="margin-top:8px">${v.flags.map(f => badge(f.message, f.level === 'critical' ? 'bad' : 'warn'))}</div>` : ''}` : html`<p class="muted sm">${T('cx.no_vitals', 'No vitals in the last 12 hours.')}</p>`, box);
  }
  form('cx-vitals', async (d, f) => {
    checkVitals(d);
    const v = await api.post('/api/doc/encounters/' + cx.enc.id + '/vitals', d);
    f.reset(); f.closest('details').open = false;
    renderVit([v]); toast((v.flags || []).length ? T('cx.vitals_flags', 'Vitals saved. Check: {f}', { f: v.flags.map(x => x.message).join('. ') }) : T('cx.vitals_saved', 'Vitals saved'), (v.flags || []).length ? undefined : 'ok');
  });
  const notesBody = d => ({ notes: Object.fromEntries(NOTE.map(([k]) => [k, d[k] || ''])), followUp: d.fuDate || d.fuNote ? { date: d.fuDate, note: d.fuNote } : undefined });
  form('cx-notes', async d => { const e = await api.patch('/api/doc/encounters/' + cx.enc.id, notesBody(d)); cx.enc = Object.assign(cx.enc, e); toast(T('cx.notes_saved', 'Notes saved'), 'ok'); });

  /* diagnoses */
  function renderDx() {
    const box = document.getElementById('cx-dx'); if (!box) return;
    MC.view(cx.dx.length ? html`<ul class="list">${cx.dx.map((d, i) => html`<li><div class="grow"><span class="title">${d.code} ${d.text}</span>${d.primary ? html`<span class="sub">${badge(T('cx.primary', 'Primary'), 'hue')}</span>` : ''}</div>
      ${cx.editable ? html`<span class="end row">${!d.primary ? html`<button class="btn sm ghost" data-action="dx-primary" data-i="${i}">${T('cx.make_primary', 'Make primary')}</button>` : ''}<button class="icon-btn" data-action="dx-rm" data-i="${i}" aria-label="${T('cx.dx_rm', 'Remove {code}', { code: d.code })}">${icon('trash')}</button></span>` : ''}</li>`)}</ul>`
      : html`<p class="muted sm">${T('cx.no_dx', 'No diagnosis yet. Add at least one, or write an assessment, before completing.')}</p>`, box);
  }
  async function saveDx(msg) {
    const e = await api.patch('/api/doc/encounters/' + cx.enc.id, { diagnoses: cx.dx.map(d => ({ code: d.code, text: d.text, primary: !!d.primary })) });
    cx.dx = e.diagnoses.slice(); renderDx(); toast(msg, 'ok');
  }
  const icdSearch = debounce(async q => {
    const box = document.getElementById('icd-res'); if (!box) return;
    if (!q.trim()) { MC.view('', box); return; }
    const rows = await api.get('/api/clinical/icd10' + qs({ q, limit: 8 })).catch(() => []);
    if (!box.isConnected) return;
    MC.view(rows.length ? html`<ul class="list">${rows.map(r => html`<li><div class="grow"><span class="title">${r.code} ${r.text}</span><span class="sub">${r.group || ''}</span></div><button class="btn sm" data-action="dx-add" data-code="${r.code}" data-text="${r.text}">${icon('plus')}${T('cx.add', 'Add')}</button></li>`)}</ul>` : html`<p class="muted sm">${T('cx.dx_none', 'No match. Try another word or the code.')}</p>`, box);
  }, 250);
  on('dx-add', async el => {
    if (cx.dx.some(d => d.code === el.dataset.code)) return toast(T('cx.dx_dup', 'Already added'));
    cx.dx.push({ code: el.dataset.code, text: el.dataset.text, primary: !cx.dx.length });
    await saveDx(T('cx.dx_added', '{code} added', { code: el.dataset.code }));
    const q = document.getElementById('icd-q'); if (q) q.value = ''; MC.view('', document.getElementById('icd-res'));
  });
  on('dx-rm', async el => { const [d] = cx.dx.splice(Number(el.dataset.i), 1); if (d && d.primary && cx.dx[0]) cx.dx[0].primary = true; await saveDx(T('cx.dx_removed', '{code} removed', { code: d.code })); });
  on('dx-primary', async el => { cx.dx.forEach((d, i) => { d.primary = i === Number(el.dataset.i); }); await saveDx(T('cx.dx_primary', 'Primary diagnosis changed')); });

  /* prescribing */
  const drugSearch = debounce(async q => {
    const box = document.getElementById('drug-res'); if (!box) return;
    if (!q.trim() || (cx.pick && cx.pick.name === q)) { MC.view('', box); return; }
    const rows = await api.get('/api/clinical/drugs' + qs({ q, limit: 8 })).catch(() => []);
    if (!box.isConnected) return;
    MC.view(rows.length ? html`<ul class="list" role="listbox" aria-label="${T('cx.drug_results', 'Formulary matches')}">${rows.map(r => html`<li class="click" data-action="drug-pick" data-code="${r.code}" role="option" tabindex="0"><div class="grow"><span class="title">${r.name}</span><span class="sub">${r.code} | ${(r.classes || []).join(', ')}${r.controlled ? ' | ' + T('cx.controlled', 'Controlled') : ''}</span></div></li>`)}</ul>`
      : html`<p class="muted sm">${T('cx.drug_free', 'Not in the formulary. You can still prescribe it by name; safety checks will be limited.')}</p>`, box);
    drugRows = rows;
  }, 250);
  let drugRows = [];
  on('drug-pick', el => {
    const d = drugRows.find(x => x.code === el.dataset.code); if (!d) return;
    cx.pick = d; const q = document.getElementById('drug-q'); q.value = d.name;
    const mg = document.getElementById('it-mg'); if (d.unitMg && !mg.value) mg.value = d.unitMg;
    const hint = document.getElementById('drug-pick'); if (hint) hint.textContent = T('cx.picked', 'From the formulary: {code}', { code: d.code });
    MC.view('', document.getElementById('drug-res')); document.getElementById('it-dt').focus();
  });
  document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.matches && e.target.matches('li[data-action="drug-pick"]')) { e.preventDefault(); e.target.click(); } });
  document.addEventListener('input', e => {
    const id = e.target && e.target.id;
    if (id === 'icd-q') icdSearch(e.target.value);
    if (id === 'drug-q') { if (cx && cx.pick && cx.pick.name !== e.target.value) { cx.pick = null; const h = document.getElementById('drug-pick'); if (h) h.textContent = T('cx.drug_hint', 'Pick from the list for full safety checks. Free text is allowed.'); } drugSearch(e.target.value); }
    if (id === 'lab-q') labSearch(e.target.value);
  });
  const itemName = it => it.drugName || (it._name) || it.drugCode;
  form('cx-item', async (d, f) => {
    const details = [];
    const text = (d.drugText || '').trim();
    if (!text) details.push({ field: 'drugText', error: T('cx.need_drug', 'Choose or type the medicine') });
    if (!d.doseText) details.push({ field: 'doseText', error: T('cx.need_dose', 'Write the dose, e.g. 1 tablet') });
    if (!d.durationDays || d.durationDays < 1 || d.durationDays > 365 || !Number.isInteger(d.durationDays)) details.push({ field: 'durationDays', error: T('cx.need_days', 'Between 1 and 365 days') });
    const fr = (freqs || []).find(x => x.key === d.frequency);
    let qty = d.quantity;
    if (qty === undefined && fr && fr.perDay && d.durationDays) qty = Math.max(1, Math.ceil(fr.perDay * d.durationDays));
    if (!qty || qty < 1 || !Number.isInteger(qty)) details.push({ field: 'quantity', error: T('cx.need_qty', 'Enter the quantity to dispense') });
    if (d.doseMg !== undefined && !(d.doseMg > 0)) details.push({ field: 'doseMg', error: T('cx.bad_mg', 'Dose must be more than 0 mg') });
    if (details.length) throw err400(T('cx.fix_item', 'Check the highlighted fields'), details);
    const it = { doseMg: d.doseMg, doseText: d.doseText, frequency: d.frequency, durationDays: d.durationDays, quantity: qty, route: d.route, instructions: d.instructions };
    if (cx.pick && cx.pick.name === text) { it.drugCode = cx.pick.code; it._name = cx.pick.name; } else it.drugName = text;
    cx.items.push(it); cx.pick = null; f.reset();
    const h = document.getElementById('drug-pick'); if (h) h.textContent = T('cx.drug_hint', 'Pick from the list for full safety checks. Free text is allowed.');
    renderItems(); toast(T('cx.item_added', '{name} added. Checking safety...', { name: itemName(it) }));
    await runCheck();
    document.getElementById('drug-q').focus();
  });
  const apiItem = it => { const o = Object.assign({}, it); delete o._name; Object.keys(o).forEach(k => o[k] === undefined && delete o[k]); return o; };
  const pregnant = () => { const c = document.getElementById('rx-preg'); return !!(c && c.checked); };
  async function runCheck() {
    const box = document.getElementById('cx-alerts'); if (!box) return;
    if (!cx.items.length) { cx.alerts = []; MC.view('', box); return; }
    const r = await api.post('/api/doc/safety-check', { patientId: cx.enc.patientId, items: cx.items.map(apiItem), pregnant: pregnant() });
    cx.alerts = r.alerts;
    MC.view(r.alerts.length ? html`${r.blocking ? html`<div class="notice bad"><b>${T('cx.blocking', 'Serious safety alerts. Change the prescription, or give an override reason when you send it.')}</b></div>` : ''}${MC.alerts(r.alerts)}` : html`<div class="notice ok">${T('cx.no_alerts', 'No safety alerts for these medicines.')}</div>`, box);
  }
  document.addEventListener('change', e => { if (e.target && e.target.id === 'rx-preg' && cx && cx.items.length) runCheck().catch(MC.showError); });
  function renderItems() {
    const box = document.getElementById('cx-rx-items'); if (!box) return;
    const fl = k => { const f = (freqs || []).find(x => x.key === k); return f ? f.label : k; };
    MC.view(cx.items.length ? html`<ul class="list">${cx.items.map((it, i) => html`<li><div class="grow"><span class="title">${itemName(it)}${it.drugCode ? '' : html` ${badge(T('cx.free_text', 'Not in formulary'), 'warn')}`}</span>
      <span class="sub">${it.doseText}${it.doseMg ? ' (' + it.doseMg + ' mg)' : ''}, ${fl(it.frequency)}, ${T('cx.for_days', 'for {n} days', { n: it.durationDays })} | ${routeLabel(it.route || 'oral')} | ${T('cx.qty_n', 'Qty {n}', { n: it.quantity })}${it.instructions ? ' | ' + it.instructions : ''}</span></div>
      <button class="icon-btn" data-action="rx-rm" data-i="${i}" aria-label="${T('cx.rm_item', 'Remove {name}', { name: itemName(it) })}">${icon('trash')}</button></li>`)}</ul>` : (cx.editable ? html`<p class="muted sm">${T('cx.no_items', 'No medicines added yet.')}</p>` : ''), box);
  }
  on('rx-rm', async el => { cx.items.splice(Number(el.dataset.i), 1); renderItems(); await runCheck(); });
  function renderRxs(list) {
    const box = document.getElementById('cx-rxs'); if (!box) return;
    MC.view(list.length ? html`<h3 style="margin-top:16px">${T('cx.rx_made', 'Prescriptions in this consultation')}</h3><ul class="list">${list.map(r => html`<li><div class="grow"><span class="title">${r.items.map(i => i.drugName).join(', ')}</span>
      <span class="sub">${sb(r.status)} ${r.routedTo ? T('cx.routed', 'Sent to the pharmacy') : r.status === 'active' ? T('cx.patient_picks', 'Waiting for the patient to choose a pharmacy') : ''}${r.safety && r.safety.overrideReason ? ' | ' + T('cx.override_was', 'Override: {r}', { r: r.safety.overrideReason }) : ''}</span></div>
      ${cx.editable && r.status === 'active' && !r.routedTo ? html`<button class="btn sm ghost" data-action="rx-cancel" data-id="${r.id}">${T('cx.rx_cancel', 'Cancel')}</button>` : ''}</li>`)}</ul>` : '', box);
  }
  async function refreshRxs() { const e = await api.get('/api/doc/encounters/' + cx.enc.id); renderRxs(e.prescriptions || []); }
  on('rx-cancel', async el => {
    const v = await dialog({ title: T('cx.rx_cancel_t', 'Cancel this prescription?'), form: true, body: html`<p>${T('cx.rx_cancel_b', 'The patient will no longer be able to send it to a pharmacy.')}</p><div class="field"><label for="rc-r">${T('cx.reason', 'Reason')}</label><input class="input" id="rc-r" name="reason" minlength="3" maxlength="300" required></div>`,
      actions: [{ label: T('cx.keep', 'Keep it'), value: null }, { label: T('cx.rx_cancel_ok', 'Cancel prescription'), primary: true, danger: true }],
      onSubmit: d => { if (!d.reason || d.reason.length < 3) throw err400(T('cx.need_reason3', 'Give a reason of at least 3 characters')); return api.post('/api/doc/prescriptions/' + el.dataset.id + '/cancel', { reason: d.reason }); } });
    if (v) { toast(T('cx.rx_cancelled', 'Prescription cancelled'), 'ok'); await refreshRxs(); }
  });
  on('cx-send', async () => {
    if (!cx.items.length) return toast(T('cx.need_items', 'Add at least one medicine first'), 'bad');
    const sel = document.querySelector('input[name="rxSendTo"]:checked'); const sendTo = sel ? sel.value : 'patient_choice';
    const body = { items: cx.items.map(apiItem), sendTo, pregnant: pregnant() };
    const url = '/api/doc/encounters/' + cx.enc.id + '/prescriptions';
    if (!(await confirm({ title: T('cx.send_q', 'Send this prescription?'), body: sendTo === 'internal' ? T('cx.send_int', '{n} medicine(s) will go to your pharmacy for {name}.', { n: cx.items.length, name: cx.chart.patient.name }) : T('cx.send_pc', '{n} medicine(s) will be saved for {name}, who chooses a pharmacy in the app.', { n: cx.items.length, name: cx.chart.patient.name }), ok: T('cx.send', 'Send prescription') }))) return;
    let r;
    try { r = await api.post(url, body); }
    catch (e) {
      if (!(e.status === 409 && e.code === 'safety_alerts')) throw e;
      const alerts = (e.details && e.details.alerts) || [];
      MC.view(html`<div class="notice bad"><b>${T('cx.blocked', 'Blocked by safety alerts')}</b></div>${MC.alerts(alerts)}`, document.getElementById('cx-alerts'));
      r = await dialog({ title: T('cx.override_t', 'Safety alerts need your decision'), form: true, wide: true,
        body: html`${MC.alerts(alerts)}<p>${T('cx.override_b', 'To prescribe anyway, write why. The reason is stored with the prescription and shown to the pharmacist.')}</p>
          <div class="field"><label for="ov-r">${T('cx.override_reason', 'Override reason (at least 10 characters)')}</label><textarea class="input" id="ov-r" name="reason" minlength="10" maxlength="500" required></textarea></div>`,
        actions: [{ label: T('cx.change_rx', 'Change the prescription'), value: null }, { label: T('cx.override_ok', 'Override and send'), primary: true, danger: true }],
        onSubmit: d => { if (!d.reason || d.reason.trim().length < 10) throw err400(T('cx.need_override', 'The reason must be at least 10 characters'), [{ field: 'reason', error: T('cx.need_override', 'The reason must be at least 10 characters') }]); return api.post(url, Object.assign({}, body, { overrideReason: d.reason.trim() })); } });
      if (!r) return;
    }
    const rt = r.routing || {};
    if (rt.sentTo) toast(T('cx.sent_pharm', 'Prescription sent to the pharmacy'), 'ok');
    else if (sendTo === 'internal') toast(rt.error || T('cx.sent_fallback', 'Saved. The pharmacy could not take it, so the patient will choose a pharmacy in the app.'), undefined, 8000);
    else toast(T('cx.sent_pc', 'Prescription saved. The patient will choose a pharmacy.'), 'ok');
    cx.items = []; renderItems(); MC.view('', document.getElementById('cx-alerts')); await refreshRxs();
  });

  /* lab orders */
  const labSearch = debounce(async q => {
    const box = document.getElementById('lab-res'); if (!box) return;
    if (!q.trim()) { MC.view('', box); return; }
    const rows = await api.get('/api/clinical/labtests' + qs({ q, limit: 8 })).catch(() => []);
    if (!box.isConnected) return;
    MC.view(rows.length ? html`<ul class="list">${rows.map(r => html`<li><div class="grow"><span class="title">${r.code} ${r.name}</span><span class="sub">${r.specimen || ''}${r.tatHours ? ' | ' + T('cx.tat', 'about {n} h', { n: r.tatHours }) : ''}</span></div><button class="btn sm" data-action="lab-add" data-code="${r.code}" data-name="${r.name}">${icon('plus')}${T('cx.add', 'Add')}</button></li>`)}</ul>` : html`<p class="muted sm">${T('cx.lab_none', 'No test matches.')}</p>`, box);
  }, 250);
  function renderTests() {
    const box = document.getElementById('lab-sel'); if (!box) return;
    MC.view(cx.tests.length ? html`<ul class="list">${cx.tests.map((t, i) => html`<li><div class="grow"><span class="title">${t.code} ${t.name}</span></div><button class="icon-btn" data-action="lab-rm" data-i="${i}" aria-label="${T('cx.rm_item', 'Remove {name}', { name: t.name })}">${icon('trash')}</button></li>`)}</ul>` : '', box);
  }
  on('lab-add', el => { if (!cx.tests.some(t => t.code === el.dataset.code)) cx.tests.push({ code: el.dataset.code, name: el.dataset.name }); renderTests(); const q = document.getElementById('lab-q'); if (q) q.value = ''; MC.view('', document.getElementById('lab-res')); });
  on('lab-rm', el => { cx.tests.splice(Number(el.dataset.i), 1); renderTests(); });
  on('cx-lab', async () => {
    if (!cx.tests.length) return toast(T('cx.need_tests', 'Add at least one test first'), 'bad');
    const sel = document.querySelector('input[name="labSendTo"]:checked');
    const body = { tests: cx.tests.map(t => ({ code: t.code })), priority: document.getElementById('lab-p').value, clinicalNote: document.getElementById('lab-n').value.trim() || undefined, sendTo: sel ? sel.value : 'patient_choice' };
    const r = await api.post('/api/doc/encounters/' + cx.enc.id + '/lab-orders', body);
    cx.orders.push({ number: (r.order && r.order.number) || '', tests: cx.tests.slice(), internal: r.routedInternally });
    cx.tests = []; renderTests(); document.getElementById('lab-n').value = '';
    MC.view(html`<ul class="list">${cx.orders.map(o => html`<li><div class="grow"><span class="title">${o.number} ${o.tests.map(t => t.code).join(', ')}</span><span class="sub">${o.internal ? T('cx.lab_ours', 'Sent to our lab') : T('cx.lab_patient', 'The patient chooses a lab')}</span></div></li>`)}</ul>${r.note ? html`<p class="muted sm">${r.note}</p>` : ''}`, document.getElementById('lab-orders'));
    toast(r.routedInternally ? T('cx.lab_sent', 'Tests sent to the lab') : T('cx.lab_saved', 'Tests ordered. The patient will choose a lab.'), 'ok');
  });

  on('cx-complete', async () => {
    const f = document.querySelector('form[data-form="cx-notes"]'); const d = MC.formData(f);
    if (!cx.dx.length && !(d.assessment || '').trim()) return toast(T('cx.need_dx', 'Add a diagnosis or write an assessment before completing'), 'bad');
    const warn = cx.items.length ? ' ' + T('cx.unsent', 'The {n} medicine(s) you have not sent will be discarded.', { n: cx.items.length }) : '';
    if (!(await confirm({ title: T('cx.complete_q', 'Complete this consultation?'), body: T('cx.complete_b', 'Notes and diagnoses for {name} are saved and locked, and the patient gets their visit summary.', { name: cx.chart.patient.name }) + warn, ok: T('cx.complete', 'Complete consultation') }))) return;
    await api.post('/api/doc/encounters/' + cx.enc.id + '/complete', Object.assign(notesBody(d), { diagnoses: cx.dx.map(x => ({ code: x.code, text: x.text, primary: !!x.primary })) }));
    toast(T('cx.completed_t', 'Consultation completed'), 'ok'); MC.go('#/today');
  });

  /* ================= patients and chart ================= */
  async function patients({ query }) {
    const rows = await api.get('/api/fd/patients' + qs({ q: query.q, limit: query.q ? 50 : 20 }));
    view(html`<div class="page-head"><div><h1>${T('pts.title', 'Patients')}</h1><p>${T('pts.sub', 'Patients linked to your provider')}</p></div></div>
      <form class="panel" data-form="pts-search" novalidate><div class="field search"><label class="sr-only" for="pq">${T('pts.label', 'Name, phone or MRN')}</label>${icon('search')}<input class="input" id="pq" name="q" value="${query.q || ''}" placeholder="${T('pts.label', 'Name, phone or MRN')}"></div><button class="btn" type="submit">${T('pts.search', 'Search')}</button></form>
      ${rows.length ? html`<div class="list">${rows.map(p => html`<a href="#/chart/${p.id}"><div class="grow"><span class="title">${p.name}</span><span class="sub">${[p.mrn, ageSex(p)].filter(Boolean).join(' | ')}</span></div>${p.allergies.length ? html`<span class="allergy-tag">${icon('alert')}${p.allergies.map(a => a.substance).join(', ')}</span>` : ''}<span style="width:20px;height:20px;flex:none;display:inline-flex" aria-hidden="true">${icon('right')}</span></a>`)}</div>`
        : empty({ icon: 'users', title: T('pts.none', 'No patient matches'), body: T('pts.none_sub', 'Only patients linked to your provider can be found.') })}`);
  }
  form('pts-search', d => MC.go('#/patients' + qs({ q: d.q })));
  const flagCls = f => (f === 'critical' ? 'flag-critical' : f === 'high' ? 'flag-high' : f === 'low' ? 'flag-low' : f === 'abnormal' ? 'flag-abnormal' : f === 'unverified' ? 'flag-unverified' : '');
  let chartCur = null;
  async function chartPage({ params }) {
    let c;
    try { c = await api.get('/api/doc/patients/' + params.id + '/chart'); } catch (e) { if (e.status === 404) return view(empty({ icon: 'user', title: T('chart.not_found', 'Patient not found'), body: T('chart.not_found_sub', 'This patient is not linked to your provider.') })); throw e; }
    chartCur = c;
    const p = c.patient; const vit = c.vitals || [];
    const maxSys = Math.max(1, ...vit.map(v => v.bpSys || 0));
    view(html`${back('#/patients', T('pts.title', 'Patients'))}${MC.wristband(bandPatient(c))}
      <div class="page-head"><div><h1>${p.name}</h1><p>${[p.mrn ? 'MRN ' + p.mrn : '', ageSex(p), p.phone].filter(Boolean).join(' | ')}</p></div><div class="actions"><button class="btn" data-action="msg-start" data-p="${p.id}" data-name="${p.name}">${icon('message')}${T('chart.message', 'Message patient')}</button>${refOK() && MC.referrals.canSend() ? html`<button class="btn" data-action="doc-refer" data-p="${p.id}">${icon('swap')}${T('chart.refer', 'Refer to another provider')}</button>` : ''}${MC.caretools.actions(p)}</div></div>
      <div class="notice">${c.sharing.note}</div>
      <div class="grid two">
        <section class="panel"><h2>${T('chart.demo', 'Demographics')}</h2><dl class="kv"><dt>${T('chart.dob', 'Date of birth')}</dt><dd>${p.dob || '-'}</dd><dt>${T('chart.blood', 'Blood group')}</dt><dd>${p.bloodGroup || '-'}</dd><dt>${T('chart.geno', 'Genotype')}</dt><dd>${p.genotype || '-'}</dd><dt>${T('vitals.weight', 'Weight')}</dt><dd>${p.weightKg ? p.weightKg + ' kg' : '-'}</dd><dt>${T('chart.address', 'Address')}</dt><dd>${p.address || '-'}</dd><dt>${T('chart.nok', 'Next of kin')}</dt><dd>${p.nokName ? p.nokName + (p.nokPhone ? ', ' + p.nokPhone : '') : '-'}</dd></dl></section>
        <section class="panel"><h2>${T('chart.allergies', 'Allergies')}</h2>${c.allergies.length ? html`<ul class="list">${c.allergies.map(a => html`<li><div class="grow"><span class="title">${a.substance}</span><span class="sub">${[a.reaction, T('sev.' + (a.severity || 'unknown'), cap(a.severity || 'unknown')), a.class].filter(Boolean).join(' | ')}</span></div></li>`)}</ul>` : html`<p>${c.noKnownAllergies ? T('chart.nka', 'No known allergies (confirmed).') : T('chart.allergy_unknown', 'Allergy status not recorded. Ask the patient.')}</p>`}
          <h3>${T('chart.conditions', 'Conditions')}</h3>${c.conditions.length ? html`<ul class="list">${c.conditions.map(x => html`<li><div class="grow"><span class="title">${x.name}</span><span class="sub">${x.code || ''}</span></div></li>`)}</ul>` : html`<p class="muted sm">${T('chart.no_conditions', 'None recorded.')}</p>`}
          <h3>${T('cx.meds', 'Current medicines')}</h3>${c.currentMedicines.length ? html`<ul class="list">${c.currentMedicines.map(m => html`<li><div class="grow"><span class="title">${m.drugName}</span><span class="sub">${date(m.at)}</span></div></li>`)}</ul>` : html`<p class="muted sm">${T('cx.no_meds', 'No current medicines on record.')}</p>`}</section>
      </div>
      <section class="panel"><h2>${T('chart.vitals', 'Vitals trend')}</h2>${vit.length ? html`
        <div class="bars" aria-label="${T('chart.bp_trend', 'Systolic blood pressure, newest first')}">${vit.filter(v => v.bpSys != null).slice(0, 10).map(v => html`<div class="bar"><span>${date(v.at)}</span><div class="track"><div class="fill" style="width:${Math.round(v.bpSys / maxSys * 100)}%"></div></div><span class="v">${v.bpSys}/${v.bpDia}</span></div>`)}</div>
        <div class="table-wrap" style="margin-top:12px"><table class="t stack-sm"><thead><tr><th>${T('cx.when', 'Taken')}</th><th>BP</th><th>${T('vitals.pulse', 'Pulse')}</th><th>${T('vitals.temp', 'Temp')}</th><th>SpO2</th><th>${T('vitals.weight', 'Weight')}</th><th>${T('vitals.glucose', 'Glucose')}</th><th>${T('chart.flags', 'Flags')}</th></tr></thead><tbody>
          ${vit.slice(0, 20).map(v => html`<tr><td data-label="${T('cx.when', 'Taken')}">${dateTime(v.at)}</td><td data-label="BP">${v.bpSys != null ? v.bpSys + '/' + v.bpDia : '-'}</td><td data-label="${T('vitals.pulse', 'Pulse')}">${v.pulse ?? '-'}</td><td data-label="${T('vitals.temp', 'Temp')}">${v.tempC ?? '-'}</td><td data-label="SpO2">${v.spo2 ?? '-'}</td><td data-label="${T('vitals.weight', 'Weight')}">${v.weightKg ?? '-'}</td><td data-label="${T('vitals.glucose', 'Glucose')}">${v.glucose ?? '-'}</td><td data-label="${T('chart.flags', 'Flags')}">${(v.flags || []).map(f => badge(f.message, f.level === 'critical' ? 'bad' : 'warn'))}</td></tr>`)}</tbody></table></div>`
        : empty({ icon: 'pulse', title: T('chart.no_vitals', 'No vitals recorded') })}</section>
      <section class="panel flush"><h2>${T('chart.encounters', 'Consultations')}</h2>${c.encounters.length ? html`<div class="list">${c.encounters.map(e => html`<a href="${e.own ? '#/consult/' + e.id : '#/chart/' + p.id}"><div class="grow"><span class="title">${date(e.startedAt)} | ${e.doctorName} ${!e.own ? badge(T('chart.other', 'From {org}', { org: e.orgName }), 'info') : ''}</span><span class="sub">${(e.diagnoses || []).map(d => d.code + ' ' + d.text).join('; ') || (e.notes || {}).complaint || T('chart.no_dx', 'No diagnosis')}</span>${(e.notes || {}).plan ? html`<span class="sub">${T('cx.n.plan', 'Plan')}: ${e.notes.plan}</span>` : ''}</div>${sb(e.status)}</a>`)}</div>` : empty({ icon: 'steth', title: T('chart.no_enc', 'No consultations yet') })}</section>
      <section class="panel flush"><h2>${T('chart.rx', 'Prescriptions')}</h2>${c.prescriptions.length ? html`<ul class="list">${c.prescriptions.map(r => html`<li><div class="grow"><span class="title">${r.items.map(i => i.drugName + (i.doseText ? ' ' + i.doseText : '')).join(', ')}</span><span class="sub">${date(r.createdAt)} | ${r.prescriberName}${r.orgId !== MC.me.org.id ? ' | ' + T('chart.other', 'From {org}', { org: r.orgName }) : ''}</span></div>${sb(r.status)}</li>`)}</ul>` : empty({ icon: 'pill', title: T('chart.no_rx', 'No prescriptions') })}</section>
      <section class="panel"><h2>${T('chart.labs', 'Lab results')}</h2>${(c.labResults || []).length ? c.labResults.map(o => html`<div class="stack" style="margin-bottom:16px"><h3>${o.number} | ${o.lab ? o.lab.name : ''} | ${dateTime(o.releasedAt)} ${o.amended ? badge(T('chart.amended', 'Amended'), 'warn') : ''} ${o.critical && o.critical.has ? badge(T('chart.critical', 'Critical result'), 'bad') : ''}</h3>
        <div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('chart.test', 'Test')}</th><th>${T('chart.result', 'Result')}</th><th>${T('chart.range', 'Reference')}</th><th>${T('chart.flag', 'Flag')}</th></tr></thead><tbody>
          ${(o.results || []).map(r => html`<tr><td data-label="${T('chart.test', 'Test')}">${r.name}</td><td data-label="${T('chart.result', 'Result')}"><span class="${flagCls(r.critical ? 'critical' : r.flag)}">${r.value} ${r.unit || ''}</span></td><td data-label="${T('chart.range', 'Reference')}">${r.refRange || (r.range ? (r.range.low ?? '') + ' - ' + (r.range.high ?? '') : '')}</td><td data-label="${T('chart.flag', 'Flag')}">${r.critical ? html`<span class="flag-critical">${T('chart.f.critical', 'Critical')}</span>` : r.flag && r.flag !== 'normal' ? html`<span class="${flagCls(r.flag)}">${T('chart.f.' + r.flag, cap(r.flag))}</span>` : T('chart.f.normal', 'Normal')}</td></tr>`)}</tbody></table></div></div>`) : empty({ icon: 'flask', title: T('chart.no_labs', 'No released lab results') })}</section>
      <div class="grid two">${MC.caretools.panels(p)}</div>`);
    MC.caretools.load(p).catch(() => {});
  }

  /* ================= referrals ================= */
  const refOK = () => MC.feature('referralNetwork') && ((MC.me && MC.me.perms) || []).some(x => x === 'referral.send' || x === 'referral.receive');
  on('doc-refer', async el => {
    const pid = el.dataset.p; let patient = null;
    if (cx && cx.chart && cx.chart.patient && cx.chart.patient.id === pid) patient = bandPatient(cx.chart);
    else if (chartCur && chartCur.patient && chartCur.patient.id === pid) patient = bandPatient(chartCur);
    else { const c = await api.get('/api/doc/patients/' + pid + '/chart'); patient = bandPatient(c); }
    await MC.referrals.sendDialog({ patient });
  });

  /* ================= messages ================= */
  async function messages({ query }) {
    const st = query.status === 'closed' ? 'closed' : 'open';
    const r = await api.get('/api/msg/threads' + qs({ status: st }));
    MC.navCount('#/messages', st === 'open' ? r.unreadTotal : 0);
    view(html`<div class="page-head"><div><h1>${T('msg.title', 'Messages')}</h1><p>${T('msg.sub', 'Conversations with your patients')}</p></div></div>
      <div class="tabs" role="tablist"><a role="tab" href="#/messages" aria-selected="${st === 'open'}">${T('msg.open', 'Open')}</a><a role="tab" href="#/messages?status=closed" aria-selected="${st === 'closed'}">${T('msg.closed', 'Closed')}</a></div>
      ${r.threads.length ? html`<div class="list">${r.threads.map(t => html`<a href="#/thread/${t.id}"><div class="grow"><span class="title">${t.patientName} | ${t.subject}</span><span class="sub">${t.lastFrom === 'patient' ? T('msg.patient_said', 'Patient') + ': ' : ''}${t.lastPreview || ''}</span><span class="sub">${ago(t.lastAt)}</span></div>${t.unread ? html`<span class="badge bad">${T('msg.unread', '{n} new', { n: t.unread })}</span>` : ''}<span style="width:20px;height:20px;flex:none;display:inline-flex" aria-hidden="true">${icon('right')}</span></a>`)}</div>`
        : empty({ icon: 'message', title: T('msg.empty', 'No conversations'), body: T('msg.empty_sub', 'Messages from your patients appear here. Start one from a patient chart.') })}`);
  }
  on('msg-start', async el => {
    const v = await dialog({ title: T('msg.new_t', 'Message {name}', { name: el.dataset.name }), form: true, body: html`<div class="field"><label for="ms-s">${T('msg.subject', 'Subject')}</label><input class="input" id="ms-s" name="subject" minlength="2" maxlength="120" required></div><div class="field"><label for="ms-t">${T('msg.text', 'Message')}</label><textarea class="input" id="ms-t" name="text" maxlength="2000" required></textarea></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('msg.send', 'Send message'), primary: true }],
      onSubmit: d => { if (!d.subject || !d.text) throw err400(T('msg.need', 'Write a subject and a message')); return api.post('/api/msg/threads', { patientId: el.dataset.p, subject: d.subject, text: d.text }); } });
    if (v) { toast(T('msg.sent', 'Message sent'), 'ok'); MC.go('#/thread/' + v.thread.id); }
  });
  async function thread({ params }) {
    const r = await api.get('/api/msg/threads/' + params.id + '/messages');
    if (r.thread.unread) api.post('/api/msg/threads/' + params.id + '/read').catch(() => { });
    let last = r.messages.length ? r.messages[r.messages.length - 1].seq : 0;
    const th = r.thread;
    const msgItem = m => html`<li><time>${dateTime(m.at)} | ${m.from === 'patient' ? th.patientName : m.senderName}</time><span style="white-space:pre-wrap">${m.text}</span></li>`;
    view(html`${back('#/messages', T('msg.title', 'Messages'))}<div class="page-head"><div><h1>${th.subject}</h1><p>${th.patientName} | ${sb(th.status)}</p></div>
      <div class="actions"><a class="btn" href="#/chart/${th.patientId}">${icon('file')}${T('cx.chart', 'Full chart')}</a><button class="btn" data-action="th-toggle" data-id="${th.id}" data-to="${th.status === 'open' ? 'close' : 'reopen'}">${th.status === 'open' ? T('msg.close', 'Close conversation') : T('msg.reopen', 'Reopen')}</button></div></div>
      <section class="panel"><ol class="timeline" id="th-list">${r.messages.map(msgItem)}</ol></section>
      ${th.status === 'open' ? html`<form class="panel" data-form="th-reply" novalidate><div class="field"><label for="th-t">${T('msg.reply', 'Reply')}</label><textarea class="input" id="th-t" name="text" maxlength="2000" required></textarea><div class="hint">${T('msg.hint', 'Plain text. Do not give a diagnosis by message if the patient needs to be seen.')}</div></div><div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${T('msg.send_reply', 'Send reply')}</button></form>` : ''}`);
    const list = document.getElementById('th-list');
    const append = ms => { if (!ms.length) return; const tmp = document.createElement('ol'); MC.view(html`${ms.map(msgItem)}`, tmp); while (tmp.firstChild) list.appendChild(tmp.firstChild); last = ms[ms.length - 1].seq; };
    form('th-reply', async (d, f) => { if (!d.text) throw err400(T('msg.need_text', 'Write your reply first')); await api.post('/api/msg/threads/' + th.id + '/messages', { text: d.text }); f.reset(); const n = await api.get('/api/msg/threads/' + th.id + '/messages?after=' + last); append(n.messages); toast(T('msg.reply_sent', 'Reply sent'), 'ok'); });
    MC.poll(async () => { const n = await api.get('/api/msg/threads/' + th.id + '/messages?after=' + last); if (n.messages.length) { append(n.messages); api.post('/api/msg/threads/' + th.id + '/read').catch(() => { }); } }, 15000);
  }
  on('th-toggle', async el => { await api.post('/api/msg/threads/' + el.dataset.id + '/' + el.dataset.to); toast(el.dataset.to === 'close' ? T('msg.closed_t', 'Conversation closed') : T('msg.reopened', 'Conversation reopened'), 'ok'); MC.render(); });

  /* ================= video visit ================= */
  let call = null;
  function setVState(text, kind) { const el = document.getElementById('vc-state'); if (el) MC.view(badge(text, kind || 'info'), el); }
  function endCall(sendBye) {
    if (!call) return;
    const c = call; call = null;
    if (c.stopPoll) c.stopPoll();
    if (sendBye && c.apptId) api.post('/api/video/' + c.apptId + '/signal', { type: 'bye' }).catch(() => { });
    try { c.pc && c.pc.close(); } catch (e) { }
    if (c.stream) c.stream.getTracks().forEach(t => t.stop());
    const lv = document.getElementById('vc-local'), rv = document.getElementById('vc-remote'); if (lv) lv.srcObject = null; if (rv) rv.srcObject = null;
    syncButtons();
  }
  function syncButtons() {
    const inCall = !!call;
    const j = document.getElementById('vc-join'), e = document.getElementById('vc-end'), m = document.getElementById('vc-mute'), cam = document.getElementById('vc-cam');
    if (j) j.hidden = inCall; if (e) e.hidden = !inCall; if (m) m.hidden = !inCall || !call.stream || !call.stream.getAudioTracks().length; if (cam) cam.hidden = !inCall || !call.stream || !call.stream.getVideoTracks().length;
  }
  async function videoPage({ params }) {
    if (!MC.feature('videoVisits')) return view(empty({ icon: 'video', title: T('vc.off', 'Video visits are switched off'), body: T('vc.off_sub', 'MediCore has switched video visits off for now. Call the patient by phone instead.'), action: html`<a class="btn" href="#/today">${T('nav.today', 'Today')}</a>` }));
    let a;
    try { a = await api.get('/api/doc/appointments/' + params.id); } catch (e) { if (e.status === 404) return view(empty({ icon: 'video', title: T('vc.not_found', 'Video visit not found') })); throw e; }
    vcAppt = a;
    view(html`${back('#/today', T('nav.today', 'Today'))}<div class="page-head"><div><h1>${T('vc.title', 'Video visit with {name}', { name: a.patient.name })}</h1><p>${a.date} ${a.time} | ${a.reason || ''} <span id="vc-state" aria-live="polite">${badge(T('vc.ready', 'Not connected'), 'outline')}</span></p></div>
      <div class="actions">${a.encounterId ? html`<a class="btn" href="#/consult/${a.encounterId}">${T('today.open_consult', 'Open consult')}</a>` : html`<button class="btn" data-action="vc-encounter">${icon('file')}${T('vc.open_record', 'Open consultation record')}</button>`}</div></div>
      <div id="vc-msg"></div>
      <section class="panel" style="padding:8px"><div style="position:relative;background:#0b1a1c;border-radius:10px;overflow:hidden;aspect-ratio:16/9;max-height:70vh">
        <video id="vc-remote" autoplay playsinline style="width:100%;height:100%;object-fit:cover" aria-label="${T('vc.remote', 'Patient video')}"></video>
        <video id="vc-local" autoplay playsinline muted style="position:absolute;right:8px;bottom:8px;width:28%;max-width:200px;border-radius:8px;border:2px solid #fff;background:#223" aria-label="${T('vc.local', 'Your camera')}"></video></div>
        <div class="btn-row" style="justify-content:center">
          <button class="btn primary lg" id="vc-join" data-action="vc-join">${icon('video')}${T('vc.join', 'Start camera and call')}</button>
          <button class="btn lg" id="vc-mute" data-action="vc-mute" hidden aria-pressed="false">${T('vc.mute', 'Mute microphone')}</button>
          <button class="btn lg" id="vc-cam" data-action="vc-cam" hidden aria-pressed="false">${T('vc.cam_off', 'Turn camera off')}</button>
          <button class="btn danger lg" id="vc-end" data-action="vc-end" hidden>${icon('phone')}${T('vc.end', 'End call')}</button></div></section>
      <p class="muted sm">${T('vc.help', 'The patient joins from the MediCore app. If the video does not connect on a weak network, end the call and phone the patient.')}</p>
      ${MC.feature('wearables') && MC.caretools && a.patientId ? html`<section class="panel" id="vc-wear"><h2>${T('vc.wear', 'Health devices')}</h2>${MC.skeleton(1)}</section>` : ''}`);
    MC.onLeave(() => endCall(true));
    const wbox = document.getElementById('vc-wear'); if (wbox) MC.caretools.wearPanel(a.patientId, wbox, { poll: 10000 });
  }
  let vcAppt = null;
  const vMsg = (text, kind) => { const box = document.getElementById('vc-msg'); if (box) MC.view(text ? html`<div class="notice ${kind || ''}">${text}</div>` : '', box); };
  async function startCall(audioOnly) {
    const a = vcAppt; vMsg('');
    setVState(T('vc.joining', 'Joining...'));
    let j;
    try { j = await api.post('/api/video/' + a.id + '/join'); }
    catch (e) {
      const m = { payment_required: T('vc.unpaid', 'The patient has not paid for this visit yet. The room opens when the bill is paid.'), too_early: T('vc.too_early', 'The room opens 15 minutes before the appointment.'), window_closed: T('vc.window_closed', 'The time for this video visit has passed.'), visit_closed: T('vc.visit_closed', 'This visit is closed.'), feature_off: T('vc.off', 'Video visits are switched off') }[e.code];
      setVState(T('vc.ready', 'Not connected'), 'outline'); vMsg(m || e.message, 'warn'); return;
    }
    let stream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setVState(T('vc.ready', 'Not connected'), 'outline'); vMsg(T('vc.no_media', 'This browser cannot use a camera. Use an up-to-date Chrome or Firefox.'), 'bad'); return; }
    try { stream = await navigator.mediaDevices.getUserMedia(audioOnly ? { audio: true } : { audio: true, video: { width: { ideal: 640 }, height: { ideal: 360 } } }); }
    catch (e) {
      setVState(T('vc.ready', 'Not connected'), 'outline');
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      const box = document.getElementById('vc-msg');
      MC.view(html`<div class="notice bad"><b>${denied ? T('vc.denied', 'Camera and microphone are blocked') : T('vc.no_cam', 'No camera or microphone found')}</b><p>${denied ? T('vc.denied_b', 'Allow camera and microphone for this site in the browser address bar, then press the call button again.') : T('vc.no_cam_b', 'Connect a camera or headset, or try with audio only.')}</p>${!audioOnly ? html`<button class="btn sm" data-action="vc-audio">${T('vc.audio_only', 'Try with audio only')}</button>` : ''}</div>`, box);
      return;
    }
    const pc = new RTCPeerConnection({ iceServers: j.iceServers });
    call = { apptId: a.id, pc, stream, after: j.lastSeq || 0, pendingIce: [], remoteSet: false };
    document.getElementById('vc-local').srcObject = stream;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    pc.ontrack = ev => { const rv = document.getElementById('vc-remote'); if (rv && ev.streams[0]) rv.srcObject = ev.streams[0]; };
    pc.onicecandidate = ev => { if (ev.candidate && call && call.pc === pc) api.post('/api/video/' + a.id + '/signal', { type: 'ice', data: ev.candidate.toJSON() }).catch(() => { }); };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      const lbl = { new: T('vc.s.new', 'Waiting for the patient'), connecting: T('vc.s.connecting', 'Connecting...'), connected: T('vc.s.connected', 'Connected'), disconnected: T('vc.s.disconnected', 'Connection unstable'), failed: T('vc.s.failed', 'Connection failed'), closed: T('vc.s.closed', 'Call ended') }[s] || s;
      setVState(lbl, s === 'connected' ? 'ok' : s === 'failed' ? 'bad' : s === 'disconnected' ? 'warn' : 'info');
      if (s === 'failed') vMsg(T('vc.failed_b', 'The video could not connect. The network may block it. End the call and phone the patient.'), 'warn');
    };
    syncButtons();
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    await api.post('/api/video/' + a.id + '/signal', { type: 'offer', data: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    setVState(T('vc.s.new', 'Waiting for the patient'), 'info');
    call.stopPoll = MC.poll(async () => {
      if (!call || call.pc !== pc) return;
      const r = await api.get('/api/video/' + a.id + '/signals?after=' + call.after);
      for (const s of r.signals) {
        if (!call || call.pc !== pc) return;
        call.after = Math.max(call.after, s.seq);
        if (s.type === 'answer' && pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(s.data); call.remoteSet = true;
          for (const c of call.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => { });
        } else if (s.type === 'ice' && s.data) {
          if (call.remoteSet) await pc.addIceCandidate(s.data).catch(() => { }); else call.pendingIce.push(s.data);
        } else if (s.type === 'bye') {
          endCall(false); setVState(T('vc.s.left', 'The patient left the call'), 'warn'); vMsg(T('vc.left_b', 'Press the call button to call again.'));
          return;
        }
      }
    }, j.pollMs || 1500);
  }
  on('vc-join', () => startCall(false));
  on('vc-audio', () => startCall(true));
  on('vc-end', async () => { if (!(await confirm({ title: T('vc.end_q', 'End the call?'), body: T('vc.end_b', 'The patient will be disconnected. You can call again while the room is open.'), ok: T('vc.end', 'End call'), danger: true }))) return; endCall(true); setVState(T('vc.s.closed', 'Call ended'), 'outline'); });
  on('vc-mute', el => { if (!call) return; const t = call.stream.getAudioTracks()[0]; if (!t) return; t.enabled = !t.enabled; el.setAttribute('aria-pressed', String(!t.enabled)); el.textContent = t.enabled ? T('vc.mute', 'Mute microphone') : T('vc.unmute', 'Unmute microphone'); });
  on('vc-cam', el => { if (!call) return; const t = call.stream.getVideoTracks()[0]; if (!t) return; t.enabled = !t.enabled; el.setAttribute('aria-pressed', String(!t.enabled)); el.textContent = t.enabled ? T('vc.cam_off', 'Turn camera off') : T('vc.cam_on', 'Turn camera on'); });
  on('vc-encounter', async () => {
    if (call && !(await confirm({ title: T('vc.leave_q', 'Leave the call?'), body: T('vc.leave_b', 'Opening the record ends the video call. You can rejoin from Today.'), ok: T('vc.open_record', 'Open consultation record') }))) return;
    const e = await api.post('/api/doc/encounters', { appointmentId: vcAppt.id });
    MC.go('#/consult/' + e.id);
  });

  /* ================= schedule ================= */
  const DAYS = [1, 2, 3, 4, 5, 6, 0];
  const dayName = d => T('day.' + d, ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d]);
  async function schedule() {
    const s = await api.get('/api/doc/schedule');
    const byDay = {}; (s.weekly || []).forEach(w => { (byDay[w.dow] = byDay[w.dow] || []).push(w); });
    const video = MC.feature('videoVisits');
    view(html`<div class="page-head"><div><h1>${T('sch.title', 'Schedule')}</h1><p>${s.configured ? (s.acceptingBookings ? T('sch.on', 'Patients can book you.') : T('sch.paused', 'Bookings are paused.')) : T('sch.new', 'Set your working hours so patients and the front desk can book you.')}</p></div></div>
      <form data-form="sch-save" novalidate>
        <section class="panel"><h2>${T('sch.week', 'Weekly hours')}</h2><p class="muted sm">${T('sch.week_sub', 'Tick the days you work. Add a second window if you take a break.')}</p>
          ${DAYS.map(d => { const w = byDay[d] || []; return html`<div class="row wrap" style="border-top:1px solid var(--line-2);padding:8px 0">
            <label class="check" style="min-width:150px"><input type="checkbox" name="on_${d}" ${w.length ? 'checked' : ''}><span><b>${dayName(d)}</b></span></label>
            <div class="row wrap"><label class="sr-only" for="s1-${d}">${T('sch.start', '{day} start', { day: dayName(d) })}</label><input class="input" style="width:auto" id="s1-${d}" name="s1_${d}" type="time" value="${w[0] ? w[0].start : '09:00'}"><span>-</span><label class="sr-only" for="e1-${d}">${T('sch.end', '{day} end', { day: dayName(d) })}</label><input class="input" style="width:auto" id="e1-${d}" name="e1_${d}" type="time" value="${w[0] ? w[0].end : '17:00'}"></div>
            <div class="row wrap"><span class="muted sm">${T('sch.and', 'and')}</span><label class="sr-only" for="s2-${d}">${T('sch.start2', '{day} second start', { day: dayName(d) })}</label><input class="input" style="width:auto" id="s2-${d}" name="s2_${d}" type="time" value="${w[1] ? w[1].start : ''}"><span>-</span><label class="sr-only" for="e2-${d}">${T('sch.end2', '{day} second end', { day: dayName(d) })}</label><input class="input" style="width:auto" id="e2-${d}" name="e2_${d}" type="time" value="${w[1] ? w[1].end : ''}"></div></div>`; })}
        </section>
        <section class="panel"><h2>${T('sch.visits', 'Visits and fees')}</h2>
          <div class="fields three"><div class="field"><label for="sc-sl">${T('sch.slot', 'Slot length')}</label><select class="input" id="sc-sl" name="slotMin">${[10, 15, 20, 30, 45, 60].map(m => html`<option value="${m}" ${(s.slotMin || 20) === m ? 'selected' : ''}>${T('sch.minutes', '{n} minutes', { n: m })}</option>`)}</select></div>
            <div class="field"><label for="sc-f">${T('sch.fee', 'In-person fee (NGN)')}</label><input class="input" id="sc-f" name="feeKobo" data-kobo type="number" min="0" step="100" value="${s.feeKobo != null ? s.feeKobo / 100 : ''}"></div>
            ${video ? html`<div class="field"><label for="sc-vf">${T('sch.vfee', 'Video fee (NGN)')}</label><input class="input" id="sc-vf" name="videoFeeKobo" data-kobo type="number" min="0" step="100" value="${s.videoFeeKobo != null ? s.videoFeeKobo / 100 : ''}"></div>` : ''}</div>
          <div class="field"><span class="label">${T('sch.types', 'I offer')}</span><label class="check"><input type="checkbox" name="types" data-list value="in_person" ${!s.configured || (s.types || []).includes('in_person') ? 'checked' : ''}><span>${T('appt.in_person', 'In person')}</span></label>${video ? html`<label class="check"><input type="checkbox" name="types" data-list value="video" ${(s.types || []).includes('video') ? 'checked' : ''}><span>${T('appt.video', 'Video')}</span></label>` : ''}</div>
          <label class="check"><input type="checkbox" name="acceptingBookings" ${!s.configured || s.acceptingBookings ? 'checked' : ''}><span>${T('sch.accepting', 'Accepting new bookings')}</span></label>
          <div class="fields two"><div class="field"><label for="sc-sp">${T('sch.specialty', 'Specialty')}</label><input class="input" id="sc-sp" name="specialty" maxlength="80" value="${s.specialty || ''}"></div><div class="field"><label for="sc-l">${T('sch.langs', 'Languages (comma separated)')}</label><input class="input" id="sc-l" name="languages" value="${(s.languages || []).join(', ')}"></div></div>
          <div class="field"><label for="sc-b">${T('sch.bio', 'About you (shown to patients)')}</label><textarea class="input" id="sc-b" name="bio" maxlength="1000">${s.bio || ''}</textarea></div></section>
        <div class="form-err notice bad" hidden></div><button class="btn primary lg" type="submit">${T('sch.save', 'Save schedule')}</button></form>`);
  }
  form('sch-save', async d => {
    const weekly = []; const details = [];
    for (const dow of DAYS) {
      if (!d['on_' + dow]) continue;
      [['s1_', 'e1_'], ['s2_', 'e2_']].forEach(([s, e], k) => {
        const st = d[s + dow], en = d[e + dow];
        if (!st && !en) { if (k === 0) details.push({ field: s + dow, error: T('sch.need_time', 'Enter the hours') }); return; }
        if (!st || !en || en <= st) { details.push({ field: e + dow, error: T('sch.bad_time', 'End must be after start') }); return; }
        weekly.push({ dow, start: st, end: en });
      });
    }
    if (!(d.types || []).length) details.push({ field: 'types', error: T('sch.need_type', 'Choose at least one visit type') });
    if (details.length) throw err400(T('sch.fix', 'Check the highlighted hours'), details);
    const body = { weekly, slotMin: Number(d.slotMin), types: d.types, acceptingBookings: !!d.acceptingBookings, specialty: d.specialty || undefined, bio: d.bio || undefined, languages: (d.languages || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 8) };
    if (d.feeKobo !== undefined) body.feeKobo = d.feeKobo; if (d.videoFeeKobo !== undefined) body.videoFeeKobo = d.videoFeeKobo;
    await api.put('/api/doc/schedule', body); toast(T('sch.saved', 'Schedule saved'), 'ok'); MC.render();
  });

  /* ================= earnings ================= */
  async function earnings({ query }) {
    const r = await api.get('/api/doc/earnings' + qs({ from: query.from, to: query.to }));
    view(html`<div class="page-head"><div><h1>${T('earn.title', 'Earnings')}</h1><p>${T('earn.sub', 'Completed appointments from {from} to {to}', { from: r.from, to: r.to })}</p></div></div>
      <form class="row wrap panel" data-form="earn-filter" novalidate><div class="field"><label for="ef">${T('earn.from', 'From')}</label><input class="input" id="ef" name="from" type="date" value="${r.from}"></div><div class="field"><label for="et">${T('earn.to', 'To')}</label><input class="input" id="et" name="to" type="date" value="${r.to}"></div><button class="btn" type="submit">${T('earn.show', 'Show')}</button></form>
      ${figures([{ value: r.completed, label: T('earn.completed', 'Completed visits') }, { value: money(r.paidKobo), label: T('earn.paid', 'Paid') }, { value: r.unpaidCount, label: T('earn.unpaid', 'Not yet paid'), tone: r.unpaidCount ? 'warn' : '' }, { value: money(r.hmoKobo), label: T('earn.hmo', 'Covered by HMO') }, { value: (r.byType.in_person || {}).count || 0, label: T('appt.in_person', 'In person') }, { value: (r.byType.video || {}).count || 0, label: T('appt.video', 'Video') }])}
      ${r.payouts && r.payouts.note ? html`<div class="notice">${r.payouts.note}</div>` : ''}
      ${r.items.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('earn.date', 'Date')}</th><th>${T('earn.type', 'Type')}</th><th class="num">${T('earn.fee', 'Fee')}</th><th>${T('earn.status', 'Payment')}</th></tr></thead><tbody>${r.items.map(i => html`<tr><td data-label="${T('earn.date', 'Date')}">${i.date} ${i.time}</td><td data-label="${T('earn.type', 'Type')}">${typeLabel(i.type)}</td><td class="num" data-label="${T('earn.fee', 'Fee')}">${money(i.amountKobo != null ? i.amountKobo : i.feeKobo)}</td><td data-label="${T('earn.status', 'Payment')}">${i.paid ? badge(T('appt.paid', 'Paid'), 'ok') : badge(T('appt.unpaid', 'Not paid'), 'warn')}</td></tr>`)}</tbody></table></div>`
        : empty({ icon: 'chart', title: T('earn.empty', 'No completed visits in this period') })}`);
  }
  form('earn-filter', d => MC.go('#/earnings' + qs({ from: d.from, to: d.to })));

  MC.boot({
    title: 'MediCore Doctor', home: '#/today',
    nav: [
      { href: '#/today', label: T('nav.today', 'Today'), icon: 'home' },
      { href: '#/patients', label: T('nav.patients', 'Patients'), icon: 'users', perm: 'patient.read' },
      { href: '#/messages', label: T('nav.messages', 'Messages'), icon: 'message' },
      { href: '#/schedule', label: T('nav.schedule', 'Schedule'), icon: 'calendar' },
      { href: '#/earnings', label: T('nav.earnings', 'Earnings'), icon: 'chart' },
      MC.referrals.navItem(),
      MC.caretools.nav.shares({ sideOnly: true }),
      MC.caretools.nav.transfers({ sideOnly: true }),
    ],
    routes: { '#/today': today, '#/consult/:id': consult, '#/patients': patients, '#/chart/:id': chartPage, '#/messages': messages, '#/thread/:id': thread, '#/video/:id': videoPage, '#/schedule': schedule, '#/earnings': earnings,
      ...MC.referrals.routes('#/referrals', { patientHref: pid => '#/chart/' + pid }),
      ...MC.caretools.routes({ patientHref: pid => '#/chart/' + pid }) },
    onReady: async () => { MC.referrals.refreshCount(); MC.caretools.refreshCount(); try { const r = await api.get('/api/msg/threads?status=open'); setTimeout(() => MC.navCount('#/messages', r.unreadTotal), 0); } catch (e) { } },
  });
})();
