# Repository Agent Instructions

These instructions apply to the entire repository. A more-specific nested
`AGENTS.md` may add directory-local guidance, but it must preserve the security,
data-isolation, contract, and documentation invariants defined at the root.

## Mandatory startup

Before inspecting implementation details, planning, editing, testing, or
reviewing code, read `ARCHITECTURE.md` in full. It is the shared source of truth
for the project map, runtime boundaries, end-to-end contract, and validation
matrix. Do not duplicate that material in agent-specific instruction files.

If current code and `ARCHITECTURE.md` disagree, investigate rather than blindly
following either description. Treat verified code behavior as ground truth and
update `ARCHITECTURE.md` in the same change.

## Working agreement

VigaBSS has no separate QA team. For every affected workflow, trace the real
chain from navigation and page state through API transport, authentication,
organization scope, permission, validation, handler/service/model, database or
external side effect, response shape, and rendering.

Check the personas that can touch the change (these are workflow viewpoints,
not a claim that every label is a database role enum):

- admin: organizations, users/groups, security, integrations, and devices;
- manager: dashboards, reports, approvals, CRM, and campaigns;
- technician: work orders, tickets, diagnostics, provisioning, and materials;
- support: client communication, tickets, reminders, surveys, and DND;
- billing: invoices, payments, CFDI, disputes, reconciliation, and collections;
- readonly: allowed views must work and no mutation may become available;
- reseller: data must retain organization and reseller scope; and
- subscriber: portal invoices, payments, usage, account, and tickets.

Do not use an admin-only happy path as proof that RBAC works. Do not present a
stub as successful behavior. Never weaken, skip, or delete a test merely to make
a change pass.

## Scope and adjacent findings

Stay within the user's authorized task. A small adjacent defect may be fixed in
the same change only when it needs no product decision, migration, permission
slug, or broad i18n work; is tightly coupled to a file already being changed;
and does not materially widen the review. Otherwise report it clearly or use
the project's issue/jobdesk workflow when that external write is authorized.
Distinguish what was fixed from what remains.

## Definition of done

- Classify the impact: database, backend, REST/GraphQL contract, frontend,
  end-to-end flow, and/or infrastructure.
- Follow the matching validation row in `ARCHITECTURE.md`. Run focused checks
  while iterating and all applicable completion gates before claiming success.
- For an unavailable Docker service, database, credential, device, or external
  provider, state the exact command or flow not run and the residual risk.
- Report the files/behavior changed, exact validation commands and results,
  known limitations, and whether `README.md` needed an update.
- Preserve unrelated work in a dirty worktree.

## Architecture maintenance

Update `ARCHITECTURE.md` in the same change whenever you alter architecture,
ownership, data flow, authentication/authorization, persistence, tenant
isolation, a public interface, background processes, deployment, or required
commands. Prefer stable contracts and source-file links over point-in-time
counts.
