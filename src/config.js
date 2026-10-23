'use strict';
/*
 * All configuration comes from environment variables. Nothing secret lives in code.
 * See docs/ENVIRONMENT.md for the full list and what each one turns on.
 */
const crypto = require('crypto');
const env = process.env;

const isNetlify = !!(env.NETLIFY || env.AWS_LAMBDA_FUNCTION_NAME || env.MC_SERVERLESS === '1');
const isTest = env.NODE_ENV === 'test' || env.MC_TEST === '1';
const isProd = env.NODE_ENV === 'production' || (isNetlify && env.CONTEXT === 'production');

let jwtSecret = env.JWT_SECRET || '';
const jwtSecretProblem = jwtSecret.length < 32
  ? (jwtSecret ? 'JWT_SECRET is shorter than 32 characters' : 'JWT_SECRET is not set')
  : null;
if (jwtSecretProblem && !isProd && !isNetlify) {
  // local dev or tests: random per-process secret, sessions end when the process restarts
  jwtSecret = crypto.randomBytes(48).toString('hex');
}

const config = {
  isNetlify, isTest, isProd,
  PORT: Number(env.PORT) || 4000,
  MONGODB_URI: env.MONGODB_URI || '',
  MONGODB_DB: env.MONGODB_DB || 'medicore',
  DB_FILE: env.DB_FILE || '',
  JWT_SECRET: jwtSecret,
  // a deployed server refuses to run (every API call answers 503) when the secret is unsafe
  configProblem: (isProd || isNetlify) && jwtSecretProblem ? jwtSecretProblem : null,
  SESSION_HOURS: Number(env.SESSION_HOURS) || 12,
  DEMO_MODE: env.DEMO_MODE === '1',
  ALLOWED_ORIGINS: (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  PUBLIC_URL: env.PUBLIC_URL || env.URL || '',
  TZ_OFFSET_MIN: 60, // Africa/Lagos, UTC+1 all year (no daylight saving)
  // first platform owner, created once on an empty database
  PLATFORM_ADMIN_EMAIL: (env.PLATFORM_ADMIN_EMAIL || '').toLowerCase().trim(),
  PLATFORM_ADMIN_PASSWORD: env.PLATFORM_ADMIN_PASSWORD || '',
  // integrations (each feature goes live when its key is present)
  PAYSTACK_SECRET: env.PAYSTACK_SECRET || '',
  PAYSTACK_PUBLIC: env.PAYSTACK_PUBLIC || '',
  TERMII_KEY: env.TERMII_KEY || '',
  TERMII_SENDER: env.TERMII_SENDER || 'MediCore',
  USSD_SECRET: env.USSD_SECRET || '',
  TURN_URL: env.TURN_URL || '', TURN_USER: env.TURN_USER || '', TURN_PASS: env.TURN_PASS || '',
  MAP_TILE_URL: env.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  MAP_TILE_ATTRIBUTION: env.MAP_TILE_ATTRIBUTION || '&copy; OpenStreetMap contributors',
  ROUTING_URL: env.ROUTING_URL || '',
  GEOCODER_URL: env.GEOCODER_URL || '',
  DATA_LOCATION: env.DATA_LOCATION || 'Not yet declared',
  DPO_EMAIL: env.DPO_EMAIL || '',
  PRIVACY_NOTICE_VERSION: env.PRIVACY_NOTICE_VERSION || '2026-10',
};

module.exports = config;
