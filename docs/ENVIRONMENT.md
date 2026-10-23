# Environment variables

Set these in **Netlify > Site configuration > Environment variables**, then redeploy. Only the first group is required. Everything else can also be set later, without a redeploy, in **MediCore HQ > Configuration > Integrations** (HQ values win over environment values).

## Required

| Variable | What it is | Example |
|---|---|---|
| `MONGODB_URI` | MongoDB Atlas connection string | `mongodb+srv://user:pass@cluster0.xxxx.mongodb.net/?retryWrites=true&w=majority` |
| `JWT_SECRET` | Long random secret for sign-in sessions. At least 32 characters. The server refuses to run without it. | 64 random characters |
| `SETTINGS_KEY` | Long random secret used to encrypt integration keys saved in HQ. Keep it forever: changing it makes saved keys unreadable. | 64 random characters |
| `PLATFORM_ADMIN_EMAIL` | Email of the first MediCore HQ owner (created once, on an empty database) | `you@yourcompany.com` |
| `PLATFORM_ADMIN_PASSWORD` | Their first password. They must change it at first sign-in. | a strong temporary password |

Generate secrets on any computer with: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

## Optional

| Variable | Default | What it turns on |
|---|---|---|
| `MONGODB_DB` | `medicore` | Database name |
| `DEMO_MODE` | off | `1` loads fictional demo providers and accounts (password `Demo2026!`), shows SMS codes on screen and allows test payments. **Never on a live site with real patients.** |
| `PUBLIC_URL` | Netlify URL | Your site address, used in payment return links |
| `ALLOWED_ORIGINS` | none | Extra web origins allowed to call the API (comma separated) |
| `SESSION_HOURS` | `12` | Default sign-in length (HQ can change it) |
| `DATA_LOCATION` | not declared | Where the database is hosted, shown in HQ for NDPA records (for example `MongoDB Atlas, AWS eu-west-1`) |
| `DPO_EMAIL` | none | Data Protection Officer contact shown in HQ |
| `PAYSTACK_SECRET`, `PAYSTACK_PUBLIC` | none | Live card, transfer and USSD payments. Without them, payments are counter-only (or demo in demo mode). |
| `TERMII_KEY`, `TERMII_SENDER` | none | Real SMS (sign-up codes, pickup and delivery codes, alerts). Without them SMS is not sent. |
| `TURN_URL`, `TURN_USER`, `TURN_PASS` | none | Video calls on strict mobile networks (a TURN relay, e.g. Twilio or Metered) |
| `MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION` | OpenStreetMap public tiles | A map tile provider for production volume (MapTiler, Stadia, Carto) |
| `GEOCODER_URL` | Photon public instance | Address search provider for production volume |
| `ROUTING_URL` | none (straight-line ETAs) | OSRM-compatible routing for road ETAs |
| `USSD_SECRET` | none (USSD off) | Shared secret your USSD aggregator sends with each request |
| `AI_API_KEY`, `AI_BASE_URL` | none (rule-based assistant) | AI assistant key (provider and model are chosen in HQ) |
| `WHATSAPP_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_PHONE_NUMBER_ID` | none | WhatsApp Business Platform (normally pasted in HQ > Integrations > WhatsApp instead) |
| `EMAIL_API_KEY`, `EMAIL_FROM` | none | Email gateway key and sender (choose the gateway in HQ > Integrations > Email) |
| `FLW_SECRET`, `FLW_PUBLIC`, `FLW_HASH` | none | Flutterwave keys (choose Flutterwave in HQ > Integrations > Payments) |
| `MONNIFY_KEY`, `MONNIFY_SECRET`, `MONNIFY_CONTRACT` | none | Monnify keys (choose Monnify in HQ) |
| `AT_USERNAME`, `AT_API_KEY` | none | Africa's Talking SMS (choose it in HQ > Integrations > SMS) |

You normally leave all of the optional integration variables out and paste the keys in **HQ > Configuration > Integrations** instead. That is where you also pick which payment gateway (Paystack, Flutterwave, Monnify, or your bank's own API through the no-code bank connector) and which SMS gateway (Termii, Africa's Talking, or any HTTP SMS API) are used, and where outgoing connectors to other systems are set up. See `docs/api/integrations.md`.
