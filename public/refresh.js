/* build: 2026-08-31 background-refresh+clock-gate */
try{console.log('%cMediCore UI build 2026-08-31: background-refresh + clock-gate active','color:#15707A;font-weight:700');}catch(e){}
/* MediCore soft-refresh: patch the DOM in place instead of replacing innerHTML,
 * so polled/updated content changes without the page looking like it reloads.
 * Preserves scroll position, focused inputs, and live nodes (maps, <video>). */
(function (g) {
  function isKept(node) {
    return node.nodeType === 1 && (node.hasAttribute('data-keep') || node.tagName === 'VIDEO' || node.tagName === 'CANVAS' || node.classList.contains('mc-keep') || node.classList.contains('leaflet-container'));
  }
  function isEditing(node) {
    var ae = document.activeElement;
    return node === ae && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT' || node.isContentEditable);
  }
  function same(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType === 1) {
      if (a.tagName !== b.tagName) return false;
      var ia = a.getAttribute('id'), ib = b.getAttribute('id');
      if (ia || ib) return ia === ib;
      // keep list rows aligned by an optional data-key
      var ka = a.getAttribute('data-key'), kb = b.getAttribute('data-key');
      if (ka || kb) return ka === kb;
      return true;
    }
    return true; // text / comment
  }
  function morphAttrs(from, to) {
    var t = to.attributes, i, n, v;
    for (i = t.length - 1; i >= 0; i--) { n = t[i].name; v = t[i].value; if (from.getAttribute(n) !== v) from.setAttribute(n, v); }
    var f = from.attributes;
    for (i = f.length - 1; i >= 0; i--) { n = f[i].name; if (!to.hasAttribute(n)) from.removeAttribute(n); }
    // keep form control values in sync unless the user is editing that field
    if ((from.tagName === 'INPUT' || from.tagName === 'TEXTAREA' || from.tagName === 'SELECT') && !isEditing(from)) {
      if (to.hasAttribute('value') && from.value !== to.getAttribute('value')) from.value = to.getAttribute('value');
    }
  }
  function morphEl(from, to) {
    if (from.tagName !== to.tagName) { from.parentNode.replaceChild(to.cloneNode(true), from); return; }
    morphAttrs(from, to);
    if (isKept(from) || isEditing(from)) return; // never disturb maps/video or a field being typed in
    morphChildren(from, to);
  }
  function morphChildren(from, to) {
    var fc = from.firstChild, tc = to.firstChild, nF, nT;
    while (tc) {
      nT = tc.nextSibling;
      if (!fc) { from.appendChild(tc.cloneNode(true)); tc = nT; continue; }
      nF = fc.nextSibling;
      if (same(fc, tc)) {
        if (fc.nodeType === 1) morphEl(fc, tc);
        else if (fc.nodeValue !== tc.nodeValue) fc.nodeValue = tc.nodeValue;
        fc = nF; tc = nT;
      } else {
        from.replaceChild(tc.cloneNode(true), fc);
        fc = nF; tc = nT;
      }
    }
    while (fc) { nF = fc.nextSibling; from.removeChild(fc); fc = nF; }
  }
  function mcMorph(el, html) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return;
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    morphChildren(el, tpl.content);
  }
  function mcView(html) { mcMorph(document.getElementById('view'), html); }
  g.mcMorph = mcMorph;
  g.mcView = mcView;
})(window);
