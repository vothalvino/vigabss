-- =============================================================================
-- Migration 468 — bind SSO sign-in to a stable IdP identity per organization
-- =============================================================================
-- SSO used to resolve the local account purely by the IdP-asserted email,
-- install-wide, so an organization admin who pointed their SSO config at an IdP
-- they control could sign in as any account on the installation (including
-- the install operator).
--
-- ssoService.findOrCreateSsoUser() now records, per organization and provider,
-- which local user a given IdP identity (issuer + subject: OIDC `sub`, SAML
-- NameID) belongs to. After the first sign-in that binding, not the email,
-- decides the account. identity_hash = sha256(issuer || '\n' || subject) keeps
-- the unique key short and portable across MySQL/MariaDB index limits; issuer
-- and subject are kept for operators.
--
-- Every lookup binds organization_id, so one organization's IdP can never
-- resolve to an identity linked through another organization's SSO.
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_sso_identities (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id   BIGINT UNSIGNED NOT NULL COMMENT 'Organization whose SSO config linked this identity',
    provider_type     ENUM('saml', 'oidc') NOT NULL,
    issuer            VARCHAR(500) NOT NULL COMMENT 'OIDC issuer URL or SAML IdP entity ID',
    subject           VARCHAR(500) NOT NULL COMMENT 'OIDC sub claim or SAML NameID',
    identity_hash     CHAR(64) NOT NULL COMMENT 'sha256 hex of issuer + newline + subject',
    user_id           BIGINT UNSIGNED NOT NULL,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_user_sso_identity (organization_id, provider_type, identity_hash),
    UNIQUE KEY uq_user_sso_identity_user (organization_id, provider_type, user_id),
    KEY idx_user_sso_identities_user_id (user_id),
    CONSTRAINT fk_user_sso_identities_org FOREIGN KEY (organization_id)
        REFERENCES organizations (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_user_sso_identities_user FOREIGN KEY (user_id)
        REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Per-organization link from an SSO IdP identity (issuer + subject) to a local user (migration 468)';
