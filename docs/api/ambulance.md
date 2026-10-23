# Ambulance API (`src/modules/ambulance.js`)

Works for a standalone ambulance service (SwiftAid) and a hospital's own fleet (Grandville). Everything is scoped to the provider that owns the unit or incident; another provider's ids answer **404**.

Conventions for all calls: JSON bodies, header `X-MC-App: <app>` on every request (also required on the public line, use `patient`), money in integer kobo, times in epoch ms. Errors are `{ error, code, details? }`. Common codes: `400 bad_request`, `403 forbidden`, `404 not_found`, `409 wrong_state | unit_taken | not_dispatchable | active_emergency | no_unit`, `423 clock_in_required`, `429 rate_limited`.

Apps: `dispatch` (role ambulance_dispatcher: perms ambulance.dispatch + ambulance.fleet), `crew` (role crew), `admin` (owner, metrics), `frontdesk` (receiving hospital), `patient`.
"Shift" = route also needs the user clocked in (`POST /api/shift/clock-in`), else 423 `clock_in_required`.

## Reference values

| Name | Values |
|---|---|
| category -> default priority | `cardiac_arrest` P1, `breathing_difficulty` P1, `unconscious` P1, `stroke_symptoms` P1, `obstetric_emergency` P1, `road_traffic_accident` P2, `bleeding` P2, `burns` P2, `seizure` P2, `trauma_fall` P2, `other` P3 |
| priority | `P1` `P2` `P3` (dispatcher may override; `triage.overridden` is then true) |
| unit.type | `BLS` `ALS` `motorbike` `transfer` |
| unit.status | `in_service` `maintenance` `retired` |
| unit.availability | `available` `assigned` `enroute` `onscene` `transporting` `athospital` `returning` `offline` |
| crew certification | `EMT-B` `EMT-I` `Paramedic` `Driver` |
| incident.source | `app` (patient SOS) `call` (dispatcher) `public` (no login) `transfer` |
| notReadyReasons | `not_in_service` `compliance_expired` `no_crew` `crew_not_verified` `no_crew_on_shift` |

## Incident state machine

```
new -> assigned -> enroute -> onscene -> transporting -> athospital -> closed
 |        |  ^        |          |                                     ^
 |        +--+ (reassign, also from enroute)     +--------------------+ (closed from onscene: treated on scene)
 +--------+-----------+----------+--> cancelled
```

| From | Allowed to |
|---|---|
| new | assigned, cancelled |
| assigned | assigned (reassign), enroute, cancelled |
| enroute | assigned (reassign), onscene, cancelled |
| onscene | transporting (needs destination), closed, cancelled |
| transporting | athospital |
| athospital | closed |
| closed, cancelled | (none) |

Every change is conditional on the FROM state: a repeated or parallel call gets **409 `wrong_state`**. A unit is claimed with a conditional update on its availability: two dispatchers assigning the same unit get one 200 and one **409 `unit_taken`**. Patients may cancel only from `new`, `assigned`, `enroute`.

Unit availability follows the incident: assigned/enroute/onscene/transporting/athospital mirror the status; closed or cancelled frees the unit (`available`, or `returning` if the crew clears with `returning: true`).

**Dispatchable** = `status: in_service`, no expired registration/insurance/inspection, `availability: available`, no current incident, and at least one crew member on the unit who is an active `crew` member, has a **verified** profile with an unexpired licence, and is **clocked in**.

**Billing**: exactly once, by the request that wins the close transition. `billing.createBill` at the ambulance provider with `source: { type: 'incident', id }`. Lines: `AMB-ALS` for an ALS unit if the price list has it, else `AMB-CALL`; plus `AMB-KM` x ceil(km) where km = sum of GPS track points recorded since `transporting`, or straight line scene -> destination when fewer than 2 points. No patient attached -> no bill (`billStatus: 'no_patient'`); no price list -> `billStatus: 'no_price_list'`. After payment `billStatus: 'paid'`.

## Objects

