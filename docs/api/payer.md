# HMO API (module `payer`, file `src/modules/payer.js`)

Two sides:
- **Provider side**: every provider package has module `hmo` (always on). Perms: `hmo.check` (receptionist, cashier, front desk manager, owner), `hmo.claim` (cashier, front desk manager, owner). Writes need clock-in (`423 clock_in_required`).
- **Payer side**: HMO orgs (type `hmo`, module `payer`) in the **payer** app (roles `payer_officer`, `payer_manager`) and the admin app (`payer_manager`). Perms `payer.members`, `payer.preauth`, `payer.claims`, `payer.pay` (manager only).
- **Patient app**: `/api/me/coverages*`.

General rules: all bodies JSON; all money is integer **kobo**; timestamps are epoch ms; dates are `YYYY-MM-DD` (Lagos). Errors: `{ error, code, details? }`. A record belonging to another HMO or provider is always **404**. A wrong-state action is **409** with `code: "wrong_state"` (or the specific code listed). The pick-list of HMOs for the patient app is the core endpoint `GET /api/directory/hmos` -> `[{ id, name, code }]`.

Cover categories (used for limits and usage): `consultation, drug, lab, ambulance, delivery, procedure, other`. Bill-line categories map as: `video -> consultation`, `registration -> other`, everything unknown -> `other`.

## Pre-authorisation threshold and tunables

| Setting | Where it comes from |
|---|---|
| `preauthThresholdKobo` | HMO's own setting (`PATCH /api/payer/settings`) > HQ per-provider override > platform setting `process.hmo.preauthThresholdKobo` > default 5,000,000 (NGN 50,000) |
| `duplicateWindowHours` | `process.hmo.duplicateWindowHours` (default 24) |
| `frequencyLimitPer30Days` | `process.hmo.frequencyLimitPer30Days` (default 3; flag when this many already exist, i.e. the 4th) |
| `preauthValidDays` | HMO setting (default 30) |

Claim submission and resubmission are refused with 403 when the platform feature `hmoClaims` is off.

---

## State machines

**Coverage** (`coverages`)
```
patient adds:   pending(patientConfirmed=true, payerVerified=false) --activate--> active
                pending --reject--> rejected
HMO enrols:     pending(patientConfirmed=false, payerVerified=true) --patient confirm--> active
                pending --patient decline--> declined
active --suspend--> suspended --reactivate--> active
active|suspended --end--> ended
```
`rejected`, `declined`, `ended` are final. Only `active` cover with `validTo >= today` counts.

**Pre-authorisation** (`preauths`)
```
pending --approve--> approved (final; usable on ONE bill until validUntil)
pending --deny-->    denied   (final)
pending --query-->   queried --provider answer--> pending
```

**Claim** (`claims`)
```
submitted --review--> under_review --approve--> approved --pay--> paid
                                   --deny-->    denied
                                   --query-->   queried --provider resubmit--> resubmitted --review--> under_review
```
`paid` and `denied` are final. Every transition is a conditional update: sending the same action twice (even in parallel) gives one 200 and one 409.

---

## Shapes

**CoverView (patient)**
```json
{ "id": "cov_..", "payerOrgId": "org_..", "payerName": "Harbor Health HMO", "memberNo": "HH-100234", "planName": "Harbor Gold",
  "status": "pending|active|suspended|ended|rejected|declined", "patientConfirmed": true, "payerVerified": true, "enrolledBy": "patient|payer",
  "limits": { "consultation": 20000000, "drug": 0, "lab": 0, "ambulance": 0, "delivery": 0, "procedure": 0, "other": 0 } | null,
  "usedKobo": { "...same keys": 0 }, "remainingKobo": { "...same keys": 0 } | null, "validTo": "2027-12-31" | null, "statusReason": null, "createdAt": 0 }
```
**CoverView (payer)** = CoverView + `{ patientId (null until the member confirms), member: { name, dob, sex, phone }, history: [{ at, from, to, by, orgId, reason? }], updatedAt }`. Before the member confirms, `member` is `{ name: <name HMO typed>, dob: null, sex: null, phone }`.

