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
      `SELECT i.id, i.invoice_number, i.status, i.subtotal, i.tax_amount, i.total, i.tax_rate, i.currency
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
      return {
        invoice: inv,
        rate,
        base: Math.round(Number(inv.subtotal || 0) * 100) / 100,
        tax: Math.round(Number(inv.tax_amount || 0) * 100) / 100,
      };
    });
    const subtotal = Math.round(lines.reduce((s, l) => s + l.base, 0) * 100) / 100;
    const taxTotal = Math.round(lines.reduce((s, l) => s + l.tax, 0) * 100) / 100;
    const total = Math.round((subtotal + taxTotal) * 100) / 100;
    const formaPago = await predominantFormaPago(exec, ids);

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
        [docId, GLOBAL_CLAVE_PROD_SERV, String(line.invoice.invoice_number || line.invoice.id).slice(0, 100),
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

module.exports = {
  stampGlobal, predominantFormaPago, periodRange, listEligibleInvoices, addEligibleInvoices, removeItem,
};
