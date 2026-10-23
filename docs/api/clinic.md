# Clinic module API (doctors, consultations, front desk)

Source: `src/modules/clinic.js` and `src/modules/clinic/*.js`. ICD-10 list: `src/clinical/icd10.js`.
Tests: `test/clinic.test.js`.

This document is the contract for the **doctor app**, the **patient app** (booking, visits, video, messages) and the **front desk app** (appointments, queue, vitals, customer care). It also covers two admin screens (doctor schedules, consultation revenue).

## 1. Conventions used everywhere

- Every path below is under `/api`. Send `X-MC-App: <app>` on **every** request (`patient`, `doctor`, `frontdesk`, `admin`). POST/PUT/PATCH without it get `403 {code:'csrf'}`. Session cookies are per app.
- JSON in, JSON out. Unknown body fields are ignored. You can never set prices, status, names, `orgId` or ids yourself.
- **Money** is integer **kobo** (NGN 1 = 100 kobo). Show `feeKobo / 100`.
- **Time**: Africa/Lagos (UTC+1, no DST). `date` = `'YYYY-MM-DD'` (Lagos), `time` = `'HH:MM'` (Lagos, 24h). Timestamps (`...At`, `startUtc`, `endUtc`, `at`) are epoch **milliseconds** (UTC).
- **Ids** are opaque strings (`apt_...`, `enc_...`, `rx_...`). Never parse them.
- **Errors**: `{ error: string (show to the user), code: string, details?: any }`.
  - `400 bad_request`: validation; `details` = `[{ field, error }]`.
  - `401 unauthorized` / `expired` etc.: sign in again. `423 clock_in_required`: the staff member must clock in (`POST /api/shift/clock-in`). `423 password_change_required`.
  - `403 forbidden`: your role cannot do this (or the record belongs to another doctor at your own provider).
  - `404 not_found`: does not exist **or belongs to another provider** (never reveals which).
  - `409`: wrong state / already done (`wrong_state`), or a specific code listed per endpoint.
  - `402 payment_required`: video visit not paid. `429 rate_limited`. `503`: integration not ready (see lab orders).
- **Clock-in**: routes marked **shift** need the staff member to be clocked in (doctors, receptionists, nurses ...). Reads never do.
- Staff routes are always scoped to the signed-in provider (`org`). Patients must be **linked** to the provider before staff can touch them (`/api/fd/patients/...` core routes do registration and linking).
- GET never changes anything. Mark-as-read is an explicit POST.
- **Tunable values** come from the settings layer (HQ, with per-provider overrides); the numbers in this document are the defaults: `process.appointments.patientCancelHours` (2), `defaultSlotMinutes` (20, used on a doctor's first schedule save), `videoJoinEarlyMinutes` (15), `videoJoinLateMinutes` (60), `payBeforeVideo` (true). Feature flags: `videoVisits` (off = video hidden from the directory, video bookings `400 video_disabled`, video calls `403 feature_off`) and `marketplace` (off = the directory only shows the caller's own linked providers). Use `canCancel`, `canJoinVideo` and `videoWindow` from the API rather than hard-coding these numbers.

### Roles and permissions used here

| Permission | Default roles |
|---|---|
| `clinic.consult`, `clinic.prescribe`, `clinic.order_lab` | doctor |
| `queue.manage` | receptionist, nurse, frontdesk_manager |
| `vitals.record` | nurse, records, frontdesk_manager, doctor |
| `care.manage` | care, frontdesk_manager |
| `patient.register` | receptionist, records, frontdesk_manager |
| `admin.settings` (schedules), `admin.finance` (revenue) | owner, admin |

Doctor routes also need the provider's `clinic` module switched on.

---

## 2. Object shapes

### DoctorProfile
```
{
  membershipId: string,         // the doctor's id for booking (one per provider they work at)
  name: string,                 // "Dr. Tunde Bello"
  orgId, orgName, orgArea: string|null,
  specialty: string|null, bio: string|null, languages: string[],
  types: ('in_person'|'video')[],
  slotMin: 10|15|20|30|45|60,
  weekly: [{ dow: 0-6 (0=Sunday), start: 'HH:MM', end: 'HH:MM' }],
  feeKobo: int|null,            // in-person fee; null if in-person not offered
  videoFeeKobo: int|null,       // video fee; null if video not offered
  acceptingBookings: boolean
}
```
`orgArea` is only on the directory/profile endpoints. Schedule endpoints add `configured: true`.
Fee rule: the schedule's own fee, else the provider price list (`CONS-GP` in person, `VIDEO-GP` video).

