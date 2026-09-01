# MediCore backend

A real API server with accounts, a shared database, and adapters for payments,
SMS, and video. The patient app and the hospital app talk to this same server, so
they share one record. It runs with plain Node, no external database service.

## Run it locally (one command)

    npm install
    npm start

Then open http://localhost:4000 in a browser. That serves the patient app AND the
API from the same place. Sign in with the demo account:

    email:    amaka@demo.ng
    password: demo1234

Data is saved to `data/db.json` and survives restarts. Delete that file and run
`npm run seed` to start fresh.

## Point the phone app at it

While testing on the same Wi-Fi, set `API_URL` in the Expo app's `App.js` to your
PC's LAN address, for example `http://192.168.0.20:4000`. For a real release, deploy
(below) and use the public URL.

## Deploy so the phone works anywhere (Render)

1. Put this folder in a GitHub repo.
2. On render.com create a new Web Service from that repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Add a persistent disk (1GB) mounted at `/data`, and set `DB_FILE=/data/db.json`
     so your data is not wiped on redeploy.
3. Set environment variables (see below). At minimum set `JWT_SECRET` to a long
   random string.
4. Deploy. Copy the service URL (like `https://medicore.onrender.com`) into the Expo
   app's `API_URL`, rebuild the app, and it works from any network.

## Environment variables

Everything runs in a safe DEV mode until you add these. Add each one only when you
have the account, and that feature goes live with no code change.

    JWT_SECRET        required in production. Any long random string.
    DB_FILE           path to the database file (use the mounted disk on Render).
    PAYSTACK_SECRET   Paystack secret key. Without it, payments are recorded but no
                      card is charged. With it, real Paystack checkout is created.
    TERMII_KEY        Termii SMS key (+ TERMII_SENDER). Without it, SMS is logged only.
    DAILY_KEY         Daily.co key for real video rooms. Without it, a placeholder
                      room is returned.
    HMO_ENDPOINTS     comma list of HMOs you have a live agreement with. See note.

## The honest bits

- **Payments**: you need a Paystack (or Flutterwave) merchant account. I cannot
  create it for you; it needs your business details and settlement bank account.
- **SMS / Video**: same, a Termii and a Daily.co account with your own keys.
- **HMO claims**: there is no open claims API in Nigeria. Each HMO (Avon, Reliance,
  Hygeia, NHIA) is a separate integration that needs a business agreement, and often
  a portal or file exchange rather than an API. The server already records claims and
  marks them ready to submit; wiring a specific HMO happens in `integrations.js`
  once that agreement exists.
- **Security & compliance**: this is a pilot-grade server. Before real patient data,
  it needs the tier-3 hardening in TIER3.md (NDPR, encryption at rest, rate limits,
  audit, backups).

## What the API gives you

Auth: `POST /api/auth/register`, `POST /api/auth/login`.
Patient: `GET /api/me/bundle`, `POST /api/appointments`,
`POST /api/prescriptions/:id/refill`, `POST /api/deliveries/:id/advance`,
`POST /api/messages`, `POST /api/bills/:id/pay`, `POST /api/video/room`.
Hospital (staff token): `GET /api/hospital/appointments`,
`GET /api/hospital/patients`, `POST /api/hospital/messages/reply`.


## New in this build (marketplace, doctor app, USSD, analytics, wearables)

The backend now also powers a cross-facility doctor marketplace, a provider (doctor) app, a USSD service for feature phones, an aggregate analytics endpoint, and a wearables ingest endpoint. Everything below is real and verified against this server.

Patient endpoints
- `GET  /api/doctors?q=&specialty=&language=`  search the marketplace
- `GET  /api/doctors/:id`                       one doctor
- `POST /api/marketplace/book`                  book any listed doctor (cross-facility), body `{doctorId,type,day,time}`
- `POST /api/wearables`  /  `GET /api/wearables` device metrics in and out
- `GET  /api/analytics`                         de-identified aggregate counts

Doctor app endpoints (doctor token)
- `GET  /api/doc/me`  profile + stats (today, completed, earnings)
- `GET  /api/doc/schedule`  the doctor's appointments
- `GET  /api/doc/patients`  patients seen or messaging this doctor
- `GET  /api/doc/thread/:patientId`  message thread
- `POST /api/doc/reply`  reply to a patient (patient sees it, attributed)
- `POST /api/doc/appointments/:id/complete`  mark done, writes a visit to the record
- `POST /api/doc/availability`  toggle accepting bookings

