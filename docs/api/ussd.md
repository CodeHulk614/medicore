# USSD API (file `src/modules/ussd.js`)

One endpoint, called by the USSD aggregator (Africa's Talking style). Not used by any MediCore web app; the patient app only sets the PIN.

## `POST /api/ussd`

**Auth:** header `X-USSD-Key: <secret>` or query `?key=<secret>` must equal `USSD_SECRET` (env var, or HQ settings `integrations.ussd.secret`). Compared in constant time.
- Platform feature `ussd` off -> `503 { error: "USSD is switched off", code: "feature_off" }`
- Secret not set -> `503 { error: "USSD not configured", code: "not_configured" }`
- Wrong or missing key -> `401 { error: "Unauthorised" }`

**Body** (`application/x-www-form-urlencoded` or JSON): `sessionId`, `serviceCode`, `phoneNumber` (any Nigerian format, normalised to +234...), `text` (the aggregator's cumulative input, parts joined by `*`; empty on the first screen).

**Response:** `200 text/plain`, starting `CON ` (wait for more input) or `END ` (session over), at most 182 characters. Never contains clinical details (no test names, results, diagnoses or drugs).

## Who is served
The phone must belong to a patient with an active MediCore account **and** a USSD PIN. Otherwise: `END This number is not set up for MediCore USSD...`. An unreadable or empty phone: `END Sorry, we could not read your phone number.` Rate limit: 40 requests per phone per 10 minutes (then `END Too many requests...`).

Patients set the PIN in the patient app with the core endpoint `POST /api/me/ussd-pin { pin: "4 digits", password }` (`GET /api/me/profile` shows `ussdPinSet`).

## Menu (by `text`)

| text | reply |
|---|---|
| `` (empty) | `CON MediCore\n1 My next appointment\n2 My HMO cover balance\n3 My latest lab result status\n4 Emergency: request ambulance\n0 Exit` |
| `0` | `END Thank you for using MediCore.` |
| `1` / `2` / `3` | `CON Enter your 4-digit MediCore PIN:` |
| `1*PIN` | `END Next appointment: Tue 21 Oct 09:00 at Grandville Hospital.` or `END You have no upcoming appointment...` |
| `2*PIN` | `END Harbor Health HMO HH-100234 to 2027-12-31: Consult NGN 192,000, Drugs NGN 300,000, Lab NGN 150,000` (up to 2 covers) or `END You have no active HMO cover on MediCore.` |
| `3*PIN` | `END Your latest lab test (ordered 2026-10-18): result ready. Open the MediCore app to view it.` (status words only) |
| `4` | `CON Emergency. Type your location or a nearby landmark:` (no PIN) |
| `4*landmark` | `CON Send an ambulance to: <landmark>?\n1 Yes\n2 No` |
| `4*landmark*1` | `END Ambulance requested. Keep your phone on...` or, if the ambulance module cannot take USSD requests, `END ... Call 112 now.` |
| `4*landmark*2` | `END Request cancelled. If it is an emergency call 112.` |
| anything else | `END Invalid choice.` |

## PIN lockout
Wrong PIN: `END Wrong PIN. 2 attempts left.` / `1 attempt left.` The third wrong PIN in a row locks USSD for that patient for **1 hour** (`END Wrong PIN. USSD is now locked for 1 hour.`); while locked, menus 1 to 3 answer `END USSD is locked after 3 wrong PINs. Try again after HH:MM...`, even with the right PIN. A correct PIN resets the counter. Emergency (4) is never locked.

## Audit
`ussd.menu` (menu number), `ussd.pin_failed`, `ussd.emergency`; no phone numbers in the audit meta.

## Emergency contract (ambulance module)
USSD calls `require('./ambulance').createIncidentFromUssd({ patient, phone, landmark, approxLocation })` when that export exists (`approxLocation` is the patient's saved home location or null; USSD has no GPS) and expects the incident document back. Until it exists, the reply tells the caller to dial 112.
