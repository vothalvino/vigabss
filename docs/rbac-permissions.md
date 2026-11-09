# VigaBSS 0.1.0-alpha.15 — RBAC Permission Matrix

> Extracted from `database/migrations/119_seed_default_roles_and_permissions.sql`.
>
> VigaBSS uses dot-notation permission slugs (`module.action`) enforced via `requirePermission()` middleware on API routes.

## System Roles

| Role | Description | Scope |
|------|-------------|-------|
| **admin** | Full system access — all resources and settings | All permissions |
| **billing** | Billing module — invoices, payments, plans, subscriptions | Billing + read-only clients/contracts |
| **support** | Support access — clients, tickets, communications | Clients + tickets + read-only contracts |
| **technician** | Field / NOC tech — devices, jobs, network, inventory | Network + jobs + inventory |
| **readonly** | Read-only observer — view all resources, cannot modify | All `*.view` and `*.export` |
| **manager** | Runs the operation (migration 010) | Every admin permission except settings, staff users and groups, security and integrations (see "The Manager group") |

All roles are flagged `is_system = TRUE` and cannot be deleted through the UI.

## Permission Slugs

| Module | Permission Slug | Description |
|--------|----------------|-------------|
| **clients** | `clients.view` | View client list and profiles |
| | `clients.create` | Create new clients |
| | `clients.update` | Edit existing client records |
| | `clients.delete` | Delete or deactivate clients |
| **contracts** | `contracts.view` | View service contracts |
| | `contracts.create` | Create new service contracts |
| | `contracts.update` | Modify existing contracts |
| | `contracts.delete` | Cancel or delete contracts |
| **invoices** | `invoices.view` | View invoices |
| | `invoices.create` | Generate new invoices |
| | `invoices.update` | Edit draft invoices |
| | `invoices.delete` | Void or delete invoices |
| **payments** | `payments.view` | View payment records |
| | `payments.create` | Record new payments |
| | `payments.update` | Edit payment records |
| | `payments.delete` | Delete payment records |
| **tickets** | `tickets.view` | View support tickets |
| | `tickets.create` | Open new support tickets |
| | `tickets.update` | Update and respond to tickets |
| | `tickets.delete` | Delete tickets |
| **devices** | `devices.view` | View network devices |
| | `devices.create` | Add new devices |
| | `devices.update` | Edit device configuration |
| | `devices.delete` | Remove devices |
| **plans** | `plans.view` | View service plans |
| | `plans.create` | Create new service plans |
| | `plans.update` | Edit existing plans |
| | `plans.delete` | Delete plans |
| **jobs** | `jobs.view` | View work orders |
| | `jobs.create` | Create new work orders |
| | `jobs.update` | Update work orders |
| | `jobs.delete` | Delete work orders |
| **expenses** | `expenses.view` | View expense records |
| | `expenses.create` | Submit new expenses |
| | `expenses.update` | Edit expense records |
| | `expenses.approve` | Approve or reject submitted expenses |
| **reports** | `reports.view` | Access reports and dashboards |
| | `reports.export` | Export report data |
| **settings** | `settings.view` | View application settings |
| | `settings.update` | Modify application settings |
| **users** | `users.view` | View user accounts |
| | `users.create` | Create new user accounts |
| | `users.update` | Edit user accounts |
| | `users.delete` | Delete or deactivate user accounts |
| **inventory** | `inventory.view` | View inventory items and stock |
| | `inventory.create` | Add inventory items |
| | `inventory.update` | Edit inventory items |
| | `inventory.transfer` | Transfer stock between warehouses |
| **network** | `network.view` | View network topology and resources |
| | `network.create` | Add network resources (NAS, IP pools) |
| | `network.update` | Edit network resources |
| | `network.delete` | Remove network resources |
| **audit** | `audit_logs.view` | View the audit log |
| **organizations** | `organizations.view` | View organization profile |
| | `organizations.update` | Edit organization settings |

## Role → Permission Matrix

