'use strict';
/* Local server: API + the apps in public/. Netlify uses netlify/functions/api.js instead. */
const { createApp } = require('./src/app');
const config = require('./src/config');
const app = createApp({ serveStatic: true });
app.listen(config.PORT, () => {
  console.log('MediCore on http://localhost:' + config.PORT + (config.DEMO_MODE ? '  (demo mode)' : ''));
  if (!process.env.JWT_SECRET) console.log('Note: JWT_SECRET not set; using a temporary secret, so sign-ins end when the server restarts.');
});
