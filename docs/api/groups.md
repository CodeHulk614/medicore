# Hospital groups and branches (`src/modules/groups.js`)

A **group** is one company with several **branches**. Each branch is an ordinary provider (org) with `groupId` and `branchName`; every service app works per branch exactly as before. Two administration levels:

| Level | App | Who | What |
|---|---|---|---|
| Group console | `group` (`/group.html`, header `X-MC-App: group`) | `group_members`: group_owner, group_admin, group_finance, group_viewer | all branches, staff in every branch, consolidated subscription, reports across branches, shared price lists, group admins, support |
| Branch admin | `admin` (`/admin.html`) | branch owner (= group owner) and branch `admin` role | one branch: its staff, settings, price list. Apps/subscription are read-only when `process.branches.branchAdminsManageModules` is false (default) |

Patients: a patient registered at one branch is a patient of every branch (same group-wide record number, records visible across branches when `process.branches.shareRecordsAcrossBranches`).

## Sign-in
`POST /api/auth/login` with `X-MC-App: group` works like the staff apps; with several groups it returns `{ chooseOrg: [{ orgId: groupId, orgName, orgType: 'group', role, roleLabel }] }` (send `orgId` back). `GET /api/auth/me` for the group app returns `{ kind: 'group', group: { id, name, code, status }, role, roleLabel, perms: ['group.branches', ...], otherOrgs }`. `POST /api/auth/switch-org { orgId }` switches group.

Group perms: `group.branches`, `group.staff`, `group.admins`, `group.finance`, `group.reports`, `group.settings`, `group.audit`, `group.network`, `group.support`.

For staff apps, `/api/auth/me` now also has `group: { id, name, code } | null`, `org.groupId`, `org.branchName`; in the admin app `isGroupAdmin` (the signed-in person also administers the group).

## Endpoints (all `X-MC-App: group`)