**PreauthView**
```json
{ "id": "pa_..", "number": "PA000012", "providerOrgId", "providerName", "payerOrgId", "payerName", "patientId", "patientName", "coverageId", "memberNo",
  "services": [{ "code", "name", "category", "qty", "unitKobo", "amountKobo", "priced": "price_list|quoted" }], "requestedKobo",
  "diagnosis": { "code": "I10" | null, "text": "..." }, "note", "status": "pending|queried|approved|denied",
  "approvedKobo": null, "authCode": "AUTH-HARB-123456" | null, "denyReason": null, "question": null, "answer": null,
  "validUntil": null, "usedBillId": null, "createdAt", "decidedAt": null,
  "ageMinutes": 12, "turnaroundMinutes": null, "waitingMinutes": 12, "history": [] }
```
Service prices: if the code exists in the provider's price list that price is used, otherwise the quoted `amountKobo` is kept (`priced: "quoted"`).

**ClaimView**
```json
{ "id": "clm_..", "number": "CL000003", "providerOrgId", "providerName", "payerOrgId", "payerName", "patientId", "patientName", "memberNo", "coverageId",
  "billId", "billNumber", "serviceDate": "2026-10-20",
  "lines": [{ "code", "name", "category", "qty", "unitPriceKobo", "totalKobo" }], "billTotalKobo", "claimedKobo", "approvedKobo": null, "paidKobo": null, "paymentRef": null,
  "diagnosis": { "code", "text" } | null, "preauthId": null, "preauthCode": null,
  "flags": [{ "code": "duplicate|no_evidence|over_limit|frequency|missing_preauth", "detail": "...", "codes?": ["CONS-GP"], "categories?": [] }], "flagged": true,
  "status": "...", "denyReason", "question", "answer", "decisionNote", "submittedAt", "decidedAt", "paidAt", "ageHours": 3.5, "turnaroundHours": null, "history": [] }
```
Diagnosis comes from the encounter linked to the bill source (appointment/encounter/rx order/lab order), else from the pre-authorisation.

**Fraud and quality flags** (computed once, at submission)
| code | rule |
|---|---|
| `duplicate` | another non-void bill for the same patient at the same provider containing the same service code within +-`duplicateWindowHours` |
| `no_evidence` | bill source record not in a done state: `appointment -> appointments.completed`, `encounter -> encounters.completed/closed/signed`, `rx_order -> rx_orders.collected/delivered`, `lab_order -> lab_orders.released`, `incident -> incidents.closed`; a manual bill (no source) is always flagged |
| `over_limit` | coverage usage above a limit, claim above bill total, coverage missing, or service date after `validTo` |
| `frequency` | patient already has >= `frequencyLimitPer30Days` claims to this HMO with the same service code in the last 30 days |
| `missing_preauth` | claimed amount above the threshold with no pre-authorisation |

---

