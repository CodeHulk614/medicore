# Pharmacy + Delivery API

Module `pharmacy` (with `delivery`). It works for a standalone pharmacy (Yaba Care Pharmacy) and for a hospital pharmacy (Grandville Hospital). All paths are under `/api`. Every mutating request needs the `X-MC-App` header (`patient`, `pharmacy`, `frontdesk`, `rider`, `admin`).

## Conventions

- Money is integer **kobo** (`150000` = NGN 1,500). Dates are `YYYY-MM-DD` (Lagos). Timestamps are epoch ms.
- Errors are `{ error, code?, details? }`. `400` bad input, `403` role or module not allowed, `404` not found **or belongs to another provider**, `409` wrong state or already done (`code`: `wrong_state`, `already_sent`, `insufficient_stock`, `already_recalled`, `already_paid`, `rider_off_duty`, `rider_not_verified`, `order_not_ready`), `423` locked (`clock_in_required`, `code_locked`), `429` rate limited.
- Writes marked **shift** need the staff member to be clocked in (`POST /api/shift/clock-in`), otherwise `423 clock_in_required`.
- Every state change is exactly-once. A repeated or parallel action gets `409`. The UI should refresh and show the current state.
- Apps and roles:

| App | Roles | Key permissions |
|---|---|---|
| `pharmacy` | pharmacist | `pharmacy.verify`, `pharmacy.dispense`, `pharmacy.stock` |
| `pharmacy` | pharmacy_tech | `pharmacy.dispense`, `pharmacy.stock` |
| `pharmacy` | delivery_dispatcher | `delivery.dispatch` |
| `frontdesk` | cashier (counter) | `billing.create`, `billing.cash` |
| `rider` | rider | `delivery.ride` |
| `admin` | owner, admin | `admin.reports`, `admin.staff` |
| `patient` | patient | own records only |

- HQ settings that change behaviour (per provider): `process.pharmacy.deliveryCodeAttempts` (default 5, used for pickup **and** delivery codes), `process.pharmacy.pickupWindowDays` (2; shown as `collectBy`), `process.pharmacy.requirePharmacistVerify` (true; when false an order can be priced straight from `received`, but blocking safety alerts still need a pharmacist), `process.pharmacy.allowSubstitution` (true), `process.delivery.riderLocationFreshSeconds` (120), feature `homeDelivery` (true; when off, delivery orders are refused). Delivery fee comes from the provider setting `settings.deliveryFeeKobo`.

## State machines

### Prescription order (`rx_orders`)

```
received ──verify(proceed)──> verified ──price──> priced ──(bill settled)──> paid ──ready──> ready ──collect(code)──> collected
   │  └─verify(query)──> queried ──verify(proceed)──┘   ↑ re-price ok           │                 └─(rider picks up)──> out_for_delivery ──(code)──> delivered
   │                        │                            (voids old bill)          │                                          │
   └─verify(reject)──> rejected <──────────────────────┘                          │               (failed + returned) <─────┘ back to ready
cancel: received | queried | verified | priced | paid | ready  ──> cancelled   (patient: only before paid)
```

- `priced -> paid` happens **only** when the bill is settled (patient pays online, cashier records cash/POS, or HMO covers it). There is no "mark paid" endpoint.
- Re-pricing is allowed while `priced` and unpaid (the old bill is voided). After payment it is refused (`409`).
- Stock is allocated FEFO (earliest expiry first; expired, quarantined and empty batches skipped) and deducted **once**, at `ready`. A transient internal state `allocating` may appear for a moment in staff views; patients see `paid`.
- `rejected` and `cancelled` give the prescription back to the patient (`canSend: true` again) so they can send it to another pharmacy.
- Cancelling a `ready` order puts the stock back on the same batches. Cancelling `paid` or `ready` sets `refundDue { billId, amountKobo, note }`; the refund itself is done in billing (`POST /api/bills/:id/refund-request`).
- `out_for_delivery` cannot be cancelled; the delivery must fail and be returned first.

### Delivery (`deliveries`)

```
pending ──assign/claim──> assigned ──pickup/handover──> picked_up ──deliver(code)──> delivered
   ↑          │ └─unassign──> pending                       └──fail(reason)──> failed ──returned──> returned ──retry──> pending
   └──────────┴── cancelled (order cancelled before hand-over)
```

