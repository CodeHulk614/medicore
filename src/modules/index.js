'use strict';
/*
 * Every API module, in mount order. A module exports { name, router, seedDemo? }.
 * Core: auth, orgs, patients, shifts, billing, staff.
 * Services: clinic, pharmacy (with delivery), ambulance, lab, payer (HMO), chw, ussd.
 * Platform: the MediCore team's HQ (superadmin).
 */
module.exports = [
  require('./auth'),
  require('./orgs'),
  require('./patients'),
  require('./shifts'),
  require('./billing'),
  require('./staff'),
  require('./groups'),
  require('./network'),
  require('./whatsapp'),
  require('./hmopanel'),
  require('./geo'),
  require('./controlplane'),
  require('./support'),
  require('./ai'),
  require('./clinic'),
  require('./pharmacy'),
  require('./ambulance'),
  require('./lab'),
  require('./payer'),
  require('./hmoplus'),
  require('./inventory'),
  require('./market'),
  require('./caresharing'),
  require('./documents'),
  require('./wearables'),
  require('./facilities'),
  require('./chw'),
  require('./ussd'),
  require('./platform'),
];
