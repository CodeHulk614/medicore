# Patient mode and patient applications (`src/modules/patients.js`)

`process.patients.mode` (HQ > Processes, overridable per provider):

- **provider** (default): a patient belongs to the providers that registered them, approved their application, or accepted a referral. The patient app shows **one provider at a time** (a hospital group counts as one provider with all its branches) with a switcher. No platform-wide search; booking, ordering medicines and lab requests only with the patient's providers (and pharmacies/labs their provider partners with, for sending a prescription or lab order). No record sharing between providers except through a referral.
- **open**: the earlier marketplace: platform-wide directory and booking, patient-controlled record sharing (needs the PCN aggregator registration before pharmacies are opened to everyone).

Other settings: `allowMultipleProviders` (default true), `applicationsNeedApproval` (default true), `crossProviderSharing` (default false; only matters in provider mode), `applicationExpiryDays` (30). The app reads them from `GET /api/meta/config` -> `patients: { mode, allowMultipleProviders, crossProviderSharing }`.

## Choosing the provider in the patient app
Send header **`X-MC-Provider: <key>`** on patient API calls, where `key` is a provider key from the summary below (an org id, or a group id). Lists (`/me/appointments`, `/me/bills`, `/me/prescriptions`, `/me/rx-orders`, `/me/lab-orders`, `/me/encounters`, `/me/threads`, `/me/deliveries`, `/directory`, `/doctors`) then show only that provider. Without the header they show all of the patient's own providers. Emergency (SOS), HMO cover, AI assistant, profile and notifications are not scoped.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/me/providers/summary` | `{ mode, allowMultipleProviders, crossProviderSharing, providers: [{ key, kind: org|group, name, mrn, linkedAt, orgIds, modules, type?, branches: [{ orgId, name, branchName, area, modules, phone }], shareHistory? }], pendingApplications: [application] }` |
| GET | `/api/me/partners?module=pharmacy|lab|clinic|ambulance|delivery&lat&lng` | providers the patient may send a prescription / lab order to: their own (`yours: true`) and partners of their providers (`partner: true`). In open mode: every listed provider |
| GET | `/api/join/providers?q&type&lat&lng&limit` | public list of providers that take patient applications; groups appear once with `kind: 'group'` and `branches: [{ id, name, branchName, area, city, distanceKm, ... }]`; standalone providers `kind: 'org'` with one branch |
| POST | `/api/me/applications` | `{ orgId (the branch or provider), note? }` -> `{ ok, approved, application, mrn?, message? }` (approved at once when the provider does not need approval) |
| GET | `/api/me/applications` | the patient's applications |
| POST | `/api/me/applications/:id/cancel` | |
| GET | `/api/me/referrals` | referrals about the patient |
| POST | `/api/me/providers/:orgId/share` | 403 in provider mode unless HQ allows cross-provider sharing |

Application: `{ id, number, orgId, orgName, groupId, groupName, status: pending|approved|declined|cancelled|expired, note, reason, createdAt, decidedAt, expiresAt }`.

## Front desk (staff)
Perm `patient.applications` (receptionist, records, front desk manager, pharmacist, lab reception, admin).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/fd/applications?status=pending` | application + `patient: { id, name, firstName, lastName, dob, age, sex, phone, email, address, lang, phoneVerified }`, `decidedByName` |
| POST | `/api/fd/applications/:id/approve` | `{}` -> `{ ok, application, patient (staffView with mrn) }` |
| POST | `/api/fd/applications/:id/decline` | `{ reason }` |

`GET /api/fd/patients?q=` at a branch also finds patients registered at other branches of the group.

Demo: Tobi (`tobi@patient.demo`) has a pending application to Crestview Hospitals, Ajah branch (`reception.ajah@crestview.demo`). Ngozi (`ngozi@patient.demo`) is a Crestview patient (registered at Ikeja, so also a patient at Ajah). Amaka is registered with four providers, so her app shows a provider switcher.
