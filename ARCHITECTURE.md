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

- `/api/v1/*` is the only REST and GraphQL prefix. There is no unversioned
  `/api/*` copy of the router (removed before the first install); limiters and
  guards are mounted on the `/api/v1` paths only. `/api/docs` is the one route
  outside it.
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
  CWMP parser is a linear tokenizer with no DTD/entity processing. It follows
  the CWMP session: an Inform is always answered with InformResponse and a
  `cwmpsid` session cookie (kept in the shared cache), queued RPCs go out one
  per empty POST or response, and an empty 204 ends the session. Within a
  session the cookie identifies the device. `reap_stuck_cpe_tasks` fails
  tasks left in_progress for 30 minutes.
- API documentation is mounted by `src/utils/openapi.js`.
- The production backend serves `frontend/dist` and falls back to the SPA for
  non-API routes (`src/middleware/staticAssets.js`): hashed `/assets/*` are
  immutable and served from the `.gz` beside them, `index.html` is no-cache.
  Every page but the sign-in and not-found screens is a lazy route, and locale
  catalogues load on demand (FE-21). `frontend/scripts/postbuild.mjs` fails the
  build when the initial JavaScript passes its gzipped budget, writes the
  `.gz` files, and moves the hidden source maps out of `dist/`. Frontend REST
  calls written by hand use `src/api/apiFetch.ts` (FE-20), never bare `fetch`.

Global middleware establishes request IDs, security headers, CORS, bounded body
parsing, cookie parsing, output-oriented XSS posture, request logging, metrics,
rate limits, and CSRF defense. Webhook and collector routes have deliberate raw
body, parser, authentication, and limiter exceptions. Never make a global
middleware change without checking those machine-to-machine paths.
`orgScope` applies the per-organization API limiter and then, for an API
token, that token's `api_key_rate_limits` policy (`apiTokenConfiguredLimiter`),
counted once per request on every route including `/graphql`.

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
resolved as a `users.id`. Staff tokens are minted only by
`signStaffAccessToken` and carry `type: 'staff'`, `aud: vigabss-staff`,
`iss: vigabss` and a `jti`; `verifyStaffAccessToken` requires all of them
(SEC-23). Tests that sign staff tokens by hand use `tests/helpers/staffJwt.js`.
Derive any other key from `JWT_SECRET` with HKDF and its own label, as the
portal, MFA and WhatsApp-pepper keys do; never reuse the secret itself.

Refresh tokens rotate on every use and a replay of a rotated one is treated as
theft (migration 509). A rotated staff row is kept with `consumed_at` until it
expires, and presenting it deletes its whole `token_family`; a rotated portal
row has `rotated_at`, and presenting it revokes every portal session of the
client. Logout ends the token's family. `GET /auth/sessions` lists the caller's
live sign-ins and `DELETE /auth/sessions/:id` ends one.

Both access-token classes carry a token version (`tv`): `users.token_version`
for staff and `clients.portal_token_version` for the portal (migration 482).
`authenticate()` and `portalAuthenticate` refuse a token whose version no
longer matches the account's. Anything that should end an account's sessions
calls `src/services/sessionRevocation.js`, which bumps the version and deletes
(staff) or revokes (portal) the refresh sessions: password resets and changes,
an admin change of a user's password, email, status, group or role, archiving
a user, and setting a portal password. A new surface that mints an access
token must embed the current version; one that verifies a token must compare
it.

A staff password is governed by the password policy of the user's home
organization (`src/services/passwordPolicyService.js`; built-in defaults of 8
characters and 5 attempts / 15 minutes when no `password_policies` row is
active). Every path that sets a password applies its composition rules
(register, change, reset, `hashPasswordField` for administrator-set
passwords); change and reset also refuse the last `history_count` passwords
(`password_history`), sign-in failures lock by its lockout settings, and a
password older than `rotation_days` sets `must_change_password` at password
sign-in. WebAuthn is not implemented: `POST /security-admin/webauthn` returns
501 and no sign-in path reads `webauthn_credentials`.

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
`/resellers`, `/reseller-portal` and `/reseller-app` route: a `reseller_user_bindings` row
(migration 471) confines the user to that reseller and its sub-resellers
(404 outside it, lists filtered) whatever permissions it holds; an unbound
user in the `reseller_admin` group is refused with 403; other unbound staff
reach every reseller in their organization through ordinary permissions.
Binding management (`PUT/DELETE /resellers/:id/users/:userId`) needs
`resellers.update` and `users.update` and is refused to bound callers. A
custom group meant for reseller staff must have its users bound.

