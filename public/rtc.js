/* MediCore real WebRTC client.
 * Patient = caller (creates the offer). Doctor = answerer.
 * Signalling is relayed over HTTP (/api/video/:room/{join,signal,poll}). */
(function (global) {
  function authHeaders(token) { return token ? { Authorization: 'Bearer ' + token } : {}; }

  async function start(opts) {
    // opts: { base, token, room, localEl, remoteEl, onState, onError }
    var base = opts.base || '';
    var token = opts.token;
    var room = opts.room;
    var alive = true, since = 0, pc = null, localStream = null, pollTimer = null, madeOffer = false;
    var role = 'patient', ice = [{ urls: 'stun:stun.l.google.com:19302' }];

    function post(path, body) {
      return fetch(base + path, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(token)), body: JSON.stringify(body || {}) }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
    }
    function get(path) { return fetch(base + path, { headers: authHeaders(token) }).then(function (r) { return r.json().catch(function () { return {}; }); }); }
    function state(s) { if (opts.onState) try { opts.onState(s); } catch (e) {} }

    try {
      var joined = await post('/api/video/' + room + '/join', {});
      role = joined.role; ice = joined.iceServers || ice;
    } catch (e) { if (opts.onError) opts.onError(e); throw e; }

    state('requesting-media');
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      // audio-only fallback so a camera-less device can still talk
      try { localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true }); }
      catch (e2) { if (opts.onError) opts.onError(new Error('Camera/microphone permission is needed for the visit.')); throw e2; }
    }
    if (opts.localEl) { opts.localEl.srcObject = localStream; opts.localEl.muted = true; try { await opts.localEl.play(); } catch (e) {} }

    pc = new RTCPeerConnection({ iceServers: ice });
    localStream.getTracks().forEach(function (t) { pc.addTrack(t, localStream); });
    pc.onicecandidate = function (ev) { if (ev.candidate) post('/api/video/' + room + '/signal', { kind: 'candidate', data: ev.candidate }).catch(function () {}); };
    pc.ontrack = function (ev) { if (opts.remoteEl && opts.remoteEl.srcObject !== ev.streams[0]) { opts.remoteEl.srcObject = ev.streams[0]; try { opts.remoteEl.play(); } catch (e) {} } };
    pc.onconnectionstatechange = function () { state(pc.connectionState); };
    pc.oniceconnectionstatechange = function () { if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') state('connected'); };

    async function makeOffer() {
      if (madeOffer) return; madeOffer = true;
      var offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      await post('/api/video/' + room + '/signal', { kind: 'offer', data: offer });
    }
    async function handle(sig) {
      try {
        if (sig.kind === 'offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(sig.data));
          var answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
          await post('/api/video/' + room + '/signal', { kind: 'answer', data: answer });
        } else if (sig.kind === 'answer') {
          if (!pc.currentRemoteDescription) await pc.setRemoteDescription(new RTCSessionDescription(sig.data));
        } else if (sig.kind === 'candidate') {
          try { await pc.addIceCandidate(new RTCIceCandidate(sig.data)); } catch (e) {}
        } else if (sig.kind === 'bye') { state('ended'); }
      } catch (e) { /* keep polling */ }
    }
    async function pollOnce() {
      if (!alive) return;
      try {
        var r = await get('/api/video/' + room + '/poll?since=' + since);
        if (r.since != null) since = r.since;
        (r.signals || []).forEach(handle);
        // the caller (patient) makes the offer once the doctor is present
        if (role === 'patient' && r.peerPresent && !madeOffer) makeOffer();
      } catch (e) {}
      if (alive) pollTimer = setTimeout(pollOnce, 1000);
    }
    // patient also offers proactively after a short delay in case presence race
    if (role === 'patient') setTimeout(function () { if (alive && !madeOffer) makeOffer(); }, 1500);
    state('waiting');
    pollOnce();

    return {
      role: role,
      toggleMic: function () { var t = localStream && localStream.getAudioTracks()[0]; if (t) { t.enabled = !t.enabled; return t.enabled; } return null; },
      toggleCam: function () { var t = localStream && localStream.getVideoTracks()[0]; if (t) { t.enabled = !t.enabled; return t.enabled; } return null; },
      hangup: function () { alive = false; if (pollTimer) clearTimeout(pollTimer); try { post('/api/video/' + room + '/signal', { kind: 'bye' }); } catch (e) {} try { pc && pc.close(); } catch (e) {} if (localStream) localStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); state('ended'); }
    };
  }

  global.MediCoreRTC = { start: start };
})(window);
