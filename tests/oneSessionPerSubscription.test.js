// =============================================================================
// One connection per subscription — validation and the Accounting-Start hook
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validate } = require('../src/middleware/validate');
const schemas = require('../src/middleware/schemas/radius');

const run = (schema, body) => { const next = jest.fn(); validate(schema)({ body }, {}, next); return next.mock.calls[0][0]; };

test.each(Object.entries(schemas).filter(([, s]) => s && s.simultaneous_use))(
  '%s refuses simultaneous_use above 1', (_name, schema) => {
    const err = run(schema, { simultaneous_use: 2 });
    expect(err?.details?.some((d) => d.field === 'simultaneous_use')).toBe(true);
    const ok = run(schema, { simultaneous_use: 1 });
    expect(ok?.details?.some((d) => d.field === 'simultaneous_use')).not.toBe(true);
  },
);

test('a new Accounting-Start session triggers the single-session check for its contract', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/radiusAccountingService.js'), 'utf8');
  const start = src.slice(src.indexOf("if (eventType === 'start') {"));
  const insertReturn = start.indexOf("return { action: 'insert'");
  const hook = start.indexOf('radiusService.enforceSingleSession(organizationId, contractId)');
  expect(hook).toBeGreaterThan(-1);
  expect(hook).toBeLessThan(insertReturn);
});