### Slot
`{ time: 'HH:MM', startUtc, endUtc, available: boolean }`. Unavailable = booked (by this doctor at any provider), in the past (or within 5 minutes), or bookings paused.

### Appointment
Common fields (`AppointmentBase`):
```
{
  id, orgId, doctorMembershipId, doctorName, specialty: string|null,
  date: 'YYYY-MM-DD', time: 'HH:MM', startUtc, endUtc, durationMin,
  type: 'in_person'|'video', reason: string|null,
  status: 'booked'|'checked_in'|'in_consult'|'completed'|'cancelled'|'no_show',
  feeKobo, billId: string|null, paid: boolean, refundDue: boolean,
  videoWindow: null | { opensAt, closesAt, open: boolean },   // video only: start-15min .. start+60min
  encounterId: string|null, createdAt,
  cancelledAt: ms|null, cancelledBy: 'patient'|'provider'|'system'|null, cancelReason: string|null
}
```
- **Patient view** (`/me/...`) adds: `orgName`, `canCancel: boolean` (status `booked` and more than 2 hours before start), `canJoinVideo: boolean` (video, active, paid, window open now).
- **Staff view** (`/fd/...`, `/doc/...`) adds: `patientId`, `patient: { id, name, mrn, age, sex, phone }`, `bookedBy: 'patient'|'staff'`, `checkedInAt`, `startedAt`, `completedAt`, `noShowAt`, `queueId` (all `ms|null`/`string|null`).

Payment: the appointment's bill (`billId`) is a normal MediCore bill. Patients pay it with the core billing routes (`POST /api/me/bills/:billId/pay`, then Paystack or, in demo mode, `POST /api/pay/demo/:paymentId/complete`); the cashier can take cash/POS (`POST /api/bills/:billId/cash`). `paid` becomes `true` automatically when the bill is settled. In-person visits can be paid at the front desk at any time; **video visits must be paid before the room opens**.

### QueueItem
```
{
  id, number: 'D-007',                 // ticket: D doctor, P pharmacy, L lab, C cashier, T triage; resets daily
  patientId, patient: { name, mrn, age, sex },
  appointmentId: string|null,
  servicePoint: 'doctor'|'pharmacy'|'lab'|'cashier'|'triage',
  doctorMembershipId: string|null, doctorName: string|null,
  priority: 'emergency'|'urgent'|'routine',
  status: 'waiting'|'called'|'in_service'|'done'|'left',
  complaint: string|null,
  at, calledAt, startedAt, doneAt, leftAt,   // ms|null
  encounterId: string|null,                  // set when a doctor starts a consultation from it
  waitMin: int,                              // minutes waited (until start, or until now if still waiting)
  latestVitals: Vitals|null                  // most recent vitals at this provider in the 12h before check-in or since
}
```
Lists are sorted: active first, then priority (emergency, urgent, routine), then arrival.

### Vitals
```
{
  id, orgId, patientId, at, by (userId), byName, queueId|null, encounterId|null,
  bpSys, bpDia, pulse, tempC, spo2, rr, weightKg, heightCm, glucose,   // number|null each
  bmi: number|null,                                                    // when weight and height given
  flags: [{ field: 'bp'|'pulse'|'tempC'|'spo2'|'rr'|'glucose', level: 'low'|'high'|'critical', message }],
  suggestedPriority: 'emergency'|'urgent'|'routine'
}
```
Accepted ranges (outside = 400): bpSys 50-260, bpDia 30-160 (must be below bpSys, both or neither), pulse 20-250, tempC 30-45, spo2 50-100, rr 4-80, weightKg 0.3-400, heightCm 20-250, glucose 0.5-40 mmol/L. bpSys, bpDia, pulse, spo2, rr are whole numbers.

### Encounter (consultation)
```
{
  id, orgId, patientId, appointmentId|null, queueId|null,
  doctorMembershipId, doctorName, type: 'in_person'|'video'|'walk_in',
  status: 'open'|'completed', startedAt, completedAt|null, updatedAt,
  notes: { complaint, history, examination, assessment, plan },   // string|null each (SOAP)
  diagnoses: [{ code: 'I10', text: 'Essential (primary) hypertension', primary: boolean }],
  followUp: null | { date: 'YYYY-MM-DD'|null, note: string|null },
  labOrderIds: string[]
}
```