USSD (telco aggregator posts to this on each keypress)
- `POST /api/ussd`  body `{sessionId, phoneNumber, text}`, replies `CON ...` / `END ...`
  Going live needs a shortcode from an aggregator (Africa's Talking, Termii, Interswitch). The service itself is complete and testable now.

Apps served statically
- `/index.html`   patient app (marketplace + multi-language built in)
- `/doctor.html`  doctor app

Demo logins (all password `demo1234`)
- Patient: `amaka@demo.ng`
- Doctors: `ada@demo.ng`, `tunde@demo.ng`, `ifeoma@demo.ng`, `musa@demo.ng`, `chidinma@demo.ng`, `bisi@demo.ng`

Multi-language: the patient app ships an English + Yoruba/Hausa/Igbo/Pidgin switcher for the app chrome (tabs, greeting, quick actions, settings). Clinical and legal wording stays in English until a native speaker reviews it, by design.


## Operator, payer and facility apps (this build)

Four more role apps now run on the same backend and the same shared record. Each is a single HTML file, served statically and also delivered standalone.

- `/admin.html`     Operations console: verify doctors and facilities (approval makes them live in the marketplace), payouts to doctors from completed visits, network overview, audit trail.
- `/payer.html`     HMO / Payer portal: pre-authorization inbox, claims adjudication (approve and pay, or deny), members and benefit utilization, high-amount fraud flags.
- `/pharmacy.html`  Pharmacy console: dispense queue from prescriptions, dispensing that decrements stock and opens a delivery and raises a claim, inventory with low and out-of-stock states.
- `/lab.html`       Diagnostics console: incoming order worklist, sample-collected step, result entry that posts straight into the patient's Records and raises a claim.

Staff demo logins (all password `demo1234`)
- Operations: `admin@demo.ng`
- Payer (Avon HMO): `payer@demo.ng`
- Pharmacy (HealthPlus): `pharmacy@demo.ng`
- Lab (CarePoint): `lab@demo.ng`

New endpoints: `/api/admin/*`, `/api/payer/*`, `/api/pharm/*`, `/api/lab/*`, plus `/api/doc/lab-order`, `/api/doc/prescribe`, and `POST /api/authorizations` (patient raises a pre-auth). Only verified doctors appear in `GET /api/doctors`.

Verified cross-app loops (see `wave_test.js`): admin verifies a doctor -> doctor appears in the patient marketplace; a doctor orders a lab test -> the lab app receives it -> posts a result -> the patient sees it in Records and a claim is raised -> the payer adjudicates it; a doctor prescribes -> the pharmacy queue shows it -> dispensing drops stock, opens a delivery the patient can track, and raises a claim; a completed visit accrues a payout the admin can settle.

## Staged next (honest)

Not built yet, and each needs something beyond pure app code: a Delivery / Rider app (analogous to a driver app, drives the patient delivery tracker), a Community Health Worker app (needs a real offline-first sync layer, service worker plus IndexedDB), and an Ambulance / Emergency dispatch app (needs live location and a dispatch desk to be meaningful). The nine-role hospital console is still the in-memory demo and remains the largest single wiring job.


## Field, emergency and logistics apps (this build)

Three more role apps complete the last-mile layer, on the same backend and shared record.

- `/rider.html`     Delivery / Rider app: job list of dispensed medication runs, accept, and pickup to delivered states that drive the patient's live delivery tracker.
- `/dispatch.html`  Emergency dispatch: log an incoming call with triage type and area, dispatch the nearest available responder (which pre-alerts a covered hospital), and move a case through en route, on scene, at hospital, closed. A public `POST /api/emergency` lets anyone report without logging in, matching real first-response design.
- `/chw.html`       Community Health Worker app: offline-first client registration and home-visit logging that queue locally and sync to the record when back online, a visits-due list, and a danger-sign referral that raises an urgent authorization.

Staff demo logins (all password `demo1234`)
- Rider: `rider@demo.ng`   Dispatch: `dispatch@demo.ng`   CHW: `chw@demo.ng`

New endpoints: `/api/rider/*`, `/api/emergency` (public), `/api/dispatch/*`, `/api/chw/*`.

Verified loops (see `field_test.js`): a dispensed prescription becomes a rider job, and advancing it to delivered updates the patient's tracker; a public emergency report reaches the dispatcher, who assigns the nearest responder and pre-alerts a hospital, with the responder freed on close; a CHW registers a client and logs a visit with a danger sign that raises a referral. The CHW offline pattern is browser-verified: registering while offline queues locally and leaves the server unchanged, then a sync flushes the queue and the client appears on the roster.

## App surface is now essentially complete

Beyond an optional Employer / Corporate benefits portal and a Public-health / Regulator surveillance console, both B2B/government rather than consumer, the remaining work is not more apps. It is: deploying the backend, connecting live payment/SMS/video/HMO keys, security and NDPR compliance with a real database and backups, wiring the nine-role hospital console to this backend, and, for production-grade field and emergency use, a service worker for offline app-shell caching plus real GPS/fleet integration. Those are the honest next steps.


## Installable apps (PWA)

All nine apps are now installable Progressive Web Apps: each has its own name, icon, and manifest, plus a shared service worker (`/sw.js`) that caches the app shell for offline use while always sending API calls to the network. Verified: the service worker registers and controls each page, every manifest carries 192 and 512 icons and `display: standalone`, login still works through the worker, and the app shell loads with the network off.

To install on a phone, the backend must be served over HTTPS (localhost also counts for testing). Then:
- Android / Chrome: open the app URL (e.g. `/doctor.html`), menu -> Install app / Add to Home screen.
- iOS / Safari: open the URL, Share -> Add to Home Screen.

Each installs as its own icon and launches fullscreen with no browser chrome, so it looks and behaves like a native app. Installability lives in the served backend (which also serves `/sw.js`, the icons, and the per-app `.webmanifest` files); a single HTML file opened directly from disk renders but cannot install.

For native app-store builds (real `.apk` / `.ipa`), wrap each app in the Expo WebView shell like the patient app in `medicore-expo.tar.gz`, then EAS-build. That path needs Expo/EAS accounts and store submissions.
