# VigaBSS 0.1.0-alpha.1 — Frontend

React 19 + TypeScript + Vite admin panel for VigaBSS 0.1.0-alpha.1.

## Quick Start

```bash
# Install dependencies
pnpm install

# Generate typed API client from OpenAPI spec (re-run whenever the spec changes)
pnpm run gen:api

# Start dev server (proxies /api/* to http://localhost:3000)
pnpm run dev

# Type-check
pnpm run lint

# Production build
pnpm run build
```

The dev server runs on `http://localhost:5173` and proxies all `/api` and `/healthz` requests
to the Express backend on `http://localhost:3000` (configurable via `VITE_API_URL` in `.env`).

## Directory Layout

```
frontend/
├── index.html
├── vite.config.ts        # Vite config with dev proxy
├── tsconfig.json
├── src/
│   ├── main.tsx          # Entry point
│   ├── App.tsx           # Router + providers
│   ├── api/
│   │   ├── client.ts     # Typed openapi-fetch client + token store + silent refresh
│   │   └── schema.d.ts   # Generated types (do not edit manually — run pnpm run gen:api)
│   ├── auth/
│   │   ├── AuthContext.tsx   # JWT auth context (login / logout / silent refresh)
│   │   └── PrivateRoute.tsx  # Role-based route guard
│   ├── components/
│   │   └── Layout.tsx    # App shell (sidebar nav, role-filtered links)
│   └── pages/
│       ├── Dashboard.tsx
│       ├── Login.tsx
│       └── NotFound.tsx
```

## Auth Flow

1. **Login** → `POST /api/v1/auth/login` → access token held in JS memory and refresh token set as an httpOnly cookie.
2. **Startup** → calls `/api/v1/auth/refresh` with the cookie to restore the in-memory session.
3. **Silent refresh** → `openapi-fetch` middleware intercepts any `401`, calls `/api/v1/auth/refresh`, retries the original request transparently.
4. **Logout** → `POST /api/v1/auth/logout` → clears the in-memory token and server-managed cookie.

## Role-Based Routing

| Role | Access |
|---|---|
| `admin` | All pages |
| `billing` | All pages except Users, Settings |
| `technician` | All pages except Users, Settings, Reports |
| `support` | All pages except Users, Settings, Reports |
| `read-only` | Dashboard, Clients (read), Devices (read) |

Routes are guarded by `<PrivateRoute requiredRole="...">` wrappers in `App.tsx`.
The `Layout` sidebar automatically hides links the current user cannot access.

## Adding a New Page (Milestone 2.2 workflow)

1. Create `src/pages/MyPage.tsx`
2. Add a route in `App.tsx` inside the appropriate `<PrivateRoute>` block
3. Add the nav item to `NAV_ITEMS` in `src/components/Layout.tsx`
4. Use `api.GET('/my-resource', ...)` from `src/api/client.ts` for data fetching

## Regenerating API Types

Whenever the backend OpenAPI spec changes:

```bash
# From the repo root
pnpm run openapi        # regenerates /docs/openapi.json

# From /frontend
pnpm run gen:api        # regenerates src/api/schema.d.ts
```

The `schema.d.ts` file is gitignored — it is always generated at install/build time.
