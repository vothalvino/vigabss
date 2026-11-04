'use strict';
// =============================================================================
// lint-staged commands are not shell lines
// =============================================================================
// lint-staged runs each command without a shell. 'gen:api && tsc --noEmit'
// therefore ran gen:api with '&&', 'pnpm', ... as extra arguments: the
// generated schema.d.ts lost --empty-objects-unknown on every commit and the
// pre-commit typecheck never ran. Chain commands as separate entries.
// =============================================================================

const config = require('../.lintstagedrc.cjs');

test('no lint-staged command uses a shell operator', () => {
  const commands = Object.values(config).flatMap(task => [].concat(typeof task === 'function' ? task(['x.ts']) : task));
  expect(commands.length).toBeGreaterThan(0);
  expect(commands.filter(c => /&&|\|\||[;|<>`]|\$\(/.test(c))).toEqual([]);
});

test('the frontend typecheck runs after the schema is generated', () => {
  const frontend = config['frontend/src/**/*.{ts,tsx}']([]);
  expect(frontend.indexOf('pnpm --dir frontend run gen:api')).toBeLessThan(frontend.indexOf('pnpm --dir frontend exec tsc --noEmit'));
  expect(frontend.indexOf('pnpm --dir frontend run gen:api')).toBeGreaterThanOrEqual(0);
});