### Prescription
```
{
  id, orgId, patientId, encounterId, prescriberMembershipId, prescriberName,
  items: [{ drugCode: string|null, drugName, doseMg: number|null, doseText, frequency, durationDays, quantity, route, instructions: string|null }],
  safety: { alerts: Alert[], blocking: boolean, overrideReason: string|null, checkedAt },
  status: 'active'|'sent'|'cancelled',
  routedTo: null | { pharmacyOrgId, rxOrderId },
  sendTo: 'internal'|'patient_choice', createdAt, cancelledAt|null, cancelReason|null
}
Alert = { level: 'contraindicated'|'major'|'moderate'|'info', type: 'allergy'|'interaction'|'duplicate'|'dose'|'pregnancy'|'paediatric'|'elderly'|'controlled'|'unlisted'|'allergy_unknown'|'quantity'|'duration', drug: string|null, message: string }
```
`contraindicated` and `major` alerts are **blocking**.
`frequency` is one of: `stat od nocte mane bd tds qds q4h q6h q8h q12h weekly prn` (labels from `GET /api/clinical/frequencies`).
`route` is one of: `oral iv im sc topical inhaled rectal vaginal sublingual ophthalmic otic nasal other` (default `oral`).

### Thread and Message
```
Thread  = { id, orgId, orgName, patientId, patientName, doctorMembershipId|null, doctorName|null, subject,
            status: 'open'|'closed', createdAt, lastAt, lastFrom: 'patient'|'staff'|null, lastPreview: string|null,
            unread: int }          // unread for the side asking (patient or provider)
Message = { id, threadId, seq: int (1,2,3... per thread), from: 'patient'|'staff', senderName, senderRole: string|null, text, at }
```
`senderName` and `from` always come from the server. `text` is plain text: **render it as text, never as HTML**.

### CareCase
```
{ id, number: 'CC-00012', orgId, patientId|null, patientName|null,
  channel: 'phone'|'walk_in'|'whatsapp'|'email'|'app'|'sms'|'social'|'other',
  category: 'enquiry'|'complaint'|'billing'|'appointment'|'results'|'prescription'|'feedback'|'other',
  priority: 'low'|'normal'|'high', subject, status: 'open'|'pending'|'resolved',
  notes: [{ id, at, byUserId, byName, text }], createdAt, createdByName, updatedAt, resolvedAt|null }
```

---

## 3. State machines

All status changes are conditional (exactly once). A repeated or late action gets `409` (`code: 'wrong_state'` unless stated).

**Appointment**
```
booked ──> checked_in ──> in_consult ──> completed
  │  │          │
  │  │          └──> cancelled
  │  ├──> in_consult          (doctor starts directly, e.g. video, or patient not checked in)
  │  ├──> cancelled
  │  └──> no_show             (staff, only after the start time)
```
- `booked -> checked_in`: front desk `POST /fd/queue` with `appointmentId`.
- `booked|checked_in -> in_consult`: doctor `POST /doc/encounters` (video needs a paid bill).
- `in_consult -> completed`: doctor `POST /doc/encounters/:id/complete`.
- `-> cancelled`: patient (only `booked`, more than 2 h before start) or front desk (`booked`/`checked_in`, any time). Cancelling frees the slot, voids an unpaid bill, or sets `refundDue: true` and alerts the cashier if it was paid (refund itself: core `POST /api/bills/:id/refund-request`).

**Queue item**
```
waiting ──> called ──> in_service ──> done
   │  │        │
   │  │        └──> left
   │  └──> in_service
   └──> left
```

**Encounter**: `open -> completed` (completing also moves the appointment `in_consult -> completed` and the queue item `in_service -> done`). Only the doctor who started it can change it, only while `open`.

**Care case**: `open <-> pending`, `open|pending -> resolved`, `resolved -> open` (reopen).

**Thread**: `open <-> closed` (staff only). Nobody can post to a closed thread (`409`).

