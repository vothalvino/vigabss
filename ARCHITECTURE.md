# VigaBSS Architecture

> This is the canonical architecture and engineering-contract document for all
> coding agents and contributors. `AGENTS.md` and `CLAUDE.md` are entrypoints;
> they must point here instead of carrying duplicate architecture descriptions.

VigaBSS is an open-source, Mexico-focused ISP management platform. It covers
customer operations, plans and contracts, billing and CFDI, payments, RADIUS and
NAS management, FTTH and wireless operations, inventory, ticketing/NOC,
regulatory workflows, automation, resellers, and a subscriber self-service
portal.

Release identity comes from the root `package.json` and is exposed at runtime by
`src/product.js`. Do not duplicate version numbers, route counts, page counts,
test counts, table counts, or migration counts here; those values change often
and must be derived from the repository.

## How to use this document

- Read this file in full before planning, changing, testing, or reviewing code.
- Treat the implementation as ground truth. If this file disagrees with current
  code, verify the behavior and correct this file in the same change.
- Update this file when a change alters a subsystem boundary, request or data
  flow, authentication/authorization, persistence model, public contract,
  background runtime, deployment topology, or required validation command.
- Do not add endpoint inventories or other volatile snapshots. Link to the
  source-of-truth file instead.
- Keep agent behavior in `AGENTS.md`, Claude-only workflow in `CLAUDE.md`, and
  operator/user instructions in `README.md` and `docs/`.

## System context

VigaBSS is a pnpm workspace with a CommonJS Node.js backend, two authentication
and route surfaces within one React SPA/bundle, and a Playwright package:

```text
Staff browser / Subscriber browser
                |
         Nginx or Ingress
                |
     React/Vite SPA + Express 5
                |
    auth -> org scope -> RBAC -> route
                |
       controllers and services
          |                 |
  MySQL/MariaDB       network/external systems
  shared or isolated  RADIUS, NAS, SNMP, PAC,
  tenant databases    payment, email/SMS, webhooks
          |
   optional read replica

Optional Redis supports cache/queues. The Node process also owns scheduled
work, WebSockets, FireRelay tunnels, the optional embedded RADIUS server,
SNMP trap reception, and WireGuard runtime coordination.
```

