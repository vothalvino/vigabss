'use strict';
// =============================================================================
// A CFDI without a client — against a real database
// =============================================================================
// The General Public invoice (factura global) is addressed to no client, so
// its cfdi_documents row has client_id NULL. A trigger that required every
// document's client to be Mexican refused it: the document could never be
// saved, and every unit test mocked the database. Only MySQL shows the
// trigger, so this inserts the row the way facturaPublicaService does.
//
// Runs only in CI's db-integration job (DB_INTEGRATION=1).
// =============================================================================

const { describeDb, relaxLimits, createOrgAdmin, teardown } = require('./realDb');

const MX_ORG = 9801; // 9101-9102 sweep, 92xx money, 9301 RBAC matrix, 9401 IPv6, 95xx menus, 9601 billing ahead, 97xx tie-out
const GLOBAL_ORG = 9802;

describeDb('a CFDI without a client against a real database', () => {
  let db;

  const insertGlobal = (org, clientId = null) => db.query(
    `INSERT INTO cfdi_documents
       (organization_id, client_id, invoice_id, tipo_comprobante, serie, folio,
        uso_cfdi, metodo_pago, forma_pago, moneda, exportacion,
        receptor_rfc, receptor_nombre, receptor_regimen, receptor_cp,
        global_periodicidad, global_meses, global_anio,
        subtotal, total_impuestos, total, sat_status)
     VALUES (?, ?, NULL, 'I', 'A', ?, 'S01', 'PUE', '01', 'MXN', '01',
             'XAXX010101000', 'PUBLICO EN GENERAL', '616', '06700', '04', '11', 2026, 100.00, 16.00, 116.00, 'draft')`,
    [org, clientId, Math.floor(Math.random() * 1e9)],
  );

  beforeAll(async () => {
    relaxLimits();
    db = require('../../../src/config/database');
    await createOrgAdmin(db, MX_ORG, 'GLOBALMX');
    await createOrgAdmin(db, GLOBAL_ORG, 'GLOBALXX');
    await db.query("UPDATE organizations SET locale = 'MX', country = 'MX' WHERE id = ?", [MX_ORG]);
  }, 120000);

  afterAll(teardown);

  test('a Mexican organization can store a document with no client', async () => {
    const [result] = await insertGlobal(MX_ORG);
    expect(result.insertId).toBeGreaterThan(0);
    const [[row]] = await db.query('SELECT client_id, receptor_rfc FROM cfdi_documents WHERE id = ?', [result.insertId]);
    expect(row).toEqual({ client_id: null, receptor_rfc: 'XAXX010101000' });
    // It can be updated (stamped) while it still has no client.
    await expect(db.query("UPDATE cfdi_documents SET sat_status = 'vigente' WHERE id = ?", [result.insertId])).resolves.toBeDefined();
  });

  test('an organization that is not Mexican cannot', async () => {
    await expect(insertGlobal(GLOBAL_ORG)).rejects.toMatchObject({ sqlState: '45000' });
  });

  test('a document with a client still needs that client to be Mexican', async () => {
    const [mx] = await db.query("INSERT INTO clients (organization_id, name, status, locale) VALUES (?, 'MX Client', 'active', 'MX')", [MX_ORG]);
    const [other] = await db.query("INSERT INTO clients (organization_id, name, status, locale) VALUES (?, 'Other Client', 'active', 'global')", [MX_ORG]);
    await expect(insertGlobal(MX_ORG, mx.insertId)).resolves.toBeDefined();
    await expect(insertGlobal(MX_ORG, other.insertId)).rejects.toMatchObject({ sqlState: '45000' });
    // Moving a clientless document onto a client that is not Mexican is refused too.
    const [doc] = await insertGlobal(MX_ORG);
    await expect(db.query('UPDATE cfdi_documents SET client_id = ? WHERE id = ?', [other.insertId, doc.insertId])).rejects.toMatchObject({ sqlState: '45000' });
  });
});