**Prescription** (clinic side): created `active`; `active -> sent` when routed to a pharmacy (by the doctor here, or by the patient through the pharmacy module's `POST /api/me/prescriptions/:id/send`); `active -> cancelled` by the prescriber only while not sent.

---

## 4. Endpoints

### 4.1 Doctor directory and slots (public; patient app)

| Method | Path | Who | Query / body | Response |
|---|---|---|---|---|
| GET | `/doctors` | anyone | `?orgId=&specialty=&q=&type=in_person\|video&limit=1-200` | `DoctorProfile[]` (with `orgArea`), sorted by name. Only active providers with the clinic module and the marketplace setting on (plus the caller's own linked providers), doctors with `acceptingBookings: true`. `specialty` and `q` are case-insensitive "contains" (q matches name, specialty, provider name). |
| GET | `/doctors/:membershipId` | anyone | | `DoctorProfile` (with `orgArea`). 404 if not listed. |
| GET | `/doctors/:membershipId/slots` | anyone | `?date=YYYY-MM-DD` (required) | `{ membershipId, date, slotMin, types, acceptingBookings, slots: Slot[] }`. Dates before today or more than 60 days ahead return `slots: []`. A day the doctor does not work returns `slots: []`. |

### 4.2 Schedules (doctor app, admin app)

`ScheduleBody` (all optional; send only what changes):
```
{ weekly: [{ dow: 0-6, start: 'HH:MM', end: 'HH:MM' }] (max 28; replaces the whole list; windows on one day must not overlap),
  slotMin: 10|15|20|30|45|60, feeKobo: int 0..100000000, videoFeeKobo: int 0..100000000,
  types: ['in_person'] | ['video'] | ['in_person','video'],
  acceptingBookings: boolean, specialty: string<=80, bio: string<=1000, languages: string[] (max 8, each <=30) }
```
First save defaults: `slotMin 20`, both types, fees from the price list, `acceptingBookings` true if `weekly` was sent, specialty "General practice", languages ["English"].

| Method | Path | Who | Body | Response |
|---|---|---|---|---|
| GET | `/doc/schedule` | doctor | | `DoctorProfile & {configured:true}` or `{ configured:false, membershipId, name, orgId, weekly:[], types:[], acceptingBookings:false }` |
| PUT | `/doc/schedule` | doctor | `ScheduleBody` | `DoctorProfile & {configured:true}` |
| GET | `/admin/doctors` | `admin.settings`/`admin.staff`/`admin.finance` | | array of the same shapes, one per doctor at the provider |
| PUT | `/admin/doctors/:membershipId/schedule` | `admin.settings` | `ScheduleBody` | `DoctorProfile & {configured:true}`; 404 if not a doctor at this provider |

### 4.3 Appointments

`BookBody = { doctorMembershipId (required), date (required), time (required, a slot time), type: 'in_person'|'video' (required), reason?: string<=300 }`

Booking errors: `404` doctor not found/not bookable; `409 not_accepting`; `400 video_disabled`; `400 type_not_offered`; `409 no_fee`; `400 too_far_ahead` (>60 days); `400 outside_schedule` (not one of the doctor's slot times that day); `400 slot_in_past`; `409 slot_taken` (also for two bookings racing for one slot: exactly one wins); `409 patient_busy` (the patient already has an overlapping appointment). Booking links the patient to the provider and raises a bill.

**Patient app**

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/me/appointments` | `BookBody` | Appointment (patient view). Rate limit 20 per hour. |
| GET | `/me/appointments` | `?scope=upcoming\|past\|all&limit=` (`upcoming`: active and not ended more than 60 min ago, soonest first; others newest first) | Appointment[] (patient view) |
| GET | `/me/appointments/:id` | | Appointment (patient view) |
| POST | `/me/appointments/:id/cancel` | `{ reason?: string<=300 }` | Appointment (patient view). `409 too_late_to_cancel` within 2 h of start; `409 wrong_state` if not `booked`. |

**Front desk app** (read: `queue.manage`/`patient.register`/`billing.create`/`billing.cash`; write: `queue.manage`/`patient.register`)

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/fd/appointments` (shift) | `BookBody & { patientId }` (patient must be linked; doctor must be at this provider) | Appointment (staff view). Patient is notified. |
| GET | `/fd/appointments` | `?date=` (default today) `&doctorMembershipId=&status=` or `?patientId=` (all of that patient's appointments here) | Appointment[] (staff view), by start time |
| GET | `/fd/appointments/:id` | | Appointment (staff view) |
| POST | `/fd/appointments/:id/cancel` | `{ reason: string 3..300 }` | Appointment (staff view) |
| POST | `/fd/appointments/:id/no-show` | | Appointment (staff view). `409 too_early` before the start time. Only from `booked`. |

Check-in is `POST /fd/queue` with `appointmentId` (4.4).

**Doctor app**

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/doc/appointments` | `?date=` (default today) or `?scope=upcoming`; `&status=` | Appointment[] (staff view), only the signed-in doctor's |
| GET | `/doc/appointments/:id` | | Appointment (staff view); 404 if not this doctor's |

### 4.4 Front desk queue, vitals, care (front desk app; doctors use the queue too)

| Method | Path | Who | Body / query | Response |
|---|---|---|---|---|
| POST | `/fd/queue` (shift) | `queue.manage` | `{ patientId (required, linked), servicePoint (required), appointmentId?, doctorMembershipId?, priority?: 'emergency'\|'urgent'\|'routine' (default routine), complaint?: string<=300 }` | QueueItem. With `appointmentId`: servicePoint must be `doctor`, the appointment moves `booked -> checked_in`, the doctor defaults to the appointment's. `doctorMembershipId` only for `doctor` and must be a doctor at this provider (else 404). `409 already_queued` if the patient is already active at that service point. The doctor is notified. |
| GET | `/fd/queue` | any front-desk/clinical staff | `?servicePoint=&status=active (default)\|today\|waiting\|called\|in_service\|done\|left&doctorMembershipId=&mine=true` (`mine`: items for me or for no particular doctor) | QueueItem[] |
| POST | `/fd/queue/:id/call` (shift) | `queue.manage`, doctor, nurse, cashier, pharmacy, lab | | QueueItem (`-> called`; patient gets an in-app "your turn"). |
| POST | `/fd/queue/:id/start` (shift) | same | | QueueItem (`-> in_service`) |
| POST | `/fd/queue/:id/done` (shift) | same | | QueueItem (`-> done`) |
| POST | `/fd/queue/:id/left` (shift) | same | | QueueItem (`-> left`) |
| POST | `/fd/queue/:id/triage` (shift) | `queue.manage`/`vitals.record` | `{ priority (required) }` | QueueItem (active items only) |
| POST | `/fd/vitals` (shift) | `vitals.record` | `{ patientId (required, linked), queueId?, bpSys?, bpDia?, pulse?, tempC?, spo2?, rr?, weightKg?, heightCm?, glucose? }` (at least one value) | Vitals. With `queueId`, the queue priority is raised (never lowered) to `suggestedPriority`. `weightKg` also updates the patient's weight. |
| GET | `/fd/patients/:id/vitals` | `vitals.record`/`clinic.consult`/`queue.manage`/`patient.read` | `?limit=1-200` (default 50) | Vitals[] newest first (this provider's, plus other providers' when the patient shares with you) |

For the doctor service point, a doctor (without `queue.manage`) can move only items assigned to them or to no doctor; calling or starting an unassigned item assigns it to them. To consult, doctors use `POST /doc/encounters { queueId }` (4.5), which also moves the item to `in_service`.

Customer care (`care.manage`):

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/fd/care-cases` | `{ channel (required), subject (required, 3..160), patientId? (linked), category? (default enquiry), priority?: low\|normal\|high (default normal), note?: string<=2000 }` | CareCase |
| GET | `/fd/care-cases` | `?status=&patientId=&limit=` | CareCase[] newest activity first |
| GET | `/fd/care-cases/:id` | | CareCase |
| POST | `/fd/care-cases/:id/notes` | `{ text (required, <=2000) }` | CareCase |
| POST | `/fd/care-cases/:id/status` | `{ status: 'open'\|'pending'\|'resolved' }` | CareCase |

### 4.5 Consultations (doctor app; `clinic.consult` unless noted)

`EncounterBody` (all optional):
```
{ notes: { complaint?, history?, examination?, assessment?, plan? }   // each string <=5000; only sent fields change
  diagnoses: [{ code: 'B50.9', text?: string<=200, primary?: boolean }]  // max 20; REPLACES the list. text defaults from the ICD-10 list;
                                                                         // a valid code not in the list needs text. One primary (first if none flagged).
  followUp: { date?: 'YYYY-MM-DD', note?: string<=300 } }
```

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/doc/encounters` (shift) | `{ appointmentId? , queueId? }` (one required) | `Encounter & { patient: { id, name, mrn, age, sex, phone } }`. Must be the appointment's doctor / the queue item's doctor or an unassigned doctor item (else 403); other provider: 404. Exactly once: a second start gets 409. Video appointment unpaid: `402 payment_required`. `notes.complaint` is prefilled from the queue complaint or appointment reason. |
| GET | `/doc/encounters` | `?status=open\|completed&date=&limit=` | `(Encounter & {patient})[]`, the signed-in doctor's, newest first |
| GET | `/doc/encounters/:id` | | `Encounter & { patient, prescriptions: Prescription[], vitals: Vitals[], own: boolean }` (any doctor at this provider can read; audited) |
| PATCH | `/doc/encounters/:id` (shift) | `EncounterBody` | Encounter. Author only, open only. |
| POST | `/doc/encounters/:id/vitals` (shift) | vitals fields as `/fd/vitals` (no patientId) | Vitals |
| POST | `/doc/encounters/:id/complete` (shift) | `EncounterBody` (applied first) | Encounter (`completed`). Needs at least one diagnosis or an assessment (400). Second call: 409. Patient is notified that the summary is ready. |
| GET | `/doc/patients/:id/chart` | | see below (audited) |

Chart response:
```
{ patient: { id, mrn, firstName, lastName, name, dob, age, sex, phone, email, address, homeLoc, bloodGroup, genotype,
             allergies, conditions, weightKg, nokName, nokPhone, claimed, shareHistory, linkedAt },
  sharing: { shareHistory: boolean, note: string },
  allergies: [{ substance, class, reaction, severity, source, at }], noKnownAllergies: boolean,
  conditions: [{ name, code, at, orgId? }],
  currentMedicines: [{ drugCode, drugName, prescriptionId, orgId, at }],   // active/sent prescriptions, last 90 days
  vitals: Vitals[] (50 newest),
  encounters: (Encounter & { orgName, own: boolean })[] (100 newest),
  prescriptions: (Prescription & { orgName })[] (100 newest),
  labResults: [...],        // from the lab module's resultsForPatient (its report shape); [] if unavailable
  appointments: AppointmentBase[] (20 newest at this provider) }
```
Records from other providers appear **only** when the patient has switched sharing on for your provider (`sharing.shareHistory`); otherwise only your provider's records are listed. To add a chronic condition or allergy to the patient record use core `PATCH /api/fd/patients/:id { addConditions, addAllergies }`.

### 4.6 Prescribing (`clinic.prescribe`)

`Item = { drugCode?: string (formulary code), drugName?: string<=120 (required if no code), doseMg?: number, doseText: string<=80 (required, e.g. "1 tablet"), frequency (required), durationDays: 1..365 (required), quantity: 1..10000 (required), route?, instructions?: string<=300 }`

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/doc/safety-check` | `{ patientId, items: Item[1..20], pregnant?: boolean }` | `{ alerts: Alert[], blocking: boolean, currentMeds: [{ drugCode, drugName, prescriptionId }] }` (dry run, nothing stored) |
| POST | `/doc/encounters/:id/prescriptions` (shift) | `{ items: Item[1..20], sendTo: 'internal'\|'patient_choice', overrideReason?: string 10..500, pregnant?: boolean, fulfilment?: 'pickup'\|'delivery' (internal only, default pickup) }` | `{ prescription: Prescription, safety: { alerts, blocking }, routing: { sentTo: orgId\|null, rxOrderId: string\|null, reason: null\|'no_internal_pharmacy'\|'pharmacy_module_not_ready'\|'pharmacy_error', error?: string } }` |
| POST | `/doc/prescriptions/:id/cancel` (shift) | `{ reason: string 3..300 }` | Prescription (prescriber only; only if not yet sent) |

Prescribing rules:
- Only on an **open** encounter you started.
- The check runs against the patient's allergies, age, weight, `pregnant`, and **current medicines** (their active/sent prescriptions from the last 90 days that your provider may see).
- If any alert is blocking and there is no `overrideReason`: **`409`** with
  `{ error, code: 'safety_alerts', details: { alerts: Alert[], blocking: true } }`. Nothing is stored. Show the alerts; let the doctor change the items or enter a reason (10+ characters) and resend. The reason is stored with the prescription and shown to the pharmacist.
- `sendTo: 'internal'` sends it to your provider's own pharmacy when the provider has the pharmacy module; otherwise (`routing.reason`) the prescription stays `active` and the patient chooses a pharmacy in the app (pharmacy module: `GET /api/me/prescriptions`, `POST /api/me/prescriptions/:id/send`).
- Unknown `drugCode` is 400. A drug given only by name that is not in the formulary gets an `unlisted` alert.

### 4.7 Lab orders (`clinic.order_lab`)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/doc/encounters/:id/lab-orders` (shift) | `{ tests: [{ code }] (1..30, codes from GET /clinical/labtests), sendTo: 'internal'\|'patient_choice', priority?: 'routine'\|'urgent' (default routine), clinicalNote?: string<=500 }` | `{ order: <lab_orders doc from the lab module>, routedInternally: boolean, note: string\|null }` |

Unknown codes: 400 listing them. `internal` goes to your own lab if the provider has the lab module; otherwise the order waits (`status: 'awaiting_lab'`) for the patient to pick a lab (lab module route `POST /api/me/lab-orders/:id/send`). If the lab module is not available: `503 { code: 'lab_module_not_ready' }`. Errors raised by the lab module (for example a test the lab does not offer) are passed through.

### 4.8 Clinical reference (any signed-in staff)

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/clinical/drugs` | `?q=&limit=1-100` (name, code or class contains) | `[{ code, name, classes, unitMg, maxDailyMg, controlled, pregnancy }]` |
| GET | `/clinical/frequencies` | | `[{ key: 'bd', label: 'twice daily', perDay: 2 }]` (`perDay` null for prn) |
| GET | `/clinical/icd10` | `?q=&limit=1-100` (code prefix, text or plain-language alias like "high bp", "pile") | `[{ code, text, group }]` best match first |
| GET | `/clinical/labtests` | `?q=&limit=1-200` | `[{ code, name, specimen, unit, panel: string[]\|null, tatHours }]` |

### 4.9 Patient visit summaries (patient app)

| Method | Path | Response |
|---|---|---|
| GET | `/me/encounters` | `[{ id, orgId, orgName, doctorName, type, date, startedAt, completedAt, complaint, diagnoses: [{code, text, primary}], plan, followUp, prescriptionCount, labOrderCount }]` completed consultations, newest first. (Prescriptions themselves: pharmacy module `GET /api/me/prescriptions`.) |

### 4.10 Messages

Text: required, max 2000 characters, plain text (control characters and anything that looks like an HTML tag are removed). Rate limits: patients 60 messages/hour, staff 200/hour.

**Patient app**

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/me/threads` | `{ orgId (a provider you are linked to, else 404), subject (2..120), text, doctorMembershipId? (a doctor there) }` | `{ thread: Thread, message: Message }` |
| GET | `/me/threads` | | `{ threads: Thread[] (latest activity first), unreadTotal: int }` |
| GET | `/me/threads/:id/messages` | `?after=<seq>` (poll for new ones) | `{ thread: Thread, messages: Message[] (by seq, max 500) }` |
| POST | `/me/threads/:id/messages` | `{ text }` | `{ thread, message }`; `409` if the thread is closed |
| POST | `/me/threads/:id/read` | | Thread (`unread: 0`) |

**Doctor and front desk apps** (`clinic.consult` or `care.manage`; doctors without `care.manage` see threads addressed to them or to no particular doctor; care staff see all of the provider's threads)

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/msg/threads` | `?status=open\|closed&patientId=&mine=true&limit=` | `{ threads: Thread[], unreadTotal }` |
| POST | `/msg/threads` | `{ patientId (linked), subject, text, doctorMembershipId? }` (a doctor starting a thread is attached automatically) | `{ thread, message }` |
| GET | `/msg/threads/:id/messages` | `?after=<seq>` | `{ thread, messages }` (audited) |
| POST | `/msg/threads/:id/messages` | `{ text }` | `{ thread, message }` |
| POST | `/msg/threads/:id/read` | | Thread |
| POST | `/msg/threads/:id/close` | | Thread (`closed`) |
| POST | `/msg/threads/:id/reopen` | | Thread (`open`) |

Notifications (no message content): patient message -> the addressed doctor (or the provider's `care` role); staff reply -> the patient.

### 4.11 Video visits (patient app and doctor app)

All three calls check, in this order: signed in; you are the appointment's **patient** (patient app) or its **assigned doctor** (doctor app, at that provider), otherwise `404`; front desk and other staff `403`; video visits switched off `403 feature_off`; `type` is video (`409 not_video`); status is `booked`/`checked_in`/`in_consult` (`409 visit_closed`); the bill is paid when `payBeforeVideo` is on (`402 payment_required`, `details: { billId }`); now is between start-15 min and start+60 min (`409 too_early` / `409 window_closed`, `details: { opensAt, closesAt }`).

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/video/:appointmentId/join` (doctor: shift) | | `{ appointmentId, role: 'caller'\|'callee', side: 'doctor'\|'patient', peerName, iceServers: RTCIceServer[], opensAt, closesAt, lastSeq: int, pollMs: 1500 }` |
| POST | `/video/:appointmentId/signal` (doctor: shift) | `{ type: 'offer'\|'answer'\|'ice'\|'bye', data: any JSON (max 16 KB) }` | `{ ok: true, seq }` |
| GET | `/video/:appointmentId/signals` | `?after=<seq>` | `{ signals: [{ seq, from: 'doctor'\|'patient', type, data, at }] (only the OTHER side's, by seq, max 200), lastSeq }` |

`iceServers` = `[{ urls: 'stun:stun.l.google.com:19302' }]` plus `{ urls: [...], username, credential }` when TURN is configured (HQ `integrations.turn`, else env `TURN_URL`/`TURN_USER`/`TURN_PASS`). Rate limit: 900 signals per 10 minutes per person per visit.

Client flow:
1. Both sides call `join`. Keep `after = lastSeq` from `join` if you want to skip old signals after a reconnect (or `0` to replay).
2. The **doctor (caller)** creates the `RTCPeerConnection` with `iceServers`, makes an offer, posts `{type:'offer', data: pc.localDescription}`, and posts each ICE candidate as `{type:'ice', data: candidate.toJSON()}`.
3. The **patient (callee)** polls `GET signals?after=` every `pollMs`; on `offer` sets the remote description, answers with `{type:'answer', data: pc.localDescription}`, and posts its own ICE candidates.
4. The doctor polls too and applies the `answer` and ICE candidates. Either side posts `{type:'bye'}` when hanging up.
5. The doctor opens the consultation record with `POST /doc/encounters { appointmentId }` (moves the appointment to `in_consult`) and completes it as usual.

### 4.12 Earnings and revenue (read only)

`?from=YYYY-MM-DD&to=YYYY-MM-DD` (default: the last 30 days to today, by appointment date).

| Method | Path | Who | Response |
|---|---|---|---|
| GET | `/doc/earnings` | doctor | `{ from, to, completed, paidCount, unpaidCount, paidKobo, hmoKobo, byType: { in_person: {count, paidKobo}, video: {count, paidKobo} }, items: [{ appointmentId, date, time, type, feeKobo, paid, amountKobo, billId }] (200 newest), payouts: { available: false, note } }` |
| GET | `/admin/clinic/revenue` | `admin.finance` | `{ from, to, doctors: [{ doctorMembershipId, doctorName, completed, paidCount, unpaidCount, paidKobo, hmoKobo, byType }] (highest paidKobo first), totals: {same summary}, payouts: { available: false, note } }` |

Counts completed appointments at this provider; `paidKobo` is the bill total of those whose bill is paid (including any HMO-covered part, shown separately in `hmoKobo`). **Payouts are not done through MediCore**: automatic doctor payouts need Paystack Transfers on a live Paystack account and each doctor's verified bank details.

---

## 5. Demo data (DEMO_MODE)

- Schedules, 20-minute slots, 09:00-17:00: Dr. Tunde Bello (Grandville Hospital, Mon-Sat, General practice), Dr. Bisi Adewale (hospital Mon/Wed/Fri, clinic Tue/Thu/Sat, Internal medicine), Dr. Ada Nwosu (Lekki Family Clinic, Mon-Sat). Fees from the price lists: hospital NGN 8,000 in person / NGN 6,000 video; clinic NGN 10,000 / NGN 7,000.
- Amaka Eze at the hospital: two completed, paid visits with Dr. Tunde (about 75 and 20 days ago, diagnosis I10), vitals history, an active amlodipine 5 mg prescription, an upcoming in-person appointment on the next working day at 10:00 (bill open), and a message thread with Dr. Tunde ("Amlodipine and ankle swelling", one unread reply).
- Kunle Martins at the clinic: a completed visit with Dr. Ada (I48) and an active warfarin 5 mg prescription, so aspirin or ibuprofen for him is flagged.
- Amaka shares her history with the hospital only, so Dr. Ada at the clinic sees only clinic records for her.
