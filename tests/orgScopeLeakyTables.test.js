'use strict';
// =============================================================================
// VigaBSS 5.0 — the tables BaseModel used to leave unscoped
// =============================================================================
// src/models/BaseModel.js reads:
//
//     if (orgId !== null && this.hasOrgScope) { conditions.push('organization_id = ?') }
//
// so a model declaring `hasOrgScope = false` gets its org filter SILENTLY
// OMITTED rather than raising. No error, no log, no failing test — the defect is
// invisible by construction, which is why it survived. The same absent predicate
// flows into update/delete/restore, making it cross-tenant WRITE as well as read.
//
// device_config_backups and recurring_payment_profiles were both mounted behind
// a generic crudController over exactly such a model. The first holds full
// RouterOS exports (PPPoE/RADIUS secrets, SNMP communities, WireGuard keys); the
// second holds gateway tokens and Stripe customer ids.
//
// Migration 425 gave both an organization_id and the models now scope. These
// assertions pin the three things that have to stay true together — flip any one
// back and the hole reopens or the writes start landing unattributed.
// =============================================================================

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const DeviceConfigBackup = require('../src/models/DeviceConfigBackup');
const RecurringPaymentProfile = require('../src/models/RecurringPaymentProfile');
const Radius = require('../src/models/Radius');
const SlaDefinition = require('../src/models/SlaDefinition');

const SCOPED = [
  ['DeviceConfigBackup', DeviceConfigBackup, 'device_config_backups'],
  ['RecurringPaymentProfile', RecurringPaymentProfile, 'recurring_payment_profiles'],
  ['Radius', Radius, 'radius'],
  ['SlaDefinition', SlaDefinition, 'sla_definitions'],
];

