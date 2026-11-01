-- =============================================================================
-- Migration 489: Send each suspension warning once (audit ASY-19)
-- =============================================================================
-- runSuspensionWarnings kept no record of what it sent, and it runs from every
-- runAutoSuspend: billing_cycle (02:00) and the superseded auto_suspend_overdue
-- (06:00) were both enabled. A subscriber in a rule's warning window got the
-- same "will be suspended" email twice a day until the invoice was paid.
--
-- 1. suspension_warning_logs records one warning per contract, invoice and
--    rule; the sender claims a row before emailing and skips claimed ones.
-- 2. billing_cycle runs both runAutoInvoice and runAutoSuspend, so the legacy
--    install-wide auto_generate_invoices and auto_suspend_overdue rows are
--    disabled where the install-wide billing_cycle is enabled. Organization
--    rows an operator created are left alone.
--
-- CREATE TABLE IF NOT EXISTS and the idempotent UPDATE keep it re-runnable.
-- =============================================================================

CREATE TABLE IF NOT EXISTS suspension_warning_logs (
    id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id  BIGINT UNSIGNED NOT NULL,
    contract_id      BIGINT UNSIGNED NOT NULL,
    invoice_id       BIGINT UNSIGNED NOT NULL COMMENT 'Overdue invoice the warning was about',
    rule_id          BIGINT UNSIGNED NOT NULL COMMENT 'Suspension rule whose window it was in',
    sent_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_suspension_warning_logs_once (contract_id, invoice_id, rule_id),
    KEY idx_suspension_warning_logs_org (organization_id),
    KEY idx_suspension_warning_logs_invoice (invoice_id),
    KEY idx_suspension_warning_logs_rule (rule_id),
    CONSTRAINT fk_suspension_warning_logs_org FOREIGN KEY (organization_id)
        REFERENCES organizations (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_suspension_warning_logs_contract FOREIGN KEY (contract_id)
        REFERENCES contracts (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_suspension_warning_logs_invoice FOREIGN KEY (invoice_id)
        REFERENCES invoices (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_suspension_warning_logs_rule FOREIGN KEY (rule_id)
        REFERENCES suspension_rules (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Suspension warnings already sent, one per contract, invoice and rule (ASY-19)';

UPDATE scheduled_tasks
   SET is_enabled = FALSE
 WHERE organization_id IS NULL
   AND task_name IN ('auto_generate_invoices', 'auto_suspend_overdue')
   AND is_enabled = TRUE
   AND EXISTS (
       SELECT 1 FROM (
           SELECT id FROM scheduled_tasks
            WHERE task_name = 'billing_cycle' AND organization_id IS NULL AND is_enabled = TRUE
       ) AS billing_cycle
   );
