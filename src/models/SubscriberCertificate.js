// =============================================================================
// VigaBSS 5.0 — SubscriberCertificate Model
// =============================================================================

const BaseModel = require('./BaseModel');
const db = require('../config/database');
const { requireOrgId } = require('../utils/requireOrgId');

class SubscriberCertificate extends BaseModel {
  static get tableName() { return 'subscriber_certificates'; }

  static get hasOrgScope() { return true; }

  static get softDelete() { return false; }

  static get fillable() {
    return [
      'organization_id',
      'radius_account_id',
      'client_id',
      'common_name',
      'serial_number',
      'fingerprint_sha256',
      'valid_from',
      'valid_until',
      'status',
      'revoked_at',
      'revocation_reason',
    ];
  }

  // Every helper below binds the certificate's own organization_id. They
  // previously bound only radius_account_id / client_id / id, so any tenant
  // could list another tenant's certificate metadata or revoke its certs
  // (which drops the TLS-Cert-Serial pin at the next RADIUS sync).

  /**
   * Find all certificates for a specific RADIUS account in `orgId`.
   */
  static async findByRadiusAccount(radiusAccountId, orgId) {
    requireOrgId(orgId, 'SubscriberCertificate.findByRadiusAccount');
    const [rows] = await db.query(
      `SELECT * FROM subscriber_certificates
        WHERE radius_account_id = ? AND organization_id <=> ?
        ORDER BY created_at DESC`,
      [radiusAccountId, orgId],
    );
    return rows;
  }

  /**
   * Find all certificates for a specific client in `orgId`.
   */
  static async findByClient(clientId, orgId) {
    requireOrgId(orgId, 'SubscriberCertificate.findByClient');
    const [rows] = await db.query(
      `SELECT * FROM subscriber_certificates
        WHERE client_id = ? AND organization_id <=> ?
        ORDER BY created_at DESC`,
      [clientId, orgId],
    );
    return rows;
  }

  /**
   * Revoke a certificate by ID within `orgId`.
   */
  static async revoke(id, orgId, reason) {
    requireOrgId(orgId, 'SubscriberCertificate.revoke');
    const [result] = await db.query(
      `UPDATE subscriber_certificates
          SET status = 'revoked', revoked_at = NOW(), revocation_reason = ?
        WHERE id = ? AND organization_id <=> ?`,
      [reason || null, id, orgId],
    );
    return result;
  }
}

module.exports = SubscriberCertificate;
