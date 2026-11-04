// =============================================================================
// VigaBSS — MikroTik RouterOS device driver (NET-30)
// =============================================================================
// Speaks the RouterOS binary API through routerosService. Every command takes
// the connection built by toConnection() from resolved credentials, so no
// caller assembles host/user/password itself.
// =============================================================================

// Lazily required: routerosService pulls in sockets and TLS at load.
let ros = null;
function routeros() {
  if (!ros) ros = require('../routerosService');
  return ros;
}

module.exports = {
  vendor: 'mikrotik',
  protocols: ['routeros_api'],

  /** @param {{ host: string, port?: number, user: string, password: string, secure?: boolean }} creds */
  toConnection(creds) {
    const r = routeros();
    return {
      host: creds.host,
      port: creds.port || (creds.secure ? r.DEFAULT_TLS_PORT : r.DEFAULT_PORT),
      user: creds.user,
      password: creds.password,
      secure: Boolean(creds.secure),
      timeoutMs: creds.timeoutMs || 12000,
    };
  },

  async test(conn) {
    await routeros().listInterfaces(conn);
    return { status: 'ok', message: 'RouterOS API connection successful' };
  },

  commands: {
    list_interfaces: conn => routeros().listInterfaces(conn),
    pppoe_create: (conn, params) => routeros().pppoeCreate(conn, params),
    pppoe_delete: (conn, params) => routeros().pppoeDelete(conn, params),
    queue_set: (conn, params) => routeros().queueSet(conn, params),
    reboot: conn => routeros().systemReboot(conn),
  },
};
