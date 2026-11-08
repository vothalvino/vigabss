# Changelog

All notable changes to VigaBSS. Releases are `v*` tags; `sudo redeploy`
deploys the newest one unless `VIGABSS_CHANNEL=main` is set in `.env.prod`.

## Unreleased

- **Reseller program, phase 5: statements (estados de cuenta).** Staff close
  a month (or any past period) of a reseller's cash in a statement, in the new
  "Estados de cuenta" tab of the reseller page: what it owed at the start,
  what it collected, voided, sealed in bags, kept as commission, handed in or
  was paid in the period, and what it owes at the end ("Debes entregar"), or
  what the ISP owes it ("Te debemos"). The figures always come from its
  movements, never typed in.
  - **Commissions are checked first.** Before a statement is drawn up, every
    paid invoice of the reseller's customers is checked against its
    commissions: a missing one is booked and one whose invoice is no longer
    paid is reversed. This also repairs the rare voided or SAT-cancelled
    invoice whose commission could not be reversed at the time. Staff can run
    the check on its own too.
  - **Draft, approved, settled.** A draft can be redone or discarded. Once
    approved it never changes: a movement posted later, such as a late
    reversal, goes in the next statement. Approving needs its own permission,
    so one person can prepare a statement and another approve it.
  - **Settling** records the transfer that squares the statement, with its
    bank reference: what the reseller handed in, or what the ISP paid it. If
    that money already moved some other way (in cash bags, for example), it
    can be marked settled without recording it again.
  - **PDF.** Staff and the reseller download each statement as a PDF. The
    reseller sees its approved and settled statements in Mi caja.
- Migration 008 adds the statements and their permissions.
- **Reportar falla.** In the reseller app, a client's page has a "Reportar
  falla" button: the reseller describes the problem and it becomes a ticket in
  the ISP's queue, marked as reported by that reseller. Staff are notified as
  for any new ticket; the customer is not. The reseller sees the status of
  what it reported.
- **The customer signs on its own phone.** Staff can send the customer of an
  installation in process a link (by email or SMS to the contact on file, or
  copy it to hand over) to read and sign the installation documents from its
  own phone. A reseller can ask the ISP to send it for its own customer, but
  never sees the link. The usual rules still apply: the installation
  authorization can be signed right away, the contract only once the
  technician's visit has started. The signature is recorded as the
  customer's own, with the link it came through. Links expire after 72 hours
  (`SIGNING_LINK_TTL_HOURS`) and a new one replaces the old.
- Migration 009 adds the signing links and the ticket's reseller.

## 0.1.0-alpha.14 — 2026-11-07

- **Reseller program, phase 4: resellers earn their commission.** When an
  invoice of a customer a *Punto de Venta* brought in is paid, the reseller
  earns its commission percentage of the invoice amount before IVA, whoever
  took the money: the reseller itself, the ISP's staff, an online payment or
  another reseller.
  - **The reseller keeps it from the cash it holds.** A "Comisión" line in
    its movements lowers what it owes the ISP ("Debes entregar") at once. If
    the invoice stops being paid (the payment is deleted, unapplied, moved or
    refunded, the collection is voided, a credit note is cancelled, or the
    invoice is voided, cancelled at SAT or deleted), a reversal line puts it
    back; paying the invoice again earns it again, never twice.
  - **Sub-resellers:** their customers earn the commission of the top-level
    reseller, at its rate and on its account.
  - **Only new payments count:** invoices paid before you upgrade (or, for
    an organization created later, before it was created) earn nothing, nor
    do imported invoices marked paid; there is no back-pay. An invoice's
    payment date can no longer be edited by hand.
  - **What does not earn:** an invoice in another currency than the
    organization's. An invoice settled by a credit note counts as paid and
    earns like any other.
  - **When the ISP owes the reseller** (its commissions are more than the
    cash it holds, "Te debemos"), staff record what they pay it as a payout
    in its movements, at most what is owed.
  - Staff see each commission (invoice, amount before IVA, rate, amount,
    earned or reversed) in the reseller's Commissions tab; the old approve
    step is gone. The reseller app shows the commission of the month, and
    "Te debemos" instead of "Debes entregar" when the ISP owes the reseller.
- **Fixes found on the way:** restoring a deleted payment can no longer mark
  a voided or cancelled invoice as paid; unapplying or moving a payment now
  updates the invoice's paid status in the same step; the reseller dashboard
  counts revenue by the day invoices were paid.
- Migration 007 adds the commission fields and the new movement types, and
  records the upgrade time as the start of commissions.

