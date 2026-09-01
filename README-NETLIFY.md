# MediCore — Netlify edition (all-on-Netlify)

The 11 apps run as static PWAs on Netlify; the whole API runs as one Netlify Function.
Data lives in a free hosted database. Pick MongoDB **or** Postgres by setting one env var:

- `MONGODB_URI`  → MongoDB (Atlas free M0)   ← set this to use Mongo
- `DATABASE_URL` → Postgres (Neon/Supabase)  ← or this to use Postgres
- neither        → local file store (for `npm start` only; not for Netlify)

Priority is MONGODB_URI, then DATABASE_URL, then file. Writes are serialized with a lock
so the apps' polling can never clobber a write (this is what makes clock-in stick).

## Deploy with MongoDB (Atlas)

1. **Create a free cluster** at mongodb.com/atlas → M0 (free).
2. **Database Access** → Add New Database User → username + password (remember them).
3. **Network Access** → Add IP Address → **Allow access from anywhere (0.0.0.0/0)**.
   Netlify Functions use changing IPs, so this is required or connections are refused.
4. **Connect → Drivers** → copy the connection string, it looks like
   `mongodb+srv://USER:PASS@cluster0.xxxx.mongodb.net/?retryWrites=true&w=majority`
   Put your real password in place of `PASS`.
5. Push this folder to GitHub and import it on Netlify (Add new site → Import from Git).
6. Netlify → **Site configuration → Environment variables** → add `MONGODB_URI` = that string.
   (Optional: `MONGODB_DB` to set the database name; default is `medicore`.)
7. **Redeploy** (Deploys → Trigger deploy). Env vars only apply to a new build.
8. Open the site. The function creates its collection and seeds the demo data on first use.
   All logins are `demo1234`. In Atlas → Browse Collections you'll see database `medicore`,
   collection `store`, with one document holding everything.

## Deploy with Postgres (Neon/Supabase) — alternative

1. Create a free Postgres (Neon or Supabase). Copy the **pooled** connection string
   (ends with `?sslmode=require`).
2. Netlify → Environment variables → add `DATABASE_URL` = that string → Redeploy.
   The function creates its table (`medicore_store`) and seeds on first use.

## Why it's stable
- The whole database is one document. Every **write** takes a lock first (a Mongo lock
  document, or a Postgres advisory lock), so concurrent requests are serialized and can't
  overwrite each other. **Reads never write**, so 2-second polling can't erase a clock-in.
- Verified: clock-in sticks under concurrent polling, writes persist, and two simultaneous
  writes both survive (no last-write-wins) — on both Mongo and Postgres.

## Still runs locally
`npm install` then `npm start` → http://localhost:4000 (file store). The database is only
used on Netlify, when `MONGODB_URI` or `DATABASE_URL` is set.

## Optional env vars
`JWT_SECRET` (set a strong secret), `ENFORCE_CLOCKIN=1`, and `TURN_URL`/`TURN_USER`/`TURN_PASS`
(video on strict mobile networks).

## Honest notes
- One document with serialized writes is fully consistent and ideal for a demo/pilot; writes
  run one at a time, so it's not high-throughput. For production scale, move `store.js` to
  per-collection/table storage.
- Deploy **without** a DB env var and Netlify falls back to a per-instance file store that
  does not persist across cold starts. Always set `MONGODB_URI` (or `DATABASE_URL`) on Netlify.
- Atlas note: if the site can't connect, it's almost always the Network Access allow-list
  (must include 0.0.0.0/0) or a wrong password in the URI.
