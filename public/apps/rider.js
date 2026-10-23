/* MediCore Rider: phone-first delivery app. Big touch targets, high contrast for sunlight,
 * keeps working on a weak network (last good data stays on screen, location retries).
 * My jobs (assigned and claimable), job detail with call / maps / pick up / deliver with code / fail,
 * live location sharing while a job is active, and the rider profile. */
(function () {
  'use strict';
  const { html, api, money, dateTime, ago, cap, icon, badge, empty, view, on, form, dialog, confirm, toast } = MC;
  void money;
  const T = (k, en, v) => MC.t('rider.' + k, en, v);
  const S = s => MC.t('status.' + s, cap(s));
  const kindOf = s => (/(delivered|verified|picked_up)/.test(s) ? 'ok' : /(failed|cancelled|suspended|locked)/.test(s) ? 'bad' : /(pending|assigned|no_profile|returned)/.test(s) ? 'warn' : 'info');
  const sBadge = s => badge(S(s), kindOf(s));
  const LIVE = ['assigned', 'picked_up'];
  const VEH = ['motorcycle', 'bicycle', 'car', 'van', 'tricycle', 'on_foot'];
  const vehLabel = v => MC.t('rider.vehicle.' + v, cap(v));
  const FAIL = { patient_unreachable: 'Could not reach the patient', patient_absent: 'Patient not at the address', wrong_address: 'Wrong or unclear address', patient_refused: 'Patient refused the package', unsafe_area: 'Area not safe', vehicle_problem: 'Problem with my vehicle', other: 'Other (explain)' };
  const failLabel = r => MC.t('rider.fail.' + r, FAIL[r] || cap(r));
  const mapsLink = (loc, address) => 'https://www.google.com/maps/dir/?api=1&destination=' + (loc && loc.lat != null ? loc.lat + ',' + loc.lng : encodeURIComponent(address || ''));

  /* sunlight: stronger contrast, bigger type and targets than the default kit sizing */
  (function css() {
    const s = document.createElement('style');
    s.textContent = `
      body[data-app="rider"] { --ink-3: #4A5C5E; }
      body[data-app="rider"] .main { max-width: 640px; }
      .rd-job { display:block; background:var(--surface); border:2px solid var(--ink); border-radius:var(--r); padding:16px; margin-bottom:12px; color:var(--ink); text-decoration:none; }
      .rd-job .rd-top { display:flex; justify-content:space-between; gap:8px; align-items:center; }
      .rd-job b.rd-name { font-size:1.375rem; }
      .rd-job .rd-addr { font-size:1.125rem; margin:6px 0 0; overflow-wrap:anywhere; }
      .rd-big { min-height:60px; font-size:1.1875rem; width:100%; }
      .rd-acts { display:grid; gap:10px; margin:16px 0; }
      .rd-acts.two { grid-template-columns:1fr 1fr; }
      .rd-sec { background:var(--surface); border:2px solid var(--line); border-radius:var(--r); padding:16px; margin-bottom:16px; }
      .rd-sec h2 { font-size:1.1875rem; margin-bottom:6px; display:flex; gap:8px; align-items:center; }
      .rd-sec h2 svg, .rd-kp svg { width:22px; height:22px; flex:none; }
      .rd-acts.two .btn { white-space:normal; padding:0 8px; text-align:center; }
      .back { white-space:nowrap; }
      .allergy-unknown svg { width:14px; height:14px; }
      .rd-sec .rd-addr { font-size:1.1875rem; font-weight:700; overflow-wrap:anywhere; margin:0 0 12px; }
      .rd-loc { display:flex; gap:10px; align-items:center; padding:12px 14px; border-radius:var(--r); margin-bottom:16px; font-weight:700; border:2px solid; }
      .rd-loc svg { width:22px; height:22px; flex:none; }
      .rd-loc.on { background:var(--green-soft); color:var(--green); border-color:var(--green); }
      .rd-loc.wait { background:var(--amber-soft); color:var(--amber); border-color:var(--amber); }
      .rd-loc.off { background:var(--red-soft); color:var(--red); border-color:var(--red); }
      .rd-loc .grow { flex:1; } .rd-loc .sm { font-weight:400; display:block; color:var(--ink-2); }
      .rd-code { display:grid; grid-template-columns:repeat(6,1fr); gap:6px; margin:8px 0 12px; }
      .rd-code span { height:56px; border:2px solid var(--ink); border-radius:8px; display:grid; place-items:center; font-size:1.75rem; font-weight:700; background:var(--surface); }
      .rd-code span.f { border-color:var(--hue); background:var(--hue-soft); }
      .rd-kp { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
      .rd-kp button { min-height:64px; font-size:1.75rem; font-weight:700; border:2px solid var(--ink); border-radius:10px; background:var(--surface); color:var(--ink); font-family:inherit; cursor:pointer; }
      .rd-kp button:active { background:var(--hue-soft); }
      .rd-kp button.fn { font-size:1rem; }
      .rd-err { background:var(--red); color:#fff; font-weight:700; padding:12px 14px; border-radius:8px; margin:0 0 12px; }
      .rd-stale { background:var(--amber-soft); color:var(--amber); border:2px solid var(--amber); padding:10px 14px; border-radius:8px; font-weight:700; margin-bottom:12px; }
    `;
    document.head.appendChild(s);
  })();

  /* ---------------- shift state (location posts only while clocked in) ---------------- */
  let onShift = null;
  async function loadShift() { if (!MC.me || !MC.me.clocks) { onShift = true; return; } try { const s = await api.get('/api/shift/me'); onShift = !!s.open; } catch (e) { /* keep last */ } }
  MC.onEvent('shift:changed', s => { onShift = !!(s && s.open); syncSharing(); renderLoc(); });

  /* ---------------- live location sharing ---------------- */
  const Loc = { want: false, stop: null, state: 'off', last: null, sentAt: 0, error: null };
  function renderLoc() {
    const el = document.getElementById('rd-loc'); if (!el) return;
    if (!Loc.want) { el.hidden = true; return; }
    el.hidden = false;
    const st = Loc.state;
    const cls = st === 'sharing' ? 'on' : (st === 'denied' || st === 'unsupported' || st === 'offshift') ? 'off' : 'wait';
    el.className = 'rd-loc ' + cls;
    const msg = {
      sharing: [T('loc.sharing', 'Sharing location'), Loc.sentAt ? T('loc.last_sent', 'Last sent {when}. The dispatcher and the patient can see where you are.', { when: MC.time(Loc.sentAt) }) : ''],
      starting: [T('loc.starting', 'Finding your location...'), T('loc.starting_sub', 'Stand in the open if this takes long.')],
      retrying: [T('loc.retrying', 'Location not sent yet'), T('loc.retrying_sub', 'Weak network. We keep trying every 10 seconds.')],
      nofix: [T('loc.nofix', 'No GPS signal yet'), T('loc.nofix_sub', 'Move to an open area. We keep trying.')],
      denied: [T('loc.denied', 'Location is blocked'), T('loc.denied_sub', 'Allow location for MediCore Rider in your browser or phone settings, then tap Try again. The dispatcher cannot see you until then.')],
      unsupported: [T('loc.unsupported', 'This phone cannot share location'), T('loc.unsupported_sub', 'Tell your dispatcher. You can still deliver with the code.')],
      offshift: [T('loc.offshift', 'Clock in to share your location'), T('loc.offshift_sub', 'Use the Clock in button at the top.')],
    }[st] || [T('loc.starting', 'Finding your location...'), ''];
    view(html`${icon(st === 'sharing' ? 'nav' : 'alert')}<div class="grow" role="status" aria-live="polite">${msg[0]}<span class="sm">${msg[1]}</span></div>${st === 'denied' || st === 'nofix' ? html`<button class="btn sm" data-action="loc-retry">${T('loc.retry', 'Try again')}</button>` : ''}`, el);
  }
  async function send(fix) {
    Loc.last = fix;
    if (!onShift) { Loc.state = 'offshift'; renderLoc(); return; }
    const body = { lat: fix.lat, lng: fix.lng };
    if (Number.isFinite(fix.accuracy)) body.accuracy = Math.min(100000, Math.max(0, fix.accuracy));
    if (Number.isFinite(fix.heading) && fix.heading >= 0 && fix.heading <= 360) body.heading = fix.heading;
    if (Number.isFinite(fix.speed) && fix.speed >= 0 && fix.speed <= 100) body.speed = fix.speed;
    try { await api.post('/api/rider/location', body); Loc.sentAt = Date.now(); Loc.state = 'sharing'; }
    catch (e) { if (e.status === 423) { onShift = false; Loc.state = 'offshift'; } else if (e.status === 429) { /* too frequent: fine */ } else Loc.state = 'retrying'; }
    renderLoc();
  }
  async function startSharing() {
    if (Loc.stop) return;
    if (!navigator.geolocation) { Loc.state = 'unsupported'; renderLoc(); return; }
    try { if (navigator.permissions && navigator.permissions.query) { const p = await navigator.permissions.query({ name: 'geolocation' }); p.onchange = () => { if (p.state !== 'denied' && Loc.state === 'denied') { stopSharing(); syncSharing(); } }; if (p.state === 'denied') { Loc.state = 'denied'; renderLoc(); return; } } } catch (e) { /* permissions API missing */ }
    Loc.state = 'starting'; renderLoc();
    Loc.stop = MC.watchPosition(send, 10000);
    const first = await MC.position(15000);
    if (first) send({ lat: first.lat, lng: first.lng, accuracy: first.accuracyM });
    else if (!Loc.last) {
      let denied = false; try { if (navigator.permissions) denied = (await navigator.permissions.query({ name: 'geolocation' })).state === 'denied'; } catch (e) { /* unknown */ }
      Loc.state = denied ? 'denied' : 'nofix'; if (denied) stopSharing(); renderLoc();
    }
  }
  function stopSharing() { if (Loc.stop) { try { Loc.stop(); } catch (e) { /* gone */ } } Loc.stop = null; }
  function syncSharing(jobs) {
    if (jobs) Loc.want = jobs.some(j => LIVE.includes(j.status));
    if (Loc.want && onShift !== false) startSharing();
    else { stopSharing(); if (Loc.want && onShift === false) Loc.state = 'offshift'; }
    renderLoc();
  }
  /* resend the last fix every 10 s while a job is active (watchPosition only fires when the phone moves) */
  async function heartbeat() { if (Loc.want && Loc.last && Loc.state !== 'denied' && Date.now() - Loc.sentAt >= 9500) await send(Loc.last); }
  on('loc-retry', async () => { stopSharing(); Loc.state = 'starting'; renderLoc(); await loadShift(); await startSharing(); });
  const locBox = () => html`<div id="rd-loc" class="rd-loc wait" hidden></div>`;

  /* ---------------- data with a weak-network fallback ---------------- */
  const cache = {};
  async function getWithCache(key, path) {
    try { const v = await api.get(path); cache[key] = { v, at: Date.now() }; return { v, stale: false }; }
    catch (e) { if (e.code === 'network' && cache[key]) return { v: cache[key].v, stale: true, at: cache[key].at }; throw e; }
  }
  const staleBar = r => (r.stale ? html`<div class="rd-stale" role="status">${T('net.stale', 'No connection. Showing what we had at {when}.', { when: MC.time(r.at) })}</div>` : '');

  /* ================= my jobs ================= */
  async function jobsPage() {
    view(html`<div class="page-head"><div><h1>${T('jobs.title', 'My jobs')}</h1></div></div>${locBox()}<div id="jobs-body">${MC.skeleton(3)}</div>`);
    const load = async () => {
      const [jr, pr, av] = await Promise.all([getWithCache('jobs', '/api/rider/jobs'), getWithCache('profile', '/api/rider/profile'), getWithCache('avail', '/api/rider/available').catch(() => ({ v: [] }))]);
      const jobs = jr.v; const prof = pr.v; const avail = av.v || [];
      const box = document.getElementById('jobs-body'); if (!box) return;
      const verified = prof.status === 'verified';
      view(html`${staleBar(jr)}
        ${!verified ? html`<div class="notice ${prof.status === 'suspended' ? 'bad' : 'warn'}">${prof.status === 'no_profile' ? T('jobs.no_profile', 'Add your vehicle and licence on the Profile page. Your dispatcher verifies them before you can take jobs.') : prof.status === 'suspended' ? T('jobs.suspended', 'Your rider profile is suspended. Talk to your dispatcher.') : T('jobs.pending', 'Your profile is waiting for the dispatcher to verify it.')} <a href="#/profile">${T('nav.profile', 'Profile')}</a></div>` : ''}
        ${onShift === false && MC.me.clocks ? html`<div class="notice warn">${T('jobs.clock_in', 'You are not clocked in. Clock in at the top of the screen to get jobs.')}</div>` : ''}
        <h2>${T('jobs.active', 'Active jobs')}</h2>
        ${jobs.active.length ? jobs.active.map(j => html`<a class="rd-job" href="#/jobs/${j.id}"><div class="rd-top"><b class="rd-name">${j.patient ? j.patient.firstName : T('jobs.patient', 'Patient')}</b>${sBadge(j.locked ? 'locked' : j.status)}</div>
            <p class="rd-addr">${j.status === 'assigned' ? T('jobs.collect_from', 'Collect from {name}', { name: j.pickup.name }) : j.address || ''}</p>
            <span class="muted">${j.distanceKm != null ? T('jobs.km', '{n} km away', { n: j.distanceKm }) + ' | ' : ''}${j.assignedAt ? T('jobs.assigned_ago', 'Assigned {when}', { when: ago(j.assignedAt) }) : ''}</span></a>`)
          : empty({ icon: 'truck', title: T('jobs.none', 'No jobs right now'), body: T('jobs.none_sub', 'New jobs from your dispatcher appear here. Keep the app open while you are on shift.') })}
        ${avail.length ? html`<h2 style="margin-top:24px">${T('jobs.available', 'Jobs you can take')}</h2>${avail.map(a => html`<div class="rd-job"><div class="rd-top"><b class="rd-name">${a.area || T('jobs.delivery', 'Delivery')}</b>${a.distanceKm != null ? badge(T('jobs.km_from', '{n} km from pharmacy', { n: a.distanceKm }), 'info') : ''}</div><p class="muted">${T('jobs.waiting', 'Waiting {when}', { when: ago(a.createdAt) })}</p>
            <button class="btn primary rd-big" data-action="job-claim" data-id="${a.id}" ${verified ? '' : 'disabled'}>${T('jobs.claim', 'Take this job')}</button></div>`)}` : ''}
        ${jobs.recent.length ? html`<h2 style="margin-top:24px">${T('jobs.recent', 'Recent')}</h2><ul class="list">${jobs.recent.map(j => html`<li><div class="grow"><span class="title">${j.patient ? j.patient.firstName : ''}</span><span class="sub">${j.deliveredAt ? dateTime(j.deliveredAt) : ''}${j.failReason ? failLabel(j.failReason) : ''}</span></div>${sBadge(j.status)}</li>`)}</ul>` : ''}`, box);
      syncSharing(jobs.active);
    };
    await load();
    MC.poll(async () => { await load(); await heartbeat(); }, 10000);
  }
  on('job-claim', async el => {
    if (!(await confirm({ title: T('jobs.claim_q', 'Take this job?'), body: T('jobs.claim_body', 'It becomes yours. Go to the pharmacy to collect the package.'), ok: T('jobs.claim', 'Take this job') }))) return;
    try { const j = await api.post('/api/rider/jobs/' + el.dataset.id + '/claim'); toast(T('jobs.claimed', 'Job taken'), 'ok'); MC.go('#/jobs/' + j.id); }
    catch (e) { if (e.status === 409) { toast(T('jobs.gone', 'Another rider took this job.'), 'bad'); MC.render(); return; } throw e; }
  });

  /* ================= job detail ================= */
  let code = '';
  let codeErr = null;
  let codeJob = null;
  function codeBoxes() { return html`<div class="rd-code" aria-hidden="true">${[0, 1, 2, 3, 4, 5].map(i => html`<span class="${code[i] ? 'f' : ''}">${code[i] || ''}</span>`)}</div>`; }
  function renderCode() {
    const el = document.getElementById('rd-codebox'); if (el) view(codeBoxes(), el);
    const inp = document.getElementById('rd-code-in'); if (inp && inp.value !== code) inp.value = code;
    const btn = document.getElementById('rd-deliver'); if (btn) btn.disabled = code.length !== 6;
    const er = document.getElementById('rd-code-err'); if (er) { er.hidden = !codeErr; er.textContent = codeErr || ''; }
  }
  document.addEventListener('input', e => { if (e.target && e.target.id === 'rd-code-in') { code = e.target.value.replace(/\D/g, '').slice(0, 6); codeErr = null; renderCode(); } });

  async function jobPage({ params, stale }) {
    const r = await getWithCache('job:' + params.id, '/api/rider/jobs/' + encodeURIComponent(params.id));
    if (stale()) return;
    const j = r.v;
    if (codeJob !== j.id) { code = ''; codeErr = null; codeJob = j.id; }
    const steps = ['assigned', 'picked_up', 'delivered'];
    const lbl = { assigned: T('job.step_go', 'Go to pharmacy'), picked_up: T('job.step_out', 'On the way'), delivered: S('delivered') };
    const phone = j.patient && j.patient.phone;
    view(html`<a class="back" href="#/jobs">${icon('left')}${T('jobs.title', 'My jobs')}</a>
      ${staleBar(r)}${locBox()}
      <div class="page-head"><div><h1>${j.patient ? T('job.title', 'Delivery for {name}', { name: j.patient.firstName }) : T('jobs.delivery', 'Delivery')}</h1><p>${sBadge(j.locked ? 'locked' : j.status)}${j.attempts > 1 ? ' ' + T('job.attempt', 'Attempt {n}', { n: j.attempts }) : ''}</p></div></div>
      ${LIVE.includes(j.status) || j.status === 'delivered' ? MC.steps(steps, j.status, lbl) : ''}
      ${j.status === 'failed' ? html`<div class="notice bad"><b>${S('failed')}:</b> ${failLabel(j.failReason)}. ${T('job.bring_back', 'Bring the package back to the pharmacy. They will confirm it is returned.')}</div>` : ''}
      ${j.status === 'delivered' ? html`<div class="notice ok"><b>${T('job.delivered', 'Delivered')}</b> ${j.deliveredAt ? dateTime(j.deliveredAt) : ''}</div>` : ''}

      <section class="rd-sec"><h2>${icon('building')} ${T('job.pickup', 'Pick up from')}</h2><p class="rd-addr">${j.pickup.name}<br><span class="muted" style="font-weight:400">${j.pickup.address || ''}</span></p>
        ${j.status === 'assigned' ? html`<div class="rd-acts"><a class="btn rd-big" href="${mapsLink(j.pickup.location, j.pickup.address)}" target="_blank" rel="noopener">${icon('nav')}${T('job.maps_pickup', 'Directions to pharmacy')}</a>
          <button class="btn primary rd-big" data-action="job-pickup">${icon('box')}${T('job.picked', 'I have the package')}</button></div>` : ''}</section>

      ${LIVE.includes(j.status) ? html`<section class="rd-sec"><h2>${icon('pin')} ${T('job.dropoff', 'Deliver to')}</h2><p class="rd-addr">${j.address || T('job.no_address', 'No address. Call the patient.')}</p>
        ${j.distanceKm != null ? html`<p class="muted">${T('jobs.km', '{n} km away', { n: j.distanceKm })}</p>` : ''}
        <div class="rd-acts two">${phone ? html`<a class="btn rd-big" href="tel:${phone}">${icon('phone')}${T('job.call', 'Call patient')}</a>` : html`<span class="btn rd-big" aria-disabled="true">${T('job.no_phone', 'No phone number')}</span>`}
          <a class="btn rd-big" href="${mapsLink(j.location, j.address)}" target="_blank" rel="noopener">${icon('nav')}${T('job.maps', 'Open in maps')}</a></div></section>` : ''}

      ${j.status === 'picked_up' ? (j.locked ? html`<section class="rd-sec"><h2>${icon('lock')} ${T('code.locked_t', 'Delivery code locked')}</h2><div class="rd-err" role="alert">${T('code.locked', 'Too many wrong codes. Do not hand over the package. Call your dispatcher: they will check with the patient and reset the code.')}</div><button class="btn rd-big" data-action="mc-reload">${icon('refresh')}${T('code.check_again', 'Check again')}</button></section>`
        : html`<section class="rd-sec"><h2>${icon('key')} ${T('code.title', 'Delivery code')}</h2><p>${T('code.sub', 'Ask the patient for the 6-digit code in their MediCore app or SMS. Hand over the package only when the code is accepted.')}</p>
          <label class="sr-only" for="rd-code-in">${T('code.label', '6-digit delivery code')}</label><input class="input" id="rd-code-in" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" value="${code}" style="font-size:2rem;letter-spacing:.4em;text-align:center;font-weight:700;min-height:64px;border:2px solid var(--ink);margin-bottom:12px">
          <div id="rd-code-err" class="rd-err" role="alert" ${codeErr ? '' : 'hidden'}>${codeErr || ''}</div>
          <div class="rd-kp" role="group" aria-label="${T('code.keypad', 'Number keypad')}">${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(k => html`<button type="button" data-action="kp" data-k="${k}">${k}</button>`)}<button type="button" class="fn" data-action="kp-clear">${T('code.clear', 'Clear')}</button><button type="button" data-action="kp" data-k="0">0</button><button type="button" class="fn" data-action="kp-del" aria-label="${T('code.delete', 'Delete last digit')}">${icon('left')}</button></div>
          <p class="muted" style="margin-top:8px">${T('code.tries', '{n} tries left', { n: j.codeTriesLeft })}</p>
          <button class="btn primary rd-big" id="rd-deliver" data-action="job-deliver" ${code.length === 6 ? '' : 'disabled'}>${icon('check')}${T('code.deliver', 'Confirm delivery')}</button></section>`) : ''}

      ${j.status === 'picked_up' ? html`<button class="btn rd-big" data-action="job-fail" style="margin-bottom:24px">${icon('x')}${T('fail.btn', 'I cannot deliver this')}</button>` : ''}`);
    syncSharing([j]);

    on('job-pickup', async () => {
      if (!(await confirm({ title: T('job.picked_q', 'Collected the package?'), body: T('job.picked_body', 'Confirm the pharmacy has handed you the package for {name}. The patient is told you are on the way.', { name: j.patient ? j.patient.firstName : '' }), ok: T('job.picked', 'I have the package') }))) return;
      try { await api.post('/api/rider/jobs/' + j.id + '/pickup'); toast(T('job.picked_done', 'Picked up. Drive safely.'), 'ok'); }
      catch (e) { if (e.status === 409) { toast(e.message, 'bad'); } else throw e; }
      MC.render();
    });
    on('job-fail', async () => {
      const v = await dialog({ title: T('fail.title', 'Why can you not deliver?'), form: true,
        body: html`<fieldset style="border:0;padding:0;margin:0"><legend class="sr-only">${T('fail.reason', 'Reason')}</legend>${Object.keys(FAIL).map(k => html`<label class="check"><input type="radio" name="reason" value="${k}"><span>${failLabel(k)}</span></label>`)}</fieldset>
          <div class="field"><label for="fl-n">${T('fail.note', 'Note for the dispatcher')}</label><textarea class="input" id="fl-n" name="note" maxlength="300"></textarea><div class="hint">${T('fail.note_hint', 'Needed when you choose Other.')}</div></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('fail.go', 'Report failed delivery'), primary: true }],
        onSubmit: async d => {
          if (!d.reason) throw new MC.ApiError(400, { error: T('fail.choose', 'Choose a reason') });
          if (d.reason === 'other' && !d.note) throw new MC.ApiError(400, { error: T('fail.need_note', 'Add a short note'), details: [{ field: 'note', error: T('fail.need_note', 'Add a short note') }] });
          if (!(await confirm({ title: T('fail.q', 'Report this delivery as failed?'), body: T('fail.body', 'The dispatcher and the patient are told. Bring the package back to the pharmacy.'), ok: T('fail.go', 'Report failed delivery'), danger: true }))) return false;
          return api.post('/api/rider/jobs/' + j.id + '/fail', d);
        } });
      if (v) { toast(T('fail.done', 'Reported. Bring the package back to the pharmacy.'), 'ok'); MC.render(); }
    });
    if (LIVE.includes(j.status) || j.status === 'failed') MC.poll(async () => {
      const n = await api.get('/api/rider/jobs/' + j.id).catch(e => { if (e.code === 'network') return null; throw e; });
      if (n && (n.status !== j.status || n.locked !== j.locked) && document.activeElement !== document.getElementById('rd-code-in')) MC.render();
      await heartbeat();
    }, 10000);
  }
  on('kp', el => { if (code.length < 6) code += el.dataset.k; codeErr = null; renderCode(); });
  on('kp-del', () => { code = code.slice(0, -1); codeErr = null; renderCode(); });
  on('kp-clear', () => { code = ''; codeErr = null; renderCode(); });
  on('job-deliver', async () => {
    if (code.length !== 6) { codeErr = T('code.six', 'Enter all 6 digits'); renderCode(); return; }
    const pos = Loc.last;
    try {
      await api.post('/api/rider/jobs/' + codeJob + '/deliver', Object.assign({ code }, pos ? { lat: pos.lat, lng: pos.lng } : {}));
      code = ''; codeErr = null;
      toast(T('code.done', 'Delivered. Thank you.'), 'ok');
      MC.render();
    } catch (e) {
      if (e.status === 400) { codeErr = e.message || T('code.wrong', 'That code is not correct.'); code = ''; renderCode(); const tl = /(\d+) tries left/.exec(e.message || ''); const p = document.querySelector('.rd-kp + p'); if (tl && p) p.textContent = T('code.tries', '{n} tries left', { n: tl[1] }); return; }
      if (e.status === 423) { code = ''; codeErr = null; toast(T('code.locked_toast', 'Code locked. Call your dispatcher.'), 'bad'); MC.render(); return; }
      if (e.status === 409) { toast(e.message, 'bad'); MC.render(); return; }
      codeErr = e.message; renderCode();
    }
  });

  /* ================= profile ================= */
  async function profilePage() {
    const p = await api.get('/api/rider/profile');
    const st = p.status;
    view(html`<div class="page-head"><div><h1>${T('profile.title', 'My profile')}</h1><p>${MC.me.user.name}${MC.me.org ? ' | ' + MC.me.org.name : ''}</p></div></div>
      <section class="rd-sec"><h2>${T('profile.status', 'Verification')}</h2><p>${sBadge(st)}</p>
        <p>${st === 'verified' ? T('profile.verified', 'Verified {when}. You can take delivery jobs.', { when: p.verifiedAt ? dateTime(p.verifiedAt) : '' }) : st === 'pending' ? T('profile.pending', 'Your dispatcher needs to check your licence and vehicle before you can take jobs.') : st === 'suspended' ? T('profile.suspended', 'Suspended. You cannot take or finish jobs. Talk to your dispatcher.') : T('profile.none', 'Add your vehicle and licence so your dispatcher can verify you.')}</p></section>
      <form class="rd-sec" data-form="profile-save" novalidate><h2>${T('profile.vehicle_t', 'Vehicle and licence')}</h2>
        <div class="field"><label for="pf-v">${T('profile.vehicle', 'Vehicle')}</label><select class="input" id="pf-v" name="vehicle" required ${st === 'suspended' ? 'disabled' : ''}>${VEH.map(v => html`<option value="${v}" ${p.vehicle === v ? 'selected' : ''}>${vehLabel(v)}</option>`)}</select></div>
        <div class="field"><label for="pf-p">${T('profile.plate', 'Plate number')}</label><input class="input" id="pf-p" name="plate" maxlength="20" value="${p.plate || ''}" autocapitalize="characters" ${st === 'suspended' ? 'disabled' : ''}></div>
        <div class="field"><label for="pf-l">${T('profile.licence', 'Licence number')}</label><input class="input" id="pf-l" name="licence" maxlength="40" required value="${p.licence || ''}" ${st === 'suspended' ? 'disabled' : ''}></div>
        ${st === 'verified' ? html`<div class="notice warn">${T('profile.reverify', 'Changing these sends your profile back to the dispatcher to verify again. You cannot take jobs until then.')}</div>` : ''}
        <div class="form-err notice bad" hidden></div>
        ${st !== 'suspended' ? html`<button class="btn primary rd-big" type="submit">${T('profile.save', 'Save details')}</button>` : ''}</form>`);
    form('profile-save', async d => {
      if (!d.licence) throw new MC.ApiError(400, { error: T('profile.need_licence', 'Enter your licence number'), details: [{ field: 'licence', error: T('profile.need_licence', 'Enter your licence number') }] });
      const changed = d.vehicle !== p.vehicle || (d.plate || null) !== (p.plate || null) || d.licence !== p.licence;
      if (!changed) { toast(T('profile.nochange', 'Nothing changed')); return; }
      if (st === 'verified' && !(await confirm({ title: T('profile.reverify_q', 'Send for verification again?'), body: T('profile.reverify', 'Changing these sends your profile back to the dispatcher to verify again. You cannot take jobs until then.'), ok: T('profile.save', 'Save details') }))) return;
      await api.put('/api/rider/profile', { vehicle: d.vehicle, plate: d.plate || undefined, licence: d.licence });
      toast(T('profile.saved', 'Details saved. Your dispatcher will verify them.'), 'ok'); MC.render();
    });
    MC.poll(heartbeat, 10000);
  }

  MC.boot({
    title: 'MediCore Rider', subtitle: MC.t('rider.login.sub', 'Deliveries for your pharmacy'), home: '#/jobs',
    nav: [
      { href: '#/jobs', label: MC.t('rider.nav.jobs', 'My jobs'), icon: 'truck', perm: 'delivery.ride' },
      { href: '#/profile', label: MC.t('rider.nav.profile', 'Profile'), icon: 'user', perm: 'delivery.ride' },
    ],
    routes: { '#/jobs': jobsPage, '#/jobs/:id': jobPage, '#/profile': profilePage },
    onReady: async () => { await loadShift(); },
  });
})();
