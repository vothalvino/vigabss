-- =============================================================================
-- Migration 492 — SAML assertions are accepted once (WHK-13, SEC-05)
-- =============================================================================
-- The SAML ACS validated the signature and minted tokens, but node-saml keeps
-- no record of what it has seen (validateInResponseTo defaults to 'never',
-- no cache provider): a captured SAMLResponse could be posted again until its
-- NotOnOrAfter and each post signed someone in. The ACS now records each
-- verified response ID here until its NotOnOrAfter and refuses a repeat.
-- =============================================================================

CREATE TABLE IF NOT EXISTS sso_saml_assertions_seen (
    organization_id BIGINT UNSIGNED NOT NULL,
    assertion_id    VARCHAR(255)    NOT NULL COMMENT 'ID of the signed SAML Response (or its assertion)',
    expires_at      DATETIME        NOT NULL COMMENT 'NotOnOrAfter of the assertion; the row can be purged after it',
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (organization_id, assertion_id),
    KEY idx_sso_saml_seen_expires (expires_at),
    CONSTRAINT fk_sso_saml_seen_org FOREIGN KEY (organization_id)
        REFERENCES organizations (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
