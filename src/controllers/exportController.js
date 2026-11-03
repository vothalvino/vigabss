// =============================================================================
// VigaBSS 5.0 — Export Controller
// =============================================================================
// CSV export endpoints for invoices, clients, contracts, and payments.
// =============================================================================

const db = require('../config/database');
const logger = require('../utils/logger');
const { toCsv: csvToCsv, csvCell } = require('../utils/csv');

// Cells are written by utils/csv, which neutralizes spreadsheet formulas
// (TNA-25). Soft-deleted rows are left out unless ?include_deleted=true, and
// each export is recorded in report_access_logs (it carries client PII).
//
// The file is streamed (DAL-13): rows are read in keyset batches by id and
// written as they arrive, waiting for the client to drain, so a large
// organization never sits in memory as one result set and one string in the
// process that also answers RADIUS.
const toCsv = (rows) => csvToCsv(rows);

const BATCH_SIZE = 1000;

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

/** Resolves once the response can take more, or has gone away. */
function writeChunk(res, chunk) {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/**
 * Stream one export as CSV.
 * @param {object} spec
 * @param {string} spec.entityType - report_access_logs.entity_type and file name
 * @param {string[]} spec.columns - result keys, also the header row
 * @param {string} spec.from - FROM ... WHERE body; `alias` rows of this org
 * @param {string} spec.alias - the exported table's alias
 * @param {string} spec.select - the select list
 */
async function streamExport(req, res, next, { entityType, columns, select, from, alias }) {
  const where = `${alias}.organization_id = ?${includeDeleted(req) ? '' : ` AND ${alias}.deleted_at IS NULL`}`;
  let started = false;
  try {
    const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM ${from} WHERE ${where}`, [req.orgId]);
    // Recorded before any row leaves.
    await logExport(req, entityType, Number(total));

    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="${entityType}.csv"`);
    started = true;
    await writeChunk(res, columns.map(csvCell).join(','));

    let afterId = null;
    for (;;) {
      if (res.destroyed) return;
      const [rows] = await db.query(
        `SELECT ${select} FROM ${from}
         WHERE ${where}${afterId === null ? '' : ` AND ${alias}.id < ?`}
         ORDER BY ${alias}.id DESC
         LIMIT ${BATCH_SIZE}`,
        afterId === null ? [req.orgId] : [req.orgId, afterId],
      );
      if (rows.length === 0) break;
      const chunk = rows.map(row => `\n${columns.map(c => csvCell(row[c])).join(',')}`).join('');
      await writeChunk(res, chunk);
      if (rows.length < BATCH_SIZE) break;
      afterId = rows[rows.length - 1].id;
    }
    res.end();
  } catch (err) {
    if (!started) return next(err);
    // The header is out: a clean end would pass a cut-off file as complete.
    logger.error({ err, entityType, orgId: req.orgId }, 'CSV export failed mid-stream');
    res.destroy(err);
  }
}

/**
 * GET /api/export/invoices
 */
function exportInvoices(req, res, next) {
  return streamExport(req, res, next, {
    entityType: 'invoices',
    alias: 'i',
    columns: ['id', 'invoice_number', 'client_id', 'name', 'email', 'subtotal', 'tax_amount', 'total', 'currency', 'status', 'due_date', 'created_at'],
    select: `i.id, i.invoice_number, i.client_id, cl.name, cl.email,
             i.subtotal, i.tax_amount, i.total, i.currency, i.status, i.due_date, i.created_at`,
    from: 'invoices i LEFT JOIN clients cl ON cl.id = i.client_id',
  });
}

/**
 * GET /api/export/clients
 */
function exportClients(req, res, next) {
  return streamExport(req, res, next, {
    entityType: 'clients',
    alias: 'cl',
    columns: ['id', 'name', 'email', 'phone', 'status', 'locale', 'country', 'city', 'state', 'created_at'],
    select: 'cl.id, cl.name, cl.email, cl.phone, cl.status, cl.locale, cl.country, cl.city, cl.state, cl.created_at',
    from: 'clients cl',
  });
}

/**
 * GET /api/export/contracts
 */
function exportContracts(req, res, next) {
  return streamExport(req, res, next, {
    entityType: 'contracts',
    alias: 'c',
    columns: ['id', 'client_id', 'name', 'plan_name', 'status', 'connection_type', 'start_date', 'end_date', 'price_override', 'plan_price', 'currency'],
    select: `c.id, c.client_id, cl.name, p.name AS plan_name,
             c.status, c.connection_type, c.start_date, c.end_date, c.price_override, p.price AS plan_price, p.currency`,
    from: 'contracts c JOIN clients cl ON cl.id = c.client_id JOIN plans p ON p.id = c.plan_id',
  });
}

/**
 * GET /api/export/payments
 */
function exportPayments(req, res, next) {
  return streamExport(req, res, next, {
    entityType: 'payments',
    alias: 'p',
    columns: ['id', 'client_id', 'name', 'amount', 'currency', 'payment_method', 'payment_date', 'reference_number', 'status', 'created_at'],
    select: `p.id, p.client_id, cl.name,
             p.amount, p.currency, p.payment_method, p.payment_date, p.reference_number, p.status, p.created_at`,
    from: 'payments p LEFT JOIN clients cl ON cl.id = p.client_id',
  });
}

module.exports = { exportInvoices, exportClients, exportContracts, exportPayments, toCsv, BATCH_SIZE };
