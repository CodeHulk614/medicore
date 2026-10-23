/* MediCore Dispatch: ambulance command view for a standalone ambulance service or a hospital fleet.
 * Board (live incidents + map), new call, incident handling, fleet and crew, response metrics.
 * Roles: ambulance_dispatcher (ambulance.dispatch + ambulance.fleet). */
(function () {
  'use strict';
  const { html, api, qs, icon, badge, empty, figures, view, on, form, dialog, confirm, toast } = MC;
  const T = MC.t;

  /* ---------------- app styles (layout only; colours come from the kit tokens) ---------------- */
  const css = document.createElement('style');
  css.textContent = `
    #main :is(dd, p, a:not(.btn), span:not(.btn), h1, h2, li, time, .lm) > svg { width: 1.1em; height: 1.1em; vertical-align: -0.18em; flex: none; }
    .d-board { display: grid; gap: var(--s4); }
    @media (min-width: 1100px) { .d-board { grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); align-items: start; } .d-board .d-mapcol { position: sticky; top: calc(var(--top) + 16px); } }
    .d-inc { display: grid; gap: var(--s4); }
    @media (min-width: 1100px) { .d-inc { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); align-items: start; } }
    .d-pri { min-width: 34px; justify-content: center; font-size: var(--t-sm); }
    .d-pri::before { display: none; }
    .d-age { font-weight: 700; white-space: nowrap; }
    .d-age svg { width: 16px; height: 16px; vertical-align: -3px; }
    .map { isolation: isolate; position: relative; z-index: 0; }
    .d-age.bad { color: var(--red); } .d-age.warn { color: var(--amber); }
    .d-flags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
    .d-legend { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); font-size: var(--t-xs); color: var(--ink-3); margin: var(--s2) 0 var(--s3); }
    .d-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; vertical-align: -1px; border: 2px solid #fff; box-shadow: 0 0 0 1px var(--line); }
    .d-legend i.hollow { background: transparent !important; border: 2px dashed var(--ink-3); box-shadow: none; }
    .d-pin { background: #10282B; color: #fff; font: 700 12px/1 var(--f); padding: 4px 6px; border-radius: 6px; border: 2px solid #fff; box-shadow: 0 1px 4px rgba(0,0,0,.35); white-space: nowrap; text-align: center; }
    .d-pin.P1 { background: #B42D27; } .d-pin.P2 { background: #9A5B00; } .d-pin.P3 { background: #3C5457; }
    .d-pin.dest { background: #3D4FA6; }
    .d-opts { display: grid; gap: var(--s2); max-height: 320px; overflow-y: auto; margin-bottom: var(--s3); }
    .d-opt { display: flex; gap: var(--s3); align-items: flex-start; padding: var(--s3); border: 1px solid var(--line); border-radius: var(--r-sm); cursor: pointer; min-height: 48px; }
    .d-opt input { width: 20px; height: 20px; margin: 2px 0 0; accent-color: var(--hue); flex: none; }
    .d-opt:has(input:checked) { border-color: var(--hue); background: var(--hue-soft); }
    .d-loc { display: grid; gap: var(--s3); }
    .d-pick { height: 300px; }
    .d-sel { padding: var(--s3) var(--s4); border-radius: var(--r-sm); background: var(--sunken); border: 1px solid var(--line); font-size: var(--t-sm); }
    .d-sel.ok { background: var(--green-soft); border-color: color-mix(in srgb, var(--green) 30%, transparent); }
    .d-unitrow .end .btn { margin-top: 4px; }
  `;
  document.head.appendChild(css);

  /* ---------------- shared labels ---------------- */
  const CAT_EN = { cardiac_arrest: 'Cardiac arrest', breathing_difficulty: 'Breathing difficulty', unconscious: 'Unconscious', stroke_symptoms: 'Stroke symptoms', obstetric_emergency: 'Obstetric emergency', road_traffic_accident: 'Road traffic accident', bleeding: 'Bleeding', burns: 'Burns', seizure: 'Seizure', trauma_fall: 'Trauma / fall', other: 'Other' };
  const CAT_PRI = { cardiac_arrest: 'P1', breathing_difficulty: 'P1', unconscious: 'P1', stroke_symptoms: 'P1', obstetric_emergency: 'P1', road_traffic_accident: 'P2', bleeding: 'P2', burns: 'P2', seizure: 'P2', trauma_fall: 'P2', other: 'P3' };
  let cats = null;
  const catLabel = k => T('dispatch.cat.' + k, CAT_EN[k] || (cats && cats[k] && cats[k].label) || MC.cap(k));
  const catPri = k => (cats && cats[k] && cats[k].priority) || CAT_PRI[k] || 'P3';
  const CAT_KEYS = Object.keys(CAT_EN);

  const INC_STEPS = ['new', 'assigned', 'enroute', 'onscene', 'transporting', 'athospital', 'closed'];
  const INC_EN = { new: 'Waiting for a unit', assigned: 'Unit assigned', enroute: 'En route', onscene: 'On scene', transporting: 'Transporting', athospital: 'At hospital', closed: 'Closed', cancelled: 'Cancelled' };
  const incLabel = s => T('dispatch.status.' + s, INC_EN[s] || MC.cap(s));
  const INC_KIND = { new: 'bad', assigned: 'warn', enroute: 'info', onscene: 'info', transporting: 'info', athospital: 'info', closed: 'ok', cancelled: 'outline' };
  const incBadge = s => badge(incLabel(s), INC_KIND[s] || 'info');
  const stepLabels = () => Object.fromEntries(INC_STEPS.map(s => [s, T('dispatch.step.' + s, { new: 'Received', assigned: 'Assigned', enroute: 'En route', onscene: 'On scene', transporting: 'Transporting', athospital: 'At hospital', closed: 'Closed' }[s])]));

  const AV_EN = { available: 'Available', assigned: 'Assigned', enroute: 'En route', onscene: 'On scene', transporting: 'Transporting', athospital: 'At hospital', returning: 'Returning', offline: 'Offline' };
  const avLabel = a => T('dispatch.avail.' + a, AV_EN[a] || MC.cap(a));
  const AV_KIND = { available: 'ok', returning: 'warn', offline: 'outline' };
  const avBadge = a => badge(avLabel(a), AV_KIND[a] || 'bad');
  const AV_COLOR = a => a === 'available' ? '#1E7A4C' : a === 'returning' ? '#C98A1B' : a === 'offline' ? '#66797B' : '#B42D27';
  const REASON_EN = { not_in_service: 'Not in service', compliance_expired: 'Papers expired', no_crew: 'No crew on the unit', crew_not_verified: 'Crew licence not verified', no_crew_on_shift: 'Crew not clocked in' };
  const reasonLabel = r => T('dispatch.reason.' + r, REASON_EN[r] || MC.cap(r));
  const UNIT_STATUS_EN = { in_service: 'In service', maintenance: 'Maintenance', retired: 'Retired' };
  const unitStatusLabel = s => T('dispatch.unit_status.' + s, UNIT_STATUS_EN[s] || MC.cap(s));
  const SOURCE_EN = { app: 'Patient app SOS', call: 'Phone call', public: 'Public emergency line', transfer: 'Transfer' };
  const sourceLabel = s => T('dispatch.source.' + s, SOURCE_EN[s] || MC.cap(s));
  const UNIT_TYPES = ['ALS', 'BLS', 'motorbike', 'transfer'];
  const typeLabel = ty => T('dispatch.unit_type.' + ty, { ALS: 'ALS (advanced)', BLS: 'BLS (basic)', motorbike: 'Motorbike responder', transfer: 'Transfer vehicle' }[ty] || ty);
  const CERTS = ['EMT-B', 'EMT-I', 'Paramedic', 'Driver'];

  const pri = p => html`<span class="badge d-pri pri-${p}" title="${T('dispatch.priority', 'Priority')}">${p}</span>`;
  const mins = m => (m == null ? '' : T('dispatch.min', '{n} min', { n: m }));
  const ageMin = ts => Math.max(0, Math.round((Date.now() - ts) / 60000));
  const fmtAge = m => (m < 60 ? T('dispatch.age.min', '{n} min', { n: m }) : T('dispatch.age.h', '{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 }));
  const telHref = p => 'tel:' + String(p || '').replace(/[^+\d]/g, '');
  const locText = l => (l ? [l.address, l.landmark].filter(Boolean).join(' | ') || (l.lat != null ? l.lat.toFixed(5) + ', ' + l.lng.toFixed(5) : '') : '');
  const isOpen = s => !['closed', 'cancelled'].includes(s);
  const perm = p => !!(MC.me && (MC.me.perms || []).includes(p));

  /* delegated change / enter handlers (no inline JS) */
  const changes = {};
  document.addEventListener('change', e => { const el = e.target.closest('[data-change]'); if (el && changes[el.dataset.change]) changes[el.dataset.change](el, e); });
  document.addEventListener('keydown', e => { if (e.key !== 'Enter') return; const el = e.target.closest('[data-enter]'); if (!el) return; e.preventDefault(); const b = document.getElementById(el.dataset.enter); if (b) b.click(); });

  /* ---------------- maps: kit map + our own layers (unit colour by availability, stale = hollow) ---------------- */
  async function safeMap(el, opts, noteEl) {
    if (!el) return null;
    let m = null;
    try { m = await MC.map(el, opts); }
    catch (e) { el.hidden = true; if (noteEl) noteEl.textContent = T('dispatch.map.failed', 'The map could not load. Positions are listed below.'); return null; }
    setTimeout(() => { if (el.isConnected && !el.querySelector('.leaflet-tile-loaded') && noteEl) noteEl.textContent = T('dispatch.map.no_tiles', 'Map images could not load (offline or blocked). Markers still show; positions are also listed below.'); }, 6000);
    return m;
  }
  function layerSet(m) {
    const L = window.L; const layers = {};
    return {
      set(key, pos, o) {
        if (!m || !L || !pos || pos.lat == null) return;
        const ll = [pos.lat, pos.lng];
        let ly = layers[key];
        if (o.pin) {
          const ic = L.divIcon({ className: '', html: '<div class="d-pin ' + MC.esc(o.cls || '') + '">' + MC.esc(o.pin) + '</div>', iconSize: null, iconAnchor: [14, 12] });
          if (ly) { ly.setLatLng(ll); ly.setIcon(ic); } else { ly = layers[key] = L.marker(ll, { icon: ic, keyboard: false }).addTo(m.leaflet); }
        } else {
          const st = { radius: 9, color: o.stale ? '#3C5457' : '#fff', weight: 2, dashArray: o.stale ? '3 3' : null, fillColor: o.color, fillOpacity: o.stale ? 0.2 : 1 };
          if (ly) { ly.setLatLng(ll); ly.setStyle(st); } else { ly = layers[key] = L.circleMarker(ll, st).addTo(m.leaflet); }
        }
        if (o.label) { if (ly.getTooltip()) ly.setTooltipContent(MC.esc(o.label)); else ly.bindTooltip(MC.esc(o.label), { direction: 'top' }); }
        if (o.href && !ly._mcHref) { ly._mcHref = true; ly.on('click', () => MC.go(o.href)); }
      },
      prune(keep) { Object.keys(layers).forEach(k => { if (!keep.includes(k)) { m.leaflet.removeLayer(layers[k]); delete layers[k]; } }); },
      fit() { if (!m || !L) return; const all = Object.values(layers).map(x => x.getLatLng()); if (all.length > 1) m.leaflet.fitBounds(L.latLngBounds(all).pad(0.2)); else if (all.length === 1) m.leaflet.setView(all[0], 14); },
    };
  }
  const unitMapLabel = u => u.name + ': ' + avLabel(u.availability) + (u.lastLoc && !u.lastLocFresh ? ' (' + T('dispatch.map.stale_at', 'location stale, {ago}', { ago: MC.ago(u.lastLoc.at) }) + ')' : '');
  const legend = () => html`<div class="d-legend" aria-hidden="true"><span><i style="background:#1E7A4C"></i>${T('dispatch.legend.available', 'Available unit')}</span><span><i style="background:#B42D27"></i>${T('dispatch.legend.busy', 'Unit on a job')}</span><span><i style="background:#C98A1B"></i>${T('dispatch.legend.returning', 'Returning')}</span><span><i style="background:#66797B"></i>${T('dispatch.legend.offline', 'Offline')}</span><span><i class="hollow"></i>${T('dispatch.legend.stale', 'Location stale')}</span><span><b>P1</b> ${T('dispatch.legend.incident', 'Incident pin')}</span></div>`;

  function unitLocLine(u) {
    if (!u.lastLoc) return T('dispatch.unit.no_gps', 'No GPS position yet');
    return u.lastLocFresh ? T('dispatch.unit.gps_fresh', 'GPS {ago}', { ago: MC.ago(u.lastLoc.at) }) : T('dispatch.unit.gps_stale', 'Location stale: last GPS {ago}', { ago: MC.ago(u.lastLoc.at) });
  }

  /* ---------------- board ---------------- */
  function setCounts(d) {
    const waiting = d.incidents.filter(i => i.status === 'new').length;
    MC.navCount('#/board', waiting || d.incidents.length);
  }
  function incRow(i) {
    const age = i.ageMin != null ? i.ageMin : ageMin(i.createdAt);
    const tone = i.status === 'new' ? (age >= (i.triage.priority === 'P1' ? 3 : 8) ? 'bad' : 'warn') : '';
    return html`<a href="#/incident/${i.id}">
      ${pri(i.triage.priority)}
      <div class="grow"><span class="title">${catLabel(i.triage.category)} <span class="muted sm">${i.number}</span></span>
        <span class="sub">${locText(i.location) || T('dispatch.board.no_address', 'No address given')}</span>
        <span class="d-flags">${incBadge(i.status)}${!i.verified ? badge(T('dispatch.flag.unverified', 'Unverified public report'), 'warn') : ''}${i.noUnitAvailable && i.status === 'new' ? badge(T('dispatch.flag.no_unit', 'No unit was free'), 'bad') : ''}${i.unitName ? badge(i.unitName, 'outline') : ''}${i.patientInfo && (i.patientInfo.allergies || []).length ? badge(T('dispatch.flag.allergy', 'Allergies'), 'bad') : ''}${i.triage.overridden ? badge(T('dispatch.flag.override', 'Priority changed'), 'outline') : ''}</span></div>
      <span class="end"><span class="d-age ${tone}">${icon('clock')} ${fmtAge(age)}</span><br><span class="xs muted">${MC.time(i.createdAt)}</span></span></a>`;
  }
  function unitRow(u) {
    return html`<li><div class="grow"><span class="title">${u.name} <span class="muted sm">${u.type} | ${u.plate}</span></span>
      <span class="sub">${unitLocLine(u)}${u.crew && u.crew.length ? ' | ' + u.crew.map(c => c.name).join(', ') : ''}</span>
      ${u.notReadyReasons && u.notReadyReasons.length && u.availability === 'available' ? html`<span class="d-flags">${u.notReadyReasons.map(r => badge(reasonLabel(r), 'warn'))}</span>` : ''}</div>
      <span class="end">${avBadge(u.availability)}${u.lastLoc && !u.lastLocFresh ? html`<br>${badge(T('dispatch.unit.stale', 'Stale'), 'outline')}` : ''}${u.currentIncidentId ? html`<br><a class="xs" href="#/incident/${u.currentIncidentId}">${T('dispatch.unit.open_job', 'Open job')}</a>` : ''}</span></li>`;
  }
  async function board({ stale }) {
    const d = await api.get('/api/dispatch/board');
    if (stale()) return;
    cats = d.categories || cats;
    view(html`<div class="page-head"><div><h1>${T('dispatch.board.title', 'Dispatch board')}</h1><p id="b-sum"></p></div>
      <div class="actions"><a class="btn primary" href="#/new">${icon('plus')}${T('dispatch.board.new', 'New call')}</a>${refOK() ? html`<a class="btn" href="#/referrals">${icon('swap')}${T('dispatch.board.referrals', 'Referrals')}</a>` : ''}</div></div>
      <div id="b-ref-note"></div><div class="d-board"><section aria-labelledby="b-inc-h"><h2 id="b-inc-h" class="sr-only">${T('dispatch.board.open', 'Open incidents')}</h2><div id="b-inc"></div></section>
      <section class="d-mapcol" aria-labelledby="b-map-h"><h2 id="b-map-h" class="sr-only">${T('dispatch.board.map', 'Map of incidents and units')}</h2>
        <div class="map" id="b-map" role="region" aria-label="${T('dispatch.board.map', 'Map of incidents and units')}"></div><p class="xs muted" id="b-map-note" role="status"></p>${legend()}
        <h3>${T('dispatch.board.units', 'Units')}</h3><div id="b-units"></div></section></div>`);
    const refNote = document.getElementById('b-ref-note');
    MC.referrals.homeNotice(refNote); MC.poll(() => MC.referrals.homeNotice(refNote), 20000);
    const paint = data => {
      const open = data.incidents; const waiting = open.filter(i => i.status === 'new').length; const avail = data.units.filter(u => u.dispatchable).length;
      const sum = document.getElementById('b-sum'); if (!sum) return;
      sum.textContent = T('dispatch.board.summary', '{open} open | {waiting} waiting for a unit | {avail} units ready', { open: open.length, waiting, avail });
      view(open.length ? html`<div class="list">${open.map(incRow)}</div>` : empty({ icon: 'ambulance', title: T('dispatch.board.empty', 'No open incidents'), body: T('dispatch.board.empty_sub', 'New calls, patient SOS alerts and public reports appear here as they come in.'), action: html`<a class="btn primary" href="#/new">${icon('plus')}${T('dispatch.board.new', 'New call')}</a>` }), document.getElementById('b-inc'));
      view(data.units.length ? html`<ul class="list">${data.units.map(unitRow)}</ul>` : empty({ icon: 'ambulance', title: T('dispatch.board.no_units', 'No units yet'), action: perm('ambulance.fleet') ? html`<a class="btn" href="#/fleet">${T('dispatch.board.add_units', 'Add units in Fleet')}</a>` : '' }), document.getElementById('b-units'));
      setCounts(data);
    };
    paint(d);
    const org = MC.me.org && MC.me.org.location;
    const m = await safeMap(document.getElementById('b-map'), { center: org && org.lat != null ? org : undefined, zoom: 12 }, document.getElementById('b-map-note'));
    if (stale()) return;
    const ls = layerSet(m); let fitted = false;
    const paintMap = data => {
      const keep = [];
      data.incidents.forEach(i => { keep.push('i' + i.id); ls.set('i' + i.id, i.location, { pin: i.triage.priority + (i.verified ? '' : ' ?'), cls: i.triage.priority, label: i.number + ' ' + catLabel(i.triage.category) + ': ' + incLabel(i.status), href: '#/incident/' + i.id }); });
      data.units.forEach(u => { if (!u.lastLoc) return; keep.push('u' + u.id); ls.set('u' + u.id, u.lastLoc, { color: AV_COLOR(u.availability), stale: !u.lastLocFresh, label: unitMapLabel(u) }); });
      ls.prune(keep);
      if (!fitted && keep.length) { ls.fit(); fitted = true; }
    };
    if (m) paintMap(d);
    MC.poll(async () => { const n = await api.get('/api/dispatch/board'); if (stale()) return; paint(n); if (m) paintMap(n); }, 5000);
  }

  /* ---------------- patient search (shared by new call and incident) ---------------- */
  async function searchPatients(q) {
    if (!q || q.trim().length < 2) throw new MC.ApiError(400, { error: T('dispatch.pt.need_q', 'Type at least 2 letters of the name, a phone number or an MRN') });
    return api.get('/api/fd/patients' + qs({ q: q.trim(), limit: 8 }));
  }
  const ptLine = p => [p.age != null ? T('dispatch.pt.age', '{n} yrs', { n: p.age }) : '', p.sex ? MC.cap(p.sex) : '', p.mrn ? 'MRN ' + p.mrn : '', p.phone || ''].filter(Boolean).join(' | ');

  /* ---------------- new call ---------------- */
  async function newCall({ stale }) {
    if (!cats) { try { const b = await api.get('/api/dispatch/board'); cats = b.categories; } catch (e) { /* fall back to the built-in list */ } }
    if (stale()) return;
    const st = { patient: null, loc: null };
    view(html`<a class="back" href="#/board">${icon('left')}${T('dispatch.nav.board', 'Board')}</a>
      <div class="page-head"><div><h1>${T('dispatch.new.title', 'New emergency call')}</h1><p>${T('dispatch.new.sub', 'Take the caller\'s details, fix the location, then create the incident and assign a unit.')}</p></div></div>
      <form data-form="call-new" class="d-inc" novalidate>
        <div>
          <section class="panel"><h2>${T('dispatch.new.caller', 'Caller')}</h2>
            <div class="fields two"><div class="field"><label for="c-n">${T('dispatch.new.caller_name', 'Caller name')}</label><input class="input" id="c-n" name="callerName" maxlength="100" autocomplete="off"></div>
            <div class="field"><label for="c-p">${T('dispatch.new.caller_phone', 'Caller phone')}</label><input class="input" id="c-p" name="callerPhone" inputmode="tel" placeholder="0803 123 4567" autocomplete="off"></div></div>
          </section>
          <section class="panel"><h2>${T('dispatch.new.what', 'What happened')}</h2>
            <div class="fields two"><div class="field"><label for="c-cat">${T('dispatch.new.category', 'Category')}</label><select class="input" id="c-cat" name="category" data-change="cat" required><option value="">${T('dispatch.new.choose', 'Choose...')}</option>${CAT_KEYS.map(k => html`<option value="${k}">${catLabel(k)} (${catPri(k)})</option>`)}</select></div>
            <div class="field"><label for="c-pri">${T('dispatch.new.priority', 'Priority')}</label><select class="input" id="c-pri" name="priority"><option value="" id="c-pri-auto">${T('dispatch.new.pri_auto', 'Automatic from category')}</option><option value="P1">${T('dispatch.new.pri_p1', 'P1: life threatening')}</option><option value="P2">${T('dispatch.new.pri_p2', 'P2: urgent')}</option><option value="P3">${T('dispatch.new.pri_p3', 'P3: not urgent')}</option></select><div class="hint" id="c-pri-hint">${T('dispatch.new.pri_hint', 'Leave on automatic unless you have a clinical reason. A change is recorded.')}</div></div></div>
            <div class="field"><label for="c-note">${T('dispatch.new.notes', 'Notes')}</label><textarea class="input" id="c-note" name="note" maxlength="1000" placeholder="${T('dispatch.new.notes_ph', 'What the caller says, number of patients, hazards')}"></textarea></div>
          </section>
          <section class="panel"><h2>${T('dispatch.new.patient', 'Registered patient (optional)')}</h2>
            <p class="muted sm">${T('dispatch.new.patient_sub', 'Link the patient if they are registered with you: the crew then sees allergies and blood group, and the case can be billed.')}</p>
            <div id="c-pt-sel"></div>
            <div class="row wrap"><div class="field grow" style="flex:1;min-width:200px;margin:0"><label for="c-pq" class="sr-only">${T('dispatch.new.patient_q', 'Name, phone or MRN')}</label><div class="search">${icon('search')}<input class="input" id="c-pq" data-enter="c-pq-go" placeholder="${T('dispatch.new.patient_q', 'Name, phone or MRN')}" autocomplete="off"></div></div>
              <button type="button" class="btn" id="c-pq-go" data-action="call-pt-search">${T('dispatch.new.find', 'Find patient')}</button>
              <button type="button" class="btn ghost" data-action="call-pt-phone">${T('dispatch.new.find_phone', 'Use caller phone')}</button></div>
            <div id="c-pt-res" style="margin-top:12px"></div>
          </section>
        </div>
        <div>
          <section class="panel"><h2>${T('dispatch.new.location', 'Location')}</h2>
            <div class="d-loc">
              <div id="c-loc-sel" class="d-sel" role="status">${T('dispatch.new.no_loc', 'No location yet. Search an address or tap the map.')}</div>
              <div class="row wrap"><div style="flex:1;min-width:200px"><label for="c-aq" class="sr-only">${T('dispatch.new.addr_q', 'Search an address or place')}</label><div class="search">${icon('search')}<input class="input" id="c-aq" data-enter="c-aq-go" placeholder="${T('dispatch.new.addr_q', 'Search an address or place')}" autocomplete="off"></div></div><button type="button" class="btn" id="c-aq-go" data-action="call-geo">${T('dispatch.new.search', 'Search')}</button></div>
              <div id="c-geo-res"></div>
              <div class="map d-pick" id="c-map" role="region" aria-label="${T('dispatch.new.map', 'Tap the map to place the incident')}"></div><p class="xs muted" id="c-map-note">${T('dispatch.new.map_hint', 'Tap the map to place or move the pin.')}</p>
              <div class="field"><label for="c-addr">${T('dispatch.new.address', 'Address')}</label><input class="input" id="c-addr" name="address" maxlength="300" autocomplete="off"></div>
              <div class="field"><label for="c-lm">${T('dispatch.new.landmark', 'Landmark')}</label><input class="input" id="c-lm" name="landmark" maxlength="200" placeholder="${T('dispatch.new.landmark_ph', 'e.g. Opposite the filling station')}" autocomplete="off"></div>
              <details><summary class="sm">${T('dispatch.new.coords', 'Enter coordinates by hand')}</summary><div class="fields two" style="margin-top:8px"><div class="field"><label for="c-lat">${T('dispatch.new.lat', 'Latitude')}</label><input class="input" id="c-lat" type="number" step="any" data-change="coords"></div><div class="field"><label for="c-lng">${T('dispatch.new.lng', 'Longitude')}</label><input class="input" id="c-lng" type="number" step="any" data-change="coords"></div></div></details>
            </div>
          </section>
          <div class="form-err notice bad" hidden></div>
          <button class="btn primary lg block" type="submit">${icon('ambulance')}${T('dispatch.new.create', 'Create incident')}</button>
        </div>
      </form>`);
    const selEl = () => document.getElementById('c-loc-sel');
    const m = await safeMap(document.getElementById('c-map'), { center: MC.me.org && MC.me.org.location && MC.me.org.location.lat != null ? MC.me.org.location : undefined, zoom: 12 }, document.getElementById('c-map-note'));
    if (stale()) return;
    const ls = layerSet(m);
    const setLoc = (lat, lng, label, opts = {}) => {
      st.loc = { lat: Number(lat), lng: Number(lng) };
      const s = selEl(); if (!s) return;
      s.className = 'd-sel ok'; s.textContent = T('dispatch.new.loc_set', 'Location set: {where}', { where: label || (st.loc.lat.toFixed(5) + ', ' + st.loc.lng.toFixed(5)) });
      ls.set('pick', st.loc, { pin: T('dispatch.new.pin', 'Here'), cls: 'P1' }); if (opts.center && m) m.leaflet.setView([st.loc.lat, st.loc.lng], 16);
      const la = document.getElementById('c-lat'), ln = document.getElementById('c-lng'); if (la && !opts.fromInputs) { la.value = st.loc.lat.toFixed(6); ln.value = st.loc.lng.toFixed(6); }
    };
    if (m) m.leaflet.on('click', async e => {
      setLoc(e.latlng.lat, e.latlng.lng);
      const a = document.getElementById('c-addr');
      if (a && !a.value) { try { const r = await api.get('/api/geo/reverse' + qs({ lat: e.latlng.lat.toFixed(6), lng: e.latlng.lng.toFixed(6) })); if (r.label && a.isConnected && !a.value) { a.value = r.label; setLoc(e.latlng.lat, e.latlng.lng, r.label); } } catch (err) { /* reverse lookup is optional */ } }
    });
    changes.coords = () => { const la = Number(document.getElementById('c-lat').value), ln = Number(document.getElementById('c-lng').value); if (la && ln) setLoc(la, ln, null, { center: true, fromInputs: true }); };
    changes.cat = el => { const o = document.getElementById('c-pri-auto'); if (o) o.textContent = el.value ? T('dispatch.new.pri_auto_is', 'Automatic: {p} for {cat}', { p: catPri(el.value), cat: catLabel(el.value) }) : T('dispatch.new.pri_auto', 'Automatic from category'); };
    let geoRes = [];
    on('call-geo', async () => {
      const q = document.getElementById('c-aq').value.trim(); const box = document.getElementById('c-geo-res');
      if (q.length < 3) { toast(T('dispatch.new.geo_short', 'Type at least 3 characters to search'), 'bad'); return; }
      const c = st.loc || (MC.me.org && MC.me.org.location) || {};
      const r = await api.get('/api/geo/search' + qs({ q, lat: c.lat, lng: c.lng }));
      geoRes = r.results || [];
      if (!r.available) { view(html`<div class="notice warn">${T('dispatch.new.geo_off', 'Address search is not available right now. Tap the map, or enter coordinates by hand, and type the address and landmark.')}</div>`, box); return; }
      view(geoRes.length ? html`<ul class="list">${geoRes.map((g, i) => html`<li><div class="grow"><span class="title">${g.label}</span></div><button type="button" class="btn sm" data-action="call-geo-pick" data-i="${i}">${T('dispatch.new.use', 'Use this')}</button></li>`)}</ul>` : html`<p class="muted sm">${T('dispatch.new.geo_none', 'No places found. Try a nearby landmark or tap the map.')}</p>`, box);
    });
    on('call-geo-pick', el => { const g = geoRes[Number(el.dataset.i)]; if (!g) return; setLoc(g.lat, g.lng, g.label, { center: true }); const a = document.getElementById('c-addr'); if (a) a.value = g.label; view('', document.getElementById('c-geo-res')); });
    let ptRes = [];
    const showPt = () => {
      const box = document.getElementById('c-pt-sel'); if (!box) return;
      view(st.patient ? html`${MC.wristband(st.patient)}<div class="btn-row" style="margin:-8px 0 12px"><button type="button" class="btn sm" data-action="call-pt-clear">${T('dispatch.new.unlink', 'Remove patient')}</button>${st.patient.homeLoc ? html`<button type="button" class="btn sm" data-action="call-pt-home">${icon('pin')}${T('dispatch.new.use_home', 'Use home address')}</button>` : ''}</div>` : '', box);
    };
    const runPt = async q => {
      ptRes = await searchPatients(q);
      view(ptRes.length ? html`<ul class="list">${ptRes.map((p, i) => html`<li><div class="grow"><span class="title">${p.name}</span><span class="sub">${ptLine(p)}</span></div><button type="button" class="btn sm" data-action="call-pt-pick" data-i="${i}">${T('dispatch.new.link', 'Link')}</button></li>`)}</ul>` : html`<p class="muted sm">${T('dispatch.new.pt_none', 'No registered patient found. You can still create the incident without one.')}</p>`, document.getElementById('c-pt-res'));
    };
    on('call-pt-search', () => runPt(document.getElementById('c-pq').value));
    on('call-pt-phone', () => { const p = document.getElementById('c-p').value; if (!p) { toast(T('dispatch.new.need_phone', 'Enter the caller phone first'), 'bad'); return; } document.getElementById('c-pq').value = p; return runPt(p); });
    on('call-pt-pick', el => { st.patient = ptRes[Number(el.dataset.i)]; showPt(); view('', document.getElementById('c-pt-res')); const n = document.getElementById('c-n'); if (n && !n.value) n.value = st.patient.name; const ph = document.getElementById('c-p'); if (ph && !ph.value && st.patient.phone) ph.value = st.patient.phone; });
    on('call-pt-clear', () => { st.patient = null; showPt(); });
    on('call-pt-home', () => { const p = st.patient; if (p && p.homeLoc) { setLoc(p.homeLoc.lat, p.homeLoc.lng, p.address, { center: true }); const a = document.getElementById('c-addr'); if (a && p.address) a.value = p.address; } });
    form('call-new', async d => {
      if (!d.category) throw new MC.ApiError(400, { error: T('dispatch.new.need_cat', 'Choose a category'), details: [{ field: 'category', error: T('dispatch.new.need_cat', 'Choose a category') }] });
      if (!st.loc) throw new MC.ApiError(400, { error: T('dispatch.new.need_loc', 'Set the location: search an address, tap the map or enter coordinates.') });
      const body = { source: 'call', category: d.category, location: { lat: st.loc.lat, lng: st.loc.lng } };
      if (d.address) body.location.address = d.address; if (d.landmark) body.location.landmark = d.landmark;
      if (d.callerName || d.callerPhone) { body.caller = {}; if (d.callerName) body.caller.name = d.callerName; if (d.callerPhone) body.caller.phone = d.callerPhone; }
      if (d.priority) body.priority = d.priority;
      if (d.note) body.note = d.note;
      if (st.patient) body.patientId = st.patient.id;
      let inc;
      try { inc = await api.post('/api/dispatch/incidents', body); }
      catch (e) { if (e.code === 'active_emergency') throw new MC.ApiError(409, { error: T('dispatch.new.active', 'This patient already has an open emergency. Open it from the board instead of creating a second one.') }); throw e; }
      toast(T('dispatch.new.created', 'Incident {n} created', { n: inc.number }), 'ok');
      MC.go('#/incident/' + inc.id);
    });
  }

  /* ---------------- incident ---------------- */
  function careLine(c) {
    const v = c.vitals || {}; const parts = [];
    if (v.bpSys) parts.push('BP ' + v.bpSys + '/' + (v.bpDia || '?')); if (v.pulse != null) parts.push(T('dispatch.care.pulse', 'Pulse') + ' ' + v.pulse); if (v.rr != null) parts.push('RR ' + v.rr); if (v.spo2 != null) parts.push('SpO2 ' + v.spo2 + '%');
    if (v.tempC != null) parts.push(v.tempC + ' C'); if (v.gcs != null) parts.push('GCS ' + v.gcs); if (v.glucose != null) parts.push(T('dispatch.care.glucose', 'Glucose') + ' ' + v.glucose); if (v.painScore != null) parts.push(T('dispatch.care.pain', 'Pain') + ' ' + v.painScore + '/10');
    return parts.join(', ');
  }
  function incidentMain(inc, suggest) {
    const pi = inc.patientInfo;
    const wb = pi ? MC.wristband({ name: pi.firstName + (pi.lastName ? ' ' + pi.lastName : ''), age: pi.age, sex: pi.sex, bloodGroup: pi.bloodGroup, allergies: pi.allergies || [], noKnownAllergies: pi.noKnownAllergies }) : '';
    const open = isOpen(inc.status);
    const canAssign = (inc.allowedNext || []).includes('assigned');
    return html`
      <div class="page-head"><div><h1>${pri(inc.triage.priority)} ${catLabel(inc.triage.category)} <span class="muted">${inc.number}</span></h1>
        <p>${incBadge(inc.status)} ${sourceLabel(inc.source)} | ${T('dispatch.inc.received', 'Received {time}, {age} ago', { time: MC.time(inc.createdAt), age: fmtAge(ageMin(inc.createdAt)) })}</p></div>
        <div class="actions">${open && !inc.verified ? html`<button class="btn primary" data-action="inc-verify">${icon('check')}${T('dispatch.inc.verify', 'Mark verified')}</button>` : ''}
          ${open ? html`<button class="btn" data-action="inc-triage">${T('dispatch.inc.triage', 'Change category or priority')}</button>` : ''}
          ${(inc.allowedNext || []).includes('closed') ? html`<button class="btn" data-action="inc-close">${T('dispatch.inc.close', 'Close incident')}</button>` : ''}
          ${inc.patientId && refOK() && MC.referrals.canSend() ? html`<button class="btn" data-action="disp-refer" data-p="${inc.patientId}">${icon('swap')}${T('dispatch.inc.refer', 'Refer patient')}</button>` : ''}
          ${(inc.allowedNext || []).includes('cancelled') ? html`<button class="btn danger" data-action="inc-cancel">${T('dispatch.inc.cancel', 'Cancel incident')}</button>` : ''}</div></div>
      ${!inc.verified && open ? html`<div class="notice warn" role="alert"><b>${T('dispatch.inc.unverified', 'Unverified public report.')}</b> ${inc.caller && inc.caller.phone ? T('dispatch.inc.unverified_call', 'Call {phone} back to confirm the emergency, then mark it verified. You can assign a unit before that if the report looks genuine.', { phone: inc.caller.phone }) : T('dispatch.inc.unverified_nophone', 'Confirm the emergency, then mark it verified.')}</div>` : ''}
      ${inc.noUnitAvailable && inc.status === 'new' ? html`<div class="notice bad">${T('dispatch.inc.no_unit', 'No unit was available when this came in. Assign the nearest unit as soon as one is free, or call a partner service.')}</div>` : ''}
      ${inc.status === 'cancelled' ? html`<div class="notice">${T('dispatch.inc.cancelled', 'Cancelled: {reason}', { reason: inc.cancelReason || '' })}</div>` : ''}
      ${wb}
      ${inc.status !== 'cancelled' ? MC.steps(INC_STEPS, inc.status, stepLabels()) : ''}
      <div class="d-inc"><div>
        <section class="panel"><h2>${T('dispatch.inc.details', 'Call details')}</h2><dl class="kv">
          <dt>${T('dispatch.inc.caller', 'Caller')}</dt><dd>${inc.caller && inc.caller.name ? inc.caller.name : T('dispatch.inc.no_name', 'No name given')}${inc.caller && inc.caller.phone ? html` | <a href="${telHref(inc.caller.phone)}">${icon('phone')} ${inc.caller.phone}</a>` : ''}</dd>
          <dt>${T('dispatch.inc.address', 'Address')}</dt><dd>${inc.location.address || T('dispatch.inc.none', 'Not given')}</dd>
          <dt>${T('dispatch.inc.landmark', 'Landmark')}</dt><dd>${inc.location.landmark || T('dispatch.inc.none', 'Not given')}</dd>
          <dt>${T('dispatch.inc.coords', 'Position')}</dt><dd>${inc.location.lat.toFixed(5)}, ${inc.location.lng.toFixed(5)}</dd>
          <dt>${T('dispatch.inc.priority', 'Priority')}</dt><dd>${inc.triage.priority}${inc.triage.overridden ? ' ' + T('dispatch.inc.overridden', '(changed from {p})', { p: inc.triage.derivedPriority }) : ''}</dd>
          <dt>${T('dispatch.inc.patient', 'Patient')}</dt><dd>${pi ? T('dispatch.inc.linked', 'Linked registered patient') : html`${T('dispatch.inc.no_patient', 'Not linked')} ${open ? html`<button class="btn sm" data-action="inc-link">${T('dispatch.inc.link', 'Link a registered patient')}</button>` : ''}`}</dd>
          ${inc.billStatus ? html`<dt>${T('dispatch.inc.bill', 'Bill')}</dt><dd>${T('dispatch.bill.' + inc.billStatus, { open: 'Bill raised, not paid yet', paid: 'Paid', no_patient: 'No bill: no patient linked', no_price_list: 'No bill: ambulance prices are not set' }[inc.billStatus] || MC.cap(inc.billStatus))}${inc.transportKm != null ? ' | ' + T('dispatch.inc.km', '{km} km transported', { km: inc.transportKm }) : ''}</dd>` : ''}
        </dl></section>
        <section class="panel"><h2>${T('dispatch.inc.unit', 'Unit')}</h2>
          ${inc.unitName ? html`<p><b>${inc.unitName}</b> ${incBadge(inc.status)}</p>` : html`<p class="muted">${T('dispatch.inc.no_unit_yet', 'No unit assigned yet.')}</p>`}
          ${canAssign ? html`<h3>${inc.unitId ? T('dispatch.inc.reassign_h', 'Reassign to another unit') : T('dispatch.inc.nearest', 'Nearest units')}</h3>
            ${suggest ? (suggest.length ? html`<ul class="list d-unitrow">${suggest.filter(u => u.id !== inc.unitId).slice(0, 6).map(u => html`<li><div class="grow"><span class="title">${u.name} <span class="muted sm">${u.type}</span></span>
              <span class="sub">${u.distanceKm != null ? T('dispatch.inc.dist', '{km} km, about {eta} min', { km: u.distanceKm, eta: u.etaMinutes }) : T('dispatch.inc.dist_unknown', 'Distance unknown')} | ${unitLocLine(u)}</span>
              ${u.dispatchable ? '' : html`<span class="d-flags">${avBadge(u.availability)}${(u.notReadyReasons || []).map(r => badge(reasonLabel(r), 'warn'))}</span>`}</div>
              <span class="end">${u.dispatchable ? html`<button class="btn sm primary" data-action="inc-assign" data-id="${u.id}" data-name="${u.name}">${inc.unitId ? T('dispatch.inc.reassign', 'Reassign') : T('dispatch.inc.assign', 'Assign')}</button>` : html`<span class="xs muted">${T('dispatch.inc.not_ready', 'Not ready')}</span>`}</span></li>`)}</ul>` : empty({ icon: 'ambulance', title: T('dispatch.inc.no_units', 'No units in service') })) : MC.skeleton(2)}
            <div class="btn-row"><button class="btn sm" data-action="inc-suggest">${icon('refresh')}${T('dispatch.inc.refresh_units', 'Refresh units')}</button></div>` : ''}
        </section>
        <section class="panel"><h2>${T('dispatch.inc.destination', 'Destination hospital')}</h2>
          ${inc.destination ? html`<p><b>${inc.destination.name}</b>${inc.destination.orgId ? html` ${badge(T('dispatch.inc.prealerted', 'On MediCore: pre-alerted'), 'ok')}` : html` ${badge(T('dispatch.inc.free_text', 'Not on MediCore: phone ahead'), 'warn')}`}</p>` : html`<p class="muted">${T('dispatch.inc.no_dest', 'Not set. The crew needs a destination before transporting.')}</p>`}
          ${open && inc.status !== 'athospital' ? html`<button class="btn" data-action="inc-dest">${icon('building')}${inc.destination ? T('dispatch.inc.change_dest', 'Change destination') : T('dispatch.inc.set_dest', 'Set destination')}</button>` : ''}
        </section>
        ${(inc.care || []).length ? html`<section class="panel"><h2>${T('dispatch.inc.care', 'Crew care notes')}</h2><ol class="timeline">${inc.care.map(c => html`<li><time>${MC.dateTime(c.at)} | ${c.byName}</time>${careLine(c)}${(c.interventions || []).length ? html`<br>${T('dispatch.care.interventions', 'Interventions')}: ${c.interventions.join(', ')}` : ''}${(c.medications || []).length ? html`<br>${T('dispatch.care.meds', 'Medications')}: ${c.medications.map(x => [x.name, x.dose, x.route].filter(Boolean).join(' ')).join(', ')}` : ''}${c.handoverNote ? html`<br><b>${T('dispatch.care.handover', 'Handover')}:</b> ${c.handoverNote}` : ''}${c.note ? html`<br>${c.note}` : ''}</li>`)}</ol></section>` : ''}
      </div><div>
        <section class="panel"><h2>${T('dispatch.inc.notes', 'Notes')}</h2>
          ${(inc.notes || []).length ? html`<ol class="timeline">${inc.notes.map(n => html`<li><time>${MC.dateTime(n.at)} | ${n.byName || ''} ${n.kind === 'caller' ? '(' + T('dispatch.inc.from_caller', 'from caller') + ')' : ''}</time>${n.text}</li>`)}</ol>` : html`<p class="muted sm">${T('dispatch.inc.no_notes', 'No notes yet.')}</p>`}
        </section>
        <section class="panel"><h2>${T('dispatch.inc.timeline', 'Timeline')}</h2><ol class="timeline">${(inc.timeline || []).map(x => html`<li><time>${MC.dateTime(x.at)}${x.byName ? ' | ' + x.byName : ''}</time>${incLabel(x.status)}${x.note ? html`: ${x.note}` : ''}</li>`)}</ol></section>
      </div></div>`;
  }
  const refOK = () => MC.feature('referralNetwork') && ((MC.me && MC.me.perms) || []).some(x => x === 'referral.send' || x === 'referral.receive');
  on('disp-refer', async el => { const pid = el.dataset.p; const patient = await api.get('/api/fd/patients/' + encodeURIComponent(pid)).catch(e => { if (e.status === 401) throw e; return { id: pid }; }); await MC.referrals.sendDialog({ patient }); });
  async function incidentPage({ params, stale }) {
    let inc = await api.get('/api/dispatch/incidents/' + params.id);
    if (stale()) return;
    let suggest = null;
    view(html`<a class="back" href="#/board">${icon('left')}${T('dispatch.nav.board', 'Board')}</a><div id="i-main"></div>
      <div class="d-inc"><section class="panel" style="margin:0"><h2>${T('dispatch.inc.map', 'Map')}</h2><div class="map" id="i-map" role="region" aria-label="${T('dispatch.inc.map', 'Map')}"></div><p class="xs muted" id="i-map-note" role="status"></p>${legend()}</section>
      ${isOpen(inc.status) ? html`<form class="panel" data-form="inc-note" novalidate style="margin:0"><div class="field"><label for="i-note">${T('dispatch.inc.add_note', 'Add a note')}</label><textarea class="input" id="i-note" name="text" required maxlength="1000"></textarea></div><button class="btn" type="submit">${T('dispatch.inc.save_note', 'Save note')}</button></form>` : '<div></div>'}</div>`);
    const paint = () => { const el = document.getElementById('i-main'); if (el) view(incidentMain(inc, suggest), el); };
    const loadSuggest = async () => { if (!(inc.allowedNext || []).includes('assigned')) { suggest = null; return; } suggest = await api.get('/api/dispatch/incidents/' + inc.id + '/suggest'); };
    paint();
    try { await loadSuggest(); } catch (e) { suggest = []; }
    if (stale()) return; paint();
    const m = await safeMap(document.getElementById('i-map'), { center: inc.location, zoom: 14 }, document.getElementById('i-map-note'));
    if (stale()) return;
    const ls = layerSet(m); let fitted = false;
    const paintMap = () => {
      if (!m) return; const keep = ['inc'];
      ls.set('inc', inc.location, { pin: inc.triage.priority, cls: inc.triage.priority, label: inc.number });
      if (inc.destination && inc.destination.lat != null) { keep.push('dest'); ls.set('dest', inc.destination, { pin: 'H', cls: 'dest', label: inc.destination.name }); }
      (suggest || []).forEach(u => { if (!u.lastLoc) return; keep.push('u' + u.id); ls.set('u' + u.id, u.lastLoc, { color: AV_COLOR(u.availability), stale: !u.lastLocFresh, label: unitMapLabel(u) }); });
      if (inc.track && inc.track.length > 1) m.line('track', inc.track);
      const last = inc.track && inc.track.length ? inc.track[inc.track.length - 1] : null;
      if (last && inc.unitId && !(suggest || []).some(u => u.id === inc.unitId)) { keep.push('cur'); ls.set('cur', last, { color: '#B42D27', stale: Date.now() - last.at > 120000, label: (inc.unitName || '') + ' ' + MC.ago(last.at) }); }
      ls.prune(keep); if (!fitted) { ls.fit(); fitted = true; }
    };
    paintMap();
    const refresh = async () => { inc = await api.get('/api/dispatch/incidents/' + inc.id); if (stale()) return; paint(); paintMap(); };
    let tick = 0;
    if (isOpen(inc.status)) MC.poll(async () => { tick++; const before = inc.status; inc = await api.get('/api/dispatch/incidents/' + inc.id); if (tick % 3 === 0 || before !== inc.status) { try { await loadSuggest(); } catch (e) { /* keep last list */ } } if (stale()) return; paint(); paintMap(); }, 5000);

    on('inc-suggest', async () => { await loadSuggest(); paint(); paintMap(); });
    on('inc-assign', async el => {
      const unitId = el.dataset.id; const name = el.dataset.name;
      let body = { unitId }; let path = '/assign';
      if (inc.unitId) {
        const r = await dialog({ title: T('dispatch.inc.reassign_q', 'Reassign to {unit}?', { unit: name }), form: true, body: html`<p>${T('dispatch.inc.reassign_body', '{old} will be freed and told to stand down.', { old: inc.unitName || '' })}</p><div class="field"><label for="ra-r">${T('dispatch.inc.reason', 'Reason')}</label><input class="input" id="ra-r" name="reason" required minlength="3" maxlength="300" placeholder="${T('dispatch.inc.reassign_ph', 'e.g. Closer unit became free')}"></div>`, actions: [{ label: T('dispatch.cancel', 'Cancel'), value: null }, { label: T('dispatch.inc.reassign', 'Reassign'), primary: true }] });
        if (!r) return; body.reason = r.reason; path = '/reassign';
      }
      try { inc = await api.post('/api/dispatch/incidents/' + inc.id + path, body); }
      catch (e) {
        if (e.code === 'unit_taken') { toast(T('dispatch.inc.unit_taken', '{unit} was just taken by another dispatcher. Choose another unit.', { unit: name }), 'bad'); await loadSuggest(); await refresh(); return; }
        if (e.code === 'wrong_state') { toast(T('dispatch.inc.changed', 'This incident changed while you were looking at it. The page is now up to date.'), 'bad'); await refresh(); return; }
        throw e;
      }
      toast(T('dispatch.inc.assigned', '{unit} assigned', { unit: name }), 'ok');
      await loadSuggest(); paint(); paintMap();
    });
    on('inc-verify', async () => {
      if (!(await confirm({ title: T('dispatch.inc.verify_q', 'Mark this report verified?'), body: inc.caller && inc.caller.phone ? T('dispatch.inc.verify_body', 'Only do this after you called {phone} back and confirmed the emergency.', { phone: inc.caller.phone }) : T('dispatch.inc.verify_body2', 'Only do this after you confirmed the emergency.'), ok: T('dispatch.inc.verify', 'Mark verified') }))) return;
      try { inc = await api.post('/api/dispatch/incidents/' + inc.id + '/verify'); } catch (e) { if (e.status === 409) { await refresh(); return; } throw e; }
      toast(T('dispatch.inc.verified', 'Report marked verified'), 'ok'); paint();
    });
    on('inc-cancel', async () => {
      const r = await dialog({ title: T('dispatch.inc.cancel_q', 'Cancel {n}?', { n: inc.number }), form: true, body: html`<p>${inc.unitId ? T('dispatch.inc.cancel_body_unit', 'The crew of {unit} is told to stand down and the unit becomes free. This cannot be undone.', { unit: inc.unitName }) : T('dispatch.inc.cancel_body', 'The incident is closed without a response. This cannot be undone.')}</p><div class="field"><label for="cx-r">${T('dispatch.inc.reason', 'Reason')}</label><textarea class="input" id="cx-r" name="reason" required minlength="3" maxlength="300"></textarea></div>`, actions: [{ label: T('dispatch.inc.keep', 'Keep incident'), value: null }, { label: T('dispatch.inc.cancel', 'Cancel incident'), primary: true }],
        onSubmit: async d => { if (!d.reason || d.reason.length < 3) throw new MC.ApiError(400, { error: T('dispatch.inc.need_reason', 'Give a reason (at least 3 characters)') }); return api.post('/api/dispatch/incidents/' + inc.id + '/cancel', { reason: d.reason }); } });
      if (!r) return; inc = r; toast(T('dispatch.inc.cancelled_t', 'Incident cancelled'), 'ok'); paint();
    });
    on('inc-close', async () => {
      const r = await dialog({ title: T('dispatch.inc.close_q', 'Close {n}?', { n: inc.number }), form: true, body: html`<p>${inc.patientId ? T('dispatch.inc.close_body', 'The case is closed, the unit becomes free and the patient is billed once for the call-out and distance.') : T('dispatch.inc.close_body_np', 'The case is closed and the unit becomes free. No bill is raised because no patient is linked.')}</p><div class="field"><label for="cl-n">${T('dispatch.inc.close_note', 'Closing note (optional)')}</label><input class="input" id="cl-n" name="note" maxlength="300"></div>`, actions: [{ label: T('dispatch.cancel', 'Cancel'), value: null }, { label: T('dispatch.inc.close', 'Close incident'), primary: true }],
        onSubmit: d => api.post('/api/dispatch/incidents/' + inc.id + '/close', d.note ? { note: d.note } : {}) });
      if (!r) return; inc = r; toast(T('dispatch.inc.closed', 'Incident closed'), 'ok'); paint();
    });
    on('inc-triage', async () => {
      const r = await dialog({ title: T('dispatch.inc.triage', 'Change category or priority'), form: true, body: html`<div class="field"><label for="tr-c">${T('dispatch.new.category', 'Category')}</label><select class="input" id="tr-c" name="category">${CAT_KEYS.map(k => html`<option value="${k}" ${k === inc.triage.category ? 'selected' : ''}>${catLabel(k)} (${catPri(k)})</option>`)}</select></div>
        <div class="field"><label for="tr-p">${T('dispatch.new.priority', 'Priority')}</label><select class="input" id="tr-p" name="priority"><option value="">${T('dispatch.new.pri_auto', 'Automatic from category')}</option>${['P1', 'P2', 'P3'].map(p => html`<option value="${p}" ${inc.triage.overridden && inc.triage.priority === p ? 'selected' : ''}>${p}</option>`)}</select><div class="hint">${T('dispatch.new.pri_hint', 'Leave on automatic unless you have a clinical reason. A change is recorded.')}</div></div>`,
        actions: [{ label: T('dispatch.cancel', 'Cancel'), value: null }, { label: T('dispatch.inc.save', 'Save'), primary: true }],
        onSubmit: d => api.patch('/api/dispatch/incidents/' + inc.id + '/triage', { category: d.category, priority: d.priority || catPri(d.category) }) });
      if (!r) return; inc = Object.assign(inc, r); toast(T('dispatch.inc.triage_saved', 'Triage updated'), 'ok'); paint(); paintMap();
    });
    on('inc-dest', async () => {
      const list = await api.get('/api/dispatch/destinations' + qs({ lat: inc.location.lat, lng: inc.location.lng }));
      const r = await dialog({ title: T('dispatch.inc.set_dest', 'Set destination'), form: true, wide: true, body: html`
        ${list.length ? html`<p class="muted sm">${T('dispatch.inc.dest_sub', 'MediCore hospitals and clinics, nearest first. They get a pre-alert straight away.')}</p><div class="d-opts" role="radiogroup">${list.map(o => html`<label class="d-opt"><input type="radio" name="orgId" value="${o.orgId}" ${inc.destination && inc.destination.orgId === o.orgId ? 'checked' : ''}><span><b>${o.name}</b><br><span class="sm muted">${[MC.cap(o.type), o.area, o.distanceKm != null ? T('dispatch.inc.km_away', '{km} km away', { km: o.distanceKm }) : ''].filter(Boolean).join(' | ')}</span></span></label>`)}</div>` : ''}
        <div class="field"><label for="ds-n">${T('dispatch.inc.dest_other', 'Or another hospital (not on MediCore)')}</label><input class="input" id="ds-n" name="name" maxlength="120" placeholder="${T('dispatch.inc.dest_ph', 'Hospital name')}"><div class="hint">${T('dispatch.inc.dest_hint', 'Free text is not pre-alerted. Phone the hospital.')}</div></div>`,
        actions: [{ label: T('dispatch.cancel', 'Cancel'), value: null }, { label: T('dispatch.inc.save_dest', 'Save destination'), primary: true }],
        onSubmit: d => { if (d.name) return api.post('/api/dispatch/incidents/' + inc.id + '/destination', { name: d.name }); if (d.orgId) return api.post('/api/dispatch/incidents/' + inc.id + '/destination', { orgId: d.orgId }); throw new MC.ApiError(400, { error: T('dispatch.inc.dest_need', 'Choose a hospital or type a name') }); } });
      if (!r) return; inc = Object.assign(inc, r); toast(T('dispatch.inc.dest_saved', 'Destination set to {name}', { name: r.destination ? r.destination.name : '' }), 'ok'); paint(); paintMap();
    });
    let linkRes = [];
    on('inc-pt-search', async () => {
      const q = document.getElementById('lp-q'); linkRes = await searchPatients(q ? q.value : '');
      view(linkRes.length ? html`<div class="d-opts">${linkRes.map(p => html`<label class="d-opt"><input type="radio" name="patientId" value="${p.id}"><span><b>${p.name}</b><br><span class="sm muted">${ptLine(p)}</span></span></label>`)}</div>` : html`<p class="muted sm">${T('dispatch.inc.pt_none', 'No registered patient found. The front desk can register them, then link here.')}</p>`, document.getElementById('lp-res'));
    });
    on('inc-link', async () => {
      const q0 = inc.caller && inc.caller.phone ? inc.caller.phone : '';
      const r = await dialog({ title: T('dispatch.inc.link', 'Link a registered patient'), form: true, body: html`<p class="muted sm">${T('dispatch.inc.link_sub', 'Search patients registered with your provider by name, phone or MRN.')}</p>
        <div class="row"><div style="flex:1"><label for="lp-q" class="sr-only">${T('dispatch.new.patient_q', 'Name, phone or MRN')}</label><input class="input" id="lp-q" value="${q0}" data-enter="lp-go" autocomplete="off"></div><button type="button" class="btn" id="lp-go" data-action="inc-pt-search">${T('dispatch.new.find', 'Find patient')}</button></div><div id="lp-res" style="margin-top:12px"></div>`,
        actions: [{ label: T('dispatch.cancel', 'Cancel'), value: null }, { label: T('dispatch.inc.link_btn', 'Link patient'), primary: true }],
        onSubmit: d => { if (!d.patientId) throw new MC.ApiError(400, { error: T('dispatch.inc.pick_pt', 'Search, then choose a patient') }); return api.post('/api/dispatch/incidents/' + inc.id + '/patient', { patientId: d.patientId }); } });
      if (!r) return; inc = Object.assign(inc, r); toast(T('dispatch.inc.linked_t', 'Patient linked'), 'ok'); paint();
    });
    form('inc-note', async (d, f) => { if (!d.text) throw new MC.ApiError(400, { error: T('dispatch.inc.note_empty', 'Write the note first') }); inc = Object.assign(inc, await api.post('/api/dispatch/incidents/' + inc.id + '/notes', { text: d.text })); f.reset(); toast(T('dispatch.inc.note_saved', 'Note saved'), 'ok'); paint(); });
  }

  /* ---------------- incident history ---------------- */
  async function history({ query }) {
    const rows = await api.get('/api/dispatch/incidents' + qs({ status: query.status, limit: 200 }));
    const tabs = ['', 'closed', 'cancelled'];
    view(html`<div class="page-head"><div><h1>${T('dispatch.hist.title', 'All incidents')}</h1><p>${T('dispatch.hist.sub', 'Newest first, last 200')}</p></div></div>
      <div class="tabs" role="tablist">${tabs.map(s => html`<a href="#/incidents${s ? '?status=' + s : ''}" role="tab" aria-selected="${(query.status || '') === s ? 'true' : 'false'}">${s ? incLabel(s) : T('dispatch.hist.all', 'All')}</a>`)}</div>
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('dispatch.hist.number', 'Number')}</th><th>${T('dispatch.hist.when', 'Received')}</th><th>${T('dispatch.priority', 'Priority')}</th><th>${T('dispatch.new.category', 'Category')}</th><th>${T('dispatch.hist.where', 'Where')}</th><th>${T('dispatch.inc.unit', 'Unit')}</th><th>${T('dispatch.hist.status', 'Status')}</th></tr></thead><tbody>
        ${rows.map(i => html`<tr class="click"><td data-label="${T('dispatch.hist.number', 'Number')}"><a href="#/incident/${i.id}"><b>${i.number}</b></a></td><td data-label="${T('dispatch.hist.when', 'Received')}">${MC.dateTime(i.createdAt)}</td><td data-label="${T('dispatch.priority', 'Priority')}">${pri(i.triage.priority)}</td><td data-label="${T('dispatch.new.category', 'Category')}">${catLabel(i.triage.category)}</td><td data-label="${T('dispatch.hist.where', 'Where')}">${locText(i.location)}</td><td data-label="${T('dispatch.inc.unit', 'Unit')}">${i.unitName || ''}</td><td data-label="${T('dispatch.hist.status', 'Status')}">${incBadge(i.status)}</td></tr>`)}</tbody></table></div>` : empty({ icon: 'clipboard', title: T('dispatch.hist.empty', 'No incidents') })}`);
  }

  /* ---------------- fleet ---------------- */
  const DOC_EN = { registration: 'Registration', insurance: 'Insurance', inspection: 'Inspection' };
  function compFlags(c) {
    const out = [];
    Object.keys(DOC_EN).forEach(k => {
      const x = c && c[k]; const n = T('dispatch.fleet.doc.' + k, DOC_EN[k]);
      if (!x || x.missing) out.push(badge(T('dispatch.fleet.doc_missing', '{doc}: no expiry date', { doc: n }), 'outline'));
      else if (x.expired) out.push(badge(T('dispatch.fleet.doc_expired', '{doc} expired {date}', { doc: n, date: MC.date(Date.parse(x.expiry)) }), 'bad'));
      else if (x.expiringSoon) out.push(badge(T('dispatch.fleet.doc_soon', '{doc} expires in {n} days', { doc: n, n: x.daysLeft }), 'warn'));
    });
    return out.length ? out : [badge(T('dispatch.fleet.docs_ok', 'Papers valid'), 'ok')];
  }
  function crewLicence(p) {
    if (!p) return badge(T('dispatch.crew.no_licence', 'No licence details'), 'warn');
    if (!p.licenceValid) return badge(T('dispatch.crew.expired', 'Licence expired {date}', { date: MC.date(Date.parse(p.licenceExpiry)) }), 'bad');
    if (p.licenceExpiringSoon) return badge(T('dispatch.crew.soon', 'Licence expires {date}', { date: MC.date(Date.parse(p.licenceExpiry)) }), 'warn');
    return html`<span class="sm">${T('dispatch.crew.valid_to', 'Valid to {date}', { date: MC.date(Date.parse(p.licenceExpiry)) })}</span>`;
  }
  async function fleet({ query }) {
    const tab = query.tab === 'crew' ? 'crew' : 'units';
    const [units, crew] = await Promise.all([api.get('/api/ambulance/units'), api.get('/api/ambulance/crew')]);
    const expired = units.filter(u => Object.values(u.compliance || {}).some(x => x && x.expired)).length;
    const soon = units.filter(u => Object.values(u.compliance || {}).some(x => x && x.expiringSoon)).length;
    const unverified = crew.filter(c => !c.profile || !c.profile.verified).length;
    view(html`<div class="page-head"><div><h1>${T('dispatch.fleet.title', 'Fleet and crew')}</h1><p>${T('dispatch.fleet.sub', 'Units, papers, crew licences and who rides on which unit')}</p></div>
      <div class="actions">${tab === 'units' ? html`<button class="btn primary" data-action="unit-add">${icon('plus')}${T('dispatch.fleet.add', 'Add unit')}</button>` : ''}</div></div>
      ${figures([{ value: units.length, label: T('dispatch.fleet.f_units', 'Units') }, { value: units.filter(u => u.dispatchable).length, label: T('dispatch.fleet.f_ready', 'Ready to dispatch') }, { value: expired, label: T('dispatch.fleet.f_expired', 'Units with expired papers'), tone: expired ? 'bad' : '' }, { value: soon, label: T('dispatch.fleet.f_soon', 'Papers expiring in 90 days'), tone: soon ? 'warn' : '' }, { value: unverified, label: T('dispatch.fleet.f_unverified', 'Crew not verified'), tone: unverified ? 'warn' : '' }])}
      <div class="tabs" role="tablist"><a href="#/fleet" role="tab" aria-selected="${tab === 'units' ? 'true' : 'false'}">${T('dispatch.fleet.units', 'Units')}</a><a href="#/fleet?tab=crew" role="tab" aria-selected="${tab === 'crew' ? 'true' : 'false'}">${T('dispatch.fleet.crew', 'Crew')}</a></div>
      ${tab === 'units' ? (units.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('dispatch.fleet.unit', 'Unit')}</th><th>${T('dispatch.fleet.status', 'Status')}</th><th>${T('dispatch.fleet.avail', 'Availability')}</th><th>${T('dispatch.fleet.crew', 'Crew')}</th><th>${T('dispatch.fleet.papers', 'Papers')}</th><th>${T('dispatch.fleet.ready', 'Ready')}</th><th></th></tr></thead><tbody>
        ${units.map(u => html`<tr><td data-label="${T('dispatch.fleet.unit', 'Unit')}"><b>${u.name}</b><br><span class="xs muted">${typeLabel(u.type)} | ${u.plate}</span></td>
          <td data-label="${T('dispatch.fleet.status', 'Status')}">${badge(unitStatusLabel(u.status), u.status === 'in_service' ? 'ok' : 'warn')}</td>
          <td data-label="${T('dispatch.fleet.avail', 'Availability')}">${avBadge(u.availability)}<br><span class="xs muted">${unitLocLine(u)}</span></td>
          <td data-label="${T('dispatch.fleet.crew', 'Crew')}">${u.crew.length ? u.crew.map(c => html`<div>${c.name} <span class="xs muted">${c.certification || ''}${c.onShift ? ' | ' + T('dispatch.crew.on_shift', 'on shift') : ''}</span>${c.verified ? '' : html` ${badge(T('dispatch.crew.unverified', 'Not verified'), 'warn')}`}</div>`) : html`<span class="muted">${T('dispatch.fleet.no_crew', 'No crew')}</span>`}</td>
          <td data-label="${T('dispatch.fleet.papers', 'Papers')}"><div class="d-flags">${compFlags(u.compliance)}</div></td>
          <td data-label="${T('dispatch.fleet.ready', 'Ready')}">${u.dispatchable ? badge(T('dispatch.fleet.yes', 'Ready'), 'ok') : html`<div class="d-flags">${(u.notReadyReasons || []).length ? u.notReadyReasons.map(r => badge(reasonLabel(r), 'warn')) : avBadge(u.availability)}</div>`}</td>
          <td class="num"><button class="btn sm" data-action="unit-edit" data-id="${u.id}">${T('dispatch.fleet.edit', 'Edit')}</button></td></tr>`)}</tbody></table></div>` : empty({ icon: 'ambulance', title: T('dispatch.fleet.empty', 'No units yet'), body: T('dispatch.fleet.empty_sub', 'Add each ambulance with its plate and paper expiry dates.'), action: html`<button class="btn primary" data-action="unit-add">${T('dispatch.fleet.add', 'Add unit')}</button>` }))
      : (crew.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('dispatch.crew.name', 'Name')}</th><th>${T('dispatch.crew.cert', 'Certification')}</th><th>${T('dispatch.crew.licence', 'Licence')}</th><th>${T('dispatch.crew.verified', 'Verified')}</th><th>${T('dispatch.fleet.unit', 'Unit')}</th><th></th></tr></thead><tbody>
        ${crew.map(c => html`<tr><td data-label="${T('dispatch.crew.name', 'Name')}"><b>${c.name}</b>${c.phone ? html`<br><a class="xs" href="${telHref(c.phone)}">${c.phone}</a>` : ''}<br><span class="xs muted">${c.onShift ? T('dispatch.crew.on_shift_now', 'On shift now') : T('dispatch.crew.off_shift', 'Not clocked in')}</span></td>
          <td data-label="${T('dispatch.crew.cert', 'Certification')}">${c.profile ? c.profile.certification : ''}</td>
          <td data-label="${T('dispatch.crew.licence', 'Licence')}">${c.profile ? html`${c.profile.licenceNo}<br>` : ''}${crewLicence(c.profile)}</td>
          <td data-label="${T('dispatch.crew.verified', 'Verified')}">${c.profile && c.profile.verified ? badge(T('dispatch.crew.is_verified', 'Verified'), 'ok') : badge(T('dispatch.crew.unverified', 'Not verified'), 'warn')}</td>
          <td data-label="${T('dispatch.fleet.unit', 'Unit')}">${c.unit ? c.unit.name : html`<span class="muted">${T('dispatch.crew.no_unit', 'Not on a unit')}</span>`}</td>
          <td class="num"><div class="row wrap" style="justify-content:flex-end;gap:6px"><button class="btn sm" data-action="crew-licence" data-id="${c.membershipId}">${c.profile ? T('dispatch.crew.edit_licence', 'Edit licence') : T('dispatch.crew.add_licence', 'Add licence')}</button>
            ${c.profile ? html`<button class="btn sm ${c.profile.verified ? '' : 'primary'}" data-action="crew-verify" data-id="${c.membershipId}">${c.profile.verified ? T('dispatch.crew.unverify', 'Remove verification') : T('dispatch.crew.verify', 'Verify licence')}</button>` : ''}
            <button class="btn sm" data-action="crew-unit" data-id="${c.membershipId}">${T('dispatch.crew.assign', 'Assign to unit')}</button></div></td></tr>`)}</tbody></table></div>` : empty({ icon: 'users', title: T('dispatch.crew.empty', 'No crew yet'), body: T('dispatch.crew.empty_sub', 'Your administrator adds crew members as staff with the Ambulance crew role.') }))}`);

    const unitFields = u => html`<div class="field"><label for="u-n">${T('dispatch.fleet.name', 'Name')}</label><input class="input" id="u-n" name="name" required maxlength="60" value="${u ? u.name : ''}" placeholder="${T('dispatch.fleet.name_ph', 'e.g. Unit 3 (BLS)')}"></div>
      <div class="fields two"><div class="field"><label for="u-t">${T('dispatch.fleet.type', 'Type')}</label><select class="input" id="u-t" name="type">${UNIT_TYPES.map(x => html`<option value="${x}" ${u && u.type === x ? 'selected' : ''}>${typeLabel(x)}</option>`)}</select></div>
      <div class="field"><label for="u-p">${T('dispatch.fleet.plate', 'Plate number')}</label><input class="input" id="u-p" name="plate" required maxlength="20" value="${u ? u.plate : ''}"></div></div>
      <div class="fields three">${Object.keys(DOC_EN).map(k => html`<div class="field"><label for="u-${k}">${T('dispatch.fleet.expiry_' + k, DOC_EN[k] + ' expiry')}</label><input class="input" id="u-${k}" name="${k}Expiry" type="date" value="${u && u.compliance && u.compliance[k] && u.compliance[k].expiry ? u.compliance[k].expiry : ''}"></div>`)}</div>
      ${u ? html`<div class="fields two"><div class="field"><label for="u-s">${T('dispatch.fleet.status', 'Status')}</label><select class="input" id="u-s" name="status">${['in_service', 'maintenance', 'retired'].map(s => html`<option value="${s}" ${u.status === s ? 'selected' : ''}>${unitStatusLabel(s)}</option>`)}</select></div>
        <div class="field"><label for="u-a">${T('dispatch.fleet.avail', 'Availability')}</label><select class="input" id="u-a" name="availability" ${u.currentIncidentId ? 'disabled' : ''}>${['available', 'offline'].map(a => html`<option value="${a}" ${u.availability === a ? 'selected' : ''}>${avLabel(a)}</option>`)}${['available', 'offline'].includes(u.availability) ? '' : html`<option value="" selected>${avLabel(u.availability)}</option>`}</select>${u.currentIncidentId ? html`<div class="hint">${T('dispatch.fleet.on_job', 'On a job: status and availability can change after the job closes.')}</div>` : ''}</div></div>
        <div class="field"><span class="label">${T('dispatch.fleet.crew', 'Crew')}</span><div class="hint">${T('dispatch.fleet.crew_hint', 'A crew member rides on one unit at a time; ticking someone moves them here.')}</div>${crew.map(c => html`<label class="check"><input type="checkbox" name="crewMembershipIds" data-list value="${c.membershipId}" ${u.crew.some(x => x.membershipId === c.membershipId) ? 'checked' : ''}><span>${c.name} <span class="muted sm">${c.profile ? c.profile.certification : ''}${c.unit && c.unit.id !== u.id ? ' | ' + T('dispatch.fleet.now_on', 'now on {unit}', { unit: c.unit.name }) : ''}</span></span></label>`)}</div>` : ''}`;
    on('unit-add', async () => {
      const r = await dialog({ title: T('dispatch.fleet.add', 'Add unit'), form: true, body: unitFields(null), actions: [{ label: T('dispatch.cancel', 'Cancel'), value: null }, { label: T('dispatch.fleet.add', 'Add unit'), primary: true }], onSubmit: d => api.post('/api/ambulance/units', d) });
      if (r) { toast(T('dispatch.fleet.added', '{unit} added. It starts offline until crew is assigned and clocked in.', { unit: r.name }), 'ok'); MC.render(); }
    });
    on('unit-edit', async el => {
      const u = units.find(x => x.id === el.dataset.id); if (!u) return;
      const r = await dialog({ title: T('dispatch.fleet.edit_t', 'Edit {unit}', { unit: u.name }), form: true, wide: true, body: unitFields(u), actions: [{ label: T('dispatch.cancel', 'Cancel'), value: null }, { label: T('dispatch.fleet.save', 'Save unit'), primary: true }],
        onSubmit: async d => {
          const body = { name: d.name, type: d.type, plate: d.plate, crewMembershipIds: d.crewMembershipIds || [] };
          Object.keys(DOC_EN).forEach(k => { if (d[k + 'Expiry']) body[k + 'Expiry'] = d[k + 'Expiry']; });
          if (d.status && d.status !== u.status) { if (d.status === 'retired' && !(await confirm({ title: T('dispatch.fleet.retire_q', 'Retire {unit}?', { unit: u.name }), body: T('dispatch.fleet.retire_body', 'A retired unit disappears from the board and fleet list. This cannot be undone here.'), ok: T('dispatch.fleet.retire', 'Retire unit'), danger: true }))) return false; body.status = d.status; }
          if (d.availability && d.availability !== u.availability) body.availability = d.availability;
          return api.patch('/api/ambulance/units/' + u.id, body);
        } });
      if (r) { toast(T('dispatch.fleet.saved', '{unit} saved', { unit: r.name }), 'ok'); MC.render(); }
    });
    on('crew-licence', async el => {
      const c = crew.find(x => x.membershipId === el.dataset.id); if (!c) return; const p = c.profile || {};
      const r = await dialog({ title: T('dispatch.crew.licence_t', 'Licence: {name}', { name: c.name }), form: true, body: html`<div class="field"><label for="cl-c">${T('dispatch.crew.cert', 'Certification')}</label><select class="input" id="cl-c" name="certification">${CERTS.map(x => html`<option value="${x}" ${p.certification === x ? 'selected' : ''}>${x}</option>`)}</select></div>
        <div class="fields two"><div class="field"><label for="cl-n">${T('dispatch.crew.licence_no', 'Licence number')}</label><input class="input" id="cl-n" name="licenceNo" required maxlength="40" value="${p.licenceNo || ''}"></div><div class="field"><label for="cl-e">${T('dispatch.crew.licence_exp', 'Licence expiry')}</label><input class="input" id="cl-e" name="licenceExpiry" type="date" required value="${p.licenceExpiry || ''}"></div></div>
        <p class="muted sm">${T('dispatch.crew.reverify', 'Changing these details removes the verification until someone checks the licence again.')}</p>`,
        actions: [{ label: T('dispatch.cancel', 'Cancel'), value: null }, { label: T('dispatch.crew.save_licence', 'Save licence'), primary: true }], onSubmit: d => api.put('/api/ambulance/crew/' + c.membershipId, d) });
      if (r) { toast(T('dispatch.crew.licence_saved', 'Licence details saved'), 'ok'); MC.render(); }
    });
    on('crew-verify', async el => {
      const c = crew.find(x => x.membershipId === el.dataset.id); if (!c || !c.profile) return; const to = !c.profile.verified;
      const ok = await confirm({ title: to ? T('dispatch.crew.verify_q', 'Verify {name}\'s licence?', { name: c.name }) : T('dispatch.crew.unverify_q', 'Remove verification for {name}?', { name: c.name }),
        body: to ? T('dispatch.crew.verify_body', 'Confirm you have seen licence {no} ({cert}), valid to {date}. Verified crew can be dispatched.', { no: c.profile.licenceNo, cert: c.profile.certification, date: MC.date(Date.parse(c.profile.licenceExpiry)) }) : T('dispatch.crew.unverify_body', 'Their unit cannot be dispatched until the licence is verified again.'),
        ok: to ? T('dispatch.crew.verify', 'Verify licence') : T('dispatch.crew.unverify', 'Remove verification'), danger: !to });
      if (!ok) return;
      await api.post('/api/ambulance/crew/' + c.membershipId + '/verify', { verified: to });
      toast(to ? T('dispatch.crew.verified_t', 'Licence verified') : T('dispatch.crew.unverified_t', 'Verification removed'), 'ok'); MC.render();
    });
    on('crew-unit', async el => {
      const c = crew.find(x => x.membershipId === el.dataset.id); if (!c) return;
      const r = await dialog({ title: T('dispatch.crew.assign_t', 'Assign {name} to a unit', { name: c.name }), form: true, body: html`<div class="d-opts" role="radiogroup">${units.map(u => html`<label class="d-opt"><input type="radio" name="unitId" value="${u.id}" ${c.unit && c.unit.id === u.id ? 'checked' : ''}><span><b>${u.name}</b><br><span class="sm muted">${u.crew.length ? u.crew.map(x => x.name).join(', ') : T('dispatch.fleet.no_crew', 'No crew')}</span></span></label>`)}${c.unit ? html`<label class="d-opt"><input type="radio" name="unitId" value="none"><span>${T('dispatch.crew.remove_unit', 'Take off {unit}', { unit: c.unit.name })}</span></label>` : ''}</div>`,
        actions: [{ label: T('dispatch.cancel', 'Cancel'), value: null }, { label: T('dispatch.crew.assign_btn', 'Save assignment'), primary: true }],
        onSubmit: async d => {
          if (!d.unitId) throw new MC.ApiError(400, { error: T('dispatch.crew.pick_unit', 'Choose a unit') });
          if (d.unitId === 'none') { const cur = units.find(u => u.id === c.unit.id); return api.patch('/api/ambulance/units/' + cur.id, { crewMembershipIds: cur.crew.map(x => x.membershipId).filter(x => x !== c.membershipId) }); }
          const u = units.find(x => x.id === d.unitId);
          return api.patch('/api/ambulance/units/' + u.id, { crewMembershipIds: [...new Set(u.crew.map(x => x.membershipId).concat(c.membershipId))] });
        } });
      if (r) { toast(T('dispatch.crew.assigned_t', 'Crew assignment saved'), 'ok'); MC.render(); }
    });
  }

  /* ---------------- metrics ---------------- */
  async function metrics({ query }) {
    const days = [7, 30, 90].includes(Number(query.days)) ? Number(query.days) : 30;
    const m = await api.get('/api/ambulance/metrics' + qs({ days }));
    const b = m.byPriority; const all = b.all;
    const fm = x => (x && x.avgMin != null ? T('dispatch.min', '{n} min', { n: x.avgMin }) : '-');
    const fp = x => (x && x.p90Min != null ? T('dispatch.min', '{n} min', { n: x.p90Min }) : '-');
    const rowsK = ['P1', 'P2', 'P3', 'all'];
    view(html`<div class="page-head"><div><h1>${T('dispatch.met.title', 'Response times')}</h1><p>${T('dispatch.met.sub', 'Incidents received in the last {n} days', { n: days })}</p></div>
      <div class="actions"><div class="seg" role="group" aria-label="${T('dispatch.met.period', 'Period')}">${[7, 30, 90].map(d => html`<button type="button" data-action="met-days" data-days="${d}" aria-pressed="${d === days ? 'true' : 'false'}">${T('dispatch.met.days', '{n} days', { n: d })}</button>`)}</div></div></div>
      ${figures([{ value: all.incidents, label: T('dispatch.met.incidents', 'Incidents') }, { value: all.closed, label: T('dispatch.met.closed', 'Closed') }, { value: all.cancelled, label: T('dispatch.met.cancelled', 'Cancelled') }, { value: fm(all.newToAssigned), label: T('dispatch.met.f_assign', 'Average call to unit assigned') }, { value: fm(all.assignedToOnscene), label: T('dispatch.met.f_scene', 'Average assigned to on scene') }])}
      ${all.incidents ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('dispatch.priority', 'Priority')}</th><th class="num">${T('dispatch.met.incidents', 'Incidents')}</th><th class="num">${T('dispatch.met.closed', 'Closed')}</th><th class="num">${T('dispatch.met.cancelled', 'Cancelled')}</th><th class="num">${T('dispatch.met.assign_avg', 'Call to assigned: average')}</th><th class="num">${T('dispatch.met.assign_p90', 'Call to assigned: 90th percentile')}</th><th class="num">${T('dispatch.met.scene_avg', 'Assigned to on scene: average')}</th><th class="num">${T('dispatch.met.scene_p90', 'Assigned to on scene: 90th percentile')}</th></tr></thead><tbody>
        ${rowsK.map(k => { const r = b[k]; const lbl = k === 'all' ? T('dispatch.met.all', 'All priorities') : k; return html`<tr><td data-label="${T('dispatch.priority', 'Priority')}">${k === 'all' ? html`<b>${lbl}</b>` : pri(k)}</td><td class="num" data-label="${T('dispatch.met.incidents', 'Incidents')}">${r.incidents}</td><td class="num" data-label="${T('dispatch.met.closed', 'Closed')}">${r.closed}</td><td class="num" data-label="${T('dispatch.met.cancelled', 'Cancelled')}">${r.cancelled}</td>
          <td class="num" data-label="${T('dispatch.met.assign_avg', 'Call to assigned: average')}">${fm(r.newToAssigned)} <span class="xs muted">(n=${r.newToAssigned.n})</span></td><td class="num" data-label="${T('dispatch.met.assign_p90', 'Call to assigned: 90th percentile')}">${fp(r.newToAssigned)}</td>
          <td class="num" data-label="${T('dispatch.met.scene_avg', 'Assigned to on scene: average')}">${fm(r.assignedToOnscene)} <span class="xs muted">(n=${r.assignedToOnscene.n})</span></td><td class="num" data-label="${T('dispatch.met.scene_p90', 'Assigned to on scene: 90th percentile')}">${fp(r.assignedToOnscene)}</td></tr>`; })}</tbody></table></div>
        <p class="muted sm" style="margin-top:12px">${T('dispatch.met.note', '90th percentile: 9 in 10 responses were at least this fast. Cancelled calls count in incidents but not in times they never reached.')}</p>` : empty({ icon: 'chart', title: T('dispatch.met.empty', 'No incidents in this period'), body: T('dispatch.met.empty_sub', 'Times appear once units are assigned and arrive on scene.') })}`);
    on('met-days', el => MC.go('#/metrics?days=' + el.dataset.days));
  }

  MC.boot({
    title: 'MediCore Dispatch', subtitle: T('dispatch.login.sub', 'Ambulance dispatch and fleet'), home: '#/board',
    nav: [
      { href: '#/board', label: T('dispatch.nav.board', 'Board'), icon: 'ambulance', perm: 'ambulance.dispatch' },
      { href: '#/new', label: T('dispatch.nav.new', 'New call'), icon: 'phone', perm: 'ambulance.dispatch' },
      { href: '#/incidents', label: T('dispatch.nav.history', 'All incidents'), short: T('dispatch.nav.history_short', 'History'), icon: 'clipboard', perm: 'ambulance.dispatch' },
      { href: '#/fleet', label: T('dispatch.nav.fleet', 'Fleet and crew'), short: T('dispatch.nav.fleet_short', 'Fleet'), icon: 'truck', perm: 'ambulance.fleet' },
      { href: '#/metrics', label: T('dispatch.nav.metrics', 'Response times'), short: T('dispatch.nav.metrics_short', 'Metrics'), icon: 'chart', perm: 'ambulance.fleet' },
      MC.referrals.navItem(),
      MC.whatsapp.navItem(),
    ],
    routes: { '#/board': board, '#/new': newCall, '#/incident/:id': incidentPage, '#/incidents': history, '#/fleet': fleet, '#/metrics': metrics, ...MC.referrals.routes('#/referrals'), ...MC.whatsapp.routes('#/whatsapp') },
    onReady: async () => { MC.referrals.refreshCount(); MC.whatsapp.refreshCount(); try { const b = await api.get('/api/dispatch/board'); cats = b.categories; setCounts(b); } catch (e) { /* board loads on its own */ } },
  });
})();
