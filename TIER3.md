# Tier 3: from pilot to production

Tier 2 (done) is a real, connected app: accounts, a shared server, the patient and
hospital seeing one record, real device biometrics, and adapters ready for payments,
SMS, and video. It runs and is verified.

Tier 3 is what turns a working pilot into something you can safely run for real
patients at scale. Most of it is engineering plus business plus legal, not a single
build. Here is the honest map, and where I can help versus where only you can act.

## 1. Data protection and compliance (do first, before real patient data)
- NDPR compliance: lawful basis, consent capture, data subject rights, a retention
  policy, and a registered Data Protection Officer. This is legal work; I can build
  the consent screens and the data-export and delete-my-data features.
- Encryption at rest for the database, and TLS everywhere (Render gives you TLS).
- Secrets management: keys in a vault, not in code or plain env where avoidable.
- I can build: an audit log of every access, consent flows, and export/delete. You
  handle: the legal registration and policy.

## 2. Security hardening
- Rate limiting, brute-force protection on login, account lockout.
- Refresh tokens and short-lived access tokens, not one long-lived token.
- Input validation on every endpoint, and role checks reviewed.
- A real database (Postgres) with backups and point-in-time recovery, replacing the
  JSON file. The data layer is already isolated so this swap is contained.
- A penetration test before go-live. I can prepare the checklist and fixes; the test
  itself should be an independent firm.

## 3. Real integrations (each needs your account or an agreement)
- Payments: Paystack or Flutterwave merchant account, webhooks to confirm settlement,
  reconciliation. I wire it; you provide the account.
- SMS and email: Termii or Africa's Talking, with a registered sender ID.
- Video: Daily.co or Agora for real telemedicine, with recording and consent.
- HMO and NHIA claims: a signed integration with each payer. This is the hardest and
  most valuable, and it is a business development effort, not a code task. Once an
  agreement and endpoint exist, wiring it is a day of work.

## 4. Connect the hospital side fully
- The backend already exposes the hospital endpoints and proves the shared record.
  The clinician app (the big MediCore console) still needs to be rewired from its
  demo data to these same APIs, so staff actions and patient actions meet in one
  place. This is a real build I can do next, mirroring what was done for the patient
  app.

## 5. Reliability and operations
- Monitoring and error tracking (for example Sentry), uptime alerts, log retention.
- Automated database backups and a tested restore.
- A staging environment separate from production.

## 6. Release
- App store publishing via EAS build and submit (Google Play, Apple). Needs the
  developer accounts (your business, your fee) and store review. I set up the build
  config; you own the accounts and the listings.
- Versioned API and over-the-air updates for the app.

## Suggested order
1. Wire the hospital app to the backend (finishes the "one record" story).
2. Swap the JSON store for Postgres, add backups.
3. Add auth hardening, rate limits, audit log, consent and data-rights screens.
4. Turn on payments and SMS with your accounts.
5. NDPR sign-off and a security review.
6. Video and, in parallel, begin HMO agreements.
7. EAS build and store release.
