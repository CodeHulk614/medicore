# MediCore v2: building an app

Every app is `public/<page>.html` (already generated, do not edit) + `public/apps/<app>.js` (you write this). The shared kit is `public/assets/mc.js` and `public/assets/mc.css`. Read both fully before writing. `public/apps/admin.js` is a working reference app; copy its patterns.

## Hard rules

1. **Markup only through `html```.** Every `${value}` is escaped. Never build HTML with string concatenation from data, never set `innerHTML` yourself (use `MC.view()`), never use `MC.raw()` on data that came from the API. This is what kills the stored-XSS attacks the old version had.
2. **No inline JS.** The pages run under a strict CSP (`script-src 'self'`). No `onclick=`, no `<script>` in templates, no `eval`/`new Function`. Use `data-action="name"` + `MC.on('name', fn)` and `<form data-form="name">` + `MC.form('name', fn)`. Pass ids with `data-id="..."` and read `el.dataset.id`.
3. **Every user-facing string goes through `MC.t('key', 'English text', vars)`**, including button labels, headings, empty states, toasts, confirm dialogs and status labels. Keys: `<app>.<screen>.<thing>`, e.g. `MC.t('pharmacy.queue.empty', 'No prescriptions waiting')`. Use `{name}` placeholders: `MC.t('patient.home.hello', 'Good morning, {name}', { name })`. Do not split sentences into pieces. Statuses: `MC.t('status.' + s, MC.cap(s))`. Clinical data coming from the API (drug names, diagnoses, results) is not translated.
4. **HQ-editable content and switches.** Text the MediCore team may want to change (welcome lines, help text, legal notices) comes from `MC.content('key', 'fallback')`. Screens tied to a platform feature check `MC.feature('videoVisits')`, `MC.feature('homeDelivery')`, `MC.feature('ussd')`, `MC.feature('aiPatientAssistant')` etc. (see `src/lib/settings.js` DEFAULTS.features) and hide cleanly when off.
5. **Sessions are cookies.** Never store tokens. `MC.api.get/post/patch` sends the app header and cookie. 401 shows the login screen automatically; 423 `clock_in_required` prompts clock-in automatically.
6. **Errors.** Let thrown `ApiError`s reach the kit (forms and actions show them). For important states (not found, forbidden) render a clear empty state that says what to do next.
7. **No `alert`, `confirm`, `prompt`.** Use `MC.dialog`, `MC.confirm`, `MC.toast`. Destructive or money actions always confirm, and the confirm text says exactly what happens.
8. **Polling** only with `MC.poll(fn, ms)` (pauses in background tabs, backs off on errors, stops when the route changes). 5 s for live tracking, 15 to 30 s for queues and boards.
9. **GPS** with `MC.position()` and `MC.watchPosition(fn, 10000)`. Maps with `await MC.map(el, { center })`, then `setMarker`, `line`, `fit`. Maps must degrade to text when tiles do not load.
10. **Money** is kobo from the API. Show with `MC.money(kobo)`. Inputs in naira use `data-kobo` on the input so `MC.formData` converts.

## Design rules (keep every app feeling like one product)

- Mobile first (390 px wide phones, often low-end Android), desktop gets the sidebar automatically at 960 px+. Check both.
- Page = `.page-head` (h1 + one line + actions) then content. Use `.list` rows with dividers for lists of people or orders; `table.t.stack-sm` inside `.table-wrap` for dense data (it stacks on phones; give each `td` a `data-label`). Use `.panel` to group, not to wrap every row.
- Any screen about one patient starts with `MC.wristband(patient)`. It shows allergies in red. Never hide it.
- Prescribing and dispensing show safety alerts with `MC.alerts(alerts)`.
- Progress of an order or case: `MC.steps(allStatuses, current, labels)`. History: `.timeline`.
- Summary numbers: `MC.figures([{ value, label, tone }])`, one row, not hero numbers.
- Status: `MC.statusBadge(status)` (always words, never colour alone). Priorities: `.badge.pri-P1/P2/P3`.
- Empty states: `MC.empty({ icon, title, body, action })`: say what will appear and offer the next action.
- Buttons say what they do ("Mark sample collected", not "Submit"). The toast repeats the verb ("Sample marked collected").
- Tap targets 44 px minimum (the kit's buttons are). Labels on every input (`<label for>`). Icon-only buttons get `aria-label`.
- No decorative gradients, no emoji, no all-caps labels. Plain sentence case.

## Boot

```js
MC.boot({
  title: 'MediCore Pharmacy',                     // overridden by HQ branding when set
  home: '#/queue',
  nav: [ { href: '#/queue', label: MC.t('pharmacy.nav.queue', 'Prescriptions'), icon: 'pill', perm: 'pharmacy.dispense' }, ... ],  // perm / anyPerm / module / show(me)
  routes: { '#/queue': queuePage, '#/order/:id': orderPage },
  publicRoutes: [],                               // routes that work signed out (patient app: none except sign-up links)
  loginFooter: () => MC.html`...`,                 // optional, e.g. "New here? Create an account"
  onReady: async me => {},                        // after sign-in, before the first route
});
```

Note: `nav` labels are evaluated once at boot, after the language loads, so `MC.t` works there. Route handlers get `{ params, query, me, stale }`; call `stale()` after awaits in long handlers to skip rendering if the user moved on.

## Testing your app

- Demo server: `cd /home/claude/medicore && DEMO_MODE=1 PORT=<your port> node server.js` (memory DB, demo data, password `Demo2026!`; accounts in `src/seed/demo.js`, e.g. `owner@grandville.demo`, `pharmacist@yabacare.demo`, `amaka@patient.demo`).
- Playwright is installed at `/tmp/claude-0/-home-claude/610f4f3b-3e72-558e-a378-72296efbefa6/scratchpad/pw` (use `chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })`, and `NO_PROXY='*'`). Put your scripts in your own folder under that scratchpad.
- For each screen: no console errors, no failed requests other than expected 401 before sign-in, works at 390x844 and 1366x800, no horizontal scroll at 390. Run the main workflow end to end against the real API. Try an XSS payload (`<img src=x onerror=alert(1)>`) in every free-text field and confirm it renders as text.
- Look at your screenshots (Read the PNG) and fix what looks wrong before you finish.

## API docs

`docs/api/*.md` (or `.txt`) per module, plus core endpoints in the source: `src/modules/{auth,orgs,patients,shifts,billing,staff,controlplane,support,geo}.js` (each route is defined at the top level of those files; read them).
