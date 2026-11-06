'use strict';

// =============================================================================
// A signed legal document (activation contract, service acknowledgment,
// installation authorization) as a PDF
// =============================================================================
// The frozen contract text exactly as it was signed (rendered_body, which
// already carries the test-environment watermark for a sandbox document), then
// the evidence: who signed, when, the captured signature, the registered
// contract it came from, and whether the stored evidence still verifies.
// Staff download it from the contract or work order; the subscriber downloads
// their own copy from the portal.
// =============================================================================

const PDFDocument = require('pdfkit');
const db = require('../config/database');
const { NotFoundError } = require('../utils/errors');
const legalDocumentService = require('./legalDocumentService');

const MARGIN = 50;
const COLORS = { primary: '#1a5276', text: '#2c3e50', muted: '#7f8c8d', ok: '#27ae60', bad: '#c0392b', quote: '#f4f6f6' };

const LABELS = {
  en: {
    signature: 'SIGNATURE', signedBy: 'Signed by', signedAt: 'Signed at', signedFrom: 'Signed from (IP)',
    client: 'Customer', document: 'Document', registration: 'Registered contract', registeredAt: 'registered',
    version: 'version', environment: 'Environment', sandbox: 'Test (no legal effect)', production: 'Production',
    evidence: 'Evidence integrity', verified: 'Verified: the text and signature are unchanged since signing',
    notVerified: 'NOT verified: the stored evidence does not match', noEvidence: 'Not available for this document',
    textHash: 'SHA-256 of the signed text', generated: 'Copy generated',
  },
  es: {
    signature: 'FIRMA', signedBy: 'Firmado por', signedAt: 'Fecha de firma', signedFrom: 'Firmado desde (IP)',
    client: 'Cliente', document: 'Documento', registration: 'Contrato registrado', registeredAt: 'registrado el',
    version: 'versión', environment: 'Entorno', sandbox: 'Prueba (sin efectos legales)', production: 'Producción',
    evidence: 'Integridad de la evidencia', verified: 'Verificada: el texto y la firma no han cambiado desde la firma',
    notVerified: 'NO verificada: la evidencia almacenada no coincide', noEvidence: 'No disponible para este documento',
    textHash: 'SHA-256 del texto firmado', generated: 'Copia generada',
  },
};

function fmtDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Text with **bold** runs, written as one flowing paragraph. */
function writeInline(doc, text, { font = 'Helvetica', bold = 'Helvetica-Bold', size = 10, color = COLORS.text } = {}) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  doc.fontSize(size).fillColor(color);
  parts.forEach((part, index) => {
    const isBold = part.startsWith('**') && part.endsWith('**');
    doc.font(isBold ? bold : font).text(isBold ? part.slice(2, -2) : part, { continued: index < parts.length - 1 });
  });
  if (!parts.length) doc.text('');
}

/** The small Markdown subset templates use: headings, quotes, lists, paragraphs. */
function writeMarkdown(doc, markdown) {
  const blocks = String(markdown || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (!lines.length) continue;
    const heading = /^(#{1,3})\s+(.*)$/.exec(lines[0]);
    if (heading && lines.length === 1) {
      const size = { 1: 15, 2: 13, 3: 11 }[heading[1].length];
      doc.moveDown(0.4).font('Helvetica-Bold').fontSize(size).fillColor(COLORS.primary).text(heading[2].replace(/\*\*/g, ''));
      doc.moveDown(0.3);
      continue;
    }
    if (lines.every((line) => line.startsWith('>'))) {
      const text = lines.map((line) => line.replace(/^>\s?/, '')).join(' ').replace(/\s+/g, ' ').trim();
      const top = doc.y;
      doc.x = MARGIN + 10;
      writeInline(doc, text, { size: 9 });
      doc.rect(MARGIN, top - 4, 3, doc.y - top + 6).fill(COLORS.primary);
      doc.x = MARGIN;
      doc.moveDown(0.6);
      continue;
    }
    if (lines.every((line) => /^\s*([-*]|\d+\.)\s+/.test(line))) {
      for (const line of lines) {
        const match = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
        writeInline(doc, `${match[1] === '-' || match[1] === '*' ? '•' : match[1]} ${match[2]}`);
      }
      doc.moveDown(0.5);
      continue;
    }
    writeInline(doc, lines.join(' ').replace(/\s+/g, ' ').trim());
    doc.moveDown(0.5);
  }
}

function row(doc, label, value) {
  doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.muted).text(`${label}: `, { continued: true });
  doc.font('Helvetica').fillColor(COLORS.text).text(value);
}

