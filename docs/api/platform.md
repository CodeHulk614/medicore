# MediCore HQ API (file `src/modules/platform.js`)

App: **hq**. Every route uses `A.requirePlatform(perm)`: anyone who is not on the platform team gets **403** (a signed-in provider or patient session), or 401 when not signed in. Platform roles (lib/roles `PLATFORM_ROLES`):

| role | perms |
|---|---|
| platform_owner | all |
| developer | platform.read, platform.orgs, platform.support, platform.audit, platform.demo |
| support | platform.read, platform.support |
| compliance | platform.read, platform.audit, platform.privacy |

Every write is audited as `hq.<action>`, with `orgId` = the target provider (null for platform-wide actions). Money is kobo; times are epoch ms. Not in this module: platform configuration (`/api/hq/config/*`, controlplane.js) and support tickets (`/api/hq/support`, support.js).

## Providers

`OrgRow`: `{ id, name, type, typeLabel, code, status: "pending|active|suspended|rejected", modules: [], subscription: { modules, seats, monthlyKobo, totalKobo, period: "monthly|annual", status: "trial|active|past_due|cancelled", trialEnds, manualPrice?, preset?, quotedAt } | null, city, area, createdAt, demo, statusReason }`

State machine: `pending -> active (approve) | rejected (reject, final)`; `active -> suspended (suspend)`; `suspended -> active (reactivate)`. Conditional: a repeated or parallel action gives one 200 and one `409 wrong_state`.

| Method | Path | Perm | Body / query | Response |
|---|---|---|---|---|
| GET | `/api/hq/providers` | platform.read | `?status=&type=&q=&limit=&skip=` (q: name, code, contact email) | `{ total, rows: [OrgRow] }` |
| GET | `/api/hq/providers/:id` | platform.read | | `OrgRow + { contact, location, kyc, settings, overrides, allowedModules, quote (orgs.quote of current modules), owner: { userId, name, email, phone, status, lastLoginAt, mustChangePassword }, staffCount, patientsCount, lastActivityAt, statusHistory: [{ at, from, to, by, reason }] }` |
| POST | `/api/hq/providers/:id/approve` | platform.orgs | | `OrgRow`; `subscription.status = "trial"`, `trialEnds = now + pricing.trialDays (30)`; owner notified; the owner can now sign in |
| POST | `/api/hq/providers/:id/reject` | platform.orgs | `{ reason }` (5-500) | `OrgRow` |
| POST | `/api/hq/providers/:id/suspend` | platform.orgs | `{ reason }` | `OrgRow + { sessionsRevoked }`. All staff sessions at this provider are revoked; every staff request fails from the next one on |
| POST | `/api/hq/providers/:id/reactivate` | platform.orgs | | `OrgRow` |
| PATCH | `/api/hq/providers/:id/modules` | platform.orgs | `{ modules: [] }`, within `allowedModules(type)`; always-on modules are added; delivery needs pharmacy or lab | `OrgRow + { quote }`; subscription price is re-quoted unless a manual price is set |
| PATCH | `/api/hq/providers/:id/subscription` | platform.orgs | `{ status?, seats?, period?: "monthly|annual", trialDays?, monthlyKobo? (negotiated price, sets manualPrice), clearManualPrice?, applyPreset?: planKey }` | `OrgRow + { quote }`. `applyPreset` copies a preset's modules (filtered to the type) and seats; 400 if the preset is not for this type |
| PATCH | `/api/hq/providers/:id/settings` | platform.orgs | `{ settings: { requireClockIn?, strictGeofence?, geofenceM?, twoStepLabVerify?, deliveryFeeKobo?, selfClaimDeliveries?, marketplace?, acceptsWalkIns?, openingHours? } }` | `OrgRow + { settings }` |
| POST | `/api/hq/providers/:id/reset-owner-password` | platform.support | | `{ tempPassword, owner: { name, email (masked) }, note }`; owner must change it at next sign-in; all their sessions revoked. 403 if the owner is a platform user, also a patient, or works at another provider |
| GET | `/api/hq/providers/:id/audit` | platform.audit | `?before=&action=<prefix>&limit=` | `[AuditEntry]` |

## Plan presets
Plans are optional presets (`id` = key). Editing a preset never changes any provider's subscription or price.

| Method | Path | Perm | Body | Response |
|---|---|---|---|---|
| GET | `/api/hq/plans` | platform.read | | `[{ key, id, label, orgTypes, priceKobo, period, modules, seats, active, orgsUsingPreset }]` |
| POST | `/api/hq/plans` | platform.plans | `{ key? (a-z0-9_-), label, orgTypes: [], priceKobo, period?: "monthly|yearly", modules: [], seats }` | plan. 400 when a module is not available to any listed type; 409 duplicate key |
| PATCH | `/api/hq/plans/:id` | platform.plans | any of the create fields except key | plan + `note` |
| POST | `/api/hq/plans/:id/deactivate` | platform.plans | | plan (409 if already inactive) |
| POST | `/api/hq/plans/:id/activate` | platform.plans | | plan |

## Platform team

`TeamMember`: `{ userId, name, email, role, roleLabel, status: "active|suspended", lastLoginAt, pendingPasswordChange }`

