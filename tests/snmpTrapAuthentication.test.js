'use strict';

// =============================================================================
// NET-24 — SNMP traps are authenticated, not attributed by source IP alone
// =============================================================================
// The receiver ran with disableAuthorization: true, so any community and any
// SNMPv3 user (with no digest check) was accepted, and a trap was attributed
// purely by its UDP source address. A trap must now carry the community or
// authenticated USM user of the device its source resolves to; anything else
// is dropped before persistence and counted.
// =============================================================================

const dgram = require('node:dgram');
const { once } = require('node:events');

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => {
  const logger = {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    child: jest.fn(() => logger),
  };
  return logger;
});
jest.mock('../src/services/eventBus', () => ({ emit: jest.fn(), on: jest.fn() }));
jest.mock('../src/services/trapForwardingService', () => ({
  forwardTrap: jest.fn().mockResolvedValue({
    matched_rules: 0, queued_deliveries: 0, delivery_ids: [], selected_webhook_ids: [], errors: 0,
  }),
}));

const snmp = require('net-snmp');
const db = require('../src/config/database');
const eventBus = require('../src/services/eventBus');
const { registry } = require('../src/utils/metricsRegistry');
const receiverService = require('../src/services/snmpTrapReceiver');

const { handleTrap, getStatus } = receiverService;

const LINK_DOWN = '1.3.6.1.6.3.1.1.5.3';

function v2cTrap(community) {
  return {
    rinfo: { address: '10.0.0.1', port: 162 },
    accept: jest.fn(),
    pdu: {
      community,
      varbinds: [{ oid: '1.3.6.1.6.3.1.1.4.1.0', type: 6, value: LINK_DOWN }],
    },
  };
}

function authDrops(reason) {
  const line = registry.render().split('\n')
    .find(l => l.startsWith(`snmp_trap_dropped_auth_total{reason="${reason}"}`));
  return line ? Number(line.split(' ').pop()) : 0;
}

// Rendering the registry reloads the last backup time from the database at
// most every 5 minutes; do that once here so it never takes a queued result.
beforeAll(() => {
  db.query.mockResolvedValue([[{ ts: null }]]);
  registry.render();
});

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
});

describe('handleTrap() checks the credential of the device the source resolves to', () => {
  test('a v2c trap with a community other than the device\'s is dropped and counted', async () => {
    db.query.mockResolvedValueOnce([[{ id: 3, organization_id: 2, name: 'sw-01', snmp_community: 'public' }]]);
    const before = getStatus().dropped_auth_total || 0;

    await handleTrap(null, v2cTrap('guessed'));

    expect(db.query).toHaveBeenCalledTimes(1); // the lookup only: nothing stored
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(getStatus().dropped_auth_total).toBe(before + 1);
  });

  test('the trap community takes precedence over the polling community', async () => {
    db.query.mockResolvedValueOnce([[{ id: 3, organization_id: 2, name: 'sw-01', snmp_community: 'public', snmp_trap_community: 'traps-only' }]]);
    await handleTrap(null, v2cTrap('public'));
    expect(eventBus.emit).not.toHaveBeenCalled();

    db.query
      .mockResolvedValueOnce([[{ id: 3, organization_id: 2, name: 'sw-01', snmp_community: 'public', snmp_trap_community: 'traps-only' }]])
      .mockResolvedValueOnce([{ insertId: 21 }]);
    await handleTrap(null, v2cTrap('traps-only'));
    expect(eventBus.emit).toHaveBeenCalledWith('device.trap', expect.objectContaining({ trapId: 21 }));
  });

  test('a device with no community or SNMPv3 user accepts no traps', async () => {
    db.query.mockResolvedValueOnce([[{ id: 3, organization_id: 2, name: 'sw-01', snmp_community: null }]]);
    const before = authDrops('no_credentials');
    await handleTrap(null, v2cTrap('public'));
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(authDrops('no_credentials')).toBe(before + 1);
  });

  test('an SNMPv3 trap must be authenticated as the device\'s own USM user', async () => {
    const device = {
      id: 3, organization_id: 2, name: 'sw-01',
      snmp_version: 'v3', snmp_v3_security_name: 'router-a', snmp_v3_auth_key_encrypted: 'secret-a',
    };
    const v3 = user => ({ ...v2cTrap(undefined), pdu: { user, varbinds: v2cTrap().pdu.varbinds } });

    db.query.mockResolvedValueOnce([[device]]);
    await handleTrap(null, v3('router-b'));
    db.query.mockResolvedValueOnce([[device]]);
    await handleTrap(null, v3('')); // noAuthNoPriv
    expect(eventBus.emit).not.toHaveBeenCalled();

    db.query.mockResolvedValueOnce([[device]]).mockResolvedValueOnce([{ insertId: 30 }]);
    await handleTrap(null, v3('router-a'));
    expect(eventBus.emit).toHaveBeenCalledWith('device.trap', expect.objectContaining({ trapId: 30 }));
  });

  test('credentials never reach the device.trap event', async () => {
    db.query
      .mockResolvedValueOnce([[{ id: 3, organization_id: 2, name: 'sw-01', snmp_community: 'public', snmp_v3_auth_key_encrypted: 'k' }]])
      .mockResolvedValueOnce([{ insertId: 40 }]);
    await handleTrap(null, v2cTrap('public'));
    const payload = JSON.stringify(eventBus.emit.mock.calls);
    expect(payload).toContain('"trapId":40');
    expect(payload).not.toMatch(/snmp_community|snmp_v3|public/);
  });
});