/**
 * Load one signed document for a PDF, scoped to the organization and, for the
 * portal, to the subscriber. Only a signed document has a copy to give.
 */
async function loadSignedDocument(documentId, { orgId, clientId = null }) {
  const params = [documentId, orgId];
  let clientCond = '';
  if (clientId !== null && clientId !== undefined) {
    clientCond = ' AND d.client_id = ?';
    params.push(clientId);
  }
  const [rows] = await db.query(
    `SELECT d.*, c.name AS client_name, o.locale AS org_locale
       FROM signed_documents d
       LEFT JOIN clients c ON c.id = d.client_id AND c.organization_id <=> d.organization_id AND c.deleted_at IS NULL
       LEFT JOIN organizations o ON o.id = d.organization_id AND o.deleted_at IS NULL
      WHERE d.id = ? AND d.organization_id <=> ?${clientCond}
        AND d.status = 'signed' AND d.deleted_at IS NULL`,
    params,
  );
  if (!rows[0]) throw new NotFoundError('Document');
  return rows[0];
}

/**
 * @param {number|string} documentId
 * @param {{ orgId: number|null, clientId?: number|null, includeSignerIp?: boolean }} options
 *   clientId limits the lookup to that subscriber's documents (portal).
 *   includeSignerIp adds the signing IP, which only staff copies show.
 * @returns {Promise<{ buffer: Buffer, filename: string }>}
 */
async function generateSignedDocumentPdf(documentId, { orgId, clientId = null, includeSignerIp = false } = {}) {
  const document = await loadSignedDocument(documentId, { orgId, clientId });
  const L = document.org_locale === 'MX' ? LABELS.es : LABELS.en;
  const evidence = legalDocumentService.verifyEvidence(document);
  const signature = legalDocumentService.signatureImageBytes(document.signature_image);

  const buffer = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: MARGIN, info: { Title: document.title || '' } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(18).fillColor(COLORS.primary).text(document.title || L.document);
    doc.moveDown(0.3);
    row(doc, L.client, document.client_name || `#${document.client_id}`);
    row(doc, L.document, `#${document.id}`);
    doc.moveDown(0.8);

    writeMarkdown(doc, document.rendered_body);

    if (doc.y > doc.page.height - 260) doc.addPage();
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(12).fillColor(COLORS.primary).text(L.signature);
    doc.moveDown(0.3);
    if (signature) {
      doc.image(signature, { fit: [260, 90] });
      doc.moveDown(0.3);
    }
    row(doc, L.signedBy, document.signer_name || '—');
    row(doc, L.signedAt, fmtDateTime(document.signed_at));
    if (includeSignerIp && document.signed_ip) row(doc, L.signedFrom, document.signed_ip);
    if (document.mx_contract_environment) {
      row(doc, L.environment, document.mx_contract_environment === 'sandbox' ? L.sandbox : L.production);
    }
    if (document.mx_registration_number) {
      const registered = document.mx_registered_at ? ` (${L.registeredAt} ${String(document.mx_registered_at).slice(0, 10)})` : '';
      const version = document.mx_template_version ? `, ${L.version} ${document.mx_template_version}` : '';
      row(doc, L.registration, `${document.mx_registration_number}${registered}${version}`);
    }
    doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.muted).text(`${L.evidence}: `, { continued: true });
    doc.font('Helvetica').fillColor(evidence === true ? COLORS.ok : evidence === false ? COLORS.bad : COLORS.muted)
      .text(evidence === true ? L.verified : evidence === false ? L.notVerified : L.noEvidence);
    if (document.content_sha256) row(doc, L.textHash, document.content_sha256);
    row(doc, L.generated, fmtDateTime(new Date()));
    doc.end();
  });

  const safeTitle = String(document.title || 'document').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';
  return { buffer, filename: `${safeTitle}-${document.id}.pdf` };
}

module.exports = { generateSignedDocumentPdf, writeMarkdown };
