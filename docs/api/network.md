# Provider network and referrals (`src/modules/network.js`)

Hospitals, clinics, pharmacies, labs and ambulance services on the platform work together. Patients never see the provider directory.

Switches (HQ > Features): `referralNetwork`, `providerMessaging`, `providerDirectory`. Processes: `process.referrals.{ requireConnection, requirePatientConsent, expireDays, notifyPatient }`. Provider settings: `networkListed` (shown in the directory), `acceptsReferrals`.

Perms: `referral.send` (most clinical and desk roles), `referral.receive` (front desk, pharmacist, lab reception/manager, ambulance dispatcher, admin), `network.manage` (admin, owner, front desk manager, lab manager: partnerships, messages).

## Directory and partners (staff apps)
| Method | Path | Perm | Notes |
|---|---|---|---|
| GET | `/api/network/providers?q&type&module&partners=true&limit` | any of the three | `[{ id, name, type, typeLabel, code, modules, area, city, location, distanceKm, phone, openingHours, groupName, sameGroup, connection: { id, status: pending|accepted, direction: in|out } | null, acceptsReferrals }]` (own group first, then partners, then nearest). `partners=true` lists only partners and own branches |
| GET | `/api/network/providers/:id` | any | the above + `email, address, partners: [{ id, name }], services: [{ code, name, category, priceKobo }]` |
| GET | `/api/network/connections` | any | `[{ id, status, direction, orgId, orgName, note, createdAt, decidedAt, byName }]` |
| POST | `/api/network/connections` | network.manage | `{ toOrgId, note? }` (if they already asked you, this accepts) |
| POST | `/api/network/connections/:id/accept` \| `decline` \| `end` | network.manage | |

## Provider messages (private between two providers)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/network/threads` | `{ threads: [{ id, orgId, orgName, referralId, subject, lastAt, lastText, unread }], unreadTotal }` |
| POST | `/api/network/threads` | `{ toOrgId, text }`: partners and own branches only |
| GET | `/api/network/threads/:id/messages` | `{ thread, messages: [{ id, mine, fromOrgName, fromName, text, system, at }] }` (marks read) |
| POST | `/api/network/threads/:id/messages` | `{ text }` |

## Referrals
Statuses: `sent -> accepted -> arrived -> completed`; `sent -> declined | cancelled | expired`; `accepted -> cancelled`.
Urgency: `emergency | urgent | routine | elective`. Service: `consultation | specialist | admission | emergency_care | lab | imaging | pharmacy | ambulance | maternity | physiotherapy | other`.

| Method | Path | Perm | Body / result |
|---|---|---|---|
| POST | `/api/referrals` | referral.send | `{ patientId, toOrgId, urgency, service, specialty?, reason (5-500), clinicalNote?, includeRecord? (default true), consent (required unless emergency), consentMethod?: verbal|written|app|emergency, coverageId? }` -> full referral. The record summary (allergies, conditions, current medicines, last 5 visits, recent lab results, last vitals) is copied at send time. The patient's active HMO cover is attached automatically |
| GET | `/api/referrals?box=in|out|all&status&patientId` | send or receive | `{ referrals: [summary], counts: { newIn } }`. Inbox puts new ones first, emergencies first |
| GET | `/api/referrals/:id` | send or receive (either side) | full: summary + `clinicalNote, snapshot, timeline, receiverMrn, queueId` |
| POST | `/api/referrals/:id/accept` | referral.receive (receiver) | `{ note? }`: registers the patient at the receiver (record number in `receiverMrn`) |
| POST | `/api/referrals/:id/decline` | referral.receive | `{ reason, suggestOrgId? }` |
| POST | `/api/referrals/:id/arrived` | referral.receive | `{ queue?: true }`: adds the patient to the triage queue |
| POST | `/api/referrals/:id/complete` | referral.receive | `{ outcome }`: shown to the referring provider |
| POST | `/api/referrals/:id/cancel` | referral.send (sender) | `{ reason }` |
| POST | `/api/referrals/:id/messages` | either side | `{ text }`: posts in the referral's private thread (`threadId`; read with `/api/network/threads/:threadId/messages`) |

Summary shape: `{ id, number, direction: in|out, fromOrgId, fromOrgName, fromName, fromRoleLabel, toOrgId, toOrgName, patientId, patientName, urgency, service, specialty, reason, status, createdAt, expiresAt, decidedAt, decidedByName, declineReason, arrivedAt, completedAt, outcome, threadId, hmo: { coverageId, payerName, memberNo, planName, status } | null, consent: { given, method, at } }`.

Snapshot shape: `{ at, byOrgName, patient: { name, dob, age, sex, phone, bloodGroup, genotype, weightKg }, allergies: [{ substance, reaction, severity }], noKnownAllergies, conditions: [{ name, code }], currentMedicines: [{ drugName, at }], recentEncounters: [{ date, orgName, doctorName, complaint, diagnoses: [{ code, text, primary }], plan }], recentLabResults: [{ number, releasedAt, lab, results: [{ name, value, unit, flag }] }], lastVitals: { at, bpSys, bpDia, pulse, tempC, spo2, respRate, weightKg, glucose } | null }`.

HMO: when the referral carries `hmo`, the receiving desk can request pre-authorisation from that HMO with the existing HMO pre-auth form (prefill `coverageId`, put the referral number in the note).

Patient side: `GET /api/me/referrals` (no clinical note or summary).

Demo: Yaba Care Pharmacy (`pharmacist@yabacare.demo`) has an open urgent referral RF000001 for Tobi to Grandville Hospital (`reception@grandville.demo` sees it). Yaba Care and Grandville are partners; Lekki Family Clinic and ClearPath are partners; ClearPath asked Crestview Ikeja to partner (`admin.ikeja@crestview.demo` can accept).
