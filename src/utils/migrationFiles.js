// =============================================================================
// Migration file ordering and checksums (DB-21)
// =============================================================================
// Files were ordered with a plain .sort(), which is right only while every
// prefix has three digits: '1000_x.sql' sorts before '101_x.sql'. Every tool
// that lists migrations orders them here by numeric prefix instead.
// =============================================================================

const crypto = require('crypto');
const fs = require('fs');

/** The numeric prefix of a migration filename ('130' in '130_x.sql'), or NaN. */
function migrationNumber(filename) {
  const match = /^(\d+)_/.exec(String(filename));
  return match ? Number.parseInt(match[1], 10) : Number.NaN;
}

function compareMigrationFiles(a, b) {
  const byNumber = migrationNumber(a) - migrationNumber(b);
  if (Number.isFinite(byNumber) && byNumber !== 0) return byNumber;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The .sql files in a directory, in numeric order. */
function listMigrationFiles(dir) {
  return fs.readdirSync(dir).filter(file => file.endsWith('.sql')).sort(compareMigrationFiles);
}

/**
 * sha256 of a migration's SQL with comments and whitespace runs removed, so
 * rewording a comment does not change it but any statement change does.
 */
function migrationChecksum(sql) {
  const normalized = String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)--[^\n]*/g, '$1')
    .replace(/(^|\s)#[^\n]*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

module.exports = { migrationNumber, compareMigrationFiles, listMigrationFiles, migrationChecksum };
