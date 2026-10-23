/*
 * MediCore referrals kit: digital referrals between providers on the platform.
 * Shared by the front desk, doctor, pharmacy, lab and dispatch apps. Load after mc.js, before the app script.
 *
 *   MC.referrals.routes('#/referrals', { patientHref: pid => '#/patient/' + pid })  -> route handlers to spread into MC.boot routes
 *   MC.referrals.navItem({ sideOnly })                                            -> nav entry (shows with referral.send or referral.receive)
 *   MC.referrals.sendDialog({ patient })                                          -> opens the "Refer a patient" form (patient optional: asks to pick one)
 *   MC.referrals.refreshCount()                                                   -> updates the nav badge with new incoming referrals
 *   MC.referrals.homeNotice(el)                                                   -> fills el with a notice when new referrals are waiting
 *   MC.referrals.canSend() / canReceive()
 *
 * Statuses: sent -> accepted -> arrived -> completed ; sent -> declined | cancelled | expired ; accepted -> cancelled
 */
(function () {
  'use strict';
  const { html, api, qs, icon, badge, empty, view, on, form, dialog, confirm, toast, dateTime, date, ago, cap } = MC;
  const T = (k, en, v) => MC.t('ref.' + k, en, v);
  const can = p => !!(MC.me && (MC.me.perms || []).includes(p));
  const canSend = () => can('referral.send');
  const canReceive = () => can('referral.receive');
  const hasMod = m => !!(MC.me && MC.me.org && (MC.me.org.modules || []).includes(m));
  const err400 = (msg, details) => new MC.ApiError(400, { error: msg, details });
  const featureOn = name => { const c = MC.config(); return !(c && c.features && c.features[name] === false); };

  let PREFIX = '#/referrals';
  let OPTS = {};

  /* ---------------- labels ---------------- */
  const URGENCY = ['emergency', 'urgent', 'routine', 'elective'];
  const URG_EN = { emergency: 'Emergency', urgent: 'Urgent', routine: 'Routine', elective: 'Elective (planned)' };
  const URG_CLS = { emergency: 'pri-P1', urgent: 'pri-P2', routine: 'pri-P3', elective: 'outline' };
  const urgLabel = u => T('urg.' + u, URG_EN[u] || cap(u));
  const urgBadge = u => html`<span class="badge plain ${URG_CLS[u] || ''}">${urgLabel(u)}</span>`;
  const SERVICES = ['consultation', 'specialist', 'admission', 'emergency_care', 'lab', 'imaging', 'pharmacy', 'ambulance', 'maternity', 'physiotherapy', 'other'];
  const SVC_EN = { consultation: 'Consultation', specialist: 'Specialist review', admission: 'Admission', emergency_care: 'Emergency care', lab: 'Laboratory tests', imaging: 'Imaging (scan or X-ray)', pharmacy: 'Pharmacy', ambulance: 'Ambulance transfer', maternity: 'Maternity care', physiotherapy: 'Physiotherapy', other: 'Other' };
  const svcLabel = s => T('svc.' + s, SVC_EN[s] || cap(s));
  const STATUSES = ['sent', 'accepted', 'arrived', 'completed', 'declined', 'cancelled', 'expired'];
  const ST_KIND = { sent: 'warn', accepted: 'info', arrived: 'info', completed: 'ok', declined: 'bad', cancelled: 'bad', expired: 'bad' };
  const stLabel = (s, dir) => (s === 'sent' ? (dir === 'in' ? T('st.new', 'New') : T('st.sent', 'Sent')) : T('st.' + s, cap(s)));
  const stBadge = (s, dir) => badge(stLabel(s, dir), ST_KIND[s] || 'info');
  const lines = text => String(text || '').split('\n').map((l, i) => html`${i ? html`<br>` : ''}${l}`);
  const short = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '...' : s; };
  const back = (href, label) => html`<a class="back" href="${href}">${icon('left')}${label}</a>`;
  const flagCls = f => (f === 'critical' ? 'flag-critical' : f === 'high' ? 'flag-high' : f === 'low' ? 'flag-low' : f === 'abnormal' ? 'flag-abnormal' : '');
  const flagText = f => (f && f !== 'normal' ? T('flag.' + f, cap(f)) : T('flag.normal', 'Normal'));

  /** run an action; a 409 (already done or wrong state) shows the message and refreshes the screen */
  async function guard(fn) {
    try { return await fn(); }
    catch (e) { if (e && e.status === 409) { toast(e.message, 'bad'); MC.render(); return null; } throw e; }
  }

  /* ---------------- nav and counts ---------------- */
  function navItem(opts) {
    return Object.assign({ href: PREFIX, label: T('nav', 'Referrals'), icon: 'swap', anyPerm: ['referral.send', 'referral.receive'], show: () => MC.feature('referralNetwork') }, opts || {});
  }
  function setCount(n) { MC.navCount(PREFIX, n || 0); const c = document.getElementById('ref-in-count'); if (c) { c.textContent = n ? String(n) : ''; c.hidden = !n; } }
  async function refreshCount() {
    if (!canReceive() || !MC.feature('referralNetwork')) return 0;
    try { const r = await api.get('/api/referrals' + qs({ box: 'in', limit: 1 })); setCount(r.counts.newIn); return r.counts.newIn; } catch (e) { return 0; }
  }
  /** a notice on an app's home screen when new referrals are waiting */
  async function homeNotice(el) {
    if (!el || !canReceive() || !MC.feature('referralNetwork')) return;
    let r; try { r = await api.get('/api/referrals' + qs({ box: 'in', status: 'sent', limit: 100 })); } catch (e) { return; }
    if (!el.isConnected) return;
    const list = r.referrals || []; setCount(r.counts.newIn);
    if (!list.length) { MC.view('', el); return; }
    const em = list.filter(x => x.urgency === 'emergency').length;
    MC.view(html`<div class="notice ${em ? 'bad' : 'warn'}" role="status"><div class="row wrap between"><span>${em ? (list.length === 1 ? T('home.one_emergency', '1 new emergency referral is waiting for a decision.') : T('home.emergency', '{n} new referrals are waiting for a decision. Emergencies: {e}.', { n: list.length, e: em })) : list.length === 1 ? T('home.one', '1 new referral is waiting for a decision.') : T('home.many', '{n} new referrals are waiting for a decision.', { n: list.length })}</span>
      <a class="btn sm ${em ? 'danger' : ''}" href="${PREFIX}?box=in">${icon('swap')}${T('home.open', 'Open referrals')}</a></div></div>`, el);
  }

  /* ================= inbox and outbox ================= */
  function boxes() { const b = []; if (canReceive()) b.push('in'); if (canSend()) b.push('out'); return b; }
  function row(r) {
    return html`<a href="${PREFIX}/${r.id}"><div class="grow"><span class="title">${r.patientName} ${urgBadge(r.urgency)}</span>
      <span class="sub">${r.number} | ${svcLabel(r.service)}${r.specialty ? ', ' + r.specialty : ''} | ${r.direction === 'in' ? T('list.from', 'From {org}', { org: r.fromOrgName }) : T('list.to', 'To {org}', { org: r.toOrgName })}</span>
      <span class="sub">${short(r.reason, 140)}</span></div>
      <span class="end">${stBadge(r.status, r.direction)}<br><span class="xs muted">${ago(r.createdAt)}</span>${r.hmo ? html`<br>${badge(T('list.hmo', 'HMO'), 'outline')}` : ''}</span></a>`;
  }
  async function listPage({ query }) {
    if (!MC.feature('referralNetwork')) return view(empty({ icon: 'swap', title: T('off.title', 'Referrals are switched off'), body: T('off.body', 'The MediCore team has switched off the provider network. Refer patients by phone for now.') }));
    const bx = boxes();
    if (!bx.length) return view(empty({ icon: 'lock', title: T('noperm.title', 'Your role cannot use referrals'), body: T('noperm.body', 'Ask your administrator if you need to send or receive referrals.') }));
    const box = bx.includes(query.box) ? query.box : bx[0];
    const status = STATUSES.includes(query.status) ? query.status : '';
    view(html`<div class="page-head"><div><h1>${T('list.title', 'Referrals')}</h1><p>${box === 'in' ? T('list.sub_in', 'Patients other providers are sending to you. Refreshes every 20 seconds.') : T('list.sub_out', 'Patients your provider has referred to others. Refreshes every 20 seconds.')}</p></div>
        <div class="actions">${canSend() ? html`<button class="btn primary" data-action="ref-new">${icon('plus')}${T('list.new', 'Refer a patient')}</button>` : ''}</div></div>
      ${bx.length > 1 ? html`<div class="tabs" role="tablist" aria-label="${T('list.boxes', 'Incoming or sent')}">
        <a role="tab" href="${PREFIX}?box=in" aria-selected="${box === 'in' ? 'true' : 'false'}">${T('list.in', 'Received')} <span class="badge plain bad" id="ref-in-count" hidden></span></a>
        <a role="tab" href="${PREFIX}?box=out" aria-selected="${box === 'out' ? 'true' : 'false'}">${T('list.out', 'Sent')}</a></div>` : ''}
      <div class="field" style="max-width:320px"><label for="ref-st">${T('list.status', 'Show')}</label><select class="input" id="ref-st" data-ref-status data-box="${box}">
        <option value="">${T('list.all', 'All referrals')}</option>${STATUSES.map(s => html`<option value="${s}" ${s === status ? 'selected' : ''}>${stLabel(s, box)}</option>`)}</select></div>
      <div id="ref-list">${MC.skeleton(3)}</div>`);
    const el = document.getElementById('ref-list');
    let sig = '';
    const load = async () => {
      const r = await api.get('/api/referrals' + qs({ box, status, limit: 200 }));
      if (!el.isConnected) return;
      setCount(r.counts.newIn);
      const s = JSON.stringify(r.referrals.map(x => [x.id, x.status]));
      if (s === sig) return; sig = s;
      MC.view(r.referrals.length ? html`<div class="list">${r.referrals.map(row)}</div>`
        : box === 'in' ? empty({ icon: 'swap', title: status ? T('list.none_status', 'No referrals with this status') : T('list.none_in', 'No referrals received yet'), body: T('list.none_in_sub', 'When another provider refers a patient to you, it appears here straight away with their record summary.') })
          : empty({ icon: 'swap', title: status ? T('list.none_status', 'No referrals with this status') : T('list.none_out', 'You have not referred anyone yet'), body: T('list.none_out_sub', 'Open a patient and choose Refer to send a digital referral to another provider.'), action: canSend() ? html`<button class="btn primary" data-action="ref-new">${icon('plus')}${T('list.new', 'Refer a patient')}</button>` : '' }), el);
    };
    await load();
    MC.poll(load, 20000);
  }
  document.addEventListener('change', e => {
    const s = e.target && e.target.closest && e.target.closest('select[data-ref-status]');
    if (s) MC.go(PREFIX + qs({ box: s.dataset.box, status: s.value }));
  });
  on('ref-new', () => sendDialog({}));

  /* ================= one referral ================= */
  let cur = null;
  function bandOf(r) {
    const s = r.snapshot || null; const sp = (s && s.patient) || {};
    return { name: sp.name || r.patientName, age: sp.age, dob: sp.dob, sex: sp.sex, bloodGroup: sp.bloodGroup, genotype: sp.genotype, weightKg: sp.weightKg,
      mrn: r.direction === 'in' ? r.receiverMrn : null, allergies: s ? s.allergies || [] : [], noKnownAllergies: s ? !!s.noKnownAllergies : false };
  }
  function cancelNote(r) { const ev = (r.timeline || []).slice().reverse().find(x => x.status === 'cancelled'); return ev ? ev.note : null; }
  function notices(r) {
    const inb = r.direction === 'in';
    const out = [];
    if (r.urgency === 'emergency' && ['sent', 'accepted'].includes(r.status)) out.push(html`<div class="notice bad" role="alert"><b>${T('det.emergency', 'Emergency referral.')}</b> ${inb ? T('det.emergency_in', 'Get ready to receive the patient now. Call {org} if you cannot take them.', { org: r.fromOrgName }) : T('det.emergency_out', 'Phone {org} to make sure they are ready for the patient.', { org: r.toOrgName })}</div>`);
    if (r.status === 'accepted') out.push(html`<div class="notice ok">${inb ? T('det.accepted_in', 'Accepted by {name}. The patient is registered with you, record number {mrn}. Mark them arrived when they come.', { name: r.decidedByName || '', mrn: r.receiverMrn || '-' }) : T('det.accepted_out', '{org} accepted this referral on {d}.', { org: r.toOrgName, d: dateTime(r.decidedAt) })}</div>`);
    if (r.status === 'arrived') out.push(html`<div class="notice ok">${inb ? (r.queueId ? T('det.arrived_q', 'Arrived {d}. The patient is in your triage queue. Report the outcome when you have seen them.', { d: dateTime(r.arrivedAt) }) : T('det.arrived_in', 'Arrived {d}. Report the outcome when you have seen them.', { d: dateTime(r.arrivedAt) })) : T('det.arrived_out', 'The patient arrived at {org} on {d}.', { org: r.toOrgName, d: dateTime(r.arrivedAt) })}</div>`);
    if (r.status === 'declined') out.push(html`<div class="notice bad"><b>${T('det.declined', 'Declined by {org}', { org: r.toOrgName })}</b>${r.decidedByName ? ' (' + r.decidedByName + ')' : ''}: ${r.declineReason || ''}${!inb ? html`<br>${T('det.declined_next', 'Tell the patient and refer them to another provider if they still need care.')}` : ''}</div>`);
    if (r.status === 'cancelled') { const n = cancelNote(r); out.push(html`<div class="notice bad"><b>${T('det.cancelled', 'Cancelled by {org}.', { org: r.fromOrgName })}</b> ${n || ''}</div>`); }
    if (r.status === 'expired') out.push(html`<div class="notice">${T('det.expired', 'This referral expired without a decision.')}</div>`);
    if (r.status === 'completed') out.push(html`<div class="notice ok"><b>${T('det.outcome', 'Outcome reported {d}', { d: dateTime(r.completedAt) })}</b><br>${lines(r.outcome)}</div>`);
    return out;
  }
  function actions(r) {
    const inb = r.direction === 'in'; const recv = inb && canReceive(); const send = !inb && canSend();
    const b = [];
    if (recv && r.status === 'sent') b.push(html`<button class="btn primary" data-action="ref-accept">${icon('check')}${T('act.accept', 'Accept referral')}</button>`, html`<button class="btn" data-action="ref-decline">${icon('x')}${T('act.decline', 'Decline')}</button>`);
    if (recv && r.status === 'accepted') b.push(html`<button class="btn primary" data-action="ref-arrived">${icon('user')}${T('act.arrived', 'Mark patient arrived')}</button>`);
    if (recv && ['accepted', 'arrived'].includes(r.status)) b.push(html`<button class="btn ${r.status === 'arrived' ? 'primary' : ''}" data-action="ref-complete">${icon('file')}${T('act.complete', 'Report outcome')}</button>`);
    if (send && ['sent', 'accepted'].includes(r.status)) b.push(html`<button class="btn" data-action="ref-cancel">${icon('x')}${T('act.cancel', 'Cancel referral')}</button>`);
    if (inb && OPTS.patientHref && ['accepted', 'arrived', 'completed'].includes(r.status)) b.push(html`<a class="btn ghost" href="${OPTS.patientHref(r.patientId)}">${icon('user')}${T('act.patient', 'Open patient record')}</a>`);
    if (!inb && OPTS.patientHref) b.push(html`<a class="btn ghost" href="${OPTS.patientHref(r.patientId)}">${icon('user')}${T('act.patient', 'Open patient record')}</a>`);
    return b;
  }
  function detailsPanel(r) {
    const c = r.consent || {};
    const consentText = c.given ? T('det.consent_yes', 'Given ({how}), recorded {d}', { how: T('consent.' + (c.method || 'verbal'), cap(c.method || 'verbal')), d: dateTime(c.at) }) : c.method === 'emergency' ? T('det.consent_em', 'Not taken: emergency referral') : T('det.consent_no', 'Not recorded');
    return html`<section class="panel"><h2>${T('det.details', 'Referral')}</h2><dl class="kv">
      <dt>${T('det.from', 'From')}</dt><dd><b>${r.fromOrgName}</b><br><span class="sm">${r.fromName || ''}${r.fromRoleLabel ? ', ' + r.fromRoleLabel : ''}</span></dd>
      <dt>${T('det.to', 'To')}</dt><dd><b>${r.toOrgName}</b></dd>
      <dt>${T('det.urgency', 'Urgency')}</dt><dd>${urgBadge(r.urgency)}</dd>
      <dt>${T('det.service', 'Service')}</dt><dd>${svcLabel(r.service)}</dd>
      ${r.specialty ? html`<dt>${T('det.specialty', 'Specialty')}</dt><dd>${r.specialty}</dd>` : ''}
      <dt>${T('det.reason', 'Reason')}</dt><dd>${lines(r.reason)}</dd>
      <dt>${T('det.note', 'Clinical note')}</dt><dd>${r.clinicalNote ? lines(r.clinicalNote) : html`<span class="muted">${T('det.no_note', 'None')}</span>`}</dd>
      <dt>${T('det.consent', 'Patient consent')}</dt><dd>${consentText}</dd>
      <dt>${T('det.sent', 'Sent')}</dt><dd>${dateTime(r.createdAt)}</dd>
      ${r.status === 'sent' && r.expiresAt ? html`<dt>${T('det.expires', 'Expires')}</dt><dd>${date(r.expiresAt)}</dd>` : ''}
    </dl></section>`;
  }
  function hmoPanel(r) {
    const h = r.hmo;
    const inb = r.direction === 'in';
    if (!h) return html`<section class="panel"><h2>${T('hmo.title', 'HMO cover')}</h2><p class="muted sm">${T('hmo.none', 'No active HMO cover was found when the referral was sent. Ask the patient whether they are covered.')}</p></section>`;
    return html`<section class="panel"><h2>${T('hmo.title', 'HMO cover')}</h2><dl class="kv">
      <dt>${T('hmo.payer', 'HMO')}</dt><dd><b>${h.payerName || '-'}</b></dd>
      <dt>${T('hmo.member', 'Member number')}</dt><dd><b>${h.memberNo || '-'}</b></dd>
      ${h.planName ? html`<dt>${T('hmo.plan', 'Plan')}</dt><dd>${h.planName}</dd>` : ''}
      <dt>${T('hmo.status', 'Status')}</dt><dd>${MC.statusBadge(h.status || 'active')}</dd></dl>
      ${inb ? html`<p class="muted sm" style="margin-top:12px">${T('hmo.hint', 'Before treating, request pre-authorisation from {payer} for services above its limit. Put the referral number {n} in the note.', { payer: h.payerName || T('hmo.the_hmo', 'the HMO'), n: r.number })}</p>
        ${can('hmo.check') && ['accepted', 'arrived'].includes(r.status) ? html`<button class="btn" data-action="ref-preauth">${icon('shield')}${T('hmo.request', 'Request pre-authorisation')}</button>` : r.status === 'sent' ? html`<p class="xs muted">${T('hmo.after_accept', 'You can request pre-authorisation after you accept the referral.')}</p>` : ''}` : ''}
    </section>`;
  }
  function summaryPanel(r) {
    const s = r.snapshot;
    if (!s) return html`<section class="panel"><h2>${T('sum.title', 'Record summary')}</h2><div class="notice">${r.direction === 'in' ? T('sum.none_in', 'The referring provider did not share a record summary. Ask them in the conversation if you need it.') : T('sum.none_out', 'You did not share a record summary with this referral.')}</div></section>`;
    const v = s.lastVitals;
    const vrows = v ? [['BP', v.bpSys != null ? v.bpSys + '/' + (v.bpDia != null ? v.bpDia : '?') + ' mmHg' : null], [T('sum.pulse', 'Pulse'), v.pulse != null ? v.pulse + ' /min' : null], [T('sum.temp', 'Temperature'), v.tempC != null ? v.tempC + ' °C' : null], ['SpO2', v.spo2 != null ? v.spo2 + '%' : null], [T('sum.rr', 'Breathing rate'), v.respRate != null ? v.respRate + ' /min' : null], [T('sum.weight', 'Weight'), v.weightKg != null ? v.weightKg + ' kg' : null], [T('sum.glucose', 'Glucose'), v.glucose != null ? v.glucose + ' mmol/L' : null]].filter(x => x[1]) : [];
    return html`<section class="panel"><h2>${T('sum.title', 'Record summary')}</h2>
      <p class="muted sm">${T('sum.sub', 'Copied from {org} on {d}. It shows the record as it was when the referral was sent.', { org: s.byOrgName || r.fromOrgName, d: dateTime(s.at) })}</p>
      <h3>${T('sum.allergies', 'Allergies')}</h3>
      ${(s.allergies || []).length ? html`<div class="row wrap" style="gap:8px;margin-bottom:12px">${s.allergies.map(a => html`<span class="allergy-tag">${icon('alert')}${a.substance}${a.reaction ? ': ' + a.reaction : ''}${a.severity && a.severity !== 'unknown' ? ' (' + T('sev.' + a.severity, cap(a.severity)) + ')' : ''}</span>`)}</div>`
        : s.noKnownAllergies ? html`<p>${T('sum.nka', 'No known allergies (confirmed).')}</p>` : html`<p><span class="allergy-unknown">${icon('alert')}${T('sum.allergy_unknown', 'Allergies not recorded. Ask the patient.')}</span></p>`}
      <h3>${T('sum.conditions', 'Conditions')}</h3>
      ${(s.conditions || []).length ? html`<ul class="list">${s.conditions.map(c => html`<li><div class="grow"><span class="title">${c.name}</span>${c.code ? html`<span class="sub">${c.code}</span>` : ''}</div></li>`)}</ul>` : html`<p class="muted sm">${T('sum.none', 'None recorded.')}</p>`}
      <h3 style="margin-top:16px">${T('sum.meds', 'Current medicines')}</h3>
      ${(s.currentMedicines || []).length ? html`<ul class="list">${s.currentMedicines.map(m => html`<li><div class="grow"><span class="title">${m.drugName}</span>${m.at ? html`<span class="sub">${T('sum.since', 'Prescribed {d}', { d: date(m.at) })}</span>` : ''}</div></li>`)}</ul>` : html`<p class="muted sm">${T('sum.no_meds', 'No current medicines on record.')}</p>`}
      <h3 style="margin-top:16px">${T('sum.vitals', 'Last vitals')}</h3>
      ${vrows.length ? html`<p class="sm muted">${dateTime(v.at)}</p><dl class="kv">${vrows.map(x => html`<dt>${x[0]}</dt><dd>${x[1]}</dd>`)}</dl>` : html`<p class="muted sm">${T('sum.no_vitals', 'No vitals on record.')}</p>`}
      <h3 style="margin-top:16px">${T('sum.visits', 'Recent visits')}</h3>
      ${(s.recentEncounters || []).length ? html`<ul class="list">${s.recentEncounters.map(e => html`<li><div class="grow"><span class="title">${e.date ? date(Date.parse(e.date + 'T12:00:00Z')) : ''}${e.orgName ? ' | ' + e.orgName : ''}${e.doctorName ? ' | ' + e.doctorName : ''}</span>
        ${e.complaint ? html`<span class="sub">${T('sum.complaint', 'Complaint')}: ${e.complaint}</span>` : ''}
        ${(e.diagnoses || []).length ? html`<span class="sub">${T('sum.dx', 'Diagnosis')}: ${e.diagnoses.map((d, i) => html`${i ? '; ' : ''}${d.code ? d.code + ' ' : ''}${d.text}${d.primary ? ' (' + T('sum.primary', 'primary') + ')' : ''}`)}</span>` : ''}
        ${e.plan ? html`<span class="sub">${T('sum.plan', 'Plan')}: ${e.plan}</span>` : ''}</div></li>`)}</ul>` : html`<p class="muted sm">${T('sum.no_visits', 'No completed visits on record.')}</p>`}
      <h3 style="margin-top:16px">${T('sum.labs', 'Recent lab results')}</h3>
      ${(s.recentLabResults || []).length ? s.recentLabResults.map(o => html`<h4 style="margin-top:12px">${[o.number, o.lab, o.releasedAt ? dateTime(o.releasedAt) : ''].filter(Boolean).join(' | ')}</h4>
        <div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('sum.test', 'Test')}</th><th>${T('sum.result', 'Result')}</th><th>${T('sum.flag', 'Flag')}</th></tr></thead><tbody>
        ${(o.results || []).map(x => html`<tr><td data-label="${T('sum.test', 'Test')}">${x.name}</td><td data-label="${T('sum.result', 'Result')}"><span class="${flagCls(x.flag)}">${x.value != null ? x.value : '-'} ${x.unit || ''}</span></td><td data-label="${T('sum.flag', 'Flag')}"><span class="${flagCls(x.flag)}">${flagText(x.flag)}</span></td></tr>`)}</tbody></table></div>`) : html`<p class="muted sm">${T('sum.no_labs', 'No released lab results on record.')}</p>`}
    </section>`;
  }
  function timelinePanel(r) {
    const tl = r.timeline || [];
    return html`<section class="panel"><h2>${T('det.history', 'History')}</h2>${tl.length ? html`<ol class="timeline">${tl.map(x => html`<li><time>${dateTime(x.at)}${x.byName ? ' | ' + x.byName : ''}${x.orgName ? ', ' + x.orgName : ''}</time>${stLabel(x.status, 'out')}${x.note ? html`: ${x.note}` : ''}</li>`)}</ol>` : html`<p class="muted sm">${T('det.no_history', 'No history yet.')}</p>`}</section>`;
  }
  function threadPanel(r) {
    if (!r.threadId) return '';
    const other = r.direction === 'in' ? r.fromOrgName : r.toOrgName;
    const msgOn = featureOn('providerMessaging');
    return html`<section class="panel"><h2>${T('msg.title', 'Conversation with {org}', { org: other })}</h2>
      <p class="muted sm">${T('msg.sub', 'Private between your provider and {org}. The patient does not see it.', { org: other })}</p>
      <div id="ref-thread" aria-live="polite">${MC.skeleton(2)}</div>
      ${msgOn ? html`<form data-form="ref-msg" novalidate style="margin-top:12px"><div class="field"><label for="ref-msg-t">${T('msg.label', 'Message to {org}', { org: other })}</label><textarea class="input" id="ref-msg-t" name="text" maxlength="2000" required></textarea></div>
        <div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${icon('message')}${T('msg.send', 'Send message')}</button></form>`
        : html`<p class="muted sm">${T('msg.off', 'Provider messaging is switched off. Phone {org} instead.', { org: other })}</p>`}
    </section>`;
  }
  function renderThread(d) {
    const box = document.getElementById('ref-thread'); if (!box) return;
    const list = (d && d.messages) || [];
    MC.view(list.length ? html`<ul class="list">${list.map(m => m.system
      ? html`<li><div class="grow"><span class="sub">${icon('clipboard')} ${lines(m.text)}</span><span class="xs muted">${m.fromOrgName || ''} | ${dateTime(m.at)}</span></div></li>`
      : html`<li><div class="grow"><span class="title">${m.fromName || m.fromOrgName} ${m.mine ? badge(T('msg.you', 'Your provider'), 'hue') : ''}</span><span class="xs muted">${m.fromOrgName || ''} | ${dateTime(m.at)}</span><span style="display:block;margin-top:4px;overflow-wrap:anywhere">${lines(m.text)}</span></div></li>`)}</ul>`
      : html`<p class="muted sm">${T('msg.empty', 'No messages yet. Ask a question or share an update here.')}</p>`, box);
  }
  async function loadThread(r) {
    if (!r.threadId) return;
    try { renderThread(await api.get('/api/network/threads/' + encodeURIComponent(r.threadId) + '/messages')); }
    catch (e) { if (e.status === 401) throw e; const box = document.getElementById('ref-thread'); if (box) MC.view(html`<p class="muted sm">${T('msg.load_failed', 'Messages could not be loaded: {m}', { m: e.message })}</p>`, box); }
  }

  async function detailPage({ params, stale }) {
    if (!MC.feature('referralNetwork')) return view(empty({ icon: 'swap', title: T('off.title', 'Referrals are switched off') }));
    let r;
    try { r = await api.get('/api/referrals/' + encodeURIComponent(params.id)); }
    catch (e) { if (e.status === 404 || e.status === 403) return view(html`${back(PREFIX, T('list.title', 'Referrals'))}${empty({ icon: 'swap', title: T('det.not_found', 'Referral not found'), body: T('det.not_found_sub', 'It may belong to another provider. Go back to your referrals.'), action: html`<a class="btn" href="${PREFIX}">${T('list.title', 'Referrals')}</a>` })}`); throw e; }
    if (stale()) return;
    cur = r;
    const flow = ['sent', 'accepted', 'arrived', 'completed'];
    const labels = { sent: T('step.sent', 'Sent'), accepted: T('step.accepted', 'Accepted'), arrived: T('step.arrived', 'Arrived'), completed: T('step.completed', 'Outcome reported') };
    const acts = actions(r);
    view(html`${back(PREFIX + qs({ box: boxes().length > 1 ? r.direction : undefined }), T('list.title', 'Referrals'))}
      ${MC.wristband(bandOf(r))}
      <div class="page-head"><div><h1>${T('det.title', 'Referral {n}', { n: r.number })}</h1>
        <p>${urgBadge(r.urgency)} ${stBadge(r.status, r.direction)} ${r.direction === 'in' ? T('det.from_line', 'From {org}, {when}', { org: r.fromOrgName, when: ago(r.createdAt) }) : T('det.to_line', 'To {org}, {when}', { org: r.toOrgName, when: ago(r.createdAt) })}</p></div>
        ${acts.length ? html`<div class="actions">${acts}</div>` : ''}</div>
      ${notices(r)}
      ${flow.includes(r.status) ? MC.steps(flow, r.status, labels) : ''}
      <div class="grid side-r"><div>${detailsPanel(r)}${summaryPanel(r)}</div>
        <div>${hmoPanel(r)}${threadPanel(r)}${timelinePanel(r)}</div></div>`);
    await loadThread(r);
    if (r.direction === 'in') refreshCount();
    MC.poll(async () => {
      const n = await api.get('/api/referrals/' + encodeURIComponent(r.id));
      const ta = document.getElementById('ref-msg-t');
      if (n.status !== cur.status && !(ta && ta.value.trim()) && !document.querySelector('dialog.dlg')) { MC.render(); return; }
      await loadThread(n);
    }, 20000);
  }

  /* ---------------- receiver and sender actions ---------------- */
  const reasonField = (id, label, hint, min, max) => html`<div class="field"><label for="${id}">${label}</label><textarea class="input" id="${id}" name="text" minlength="${min}" maxlength="${max}" required></textarea>${hint ? html`<div class="hint">${hint}</div>` : ''}</div>`;
  const needText = (d, min, msg) => { if (!d.text || d.text.trim().length < min) throw err400(msg, [{ field: 'text', error: msg }]); return d.text.trim(); };
  on('ref-accept', async () => {
    const r = cur; if (!r) return;
    const v = await dialog({ title: T('accept.title', 'Accept referral {n}?', { n: r.number }), form: true,
      body: html`<p>${T('accept.body', '{name} will be registered with your provider and {org} will be told you accepted.', { name: r.patientName, org: r.fromOrgName })}</p>
        <div class="field"><label for="ra-n">${T('accept.note', 'Note (optional)')}</label><textarea class="input" id="ra-n" name="note" maxlength="500"></textarea><div class="hint">${T('accept.note_hint', 'For example when to come and who to ask for. {org} and the patient see this note.', { org: r.fromOrgName })}</div></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('act.accept', 'Accept referral'), primary: true }],
      onSubmit: d => guard(() => api.post('/api/referrals/' + r.id + '/accept', { note: d.note ? d.note.trim() : undefined })) });
    if (v) { toast(T('accept.done', 'Referral accepted. Record number {mrn}', { mrn: v.receiverMrn || '-' }), 'ok'); MC.render(); }
  });
  on('ref-decline', async () => {
    const r = cur; if (!r) return;
    const v = await dialog({ title: T('decline.title', 'Decline referral {n}?', { n: r.number }), form: true,
      body: html`<p>${T('decline.body', '{org} and the patient will be told you cannot take {name}. Give the reason so they can find care elsewhere.', { org: r.fromOrgName, name: r.patientName })}</p>${reasonField('rd-r', T('decline.reason', 'Reason'), T('decline.hint', 'For example: no specialist this week, no bed available.'), 5, 500)}`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('act.decline_ok', 'Decline referral'), primary: true, danger: true }],
      onSubmit: d => { const reason = needText(d, 5, T('decline.need', 'Give a reason of at least 5 characters')); return guard(() => api.post('/api/referrals/' + r.id + '/decline', { reason })); } });
    if (v) { toast(T('decline.done', 'Referral declined'), 'ok'); MC.render(); }
  });
  on('ref-arrived', async () => {
    const r = cur; if (!r) return;
    const fd = hasMod('frontdesk');
    const v = await dialog({ title: T('arrived.title', 'Mark {name} arrived?', { name: r.patientName }), form: true,
      body: html`<p>${T('arrived.body', '{org} will be told the patient has arrived.', { org: r.fromOrgName })}</p>
        ${fd ? html`<label class="check"><input type="checkbox" name="queue" checked><span>${T('arrived.queue', 'Add the patient to the triage queue')}<br><span class="sm muted">${T('arrived.queue_hint', 'Priority follows the referral urgency.')}</span></span></label>` : ''}`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('act.arrived', 'Mark patient arrived'), primary: true }],
      onSubmit: d => guard(() => api.post('/api/referrals/' + r.id + '/arrived', { queue: fd ? !!d.queue : false })) });
    if (v) { toast(v.queueId ? T('arrived.done_q', 'Arrival recorded. {name} is in the triage queue', { name: r.patientName }) : T('arrived.done', 'Arrival recorded'), 'ok'); MC.render(); }
  });
  on('ref-complete', async () => {
    const r = cur; if (!r) return;
    const v = await dialog({ title: T('complete.title', 'Report the outcome to {org}', { org: r.fromOrgName }), form: true,
      body: html`<p class="muted sm">${T('complete.body', 'Say what you found and did, and what {org} should do next. This closes the referral.', { org: r.fromOrgName })}</p>${reasonField('rc-o', T('complete.label', 'Outcome'), T('complete.hint', 'For example: seen in clinic, diagnosis, treatment started, follow-up date.'), 5, 2000)}`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('complete.send', 'Send outcome'), primary: true }],
      onSubmit: d => { const outcome = needText(d, 5, T('complete.need', 'Write the outcome (at least 5 characters)')); return guard(() => api.post('/api/referrals/' + r.id + '/complete', { outcome })); } });
    if (v) { toast(T('complete.done', 'Outcome sent to {org}', { org: r.fromOrgName }), 'ok'); MC.render(); }
  });
  on('ref-cancel', async () => {
    const r = cur; if (!r) return;
    const v = await dialog({ title: T('cancel.title', 'Cancel referral {n}?', { n: r.number }), form: true,
      body: html`<p>${T('cancel.body', '{org} will be told the referral for {name} is cancelled. This cannot be undone.', { org: r.toOrgName, name: r.patientName })}</p>${reasonField('rx-r', T('cancel.reason', 'Reason'), '', 5, 300)}`,
      actions: [{ label: T('cancel.keep', 'Keep referral'), value: null }, { label: T('act.cancel', 'Cancel referral'), primary: true, danger: true }],
      onSubmit: d => { const reason = needText(d, 5, T('cancel.need', 'Give a reason of at least 5 characters')); return guard(() => api.post('/api/referrals/' + r.id + '/cancel', { reason })); } });
    if (v) { toast(T('cancel.done', 'Referral cancelled'), 'ok'); MC.render(); }
  });
  form('ref-msg', async (d, f) => {
    const r = cur; if (!r) return;
    const text = (d.text || '').trim();
    if (!text) throw err400(T('msg.need', 'Write a message first'), [{ field: 'text', error: T('msg.need', 'Write a message first') }]);
    await api.post('/api/referrals/' + r.id + '/messages', { text });
    f.reset(); toast(T('msg.sent', 'Message sent'), 'ok');
    await loadThread(r);
  });
  const HMO_CAT = { consultation: 'consultation', video: 'consultation', procedure: 'procedure', lab: 'lab', drug: 'drug', delivery: 'delivery', ambulance: 'ambulance' };
  on('ref-preauth', async () => {
    const r = cur; if (!r || !r.hmo) return;
    let svcs = [];
    try { svcs = (await api.get('/api/services')).filter(s => s.active !== false); } catch (e) { svcs = []; }
    if (!svcs.length) { toast(T('pa.no_services', 'Your price list is empty. Ask your administrator to add services first.'), 'bad'); return; }
    const v = await dialog({ title: T('pa.title', 'Request pre-authorisation from {payer}', { payer: r.hmo.payerName || T('hmo.the_hmo', 'the HMO') }), form: true,
      body: html`<p class="muted sm">${T('pa.sub', 'Member {m}. The price comes from your price list.', { m: r.hmo.memberNo || '-' })}</p>
        <div class="field"><label for="pa-s">${T('pa.service', 'Service')}</label><select class="input" id="pa-s" name="code" required>${svcs.map(s => html`<option value="${s.code}">${s.name} (${MC.money(s.priceKobo)})</option>`)}</select></div>
        <div class="field"><label for="pa-q">${T('pa.qty', 'Quantity')}</label><input class="input" id="pa-q" name="qty" type="number" min="1" max="1000" value="1" inputmode="numeric"></div>
        <div class="fields two"><div class="field"><label for="pa-dx">${T('pa.dx', 'Diagnosis or reason')}</label><input class="input" id="pa-dx" name="dx" maxlength="200" required></div>
        <div class="field"><label for="pa-dc">${T('pa.dx_code', 'ICD-10 code (optional)')}</label><input class="input" id="pa-dc" name="dxCode" maxlength="12"></div></div>
        <div class="field"><label for="pa-n">${T('pa.note', 'Note for the HMO')}</label><textarea class="input" id="pa-n" name="note" maxlength="1000">${T('pa.note_default', 'Referral {n} from {org}.', { n: r.number, org: r.fromOrgName })}</textarea></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pa.send', 'Request pre-authorisation'), primary: true }],
      onSubmit: d => {
        if (!d.dx || !d.dx.trim()) throw err400(T('pa.need_dx', 'Enter the diagnosis or reason'), [{ field: 'dx', error: T('pa.need_dx', 'Enter the diagnosis or reason') }]);
        const s = svcs.find(x => x.code === d.code); const qty = Math.max(1, Math.round(d.qty || 1));
        return api.post('/api/hmo/preauths', { patientId: r.patientId, payerOrgId: r.hmo.payerOrgId, coverageId: r.hmo.coverageId, services: [{ code: s.code, name: s.name, category: HMO_CAT[s.category] || 'other', qty, amountKobo: s.priceKobo * qty }],
          diagnosis: { code: d.dxCode || undefined, text: d.dx.trim() }, note: d.note || undefined });
      } });
    if (v) toast(T('pa.done', 'Pre-authorisation {n} requested from {payer}', { n: v.number || '', payer: r.hmo.payerName || '' }), 'ok');
  });

  /* ================= send a referral ================= */
  async function pickPatient() {
    let rows = [];
    const paint = (d) => {
      const box = d.querySelector('#rp-res'); if (!box) return;
      MC.view(rows.length ? html`<div class="choice">${rows.map(p => html`<label class="check" style="border-bottom:1px solid var(--line-2)"><input type="radio" name="patientId" value="${p.id}"><span><b>${p.name}</b><br><span class="sm muted">${[p.mrn, p.age != null ? T('pick.age', '{n} yrs', { n: p.age }) : '', p.sex && p.sex !== 'unknown' ? MC.t('kit.sex.' + p.sex, cap(p.sex)) : '', p.phone].filter(Boolean).join(' | ')}</span></span></label>`)}</div>`
        : html`<p class="muted sm">${T('pick.none', 'No patient found. Only patients registered with your provider can be referred.')}</p>`, box);
    };
    const v = await dialog({ title: T('pick.title', 'Who are you referring?'), form: true,
      body: html`<div class="field search"><label class="sr-only" for="rp-q">${T('pick.search', 'Name, phone or record number')}</label>${icon('search')}<input class="input" id="rp-q" placeholder="${T('pick.search', 'Name, phone or record number')}" autocomplete="off"></div>
        <div class="field" id="rp-res"><p class="muted sm">${T('pick.hint', 'Type at least 2 letters to search your patients.')}</p></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pick.next', 'Continue'), primary: true }],
      onOpen: d => {
        let t = null; const q = d.querySelector('#rp-q');
        q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => { const s = q.value.trim(); if (s.length < 2) return; try { rows = await api.get('/api/fd/patients' + qs({ q: s, limit: 20 })); } catch (e) { rows = []; } paint(d); }, 300); });
        q.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
      },
      onSubmit: d => { const p = rows.find(x => x.id === d.patientId); if (!p) throw err400(T('pick.need', 'Search, then choose the patient')); return p; } });
    return v || null;
  }

  function provRow(p, sel) {
    const meta = [p.typeLabel, [p.area, p.city].filter(Boolean).join(', '), p.distanceKm != null ? T('send.km', '{km} km away', { km: p.distanceKm }) : '', p.groupName].filter(Boolean).join(' | ');
    const partner = p.connection && p.connection.status === 'accepted';
    return html`<label class="check" style="border-bottom:1px solid var(--line-2)"><input type="radio" name="toOrgId" value="${p.id}" ${p.acceptsReferrals ? '' : 'disabled'} ${sel === p.id ? 'checked' : ''}><span><b>${p.name}</b>
      ${p.sameGroup ? badge(T('send.own_group', 'Your group'), 'hue') : partner ? badge(T('send.partner', 'Partner'), 'ok') : p.connection && p.connection.status === 'pending' ? badge(T('send.pending', 'Partnership pending'), 'outline') : ''}
      ${p.acceptsReferrals ? '' : badge(T('send.not_accepting', 'Not taking referrals'), 'bad')}<br><span class="sm muted">${meta}</span></span></label>`;
  }

  async function sendDialog({ patient } = {}) {
    if (!canSend()) { toast(T('send.noperm', 'Your role cannot send referrals'), 'bad'); return null; }
    if (!MC.feature('referralNetwork')) { toast(T('off.title', 'Referrals are switched off'), 'bad'); return null; }
    if (!patient) { patient = await pickPatient(); if (!patient) return null; }
    if (!Array.isArray(patient.allergies)) { try { const full = await api.get('/api/fd/patients/' + encodeURIComponent(patient.id)); patient = Object.assign({}, patient, { allergies: full.allergies || [], noKnownAllergies: full.noKnownAllergies, mrn: patient.mrn || full.mrn, age: patient.age != null ? patient.age : full.age, sex: patient.sex || full.sex, name: patient.name || full.name }); } catch (e) { if (e.status === 401) throw e; } }
    const dirOn = MC.feature('providerDirectory');
    const st = { all: false, q: '', sel: null, seq: 0 };
    let dlg = null;
    const loadProvs = async () => {
      const box = dlg && dlg.querySelector('#rs-provs'); if (!box) return;
      const seq = ++st.seq;
      let rows; let err = null;
      try { rows = await api.get('/api/network/providers' + qs({ q: st.q || undefined, partners: st.all ? undefined : 'true', limit: 40 })); } catch (e) { if (e.status === 401) throw e; err = e; rows = []; }
      if (seq !== st.seq || !box.isConnected) return;
      MC.view(err ? html`<div class="notice bad">${err.message}</div>`
        : rows.length ? html`<div style="max-height:300px;overflow-y:auto;border:1px solid var(--line);border-radius:var(--r-sm);padding:0 12px">${rows.map(p => provRow(p, st.sel))}</div>`
          : html`<div class="notice">${st.all ? T('send.none_found', 'No provider matches. Try another name or area.') : st.q ? T('send.none_partner_q', 'None of your partners match. Search the whole directory instead.') : T('send.no_partners', 'You have no partners yet. Search the whole directory to refer to any provider on MediCore.')}
            ${!st.all && dirOn ? html`<div class="btn-row" style="margin-top:8px"><button type="button" class="btn sm" data-action="ref-dir-all">${icon('globe')}${T('send.search_all', 'Search all providers')}</button></div>` : ''}</div>`, box);
    };
    const setScope = all => { st.all = all; if (!dlg) return; dlg.querySelectorAll('[data-action="ref-dir-scope"]').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.all === '1') === all))); loadProvs(); };
    on('ref-dir-scope', el => setScope(el.dataset.all === '1'));
    on('ref-dir-all', () => setScope(true));
    const v = await dialog({ title: T('send.title', 'Refer {name}', { name: patient.name }), form: true, wide: true,
      body: html`${MC.wristband(patient)}
        <div class="field"><span class="label" id="rs-to-l">${T('send.to', 'Refer to')}</span>
          ${dirOn ? html`<div class="seg" role="group" aria-label="${T('send.scope', 'Which providers')}"><button type="button" data-action="ref-dir-scope" data-all="0" aria-pressed="true">${T('send.partners', 'Partners and branches')}</button><button type="button" data-action="ref-dir-scope" data-all="1" aria-pressed="false">${T('send.all', 'All providers')}</button></div>` : html`<p class="muted sm">${T('send.partners_only', 'You can refer to your partners and the branches of your group.')}</p>`}
          <div class="search" style="margin-top:8px"><label class="sr-only" for="rs-q">${T('send.search', 'Search by name or area')}</label>${icon('search')}<input class="input" id="rs-q" placeholder="${T('send.search', 'Search by name or area')}" autocomplete="off"></div>
          <div id="rs-provs" role="radiogroup" aria-labelledby="rs-to-l" style="margin-top:8px">${MC.skeleton(2)}</div></div>
        <div class="fields two"><div class="field"><label for="rs-u">${T('send.urgency', 'How urgent?')}</label><select class="input" id="rs-u" name="urgency">${URGENCY.map(u => html`<option value="${u}" ${u === 'routine' ? 'selected' : ''}>${urgLabel(u)}</option>`)}</select></div>
          <div class="field"><label for="rs-s">${T('send.service', 'Service needed')}</label><select class="input" id="rs-s" name="service">${SERVICES.map(s => html`<option value="${s}">${svcLabel(s)}</option>`)}</select></div></div>
        <div class="field"><label for="rs-sp">${T('send.specialty', 'Specialty (optional)')}</label><input class="input" id="rs-sp" name="specialty" maxlength="80" placeholder="${T('send.specialty_ph', 'e.g. Cardiology')}" autocomplete="off"></div>
        <div class="field"><label for="rs-r">${T('send.reason', 'Reason for referral')}</label><textarea class="input" id="rs-r" name="reason" minlength="5" maxlength="500" required></textarea><div class="hint">${T('send.reason_hint', 'The receiving front desk reads this first. Say what you found and what you need them to do.')}</div></div>
        <div class="field"><label for="rs-n">${T('send.note', 'Clinical note (optional)')}</label><textarea class="input" id="rs-n" name="clinicalNote" maxlength="3000"></textarea><div class="hint">${T('send.note_hint', 'Only staff at your provider and the receiving provider see this. The patient does not.')}</div></div>
        <label class="check"><input type="checkbox" name="includeRecord" checked><span>${T('send.include', 'Share a record summary')}<br><span class="sm muted">${T('send.include_hint', 'Copies allergies, conditions, current medicines, the last 5 visits with diagnoses, recent lab results and the last vitals into the referral. The patient\'s active HMO cover is attached automatically.')}</span></span></label>
        <div class="field" id="rs-consent"><label class="check"><input type="checkbox" name="consent"><span>${T('send.consent', 'The patient agrees to this referral and to sharing their record summary')}</span></label>
          <span class="label">${T('send.consent_how', 'How did they agree?')}</span>
          <div class="row wrap"><label class="check"><input type="radio" name="consentMethod" value="verbal" checked><span>${T('consent.verbal', 'Verbally')}</span></label><label class="check"><input type="radio" name="consentMethod" value="written"><span>${T('consent.written', 'In writing')}</span></label></div>
          <div class="notice warn" id="rs-em-hint" hidden>${T('send.emergency_hint', 'Emergency: you can send without consent. It is recorded as an emergency referral. Phone the receiving provider as well.')}</div></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('send.submit', 'Send referral'), primary: true }],
      onOpen: d => {
        dlg = d;
        let t = null; const q = d.querySelector('#rs-q');
        q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { st.q = q.value.trim(); loadProvs(); }, 300); });
        q.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
        d.addEventListener('change', e => { if (e.target.name === 'toOrgId') st.sel = e.target.value; if (e.target.name === 'urgency') d.querySelector('#rs-em-hint').hidden = e.target.value !== 'emergency'; });
        loadProvs();
      },
      onSubmit: d => {
        const details = [];
        if (!d.toOrgId) details.push({ field: 'toOrgId', error: T('send.need_to', 'Choose the provider to refer to') });
        const reason = (d.reason || '').trim();
        if (reason.length < 5) details.push({ field: 'reason', error: T('send.need_reason', 'Write the reason (at least 5 characters)') });
        if (d.urgency !== 'emergency' && !d.consent) details.push({ field: 'consent', error: T('send.need_consent', 'Confirm the patient agrees, or choose Emergency if they cannot') });
        if (details.length) throw err400(details[0].error, details);
        return api.post('/api/referrals', { patientId: patient.id, toOrgId: d.toOrgId, urgency: d.urgency, service: d.service, specialty: d.specialty ? d.specialty.trim() : undefined, reason,
          clinicalNote: d.clinicalNote ? d.clinicalNote.trim() : undefined, includeRecord: !!d.includeRecord, consent: !!d.consent, consentMethod: d.consent ? d.consentMethod : undefined });
      } });
    dlg = null;
    if (!v) return null;
    toast(T('send.done', 'Referral {n} sent to {org}', { n: v.number, org: v.toOrgName }), 'ok');
    MC.go(PREFIX + '/' + v.id);
    return v;
  }

  function routes(prefix, opts) {
    PREFIX = prefix || '#/referrals'; OPTS = opts || {};
    return { [PREFIX]: listPage, [PREFIX + '/:id']: detailPage };
  }

  MC.referrals = { routes, navItem, sendDialog, refreshCount, homeNotice, canSend, canReceive, urgencyBadge: urgBadge, statusBadge: stBadge };
})();
