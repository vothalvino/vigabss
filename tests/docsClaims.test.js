// =============================================================================
// OPS-22 — README and CONTRIBUTING claims match the code
// =============================================================================
// The README listed payment gateways (OpenPay, MercadoPago, PayPal) and a PAC
// (FacturAPI) the code does not support, task names that do not exist
// (payment_retry, config_backup), an active ZAP scan where CI runs a passive
// baseline, and audit-log retention the purge refuses. CONTRIBUTING sent
// developers to an X-Org-Id header nothing reads and suggested regenerating
// schema.sql with mysqldump --no-data, which would drop its seed rows.
// =============================================================================

const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const readme = read('README.md');
const contributing = read('CONTRIBUTING.md');
const featureLine = prefix => readme.split('\n').find(l => l.startsWith(prefix)) || '';

test('the payment gateways the README names are the ones that charge', () => {
  const service = read('src/services/paymentGatewayService.js');
  const charging = [...service.matchAll(/case '([a-z_]+)':\n\s+result = await paymentCircuitBreaker/g)].map(m => m[1]);
  expect(charging.sort()).toEqual(['conekta', 'stripe']);
  const line = featureLine('- Payment gateway integrations');
  for (const name of ['OpenPay', 'MercadoPago', 'PayPal']) expect(line).not.toContain(name);
  for (const name of ['Stripe', 'Conekta']) expect(line).toContain(name);
});

test('the PACs the README names are the supported ones', () => {
  expect(read('src/services/cfdiService.js')).toMatch(/Supported: finkok, sw_sapien\./);
  const line = featureLine('- SAT CFDI 4.0');
  expect(line).toContain('Finkok');
  expect(line).toContain('SW Sapien');
  expect(line).not.toMatch(/FacturAPI|etc\./);
});

test('every task the README names is a real scheduled task', () => {
  const runner = read('src/services/taskRunner.js');
  const line = featureLine('- Scheduled tasks');
  const names = [...line.matchAll(/`([a-z0-9_]+)`/g)].map(m => m[1]);
  expect(names.length).toBeGreaterThan(5);
  expect(names.filter(n => !runner.includes(`case '${n}':`))).toEqual([]);
});

test('the README describes the ZAP scan CI actually runs', () => {
  expect(read('.github/workflows/ci.yml')).toMatch(/zaproxy\/action-baseline@/);
  expect(featureLine('- OWASP ZAP')).toMatch(/baseline \(passive\)/);
  expect(featureLine('- OWASP ZAP')).not.toMatch(/active scan/);
});

test('the README does not promise audit-log purging', () => {
  const line = featureLine('- Data retention policies');
  expect(line).toMatch(/audit log is never purged/);
  expect(read('src/services/retentionService.js')).not.toMatch(/^\s+audit_logs: \{/m);
});

test('CONTRIBUTING matches how the organization is chosen and how schema.sql is kept', () => {
  expect(contributing).not.toMatch(/via `X-Org-Id` header/);
  expect(read('src/middleware/orgScope.js')).not.toMatch(/x-org-id/i);
  expect(contributing).not.toMatch(/regenerate it with: `mysqldump/);
  expect(contributing).toMatch(/database\/rollbacks\//);
  // Counts go stale; the tree describes, it does not count.
  expect(contributing).not.toMatch(/\(\d+\+? (?:controllers|entities|route files|services|files)[,)]/);
});