| Permission | admin | billing | support | technician | readonly |
|------------|:-----:|:-------:|:-------:|:----------:|:--------:|
| `clients.view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `clients.create` | ✓ | | ✓ | | |
| `clients.update` | ✓ | | ✓ | | |
| `clients.delete` | ✓ | | | | |
| `contracts.view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `contracts.create` | ✓ | | | | |
| `contracts.update` | ✓ | | | | |
| `contracts.delete` | ✓ | | | | |
| `invoices.view` | ✓ | ✓ | | | ✓ |
| `invoices.create` | ✓ | ✓ | | | |
| `invoices.update` | ✓ | ✓ | | | |
| `invoices.delete` | ✓ | ✓ | | | |
| `payments.view` | ✓ | ✓ | | | ✓ |
| `payments.create` | ✓ | ✓ | | | |
| `payments.update` | ✓ | ✓ | | | |
| `payments.delete` | ✓ | ✓ | | | |
| `tickets.view` | ✓ | | ✓ | | ✓ |
| `tickets.create` | ✓ | | ✓ | | |
| `tickets.update` | ✓ | | ✓ | | |
| `tickets.delete` | ✓ | | ✓ | | |
| `devices.view` | ✓ | | | ✓ | ✓ |
| `devices.create` | ✓ | | | ✓ | |
| `devices.update` | ✓ | | | ✓ | |
| `devices.delete` | ✓ | | | ✓ | |
| `plans.view` | ✓ | ✓ | | | ✓ |
| `plans.create` | ✓ | ✓ | | | |
| `plans.update` | ✓ | ✓ | | | |
| `plans.delete` | ✓ | ✓ | | | |
| `jobs.view` | ✓ | | | ✓ | ✓ |
| `jobs.create` | ✓ | | | ✓ | |
| `jobs.update` | ✓ | | | ✓ | |
| `jobs.delete` | ✓ | | | ✓ | |
| `expenses.view` | ✓ | ✓ | | ✓ | ✓ |
| `expenses.create` | ✓ | | | ✓ | |
| `expenses.update` | ✓ | | | | |
| `expenses.approve` | ✓ | ✓ | | | |
| `reports.view` | ✓ | ✓ | ✓ | | ✓ |
| `reports.export` | ✓ | ✓ | | | ✓ |
| `settings.view` | ✓ | ✓ | | | ✓ |
| `settings.update` | ✓ | | | | |
| `users.view` | ✓ | | | | ✓ |
| `users.create` | ✓ | | | | |
| `users.update` | ✓ | | | | |
| `users.delete` | ✓ | | | | |
| `inventory.view` | ✓ | | | ✓ | ✓ |
| `inventory.create` | ✓ | | | ✓ | |
| `inventory.update` | ✓ | | | ✓ | |
| `inventory.transfer` | ✓ | | | ✓ | |
| `network.view` | ✓ | | | ✓ | ✓ |
| `network.create` | ✓ | | | ✓ | |
| `network.update` | ✓ | | | ✓ | |
| `network.delete` | ✓ | | | ✓ | |
| `audit_logs.view` | ✓ | | | | ✓ |
| `organizations.view` | ✓ | | | | ✓ |
| `organizations.update` | ✓ | | | | |

## Reseller accounts

The `reseller_admin` group is for staff users bound to a reseller
(`reseller_user_bindings`). It holds only:

| Permission Slug | Description |
|----------------|-------------|
| `reseller_app.use` | Use the reseller app (`/reseller-app`): own clients, leads and plans |
| `reseller_app.signup` | Sign up new customers as leads in the reseller app |
| `reseller_app.collect` | Collect cash from subscribers in the reseller app, void a same-day collection and close the cash box (migration 004) |
| `reseller_app.bags` | See the reseller's cash bags and seal one with the cash it holds (migration 005) |
| `reseller_app.statements` | See the reseller's approved and settled statements and their PDF (migration 008) |
| `reseller_app.tickets` | Report a fault for a client of its subtree and follow its status (migration 009) |
| `reseller_portal.*` | Reseller portal reads (dashboard, clients, invoices, inventory), confined to the reseller's subtree |
| `webauthn.*` | The user's own passkeys |

Migration 002 removed its organization-wide security views and migration 003
removed the reseller administration views (`resellers.view`,
`reseller_plan_prices.view`, `reseller_commissions.view`,
`reseller_ip_pool_allocations.view`, `reseller_bandwidth_quotas.view`,
`reseller_olt_port_assignments.view`, `reseller_billing_entities.view`).

A bound user, in any group, can reach only these API path prefixes:
`/auth`, `/2fa`, `/security-admin/webauthn` (its own passkeys), `/notifications`,
`/reseller-app`, `/resellers` and `/reseller-portal`
(`src/middleware/resellerFence.js`). Everything else is
403 whatever permissions the group holds. The staff WebSocket hub refuses a
bound user at sign-in, and an open real-time stream (SSE, GraphQL, WebSocket)
ends when its user is bound (`src/services/realtimeAccess.js`). The reseller
app itself answers 403 to users without a binding.

