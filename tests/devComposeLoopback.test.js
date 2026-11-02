// =============================================================================
// OPS-11 — the development compose keeps its data services on loopback
// =============================================================================
// docker-compose.yml published MySQL 3306, password-less Redis 6379 and
// ChromaDB 8000 with no host IP, so Docker bound them on every interface (its
// iptables rules bypass UFW), and MySQL fell back to a fixed root password.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const compose = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8'));

test.each(['db', 'redis', 'chromadb'])('%s publishes its ports on 127.0.0.1 only', (service) => {
  const ports = compose.services[service].ports;
  expect(ports.length).toBeGreaterThan(0);
  for (const port of ports) expect(String(port)).toMatch(/^127\.0\.0\.1:/);
});

test('MySQL has no fallback root password', () => {
  expect(compose.services.db.environment.MYSQL_ROOT_PASSWORD).toBe('${DB_PASSWORD:?Set DB_PASSWORD in .env}');
});
