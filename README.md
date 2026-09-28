# Kadena Community Edition Adoption Index

One daily score showing whether Kadena Community Edition is being adopted, published at adoption.kadena.ws.

The score compares five inputs with one fixed baseline: their level over the first 30 collected days, 29 June to 28 July 2026. Baseline activity scores 50 and there is no upper limit (all inputs at double the baseline score 100).

| Input | Weight |
|---|---:|
| Active addresses | 30% |
| New contracts | 25% |
| TVL (named protocol registry, in KDA) | 20% |
| Network hashrate | 15% |
| GitHub commits (kda-community) | 10% |

`index = 50 × Σ weight × (current ÷ baseline)`, where current is the trailing 7-day average (addresses, TVL, hashrate) or 7-day count (contracts, commits). Count baselines below one event per day use one per day. Baselines never move and earlier scores are never restated. The full method is on the site at `/methodology`.

## Structure

- `backend/`: Node.js API and daily collector, backed by PostgreSQL
- `site/`: Next.js website
- `ecosystem.config.cjs`: PM2 processes
  - `kce-api`: API on 127.0.0.1, port `PORT` from `backend/.env` (default 3001); the website follows it automatically
  - `kce-daily`: collector, runs at 00:00 UTC
  - `kce-web`: website on 127.0.0.1:3002

## Requirements

Node.js 22.18+, PostgreSQL 16+, PM2, and Nginx for HTTPS.

## Setup

```sh
cd backend && npm ci
cp .env.example .env && chmod 600 .env    # set DATABASE_URL and GITHUB_TOKEN
npm run migrate
cd ../site && npm ci && npm run build
cd .. && pm2 start ecosystem.config.cjs && pm2 save
```

`site/ops/nginx.conf.example` proxies adoption.kadena.ws to 127.0.0.1:3002. Keep the API and the database on localhost.

## Update

```sh
git pull
(cd backend && npm ci && npm run migrate)
pm2 stop kce-web && (cd site && npm ci && npm run build)
pm2 restart ecosystem.config.cjs --update-env && pm2 save
```

Avoid updating while the daily job is running (from 00:00 UTC).

A scoring-method change is applied explicitly. For a database scored by the previous method, run this once before `npm run migrate`:

```sh
cd backend && npm run migrate-method -- --from kce-v3-growing-90d-2026-09-27
```

It archives the old scores, recalculates every day from the stored raw observations (checking they are unchanged) and records the migration. Until then `npm run migrate` stops and leaves the data untouched.

## Useful commands

- `cd backend && npm run status`: collected days, checkpoints and review state.
- `cd backend && npm run daily`: manual catch-up after a missed midnight run.
- `cd backend && npm run report -- --day 2026-09-26 --directory ~/day-report`: one day's calculation, TVL by protocol and new modules (read-only).
- Local development:
  - backend: `npm start`
  - site: put `KCE_API_ORIGIN=http://127.0.0.1:3001` in `site/.env.local`, then run `npm run dev` (http://127.0.0.1:5173)
- Tests: `npm test` in each folder. Backend database tests need `TEST_DATABASE_URL` pointing at a separate `*_test` database.

Free visitors see today's score and how it compares with the baseline. History, the breakdown and the 7-day and 30-day changes are Pro features. Sign-in and payments are not built yet.
