// =============================================================================
// NET-30 — every registered device driver honours the driver contract
// =============================================================================
// The mocked driver tests replaced routerosService with a jest mock that had
// a listInterfaces method the real module never exported, so every MikroTik
// connection test and list_interfaces command failed with "is not a function"
// while the suite passed. Here each driver runs against the REAL transport
// module's export list: a command or test() that reaches for a function the
// module does not export fails. No socket is opened.
// =============================================================================

const { VENDORS, getDriver, implementedVendors } = require('../src/services/drivers');

const TRANSPORT = { mikrotik: '../src/services/routerosService' };

function withRealExports(vendor) {
  const actual = jest.requireActual(TRANSPORT[vendor]);
  const reached = [];
  jest.resetModules();
  jest.doMock(TRANSPORT[vendor], () => new Proxy(actual, {
    get(target, key) {
      if (typeof key !== 'string' || /^DEFAULT_/.test(key)) return target[key];
      reached.push(key);
      if (typeof target[key] !== 'function') throw new Error(`${TRANSPORT[vendor]} does not export ${key}()`);
      return async () => ({ stubbed: key });
    },
  }));
  const driver = require('../src/services/drivers').getDriver(vendor);
  return { driver, reached };
}

afterEach(() => {
  jest.resetModules();
  jest.dontMock('../src/services/routerosService');
});

test('every implemented vendor is a vendor router_driver_configs allows', () => {
  expect(implementedVendors().length).toBeGreaterThan(0);
  for (const vendor of implementedVendors()) expect(VENDORS).toContain(vendor);
});

test('a vendor without a driver has none, rather than a stub that claims success', () => {
  for (const vendor of VENDORS.filter(v => !implementedVendors().includes(v))) expect(getDriver(vendor)).toBeNull();
  expect(getDriver('constructor')).toBeNull();
});

describe.each(implementedVendors())('%s driver', (vendor) => {
  test('has the contract shape', () => {
    const driver = getDriver(vendor);
    expect(driver.vendor).toBe(vendor);
    expect(Array.isArray(driver.protocols) && driver.protocols.length).toBeTruthy();
    expect(typeof driver.toConnection).toBe('function');
    expect(typeof driver.test).toBe('function');
    expect(Object.keys(driver.commands).length).toBeGreaterThan(0);
  });

  test('toConnection carries the resolved login and a port', () => {
    const conn = getDriver(vendor).toConnection({ host: '192.0.2.10', user: 'u', password: 'p' });
    expect(conn).toMatchObject({ host: '192.0.2.10', user: 'u', password: 'p' });
    expect(conn.port).toEqual(expect.any(Number));
  });

  test('test() reaches a function the transport module exports', async () => {
    const { driver, reached } = withRealExports(vendor);
    await expect(driver.test(driver.toConnection({ host: '192.0.2.10', user: 'u', password: 'p' }))).resolves.toMatchObject({ status: 'ok' });
    expect(reached.length).toBeGreaterThan(0);
  });

  test.each(Object.keys(getDriver(vendor).commands))('command %s reaches a function the transport module exports', async (command) => {
    const { driver, reached } = withRealExports(vendor);
    const conn = driver.toConnection({ host: '192.0.2.10', user: 'u', password: 'p' });
    await expect(driver.commands[command](conn, { name: 'x' })).resolves.toEqual({ stubbed: reached[reached.length - 1] });
  });
});
