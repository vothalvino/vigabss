// =============================================================================
// VigaBSS 5.0 — Export Controller
// =============================================================================
// CSV export endpoints for invoices, clients, contracts, and payments.
// =============================================================================

const db = require('../config/database');
const { toCsv: csvToCsv } = require('../utils/csv');

// Cells are written by utils/csv, which neutralizes spreadsheet formulas
// (TNA-25). Soft-deleted rows are left out unless ?include_deleted=true, and
// each export is recorded in report_access_logs (it carries client PII).
const toCsv = (rows) => csvToCsv(rows);

function includeDeleted(req) {
  return String(req.query?.include_deleted) === 'true';
}

async function logExport(req, entityType, rowCount) {
  await db.query(
    `INSERT INTO report_access_logs
       (organization_id, user_id, api_token_id, report_type, entity_type, parameters, ip_address, user_agent, accessed_at)
     VALUES (?, ?, ?, 'csv_export', ?, ?, ?, ?, NOW())`,
    [req.orgId ?? null, req.user?.id ?? null, req.user?.apiTokenId ?? null, entityType,
      JSON.stringify({ include_deleted: includeDeleted(req), row_count: rowCount }),
      req.ip || null, (typeof req.get === 'function' && req.get('user-agent')) || null],
  );
}

/**
 * GET /api/export/invoices
 */
async function exportInvoices(req, res, next) {
  try {
    const [rows] = await db.query(
      `SELECT i.id, i.invoice_number, i.client_id, cl.name, cl.email,
              i.subtotal, i.tax_amount, i.total, i.currency, i.status, i.due_date, i.created_at
       FROM invoices i
       LEFT JOIN clients cl ON cl.id = i.client_id
       WHERE i.organization_id = ?${includeDeleted(req) ? '' : ' AND i.deleted_at IS NULL'}
       ORDER BY i.created_at DESC`,
      [req.orgId],
    );

    res.set('Content-Type', 'text/csv');
    await logExport(req, 'invoices', rows.length);
    res.set('Content-Disposition', 'attachment; filename="invoices.csv"');
    res.send(toCsv(rows));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/export/clients
 */
async function exportClients(req, res, next) {
  try {
    const [rows] = await db.query(
      `SELECT id, name, email, phone, status, locale, country, city, state, created_at
       FROM clients
       WHERE organization_id = ?${includeDeleted(req) ? '' : ' AND deleted_at IS NULL'}
       ORDER BY name`,
      [req.orgId],
    );

    res.set('Content-Type', 'text/csv');
    await logExport(req, 'clients', rows.length);
    res.set('Content-Disposition', 'attachment; filename="clients.csv"');
    res.send(toCsv(rows));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/export/contracts
 */
async function exportContracts(req, res, next) {
  try {
    const [rows] = await db.query(
      `SELECT c.id, c.client_id, cl.name, p.name AS plan_name,
              c.status, c.connection_type, c.start_date, c.end_date, c.price_override, p.price AS plan_price, p.currency
       FROM contracts c
       JOIN clients cl ON cl.id = c.client_id
       JOIN plans p ON p.id = c.plan_id
       WHERE c.organization_id = ?${includeDeleted(req) ? '' : ' AND c.deleted_at IS NULL'}
       ORDER BY c.created_at DESC`,
      [req.orgId],
    );

    res.set('Content-Type', 'text/csv');
    await logExport(req, 'contracts', rows.length);
    res.set('Content-Disposition', 'attachment; filename="contracts.csv"');
    res.send(toCsv(rows));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/export/payments
 */
async function exportPayments(req, res, next) {
  try {
    const [rows] = await db.query(
      `SELECT p.id, p.client_id, cl.name,
              p.amount, p.currency, p.payment_method, p.payment_date, p.reference_number, p.status, p.created_at
       FROM payments p
       LEFT JOIN clients cl ON cl.id = p.client_id
       WHERE p.organization_id = ?${includeDeleted(req) ? '' : ' AND p.deleted_at IS NULL'}
       ORDER BY p.created_at DESC`,
      [req.orgId],
    );

    res.set('Content-Type', 'text/csv');
    await logExport(req, 'payments', rows.length);
    res.set('Content-Disposition', 'attachment; filename="payments.csv"');
    res.send(toCsv(rows));
  } catch (err) {
    next(err);
  }
}

module.exports = { exportInvoices, exportClients, exportContracts, exportPayments, toCsv };
