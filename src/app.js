'use strict';
/*
 * Express application. Same app runs locally (server.js) and on Netlify (netlify/functions/api.js).
 */
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const db = require('./db');
const config = require('./config');
const { errorHandler, notFound } = require('./lib/http');
const { loadSession, apiGuard } = require('./lib/auth');
const modules = require('./modules');
const bootstrap = require('./bootstrap');

function createApp({ serveStatic = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false); // client IPs come from Netlify's own header (see lib/ratelimit ipOf)

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // health is answered before anything that can fail
  app.get('/api/health', async (req, res) => {
    const out = { ok: !config.configProblem, version: '2.0.0', db: null, demoMode: config.DEMO_MODE,
      integrations: { payments: (() => { const g = require('./lib/payments').active(); return g.configured ? g.name : (config.DEMO_MODE ? 'demo' : 'off'); })(), sms: (() => { const s2 = require('./lib/sms').active(); return s2.configured ? s2.name : 'dev'; })(), ussd: config.USSD_SECRET ? 'on' : 'off', turn: config.TURN_URL ? 'on' : 'stun-only', routing: config.ROUTING_URL ? 'on' : 'straight-line' } };
    if (config.configProblem) out.problem = config.configProblem;
    try { await db.init(); await db.store.ping(); out.db = db.kind; } catch (e) { out.ok = false; out.db = 'error'; out.problem = out.problem || 'Database not reachable'; }
    res.status(out.ok ? 200 : 503).json(out);
  });

  app.use('/api', (req, res, next) => {
    if (config.configProblem) return res.status(503).json({ error: 'The server is not configured yet: ' + config.configProblem + '. Set it in your Netlify environment variables and redeploy.', code: 'not_configured' });
    db.init().then(() => bootstrap.ensure()).then(() => require('./lib/settings').load()).then(() => next(), next);
  });
  app.use('/api', cookieParser());
  app.use('/api', express.json({ limit: '200kb', verify: (req, res, buf) => { if (/^\/api\/(pay\/[a-z]+|whatsapp)\/webhook/.test(req.originalUrl)) req.rawBody = buf.toString('utf8'); } }));
  app.use('/api', express.urlencoded({ extended: false, limit: '20kb' }));
  app.use('/api', apiGuard);
  app.use('/api', loadSession);
  // maintenance mode (set in HQ): everyone except the MediCore team gets a clear message on writes
  app.use('/api', (req, res, next) => {
    const S = require('./lib/settings');
    if (!S.feature('maintenanceMode') || req.ctx.app === 'hq' || ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || /^\/api\/auth\//.test(req.originalUrl)) return next();
    res.status(503).json({ error: S.get('features.maintenanceMessage') || 'MediCore is under maintenance. Please try again shortly.', code: 'maintenance' });
  });
  for (const m of modules) if (m.router) app.use('/api', m.router);
  app.use('/api', (req, res, next) => next(notFound('No such API endpoint')));

  if (serveStatic) {
    const pub = path.join(__dirname, '..', 'public');
    // same security headers Netlify sends (netlify.toml), so local testing matches production
    app.use((req, res, next) => {
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: https://*.tile.openstreetmap.org https://tile.openstreetmap.org https://*.basemaps.cartocdn.com https://api.maptiler.com; font-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://checkout.paystack.com; object-src 'none'");
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=(self), payment=()');
      next();
    });
    app.use(express.static(pub, { extensions: ['html'], setHeaders: (res, p) => { if (/\.(html|js|css|webmanifest)$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); if (p.endsWith('.webmanifest')) res.setHeader('Content-Type', 'application/manifest+json'); } }));
  }
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
