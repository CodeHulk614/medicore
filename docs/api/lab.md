# Lab API (`src/modules/lab.js`)

Works for a standalone lab (ClearPath Diagnostics) and a hospital lab (Grandville). Lab staff see only orders where `labOrgId` is their provider; referring doctors see orders their provider referred. Anything else is **404**.

All calls: JSON, header `X-MC-App`, money in integer kobo, times epoch ms. Errors `{ error, code, details? }`; codes used: `400 bad_request`, `403 forbidden`, `404 not_found`, `409 wrong_state | payment_required | unverified_values | not_ready | stale`, `423 clock_in_required`, `429 rate_limited`.

Apps and roles: `lab` (lab_reception: lab.receive; lab_scientist: receive, result, verify; lab_manager: plus lab.catalog), `frontdesk` (cashier at a lab provider: worklist read, walk-in orders via billing.create, payments via core `/api/bills/:id/cash`), `doctor` (referring), `patient`, `admin` (owner has all perms). "Shift" = clock-in required.

Test codes come from `src/clinical/labtests.js` (`GET /api/lab/catalog` lists them all). Panels expand to components: `FBC` = HB, WBC, PLT, PCV; `E-U-CR` = NA, K, UREA, CREAT; `LFT` = ALT, AST, TBIL, ALB; `LIPID` = CHOL, HDL, LDL, TG. Results are entered per component.

## Order state machine

```
awaiting_lab -> ordered -> paid -> sample_collected -> in_progress -> resulted -> verified -> released
     |            |   \______________urgent override____/      ^            |           |
     |            |                                            +-- reopen --+-----------+
     +------------+--------> cancelled (also from paid)
released --amend--> released (version + 1, previous version kept)
```

| From | To | How |
|---|---|---|
| awaiting_lab | ordered | patient `POST /api/me/lab-orders/:id/send` |
| awaiting_lab | cancelled | patient cancel |
| ordered | paid | **only** `billing.onSettled('lab_order')` (Paystack, counter cash/POS, or full HMO cover; `paidVia` = `paystack|cash|pos|transfer|hmo|free|demo`) |
| ordered | sample_collected | receive with `urgentOverride.reason`, urgent orders only, if `process.lab.collectBeforePaymentForUrgent` (default true). Audited `lab.receive_urgent_override`. A later payment sets `paid: true` without changing status |
| paid | sample_collected | `POST /api/lab/orders/:id/receive` |
| ordered, paid | cancelled | lab cancel (bill must be voided/refunded at the desk) |
| sample_collected | in_progress | start |
| in_progress | resulted | enter results (all components at once) |
| resulted, verified | in_progress | reopen with reason (correct before release) |
| resulted | verified | verify (blocked while any value is `unverified`; two-step rule) |
| verified | released | release (notifications) |
| released | released | amend (new version + reason) |

Every transition is conditional on its FROM state; repeats and parallel calls get **409 `wrong_state`**. Bills are created once (by the request that wins `awaiting_lab -> ordered`, or at order creation when the lab is known) with `billing.createBill({ orgId: labOrgId, source: { type: 'lab_order', id } })`, one line per ordered test: `{ code: 'LAB-<code>', name, category: 'lab', qty: 1, unitPriceKobo: <lab catalogue price> }`.

**Flags are computed on the server** with `labtests.flag(range, value)` using the lab's range (reference range overridden by the lab's catalogue `range`). Any `flag` / `critical` the client sends is ignored. Flags: `normal | low | high | abnormal | unverified`; `critical: bool`. A non-numeric value for a numeric test is stored as `unverified` and sets `hasUnverified: true`, which blocks verify until the order is reopened and re-entered.

**Two-step verification**: when the provider setting `twoStepLabVerify` (admin `PATCH /api/admin/org { settings: { twoStepLabVerify: true } }`) or platform `process.lab.twoStepVerifyDefault` is on, the verifier must be a different user from the one who entered the results (403).

## Objects

### Order summary (worklist, lab detail base)
```json
{
  "id": "lo_...", "number": "LO000004", "status": "paid", "statusLabel": "Paid, awaiting sample", "priority": "routine|urgent",
  "tests": [{ "code": "FBC", "name": "Full blood count" }], "accession": "CLEAR-261020-0001|null", "paid": true, "paidVia": "pos", "billId": "bil_...",
  "collectedAt": 0, "urgentOverride": false, "tatHours": 4, "dueAt": 0, "overdue": false, "minutesLeft": 180,
  "hasUnverified": false, "criticalPending": false, "referringOrgName": "Lekki Family Clinic|null", "referrerName": "free text|null", "orderedByName": "Dr. Ada Nwosu|null",
  "selfRequested": false, "source": "referral|self|walk_in", "createdAt": 0, "releasedAt": null, "version": 0,
  "patient": { "id": "pat_...", "name": "Kunle Martins", "mrn": "CLEA-000003", "age": 67, "sex": "male" }
}
```
`tatHours` = the longest turnaround of the ordered tests at that lab; `dueAt` = `collectedAt + tatHours`; `overdue` computed on read. Accession / barcode format `<LABCODE>-<YYMMDD>-<NNNN>` (render as Code128).

