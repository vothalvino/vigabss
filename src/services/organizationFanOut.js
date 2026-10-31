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

const { AsyncLocalStorage } = require('async_hooks');
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

// -----------------------------------------------------------------------------
// forEachDatabaseScope — install-wide work over every database (ASY-06)
// -----------------------------------------------------------------------------
// Billing, autopay, retries, ticket automation, certificate/SLA checks and
// SNMP polling ran install-wide against the primary database only (cron and
// BullMQ callbacks carry no tenant context). An organization moved to its own
// database was never invoiced, suspended, charged or polled — and the stale
// copy of its rows left on the primary could be. The handler now runs:
//   1. once on the primary with `organizationId` null — single-tenant rows
//      (organization_id NULL) and every shared organization — while
//      orgScopeFilter() excludes the isolated organizations' stale rows;
//   2. once per isolated organization, inside its own database context.
// One scope failing does not stop the others, but the run then throws (after
// every scope ran), so a billing or charging failure in any database marks
// the task failed instead of hiding behind the scopes that succeeded.

const scopeStore = new AsyncLocalStorage();

/**
 * SQL fragment that scopes an install-wide query: `AND column = ?` for one
 * organization; during the primary pass of forEachDatabaseScope, `AND
 * (column IS NULL OR column NOT IN (…isolated…))`; otherwise nothing.
 * @param {string} column  e.g. 'c.organization_id' (a trusted literal)
 * @param {number|null|undefined} organizationId
 * @returns {{ sql: string, params: number[] }}
 */
function orgScopeFilter(column, organizationId) {
  if (organizationId !== null && organizationId !== undefined && organizationId !== '') {
    return { sql: ` AND ${column} = ?`, params: [Number(organizationId)] };
  }
  const excluded = scopeStore.getStore()?.excludedOrganizationIds || [];
  if (!excluded.length) return { sql: '', params: [] };
  return {
    sql: ` AND (${column} IS NULL OR ${column} NOT IN (${excluded.map(() => '?').join(', ')}))`,
    params: [...excluded],
  };
}

async function isolatedOrganizationIds() {
  const [rows] = await withPrimary(() => db.query(
    `SELECT odc.organization_id
       FROM organization_database_configs odc
       JOIN organizations o ON o.id = odc.organization_id
      WHERE odc.isolation_mode = 'isolated' AND o.status = 'active' AND o.deleted_at IS NULL
      ORDER BY odc.organization_id`,
  ));
  return rows.map(row => Number(row.organization_id)).filter(Number.isSafeInteger);
}

/**
 * @param {string} label  task name, for logs and errors
 * @param {(organizationId: number|null) => Promise<any>} handler
 */
async function forEachDatabaseScope(label, handler) {
  const isolated = await isolatedOrganizationIds();
  // No isolated organizations (most installs): exactly the old single run on
  // the primary, with its own result and errors.
  if (!isolated.length) return withPrimary(() => handler(null));
  const scopes = [{ organizationId: null }, ...isolated.map(organizationId => ({ organizationId }))];
  const summary = { scopes_total: scopes.length, scopes_succeeded: 0, scopes_failed: 0, results: [], failures: [] };

  for (const { organizationId } of scopes) {
    try {
      const result = organizationId === null
        ? await withPrimary(() => scopeStore.run({ excludedOrganizationIds: isolated }, () => handler(null)))
        : await withTenant(organizationId, () => scopeStore.run({ excludedOrganizationIds: [] }, () => handler(organizationId)));
      summary.scopes_succeeded += 1;
      summary.results.push({ organization_id: organizationId, result });
    } catch (err) {
      summary.scopes_failed += 1;
      summary.failures.push({ organization_id: organizationId, error: err.message });
      logger.warn({ err, organizationId, task: label }, 'Task failed for database scope; continuing');
    }
  }

  if (summary.scopes_failed > 0) {
    const err = new Error(`${label} failed in ${summary.scopes_failed} of ${summary.scopes_total} database scope(s)`);
    err.failures = summary.failures;
    err.result = summary;
    throw err;
  }
  return summary;
}

module.exports = { forEachActiveOrganization, forEachDatabaseScope, orgScopeFilter };