### Incident (staff view: dispatcher and crew)
```json
{
  "id": "inc_...", "orgId": "org_...", "number": "INC000012", "source": "app|call|public|transfer",
  "caller": { "name": "Kunle Martins", "phone": "+2348077770202" },
  "patientId": "pat_...|null",
  "patientInfo": { "firstName": "Kunle", "age": 67, "sex": "male", "bloodGroup": "O-", "allergies": [{ "substance": "Penicillin", "severity": "severe", "reaction": "Rash" }], "noKnownAllergies": false } | null,
  "location": { "lat": 6.452, "lng": 3.435, "address": "9 Bourdillon Rd|null", "landmark": "null|text" },
  "triage": { "category": "stroke_symptoms", "priority": "P1", "derivedPriority": "P1", "overridden": false, "overriddenBy": null },
  "status": "assigned", "statusLabel": "Ambulance assigned", "allowedNext": ["assigned", "enroute", "cancelled"],
  "unitId": "unit_...|null", "unitName": "SwiftAid 1 (ALS)|null",
  "destination": { "orgId": "org_...|null", "name": "Grandville Hospital", "lat": 6.499, "lng": 3.354, "address": "..." } | null,
  "timeline": [{ "status": "new", "at": 1792500000000, "by": "usr_...|public", "byName": "Lanre Shittu", "note": null }],
  "times": { "new": 0, "assigned": 0, "enroute": 0, "onscene": 0, "transporting": 0, "athospital": 0, "closed": 0, "cancelled": 0, "reassigned": 0, "destinationSet": 0 },
  "verified": true, "flags": { "unverified": false, "noUnitAvailableAtCreate": false, "priorityOverridden": false },
  "notes": [{ "text": "...", "at": 0, "by": "usr_...", "byName": "...", "kind": "dispatcher|caller" }],
  "care": [ePCR entry, see crew],
  "noUnitAvailable": false, "billId": "bil_...|null", "billStatus": "open|paid|no_patient|no_price_list|null", "transportKm": 10.2,
  "cancelReason": "text (when cancelled)", "createdAt": 0
}
```
Only the `times.*` keys that happened are present.

### Unit
```json
{
  "id": "unit_...", "name": "SwiftAid 1 (ALS)", "type": "ALS", "plate": "LND-482-KJ", "status": "in_service", "availability": "available", "currentIncidentId": null,
  "lastLoc": { "lat": 6.6, "lng": 3.35, "accuracy": 12, "speed": 14, "heading": 120, "at": 0 } | null, "lastLocFresh": true,
  "compliance": { "registration": { "expiry": "2027-08-01", "daysLeft": 285, "expired": false, "expiringSoon": false, "missing": false }, "insurance": {...}, "inspection": {...} },
  "crew": [{ "membershipId": "mem_...", "userId": "usr_...", "name": "Paul Okeke", "certification": "Paramedic", "verified": true, "licenceValid": true, "licenceExpiry": "2027-11-24", "active": true, "onShift": true, "ready": true }],
  "ready": true, "notReadyReasons": [], "dispatchable": true,
  "distanceKm": 3.2, "etaMinutes": 11
}
```
`expiringSoon` = 0..90 days left. `distanceKm` / `etaMinutes` only in `suggest`. `lastLocFresh` = GPS within `process.emergency.locationFreshSeconds` (default 120 s).

### Patient incident view (patient app, public status)
```json
{
  "id": "inc_...", "number": "INC000012", "status": "enroute", "statusLabel": "Ambulance on the way", "category": "stroke_symptoms", "categoryLabel": "Stroke symptoms", "priority": "P1",
  "createdAt": 0, "provider": { "id": "org_...", "name": "SwiftAid Ambulance", "phone": "+234..." },
  "unit": { "name": "SwiftAid 1 (ALS)", "plate": "LND-482-KJ", "type": "ALS" } | null,
  "unitLoc": { "lat": 6.5, "lng": 3.4, "at": 0, "heading": 120 } | null,
  "etaMinutes": 9 | null, "etaTarget": "you|hospital|null",
  "destination": { "name": "Grandville Hospital" } | null, "location": { "lat": 0, "lng": 0, "address": null, "landmark": null },
  "timeline": [{ "status": "new", "label": "Received", "at": 0 }],
  "canCancel": true, "verified": true, "cancelReason": null
}
```
`unitLoc` and `etaMinutes` appear only when the unit's GPS is fresh. ETA: OSRM-compatible `ROUTING_URL` (settings `integrations.routing.url`) when set, else straight line x1.4 at 25 km/h. Nothing is written on GET; poll every 10 to 15 s.

## Endpoints