describe('the formerly-unscoped models now scope by organization', () => {
  it.each(SCOPED)('%s.hasOrgScope is true', (_name, Model) => {
    expect(Model.hasOrgScope).toBe(true);
  });

  it.each(SCOPED)('%s lists organization_id in fillable', (_name, Model) => {
    // THE TRAP: crudController injects req.orgId into the body only when
    // hasOrgScope is true (crudController.js:123-125), and BaseModel.create
    // filters strictly to `fillable`. Turning scoping on WITHOUT this line makes
    // every POST silently drop the org — writing a NULL-org row that is
    // invisible to its own creator's list and 404s on update. The fix would
    // have caused a new instance of the bug class it closes.
    expect(Model.fillable).toContain('organization_id');
  });

  it.each(SCOPED)('%s organization_id is NULLABLE, like every parent org column', (_name, _Model, table) => {
    // NOT NULL here is a DATA-LOSS bug, not extra safety. Every parent org
    // column in this schema is nullable by design —
    //   devices.organization_id / clients.organization_id:
    //   'Tenant organization ...; NULL = single-tenant deployment'
    // — so on a single-tenant install the backfill legitimately yields NULL.
    // A NOT NULL column can only be reconciled by deleting those rows, which is
    // what an earlier draft did: it would have wiped every device config backup
    // and every autopay profile on such an install. CI passed because the
    // tables are empty there.
    //
    // Nullable is also correct, not just safe: BaseModel applies no org
    // predicate when req.orgId is null, so a single-tenant deployment still
    // sees its own rows.
    const schema = read('database/schema.sql');
    const block = schema.slice(schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`));
    const ddl = block.slice(0, block.indexOf('ENGINE='));
    expect(ddl).toMatch(/organization_id\s+BIGINT UNSIGNED\s+NULL/);
    expect(ddl).not.toMatch(/organization_id\s+BIGINT UNSIGNED\s+NOT NULL/);
  });

});

describe('BaseModel no longer omits the predicate silently (TNB-34)', () => {
  it('a missing organization throws instead of dropping the tenant filter', () => {
    // The trap these per-model guards existed for: a null orgId used to skip
    // the condition. It is now a throw, unless the caller passes UNSCOPED.
    const src = read('src/models/BaseModel.js');
    expect(src).not.toMatch(/orgId = null/);
    expect(src).toMatch(/if \(orgId === null \|\| orgId === undefined\) \{\s*throw new Error/);
  });
});

describe('raw SQL that BaseModel scoping cannot reach', () => {
  it('the config-backup diff route filters by organization', () => {
    // GET /device-config-backups/diff/:id is a hand-written query, so the model
    // flag does nothing for it. Without an explicit predicate any tenant could
    // read any other tenant's config diff by guessing an id.
    const src = read('src/routes/deviceConfigBackups.js');
    const diff = src.slice(src.indexOf("router.get('/diff/:id'"));
    const handler = diff.slice(0, diff.indexOf('});'));
    expect(handler).toMatch(/FROM device_config_backups/);
    expect(handler).toMatch(/organization_id = \?/);
    expect(handler).toMatch(/req\.orgId/);
  });

  it('the nightly config pull writes an organization_id', () => {
    // configBackupService runs unattended with no request context, so it derives
    // the org from the device in the statement itself. Miss this and the nightly
    // pull silently refills the table with NULL-org rows that no multi-tenant
    // request can see — re-creating the leak's mirror image.
    const src = read('src/services/configBackupService.js');
    const ins = src.slice(src.indexOf('INSERT INTO device_config_backups'));
    const stmt = ins.slice(0, ins.indexOf('`,'));
    expect(stmt).toMatch(/organization_id/);
    expect(stmt).toMatch(/SELECT organization_id FROM devices WHERE id = \?/);
  });

  it('autopay enrollment writes an organization_id taken from the gateway', () => {
    const src = read('src/services/autopayService.js');
    const ins = src.slice(src.indexOf('INSERT INTO recurring_payment_profiles'));
    const stmt = ins.slice(0, ins.indexOf('`,'));
    expect(stmt).toMatch(/organization_id/);
    expect(src).toMatch(/\[gateway\.organization_id, clientId, gateway\.id/);
  });
});

describe('config backups and autopay profiles are owned by an organization', () => {
  const { baselineColumns, baselineTable } = require('./helpers/baseline');

  it.each([
    ['device_config_backups', 'fk_dcb_org', 'idx_dcb_org'],
    ['recurring_payment_profiles', 'fk_rpp_org', 'idx_rpp_org'],
  ])('%s has organization_id, its foreign key and its index', (table, fk, index) => {
    expect(baselineColumns(table).get('organization_id')).toMatch(/^bigint unsigned/);
    expect(baselineTable(table)).toMatch(new RegExp(`CONSTRAINT \`${fk}\` FOREIGN KEY \\(\`organization_id\`\\) REFERENCES \`organizations\``));
    expect(baselineTable(table)).toMatch(new RegExp(`KEY \`${index}\` \\(\`organization_id\`,`));
  });
});

describe('radius — the one that LOOKED already fixed (migration 426)', () => {
  it('keeps the JOIN overrides that scope reads', () => {
    // These are not redundant with the column: they serve the RADIUS auth path
    // with an explicit SAFE_COLUMNS list and carry their own cross-tenant tests.
    // Deleting them because "the column handles it now" would drop that
    // column-allowlisting too.
    const src = read('src/models/Radius.js');
    expect(src).toMatch(/JOIN clients cl ON cl\.id = r\.client_id/);
    for (const m of ['findById', 'findAll', 'count']) {
      expect(src).toMatch(new RegExp(`static async ${m}\\(`));
    }
  });

  it('does NOT override the write paths — which is why the column is needed', () => {
    // The whole point. Reads were scoped by the JOIN; update/delete/restore fell
    // through to BaseModel with no predicate, so any tenant could rewrite or
    // soft-delete another tenant's PPPoE username and password by id. If someone
    // later adds these overrides, this test should be revisited, not deleted.
    const src = read('src/models/Radius.js');
    for (const m of ['update', 'delete', 'restore']) {
      expect(src).not.toMatch(new RegExp(`static async ${m}\\(`));
    }
    expect(Radius.hasOrgScope).toBe(true);
  });

  it('subscriber provisioning writes the org on the raw INSERT', () => {
    const src = read('src/services/subscriberProvisioningService.js');
    const ins = src.slice(src.indexOf('INSERT INTO radius'));
    expect(ins.slice(0, ins.indexOf('`,'))).toMatch(/organization_id/);
    expect(src).toMatch(/\[organizationId, contract\.client_id, contract\.id/);
  });
});

// ---------------------------------------------------------------------------
// Raw SQL the model flag cannot reach: technician GPS history
// ---------------------------------------------------------------------------
// technician_gps_breadcrumbs has no organization_id of its own, so a JOIN on
// users is the only way to scope it. Without one, GET /:userId/history returned
// ANY technician's movement history to ANY tenant that guessed a user id — a
// day of breadcrumbs is where a rival ISP's crew went, which customers they
// visited and when.
describe('technician GPS history is org-scoped through users', () => {
  const src = read('src/routes/technicianTracking.js');
  const history = src.slice(src.indexOf("router.get('/:userId/history'"));
  const handler = history.slice(0, history.indexOf('});'));

  it('joins users and filters on the caller org', () => {
    expect(handler).toMatch(/JOIN users u ON u\.id = b\.user_id AND u\.organization_id = \?/);
    expect(handler).toMatch(/req\.orgId/);
  });

  it('binds the org BEFORE the user id, matching the placeholder order', () => {
    // The JOIN's placeholder comes first in the statement; swapping the binds
    // would scope by user id and filter by org — silently returning nothing,
    // or the wrong rows.
    expect(handler).toMatch(/\[req\.orgId, req\.params\.userId\]/);
  });

  it('the sibling /positions route is scoped too', () => {
    const pos = src.slice(src.indexOf("router.get('/positions'"));
    expect(pos.slice(0, pos.indexOf('});'))).toMatch(/u\.organization_id = \?/);
  });
});