- Wrong delivery code: after `deliveryCodeAttempts` (5) wrong codes the delivery is `locked: true`, the dispatcher is alerted, and `deliver` returns `423 code_locked` even with the right code until the dispatcher calls `unlock` (new code sent to the patient).
- `kind` is `'medication'` now; the model is generic so labs can reuse it.

### Counter sale (`pharmacy_sales`)

```
awaiting_approval ──approve(pharmacist)──> billed ──(bill settled)──> paid ──(auto)──> completed
awaiting_approval | billed ──cancel──> cancelled
```

- OTC-only sales go straight to `billed`. Prescription-only items need a linked patient, and either the creator is a pharmacist or the sale waits in `awaiting_approval`.
- Stock is deducted once, automatically, when the bill is settled. If stock ran out meanwhile, the sale stays `paid` with `stockShort: true`; retry with `POST /pharmacy/sales/:id/complete`.

### Purchase order

`draft -> sent -> partially_received -> received`; `draft | sent -> cancelled`.

## Shapes

**ItemView**
```json
{ "id": "pit_…", "drugCode": "AMLO5", "name": "Amlodipine 5mg tablet", "form": "Tablet", "strength": "5mg", "unit": "tablet",
  "reorderLevel": 50, "controlled": false, "rxOnly": true, "sellPriceKobo": 4000, "active": true,
  "onHand": 32, "batches": 2, "lowStock": true, "outOfStock": false, "nearExpiryQty": 12, "earliestExpiry": "2027-02-17",
  "expiredQty": 0, "quarantinedQty": 0 }
```
`onHand` counts only usable stock (active, not expired). `drugCode` is `null` for items not in the formulary.

**Batch**
`{ id, orgId, itemId, batchNo, expiry, qty, qtyReceived, costKobo, supplierId, poId, status: 'active'|'quarantined'|'expired'|'depleted', recalledAt, receivedAt, daysToExpiry, nearExpiry, expired }`

**Move** (ledger, read-only)
`{ id, itemId, batchId, type: 'receive'|'dispense'|'sale'|'adjust'|'count'|'return_in'|'return_supplier'|'recall'|'expire', qty (signed), balanceAfter, reason, ref: {type,id}|null, by, byName, at, meta? }`

**StaffOrder** (`/pharmacy/orders/:id`)
```json
{ "id": "rxo_…", "status": "priced", "fulfilment": "pickup", "patientId": "pat_…", "prescriptionId": "rx_…",
  "prescriberOrgId": "org_…", "prescriberOrgName": "Lekki Family Clinic", "prescriberName": "Dr. Ada Nwosu", "prescriberUserId": "usr_…",
  "items": [{ "drugCode": "AMLO5", "drugName": "Amlodipine 5mg tablet", "doseMg": 5, "doseText": "5mg", "frequency": "od", "durationDays": 30, "quantity": 30, "route": "oral", "instructions": null }],
  "prescriberSafety": { "alerts": [], "blocking": false, "overrideReason": null, "checkedAt": 0 },
  "verification": { "by": "usr_…", "byName": "Pharm. Musa Ibrahim", "at": 0, "alerts": [/* safety alerts */], "blocking": false, "decision": "proceed|reject|query", "reason": null },
  "lines": [{ "rxIndex": 0, "supplied": true, "itemId": "pit_…", "drugCode": "AMLO5", "name": "…", "controlled": false, "qty": 30, "unitPriceKobo": 4000, "totalKobo": 120000, "substitutedFor": null, "substitutionReason": null }],
  "deliveryFeeKobo": 0, "totalKobo": 120000, "billId": "bil_…",
  "bill": { "id": "bil_…", "number": "B000012", "status": "open|paid|void", "totalKobo": 120000, "patientDueKobo": 120000, "paidKobo": 0, "lines": [], "hmo": null },
  "allocations": [{ "itemId": "…", "batchId": "…", "batchNo": "YC-AMLO5-2601", "expiry": "2027-02-17", "qty": 12 }],
  "address": null, "location": null, "deliveryId": null, "delivery": { "id": "dlv_…", "status": "assigned", "riderMembershipId": "mem_…", "locked": false },
  "pickupAttempts": 0, "pickupLocked": false, "collectBy": null, "pickupOverdue": false, "refundDue": null,
  "timeline": [{ "status": "received", "at": 0, "by": null, "note": "sent by patient" }],
  "patient": { /* staff patient view: name, age, allergies, conditions, weightKg … */ } }
```
A line not supplied: `{ rxIndex, supplied: false, name, notSuppliedReason, qty: 0, unitPriceKobo: 0, totalKobo: 0 }`.

