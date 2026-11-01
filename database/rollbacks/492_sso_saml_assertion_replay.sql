-- =============================================================================
-- Rollback 492: drop the SAML assertion replay cache
-- =============================================================================
-- SAML responses can then be replayed again until their NotOnOrAfter.
-- =============================================================================

DROP TABLE IF EXISTS sso_saml_assertions_seen;
