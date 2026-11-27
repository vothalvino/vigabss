// =============================================================================
// VigaBSS 5.0 — Factura global (factura pública) stamping (BIL-24)
// =============================================================================
// A factura_publica_invoices record groups paid invoices sold to the general
// public and states the period they cover (c_Periodicidad, c_Meses, Año). It
// used to be bookkeeping only: nothing built a CFDI from it. stampGlobal turns
// it into one CFDI 4.0 ingreso to PUBLICO EN GENERAL:
//
//   * one Concepto per invoice (SAT's rule for a global: each operation is a
//     concepto, ClaveProdServ 01010101, ClaveUnidad ACT, NoIdentificacion =
//     the ticket/invoice number), with that invoice's own amounts and IVA;
//   * receptor XAXX010101000 / PUBLICO EN GENERAL / régimen 616 / UsoCFDI
//     S01, DomicilioFiscalReceptor = the emisor's postal code;
//   * PUE with the predominant forma de pago of the invoices' payments;
//   * InformacionGlobal from the record (global_* columns, migration 496).
//
// The record locks first, so its invoice set cannot change while the CFDI is
// built; the stamp itself runs after commit like every other conversion.
// =============================================================================

const db = require('../config/database');
const cfdiService = require('./cfdiService');
const { nextCfdiFolio } = require('./invoiceCfdiService');
const { invoiceTaxFraction } = require('./billingService');
const auditLog = require('./auditLog');
const { AppError } = require('../utils/errors');
const {
  FORMA_PAGO_BY_METHOD, PUBLICO_EN_GENERAL_RFC, PUBLICO_EN_GENERAL_NOMBRE,
  globalPeriodProblem, nombreProblem, catalogIvaRate,
} = require('../utils/satCatalogs');
const { businessDayStartUtc } = require('../utils/businessDate');
const logger = require('../utils/logger').child({ service: 'facturaPublica' });

const GLOBAL_CLAVE_PROD_SERV = '01010101';
const GLOBAL_CLAVE_UNIDAD = 'ACT';

/**
 * What identifies a line of the global (NoIdentificacion, at most 100
 * characters): the invoice, the id of the payment that settled it and the day
 * of that payment, so each item can be traced to the money it reports.
 */
function conceptoReference(invoice) {
  const parts = [String(invoice.invoice_number || invoice.id)];
  if (invoice.payment_id) parts.push(`PAGO ${invoice.payment_id}`);
  if (invoice.payment_date) parts.push(String(invoice.payment_date).slice(0, 10));
  return parts.join(' ').slice(0, 100);
}

/** The forma de pago that carried the most money across these invoices. */
async function predominantFormaPago(exec, invoiceIds) {
  const [rows] = await exec(
    `SELECT p.sat_forma_pago, p.payment_method, SUM(pa.amount) AS amount
       FROM payment_allocations pa
       JOIN payments p ON p.id = pa.payment_id AND p.deleted_at IS NULL
      WHERE pa.invoice_id IN (${invoiceIds.map(() => '?').join(',')}) AND pa.deleted_at IS NULL
      GROUP BY p.sat_forma_pago, p.payment_method`,
    invoiceIds,
  );
  const byForma = new Map();
  for (const r of rows) {
    const forma = r.sat_forma_pago || FORMA_PAGO_BY_METHOD[r.payment_method];
    if (forma) byForma.set(forma, (byForma.get(forma) || 0) + Number(r.amount || 0));
  }
  let best = null;
  for (const [forma, amount] of byForma) {
    if (!best || amount > best.amount) best = { forma, amount };
  }
  return best ? best.forma : '01';
}

/**
 * Build and stamp the factura global for one factura pública record.
 *
 * @param {number} facturaId
 * @param {number} orgId
 * @param {{ userId?: number|null }} [opts]
 * @returns {Promise<{cfdi_document_id: number, uuid: string|null, stamped: boolean, stamp_error?: string}>}
 */
