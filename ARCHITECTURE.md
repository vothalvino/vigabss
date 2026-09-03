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
  the JSON API/authentication surface.
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

Reseller scoping by `reseller_id` is an additional business filter, not a hard
tenant boundary and not a substitute for `organization_id`/tenant routing.

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
scope list fails closed. GraphQL must maintain permission parity with equivalent
REST operations through `src/graphql/authz.js` and the field map in
`src/graphql/index.js`.

Known existing divergence: `src/graphql/authz.js` still short-circuits for
`user.role === 'admin'`, while REST only bypasses permissions for a validated
global-access principal. Treat this as security debt, not a pattern to copy.
When changing GraphQL authorization, align it with REST and add parity tests.

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

Many responses are direct `SELECT *` database rows. Database column names and
MySQL wire types are therefore part of the effective API contract. Verify them
in `database/schema.sql` or the migration rather than guessing aliases in the
frontend. MySQL booleans commonly return as `0`/`1`, and `DECIMAL` values return
as strings under the current mysql2 configuration; convert deliberately before
boolean logic, comparison, or arithmetic.

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

Redis-backed caching and BullMQ workers are optional. Code must preserve the
documented no-Redis fallback unless a deployment requirement is intentionally
changed. Some tasks use MySQL locks or row locks for cross-process exclusion;
do not replace those with process-local state.

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
- `isp-platform-features.md` — product/feature scope; verify completion claims
  against current code.
- `.claude/agent-memory/fullstack-autonomous-engineer/MEMORY.md` — index of
  historical implementation notes. These notes are useful leads, not current
  architectural authority; re-verify them before relying on them.

When adding a durable reference, link it here instead of copying its contents.
