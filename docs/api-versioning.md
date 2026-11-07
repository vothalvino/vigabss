# API Versioning Strategy

VigaBSS 0.1.0-alpha.8 uses URL-based API versioning. All endpoints are mounted under the `/api/v1/` prefix.

---

## Current State

| Prefix | Status | Notes |
|--------|--------|-------|
| `/api/v1/` | **Active** | The only version |

There is no unversioned alias: `/api/<resource>` returns 404. (An alias
existed during development and was removed before the first install, so no
client ever depended on it.)

---

## Versioning Rules

1. **Non-breaking changes** are made in-place on `/api/v1/`:
   - Adding new optional fields to request/response bodies
   - Adding new endpoints
   - Adding new query parameters
   - Adding new enum values to existing fields
   - Relaxing validation (e.g., making a required field optional)

2. **Breaking changes** require a new version (`/api/v2/`):
   - Removing or renaming fields
   - Changing field types
   - Changing validation to be more restrictive
   - Removing endpoints
   - Changing authentication/authorization behavior
   - Changing response status codes for existing behavior

---

## Introducing `/api/v2/`

When a breaking change is needed:

1. Create a new Express router for v2 in `src/app.js`:
   ```js
   const v2 = express.Router();
   // Mount updated routes
   app.use('/api/v2', v2);
   ```

2. Keep `/api/v1/` running with unchanged behavior.

3. Add deprecation headers to v1:
   ```js
   app.use('/api/v1', (req, res, next) => {
     res.set('Deprecation', 'true');
     res.set('Sunset', '<sunset-date>');
     res.set('Link', `</api/v2${req.path}>; rel="successor-version"`);
     next();
   }, v1);
   ```

4. Document the migration guide in `docs/` and announce via changelog.

5. Support both versions in parallel for at least **6 months** before sunsetting the old version.

---

## Sunset Policy

| Phase | Duration | Action |
|-------|----------|--------|
| **Active** | Ongoing | Fully supported, receives bug fixes and features |
| **Deprecated** | 6 months | Receives critical bug/security fixes only; emits `Deprecation` header |
| **Sunset** | After sunset date | Returns `410 Gone` for all requests |

---

## Response Headers Reference

| Header | Value | Description |
|--------|-------|-------------|
| `Deprecation` | `true` | Indicates this API version is deprecated ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594)) |
| `Sunset` | ISO 8601 date | Date after which this version will stop responding |
| `Link` | `<url>; rel="successor-version"` | URL of the replacement endpoint |

---

## OpenAPI Spec

The OpenAPI specification at `/api/docs` and `docs/openapi.json` always reflects the **latest active version**. When v2 is introduced, a separate `docs/openapi-v1.json` will be archived for reference.
