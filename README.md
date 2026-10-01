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
  - `kce-worker`: confirms payments, finds payments made outside the checkout, sends alerts, reminders and receipts
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

## Accounts and Pro subscriptions

Free visitors see today's score and how it compares with the baseline. Index Pro adds the history chart (30D, 90D, All, and 1Y once a year of data exists), the breakdown of the five inputs, the 7-day and 30-day changes, CSV export and email alerts.

- **Sign-in:** an emailed link or 6-digit code, each valid for 15 minutes and usable once. Sessions last 30 days.
- **Plans:** $9 for 30 days or $79 for 365 days. A payment buys a fixed period: nothing renews automatically, and reminders go out 7 days and 1 day before access ends. Payments are non-refundable except where required by law.
- **Paying with USDT or USDC on BNB Smart Chain:** WalletConnect (scan a QR code with a phone wallet) or a browser wallet (MetaMask, Trust Wallet, Binance Wallet).
  - The wallet is linked to the account with a free signature.
  - The payment counts once three public providers (two must agree) report the transaction final.
  - Payments made outside the checkout from a linked wallet are found by `kce-worker`.
- **Admin page** (`/admin`, for `ADMIN_EMAILS`): payments, transfers from wallets not linked to an account, subscriptions, data issue reports, and a manual extend with an audit note.

Configuration lives in `backend/.env`; every setting is described in `backend/.env.example`. After changing it:

```sh
cd backend && npm run check-config
cd .. && pm2 restart ecosystem.config.cjs --update-env && pm2 save
```

Restart through the ecosystem file, not a single app, so the website picks up `SITE_API_KEY` and `kce-worker` starts. A mistake in these settings switches accounts off (the public index keeps running) and `npm run check-config` names it.

Test on `PAYMENT_NETWORK=bsc-testnet` first; the checkout is then limited to admin accounts. Before switching to `bsc`, remove the test data:

```sql
DELETE FROM subscriptions WHERE user_id IN (SELECT DISTINCT user_id FROM payments WHERE network='bsc-testnet');
```

## Data issue reports

A small "Report a data issue" link sits beside the indicators: on the score card, in each Pro breakdown card (free visitors get one link under the locked breakdown) and in each input on `/methodology`. It opens `/report`, which asks for the indicator, a description, a supporting link or transaction ID, and an optional email for a reply.

- Reports are listed on `/admin`, open ones first; an admin resolves each with a note, recorded in the audit log.
- The first 10 reports in any 24 hours are also emailed to `ADMIN_EMAILS` (to `SUPPORT_EMAIL` when there are none). Nothing is ever emailed to the reporter.
- Limits: 5 reports an hour and 10 a day per visitor, and 100 a day in total, which active subscribers are exempt from. IP addresses are not stored: the limit uses a keyed hash, which the next report clears once it is two days old.