## 0.1.0-alpha.13 — 2026-11-07

- **Sealing a cash bag now takes the money off the reseller's account at
  once.** When a *Punto de Venta* seals a bag, the declared amount is
  removed from what it owes the ISP right away, with a "Bolsa sellada" line
  in its movements. The bag's cash is then shown apart, as waiting for the
  carrier or on its way, and no longer counts as the reseller's.
  - **Receiving a bag** only records a difference: if the counted cash
    matches what was declared nothing more is posted; a short bag raises
    what the reseller owes and an over bag lowers it.
  - **A lost bag is the ISP's loss.** Marking a sealed bag lost posts
    nothing, so the reseller does not owe the declared amount again.
  - Staff cannot record a "Bolsa sellada" line by hand.
- **Reseller drop-downs list every reseller.** The reseller pickers and
  filters in Resellers, Leads and Cash bags used to show only the first 100;
  they now load them all (up to 5,000, with a notice when there are more).
- Migration 006 adds the new ledger line and posts it for the bags that
  were already sealed or on their way when you upgrade.

## 0.1.0-alpha.12 — 2026-11-07

- **Reseller program, phase 3: cash bags and carriers.** Collected cash now
  travels from a *Punto de Venta* to the ISP in numbered bags.
  - **Bags:** staff register bags by serial, one at a time or as a range,
    and hand a batch to a carrier. Each bag moves through in stock, with a
    carrier, at a reseller, ready for pickup, on its way and received. Void
    and lost are also possible, and every step is recorded with who did it
    and when.
  - **Reseller (`/punto/bolsas`):** the reseller fills a bag, declares the
    amount and seals it. That cash leaves cash on hand, so the credit limit
    frees right away; the debt still counts it until the ISP receives the
    bag. When the limit is reached, Cobrar says to fill a bag. Received bags
    disappear from the reseller app.
  - **Carrier app (`/ruta`):** a new `carrier` login, made for phones, that
    sees only the resellers assigned to it. It drops off empty bags and
    picks up sealed ones, scanning the serial with the camera or typing it;
    the serial must match. A carrier never sees amounts, customers or other
    resellers, and its login can't open any other part of the system.
  - **Staff (`Bolsas de efectivo`):** a board of bags ready for pickup, on
    their way, received and with differences, plus a Carriers tab to create
    carrier logins and choose their resellers. On receipt staff enter the
    counted amount: the declared amount is booked as handed in, and any
    shortfall or overage is posted to the reseller as an adjustment. Each
    reseller also gets a Bolsas tab.
  - **Resellers** gain an address, city and map location, which their
    carriers see.
  - **Permissions:** `carrier_app.use`, `carrier_app.pickup`,
    `cash_bags.view`, `cash_bags.manage`, `cash_bags.receive`,
    `carriers.manage` and `reseller_app.bags`. Creating a carrier login also
    needs `users.create`.
  - **Mi caja** now shows whether the box is open or closed.
  - Migration 005 adds the bag, bag event and carrier assignment tables.

## 0.1.0-alpha.11 — 2026-11-07

- **Reseller app, phase 2: resellers collect cash.** A *Punto de Venta* can
  now take cash payments, up to a credit limit: the most collected cash it
  may hold before handing it in to the ISP.
  - **Cobrar:** the reseller's own customers, or any subscriber found by
    exact customer number or phone. A customer that isn't the reseller's own
    shows only a masked name. The payment pays the oldest invoices first,
    reconnects a suspended service and issues the payment complement (REP).
  - **Receipt:** printable on 58 or 80 mm paper, or shared by WhatsApp. It
    says the reseller collected on the ISP's behalf.
  - **Mi caja:** today's collections, a same-day void by the user who
    collected, and closing the cash box with the counted amount.
  - **Credit limit:** a default for every reseller in the organization
    settings (2000.00), which each reseller's form can override. Over the limit, the
    collection is refused and the app says how much can still be collected.
  - **Cash ledger:** what each reseller owes the ISP. Staff record the cash
    it hands in, and adjustments, in the reseller's new **Movimientos** tab.
    A sub-reseller's cash is booked on its top-level reseller.
  - **Payments** shows the reseller that collected a payment and can be
    filtered by it.
  - Restoring a deleted payment is now refused unless it was completed, and
    always for a collection a reseller voided.
  - The `/punto` header no longer cuts off the reseller's name.
  - Migration 004 adds the credit limit, the collecting reseller on payments
    and the cash ledger. Its rollback refuses to run once collections exist.

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
