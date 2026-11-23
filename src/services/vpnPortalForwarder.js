// =============================================================================
// VigaBSS 5.0 — VPN clients keep their own address when they open this site
// =============================================================================
// A full-tunnel WireGuard client that opens this install's own site used to
// arrive as Docker's gateway address: the hub NATs the connection out, it
// loops back through the host's published port, and the web server sees the
// bridge. Every client looked the same, so the admin IP allowlist, login IP
// blocks, rate limits and the audit log could not tell them apart.
//
// The hub's firewall now redirects such a connection (tunnel client → this
// install's public address, TCP 443) to the listener below, which runs in the
// hub's network namespace as the ordinary non-root app. It opens a connection
// to the web server's PROXY-protocol port and announces the client's tunnel
// address, so the web server and the app see 10.99.x.y (and its IPv6 twin)
// instead of the gateway. TLS is not terminated here: bytes are passed through.
//
// The address announced always comes from the accepted socket, never from
// anything the client sent, and only tunnel-client addresses are accepted.
//
// The redirect is only switched on while this listener is up AND the web
// server's PROXY port answers. Otherwise (host nginx, an older nginx.conf,
// a start-up race) the address sets stay empty and a client reaches the site
// exactly as before.
// =============================================================================

const net = require('node:net');
const dns = require('node:dns').promises;
const config = require('../config');
const wireguard = require('./wireguardServerService');
const logger = require('../utils/logger').child({ service: 'vpnPortalForwarder' });

const LISTEN_PORT = wireguard.PORTAL_FORWARD_PORT;
// The bundled web server, by its Compose service name, and its PROXY port.
const upstreamTarget = { host: 'nginx', port: 8443 };
const REFRESH_MS = 10 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 5000;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CONNECTIONS = 512;

let server = null;
let timer = null;
let active = { v4: [], v6: [] };

