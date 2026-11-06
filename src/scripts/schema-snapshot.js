// =============================================================================
// VigaBSS 5.0 — Schema snapshot
// =============================================================================
// Writes a normalized JSON description of a database: tables, columns,
// indexes, foreign keys, CHECK constraints, triggers, routines, views and the
// rows every table holds right after install (the seed data). Two databases
// built different ways (for example the full migration chain and a squashed
// baseline) are equivalent when their snapshots are byte-identical.
//
// Timestamps that installs fill with NOW() differ between any two runs, so
// date/time values in rows are replaced with a marker; their presence (NULL or
// not) still counts. schema_migrations belongs to the runner and is skipped.
//
// Usage:  node src/scripts/schema-snapshot.js <output.json>
//         (connects with DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME)
// =============================================================================

require('dotenv').config();
const fs = require('fs');
const mysql = require('mysql2/promise');

const SKIP_TABLES = new Set(['schema_migrations']);
const TIME_TYPES = new Set(['date', 'datetime', 'timestamp', 'time', 'year']);

// Whitespace and the schema qualifier differ between how a trigger or view was
// written and how the server echoes it back; neither changes what it does.
function normalizeSql(text, schema) {
  return String(text ?? '')
    .split(`\`${schema}\`.`).join('')
    .replace(/\s+/g, ' ')
    .trim();
}

async function rows(conn, sql, params) {
  const [result] = await conn.query(sql, params);
  return result;
}

