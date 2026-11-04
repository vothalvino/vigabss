// =============================================================================
// VigaBSS — E2E persona seed (FE-06)
// =============================================================================
// Runs after seed.js in the e2e job. The demo data had one organization and
// one user who was an admin AND the install operator, so every permission
// check was skipped and the UI was only ever exercised with full rights. This
// adds what the persona flows need:
//   - billing@ and readonly@demo-isp.com: ordinary users of the demo org in
//     the built-in billing and readonly groups;
//   - portal access for John Doe (client 1) and an issued invoice to show;
//   - 120 more clients, so lists run past one page of 100;
//   - a second organization with its own admin and a client the demo org
//     must never see.
// Passwords come from E2E_PERSONA_PASSWORD / E2E_PORTAL_PASSWORD. Development
// and tests only; refuses NODE_ENV=production. Safe to re-run.
// =============================================================================

require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const logger = require('../utils/logger').child({ script: 'seed-e2e' });
const { DEMO_ORGANIZATION_ID } = require('./seed');

const OTHER_ORGANIZATION_ID = 200;

async function groupId(conn, name) {
  const [[row]] = await conn.query('SELECT id FROM roles WHERE name = ? AND is_system = 1 AND deleted_at IS NULL LIMIT 1', [name]);
  if (!row) throw new Error(`system role ${name} is missing`);
  return row.id;
}

async function user(conn, { email, firstName, role, org, hash }) {
  await conn.query(
    `INSERT IGNORE INTO users (first_name, last_name, email, password_hash, role, group_id, organization_id, status)
     VALUES (?, 'E2E', ?, ?, ?, ?, ?, 'active')`,
    [firstName, email, hash, role, await groupId(conn, role), org],
  );
  const [[row]] = await conn.query('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL', [email]);
  await conn.query('INSERT IGNORE INTO organization_users (organization_id, user_id, role) VALUES (?, ?, ?)', [org, row.id, role]);
}

async function seedE2e() {
  if (process.env.NODE_ENV === 'production') throw new Error('seed-e2e.js refuses NODE_ENV=production');
  const personaPassword = process.env.E2E_PERSONA_PASSWORD;
  const portalPassword = process.env.E2E_PORTAL_PASSWORD;
  if (!personaPassword || !portalPassword) throw new Error('set E2E_PERSONA_PASSWORD and E2E_PORTAL_PASSWORD');
  const personaHash = await bcrypt.hash(personaPassword, 10);
  const conn = await db.getConnection();
  try {
    logger.info('Seeding personas...');
    await user(conn, { email: 'billing@demo-isp.com', firstName: 'Billing', role: 'billing', org: DEMO_ORGANIZATION_ID, hash: personaHash });
    await user(conn, { email: 'readonly@demo-isp.com', firstName: 'Readonly', role: 'readonly', org: DEMO_ORGANIZATION_ID, hash: personaHash });

    logger.info('Seeding portal access...');
    await conn.query(
      'UPDATE clients SET portal_password_hash = ? WHERE id = 1 AND organization_id = ?',
      [await bcrypt.hash(portalPassword, 10), DEMO_ORGANIZATION_ID],
    );
    await conn.query(
      `INSERT IGNORE INTO invoices (organization_id, client_id, contract_id, invoice_number, subtotal, tax_amount, total,
         currency, tax_rate, due_date, issue_date, status)
       VALUES (?, 1, 1, 'INV-E2E-0001', '100.00', '0.00', '100.00', 'MXN', 0, '2026-12-31', '2026-11-01', 'issued')`,
      [DEMO_ORGANIZATION_ID],
    );

    logger.info('Seeding 120 more clients...');
    const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM clients WHERE organization_id = ? AND name LIKE 'Bulk Client %'", [DEMO_ORGANIZATION_ID]);
    for (let i = Number(n) + 1; i <= 120; i++) {
      await conn.query(
        "INSERT INTO clients (organization_id, name, email, client_type, status, country) VALUES (?, ?, ?, 'personal', 'active', 'US')",
        [DEMO_ORGANIZATION_ID, `Bulk Client ${String(i).padStart(3, '0')}`, `bulk${i}@e2e.test`],
      );
    }

    logger.info('Seeding a second organization...');
    await conn.query(
      "INSERT IGNORE INTO organizations (id, name, locale, country, status) VALUES (?, 'Other ISP', 'global', 'US', 'active')",
      [OTHER_ORGANIZATION_ID],
    );
    await user(conn, { email: 'admin@other-isp.com', firstName: 'Other', role: 'admin', org: OTHER_ORGANIZATION_ID, hash: personaHash });
    const [[other]] = await conn.query("SELECT id FROM clients WHERE organization_id = ? AND name = 'Other Org Client'", [OTHER_ORGANIZATION_ID]);
    if (!other) {
      await conn.query(
        "INSERT INTO clients (organization_id, name, email, client_type, status, country) VALUES (?, 'Other Org Client', 'other@e2e.test', 'personal', 'active', 'US')",
        [OTHER_ORGANIZATION_ID],
      );
    }
    logger.info('E2E personas ready.');
  } finally {
    conn.release();
    await db.close();
  }
}

if (require.main === module) {
  seedE2e()
    .then(() => process.exit(0))
    .catch((err) => { logger.error({ err }, 'E2E seed failed'); process.exit(1); });
}

module.exports = { seedE2e, OTHER_ORGANIZATION_ID };
