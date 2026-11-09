// =============================================================================
// VigaBSS 5.0 — Reseller statement PDF (reseller program, phase 5)
// =============================================================================
// The printable estado de cuenta of a reseller statement
// (resellerSettlementService): the ISP, the reseller and the period, the
// opening balance, the period's totals by movement type, the closing balance
// ("Debes entregar" / "Te debemos"), the approval and settlement, and every
// ledger line of the period. Spanish, like the reseller app.
// =============================================================================

const PDFDocument = require('pdfkit');
const db = require('../config/database');
const { requireOrgId } = require('../utils/requireOrgId');
const settlements = require('./resellerSettlementService');
const product = require('../product');

const MARGIN = 50;
const COLORS = { primary: '#1a5276', text: '#2c3e50', muted: '#7f8c8d', border: '#bdc3c7', danger: '#c0392b', success: '#27ae60' };

// The same words as the reseller app's Mi caja (punto.ledger.types).
const TYPE_LABELS = {
  collection: 'Cobros',
  collection_void: 'Cobros anulados',
  deposit: 'Entregas a la empresa',
  adjustment: 'Ajustes',
  bag_sealed: 'Bolsas selladas',
  commission: 'Comisiones ganadas',
  commission_reversal: 'Comisiones revertidas',
  payout: 'Pagos de la empresa',
  collection_fee: 'Comisiones por cobro',
  collection_fee_reversal: 'Comisiones por cobro revertidas',
};
const LINE_LABELS = {
  collection: 'Cobro',
  collection_void: 'Cobro anulado',
  deposit: 'Entrega',
  adjustment: 'Ajuste',
  bag_sealed: 'Bolsa sellada',
  commission: 'Comisión ganada',
  commission_reversal: 'Comisión revertida',
  payout: 'Pago de la empresa',
  collection_fee: 'Comisión por cobro',
  collection_fee_reversal: 'Comisión por cobro revertida',
};
const STATUS_LABELS = { draft: 'Borrador', approved: 'Aprobado', settled: 'Liquidado', void: 'Descartado' };

function fmt(amount, currency) {
  const n = Number(amount) || 0;
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency || ''}`.trim();
}

function fmtDateTime(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function hr(doc, y) {
  doc.strokeColor(COLORS.border).lineWidth(0.5).moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y).stroke();
  return y + 8;
}

function row(doc, y, cols, { bold = false, color = COLORS.text, size = 8 } = {}) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
  let height = 0;
  for (const c of cols) {
    const text = c.text === null || c.text === undefined ? '' : String(c.text);
    doc.text(text, c.x, y, { width: c.width, align: c.align || 'left' });
    height = Math.max(height, doc.heightOfString(text, { width: c.width }));
  }
  return y + Math.max(12, height + 3);
}

function lineReference(line) {
  if (line.invoice_number) return `Factura ${line.invoice_number}`;
  if (line.cash_bag_serial) return `Bolsa ${line.cash_bag_serial}`;
  if (line.payment_id) return `Pago #${line.payment_id}`;
  return '';
}

/**
 * The PDF of one statement (the API shape of resellerSettlementService.get).
 * @returns {Promise<{buffer: Buffer, filename: string}>}
 */
