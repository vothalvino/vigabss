// =============================================================================
// FE2-02 — the Fiber Plant forms send fields and values the API accepts
// =============================================================================
// ODF create sent frame_type 'standard' from a status list and total_ports;
// OTDR sent fault_detected as a boolean, device_id/test_date/fiber_length_m
// and other fault types; routes sent total_length_m, fiber_count and
// installation_date with statuses planned/decommissioned; SFP defaulted to
// lifecycle 'spare' and sent device_id, sfp_port_name and max_distance_km.
// Every one of these was a 422 or a column the table lacks.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { createOdfFrame } = require('../src/middleware/schemas/odfFrames');
const { createOtdrTest } = require('../src/middleware/schemas/otdrTests');
const { createFiberRoute } = require('../src/middleware/schemas/fiberRoutes');
const { createSfpInventory } = require('../src/middleware/schemas/sfpInventory');

const page = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'pages', 'FiberPlantManagementPage.tsx'), 'utf8');
const list = (name) => [...page.slice(page.indexOf(`const ${name} =`), page.indexOf('];', page.indexOf(`const ${name} =`))).matchAll(/'([^']+)'/g)].map((m) => m[1]);
const bodyFields = (iface) => {
  const start = page.indexOf(`interface ${iface} {`);
  return [...page.slice(start, page.indexOf('\n}', start)).matchAll(/^\s+([a-z_]+)\??:/gm)].map((m) => m[1]);
};

test.each([
  ['ROUTE_STATUSES', createFiberRoute.status],
  ['FRAME_TYPES', createOdfFrame.frame_type],
  ['FAULT_TYPES', createOtdrTest.fault_type],
  ['LIFECYCLE_STATUSES', createSfpInventory.lifecycle_status],
])('%s is the validator enum', (name, rule) => {
  expect(list(name).sort()).toEqual([...rule.enum].sort());
});

test.each([
  ['FiberRouteBody', createFiberRoute],
  ['OtdrTestBody', createOtdrTest],
  ['SfpBody', createSfpInventory],
])('every %s field is one the validator accepts', (iface, schema) => {
  const unknown = bodyFields(iface).filter((f) => !(f in schema));
  expect(unknown).toEqual([]);
});

test('ODF create sends port_count and a valid default frame type', () => {
  expect(page).toMatch(/async function createOdfFrame\(body: \{ name: string; location_detail\?: string; port_count\?: number; frame_type\?: string \}\)/);
  const defaults = [...page.matchAll(/frame_type: '([a-z_]+)'/g)].map((m) => m[1]);
  for (const d of defaults) expect(createOdfFrame.frame_type.enum).toContain(d);
});

test('OTDR sends fault_detected as 0/1 and SFP defaults to a valid lifecycle', () => {
  expect(page).toMatch(/fault_detected: e\.target\.checked \? 1 : 0/);
  for (const [, d] of page.matchAll(/lifecycle_status: '([a-z_]+)'|lifecycle_status \?\? '([a-z_]+)'/g)) {
    if (d) expect(createSfpInventory.lifecycle_status.enum).toContain(d);
  }
  expect(page).not.toMatch(/'spare'|'faulty'/);
});

test('the route list reads cable_length_m', () => {
  expect(page).toMatch(/fr\.cable_length_m !== null/);
  expect(page).not.toMatch(/fiber_count|installation_date|total_ports|sfp_port_name|max_distance_km/);
});
