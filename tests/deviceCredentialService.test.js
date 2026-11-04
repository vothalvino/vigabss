// =============================================================================
// NET-30 — one per-device credential resolver
// =============================================================================
// Logins lived on the NAS row, in router_driver_configs, in FireRelay job
// params and in one install-wide env pair. The resolver checks them in a fixed
// order, always inside the device's own organization, and returns null rather
// than borrow another organization's or the installation's login.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/encryption', () => ({ decrypt: v => (v ? `plain:${v}` : null) }));

const db = require('../src/config/database');
const { resolveDeviceCredentials } = require('../src/services/deviceCredentialService');

const DEVICE = { id: 5, ip_address: '10.9.0.1' };
const ORG = 7;

// Answers each lookup from fixtures, applying the organization predicate the
// way MySQL would; a query without one returns everything (and would leak).
function fixtures({ configs = [], nas = [] }) {
  db.query.mockImplementation(async (sql, params) => {
    if (/FROM router_driver_configs/.test(sql)) {
      const bound = /device_id = \?/.test(sql);
      const [deviceId, org, vendor, protocols] = bound ? params : [null, ...params];
      return [configs.filter(c => c.device_id === deviceId
        && c.organization_id === org && c.vendor === vendor && protocols.includes(c.protocol))];
    }
    if (/FROM nas/.test(sql)) {
      return [nas.filter(n => n.ip_address === params[0] && n.organization_id === params[1])];
    }
    throw new Error(`unexpected query ${sql}`);
  });
}

const cfg = (over) => ({ id: 1, vendor: 'mikrotik', protocol: 'routeros_api', host: null, port: 8728, username: 'u', encrypted_password: 'C', ...over });

beforeEach(() => db.query.mockReset());

test('credentials typed into the request win and need no lookup', async () => {
  fixtures({});
  const creds = await resolveDeviceCredentials({ organizationId: ORG, device: DEVICE, override: { password: 'typed' } });
  expect(creds).toMatchObject({ source: 'override', user: 'admin', password: 'typed', host: DEVICE.ip_address });
  expect(db.query).not.toHaveBeenCalled();
});

test('a config bound to the device comes before the NAS and the org default', async () => {
  fixtures({
    configs: [cfg({ id: 2, device_id: null, organization_id: ORG, username: 'org' }), cfg({ id: 3, device_id: 5, organization_id: ORG, username: 'dev', ssl_enabled: 1 })],
    nas: [{ id: 9, ip_address: DEVICE.ip_address, organization_id: ORG, api_username: 'nas', api_password_encrypted: 'N' }],
  });
  const creds = await resolveDeviceCredentials({ organizationId: ORG, device: DEVICE });
  expect(creds).toMatchObject({ source: 'device', user: 'dev', password: 'plain:C', secure: true, driverConfigId: 3 });
});

test('then the NAS at the device address', async () => {
  fixtures({
    configs: [cfg({ id: 2, device_id: null, organization_id: ORG, username: 'org' })],
    nas: [{ id: 9, ip_address: DEVICE.ip_address, organization_id: ORG, api_port: 8729, api_username: 'nas', api_password_encrypted: 'N', api_use_tls: 1 }],
  });
  const creds = await resolveDeviceCredentials({ organizationId: ORG, device: DEVICE });
  expect(creds).toMatchObject({ source: 'nas', user: 'nas', password: 'plain:N', port: 8729, secure: true, nasId: 9 });
});

test('then the organization default, always aimed at the device address', async () => {
  fixtures({ configs: [cfg({ id: 2, device_id: null, organization_id: ORG, username: 'org', host: '192.0.2.99' })] });
  const creds = await resolveDeviceCredentials({ organizationId: ORG, device: DEVICE });
  expect(creds).toMatchObject({ source: 'org', user: 'org', host: DEVICE.ip_address });
});

test('explicit job params are the last resort', async () => {
  fixtures({});
  const creds = await resolveDeviceCredentials({ organizationId: ORG, device: DEVICE, fallback: { user: 'job', password: 'p', port: 8729 } });
  expect(creds).toMatchObject({ source: 'params', user: 'job', password: 'p', port: 8729 });
});

test("another organization's logins for the same device and address are never used", async () => {
  fixtures({
    configs: [cfg({ device_id: 5, organization_id: 8 }), cfg({ device_id: null, organization_id: 8 })],
    nas: [{ id: 9, ip_address: DEVICE.ip_address, organization_id: 8, api_username: 'nas', api_password_encrypted: 'N' }],
  });
  await expect(resolveDeviceCredentials({ organizationId: ORG, device: DEVICE })).resolves.toBeNull();
});

test('a config the driver cannot speak (ssh for a MikroTik) is skipped', async () => {
  fixtures({ configs: [cfg({ device_id: 5, organization_id: ORG, protocol: 'ssh' })] });
  await expect(resolveDeviceCredentials({ organizationId: ORG, device: DEVICE })).resolves.toBeNull();
});

test('a config without a password is no login', async () => {
  fixtures({ configs: [cfg({ device_id: 5, organization_id: ORG, encrypted_password: null })] });
  await expect(resolveDeviceCredentials({ organizationId: ORG, device: DEVICE })).resolves.toBeNull();
});

test('a device with no organization only matches an organization-less NAS', async () => {
  fixtures({ nas: [{ id: 9, ip_address: DEVICE.ip_address, organization_id: null, api_username: 'nas', api_password_encrypted: 'N' }] });
  const creds = await resolveDeviceCredentials({ organizationId: null, device: DEVICE });
  expect(creds).toMatchObject({ source: 'nas' });
  expect(db.query).toHaveBeenCalledTimes(1);
});

test('the old install-wide env login is not a source', async () => {
  process.env.ROUTEROS_API_USER = 'install-operator';
  process.env.ROUTEROS_API_PASSWORD = 'install-operator-secret';
  try {
    fixtures({});
    await expect(resolveDeviceCredentials({ organizationId: ORG, device: DEVICE })).resolves.toBeNull();
  } finally {
    delete process.env.ROUTEROS_API_USER;
    delete process.env.ROUTEROS_API_PASSWORD;
  }
});
