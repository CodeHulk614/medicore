'use strict';
/*
 * One-time codes for phone verification, password reset and patient record linking.
 * Codes are 6 digits, stored only as a hash, expire in 10 minutes, allow 5 attempts.
 * In DEMO_MODE the code is also returned to the caller (marked devCode) so demos work
 * without an SMS account; in production it only goes out by SMS.
 */
const db = require('../db');
const config = require('../config');
const { id, digits, sha256 } = require('./util');
const { sms } = require('./notify');
const { bad } = require('./http');

db.index('otps', ['purpose', 'target']);

async function issue(purpose, target, message) {
  const code = digits(6);
  await db.col('otps').deleteMany({ purpose, target });
  await db.col('otps').insertOne({ id: id('otp'), purpose, target, codeHash: sha256(purpose + ':' + target + ':' + code), exp: Date.now() + (Number(require('./settings').get('process.security.otpMinutes', 10)) || 10) * 60000, attempts: 0, at: Date.now() });
  // codes go by WhatsApp first when HQ turned it on (authentication template), with SMS as the fallback
  let viaWa = false;
  const W = config.WHATSAPP || {};
  if (W.sendCodes && require('./settings').feature('whatsapp')) { try { viaWa = (await require('./whatsapp').sendCode(target, code)).ok; } catch (e) { viaWa = false; } }
  if (!viaWa) await sms(target, (message || 'Your MediCore code is {code}').replace('{code}', code) + '. It expires in 10 minutes. Do not share it.');
  return config.DEMO_MODE ? { devCode: code } : {};
}

async function verify(purpose, target, code) {
  const rec = await db.col('otps').findOne({ purpose, target });
  if (!rec || rec.exp < Date.now()) throw bad('That code has expired. Request a new one.');
  if (rec.attempts >= 5) throw bad('Too many wrong codes. Request a new one.');
  if (rec.codeHash !== sha256(purpose + ':' + target + ':' + String(code || '').trim())) {
    await db.col('otps').updateOne({ id: rec.id }, { $inc: { attempts: 1 } });
    throw bad('That code is not correct.');
  }
  await db.col('otps').deleteOne({ id: rec.id });
  return true;
}

module.exports = { issue, verify };
