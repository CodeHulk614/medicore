# Start here: put MediCore v2 online

You will create (or reuse) three free accounts: **MongoDB Atlas** (the database), **GitHub** (stores the code) and **Netlify** (hosts the apps and the API). Allow about 40 minutes the first time. No coding needed.

## 1. Database: MongoDB Atlas

1. Go to mongodb.com/atlas, sign in, and create a **free M0 cluster**. For region, pick **AWS Cape Town (af-south-1)** if it is offered on your plan; otherwise the nearest Europe region. Write down which one you chose: you will declare it as your data location (NDPA).
2. **Database Access** > Add user > username + a generated password. Save both.
3. **Network Access** > Add IP address > **Allow access from anywhere (0.0.0.0/0)**. Netlify uses changing addresses, so this is required. Your strong password protects the database.
4. **Connect** > Drivers > copy the connection string and put your real password in it:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`

## 2. Code: GitHub

1. Unzip `medicore-v2-source.zip` on your computer.
2. On github.com create a new **private** repository (for example `CodeHulk614/medicore`). If the old v1 repository is there, create a new one or a new branch; do not mix the two.
3. On the new repository page, click **uploading an existing file**, drag in everything from the unzipped folder (including the `public`, `src`, `netlify`, `docs`, `scripts` and `test` folders, `package.json`, `package-lock.json`, `netlify.toml`, `server.js`). Commit.
   Do **not** upload a `node_modules` folder if you have one.

## 3. Hosting: Netlify

1. app.netlify.com > **Add new site > Import an existing project** > GitHub > pick the repository.
2. Build settings: leave the build command empty; publish directory `public` (both are already set in `netlify.toml`). Deploy.
3. **Site configuration > Environment variables**, add (see `docs/ENVIRONMENT.md` for details):

   | Key | Value |
   |---|---|
   | `MONGODB_URI` | your connection string from step 1 |
   | `JWT_SECRET` | a long random string (64+ characters) |
   | `SETTINGS_KEY` | a different long random string. Keep a copy somewhere safe forever. |
   | `PLATFORM_ADMIN_EMAIL` | your email |
   | `PLATFORM_ADMIN_PASSWORD` | a strong temporary password |
   | `DATA_LOCATION` | for example `MongoDB Atlas, AWS af-south-1 (Cape Town)` |
   | `DPO_EMAIL` | your Data Protection Officer's email |

   For a **demo site only** (fictional data, never real patients) also add `DEMO_MODE` = `1`.
4. **Deploys > Trigger deploy > Deploy site.** Environment variables only apply to a new deploy.

To make a random secret: open any browser, press F12, Console, paste `crypto.getRandomValues(new Uint8Array(48)).reduce((s,b)=>s+b.toString(16).padStart(2,'0'),'')` and press Enter.

## 4. Check it works

1. Open `https://YOUR-SITE.netlify.app/api/health`. You should see `"ok":true` and `"db":"mongo"`. If it says `not_configured`, a variable is missing or too short; fix it and redeploy.
2. Open `https://YOUR-SITE.netlify.app/hq.html`, sign in with `PLATFORM_ADMIN_EMAIL` and the temporary password, then set your own password.
3. In HQ: **Configuration > Look and feel** (product name, colours), **Texts** (privacy and terms links, crisis lines), **Pricing**, **Integrations** (pick the payment gateway and SMS gateway and paste their keys when you have the accounts), **Compliance** (track NDPC, PCN, HEFAMAA and the other registrations, and your HMO and bank agreements). The **Go-live checklist** shows what is still missing.
4. Providers sign up at `/register.html#/provider` (hospital groups tick "We have more than one branch"). Approve them in HQ > Providers. Their staff then use the apps below; a group's head office uses `/group.html` to add branches and run them.

## The apps

| Page | Who uses it |
|---|---|
| `/index.html` | Patients (sign up at `/register.html#/patient`) |
| `/register.html` | Patient and provider sign-up |
| `/frontdesk.html` | Reception, cashiers, records, nurses, customer care |
| `/doctor.html` | Doctors |
| `/pharmacy.html` | Pharmacists, technicians, delivery dispatchers |
| `/rider.html` | Delivery riders |
| `/dispatch.html` | Ambulance dispatchers |
| `/crew.html` | Ambulance crew |
| `/lab.html` | Lab reception, scientists, lab managers |
| `/chw.html` | Community health workers |
| `/payer.html` | HMO officers and managers |
| `/admin.html` | Each provider's (or branch's) owner and administrators |
| `/group.html` | The head office of a hospital group: every branch, staff in every branch, consolidated subscription and reports |
| `/hq.html` | The MediCore team (you and your developers) |