## Patient app

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/me/coverages` | | `[CoverView]` (includes pending HMO enrolments addressed to the patient's phone) |
| POST | `/api/me/coverages` | `{ payerOrgId, memberNo (A-Z 0-9 - / ., max 40, stored upper-case), planName? }` | `CoverView` (status `pending`). 404 unknown HMO; 409 already has cover with this HMO, or member number taken |
| POST | `/api/me/coverages/:id/confirm` | | `CoverView`. HMO-enrolled -> `active`. 409 if not waiting for confirmation |
| POST | `/api/me/coverages/:id/decline` | | `CoverView` (`declined`) |

## Payer app (HMO staff; only records with their `payerOrgId`)

| Method | Path | Perm | Body / query | Response |
|---|---|---|---|---|
| GET | `/api/payer/coverages` | members/preauth/claims | `?status=&q=&limit=` (q matches memberNo, name, phone) | `[PayerCoverView]` |
| GET | `/api/payer/coverages/:id` | same | | `PayerCoverView + { claims: [{ id, number, status, claimedKobo, approvedKobo, submittedAt }] }` |
| POST | `/api/payer/coverages/:id/activate` | payer.members | `{ limits: {category: kobo, ...} (required, missing categories = 0), validTo (required, not past), planName? }` | `PayerCoverView`. Only patient-added pending cover |
| POST | `/api/payer/coverages/:id/reject` | payer.members | `{ reason }` | `PayerCoverView` |
| POST | `/api/payer/coverages/:id/suspend` | payer.members | `{ reason }` | `PayerCoverView` |
| POST | `/api/payer/coverages/:id/reactivate` | payer.members | | `PayerCoverView` |
| POST | `/api/payer/coverages/:id/end` | payer.members | `{ reason }` | `PayerCoverView` |
| POST | `/api/payer/coverages/:id/limits` | payer.members | `{ limits: {only the categories to change}, validTo?, planName? }` (active or suspended) | `PayerCoverView` |
| POST | `/api/payer/coverages/enrol` | payer.members | `{ members: [{ phone, memberNo, name?, planName?, limits, validTo }] }` (1 to 200) | `{ enrolled, failed, results: [{ index, memberNo?, ok, coverageId?, status?, error? }] }`. The result never reveals whether the phone is a MediCore patient |
| GET | `/api/payer/settings` | any payer perm | | `{ preauthThresholdKobo, thresholdSource: "hmo|platform", preauthValidDays, duplicateWindowHours, frequencyLimitPer30Days }` |
| PATCH | `/api/payer/settings` | admin.settings (manager) | `{ preauthThresholdKobo?, preauthValidDays? (1-365) }` | same as GET |
| GET | `/api/payer/preauths` | preauth/claims | `?status=&limit=` (pending sorted oldest first) | `[PreauthView]` |
| GET | `/api/payer/preauths/:id` | preauth/claims | | `PreauthView + { cover: { status, validTo, limits, usedKobo, remainingKobo } }` |
| POST | `/api/payer/preauths/:id/approve` | payer.preauth | `{ approvedKobo (1..requestedKobo), authCode? (else generated), note? }` | `PreauthView` |
| POST | `/api/payer/preauths/:id/deny` | payer.preauth | `{ reason }` | `PreauthView` |
| POST | `/api/payer/preauths/:id/query` | payer.preauth | `{ question }` | `PreauthView` |
| GET | `/api/payer/claims` | claims/pay | `?status=&flagged=true&providerOrgId=&limit=` (oldest first) | `[ClaimView]` |
| GET | `/api/payer/claims/:id` | claims/pay | | `ClaimView + { cover }` |
| POST | `/api/payer/claims/:id/review` | payer.claims | | from `submitted` or `resubmitted` |
| POST | `/api/payer/claims/:id/approve` | payer.claims | `{ approvedKobo (1..claimedKobo; less = partial), note? }` | from `under_review` |
| POST | `/api/payer/claims/:id/deny` | payer.claims | `{ reason }` | from `under_review` |
| POST | `/api/payer/claims/:id/query` | payer.claims | `{ question }` | from `under_review` |
| POST | `/api/payer/claims/:id/pay` | payer.pay | `{ paymentRef }` | from `approved`; `paidKobo = approvedKobo` |
| GET | `/api/payer/dashboard` | any payer perm or admin.reports | | see below |

Dashboard:
```json
{ "queue": { "submitted": 0, "under_review": 0, "queried": 0, "resubmitted": 0, "approved": 0, "denied": 0, "paid": 0 },
  "openClaims": 0, "oldestOpenHours": null, "avgTurnaroundHours": null,
  "flaggedOpen": 0, "flagged": [{ "id", "number", "providerOrgId", "flags": ["duplicate"], "claimedKobo", "ageHours" }],
  "totals": { "claimedKobo", "approvedKobo", "paidKobo", "approvedUnpaidKobo" },
  "byProvider": [{ "providerOrgId", "providerName", "claims", "claimedKobo", "approvedKobo", "paidKobo", "flagged" }],
  "preauths": { "pending", "queried", "oldestPendingMinutes", "avgTurnaroundMinutes" },
  "members": { "active", "pending", "utilisation": [{ "coverageId", "memberNo", "name", "limitKobo", "usedKobo", "pct" }] } }
