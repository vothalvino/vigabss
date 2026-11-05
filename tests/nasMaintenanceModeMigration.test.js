'use strict';
// =============================================================================
// NAS maintenance mode (introduced by development migration 456)
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');
const { baselineColumns } = require('./helpers/baseline');

describe('NAS maintenance mode', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'database/schema.sql'), 'utf8');

  test('a NOT NULL maintenance flag, off by default, right after access_mode', () => {
    const columns = baselineColumns('nas');
    expect(columns.get('maintenance_mode')).toMatch(/^tinyint\(1\) NOT NULL DEFAULT '0'/);
    const names = [...columns.keys()];
    expect(names.indexOf('maintenance_mode')).toBe(names.indexOf('access_mode') + 1);
    expect(schema).toMatch(/maintenance_mode BOOLEAN\s+NOT NULL DEFAULT FALSE/);
  });
});
