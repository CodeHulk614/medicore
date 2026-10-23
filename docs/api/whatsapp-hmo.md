# Contact numbers, WhatsApp, off-platform HMOs, provider controls, data export

## Department contacts (phone + WhatsApp)
Departments (`DEPARTMENTS` in `src/modules/whatsapp.js`): `main` (Main line and reception), `emergency`, `appointments`, `pharmacy`, `lab`, `billing` (Billing and HMO), `care` (Customer care and complaints), `ambulance`, `records`.
Entry: `{ phone, whatsapp, waPhoneNumberId, email, hours, show }`. Numbers accept `0803 123 4567`, `+234...` or other countries `+44...`; they are stored as `+digits`. `waPhoneNumberId` (digits) is optional and advanced: it is the Meta "phone number ID" of that number once it is added to the platform's WhatsApp Business Account; with it, chats on that number land in that department's inbox. Without it the number still gives patients a click-to-chat button. `show: false` hides an entry from patients.
Views add `{ label, callLink: 'tel:+...', chatLink: 'https://wa.me/...', automated }`.

| Method | Path | Perm | Body / result |
|---|---|---|---|
| GET | `/api/admin/contacts` | admin.settings/staff/reports | `{ departments: { key: label }, contacts: { key: entry view }, modules, whatsappApi }` |
| PATCH | `/api/admin/contacts` | admin.settings | `{ contacts: { key: entry | null } }` (null removes) -> `{ contacts }` |
| GET | `/api/group/contacts` | any group role | `{ departments, headOffice: {...}, branches: [{ id, name, status, modules, contacts }], whatsappApi }` |
| PATCH | `/api/group/contacts` | group.settings | head office numbers, same body |
| PATCH | `/api/group/branches/:id/contacts` | group.branches | a branch's numbers, same body |
| GET | `/api/me/contacts` (patient; honours X-MC-Provider) | | `{ providers: [{ key, kind, name, headOffice, branches: [{ orgId, name, area, contacts }] }], platform: { supportPhone, supportWhatsapp, supportChatLink }, whatsappOptIn, whatsappAutomated }` |
| POST | `/api/me/whatsapp` (patient) | | `{ optIn: bool, number? }` -> `{ ok, whatsappOptIn, whatsapp }` |
| POST | `/api/fd/patients/:id/whatsapp` | patient.register or whatsapp.inbox | staff record the patient's agreement: `{ optIn, number? }` |

Platform numbers: HQ branding `supportPhone`, `supportWhatsapp`, `salesPhone`, `salesWhatsapp` (in `/api/meta/config` branding).

## WhatsApp automation (HQ > Integrations > WhatsApp)
Settings `integrations.whatsapp`: `phoneNumberId`, `businessAccountId`, `accessToken`*, `appSecret`*, `verifyToken`*, `apiVersion` (v21.0), `templates: { update, updateLanguage, code, codeLanguage }`, `notifyPatients` (bool), `sendCodes` (bool), `inbox` (bool), `autoReply`, `unknownReply`. Feature switch `features.whatsapp` must be on.
- Webhook for Meta: `GET/POST /api/whatsapp/webhook` (verify token; X-Hub-Signature-256 with the app secret).
- Patients who agreed get every notification on WhatsApp through the `update` template ({{1}} title, {{2}} details); then no SMS copy. With `sendCodes`, codes go by WhatsApp (authentication template `code`) and fall back to SMS.
- Incoming chats: department number -> that department's inbox; platform number -> the known patient's provider (menu when several); unknown -> `unknownReply`. Emergency words (English, Pidgin, Yoruba, Hausa, Igbo) -> instant reply with emergency numbers, chat marked urgent, provider alerted.
- Test: `POST /api/hq/config/test/whatsapp { to? }`. Number registry: `GET /api/hq/whatsapp/numbers` -> `{ platform: { phoneNumberId, configured, webhookPath }, numbers: [{ kind, id, name, dept, deptLabel, whatsapp, waPhoneNumberId }], departments }`.
- Email gateway: `integrations.email: { provider: '' | 'sendgrid' | 'brevo' | 'mailgun' | 'resend', apiKey*, from, fromName, mailgunDomain, mailgunRegion: us|eu }`; test `POST /api/hq/config/test/email { to }`.

