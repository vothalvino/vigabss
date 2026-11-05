'use strict';
// =============================================================================
// Real-database harness (TNA-37 / OPS-20)
// =============================================================================
// Every other Jest suite mocks src/config/database, so nothing ran the app's
// SQL against MySQL with two tenants in it. These suites run only when
// DB_INTEGRATION=1 and DB_* point at a migrated, disposable database (CI's
// db-integration job). They write freely: never point them at real data.
//
// seedTwoOrgs() puts one row per organization into every table it can fill,
// in foreign-key order, reading the structure from information_schema rather
// than a hand-kept list, so a new table is covered without editing this file.
// Text columns carry the organization's marker (ZQXA… / ZQXB…): if a response
// to organization A contains "ZQXB", B's data leaked.
// =============================================================================

const ENABLED = process.env.DB_INTEGRATION === '1';
// The organizations' compliance locale for the sweep. CI runs it once each
// way: MX reaches the Mexican tables and routes, global the global paths of
// routes that branch on locale.
const SWEEP_LOCALE = process.env.DB_SWEEP_LOCALE === 'global' ? 'global' : 'MX';
const describeDb = ENABLED ? describe : describe.skip;

const ORG_A = 9101;
const ORG_B = 9102;
const MARK = { [ORG_A]: 'ZQXA', [ORG_B]: 'ZQXB' };
const LEAK_RE = /zqxb/i;

// Rate limits sized for a human would turn the route sweep into 429s.
function relaxLimits() {
  for (const key of ['RATE_LIMIT_API', 'RATE_LIMIT_TENANT_API', 'RATE_LIMIT_TENANT_PRINCIPAL_API',
    'RATE_LIMIT_EXPORT', 'RATE_LIMIT_SSE', 'RATE_LIMIT_UPLOAD', 'RATE_LIMIT_PUBLIC', 'RATE_LIMIT_SESSION']) {
    process.env[key] = '1000000';
  }
}

// Tables the generic seeder leaves alone: the tenants themselves, the
// identities the harness creates by hand, and bookkeeping.
// bookkeeping, and rows that would restrict the signed-in admin themselves
// (an IP allowlist, a reseller binding) and so empty the sweep.
const SKIP_TABLES = new Set([
  'organizations', 'users', 'organization_users', 'roles', 'permissions', 'role_permissions',
  'schema_migrations', 'migrations', 'admin_ip_allowlist', 'reseller_user_bindings',
]);

const quote = name => `\`${String(name).replace(/`/g, '``')}\``;

