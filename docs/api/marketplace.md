# Collaborative marketplace (v2.3)

Everything here is switched on or off in HQ > Configuration > Features, and tuned in HQ > Configuration > Processes. Money is in kobo.

| Feature switch | What it controls |
|---|---|
| `marketplace` | The patient marketplace (subscription, map, provider pages) |
| `marketplacePharmacy` | Marketplace patients ordering medicines from pharmacies they are not registered with. Blocked by the PCN compliance item when it is enforced and not done |
| `careSharing` | Shared care between providers |
| `documents` | Scans, letters with verification codes, signed forms |
| `inventory` | Stores and bed capacity |
| `publicFacilities` | Public hospitals (not on MediCore) in the finder and the emergency map |
| `transfers` | Emergency transfers, transfer packs, ambulance requests |
| `hmoRetail` | Patients buy HMO plans in the app |
| `hmoNetwork` | HMO provider networks, primary providers, capitation, free network access for members |

## Patient marketplace (`src/modules/market.js`)

Access: an active subscription (monthly, quarterly or yearly; prices in `process.marketplace`) opens every listed provider. Members with active HMO cover see their HMO's network free (`process.marketplace.hmoMembersSeeNetwork`). The subscription is a bill to MediCore (`orgId: 'platform'`, source `market_sub`) paid through the normal payment flow; it starts when the payment is confirmed (once).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/market/status` | `{ on, full, subscription, pending, hmoNetworkProviders, prices: { monthly: { months, amountKobo } ... }, pharmacyOrders, history }` |
| POST | `/api/market/subscribe` | `{ plan: monthly|quarterly|annual, consent: true }` -> `{ subscription, billId, amountKobo }`; pay with `/api/me/bills/:id/pay` |
| POST | `/api/market/cancel-pending` | cancels an unpaid subscription and voids its bill |
| GET | `/api/market/providers` | `?lat&lng&radiusKm&type&q&specialty&drug&test&service&emergency&hmo` -> `{ access: none|hmo|full, teaser?, providers: [card] }`. Card: public provider fields + `verified, doctors, specialties, video, takingEmergencies, freeBeds, viaHmo, yours, drugMatches?, testMatches?` |
| GET | `/api/market/providers/:id` | full page: services and prices, doctors, lab tests, public store items (state only), capacity, HMOs accepted, partners, `canUse`, `autoRegister` |
| GET | `/api/market/providers/:id/stock?q=` | pharmacy medicines: `{ name, form, strength, rxOnly, state: in_stock|low|out, priceKobo? }` (never quantities) |
| POST | `/api/market/providers/:id/join` | registers the patient at once (`via: 'marketplace'`) or sends an application when the provider approves joiners |
| GET/PATCH | `/api/admin/market-profile` | provider: `listed, autoRegister, showInventory, showPrices, about, facilities[], languages[], location` |
| GET | `/api/hq/market` | HQ figures: active subscribers, revenue 30 days, listed providers, joins |

Using a provider through the marketplace (booking, prescriptions, lab requests) goes through `patients.patientCanUse`, which now also allows marketplace access; the first use registers the patient there.

## Shared care (`src/modules/caresharing.js`)