### Patient (app `patient`)
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/me/emergency` | `{ lat*, lng*, category*, note?, address?, landmark?, providerOrgId? }` | patient incident view + `{ existing: bool, noUnitAvailable?: bool }` |
| GET | `/api/me/emergency/active` | | `{ incident: view or null }` |
| GET | `/api/me/emergency` | | `[view]` (last 50) |
| GET | `/api/me/emergency/:id` | | view (404 if not yours) |
| POST | `/api/me/emergency/:id/cancel` | `{ reason? }` | view; 409 once on scene or already closed |

SOS rules: lat/lng must be inside Nigeria (lat 4..14, lng 2.5..15) else 400. If you already have an open emergency, the same incident comes back with `existing: true` (one open emergency per patient). Rate limit 5 per patient per hour. `providerOrgId` must be an active provider with the ambulance module (else 404). Otherwise the nearest active ambulance provider with a dispatchable available unit within `process.emergency.sosRadiusKm` (default 40 km; distance from unit `lastLoc`, or provider location) is chosen; if none has one, the nearest provider gets it with `noUnitAvailable: true` (the dispatcher sees the flag). The patient is linked to that provider (`via: 'emergency'`) and their first name, age, sex, blood group and allergies are copied into the incident (`patientInfo`) for this case only.

### Public line (no login; header `X-MC-App: patient`)
| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/api/emergency` | `{ name*, phone*, lat*, lng*, category*, address?, landmark?, note? }` | `{ ok, existing:false, incidentId, number, trackToken, provider: { name, phone }, message }` or for a phone with an open public case `{ ok, existing:true, incidentId, number, provider, message }` |
| GET | `/api/emergency/:id/status?token=` | | patient incident view without `location` and `destination`; 404 on bad token |

Phone is normalised to `+234...` (400 if not a Nigerian number). Limits: per IP `process.emergency.publicPerIpPerHour` (default 5) per hour, per phone 3 per hour -> 429. Created with `verified: false`, `source: 'public'`, shown flagged on the board. Feature switch `features.publicEmergency` off -> 404. Keep the `trackToken` on the device to poll status.

### Dispatcher (app `dispatch`, perm ambulance.dispatch)
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/dispatch/board` | | `{ incidents: [incident + ageMin], units: [unit], categories: { key: { label, priority } } }` open incidents sorted P1 first, then oldest |
| GET | `/api/dispatch/incidents` | `?status=&limit=` | `[incident]` newest first |
| GET | `/api/dispatch/incidents/:id` | | incident + `track: [{ lat, lng, at, status }]` |
| POST | `/api/dispatch/incidents` (shift) | `{ source?: 'call'|'transfer', caller?: { name?, phone? }, patientId?, location*: { lat*, lng*, address?, landmark? }, category*, priority?, note? }` | incident. `patientId` must be linked to your provider (404); 409 `active_emergency` if that patient already has an open one |
| PATCH | `/api/dispatch/incidents/:id/triage` (shift) | `{ category?, priority? }` | incident (changing category re-derives priority unless priority is given) |
| GET | `/api/dispatch/incidents/:id/suggest` | | `[unit with distanceKm, etaMinutes]` dispatchable first, then nearest |
| POST | `/api/dispatch/incidents/:id/assign` (shift) | `{ unitId* }` | incident (`new` -> `assigned`). 409 `unit_taken`, `not_dispatchable` (message lists reasons), `wrong_state` |
| POST | `/api/dispatch/incidents/:id/reassign` (shift) | `{ unitId*, reason* (3..300) }` | incident; old unit freed |
| POST | `/api/dispatch/incidents/:id/cancel` (shift) | `{ reason* }` | incident |
| POST | `/api/dispatch/incidents/:id/close` (shift) | `{ note? }` | incident (from onscene or athospital); bills once |
| POST | `/api/dispatch/incidents/:id/destination` (shift) | `{ orgId }` (active provider with clinic module) or `{ name*, lat?, lng? }` (free text hospital) | incident. A MediCore destination is pre-alerted: notification to its `receptionist` role, kind `ambulance_incoming` |
| POST | `/api/dispatch/incidents/:id/notes` | `{ text* }` | incident |
| POST | `/api/dispatch/incidents/:id/verify` (shift) | | incident with `verified: true` (public call confirmed by call-back); 409 if already verified |
| POST | `/api/dispatch/incidents/:id/patient` | `{ patientId* }` (linked; register walk-ins via `/api/fd/patients` first) | incident; needed for billing a public call |
| GET | `/api/dispatch/destinations` | `?lat=&lng=` | `[{ orgId, name, type, lat, lng, area, distanceKm }]` (also for crew) |
| GET | `/api/shift/on-duty` (core) | | who is clocked in |

Dispatcher notifications (`GET /api/notifications`, role-addressed): `ambulance_new` (title says UNVERIFIED for public calls), `ambulance_cancel`.

### Fleet (perm ambulance.fleet: dispatcher, owner in `admin`)
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/ambulance/units` | | `[unit]` (not retired) |
| POST | `/api/ambulance/units` | `{ name*, type*, plate*, registrationExpiry?, insuranceExpiry?, inspectionExpiry? }` (dates `YYYY-MM-DD`) | unit (starts `in_service`, `offline`) |
| PATCH | `/api/ambulance/units/:id` | `{ name?, type?, plate?, status?, availability?: 'available'|'offline', crewMembershipIds?: [membershipId], registrationExpiry?, insuranceExpiry?, inspectionExpiry? }` | unit. status/availability changes only between jobs (409). Crew must be active `crew` members of your provider (400); a crew member is moved off any other unit |
| GET | `/api/ambulance/crew` | | `[{ membershipId, name, phone, status, onShift, profile: { certification, licenceNo, licenceExpiry, licenceValid, licenceExpiringSoon, verified, verifiedAt } | null, unit: { id, name } | null }]` |
| PUT | `/api/ambulance/crew/:membershipId` | `{ certification*, licenceNo*, licenceExpiry* }` | profile; changed details reset `verified` to false |
| POST | `/api/ambulance/crew/:membershipId/verify` | `{ verified* }` | profile (cannot verify yourself; expired licence 400) |
| GET | `/api/ambulance/metrics` | `?days=30` (perm ambulance.fleet or admin.reports) | `{ days, since, byPriority: { all|P1|P2|P3: { incidents, closed, cancelled, newToAssigned: { n, avgMin, p90Min }, assignedToOnscene: { n, avgMin, p90Min } } } }` |

