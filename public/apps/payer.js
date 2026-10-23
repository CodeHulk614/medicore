/* MediCore HMO desk: member cover, pre-authorisations, claims review and payment.
 * Roles payer_officer (members, preauth, claims) and payer_manager (+ payer.pay, settings).
 * Desktop-heavy but every screen works on a phone. All money is kobo from the API. */
(function () {
  'use strict';
  const { html, api, qs, money, date, dateTime, cap, icon, badge, empty, figures, view, on, form, dialog, confirm, toast } = MC;
  const T = (k, en, v) => MC.t('payer.' + k, en, v);

  /* kit gap: icons inside headings, notices, badges and the wristband's 'allergies not recorded' tag have no size in mc.css */
  (function () { const s = document.createElement('style'); s.textContent = '.badge svg,.notice svg,.panel>h2 svg,h1 svg,h3 svg,p svg,.allergy-unknown svg{width:1.1em;height:1.1em;vertical-align:-.15em;flex:none}.back svg{width:20px;height:20px;flex:none}'; document.head.appendChild(s); })();
  const st = s => MC.t('status.' + s, cap(s));
  const KIND = { active: 'ok', approved: 'ok', paid: 'ok', denied: 'bad', rejected: 'bad', declined: 'bad', suspended: 'bad', ended: 'outline', pending: 'warn', queried: 'warn', submitted: 'warn', resubmitted: 'warn', under_review: 'info' };
  const sBadge = s => badge(st(s), KIND[s] || 'info');
  const can = p => !!(MC.me && (MC.me.perms || []).includes(p));
  const CATS = ['consultation', 'drug', 'lab', 'ambulance', 'delivery', 'procedure', 'other'];
  const catLabel = c => T('cat.' + c, cap(c));
  const sum = o => CATS.reduce((s, c) => s + (Number((o || {})[c]) || 0), 0);
  const tomorrowISO = () => { const d = new Date(Date.now() + 86400e3 + 3600e3); return d.toISOString().slice(0, 10); };
  const endOfNextYear = () => (new Date().getUTCFullYear() + 1) + '-12-31';
  const isoDate = s => (s ? date(Date.parse(s + 'T12:00:00Z')) : '');

  /* durations: minutes and hours from the API, shown in words */
  function fmtMin(m) {
    if (m == null) return '-';
    m = Math.max(0, Math.round(m));
    if (m < 60) return T('time.min', '{n} min', { n: m });
    if (m < 48 * 60) return T('time.hmin', '{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 });
    return T('time.days', '{n} days', { n: Math.round(m / 1440) });
  }
  const fmtHours = h => (h == null ? '-' : fmtMin(h * 60));
  const ageTone = (min, warnAt, badAt) => (min >= badAt ? 'bad' : min >= warnAt ? 'warn' : 'ok');
  const timer = (min, warnAt, badAt) => html`<span class="badge ${ageTone(min, warnAt, badAt)}">${icon('clock')}${fmtMin(min)}</span>`;

  /* fraud and quality flags, in plain words */
  const FLAG_TITLE = {
    duplicate: () => T('flag.duplicate', 'Possible duplicate'), no_evidence: () => T('flag.no_evidence', 'No proof the service happened'),
    over_limit: () => T('flag.over_limit', 'Over the limit'), frequency: () => T('flag.frequency', 'Unusually frequent'), missing_preauth: () => T('flag.missing_preauth', 'No pre-authorisation'),
  };
  const FLAG_TEXT = {
    duplicate: () => T('flag.duplicate_text', 'The same service was billed for this member at the same provider within a short time. Check that it was not charged twice.'),
    no_evidence: () => T('flag.no_evidence_text', 'The appointment, order or visit behind this bill was not marked done in MediCore, or the bill was typed in by hand. Ask the provider for proof.'),
    over_limit: () => T('flag.over_limit_text', 'This claim goes past the member\'s limit, is more than the bill, or falls outside the cover dates.'),
    frequency: () => T('flag.frequency_text', 'This member has had the same service claimed several times in the last 30 days.'),
    missing_preauth: () => T('flag.missing_preauth_text', 'The amount is above your pre-authorisation threshold and no approval was given.'),
  };
  const flagTitle = c => (FLAG_TITLE[c] ? FLAG_TITLE[c]() : cap(c));
  const flagBadges = flags => (flags || []).map(f => html`<span class="badge bad">${flagTitle(typeof f === 'string' ? f : f.code)}</span> `);

  const timeline = hist => (hist && hist.length ? html`<ol class="timeline">${hist.slice().reverse().map(h => html`<li><time>${dateTime(h.at)}</time>${h.from ? st(h.from) + ' > ' : ''}<b>${st(h.to)}</b>${h.action && h.action !== h.to ? html` <span class="muted">(${cap(h.action)})</span>` : ''}${h.reason ? html`<br><span class="muted">${h.reason}</span>` : ''}</li>`)}</ol>` : html`<p class="muted sm">${T('history.none', 'No history yet')}</p>`);
  const member = (name, dob, sex) => MC.wristband({ name: name || T('member.unnamed', 'Name not given'), dob: dob || null, sex: sex || null });
  const limitsTable = cov => html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('limits.cat', 'Category')}</th><th class="num">${T('limits.limit', 'Limit')}</th><th class="num">${T('limits.used', 'Used')}</th><th class="num">${T('limits.left', 'Left')}</th></tr></thead><tbody>
    ${CATS.map(c => html`<tr><td data-label="${T('limits.cat', 'Category')}"><b>${catLabel(c)}</b></td><td class="num" data-label="${T('limits.limit', 'Limit')}">${money((cov.limits || {})[c] || 0)}</td><td class="num" data-label="${T('limits.used', 'Used')}">${money((cov.usedKobo || {})[c] || 0)}</td><td class="num" data-label="${T('limits.left', 'Left')}">${cov.remainingKobo ? money(cov.remainingKobo[c] || 0) : '-'}</td></tr>`)}
    <tr><td data-label="${T('limits.cat', 'Category')}"><b>${T('limits.total', 'Total')}</b></td><td class="num" data-label="${T('limits.limit', 'Limit')}"><b>${money(sum(cov.limits))}</b></td><td class="num" data-label="${T('limits.used', 'Used')}"><b>${money(sum(cov.usedKobo))}</b></td><td class="num" data-label="${T('limits.left', 'Left')}"><b>${cov.remainingKobo ? money(sum(cov.remainingKobo)) : '-'}</b></td></tr></tbody></table></div>`;
  const limitFields = (prefix, cur) => html`<div class="fields two">${CATS.map(c => html`<div class="field"><label for="${prefix}-${c}">${T('limits.field', '{cat} limit (NGN)', { cat: catLabel(c) })}</label><input class="input" id="${prefix}-${c}" name="lim_${c}" type="number" min="0" step="100" inputmode="decimal" data-kobo value="${cur && cur[c] != null ? cur[c] / 100 : ''}" placeholder="0"></div>`)}</div>`;
  const readLimits = d => Object.fromEntries(CATS.map(c => [c, Number(d['lim_' + c]) || 0]));

  /* ================= dashboard ================= */
  async function dashboard({ stale }) {
    const d = await api.get('/api/payer/dashboard');
    if (stale()) return;
    const provName = Object.fromEntries((d.byProvider || []).map(p => [p.providerOrgId, p.providerName]));
    const order = ['submitted', 'resubmitted', 'under_review', 'queried', 'approved', 'paid', 'denied'];
    const qmax = Math.max(1, ...order.map(s => d.queue[s] || 0));
    MC.navCount('#/claims', d.openClaims); MC.navCount('#/preauths', d.preauths.pending);
    view(html`<div class="page-head"><div><h1>${T('dash.title', 'HMO desk')}</h1><p>${MC.me.org.name} | ${T('dash.sub', 'Claims, pre-authorisations and members at a glance')}</p></div>
      <div class="actions"><a class="btn" href="#/preauths">${icon('shield')}${T('dash.to_preauths', 'Pre-authorisations')}</a><a class="btn primary" href="#/claims">${icon('file')}${T('dash.to_claims', 'Review claims')}</a></div></div>
      ${figures([
        { value: String(d.openClaims), label: T('dash.open', 'Open claims') },
        { value: fmtHours(d.oldestOpenHours), label: T('dash.oldest', 'Oldest open claim'), tone: d.oldestOpenHours > 72 ? 'bad' : d.oldestOpenHours > 24 ? 'warn' : '' },
        { value: fmtHours(d.avgTurnaroundHours), label: T('dash.turnaround', 'Average claim turnaround') },
        { value: String(d.flaggedOpen), label: T('dash.flagged', 'Flagged open claims'), tone: d.flaggedOpen ? 'warn' : '' },
        { value: String(d.preauths.pending), label: T('dash.pa_pending', 'Pre-authorisations waiting'), tone: d.preauths.oldestPendingMinutes > 60 ? 'warn' : '' },
        { value: fmtMin(d.preauths.avgTurnaroundMinutes), label: T('dash.pa_turnaround', 'Average pre-authorisation reply') },
      ])}
      ${figures([
        { value: money(d.totals.claimedKobo), label: T('dash.claimed', 'Claimed') },
        { value: money(d.totals.approvedKobo), label: T('dash.approved', 'Approved') },
        { value: money(d.totals.paidKobo), label: T('dash.paid', 'Paid') },
        { value: money(d.totals.approvedUnpaidKobo), label: T('dash.unpaid', 'Approved, not yet paid'), tone: d.totals.approvedUnpaidKobo ? 'warn' : '' },
      ])}
      <div class="grid two">
        <section class="panel"><h2>${T('dash.queue', 'Claims by status')}</h2><div class="bars">${order.map(s => html`<a class="bar" href="#/claims?status=${s}" style="color:inherit;text-decoration:none"><span>${st(s)}</span><div class="track"><div class="fill" style="width:${Math.round((d.queue[s] || 0) / qmax * 100)}%"></div></div><span class="v">${d.queue[s] || 0}</span></a>`)}</div></section>
        <section class="panel"><h2>${T('dash.flagged_title', 'Flagged claims to check')}</h2>
          ${d.flagged.length ? html`<ul class="list">${d.flagged.map(c => html`<li><div class="grow"><a class="title" href="#/claims/${c.id}">${c.number}</a><span class="sub">${provName[c.providerOrgId] || ''} | ${money(c.claimedKobo)} | ${T('dash.waiting', 'waiting {t}', { t: fmtHours(c.ageHours) })}</span><span>${flagBadges(c.flags)}</span></div></li>`)}</ul>`
            : empty({ icon: 'shield', title: T('dash.no_flagged', 'No flagged claims'), body: T('dash.no_flagged_sub', 'Claims with duplicate, missing evidence or limit problems appear here.') })}</section>
      </div>
      <section class="panel flush"><h2>${T('dash.by_provider', 'Totals by provider')}</h2>
        ${d.byProvider.length ? html`<div class="table-wrap" style="border:0"><table class="t stack-sm"><thead><tr><th>${T('col.provider', 'Provider')}</th><th class="num">${T('col.claims', 'Claims')}</th><th class="num">${T('dash.claimed', 'Claimed')}</th><th class="num">${T('dash.approved', 'Approved')}</th><th class="num">${T('dash.paid', 'Paid')}</th><th class="num">${T('col.flagged', 'Flagged')}</th></tr></thead><tbody>
          ${d.byProvider.map(p => html`<tr><td data-label="${T('col.provider', 'Provider')}"><a href="#/claims?providerOrgId=${p.providerOrgId}"><b>${p.providerName || p.providerOrgId}</b></a></td><td class="num" data-label="${T('col.claims', 'Claims')}">${p.claims}</td><td class="num" data-label="${T('dash.claimed', 'Claimed')}">${money(p.claimedKobo)}</td><td class="num" data-label="${T('dash.approved', 'Approved')}">${money(p.approvedKobo)}</td><td class="num" data-label="${T('dash.paid', 'Paid')}">${money(p.paidKobo)}</td><td class="num" data-label="${T('col.flagged', 'Flagged')}">${p.flagged ? badge(String(p.flagged), 'warn') : '0'}</td></tr>`)}</tbody></table></div>`
          : empty({ icon: 'building', title: T('dash.no_claims', 'No claims yet'), body: T('dash.no_claims_sub', 'Providers submit claims from paid bills. They show here by provider.') })}</section>
      <section class="panel"><h2>${T('dash.utilisation', 'Member utilisation')}</h2><p class="muted sm">${T('dash.members_line', '{a} active members, {p} pending', { a: d.members.active, p: d.members.pending })}</p>
        ${d.members.utilisation.length ? html`<div class="bars">${d.members.utilisation.map(u => html`<a class="bar" href="#/members/${u.coverageId}" style="color:inherit;text-decoration:none"><span>${u.name || u.memberNo}<br><span class="xs muted">${u.memberNo}</span></span><div class="track"><div class="fill" style="width:${Math.min(100, u.pct)}%"></div></div><span class="v">${u.pct}%<br><span class="xs muted">${money(u.usedKobo)}</span></span></a>`)}</div>`
          : empty({ icon: 'users', title: T('dash.no_members', 'No active members yet') })}</section>`);
    MC.poll(async () => { const n = await api.get('/api/payer/dashboard'); MC.navCount('#/claims', n.openClaims); MC.navCount('#/preauths', n.preauths.pending); }, 30000);
  }

  /* ================= members and cover ================= */
  const MEMBER_TABS = ['pending', 'active', 'suspended', 'ended', 'rejected', 'declined'];
  async function members({ query, stale }) {
    const status = MEMBER_TABS.includes(query.status) ? query.status : (query.status === 'all' ? '' : 'pending');
    const rows = await api.get('/api/payer/coverages' + qs({ status, q: query.q, limit: 300 }));
    if (stale()) return;
    const verify = rows.filter(c => c.status === 'pending' && c.patientConfirmed && !c.payerVerified);
    const waiting = rows.filter(c => c.status === 'pending' && !c.patientConfirmed);
    const rest = rows.filter(c => c.status !== 'pending');
    const table = list => html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('col.member', 'Member')}</th><th>${T('col.memberno', 'Member number')}</th><th>${T('col.phone', 'Phone')}</th><th>${T('col.plan', 'Plan')}</th><th>${T('col.valid', 'Valid to')}</th><th>${T('col.status', 'Status')}</th><th></th></tr></thead><tbody>
      ${list.map(c => html`<tr><td data-label="${T('col.member', 'Member')}"><b>${c.member.name || T('member.unnamed', 'Name not given')}</b></td><td data-label="${T('col.memberno', 'Member number')}">${c.memberNo}</td><td data-label="${T('col.phone', 'Phone')}">${c.member.phone || '-'}</td><td data-label="${T('col.plan', 'Plan')}">${c.planName || '-'}</td><td data-label="${T('col.valid', 'Valid to')}">${c.validTo ? isoDate(c.validTo) : '-'}</td><td data-label="${T('col.status', 'Status')}">${sBadge(c.status)}</td>
        <td class="num"><a class="btn sm ${c.status === 'pending' && c.patientConfirmed && !c.payerVerified ? 'primary' : ''}" href="#/members/${c.id}">${c.status === 'pending' && c.patientConfirmed && !c.payerVerified ? T('members.verify', 'Verify') : T('members.open', 'Open')}</a></td></tr>`)}</tbody></table></div>`;
    view(html`<div class="page-head"><div><h1>${T('members.title', 'Members and cover')}</h1><p>${T('members.sub', 'Verify cover members add in the MediCore app, and manage plans and limits.')}</p></div>
      ${can('payer.members') ? html`<div class="actions"><a class="btn primary" href="#/members/enrol">${icon('plus')}${T('members.enrol', 'Enrol members')}</a></div>` : ''}</div>
      <nav class="tabs" aria-label="${T('members.filter', 'Filter by status')}">${MEMBER_TABS.concat(['all']).map(s => html`<a href="#/members?status=${s}" aria-current="${(s === 'all' ? !status : status === s) ? 'page' : 'false'}">${s === 'all' ? T('members.all', 'All') : st(s)}</a>`)}</nav>
      <form data-form="member-search" class="row wrap" style="margin-bottom:16px" role="search"><div class="search" style="flex:1;min-width:200px"><label class="sr-only" for="ms-q">${T('members.search', 'Search members')}</label>${icon('search')}<input class="input" id="ms-q" name="q" value="${query.q || ''}" placeholder="${T('members.search_ph', 'Member number, name or phone')}"><input type="hidden" name="status" value="${query.status || ''}"></div><button class="btn" type="submit">${T('members.search_btn', 'Search')}</button></form>
      ${!rows.length ? empty({ icon: 'users', title: status === 'pending' ? T('members.none_pending', 'No cover waiting for you') : T('members.none', 'No members found'), body: status === 'pending' ? T('members.none_pending_sub', 'When a member adds your HMO in the MediCore app, it appears here to verify.') : T('members.none_sub', 'Try another status or search.') }) : ''}
      ${verify.length ? html`<section><h2>${T('members.to_verify', 'Waiting for you to verify ({n})', { n: verify.length })}</h2><p class="muted sm">${T('members.to_verify_sub', 'The member added this cover in the app. Check the member number, then activate it with a plan and limits, or reject it.')}</p>${table(verify)}</section>` : ''}
      ${waiting.length ? html`<section style="margin-top:24px"><h2>${T('members.waiting', 'Waiting for the member to confirm ({n})', { n: waiting.length })}</h2><p class="muted sm">${T('members.waiting_sub', 'You enrolled these members. Cover starts when they confirm in the MediCore app.')}</p>${table(waiting)}</section>` : ''}
      ${rest.length ? html`<section style="margin-top:${verify.length || waiting.length ? '24px' : '0'}">${table(rest)}</section>` : ''}`);
    form('member-search', d => MC.go('#/members' + qs({ status: d.status, q: d.q })));
  }

  async function memberPage({ params, stale }) {
    let c;
    try { c = await api.get('/api/payer/coverages/' + encodeURIComponent(params.id)); }
    catch (e) { if (e.status === 404) return view(html`<a class="back" href="#/members">${icon('left')}${T('members.title', 'Members and cover')}</a>${empty({ icon: 'users', title: T('member.not_found', 'Cover not found'), body: T('member.not_found_sub', 'It may belong to another HMO or have been removed. Go back to the member list.') })}`); throw e; }
    if (stale()) return;
    const needsVerify = c.status === 'pending' && c.patientConfirmed && !c.payerVerified;
    const waitMember = c.status === 'pending' && !c.patientConfirmed;
    const m = can('payer.members');
    view(html`<a class="back" href="#/members">${icon('left')}${T('members.title', 'Members and cover')}</a>
      ${member(c.member.name, c.member.dob, c.member.sex)}
      <div class="page-head"><div><h1>${c.memberNo}</h1><p>${c.planName || T('member.no_plan', 'No plan name yet')} | ${sBadge(c.status)}</p></div>
        <div class="actions">${m ? html`
          ${needsVerify ? html`<button class="btn primary" data-action="cov-activate">${icon('check')}${T('member.activate', 'Activate cover')}</button><button class="btn" data-action="cov-reject">${icon('x')}${T('member.reject', 'Reject')}</button>` : ''}
          ${c.status === 'active' || c.status === 'suspended' ? html`<button class="btn" data-action="cov-limits">${icon('edit')}${T('member.edit_limits', 'Change plan and limits')}</button>` : ''}
          ${c.status === 'active' ? html`<button class="btn" data-action="cov-suspend">${T('member.suspend', 'Suspend')}</button>` : ''}
          ${c.status === 'suspended' ? html`<button class="btn primary" data-action="cov-reactivate">${T('member.reactivate', 'Reactivate')}</button>` : ''}
          ${c.status === 'active' || c.status === 'suspended' ? html`<button class="btn danger" data-action="cov-end">${T('member.end', 'End cover')}</button>` : ''}` : ''}</div></div>
      ${needsVerify ? html`<div class="notice warn">${T('member.verify_note', 'The member added this cover in the MediCore app. Check that {no} is a real member of your HMO before you activate it.', { no: c.memberNo })}</div>` : ''}
      ${waitMember ? html`<div class="notice">${T('member.wait_note', 'You enrolled this member. Cover becomes active when they confirm it in the MediCore app.')}</div>` : ''}
      ${c.statusReason ? html`<div class="notice">${T('member.reason', 'Reason: {r}', { r: c.statusReason })}</div>` : ''}
      <div class="grid side-r">
        <div>
          <section class="panel"><h2>${T('member.limits', 'Limits and use')}</h2>${c.limits ? limitsTable(c) : html`<p class="muted">${T('member.no_limits', 'No limits set yet. They are set when you activate the cover.')}</p>`}</section>
          <section class="panel flush"><h2>${T('member.claims', 'Claims for this member')}</h2>${c.claims.length ? html`<ul class="list">${c.claims.map(x => html`<a href="#/claims/${x.id}"><div class="grow"><span class="title">${x.number}</span><span class="sub">${dateTime(x.submittedAt)} | ${T('member.claimed', 'Claimed {a}', { a: money(x.claimedKobo) })}${x.approvedKobo != null ? ' | ' + T('member.approved_amt', 'approved {a}', { a: money(x.approvedKobo) }) : ''}</span></div>${sBadge(x.status)}</a>`)}</ul>` : empty({ icon: 'file', title: T('member.no_claims', 'No claims yet') })}</section>
        </div>
        <div>
          <section class="panel"><h2>${T('member.details', 'Cover details')}</h2><dl class="kv">
            <dt>${T('col.memberno', 'Member number')}</dt><dd><b>${c.memberNo}</b></dd>
            <dt>${T('col.plan', 'Plan')}</dt><dd>${c.planName || '-'}</dd>
            <dt>${T('col.valid', 'Valid to')}</dt><dd>${c.validTo ? isoDate(c.validTo) : '-'}</dd>
            <dt>${T('col.phone', 'Phone')}</dt><dd>${c.member.phone || '-'}</dd>
            <dt>${T('member.added_by', 'Added by')}</dt><dd>${c.enrolledBy === 'payer' ? T('member.by_hmo', 'Your HMO') : T('member.by_member', 'The member, in the app')}</dd>
            <dt>${T('member.confirmed', 'Member confirmed')}</dt><dd>${c.patientConfirmed ? T('yes', 'Yes') : T('no', 'No')}</dd>
            <dt>${T('member.verified', 'HMO verified')}</dt><dd>${c.payerVerified ? T('yes', 'Yes') : T('no', 'No')}</dd>
          </dl></section>
          <section class="panel"><h2>${T('history', 'History')}</h2>${timeline(c.history)}</section>
        </div>
      </div>`);

    const reasonDlg = (title, body, ok, path, danger) => dialog({ title, form: true, body: html`<p>${body}</p><div class="field"><label for="cv-r">${T('reason', 'Reason')}</label><textarea class="input" id="cv-r" name="reason" required minlength="3" maxlength="300"></textarea></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: ok, primary: true, danger }], onSubmit: d => api.post('/api/payer/coverages/' + c.id + '/' + path, { reason: d.reason }) });
    on('cov-activate', async () => {
      const r = await dialog({ title: T('member.activate_title', 'Activate cover {no}', { no: c.memberNo }), form: true, wide: true, body: html`
        <div class="fields two"><div class="field"><label for="ca-p">${T('col.plan', 'Plan')}</label><input class="input" id="ca-p" name="planName" maxlength="80" value="${c.planName || ''}" placeholder="${T('member.plan_ph', 'e.g. Harbor Gold')}"></div>
        <div class="field"><label for="ca-v">${T('col.valid', 'Valid to')}</label><input class="input" id="ca-v" name="validTo" type="date" min="${MC.todayISO()}" value="${endOfNextYear()}" required></div></div>
        <p class="muted sm">${T('member.limits_hint', 'Yearly limit per category in naira. Leave 0 for categories the plan does not cover.')}</p>${limitFields('ca', null)}`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('member.activate_next', 'Review and activate'), primary: true }],
        onSubmit: async d => {
          const limits = readLimits(d);
          if (!d.validTo) throw new MC.ApiError(400, { error: T('member.need_valid', 'Choose the date the cover ends'), details: [{ field: 'validTo', error: T('member.need_valid', 'Choose the date the cover ends') }] });
          if (!sum(limits)) throw new MC.ApiError(400, { error: T('member.need_limit', 'Set at least one limit above zero') });
          const ok = await confirm({ title: T('member.activate_q', 'Activate cover {no}?', { no: c.memberNo }), body: T('member.activate_body', '{name} will be covered up to {total} in total until {date}. Providers can bill your HMO straight away.', { name: c.member.name || c.memberNo, total: money(sum(limits)), date: isoDate(d.validTo) }), ok: T('member.activate', 'Activate cover') });
          if (!ok) return false;
          return api.post('/api/payer/coverages/' + c.id + '/activate', { limits, validTo: d.validTo, planName: d.planName || undefined });
        } });
      if (r) { toast(T('member.activated', 'Cover activated'), 'ok'); MC.render(); }
    });
    on('cov-reject', async () => { if (await reasonDlg(T('member.reject_title', 'Reject cover {no}?', { no: c.memberNo }), T('member.reject_body', 'The member is told the cover was not verified. This cannot be undone; they can add it again.'), T('member.reject', 'Reject'), 'reject', true)) { toast(T('member.rejected', 'Cover rejected'), 'ok'); MC.render(); } });
    on('cov-suspend', async () => { if (await reasonDlg(T('member.suspend_title', 'Suspend cover {no}?', { no: c.memberNo }), T('member.suspend_body', 'Providers cannot use this cover until you reactivate it. Limits and use are kept.'), T('member.suspend', 'Suspend'), 'suspend', true)) { toast(T('member.suspended', 'Cover suspended'), 'ok'); MC.render(); } });
    on('cov-end', async () => { if (await reasonDlg(T('member.end_title', 'End cover {no}?', { no: c.memberNo }), T('member.end_body', 'The cover ends for good and cannot be reactivated. Claims already submitted can still be paid.'), T('member.end', 'End cover'), 'end', true)) { toast(T('member.ended', 'Cover ended'), 'ok'); MC.render(); } });
    on('cov-reactivate', async () => {
      if (!(await confirm({ title: T('member.reactivate_q', 'Reactivate cover {no}?', { no: c.memberNo }), body: T('member.reactivate_body', 'Providers can bill this cover again, up to the remaining limits.'), ok: T('member.reactivate', 'Reactivate') }))) return;
      await api.post('/api/payer/coverages/' + c.id + '/reactivate'); toast(T('member.reactivated', 'Cover reactivated'), 'ok'); MC.render();
    });
    on('cov-limits', async () => {
      const r = await dialog({ title: T('member.edit_limits', 'Change plan and limits'), form: true, wide: true, body: html`
        <div class="fields two"><div class="field"><label for="cl-p">${T('col.plan', 'Plan')}</label><input class="input" id="cl-p" name="planName" maxlength="80" value="${c.planName || ''}"></div>
        <div class="field"><label for="cl-v">${T('col.valid', 'Valid to')}</label><input class="input" id="cl-v" name="validTo" type="date" value="${c.validTo || ''}"></div></div>${limitFields('cl', c.limits)}`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('member.save_limits', 'Save limits'), primary: true }],
        onSubmit: async d => {
          const limits = readLimits(d);
          const ok = await confirm({ title: T('member.limits_q', 'Change limits for {no}?', { no: c.memberNo }), body: T('member.limits_body', 'Total limit changes from {a} to {b}. Money already used stays counted.', { a: money(sum(c.limits)), b: money(sum(limits)) }), ok: T('member.save_limits', 'Save limits') });
          if (!ok) return false;
          return api.post('/api/payer/coverages/' + c.id + '/limits', { limits, validTo: d.validTo || undefined, planName: d.planName || undefined });
        } });
      if (r) { toast(T('member.limits_saved', 'Limits saved'), 'ok'); MC.render(); }
    });
  }

  /* bulk enrolment by phone list */
  function parseList(text) {
    return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map((l, i) => { const p = l.split(/\s*[,;\t]\s*/); return { line: i + 1, phone: p[0] || '', memberNo: (p[1] || '').toUpperCase(), name: p.slice(2).join(' ') || undefined }; });
  }
  async function enrolPage() {
    if (!can('payer.members')) return view(empty({ icon: 'lock', title: T('enrol.no_perm', 'You cannot enrol members'), body: T('enrol.no_perm_sub', 'Ask your HMO manager for the members permission.') }));
    view(html`<a class="back" href="#/members">${icon('left')}${T('members.title', 'Members and cover')}</a><div class="page-head"><div><h1>${T('enrol.title', 'Enrol members')}</h1><p>${T('enrol.sub', 'Add up to 200 members at once. Each person confirms the cover in the MediCore app before it becomes active.')}</p></div></div>
      <form class="panel" data-form="enrol" novalidate>
        <div class="field"><label for="en-l">${T('enrol.list', 'Members, one per line')}</label><textarea class="input" id="en-l" name="list" rows="8" required placeholder="08031234567, HH-200001, Ngozi Ade&#10;08039876543, HH-200002"></textarea><div class="hint">${T('enrol.list_hint', 'Phone number, member number, then the name (optional), separated by commas.')}</div></div>
        <div class="fields two"><div class="field"><label for="en-p">${T('col.plan', 'Plan')}</label><input class="input" id="en-p" name="planName" maxlength="80"></div>
        <div class="field"><label for="en-v">${T('col.valid', 'Valid to')}</label><input class="input" id="en-v" name="validTo" type="date" min="${tomorrowISO()}" value="${endOfNextYear()}" required></div></div>
        <p class="muted sm">${T('member.limits_hint', 'Yearly limit per category in naira. Leave 0 for categories the plan does not cover.')}</p>${limitFields('en', null)}
        <div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${T('enrol.review', 'Review and enrol')}</button></form>
      <div id="enrol-out"></div>`);
    form('enrol', async d => {
      const rows = parseList(d.list); const limits = readLimits(d);
      if (!rows.length) throw new MC.ApiError(400, { error: T('enrol.empty', 'Add at least one member') });
      if (rows.length > 200) throw new MC.ApiError(400, { error: T('enrol.too_many', 'At most 200 members at a time. You entered {n}.', { n: rows.length }) });
      if (!d.validTo) throw new MC.ApiError(400, { error: T('member.need_valid', 'Choose the date the cover ends') });
      if (!sum(limits)) throw new MC.ApiError(400, { error: T('member.need_limit', 'Set at least one limit above zero') });
      if (!(await confirm({ title: T('enrol.q', 'Enrol {n} members?', { n: rows.length }), body: T('enrol.q_body', 'Each member gets cover up to {total} in total until {date}, once they confirm in the MediCore app.', { total: money(sum(limits)), date: isoDate(d.validTo) }), ok: T('enrol.go', 'Enrol members') }))) return;
      const r = await api.post('/api/payer/coverages/enrol', { members: rows.map(x => ({ phone: x.phone, memberNo: x.memberNo, name: x.name, planName: d.planName || undefined, limits, validTo: d.validTo })) });
      toast(T('enrol.done', '{n} enrolled, {f} not enrolled', { n: r.enrolled, f: r.failed }), r.failed ? '' : 'ok');
      view(html`<section class="panel flush"><h2>${T('enrol.results', 'Results')}</h2><div class="table-wrap" style="border:0"><table class="t stack-sm"><thead><tr><th>${T('enrol.line', 'Line')}</th><th>${T('col.phone', 'Phone')}</th><th>${T('col.memberno', 'Member number')}</th><th>${T('col.status', 'Status')}</th></tr></thead><tbody>
        ${r.results.map(x => { const row = rows[x.index] || {}; return html`<tr><td data-label="${T('enrol.line', 'Line')}">${row.line}</td><td data-label="${T('col.phone', 'Phone')}">${row.phone}</td><td data-label="${T('col.memberno', 'Member number')}">${x.memberNo || row.memberNo}</td><td data-label="${T('col.status', 'Status')}">${x.ok ? html`${badge(T('enrol.ok', 'Enrolled, waiting for the member'), 'ok')} <a href="#/members/${x.coverageId}">${T('members.open', 'Open')}</a>` : html`${badge(T('enrol.fail', 'Not enrolled'), 'bad')} <span class="sm">${x.error}</span>`}</td></tr>`; })}</tbody></table></div></section>`, document.getElementById('enrol-out'));
    });
  }

  /* ================= pre-authorisations ================= */
  const PA_TABS = ['pending', 'queried', 'approved', 'denied'];
  async function preauths({ query, stale }) {
    const status = PA_TABS.includes(query.status) ? query.status : 'pending';
    const load = () => api.get('/api/payer/preauths' + qs({ status, limit: 200 }));
    const rows = await load();
    if (stale()) return;
    const paint = list => view(html`<div class="page-head"><div><h1>${T('pa.title', 'Pre-authorisations')}</h1><p>${T('pa.sub', 'Providers ask before expensive care. The oldest request is first; reply quickly, the patient may be waiting.')}</p></div></div>
      <nav class="tabs" aria-label="${T('pa.filter', 'Filter by status')}">${PA_TABS.map(s => html`<a href="#/preauths?status=${s}" aria-current="${status === s ? 'page' : 'false'}">${st(s)}</a>`)}</nav>
      ${list.length ? html`<ul class="list">${list.map(p => html`<a href="#/preauths/${p.id}"><div class="grow"><span class="title">${p.patientName || p.memberNo} <span class="muted">| ${p.number}</span></span><span class="sub">${p.providerName || ''} | ${p.diagnosis ? (p.diagnosis.code ? p.diagnosis.code + ' ' : '') + p.diagnosis.text : ''}</span><span class="sub">${p.services.map(s => s.name).join(', ')}</span></div>
        <span class="end"><b>${money(p.requestedKobo)}</b><br>${p.status === 'pending' ? timer(p.waitingMinutes, 30, 120) : p.status === 'approved' ? html`<span class="xs">${p.authCode}</span>` : sBadge(p.status)}</span></a>`)}</ul>`
        : empty({ icon: 'shield', title: status === 'pending' ? T('pa.none', 'No requests waiting') : T('pa.none_status', 'Nothing here'), body: status === 'pending' ? T('pa.none_sub', 'New pre-authorisation requests from providers appear here.') : '' })}`);
    paint(rows);
    if (status === 'pending') MC.navCount('#/preauths', rows.length);
    MC.poll(async () => { const n = await load(); if (status === 'pending') MC.navCount('#/preauths', n.length); if (!document.querySelector('dialog.dlg')) paint(n); }, 20000);
  }

  async function preauthPage({ params, stale }) {
    let p;
    let validDays = 30;
    try { [p, validDays] = await Promise.all([api.get('/api/payer/preauths/' + encodeURIComponent(params.id)), api.get('/api/payer/settings').then(x => x.preauthValidDays).catch(() => 30)]); }
    catch (e) { if (e.status === 404) return view(html`<a class="back" href="#/preauths">${icon('left')}${T('pa.title', 'Pre-authorisations')}</a>${empty({ icon: 'shield', title: T('pa.not_found', 'Request not found'), body: T('pa.not_found_sub', 'It may belong to another HMO. Go back to the inbox.') })}`); throw e; }
    if (stale()) return;
    const act = p.status === 'pending' && can('payer.preauth');
    view(html`<a class="back" href="#/preauths">${icon('left')}${T('pa.title', 'Pre-authorisations')}</a>
      ${member(p.patientName)}
      <div class="page-head"><div><h1>${T('pa.req', 'Request {n}', { n: p.number })}</h1><p>${p.providerName || ''} | ${p.memberNo} | ${sBadge(p.status)} ${p.status === 'pending' ? timer(p.waitingMinutes, 30, 120) : ''}</p></div>
        ${act ? html`<div class="actions"><button class="btn primary" data-action="pa-approve">${icon('check')}${T('pa.approve', 'Approve')}</button><button class="btn" data-action="pa-query">${icon('message')}${T('pa.query', 'Ask a question')}</button><button class="btn danger" data-action="pa-deny">${T('pa.deny', 'Deny')}</button></div>` : ''}</div>
      ${p.status === 'queried' ? html`<div class="notice warn"><b>${T('pa.asked', 'You asked')}:</b> ${p.question}<br>${T('pa.wait_answer', 'Waiting for the provider to answer.')}</div>` : ''}
      ${p.answer ? html`<div class="notice"><b>${T('pa.answer', 'Provider answered')}:</b> ${p.answer}</div>` : ''}
      ${p.status === 'approved' ? html`<div class="notice ok">${T('pa.approved_note', 'Approved {a}. Authorisation code {c}, valid until {d}.', { a: money(p.approvedKobo), c: p.authCode, d: date(p.validUntil) })}${p.usedBillId ? ' ' + T('pa.used', 'Already used on a bill.') : ''}</div>` : ''}
      ${p.status === 'denied' ? html`<div class="notice bad">${T('pa.denied_note', 'Denied: {r}', { r: p.denyReason || '' })}</div>` : ''}
      <div class="grid side-r"><div>
        <section class="panel flush"><h2>${T('pa.services', 'Services requested')}</h2><div class="table-wrap" style="border:0"><table class="t stack-sm"><thead><tr><th>${T('col.service', 'Service')}</th><th>${T('limits.cat', 'Category')}</th><th class="num">${T('col.qty', 'Qty')}</th><th class="num">${T('col.amount', 'Amount')}</th><th>${T('pa.price_from', 'Price from')}</th></tr></thead><tbody>
          ${p.services.map(s => html`<tr><td data-label="${T('col.service', 'Service')}"><b>${s.name}</b><br><span class="xs muted">${s.code}</span></td><td data-label="${T('limits.cat', 'Category')}">${catLabel(s.category)}</td><td class="num" data-label="${T('col.qty', 'Qty')}">${s.qty}</td><td class="num" data-label="${T('col.amount', 'Amount')}">${money(s.amountKobo)}</td><td data-label="${T('pa.price_from', 'Price from')}">${s.priced === 'price_list' ? badge(T('pa.price_list', 'Price list'), 'ok') : badge(T('pa.quoted', 'Quoted by provider'), 'warn')}</td></tr>`)}
          <tr><td data-label="${T('col.service', 'Service')}"><b>${T('limits.total', 'Total')}</b></td><td></td><td></td><td class="num" data-label="${T('col.amount', 'Amount')}"><b>${money(p.requestedKobo)}</b></td><td></td></tr></tbody></table></div></section>
        <section class="panel"><h2>${T('pa.clinical', 'Clinical reason')}</h2><dl class="kv"><dt>${T('col.diagnosis', 'Diagnosis')}</dt><dd>${p.diagnosis ? html`${p.diagnosis.code ? html`<b>${p.diagnosis.code}</b> ` : ''}${p.diagnosis.text}` : '-'}</dd><dt>${T('pa.note', 'Note')}</dt><dd>${p.note || '-'}</dd><dt>${T('pa.received', 'Received')}</dt><dd>${dateTime(p.createdAt)}</dd>${p.decidedAt ? html`<dt>${T('pa.decided', 'Decided')}</dt><dd>${dateTime(p.decidedAt)} (${fmtMin(p.turnaroundMinutes)})</dd>` : ''}</dl></section>
      </div><div>
        <section class="panel"><h2>${T('pa.cover', 'Member cover')}</h2>${p.cover ? html`<p>${sBadge(p.cover.status)} ${T('pa.valid_to', 'valid to {d}', { d: isoDate(p.cover.validTo) })}</p>${limitsTable(p.cover)}` : html`<p class="muted">${T('pa.no_cover', 'Cover record not found')}</p>`}</section>
        <section class="panel"><h2>${T('history', 'History')}</h2>${timeline(p.history)}</section>
      </div></div>`);
    const textDlg = (title, body, label, name, ok, path, danger) => dialog({ title, form: true, body: html`<p>${body}</p><div class="field"><label for="pa-t">${label}</label><textarea class="input" id="pa-t" name="${name}" required minlength="3" maxlength="500"></textarea></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: ok, primary: true, danger }], onSubmit: d => api.post('/api/payer/preauths/' + p.id + '/' + path, { [name]: d[name] }) });
    on('pa-approve', async () => {
      const r = await dialog({ title: T('pa.approve_title', 'Approve {n}', { n: p.number }), form: true, body: html`
        <div class="field"><label for="pa-a">${T('pa.amount', 'Amount to approve (NGN)')}</label><input class="input" id="pa-a" name="approvedKobo" type="number" min="1" max="${p.requestedKobo / 100}" step="0.01" data-kobo value="${p.requestedKobo / 100}" required><div class="hint">${T('pa.amount_hint', 'Up to {a}, the amount requested.', { a: money(p.requestedKobo) })}</div></div>
        <div class="field"><label for="pa-c">${T('pa.code', 'Authorisation code (optional)')}</label><input class="input" id="pa-c" name="authCode" maxlength="30" pattern="[A-Za-z0-9/-]+"><div class="hint">${T('pa.code_hint', 'Leave empty and MediCore makes one.')}</div></div>
        <div class="field"><label for="pa-n">${T('pa.note_opt', 'Note to the provider (optional)')}</label><textarea class="input" id="pa-n" name="note" maxlength="500"></textarea></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pa.approve_next', 'Review and approve'), primary: true }],
        onSubmit: async d => {
          if (!d.approvedKobo || d.approvedKobo < 1 || d.approvedKobo > p.requestedKobo) throw new MC.ApiError(400, { error: T('pa.amount_bad', 'Enter an amount between {min} and {max}', { min: money(100), max: money(p.requestedKobo) }), details: [{ field: 'approvedKobo', error: T('pa.amount_bad', 'Enter an amount between {min} and {max}', { min: money(100), max: money(p.requestedKobo) }) }] });
          const part = d.approvedKobo < p.requestedKobo;
          const ok = await confirm({ title: T('pa.approve_q', 'Approve {a} for {name}?', { a: money(d.approvedKobo), name: p.patientName || p.memberNo }), body: part ? T('pa.approve_part', 'This is less than the {r} requested. {prov} can bill your HMO up to {a} on one bill in the next {days} days.', { r: money(p.requestedKobo), prov: p.providerName || '', a: money(d.approvedKobo), days: validDays }) : T('pa.approve_full', '{prov} can bill your HMO up to {a} on one bill in the next {days} days. The provider is told straight away.', { prov: p.providerName || '', a: money(d.approvedKobo), days: validDays }), ok: T('pa.approve', 'Approve') });
          if (!ok) return false;
          return api.post('/api/payer/preauths/' + p.id + '/approve', { approvedKobo: d.approvedKobo, authCode: d.authCode || undefined, note: d.note || undefined });
        } });
      if (r) { toast(T('pa.approved', 'Approved. Code {c}', { c: r.authCode }), 'ok'); MC.render(); }
    });
    on('pa-deny', async () => { if (await textDlg(T('pa.deny_title', 'Deny {n}?', { n: p.number }), T('pa.deny_body', 'The provider is told it is denied, with your reason. This cannot be undone.'), T('reason', 'Reason'), 'reason', T('pa.deny', 'Deny'), 'deny', true)) { toast(T('pa.denied', 'Request denied'), 'ok'); MC.render(); } });
    on('pa-query', async () => { if (await textDlg(T('pa.query_title', 'Ask the provider about {n}', { n: p.number }), T('pa.query_body', 'The request waits until the provider answers.'), T('pa.question', 'Question'), 'question', T('pa.send_q', 'Send question'), 'query')) { toast(T('pa.queried', 'Question sent'), 'ok'); MC.render(); } });
  }

  /* ================= claims ================= */
  const CLAIM_STATES = ['submitted', 'resubmitted', 'under_review', 'queried', 'approved', 'paid', 'denied'];
  async function claims({ query, stale }) {
    const status = CLAIM_STATES.includes(query.status) ? query.status : '';
    const [rows, dash] = await Promise.all([api.get('/api/payer/claims' + qs({ status, flagged: query.flagged === 'true' ? 'true' : undefined, providerOrgId: query.providerOrgId, limit: 300 })), api.get('/api/payer/dashboard').catch(() => null)]);
    if (stale()) return;
    const provs = dash ? dash.byProvider : [];
    view(html`<div class="page-head"><div><h1>${T('cl.title', 'Claims')}</h1><p>${T('cl.sub', 'Oldest first. Open a claim to review the lines, diagnosis and flags.')}</p></div></div>
      <form data-form="claim-filter" class="panel" novalidate><div class="fields three">
        <div class="field"><label for="cf-s">${T('col.status', 'Status')}</label><select class="input" id="cf-s" name="status"><option value="">${T('cl.any_status', 'Any status')}</option>${CLAIM_STATES.map(s => html`<option value="${s}" ${status === s ? 'selected' : ''}>${st(s)}</option>`)}</select></div>
        <div class="field"><label for="cf-p">${T('col.provider', 'Provider')}</label><select class="input" id="cf-p" name="providerOrgId"><option value="">${T('cl.any_provider', 'Any provider')}</option>${provs.map(p => html`<option value="${p.providerOrgId}" ${query.providerOrgId === p.providerOrgId ? 'selected' : ''}>${p.providerName || p.providerOrgId}</option>`)}</select></div>
        <div class="field"><span class="label">${T('col.flags', 'Flags')}</span><label class="check"><input type="checkbox" name="flagged" ${query.flagged === 'true' ? 'checked' : ''}><span>${T('cl.only_flagged', 'Only flagged claims')}</span></label></div></div>
        <button class="btn" type="submit">${icon('search')}${T('cl.apply', 'Show claims')}</button></form>
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('col.claim', 'Claim')}</th><th>${T('col.member', 'Member')}</th><th>${T('col.provider', 'Provider')}</th><th>${T('col.service_date', 'Service date')}</th><th class="num">${T('col.claimed', 'Claimed')}</th><th class="num">${T('col.approved', 'Approved')}</th><th>${T('col.flags', 'Flags')}</th><th>${T('col.status', 'Status')}</th><th>${T('col.age', 'Age')}</th></tr></thead><tbody>
        ${rows.map(c => html`<tr><td data-label="${T('col.claim', 'Claim')}"><a href="#/claims/${c.id}"><b>${c.number}</b></a></td><td data-label="${T('col.member', 'Member')}">${c.patientName || ''}<br><span class="xs muted">${c.memberNo}</span></td><td data-label="${T('col.provider', 'Provider')}">${c.providerName || ''}</td><td data-label="${T('col.service_date', 'Service date')}">${isoDate(c.serviceDate)}</td><td class="num" data-label="${T('col.claimed', 'Claimed')}">${money(c.claimedKobo)}</td><td class="num" data-label="${T('col.approved', 'Approved')}">${c.approvedKobo != null ? money(c.approvedKobo) : '-'}</td><td data-label="${T('col.flags', 'Flags')}">${c.flagged ? flagBadges(c.flags) : html`<span class="muted">${T('cl.no_flags', 'None')}</span>`}</td><td data-label="${T('col.status', 'Status')}">${sBadge(c.status)}</td><td data-label="${T('col.age', 'Age')}">${['submitted', 'resubmitted', 'under_review', 'queried'].includes(c.status) ? timer(c.ageHours * 60, 24 * 60, 72 * 60) : fmtHours(c.turnaroundHours)}</td></tr>`)}</tbody></table></div>`
        : empty({ icon: 'file', title: T('cl.none', 'No claims match'), body: T('cl.none_sub', 'Change the filters, or wait for providers to submit claims from paid bills.') })}`);
    form('claim-filter', d => MC.go('#/claims' + qs({ status: d.status, providerOrgId: d.providerOrgId, flagged: d.flagged ? 'true' : undefined })));
  }

  async function claimPage({ params, stale }) {
    let c;
    try { c = await api.get('/api/payer/claims/' + encodeURIComponent(params.id)); }
    catch (e) { if (e.status === 404) return view(html`<a class="back" href="#/claims">${icon('left')}${T('cl.title', 'Claims')}</a>${empty({ icon: 'file', title: T('cl.not_found', 'Claim not found'), body: T('cl.not_found_sub', 'It may belong to another HMO. Go back to the claims list.') })}`); throw e; }
    if (stale()) return;
    const s = c.status;
    const review = can('payer.claims'); const pay = can('payer.pay');
    const flow = s === 'denied' ? ['submitted', 'under_review', 'denied'] : s === 'queried' || s === 'resubmitted' ? ['submitted', 'under_review', 'queried', 'resubmitted', 'approved', 'paid'] : ['submitted', 'under_review', 'approved', 'paid'];
    const noEvidence = (c.flags || []).some(f => f.code === 'no_evidence');
    view(html`<a class="back" href="#/claims">${icon('left')}${T('cl.title', 'Claims')}</a>
      ${member(c.patientName)}
      <div class="page-head"><div><h1>${T('cl.claim', 'Claim {n}', { n: c.number })}</h1><p>${c.providerName || ''} | ${T('cl.bill', 'Bill {b}', { b: c.billNumber || '' })} | ${sBadge(s)}</p></div>
        <div class="actions">
          ${review && (s === 'submitted' || s === 'resubmitted') ? html`<button class="btn primary" data-action="cl-review">${icon('eye')}${T('cl.start_review', 'Start review')}</button>` : ''}
          ${review && s === 'under_review' ? html`<button class="btn primary" data-action="cl-approve-full">${icon('check')}${T('cl.approve_full', 'Approve in full')}</button><button class="btn" data-action="cl-approve-part">${T('cl.approve_part', 'Approve part')}</button><button class="btn" data-action="cl-query">${icon('message')}${T('cl.query', 'Ask a question')}</button><button class="btn danger" data-action="cl-deny">${T('cl.deny', 'Deny')}</button>` : ''}
          ${pay && s === 'approved' ? html`<button class="btn primary" data-action="cl-pay">${icon('card')}${T('cl.mark_paid', 'Mark paid')}</button>` : ''}
        </div></div>
      ${MC.steps(flow, s, Object.fromEntries(flow.map(x => [x, st(x)])))}
      ${s === 'approved' && !pay ? html`<div class="notice">${T('cl.pay_manager', 'Approved. Your HMO manager records the payment.')}</div>` : ''}
      ${s === 'queried' ? html`<div class="notice warn"><b>${T('pa.asked', 'You asked')}:</b> ${c.question}<br>${T('cl.wait_answer', 'Waiting for the provider to answer and resubmit.')}</div>` : ''}
      ${c.answer ? html`<div class="notice"><b>${T('pa.answer', 'Provider answered')}:</b> ${c.answer}</div>` : ''}
      ${s === 'denied' ? html`<div class="notice bad">${T('cl.denied_note', 'Denied: {r}', { r: c.denyReason || '' })}</div>` : ''}
      ${s === 'paid' ? html`<div class="notice ok">${T('cl.paid_note', 'Paid {a} on {d}. Reference {r}.', { a: money(c.paidKobo), d: dateTime(c.paidAt), r: c.paymentRef })}</div>` : ''}
      ${c.flagged ? html`<section class="panel" style="border-color:var(--red)"><h2>${icon('alert')} ${s === 'paid' || s === 'denied' || s === 'approved' ? T('cl.flags_title_done', 'Warning flags on this claim') : T('cl.flags_title', 'Check before you approve')}</h2><div class="alerts">${c.flags.map(f => html`<div class="alert major">${icon('alert')}<div><b>${flagTitle(f.code)}</b>${FLAG_TEXT[f.code] ? FLAG_TEXT[f.code]() : ''}${f.detail ? html`<br><span class="muted">${f.detail}</span>` : ''}${f.codes && f.codes.length ? html`<br><span class="muted">${T('cl.codes', 'Service codes: {c}', { c: f.codes.join(', ') })}</span>` : ''}</div></div>`)}</div></section>` : html`<div class="notice ok">${T('cl.clean', 'No warning flags on this claim.')}</div>`}
      <div class="grid side-r"><div>
        <section class="panel flush"><h2>${T('cl.lines', 'Bill lines')}</h2><div class="table-wrap" style="border:0"><table class="t stack-sm"><thead><tr><th>${T('col.service', 'Service')}</th><th>${T('limits.cat', 'Category')}</th><th class="num">${T('col.qty', 'Qty')}</th><th class="num">${T('col.unit', 'Unit price')}</th><th class="num">${T('col.amount', 'Amount')}</th></tr></thead><tbody>
          ${c.lines.map(l => html`<tr><td data-label="${T('col.service', 'Service')}"><b>${l.name}</b><br><span class="xs muted">${l.code}</span></td><td data-label="${T('limits.cat', 'Category')}">${catLabel(l.category)}</td><td class="num" data-label="${T('col.qty', 'Qty')}">${l.qty}</td><td class="num" data-label="${T('col.unit', 'Unit price')}">${money(l.unitPriceKobo)}</td><td class="num" data-label="${T('col.amount', 'Amount')}">${money(l.totalKobo)}</td></tr>`)}</tbody></table></div>
          <dl class="kv" style="padding:16px"><dt>${T('cl.bill_total', 'Bill total')}</dt><dd>${money(c.billTotalKobo)}</dd><dt><b>${T('col.claimed', 'Claimed')}</b></dt><dd><b>${money(c.claimedKobo)}</b></dd>${c.approvedKobo != null ? html`<dt>${T('col.approved', 'Approved')}</dt><dd>${money(c.approvedKobo)}${c.approvedKobo < c.claimedKobo ? ' ' + T('cl.partial', '(part)') : ''}</dd>` : ''}${c.paidKobo != null ? html`<dt>${T('dash.paid', 'Paid')}</dt><dd>${money(c.paidKobo)}</dd>` : ''}</dl></section>
        <section class="panel"><h2>${T('cl.clinical', 'Clinical and authorisation')}</h2><dl class="kv">
          <dt>${T('col.diagnosis', 'Diagnosis')}</dt><dd>${c.diagnosis ? html`${c.diagnosis.code ? html`<b>${c.diagnosis.code}</b> ` : ''}${c.diagnosis.text}` : html`<span class="muted">${T('cl.no_dx', 'Not recorded')}</span>`}</dd>
          <dt>${T('cl.preauth', 'Pre-authorisation')}</dt><dd>${c.preauthCode ? html`<b>${c.preauthCode}</b>${c.preauthId ? html` <a href="#/preauths/${c.preauthId}">${T('members.open', 'Open')}</a>` : ''}` : html`<span class="muted">${T('cl.no_preauth', 'None')}</span>`}</dd>
          <dt>${T('cl.evidence', 'Evidence')}</dt><dd>${noEvidence ? badge(T('cl.evidence_missing', 'No completed service record'), 'bad') : badge(T('cl.evidence_ok', 'Service record completed'), 'ok')}</dd>
          <dt>${T('col.service_date', 'Service date')}</dt><dd>${isoDate(c.serviceDate)}</dd>
          <dt>${T('col.memberno', 'Member number')}</dt><dd>${c.coverageId ? html`<a href="#/members/${c.coverageId}">${c.memberNo}</a>` : c.memberNo}</dd>
          <dt>${T('cl.submitted', 'Submitted')}</dt><dd>${dateTime(c.submittedAt)} (${fmtHours(c.ageHours)})</dd>
          ${c.decisionNote ? html`<dt>${T('pa.note', 'Note')}</dt><dd>${c.decisionNote}</dd>` : ''}</dl></section>
      </div><div>
        <section class="panel"><h2>${T('pa.cover', 'Member cover')}</h2>${c.cover ? html`<p>${sBadge(c.cover.status)} ${T('pa.valid_to', 'valid to {d}', { d: isoDate(c.cover.validTo) })}</p>${limitsTable(c.cover)}` : html`<p class="muted">${T('pa.no_cover', 'Cover record not found')}</p>`}</section>
        <section class="panel"><h2>${T('history', 'History')}</h2>${timeline(c.history)}</section>
      </div></div>`);

    on('cl-review', async () => { await api.post('/api/payer/claims/' + c.id + '/review'); toast(T('cl.reviewing', 'Review started'), 'ok'); MC.render(); });
    const approve = async kobo => {
      const part = kobo < c.claimedKobo;
      const ok = await confirm({ title: T('cl.approve_q', 'Approve {a} on claim {n}?', { a: money(kobo), n: c.number }), body: part ? T('cl.approve_part_body', 'This is part of the {c} claimed. {prov} is told {a} is approved and the rest is not.', { c: money(c.claimedKobo), prov: c.providerName || '', a: money(kobo) }) + (c.flagged ? ' ' + T('cl.flag_warn', 'This claim has warning flags.') : '') : T('cl.approve_full_body', '{prov} is told the full {a} is approved and will be paid.', { prov: c.providerName || '', a: money(kobo) }) + (c.flagged ? ' ' + T('cl.flag_warn', 'This claim has warning flags.') : ''), ok: T('cl.approve', 'Approve {a}', { a: money(kobo) }) });
      return ok;
    };
    on('cl-approve-full', async () => {
      if (!(await approve(c.claimedKobo))) return;
      await api.post('/api/payer/claims/' + c.id + '/approve', { approvedKobo: c.claimedKobo }); toast(T('cl.approved', 'Claim approved'), 'ok'); MC.render();
    });
    on('cl-approve-part', async () => {
      const r = await dialog({ title: T('cl.approve_part_title', 'Approve part of {n}', { n: c.number }), form: true, body: html`
        <div class="field"><label for="ca-a">${T('cl.amount', 'Amount to approve (NGN)')}</label><input class="input" id="ca-a" name="approvedKobo" type="number" min="0.01" step="0.01" max="${c.claimedKobo / 100}" data-kobo required><div class="hint">${T('cl.amount_hint', 'Less than {a}, the amount claimed.', { a: money(c.claimedKobo) })}</div></div>
        <div class="field"><label for="ca-n">${T('cl.why_part', 'Why only part? (sent to the provider)')}</label><textarea class="input" id="ca-n" name="note" maxlength="500" required></textarea></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('cl.review_approve', 'Review and approve'), primary: true }],
        onSubmit: async d => {
          if (!d.approvedKobo || d.approvedKobo < 1 || d.approvedKobo > c.claimedKobo) throw new MC.ApiError(400, { error: T('pa.amount_bad', 'Enter an amount between {min} and {max}', { min: money(1), max: money(c.claimedKobo) }), details: [{ field: 'approvedKobo', error: T('pa.amount_bad', 'Enter an amount between {min} and {max}', { min: money(1), max: money(c.claimedKobo) }) }] });
          if (!(await approve(d.approvedKobo))) return false;
          return api.post('/api/payer/claims/' + c.id + '/approve', { approvedKobo: d.approvedKobo, note: d.note || undefined });
        } });
      if (r) { toast(T('cl.approved', 'Claim approved'), 'ok'); MC.render(); }
    });
    const textDlg = (title, body, label, name, ok, path, danger) => dialog({ title, form: true, body: html`<p>${body}</p><div class="field"><label for="cl-t">${label}</label><textarea class="input" id="cl-t" name="${name}" required minlength="3" maxlength="500"></textarea></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: ok, primary: true, danger }], onSubmit: d => api.post('/api/payer/claims/' + c.id + '/' + path, { [name]: d[name] }) });
    on('cl-deny', async () => { if (await textDlg(T('cl.deny_title', 'Deny claim {n}?', { n: c.number }), T('cl.deny_body', 'Nothing is paid on this claim and the provider is told your reason. This cannot be undone.'), T('reason', 'Reason'), 'reason', T('cl.deny', 'Deny'), 'deny', true)) { toast(T('cl.denied', 'Claim denied'), 'ok'); MC.render(); } });
    on('cl-query', async () => { if (await textDlg(T('cl.query_title', 'Ask the provider about {n}', { n: c.number }), T('cl.query_body', 'The claim goes back to the provider. It returns to your queue when they resubmit.'), T('pa.question', 'Question'), 'question', T('pa.send_q', 'Send question'), 'query')) { toast(T('pa.queried', 'Question sent'), 'ok'); MC.render(); } });
    on('cl-pay', async () => {
      const r = await dialog({ title: T('cl.pay_title', 'Record payment for {n}', { n: c.number }), form: true, body: html`<p>${T('cl.pay_body', 'Pay {a} to {prov} first, then enter the bank transfer reference.', { a: money(c.approvedKobo), prov: c.providerName || '' })}</p>
        <div class="field"><label for="cp-r">${T('cl.pay_ref', 'Payment reference')}</label><input class="input" id="cp-r" name="paymentRef" maxlength="60" required autocomplete="off"></div>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('cl.pay_next', 'Review payment'), primary: true }],
        onSubmit: async d => {
          if (!d.paymentRef) throw new MC.ApiError(400, { error: T('cl.need_ref', 'Enter the payment reference'), details: [{ field: 'paymentRef', error: T('cl.need_ref', 'Enter the payment reference') }] });
          const ok = await confirm({ title: T('cl.pay_q', 'Mark {a} as paid?', { a: money(c.approvedKobo) }), body: T('cl.pay_q_body', 'Claim {n} to {prov} is recorded as paid with reference {r}. This cannot be undone.', { n: c.number, prov: c.providerName || '', r: d.paymentRef }), ok: T('cl.mark_paid', 'Mark paid') });
          if (!ok) return false;
          return api.post('/api/payer/claims/' + c.id + '/pay', { paymentRef: d.paymentRef });
        } });
      if (r) { toast(T('cl.paid', 'Claim marked paid'), 'ok'); MC.render(); }
    });
  }

  /* ================= settings ================= */
  async function settings({ stale }) {
    const s = await api.get('/api/payer/settings');
    if (stale()) return;
    const edit = can('admin.settings');
    view(html`<div class="page-head"><div><h1>${T('set.title', 'HMO settings')}</h1><p>${T('set.sub', 'Rules providers follow when they bill your HMO.')}</p></div></div>
      <section class="panel"><h2>${T('set.current', 'Current rules')}</h2><dl class="kv">
        <dt>${T('set.threshold', 'Pre-authorisation needed above')}</dt><dd><b>${money(s.preauthThresholdKobo)}</b> <span class="muted sm">(${s.thresholdSource === 'hmo' ? T('set.src_hmo', 'set by your HMO') : T('set.src_platform', 'MediCore default')})</span></dd>
        <dt>${T('set.valid', 'Approvals valid for')}</dt><dd>${T('set.days', '{n} days', { n: s.preauthValidDays })}</dd>
        <dt>${T('set.dup', 'Duplicate check window')}</dt><dd>${T('set.hours', '{n} hours', { n: s.duplicateWindowHours })}</dd>
        <dt>${T('set.freq', 'Frequent service flag')}</dt><dd>${T('set.freq_v', 'From claim {n} of the same service in 30 days', { n: s.frequencyLimitPer30Days + 1 })}</dd></dl>
        <p class="muted sm" style="margin-top:12px">${T('set.platform_note', 'The duplicate and frequency rules are set by MediCore for all HMOs.')}</p></section>
      ${edit ? html`<form class="panel" data-form="set-save" novalidate><h2>${T('set.change', 'Change your rules')}</h2>
        <div class="fields two"><div class="field"><label for="ss-t">${T('set.threshold_in', 'Pre-authorisation threshold (NGN)')}</label><input class="input" id="ss-t" name="preauthThresholdKobo" type="number" min="0" step="500" data-kobo value="${s.preauthThresholdKobo / 100}" required><div class="hint">${T('set.threshold_hint', 'Bills covered above this amount need your approval first.')}</div></div>
        <div class="field"><label for="ss-d">${T('set.valid_in', 'Approval valid for (days)')}</label><input class="input" id="ss-d" name="preauthValidDays" type="number" min="1" max="365" value="${s.preauthValidDays}" required></div></div>
        <div class="form-err notice bad" hidden></div><button class="btn primary" type="submit">${T('set.save', 'Save rules')}</button></form>`
        : html`<p class="muted">${T('set.manager_only', 'Only your HMO manager can change these rules.')}</p>`}`);
    form('set-save', async d => {
      if (!(await confirm({ title: T('set.q', 'Change your HMO rules?'), body: T('set.q_body', 'Providers will need pre-authorisation for cover above {a}, and new approvals last {n} days. Existing approvals are not changed.', { a: money(d.preauthThresholdKobo), n: d.preauthValidDays }), ok: T('set.save', 'Save rules') }))) return;
      await api.patch('/api/payer/settings', { preauthThresholdKobo: d.preauthThresholdKobo, preauthValidDays: d.preauthValidDays });
      toast(T('set.saved', 'Rules saved'), 'ok'); MC.render();
    });
  }

  MC.boot({
    title: 'MediCore HMO', home: '#/',
    nav: [
      { href: '#/', label: T('nav.dash', 'Dashboard'), short: T('nav.dash_s', 'Home'), icon: 'chart', anyPerm: ['payer.claims', 'payer.preauth', 'payer.members', 'admin.reports'] },
      { href: '#/members', label: T('nav.members', 'Members and cover'), short: T('nav.members_s', 'Members'), icon: 'users', anyPerm: ['payer.members', 'payer.preauth', 'payer.claims'] },
      { href: '#/preauths', label: T('nav.preauths', 'Pre-authorisations'), short: T('nav.preauths_s', 'Approvals'), icon: 'shield', anyPerm: ['payer.preauth', 'payer.claims'] },
      { href: '#/claims', label: T('nav.claims', 'Claims'), icon: 'file', anyPerm: ['payer.claims', 'payer.pay'] },
      { href: '#/settings', label: T('nav.settings', 'HMO settings'), short: T('nav.settings_s', 'Settings'), icon: 'settings', anyPerm: ['payer.members', 'payer.preauth', 'payer.claims', 'admin.settings'] },
    ],
    routes: { '#/': dashboard, '#/members': members, '#/members/enrol': enrolPage, '#/members/:id': memberPage, '#/preauths': preauths, '#/preauths/:id': preauthPage, '#/claims': claims, '#/claims/:id': claimPage, '#/settings': settings },
  });
})();
