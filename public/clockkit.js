/* ============================================================================
 * MediCore ClockKit  -  a shared, drop-in clock-in + profile widget.
 * Any staff app includes <script src="/clockkit.js"></script> and gets a
 * floating shift chip: clock in (captures time + geolocation, geofenced on-site),
 * a profile/shift panel, on-duty view for managers, and accent customization.
 * It finds the app's own auth token, so no per-app wiring beyond the one tag.
 * Excludes the patient app (patients do not clock in).
 * ==========================================================================*/
(function () {
  var KEYS = ['mcd:token', 'mclab:token', 'mcpharm:token', 'mcadmin:token', 'mcpayer:token', 'mcrider:token', 'mcdispatch:token', 'mccrew:token', 'mcchw:token'];
  var token = null;
  for (var i = 0; i < KEYS.length; i++) { try { var t = localStorage.getItem(KEYS[i]); if (t) { token = t; break; } } catch (e) {} }
  if (!token) return; // not signed in, or an app we don't manage

  function api(path, method, body) {
    return fetch(path, { method: method || 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); });
  }
  var ACCENTS = ['#15707A', '#1E6FB5', '#7A4FD6', '#C0392B', '#0E8A6A', '#B5651D'];
  try { var a = localStorage.getItem('mc-accent'); if (a) document.documentElement.style.setProperty('--teal', a); } catch (e) {}

  var who = null, shift = null, mounted = false;
  function fmtMin(m) { return m < 60 ? (m + 'm') : (Math.floor(m / 60) + 'h ' + (m % 60) + 'm'); }
  function since(ts) { return fmtMin(Math.round((Date.now() - ts) / 60000)) + ' ago'; }

  var css = '\
  #mc-ck-chip{position:fixed;right:14px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:9000;display:flex;align-items:center;gap:7px;padding:9px 13px;border-radius:999px;font:600 13px/1 Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.18);border:none}\
  #mc-ck-chip.in{background:var(--surface,#fff);color:var(--ink,#0C2A2E);border:1px solid var(--line,#E4EBEB)}\
  #mc-ck-chip.out{background:var(--gold,#E9B23C);color:#3a2a06}\
  #mc-ck-chip .d{width:8px;height:8px;border-radius:50%;background:#15A88A}\
  #mc-ck-chip .d.off{background:#E9B23C}\
  #mc-ck-scrim{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9001;opacity:0;pointer-events:none;transition:opacity .2s}\
  #mc-ck-scrim.on{opacity:1;pointer-events:auto}\
  #mc-ck-sheet{position:fixed;left:0;right:0;bottom:0;z-index:9002;max-width:520px;margin:0 auto;background:var(--surface,#fff);color:var(--ink,#0C2A2E);border-radius:22px 22px 0 0;padding:20px 20px calc(24px + env(safe-area-inset-bottom));transform:translateY(100%);transition:transform .26s cubic-bezier(.2,.8,.2,1);font-family:Inter,system-ui,sans-serif;max-height:86vh;overflow:auto}\
  #mc-ck-sheet.on{transform:translateY(0)}\
  #mc-ck-sheet .g{width:38px;height:4px;border-radius:2px;background:var(--line,#E4EBEB);margin:0 auto 14px}\
  #mc-ck-sheet .av{width:52px;height:52px;border-radius:15px;background:var(--teal-soft,#DCECEC);color:var(--teal,#15707A);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1.1rem}\
  #mc-ck-sheet .mut{color:var(--muted,#5E7678);font-size:.85rem}\
  #mc-ck-sheet .card{border:1px solid var(--line,#E4EBEB);border-radius:14px;padding:14px;margin-top:12px}\
  #mc-ck-sheet .b{border:none;border-radius:12px;padding:12px 16px;font-weight:700;font-size:.92rem;cursor:pointer;width:100%;font-family:inherit}\
  #mc-ck-sheet .prim{background:var(--teal,#15707A);color:#fff}\
  #mc-ck-sheet .coral{background:var(--coral,#DF5039);color:#fff}\
  #mc-ck-sheet .line{background:var(--surface,#fff);border:1px solid var(--line,#E4EBEB);color:var(--ink,#0C2A2E)}\
  #mc-ck-sheet .sw{width:30px;height:30px;border-radius:9px;cursor:pointer;border:2px solid transparent;display:inline-block}\
  #mc-ck-sheet .pill{padding:4px 10px;border-radius:999px;font-size:.72rem;font-weight:700}\
  ';
  var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  var chip = document.createElement('button'); chip.id = 'mc-ck-chip';
  var scrim = document.createElement('div'); scrim.id = 'mc-ck-scrim'; scrim.onclick = closeSheet;
  var sheet = document.createElement('div'); sheet.id = 'mc-ck-sheet';
  function ready() { document.body.appendChild(chip); document.body.appendChild(scrim); document.body.appendChild(sheet); mounted = true; refresh(); }
  if (document.body) ready(); else document.addEventListener('DOMContentLoaded', ready);

  function refresh() {
    Promise.all([api('/api/whoami').catch(function () { return null; }), api('/api/shift/me').catch(function () { return { open: null, todayMinutes: 0 }; })])
      .then(function (r) { who = r[0]; shift = r[1]; if (!who) { chip.style.display = 'none'; return; } renderChip(); });
  }
  function renderChip() {
    var open = shift && shift.open;
    if (open) { chip.className = 'in'; chip.innerHTML = '<span class="d ' + (open.onSite === false ? 'off' : '') + '"></span>' + (open.onSite === false ? 'Off-site' : 'On') + ' \u00b7 ' + fmtMin(open.minutes); }
    else { chip.className = 'out'; chip.innerHTML = '\u23f1 Clock in'; }
    chip.style.display = 'flex';
    chip.onclick = openSheet;
  }
  function openSheet() { renderSheet(); sheet.classList.add('on'); scrim.classList.add('on'); }
  function closeSheet() { sheet.classList.remove('on'); scrim.classList.remove('on'); }

  function renderSheet() {
    var open = shift && shift.open;
    var sched = shift && shift.todaySchedule;
    var punc = open && open.punctuality;
    var puncPill = punc ? '<span class="pill" style="margin-left:6px;background:' + (punc === 'late' ? '#FBE3DE' : '#DBF4EC') + ';color:' + (punc === 'late' ? '#b23a22' : '#0d7a5f') + '">' + (punc === 'late' ? ('Late ' + (open.lateMinutes > 0 ? open.lateMinutes + 'm' : '') ) : 'On time') + '</span>' : '';
    var schedLine = sched ? '<div class="mut" style="margin-top:4px">Rostered ' + sched.start + '\u2013' + sched.end + (sched.duty ? (' \u00b7 ' + sched.duty) : '') + '</div>' : '';
    var initials = (who.name || '').split(' ').filter(Boolean).slice(0, 2).map(function (x) { return x[0]; }).join('').toUpperCase();
    var accent = '';
    try { accent = getComputedStyle(document.documentElement).getPropertyValue('--teal').trim(); } catch (e) {}
    var swatches = ACCENTS.map(function (c) { return '<span class="sw" style="background:' + c + ';border-color:' + (accent === c ? 'var(--ink,#0C2A2E)' : 'transparent') + '" onclick="__mcck.accent(\'' + c + '\')"></span>'; }).join(' ');
    sheet.innerHTML = '<div class="g"></div>' +
      '<div style="display:flex;align-items:center;gap:12px"><div class="av">' + initials + '</div><div><div style="font-weight:800">' + who.name + '</div><div class="mut">' + who.roleLabel + ' \u00b7 ' + who.hospital + '</div></div></div>' +
      '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><div><div class="mut">Shift</div><div style="font-weight:700">' + (open ? ('Clocked in ' + since(open.clockIn)) : 'Not clocked in') + '</div></div>' +
        (open ? '<span class="pill" style="background:' + (open.onSite === false ? 'var(--gold-soft,#FBEFD3)' : '#DBF4EC') + ';color:' + (open.onSite === false ? '#8a6b12' : '#0d7a5f') + '">' + (open.onSite === false ? 'Off-site' : 'On-site') + '</span>' + puncPill : '') + '</div>' +
        schedLine +
        '<div class="mut" style="margin-top:6px">Today: ' + fmtMin((shift && shift.todayMinutes) || 0) + ' worked</div>' +
        (open ? '<button class="b coral" style="margin-top:12px" onclick="__mcck.out()">Clock out</button>' : '<button class="b prim" style="margin-top:12px" onclick="__mcck.in()">Clock in now</button>') +
      '</div>' +
      (who.canSeeOnDuty ? '<div class="card" id="mc-ck-onduty"><div class="mut">On duty now</div><div style="margin-top:6px" class="mut">Loading...</div></div>' : '') +
      '<div class="card"><div style="font-weight:700;margin-bottom:8px">Accent colour</div>' + swatches + '</div>';
    if (who.canSeeOnDuty) loadOnDuty();
  }
  function loadOnDuty() {
    api('/api/shift/onduty').then(function (list) {
      var el = document.getElementById('mc-ck-onduty'); if (!el) return;
      el.innerHTML = '<div class="mut">On duty now (' + list.length + ')</div>' + list.map(function (s) {
        return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line,#eee)"><div><div style="font-weight:600">' + s.name + '</div><div class="mut">' + s.role + ' \u00b7 in ' + since(s.clockIn) + '</div></div><span class="pill" style="background:' + (s.onSite === false ? 'var(--gold-soft,#FBEFD3)' : '#DBF4EC') + ';color:' + (s.onSite === false ? '#8a6b12' : '#0d7a5f') + '">' + (s.onSite === false ? 'off-site' : 'on-site') + '</span></div>';
      }).join('') || '<div class="mut">No one else clocked in.</div>';
    }).catch(function () {});
  }

  window.__mcck = {
    in: function () {
      var go = function (lat, lng, acc) { api('/api/shift/clockin', 'POST', { lat: lat, lng: lng, accuracy: acc }).then(function () { return refresh(); }).then(function () { renderSheet(); }).catch(function () {}); };
      if (navigator.geolocation) navigator.geolocation.getCurrentPosition(function (p) { go(p.coords.latitude, p.coords.longitude, Math.round(p.coords.accuracy)); }, function () { go(null, null, null); }, { timeout: 8000 });
      else go(null, null, null);
    },
    out: function () { api('/api/shift/clockout', 'POST').then(function () { return refresh(); }).then(function () { closeSheet(); }).catch(function () {}); },
    accent: function (c) { document.documentElement.style.setProperty('--teal', c); try { localStorage.setItem('mc-accent', c); } catch (e) {} renderSheet(); },
  };
})();