/** An accepted socket's peer address without the IPv4-mapped prefix. */
function plainAddress(address) {
  const text = String(address || '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
  return mapped ? mapped[1] : text;
}

/** The tunnel-client pools as a BlockList (IPv6 only when it is on). */
function clientPools() {
  const pools = new net.BlockList();
  const [v4, v4Prefix] = String(config.wireguard.clientSubnet || '').split('/');
  if (net.isIP(v4) === 4 && /^\d{1,2}$/.test(v4Prefix || '')) pools.addSubnet(v4, Number(v4Prefix), 'ipv4');
  const v6Subnet = wireguard.clientSubnetV6();
  if (v6Subnet) {
    const [v6, v6Prefix] = v6Subnet.split('/');
    pools.addSubnet(v6, Number(v6Prefix), 'ipv6');
  }
  return pools;
}

function isTunnelClient(address, pools = clientPools()) {
  const family = net.isIP(address);
  if (family === 4) return pools.check(address, 'ipv4');
  if (family === 6) return pools.check(address, 'ipv6');
  return false;
}

/**
 * The PROXY protocol (version 1) line announcing a client. Both addresses
 * must be of one family; the destination is informational, so when the local
 * address is of the other family the client's own address stands in for it.
 */
function proxyHeader({ remoteAddress, remotePort, localAddress, localPort }) {
  const src = plainAddress(remoteAddress);
  const family = net.isIP(src);
  if (!family) return null;
  const local = plainAddress(localAddress);
  const dst = net.isIP(local) === family ? local : src;
  const port = (value) => (Number.isInteger(value) && value > 0 && value < 65536 ? value : 0);
  return `PROXY TCP${family} ${src} ${dst} ${port(remotePort)} ${port(localPort)}\r\n`;
}

function handle(client, pools) {
  const src = plainAddress(client.remoteAddress);
  const header = isTunnelClient(src, pools) ? proxyHeader(client) : null;
  if (!header) {
    client.destroy();
    return;
  }
  const upstream = net.connect({ ...upstreamTarget });
  const close = () => { client.destroy(); upstream.destroy(); };
  upstream.setTimeout(CONNECT_TIMEOUT_MS, close);
  upstream.once('connect', () => {
    upstream.setTimeout(IDLE_TIMEOUT_MS, close);
    upstream.write(header);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  client.setTimeout(IDLE_TIMEOUT_MS, close);
  client.on('error', close);
  upstream.on('error', close);
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
}

/** Does the web server's PROXY port answer? Announces nothing about a client. */
function upstreamReady() {
  return new Promise((resolve) => {
    const probe = net.connect({ ...upstreamTarget });
    const done = (ok) => { probe.destroy(); resolve(ok); };
    probe.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
    probe.once('error', () => done(false));
    probe.once('connect', () => probe.end('PROXY UNKNOWN\r\n', () => done(true)));
  });
}

const usable = (ip) => !['0.0.0.0', '::', '::1'].includes(ip) && !ip.startsWith('127.');

/** This install's public addresses: where its own host name points. */
async function portalAddresses() {
  let host;
  try { host = new URL(config.appUrl).hostname.replace(/^\[|\]$/g, ''); } catch (_) { return { v4: [], v6: [] }; }
  const literal = net.isIP(host);
  if (literal === 4) return { v4: [host].filter(usable), v6: [] };
  if (literal === 6) return { v4: [], v6: [host].filter(usable) };
  const [v4, v6] = await Promise.all([
    dns.resolve4(host).catch(() => []),
    wireguard.clientSubnetV6() ? dns.resolve6(host).catch(() => []) : [],
  ]);
  return { v4: v4.filter(usable).slice(0, 16), v6: v6.filter(usable).slice(0, 16) };
}

/** Point the hub's redirect at the current addresses, or switch it off. */
async function refresh() {
  if (!config.wireguard.serverEnabled) return { applied: false };
  let wanted = { v4: [], v6: [] };
  try {
    if (server?.listening && await upstreamReady()) wanted = await portalAddresses();
    await wireguard.setPortalAddresses(wanted);
    if (JSON.stringify(wanted) !== JSON.stringify(active)) {
      logger.info({ v4: wanted.v4.length, v6: wanted.v6.length },
        wanted.v4.length || wanted.v6.length
          ? 'VPN clients now reach this site with their own tunnel address'
          : 'VPN portal forwarding is off (web server PROXY port not reachable or no public address)');
    }
    active = wanted;
    return { applied: true, ...wanted };
  } catch (err) {
    logger.warn({ err: err.message }, 'VPN portal forwarding could not be updated');
    return { applied: false };
  }
}

function listen() {
  return new Promise((resolve) => {
    const pools = clientPools();
    const created = net.createServer({ allowHalfOpen: false }, (client) => handle(client, pools));
    created.maxConnections = MAX_CONNECTIONS;
    const attempt = (host, fallback) => {
      created.once('error', (err) => {
        if (fallback) { attempt(fallback, null); return; }
        logger.warn({ err: err.message }, 'VPN portal forwarder could not listen');
        resolve(null);
      });
      created.listen({ port: LISTEN_PORT, host }, () => {
        created.removeAllListeners('error');
        created.on('error', (err) => logger.warn({ err: err.message }, 'VPN portal forwarder error'));
        resolve(created);
      });
    };
    attempt('::', '0.0.0.0');
  });
}

/** Start forwarding. Never throws: the hub works without it, as it always did. */
async function start() {
  if (server || !config.wireguard.serverEnabled) return { started: false };
  server = await listen();
  if (!server) return { started: false };
  await refresh();
  timer = setInterval(() => { refresh().catch(() => {}); }, REFRESH_MS);
  timer.unref();
  return { started: true };
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  active = { v4: [], v6: [] };
  const closing = server;
  server = null;
  // Not awaited: close() only completes once open connections have ended.
  if (closing) closing.close();
}

module.exports = {
  start, stop, refresh,
  // exported for tests
  plainAddress, proxyHeader, isTunnelClient, clientPools, portalAddresses, handle,
  LISTEN_PORT, upstreamTarget, upstreamReady,
};
