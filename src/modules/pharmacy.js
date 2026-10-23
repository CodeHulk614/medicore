'use strict';
/*
 * Pharmacy module (with delivery). Works for a standalone pharmacy and for a hospital pharmacy.
 * Parts live in ./pharmacy/:
 *   common.js     indexes, guards, atomic stock primitives, FEFO, ledger, controlled register, codes
 *   inventory.js  items, batches, receive/adjust/count/returns/recall/expiry, suppliers, purchase orders, alerts
 *   orders.js     rx_orders state machine, patient prescription routes, createOrderFromPrescription
 *   sales.js      walk-in / OTC counter sales
 *   delivery.js   dispatcher, riders, location pings, delivery codes, patient tracking
 *   reports.js    dashboard, stock valuation, daily sales
 *   seed.js       demo data
 * API reference: docs/api/pharmacy.md
 */
const express = require('express');
const inventory = require('./pharmacy/inventory');
const orders = require('./pharmacy/orders');
const sales = require('./pharmacy/sales');
const delivery = require('./pharmacy/delivery');
const reports = require('./pharmacy/reports');
const { seedDemo } = require('./pharmacy/seed');

const router = express.Router();
router.use(reports.router);
router.use(inventory.router);
router.use(orders.router);
router.use(sales.router);
router.use(delivery.router);

module.exports = {
  name: 'pharmacy', router, seedDemo,
  createOrderFromPrescription: orders.createOrderFromPrescription,
  createDelivery: delivery.createDelivery,
  TRANSITIONS: orders.TRANSITIONS, DELIVERY_TRANSITIONS: delivery.D_TRANSITIONS, SALE_TRANSITIONS: sales.S_TRANSITIONS,
};
