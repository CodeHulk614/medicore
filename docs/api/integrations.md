# Plug-and-play integrations, connectors and the compliance register

Everything here is set in **HQ > Configuration**, versioned and restorable like every other setting. Keys are encrypted at rest and never sent back (responses show `{ set: true, last4 }`). Saving a key never needs a redeploy.

## Settings section `integrations` (PATCH `/api/hq/config/integrations` with `{ patch: {...} }`, perm platform.integrations)

| Path | What |
|---|---|
| `payments.provider` | `paystack` \| `flutterwave` \| `monnify` \| `custom` \| `none` (which gateway takes online payments) |
| `payments.label` | name shown to patients (e.g. your bank's name) |
| `payments.settleToProviders` | send each provider's money to its own settlement subaccount when set |
| `paystack.publicKey`, `paystack.secretKey`* | Paystack |
| `flutterwave.publicKey`, `flutterwave.secretKey`*, `flutterwave.webhookHash`* | Flutterwave (webhook hash = the "secret hash" set in the Flutterwave dashboard) |
| `monnify.apiKey`, `monnify.secretKey`*, `monnify.contractCode`, `monnify.baseUrl` | Monnify (`https://sandbox.monnify.com` for testing) |
| `customPayment.label`, `customPayment.baseUrl` | a bank's or any gateway's collection API |
| `customPayment.auth.type` | `none` \| `bearer` \| `basic` \| `header` \| `oauth2` |
| `customPayment.auth.headerName`, `.token`*, `.username`, `.password`*, `.tokenUrl`, `.clientId`, `.clientSecret`*, `.scope` | auth details (oauth2 = client credentials) |
| `customPayment.init.method`, `.path`, `.bodyTemplate`, `.checkoutUrlPath`, `.providerRefPath` | start a payment: `path` is appended to `baseUrl`; `bodyTemplate` is JSON with placeholders `{{reference}} {{amountKobo}} {{amountNaira}} {{email}} {{phone}} {{name}} {{callbackUrl}} {{orgName}} {{settlementAccount}} {{settlementBankCode}} {{settlementSubaccount}}`; `checkoutUrlPath` is where the checkout link is in the reply (dot path, e.g. `data.checkoutUrl`) |
| `customPayment.verify.method`, `.path`, `.statusPath`, `.successValues`, `.amountPath`, `.amountUnit` | confirm a payment: `path` may use `{{reference}}`; `successValues` comma list (e.g. `success,paid`); `amountUnit` `kobo` or `naira` |
| `customPayment.webhook.signatureHeader`, `.algorithm` (`sha512`\|`sha256`\|`none`), `.secret`*, `.referencePath`, `.statusPath`, `.amountPath` | the gateway's webhook to `POST /api/pay/custom/webhook` (HMAC of the raw body). With `none`, the webhook only triggers a verify call |
| `sms.provider` | `termii` \| `africastalking` \| `custom` \| `none` |
| `termii.apiKey`*, `termii.senderId` | Termii |
| `africastalking.username`, `.apiKey`*, `.senderId` | Africa's Talking (`sandbox` username for testing) |
| `customSms.url`, `.method`, `.contentType` (`json`\|`form`), `.headerName`, `.token`*, `.bodyTemplate`, `.successStatus` | any HTTP SMS API: template placeholders `{{to}} {{toNoPlus}} {{text}} {{sender}}` |
| `turn.*`, `maps.*`, `geocoder.url`, `routing.url`, `ussd.secret`*, `ai.*`, `whatsapp.*`, `email.*` | unchanged |

(* = secret)

Webhook URLs to give each gateway: `/api/pay/paystack/webhook`, `/api/pay/flutterwave/webhook`, `/api/pay/monnify/webhook`, `/api/pay/custom/webhook`.

Settlement accounts: each provider (or each branch, set by its group) can store `{ bankName, bankCode, accountNumber, accountName, subaccount }` (`PATCH /api/admin/org/settlement`, `PATCH /api/group/branches/:id/settlement`). The active gateway uses `subaccount` (Paystack subaccount, Flutterwave subaccount id, Monnify subaccount code) or the account placeholders in a custom template.

## Connection tests
`POST /api/hq/config/test/:integration` for `paystack`, `termii`, `ai`, `flutterwave`, `monnify`, `customPayment`, `africastalking`, and `sms` (body `{ to: phone }` sends a real test SMS through the active gateway). Result `{ ok, status, message }`.

## Go-live checklist
`GET /api/hq/integrations/status` -> `{ integrations: [{ key, label, provider?, providerLabel?, ready, needs }], compliance: [{ key, label, status, enforce, blocksFeatures, expiresOn, blocking }], partners: [{ key, name, kind, status, endsOn }] }`.

## Outgoing connectors (send events to any outside system)
| Method | Path | Notes |
|---|---|---|
| GET | `/api/hq/connectors` | `{ connectors: [{ id, label, url, events, active, orgIds, secretSet, lastAt, lastOk, lastStatus, createdAt }], events: { key: description } }` |
| POST | `/api/hq/connectors` | `{ label, url (https), events: ['referral.sent', ...] or ['*'], secret?, active?, orgIds? }` |
| PATCH | `/api/hq/connectors/:id` | same fields, all optional (`secret: ''` clears) |
| POST | `/api/hq/connectors/:id/delete` | |
| POST | `/api/hq/connectors/:id/test` | sends `connector.test` |
| GET | `/api/hq/connectors/:id/deliveries` | `[{ id, event, at, ok, status, error, payload }]` |
| POST | `/api/hq/connectors/deliveries/:id/retry` | |

Each delivery: `POST url` with JSON `{ deliveryId, event, at, data }`, headers `X-MediCore-Event`, `X-MediCore-Delivery`, `X-MediCore-Signature: sha256=<HMAC-SHA256 of the body with the connector secret>`. `data` holds ids and amounts only. Events: `patient.registered, patient.application, patient.application_approved, referral.sent, referral.accepted, referral.declined, referral.completed, payment.success, bill.paid, org.signup, org.approved, group.branch_created, claim.submitted`.

## Settings section `compliance` (PATCH `/api/hq/config/compliance`, perm platform.config)
```
compliance.items.<key> = { label, status: not_started|in_progress|submitted|done|expired|not_needed, reference, issuedOn, expiresOn, docUrl (https), owner, notes, enforce: bool, blocksFeatures: ['marketplace', 'videoVisits', ...] }
compliance.partners.<key> = { name, kind (hmo|bank|payment|sms|telecom|regulator|insurer|other), status: prospect|negotiating|signed|live|paused|ended, contact, email, phone, startsOn, endsOn, terms, docUrl, notes }
```
Built-in items: `ndpc`, `dpo`, `dpia`, `pcn` (blocks `marketplace` when enforced), `hefamaa` (blocks `videoVisits`), `paystackKyc`, `smsSender`, `ussdCode` (blocks `ussd`). New items can be added with any key; `null` removes one. **An item with `enforce: true` and a status other than `done` switches off the features it lists, everywhere** (server checks and the apps' `MC.feature`).

## Other new settings
- `process.patients`, `process.branches`, `process.referrals` (see patient-mode.md, groups.md, network.md)
- `pricing.branchDiscounts: [{ minBranches, percent }]`
- `features.groups`, `features.referralNetwork`, `features.providerMessaging`, `features.providerDirectory`