A bound user works in the reseller app (`src/routes/resellerApp.js`,
`/api/v1/reseller-app`, the SPA's `/punto`): its subtree's clients, the plans
its reseller may offer (the `reseller_allowed_plans` of its top-level
reseller, which its sub-resellers share, or every active plan when there are
none), and lead sign-ups that the ISP converts; every route there answers
403 to an unbound caller. `src/middleware/resellerFence.js`, mounted on the
v1 router before the routes, confines any bound principal (session or API
token, not a validated global-access principal) to `/auth`, `/2fa`,
`/security-admin/webauthn` (its own passkeys), `/notifications`,
`/reseller-app`, `/resellers` and `/reseller-portal`; any
other path is 403 whatever its group grants. The same fence confines a
carrier (a user whose `users.group_id` is the seeded system group `carrier`,
`src/services/carrierAccount.js`; `authenticate` carries the group id on
`req.user` as a non-enumerable `groupId`) to those account prefixes and
`/carrier-app`; a user who is both gets only the account prefixes, so both
directions are refused (422): binding a carrier to a reseller
(`PUT /resellers/:id/users/:userId`), and giving the carrier group to a user
bound to a reseller in any of its organizations (`PUT`/`PATCH /users/:id`,
`PATCH /users/:id/group`). The fence authenticates the
request itself (route guards are idempotent), skips public routes and
requests without credentials, and shares one binding lookup per request with
`resellerScope` (`bindingForRequest`). Like `orgScope`, it and the
`reseller_binding` of `/auth/me` run only when the database module has
`withTenantContext`, which the real module always has; query-only test
doubles skip them. A lead captured there carries `leads.reseller_id`, which
`lifecycleService` copies to the client on conversion when that reseller is
still live in the organization. A bound caller may not set `commission_rate`
or `status` on `POST`/`PUT /resellers`; logins (`POST /resellers/:id/users`),
allowed plans, suspension, commission approval, plan prices and the
resource and billing-entity writes are org-level only (a binding may be given
to a user in any group, so the binding, not the group, decides). The fence
also covers real-time feeds: the staff WebSocket hub refuses a bound user or a
carrier, and `realtimeAccess.stillAuthorized` ends an open SSE, GraphQL or
WebSocket stream once its user is bound or moved into the carrier group. Reseller-facing reads name their columns: no
`SELECT *` row from `clients` (portal and reset hashes, CURP, notes) or
`invoices` reaches a reseller. `GET /reseller-app/leads/:id/feasibility`
deliberately does not return the staff desk-check payload: the reseller picks
the coordinates, so it gets a summary (zones that are `active` or `degraded`,
and AP/ODF proximity as distance bands within 3 km, free FTTH ports as a
boolean) without device or frame ids, names, coordinates, RF figures or error
text, and `POST /reseller-app/leads` has a per-reseller limiter
(`RATE_LIMIT_RESELLER_SIGNUP`).

A bound user with `reseller_app.collect` also collects cash for the ISP
(phase 2, migration 004, `src/routes/resellerAppCollect.js`,
`src/services/resellerCollectionService.js`). The reseller is the ISP's
commission agent: the ISP stays the provider and the CFDI issuer, and a
collection is an ordinary completed cash payment of the client (forma 01,
`recorded_by` the user) carrying `payments.reseller_id`, which only this path
sets (not fillable; staff create and update drop it; the staff list shows
`reseller_name` and filters on it). Money is booked per collecting reseller,
the top-level reseller of the user's binding
(`resellerLedgerService.collectingResellerId`; `req.resellerScope.rootId` is
the bound reseller, which may be a sub-reseller), whoever owns the client, in
the append-only `reseller_ledger_entries`
(`src/services/resellerLedgerService.js`, never updated or deleted): a
collection adds its amount, its void and a deposit subtract, an adjustment is
signed. The balance (what the reseller owes) is the sum, `in_bags` is the
declared amount of its cash bags that are sealed and not yet received
(`ready_for_pickup`, `in_transit`; phase 3), `cash_on_hand` is the balance
minus `in_bags`, the effective limit is `resellers.credit_limit` or
the per-organization setting `reseller_default_credit_limit`, and
`available_to_collect` is the limit minus the cash on hand, never below 0.
A sub-reseller's users collect, read `/me` money, `/ledger`, the day's list
and receipts, and void against that top-level reseller, which is the only one
staff deposit on; the bound sub-reseller must also be active to collect.
`POST /reseller-app/payments` runs in one transaction that locks the reseller
row first (every ledger writer does), then the client's invoices before its
first plain read (DAL-04: under REPEATABLE READ that read fixes the snapshot
the balance_due subquery and the over-allocation trigger sum allocations
from, and other allocators do not take the reseller lock), refuses with 409
`CREDIT_LIMIT` when the
cash on hand plus the amount would pass the limit (exactly at it is allowed),
opens the user's cash session if none is open, inserts the payment, writes
the client-ledger credit (`billingService.recordPaymentCredit`), allocates
oldest invoice first or to the chosen invoices with the allocate-auto
waterfall (`getInvoicesWithBalance`, `allocateAcrossInvoices`) and appends the `collection` entry with the payment
and session ids; `payment.received`, `reconnectIfSuspended` per invoice it
paid off and `repService.maybeGenerateRep` per allocation run after commit and
only log a failure. An `Idempotency-Key` (per user, `idempotency_keys`, 24 h)
replays the first answer. A reseller may collect from any subscriber of the
organization: its own subtree's clients are fully visible, any other is found
only by an exact customer number or phone (`GET /reseller-app/collect/lookup`,
limited per collecting reseller by `RATE_LIMIT_RESELLER_LOOKUP` per window and
`RATE_LIMIT_RESELLER_LOOKUP_DAILY` per 24 h, since customer numbers are
sequential) with a masked name and no
contact data, and the lookup hands out a 15-minute HMAC token
(`src/utils/collectToken.js`, key derived from `JWT_SECRET` by HKDF) binding the
organization, client and bound reseller, which the payment takes instead
of a client id. A void (`POST /reseller-app/payments/:id/void`) is allowed only
to the collecting reseller and, within it, to the user whose cash session holds
the collection (409 `NOT_YOUR_COLLECTION` for a colleague; the list marks only
the caller's collections `voidable`), on the business day of the collection,
while that session is open and no REP binds the payment (409 otherwise); it
locks the client's invoices first, reverses the client credit and the
allocations like a staff deletion, cancels and soft-deletes the payment and
appends `collection_void` with the negated amount of the `collection` entry
(not the payment's current amount, which staff may have edited), so the pair
nets to zero. Staff `POST /payments/:id/restore` refuses (409) a payment that
is not completed, and a voided reseller collection in particular
(`PAYMENT_VOIDED_BY_RESELLER`): restoring re-credits the client and revives
the allocations. Closing the cash box
(`cashReconciliationService.closeSession`) records the count and the
variance and leaves the ledger alone; only org-level staff with
`reseller_ledger.manage` record cash handed in (`POST /resellers/:id/ledger`
deposit, never a payment, at most the cash on hand; or a noted adjustment),
which frees the limit. The ledger routes and a reseller's `credit_limit` are refused
to bound callers. A staff deletion or edit of a reseller-collected payment
does not touch the reseller ledger: the cash the reseller took is still owed
until a deposit or an adjustment says otherwise.

Phase 3 (migration 005) moves the cash in numbered money bags
(`src/services/cashBagService.js`, the only writer of `cash_bags` and the
append-only `cash_bag_events`). The bag's status is a state machine checked
inside the transaction that holds the bag row (`FOR UPDATE`, status
re-checked, conditional `UPDATE`), and every change writes an event with the
actor: `in_stock` → `with_carrier` (staff hand a batch to a carrier) →
`at_reseller` (the carrier drops it off; `reseller_id` is always a top-level
reseller) → `ready_for_pickup` (the reseller seals it with a declared amount D,
0 < D ≤ cash on hand) → `in_transit` (the carrier picks it up by its serial at
that reseller) → `received` (staff count C); also `ready_for_pickup` →
`received` when the reseller brings it in, `void` from the three states
without money, `lost` from the two with money, and the returns `with_carrier`
→ `in_stock` and `at_reseller` → `with_carrier`. `received`, `void` and
`lost` are terminal. Sealing books nothing (D moves from cash on hand to
`in_bags` and frees the limit); receiving posts a `deposit` of −D and, when C
differs, an `adjustment` of D − C, both with `reseller_ledger_entries.cash_bag_id`
(net −C); a lost bag posts nothing, so D is owed as cash on hand again until
an administrator records an adjustment. Every transition whose bag has or
gets a reseller (drop-off, seal, pickup, receive, lost, and void or return of
an `at_reseller` bag) locks the reseller row first, then the bag (the order of
a collection), so a seal and a concurrent collection cannot both pass the
credit check, and two transitions of one bag cannot deadlock: the
`cash_bag_events` row and the drop-off's `reseller_id` check their foreign
key with a shared lock on the reseller row, which would otherwise be taken
after the bag. A bag that changed reseller between the read and the lock is
a 409 `BAG_CHANGED`; only a handover (no reseller) locks the bags alone. A carrier (`src/routes/carrierApp.js`,
`/api/v1/carrier-app`) sees only the top-level resellers of its
`carrier_reseller_assignments` and never an amount; a pickup of an unknown
serial, another reseller's or organization's bag, an unassigned reseller or a
bag that is not ready is the same 404, and a drop-off is all or nothing over
the carrier's own stock. Staff manage bags at `/api/v1/cash-bags`
(`src/routes/cashBags.js`), carriers at `/api/v1/carriers`
(`src/routes/carriers.js`; creating a carrier login also needs `users.create`,
like a reseller login, and `GET /carriers/assignable-resellers` lists every
live top-level reseller for the assignment picker with `carriers.manage`
alone) and read a reseller's bags at
`GET /resellers/:id/bags`; all of them are org-level only (refused to
reseller-bound users and carriers). The 409 `CREDIT_LIMIT` of a collection
carries `empty_bags` so the app can ask the reseller to fill one, and a void
is refused (409 `CASH_SEALED_IN_BAG`) when the collection's cash is no longer
on hand. Bag and
assignment user ids are primary-database `users.id` without a foreign key,
like `reseller_user_bindings.user_id`.

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

API tokens are always created with an explicit, non-empty scope list (full
access is `["*:write"]`); the API refuses a missing, empty or `null` list on
create and update, revocation is one-way (`POST /api-tokens/:id/revoke`), and
`token_hash` is never returned. `NULL` scopes remain the unrestricted sentinel
in the auth layer, but nothing can create them; an empty or invalid scope list
fails closed. A role is not expressible as a scope, so `requireRole` admits
only that sentinel — in practice role-gated admin routes (SSO configuration,
FireRelay nodes) refuse API tokens.
Installation-wide infrastructure (FireRelay node registry and tunnel commands,
backup settings, DR-drill status and runbook, system version) is gated on the install operator
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
- Every `/api/v1` route authenticates by default: `applyDefaultDeny`
  (`src/middleware/v1DefaultDeny.js`) puts `authenticate` in front of each
  route's handlers, except the reviewed `PUBLIC_V1_ROUTES` (sign-in, portal,
  provider webhooks, collectors). Route files still add `authenticate`,
  `orgScope` and `requirePermission` themselves.
  `tests/routeSecurityInventory.test.js` walks the route tree and fails on a
  route that lacks the organization scope or a permission guard without a
  reviewed reason, or a write that only a `*.view` permission guards. Custom
  guards are marked with `tagGuard` from `src/middleware/routeGuard.js` so the test
  can see them.
- Validation schemas live in `src/middleware/schemas/`. The custom `validate()`
  middleware validates declared fields and, on POST, PUT and PATCH, strips
  undeclared ones by default (TNA-38). The routes that predate this pass
  `{ strip: false }` explicitly; `tests/validateStripRatchet.test.js` keeps
  that list from growing.
- Every write route has a schema, and a create schema requires each NOT NULL
  column without a default unless the handler fills it (a parent id from the
  path, a generated number, a sealed secret). `tests/validatorSchemaParity.test.js`
  checks this against `schema.sql`, with the server-filled columns listed and
  reviewed there. Bad input is a 4xx: a missing row is `NotFoundError`, a
  provider refusal `PaymentGatewayError` (502), never a plain `Error`.
- `crudController` checks every foreign key a create or update writes against
  `req.orgId`, from the FOREIGN KEY constraints in `schema.sql`
  (`src/models/ownedForeignKeys.json`, regenerated with
  `node src/scripts/generate-owned-fks.js --write`). It runs after the route's
  own hooks; a route that checks a field itself sets `ownedRefs: { field: null }`.
  A target in `SHARED_TABLES` (NULL-organization defaults such as system
  message templates) is checked with `allowShared`. Hand-written writes use the
  same map or `ownedReferences(...)` after `validate()`.
- An action or delete on a path id answers 404 when its org-scoped statement
  matched no row (`affectedRows === 0`), never a 2xx; the real-database write
  sweep (`tests/integration/db/tenantIsolationSweep.test.js`) fails on either.
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
- A sealed value is `vb1:<key id>:<iv>:<tag>:<ciphertext>`
  (`src/utils/encryption.js`). `ENCRYPTION_KEYS_PREVIOUS` keeps old keys for
  decryption only, and `src/scripts/rotate-encryption-key.js` re-seals every
  value an old key sealed, found by its prefix in any text or JSON column, so
  a new secret column needs no registration for rotation. Do not store a
  sealed value in a column the script cannot update (a generated column, a
  table without a primary key).
- Output encoding happens at the sink: React escapes text, the knowledge-base
  HTML sink uses DOMPurify, XML builders escape XML, and email templates escape
  interpolated HTML. Do not reintroduce blanket input-side HTML encoding.

### Models and SQL

Most models extend `src/models/BaseModel.js`:

- `fillable` is an allowlist for insert/update and silently omits unknown keys.
  List filters accept `fillable`, `filterableColumns`, `id` and
  `organization_id`; a service-managed `status` is listed in
  `filterableColumns`, never assumed (DB-06).
  `tests/modelSchemaContract.test.js` checks fillable, filterable,
  `hasOrgScope`, `softDelete` and `status` against `database/schema.sql`.
- `hasOrgScope` adds the `organization_id` predicate to every generic method,
  and an omitted or `null` organization throws instead of dropping it
  (TNB-34). An install-wide caller passes `BaseModel.UNSCOPED` explicitly
  (staff identities in `User`, for instance). A model's own helpers on an
  org-scoped model take `orgId` too; `tests/modelHelperOrgScope.test.js`
  lists the reviewed exceptions.
- `softDelete` adds `deleted_at` behavior. A row the runtime selects by a flag
  declares `deactivateOnDelete` (`{ is_active: 0 }`, `{ status: 'inactive' }`)
  so a delete also switches it off (DAL-14). Hand-written SQL on a softDelete
  table filters `<alias>.deleted_at`, or marks the query
  `/* includes deleted rows: <reason> */`; `tests/softDeleteRawSql.test.js`
  ratchets the existing unfiltered reads per file.
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
boolean logic, comparison, or arithmetic. `JSON` columns arrive already decoded
(objects and arrays), so never `JSON.parse` them directly: use
`parseJsonColumn` from `src/utils/jsonColumn.js`, which also accepts JSON text
from older rows and test doubles.

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

The organization's switch (`organization_mx_profiles.pac_environment`) picks
the PAC rows that stamp; each CFDI records the environment that stamped it in
`cfdi_documents.pac_environment`, and cancellation uses PAC rows of that
environment, not the current switch (CFD-13). A sandbox CFDI was never
registered at SAT: it does not block voiding its invoice and its UUID stays
out of `/billing/tax-reports`. `GET /pac-providers/environment` reports
`sandbox_vigente_count` so the switch to production can warn about them.

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

An invoice's open balance is its total minus live `payment_allocations` and
minus live `credit_note_applications` (`utils/invoiceBalance.creditAppliedSql`).
Every balance_due, paid-status refresh, suspension and retry calculation
subtracts both. A posted credit note with an `invoice_id` is applied to it, up
to what the invoice owes, by `creditNoteApplicationService.syncApplication`.
That runs on every note write and on SAT cancellation of its egreso, and a
voided, cancelled or deleted invoice releases it. The client balance counts
only a note's unapplied part. Invoices under an active payment plan
(`notUnderActivePlanSql`) are skipped by suspension and late fees.

Every allocation path runs in one transaction that locks the payment first,
then its invoices, with `paymentAllocationService.lockInvoicesForAllocation`
(a plain `SELECT id … FOR UPDATE`, ordered by id). The locks come before any
read that sums allocations. The over-allocation triggers and the balance
subqueries are non-locking reads, and the REPEATABLE READ snapshot is fixed by
the transaction's first such read. Summing before locking lets two concurrent
allocators both pass. A draft or live REP binds its payment: delete, unapply,
reallocate, status edits and staff refunds answer `PAYMENT_HAS_REP` until the
REP is cancelled (`repService.assertNoBindingRep`).

Only `paymentAllocationService.applyAllocation` inserts `payment_allocations`
rows (BIL-28; `tests/paymentAllocationWriters.test.js` fails on another
writer). It refuses an invoice of another organization, of another client
(except group billing, `anyClient`), in another currency, or not in
`PAYABLE_STATUSES`, and maps the guard triggers to 422 `OVER_ALLOCATION` and
`ALLOCATION_EXISTS`. Waterfalls without a selection pre-filter invoices with
`allocationRefusal`, so another currency stays unallocated credit.

`pnpm run sql:check` statically checks resolvable SQL in `src/` against
`database/schema.sql`, including table/column names, ENUM values, and writes to
generated columns. Dynamic SQL is reported as skipped. The exception lists in
the checker are a ratchet: shrink them when fixing a gap and never add an entry
without a specific explanation.

`privacyNoticeService.getNotice` archives each distinct notice text the first
time it is served in `privacy_notice_versions` (one row per organization and
SHA-256; never updated) and returns its `versionId`. Portal and signed-handoff
consents store that id with the version and hash, and the portal accept
endpoint takes the displayed `version` and `hash` and answers 409
`PRIVACY_NOTICE_CHANGED` when they are no longer what is served (REG-11). An
organization that edits its own notice text must change
`privacy_notice_version` in the same update.

### Scheduled and asynchronous work

The scheduler reads `scheduled_tasks`, but executable task names must also be
registered in the `switch` in `src/services/taskRunner.js`. Every scheduler
process re-syncs its cron handles from the table each minute, and the
`/scheduled-tasks` API reloads its own process at once, so a created, edited,
disabled or deleted row needs no restart; the BullMQ worker skips a queued job
whose row was disabled or deleted. A seed row without a
cron expression, dispatcher case, scope classification, and dispatch test is a
dead feature. `tests/scheduledTaskSeedContract.test.js` replays the seeds from
the migrations and from `schema.sql`: both must seed the same rows, every row
needs a dispatcher case, and a task whose case is a `{ deferred: true }` stub
must be seeded disabled (migration 506); enable it in the migration that
implements it. Keep global versus organization-scoped execution explicit.
A seeded install-wide row runs with `organizationId = null`; a handler that
binds `organization_id = ?` must then be fanned out with
`forEachActiveOrganization` (`src/services/organizationFanOut.js`) — it reads
the org list on the primary, enters each isolated tenant's context, isolates
per-org failures and throws only when every org failed. Passing NULL straight
through matches nothing and records a successful no-op.

Handlers that already cover every organization of one database when given
`organizationId = null` (invoicing, suspension, autopay, payment retries,
ticket automation, CSD/SLA checks, scheduled reports, SNMP polling, RADIUS
sync, NAS health, speed windows, duplicate-session kicks, certificate and
maintenance-window expiry, rollover, low stock, retention checks, network
health snapshots) run through `forEachDatabaseScope` instead: once on the primary, where `orgScopeFilter()`
excludes the stale primary rows of isolated organizations, then once inside each
isolated organization's database. Use `orgScopeFilter(column, organizationId)`
for the organization predicate in such handlers; a hand-written
`organizationId ? 'AND x = ?' : ''` processes isolated organizations' stale
primary copies. A task row owned by one organization runs inside that
organization's database (`runTask` enters it). Backups (`database_backup`)
still dump the primary database only.

Redis-backed caching and BullMQ workers are optional. Code must preserve the
documented no-Redis fallback unless a deployment requirement is intentionally
changed. Some tasks use MySQL locks or row locks for cross-process exclusion;
do not replace those with process-local state.

Retention keeps connection logs, accounting events, daily usage, CGNAT
bindings and binding events covered by an active `preservation_holds` row
(REG-06, `src/services/preservationHoldService.js`): same organization, a
matching client, contract, username or IP, and an overlapping UTC range. A hold
belongs to one government request or one DSAR (whose legal hold places one).
`tests/test_preservation_holds.sql` runs the connection-log predicate in MySQL.

Calendar days are business days (BIL-34): `src/utils/businessDate.js` gives
the day in `BUSINESS_TIMEZONE` (default `America/Mexico_City`). Containers and
MySQL sessions run in UTC, so never write `CURDATE()`, `CURRENT_DATE`, a
`NOW()` comparison against a DATE, or `new Date().toISOString().slice(0, 10)`
for a business date: pass `businessToday()` as a parameter, or inline
`sqlBusinessToday()`. Models list their today-defaulted DATE columns in
`businessDateColumns`, which `BaseModel.create` fills. Cron expressions run in
the business zone. Timestamps, usage and accounting days, and the analytics
snapshot windows stay UTC.

With `REDIS_URL` set, more than one app replica may run (SEC-24): the per-IP
rate limiters count in Redis (`CacheStore`, prefix `rl_ip_<name>:`), and SSE,
browser WebSocket and GraphQL subscription events go through
`src/services/realtimeBus.js`, which delivers locally and relays over the
`vigabss:realtime` Redis channel to every other process, the worker included.
Publish through `events.broadcast` or `pubsub.publish`, never to a local client
set directly. FireRelay agent tunnels remain per process.

Bulk subscriber work runs as a batch job, never inside the request (TNA-41):
`automationService.createBatchJob` persists one `batch_job_items` row per
target and queues a `batch-job` job (`POST /batch-jobs` and `/bulk/suspend`
answer 202). `processBatchJob` holds the job's advisory lock
(`src/utils/advisoryLock.js`), claims each item as `processing` before its
operation, and records an item found still `processing` as a failure instead
of running it twice; `resumeBatchJobs` queues unfinished jobs at startup.
`send_email` and `send_sms` queue one `message_outbox` row per item (dedupe key
`batch_job_item:<org>:<item>`), and an item the client's preferences block is
`skipped`; `rate_limit`, `send_notification`, `apply_tag` and `remove_tag` have
no implementation and are refused (501) before a job is stored. CSV imports
still run in the request. A provisioning pipeline's `assign_ip` stage keeps the
contract's active `ip_assignments` row or allocates from the request's
`ip_pool_id` through `poolAssignmentService.assignNextFreeIp`; with neither it
is `skipped`. `configure_device` and `send_notification` stages remain
unimplemented and are recorded `skipped`.

The FUP throttle is state on the contract, like a soft suspension:
`contracts.fup_throttled_month` names the billing month a contract is throttled
for (migration 519). `check_fup_thresholds` (`fupService.checkFupThresholds`,
every organization) throttles an active contract once its complete-day usage
this business month reaches the plan's FUP threshold (`fup_threshold_gb`, else
`fup_threshold_percent` of `data_cap_gb`, else the cap) plus purchased packs and
rollover, and restores the plan rate when the month ends or a pack lifts it
back under. Setting and clearing the column are conditional UPDATEs, so each
contract is throttled and logged once per month. Both RADIUS paths serve the
FUP rate while the column names the current month
(`radiusAttributeService.effectiveThrottle`; a soft suspension's throttle wins),
speed-window transitions skip throttled contracts, and the CoA carries the
vendor rate attributes. `convert_expired_trials` was removed: invoices price
the trial window themselves (`billingService.isContractInTrial`).

A plan change is not done when `contracts.plan_id` is written: call
`contractPlanChangeService.pushPlanChange` after it commits. It rewrites the
contract's FreeRADIUS rows and sends the live session a CoA at the rate now in
force (the new plan's, with any speed window, unless a soft suspension or FUP
throttle applies). PUT/PATCH `/contracts/:id`, an approved portal plan change
and batch `change_plan` all call it; the batch also goes through
`contractUpdateGuard.updateContractWithActivationGuard`, like the PUT.

Each of those paths also bills the rest of an already-invoiced period at the
new price (`planChangeProrationService.prorate`, in the change's transaction):
a one-off invoice for an upgrade, an issued credit note for a downgrade. Staff
and batch changes take `prorate: false` for a courtesy change or a correction;
a contract with a `price_override` pays the same whatever its plan, so it is
never prorated.

Automation rules (`src/services/automationActions.js`, ASY-36) run on every
business event: a `*` listener on `eventBus` evaluates the organization's
enabled rules whose `trigger_event` matches (the set of trigger events is
cached per organization for a minute and dropped when a rule is saved).
`create_ticket`, `suspend_contract` and `send_notification` (outbox email or
SMS) are the only actions; saving a rule with any other `action_type` is 422,
and an action with nothing to act on is recorded `skipped`, never `success`.
The client, contract and invoice come from the event payload and are checked
against the organization. An event raised while a rule's action runs
(`AsyncLocalStorage` scope) runs no rules, so rules cannot loop.
Remediation rules (`remediation_evaluation`) send `reboot` / `reboot_device`
to the breaching device through its driver config
(`routerDriverService.dispatchCommand`), recording `success` or `failure`;
any other action, or a device without a driver that can reboot it, is
`not_dispatched`.

Every scheduled task run goes through `taskRunner.executeScheduledTask(task,
via)` (ASY-28), from the inline cron path (`via = 'cron'`), the BullMQ
`scheduled-task` worker (`'worker'`) and a manual run (`'manual'`). It records
the row's `last_status`, `last_error` and `last_duration_ms`, a
`scheduled_task_runs` history row and the `scheduled_task_runs_total` and
`scheduled_task_duration_seconds` metrics, a throw included. Both the inline
path and the worker hold the task's MySQL advisory lock
(`scheduler.runExclusive`) for the whole run, so a run never overlaps the
previous one; the worker records a refused overlap as skipped. On shutdown the
app waits for inline runs (`scheduler.drain`) before closing the database.

Outgoing messages go through `src/services/messageOutbox.js` (ASY-33):
`enqueue()` writes a `message_outbox` row (optionally inside the caller's
transaction), and the `message_outbox` task, or with Redis a `message-outbox`
job, delivers it. A row is claimed before any I/O and set to `sending` just
before the provider call; a stale claim is requeued, a stale `sending` becomes
`outcome_unknown`. Failures that provably sent nothing retry with backoff
(1, 5, 15, 60, 240 minutes) up to `max_attempts`; email also retries after a
timeout, SMS and WhatsApp do not. Consent and the organization state are
checked at enqueue and again by the transport before the call; a block is
`skipped`. Each organization has a per-minute budget per channel
(`OUTBOX_RATE_<CHANNEL>_PER_MINUTE`). Staff see and retry or cancel messages at
`/message-outbox`; retrying `outcome_unknown` needs
`confirm_possible_duplicate`. A producer with its own ledger registers
`onOutcome(source_type, fn)` in `src/services/outboxOutcomeHandlers.js`, which
the outbox loads in whichever process delivers. Send through the outbox
(`enqueue`, `queueEmail`, `smsTransport.queueSms`), or `sendNow` /
`sendEmailNow` when a person waits for the result (it delivers in the request;
a retryable failure stays queued). A message that carries a secret (reset
link, code, password) is `sensitive`: its body is hidden from the API, cleared
once final, and not retryable by staff. `emailTransport.sendEmail` and
`smsTransport.sendSms` are the outbox's adapters. Campaigns keep their own
ledger: `campaign_send` claims each `campaign_messages` row and enqueues it in
one transaction (`failed` + "Queued in the message outbox" is the in-flight
state), the outbox outcome sets its final state and the campaign counters, an
unknown outcome keeps the marker that blocks a duplicate redispatch, and
cancelling or deleting a campaign withdraws its still-queued messages
(`cancelQueuedBySource`). Provider reports reach the client through
`POST /communication/delivery-webhook` and `deliveryFeedbackService`
(migration 512): a hard bounce adds a `client_contact_suppressions` row for
the contact epoch the message went to, which the communication check refuses
for every class until the address changes; a complaint withdraws marketing
consent for the channel; an SMS STOP is a do-not-contact opt-out.
`tests/outboxOnlySender.test.js`
lists the only other direct callers (the SMTP settings test send and SNMP trap
forwarding, which has its own durable queue).

Business events (`invoice.created`, `payment.received`, `contract.suspended` /
`.restored`, `suspension.warning`, `ticket.created`, `maintenance.scheduled`)
are emitted through `src/services/businessEvents.js` once the write commits;
`src/services/notificationHooks.js` turns them into webhooks, SSE and, where
the emitter supplies a `client`, subscriber messages. A new path that creates
one of these records must call the matching helper.

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
FireRelay agent. Device logins, for that pull and for the nightly
`config_backup_pull` task, come only from `deviceCredentialService`, inside the
device's own organization and in this order: credentials typed into the
request, an active driver config bound to the device, the NAS row at the
device's address (RouterOS only), the organization's default driver config
(`device_id IS NULL`), then explicit job params. No install-wide device login
exists; a device with no stored login is refused (422) or, nightly, counted in
`no_credentials` and not contacted.

Vendor I/O goes through the driver registry in `src/services/drivers/`: a
driver is `{ vendor, protocols, toConnection, test, commands }`, and only
MikroTik has one. A vendor without a driver records `not_dispatched` or
`not_implemented`, never success. `tests/deviceDrivers.test.js` holds every
registered driver to that contract and requires every command to call a real
function of the unmocked transport module.

### Network jobs

A network job the API accepts is either executed or refused; it is never
stored to sit `pending` (NET-26). Executed jobs are a durable row plus a queued
job (`discovery-scan`, `ap-command`) that holds an advisory lock per row, and
start-up queues unfinished rows again (`resumeDiscoveryScans`,
`resumeApCommands`), like batch jobs:

- discovery scans expand their ranges through the management-target guard
  (at most 4096 addresses), probe each host's SNMP system group with bounded
  concurrency, and write `discovery_results` for responders that are not
  already devices; a scan can be cancelled;
- AP commands: only `reboot` runs, through the device's driver config; radio
  commands and future schedules are 501, a device without a capable driver 422;
- CPE firmware campaigns are launched explicitly
  (`POST /cpe-management/firmware-campaigns/:id/launch`) and queue one CWMP
  `download` task per targeted CPE (`parameters._campaignId`); every path that
  settles a CPE task recounts the campaign;
- ONU reboot, ONU firmware jobs and ONU port migrations are 501
  (`ONU_ACTION_NOT_IMPLEMENTED`) until an OLT driver exists.

The executor owns these rows' status and progress columns; create and update
routes drop them from the body.

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

`gen:api` runs with `--empty-objects-unknown`, so a response documented only as
`{ type: 'object' }` is typed `unknown` and a page narrows it (`unwrapList`,
`unwrapData` in `frontend/src/api/envelope.ts`, or a cast of `res.data`).
Document a missing path or query parameter in `src/utils/openapi.js` rather
than casting the call `as never`: `src/test/apiContract.test.ts` checks every
literal path against the spec, and `src/test/asNeverRatchet.test.ts` keeps any
file from adding an `as never` or `as unknown as` (FE-23).

A response that sends whole table rows can be typed from `database/schema.sql`
with `tableRowSchema(table)` (`src/utils/tableRowSchema.js`): DECIMAL columns
are strings (mysql2's default), dates are ISO strings, NULL-able columns may be
null, every column is required and joined fields are allowed. The invoice,
payment, credit note, ticket and contract reads use it; pages take the row
types from `frontend/src/api/rows.ts` instead of restating the columns.

Display helpers are shared: `components/ui/StatusBadge` (a page passes its
status colour map), `lib/money`'s `formatMoney` and `lib/dates`'
`formatDate` (calendar dates never shift a day). `src/test/sharedHelpers.test.ts`
keeps new pages from declaring their own StatusBadge or money formatter.

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
- The reseller app (`/punto`, `frontend/src/pages/punto/`) is for staff
  accounts with a `reseller_binding` (from `/auth/me`). `PuntoRoute` guards it
  and sends unbound users to `/`; `PrivateRoute` sends a bound user from every
  staff route to `/punto`. `PuntoLayout` is separate from the staff `Layout`
  and calls only `/auth/*` and `/reseller-app/*`, which the reseller fence
  allows. It shows a no-access notice without `reseller_app.use` and hides
  the sign-up without `reseller_app.signup`. Its tabs are Inicio (with the
  cash position from `/reseller-app/me`'s `money`), Cobrar, Clientes, Nuevo
  and Mi caja; Prospectos is reached from Inicio and Clientes. Cobrar
  (`/punto/cobrar`, also `?cliente=<id>` from a client's page) needs
  `reseller_app.collect` and sends one `Idempotency-Key` per attempt; the
  receipt (`/punto/recibo/:id`) prints at 58 mm and shares a wa.me text; Mi
  caja (`/punto/caja`) lists the day's collections (voidable as the server's
  `voidable` says), closes the cash box and shows the ledger. The server's
  refusal codes (`CREDIT_LIMIT`, `COLLECT_TOKEN_*`, the void codes) are shown
  as translated text. Staff see a reseller's cash ledger in the reseller
  page's Movimientos tab (`reseller_ledger.view`; deposits and adjustments
  need `reseller_ledger.manage`) and a reseller badge and `?reseller_id=`
  filter on the payments list. Mis bolsas (`/punto/bolsas`, reached from
  Inicio's "Mis bolsas" card and from Mi caja, not a bottom tab; needs
  `reseller_app.bags`) lists the bags from `/reseller-app/bags` and seals an
  empty one with a declared amount (`BAG_AMOUNT_EXCEEDS_CASH` shown as
  text); Cobrar's `CREDIT_LIMIT` refusal links there when `empty_bags > 0`.
- The carrier app (`/ruta`, `frontend/src/pages/ruta/`) is for accounts in
  the system `carrier` group (`carrier: true` from `/auth/me`, read by
  `auth/carrier.ts`). `RutaRoute` guards it (a bound user goes to `/punto`,
  anyone else to `/`); `PrivateRoute` and `PuntoRoute` send a carrier to
  `/ruta`. `RutaLayout` calls only `/auth/*` and `/carrier-app/*`, which the
  carrier fence allows, and never shows an amount. Screens: Inicio (assigned
  resellers), Recoger (`/ruta/recoger`), Entregar (`/ruta/entregar`, both
  `carrier_app.pickup`) and Mis bolsas (`/ruta/mis-bolsas`). Serials are
  typed, or scanned with `components/SerialScanInput.tsx` when the browser
  has `BarcodeDetector`. Staff manage bags and carriers on the Bolsas de
  efectivo page (`/cash-bags`, `frontend/src/pages/cashBags/`;
  `cash_bags.view`, its Transportistas tab `carriers.manage`), in the
  reseller page's Bolsas tab, and set a reseller's address and coordinates
  (for the carrier) in the reseller form; an edit sends a cleared address,
  city or coordinate pair as null and `PUT /resellers/:id` clears it (an
  absent field is kept).
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

Migrations are sequential and append-only. `001_baseline.sql` is the whole
schema, seed data, routines, triggers and events of the first release: the 525
development migrations were squashed into it before anything was installed,
after a CI comparison proved it produces an identical database on MySQL 8.4 and
MariaDB 10.6 (including partitions and event schedules). It is never edited and
has no rollback. Every later change is a new numbered migration.
`pnpm schema:snapshot <out.json>` writes the normalized description of a
database (tables, columns, indexes, keys, CHECKs, partitions, triggers,
routines, events with their schedule relative to creation, and every row)
that the squash was proven with; two databases built different ways are
equivalent when their snapshots are identical. Determine the
next number from the filesystem; never rely on a number copied into
documentation:

```bash
find database/migrations -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort -V | tail -1
```

For every database change:

1. Add the next numbered forward migration in `database/migrations/`. Do not
   amend an already-shipped migration.
2. Add a rollback with the identical filename in `database/rollbacks/`.
   `rollback.js` matches a rollback to its migration by the same numeric
   prefix; `rollback.js --to 1` undoes everything after the baseline, which is
   as low as it goes. A rollback must be honest about data that cannot or must
   not be restored, and one that drops or deletes evidence must refuse first
   while that evidence exists (`tests/evidenceRollbackGuards.test.js`).
3. Make DDL safe for the supported MySQL/MariaDB versions and re-execution.
   Follow current guarded stored-procedure patterns where direct
   `ALTER ... IF [NOT] EXISTS` is not portable, and drop a routine before
   creating it. Every migration after the baseline must also be safe to run a
   second time after a partial failure (guarded DDL, seeds that do not
   duplicate rows); `tests/migrationRunnerOrder.test.js` checks this and CI
   re-executes them. `migrate.js` orders files by numeric prefix and records a
   checksum of each file's SQL without comments. It warns when an applied
   migration has changed since it ran, because the change never reaches that
   database: never edit a shipped migration's statements.
4. Mirror the final structure in `database/schema.sql`.
5. Seed every new permission slug and grant it to the intended built-in roles.
   A route permission without seed/grant data locks out all ordinary users.
6. Keep `README.md` synchronized. Its latest migration number and schema table
   count are CI-checked; the database inventory and notable migration notes are also part
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
pnpm run test:db            # SQL-level tests (tests/test_*.sql) against a real database
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
`tests/integration/db` is the exception: it runs only with `DB_INTEGRATION=1`
against a migrated, disposable database (CI's `db-integration` job, on every
PR), seeds two organizations, sweeps every `/api/v1` route as one with the
other's ids, and races the numbering, billing-period, allocation and webhook
paths. The job runs twice in parallel, with the organizations' locale set by
`DB_SWEEP_LOCALE`: as MX, which seeds and sweeps the Mexican tables, and as
global, which sweeps the global path of routes that branch on locale. Every
parameterised route must resolve to a seeded row, or be listed as
install-wide or (global only) MX-only. Point it only at a throwaway database:
it writes freely.
Frontend tests run in `America/Mexico_City` (vite.config.ts), and the
coverage floor gates CI. A page test that needs the real token, refresh and
retry path stubs only `fetch` with `src/test/fakeServer.ts` and uses
mysql2-shaped fixtures (DECIMAL strings, 0/1, UTC-midnight DATEs) instead of
mocking `@/api/client`.
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
  The test compose builds the Dockerfile `test` stage (devDependencies and a
  MySQL client), applies migrations, runs `tests/run_tests.sh`, then Jest.
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
- **Stale FreeRADIUS rows:** external FreeRADIUS authenticates from the
  `radcheck`/`radreply`/`radusergroup` tables keyed by username, not from
  `radius.status`. Any path that turns service off (suspend, terminate,
  cancel, account delete/rename/deactivate) must remove those rows with
  `radiusService.syncFreeradiusContract(id, { enabled: false })` before it
  disconnects the session; turning service back on rewrites them with
  `syncFreeradiusTables(orgId, { contractId })`. The periodic full sync also
  purges rows of accounts that may no longer authenticate.
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