The supported toolchain is Node.js 24 or newer and pnpm 10 or newer. The exact
pnpm version is pinned by `packageManager` in `package.json`.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/app.js` | Express construction, global middleware, health surfaces, API mounts, docs, static frontend, and error handling |
| `src/server.js` | Process startup and shutdown; database check, schedulers/workers, HTTP/WS/UDP services, and optional runtimes |
| `src/routes/` | REST routers and route-level authentication, organization scope, permission, feature, rate-limit, and validation composition |
| `src/middleware/` | Authentication, RBAC, organization context, validation, rate limiting, security controls, and request context |
| `src/middleware/schemas/` | Hand-written request validation definitions, also consumed by OpenAPI generation |
| `src/controllers/` | Reusable and resource-specific HTTP handlers; `crudController.js` supplies common CRUD behavior |
| `src/services/` | Domain logic, external adapters, scheduled work, queues, monitoring, billing, provisioning, and communication |
| `src/models/` | MySQL-backed models, mostly extending `BaseModel` |
| `src/graphql/` | GraphQL Yoga schema, resolvers, context, and field-level authorization |
| `src/workers/` | Optional background queue workers |
| `src/config/` | Environment-backed configuration, database routing, and integration configuration |
| `src/scripts/` | Migration, rollback, seed, backup, OpenAPI, integrity checks, and administrative CLI tools |
| `src/utils/` | Shared errors, logging, OpenAPI generator, security helpers, and cross-cutting utilities |
| `frontend/src/App.tsx` | Staff and subscriber client-side route tree |
| `frontend/src/nav/routes.ts` | Canonical staff navigation registry and route visibility metadata |
| `frontend/src/api/` | Generated OpenAPI types, typed client, authenticated raw fetch, and API helpers |
| `frontend/src/auth/` | Staff/portal auth contexts, route guards, and UI permission helpers |
| `frontend/src/pages/` | Staff and subscriber pages |
| `frontend/src/i18n/locales/` | Frontend translations for English, Spanish, and Brazilian Portuguese |
| `database/migrations/` | Sequential, append-only forward migrations |
| `database/rollbacks/` | Matching rollback scripts |
| `database/schema.sql` | Full current schema for fresh installs; must mirror structural migrations |
| `tests/` | Backend Jest/Supertest tests, schema contract tests, and real-DB test support |
| `e2e/` | Playwright end-to-end flows |
| `docs/openapi.json` | Generated and committed REST contract consumed by the frontend type generator |
| `docker-compose*.yml`, `Dockerfile` | Development, production, test, E2E, build, and host-Nginx container topologies |
| `k8s/`, `charts/` | Kubernetes manifests and Helm chart |
| `install.sh`, `redeploy.sh`, `deploy/` | Installation and operational deployment tooling |

## Backend runtime and HTTP surfaces

`src/server.js` validates production configuration, verifies the primary
database, reports pending migrations, starts the scheduler and optional queue
workers, initializes WireGuard state, starts HTTP, attaches FireRelay and browser
WebSocket servers, starts the SNMP trap receiver and optional embedded RADIUS
server, and drains them on shutdown.

`src/app.js` owns the HTTP security and routing stack. Important surfaces are:

- `/api/v1/*` is the canonical REST and GraphQL prefix.
- `/api/*` is a backward-compatible mount of the same router. It emits
  deprecation metadata and currently advertises a 2027-06-01 sunset. New code
  and frontend calls must use `/api/v1`.
- `/api/v1/graphql` is GraphQL Yoga behind authentication, organization scope,
  API-token scope checks, and per-root-field permission checks.
- `/health`, `/healthz`, `/health/live`, and `/health/ready` are health surfaces
  with intentionally different liveness/readiness depth.
- `/metrics` exposes Prometheus metrics outside the versioned API router.
- `/acs/cwmp` is the text/XML TR-069 endpoint and intentionally sits outside
  the JSON API/authentication surface. It authenticates every CWMP message
  itself (HTTP Basic: the CPE's own credentials, or `ACS_USERNAME`/
  `ACS_PASSWORD` for first contact by a CPE with none), never resolves a device
  by serial+OUI without that, has its own per-IP limiter, and reads its body
  only as bounded XML text — the global JSON/form parsers skip it and the
  CWMP parser is a linear tokenizer with no DTD/entity processing.
- API documentation is mounted by `src/utils/openapi.js`.
- The production backend serves `frontend/dist` and falls back to the SPA for
  non-API routes.

Global middleware establishes request IDs, security headers, CORS, bounded body
parsing, cookie parsing, output-oriented XSS posture, request logging, metrics,
rate limits, and CSRF defense. Webhook and collector routes have deliberate raw
body, parser, authentication, and limiter exceptions. Never make a global
middleware change without checking those machine-to-machine paths.

A typical protected domain request follows this chain:

```text
authenticate -> orgScope -> requirePermission -> validate -> handler
             -> service/controller -> model/database -> serialized response
```

Not every route uses the generic chain: public auth, subscriber portal,
webhooks, collectors, install-operator endpoints, RADIUS accounting, GraphQL,
and ACS have specialized boundaries. Inspect the router before copying a nearby
pattern. Literal paths such as `/stats` and `/assignable-users` must be mounted
before a parameter route such as `/:id`.

Errors use a common `{ error: { code, message, ... } }` envelope and include the
request ID when one is available. Reuse the error classes and central handler
instead of inventing endpoint-local error shapes.

## Identity, organization scope, and authorization

These are security boundaries, not convenience conventions.

### Authentication

Staff/API authentication is implemented in `src/middleware/auth.js` and accepts:

- a Bearer JWT;
- the SPA's HTTP-only access cookie; or
- an API key through `X-API-Key`.

Subscriber-portal access JWTs are a separate credential class. They are signed
with a portal-only key derived from `JWT_SECRET`, carry `aud: vigabss-portal`
and `type: 'portal'`, and are issued and verified only through
`src/utils/accessTokens.js`. Staff verification (`authenticate()`, GraphQL,
SSE, and the browser WebSocket hub) uses `verifyStaffAccessToken`, which also
rejects any token claiming the portal type or audience; `portalAuthenticate`
uses `verifyPortalAccessToken`. Never verify an access JWT with a raw
`jwt.verify(..., JWT_SECRET)` on a new surface: a `clients.id` must never be
resolved as a `users.id`.

Staff with TOTP enabled sign in in two steps. `POST /auth/login` (and an SSO
callback) returns a 5-minute `type: 'mfa'` challenge signed with a third
derived key; it sets no cookies and creates no session, and
`verifyStaffAccessToken` rejects it. Only `POST /auth/login/2fa` exchanges it,
with a single-use TOTP step or backup code, for a session. Any new path that
mints a staff session must apply `authService.requiresSecondFactor()` first.

SSO (`src/services/ssoService.js`) may only sign in accounts that belong to the
configuring organization alone, never an install operator or super-admin, and
links each account to the IdP identity (`user_sso_identities`, bound by
`organization_id`). The `/sso/:orgId` admin endpoints require `:orgId` to be the
caller's active organization unless the caller has global access, and refuse
API tokens.

The Authorization header takes precedence over the browser cookie. The active
organization is resolved into the authenticated principal and carried as
`req.user.organizationId`; `orgScope` validates it and exposes `req.orgId`.
Downstream code must use `req.orgId`, not `req.organizationId`, and must never
trust an arbitrary organization ID in a request body.

`X-Org-Id` is not the organization authority in the current middleware. Staff
organization switching re-resolves access and issues credentials for the new
active organization; API keys are bound to their stored organization. Do not
revive older header-based examples as an authorization mechanism.

### Database tenant routing

Most tenant-owned rows carry `organization_id`, and every read/write must bind
the active organization. `src/config/database.js` also wraps an org-scoped
request in `AsyncLocalStorage`. Organizations configured for database isolation
are routed to a bounded, invalidatable tenant pool; other organizations use the
shared primary database.

- Use the exported `db` module; do not create ad-hoc pools in domain code.
- Use `db.withPrimaryContext(...)` for installation-wide identity, registry, or
  fleet work that must escape a tenant database context.
- Use `db.queryReplica(...)` for read-only reporting/dashboard work where the
  existing pattern permits replica lag.
- Keep every statement in a transaction on the same acquired connection. A
  guard on one pooled connection and a write on another is not atomic.
- Passing `organizationId = null` to a service does not reset database routing;
  use the explicit primary context for global work.
- A tenant-owned row that references another tenant-owned row (`client_id`,
  `contract_id`, `assigned_to`, a related or merge-source id, ...) must verify
  that reference in `req.orgId` on create, update, and any derivation step (for
  example quote -> invoice conversion); reject a foreign or missing reference
  with a 422 `ValidationError`. See `assertServiceOrderFks`, `assertQuoteFks`
  and `assertTicketFks` in `src/routes/`; the shared table-map form is
  `assertOwnedReferences`/`ownedReferences` in `src/utils/ownedReferences.js`.
  A billing document's `contract_id` must also belong to the document's own
  client, and a side effect driven by a stored reference (a paid invoice
  reconnecting its contract) re-binds the org at use time instead of trusting
  the stored id. Display joins to a referenced row (client name, device name,
  ...) must also bind the joined row's `organization_id` to the base row's, so
  a legacy foreign id can never surface another tenant's data.
- Child tables without their own `organization_id` (for example
  `ticket_comments`, `ticket_relations`, `ticket_time_logs`) are scoped only
  through their parent: load the parent by id **and** `req.orgId` before any
  child read or write, and 404 on a miss (tickets: `requireOwnedTicket` in
  `src/routes/tickets.js`).
- Subscriber-portal queries must bind `req.client.organizationId` as well as
  `req.client.id`, using null-safe `organization_id <=> ?` because single-tenant
  installs may store NULL organization IDs. A `client_id` match alone is not a
  tenant boundary. Services called from the portal (`portalServiceRequestService`,
  `whatsappService`) take the org as an argument and refuse `undefined` via
  `src/utils/requireOrgId.js`.
- The WhatsApp webhook has no org context, so its phone- and code-keyed
  lookups (binding resolution, code verification, per-phone conversation
  state) are install-wide by design. Every client-keyed WhatsApp query still
  binds an org: the portal client's, or for the bot the org of the already
  resolved `whatsapp_links` row, never a payload value.
  `whatsapp_conversation_state` has no `organization_id` and is scoped through
  its parent `clients` row.

Reseller scoping by `reseller_id` is an additional business filter, not a hard
tenant boundary and not a substitute for `organization_id`/tenant routing.
Which resellers a staff caller may act on is resolved server-side by
`src/middleware/resellerScope.js` (`req.resellerScope`) for every
`/resellers` and `/reseller-portal` route: a `reseller_user_bindings` row
(migration 471) confines the user to that reseller and its sub-resellers
(404 outside it, lists filtered) whatever permissions it holds; an unbound
user in the `reseller_admin` group is refused with 403; other unbound staff
reach every reseller in their organization through ordinary permissions.
Binding management (`PUT/DELETE /resellers/:id/users/:userId`) needs
`resellers.update` and `users.update` and is refused to bound callers. A
custom group meant for reseller staff must have its users bound.

### RBAC resolution

Backend authorization is authoritative. `requirePermission` first enforces API
token scopes, then resolves the principal:

1. A validated installation operator or exact system super-admin principal can
   carry global organization access. API tokens never inherit this bypass.
2. For ordinary users, a live `users.group_id` is authoritative when that user
   may access the organization. An empty group permission set is a deliberate
   deny-all and must not fall through.
3. Without an authoritative group, an active `organization_users` membership
   role resolves through `roles` and `role_permissions`.
4. Legacy `users.role` is a compatibility fallback only for a user homed in the
   active organization.

There is no production-wide `users.role = 'admin'` permission bypass in
`src/middleware/rbac.js`. A narrow shortcut exists only for old query-only test
doubles. Do not design production behavior around that test compatibility path.

API token scope `NULL` is the legacy unrestricted sentinel; an empty or invalid
scope list fails closed. A role is not expressible as a scope, so `requireRole`
admits only that unrestricted sentinel and refuses scope-limited tokens.
Installation-wide infrastructure (FireRelay node registry and tunnel commands,
backup settings, system version) is gated on the install operator
(`src/services/installOperator.js`), never on a tenant admin/owner role.
GraphQL must maintain permission parity with equivalent
REST operations through `src/graphql/authz.js` and the field maps in
`src/graphql/index.js`: `FIELD_PERMISSIONS` guards root fields (FORBIDDEN on
denial) and `NESTED_FIELD_PERMISSIONS` guards every nested edge that crosses
into another resource (for example `Client.invoices` needs `invoices.view`).
A denied nested edge resolves to `[]`/`null` without an error so detail pages
keep the sections the caller may see. `authz.js` resolves principals exactly
like `requirePermission` (token scopes, global-access bypass never for API
tokens, permission set memoized per request); there is no `role === 'admin'`
shortcut. Billing-category tickets are hidden from `ticket`/`tickets` without
`tickets.view_billing`. A new type field that reaches another resource needs a
`NESTED_FIELD_PERMISSIONS` entry and a test in
`tests/graphqlNestedAuthz.test.js`.

Frontend route guards, navigation visibility, and `can(user, permission)` are
UX controls only. They must reflect backend grants so users do not see actions
that inevitably fail, but they never replace server-side authorization.

## Backend layers and persistence conventions

### Routes, validation, controllers, and services

- Routes compose middleware and handlers. Use a permission slug that is seeded
  and granted to every intended role.
- Validation schemas live in `src/middleware/schemas/`. The custom `validate()`
  middleware validates declared fields but, by default, leaves undeclared fields
  in the body. Sensitive mutation routes can opt into `{ strip: true }`.
- `crudController.js` centralizes common list/get/create/update/delete behavior,
  audit logging, cache invalidation, serializers, hooks, and optional locked
  transactions. Use its extension points before forking a second CRUD pattern.
- Put multi-record invariants, external I/O, and reusable domain decisions in a
  service. Route handlers should remain transport-oriented.
- Stored credentials (`*_encrypted` columns) are written only by the server.
  Settings routes accept a write-only plaintext field (`secret_key`,
  `password`, ...) and seal it with `src/utils/sealSecrets.js`
  (`encryptStrict` in production); a client-sent `*_encrypted` key is a 422, a
  blank write-only field keeps the stored value, and responses expose only
  `has_*` booleans. Readers always go through `decrypt()`. The same applies
  to network credentials that are not named `*_encrypted` (`devices` and
  `discovery_scans.snmp_community`, `bandwidth_test_servers.auth_token`):
  sealed on write, redacted with `src/utils/secretRedaction.js`, decrypted by
  their one reader (snmpPoller). `nas.secret` is the exception: external
  FreeRADIUS reads it from the table, so it stays plaintext at rest, is
  redacted to `has_secret`, and only `GET /nas/:id/secret` with
  `radius.credentials.view` returns it.
- Output encoding happens at the sink: React escapes text, the knowledge-base
  HTML sink uses DOMPurify, XML builders escape XML, and email templates escape
  interpolated HTML. Do not reintroduce blanket input-side HTML encoding.

### Models and SQL

Most models extend `src/models/BaseModel.js`:

- `fillable` is an allowlist for insert/update and silently omits unknown keys.
- `hasOrgScope` adds `organization_id` predicates when an org ID is supplied.
- `softDelete` adds `deleted_at` behavior.
- generic list filters and sort fields are allowlisted.
- generic updates reject `organization_id`; tenant re-homing requires a
  separate, explicitly reviewed operation.

Child tables without their own `organization_id` (contacts, invoice/quote/
credit-note/factura-pública items, payment allocations, CFDI conceptos and
related documents, inventory stock, device-group members) are tenant-scoped
only through their parent. A child sub-route must load the parent with
`req.orgId` first and return 404 when it is not in the org, and its model
helper must take `orgId` and join the parent's `organization_id` (null-safe
`<=>` where that column is nullable). Helpers built this way call
`src/utils/requireOrgId.js` and throw when `orgId` is `undefined`. A line-item
POST takes its parent id from the URL only: `validate()` does not strip
undeclared keys, so a body parent id spread after the URL id overrides it.
Global (`organization_id IS NULL`) rows such as shared CPE profiles stay
readable through an explicit "own or NULL" lookup, never through an unscoped
one. `tests/childResourceOrgIsolation.test.js` covers these routes with two
organizations.

Many responses are direct `SELECT *` database rows. Database column names and
MySQL wire types are therefore part of the effective API contract. Verify them
in `database/schema.sql` or the migration rather than guessing aliases in the
frontend. MySQL booleans commonly return as `0`/`1`, and `DECIMAL` values return
as strings under the current mysql2 configuration; convert deliberately before
boolean logic, comparison, or arithmetic.

A client's headline balance is computed live by
`src/services/clientBalanceService.js` from invoices, payments, and
`issued`/`applied` credit notes. `client_balance_ledger` is the history behind
the Ledger tab, `GET /clients/:id/balance-ledger`, and the statement PDF, and
it must agree with the headline balance. Credit notes follow one invariant,
owned by `src/services/creditNoteLedgerService.js`: a note's net ledger credit
equals its total while it is `issued`/`applied` and not soft-deleted, and is
zero while it is `draft`, `cancelled`, or soft-deleted. Every write path
re-syncs the note to that target with the shared, net-aware
`syncCreditNoteLedger` helper on the same transaction that changes the note:
`PUT /credit-notes/:id` (issue posts the total, cancel appends a reversal, a
total change on a posted note appends the delta, a client change reverses the
credit on the previous client), `DELETE` (reversal), and restore (re-post) all
run inside the crudController row lock, so a concurrent duplicate posts
nothing; a note created already issued/applied and the refund path
(`refundRequestService`, `refund_method = credit_note`, in the transaction that
inserts the note) post at creation. A posted note cannot return to draft,
`cancelled` is terminal, and cancelling or deleting a note with a live CFDI de
Egreso is refused until the CFDI is cancelled. `billing_adjustments` is an
audit record and feeds no balance.

A succeeded gateway capture is money like any other payment:
`paymentGatewayService.reconcilePayment` posts one `completed` `payments` row,
links it through `payment_transactions.payment_id` (set in the same transaction,
under the transaction row lock, which is also the idempotency guard), writes the
ledger credit with `billingService.recordPaymentCredit`, and allocates through
`paymentAllocationService.allocateAcrossInvoices`, the same waterfall as
`POST /payments/:id/allocate-auto`; reconnect, retry cancellation and REP
generation run after commit. A succeeded transaction with `payment_id IS NULL`
is unposted money: reconcile throws on failure (the webhook answers 500 and the
redelivered failed event is reprocessed) and the install-wide
`reconcile_gateway_payments` task sweeps the rest. Rows reconciled before
migration 472 carry a `payment_transaction` ledger credit and no payment, and
are skipped. Stripe webhooks use the HMAC signing secret; Conekta webhooks are
RSA-SHA256 verified against the webhook key's public key PEM. Ledger history is corrected by appending
compensating rows, not by editing old ones.

`pnpm run sql:check` statically checks resolvable SQL in `src/` against
`database/schema.sql`, including table/column names, ENUM values, and writes to
generated columns. Dynamic SQL is reported as skipped. The exception lists in
the checker are a ratchet: shrink them when fixing a gap and never add an entry
without a specific explanation.

### Scheduled and asynchronous work

The scheduler reads `scheduled_tasks`, but executable task names must also be
registered in the `switch` in `src/services/taskRunner.js`. A seed row without a
cron expression, dispatcher case, scope classification, and dispatch test is a
dead feature. Keep global versus organization-scoped execution explicit.
A seeded install-wide row runs with `organizationId = null`; a handler that
binds `organization_id = ?` must then be fanned out with
`forEachActiveOrganization` (`src/services/organizationFanOut.js`) — it reads
the org list on the primary, enters each isolated tenant's context, isolates
per-org failures and throws only when every org failed. Passing NULL straight
through matches nothing and records a successful no-op.

Redis-backed caching and BullMQ workers are optional. Code must preserve the
documented no-Redis fallback unless a deployment requirement is intentionally
changed. Some tasks use MySQL locks or row locks for cross-process exclusion;
do not replace those with process-local state.

### SNMP polling and metric history

SNMP polling is profile-driven but deliberately not auto-matched at runtime.
Only devices with `snmp_enabled = TRUE`, an address, and an explicit
`devices.snmp_profile_id` enter the polling loop. `snmp_profile_oids` maps each
active scalar, table, or averaged-table object to an allowlisted
`snmp_metrics` column. IF-X-MIB Counter64 values arrive from `net-snmp` as
big-endian buffers; the poller converts only values that remain exactly
representable as JavaScript integers and records a gap rather than an
imprecise counter otherwise. The poll loop is install-wide, but a
`device_polling_configs` row applies only to devices of its own organization
(`organization_id <=>` the device's; type-level rows prefer the device's org,
then an install-wide NULL-org row), and its `device_id` must belong to
`req.orgId` on create/update.

The metric pipeline is:

```text
assigned device + profile OIDs
          |
      SNMP poller
          |
    snmp_metrics (raw)
          |
   1hr -> 1day -> 1month rollups
          |
history API/UI and tenant-scoped alert evaluation
```

Raw, hourly, and daily history expose the same canonical RF keys
(`signal_strength`, `noise_floor_dbm`, `air_util_pct`, `gps_sync_status`,
`snr_db`, `ccq_pct`, `tx_rate_mbps`, and `rx_rate_mbps`); unavailable vendor
objects remain `NULL`. Rollup procedures must populate every matching
avg/min/max column, including `if_oper_status`, at all three tiers. Alert SQL
must join raw metrics to the owning device and bind `organization_id`; a
device-less rule is organization-wide, never installation-wide. The global
five-minute alert task fans out over active shared-database organizations and
enters each isolated tenant database explicitly; it must never query rules with
`organization_id = NULL` and report a false-success no-op.

### Device configuration backup and templates

On-demand `POST /device-config-backups/pull` loads the device with
`organization_id <=> req.orgId` before any RouterOS session is opened through a
FireRelay agent. Its credentials come only from the request body or from the
device's active MikroTik `router_driver_configs` row in the same organization.
The install-wide `ROUTEROS_API_USER`/`ROUTEROS_API_PASSWORD` variables belong to
the unattended nightly `config_backup` task (`runNightlyBackups`) and must not
become a fallback for tenant-triggered pulls.

`POST /config-templates/:id/deploy` binds both template and device to
`req.orgId`. No config-push mechanism exists (no RouterOS import/apply handler,
FireRelay command, or driver command), so a deploy renders the template, records
`config_deployment_records.status = 'pending'` with no `deployed_at`, and
returns `push_performed: false` plus `rendered_config` for manual application.
Do not record `success` until a real push reports per-step device results.

## REST/OpenAPI contract

The REST contract has a manual source and two generated consumers:

```text
Express route + request schema
          |
src/utils/openapi.js          (hand-written path/operation definitions)
          |
pnpm run openapi
          |
docs/openapi.json             (committed artifact)
          |
frontend: pnpm run gen:api
          |
frontend/src/api/schema.d.ts  (generated TypeScript types)
```

`pnpm run spec:check` only proves that `docs/openapi.json` matches the OpenAPI
generator. It cannot discover that an Express route was omitted from the
generator, so reviewers must compare changed routes to the spec manually.

Prefer the typed `api.GET/POST/PUT/PATCH/DELETE(...)` client from
`frontend/src/api/client.ts`. Use `authedFetch` when raw response bodies,
downloads, GraphQL, or a path not expressible through the generated client make
it necessary; it preserves token attachment, cookies, CSRF headers, refresh,
and one retry. Do not use bare `fetch` for an authenticated API call.

Some legacy pages still implement a local `apiFetch` and read old
`localStorage` token/organization keys that the current auth context no longer
owns. This is existing migration debt, not precedent. When touching one of
those callers, prefer the shared typed client or `authedFetch` and verify reload,
cookie-auth, CSRF, refresh, and active-organization behavior.

## Frontend architecture

The React/Vite application contains separate authentication contexts and route
trees for staff and subscriber users:

- `AuthContext` + `PrivateRoute` protect staff/admin operations.
- `PortalAuthContext` + `PortalRoute` protect the subscriber portal.
- `App.tsx` is the route source of truth.
- TanStack Query owns server-state fetching/caching where adopted.
- `frontend/src/api/client.ts` owns authenticated transport behavior.

Staff navigation is registry-driven. Every routed staff page must have a
matching entry in `frontend/src/nav/routes.ts` unless it is one of the explicit
registry exceptions. The registry feeds the rail, hub pages, and command
palette. Its `guard` must mirror the `PrivateRoute` tier, and an item must be
reachable through a rail row and/or hub card. `roles` is an audited allowlist,
not a privilege ranking. `requiredAnyPermissions` is available for sensitive
pages. Keep `navRegistry.test.ts` and `navPersonas.test.ts` aligned with routing,
grants, and intended personas.

The UI permission helper in `frontend/src/auth/permissions.ts` prefers the
server-resolved `permissions` array, including an authoritative empty array, and
uses its hard-coded role map only as compatibility for older responses. UI
permission coverage is not uniform across all pages: follow the established
helper instead of adding a third pattern, and test that visible actions match
backend permissions.

All user-facing text must use i18next and be present in all three frontend
locales: `en`, `es`, and `pt-BR`. Follow `docs/language-guideline.md`.

## Database change contract

Migrations are sequential and append-only. Determine the next number from the
filesystem; never rely on a number copied into documentation:

```bash
find database/migrations -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort -V | tail -1
```

For every database change:

1. Add the next numbered forward migration in `database/migrations/`. Do not
   amend an already-shipped migration.
2. Add a rollback with the identical filename in `database/rollbacks/`. A
   rollback must be honest about data that cannot or must not be restored.
3. Make DDL safe for the supported MySQL/MariaDB versions and re-execution.
   Follow current guarded stored-procedure patterns where direct
   `ALTER ... IF [NOT] EXISTS` is not portable.
4. Mirror the final structure in `database/schema.sql`.
5. Seed every new permission slug and grant it to the intended built-in roles.
   A route permission without seed/grant data locks out all ordinary users.
6. Keep `README.md` synchronized. Its migration range and schema table count are
   CI-checked; the database inventory and notable migration notes are also part
   of the contributor contract.
7. Run offline parity/static checks and, when a real local database is
   available, migration apply/idempotency/rollback and DB integration tests.

Do not author two migration-producing changes in parallel against the same
branch. Re-read the highest number immediately before creating the file.

## End-to-end feature contract

Not every change touches every layer, but every affected link must remain
connected:

1. **Personas and data:** identify the staff/subscriber roles, organization
   boundary, real database columns, state transitions, and failure behavior.
2. **Persistence:** create/mirror/roll back schema and seed permissions or
   scheduled work when needed.
3. **Input and model:** align validation, enums, request field names, model
   `fillable`, tenant predicates, and transaction boundaries.
4. **Backend:** wire route middleware, service/controller logic, error shape,
   audit effects, external side effects, and scheduler dispatch.
5. **Contract:** update the hand-written OpenAPI definition, regenerate the JSON,
   and regenerate frontend types.
6. **Frontend:** use the real response shape; wire route, navigation, guard,
   permission-aware actions, query invalidation, loading/error/empty states, and
   all locales.
7. **Verification and operations:** add focused tests at each changed layer,
   exercise the end-to-end flow where practical, and update operator docs/env/
   deployment inputs.

A feature is not complete when only its table, endpoint, or page exists. Trace
the real workflow from navigation through authorization and persistence back to
the rendered response.

## Commands and validation matrix

Install dependencies from the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
```

Common development commands:

```bash
# Backend, from repository root
pnpm dev
pnpm lint
pnpm test
pnpm run test:db            # real database; Docker is the documented setup
pnpm run migrate
pnpm run migrate:smoke-test # real database; validates migration/schema parity
pnpm run seed
pnpm run sql:check
pnpm run schema:parity      # offline
pnpm run openapi
pnpm run spec:check

# Frontend, from repository root
pnpm --filter vigabss-frontend dev
pnpm --filter vigabss-frontend run lint       # gen:api + tsc --noEmit
pnpm --filter vigabss-frontend test
pnpm --filter vigabss-frontend run i18n:check
pnpm --filter vigabss-frontend build

# End-to-end
pnpm --filter vigabss-e2e test
```

Select checks by impact; run focused tests early and the appropriate full gate
before completion:

| Impact | Minimum validation |
| --- | --- |
| Documentation/instructions only | Inspect rendered Markdown and links; `git diff --check` |
| Backend JavaScript | Focused Jest tests, `pnpm lint`, then `pnpm test` |
| SQL/model/data access | `pnpm run sql:check`, `pnpm run schema:parity`, relevant Jest tests; add real-DB checks below for migrations |
| Migration/schema/seed | Above plus `pnpm run migrate:smoke-test` and `pnpm run test:db` when Docker/MySQL is available |
| REST contract/schema | `pnpm run openapi`, `pnpm run spec:check`, frontend API generation/type-check, relevant contract tests |
| Frontend | `pnpm --filter vigabss-frontend run lint`, relevant/full frontend tests, `i18n:check`; add `build` for release-critical or routing changes |
| Critical user flow | All impacted layer checks plus `pnpm --filter vigabss-e2e test` |
| Compose/infra | Parse every changed Compose overlay with `docker compose ... config`; run relevant image/Helm/deploy checks |

Plain backend Jest uses a mocked database and does not prove MySQL behavior.
`test:db` and migration smoke tests require a real local MySQL/MariaDB; the
Compose services are the documented setup. Playwright requires the full E2E
stack. If an environment-dependent command cannot run, report exactly what was
not verified and the remaining risk; never describe an unrun gate as green.
Run migration, rollback, seed, and DB integration commands only against an
explicitly identified disposable local/test database, never an unknown or
production database.

Pre-commit hooks run ESLint for backend source changes and frontend API
generation/type checking for frontend source changes. CI additionally checks
coverage, migration numbering and rollback behavior, live schema parity,
README/schema counts, MySQL and MariaDB compatibility, security scans, and
deployment artifacts. Do not weaken a check or test to make a change pass.

## Deployment architecture

- `docker-compose.yml` is the main development topology.
- `docker-compose.prod.yml` includes MySQL primary/read-replica services, Redis,
  the app, an isolated WireGuard helper, Nginx, Certbot, and optional ChromaDB;
  `docker-compose.host-nginx.yml` supports a host-managed proxy.
- `docker-compose.test.yml` and `docker-compose.e2e.yml` provide database and
  full-flow test environments; `docker-compose.build.yml` supports image builds.
- `install.sh` is the fresh production installer. Current installs use
  `/opt/vigabss`; `/opt/fireisp` remains a compatibility path.
- `k8s/` and `charts/` provide Kubernetes and Helm deployment assets.
- Operational references live in `docs/deployment.md`,
  `docs/backup-restore.md`, `docs/firerelay.md`, `docs/freeradius/`, and
  `docs/grafana/`.

The application is the single owner of HTTP security headers across supported
topologies. Do not duplicate them in Nginx/Ingress without reviewing browser
header-combination semantics. Production proxy hop count must match
`TRUST_PROXY`, or IP-based security and rate limiting become incorrect.

Optional capabilities use a mix of feature flags and service-specific
configuration; there is not one uniform gate. Preserve each subsystem's safe
disabled/no-op behavior, including the no-Redis fallback and opt-in listeners,
unless the deployment contract is intentionally changed.

The historical name `fireisp` remains in compatibility-sensitive identifiers,
including default database/cookie names, deployment paths, and selected chart
or runtime labels. Do not globally rename those strings as cosmetic cleanup;
verify each one's upgrade and interoperability contract first.

## Recurring failure modes

- **Column/response drift:** direct SQL rows expose unaliased column names; a
  guessed frontend property silently renders `undefined`, `NaN`, or a dash.
- **Request drift:** `validate()` ignores undeclared keys unless stripping is
  enabled, while model `fillable` drops unsupported fields. A mismatched form
  key may be ignored, rejected, or accidentally reach custom SQL.
- **Tenant escape:** omitting `req.orgId`, accepting `organization_id` on update,
  or running global work inside tenant context can leak or move data.
- **User-supplied regex:** never pass a tenant-authored pattern straight to
  `new RegExp()`; V8 has no match timeout, so one catastrophic pattern stalls
  every tenant on the process. Use `src/utils/safeRegex.js` (length cap,
  nested-quantifier/backreference rejection) at write time and again at
  evaluation, and cap the subject length (config compliance rules do both).
- **Permission half-wiring:** a new slug without seed/grant data, or navigation
  without matching backend grants, produces ordinary-user 403s while privileged
  test users appear fine.
- **OpenAPI half-wiring:** spec drift can be clean even when a new Express route
  was never added to `src/utils/openapi.js`.
- **Scheduled-task half-wiring:** a seeded name without cron, scope allowlist,
  dispatcher case, or test never does useful work.
- **Transaction split:** taking a lock on one connection and reading/writing on
  another defeats the lock and can deadlock or return stale data.
- **Route shadowing:** `/:id` mounted before a literal path captures the literal.
- **Replica misuse:** a write-followed-by-read invariant cannot rely on a lagging
  replica.
- **Fake integrations:** some device drivers, live FTTH operations, scripting,
  payment, or integration paths may intentionally be incomplete. Confirm the
  service behavior; a UI that reports stubbed work as success is a defect.
- **Regex lint:** unnecessary escapes such as `\-` inside character classes fail
  the configured ESLint rule.

## Durable references

- `README.md` — operator-facing overview, configuration, schema inventory, and
  deployment/use instructions.
- `CONTRIBUTING.md` — contributor setup, style, and contribution workflow.
- `docs/language-guideline.md` — localization rules.
- `docs/openapi.json` — generated REST artifact, not the authoring source.
- `docs/architecture.md` — compatibility link to this canonical root document;
  it must not become a second architecture source.
- [Modular regional architecture plan](docs/modular-regional-architecture-plan.md)
  — proposed modularization and regional network services; not current runtime behavior.
- `isp-platform-features.md` — product/feature scope; verify completion claims
  against current code.
- `.claude/agent-memory/fullstack-autonomous-engineer/MEMORY.md` — index of
  historical implementation notes. These notes are useful leads, not current
  architectural authority; re-verify them before relying on them.

When adding a durable reference, link it here instead of copying its contents.
