// =============================================================================
// VigaBSS 5.0 — ending a contract's service for good
// =============================================================================
// One implementation of "terminate", used by the contract screen's Terminate
// action and by a technology transition (the replaced contract ends when its
// replacement is activated): the contract becomes `terminated`, its RADIUS
// account stops authenticating, live sessions are disconnected, and a pickup
// work order is raised for equipment still at the customer's premises.
// =============================================================================

const db = require('../config/database');
const Contract = require('../models/Contract');
const auditLog = require('./auditLog');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger').child({ service: 'contractTermination' });

const TERMINABLE = Object.freeze(['active', 'suspended']);

/**
 * Turning service off must also remove the subscriber's FreeRADIUS SQL rows:
 * the periodic sync only rewrites active accounts (NET-03). The full sync also
 * clears them, so a failure here is logged rather than undoing the change.
 */
async function purgeFreeradiusRows(contractId, orgId) {
  try {
    await require('./radiusService').syncFreeradiusContract(contractId, { organizationId: orgId, enabled: false });
  } catch (err) {
    logger.error({ err: err.message, contractId }, 'Could not remove FreeRADIUS rows; the next sync will');
  }
}

/**
 * Terminate an active or suspended contract.
 *
 * @param {number|string} contractId
 * @param {number} orgId
 * @param {{ userId?: number|null, summary?: string|null }} [opts]
 * @returns {Promise<object>} the updated contract
 * @throws 404 when it is not this organization's, 422 NOT_TERMINABLE otherwise
 */
async function terminateContract(contractId, orgId, { userId = null, summary = null } = {}) {
  const [rows] = await db.query(
    'SELECT * FROM contracts WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [contractId, orgId],
  );
  const contract = rows[0];
  if (!contract) throw new AppError('Contract not found', 404, 'NOT_FOUND');
  if (!TERMINABLE.includes(contract.status)) {
    throw new AppError(`Cannot terminate a contract with status '${contract.status}'`, 422, 'NOT_TERMINABLE');
  }
  const record = await Contract.update(contractId, { status: 'terminated' }, orgId);
  // Stop NEW PPPoE sessions (unconditional, as cancelOrder does), then drop
  // the FreeRADIUS rows and disconnect the live session.
  await db.query(
    "UPDATE radius SET status = 'inactive' WHERE contract_id = ? AND organization_id = ? AND deleted_at IS NULL",
    [contractId, orgId],
  );
  await purgeFreeradiusRows(record.id, orgId);
  // Best-effort: a failed CoA must not undo the termination.
  require('./suspensionService').sendRadiusDisconnect(parseInt(contractId, 10)).catch(() => {});
  require('./inventorySerialService').ensurePickupWorkOrder(record.id, { orgId, performedBy: userId })
    .catch(err => logger.error({ err: err.message, contractId: record.id }, 'Failed to auto-create equipment pickup work order'));
  await auditLog.log({
    userId,
    organizationId: orgId,
    action: 'terminate',
    tableName: Contract.tableName,
    recordId: record.id,
    ...(summary ? { summary } : {}),
    oldValues: { status: contract.status },
    newValues: { status: 'terminated' },
  }).catch(() => {});
  return record;
}

module.exports = { terminateContract, purgeFreeradiusRows, TERMINABLE };
