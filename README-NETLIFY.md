# MediCore — Netlify edition (all-on-Netlify, Postgres-backed)

The 11 apps run as static PWAs on Netlify, and the whole API runs as one Netlify
Function. Data lives in a free hosted **Postgres** (Neon or Supabase). This is the
edition to deploy for a stable demo: writes use a row-lock so nothing gets clobbered
by the apps' polling (this is what fixes the "clock-in won't stick / everything
resets on refresh" problem).

## Deploy in 4 steps

1. **Create a free Postgres** (pick one):
   - **Neon** (neon.tech): New Project → copy the **pooled** connection string. It looks like
     `postgresql://USER:PASS@ep-xxxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require`.
   - **Supabase** (supabase.com): New project → Project Settings → Database → Connection string →
     **Connection pooling / Transaction** → copy it (ends with `?sslmode=require`).

2. **Push this folder to GitHub** and import it on Netlify (Add new site → Import from Git).
   Netlify reads `netlify.toml` automatically (publishes `public/`, bundles the function,
   redirects `/api/*`).

3. **Add the database URL to Netlify**: Site configuration → Environment variables →
   add `DATABASE_URL` = the connection string from step 1. Then **redeploy** (Deploys →
   Trigger deploy) so the function picks it up.

4. Open your site. The function auto-creates its table and seeds the demo data on the
   first request. All logins are `demo1234`.

That's it. No schema to run — the function manages its own table (`medicore_store`).

## Why this is stable now
- The entire database is one JSONB document. Every **write** runs inside a transaction
  that takes a Postgres advisory lock first, so concurrent requests are serialized and
  can't overwrite each other. **Reads never write**, so the apps' 2-second polling can no
  longer erase a clock-in or any other change.
- Verified against a real Postgres: clock-in sticks under concurrent polling, writes
  persist, and two simultaneous writes both survive (no last-write-wins).

## Optional env vars (Netlify → Environment variables)
- `JWT_SECRET` — set a strong secret for real use.
- `ENFORCE_CLOCKIN=1` — server-side clock-in enforcement.
- `TURN_URL`, `TURN_USER`, `TURN_PASS` — TURN server for video on strict mobile networks.

## It still runs locally, unchanged
`npm install` then `npm start` → http://localhost:4000 (file-based store, exactly like the
original). Postgres is only used on Netlify, when `DATABASE_URL` is set.

## Honest notes
- One JSONB document with serialized writes is ideal for a demo/pilot and completely
  consistent. It is not high-throughput: writes run one at a time. For production scale,
  the `store.js` seam is where you'd move to per-table Postgres.
- If you deploy **without** `DATABASE_URL`, the function falls back to a per-instance file
  store that does **not** persist across Netlify cold starts. Always set `DATABASE_URL` on
  Netlify.
- Movement (ambulances/riders) advances when a screen loads/polls (no background clock).
