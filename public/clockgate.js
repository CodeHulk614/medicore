/* MediCore clock-in gate.
 * A staff member who has not clocked in cannot use their app: a full-screen
 * overlay covers everything with a single Clock in action. Once on the clock,
 * the app unlocks; if they clock out, the gate returns on the next check. */
(function (g) {
  var G = { api: '', token: '', role: '', onIn: null, el: null, timer: null, mounted: false };
  var LABEL = { pharmacy: 'Pharmacy', lab: 'Laboratory', frontdesk: 'Front office', dispatch: 'Dispatch', rider: 'Deliveries', chw: 'Community health', doctor: 'Clinic', crew: 'Ambulance' };

  function ensureEl() {
    if (G.el) return G.el;
    var d = document.createElement('div');
    d.id = 'mcClockGate';
    d.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;background:linear-gradient(160deg,#0C2A2E,#15707A);color:#fff;padding:24px;text-align:center;font-family:inherit';
    d.innerHTML = '<div style="max-width:360px;width:100%">'
      + '<div style="font-size:2.6rem;margin-bottom:6px">\u23F1\uFE0F</div>'
      + '<div style="font-size:1.4rem;font-weight:800">You\u2019re clocked out</div>'
      + '<div id="mcGateSub" style="opacity:.92;margin:10px 0 22px;font-size:.95rem;line-height:1.5">Clock in to start your shift. Your app stays locked until you\u2019re on the clock, and your time is recorded for attendance.</div>'
      + '<button id="mcGateBtn" style="width:100%;padding:15px;border:none;border-radius:14px;background:#E9B23C;color:#3a2a06;font-weight:800;font-size:1rem;cursor:pointer">Clock in</button>'
      + '<div id="mcGateMsg" style="opacity:.9;margin-top:12px;font-size:.85rem;min-height:1em"></div>'
      + '<button id="mcGateLogout" style="margin-top:16px;background:none;border:none;color:rgba(255,255,255,.72);text-decoration:underline;cursor:pointer;font-size:.85rem">Log out</button>'
      + '</div>';
    document.body.appendChild(d); G.el = d;
    d.querySelector('#mcGateBtn').onclick = clockIn;
    d.querySelector('#mcGateLogout').onclick = function () { try { if (typeof g.logout === 'function') return g.logout(); } catch (e) {} try { localStorage.clear(); } catch (e) {} location.reload(); };
    return d;
  }
  function show() { var e = ensureEl(); if (G.role && LABEL[G.role]) e.querySelector('#mcGateSub') && (e.querySelector('#mcGateBtn').textContent = 'Clock in \u2014 ' + LABEL[G.role]); e.style.display = 'flex'; }
  function hide() { if (G.el) G.el.style.display = 'none'; }

  async function fetchShift() {
    try {
      var r = await fetch(G.api + '/api/shift/me', { headers: { Authorization: 'Bearer ' + G.token } });
      if (!r.ok) return { open: true, _err: true }; // never lock someone out on a fetch error
      return await r.json();
    } catch (e) { return { open: true, _err: true }; }
  }
  function isOpen(shift) { return !!(shift && shift.open); }

  function clockIn() {
    var btn = G.el.querySelector('#mcGateBtn'), msg = G.el.querySelector('#mcGateMsg');
    btn.disabled = true; var was = btn.textContent; btn.textContent = 'Clocking in\u2026'; msg.textContent = '';
    var send = function (coords) {
      fetch(G.api + '/api/shift/clockin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + G.token }, body: JSON.stringify(coords || {}) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not clock in'); return j; }); })
        .then(function () { hide(); if (typeof G.onIn === 'function') { try { G.onIn(); } catch (e) {} } })
        .catch(function (e) { msg.textContent = e.message; btn.disabled = false; btn.textContent = was; });
    };
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition(function (p) { send({ lat: p.coords.latitude, lng: p.coords.longitude }); }, function () { send({}); }, { timeout: 4000, maximumAge: 60000 });
    else send({});
  }

  async function check() {
    if (!G.token) return true;
    var shift = await fetchShift();
    if (isOpen(shift)) { hide(); return true; }
    show(); return false;
  }
  function mount(opts) {
    G.api = opts.api || ''; G.token = opts.token; G.role = opts.role; G.onIn = opts.onIn || null;
    if (!G.token) return;
    try { if (window.__MC_NOGATE || localStorage.getItem('mc:nogate') === '1') return; } catch (e) {}
    ensureEl(); check();
    if (!G.timer) G.timer = setInterval(check, 10000);
    G.mounted = true;
  }
  g.mcClockGate = { mount: mount, check: check, isOpen: isOpen, hide: hide };
})(window);
