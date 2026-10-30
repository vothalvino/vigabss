-- =============================================================================
-- Rollback 468 — drop user_sso_identities
-- =============================================================================
-- Roll the code back first: ssoService.findOrCreateSsoUser() reads and writes
-- this table on every SSO sign-in. The identity links are not preserved; the
-- next sign-in after re-applying migration 468 links accounts again by email,
-- under the organization-eligibility rules.
-- =============================================================================

DROP TABLE IF EXISTS user_sso_identities;
