// =============================================================================
// VigaBSS 5.0 — Plan Availability Check
// =============================================================================
// Shared "is this plan selectable for a NEW or newly-moved assignment?" guard,
// used by routes/contracts.js (contract create + plan-move on PUT/PATCH/renew)
// and routes/serviceOrders.js (service-order create/update FK checks).
//
// A plan is selectable when it is LIVE (not archived/soft-deleted) and, when
// an active org context exists, either belongs to THIS organization or is a
// global plan (organization_id IS NULL). Archived plans keep billing their
// EXISTING contracts but cannot take on new ones; a plan scoped to a
// different organization must never be assignable cross-tenant (security
// hardening — see fix/network-authz-hardening).
//
// The org branch is skipped entirely when orgId is null/undefined
// (single-tenant / no active-org context), matching every other org-scoped
// lookup in this codebase (BaseModel.findById, etc.).
//
// It also holds the access-technology rules for a contract (migration 018):
// the technology is chosen when the contract is created and is fixed after
// that. Moving a subscriber between WISP and FTTH is done with a new contract.
//
// lifecycleService.js#startOrder intentionally keeps its OWN inline copy of
// this exact check (see the comment there) to avoid a route->service import
// cycle; keep both in sync if this logic ever changes.
// =============================================================================

const { AppError } = require('../utils/errors');
const { TECHNOLOGIES, PLAN_TECHNOLOGIES, effectiveTechnology } = require('../utils/accessTechnology');

/**
 * @param {object} executor - DB pool or transaction connection (exposes .query)
 * @param {number} planId
 * @param {number|null} [orgId]
 * @returns {Promise<{id: number, access_technology: string}>} the plan
 * @throws {AppError} 422 PLAN_ARCHIVED when the plan is archived, missing, or
 *   belongs to a different organization
 */
async function assertPlanSelectable(executor, planId, orgId = null) {
  let sql = 'SELECT id, access_technology FROM plans WHERE id = ? AND deleted_at IS NULL';
  const params = [planId];
  if (orgId !== null && orgId !== undefined) {
    sql += ' AND (organization_id = ? OR organization_id IS NULL)';
    params.push(orgId);
  }
  const [rows] = await executor.query(sql, params);
  if (!rows[0]) {
    throw new AppError(
      'This plan is archived, unavailable, or belongs to a different organization; a contract cannot be assigned to it.',
      422, 'PLAN_ARCHIVED',
    );
  }
  return rows[0];
}

/** A live plan's access_technology ('wisp' | 'ftth' | 'both'), or null when it is not visible to this organization. */
async function planTechnology(executor, planId, orgId = null) {
  const [rows] = await executor.query(
    `SELECT access_technology FROM plans
      WHERE id = ? AND deleted_at IS NULL AND (? IS NULL OR organization_id = ? OR organization_id IS NULL)`,
    [planId, orgId ?? null, orgId ?? null],
  );
  return rows[0] ? (rows[0].access_technology || 'wisp') : null;
}

/**
 * The technology a NEW contract is written with. It is decided once, here:
 * a contract's technology never changes afterwards (changing technology means
 * a new contract).
 *   - plan offered over one technology: that one; asking for the other is refused;
 *   - plan offered over both: the caller must say which.
 *
 * @param {string|null|undefined} offeredByPlan  the plan row's access_technology
 * @param {'wisp'|'ftth'|null|undefined} requested
 * @returns {'wisp'|'ftth'}
 */
function technologyForNewContract(offeredByPlan, requested) {
  const offered = PLAN_TECHNOLOGIES.includes(offeredByPlan) ? offeredByPlan : 'wisp';
  const asked = TECHNOLOGIES.includes(requested) ? requested : null;
  if (offered === 'both') {
    if (!asked) {
      throw new AppError('This plan is offered over WISP and FTTH. Choose which one this contract uses.', 422, 'TECHNOLOGY_REQUIRED');
    }
    return asked;
  }
  if (asked && asked !== offered) {
    throw new AppError(`This plan is not offered over ${asked.toUpperCase()}. Choose a plan that is.`, 422, 'TECHNOLOGY_NOT_OFFERED');
  }
  return offered;
}

/**
 * Moving an existing contract to another plan must keep its technology.
 * A WISP contract cannot move to an FTTH-only plan (or the reverse): that is a
 * change of technology, which takes a new contract.
 *
 * @param {object} contract  row with plan_id and access_technology
 */
async function assertPlanKeepsTechnology(executor, contract, newPlanId, orgId = null) {
  const current = effectiveTechnology(
    contract.access_technology,
    contract.plan_id ? await planTechnology(executor, contract.plan_id, orgId) : null,
  );
  const offered = (await planTechnology(executor, newPlanId, orgId)) || 'wisp';
  if (offered !== 'both' && offered !== current) {
    throw new AppError(
      `This contract is ${current.toUpperCase()} and that plan is ${offered.toUpperCase()} only. Changing technology needs a new contract.`,
      422, 'TECHNOLOGY_CHANGE_NEEDS_NEW_CONTRACT',
    );
  }
  return current;
}

module.exports = { assertPlanSelectable, planTechnology, technologyForNewContract, assertPlanKeepsTechnology };
