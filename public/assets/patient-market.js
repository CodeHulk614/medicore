/*
 * MediCore patient app, collaborative marketplace part: the marketplace map and provider pages, subscription,
 * care team, documents, HMO plans and member cards, member requests, and hospitals near me for emergencies.
 * Load after mc.js and before apps/patient.js; patient.js spreads MC.pmarket.routes() into its routes and exposes
 * MC.patientApp (payBill, loadProviders, choose, providers) used here.
 */
(function () {
  'use strict';
  const { html, api, qs, icon, badge, empty, view, on, form, dialog, confirm, toast, dateTime, date, cap, money } = MC;
  const T = (k, en, v) => MC.t('pm.' + k, en, v);
  const PA = () => MC.patientApp || {};
  const back = (href, label) => html`<a class="back" href="${href}">${icon('left')}${label}</a>`;
  const head = (title, sub) => html`<div class="page-head"><div><h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ''}</div></div>`;
  const lines = text => String(text || '').split('\n').map((l, i) => html`${i ? html`<br>` : ''}${l}`);

  (function styles() {
    const s = document.createElement('style');
    s.textContent = [
      '.pm-map{height:300px;border-radius:var(--r);overflow:hidden;border:1px solid var(--line);margin-bottom:12px}',
      '.pm-hero{border:1px solid var(--line);border-radius:var(--r-lg);padding:var(--s4);background:var(--hue-soft);margin-bottom:var(--s4)}.pm-hero h2{margin:0 0 8px}',
      '.pm-plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:12px 0}',
      '.pm-card{border-radius:16px;padding:18px;color:#fff;background:linear-gradient(135deg,var(--hue),#17292B);margin-bottom:12px}.pm-card .no{font-size:1.25rem;font-weight:700;letter-spacing:.06em}.pm-card .code{font-size:1.6rem;font-weight:700;letter-spacing:.18em;background:rgba(255,255,255,.14);border-radius:10px;padding:6px 10px;display:inline-block;margin-top:8px}.pm-card .sub{opacity:.85;font-size:var(--t-sm)}',
      '.pm-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}',
      '.pm-wgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:12px}.pm-wtile{border:1px solid var(--line);border-radius:var(--r);padding:12px;display:flex;flex-direction:column;gap:4px}.pm-wval{font-size:1.5rem;font-weight:700}.pm-wval small{font-size:var(--t-sm);font-weight:400;color:var(--muted)}',
      '.pm-bars{display:flex;align-items:flex-end;gap:3px;height:34px;margin:4px 0}.pm-bars span{flex:1;background:var(--hue);border-radius:3px 3px 0 0;opacity:.85}.pm-bars span.none{background:var(--line)}',
      '.pm-filters{display:grid;grid-template-columns:1fr 1fr;gap:8px}@media(min-width:720px){.pm-filters{grid-template-columns:repeat(4,1fr)}}',
    ].join('\n');
    document.head.appendChild(s);
  })();

  const TYPE_EN = { hospital: 'Hospital', clinic: 'Clinic', pharmacy: 'Pharmacy', lab: 'Laboratory', ambulance: 'Ambulance service', other: 'Other' };
  const typeLabel = t2 => T('type.' + t2, TYPE_EN[t2] || cap(t2));
  const STATE_EN = { in_stock: 'Available', low: 'Running low', out: 'Out of stock' };
  const stateBadge = s => badge(T('state.' + s, STATE_EN[s] || cap(s)), s === 'in_stock' ? 'ok' : s === 'low' ? 'warn' : 'bad');
  const PLAN_EN = { monthly: '1 month', quarterly: '3 months', annual: '12 months' };
  const planLabel = p => T('plan.' + p, PLAN_EN[p] || cap(p));
  const COLOR = { hospital: '#3D4FA6', clinic: '#3D4FA6', pharmacy: '#1E7A4C', lab: '#6B3FA0', ambulance: '#B42D27', other: '#3C5457' };
  const SHARE_EN = { pending_patient: 'Waiting for you', pending_provider: 'Waiting for the provider', active: 'Active', ended: 'Ended', declined: 'You said no', revoked: 'You stopped it', cancelled: 'Cancelled', expired: 'Ended' };
  const PURPOSE_EN = { ongoing_treatment: 'Ongoing treatment', medicines: 'Medicines and refills', lab_monitoring: 'Regular lab tests', specialist_care: 'Specialist care', physiotherapy: 'Physiotherapy', maternity: 'Maternity care', home_care: 'Home care', second_opinion: 'Second opinion', other: 'Other' };
  const CAT_EN = { case_notes: 'Case notes or folder', referral_letter: 'Referral letter', lab_result: 'Lab result', imaging: 'X-ray or scan report', prescription: 'Prescription', discharge_summary: 'Discharge summary', consent_form: 'Consent form', id_card: 'ID card', hmo_card: 'HMO card', birth_record: 'Birth record', immunisation: 'Immunisation card', invoice_receipt: 'Invoice or receipt', other: 'Other' };
  const REQ_EN = { change_provider: 'Change my primary provider', add_dependant: 'Add a family member', complaint: 'Complaint', question: 'Question', card: 'Member card', refund: 'Refund', other: 'Other' };
  const REL_EN = { self: 'Principal member', spouse: 'Husband or wife', child: 'Child', parent: 'Parent', other: 'Family member' };

  /** registers the patient at a marketplace provider if needed, switches the app to it, then goes to href */
  async function useProvider(o, href) {
    if (!o.yours) {
      const r = await api.post('/api/market/providers/' + o.id + '/join');
      if (!r.approved) { toast(r.message || T('join.wait', 'Your request was sent. You can use {name} once they approve you.', { name: o.name }), 'ok', 6000); return; }
      toast(T('join.done', 'You are registered with {name}. Record number {mrn}.', { name: o.name, mrn: r.mrn || '' }), 'ok', 5000);
    }
    if (PA().loadProviders) { await PA().loadProviders(); const p = (PA().providers() || []).find(x => (x.orgIds || []).includes(o.id)); if (p) PA().choose(p.key); }
    MC.go(href || '#/');
  }

  /* ================= marketplace ================= */
  async function marketPage({ query }) {
    const st = await api.get('/api/market/status');
    if (!st.on) return view(html`${head(T('title', 'Marketplace'))}${empty({ icon: 'globe', title: T('off', 'The marketplace is not open yet'), body: T('off_sub', 'For now you can use the providers you are registered with.') })}`);
    if (!st.full && !st.hmoNetworkProviders) return paywall(st);
    let pos = query.lat ? { lat: Number(query.lat), lng: Number(query.lng) } : null;
    const r = await api.get('/api/market/providers' + qs({ lat: pos && pos.lat, lng: pos && pos.lng, radiusKm: query.km, type: query.type, q: query.q, specialty: query.specialty, drug: query.drug, test: query.test, service: query.service, emergency: query.emergency ? 'true' : undefined, hmo: query.hmo ? 'true' : undefined }));
    const list = r.providers;
    view(html`${head(T('title', 'Marketplace'), st.full ? T('sub_full', 'Every hospital, clinic, pharmacy and lab on MediCore. Your access runs until {d}.', { d: date(st.subscription.endsAt) }) : T('sub_hmo', 'Providers in your HMO network, free with your cover.'))}
      ${!st.full ? html`<div class="notice">${T('hmo_only', 'You see your HMO\'s network. To see every provider on MediCore, get marketplace access.')} <a href="#/market/subscribe">${T('get_access', 'Get access')}</a></div>` : ''}
      <form class="panel" data-form="pm-search" novalidate>
        <div class="pm-filters"><div class="field" style="margin:0"><label for="pm-q">${T('f.q', 'Name or area')}</label><input class="input" id="pm-q" name="q" value="${query.q || ''}"></div>
          <div class="field" style="margin:0"><label for="pm-t">${T('f.type', 'Type')}</label><select class="input" id="pm-t" name="type"><option value="">${T('f.any', 'Any')}</option>${Object.keys(TYPE_EN).map(k => html`<option value="${k}" ${query.type === k ? 'selected' : ''}>${typeLabel(k)}</option>`)}</select></div>
          <div class="field" style="margin:0"><label for="pm-sp">${T('f.specialty', 'Specialist')}</label><input class="input" id="pm-sp" name="specialty" value="${query.specialty || ''}" placeholder="${T('f.specialty_ph', 'e.g. Paediatrics')}"></div>
          <div class="field" style="margin:0"><label for="pm-d">${T('f.drug', 'Medicine in stock')}</label><input class="input" id="pm-d" name="drug" value="${query.drug || ''}" placeholder="${T('f.drug_ph', 'e.g. Amlodipine')}"></div>
          <div class="field" style="margin:0"><label for="pm-te">${T('f.test', 'Lab test')}</label><input class="input" id="pm-te" name="test" value="${query.test || ''}" placeholder="${T('f.test_ph', 'e.g. Malaria')}"></div>
          <div class="field" style="margin:0"><label for="pm-k">${T('f.km', 'Within (km)')}</label><input class="input" id="pm-k" name="km" type="number" min="1" max="500" value="${query.km || ''}"></div></div>
        <label class="check"><input type="checkbox" name="emergency" ${query.emergency ? 'checked' : ''}><span>${T('f.emergency', 'Taking emergencies now')}</span></label>
        ${st.hmoNetworkProviders && st.full ? html`<label class="check"><input type="checkbox" name="hmo" ${query.hmo ? 'checked' : ''}><span>${T('f.hmo', 'Only my HMO\'s network')}</span></label>` : ''}
        <input type="hidden" name="lat" value="${query.lat || ''}"><input type="hidden" name="lng" value="${query.lng || ''}">
        <div class="btn-row"><button class="btn primary" type="submit">${icon('search')}${T('f.search', 'Search')}</button><button class="btn" type="button" data-action="pm-near">${icon('pin')}${T('f.near', 'Near me')}</button></div></form>
      <div class="pm-map" id="pm-map"></div>
      <section class="panel flush">${list.length ? html`<div class="list">${list.map(o => html`<a href="#/market/p/${o.id}${pos ? qs({ lat: pos.lat, lng: pos.lng }) : ''}">${icon(o.type === 'pharmacy' ? 'pill' : o.type === 'lab' ? 'flask' : o.type === 'ambulance' ? 'ambulance' : 'building')}<div class="grow"><span class="title">${o.name}</span>
        <span class="sub">${[typeLabel(o.type), o.area, o.distanceKm != null ? o.distanceKm + ' km' : null].filter(Boolean).join(' | ')}</span>
        <div class="pm-tags">${o.yours ? badge(T('yours', 'Registered'), 'ok') : ''}${o.viaHmo ? badge(T('via_hmo', 'In your HMO network'), 'info') : ''}${o.verified ? badge(T('verified', 'Licence checked'), '') : ''}${o.takingEmergencies === true ? badge(T('taking', 'Taking emergencies'), 'ok') : o.takingEmergencies === false ? badge(T('not_taking', 'Not taking emergencies now'), 'bad') : ''}${o.doctors ? badge(o.doctors === 1 ? T('doctors_1', '1 doctor') : T('doctors_n', '{n} doctors', { n: o.doctors }), '') : ''}${o.video ? badge(T('video', 'Video visits'), '') : ''}</div>
        ${(o.drugMatches || []).length ? html`<span class="sub">${o.drugMatches.map(dm => html`${dm.name}${dm.strength ? ' ' + dm.strength : ''}: ${stateBadge(dm.state)}${dm.priceKobo != null ? ' ' + money(dm.priceKobo) : ''} `)}</span>` : ''}
        ${(o.testMatches || []).length ? html`<span class="sub">${o.testMatches.map(tm => tm.name + (tm.priceKobo != null ? ' ' + money(tm.priceKobo) : '')).join(', ')}</span>` : ''}
        ${(o.specialties || []).length ? html`<span class="sub">${o.specialties.slice(0, 4).join(', ')}</span>` : ''}</div>${icon('right')}</a>`)}</div>`
        : empty({ icon: 'search', title: T('none', 'No provider matches'), body: T('none_sub', 'Try a wider distance or fewer filters.') })}</section>`);
    try {
      const m = await MC.map(document.getElementById('pm-map'), { center: pos || (list[0] && list[0].location) || undefined, zoom: 12 });
      if (pos) m.setMarker('me', pos, { kind: 'me', label: T('you', 'You') });
      list.forEach(o => { if (o.location) m.setMarker(o.id, o.location, { color: COLOR[o.type] || COLOR.other, label: o.name, onClick: () => MC.go('#/market/p/' + o.id) }); });
      m.fit();
    } catch (e) { /* the list works without the map */ }
  }
  form('pm-search', d => MC.go('#/market' + qs({ q: d.q, type: d.type, specialty: d.specialty, drug: d.drug, test: d.test, km: d.km, emergency: d.emergency ? 1 : '', hmo: d.hmo ? 1 : '', lat: d.lat, lng: d.lng })));
  on('pm-near', async () => { const p = await MC.position(); if (!p) return toast(T('no_gps', 'Turn on location to find providers near you'), 'bad'); const d = MC.formData(document.querySelector('[data-form="pm-search"]')); MC.go('#/market' + qs({ q: d.q, type: d.type, specialty: d.specialty, drug: d.drug, test: d.test, km: d.km || 15, emergency: d.emergency ? 1 : '', lat: p.lat.toFixed(5), lng: p.lng.toFixed(5) })); });

  async function paywall(st) {
    const tz = await api.get('/api/market/providers').catch(() => null);
    const prices = st.prices || {}; const keys = Object.keys(prices);
    const perMonth = k => Math.round(prices[k].amountKobo / prices[k].months);
    const base = prices.monthly ? prices.monthly.amountKobo : null;
    view(html`${head(T('title', 'Marketplace'))}
      <div class="pm-hero"><h2>${T('pw.title', 'Find any hospital, clinic, pharmacy or lab')}</h2><p>${T('pw.body', 'See every provider on MediCore on a map: their doctors and specialists, prices, which medicines are in stock, and who is taking emergencies now. Book, order and register with as many as you like.')}</p>
        ${tz && tz.teaser ? html`<p><b>${T('pw.nearby', '{n} providers near you are waiting.', { n: tz.teaser.nearby })}</b> ${tz.teaser.types.map(x => typeLabel(x.type) + ': ' + x.count).join(', ')}</p>` : ''}</div>
      <form class="panel" data-form="pm-sub" novalidate><h2>${T('pw.choose', 'Choose your access')}</h2>
        <div class="pm-plans">${keys.map((k, i) => html`<label class="opt"><input type="radio" name="plan" value="${k}" ${i === keys.length - 1 ? 'checked' : ''}><span class="grow"><span class="title">${planLabel(k)}: ${money(prices[k].amountKobo)}</span><span class="sub">${money(perMonth(k))} ${T('pw.per_month', 'a month')}${base && perMonth(k) < base ? ' | ' + T('pw.save', 'save {p}%', { p: Math.round((1 - perMonth(k) / base) * 100) }) : ''}</span></span></label>`)}</div>
        ${st.showBankCharge ? html`<p class="muted sm">${T('pw.bank', 'Your bank may add a service charge of {c} per payment.', { c: money(st.bankChargeKobo) })}</p>` : ''}
        <label class="check"><input type="checkbox" name="consent" required><span>${T('pw.consent', 'I understand that a provider I book with, order from or join through the marketplace registers me and can see my details and what I share with them.')}</span></label>
        <div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${T('pw.go', 'Get access')}</button>
        <p class="muted sm">${T('pw.hmo_note', 'Have HMO cover? Your HMO\'s providers are free: add your cover in HMO cover.')} <a href="#/more/hmo">${T('pw.hmo_link', 'HMO cover')}</a></p></form>`);
  }
  form('pm-sub', async d => {
    if (!d.consent) throw new MC.ApiError(400, { error: T('pw.need_consent', 'Tick the box to agree first'), details: [{ field: 'consent', error: T('pw.need_consent', 'Tick the box to agree first') }] });
    const r = await api.post('/api/market/subscribe', { plan: d.plan, consent: true });
    const ok = PA().payBill ? await PA().payBill(r.billId, { amountKobo: r.amountKobo, orgName: 'MediCore', returnTo: '#/market' }) : false;
    if (ok === true) { toast(T('pw.active', 'Marketplace access is active'), 'ok'); MC.go('#/market'); }
  });
  async function subscribePage() { const st = await api.get('/api/market/status'); return paywall(st); }

  /* ---------------- a provider's marketplace page ---------------- */
  let CUR = null;
  async function providerPage({ params, query }) {
    let o;
    try { o = await api.get('/api/market/providers/' + params.id + qs({ lat: query.lat, lng: query.lng })); } catch (e) { if (e.status === 404) return view(html`${back('#/market', T('title', 'Marketplace'))}${empty({ icon: 'building', title: T('p.gone', 'This provider is not available to you'), body: T('p.gone_sub', 'Get marketplace access to see every provider.'), action: html`<a class="btn primary" href="#/market/subscribe">${T('get_access', 'Get access')}</a>` })}`); throw e; }
    CUR = o;
    const cap2 = o.capacity || {};
    view(html`${back('#/market', T('title', 'Marketplace'))}<div class="page-head"><div><h1>${o.name}</h1><p>${[typeLabel(o.type), o.area, o.distanceKm != null ? o.distanceKm + ' km' : null, o.hours].filter(Boolean).join(' | ')}</p></div>
      <div class="actions">${o.yours ? html`<button class="btn primary" data-action="pm-use" data-href="#/">${T('p.open', 'Open in my providers')}</button>` : html`<button class="btn primary" data-action="pm-use" data-href="#/">${o.autoRegister ? T('p.join', 'Register with them') : T('p.apply', 'Ask to register')}</button>`}${o.phone ? html`<a class="btn" href="tel:${o.phone}">${icon('phone')}${T('p.call', 'Call')}</a>` : ''}${o.whatsapp ? html`<a class="btn" href="https://wa.me/${String(o.whatsapp).replace(/\D/g, '')}" target="_blank" rel="noopener">${icon('message')}WhatsApp</a>` : ''}</div></div>
      <div class="pm-tags" style="margin-bottom:12px">${o.yours ? badge(T('yours', 'Registered') + (o.mrn ? ' ' + o.mrn : ''), 'ok') : ''}${o.viaHmo ? badge(T('via_hmo', 'In your HMO network'), 'info') : ''}${o.verified ? badge(T('verified', 'Licence checked'), '') : ''}${cap2.acceptingEmergencies === true && !cap2.stale ? badge(T('taking', 'Taking emergencies'), 'ok') : cap2.acceptingEmergencies === false && !cap2.stale ? badge(T('not_taking', 'Not taking emergencies now'), 'bad') : ''}</div>
      ${o.about ? html`<p>${o.about}</p>` : ''}
      <div class="grid two"><div>
        ${o.doctors.length ? html`<section class="panel flush"><h2>${T('p.doctors', 'Doctors and specialists')}</h2><ul class="list">${o.doctors.map(d => html`<li><div class="grow"><span class="title">${d.name}</span><span class="sub">${[d.specialty, (d.languages || []).join(', '), d.video ? T('video', 'Video visits') : null].filter(Boolean).join(' | ')}</span></div><span class="end"><button class="btn sm primary" data-action="pm-use" data-href="#/care/doctor/${d.membershipId}">${T('p.book', 'Book')}</button></span></li>`)}</ul></section>` : ''}
        ${(o.modules || []).includes('pharmacy') ? html`<section class="panel"><h2>${T('p.stock', 'Medicines in stock')}</h2><form class="row" data-form="pm-stock" novalidate><input class="input" name="q" placeholder="${T('p.stock_ph', 'Search a medicine')}" aria-label="${T('p.stock_ph', 'Search a medicine')}" style="flex:1"><button class="btn" type="submit">${icon('search')}</button></form><ul class="list" id="pm-stock"></ul>
          <p class="muted sm">${T('p.rx_note', 'Prescription-only medicines need a prescription from your doctor.')}</p>${o.pharmacyOrders || o.yours ? html`<button class="btn" data-action="pm-use" data-href="#/medicines">${icon('pill')}${T('p.order', 'Send a prescription here')}</button>` : html`<p class="notice warn sm">${T('p.no_orders', 'Ordering from this pharmacy in the app is not available yet. Visit or call them.')}</p>`}</section>` : ''}
        ${o.tests.length ? html`<section class="panel flush"><h2>${T('p.tests', 'Lab tests')}</h2>${(() => { const li = x => html`<li><div class="grow"><span class="title">${x.name}</span><span class="sub">${[x.priceKobo != null ? money(x.priceKobo) : null, x.tatHours ? T('p.tat', 'Results in about {h} hours', { h: x.tatHours }) : null].filter(Boolean).join(' | ')}</span></div></li>`; return html`<ul class="list">${o.tests.slice(0, 8).map(li)}</ul>${o.tests.length > 8 ? html`<details style="padding:0 16px"><summary style="min-height:44px;cursor:pointer;font-weight:600">${T('p.all_tests', 'All {n} tests', { n: o.tests.length })}</summary><ul class="list">${o.tests.slice(8).map(li)}</ul></details>` : ''}`; })()}<div style="padding:12px"><button class="btn" data-action="pm-use" data-href="#/care/provider/${o.id}">${icon('flask')}${T('p.request_test', 'Request a test')}</button></div></section>` : ''}
      </div><div>
        ${o.storeItems.length ? html`<section class="panel flush"><h2>${T('p.available', 'Available now')}</h2><ul class="list">${o.storeItems.map(i => html`<li><div class="grow"><span class="title">${i.name}</span>${i.priceKobo != null ? html`<span class="sub">${money(i.priceKobo)}</span>` : ''}</div><span class="end">${stateBadge(i.state)}</span></li>`)}</ul></section>` : ''}
        ${o.services.length ? html`<section class="panel flush"><h2>${T('p.prices', 'Services and prices')}</h2><ul class="list">${o.services.slice(0, 40).map(s => html`<li><div class="grow"><span class="title">${s.name}</span></div><span class="end">${s.priceKobo != null ? money(s.priceKobo) : ''}</span></li>`)}</ul></section>` : ''}
        <section class="panel"><h2>${T('p.about', 'Good to know')}</h2><dl class="kv">${o.address ? html`<dt>${T('p.address', 'Address')}</dt><dd>${o.address}</dd>` : ''}${o.facilities.length ? html`<dt>${T('p.facilities', 'Facilities')}</dt><dd>${o.facilities.join(', ')}</dd>` : ''}${o.languages.length ? html`<dt>${T('p.languages', 'Languages')}</dt><dd>${o.languages.join(', ')}</dd>` : ''}
          ${o.hmos.length ? html`<dt>${T('p.hmos', 'HMOs accepted')}</dt><dd>${o.hmos.map(h => h.name).join(', ')}</dd>` : ''}${cap2.freeBeds != null && !cap2.stale && cap2.totalBeds ? html`<dt>${T('p.beds', 'Free beds')}</dt><dd>${cap2.freeBeds}</dd>` : ''}${o.partners.length ? html`<dt>${T('p.partners', 'Works with')}</dt><dd>${o.partners.map(x => x.name).join(', ')}</dd>` : ''}</dl></section>
      </div></div>`);
    if ((o.modules || []).includes('pharmacy')) loadStock('');
  }
  async function loadStock(q) { const el = document.getElementById('pm-stock'); if (!el || !CUR) return; const r = await api.get('/api/market/providers/' + CUR.id + '/stock' + qs({ q })); MC.view(r.length ? html`${r.slice(0, q ? 25 : 8).map(i => html`<li><div class="grow"><span class="title">${i.name}${i.strength ? ' ' + i.strength : ''}</span><span class="sub">${[i.form, i.rxOnly ? T('p.rx_only', 'Prescription only') : null, i.priceKobo != null ? money(i.priceKobo) : null].filter(Boolean).join(' | ')}</span></div><span class="end">${stateBadge(i.state)}</span></li>`)}` : html`<li class="muted">${T('p.no_stock', 'Nothing found')}</li>`, el); }
  form('pm-stock', d => loadStock(d.q || ''));
  on('pm-use', async el => { if (CUR) await useProvider(CUR, el.dataset.href); });

  /* ================= care team ================= */
  async function careTeamPage() {
    const r = await api.get('/api/me/care-team');
    const row = s => html`<li><div class="grow"><span class="title">${s.fromOrgName} + ${s.toOrgName}</span><span class="sub">${T('ct.purpose.' + s.purpose, PURPOSE_EN[s.purpose] || cap(s.purpose))}${s.note ? ' | ' + s.note : ''} | ${s.status === 'active' && s.endsAt ? T('ct.until', 'Until {d}', { d: date(s.endsAt) }) : dateTime(s.createdAt)}</span></div>
      <span class="end">${badge(T('ct.st.' + s.status, SHARE_EN[s.status] || cap(s.status)), s.status === 'active' ? 'ok' : s.status.startsWith('pending') ? 'warn' : '')}
        ${s.status === 'pending_patient' ? html`<button class="btn sm primary" data-action="pm-cs" data-a="approve" data-id="${s.id}">${T('ct.agree', 'Agree')}</button><button class="btn sm" data-action="pm-cs" data-a="decline" data-id="${s.id}">${T('ct.no', 'No')}</button>` : ''}
        ${['pending_provider', 'active'].includes(s.status) ? html`<button class="btn sm" data-action="pm-cs" data-a="revoke" data-id="${s.id}">${T('ct.stop', 'Stop sharing')}</button>` : ''}</span></li>`;
    view(html`${back('#/more', T('more', 'More'))}${head(T('ct.title', 'My care team'), T('ct.sub', 'Providers who look after you together and see the same record. You decide.'))}
      ${r.waitingForYou ? html`<div class="notice warn">${T('ct.waiting', 'A provider is waiting for your answer.')}</div>` : ''}
      <section class="panel flush">${r.shares.length ? html`<ul class="list">${r.shares.map(row)}</ul>` : empty({ icon: 'users', title: T('ct.none', 'No shared care'), body: T('ct.none_sub', 'When your hospital wants a pharmacy, lab or another hospital to look after you with them, you will be asked here.') })}</section>`);
  }
  on('pm-cs', async el => {
    const a = el.dataset.a;
    const q = { approve: [T('ct.agree_q', 'Let these providers share your care?'), T('ct.agree_b', 'Both will see your records while it is active. You can stop it any time.'), T('ct.agree', 'Agree')], decline: [T('ct.no_q', 'Say no?'), T('ct.no_b', 'The provider will be told you said no.'), T('ct.no', 'No')], revoke: [T('ct.stop_q', 'Stop sharing your care?'), T('ct.stop_b', 'The other provider stops seeing your records at once.'), T('ct.stop', 'Stop sharing')] }[a];
    if (!(await confirm({ title: q[0], body: q[1], ok: q[2], danger: a !== 'approve' }))) return;
    await api.post('/api/me/care-shares/' + el.dataset.id + '/' + a); MC.render();
  });

  /* ================= documents ================= */
  async function docsPage() {
    const list = await api.get('/api/me/documents');
    view(html`${back('#/more', T('more', 'More'))}${head(T('docs.title', 'My documents'), T('docs.sub', 'Letters, sick notes, signed forms and papers from your providers, and your own old records.'))}
      <div class="btn-row" style="margin-top:0"><button class="btn primary" data-action="pm-up">${icon('plus')}${T('docs.add', 'Add an old record')}</button></div>
      <section class="panel flush">${list.length ? html`<div class="list">${list.map(d => html`<a href="#" data-action="pm-doc" data-id="${d.id}">${icon(d.kind === 'letter' ? 'file' : d.kind === 'form' ? 'edit' : 'clipboard')}<div class="grow"><span class="title">${d.title}</span><span class="sub">${[T('cat.' + d.category, CAT_EN[d.category] || cap(d.category)), d.docDate || date(d.createdAt), d.byPatient ? (d.sharedWithProviders ? T('docs.shared', 'Shared with your providers') : T('docs.private', 'Only you')) : d.orgName].filter(Boolean).join(' | ')}</span></div>${d.status === 'cancelled' ? badge(T('docs.cancelled', 'Cancelled'), 'bad') : ''}</a>`)}</div>`
        : empty({ icon: 'file', title: T('docs.none', 'No documents yet'), body: T('docs.none_sub', 'Take photos of old results, cards and folders so every provider you use can see them.') })}</section>`);
    MC.pmDocs = list;
  }
  on('pm-up', async () => {
    let picked = null;
    const r = await dialog({ title: T('docs.add', 'Add an old record'), form: true, body: html`<div class="field"><label for="pu-c">${T('docs.what', 'What is it')}</label><select class="input" id="pu-c" name="category">${Object.keys(CAT_EN).map(k => html`<option value="${k}">${T('cat.' + k, CAT_EN[k])}</option>`)}</select></div>
      <div class="field"><label for="pu-t">${T('docs.name', 'Name')}</label><input class="input" id="pu-t" name="title" required maxlength="120"></div><div class="field"><label for="pu-d">${T('docs.date', 'Date on the paper')}</label><input class="input" id="pu-d" name="docDate" type="date"></div>
      <div class="field"><span class="label">${T('docs.photo', 'Photo or PDF')}</span><div class="btn-row" style="margin:0"><label class="btn" for="pu-cam">${icon('eye')}${T('docs.camera', 'Take a photo')}</label><label class="btn" for="pu-file">${icon('download')}${T('docs.choose', 'Choose a file')}</label></div><input type="file" id="pu-cam" accept="image/*" capture="environment" hidden data-upl><input type="file" id="pu-file" accept="image/*,application/pdf" hidden data-upl><div class="hint" id="pu-name"></div></div>
      <label class="check"><input type="checkbox" name="share" checked><span>${T('docs.share_q', 'Let my providers see it')}</span></label>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('docs.save', 'Save'), primary: true }],
      onOpen: d => d.querySelectorAll('[data-upl]').forEach(inp => inp.addEventListener('change', () => { picked = inp.files[0] || picked; d.querySelector('#pu-name').textContent = picked ? picked.name : ''; })),
      onSubmit: async d => api.post('/api/me/documents', { category: d.category, title: d.title, docDate: d.docDate, share: !!d.share, file: await MC.readUpload(picked) }) });
    if (r) { toast(T('docs.saved', 'Saved'), 'ok'); MC.render(); }
  });
  on('pm-doc', async el => {
    const d = (MC.pmDocs || []).find(x => x.id === el.dataset.id); if (!d) return;
    if (MC.caretools) return MC.caretools.showDoc(d, null, { blobBase: '/api/me/documents/blobs/' });
    const pages = []; for (const f of d.files || []) { try { pages.push(Object.assign({ url: (await api.blobUrl('/api/me/documents/blobs/' + f.blobId)).url }, f)); } catch (e) { /* skip */ } }
    const L = d.letter;
    const acts = [{ label: MC.t('kit.close', 'Close'), value: null }];
    if (d.byPatient) acts.unshift({ label: d.sharedWithProviders ? T('docs.unshare', 'Stop sharing') : T('docs.share', 'Share with my providers'), value: 'share' }, { label: T('docs.remove', 'Remove'), value: 'remove' });
    const v = await dialog({ title: d.title, wide: true, body: L ? html`<p><b>${L.provider.name}</b><br>${L.issuedOn}</p><p>${lines(L.body)}</p>${L.restFrom ? html`<p>${T('docs.rest', 'Rest from {a} to {b}', { a: L.restFrom, b: L.restTo })}</p>` : ''}<p>${L.signer.name}, ${L.signer.licenceBody} ${L.signer.licenceNo}</p><p class="muted sm">${T('docs.verify', 'Anyone can check it at {url} with code {c}.', { url: location.origin + '/register.html#/verify', c: d.verifyCode })}</p>`
      : d.form ? html`<p>${d.form.text}</p><p class="muted sm">${d.form.signerName} | ${dateTime(d.form.signedAt)}</p>`
        : html`${pages.map(p => (/^image\//.test(p.mime) ? html`<img src="${p.url}" alt="" style="width:100%;border:1px solid var(--line);border-radius:8px;margin-bottom:8px">` : html`<a class="btn" href="${p.url}" target="_blank" rel="noopener">${T('docs.open_pdf', 'Open PDF')}</a>`))}`, actions: acts });
    if (v === 'share') { await api.post('/api/me/documents/' + d.id + '/share', { share: !d.sharedWithProviders }); MC.render(); }
    if (v === 'remove' && await confirm({ title: T('docs.remove_q', 'Remove this document?'), body: T('docs.remove_b', 'It disappears from your app and from your providers.'), ok: T('docs.remove', 'Remove'), danger: true })) { await api.post('/api/me/documents/' + d.id + '/remove'); MC.render(); }
  });

  /* ================= HMO: plans, cards, requests ================= */
  async function plansPage() {
    const [list, acc] = await Promise.all([api.get('/api/me/hmo/plans'), api.get('/api/me/hmo/access').catch(() => ({ all: true, reason: 'open', ninOnFile: true }))]);
    view(html`${back('#/more/hmo', T('hmo.cover', 'HMO cover'))}${head(T('hmo.plans', 'Buy a health plan'), T('hmo.plans_sub', 'HMOs on MediCore. Pay in the app; your cover starts when the premium is paid.'))}
      ${acc.reason === 'uninsured' ? html`<div class="notice ok">${T('hmo.free_uninsured', 'You have no HMO yet, so you can compare and join any HMO here free. No subscription needed.')}</div>` : ''}
      ${acc.reason === 'subscription_required' ? html`<div class="notice">${T('hmo.need_sub', 'You already have HMO cover, so you see your own HMO here. To compare and join other HMOs, subscribe to the marketplace.')} <a class="btn sm" href="#/market/subscribe">${T('hmo.subscribe', 'Subscribe')}</a></div>` : ''}
      ${!acc.ninOnFile ? html`<div class="notice warn">${T('hmo.need_nin', 'Add your NIN in Profile first. HMOs register members with a confirmed NIN.')} <a class="btn sm" href="#/more/profile">${T('hmo.add_nin', 'Add my NIN')}</a></div>` : ''}
      ${list.length ? list.map(h => html`<section class="panel"><h2>${h.name}</h2><p class="muted sm">${T('hmo.network_n', '{n} providers in their network', { n: h.networkProviders })}${h.phone ? ' | ' + h.phone : ''}</p>
        ${h.plans.map(p => html`<div class="panel" style="margin:12px 0 0"><h3 style="margin-top:0">${p.name} <span class="muted sm">(${cap(p.kind)}${p.maxDependants ? ', ' + T('hmo.deps', 'up to {n} family members', { n: p.maxDependants }) : ''})</span></h3>
          <p>${p.premiumMonthlyKobo ? html`<b>${money(p.premiumMonthlyKobo)}</b> ${T('hmo.a_month', 'a month')}` : ''}${p.premiumMonthlyKobo && p.premiumAnnualKobo ? ' | ' : ''}${p.premiumAnnualKobo ? html`<b>${money(p.premiumAnnualKobo)}</b> ${T('hmo.a_year', 'a year')}` : ''}</p>
          ${p.benefits ? html`<p class="sm"><b>${T('hmo.covers', 'Covers')}:</b> ${p.benefits}</p>` : ''}${p.exclusions ? html`<p class="sm"><b>${T('hmo.not_covered', 'Not covered')}:</b> ${p.exclusions}</p>` : ''}${p.waitingDays ? html`<p class="sm muted">${T('hmo.waiting', 'Some benefits start after {n} days.', { n: p.waitingDays })}</p>` : ''}
          <button class="btn primary" data-action="pm-buy" data-plan="${p.id}" data-hmo="${h.payerOrgId}" data-name="${p.name}" data-m="${p.premiumMonthlyKobo || ''}" data-y="${p.premiumAnnualKobo || ''}">${T('hmo.buy', 'Choose this plan')}</button></div>`)}</section>`)
        : empty({ icon: 'shield', title: T('hmo.no_plans', 'No HMO sells plans in the app yet') })}`);
  }
  on('pm-buy', async el => {
    const nets = await api.get('/api/me/hmo/networks/' + el.dataset.hmo + '?primaryOnly=true');
    const r = await dialog({ title: el.dataset.name, form: true, body: html`<div class="field"><span class="label">${T('hmo.how_pay', 'How do you want to pay?')}</span>${el.dataset.m ? html`<label class="opt"><input type="radio" name="period" value="monthly" checked><span class="grow"><span class="title">${T('hmo.monthly', 'Every month')}: ${money(Number(el.dataset.m))}</span></span></label>` : ''}${el.dataset.y ? html`<label class="opt"><input type="radio" name="period" value="annual" ${el.dataset.m ? '' : 'checked'}><span class="grow"><span class="title">${T('hmo.yearly', 'Once a year')}: ${money(Number(el.dataset.y))}</span></span></label>` : ''}</div>
      <div class="field"><label for="hb-p">${T('hmo.primary', 'Your primary provider (where you go first)')}</label><select class="input" id="hb-p" name="primaryOrgId"><option value="">${T('hmo.choose_later', 'Choose later')}</option>${nets.map(n => html`<option value="${n.id}">${n.name}${n.distanceKm != null ? ' (' + n.distanceKm + ' km)' : ''}</option>`)}</select></div>
      <label class="check"><input type="checkbox" name="consent"><span>${T('hmo.consent', 'I accept the plan\'s terms and agree that the HMO and the providers that treat me share my cover and bills.')}</span></label>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('hmo.continue', 'Continue to payment'), primary: true }],
      onSubmit: d => { if (!d.consent) throw new MC.ApiError(400, { error: T('pw.need_consent', 'Tick the box to agree first') }); return api.post('/api/me/hmo/buy', { planId: el.dataset.plan, period: d.period, primaryOrgId: d.primaryOrgId, consent: true }); } });
    if (!r) return;
    const ok = PA().payBill ? await PA().payBill(r.billId, { amountKobo: r.amountKobo, orgName: el.dataset.name, returnTo: '#/hmo/cards' }) : false;
    if (ok === true) MC.go('#/hmo/cards');
  });
  async function cardsPage() {
    const cards = await api.get('/api/me/hmo/cards');
    view(html`${back('#/more/hmo', T('hmo.cover', 'HMO cover'))}${head(T('hmo.cards', 'Member cards'), T('hmo.cards_sub', 'Show the card code at any provider in your HMO\'s network.'))}
      ${cards.length ? cards.map(c => html`<div class="pm-card"><div class="sub">${c.hmoName}${c.planName ? ' | ' + c.planName : ''}</div><div style="font-size:1.2rem;font-weight:700;margin-top:6px">${c.name || ''}</div><div class="sub">${T('rel.' + (c.relation || 'self'), REL_EN[c.relation || 'self'] || cap(c.relation))}</div>
          <div class="no">${c.memberNo}</div>${c.cardCode ? html`<div class="code" aria-label="${T('hmo.code', 'Card code')}">${c.cardCode}</div>` : ''}
          <div class="sub" style="margin-top:8px">${c.status === 'active' ? T('hmo.valid', 'Valid to {d}', { d: c.validTo || '' }) : cap(c.status)}${c.primaryOrgName ? ' | ' + T('hmo.primary_short', 'Primary: {p}', { p: c.primaryOrgName }) : ''}</div></div>
        <div class="btn-row" style="margin-top:0;margin-bottom:20px">${c.paymentDue && c.billId ? html`<button class="btn primary" data-action="pm-paycov" data-bill="${c.billId}" data-name="${c.planName || c.hmoName}">${T('hmo.pay_now', 'Pay the premium')}</button>` : ''}
          ${c.status === 'active' && c.mine ? html`<button class="btn" data-action="pm-primary" data-id="${c.id}" data-hmo="${c.payerOrgId}">${T('hmo.change_primary', 'Change primary provider')}</button>` : ''}
          ${c.mine && c.planId && !c.principalCoverageId && ['active', 'pending'].includes(c.status) && !c.paymentDue ? html`<button class="btn" data-action="pm-renew" data-id="${c.id}" data-name="${c.planName}">${T('hmo.renew', 'Pay for more months')}</button>` : ''}
          ${c.hmoPhone ? html`<a class="btn" href="tel:${c.hmoPhone}">${icon('phone')}${T('hmo.call', 'Call the HMO')}</a>` : ''}</div>`)
        : empty({ icon: 'shield', title: T('hmo.no_cards', 'No member cards yet'), action: html`<a class="btn primary" href="#/hmo/plans">${T('hmo.plans', 'Buy a health plan')}</a>` })}`);
  }
  on('pm-paycov', async el => { const ok = PA().payBill ? await PA().payBill(el.dataset.bill, { orgName: el.dataset.name, returnTo: '#/hmo/cards' }) : false; if (ok === true) MC.render(); });
  on('pm-renew', async el => {
    const v = await dialog({ title: T('hmo.renew', 'Pay for more months'), form: true, body: html`<label class="opt"><input type="radio" name="period" value="monthly" checked><span class="grow"><span class="title">${T('hmo.monthly', 'Every month')}</span></span></label><label class="opt"><input type="radio" name="period" value="annual"><span class="grow"><span class="title">${T('hmo.yearly', 'Once a year')}</span></span></label>`, actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('hmo.continue', 'Continue to payment'), primary: true }], onSubmit: d => api.post('/api/me/hmo/' + el.dataset.id + '/renew', { period: d.period }) });
    if (!v) return; const ok = PA().payBill ? await PA().payBill(v.billId, { amountKobo: v.amountKobo, orgName: el.dataset.name, returnTo: '#/hmo/cards' }) : false; if (ok === true) MC.render();
  });
  on('pm-primary', async el => {
    const nets = await api.get('/api/me/hmo/networks/' + el.dataset.hmo + '?primaryOnly=true');
    const v = await dialog({ title: T('hmo.change_primary', 'Change primary provider'), form: true, body: html`<div class="field"><label for="cp-o">${T('hmo.primary', 'Your primary provider (where you go first)')}</label><select class="input" id="cp-o" name="orgId" required>${nets.map(n => html`<option value="${n.id}">${n.name}${n.distanceKm != null ? ' (' + n.distanceKm + ' km)' : ''}</option>`)}</select></div>`, actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: MC.t('kit.save', 'Save'), primary: true }], onSubmit: d => api.post('/api/me/hmo/' + el.dataset.id + '/primary', { orgId: d.orgId }) });
    if (v) { toast(T('hmo.primary_done', 'Primary provider changed'), 'ok'); MC.render(); }
  });
  async function requestsPage() {
    const [list, cards] = await Promise.all([api.get('/api/me/hmo/requests'), api.get('/api/me/hmo/cards')]);
    const mine = cards.filter(c => c.mine && c.status !== 'declined');
    view(html`${back('#/more/hmo', T('hmo.cover', 'HMO cover'))}${head(T('hmo.req', 'Talk to my HMO'), T('hmo.req_sub', 'Questions, changes and complaints, answered in the app.'))}
      ${mine.length ? html`<form class="panel" data-form="pm-req" novalidate><h2>${T('hmo.req_new', 'New request')}</h2><div class="fields two"><div class="field"><label for="rq-c">${T('hmo.req_cover', 'Cover')}</label><select class="input" id="rq-c" name="coverageId">${mine.map(c => html`<option value="${c.id}">${c.hmoName} ${c.memberNo}</option>`)}</select></div><div class="field"><label for="rq-t">${T('hmo.req_type', 'About')}</label><select class="input" id="rq-t" name="type">${Object.keys(REQ_EN).map(k => html`<option value="${k}">${T('req.' + k, REQ_EN[k])}</option>`)}</select></div></div>
        <div class="field"><label for="rq-s">${T('hmo.req_subject', 'Subject')}</label><input class="input" id="rq-s" name="subject" required maxlength="120"></div><div class="field"><label for="rq-x">${T('hmo.req_text', 'Message')}</label><textarea class="input" id="rq-x" name="text" required rows="3" maxlength="2000"></textarea></div><div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${T('hmo.req_send', 'Send')}</button></form>` : ''}
      ${list.map(r => html`<section class="panel"><div class="row between"><h2 style="margin:0">${r.subject}</h2>${badge(cap(r.status), r.status === 'answered' ? 'ok' : r.status === 'open' ? 'warn' : '')}</div><p class="muted sm">${r.number} | ${T('req.' + r.type, REQ_EN[r.type] || cap(r.type))}</p>
        ${r.messages.map(m => html`<div class="bub ${m.by === 'member' ? 'me' : 'them'}" style="margin-bottom:6px"><span class="who">${m.byName} | ${dateTime(m.at)}</span>${lines(m.text)}</div>`)}
        ${r.status !== 'closed' ? html`<form class="row" data-form="pm-req-reply" data-id="${r.id}" novalidate><input class="input" name="text" required maxlength="2000" style="flex:1" aria-label="${T('hmo.reply', 'Reply')}" placeholder="${T('hmo.reply', 'Reply')}"><button class="btn" type="submit">${T('hmo.req_send', 'Send')}</button></form>` : ''}</section>`)}`);
    list.filter(r => r.unread).forEach(r => api.post('/api/me/hmo/requests/' + r.id + '/read').catch(() => {}));
  }
  form('pm-req', async d => { await api.post('/api/me/hmo/requests', d); toast(T('hmo.req_sent', 'Sent to your HMO'), 'ok'); MC.render(); });
  form('pm-req-reply', async (d, f) => { await api.post('/api/me/hmo/requests/' + f.dataset.id + '/messages', d); MC.render(); });

  /* ================= hospitals near me (emergency) ================= */
  async function hospitalsPage() {
    view(html`${back('#/sos', T('em.back', 'Emergency'))}${head(T('em.title', 'Hospitals near me'), T('em.sub', 'Emergency departments near you, on MediCore or not. In a life-threatening emergency call 112.'))}<div id="em-body">${MC.skeleton(3)}</div>`);
    const p = await MC.position();
    if (!p) return MC.view(html`${empty({ icon: 'pin', title: T('em.no_gps', 'Turn on location'), body: T('em.no_gps_sub', 'We need your location to find the nearest hospitals. Call 112 if you cannot.') })}<a class="btn danger" href="tel:112">${icon('phone')}112</a>`, document.getElementById('em-body'));
    const r = await api.get('/api/emergency/facilities' + qs({ lat: p.lat.toFixed(5), lng: p.lng.toFixed(5) }));
    MC.view(html`<div class="pm-map" id="em-map"></div><div class="btn-row" style="margin-top:0"><a class="btn danger" href="tel:112">${icon('phone')}${T('em.call112', 'Call 112')}</a></div>
      ${r.facilities.length ? html`<section class="panel flush"><ul class="list">${r.facilities.map(f => html`<li><div class="grow"><span class="title">${f.name}</span><span class="sub">${[f.distanceKm != null ? f.distanceKm + ' km' : null, f.etaMin ? T('em.eta', 'about {m} min', { m: f.etaMin }) : null, f.open24h ? T('em.24h', 'Open 24 hours') : null, f.source === 'platform' ? 'MediCore' : null].filter(Boolean).join(' | ')}</span>
        ${f.takingEmergencies === false ? html`<span class="sub">${badge(T('not_taking', 'Not taking emergencies now'), 'bad')}</span>` : ''}<div class="pm-tags">${(f.phones || []).map(ph => html`<a class="btn sm" href="tel:${ph.number}">${icon('phone')}${ph.number}</a>`)}<a class="btn sm" href="https://www.google.com/maps/dir/?api=1&destination=${f.location ? f.location.lat + ',' + f.location.lng : ''}" target="_blank" rel="noopener">${icon('nav')}${T('em.directions', 'Directions')}</a></div></div></li>`)}</ul></section>`
        : empty({ icon: 'building', title: T('em.none', 'No hospital found near you'), body: T('em.none_sub', 'Call 112.') })}`, document.getElementById('em-body'));
    try { const m = await MC.map(document.getElementById('em-map'), { center: p, zoom: 12 }); m.setMarker('me', p, { kind: 'me', label: T('you', 'You') }); r.facilities.forEach(f => { if (f.location) m.setMarker(f.id, f.location, { color: f.source === 'public' ? '#5B6B6A' : '#B42D27', label: f.name }); }); m.fit(); } catch (e) { /* list is enough */ }
  }

  /* ================= health devices and wearables ================= */
  const WT = () => ({ steps: T('w.steps', 'Steps'), heart_rate: T('w.hr', 'Heart rate'), resting_hr: T('w.rhr', 'Resting heart rate'), spo2: T('w.spo2', 'Blood oxygen'), bp: T('w.bp', 'Blood pressure'), glucose: T('w.glucose', 'Blood sugar'), temperature: T('w.temp', 'Temperature'), weight: T('w.weight', 'Weight'), sleep: T('w.sleep', 'Sleep'), hrv: T('w.hrv', 'Heart rate variability') });
  const SRC = () => ({ health_connect: T('w.src.hc', 'Android phone (Health Connect)'), apple_health: T('w.src.ah', 'iPhone (Apple Health)'), cloud: T('w.src.cloud', 'Fitbit, Garmin, Withings, Oura, Polar, Huawei'), bluetooth: T('w.src.bt', 'Bluetooth heart-rate device'), manual: T('w.src.manual', 'Type in a reading'), demo: T('w.src.demo', 'Demo watch') });
  const SRC_HINT = () => ({ health_connect: T('w.hint.hc', 'Install the MediCore app and allow Health Connect. Watches that save to Health Connect (Xiaomi, Samsung and others) then sync on their own.'), apple_health: T('w.hint.ah', 'Install the MediCore app on your iPhone and allow Apple Health. Apple Watch readings then sync on their own.'), cloud: T('w.hint.cloud', 'Sign in to your watch brand\'s account once. New readings arrive by themselves.'), bluetooth: T('w.hint.bt', 'Works in Chrome on Android. Turn on the device, then connect it here.'), manual: T('w.hint.manual', 'For a blood pressure cuff, glucose meter, thermometer or scale.'), demo: T('w.hint.demo', 'Demo only: a pretend watch with a week of readings.') });
  const wval = (k, r) => (k === 'bp' ? r.value + '/' + r.value2 : k === 'sleep' ? (Math.round(r.value / 6) / 10) : k === 'steps' ? Math.round(r.value).toLocaleString('en-NG') : r.value);
  const wunit = (k, u) => (k === 'sleep' ? T('w.hours', 'hours') : u);
  const flagBadge = f => (f === 'urgent' ? badge(T('w.f.urgent', 'Danger range'), 'bad') : f === 'high' ? badge(T('w.f.high', 'High'), 'warn') : f === 'low' ? badge(T('w.f.low', 'Low'), 'warn') : badge(T('w.f.ok', 'Usual range'), 'ok'));
  function bars(vals) { const max = Math.max(1, ...vals.filter(v => v != null)); return html`<div class="pm-bars" aria-hidden="true">${vals.map(v => html`<span style="height:${v == null ? 2 : Math.max(6, Math.round(v / max * 100))}%" class="${v == null ? 'none' : ''}"></span>`)}</div>`; }
  function tiles(st) {
    const L = WT(); const ks = Object.keys(st);
    if (!ks.length) return empty({ icon: 'heart', title: T('w.none', 'No readings yet'), body: T('w.none_sub', 'Connect a device below or type in a reading.') });
    return html`<div class="pm-wgrid">${ks.map(k => { const x = st[k]; return html`<div class="pm-wtile"><div class="sm muted">${L[k] || x.label}</div><div class="pm-wval">${wval(k, x.latest)} <small>${wunit(k, x.unit)}</small></div><div>${k === 'steps' || k === 'sleep' || k === 'weight' ? '' : flagBadge(x.latest.flag)}</div>${bars(x.last7)}<div class="xs muted">${T('w.avg', '7-day average {v}', { v: k === 'bp' ? x.average + '/' + x.average2 : k === 'sleep' ? Math.round(x.average / 6) / 10 + ' ' + T('w.hours', 'hours') : Math.round(x.average).toLocaleString('en-NG') })} | ${dateTime(x.latest.at)}</div></div>`; })}</div>`;
  }
  async function wearablesPage({ stale }) {
    const d = await api.get('/api/me/wearables');
    if (stale()) return;
    const L = WT(); const SR = SRC(); const SH = SRC_HINT();
    view(html`${back('#/more', T('more', 'More'))}${head(T('w.title', 'Health devices'), T('w.sub', 'Sync your watch, band or home devices. Your providers see your readings only if you share them.'))}
      ${d.requests.map(q => html`<div class="notice warn"><b>${T('w.req_t', '{org} asked for a reading', { org: q.orgName })}</b>${q.byName ? ' (' + q.byName + ')' : ''}: ${q.types.map(x => L[x] || x).join(', ')}.<br>${T('w.req_how', 'Open your watch or device app, take the reading, then tap Sync now.')}${q.note ? html`<br><i>${q.note}</i>` : ''}
        <div class="btn-row"><button class="btn primary" data-action="w-sync">${icon('refresh')}${T('w.sync', 'Sync now')}</button><button class="btn" data-action="w-manual" data-types="${q.types.join(',')}">${T('w.type_it', 'Type it in')}</button><button class="btn" data-action="w-share-req" data-id="${q.id}">${icon('users')}${T('w.share_req', 'Share my readings with {org}', { org: q.orgName })}</button></div></div>`)}
      <section class="panel"><div class="row between wrap"><h2 style="margin:0">${T('w.latest', 'My readings')}</h2><div class="btn-row" style="margin:0"><button class="btn sm" data-action="w-sync">${icon('refresh')}${T('w.sync', 'Sync now')}</button><button class="btn sm" data-action="w-manual">${icon('plus')}${T('w.add', 'Add a reading')}</button></div></div>${tiles(d.stats)}</section>
      <section class="panel" id="w-sum"><h2>${T('w.sum_t', 'What your readings say')}</h2><p class="muted sm">${T('w.sum_wait', 'Reading your week...')}</p></section>
      <section class="panel flush"><h2>${T('w.sources', 'Connect a device')}</h2><ul class="list">${d.sources.map(x => html`<li><div class="grow"><span class="title">${SR[x.key] || x.label}</span><span class="sub">${SH[x.key] || ''}${x.lastSyncAt ? ' | ' + T('w.last', 'Last sync {t}', { t: dateTime(x.lastSyncAt) }) : ''}</span></div>
        ${x.connected ? html`<span style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none">${badge(T('w.connected', 'Connected'), 'ok')}<button class="btn sm ghost" data-action="w-disc" data-src="${x.key}">${T('w.disconnect', 'Disconnect')}</button></span>`
          : x.key === 'manual' ? html`<button class="btn sm" data-action="w-manual">${T('w.add', 'Add a reading')}</button>` : x.key === 'bluetooth' ? html`<button class="btn sm" data-action="w-bt" ${navigator.bluetooth ? '' : 'disabled'}>${navigator.bluetooth ? T('w.bt_connect', 'Connect') : T('w.bt_na', 'Not on this phone')}</button>`
          : ['health_connect', 'apple_health'].includes(x.key) ? badge(T('w.in_app', 'In the MediCore app'), 'outline') : html`<button class="btn sm" data-action="w-connect" data-src="${x.key}" ${x.available ? '' : 'disabled'}>${x.available ? T('w.connect', 'Connect') : T('w.soon', 'Coming soon')}</button>`}</li>`)}</ul></section>
      <section class="panel flush"><h2>${T('w.share_t', 'Who can see my readings')}</h2>${d.sharing.length ? html`<ul class="list">${d.sharing.map(x => html`<li><div class="grow"><span class="title">${x.name}</span></div><label class="check" style="flex:none"><input type="checkbox" data-change="w-share" data-org="${x.orgId}" ${x.share ? 'checked' : ''}><span class="sm">${T('w.share', 'Share')}</span></label></li>`)}</ul>` : html`<p class="muted sm" style="padding:0 16px 16px">${T('w.no_prov', 'You are not registered with a provider yet.')}</p>`}</section>`);
    api.get('/api/me/wearables/summary').then(r => { const box = document.getElementById('w-sum'); if (box) MC.view(html`<h2>${T('w.sum_t', 'What your readings say')}</h2><p>${lines(r.text)}</p><p class="xs muted">${r.by === 'ai' ? T('w.by_ai', 'Written by the MediCore assistant from your readings.') : T('w.by_rules', 'Worked out from your readings.')}</p>`, box); }).catch(() => {});
  }
  on('w-sync', async () => { const r = await api.post('/api/me/wearables/refresh'); toast(r.saved ? T('w.synced', '{n} new readings', { n: r.saved }) : r.companion ? T('w.synced_app', 'Open the MediCore app on your phone to send the latest readings') : T('w.synced_none', 'No new readings yet. Take the reading on your device first.'), r.saved ? 'ok' : ''); MC.render(); });
  on('w-connect', async el => { const r = await api.post('/api/me/wearables/connect', { source: el.dataset.src }); if (r.authUrl) { location.href = r.authUrl; return; } toast(T('w.conn_ok', 'Connected'), 'ok'); MC.render(); });
  on('w-disc', async el => { if (!(await confirm({ title: T('w.disc_q', 'Disconnect this device?'), body: T('w.disc_b', 'New readings stop. Readings already saved stay unless you delete them in Profile.'), ok: T('w.disconnect', 'Disconnect') }))) return; await api.post('/api/me/wearables/disconnect', { source: el.dataset.src }); MC.render(); });
  on('w-share-req', async el => { await api.post('/api/me/reading-requests/' + el.dataset.id + '/answer', { share: true }); toast(T('w.shared', 'Shared'), 'ok'); MC.render(); });
  document.addEventListener('change', async e => { const el = e.target; if (!el || !el.dataset || el.dataset.change !== 'w-share') return; await api.post('/api/me/wearables/share', { orgId: el.dataset.org, share: el.checked }); toast(el.checked ? T('w.shared', 'Shared') : T('w.unshared', 'Stopped sharing'), 'ok'); });
  on('w-manual', async el => {
    const L = WT(); const pre = (el.dataset.types || '').split(',').filter(Boolean)[0] || 'bp';
    const d = await dialog({ title: T('w.add_t', 'Add a reading'), form: true, body: html`<div class="field"><label for="wm-t">${T('w.what', 'What did you measure?')}</label><select class="input" id="wm-t" name="type">${['bp', 'heart_rate', 'spo2', 'glucose', 'temperature', 'weight', 'steps'].map(k => html`<option value="${k}" ${k === pre ? 'selected' : ''}>${L[k]}</option>`)}</select></div>
        <div class="fields two"><div class="field"><label for="wm-v">${T('w.value', 'Reading (top number for blood pressure)')}</label><input class="input" id="wm-v" name="value" inputmode="decimal" required></div><div class="field"><label for="wm-v2">${T('w.value2', 'Bottom number (blood pressure only)')}</label><input class="input" id="wm-v2" name="value2" inputmode="numeric"></div></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('w.save', 'Save reading'), primary: true }],
      onSubmit: f => { const v = Number(String(f.value || '').replace(',', '.')); if (!(v > 0)) throw new MC.ApiError(400, { error: T('w.need_v', 'Type the reading') }); const r = { type: f.type, value: v, at: Date.now(), device: 'manual' }; if (f.type === 'bp') { r.value2 = Number(f.value2); if (!(r.value2 > 0)) throw new MC.ApiError(400, { error: T('w.need_v2', 'Type the bottom number too') }); } return api.post('/api/me/wearables/sync', { source: 'manual', readings: [r] }); } });
    if (d) { toast(d.flagged ? T('w.saved_flag', 'Saved. This reading is outside the usual range: check it again and tell your provider.') : T('w.saved', 'Reading saved'), d.flagged ? 'bad' : 'ok'); MC.render(); }
  });
  /* Web Bluetooth heart-rate (GATT Heart Rate Service 0x180D): Chrome on Android */
  on('w-bt', async () => {
    try {
      const dev = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
      const ch = await (await (await dev.gatt.connect()).getPrimaryService('heart_rate')).getCharacteristic('heart_rate_measurement');
      const bpm = await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('timeout')), 15000); ch.addEventListener('characteristicvaluechanged', e => { const v = e.target.value; const f = v.getUint8(0); clearTimeout(to); res(f & 1 ? v.getUint16(1, true) : v.getUint8(1)); }, { once: true }); ch.startNotifications(); });
      try { dev.gatt.disconnect(); } catch (e) { }
      await api.post('/api/me/wearables/sync', { source: 'bluetooth', readings: [{ type: 'heart_rate', value: bpm, at: Date.now(), device: dev.name || 'Bluetooth' }] });
      toast(T('w.bt_ok', 'Heart rate {n} bpm saved', { n: bpm }), 'ok'); MC.render();
    } catch (e) { if (e && e.name === 'NotFoundError') return; toast(T('w.bt_fail', 'Could not read the device. Make sure it is on and close by.'), 'bad'); }
  });

  function routes() {
    return { '#/market': marketPage, '#/market/subscribe': subscribePage, '#/market/p/:id': providerPage, '#/more/care-team': careTeamPage, '#/more/documents': docsPage,
      '#/hmo/plans': plansPage, '#/hmo/cards': cardsPage, '#/hmo/requests': requestsPage, '#/hospitals': hospitalsPage, '#/more/health-devices': wearablesPage };
  }
  MC.pmarket = { routes };
})();