| Method | Path | Perm | Body | Response |
|---|---|---|---|---|
| GET | `/api/hq/team` | platform.users | | `{ team: [TeamMember], roles: [{ key, label }] }` |
| POST | `/api/hq/team` | platform.users | `{ name, email, role }` | `{ member, tempPassword | null, note }`. An existing MediCore account gets the role and keeps its password. 409 if already on the team |
| PATCH | `/api/hq/team/:userId` | platform.users | `{ role }` | `TeamMember`; the member's HQ sessions are revoked |
| POST | `/api/hq/team/:userId/suspend` | platform.users | | `TeamMember`; HQ sessions revoked (other roles unaffected) |
| POST | `/api/hq/team/:userId/reactivate` | platform.users | | `TeamMember` |

Rules: you cannot change your own role or suspend yourself (403). The last `platform_owner` cannot be demoted or suspended (`409 last_owner`), including when two owners demote each other at the same moment.

## Metrics
`GET /api/hq/metrics` (platform.read):
```json
{ "providers": { "total", "byType": {}, "byStatus": {}, "pending" },
  "patients": { "total", "new30d", "withAccount" }, "staff": { "active", "onDuty" },
  "bills30d": { "count", "paidCount", "paidVolumeKobo", "hmoCoveredKobo" },
  "incidents": { "total", "last30d" }, "prescriptions": { "total", "last30d" },
  "claims": { "total", "open", "last30d" }, "labOrders": { "total" },
  "support": { "total", "open", "urgentOpen", "byStatus": {} },
  "subscriptions": { "byStatus": {}, "activeMonthlyKobo" },
  "privacy": { "openRequests", "openBreaches" },
  "perDay": [{ "date", "newPatients", "bills", "paidKobo", "incidents", "newProviders" }] }
```
`perDay` has 30 entries, oldest first (Lagos dates).

## Audit search
`GET /api/hq/audit` (platform.audit) `?orgId=&actorId=&patientId=&targetId=&action=<prefix>&before=&after=&limit=` (max 500) -> `[{ id, at, action, actorId, actorKind, actorName, role, orgId, patientId, targetType, targetId, ip, app, meta? }]`, newest first.

## Privacy and compliance (platform.privacy)

Patient requests come from the patient app (`POST /api/me/privacy-request { type: delete|correct|restrict|object, note }`, core). Request states: `open -> in_progress (assign) -> responded -> closed`; `responded -> in_progress` allowed; `closed` final. Due 30 days after `at`.

`RequestView`: `{ id, patientId, type, note, status, at, dueAt, assignedTo, assignedName, response, respondedAt, outcome, closeNote, executedAt, retentionReason, deletionResult, history, patientName, patientStatus, overdue, daysLeft }`

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/api/hq/privacy/settings` | | `{ dataLocation, dpoEmail, privacyNoticeVersion, ndpcBreachHours: 72, requestResponseDays: 30, configuredBy }` |
| GET | `/api/hq/privacy/requests` | `?status=&type=&limit=` | `[RequestView]` (oldest first) |
| GET | `/api/hq/privacy/requests/:id` | | `RequestView` |
| POST | `/api/hq/privacy/requests/:id/assign` | `{ userId? }` (default: me; must be a platform user) | `RequestView` |
| POST | `/api/hq/privacy/requests/:id/respond` | `{ response }` | `RequestView`; patient notified in-app |
| POST | `/api/hq/privacy/requests/:id/close` | `{ outcome: completed|declined|withdrawn, note? }` | `RequestView` |
| POST | `/api/hq/privacy/requests/:id/execute-deletion` | `{ retentionReason }` | `{ ok, requestId, patientId, result: { userAction: "disabled|unlinked_staff_account|null", linksRemoved }, retained }`. Exactly once (409 after) |
| GET | `/api/hq/privacy/consents/:patientId` | | `{ patientId, status, current, records: [{ id, version, accepted, channel, at }] }` |

**Deletion = anonymisation:** names become "Removed Patient"; phone, email, address, home location, next of kin and USSD PIN are removed; `status: "removed"`; `retention: { reason, requestId, at, note }` is kept. The user account is disabled (phone and email released) and its sessions are revoked; if the person is also staff or on the platform team, only the patient profile is detached. All provider links get `status: "removed"`. Clinical, billing and audit records are **kept** under the same patientId for legal retention. The request is closed with outcome `completed`.

**Breach register**

`BreachView`: `{ id, title, discoveredAt, description, affectedCount, ndpcNotifiedAt, subjectsNotifiedAt, status: "open|contained|closed", actions, createdAt, createdBy, updatedAt, ndpcDeadline (discoveredAt + 72 h), ndpcHoursLeft (null once notified), ndpcOverdue (not notified and past the deadline), ndpcLate (notified after the deadline) }`

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/hq/privacy/breaches` | | `[BreachView]` newest first |
| POST | `/api/hq/privacy/breaches` | `{ title, discoveredAt, description (required), affectedCount?, ndpcNotifiedAt?, subjectsNotifiedAt?, status?, actions? }` | `BreachView` |
| PATCH | `/api/hq/privacy/breaches/:id` | any of the above | `BreachView`. A closed breach only accepts `status: "open"` (reopen) |

## Demo (platform.demo, only when `DEMO_MODE=1`)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/hq/demo/accounts` | | `{ password, rows: [[label, app, email]] }` |
| POST | `/api/hq/demo/reset` | `{ confirm: "RESET" }` | `{ ok, message, accounts }`. Wipes the whole database and reloads the demo data; **every session ends, including the caller's**, so the HQ app must go back to sign-in |

With demo mode off both answer `403`.
