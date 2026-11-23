// =============================================================================
// VigaBSS 5.0 — technology transition: one contract replaces another
// =============================================================================
// A subscriber moves between WISP and FTTH with a NEW contract (a contract's
// technology is fixed, migration 018). The new contract names the one it
// replaces (contracts.replaces_contract_id, migration 021) and then follows
// the ordinary activation workflow: installation, acceptance, speed test and
// the customer's signature. Nothing here weakens those requirements; the
// transition adds two things only:
//
//   - rules for what may be replaced (same client, in service, the other
//     technology, one open replacement at a time);
//   - when the new contract is activated, the replaced one is terminated.
//
// Until that moment the old contract keeps working and keeps being billed, so
// a subscriber is never without service, and cancelling the pending
// replacement leaves the old contract untouched.
// =============================================================================

const db = require('../config/database');
const { AppError } = require('../utils/errors');
const { effectiveTechnology } = require('../utils/accessTechnology');
const logger = require('../utils/logger').child({ service: 'contractTransition' });

const REPLACEABLE = Object.freeze(['active', 'suspended']);

const refuse = (message, code) => new AppError(message, 422, code);

/**
 * Check that a new contract may replace `replacesId`. Runs inside the
 * contract-create transaction and locks the old contract, so two replacements
 * cannot be opened for it at once.
 *
 * @param {object} conn  transaction connection
 * @param {object} opts
 * @param {number} opts.orgId
 * @param {number} opts.clientId       client of the new contract
 * @param {number} opts.replacesId
 * @param {'wisp'|'ftth'} opts.technology  technology of the new contract
 * @returns {Promise<object>} the contract being replaced
 */
async function assertCanReplace(conn, { orgId, clientId, replacesId, technology }) {
  const [rows] = await conn.query(
    `SELECT c.id, c.client_id, c.status, c.access_technology, p.access_technology AS plan_technology
       FROM contracts c
       LEFT JOIN plans p ON p.id = c.plan_id AND p.deleted_at IS NULL
      WHERE c.id = ? AND c.organization_id = ? AND c.deleted_at IS NULL
      FOR UPDATE`,
    [replacesId, orgId],
  );
  const old = rows[0];
  if (!old) throw refuse('The contract to replace does not exist', 'REPLACED_CONTRACT_NOT_FOUND');
  if (Number(old.client_id) !== Number(clientId)) {
    throw refuse('A contract can only replace another contract of the same client', 'REPLACED_CONTRACT_OTHER_CLIENT');
  }
  if (!REPLACEABLE.includes(old.status)) {
    throw refuse(`Only a contract in service can be replaced (this one is ${old.status})`, 'REPLACED_CONTRACT_NOT_IN_SERVICE');
  }
  const current = effectiveTechnology(old.access_technology, old.plan_technology);
  if (current === technology) {
    throw refuse(
      `The contract is already ${current.toUpperCase()}. A replacement contract is for changing technology; to change plan, edit the contract.`,
      'REPLACEMENT_SAME_TECHNOLOGY',
    );
  }
  const [open] = await conn.query(
    `SELECT id FROM contracts
      WHERE replaces_contract_id = ? AND organization_id = ? AND status = 'pending' AND deleted_at IS NULL
      LIMIT 1`,
    [replacesId, orgId],
  );
  if (open[0]) {
    throw refuse(`Contract #${open[0].id} is already replacing this one. Finish or cancel it first.`, 'REPLACEMENT_ALREADY_OPEN');
  }
  return old;
}

/** How a contract relates to others: what it replaces, and what is replacing it. */
async function relations(contractId, orgId) {
  const [[self]] = await db.query(
    'SELECT id, replaces_contract_id FROM contracts WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [contractId, orgId],
  );
  if (!self) throw new AppError('Contract not found', 404, 'NOT_FOUND');
  let replaces = null;
  if (self.replaces_contract_id) {
    const [rows] = await db.query(
      'SELECT id, status FROM contracts WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
      [self.replaces_contract_id, orgId],
    );
    replaces = rows[0] || null;
  }
  // The newest replacement that is still open or went through.
  const [by] = await db.query(
    `SELECT id, status FROM contracts
      WHERE replaces_contract_id = ? AND organization_id = ? AND deleted_at IS NULL
        AND status IN ('pending', 'active', 'suspended')
      ORDER BY id DESC LIMIT 1`,
    [contractId, orgId],
  );
  return { replaces, replaced_by: by[0] || null };
}

/**
 * The new contract was activated: terminate the one it replaces. Called after
 * the activation has committed. A failure is logged and reported, never
 * thrown: the signed, activated contract stands, and the old one can still be
 * terminated by hand from its own screen.
 *
 * @returns {Promise<{replaced_contract_id: number, terminated: boolean, error?: string}|null>}
 */
async function completeTransition(newContractId, orgId, { userId = null } = {}) {
  const [[row]] = await db.query(
    'SELECT replaces_contract_id FROM contracts WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [newContractId, orgId],
  );
  const replacedId = row?.replaces_contract_id;
  if (!replacedId) return null;
  try {
    await require('./contractTerminationService').terminateContract(replacedId, orgId, {
      userId, summary: `Replaced by contract #${newContractId}`,
    });
    return { replaced_contract_id: Number(replacedId), terminated: true };
  } catch (err) {
    // Already ended by someone is the expected benign case.
    const benign = err.code === 'NOT_TERMINABLE';
    if (!benign) logger.error({ err: err.message, newContractId, replacedId }, 'Could not terminate the replaced contract');
    return { replaced_contract_id: Number(replacedId), terminated: false, error: benign ? null : err.message };
  }
}

module.exports = { assertCanReplace, relations, completeTransition, REPLACEABLE };