async function generate(orgId, statement) {
  requireOrgId(orgId, 'resellerStatementPdf.generate');
  const [[org]] = await db.query(
    'SELECT name, email, phone, address, city, state FROM organizations WHERE id = ? AND deleted_at IS NULL',
    [orgId],
  );
  const { rows: lines } = await settlements.lines(orgId, statement, { limit: null });
  const cur = statement.currency;

  const buffer = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: MARGIN, info: { Title: `Estado de cuenta #${statement.id}` } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const width = doc.page.width - MARGIN * 2;

    // ---- Header ----
    doc.font('Helvetica-Bold').fontSize(18).fillColor(COLORS.primary).text('ESTADO DE CUENTA', MARGIN, MARGIN);
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted)
      .text(`Punto de venta · #${statement.id} · ${STATUS_LABELS[statement.status] || statement.status}`, MARGIN, MARGIN + 24);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.text)
      .text((org && org.name) || product.displayName, 330, MARGIN, { width: width - 280, align: 'right' });
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted);
    let oy = MARGIN + 15;
    for (const part of [org && org.address, org && [org.city, org.state].filter(Boolean).join(', '), org && org.email, org && org.phone]) {
      if (part) { doc.text(part, 330, oy, { width: width - 280, align: 'right' }); oy += 10; }
    }

    let y = hr(doc, Math.max(oy, MARGIN + 44) + 6);
    y = row(doc, y, [
      { x: MARGIN, width: 250, text: 'REVENDEDOR' },
      { x: 320, width: 242, text: 'PERIODO' },
    ], { bold: true, color: COLORS.muted });
    y = row(doc, y, [
      { x: MARGIN, width: 250, text: statement.reseller_name || `#${statement.reseller_id}` },
      { x: 320, width: 242, text: `${statement.period_start} a ${statement.period_end}` },
    ], { bold: true, size: 11 });
    y += 6;

    // ---- Summary ----
    y = hr(doc, y);
    const amountCol = { x: 400, width: 162, align: 'right' };
    y = row(doc, y, [{ x: MARGIN, width: 340, text: 'Saldo al inicio del periodo' }, { ...amountCol, text: fmt(statement.opening_balance, cur) }], { size: 9 });
    for (const type of settlements.TOTAL_TYPES) {
      const v = statement.totals[type] || 0;
      y = row(doc, y, [{ x: MARGIN + 12, width: 328, text: TYPE_LABELS[type] || type }, { ...amountCol, text: fmt(v, cur) }], {
        size: 9, color: v === 0 ? COLORS.muted : COLORS.text,
      });
    }
    y = hr(doc, y + 2);
    const closing = Number(statement.closing_balance) || 0;
    const closingLabel = closing > 0 ? 'Debes entregar' : closing < 0 ? 'Te debemos' : 'Saldo al cierre';
    y = row(doc, y, [
      { x: MARGIN, width: 340, text: `${closingLabel} (saldo al cierre)` },
      { ...amountCol, text: fmt(Math.abs(closing), cur) },
    ], { bold: true, size: 11, color: closing < 0 ? COLORS.success : COLORS.primary });
    y += 2;
    doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.muted)
      .text('Un saldo positivo es lo que el revendedor debe entregar a la empresa; uno negativo, lo que la empresa le debe.', MARGIN, y, { width });
    y += 14;

    // ---- Approval and settlement ----
    const facts = [];
    if (statement.approved_at) facts.push(`Aprobado: ${fmtDateTime(statement.approved_at)}`);
    if (statement.settled_at) facts.push(`Liquidado: ${fmtDateTime(statement.settled_at)}`);
    if (statement.bank_ref) facts.push(`Referencia: ${statement.bank_ref}`);
    if (statement.status === 'draft') facts.push('BORRADOR: las cifras pueden cambiar hasta su aprobación.');
    if (statement.status === 'void') facts.push('DESCARTADO: este estado de cuenta no tiene validez.');
    if (facts.length) {
      doc.font('Helvetica').fontSize(8.5).fillColor(statement.status === 'void' ? COLORS.danger : COLORS.text)
        .text(facts.join('   ·   '), MARGIN, y, { width });
      y += 16;
    }
    if (statement.notes) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(COLORS.muted).text(statement.notes, MARGIN, y, { width });
      y = doc.y + 8;
    }

    // ---- Lines ----
    const cols = [
      { x: MARGIN, width: 82 },
      { x: 136, width: 92 },
      { x: 232, width: 92 },
      { x: 328, width: 150 },
      { x: 480, width: 82, align: 'right' },
    ];
    const header = (yy) => hr(doc, row(doc, hr(doc, yy), [
      { ...cols[0], text: 'Fecha' }, { ...cols[1], text: 'Movimiento' }, { ...cols[2], text: 'Referencia' },
      { ...cols[3], text: 'Nota' }, { ...cols[4], text: 'Importe' },
    ], { bold: true, color: COLORS.primary }));
    y = header(y);
    if (!lines.length) {
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted).text('No hubo movimientos en este periodo.', MARGIN, y);
      y += 16;
    }
    for (const line of lines) {
      if (y > doc.page.height - MARGIN - 40) { doc.addPage(); y = header(MARGIN); }
      y = row(doc, y, [
        { ...cols[0], text: fmtDateTime(line.created_at).replace(' UTC', '') },
        { ...cols[1], text: LINE_LABELS[line.entry_type] || line.entry_type },
        { ...cols[2], text: lineReference(line) },
        { ...cols[3], text: (line.note || '').slice(0, 140) },
        { ...cols[4], text: fmt(line.amount, line.currency || cur) },
      ]);
    }

    doc.font('Helvetica').fontSize(7).fillColor(COLORS.muted)
      .text(`${statement.entry_count} movimientos · Fechas en UTC · Generado por ${product.displayName}`, MARGIN, doc.page.height - MARGIN - 10, { width, align: 'center' });
    doc.end();
  });

  return { buffer, filename: `estado-de-cuenta-${statement.id}-${statement.period_start}-${statement.period_end}.pdf` };
}

module.exports = { generate, TYPE_LABELS, LINE_LABELS };
