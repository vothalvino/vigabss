-- =============================================================================
-- Migration 471: Bind staff users to a reseller (audit TNB-13)
-- =============================================================================
-- Reseller routes only checked that the URL reseller belonged to the caller's
-- organization, and nothing bound a user to a reseller, so any reseller_admin
-- could read and manage every reseller's customers, invoices, inventory and
-- billing entity (bank account/CLABE) in the organization.
--
-- One row binds a staff user to exactly one reseller within one organization.
-- A bound user is confined to that reseller's subtree (itself plus its
-- sub-resellers) on /resellers and /reseller-portal. An unbound user in the
-- seeded reseller_admin group is refused (fail closed); other org-level staff
-- keep cross-reseller access through their ordinary permissions.
--
-- A dedicated table (rather than organization_users.reseller_id) avoids
-- creating membership rows for users homed in the organization: a new
-- organization_users row would change their permission resolution (the
-- membership role outranks the legacy users.role fallback).
--
-- The table lives beside `resellers` (the tenant database for an isolated
-- organization), while staff identities are resolved in the primary database,
-- so user_id deliberately has no FK to users; the API verifies the user belongs
-- to the organization before binding.
--
-- UPGRADE NOTE: existing reseller_admin users lose reseller access until an
-- administrator binds them (PUT /api/v1/resellers/:id/users/:userId).
--
-- CREATE TABLE IF NOT EXISTS keeps the migration safely re-runnable.
-- =============================================================================

CREATE TABLE IF NOT EXISTS reseller_user_bindings (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id BIGINT UNSIGNED NOT NULL COMMENT 'Organization in which the binding applies',
    user_id         BIGINT UNSIGNED NOT NULL COMMENT 'Staff user (primary-DB users.id; no FK, see migration 471) confined to the reseller subtree',
    reseller_id     BIGINT UNSIGNED NOT NULL COMMENT 'Root of the reseller subtree the user may access',
    created_by      BIGINT UNSIGNED NULL     COMMENT 'Administrator who created or last changed the binding',
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_reseller_user_bindings_org_user (organization_id, user_id),
    KEY idx_reseller_user_bindings_reseller (reseller_id),
    KEY idx_reseller_user_bindings_user (user_id),
    CONSTRAINT fk_reseller_user_bindings_organization FOREIGN KEY (organization_id)
        REFERENCES organizations (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_reseller_user_bindings_reseller FOREIGN KEY (reseller_id)
        REFERENCES resellers (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Binds a staff user to one reseller subtree per organization (TNB-13)';