**PatientOrder** (`/me/rx-orders/:id`, also returned by send and cancel)
```json
{ "id": "rxo_…", "status": "ready", "fulfilment": "pickup", "prescriptionId": "rx_…",
  "pharmacy": { "id": "org_…", "name": "Yaba Care Pharmacy", "phone": "+234…", "address": "…", "location": { "lat": 6.5, "lng": 3.37 } },
  "items": [{ "drugName": "…", "doseText": "…", "frequency": "od", "durationDays": 30, "quantity": 30, "instructions": null }],
  "lines": [{ "name": "…", "qty": 30, "unitPriceKobo": 4000, "totalKobo": 120000, "substituted": false, "substitutionReason": null, "supplied": true }],
  "deliveryFeeKobo": 0, "totalKobo": 120000, "address": null,
  "bill": { "id": "bil_…", "number": "B000012", "status": "paid", "totalKobo": 120000, "patientDueKobo": 120000, "paidKobo": 120000, "lines": [], "hmo": null },
  "pickupCode": "482913", "collectBy": 0,
  "delivery": null,
  "message": null, "refundDue": null,
  "timeline": [{ "status": "received", "at": 0 }], "createdAt": 0 }
```
- `pickupCode` is set only while `status === 'ready'` and fulfilment is pickup (null after 5 wrong tries; `message` explains).
- `delivery` (delivery orders, after `ready`): `{ id, status, deliveryCode }`. `deliveryCode` is shown until delivered (null while locked).
- `message`: the pharmacist's reason when `rejected` or `queried`; the cancel reason when `cancelled`.
- To pay: `POST /api/me/bills/{bill.id}/pay` (billing module), then follow its demo or Paystack flow.

**PatientDelivery** (`/me/deliveries/:id`)
```json
{ "id": "dlv_…", "kind": "medication", "status": "picked_up", "rxOrderId": "rxo_…",
  "pharmacy": { "name": "Yaba Care Pharmacy", "phone": "+234…" }, "address": "22 Herbert Macaulay Way, Yaba", "destination": { "lat": 6.507, "lng": 3.375 },
  "rider": { "firstName": "Sam", "vehicle": "motorcycle" },
  "riderLocation": { "lat": 6.5085, "lng": 3.372, "heading": 90, "at": 0 },
  "etaMinutes": 3, "deliveryCode": "120934", "codeLocked": false,
  "timeline": [{ "status": "pending", "at": 0 }], "createdAt": 0, "deliveredAt": null }
```
`rider` is shown while `assigned`/`picked_up`. `riderLocation` and `etaMinutes` only while `picked_up` and the last GPS ping is fresh (< 2 min); otherwise null. Poll every 15 to 30 s.

**DispatchDelivery** (`/delivery/deliveries/:id`)
`{ id, orgId, kind, rxOrderId, patientId, address, location, status, riderMembershipId, riderUserId, codeAttempts, locked, attempts, failReason, failNote, lastLoc: {lat,lng,accuracy,heading,speed,at,fresh}|null, timeline, createdAt, updatedAt, assignedAt?, pickedUpAt?, deliveredAt?, patient: { firstName, lastInitial, phone }, rider: { membershipId, name, phone }|null }` (no codes).

**RiderRow** (`/delivery/riders`)
`{ membershipId, name, phone, profileId, status: 'no_profile'|'pending'|'verified'|'suspended', vehicle, plate, licence, onDuty, activeJobs, lastLoc }`

**RiderJob** (`/rider/jobs…`)
`{ id, kind, status, attempts, locked, codeTriesLeft, patient: { firstName, phone (only while assigned/picked_up) }, address, location (only while active), pickup: { name, address, location }, distanceKm, assignedAt, pickedUpAt, deliveredAt, failReason }`

**Sale**
`{ id, number: 'S000001', patientId|null, patientName|null, lines: [{ itemId, drugCode, name, qty, unitPriceKobo, totalKobo, rxOnly, controlled }], totalKobo, status, approval: { by, byName, at, alerts, blocking, overrideReason }|null, billId, bill: { id, number, status, totalKobo, patientDueKobo, paidKobo }|null, allocations, stockShort, createdBy, createdByName, createdAt, timeline }`

