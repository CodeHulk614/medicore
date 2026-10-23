/* MediCore Crew: phone app for ambulance crews in a moving vehicle.
 * Big buttons, few words, works through bad signal: status changes made offline are kept on the
 * phone and sent when the connection comes back. Shares GPS while on duty. */
(function () {
  'use strict';
  const { html, api, qs, icon, badge, empty, view, on, form, dialog, confirm, toast } = MC;
  const T = MC.t;

  const css = document.createElement('style');
  css.textContent = `
    #main :is(dd, p, a:not(.btn), span:not(.btn), h1, h2, li, time, .lm) > svg { width: 1.1em; height: 1.1em; vertical-align: -0.18em; flex: none; }
    body[data-app="crew"] .main { max-width: 680px; }
    .c-btn { width: 100%; min-height: 64px; font-size: 1.25rem; justify-content: flex-start; padding: 0 var(--s4); gap: var(--s3); border-width: 2px; }
    .c-btn svg { width: 26px; height: 26px; flex: none; }
    .c-btn { white-space: normal; text-align: left; line-height: 1.2; }
    .c-two > * { min-width: 0; }
    .c-job .lm svg { width: 18px; height: 18px; vertical-align: -3px; }
    .c-btn.next { background: var(--hue); border-color: var(--hue); color: #fff; box-shadow: 0 0 0 4px var(--hue-soft); }
    .c-btn.done { background: var(--green-soft); border-color: transparent; color: var(--green); opacity: 1; }
    .c-btn.later { opacity: .45; }
    .c-btn .n { margin-left: auto; font-size: var(--t-sm); font-weight: 400; }
    .c-stack { display: grid; gap: var(--s2); margin: var(--s3) 0 var(--s4); }
    .c-two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s2); }
    .c-job { border: 2px solid var(--ink); border-radius: var(--r); background: var(--surface); padding: var(--s4); margin-bottom: var(--s4); }
    .c-job.P1 { border-color: var(--red); }
    .c-job .what { font-size: 1.5rem; font-weight: 700; line-height: 1.2; margin: var(--s2) 0; }
    .c-job .addr { font-size: 1.1875rem; font-weight: 700; overflow-wrap: anywhere; }
    .c-job .lm { font-size: 1.0625rem; color: var(--ink-2); overflow-wrap: anywhere; }
    .c-pri { font-size: 1rem; padding: 4px 12px; } .c-pri::before { display: none; }
    .c-share { display: flex; align-items: center; gap: var(--s3); padding: var(--s3) var(--s4); border-radius: var(--r); font-weight: 700; margin-bottom: var(--s3); border: 2px solid transparent; }
    .c-share .dot { width: 14px; height: 14px; border-radius: 50%; flex: none; background: currentColor; }
    .c-share.on { background: var(--green-soft); color: var(--green); }
    .c-share.on .dot { animation: c-pulse 1.6s infinite; }
    .c-share.warn { background: var(--amber-soft); color: var(--amber); border-color: color-mix(in srgb, var(--amber) 40%, transparent); }
    .c-share.bad { background: var(--red-soft); color: var(--red); border-color: var(--red); }
    .c-share.off { background: var(--sunken); color: var(--ink-2); }
    .c-share small { display: block; font-weight: 400; color: inherit; opacity: .85; }
    @keyframes c-pulse { 50% { opacity: .35; } }
    .c-queue { background: var(--amber); color: #fff; font-weight: 700; padding: var(--s3) var(--s4); border-radius: var(--r); margin-bottom: var(--s3); }
    .c-vitals { display: grid; grid-template-columns: 1fr 1fr; gap: 0 var(--s3); }
    @media (min-width: 520px) { .c-vitals { grid-template-columns: repeat(3, 1fr); } }
    .c-vitals .input { font-size: 1.25rem; }
    .c-chips { display: flex; flex-wrap: wrap; gap: var(--s2); }
    .c-chip { display: inline-flex; align-items: center; gap: 8px; min-height: 48px; padding: 0 var(--s3); border: 2px solid var(--line); border-radius: 999px; cursor: pointer; font-weight: 700; background: var(--surface); }
    .c-chip input { width: 20px; height: 20px; accent-color: var(--hue); }
    .c-chip:has(input:checked) { border-color: var(--hue); background: var(--hue-soft); }
    .c-demo { border: 2px dashed var(--line); border-radius: var(--r); padding: var(--s3); margin-top: var(--s4); }
    .c-opts { display: grid; gap: var(--s2); max-height: 50vh; overflow-y: auto; margin-bottom: var(--s3); }
    .c-opt { display: flex; gap: var(--s3); align-items: center; padding: var(--s3); border: 2px solid var(--line); border-radius: var(--r-sm); min-height: 56px; cursor: pointer; }
    .c-opt input { width: 22px; height: 22px; accent-color: var(--hue); flex: none; }
    .c-opt:has(input:checked) { border-color: var(--hue); background: var(--hue-soft); }
  `;
  document.head.appendChild(css);

  /* ---------------- labels ---------------- */
  const ST_EN = { new: 'Waiting', assigned: 'Job assigned', enroute: 'En route', onscene: 'On scene', transporting: 'Transporting', athospital: 'At hospital', closed: 'Clear', cancelled: 'Cancelled' };
  const stLabel = s => T('crew.status.' + s, ST_EN[s] || MC.cap(s));
  const AV_EN = { available: 'Available', assigned: 'Assigned', enroute: 'En route', onscene: 'On scene', transporting: 'Transporting', athospital: 'At hospital', returning: 'Returning to base', offline: 'Offline' };
  const avLabel = a => T('crew.avail.' + a, AV_EN[a] || MC.cap(a));
  const pri = p => html`<span class="badge c-pri pri-${p}">${p}</span>`;
  const telHref = p => 'tel:' + String(p || '').replace(/[^+\d]/g, '');
  const navHref = l => 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(Number(l.lat).toFixed(6) + ',' + Number(l.lng).toFixed(6)) + '&travelmode=driving';
  // the five crew steps, in order, and the incident status each one moves to
  const STEPS = [
    { key: 'enroute', to: 'enroute', from: ['assigned'], icon: 'nav', en: 'En route', hint: 'Leaving for the scene' },
    { key: 'onscene', to: 'onscene', from: ['enroute'], icon: 'pin', en: 'On scene', hint: 'Arrived at the patient' },
    { key: 'transporting', to: 'transporting', from: ['onscene'], icon: 'ambulance', en: 'Transporting', hint: 'Patient on board' },
    { key: 'athospital', to: 'athospital', from: ['transporting'], icon: 'building', en: 'At hospital', hint: 'Arrived at the hospital' },
    { key: 'clear', to: 'closed', from: ['athospital', 'onscene'], icon: 'check', en: 'Clear', hint: 'Handover done, job finished' },
  ];
  const ORDER = ['assigned', 'enroute', 'onscene', 'transporting', 'athospital', 'closed'];

  /* ---------------- state ---------------- */
  let cm = null;                     // GET /api/crew/me
  let demoAvailable = true;
  const loc = { stop: null, state: 'off', lastAt: 0, perm: null, acc: null };
  const demo = { on: false, stop: null, remainingKm: null };

  /* ---------------- offline queue for status changes ---------------- */
  const QK = 'mc-crew-queue';
  let queue = [];
  try { queue = JSON.parse(localStorage.getItem(QK) || '[]') || []; } catch (e) { queue = []; }
  const saveQ = () => { try { localStorage.setItem(QK, JSON.stringify(queue)); } catch (e) { /* memory only */ } };
  let flushing = false;
  async function flushQueue() {
    if (flushing || !queue.length) return;
    flushing = true;
    try {
      while (queue.length) {
        const q = queue[0];
        try { await api.post('/api/crew/incidents/' + q.incidentId + '/status', q.body); }
        catch (e) {
          if (e.status === 0) break; // still offline: keep it
          if (e.status !== 409 && e.status !== 404) toast(T('crew.queue.failed', 'A saved update could not be sent: {msg}', { msg: e.message }), 'bad');
        }
        queue.shift(); saveQ();
        if (!queue.length) toast(T('crew.queue.sent', 'Saved updates sent'), 'ok');
      }
    } finally { flushing = false; }
  }
  window.addEventListener('online', () => { refresh(true).catch(() => { }); });
  // what the incident status is once queued updates are applied (so buttons move on while offline)
  function effectiveStatus() {
    if (!cm || !cm.incident) return null;
    let s = cm.incident.status;
    queue.filter(q => q.incidentId === cm.incident.id).forEach(q => { const st = STEPS.find(x => x.key === q.body.status); if (st && ORDER.indexOf(st.to) > ORDER.indexOf(s)) s = st.to; });
    return s;
  }

  /* ---------------- location sharing ---------------- */
  function locState() {
    if (!cm || !cm.onShift) return { cls: 'off', text: T('crew.loc.off_duty', 'Not sharing location: you are off duty'), sub: T('crew.loc.off_duty_sub', 'Clock in to start sharing.') };
    if (!cm.unit) return { cls: 'off', text: T('crew.loc.no_unit', 'Not sharing location: you are not on a unit') };
    if (demo.on) return { cls: 'warn', text: T('crew.loc.demo', 'Simulated drive (demo): real GPS paused'), sub: demo.remainingKm != null ? T('crew.loc.demo_left', '{km} km to go', { km: demo.remainingKm }) : '' };
    if (loc.state === 'denied') return { cls: 'bad', text: T('crew.loc.denied', 'Location blocked'), sub: T('crew.loc.denied_sub', 'Dispatch cannot see you. Allow location for this app in your phone settings, then tap Try again.') };
    if (loc.state === 'unavailable') return { cls: 'bad', text: T('crew.loc.unavailable', 'This phone cannot share location') };
    if (loc.state === 'offline') return { cls: 'warn', text: T('crew.loc.offline', 'Sharing location: no signal'), sub: T('crew.loc.offline_sub', 'Positions resume when the connection is back.') };
    if (loc.state === 'on' && loc.lastAt) return { cls: 'on', text: T('crew.loc.on', 'Sharing location'), sub: T('crew.loc.last', 'Last sent {ago}', { ago: MC.ago(loc.lastAt) }) + (loc.acc ? ' | ' + T('crew.loc.acc', 'accurate to {m} m', { m: loc.acc }) : '') };
    return { cls: 'warn', text: T('crew.loc.waiting', 'Sharing location: waiting for GPS'), sub: T('crew.loc.waiting_sub', 'Stay where the sky is visible if this takes long.') };
  }
  function paintLoc() {
    const el = document.getElementById('c-share'); if (!el) return;
    const s = locState();
    el.className = 'c-share ' + s.cls;
    view(html`<span class="dot" aria-hidden="true"></span><span>${s.text}${s.sub ? html`<small>${s.sub}</small>` : ''}</span>${s.cls === 'bad' && loc.state === 'denied' ? html`<button class="btn sm" style="margin-left:auto" data-action="loc-retry">${T('crew.loc.retry', 'Try again')}</button>` : ''}`, el);
  }
  async function sendPos(p) {
    if (!cm || !cm.onShift || !cm.unit || demo.on) return;
    const b = { lat: p.lat, lng: p.lng };
    const acc = p.accuracy != null ? p.accuracy : p.accuracyM;
    if (Number.isFinite(acc)) b.accuracy = Math.min(100000, Math.max(0, acc));
    if (Number.isFinite(p.speed) && p.speed >= 0) b.speed = Math.min(100, p.speed);
    if (Number.isFinite(p.heading) && p.heading >= 0) b.heading = Math.min(360, p.heading);
    try { await api.post('/api/crew/location', b); loc.state = 'on'; loc.lastAt = Date.now(); loc.acc = Number.isFinite(acc) ? Math.round(acc) : null; }
    catch (e) { if (e.status === 0) loc.state = 'offline'; else if (e.code === 'no_unit') { loc.state = 'off'; } }
    paintLoc();
  }
  function watchPermission() {
    if (loc.perm || !navigator.permissions || !navigator.permissions.query) return;
    navigator.permissions.query({ name: 'geolocation' }).then(s => {
      loc.perm = s;
      const apply = () => { if (s.state === 'denied') { loc.state = 'denied'; } else if (loc.state === 'denied') { loc.state = 'starting'; restartSharing(); } paintLoc(); };
      apply(); s.onchange = apply;
    }).catch(() => { });
  }
  function startSharing() {
    if (loc.stop) return;
    if (!navigator.geolocation) { loc.state = 'unavailable'; paintLoc(); return; }
    if (loc.state !== 'denied') loc.state = 'starting';
    watchPermission();
    MC.position(10000).then(p => {
      if (p) sendPos(p);
      else if (navigator.permissions && loc.perm && loc.perm.state === 'denied') loc.state = 'denied';
      paintLoc();
    });
    loc.stop = MC.watchPosition(sendPos, 10000);
  }
  function stopSharing() { if (loc.stop) { loc.stop(); loc.stop = null; } if (loc.state !== 'denied') loc.state = 'off'; }
  function restartSharing() { stopSharing(); syncSharing(); }
  function syncSharing() { const want = !!(cm && cm.onShift && cm.unit); if (want && !loc.stop) startSharing(); if (!want && loc.stop) stopSharing(); paintLoc(); }
  on('loc-retry', () => { loc.state = 'starting'; restartSharing(); });

  /* ---------------- data ---------------- */
  let lastSig = '';
  let prevIncidentId = null;
  async function load() {
    cm = await api.get('/api/crew/me');
    const id = cm.incident ? cm.incident.id : null;
    if (id && id !== prevIncidentId && prevIncidentId !== undefined) {
      if (prevIncidentId !== null) { /* switched job */ }
      if (lastSig) { toast(T('crew.job.new', 'New job: {cat}', { cat: cm.incident.categoryLabel || '' }), 'ok', 6000); try { navigator.vibrate && navigator.vibrate([300, 120, 300]); } catch (e) { /* not supported */ } }
    }
    if (!id && prevIncidentId && lastSig) toast(T('crew.job.ended', 'The job was closed or cancelled by dispatch'), '', 6000);
    prevIncidentId = id;
    syncSharing();
    return cm;
  }
  const sig = () => JSON.stringify([cm.onShift, cm.unit && [cm.unit.id, cm.unit.availability, cm.unit.status], cm.incident && [cm.incident.id, cm.incident.status, cm.incident.destination, cm.incident.etaMinutes, (cm.incident.care || []).length, cm.incident.patientInfo], queue.length, demo.on]);
  let renderCurrent = null;
  async function refresh(force) { try { await flushQueue(); await load(); if (renderCurrent && (force || sig() !== lastSig)) renderCurrent(); } catch (e) { if (e.status === 0) paintLoc(); throw e; } }
  MC.onEvent('shift:changed', () => refresh(true).catch(() => { }));

  async function clockIn() {
    const p = await MC.position(8000);
    await api.post('/api/shift/clock-in', p ? { lat: p.lat, lng: p.lng, accuracyM: p.accuracyM } : {});
    toast(p ? T('crew.shift.in', 'Clocked in. Have a safe shift.') : T('crew.shift.in_noloc', 'Clocked in without location'), 'ok');
    MC.refreshShift(); await refresh(true);
  }
  on('crew-clock-in', clockIn);

  /* ---------------- job screen ---------------- */
  function header() {
    return html`<div id="c-share" class="c-share off" role="status" aria-live="polite"></div>${queue.length ? html`<div class="c-queue" role="status">${icon('refresh')} ${T('crew.queue.waiting', '{n} update(s) saved on this phone. They will be sent when you have signal.', { n: queue.length })}</div>` : ''}`;
  }
  function jobView() {
    if (!cm.onShift) return html`${header()}<div class="gate"><div class="inner">${icon('clock')}<h1>${T('crew.off.title', 'You are off duty')}</h1><p>${T('crew.off.sub', 'Clock in to receive jobs and share your location with dispatch.')}</p><button class="btn primary c-btn" style="justify-content:center" data-action="crew-clock-in">${icon('clock')}${T('crew.off.clock_in', 'Clock in to start duty')}</button></div></div>`;
    if (!cm.unit) return html`${header()}${empty({ icon: 'ambulance', title: T('crew.no_unit.title', 'You are not on a unit'), body: T('crew.no_unit.sub', 'Ask your fleet manager or dispatcher to put you on an ambulance. This screen updates by itself.') })}`;
    const u = cm.unit; const inc = cm.incident;
    if (!inc) return html`${header()}<div class="page-head"><div><h1>${u.name}</h1><p>${T('crew.idle.sub', 'No job right now. Stay ready; a new job appears here with a buzz.')}</p></div></div>
      ${availabilityPanel()}`;
    const s = effectiveStatus(); const pi = inc.patientInfo;
    const toHospital = ['transporting', 'athospital'].includes(s) && inc.destination && inc.destination.lat != null;
    const target = toHospital ? inc.destination : inc.location;
    const nextStep = STEPS.find(x => x.from.includes(s) && x.key !== 'clear') || (s === 'athospital' ? STEPS[4] : null);
    return html`${header()}
      <section class="c-job ${inc.triage.priority}" aria-label="${T('crew.job.current', 'Current job')}">
        <div class="row between wrap"><span>${pri(inc.triage.priority)} <b>${inc.number}</b></span>${badge(stLabel(s), s === 'assigned' ? 'bad' : 'info')}</div>
        <div class="what">${inc.categoryLabel || inc.triage.category}</div>
        ${toHospital ? html`<div class="lm">${T('crew.job.to_hospital', 'Taking patient to')}</div><div class="addr">${inc.destination.name}</div>` : html`<div class="addr">${inc.location.address || T('crew.job.no_address', 'No address: use the map pin')}</div>${inc.location.landmark ? html`<div class="lm">${icon('pin')} ${inc.location.landmark}</div>` : ''}`}
        ${inc.etaMinutes != null ? html`<p class="sm" style="margin:8px 0 0">${toHospital ? T('crew.job.eta_h', 'About {n} min to the hospital', { n: inc.etaMinutes }) : T('crew.job.eta_s', 'About {n} min to the scene', { n: inc.etaMinutes })}</p>` : ''}
        <div class="c-two" style="margin-top:12px">
          <a class="btn primary c-btn" style="justify-content:center" href="${navHref(target)}" target="_blank" rel="noopener">${icon('nav')}${T('crew.job.navigate', 'Navigate')}</a>
          ${inc.caller && inc.caller.phone ? html`<a class="btn c-btn" style="justify-content:center" href="${telHref(inc.caller.phone)}">${icon('phone')}${T('crew.job.call', 'Call caller')}</a>` : html`<span class="btn c-btn later" style="justify-content:center" aria-disabled="true">${T('crew.job.no_phone', 'No caller phone')}</span>`}
        </div>
        ${inc.caller && (inc.caller.name || inc.caller.phone) ? html`<p class="sm muted" style="margin:8px 0 0">${T('crew.job.caller', 'Caller')}: ${inc.caller.name || ''} ${inc.caller.phone || ''}</p>` : ''}
        ${!inc.verified ? html`<p class="notice warn" style="margin:8px 0 0">${T('crew.job.unverified', 'Public report not yet confirmed by dispatch.')}</p>` : ''}
      </section>
      ${pi ? MC.wristband({ name: pi.firstName || T('crew.job.patient', 'Patient'), age: pi.age, sex: pi.sex, bloodGroup: pi.bloodGroup, allergies: pi.allergies || [], noKnownAllergies: pi.noKnownAllergies }) : html`<div class="notice">${T('crew.job.no_patient', 'Patient not identified. Ask about allergies before giving any medicine.')}</div>`}
      ${(inc.notes || []).length ? html`<details class="panel"><summary><b>${T('crew.job.notes', 'Dispatch notes ({n})', { n: inc.notes.length })}</b></summary><ul class="list" style="margin-top:8px">${inc.notes.map(n => html`<li><div class="grow"><span>${n.text}</span><span class="sub">${MC.time(n.at)} ${n.byName || ''}</span></div></li>`)}</ul></details>` : ''}
      <h2 class="sr-only">${T('crew.job.status', 'Update status')}</h2>
      <div class="c-stack">${STEPS.map(st => {
        const done = ORDER.indexOf(s) >= ORDER.indexOf(st.to) && !(st.key === 'clear');
        const isNext = nextStep && nextStep.key === st.key;
        const clearFromScene = st.key === 'clear' && s === 'onscene';
        if (done) return html`<button class="btn c-btn done" disabled>${icon('check')}${T('crew.step.' + st.key, st.en)}<span class="n">${T('crew.step.done', 'Done')}</span></button>`;
        if (isNext) return html`<button class="btn c-btn next" data-action="crew-step" data-step="${st.key}">${icon(st.icon)}${T('crew.step.' + st.key, st.en)}<span class="n">${T('crew.step.hint.' + st.key, st.hint)}</span></button>`;
        if (clearFromScene) return html`<button class="btn c-btn" data-action="crew-step" data-step="clear">${icon('check')}${T('crew.step.clear_scene', 'Clear: treated on scene')}<span class="n">${T('crew.step.no_transport', 'No transport')}</span></button>`;
        return html`<button class="btn c-btn later" disabled>${icon(st.icon)}${T('crew.step.' + st.key, st.en)}</button>`;
      })}</div>
      <div class="c-two">
        <a class="btn c-btn" style="justify-content:center" href="#/care">${icon('pulse')}${T('crew.job.care', 'Care notes')}${(inc.care || []).length ? ' (' + inc.care.length + ')' : ''}</a>
        <button class="btn c-btn" style="justify-content:center" data-action="crew-dest">${icon('building')}${inc.destination ? T('crew.job.change_dest', 'Change hospital') : T('crew.job.set_dest', 'Set hospital')}</button>
      </div>
      ${inc.destination && !toHospital ? html`<p class="sm muted">${T('crew.job.dest', 'Destination')}: <b>${inc.destination.name}</b></p>` : ''}
      ${cm.demoDrive && demoAvailable && ['assigned', 'enroute', 'transporting'].includes(s) ? html`<div class="c-demo"><p class="sm muted" style="margin:0 0 8px">${T('crew.demo.note', 'Demo only: moves the ambulance toward the target every 3 seconds instead of real GPS.')}</p><button class="btn ${demo.on ? 'primary' : ''}" data-action="crew-demo" aria-pressed="${demo.on ? 'true' : 'false'}">${icon('ambulance')}${demo.on ? T('crew.demo.stop', 'Stop simulated drive') : T('crew.demo.start', 'Simulate drive (demo)')}</button></div>` : ''}`;
  }
  function availabilityPanel() {
    const a = cm.unit.availability; const busy = !!cm.unit.currentIncidentId;
    return html`<section class="panel"><h2>${T('crew.avail.title', 'Your unit is')}: ${avLabel(a)}</h2>
      ${cm.unit.status !== 'in_service' ? html`<p class="notice warn">${T('crew.avail.out', 'This unit is out of service. Dispatch will not send it.')}</p>` : ''}
      ${!busy && cm.unit.status === 'in_service' ? html`<div class="c-stack">${['available', 'returning', 'offline'].map(x => html`<button class="btn c-btn ${a === x ? 'next' : ''}" data-action="crew-avail" data-av="${x}" aria-pressed="${a === x ? 'true' : 'false'}">${icon(x === 'available' ? 'check' : x === 'returning' ? 'refresh' : 'x')}${T('crew.avail.set_' + x, { available: 'Available for jobs', returning: 'Returning to base', offline: 'Off the road' }[x])}</button>`)}</div>` : ''}
      ${(cm.unit.notReadyReasons || []).length && a === 'available' ? html`<p class="notice warn">${T('crew.avail.not_ready', 'Dispatch cannot send this unit yet:')} ${cm.unit.notReadyReasons.map(r => T('crew.reason.' + r, { not_in_service: 'not in service', compliance_expired: 'papers expired', no_crew: 'no crew', crew_not_verified: 'crew licence not verified', no_crew_on_shift: 'no crew clocked in' }[r] || r)).join(', ')}</p>` : ''}
    </section>`;
  }
  async function jobPage({ stale }) {
    demo.on = false;
    await load();
    if (stale()) return;
    renderCurrent = () => { lastSig = sig(); view(jobView()); paintLoc(); };
    renderCurrent();
    MC.poll(async () => { await refresh(false); paintLoc(); }, 5000);
    MC.onLeave(() => { renderCurrent = null; demo.on = false; });
  }

  async function postStatus(step, extra = {}) {
    const inc = cm.incident; const body = Object.assign({ status: step }, extra);
    try { cm.incident = Object.assign(cm.incident, await api.post('/api/crew/incidents/' + inc.id + '/status', body)); }
    catch (e) {
      if (e.status === 0) { queue.push({ incidentId: inc.id, body, at: Date.now() }); saveQ(); toast(T('crew.queue.saved', 'No signal. Saved on this phone; it will be sent automatically.'), 'bad', 6000); if (renderCurrent) renderCurrent(); return false; }
      if (e.code === 'wrong_state') { toast(e.message, 'bad'); await refresh(true); return false; }
      throw e;
    }
    return true;
  }
  on('crew-step', async el => {
    const step = el.dataset.step; const st = STEPS.find(x => x.key === step);
    if (step === 'transporting' && !cm.incident.destination) {
      toast(T('crew.step.need_dest', 'Choose the hospital first'));
      const ok = await chooseDestination(); if (!ok) return;
    }
    if (step === 'clear') {
      const fromScene = effectiveStatus() === 'onscene';
      const v = await dialog({ title: fromScene ? T('crew.clear.q_scene', 'Finish this job without transport?') : T('crew.clear.q', 'Finish this job?'),
        body: html`<p>${T('crew.clear.body', 'This closes the job for everyone and bills the call-out. It cannot be undone.')}</p><p><b>${T('crew.clear.where', 'Where is the unit going now?')}</b></p>`,
        actions: [{ label: T('crew.clear.cancel', 'Not yet'), value: null }, { label: T('crew.clear.returning', 'Clear, returning to base'), value: 'returning' }, { label: T('crew.clear.available', 'Clear, available now'), value: 'available', primary: true }] });
      if (!v) return;
      const ok = await postStatus('clear', { returning: v === 'returning' });
      if (ok) { toast(T('crew.clear.done', 'Job cleared. Thank you.'), 'ok'); demo.on = false; }
      await refresh(true).catch(() => { });
      return;
    }
    const ok = await postStatus(step);
    if (ok) toast(T('crew.step.saved', 'Status: {s}', { s: T('crew.step.' + step, st.en) }), 'ok');
    if (renderCurrent) { lastSig = ''; renderCurrent(); }
  });

  async function chooseDestination() {
    const inc = cm.incident; const from = (cm.unit && cm.unit.lastLoc) || inc.location;
    const list = await api.get('/api/dispatch/destinations' + qs({ lat: from.lat, lng: from.lng }));
    const r = await dialog({ title: T('crew.dest.title', 'Which hospital?'), form: true,
      body: html`<div class="c-opts" role="radiogroup">${list.slice(0, 12).map(o => html`<label class="c-opt"><input type="radio" name="orgId" value="${o.orgId}" ${inc.destination && inc.destination.orgId === o.orgId ? 'checked' : ''}><span><b>${o.name}</b><br><span class="sm muted">${[o.area, o.distanceKm != null ? T('crew.dest.km', '{km} km', { km: o.distanceKm }) : ''].filter(Boolean).join(' | ')}</span></span></label>`)}</div>
        <div class="field"><label for="cd-n">${T('crew.dest.other', 'Another hospital (type the name)')}</label><input class="input" id="cd-n" name="name" maxlength="120"></div>`,
      actions: [{ label: T('crew.cancel', 'Cancel'), value: null }, { label: T('crew.dest.save', 'Set hospital'), primary: true }],
      onSubmit: d => { const b = d.name ? { name: d.name } : d.orgId ? { orgId: d.orgId } : null; if (!b) throw new MC.ApiError(400, { error: T('crew.dest.need', 'Choose a hospital or type a name') }); return api.post('/api/crew/incidents/' + inc.id + '/destination', b); } });
    if (!r) return false;
    cm.incident = Object.assign(cm.incident, r);
    toast(T('crew.dest.saved', 'Hospital set: {name}', { name: r.destination ? r.destination.name : '' }), 'ok');
    if (renderCurrent) { lastSig = ''; renderCurrent(); }
    return true;
  }
  on('crew-dest', chooseDestination);

  on('crew-avail', async el => {
    const a = el.dataset.av;
    if (a === 'offline' && !(await confirm({ title: T('crew.avail.off_q', 'Take the unit off the road?'), body: T('crew.avail.off_body', 'Dispatch will not send you jobs until you set it available again.'), ok: T('crew.avail.set_offline', 'Off the road') }))) return;
    cm.unit = Object.assign(cm.unit, await api.post('/api/crew/availability', { availability: a }));
    toast(T('crew.avail.saved', 'Unit is now: {a}', { a: avLabel(a) }), 'ok');
    if (renderCurrent) { lastSig = ''; renderCurrent(); }
  });

  /* demo helper: drive the unit with the demo endpoint every 3 s */
  on('crew-demo', async () => {
    if (demo.on) { demo.on = false; if (demo.stop) demo.stop(); demo.stop = null; syncSharing(); if (renderCurrent) { lastSig = ''; renderCurrent(); } return; }
    demo.on = true; stopSharing();
    const tick = async () => {
      if (!demo.on || !cm.incident) return;
      try {
        const r = await api.post('/api/crew/demo-drive', { incidentId: cm.incident.id });
        demo.remainingKm = r.remainingKm; paintLoc();
        if (r.arrived) { demo.on = false; if (demo.stop) demo.stop(); demo.stop = null; toast(T('crew.demo.arrived', 'Arrived (demo). Update your status.'), 'ok'); syncSharing(); if (renderCurrent) { lastSig = ''; renderCurrent(); } }
      } catch (e) {
        if (e.status === 404 && !e.code) demoAvailable = false;
        if (e.status === 404 || e.status === 409) { demo.on = false; if (demo.stop) demo.stop(); demo.stop = null; syncSharing(); if (renderCurrent) { lastSig = ''; renderCurrent(); } return; }
        throw e;
      }
    };
    demo.stop = MC.poll(tick, 3000);
    toast(T('crew.demo.on', 'Simulated drive started'));
    if (renderCurrent) { lastSig = ''; renderCurrent(); }
    tick().catch(() => { });
  });

  /* ---------------- care notes ---------------- */
  const QUICK = [['oxygen', 'Oxygen'], ['iv_access', 'IV access'], ['cpr', 'CPR'], ['defib', 'Defibrillation'], ['airway', 'Airway support'], ['bleeding_control', 'Bleeding control'], ['splint', 'Splint'], ['c_collar', 'Neck collar'], ['recovery_position', 'Recovery position'], ['fluids', 'IV fluids']];
  const VITALS = [['bpSys', 'BP systolic', 'mmHg', 30, 300, 1], ['bpDia', 'BP diastolic', 'mmHg', 10, 200, 1], ['pulse', 'Pulse', '/min', 0, 300, 1], ['rr', 'Breathing rate', '/min', 0, 80, 1], ['spo2', 'SpO2', '%', 0, 100, 1], ['tempC', 'Temperature', 'C', 25, 45, 0.1], ['gcs', 'GCS', '3 to 15', 3, 15, 1], ['glucose', 'Glucose', 'mmol/L', 0, 60, 0.1], ['painScore', 'Pain', '0 to 10', 0, 10, 1]];
  function careEntry(c) {
    const v = c.vitals || {};
    const parts = VITALS.filter(x => v[x[0]] != null).map(x => T('crew.vital.' + x[0], x[1]) + ' ' + v[x[0]] + (x[2] && !/to/.test(x[2]) ? ' ' + x[2] : ''));
    return html`<li><time>${MC.time(c.at)} | ${c.byName}</time>${parts.join(', ')}${(c.interventions || []).length ? html`<br>${T('crew.care.interventions', 'Interventions')}: ${c.interventions.join(', ')}` : ''}${(c.medications || []).length ? html`<br>${T('crew.care.meds', 'Medicines')}: ${c.medications.map(m => [m.name, m.dose, m.route].filter(Boolean).join(' ')).join(', ')}` : ''}${c.handoverNote ? html`<br><b>${T('crew.care.handover', 'Handover')}:</b> ${c.handoverNote}` : ''}${c.note ? html`<br>${c.note}` : ''}</li>`;
  }
  async function carePage({ stale }) {
    await load();
    if (stale()) return;
    const inc = cm.incident; const s = effectiveStatus();
    if (!inc) { view(html`<a class="back" href="#/job">${icon('left')}${T('crew.nav.job', 'Job')}</a>${empty({ icon: 'pulse', title: T('crew.care.no_job', 'No current job'), body: T('crew.care.no_job_sub', 'Care notes are recorded against the job you are on.') })}`); return; }
    const canAdd = ['enroute', 'onscene', 'transporting', 'athospital'].includes(s);
    const pi = inc.patientInfo;
    view(html`<a class="back" href="#/job">${icon('left')}${T('crew.nav.job', 'Job')}</a>
      <div class="page-head"><div><h1>${T('crew.care.title', 'Patient care notes')}</h1><p>${inc.number} | ${inc.categoryLabel || ''}</p></div></div>
      ${pi ? MC.wristband({ name: pi.firstName || T('crew.job.patient', 'Patient'), age: pi.age, sex: pi.sex, bloodGroup: pi.bloodGroup, allergies: pi.allergies || [], noKnownAllergies: pi.noKnownAllergies }) : ''}
      ${canAdd ? html`<form data-form="crew-care" class="panel" novalidate>
        <h2>${T('crew.care.vitals', 'Vital signs')}</h2>
        <div class="c-vitals">${VITALS.map(x => html`<div class="field"><label for="v-${x[0]}">${T('crew.vital.' + x[0], x[1])} <span class="muted sm">${x[2]}</span></label><input class="input" id="v-${x[0]}" name="v_${x[0]}" type="number" inputmode="${x[5] < 1 ? 'decimal' : 'numeric'}" min="${x[3]}" max="${x[4]}" step="${x[5]}"></div>`)}</div>
        <h2>${T('crew.care.interventions', 'Interventions')}</h2>
        <div class="c-chips">${QUICK.map(q => html`<label class="c-chip"><input type="checkbox" name="quick" data-list value="${T('crew.care.q.' + q[0], q[1])}">${T('crew.care.q.' + q[0], q[1])}</label>`)}</div>
        <div class="field" style="margin-top:12px"><label for="cc-o">${T('crew.care.other', 'Other intervention')}</label><input class="input" id="cc-o" name="other" maxlength="120"></div>
        <h2>${T('crew.care.meds_given', 'Medicines given')}</h2>
        <div class="fields three"><div class="field"><label for="cm-n">${T('crew.care.med_name', 'Medicine')}</label><input class="input" id="cm-n" name="medName" maxlength="80"></div><div class="field"><label for="cm-d">${T('crew.care.med_dose', 'Dose')}</label><input class="input" id="cm-d" name="medDose" maxlength="40"></div><div class="field"><label for="cm-r">${T('crew.care.med_route', 'Route')}</label><input class="input" id="cm-r" name="medRoute" maxlength="30" placeholder="${T('crew.care.route_ph', 'e.g. IV, oral')}"></div></div>
        <div class="field"><label for="cc-h">${T('crew.care.handover_note', 'Handover note')}</label><textarea class="input" id="cc-h" name="handoverNote" maxlength="2000" placeholder="${T('crew.care.handover_ph', 'What the receiving team needs to know')}"></textarea></div>
        <div class="field"><label for="cc-n">${T('crew.care.note', 'Other notes')}</label><textarea class="input" id="cc-n" name="note" maxlength="1000"></textarea></div>
        <div class="form-err notice bad" hidden></div>
        <button class="btn primary c-btn" style="justify-content:center" type="submit">${icon('check')}${T('crew.care.save', 'Save care notes')}</button></form>` : html`<div class="notice">${s === 'assigned' ? T('crew.care.not_yet', 'Care notes open once you are en route.') : T('crew.care.closed', 'This job is finished.')}</div>`}
      <section class="panel"><h2>${T('crew.care.recorded', 'Recorded')}</h2>${(inc.care || []).length ? html`<ol class="timeline">${inc.care.slice().reverse().map(careEntry)}</ol>` : html`<p class="muted sm">${T('crew.care.none', 'Nothing recorded yet.')}</p>`}</section>`);
    form('crew-care', async (d, f) => {
      const body = {}; const vit = {};
      VITALS.forEach(x => { const v = d['v_' + x[0]]; if (v !== undefined && !Number.isNaN(v)) vit[x[0]] = v; });
      if (Object.keys(vit).length) body.vitals = vit;
      const iv = (d.quick || []).slice(); if (d.other) iv.push(d.other); if (iv.length) body.interventions = iv;
      if (d.medName) body.medications = [{ name: d.medName, dose: d.medDose || undefined, route: d.medRoute || undefined }];
      if (d.handoverNote) body.handoverNote = d.handoverNote; if (d.note) body.note = d.note;
      if (!Object.keys(body).length) throw new MC.ApiError(400, { error: T('crew.care.empty', 'Enter at least one vital sign, intervention or note') });
      const r = await api.post('/api/crew/incidents/' + inc.id + '/care', body);
      inc.care = (inc.care || []).concat(r.entry);
      f.reset(); toast(T('crew.care.saved', 'Care notes saved'), 'ok');
      MC.render();
    });
  }

  /* ---------------- unit and me ---------------- */
  async function unitPage({ stale }) {
    await load();
    if (stale()) return;
    renderCurrent = () => {
      lastSig = sig();
      const u = cm.unit; const p = cm.profile;
      const comp = u ? Object.entries(u.compliance || {}).filter(([, x]) => x && (x.expired || x.expiringSoon)) : [];
      view(html`${header()}<div class="page-head"><div><h1>${u ? u.name : T('crew.unit.none', 'No unit')}</h1><p>${u ? u.type + ' | ' + u.plate : T('crew.no_unit.sub', 'Ask your fleet manager or dispatcher to put you on an ambulance. This screen updates by itself.')}</p></div></div>
        ${u && cm.onShift ? availabilityPanel() : ''}
        ${!cm.onShift ? html`<button class="btn primary c-btn" style="justify-content:center;margin-bottom:16px" data-action="crew-clock-in">${icon('clock')}${T('crew.off.clock_in', 'Clock in to start duty')}</button>` : ''}
        ${u ? html`<section class="panel"><h2>${T('crew.unit.crew', 'Crew on this unit')}</h2><ul class="list">${u.crew.map(c => html`<li><div class="grow"><span class="title">${c.name}</span><span class="sub">${c.certification || ''}${c.onShift ? ' | ' + T('crew.unit.on_shift', 'on shift') : ' | ' + T('crew.unit.off_shift', 'not clocked in')}</span></div>${c.verified && c.licenceValid ? badge(T('crew.unit.ok', 'Licence OK'), 'ok') : badge(T('crew.unit.check', 'Licence needs checking'), 'warn')}</li>`)}</ul></section>` : ''}
        ${comp.length ? html`<div class="notice warn">${comp.map(([k, x]) => html`<div>${x.expired ? T('crew.unit.doc_expired', '{doc} has expired', { doc: T('crew.doc.' + k, MC.cap(k)) }) : T('crew.unit.doc_soon', '{doc} expires in {n} days', { doc: T('crew.doc.' + k, MC.cap(k)), n: x.daysLeft })}</div>`)}</div>` : ''}
        <section class="panel"><h2>${T('crew.me.title', 'My licence')}</h2>${p ? html`<dl class="kv"><dt>${T('crew.me.cert', 'Certification')}</dt><dd>${p.certification}</dd><dt>${T('crew.me.expiry', 'Expires')}</dt><dd>${MC.date(Date.parse(p.licenceExpiry))}</dd><dt>${T('crew.me.verified', 'Checked by your provider')}</dt><dd>${p.verified ? badge(T('crew.me.yes', 'Yes'), 'ok') : badge(T('crew.me.no', 'Not yet'), 'warn')}</dd></dl>${!p.licenceValid ? html`<p class="notice bad">${T('crew.me.expired', 'Your licence has expired. You cannot be dispatched until it is renewed.')}</p>` : ''}` : html`<p class="muted">${T('crew.me.none', 'Your licence details are not on file. Give them to your fleet manager.')}</p>`}</section>`);
      paintLoc();
    };
    renderCurrent();
    MC.poll(async () => { await refresh(false); paintLoc(); }, 10000);
    MC.onLeave(() => { renderCurrent = null; });
  }

  MC.boot({
    title: 'MediCore Crew', subtitle: T('crew.login.sub', 'For ambulance crews on the road'), home: '#/job',
    nav: [
      { href: '#/job', label: T('crew.nav.job', 'Job'), icon: 'ambulance', perm: 'ambulance.crew' },
      { href: '#/care', label: T('crew.nav.care', 'Care notes'), icon: 'pulse', perm: 'ambulance.crew' },
      { href: '#/unit', label: T('crew.nav.unit', 'My unit'), icon: 'user', perm: 'ambulance.crew' },
    ],
    routes: { '#/job': jobPage, '#/care': carePage, '#/unit': unitPage },
    onReady: async () => { prevIncidentId = undefined; try { await flushQueue(); } catch (e) { /* retried later */ } },
  });
})();
