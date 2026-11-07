# Contributing to VigaBSS 0.1.0-alpha.10

Thank you for your interest in contributing to VigaBSS! This guide will help you get started.

## Development Setup

### Prerequisites

- **Node.js** 24+
- **pnpm** 10+ (Corepack recommended)
- **MySQL** 8.0+ or MariaDB 10.6+ (with `event_scheduler=ON`)
- **Git**

### Quick Start

```bash
# Clone the repository
git clone https://github.com/vothalvino/vigabss.git
cd vigabss

# Install dependencies
corepack enable
pnpm install --frozen-lockfile

# Copy environment config
cp .env.example .env
# Edit .env with your database credentials

# Run database migrations
pnpm run migrate

# Seed test data (optional)
pnpm run seed

# Start development server (auto-reload)
pnpm run dev

# Run tests
pnpm test

# Run linter
pnpm run lint
```

### Project Structure

```
vigabss/
├── database/           # SQL schema and migrations
│   ├── schema.sql      # Structure reference for sql:check / schema:parity (not an installer)
│   └── migrations/     # Numbered migration files (150+)
├── docs/               # Deployment, RADIUS, API, and Grafana docs
├── k8s/                # Kubernetes manifests (deployment, HPA, ingress…)
├── frontend/           # React 19 + TypeScript + Vite admin/customer SPA
├── e2e/                # Playwright end-to-end tests
├── src/
│   ├── app.js          # Express application setup
│   ├── server.js       # HTTP server entry point
│   ├── config/         # App config, database pool, FireRelay
│   ├── controllers/    # Route handler logic
│   ├── middleware/      # Auth, RBAC, rate limiting, validation, schemas
│   ├── models/         # Database models (BaseModel and one class per table)
│   ├── routes/         # Express routers
│   ├── services/       # Business logic
│   ├── scripts/        # CLI tools (migrate, seed, backup, admin)
│   ├── utils/          # Logger, i18n, errors, encryption, OpenAPI
│   ├── views/          # Email templates
│   └── locales/        # i18n translation files (en, es, pt-BR)
├── storage/            # File uploads and backups
└── tests/              # Jest tests and SQL tests (test_*.sql)
```

### API Architecture

- **Auth**: JWT with refresh token rotation, TOTP 2FA
- **Multi-org**: All data scoped by `organization_id`; the organization comes from the signed-in session or API token (`orgScope`), never from a request header. Switching organization is `POST /auth/switch-organization`
- **RBAC**: Permission-based access control per route
- **Versioning**: Routes available at both `/api/` and `/api/v1/`
- **Real-time**: SSE event streams at `/api/v1/events/`
- **Metrics**: Prometheus at `/metrics`, Grafana templates in `docs/grafana/`

### Running Tests

```bash
# All tests (unit + integration)
pnpm test

# Watch mode
pnpm run test:watch

# SQL-level database tests: triggers, constraints, seed data (needs MySQL;
# docker-compose.test.yml provides one)
pnpm run test:db

# Run a specific test file
pnpm exec jest tests/billingService.test.js --forceExit
```

### Code Style

- **ESLint** is configured — run `pnpm run lint` before committing
- No trailing semicolons? Wrong — this project **uses semicolons**
- Single quotes for strings
- 2-space indentation
- Trailing commas in multiline expressions

### Making Changes

1. **Create a branch** from `main`: `git checkout -b feat/my-feature`
2. **Write tests first** — all new code needs test coverage
3. **Run the full suite** before pushing: `pnpm run lint && pnpm test`
4. **Keep PRs focused** — one feature or fix per PR
5. **Update docs** if your change affects the API or configuration

### Database Migrations

Migrations are numbered SQL files in `database/migrations/`:

```bash
# The highest number so far; use the next one
find database/migrations -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort -V | tail -1

# Apply migrations
pnpm run migrate
```

ARCHITECTURE.md ("Database change contract") has the full rules.

Rules:
- Always add `IF NOT EXISTS` / `IF EXISTS` guards
- Add a rollback with the same filename in `database/rollbacks/`; it must be honest about data it cannot restore
- From migration 504 on, a migration must be safe to run again after a partial failure
- Test with `docker compose -f docker-compose.test.yml up --build`
- **Always update `database/schema.sql`** — every migration that changes the database structure (new table, altered column, new index, new trigger, etc.) **must** be reflected in `database/schema.sql`. This file is the combined structure reference that `sql:check`, `schema:parity` and the SQL test suite read; it is not an installer, because seed rows (permissions, role grants, scheduled tasks) live only in migrations — install with `pnpm run migrate`. If your migration adds a table, append the `CREATE TABLE` to `schema.sql`; if it alters a column, update the corresponding table definition in `schema.sql`. Edit it by hand: never regenerate it with `mysqldump --no-data`, which drops its seed `INSERT`s, routines and events.
- **Always update `README.md`** — the README contains a **Database Tables** table and **migration notes** that serve as the project's living database reference. If your migration creates a new table, add a row to the Database Tables table. If your migration makes a notable structural change (ALTER TABLE, new trigger, new stored procedure, seed data, etc.), add a migration note blockquote (e.g. `> **Migration NNN — Short description:** ...`) to the README following the existing format.

### Commit Messages

Follow conventional commits:

```
feat: add bulk client import endpoint
fix: correct tax calculation for zero-rated items
docs: add RADIUS troubleshooting section
test: add E2E billing workflow tests
chore: update dependencies
```

## Reporting Issues

- Check existing issues first
- Include steps to reproduce
- Include relevant log output (sanitized — no secrets!)
- Specify your Node.js version and OS

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