describe('the real net-snmp listener', () => {
  async function unusedUdpPort() {
    const socket = dgram.createSocket('udp4');
    socket.bind(0, '127.0.0.1');
    await once(socket, 'listening');
    const { port } = socket.address();
    socket.close();
    await once(socket, 'close');
    return port;
  }

  async function listen(credentialRows) {
    const port = await unusedUdpPort();
    const calls = [];
    let notify;
    const receiver = snmp.createReceiver(receiverService.receiverOptions(port, '127.0.0.1'), (error, notification) => {
      Promise.resolve(handleTrap(error, notification)).then(() => {
        calls.push({ error, notification });
        if (notify) notify();
      });
    });
    const socket = Object.values(receiver.listener.sockets)[0];
    try { socket.address(); } catch (_) { await once(socket, 'listening'); }
    db.query.mockResolvedValueOnce([credentialRows]);
    receiverService.applyTrapCredentials(receiver, await receiverService.loadTrapCredentials());
    const next = () => new Promise(resolve => { notify = resolve; });
    return {
      port, calls, next,
      close: () => new Promise(resolve => receiver.close(() => resolve())),
    };
  }

  function sendV2c(port, community) {
    const session = snmp.createSession('127.0.0.1', community, {
      version: snmp.Version2c, trapPort: port, sourceAddress: '127.0.0.1', retries: 0, timeout: 1000,
    });
    return new Promise((resolve, reject) => {
      session.trap(LINK_DOWN, error => { session.close(); return error ? reject(error) : resolve(); });
    });
  }

  function sendV3(port, user) {
    const session = snmp.createV3Session('127.0.0.1', user, { trapPort: port, retries: 0, timeout: 1000 });
    return new Promise((resolve, reject) => {
      session.trap(LINK_DOWN, error => { session.close(); return error ? reject(error) : resolve(); });
    });
  }

  const deviceRow = { id: 9, organization_id: 4, name: 'Loopback router', snmp_community: 'right-community' };

  test('an unknown community is rejected by the listener before any lookup', async () => {
    const listener = await listen([{ snmp_community: 'right-community' }]);
    const before = authDrops('unknown_community');
    try {
      const done = listener.next();
      await sendV2c(listener.port, 'guessed-community');
      await done;
      expect(db.query).toHaveBeenCalledTimes(1); // the credential load only
      expect(authDrops('unknown_community')).toBe(before + 1);
    } finally {
      await listener.close();
    }
  });

  test('another device\'s community does not authenticate this source', async () => {
    const listener = await listen([{ snmp_community: 'right-community' }, { snmp_community: 'other-device' }]);
    const before = authDrops('community_mismatch');
    try {
      db.query.mockResolvedValueOnce([[deviceRow]]);
      const done = listener.next();
      await sendV2c(listener.port, 'other-device');
      await done;
      expect(eventBus.emit).not.toHaveBeenCalled();
      expect(authDrops('community_mismatch')).toBe(before + 1);

      db.query.mockResolvedValueOnce([[deviceRow]]).mockResolvedValueOnce([{ insertId: 88 }]);
      const accepted = listener.next();
      await sendV2c(listener.port, 'right-community');
      await accepted;
      expect(eventBus.emit).toHaveBeenCalledWith('device.trap', expect.objectContaining({ organizationId: 4, trapId: 88 }));
    } finally {
      await listener.close();
    }
  });

  test('SNMPv3 traps are digest-checked against the device\'s USM keys', async () => {
    const stored = {
      snmp_v3_security_name: 'trap-user', snmp_v3_auth_protocol: 'sha', snmp_v3_auth_key_encrypted: 'auth-passphrase-1',
      snmp_v3_priv_protocol: 'aes128', snmp_v3_priv_key_encrypted: 'priv-passphrase-1',
    };
    const listener = await listen([stored]);
    const user = authKey => ({
      name: 'trap-user', level: snmp.SecurityLevel.authPriv,
      authProtocol: snmp.AuthProtocols.sha, authKey,
      privProtocol: snmp.PrivProtocols.aes, privKey: 'priv-passphrase-1',
    });
    try {
      const before = getStatus().dropped_auth_total;
      const rejected = listener.next();
      await sendV3(listener.port, user('wrong-passphrase'));
      await rejected;
      expect(getStatus().dropped_auth_total).toBe(before + 1);
      expect(eventBus.emit).not.toHaveBeenCalled();

      db.query
        .mockResolvedValueOnce([[{ ...deviceRow, snmp_community: null, snmp_version: 'v3', ...stored }]])
        .mockResolvedValueOnce([{ insertId: 89 }]);
      const accepted = listener.next();
      await sendV3(listener.port, user('auth-passphrase-1'));
      await accepted;
      expect(eventBus.emit).toHaveBeenCalledWith('device.trap', expect.objectContaining({ trapId: 89 }));
    } finally {
      await listener.close();
    }
  });

  test('a USM user name configured with different keys on two devices is not accepted', async () => {
    db.query.mockResolvedValueOnce([[
      { snmp_v3_security_name: 'shared', snmp_v3_auth_protocol: 'sha', snmp_v3_auth_key_encrypted: 'key-one' },
      { snmp_v3_security_name: 'shared', snmp_v3_auth_protocol: 'sha', snmp_v3_auth_key_encrypted: 'key-two' },
      { snmp_v3_security_name: 'solo', snmp_v3_auth_protocol: 'sha', snmp_v3_auth_key_encrypted: 'key-three' },
    ]]);
    const { users } = await receiverService.loadTrapCredentials();
    expect(users.map(u => u.name)).toEqual(['solo']);
  });
});
