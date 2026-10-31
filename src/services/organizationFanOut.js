// =============================================================================
// VigaBSS 5.0 — Run an org-scoped job for every active organization
// =============================================================================
// Seeded scheduled tasks are install-wide rows (organization_id NULL). A
// handler that binds `organization_id = ?` matches nothing for NULL, so those
// tasks recorded success without doing anything (ASY-02). This runs the
// handler once per active organization instead: the organization list is read
// on the primary database, an isolated tenant runs inside its own database
// context, and one organization failing does not stop the others. It throws
// only when every organization failed, so the task run is marked failed then.
// Same shape as runAlertEvaluation in taskRunner.js.
// =============================================================================

const db = require('../config/database');
const logger = require('../utils/logger').child({ service: 'organizationFanOut' });

const withPrimary = callback => (
  typeof db.withPrimaryContext === 'function' ? db.withPrimaryContext(callback) : callback()
);
const withTenant = (orgId, callback) => (
  typeof db.withTenantContext === 'function' ? db.withTenantContext(orgId, callback) : callback()
);

/**
 * @param {string} label           task name, for logs and errors
 * @param {(orgId: number) => Promise<any>} handler
 * @returns {Promise<{ organizations_total, organizations_succeeded, organizations_failed, results, failures }>}
 */
async function forEachActiveOrganization(label, handler) {
  const [organizations] = await withPrimary(() => db.query(
    `SELECT o.id,
            CASE WHEN odc.isolation_mode = 'isolated' THEN 'isolated' ELSE 'shared' END AS database_scope
       FROM organizations o
       LEFT JOIN organization_database_configs odc ON odc.organization_id = o.id
      WHERE o.status = 'active' AND o.deleted_at IS NULL
      ORDER BY o.id`,
  ));

  const summary = {
    organizations_total: organizations.length,
    organizations_succeeded: 0,
    organizations_failed: 0,
    results: [],
    failures: [],
  };

  for (const organization of organizations) {
    const orgId = Number(organization.id);
    try {
      const run = () => handler(orgId);
      const result = organization.database_scope === 'isolated'
        ? await withTenant(orgId, run)
        : await withPrimary(run);
      summary.organizations_succeeded += 1;
      summary.results.push({ organization_id: orgId, result });
    } catch (err) {
      summary.organizations_failed += 1;
      summary.failures.push({ organization_id: orgId, error: err.message });
      logger.warn({ err, organizationId: orgId, task: label }, 'Task failed for organization; continuing');
    }
  }

  if (summary.organizations_total > 0 && summary.organizations_succeeded === 0) {
    const err = new Error(`${label} failed for every active organization`);
    err.failures = summary.failures;
    throw err;
  }
  return summary;
}

module.exports = { forEachActiveOrganization };
