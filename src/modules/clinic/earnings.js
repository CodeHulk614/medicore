'use strict';
/*
 * Consultation earnings: what each doctor brought in from completed, paid consultations.
 * Read-only views. Paying doctors out (Paystack transfers to their bank accounts) is NOT
 * implemented: it needs a live Paystack account with Transfers enabled and each doctor's
 * verified bank details; until then providers pay doctors outside MediCore.
 */
const express = require('express');
const db = require('../../db');
const { ah, query, t, bad } = require('../../lib/http');
const A = require('../../lib/auth');
const { todayLagos, addDays } = require('../../lib/util');
const C = require('./common');

const router = express.Router();
const PAYOUT_NOTE = 'Payouts are not made through MediCore yet. Automatic doctor payouts need Paystack Transfers on a live Paystack account and each doctor\'s verified bank details.';

function range(q) {
  const to = q.to || todayLagos(); const from = q.from || addDays(to, -30);
  if (from > to) throw bad('"from" must be on or before "to"');
  return { from, to, start: C.dayRangeUtc(from).start, end: C.dayRangeUtc(to).end };
}
const rangeRules = { from: t.date(), to: t.date() };

/** completed consultations in range with their bills */
async function rowsFor(orgId, r, doctorMembershipId) {
  const f = { orgId, status: 'completed', startUtc: { $gte: r.start, $lt: r.end } };
  if (doctorMembershipId) f.doctorMembershipId = doctorMembershipId;
  const appts = await db.col('appointments').find(f, { sort: { startUtc: -1 }, limit: 5000 });
  const out = [];
  for (const a of appts) {
    const bill = a.billId ? await db.col('bills').findOne({ id: a.billId, orgId }) : null;
    out.push({ a, bill, paid: !!(bill && bill.status === 'paid'), amountKobo: bill && bill.status === 'paid' ? bill.totalKobo : 0, hmoKobo: bill && bill.hmo ? bill.hmo.coveredKobo || 0 : 0 });
  }
  return out;
}
function summarise(rows) {
  const s = { completed: rows.length, paidCount: 0, unpaidCount: 0, paidKobo: 0, hmoKobo: 0, byType: { in_person: { count: 0, paidKobo: 0 }, video: { count: 0, paidKobo: 0 } } };
  for (const r of rows) {
    if (r.paid) { s.paidCount++; s.paidKobo += r.amountKobo; s.hmoKobo += r.hmoKobo; } else s.unpaidCount++;
    const bt = s.byType[r.a.type]; if (bt) { bt.count++; bt.paidKobo += r.amountKobo; }
  }
  return s;
}

router.get('/doc/earnings', A.requireStaff({ perm: 'clinic.consult', module: 'clinic' }), ah(async (req, res) => {
  const r = range(query(req, rangeRules));
  const rows = await rowsFor(req.ctx.org.id, r, req.ctx.membership.id);
  res.json(Object.assign({ from: r.from, to: r.to }, summarise(rows), {
    items: rows.slice(0, 200).map(x => ({ appointmentId: x.a.id, date: x.a.date, time: x.a.time, type: x.a.type, feeKobo: x.a.feeKobo, paid: x.paid, amountKobo: x.amountKobo, billId: x.a.billId })),
    payouts: { available: false, note: PAYOUT_NOTE },
  }));
}));

router.get('/admin/clinic/revenue', A.requireStaff({ perm: 'admin.finance' }), ah(async (req, res) => {
  const r = range(query(req, rangeRules));
  const rows = await rowsFor(req.ctx.org.id, r, null);
  const by = {};
  for (const x of rows) (by[x.a.doctorMembershipId] = by[x.a.doctorMembershipId] || { doctorMembershipId: x.a.doctorMembershipId, doctorName: x.a.doctorName, rows: [] }).rows.push(x);
  const doctors = Object.values(by).map(d => Object.assign({ doctorMembershipId: d.doctorMembershipId, doctorName: d.doctorName }, summarise(d.rows))).sort((a, b) => b.paidKobo - a.paidKobo);
  res.json(Object.assign({ from: r.from, to: r.to, doctors }, { totals: summarise(rows), payouts: { available: false, note: PAYOUT_NOTE } }));
}));

module.exports = { router };