Version 2.3 adds the collaborative marketplace: the patient marketplace (map, provider pages, stock, subscription), shared care between providers, documents (scans, verifiable letters, signed consent forms), stores and beds, public hospitals and emergency transfers, and HMOs running plans, networks and capitation on MediCore. See `docs/api/marketplace.md`. Anyone can check a MediCore letter at `/register.html#/verify`.

Each page installs as its own phone app: open it in Chrome on Android, menu > **Install app** (iPhone: Safari > Share > Add to Home Screen).

## Demo mode accounts (only when `DEMO_MODE=1`)

Password for all: `Demo2026!`. HQ: `hq@medicore.demo`. Providers: Grandville Hospital (full hospital), Lekki Family Clinic (clinic only), Yaba Care Pharmacy (standalone pharmacy with riders), SwiftAid Ambulance (standalone ambulance service), ClearPath Diagnostics (standalone lab), Harbor Health HMO. Staff emails follow `role@provider.demo`, e.g. `owner@grandville.demo`, `reception@grandville.demo`, `dr.tunde@grandville.demo`, `pharmacist@yabacare.demo`, `rider@yabacare.demo`, `dispatch@swiftaid.demo`, `crew@swiftaid.demo`, `scientist@clearpath.demo`, `officer@harborhmo.demo`. Hospital group: Crestview Hospitals with branches Ikeja and Ajah: group console `owner@crestview.demo` (owner) and `ops@crestview.demo` (group administrator), branch admins `admin.ikeja@crestview.demo` and `admin.ajah@crestview.demo`, front desks `reception.ikeja@crestview.demo` and `reception.ajah@crestview.demo`. Patients: `amaka@patient.demo` (four providers, so her app shows the provider switcher), `tobi@patient.demo` (has a pending application to Crestview Ajah and an open referral from Yaba Care Pharmacy to Grandville), `kunle@patient.demo`, `ngozi@patient.demo` (Crestview patient). The full list is in HQ > Demo.

## What needs your accounts or partnerships (not code)

