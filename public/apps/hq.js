/* MediCore HQ: the super-admin console for the MediCore product owner and developers.
 * Overview, providers (approval, KYC, apps and subscription, suspension, owner password, audit,
 * per-provider overrides), plan presets, platform team, privacy and compliance, audit search, demo.
 * Configuration screens and the support queue come from hq-config.js (window.HQConfig). */
(function () {
  'use strict';
  const { html, api, qs, money, date, dateTime, ago, cap, icon, badge, statusBadge, empty, figures, view, on, form, dialog, confirm, toast } = MC;
  const T = (k, d, v) => MC.t('hq.' + k, d, v);
  const H = window.HQConfig || { routes: {}, nav: [] };
  const can = p => ((MC.me && MC.me.perms) || []).includes(p);
  const st = s => MC.t('status.' + s, cap(s));
  const sBadge = s => statusBadge(s, { trial: 'info', past_due: 'bad', in_progress: 'info', responded: 'info', contained: 'warn' });
  const wide = () => window.matchMedia && window.matchMedia('(min-width: 960px)').matches;
  const LAGOS = '+01:00';
  const toLocalInput = ts => (ts ? new Date(ts + 3600e3).toISOString().slice(0, 16) : '');
  const fromLocalInput = v => (v ? Date.parse(v + ':00' + LAGOS) : undefined);
  let demoMode = null;

  const TYPES = { hospital: 'Hospital', clinic: 'Clinic / medical centre', pharmacy: 'Pharmacy', ambulance: 'Ambulance service', lab: 'Laboratory / diagnostics', other: 'Other health service', hmo: 'HMO / health insurer' };
  const typeLabel = k => T('type.' + k, TYPES[k] || cap(k));
  const MODS = { frontdesk: 'Front desk', clinic: 'Doctors and consultations', pharmacy: 'Pharmacy', delivery: 'Delivery (dispatcher and riders)', ambulance: 'Ambulance (dispatcher and crew)', lab: 'Laboratory', chw: 'Community health', hmo: 'HMO billing', payer: 'HMO / payer desk' };
  const ALWAYS = ['frontdesk', 'hmo'];
  const modLabel = k => T('mod.' + k, MODS[k] || cap(k));
  const ORG_STATUSES = ['pending', 'active', 'suspended', 'rejected'];
  const SUB_STATUSES = ['trial', 'active', 'past_due', 'cancelled'];

  const head = (title, sub, actions) => html`<div class="page-head"><div><h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ''}</div>${actions ? html`<div class="actions">${actions}</div>` : ''}</div>`;
  const back = (href, label) => html`<a class="back" href="${href}">${icon('left')}${label}</a>`;
  const noAccess = () => view(html`${empty({ icon: 'lock', title: T('common.forbidden', 'You do not have access to this page'), body: T('common.forbidden_sub', 'Your MediCore team role does not include this. Ask a platform owner if you need it.'), action: html`<a class="btn" href="#/">${T('common.to_overview', 'Go to the overview')}</a>` })}`);
  const guard = (perm, fn) => ctx => (can(perm) ? fn(ctx) : noAccess());
  const tabsNav = (items, cur, label) => html`<nav class="tabs" aria-label="${label}">${items.map(([href, l]) => html`<a href="${href}" aria-current="${href === cur ? 'page' : 'false'}">${l}</a>`)}</nav>`;
  const field = (id, label, input, hint) => html`<div class="field"><label for="${id}">${label}</label>${input}${hint ? html`<div class="hint">${hint}</div>` : ''}</div>`;
  const opt = (value, label, sel) => html`<option value="${value}" ${sel ? 'selected' : ''}>${label}</option>`;
  const tempPwDialog = (title, pw, note) => dialog({ title, body: html`<p>${T('common.temp_pw_give', 'Give this temporary password to the person privately, after checking who they are. They must choose their own password when they sign in.')}</p><p class="notice"><b>${pw}</b></p><p class="muted sm">${note || T('common.temp_pw_once', 'It will not be shown again.')}</p>`, actions: [{ label: T('common.done', 'Done'), primary: true, value: true }] });

  /* ======================= overview ======================= */
  async function overview({ stale }) {
    const [m, pending, tickets, gl] = await Promise.all([
      api.get('/api/hq/metrics'),
      api.get('/api/hq/providers' + qs({ status: 'pending', limit: 20 })),
      can('platform.support') ? api.get('/api/hq/support').catch(() => null) : Promise.resolve(null),
      api.get('/api/hq/integrations/status').catch(() => null),
    ]);
    if (stale()) return;
    const glNeeds = gl ? gl.integrations.filter(x => !x.ready && x.needs).length : 0;
    const glBlocking = gl ? gl.compliance.filter(x => x.blocking).length : 0;
    const overdue = tickets ? tickets.filter(x => x.overdue).length : null;
    const days = m.perDay || []; const max = Math.max(1, ...days.map(d => d.paidKobo));
    const byType = Object.entries(m.providers.byType || {}).sort((a, b) => b[1] - a[1]);
    const byStatus = ORG_STATUSES.filter(s => (m.providers.byStatus || {})[s]).map(s => [s, m.providers.byStatus[s]]);
    const maxType = Math.max(1, ...byType.map(x => x[1]));
    view(html`${head(T('ov.title', 'Platform overview'), T('ov.sub', 'Providers, patients and activity across MediCore. Figures cover the last 30 days unless stated.'), html`<a class="btn" href="#/providers">${icon('building')}${T('ov.all_providers', 'All providers')}</a>`)}
      ${gl && (glNeeds || glBlocking) ? html`<div class="notice ${glBlocking ? 'bad' : ''}"><b>${T('ov.golive', 'Go-live: {n} integrations still need an account or keys, and {b} compliance items are switching features off.', { n: glNeeds, b: glBlocking })}</b> <a href="#/golive">${T('ov.golive_open', 'Open the go-live checklist')}</a></div>` : ''}
      ${m.providers.pending ? html`<div class="notice warn"><b>${T('ov.pending_n', '{n} providers are waiting for approval.', { n: m.providers.pending })}</b> ${T('ov.pending_sub', 'They cannot use MediCore until you approve them.')} <a href="#/providers?status=pending">${T('ov.review', 'Review them')}</a></div>` : ''}
      ${figures([
        { value: m.providers.total, label: T('ov.f.providers', 'Providers') },
        { value: m.patients.total, label: T('ov.f.patients', 'Patients ({n} new)', { n: m.patients.new30d }) },
        { value: m.staff.active, label: T('ov.f.staff', 'Active staff ({n} on duty)', { n: m.staff.onDuty }) },
        { value: money(m.bills30d.paidVolumeKobo), label: T('ov.f.paid', 'Paid, 30 days') },
        { value: m.incidents.last30d, label: T('ov.f.incidents', 'Emergencies, 30 days') },
        { value: m.prescriptions.last30d, label: T('ov.f.rx', 'Prescriptions, 30 days') },
        { value: m.claims.open, label: T('ov.f.claims', 'HMO claims open ({n} total)', { n: m.claims.total }), tone: m.claims.open ? 'warn' : '' },
        { value: m.support.open, label: T('ov.f.tickets', 'Open support tickets'), tone: m.support.urgentOpen ? 'bad' : '' },
        ...(overdue != null ? [{ value: overdue, label: T('ov.f.overdue', 'Overdue tickets'), tone: overdue ? 'bad' : '' }] : []),
        { value: m.privacy.openRequests + ' / ' + m.privacy.openBreaches, label: T('ov.f.privacy', 'Privacy requests / breaches open'), tone: m.privacy.openBreaches ? 'bad' : '' },
      ])}
${pending.rows.length ? html`<section class="panel flush"><h2>${T('ov.pending_title', 'Waiting for approval')}</h2>
        ${pending.rows.length ? html`<div class="list">${pending.rows.map(o => html`<a href="#/providers/${o.id}"><div class="grow"><span class="title">${o.name}</span><span class="sub">${typeLabel(o.type)} | ${o.area || o.city || T('common.no_area', 'No area given')} | ${T('ov.signed_up', 'Signed up {when}', { when: ago(o.createdAt) })}</span></div><span class="end btn sm">${T('ov.review_one', 'Review')}${icon('right')}</span></a>`)}</div>` : html`<div class="panel" style="border:0;margin:0">${empty({ icon: 'check', title: T('ov.none_pending', 'No providers waiting'), body: T('ov.none_pending_sub', 'New sign-ups from the website appear here for approval.') })}</div>`}
      </section>` : ''}
      <div class="grid side-r">
        <section class="panel"><h2>${T('ov.paid_title', 'Paid volume per day')}</h2><p class="muted sm">${T('ov.paid_sub', '{amount} from {n} paid bills in the last 30 days. HMO covered {hmo}.', { amount: money(m.bills30d.paidVolumeKobo), n: m.bills30d.paidCount, hmo: money(m.bills30d.hmoCoveredKobo) })}</p>
          ${days.some(d => d.paidKobo) ? html`<div class="bars">${days.slice().reverse().map(d => html`<div class="bar"><span>${MC.day(Date.parse(d.date) + 3600e3)}</span><div class="track"><div class="fill" style="width:${Math.round(d.paidKobo / max * 100)}%"></div></div><span class="v">${money(d.paidKobo)}</span></div>`)}</div>` : empty({ icon: 'chart', title: T('ov.paid_empty', 'No paid bills in the last 30 days'), body: T('ov.paid_empty_sub', 'Payments at every provider show here.') })}</section>
        <div>
          <section class="panel"><h2>${T('ov.by_type', 'Providers by type')}</h2>${byType.length ? html`<div class="bars">${byType.map(([k, n]) => html`<div class="bar"><span>${typeLabel(k)}</span><div class="track"><div class="fill" style="width:${Math.round(n / maxType * 100)}%"></div></div><span class="v">${n}</span></div>`)}</div>` : empty({ icon: 'building', title: T('ov.no_providers', 'No providers yet') })}</section>
          <section class="panel"><h2>${T('ov.by_status', 'Providers by status')}</h2><div class="list">${byStatus.map(([s, n]) => html`<a href="#/providers?status=${s}"><div class="grow">${sBadge(s)}</div><span class="end"><b>${n}</b></span></a>`)}</div></section>
          <section class="panel"><h2>${T('ov.subs', 'Subscriptions (active providers)')}</h2><dl class="kv">${Object.entries(m.subscriptions.byStatus || {}).map(([s, n]) => html`<dt>${st(s)}</dt><dd>${n}</dd>`)}<dt>${T('ov.mrr', 'Paying monthly total')}</dt><dd><b>${money(m.subscriptions.activeMonthlyKobo)}</b></dd></dl></section>
        </div>
      </div>
`);
  }

  /* ======================= providers ======================= */
  const PAGE = 50;
  async function providers({ query, stale }) {
    const skip = Number(query.skip) || 0;
    const [r, groups] = await Promise.all([api.get('/api/hq/providers' + qs({ status: query.status, type: query.type, q: query.q, limit: PAGE, skip })), api.get('/api/hq/groups').catch(() => [])]);
    if (stale()) return;
    const gName = Object.fromEntries((groups || []).map(g => [g.id, g.name]));
    view(html`${head(T('pv.title', 'Providers'), T('pv.sub', '{n} providers match', { n: r.total }))}${pvTabs('#/providers', groups.length)}
      <form data-form="pv-filter" class="panel" novalidate><div class="fields three">
        ${field('pv-q', T('pv.search', 'Search name, code or email'), html`<input class="input" id="pv-q" name="q" type="search" value="${query.q || ''}" maxlength="80">`)}
        ${field('pv-s', T('pv.status', 'Status'), html`<select class="input" id="pv-s" name="status">${opt('', T('pv.any_status', 'Any status'), !query.status)}${ORG_STATUSES.map(s => opt(s, st(s), query.status === s))}</select>`)}
        ${field('pv-t', T('pv.type', 'Type'), html`<select class="input" id="pv-t" name="type">${opt('', T('pv.any_type', 'Any type'), !query.type)}${Object.keys(TYPES).map(k => opt(k, typeLabel(k), query.type === k))}</select>`)}
      </div><div class="row wrap"><button class="btn primary" type="submit">${icon('search')}${T('pv.apply', 'Show providers')}</button>${query.q || query.status || query.type ? html`<a class="btn ghost" href="#/providers">${T('pv.clear', 'Clear filters')}</a>` : ''}</div></form>
      ${r.rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('pv.c.name', 'Provider')}</th><th>${T('pv.c.type', 'Type')}</th><th>${T('pv.c.status', 'Status')}</th><th>${T('pv.c.sub', 'Subscription')}</th><th class="num">${T('pv.c.price', 'Per month')}</th><th>${T('pv.c.created', 'Signed up')}</th></tr></thead><tbody>
        ${r.rows.map(o => { const s = o.subscription || {}; return html`<tr><td data-label="${T('pv.c.name', 'Provider')}"><a href="#/providers/${o.id}"><b>${o.name}</b></a>${o.demo ? html` ${badge(T('pv.demo', 'Demo'), 'outline')}` : ''}${o.groupId ? html`<br><a class="xs" href="#/groups/${o.groupId}">${T('pv.branch_of', 'Branch of {group}', { group: gName[o.groupId] || T('pv.a_group', 'a hospital group') })}${o.branchName ? ': ' + o.branchName : ''}</a>` : ''}<br><span class="xs muted">${o.code}${o.area || o.city ? ' | ' + (o.area || o.city) : ''}</span></td><td data-label="${T('pv.c.type', 'Type')}">${typeLabel(o.type)}</td><td data-label="${T('pv.c.status', 'Status')}">${sBadge(o.status)}</td><td data-label="${T('pv.c.sub', 'Subscription')}">${s.status ? sBadge(s.status) : html`<span class="muted">${T('pv.no_sub', 'None')}</span>`}</td><td class="num" data-label="${T('pv.c.price', 'Per month')}">${s.monthlyKobo != null ? money(s.monthlyKobo) : ''}</td><td data-label="${T('pv.c.created', 'Signed up')}">${date(o.createdAt)}</td></tr>`; })}
      </tbody></table></div>
      <div class="btn-row">${skip > 0 ? html`<a class="btn" href="#/providers${qs(Object.assign({}, query, { skip: Math.max(0, skip - PAGE) || undefined }))}">${icon('left')}${T('pv.prev', 'Previous')}</a>` : ''}${skip + PAGE < r.total ? html`<a class="btn" href="#/providers${qs(Object.assign({}, query, { skip: skip + PAGE }))}">${T('pv.next', 'Next')}${icon('right')}</a>` : ''}</div>`
      : empty({ icon: 'building', title: T('pv.empty', 'No providers match'), body: T('pv.empty_sub', 'Change the filters, or wait for providers to sign up on the website.'), action: html`<a class="btn" href="#/providers">${T('pv.clear', 'Clear filters')}</a>` })}`);
    form('pv-filter', d => MC.go('#/providers' + qs({ q: d.q, status: d.status, type: d.type })));
  }

  const providerTabs = (o, cur) => tabsNav([
    ['#/providers/' + o.id, T('pd.t.profile', 'Profile and subscription')],
    ['#/providers/' + o.id + '/overrides', T('pd.t.overrides', 'Own settings')],
    ...(can('platform.audit') ? [['#/providers/' + o.id + '/audit', T('pd.t.audit', 'Audit log')]] : []),
  ], cur, T('pd.sections', 'Provider sections'));
  const providerHead = o => html`${back('#/providers', T('pv.title', 'Providers'))}${head(o.name, html`${typeLabel(o.type)} | ${T('pd.code', 'Code')} <b>${o.code}</b> | ${sBadge(o.status)}${o.groupId ? html` | <a href="#/groups/${o.groupId}">${T('pd.group_link', 'Branch of a hospital group{b}', { b: o.branchName ? ': ' + o.branchName : '' })}</a>` : ''}`, statusActions(o))}`;
  function statusActions(o) {
    if (!can('platform.orgs')) return '';
    if (o.status === 'pending') return html`<button class="btn" data-action="pd-reject" data-id="${o.id}">${icon('x')}${T('pd.reject', 'Reject')}</button><button class="btn primary" data-action="pd-approve" data-id="${o.id}">${icon('check')}${T('pd.approve', 'Approve provider')}</button>`;
    if (o.status === 'active') return html`<button class="btn" data-action="pd-suspend" data-id="${o.id}">${icon('stop')}${T('pd.suspend', 'Suspend provider')}</button>`;
    if (o.status === 'suspended') return html`<button class="btn primary" data-action="pd-reactivate" data-id="${o.id}">${icon('refresh')}${T('pd.reactivate', 'Reactivate provider')}</button>`;
    return '';
  }
  const stateErr = e => { if (e && e.code === 'wrong_state') { toast(T('pd.wrong_state', 'Someone else changed this provider first. Showing the latest status.'), 'bad'); MC.render(); return true; } return false; };

  async function providerDetail({ params, stale }) {
    const o = await api.get('/api/hq/providers/' + encodeURIComponent(params.id));
    const tickets = can('platform.support') ? await api.get('/api/hq/support' + qs({ orgId: o.id })).catch(() => []) : null;
    if (stale()) return;
    const s = o.subscription || {}; const k = o.kyc || {}; const c = o.contact || {}; const ow = o.owner;
    const kycRow = (label, v) => html`<dt>${label}</dt><dd>${v ? html`<b>${v}</b>` : badge(T('pd.kyc_missing', 'Not provided'), 'warn')}</dd>`;
    view(html`${providerHead(o)}${providerTabs(o, '#/providers/' + o.id)}
      ${o.status === 'pending' ? html`<div class="notice warn">${T('pd.pending_note', 'Check the CAC registration and the licence below before approving. Once approved, the owner can sign in and the {days}-day free trial starts.', { days: (o.quote && o.quote.trialDays) || 30 })}</div>` : ''}
      ${o.status === 'suspended' ? html`<div class="notice bad"><b>${T('pd.suspended_note', 'Suspended. Nobody at this provider can sign in.')}</b>${o.statusReason ? html`<br>${T('pd.reason', 'Reason')}: ${o.statusReason}` : ''}</div>` : ''}
      ${o.status === 'rejected' ? html`<div class="notice bad"><b>${T('pd.rejected_note', 'Application rejected. This is final.')}</b>${o.statusReason ? html`<br>${T('pd.reason', 'Reason')}: ${o.statusReason}` : ''}</div>` : ''}
      ${figures([{ value: o.staffCount, label: T('pd.f.staff', 'Active staff') }, { value: o.patientsCount, label: T('pd.f.patients', 'Patients linked') }, { value: s.monthlyKobo != null ? money(s.monthlyKobo) : '-', label: T('pd.f.monthly', 'Per month') }, { value: s.status ? st(s.status) : '-', label: T('pd.f.sub', 'Subscription'), tone: s.status === 'past_due' || s.status === 'cancelled' ? 'bad' : '' }, { value: o.lastActivityAt ? ago(o.lastActivityAt) : T('pd.never', 'Never'), label: T('pd.f.activity', 'Last activity') }])}
      <div class="grid two">
        <section class="panel"><h2>${T('pd.profile', 'Profile')}</h2><dl class="kv">
          <dt>${T('pd.type', 'Type')}</dt><dd>${typeLabel(o.type)}</dd>
          <dt>${T('pd.phone', 'Phone')}</dt><dd>${c.phone || '-'}</dd><dt>${T('pd.email', 'Email')}</dt><dd>${c.email || '-'}</dd><dt>${T('pd.address', 'Address')}</dt><dd>${c.address || '-'}</dd>
          <dt>${T('pd.area', 'Area')}</dt><dd>${[o.area, o.city, o.location && o.location.state].filter(Boolean).join(', ') || '-'}</dd>
          <dt>${T('pd.created', 'Signed up')}</dt><dd>${dateTime(o.createdAt)}</dd>${o.demo ? html`<dt>${T('pd.demo', 'Demo data')}</dt><dd>${T('common.yes', 'Yes')}</dd>` : ''}</dl></section>
        <section class="panel"><h2>${T('pd.kyc', 'KYC')}</h2><dl class="kv">${kycRow(T('pd.cac', 'CAC number'), k.cacNumber)}${kycRow(T('pd.lic_kind', 'Licence type'), k.licenceKind)}${kycRow(T('pd.lic_no', 'Licence number'), k.licenceNumber)}</dl>
          <p class="muted sm" style="margin-top:12px">${T('pd.kyc_hint', 'Confirm these with the CAC search portal and the relevant regulator (PCN, MDCN or MLSCN) before approval.')}</p></section>
      </div>
      <section class="panel"><div class="row between wrap"><h2 style="margin:0;font-size:var(--t-lg)">${T('pd.owner', 'Owner account')}</h2>${ow && can('platform.support') ? html`<button class="btn sm" data-action="pd-reset-pw" data-id="${o.id}">${icon('key')}${T('pd.reset_pw', 'Reset owner password')}</button>` : ''}</div>
        ${ow ? html`<dl class="kv" style="margin-top:12px"><dt>${T('pd.name', 'Name')}</dt><dd>${ow.name}</dd><dt>${T('pd.email', 'Email')}</dt><dd>${ow.email || '-'}</dd><dt>${T('pd.phone', 'Phone')}</dt><dd>${ow.phone || '-'}</dd><dt>${T('pd.status', 'Status')}</dt><dd>${sBadge(ow.status)}${ow.mustChangePassword ? html` ${badge(T('pd.must_change', 'Must set a new password'), 'warn')}` : ''}</dd><dt>${T('pd.last_login', 'Last sign in')}</dt><dd>${ow.lastLoginAt ? ago(ow.lastLoginAt) : T('pd.never', 'Never')}</dd></dl>` : html`<p class="muted">${T('pd.no_owner', 'This provider has no owner account.')}</p>`}</section>
      <section class="panel"><div class="row between wrap"><h2 style="margin:0;font-size:var(--t-lg)">${T('pd.apps_sub', 'Apps and subscription')}</h2>${can('platform.orgs') ? html`<div class="row wrap">${o.type !== 'hmo' ? html`<button class="btn sm" data-action="pd-apps">${icon('box')}${T('pd.change_apps', 'Change apps')}</button>` : ''}<button class="btn sm" data-action="pd-sub">${icon('card')}${T('pd.edit_sub', 'Edit subscription')}</button></div>` : ''}</div>
        <div class="row wrap" style="margin:12px 0">${o.modules.map(m => badge(modLabel(m), 'hue'))}</div>
        <dl class="kv"><dt>${T('pd.sub_status', 'Status')}</dt><dd>${s.status ? sBadge(s.status) : '-'}${s.status === 'trial' && s.trialEnds ? html` <span class="sm muted">${T('pd.trial_ends', 'trial ends {d}', { d: date(s.trialEnds) })}</span>` : ''}</dd>
          <dt>${T('pd.period', 'Billing period')}</dt><dd>${s.period === 'annual' ? T('pd.annual', 'Yearly') : T('pd.monthly', 'Monthly')}</dd>
          <dt>${T('pd.seats', 'Staff accounts')}</dt><dd>${s.seats || '-'}</dd>
          <dt>${T('pd.price', 'Monthly price')}</dt><dd><b>${s.monthlyKobo != null ? money(s.monthlyKobo) : '-'}</b>${s.manualPrice ? html` ${badge(T('pd.negotiated', 'Negotiated price'), 'warn')}` : ''}</dd>
          ${s.period === 'annual' ? html`<dt>${T('pd.total_year', 'Charged per year')}</dt><dd>${money(s.totalKobo)}</dd>` : ''}
          ${s.preset ? html`<dt>${T('pd.preset', 'Preset')}</dt><dd>${s.preset}</dd>` : ''}
          <dt>${T('pd.quote', 'Price from current apps')}</dt><dd>${money(o.quote.monthlyKobo)}${s.manualPrice && o.quote.monthlyKobo !== s.monthlyKobo ? html` <span class="sm muted">${T('pd.quote_differs', '(differs from the negotiated price)')}</span>` : ''}</dd></dl>
        <details style="margin-top:12px"><summary class="btn ghost sm">${T('pd.breakdown', 'Price breakdown')}</summary>${quoteView(o.quote)}</details></section>
      ${o.statusHistory && o.statusHistory.length ? html`<section class="panel"><h2>${T('pd.history', 'Status history')}</h2><ol class="timeline">${o.statusHistory.slice().reverse().map(h => html`<li><time>${dateTime(h.at)}</time><b>${T('pd.h_change', '{from} to {to}', { from: st(h.from), to: st(h.to) })}</b>${h.reason ? html`<br><span class="muted">${h.reason}</span>` : ''}</li>`)}</ol></section>` : ''}
      ${tickets ? html`<section class="panel flush"><h2>${T('pd.tickets', 'Open support requests')}</h2>${tickets.length ? html`<div class="list">${tickets.map(x => html`<a href="#/support/${x.id}"><div class="grow"><span class="title">${x.subject}</span><span class="sub">${x.number} | ${ago(x.createdAt)}</span></div><span class="end">${x.overdue ? html`${badge(T('sp.overdue', 'Overdue'), 'bad')} ` : ''}${sBadge(x.status)}</span></a>`)}</div>` : html`<div style="padding:0 16px 16px"><p class="muted sm">${T('pd.no_tickets', 'No open requests from this provider.')} <a href="#/support">${T('pd.all_tickets', 'Open the support queue')}</a></p></div>`}</section>` : ''}`);
    bindProviderActions(o);
    on('pd-apps', () => changeApps(o));
    on('pd-sub', () => editSubscription(o));
    on('pd-reset-pw', async () => {
      if (!(await confirm({ title: T('pd.reset_q', 'Reset the owner\'s password?'), body: T('pd.reset_body', '{name} is signed out everywhere and must sign in with a temporary password you give them. Only do this after checking who they are, for example by calling the provider\'s registered phone number.', { name: ow.name }), ok: T('pd.reset_pw', 'Reset owner password'), danger: true }))) return;
      const r = await api.post('/api/hq/providers/' + o.id + '/reset-owner-password');
      await tempPwDialog(T('pd.reset_done', 'New temporary password for {name}', { name: r.owner.name }), r.tempPassword, r.note);
      MC.render();
    });
  }
  function quoteView(q) {
    if (!q) return '';
    return html`<dl class="kv" style="margin-top:8px">${q.lines.map(l => html`<dt>${l.key === 'base' ? T('pd.q.base', 'Core package') : modLabel(l.key)}</dt><dd>${money(l.kobo)}</dd>`)}
      ${q.discount ? html`<dt>${T('pd.q.discount', 'Bundle discount ({p}%)', { p: q.discount.percent })}</dt><dd>-${money(q.discount.kobo)}</dd>` : ''}
      ${q.seats && q.seats.extra ? html`<dt>${T('pd.q.seats', '{n} extra staff accounts', { n: q.seats.extra })}</dt><dd>${money(q.seats.kobo)}</dd>` : ''}
      <dt><b>${T('pd.q.total', 'Monthly total')}</b></dt><dd><b>${money(q.monthlyKobo)}</b></dd>
      ${q.period === 'annual' ? html`<dt>${T('pd.q.year', 'Charged per year')}</dt><dd>${money(q.totalKobo)}</dd>` : ''}
      <dt>${T('pd.q.bank', 'Bank service charge per payment')}</dt><dd>${money(q.bankChargePerPaymentKobo)}</dd></dl>`;
  }
  function bindProviderActions(o) {
    on('pd-approve', async () => {
      if (!(await confirm({ title: T('pd.approve_q', 'Approve {name}?', { name: o.name }), body: T('pd.approve_body', 'The provider goes live: the owner can sign in straight away, staff can be added and the free trial starts today. The owner is notified.'), ok: T('pd.approve', 'Approve provider') }))) return;
      try { await api.post('/api/hq/providers/' + o.id + '/approve'); } catch (e) { if (stateErr(e)) return; throw e; }
      toast(T('pd.approved', '{name} approved', { name: o.name }), 'ok'); MC.render();
    });
    on('pd-reject', async () => {
      const v = await dialog({ title: T('pd.reject_q', 'Reject {name}?', { name: o.name }), form: true, body: html`<div class="notice bad">${T('pd.reject_warn', 'Rejection is final. The provider cannot be approved later and must sign up again.')}</div>${field('pd-rr', T('pd.reject_reason', 'Reason (the owner sees this)'), html`<textarea class="input" id="pd-rr" name="reason" required minlength="5" maxlength="500"></textarea>`, T('pd.reason_hint', 'At least 5 characters, for example what is missing from the KYC.'))}`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pd.reject', 'Reject'), primary: true }],
        onSubmit: d => api.post('/api/hq/providers/' + o.id + '/reject', { reason: d.reason }) }).catch(e => { if (!stateErr(e)) throw e; });
      if (v) { toast(T('pd.rejected', '{name} rejected', { name: o.name }), 'ok'); MC.render(); }
    });
    on('pd-suspend', async () => {
      const v = await dialog({ title: T('pd.suspend_q', 'Suspend {name}?', { name: o.name }), form: true, body: html`<div class="notice bad"><b>${T('pd.suspend_warn', 'Every staff member at this provider is signed out immediately.')}</b> ${T('pd.suspend_warn2', 'Their next action in any MediCore app fails and they cannot sign in again until you reactivate the provider. Patients cannot book or order from it. No data is deleted.')}</div>${field('pd-sr', T('pd.suspend_reason', 'Reason (kept in the status history)'), html`<textarea class="input" id="pd-sr" name="reason" required minlength="5" maxlength="500"></textarea>`, T('pd.reason_hint2', 'At least 5 characters, for example "Subscription unpaid for 60 days".'))}`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pd.suspend_ok', 'Suspend and sign everyone out'), primary: true }],
        onSubmit: async d => { try { return await api.post('/api/hq/providers/' + o.id + '/suspend', { reason: d.reason }); } catch (e) { if (e.code === 'wrong_state') { stateErr(e); return null; } throw e; } } });
      if (v) { toast(T('pd.suspended', '{name} suspended. {n} sessions signed out.', { name: o.name, n: v.sessionsRevoked }), 'ok'); MC.render(); }
    });
    on('pd-reactivate', async () => {
      if (!(await confirm({ title: T('pd.react_q', 'Reactivate {name}?', { name: o.name }), body: T('pd.react_body', 'Staff can sign in again and patients can find the provider. The subscription is not changed.'), ok: T('pd.reactivate', 'Reactivate provider') }))) return;
      try { await api.post('/api/hq/providers/' + o.id + '/reactivate'); } catch (e) { if (stateErr(e)) return; throw e; }
      toast(T('pd.reactivated', '{name} reactivated', { name: o.name }), 'ok'); MC.render();
    });
  }
  async function changeApps(o) {
    const s = o.subscription || {};
    const allowed = o.allowedModules.filter(m => m !== 'payer');
    const v = await dialog({ title: T('pd.apps_title', 'Apps for {name}', { name: o.name }), wide: true, form: true,
      body: html`<p class="muted sm">${T('pd.apps_hint', 'Staff get or lose access to an app as soon as you save. Delivery needs the pharmacy or the lab app.')}</p>
        <div class="grid two"><div>${allowed.map(m => html`<label class="check"><input type="checkbox" name="modules" data-list="1" value="${m}" ${o.modules.includes(m) ? 'checked' : ''} ${ALWAYS.includes(m) ? 'disabled' : ''}><span>${modLabel(m)}${ALWAYS.includes(m) ? html` <span class="xs muted">${T('pd.always', 'always included')}</span>` : ''}</span></label>`)}</div>
        <div><h3>${T('pd.new_price', 'New price')}</h3>${s.manualPrice ? html`<div class="notice warn">${T('pd.manual_keep', 'This provider has a negotiated price of {p}. It stays the same; clear it in Edit subscription to use the calculated price.', { p: money(s.monthlyKobo) })}</div>` : ''}<div id="hq-quote" aria-live="polite">${MC.skeleton(2)}</div></div></div>`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pd.apps_save', 'Save apps'), primary: true }],
      onOpen: d => {
        const box = d.querySelector('#hq-quote'); let n = 0;
        const update = async () => {
          const mods = [...d.querySelectorAll('input[name=modules]')].filter(x => x.checked).map(x => x.value); const my = ++n;
          try { const q = await api.post('/api/pricing/quote', { type: o.type, modules: mods, seats: s.seats, period: s.period }); if (my !== n || !box.isConnected) return; const diff = q.monthlyKobo - (s.monthlyKobo || 0); MC.view(html`${quoteView(q)}${!s.manualPrice ? html`<p class="sm" style="margin-top:8px">${T('pd.diff', 'Change: {d} a month', { d: (diff >= 0 ? '+' : '-') + money(Math.abs(diff)) })}</p>` : ''}`, box); box.dataset.kobo = String(q.monthlyKobo); }
          catch (e) { if (my === n && box.isConnected) MC.view(html`<div class="notice bad">${e.message}</div>`, box); }
        };
        d.addEventListener('change', update); update();
      },
      onSubmit: async d => {
        const mods = (d.modules || []).concat(ALWAYS.filter(m => allowed.includes(m)));
        const box = document.getElementById('hq-quote'); const newPrice = s.manualPrice ? s.monthlyKobo : Number(box && box.dataset.kobo);
        if (!(await confirm({ title: T('pd.apps_q', 'Save these apps?'), body: T('pd.apps_q_body', '{name} will have: {apps}. Monthly price: {p}. Staff using a removed app lose access immediately.', { name: o.name, apps: mods.map(modLabel).join(', '), p: Number.isFinite(newPrice) ? money(newPrice) : '-' }), ok: T('pd.apps_save', 'Save apps') }))) return false;
        return api.patch('/api/hq/providers/' + o.id + '/modules', { modules: mods });
      } });
    if (v) { toast(T('pd.apps_saved', 'Apps saved. Monthly price {p}.', { p: money((v.subscription || {}).monthlyKobo) }), 'ok'); MC.render(); }
  }
  async function editSubscription(o) {
    const s = o.subscription || {};
    const plans = (await api.get('/api/hq/plans').catch(() => [])).filter(p => p.active !== false && (p.orgTypes || []).includes(o.type));
    const v = await dialog({ title: T('pd.sub_title', 'Subscription for {name}', { name: o.name }), form: true,
      body: html`<div class="fields two">
        ${field('ps-st', T('pd.sub_status', 'Status'), html`<select class="input" id="ps-st" name="status">${SUB_STATUSES.map(x => opt(x, st(x), s.status === x))}</select>`, T('pd.sub_status_hint', 'Choosing trial restarts the trial from today.'))}
        ${field('ps-td', T('pd.trial_days', 'Trial length (days)'), html`<input class="input" id="ps-td" name="trialDays" type="number" min="1" max="365" placeholder="30">`, T('pd.trial_days_hint', 'Only used when the status is trial.'))}
        ${field('ps-se', T('pd.seats', 'Staff accounts'), html`<input class="input" id="ps-se" name="seats" type="number" min="1" max="100000" value="${s.seats || ''}">`)}
        ${field('ps-pe', T('pd.period', 'Billing period'), html`<select class="input" id="ps-pe" name="period">${opt('monthly', T('pd.monthly', 'Monthly'), s.period !== 'annual')}${opt('annual', T('pd.annual', 'Yearly'), s.period === 'annual')}</select>`)}</div>
        ${field('ps-mp', T('pd.manual', 'Negotiated monthly price (NGN, optional)'), html`<input class="input" id="ps-mp" name="monthlyKobo" type="number" min="0" step="1" data-kobo placeholder="${s.manualPrice ? String(s.monthlyKobo / 100) : T('pd.manual_ph', 'Leave empty to use the calculated price')}">`, T('pd.manual_hint', 'A negotiated price replaces the calculated price until you clear it.'))}
        ${s.manualPrice ? html`<label class="check"><input type="checkbox" name="clearManualPrice"><span>${T('pd.clear_manual', 'Clear the negotiated price ({p}) and use the calculated price', { p: money(s.monthlyKobo) })}</span></label>` : ''}
        ${plans.length ? field('ps-pr', T('pd.apply_preset', 'Apply a preset (optional)'), html`<select class="input" id="ps-pr" name="applyPreset">${opt('', T('pd.no_preset', 'No, keep the current apps'), true)}${plans.map(p => opt(p.id, p.label + ' (' + p.modules.map(modLabel).join(', ') + ')', false))}</select>`, T('pd.preset_hint', 'A preset replaces the apps and staff accounts with the preset\'s.')) : ''}`,
      actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pd.sub_save', 'Save subscription'), primary: true }],
      onSubmit: async d => {
        const b = {};
        if (d.status && d.status !== s.status) b.status = d.status;
        if (d.status === 'trial' && d.trialDays) b.trialDays = d.trialDays;
        if (d.seats && d.seats !== s.seats) b.seats = d.seats;
        if (d.period && d.period !== (s.period || 'monthly')) b.period = d.period;
        if (d.monthlyKobo != null) b.monthlyKobo = d.monthlyKobo;
        if (d.clearManualPrice) b.clearManualPrice = true;
        if (d.applyPreset) b.applyPreset = d.applyPreset;
        if (!Object.keys(b).length) throw new MC.ApiError(400, { error: T('pd.nothing', 'Nothing has changed.') });
        const lines = [];
        if (b.status) lines.push(T('pd.c_status', 'status becomes {s}', { s: st(b.status) }));
        if (b.seats) lines.push(T('pd.c_seats', '{n} staff accounts', { n: b.seats }));
        if (b.period) lines.push(b.period === 'annual' ? T('pd.c_annual', 'billed yearly') : T('pd.c_monthly', 'billed monthly'));
        if (b.monthlyKobo != null) lines.push(T('pd.c_manual', 'negotiated price {p} a month', { p: money(b.monthlyKobo) }));
        if (b.clearManualPrice) lines.push(T('pd.c_clear', 'negotiated price removed'));
        if (b.applyPreset) lines.push(T('pd.c_preset', 'apps and staff accounts replaced by the preset'));
        if (!(await confirm({ title: T('pd.sub_q', 'Change the subscription?'), body: T('pd.sub_q_body', 'For {name}: {changes}. The price is recalculated unless a negotiated price is set.', { name: o.name, changes: lines.join('; ') }), ok: T('pd.sub_save', 'Save subscription'), danger: b.status === 'cancelled' }))) return false;
        return api.patch('/api/hq/providers/' + o.id + '/subscription', b);
      } });
    if (v) { toast(T('pd.sub_saved', 'Subscription saved. Monthly price {p}.', { p: money((v.subscription || {}).monthlyKobo) }), 'ok'); MC.render(); }
  }

  /* ---------- per-provider overrides ---------- */
  const FEATURE_INFO = {
    patientSelfSignup: 'Patients can create their own accounts', providerSelfSignup: 'Providers can sign up on the website', publicEmergency: 'Anyone can report an emergency without an account', videoVisits: 'Video consultations',
    marketplace: 'Patients can find and book any listed provider', homeDelivery: 'Medicine and sample delivery', ussd: 'USSD service for feature phones', whatsapp: 'WhatsApp channel (needs WhatsApp Business API)', ai: 'AI assistant (master switch)',
    aiPatientAssistant: 'AI health assistant for patients', aiClinicianAssistant: 'AI drafting help for doctors (doctor approves)', aiLabExplainer: 'AI plain-language lab result explanations', chw: 'Community health worker app', onlinePayments: 'Online card, transfer and USSD payments',
    cashPayments: 'Cash and POS at the counter', hmoClaims: 'HMO cover, pre-authorisation and claims', lowDataMode: 'Low-data mode (fewer images and maps)', maintenanceMode: 'Maintenance mode: providers can read but not change anything',
    groups: 'Hospital groups with several branches', referralNetwork: 'Referrals between providers', providerMessaging: 'Private messages between providers', providerDirectory: 'Provider directory for staff (find partners)',
  };
  const PROC_LABELS = {
    security: 'Security', 'security.passwordMinLength': 'Minimum password length', 'security.sessionHours': 'Sign-in lasts (hours)', 'security.lockoutAttempts': 'Wrong passwords before lock', 'security.lockoutMinutes': 'Lock lasts (minutes)', 'security.otpMinutes': 'SMS codes expire after (minutes)', 'security.loginPerIpPer5Min': 'Sign-ins allowed per network in 5 minutes',
    appointments: 'Appointments', 'appointments.patientCancelHours': 'Patients can cancel up to (hours before)', 'appointments.defaultSlotMinutes': 'Default slot length (minutes)', 'appointments.videoJoinEarlyMinutes': 'Video room opens early by (minutes)', 'appointments.videoJoinLateMinutes': 'Video room stays open for (minutes after start)', 'appointments.payBeforeVideo': 'Video visits must be paid first',
    pharmacy: 'Pharmacy', 'pharmacy.pickupWindowDays': 'Days to collect before an order is missed', 'pharmacy.deliveryCodeAttempts': 'Wrong delivery codes before lock', 'pharmacy.requirePharmacistVerify': 'A pharmacist must verify every prescription', 'pharmacy.allowSubstitution': 'Allow generic substitution with a reason',
    lab: 'Laboratory', 'lab.twoStepVerifyDefault': 'New labs need a second scientist to verify', 'lab.collectBeforePaymentForUrgent': 'Urgent samples can be taken before payment',
    hmo: 'HMO', 'hmo.preauthThresholdKobo': 'Pre-authorisation needed above (NGN)', 'hmo.duplicateWindowHours': 'Duplicate claim window (hours)', 'hmo.frequencyLimitPer30Days': 'Same service per patient per 30 days before flag',
    emergency: 'Emergency', 'emergency.publicPerIpPerHour': 'Public reports per network per hour', 'emergency.sosRadiusKm': 'Search radius for the nearest ambulance (km)', 'emergency.locationFreshSeconds': 'Ambulance location counts as live for (seconds)',
    delivery: 'Delivery', 'delivery.riderLocationFreshSeconds': 'Rider location counts as live for (seconds)',
    billing: 'Billing', 'billing.platformFeeKobo': 'MediCore fee per bill (NGN)', 'billing.bankChargeKobo': 'Bank service charge per payment (NGN)', 'billing.showBankChargeToPatient': 'Show the bank charge to patients',
    ai: 'AI assistant', 'ai.patientDailyMessages': 'AI messages per patient per day', 'ai.conversationRetentionDays': 'Keep AI conversations for (days)',
    patients: 'Patients and providers', 'patients.mode': 'How patients relate to providers', 'patients.allowMultipleProviders': 'A patient can belong to more than one provider', 'patients.applicationsNeedApproval': 'Patient applications need approval', 'patients.crossProviderSharing': 'Patients can share records with another provider themselves', 'patients.applicationExpiryDays': 'Unanswered applications expire after (days)',
    branches: 'Hospital groups and branches', 'branches.requireApproval': 'New branches need HQ approval', 'branches.shareRecordsAcrossBranches': 'Branches see each other\'s patient records', 'branches.branchAdminsManageModules': 'Branch admins can change apps and subscription',
    referrals: 'Referrals', 'referrals.requireConnection': 'Refer only to partners', 'referrals.requirePatientConsent': 'Patient consent needed to refer', 'referrals.expireDays': 'Unanswered referrals expire after (days)', 'referrals.notifyPatient': 'Tell the patient about referrals',
  };
  const MODE_LABELS = { provider: 'Provider mode', open: 'Open mode' };
  const human = k => cap(String(k).replace(/([A-Z])/g, ' $1').toLowerCase());
  const procLabel = p => T('pr.' + p, PROC_LABELS[p] || human(p.split('.').pop()));
  const getP = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const setP = (o, p, v) => { const ks = p.split('.'); let c = o; for (let i = 0; i < ks.length - 1; i++) { if (!c[ks[i]] || typeof c[ks[i]] !== 'object') c[ks[i]] = {}; c = c[ks[i]]; } c[ks[ks.length - 1]] = v; };
  const leaves = (o, pre = '', out = []) => { Object.entries(o || {}).forEach(([k, v]) => { const p = pre ? pre + '.' + k : k; if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, p, out); else out.push(p); }); return out; };
  const isKobo = p => /Kobo$/.test(p);
  const showVal = (p, v) => (typeof v === 'boolean' ? (v ? T('ovr.on', 'On') : T('ovr.off', 'Off')) : isKobo(p) ? money(v) : (v === '' || v == null ? T('ovr.empty', '(empty)') : String(v)));

  async function providerOverrides({ params, stale }) {
    const [o, ov, cfg] = await Promise.all([api.get('/api/hq/providers/' + encodeURIComponent(params.id)), api.get('/api/hq/config/orgs/' + encodeURIComponent(params.id) + '/overrides'), api.get('/api/hq/config')]);
    if (stale()) return;
    const plat = cfg.settings; const cur = ov.overrides || {}; const edit = can('platform.orgs');
    const dis = edit ? '' : 'disabled';
    const mark = (sec, p) => { const v = getP(cur[sec], p); if (v === undefined) return ''; const pv = getP(plat[sec], p); return v === pv || JSON.stringify(v) === JSON.stringify(pv) ? html` ${badge(T('ovr.same', 'Set, same as platform'), 'outline')}` : html` ${badge(T('ovr.differs', 'Differs from platform: {v}', { v: showVal(p, pv) }), 'warn')}`; };
    const tri = (name, v, pv) => html`<select class="input" name="${name}" id="ov-${name}" ${dis}>${opt('', T('ovr.default', 'Platform default ({v})', { v: pv ? T('ovr.on', 'On') : T('ovr.off', 'Off') }), v === undefined)}${opt('on', T('ovr.force_on', 'On for this provider'), v === true)}${opt('off', T('ovr.force_off', 'Off for this provider'), v === false)}</select>`;
    const featKeys = Object.keys(plat.features).filter(k => typeof plat.features[k] === 'boolean');
    const procSecs = Object.keys(plat.process);
    const contentGlobal = Object.keys(plat.content.global || {});
    const contentApps = Object.entries(plat.content.apps || {});
    const nOver = Object.values(cur).reduce((a, s) => a + leaves(s).length, 0);
    view(html`${providerHead(o)}${providerTabs(o, '#/providers/' + o.id + '/overrides')}
      <p class="muted">${T('ovr.sub', 'Settings that apply to this provider only. Anything left on "Platform default" follows the platform configuration, including future changes.')}</p>
      ${!edit ? html`<div class="notice warn">${T('ovr.read_only', 'You can view these settings but not change them.')}</div>` : ''}
      ${figures([{ value: nOver, label: T('ovr.count', 'Own settings for this provider') }])}
      <form data-form="ovr-save" novalidate>
        <section class="panel"><h2>${T('ovr.features', 'Features')}</h2><div class="fields two">${featKeys.map(k => { const name = 'f.' + k; return html`<div class="field"><label for="ov-${name}">${T('ft.' + k, FEATURE_INFO[k] || human(k))}${mark('features', k)}</label>${tri(name, getP(cur.features, k), plat.features[k])}</div>`; })}</div></section>
        <section class="panel"><h2>${T('ovr.process', 'Processes')}</h2><p class="muted sm">${T('ovr.process_hint', 'Leave a number empty to use the platform value shown in grey.')}</p>
          ${procSecs.map(sec => html`<h3>${T('pr.' + sec, PROC_LABELS[sec] || human(sec))}</h3><div class="fields two">${Object.keys(plat.process[sec]).map(k => { const p = sec + '.' + k; const pv = plat.process[sec][k]; const v = getP(cur.process, p); const name = 'p.' + p;
            if (typeof pv === 'boolean') return html`<div class="field"><label for="ov-${name}">${procLabel(p)}${mark('process', p)}</label>${tri(name, v, pv)}</div>`;
            if (p === 'patients.mode') return html`<div class="field"><label for="ov-${name}">${procLabel(p)}${mark('process', p)}</label><select class="input" name="${name}" id="ov-${name}" ${dis}>${opt('', T('ovr.default_v', 'Platform default ({v})', { v: T('ovr.mode.' + pv, MODE_LABELS[pv] || cap(pv)) }), v === undefined)}${Object.keys(MODE_LABELS).map(m => opt('s:' + m, T('ovr.mode_for', '{m} for this provider', { m: T('ovr.mode.' + m, MODE_LABELS[m]) }), v === m))}</select></div>`;
            if (typeof pv !== 'number') return '';
            return html`<div class="field"><label for="ov-${name}">${procLabel(p)}${mark('process', p)}</label><input class="input" id="ov-${name}" name="${name}" type="number" min="0" step="any" ${isKobo(p) ? MC.raw('data-kobo') : ''} value="${v === undefined ? '' : isKobo(p) ? v / 100 : v}" placeholder="${isKobo(p) ? pv / 100 : pv}" ${dis}></div>`; })}</div>`)}</section>
        <section class="panel"><h2>${T('ovr.content', 'Texts')}</h2><p class="muted sm">${T('ovr.content_hint', 'Leave a text empty to use the platform text shown in grey. A text set for one app wins over the text for all apps.')}</p>
          <h3>${T('ovr.all_apps', 'All apps')}</h3>${contentGlobal.map(k => { const p = 'global.' + k; const name = 'c.' + p; const v = getP(cur.content, p); return html`<div class="field"><label for="ov-${name}">${human(k)}${mark('content', p)}</label><textarea class="input" id="ov-${name}" name="${name}" rows="2" maxlength="4000" placeholder="${plat.content.global[k] || ''}" ${dis}>${v == null ? '' : v}</textarea></div>`; })}
          <details ${leaves(cur.content && cur.content.apps).length ? 'open' : ''}><summary class="btn ghost">${T('ovr.per_app', 'Texts for one app')}</summary>${contentApps.map(([a, fields]) => html`<h3 style="margin-top:12px">${cap(a)}</h3>${Object.keys(fields).map(k => { const p = 'apps.' + a + '.' + k; const name = 'c.' + p; const v = getP(cur.content, p); return html`<div class="field"><label for="ov-${name}">${human(k)}${mark('content', p)}</label><textarea class="input" id="ov-${name}" name="${name}" rows="2" maxlength="4000" placeholder="${fields[k] || ''}" ${dis}>${v == null ? '' : v}</textarea></div>`; })}`)}</details></section>
        <div class="form-err notice bad" hidden></div>
        ${edit ? html`<div class="btn-row"><button class="btn primary" type="submit">${T('ovr.save', 'Save own settings')}</button>${nOver ? html`<button type="button" class="btn" data-action="ovr-clear">${T('ovr.clear_all', 'Remove all own settings')}</button>` : ''}</div>` : ''}
      </form>`);
    form('ovr-save', async d => {
      const next = { features: {}, process: {}, content: {} };
      Object.entries(d).forEach(([name, v]) => {
        if (v === undefined || v === '') return;
        const sec = { f: 'features', p: 'process', c: 'content' }[name[0]]; const p = name.slice(2); if (!sec) return;
        if (v === 'on' || v === 'off') setP(next[sec], p, v === 'on');
        else if (typeof v === 'string' && v.startsWith('s:')) setP(next[sec], p, v.slice(2));
        else if (sec === 'process') setP(next[sec], p, Number(v));
        else setP(next[sec], p, String(v));
      });
      const resets = {}; const sets = {}; let changed = 0;
      ['features', 'process', 'content'].forEach(sec => {
        const before = cur[sec] || {}; const after = next[sec];
        if (JSON.stringify(leaves(before).sort().map(p => [p, getP(before, p)])) === JSON.stringify(leaves(after).sort().map(p => [p, getP(after, p)]))) return;
        changed++;
        const removed = leaves(before).some(p => getP(after, p) === undefined);
        if (removed || !leaves(after).length) resets[sec] = null;
        if (leaves(after).length) sets[sec] = after;
      });
      if (!changed) { toast(T('ovr.no_change', 'Nothing has changed')); return; }
      // the API merges objects and only clears whole sections (null), so a removed value needs a reset first
      if (Object.keys(resets).length) await api.patch('/api/hq/config/orgs/' + o.id + '/overrides', resets);
      if (Object.keys(sets).length) await api.patch('/api/hq/config/orgs/' + o.id + '/overrides', sets);
      toast(T('ovr.saved', 'Own settings saved for {name}. The apps pick them up within a minute.', { name: o.name }), 'ok'); MC.render();
    });
    on('ovr-clear', async () => {
      if (!(await confirm({ title: T('ovr.clear_q', 'Remove all own settings?'), body: T('ovr.clear_body', '{name} goes back to the platform features, processes and texts.', { name: o.name }), ok: T('ovr.clear_all', 'Remove all own settings'), danger: true }))) return;
      await api.patch('/api/hq/config/orgs/' + o.id + '/overrides', { features: null, process: null, content: null });
      toast(T('ovr.cleared', 'Own settings removed'), 'ok'); MC.render();
    });
  }

  /* ---------- audit (shared table) ---------- */
  function auditTable(rows, orgNames) {
    return html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('au.when', 'When')}</th><th>${T('au.who', 'Who')}</th><th>${T('au.action', 'Action')}</th>${orgNames ? html`<th>${T('au.provider', 'Provider')}</th>` : ''}<th>${T('au.record', 'Record')}</th><th>${T('au.from', 'From')}</th></tr></thead><tbody>
      ${rows.map(a => html`<tr><td data-label="${T('au.when', 'When')}">${dateTime(a.at)}</td><td data-label="${T('au.who', 'Who')}">${a.actorName || T('au.public', 'Public')}${a.role || a.actorKind ? html`<br><span class="xs muted">${cap(a.role || a.actorKind)}</span>` : ''}</td><td data-label="${T('au.action', 'Action')}"><b>${a.action}</b></td>${orgNames ? html`<td data-label="${T('au.provider', 'Provider')}">${a.orgId ? html`<a href="#/providers/${a.orgId}">${orgNames[a.orgId] || a.orgId}</a>` : html`<span class="muted">${T('au.platform', 'Platform')}</span>`}</td>` : ''}<td data-label="${T('au.record', 'Record')}" class="xs">${a.targetType || ''} ${a.targetId || ''}${a.patientId ? html`<br>${T('au.patient', 'Patient')} ${a.patientId}` : ''}</td><td data-label="${T('au.from', 'From')}" class="xs">${a.app || ''}${a.ip ? html`<br>${a.ip}` : ''}</td></tr>`)}
    </tbody></table></div>`;
  }
  async function providerAudit({ params, query, stale }) {
    const [o, rows] = await Promise.all([api.get('/api/hq/providers/' + encodeURIComponent(params.id)), api.get('/api/hq/providers/' + encodeURIComponent(params.id) + '/audit' + qs({ action: query.action, before: query.before, limit: 100 }))]);
    if (stale()) return;
    const base = '#/providers/' + o.id + '/audit';
    view(html`${providerHead(o)}${providerTabs(o, base)}
      <form data-form="pa-filter" class="row wrap" style="margin-bottom:16px" novalidate><label class="sr-only" for="pa-a">${T('au.action_filter', 'Action starts with')}</label><input class="input" id="pa-a" name="action" value="${query.action || ''}" placeholder="${T('au.action_ph', 'Action starts with, e.g. patient.')}" style="max-width:320px"><button class="btn" type="submit">${icon('search')}${T('au.filter', 'Filter')}</button></form>
      ${rows.length ? html`${auditTable(rows)}${rows.length === 100 ? html`<div class="btn-row"><a class="btn" href="${base}${qs({ action: query.action, before: rows[rows.length - 1].at })}">${T('au.older', 'Older entries')}</a></div>` : ''}` : empty({ icon: 'shield', title: T('au.empty', 'No audit entries'), body: T('au.empty_sub', 'Changes and record views at this provider appear here.') })}`);
    form('pa-filter', d => MC.go(base + qs({ action: d.action })));
  }

  /* ======================= hospital groups ======================= */
  const pvTabs = (cur, nGroups) => tabsNav([['#/providers', T('pv.t.providers', 'All providers')], ['#/groups', nGroups != null ? T('pv.t.groups_n', 'Hospital groups ({n})', { n: nGroups }) : T('pv.t.groups', 'Hospital groups')]], cur, T('pv.sections', 'Provider views'));
  async function groupsList({ query, stale }) {
    const rows = await api.get('/api/hq/groups' + qs({ status: query.status, q: query.q }));
    if (stale()) return;
    view(html`${head(T('gr.title', 'Hospital groups'), T('gr.sub', 'Companies that run several branches. Each branch is a provider with its own apps; the group pays one consolidated subscription.'))}${pvTabs('#/groups')}
      <form data-form="gr-filter" class="panel" novalidate><div class="fields two">
        ${field('gr-q', T('gr.search', 'Search name or code'), html`<input class="input" id="gr-q" name="q" type="search" value="${query.q || ''}" maxlength="80">`)}
        ${field('gr-s', T('pv.status', 'Status'), html`<select class="input" id="gr-s" name="status">${opt('', T('pv.any_status', 'Any status'), !query.status)}${ORG_STATUSES.map(x => opt(x, st(x), query.status === x))}</select>`)}
      </div><div class="row wrap"><button class="btn primary" type="submit">${icon('search')}${T('gr.apply', 'Show groups')}</button>${query.q || query.status ? html`<a class="btn ghost" href="#/groups">${T('pv.clear', 'Clear filters')}</a>` : ''}</div></form>
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('gr.c.name', 'Group')}</th><th>${T('gr.c.status', 'Status')}</th><th class="num">${T('gr.c.branches', 'Branches')}</th><th class="num">${T('gr.c.monthly', 'Per month')}</th><th>${T('gr.c.created', 'Created')}</th></tr></thead><tbody>
        ${rows.map(g => html`<tr><td data-label="${T('gr.c.name', 'Group')}"><a href="#/groups/${g.id}"><b>${g.name}</b></a><br><span class="xs muted">${g.code}</span></td><td data-label="${T('gr.c.status', 'Status')}">${sBadge(g.status)}</td><td class="num" data-label="${T('gr.c.branches', 'Branches')}">${T('gr.branches_n', '{a} active of {n}', { a: g.activeBranches, n: g.branches })}</td><td class="num" data-label="${T('gr.c.monthly', 'Per month')}">${money(g.monthlyKobo)}</td><td data-label="${T('gr.c.created', 'Created')}">${date(g.createdAt)}</td></tr>`)}
      </tbody></table></div>` : empty({ icon: 'building', title: T('gr.empty', 'No hospital groups match'), body: T('gr.empty_sub', 'Groups appear when a provider signs up as a group or an owner turns a provider into a group.') })}`);
    form('gr-filter', d => MC.go('#/groups' + qs({ q: d.q, status: d.status })));
  }
  const GROUP_ROLES = { group_owner: 'Group owner', group_admin: 'Group admin', group_finance: 'Group finance', group_viewer: 'Group viewer' };
  async function groupDetail({ params, stale }) {
    let g;
    try { g = await api.get('/api/hq/groups/' + encodeURIComponent(params.id)); } catch (e) { if (e.status === 404) return view(html`${back('#/groups', T('gr.title', 'Hospital groups'))}${empty({ icon: 'building', title: T('gr.not_found', 'Group not found'), action: html`<a class="btn" href="#/groups">${T('gr.back', 'Back to hospital groups')}</a>` })}`); throw e; }
    if (stale()) return;
    const q = g.quote || {}; const c = g.contact || {}; const edit = can('platform.orgs');
    view(html`${back('#/groups', T('gr.title', 'Hospital groups'))}${head(g.name, html`${T('gr.code', 'Code')} <b>${g.code}</b> | ${sBadge(g.status)}`, edit ? (g.status === 'active' ? html`<button class="btn" data-action="gr-suspend">${icon('stop')}${T('gr.suspend', 'Suspend group')}</button>` : g.status === 'suspended' ? html`<button class="btn primary" data-action="gr-reactivate">${icon('refresh')}${T('gr.reactivate', 'Reactivate group')}</button>` : '') : '')}
      ${g.status === 'suspended' ? html`<div class="notice bad"><b>${T('gr.suspended_note', 'Suspended. Nobody at any branch can sign in.')}</b>${g.statusReason ? html`<br>${T('pd.reason', 'Reason')}: ${g.statusReason}` : ''}</div>` : ''}
      ${g.status === 'pending' ? html`<div class="notice warn">${T('gr.pending_note', 'Waiting for approval. Approving the first branch approves the group.')}</div>` : ''}
      ${figures([{ value: g.branches.length, label: T('gr.f.branches', 'Branches') }, { value: g.branches.filter(b => b.status === 'active').length, label: T('gr.f.active', 'Active branches') }, { value: g.admins.length, label: T('gr.f.admins', 'Group admins') }, { value: money(q.monthlyKobo), label: T('gr.f.monthly', 'Per month, all branches') }])}
      <section class="panel flush"><h2>${T('gr.branches', 'Branches')}</h2>${g.branches.length ? html`<div class="list">${g.branches.map(b => html`<a href="#/providers/${b.id}"><div class="grow"><span class="title">${b.branchName || b.name}</span><span class="sub">${b.name} | ${typeLabel(b.type)} | ${b.code}${b.area || b.city ? ' | ' + (b.area || b.city) : ''}</span><span class="sub">${(b.modules || []).map(modLabel).join(', ')}</span></div><span class="end">${sBadge(b.status)}</span></a>`)}</div>` : html`<p class="muted" style="padding:0 16px 16px">${T('gr.no_branches', 'No branches yet.')}</p>`}</section>
      <div class="grid two">
        <section class="panel"><h2>${T('gr.quote', 'Consolidated subscription')}</h2>
          <dl class="kv">${(q.branches || []).map(l => html`<dt>${l.name} ${l.status !== 'active' ? html`<span class="xs">${sBadge(l.status)}</span>` : ''}</dt><dd style="white-space:nowrap">${money(l.monthlyKobo)}${l.status !== 'active' && l.status !== 'pending' ? html` <span class="xs muted">${T('gr.not_counted', 'not counted')}</span>` : ''}</dd>`)}
            <dt>${T('gr.subtotal', 'Subtotal ({n} branches)', { n: q.branchCount || 0 })}</dt><dd style="white-space:nowrap">${money(q.subtotalKobo)}</dd>
            ${q.discount ? html`<dt>${T('gr.discount', 'Group discount ({p}% from {n} branches)', { p: q.discount.percent, n: q.discount.minBranches })}</dt><dd style="white-space:nowrap">-${money(q.discount.kobo)}</dd>` : ''}
            <dt><b>${T('gr.total', 'Monthly total')}</b></dt><dd style="white-space:nowrap"><b>${money(q.monthlyKobo)}</b></dd>
            <dt>${T('pd.q.bank', 'Bank service charge per payment')}</dt><dd style="white-space:nowrap">${money(q.bankChargePerPaymentKobo)}</dd></dl>
          <p class="muted sm" style="margin-top:12px">${T('gr.quote_hint', 'Each branch keeps its own package. Group discounts are set in Configuration, Pricing.')}</p></section>
        <section class="panel"><h2>${T('gr.contact', 'Contact')}</h2><dl class="kv"><dt>${T('pd.phone', 'Phone')}</dt><dd>${c.phone || '-'}</dd><dt>${T('pd.email', 'Email')}</dt><dd>${c.email || '-'}</dd><dt>${T('pd.address', 'Address')}</dt><dd>${c.address || '-'}</dd><dt>${T('pd.created', 'Signed up')}</dt><dd>${dateTime(g.createdAt)}</dd></dl></section>
      </div>
      <section class="panel flush"><h2>${T('gr.admins', 'Group admins')}</h2>${g.admins.length ? html`<div class="list">${g.admins.map(a => html`<li><div class="grow"><span class="title">${a.name || '-'}${a.isOwner ? html` ${badge(T('gr.owner', 'Owner'), 'hue')}` : ''}</span><span class="sub">${T('grrole.' + a.role, GROUP_ROLES[a.role] || cap(a.role))}${a.email ? ' | ' + a.email : ''}</span></div><span class="end">${sBadge(a.status)}</span></li>`)}</div>` : html`<p class="muted" style="padding:0 16px 16px">${T('gr.no_admins', 'No group admins.')}</p>`}</section>`);
    on('gr-suspend', async () => {
      const v = await dialog({ title: T('gr.suspend_q', 'Suspend {name}?', { name: g.name }), form: true, body: html`<div class="notice bad"><b>${T('gr.suspend_warn', 'Every staff member at every branch, and every group admin, is signed out immediately.')}</b> ${T('gr.suspend_warn2', 'Nobody can sign in again until you reactivate the group. Patients cannot book or order from its branches. No data is deleted.')}</div>${field('gr-sr', T('pd.suspend_reason', 'Reason (kept in the status history)'), html`<textarea class="input" id="gr-sr" name="reason" required minlength="5" maxlength="500"></textarea>`, T('pd.reason_hint2', 'At least 5 characters, for example "Subscription unpaid for 60 days".'))}`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('gr.suspend_ok', 'Suspend group and sign everyone out'), primary: true }],
        onSubmit: async d => { if (!d.reason || d.reason.trim().length < 5) throw new MC.ApiError(400, { error: T('gr.reason_short', 'Give a reason of at least 5 characters.') }); try { return await api.post('/api/hq/groups/' + g.id + '/suspend', { reason: d.reason.trim() }); } catch (e) { if (e.status === 409) { toast(e.message, 'bad'); MC.render(); return null; } throw e; } } });
      if (v) { toast(T('gr.suspended', '{name} suspended. {n} sessions signed out.', { name: g.name, n: v.sessionsRevoked }), 'ok'); MC.render(); }
    });
    on('gr-reactivate', async () => {
      if (!(await confirm({ title: T('gr.react_q', 'Reactivate {name}?', { name: g.name }), body: T('gr.react_body', 'Staff and admins at every branch can sign in again. Branches HQ suspended one by one stay suspended.'), ok: T('gr.reactivate', 'Reactivate group') }))) return;
      try { await api.post('/api/hq/groups/' + g.id + '/reactivate'); } catch (e) { if (e.status === 409) { toast(e.message, 'bad'); MC.render(); return; } throw e; }
      toast(T('gr.reactivated', '{name} reactivated', { name: g.name }), 'ok'); MC.render();
    });
  }

  /* ======================= plan presets ======================= */
  async function plans({ stale }) {
    const rows = await api.get('/api/hq/plans');
    if (stale()) return;
    const edit = can('platform.plans');
    view(html`${head(T('pl.title', 'Plan presets'), T('pl.sub', 'Ready-made packages you can apply to a provider. Editing a preset never changes any provider\'s current subscription or price.'), edit ? html`<button class="btn primary" data-action="pl-new">${icon('plus')}${T('pl.new', 'New preset')}</button>` : '')}
      ${!edit ? html`<div class="notice">${T('pl.read_only', 'Only the platform owner can create or edit presets.')}</div>` : ''}
      ${rows.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('pl.name', 'Preset')}</th><th>${T('pl.for', 'For')}</th><th>${T('pl.apps', 'Apps')}</th><th class="num">${T('pl.price', 'Price')}</th><th class="num">${T('pl.seats', 'Staff accounts')}</th><th>${T('pl.status', 'Status')}</th><th></th></tr></thead><tbody>
        ${rows.map(p => html`<tr><td data-label="${T('pl.name', 'Preset')}"><b>${p.label}</b><br><span class="xs muted">${p.id} | ${T('pl.used', 'used by {n}', { n: p.orgsUsingPreset })}</span></td><td data-label="${T('pl.for', 'For')}">${(p.orgTypes || []).map(typeLabel).join(', ')}</td><td data-label="${T('pl.apps', 'Apps')}" class="xs">${(p.modules || []).map(modLabel).join(', ')}</td><td class="num" data-label="${T('pl.price', 'Price')}">${money(p.priceKobo)}<br><span class="xs muted">${p.period === 'yearly' ? T('pl.per_year', 'per year') : T('pl.per_month', 'per month')}</span></td><td class="num" data-label="${T('pl.seats', 'Staff accounts')}">${p.seats}</td><td data-label="${T('pl.status', 'Status')}">${p.active === false ? badge(T('pl.inactive', 'Inactive'), 'warn') : badge(T('pl.active', 'Active'), 'ok')}</td>
          <td class="num">${edit ? html`<div class="row wrap" style="justify-content:flex-end"><button class="btn sm" data-action="pl-edit" data-id="${p.id}">${T('pl.edit', 'Edit')}</button><button class="btn sm" data-action="pl-toggle" data-id="${p.id}">${p.active === false ? T('pl.activate', 'Activate') : T('pl.deactivate', 'Deactivate')}</button></div>` : ''}</td></tr>`)}
      </tbody></table></div>` : empty({ icon: 'box', title: T('pl.empty', 'No presets yet'), body: T('pl.empty_sub', 'Providers build their own package; presets are optional shortcuts.') })}`);
    const allMods = Object.keys(MODS);
    const body = p => html`${p ? '' : field('pl-k', T('pl.key', 'Key (optional, lower case)'), html`<input class="input" id="pl-k" name="key" pattern="[a-z0-9_-]{3,40}" maxlength="40">`)}
      ${field('pl-l', T('pl.label', 'Name'), html`<input class="input" id="pl-l" name="label" required maxlength="80" value="${p ? p.label : ''}">`)}
      <div class="field"><span class="label">${T('pl.for', 'For')}</span>${Object.keys(TYPES).map(k => html`<label class="check"><input type="checkbox" name="orgTypes" data-list="1" value="${k}" ${p && p.orgTypes.includes(k) ? 'checked' : ''}><span>${typeLabel(k)}</span></label>`)}</div>
      <div class="field"><span class="label">${T('pl.apps', 'Apps')}</span>${allMods.map(m => html`<label class="check"><input type="checkbox" name="modules" data-list="1" value="${m}" ${p ? (p.modules.includes(m) ? 'checked' : '') : (ALWAYS.includes(m) ? 'checked' : '')}><span>${modLabel(m)}</span></label>`)}</div>
      <div class="fields three">${field('pl-p', T('pl.price_ngn', 'Price (NGN)'), html`<input class="input" id="pl-p" name="priceKobo" type="number" min="0" data-kobo required value="${p ? p.priceKobo / 100 : ''}">`)}
      ${field('pl-pe', T('pl.period', 'Period'), html`<select class="input" id="pl-pe" name="period">${opt('monthly', T('pl.monthly', 'Monthly'), !p || p.period !== 'yearly')}${opt('yearly', T('pl.yearly', 'Yearly'), p && p.period === 'yearly')}</select>`)}
      ${field('pl-s', T('pl.seats', 'Staff accounts'), html`<input class="input" id="pl-s" name="seats" type="number" min="1" required value="${p ? p.seats : 10}">`)}</div>`;
    on('pl-new', async () => { if (await dialog({ title: T('pl.new', 'New preset'), wide: true, form: true, body: body(null), actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pl.create', 'Create preset'), primary: true }], onSubmit: d => api.post('/api/hq/plans', { key: d.key, label: d.label, orgTypes: d.orgTypes, modules: d.modules, priceKobo: d.priceKobo, period: d.period, seats: d.seats }) })) { toast(T('pl.created', 'Preset created'), 'ok'); MC.render(); } });
    on('pl-edit', async el => { const p = rows.find(x => x.id === el.dataset.id); if (!p) return; if (await dialog({ title: T('pl.edit_t', 'Edit {name}', { name: p.label }), wide: true, form: true, body: html`<div class="notice">${T('pl.edit_note', 'Providers already on this preset keep their current apps and price.')}</div>${body(p)}`, actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pl.save', 'Save preset'), primary: true }], onSubmit: d => api.patch('/api/hq/plans/' + p.id, { label: d.label, orgTypes: d.orgTypes, modules: d.modules, priceKobo: d.priceKobo, period: d.period, seats: d.seats }) })) { toast(T('pl.saved', 'Preset saved'), 'ok'); MC.render(); } });
    on('pl-toggle', async el => { const p = rows.find(x => x.id === el.dataset.id); if (!p) return; const off = p.active !== false;
      if (off && !(await confirm({ title: T('pl.deact_q', 'Deactivate {name}?', { name: p.label }), body: T('pl.deact_body', 'It can no longer be applied to providers. Providers already using it are not changed.'), ok: T('pl.deactivate', 'Deactivate') }))) return;
      await api.post('/api/hq/plans/' + p.id + (off ? '/deactivate' : '/activate')); toast(off ? T('pl.deactivated', 'Preset deactivated') : T('pl.activated', 'Preset activated'), 'ok'); MC.render(); });
  }

  /* ======================= team ======================= */
  const lastOwner = e => (e && e.code === 'last_owner' ? new MC.ApiError(409, { error: T('tm.last_owner', 'This is the last platform owner. MediCore must always have at least one, so they cannot be given another role or suspended. Make someone else a platform owner first.'), code: 'last_owner' }) : e);
  async function team({ stale }) {
    const d = await api.get('/api/hq/team');
    if (stale()) return;
    const meId = MC.me.user.id; const owners = d.team.filter(m => m.role === 'platform_owner' && m.status === 'active').length;
    view(html`${head(T('tm.title', 'MediCore team'), T('tm.sub', 'People who can use HQ, and what their role lets them do.'), html`<button class="btn primary" data-action="tm-invite">${icon('plus')}${T('tm.invite', 'Invite a team member')}</button>`)}
      ${owners <= 1 ? html`<div class="notice">${T('tm.one_owner', 'There is one platform owner. Their role cannot be changed and they cannot be suspended until there is another owner.')}</div>` : ''}
      <div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('tm.name', 'Name')}</th><th>${T('tm.role', 'Role')}</th><th>${T('tm.status', 'Status')}</th><th>${T('tm.last', 'Last sign in')}</th><th></th></tr></thead><tbody>
        ${d.team.map(m => html`<tr><td data-label="${T('tm.name', 'Name')}"><b>${m.name}</b>${m.userId === meId ? html` ${badge(T('tm.you', 'You'), 'hue')}` : ''}<br><span class="xs muted">${m.email || ''}</span>${m.pendingPasswordChange ? html`<br><span class="xs muted">${T('tm.pending_pw', 'Has not set a password yet')}</span>` : ''}</td><td data-label="${T('tm.role', 'Role')}">${T('role.' + m.role, m.roleLabel || cap(m.role))}</td><td data-label="${T('tm.status', 'Status')}">${sBadge(m.status)}</td><td data-label="${T('tm.last', 'Last sign in')}">${m.lastLoginAt ? ago(m.lastLoginAt) : T('pd.never', 'Never')}</td>
          <td class="num">${m.userId === meId ? '' : html`<div class="row wrap" style="justify-content:flex-end">${m.status === 'active' ? html`<button class="btn sm" data-action="tm-role" data-id="${m.userId}">${T('tm.change_role', 'Change role')}</button><button class="btn sm" data-action="tm-suspend" data-id="${m.userId}">${T('tm.suspend', 'Suspend')}</button>` : html`<button class="btn sm" data-action="tm-react" data-id="${m.userId}">${T('tm.reactivate', 'Reactivate')}</button>`}</div>`}</td></tr>`)}
      </tbody></table></div>
      <section class="panel" style="margin-top:16px"><h2>${T('tm.roles', 'What each role can do')}</h2><dl class="kv">
        <dt>${T('role.platform_owner', 'Platform owner')}</dt><dd>${T('tm.r.owner', 'Everything, including integration keys, prices and the team.')}</dd>
        <dt>${T('role.developer', 'Developer')}</dt><dd>${T('tm.r.dev', 'Providers, configuration, support, audit and demo data. Not integration keys, prices, privacy or the team.')}</dd>
        <dt>${T('role.support', 'Support')}</dt><dd>${T('tm.r.support', 'View providers and work the support queue, including owner password resets.')}</dd>
        <dt>${T('role.compliance', 'Compliance / DPO')}</dt><dd>${T('tm.r.compliance', 'Privacy requests, the breach register, consent records and the audit log.')}</dd></dl></section>`);
    const roleSel = (sel) => html`<select class="input" id="tm-r" name="role" required>${d.roles.map(r => opt(r.key, T('role.' + r.key, r.label), r.key === sel))}</select>`;
    on('tm-invite', async () => {
      const r = await dialog({ title: T('tm.invite', 'Invite a team member'), form: true, body: html`${field('tm-n', T('tm.name', 'Name'), html`<input class="input" id="tm-n" name="name" required maxlength="100" autocomplete="off">`)}${field('tm-e', T('tm.email', 'Work email'), html`<input class="input" id="tm-e" name="email" type="email" required autocomplete="off">`)}${field('tm-r', T('tm.role', 'Role'), roleSel('support'), T('tm.role_hint', 'Give the smallest role that lets them do their job.'))}`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('tm.send', 'Add to the team'), primary: true }], onSubmit: v => api.post('/api/hq/team', v) });
      if (!r) return;
      if (r.tempPassword) await tempPwDialog(T('tm.added', '{name} added to the team', { name: r.member.name }), r.tempPassword, r.note);
      else await dialog({ title: T('tm.added', '{name} added to the team', { name: r.member.name }), body: html`<p>${r.note}</p>`, actions: [{ label: T('common.done', 'Done'), primary: true, value: true }] });
      MC.render();
    });
    on('tm-role', async el => {
      const m = d.team.find(x => x.userId === el.dataset.id); if (!m) return;
      const v = await dialog({ title: T('tm.role_t', 'Change {name}\'s role', { name: m.name }), form: true, body: html`${field('tm-r', T('tm.role', 'Role'), roleSel(m.role), T('tm.role_signout', 'They are signed out of HQ and sign in again with the new role.'))}`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('tm.role_save', 'Change role'), primary: true }],
        onSubmit: async f => { if (f.role === m.role) throw new MC.ApiError(400, { error: T('tm.same_role', 'That is already their role.') }); try { return await api.patch('/api/hq/team/' + m.userId, { role: f.role }); } catch (e) { throw lastOwner(e); } } });
      if (v) { toast(T('tm.role_done', 'Role changed for {name}', { name: m.name }), 'ok'); MC.render(); }
    });
    on('tm-suspend', async el => {
      const m = d.team.find(x => x.userId === el.dataset.id); if (!m) return;
      if (!(await confirm({ title: T('tm.suspend_q', 'Suspend {name}?', { name: m.name }), body: T('tm.suspend_body', 'They are signed out of HQ now and cannot sign in to HQ until reactivated. Any provider or patient accounts they have are not affected.'), ok: T('tm.suspend', 'Suspend'), danger: true }))) return;
      try { await api.post('/api/hq/team/' + m.userId + '/suspend'); } catch (e) { const e2 = lastOwner(e); if (e2.code === 'last_owner') { await dialog({ title: T('tm.last_owner_t', 'Cannot suspend the last owner'), body: html`<div class="notice bad">${e2.message}</div>` }); return; } throw e2; }
      toast(T('tm.suspended', '{name} suspended', { name: m.name }), 'ok'); MC.render();
    });
    on('tm-react', async el => { const m = d.team.find(x => x.userId === el.dataset.id); if (!m) return; await api.post('/api/hq/team/' + m.userId + '/reactivate'); toast(T('tm.reactivated', '{name} reactivated', { name: m.name }), 'ok'); MC.render(); });
  }

  /* ======================= privacy and compliance ======================= */
  const privTabs = cur => tabsNav([['#/privacy', T('pr2.t.requests', 'Patient requests')], ['#/privacy/breaches', T('pr2.t.breaches', 'Breach register')], ['#/privacy/consent', T('pr2.t.consent', 'Consent and data location')]], cur, T('pr2.sections', 'Privacy sections'));
  const REQ_TYPES = { delete: 'Delete my data', correct: 'Correct my data', restrict: 'Restrict use', object: 'Object to use' };
  const reqType = k => T('pr2.type.' + k, REQ_TYPES[k] || cap(k));
  const privHead = () => head(T('pr2.title', 'Privacy and compliance'), T('pr2.sub', 'Patient data requests (30 days to respond), the NDPC breach register (72 hours to notify) and consent records, under the NDPA 2023.'));
  async function privacy({ query, stale }) {
    const rows = await api.get('/api/hq/privacy/requests' + qs({ status: query.status }));
    if (stale()) return;
    const list = query.status ? rows : rows.filter(r => r.status !== 'closed');
    const sub = [['', T('pr2.f.active', 'Not closed')], ['open', st('open')], ['in_progress', st('in_progress')], ['responded', st('responded')], ['closed', st('closed')]];
    view(html`${privHead()}${privTabs('#/privacy')}
      ${tabsNav(sub.map(([k, l]) => ['#/privacy' + qs({ status: k }), l]), '#/privacy' + qs({ status: query.status }), T('pr2.filter', 'Filter by status'))}
      ${list.length ? html`<div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('pr2.patient', 'Patient')}</th><th>${T('pr2.type', 'Request')}</th><th>${T('pr2.status', 'Status')}</th><th>${T('pr2.received', 'Received')}</th><th>${T('pr2.due', 'Due')}</th><th>${T('pr2.assigned', 'Handled by')}</th></tr></thead><tbody>
        ${list.map(r => html`<tr><td data-label="${T('pr2.patient', 'Patient')}"><a href="#/privacy/requests/${r.id}"><b>${r.patientName || T('pr2.unknown', 'Unknown patient')}</b></a><br><span class="xs muted">${r.patientId}</span></td><td data-label="${T('pr2.type', 'Request')}">${reqType(r.type)}</td><td data-label="${T('pr2.status', 'Status')}">${sBadge(r.status)}</td><td data-label="${T('pr2.received', 'Received')}">${date(r.at)}</td><td data-label="${T('pr2.due', 'Due')}">${r.status === 'closed' ? '-' : r.overdue ? badge(T('pr2.overdue', 'Overdue by {n} days', { n: Math.abs(r.daysLeft) }), 'bad') : html`${date(r.dueAt)}<br><span class="xs ${r.daysLeft <= 7 ? '' : 'muted'}">${T('pr2.days_left', '{n} days left', { n: r.daysLeft })}</span>`}</td><td data-label="${T('pr2.assigned', 'Handled by')}">${r.assignedName || html`<span class="muted">${T('pr2.nobody', 'Nobody yet')}</span>`}</td></tr>`)}
      </tbody></table></div>` : empty({ icon: 'shield', title: T('pr2.empty', 'No requests here'), body: T('pr2.empty_sub', 'When a patient asks to see, correct or delete their data from the patient app, the request appears here.') })}`);
  }
  async function privacyRequest({ params, stale }) {
    const r = await api.get('/api/hq/privacy/requests/' + encodeURIComponent(params.id));
    if (stale()) return;
    const openish = r.status !== 'closed';
    const canDelete = r.type === 'delete' && openish && !r.executedAt;
    view(html`${back('#/privacy', T('pr2.t.requests', 'Patient requests'))}${head(reqType(r.type), html`${r.patientName || T('pr2.unknown', 'Unknown patient')} | ${sBadge(r.status)}${r.overdue ? html` ${badge(T('pr2.overdue_short', 'Overdue'), 'bad')}` : ''}`,
      openish ? html`<button class="btn" data-action="pr2-assign">${T('pr2.assign_me', 'Assign to me')}</button>${r.status !== 'responded' ? html`<button class="btn" data-action="pr2-respond">${icon('message')}${T('pr2.respond', 'Respond to patient')}</button>` : ''}<button class="btn" data-action="pr2-close">${T('pr2.close', 'Close request')}</button>${canDelete ? html`<button class="btn danger" data-action="pr2-delete">${icon('trash')}${T('pr2.delete', 'Anonymise patient')}</button>` : ''}` : '')}
      <div class="grid two"><section class="panel"><h2>${T('pr2.details', 'Request')}</h2><dl class="kv">
        <dt>${T('pr2.patient_id', 'Patient id')}</dt><dd>${r.patientId}${r.patientStatus === 'removed' ? html` ${badge(T('pr2.anonymised', 'Anonymised'), 'outline')}` : ''}</dd>
        <dt>${T('pr2.received', 'Received')}</dt><dd>${dateTime(r.at)}</dd><dt>${T('pr2.due', 'Due')}</dt><dd>${date(r.dueAt)}${openish ? html` <span class="sm ${r.overdue ? '' : 'muted'}">(${r.overdue ? T('pr2.overdue', 'Overdue by {n} days', { n: Math.abs(r.daysLeft) }) : T('pr2.days_left', '{n} days left', { n: r.daysLeft })})</span>` : ''}</dd>
        <dt>${T('pr2.assigned', 'Handled by')}</dt><dd>${r.assignedName || '-'}</dd>
        <dt>${T('pr2.note', 'Patient\'s note')}</dt><dd>${r.note || '-'}</dd>
        ${r.response ? html`<dt>${T('pr2.response', 'Our response')}</dt><dd>${r.response}<br><span class="xs muted">${dateTime(r.respondedAt)}</span></dd>` : ''}
        ${r.outcome ? html`<dt>${T('pr2.outcome', 'Outcome')}</dt><dd>${st(r.outcome)}${r.closeNote ? html`<br>${r.closeNote}` : ''}</dd>` : ''}
        ${r.executedAt ? html`<dt>${T('pr2.executed', 'Anonymised')}</dt><dd>${dateTime(r.executedAt)}<br><span class="xs muted">${T('pr2.retention', 'Retention reason')}: ${r.retentionReason || '-'}</span></dd>` : ''}</dl></section>
      <section class="panel"><h2>${T('pr2.history', 'History')}</h2>${(r.history || []).length ? html`<ol class="timeline"><li><time>${dateTime(r.at)}</time>${T('pr2.h_received', 'Received from the patient app')}</li>${r.history.map(h => html`<li><time>${dateTime(h.at)}</time>${st(h.to)}${h.action ? ' (' + cap(h.action) + ')' : ''}</li>`)}</ol>` : html`<p class="muted">${T('pr2.h_none', 'No action yet.')}</p>`}
        ${r.type === 'delete' && openish ? html`<div class="notice warn" style="margin-top:12px">${T('pr2.delete_hint', 'Deletion is done by anonymising the patient. Respond to the patient first if you need to explain what is kept for legal retention.')}</div>` : ''}</section></div>`);
    const after = async (msg) => { toast(msg, 'ok'); MC.render(); };
    on('pr2-assign', async () => { await api.post('/api/hq/privacy/requests/' + r.id + '/assign', {}); after(T('pr2.assigned_t', 'Assigned to you')); });
    on('pr2-respond', async () => { const v = await dialog({ title: T('pr2.respond', 'Respond to patient'), form: true, body: field('pr2-rt', T('pr2.response', 'Our response'), html`<textarea class="input" id="pr2-rt" name="response" required maxlength="2000" rows="5"></textarea>`, T('pr2.response_hint', 'The patient is notified in the app and reads this under Settings, Privacy.')), actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pr2.send', 'Send response'), primary: true }], onSubmit: d => api.post('/api/hq/privacy/requests/' + r.id + '/respond', { response: d.response }) }); if (v) after(T('pr2.responded', 'Response sent to the patient')); });
    on('pr2-close', async () => { const v = await dialog({ title: T('pr2.close', 'Close request'), form: true, body: html`${field('pr2-oc', T('pr2.outcome', 'Outcome'), html`<select class="input" id="pr2-oc" name="outcome" required>${opt('completed', st('completed'), true)}${opt('declined', st('declined'), false)}${opt('withdrawn', st('withdrawn'), false)}</select>`)}${field('pr2-cn', T('pr2.close_note', 'Note (optional)'), html`<input class="input" id="pr2-cn" name="note" maxlength="500">`)}<p class="muted sm">${T('pr2.close_final', 'A closed request cannot be reopened.')}</p>`, actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pr2.close', 'Close request'), primary: true }], onSubmit: d => api.post('/api/hq/privacy/requests/' + r.id + '/close', d) }); if (v) after(T('pr2.closed', 'Request closed')); });
    on('pr2-delete', async () => {
      const v = await dialog({ title: T('pr2.delete_q', 'Anonymise {name}?', { name: r.patientName || r.patientId }), form: true, body: html`<div class="notice bad"><b>${T('pr2.delete_warn', 'This cannot be undone.')}</b></div>
        <p>${T('pr2.delete_what', 'What happens:')}</p><ul class="sm">
          <li>${T('pr2.d1', 'The name becomes "Removed Patient". Phone, email, address, home location, next of kin and USSD PIN are erased.')}</li>
          <li>${T('pr2.d2', 'Their MediCore account is disabled and signed out everywhere. If they are also staff or on the MediCore team, only the patient profile is detached.')}</li>
          <li>${T('pr2.d3', 'Every provider loses the link to this patient.')}</li>
          <li>${T('pr2.d4', 'Clinical, billing and audit records are kept under the same patient id for legal and medical record retention.')}</li>
          <li>${T('pr2.d5', 'The request is closed as completed.')}</li></ul>
        ${field('pr2-rr', T('pr2.retention', 'Retention reason'), html`<input class="input" id="pr2-rr" name="retentionReason" required minlength="5" maxlength="300" value="${T('pr2.retention_default', 'Medical records retained as required by law')}">`, T('pr2.retention_hint', 'Why clinical and billing records are kept. Recorded with the patient.'))}
        <label class="check"><input type="checkbox" name="understand" required><span>${T('pr2.understand', 'I have verified this request and understand it cannot be undone')}</span></label>`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('pr2.delete_ok', 'Anonymise permanently'), primary: true }],
        onSubmit: d => { if (!d.understand) throw new MC.ApiError(400, { error: T('pr2.tick', 'Tick the box to confirm.') }); return api.post('/api/hq/privacy/requests/' + r.id + '/execute-deletion', { retentionReason: d.retentionReason }); } });
      if (v) after(T('pr2.deleted', 'Patient anonymised. {n} provider links removed.', { n: v.result.linksRemoved }));
    });
  }
  function ndpcLine(b) {
    if (b.ndpcNotifiedAt) return html`${badge(T('breach.notified', 'NDPC notified {d}', { d: dateTime(b.ndpcNotifiedAt) }), b.ndpcLate ? 'warn' : 'ok')}${b.ndpcLate ? html` ${badge(T('breach.late', 'Notified after the 72-hour deadline'), 'bad')}` : ''}`;
    const h = (b.ndpcDeadline - Date.now()) / 3600e3;
    if (h < 0) return badge(T('breach.overdue', 'NDPC deadline passed {n} h ago, notify now', { n: Math.round(-h) }), 'bad');
    const hh = Math.floor(h); const mm = Math.floor((h - hh) * 60);
    return badge(T('breach.left', '{h} h {m} min left to notify NDPC (by {d})', { h: hh, m: mm, d: dateTime(b.ndpcDeadline) }), h < 24 ? 'bad' : 'warn');
  }
  async function breaches({ stale }) {
    const rows = await api.get('/api/hq/privacy/breaches');
    if (stale()) return;
    view(html`${privHead()}${privTabs('#/privacy/breaches')}
      <div class="row between wrap" style="margin-bottom:16px"><p class="muted sm" style="margin:0">${T('breach.sub', 'Record every personal data breach. The NDPC must be told within 72 hours of discovery; tell affected patients without delay when the risk is high.')}</p><button class="btn primary" data-action="br-new">${icon('plus')}${T('breach.new', 'Record a breach')}</button></div>
      ${rows.length ? html`<div class="list">${rows.map(b => html`<li><div class="grow"><span class="title">${b.title} ${sBadge(b.status)}</span><span class="sub">${T('breach.discovered', 'Discovered {d}', { d: dateTime(b.discoveredAt) })}${b.affectedCount != null ? ' | ' + T('breach.affected', '{n} people affected', { n: b.affectedCount }) : ''}${b.subjectsNotifiedAt ? ' | ' + T('breach.subjects', 'Patients told {d}', { d: date(b.subjectsNotifiedAt) }) : ''}</span><span class="sub" style="margin-top:4px">${ndpcLine(b)}</span></div>
        <span class="end">${b.status === 'closed' ? html`<button class="btn sm" data-action="br-reopen" data-id="${b.id}">${T('breach.reopen', 'Reopen')}</button>` : html`<div class="row wrap" style="justify-content:flex-end">${!b.ndpcNotifiedAt ? html`<button class="btn sm primary" data-action="br-ndpc" data-id="${b.id}">${T('breach.mark_ndpc', 'NDPC notified now')}</button>` : ''}<button class="btn sm" data-action="br-edit" data-id="${b.id}">${T('breach.update', 'Update')}</button></div>`}</span></li>`)}</div>`
      : empty({ icon: 'shield', title: T('breach.empty', 'No breaches recorded'), body: T('breach.empty_sub', 'If personal data is lost, stolen or seen by someone who should not see it, record it here straight away. The 72-hour clock starts at discovery.') })}`);
    const formBody = b => html`${field('br-t', T('breach.title_f', 'What happened, in a few words'), html`<input class="input" id="br-t" name="title" required maxlength="160" value="${b ? b.title : ''}">`)}
      <div class="fields two">${field('br-d', T('breach.disc_f', 'Discovered at (Lagos time)'), html`<input class="input" id="br-d" name="discoveredAt" type="datetime-local" required value="${toLocalInput(b ? b.discoveredAt : Date.now())}">`, T('breach.disc_hint', 'The NDPC deadline is 72 hours after this.'))}
      ${field('br-a', T('breach.affected_f', 'People affected (estimate)'), html`<input class="input" id="br-a" name="affectedCount" type="number" min="0" value="${b && b.affectedCount != null ? b.affectedCount : ''}">`)}</div>
      ${field('br-ds', T('breach.desc_f', 'Description'), html`<textarea class="input" id="br-ds" name="description" required maxlength="4000" rows="4">${b ? b.description : ''}</textarea>`, T('breach.desc_hint', 'What data, which systems, how it was found. No patient names.'))}
      ${field('br-ac', T('breach.actions_f', 'Actions taken'), html`<textarea class="input" id="br-ac" name="actions" maxlength="4000" rows="3">${b && b.actions ? b.actions : ''}</textarea>`)}
      ${b ? html`<div class="fields two">${field('br-n', T('breach.ndpc_f', 'NDPC notified at'), html`<input class="input" id="br-n" name="ndpcNotifiedAt" type="datetime-local" value="${toLocalInput(b.ndpcNotifiedAt)}">`)}${field('br-sn', T('breach.subj_f', 'Patients notified at'), html`<input class="input" id="br-sn" name="subjectsNotifiedAt" type="datetime-local" value="${toLocalInput(b.subjectsNotifiedAt)}">`)}</div>
        ${field('br-st', T('breach.status_f', 'Status'), html`<select class="input" id="br-st" name="status">${['open', 'contained', 'closed'].map(s => opt(s, st(s), b.status === s))}</select>`)}` : ''}`;
    const toBody = d => { const o = { title: d.title, description: d.description, discoveredAt: fromLocalInput(d.discoveredAt) }; if (d.affectedCount != null) o.affectedCount = d.affectedCount; if (d.actions) o.actions = d.actions; ['ndpcNotifiedAt', 'subjectsNotifiedAt'].forEach(k => { if (d[k]) o[k] = fromLocalInput(d[k]); }); if (d.status) o.status = d.status; return o; };
    on('br-new', async () => { const v = await dialog({ title: T('breach.new', 'Record a breach'), wide: true, form: true, body: formBody(null), actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('breach.save_new', 'Record breach'), primary: true }], onSubmit: d => api.post('/api/hq/privacy/breaches', toBody(d)) }); if (v) { toast(T('breach.recorded', 'Breach recorded. NDPC deadline {d}.', { d: dateTime(v.ndpcDeadline) }), 'ok'); MC.render(); } });
    on('br-edit', async el => { const b = rows.find(x => x.id === el.dataset.id); if (!b) return; const v = await dialog({ title: b.title, wide: true, form: true, body: formBody(b), actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('breach.save', 'Save breach'), primary: true }], onSubmit: async d => { const body = toBody(d); if (body.status === 'closed' && b.status !== 'closed' && !(await confirm({ title: T('breach.close_q', 'Close this breach?'), body: T('breach.close_body', 'A closed breach cannot be edited until it is reopened.'), ok: T('breach.close', 'Close breach') }))) return false; return api.patch('/api/hq/privacy/breaches/' + b.id, body); } }); if (v) { toast(T('breach.saved', 'Breach updated'), 'ok'); MC.render(); } });
    on('br-ndpc', async el => { const b = rows.find(x => x.id === el.dataset.id); if (!b) return; if (!(await confirm({ title: T('breach.ndpc_q', 'Record that the NDPC was notified now?'), body: T('breach.ndpc_body', 'Use this once the notification has actually been sent to the Nigeria Data Protection Commission. The time is recorded as now.'), ok: T('breach.mark_ndpc', 'NDPC notified now') }))) return; await api.patch('/api/hq/privacy/breaches/' + b.id, { ndpcNotifiedAt: Date.now() }); toast(T('breach.ndpc_done', 'NDPC notification recorded'), 'ok'); MC.render(); });
    on('br-reopen', async el => { if (!(await confirm({ title: T('breach.reopen_q', 'Reopen this breach?'), body: T('breach.reopen_body', 'It becomes open again and can be updated.'), ok: T('breach.reopen', 'Reopen') }))) return; await api.patch('/api/hq/privacy/breaches/' + el.dataset.id, { status: 'open' }); toast(T('breach.reopened', 'Breach reopened'), 'ok'); MC.render(); });
  }
  async function consent({ query, stale }) {
    const [s, c] = await Promise.all([api.get('/api/hq/privacy/settings'), query.patient ? api.get('/api/hq/privacy/consents/' + encodeURIComponent(query.patient)).catch(e => ({ error: e })) : Promise.resolve(null)]);
    if (stale()) return;
    const undeclared = !s.dataLocation || /not yet/i.test(s.dataLocation);
    view(html`${privHead()}${privTabs('#/privacy/consent')}
      <div class="grid two">
        <section class="panel"><h2>${T('cs.lookup', 'Consent lookup')}</h2>
          <form data-form="cs-find" novalidate>${field('cs-p', T('cs.patient_id', 'Patient id'), html`<input class="input" id="cs-p" name="patient" required value="${query.patient || ''}" placeholder="pat_..." autocomplete="off">`, T('cs.patient_hint', 'Find it on the privacy request or in the audit log. Every lookup is audited.'))}<button class="btn primary" type="submit">${icon('search')}${T('cs.find', 'Show consent records')}</button></form>
          ${c && c.error ? html`<div class="notice bad" style="margin-top:16px">${c.error.status === 404 ? T('cs.not_found', 'No patient with that id.') : c.error.message}</div>` : ''}
          ${c && !c.error ? html`<dl class="kv" style="margin-top:16px"><dt>${T('cs.status', 'Patient status')}</dt><dd>${sBadge(c.status || 'active')}</dd><dt>${T('cs.current', 'Current consent')}</dt><dd>${c.current ? html`${T('cs.version', 'Version {v}', { v: c.current.version || '-' })} | ${c.current.accepted === false ? badge(T('cs.withdrawn', 'Withdrawn'), 'bad') : badge(T('cs.accepted', 'Accepted'), 'ok')}${c.current.at ? html`<br><span class="xs muted">${dateTime(c.current.at)}</span>` : ''}` : badge(T('cs.none', 'No consent recorded'), 'warn')}</dd></dl>
            ${c.records.length ? html`<div class="table-wrap" style="margin-top:12px"><table class="t stack-sm"><thead><tr><th>${T('cs.when', 'When')}</th><th>${T('cs.version_c', 'Notice version')}</th><th>${T('cs.choice', 'Choice')}</th><th>${T('cs.channel', 'Channel')}</th></tr></thead><tbody>${c.records.map(x => html`<tr><td data-label="${T('cs.when', 'When')}">${dateTime(x.at)}</td><td data-label="${T('cs.version_c', 'Notice version')}">${x.version || '-'}</td><td data-label="${T('cs.choice', 'Choice')}">${x.accepted === false ? T('cs.withdrawn', 'Withdrawn') : T('cs.accepted', 'Accepted')}</td><td data-label="${T('cs.channel', 'Channel')}">${x.channel ? cap(x.channel) : '-'}</td></tr>`)}</tbody></table></div>` : html`<p class="muted sm" style="margin-top:12px">${T('cs.no_records', 'No consent history for this patient.')}</p>`}` : ''}</section>
        <section class="panel"><h2>${T('cs.dl', 'Data location and DPO')}</h2>
          ${undeclared || !s.dpoEmail ? html`<div class="notice warn">${T('cs.missing', 'Declare where patient data is stored and who the Data Protection Officer is before going live. Set DATA_LOCATION and DPO_EMAIL in the server environment.')}</div>` : ''}
          <dl class="kv"><dt>${T('cs.location', 'Data stored in')}</dt><dd>${s.dataLocation || '-'}</dd><dt>${T('cs.dpo', 'Data Protection Officer')}</dt><dd>${s.dpoEmail ? html`<a href="mailto:${s.dpoEmail}">${s.dpoEmail}</a>` : badge(T('cs.not_set', 'Not set'), 'warn')}</dd>
            <dt>${T('cs.notice', 'Privacy notice version')}</dt><dd>${s.privacyNoticeVersion || '-'}</dd><dt>${T('cs.ndpc', 'Breach notice to NDPC')}</dt><dd>${T('cs.hours', 'Within {n} hours', { n: s.ndpcBreachHours })}</dd><dt>${T('cs.resp', 'Patient requests answered')}</dt><dd>${T('cs.days', 'Within {n} days', { n: s.requestResponseDays })}</dd></dl>
          <p class="muted xs" style="margin-top:12px">${T('cs.configured', 'Set from the server environment: {v}', { v: s.configuredBy })}</p></section>
      </div>`);
    form('cs-find', d => MC.go('#/privacy/consent' + qs({ patient: (d.patient || '').trim() })));
  }

  /* ======================= audit search ======================= */
  const dayStart = d => (d ? Date.parse(d + 'T00:00:00' + LAGOS) : undefined);
  const dayEnd = d => (d ? Date.parse(d + 'T23:59:59.999' + LAGOS) : undefined);
  async function auditSearch({ query, stale }) {
    const [orgs, rows] = await Promise.all([api.get('/api/hq/providers?limit=500').catch(() => ({ rows: [] })), api.get('/api/hq/audit' + qs({ orgId: query.orgId, actorId: query.actorId, patientId: query.patientId, targetId: query.targetId, action: query.action, after: dayStart(query.from), before: query.before || dayEnd(query.to), limit: 100 }))]);
    if (stale()) return;
    const names = Object.fromEntries(orgs.rows.map(o => [o.id, o.name]));
    const filtered = ['orgId', 'actorId', 'patientId', 'targetId', 'action', 'from', 'to'].some(k => query[k]);
    view(html`${head(T('au.title', 'Audit log'), T('au.sub', 'Every change and every view of a patient record across MediCore, newest first.'))}
      <form data-form="au-filter" class="panel" novalidate><div class="fields three">
        ${field('au-o', T('au.provider', 'Provider'), html`<select class="input" id="au-o" name="orgId">${opt('', T('au.any_provider', 'Any provider'), !query.orgId)}${orgs.rows.map(o => opt(o.id, o.name, query.orgId === o.id))}</select>`)}
        ${field('au-a', T('au.action_filter', 'Action starts with'), html`<input class="input" id="au-a" name="action" value="${query.action || ''}" placeholder="hq.org." maxlength="60">`)}
      </div><details ${query.actorId || query.patientId || query.targetId || query.from || query.to ? 'open' : ''} style="margin-bottom:12px"><summary class="btn ghost sm">${T('au.more_filters', 'More filters: person, patient, record, dates')}</summary><div class="fields three" style="margin-top:12px">
        ${field('au-u', T('au.actor', 'Person (user id)'), html`<input class="input" id="au-u" name="actorId" value="${query.actorId || ''}" placeholder="usr_..." autocomplete="off">`)}
        ${field('au-p', T('au.patient_id', 'Patient id'), html`<input class="input" id="au-p" name="patientId" value="${query.patientId || ''}" placeholder="pat_..." autocomplete="off">`)}
        ${field('au-t', T('au.target', 'Record id'), html`<input class="input" id="au-t" name="targetId" value="${query.targetId || ''}" autocomplete="off">`)}
        <div class="fields two">${field('au-f', T('au.from_d', 'From'), html`<input class="input" id="au-f" name="from" type="date" value="${query.from || ''}">`)}${field('au-to', T('au.to_d', 'To'), html`<input class="input" id="au-to" name="to" type="date" value="${query.to || ''}">`)}</div>
      </div></details><div class="form-err notice bad" hidden></div><div class="row wrap"><button class="btn primary" type="submit">${icon('search')}${T('au.search', 'Search the audit log')}</button>${filtered ? html`<a class="btn ghost" href="#/audit">${T('pv.clear', 'Clear filters')}</a>` : ''}</div></form>
      ${rows.length ? html`${auditTable(rows, names)}${rows.length === 100 ? html`<div class="btn-row"><a class="btn" href="#/audit${qs(Object.assign({}, query, { before: rows[rows.length - 1].at, to: undefined }))}">${T('au.older', 'Older entries')}</a></div>` : ''}` : empty({ icon: 'shield', title: T('au.none', 'No entries match'), body: T('au.none_sub', 'Widen the dates or remove a filter.') })}`);
    form('au-filter', d => {
      if (d.from && d.to && d.from > d.to) throw new MC.ApiError(400, { error: T('au.bad_dates', 'The start date must be before the end date.') });
      MC.go('#/audit' + qs({ orgId: d.orgId, action: d.action, actorId: d.actorId, patientId: d.patientId, targetId: d.targetId, from: d.from, to: d.to }));
    });
  }

  /* ======================= demo ======================= */
  const pageFor = app => (app === 'patient' ? '/index.html' : '/' + app + '.html');
  async function demo({ stale }) {
    if (demoMode === false) return view(html`${head(T('dm.title', 'Demo'), '')}${empty({ icon: 'lock', title: T('dm.off', 'Demo mode is off'), body: T('dm.off_sub', 'Demo accounts and demo data only exist on a server started with DEMO_MODE=1. They can never be loaded on a live system.') })}`);
    const d = await api.get('/api/hq/demo/accounts');
    if (stale()) return;
    view(html`${head(T('dm.title', 'Demo'), T('dm.sub', 'Demo accounts for every app. All use the same password.'), html`<button class="btn danger" data-action="dm-reset">${icon('refresh')}${T('dm.reset', 'Reset demo data')}</button>`)}
      <div class="notice">${T('dm.password', 'Password for every demo account:')} <b>${d.password}</b></div>
      <div class="table-wrap"><table class="t stack-sm"><thead><tr><th>${T('dm.account', 'Account')}</th><th>${T('dm.app', 'App')}</th><th>${T('dm.email', 'Email')}</th><th></th></tr></thead><tbody>
        ${d.rows.map(([label, app, email]) => html`<tr><td data-label="${T('dm.account', 'Account')}"><b>${label}</b></td><td data-label="${T('dm.app', 'App')}">${cap(app)}</td><td data-label="${T('dm.email', 'Email')}">${email}</td><td class="num"><a class="btn sm" href="${pageFor(app)}" target="_blank" rel="noopener">${T('dm.open', 'Open app')}${icon('right')}</a></td></tr>`)}
      </tbody></table></div>`);
    on('dm-reset', async () => {
      const v = await dialog({ title: T('dm.reset_q', 'Reset all demo data?'), form: true, body: html`<div class="notice bad"><b>${T('dm.reset_warn', 'Everything in this demo database is wiped and the original demo data is loaded again.')}</b> ${T('dm.reset_warn2', 'Every change made by anyone is lost and everyone is signed out of every app, including you.')}</div>${field('dm-c', T('dm.type', 'Type RESET to confirm'), html`<input class="input" id="dm-c" name="confirm" required autocomplete="off" autocapitalize="characters">`)}`,
        actions: [{ label: MC.t('kit.cancel', 'Cancel'), value: null }, { label: T('dm.reset_ok', 'Wipe and reload demo data'), primary: true }],
        onSubmit: f => { if (f.confirm !== 'RESET') throw new MC.ApiError(400, { error: T('dm.type_err', 'Type RESET in capital letters to confirm.') }); return api.post('/api/hq/demo/reset', { confirm: 'RESET' }); } });
      if (!v) return;
      await dialog({ title: T('dm.done', 'Demo data reloaded'), body: html`<p>${T('dm.done_body', 'Everyone has been signed out. Sign in again to continue.')}</p>`, actions: [{ label: T('dm.signin', 'Sign in again'), primary: true, value: true }] });
      location.hash = '#/';
      api.get('/api/auth/me').catch(() => { });
    });
  }

  /* ======================= more (phones) ======================= */
  let NAV = [];
  function more() {
    const items = NAV.filter(n => n.href !== '#/more' && (!n.perm || can(n.perm)) && (!n.show || n.show(MC.me)));
    view(html`${head(T('more.title', 'All sections'), '')}<div class="list">${items.map(n => html`<a href="${n.href}"><span style="display:inline-flex;width:22px;height:22px;flex:none;color:var(--ink-3)">${icon(n.icon)}</span><div class="grow"><span class="title">${n.label}</span></div><span style="display:inline-flex;width:20px;height:20px;flex:none">${icon('right')}</span></a>`)}</div>`);
  }

  NAV = [
    { href: '#/', label: T('nav.overview', 'Overview'), icon: 'home', perm: 'platform.read' },
    { href: '#/providers', label: T('nav.providers', 'Providers'), icon: 'building', perm: 'platform.read' },
    { href: '#/groups', label: T('nav.groups', 'Hospital groups'), icon: 'users', perm: 'platform.read', sideOnly: true },
    { href: '#/plans', label: T('nav.plans', 'Plan presets'), icon: 'box', perm: 'platform.read', sideOnly: true },
    { href: '#/team', label: T('nav.team', 'Team'), icon: 'users', perm: 'platform.users', sideOnly: true },
    { href: '#/privacy', label: T('nav.privacy', 'Privacy and compliance'), short: T('nav.privacy_s', 'Privacy'), icon: 'shield', perm: 'platform.privacy', sideOnly: true },
    { href: '#/audit', label: T('nav.audit', 'Audit log'), icon: 'file', perm: 'platform.audit', sideOnly: true },
    { href: '#/demo', label: T('nav.demo', 'Demo'), icon: 'refresh', perm: 'platform.demo', sideOnly: true, show: () => demoMode !== false },
  ].concat((H.nav || []).map(n => (n.href === '#/config' ? Object.assign({}, n, { sideOnly: true, group: T('nav.g_settings', 'Settings') }) : n.href !== '#/support' ? Object.assign({}, n, { sideOnly: true }) : n)), [
    { href: '#/more', label: T('nav.more', 'More'), icon: 'menu', show: () => !wide() },
  ]);

  MC.boot({
    title: 'MediCore HQ', subtitle: T('login.sub', 'Platform control for the MediCore team'), home: '#/',
    nav: NAV,
    routes: Object.assign({
      '#/': guard('platform.read', overview),
      '#/providers': guard('platform.read', providers),
      '#/providers/:id': guard('platform.read', providerDetail),
      '#/providers/:id/overrides': guard('platform.read', providerOverrides),
      '#/providers/:id/audit': guard('platform.audit', providerAudit),
      '#/groups': guard('platform.read', groupsList),
      '#/groups/:id': guard('platform.read', groupDetail),
      '#/plans': guard('platform.read', plans),
      '#/team': guard('platform.users', team),
      '#/privacy': guard('platform.privacy', privacy),
      '#/privacy/requests/:id': guard('platform.privacy', privacyRequest),
      '#/privacy/breaches': guard('platform.privacy', breaches),
      '#/privacy/consent': guard('platform.privacy', consent),
      '#/audit': guard('platform.audit', auditSearch),
      '#/demo': guard('platform.demo', demo),
      '#/more': more,
    }, H.routes || {}),
    onReady: async () => {
      demoMode = null;
      if (can('platform.demo') && can('platform.read')) {
        try { const c = await api.get('/api/hq/config'); demoMode = !!(c.environment && c.environment.demoMode); } catch (e) { demoMode = false; }
      } else demoMode = false;
      if (!demoMode) document.querySelectorAll('[data-nav][href="#/demo"]').forEach(a => a.remove());
    },
  });
})();
