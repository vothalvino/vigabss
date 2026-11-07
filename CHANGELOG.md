# Changelog

All notable changes to VigaBSS. Releases are `v*` tags; `sudo redeploy`
deploys the newest one unless `VIGABSS_CHANNEL=main` is set in `.env.prod`.

## Unreleased

Nothing yet.

## 0.1.0-alpha.10 — 2026-11-07

- **Reseller accounts can manage their own passkeys again.** The reseller
  fence (0.1.0-alpha.9) blocked `/security-admin/webauthn`, although the
  reseller role keeps `webauthn.*`. It now allows exactly that path, which
  lists and revokes only the caller's own credentials. The rest of security
  admin stays blocked.

## 0.1.0-alpha.9 — 2026-11-07

- **Reseller app, phase 1: resellers can sign up customers.** A reseller is
  now a *Punto de Venta*: a commission agent who signs up neighbours, while
  the ISP converts, signs the contract and installs. A user bound to a
  reseller lands on **`/punto`**, a phone-first app in Spanish, English and
  Portuguese with four screens:
  - **Inicio:** counts of active, suspended and overdue clients, and open
    leads.
  - **Clientes:** the reseller's own customers, with balances and invoices.
  - **Nuevo cliente:** captures a lead with the plan, the tax details and the
    phone's location, and shows a coverage summary.
  - **Prospectos:** the reseller's leads.

  Leads appear in the ISP's lead inbox tagged with the reseller. Once a lead
  is converted, the customer shows in the reseller's list.
- **Admin:**
  - New and edit forms for resellers.
  - An **Allowed plans** tab; if no plans are selected, every active plan is
    allowed.
  - **Create login**, which creates a reseller user and binds it in one step.
  - The lead list shows the reseller and can be filtered by it.
  - Half-built tabs are hidden: plan prices, resources, billing entity,
    branding, and per-row commission approval.
- **Security:**
  - A reseller-bound account can only reach the reseller app, sign-in,
    two-factor and notifications. Every other API returns 403, whatever its
    permissions, and the staff WebSocket refuses it.
  - Bound users can no longer change commission, status or other ISP-owned
    reseller settings.
  - The reseller portal no longer returns full client and invoice rows
    (password and reset hashes, CURP, notes).
  - The coverage summary does not reveal network devices or coordinates.
- **Removed:** the reseller portal's suspend, cancel and create-client
  endpoints. They only changed a status field and left the subscriber online.
- **Migration 003:**
  - Adds `leads.reseller_id` and the `reseller_allowed_plans` table.
  - Grants `reseller_app.use` and `reseller_app.signup` to reseller_admin,
    and removes its reseller administration view grants.

## 0.1.0-alpha.8 — 2026-11-06

- **Signed copies are named after the contract and the signing date.** A
  downloaded activation contract is now `contrato-<contract>-<YYYY-MM-DD>.pdf`
  (`contract-…` outside Mexico) instead of `document-<id>.pdf`. The date is
  the signing day in Mexico City time for MX organizations, UTC otherwise.
  Other documents on the same contract are prefixed with their kind (for
  example `acuse-servicio-contrato-…`), so they do not share a name. A
  document without a contract uses its own number. Staff and portal
  downloads both use the server's name.

## 0.1.0-alpha.7 — 2026-11-06

- **Signed contracts stay reachable after activation.** The signed-document
  View and Download were only on the activation card, which disappears once a
  contract is active. The contract page now has a **Signed documents** tab at
  every status, and the customer's **Documents** tab lists the signed
  contracts and documents across all of their contracts, each with View and
  Download PDF. Both need the `signed_documents.view` permission.

## 0.1.0-alpha.6 — 2026-11-06

- **Signed documents can be read and downloaded again.** Once signed, an
  activation contract (or service acknowledgment, or installation
  authorization) only showed "Signed by <name>". Staff now open it from the
  contract or work order (**View**: the text exactly as signed, the signature,
  signer, date, signing IP, environment, registered contract and whether the
  stored evidence still verifies) and download a PDF copy. Subscribers get a
  **Documents** page in the portal with their own signed documents and a PDF
  copy of each (`GET /portal/documents`, `/portal/documents/{id}`,
  `/portal/documents/{id}/pdf`; staff: `GET /signed-documents/{id}/pdf`).

## 0.1.0-alpha.5 — 2026-11-06

- **Contract activation is a guided page.** A step tracker (schedule visit,
  test connection, customer signs, finish visit, activate) and one "Next:"
  sentence lead the card; only the current step shows its controls, finished
  steps fold into a summary, and locked steps say what unlocks them. While the
  test line is switching off it says when the visit can be finished and why,
  instead of claiming temporary internet is still on and offering the speed
  test again (#108).
- **The Helm chart is named `vigabss`.** It was still `fireisp`, so every
  release published a `fireisp-<version>` chart release. The chart now lives in
  `charts/vigabss`; the docs install it as `helm install vigabss vigabss/vigabss`
  into the `vigabss` namespace, with `vigabss` database defaults.
- **Prometheus alerts can fire.** The alert rules selected `job="fireisp"`
  while the docs configure the scrape job as `vigabss`, so no rule matched any
  series; both rule files now select `vigabss`, and a test keeps them aligned.
- **The Resellers page shows write actions only to users who may use them.**
  A reseller user saw Suspend, Delete, Approve and Remove buttons on the
  reseller list, plan price, commission and IP pool tabs that could only answer
  403; each now requires the permission its route checks (#106).

## 0.1.0-alpha.4 — 2026-11-06

Fixes from testing the customer and reseller portals on a live install.

- **Security: reseller users no longer see or change ISP-wide security
  settings.** Migration 002 (the first after the baseline) removes nine
  permissions the `reseller_admin` group had held since before reseller
  scoping existed, including adding admin IP allowlist entries — enough to
  lock the ISP's administrators out of admin pages. Reseller users keep their
  reseller-scoped access and their own passkeys.
- **Pages load after an update.** A tab opened before a deploy asked for the
  old page files and got the app's HTML back (cached for a year), so pages
  such as Payments did not load. Missing files are now a plain 404, and the
  app reloads once into the new version.
- **Users without operations access land on a page they can use.** A reseller
  user opened on the Operations Overview, every tile refused; they now start
  on Resellers.
- **CI runs the full unit test suites on pull requests**, not only after merge.

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
