// =============================================================================
// No unquoted MySQL/MariaDB reserved word as a column name
// =============================================================================
// Migration 511 named a column `sensitive`, a reserved word since MySQL 5.0
// (cursor sensitivity). The mocked suites accepted it and only the real
// database in CI refused it. This reads every CREATE TABLE and ADD COLUMN and
// fails on a bare reserved column name before it reaches a database.
// =============================================================================

const fs = require('fs');
const path = require('path');

// The MySQL 8.0 reserved words (the "(R)" entries of the keyword list) that
// can plausibly be a column name, plus MariaDB-only reserved words.
const RESERVED = new Set([
  'accessible', 'add', 'all', 'alter', 'analyze', 'and', 'as', 'asc', 'asensitive', 'before', 'between',
  'bigint', 'binary', 'blob', 'both', 'by', 'call', 'cascade', 'case', 'change', 'char', 'character',
  'check', 'collate', 'column', 'condition', 'constraint', 'continue', 'convert', 'create', 'cross',
  'cube', 'cume_dist', 'current_date', 'current_role', 'current_time', 'current_timestamp', 'current_user',
  'cursor', 'database', 'databases', 'day_hour', 'day_microsecond', 'day_minute', 'day_second', 'dec',
  'decimal', 'declare', 'default', 'delayed', 'delete', 'dense_rank', 'desc', 'describe', 'deterministic',
  'distinct', 'distinctrow', 'div', 'double', 'drop', 'dual', 'each', 'else', 'elseif', 'empty', 'enclosed',
  'escaped', 'except', 'exists', 'exit', 'explain', 'false', 'fetch', 'first_value', 'float', 'for',
  'force', 'foreign', 'from', 'fulltext', 'function', 'generated', 'get', 'grant', 'group', 'grouping',
  'groups', 'having', 'high_priority', 'hour_microsecond', 'hour_minute', 'hour_second', 'if', 'ignore',
  'in', 'index', 'infile', 'inner', 'inout', 'insensitive', 'insert', 'int', 'integer', 'intersect',
  'interval', 'into', 'is', 'iterate', 'join', 'json_table', 'key', 'keys', 'kill', 'lag', 'last_value',
  'lateral', 'lead', 'leading', 'leave', 'left', 'like', 'limit', 'linear', 'lines', 'load', 'localtime',
  'localtimestamp', 'lock', 'long', 'loop', 'low_priority', 'match', 'maxvalue', 'mediumint', 'minute_microsecond',
  'minute_second', 'mod', 'modifies', 'natural', 'not', 'nth_value', 'ntile', 'null', 'numeric', 'of', 'offset',
  'on', 'optimize', 'option', 'optionally', 'or', 'order', 'out', 'outer', 'outfile', 'over', 'partition',
  'percent_rank', 'precision', 'primary', 'procedure', 'purge', 'range', 'rank', 'read', 'reads', 'real',
  'recursive', 'references', 'regexp', 'release', 'rename', 'repeat', 'replace', 'require', 'resignal',
  'restrict', 'return', 'returning', 'revoke', 'right', 'rlike', 'row', 'row_number', 'rows', 'schema',
  'schemas', 'second_microsecond', 'select', 'sensitive', 'separator', 'set', 'show', 'signal', 'smallint',
  'spatial', 'specific', 'sql', 'sqlexception', 'sqlstate', 'sqlwarning', 'ssl', 'starting', 'stored',
  'straight_join', 'system', 'table', 'terminated', 'then', 'tinyint', 'to', 'trailing', 'trigger', 'true',
  'undo', 'union', 'unique', 'unlock', 'unsigned', 'update', 'usage', 'use', 'using', 'utc_date', 'utc_time',
  'utc_timestamp', 'values', 'varbinary', 'varchar', 'varying', 'virtual', 'when', 'where', 'while', 'window',
  'with', 'write', 'xor', 'year_month', 'zerofill',
]);

const TYPE = '(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|DECIMAL|NUMERIC|FLOAT|DOUBLE|BOOLEAN|BOOL|BIT|CHAR|VARCHAR|BINARY|VARBINARY|TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|TINYBLOB|BLOB|MEDIUMBLOB|LONGBLOB|ENUM|SET|JSON|DATE|DATETIME|TIMESTAMP|TIME|YEAR|POINT|GEOMETRY)\\b';
// A column definition line inside CREATE TABLE, or ADD [COLUMN] name.
const DEFINITION = new RegExp(`^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s+${TYPE}`, 'i');
const ADD_COLUMN = new RegExp(`ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s+${TYPE}`, 'gi');

function bareReservedColumns(sql) {
  const found = new Set();
  let inCreate = false;
  for (const line of sql.split('\n')) {
    const code = line.replace(/--.*$/, '');
    if (/CREATE\s+TABLE/i.test(code)) inCreate = true;
    if (inCreate) {
      const m = DEFINITION.exec(code);
      if (m && RESERVED.has(m[1].toLowerCase())) found.add(m[1]);
      if (/^\)\s*(ENGINE|;|COMMENT)/i.test(code.trim())) inCreate = false;
    }
    for (const m of code.matchAll(ADD_COLUMN)) {
      if (RESERVED.has(m[1].toLowerCase())) found.add(m[1]);
    }
  }
  return [...found];
}

describe('SQL column names', () => {
  const root = path.join(__dirname, '..', 'database');
  const files = [
    path.join(root, 'schema.sql'),
    ...fs.readdirSync(path.join(root, 'migrations')).filter(f => f.endsWith('.sql')).map(f => path.join(root, 'migrations', f)),
  ];

  test('the detector catches the column migration 511 first shipped', () => {
    expect(bareReservedColumns('CREATE TABLE t (\n    sensitive TINYINT(1) NOT NULL DEFAULT 0\n) ENGINE=InnoDB;'))
      .toEqual(['sensitive']);
    expect(bareReservedColumns('ALTER TABLE t ADD COLUMN `sensitive` TINYINT(1) NOT NULL;')).toEqual([]);
    expect(bareReservedColumns('ALTER TABLE t ADD COLUMN sensitive TINYINT(1) NOT NULL;')).toEqual(['sensitive']);
  });

  test.each(files.map(f => [path.relative(root, f), f]))('%s names no column with a bare reserved word', (_name, file) => {
    expect(bareReservedColumns(fs.readFileSync(file, 'utf8'))).toEqual([]);
  });
});
