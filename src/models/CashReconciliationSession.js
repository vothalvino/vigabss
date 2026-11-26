// =============================================================================
// VigaBSS 5.0 — CashReconciliationSession Model
// =============================================================================

const BaseModel = require('./BaseModel');

class CashReconciliationSession extends BaseModel {
  static get tableName() { return 'cash_reconciliation_sessions'; }

  // The list's ?date_from=&date_to= range: when the cashier was opened.
  static get dateFilter() { return { column: 'opened_at', kind: 'datetime' }; }

  static get fillable() {
    return [
      'organization_id', 'agent_user_id', 'opened_at', 'closed_at',
      'expected_total', 'counted_total', 'variance', 'status', 'notes',
      'approved_by', 'approved_at', 'review_note',
      'opening_total', 'opening_expected', 'pickups_total',
    ];
  }

  static get hasOrgScope() { return true; }

  static get softDelete() { return true; }
}

module.exports = CashReconciliationSession;
