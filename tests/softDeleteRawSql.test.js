'use strict';
// =============================================================================
// DAL-14 — raw SQL on soft-delete tables cannot quietly add unfiltered reads
// =============================================================================
// BaseModel filters deleted_at for softDelete models, but hand-written SQL has
// to do it itself, and about 590 FROM/JOINs of those tables in routes and
// services did not. Many are intended (an invoice PDF still names an archived
// client), so this is a ratchet: no file may gain one. A new read must filter
// <alias>.deleted_at, or say why it wants deleted rows in the SQL:
//   /* includes deleted rows: <reason> */
// When a file's count drops, lower its baseline in
// tests/fixtures/softDeleteBaseline.json in the same change.
// =============================================================================

const { scan, unfilteredReads } = require('./helpers/softDeleteScan');
const baseline = require('./fixtures/softDeleteBaseline.json');

const counts = scan();

test('the scanner flags an unfiltered join and accepts a filtered one', () => {
  const tables = new Set(['clients']);
  expect(unfilteredReads('SELECT i.* FROM invoices i JOIN clients c ON c.id = i.client_id', tables)).toEqual(['clients']);
  expect(unfilteredReads('SELECT i.* FROM invoices i JOIN clients c ON c.id = i.client_id AND c.deleted_at IS NULL', tables)).toEqual([]);
  expect(unfilteredReads('SELECT * FROM clients WHERE deleted_at IS NULL', tables)).toEqual([]);
});

test('no file reads a soft-delete table without deleted_at more often than its baseline', () => {
  const over = Object.entries(counts)
    .filter(([file, n]) => n > (baseline[file] || 0))
    .map(([file, n]) => `${file}: ${n} (baseline ${baseline[file] || 0})`);
  expect(over).toEqual([]);
});

test('the baseline is tightened when reads are fixed', () => {
  const stale = Object.entries(baseline)
    .filter(([file, n]) => (counts[file] || 0) < n)
    .map(([file, n]) => `${file}: baseline ${n}, now ${counts[file] || 0}`);
  expect(stale).toEqual([]);
});