Creating a reseller login (`POST /resellers/:id/users`) needs
`resellers.update` and `users.create`; binding an existing user needs
`resellers.update` and `users.update`. Both, and the allowed plans
(`/resellers/:id/allowed-plans`), are refused to bound users. So are the
ISP's decisions about a reseller, whatever permissions the bound user's group
holds: suspend or reactivate (`POST /resellers/:id/suspend`), plan prices,
IP pools, OLT ports, bandwidth quota and the billing entity. A bound user may still create sub-resellers of its own reseller,
without a commission rate or status.

### Reseller cash (migration 004)

| Permission Slug | Granted to | Description |
|----------------|-----------|-------------|
| `reseller_app.collect` | `reseller_admin`, `admin` | Cash collection in the reseller app (`/reseller-app/collect/*`, `POST /reseller-app/payments`, its void, `POST /reseller-app/cash-session/close`); the routes still refuse an unbound user |
| `reseller_ledger.view` | `admin` | A reseller's cash ledger and summary (`GET /resellers/:id/ledger`) |
| `reseller_ledger.manage` | `admin` | Record cash a reseller handed in, a payout of what the ISP owes it (migration 007), or an adjustment (`POST /resellers/:id/ledger`) |

Both ledger routes are org-level only, whatever the bound user's group holds,
and so is a reseller's `credit_limit` on `POST`/`PUT /resellers`. A bound
user reads its own position in the app (`GET /reseller-app/me`, `/ledger`).
`reseller_admin` holds no `cash_reconciliation.*` permission: a reseller's
cash box is the reseller app's `/cash-session`, and the staff
cash-reconciliation routes are behind the fence.

### Reseller commissions (migration 007)

No new permission. `reseller_commissions.view` reads a reseller's commissions
(`GET /resellers/:id/commissions`, org-level staff and, within its subtree, a
bound user whose group holds it). The commission engine writes them and their
ledger lines; nobody approves or pays a commission by hand, so the old
`POST /resellers/:id/commissions/:cId/approve` route is gone and
`reseller_commissions.approve` is still seeded but guards nothing (removing it
would need a destructive migration). A payout is recorded with
`reseller_ledger.manage`, like a deposit.

### Reseller statements and settlement (migration 008)

| Permission Slug | Granted to | Description |
|----------------|-----------|-------------|
| `reseller_settlements.view` | `admin` | A top-level reseller's statements, their lines and PDF (`GET /resellers/:id/settlements`, `/:sid`, `/:sid/pdf`) |
| `reseller_settlements.manage` | `admin` | Generate a statement (it runs the commission gap sweep first), regenerate or discard a draft, settle an approved one with a bank reference, and run the gap sweep on its own (`POST /resellers/:id/commissions/sweep`) |
| `reseller_settlements.approve` | `admin` | Approve a draft, freezing its figures (`POST /resellers/:id/settlements/:sid/approve`); kept apart from `.manage` so one person can draw up a statement and another approve it |
| `reseller_app.statements` | `reseller_admin`, `admin` | The reseller's approved and settled statements in the reseller app (`GET /reseller-app/statements`, `/:sid`, `/:sid/pdf`); never a draft; the routes still refuse an unbound user |

The staff statement routes are org-level only, whatever the bound user's
group holds.

### Reportar falla and the remote signing link (migration 009)

| Permission Slug | Granted to | Description |
|----------------|-----------|-------------|
| `reseller_app.tickets` | `reseller_admin`, `admin` | Report a fault for a client of the subtree (`POST /reseller-app/tickets`) and list the subtree's reports (`GET /reseller-app/tickets`); the routes still refuse an unbound user |

No other new permission. Staff send or copy a remote signing link with
`signed_documents.create` (`POST /service-orders/:id/signing-links`, `/revoke`)
and list them with `signed_documents.view`. A reseller asks the ISP to send its
lead's customer the link with `reseller_app.signup`
(`POST /reseller-app/leads/:id/signing-link`) and never receives it. The
public signing routes (`/public/signing/:token`) have no session: the token is
the credential (`src/middleware/v1DefaultDeny.js`).

Binding a user whose group lacks `reseller_app.use` leaves it fenced with no
usable app: `/punto` shows a no-access notice. Logins created with
`POST /resellers/:id/users` are always in `reseller_admin`.

