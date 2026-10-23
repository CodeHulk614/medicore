# Community health API (module `chw`, file `src/modules/chw.js`)

App: **chw**. Role `chw` (perm `chw.field`, plus `patient.register`); the role clocks in, so every write needs an open shift (`423 clock_in_required`). Supervisors are provider admins (`admin.reports` / `admin.staff`). The provider must have module `chw` (else 403) and the platform feature `chw` must be on (else `403 feature_off`).

**Visibility:** a CHW sees only households and clients they registered, or that an admin assigned to them (assigning a household also covers its clients). Anything else is 404 / `not_found`.

## Offline sync

`POST /api/chw/sync`
```json
{ "records": [
  { "clientRef": "<UUID made on the device>", "kind": "household|client|visit|immunization|anc|referral",
    "data": { ... }, "recordedAt": 1792500000000, "lat": 6.5, "lng": 3.36 } ] }
```
- 1 to 200 records per call (more: 400 for the whole call). Processed **in order**, so a household and the clients that reference it can go in one batch.
- **Idempotent**: `(orgId, clientRef)` is unique. Re-sending a record returns `status: "existing"` with the same `id`; nothing is created twice, even for parallel sends.
- `recordedAt` (epoch ms, device time) is optional; future times are clamped to now.
- Each record succeeds or fails on its own.

Response:
```json
{ "ok": false, "saved": 3, "failed": 1, "serverTime": 1792500000000,
  "results": [
    { "clientRef": "...", "kind": "client", "ok": true, "status": "created|existing|link_requested", "id": "cc_...", "patientId": "pat_..."?, "existing": true?, "referralId": "cr_..."?, "queueId": "q_..."?, "devCode": "123456"? (demo only, link_requested), "message": "..."? },
    { "clientRef": "...", "kind": "visit", "ok": false, "error": "invalid|not_found|consent_required|duplicate|ref_conflict|retry|server_error", "message": "...", "details": [..]?, "retry": false } ] }
```
**Queue clearing rule for the app:** remove a record from the per-user offline queue when `ok` is true. When `ok` is false and `retry` is false, keep it, show `message` and let the CHW edit it (re-send with the same clientRef after fixing). When `retry` is true, keep it and send it again later.

### `data` per kind
References to earlier records: use the server id (`householdId`, `clientId`) or the earlier record's clientRef (`householdRef`, `forClientRef`); both must be visible to this CHW.

| kind | fields |
|---|---|
| `household` | `name` (required), `address?`, `area?`, `ward?`, `lga?`, `phone?`, `members?` (1-60) |
| `client` | `firstName`, `lastName`, `consent: true` (all required), `dob?`, `sex? (female/male/other/unknown)`, `phone?`, `householdId?` or `householdRef?`, `relationship?`, `pregnant?`, `lmp?` (date), `noKnownAllergies?` |
| `visit` | `clientId` or `forClientRef`, `purpose? (routine/followup/sick/newborn/postnatal/nutrition/other)`, `dangerSigns?: [code]`, `tempC?`, `muacCm?`, `weightKg?`, `respRate?`, `notes?`, `outcome? (ok/advised/treated/referred)` |
| `immunization` | `clientId` or `forClientRef`, `vaccine` (code below), `givenOn` (date, not future, not before dob), `batchNo?`, `notes?`. Same vaccine twice for one child: `duplicate` |
| `anc` | `clientId` or `forClientRef`, `givenOn?` (default: day of recordedAt), `lmp?` (updates the client, marks pregnant), `gestWeeks?`, `bpSys?`, `bpDia?`, `weightKg?`, `fundalHeightCm?`, `dangerSigns?`, `ironFolate?`, `iptpDose?`, `llinGiven?`, `notes?`, `nextVisitOn?` |
| `referral` | `clientId` or `forClientRef`, `reason` (required), `urgency? (urgent/routine, default routine)`, `dangerSigns?` |

### Clients become patients
Same rules as front desk registration:
- New phone or no phone: a MediCore patient is created and linked to the CHW's provider (`createdVia: "chw"`), consent recorded (`channel "chw:<orgId>"`), welcome SMS if a phone was given. Result `status: "created"`, with `patientId`.
- Phone already linked to this provider: the existing patient is used (`existing: true`).
- Phone belongs to a MediCore patient elsewhere: **nothing about them is returned**. The person gets an SMS code; result `status: "link_requested"` (client `status: "pending_link"`, `patientId: null`). Then:

