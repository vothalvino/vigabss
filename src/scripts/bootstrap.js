// =============================================================================
// VigaBSS 5.0 — Production bootstrap
// =============================================================================
// Creates what a fresh production install needs and nothing else: the
// operator's organization and its first administrator, who is also the
// install operator. install.sh used to run seed.js here, which created a
// "Demo ISP" tenant with admin@demo-isp.com, sample clients with real-looking
// addresses, five active contracts dated 2025 that the daily invoicing task
// then back-billed, and an ACTIVE NAS at 10.0.0.1 with the shared secret
// 'testing123' (OPS-03). Demo data stays in seed.js, for development only.
//
// Environment:
//   ADMIN_EMAIL     required — the administrator's login (install.sh: $EMAIL)
//   ADMIN_PASSWORD  initial password; a random one is generated and logged
//                   once when unset. Only the bcrypt hash is stored.
//   ORG_NAME        organization name (default "My ISP")
//   ORG_COUNTRY     ISO 3166-1 alpha-2 country code (optional; "MX" turns on
//                   the Mexican SAT/IFT compliance surface)
//
// Idempotent: an install that already has an administrator is left alone.
//
// Usage:  node src/scripts/bootstrap.js
// =============================================================================

require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const Organization = require('../models/Organization');
const logger = require('../utils/logger').child({ script: 'bootstrap' });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CURRENCY_BY_COUNTRY = { MX: 'MXN', US: 'USD', CO: 'COP', GT: 'GTQ', CR: 'CRC', PE: 'PEN', CL: 'CLP', AR: 'ARS', BR: 'BRL', ES: 'EUR' };

function readOptions(env = process.env) {
  const email = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!EMAIL.test(email)) {
    throw new Error('ADMIN_EMAIL must be set to the administrator\'s email address');
  }
  const country = String(env.ORG_COUNTRY || '').trim().toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) {
    throw new Error('ORG_COUNTRY must be a two-letter ISO country code (e.g. MX, US)');
  }
  const name = String(env.ORG_NAME || '').trim() || 'My ISP';
  return { email, country: country || null, name: name.slice(0, 255) };
}

async function bootstrap(env = process.env) {
  const { email, country, name } = readOptions(env);

  const [admins] = await db.query("SELECT id, email FROM users WHERE role = 'admin' AND deleted_at IS NULL LIMIT 1");
  if (admins.length) {
    logger.info({ userId: admins[0].id }, 'An administrator already exists; nothing to bootstrap');
    return { created: false, userId: admins[0].id };
  }

  const [orgs] = await db.query('SELECT id FROM organizations WHERE deleted_at IS NULL ORDER BY id LIMIT 1');
  let organizationId = orgs[0]?.id;
  if (!organizationId) {
    const org = await Organization.create({
      name,
      country,
      locale: country === 'MX' ? 'MX' : 'global',
      ...(CURRENCY_BY_COUNTRY[country] ? { currency: CURRENCY_BY_COUNTRY[country] } : {}),
      status: 'active',
    });
    organizationId = org.id;
    logger.info({ organizationId, name, country }, 'Organization created');
  }

  let password = env.ADMIN_PASSWORD;
  if (!password) {
    password = `${crypto.randomBytes(15).toString('base64')}A9!`;
    logger.warn(`ADMIN_PASSWORD not set — generated a random administrator password: ${password}`);
  }
  const passwordHash = await bcrypt.hash(password, 12);

  // is_install_operator: this account runs the box (migration 444). It is not
  // a tenant role and cannot be granted through the API, so a fresh install
  // has to be given it here.
  const [result] = await db.query(
    // must_change_password: the initial password was printed on the console,
    // so it is replaced at first login (migration 479).
    `INSERT INTO users (first_name, last_name, email, password_hash, role, group_id, organization_id, status, is_install_operator, must_change_password)
     VALUES ('Admin', 'User', ?, ?, 'admin',
             (SELECT id FROM roles WHERE name = 'admin' AND deleted_at IS NULL LIMIT 1), ?, 'active', 1, 1)`,
    [email, passwordHash, organizationId],
  );
  const userId = result.insertId;
  await db.query(
    "INSERT IGNORE INTO organization_users (organization_id, user_id, role) VALUES (?, ?, 'owner')",
    [organizationId, userId],
  );
  logger.info({ userId, email, organizationId }, 'Administrator created');
  return { created: true, userId, organizationId };
}

if (require.main === module) {
  bootstrap()
    .then(() => db.close())
    .then(() => process.exit(0))
    .catch(async (err) => {
      logger.error({ err: err.message }, 'Bootstrap failed');
      await db.close().catch(() => {});
      process.exit(1);
    });
}

module.exports = { bootstrap, readOptions };
