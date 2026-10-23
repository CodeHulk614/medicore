/*
 * MediCore WhatsApp kit: the department WhatsApp inbox for staff apps.
 * Shared by the front desk, pharmacy, lab and dispatch apps (and admin later). Load after mc.js, before the app script.
 *
 *   MC.whatsapp.routes('#/whatsapp', { patientHref: pid => '#/patient/' + pid })  -> route handlers to spread into MC.boot routes
 *   MC.whatsapp.navItem(opts)                                                     -> nav entry (perm whatsapp.inbox) with the unread count
 *   MC.whatsapp.startDialog({ patient })                                          -> start a chat with a patient who agreed to WhatsApp
 *   MC.whatsapp.refreshCount()                                                    -> updates the nav badge with unread messages
 *   MC.whatsapp.chatLink(number, text)                                            -> https://wa.me link (click-to-chat, needs no setup)
 *   MC.whatsapp.canUse()
 *
 * Chats: open -> closed. Replies inside 24 hours of the person's last message are free text; after that only
 * the approved update template, and only to a patient who agreed to WhatsApp messages.
 */
(function () {
  'use strict';
  const { html, api, qs, icon, badge, empty, view, on, form, dialog, confirm, toast, dateTime, time, ago, cap } = MC;
  const T = (k, en, v) => MC.t('wa.' + k, en, v);
  const can = p => !!(MC.me && (MC.me.perms || []).includes(p));
  const canUse = () => can('whatsapp.inbox');
  const hasMod = m => !!(MC.me && MC.me.org && (MC.me.org.modules || []).includes(m));
  const err400 = (msg, details) => new MC.ApiError(400, { error: msg, details });

  let PREFIX = '#/whatsapp';
  let OPTS = {};
  let apiReady = null;     // last value seen from the server
  let myDepts = {};        // departments this role handles { key: label }

  /* ---------------- helpers ---------------- */
  const DEPT_EN = { main: 'Main line and reception', emergency: 'Emergency', appointments: 'Appointments', pharmacy: 'Pharmacy', lab: 'Laboratory', billing: 'Billing and HMO', care: 'Customer care and complaints', ambulance: 'Ambulance', records: 'Medical records' };
  const DEPT_MOD = { pharmacy: 'pharmacy', lab: 'lab', ambulance: 'ambulance' };
  const deptLabel = (k, fallback) => T('dept.' + k, DEPT_EN[k] || fallback || cap(k));
  const digits = s => String(s || '').replace(/\D/g, '');
  const chatLink = (number, text) => { const d = digits(number); return d.length >= 8 ? 'https://wa.me/' + d + (text ? '?text=' + encodeURIComponent(text) : '') : null; };
  const safeUrl = u => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null);
  const short = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '...' : s; };
  const lines = text => String(text || '').split('\n').map((l, i) => html`${i ? html`<br>` : ''}${l}`);
  const back = (href, label) => html`<a class="back" href="${href}">${icon('left')}${label}</a>`;
  const urgentBadge = () => html`<span class="badge plain pri-P1">${icon('alert')}${T('urgent', 'Urgent')}</span>`;
  const unreadBadge = n => (n ? html`<span class="badge plain hue" aria-label="${T('unread_l', '{n} unread', { n })}">${T('unread', '{n} new', { n })}</span>` : '');
  const STATUS_EN = { sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Not delivered' };
  const msgStatus = s => (s ? badge(T('st.' + s, STATUS_EN[s] || cap(s)), s === 'failed' ? 'bad' : s === 'read' || s === 'delivered' ? 'ok' : 'outline') : '');
  /** turn the server's WhatsApp errors into words the desk understands */
  function explain(e) {
    if (!e || e.status !== 409) return e;
    if (e.code === 'whatsapp_off') { apiReady = false; return new MC.ApiError(409, { error: T('err.off', 'Not sent: MediCore has not connected WhatsApp yet, so messages cannot be sent from here. Use "Open in WhatsApp" to message from your department phone, or call the person.'), code: e.code }); }
    if (e.code === 'outside_window') return new MC.ApiError(409, { error: T('err.window', 'Not sent: more than 24 hours have passed since this person last wrote, and they have not agreed to WhatsApp messages. Wait for them to write again, or call them.'), code: e.code });
    if (e.code === 'no_opt_in') return new MC.ApiError(409, { error: T('err.no_opt_in', 'Not sent: this patient has not agreed to WhatsApp messages. Ask them first and record their answer on their patient record.'), code: e.code });
    if (e.code === 'whatsapp_failed') return new MC.ApiError(409, { error: T('err.failed', 'WhatsApp did not accept the message: {m}', { m: e.message }), code: e.code });
    return e;
  }
  const offBanner = () => html`<div class="notice warn" role="status"><b>${T('off.title', 'Replies need MediCore to connect WhatsApp.')}</b> ${T('off.body', 'You can read chats here, but replies from MediCore will not send until the MediCore team connects the WhatsApp Business account. Until then, use "Open in WhatsApp" to answer from your department\'s WhatsApp phone. Click-to-chat links for patients still work.')}</div>`;

  /* ---------------- nav and counts ---------------- */
  function navItem(opts) {
    return Object.assign({ href: PREFIX, label: T('nav', 'WhatsApp'), icon: 'message', perm: 'whatsapp.inbox' }, opts || {});
  }
  const setCount = n => MC.navCount(PREFIX, n || 0);
  async function refreshCount() {
    if (!canUse()) return 0;
    try { const r = await api.get('/api/wa/conversations' + qs({ status: 'open', limit: 200 })); apiReady = r.apiReady; myDepts = r.departments || {}; setCount(r.unreadTotal); return r.unreadTotal; } catch (e) { return 0; }
  }

  /* ================= inbox ================= */
  function row(c) {
    const who = c.name || c.phone;
    return html`<a href="${PREFIX}/${c.id}" ${c.priority === 'urgent' ? html`style="border-left:4px solid var(--red)"` : ''}>
      <div class="grow"><span class="title">${who} ${c.priority === 'urgent' ? urgentBadge() : ''} ${unreadBadge(c.unread)}</span>
        <span class="sub">${[deptLabel(c.dept, c.deptLabel), c.name ? c.phone : '', c.assignedName ? T('list.assigned', 'With {name}', { name: c.assignedName }) : T('list.unassigned', 'Not assigned')].filter(Boolean).join(' | ')}</span>
        <span class="sub">${c.lastText ? short(c.lastText, 120) : html`<i>${T('list.no_text', 'No messages yet')}</i>`}</span></div>
      <span class="end xs muted">${ago(c.lastAt)}${c.patientId ? html`<br>${badge(T('list.patient', 'Patient'), 'outline')}` : ''}</span></a>`;
  }
  async function inboxPage({ query }) {
    if (!canUse()) return view(empty({ icon: 'lock', title: T('noperm.title', 'Your role cannot use the WhatsApp inbox'), body: T('noperm.body', 'Ask your administrator if you need to answer WhatsApp chats.') }));
    const status = query.status === 'closed' ? 'closed' : 'open';
    const dept = DEPT_EN[query.dept] ? query.dept : '';
    view(html`<div class="page-head"><div><h1>${T('title', 'WhatsApp')}</h1><p id="wa-sub">${T('sub', 'Chats from patients on your department WhatsApp numbers. Refreshes every 15 seconds.')}</p></div></div>
      <div id="wa-banner"></div>
      <div class="tabs" role="tablist" aria-label="${T('depts', 'Departments')}" id="wa-tabs"></div>
      <div class="seg" role="group" aria-label="${T('show', 'Show')}" style="margin-bottom:16px">
        <button type="button" data-action="wa-status" data-s="open" data-dept="${dept}" aria-pressed="${status === 'open' ? 'true' : 'false'}">${T('open', 'Open')}</button>
        <button type="button" data-action="wa-status" data-s="closed" data-dept="${dept}" aria-pressed="${status === 'closed' ? 'true' : 'false'}">${T('closed', 'Closed')}</button></div>
      <div id="wa-list">${MC.skeleton(3)}</div>`);
    const el = document.getElementById('wa-list');
    let sig = '';
    const load = async () => {
      const r = await api.get('/api/wa/conversations' + qs({ status, dept, limit: 200 }));
      if (!el.isConnected) return;
      apiReady = r.apiReady; myDepts = r.departments || {};
      if (status === 'open' && !dept) setCount(r.unreadTotal);
      const s = JSON.stringify([r.apiReady, Object.keys(myDepts), r.conversations.map(c => [c.id, c.unread, c.lastAt, c.priority, c.assignedTo, c.dept, c.name])]);
      const sub = document.getElementById('wa-sub'); if (sub) sub.textContent = T('updated', 'Updated {t}. Refreshes every 15 seconds.', { t: time(Date.now()) });
      if (s === sig) return; sig = s;
      MC.view(r.apiReady ? '' : offBanner(), document.getElementById('wa-banner'));
      const keys = Object.keys(myDepts);
      MC.view(keys.length > 1 ? html`<a role="tab" href="${PREFIX}${qs({ status: status === 'closed' ? 'closed' : undefined })}" aria-selected="${dept ? 'false' : 'true'}">${T('all', 'All')}</a>${keys.map(k => html`<a role="tab" href="${PREFIX}${qs({ dept: k, status: status === 'closed' ? 'closed' : undefined })}" aria-selected="${dept === k ? 'true' : 'false'}">${deptLabel(k, myDepts[k])}</a>`)}` : '', document.getElementById('wa-tabs'));
      const urgent = r.conversations.filter(c => c.priority === 'urgent' && c.status === 'open').length;
      MC.view(html`${urgent ? html`<div class="notice bad" role="alert"><b>${urgent === 1 ? T('urgent_one', '1 urgent chat.') : T('urgent_many', '{n} urgent chats.', { n: urgent })}</b> ${T('urgent_body', 'Someone used an emergency word. Open it now and call them if you can.')}</div>` : ''}
        ${r.conversations.length ? html`<div class="list">${r.conversations.map(row)}</div>`
          : empty({ icon: 'message', title: status === 'open' ? T('empty_open', 'No open chats') : T('empty_closed', 'No closed chats'), body: status === 'open' ? T('empty_open_sub', 'When a patient writes to one of your department WhatsApp numbers, the chat appears here.') : T('empty_closed_sub', 'Chats you close appear here.') })}`, el);
    };
    await load();
    MC.poll(load, 15000);
    if (status !== 'open' || dept) refreshCount();
  }
  on('wa-status', el => MC.go(PREFIX + qs({ dept: el.dataset.dept || undefined, status: el.dataset.s === 'closed' ? 'closed' : undefined })));

  /* ================= one conversation ================= */
  let cur = null; // { c, patient, optIn }
  function bubble(m) {
    const out = m.dir === 'out';
    const who = out ? (m.auto ? T('msg.auto', 'Automatic reply') : m.byName || T('msg.staff', 'Staff')) : (cur && (cur.c.name || cur.c.phone)) || T('msg.them', 'Them');
    const marks = [];
    if (m.auto) marks.push(badge(T('msg.auto_b', 'Automatic'), 'outline'));
    if (m.template) marks.push(badge(T('msg.template', 'Sent as update template'), 'info'));
    if (out) marks.push(msgStatus(m.status));
    return html`<li style="display:flex;flex-direction:column;align-items:${out ? 'flex-end' : 'flex-start'};padding:6px 0">
      <div style="max-width:min(85%,560px);padding:10px 12px;border-radius:12px;${out ? 'background:var(--hue-soft);border-bottom-right-radius:4px' : 'background:var(--sunken);border-bottom-left-radius:4px'};overflow-wrap:anywhere">
        <span class="sr-only">${out ? T('msg.sr_out', 'Sent by {who}:', { who }) : T('msg.sr_in', 'From {who}:', { who })}</span>
        ${m.text ? lines(m.text) : html`<i class="muted">${T('msg.media', '[{type} message: open WhatsApp on the phone to view it]', { type: m.type || 'media' })}</i>`}</div>
      <span class="xs muted" style="margin-top:2px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;justify-content:${out ? 'flex-end' : 'flex-start'}">${who} | ${dateTime(m.at)} ${marks}</span>
      ${m.status === 'failed' || m.error ? html`<span class="xs" style="color:var(--red);max-width:85%;text-align:${out ? 'right' : 'left'}">${T('msg.failed', 'Not delivered')}${m.error ? ': ' + m.error : ''}</span>` : ''}</li>`;
  }
  function renderMsgs(list) {
    const box = document.getElementById('wa-msgs'); if (!box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    MC.view(list.length ? html`<ol style="list-style:none;margin:0;padding:0 2px">${list.map(bubble)}</ol>` : html`<p class="muted sm">${T('msg.none', 'No messages in this chat yet.')}</p>`, box);
    if (nearBottom || !box.dataset.seen) { box.scrollTop = box.scrollHeight; box.dataset.seen = '1'; }
  }
  function ruleText(c, optIn) {
    if (c.status === 'closed') return { kind: '', text: T('rule.closed', 'This chat is closed. If the person writes again, a new chat opens in the inbox.') };
    if (c.canReplyFreely) return { kind: 'ok', text: T('rule.free', 'They last wrote {ago}. You can reply freely until {t} (WhatsApp allows free replies for 24 hours after the person writes).', { ago: ago(c.lastInboundAt), t: dateTime(c.lastInboundAt + 24 * 3600e3) }) };
    const since = c.lastInboundAt ? T('rule.since', 'They last wrote {d}.', { d: dateTime(c.lastInboundAt) }) : T('rule.never', 'This person has not written in this chat.');
    if (!c.patientId) return { kind: 'warn', text: since + ' ' + T('rule.unlinked', 'More than 24 hours have passed, so WhatsApp only allows an approved update message, and only to a patient who agreed to WhatsApp messages. This chat is not linked to a patient, so you cannot reply until they write again. Link the patient or call them.') };
    if (optIn === true) return { kind: 'info', text: since + ' ' + T('rule.template', 'More than 24 hours have passed. The patient agreed to WhatsApp messages, so your reply goes as MediCore\'s approved update message.') };
    if (optIn === false) return { kind: 'warn', text: since + ' ' + T('rule.no', 'More than 24 hours have passed and the patient has not agreed to WhatsApp messages, so you cannot reply until they write again. Call them instead.') };
    return { kind: 'warn', text: since + ' ' + T('rule.unknown', 'More than 24 hours have passed. You can reply only if the patient agreed to WhatsApp messages (recorded on their patient record); it then goes as the approved update message. Otherwise wait for them to write again, or call them.') };
  }
  async function convPage({ params, stale }) {
    if (!canUse()) return view(empty({ icon: 'lock', title: T('noperm.title', 'Your role cannot use the WhatsApp inbox') }));
    let r;
    try { r = await api.get('/api/wa/conversations/' + encodeURIComponent(params.id)); }
    catch (e) { if (e.status === 404 || e.status === 403) return view(html`${back(PREFIX, T('title', 'WhatsApp'))}${empty({ icon: 'message', title: T('nf.title', 'Chat not found'), body: T('nf.body', 'It may have moved to a department you do not handle. Go back to the inbox.'), action: html`<a class="btn" href="${PREFIX}">${T('nf.back', 'Back to the inbox')}</a>` })}`); throw e; }
    if (stale()) return;
    let optIn = null;
    if (r.patient && can('patient.read')) { try { const p = await api.get('/api/fd/patients/' + encodeURIComponent(r.patient.id)); if (typeof p.whatsappOptIn === 'boolean') optIn = p.whatsappOptIn; } catch (e) { if (e.status === 401) throw e; } }
    if (stale()) return;
    if (apiReady === null) await refreshCount(); else refreshCount();
    if (stale()) return;
    const c = r.conversation;
    cur = { c, patient: r.patient, optIn };
    const mine = MC.me && MC.me.user && c.assignedTo === MC.me.user.id;
    const open = c.status === 'open';
    const rule = ruleText(c, optIn);
    const waOpen = chatLink(c.phone);
    view(html`${back(PREFIX, T('title', 'WhatsApp'))}
      <div class="page-head"><div><h1>${c.name || c.phone}</h1>
        <p>${c.priority === 'urgent' ? urgentBadge() : ''} ${MC.statusBadge(c.status)} ${[c.name ? c.phone : '', deptLabel(c.dept, c.deptLabel), c.assignedName ? (mine ? T('det.mine', 'Assigned to you') : T('list.assigned', 'With {name}', { name: c.assignedName })) : T('list.unassigned', 'Not assigned')].filter(Boolean).join(' | ')}</p></div>
        <div class="actions">
          ${open && !mine ? html`<button class="btn" data-action="wa-assign">${icon('user')}${T('act.assign', 'Assign to me')}</button>` : ''}
          ${open ? html`<button class="btn" data-action="wa-move">${icon('swap')}${T('act.move', 'Move to department')}</button>` : ''}
          ${can('patient.read') ? html`<button class="btn" data-action="wa-link">${icon('users')}${r.patient ? T('act.relink', 'Link a different patient') : T('act.link', 'Link to a patient')}</button>` : ''}
          ${open ? html`<button class="btn" data-action="wa-close">${icon('check')}${T('act.close', 'Close chat')}</button>` : ''}
          ${waOpen ? html`<a class="btn ghost" href="${waOpen}" target="_blank" rel="noopener">${icon('message')}${T('act.open_wa', 'Open in WhatsApp')}</a>` : ''}
        </div></div>
      ${c.priority === 'urgent' && open ? html`<div class="notice bad" role="alert"><b>${T('det.urgent', 'Urgent chat.')}</b> ${T('det.urgent_body', 'This person used an emergency word and was sent the emergency numbers automatically. Reply now and call them on {phone} if you can.', { phone: c.phone })}</div>` : ''}
      ${apiReady === false ? offBanner() : ''}
      ${r.patient ? html`<div class="notice"><div class="row wrap between"><span>${T('det.linked', 'Linked to {name}, record number {mrn}.', { name: r.patient.name, mrn: r.patient.mrn || '-' })} ${optIn === true ? badge(T('det.opt_in', 'Agreed to WhatsApp'), 'ok') : optIn === false ? badge(T('det.opt_out', 'Said no to WhatsApp'), 'warn') : ''}</span>
        ${OPTS.patientHref ? html`<a class="btn sm" href="${OPTS.patientHref(r.patient.id)}">${icon('user')}${T('det.open_patient', 'Open patient record')}</a>` : ''}</div></div>`
        : html`<div class="notice">${T('det.unlinked', 'This chat is not linked to a patient record yet.')}${can('patient.read') ? ' ' + T('det.unlinked_hint', 'Use "Link to a patient" once you know who it is.') : ''}</div>`}
      <section class="panel"><h2>${T('det.messages', 'Messages')}</h2>
        <div id="wa-msgs" aria-live="polite" style="max-height:60vh;overflow-y:auto;overflow-x:hidden"></div></section>
      ${open ? html`<form class="panel" data-form="wa-reply" novalidate><h2>${T('reply.title', 'Reply')}</h2>
        <div class="notice ${rule.kind}" id="wa-rule">${rule.text}</div>
        <div class="field"><label for="wa-text">${T('reply.label', 'Your reply')}</label><textarea class="input" id="wa-text" name="text" maxlength="2000" required></textarea>
          <div class="hint">${T('reply.hint', 'The person sees your name and your provider. Do not send test results, diagnoses or payment details on WhatsApp.')}</div></div>
        <div class="form-err notice bad" hidden></div>
        <div class="btn-row"><button class="btn primary" type="submit">${icon('message')}${T('reply.send', 'Send reply')}</button>
          ${waOpen ? html`<a class="btn ghost" id="wa-open-text" href="${waOpen}" target="_blank" rel="noopener">${T('reply.open_wa', 'Open in WhatsApp with this text')}</a>` : ''}</div></form>`
        : html`<div class="notice">${ruleText(c, optIn).text}</div>`}`);
    renderMsgs(r.messages);
    let sig = JSON.stringify(r.messages.map(m => [m.id, m.status]));
    const head = x => JSON.stringify([x.status, x.dept, x.assignedTo, x.patientId, x.priority, x.canReplyFreely, x.name]);
    const h0 = head(c);
    MC.poll(async () => {
      const n = await api.get('/api/wa/conversations/' + encodeURIComponent(c.id));
      if (!document.getElementById('wa-msgs')) return;
      const ta = document.getElementById('wa-text');
      if (head(n.conversation) !== h0 && !(ta && ta.value.trim()) && !document.querySelector('dialog.dlg')) { MC.render(); return; }
      const s = JSON.stringify(n.messages.map(m => [m.id, m.status]));
      if (s !== sig) { sig = s; renderMsgs(n.messages); }
    }, 10000);
  }
  document.addEventListener('input', e => {
    if (!e.target || e.target.id !== 'wa-text' || !cur) return;
    const a = document.getElementById('wa-open-text'); const l = chatLink(cur.c.phone, e.target.value.trim());
    if (a && l) a.setAttribute('href', l);
  });
  form('wa-reply', async (d, f) => {
    if (!cur) return;
    const text = (d.text || '').trim();
    if (!text) throw err400(T('reply.need', 'Write your reply first'), [{ field: 'text', error: T('reply.need', 'Write your reply first') }]);
    let r;
    try { r = await api.post('/api/wa/conversations/' + cur.c.id + '/reply', { text }); } catch (e) { throw explain(e); }
    f.reset();
    toast(r && r.template ? T('reply.sent_t', 'Reply sent as the update template') : T('reply.sent', 'Reply sent'), 'ok');
    MC.render();
  });
  on('wa-assign', async () => {
    if (!cur) return;
    await api.post('/api/wa/conversations/' + cur.c.id + '/assign');
    toast(T('assign.done', 'Chat assigned to you'), 'ok'); MC.render();
  });
  on('wa-move', async () => {
    if (!cur) return;
    const c = cur.c;
    const keys = Object.keys(DEPT_EN).filter(k => k !== c.dept && (!DEPT_MOD[k] || hasMod(DEPT_MOD[k]) || myDepts[k]));
    const v = await dialog({ title: T('move.title', 'Move this chat to another department'), form: true,
      body: html`<p class="muted sm">${T('move.body', 'The chat leaves {dept} and appears in the inbox of the department you choose.', { dept: deptLabel(c.dept, c.deptLabel) })}</p>
        <div class="field"><label for="wa-mv">${T('move.to', 'Move to')}</label><select class="input" id="wa-mv" name="dept">${keys.map(k => html`<option value="${k}">${deptLabel(k)}${myDepts[k] ? '' : ' ' + T('move.not_yours', '(you will no longer see it)')}</option>`)}</select></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('move.ok', 'Move chat'), primary: true }],
      onSubmit: async d => { await api.post('/api/wa/conversations/' + c.id + '/move', { dept: d.dept }); return d; } });
    if (!v) return;
    toast(T('move.done', 'Chat moved to {dept}', { dept: deptLabel(v.dept) }), 'ok');
    if (myDepts[v.dept]) MC.render(); else MC.go(PREFIX);
  });
  on('wa-close', async () => {
    if (!cur) return;
    const c = cur.c;
    if (!(await confirm({ title: T('close.title', 'Close this chat?'), body: T('close.body', 'The chat with {who} moves to Closed. If they write again, a new chat opens in the inbox.', { who: c.name || c.phone }), ok: T('act.close', 'Close chat') }))) return;
    await api.post('/api/wa/conversations/' + c.id + '/close');
    toast(T('close.done', 'Chat closed'), 'ok'); MC.go(PREFIX);
  });
  on('wa-link', async () => {
    if (!cur) return;
    const c = cur.c;
    let rows = [];
    const paint = d => {
      const box = d.querySelector('#wa-lp-res'); if (!box) return;
      MC.view(rows.length ? html`<div class="choice">${rows.map(p => html`<label class="check" style="border-bottom:1px solid var(--line-2)"><input type="radio" name="patientId" value="${p.id}"><span><b>${p.name}</b><br><span class="sm muted">${[p.mrn, p.age != null ? T('link.age', '{n} yrs', { n: p.age }) : '', p.phone].filter(Boolean).join(' | ')}${p.phone && digits(p.phone) === digits(c.phone) ? html` ${badge(T('link.same', 'Same number'), 'ok')}` : ''}</span></span></label>`)}</div>`
        : html`<p class="muted sm">${T('link.none', 'No patient found. Only patients registered with your provider can be linked.')}</p>`, box);
    };
    const v = await dialog({ title: T('link.title', 'Link this chat to a patient'), form: true,
      body: html`<p class="muted sm">${T('link.body', 'Check with the person who they are before you link. Staff who open the chat will see the patient record link.')}</p>
        <div class="field search"><label class="sr-only" for="wa-lp-q">${T('link.search', 'Name, phone or record number')}</label>${icon('search')}<input class="input" id="wa-lp-q" placeholder="${T('link.search', 'Name, phone or record number')}" autocomplete="off" value="${/^234/.test(digits(c.phone)) ? '0' + digits(c.phone).slice(3) : c.phone || ''}"></div>
        <div class="field" id="wa-lp-res"><p class="muted sm">${T('link.hint', 'Type at least 2 letters or the phone number to search your patients.')}</p></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('link.ok', 'Link patient'), primary: true }],
      onOpen: d => {
        let t = null; const q = d.querySelector('#wa-lp-q');
        const run = async () => { const s = q.value.trim(); if (s.length < 2) return; try { rows = await api.get('/api/fd/patients' + qs({ q: s, limit: 20 })); } catch (e) { rows = []; } paint(d); };
        q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 300); });
        q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(t); run(); } });
        if (q.value) run();
      },
      onSubmit: async d => {
        const p = rows.find(x => x.id === d.patientId);
        if (!p) throw err400(T('link.need', 'Search, then choose the patient'));
        await api.post('/api/wa/conversations/' + c.id + '/link-patient', { patientId: p.id });
        return p;
      } });
    if (v) { toast(T('link.done', 'Chat linked to {name}', { name: v.name }), 'ok'); MC.render(); }
  });

  /* ================= start a chat with a patient ================= */
  async function startDialog({ patient } = {}) {
    if (!canUse()) { toast(T('noperm.title', 'Your role cannot use the WhatsApp inbox'), 'bad'); return null; }
    if (!patient) return null;
    await refreshCount();
    const keys = Object.keys(myDepts);
    const number = patient.whatsapp || patient.phone;
    const link = chatLink(number);
    const v = await dialog({ title: T('start.title', 'Message {name} on WhatsApp', { name: patient.name }), form: true,
      body: html`<p>${number ? T('start.to', 'To {number}.', { number }) : T('start.no_number', 'This patient has no phone number on record.')}</p>
        ${apiReady === false ? html`<div class="notice warn">${T('start.off', 'MediCore has not connected WhatsApp yet, so this message cannot be sent from here. Use "Open in WhatsApp" to message the patient from your department phone instead.')}${link ? html`<div class="btn-row" style="margin-top:8px"><a class="btn sm" href="${link}" target="_blank" rel="noopener">${icon('message')}${T('act.open_wa', 'Open in WhatsApp')}</a></div>` : ''}</div>` : ''}
        <p class="muted sm">${T('start.rule', 'WhatsApp only allows free text within 24 hours of the patient writing to you, so this goes as MediCore\'s approved update message. Their replies appear in your WhatsApp inbox.')}</p>
        ${keys.length > 1 ? html`<div class="field"><label for="wa-st-d">${T('start.dept', 'Send from')}</label><select class="input" id="wa-st-d" name="dept">${keys.map(k => html`<option value="${k}">${deptLabel(k, myDepts[k])}</option>`)}</select></div>` : ''}
        <div class="field"><label for="wa-st-t">${T('start.text', 'Message')}</label><textarea class="input" id="wa-st-t" name="text" maxlength="900" required></textarea>
          <div class="hint">${T('start.hint', 'Up to 900 characters. Do not send test results, diagnoses or payment details on WhatsApp.')}</div></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('start.send', 'Send WhatsApp message'), primary: true }],
      onSubmit: async d => {
        const text = (d.text || '').trim();
        if (!text) throw err400(T('start.need', 'Write the message first'), [{ field: 'text', error: T('start.need', 'Write the message first') }]);
        try { return await api.post('/api/wa/start', { patientId: patient.id, dept: d.dept || keys[0] || undefined, text }); } catch (e) { throw explain(e); }
      } });
    if (!v) return null;
    toast(T('start.done', 'WhatsApp message sent to {name}', { name: patient.name }), 'ok');
    if (v.conversationId) MC.go(PREFIX + '/' + v.conversationId);
    return v;
  }

  function routes(prefix, opts) {
    PREFIX = prefix || '#/whatsapp'; OPTS = opts || {};
    return { [PREFIX]: inboxPage, [PREFIX + '/:id']: convPage };
  }

  MC.whatsapp = { routes, navItem, startDialog, refreshCount, chatLink, safeUrl, canUse, deptLabel, apiReady: () => apiReady };
})();