### Cash bags and carriers (migration 005)

| Permission Slug | Granted to | Description |
|----------------|-----------|-------------|
| `reseller_app.bags` | `reseller_admin`, `admin` | The reseller's bags and sealing one (`GET /reseller-app/bags`, `POST /reseller-app/bags/seal`); the routes still refuse an unbound user |
| `carrier_app.use` | `carrier`, `admin` | The carrier app reads (`GET /carrier-app/me`, `/resellers`, `/bags`); the routes still refuse anyone outside the carrier group |
| `carrier_app.pickup` | `carrier`, `admin` | Pick up a sealed bag and drop off empty ones (`POST /carrier-app/pickup`, `/dropoff`) |
| `cash_bags.view` | `admin`, `manager` | Bags, their history and the per-reseller differences (`GET /cash-bags`, `/cash-bags/summary`, `/cash-bags/:id`, `/resellers/:id/bags`) |
| `cash_bags.manage` | `admin`, `manager` | Register bags, hand them to a carrier for one of its points (migration 010), return, void or mark them lost |
| `cash_bags.receive` | `admin`, `manager` | Count and receive a bag, posting its deposit and any difference to the reseller ledger (`POST /cash-bags/:id/receive`) |
| `carriers.manage` | `admin`, `manager` | Carrier logins and the resellers each may visit (`/carriers`); creating a carrier login (`POST /carriers`) also needs `users.create` or `point_logins.create`, as a reseller login does |

The seeded system group `carrier` holds only `carrier_app.use`,
`carrier_app.pickup` and `webauthn.*` (its own passkeys). A user in it is a
carrier: it can reach only `/auth`, `/2fa`, `/security-admin/webauthn`,
`/notifications` and `/carrier-app` (`src/middleware/resellerFence.js`),
whatever permissions the group is later given; the staff WebSocket hub and the
real-time streams refuse it too. A carrier sees only the top-level resellers
assigned to it, and never an amount. A carrier cannot be bound to a reseller
(`PUT /resellers/:id/users/:userId` answers 422), and a user bound to a
reseller cannot be given the `carrier` group (`PUT`/`PATCH /users/:id` and
`PATCH /users/:id/group` answer 422). Carrier logins created with
`POST /carriers` (`carriers.manage` and `users.create` or `point_logins.create`) are always in
`carrier`; `carriers.manage` alone lists carriers and assigns them resellers
(`GET /carriers/assignable-resellers` lists the choices).

The cash bag and carrier routes are org-level only: refused to reseller-bound
users and to carriers whatever their group holds.

### The Manager group (migration 010)

The seeded system group `manager` (persona `billing`, so it never takes the
admin bypass) runs the operation: it holds every permission the `admin` group
holds except organization settings (`settings.*`, `email_settings.*`,
`backup_settings.*`), creating and editing staff users and groups
(`users.create`, `users.update`, `users.delete`, `roles.*`), `organizations.*`,
security administration (the `security` module; its own `webauthn.*` stay),
`integration_*`, `api_tokens.*`, `webhooks.*`, `pac_providers.*`,
`csd_certificates.*`, `payment_gateways.*`, `data_residency.*`,
`ai.providers.*`, `ai.policy.write`, `wireguard.peers.admin`,
`wireguard.assignments.manage`, `audit_export.view` and
`report_access_logs.view`. It keeps `users.view` to pick staff for tickets and
work orders. A later migration that grants `admin` a permission grants it to
`manager` too unless it falls in those areas (`tests/managerRole.test.js`).

| Permission Slug | Granted to | Description |
|----------------|-----------|-------------|
| `point_logins.create` | `admin`, `manager` | Create the login of a reseller (`POST /resellers/:id/users`, with `resellers.update`) or a carrier (`POST /carriers`, with `carriers.manage`) without `users.create`; those routes only create an account in their own group |

## Route Authorization

Routes without RBAC middleware (by design):

| Route | Reason |
|-------|--------|
| `auth.js` | Public endpoints (login, register, password reset) |
| `events.js` | SSE stream — authentication only, no permission needed |
| `metrics.js` | Internal Prometheus metrics endpoint |
| `paymentWebhooks.js` | Authenticated via HMAC signature (Stripe/Conekta) |
| `pdf.js` | Authentication only — users download their own documents |
| `twoFactor.js` | User self-service (own account only) |

All other 63 route files enforce RBAC via `requirePermission('module.action')`.