async function stampGlobal(facturaId, orgId, { userId = null } = {}) {
  const emisor = await cfdiService.getEmisorProfile(orgId);
  const emisorNameProblem = nombreProblem(emisor?.razon_social);
  if (emisorNameProblem) {
    throw new AppError(`The organization's fiscal name (razón social) ${emisorNameProblem}.`, 422, 'CFDI_NOMBRE_INVALID');
  }

  const conn = await db.getConnection();
  let docId;
  let filedCount;
  try {
    await conn.beginTransaction();
    const exec = conn.execute.bind(conn);

    const [[factura]] = await exec(
      'SELECT * FROM factura_publica_invoices WHERE id = ? AND organization_id = ? FOR UPDATE',
      [facturaId, orgId],
    );
    if (!factura) throw new AppError('Factura pública not found', 404, 'NOT_FOUND');
    if (factura.status !== 'draft' || factura.cfdi_document_id) {
      throw new AppError(
        `Only a draft factura pública can be stamped (this one is ${factura.status}${factura.cfdi_document_id ? `, CFDI #${factura.cfdi_document_id}` : ''}).`,
        409, 'FACTURA_PUBLICA_NOT_DRAFT',
      );
    }
    const periodProblem = globalPeriodProblem(factura.periodicidad, factura.meses, factura.anio);
    if (periodProblem) {
      throw new AppError(`The factura pública's period cannot be filed: ${periodProblem}.`, 422, 'FACTURA_PUBLICA_PERIOD_INVALID');
    }

    const [invoices] = await exec(
      // What the invoice's credit notes took off it: a credit note on an
      // invoice with no CFDI of its own has no CFDI either, so the global is
      // the only place that reduction can be reported.
      `SELECT i.id, i.invoice_number, i.status, i.subtotal, i.tax_amount, i.total, i.tax_rate, i.currency,
              (SELECT pa.payment_id FROM payment_allocations pa
                WHERE pa.invoice_id = i.id AND pa.deleted_at IS NULL ORDER BY pa.id DESC LIMIT 1) AS payment_id,
              (SELECT DATE_FORMAT(p.payment_date, '%Y-%m-%d') FROM payment_allocations pa
                 JOIN payments p ON p.id = pa.payment_id AND p.organization_id = i.organization_id AND p.deleted_at IS NULL
                WHERE pa.invoice_id = i.id AND pa.deleted_at IS NULL ORDER BY pa.id DESC LIMIT 1) AS payment_date,
              (SELECT COALESCE(SUM(cn.subtotal), 0) FROM credit_notes cn
                WHERE cn.invoice_id = i.id AND cn.organization_id = i.organization_id
                  AND cn.status IN ('issued', 'applied') AND cn.deleted_at IS NULL) AS credited_subtotal,
              (SELECT COALESCE(SUM(cn.tax_amount), 0) FROM credit_notes cn
                WHERE cn.invoice_id = i.id AND cn.organization_id = i.organization_id
                  AND cn.status IN ('issued', 'applied') AND cn.deleted_at IS NULL) AS credited_tax
         FROM factura_publica_invoice_items fi
         JOIN invoices i ON i.id = fi.invoice_id AND i.organization_id = ? AND i.deleted_at IS NULL
        WHERE fi.factura_publica_invoice_id = ?
        ORDER BY i.id`,
      [orgId, factura.id],
    );
    if (invoices.length === 0) {
      throw new AppError('The factura pública has no invoices to report.', 422, 'FACTURA_PUBLICA_EMPTY');
    }
    // A global reports operations already collected (PUE).
    const unpaid = invoices.filter(i => i.status !== 'paid');
    if (unpaid.length) {
      throw new AppError(
        `Only paid invoices go into a factura global; not paid: ${unpaid.map(i => i.invoice_number || i.id).join(', ')}.`,
        422, 'FACTURA_PUBLICA_UNPAID',
      );
    }
    const ids = invoices.map(i => i.id);
    const [ownCfdi] = await exec(
      `SELECT invoice_id FROM cfdi_documents
        WHERE invoice_id IN (${ids.map(() => '?').join(',')}) AND organization_id = ?
          AND sat_status IN ('draft', 'vigente', 'cancel_pending')`,
      [...ids, orgId],
    );
    if (ownCfdi.length) {
      throw new AppError(
        `These invoices already have their own CFDI and cannot also be in a factura global: ${ownCfdi.map(r => r.invoice_id).join(', ')}.`,
        422, 'FACTURA_PUBLICA_INVOICE_HAS_CFDI',
      );
    }
    const currencies = new Set(invoices.map(i => i.currency || 'MXN'));
    if (currencies.size > 1) {
      throw new AppError('A factura global is in one currency; these invoices mix currencies.', 422, 'FACTURA_PUBLICA_MIXED_CURRENCY');
    }

    const lines = invoices.map((inv) => {
      const rate = catalogIvaRate(invoiceTaxFraction(Number(inv.tax_rate || 0)));
      if (rate === null) {
        throw new AppError(
          `Invoice ${inv.invoice_number || inv.id} has a tax rate SAT does not accept (16%, 8% or 0%).`,
          422, 'CFDI_TASA_NOT_IN_CATALOG',
        );
      }
      // Net of its credit notes: what was actually sold.
      return {
        invoice: inv,
        rate,
        base: Math.round((Number(inv.subtotal || 0) - Number(inv.credited_subtotal || 0)) * 100) / 100,
        tax: Math.round((Number(inv.tax_amount || 0) - Number(inv.credited_tax || 0)) * 100) / 100,
      };
    // An invoice credited in full sold nothing: it is not a concepto.
    }).filter(line => line.base > 0);
    if (lines.length === 0) {
      throw new AppError('Every invoice in this factura pública was credited in full: there is nothing to report.', 422, 'FACTURA_PUBLICA_EMPTY');
    }
    const subtotal = Math.round(lines.reduce((s, l) => s + l.base, 0) * 100) / 100;
    const taxTotal = Math.round(lines.reduce((s, l) => s + l.tax, 0) * 100) / 100;
    const total = Math.round((subtotal + taxTotal) * 100) / 100;
    // A record built from one form of payment reports that one (migration
    // 040); an older record reports the form that carried the most money.
    const formaPago = factura.forma_pago || await predominantFormaPago(exec, ids);

    const folio = await nextCfdiFolio(conn, orgId);
    const serie = emisor.cfdi_serie_ingreso || 'A';
    const [docResult] = await exec(
      `INSERT INTO cfdi_documents
         (organization_id, client_id, invoice_id, tipo_comprobante, serie, folio,
          uso_cfdi, metodo_pago, forma_pago, moneda, exportacion,
          receptor_rfc, receptor_nombre, receptor_regimen, receptor_cp,
          global_periodicidad, global_meses, global_anio,
          subtotal, total_impuestos, total, sat_status)
       VALUES (?, NULL, NULL, 'I', ?, ?, 'S01', 'PUE', ?, ?, '01', ?, ?, '616', ?, ?, ?, ?, ?, ?, ?, 'draft')`,
      [orgId, serie, folio, formaPago, [...currencies][0],
        PUBLICO_EN_GENERAL_RFC, PUBLICO_EN_GENERAL_NOMBRE, emisor.codigo_postal_fiscal,
        factura.periodicidad, factura.meses, factura.anio,
        subtotal, taxTotal, total],
    );
    docId = docResult.insertId;

    for (const line of lines) {
      const objetoImp = line.rate > 0 ? '02' : '01';
      const [cResult] = await exec(
        `INSERT INTO cfdi_conceptos
           (cfdi_document_id, clave_prod_serv, no_identificacion, clave_unidad, cantidad, descripcion, valor_unitario, importe, objeto_imp)
         VALUES (?, ?, ?, ?, 1, 'Venta', ?, ?, ?)`,
        [docId, GLOBAL_CLAVE_PROD_SERV, conceptoReference(line.invoice),
          GLOBAL_CLAVE_UNIDAD, line.base, line.base, objetoImp],
      );
      if (line.rate > 0) {
        await exec(
          `INSERT INTO cfdi_concepto_impuestos
             (cfdi_concepto_id, tax_type, impuesto, tipo_factor, base, tasa_o_cuota, importe)
           VALUES (?, 'traslado', '002', 'Tasa', ?, ?, ?)`,
          [cResult.insertId, line.base, line.rate.toFixed(6), line.tax],
        );
      }
    }

    await exec(
      `UPDATE factura_publica_invoices
          SET cfdi_document_id = ?, subtotal = ?, total_impuestos = ?, total = ?
        WHERE id = ?`,
      [docId, subtotal, taxTotal, total, factura.id],
    );
    filedCount = lines.length;
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  await auditLog.log({
    userId, organizationId: orgId, action: 'stamp_request',
    tableName: 'cfdi_documents', recordId: docId,
    summary: `Factura pública #${facturaId} (${filedCount} invoices) converted to factura global CFDI #${docId}`,
  });

  await cfdiService.generateXml(docId);
  try {
    const result = await cfdiService.stamp(docId, { userId });
    await db.query("UPDATE factura_publica_invoices SET status = 'stamped' WHERE id = ? AND organization_id = ?", [facturaId, orgId]);
    return { cfdi_document_id: docId, uuid: result.uuid, stamped: true };
  } catch (err) {
    logger.warn({ facturaId, docId, err: err.message }, 'Factura global created but PAC stamping failed — retry from the CFDI page');
    return { cfdi_document_id: docId, uuid: null, stamped: false, stamp_error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Building the invoice set (the staff screen)
// ---------------------------------------------------------------------------

/**
 * The UTC range [from, to) of business days a factura's period covers:
 * Meses 01-12 is that month of Año (every periodicidad but bimestral reports
 * one month), 13-18 a bimester (13 = January-February … 18 = November-December).
 */
function periodRange(factura) {
  const m = Number(factura.meses);
  const y = Number(factura.anio);
  const first = m >= 13 ? (m - 13) * 2 + 1 : m;
  const months = m >= 13 ? 2 : 1;
  const ymd = (year, month) => `${year}-${String(month).padStart(2, '0')}-01`;
  const endMonth = first + months;
  return {
    from: businessDayStartUtc(ymd(y, first)),
    to: businessDayStartUtc(endMonth > 12 ? ymd(y + 1, endMonth - 12) : ymd(y, endMonth)),
  };
}

// Paid in the period, live, with no CFDI of its own, and in no factura global
// yet (an invoice can be in one: UNIQUE(invoice_id)). stampGlobal checks the
// same again, under the record's lock.
// Each query writes i.deleted_at IS NULL itself, beside this fragment.
const ELIGIBLE_WHERE = `i.organization_id = ? AND i.status = 'paid'
        AND i.paid_at >= ? AND i.paid_at < ?
        AND NOT EXISTS (SELECT 1 FROM cfdi_documents cd
                         WHERE cd.invoice_id = i.id AND cd.organization_id = i.organization_id
                           AND cd.sat_status IN ('draft', 'vigente', 'cancel_pending'))
        AND NOT EXISTS (SELECT 1 FROM factura_publica_invoice_items fi WHERE fi.invoice_id = i.id)`;

async function lockDraft(exec, facturaId, orgId) {
  const [[factura]] = await exec(
    'SELECT * FROM factura_publica_invoices WHERE id = ? AND organization_id = ? FOR UPDATE',
    [facturaId, orgId],
  );
  if (!factura) throw new AppError('Factura pública not found', 404, 'NOT_FOUND');
  if (factura.status !== 'draft' || factura.cfdi_document_id) {
    throw new AppError(
      `Invoices can only be changed on a draft factura pública (this one is ${factura.status}).`,
      422, 'FACTURA_PUBLICA_NOT_DRAFT',
    );
  }
  return factura;
}

/**
 * Invoices that may join this factura, newest payment first, with their count
 * and sum for the "add all" action.
 */
async function listEligibleInvoices(facturaId, orgId, { page = 1, limit = 50 } = {}) {
  const [[factura]] = await db.query(
    'SELECT * FROM factura_publica_invoices WHERE id = ? AND organization_id = ?',
    [facturaId, orgId],
  );
  if (!factura) throw new AppError('Factura pública not found', 404, 'NOT_FOUND');
  const { from, to } = periodRange(factura);
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 50), 100);
  const params = [orgId, from, to];
  const [rows] = await db.query(
    `SELECT i.id, i.invoice_number, i.client_id, i.total, i.currency, i.paid_at
       FROM invoices i
      WHERE i.deleted_at IS NULL AND ${ELIGIBLE_WHERE}
      ORDER BY i.paid_at DESC, i.id DESC LIMIT ${limitNum} OFFSET ${(pageNum - 1) * limitNum}`,
    params,
  );
  const [totals] = await db.query(
    `SELECT i.currency, COUNT(*) AS count, COALESCE(SUM(i.total), 0) AS total
       FROM invoices i WHERE i.deleted_at IS NULL AND ${ELIGIBLE_WHERE} GROUP BY i.currency ORDER BY i.currency`,
    params,
  );
  const total = totals.reduce((n, t) => n + Number(t.count), 0);
  return {
    data: rows,
    meta: {
      total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum),
      period: { from: from.toISOString(), to: to.toISOString() },
      byCurrency: totals.map(t => ({ currency: t.currency, count: Number(t.count), total: String(t.total) })),
    },
  };
}

/**
 * Link every eligible invoice of the period in one statement. With a
 * currency, only that currency's (a factura global is in one currency).
 */
async function addEligibleInvoices(facturaId, orgId, { currency = null } = {}) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const exec = conn.execute.bind(conn);
    const factura = await lockDraft(exec, facturaId, orgId);
    const { from, to } = periodRange(factura);
    const [result] = await exec(
      `INSERT INTO factura_publica_invoice_items (factura_publica_invoice_id, invoice_id)
       SELECT ?, i.id FROM invoices i
        WHERE i.deleted_at IS NULL AND ${ELIGIBLE_WHERE}${currency ? ' AND i.currency = ?' : ''}
        ORDER BY i.id`,
      [factura.id, orgId, from, to, ...(currency ? [currency] : [])],
    );
    await conn.commit();
    return { added: result.affectedRows };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Unlink one invoice from a draft factura. */
async function removeItem(facturaId, itemId, orgId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const exec = conn.execute.bind(conn);
    const factura = await lockDraft(exec, facturaId, orgId);
    const [result] = await exec(
      'DELETE FROM factura_publica_invoice_items WHERE id = ? AND factura_publica_invoice_id = ?',
      [itemId, factura.id],
    );
    if (!result.affectedRows) throw new AppError('Factura pública item not found', 404, 'NOT_FOUND');
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Built from a date range (migration 040)
// ---------------------------------------------------------------------------
// Staff choose a range of payment days. The paid invoices of that range that
// were never stamped (the client did not ask for a CFDI) are listed, each
// with the payment that settled it: its id, its day and its form. Staff untick
// what they want to leave out and choose whether each form of payment gets
// its own General Public invoice (a CFDI states one form of payment) or all
// go into one.
//
// An invoice belongs to the payment that completed it (its latest
// allocation): that payment's day and form are when and how it was collected.
// An invoice is eligible when it is paid, has no CFDI of its own and is in no
// other General Public invoice.

// SAT c_FormaPago of a payment: its own code, else its method's.
const FORMA_SQL = `COALESCE(p.sat_forma_pago, CASE p.payment_method ${
  Object.entries(FORMA_PAGO_BY_METHOD).map(([method, forma]) => `WHEN '${method}' THEN '${forma}'`).join(' ')
} ELSE '03' END)`;

const SETTLED_BY = `FROM invoices i
       JOIN payment_allocations pa ON pa.deleted_at IS NULL
                                  AND pa.id = (SELECT MAX(last.id) FROM payment_allocations last
                                                WHERE last.invoice_id = i.id AND last.deleted_at IS NULL)
       JOIN payments p ON p.id = pa.payment_id AND p.organization_id = i.organization_id
                      AND p.status = 'completed' AND p.deleted_at IS NULL
       LEFT JOIN clients c ON c.id = i.client_id AND c.organization_id = i.organization_id /* includes deleted rows: a payment keeps naming its client */
      WHERE i.organization_id = ? AND i.deleted_at IS NULL AND i.status = 'paid'
        AND p.payment_date >= ? AND p.payment_date <= ?
        AND NOT EXISTS (SELECT 1 FROM cfdi_documents cd
                         WHERE cd.invoice_id = i.id AND cd.organization_id = i.organization_id
                           AND cd.sat_status IN ('draft', 'vigente', 'cancel_pending'))
        AND NOT EXISTS (SELECT 1 FROM factura_publica_invoice_items fi WHERE fi.invoice_id = i.id)`;

const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const FORMAS = [...new Set(Object.values(FORMA_PAGO_BY_METHOD))];

/** The range a record may cover: real days, in order, inside one calendar month. */
function checkRange({ date_from: from, date_to: to }) {
  if (!isDay(from) || !isDay(to)) throw new AppError('date_from and date_to must be dates (YYYY-MM-DD).', 422, 'VALIDATION_ERROR');
  if (from > to) throw new AppError('date_from is after date_to.', 422, 'VALIDATION_ERROR');
  if (from.slice(0, 7) !== to.slice(0, 7)) {
    throw new AppError('A General Public invoice covers days of one month. Make one per month.', 422, 'FACTURA_PUBLICA_RANGE');
  }
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
  // SAT c_Periodicidad for the span: a day, a week, a fortnight, a month.
  const periodicidad = days === 1 ? '01' : days <= 7 ? '02' : days <= 16 ? '03' : '04';
  return { from, to, periodicidad, meses: from.slice(5, 7), anio: Number(from.slice(0, 4)) };
}

/**
 * The paid, never-stamped invoices whose settling payment falls in the range,
 * each with that payment's id, day, method and SAT form. Amounts are net of
 * the invoices' credit notes, as the CFDI will report them.
 */
async function unreportedInvoices(orgId, range, exec = db.query.bind(db)) {
  const sel = checkRange(range);
  const [rows] = await exec(
    `SELECT i.id AS invoice_id, i.invoice_number, i.client_id, c.name AS client_name,
            p.id AS payment_id, p.payment_date, p.payment_method, ${FORMA_SQL} AS forma_pago,
            i.total - (SELECT COALESCE(SUM(cn.total), 0) FROM credit_notes cn
                        WHERE cn.invoice_id = i.id AND cn.organization_id = i.organization_id
                          AND cn.status IN ('issued', 'applied') AND cn.deleted_at IS NULL) AS net_total
       ${SETTLED_BY}
      ORDER BY p.payment_date, p.id, i.id
      LIMIT 5000`,
    [orgId, sel.from, sel.to],
  );
  const data = [];
  const byForma = new Map();
  for (const r of rows || []) {
    const total = Math.round(Number(r.net_total) * 100) / 100;
    if (!(total > 0)) continue; // credited in full: nothing was sold
    data.push({
      invoice_id: Number(r.invoice_id), invoice_number: r.invoice_number,
      client_id: r.client_id, client_name: r.client_name,
      payment_id: Number(r.payment_id), payment_date: r.payment_date,
      payment_method: r.payment_method, forma_pago: r.forma_pago, total,
    });
    const f = byForma.get(r.forma_pago) || { forma_pago: r.forma_pago, invoices: 0, total: 0 };
    f.invoices += 1;
    f.total = Math.round((f.total + total) * 100) / 100;
    byForma.set(r.forma_pago, f);
  }
  return {
    data,
    meta: {
      date_from: sel.from, date_to: sel.to, periodicidad: sel.periodicidad, meses: sel.meses, anio: sel.anio,
      invoices: data.length,
      total: Math.round(data.reduce((n, r) => n + r.total, 0) * 100) / 100,
      by_forma: [...byForma.values()].sort((a, b) => b.total - a.total),
    },
  };
}

/**
 * Create draft General Public invoices from the range's unreported invoices:
 * all of them, or only `invoiceIds`. With `separate` (the default) each form
 * of payment gets its own draft, which reports that form; without it, one
 * draft holds them all and reports the form that carried the most money.
 * What is eligible is read again inside the transaction, so an invoice that
 * stopped being eligible since the list was shown is simply not taken.
 */
async function generateFromRange(orgId, range, { invoiceIds = null, separate = true } = {}) {
  const sel = checkRange(range);
  if (invoiceIds && (invoiceIds.length > 5000 || invoiceIds.some(id => !Number.isInteger(Number(id)) || Number(id) < 1))) {
    throw new AppError('invoice_ids must be a list of invoice ids.', 422, 'VALIDATION_ERROR');
  }
  const wanted = invoiceIds ? new Set(invoiceIds.map(Number)) : null;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const exec = conn.execute.bind(conn);
    const eligible = await unreportedInvoices(orgId, range, exec);
    const chosen = eligible.data.filter(r => !wanted || wanted.has(r.invoice_id));
    if (chosen.length === 0) {
      throw new AppError('None of the chosen invoices is left to report.', 422, 'FACTURA_PUBLICA_EMPTY');
    }
    const groups = new Map();
    for (const row of chosen) {
      const key = separate ? row.forma_pago : null;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const records = [];
    for (const [forma, rows] of groups) {
      const [created] = await exec(
        `INSERT INTO factura_publica_invoices (organization_id, periodicidad, meses, anio, forma_pago, date_from, date_to)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [orgId, sel.periodicidad, sel.meses, sel.anio, forma, sel.from, sel.to],
      );
      for (const row of rows) {
        await exec(
          'INSERT INTO factura_publica_invoice_items (factura_publica_invoice_id, invoice_id) VALUES (?, ?)',
          [created.insertId, row.invoice_id],
        );
      }
      records.push({
        id: created.insertId, periodicidad: sel.periodicidad, meses: sel.meses, anio: sel.anio,
        forma_pago: forma, date_from: sel.from, date_to: sel.to, status: 'draft',
        invoices: rows.length, total: Math.round(rows.reduce((n, r) => n + r.total, 0) * 100) / 100,
      });
    }
    await conn.commit();
    return records;
  } catch (err) {
    await conn.rollback().catch(() => {});
    // Another draft took one of these invoices at the same moment.
    if (err && err.code === 'ER_DUP_ENTRY') {
      throw new AppError('One of these invoices was just added to another General Public invoice. Load the invoices again.', 409, 'FACTURA_PUBLICA_TAKEN');
    }
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  stampGlobal, predominantFormaPago, periodRange, listEligibleInvoices, addEligibleInvoices, removeItem,
  unreportedInvoices, generateFromRange, checkRange, FORMAS,
};