| Item | Why | Where it goes |
|---|---|---|
| A payment gateway live account: Paystack, Flutterwave or Monnify (business KYC), or your bank's collection API | Real online payments. Without it: counter payments only (demo payments in demo mode). A bank's API is connected without code through the bank connector (endpoints, auth, body template). | HQ > Integrations > Payments |
| An SMS account and approved sender ID: Termii, Africa's Talking, or any HTTP SMS API | SMS codes, pickup/delivery codes, alerts | HQ > Integrations > SMS |
| TURN relay (e.g. Metered or Twilio) | Video calls on strict mobile networks | HQ > Integrations > TURN |
| Map tile and geocoding plan (MapTiler, Stadia, or self-hosted) | OpenStreetMap's public servers are for light use only | HQ > Integrations > Maps / Address search |
| USSD short code from an aggregator (e.g. Africa's Talking) | Feature-phone access | HQ > Integrations > USSD; point the aggregator at `/api/ussd` |
| AI provider account and key | Patient assistant, lab explanations, note drafting | HQ > Integrations > AI; then HQ > Features |
| NDPC registration as a data controller of major importance, a DPO, a DPIA | Required for health data under the NDPA 2023 and GAID 2025 | Legal |
| PCN registration as an Electronic Pharmacy Aggregator, with a superintendent pharmacist | Likely required once patients can order from many pharmacies (PCN Electronic Pharmacy Regulations 2026) | Legal |
| HEFAMAA registration (Lagos) for telemedicine, and each provider's own licences | Facility and service licensing | Legal |
| HMO agreements | Real claims exchange with each HMO | Business |
| Native-speaker review of Pidgin, Yoruba, Hausa and Igbo | The translations are machine-assisted | HQ > Configuration > Translations |
| WhatsApp Business Platform (Meta): verified Meta Business account, a WhatsApp Business account, the platform number, an access token, app secret and two approved templates | Automated WhatsApp updates, codes and two-way chats in each department's inbox. Without it, the department WhatsApp numbers still work as click-to-chat buttons for patients | HQ > Integrations > WhatsApp (webhook: `/api/whatsapp/webhook`); each provider adds its department numbers in Admin > Contact numbers |
| Each provider's own WhatsApp numbers added to the platform's WhatsApp Business account (optional) | Chats on a hospital's or department's own number arrive in that department's inbox | Meta Business Manager, then the number's phone number ID in Admin > Contact numbers |
| An email gateway (SendGrid, Brevo, Mailgun or Resend) with a verified sender address | Pre-authorisation requests and claim files to HMOs that are not on the platform | HQ > Integrations > Email |
| Systems that should receive events (bank, ERP, HMO claims system) | Optional: send referrals, payments and approvals to them automatically | HQ > Connectors |
| A verified list of public hospitals (government teaching hospitals, federal medical centres, general hospitals, PHCs) with emergency and referral-desk numbers, for example an export from the Federal Ministry of Health facility registry plus calls to check each number | Emergency transfers and the "hospitals near me" map. The demo listings are fictional | HQ > Public hospitals > Import a spreadsheet |
| NHIA accreditation of each HMO you approve, and its provider agreements | HMOs selling plans and paying capitation through MediCore | HQ > Compliance (NHIA item); check before approving the HMO |
| An account with a NIN verification partner licensed by NIMC (for example Dojah, Prembly, YouVerify or Smile ID), a data processing agreement, and per-check credit (about NGN 60 a check) | Automatic NIN checks when patients sign up and when providers and HMOs register them. Without it, NINs are saved as pending and staff confirm them by hand | HQ > Integrations > Video, maps, USSD and AI > NIN verification; HQ > Compliance (NIMC item) |
| A Google Play developer account (USD 25) and an Apple developer account (USD 99 a year), and the MediCore phone app built natively | Reading Android Health Connect and Apple Health (browsers cannot), and background GPS for the ambulance crew and rider apps | Built during product completion; everything else stays a web app |
| A wearables partner account, for example Terra (from about USD 499 a month for about 500 connected users) | Watch brands' cloud accounts: Garmin, Withings, Oura, Polar, Huawei. Not needed for the phone app, Bluetooth or typed readings | HQ > Integrations > Wearables partner; webhook /api/wearables/webhook/terra |
| Marketplace prices that make sense with the bank charge (consider quarterly or yearly access) | Patients pay MediCore for marketplace access through the payment gateway | HQ > Configuration > Processes > Patient marketplace |

Track every registration and agreement in **HQ > Compliance**. An item there can be set to *enforce*: until it is marked done, the features it lists stay switched off everywhere (for example PCN registration blocks the open pharmacy marketplace, HEFAMAA blocks video visits).

## Running it on your own computer (optional)

Install Node.js 20+, then in the folder: `npm install`, then `DEMO_MODE=1 npm start` (Windows PowerShell: `$env:DEMO_MODE=1; npm start`) and open http://localhost:4000/hq.html. Run the automated tests with `npm test`.

## What changed in v2.5 (October 2026)

- New app look in every app. On phones: a frosted top bar, a floating glass tab bar, cards with soft depth, pill buttons, chip-style tabs, rounder fields and bottom sheets for dialogs. On computers the same rounding and depth, with the side menu kept.
- A provider's own colour now works in dark mode too.
- All of it lives in public/assets/mc.css (the "App look" section at the end), so colours, rounding and glass strength can be tuned in one place.

## What changed in v2.4.1 (October 2026)

- Demo loading on Netlify is fast enough to finish inside one request (about 2 seconds instead of over 10). The demo is built in memory and copied to MongoDB in bulk.
- A half-finished earlier demo load is cleared and loaded again automatically. This fixes "That already exists" on sign-in.
- Two cold starts can no longer load the demo at the same time.
- DEMO_MODE never wipes a database that holds non-demo accounts; it stops with a clear message instead.

## What changed in v2.4 (October 2026)

- Patients register with a NIN, checked with a licensed NIMC partner. The NIN itself is never stored, only a keyed fingerprint and the last 4 digits. Staff can register without one when they give a reason (a child, an emergency, not yet enrolled).
- A self-registered patient joins their first provider free; joining more needs the marketplace subscription (NGN 2,500 a month, 6,750 a quarter, 25,000 a year). Referrals and shared care between providers stay free.
- HMOs register their clients as an institution (HMO app > Members > Register a client). Providers that find a patient by NIN see the HMO and whether they are in its network; after the patient's code they see the plan, validity, primary provider and claims.
- Patients with no HMO browse and buy any HMO's plans free; patients who already have cover need the marketplace to compare others. A network provider can start an HMO plan for an uninsured patient at the desk.
- Every staff member has a cryptographic staff ID (anyone can check it at /api/verify/staff/ID). Every clock-in is signed and numbered, and Admin > Attendance > Check the records shows any record edited or deleted.
- Emergency SOS: any patient can call any nearby ambulance service, with no subscription; the trip is billed to the patient's account.
- One person, one record: every patient gets a MediCore patient ID for life (MCP-XXXX-XXXX). A second record is refused when the NIN, phone or email already exists; providers find the person by NIN, patient ID, phone or email and link them with the patient's code.
- Health devices (Patient app > More > Health devices): readings from the phone's health app (Android Health Connect, Apple Health) arrive through the MediCore phone app; watch brands (Garmin, Withings, Oura, Polar, Huawei) through a wearables partner (HQ > Integrations > Wearables partner); Bluetooth heart-rate devices in Chrome on Android; home devices typed in. Providers the patient shares with see the readings, and a doctor can ask for a fresh reading during a video visit. Summaries use the AI assistant when it is on, and plain rules otherwise.

