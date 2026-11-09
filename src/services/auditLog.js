// =============================================================================
// VigaBSS 5.0 — Audit Log Service
// =============================================================================
// Records who changed what and when into the audit_logs table.
// =============================================================================

const db = require('../config/database');
const logger = require('../utils/logger');
const { runInPrimaryContext } = require('../utils/primaryContext');
const { noteAuditWriteFailure } = require('../utils/opsMetrics');

/**
 * Log an audit event.
 *
 * The audit_logs table stores the affected record as (entity_type, entity_id).
 * Historically this service INSERTed table_name/record_id/organization_id —
 * columns the table did not have — so every write threw and was swallowed here,
 * leaving the audit trail permanently empty (migration 374 added
 * organization_id and widened `action` to VARCHAR; entity_type/entity_id
 * already existed). Callers pass the affected table under either
 * `tableName`/`entityType` and its id under `recordId`/`entityId`; accept both.
 *
 * @param {object} params
 * @param {number} params.userId       - The user who performed the action
 * @param {number} [params.organizationId] - The org context (NULL for system)
 * @param {string} params.action       - verb, e.g. 'create'/'update'/'partial_update'/'delete'
 * @param {string} [params.tableName]  - The affected table (a.k.a. entityType)
 * @param {string} [params.entityType] - Alias for tableName
 * @param {number} [params.recordId]   - The affected record's ID (a.k.a. entityId)
 * @param {number} [params.entityId]   - Alias for recordId
 * @param {string} [params.summary]    - Human-readable description
 * @param {object} [params.oldValues]  - Previous values (for update/delete)
 * @param {object} [params.newValues]  - New values (for create/update)
 * @param {string} [params.ipAddress]  - Request IP (sign-in events, migration 013)
 * @param {string} [params.userAgent]  - Request browser / client
 */
async function log({ userId, organizationId, action, tableName, entityType, recordId, entityId, summary, oldValues, newValues, ipAddress, userAgent }) {
  try {
    await runInPrimaryContext(() => db.query(
      `INSERT INTO audit_logs (user_id, organization_id, action, entity_type, entity_id, summary, old_values, new_values, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId || null,
        organizationId || null,
        action,
        entityType || tableName || null,
        entityId ?? recordId ?? null,
        summary || null,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        ipAddress ? String(ipAddress).slice(0, 45) : null,
        userAgent ? String(userAgent).slice(0, 500) : null,
      ],
    ));
  } catch (err) {
    // Audit logging should never crash the request
    noteAuditWriteFailure();
    logger.error({ err, action, entityType: entityType || tableName || null }, 'Audit log error');
  }
}

module.exports = { log };
