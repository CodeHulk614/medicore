/* MediCore Community: the community health worker app. Phone-first and offline-first.
 *
 * Every record (household, client, visit, immunisation, antenatal contact, referral) is first
 * saved on the phone in a per-user queue (IndexedDB, localStorage fallback), with a UUID made
 * on the device as its clientRef, then sent to POST /api/chw/sync when online. Sync is
 * idempotent on the server, so a record is only removed from the queue once the server says ok.
 * The queue and the cached data are keyed by the signed-in user (and provider) and never shared.
 */
(function () {
  'use strict';
  const { html, api, qs, date, dateTime, ago, cap, icon, badge, empty, view, on, form, dialog, confirm, toast } = MC;
  const T = (k, en, v) => MC.t('chw.' + k, en, v);

  /* kit gap: icons inside headings, notices, badges and the wristband's 'allergies not recorded' tag have no size in mc.css */
  (function () { const s = document.createElement('style'); s.textContent = '.badge svg,.notice svg,.panel>h2 svg,h1 svg,h3 svg,p svg,.allergy-unknown svg{width:1.1em;height:1.1em;vertical-align:-.15em;flex:none}.back svg{width:20px;height:20px;flex:none}'; document.head.appendChild(s); })();
  const st = s => MC.t('status.' + s, cap(s));

  /* ---------------- offline start ----------------
   * The kit asks /api/auth/me on start; offline that fails and would show the sign-in screen.
   * Keep the last answer (no tokens: the session stays an HttpOnly cookie) and use it only when
   * the network is unreachable, so a CHW can open the app in the field. Cleared on sign-out. */
  const ME_KEY = 'mc-chw-me';
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
  const lsDel = k => { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } };
  let startedOffline = false;
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = String((init && init.method) || 'GET').toUpperCase();
    if (url === '/api/auth/logout') lsDel(ME_KEY);
    if (url !== '/api/auth/me' || method !== 'GET') return realFetch(input, init);
    try {
      const r = await realFetch(input, init);
      if (r.ok) r.clone().text().then(t => lsSet(ME_KEY, t)).catch(() => { });
      else if (r.status === 401 || r.status === 403) lsDel(ME_KEY);
      return r;
    } catch (e) {
      const cached = lsGet(ME_KEY);
      if (cached) { startedOffline = true; return new Response(cached, { status: 200, headers: { 'Content-Type': 'application/json' } }); }
      throw e;
    }
  };

  /* ---------------- device storage ---------------- */
  const scope = () => (MC.me && MC.me.user ? MC.me.user.id + '@' + (MC.me.org ? MC.me.org.id : '') : null);
  let useLS = !('indexedDB' in window);
  let dbp = null;
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      let r; try { r = indexedDB.open('mc-chw', 1); } catch (e) { return rej(e); }
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'clientRef' }).createIndex('scope', 'scope'); if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache', { keyPath: 'key' }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked'));
    });
    dbp.catch(() => { dbp = null; useLS = true; });
    return dbp;
  }
  function idb(storeName, mode, fn) {
    return openDB().then(d => new Promise((res, rej) => {
      const tx = d.transaction(storeName, mode); const r = fn(tx.objectStore(storeName)); let out;
      if (r) r.onsuccess = () => { out = r.result; };
      tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    }));
  }
  const lsJson = k => { try { return JSON.parse(lsGet(k) || 'null'); } catch (e) { return null; } };
  const FULL = () => new Error(T('store.full', 'This phone could not save the record. Free some storage space and try again.'));
  const store = {
    async list(sc) {
      if (!sc) return [];
      if (!useLS) { try { return (await idb('queue', 'readonly', s => s.index('scope').getAll(sc)) || []).sort((a, b) => a.seq - b.seq); } catch (e) { useLS = true; } }
      return (lsJson('mc-chw-q:' + sc) || []).sort((a, b) => a.seq - b.seq);
    },
    async put(rec) {
      if (!rec.scope) throw FULL();
      if (!useLS) { try { await idb('queue', 'readwrite', s => s.put(rec)); return; } catch (e) { useLS = true; } }
      const l = (lsJson('mc-chw-q:' + rec.scope) || []).filter(x => x.clientRef !== rec.clientRef); l.push(rec);
      if (!lsSet('mc-chw-q:' + rec.scope, JSON.stringify(l))) throw FULL();
    },
    async del(sc, ref) {
      if (!useLS) { try { const cur = await idb('queue', 'readonly', s => s.get(ref)); if (cur && cur.scope === sc) await idb('queue', 'readwrite', s => s.delete(ref)); return; } catch (e) { useLS = true; } }
      lsSet('mc-chw-q:' + sc, JSON.stringify((lsJson('mc-chw-q:' + sc) || []).filter(x => x.clientRef !== ref)));
    },
    async get(sc, name) {
      if (!sc) return null;
      if (!useLS) { try { const r = await idb('cache', 'readonly', s => s.get(sc + ':' + name)); return r ? { v: r.v, at: r.at } : null; } catch (e) { useLS = true; } }
      return lsJson('mc-chw-c:' + sc + ':' + name);
    },
    async set(sc, name, v) {
      if (!sc) return;
      const row = { key: sc + ':' + name, scope: sc, v, at: Date.now() };
      if (!useLS) { try { await idb('cache', 'readwrite', s => s.put(row)); return; } catch (e) { useLS = true; } }
      lsSet('mc-chw-c:' + sc + ':' + name, JSON.stringify({ v, at: row.at }));
    },
  };

  /** GET with a per-user cache: online answers are saved, offline the saved copy is used */
  async function cached(path, name) {
    const sc = scope();
    try { const d = await api.get(path); store.set(sc, name, d); return { data: d, offline: false }; }
    catch (e) {
      if (e.status === 0) { const c = await store.get(sc, name); if (c) return { data: c.v, offline: true, at: c.at }; e.noCache = true; }
      throw e;
    }
  }
  const offlineNote = res => (res && res.offline ? html`<div class="notice warn" role="status">${T('offline.note', 'Offline, showing saved data from {t}. New records are kept on this phone.', { t: ago(res.at) })}</div>` : '');
  const offlineEmpty = (e) => { if (e && e.noCache) { view(empty({ icon: 'globe', title: T('offline.none', 'Offline, nothing saved yet'), body: T('offline.none_sub', 'Open this screen once while online so it is saved on this phone. You can still register people and log visits.'), action: html`<a class="btn primary" href="#/register">${icon('plus')}${T('home.register', 'Register a person')}</a>` })); return true; } return false; };

  /* ---------------- schedule (offline fallback built in) ---------------- */
  const NPI_FALLBACK = [['BCG', 'BCG', 0], ['OPV0', 'OPV 0', 0], ['HEPB0', 'Hepatitis B birth dose', 0], ['PENTA1', 'Pentavalent 1', 42], ['PCV1', 'PCV 1', 42], ['OPV1', 'OPV 1', 42], ['ROTA1', 'Rotavirus 1', 42],
    ['PENTA2', 'Pentavalent 2', 70], ['PCV2', 'PCV 2', 70], ['OPV2', 'OPV 2', 70], ['ROTA2', 'Rotavirus 2', 70], ['PENTA3', 'Pentavalent 3', 98], ['PCV3', 'PCV 3', 98], ['OPV3', 'OPV 3', 98], ['ROTA3', 'Rotavirus 3', 98], ['IPV', 'IPV', 98],
    ['MEASLES1', 'Measles 1', null, 9], ['YF', 'Yellow fever', null, 9], ['MENA', 'Meningitis A', null, 9], ['MEASLES2', 'Measles 2', null, 15]].map(([code, label, ageDays, ageMonths]) => ({ code, label, ageDays, ageMonths: ageMonths || null }));
  const SIGN_FALLBACK = { convulsions: 'Convulsions', unable_to_feed: 'Unable to drink or breastfeed', vomiting_everything: 'Vomits everything', lethargic_unconscious: 'Lethargic or unconscious', fast_breathing: 'Fast breathing', chest_indrawing: 'Chest indrawing', high_fever: 'High fever', severe_dehydration: 'Severe dehydration', severe_malnutrition: 'Severe malnutrition (MUAC red)', bleeding: 'Vaginal bleeding', severe_headache: 'Severe headache', blurred_vision: 'Blurred vision', swelling_face_hands: 'Swelling of face or hands', reduced_fetal_movement: 'Reduced fetal movement', leaking_fluid: 'Leaking fluid', severe_abdominal_pain: 'Severe abdominal pain', fever_pregnancy: 'Fever in pregnancy', difficulty_breathing: 'Difficulty breathing', other: 'Other danger sign' };
  let schedule = { immunization: NPI_FALLBACK, ancContactsWeeks: [12, 20, 26, 30, 34, 36, 38, 40], dangerSigns: Object.entries(SIGN_FALLBACK).map(([code, label]) => ({ code, label })), maxBatch: 200 };
  async function loadSchedule() { try { const r = await cached('/api/chw/schedule', 'schedule'); if (r.data && r.data.immunization) schedule = r.data; } catch (e) { /* keep the built-in schedule */ } }
  const signLabel = code => { const s = schedule.dangerSigns.find(x => x.code === code); return T('sign.' + code, s ? s.label : (SIGN_FALLBACK[code] || cap(code))); };
  const vaccineLabel = code => { const v = schedule.immunization.find(x => x.code === code); return v ? v.label : code; };
  const SIGNS = {
    pregnancy: ['bleeding', 'severe_headache', 'blurred_vision', 'convulsions', 'fever_pregnancy', 'reduced_fetal_movement', 'leaking_fluid', 'severe_abdominal_pain', 'swelling_face_hands', 'difficulty_breathing', 'other'],
    child: ['unable_to_feed', 'convulsions', 'lethargic_unconscious', 'vomiting_everything', 'fast_breathing', 'chest_indrawing', 'severe_dehydration', 'high_fever', 'severe_malnutrition', 'other'],
    general: ['high_fever', 'difficulty_breathing', 'convulsions', 'lethargic_unconscious', 'severe_abdominal_pain', 'severe_dehydration', 'vomiting_everything', 'other'],
  };

  /* ---------------- dates ---------------- */
  const today = () => MC.todayISO();
  const addDaysISO = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const addMonthsISO = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return d.toISOString().slice(0, 10); };
  const isoDate = s => (s ? date(Date.parse(s + 'T12:00:00Z')) : '');
  const ageMonths = dob => { if (!dob) return null; const a = new Date(dob + 'T00:00:00Z'); const b = new Date(today() + 'T00:00:00Z'); let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth(); if (b.getUTCDate() < a.getUTCDate()) m--; return Math.max(0, m); };
  const ageText = dob => { const m = ageMonths(dob); if (m == null) return ''; if (m < 1) return T('age.weeks', '{n} weeks', { n: Math.max(0, Math.floor((Date.parse(today()) - Date.parse(dob)) / 604800000)) }); if (m < 24) return T('age.months', '{n} months', { n: m }); return T('age.years', '{n} years', { n: Math.floor(m / 12) }); };
  const gestWeeks = lmp => (lmp ? Math.floor((Date.parse(today() + 'T00:00:00Z') - Date.parse(lmp + 'T00:00:00Z')) / 604800000) : null);
  const kindOf = c => (c.pregnant ? 'pregnancy' : (c.dob && ageMonths(c.dob) < 60 ? 'child' : 'general'));

  /* ---------------- the queue and sync ---------------- */
  const uuid = () => { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128; const h = [...b].map(x => x.toString(16).padStart(2, '0')).join(''); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20); };
  let seqN = 0;
  let syncing = null; let needClock = false;
  const KIND_LABEL = { household: () => T('kind.household', 'Household'), client: () => T('kind.client', 'Person'), visit: () => T('kind.visit', 'Visit'), immunization: () => T('kind.immunization', 'Vaccine'), anc: () => T('kind.anc', 'Antenatal contact'), referral: () => T('kind.referral', 'Referral') };
  const kindLabel = k => (KIND_LABEL[k] ? KIND_LABEL[k]() : cap(k));

  async function pendingList() { return store.list(scope()); }
  async function updatePending() {
    const n = (await pendingList()).length;
    MC.navCount('#/sync', n);
    document.querySelectorAll('[data-pending-count]').forEach(el => { el.textContent = String(n); });
    return n;
  }
  async function enqueue(kind, data, label, meta) {
    const sc = scope(); if (!sc) throw FULL();
    const pos = await MC.position(6000);
    const rec = { clientRef: uuid(), scope: sc, kind, data, label: label || kindLabel(kind), meta: meta || {}, recordedAt: Date.now(), seq: Date.now() * 1000 + (seqN++ % 1000), state: 'pending', createdAt: Date.now() };
    if (pos) { rec.lat = pos.lat; rec.lng = pos.lng; }
    await store.put(rec);
    await updatePending();
    return rec;
  }
  const refMap = async () => ((await store.get(scope(), 'refmap')) || { v: {} }).v || {};
  async function lastSync() { const r = await store.get(scope(), 'lastsync'); return r ? r.v : null; }

  async function onShift() {
    if (!MC.me || !MC.me.clocks) return true;
    try { const s = await api.get('/api/shift/me'); return !!s.open; } catch (e) { return e.status !== 423; }
  }
  /** send waiting records. auto: skip quietly when off shift; all: also resend failed ones */
  function syncNow(opts) {
    const o = opts || {};
    if (syncing) return syncing;
    syncing = (async () => {
      const sc = scope(); if (!sc) return { sent: 0 };
      const all = await store.list(sc);
      const list = all.filter(r => o.all || r.state !== 'failed');
      if (!list.length) return { sent: 0 };
      if (!navigator.onLine) return { offline: true };
      if (o.auto && !(await onShift())) { needClock = true; return { needClock: true }; }
      needClock = false;
      const results = []; const map = await refMap(); let sent = 0; let error = null;
      const size = Math.max(1, Math.min(200, schedule.maxBatch || 200));
      for (let i = 0; i < list.length; i += size) {
        const chunk = list.slice(i, i + size);
        let r;
        try {
          r = await api.post('/api/chw/sync', { records: chunk.map(x => { const out = { clientRef: x.clientRef, kind: x.kind, data: x.data, recordedAt: x.recordedAt }; if (x.lat != null && x.lng != null) { out.lat = x.lat; out.lng = x.lng; } return out; }) });
        } catch (e) { error = e; if (e.code === 'clock_in_required') needClock = true; break; }
        sent += chunk.length;
        const byRef = Object.fromEntries((r.results || []).map(x => [x.clientRef, x]));
        for (const rec of chunk) {
          const res = byRef[rec.clientRef];
          if (!res) continue;
          const row = { clientRef: rec.clientRef, kind: rec.kind, label: rec.label, ok: res.ok, status: res.status, error: res.error, message: res.message, devCode: res.devCode, referralId: res.referralId, id: res.id };
          results.push(row);
          if (res.ok) {
            if (res.id && (rec.kind === 'client' || rec.kind === 'household')) map[rec.clientRef] = res.id;
            await store.del(sc, rec.clientRef);
          } else {
            await store.put(Object.assign({}, rec, { state: res.retry ? 'pending' : 'failed', error: res.error, message: res.message, details: res.details || null, triedAt: Date.now() }));
          }
        }
      }
      await store.set(sc, 'refmap', map);
      if (results.length) await store.set(sc, 'lastsync', { at: Date.now(), results });
      return { sent, results, error };
    })().finally(() => { syncing = null; updatePending(); });
    return syncing;
  }
  async function syncAndReport(opts) {
    const r = await syncNow(opts);
    if (r.offline) { toast(T('sync.offline', 'You are offline. Records stay on this phone and are sent when you reconnect.')); return r; }
    if (r.needClock) { toast(T('sync.need_clock', 'Clock in to send your records.')); return r; }
    if (r.error) { if (r.error.code !== 'clock_in_required') toast(T('sync.failed', 'Could not send: {m}. Your records are safe on this phone.', { m: r.error.message }), 'bad'); return r; }
    if (r.results && r.results.length) {
      const ok = r.results.filter(x => x.ok).length; const bad = r.results.length - ok;
      toast(bad ? T('sync.partly', '{ok} sent, {bad} need attention', { ok, bad }) : T('sync.done', '{ok} records sent', { ok }), bad ? 'bad' : 'ok');
    } else if (!r.sent && opts && !opts.auto) toast(T('sync.nothing', 'Nothing waiting to send'), 'ok');
    return r;
  }
  const DATA_ROUTES = /^#\/($|\?|clients|client\/|referrals|sync|me)/;
  async function autoSync() {
    if (!navigator.onLine || !scope() || syncing) return;
    const r = await syncNow({ auto: true });
    if (r.results && r.results.length) {
      const ok = r.results.filter(x => x.ok).length;
      toast(T('sync.auto', '{ok} saved records sent', { ok }), r.results.some(x => !x.ok) ? 'bad' : 'ok');
      if (DATA_ROUTES.test(location.hash || '#/') && !document.querySelector('dialog.dlg')) MC.render();
    }
  }

  /* ---------------- shared bits ---------------- */
  const tel = s => String(s || '').replace(/[^\d+]/g, '');
  function emergencyCalls() {
    const raw = MC.content('emergencyNumbers', '112');
    const parts = String(raw).split(/[,;]/).map(x => x.trim()).filter(Boolean);
    return html`<div class="btn-row">${parts.map(p => { const m = p.match(/\+?\d[\d\s-]{1,}/); return m ? html`<a class="btn danger lg" style="white-space:normal;text-align:left;max-width:100%;height:auto;padding-top:8px;padding-bottom:8px" href="tel:${tel(m[0])}">${icon('phone')}${T('refer.call', 'Call {n}', { n: p })}</a>` : html`<span class="badge bad">${p}</span>`; })}</div>`;
  }
  const referPanel = (name, hidden) => html`<div class="notice bad" data-refer-panel role="alert" ${hidden ? 'hidden' : ''} style="border-width:2px">
      <h3 style="margin:0 0 4px">${icon('alert')} ${T('refer.now', 'Refer now')}</h3>
      <p style="margin:0 0 8px">${T('refer.now_body', 'A danger sign means {name} must go to the health facility now. This visit is saved as an urgent referral.', { name: name || T('refer.person', 'this person') })}</p>
      <p class="sm" style="margin:0">${T('refer.call_if', 'If they cannot travel or are getting worse, call an ambulance:')}</p>${emergencyCalls()}</div>`;
  const signChecks = (codes, chosen) => html`<fieldset class="field" style="border:0;padding:0;margin:0 0 16px"><legend class="label" style="font-weight:700;margin-bottom:6px">${T('visit.signs', 'Danger signs')}</legend><div class="hint">${T('visit.signs_hint', 'Tick every sign you see. Any sign makes this an urgent referral.')}</div>
      ${codes.map(c => html`<label class="check"><input type="checkbox" name="dangerSigns" data-list value="${c}" ${(chosen || []).includes(c) ? 'checked' : ''}><span>${signLabel(c)}</span></label>`)}</fieldset>`;
  const pendingBadge = () => badge(T('state.local', 'Not sent yet'), 'warn');
  const clientStatus = c => (c.local ? pendingBadge() : c.status === 'pending_link' ? badge(T('client.pending_link', 'Needs link code'), 'warn') : '');
  document.addEventListener('change', e => {
    const el = e.target; const f = el && el.closest ? el.closest('form') : null; if (!f) return;
    if (el.name === 'dangerSigns') {
      const n = f.querySelectorAll('input[name="dangerSigns"]:checked').length;
      const p = f.querySelector('[data-refer-panel]'); if (p) p.hidden = !n;
      const out = f.querySelector('select[name="outcome"]'); if (out) { if (n) out.value = 'referred'; out.disabled = !!n; }
      const btn = f.querySelector('button[type=submit]'); if (btn && btn.dataset.normal) btn.textContent = n ? btn.dataset.refer : btn.dataset.normal;
      f.classList.toggle('refer-on', !!n);
    }
    if (el.name === 'pregnant') { const l = f.querySelector('[data-lmp]'); if (l) l.hidden = !el.checked; }
  });

  /* clients from the cached roster plus the ones still on the phone */
  async function rosterAll() {
    let res = null, err = null;
    try { res = await cached('/api/chw/roster', 'roster'); } catch (e) { err = e; }
    const roster = res ? res.data : { households: [], clientsWithoutHousehold: [], counts: {} };
    const q = await pendingList(); const map = await refMap();
    const hhs = roster.households.map(h => Object.assign({}, h, { clients: h.clients.slice() }));
    const known = new Set(hhs.map(h => h.clientRef).concat(roster.households.flatMap(h => h.clients.map(c => c.clientRef))).concat(roster.clientsWithoutHousehold.map(c => c.clientRef)));
    const lone = roster.clientsWithoutHousehold.slice();
    q.filter(r => r.kind === 'household' && !known.has(r.clientRef)).forEach(r => hhs.unshift(Object.assign({ id: 'ref-' + r.clientRef, clientRef: r.clientRef, local: true, failed: r.state === 'failed', clients: [] }, r.data)));
    q.filter(r => r.kind === 'client' && !known.has(r.clientRef)).forEach(r => {
      const d = r.data; const c = Object.assign({ id: 'ref-' + r.clientRef, clientRef: r.clientRef, local: true, failed: r.state === 'failed', name: d.firstName + ' ' + d.lastName, status: 'local' }, d);
      const hid = d.householdId || (d.householdRef ? (map[d.householdRef] || 'ref-' + d.householdRef) : null);
      const h = hid && hhs.find(x => x.id === hid || x.id === 'ref-' + d.householdRef || x.clientRef === d.householdRef);
      if (h) h.clients.unshift(c); else lone.unshift(c);
    });
    return { res, err, households: hhs, lone, all: hhs.flatMap(h => h.clients).concat(lone) };
  }
  /* resolve a route id (server id or ref-<clientRef>) to the id/ref used in records */
  async function target(routeId) {
    if (!routeId.startsWith('ref-')) return { clientId: routeId };
    const ref = routeId.slice(4); const map = await refMap();
    return map[ref] ? { clientId: map[ref] } : { forClientRef: ref };
  }
  async function findClient(routeId) {
    const r = await rosterAll();
    let c = r.all.find(x => x.id === routeId);
    if (!c && routeId.startsWith('ref-')) { const map = await refMap(); const sid = map[routeId.slice(4)]; if (sid) c = r.all.find(x => x.id === sid); }
    return c || null;
  }

  /* ================= home ================= */
  async function home({ me, stale }) {
    let due = null, refs = null;
    try { due = await cached('/api/chw/due?days=7', 'due'); } catch (e) { due = null; }
    try { refs = await cached('/api/chw/referrals', 'referrals'); } catch (e) { refs = null; }
    const q = await pendingList(); const failed = q.filter(r => r.state === 'failed');
    const r = await rosterAll();
    if (stale()) return;
    const t0 = today(); const items = due ? due.data.immunizations.concat(due.data.anc).sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1)) : [];
    const now1 = items.filter(i => i.dueOn <= t0); const soon = items.filter(i => i.dueOn > t0);
    // local clients (not synced) with immunisations due: computed on the phone
    r.all.filter(c => c.local && c.dob && ageMonths(c.dob) < 60).forEach(c => schedule.immunization.forEach(v => { const d = v.ageMonths ? addMonthsISO(c.dob, v.ageMonths) : addDaysISO(c.dob, v.ageDays || 0); if (d <= addDaysISO(t0, 7)) (d <= t0 ? now1 : soon).push({ type: 'immunization', code: v.code, label: v.label, dueOn: d, overdue: d < t0, clientId: c.id, name: c.name }); }));
    const openRefs = refs ? refs.data.filter(x => x.status === 'open') : [];
    const pendingLink = r.all.filter(c => c.status === 'pending_link');
    const dueRow = i => html`<a href="#/client/${i.clientId}"><div class="grow"><span class="title">${i.name}</span><span class="sub">${i.type === 'anc' ? T('home.anc_due', 'Antenatal contact {n}', { n: String(i.code || '').replace('ANC', '') }) + (i.gestWeeks != null ? ' | ' + T('home.weeks', '{n} weeks pregnant', { n: i.gestWeeks }) : '') : html`${T('home.vaccine', 'Vaccine')}: ${i.label}`}</span></div><span class="end">${i.overdue ? badge(T('due.overdue', 'Overdue'), 'bad') : badge(isoDate(i.dueOn), 'warn')}</span></a>`;
    view(html`<div class="page-head"><div><h1>${T('home.hello', 'Hello, {name}', { name: (me.user.name || '').split(' ')[0] })}</h1><p>${me.org.name} | ${T('home.sub', 'Your visits for today')}</p></div>
      <div class="actions"><a class="btn primary" href="#/register">${icon('plus')}${T('home.register', 'Register a person')}</a></div></div>
      ${offlineNote(due || refs)}${!navigator.onLine && !(due && due.offline) ? html`<div class="notice warn">${T('offline.short', 'You are offline. New records are saved on this phone.')}</div>` : ''}
      <section class="panel"><div class="row between wrap"><div><h2 style="margin:0">${q.length ? T('home.pending', '{n} records waiting to send', { n: q.length }) : T('home.all_sent', 'All records sent')}</h2>
        <p class="muted sm" style="margin:4px 0 0">${q.length ? (failed.length ? T('home.failed', '{n} need your attention.', { n: failed.length }) : navigator.onLine ? T('home.will_send', 'They are sent automatically when you are online and clocked in.') : T('home.offline_keep', 'They stay on this phone until you are back online.')) : T('home.synced_sub', 'Everything you recorded is saved on MediCore.')}${needClock ? ' ' + T('home.need_clock', 'Clock in to send them.') : ''}</p></div>
        <div class="row wrap">${q.length ? html`<button class="btn primary" data-action="chw-sync">${icon('refresh')}${T('sync.now', 'Sync now')}</button>` : ''}<a class="btn" href="#/sync">${T('home.see_queue', 'See records')}</a></div></div></section>
      ${failed.length ? html`<div class="notice bad">${T('home.fix', '{n} records were not accepted. Open Sync to fix them.', { n: failed.length })} <a href="#/sync">${T('home.open_sync', 'Open Sync')}</a></div>` : ''}
      <section style="margin-bottom:16px"><h2>${T('home.due_now', 'Due today or overdue')}</h2>${now1.length ? html`<div class="list">${now1.map(dueRow)}</div>` : empty({ icon: 'check', title: T('home.none_due', 'Nothing due today'), body: due ? T('home.none_due_sub', 'Vaccines and antenatal contacts that fall due appear here.') : T('home.due_unknown', 'Go online once to load what is due.') })}</section>
      ${soon.length ? html`<section style="margin-bottom:16px"><h2>${T('home.due_soon', 'Coming up this week')}</h2><div class="list">${soon.map(dueRow)}</div></section>` : ''}
      <section style="margin-bottom:16px"><h2>${T('home.follow', 'Follow up')}</h2>${openRefs.length || pendingLink.length ? html`<div class="list">
        ${openRefs.map(x => html`<a href="#/client/${x.clientId}"><div class="grow"><span class="title">${x.name || ''}</span><span class="sub">${x.reason}</span></div><span class="end">${x.urgency === 'urgent' ? badge(T('ref.urgent', 'Urgent'), 'bad') : ''} ${badge(T('ref.not_at_desk', 'Not at the desk yet'), 'warn')}</span></a>`)}
        ${pendingLink.map(c => html`<a href="#/client/${c.id}"><div class="grow"><span class="title">${c.name}</span><span class="sub">${T('home.link_needed', 'Ask for the SMS code to link their MediCore record')}</span></div>${badge(T('client.pending_link', 'Needs link code'), 'warn')}</a>`)}</div>`
        : empty({ icon: 'clipboard', title: T('home.no_follow', 'No follow-ups'), body: T('home.no_follow_sub', 'Referrals not yet at the front desk and people waiting to be linked show here.') })}</section>
      <p><a href="#/me">${icon('user')} ${T('home.profile', 'My profile')}</a></p>`);
  }

  /* ================= clients (households) ================= */
  async function clients({ query, stale }) {
    const r = await rosterAll();
    if (stale()) return;
    if (!r.res && r.err && !r.err.noCache) throw r.err;
    const s = String(query.q || '').toLowerCase().trim();
    const match = c => !s || (c.name || '').toLowerCase().includes(s);
    const hh = r.households.map(h => Object.assign({}, h, { clients: h.clients.filter(match) })).filter(h => !s || h.clients.length || (h.name || '').toLowerCase().includes(s));
    const lone = r.lone.filter(match);
    const row = c => html`<a href="#/client/${c.id}"><div class="grow"><span class="title">${c.name}</span><span class="sub">${[c.relationship, c.sex && c.sex !== 'unknown' ? cap(c.sex) : '', c.dob ? ageText(c.dob) : '', c.pregnant ? T('client.pregnant', 'Pregnant') : ''].filter(Boolean).join(' | ')}${c.lastVisitAt ? ' | ' + T('client.last_visit', 'last visit {t}', { t: ago(c.lastVisitAt) }) : ''}</span></div><span class="end">${clientStatus(c)}${c.assigned ? badge(T('client.assigned', 'Assigned'), 'info') : ''}</span></a>`;
    view(html`<div class="page-head"><div><h1>${T('clients.title', 'Households and people')}</h1><p>${T('clients.count', '{h} households, {c} people', { h: r.households.length, c: r.all.length })}</p></div>
      <div class="actions"><a class="btn" href="#/register/household">${icon('home')}${T('clients.add_hh', 'Add household')}</a><a class="btn primary" href="#/register">${icon('plus')}${T('home.register', 'Register a person')}</a></div></div>
      ${r.res ? offlineNote(r.res) : html`<div class="notice warn">${T('offline.roster_none', 'Offline and no saved list yet. Only people recorded on this phone are shown.')}</div>`}
      <form data-form="client-search" role="search" class="row" style="margin-bottom:16px"><div class="search" style="flex:1"><label class="sr-only" for="cs-q">${T('clients.search', 'Search by name')}</label>${icon('search')}<input class="input" id="cs-q" name="q" value="${query.q || ''}" placeholder="${T('clients.search', 'Search by name')}"></div><button class="btn" type="submit">${T('clients.find', 'Find')}</button></form>
      ${!hh.length && !lone.length ? empty({ icon: 'users', title: s ? T('clients.no_match', 'Nobody matches') : T('clients.none', 'No households yet'), body: T('clients.none_sub', 'Register a household, then the people who live there.'), action: html`<a class="btn primary" href="#/register/household">${icon('home')}${T('clients.add_hh', 'Add household')}</a>` }) : ''}
      ${hh.map(h => html`<section class="panel flush"><div class="row between wrap" style="padding:16px 16px 8px"><div><h2 style="margin:0">${h.name}</h2><span class="sub muted sm">${[h.address, h.area, h.lga].filter(Boolean).join(', ')}${h.members ? ' | ' + T('clients.members', '{n} people live here', { n: h.members }) : ''}</span> ${h.local ? pendingBadge() : ''}</div>
        <a class="btn sm" href="#/register?hh=${h.id}">${icon('plus')}${T('clients.add_person', 'Add person')}</a></div>
        ${h.clients.length ? html`<div class="list" style="border:0;border-top:1px solid var(--line-2);border-radius:0">${h.clients.map(row)}</div>` : html`<p class="muted sm" style="padding:0 16px 16px">${T('clients.hh_empty', 'Nobody registered in this household yet.')}</p>`}</section>`)}
      ${lone.length ? html`<section><h2>${T('clients.lone', 'Not in a household')}</h2><div class="list">${lone.map(row)}</div></section>` : ''}`);
    form('client-search', d => MC.go('#/clients' + qs({ q: d.q })));
  }

  /* ================= register ================= */
  async function registerPerson({ query, stale }) {
    const r = await rosterAll();
    if (stale()) return;
    const pre = query.hh || '';
    view(html`<div class="page-head"><div><h1>${T('reg.title', 'Register a person')}</h1><p>${T('reg.sub', 'Works offline. The record is sent when you are online.')}</p></div></div>
      <nav class="tabs"><a href="#/register" aria-current="page">${T('reg.person_tab', 'Person')}</a><a href="#/register/household">${T('reg.hh_tab', 'Household')}</a></nav>
      <form class="panel" data-form="reg-client" novalidate>
        <div class="field"><label for="rc-h">${T('reg.household', 'Household')}</label><select class="input" id="rc-h" name="household"><option value="">${T('reg.no_household', 'Not in a household')}</option>${r.households.map(h => html`<option value="${h.id}" ${pre === h.id ? 'selected' : ''}>${h.name}${h.local ? ' (' + T('state.local', 'Not sent yet') + ')' : ''}</option>`)}</select><div class="hint"><a href="#/register/household">${T('reg.new_hh', 'Add a new household first')}</a></div></div>
        <div class="fields two"><div class="field"><label for="rc-f">${T('field.firstName', 'First name')}</label><input class="input" id="rc-f" name="firstName" required maxlength="60" autocomplete="off"></div>
        <div class="field"><label for="rc-l">${T('field.lastName', 'Last name')}</label><input class="input" id="rc-l" name="lastName" required maxlength="60" autocomplete="off"></div></div>
        <div class="fields two"><div class="field"><label for="rc-s">${T('field.sex', 'Sex')}</label><select class="input" id="rc-s" name="sex"><option value="female">${T('sex.female', 'Female')}</option><option value="male">${T('sex.male', 'Male')}</option><option value="other">${T('sex.other', 'Other')}</option><option value="unknown">${T('sex.unknown', 'Not known')}</option></select></div>
        <div class="field"><label for="rc-d">${T('field.dob', 'Date of birth')}</label><input class="input" id="rc-d" name="dob" type="date" max="${today()}"><div class="hint">${T('reg.dob_hint', 'Needed for the vaccine schedule of children.')}</div></div></div>
        <div class="fields two"><div class="field"><label for="rc-p">${T('field.phone', 'Phone')}</label><input class="input" id="rc-p" name="phone" inputmode="tel" placeholder="0803 123 4567" maxlength="20"><div class="hint">${T('reg.phone_hint', 'Optional. We send a welcome SMS.')}</div></div>
        <div class="field"><label for="rc-r">${T('field.relationship', 'Relationship in household')}</label><input class="input" id="rc-r" name="relationship" maxlength="40" placeholder="${T('reg.rel_ph', 'e.g. mother, child')}"></div></div>
        <label class="check"><input type="checkbox" name="pregnant"><span>${T('reg.pregnant', 'Pregnant now')}</span></label>
        <div class="field" data-lmp hidden><label for="rc-m">${T('field.lmp', 'First day of last period (LMP)')}</label><input class="input" id="rc-m" name="lmp" type="date" max="${today()}"></div>
        <label class="check"><input type="checkbox" name="noKnownAllergies"><span>${T('reg.nka', 'No known allergies')}</span></label>
        <div class="notice" style="margin-top:12px"><b>${T('reg.consent_title', 'Privacy notice')}</b><br>${MC.content('chwConsent', T('reg.consent_text', 'Read this to the person: MediCore keeps your health record safe and shares it only with the health workers caring for you. You can ask to see or delete it at any time.'))}</div>
        <label class="check"><input type="checkbox" name="consent" required><span><b>${T('reg.consent', 'The person agrees to the privacy notice')}</b></span></label>
        <p class="muted sm">${T('reg.location', 'Your location is saved with the record, if the phone allows it.')}</p>
        <div class="form-err notice bad" hidden></div><button class="btn primary block lg" type="submit">${T('reg.save', 'Save person')}</button></form>`);
    form('reg-client', async d => {
      if (!d.firstName || !d.lastName) throw new MC.ApiError(400, { error: T('reg.need_name', 'Enter the first and last name'), details: [!d.firstName && { field: 'firstName', error: T('reg.required', 'Required') }, !d.lastName && { field: 'lastName', error: T('reg.required', 'Required') }].filter(Boolean) });
      if (!d.consent) throw new MC.ApiError(400, { error: T('reg.need_consent', 'The person must agree to the privacy notice before you register them'), details: [{ field: 'consent', error: T('reg.required', 'Required') }] });
      const data = { firstName: d.firstName, lastName: d.lastName, sex: d.sex || 'unknown', consent: true };
      ['dob', 'phone', 'relationship'].forEach(k => { if (d[k]) data[k] = d[k]; });
      if (d.pregnant) { data.pregnant = true; if (d.lmp) data.lmp = d.lmp; }
      if (d.noKnownAllergies) data.noKnownAllergies = true;
      if (d.household) { if (d.household.startsWith('ref-')) { const map = await refMap(); const ref = d.household.slice(4); if (map[ref]) data.householdId = map[ref]; else data.householdRef = ref; } else data.householdId = d.household; }
      const rec = await enqueue('client', data, T('kind.client', 'Person') + ': ' + data.firstName + ' ' + data.lastName);
      toast(T('reg.saved', '{name} saved on this phone', { name: data.firstName }), 'ok');
      if (navigator.onLine) await syncNow({ auto: true });
      const map = await refMap();
      MC.go('#/client/' + (map[rec.clientRef] || 'ref-' + rec.clientRef));
    });
  }
  async function registerHousehold() {
    view(html`<div class="page-head"><div><h1>${T('reg.hh_title', 'Add a household')}</h1><p>${T('reg.sub', 'Works offline. The record is sent when you are online.')}</p></div></div>
      <nav class="tabs"><a href="#/register">${T('reg.person_tab', 'Person')}</a><a href="#/register/household" aria-current="page">${T('reg.hh_tab', 'Household')}</a></nav>
      <form class="panel" data-form="reg-hh" novalidate>
        <div class="field"><label for="rh-n">${T('field.name', 'Household name')}</label><input class="input" id="rh-n" name="name" required maxlength="100" placeholder="${T('reg.hh_ph', 'e.g. Okonkwo household')}"></div>
        <div class="field"><label for="rh-a">${T('field.address', 'Address or directions')}</label><input class="input" id="rh-a" name="address" maxlength="300"></div>
        <div class="fields three"><div class="field"><label for="rh-ar">${T('field.area', 'Area')}</label><input class="input" id="rh-ar" name="area" maxlength="80"></div><div class="field"><label for="rh-w">${T('field.ward', 'Ward')}</label><input class="input" id="rh-w" name="ward" maxlength="80"></div><div class="field"><label for="rh-l">${T('field.lga', 'LGA')}</label><input class="input" id="rh-l" name="lga" maxlength="80"></div></div>
        <div class="fields two"><div class="field"><label for="rh-p">${T('field.phone', 'Phone')}</label><input class="input" id="rh-p" name="phone" inputmode="tel" maxlength="20"></div><div class="field"><label for="rh-m">${T('field.members', 'People living here')}</label><input class="input" id="rh-m" name="members" type="number" min="1" max="60" inputmode="numeric"></div></div>
        <p class="muted sm">${T('reg.location', 'Your location is saved with the record, if the phone allows it.')}</p>
        <div class="form-err notice bad" hidden></div><button class="btn primary block lg" type="submit">${T('reg.hh_save', 'Save household')}</button></form>`);
    form('reg-hh', async d => {
      if (!d.name) throw new MC.ApiError(400, { error: T('reg.need_hh', 'Enter a name for the household'), details: [{ field: 'name', error: T('reg.required', 'Required') }] });
      const data = { name: d.name }; ['address', 'area', 'ward', 'lga', 'phone', 'members'].forEach(k => { if (d[k] !== undefined && d[k] !== '') data[k] = d[k]; });
      const rec = await enqueue('household', data, T('kind.household', 'Household') + ': ' + d.name);
      toast(T('reg.hh_saved', 'Household saved on this phone'), 'ok');
      if (navigator.onLine) syncNow({ auto: true });
      MC.go('#/register?hh=ref-' + rec.clientRef);
    });
  }

  /* ================= client page ================= */
  async function clientPage({ params, stale }) {
    let id = params.id; let res = null; let c = null; let rec = { visits: [], immunizations: [], anc: [], referrals: [], due: [] };
    if (id.startsWith('ref-')) { const map = await refMap(); if (map[id.slice(4)]) id = map[id.slice(4)]; }
    if (!id.startsWith('ref-')) {
      try { res = await cached('/api/chw/clients/' + encodeURIComponent(id), 'client:' + id); c = res.data; rec = c; }
      catch (e) { if (e.status === 404) return view(html`<a class="back" href="#/clients">${icon('left')}${T('clients.title', 'Households and people')}</a>${empty({ icon: 'users', title: T('client.not_found', 'Person not found'), body: T('client.not_found_sub', 'They may have been assigned to another health worker.') })}`); if (!e.noCache) throw e; }
    }
    if (!c) c = await findClient(params.id);
    if (stale()) return;
    if (!c) return view(html`<a class="back" href="#/clients">${icon('left')}${T('clients.title', 'Households and people')}</a>${empty({ icon: 'globe', title: T('client.unavailable', 'Not saved on this phone'), body: T('client.unavailable_sub', 'Open this person once while online to keep their record on this phone.') })}`);
    const q = await pendingList();
    const mine = q.filter(r => r.kind !== 'client' && r.kind !== 'household' && ((r.data.clientId && r.data.clientId === c.id) || (r.data.forClientRef && r.data.forClientRef === c.clientRef)));
    const ls = await lastSync(); const link = ls && ls.results.find(x => x.clientRef === c.clientRef && x.status === 'link_requested');
    const kind = kindOf(c); const rid = params.id;
    const given = {}; (rec.immunizations || []).forEach(v => { given[v.vaccine] = { on: v.givenOn }; }); mine.filter(r => r.kind === 'immunization').forEach(r => { given[r.data.vaccine] = { on: r.data.givenOn, local: true, failed: r.state === 'failed' }; });
    const child = c.dob && ageMonths(c.dob) < 60;
    const t0 = today();
    const card = child || Object.keys(given).length ? schedule.immunization.map(v => { const due = c.dob ? (v.ageMonths ? addMonthsISO(c.dob, v.ageMonths) : addDaysISO(c.dob, v.ageDays || 0)) : null; const g = given[v.code]; return { v, due, g, state: g ? 'given' : !due ? 'unknown' : due < t0 ? 'overdue' : due <= addDaysISO(t0, 14) ? 'due' : 'later' }; }) : [];
    const ancCount = (rec.anc || []).length + mine.filter(r => r.kind === 'anc').length;
    const ga = c.pregnant ? gestWeeks(c.lmp) : null;
    const nextAnc = c.pregnant && c.lmp && ancCount < schedule.ancContactsWeeks.length ? { n: ancCount + 1, wk: schedule.ancContactsWeeks[ancCount], on: addDaysISO(c.lmp, schedule.ancContactsWeeks[ancCount] * 7) } : null;
    const visitRows = (rec.visits || []).map(v => ({ at: v.recordedAt || v.createdAt, purpose: v.purpose, signs: v.dangerSigns || [], outcome: v.outcome, notes: v.notes })).concat(mine.filter(r => r.kind === 'visit').map(r => ({ at: r.recordedAt, purpose: r.data.purpose, signs: r.data.dangerSigns || [], outcome: r.data.outcome, notes: r.data.notes, local: true, failed: r.state === 'failed' }))).sort((a, b) => b.at - a.at);
    const refRows = (rec.referrals || []).map(x => ({ at: x.recordedAt || x.createdAt, reason: x.reason, urgency: x.urgency, status: x.status })).concat(mine.filter(r => r.kind === 'referral' || ((r.kind === 'visit' || r.kind === 'anc') && (r.data.dangerSigns || []).length)).map(r => ({ at: r.recordedAt, reason: r.kind === 'referral' ? r.data.reason : T('ref.from_signs', 'Danger signs: {s}', { s: r.data.dangerSigns.map(signLabel).join(', ') }), urgency: r.kind === 'referral' ? r.data.urgency || 'routine' : 'urgent', local: true }))).sort((a, b) => b.at - a.at);
    view(html`<a class="back" href="#/clients">${icon('left')}${T('clients.title', 'Households and people')}</a>
      ${MC.wristband({ name: c.name || (c.firstName + ' ' + c.lastName), dob: c.dob, sex: c.sex })}
      ${offlineNote(res)}
      <div class="page-head"><div><h1>${c.name || (c.firstName + ' ' + c.lastName)}</h1><p>${[c.dob ? ageText(c.dob) : '', c.relationship, c.pregnant ? T('client.pregnant_wk', 'Pregnant{w}', { w: ga != null ? ', ' + T('home.weeks', '{n} weeks pregnant', { n: ga }) : '' }) : ''].filter(Boolean).join(' | ')} ${clientStatus(c)}</p></div>
        <div class="actions"><a class="btn primary" href="#/visit/${rid}">${icon('clipboard')}${T('client.log_visit', 'Log visit')}</a>${c.pregnant || (c.sex === 'female' && !child) ? html`<a class="btn" href="#/anc/${rid}">${icon('heart')}${T('client.anc', 'Antenatal contact')}</a>` : ''}<a class="btn" href="#/refer/${rid}">${icon('ambulance')}${T('client.refer', 'Refer')}</a></div></div>
      ${c.local ? html`<div class="notice warn">${c.failed ? T('client.local_failed', 'This person was not accepted by MediCore yet. Open Sync to fix the record.') : T('client.local', 'Saved on this phone. It will be sent to MediCore when you are online.')}</div>` : ''}
      ${c.status === 'pending_link' ? html`<div class="notice warn">${T('client.link_note', 'This person already has a MediCore record. They got a code by SMS. Ask for it to link their record.')} ${link && link.devCode ? html`<br>${T('client.demo_code', 'Demo mode: the code is {c}', { c: link.devCode })}` : ''}<div class="btn-row"><button class="btn primary" data-action="chw-link" data-id="${c.id}">${icon('key')}${T('client.enter_code', 'Enter code')}</button></div></div>` : ''}
      <div class="grid two">
        <section class="panel"><h2>${T('client.due', 'Due next')}</h2>
          ${nextAnc ? html`<p>${icon('heart')} ${T('client.next_anc', 'Antenatal contact {n} at {w} weeks, due {d}', { n: nextAnc.n, w: nextAnc.wk, d: isoDate(nextAnc.on) })} ${nextAnc.on < t0 ? badge(T('due.overdue', 'Overdue'), 'bad') : ''}</p>` : ''}
          ${card.filter(x => x.state === 'overdue' || x.state === 'due').length ? html`<ul class="list">${card.filter(x => x.state === 'overdue' || x.state === 'due').map(x => html`<li><div class="grow"><span class="title">${x.v.label}</span><span class="sub">${T('client.due_on', 'Due {d}', { d: isoDate(x.due) })}</span></div><span class="end">${x.state === 'overdue' ? badge(T('due.overdue', 'Overdue'), 'bad') : badge(T('due.due', 'Due'), 'warn')} <button class="btn sm" data-action="chw-vax" data-code="${x.v.code}">${T('client.record_given', 'Record given')}</button></span></li>`)}</ul>` : (!nextAnc ? html`<p class="muted">${T('client.nothing_due', 'Nothing due in the next two weeks.')}</p>` : '')}
          ${c.pregnant && !c.lmp ? html`<p class="muted sm">${T('client.need_lmp', 'Record the last period date at the next antenatal contact to see the schedule.')}</p>` : ''}</section>
        <section class="panel"><h2>${T('client.referrals', 'Referrals')}</h2>${refRows.length ? html`<ul class="list">${refRows.map(x => html`<li><div class="grow"><span class="title">${x.reason}</span><span class="sub">${dateTime(x.at)}</span></div><span class="end">${x.urgency === 'urgent' ? badge(T('ref.urgent', 'Urgent'), 'bad') : badge(T('ref.routine', 'Routine'), 'info')} ${x.local ? pendingBadge() : refStatus(x.status)}</span></li>`)}</ul>` : html`<p class="muted">${T('client.no_refs', 'No referrals.')}</p>`}</section>
      </div>
      ${card.length ? html`<section class="panel flush"><h2>${T('client.card', 'Immunisation card')}</h2><div class="table-wrap" style="border:0"><table class="t stack-sm"><thead><tr><th>${T('col.vaccine', 'Vaccine')}</th><th>${T('col.due', 'Due')}</th><th>${T('col.given', 'Given')}</th><th></th></tr></thead><tbody>
        ${card.map(x => html`<tr><td data-label="${T('col.vaccine', 'Vaccine')}"><b>${x.v.label}</b></td><td data-label="${T('col.due', 'Due')}">${x.due ? isoDate(x.due) : '-'}</td><td data-label="${T('col.given', 'Given')}">${x.g ? html`${badge(T('vax.given', 'Given {d}', { d: isoDate(x.g.on) }), 'ok')} ${x.g.local ? pendingBadge() : ''}` : x.state === 'overdue' ? badge(T('due.overdue', 'Overdue'), 'bad') : x.state === 'due' ? badge(T('due.due', 'Due'), 'warn') : html`<span class="muted">${T('vax.later', 'Not yet')}</span>`}</td><td class="num">${x.g ? '' : html`<button class="btn sm" data-action="chw-vax" data-code="${x.v.code}">${T('client.record_given', 'Record given')}</button>`}</td></tr>`)}</tbody></table></div></section>` : ''}
      ${c.pregnant || ancCount ? html`<section class="panel"><h2>${T('client.anc_title', 'Antenatal contacts ({n} of 8)', { n: ancCount })}</h2>${(rec.anc || []).length || mine.some(r => r.kind === 'anc') ? html`<ul class="list">${(rec.anc || []).map(a => ({ on: a.givenOn, wk: a.gestWeeks, bp: a.bpSys ? a.bpSys + '/' + a.bpDia : '', signs: a.dangerSigns || [] })).concat(mine.filter(r => r.kind === 'anc').map(r => ({ on: r.data.givenOn, wk: r.data.gestWeeks, bp: r.data.bpSys ? r.data.bpSys + '/' + (r.data.bpDia || '') : '', signs: r.data.dangerSigns || [], local: true }))).map(a => html`<li><div class="grow"><span class="title">${isoDate(a.on)}${a.wk ? ' | ' + T('home.weeks', '{n} weeks pregnant', { n: a.wk }) : ''}</span><span class="sub">${a.bp ? T('anc.bp_v', 'BP {v}', { v: a.bp }) : ''}${a.signs.length ? ' | ' + a.signs.map(signLabel).join(', ') : ''}</span></div>${a.local ? pendingBadge() : ''}</li>`)}</ul>` : html`<p class="muted">${T('client.no_anc', 'No antenatal contacts recorded yet.')}</p>`}</section>` : ''}
      <section class="panel"><h2>${T('client.visits', 'Visits')}</h2>${visitRows.length ? html`<ul class="list">${visitRows.map(v => html`<li><div class="grow"><span class="title">${dateTime(v.at)} | ${T('purpose.' + (v.purpose || 'routine'), cap(v.purpose || 'routine'))}</span><span class="sub">${v.signs.length ? html`<b class="flag-high">${v.signs.map(signLabel).join(', ')}</b> ` : ''}${v.outcome ? T('outcome.' + v.outcome, cap(v.outcome)) : ''}${v.notes ? ' | ' + v.notes : ''}</span></div>${v.local ? pendingBadge() : ''}</li>`)}</ul>` : html`<p class="muted">${T('client.no_visits', 'No visits yet.')}</p>`}</section>`);

    on('chw-vax', async el => {
      const code = el.dataset.code;
      const r = await dialog({ title: T('vax.title', 'Record {v}', { v: vaccineLabel(code) }), form: true, body: html`
        <div class="field"><label for="vx-d">${T('field.givenOn', 'Date given')}</label><input class="input" id="vx-d" name="givenOn" type="date" required max="${today()}" min="${c.dob || ''}" value="${today()}"></div>
        <div class="field"><label for="vx-b">${T('field.batchNo', 'Batch number (optional)')}</label><input class="input" id="vx-b" name="batchNo" maxlength="40"></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('vax.save', 'Save vaccine'), primary: true }],
        onSubmit: async d => {
          if (!d.givenOn) throw new MC.ApiError(400, { error: T('vax.need_date', 'Enter the date it was given'), details: [{ field: 'givenOn', error: T('reg.required', 'Required') }] });
          const data = Object.assign(await target(rid), { vaccine: code, givenOn: d.givenOn }); if (d.batchNo) data.batchNo = d.batchNo;
          await enqueue('immunization', data, T('kind.immunization', 'Vaccine') + ': ' + vaccineLabel(code) + ', ' + (c.name || c.firstName));
          return true;
        } });
      if (r) { toast(T('vax.saved', '{v} saved', { v: vaccineLabel(code) }), 'ok'); if (navigator.onLine) await syncNow({ auto: true }); MC.render(); }
    });
    on('chw-link', async el => {
      if (!navigator.onLine) return toast(T('client.link_offline', 'Connect to the internet to link this record.'), 'bad');
      const r = await dialog({ title: T('client.enter_code', 'Enter code'), form: true, body: html`<p>${T('client.code_body', 'Ask {name} for the 6-digit code MediCore sent to their phone.', { name: c.firstName || c.name })}</p><div class="field"><label for="lk-c">${T('client.code', '6-digit code')}</label><input class="input" id="lk-c" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('client.link', 'Link record'), primary: true }], onSubmit: d => api.post('/api/chw/clients/' + encodeURIComponent(el.dataset.id) + '/link', { code: d.code }) });
      if (r) { toast(T('client.linked', 'Record linked'), 'ok'); MC.render(); }
    });
  }
  const refStatus = s => (s === 'queued' ? badge(T('ref.queued', 'At the front desk'), 'ok') : s === 'open' ? badge(T('ref.not_at_desk', 'Not at the desk yet'), 'warn') : s ? badge(st(s), 'info') : '');

  /* ================= log visit / ANC / referral ================= */
  async function clientFor(params) {
    const c = await findClient(params.id);
    if (c) return c;
    if (!params.id.startsWith('ref-')) { const r = await store.get(scope(), 'client:' + params.id); if (r) return r.v; }
    return null;
  }
  function referScreen(c, signs, rec, res) {
    const sent = res && res.results && res.results.find(x => x.clientRef === rec.clientRef && x.ok);
    view(html`<div class="panel" style="border:3px solid var(--red);background:var(--red-soft)">
      <h1 style="color:var(--red)">${icon('alert')} ${T('refer.now', 'Refer now')}</h1>
      <p><b>${T('refer.screen', '{name} has a danger sign. Take them to {org} now.', { name: c.name || c.firstName, org: MC.me.org.name })}</b></p>
      <ul>${signs.map(s => html`<li><b>${signLabel(s)}</b></li>`)}</ul>
      <p>${sent ? (sent.referralId ? T('refer.sent', 'The urgent referral is with the front desk.') : T('refer.sent2', 'The visit was sent.')) : T('refer.queued', 'The urgent referral is saved on this phone and goes to the front desk as soon as you are online.')}</p>
      <p class="sm">${T('refer.call_if', 'If they cannot travel or are getting worse, call an ambulance:')}</p>${emergencyCalls()}
      </div><div class="btn-row"><a class="btn primary" href="#/client/${c.id}">${T('refer.back', 'Back to {name}', { name: c.firstName || c.name })}</a><a class="btn" href="#/referrals">${T('nav.referrals', 'Referrals')}</a></div>`);
  }
  const notFoundClient = () => view(empty({ icon: 'users', title: T('client.unavailable', 'Not saved on this phone'), body: T('client.unavailable_sub', 'Open this person once while online to keep their record on this phone.'), action: html`<a class="btn" href="#/clients">${T('clients.title', 'Households and people')}</a>` }));
  async function sendAfterSave(rec) {
    if (!navigator.onLine) return null;
    return Promise.race([syncNow({ auto: true }), new Promise(r => setTimeout(() => r(null), 10000))]);
  }

  async function visitPage({ params, stale }) {
    const c = await clientFor(params); if (stale()) return;
    if (!c) return notFoundClient();
    const kind = kindOf(c); const name = c.name || c.firstName;
    const normal = T('visit.save', 'Save visit'); const refer = T('visit.save_refer', 'Save and refer now');
    view(html`<a class="back" href="#/client/${params.id}">${icon('left')}${name}</a>
      ${MC.wristband({ name, dob: c.dob, sex: c.sex })}
      <div class="page-head"><div><h1>${T('visit.title', 'Log a visit')}</h1><p>${kind === 'pregnancy' ? T('visit.preg', 'Pregnancy danger signs') : kind === 'child' ? T('visit.child', 'Child danger signs') : T('visit.general', 'General danger signs')}</p></div></div>
      <form class="panel" data-form="visit" novalidate>
        <div class="field"><label for="vi-p">${T('field.purpose', 'Reason for visit')}</label><select class="input" id="vi-p" name="purpose">${['routine', 'followup', 'sick', 'newborn', 'postnatal', 'nutrition', 'other'].map(p => html`<option value="${p}">${T('purpose.' + p, cap(p))}</option>`)}</select></div>
        ${signChecks(SIGNS[kind])}
        ${referPanel(name, true)}
        <div class="fields two"><div class="field"><label for="vi-t">${T('field.tempC', 'Temperature (C)')}</label><input class="input" id="vi-t" name="tempC" type="number" step="0.1" min="30" max="45" inputmode="decimal"></div>
        <div class="field"><label for="vi-r">${T('field.respRate', 'Breaths per minute')}</label><input class="input" id="vi-r" name="respRate" type="number" min="5" max="120" inputmode="numeric"></div>
        <div class="field"><label for="vi-w">${T('field.weightKg', 'Weight (kg)')}</label><input class="input" id="vi-w" name="weightKg" type="number" step="0.1" min="0.3" max="300" inputmode="decimal"></div>
        ${kind === 'child' ? html`<div class="field"><label for="vi-m">${T('field.muacCm', 'MUAC (cm)')}</label><input class="input" id="vi-m" name="muacCm" type="number" step="0.1" min="5" max="40" inputmode="decimal"></div>` : ''}</div>
        <div class="field"><label for="vi-o">${T('field.outcome', 'Outcome')}</label><select class="input" id="vi-o" name="outcome">${['ok', 'advised', 'treated', 'referred'].map(o => html`<option value="${o}">${T('outcome.' + o, cap(o))}</option>`)}</select></div>
        <div class="field"><label for="vi-n">${T('field.notes', 'Notes')}</label><textarea class="input" id="vi-n" name="notes" maxlength="1000"></textarea></div>
        <div class="form-err notice bad" hidden></div><button class="btn primary block lg" type="submit" data-normal="${normal}" data-refer="${refer}">${normal}</button></form>`);
    form('visit', async d => {
      const signs = d.dangerSigns || [];
      const data = Object.assign(await target(params.id), { purpose: d.purpose || 'routine' });
      if (signs.length) { data.dangerSigns = signs; data.outcome = 'referred'; } else if (d.outcome) data.outcome = d.outcome;
      ['tempC', 'respRate', 'weightKg', 'muacCm'].forEach(k => { if (d[k] !== undefined && !Number.isNaN(d[k])) data[k] = d[k]; });
      if (d.notes) data.notes = d.notes;
      const rec = await enqueue('visit', data, T('kind.visit', 'Visit') + ': ' + name + (signs.length ? ' (' + T('ref.urgent', 'Urgent') + ')' : ''));
      const res = await sendAfterSave(rec);
      if (signs.length) return referScreen(c, signs, rec, res);
      toast(T('visit.saved', 'Visit saved'), 'ok'); MC.go('#/client/' + params.id);
    });
  }

  async function ancPage({ params, stale }) {
    const c = await clientFor(params); if (stale()) return;
    if (!c) return notFoundClient();
    const name = c.name || c.firstName; const ga = gestWeeks(c.lmp);
    const normal = T('anc.save', 'Save antenatal contact'); const refer = T('visit.save_refer', 'Save and refer now');
    view(html`<a class="back" href="#/client/${params.id}">${icon('left')}${name}</a>
      ${MC.wristband({ name, dob: c.dob, sex: c.sex })}
      <div class="page-head"><div><h1>${T('anc.title', 'Antenatal contact')}</h1><p>${ga != null ? T('home.weeks', '{n} weeks pregnant', { n: ga }) : T('anc.no_lmp', 'Last period date not recorded')}</p></div></div>
      <form class="panel" data-form="anc" novalidate>
        <div class="fields two"><div class="field"><label for="an-d">${T('field.contactDate', 'Date of contact')}</label><input class="input" id="an-d" name="givenOn" type="date" max="${today()}" value="${today()}"></div>
        ${c.lmp ? html`<div class="field"><label for="an-g">${T('field.gestWeeks', 'Weeks pregnant')}</label><input class="input" id="an-g" name="gestWeeks" type="number" min="1" max="45" value="${ga != null && ga > 0 ? ga : ''}"></div>` : html`<div class="field"><label for="an-l">${T('field.lmp', 'First day of last period (LMP)')}</label><input class="input" id="an-l" name="lmp" type="date" max="${today()}"></div>`}</div>
        ${signChecks(SIGNS.pregnancy)}
        ${referPanel(name, true)}
        <div class="fields two"><div class="field"><label for="an-s">${T('field.bpSys', 'Blood pressure, top number')}</label><input class="input" id="an-s" name="bpSys" type="number" min="50" max="260" inputmode="numeric"></div>
        <div class="field"><label for="an-b">${T('field.bpDia', 'Blood pressure, bottom number')}</label><input class="input" id="an-b" name="bpDia" type="number" min="30" max="160" inputmode="numeric"></div>
        <div class="field"><label for="an-w">${T('field.weightKg', 'Weight (kg)')}</label><input class="input" id="an-w" name="weightKg" type="number" step="0.1" min="20" max="300" inputmode="decimal"></div>
        <div class="field"><label for="an-f">${T('field.fundalHeightCm', 'Fundal height (cm)')}</label><input class="input" id="an-f" name="fundalHeightCm" type="number" step="0.5" min="5" max="50" inputmode="decimal"></div>
        <div class="field"><label for="an-i">${T('field.iptpDose', 'IPTp dose number')}</label><input class="input" id="an-i" name="iptpDose" type="number" min="0" max="6" inputmode="numeric"></div>
        <div class="field"><label for="an-n2">${T('field.nextVisitOn', 'Next contact')}</label><input class="input" id="an-n2" name="nextVisitOn" type="date" min="${today()}"></div></div>
        <label class="check"><input type="checkbox" name="ironFolate"><span>${T('field.ironFolate', 'Iron and folic acid given')}</span></label>
        <label class="check"><input type="checkbox" name="llinGiven"><span>${T('field.llinGiven', 'Mosquito net (LLIN) given')}</span></label>
        <div class="field"><label for="an-n">${T('field.notes', 'Notes')}</label><textarea class="input" id="an-n" name="notes" maxlength="1000"></textarea></div>
        <div class="form-err notice bad" hidden></div><button class="btn primary block lg" type="submit" data-normal="${normal}" data-refer="${refer}">${normal}</button></form>`);
    form('anc', async d => {
      const signs = d.dangerSigns || [];
      const data = await target(params.id);
      ['givenOn', 'lmp', 'nextVisitOn', 'notes'].forEach(k => { if (d[k]) data[k] = d[k]; });
      ['gestWeeks', 'bpSys', 'bpDia', 'weightKg', 'fundalHeightCm', 'iptpDose'].forEach(k => { if (d[k] !== undefined && !Number.isNaN(d[k])) data[k] = d[k]; });
      if (d.ironFolate) data.ironFolate = true; if (d.llinGiven) data.llinGiven = true;
      if (signs.length) data.dangerSigns = signs;
      const rec = await enqueue('anc', data, T('kind.anc', 'Antenatal contact') + ': ' + name + (signs.length ? ' (' + T('ref.urgent', 'Urgent') + ')' : ''));
      const res = await sendAfterSave(rec);
      if (signs.length) return referScreen(c, signs, rec, res);
      if (data.bpSys >= 140 || data.bpDia >= 90) toast(T('anc.high_bp', 'Blood pressure is high. Refer her to the clinic for a check.'), 'bad', 8000); else toast(T('anc.saved', 'Antenatal contact saved'), 'ok');
      MC.go('#/client/' + params.id);
    });
  }

  async function referPage({ params, stale }) {
    const c = await clientFor(params); if (stale()) return;
    if (!c) return notFoundClient();
    const name = c.name || c.firstName;
    view(html`<a class="back" href="#/client/${params.id}">${icon('left')}${name}</a>
      ${MC.wristband({ name, dob: c.dob, sex: c.sex })}
      <div class="page-head"><div><h1>${T('refer.title', 'Refer to the health facility')}</h1><p>${MC.me.org.name}</p></div></div>
      <form class="panel" data-form="refer" novalidate>
        <div class="field"><label for="rf-r">${T('field.reason', 'Reason for referral')}</label><textarea class="input" id="rf-r" name="reason" required maxlength="300"></textarea></div>
        <fieldset class="field" style="border:0;padding:0"><legend class="label" style="font-weight:700">${T('field.urgency', 'How urgent?')}</legend>
          <label class="check"><input type="radio" name="urgency" value="routine" checked><span>${T('ref.routine_long', 'Routine: go to the clinic in the next days')}</span></label>
          <label class="check"><input type="radio" name="urgency" value="urgent"><span>${T('ref.urgent_long', 'Urgent: go now')}</span></label></fieldset>
        ${signChecks(SIGNS[kindOf(c)])}${referPanel(name, true)}
        <div class="form-err notice bad" hidden></div><button class="btn primary block lg" type="submit">${T('refer.save', 'Save referral')}</button></form>`);
    form('refer', async d => {
      if (!d.reason) throw new MC.ApiError(400, { error: T('refer.need_reason', 'Say why you are referring them'), details: [{ field: 'reason', error: T('reg.required', 'Required') }] });
      const signs = d.dangerSigns || [];
      const data = Object.assign(await target(params.id), { reason: d.reason, urgency: signs.length ? 'urgent' : (d.urgency || 'routine') });
      if (signs.length) data.dangerSigns = signs;
      const rec = await enqueue('referral', data, T('kind.referral', 'Referral') + ': ' + name);
      const res = await sendAfterSave(rec);
      if (data.urgency === 'urgent') return referScreen(c, signs, rec, res);
      toast(T('refer.saved', 'Referral saved'), 'ok'); MC.go('#/client/' + params.id);
    });
  }

  /* ================= referrals ================= */
  async function referrals({ stale }) {
    let res = null;
    try { res = await cached('/api/chw/referrals', 'referrals'); } catch (e) { if (!e.noCache) throw e; }
    const q = (await pendingList()).filter(r => r.kind === 'referral' || ((r.kind === 'visit' || r.kind === 'anc') && (r.data.dangerSigns || []).length));
    if (stale()) return;
    const list = res ? res.data : [];
    const qs1 = s => (s === 'waiting' ? T('ref.q_waiting', 'Waiting at triage') : s === 'called' ? T('ref.q_called', 'Called in') : s === 'in_service' ? T('ref.q_in', 'Being seen') : s === 'done' ? T('ref.q_done', 'Seen') : s === 'left' ? T('ref.q_left', 'Left without being seen') : st(s));
    view(html`<div class="page-head"><div><h1>${T('nav.referrals', 'Referrals')}</h1><p>${T('ref.sub', 'People you sent to the health facility, and whether they reached the front desk.')}</p></div></div>
      ${res ? offlineNote(res) : html`<div class="notice warn">${T('offline.ref_none', 'Offline and no saved list yet. Only referrals on this phone are shown.')}</div>`}
      ${q.length ? html`<h2>${T('ref.waiting_send', 'Waiting to send')}</h2><div class="list" style="margin-bottom:16px">${q.map(r => html`<a href="#/sync"><div class="grow"><span class="title">${r.label}</span><span class="sub">${dateTime(r.recordedAt)}${r.message ? ' | ' + r.message : ''}</span></div><span class="end">${badge(T('ref.urgent', 'Urgent'), 'bad')} ${r.state === 'failed' ? badge(T('state.failed', 'Needs attention'), 'bad') : pendingBadge()}</span></a>`)}</div>` : ''}
      ${list.length ? html`<div class="list">${list.map(x => html`<a href="#/client/${x.clientId}"><div class="grow"><span class="title">${x.name || ''}</span><span class="sub">${x.reason}</span><span class="sub">${dateTime(x.createdAt)}</span></div><span class="end">${x.urgency === 'urgent' ? badge(T('ref.urgent', 'Urgent'), 'bad') : badge(T('ref.routine', 'Routine'), 'info')}<br>${x.status === 'queued' ? badge(qs1(x.queueStatus || 'waiting'), x.queueStatus === 'done' ? 'ok' : 'info') : refStatus(x.status)}</span></a>`)}</div>`
        : (q.length ? '' : empty({ icon: 'ambulance', title: T('ref.none', 'No referrals yet'), body: T('ref.none_sub', 'When you refer someone, or a visit finds a danger sign, it shows here with its status at the front desk.') }))}`);
  }

  /* ================= sync ================= */
  const FIELDS = { name: 'Household name', address: 'Address', area: 'Area', ward: 'Ward', lga: 'LGA', phone: 'Phone', members: 'People living here', firstName: 'First name', lastName: 'Last name', dob: 'Date of birth', sex: 'Sex', relationship: 'Relationship in household', pregnant: 'Pregnant', lmp: 'First day of last period (LMP)', consent: 'The person agrees to the privacy notice', noKnownAllergies: 'No known allergies',
    purpose: 'Reason for visit', tempC: 'Temperature (C)', muacCm: 'MUAC (cm)', weightKg: 'Weight (kg)', respRate: 'Breaths per minute', notes: 'Notes', outcome: 'Outcome', vaccine: 'Vaccine', givenOn: 'Date given', batchNo: 'Batch number', gestWeeks: 'Weeks pregnant', bpSys: 'Blood pressure, top number', bpDia: 'Blood pressure, bottom number', fundalHeightCm: 'Fundal height (cm)', ironFolate: 'Iron and folic acid given', iptpDose: 'IPTp dose number', llinGiven: 'Mosquito net (LLIN) given', nextVisitOn: 'Next contact', reason: 'Reason for referral', urgency: 'How urgent?' };
  const DATES = ['dob', 'lmp', 'givenOn', 'nextVisitOn']; const NUMS = ['members', 'tempC', 'muacCm', 'weightKg', 'respRate', 'gestWeeks', 'bpSys', 'bpDia', 'fundalHeightCm', 'iptpDose'];
  const ENUMS = { sex: ['female', 'male', 'other', 'unknown'], purpose: ['routine', 'followup', 'sick', 'newborn', 'postnatal', 'nutrition', 'other'], outcome: ['ok', 'advised', 'treated', 'referred'], urgency: ['routine', 'urgent'] };
  const BOOLS = ['pregnant', 'consent', 'noKnownAllergies', 'ironFolate', 'llinGiven'];
  const editable = kind => ({ household: ['name', 'address', 'area', 'ward', 'lga', 'phone', 'members'], client: ['firstName', 'lastName', 'sex', 'dob', 'phone', 'relationship', 'pregnant', 'lmp', 'noKnownAllergies', 'consent'], visit: ['purpose', 'tempC', 'respRate', 'weightKg', 'muacCm', 'outcome', 'notes'], immunization: ['givenOn', 'batchNo'], anc: ['givenOn', 'lmp', 'gestWeeks', 'bpSys', 'bpDia', 'weightKg', 'fundalHeightCm', 'iptpDose', 'nextVisitOn', 'ironFolate', 'llinGiven', 'notes'], referral: ['reason', 'urgency'] }[kind] || []);
  const fieldLabel = k => T('field.' + k, FIELDS[k] || cap(k));
  function editField(k, v, bad) {
    const idf = 'ed-' + k; const errLine = bad ? html`<div class="err">${bad}</div>` : '';
    if (BOOLS.includes(k)) return html`<label class="check"><input type="checkbox" name="${k}" ${v ? 'checked' : ''}><span>${fieldLabel(k)}</span></label>${errLine}`;
    if (ENUMS[k]) return html`<div class="field"><label for="${idf}">${fieldLabel(k)}</label><select class="input" id="${idf}" name="${k}" ${bad ? MC.raw('aria-invalid="true"') : ''}>${ENUMS[k].map(o => html`<option value="${o}" ${v === o ? 'selected' : ''}>${T((k === 'sex' ? 'sex.' : k === 'urgency' ? 'urg.' : k + '.') + o, cap(o))}</option>`)}</select>${errLine}</div>`;
    if (k === 'notes' || k === 'reason') return html`<div class="field"><label for="${idf}">${fieldLabel(k)}</label><textarea class="input" id="${idf}" name="${k}" ${bad ? MC.raw('aria-invalid="true"') : ''}>${v || ''}</textarea>${errLine}</div>`;
    return html`<div class="field"><label for="${idf}">${fieldLabel(k)}</label><input class="input" id="${idf}" name="${k}" type="${DATES.includes(k) ? 'date' : NUMS.includes(k) ? 'number' : 'text'}" ${NUMS.includes(k) ? MC.raw('step="any"') : ''} value="${v == null ? '' : v}" ${bad ? MC.raw('aria-invalid="true"') : ''}>${errLine}</div>`;
  }
  async function syncPage({ stale }) {
    const q = await pendingList(); const ls = await lastSync();
    if (stale()) return;
    const failed = q.filter(r => r.state === 'failed');
    const resLabel = x => (x.ok ? (x.status === 'existing' ? T('res.existing', 'Already saved (not added twice)') : x.status === 'link_requested' ? T('res.link', 'Saved. This person already has a record: ask for their SMS code') : x.referralId ? T('res.referred', 'Saved, urgent referral sent') : T('res.created', 'Saved')) : (x.message || T('res.failed', 'Not saved')));
    view(html`<div class="page-head"><div><h1>${T('sync.title', 'Sync')}</h1><p><span data-pending-count>${q.length}</span> ${T('sync.waiting', 'records waiting on this phone')}</p></div>
      <div class="actions"><button class="btn primary" data-action="chw-sync-all">${icon('refresh')}${T('sync.now', 'Sync now')}</button></div></div>
      ${!navigator.onLine ? html`<div class="notice warn">${T('sync.offline_note', 'You are offline. Records stay safely on this phone until you reconnect.')}</div>` : ''}
      ${needClock ? html`<div class="notice warn">${T('sync.clock_note', 'You are not clocked in. Clock in with the button at the top to send your records.')}</div>` : ''}
      ${failed.length ? html`<div class="notice bad">${T('sync.failed_note', '{n} records were not accepted. Fix them and send again. They are never deleted unless you discard them.', { n: failed.length })}</div>` : ''}
      <section style="margin-bottom:24px"><h2>${T('sync.on_phone', 'On this phone')}</h2>${q.length ? html`<ul class="list">${q.map(r => html`<li><div class="grow"><span class="title">${r.label}</span><span class="sub">${T('sync.recorded', 'Recorded {t}', { t: dateTime(r.recordedAt) })}${r.lat != null ? ' | ' + T('sync.with_gps', 'with location') : ''}</span>${r.message ? html`<span class="sub" style="color:var(--red)"><b>${r.message}</b>${r.details ? html`: ${r.details.map(x => fieldLabel(String(x.field || '').split('.')[0]) + ' ' + x.error).join('; ')}` : ''}</span>` : ''}</div>
        <span class="end">${r.state === 'failed' ? badge(T('state.failed', 'Needs attention'), 'bad') : badge(r.error ? T('state.retry', 'Will try again') : T('state.waiting', 'Waiting'), 'warn')}${r.state === 'failed' ? html`<br><span class="row wrap" style="justify-content:flex-end;gap:4px;margin-top:4px"><button class="btn sm" data-action="chw-edit" data-id="${r.clientRef}">${icon('edit')}${T('sync.fix', 'Fix')}</button><button class="btn sm" data-action="chw-discard" data-id="${r.clientRef}" aria-label="${T('sync.discard_l', 'Discard {r}', { r: r.label })}">${icon('trash')}</button></span>` : ''}</span></li>`)}</ul>`
        : empty({ icon: 'check', title: T('sync.empty', 'Nothing waiting'), body: T('sync.empty_sub', 'Everything recorded on this phone has been sent to MediCore.') })}</section>
      ${ls ? html`<section><h2>${T('sync.last', 'Last sync, {t}', { t: dateTime(ls.at) })}</h2><ul class="list">${ls.results.map(x => html`<li><div class="grow"><span class="title">${x.label || kindLabel(x.kind)}</span><span class="sub">${resLabel(x)}${x.devCode ? ' | ' + T('client.demo_code', 'Demo mode: the code is {c}', { c: x.devCode }) : ''}</span></div>${x.ok ? badge(x.status === 'existing' ? T('res.existing_s', 'Already saved') : T('res.ok', 'Sent'), 'ok') : badge(T('state.failed', 'Needs attention'), 'bad')}</li>`)}</ul></section>` : ''}
      <p style="margin-top:16px"><a href="#/me">${icon('user')} ${T('home.profile', 'My profile')}</a></p>`);
    on('chw-sync-all', async () => { await syncAndReport({ all: true }); MC.render(); });
    on('chw-discard', async el => {
      const r = q.find(x => x.clientRef === el.dataset.id); if (!r) return;
      if (!(await confirm({ title: T('sync.discard_q', 'Discard this record?'), body: T('sync.discard_body', '"{r}" will be deleted from this phone and never sent. This cannot be undone.', { r: r.label }), ok: T('sync.discard', 'Discard record'), danger: true }))) return;
      await store.del(scope(), r.clientRef); await updatePending(); toast(T('sync.discarded', 'Record discarded'), 'ok'); MC.render();
    });
    on('chw-edit', async el => {
      const r = q.find(x => x.clientRef === el.dataset.id); if (!r) return;
      const badFields = Object.fromEntries((r.details || []).map(x => [String(x.field || '').split('.')[0], x.error]));
      const keys = editable(r.kind);
      const res = await dialog({ title: T('sync.fix_title', 'Fix: {r}', { r: r.label }), form: true, body: html`${r.message ? html`<div class="notice bad">${r.message}</div>` : ''}${keys.map(k => editField(k, r.data[k], badFields[k]))}${r.data.dangerSigns ? signChecks(SIGNS.general.concat(SIGNS.pregnancy, SIGNS.child).filter((v, i, a) => a.indexOf(v) === i), r.data.dangerSigns) : ''}`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('sync.save_send', 'Save and send again'), primary: true }],
        onSubmit: async d => {
          const data = Object.assign({}, r.data);
          keys.forEach(k => { const v = d[k]; if (v === undefined || v === '' || v === false || (typeof v === 'number' && Number.isNaN(v))) delete data[k]; else data[k] = v; });
          if (r.kind === 'client' && !data.consent) throw new MC.ApiError(400, { error: T('reg.need_consent', 'The person must agree to the privacy notice before you register them') });
          if (r.data.dangerSigns) { if ((d.dangerSigns || []).length) data.dangerSigns = d.dangerSigns; else delete data.dangerSigns; }
          await store.put(Object.assign({}, r, { data, state: 'pending', error: null, message: null, details: null }));
          return true;
        } });
      if (res) { toast(T('sync.fixed', 'Record updated'), 'ok'); if (navigator.onLine) await syncAndReport({ all: false }); MC.render(); }
    });
  }

  /* ================= profile ================= */
  async function profile({ me, stale }) {
    const q = await pendingList(); const ls = await lastSync();
    let shift = null; try { shift = await api.get('/api/shift/me'); } catch (e) { shift = null; }
    if (stale()) return;
    view(html`<div class="page-head"><div><h1>${T('me.title', 'My profile')}</h1><p>${me.roleLabel} | ${me.org.name}</p></div></div>
      <section class="panel"><dl class="kv"><dt>${T('me.name', 'Name')}</dt><dd><b>${me.user.name}</b></dd>${me.user.email ? html`<dt>${T('me.email', 'Email')}</dt><dd>${me.user.email}</dd>` : ''}${me.user.phone ? html`<dt>${T('field.phone', 'Phone')}</dt><dd>${me.user.phone}</dd>` : ''}
        <dt>${T('me.shift', 'Shift')}</dt><dd>${shift ? (shift.open ? badge(T('me.on_shift', 'On shift since {t}', { t: MC.time(shift.open.in) }), 'ok') : badge(T('me.off_shift', 'Not clocked in'), 'warn')) : html`<span class="muted">${T('me.shift_unknown', 'Unknown while offline')}</span>`}</dd>
        <dt>${T('me.pending', 'Waiting to send')}</dt><dd><span data-pending-count>${q.length}</span></dd>
        <dt>${T('me.last_sync', 'Last sync')}</dt><dd>${ls ? dateTime(ls.at) : T('me.never', 'Not yet')}</dd>
        <dt>${T('me.storage', 'Saved on')}</dt><dd>${useLS ? T('me.ls', 'This phone (basic storage)') : T('me.idb', 'This phone')}</dd></dl>
        <div class="btn-row"><button class="btn primary" data-action="chw-sync">${icon('refresh')}${T('sync.now', 'Sync now')}</button><a class="btn" href="#/sync">${T('home.see_queue', 'See records')}</a><button class="btn" data-action="chw-signout">${icon('logout')}${T('me.signout', 'Sign out')}</button></div></section>
      <section class="panel"><h2>${T('me.privacy', 'Privacy on this phone')}</h2><p class="sm">${T('me.privacy_text', 'Records you make offline are kept only for your account on this phone and are removed from it once MediCore has them. Another health worker signing in here cannot see them.')}</p></section>`);
    on('chw-signout', async () => {
      if (!navigator.onLine) return toast(T('me.signout_offline', 'Connect to the internet to sign out.'), 'bad');
      const n = (await pendingList()).length;
      if (!(await confirm({ title: T('me.signout_q', 'Sign out?'), body: n ? T('me.signout_pending', 'You have {n} records not sent yet. They stay on this phone for your account and are sent the next time you sign in.', { n }) : T('me.signout_body', 'You will need your password to sign in again.'), ok: T('me.signout', 'Sign out'), danger: !!n }))) return;
      try { await api.post('/api/auth/logout'); } catch (e) { /* signed out locally anyway */ }
      lsDel(ME_KEY); location.hash = ''; location.reload();
    });
  }

  on('chw-sync', async () => { await syncAndReport({ all: true }); MC.render(); });

  /* every data route: offline-safe wrapper (no cache yet -> clear empty state) */
  const safe = fn => async ctx => { try { await fn(ctx); } catch (e) { if (offlineEmpty(e)) return; throw e; } finally { if (!ctx.stale()) updatePending(); } };

  MC.boot({
    title: 'MediCore Community', home: '#/',
    nav: [
      { href: '#/', label: T('nav.home', 'Today'), icon: 'home', perm: 'chw.field' },
      { href: '#/clients', label: T('nav.clients', 'Households'), short: T('nav.clients_s', 'People'), icon: 'users', perm: 'chw.field' },
      { href: '#/register', label: T('nav.register', 'Register'), icon: 'plus', perm: 'chw.field' },
      { href: '#/referrals', label: T('nav.referrals', 'Referrals'), icon: 'ambulance', perm: 'chw.field' },
      { href: '#/sync', label: T('nav.sync', 'Sync'), icon: 'refresh', perm: 'chw.field' },
      { href: '#/me', label: T('nav.me', 'My profile'), icon: 'user', perm: 'chw.field', sideOnly: true },
    ],
    routes: { '#/': safe(home), '#/clients': safe(clients), '#/register': safe(registerPerson), '#/register/household': safe(registerHousehold), '#/client/:id': safe(clientPage), '#/visit/:id': safe(visitPage), '#/anc/:id': safe(ancPage), '#/refer/:id': safe(referPage), '#/referrals': safe(referrals), '#/sync': safe(syncPage), '#/me': safe(profile) },
    onReady: async () => { await loadSchedule(); await updatePending(); if (navigator.onLine && !startedOffline) autoSync(); },
  });

  /* the kit's offline bar says changes will not be saved; in this app they are saved on the phone */
  const fixBar = () => { const b = document.getElementById('mc-offline'); if (b) b.textContent = T('offline.bar', 'You are offline. New records are saved on this phone and sent when you reconnect.'); };
  fixBar();
  window.addEventListener('offline', () => { fixBar(); if (/^#\/($|\?)/.test(location.hash || '#/') && MC.me) MC.render(); });
  window.addEventListener('online', () => { startedOffline = false; if (MC.me) { MC.refreshShift(); loadSchedule(); } autoSync(); });
  MC.onEvent('shift:changed', s => { if (s && s.open) { needClock = false; autoSync(); } });
})();
