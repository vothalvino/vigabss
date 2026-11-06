'use strict';
// =============================================================================
// VigaBSS 5.0 — one active default tax rate per org
// =============================================================================
// resolveTaxContext picks the org default with `... LIMIT 1` and, when no
// explicit rate id is passed, an ORDER BY key that is constant. With TWO active
// defaults it therefore returns whichever row MySQL hands back first. Nothing
// prevented that second default: no uniqueness in the schema, and a bare
// crudController on the route with no hooks, so creating another default simply
// left both set.
//
// The failure shape is the dangerous one for this product — not an error, a
// silently WRONG number. Every invoice, quote and credit note resolves tax
// through that function, and for a Mexican ISP the results become SAT-stamped
// documents that cannot be un-sent.
//
// Two layers, and both are needed:
//   * the schema — a unique index over a generated column (development
//     migration 427), so a race can only ever produce ER_DUP_ENTRY instead of
//     two defaults;
//   * a beforeCreate/beforeUpdate hook — so the ordinary act of changing the
//     default demotes the incumbent instead of colliding with that index.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const { baselineTable } = require('./helpers/baseline');
const table = baselineTable('tax_rates');
const guard = table.match(/`default_guard`[^\n]*/)[0];

describe('the schema-level guarantee', () => {
  it('a generated column that is NULL unless the row is an active default', () => {
    // NULLs repeat freely in a MySQL unique index, so every non-default,
    // inactive or soft-deleted row must land on NULL or the index would reject
    // perfectly legal rows.
    expect(guard).toMatch(/GENERATED ALWAYS AS \(/);
    expect(guard).toMatch(/case when \(\(`is_default` = 1\) and \(`status` = 'active'\) and \(`deleted_at` is null\)\)/);
    expect(guard).toMatch(/else NULL end/);
    expect(table).toContain('UNIQUE KEY `uq_tax_rates_default_guard` (`default_guard`)');
  });

  it('keys the guard on IFNULL(organization_id, 0), not the raw column', () => {
    // tax_rates.organization_id is 'NULL = applies to all tenants'. A raw
    // reference would make the guard NULL for every global rate, which the
    // unique index ignores — letting two GLOBAL defaults coexist, i.e. exactly
    // the bug this closes, surviving in the one scope nobody checks.
    expect(guard).toMatch(/then ifnull\(`organization_id`,0\)/);
    expect(guard).not.toMatch(/then `organization_id` /);
  });

  it('is VIRTUAL, not STORED', () => {
    // STORED forces an ALGORITHM=COPY table rebuild, and tax_rates is the parent
    // of FKs from invoices, quotes and credit_notes, so a later migration that
    // touched it would risk ER_CANNOT_ADD_FOREIGN.
    expect(guard).toMatch(/\) VIRTUAL/);
    expect(guard).not.toMatch(/\) STORED/);
  });

  it('never writes the generated column', () => {
    // MySQL rejects any explicit value for a generated column, so an INSERT or
    // UPDATE naming default_guard would fail outright.
    for (const f of ['src/routes/taxRates.js', 'src/services/billingService.js', 'src/models/TaxRate.js']) {
      expect(read(f)).not.toMatch(/INSERT[\s\S]{0,200}default_guard/);
      expect(read(f)).not.toMatch(/SET[\s\S]{0,80}default_guard\s*=/);
    }
  });
});

describe('the route demotes the incumbent default', () => {
  const src = read('src/routes/taxRates.js');

  it('hooks both create and update', () => {
    // The index alone would make "make this one the default" fail with a
    // duplicate-key error and no explanation. beforeCreate is required
    // specifically because an after* hook runs when the insert has ALREADY
    // tripped the index.
    expect(src).toMatch(/beforeCreate:/);
    expect(src).toMatch(/beforeUpdate:/);
  });

  it('scopes the demotion the same way the guard is keyed', () => {
    // A plain `organization_id = ?` would never match the global (NULL org)
    // rows the guard keys as 0 — the demotion would silently no-op for them
    // while the index still rejected the insert.
    expect(src).toMatch(/IFNULL\(organization_id, 0\) = \?/);
    expect(src).toMatch(/is_default = 1/);
    expect(src).toMatch(/status = 'active'/);
    expect(src).toMatch(/deleted_at IS NULL/);
  });

  it('does not demote the row being updated', () => {
    // Re-saving the current default must not clear it.
    expect(src).toMatch(/excludeId/);
    expect(src).toMatch(/AND id <> \?/);
  });

  it('leaves the row alone when is_default is absent from a PATCH', () => {
    expect(src).toMatch(/if \(req\.body\.is_default === undefined\) return;/);
  });
});

describe('crudController gained a beforeCreate hook', () => {
  const src = read('src/controllers/crudController.js');

  it('runs it after the org injection and before the insert', () => {
    // Order matters: a hook reconciling per-org state must see the org the row
    // will actually be written with.
    const inject = src.indexOf('req.body.organization_id = req.orgId');
    const hook = src.indexOf('if (beforeCreateHook) await beforeCreateHook(req)');
    const insert = src.indexOf('const record = await createFn(req.body)');
    expect(inject).toBeLessThan(hook);
    expect(hook).toBeLessThan(insert);
  });

  it('stays optional, so the other ~171 routers are unaffected', () => {
    expect(src).toMatch(/typeof _options\.beforeCreate === 'function' \? _options\.beforeCreate : null/);
  });
});

describe('resolveTaxContext no longer resolves a rate across tenants', () => {
  const src = read('src/services/billingService.js');
  const q = src.slice(src.indexOf('SELECT id, rate FROM tax_rates'));
  const stmt = q.slice(0, q.indexOf('`,'));

  it('constrains the explicit-id branch by org, status and soft delete', () => {
    // It was a bare `WHERE id = ?`: any tenant's rate id resolved, including
    // inactive and soft-deleted ones.
    expect(stmt).toMatch(/id = \?[\s\S]*organization_id = \? OR organization_id IS NULL/);
    expect(stmt).toMatch(/status = 'active' AND deleted_at IS NULL\)/);
  });

  it('still admits globally shared rates', () => {
    // Migration 121 seeds shared rates with a NULL org; restricting the branch
    // to `organization_id = ?` would silently stop resolving them.
    expect(stmt).toMatch(/organization_id IS NULL/);
  });
});