## Endpoints: patient app (`X-MC-App: patient`)

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/me/prescriptions` | | `[{ id, prescriberOrgId, prescriberOrgName, prescriberName, createdAt, status: 'active'\|'sent'\|'cancelled', items: [{drugCode, drugName, doseText, frequency, durationDays, quantity, route, instructions}], canSend, order: { id, status, fulfilment, pharmacyOrgId, pharmacyName, totalKobo, billId, deliveryId }\|null, previousOrders: [{ id, status, pharmacyOrgId }] }]` |
| POST | `/me/prescriptions/:id/send` | `{ pharmacyOrgId, fulfilment: 'pickup'\|'delivery', address?, location?: {lat,lng} }` | PatientOrder. `404` pharmacy not found / not a pharmacy; `400` no delivery at that pharmacy or no address (falls back to profile address and home location); `409 already_sent`. Choose pharmacies from `GET /api/directory?module=pharmacy&lat=&lng=` (delivery possible when `modules` includes `delivery`). |
| GET | `/me/rx-orders` | | `[{ id, status, fulfilment, pharmacyName, totalKobo, billId, deliveryId, createdAt, updatedAt }]` |
| GET | `/me/rx-orders/:id` | | PatientOrder |
| POST | `/me/rx-orders/:id/cancel` | `{ reason? }` | PatientOrder (only before payment) |
| GET | `/me/deliveries` | | `[PatientDelivery]` |
| GET | `/me/deliveries/:id` | | PatientDelivery (own only, else 404) |

## Endpoints: pharmacy app (pharmacist, technician)

Guard abbreviations: **R** = any of verify/dispense/stock; **R+** = R or `admin.reports`; **V** = `pharmacy.verify`; **D** = `pharmacy.dispense`; **St** = `pharmacy.stock`.

### Orders

| Method | Path | Guard | Body / query | Response |
|---|---|---|---|---|
| GET | `/pharmacy/orders` | R | `?status=&active=true&fulfilment=&patientId=&limit=` | `[{ id, status, fulfilment, patientId, patientName, prescriberName, prescriberOrgName, itemCount, totalKobo, billId, deliveryId, createdAt, updatedAt }]` |
| GET | `/pharmacy/orders/:id` | R | | StaffOrder (audited) |
| GET | `/pharmacy/orders/:id/safety` | V | `?pregnant=true` | `{ prescriberSafety, alerts: [{level, type, drug, message}], blocking }` (no state change) |
| POST | `/pharmacy/orders/:id/verify` | V, shift | `{ decision: 'proceed'\|'reject'\|'query', reason?, pregnant? }` | StaffOrder. Re-runs the safety check. `proceed` with blocking alerts needs `reason` (min 5), else `400 code: safety_blocking, details: alerts`. `reject`/`query` need `reason`. Query notifies the prescriber. |
| POST | `/pharmacy/orders/:id/price` | D, shift | `{ lines?: [{ rxIndex, itemId?, substitutionReason?, supply?: false, notSuppliedReason? }] }` | StaffOrder (status `priced`, bill raised). Without `lines`, each prescription item is matched by `drugCode`. A different item is a substitution and needs `substitutionReason`. Quantities always come from the prescription. `409 insufficient_stock` if not enough usable stock. Delivery fee is added for delivery orders. |
| POST | `/pharmacy/orders/:id/ready` | D, shift | | StaffOrder (`ready`, `allocations`). Pickup: code sent to patient by SMS and app. Delivery: creates a `pending` delivery (`deliveryId`). `409` if not paid; `409 insufficient_stock` leaves it `paid`. |
| POST | `/pharmacy/orders/:id/collect` | D, shift | `{ code: '123456' }` | StaffOrder (`collected`). Wrong code `400`; after 5 wrong `423 code_locked`. |
| POST | `/pharmacy/orders/:id/reissue-code` | V, shift | | `{ ok: true }` (new pickup code SMS'd, attempts reset) |
| POST | `/pharmacy/orders/:id/cancel` | V or D, shift | `{ reason }` (min 5) | StaffOrder (`cancelled`, maybe `refundDue`) |

### Inventory

| Method | Path | Guard | Body / query | Response |
|---|---|---|---|---|
| GET | `/pharmacy/items` | R+ | `?q=&lowOnly=true&includeInactive=true` | `[ItemView]` |
| GET | `/pharmacy/items/:id` | R+ | | `{ item: ItemView, batches: [Batch], moves: [Move] (latest 50) }` |
| POST | `/pharmacy/items` | St | `{ drugCode?, name?, form?, strength?, unit?, reorderLevel?, controlled?, rxOnly?, sellPriceKobo }` | ItemView. Known `drugCode` fills the name; formulary-controlled drugs are always controlled and prescription-only. `409` if already stocked. |
| PATCH | `/pharmacy/items/:id` | St | any of `name, form, strength, unit, reorderLevel, controlled, rxOnly, sellPriceKobo, active` | ItemView |
| GET | `/pharmacy/formulary` | R | `?q=` | `[{ code, name, controlled, defaultRxOnly }]` |
| POST | `/pharmacy/stock/receive` | St, shift | `{ itemId, batchNo, expiry, qty (>=1), costKobo?, supplierId? }` | Batch. Expired stock refused. Same batchNo with same expiry adds to it. |
| POST | `/pharmacy/batches/:id/adjust` | St, shift | `{ delta (non-zero int), reason: 'damaged'\|'breakage'\|'theft_loss'\|'found'\|'data_correction'\|'sample'\|'other', note? }` | `{ batch, move }`. `409 insufficient_stock` if it would go below 0. |
| POST | `/pharmacy/batches/:id/count` | St, shift | `{ counted (>=0), note? }` | `{ batch, variance, move }` (`409` if stock moved during the count) |
| POST | `/pharmacy/batches/:id/return-in` | D, shift | `{ qty, reason, rxOrderId?, saleId? }` | `{ batch, move }` (not for quarantined or expired batches; not more than was dispensed) |
| POST | `/pharmacy/batches/:id/return-supplier` | St, shift | `{ qty, reason }` | `{ batch, creditKobo, move }` |
| POST | `/pharmacy/batches/:id/recall` | St, shift | `{ reason (min 5), reference? }` | `{ recall: { id, batchId, batchNo, reason, quarantinedQty, affectedOrderIds, affectedSaleIds, claimStatus: 'open', at }, batch }`. Once only: then `409 already_recalled`. |
| GET | `/pharmacy/recalls` | R | | `[Recall]` |
| POST | `/pharmacy/recalls/:id/claim` | St | `{ claimStatus: 'sent'\|'credited'\|'closed', note? }` | Recall (forward only) |
| POST | `/pharmacy/stock/expire-sweep` | St, shift | | `{ expired: [{ batchId, batchNo, qty }] }` (writes off expired batches) |
| GET | `/pharmacy/moves` | R+ | `?itemId=&batchId=&type=&limit=` | `[Move]` |
| GET | `/pharmacy/alerts` | R+ | | `{ lowStock: [{ itemId, name, onHand, reorderLevel, outOfStock }], expiring: [{ batchId, itemId, name, batchNo, expiry, daysToExpiry, qty }] (< 90 days), expired: [{ batchId, itemId, name, batchNo, expiry, qty }] }` |
| GET | `/pharmacy/controlled-register` | V or `admin.reports` | `?itemId=&from=&to=&limit=` | `[{ id, itemId, drugCode, itemName, batchId, batchNo, qty, balanceAfter, patientId, patientName, ref: {type,id}, by, byName, at }]` |
| GET/POST | `/pharmacy/suppliers` | R / St | POST `{ name, phone?, email?, address?, contactName? }` | `[Supplier]` / Supplier |
| PATCH | `/pharmacy/suppliers/:id` | St | same fields + `active` | Supplier |
| GET | `/pharmacy/purchase-orders` | R | `?status=` | `[PO + supplierName]` |
| GET | `/pharmacy/purchase-orders/:id` | R | | `PO + batches` |
| POST | `/pharmacy/purchase-orders` | St | `{ supplierId, lines: [{ itemId, qty, costKobo? }], note? }` | PO `{ id, number: 'PO00001', supplierId, status: 'draft', lines: [{ itemId, name, qty, costKobo, receivedQty }], totalKobo, timeline }` |
| PATCH | `/pharmacy/purchase-orders/:id` | St | `{ lines, note? }` (draft only) | PO |
| POST | `/pharmacy/purchase-orders/:id/send` | St | | PO (`sent`) |
| POST | `/pharmacy/purchase-orders/:id/cancel` | St | `{ reason }` | PO (`cancelled`) |
| POST | `/pharmacy/purchase-orders/:id/receive` | St, shift | `{ lines: [{ itemId, batchNo, expiry, qty, costKobo? }] }` | `{ po, batches: [Batch] }`. Items must be on the PO; qty cannot exceed what is outstanding. |

### Counter sales (pharmacy app or front-desk cashier)

| Method | Path | Guard | Body / query | Response |
|---|---|---|---|---|
| GET | `/pharmacy/counter/items` | D or `billing.create` | `?q=` | `[{ id, drugCode, name, unit, sellPriceKobo, rxOnly, controlled, available }]` |
| POST | `/pharmacy/sales` | D or `billing.create`, shift | `{ patientId?, lines: [{ itemId, qty (1-1000) }], overrideReason?, note? }` | Sale (`billed` or `awaiting_approval`). Prescription-only items without `patientId`: `400`. A pharmacist creating it runs the safety check (blocking needs `overrideReason`). |
| POST | `/pharmacy/sales/:id/approve` | V, shift | `{ overrideReason? }` | Sale (`billed`) |
| POST | `/pharmacy/sales/:id/complete` | D or `billing.create`, shift | | Sale (`completed`); retry when `stockShort` |
| POST | `/pharmacy/sales/:id/cancel` | D or `billing.create`, shift | `{ reason }` | Sale (`cancelled`, bill voided) |
| GET | `/pharmacy/sales` | D or `billing.create` | `?status=&limit=` | `[Sale]` |
| GET | `/pharmacy/sales/:id` | D or `billing.create` | | Sale |

Payment at the counter: `POST /api/bills/{billId}/cash { method: 'cash'|'pos'|'transfer', amountKobo, receiptNo }` (billing module, cashier). The sale completes and stock is deducted automatically.

### Dashboard and reports (pharmacy app or admin app)

| Method | Path | Guard | Response |
|---|---|---|---|
| GET | `/pharmacy/dashboard` | R+ | `{ orders: { [status]: count }, toVerify, toPrepare, readyForPickup, salesAwaitingApproval, salesStockShort, today: { paidBills, revenueKobo }, lowStock, outOfStock, expiringBatches, expiredBatches, deliveries: { [status]: count }\|null }` |
| GET | `/pharmacy/reports/valuation` | `admin.reports`, V or St | `{ asOf, totals: { units, costKobo, sellKobo, quarantinedCostKobo, expiredCostKobo, marginKobo }, items: [{ itemId, name, drugCode, units, costKobo, sellKobo, quarantinedCostKobo, expiredCostKobo }] }` |
| GET | `/pharmacy/reports/daily-sales?date=YYYY-MM-DD` | same | `{ date, bills, totalKobo, hmoCoveredKobo, deliveryFeesKobo, bySource: { rx_order: {count,totalKobo}, pharmacy_sale: {count,totalKobo} }, byMethod: { [cash\|pos\|transfer\|online\|hmo\|free]: kobo }, unitsOut, topItems: [{ name, qty, totalKobo }] }` |

## Endpoints: dispatcher (pharmacy app, `delivery_dispatcher`)

Guard **Ds** = `delivery.dispatch`; **Ds/D** = dispatch or `pharmacy.dispense`; **Ds/A** = dispatch or `admin.staff` (admin app works too).

| Method | Path | Guard | Body / query | Response |
|---|---|---|---|---|
| GET | `/delivery/board` | Ds | | `{ counts: { [status]: n }, ridersOnDuty, riders: [RiderRow], selfClaim, lockedCount }` |
| GET | `/delivery/deliveries` | Ds/D | `?status=&active=true&riderMembershipId=&limit=` | `[DispatchDelivery]` |
| GET | `/delivery/deliveries/:id` | Ds/D | | DispatchDelivery |
| POST | `/delivery/deliveries/:id/assign` | Ds, shift | `{ riderMembershipId }` | DispatchDelivery (`assigned`). Rider must be this provider's, verified and clocked in (`409 rider_not_verified` / `rider_off_duty`). Re-assigning an assigned job is allowed. |
| POST | `/delivery/deliveries/:id/unassign` | Ds, shift | | DispatchDelivery (`pending`) |
| POST | `/delivery/deliveries/:id/handover` | Ds/D, shift | | DispatchDelivery (`picked_up`; order `out_for_delivery`; patient gets an SMS with the code) |
| POST | `/delivery/deliveries/:id/returned` | Ds/D, shift | | DispatchDelivery (`returned`; order back to `ready`) |
| POST | `/delivery/deliveries/:id/retry` | Ds, shift | | DispatchDelivery (`pending`, `attempts + 1`) |
| POST | `/delivery/deliveries/:id/unlock` | Ds, shift | | DispatchDelivery (new code sent to the patient) |
| GET | `/delivery/riders` | Ds/A | | `[RiderRow]` |
| POST | `/delivery/riders` | Ds/A | `{ membershipId, vehicle?, plate?, licence?, status? }` | RiderRow (creates the profile) |
| PATCH | `/delivery/riders/:id` | Ds/A | `{ vehicle?, plate?, licence?, status?: 'pending'\|'verified'\|'suspended' }` (`:id` = profileId) | RiderRow. Verifying needs vehicle and licence. |

`vehicle` is one of `motorcycle, bicycle, car, van, tricycle, on_foot`.

## Endpoints: rider app (`X-MC-App: rider`)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/rider/profile` | | `{ id, status, vehicle, plate, licence, verifiedAt }` or `{ status: 'no_profile' }` |
| PUT | `/rider/profile` | `{ vehicle, plate?, licence }` | profile (changing details sends it back to `pending` for the dispatcher to verify) |
| GET | `/rider/jobs` | | `{ active: [RiderJob], recent: [RiderJob] }` |
| GET | `/rider/jobs/:id` | | RiderJob (only own jobs, else 404) |
| GET | `/rider/available` | | `[{ id, kind, createdAt, area, distanceKm }]` (empty unless the provider allows self-claim) |
| POST | `/rider/jobs/:id/claim` | | RiderJob (`assigned`; self-claim only) |
| POST | `/rider/jobs/:id/pickup` | | RiderJob (`picked_up`). The order must be `ready`. |
| POST | `/rider/location` | `{ lat, lng, accuracy?, heading?, speed? }` | `{ ok, at, jobsUpdated }`. Send real phone GPS (`navigator.geolocation.watchPosition`) every 10 to 20 s while on a job; max 30 per minute. |
| POST | `/rider/jobs/:id/deliver` | `{ code: '123456', lat?, lng? }` | RiderJob (`delivered`). Wrong code `400 "… N tries left"`, then `423 code_locked`. |
| POST | `/rider/jobs/:id/fail` | `{ reason: 'patient_unreachable'\|'patient_absent'\|'wrong_address'\|'patient_refused'\|'unsafe_area'\|'vehicle_problem'\|'other', note? }` | RiderJob (`failed`); `other` needs a note. Then bring the order back; the pharmacy confirms with `/delivery/deliveries/:id/returned`. |