### Result line
```json
{ "code": "HB", "name": "Haemoglobin", "value": "10.9", "unit": "g/dL", "flag": "low", "critical": false, "comment": null,
  "range": { "low": 11.5, "high": 16.5, "critLow": 7, "critHigh": 20, "normalText": null, "qualitative": false } }
```

### Report (patient report, doctor results, resultsForPatient)
```json
{
  "id": "lo_...", "number": "LO000001", "status": "released",
  "lab": { "id": "org_...", "name": "ClearPath Diagnostics", "phone": "+234...", "address": "..." },
  "referringOrgName": "Lekki Family Clinic", "orderedByName": "Dr. Ada Nwosu", "selfRequested": false, "accession": "CLEAR-DEMO-0001", "collectedAt": 0,
  "tests": [{ "code": "FBC", "name": "Full blood count" }], "results": [result line],
  "verifiedBy": { "name": "Funke Ojo", "at": 0 }, "releasedAt": 0, "version": 2, "amended": true,
  "amendments": [{ "version": 2, "reason": "Transcription error", "at": 0, "byName": "Funke Ojo" }],
  "critical": { "has": false, "acknowledged": false }
}
```

### Patient order
```json
{ "id": "lo_...", "number": "LO000002", "status": "awaiting_lab", "statusLabel": "Choose a lab", "tests": [{ "code": "INR", "name": "INR (prothrombin time)" }], "priority": "routine",
  "lab": { "id", "name", "phone" } | null, "referringOrgName": "Lekki Family Clinic", "orderedByName": "Dr. Ada Nwosu", "selfRequested": false,
  "billId": "bil_...|null", "bill": { "status": "open|paid|void", "totalKobo": 800000, "patientDueKobo": 800000, "paidKobo": 0 } | null, "paid": false,
  "resultReady": false, "version": 0, "createdAt": 0, "releasedAt": null }
```
Pay with core `POST /api/me/bills/:billId/pay`.

## Endpoints

### Public (no login)
| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/api/labs` | `?codes=FBC,MP&lat=&lng=` | labs offering ALL codes: `[publicOrg + { acceptsWalkIns, totalKobo, tatHours }]` nearest first (publicOrg = `{ id, name, type, typeLabel, code, modules, area, city, location, distanceKm, phone, openingHours }`) |
| GET | `/api/labs/:orgId/tests` | | `{ lab: publicOrg + { acceptsWalkIns }, tests: [{ code, name, specimen, panel: [{ code, name }] | null, priceKobo, tatHours }] }` active tests only |

### Patient (app `patient`)
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/me/lab-orders` | | `[patient order]` newest first |
| POST | `/api/me/lab-orders/:id/send` | `{ labOrgId* }` | patient order (status `ordered`, bill raised). 409 if not `awaiting_lab`; 404 if not an active lab; 400 `This lab does not offer: X` (details[0].codes) |
| POST | `/api/me/lab-orders/:id/cancel` | | patient order; only `awaiting_lab` |
| POST | `/api/me/lab-requests` | `{ labOrgId*, tests*: ['FBS', ...] }` | patient order (`selfRequested: true`, bill raised). 403 if the lab's `acceptsWalkIns` is false. 10 per hour. Results go to the patient only (never shared to other providers) |
| GET | `/api/me/lab-orders/:id/report` | | report; 409 `not_ready` before release; 404 if not yours |

Patient notifications: `lab_result` (SMS "Your lab result is ready", no clinical details), `lab_critical` for self-requested critical results (asks them to contact the lab).

