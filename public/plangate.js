/* MediCore plan gate: locks an app if the hospital's subscription doesn't include it
 * (or the subscription is suspended). Reads /api/me/hospital and overlays a lock. */
(function (g) {
  var LABEL = { lab: 'Laboratory', pharmacy: 'Pharmacy & delivery', ambulance: 'Emergency & dispatch', chw: 'Community health' };
  async function mount(opts) {
    if (!opts || !opts.token) return;
    try { if (g.__MC_NOGATE || localStorage.getItem('mc:nogate') === '1') return; } catch (e) {}
    var hosp;
    try {
      var r = await fetch((opts.api || '') + '/api/me/hospital', { headers: { Authorization: 'Bearer ' + opts.token } });
      if (!r.ok) return; hosp = await r.json();
    } catch (e) { return; }
    var sub = hosp.subscription || {};
    var modOff = hosp.modules && hosp.modules[opts.module] === false;
    if (!modOff && sub.status !== 'suspended') return;
    if (document.getElementById('mcPlanGate')) return;
    var d = document.createElement('div'); d.id = 'mcPlanGate';
    d.style.cssText = 'position:fixed;inset:0;z-index:2147482000;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#0C2A2E,#15707A);color:#fff;padding:24px;text-align:center;font-family:inherit';
    var msg = sub.status === 'suspended'
      ? 'Your hospital\u2019s MediCore subscription is suspended.'
      : ('The ' + (LABEL[opts.module] || opts.module) + ' app is not part of your plan' + (sub.tier ? ' (' + sub.tier + ')' : '') + '.');
    d.innerHTML = '<div style="max-width:360px"><div style="font-size:2.6rem">\uD83D\uDD12</div>'
      + '<div style="font-size:1.35rem;font-weight:800;margin:8px 0">Not in your plan</div>'
      + '<div style="opacity:.92;margin-bottom:20px;line-height:1.5">' + msg + ' Ask your hospital admin to upgrade with MediCore.</div>'
      + '<button onclick="location.href=\'/register.html\'" style="background:#E9B23C;color:#3a2a06;border:none;border-radius:12px;padding:13px 20px;font-weight:800;cursor:pointer">See plans</button></div>';
    document.body.appendChild(d);
  }
  g.mcPlanGate = { mount: mount };
})(window);
