/* MediCore shared geocoder (address autocomplete + reverse), used by every app that
 * takes a typed address. Uses Photon (built for autocomplete, area-biased) with a
 * Nominatim fallback, and Nominatim for reverse geocoding. No API key required. */
(function (g) {
  function bias() { try { if (g.__mcBias && g.__mcBias.lat != null) return g.__mcBias; } catch (e) {} return { lat: 6.5244, lng: 3.3792 }; } // Lagos default
  function setBias(lat, lng) { if (lat != null && lng != null) g.__mcBias = { lat: lat, lng: lng }; }
  async function search(q) {
    if (!q || q.trim().length < 3) return [];
    const b = bias();
    try {
      const r = await fetch('https://photon.komoot.io/api/?limit=8&lang=en&lat=' + b.lat + '&lon=' + b.lng + '&q=' + encodeURIComponent(q));
      if (r.ok) {
        const j = await r.json();
        const feats = (j.features || []).map(f => { const p = f.properties || {}; const c = (f.geometry || {}).coordinates || [];
          const parts = [p.name, (p.street && p.street !== p.name) ? p.street : null, p.housenumber, p.suburb || p.district, p.city || p.town || p.village, p.state, p.country].filter(Boolean);
          return { display_name: [...new Set(parts)].join(', '), lat: c[1], lon: c[0] }; }).filter(x => x.lat != null && x.display_name);
        if (feats.length) return feats;
      }
    } catch (e) {}
    try { const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=8&countrycodes=ng&q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } });
      if (r.ok) { const j = await r.json(); return j.map(x => ({ display_name: x.display_name, lat: x.lat, lon: x.lon })); } } catch (e) {}
    return [];
  }
  async function reverse(lat, lng) {
    try { const r = await fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng, { headers: { Accept: 'application/json' } });
      if (r.ok) { const j = await r.json(); return j.display_name || null; } } catch (e) {}
    return null;
  }
  // Turn an <input> into an address autocomplete. onPick({lat,lng,text}) fires on selection.
  function mountAutocomplete(input, onPick, opts) {
    if (!input || input.__mgMounted) return; input.__mgMounted = true; opts = opts || {};
    input.setAttribute('autocomplete', 'off');
    let box = opts.box; if (!box) { box = document.createElement('div'); box.style.cssText = 'margin-top:4px'; input.parentNode.insertBefore(box, input.nextSibling); }
    let timer = null, results = [];
    input.addEventListener('input', function () {
      clearTimeout(timer); const q = input.value.trim(); if (q.length < 3) { box.innerHTML = ''; return; }
      box.innerHTML = '<div style="padding:6px;font-size:.78rem;color:#8aa">Searching\u2026</div>';
      timer = setTimeout(async function () {
        results = await search(q);
        box.innerHTML = results.length
          ? results.map((r, i) => '<button type="button" data-i="' + i + '" class="mg-opt" style="display:block;width:100%;text-align:left;margin-top:6px;font-size:.85rem;padding:9px 10px;border:1px solid var(--line,#dde);border-radius:8px;background:var(--surface,#fff);color:inherit;cursor:pointer">' + (r.display_name || '').replace(/</g, '&lt;') + '</button>').join('')
          : '<div style="padding:8px;font-size:.8rem;color:#8aa">No matches yet \u2014 you can type it in full.</div>';
      }, 400);
    });
    box.addEventListener('click', function (e) { const btn = e.target.closest('.mg-opt'); if (!btn) return; const r = results[+btn.dataset.i]; if (!r) return;
      input.value = r.display_name; box.innerHTML = ''; if (onPick) onPick({ lat: parseFloat(r.lat), lng: parseFloat(r.lon), text: r.display_name }); });
  }
  g.MediGeo = { search: search, reverse: reverse, mountAutocomplete: mountAutocomplete, setBias: setBias, bias: bias };
})(window);
