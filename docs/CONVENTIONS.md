# MediCore v2: conventions for module builders

Read this fully before writing a module. The core (auth, orgs, patients, shifts, billing, staff) is done and tested (`npm test`). Your job is a service module that plugs into it.

## The product in one paragraph

MediCore serves many kinds of provider, each running alone or together: a full hospital, a clinic with no pharmacy or ambulance, a standalone pharmacy (with its own delivery dispatcher and riders), a standalone ambulance service (dispatcher and crew), a standalone lab, and HMOs (payers). Every provider package = patient app + front desk + admin + the service modules it has switched on (`org.modules`). Patients have ONE MediCore identity linked to every provider they use (`patient_links`). A prescription written at a clinic can be filled at any pharmacy the patient chooses; a lab order can go to any lab; an SOS can go to any ambulance service. The MediCore team (product owner and developers) run HQ.

## Hard rules (these are why v1 failed its audit)

1. **Tenant scoping on every query.** Staff routes always filter by `req.ctx.org.id`. Never look up a record by id alone; use `{ id, orgId: req.ctx.org.id }` (or the right org field, e.g. `labOrgId`, `pharmacyOrgId`). A record from another provider must return 404, not 403.
2. **Patients only through links.** Before a staff user touches a patient, call `await P.requireLinked(req, patientId)` (from `./patients`). Records another provider created are visible only when `await P.sharesWith(orgId, patientId)` is true; use `P.visibleRecordFilter(req, patientId, field)` to build the filter. Patients see their own records via `req.ctx.patient.id`.
3. **Validate every input** with `body(req, schema)` / `query(req, schema)` from `../lib/http` (see `t.*` rules). It returns only the declared fields, so never spread `req.body` into a document. Use `param(req, 'id')` for path ids.
4. **Every handler is wrapped in `ah(async (req, res) => ...)`.** Throw `bad()`, `forbidden()`, `notFound()`, `conflict()` from `../lib/http`. Never let a handler crash the process.
5. **State machines with conditional updates.** Every status change is `findOneAndUpdate({ id, orgId, status: FROM }, { $set: { status: TO, ... } })` and treats `null` as "already done or wrong state" (409). This is what makes actions exactly-once (no double stock deduction, no double claims, no double billing). Define an explicit `TRANSITIONS` map per entity.
6. **Money is integer kobo, computed on the server.** Use the provider price list (`require('./orgs').service(orgId, code)`) or your own catalogue prices. Raise bills with `require('./billing').createBill({...})` and react to payment with `billing.onSettled('<your source type>', async (bill, how) => ...)`. Never mark anything paid yourself.
7. **Permissions and modules.** Guard routes with `A.requireStaff({ perm, anyPerm, module })` (from `../lib/auth`). Permissions and roles live in `src/lib/roles.js`; use the existing ones. Patient routes use `A.requirePatient`; HQ routes use `A.requirePlatform(perm)`.
8. **Clock-in.** Add `A.requireOnShift` after the staff guard on operational writes (dispense, collect sample, dispatch, advance a delivery, enter results, consult). Reads do not need it.
9. **Audit.** Call `await audit(req, 'module.action', { type, id, patientId, orgId? }, meta)` on every write and on staff views of a patient's clinical record. No names, phone numbers or clinical text in `meta`.
10. **No mutation inside GET handlers.** Serverless instances only persist what you write; a GET must not change state (no "auto-advance on read"). Time-based things are computed on read from stored timestamps. Location comes from real device GPS posts, not simulation.
11. **Notifications** via `require('../lib/notify').notify({ patientId | userId | orgId+role, title, body, kind, ref, sms? })`. SMS only when it matters (pickup ready, rider arriving, result ready). Never put clinical details in SMS.
12. **Indexes.** Declare at module load: `db.index('collection', ['field', ...], { unique })`. Use a unique index for anything that must not duplicate (e.g. one appointment per doctor slot: `slotKey`).
13. **Time.** Africa/Lagos is UTC+1, no DST. Use `lagosToUtc(date, time)` and `utcToLagos(ts)` from `../lib/util`. Store epoch ms.
14. **Ids** via `id('prefix')` from `../lib/util`. Never sequential ids in URLs (sequential human numbers like bill numbers are fine as display fields).
15. **Do not edit core files** (`src/lib/*`, `src/db/*`, `src/app.js`, `src/modules/{auth,orgs,patients,shifts,billing,staff,index}.js`, `src/seed/demo.js`, `test/helpers.js`). If you need a core change, describe it in your final report. Do not edit another builder's module. Cross-module calls use the exported functions named below, required lazily inside functions (`require('./lab')`) to avoid circular imports.

## Module shape

```js
// src/modules/<name>.js
const express = require('express');
const router = express.Router();
// ... routes under the /api prefix (the router is mounted at /api)
module.exports = { name: '<name>', router, seedDemo: async (ctx) => { /* optional demo data */ }, /* exported helpers */ };
```