async function snapshot(conn, schema) {
  const tables = await rows(conn, `
    SELECT TABLE_NAME AS \`name\`, TABLE_TYPE AS \`type\`, ENGINE AS \`engine\`, TABLE_COLLATION AS \`collation\`,
           TABLE_COMMENT AS \`comment\`, ROW_FORMAT AS \`rowFormat\`, CREATE_OPTIONS AS \`createOptions\`
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [schema]);
  const columns = await rows(conn, `
    SELECT TABLE_NAME AS \`t\`, COLUMN_NAME AS \`name\`, ORDINAL_POSITION AS \`pos\`, COLUMN_TYPE AS \`type\`,
           IS_NULLABLE AS \`nullable\`, COLUMN_DEFAULT AS \`dflt\`, EXTRA AS \`extra\`,
           CHARACTER_SET_NAME AS \`charset\`, COLLATION_NAME AS \`collation\`,
           GENERATION_EXPRESSION AS \`genExpr\`, COLUMN_COMMENT AS \`comment\`
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [schema]);
  const indexes = await rows(conn, `
    SELECT TABLE_NAME AS \`t\`, INDEX_NAME AS \`name\`, NON_UNIQUE AS \`nonUnique\`, SEQ_IN_INDEX AS \`seq\`,
           COLUMN_NAME AS \`col\`, SUB_PART AS \`subPart\`, INDEX_TYPE AS \`type\`
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, [schema]);
  const foreignKeys = await rows(conn, `
    SELECT k.TABLE_NAME AS \`t\`, k.CONSTRAINT_NAME AS \`name\`, k.COLUMN_NAME AS \`col\`, k.ORDINAL_POSITION AS \`pos\`,
           k.REFERENCED_TABLE_NAME AS \`refTable\`, k.REFERENCED_COLUMN_NAME AS \`refCol\`,
           r.UPDATE_RULE AS \`onUpdate\`, r.DELETE_RULE AS \`onDelete\`
      FROM information_schema.KEY_COLUMN_USAGE k
      JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
       AND r.TABLE_NAME = k.TABLE_NAME
     WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [schema]);
  const checks = await rows(conn, `
    SELECT tc.TABLE_NAME AS \`t\`, cc.CONSTRAINT_NAME AS \`name\`, cc.CHECK_CLAUSE AS \`clause\`
      FROM information_schema.CHECK_CONSTRAINTS cc
      JOIN information_schema.TABLE_CONSTRAINTS tc
        ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
       AND tc.CONSTRAINT_TYPE = 'CHECK'
     WHERE cc.CONSTRAINT_SCHEMA = ? ORDER BY tc.TABLE_NAME, cc.CONSTRAINT_NAME`, [schema]);
  const triggers = await rows(conn, `
    SELECT TRIGGER_NAME AS \`name\`, EVENT_OBJECT_TABLE AS \`t\`, ACTION_TIMING AS \`timing\`,
           EVENT_MANIPULATION AS \`event\`, ACTION_ORDER AS \`actionOrder\`, ACTION_STATEMENT AS \`body\`,
           SQL_MODE AS \`sqlMode\`
      FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`, [schema]);
  const routines = await rows(conn, `
    SELECT ROUTINE_NAME AS \`name\`, ROUTINE_TYPE AS \`type\`, DTD_IDENTIFIER AS \`returnType\`, ROUTINE_DEFINITION AS \`body\`,
           IS_DETERMINISTIC AS \`deterministic\`, SQL_DATA_ACCESS AS \`dataAccess\`, SECURITY_TYPE AS \`security\`,
           SQL_MODE AS \`sqlMode\`, ROUTINE_COMMENT AS \`comment\`
      FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME`, [schema]);
  const parameters = await rows(conn, `
    SELECT SPECIFIC_NAME AS \`routine\`, ORDINAL_POSITION AS \`pos\`, PARAMETER_MODE AS \`mode\`,
           PARAMETER_NAME AS \`name\`, DTD_IDENTIFIER AS \`type\`
      FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA = ? ORDER BY SPECIFIC_NAME, ORDINAL_POSITION`, [schema]);
  // Partition names and bounds depend on the install date, so two installs are
  // comparable only when made on the same day (which the equivalence job does).
  const partitions = await rows(conn, `
    SELECT TABLE_NAME AS \`t\`, PARTITION_NAME AS \`name\`, PARTITION_ORDINAL_POSITION AS \`pos\`,
           PARTITION_METHOD AS \`method\`, PARTITION_EXPRESSION AS \`expression\`,
           PARTITION_DESCRIPTION AS \`description\`
      FROM information_schema.PARTITIONS
     WHERE TABLE_SCHEMA = ? AND PARTITION_NAME IS NOT NULL
     ORDER BY TABLE_NAME, PARTITION_ORDINAL_POSITION`, [schema]);
  const views = await rows(conn, `
    SELECT TABLE_NAME AS \`name\`, VIEW_DEFINITION AS \`body\`
      FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [schema]);
  const events = await rows(conn, `
    SELECT EVENT_NAME AS \`name\`, EVENT_DEFINITION AS \`body\`, INTERVAL_VALUE AS \`intervalValue\`, INTERVAL_FIELD AS \`intervalField\`,
           EVENT_TYPE AS \`type\`, STATUS AS \`status\`, ON_COMPLETION AS \`onCompletion\`, SQL_MODE AS \`sqlMode\`,
           -- The first run relative to creation (absolute times differ per
           -- install): days later and time of day, or for hourly events the
           -- hours later and minute past the hour.
           CASE WHEN INTERVAL_FIELD = 'HOUR'
                THEN CONCAT('+', TIMESTAMPDIFF(HOUR, DATE_FORMAT(CREATED, '%Y-%m-%d %H:00:00'),
                                              DATE_FORMAT(STARTS, '%Y-%m-%d %H:00:00')), 'h :', DATE_FORMAT(STARTS, '%i'))
                ELSE CONCAT('+', DATEDIFF(STARTS, CREATED), 'd ', DATE_FORMAT(STARTS, '%H:%i:%s'))
           END AS \`startsAfterCreate\`
      FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME`, [schema]);

  const timeColumns = new Map();
  for (const c of columns) {
    if (TIME_TYPES.has(String(c.type).split('(')[0].toLowerCase())) {
      if (!timeColumns.has(c.t)) timeColumns.set(c.t, new Set());
      timeColumns.get(c.t).add(c.name);
    }
  }

  const data = {};
  for (const table of tables) {
    if (table.type !== 'BASE TABLE' || SKIP_TABLES.has(table.name)) continue;
    const found = await rows(conn, `SELECT * FROM \`${table.name}\``);
    if (!found.length) continue;
    const times = timeColumns.get(table.name) || new Set();
    data[table.name] = found
      .map(row => JSON.stringify(Object.keys(row).sort().map((key) => {
        const value = row[key];
        if (times.has(key)) return [key, value === null ? null : '<time>'];
        if (Buffer.isBuffer(value)) return [key, value.toString('hex')];
        return [key, value];
      })))
      .sort();
  }

  const strip = list => list.map(item => ({ ...item, ...(item.body !== undefined ? { body: normalizeSql(item.body, schema) } : {}) }));
  return {
    tables: tables.map(({ name, type, engine, collation, comment, rowFormat, createOptions }) => ({
      name, type, engine, collation, comment, rowFormat, createOptions: normalizeSql(createOptions, schema),
    })),
    columns,
    indexes,
    foreignKeys,
    checks: checks.map(c => ({ ...c, clause: normalizeSql(c.clause, schema) })),
    triggers: strip(triggers),
    routines: strip(routines),
    parameters,
    partitions: partitions.map(p => ({ ...p, expression: normalizeSql(p.expression, schema) })),
    views: strip(views),
    events: strip(events),
    data,
  };
}

async function main() {
  const out = process.argv[2];
  if (!out) {
    console.error('Usage: node src/scripts/schema-snapshot.js <output.json>');
    process.exit(2);
  }
  const schema = process.env.DB_NAME || 'fireisp';
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: schema,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  try {
    const result = await snapshot(conn, schema);
    fs.writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
    console.log(`Snapshot of ${schema}: ${result.tables.length} tables, ${Object.keys(result.data).length} seeded, written to ${out}`);
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { snapshot, normalizeSql };
