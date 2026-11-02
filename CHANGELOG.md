# Changelog

All notable changes to VigaBSS. Releases are `v*` tags; `sudo redeploy`
deploys the newest one unless `VIGABSS_CHANNEL=main` is set in `.env.prod`.

## Unreleased

- Scheduled-task locks use their own connection pool, so a burst of due tasks
  can no longer deadlock the API (#51).
- Every API route requires sign-in unless it is reviewed as public, and a route
  inventory test checks each route's organization scope and permission.
- Database pools fail fast with `503 DB_POOL_EXHAUSTED` instead of hanging, and
  report their usage on `/metrics`.
- Billing, payment gateway and PAC failures are counted and alerted.
- Installs and redeploys follow releases by default (`VIGABSS_CHANNEL`).

## 0.1.0-alpha.1

The first alpha. No release has been tagged yet; installs follow `main`.
