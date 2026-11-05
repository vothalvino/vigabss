-- =============================================================================
-- Migration 522 — CSV imports run as background jobs
-- =============================================================================
-- POST /import/<entity> parsed and inserted up to 10,000 rows inside the web
-- request: a large file held a request (and a connection) for minutes, timed
-- out at the proxy while still inserting, and left the caller unsure what had
-- been imported. A request now stores the CSV here, queues a csv-import job
-- and answers 202 with the job; the worker records the result. The CSV holds
-- subscriber data, so it is cleared when the job ends.
-- =============================================================================

CREATE TABLE IF NOT EXISTS import_jobs (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id BIGINT UNSIGNED NOT NULL COMMENT 'Owning tenant organisation',
    entity          ENUM('clients','devices','contracts','invoices','payments') NOT NULL COMMENT 'What the CSV creates',
    status          ENUM('queued','running','completed','failed') NOT NULL DEFAULT 'queued',
    csv_payload     MEDIUMTEXT      NULL     COMMENT 'The uploaded CSV; cleared when the job ends',
    total_rows      INT UNSIGNED    NULL     COMMENT 'Data rows parsed',
    imported_rows   INT UNSIGNED    NULL     COMMENT 'Rows created',
    row_errors      JSON            NULL     COMMENT '[{row, error}] for rows not created',
    error_message   VARCHAR(500)    NULL     COMMENT 'Why the job as a whole failed',
    created_by      BIGINT UNSIGNED NULL,
    started_at      DATETIME        NULL,
    completed_at    DATETIME        NULL,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_import_jobs_org_created (organization_id, created_at),
    KEY idx_import_jobs_status (status),
    CONSTRAINT fk_import_jobs_org FOREIGN KEY (organization_id)
        REFERENCES organizations (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_import_jobs_created_by FOREIGN KEY (created_by)
        REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='CSV imports queued from the web request and run by a worker (migration 522)';
