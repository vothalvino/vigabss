---
name: section12-ticketing-noc
description: Section 12 Ticketing & NOC — migrations 297-301 complete; full frontend (NOC dashboard, work orders, TicketDetail extensions); README has 250 rows = 250 CREATE TABLE; next migration: 302
metadata:
  type: project
---

Migrations 297-301 implemented on a section worktree (branch `12-of-isp-platform-feature.md`).

**Why:** §12 adds ticketing workflow extensions (time logs, relations, AI triage/summary, merge, source field) plus a live NOC dashboard, field dispatch work orders, mobile GPS technician tracking, and file attachments.

**How to apply:** Next migration starts at 302. Table count is now 250 (README rows 1-250 = 250 CREATE TABLE statements in schema.sql). CI checks headline "all 250 tables" text against CREATE TABLE count — both match.

## What was built

### Migrations (297-301)
- **297** — `tickets.source` column + 6 tables: `ticket_time_logs`, `ticket_relations`, `ticket_ai_triage`, `work_orders`, `work_order_materials`, `technician_gps_breadcrumbs`
- **298** — 14 permissions across `noc` and `tickets` modules
- **299** — `sla_breach_check` scheduled task seed (task_type=notification, every 5 min)
- **300** — `ticket_attachments` table + 3 permissions (ticket_attachments.view/create/delete)
- **301** — `work_order_attachments` table + 3 permissions (work_order_attachments.view/create/delete)

### New route files
- `src/routes/nocDashboard.js` — 6 endpoints: health, alarms, outages, ticket-queue, events, sla-compliance
- `src/routes/workOrders.js` — 12 endpoints: CRUD + restore + stats + materials sub-resource
- `src/routes/technicianTracking.js` — 4 endpoints: breadcrumb ingest, positions, route-optimize, history

### tickets.js extensions (existing file)
- Time logs, relations, AI triage, AI summary, merge sub-resources
- Attachment routes: GET list, POST upload (multer disk storage to `uploads/tickets/`), DELETE, GET download

### taskRunner.js
- `sla_breach_check` case added — calls `handleSlaBreachCheck(organizationId)` which marks overdue ticket_sla_events as breached
- `auto_escalate_tickets` already existed (§1.3) and handles time-based escalation via `interactionService.autoEscalateTickets`

### Frontend pages (new)
- `frontend/src/pages/NocDashboard.tsx` — 6-panel dashboard (network health, alarms, outages, ticket queue, events, SLA compliance)
- `frontend/src/pages/WorkOrders.tsx` — list/filter/create/status-dispatch/materials sub-resource

### TicketDetail extensions (existing page, extended)
`frontend/src/pages/TicketDetail.tsx` now includes panels below AiSuggestedReplyPanel:
- **AiTriagePanel** — displays `GET /tickets/:id/ai-triage` results (suggested_category/priority/resolution + KB article ID badges) plus a "Generate Summary" button calling `POST /tickets/:id/ai-summary`
- **RelationsPanel** — lists relations from `GET /tickets/:id/relations`; add form (related ticket ID + type selector); delete via `DELETE /tickets/:id/relations/:relId`
- **TimeLogsPanel** — lists entries from `GET /tickets/:id/time-logs` with total duration; add form (minutes/date/description) via `POST /tickets/:id/time-logs`
- **AttachmentsPanel** — lists from `GET /tickets/:id/attachments`; upload via FormData `POST /tickets/:id/attachments`; download link; delete via `DELETE /tickets/:ticketId/attachments/:attachmentId`
- `ticketDetail.*` i18n keys added to all 3 locales (2053 keys total)

### Router and nav
- App.tsx: noc-dashboard and work-orders routes under technician+ guard
- Layout.tsx: nav entries for noc-dashboard and work-orders

## Schema gotchas
- **outages table has NO `organization_id`** — NOC outages query joins via `sites.organization_id`
- **ticket_sla_events uses `is_breached TINYINT`** — SLA compliance query uses `is_breached = 0` for compliant count
- **alert_events exposes `metric` column** — not `message`; events timeline query uses `metric AS detail`
- **technician_gps_breadcrumbs has NO FKs** — intentional, append-only write-hot table
- **ticket_sla_events has `target_deadline`** — the column checked by sla_breach_check (not `due_at`)
- **snmp_metrics_1month** was missing from README numbered rows — added as row 28, rows 28-249 became 29-250

## Verification results (2026-06-12, commit b6adcd3)
- schema-parity-check: 0 failures
- pnpm spec:check: 627 paths, 0 drift
- pnpm lint: 0 errors
- SLA handler tests (tests/taskRunner.sla.test.js): 4/4 passed
- Full backend suite: 4047 passed, 1 suite skipped (setupSecrets CRLF pre-existing)
- Frontend lint (gen:api + tsc --noEmit): clean
- Frontend tests: 396 passed
- i18n:check: 2053/2053 100%
- Frontend build: clean
- FK dup check: no new duplicates
- README rows 250 = schema.sql CREATE TABLE 250