`seedDemo(ctx)` runs after core demo data. `ctx.orgs.{hospital,clinic,pharmacy,ambulance,lab,hmo}`, `ctx.staff[orgKey][staffKey].{user,membership}`, `ctx.patients.{amaka,tobi,zainab,kunle}`, `ctx.users`. See `src/seed/demo.js` for the exact accounts. Demo password: `Demo2026!`.

## Cross-module contracts (agree on these exactly)

### Prescriptions (owned by clinic) to pharmacy orders (owned by pharmacy)
- `prescriptions`: `{ id, orgId (prescribing provider), patientId, encounterId, prescriberUserId, prescriberMembershipId, prescriberName, items: [{ drugCode|null, drugName, doseMg|null, doseText, frequency, durationDays, quantity, route, instructions }], safety: { alerts, blocking, overrideReason|null, checkedAt }, status: 'active'|'cancelled'|'sent', routedTo: { pharmacyOrgId, rxOrderId }|null, createdAt }`
- `frequency` keys are those in `src/clinical/safety.js` `FREQ`.
- The pharmacy module exports `async createOrderFromPrescription({ prescription, pharmacyOrgId, fulfilment: 'pickup'|'delivery', address, location, requestedBy: 'doctor'|'patient' })` returning the `rx_orders` doc. It creates the patient link at the pharmacy (`P.ensureLink`) because the patient (or their doctor, on their behalf) chose that pharmacy.
- Clinic calls it when the doctor sends to the provider's own pharmacy (only if `org.modules` has `pharmacy`). The pharmacy module owns the patient route `POST /api/me/prescriptions/:id/send { pharmacyOrgId, fulfilment, address, location }` and `GET /api/me/prescriptions` (prescriptions with their order status).
- Safety: `require('../clinical/safety').check({ patient, items, currentMeds, pregnant })`. Blocking alerts need `overrideReason`. The pharmacist re-runs the check at verification.

### Lab orders (owned by lab)
- The lab module exports `async createLabOrder({ referringOrgId, labOrgId|null, patientId, tests: [{ code }], orderedByUserId, orderedByName, encounterId, priority: 'routine'|'urgent', clinicalNote })` returning the `lab_orders` doc. With `labOrgId` null the order waits (`status: 'awaiting_lab'`) for the patient to choose a lab via `POST /api/me/lab-orders/:id/send { labOrgId }` (lab module route). Test codes come from `src/clinical/labtests.js`.
- Results released by the lab are readable by the patient, by the referring provider (always, it asked for them) and by other linked providers only when sharing is on.
- Lab exports `async resultsForPatient(req, patientId)` for the doctor chart.

### Encounters, vitals, queue (owned by clinic)
- `vitals`: `{ id, orgId, patientId, at, by, bpSys, bpDia, pulse, tempC, spo2, rr, weightKg, heightCm, glucose }` recorded at front desk (`vitals.record`) or by a doctor.
- `queue` (front desk check-in): `{ id, orgId, patientId, appointmentId|null, servicePoint: 'doctor'|'pharmacy'|'lab'|'cashier'|'triage', doctorMembershipId|null, priority, status: 'waiting'|'called'|'in_service'|'done'|'left', at }`.

### Ambulance incidents (owned by ambulance)
- Patient SOS `POST /api/me/emergency` picks the nearest active ambulance provider with an available unit (or a provider the patient names). Public `POST /api/emergency` (no login) is rate-limited and marked unverified.
- Destination hospital pre-alert: if the destination is a MediCore provider, `notify({ orgId, role: 'receptionist' ... })` and the provider's front desk sees incoming cases at `GET /api/fd/incoming`.

### HMO (owned by payer)
- `coverages`: `{ id, patientId, payerOrgId, memberNo, planName, status: 'pending'|'active'|'suspended'|'ended', limits: { [category]: kobo }, usedKobo: { [category]: kobo }, validTo }`.
- Every provider (module `hmo`, always on) can check cover for a linked patient and request pre-authorisation; payer staff see only their HMO. Claims come from bills with `bill.hmo` set via `billing.setHmoCover(billId, {...})`. Claim transitions are one-way. Fraud flags: duplicate service, no matching completed service record, over limit, frequency.

## Testing

- Put tests in `test/<module>.test.js` using `const { boot } = require('./helpers')`. `h.as(app, email)` returns a signed-in, clocked-in client. Run with `node --test --test-concurrency=1 test/<module>.test.js`.
- Write tests for: the happy path end to end, cross-provider isolation (another provider gets 404), every state transition being exactly-once (send the same action twice, in parallel too), validation rejects bad input, and permissions (wrong role gets 403).
- `npm test` must stay green for all files, including core.

## API documentation

Write `docs/api/<module>.md`: one table of endpoints (method, path, app/role, body, response) plus the state machine. The front-end builders work only from these docs, so be exact about request and response shapes.
