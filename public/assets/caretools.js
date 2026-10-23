/*
 * MediCore care tools kit: shared care, documents (scans, letters, signed forms), emergency transfers and stores.
 * Shared by the front desk, doctor, pharmacy, lab, dispatch and admin apps. Load after mc.js (and referrals.js), before the app.
 *
 *   MC.caretools.actions(patient)              -> buttons for a patient page (share care, add document, transfer)
 *   MC.caretools.panels(patient)               -> panels for a patient page (care team, documents); then
 *   MC.caretools.load(patient, stale)          -> fills them
 *   MC.caretools.routes({ patientHref })       -> routes: #/shared-care, #/transfers, #/transfers/:id, #/store
 *   MC.caretools.nav.shares() / transfers() / store()   -> nav entries (shown by permission and HQ feature switch)
 *   MC.caretools.refreshCount()                -> badge with shared-care requests waiting for this provider
 */
(function () {
  'use strict';
  const { html, api, qs, icon, badge, empty, view, on, form, dialog, confirm, toast, dateTime, date, ago, cap, money } = MC;
  const T = (k, en, v) => MC.t('ct.' + k, en, v);
  const can = p => !!(MC.me && (MC.me.perms || []).includes(p));
  const canAny = (...ps) => ps.some(can);
  const hasMod = m => !!(MC.me && MC.me.org && (MC.me.org.modules || []).includes(m));
  const feat = n => { const c = MC.config(); return !(c && c.features && c.features[n] === false); };
  const back = (href, label) => html`<a class="back" href="${href}">${icon('left')}${label}</a>`;
  const lines = text => String(text || '').split('\n').map((l, i) => html`${i ? html`<br>` : ''}${l}`);
  let OPTS = { patientHref: pid => '#/patient/' + pid };
  const ApiErr = msg => new MC.ApiError(400, { error: msg });

  (function styles() {
    const s = document.createElement('style');
    s.textContent = [
      '.ct-team{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}.ct-team .chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:6px 12px;background:var(--surface);font-weight:700;font-size:var(--t-sm)}',
      '.ct-msgs{display:flex;flex-direction:column;gap:8px;max-height:320px;overflow:auto;margin-bottom:10px}.ct-msg{padding:8px 12px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.ct-msg.you{background:var(--hue-soft)}.ct-msg .who{display:block;font-size:var(--t-xs);color:var(--ink-3)}',
      '.ct-pages{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}.ct-pages img{width:100%;height:auto;border:1px solid var(--line);border-radius:8px;background:#fff}',
      '.ct-sig{width:100%;height:160px;border:2px dashed var(--line);border-radius:10px;background:#fff;touch-action:none;display:block}',
      '.ct-paper{background:#fff;color:#111;padding:28px;border:1px solid var(--line);border-radius:8px;font-size:15px;line-height:1.55}.ct-paper h3{margin:0 0 4px}.ct-paper .lh{border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:16px}.ct-paper .sig img{max-height:70px}',
      '.ct-map{height:320px;border-radius:var(--r);overflow:hidden;border:1px solid var(--line);margin-bottom:12px}',
      '.ct-phones{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}.ct-code{font-size:2rem;font-weight:700;letter-spacing:.2em;text-align:center;border:2px dashed var(--hue);border-radius:10px;padding:8px;margin:8px 0}',
      '@media print{body *{visibility:hidden!important}.ct-print,.ct-print *{visibility:visible!important}.ct-print{position:absolute;left:0;top:0;width:100%;border:0}.dlg-head,.dlg-foot{display:none!important}}',
    ].join('\n');
    document.head.appendChild(s);
  })();

  /* ================= labels ================= */
  const PURPOSE_EN = { ongoing_treatment: 'Ongoing treatment', medicines: 'Medicines and refills', lab_monitoring: 'Regular lab tests', specialist_care: 'Specialist care', physiotherapy: 'Physiotherapy', maternity: 'Maternity care', home_care: 'Home care', second_opinion: 'Second opinion', other: 'Other' };
  const purposeLabel = p => T('purpose.' + p, PURPOSE_EN[p] || cap(p));
  const SHARE_ST_EN = { pending_patient: 'Waiting for the patient', pending_provider: 'Waiting for the provider', active: 'Active', ended: 'Ended', declined: 'Declined', revoked: 'Withdrawn by the patient', cancelled: 'Cancelled', expired: 'Ended (date passed)' };
  const SHARE_KIND = { pending_patient: 'warn', pending_provider: 'warn', active: 'ok', ended: '', declined: 'bad', revoked: 'bad', cancelled: '', expired: '' };
  const shareBadge = s => badge(T('sst.' + s, SHARE_ST_EN[s] || cap(s)), SHARE_KIND[s] || '');
  const CAT_EN = { case_notes: 'Case notes or folder', referral_letter: 'Referral letter', lab_result: 'Lab result', imaging: 'X-ray or scan report', prescription: 'Prescription', discharge_summary: 'Discharge summary', consent_form: 'Consent form', id_card: 'ID card', hmo_card: 'HMO card', birth_record: 'Birth record', immunisation: 'Immunisation card', invoice_receipt: 'Invoice or receipt', other: 'Other' };
  const catLabel = c => T('cat.' + c, CAT_EN[c] || cap(c));
  const LETTER_EN = { medical_report: 'Medical report', sick_note: 'Sick note', referral_letter: 'Referral letter', discharge_summary: 'Discharge summary', fitness_certificate: 'Medical fitness certificate' };
  const letterLabel = c => T('letter.' + c, LETTER_EN[c] || cap(c));
  const SIGNER_EN = { self: 'The patient', parent: 'Parent', guardian: 'Guardian', next_of_kin: 'Next of kin', spouse: 'Husband or wife', other: 'Other' };
  const signerLabel = c => T('signer.' + c, SIGNER_EN[c] || cap(c));
  const SVC_EN = { emergency: 'Emergency', icu: 'ICU', nicu: 'Newborn ICU', maternity: 'Maternity', trauma: 'Trauma', burns: 'Burns', dialysis: 'Dialysis', surgery: 'Surgery', paediatrics: 'Children', psychiatry: 'Mental health', oncology: 'Cancer care', cardiology: 'Heart care', neurosurgery: 'Neurosurgery', blood_bank: 'Blood bank', ct_scan: 'CT scan', mri: 'MRI', isolation: 'Isolation', antivenom: 'Antivenom' };
  const svcLabel = s => T('svc.' + s, SVC_EN[s] || cap(s));
  const OUT_EN = { requested: 'Requested', no_answer: 'No answer', accepted: 'Accepted', declined: 'Declined', en_route: 'On the way', arrived: 'Arrived', cancelled: 'Cancelled' };
  const outLabel = o => T('out.' + o, OUT_EN[o] || cap(o));
  const OUT_KIND = { requested: 'warn', no_answer: 'warn', accepted: 'ok', declined: 'bad', en_route: 'info', arrived: 'ok', cancelled: '' };
  const PHONE_EN = { main: 'Main line', emergency: 'Emergency', transfer: 'Referral desk', ambulance: 'Ambulance', whatsapp: 'WhatsApp', other: 'Other' };
  const phoneLabel = k => T('ph.' + k, PHONE_EN[k] || cap(k));
  const DEPT_EN = { general: 'General store', ward: 'Wards', emergency: 'Emergency', theatre: 'Theatre', maternity: 'Maternity', clinic: 'Clinic', lab: 'Laboratory', ambulance: 'Ambulances', dialysis: 'Dialysis', radiology: 'Radiology' };
  const deptLabel = d => T('dept.' + d, DEPT_EN[d] || cap(d));
  const STCAT_EN = { consumable: 'Consumable', reagent: 'Reagent', equipment: 'Equipment', blood: 'Blood', vaccine: 'Vaccine', oxygen: 'Oxygen', linen: 'Linen', other: 'Other' };
  const stcatLabel = c => T('stcat.' + c, STCAT_EN[c] || cap(c));
  const WARD_EN = { emergency: 'Emergency', general: 'General ward', maternity: 'Maternity', paediatric: 'Children', icu: 'ICU', nicu: 'Newborn ICU', hdu: 'High dependency', isolation: 'Isolation', dialysis: 'Dialysis', theatre: 'Theatre', psychiatric: 'Mental health', burns: 'Burns' };
  const wardLabel = w => T('ward.' + w, WARD_EN[w] || cap(w));
  const STATE_EN = { in_stock: 'Available', low: 'Running low', out: 'Out of stock' };
  const stateBadge = s => badge(T('state.' + s, STATE_EN[s] || cap(s)), s === 'in_stock' ? 'ok' : s === 'low' ? 'warn' : 'bad');
  const MOVE_EN = { receive: 'Receive stock', issue: 'Issue', adjust: 'Adjust', count: 'Count', waste: 'Write off', return: 'Return to store' };
  const moveLabel = m => T('mv.' + m, MOVE_EN[m] || cap(m));
  const tel = p => html`<a class="btn sm" href="${'tel:' + p.number}">${icon('phone')}${phoneLabel(p.kind)}: ${p.number}</a>`;

  /* ================= nav and counts ================= */
  const nav = {
    shares: o => Object.assign({ href: '#/shared-care', label: T('nav.shares', 'Shared care'), icon: 'users', anyPerm: ['careshare.manage'], show: () => MC.feature('careSharing') }, o || {}),
    transfers: o => Object.assign({ href: '#/transfers', label: T('nav.transfers', 'Emergency transfers'), short: T('nav.transfers_short', 'Transfers'), icon: 'ambulance', anyPerm: ['transfer.manage'], show: () => MC.feature('transfers') }, o || {}),
    store: o => Object.assign({ href: '#/store', label: T('nav.store', 'Stores and beds'), short: T('nav.store_short', 'Stores'), icon: 'box', anyPerm: ['inventory.read', 'inventory.manage', 'inventory.issue', 'capacity.update'], show: () => MC.feature('inventory') }, o || {}),
  };
  async function refreshCount() {
    if (!can('careshare.manage') || !MC.feature('careSharing')) return 0;
    try { const r = await api.get('/api/care-shares?box=in&status=pending_provider'); MC.navCount('#/shared-care', r.waiting || 0); return r.waiting; } catch (e) { return 0; }
  }

  /* ================= patient page: actions and panels ================= */
  function actions(p) {
    return html`${can('careshare.manage') && MC.feature('careSharing') ? html`<button class="btn" data-action="ct-share" data-p="${p.id}" data-name="${p.name}">${icon('users')}${T('share.btn', 'Share care')}</button>` : ''}
      ${can('transfer.manage') && MC.feature('transfers') ? html`<a class="btn" href="#/transfers${qs({ patient: p.id })}">${icon('ambulance')}${T('tr.btn', 'Emergency transfer')}</a>` : ''}`;
  }
  function panels(p) {
    return html`${MC.feature('careSharing') && canAny('careshare.manage', 'patient.read', 'clinic.consult') ? html`<section class="panel" id="ct-team-${p.id}"><h2>${T('team.title', 'Care team')}</h2>${MC.skeleton(1)}</section>` : ''}
      ${MC.feature('documents') && canAny('docs.read', 'docs.upload', 'docs.issue', 'clinic.consult') ? html`<section class="panel" id="ct-docs-${p.id}"><h2>${T('docs.title', 'Documents')}</h2>${MC.skeleton(1)}</section>` : ''}
      ${MC.feature('wearables') && canAny('patient.read', 'clinic.consult', 'vitals.record') ? html`<section class="panel" id="ct-wear-${p.id}"><h2>${T('w.title', 'Health devices')}</h2>${MC.skeleton(1)}</section>` : ''}`;
  }
  async function load(p, stale) {
    const team = document.getElementById('ct-team-' + p.id); const docs = document.getElementById('ct-docs-' + p.id);
    const [t, d] = await Promise.all([team ? api.get('/api/care-team/' + p.id).catch(() => null) : null, docs ? api.get('/api/docs/patients/' + p.id).catch(() => null) : null]);
    if (stale && stale()) return;
    if (team) MC.view(teamBody(p, t), team);
    if (docs) MC.view(docsBody(p, d), docs);
    const wear = document.getElementById('ct-wear-' + p.id); if (wear) wearPanel(p.id, wear);
    const box = document.getElementById('ct-msgs-' + p.id); if (box) box.scrollTop = box.scrollHeight;
  }
  function teamBody(p, t) {
    if (!t) return html`<h2>${T('team.title', 'Care team')}</h2><p class="muted sm">${T('team.err', 'Could not load the care team.')}</p>`;
    const open = t.shares.filter(s => ['pending_patient', 'pending_provider', 'active'].includes(s.status));
    return html`<h2>${T('team.title', 'Care team')}</h2>
      ${t.team.length ? html`<div class="ct-team">${t.team.map(m => html`<span class="chip">${icon(m.you ? 'home' : 'building')}${m.name}${m.you ? html` <span class="muted">(${T('team.you', 'you')})</span>` : ''}</span>`)}</div>` : html`<p class="muted sm">${T('team.none', 'Only your provider looks after this patient. Share their care to work with a pharmacy, lab or another hospital on one record.')}</p>`}
      ${open.length ? html`<ul class="list">${open.map(s => html`<li><div class="grow"><span class="title">${s.direction === 'in' ? s.fromOrgName : s.toOrgName} | ${purposeLabel(s.purpose)}</span><span class="sub">${s.number} | ${s.status === 'active' && s.endsAt ? T('share.until', 'Until {d}', { d: date(s.endsAt) }) : dateTime(s.createdAt)}${s.note ? ' | ' + s.note : ''}</span></div>
        <span class="end">${shareBadge(s.status)}${can('careshare.manage') ? html` ${s.direction === 'in' && s.status === 'pending_provider' ? html`<button class="btn sm primary" data-action="ct-accept" data-id="${s.id}" data-p="${p.id}">${T('share.accept', 'Accept')}</button>` : ''}${s.direction === 'out' && s.status === 'pending_patient' ? html`<button class="btn sm" data-action="ct-code" data-id="${s.id}" data-p="${p.id}">${T('share.code', 'Consent by SMS code')}</button>` : ''}<button class="btn sm" data-action="ct-end" data-id="${s.id}" data-p="${p.id}">${s.status === 'active' ? T('share.end', 'End') : T('share.cancel', 'Cancel')}</button>` : ''}</span></li>`)}</ul>` : ''}
      ${t.canWrite ? html`<h3>${T('team.msgs', 'Care team messages')}</h3><div class="ct-msgs" id="ct-msgs-${p.id}">${t.messages.length ? t.messages.map(m => html`<div class="ct-msg ${m.you ? 'you' : ''}"><span class="who">${m.byName}${m.role ? ', ' + m.role : ''} | ${m.orgName} | ${dateTime(m.at)}</span>${lines(m.text)}</div>`) : html`<p class="muted sm">${T('team.no_msgs', 'No messages yet. Only providers on the care team see them.')}</p>`}</div>
        <form class="row" data-form="ct-msg" data-p="${p.id}" novalidate><input class="input" name="text" required maxlength="2000" placeholder="${T('team.msg_ph', 'Write to the care team')}" aria-label="${T('team.msg_ph', 'Write to the care team')}" style="flex:1"><button class="btn primary" type="submit">${T('team.send', 'Send')}</button></form>` : ''}`;
  }
  function docsBody(p, list) {
    const rows = list || [];
    const kindIcon = d => (d.kind === 'letter' ? 'file' : d.kind === 'form' ? 'edit' : 'clipboard');
    return html`<h2>${T('docs.title', 'Documents')}</h2>
      <div class="btn-row" style="margin-top:0">${can('docs.upload') ? html`<button class="btn" data-action="ct-upload" data-p="${p.id}">${icon('plus')}${T('docs.scan', 'Scan or upload')}</button>` : ''}
        ${can('docs.issue') ? html`<button class="btn" data-action="ct-letter" data-p="${p.id}">${icon('file')}${T('docs.letter', 'Write a letter or note')}</button>` : ''}
        ${can('docs.forms') ? html`<button class="btn" data-action="ct-form" data-p="${p.id}">${icon('edit')}${T('docs.form', 'Consent form')}</button>` : ''}</div>
      ${rows.length ? html`<div class="list">${rows.map(d => html`<a href="#" data-action="ct-doc" data-id="${d.id}" data-p="${p.id}">${icon(kindIcon(d))}<div class="grow"><span class="title">${d.title}</span><span class="sub">${[catLabel(d.category), d.docDate || date(d.createdAt), d.byPatient ? T('docs.from_patient', 'Added by the patient') : d.orgName, d.files.length > 1 ? T('docs.pages', '{n} pages', { n: d.files.length }) : ''].filter(Boolean).join(' | ')}</span></div>${d.status === 'cancelled' ? badge(T('docs.cancelled', 'Cancelled'), 'bad') : d.verifyCode ? badge(T('docs.verifiable', 'Verifiable'), 'ok') : ''}</a>`)}</div>`
        : html`<p class="muted sm">${T('docs.none', 'No documents yet. Scan old folders and outside results so the whole team has them.')}</p>`}`;
  }
  const docCache = {};
  async function reloadPanels(pid) { const p = { id: pid }; await load(p); }

  /* ---------------- shared care ---------------- */
  /* ---------------- health devices: the patient's wearable and home readings, and asking for a fresh one ---------------- */
  const WL = () => ({ steps: T('w.steps', 'Steps'), heart_rate: T('w.hr', 'Heart rate'), resting_hr: T('w.rhr', 'Resting heart rate'), spo2: T('w.spo2', 'Blood oxygen'), bp: T('w.bp', 'Blood pressure'), glucose: T('w.glucose', 'Blood sugar'), temperature: T('w.temp', 'Temperature'), weight: T('w.weight', 'Weight'), sleep: T('w.sleep', 'Sleep'), hrv: T('w.hrv', 'Heart rate variability') });
  const wv = (k, r) => (k === 'bp' ? r.value + '/' + r.value2 : k === 'sleep' ? Math.round(r.value / 6) / 10 + ' h' : r.value);
  const wf = f => (f === 'urgent' ? badge(T('w.urgent', 'Urgent'), 'bad') : f === 'high' ? badge(T('w.high', 'High'), 'warn') : f === 'low' ? badge(T('w.low', 'Low'), 'warn') : '');
  const canAsk = () => canAny('clinic.consult', 'vitals.record');
  async function wearPanel(pid, el, opts) {
    const w = await api.get('/api/fd/patients/' + pid + '/wearables').catch(() => null);
    if (!w) { MC.view(html`<h2>${T('w.title', 'Health devices')}</h2><p class="muted sm">${T('w.unavail', 'Not available.')}</p>`, el); return; }
    const L = WL(); const open = (w.requests || []).filter(q => q.status === 'open' && q.expiresAt > Date.now());
    const askBtn = canAsk() ? html`<button class="btn sm" data-action="ct-wreq" data-p="${pid}">${icon('heart')}${T('w.ask', 'Ask for a reading')}</button>` : '';
    const reqLine = (w.requests || []).slice(0, 2).map(q => html`<div class="xs muted">${T('w.req_line', 'Asked {t} for {what}: {st}', { t: dateTime(q.createdAt), what: q.types.map(x => L[x] || x).join(', '), st: q.status === 'received' ? T('w.st_received', 'received') : q.status === 'open' ? T('w.st_open', 'waiting for the patient') : T('w.st_' + q.status, q.status) })}</div>`);
    if (!w.shared) { MC.view(html`<div class="row between wrap"><h2 style="margin:0">${T('w.title', 'Health devices')}</h2>${askBtn}</div><p class="muted sm">${T('w.not_shared', 'The patient has not shared device readings with you. Asking for a reading also asks them to share.')}</p>${reqLine}`, el); return; }
    const st = Object.values(w.stats || {});
    MC.view(html`<div class="row between wrap"><h2 style="margin:0">${T('w.title', 'Health devices')}</h2>${askBtn}</div>
      ${open.length ? html`<div class="notice">${T('w.waiting', 'Waiting for the patient to take and sync: {what}', { what: open[0].types.map(x => L[x] || x).join(', ') })}</div>` : ''}
      ${st.length ? html`<div class="table-wrap"><table class="t"><thead><tr><th>${T('w.c_type', 'Reading')}</th><th>${T('w.c_latest', 'Latest')}</th><th>${T('w.c_avg', '7-day average')}</th><th>${T('w.c_when', 'When')}</th></tr></thead><tbody>${st.map(x => html`<tr><td>${L[x.type] || x.label}</td><td><b>${wv(x.type, x.latest)}</b> ${x.type === 'sleep' ? '' : x.unit} ${wf(x.latest.flag)}</td><td>${x.type === 'bp' ? x.average + '/' + x.average2 : x.type === 'sleep' ? Math.round(x.average / 6) / 10 + ' h' : Math.round(x.average)}</td><td class="sm">${ago(x.latest.at)}</td></tr>`)}</tbody></table></div>`
        : html`<p class="muted sm">${T('w.none', 'No readings in the last 7 days.')}</p>`}
      <div id="ct-wsum-${pid}" class="notice" style="margin-top:10px">${T('w.sum_wait', 'Summarising...')}</div>${reqLine}`, el);
    api.get('/api/fd/patients/' + pid + '/wearables/summary').then(r => { const b = document.getElementById('ct-wsum-' + pid); if (b) MC.view(html`<b>${r.by === 'ai' ? T('w.ai', 'Assistant summary') : T('w.rules', 'Summary')}:</b> ${r.text}`, b); }).catch(() => { const b = document.getElementById('ct-wsum-' + pid); if (b) b.remove(); });
    if (opts && opts.poll && !el.dataset.polling) { el.dataset.polling = '1'; MC.poll(async () => { if (!document.body.contains(el)) return; await wearPanel(pid, el); }, opts.poll); }
  }
  on('ct-wreq', async el => {
    const L = WL(); const KS = ['heart_rate', 'spo2', 'bp', 'temperature', 'glucose', 'steps'];
    const d = await dialog({ title: T('w.ask_t', 'Ask the patient for a fresh reading'), form: true, body: html`<p class="sm">${T('w.ask_b', 'The patient gets a message to take the reading on their watch or home device and sync it. You see it here as soon as it arrives.')}</p>
      <div class="field"><span class="label">${T('w.which', 'Readings')}</span>${KS.map((k, i) => html`<label class="check"><input type="checkbox" name="t_${k}" ${i < 2 ? 'checked' : ''}><span>${L[k]}</span></label>`)}</div>
      <div class="field"><label for="wr-n">${T('w.note', 'Note to the patient (optional)')}</label><input class="input" id="wr-n" name="note" maxlength="200" placeholder="${T('w.note_ph', 'e.g. sit quietly for 5 minutes first')}"></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('w.send', 'Send request'), primary: true }],
      onSubmit: f => { const types = KS.filter(k => f['t_' + k]); if (!types.length) throw new MC.ApiError(400, { error: T('w.need_type', 'Choose at least one reading') }); return api.post('/api/fd/patients/' + el.dataset.p + '/reading-requests', { types, note: f.note || undefined }); } });
    if (d) { toast(T('w.sent', 'Request sent to the patient'), 'ok'); const box = document.getElementById('ct-wear-' + el.dataset.p) || document.getElementById('vc-wear'); if (box) wearPanel(el.dataset.p, box); }
  });
  on('ct-share', async el => { await shareDialog({ id: el.dataset.p, name: el.dataset.name }); });
  async function shareDialog(p) {
    const provs = await api.get('/api/network/providers').catch(() => []);
    const opts = (provs || []).filter(o => o.acceptsReferrals !== false);
    const r = await dialog({ title: T('share.title', 'Share {name}\'s care', { name: p.name }), wide: true, form: true, body: html`
      <p class="muted sm">${T('share.intro', 'The other provider joins the care team: both of you see this patient\'s records while the share is active, and you can talk in one place. The patient must agree.')}</p>
      <div class="field"><label for="ct-to">${T('share.to', 'Share with')}</label><select class="input" id="ct-to" name="toOrgId" required><option value="">${T('share.pick', 'Choose a provider')}</option>${opts.map(o => html`<option value="${o.id}">${o.name}${o.area ? ' (' + o.area + ')' : ''}${o.connection && o.connection.status === 'accepted' ? ' *' : ''}</option>`)}</select><div class="hint">${T('share.partners_hint', 'Partners are marked with *.')}</div></div>
      <div class="fields two"><div class="field"><label for="ct-pu">${T('share.purpose', 'Why')}</label><select class="input" id="ct-pu" name="purpose" required>${Object.keys(PURPOSE_EN).map(k => html`<option value="${k}">${purposeLabel(k)}</option>`)}</select></div>
        <div class="field"><label for="ct-days">${T('share.days', 'For how long')}</label><select class="input" id="ct-days" name="days"><option value="30">${T('share.d30', '1 month')}</option><option value="90">${T('share.d90', '3 months')}</option><option value="180" selected>${T('share.d180', '6 months')}</option><option value="365">${T('share.d365', '1 year')}</option></select></div></div>
      <div class="field"><label for="ct-note">${T('share.note', 'Note for the other provider')}</label><textarea class="input" id="ct-note" name="note" maxlength="1000" rows="3"></textarea></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('share.send', 'Send request'), primary: true }],
      onSubmit: d => api.post('/api/care-shares', { patientId: p.id, toOrgId: d.toOrgId, purpose: d.purpose, note: d.note, days: Number(d.days) }) });
    if (!r) return;
    if (r.status === 'pending_patient') {
      if (r.canUseCode && (await confirm({ title: T('share.consent_q', 'Get the patient\'s agreement now?'), body: r.patientHasApp ? T('share.consent_app', 'The patient was asked in the app. If they are with you, they can agree with an SMS code instead.') : T('share.consent_noapp', 'This patient does not use the app. Send them an SMS code and type the code they read back.'), ok: T('share.code', 'Consent by SMS code') }))) await codeConsent(r.id);
      else toast(T('share.sent_patient', 'Request sent. The patient will be asked in the app.'), 'ok');
    } else toast(T('share.sent', 'Request sent to {org}', { org: r.toOrgName }), 'ok');
    MC.render();
  }
  async function codeConsent(id) {
    const s = await api.post('/api/care-shares/' + id + '/consent-code/send');
    const v = await dialog({ title: T('share.code_title', 'Patient\'s agreement'), form: true, body: html`<p>${T('share.code_body', 'We sent a 6-digit code to the patient\'s phone. Ask them to read it to you.')}</p>${s.devCode ? html`<p class="notice">${T('share.demo_code', 'Demo code: {c}', { c: s.devCode })}</p>` : ''}<div class="field"><label for="ct-cd">${T('share.code_label', 'Code')}</label><input class="input" id="ct-cd" name="code" inputmode="numeric" maxlength="6" required></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('share.code_ok', 'Confirm agreement'), primary: true }], onSubmit: d => api.post('/api/care-shares/' + id + '/consent-code/verify', { code: d.code }) });
    if (v) toast(T('share.agreed', 'The patient agreed. The other provider has been asked to accept.'), 'ok');
  }
  on('ct-code', async el => { await codeConsent(el.dataset.id); MC.render(); });
  on('ct-accept', async el => { const r = await api.post('/api/care-shares/' + el.dataset.id + '/accept'); toast(T('share.accepted', 'You joined the care team. Record number {mrn}.', { mrn: r.mrn || '' }), 'ok'); refreshCount(); MC.render(); });
  on('ct-decline', async el => {
    const v = await dialog({ title: T('share.decline', 'Decline'), form: true, body: html`<div class="field"><label for="ct-dr">${T('share.reason', 'Reason')}</label><input class="input" id="ct-dr" name="reason" required minlength="3" maxlength="300"></div>`, actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('share.decline', 'Decline'), primary: true }], onSubmit: d => api.post('/api/care-shares/' + el.dataset.id + '/decline', { reason: d.reason }) });
    if (v) { refreshCount(); MC.render(); }
  });
  on('ct-end', async el => {
    const v = await dialog({ title: T('share.end_title', 'End shared care'), form: true, body: html`<p class="muted sm">${T('share.end_body', 'The other provider stops seeing your records for this patient (and you theirs).')}</p><div class="field"><label for="ct-er">${T('share.reason', 'Reason')}</label><input class="input" id="ct-er" name="reason" required minlength="3" maxlength="300"></div>`, actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('share.end', 'End'), primary: true }], onSubmit: d => api.post('/api/care-shares/' + el.dataset.id + '/end', { reason: d.reason }) });
    if (v) MC.render();
  });
  form('ct-msg', async (d, f) => { const pid = f.dataset.p; await api.post('/api/care-team/' + pid + '/messages', { text: d.text }); await load({ id: pid }); });

  async function sharesPage({ query }) {
    const box = query.box === 'out' ? 'out' : 'in';
    const r = await api.get('/api/care-shares' + qs({ box }));
    MC.navCount('#/shared-care', box === 'in' ? r.waiting : undefined);
    view(html`<div class="page-head"><div><h1>${T('nav.shares', 'Shared care')}</h1><p>${T('shares.sub', 'Patients you look after together with other providers')}</p></div></div>
      <div class="tabs" role="tablist"><a role="tab" href="#/shared-care?box=in" aria-selected="${box === 'in'}">${T('shares.in', 'Shared with you')}${r.waiting && box === 'in' ? ' (' + r.waiting + ')' : ''}</a><a role="tab" href="#/shared-care?box=out" aria-selected="${box === 'out'}">${T('shares.out', 'Shared by you')}</a></div>
      <section class="panel flush">${r.shares.length ? html`<ul class="list">${r.shares.map(s => html`<li><div class="grow"><span class="title">${s.patientName} | ${box === 'in' ? s.fromOrgName : s.toOrgName}</span><span class="sub">${s.number} | ${purposeLabel(s.purpose)} | ${dateTime(s.createdAt)}${s.note ? ' | ' + s.note : ''}</span></div>
        <span class="end">${shareBadge(s.status)} ${box === 'in' && s.status === 'pending_provider' ? html`<button class="btn sm primary" data-action="ct-accept" data-id="${s.id}">${T('share.accept', 'Accept')}</button><button class="btn sm" data-action="ct-decline" data-id="${s.id}">${T('share.decline', 'Decline')}</button>` : ''}${s.status === 'active' ? html`<a class="btn sm" href="${OPTS.patientHref(s.patientId)}">${T('shares.open', 'Open patient')}</a>` : ''}${box === 'out' && s.status === 'pending_patient' ? html`<button class="btn sm" data-action="ct-code" data-id="${s.id}">${T('share.code', 'Consent by SMS code')}</button>` : ''}</span></li>`)}</ul>`
        : empty({ icon: 'users', title: box === 'in' ? T('shares.none_in', 'No patients shared with you') : T('shares.none_out', 'You have not shared any patients'), body: T('shares.how', 'Share a patient from their page: Share care.') })}</section>`);
  }

  /* ---------------- documents ---------------- */
  let META = null;
  async function meta() { if (!META) META = await api.get('/api/docs/meta'); return META; }
  const fileInputs = id => html`<div class="field"><span class="label">${T('docs.page', 'Page')}</span><div class="btn-row" style="margin:0"><label class="btn" for="${id}-cam">${icon('eye')}${T('docs.camera', 'Take a photo')}</label><label class="btn" for="${id}-file">${icon('download')}${T('docs.choose', 'Choose a file')}</label></div>
    <input type="file" id="${id}-cam" accept="image/*" capture="environment" hidden data-upl><input type="file" id="${id}-file" accept="image/*,application/pdf" hidden data-upl><div class="hint" id="${id}-name">${T('docs.limit', 'Photos are made smaller before sending. PDF files up to {mb} MB.', { mb: META ? META.maxFileMb : 3 })}</div></div>`;
  function wireFiles(d, id) { let picked = null; d.querySelectorAll('input[data-upl]').forEach(inp => inp.addEventListener('change', () => { picked = inp.files[0] || picked; const n = d.querySelector('#' + id + '-name'); if (n && picked) n.textContent = picked.name; })); return () => picked; }
  on('ct-upload', async el => {
    const pid = el.dataset.p; const m = await meta(); let getFile = null;
    const doc = await dialog({ title: T('docs.scan', 'Scan or upload'), wide: true, form: true, body: html`
      <div class="fields two"><div class="field"><label for="du-cat">${T('docs.category', 'What is it')}</label><select class="input" id="du-cat" name="category" required>${m.categories.map(c => html`<option value="${c}">${catLabel(c)}</option>`)}</select></div>
        <div class="field"><label for="du-date">${T('docs.date', 'Date on the paper')}</label><input class="input" id="du-date" name="docDate" type="date"></div></div>
      <div class="field"><label for="du-title">${T('docs.doc_title', 'Title')}</label><input class="input" id="du-title" name="title" required maxlength="120" placeholder="${T('docs.title_ph', 'For example: Old folder 2019 to 2024')}"></div>
      <div class="field"><label for="du-note">${T('docs.note', 'Note (optional)')}</label><input class="input" id="du-note" name="note" maxlength="1000"></div>${fileInputs('du')}`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('docs.save', 'Save'), primary: true }],
      onOpen: d => { getFile = wireFiles(d, 'du'); },
      onSubmit: async d => { const f = await MC.readUpload(getFile && getFile()); return api.post('/api/docs/patients/' + pid, { category: d.category, title: d.title, docDate: d.docDate, note: d.note, file: f }); } });
    if (!doc) return;
    // more pages
    for (let i = 2; i <= m.maxFiles; i++) {
      let gf = null;
      const more = await dialog({ title: T('docs.more_q', 'Add page {n}?', { n: i }), form: true, body: html`<p class="muted sm">${T('docs.more_body', 'Add the next page of the same document, or finish.')}</p>${fileInputs('dm' + i)}`,
        actions: [{ label: T('docs.finish', 'Finish'), value: null }, { label: T('docs.add_page', 'Add page'), primary: true }], onOpen: d => { gf = wireFiles(d, 'dm' + i); },
        onSubmit: async () => { const f = await MC.readUpload(gf && gf()); return api.post('/api/docs/' + doc.id + '/files', { file: f }); } });
      if (!more) break;
    }
    toast(T('docs.saved', 'Document saved to the record'), 'ok'); await reloadPanels(pid);
  });
  async function signatureSetup() {
    const s = (await meta()).signature || {};
    return dialog({ title: T('sig.title', 'My signature details'), form: true, body: html`<p class="muted sm">${T('sig.body', 'Letters and certificates you issue carry your name and licence number, and a code anyone can check online.')}</p>
      <div class="fields two"><div class="field"><label for="sg-t">${T('sig.ttl', 'Title')}</label><input class="input" id="sg-t" name="title" value="${s.title || ''}" maxlength="60" placeholder="${T('sig.ttl_ph', 'Consultant physician')}"></div><div class="field"><label for="sg-q">${T('sig.qual', 'Qualifications')}</label><input class="input" id="sg-q" name="qualifications" value="${s.qualifications || ''}" maxlength="120" placeholder="MBBS, FWACP"></div></div>
      <div class="fields two"><div class="field"><label for="sg-b">${T('sig.lbody', 'Licensing body')}</label><input class="input" id="sg-b" name="licenceBody" value="${s.licenceBody || 'MDCN'}" maxlength="40"></div><div class="field"><label for="sg-n">${T('sig.lno', 'Licence number')}</label><input class="input" id="sg-n" name="licenceNo" value="${s.licenceNo || ''}" required maxlength="40"></div></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('sig.save', 'Save'), primary: true }], onSubmit: async d => { await api.put('/api/docs/my-signature', d); META = null; return true; } });
  }
  on('ct-letter', async el => {
    const pid = el.dataset.p; const m = await meta();
    if (!m.signature || !m.signature.licenceNo) { if (!(await signatureSetup())) return; }
    const r = await dialog({ title: T('docs.letter', 'Write a letter or note'), wide: true, form: true, body: html`
      <div class="fields two"><div class="field"><label for="dl-t">${T('letter.type', 'Type')}</label><select class="input" id="dl-t" name="type">${m.letters.map(l => html`<option value="${l}">${letterLabel(l)}</option>`)}</select></div>
        <div class="field"><label for="dl-a">${T('letter.to', 'Addressed to')}</label><input class="input" id="dl-a" name="addressedTo" maxlength="160" placeholder="${T('letter.to_ph', 'To whom it may concern')}"></div></div>
      <div class="field"><label for="dl-d">${T('letter.dx', 'Diagnosis (leave empty for a sick note the employer sees)')}</label><input class="input" id="dl-d" name="diagnosis" maxlength="300"></div>
      <div class="field"><label for="dl-b">${T('letter.body', 'Letter')}</label><textarea class="input" id="dl-b" name="body" required rows="7" maxlength="6000"></textarea></div>
      <div class="fields two"><div class="field"><label for="dl-rf">${T('letter.rest_from', 'Rest from (sick note)')}</label><input class="input" id="dl-rf" name="restFrom" type="date"></div><div class="field"><label for="dl-rt">${T('letter.rest_to', 'Rest until')}</label><input class="input" id="dl-rt" name="restTo" type="date"></div></div>
      <div class="field"><label for="dl-r">${T('letter.recs', 'Recommendations (optional)')}</label><textarea class="input" id="dl-r" name="recommendations" rows="2" maxlength="2000"></textarea></div>
      <p class="muted sm"><a href="#" data-action="ct-sig">${T('sig.edit', 'Change my signature details')}</a></p>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('letter.issue', 'Issue and sign'), primary: true }], onSubmit: d => api.post('/api/docs/patients/' + pid + '/letters', d) });
    if (r) { toast(T('letter.issued', 'Issued. Code {c}', { c: r.verifyCode }), 'ok'); await reloadPanels(pid); showDoc(r, pid); }
  });
  on('ct-sig', async () => { await signatureSetup(); });
  on('ct-form', async el => {
    const pid = el.dataset.p; const m = await meta();
    const pick = await dialog({ title: T('docs.form', 'Consent form'), form: true, body: html`<div class="field"><label for="df-t">${T('form.which', 'Which form')}</label><select class="input" id="df-t" name="templateId">${m.forms.map(f => html`<option value="${f.id}">${f.title}${f.custom ? ' *' : ''}</option>`)}</select></div>`, actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('form.next', 'Next'), primary: true }] });
    if (!pick) return;
    const tpl = m.forms.find(f => f.id === pick.templateId); let pad = null;
    const field = f => f.type === 'select' ? html`<div class="field"><label for="ff-${f.key}">${f.label}</label><select class="input" id="ff-${f.key}" name="a_${f.key}" ${f.required ? 'required' : ''}>${(f.options || []).map(o => html`<option value="${o}">${cap(o)}</option>`)}</select></div>` : html`<div class="field"><label for="ff-${f.key}">${f.label}</label><input class="input" id="ff-${f.key}" name="a_${f.key}" type="${f.type === 'date' ? 'date' : 'text'}" maxlength="500" ${f.required ? 'required' : ''}></div>`;
    const r = await dialog({ title: tpl.title, wide: true, form: true, body: html`<div class="notice"><p class="sm" style="margin:0">${tpl.body}</p></div>${(tpl.fields || []).map(field)}
      <div class="fields two"><div class="field"><label for="ff-sn">${T('form.signer', 'Name of the person signing')}</label><input class="input" id="ff-sn" name="signerName" required maxlength="120"></div><div class="field"><label for="ff-sr">${T('form.relation', 'They are')}</label><select class="input" id="ff-sr" name="signerRelation">${m.signers.map(s => html`<option value="${s}">${signerLabel(s)}</option>`)}</select></div></div>
      <div class="fields two"><div class="field"><label for="ff-w">${T('form.witness', 'Witness')}${tpl.requireWitness ? ' *' : ''}</label><input class="input" id="ff-w" name="witnessName" maxlength="120" ${tpl.requireWitness ? 'required' : ''}></div><div class="field"><label for="ff-l">${T('form.language', 'Explained in (language)')}</label><input class="input" id="ff-l" name="language" maxlength="30"></div></div>
      <div class="field"><span class="label">${T('form.sign_here', 'Sign here')}</span><canvas class="ct-sig" id="ff-pad" aria-label="${T('form.sign_here', 'Sign here')}"></canvas><button type="button" class="btn sm" id="ff-clear">${T('form.clear', 'Clear')}</button></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('form.save', 'Save signed form'), primary: true }],
      onOpen: d => { pad = MC.signaturePad(d.querySelector('#ff-pad')); d.querySelector('#ff-clear').addEventListener('click', () => pad.clear()); },
      onSubmit: d => { if (pad.empty()) throw ApiErr(T('form.no_sig', 'Ask the person to sign in the box first')); const answers = {}; Object.keys(d).filter(k => k.startsWith('a_')).forEach(k => { answers[k.slice(2)] = d[k]; }); return api.post('/api/docs/patients/' + pid + '/forms', { templateId: tpl.id, answers, signerName: d.signerName, signerRelation: d.signerRelation, witnessName: d.witnessName, language: d.language, signature: pad.toDataURL() }); } });
    if (r) { toast(T('form.saved', 'Signed form saved to the record'), 'ok'); await reloadPanels(pid); }
  });
  on('ct-doc', async (el, ev) => { if (ev) ev.preventDefault(); const list = await api.get('/api/docs/patients/' + el.dataset.p); const d = list.find(x => x.id === el.dataset.id); if (d) showDoc(d, el.dataset.p); });
  async function showDoc(d, pid, opts) {
    const base = (opts && opts.blobBase) || '/api/docs/blobs/';
    const pages = [];
    for (const f of d.files || []) { try { const b = await api.blobUrl(base + f.blobId); pages.push(Object.assign({ url: b.url }, f)); } catch (e) { pages.push(Object.assign({ url: null }, f)); } }
    let sig = null; if (d.form && d.form.signatureBlobId) { try { sig = (await api.blobUrl(base + d.form.signatureBlobId)).url; } catch (e) { sig = null; } }
    const L = d.letter;
    const body = L ? html`<div class="ct-paper ct-print"><div class="lh"><h3>${L.provider.name}</h3><div class="sm">${[L.provider.address, L.provider.phone, L.provider.email].filter(Boolean).join(' | ')}</div></div>
        <p><b>${letterLabel(L.type)}</b><br>${T('letter.date', 'Date')}: ${L.issuedOn}</p>${L.addressedTo ? html`<p>${L.addressedTo}</p>` : ''}
        <p>${T('letter.patient', 'Patient')}: <b>${L.patient.name}</b>${L.patient.dob ? ', ' + T('letter.born', 'born {d}', { d: L.patient.dob }) : ''}${L.patient.mrn ? ', MRN ' + L.patient.mrn : ''}</p>
        ${L.diagnosis ? html`<p>${T('letter.dx_short', 'Diagnosis')}: ${L.diagnosis}</p>` : ''}<p>${lines(L.body)}</p>
        ${L.restFrom ? html`<p>${T('letter.rest', 'Rest from {a} to {b} inclusive.', { a: L.restFrom, b: L.restTo })}</p>` : ''}${L.recommendations ? html`<p>${lines(L.recommendations)}</p>` : ''}
        <p style="margin-top:28px"><b>${L.signer.name}</b><br>${[L.signer.title, L.signer.qualifications].filter(Boolean).join(', ')}<br>${L.signer.licenceBody} ${L.signer.licenceNo}</p>
        <p class="sm">${T('letter.verify', 'Check this document at {url} with code {c}.', { url: location.origin + '/register.html#/verify', c: d.verifyCode })}</p>${d.status === 'cancelled' ? html`<p class="notice bad">${T('docs.cancelled', 'Cancelled')}</p>` : ''}</div>`
      : d.form ? html`<div class="ct-paper ct-print"><div class="lh"><h3>${d.orgName || ''}</h3></div><h3>${d.form.title}</h3><p>${d.form.text}</p>
        <div class="sig">${sig ? html`<img src="${sig}" alt="${T('form.signature', 'Signature')}">` : ''}<p><b>${d.form.signerName}</b> (${signerLabel(d.form.signerRelation)}) | ${dateTime(d.form.signedAt)}${d.form.witnessName ? html`<br>${T('form.witness', 'Witness')}: ${d.form.witnessName}` : ''}${d.form.language ? html`<br>${T('form.language', 'Explained in (language)')}: ${d.form.language}` : ''}<br>${T('form.taken_by', 'Taken by {n}', { n: d.form.takenBy })}</p></div></div>`
      : html`<p class="muted sm">${[catLabel(d.category), d.docDate, d.byPatient ? T('docs.from_patient', 'Added by the patient') : d.orgName, d.createdByName].filter(Boolean).join(' | ')}</p>${d.note ? html`<p>${d.note}</p>` : ''}
        <div class="ct-pages">${pages.map((pg, i) => pg.url && /^image\//.test(pg.mime) ? html`<a href="${pg.url}" target="_blank" rel="noopener"><img src="${pg.url}" alt="${T('docs.page_n', 'Page {n}', { n: i + 1 })}"></a>` : pg.url ? html`<a class="btn" href="${pg.url}" target="_blank" rel="noopener">${icon('file')}${T('docs.open_pdf', 'Open PDF page {n}', { n: i + 1 })}</a>` : html`<p class="muted">${T('docs.page_err', 'Page {n} could not load', { n: i + 1 })}</p>`)}</div>`;
    const acts = [{ label: MC.t('kit.close', 'Close'), value: null }];
    if (L && d.status === 'active' && d.mine && can('docs.issue')) acts.unshift({ label: T('docs.cancel_letter', 'Cancel letter'), value: 'cancel' });
    if (!L && !d.form && d.mine && d.status === 'active' && can('docs.upload')) acts.unshift({ label: T('docs.remove', 'Remove'), value: 'remove' });
    const printBtn = L || d.form ? html`<div class="btn-row" style="margin-top:0"><button type="button" class="btn" id="ct-print">${icon('file')}${T('docs.print', 'Print')}</button></div>` : '';
    const v = await dialog({ title: d.title, wide: true, body: html`${printBtn}${body}`, actions: acts, onOpen: dd => { const pb = dd.querySelector('#ct-print'); if (pb) pb.addEventListener('click', () => window.print()); } });
    if (v === 'cancel' || v === 'remove') {
      const r = await dialog({ title: v === 'cancel' ? T('docs.cancel_letter', 'Cancel letter') : T('docs.remove', 'Remove'), form: true, body: html`<div class="field"><label for="dc-r">${T('share.reason', 'Reason')}</label><input class="input" id="dc-r" name="reason" required minlength="3" maxlength="300"></div>`, actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('kit.confirm', 'Confirm'), primary: true }], onSubmit: x => api.post('/api/docs/' + d.id + '/' + (v === 'cancel' ? 'cancel' : 'remove'), { reason: x.reason }) });
      if (r && pid) await reloadPanels(pid);
    }
  }

  /* ---------------- emergency transfers ---------------- */
  async function pickPatient(preset) {
    if (preset) { try { return await api.get('/api/fd/patients/' + preset); } catch (e) { /* fall through */ } }
    return dialog({ title: T('tr.which_patient', 'Which patient?'), form: true, body: html`<div class="field"><label for="tp-q">${T('tr.search', 'Name, phone or record number')}</label><input class="input" id="tp-q" name="q" required minlength="2"></div><ul class="list" id="tp-res"></ul>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('tr.find', 'Find'), primary: true }],
      onSubmit: async d => { const r = await api.get('/api/fd/patients' + qs({ q: d.q })); const ul = document.getElementById('tp-res'); MC.view(r.length ? html`${r.slice(0, 8).map(p => html`<li><div class="grow"><span class="title">${p.name}</span><span class="sub">${[p.mrn, p.phone].filter(Boolean).join(' | ')}</span></div><button type="button" class="btn sm" data-pick="${p.id}">${T('tr.choose', 'Choose')}</button></li>`)}` : html`<li class="muted">${T('tr.no_match', 'No patient found')}</li>`, ul);
        return new Promise(res => { ul.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => { res(r.find(x => x.id === b.dataset.pick)); })); }); } });
  }
  let FINDER = null;
  async function transfersPage({ query }) {
    const svc = query.service || ''; const src = query.source || 'all';
    let pos = null; if (query.lat && query.lng) pos = { lat: Number(query.lat), lng: Number(query.lng) };
    const [r, mine] = await Promise.all([api.get('/api/facilities/finder' + qs({ service: svc, source: src, lat: pos ? pos.lat : undefined, lng: pos ? pos.lng : undefined, radiusKm: query.km || 50 })), api.get('/api/transfers?open=true').catch(() => [])]);
    FINDER = r.facilities;
    const fac = f => html`<li><div class="grow"><span class="title">${f.name} ${f.source === 'public' ? badge(T('tr.public', 'Not on MediCore'), '') : badge('MediCore', 'hue')} ${f.verified === false ? badge(T('tr.unverified', 'Numbers not yet checked'), 'warn') : ''}</span>
      <span class="sub">${[f.distanceKm != null ? f.distanceKm + ' km' : null, f.etaMin ? T('tr.eta', 'about {m} min by road', { m: f.etaMin }) : null, f.level ? cap(f.level) : null, f.address || f.area].filter(Boolean).join(' | ')}</span>
      <span class="sub">${f.source === 'platform' ? (f.takingEmergencies === false ? badge(T('tr.not_taking', 'Not taking emergencies'), 'bad') : f.takingEmergencies ? badge(T('tr.taking', 'Taking emergencies'), 'ok') : badge(T('tr.unknown', 'Status not updated today'), '')) : ''} ${[f.freeBeds != null ? T('tr.beds', '{n} free beds', { n: f.freeBeds }) : null].concat((f.capacity || []).filter(w => w.key === 'icu' || w.key === 'nicu').map(w => T('tr.ward_free', '{w}: {a} of {t} free', { w: wardLabel(w.key), a: w.available, t: w.total }))).filter(Boolean).join(' | ')}</span>
      ${(f.services || []).length ? html`<span class="sub">${f.services.map(svcLabel).join(', ')}</span>` : ''}
      <div class="ct-phones">${(f.phones || []).map(tel)}</div></div>
      <span class="end">${f.source === 'public' ? html`<button class="btn sm primary" data-action="tr-start" data-id="${f.id}" data-patient="${query.patient || ''}">${T('tr.transfer', 'Transfer here')}</button><button class="btn sm" data-action="tr-suggest" data-id="${f.id}">${T('tr.suggest', 'Report a wrong number')}</button>` : can('referral.send') ? html`<button class="btn sm primary" data-action="tr-refer" data-patient="${query.patient || ''}">${T('tr.refer', 'Refer on MediCore')}</button>` : ''}</span></li>`;
    view(html`<div class="page-head"><div><h1>${T('nav.transfers', 'Emergency transfers')}</h1><p>${T('tr.sub', 'Hospitals near you that can take the patient: on MediCore (with beds) and public hospitals that are not on MediCore yet. Tap a number to call.')}</p></div></div>
      ${mine.length ? html`<section class="panel flush"><h2>${T('tr.open', 'Open transfers')}</h2><div class="list">${mine.map(x => html`<a href="#/transfers/${x.id}"><div class="grow"><span class="title">${x.number} | ${x.patientName} | ${x.target.name}</span><span class="sub">${x.reason} | ${dateTime(x.createdAt)}</span></div>${badge(outLabel(x.status), OUT_KIND[x.status])}</a>`)}</div></section>` : ''}
      <form class="panel row" data-form="tr-filter" novalidate style="flex-wrap:wrap;gap:12px;align-items:flex-end">
        <div class="field" style="flex:1;min-width:180px;margin:0"><label for="tf-s">${T('tr.need', 'Needs')}</label><select class="input" id="tf-s" name="service"><option value="">${T('tr.any', 'Any hospital')}</option>${r.services.map(s => html`<option value="${s}" ${s === svc ? 'selected' : ''}>${svcLabel(s)}</option>`)}</select></div>
        <div class="field" style="flex:1;min-width:160px;margin:0"><label for="tf-o">${T('tr.which', 'Show')}</label><select class="input" id="tf-o" name="source"><option value="all">${T('tr.all', 'All hospitals')}</option><option value="platform" ${src === 'platform' ? 'selected' : ''}>${T('tr.on', 'On MediCore')}</option><option value="public" ${src === 'public' ? 'selected' : ''}>${T('tr.off', 'Not on MediCore')}</option></select></div>
        <div class="field" style="width:120px;margin:0"><label for="tf-k">${T('tr.km', 'Within (km)')}</label><input class="input" id="tf-k" name="km" type="number" min="1" max="1000" value="${query.km || 50}"></div>
        <input type="hidden" name="patient" value="${query.patient || ''}"><button class="btn" type="submit">${icon('search')}${T('tr.search_btn', 'Search')}</button>
        <button class="btn" type="button" data-action="tr-here">${icon('pin')}${T('tr.here', 'Near my location')}</button></form>
      <div class="ct-map" id="tr-map"></div>
      <section class="panel flush">${FINDER.length ? html`<ul class="list">${FINDER.map(fac)}</ul>` : empty({ icon: 'building', title: T('tr.none', 'No hospital found'), body: T('tr.none_sub', 'Widen the distance or remove the service filter. Call 112 in a life-threatening emergency.') })}</section>`);
    try {
      const m = await MC.map(document.getElementById('tr-map'), { center: r.from || undefined, zoom: 12 });
      if (r.from) m.setMarker('me', r.from, { kind: 'me', label: T('tr.you', 'You') });
      FINDER.forEach(f => { if (f.location) m.setMarker(f.id, f.location, { color: f.source === 'public' ? '#5B6B6A' : f.takingEmergencies === false ? '#B42D27' : '#1E7A4C', label: f.name }); });
      m.fit();
    } catch (e) { /* map optional */ }
  }
  form('tr-filter', d => MC.go('#/transfers' + qs({ service: d.service, source: d.source, km: d.km, patient: d.patient })));
  on('tr-here', async () => { const p = await MC.position(); if (!p) return toast(T('tr.no_gps', 'Location is not available. Searching from your provider\'s address.')); const q = MC.formData(document.querySelector('[data-form="tr-filter"]')); MC.go('#/transfers' + qs({ service: q.service, source: q.source, km: q.km, patient: q.patient, lat: p.lat.toFixed(5), lng: p.lng.toFixed(5) })); });
  on('tr-refer', async el => { const p = await pickPatient(el.dataset.patient); if (p) await MC.referrals.sendDialog({ patient: p }); });
  on('tr-start', async el => {
    const f = (FINDER || []).find(x => x.id === el.dataset.id); const p = await pickPatient(el.dataset.patient); if (!p || !f) return;
    const r = await dialog({ title: T('tr.to', 'Transfer {name} to {h}', { name: p.name, h: f.name }), wide: true, form: true, body: html`<div class="ct-phones">${(f.phones || []).map(tel)}</div>
      <div class="field"><label for="tt-u">${T('tr.urgency', 'Urgency')}</label><select class="input" id="tt-u" name="urgency"><option value="emergency">${T('tr.u_em', 'Emergency')}</option><option value="urgent">${T('tr.u_ur', 'Urgent')}</option><option value="routine">${T('tr.u_ro', 'Routine')}</option></select></div>
      <div class="field"><label for="tt-r">${T('tr.reason', 'Reason for transfer')}</label><textarea class="input" id="tt-r" name="reason" required rows="2" maxlength="1000"></textarea></div>
      <div class="field"><label for="tt-c">${T('tr.clinical', 'Clinical summary for the receiving doctor')}</label><textarea class="input" id="tt-c" name="clinicalNote" rows="3" maxlength="2000"></textarea></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('tr.create', 'Start transfer'), primary: true }], onSubmit: d => api.post('/api/transfers', Object.assign({ patientId: p.id, facilityId: f.id }, d)) });
    if (r) MC.go('#/transfers/' + r.id);
  });
  on('tr-suggest', async el => {
    const v = await dialog({ title: T('tr.suggest', 'Report a wrong number'), form: true, body: html`<div class="fields two"><div class="field"><label for="sg-n">${T('tr.correct_no', 'Correct number')}</label><input class="input" id="sg-n" name="number" inputmode="tel"></div><div class="field"><label for="sg-k">${T('tr.no_kind', 'Which line')}</label><select class="input" id="sg-k" name="kind">${Object.keys(PHONE_EN).map(k => html`<option value="${k}">${phoneLabel(k)}</option>`)}</select></div></div><div class="field"><label for="sg-x">${T('tr.what', 'What did you find?')}</label><textarea class="input" id="sg-x" name="note" required rows="2" maxlength="500"></textarea></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('tr.send', 'Send to MediCore'), primary: true }], onSubmit: d => api.post('/api/facilities/' + el.dataset.id + '/suggest', d) });
    if (v) toast(T('tr.thanks', 'Thank you. MediCore will check and update the number.'), 'ok');
  });
  async function transferPage({ params }) {
    const x = await api.get('/api/transfers/' + params.id);
    view(html`${back('#/transfers', T('nav.transfers', 'Emergency transfers'))}<div class="page-head"><div><h1>${x.number}: ${x.patientName}</h1><p>${T('tr.to_short', 'To {h}', { h: x.target.name })} | ${cap(x.urgency)} | ${dateTime(x.createdAt)}</p></div><div class="actions">${badge(outLabel(x.status), OUT_KIND[x.status])}</div></div>
      <div class="grid two"><div>
        <section class="panel"><h2>${T('tr.call', 'Call the hospital')}</h2><div class="ct-phones">${(x.target.phones || []).map(tel)}</div>
          <form data-form="tr-log" data-id="${x.id}" novalidate style="margin-top:12px"><div class="fields two"><div class="field"><label for="tl-o">${T('tr.outcome', 'What happened')}</label><select class="input" id="tl-o" name="outcome">${Object.keys(OUT_EN).map(o => html`<option value="${o}">${outLabel(o)}</option>`)}</select></div><div class="field"><label for="tl-c">${T('tr.spoke', 'Spoke to')}</label><input class="input" id="tl-c" name="contactName" maxlength="100"></div></div>
          <div class="field"><label for="tl-n">${T('tr.note', 'Note')}</label><input class="input" id="tl-n" name="note" maxlength="500"></div><button class="btn primary" type="submit">${T('tr.log', 'Save')}</button></form></section>
        <section class="panel"><h2>${T('tr.pack', 'Transfer pack')}</h2><p class="muted sm">${T('tr.pack_sub', 'A link the receiving hospital opens without an account to see the patient summary (allergies, conditions, medicines, recent results). Give them the 6-digit code by phone.')}</p>
          ${x.pack ? html`<p>${x.pack.revoked ? badge(T('tr.pack_revoked', 'Withdrawn'), 'bad') : T('tr.pack_info', 'Valid until {d}. Opened {n} times.', { d: dateTime(x.pack.expiresAt), n: x.pack.views })}</p>` : ''}
          <div class="btn-row"><button class="btn primary" data-action="tr-pack" data-id="${x.id}">${icon('file')}${x.pack ? T('tr.pack_new', 'Make a new pack') : T('tr.pack_make', 'Make a transfer pack')}</button>${x.pack && !x.pack.revoked ? html`<button class="btn" data-action="tr-pack-revoke" data-id="${x.id}">${T('tr.pack_revoke', 'Withdraw pack')}</button>` : ''}</div></section>
        <section class="panel"><h2>${T('tr.amb', 'Ambulance')}</h2>${x.incidentId ? html`<p>${T('tr.amb_done', 'Ambulance requested.')}</p>` : html`<p class="muted sm">${T('tr.amb_sub', 'Send your own ambulance service, or the nearest one on MediCore, with this hospital as the destination.')}</p><button class="btn" data-action="tr-amb" data-id="${x.id}">${icon('ambulance')}${T('tr.amb_btn', 'Request an ambulance')}</button>`}</section>
      </div><div>
        <section class="panel"><h2>${T('tr.details', 'Details')}</h2><p><b>${T('tr.reason', 'Reason for transfer')}</b><br>${x.reason}</p>${x.clinicalNote ? html`<p><b>${T('tr.clinical', 'Clinical summary for the receiving doctor')}</b><br>${lines(x.clinicalNote)}</p>` : ''}</section>
        <section class="panel flush"><h2>${T('tr.log_title', 'Log')}</h2><ul class="list">${x.log.slice().reverse().map(e => html`<li><div class="grow"><span class="title">${outLabel(e.outcome)}${e.contactName ? ', ' + e.contactName : ''}</span><span class="sub">${dateTime(e.at)} | ${e.byName || ''}${e.note ? ' | ' + e.note : ''}</span></div></li>`)}</ul></section>
      </div></div>`);
  }
  form('tr-log', async (d, f) => { await api.post('/api/transfers/' + f.dataset.id + '/log', d); toast(T('tr.saved', 'Saved'), 'ok'); MC.render(); });
  on('tr-pack', async el => {
    const r = await api.post('/api/transfers/' + el.dataset.id + '/pack');
    const link = r.link.startsWith('http') ? r.link : location.origin + r.path;
    const wa = 'https://wa.me/?text=' + encodeURIComponent(r.message.replace(r.path, link).replace(/^.*?Open /, 'Patient transfer. Open '));
    await dialog({ title: T('tr.pack_ready', 'Transfer pack ready'), body: html`<p>${T('tr.pack_send', 'Send this link to the receiving hospital (WhatsApp, SMS or email), then read them the code on the phone.')}</p>
      <div class="field"><label for="tp-l">${T('tr.link', 'Link')}</label><input class="input" id="tp-l" readonly value="${link}"></div><div class="ct-code" aria-label="${T('tr.code', 'Access code')}">${r.code}</div>
      <p class="muted sm">${T('tr.pack_once', 'The code is shown only now. Valid until {d}.', { d: dateTime(r.expiresAt) })}</p><a class="btn" href="${wa}" target="_blank" rel="noopener">${icon('message')}${T('tr.wa', 'Send the link by WhatsApp')}</a>`, actions: [{ label: MC.t('kit.close', 'Close'), value: null }] });
    MC.render();
  });
  on('tr-pack-revoke', async el => { if (await confirm({ title: T('tr.pack_revoke', 'Withdraw pack'), body: T('tr.pack_revoke_body', 'The link stops working at once.'), ok: T('tr.pack_revoke', 'Withdraw pack'), danger: true })) { await api.post('/api/transfers/' + el.dataset.id + '/pack/revoke'); MC.render(); } });
  on('tr-amb', async el => { const r = await api.post('/api/transfers/' + el.dataset.id + '/ambulance', {}); toast(T('tr.amb_ok', 'Ambulance requested from {org} ({n}).', { org: r.ambulanceOrgName, n: r.incidentNumber }) + (r.noUnitAvailable ? ' ' + T('tr.amb_none', 'No unit is free right now: call them.') : ''), r.noUnitAvailable ? 'bad' : 'ok', 8000); MC.render(); });

  /* ---------------- stores and capacity ---------------- */
  let SM = null;
  async function storePage({ query }) {
    if (!SM) SM = await api.get('/api/store/meta').catch(() => null);
    const dept = query.dept || ''; const low = query.low === '1';
    const [items, alerts, cap2] = await Promise.all([canAny('inventory.read', 'inventory.manage', 'inventory.issue') ? api.get('/api/store/items' + qs({ dept, q: query.q, low: low ? 'true' : undefined })).catch(() => null) : null, canAny('inventory.read', 'inventory.manage') ? api.get('/api/store/alerts').catch(() => null) : null, api.get('/api/store/capacity').catch(() => null)]);
    const showCap = cap2 && (can('capacity.update') || (cap2.wards || []).length) && (MC.me.org.type === 'hospital' || MC.me.org.type === 'clinic' || hasMod('clinic'));
    view(html`<div class="page-head"><div><h1>${T('nav.store', 'Stores and beds')}</h1><p>${T('st.sub', 'Consumables, reagents, equipment, blood and oxygen, and the beds you have free.')}</p></div><div class="actions">${can('inventory.manage') ? html`<button class="btn primary" data-action="st-new">${icon('plus')}${T('st.new', 'New item')}</button>` : ''}</div></div>
      ${showCap ? html`<section class="panel"><h2>${T('cap.title', 'Beds and emergencies')}</h2>
        <p>${cap2.acceptingEmergencies === false ? badge(T('tr.not_taking', 'Not taking emergencies'), 'bad') : cap2.acceptingEmergencies ? badge(T('tr.taking', 'Taking emergencies'), 'ok') : badge(T('cap.not_set', 'Not set'), '')} ${cap2.updatedAt ? html`<span class="muted sm">${T('cap.updated', 'Updated {t} by {n}', { t: ago(cap2.updatedAt), n: cap2.updatedByName || '' })}</span>` : ''} ${cap2.stale ? badge(T('cap.stale', 'Older than a day: other hospitals see it as unknown'), 'warn') : ''}</p>
        ${cap2.wards.length ? html`<div class="figures">${cap2.wards.map(w => html`<div class="${w.available === 0 ? 'bad' : ''}"><b>${w.available}/${w.total}</b><span>${wardLabel(w.key)}</span></div>`)}</div>` : ''}${cap2.note ? html`<p class="sm">${cap2.note}</p>` : ''}
        ${can('capacity.update') ? html`<button class="btn" data-action="cap-edit">${icon('edit')}${T('cap.edit', 'Update beds')}</button>` : ''}</section>` : ''}
      ${items ? html`${alerts && (alerts.low || alerts.out || alerts.nearExpiry || alerts.expired) ? html`<div class="notice warn">${T('st.alerts', '{low} running low, {out} out of stock, {exp} expiring soon, {gone} expired.', { low: alerts.low, out: alerts.out, exp: alerts.nearExpiry, gone: alerts.expired })} <a href="#/store?low=1">${T('st.show_alerts', 'Show them')}</a></div>` : ''}
        <div class="tabs" role="tablist"><a role="tab" href="#/store" aria-selected="${!dept && !low}">${T('st.all', 'All')}</a>${(SM ? SM.depts : []).map(d => html`<a role="tab" href="#/store?dept=${d}" aria-selected="${dept === d}">${deptLabel(d)}</a>`)}</div>
        <form class="row" data-form="st-search" novalidate style="margin-bottom:12px"><input class="input" name="q" value="${query.q || ''}" placeholder="${T('st.search', 'Search items')}" aria-label="${T('st.search', 'Search items')}" style="flex:1"><input type="hidden" name="dept" value="${dept}"><button class="btn" type="submit">${icon('search')}</button></form>
        <section class="panel flush">${items.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('st.item', 'Item')}</th><th>${T('st.dept', 'Department')}</th><th class="num">${T('st.qty', 'In stock')}</th><th>${T('st.state', 'State')}</th><th>${T('st.expiry', 'Expiry')}</th><th></th></tr></thead><tbody>
          ${items.map(i => html`<tr><td data-label="${T('st.item', 'Item')}"><b>${i.name}</b>${i.public ? html` ${badge(T('st.public', 'Patients see it'), 'info')}` : ''}<br><span class="xs muted">${stcatLabel(i.category)}${i.location ? ' | ' + i.location : ''}</span></td><td data-label="${T('st.dept', 'Department')}">${deptLabel(i.dept)}</td><td class="num" data-label="${T('st.qty', 'In stock')}">${i.qty} ${i.unit || ''}</td><td data-label="${T('st.state', 'State')}">${stateBadge(i.state)}</td><td data-label="${T('st.expiry', 'Expiry')}">${i.expiry ? html`${i.expiry} ${i.expired ? badge(T('st.expired', 'Expired'), 'bad') : i.nearExpiry ? badge(T('st.near', 'Soon'), 'warn') : ''}` : '-'}</td>
            <td class="num"><button class="btn sm" data-action="st-open" data-id="${i.id}">${T('st.open', 'Open')}</button></td></tr>`)}</tbody></table></div>`
          : empty({ icon: 'box', title: T('st.none', 'No items here yet'), body: can('inventory.manage') ? T('st.none_sub', 'Add the items you keep, with a reorder level, to get warnings before you run out.') : '' })}</section>` : ''}`);
  }
  form('st-search', d => MC.go('#/store' + qs({ dept: d.dept, q: d.q })));
  const itemFields = (i, depts) => html`<div class="fields two"><div class="field"><label for="si-n">${T('st.item', 'Item')}</label><input class="input" id="si-n" name="name" value="${i.name || ''}" required maxlength="120"></div><div class="field"><label for="si-d">${T('st.dept', 'Department')}</label><select class="input" id="si-d" name="dept">${depts.map(d => html`<option value="${d}" ${i.dept === d ? 'selected' : ''}>${deptLabel(d)}</option>`)}</select></div></div>
    <div class="fields three"><div class="field"><label for="si-c">${T('st.category', 'Kind')}</label><select class="input" id="si-c" name="category">${Object.keys(STCAT_EN).map(c => html`<option value="${c}" ${i.category === c ? 'selected' : ''}>${stcatLabel(c)}</option>`)}</select></div><div class="field"><label for="si-u">${T('st.unit', 'Unit')}</label><input class="input" id="si-u" name="unit" value="${i.unit || ''}" maxlength="30" placeholder="${T('st.unit_ph', 'pieces, boxes, units')}"></div><div class="field"><label for="si-r">${T('st.reorder', 'Warn at')}</label><input class="input" id="si-r" name="reorderLevel" type="number" min="0" value="${i.reorderLevel || 0}"></div></div>
    <div class="fields two"><div class="field"><label for="si-l">${T('st.location', 'Where it is kept')}</label><input class="input" id="si-l" name="location" value="${i.location || ''}" maxlength="80"></div><div class="field"><label for="si-e">${T('st.expiry', 'Expiry')}</label><input class="input" id="si-e" name="expiry" type="date" value="${i.expiry || ''}"></div></div>
    <label class="check"><input type="checkbox" name="public" ${i.public ? 'checked' : ''}><span>${T('st.public_q', 'Show patients whether it is available (never the quantity)')}</span></label>
    <div class="field"><label for="si-pl">${T('st.public_label', 'Name patients see (optional)')}</label><input class="input" id="si-pl" name="publicLabel" value="${i.publicLabel || ''}" maxlength="120"></div>`;
  on('st-new', async () => {
    const r = await dialog({ title: T('st.new', 'New item'), wide: true, form: true, body: html`${itemFields({}, SM ? SM.depts : ['general'])}<div class="field"><label for="si-q">${T('st.opening', 'Quantity now')}</label><input class="input" id="si-q" name="qty" type="number" min="0" value="0"></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('st.save', 'Save'), primary: true }], onSubmit: d => api.post('/api/store/items', d) });
    if (r) MC.render();
  });
  on('st-open', async el => {
    const r = await api.get('/api/store/items/' + el.dataset.id); const i = r.item;
    const types = can('inventory.manage') ? ['receive', 'issue', 'count', 'waste', 'return'] : ['issue', 'waste', 'return'];
    const v = await dialog({ title: i.name, wide: true, form: true, body: html`<p>${stateBadge(i.state)} <b>${i.qty} ${i.unit || ''}</b> | ${deptLabel(i.dept)}${i.expiry ? ' | ' + T('st.expiry', 'Expiry') + ' ' + i.expiry : ''}</p>
      <div class="fields three"><div class="field"><label for="sm-t">${T('st.action', 'Action')}</label><select class="input" id="sm-t" name="type">${types.map(t2 => html`<option value="${t2}">${moveLabel(t2)}</option>`)}</select></div><div class="field"><label for="sm-q">${T('st.qty_move', 'Quantity')}</label><input class="input" id="sm-q" name="qty" type="number" min="0" required></div><div class="field"><label for="sm-e">${T('st.new_expiry', 'Expiry (when receiving)')}</label><input class="input" id="sm-e" name="expiry" type="date"></div></div>
      <div class="field"><label for="sm-r">${T('st.reason', 'Reason or where it went')}</label><input class="input" id="sm-r" name="reason" maxlength="200"></div>
      <h3>${T('st.moves', 'Recent movements')}</h3><ul class="list">${r.moves.slice(0, 12).map(m => html`<li><div class="grow"><span class="title">${moveLabel(m.type)} ${m.qty > 0 ? '+' : ''}${m.qty}</span><span class="sub">${dateTime(m.at)} | ${m.byName || ''}${m.reason ? ' | ' + m.reason : ''} | ${T('st.balance', 'Balance {n}', { n: m.balanceAfter })}</span></div></li>`)}</ul>`,
      actions: [can('inventory.manage') ? { label: T('st.edit', 'Edit item'), value: 'edit' } : null, { label: MC.t('kit.close', 'Close'), value: null }, { label: T('st.record', 'Record'), primary: true }].filter(Boolean),
      onSubmit: d => api.post('/api/store/items/' + i.id + '/move', { type: d.type, qty: Number(d.qty), reason: d.reason, expiry: d.expiry }) });
    if (v === 'edit') {
      const e = await dialog({ title: T('st.edit', 'Edit item'), wide: true, form: true, body: html`${itemFields(i, SM ? SM.depts : [i.dept])}<label class="check"><input type="checkbox" name="active" checked><span>${T('st.active', 'In use (untick to retire the item)')}</span></label>`, actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('st.save', 'Save'), primary: true }], onSubmit: d => api.patch('/api/store/items/' + i.id, d) });
      if (e) MC.render(); return;
    }
    if (v) { toast(T('st.recorded', 'Recorded'), 'ok'); MC.render(); }
  });
  on('cap-edit', async () => {
    const c = await api.get('/api/store/capacity');
    const by = Object.fromEntries((c.wards || []).map(w => [w.key, w]));
    const v = await dialog({ title: T('cap.edit', 'Update beds'), wide: true, form: true, body: html`<label class="check"><input type="checkbox" name="acceptingEmergencies" ${c.acceptingEmergencies !== false ? 'checked' : ''}><span><b>${T('cap.taking_q', 'We are taking emergencies now')}</b></span></label>
      <div class="table-wrap"><table class="t"><thead><tr><th>${T('cap.ward', 'Ward')}</th><th>${T('cap.total', 'Beds')}</th><th>${T('cap.free', 'Free now')}</th></tr></thead><tbody>${c.wardKeys.map(k => html`<tr><td>${wardLabel(k)}</td><td><input class="input" name="t_${k}" type="number" min="0" max="5000" value="${by[k] ? by[k].total : ''}" aria-label="${wardLabel(k)} ${T('cap.total', 'Beds')}"></td><td><input class="input" name="a_${k}" type="number" min="0" max="5000" value="${by[k] ? by[k].available : ''}" aria-label="${wardLabel(k)} ${T('cap.free', 'Free now')}"></td></tr>`)}</tbody></table></div>
      <div class="field"><label for="cp-n">${T('cap.note', 'Note for other hospitals')}</label><input class="input" id="cp-n" name="note" maxlength="200" value="${c.note || ''}"></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('st.save', 'Save'), primary: true }],
      onSubmit: d => { const wards = c.wardKeys.filter(k => d['t_' + k] != null).map(k => ({ key: k, total: Number(d['t_' + k]), available: Number(d['a_' + k] || 0) })); return api.put('/api/store/capacity', { wards, acceptingEmergencies: !!d.acceptingEmergencies, note: d.note || '' }); } });
    if (v) { toast(T('cap.saved', 'Beds updated'), 'ok'); MC.render(); }
  });

  function routes(opts) {
    OPTS = Object.assign(OPTS, opts || {});
    return { '#/shared-care': sharesPage, '#/transfers': transfersPage, '#/transfers/:id': transferPage, '#/store': storePage };
  }
  MC.caretools = { actions, panels, load, routes, nav, refreshCount, shareDialog, showDoc, wearPanel, labels: { catLabel, letterLabel, purposeLabel, svcLabel, wardLabel, stateBadge, shareBadge } };
})();
