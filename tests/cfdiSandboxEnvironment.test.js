// =============================================================================
// BIL-35 — a stamped CFDI records the PAC environment that stamped it; the
// PDF of a sandbox CFDI is watermarked
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('the stamp write saves the stamping PAC environment', () => {
  const src = read('src/services/cfdiService.js');
  expect(src).toMatch(/pac_provider = \?, pac_environment = \?,/);
  expect(src).toMatch(/stampedProvider\?\.environment === 'production' \? 'production' : 'sandbox'/);
});

test('schema.sql and migration 500 add cfdi_documents.pac_environment', () => {
  const schema = read('database/schema.sql');
  const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS cfdi_documents'));
  expect(table.slice(0, table.indexOf(') ENGINE'))).toMatch(/pac_environment\s+ENUM\('sandbox', 'production'\) NULL/);
  expect(read('database/migrations/500_cfdi_pac_environment.sql')).toMatch(/ADD COLUMN pac_environment ENUM\('sandbox', 'production'\)/);
  expect(fs.existsSync(path.join(root, 'database/rollbacks/500_cfdi_pac_environment.sql'))).toBe(true);
});

describe('representación impresa', () => {
  const { renderRepresentacionImpresa } = require('../src/services/cfdiRepresentacionPdf');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Serie="A" Folio="1" Fecha="2026-10-01T10:00:00" SubTotal="100.00" Total="116.00" Moneda="MXN" TipoDeComprobante="I" MetodoPago="PUE" FormaPago="03" LugarExpedicion="64000" Exportacion="01" NoCertificado="30001000000500003416" Sello="abc">
  <cfdi:Emisor Rfc="EKU9003173C9" Nombre="ESCUELA KEMPER URGATE" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="XAXX010101000" Nombre="PUBLICO EN GENERAL" DomicilioFiscalReceptor="64000" RegimenFiscalReceptor="616" UsoCFDI="S01"/>
  <cfdi:Conceptos><cfdi:Concepto ClaveProdServ="81112100" Cantidad="1" ClaveUnidad="E48" Descripcion="Internet" ValorUnitario="100.00" Importe="100.00" ObjetoImp="02"/></cfdi:Conceptos>
  <cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="11111111-2222-3333-4444-555555555555" FechaTimbrado="2026-10-01T10:00:05" RfcProvCertif="SPR190613I52" SelloCFD="abc" NoCertificadoSAT="30001000000500003456" SelloSAT="def"/></cfdi:Complemento>
</cfdi:Comprobante>`;

  test('a sandbox CFDI gets the not-fiscally-valid watermark', async () => {
    const plain = await renderRepresentacionImpresa({ xml });
    const sandbox = await renderRepresentacionImpresa({ xml, sandbox: true });
    // pdfkit writes text as hex glyph runs; the watermark adds content.
    expect(sandbox.length).toBeGreaterThan(plain.length);
  });
});

test('the PDF paths pass sandbox for a sandbox or SIMULADO CFDI', () => {
  const src = read('src/services/pdfService.js');
  expect(src.match(/sandbox: isSandboxCfdi\(/g)).toHaveLength(2);
  expect(src).toMatch(/pac_environment === 'sandbox' \|\| String\(cfdi\?\.uuid \|\| ''\)\.startsWith\('SIMULADO-'\)/);
});
