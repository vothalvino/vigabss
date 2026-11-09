'use strict';

// =============================================================================
// TNA-40 — configurable features with no consumer say so
// =============================================================================
// Backup schedules, masking rules, DHCP reservations and billing adjustments
// were stored and shown like working settings, but nothing read them; speed
// tests could be queued but nothing ran them. Each page or API now says the
// record is not applied, and speed-test jobs are refused. This test ties each
// label to the absence of a consumer: wiring a feature up fails it until its
// label is removed too.
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory()
    ? walk(path.join(dir, e.name))
    : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}

// Code that would act on the records: everything under src/ except the
// feature's own CRUD route, its model and the metadata files.
function consumers(table, ownFiles) {
  const own = new Set(ownFiles.map(f => path.join(ROOT, f)));
  return walk(path.join(ROOT, 'src'))
    .filter(f => !own.has(f))
    .filter(f => !/src\/(models\/ownedForeignKeys\.json|utils\/openapi\.js|scripts\/)/.test(f))
    .filter(f => new RegExp(`\\b${table}\\b`).test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(ROOT, f));
}

test.each([
  ['config_backup_schedules', ['src/routes/configBackupSchedules.js'], 'frontend/src/pages/ConfigBackupScheduleList.tsx', 'notApplied.backupSchedules'],
])('%s has no consumer, and its page says it is not applied', (table, own, page, key) => {
  expect(consumers(table, own)).toEqual([]);
  expect(read(page)).toContain(`<NotAppliedNotice detail={t('${key}')} />`);
});

// Data masking rules are applied by nothing, so Security & Access Control no
// longer shows them at all (2026-11) instead of listing them with a notice.
test('data_masking_rules has no consumer, and the security page does not show it', () => {
  expect(consumers('data_masking_rules', ['src/routes/dataSecurity.js', 'src/models/DataMaskingRule.js'])).toEqual([]);
  const page = read('frontend/src/pages/SecurityAccessControlPage.tsx');
  expect(page).not.toMatch(/data-masking|dataMasking/);
});

test('billing adjustments change no balance, and the page says they are notes', () => {
  const service = read('src/services/billingAdjustmentService.js');
  expect(service).not.toMatch(/client_balance_ledger|credit_notes|UPDATE invoices|INSERT INTO payments/);
  expect(read('frontend/src/pages/BillingAdjustmentList.tsx'))
    .toContain("<NotAppliedNotice detail={t('notApplied.billingAdjustments')} />");
});

test('DHCP reservations are records only, and the API says so', () => {
  expect(consumers('dhcp_static_reservations', ['src/routes/dhcpServers.js'])).toEqual([]);
  const route = read('src/routes/dhcpServers.js');
  expect(route.match(/meta: \{[^}]*applied_to_server: false/g)).toHaveLength(2);
});

test('speed-test jobs are refused while nothing runs them', () => {
  const runner = read('src/services/taskRunner.js');
  expect(runner).toMatch(/case 'subscriber_speed_test_run':[\s\S]*?deferred: true/);
  expect(read('src/routes/portal.js')).toMatch(/router\.post\('\/speed-test', \(_req, _res, next\) => \{\n\s+next\(speedTestJobsUnavailable\(\)\);/);
  expect(read('src/routes/bandwidthTests.js')).toMatch(/throw speedTestJobsUnavailable\(\);/);
  expect(read('frontend/src/pages/portal/PortalSpeedTest.tsx')).not.toMatch(/method: 'POST'/);
});
