// =============================================================================
// OPS-09 — the app container does not receive the MySQL root or replication
// secrets
// =============================================================================
// The app loads .env.prod through env_file, which also holds DB_ROOT_PASSWORD
// and MYSQL_REPL_*; only the database services need them. The k8s app secret
// carried DB_ROOT_PASSWORD although nothing in the cluster manifests uses it.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('docker-compose.prod.yml blanks the database admin secrets for the app', () => {
  const app = yaml.load(read('docker-compose.prod.yml')).services.app;
  expect(app.env_file).toContain('.env.prod');
  for (const key of ['DB_ROOT_PASSWORD', 'MYSQL_REPL_USER', 'MYSQL_REPL_PASSWORD']) {
    expect(app.environment[key]).toBe('');
  }
});

test('the database services still receive them', () => {
  const services = yaml.load(read('docker-compose.prod.yml')).services;
  expect(services['db-primary'].environment.MYSQL_ROOT_PASSWORD).toMatch(/DB_ROOT_PASSWORD/);
  expect(services['db-replica'].environment.MYSQL_REPL_PASSWORD).toMatch(/MYSQL_REPL_PASSWORD/);
});

test('the k8s app secret has no root password', () => {
  expect(read('k8s/sealed-secret.yaml')).not.toMatch(/DB_ROOT_PASSWORD/);
});

test('src never reads the root or replication secrets', () => {
  const offenders = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js') && /process\.env\.(DB_ROOT_PASSWORD|MYSQL_REPL_)/.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
    }
  })(path.join(root, 'src'));
  expect(offenders).toEqual([]);
});