`POST /api/chw/clients/:id/link` `{ code }` -> `ClientView` (`status: "active"`, `patientId` set). Wrong code 400.

### Danger signs and referrals
A `visit` or `anc` with any `dangerSigns` automatically creates an **urgent referral** (returned as `referralId`, `queueId`). A `referral` record creates one with its own urgency. When the client is linked to a patient, the referral is inserted into the provider's front desk queue:
```json
{ "id": "q_..", "orgId", "patientId", "appointmentId": null, "servicePoint": "triage", "doctorMembershipId": null, "priority": "urgent|normal", "status": "waiting", "at", "source": "chw", "referralId": "cr_.." }
```
and receptionists get an in-app notification (`kind: "chw_referral"`, no clinical text). A client still `pending_link` gets a referral without a queue entry.

Danger sign codes: `convulsions, unable_to_feed, vomiting_everything, lethargic_unconscious, fast_breathing, chest_indrawing, high_fever, severe_dehydration, severe_malnutrition, bleeding, severe_headache, blurred_vision, swelling_face_hands, reduced_fetal_movement, leaking_fluid, severe_abdominal_pain, fever_pregnancy, difficulty_breathing, other` (labels from `/api/chw/schedule`).

## Reads (CHW)

| Method | Path | Response |
|---|---|---|
| GET | `/api/chw/schedule` | `{ immunization: [{ code, label, ageDays, ageMonths }], ancContactsWeeks: [12,20,26,30,34,36,38,40], dangerSigns: [{ code, label }], maxBatch: 200 }` (cache offline) |
| GET | `/api/chw/roster` | `{ households: [{ id, clientRef, name, address, area, ward, lga, members, loc, assigned, createdAt, clients: [ClientView+{lastVisitAt, assigned}] }], clientsWithoutHousehold: [..], counts: { households, clients, pendingLink } }` |
| GET | `/api/chw/clients/:id` | `ClientView + { visits: [], immunizations: [], anc: [], referrals: [], due: [DueItem] }` |
| GET | `/api/chw/due?days=30` (0-180) | `{ immunizations: [DueItem+{clientId, name, householdId}], anc: [same] }` sorted by date |
| GET | `/api/chw/referrals` | `[{ id, clientId, name, patientId, reason, urgency, dangerSigns, status: "open|queued", queueId, queueStatus, fromVisitId, createdAt }]` |

`ClientView`: `{ id, clientRef, householdId, patientId, status: "active|pending_link", firstName, lastName, name, dob, sex, pregnant, lmp, relationship, createdAt }`
`DueItem`: `{ type: "immunization|anc", code, label, dueOn, overdue, gestWeeks? }`

**Immunisation schedule (Nigeria NPI):** birth: BCG, OPV0, HEPB0; 6 weeks: PENTA1, PCV1, OPV1, ROTA1; 10 weeks: PENTA2, PCV2, OPV2, ROTA2; 14 weeks: PENTA3, PCV3, OPV3, ROTA3, IPV; 9 months: MEASLES1, YF, MENA; 15 months: MEASLES2. Shown for children under 5 until recorded.
**ANC:** WHO eight-contact model (12, 20, 26, 30, 34, 36, 38, 40 weeks from LMP); the next contact after the number already recorded, while gestation is 42 weeks or less.

## Supervisors (admin app)

| Method | Path | Perm | Body / query | Response |
|---|---|---|---|---|
| GET | `/api/chw/workers` | admin.reports or admin.staff | | `[{ membershipId, userId, name, status, households, clients }]` |
| POST | `/api/chw/assign` | admin.staff | `{ kind: "household|client", id, chwMembershipId, unassign? }` | `{ ok, id, assignedTo: [userId] }` |
| GET | `/api/chw/supervisor/summary?weeks=4` (1-26) | admin.reports or admin.staff | | `{ since, weeks, workers: [{ userId, name, weeks: [{ week (Monday date), visits, immunizations, anc, referrals, urgentReferrals, newClients }], totals: {...} }] }` |

## Demo
CHW `chw@grandville.demo` at Grandville Hospital: Okonkwo household with a pregnant mother (20 weeks, one ANC contact) and a 7-week-old baby (birth doses given, 6-week vaccines due).