async function loadStructure(db) {
  const [columns] = await db.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS dt, COLUMN_TYPE AS ct, IS_NULLABLE AS nullable,
            COLUMN_DEFAULT AS dflt, EXTRA AS extra, CHARACTER_MAXIMUM_LENGTH AS len, SRS_ID AS srid
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  );
  const [fks] = await db.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, REFERENCED_TABLE_NAME AS rt, REFERENCED_COLUMN_NAME AS rc
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
  );
  const [baseTables] = await db.query(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`,
  );
  const tables = new Map(baseTables.map(r => [r.t, { name: r.t, columns: [], fks: new Map() }]));
  for (const col of columns) tables.get(col.t)?.columns.push(col);
  for (const fk of fks) {
    const table = tables.get(fk.t);
    if (table && fk.c !== 'organization_id') table.fks.set(fk.c, { table: fk.rt, column: fk.rc });
  }
  return tables;
}

const isGenerated = col => /GENERATED|auto_increment/i.test(col.extra || '');
const required = col => col.nullable === 'NO' && col.dflt === null && !isGenerated(col);
const TEXT_TYPES = new Set(['varchar', 'char', 'text', 'tinytext', 'mediumtext', 'longtext']);

// Geometry goes through ST_GeomFromText; insertRow expands { sql, value }.
const GEOMETRY_WKT = {
  point: 'POINT(1 1)',
  linestring: 'LINESTRING(0 0, 1 1)',
  polygon: 'POLYGON((0 0, 0 1, 1 1, 1 0, 0 0))',
  geometry: 'POLYGON((0 0, 0 1, 1 1, 1 0, 0 0))',
  multipolygon: 'MULTIPOLYGON(((0 0, 0 1, 1 1, 1 0, 0 0)))',
};

// Values the generic rules get wrong because a CHECK constraint needs them.
// SKIP leaves a nullable column out of the full row.
const SKIP = Symbol('skip');
const COLUMN_VALUES = {
  'cgnat_attribution_bindings.protocol': () => 6,
  'factura_publica_invoices.meses': () => '01',
  // Exactly one case: the DSAR, not the government request.
  'preservation_holds.gov_data_request_id': () => SKIP,
  // At most one source document per CFDI: the invoice.
  'cfdi_documents.credit_note_id': () => SKIP,
  'cfdi_documents.payment_id': () => SKIP,
  // A first revision without a concession title or an approver.
  'snii_report_batches.revision_no': () => 1,
  'snii_report_batches.filing_year': () => 2026,
  'snii_report_batches.concession_title_id': () => SKIP,
  'snii_report_batches.supersession_reason': () => SKIP,
  'snii_report_batches.approved_by': () => SKIP,
  // A manual asset carries its payload instead of a source row.
  'snii_asset_registry.source_type': () => 'manual',
  'snii_asset_registry.manual_payload': () => '{}',
  // target_type 'email': the address and nothing else.
  'snmp_trap_forwarding_deliveries.target_type': () => 'email',
  'snmp_trap_forwarding_deliveries.target_url': () => SKIP,
  'snmp_trap_forwarding_deliveries.webhook_id': () => SKIP,
  // A link joins two devices; the second is the organization's spare.
  'network_links.device_b_id': (org, spares) => spares.get('devices')?.[org],
  // A factura global takes only paid invoices: the spare invoice is paid.
  'factura_publica_invoice_items.invoice_id': (org, spares) => spares.get('invoices')?.[org],
};

// Tables that get a second row per organization, for a row that needs two
// or a row in another state: { table: { column: value } } on the spare.
const SPARE_TABLES = { devices: {}, invoices: { status: 'paid' } };

function scalarFor(col, mark, table, org) {
  const dt = col.dt.toLowerCase();
  if (GEOMETRY_WKT[dt]) return { sql: `ST_GeomFromText(?, ${Number(col.srid) || 0})`, value: GEOMETRY_WKT[dt] };
  // An end after its start satisfies CHECK (end >= start) and (end > start).
  const later = /(end|expir|until|due|_to$|finish|clos)/.test(col.c);
  if (TEXT_TYPES.has(dt)) {
    if (/email/.test(col.c)) return `${mark.toLowerCase()}.${table}@example.com`.slice(0, col.len || 255);
    return `${mark}-${table}.${col.c}`.slice(0, Math.max(1, Number(col.len) || 255));
  }
  if (dt === 'enum' || dt === 'set') return col.ct.match(/'((?:[^']|'')*)'/)[1].replace(/''/g, "'");
  if (dt === 'json') return '{}';
  if (dt === 'tinyint' && /tinyint\(1\)/.test(col.ct)) return 1;
  // Distinct per organization, for an install-wide UNIQUE on a number.
  if (['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'decimal', 'float', 'double'].includes(dt)) return org === ORG_A ? 1 : 2;
  if (dt === 'bit') return 0;
  if (dt === 'date') return later ? '2026-12-31' : '2026-01-15';
  if (dt === 'datetime' || dt === 'timestamp') return later ? '2026-12-31 00:00:00' : '2026-01-15 00:00:00';
  if (dt === 'time') return '01:00:00';
  if (dt === 'year') return 2026;
  if (['binary', 'varbinary', 'blob', 'tinyblob', 'mediumblob', 'longblob'].includes(dt)) {
    return Buffer.alloc(Math.min(16, Number(col.len) || 16), 1);
  }
  return undefined; // geometry and friends: the table is skipped if required
}

// A row for `org` in `table`, or null when a required value is unavailable.
// full: also fill nullable text with the marker and nullable FKs when the
// parent row exists, so the row is as visible as possible.
function buildRow(table, org, seeded, globals, full, spares = new Map()) {
  const row = {};
  for (const col of table.columns) {
    if (isGenerated(col) || col.c === 'deleted_at') continue;
    if (col.c === 'organization_id') { row.organization_id = org; continue; }
    const override = COLUMN_VALUES[`${table.name}.${col.c}`];
    if (override) {
      const value = override(org, spares);
      if (value === SKIP) continue;
      if (value === undefined) return null;
      row[col.c] = value;
      continue;
    }
    const fk = table.fks.get(col.c);
    if (fk) {
      const parent = fk.table === 'organizations' ? org : (seeded.get(fk.table)?.[org]?.[fk.column] ?? globals.get(`${fk.table}.${fk.column}`));
      if (parent !== undefined && parent !== null && (full || required(col))) row[col.c] = parent;
      else if (required(col)) return null;
      continue;
    }
    if (required(col) || (full && col.nullable === 'YES' && TEXT_TYPES.has(col.dt) && (Number(col.len) || 1000) >= 12)) {
      const value = scalarFor(col, MARK[org], table.name, org);
      if (value === undefined) { if (required(col)) return null; continue; }
      row[col.c] = value;
    }
  }
  return row;
}

// The org a table's row belongs to: its organization_id, or a required FK to
// a table already seeded for that org (invoice_items via invoices, …).
function ownedBy(table, seeded) {
  if (table.columns.some(c => c.c === 'organization_id')) return true;
  return [...table.fks.entries()].some(([column, fk]) => {
    const col = table.columns.find(c => c.c === column);
    return col && col.nullable === 'NO' && seeded.has(fk.table);
  });
}

async function readGlobals(db, tables) {
  // A required FK to an install-wide table (SAT catalogs, permissions, …)
  // takes any existing row.
  const globals = new Map();
  const wanted = new Set();
  for (const table of tables.values()) {
    for (const fk of table.fks.values()) {
      const target = tables.get(fk.table);
      if (target && !target.columns.some(c => c.c === 'organization_id')) wanted.add(`${fk.table}.${fk.column}`);
    }
  }
  for (const key of wanted) {
    const [t, c] = key.split('.');
    const [[row]] = await db.query(`SELECT ${quote(c)} AS v FROM ${quote(t)} LIMIT 1`).catch(() => [[]]);
    if (row) globals.set(key, row.v);
  }
  return globals;
}

async function insertRow(conn, tableName, row) {
  const cols = Object.keys(row);
  const raw = v => v && typeof v === 'object' && !Buffer.isBuffer(v) && v.sql;
  const [result] = await conn.query(
    `INSERT INTO ${quote(tableName)} (${cols.map(quote).join(', ')}) VALUES (${cols.map(c => raw(row[c]) || '?').join(', ')})`,
    cols.map(c => (raw(row[c]) ? row[c].value : row[c])),
  );
  return result.insertId;
}

// prior: the { seeded, spares } of an earlier pass, whose tables are kept.
async function seedGeneric(db, tables, users, prior = null) {
  const globals = await readGlobals(db, tables);
  // table -> { [org]: { [column]: value } }; the admins stand in for users.
  const seeded = prior?.seeded || new Map([['users', { [ORG_A]: { id: users[ORG_A] }, [ORG_B]: { id: users[ORG_B] } }]]);
  const spares = prior?.spares || new Map(); // table -> { [org]: id } of a second row
  const skipped = new Map(); // table -> reason
  const pending = [...tables.values()].filter(t => !SKIP_TABLES.has(t.name));
  const conn = await db.getConnection();
  try {
    // Repeated passes in place of a topological sort: a table is tried once
    // every required parent it has is seeded, and passes stop when one adds
    // nothing.
    let progress = true;
    while (progress) {
      progress = false;
      for (const table of pending.filter(t => !seeded.has(t.name) && !skipped.has(t.name))) {
        const waiting = [...table.fks.entries()].some(([column, fk]) => {
          const col = table.columns.find(c => c.c === column);
          return col && required(col) && fk.table !== table.name && fk.table !== 'organizations'
            && !seeded.has(fk.table) && !skipped.has(fk.table) && !globals.has(`${fk.table}.${fk.column}`);
        });
        if (waiting || !ownedBy(table, seeded)) continue;
        const ids = {};
        let error = null;
        for (const org of [ORG_A, ORG_B]) {
          let id = null;
          for (const full of [true, false]) {
            const row = buildRow(table, org, seeded, globals, full, spares);
            if (!row) { error = 'a required value has no source'; break; }
            try {
              id = await insertRow(conn, table.name, row);
              const keyCols = Object.fromEntries(table.columns.filter(c => c.c === 'id').map(() => ['id', id]));
              ids[org] = { ...row, ...keyCols };
              error = null;
              break;
            } catch (err) {
              // Both attempts' errors: the fallback's often only hides the first.
              const message = `${err.code || ''} ${err.sqlMessage || err.message}`.trim();
              error = full ? message : `${message} (full row: ${error})`;
            }
          }
          if (!ids[org]) break;
        }
        if (ids[ORG_A] && ids[ORG_B] && SPARE_TABLES[table.name]) {
          const spare = {};
          for (const org of [ORG_A, ORG_B]) {
            // The same row, its text and numbers moved off any UNIQUE key.
            const row = Object.fromEntries(Object.entries(ids[org]).filter(([c]) => c !== 'id').map(([c, v]) => {
              const col = table.columns.find(x => x.c === c);
              if (table.fks.has(c) || c === 'organization_id') return [c, v];
              if (typeof v === 'string' && TEXT_TYPES.has(col.dt)) return [c, `${v}-2`.slice(-(Number(col.len) || 255))];
              if (typeof v === 'number' && !/tinyint\(1\)/.test(col.ct)) return [c, v + 10];
              return [c, v];
            }));
            spare[org] = await insertRow(conn, table.name, { ...row, ...SPARE_TABLES[table.name] });
          }
          spares.set(table.name, spare);
        }
        if (ids[ORG_A] && ids[ORG_B]) {
          seeded.set(table.name, ids);
          progress = true;
        } else {
          skipped.set(table.name, error || 'not seeded');
        }
      }
    }
    for (const table of pending) {
      if (!seeded.has(table.name) && !skipped.has(table.name)) skipped.set(table.name, ownedBy(table, seeded) ? 'parent not seeded' : 'install-wide');
    }
  } finally {
    conn.release();
  }
  return { seeded, skipped, spares };
}

// An organization and an ordinary admin of it: a group with every
// permission, of the admin persona, but neither an install operator nor
// super_admin, so nothing bypasses the organization checks.
async function createOrgAdmin(db, org, mark = MARK[org] || `ORG${org}`) {
  const bcrypt = require('bcryptjs');
  await db.query("INSERT IGNORE INTO roles (name, description, kind, is_system) VALUES ('it_all_permissions', 'DB integration tests', 'admin', 0)");
  const [[role]] = await db.query("SELECT id FROM roles WHERE name = 'it_all_permissions' AND deleted_at IS NULL");
  await db.query('INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions', [role.id]);
  await db.query(
    // locale global: an MX organization's contracts need a classified
    // contract source and environment, which the generic seed cannot supply.
    "INSERT INTO organizations (id, name, locale, country, status, currency) VALUES (?, ?, 'global', 'US', 'active', 'MXN')",
    [org, `${mark} ISP`],
  );
  const [result] = await db.query(
    `INSERT INTO users (organization_id, first_name, last_name, email, password_hash, role, group_id, status)
     VALUES (?, ?, 'Admin', ?, ?, 'admin', ?, 'active')`,
    [org, mark, `admin-${org}@example.com`, await bcrypt.hash('integration-only-password', 4), role.id],
  );
  await db.query("INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, 'admin')", [org, result.insertId]);
  const { signStaffAccessToken } = require('../../../src/utils/accessTokens');
  return { userId: result.insertId, token: signStaffAccessToken({ sub: result.insertId, orgId: org, tv: 0 }) };
}

async function seedIdentities(db) {
  const users = {};
  for (const org of [ORG_A, ORG_B]) users[org] = (await createOrgAdmin(db, org)).userId;
  return users;
}

// files has no organization_id: a client's document is the file whose
// entity is that client, so the generic seed leaves it out.
async function seedClientFiles(db, seeded) {
  const ids = {};
  for (const org of [ORG_A, ORG_B]) {
    const clientId = seeded.get('clients')[org].id;
    const [result] = await db.query(
      `INSERT INTO files (entity_type, entity_id, category, file_name, file_path)
       VALUES ('client', ?, 'client_file', ?, ?)`,
      [clientId, `${MARK[org]}-document.pdf`, `clients/${clientId}/${MARK[org]}-document.pdf`],
    );
    ids[org] = { id: result.insertId, entity_id: clientId };
  }
  seeded.set('files', ids);
}

// Tables a global organization cannot hold: refused by a locale trigger, or
// unseeded and pointing at such a table.
function mxOnlyTables(tables, seeded, skipped) {
  const out = new Set([...skipped].filter(([, reason]) => /locale/i.test(reason)).map(([name]) => name));
  let grew = true;
  while (grew) {
    grew = false;
    for (const table of tables.values()) {
      if (seeded.has(table.name) || out.has(table.name)) continue;
      if ([...table.fks.values()].some(fk => out.has(fk.table))) { out.add(table.name); grew = true; }
    }
  }
  return out;
}

let state = null;

async function setup() {
  if (state) return state;
  relaxLimits();
  const db = require('../../../src/config/database');
  const users = await seedIdentities(db);
  const tables = await loadStructure(db);
  const first = await seedGeneric(db, tables, users);
  let pass = first;
  if (SWEEP_LOCALE === 'MX') {
    // The Mexican tables' triggers need an MX organization and client, and
    // an MX organization's contracts need fields the generic seed cannot
    // supply. So both organizations switch to MX once the first pass has
    // seeded contracts, and a second pass fills what the triggers refused.
    // A locale cannot go back from MX once MX rows exist.
    await db.query("UPDATE organizations SET locale = 'MX', country = 'MX' WHERE id IN (?, ?)", [ORG_A, ORG_B]);
    await db.query("UPDATE clients SET locale = 'MX' WHERE organization_id IN (?, ?)", [ORG_A, ORG_B]);
    pass = await seedGeneric(db, tables, users, first);
  }
  const { seeded, skipped, spares } = pass;
  // As MX every table should seed, so nothing is excused.
  const mxOnly = SWEEP_LOCALE === 'global' ? mxOnlyTables(tables, seeded, skipped) : new Set();
  await seedClientFiles(db, seeded);
  skipped.delete('files');
  // The portal signs in only an active client.
  await db.query("UPDATE clients SET status = 'active' WHERE organization_id IN (?, ?)", [ORG_A, ORG_B]);
  const { signStaffAccessToken, signPortalAccessToken } = require('../../../src/utils/accessTokens');
  const staffToken = org => signStaffAccessToken({ sub: users[org], orgId: org, tv: 0 });
  const portalToken = org => signPortalAccessToken({ clientId: seeded.get('clients')[org].id, organizationId: org, tokenVersion: 0 }, 3600);
  state = { db, tables, seeded, skipped, spares, mxOnly, users, staffToken, portalToken };
  return state;
}

async function teardown() {
  const db = require('../../../src/config/database');
  if (typeof db.close === 'function') await db.close();
}

module.exports = { ENABLED, SWEEP_LOCALE, describeDb, ORG_A, ORG_B, MARK, LEAK_RE, setup, teardown, relaxLimits, createOrgAdmin };
