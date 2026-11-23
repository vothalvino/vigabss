// =============================================================================
// VigaBSS 5.0 — access technology of a contract (WISP or FTTH)
// =============================================================================
// A plan is offered over WISP, FTTH or both. A contract is written for one
// technology, chosen when it is created, and keeps it (migration 018; the
// rules for creating and re-planning a contract are in
// services/planAvailability.js). The one rule for "which technology is this
// contract" lives here, in JavaScript and as SQL, so every place that needs
// it (speed enforcement, the FTTH area, reports) agrees.
//
//   the contract has a technology -> that
//   it has none (older contracts) -> ftth for an FTTH-only plan, wisp otherwise
// =============================================================================

const TECHNOLOGIES = Object.freeze(['wisp', 'ftth']);
const PLAN_TECHNOLOGIES = Object.freeze(['wisp', 'ftth', 'both']);

/**
 * @param {string|null|undefined} contractTechnology contracts.access_technology
 * @param {string|null|undefined} planTechnology     plans.access_technology
 * @returns {'wisp'|'ftth'}
 */
function effectiveTechnology(contractTechnology, planTechnology) {
  if (TECHNOLOGIES.includes(contractTechnology)) return contractTechnology;
  return planTechnology === 'ftth' ? 'ftth' : 'wisp';
}

/** The same rule as an SQL expression over a contract alias and a plan alias. */
function effectiveTechnologySql(contractAlias = 'c', planAlias = 'p') {
  if (!/^[a-z_]+$/i.test(contractAlias) || !/^[a-z_]+$/i.test(planAlias)) throw new Error('invalid alias');
  return `COALESCE(${contractAlias}.access_technology, IF(${planAlias}.access_technology = 'ftth', 'ftth', 'wisp'))`;
}

module.exports = { TECHNOLOGIES, PLAN_TECHNOLOGIES, effectiveTechnology, effectiveTechnologySql };
