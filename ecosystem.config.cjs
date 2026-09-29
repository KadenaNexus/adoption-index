// PM2 processes for the whole project. Run from the repository root after `npm run build` in site/:
//   pm2 start ecosystem.config.cjs && pm2 save
// kce-api, kce-worker and kce-daily come from backend/ecosystem.config.cjs (private backend/.env).
// kce-web serves the Next.js site on localhost only; put Nginx/HTTPS in front of it.
const fs = require('node:fs');
const path = require('node:path');
const backend = require('./backend/ecosystem.config.cjs');

// The website reads the API's PORT and the shared SITE_API_KEY from backend/.env, so they are set in one place.
// util.parseEnv reads the file exactly as the backend's --env-file does (quotes and comments included).
function backendEnv(name, fallback) {
  try {
    return require('node:util').parseEnv(fs.readFileSync(path.join(__dirname, 'backend', '.env'), 'utf8'))[name] || fallback;
  } catch {
    return fallback;
  }
}

module.exports = {
  apps: [
    ...backend.apps,
    {
      name: 'kce-web',
      cwd: path.join(__dirname, 'site'),
      script: 'node_modules/next/dist/bin/next',
      args: 'start -H 127.0.0.1',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      kill_timeout: 10000,
      time: true,
      env: {
        NODE_ENV: 'production',
        TZ: 'UTC',
        PORT: process.env.KCE_WEB_PORT ?? '3002',
        KCE_API_ORIGIN: process.env.KCE_API_ORIGIN ?? `http://127.0.0.1:${backendEnv('PORT', '3001')}`,
        KCE_SITE_KEY: backendEnv('SITE_API_KEY', ''),
        NEXT_TELEMETRY_DISABLED: '1',
      },
    },
  ],
};