| Method | Path | Perm | Notes |
|---|---|---|---|
| GET | `/api/group/profile` | any | `{ id, name, code, status, contact, logoUrl, settings, mrnPrefix }` |
| PATCH | `/api/group/profile` | group.settings | `{ name?, contact?: {phone,email,address}, logoUrl?, settings?: { acceptsPatientApplications, defaultOpeningHours } }` |
| GET | `/api/group/overview?days=30` | any | `{ group, days, branches: [{ id, name, status, type, modules, area, patients, newPatients, staffActive, onDuty, revenueKobo, hmoCoveredKobo, openBills, outstandingKobo, appointments, encounters, labOrders, rxOrders, incidents, referralsIn, referralsOut, pendingApplications }], totals: {same keys summed}, subscription: groupQuote or null }` |
| GET | `/api/group/reports/revenue?days=30` | group.reports | `{ branches:[{id,name}], byDay: [{ date, byBranch: { orgId: kobo }, totalKobo }], byBranch: { orgId: kobo }, byCategory }` |
| GET | `/api/group/branches` | any | `{ branches: [branchRow], quote, allowedModules: { type: [modules] }, modules: { key: { label, desc, always } } }` |
| GET | `/api/group/branches/:id` | any | branchRow + `stats` (30 days, same keys as overview) + `allowedModules` + `quote` |
| POST | `/api/group/branches` | group.branches | `{ branchName, type?, modules?, seats?, contact: { phone, email?, address }, location?: { lat, lng, area, city, state }, admin?: { name, email?, phone? }, copyServicesFrom?: branchId }` -> `{ branch, admin: { membershipId, name, tempPassword|null } | null, note }`. Active at once when the group is active (unless HQ requires approval: then `pending`). |
| PATCH | `/api/group/branches/:id` | group.branches | `{ branchName?, contact?, location?, settings?: { openingHours, acceptsWalkIns, acceptsPatientApplications, requireClockIn, networkListed }, seats? }` |
| POST | `/api/group/branches/:id/modules` | group.branches | `{ module, enabled, confirmPriceKobo? }`: first call returns `{ needsConfirm, quote, currentMonthlyKobo, groupMonthlyKobo }`; send `confirmPriceKobo: quote.monthlyKobo` to apply. If HQ turned self-service off, returns `{ requested: true, ticket, message }` |
| POST | `/api/group/branches/:id/suspend` | group.branches | `{ reason }`; ends that branch's sessions |
| POST | `/api/group/branches/:id/reactivate` | group.branches | only if the group suspended it (not HQ) |
| PATCH | `/api/group/branches/:id/settlement` | group.finance | `{ bankName?, bankCode?, accountNumber? (10 digits), accountName?, subaccount? }`; account number is masked in responses |
| GET | `/api/group/staff?branchId&q&role` | group.staff | `{ staff: [{ id, userId, orgId, branchName, name, email, phone, role, roleLabel, title, status, isOwner, lastLoginAt, pendingPasswordChange }], branches: [{ id, name, status, seats }], rolesByBranch: { orgId: [{ key, label, app }] } }` |
| POST | `/api/group/staff` | group.staff | `{ branchId, name, email?, phone?, role, title? }` -> `{ member, tempPassword|null }` |
| PATCH | `/api/group/staff/:membershipId` | group.staff | `{ role?, title?, status?: active|suspended|removed, moveToBranchId? }` |
| GET | `/api/group/admins` | group.admins | `{ admins: [{ id, name, email, phone, role, roleLabel, status, isOwner, lastLoginAt }], roles: [{ key, label, perms }] }` |
| POST | `/api/group/admins` | group.admins | `{ name, email?, phone?, role: group_admin|group_finance|group_viewer }` -> `{ ok, admin, tempPassword|null }` |
| PATCH | `/api/group/admins/:id` | group.admins | `{ role?, status? }` |
| GET | `/api/group/subscription` | group.finance | `{ branches: [{ orgId, name, status, modules, seats, monthlyKobo }], branchCount, subtotalKobo, discount: { percent, kobo, minBranches } | null, monthlyKobo, bankChargePerPaymentKobo, trialEnds, statuses }` |
| GET | `/api/group/services?branchId` | group.settings | that branch's price list |
| POST | `/api/group/services/copy` | group.settings | `{ fromBranchId, toBranchIds: [], overwrite? }` -> `{ created, updated, skipped, items }` |
| GET | `/api/group/audit?branchId&action&before&limit` | group.audit | audit rows + `branchName` |
| GET | `/api/group/referrals?status` | group.network or group.reports | referral flow across branches, no clinical content: `{ id, number, fromOrgName, toOrgName, urgency, service, status, createdAt, direction: in|out|internal }` |
| GET/POST | `/api/group/support` | group.support | list / create `{ category, priority, subject, text }` (same categories as admin support) |
| POST | `/api/group/support/:id/reply` | group.support | `{ text }` |

`branchRow`: `{ id, name, branchName, type, typeLabel, code, status, statusReason, suspendedBy, modules, contact, location, settings, subscription, settlement (masked) | null, createdAt }`.

## Branch admin (admin app) additions
- `GET /api/admin/org` now also returns `group`, `branchName`, `isOwner`, `modulesManagedByGroup`, `settlement` (masked), `canConvertToGroup`.
- `POST /api/admin/org/modules` returns 403 for a branch when modules are managed by the group.
- `PATCH /api/admin/org` settings also accept `acceptsPatientApplications`, `networkListed`, `acceptsReferrals`. A branch cannot rename itself (the group names branches).
- `PATCH /api/admin/org/settlement` (admin.finance; standalone providers only): same body as the group settlement call.
- `POST /api/admin/org/convert-to-group` (owner only): `{ groupName?, branchName? }` turns a standalone provider into a group whose first branch is this provider. Then the owner uses the group console.

## Provider sign-up
`POST /api/orgs/signup` accepts `group: { name, branchName }`: creates a pending group whose first branch is the signup. More branches are added in the group console after approval.

## HQ
`GET /api/hq/groups`, `GET /api/hq/groups/:id` (branches, admins, quote), `POST /api/hq/groups/:id/suspend { reason }`, `POST /api/hq/groups/:id/reactivate`. Provider rows (`/api/hq/providers`) carry `groupId` and `branchName`. Approving a group's first branch approves the group.

Pricing: each branch keeps its own package; the group pays the sum less `pricing.branchDiscounts` (default 3+ branches 10%, 10+ branches 20%).
