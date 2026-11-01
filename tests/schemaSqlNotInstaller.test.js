// =============================================================================
// DB-08 — the docs do not install from schema.sql
// =============================================================================
// The README Quick Start offered `mysql … < database/schema.sql` as a one-step
// install. schema.sql holds 102 permissions where the migrations seed 794,
// plus none of about 37 scheduled tasks and no schema_migrations rows: RBAC
// has no admin bypass, so such an install answers 403 to everyone.
// =============================================================================

const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('the README Quick Start installs with the migration runner, not schema.sql', () => {
  const readme = read('README.md');
  const quick = readme.slice(readme.indexOf('### Quick Start'), readme.indexOf('### Database Tables'));
  expect(quick).toMatch(/pnpm run migrate/);
  expect(quick).not.toMatch(/<\s*database\/schema\.sql/);
  expect(quick).not.toMatch(/for f in database\/migrations/);
});

test('schema.sql and CONTRIBUTING say it is not an installer', () => {
  expect(read('database/schema.sql').slice(0, 800)).toMatch(/NOT an installer/);
  expect(read('CONTRIBUTING.md')).not.toMatch(/schema\.sql\s+# Full schema \(for fresh installs\)/);
});
