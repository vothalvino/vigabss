// =============================================================================
// VigaBSS 5.0 — Contract updates that respect a prepared installation
// =============================================================================
// Moved from routes/contracts.js so the batch plan change uses the same guard
// as PUT /contracts/:id (ASY-15): while a new_install service order is new or
// in process, the fields the activation will apply cannot change underneath
// it.
// =============================================================================

const db = require('../config/database');
const Contract = require('../models/Contract');
const { ValidationError } = require('../utils/errors');

const ACTIVATION_FROZEN_FIELDS = new Set([
  'client_id', 'plan_id', 'contract_template_mx_id', 'mx_contract_environment', 'connection_type',
  'start_date', 'end_date', 'billing_day', 'price_override', 'ip_address',
  'facturar', 'status',
]);

function comparableContractValue(field, value) {
  if (value === null || value === undefined || value === '') return null;
  if (field === 'start_date' || field === 'end_date') {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
  }
  if (['client_id', 'plan_id', 'contract_template_mx_id', 'billing_day', 'price_override'].includes(field)) {
    const numeric = Number(value);
    return Number.isNaN(numeric) ? String(value) : numeric;
  }
  if (field === 'facturar') return Number(Boolean(Number(value)));
  return String(value);
}

async function updateContractWithActivationGuard(contract, body, orgId, runner = db) {
  const exec = runner.query.bind(runner);
  const touched = [...ACTIVATION_FROZEN_FIELDS].filter(field => body[field] !== undefined);
  if (!touched.length || Object.prototype.hasOwnProperty.call(body, 'organization_id')) {
    return Contract.update(contract.id, body, orgId, { exec });
  }

  const filtered = {};
  for (const field of Contract.fillable) {
    if (field !== 'organization_id' && body[field] !== undefined) filtered[field] = body[field];
  }
  const columns = Object.keys(filtered);
  if (!columns.length) return Contract.findByIdOrFail(contract.id, orgId, { exec });

  // One conditional UPDATE is the concurrency boundary: prepare locks the
  // contract before creating its order, while this statement locks/updates the
  // contract only when there is no prepared installation OR every supplied
  // activation field is unchanged. Including `new` orders closes the small
  // prepare-commit -> start gap; a stale PUT cannot slip in between the old
  // SELECT and Contract.update and change the values the order will activate.
  const sets = columns.map(field => `\`${field}\` = ?`).join(', ');
  const unchanged = touched.map(field => `\`${field}\` <=> ?`).join(' AND ');
  const params = [
    ...columns.map(field => filtered[field]),
    contract.id,
    orgId,
    ...touched.map(field => comparableContractValue(field, body[field])),
  ];
  const [result] = await runner.query(
    `UPDATE \`contracts\`
        SET ${sets}
      WHERE id = ? AND organization_id = ? AND deleted_at IS NULL
        AND (
          NOT EXISTS (
            SELECT 1 FROM service_orders so
             WHERE so.contract_id = \`contracts\`.id
               AND so.organization_id = \`contracts\`.organization_id
               AND so.order_type = 'new_install'
               AND so.status IN ('new','in_process')
               AND so.deleted_at IS NULL
          )
          OR (${unchanged})
        )`,
    params,
  );
  const current = await Contract.findByIdOrFail(contract.id, orgId, { exec });
  if (result.affectedRows === 0) {
    const changed = touched.filter(field =>
      comparableContractValue(field, body[field]) !== comparableContractValue(field, current[field]));
    if (changed.length) {
      throw new ValidationError(
        `Finish or cancel the prepared/in-process installation before changing activation fields: ${changed.join(', ')}`,
      );
    }
  }
  return current;
}

module.exports = { updateContractWithActivationGuard, comparableContractValue, ACTIVATION_FROZEN_FIELDS };