## WhatsApp inbox (staff apps, perm `whatsapp.inbox`)
Roles see departments: receptionist main/appointments/records; records records/main; front desk manager main/appointments/records/billing/care/emergency; cashier billing; nurse main/emergency; care care/main; pharmacist, technician, delivery dispatcher pharmacy; lab roles lab; ambulance dispatcher emergency/ambulance; owner and admin all.

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/wa/conversations?status=open|closed&dept` | `{ conversations: [{ id, dept, deptLabel, phone, name, patientId, status, priority: normal|urgent, unread, lastAt, lastText, lastInboundAt, canReplyFreely, assignedTo, assignedName }], departments: { key: label }, apiReady, unreadTotal }` (urgent first) |
| GET | `/api/wa/conversations/:id` | `{ conversation, patient: { id, name, mrn } | null, messages: [{ id, dir: in|out, text, type, status, auto, template, byName, at, error }] }` (marks read) |
| POST | `/api/wa/conversations/:id/reply` | `{ text }` -> `{ ok, template }`. Inside 24 h: free text. Outside: sends the update template only if the patient agreed; else 409 `outside_window`. 409 `whatsapp_off` when HQ has not connected WhatsApp |
| POST | `/api/wa/conversations/:id/close` \| `assign` | |
| POST | `/api/wa/conversations/:id/move` | `{ dept }` |
| POST | `/api/wa/conversations/:id/link-patient` | `{ patientId }` (a patient registered here) |
| POST | `/api/wa/start` | `{ patientId, dept?, text }`: start a chat with a patient who agreed (template) -> `{ conversationId, ok }` |

## Off-platform HMOs
Panel entry: `{ id, payerOrgId|null, name, code, contactName, phone, whatsapp, email, preauthEmail, claimsEmail, portalUrl, notes, active, onPlatform, chatLink }`.

| Method | Path | Perm | Notes |
|---|---|---|---|
| GET | `/api/admin/hmos` | admin.settings or admin.finance | `{ panel, platformHmos: [{ id, name, code }], emailReady }` |
| POST | `/api/admin/hmos` | same | on-platform: `{ payerOrgId }`; off-platform: `{ name, code?, contactName?, phone?, whatsapp?, email?, preauthEmail?, claimsEmail?, portalUrl?, notes? }` |
| PATCH | `/api/admin/hmos/:id` | same | any field above except payerOrgId; `active: false` removes it from the desk |
| GET | `/api/fd/hmos` | hmo.check or hmo.claim | active panel |
| GET/POST | `/api/fd/patients/:id/external-covers` | hmo.check | POST `{ panelId, memberNo, planName?, employer?, validTo? }` (off-platform HMOs only) |
| PATCH | `/api/fd/external-covers/:id` | hmo.check | `{ status: active|ended, planName?, validTo? }` |
| POST | `/api/fd/external-preauths` | hmo.check | `{ patientId, panelId, coverId?, diagnosis, note?, items: [{ serviceCode, qty } or { name, amountKobo, qty }], sendEmail? }` -> request + `{ message (text), emailSent, whatsappLink (wa.me with the message), portalUrl, patientName }` |
| GET | `/api/fd/external-preauths?status&panelId&patientId` | hmo.check/claim | list + patientName |
| POST | `/api/fd/external-preauths/:id/decide` | hmo.check | `{ status: approved|denied|cancelled, authCode (approved), approvedKobo?, reason (denied) }` |
| POST | `/api/bills/:id/external-hmo` | hmo.check or billing.create | `{ panelId, coverId?, preauthId?, coveredKobo, authCode? }`: HMO's share on an unpaid bill (bill gets `hmoExternal`, `patientDueKobo` drops; fully covered bills become paid) |
| GET | `/api/fd/external-claims?panelId&from&to` | hmo.claim | unclaimed bills `{ hmo, bills: [{ id, number, createdAt, patientName, memberNo, authCode, totalKobo, coveredKobo }], totalCoveredKobo, emailReady }` |
| GET | `/api/fd/external-claims/export?panelId&from&to` or `&batchId` | hmo.claim | CSV download |
| POST | `/api/fd/external-claims/batches` | hmo.claim | `{ panelId, billIds, sendEmail?, note? }` -> batch + `{ emailSent, whatsappLink, portalUrl }` (each bill claimed once) |
| GET | `/api/fd/external-claims/batches?panelId` | hmo.claim | batches `{ id, number, hmoName, count, totalCoveredKobo, status: submitted|part_paid|paid, paidKobo, payments, createdAt, byName }` |
| POST | `/api/fd/external-claims/batches/:id/payment` | hmo.claim | `{ paidKobo, reference, rejectedBillIds? }` |

## Provider controls (Admin > Settings; group console branch settings)
`settings.acceptsOnlineBooking` (patients may book in the app; default on), `settings.applicationsNeedApproval` (overrides HQ), `settings.payBeforeVideo` (overrides HQ), `settings.referralsFromPartnersOnly` (default off), plus the earlier `acceptsPatientApplications`, `networkListed`, `acceptsReferrals`.

## Data export
`GET /api/admin/export` (owner, or admin.privacy): JSON file of the provider's patients, staff, visits, prescriptions, lab orders, bills, payments, referrals, HMO records. `GET /api/group/export?branchId=` (group owner): all branches or one. Limited to 5 a day; audited.

Demo: Grandville has department numbers, a WhatsApp chat from Amaka in the appointments inbox (Amaka agreed to WhatsApp), and an HMO panel with Harbor Health (on the platform) and "Bluewater HMO (off-platform demo)"; Tobi has Bluewater cover (member BWH/1029/01). Outbound internet is blocked in the sandbox, so WhatsApp/email sends fail cleanly there.
