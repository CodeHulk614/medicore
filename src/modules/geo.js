'use strict';
/*
 * Address search and reverse lookup, proxied through the API so the apps can keep a strict
 * Content-Security-Policy and so the geocoder can be swapped by config (GEOCODER_URL).
 * Default: Photon (komoot) public instance, which is for light use; set GEOCODER_URL to a
 * paid or self-hosted Photon/Nominatim-compatible service for production volume.
 * Results are biased to Nigeria. Rate limited per user/IP.
 */
const express = require('express');
const https = require('https');
const config = require('../config');
const { ah, query, t } = require('../lib/http');
const RL = require('../lib/ratelimit');

const router = express.Router();
const BASE = () => config.GEOCODER_URL || 'https://photon.komoot.io';

function getJSON(url) {
  return new Promise(resolve => {
    const req = https.get(url, { timeout: 6000, headers: { 'User-Agent': 'MediCore/2.0 (+https://medicore.ng)' } }, res => {
      let b = ''; res.on('data', c => { b += c; if (b.length > 2e6) req.destroy(); }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
const label = p => [p.name, p.housenumber && p.street ? p.housenumber + ' ' + p.street : p.street, p.district || p.suburb, p.city || p.town || p.village, p.state].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');

router.get('/geo/search', ah(async (req, res) => {
  const q = query(req, { q: t.str({ required: true, min: 3, max: 120 }), lat: t.lat(), lng: t.lng() });
  await RL.limit('geo_' + (req.ctx.user ? req.ctx.user.id : RL.ipOf(req)), 60, 600);
  const u = new URL('/api/', BASE()); u.searchParams.set('q', q.q); u.searchParams.set('limit', '8'); u.searchParams.set('lang', 'en');
  u.searchParams.set('lat', String(q.lat != null ? q.lat : 6.5244)); u.searchParams.set('lon', String(q.lng != null ? q.lng : 3.3792));
  u.searchParams.set('bbox', '2.6,4.2,14.7,13.9');
  const j = await getJSON(u.toString());
  if (!j || !Array.isArray(j.features)) return res.json({ results: [], available: false });
  res.json({ available: true, results: j.features.map(f => ({ label: label(f.properties || {}), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] })).filter(r => r.label) });
}));
router.get('/geo/reverse', ah(async (req, res) => {
  const q = query(req, { lat: t.lat({ required: true }), lng: t.lng({ required: true }) });
  await RL.limit('georev_' + (req.ctx.user ? req.ctx.user.id : RL.ipOf(req)), 60, 600);
  const u = new URL('/reverse', BASE()); u.searchParams.set('lat', String(q.lat)); u.searchParams.set('lon', String(q.lng)); u.searchParams.set('lang', 'en');
  const j = await getJSON(u.toString());
  const f = j && j.features && j.features[0];
  res.json({ available: !!j, label: f ? label(f.properties || {}) : null });
}));

module.exports = { name: 'geo', router };