All rider writes need a clocked-in shift and a `verified` profile (`403` otherwise).

## For the clinic module

`require('./pharmacy').createOrderFromPrescription({ prescription, pharmacyOrgId, fulfilment: 'pickup'|'delivery', address, location, requestedBy: 'doctor'|'patient' })` returns the `rx_orders` document. It claims the prescription itself (`status: 'active', routedTo: null` becomes `'sent'` with `routedTo: { pharmacyOrgId, rxOrderId }`), so the clinic does not need to update the prescription first. A prescription the clinic has already marked `sent` to that same pharmacy with `rxOrderId: null` is also accepted. It throws `404` (no such pharmacy), `400` (bad input or no delivery) or `409 already_sent`.

## Demo data

- Yaba Care Pharmacy and Grandville Hospital pharmacy: 24 formulary items each. AMOX500, AMLO5, METF500, PARA500, AL2040, ASP75 and WARF5 have 2 batches each. AMOX500 has a batch expiring in 45 days, AMLO5 is low stock, TRAM50 is controlled. Two suppliers, one received PO (OMEP20, CETI10) and one draft PO.
- Verified riders: `rider@yabacare.demo`, `rider2@yabacare.demo`, `rider@grandville.demo`. Dispatchers: `dispatch@yabacare.demo`, `dispatch.rx@grandville.demo`. Pharmacists: `pharmacist@yabacare.demo`, `pharmacist@grandville.demo`. Counter cashier: `counter@yabacare.demo`.
- `tobi@patient.demo` has an active metformin prescription from Grandville Hospital, ready to send to a pharmacy of his choice, and one delivered past order from Yaba Care.