### Lab desk and worklist (module lab; perms lab.receive / lab.result / lab.verify / lab.catalog / billing.cash / billing.create)
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/lab/worklist` | `?status=&overdue=true&limit=` | `[order summary]`. No status = all open orders plus released ones with an unacknowledged critical value. Sorted critical pending, urgent, overdue, oldest |
| GET | `/api/lab/accession/:acc` | | order summary (404 at another lab) |
| GET | `/api/lab/orders/:id` | | summary + `{ clinicalNote, specimen: { collectedAt, collectedBy, collectorName, types, note, urgentOverride: { reason, by, at } | null }, results, enteredBy: { userId, name, at }, verifiedBy, versions: [{ version, results, verifiedBy, releasedAt, supersededAt }], amendments, critical: { has, acknowledged, acknowledgedAt, notifiedAt, callbacks: [{ to, method, note, at, by, byName, side }] }, timeline: [{ status, at, by, byName, note }], components: [{ code, components: [{ code, name }] }] }` |
| POST | `/api/lab/orders` (shift; lab.receive or billing.create) | `{ patientId*, tests*: [code], priority?, clinicalNote?, referrerName? }` | order summary (walk-in, `source: 'walk_in'`, bill raised). Register or link the patient first with core `/api/fd/patients` (404 if not linked) |
| GET | `/api/lab/catalog` | | `[{ code, name, loinc, specimen, panel, priceKobo, tatHours, active, inCatalogue, range, reference }]` every reference test, with this lab's settings |
| PUT | `/api/lab/catalog/:code` (lab.catalog) | `{ priceKobo?, tatHours?, active?, range?: { unit?, low?, high?, critLow?, critHigh?, normalText? } }` | catalogue entry view. Active needs a price |

### Lab workflow
| Method | Path | Perm | Body | Response |
|---|---|---|---|---|
| POST | `/api/lab/orders/:id/receive` | lab.receive, shift | `{ urgentOverride?: { reason* (5..300) }, specimenNote? }` | summary with accession. Unpaid -> 409 `payment_required`; override on a routine order -> 403 |
| POST | `/api/lab/orders/:id/start` | lab.result, shift | | summary (`in_progress`) |
| POST | `/api/lab/orders/:id/results` | lab.result, shift | `{ results*: [{ code*, value*, comment? }] }` every component of the order | summary + `results`. 409 unless `in_progress`; 400 for a code not in the order, a duplicate, or a missing component |
| POST | `/api/lab/orders/:id/reopen` | lab.result or lab.verify, shift | `{ reason* }` | summary (`in_progress`) |
| POST | `/api/lab/orders/:id/verify` | lab.verify, shift | | summary. 409 `unverified_values`; 403 two-step |
| POST | `/api/lab/orders/:id/release` | lab.verify, shift | | summary. Notifies once |
| POST | `/api/lab/orders/:id/critical-callback` | lab.result or lab.verify, shift | `{ to* (person informed), method?: 'phone'|'in_person'|'other', note? }` | `{ ok, critical }` |
| POST | `/api/lab/orders/:id/amend` | lab.verify, shift | `{ reason* (5..300), results*: [{ code, value, comment? }] }` (only changed components) | summary + `results`, `amendments`. 409 unless released; 400 for invalid values; 409 `stale` on a parallel amend |
| POST | `/api/lab/orders/:id/cancel` | lab.receive, shift | `{ reason* }` | summary + `billNote` (from ordered or paid) |

On release: patient `lab_result`; referring doctor (`orderedByUserId`) `lab_result`. If any value is critical: urgent `lab_critical` notification to the ordering doctor and to role `doctor` at the referring provider, and to `lab_manager` at the lab; `criticalPending` stays true on the worklist until a callback or doctor acknowledgement is recorded. Amendments re-notify (`Your lab report was updated`).

### Referring provider (app `doctor`; perm clinic.order_lab or clinic.consult)
| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/lab/referred` | `?status=&patientId=&limit=` | `[order summary + lab: { id, name } | null]` orders your provider referred |
| GET | `/api/lab/patient-results/:patientId` | | `[report]` released results your provider may see (patient must be linked: 404) |
| POST | `/api/lab/referred/:id/ack-critical` | `{ note? }` | `{ ok, critical }` records a callback `{ to: doctor name, method: 'app_ack', at, by }` |

Doctors read notifications with core `GET /api/notifications`.

## Module exports (for other builders)
- `createLabOrder({ referringOrgId, labOrgId|null, patientId, tests: [{ code }], orderedByUserId, orderedByName, encounterId, priority: 'routine'|'urgent', clinicalNote })` returns the `lab_orders` doc. `labOrgId` null -> `awaiting_lab`. With a lab: the lab must offer every code (throws 400), the patient is linked at the lab and the bill is raised.
- `resultsForPatient(req, patientId)` returns `[report]`: results from the caller's own lab, results the caller referred, and others only when `P.sharesWith(org, patient)` (self-requested results excluded).

## Settings used
`process.lab.twoStepVerifyDefault` (false), `process.lab.collectBeforePaymentForUrgent` (true); provider `settings.twoStepLabVerify`, `settings.acceptsWalkIns`, `settings.marketplace`.

## Demo data
Catalogues with prices at ClearPath (e.g. FBC NGN 6,500, MP 2,500, INR 8,000, E-U-CR 15,000) and Grandville (FBC 6,000 with 2 h turnaround, own HB range 12 to 16). Amaka: released FBC + MP at ClearPath referred by Lekki Family Clinic (HB low, malaria seen). Kunle: INR from the clinic waiting for him to choose a lab. Tobi: urgent RBS + E-U-CR in progress at the Grandville lab.