```

## Provider side (front desk / cashier / admin of any provider)

| Method | Path | Perm | Body / query | Response |
|---|---|---|---|---|
| GET | `/api/hmo/patients/:patientId/cover` | hmo.check | patient must be linked (else 404) | `[{ coverageId, payerOrgId, payerName, memberNo, planName, validTo, limits, usedKobo, remainingKobo, preauthThresholdKobo }]` (active only) |
| POST | `/api/hmo/preauths` | hmo.check | `{ patientId, payerOrgId, coverageId, services: [{ code, name, category, qty?, amountKobo }] (1-30), diagnosis: { code?, text }, note? }` | `PreauthView` |
| GET | `/api/hmo/preauths` | hmo.check | `?status=&patientId=&limit=` | `[PreauthView]` (this provider's) |
| GET | `/api/hmo/preauths/:id` | hmo.check | | `PreauthView` |
| POST | `/api/hmo/preauths/:id/answer` | hmo.check | `{ answer }` | `PreauthView` (queried -> pending) |
| POST | `/api/hmo/bills/:billId/apply-cover` | hmo.check | `{ coverageId, preauthId? }` | `{ bill, coveredKobo, byCategory: {category: kobo}, patientDueKobo, coverage: { id, memberNo, payerOrgId } }` |
| GET | `/api/hmo/claimable-bills` | hmo.claim | | `[{ billId, number, patientId, patientName, payerOrgId, payerName, totalKobo, coveredKobo, createdAt }]` |
| POST | `/api/hmo/claims` | hmo.claim | `{ billIds: [..] (1-100) }` | `{ submitted, failed, results: [{ billId, ok, claimId?, number?, flags?: [code], error?: "not_found|no_cover|not_settled|already_claimed", message? }] }` |
| GET | `/api/hmo/claims` | hmo.claim | `?status=&payerOrgId=&limit=` | `[ClaimView]` |
| GET | `/api/hmo/claims/:id` | hmo.claim | | `ClaimView` |
| POST | `/api/hmo/claims/:id/resubmit` | hmo.claim | `{ answer }` | `ClaimView` (queried -> resubmitted) |
| GET | `/api/hmo/dashboard` | hmo.claim or admin.reports | | `{ byStatus: { <status>: { count, claimedKobo } }, payers: [{ payerOrgId, payerName, claims, pendingKobo, approvedUnpaidKobo, paidKobo, deniedKobo, outstandingKobo }], outstandingKobo, unclaimedBills, preauthsPending, preauthsQueried }` |

### Apply cover rules
- Bill must be at the caller's provider, `open`, unpaid, with no cover yet; patient linked; coverage active, confirmed and belonging to the bill's patient.
- Covered amount = per category `min(bill lines in category, remaining limit)`, capped at the pre-authorisation's `approvedKobo` when one is given.
- Without a pre-authorisation and covered amount above the threshold: `409 preauth_required`. With one it must be `approved`, unexpired, same patient/coverage/provider and unused (`409 preauth_used`); it is consumed by this bill.
- Nothing coverable: `409 not_covered`. Cover once per bill: `409 already_covered`. Inactive cover: `409 cover_inactive`.
- Usage is reserved atomically: parallel bills can never take a coverage above its limits.
- `billing.setHmoCover` lowers `patientDueKobo`; a fully covered bill becomes `paid` (`settledBy: "hmo"`) at once. The patient pays the rest through the normal bill payment.

### Claim rules
- One claim per bill, ever (unique). Only `paid` bills with HMO cover at the caller's provider.
- `bill.hmo.claimStatus` mirrors the claim status (`not_submitted` until claimed), and `bill.hmo.claimId` is set.

## Notifications
In-app, role-addressed: new cover / preauth / claim -> HMO `payer_officer`; preauth and claim decisions -> provider `cashier`; cover changes -> patient. No SMS.

## Demo data (Harbor Health HMO)
Active cover: Amaka `HH-100234` (Harbor Gold), Tobi `HH-100871` (Harbor Silver). One approved, unused preauth for Amaka at Grandville Hospital (CONS-SPEC). One paid claim (Amaka, CONS-GP). One flagged duplicate claim (Tobi, CONS-GP billed twice the same day). Sign in: `officer@harborhmo.demo` (officer) and `owner@harborhmo.demo` (manager, can pay).