### Crew (app `crew`, perm ambulance.crew)
Crew act only on the incident assigned to the unit they are on, at their own provider; anything else is 404.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/crew/me` | | `{ onShift, profile: { certification, licenceExpiry, verified, licenceValid } | null, unit: unit | null, incident: incident + { etaMinutes, etaTarget: 'scene'|'hospital'|null, categoryLabel } | null, demoDrive: bool }` |
| POST | `/api/crew/location` (shift) | `{ lat*, lng*, accuracy?, speed? (m/s), heading? (0..360) }` from phone GPS (`watchPosition`), every 5 to 15 s | `{ ok, tracked, incidentId }`; `tracked` false when a point was stored less than 10 s ago (unit `lastLoc` is always updated). 409 `no_unit`. Max 30 per minute |
| POST | `/api/crew/incidents/:id/status` (shift) | `{ status*: 'enroute'|'onscene'|'transporting'|'athospital'|'clear', note?, returning? }` | incident. `clear` closes (from onscene or athospital) and bills once. `transporting` needs a destination (400) and re-alerts the receiving desk |
| POST | `/api/crew/incidents/:id/destination` (shift) | same as dispatcher | incident |
| POST | `/api/crew/incidents/:id/care` (shift) | `{ vitals?: { bpSys, bpDia, pulse, rr, spo2, tempC, gcs, glucose, painScore }, interventions?: [text], medications?: [{ name*, dose?, route? }], handoverNote?, note? }` | `{ ok, entry: { id, at, by, byName, ...fields } }`; allowed enroute to athospital |
| POST | `/api/crew/availability` (shift) | `{ availability*: 'available'|'returning'|'offline' }` | unit; only between jobs |
| POST | `/api/crew/demo-drive` (shift, **DEMO_MODE only**; the route does not exist otherwise) | `{ incidentId* }` | `{ ok, demo: true, loc, remainingKm, arrived }` moves the unit about 400 m toward the scene (assigned/enroute) or destination (transporting). The demo crew app may call it on a timer instead of real GPS |

Crew notifications (user-addressed): `ambulance_job` (new job, cancelled).

### Receiving hospital front desk (app `frontdesk`; perm queue.manage, patient.register or patient.read)
| Method | Path | Response |
|---|---|---|
| GET | `/api/fd/incoming` | `[{ incidentId, number, fromProvider: { name, phone }, status, statusLabel, category, categoryLabel, priority, etaMinutes (while transporting with fresh GPS, else null), unit: { name, plate, type } | null, arrivedAt, patient: { firstName, age, sex, bloodGroup, allergies: [{ substance, severity }] } | null }]` open incidents whose destination is your provider |

Pre-alert notifications to role `receptionist`: kind `ambulance_incoming`, `ref: { type: 'incident', id }`, on destination set and again when transport starts.

## Settings used (HQ, `src/lib/settings.js`)
`process.emergency.publicPerIpPerHour` (5), `process.emergency.sosRadiusKm` (40), `process.emergency.locationFreshSeconds` (120), `features.publicEmergency` (true), `integrations.routing.url`.

## Demo data
SwiftAid: `SwiftAid 1 (ALS)` (crew@swiftaid.demo, insurance expiring in 60 days), `SwiftAid 2 (BLS)` (crew2@swiftaid.demo), `SwiftAid Moto 1` (no crew); one open unverified public RTA call; one closed seizure case (Zainab, to Grandville) with a bill (AMB-ALS + 12 km). Grandville: `Grandville A1` (crew@grandville.demo), `Grandville B2` (no crew). Units become dispatchable once their crew clocks in.
