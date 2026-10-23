'use strict';
/*
 * Clinic module: doctors, consultations and front-desk operations for every provider.
 * Split into parts under ./clinic/:
 *   schedules     doctor schedules, public doctor directory, computed slots
 *   appointments  booking (patient and front desk), cancel, no-show, doctor lists
 *   frontdesk     check-in queue per service point, vitals and triage, customer care cases
 *   consult       encounters (SOAP notes, ICD-10 diagnoses), chart, prescribing, lab orders, clinical search
 *   messages      patient <-> provider message threads
 *   video         WebRTC signalling for paid video visits (stored in the database)
 *   earnings      doctor earnings and provider consultation revenue (read only)
 * API reference: docs/api/clinic.md
 */
const express = require('express');
const router = express.Router();

const parts = ['schedules', 'appointments', 'frontdesk', 'consult', 'messages', 'video', 'earnings'].map(n => require('./clinic/' + n));
for (const p of parts) router.use(p.router);

const consult = require('./clinic/consult');
const frontdesk = require('./clinic/frontdesk');
const appointments = require('./clinic/appointments');
const { seedDemo } = require('./clinic/seed');

module.exports = {
  name: 'clinic', router, seedDemo,
  // helpers other modules may use
  currentMeds: consult.currentMeds, runSafety: consult.runSafety, recordVitals: frontdesk.recordVitals, vitalsView: frontdesk.vitalsView, bookAppointment: appointments.book,
};
