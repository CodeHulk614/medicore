# MediCore — Netlify edition (all-on-Netlify)

This is the same MediCore, packaged to run **entirely on Netlify**: the 11 apps as
static PWAs, and the whole API as one Netlify Function backed by **Netlify Blobs**
(free) — no separate backend host.

## It still runs locally, unchanged
`npm install` then `npm start` → http://localhost:4000 (file-based store, exactly like
the original). The serverless bits only activate on Netlify.

## Deploy to Netlify
1. Push this folder to a GitHub repo.
2. netlify.com → Add new site → Import from Git → pick the repo.
3. Netlify reads `netlify.toml`: it publishes `public/`, bundles `netlify/functions/api.js`,
   and sends every `/api/*` call to it. **Enable Netlify Blobs** (on by default for new sites).
4. Done. Visit the site; the apps install as PWAs and the API is live on the same domain.

## What changed vs the original (all additive, guarded)
- `netlify/functions/api.js` — wraps the Express app with `serverless-http`, hydrates the
  db from Netlify Blobs at the start of each request and saves it back at the end.
- `store.js` — gains a serverless mode (memory + Blobs) alongside the local file store.
- Movement (ambulances, riders) is advanced **lazily on each request** by the elapsed real
  time, since serverless has no background timers.
- `server.js` exports the app and only calls `listen()` when run directly (local).

## Honest trade-offs of the serverless edition
- **Concurrency is last-write-wins** (the whole db is one Blob). Fine for demos/pilots; for
  production move to Postgres (Neon/Supabase) behind the same `store.js` seam.
- **Real-time is near-real-time**: positions advance when someone loads/polls, not on a
  background clock. Video signalling works but is higher-latency than the always-on server.
- For heavy, always-on real-time, prefer the original on a persistent host (Render/Railway).
