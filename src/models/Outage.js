// =============================================================================
// VigaBSS 5.0 — Outage Model
// =============================================================================

const BaseModel = require('./BaseModel');

class Outage extends BaseModel {
  static get tableName() { return 'outages'; }

  static get fillable() {
    return [
      // organization_id is fillable so crudController can inject it on create.
      // It is never
      // accepted from a request body — the route rejects that explicitly,
      // because validate() ignores undeclared fields rather than stripping
      // them, and a PUT could otherwise move an outage between tenants.
      'organization_id',
      'site_id', 'device_id', 'outage_type', 'title', 'description',
      'severity', 'started_at', 'resolved_at', 'affected_clients_count',
      'root_cause', 'status', 'created_by',
    ];
  }

  // Migration 437 added organization_id. TRUE gives every WRITE verb a strict
  // org predicate for free — before this, update/delete/restore ran with no
  // predicate at all and one tenant could resolve or delete another tenant's
  // outage.
  static get hasOrgScope() { return true; }

  // The outages table has a deleted_at column (migration 151).
  static get softDelete() { return true; }
}

module.exports = Outage;
