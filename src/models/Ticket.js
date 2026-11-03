// =============================================================================
// VigaBSS 5.0 — Ticket Model
// =============================================================================

const BaseModel = require('./BaseModel');

class Ticket extends BaseModel {
  static get tableName() { return 'tickets'; }

  static get fillable() {
    return [
      'organization_id', 'client_id', 'contract_id', 'assigned_to',
      'subject', 'description', 'priority', 'category', 'status', 'notes',
      // Server-managed: stamped/cleared by the tickets route beforeUpdate hook on
      // status transitions. Fillable so the hook's value reaches Model.update.
      'resolved_at',
    ];
  }

  static get hasOrgScope() { return true; }

  static get softDelete() { return true; }

  static async getComments(ticketId, orgId) {
    const db = require('../config/database');
    // The ticket must belong to the organization (TNB-34).
    const [rows] = await db.query(
      `SELECT * FROM ticket_comments WHERE ticket_id = ? AND deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM tickets owner WHERE owner.id = ? AND owner.organization_id = ?)
        ORDER BY created_at ASC`,
      [ticketId, ticketId, this.scopedOrg(orgId, 'getComments')],
    );
    return rows;
  }

  static async addComment(data) {
    const db = require('../config/database');
    const [result] = await db.query(
      `INSERT INTO ticket_comments (ticket_id, user_id, author_type, body, is_internal)
       VALUES (?, ?, ?, ?, ?)`,
      [data.ticket_id, data.user_id, data.user_id ? 'staff' : 'system', data.body, data.is_internal || false],
    );
    const [rows] = await db.query('SELECT * FROM ticket_comments WHERE id = ?', [result.insertId]);
    return rows[0];
  }
}

module.exports = Ticket;
