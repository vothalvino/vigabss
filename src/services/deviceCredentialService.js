// =============================================================================
// VigaBSS — per-device credential resolver (NET-30)
// =============================================================================
// Device logins lived in four places, each read by its own caller: the NAS
// row (provisioning), router_driver_configs (driver commands, on-demand
// backup pulls), FireRelay job params, and one install-wide env login
// (ROUTEROS_API_USER/PASSWORD) that the nightly backup used for every device
// of every tenant. This resolves one device's login in a fixed order, all
// inside the device's own organization:
//
//   override  — credentials a person typed for this one request;
//   device    — an active driver config bound to the device;
//   nas       — the NAS row at the device's address with RouterOS API
//               credentials (RouterOS only: NAS logins are RouterOS API logins);
//   org       — the organization's default driver config (device_id NULL);
//   fallback  — explicit job params.
//
// It returns null when no source has a password: callers refuse or skip, and
// never borrow another organization's or the installation's login.
// =============================================================================

const db = require('../config/database');
const { decrypt } = require('../utils/encryption');
const { getDriver } = require('./drivers');

const DRIVER_CONFIG_COLUMNS = 'id, vendor, protocol, host, port, username, encrypted_password, ssl_enabled, timeout_ms';

function hasPassword(p) {
  return p !== undefined && p !== null && p !== '';
}

function fromDriverConfig(row, source, deviceHost) {
  if (!row || !row.username || !row.encrypted_password) return null;
  return {
    source,
    vendor: row.vendor,
    driverConfigId: row.id,
    host: row.host || deviceHost,
    port: row.port ? Number(row.port) : undefined,
    user: row.username,
    password: decrypt(row.encrypted_password),
    secure: Boolean(row.ssl_enabled),
    timeoutMs: row.timeout_ms || undefined,
  };
}

/**
 * Resolve the login for one device.
 *
 * @param {object} opts
 * @param {number|null} opts.organizationId  the device's organization
 * @param {{ id: number, ip_address?: string }} opts.device
 * @param {string} [opts.vendor='mikrotik']  only credentials for this vendor
 * @param {{ user?: string, password?: string, port?: number }} [opts.override]
 * @param {{ user?: string, password?: string, port?: number }} [opts.fallback]
 * @returns {Promise<null | { source: string, vendor: string, host: string, port?: number,
 *   user: string, password: string, secure: boolean, timeoutMs?: number, driverConfigId?: number }>}
 */
async function resolveDeviceCredentials({ organizationId, device, vendor = 'mikrotik', override, fallback }) {
  const host = device.ip_address;
  const explicit = (creds, source) => ({
    source,
    vendor,
    host,
    port: creds.port ? Number(creds.port) : undefined,
    user: creds.user || 'admin',
    password: String(creds.password),
    secure: false,
  });

  if (override && hasPassword(override.password)) return explicit(override, 'override');

  // Only configs the vendor's driver can speak (MikroTik: routeros_api, not
  // an ssh row for the same box).
  const driver = getDriver(vendor);
  const protocols = driver ? driver.protocols : [];

  // router_driver_configs.organization_id is NOT NULL: a device with no
  // organization has no stored login to find.
  if (protocols.length && organizationId !== null && organizationId !== undefined) {
    const [bound] = await db.query(
      `SELECT ${DRIVER_CONFIG_COLUMNS} FROM router_driver_configs
        WHERE device_id = ? AND organization_id = ? AND vendor = ? AND protocol IN (?)
          AND is_active = 1 AND deleted_at IS NULL
        ORDER BY id DESC LIMIT 1`,
      [device.id, organizationId, vendor, protocols],
    );
    const fromDevice = fromDriverConfig(bound[0], 'device', host);
    if (fromDevice) return fromDevice;
  }

  if (vendor === 'mikrotik' && host) {
    const [nas] = await db.query(
      `SELECT id, ip_address, api_port, api_username, api_password_encrypted, api_use_tls FROM nas
        WHERE ip_address = ? AND organization_id <=> ? AND deleted_at IS NULL
          AND api_username IS NOT NULL AND api_password_encrypted IS NOT NULL AND api_password_encrypted <> ''
        LIMIT 1`,
      [host, organizationId ?? null],
    );
    if (nas[0]) {
      return {
        source: 'nas',
        vendor,
        nasId: nas[0].id,
        host,
        port: nas[0].api_port ? Number(nas[0].api_port) : undefined,
        user: nas[0].api_username,
        password: decrypt(nas[0].api_password_encrypted),
        secure: Boolean(nas[0].api_use_tls),
      };
    }
  }

  if (protocols.length && organizationId !== null && organizationId !== undefined) {
    const [orgWide] = await db.query(
      `SELECT ${DRIVER_CONFIG_COLUMNS} FROM router_driver_configs
        WHERE device_id IS NULL AND organization_id = ? AND vendor = ? AND protocol IN (?)
          AND is_active = 1 AND deleted_at IS NULL
        ORDER BY id DESC LIMIT 1`,
      [organizationId, vendor, protocols],
    );
    // An organization default has no host of its own that applies to every
    // device: always connect to the device's address.
    const fromOrg = fromDriverConfig(orgWide[0] && { ...orgWide[0], host: null }, 'org', host);
    if (fromOrg) return fromOrg;
  }

  if (fallback && hasPassword(fallback.password)) return explicit(fallback, 'params');
  return null;
}

module.exports = { resolveDeviceCredentials };
