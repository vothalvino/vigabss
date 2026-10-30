// =============================================================================
// VigaBSS 5.0 — Device Group Model
// =============================================================================

const BaseModel = require('./BaseModel');
const { requireOrgId } = require('../utils/requireOrgId');

class DeviceGroup extends BaseModel {
  static get tableName() { return 'device_groups'; }

  static get fillable() {
    return ['organization_id', 'name', 'description', 'group_type', 'color', 'status'];
  }

  static get hasOrgScope() { return true; }

  static get softDelete() { return true; }

  // Get members (devices) of a group
  static async getMembers(groupId, orgId) {
    const db = require('../config/database');
    const [rows] = await db.query(
      `SELECT d.id, d.name, d.type, d.manufacturer, d.model, d.ip_address, d.status
       FROM device_group_members dgm
       JOIN devices d ON d.id = dgm.device_id
       WHERE dgm.device_group_id = ? AND d.deleted_at IS NULL AND d.organization_id = ?
       ORDER BY d.name`,
      [groupId, orgId],
    );
    return rows;
  }

  // Add device(s) to a group. One INSERT ... SELECT that only produces rows
  // when the group belongs to `orgId` AND each device belongs to the same
  // organization as the group, so neither a foreign group nor a foreign
  // device can be linked (previously both ids were inserted unverified).
  static async addMembers(groupId, deviceIds, orgId) {
    requireOrgId(orgId, 'DeviceGroup.addMembers');
    const db = require('../config/database');
    if (!deviceIds || deviceIds.length === 0) return 0;
    const placeholders = deviceIds.map(() => '?').join(',');
    const [result] = await db.query(
      `INSERT IGNORE INTO device_group_members (device_group_id, device_id)
       SELECT g.id, d.id
         FROM device_groups g
         JOIN devices d ON d.organization_id <=> g.organization_id AND d.deleted_at IS NULL
        WHERE g.id = ? AND g.organization_id <=> ? AND g.deleted_at IS NULL
          AND d.id IN (${placeholders})`,
      [groupId, orgId, ...deviceIds],
    );
    return result.affectedRows;
  }

  // Remove device from a group owned by `orgId`.
  static async removeMember(groupId, deviceId, orgId) {
    requireOrgId(orgId, 'DeviceGroup.removeMember');
    const db = require('../config/database');
    const [result] = await db.query(
      `DELETE dgm FROM device_group_members dgm
         JOIN device_groups g ON g.id = dgm.device_group_id
        WHERE dgm.device_group_id = ? AND dgm.device_id = ? AND g.organization_id <=> ?`,
      [groupId, deviceId, orgId],
    );
    return result.affectedRows;
  }
}

module.exports = DeviceGroup;
