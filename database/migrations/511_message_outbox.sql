-- =============================================================================
-- Migration 511 — one durable outbox for email, SMS, WhatsApp and push (ASY-33)
-- =============================================================================
-- Email was sent inline and never retried, portal push had no queue, SMS had
-- its own queue without retries, and campaigns had a fourth one. Every
-- outgoing message is now a message_outbox row first; the message_outbox task
-- delivers it with one set of rules: consent and organization checks right
-- before the provider call, a claim before any I/O, an "outcome unknown"
-- state once the provider may have the message, retries with backoff for
-- failures that provably sent nothing, and per-organization rate limits.
--
--   queued -> claimed -> sending -> sent
--                     \-> skipped        (consent or recipient blocked; no I/O)
--                      -> queued         (retry: next_attempt_at in the future)
--                      -> failed         (permanent, or out of attempts)
--          sending stale -> outcome_unknown (never retried automatically)
--   failed / outcome_unknown -> queued | cancelled   (staff, /message-outbox)
--
-- Re-runnable: CREATE TABLE IF NOT EXISTS, INSERT IGNORE and NOT EXISTS seeds.
-- =============================================================================

CREATE TABLE IF NOT EXISTS message_outbox (
    id                    BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
    organization_id       BIGINT UNSIGNED  NULL     COMMENT 'Owning organization; NULL = install-wide operational message',
    organization_epoch    BIGINT UNSIGNED  NOT NULL DEFAULT 0 COMMENT 'Organization outbound epoch at enqueue; a change skips the message',
    client_id             BIGINT UNSIGNED  NULL     COMMENT 'Client recipient; NULL = operational (staff or install) recipient',
    client_contact_epoch  BIGINT UNSIGNED  NOT NULL DEFAULT 0 COMMENT 'Client contact epoch at enqueue; a changed address or number skips the message',
    channel               ENUM('email','sms','whatsapp','push') NOT NULL,
    message_class         ENUM('marketing','transactional','security','support_reply') NULL
                                           COMMENT 'Required for client messages; NULL for operational ones',
    priority              TINYINT UNSIGNED NOT NULL DEFAULT 5 COMMENT 'Lower is sooner: security 1, transactional 3, support_reply 4, marketing 8',
    email_function        VARCHAR(20)      NULL     COMMENT 'Sender identity for email (general, billing, support, noc)',
    recipient             VARCHAR(320)     NULL     COMMENT 'Email address or E.164 number; NULL for push (the client''s subscriptions)',
    subject               VARCHAR(500)     NULL,
    body_text             MEDIUMTEXT       NULL,
    body_html             MEDIUMTEXT       NULL,
    payload               JSON             NULL     COMMENT 'Push event and fields, email attachments, template id',
    is_sensitive          TINYINT(1)       NOT NULL DEFAULT 0 COMMENT '1 = carries a secret (reset link, code): body hidden from the API, cleared once final, not retryable',
    source_type           VARCHAR(40)      NULL     COMMENT 'What produced it, e.g. campaign_message, invoice, password_reset',
    source_id             BIGINT UNSIGNED  NULL,
    dedupe_key            VARCHAR(191)     NULL     COMMENT 'Producer idempotency key; a second enqueue with it is ignored',
    status                ENUM('queued','claimed','sending','sent','skipped','failed','outcome_unknown','cancelled')
                                           NOT NULL DEFAULT 'queued',
    attempts              SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    max_attempts          SMALLINT UNSIGNED NOT NULL DEFAULT 5,
    next_attempt_at       TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    claimed_at            TIMESTAMP        NULL,
    sent_at               TIMESTAMP        NULL,
    provider_message_id   VARCHAR(255)     NULL,
    last_error_code       VARCHAR(64)      NULL,
    last_error            VARCHAR(1000)    NULL,
    created_at            TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_message_outbox_dedupe (dedupe_key),
    KEY idx_message_outbox_due (status, next_attempt_at, priority),
    KEY idx_message_outbox_org_status (organization_id, status, created_at),
    KEY idx_message_outbox_org_sent (organization_id, channel, sent_at),
    KEY idx_message_outbox_source (source_type, source_id),
    KEY idx_message_outbox_provider_id (provider_message_id),
    KEY idx_message_outbox_client (client_id),
    CONSTRAINT fk_message_outbox_org FOREIGN KEY (organization_id)
        REFERENCES organizations (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_message_outbox_client FOREIGN KEY (client_id)
        REFERENCES clients (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Every outgoing email, SMS, WhatsApp and push message, delivered by the message_outbox task (ASY-33)';

INSERT IGNORE INTO permissions (name, description, module) VALUES
  ('message_outbox.view',   'View queued, failed and undelivered outgoing messages', 'communications'),
  ('message_outbox.manage', 'Retry or cancel failed and undelivered outgoing messages', 'communications');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   roles r
JOIN   permissions p ON p.name = 'message_outbox.view'
WHERE  r.name IN ('admin', 'super_admin', 'support', 'billing', 'noc_operator', 'auditor');

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM   roles r
JOIN   permissions p ON p.name = 'message_outbox.manage'
WHERE  r.name IN ('admin', 'super_admin');

INSERT INTO scheduled_tasks
  (organization_id, task_name, task_type, description,
   cron_expression, priority, max_retries, timeout_seconds, is_enabled)
SELECT NULL, 'message_outbox', 'notification',
       'Deliver queued email, SMS, WhatsApp and push messages from message_outbox, with retries and per-organization rate limits.',
       '* * * * *', 'high', 3, 120, TRUE
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM scheduled_tasks
    WHERE task_name = 'message_outbox' AND organization_id IS NULL
);

-- The SMS queue drained by sms_send is replaced by the outbox; queueSms now
-- writes message_outbox rows.
DELETE FROM scheduled_tasks WHERE task_name = 'sms_send';
