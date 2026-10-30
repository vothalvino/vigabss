'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const FILENAME = '464_soft_delete_cross_org_plan_windows.sql';
const migration = read(`database/migrations/${FILENAME}`);
// Strip SQL comments so assertions only see executable statements.
const statements = migration.replace(/--.*$/gm, '');

describe('migration 464 cross-org plan window repair', () => {
  test.each(['plan_speed_windows', 'plan_access_windows'])(
    'soft-deletes only live %s rows whose org differs (null-safe) from the plan',
    table => {
      const re = new RegExp(
        `UPDATE ${table} w\\s+JOIN plans p ON p\\.id = w\\.plan_id\\s+` +
        'SET w\\.deleted_at = NOW\\(\\)\\s+' +
        'WHERE w\\.deleted_at IS NULL\\s+' +
        'AND NOT \\(w\\.organization_id <=> p\\.organization_id\\);',
      );
      expect(statements).toMatch(re);
    },
  );

  test('is data-only: exactly two UPDATEs, no DDL, no hard delete, no other columns', () => {
    expect(statements.match(/\bUPDATE\b/g)).toHaveLength(2);
    expect(statements).not.toMatch(/\b(?:ALTER|CREATE|DROP|DELETE|INSERT|TRUNCATE|RENAME)\b/i);
    // The only assignment is deleted_at; status/organization_id are never rewritten.
    expect(statements.match(/\bSET\b[^;]*?(?=WHERE)/g)).toEqual([
      expect.stringMatching(/^SET w\.deleted_at = NOW\(\)\s*$/),
      expect.stringMatching(/^SET w\.deleted_at = NOW\(\)\s*$/),
    ]);
    // A plain `!=` would skip NULL-org rows on either side.
    expect(statements).not.toMatch(/organization_id\s*(?:!=|<>)/);
  });

  test('ships an identically named rollback that does not resurrect windows', () => {
    const rollback = read(`database/rollbacks/${FILENAME}`);
    expect(rollback).toMatch(/NOT auto-restored/);
    const exec = rollback.replace(/--.*$/gm, '');
    expect(exec).toMatch(/SELECT 1 AS cross_org_plan_window_repair_preserved/);
    expect(exec).not.toMatch(/\b(?:UPDATE|INSERT|DELETE|ALTER|CREATE|DROP)\b/i);
  });

  // Mirrors the CI "Check migration numbering integrity" and README sync steps.
  test('migration numbering is gapless and the README range matches the file count', () => {
    const files = fs.readdirSync(path.join(root, 'database/migrations'))
      .filter(f => f.endsWith('.sql'))
      .sort();
    files.forEach((f, i) => {
      expect(Number(f.split('_')[0])).toBe(i + 1);
    });
    expect(files).toContain(FILENAME);

    const readme = read('README.md');
    const line = readme.split('\n').find(l => l.includes('Individual numbered migration files'));
    expect(line).toBeDefined();
    const readmeMax = Number(line.replace(/\)/g, '').match(/(\d+)\s*$/)[1]);
    expect(readmeMax).toBe(files.length);
    expect(readme).toMatch(/> \*\*Migration 464 — /);
  });
});
