'use strict';
/* MediCore API as one Netlify Function. The database is MongoDB (MONGODB_URI). */
process.env.MC_SERVERLESS = '1';
const serverless = require('serverless-http');
const { createApp } = require('../../src/app');
const handler = serverless(createApp({ serveStatic: false }));
exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;   // keep the Mongo connection warm between calls
  if (event && event.rawUrl) { try { event.path = new URL(event.rawUrl).pathname; } catch (e) {} }
  return handler(event, context);
};