Statuses: `pending_patient -> pending_provider -> active -> ended | revoked | expired`; pending -> `declined | cancelled`. While active, both providers (and their groups' branches) see each other's records for that patient (`patients.visibleRecordFilter`) and write in one care-team conversation.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/care-shares` | `{ patientId, toOrgId, purpose, note?, days? }` (perm `careshare.manage`) |
| POST | `/api/care-shares/:id/consent-code/send` and `/verify` | patient agreement by SMS code at the desk |
| GET | `/api/care-shares?box=in|out&status&patientId` | `{ shares, waiting }` |
| POST | `/api/care-shares/:id/accept` \| `decline` \| `end` | receiving provider accepts (registers the patient there) or declines; either side ends |
| GET | `/api/care-team/:patientId` | `{ team, shares, messages, canWrite }` |
| POST | `/api/care-team/:patientId/messages` | `{ text }`, providers on the team only |
| GET | `/api/me/care-team` | patient view |
| POST | `/api/me/care-shares/:id/approve` \| `decline` \| `revoke` | patient decisions |

Purposes: `ongoing_treatment, medicines, lab_monitoring, specialist_care, physiotherapy, maternity, home_care, second_opinion, other`.

## Documents (`src/modules/documents.js`)

Files are stored in `doc_blobs` (base64), one page per request, up to `process.documents.maxFileMb` (default 3 MB). Content is checked against the type (JPEG, PNG, WebP, PDF). The API body limit for `/api/docs` and `/api/me/documents` is 6 MB (Netlify functions accept up to 6 MB).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/docs/meta` | categories, letter types, standard and custom forms, my signature |
| GET | `/api/docs/patients/:pid` | documents this provider may see |
| POST | `/api/docs/patients/:pid` | `{ category, title, docDate?, note?, file: { name, mime, data: dataURL } }` |
| POST | `/api/docs/:id/files` | add a page |
| GET | `/api/docs/blobs/:id` | the file (audited) |
| PUT | `/api/docs/my-signature` | `{ title, licenceBody, licenceNo, qualifications }` (needed before issuing letters) |
| POST | `/api/docs/patients/:pid/letters` | `{ type: medical_report|sick_note|referral_letter|discharge_summary|fitness_certificate, body, addressedTo?, diagnosis?, restFrom?, restTo?, recommendations? }` -> carries `verifyCode` |
| POST | `/api/docs/:id/cancel` \| `remove` | cancel a letter; remove a scan (reason required) |
| POST | `/api/docs/patients/:pid/forms` | `{ templateId, answers, signerName, signerRelation, witnessName?, language?, signature: PNG dataURL }` |
| GET/POST/PATCH | `/api/admin/form-templates` | provider's own forms (`{{field}}` placeholders) |
| GET | `/api/public/verify/:code` | anyone: `{ valid, type, issuedOn, provider, signer, patientInitials, restFrom, restTo }` (no diagnosis). Page: `/register.html#/verify/<code>` |
| GET/POST | `/api/me/documents`, `/api/me/documents/:id/files`, `/share`, `/remove`, `/api/me/documents/blobs/:id` | patient side |

Standard forms: consent to treatment, procedure or operation, blood transfusion, records sharing, discharge against medical advice, admission.

## Stores and capacity (`src/modules/inventory.js`)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/store/meta`, `/api/store/items?dept&q&low`, `/api/store/items/:id`, `/api/store/alerts` | read (perm `inventory.read`) |
| POST/PATCH | `/api/store/items` | `{ name, dept, category, unit, reorderLevel, location, expiry, public, publicLabel, priceKobo, qty }` (perm `inventory.manage`) |
| POST | `/api/store/items/:id/move` | `{ type: receive|issue|count|adjust|waste|return, qty, reason, expiry?, patientId? }`; issue never goes below zero |
| GET/PUT | `/api/store/capacity` | `{ wards: [{ key, total, available }], acceptingEmergencies, note }` (perm `capacity.update`); older than 24 hours shows as unknown to others |

Departments: general, ward, emergency, theatre, maternity, clinic, lab, ambulance, dialysis, radiology. Wards: emergency, general, maternity, paediatric, icu, nicu, hdu, isolation, dialysis, theatre, psychiatric, burns.

## Public hospitals and transfers (`src/modules/facilities.js`)

| Method | Path | Notes |
|---|---|---|
| GET/POST/PATCH | `/api/hq/facilities` | HQ registry: name, kind, ownership, level, state, lga, address, location, phones `[{ number, kind: main|emergency|transfer|ambulance|whatsapp|other }]`, services, open24h, verified |
| POST | `/api/hq/facilities/import` | `{ csv, dryRun?, markVerified? }`; columns `name, kind, ownership, level, state, lga, address, lat, lng, main_phone, emergency_phone, transfer_phone, services (a|b), open24h, hfr_id` |
| GET/POST | `/api/hq/facility-suggestions`, `/:id/apply|dismiss` | corrections sent by providers |
| GET | `/api/facilities/finder?lat&lng&service&radiusKm&source` | staff: MediCore hospitals (with capacity) and public ones together |
| POST | `/api/facilities/:id/suggest` | a provider reports a wrong number |
| GET | `/api/emergency/facilities?lat&lng` | anyone: emergency-capable hospitals near a point (no bed counts) |
| POST | `/api/transfers` | `{ patientId, facilityId, reason, clinicalNote?, urgency }` (public hospitals; MediCore hospitals get a referral) |
| POST | `/api/transfers/:id/log` | `{ outcome: requested|no_answer|accepted|declined|en_route|arrived|cancelled, contactName?, numberCalled?, note? }` |
| POST | `/api/transfers/:id/pack` (`/revoke`) | link + 6-digit code, both shown once; valid `process.transfers.packHours` (72), opened at most `packMaxViews` times |
| POST | `/api/transfers/:id/ambulance` | `{ ambulanceOrgId? }`: incident (source `transfer`) with this hospital as destination |
| POST | `/api/public/transfer/:token` | receiving hospital, no account: `{ code }` -> patient summary. Page: `/register.html#/transfer/<token>` |

## HMOs on the platform (`src/modules/hmoplus.js`)

| Method | Path | Notes |
|---|---|---|
| GET/POST/PATCH | `/api/payer/plans` | plans: kind, monthly and yearly premium, limits, benefits, exclusions, waiting days, family members allowed, `sellOnline`, `activateOnPayment` |
| GET/POST/PATCH | `/api/payer/network`, `/candidates`, `/:id/suspend|reactivate|end` | provider network: level, primary care, capitation rate |
| GET | `/api/admin/hmo-network`, POST `/api/admin/hmo-network/:id/accept|decline|leave` | provider side; accepting adds the HMO to the provider's panel |
| GET/POST/PATCH | `/api/payer/employers` | corporate clients |
| POST | `/api/payer/coverages/:id/details` | plan, primary provider, employer, relation (gives the member a card code) |
| POST | `/api/payer/coverages/:id/dependants`, GET `/family` | family members with their own member numbers and cards (no phone needed) |
| GET/POST | `/api/payer/capitation?month=`, `/api/payer/capitation/pay` | statement per primary provider (enrollees x rate); each provider is paid once a month |
| GET | `/api/hmo/capitation` | provider: this month and payments received |
| GET | `/api/hmo/verify-card?code=`, POST `/api/hmo/verify-card/register` | desk checks a member card (network or panel providers only) and registers the member |
| GET | `/api/me/hmo/plans`, `/api/me/hmo/networks/:payerOrgId` | patient: plans sold in the app, the HMO's network |
| POST | `/api/me/hmo/buy`, `/api/me/hmo/:id/renew` | premium bill (source `hmo_premium`, settles to the HMO); paid -> active with validity extended |
| GET | `/api/me/hmo/cards` | member cards, own and dependants' |
| POST | `/api/me/hmo/:id/primary` | change primary provider (limited by `process.hmo.primaryChangeMinMonths`) |
| GET/POST | `/api/me/hmo/requests`, `/:id/messages`; `/api/payer/requests`, `/:id/reply` | member requests and answers |
| GET | `/api/payer/overview` | plans, network, online members, dependants, open requests, capitation due |

## New permissions

`careshare.manage`, `docs.read`, `docs.upload`, `docs.issue`, `docs.forms`, `inventory.read`, `inventory.manage`, `inventory.issue`, `capacity.update`, `transfer.manage`, `payer.plans`, `payer.network`, `payer.care`. New role: `store_officer` (front desk app). Defaults are given to the matching roles; HQ > Roles can change them.

## Demo data

Ngozi has a quarterly marketplace subscription. Tobi and Amaka have Harbor cover, so they see Harbor's network. Harbor sells Harbor Gold and Harbor Silver online, has five network providers (Grandville and Lekki as primary care with capitation), an employer, a dependant (Chidera, card `HGCHIDE2`) and a member question. Amaka is shared between Grandville and Yaba Care Pharmacy, with care-team messages; Tobi's lab monitoring share with ClearPath waits for the lab. Grandville has store items (blood, oxygen, delivery packs marked public) and beds; Crestview Ajah is not taking emergencies. Four fictional public hospitals are on the map. Amaka has a scanned folder, her own uploaded result and a sick note with code `DEMOSICK24`.
