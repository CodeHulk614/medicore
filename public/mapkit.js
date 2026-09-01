/* ============================================================================
 * MediCore MapKit  -  one map module for dispatch, crew and patient tracking.
 * Real OpenStreetMap street tiles (Leaflet) + a road-following route polyline,
 * with IN-PLACE marker updates so the map animates without the page refreshing.
 * Falls back to a self-contained SVG schematic when offline. No API key needed.
 * ==========================================================================*/
(function (global) {
  var LEAFLET_JS = '/vendor/leaflet/leaflet.js';
  var LEAFLET_CSS = '/vendor/leaflet/leaflet.css';
  // critical Leaflet layout CSS, inlined so tiles position correctly even if the CDN stylesheet is slow or blocked
  var CRITICAL_CSS = '.leaflet-container{position:relative;overflow:hidden;background:#e7ecec;-webkit-tap-highlight-color:transparent;outline:0}'
    + '.leaflet-pane,.leaflet-tile,.leaflet-marker-icon,.leaflet-marker-shadow,.leaflet-tile-container,.leaflet-pane>svg,.leaflet-pane>canvas,.leaflet-zoom-box,.leaflet-image-layer,.leaflet-layer{position:absolute;left:0;top:0}'
    + '.leaflet-tile{width:256px;height:256px;visibility:hidden}.leaflet-tile-loaded{visibility:inherit}'
    + '.leaflet-pane{z-index:400}.leaflet-tile-pane{z-index:200}.leaflet-overlay-pane{z-index:400}.leaflet-shadow-pane{z-index:500}.leaflet-marker-pane{z-index:600}.leaflet-tooltip-pane{z-index:650}.leaflet-popup-pane{z-index:700}'
    + '.leaflet-zoom-animated{transform-origin:0 0}.leaflet-fade-anim .leaflet-tile{will-change:opacity}'
    + '.leaflet-control-container{position:absolute;z-index:800;pointer-events:none}.leaflet-top,.leaflet-bottom{position:absolute;z-index:1000;pointer-events:none}.leaflet-top{top:0}.leaflet-bottom{bottom:0}.leaflet-left{left:0}.leaflet-right{right:0}'
    + '.leaflet-control{position:relative;pointer-events:auto;float:left;clear:both;margin:10px}.leaflet-right .leaflet-control{float:right}'
    + '.leaflet-bar{box-shadow:0 1px 5px rgba(0,0,0,.4);border-radius:6px;overflow:hidden}.leaflet-bar a{background:#fff;width:30px;height:30px;line-height:30px;display:block;text-align:center;text-decoration:none;color:#222;font:700 18px sans-serif;border-bottom:1px solid #ddd}.leaflet-bar a:last-child{border-bottom:none}'
    + '.leaflet-control-attribution{background:rgba(255,255,255,.75);padding:0 5px;font-size:10px;color:#333}.leaflet-control-attribution a{color:#0a7}'
    + '.leaflet-grab{cursor:grab;cursor:-webkit-grab}.leaflet-dragging .leaflet-grab,.leaflet-dragging .leaflet-grab .leaflet-interactive{cursor:grabbing;cursor:-webkit-grabbing}.leaflet-interactive{cursor:pointer}'
    + '.leaflet-touch .leaflet-bar a{width:34px;height:34px;line-height:34px}';
  function patchLeaflet(L) {
    if (!L || L.__mcPatched) return;
    L.__mcPatched = true;
    // (a) null-safe public helper (covers any external/plugin callers)
    if (L.DomUtil) {
      L.DomUtil.getSizedParentNode = function (element) {
        try { do { element = element.parentNode; } while (element && element !== document.body && (!element.offsetWidth || !element.offsetHeight)); } catch (e) { return document.body; }
        return element || document.body;
      };
    }
    // (b) THE REAL FIX: Leaflet's Draggable calls a *module-local* getSizedParentNode that we
    //     cannot reassign. It reads `null.offsetWidth` when the map sits in a zero-size / transformed
    //     / mid-re-render ancestor, throwing the DomUtil.js crash on pointer-down. Wrap the drag
    //     handlers so that can never take down the app; the map simply skips that one gesture.
    if (L.Draggable && L.Draggable.prototype) {
      ['_onDown', '_onMove', '_onUp'].forEach(function (m) {
        var orig = L.Draggable.prototype[m];
        if (typeof orig === 'function') {
          L.Draggable.prototype[m] = function () { try { return orig.apply(this, arguments); } catch (e) { } };
        }
      });
    }
    if (!document.getElementById('mc-leaflet-css')) {
      var st = document.createElement('style'); st.id = 'mc-leaflet-css'; st.textContent = CRITICAL_CSS; document.head.appendChild(st);
    }
  }
  var loading = null;
  function loadLeaflet() {
    if (global.L) { patchLeaflet(global.L); return Promise.resolve(global.L); }
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      try {
        var link = document.createElement('link'); link.rel = 'stylesheet'; link.href = LEAFLET_CSS; document.head.appendChild(link);
        var s = document.createElement('script'); s.src = LEAFLET_JS; s.async = true;
        var to = setTimeout(function () { reject(new Error('timeout')); }, 6000);
        s.onload = function () { clearTimeout(to); patchLeaflet(global.L); resolve(global.L); };
        s.onerror = function () { clearTimeout(to); reject(new Error('failed')); };
        document.head.appendChild(s);
      } catch (e) { reject(e); }
    });
    return loading;
  }
  var UCOLOR = { available: '#15A88A', dispatched: '#E9B23C', enroute: '#E9B23C', onscene: '#DF5039', transporting: '#DF5039', athospital: '#3FB2BB', clearing: '#93A9AA', returning: '#93A9AA' };
  function ucolor(s) { return UCOLOR[s] || '#15707A'; }
  function shortLabel(name) { var m = (name || '').match(/[A-Z]\d/); return m ? m[0] : (name || '').replace(/[^A-Z0-9]/g, '').slice(-2); }
  // normalise inputs: single scene/route -> arrays; latlng objects/pairs -> [lat,lng]
  function norm(d) {
    var cases = (d.cases || []).slice(); if (d.scene) cases.push(d.scene);
    var routes = (d.routes || []).slice(); if (d.route) routes.push(d.route);
    routes = routes.map(function (r) { return (r || []).map(function (p) { return (p.lat != null) ? [p.lat, p.lng] : [p[0], p[1]]; }); }).filter(function (r) { return r.length > 1; });
    return { units: d.units || [], riders: d.riders || [], cases: cases, routes: routes, hospital: d.hospital, me: d.me, bounds: d.bounds };
  }

  function LeafletMap(el, L, onFail) {
    var self = this;
    el.style.minHeight = el.style.minHeight || '240px';
    this.L = L; this.el = el;
    this.map = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: true, dragging: true, tap: true, touchZoom: true, doubleClickZoom: true }).setView([6.5, 3.38], 12);
    this.tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(this.map);
    // if the network blocks OSM tiles the map would just sit blank; detect that and let the caller fall back
    var loaded = 0, errored = 0;
    this.tiles.on('tileload', function () { loaded++; });
    this.tiles.on('tileerror', function () { errored++; });
    // if not a single tile renders (network blocks OSM, or a silent hang), fall back to the schematic
    setTimeout(function () { if (!self._dead && loaded === 0 && typeof onFail === 'function') onFail(); }, 4000);
    this.units = {}; this.hospital = null; this.me = null; this._fitted = false;
    this.routesLayer = L.layerGroup().addTo(this.map);
    this.casesLayer = L.layerGroup().addTo(this.map);
    this.ridersLayer = L.layerGroup().addTo(this.map);
    this._resize = function () { try { if (self.map && self.map._container && self.map._container.isConnected) self.map.invalidateSize(false); } catch (e) {} };
    window.addEventListener('resize', this._resize);
    setTimeout(this._resize, 60); setTimeout(this._resize, 300);
  }
  LeafletMap.prototype.alive = function () { return this.map && this.map._container && this.map._container.isConnected; };
  LeafletMap.prototype.update = function (raw) {
    if (!this.alive()) return; // container was detached by a re-render; never operate on a stale map
    var L = this.L, self = this, d = norm(raw), seen = {};
    this.routesLayer.clearLayers();
    d.routes.forEach(function (line) { L.polyline(line, { color: '#15707A', weight: 4, opacity: 0.7, dashArray: '8 6' }).addTo(self.routesLayer); });
    this.casesLayer.clearLayers();
    d.cases.forEach(function (c) { L.circleMarker([c.lat, c.lng], { radius: 9, color: '#fff', weight: 2, fillColor: '#DF5039', fillOpacity: 1 }).addTo(self.casesLayer); });
    if (d.hospital) { if (!this.hospital) this.hospital = L.marker([d.hospital.lat, d.hospital.lng], { icon: L.divIcon({ className: '', html: '<div style="background:#3FB2BB;color:#fff;border-radius:6px;padding:2px 6px;font:700 10px sans-serif;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.3)">+ ' + ((d.hospital.name || 'Hospital').split(' ')[0]) + '</div>', iconSize: [0, 0] }) }).addTo(this.map); else this.hospital.setLatLng([d.hospital.lat, d.hospital.lng]); }
    if (d.me) { if (!this.me) this.me = L.circleMarker([d.me.lat, d.me.lng], { radius: 8, color: '#fff', weight: 2, fillColor: '#15707A', fillOpacity: 1 }).addTo(this.map); else this.me.setLatLng([d.me.lat, d.me.lng]); }
    d.units.forEach(function (u) { seen[u.id] = 1; var c = ucolor(u.status);
      if (!self.units[u.id]) self.units[u.id] = L.circleMarker([u.lat, u.lng], { radius: 9, color: '#fff', weight: 2, fillColor: c, fillOpacity: 1 }).addTo(self.map).bindTooltip(u.name);
      else { self.units[u.id].setLatLng([u.lat, u.lng]); self.units[u.id].setStyle({ fillColor: c }); } });
    Object.keys(this.units).forEach(function (id) { if (!seen[id]) { self.map.removeLayer(self.units[id]); delete self.units[id]; } });
    this.ridersLayer.clearLayers();
    d.riders.forEach(function (r) { L.marker([r.lat, r.lng], { icon: L.divIcon({ className: '', html: '<div style="width:20px;height:20px;border-radius:50%;background:#E9B23C;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);color:#3a2a06;font:800 9px sans-serif;display:flex;align-items:center;justify-content:center">R</div>', iconSize: [20, 20], iconAnchor: [10, 10] }) }).addTo(self.ridersLayer).bindTooltip(r.name || 'Rider'); });
    if (!this._fitted) { var pts = []; d.units.forEach(function (u) { pts.push([u.lat, u.lng]); }); d.riders.forEach(function (r) { pts.push([r.lat, r.lng]); }); d.cases.forEach(function (c) { pts.push([c.lat, c.lng]); }); if (d.hospital) pts.push([d.hospital.lat, d.hospital.lng]); if (d.me) pts.push([d.me.lat, d.me.lng]); if (pts.length) { try { this.map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 }); this._fitted = true; } catch (e) {} } }
  };
  LeafletMap.prototype.recenter = function () { this._fitted = false; };
  LeafletMap.prototype.destroy = function () { this._dead = true; try { window.removeEventListener('resize', this._resize); } catch (e) {} try { this.map.remove(); } catch (e) {} };

  function SvgMap(el) { this.el = el; el.style.minHeight = '220px'; }
  SvgMap.prototype.update = function (raw) {
    var d = norm(raw), B = d.bounds || { latMin: 6.42, latMax: 6.63, lngMin: 3.31, lngMax: 3.56 }, W = 340, H = 230, P = 12;
    var px = function (lng) { return P + ((lng - B.lngMin) / (B.lngMax - B.lngMin)) * (W - 2 * P); };
    var py = function (lat) { return P + ((B.latMax - lat) / (B.latMax - B.latMin)) * (H - 2 * P); };
    var grid = ''; var i; for (i = 0; i < 6; i++) grid += '<line x1="' + (P + i * (W - 2 * P) / 5) + '" y1="' + P + '" x2="' + (P + i * (W - 2 * P) / 5) + '" y2="' + (H - P) + '" stroke="rgba(120,140,140,.18)" stroke-width="1"/>';
    for (i = 0; i < 5; i++) grid += '<line x1="' + P + '" y1="' + (P + i * (H - 2 * P) / 4) + '" x2="' + (W - P) + '" y2="' + (P + i * (H - 2 * P) / 4) + '" stroke="rgba(120,140,140,.18)" stroke-width="1"/>';
    var route = d.routes.map(function (line) { var pts = line.map(function (p) { return px(p[1]) + ',' + py(p[0]); }).join(' '); return '<polyline points="' + pts + '" fill="none" stroke="#15707A" stroke-width="2" stroke-dasharray="6 4" opacity="0.7"/>'; }).join('');
    var hosp = d.hospital ? '<g><rect x="' + (px(d.hospital.lng) - 5) + '" y="' + (py(d.hospital.lat) - 5) + '" width="10" height="10" rx="2" fill="#3FB2BB"/><text x="' + (px(d.hospital.lng) + 8) + '" y="' + (py(d.hospital.lat) + 3) + '" fill="#3FB2BB" font-size="8" font-weight="700">' + ((d.hospital.name || 'Hosp').split(' ')[0]) + '</text></g>' : '';
    var scenes = d.cases.map(function (c) { return '<g><circle cx="' + px(c.lng) + '" cy="' + py(c.lat) + '" r="6" fill="#DF5039" opacity="0.25"><animate attributeName="r" values="6;12;6" dur="1.6s" repeatCount="indefinite"/></circle><circle cx="' + px(c.lng) + '" cy="' + py(c.lat) + '" r="4" fill="#DF5039"/></g>'; }).join('');
    var me = d.me ? '<circle cx="' + px(d.me.lng) + '" cy="' + py(d.me.lat) + '" r="6" fill="#15707A" stroke="#fff" stroke-width="1.5"/>' : '';
    var units = d.units.map(function (u) { return '<g><circle cx="' + px(u.lng) + '" cy="' + py(u.lat) + '" r="7" fill="' + ucolor(u.status) + '" stroke="#fff" stroke-width="1.5"/><text x="' + px(u.lng) + '" y="' + (py(u.lat) + 2.5) + '" fill="#fff" font-size="6.5" text-anchor="middle" font-weight="800">' + shortLabel(u.name) + '</text></g>'; }).join('');
    var riders = d.riders.map(function (r) { return '<g><circle cx="' + px(r.lng) + '" cy="' + py(r.lat) + '" r="6.5" fill="#E9B23C" stroke="#fff" stroke-width="1.5"/><text x="' + px(r.lng) + '" y="' + (py(r.lat) + 2.3) + '" fill="#3a2a06" font-size="6.5" text-anchor="middle" font-weight="800">R</text></g>'; }).join('');
    this.el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block;border-radius:12px"><rect x="' + P + '" y="' + P + '" width="' + (W - 2 * P) + '" height="' + (H - 2 * P) + '" rx="10" fill="var(--surface-2,#EDF3F3)"/>' + grid + route + hosp + scenes + me + units + riders + '</svg>';
  };
  SvgMap.prototype.recenter = function () {};
  SvgMap.prototype.destroy = function () { this.el.innerHTML = ''; };

  function create(el, opts) {
    opts = opts || {};
    var wrapper = { _impl: new SvgMap(el), _pending: null, ready: false, _destroyed: false };
    wrapper.update = function (d) { this._pending = d; try { this._impl.update(d); } catch (e) {} };
    wrapper.recenter = function () { try { this._impl.recenter(); } catch (e) {} };
    wrapper.destroy = function () { this._destroyed = true; try { this._impl.destroy(); } catch (e) {} };
    if (opts.offline) return wrapper;
    loadLeaflet().then(function (L) {
      var tries = 0;
      (function go() {
        if (wrapper._destroyed) return;
        // if the container was detached by a re-render, do NOT init Leaflet on it (that is the offsetWidth crash)
        if (!el.isConnected) return;
        // if it is attached but not yet laid out (zero size), wait a few frames rather than init blank
        if (!(el.offsetWidth > 0 && el.offsetHeight > 0)) { if (tries++ < 40) return requestAnimationFrame(go); return; }
        try {
          var revert = function () {
            if (wrapper._destroyed) return;
            try { lm.destroy(); } catch (e) {}
            var svg = new SvgMap(el); wrapper._impl = svg; wrapper.ready = false;
            if (wrapper._pending) { try { svg.update(wrapper._pending); } catch (e) {} }
          };
          // IMPORTANT: clear the schematic from the container FIRST. Leaflet appends its panes to
          // the same element, and destroying the SVG afterwards (innerHTML='') would wipe them,
          // leaving the blank grey box. Order matters.
          wrapper._impl.destroy();
          var lm = new LeafletMap(el, L, revert);
          wrapper._impl = lm; wrapper.ready = true;
          if (wrapper._pending) lm.update(wrapper._pending);
        } catch (e) { try { wrapper._impl = new SvgMap(el); if (wrapper._pending) wrapper._impl.update(wrapper._pending); } catch (e2) {} }
      })();
    }).catch(function () {});
    return wrapper;
  }
  // Once the ambulance has the patient on board (transporting/at hospital), the
  // patient rides WITH the vehicle. Return a marker position that follows the unit,
  // nudged slightly so both markers stay visible side by side; otherwise the pickup point.
  function ridePos(u, fallback) {
    if (u && (u.status === 'transporting' || u.status === 'athospital')) {
      return { lat: u.lat + 0.00035, lng: u.lng + 0.00045, riding: true };
    }
    return fallback;
  }
  // Interactive picker: a draggable pin on a real map. onPick({lat,lng}) fires on
  // drag or map tap. Used by the delivery-address screen. Falls back silently if
  // Leaflet/tiles are unavailable (the caller keeps the manual address field).
  function createPicker(el, opts) {
    opts = opts || {};
    var api = { _map: null, _marker: null, _destroyed: false, _pending: opts.start || null };
    api.getLatLng = function () { if (this._marker) { var ll = this._marker.getLatLng(); return { lat: ll.lat, lng: ll.lng }; } return this._pending; };
    api.setCenter = function (lat, lng) { this._pending = { lat: lat, lng: lng }; if (this._map && this._marker) { this._marker.setLatLng([lat, lng]); this._map.setView([lat, lng], Math.max(this._map.getZoom() || 15, 15)); } };
    api.destroy = function () { this._destroyed = true; try { if (this._map) this._map.remove(); } catch (e) {} };
    el.style.minHeight = el.style.minHeight || '220px';
    loadLeaflet().then(function (L) {
      var tries = 0;
      (function go() {
        if (api._destroyed || !el.isConnected) return;
        if (!(el.offsetWidth > 0 && el.offsetHeight > 0)) { if (tries++ < 40) return requestAnimationFrame(go); return; }
        try {
          var start = opts.start || { lat: 6.4966, lng: 3.3512 };
          var map = L.map(el, { zoomControl: true, attributionControl: true }).setView([start.lat, start.lng], 15);
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
          var marker = L.marker([start.lat, start.lng], { draggable: true }).addTo(map);
          api._map = map; api._marker = marker;
          var fire = function () { var ll = marker.getLatLng(); if (typeof opts.onPick === 'function') opts.onPick({ lat: ll.lat, lng: ll.lng }); };
          marker.on('dragend', fire);
          map.on('click', function (e) { marker.setLatLng(e.latlng); fire(); });
          setTimeout(function () { try { map.invalidateSize(false); } catch (e) {} }, 80);
          setTimeout(function () { try { map.invalidateSize(false); } catch (e) {} }, 300);
        } catch (e) {}
      })();
    }).catch(function () {});
    return api;
  }
  global.MapKit = { create: create, ucolor: ucolor, ridePos: ridePos, createPicker: createPicker };
})(window);
