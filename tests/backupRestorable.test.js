// =============================================================================
// A backup has to be one MySQL will load
// =============================================================================
// The image used to ship Debian's default-mysql-client, which is the MariaDB
// client. mariadb-dump writes a value for every generated column, and MySQL
// refuses such a row on load (error 3105). With over fifty generated columns
// in the schema, no backup the product took could be restored; the DR drill's
// restore test is what found it. The image now carries Oracle's own tools,
// copied from the same MySQL image the database runs.
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const production = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));

test('the production image carries Oracle mysqldump and mysql, not the MariaDB client', () => {
  expect(production).not.toMatch(/^[^#\n]*default-mysql-client/m);
  expect(production).not.toMatch(/^[^#\n]*mariadb/m);
  expect(production).toMatch(/COPY --from=mysql:\d+\.\d+\.\d+@sha256:[0-9a-f]{64} \\\n\s+\/usr\/bin\/mysqldump \/usr\/bin\/mysql \/usr\/local\/bin\//);
  // The build itself proves the copied binaries run on this base image.
  expect(production).toMatch(/^RUN mysqldump --version && mysql --version$/m);
});

test('the tools come from the very MySQL image the database runs', () => {
  const pin = /COPY --from=(mysql:\S+)/.exec(production)[1];
  for (const file of ['docker-compose.prod.yml', 'docker-compose.yml']) {
    const compose = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const images = compose.match(/image: mysql:\S+/g);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) expect(image).toBe(`image: ${pin}`);
  }
});

test('the dump is taken as data, without GTID state that needs privileges to load', () => {
  const backup = fs.readFileSync(path.join(ROOT, 'src', 'scripts', 'backup.js'), 'utf8');
  expect(backup).toMatch(/'--loose-set-gtid-purged=OFF',/);
  expect(backup).toMatch(/'--no-tablespaces',/);
});
