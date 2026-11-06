# Changelog

All notable changes to VigaBSS. Releases are `v*` tags; `sudo redeploy`
deploys the newest one unless `VIGABSS_CHANNEL=main` is set in `.env.prod`.

## Unreleased

Nothing yet.

## 0.1.0-alpha.3 — 2026-11-06

Fixes found by testing 0.1.0-alpha.2 on a live install.

- **Suspending a contract no longer reports success when nothing happened.**
  A pending contract, or a suspension-exempt client, now gets a 422 that says
  why, instead of `status: suspended` while the subscriber stays online.
- **The update banner follows the install's channel.** A release-channel
  install (the default) compares against the newest `v*` release, not the
  head of `main`, so a merge no longer shows a phantom update.
  `VIGABSS_CHANNEL` now reaches the app container.
- **New clients take their organization's locale.** In an MX organization,
  clients created from the API, the form, the reseller portal or CSV import
  are MX unless another locale is chosen, so they get the MX rules
  (border-region IVA, CFDI).
- **The API spec lists only endpoints that exist.** 21 documented operations
  were not served; a test now walks the router and fails on any such entry.

## 0.1.0-alpha.2 — 2026-11-06

Fixes found on the first real install of 0.1.0-alpha.1. Install this release
instead; alpha.1 cannot complete a fresh install.

- **Fresh installs no longer stop before migrating.** The pre-migration backup
  looked up isolated tenants on an empty database (`ER_NO_SUCH_TABLE`).
- **The SNMP trap listener starts, and `/health/ready` passes.** Its schema
  check looked for migration 459, which is part of the release baseline now.
- **`redeploy <tag>` rollbacks work again.** The guard checked for the 459/460
  migration files; it now requires a release that contains the baseline.
- **Helm chart releases publish without manual help** (chart-releaser now has
  a git identity).

## 0.1.0-alpha.1 — 2026-11-05

The first tagged release, and the first one installs follow by default
(`VIGABSS_CHANNEL=release`). It is an **alpha**: everything below is built and
covered by automated tests, but most items on
[the pre-launch checklist](docs/pre-launch-test-checklist.md) have not yet run
against real hardware or providers — PAC stamping, Stripe/Conekta payments and
refunds, and RADIUS accounting from a real NAS among them. Treat it as ready
for a pilot, not for production billing.

### Installing

- Fresh installs only: `install.sh` (Docker Compose) or the Helm chart
  (`charts/fireisp`). The release image is
  `ghcr.io/vothalvino/vigabss:0.1.0-alpha.1`, multi-arch (amd64 and arm64)
  and signed with Cosign; `redeploy` verifies the signature.
- The database is built from one migration, `001_baseline.sql`: the 525
  development migrations were squashed into it, after CI proved it produces an
  identical database on MySQL 8.4 and MariaDB 10.6. A database created from the
  development history is refused with an explanation; recreate it.

### Notable changes since development began

- **Security and tenancy.** Every API route requires sign-in unless reviewed as
  public, a real-database sweep checks every route against cross-organization
  access as both a Mexican and a global organization, and every write route
  answers bad input with a 4xx. The API is served only under `/api/v1`.
- **Collectors.** FreeRADIUS accounting and PPPoE events authenticate with
  single-scope organization API tokens only; accounting runs on its own
  database pool and is counted on `/metrics`.
- **Billing and Mexico.** Factura global, late fees on the unpaid share,
  provider refunds that flag a live REP, frozen cash-reconciliation sessions,
  CFDI sandbox/production environments, and IPv6 in the legal IP-attribution
  lookup and government requests.
- **Operations.** Background CSV imports, a payment problems page, queue and
  RADIUS monitoring, firmware installs confirmed by the CPE, the container
  running as uid 10001, opt-in egress network policy, and a blocking DAST scan.
- **Fixes found by the pre-release cleanup.** Four tables declared no
  collation; 17 shipped SNMP profiles could be claimed by one tenant; on
  MariaDB, editing a speed test rewrote when it was measured.
- Scheduled-task locks use their own connection pool, so a burst of due tasks
  can no longer deadlock the API (#51). Database pools fail fast with
  `503 DB_POOL_EXHAUSTED` instead of hanging, and report their usage on
  `/metrics`. Billing, payment gateway and PAC failures are counted and
  alerted.
