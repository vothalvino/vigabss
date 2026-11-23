'use strict';
// =============================================================================
// VPN clients keep their own address when they open this install's site
// =============================================================================
// A full-tunnel WireGuard client used to reach the site as Docker's gateway
// address, the same for every client, so the admin IP allowlist could not tell
// them apart. The hub now redirects such a connection to the app's forwarder,
// which announces the client's tunnel address to the web server with the
// PROXY protocol.
// =============================================================================

const fs = require('fs');
const net = require('net');
const path = require('path');
const yaml = require('js-yaml');

const mockSetPortalAddresses = jest.fn(async () => ({ applied: true }));
jest.mock('../src/services/wireguardServerService', () => ({
  PORTAL_FORWARD_PORT: 8443,
  clientSubnetV6: () => 'fd99:7669:6761::/64',
  setPortalAddresses: (...a) => mockSetPortalAddresses(...a),
}));

const config = require('../src/config');
const forwarder = require('../src/services/vpnPortalForwarder');

const root = path.join(__dirname, '..');
const listenOn = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

describe('the announced address', () => {
  test('is the socket peer, as PROXY protocol version 1', () => {
    expect(forwarder.proxyHeader({ remoteAddress: '::ffff:10.99.0.7', remotePort: 51000, localAddress: '::ffff:10.99.0.1', localPort: 8443 }))
      .toBe('PROXY TCP4 10.99.0.7 10.99.0.1 51000 8443\r\n');
    expect(forwarder.proxyHeader({ remoteAddress: 'fd99:7669:6761::a63:7', remotePort: 51000, localAddress: 'fd99:7669:6761::1', localPort: 8443 }))
      .toBe('PROXY TCP6 fd99:7669:6761::a63:7 fd99:7669:6761::1 51000 8443\r\n');
  });

  test('never mixes address families in one line', () => {
    expect(forwarder.proxyHeader({ remoteAddress: 'fd99:7669:6761::a63:7', remotePort: 1, localAddress: '10.99.0.1', localPort: 8443 }))
      .toBe('PROXY TCP6 fd99:7669:6761::a63:7 fd99:7669:6761::a63:7 1 8443\r\n');
  });

  test('nothing is announced for something that is not an address', () => {
    expect(forwarder.proxyHeader({ remoteAddress: 'not an ip\r\nPROXY TCP4 1.2.3.4', remotePort: 1, localAddress: '10.99.0.1', localPort: 8443 })).toBeNull();
  });
});

describe('who may use the forwarder', () => {
  test('only addresses from the tunnel-client pools', () => {
    config.wireguard.clientSubnet = '10.99.0.0/16';
    expect(forwarder.isTunnelClient('10.99.0.7')).toBe(true);
    expect(forwarder.isTunnelClient('fd99:7669:6761::a63:7')).toBe(true);
    // The Docker gateway, a NAS tunnel peer, the internet.
    expect(forwarder.isTunnelClient('172.19.0.1')).toBe(false);
    expect(forwarder.isTunnelClient('10.255.0.9')).toBe(false);
    expect(forwarder.isTunnelClient('203.0.113.5')).toBe(false);
    expect(forwarder.isTunnelClient('2001:db8::1')).toBe(false);
  });
});

describe('a forwarded connection', () => {
  let upstream; let front; let received;

  beforeEach(async () => {
    received = '';
    upstream = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        received += chunk.toString('latin1');
        if (received.endsWith('ping')) socket.write('pong');
      });
    });
    Object.assign(forwarder.upstreamTarget, { host: '127.0.0.1', port: await listenOn(upstream) });
  });

  afterEach(async () => {
    await new Promise((resolve) => front.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  });

  const connectThrough = async (clientSubnet) => {
    config.wireguard.clientSubnet = clientSubnet;
    const pools = forwarder.clientPools();
    front = net.createServer((socket) => forwarder.handle(socket, pools));
    const port = await listenOn(front);
    return net.connect({ host: '127.0.0.1', port });
  };

  test('starts with the client\'s address, then carries the bytes both ways unchanged', async () => {
    const client = await connectThrough('127.0.0.0/8');
    const reply = await new Promise((resolve, reject) => {
      client.on('error', reject);
      client.on('data', (chunk) => resolve(chunk.toString()));
      client.write('ping');
    });
    client.destroy();
    expect(reply).toBe('pong');
    expect(received).toMatch(/^PROXY TCP4 127\.0\.0\.1 127\.0\.0\.1 \d+ \d+\r\nping$/);
  });

  test('a connection from outside the tunnel pools is closed and never reaches the web server', async () => {
    const client = await connectThrough('10.99.0.0/16');
    await new Promise((resolve) => { client.on('close', resolve); client.on('error', () => {}); client.write('ping'); });
    expect(received).toBe('');
  });
});

describe('when the redirect is on', () => {
  beforeEach(() => { mockSetPortalAddresses.mockClear(); config.wireguard.serverEnabled = true; });
  afterEach(() => { config.wireguard.serverEnabled = false; });

  test('with no forwarder listening the address sets are emptied, so clients reach the site as before', async () => {
    config.appUrl = 'https://203.0.113.10';
    await forwarder.refresh();
    expect(mockSetPortalAddresses).toHaveBeenCalledWith({ v4: [], v6: [] });
  });

  test('a literal public address is used as is; loopback never is', async () => {
    config.appUrl = 'https://203.0.113.10';
    await expect(forwarder.portalAddresses()).resolves.toEqual({ v4: ['203.0.113.10'], v6: [] });
    config.appUrl = 'https://127.0.0.1:3000';
    await expect(forwarder.portalAddresses()).resolves.toEqual({ v4: [], v6: [] });
  });
});

describe('the web server side', () => {
  const conf = fs.readFileSync(path.join(root, 'nginx', 'nginx.conf'), 'utf8');
  const compose = yaml.load(fs.readFileSync(path.join(root, 'docker-compose.prod.yml'), 'utf8'));

  test('nginx takes the announced address on its PROXY port', () => {
    expect(conf).toMatch(/listen\s+8443 ssl proxy_protocol;/);
    expect(conf).toMatch(/listen\s+\[::\]:8443 ssl proxy_protocol;/);
    expect(conf).toMatch(/real_ip_header\s+proxy_protocol;/);
  });

  test('an announced address is trusted from private sources only', () => {
    const trusted = [...conf.matchAll(/set_real_ip_from\s+([^;]+);/g)].map((m) => m[1]);
    expect(trusted.sort()).toEqual(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7']);
  });

  test('the PROXY port is never published: anyone who could reach it could claim any address', () => {
    for (const [name, service] of Object.entries(compose.services)) {
      for (const port of service.ports || []) {
        expect(`${name} ${typeof port === 'string' ? port : JSON.stringify(port)}`).not.toMatch(/8443/);
      }
    }
    expect(compose.services.nginx.ports).toEqual(['80:80', '443:443']);
  });
});
